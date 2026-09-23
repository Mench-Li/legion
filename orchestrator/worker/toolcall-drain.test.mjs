// orchestrator/worker/toolcall-drain.test.mjs
// ============================================================================
// PRT-610 出站车道的**收账侧**判据——以及**整条环**的证明。
//
// 这一套件的存在理由是一句可以在库里读出来的话：
//
//   `team-hub/routes/tool-calls.mjs:61`  「写侧只有一个入口：执行面调 `recordToolCall`。
//                                  本进程只提供**读**与建表。」
//
//   ★ 第 52 轮改指：这句话原来在 `team-hub/server.mjs:7296`，
//     而 PRT-316 的模块提取把它搬进了 `routes/tool-calls.mjs`。
//     ⇒ 一条**行号引用**与它指的东西之间隔着一份**别人正在改的文件**，
//       而"引用漂了"与"被引用的东西没了"在读数上长得一样。
//
// 而在第 21 轮之前，那个入口的**生产调用方是 0 处** ⇒
// `toolCallLogEvidence().recorded` 永远 `false` ⇒ 发布就绪判据
// `decisionSourceRecorded` 在生产里**没有任何产出者**。本套件的 ① 就是
// **把那个判据真的翻成 true**，用的是一条真实走过的车道，不是手工插一行。
//
// 每一例都在问：**反过来的写法会表现成什么**。
//
//   · ① ★★★ 整条环：spool(执行面) → drain(worker) → 真 SQLite → recorded:true
//   · ② 语义校验**恰好一次**（在收账侧，不在写入侧）
//   · ③ 重跑安全：收了两遍，行还是一行，且如实报 duplicate
//   · ④ 坏记录逐条具名，好的照常落账，`complete:false`
//   · ⑤ 缺文件不是错误，但也不是"收完了"（三个桶：unwired / idle / wired）
//   · ⑥ 顺序：先派发再落结果（反过来会丢结果，且理由是具名的）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  TOOLCALL_DRAIN_CHECKED,
  TOOLCALL_DRAIN_CODES,
  TOOLCALL_DRAIN_READINESS,
  applySpoolRecord,
  drainToolCallSpool,
  toolCallDrainStatus,
} from './toolcall-drain.mjs'
import {
  TOOLCALL_SPOOL_KINDS,
  appendSpoolRecord,
  encodeSpoolRecord,
  spoolFileFor,
} from '../../runtime/toolcall/spool.mjs'
import {
  RESULT_STATUSES,
  TOOL_CALL_TABLE,
  ensureToolCallSchema,
  markDispatched,
  readToolCall,
  toolCallIdempotencyKey,
  toolCallLogEvidence,
} from '../../team-hub/tool-call-log.mjs'

const root = mkdtempSync(join(tmpdir(), 'legion-toolcall-drain-'))
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

let dbSeq = 0
/** 每个用例一个**全新的真库**（表也真的建）——共享一个库会让"行数"这个读数互相污染。 */
function freshDb() {
  dbSeq += 1
  const db = new DatabaseSync(join(root, `db-${dbSeq}.sqlite`))
  ensureToolCallSchema(db)
  return db
}

/** 执行面那一侧会写下的三种记录。`decision` 的字段**逐字**取自 `toolCallRowOf()`。 */
function decision(kind, row) {
  return { kind, row }
}

const T0 = '2026-09-18T06:00:00.000Z'

function decisionRecord(callId, over = {}) {
  return decision(TOOLCALL_SPOOL_KINDS.DECISION, {
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
  })
}

// ══════════════════════════════════════════════════════════════════════════
// ① ★★★ 整条环
// ══════════════════════════════════════════════════════════════════════════

