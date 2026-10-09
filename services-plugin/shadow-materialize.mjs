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
  const qs = teamHubToken ? '?token=' + encodeURIComponent(teamHubToken) : ''
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
