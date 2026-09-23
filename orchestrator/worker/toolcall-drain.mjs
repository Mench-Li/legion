// orchestrator/worker/toolcall-drain.mjs
// ============================================================================
// PRT-610 出站车道的**收账侧**：把执行面写下的逐 Run 载荷收进 `tool_calls`。
//
// 与 `runtime/toolcall/spool.mjs` 是**同一条车道的两半**：那一半在**没有凭证**的
// 执行面里写，这一半把 spool 收进 `tool_calls`。中间那一层是
// `team-hub/tool-call-log.mjs` —— 建表、三个写入函数（`recordToolCall` /
// `markDispatched` / `recordResult`）与 HTTP 读面都已经有了，缺的**只有生产的调用方**。
//
//   （本行原先引的是 `server.mjs:7296`，而那个文件只有 5676 行 —— 一处**指不到的
//   坐标**。它引的那句话也不在别处：见下面这条真正的边界。）
//
// ★★ 收账**住在哪个进程**是**尚未裁决**的（`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md`
//   §14.7 摆了三条路，业主还没选；那里逐字写着"本文件不替业主选"）：
//
//     · **甲** —— 新登记一个部署配置键，两半各自从自己的 env 读；
//     · **乙** —— 收账侧住在 **hub** 进程里，路径从 hub 自己的库位置派生
//       （`server.mjs:335` 那个 `dbFile` 的同级目录）；
//     · **丙** —— 照第 19 条的形状**按 Run** 把目录交给两半（PRT-214 已跑通两遍的
//       那五个性质）——**唯一与第 19 条裁决逐字一致**的一条。
//
//   第 118 轮一度给 hub 放行了 `LEGION_DATA_DIR`（理由是"只有它开着库"）——
//   那**就是乙**，等于用一个 diff 替业主选了。已撤回：
//   `product/launcher/launcher.mjs` 的 `derivedValuesFor()` 旁那段与用例
//   `runtime-contract-wiring.test.mjs` ①b″。
//
//   ⇒ 在裁决之前，本模块**不**假定宿主：它只要求一个 `db` 与一个 `file`，
//     "谁来调、什么时候调"留给调用侧。
//
// ```
//   runtime/toolcall/spool.mjs            orchestrator/worker/toolcall-drain.mjs
//   appendSpoolRecord({kind:'decision'}) ──▶ recordToolCall()
//   appendSpoolRecord({kind:'dispatched'}) ─▶ markDispatched()
//   appendSpoolRecord({kind:'result'})   ──▶ recordResult()
//                                           → toolCallLogEvidence().recorded === true
// ```
//
// ## 三个判断（每一个都写得成"反过来的写法是什么"）
//
// **① 坏记录逐条具名，好的照常落账，而"这趟有没有东西没进去"必须读得出来。**
//
// 两个都不取：
//   · "遇到坏记录就整条车道停下" ⇒ **一次格式事故**会让这个 Run 之后**所有**工具
//     调用都不落账（包括与那次事故毫无关系的），而账本看起来只是"后面没调工具"；
//   · "跳过坏记录、把这一趟读成『都处理完了』" ⇒ 那次事故**永远不出现在任何告警里**。
//
// 所以：坏记录进 `refusals`（带行号 + 具名码），其余照常落账，而返回值带
// `complete:false`。**"这一趟有东西没进去"不可能被读成"都进去了"。**
//
// **② 结果是幂等的，而且**必须**是——因为"收了一半崩了"是正常情况。**
// 收账要写多行（决定 / 已派发 / 结果），进程可能在任何两行之间死掉。重跑必须安全：
// `recordToolCall` 自己按 `callId` 去重（第二次返回 `duplicate`）、
// `markDispatched` / `recordResult` 是带条件的状态迁移。
// ⇒ 本模块**不删**处理过的记录，也不记"收到哪儿了"的游标：
//
//   > 一个「收完就删、并记一个游标」的收账，
//   > 与一个「游标落了、行没落」的收账，是同一个东西——
//   > 只不过前者在崩溃后会把**没落账的那几条**当成"已经收过了"。
//
// **②′ 但"重跑安全"要分两半 —— 另一半是第 118 轮第六轮才补上的。**
//
// 一句话：**行的幂等一直成立，读数的幂等曾经不成立。** 同一个文件收第二趟时，
// 已经收过的 `dispatched` 记录会被 `markDispatched` 的条件守卫拒绝（那条守卫是**对的**
// ——它防的是"重复派发＝外部写做两遍"），于是第二趟读成 `complete:false` 并带一条 refusal：
//
// ```
// pass1: applied={decision:1,dispatched:1,result:1,total:3} complete=true  refusals=[]
// pass2: applied={decision:1,dispatched:0,result:1,total:2} complete=false
//        refusals=[{line:2, code:'toolcall-drain-apply-failed', reason:'…不在 none 状态…'}]
// ```
//
// 修法**不在守卫那一侧**（它一个字都没动）：收账**先读状态** —— 行已经不在 `none`
// 就是一次**重放**，记 `outcome:'replayed'` 并跳过；`applied` 与 `replayed` 分开报。
// 直接调 `markDispatched` 的**派发路径**照旧会抛同样的错（有用例钉着）。
//
//   > 一个「重放安全」的收账，与一个「把重放读成第二次派发」的收账，
//   > 在**第一趟**的读数里是同一个东西。
//
// ⇒ 为什么这条重要：读数不幂等，"扫一趟"就永远报告"有东西没进去"，而一个每 30 秒
//   叫一次的告警会被关掉（`team-hub/toolcall-sweep.mjs` 头部记着这件事）。
//
// ★ 代价如实写在 §5 的边界里：车道文件会一直长，**裁剪不是本模块的事**。
//
// **③ `present:false`（这个 Run 没有车道文件）不是错误，但也不是"收完了"。**
// 字段分开报，让"这次 Run 没调过工具 / 车道没开"与"收账真的跑过了"在读数上分得开。
//
// @module orchestrator/worker/toolcall-drain
// ============================================================================

