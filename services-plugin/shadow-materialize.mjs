// services-plugin/shadow-materialize.mjs
// ============================================================================
// P2 的执行那一半：**读**两侧、算出计划、记一行读数 —— **一个字节都不写**。
//
// 它与 P3 的唯一区别就是"不写"，所以本模块的纪律也必须与此完全对称：
//
//   ★ 它**只碰读方法**。`ctx.settings.describe` / `ctx.credentials.describe` /
//     `ctx.llm.*` 之外一个都不调；`ctx.settings.mutate` / `ctx.credentials.set|unset`
//     在本模块里**一次都不出现**。这条不是靠"我记得"，而是靠用例：
//     夹具把 mutate/set/unset 换成"一被调用就抛并记名"的探针，
//     于是任何一次误写都会让用例红 —— 而 P3 落地时它也会同样红，
//     除非那时**有意**把这一条改成"允许写"（那是一个该被看见的改动，不是一个静默的漂移）。
//
// ## 为什么"读不到 DSH 现状"必须单独成一态
//
// `planMaterialization` 在两侧都空时会给 `clean: true`。而"读不到 DSH 现状"
// 会让 actual 为空 —— 于是**读失败会伪装成"完全一致"**。
// 这正是本仓反复出现的那一族错（BUG-009-a 的探测器、BUG-010 的假停摆、P1 的幂等读数）。
// 所以这一层显式把 `actualReadOk` 传下去，并由 `describeMaterializationPlan` 拒绝说 clean。
//
// ## 连续轮次的"空"由调用方记（这里只回报事实）
//
// "连续 N 轮 diff 为空才允许进 P3" 需要跨启动的计数，而那是**部署**的事实、
// 不是这一层的状态。本模块只回报 `clean` 与 `counts`；轮次连续性由调用方（与看日志的人）判定。
// ============================================================================

import { readDshProviderSnapshot } from './dsh-snapshot.mjs'
import { planMaterialization, describeMaterializationPlan } from './materialize-plan.mjs'

/**
 * 读 Legion 的目录（经中枢自己的 API —— 与 P1 的导入同一条路，不直连 team.db）。
 * 失败返回 null，由调用方按"读不到"处置（**不许当成空目录**）。
 */
async function fetchLegionProviders({ hubUpstream, teamHubToken, fetchImpl }) {
  // ★★★ 2026-10-12：**必须带 `includeSecretRefs=1`** —— 这一条是 P2→P3 那扇门的真根因。
  //
  //   实测（将军重启后，用新加的"物化读数"读出来的）：
  //
  //     新增 0 / 修改 3 / 删除 0 / 未变 1（clean=false）
  //     update = [{deepseek-official,[apiKeyEnv]}, {fjd-ds,[apiKeyEnv]}, {svea-ds,[apiKeyEnv,models]}]
  //
  //   而 `fjd-ds` 两侧明明都是 `FJD_DS_API_KEY`。原因就是这一行少了参数：
  //   hub 的默认读法**不含引用名**（那是密钥库的槽位清单，不该跟着读路径公开），
  //   于是 Legion 侧归一化后 `apiKeyEnv: null`，与 DSH 侧的真名字比**永远不等**
  //   ⇒ 凡是配了凭证的供应商都永久报一处幻影差异 ⇒ **这道门永远到不了 clean**。
  //
  //   ⚠ 同一个参数在 `materializer.mjs`（P3 写路径）里**早就加了**，还配了判据 ⑲；
  //     而这里是 P2 读路径 —— 同一个规则写成两处，只修了一处，于是：
  //
  //     > 一处"我读了另一份"的缺口，与一处"它真的不一样"的差异，
  //     > 在同一行 `修改 N` 里长得一模一样 ——
  //     > 只不过前者永远不会消失，而门禁的放行条件正是"它消失"。
  //
  //   现在两处都带，且由 `shadow-materialize.test.mjs` 的 ⑲ 与 `materializer.test.mjs`
  //   的 ⑲ 各钉一条（**同一个参数的验证也必须有两处**，否则下一次还是会漏一侧）。
  const qs = teamHubToken
    ? '?token=' + encodeURIComponent(teamHubToken) + '&includeSecretRefs=1'
    : '?includeSecretRefs=1'
  let res
  try {
    res = await fetchImpl(`${hubUpstream}/api/model-providers${qs}`, {
      method: 'GET',
      headers: teamHubToken ? { authorization: `Bearer ${teamHubToken}` } : {},
    })
  } catch (e) {
    // ★ 网络层抛错必须变成"读不到"，**不能**让它冒出去。
    //   冒出去的后果不是少一行日志：启动路径上这一轮是被 `await` 的，
    //   抛出会**跳过它后面的 `schedule.start()`** ⇒ P4 的周期收敛永远不启动，
    //   而唯一的症状是"日志里少了一行" —— 一个安静到几乎发现不了的失效。
    //   （这条在第一次真实重启前就被想到了：中枢刚起来的那一瞬间 ECONNREFUSED 是常态。）
    return { ok: false, reason: `连不上中枢（${e instanceof Error ? e.message : String(e)}）` }
  }
  if (res.status !== 200) return { ok: false, reason: `中枢返回 HTTP ${res.status}` }
  let body = null
  try { body = JSON.parse(await res.text()) } catch { return { ok: false, reason: '中枢响应不是 JSON' } }
  if (body === null || !Array.isArray(body.providers)) return { ok: false, reason: '中枢响应里没有 providers 数组' }
  return { ok: true, providers: body.providers }
}

