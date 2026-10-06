// packages/shared/test/node-protocol.test.mjs
// 远程 Agent 通道 S-C：协议契约。
//
// 覆盖的重点是**拒绝路径**，因为它们在真实链路上最难复现、也最容易悄悄失效：
// 版本不兼容、方向反了、缺 leaseEpoch、重复事件、序号倒退。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SEEN_WINDOW,
  FRAME_TYPES,
  LIMITS,
  MAX_FRAME_BYTES,
  NODE_PHASES,
  NODE_PATH,
  PROGRESS_KINDS,
  PROTOCOL_CODES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SEQ_OUTCOMES,
  TERMINAL_OUTCOMES,
  buildFrame,
  createSequenceTracker,
  directionOf,
  isFrameType,
  negotiateVersion,
  requestIdFor,
  validateFrame,
} from '../src/node-protocol.mjs'

const req = 'req-1'
const nodeId = 'node-abc'

/** 每个类型一个**最小合法**帧。覆盖性断言靠它，逐个手写用例会漏掉类型。 */
const VALID_FRAMES = Object.freeze({
  [FRAME_TYPES.HELLO]: { type: FRAME_TYPES.HELLO, protocolVersion: PROTOCOL_VERSION, nodeId },
  [FRAME_TYPES.HELLO_ACK]: { type: FRAME_TYPES.HELLO_ACK, requestId: req, protocolVersion: PROTOCOL_VERSION },
  [FRAME_TYPES.HEARTBEAT]: { type: FRAME_TYPES.HEARTBEAT, requestId: req, nodeId, leases: [{ attemptId: 'att-1', leaseEpoch: 3 }] },
  [FRAME_TYPES.HEARTBEAT_ACK]: { type: FRAME_TYPES.HEARTBEAT_ACK, requestId: req },
  [FRAME_TYPES.DISPATCH]: { type: FRAME_TYPES.DISPATCH, requestId: req, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1 },
  [FRAME_TYPES.ACK]: { type: FRAME_TYPES.ACK, requestId: req, nodeId, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, accepted: true },
  [FRAME_TYPES.PHASE]: { type: FRAME_TYPES.PHASE, requestId: req, nodeId, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, state: 'PreparingWorkspace' },
  [FRAME_TYPES.PROGRESS]: { type: FRAME_TYPES.PROGRESS, requestId: req, nodeId, eventId: 'ev-1', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, seq: 1, kind: 'step', summary: '正在读取项目文件' },
  [FRAME_TYPES.TRANSITION]: { type: FRAME_TYPES.TRANSITION, requestId: req, nodeId, eventId: 'ev-2', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, seq: 2, outcome: 'completed', artifacts: [{ path: 'src/a.mjs' }] },
  [FRAME_TYPES.FAILURE]: { type: FRAME_TYPES.FAILURE, requestId: req, nodeId, eventId: 'ev-3', taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, seq: 3, failureCode: 'tool-crash' },
  [FRAME_TYPES.RECONCILE]: { type: FRAME_TYPES.RECONCILE, requestId: req, nodeId, ledger: [{ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, state: 'Running' }] },
  [FRAME_TYPES.CANCEL]: { type: FRAME_TYPES.CANCEL, requestId: req, taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1 },
  [FRAME_TYPES.ERROR]: { type: FRAME_TYPES.ERROR, requestId: req, code: 'SOMETHING_WRONG' },
})

test('每个已登记的帧类型都有方向，且都有一个最小合法帧', () => {
  for (const type of Object.values(FRAME_TYPES)) {
    assert.ok(isFrameType(type), `未登记的类型：${type}`)
    assert.ok(['node', 'hub', 'both'].includes(directionOf(type)), `类型 ${type} 缺方向`)
    assert.ok(VALID_FRAMES[type], `类型 ${type} 缺最小合法帧样本`)
  }
  assert.equal(Object.keys(FRAME_TYPES).length, Object.keys(VALID_FRAMES).length)
})

test('协议常量与设计文档一致', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(PROTOCOL_NAME, 'legion-node-v1')
  assert.equal(NODE_PATH, '/node')
  // 终态名义必须逐字对齐 run-store 的 mapOutcomeToState 入参。
  assert.deepEqual([...TERMINAL_OUTCOMES], ['completed', 'failed', 'outcome_unknown', 'cancelled'])
})