test('① ★★★ 执行面写 spool → worker 收账 → 真库里有了带来源的行 ⇒ recorded 翻 true', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-loop' })

  // ── 收账之前：就绪判据说"表在，但没有一条带来源的行" ──────────────────
  const before = toolCallLogEvidence({ db })
  assert.equal(before.state, 'readable', '表已经建好了')
  assert.equal(before.total, 0)
  assert.equal(before.recorded, false, '★ 收账之前必须是 false——这本就是今天生产的读数')

  // ── 执行面那一侧：三次追加（决定 / 已派发 / 结果），**没有任何 hub 访问** ──
  appendSpoolRecord({ file, record: decisionRecord('call-1') })
  appendSpoolRecord({ file, record: decision(TOOLCALL_SPOOL_KINDS.DISPATCHED, { callId: 'call-1', atText: T0 }) })
  appendSpoolRecord({ file, record: decision(TOOLCALL_SPOOL_KINDS.RESULT, { callId: 'call-1', status: RESULT_STATUSES.OK, result: { code: 0 }, atText: T0 }) })

  // ── worker 那一侧：收账 ───────────────────────────────────────────────
  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.present, true)
  assert.equal(drained.complete, true, '没有一条读不出来')
  assert.deepEqual(
    { d: drained.applied.decision, s: drained.applied.dispatched, r: drained.applied.result },
    { d: 1, s: 1, r: 1 },
    '三种记录各落一条',
  )
  assert.equal(drained.refusals.length, 0)

  // ── 真库里的那一行：形状与内容都要对 ────────────────────────────────
  const row = readToolCall({ db, idempotencyKey: drained.applied.total === 3 ? undefined : undefined }) // 占位，下面用真键
  assert.equal(row, null, '没有键就不该读到东西（`undefined` 不会匹配任何一行）')

  const evidence = toolCallLogEvidence({ db })
  assert.equal(evidence.total, 1, '一次工具调用 = 一行')
  assert.equal(evidence.sourced, 1, '这一行带着决定来源')
  assert.equal(evidence.recorded, true, '★★★ 就绪判据 `decisionSourceRecorded` 至此**真的有产出者了**')

  // 结果状态也真的落了（证明 dispatched → result 那条状态机走通了）
  const db2 = db
  const one = db2.prepare(`SELECT * FROM ${TOOL_CALL_TABLE} LIMIT 1`).get()
  assert.equal(one.decisionSource, 'pre-execute', '来源逐字')
  assert.equal(one.decision, 'deny')
  assert.equal(one.toolName, 'git-commit')
  assert.equal(one.resultStatus, RESULT_STATUSES.OK, '结果是 ok（先派发后落结果才可能）')
  assert.equal(one.dispatchedAt, T0, '已派发时刻落上了')
  assert.equal(JSON.parse(one.rawInput).message, 'x', '原始输入原样')
  assert.equal(JSON.parse(one.canonicalInput).message, 'x', 'canonical 输入原样')

  // ── 与 release-gate 的判据名对齐（不是自己编一个名字） ───────────────
  assert.equal(TOOLCALL_DRAIN_READINESS, 'decisionSourceRecorded')
  assert.equal(TOOLCALL_DRAIN_READINESS, 'decisionSourceRecorded')
})

test('①b ★★ 这条环的**否定对照**：不跑收账，同样的 spool 不会让 recorded 变 true', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-noop' })
  appendSpoolRecord({ file, record: decisionRecord('call-9') })
  // 只写不收
  assert.equal(toolCallLogEvidence({ db }).recorded, false, '写了但没收 ⇒ 账上仍然没有行')
  assert.equal(toolCallLogEvidence({ db }).total, 0)
})

// ══════════════════════════════════════════════════════════════════════════
// ② ★★★ 语义校验恰好一次（在收账侧）
// ══════════════════════════════════════════════════════════════════════════

test('② ★★★ 语义不合法的记录：写入端照收，**收账端**才拒——而且理由是来源本身', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-badsem' })
  // 结构合法、语义不可能：guard 只有降级语义，给不出 allow
  const impossible = decisionRecord('call-bad', { decisionSource: 'guard', decision: 'allow' })
  assert.doesNotThrow(() => appendSpoolRecord({ file, record: impossible }), '写入端只看结构')

  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.applied.total, 0, '一条都没落进去')
  assert.equal(drained.complete, false, '★ 必须报"这一趟有东西没进去"')
  assert.equal(drained.refusals.length, 1)
  assert.match(drained.refusals[0].reason, /guard/, '理由要说出是**来源**的问题')
  assert.equal(toolCallLogEvidence({ db }).recorded, false, '账上仍然没有带来源的行')
})

test('②b 未知来源也被收账侧拒（词表只有 tool-call-log.mjs 那一份）', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-unknown-source' })
  appendSpoolRecord({ file, record: decisionRecord('c-x', { decisionSource: 'made-up' }) })
  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.complete, false)
  assert.match(drained.refusals[0].reason, /来源|source/i)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ ★★★ 重跑安全
// ══════════════════════════════════════════════════════════════════════════