/**
 * 跑一轮影子对账。**只读、只记日志。**
 *
 * @returns `{ ok, plan, line, legionReadOk, actualReadOk }` —— 调用方据此决定要不要记一笔、
 *   以及在"连续为空"的判定里怎么计。
 */
export async function runShadowMaterialization({ ctx, hubUpstream, teamHubToken = '', fetchImpl = fetch, log = () => {} } = {}) {
  const legion = await fetchLegionProviders({ hubUpstream, teamHubToken, fetchImpl })
  if (!legion.ok) {
    const line = `供应商影子对账：**读不到 Legion 的目录**（${legion.reason}）→ 本次无法对账（不是 clean）`
    log(line)
    return { ok: false, plan: null, line, legionReadOk: false, actualReadOk: false }
  }

  const snap = await readDshProviderSnapshot(ctx)
  // ★ 用 `readOk` 而不是"数组是不是空"去判断读失败：两者都是空数组，
  //   而把"读不出来"当成"DSH 是空的"会让影子对账报 clean —— 那正是"接管不用改"的来源。
  const actualReadOk = snap.readOk === true
  const plan = planMaterialization({ desired: legion.providers, actual: snap.providers })
  const line = describeMaterializationPlan(plan, { actualReadOk, actualReason: snap.reason })
  log(line)
  return {
    ok: actualReadOk,
    plan,
    line,
    legionReadOk: true,
    actualReadOk,
  }
}

/**
 * ★★ 2026-10-12：把这轮对账的**读数**上报给中枢（只读方向：中枢是收方，DSH 一点没动）。
 *
 * ## 为什么需要它
 *
 * 计划里那几处差异此前**只活在这一行日志里**（而且实测那份日志是乱码），
 * 于是"打开写入会改什么"这件事**没有任何人能看见** —— 包括要按它做决定的人。
 * 而决策文档 P2→P3 的放行条件恰恰是"连续几轮 diff 为空"，那要求**看得见** diff。
 *
 * ## 纪律
 *
 *   · 上报的是**计数与改了哪几个字段**，**不含任何值**（`plan` 里本来就只有 id 与字段名）；
 *   · **失败只记日志**：中枢没起来/网络抖动都不该影响对账本身，
 *     更不该把宿主的启动路径拖坏（与 `maybeBootstrapProviderImport` 同一条纪律）；
 *   · 读不出来（`actualReadOk:false` 或 `legionReadOk:false`）时**照样上报**：
 *     "这次没读到"本身就是要让面板看见的读数 —— 不上报会让人以为"没有差异"。
 */
export async function reportMaterializationReading({
  hubUpstream, teamHubToken = '', reading, fetchImpl = fetch, log = () => {},
} = {}) {
  const qs = teamHubToken ? '?token=' + encodeURIComponent(teamHubToken) : ''
  try {
    const res = await fetchImpl(`${hubUpstream}/api/model-materialization/reading${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(teamHubToken ? { authorization: `Bearer ${teamHubToken}` } : {}) },
      body: JSON.stringify(reading),
    })
    if (res.status !== 200) {
      log(`模型配置读数上报失败：中枢返回 HTTP ${res.status}（**不影响对账本身**）`)
      return { ok: false, status: res.status }
    }
    return { ok: true, status: 200 }
  } catch (e) {
    log(`模型配置读数上报失败：${e instanceof Error ? e.message : String(e)}（**不影响对账本身**）`)
    return { ok: false, status: 0 }
  }
}
