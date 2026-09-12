// ============================================================================
// PRT-707 的判据。
//
// 这一组盯的**不是**"六个步骤跑得通不通"，而是**向导报"完成"时到底看没看过产品**。
//
// 一个"每一步都返回成功就报完成"的向导，与一个"不管做没做成都说完成了"的向导，
// 在"用户第一次点运行的时候会不会成功"上是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STEP_KINDS,
  VERIFY_ACCEPTED_STATES,
  WIZARD_CODES,
  WIZARD_STATE_FILENAME,
  WIZARD_STEP_DEFS,
  WIZARD_STEP_IDS,
  createWizard,
} from './wizard.mjs'

function scratch(prefix = 'legion-wizard-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 一份"什么都成功"的依赖集合。 */
function happyDeps(over = {}) {
  return {
    checkEnvironment: () => ({ ok: true, message: '环境满足' }),
    initialize: () => ({ ok: true, message: '目录已建立' }),
    start: () => ({ ok: true, message: '组件已启动' }),
    submitModelConfig: async () => ({ ok: true, message: '模型已配置' }),
    observe: async () => ({ runtimeState: 'ready', modelResolved: true }),
    ...over,
  }
}

/**
 * 按**真实的使用顺序**驱动向导：跑到需要输入的地方 → 提交 → 继续。
 *
 * 为什么不让 `submit()` 在任何时候都接受：`submit()` 在**当前步骤不是**
 * 需要输入的那一步时会拒绝。这是对的——一个在错误步骤上静默吞掉用户输入的
 * 向导，会让用户以为自己已经配好了。所以测试侧适配它，而不是反过来。
 */
async function driveToInput(w, value = { apiKey: 'sk-x' }) {
  const r = await w.run()
  if (r.needsInput === true) {
    const accepted = w.submit(value)
    assert.equal(accepted.accepted, true, `提交被拒绝：${accepted.message}`)
  }
  return r
}
// ── 步骤定义 ────────────────────────────────────────────────────────────────

test('① 六个步骤顺序固定，且依赖顺序即数组顺序', () => {
  assert.deepEqual([...WIZARD_STEP_IDS],
    ['environment', 'initialize', 'start', 'configure-model', 'verify', 'done'])
  assert.equal(Object.isFrozen(WIZARD_STEP_IDS), true)
})

test('① 每一步都有标题，未完成时都有"为什么还卡着"', () => {
  for (const id of WIZARD_STEP_IDS) {
    const d = WIZARD_STEP_DEFS[id]
    assert.equal(d.id, id)
    assert.ok(typeof d.title === 'string' && d.title.length > 0, id)
    if (id === 'done') { assert.equal(d.blockingReason, null); continue }
    assert.ok(typeof d.blockingReason === 'string' && d.blockingReason.length > 0,
      `${id} 没说明"为什么还卡着"——用户会不知道该干什么`)
  }
  assert.equal(Object.isFrozen(WIZARD_STEP_DEFS), true)
})

test('① ★ `configure-model` 是**需要输入**的那一步（不是自动跳过）', () => {
  assert.equal(WIZARD_STEP_DEFS['configure-model'].kind, STEP_KINDS.INPUT)
  assert.ok(WIZARD_STEP_DEFS['configure-model'].needsInputReason.length > 0)
  assert.equal(WIZARD_STEP_DEFS.verify.kind, STEP_KINDS.VERIFY)
})

// ── ★ 核心：报"完成"必须建立在实测之上 ──────────────────────────────────────

test('② ★ 观测到 `ready` + 模型可解析时才算完成（正向对照）', async () => {
  const w = createWizard(happyDeps())
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, true)
  assert.equal(r.blocked, undefined)
  // 必须**真的调过** observe，而不是跳过它
  assert.ok(r.results.some((x) => x.step === 'verify' && x.ok === true),
    '没有走 verify 就报了完成')
})

test('② ★★ 前面每一步都成功，但**实测不通过**时**不能**报完成', async () => {
  // 这是本模块存在的理由。
  for (const seen of [
    { runtimeState: 'starting', modelResolved: true },
    { runtimeState: 'degraded', modelResolved: true },
    { runtimeState: 'unavailable', modelResolved: true },
    { runtimeState: 'incompatible', modelResolved: true },
    { runtimeState: 'upgrading', modelResolved: true },
    { runtimeState: null, modelResolved: true },
    {},
  ]) {
    const w = createWizard(happyDeps({ observe: async () => seen }))
    await driveToInput(w)
    const r = await w.run()
    assert.equal(r.done, false,
      `实测到 ${JSON.stringify(seen)} 却报了完成——"每一步都返回成功"被当成了"产品可用"`)
    assert.equal(r.blockedStep, 'verify')
  }
})