import { readSpoolRecords } from '../../runtime/toolcall/spool.mjs'
import {
  markDispatched,
  readToolCall,
  recordResult,
  recordToolCall,
  RESULT_STATUSES,
  toolCallIdempotencyKey,
} from '../../team-hub/tool-call-log.mjs'

export const TOOLCALL_DRAIN_VERSION = 'legion/toolcall-drain@1'

/** 收账期的具名码。 */
export const TOOLCALL_DRAIN_CODES = Object.freeze({
  /** 没给 db。 */
  NO_DB: 'toolcall-drain-no-db',
  /** 没给 file。 */
  NO_FILE: 'toolcall-drain-no-file',
  /** 执行面写的记录带了这一侧不认识的 kind。 */
  UNKNOWN_KIND: 'toolcall-drain-unknown-kind',
  /** 落这一条时下面的写入函数抛了（语义不合法、状态迁移不成立…）。 */
  APPLY_FAILED: 'toolcall-drain-apply-failed',
})

function drainError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/**
 * 把一条载荷落进 `tool_calls`。
 *
 * ★ 语义校验**恰好在这里发生一次**（`recordToolCall` 的 `assertSourceDecision`、
 * `recordResult` 的 `assertResultStatus`）——`spool.mjs` **故意**不校验语义。
 * 它在写入端通过、在这里被拒，是**设计**：词表只有一份。
 *
 * @returns {Readonly<{kind: string, outcome: string, idempotencyKey: string}>}
 */
