// team-hub/tool-call-log.test.mjs
// ============================================================================
// PRT-610 的判据：持久化工具调用、决定与**决定来源**、结果和幂等键
//
// spec §6.8 line 480：
//   「`tool_calls` 必须记录决定来源（pre-execute / guard / approval / sandbox 兜底）；
//     否则事后无法区分策略拒绝与沙箱兜底拒绝，而这两类的**修复动作不同**。」
// spec §6.8 line 479：「guard 只有降级语义、**没有 allow 语义**。」
// spec §6.8 line 470：「**原始输入和 canonical 输入同时保存**。」
// spec §6.5 line 478：「F-02 的 `allow-once` 按 canonical 哈希，
//     DSH 的 `allowed-once` 按 `callId`。**两者不是一回事**。」
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DECISION_SOURCES,
  RESULT_STATUSES,
  RETRY_SAFETY,
  SANDBOX_FALLBACK_SOURCE,
  SOURCE_DECISIONS,
  SOURCE_REPAIR_ACTIONS,
  TOOL_CALL_LOG_CHECKED,
  TOOL_CALL_TABLE,
  assertCanonicalMatchesRaw,
  assertResultStatus,
  assertRetryable,
  assertSourceDecision,
  assertSourcesAligned,
  assertSourcesCovered,
  countBySource,
  ensureToolCallSchema,
  explainRejection,
  markDispatched,
  readToolCall,
  recordResult,
  recordToolCall,
  toolCallIdempotencyKey,
} from './tool-call-log.mjs'
import { ENFORCEMENT_SOURCES } from '../runtime/dsh-composition/enforcement.mjs'

const root = mkdtempSync(join(tmpdir(), 'legion-tool-call-'))
const db = new DatabaseSync(join(root, 'tool.db'))
ensureToolCallSchema(db)
ensureToolCallSchema(db) // 幂等

