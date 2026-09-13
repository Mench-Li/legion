// orchestrator/worker/claim-gate.test.mjs
// ============================================================================
// PRT-711：把**产品状态**接到 Orchestrator 的认领决定上。
//
// 在这一批之前，`product/runtime-state.mjs` 把 spec §6.3 那张表做全了，
// 却**没有任何生产调用方**——于是那张表在真实运行里从不生效：
// worker 只问「我能不能执行」（有没有 executor、阶段齐不齐），
// 从不问「现在该不该执行」。
//
//   > 一个"引擎在、我就认领"的 worker，
//   > 与一个在升级过程中继续把任务领走并跑起来的 worker，
//   > 是同一个东西——只不过前者在"我能不能执行"这个问题上回答得完全正确。
//
// ## 这一套要钉住的三件事
//
//   ① **闸门真的排在 hub.claim() 之前。** 判据不是"闸门被调用了"，
//      而是**hub 一次都没被调用过**——一个"先认领再问闸门"的实现，
//      在"闸门被调用"这个计数上看起来是完全正确的。
//   ② **每轮都重新问。** 升级是运行中发生的；只在启动时判一次，
//      等于在升级开始的下一秒又开始认领。
//   ③ **问不出来 ≠ 可以认领。** 闸门抛错、返回空，都必须落成"不认领"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorker, inPlaceStages } from './main.mjs'
import { claimGateFromExecutor, runtimeStateFromExecutor } from '../../product/orchestrator/claim-gate.mjs'
import { EXECUTOR_CODES } from './executor.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'claim-gate-'))

/** 一个记账用的 hub：记录 claim 被调用了几次。 */
function countingHub(claimResult = null) {
  const calls = { claim: 0 }
  return {
    calls,
    async claim() { calls.claim += 1; return claimResult },
    async heartbeat() { return { ok: true } },
    async release() { return { ok: true } },
    async transition() { return { ok: true } },
  }
}

const EXECUTOR = { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) }

function makeWorker({ hub, claimGate, dataDir, logs = [] }) {
  return createWorker({
    hub,
    executor: EXECUTOR,
    claimGate,
    dataDir,
    logger: (l) => logs.push(l),
  })
}

// ── ① 闸门挡在认领之前 ────────────────────────────────────────────────

test('闸门说不认领时，hub.claim **一次都不会被调用**', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  let asked = 0
  const w = makeWorker({
    hub, dataDir,
    claimGate: () => { asked += 1; return { claim: false, state: 'upgrading', reason: '正在升级' } },
  })

  const r = await w.tick()

  assert.equal(asked, 1, '闸门必须被问到')
  assert.equal(r.acted, false)
  assert.equal(r.reason, 'claim-blocked')
  // ★ 这一条才是要点：判据不是"闸门跑过了"，而是**认领根本没发生**。
  assert.equal(hub.calls.claim, 0,
    '闸门说不认领，却仍然调用了 hub.claim——那说明闸门排在认领之后，等于没有闸门')
})

test('闸门说不认领时，状态文件里能读到**产品状态**与理由', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  const w = makeWorker({
    hub, dataDir,
    claimGate: () => ({ claim: false, state: 'upgrading', scope: 'none', reason: '正在升级：已停止认领' }),
  })
  await w.tick()

  const status = w.status()
  assert.equal(status.state, 'claim-blocked')
  assert.equal(status.claimGateMode, 'installed')
  // "为什么现在不认领"必须能从盘上读到，而不是只能从日志行文里猜
  assert.equal(status.claimGate.state, 'upgrading')
  assert.match(status.claimGate.reason, /正在升级/)
  assert.equal(status.claimGate.claim, false)
})

test('闸门放行时照常认领（闸门不是"一律不认领"的开关）', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  const w = makeWorker({
    hub, dataDir,
    claimGate: () => ({ claim: true, state: 'ready', scope: 'all', reason: '执行引擎可用' }),
  })
  const r = await w.tick()
  assert.equal(hub.calls.claim, 1, '放行时必须真的去认领')
  assert.notEqual(r.reason, 'claim-blocked')
})

// ── ② 每轮都重新问 ────────────────────────────────────────────────────

test('★ 闸门是**每轮**问的：升级一开始，下一轮就停下来', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  // 一个会变的开关：真实里它由"升级是否进行中"驱动
  let upgrading = false
  const gate = claimGateFromExecutor({ wired: true }, () => ({ upgrading }))
  const w = makeWorker({ hub, dataDir, claimGate: gate })

  await w.tick()
  assert.equal(hub.calls.claim, 1, '第一轮应当认领（产品状态 ready）')

  upgrading = true
  const r2 = await w.tick()
  // ★ 这一条是"每轮问"的全部意义：启动时它明明是 ready 的。
  assert.equal(r2.reason, 'claim-blocked', '升级开始后必须立刻停止认领')
  assert.equal(hub.calls.claim, 1, '升级开始后不得再认领')
  assert.equal(w.status().claimGate.state, 'upgrading')

  upgrading = false
  await w.tick()
  assert.equal(hub.calls.claim, 2, '升级结束后应当恢复认领')
})

// ── ③ 问不出来 ≠ 可以认领 ────────────────────────────────────────────

test('★ 闸门抛错时**不认领**（坏掉的判据不是通行证）', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  const w = makeWorker({ hub, dataDir, claimGate: () => { throw new Error('闸门内部炸了') } })

  const r = await w.tick()
  assert.equal(r.reason, 'claim-blocked')
  assert.equal(hub.calls.claim, 0, '闸门抛错时绝不能认领')
  assert.match(w.status().claimGate.reason, /闸门内部炸了/)
})

