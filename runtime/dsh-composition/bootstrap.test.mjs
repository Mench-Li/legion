// runtime/dsh-composition/bootstrap.test.mjs
// ============================================================================
// DSH 侧装配入口（PRT-215 落地 + PRT-257 的应用自检与修复入口）
//
// ## 这一组守的是什么
//
// `startupSelfCheck()`、`probeSandbox()`、`bindDshRuntime()` 三件东西
// 此前**都只在自己的模块里存在，没有任何调用者**。后果有两条，第二条更重：
//
//   ① worker 的 `executor` 永远是 `EXECUTOR_HOST_PORT_REQUIRED`，
//      PRT-253 的执行引擎与 PRT-510 的预算闸门**都不会被激活**；
//   ② 「强制面未生效时禁止自动执行」这条保证**从未被行使过**——
//      它写在文档里、写在代码里，而从没拦过任何一次执行。
//
//   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
//
// 所以这一组最要紧的一条不是"自检函数算得对不对"（那有自己的套件），
// 而是**自检没过时，端口到底有没有被注册**——因为注册了就代表
// 一个独立进程的 worker 可能已经开始认领任务了。
//
// 全程用注入的假件：组合树观察、沙箱 `confine`、运行时宿主都是给的。
// 这既符合 `port.mjs`/`selfcheck.mjs` 的既有取舍，也让"补丁层没挂上"
// 这种在真 DSH 上极难稳定复现的处境变得可测。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bootstrapDshRuntime, repairPlanFor, REPAIR_ACTIONS, BOOTSTRAP_CODES,
} from './bootstrap.mjs'
import { PATCH_LAYER_ROWS, LEGION_PERMISSION_PRESETS } from './patch-layer.mjs'
import {
  bindDshRuntime, dshRuntimeBound, resetDshRuntimeBinding, productionExecutorProvider,
} from '../../orchestrator/worker/executor-binding.mjs'
import { EXECUTOR_CODES } from '../../orchestrator/worker/executor.mjs'

// 能力名与判据都照 `runtime/contracts` 的 `REQUIRED_CAPABILITIES`：
// 判据是「**必须显式为 true**」——「没说」与「说不行」同判不可用。
// 名字写错就等于没说，于是这一组会整片红，而原因是夹具而不是实现。
const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

/**
 * 一个探测通过、且**端口完整**的运行时宿主。
 *
 * 两件事都要：探测只要 `probeRuntime`，而执行引擎还要 `startRun`
 * （`assertHostPort` 的必需方法就是这两个）。只给 `probeRuntime` 的端口
 * 会被 `PORT_INCOMPLETE` 挡住——那正是它该被挡住的时候。
 */
function hostOk(over = {}) {
  return {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() {
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun() {
      return { result: new Promise(() => {}), dispose: async () => {} }
    },
    ...over,
  }
}

/** 一个"组合树全部行都激活、preset 表也换成了 Legion 的"观察结果。 */
function compositionOk() {
  return {
    rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
    // `LEGION_PERMISSION_PRESETS` 是**按名字作键的对象**，不是数组。
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
  }
}

/**
 * 一个"沙箱真的做到了 full 级管制"的端口。
 *
 * 三件事都要满足，缺一条 `probeSandbox` 就判未生效：
 *   · `enforcement === 'full'`（`partial` 一律判未生效）
 *   · 返回的 argv **真的变了**（原样返回 = 没做任何包装 = 最直接的"没生效"证据）
 *   · `denialSignatures` 非空（空集合意味着沙箱拒绝无法被识别，
 *     拒绝会退化成普通失败）
 */
/**
 * 一个"**读了**组合树、而补丁层确实没生效"的观察结果。
 *
 * 与"没有观察结果"（`composition: {}`）是**两件事**：
 *   · 这里：行在，但没激活 → 补丁层真的没生效 → 去重新应用补丁层
 *   · 那里：没有人去读 → 接线缺一截 → 去把观察器接上
 */
function compositionNotApplied() {
  return {
    rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: false })),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
  }
}

function sandboxOk() {
  return {
    async confine(argv) {
      return {
        enforcement: 'full',
        backend: 'test-backend',
        argv: ['sandbox-run', '--', ...argv],
        denialSignatures: ['operation not permitted'],
      }
    },
  }
}

/** 一个"只做到部分管制"的沙箱端口——按 `partial` 的语义，这**不算可用**。 */
function sandboxPartial() {
  return {
    async confine(argv) {
      return {
        enforcement: 'partial',
        backend: 'test-backend',
        argv: ['sandbox-run', '--', ...argv],
        denialSignatures: ['operation not permitted'],
      }
    },
  }
}

async function boot(over = {}) {
  return bootstrapDshRuntime({
    runtimeHost: hostOk(),
    composition: compositionOk(),
    sandbox: sandboxOk(),
    canRead: () => true,
    ...over,
  })
}