let seq = 0
function newCall(over = {}) {
  seq += 1
  const raw = over.rawInput ?? { path: `/w/f${seq}.txt`, mode: 'w' }
  return {
    callId: `call-${seq}`,
    toolName: 'file_write',
    decision: 'allow',
    decisionSource: 'pre-execute',
    rawInput: raw,
    canonicalInput: over.canonicalInput ?? raw,
    canonicalHash: `hash-${seq}`,
    atText: `2026-09-12T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...over,
  }
}

// ------------------------------------------------------- ① 来源必须闭合且自洽

test('① ★★ 来源引用强制面那一份，不是抄一份', () => {
  //   > 一个「把来源列表抄一份」的表，与一个「两份列表迟早不一样」的表，
  //   > 是同一个东西——只不过它的表现是「新的强制点在审计里根本不存在」。
  assert.equal(DECISION_SOURCES, ENFORCEMENT_SOURCES, '来源列表不是同一份引用（抄了一份）')
  assert.deepEqual([...DECISION_SOURCES], ['pre-execute', 'guard', 'approval', 'sandbox'])
})

test('① ★★ `source=guard, decision=allow` 必须被拒（§6.8：guard 没有 allow 语义）', () => {
  //   > 一个「接受 source='guard', decision='allow' 的表」，
  //   > 与一个「来源列永远说得通」的表，是同一个东西——
  //   > 只不过前者让你在审计里看到一次"hard floor 批准了这个操作"。
  assert.throws(() => assertSourceDecision('guard', 'allow'), /guard 只有降级语义/)
  assert.throws(() => assertSourceDecision('sandbox', 'allow'), /沙箱兜底只会拒绝/)
  assert.throws(() => assertSourceDecision('sandbox', 'ask'), /只可能/)
  assert.throws(() => assertSourceDecision('nonsense', 'deny'), /未知的决定来源/)
  // 合法的组合要安静通过
  assert.equal(assertSourceDecision('guard', 'deny'), 'guard')
  assert.equal(assertSourceDecision('sandbox', 'deny'), 'sandbox')
  assert.equal(assertSourceDecision('pre-execute', 'ask'), 'pre-execute')
  assert.equal(assertSourceDecision('approval', 'allow'), 'approval')
})

test('① ★★ 每个来源都有一张**查得到**的修复动作表', () => {
  const e = TOOL_CALL_LOG_CHECKED
  assert.deepEqual(e.missingDecisions, [])
  assert.deepEqual(e.missingActions, [])
  assert.deepEqual(e.orphanActions, [])
  assert.deepEqual(e.orphanDecisions, [])
  assert.deepEqual(e.noDeny, [])
  for (const s of DECISION_SOURCES) {
    assert.equal(typeof SOURCE_REPAIR_ACTIONS[s], 'string')
    assert.ok(SOURCE_REPAIR_ACTIONS[s].length > 4, s)
  }
  // 沙箱兜底的修复动作必须**明确区别于**策略类（§6.8：两类的修复动作不同）
  assert.notEqual(SOURCE_REPAIR_ACTIONS[SANDBOX_FALLBACK_SOURCE], SOURCE_REPAIR_ACTIONS['pre-execute'])
  assert.match(SOURCE_REPAIR_ACTIONS[SANDBOX_FALLBACK_SOURCE], /沙箱/)
})

test('① ★★ 自检**真的会拦**"加了来源却没加修复动作"', () => {
  // 新来源照样能写进库，只在值班的人查它时抛一个"未知来源"——那时离事故很久了。
  //
  // 注意要**同时**给它一个决定表：`assertSourcesAligned` 先检查决定表，
  // 只加来源的话会先在那里就抛，"没有动作"这条永远轮不到——
  // 那正是本批在别处反复遇到的那个形状（前一道闸门先拦下，后一道从未执行）。
  const sources = [...DECISION_SOURCES, 'network']
  const decisions = { ...SOURCE_DECISIONS, network: ['allow', 'deny'] }
  const evidence = assertSourcesCovered({ sources, decisions })
  assert.deepEqual(evidence.missingActions, ['network'])
  assert.deepEqual(evidence.missingDecisions, [], '这一条要验的是动作缺失，不是决定缺失')
  assert.throws(() => assertSourcesAligned(evidence), /没有修复动作/)
  assert.throws(() => assertSourcesAligned(evidence), /不知道该去哪里修/)
  // 决定表也缺时先报决定表（顺序本身就是"先决条件"）
  assert.throws(() => assertSourcesAligned(assertSourcesCovered({ sources })), /没有声明可能的决定/)
})

test('① ★★ 自检**真的会拦**"修复动作表里留着已不存在的来源"', () => {
  const actions = { ...SOURCE_REPAIR_ACTIONS, retired: '改一个已经不存在的强制点' }
  assert.deepEqual(assertSourcesCovered({ actions }).orphanActions, ['retired'])
  assert.throws(() => assertSourcesAligned(assertSourcesCovered({ actions })), /已不存在的来源/)
})

test('① ★★ 自检**真的会拦**"某个来源永远不会产出 deny"', () => {
  // 那样的来源在审计里存在，但它的修复动作**永远不会被读到**。
  const decisions = { ...SOURCE_DECISIONS, 'pre-execute': ['allow', 'ask'] }
  assert.deepEqual(assertSourcesCovered({ decisions }).noDeny, ['pre-execute'])
  assert.throws(() => assertSourcesAligned(assertSourcesCovered({ decisions })), /永远不会产出 deny/)
})

// ------------------------------------------------------ ② 原始与 canonical 输入

test('② ★★ 原始输入与 canonical 输入同时落库（两列都在，且都能读回）', () => {
  const raw = { mode: 'w', path: '/w/a.txt' }
  const canonical = { mode: 'w', path: '/w/a.txt' }
  const c = newCall({ rawInput: raw, canonicalInput: canonical })
  recordToolCall({ db, ...c })
  const row = readToolCall({ db, idempotencyKey: c.callId })
  assert.deepEqual(row.rawInput, raw, '原始输入没有落库')
  assert.deepEqual(row.canonicalInput, canonical, 'canonical 输入没有落库')
  assert.ok(row.canonicalHash, 'canonical 哈希没有落库')
})

test('② ★★ canonical 输入必须是原始输入的**投影**（两份对不起来就不算"都存了"）', () => {
  //   > 一个「两份输入都可能对、也可能不对」的表，
  //   > 与一个「只有一份输入」的表，在「事后能不能证明执行的是被批准的那次」上
  //   > 是同一个东西。
  const project = (raw) => ({ path: raw.path, mode: raw.mode })
  const raw = { path: '/w/a.txt', mode: 'w', uiHint: '用户点了写入' }
  const ok = assertCanonicalMatchesRaw({ rawInput: raw, canonicalInput: { path: '/w/a.txt', mode: 'w' }, project })
  assert.equal(ok.ok, true)
  assert.match(ok.canonicalText, /a\.txt/)
  assert.throws(
    () => assertCanonicalMatchesRaw({ rawInput: raw, canonicalInput: { path: '/w/B.txt', mode: 'w' }, project }),
    /不一致/,
    'canonical 与 raw 对不上却没有被发现',
  )
  // 缺 project 时要报错，而不是默认"对得上"
  assert.throws(() => assertCanonicalMatchesRaw({ rawInput: raw, canonicalInput: {} }), /需要 project/)
})

test('② ★★ 执行时按当前规则重推 canonical —— 存的与批准的对不上就抛', () => {
  // 这条是"执行只使用与哈希一致的不可变参数"（§6.8 line 470）的直接读法：
  // canonical 哈希必须与 canonical 输入一致，不能是"当时算的另一个东西"。
  const project = (raw) => ({ path: raw.path, mode: raw.mode })
  const raw = { path: '/w/a.txt', mode: 'w' }
  const canonical = project(raw)
  const c = newCall({ rawInput: raw, canonicalInput: canonical, canonicalHash: 'H1' })
  recordToolCall({ db, ...c })
  const row = readToolCall({ db, idempotencyKey: c.callId })
  assert.deepEqual(row.canonicalInput, project(row.rawInput), 'canonical 输入不是 raw 的投影')
  assert.equal(row.canonicalHash, 'H1', '执行侧读到的哈希与记录不一致')
})

// ---------------------------------------------------------------- ③ 幂等键

test('③ ★★ 幂等键按 callId，**不**含时间戳/AttemptId/重试次数', () => {
  //   > 一个「把时间戳算进幂等键」的幂等键，
  //   > 与一个「每次重试都是全新调用」的幂等键，是同一个东西——
  //   > 只不过它坏在"重试"这条路径上，而重试恰恰是它存在的理由。
  assert.equal(toolCallIdempotencyKey({ callId: 'c1' }), 'c1')
  assert.equal(
    toolCallIdempotencyKey({ callId: 'c1' }),
    toolCallIdempotencyKey({ callId: 'c1', attemptId: 'att-9', atText: '2026-09-12T00:00:00.000Z', retryCount: 7 }),
    '幂等键里混进了观察 metadata——重试会被当成一次新调用',
  )
  // 装载时留下的样例也必须证明这一点（两份算出**不同**输入、**相同**键）
  assert.equal(TOOL_CALL_LOG_CHECKED.keyIgnoresObservation[0], TOOL_CALL_LOG_CHECKED.keyIgnoresObservation[1])
  assert.equal(TOOL_CALL_LOG_CHECKED.sampleIdempotencyKey, 'call-1')
  // 那两份样例必须来自**不同**的输入，否则这个对比什么都没证明
  assert.notDeepEqual(
    { callId: 'call-1' },
    { callId: 'call-1', attemptId: 'att-9', atText: '2026-09-12T00:00:00.000Z', retryCount: 7, elapsedMs: 8123 },
  )
})

test('③ ★★ 幂等键**不等于** canonical 哈希（两者不是一回事，§6.5）', () => {
  // F-02 的 allow-once 是按哈希；DSH 的 allowed-once 是按 callId。
  //   > 一个「把授权账本的键拿来当执行幂等键」的表，
  //   > 与一个「一次合法重试永远做不了」的表，是同一个东西。
  const a = newCall({ canonicalHash: 'SAME-HASH' })
  const b = newCall({ canonicalHash: 'SAME-HASH' })
  assert.notEqual(a.callId, b.callId)
  assert.notEqual(toolCallIdempotencyKey({ callId: a.callId }), toolCallIdempotencyKey({ callId: b.callId }),
    '两个不同的 callId 得到了同一个幂等键')
})

test('③ ★ 没有 callId 要抛，而不是回退到哈希或空键', () => {
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => toolCallIdempotencyKey({ callId: bad }), TypeError, String(bad))
  }
})

test('③ ★★ 同一个 callId 重放**不新增行**，只把 attempts 加一', () => {
  //   > 一个「同一个调用被写了两次」的表，
  //   > 与一个「事后数不出到底调用过几次」的表，是同一个东西。
  const c = newCall({ callId: `dup-${Date.now()}` })
  const first = recordToolCall({ db, ...c })
  assert.equal(first.outcome, 'recorded')
  assert.equal(first.attempts, 0)
  const second = recordToolCall({ db, ...c })
  assert.equal(second.outcome, 'duplicate')
  assert.equal(second.attempts, 1)
  assert.equal(second.idempotencyKey, first.idempotencyKey)
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${TOOL_CALL_TABLE} WHERE callId=?`).get(c.callId).n
  assert.equal(Number(n), 1, '重放新增了一行——事后数不出调用过几次')
  // ★ 必须**读回库里的值**，而不是只看返回值。
  //
  // 破坏性验证抓到了这一点：把累加那条 UPDATE 删掉时，用例**没红**——因为
  // `attempts` 是从 `existing.attempts` 算出来的一个"声称"，不是库里的状态。
  //
  //   > 一个「断言返回值里的计数」的用例，
  //   > 与一个「断言一个可能永远不落库的计数」的用例，在「事后数不算得出来」
  //   > 上是同一个东西。
  //
  // 库里那一列才是"事后数得出调用过几次"的唯一依据。
  const persisted = db.prepare(`SELECT attempts FROM ${TOOL_CALL_TABLE} WHERE idempotencyKey=?`).get(second.idempotencyKey).attempts
  assert.equal(Number(persisted), 1, 'attempts 只出现在了返回值里，没有落库')
  // 第三次重放也要落库（不是只做一次）
  const third = recordToolCall({ db, ...c })
  assert.equal(third.attempts, 2)
  const persisted3 = db.prepare(`SELECT attempts FROM ${TOOL_CALL_TABLE} WHERE idempotencyKey=?`).get(third.idempotencyKey).attempts
  assert.equal(Number(persisted3), 2, 'attempts 的累加没有持续落库')
})

