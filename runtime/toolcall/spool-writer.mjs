// runtime/toolcall/spool-writer.mjs
// ============================================================================
// PRT-610 出站车道的**写入侧宿主**：把执行面**已经作出的**工具决定追加进车道文件。
//
// 这条车道的两半：本模块是**写入侧**（执行面按 Run 落盘），
// `orchestrator/worker/toolcall-drain.mjs` 是**收账侧**（有人把它收进 `tool_calls`，
// 宿主是 hub —— `team-hub/toolcall-sweep.mjs`）。
//
// ## ★★ 第 28 条第二个问题的答案：`runId` 在这里按**事件**取，不在装配期绑
//
// §14.5 量到的那处真设计问题：`spoolDirFor({dataDir, runId})` 是**逐 Run**一份，
// 而 `onDecision` 是**装配期**给的 —— 在装配期把 runId 绑死，会让**整个进程只往
// 第一个 Run 的账本里写**（"第二个 Run 的工具账不见了"）。
//
//   > 一个「装配期绑死 Run」的车道，与一个「只记第一个 Run」的车道，
//   > 是同一个东西——只不过前者的表现是"后面的 Run 没有工具账"，
//   > 而那读起来像"那些 Run 没调过工具"。
//
// ⇒ 本模块**不持有 Run**：`runIdOf(event)` 每次从**这一个事件**里取（组合根
//   用 `identityOverlayForExecution(execution)` 从按 Run 装上的身份覆盖里读）。
//   于是同一个进程里并发的两个 Run 各写各的文件。
//
// ## `dataDir` 也**不**从别处派生
//
// 目录锚是 `LEGION_DATA_DIR`（Launcher 按冻结布局注入，runtime 早就有这一行）。
// 缺它时本模块返回**具名**拒绝而**不写**，**不**回落成 cwd / 临时目录 / 库的邻居 ——
// 一个"随手找个地方写"的车道，与一个"写进了某个没人会来收的目录"的车道，
// 在返回值上是同一个东西（都成功），只不过后者永远收不到。
//
// ## 绝不把强制面炸掉
//
// `observeDecision` 是**事后通知**（`tool-request.mjs` 那一段逐字写着：检查必须在
// 返回之前，不能在 `onDecision` 里）。所以这里**任何**失败都收成具名读数并返回，
// **不抛**：一次记账失败不该把一次工具调用变成别的东西。
//
//   > 一个"记账失败就抛"的观察点，与一个"记账能改变判定"的观察点，是同一个东西。
//
// @module runtime/toolcall/spool-writer
// ============================================================================

import { TOOLCALL_SPOOL_KINDS, appendSpoolRecord, spoolFileFor } from './spool.mjs'

export const TOOLCALL_SPOOL_WRITER_VERSION = 'legion/toolcall-spool-writer@1'

/** 具名读数码。**每一个"没写进去"的理由都有自己的码**。 */
export const TOOLCALL_SPOOL_WRITER_CODES = Object.freeze({
  /** 没有 `LEGION_DATA_DIR`：车道的位置不知道（**不猜**、不回落）。 */
  NO_DATA_DIR: 'toolcall-writer-no-data-dir',
  /** 组合根没给行构造器（装配错误，不是数据问题）。 */
  NO_ROW_BUILDER: 'toolcall-writer-no-row-builder',
  /** 这条事件里读不出 Run 号 ⇒ **不写**（写了就会与别的 Run 合流）。 */
  NO_RUN_ID: 'toolcall-writer-no-run-id',
  /** 这条事件没带投影 ⇒ 不是工具调用级的决定，猜不出一行来。 */
  NO_PROJECTION: 'toolcall-writer-no-projection',
  /** 行构造器抛了 / 造出来的东西不是一个行。 */
  ROW_UNUSABLE: 'toolcall-writer-row-unusable',
  /** 追加到文件时失败（权限 / 磁盘 / 非法 Run 号目录分量）。 */
  APPEND_FAILED: 'toolcall-writer-append-failed',
})

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 造一个写入侧宿主。
 *
 * 依赖**全部注入**（`runIdOf` / `rowOf` / `append` / `fileFor`）：本模块因此只依赖
 * `spool.mjs`，而"从事件里取 Run 号"与"把事件翻成 `tool_calls` 的行"这两件
 * 需要组合面知识的事留在组合根那一侧（`root-row.mjs`）。
 *
 *   > 一个"自己 import 投影器与身份表"的写入模块，
 *   > 与一个"把执行面的两个内部形状写进车道契约"的模块，是同一个东西——
 *   > 只不过前者会让这条车道在 DSH 换一个内部形状时静静地停止工作。
 *
 * @param {object} args
 * @param {string|null} [args.dataDir]   车道目录的锚（`LEGION_DATA_DIR`）
 * @param {(event: object) => (string|null)} [args.runIdOf] 从**这一个事件**取 Run 号
 * @param {(event: object, runId: string) => (object|null)} [args.rowOf] 行构造器
 * @param {Function} [args.append]       `appendSpoolRecord`
 * @param {Function} [args.fileFor]      `spoolFileFor`
 * @param {() => string} [args.now]      取事件时间（只在行构造器没给 `atText` 时用）
 * @param {(reading: object) => void} [args.onReading] 观测点（**自己不许抛**是调用方的事）
 * @returns {Readonly<object>}
 */