export function applySpoolRecord({ db, record, atText = '' } = {}) {
  const row = record?.row ?? {}
  const kind = record?.kind
  if (kind === 'decision') {
    // ★★ 同一个形状（第 118 轮第六轮）：**已经收过的决定不许再走一遍 `recordToolCall`**。
    //
    // `recordToolCall` 的 duplicate 分支**会写** —— `attempts = attempts + 1` 与 `updatedAt`。
    // 于是"重放"会随着扫描次数把 `attempts` 抬上去，而 `attempts` 是**重试**的读数：
    // 把它记成"重试了 N 次"与真的重试过 N 次，在审计里是同一个东西。
    //
    // 只跳过**完全一致**的那些（工具名 + canonical 哈希）：不一致的仍然交给
    // `recordToolCall` 去抛 —— 那是一次真事故，不是重放（它那两条例外逐字写着理由：
    // 同一个 callId 带着不同的工具名/参数进来，"重试"就不再是同一次调用）。
    const existingKey = toolCallIdempotencyKey({ callId: row.callId })
    const existing = readToolCall({ db, idempotencyKey: existingKey })
    if (existing !== null
      && existing.toolName === row.toolName
      && existing.canonicalHash === row.canonicalHash) {
      return Object.freeze({ kind, outcome: 'replayed', idempotencyKey: existingKey })
    }
    const res = recordToolCall({
      db,
      callId: row.callId,
      toolName: row.toolName,
      decision: row.decision,
      decisionSource: row.decisionSource,
      reason: row.reason ?? null,
      rawInput: row.rawInput ?? null,
      canonicalInput: row.canonicalInput ?? null,
      canonicalHash: row.canonicalHash,
      attemptId: row.attemptId ?? null,
      runId: row.runId ?? null,
      scope: row.scope ?? null,
      taskId: row.taskId ?? null,
      atText: row.atText ?? atText,
    })
    return Object.freeze({ kind, outcome: res.outcome, idempotencyKey: res.idempotencyKey })
  }
  if (kind === 'dispatched') {
    // `markDispatched` / `recordResult` 收的是**幂等键**，不是 callId。
    // 键的算法**只有一份**（`tool-call-log.mjs` 的 `toolCallIdempotencyKey`，
    // 也正是 `recordToolCall` 内部用的那一个）——这里**引用它，不重算**。
    //
    //   > 一个「收账侧自己再算一遍幂等键」的车道，
    //   > 与一个「键不一致时 `markDispatched` 更新到 0 行」的车道，是同一个东西——
    //   > 只不过它的表现是"这条记录的结果还没回来"，而不是一次报错。
    const key = toolCallIdempotencyKey({ callId: row.callId })
    // ★★ **重放**与"第二次派发"必须先分开（第 118 轮第六轮，见文件头 ②′）。
    //
    // `markDispatched()` 的守卫是**故意**严的：它防的是"重复派发＝外部写做两遍"。
    // 但收账**从不派发**，它只是重放一份日志 —— 不加这一步，一行**已经收过**的
    // `dispatched` 会被那条守卫读成"有人在派发第二次"，于是整个文件的第二趟报
    // `complete:false`（实测：pass2 `applied.dispatched:0` + 一条 refusal）。
    //
    // ⇒ 先读状态：行已经不在 `none`（已派发过、或已有结果）就是**重放**，跳过并记成
    //   `outcome:'replayed'`。守卫**一个字都没放宽** —— 直接调 `markDispatched` 的
    //   派发路径照旧会抛同样的错（有用例钉着）。
    const before = readToolCall({ db, idempotencyKey: key })
    if (before !== null && before.resultStatus !== RESULT_STATUSES.NONE) {
      return Object.freeze({ kind, outcome: 'replayed', idempotencyKey: key })
    }
    const res = markDispatched({ db, idempotencyKey: key, atText: row.atText ?? atText })
    return Object.freeze({ kind, outcome: res.outcome, idempotencyKey: key })
  }
  if (kind === 'result') {
    const key = toolCallIdempotencyKey({ callId: row.callId })
    // 同一个形状：**已经落过同一个结果**就是重放。
    // 状态不同（例如库里是 `unknown`、记录里是 `ok`）⇒ **照旧写**，那是一次真实的状态推进。
    const settled = readToolCall({ db, idempotencyKey: key })
    if (settled !== null && settled.settledAt !== null && settled.resultStatus === row.status) {
      return Object.freeze({ kind, outcome: 'replayed', idempotencyKey: key })
    }
    const res = recordResult({
      db,
      idempotencyKey: key,
      status: row.status,
      result: row.result ?? null,
      atText: row.atText ?? atText,
    })
    return Object.freeze({ kind, outcome: res.outcome, idempotencyKey: key })
  }
  throw drainError(
    TOOLCALL_DRAIN_CODES.UNKNOWN_KIND,
    `执行面写下了一种这一侧不认识的 kind：${JSON.stringify(kind)}`,
  )
}

