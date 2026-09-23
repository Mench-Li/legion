// team-hub/toolcall-sweep.mjs
// ============================================================================
// PRT-610 出站车道的**收账侧宿主**：把每个已开过车道的 Run 收进 `tool_calls`。
//
// 第 118 轮第五轮落地，压在第 28 条的裁决上（`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`
// §14.7 三条路，业主授权本会话定；取法与理由记在
// `docs/superpowers/prt/PRT-TAKEOVER-QUEUE-2026-09-23.md` §3.2.1）：
//
//   · **目录锚在 `LEGION_DATA_DIR`** —— 这是"既有配置量"，runtime（写侧）与
//     orchestrator 今天就已经各拿一份（`product/config-schema.mjs:1057` / `:1059`）；
//     不新登记键（甲要落进 runtime 那个**已缺 4 把键**的 `envNames`，第 19 条人工项 A）；
//     也**不**从库的位置派生（乙的隐式耦合，见下）。
//   · **宿主是 hub** —— 它是唯一持有**可写** db 的进程
//     （`team-hub/server.mjs:717` 的 `ensureToolCallSchema(db)`）。
//   · **交付按 Run**（丙的机制）：每个 Run 一个文件，一趟收一个文件。
//
// ## 一条判据：目录只从 `LEGION_DATA_DIR` 来，**绝不**从库的位置推
//
// 收账要同时知道"库在哪"与"车道在哪"，而这两个是**不同的锚**（`TEAM_HUB_DB` 与
// `LEGION_DATA_DIR`）。这里刻意**不**提供"从 dbFile 同级派生"的回落：那种派生会把
// "库一挪、账就断"变成一条隐式耦合，而隐式耦合的表现是一条**空读数**——
// 空目录是合法局面，收账会"成功"地什么也没收。
//
//   > 一个「库找不到就顺手在它旁边找账」的收账，
//   > 与一个「账真的空了」的收账，在返回值上是同一个东西——
//   > 只不过前者的成因永远不会出现在任何一份诊断里。
//
// 所以 `LEGION_DATA_DIR` 缺席时，本模块返回一个**具名**的 `ran:false`，而不是去猜。
//
// ## 不崩、不静默
//
// tick 的回调里抛出去会掀掉主服务（`setInterval` 没有别人接着）。所以每一层失败
// 都收成**具名读数**：没有 DataDir / 车道目录读不动 / 某个 Run 的收账失败 / 逐行的
// 落账拒绝——四者分开报，而"收了几条"永远是给出的那个数。
//
// ## ★★ 一处**先于接线发现**的缺陷：收账的读数不能安全重跑（本模块因此**还没接进 tick**）
//
// 实测（`.probe-idem.mjs`，同一个文件收两趟）：
//
// ```
// pass1: applied={decision:1,dispatched:1,result:1,total:3} complete=true  refusals=[]
// pass2: applied={decision:1,dispatched:0,result:1,total:2} complete=false
//        refusals=[{ line:2, code:'toolcall-drain-apply-failed',
//                    reason:'不能把 c1 标记为"已派发"：它不在 none 状态
//                            （要么已经派发过、要么已经有结果）——重复派发是外部写做两遍的直接原因' }]
// ```
//
// 凡是文件里**已经收过**的 `dispatched` 记录，第二次都会落进 `refusals` ⇒ `complete:false`；
// 而 `toolcall-drain.mjs` 头部 ② 逐字写着"结果是幂等的，而且**必须**是——因为'收了一半
// 崩了'是正常情况"。**行的幂等成立（库里一行不多），读数的幂等不成立。**
//
//   > 一个"重跑安全"的收账，与一个"重跑之后报告'有东西没进去'"的收账，
//   > 在只有第一趟的读数里是同一个东西。
//
// ⇒ 在 drain 的重放语义修好之前**不把本模块接进 tick**：一个每 30 秒把 `complete:false`
//   刷一遍的定时器，与一个坏掉的告警是同一个东西（而"总是叫狼来了的门禁会被关掉"）。
//   本模块今天只在"按 Run 的主路径"上被调用——那条路每个 Run 只收一次，读数是干净的。
//
// ## 与"按 Run 交付"的关系（如实）
//
// 本模块是**扫一趟**：它覆盖的是"Run 收口那一刻没人收"的局面（hub 当时没在跑、
// 那一刻的调用点出错、或写侧把记录追加在收口之后）。**按 Run 的主路径还在写侧那一条**
// （执行面按 Run 绑定 runId），届时主路径收完之后这一趟是空跑——那正是它该有的样子。
//
// @module team-hub/toolcall-sweep
// ============================================================================

import { listSpooledRuns } from '../runtime/toolcall/spool.mjs'
import { drainToolCallSpool } from '../orchestrator/worker/toolcall-drain.mjs'