test('★ 闸门返回空时**不认领**（"没给结论"不是"同意"）', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  for (const empty of [null, undefined]) {
    const w = makeWorker({ hub, dataDir, claimGate: () => empty })
    const r = await w.tick()
    assert.equal(r.reason, 'claim-blocked', `闸门返回 ${empty} 时必须不认领`)
  }
  assert.equal(hub.calls.claim, 0)
})

test('claimGate 不是函数时**建实例就抛错**（装了却从不被调用 = 没装）', () => {
  const dataDir = tmp()
  try {
    assert.throws(
      () => createWorker({ hub: countingHub(), dataDir, claimGate: { claim: true } }),
      /claimGate 必须是函数/,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ── ④ 没装闸门这件事必须**可见** ──────────────────────────────────────

test('★ 没装闸门时状态里是 not-installed，而不是被读成"闸门放行"', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  const logs = []
  const w = makeWorker({ hub, dataDir, logs }) // 不传 claimGate
  w.start()
  await w.stop({ reason: 'test' })

  // 三态而不是布尔：not-installed 与 installed∧true 在"为什么 claimed 一直是 0"
  // 这件事上给出的答案完全不同。
  assert.equal(w.status().claimGateMode, 'not-installed')
  assert.equal(w.status().claimGate, null, '没装闸门时不该伪造一份裁决')
  assert.ok(logs.some((l) => /没有安装认领闸门/.test(l)),
    '没装闸门必须在启动时说一次——否则"产品状态拦不住它"是一件要猜的事')
})

// ── ⑤ 执行引擎状态 → 产品状态的映射 ──────────────────────────────────

test('runtimeStateFromExecutor：三种处境映射到三个不同的产品状态', () => {
  assert.equal(runtimeStateFromExecutor({ wired: true, refusal: null }).processState, 'ready')
  assert.equal(
    runtimeStateFromExecutor({ wired: false, refusal: { code: EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE } }).processState,
    'unavailable',
  )
  assert.equal(
    runtimeStateFromExecutor({ wired: false, refusal: { code: EXECUTOR_CODES.HOST_PORT_REQUIRED } }).processState,
    'unavailable',
  )
  // 自检不兼容要**带出 reasons**，且由 liftProductState 抬成 incompatible
  const g = claimGateFromExecutor({ wired: false, refusal: { code: EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE, reasons: ['补丁层未应用'] } })()
  assert.equal(g.state, 'incompatible', '自检不兼容必须抬成 incompatible（禁止自动执行那一档）')
  assert.equal(g.claim, false)
  assert.equal(g.liftedFrom, 'unavailable')
})

test('★ 认不出来的处境不落到 ready：外部信号只能把状态往上抬', () => {
  // 想让一个"接上了"的 worker 报个奇怪的状态 → 不能变成 ready
  const weird = claimGateFromExecutor({ wired: true }, () => ({ processState: '不存在的状态' }))()
  assert.equal(weird.state, '不存在的状态')
  assert.equal(weird.claim, false, '认不出的状态绝不允许认领')
  assert.equal(weird.unrecognized, true)

  // 反过来：接上时是 ready；但 upgrading 必须压过它（更保守的方向）
  const up = claimGateFromExecutor({ wired: true }, () => ({ upgrading: true }))()
  assert.equal(up.state, 'upgrading')
  assert.equal(up.claim, false)
  assert.equal(up.liftedFrom, 'ready')
})

test('degraded：不给"哪些任务的必需能力已满足"就一个都不认领', () => {
  const noInfo = claimGateFromExecutor({ wired: true }, () => ({ processState: 'degraded' }))()
  assert.equal(noInfo.claim, false, '不给判据不等于判据都满足')
  assert.equal(noInfo.state, 'degraded')
  // ★ 断言**理由的出处**，而不只是布尔值：
  //   `satisfiedCapabilities: null`（"没给"）与 `[]`（"给了，一个都没满足"）
  //   都得到 claim=false，但它们是两件不同的事，只有前者会说出
  //   "**不给判据不等于判据都满足**"。
  //   只断言 claim=false 的话，闸门把 null 写成 [] 也照样绿——
  //   而那恰好把"调用方根本没接线"伪装成"接线了但没有能力可用"。
  assert.match(noInfo.reason, /不给判据不等于判据都满足/,
    '必须区分"没给判据"与"给了但都不满足"——否则接线漏了会看起来像能力不足')

  const withInfo = claimGateFromExecutor({ wired: true }, () => ({ processState: 'degraded', satisfiedCapabilities: ['t1'] }))()
  assert.equal(withInfo.claim, true)
  assert.deepEqual(withInfo.eligible, ['t1'])
})

// ── ⑥ 闸门不越过"我干得了吗"那一层 ───────────────────────────────────

test('没有执行引擎时不认领（闸门不替代既有的能力判据）', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const hub = countingHub({ attemptId: 'a1' })
  const w = createWorker({
    hub, executor: null, dataDir,
    claimGate: () => ({ claim: true, state: 'ready' }),   // 闸门放行也没用
  })
  const r = await w.tick()
  assert.equal(r.reason, 'no-executor')
  assert.equal(hub.calls.claim, 0)
})

test('hub 没配时不认领（闸门排在 hub 检查之后，不制造假的产品状态）', async (t) => {
  const dataDir = tmp()
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  let asked = 0
  const w = createWorker({
    hub: null, executor: EXECUTOR, dataDir,
    claimGate: () => { asked += 1; return { claim: true } },
  })
  const r = await w.tick()
  assert.equal(r.reason, 'hub-not-configured')
  assert.equal(asked, 0, 'hub 都没配时不必问闸门')
})