test('② ★ `degraded` **不算**通过（部分能力不可用不是"产品可用了"）', () => {
  assert.deepEqual([...VERIFY_ACCEPTED_STATES], ['ready'])
})

test('② ★ 运行时可用但**模型解析不了**时也不能报完成', async () => {
  // 「我写了一条记录」与「这条记录能用」是两件事。
  const w = createWizard(happyDeps({
    observe: async () => ({ runtimeState: 'ready', modelResolved: false }),
  }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.ok(r.message.includes('解析'), r.message)
})

test('② ★ 观测**抛错**时不算过（一个在观测失败时放行的向导＝不做观测的向导）', async () => {
  const w = createWizard(happyDeps({
    observe: async () => { throw new Error('探针炸了') },
  }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.blockedStep, 'verify')
  assert.ok(r.message.includes('探针炸了'), r.message)
})

test('② ★ 观测返回说不清的东西时不算过', async () => {
  for (const bad of [null, undefined, 'ok', 42, true]) {
    const w = createWizard(happyDeps({ observe: async () => bad }))
    await driveToInput(w)
    const r = await w.run()
    assert.equal(r.done, false, `观测返回 ${JSON.stringify(bad)} 却算过了`)
    assert.equal(r.blockedStep, 'verify')
  }
})

test('② ★ **没有配置观测方式**时不报完成（宁可卡住，也不说假话）', async () => {
  const deps = happyDeps()
  delete deps.observe
  const w = createWizard(deps)
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.blockedStep, 'verify')
  // 断言**具体那句话**，不只断言"卡住了"。
  //
  // 没有这个显式检查时，`observe` 为 null 会在 `await observe()` 那里抛
  // TypeError，被 catch 接住，结果同样是"卡在 verify"——所以只断言"卡住"
  // 的话，把这道检查删掉用例照样绿。而两者的差别恰恰是用户能看到的：
  // 一个是"你没有配置观测方式"（装配问题），
  // 一个是"观测产品时出错：observe is not a function"（一个看不出该修哪里的报错）。
  assert.ok(r.message.includes('没有配置观测方式'),
    `缺依赖被说成了别的原因：${r.message}`)
})

test('② `verify` 失败时留下 **error 级**诊断（用户要能查到为什么）', async () => {
  const w = createWizard(happyDeps({ observe: async () => ({ runtimeState: 'unavailable' }) }))
  await driveToInput(w)
  await w.run()
  const d = w.diagnostics().find((x) => x.code === WIZARD_CODES.NOT_OBSERVED)
  assert.ok(d, '没有留下"没观测到"的诊断')
  assert.equal(d.severity, 'error')
})

// ── ★ 需要输入的那一步必须真的挡住 ──────────────────────────────────────────

test('③ ★ 没给输入时**停在原地**，且说清在等什么', async () => {
  const w = createWizard(happyDeps())
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.needsInput, true)
  assert.equal(r.blockedStep, 'configure-model')
  const st = w.status()
  assert.equal(st.step, 'configure-model')
  assert.ok(st.awaiting !== null, 'status() 没有说清在等什么')
  assert.ok(st.awaiting.includes('密钥'), st.awaiting)
})

test('③ ★ 没给输入时**绝不**往下走到 verify 或 done', async () => {
  let observed = 0
  const w = createWizard(happyDeps({
    observe: async () => { observed += 1; return { runtimeState: 'ready', modelResolved: true } },
  }))
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(observed, 0, '还没配模型就去观测了')
  assert.ok(!r.results.some((x) => x.step === 'verify'), '跳过模型配置直接去 verify')
})

test('③ 没给输入时不调用 `submitModelConfig`', async () => {
  let calls = 0
  const w = createWizard(happyDeps({
    submitModelConfig: async () => { calls += 1; return { ok: true } },
  }))
  await w.run()
  assert.equal(calls, 0)
})

test('③ ★ 提交的动作返回非正面结论时**不算过**（"没返回错误"≠"成功了"）', async () => {
  for (const bad of [undefined, null, {}, { ok: false }, { ok: false, message: '密钥无效' }]) {
    const w = createWizard(happyDeps({ submitModelConfig: async () => bad }))
    await driveToInput(w)
    const r = await w.run()
    assert.equal(r.done, false, `提交返回 ${JSON.stringify(bad)} 却算过了`)
    assert.equal(r.blockedStep, 'configure-model')
  }
})

test('③ 提交动作抛错时也停在原地（不是冒到调用方）', async () => {
  const w = createWizard(happyDeps({
    submitModelConfig: async () => { throw new Error('密钥库不可写') },
  }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.ok(r.message.includes('密钥库不可写'), r.message)
})

test('③ ★ 在**不需要输入**的步骤上提交会被拒绝（静默吞掉更糟）', () => {
  const w = createWizard(happyDeps())
  const r = w.submit({ apiKey: 'sk-x' })
  assert.equal(r.accepted, false)
  assert.ok(r.message.includes('不需要输入'), r.message)
  assert.ok(w.diagnostics().some((d) => d.code === WIZARD_CODES.BAD_INPUT))
})

test('③ 提交空值被拒绝（缺密钥就是缺密钥）', async () => {
  const w = createWizard(happyDeps())
  await w.run()
  assert.equal(w.submit(null).accepted, false)
  assert.equal(w.submit({}).accepted, false)
  assert.equal(w.submit({ apiKey: '' }).accepted, false)
  assert.equal(w.submit({ apiKey: 'sk-x' }).accepted, true)
})

// ── 失败就停，不跳步 ────────────────────────────────────────────────────────

test('④ ★ 任何自动步骤失败时**停下**，不继续往前（否则会带着假完成回来）', async () => {
  for (const step of ['environment', 'initialize', 'start']) {
    const deps = happyDeps()
    const key = step === 'environment' ? 'checkEnvironment' : step === 'initialize' ? 'initialize' : 'start'
    deps[key] = () => ({ ok: false, message: `${step} 炸了` })
    const w = createWizard(deps)
    await driveToInput(w)
    const r = await w.run()
    assert.equal(r.done, false, `${step} 失败却报了完成`)
    assert.equal(r.blockedStep, step)
    // 后面的步骤一次都没被碰过
    assert.ok(!r.results.some((x) => x.step === 'verify'), `${step} 失败后仍然去 verify 了`)
  }
})

test('④ 自动步骤**抛错**时也停下，并把原因写进诊断', async () => {
  const w = createWizard(happyDeps({ start: () => { throw new Error('端口被占') } }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.blockedStep, 'start')
  assert.ok(r.message.includes('端口被占'))
  assert.ok(w.diagnostics().some((d) => d.code === WIZARD_CODES.STEP_FAILED))
})

test('④ 自动步骤返回非正面结论时不算过（`undefined` 也不行）', async () => {
  const w = createWizard(happyDeps({ initialize: () => undefined }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.blockedStep, 'initialize')
})

test('④ 没配置动作的步骤不算过（缺依赖不是"没问题"）', async () => {
  const deps = happyDeps()
  delete deps.checkEnvironment
  const w = createWizard(deps)
  const r = await w.run()
  assert.equal(r.done, false)
  assert.equal(r.blockedStep, 'environment')
})

test('④ ★ 卡住之后**接着推进**不会越过那一步（可反复调用）', async () => {
  let attempts = 0
  const w = createWizard(happyDeps({
    start: () => { attempts += 1; return { ok: false, message: '还没好' } },
  }))
  await driveToInput(w)
  const a = await w.run()
  const b = await w.run()
  assert.equal(a.blockedStep, 'start')
  assert.equal(b.blockedStep, 'start')
  assert.equal(b.done, false)
  assert.ok(attempts >= 2, '第二次 run 没有重试那一步')
})

// ── ★ 断点续跑：只恢复位置，不恢复结论 ──────────────────────────────────────

test('⑤ ★ 中断后重跑**从断点继续**（首次运行向导天然会被打断）', async () => {
  const { root, cleanup } = scratch()
  try {
    const stateFile = join(root, WIZARD_STATE_FILENAME)
    const ran = []
    const w1 = createWizard(happyDeps({
      initialize: () => { ran.push('initialize'); return { ok: true } },
      start: () => { ran.push('start'); return { ok: true } },
      stateFile, fs: await import('node:fs'),
    }))
    await w1.run()   // 停在 configure-model
    assert.deepEqual(ran, ['initialize', 'start'])

    // 第二次：一个新的实例，同一个状态文件
    const ran2 = []
    const w2 = createWizard(happyDeps({
      checkEnvironment: () => { ran2.push('environment'); return { ok: true } },
      initialize: () => { ran2.push('initialize'); return { ok: true } },
      start: () => { ran2.push('start'); return { ok: true } },
      stateFile, fs: await import('node:fs'),
    }))
    assert.equal(w2.status().step, 'configure-model', '没有从断点继续')
    await driveToInput(w2)
    const r = await w2.run()
    assert.equal(r.done, true)
    assert.ok(!ran2.includes('initialize'), '重跑时又初始化了一遍目录')
    assert.ok(!ran2.includes('start'), '重跑时又启动了一遍')
  } finally { cleanup() }
})

test('⑤ ★★ 恢复时**不恢复**"某一步已经过了"的结论（上次的 verify 对这次没有说服力）', async () => {
  const { root, cleanup } = scratch()
  try {
    const fs = await import('node:fs')
    const stateFile = join(root, WIZARD_STATE_FILENAME)
    // 先完成一次
    const w1 = createWizard(happyDeps({ stateFile, fs }))
    await driveToInput(w1)
    assert.equal((await w1.run()).done, true)

    // 状态文件里写着 finished:true，但重跑时**必须重新观测**
    let observed = 0
    const w2 = createWizard(happyDeps({
      // 模型确实已经配好了，所以不必再输一次密钥——
      // 但"模型配好了"**不能**替代"产品实测可用"。
      isModelConfigured: () => true,
      observe: async () => { observed += 1; return { runtimeState: 'unavailable' } },
      stateFile, fs,
    }))
    const r = await w2.run()
    assert.equal(r.done, false,
      '上一轮的"完成"被当成了这一轮的结论——产品这次其实是坏的')
    assert.ok(observed >= 1, '没有重新观测就下了结论')
  } finally { cleanup() }
})

test('⑤ 坏掉的进度文件**不猜**：回到第一步（各步幂等，从头是安全的）', async () => {
  const { root, cleanup } = scratch()
  try {
    const fs = await import('node:fs')
    const stateFile = join(root, WIZARD_STATE_FILENAME)
    writeFileSync(stateFile, '{ 这不是 JSON', 'utf8')
    const w = createWizard(happyDeps({ stateFile, fs }))
    assert.equal(w.status().step, 'environment')
    assert.ok(w.diagnostics().some((d) => d.code === WIZARD_CODES.STATE_UNREADABLE))
  } finally { cleanup() }
})

test('⑤ 版本不认识的进度文件也不猜', async () => {
  const { root, cleanup } = scratch()
  try {
    const fs = await import('node:fs')
    const stateFile = join(root, WIZARD_STATE_FILENAME)
    writeFileSync(stateFile, JSON.stringify({ version: 'legion/first-run-wizard@99', step: 'verify' }), 'utf8')
    const w = createWizard(happyDeps({ stateFile, fs }))
    assert.equal(w.status().step, 'environment')
  } finally { cleanup() }
})

test('⑤ 进度写不下来时**照样能跑完**（只是下次会从头开始），并留一条诊断', async () => {
  const { root, cleanup } = scratch()
  try {
    // 指向一个不存在的目录：写入必然失败
    const stateFile = join(root, 'no-such-dir', WIZARD_STATE_FILENAME)
    const w = createWizard(happyDeps({ stateFile, fs: await import('node:fs') }))
    await driveToInput(w)
    const r = await w.run()
    assert.equal(r.done, true, '进度存不下来不该让向导跑不完')
    assert.ok(w.diagnostics().some((d) => d.code === WIZARD_CODES.STATE_WRITE_FAILED))
  } finally { cleanup() }
})

test('⑤ 没给状态文件时不做持久化，也不报错', async () => {
  const w = createWizard(happyDeps())
  assert.equal(w.stateFile, null)
  await driveToInput(w)
  assert.equal((await w.run()).done, true)
})

test('⑤ ★ 模型**确实**已配置时可以跳过输入（重跑向导不必重新输密钥）', async () => {
  const w = createWizard(happyDeps({ isModelConfigured: () => true }))
  const r = await w.run()
  assert.equal(r.done, true, '模型已确认配置，却仍然卡在输入上')
  assert.ok(r.results.some((x) => x.step === 'configure-model' && x.ok === true))
})

test('⑤ ★★ 只有**恰好返回 true** 才算已配置（"看起来配过了"会让用户无路可走）', async () => {
  // 一个"大概配过了"的判断会跳过唯一的配置入口，然后走到 verify 去发现
  // 模型不可用——而用户此时已经没有任何地方可以填密钥了。
  for (const bad of [undefined, null, false, 'yes', 1, [], {}]) {
    const w = createWizard(happyDeps({ isModelConfigured: () => bad }))
    const r = await w.run()
    assert.equal(r.needsInput, true,
      `核对返回 ${JSON.stringify(bad)} 时跳过了输入：用户没有地方可以填密钥了`)
    assert.equal(r.blockedStep, 'configure-model')
  }
})

test('⑤ ★ 核对**抛错**时要求输入（读不出来不等于配好了）', async () => {
  const w = createWizard(happyDeps({
    isModelConfigured: () => { throw new Error('读不了配置') },
  }))
  const r = await w.run()
  assert.equal(r.needsInput, true)
})

test('⑤ 没有配置核对手续时一律要求输入（缺依赖不是"没问题"）', async () => {
  const w = createWizard(happyDeps())
  const r = await w.run()
  assert.equal(r.needsInput, true)
})

// ── 状态与重置 ──────────────────────────────────────────────────────────────
test('⑥ `status()` 报出已完成的前缀步骤（用户看得见进度）', async () => {
  const w = createWizard(happyDeps())
  await w.run()
  const st = w.status()
  assert.deepEqual([...st.completedSteps], ['environment', 'initialize', 'start'])
  assert.equal(st.finished, false)
  assert.equal(Object.isFrozen(st), true)
})

test('⑥ 完成后 `status()` 的 `finished` 为真、`blockingReason` 为 null', async () => {
  const w = createWizard(happyDeps())
  await driveToInput(w)
  await w.run()
  const st = w.status()
  assert.equal(st.finished, true)
  assert.equal(st.blockingReason, null)
})

test('⑥ 已完成后重复 `run()` 直接返回完成（不会把步骤又跑一遍）', async () => {
  let inits = 0
  const w = createWizard(happyDeps({ initialize: () => { inits += 1; return { ok: true } } }))
  await driveToInput(w)
  await w.run()
  const r2 = await w.run()
  assert.equal(r2.done, true)
  assert.equal(inits, 1)
})

test('⑥ `reset()` 回到第一步，且**不删除任何产品数据**', async () => {
  const w = createWizard(happyDeps())
  await driveToInput(w)
  await w.run()
  const r = w.reset()
  assert.equal(r.step, 'environment')
  assert.equal(w.status().step, 'environment')
  assert.equal(w.status().finished, false)
  assert.deepEqual([...w.status().completedSteps], [])
  assert.equal(w.status().awaiting, null)
})

test('⑥ 结果与诊断都记账，且冻结', async () => {
  const w = createWizard(happyDeps())
  await driveToInput(w)
  const r = await w.run()
  assert.equal(Object.isFrozen(r.results), true)
  assert.equal(Object.isFrozen(r.diagnostics), true)
  assert.equal(Object.isFrozen(w), true)
  assert.ok(r.results.length >= 6, `步骤结论太少：${r.results.length}`)
  for (const x of r.results) assert.ok(typeof x.step === 'string' && typeof x.ok === 'boolean')
})

test('⑥ 每一步的结论都带时间戳（排障时要能对齐日志）', async () => {
  let t = 1000
  const w = createWizard(happyDeps({ now: () => (t += 1) }))
  await driveToInput(w)
  const r = await w.run()
  for (const x of r.results) assert.equal(typeof x.at, 'number')
})

test('⑥ ★ 完成标准里那四件事全部走到了（启动、模型配置、运行验证、可停止）', async () => {
  // spec §6.10：「干净 Windows 机器不打开终端即可完成安装后启动、模型配置、
  // 运行和停止。」向导覆盖前三件；"停止"由 Launcher 的 stop() 提供。
  const seen = []
  const w = createWizard(happyDeps({
    checkEnvironment: () => { seen.push('环境'); return { ok: true } },
    initialize: () => { seen.push('初始化'); return { ok: true } },
    start: () => { seen.push('启动'); return { ok: true } },
    submitModelConfig: async () => { seen.push('模型配置'); return { ok: true } },
    observe: async () => { seen.push('运行验证'); return { runtimeState: 'ready', modelResolved: true } },
  }))
  await driveToInput(w)
  const r = await w.run()
  assert.equal(r.done, true)
  assert.deepEqual(seen, ['环境', '初始化', '启动', '模型配置', '运行验证'])
})