// ── 版本协商 ────────────────────────────────────────────────────────────────

test('版本协商接受范围内的版本，拒绝范围外的版本并回双方范围', () => {
  assert.equal(negotiateVersion({ offered: 1 }).ok, true)
  const high = negotiateVersion({ offered: 2 })
  assert.equal(high.ok, false)
  assert.equal(high.code, PROTOCOL_CODES.VERSION_UNSUPPORTED)
  // ★ 只说"不支持"对面无从判断该升还是该降；必须回 Hub 接受的范围。
  assert.equal(high.hubMin, 1)
  assert.equal(high.hubMax, 1)
  assert.equal(high.offered, 2)
  // 非整数同样拒绝（不能靠比较运算"顺带"通过）。
  assert.equal(negotiateVersion({ offered: '1' }).ok, false)
  assert.equal(negotiateVersion({ offered: undefined }).ok, false)
  assert.equal(negotiateVersion({ offered: 1.5 }).ok, false)
})

// ── 帧校验 ──────────────────────────────────────────────────────────────────

test('每个类型的最小合法帧都能通过校验', () => {
  for (const [type, frame] of Object.entries(VALID_FRAMES)) {
    const r = validateFrame(frame)
    assert.equal(r.ok, true, `${type} 应通过校验，实际：${JSON.stringify(r)}`)
  }
})

test('帧接受 JSON 文本与已解析对象两种输入，并拒绝其它形态', () => {
  assert.equal(validateFrame(JSON.stringify(VALID_FRAMES[FRAME_TYPES.ERROR])).ok, true)
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.ERROR]).ok, true)
  assert.equal(validateFrame('{ not json').code, PROTOCOL_CODES.FRAME_NOT_OBJECT)
  assert.equal(validateFrame('[]').code, PROTOCOL_CODES.FRAME_NOT_OBJECT)
  assert.equal(validateFrame('null').code, PROTOCOL_CODES.FRAME_NOT_OBJECT)
  assert.equal(validateFrame('"text"').code, PROTOCOL_CODES.FRAME_NOT_OBJECT)
})

test('超长帧在解析前就被拒（不先 JSON.parse 一个 256KB 的串）', () => {
  const huge = JSON.stringify({ type: FRAME_TYPES.ERROR, requestId: req, code: 'X', padding: 'a'.repeat(MAX_FRAME_BYTES) })
  const r = validateFrame(huge)
  assert.equal(r.code, PROTOCOL_CODES.FRAME_TOO_LARGE)
})

test('未登记的帧类型具名拒绝，不静默忽略', () => {
  const r = validateFrame({ type: 'dispatch.v2', requestId: req, taskId: 'T', attemptId: 'A', leaseEpoch: 1 })
  assert.equal(r.code, PROTOCOL_CODES.UNKNOWN_TYPE)
  // 忽略未知类型会让"Node 报了但 Hub 什么也没记"看起来一切正常。
  assert.match(r.message, /dispatch\.v2/)
})

test('方向反了会被拒：Hub 不该收到 Hub 才发的帧', () => {
  // dispatch 是 Hub→Node；以 hub 角色校验应当被拒。
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.DISPATCH], { role: 'hub' }).code, PROTOCOL_CODES.WRONG_DIRECTION)
  // 同一条帧以 node 角色校验则通过（Node 端收到的正是它）。
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.DISPATCH], { role: 'node' }).ok, true)
  // 反过来：progress 是 Node→Hub。
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.PROGRESS], { role: 'node' }).code, PROTOCOL_CODES.WRONG_DIRECTION)
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.PROGRESS], { role: 'hub' }).ok, true)
})

test('已协商版本之后，版本不符的帧被拒', () => {
  const frame = { ...VALID_FRAMES[FRAME_TYPES.ERROR], v: 1 }
  assert.equal(validateFrame(frame, { version: 1 }).ok, true)
  assert.equal(validateFrame({ ...frame, v: 2 }, { version: 1 }).code, PROTOCOL_CODES.VERSION_UNSUPPORTED)
  assert.equal(validateFrame({ ...frame, v: undefined }, { version: 1 }).code, PROTOCOL_CODES.VERSION_UNSUPPORTED)
})