/**
 * 收一趟账。
 *
 * @returns {Readonly<{
 *   present: boolean, complete: boolean,
 *   applied: Readonly<{decision: number, dispatched: number, result: number, total: number}>,
 *   replayed: Readonly<{decision: number, dispatched: number, result: number, total: number}>,
 *   refusals: ReadonlyArray<{line: number|null, code: string, reason: string}>,
 * }>}
 *   `complete:false` ⇒ 有东西没进去（读不出来的行，或落账失败的行）。
 *   `applied` 只数**真的写了**的；已经在目标状态的那些走 `replayed`（见 ②′）。
 */
export function drainToolCallSpool({ db, file, atText = '' } = {}) {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw drainError(TOOLCALL_DRAIN_CODES.NO_DB, '收账需要 db（且必须有 prepare）')
  }
  if (typeof file !== 'string' || file.trim() === '') {
    throw drainError(TOOLCALL_DRAIN_CODES.NO_FILE, '收账需要 file')
  }

  const read = readSpoolRecords({ file })
  const refusals = [...read.refusals]
  const applied = { decision: 0, dispatched: 0, result: 0 }
  const replayed = { decision: 0, dispatched: 0, result: 0 }
  // ★ 按文件顺序落账。追加写 ⇒ 文件顺序 = 墙钟顺序，而 `recordResult` 依赖
  //   `recordToolCall` 已经落过那一行（它是一次 UPDATE）。
  // ★ 逐条带着**行号**：只报一个 `line: null` 的具名拒绝，值班的人知道"有一条坏了"
  //   却找不到它在哪一行——而"知道错在哪"与"能去改"是两件事。
  for (const { line, record: rec } of read.entries) {
    try {
      const res = applySpoolRecord({ db, record: rec, atText })
      // ★ 重放**不算 applied**：它一个字节都没写。两者混在一起，"这一趟收了几条"
      //   会随重跑次数增长，而库里的行数一步不动 —— 那种读数是不能用来判断"收完没有"的。
      if (res.outcome === 'replayed') replayed[res.kind] += 1
      else applied[res.kind] += 1
    } catch (err) {
      refusals.push(Object.freeze({
        line,
        code: err?.code ?? TOOLCALL_DRAIN_CODES.APPLY_FAILED,
        reason: `第 ${line} 行落账失败（kind=${JSON.stringify(rec?.kind)}，`
          + `callId=${JSON.stringify(rec?.row?.callId)}）：${err?.message ?? String(err)}`,
      }))
    }
  }
  refusals.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER))

  return Object.freeze({
    present: read.present,
    complete: refusals.length === 0,
    applied: Object.freeze({
      decision: applied.decision,
      dispatched: applied.dispatched,
      result: applied.result,
      total: applied.decision + applied.dispatched + applied.result,
    }),
    // ★★ **重放**（这一条已经在库里处于目标状态）与 `applied` 分开报（第 118 轮第六轮）。
    //   它今天在 sweep 那一侧是"第二趟不再报 `complete:false`"的依据。
    replayed: Object.freeze({
      decision: replayed.decision,
      dispatched: replayed.dispatched,
      result: replayed.result,
      total: replayed.decision + replayed.dispatched + replayed.result,
    }),
    refusals: Object.freeze(refusals),
    total: read.total,
  })
}

/** 默认就绪判据名（与 `release-gate.mjs` 的 `decisionSourceRecorded` 对齐）。 */
export const TOOLCALL_DRAIN_READINESS = 'decisionSourceRecorded'