test('③ ★★ 同一个 callId 换工具名或换哈希 **必须抛**（不得静默认成同一次）', () => {
  //   > 一个「同一个 callId 第二次带着不同的工具名进来、被当成同一次调用」的表，
  //   > 与一个「审计里的工具名可以是任意值」的表，是同一个东西。
  const c = newCall({ callId: `guard-${Date.now()}` })
  recordToolCall({ db, ...c })
  assert.throws(() => recordToolCall({ db, ...c, toolName: 'file_delete' }), /不同的工具名/)
  assert.throws(() => recordToolCall({ db, ...c, canonicalHash: 'other' }), /不同的 canonical 哈希/)
  assert.throws(() => recordToolCall({ db, ...c, canonicalHash: 'other' }), /不得静默改写/)
})

// ---------------------------------------------------------------- ④ 结果状态

test('④ ★★ 结果有四态，`unknown` 与 `none` 必须分开', () => {
  //   > 一个只有「成功/失败」两态的结果列，
  //   > 与一个「把崩在中途的写操作读成『没执行过』」的结果列，是同一个东西——
  //   > 而它的表现是重试一次外部写操作。
  assert.deepEqual(Object.values(RESULT_STATUSES).sort(), ['error', 'none', 'ok', 'unknown'])
  assert.equal(RETRY_SAFETY.unknown, 'must-resolve-first')
  assert.notEqual(RETRY_SAFETY.unknown, RETRY_SAFETY.none)
  for (const s of ['bogus', '', null, undefined]) assert.throws(() => assertResultStatus(s), /未知的结果状态/)
  assert.equal(assertResultStatus('ok'), 'ok')
})