test('③ ★★★ 收两遍：行还是一行，第二遍如实报**重放**（崩溃后重跑必须安全）', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-twice' })
  appendSpoolRecord({ file, record: decisionRecord('call-2') })

  const first = drainToolCallSpool({ db, file })
  assert.equal(first.applied.decision, 1)
  assert.equal(first.complete, true)
  const ev1 = toolCallLogEvidence({ db })
  assert.equal(ev1.total, 1)

  const second = drainToolCallSpool({ db, file })
  assert.equal(second.complete, true, '重跑本身不算"有东西没进去"')
  /**
   * ★★ 第 118 轮第六轮之前，这一行断的是 `second.applied.decision === 1` ——
   *   那时第二遍走的仍是 `recordToolCall` 的 duplicate 分支，而**那个分支会写**
   *   （`attempts + 1`、`updatedAt`）。"报 duplicate"与"什么都没写"因此是两件事，
   *   而当时的用例把前者当成了幂等的证据。
   *
   * ⇒ 现在收账先读状态，重放走 `replayed`：`applied` 只数**真的写了**的那些。
   *   （`recordToolCall` 自己的 duplicate 语义没变，它在 `tool-call-log` 那一侧照旧被验。）
   */
  assert.equal(second.applied.decision, 0, '重放不该再写一遍')
  assert.equal(second.replayed.decision, 1, '它如实报的是重放')
  assert.equal(toolCallLogEvidence({ db }).total, 1, '★ 行数没有变成 2')
  assert.equal(readToolCall({ db, idempotencyKey: toolCallIdempotencyKey({ callId: 'call-2' }) }).attempts, 0,
    '★ 重放不是重试：`attempts` 必须一步不动')

  // ★ 为什么必须幂等：收一趟要写多行，进程可能死在两行之间。
  //   本模块**不删**处理过的记录，也不记游标——
  //   一个「收完就删 + 记游标」的收账会在崩溃后把没落的几条当成"已经收过了"。
  const src = readFileSync(new URL('./toolcall-drain.mjs', import.meta.url), 'utf8')
  for (const banned of ['unlinkSync', 'rmSync', 'truncateSync', 'writeFileSync']) {
    assert.ok(!src.includes(banned), `收账不该出现 ${banned}：它会把"还没落账的记录"删掉`)
  }
})

test('③b ★★★ 同一条 `dispatched` 收两遍 ⇒ 第二遍是**重放**（不再拒绝），而守卫**没被放宽**', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-disp-twice' })
  appendSpoolRecord({ file, record: decisionRecord('call-3') })
  appendSpoolRecord({ file, record: decision(TOOLCALL_SPOOL_KINDS.DISPATCHED, { callId: 'call-3', atText: T0 }) })

  const first = drainToolCallSpool({ db, file })
  assert.equal(first.complete, true)
  assert.deepEqual(first.applied, { decision: 1, dispatched: 1, result: 0, total: 2 })
  assert.equal(first.replayed.total, 0)

  const again = drainToolCallSpool({ db, file })
  /**
   * ★★★ 第 118 轮第六轮改的就是这一条。**在这之前**它的期望是"第二遍必须被具名拒绝"，
   *   而那正是那条声称（头部 ②"重跑必须安全"）与行为之间的缺口：行幂等、**读数不幂等**。
   *   `markDispatched` 的守卫没错（它防的是重复派发＝外部写做两遍），错的是**收账**去撞它 ——
   *   收账从不派发，它只是重放一份日志。
   *
   * ⇒ 现在收账**先读状态**：行已经不在 `none` 就是重放，记 `outcome:'replayed'` 并跳过。
   */
  assert.equal(again.complete, true, '重放不许再报"有东西没进去"')
  assert.deepEqual(again.refusals, [])
  assert.equal(again.applied.dispatched, 0, '重放一个字节都没写')
  assert.equal(again.replayed.dispatched, 1)
  assert.equal(again.replayed.decision, 1,
    '决定的重放也不许写 —— `recordToolCall` 的 duplicate 分支会抬 `attempts`')
  // ★ `attempts` 是**重试**的读数；重放不是重试，所以它必须一步不动。
  assert.equal(readToolCall({ db, idempotencyKey: toolCallIdempotencyKey({ callId: 'call-3' }) }).attempts, 0,
    '重放把 attempts 抬上去了 —— 那会让审计读成"这条调用重试过"')

  /**
   * ★★ 而那条守卫**一个字都没放宽**：不经收账、直接走派发路径，照旧抛同样的错。
   *   没有这一条，上面的"跳过"就可能被人顺手做成"把守卫改成忽略"。
   */
  assert.throws(
    () => markDispatched({ db, idempotencyKey: toolCallIdempotencyKey({ callId: 'call-3' }), atText: T0 }),
    /none 状态/,
    '重复派发仍然是外部写做两遍的直接原因 —— 收账的跳过只发生在收账那一侧',
  )
})

// ══════════════════════════════════════════════════════════════════════════
// ④ ★★★ 坏记录逐条具名，好的照常落账
// ══════════════════════════════════════════════════════════════════════════