export function createToolCallSpoolWriter({
  dataDir = null,
  runIdOf = () => null,
  rowOf = null,
  append = appendSpoolRecord,
  fileFor = spoolFileFor,
  now = () => new Date().toISOString(),
  onReading = null,
} = {}) {
  const counters = { written: 0, refused: 0 }
  let lastRefusal = null

  function refuse(code, reason) {
    counters.refused += 1
    lastRefusal = Object.freeze({ code, reason })
    // ★ 观测点自己抛也不许影响这里：它已经在"事后通知"路径上了。
    try { onReading?.(lastRefusal) } catch { /* 观测点坏了与判定无关 */ }
    return Object.freeze({ ok: false, code, reason, file: null })
  }

  /**
   * 收到一条工具决定。
   *
   * @param {object} event 桥的 `onDecision` 那一条：`{execution, decision, projection, ...}`
   * @returns {Readonly<{ok: boolean, code: string|null, reason: string, file: string|null}>}
   */
  function observeDecision(event) {
    try {
      if (!nonEmpty(dataDir)) {
        return refuse(TOOLCALL_SPOOL_WRITER_CODES.NO_DATA_DIR,
          '没有 LEGION_DATA_DIR ⇒ 车道写在哪里不知道。**不回落**成 cwd / 临时目录 / '
          + '库的邻居：一个"随手找个地方写"的车道，写进去的账没人会来收，而它看起来是成功的')
      }
      if (typeof rowOf !== 'function') {
        return refuse(TOOLCALL_SPOOL_WRITER_CODES.NO_ROW_BUILDER,
          '组合根没有给行构造器（`rowOf`）⇒ 造不出 `tool_calls` 那一行的形状，不猜一个')
      }
      const runId = runIdOf(event)
      if (!nonEmpty(runId)) {
        return refuse(TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID,
          '这条事件里读不出 Run 号 ⇒ **不写**。不回落成"进程级那一本"：'
          + '多个 Run 的账合流之后**读起来更完整**，而"哪个 Run 调了哪个工具"'
          + '正是这本账存在的理由')
      }
      if (event?.projection === null || event?.projection === undefined) {
        return refuse(TOOLCALL_SPOOL_WRITER_CODES.NO_PROJECTION,
          '这条事件没带投影（它不是工具调用级的决定）⇒ 猜不出一行来')
      }
      let row
      try {
        row = rowOf(event, runId)
      } catch (err) {
        return refuse(err?.code ?? TOOLCALL_SPOOL_WRITER_CODES.ROW_UNUSABLE,
          `行构造器抛了：${err?.message ?? String(err)}`)
      }
      if (row === null || row === undefined || typeof row !== 'object') {
        return refuse(TOOLCALL_SPOOL_WRITER_CODES.ROW_UNUSABLE,
          `行构造器给的是 ${row === null ? 'null' : typeof row}，而它必须是一个行对象`)
      }
      const file = fileFor({ dataDir, runId })
      append({ file, record: Object.freeze({ kind: TOOLCALL_SPOOL_KINDS.DECISION, row }) })
      counters.written += 1
      return Object.freeze({ ok: true, code: null, reason: '', file })
    } catch (err) {
      // ★ 追加失败（含非法 Run 号目录分量）：具名，且**不抛**。
      return refuse(err?.code ?? TOOLCALL_SPOOL_WRITER_CODES.APPEND_FAILED,
        `写车道文件失败：${err?.message ?? String(err)}`)
    }
  }

  return Object.freeze({
    version: TOOLCALL_SPOOL_WRITER_VERSION,
    observeDecision,
    /** 只读读数（诊断面/用例看它，判定不看它）。 */
    reading: () => Object.freeze({
      version: TOOLCALL_SPOOL_WRITER_VERSION,
      dataDir: nonEmpty(dataDir) ? dataDir : null,
      written: counters.written,
      refused: counters.refused,
      lastRefusal,
    }),
    /** 某个 Run 的车道文件路径（没配 DataDir 时 `null`）。 */
    fileOf: (runId) => (nonEmpty(dataDir) ? fileFor({ dataDir, runId }) : null),
    /** 事件时间（用例注入 `now` 用；行构造器通常自带 `atText`）。 */
    nowText: () => now(),
  })
}
