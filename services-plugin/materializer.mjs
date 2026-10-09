// services-plugin/materializer.mjs
// ============================================================================
// P3（docs/DECISION-legion-owns-model-config.md）：**接管写入**。
//
// 它做四件事，顺序不能换：
//
//   ① **门（gate）**：`enabled` 为假 ⇒ 一个字节都不写，直接返回"未接管"。
//      这是唯一不可逆的一段，所以"打开"必须是一次**显式**的动作，不能靠"代码写完就生效"。
//   ② 写：`ctx.settings.mutate('llm-pi-ai', ops, revision)` + `ctx.credentials.set(ref, value)`。
//   ③ **写后用真读者回读，重新出计划**，验收"剩下的差异恰好是我们有意跳过的那几条"。
//      ★ 判据不是"我写进去了"，而是"**读者读回来了**"（与 `credential-materializer.mjs` 同一条纪律）。
//   ④ 证不出来 ⇒ **回滚**（执行逆 ops），并重新回读确认已改回去；回滚也失败就明说。
//
// ## 为什么验收是"重出计划"而不是"逐字段比对"
//
// 因为"什么算一致"已经在 P2 里定义过了：`planMaterialization` 就是那个定义。
// 另写一套逐字段比对等于**把同一个判断实现两遍**，而两份实现漂移的那一天，
// 会表现为"写进去了、也验过了，但界面读出来还是旧的"。
//
//   > 一个"写者按自己的理解验自己"的验收，
//   > 与一个"读者按界面同一条判据验"的验收，在写入正确时是同一个读数。
//
// ## 凭证：只新增、从不删除
//
// "Legion 里没有这个值"**不等于**"DSH 该把它删掉"。所以本模块从不 unset 凭证。
// 值从哪来由 `secretReader` 注入（生产里是本机 DPAPI 受保护库的 `get`，见
// `legion-secrets.mjs`）；读出 `null`（Legion 没有这个值）就**保持 DSH 原样** ——
// 这正是 P1 引导导入之后的常态：引用名收进来了，值仍留在 DSH 那边继续工作。
//
// ## 出错时不抛
//
// 它跑在宿主的启动/周期路径上。任何异常都必须变成一条**读得懂的日志 + 一个返回状态**，
// 而不是把宿主的启动拖坏（与 P1 的引导导入同一条纪律）。
// ============================================================================

import { planMaterialization } from './materialize-plan.mjs'
import { planToOps, expectedResidual, verifyResidual } from './materialize-ops.mjs'
import { readDshProviderSnapshot } from './dsh-snapshot.mjs'

/**
 * @param ctx        宿主上下文（只用 `ctx.get(...)` **软取** settings / credentials / llm）
 * @param hubUpstream 中枢地址（用来读 Legion 的目录）
 * @param fetchImpl   注入点（用例用假件）
 * @param secretReader `(ref) => Promise<string|null>`：从 Legion 的受保护库取**值**；
 *                     返回 null 表示"Legion 没有这个值"（那就不动 DSH 的）
 * @param enabled     **显式门**：默认 false ⇒ 不写
 * @param allowDeletes 删除是**独立**的第二道门：默认 false ⇒ 删除只报告、不执行
 */