test('④ ★★★ 中间一条坏掉：其余照常落账，坏的具名带行号，complete=false', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-mixed' })
  appendSpoolRecord({ file, record: decisionRecord('good-1') })
  appendSpoolRecord({ file, record: decisionRecord('bad-1', { decisionSource: 'nope' }) }) // 语义坏
  appendSpoolRecord({ file, record: decisionRecord('good-2') })

  // 再把第 4 行写成坏 JSON（格式坏）
  writeFileSync(file, readFileSync(file, 'utf8') + '{"kind":"decision","row":{\n', 'utf8')

  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.applied.decision, 2, '★ 两条好的**照常落账**（不因为一条坏的整条车道停下）')
  assert.equal(drained.complete, false, '★ 而"有东西没进去"必须读得出来')
  assert.equal(drained.refusals.length, 2, '坏的两条各自具名')
  const lines = drained.refusals.map((r) => r.line).sort()
  assert.deepEqual(lines, [2, 4], '行号如实（第 2 行语义坏、第 4 行格式坏）')
  assert.equal(toolCallLogEvidence({ db }).total, 2, '账上是那两条好的')

  // ★★ 两个都不取的写法各自的读数（写下来，是为了让"选了这个"是一个决定而不是默认）：
  //   · 遇坏即停 ⇒ applied.decision 会是 1，而 good-2 永远不落账；
  //   · 静默跳过 ⇒ 完全相同的 applied.decision=2，但**没有任何地方**说少了东西。
  const silentSkipWouldLookLike = { applied: 2, complete: true }
  assert.equal(drained.applied.decision, silentSkipWouldLookLike.applied, '两种写法的"落了几条"完全一样')
  assert.notEqual(drained.complete, silentSkipWouldLookLike.complete, '差别只在 complete')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 三个桶：unwired / idle / wired
// ══════════════════════════════════════════════════════════════════════════