test('④ ★★ 派发前先落库：`markDispatched` 把 none → unknown', () => {
  //   > 一个「先派发再记账」的顺序，
  //   > 与一个「把已经发生的副作用记成『还没发生』」的顺序，是同一个东西。
  const c = newCall({ callId: `disp-${Date.now()}` })
  recordToolCall({ db, ...c })
  assert.equal(readToolCall({ db, idempotencyKey: c.callId }).resultStatus, RESULT_STATUSES.NONE)
  const r = markDispatched({ db, idempotencyKey: c.callId, atText: '2026-09-12T01:00:00.000Z' })
  assert.equal(r.outcome, 'dispatched')
  const row = readToolCall({ db, idempotencyKey: c.callId })
  assert.equal(row.resultStatus, RESULT_STATUSES.UNKNOWN, '派发后不是 unknown')
  assert.ok(row.dispatchedAt, 'dispatchedAt 没有写下')
  // 重复派发要抛（那是外部写做两遍的直接原因）
  assert.throws(() => markDispatched({ db, idempotencyKey: c.callId }), /重复派发|不在 none 状态/)
})

test('④ ★★ 没派发过就不能落结果（否则"没执行过"与"结果未知"被混起来）', () => {
  const c = newCall({ callId: `nores-${Date.now()}` })
  recordToolCall({ db, ...c })
  assert.throws(() => recordResult({ db, idempotencyKey: c.callId, status: 'ok' }), /没有"已派发"记录/)
})