// ============================================================================
// ① 全绿时：真的注册上了，而且 worker 真的能开始工作
// ============================================================================

test('① 自检通过时注册端口，且 `unbind` 可用', async () => {
  resetDshRuntimeBinding()
  const r = await boot()
  try {
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(dshRuntimeBound(), true, '自检通过时必须真的注册')
    assert.equal(typeof r.unbind, 'function')
    assert.equal(r.patchVersion !== null && r.patchVersion !== undefined, true)
  } finally { r.unbind?.(); resetDshRuntimeBinding() }
})

test('① **装配之后 worker 真的能工作**（这是"接线通了"的唯一证明）', async () => {
  // 只断言 `ok: true` 是不够的：`ok` 是这条装配函数自己给的，
  // 而"worker 能不能拿到执行引擎"要**去问 worker 那条路**。
  resetDshRuntimeBinding()
  const r = await boot()
  const hub = {
    async post() { return { status: 200, body: { ok: true, snapshotHash: 'h', snapshot: { finalText: 'x' } } } },
    async get() {
      return { status: 200, body: { ok: true, verification: { ok: true }, snapshot: { finalText: '正文' } } }
    },
  }
  try {
    const provided = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(provided.ok, true,
      `装配之后 worker 必须能拿到执行引擎；实际 ${provided.code}：${provided.message}`)
  } finally { r.unbind?.(); resetDshRuntimeBinding() }
})

