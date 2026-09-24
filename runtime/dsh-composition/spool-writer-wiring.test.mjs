// runtime/dsh-composition/spool-writer-wiring.test.mjs
//
// ★★ 按 Run 的账：**从身份载荷到车道文件**的那条生产路径。
//
// 前面的用例各自钉住一段：`spool-writer.test.mjs` 钉住宿主的行为，
// `run-identity.test.mjs` 钉住身份按 Run 覆盖，`tool-request.mjs` 的用例钉住投影。
// 这一份钉的是**它们接起来之后**的那件事 —— 而且用的是**真的**桥、**真的**身份安装、
// 与组合根（`root-row.mjs`）**逐字相同**的三个注入点。
//
//   > 一段一段都是绿的、而接起来不产账，正是这个仓库反复量到的那种缺口
//   > （第 113 轮的 23 个 `gap` 模块全都是"写好了、没人调"）。
//
// ★ 这里**不**复制 `root-row.mjs` 的那三行注入逻辑就完事：下面 `writerWiredTo()`
//   逐字复写它们，并在测试里断言"注入点用的是**按事件取 Run**"——
//   否则这份用例会在有人把注入改成装配期绑死时**继续绿**。
//
// ★★ 第 118 轮第十七轮起，`onDecision` 那一个注入点**不再各写一份**：
//   生产与这里都调 `createSpoolObserver()`（住在写入侧那一侧）。
//   理由同上——包装写两份，两条接线总有一天不是同一条。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RUN_IDENTITY_STATES,
  RUN_IDENTITY_WIRE_VERSION,
} from '../contracts/run-identity.mjs'
import {
  createRunIdentityInstallation,
  identityOverlayForExecution,
  installRunIdentityIntoAgent,
} from './run-identity.mjs'
import { createEnforcementBridge, toolCallRowOf } from './tool-request.mjs'
import { DECISION_KINDS } from '../connectors/decision-port.mjs'
import {
  TOOLCALL_SPOOL_WRITER_CODES,
  createSpoolObserver,
  createToolCallSpoolWriter,
} from '../toolcall/spool-writer.mjs'
import {
  TOOLCALL_SPOOL_KINDS,
  appendSpoolRecord,
  readSpoolRecords,
  spoolFileFor,
} from '../toolcall/spool.mjs'

/** 进程级上下文——**故意**与每一次 Run 的覆盖都不同（否则"没覆盖"也会看起来对）。 */
const PROC_CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})

const fakeAgent = (id) => ({ id })

const execOf = (agent, callId) => ({
  name: 'write-file', callId, arguments: { path: 'C:/work/a.txt', mode: 'w' }, agent,
})

/** 与 `root-row.mjs` 里那三行**逐字相同**的接线（组合根只做这三件事）。 */
function writerWiredTo(dataDir) {
  return createToolCallSpoolWriter({
    dataDir,
    runIdOf: (event) => identityOverlayForExecution(event?.execution)?.runId ?? null,
    rowOf: (event, runId) => toolCallRowOf(event.projection, {
      decision: event.decision?.kind,
      decisionSource: (typeof event.source === 'string' && event.source.trim() !== '')
        ? event.source
        : 'pre-execute',
      reason: event.decision?.reason ?? event.reason ?? null,
      runId,
    }),
  })
}

/** 一个装好**按 Run**身份（含 `runId`）的 Agent。 */
function agentWithRun(runId, { scope = 'gf001' } = {}) {
  const agent = fakeAgent(`agent-${runId}`)
  installRunIdentityIntoAgent({
    agent,
    installation: createRunIdentityInstallation({
      state: RUN_IDENTITY_STATES.INSTALLED,
      identity: { version: RUN_IDENTITY_WIRE_VERSION, scope, taskId: 'task-7', cwd: 'C:/work', runId },
    }),
  })
  return agent
}