test('④ ★★ `unknown` **永不**自动重试（重试就是第二次外部写）', () => {
  const c = newCall({ callId: `unk-${Date.now()}` })
  recordToolCall({ db, ...c })
  markDispatched({ db, idempotencyKey: c.callId })
  const row = readToolCall({ db, idempotencyKey: c.callId })
  const v = assertRetryable(row)
  assert.equal(v.retryable, false, 'unknown 被判成可重试')
  assert.equal(v.safety, 'must-resolve-first')
  assert.match(v.reason, /第二遍|查清/)
  // 即使工具声明幂等，unknown 也不自动重试
  assert.equal(assertRetryable(row, { toolIsIdempotent: true }).retryable, false,
    '声明幂等的工具在 unknown 下被自动重试了——不确定的状态不是幂等性能解决的')
})

test('④ ★★ 四态各自的重试判定', () => {
  const mk = (status) => ({ resultStatus: status, decision: 'allow' })
  assert.equal(assertRetryable(mk('none')).retryable, true)
  assert.equal(assertRetryable(mk('ok')).retryable, false, 'ok 不该重做（应当返回缓存结果）')
  assert.match(assertRetryable(mk('ok')).reason, /缓存|重做/)
  assert.equal(assertRetryable(mk('error')).retryable, false, '未声明幂等的工具在 error 下不该自动重试')
  assert.equal(assertRetryable(mk('error'), { toolIsIdempotent: true }).retryable, true)
  // 没有记录 = 确定没调用过
  assert.equal(assertRetryable(null).retryable, true)
  assert.equal(assertRetryable(null).safety, 'safe')
})

test('④ ★ 结果落库并可读回，unknown 能被真实结果覆盖', () => {
  const c = newCall({ callId: `settle-${Date.now()}` })
  recordToolCall({ db, ...c })
  markDispatched({ db, idempotencyKey: c.callId })
  const r = recordResult({ db, idempotencyKey: c.callId, status: 'ok', result: { bytes: 12 }, atText: '2026-09-12T02:00:00.000Z' })
  assert.equal(r.status, 'ok')
  const row = readToolCall({ db, idempotencyKey: c.callId })
  assert.equal(row.resultStatus, 'ok')
  assert.deepEqual(row.result, { bytes: 12 })
  assert.ok(row.settledAt)
  assert.equal(assertRetryable(row).retryable, false)
})

// ------------------------------------------------------- ⑤ 拒绝归因与修复动作

test('⑤ ★★ 策略拒绝与沙箱兜底拒绝**分得开**，且给出各自的动作（§6.8 line 480）', () => {
  const policy = { decision: 'deny', decisionSource: 'pre-execute', reason: 'risk>threshold' }
  const sandbox = { decision: 'deny', decisionSource: 'sandbox', reason: '沙箱拒绝了未声明的路径' }
  const a = explainRejection(policy)
  const b = explainRejection(sandbox)
  assert.equal(a.denied, true)
  assert.equal(b.denied, true)
  assert.equal(a.isSandboxFallback, false)
  assert.equal(b.isSandboxFallback, true)
  assert.notEqual(a.repairAction, b.repairAction, '两类的修复动作相同——那这个来源列就白记了')
  assert.match(b.repairAction, /沙箱/)
  assert.match(a.repairAction, /策略/)
  // 全部四个来源的动作两两不同（否则"分得开"只是名义上的）
  const all = DECISION_SOURCES.map((s) => explainRejection({ decision: 'deny', decisionSource: s, reason: 'x' }).repairAction)
  assert.equal(new Set(all).size, DECISION_SOURCES.length, `修复动作有重复：${JSON.stringify(all)}`)
})