test('⑤ ★★ 缺文件（车道没开）不是错误，但也不是"收完了"；三态分得开', () => {
  const db = freshDb()
  const missing = spoolFileFor({ dataDir: root, runId: 'run-never' })
  const drained = drainToolCallSpool({ db, file: missing })
  assert.equal(drained.present, false, '没写过的 Run')
  assert.equal(drained.complete, true, '没文件**不是**不完整')
  assert.equal(drained.applied.total, 0)
  assert.equal(drained.refusals.length, 0)

  // 三态：没接过 / 接了但执行面从没写过 / 执行面写了但一条没落
  const unwired = toolCallDrainStatus({ evidence: toolCallLogEvidence({ db }), drain: null })
  assert.equal(unwired.state, 'unwired', '压根没跑过 ⇒ unwired（去查**接线**）')
  assert.equal(unwired.ok, false)
  assert.match(unwired.reason, /没有被调用过/)

  const presentButEmpty = toolCallDrainStatus({ evidence: toolCallLogEvidence({ db }), drain: drained })
  assert.equal(presentButEmpty.state, 'unwired', '跑了、但执行面从来没写过 ⇒ 仍是接线问题')
  assert.match(presentButEmpty.reason, /从来没有为这个 Run 写过东西/)

  // 执行面**写了**，但语义不合法 ⇒ 全被拒 ⇒ idle（去查**数据**）
  const wroteFile = spoolFileFor({ dataDir: root, runId: 'run-wrote-bad' })
  appendSpoolRecord({ file: wroteFile, record: decisionRecord('c-bad', { decisionSource: 'made-up' }) })
  const rejected = drainToolCallSpool({ db, file: wroteFile })
  assert.equal(rejected.present, true)
  assert.equal(rejected.applied.total, 0, '一条都没落')
  assert.equal(rejected.refusals.length, 1)
  const idle = toolCallDrainStatus({ evidence: toolCallLogEvidence({ db }), drain: rejected })
  assert.equal(idle.state, 'idle', '写了、被拒了 ⇒ idle（去查 refusals 的行号）')
  assert.equal(idle.ok, false)
  assert.match(idle.reason, /1 条被拒/)

  // ★ unwired 与 idle 在 `evidence.recorded` 上是**同一个读数**（都是 false），
  //   而处置完全不同（改接线 vs 改数据）——这就是为什么要有三个桶。
  const ev = toolCallLogEvidence({ db })
  assert.equal(ev.recorded, false, '三种没接好的情况在 recorded 上都长这样')
  assert.equal(idle.ok, unwired.ok, '两者 ok 相同')
  assert.notEqual(idle.state, unwired.state, '而桶名不同')
  assert.notEqual(idle.reason, unwired.reason, '理由也不同')

  // 真收一条合法的之后就变 wired
  appendSpoolRecord({ file: wroteFile, record: decisionRecord('c-wire') })
  const wiredDrain = drainToolCallSpool({ db, file: wroteFile })
  assert.equal(wiredDrain.applied.total, 1)
  const wired = toolCallDrainStatus({ evidence: toolCallLogEvidence({ db }), drain: wiredDrain })
  assert.equal(wired.state, 'wired')
  assert.equal(wired.ok, true, '★ 就绪判据至此为真')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 顺序：先派发，再落结果
// ══════════════════════════════════════════════════════════════════════════

test('⑥ ★★ 只有 result 没有 dispatched ⇒ 具名拒绝（顺序是可重试性的全部依据）', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-result-first' })
  appendSpoolRecord({ file, record: decisionRecord('call-r') })
  appendSpoolRecord({ file, record: decision(TOOLCALL_SPOOL_KINDS.RESULT, { callId: 'call-r', status: RESULT_STATUSES.OK, atText: T0 }) })

  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.applied.decision, 1)
  assert.equal(drained.applied.result, 0, '结果落不进去')
  assert.equal(drained.complete, false)
  assert.match(drained.refusals[0].reason, /没有"已派发"记录/, '理由是那条顺序，不是"文件坏了"')
  // 而那一行仍然是 `none`：**确定没派发过**，所以重试是安全的
  const one = db.prepare(`SELECT * FROM ${TOOL_CALL_TABLE} LIMIT 1`).get()
  assert.equal(one.resultStatus, RESULT_STATUSES.NONE)
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 契约面
// ══════════════════════════════════════════════════════════════════════════

test('⑦ 参数缺失具名拒绝；`applySpoolRecord` 对未知 kind 具名拒绝', () => {
  assert.throws(() => drainToolCallSpool({ file: 'x' }), (e) => e.code === TOOLCALL_DRAIN_CODES.NO_DB)
  assert.throws(() => drainToolCallSpool({ db: freshDb(), file: '' }), (e) => e.code === TOOLCALL_DRAIN_CODES.NO_FILE)
  assert.throws(
    () => applySpoolRecord({ db: freshDb(), record: { kind: 'nope', row: {} } }),
    (e) => e.code === TOOLCALL_DRAIN_CODES.UNKNOWN_KIND,
  )
  assert.equal(TOOLCALL_DRAIN_CHECKED.readiness, 'decisionSourceRecorded')
  assert.deepEqual([...TOOLCALL_DRAIN_CHECKED.writes], ['recordToolCall', 'markDispatched', 'recordResult'])
})

test('⑦b 收账侧**只**调那三个写入函数（没有第二条写路径）', () => {
  const src = readFileSync(new URL('./toolcall-drain.mjs', import.meta.url), 'utf8')
  for (const banned of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
    assert.ok(
      !src.includes(banned),
      `收账侧不该自己写 SQL（出现 ${JSON.stringify(banned)}）：写侧只有 tool-call-log.mjs 那三个函数`,
    )
  }
})

test('⑦c `encodeSpoolRecord` 与 `appendSpoolRecord` 的产出能被收账侧原样吃下（接口对齐）', () => {
  const db = freshDb()
  const file = spoolFileFor({ dataDir: root, runId: 'run-encode' })
  // 用执行面那一侧真正会用的写法：先编码，再自己落盘。
  // ★ 目录要自己建——这正是"两个模块各管一段"的代价，也是本用例在断言的事：
  //   `spoolFileFor()` 只**算路径**、不建目录（建目录是 `appendSpoolRecord` 的活）。
  //   谁忘了这一步，就会拿到一个 ENOENT，而那与"这次 Run 没调工具"完全不像。
  mkdirSync(join(root, 'toolcall-spool', 'run-encode'), { recursive: true })
  const line = encodeSpoolRecord(decisionRecord('call-e'))
  writeFileSync(file, line, 'utf8')
  const drained = drainToolCallSpool({ db, file })
  assert.equal(drained.complete, true)
  assert.equal(drained.applied.decision, 1)
  assert.equal(toolCallLogEvidence({ db }).recorded, true)
})

test('⑦d ★ `spoolFileFor()` 只算路径**不建目录**——建目录只发生在 append 里', () => {
  const p = spoolFileFor({ dataDir: root, runId: 'run-not-created' })
  assert.equal(existsSync(p), false, '算路径这件事本身不该有副作用')
  assert.equal(existsSync(join(root, 'toolcall-spool', 'run-not-created')), false)
  appendSpoolRecord({ file: p, record: decisionRecord('c-mk') })
  assert.equal(existsSync(p), true, 'append 才建目录')
})