test('阶段上报只接受状态机里那几个名字', () => {
  assert.deepEqual([...NODE_PHASES], ['PreparingWorkspace', 'BuildingContext', 'Running'])
  // ★ 这些名字**逐字取自**状态机，不是另一套词汇。自创 `preparing` 会让
  //   状态机收到一条没有边可走的迁移，而拒绝发生在离原因很远的地方。
  for (const bad of ['preparing', 'Leased', 'Queued', 'Validating', 'completed', null, undefined]) {
    assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PHASE], state: bad }).code, PROTOCOL_CODES.UNKNOWN_PHASE, `state=${JSON.stringify(bad)} 应被拒`)
  }
  for (const good of NODE_PHASES) {
    assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PHASE], state: good }).ok, true)
  }
})

test('缺 leaseEpoch 的回报被拒 —— 这正是"迟到的旧回报"的入口', () => {
  for (const type of [FRAME_TYPES.PROGRESS, FRAME_TYPES.TRANSITION, FRAME_TYPES.FAILURE, FRAME_TYPES.ACK]) {
    const frame = { ...VALID_FRAMES[type] }
    delete frame.leaseEpoch
    const r = validateFrame(frame)
    assert.equal(r.ok, false, `${type} 缺 leaseEpoch 应被拒`)
    assert.equal(r.code, PROTOCOL_CODES.LEASE_EPOCH_MISSING)
  }
  // 非正整数的 leaseEpoch 同样拒绝（0 与负数都表示"没有租约"）。
  for (const bad of [0, -1, 1.5, '1']) {
    assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PROGRESS], leaseEpoch: bad }).ok, false, `leaseEpoch=${bad} 应被拒`)
  }
})

test('缺 requestId 的帧被拒（hello 除外）', () => {
  const frame = { ...VALID_FRAMES[FRAME_TYPES.ERROR] }
  delete frame.requestId
  assert.equal(validateFrame(frame).code, PROTOCOL_CODES.MISSING_FIELD)
  // hello 不带 requestId 也合法：它是连接的第一帧，关联对象还不存在。
  assert.equal(validateFrame(VALID_FRAMES[FRAME_TYPES.HELLO]).ok, true)
})

test('未知的终态名义与进展类别被具名拒绝', () => {
  const bad = validateFrame({ ...VALID_FRAMES[FRAME_TYPES.TRANSITION], outcome: 'succeeded' })
  assert.equal(bad.code, PROTOCOL_CODES.UNKNOWN_OUTCOME)
  // ★ `succeeded` 正是设计文档 §7.1 点名禁止的第二套状态名。
  assert.match(bad.message, /succeeded/)

  const badKind = validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PROGRESS], kind: 'thinking' })
  assert.equal(badKind.code, PROTOCOL_CODES.UNKNOWN_PROGRESS_KIND)
  assert.ok(PROGRESS_KINDS.includes('step'))
})

test('字段超长与条数超限被拒', () => {
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PROGRESS], summary: 'x'.repeat(4001) }).code, PROTOCOL_CODES.FIELD_TOO_LONG)
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PROGRESS], seq: 0 }).code, PROTOCOL_CODES.SEQ_INVALID)
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.PROGRESS], seq: 1.5 }).code, PROTOCOL_CODES.SEQ_INVALID)
  const many = { ...VALID_FRAMES[FRAME_TYPES.RECONCILE], ledger: Array.from({ length: 501 }, () => ({ taskId: 'T', attemptId: 'A', leaseEpoch: 1, state: 'Running' })) }
  assert.equal(validateFrame(many).code, PROTOCOL_CODES.TOO_MANY_ITEMS)
  // artifacts 元素必须带 path：只有摘要没有路径的"产物"在手机上没有可打开的东西。
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.TRANSITION], artifacts: [{ hash: 'abc' }] }).code, PROTOCOL_CODES.MISSING_FIELD)
})

test('ack 拒收必须给理由', () => {
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.ACK], accepted: false }).code, PROTOCOL_CODES.MISSING_FIELD)
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.ACK], accepted: false, reason: '缺少项目授权' }).ok, true)
  // accepted 必须是布尔，不能靠真值判断。
  assert.equal(validateFrame({ ...VALID_FRAMES[FRAME_TYPES.ACK], accepted: 'yes' }).code, PROTOCOL_CODES.INVALID_FIELD)
})