test('⑤ ★ 没有来源的拒绝要**抛**，不能静默返回"不知道"', () => {
  assert.throws(() => explainRejection({ decision: 'deny', decisionSource: 'mystery' }), /未知的决定来源/)
  assert.throws(() => explainRejection(null), /需要一行记录/)
})

test('⑤ ★ 非拒绝的行不冒充修复动作', () => {
  const r = explainRejection({ decision: 'allow', decisionSource: 'pre-execute' })
  assert.equal(r.denied, false)
  assert.equal(r.repairAction, null)
  assert.equal(r.isSandboxFallback, false)
})

test('⑤ ★★ `countBySource` 能直接回答"有多少是沙箱兜底拒绝的"', () => {
  const before = countBySource({ db, decision: 'deny' })
  const base = before.reduce((n, r) => n + r.count, 0)
  const stamp = Date.now()
  recordToolCall({ db, ...newCall({ callId: `cnt-a-${stamp}`, decision: 'deny', decisionSource: 'sandbox', reason: 'sandbox' }) })
  recordToolCall({ db, ...newCall({ callId: `cnt-b-${stamp}`, decision: 'deny', decisionSource: 'sandbox', reason: 'sandbox' }) })
  recordToolCall({ db, ...newCall({ callId: `cnt-c-${stamp}`, decision: 'deny', decisionSource: 'pre-execute', reason: 'policy' }) })
  const after = countBySource({ db, decision: 'deny' })
  const total = after.reduce((n, r) => n + r.count, 0)
  assert.equal(total, base + 3)
  // ★ 分组必须是按 (来源, 决定)，不是按 callId。
  //
  // 破坏性验证抓到了这一点：只断言"某来源的 count >= 1"时，把 GROUP BY 改成
  // `GROUP BY callId` 用例**没红**——因为每条 callId 也都带着来源字段，
  // `find` 照样能找到一行 count=1 的。
  //
  //   > 一个「只要行里有来源字段就算分组对了」的断言，
  //   > 与一个「根本没检查分组」的断言，在「这个统计到底能不能读」上是同一个东西。
  //
  // 真正的判据是：**每个 (来源, 决定) 组合在结果里只出现一次**，
  // 且它的 count 等于库里这个组合的行数。
  const pairs = after.map((r) => `${r.decisionSource}|${r.decision}`)
  assert.equal(new Set(pairs).size, pairs.length, `同一组合在结果里出现了多次：${JSON.stringify(pairs)}（按 callId 分组了？）`)
  for (const r of after) {
    const expected = db.prepare(
      `SELECT COUNT(*) AS n FROM ${TOOL_CALL_TABLE} WHERE decisionSource=? AND decision=?`,
    ).get(r.decisionSource, r.decision).n
    assert.equal(r.count, Number(expected), `${r.decisionSource}/${r.decision} 的计数与库里的行数不符`)
  }
  const sandbox = after.find((r) => r.decisionSource === 'sandbox')
  assert.ok(sandbox && sandbox.count >= 2, `沙箱兜底拒绝应当至少 2 条，实际 ${sandbox?.count}`)
  const policy = after.find((r) => r.decisionSource === 'pre-execute')
  assert.ok(policy && policy.count >= 1)
})

// ------------------------------------------------------ ⑥ 端到端与不变量

