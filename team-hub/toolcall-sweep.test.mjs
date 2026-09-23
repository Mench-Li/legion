// team-hub/toolcall-sweep.test.mjs
// ============================================================================
// PRT-610 收账侧宿主（`toolcall-sweep.mjs`）的用例。
//
// 这一组钉的是**第 28 条裁决之后**才存在的那条路：目录从 `LEGION_DATA_DIR` 来、
// 收账住在 hub、交付按 Run。三个"看起来都对"的错法各有至少一条反面用例：
//
//   · 没给 DataDir 就**顺手从库的位置推**（乙的隐式耦合）⇒ ①；
//   · 把"车道目录不在"读成"收完了"⇒ ②；
//   · 把"这一趟处理了几条"读成"库里新增了几行"（收账必须能安全重跑）⇒ ③b。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOOLCALL_SPOOL_DIRNAME,
  TOOLCALL_SPOOL_FILENAME,
  TOOLCALL_SPOOL_KINDS,
  appendSpoolRecord,
  listSpooledRuns,
  spoolDirFor,
  spoolFileFor,
} from '../runtime/toolcall/spool.mjs'
import { ensureToolCallSchema, RESULT_STATUSES } from './tool-call-log.mjs'
import { TOOLCALL_SWEEP_CODES, sweepToolCallSpool } from './toolcall-sweep.mjs'

let seq = 0
/** 每个用例一棵**全新的树**（数据目录 + 库），免得"行数"这个读数互相污染。 */
function fresh() {
  seq += 1
  const root = mkdtempSync(join(tmpdir(), `legion-sweep-${process.pid}-${seq}-`))
  const db = new DatabaseSync(join(root, 'team.sqlite'))
  ensureToolCallSchema(db)
  return { root, db }
}

const T0 = '2026-09-23T02:00:00.000Z'

function decisionRecord(callId, over = {}) {
  return {
    kind: TOOLCALL_SPOOL_KINDS.DECISION,
    row: {
      callId,
      toolName: 'git-commit',
      decision: 'deny',
      decisionSource: 'pre-execute',
      reason: '策略门拒绝',
      rawInput: { message: 'x' },
      canonicalInput: { message: 'x' },
      canonicalHash: 'a'.repeat(64),
      runId: 'run-1',
      attemptId: 'att-1',
      atText: T0,
      ...over,
    },
  }
}

/** 库里真正落了几个不同的工具调用（不是"这一趟处理了几条"）。 */
function rowCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n
}