test('heartbeat 的 leases 元素逐个校验（不是只看数组长度）', () => {
  const bad = { ...VALID_FRAMES[FRAME_TYPES.HEARTBEAT], leases: [{ attemptId: 'att-1', leaseEpoch: 3 }, { attemptId: 'att-2' }] }
  assert.equal(validateFrame(bad).code, PROTOCOL_CODES.LEASE_EPOCH_MISSING)
})

// ── 序号与幂等 ──────────────────────────────────────────────────────────────

test('序号闸门：按序接受、重复 eventId 视为正常重复、不同事件撞击旧序号视为错误', () => {
  const tracker = createSequenceTracker()
  assert.deepEqual(tracker.observe({ eventId: 'e1', seq: 1 }), { ok: true, outcome: SEQ_OUTCOMES.ACCEPTED, seq: 1 })
  assert.deepEqual(tracker.observe({ eventId: 'e2', seq: 2 }), { ok: true, outcome: SEQ_OUTCOMES.ACCEPTED, seq: 2 })
  // 同一个 eventId 再来一次：网络重试的正常形态，**不是**错误。
  assert.deepEqual(tracker.observe({ eventId: 'e2', seq: 2 }), { ok: true, outcome: SEQ_OUTCOMES.DUPLICATE, seq: 2 })
  // 一个没见过的事件带着旧序号：这是"事件流里有无法排序的洞"，必须拒。
  const out = tracker.observe({ eventId: 'e3', seq: 2 })
  assert.equal(out.ok, false)
  assert.equal(out.code, PROTOCOL_CODES.SEQ_OUT_OF_ORDER)
  assert.equal(out.lastSeq, 2)
  assert.equal(tracker.lastSeq, 2, '被拒的事件不得推进游标')
})

test('序号闸门拒绝非法的 eventId 与 seq', () => {
  const tracker = createSequenceTracker()
  assert.equal(tracker.observe({ eventId: '', seq: 1 }).code, PROTOCOL_CODES.INVALID_FIELD)
  assert.equal(tracker.observe({ seq: 1 }).code, PROTOCOL_CODES.INVALID_FIELD)
  assert.equal(tracker.observe({ eventId: 'e', seq: 0 }).code, PROTOCOL_CODES.SEQ_INVALID)
  assert.equal(tracker.observe({ eventId: 'e', seq: '1' }).code, PROTOCOL_CODES.SEQ_INVALID)
  assert.equal(tracker.observe({ eventId: 'x'.repeat(129), seq: 1 }).code, PROTOCOL_CODES.FIELD_TOO_LONG)
})

test('序号闸门的记忆窗口有界，且窗口淘汰不破坏顺序判定', () => {
  const tracker = createSequenceTracker({ window: 2 })
  tracker.observe({ eventId: 'e1', seq: 1 })
  tracker.observe({ eventId: 'e2', seq: 2 })
  tracker.observe({ eventId: 'e3', seq: 3 })
  assert.equal(tracker.size, 2, '窗口应淘汰最老的 eventId')
  // ★ 被淘汰的 e1 再来时不再是 duplicate，但**仍然被拒**：它的 seq 已 <= lastSeq。
  //   这就是"窗口只影响报错还是静默忽略，不影响顺序正确性"。
  const replay = tracker.observe({ eventId: 'e1', seq: 1 })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, PROTOCOL_CODES.SEQ_OUT_OF_ORDER)
  assert.equal(tracker.lastSeq, 3)
})

test('序号闸门可从既有游标恢复（重连后继续用同一个号段）', () => {
  const tracker = createSequenceTracker({ lastSeq: 10 })
  assert.equal(tracker.observe({ eventId: 'e11', seq: 11 }).ok, true)
  assert.equal(tracker.observe({ eventId: 'e5', seq: 5 }).code, PROTOCOL_CODES.SEQ_OUT_OF_ORDER)
  assert.throws(() => createSequenceTracker({ lastSeq: -1 }), /lastSeq/)
  assert.equal(DEFAULT_SEEN_WINDOW, 1024)
})

// ── 构造帧 ──────────────────────────────────────────────────────────────────