/** 真桥 + 真身份 + 组合根那三行注入。 */
function bridgeFor(dataDir, { decide = () => ({ kind: 'allow' }) } = {}) {
  const writer = writerWiredTo(dataDir)
  const bridge = createEnforcementBridge({
    context: PROC_CTX,
    decide,
    // ★ 与 `root-row.mjs:815` 逐字同一条：**放行时**多记一条 `dispatched`。
    onDecision: createSpoolObserver(writer, { allowKind: DECISION_KINDS.ALLOW }),
  })
  return { bridge, writer }
}

/**
 * 走一遍桥。
 *
 * ★ 实测过（`.probe-bridge-notify.mjs` 那次探测）：**`preExecute` 自己就会发那条通知**，
 *   而且它带的键是 `canonicalHash, decision, elapsedMs, execution, projection, reason, source`
 *   ——**带投影**。所以生产路径上"一次工具决定"正好对应一条通知，
 *   不需要谁额外再调一次（`onDecision` 不是桥面上的一个成员，它是这一条内部通知钩子）。
 */
async function driveOnce(bridge, exec) {
  return bridge.preExecute(exec).then((decision) => decision)
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'legion-spool-wiring-'))
}

test('① ★★★ 生产路径：真桥 + 真身份 + 组合根那三行 ⇒ 决定落进**这个 Run** 的车道文件', async () => {
  const dir = tempDir()
  try {
    const { bridge, writer } = bridgeFor(dir)
    const agent = agentWithRun('run-42')
    await driveOnce(bridge, execOf(agent, 'e2e-1'))

    // ★★ 第 118 轮第十七轮：一条 `allow` 决定现在产**两条**记录
    //   （`decision` + `dispatched`）——这一行跟着生产接线走。
    assert.equal(writer.reading().written, 2, '决定与派发两条都该进车道')
    assert.deepEqual(writer.reading().lastRefusal, null)
    const file = spoolFileFor({ dataDir: dir, runId: 'run-42' })
    assert.equal(writer.fileOf('run-42'), file)
    const rows = readSpoolRecords({ file }).records
    assert.deepEqual(rows.map((r) => r.kind), ['decision', 'dispatched'],
      '顺序是契约：收账侧先建行（decision）再推状态（dispatched）')
    assert.equal(rows[0].row.runId, 'run-42', 'Run 号没有从身份覆盖里取到')
    assert.equal(rows[0].row.decision, 'allow')
    assert.equal(rows[0].row.decisionSource, 'pre-execute')
    assert.equal(rows[0].row.callId, 'e2e-1')
    assert.equal(rows[0].row.toolName, 'write-file')
    assert.ok(rows[0].row.canonicalHash, '行里没有授权哈希（`toolCallRowOf` 的必填项）')
    // 派发行指向**同一次调用**（收账侧靠 `callId` 算幂等键找到那一行）
    assert.equal(rows[1].row.callId, 'e2e-1')
    assert.equal(rows[1].row.runId, 'run-42')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('①b ★★★ 被 `deny` 的调用**没有派发行**（真桥路径上的"并不存在的派发"）', async () => {
  const dir = tempDir()
  try {
    const { bridge, writer } = bridgeFor(dir, { decide: () => ({ kind: 'deny', reason: '越界' }) })
    const agent = agentWithRun('run-deny')
    const decision = await driveOnce(bridge, execOf(agent, 'deny-1'))
    assert.equal(decision.kind, 'deny', '判定自己必须照常拒绝')

    const rows = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-deny' }) }).records
    assert.deepEqual(rows.map((r) => r.kind), ['decision'])
    assert.equal(rows[0].row.decision, 'deny')
    assert.equal(writer.reading().written, 1)
    // ★ 反向对照：同一条路径上 `allow` **必须**多出那一条 ——
    //   否则上面那条断言在一个"永远不写派发"的实现下也会绿。
    const ok = bridgeFor(dir)
    await driveOnce(ok.bridge, execOf(agentWithRun('run-allow'), 'allow-1'))
    assert.deepEqual(
      readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-allow' }) }).records.map((r) => r.kind),
      ['decision', 'dispatched'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('② ★★★ 一个进程里两个 Run：各写各的账（§14.5 那处设计的**验收点**）', async () => {
  const dir = tempDir()
  try {
    const { bridge, writer } = bridgeFor(dir)
    const a = agentWithRun('run-a', { scope: 'gf001' })
    const b = agentWithRun('run-b', { scope: 'ozon' })
    await driveOnce(bridge, execOf(a, 'call-a'))
    await driveOnce(bridge, execOf(b, 'call-b'))

    assert.equal(writer.reading().written, 4, '两个 Run 各两条（decision + dispatched）')
    const rowsA = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-a' }) }).records
    const rowsB = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-b' }) }).records
    assert.equal(rowsA.length, 2, 'run-a 的账不对')
    assert.equal(rowsB.length, 2, 'run-b 的账不对')
    assert.equal(rowsA[0].row.callId, 'call-a')
    assert.equal(rowsB[0].row.callId, 'call-b')
    // ★ 两个 Run 的空间不同，而**账没有合流**：这一条就是"装配期绑死 Run"会红的地方。
    assert.notEqual(rowsA[0].row.runId, rowsB[0].row.runId)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ ★ 身份里没有 `runId`（老载荷）：判定照常，而车道**一条不写**且具名', async () => {
  const dir = tempDir()
  try {
    const seen = []
    const writer = writerWiredTo(dir)
    const bridge = createEnforcementBridge({
      context: PROC_CTX,
      decide: (p) => { seen.push(p.subject.scope); return { kind: 'allow' } },
      onDecision: writer.observeDecision,
    })
    const agent = fakeAgent('legacy')
    installRunIdentityIntoAgent({
      agent,
      installation: createRunIdentityInstallation({
        state: RUN_IDENTITY_STATES.INSTALLED,
        // 老载荷：有 scope / taskId / cwd，**没有** runId
        identity: { version: RUN_IDENTITY_WIRE_VERSION, scope: 'gf001', taskId: 'task-7', cwd: 'C:/work' },
      }),
    })
    await driveOnce(bridge, execOf(agent, 'legacy-1'))

    // ★ 判定**不受影响**（这是"观察点不许改判定"在真实路径上的样子）
    assert.deepEqual(seen, ['gf001'])
    // ★ 而账**没写**，且理由是具名的——不回落成"进程级那一本"
    assert.equal(writer.reading().written, 0)
    assert.equal(writer.reading().lastRefusal.code, TOOLCALL_SPOOL_WRITER_CODES.NO_RUN_ID)
    assert.equal(readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'gf001' }) }).present, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ 记的是**已作出的**决定：`deny` 也照记（审计要的是决定，不是放行）', async () => {
  const dir = tempDir()
  try {
    const { bridge, writer } = bridgeFor(dir, { decide: () => ({ kind: 'deny', reason: '没批准' }) })
    const agent = agentWithRun('run-deny')
    const decision = await driveOnce(bridge, execOf(agent, 'deny-1'))
    assert.equal(decision.kind, 'deny')
    const rows = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-deny' }) }).records
    assert.equal(rows.length, 1)
    assert.equal(rows[0].row.decision, 'deny')
    assert.equal(rows[0].row.reason, '没批准')
    assert.equal(writer.reading().written, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ ★ 组合根的注入点真的是**按事件取 Run**（防"改回装配期绑死"后本套仍然绿）', () => {
  const dir = tempDir()
  try {
    const writer = writerWiredTo(dir)
    const a = agentWithRun('run-1')
    const b = agentWithRun('run-2')
    // 同一个 writer、两个不同事件 ⇒ 两个不同文件。装配期绑死的实现只会有一个文件。
    const f1 = writer.observeDecision({
      execution: execOf(a, 'c1'),
      decision: { kind: 'allow' },
      projection: { callId: 'c1', toolName: 'write-file', canonicalHash: 'h1' },
    })
    const f2 = writer.observeDecision({
      execution: execOf(b, 'c2'),
      decision: { kind: 'allow' },
      projection: { callId: 'c2', toolName: 'write-file', canonicalHash: 'h2' },
    })
    assert.equal(f1.ok, true)
    assert.equal(f2.ok, true)
    assert.notEqual(f1.file, f2.file, '两个 Run 写进了同一个文件 ⇒ Run 号不是按事件取的')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============================================================================
// **T3② / T4**（2026-09-24）：三处**反例**。
//
// 前面五例证明的是"按事件取 Run 的接线是对的"。而"对"这个读数有一个老问题：
// 它在**错法**下会不会绿，用例自己没说。所以下面三例把错法与事实的差别
// **摆进同一次运行**里 —— 一处是 T3 要的"装配期绑死 ⇒ Run #2 写进 Run #1 的台账"，
// 两处是 T4 那三种记录形状里今天仍没接的两种（`result` 无生产者、`attemptId` 恒 null）。
// ============================================================================

test('⑥ ★★★（T3② 反例）装配期把 Run 绑死 ⇒ Run #2 的账写进 Run #1 的车道，而 Run #2 自己的车道不存在', async () => {
  const dir = tempDir()
  const okDir = tempDir()
  try {
    // ★ 这是**故意的错法**：`runIdOf` 不看事件，装配期就把 Run 定死。
    //   它与 `writerWiredTo()` 只差这一个函数体 —— 于是两份读数的差别只来自这一处。
    const firstRun = 'run-first'
    const wrongWriter = createToolCallSpoolWriter({
      dataDir: dir,
      runIdOf: () => firstRun,
      rowOf: (event, runId) => toolCallRowOf(event.projection, {
        decision: event.decision?.kind,
        decisionSource: (typeof event.source === 'string' && event.source.trim() !== '')
          ? event.source
          : 'pre-execute',
        reason: event.decision?.reason ?? event.reason ?? null,
        runId,
      }),
    })
    const wrongBridge = createEnforcementBridge({
      context: PROC_CTX,
      decide: () => ({ kind: 'allow' }),
      onDecision: createSpoolObserver(wrongWriter, { allowKind: DECISION_KINDS.ALLOW }),
    })
    await driveOnce(wrongBridge, execOf(agentWithRun('run-second'), 'call-second'))

    // ① Run #2 的两次写入**全部**落在 Run #1 的车道里
    const stolen = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: firstRun }) }).records
    assert.deepEqual(stolen.map((r) => r.kind), ['decision', 'dispatched'])
    assert.equal(stolen[0].row.callId, 'call-second')
    // ★ 而且账上写着**错的 Run 号**：这一行说的是 `run-first`。
    //   这正是那处缺陷最贵的地方 —— 它读起来完全合理，只是记在了别人的账上。
    assert.equal(stolen[0].row.runId, firstRun,
      '绑死时账上的 runId 会跟着错法一起错；若这里断言失败，说明"错法"没有真的绑死')
    // ② Run #2 自己的车道**根本不存在**（不是"空文件"，是没这个文件）
    assert.equal(readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-second' }) }).present, false)

    // ③ ★ 反向对照：同一条驱动、换成生产的"按事件取" ⇒ 两个 Run 各归各位。
    //    没有这一段，上面那些断言在一个"两个 Run 都不写"的实现下同样绿。
    const { bridge: okBridge } = bridgeFor(okDir)
    await driveOnce(okBridge, execOf(agentWithRun('run-second'), 'call-second'))
    assert.equal(readSpoolRecords({ file: spoolFileFor({ dataDir: okDir, runId: firstRun }) }).present, false,
      '生产接线在只跑过 Run #2 时不该有 Run #1 的车道')
    const own = readSpoolRecords({ file: spoolFileFor({ dataDir: okDir, runId: 'run-second' }) }).records
    assert.deepEqual(own.map((r) => r.kind), ['decision', 'dispatched'])
    assert.equal(own[0].row.runId, 'run-second')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(okDir, { recursive: true, force: true })
  }
})

test('⑦ ★★★（T4 反例之一）`result` 在词表里、在生产路径上**一个都不产**，而每行都写着 resultStatus:none', async () => {
  const dir = tempDir()
  try {
    // ① 词表层：spool **认识** `result`，并会按它的必填字段校验。
    //    ⇒ 缺的不是词表。这一半必须与下一半一起读，否则"result 恒 0 行"
    //      会被读成"还没有结果发生"。
    assert.equal(TOOLCALL_SPOOL_KINDS.RESULT, 'result')
    const file = spoolFileFor({ dataDir: dir, runId: 'run-hand' })
    const hand = appendSpoolRecord({
      file,
      record: { kind: TOOLCALL_SPOOL_KINDS.RESULT, row: { callId: 'hand-1', status: 'ok' } },
    })
    // ★ 断言用"**写进去再读回来**"，不用返回值的字段名（那是实现细节；
    //   本节初版就写错过一次：`appendSpoolRecord` 返回的是 `{file, bytes}`，没有 `ok`）。
    assert.ok(hand.bytes > 0, '写入没有字节数 —— 返回值形状变了，读一下这个函数的契约')
    const back = readSpoolRecords({ file })
    assert.equal(back.complete, true, `词表说它认识 result，写入却被拒了：${JSON.stringify(back.refusals)}`)
    assert.deepEqual(back.records.map((r) => r.kind), [TOOLCALL_SPOOL_KINDS.RESULT])
    assert.equal(back.records[0].row.status, 'ok')

    // ② 生产层：真桥走 `allow` 与 `deny` 两条真实路径 ⇒ 一个 `result` 都没有
    const kinds = new Set()
    const statuses = new Set()
    for (const [runId, decide, callId] of [
      ['run-w-allow', () => ({ kind: 'allow' }), 'w1'],
      ['run-w-deny', () => ({ kind: 'deny', reason: '越界' }), 'w2'],
    ]) {
      const { bridge } = bridgeFor(dir, { decide })
      await driveOnce(bridge, execOf(agentWithRun(runId), callId))
      for (const r of readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId }) }).records) {
        kinds.add(r.kind)
        statuses.add(r.row.resultStatus)
      }
    }
    assert.ok(!kinds.has(TOOLCALL_SPOOL_KINDS.RESULT),
      `生产路径上出现了 result 行：${[...kinds].join(', ')} —— 那条缝要是接了，本节与 §2.2 都要改`)
    assert.deepEqual([...kinds].sort(), ['decision', 'dispatched'])
    // ③ 最贵的一半：每一行都带着 `resultStatus: 'none'` ⇒
    //    「结果还没回来」与「根本没人写结果」在账上是**同一行**。
    assert.deepEqual([...statuses], ['none'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑧ ★★（T4 反例之二）`attemptId` 今天恒为 `null`，且是**显式的** null（键在）而不是缺键', async () => {
  const dir = tempDir()
  try {
    const { bridge } = bridgeFor(dir)
    await driveOnce(bridge, execOf(agentWithRun('run-att'), 'att-1'))
    const rows = readSpoolRecords({ file: spoolFileFor({ dataDir: dir, runId: 'run-att' }) }).records
    assert.ok(rows.length >= 1)
    // ★ 契约：行的键集与 `toolCallRowOf` **一致**（不是"我们记得的那几个"）。
    //   把这条钉住，字段改名/增删会在这里红，而不是在某个下游读数的"看起来对"里。
    const expected = Object.keys(toolCallRowOf(
      { callId: 'x', toolName: 'y', arguments: {}, canonicalHash: 'h' },
      { decision: 'allow', decisionSource: 'pre-execute' },
    )).sort()
    for (const r of rows) {
      assert.deepEqual(Object.keys(r.row).sort(), expected, '行的键集与 `toolCallRowOf` 不一致（形状在漂）')
      // ★ 显式 null 与缺键在 JSON 里长得不一样：缺键读起来像"这次没有 attempt"，
      //   而真相是"这一版还没把 attemptId 接上来"（T4 登记，下一轮连同 result 一起做）。
      assert.ok('attemptId' in r.row, '缺 attemptId 键：读起来与"这次没有 attempt"一样')
      assert.equal(r.row.attemptId, null)
      assert.equal(r.row.runId, 'run-att')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