/** 一个 Run 的三条记录（决定 / 已派发 / 结果），与执行面写下的顺序逐字一致。 */
function writeRun(root, runId, callId) {
  const file = spoolFileFor({ dataDir: root, runId })
  appendSpoolRecord({ file, record: decisionRecord(callId, { runId }) })
  appendSpoolRecord({ file, record: { kind: TOOLCALL_SPOOL_KINDS.DISPATCHED, row: { callId, atText: T0 } } })
  appendSpoolRecord({
    file,
    record: {
      kind: TOOLCALL_SPOOL_KINDS.RESULT,
      row: { callId, status: RESULT_STATUSES.OK, result: { code: 0 }, atText: T0 },
    },
  })
  return file
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★★★ 没有 DataDir ⇒ 具名拒绝，**绝不**从库的位置推
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 没有 `LEGION_DATA_DIR` ⇒ 具名 `ran:false`，且**一次 db 都不碰**', () => {
  const { db } = fresh()
  let drainCalls = 0
  const reading = sweepToolCallSpool({
    db,
    env: {},                                  // ★ 刻意不给 DataDir
    drain: () => { drainCalls += 1; throw new Error('不该被调到') },
  })

  /**
   * ★ 这一条钉的是第 28 条**选项乙的代价**：能从库的位置推出车道的位置时，
   *   "库一挪账就断"不会报错，它只会让收账**成功地**收到零条。
   *   所以缺 DataDir 时这里必须**什么都不做**，并且说得出是"不知道位置"。
   */
  assert.equal(reading.ran, false)
  assert.equal(reading.code, TOOLCALL_SWEEP_CODES.NO_DATA_DIR)
  assert.match(reading.reason, /不从库的位置派生/)
  assert.equal(reading.complete, false, '没跑就不能读成"收完了"')
  assert.equal(reading.applied.total, 0)
  assert.equal(drainCalls, 0, '缺位置时不许去碰库')
  assert.equal(rowCount(db), 0)
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★ "车道目录不在"与"车道开着、这一趟没有坏的"必须可分
// ══════════════════════════════════════════════════════════════════════════

test('② ★★ 车道目录不在 ⇒ `present:false`（不是"收完了"）；目录在但空 ⇒ `present:true`', () => {
  const a = fresh()
  const absent = sweepToolCallSpool({ db: a.db, env: { LEGION_DATA_DIR: a.root } })
  assert.equal(absent.ran, true, '这一趟**跑了**（有位置可去）')
  assert.equal(absent.present, false, '车道从没开过')
  assert.equal(absent.complete, true, '而"没有东西没进去"也是真的')
  assert.deepEqual(absent.runs, [])

  const b = fresh()
  mkdirSync(join(b.root, TOOLCALL_SPOOL_DIRNAME), { recursive: true })
  const empty = sweepToolCallSpool({ db: b.db, env: { LEGION_DATA_DIR: b.root } })
  assert.equal(empty.present, true, '车道开着')
  assert.equal(empty.complete, true)
  assert.deepEqual(empty.runs, [])
  // 与 ① 的形状必须不同：那一条的 `ran` 是 false（位置不知道），这一条是 true。
  assert.notEqual(absent.ran, false && empty.ran)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ ★★★ 真环：两个 Run → 真库；再扫一趟必须幂等
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★★ 两个 Run 的 spool 文件 → 真库两行；重复扫**不新增行**，而 `applied` 报的是"这一趟处理了几条"', () => {
  const { root, db } = fresh()
  writeRun(root, 'run-a', 'call-a')
  writeRun(root, 'run-b', 'call-b')

  const first = sweepToolCallSpool({ db, env: { LEGION_DATA_DIR: root } })
  assert.equal(first.ran, true)
  assert.equal(first.present, true)
  assert.equal(first.complete, true, `不许有拒绝：${JSON.stringify(first.refusals)}`)
  assert.deepEqual(first.applied, { decision: 2, dispatched: 2, result: 2, total: 6 })
  assert.deepEqual(first.runs.map((r) => r.dirName), ['run-a', 'run-b'], '顺序必须确定（按目录名）')
  assert.equal(rowCount(db), 2, '库里是两个**不同的**调用')

  // ── ③b 重跑：现在**读数也幂等**了（第 118 轮第六轮修好）────────────────────
  //
  // 修好之前这里报 `complete:false` 外加两条带行号的 refusal（重放的 `dispatched` 被
  // 状态机拒绝）。`toolcall-drain.mjs` 头部 ② 声称"重跑必须安全"：**行**那一半一直成立，
  // **读数**那一半曾经不成立。现在收账先读状态，重放走 `replayed`。
  const second = sweepToolCallSpool({ db, env: { LEGION_DATA_DIR: root } })
  assert.equal(rowCount(db), 2, '★ 库里**一行都没多**——幂等键在 tool-calls 那一侧')
  assert.equal(second.complete, true, '★ 重放不许再报"有东西没进去"')
  assert.deepEqual(second.refusals, [], '一条拒绝都不该有')
  assert.equal(second.applied.total, 0, '★ 第二趟**什么都没写**（`applied` 只数真的写了的那几条）')
  assert.deepEqual(second.replayed, { decision: 2, dispatched: 2, result: 2, total: 6 },
    '★ 6 条全部如实报成重放')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★ 坏行逐条具名（带行号），好行照落
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★ 一条坏行 ⇒ 带行号的具名拒绝、`complete:false`，同 Run 的其它记录照常落账', () => {
  const { root, db } = fresh()
  const file = writeRun(root, 'run-bad', 'call-ok')
  // 追加一条**语义**非法（词表在 tool-call-log 那一侧）——写入端只看结构，所以写得进去。
  appendSpoolRecord({ file, record: decisionRecord('call-bad', { runId: 'run-bad', decisionSource: 'made-up' }) })

  const reading = sweepToolCallSpool({ db, env: { LEGION_DATA_DIR: root } })
  assert.equal(reading.complete, false, '有东西没进去就必须读得出来')
  assert.equal(reading.refusals.length, 1)
  assert.equal(reading.refusals[0].line, 4, '★ 拒绝必须带**行号**，否则知道错了也找不到它在哪')
  assert.equal(reading.applied.total, 3, '同 Run 的另外三条照常走了')
  assert.equal(rowCount(db), 1, '好的那条落库了')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ ★ 读不动目录 ⇒ 具名读数，不抛
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★ 车道目录读不动 ⇒ 具名 `LIST_FAILED`、不抛（tick 里抛出去会掀掉主服务）', () => {
  const { db } = fresh()
  const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const reading = sweepToolCallSpool({
    db,
    env: { LEGION_DATA_DIR: '/does/not/matter' },
    listRuns: () => { throw boom },
  })
  assert.equal(reading.ran, false)
  assert.equal(reading.code, 'EACCES')
  assert.equal(reading.complete, false)
  assert.equal(reading.refusals.length, 1)
  assert.match(reading.refusals[0].reason, /扫车道目录时失败/)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ ★ 车道目录里那个 Run 收账整体失败 ⇒ 具名拒绝，别的 Run 照收
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★ 单个 Run 收账抛 ⇒ 具名 `RUN_FAILED`，同趟的另一个 Run 照收（一个 Run 坏不拖垮全趟）', () => {
  const { root, db } = fresh()
  writeRun(root, 'run-ok', 'call-ok')
  writeRun(root, 'run-boom', 'call-boom')

  const reading = sweepToolCallSpool({
    db,
    env: { LEGION_DATA_DIR: root },
    drain: ({ file }) => {
      if (file.includes('run-boom')) {
        throw Object.assign(new Error('disk gone'), { code: 'EIO' })
      }
      return { present: true, complete: true, applied: { decision: 1, dispatched: 1, result: 1 }, refusals: [], total: 3 }
    },
  })
  assert.equal(reading.complete, false)
  assert.equal(reading.refusals.length, 1)
  assert.equal(reading.refusals[0].code, 'EIO')
  assert.match(reading.refusals[0].reason, /run-boom/)
  assert.equal(reading.applied.total, 3, '另一个 Run 照收')
  assert.deepEqual(reading.runs.map((r) => r.dirName), ['run-ok'])
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ ★★ 枚举器：只认目录、顺序确定、两种"空"分开
// ══════════════════════════════════════════════════════════════════════════

test('⑦ ★★ `listSpooledRuns`：只认目录（同名文件不是一条车道）、顺序确定、`present` 分得开', () => {
  const { root } = fresh()
  assert.deepEqual(listSpooledRuns({ dataDir: root }), { present: false, runs: [] })

  const lane = join(root, TOOLCALL_SPOOL_DIRNAME)
  mkdirSync(join(lane, 'run-z'), { recursive: true })
  mkdirSync(join(lane, 'run-a'), { recursive: true })
  writeFileSync(join(lane, 'README.md'), 'not a lane\n')   // ★ 同名文件：不是一条车道
  mkdirSync(join(lane, 'nested', 'deep'), { recursive: true })

  const listed = listSpooledRuns({ dataDir: root })
  assert.equal(listed.present, true)
  assert.deepEqual(listed.runs.map((r) => r.dirName), ['nested', 'run-a', 'run-z'],
    '按目录名排序；README.md 不是目录 ⇒ 不在里面')
  assert.equal(listed.runs[1].file, join(lane, 'run-a', TOOLCALL_SPOOL_FILENAME))
  // 目录名原样给出：**不反解 runId**（`safeRunId()` 单向，反解就得猜，猜错=两个 Run 合流）
  assert.equal(spoolDirFor({ dataDir: root, runId: 'run-a' }), join(lane, 'run-a'))
})