export const TOOLCALL_SWEEP_VERSION = 'legion/toolcall-sweep@1'

/** 具名读数码。 */
export const TOOLCALL_SWEEP_CODES = Object.freeze({
  /** 没有 `LEGION_DATA_DIR`：车道的位置**不知道**，因此这一趟什么都没做（且不去猜）。 */
  NO_DATA_DIR: 'toolcall-sweep-no-data-dir',
  /** 车道目录存在但读不动（权限 / IO）。与"目录不在"分开。 */
  LIST_FAILED: 'toolcall-sweep-list-failed',
  /** 某一个 Run 的收账整体抛了（不是逐行拒绝）。 */
  RUN_FAILED: 'toolcall-sweep-run-failed',
})

/** 全零的 `applied`（四种读数一起，免得某个分支漏掉一种）。 */
function zeroApplied() {
  return Object.freeze({ decision: 0, dispatched: 0, result: 0, total: 0 })
}

/**
 * 扫一趟。
 *
 * @param {object} args
 * @param {object} args.db                `node:sqlite` 的 `DatabaseSync`（必须已有 `tool_calls` 表）
 * @param {object} [args.env]             读 `LEGION_DATA_DIR` 的地方（默认 `process.env`）
 * @param {Function} [args.listRuns]      注入 `listSpooledRuns`（用例用替身；生产用真的）
 * @param {Function} [args.drain]         注入 `drainToolCallSpool`
 * @returns {Readonly<object>} 具名读数（**不抛**）
 */
export function sweepToolCallSpool({
  db,
  env = process.env,
  listRuns = listSpooledRuns,
  drain = drainToolCallSpool,
} = {}) {
  const dataDir = env?.LEGION_DATA_DIR
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return Object.freeze({
      version: TOOLCALL_SWEEP_VERSION,
      ran: false,
      code: TOOLCALL_SWEEP_CODES.NO_DATA_DIR,
      reason: '没有 LEGION_DATA_DIR ⇒ 车道的位置不知道。**不从库的位置派生**'
        + '（第 28 条的选项乙就是那条隐式耦合）',
      present: false,
      runs: Object.freeze([]),
      applied: zeroApplied(),
      refusals: Object.freeze([]),
      complete: false,
    })
  }

  let listed
  try {
    listed = listRuns({ dataDir })
  } catch (err) {
    return Object.freeze({
      version: TOOLCALL_SWEEP_VERSION,
      ran: false,
      code: err?.code ?? TOOLCALL_SWEEP_CODES.LIST_FAILED,
      reason: `车道目录读不动：${err?.message ?? String(err)}`,
      present: false,
      runs: Object.freeze([]),
      applied: zeroApplied(),
      refusals: Object.freeze([Object.freeze({
        line: null,
        code: err?.code ?? TOOLCALL_SWEEP_CODES.LIST_FAILED,
        reason: `扫车道目录时失败：${err?.message ?? String(err)}`,
      })]),
      complete: false,
    })
  }

  const applied = { decision: 0, dispatched: 0, result: 0 }
  const refusals = []
  const runs = []
  for (const entry of listed.runs) {
    let reading
    try {
      reading = drain({ db, file: entry.file })
    } catch (err) {
      refusals.push(Object.freeze({
        line: null,
        code: err?.code ?? TOOLCALL_SWEEP_CODES.RUN_FAILED,
        reason: `Run 目录 ${entry.dirName} 收账失败：${err?.message ?? String(err)}`,
      }))
      continue
    }
    applied.decision += reading.applied.decision
    applied.dispatched += reading.applied.dispatched
    applied.result += reading.applied.result
    // 逐行的拒绝**带着行号往上递**：只报"这个 Run 有一条坏的"，值班的人知道有错
    // 却找不到它在哪一行——而"知道错在哪"与"能去改"是两件事。
    for (const refusal of reading.refusals) refusals.push(refusal)
    runs.push(Object.freeze({
      dirName: entry.dirName,
      present: reading.present,
      complete: reading.complete,
      applied: reading.applied,
      total: reading.total,
    }))
  }

  return Object.freeze({
    version: TOOLCALL_SWEEP_VERSION,
    ran: true,
    code: null,
    reason: '',
    // ★ `present:false`（车道目录不在）**不是**错误，但也不是"收完了"：
    //   与 `complete` 分开报，让"车道没开过"与"开着、这一趟没有坏的"分得开。
    present: listed.present,
    runs: Object.freeze(runs),
    applied: Object.freeze({
      decision: applied.decision,
      dispatched: applied.dispatched,
      result: applied.result,
      total: applied.decision + applied.dispatched + applied.result,
    }),
    refusals: Object.freeze(refusals),
    complete: refusals.length === 0,
  })
}