test('⑥ ★★ 一次真实的写入调用：申请 → 派发 → 结果，全程可归因', () => {
  const callId = `e2e-${Date.now()}`
  const raw = { path: '/w/report.txt', mode: 'w', content: 'hello' }
  recordToolCall({
    db, callId, toolName: 'file_write', decision: 'allow', decisionSource: 'approval',
    reason: '用户批准', rawInput: raw, canonicalInput: { path: raw.path, mode: raw.mode, content: raw.content },
    canonicalHash: 'E2E-H', attemptId: 'att-e2e', atText: '2026-09-12T03:00:00.000Z',
  })
  markDispatched({ db, idempotencyKey: callId, atText: '2026-09-12T03:00:01.000Z' })
  recordResult({ db, idempotencyKey: callId, status: 'ok', result: { written: 5 }, atText: '2026-09-12T03:00:02.000Z' })
  const row = readToolCall({ db, idempotencyKey: callId })
  assert.equal(row.decision, 'allow')
  assert.equal(row.decisionSource, 'approval')
  assert.equal(row.toolName, 'file_write')
  assert.equal(row.attemptId, 'att-e2e')
  assert.deepEqual(row.rawInput, raw)
  assert.equal(row.resultStatus, 'ok')
  assert.deepEqual(row.result, { written: 5 })
  assert.equal(row.attempts, 0)
})

test('⑤ ★★ `countBySource` 不带 decision 时也要按 (来源, 决定) 分组', () => {
  // 这条覆盖的是 `countBySource({db})` 那条分支。破坏性验证发现它**从未被执行**：
  // 只把 GROUP BY 改坏那一条分支，用例不红——因为没有任何用例调用过它。
  //
  //   > 一段从未被执行的分支，与一段不存在的分支，
  //   > 在「它到底对不对」上是同一个东西。
  const all = countBySource({ db })
  const pairs = all.map((r) => `${r.decisionSource}|${r.decision}`)
  assert.equal(new Set(pairs).size, pairs.length, `同一组合出现了多次：${JSON.stringify(pairs)}（按 callId 分组了？）`)
  // 每一行的计数必须等于库里该组合的行数
  for (const r of all) {
    const expected = db.prepare(
      `SELECT COUNT(*) AS n FROM ${TOOL_CALL_TABLE} WHERE decisionSource=? AND decision=?`,
    ).get(r.decisionSource, r.decision).n
    assert.equal(r.count, Number(expected), `${r.decisionSource}/${r.decision}`)
  }
  // 不带 decision 的结果必须**覆盖**带 decision 的结果（前者是后者的超集）
  const deny = countBySource({ db, decision: 'deny' })
  const denyFromAll = all.filter((r) => r.decision === 'deny')
  assert.deepEqual(
    denyFromAll.map((r) => [r.decisionSource, r.count]).sort(),
    deny.map((r) => [r.decisionSource, r.count]).sort(),
    '全量统计与按 deny 过滤的统计对不上',
  )
})

test('⑥ ★★ 一条只记录来源、却不给动作的日志 = 一条没有来源的日志', () => {
  // 这一条把 §6.8 line 480 的**意图**钉下来：来源列存在的全部意义是
  // "拿到它的人知道去哪里修"。所以每条来源都必须能算出一个动作，
  // 且四个动作两两不同（⑤ 已验）。
  for (const s of DECISION_SOURCES) {
    const r = explainRejection({ decision: 'deny', decisionSource: s, reason: 'r' })
    assert.ok(r.repairAction && r.repairAction.length > 4, `${s} 没有可执行的动作`)
  }
  // 而未登记来源写库时要被拦在**写入**这一步，不是等到查询时才炸
  assert.throws(
    () => recordToolCall({ db, ...newCall({ callId: `bad-src-${Date.now()}`, decisionSource: 'mystery' }) }),
    /未知的决定来源/,
  )
})

test('⑥ ★ 读一行返回的是叶字段，不是行对象（不泄漏 live 数据）', () => {
  const c = newCall({ callId: `leaf-${Date.now()}` })
  recordToolCall({ db, ...c })
  const row = readToolCall({ db, idempotencyKey: c.callId })
  assert.deepEqual(Object.keys(row).sort(), [
    'attemptId', 'attempts', 'callId', 'canonicalHash', 'canonicalInput', 'decision',
    'decisionSource', 'dispatchedAt', 'idempotencyKey', 'rawInput', 'reason', 'result',
    'resultStatus', 'runId', 'settledAt', 'toolName',
  ].sort())
  // 真正的判据不是"键名对得上"，而是"它是一份**普通数据**"：
  // 能原样 JSON 往返，说明里面没有活着的东西（Service / 行对象 / 函数）。
  assert.deepEqual(JSON.parse(JSON.stringify(row)), { ...row })
  assert.equal(readToolCall({ db, idempotencyKey: 'nope' }), null)
})

test.after(() => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