test('buildFrame 补上版本、requestId 与时间戳', () => {
  const frame = buildFrame(FRAME_TYPES.HEARTBEAT, { requestId: 'r-1', nodeId }, { now: () => 1234 })
  assert.equal(frame.v, PROTOCOL_VERSION)
  assert.equal(frame.type, FRAME_TYPES.HEARTBEAT)
  assert.equal(frame.requestId, 'r-1')
  assert.equal(frame.sentAtMs, 1234)
  assert.equal(validateFrame(frame).ok, true)
})

test('buildFrame 拒绝未知类型与缺 requestId', () => {
  assert.throws(() => buildFrame('nope', { requestId: 'r' }), /未登记的帧类型/)
  assert.throws(() => buildFrame(FRAME_TYPES.ERROR, {}), /requestId/)
})

test('requestIdFor 可注入随机源', () => {
  assert.equal(requestIdFor('req', () => new Uint8Array(12).fill(0)), 'req-000000000000000000000000')
  assert.match(requestIdFor(), /^req-[0-9a-f]{24}$/)
})

// ── 任务简介（dispatch 的 brief） ────────────────────────────────────────────
//
// 在它之前，远端只拿到 `{id,title,status,version,role}`——而手机建任务时
// `title` 是**用户消息截断到 200 字**。也就是说电脑上真正干活那个程序能拿到的
// 全部信息就是那 200 字。

test('brief 可省略（老 Hub 不发它，不该因此判成非法帧）', () => {
  const base = { v: PROTOCOL_VERSION, type: FRAME_TYPES.DISPATCH, requestId: 'r', nodeId: 'n', taskId: 'T-1', attemptId: 'a-1', leaseEpoch: 1 }
  assert.equal(validateFrame(JSON.stringify(base), { role: 'node', version: PROTOCOL_VERSION }).ok, true)
})

test('brief 带上正文、验收标准、边界与优先级', () => {
  const frame = {
    v: PROTOCOL_VERSION, type: FRAME_TYPES.DISPATCH, requestId: 'r', nodeId: 'n',
    taskId: 'T-1', attemptId: 'a-1', leaseEpoch: 1,
    brief: { goal: '把登录页改一下', description: '正文', acceptance: ['能登录'], boundary: ['不改数据库'], priority: 'high' },
  }
  const r = validateFrame(JSON.stringify(frame), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(r.ok, true, r.message)
})

test('★ brief 分段有界：超长的那一段**具名**报出来，而不是整包被拒', () => {
  // 整包限长时，一段超长会把别的段一起挤掉，而"挤掉的是哪一段"取决于写入顺序
  // ——那是不可复现的。分段限长让"哪一段超了"是确定的。
  const mk = (brief) => JSON.stringify({
    v: PROTOCOL_VERSION, type: FRAME_TYPES.DISPATCH, requestId: 'r', nodeId: 'n',
    taskId: 'T-1', attemptId: 'a-1', leaseEpoch: 1, brief,
  })
  const tooLong = validateFrame(mk({ description: 'x'.repeat(LIMITS.briefText + 1) }), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, PROTOCOL_CODES.FIELD_TOO_LONG)
  assert.match(tooLong.message, /description/)

  const tooMany = validateFrame(mk({ acceptance: Array.from({ length: LIMITS.briefItems + 1 }, (_, i) => `a${i}`) }), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.code, PROTOCOL_CODES.TOO_MANY_ITEMS)
  assert.match(tooMany.message, /acceptance/)

  const bigItem = validateFrame(mk({ boundary: ['x'.repeat(LIMITS.briefItem + 1)] }), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(bigItem.ok, false)
  assert.match(bigItem.message, /boundary/)
})

test('brief 形状不对时报错，不静默丢弃', () => {
  const mk = (brief) => JSON.stringify({
    v: PROTOCOL_VERSION, type: FRAME_TYPES.DISPATCH, requestId: 'r', nodeId: 'n',
    taskId: 'T-1', attemptId: 'a-1', leaseEpoch: 1, brief,
  })
  const arr = validateFrame(mk([]), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(arr.ok, false)
  assert.match(arr.message, /brief 必须是对象/)
  const notArray = validateFrame(mk({ acceptance: '能登录' }), { role: 'node', version: PROTOCOL_VERSION })
  assert.equal(notArray.ok, false)
  assert.match(notArray.message, /acceptance 必须是数组/)
})
