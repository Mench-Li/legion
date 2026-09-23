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
import { readSpoolRecords, spoolFileFor } from '../toolcall/spool.mjs'

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
    // ★ 与 `root-row.mjs:808` 逐字同一条：**放行时**多记一条 `dispatched`。
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