/**
 * 装了这条车道没有？——供部署自检读。
 *
 * ★ **三个桶而不是两个**，而且分桶用的是**执行面有没有在写**与**账上有没有落**这两件
 * 不同的事：`recorded:false` 把下面三种情况读成同一个读数，而它们的处置完全不同。
 *
 * | 桶 | 判据 | 该去查什么 |
 * | --- | --- | --- |
 * | `unwired` | 收账**没有跑过**，或跑了而执行面**从来没写过**（`present:false`） | 接线：执行面那一半没装上 |
 * | `idle` | 执行面**写了**，但一条都没落进账（全被拒 / 状态迁移不成立） | 数据：去看 `refusals` |
 * | `wired` | 账上已经有带决定来源的行 | —— |
 *
 *   > 一个「只有装了 / 没装」两态的自检，
 *   > 与一个「把『没接线』与『接了但一条都没收到』读成同一句话」的自检，
 *   > 是同一个东西——只不过前者会让人去**改接线**，而问题在数据里。
 *
 * @param {{evidence: object, drain?: object|null}} args
 *   `evidence` = `toolCallLogEvidence()` 的返回；
 *   `drain` = `drainToolCallSpool()` 的返回，**`null`/省略表示从来没跑过**。
 */
export function toolCallDrainStatus({ evidence, drain = null } = {}) {
  const recorded = evidence?.recorded === true
  if (recorded) {
    return Object.freeze({
      state: 'wired',
      readiness: TOOLCALL_DRAIN_READINESS,
      ok: true,
      reason: evidence?.reason ?? '账上有带决定来源的行',
    })
  }
  if (drain === null || drain === undefined) {
    return Object.freeze({
      state: 'unwired',
      readiness: TOOLCALL_DRAIN_READINESS,
      ok: false,
      reason: '这条车道**没有被调用过**（收账那一步没有接上）'
        + ` —— ${evidence?.reason ?? '（没有更多读数）'}`,
    })
  }
  if (drain.present !== true) {
    return Object.freeze({
      state: 'unwired',
      readiness: TOOLCALL_DRAIN_READINESS,
      ok: false,
      reason: '收账跑过了，但**执行面从来没有为这个 Run 写过东西**'
        + '（没有车道文件）—— 接线的那一半没装上'
        + ` —— ${evidence?.reason ?? '（没有更多读数）'}`,
    })
  }
  const refusals = Array.isArray(drain.refusals) ? drain.refusals.length : 0
  // ★ 重放要与"落进账"分开报（第 118 轮第六轮）：一个已经把这一趟**全部重放**过的读数，
  //   说"落进账的有 0 条"字面上没错、读起来却是"一条都没收"——而它其实什么都收完了。
  const replayed = Number(drain.replayed?.total ?? 0)
  return Object.freeze({
    state: 'idle',
    readiness: TOOLCALL_DRAIN_READINESS,
    ok: false,
    reason: `执行面写了 ${drain.total ?? 0} 条，落进账的有 ${drain.applied?.total ?? 0} 条`
      + (replayed > 0 ? `（另有 ${replayed} 条**已经在账上了**，属重放，不是没收）` : '')
      + (refusals > 0 ? `，另有 ${refusals} 条被拒（去看 refusals 里的行号）` : '')
      + ` —— ${evidence?.reason ?? '（没有更多读数）'}`,
  })
}

/**
 * 装载时自检：`TOOLCALL_DRAIN_CHECKED` 只是把这一侧的契约摆出来给门禁读，
 * 它**不**复制任何词表——`decisionSource` / `status` 的合法取值只有
 * `team-hub/tool-call-log.mjs` 那一份，本模块靠调用它来校验。
 */
export const TOOLCALL_DRAIN_CHECKED = Object.freeze({
  version: TOOLCALL_DRAIN_VERSION,
  readiness: TOOLCALL_DRAIN_READINESS,
  codes: Object.freeze(Object.values(TOOLCALL_DRAIN_CODES)),
  /** 收账只走这三个写入函数——一个不多、一个不少。 */
  writes: Object.freeze(['recordToolCall', 'markDispatched', 'recordResult']),
})