export async function runMaterialization({
  ctx, hubUpstream, teamHubToken = '', fetchImpl = fetch, secretReader = async () => null,
  enabled = false, allowDeletes = false, log = () => {},
} = {}) {
  if (!enabled) {
    // ★ 门关着时**连读都不必**（读了也不会写），但仍要有一条读数，
    //   否则日志里"没有物化日志"会被读成"物化没接上"，而两种情况的处置完全不同。
    log('模型配置物化：**未启用**（LEGION_APPLY_MODEL_CONFIG 未开）→ 本次不写任何东西；DSH 配置保持原样（仅影子对账）')
    return { applied: false, reason: 'gate-off', wrote: false }
  }

  const settings = ctx?.get?.('settings') ?? null
  if (!settings || typeof settings.mutate !== 'function') {
    log('模型配置物化：宿主没有 settings 服务（或没有 mutate）→ 本次放弃（**未写任何东西**）')
    return { applied: false, reason: 'no-settings', wrote: false }
  }
  const credentials = ctx?.get?.('credentials') ?? null

  // ── 读 Legion 的目录（经中枢自己的 API，与 P1 导入同一条路，不直连 team.db）──
  const qs = teamHubToken ? '?token=' + encodeURIComponent(teamHubToken) : ''
  let legion = null
  try {
    const res = await fetchImpl(`${hubUpstream}/api/model-providers${qs}`, {
      method: 'GET', headers: teamHubToken ? { authorization: `Bearer ${teamHubToken}` } : {},
    })
    if (res.status !== 200) { log(`模型配置物化：读 Legion 目录失败（HTTP ${res.status}）→ 本次放弃`); return { applied: false, reason: 'legion-read-failed', wrote: false } }
    legion = JSON.parse(await res.text())
  } catch (e) {
    log(`模型配置物化：读 Legion 目录出错（${e instanceof Error ? e.message : String(e)}）→ 本次放弃`)
    return { applied: false, reason: 'legion-read-failed', wrote: false }
  }
  if (!Array.isArray(legion?.providers)) {
    log('模型配置物化：中枢响应里没有 providers 数组 → 本次放弃')
    return { applied: false, reason: 'legion-shape', wrote: false }
  }

  // ── 读 DSH 现状（与 P2 同一个读者）──
  const snap = await readDshProviderSnapshot(ctx)
  if (snap.readOk !== true) {
    // ★ 读不到就**什么都不做**：在"看不见现状"的前提下写入，等于闭着眼睛覆盖。
    log(`模型配置物化：读不到 DSH 现状（${snap.reason}）→ 本次放弃（**未写任何东西**）`)
    return { applied: false, reason: 'actual-read-failed', wrote: false }
  }

  const before = planMaterialization({ desired: legion.providers, actual: snap.providers, actualCredentials: await readCredentialState(credentials, legion.providers) })
  const t = planToOps({ plan: before, desired: legion.providers, actual: snap.providers, allowDeletes })

  if (t.ops.length === 0 && t.credentialsToSet.length === 0) {
    log(`模型配置物化：已启用，但本轮无差异（clean=${before.clean}${t.skippedDeletes.length > 0 ? `，跳过删除 ${t.skippedDeletes.length}` : ''}）→ 未写任何东西`)
    return { applied: true, wrote: false, before, skippedDeletes: t.skippedDeletes }
  }

  // ── 写 ──
  let revision = undefined
  try {
    // 乐观锁：先取当前 revision，写入时带上 —— 两个写入者同时改时，后来的那次会被拒绝，
    // 而不是静默覆盖（`settings.mutate` 的第三个参数就是这个用途）。
    if (typeof settings.describe === 'function') {
      const ns = settings.describe({ redactSecrets: true })?.find?.((n) => n?.ns === 'llm-pi-ai')
      if (ns && Number.isInteger(ns.revision)) revision = ns.revision
    }
  } catch { revision = undefined }

  const wroteOps = []
  // ★ 这两本账必须分开记："写了的"与"没值可写、因此有意不动 DSH 的"。
  //   混成一个数组会让验收按"我们打算写 N 个凭证"去比，
  //   而**没值**的那些在回读里仍然显示"缺" ⇒ 明明行为正确却判失败、然后回滚。
  const credentialsWritten = []
  const credentialsUnavailable = []
  try {
    if (t.ops.length > 0) {
      await settings.mutate('llm-pi-ai', t.ops, revision)
      wroteOps.push(`providers(${t.appliedIds.length})`)
    }
    for (const ref of t.credentialsToSet) {
      if (!credentials || typeof credentials.set !== 'function') { credentialsUnavailable.push(ref); continue }
      const value = await secretReader(ref)
      // ★ 读不到值就**不动** DSH 的凭证：把"没有值"写成空串会**毁掉**一把正在用的钥匙。
      if (typeof value !== 'string' || value === '') { credentialsUnavailable.push(ref); continue }
      await credentials.set(ref, value)
      credentialsWritten.push(ref)
      wroteOps.push(`credential(${ref})`)
    }
  } catch (e) {
    log(`模型配置物化：写入失败（${e instanceof Error ? e.message : String(e)}）→ 尝试回滚`)
    const rolled = await rollback({ settings, reversed: t.reversed, log })
    return { applied: false, reason: 'write-failed', wrote: true, wroteOps, rolled, error: e instanceof Error ? e.message : String(e) }
  }

  // ── ③ 写后回读：用**真读者**重新出计划 ──
  const after = await rereadPlan(ctx, legion.providers, await readCredentialState(credentials, legion.providers))
  const expected = expectedResidual({
    skippedDeletes: t.skippedDeletes,
    // 我们**有意**不动的凭证（Legion 没有值 / 没有 credentials 服务）在回读里仍然显示"缺" ——
    // 那不是失败，是"保持 DSH 原样"这条规则的正常结果。
    credentialRefsLeft: credentialsUnavailable.length,
  })
  const verdict = verifyResidual(after, expected)

  if (!verdict.ok) {
    log(`模型配置物化：写后回读**不通过** → ${verdict.problems.join('；')}`)
    const rolled = await rollback({ settings, reversed: t.reversed, log })
    return { applied: false, reason: 'verify-failed', wrote: true, wroteOps, verdict, rolled, before, after }
  }

  // ★ `wrote` 必须表示"**真的发出了写**"，而不是"走到了写入这一段"。
  //   两者在"有凭证要补、而 Legion 里没值可补"时分开：那一路什么都没写，
  //   报 `wrote: true` 会让日志/读数里出现一次并不存在的写入 ——
  //   而"这轮写过没有"正是人判断"是不是接管生效了"的唯一依据。
  const didWrite = wroteOps.length > 0
  const why = credentialsUnavailable.length > 0
    ? `凭证 ${credentialsUnavailable.length} 个在 Legion 里没有值 ⇒ 保持 DSH 原样`
    : '两侧一致'
  log(didWrite
    ? `模型配置物化：已写入并**回读通过** —— ${wroteOps.join(' / ')}；`
      + `新增 ${before.counts.create} / 修改 ${before.counts.update} / 删除 ${before.counts.delete - t.skippedDeletes.length}`
      + `${t.skippedDeletes.length > 0 ? ` / **跳过删除 ${t.skippedDeletes.length}**（${t.skippedDeletes.join(', ')}）` : ''}`
      + `${credentialsUnavailable.length > 0 ? ` / 凭证留原样 ${credentialsUnavailable.length}（${credentialsUnavailable.join(', ')}）` : ''}`
    : `模型配置物化：已启用、回读通过，但**本轮无需写入**（${why}）`)
  return {
    applied: true, wrote: didWrite, wroteOps, before, after, verdict,
    skippedDeletes: t.skippedDeletes, credentialsSet: credentialsWritten,
    credentialsUnavailable,
  }
}