test('① 注销之后又回到拒绝（一次装配对应一次注册）', async () => {
  resetDshRuntimeBinding()
  const r = await boot()
  r.unbind()
  assert.equal(dshRuntimeBound(), false)
  const provided = await productionExecutorProvider({ post: async () => ({ status: 200, body: {} }), get: async () => ({ status: 200, body: {} }) })
  assert.equal(provided.ok, false)
  assert.equal(provided.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
})

// ============================================================================
// ② 自检没过时：**什么都不注册**
// ============================================================================

test('② **补丁层没挂上 → 不注册端口**（这是这条闸门存在的全部意义）', async () => {
  resetDshRuntimeBinding()
  const r = await boot({
    // 行一个都不在：补丁层没应用
    composition: compositionNotApplied(),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  // **最要紧的一条**：端口没被注册。注册了就代表一个独立进程的 worker
  // 可能已经开始认领任务了。
  assert.equal(dshRuntimeBound(), false, '自检没过时绝不能注册端口')
  assert.match(r.message, /不注册宿主端口/)
})

test('② **没人给观察结果 → 具名码是「没观察」，不是「补丁层未生效」**', async () => {
  // 这一条是补出来的。第一版写的是 `composition ?? {}`，于是"没人给观察结果"
  // 会静默变成"观察结果是空" → 判 `composition-patch-layer` 未生效 →
  // 报「补丁层未完全生效」。**那是错的诊断**：补丁层可能完全没问题，
  // 只是没有人去读组合树。顺着那条消息排查会去重装补丁层。
  resetDshRuntimeBinding()
  for (const missing of [undefined, null, {}, { rows: [] }, { rows: 'nope' }]) {
    const r = await boot({ composition: missing })
    assert.equal(r.ok, false, `composition=${JSON.stringify(missing)} 时必须拦住执行`)
    assert.equal(r.code, BOOTSTRAP_CODES.COMPOSITION_UNOBSERVED,
      `composition=${JSON.stringify(missing)} 报的是 ${r.code}：` +
      '「没接观察器」与「补丁层没生效」混成一个码会让排查方向指向错的地方')
    assert.notEqual(r.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(dshRuntimeBound(), false)
  }
})

test('② 「没观察」与「观察了、说没生效」**报不同的码**（这是把它们分开的全部意义）', async () => {
  resetDshRuntimeBinding()
  const unobserved = await boot({ composition: undefined })
  const notApplied = await boot({ composition: compositionNotApplied() })
  assert.equal(unobserved.code, BOOTSTRAP_CODES.COMPOSITION_UNOBSERVED)
  assert.equal(notApplied.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.notEqual(unobserved.code, notApplied.code)
  // 两者的修复动作也必须不同——否则"分开"只分在了码上，不在行动上。
  assert.notEqual(unobserved.repair.items[0].action, notApplied.repair.items[0].action)
  assert.equal(unobserved.repair.items[0].action, 'connect-composition-observer')
  assert.equal(notApplied.repair.items[0].action, 'reapply-composition-patch')
})

test('② **沙箱只做到 partial → 不注册**（partial 意味着存在不被管制的路径）', async () => {
  resetDshRuntimeBinding()
  const r = await boot({ sandbox: sandboxPartial() })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.equal(dshRuntimeBound(), false)
  // 理由要能指到沙箱那一项上，而不是笼统的"自检没过"。
  const sandboxCheck = r.checks.find((c) => c.name === 'sandbox-enforcement')
  assert.equal(sandboxCheck.ok, false)
})

test('② **运行时探测未过 → 不注册**', async () => {
  resetDshRuntimeBinding()
  const r = await boot({
    runtimeHost: hostOk({ async probeRuntime() { return { version: '9.9.9', capabilities: {} } } }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.equal(dshRuntimeBound(), false)
  const runtimeCheck = r.checks.find((c) => c.name === 'runtime-probe')
  assert.equal(runtimeCheck.ok, false)
})

test('② 运行时探测**抛错** → 具名拒绝，且不注册', async () => {
  // 真 `probeRuntime` 把宿主异常都归一化成 `{ok:false}`，所以这条分支
  // **用真实现永远走不到**——必须靠注入才测得到。
  // （这正是 PRT-510 那一批学到的：一条没人走过的分支与一条不存在的分支同形。）
  resetDshRuntimeBinding()
  const r = await boot({
    probeFactory: async () => { throw new Error('引擎没起来') },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.RUNTIME_PROBE_FAILED)
  assert.match(r.message, /引擎没起来/)
  assert.equal(dshRuntimeBound(), false)
})

test('② 探测返回 `undefined` 也算未过（"没探测"不等于"没问题"）', async () => {
  resetDshRuntimeBinding()
  const r = await boot({ probeFactory: async () => undefined })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.RUNTIME_PROBE_FAILED)
  assert.equal(dshRuntimeBound(), false)
})

test('② 宿主探测**返回不可用**（不抛）→ 归到自检未过，而不是探测失败码', async () => {
  // 与上面两条是**不同**的路径：宿主不能用是"探测成功地说不行"，
  // 不是"探测本身坏了"。两者的处置不同（前者去修运行时，后者去修探测器）。
  resetDshRuntimeBinding()
  const r = await boot({
    runtimeHost: hostOk({ async probeRuntime() { return { version: '9.9.9', capabilities: {} } } }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.notEqual(r.code, BOOTSTRAP_CODES.RUNTIME_PROBE_FAILED)
  assert.equal(dshRuntimeBound(), false)
})

test('② **端口不完整 → 当场拒绝，不注册**（否则失败会推迟到 worker 那边）', async () => {
  // 只给 `probeRuntime` 的端口能通过探测，却**用不了**：执行引擎还要 `startRun`。
  // 第一版就是在这里注册成功了，于是失败推迟到 worker 构造执行引擎时——
  // 那里报的是 "worker 起不来"，而真因是装配这一步给的东西不全。
  resetDshRuntimeBinding()
  const r = await boot({ runtimeHost: { async probeRuntime() { return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } } } } })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.PORT_INCOMPLETE)
  assert.match(r.message, /startRun/, '要说清缺哪个方法')
  assert.equal(dshRuntimeBound(), false, '端口不全时绝不能注册')
})

test('② 端口**不是对象**时也拒（`null` 读出来是"缺两个方法"，不是"没问题"）', async () => {
  resetDshRuntimeBinding()
  for (const bad of [null, 'nope', 42]) {
    const r = await boot({ runtimeHost: bad })
    assert.equal(r.ok, false, `runtimeHost=${JSON.stringify(bad)} 时必须拒绝`)
    assert.equal(dshRuntimeBound(), false)
  }
})

test('② 缺 `canRead` 时拒绝（不替调用方决定权限）', async () => {
  resetDshRuntimeBinding()
  const r = await boot({ canRead: undefined })
  assert.equal(r.ok, false)
  assert.equal(r.code, BOOTSTRAP_CODES.BAD_WIRING)
  assert.equal(dshRuntimeBound(), false)
})

test('② 自检结果**形状不对**时拒绝（缺 autoExecutionForbidden 会被读成放行）', async () => {
  resetDshRuntimeBinding()
  for (const bad of [{}, { state: 'effective' }, null, 'effective']) {
    const r = await boot({ selfCheck: async () => bad })
    assert.equal(r.ok, false, `自检返回 ${JSON.stringify(bad)} 时必须拒绝`)
    assert.equal(r.code, BOOTSTRAP_CODES.BAD_WIRING)
    assert.equal(dshRuntimeBound(), false)
  }
})

test('② **两次探测的结论被复用，不重新探测**（避免 worker 与 Launcher 判定不一致）', async () => {
  resetDshRuntimeBinding()
  let probes = 0
  const r = await boot({
    runtimeHost: hostOk({
      async probeRuntime() { probes++; return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } } },
    }),
  })
  try {
    assert.equal(probes, 1, '装配时探测一次')
    // worker 建执行引擎时会**再要一次**自检结论——那一次不该重新探测。
    const provided = await productionExecutorProvider({
      post: async () => ({ status: 200, body: { ok: true, snapshotHash: 'h', snapshot: { finalText: 'x' } } }),
      get: async () => ({ status: 200, body: { ok: true, verification: { ok: true }, snapshot: { finalText: '正文' } } }),
    })
    assert.equal(provided.ok, true, JSON.stringify(provided))
    assert.equal(probes, 1, 'worker 那一次必须复用结论：两次探测得到不同答案会让两边判定不一致')
  } finally { r.unbind?.(); resetDshRuntimeBinding() }
})

// ============================================================================
// ③ 修复入口：不能只说"哪一项没过"
// ============================================================================

test('③ 每一项失败都带一条**可执行的**修复动作', () => {
  const check = {
    checks: [
      { name: 'composition-patch-layer', ok: false, reasons: ['补丁层未完全生效'] },
      { name: 'runtime-probe', ok: false, reasons: ['版本不符'] },
      { name: 'sandbox-enforcement', ok: false, reasons: ['沙箱未提供 full 级管制'] },
    ],
  }
  const plan = repairPlanFor(check)
  assert.equal(plan.ok, false)
  assert.equal(plan.items.length, 3)
  for (const item of plan.items) {
    assert.equal(typeof item.action, 'string')
    assert.notEqual(item.action, 'inspect-manually', `${item.check} 应当有预置修法`)
    assert.equal(typeof item.why, 'string')
    assert.ok(item.why.length > 20, '`why` 要说清为什么非修不可，不是一句话重复 check 名')
  }
  assert.deepEqual(plan.items.map((i) => i.action),
    ['reapply-composition-patch', 'install-supported-runtime', 'fix-sandbox-backend'])
})

test('③ **预置里没有的那一项也要出现在计划里**（丢掉它会让"三项没过"变成"修两项就好"）', () => {
  const plan = repairPlanFor({
    checks: [
      { name: 'composition-patch-layer', ok: false, reasons: ['x'] },
      { name: 'a-check-nobody-anticipated', ok: false, reasons: ['没见过的失败'] },
    ],
  })
  assert.equal(plan.items.length, 2, '未知项不能被丢掉')
  const unknown = plan.items.find((i) => i.check === 'a-check-nobody-anticipated')
  assert.equal(unknown.action, 'inspect-manually')
  assert.match(unknown.why, /仍然在阻止执行/, '要说清"没有修法"不等于"不用修"')
})

test('③ 全通过时计划为空且 `ok: true`', () => {
  const plan = repairPlanFor({ checks: [{ name: 'a', ok: true }, { name: 'b', ok: true }] })
  assert.equal(plan.ok, true)
  assert.equal(plan.items.length, 0)
})

test('③ 拒绝结果里**一定带得回修复计划**（否则调用方只能把产品重装一遍）', async () => {
  resetDshRuntimeBinding()
  const r = await boot({ composition: compositionNotApplied() })
  assert.equal(r.ok, false)
  assert.equal(r.repair.ok, false)
  assert.ok(r.repair.items.length > 0, '拒绝时必须带回修复计划')
  assert.ok(r.repair.items.some((i) => i.action === 'reapply-composition-patch'))
})

test('③ `REPAIR_ACTIONS` 覆盖自检的**全部**检查项（新增一项时这条会红）', async () => {
  // 自检的检查项名是 `startupSelfCheck` 的契约。这里用一次"全失败"的自检
  // 拿到全部项名，再要求每一项都有预置修法——
  // 一个新增的检查项如果没有修法，用户看到的就又是一句"没过"。
  resetDshRuntimeBinding()
  const r = await boot({
    composition: compositionNotApplied(),
    runtimeHost: { async probeRuntime() { return { version: 'x', capabilities: {} } } },
    sandbox: {},
  })
  const names = r.checks.map((c) => c.name)
  assert.ok(names.length >= 3, `自检项太少，这一条断言会失去意义：${JSON.stringify(names)}`)
  for (const name of names) {
    assert.ok(REPAIR_ACTIONS[name] !== undefined,
      `自检项 ${name} 没有预置修法：用户看到的又会是一句"没过"`)
  }
  const plan = repairPlanFor({ checks: r.checks })
  assert.equal(plan.ok, false)
  assert.ok(plan.items.every((i) => i.action !== 'inspect-manually'),
    `全部自检项都应当有预置修法：${JSON.stringify(plan.items.map((i) => i.action))}`)
})

// ============================================================================
// ④ 注册口本身给不出假成功
// ============================================================================

test('④ 绕过自检直接调 `bindDshRuntime` 缺 `selfCheck` 会抛（注册口自己挡着）', () => {
  resetDshRuntimeBinding()
  // 装配入口是**正常路径**；注册口自己那道校验是防止有人绕过它。
  assert.throws(() => bindDshRuntime({ host: hostOk(), canRead: () => true }), /selfCheck/)
})