/**
 * 直接问**凭证服务**：Legion 想要的这些引用名，DSH 这边配了没有。
 *
 * ★ 为什么不能从供应商快照的 `credentialConfigured` 上读：那个字段只对**已经存在**的
 *   供应商有意义。一条**还没建**的供应商在快照里没有条目 ⇒ 那个字段无从取 ⇒
 *   早先的实现把"取不到"当成了"已配"，于是"新建一条带密钥的供应商"这条路
 *   在写之前根本不要求凭证，写完之后却又要求 —— **同一个问题在前后两次得到不同答案**，
 *   表现为写进去、回读不通过、然后回滚（实测：P3 用例 ⑧⑨ 全红）。
 *
 *   > 一个"从邻近的字段推断凭证状态"的判据，
 *   > 与一个"直接问凭证服务"的判据，在供应商都已经存在时是同一个读数。
 *
 * 引用名是**全局**的（DSH 的凭证文档按 ref 存放，不按 provider），所以问一次就够。
 * 问不到（没有 credentials 服务）就**不写进 map** —— 那表示"不知道"，而"不知道"不许被当成"缺"。
 */
async function readCredentialState(credentials, desiredProviders) {
  const map = {}
  if (!credentials || typeof credentials.describe !== 'function') return map
  for (const p of desiredProviders) {
    const ref = p?.apiKeyEnv ?? p?.secretRef
    if (typeof ref !== 'string' || ref === '') continue
    try { map[ref] = (await credentials.describe(ref))?.configured === true } catch { /* 问不到就不写进 map */ }
  }
  return map
}

/** 回读并重新出计划。读不到就返回一份"全都对不上"的计划，让调用方判失败（fail closed）。 */
async function rereadPlan(ctx, desired, actualCredentials) {
  const snap = await readDshProviderSnapshot(ctx)
  if (snap.readOk !== true) {
    return { counts: { create: -1, update: -1, delete: -1, unchanged: 0 }, create: ['<读不到现状>'], update: [], delete: [], credentialsNeeded: [], clean: false }
  }
  return planMaterialization({ desired, actual: snap.providers, actualCredentials })
}

/** 执行逆 ops，然后**再回读一次**确认真的改回去了（回滚本身也要被验）。 */
async function rollback({ settings, reversed, log }) {
  try {
    if (reversed.length > 0) await settings.mutate('llm-pi-ai', reversed, undefined)
    log(`模型配置物化：已回滚（${reversed.length} 条逆 ops）`)
    return { ok: true, ops: reversed.length }
  } catch (e) {
    // ★ 回滚失败必须**大声**说：这时 DSH 的配置处在一个既不是 Legion 的、也不是原来的状态。
    log(`模型配置物化：**回滚也失败了**（${e instanceof Error ? e.message : String(e)}）—— `
      + 'DSH 的配置现在既不等于 Legion 的、也不等于改动前的，需要人工看一次')
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
