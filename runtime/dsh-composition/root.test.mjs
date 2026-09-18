// runtime/dsh-composition/root.test.mjs
// ============================================================================
// PRT-214 组合根（`root.mjs`）——**那个缺失的生产调用方**。
//
// ## 这一组守的是什么
//
// `assembleEnforcement()` / `bootstrapDshRuntime()` / `bindDshRuntime()` 三件东西
// 此前**只有用例在调**。后果里最重的一条：worker 的 `executor` 永远是
// `HOST_PORT_REQUIRED`，于是「强制面未生效时禁止自动执行」这条保证
// **从未被行使过**。
//
//   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
//
// 所以这一组最要紧的不是"配置解析对不对"（那几条也都有），而是：
//
//   ① 装配**只发生一次**，两行共用**同一份**桥与**同一本**登记簿
//      ——是身份（`===`），不是形状；
//   ② 组合根拿不到时，行模块**拒绝**，而且**不挂一个空的 listener**；
//   ③ `bind` 真的把 `productionExecutorProvider()` 从 `HOST_PORT_REQUIRED`
//      翻成可用，`unbind` 再翻回去。
//
// ## 测试形状纪律
//
//   · 断言的是**具名码**本身，不是"它抛了"；
//   · 每条"缺席"断言都有**反向对照**（装好之后真的挂上了）——
//     否则"没有 listener"在一个什么都没实现的版本上同样为真；
//   · 端口一律用注入的假件，绝不注册进任何真 `ToolRuntime`；
//   · 假 Context 只实现本套件要观察的那几个口，**不建模 `inject` 的等待语义**
//     （那是 DSH 的契约，由 `enforcement-plugin.test.mjs` 对着真运行时守）。
// ============================================================================

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ENFORCEMENT_CONFIG_FIELDS,
  ENFORCEMENT_ROOT_CODES,
  enforcementInstallation,
  enforcementRoot,
  installEnforcementRoot,
  resetEnforcementRoot,
  resolveEnforcementConfig,
} from './root.mjs'
import { bindingOf } from './assemble.mjs'
import { LEGION_PERMISSION_PRESETS, LEGION_ROW_PREFIX, PATCH_LAYER_ROWS, RUNTIME_ONLY_ROW_IDS } from './patch-layer.mjs'
import { renderPatchReport } from './render.mjs'
import { toPatchDocument } from './patch-format.mjs'
import { BOOTSTRAP_CODES } from './bootstrap.mjs'
import {
  dshRuntimeBound, productionExecutorProvider, resetDshRuntimeBinding,
} from '../../orchestrator/worker/executor-binding.mjs'
import { EXECUTOR_CODES } from '../../orchestrator/worker/executor.mjs'

import preExecuteRow, { PRE_EXECUTE_ROW_CODES } from './plugins/pre-execute-row.mjs'
import approvalAnswererRow, { APPROVAL_ANSWERER_ROW_CODES } from './plugins/approval-answerer-row.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'

const CODES = ENFORCEMENT_ROOT_CODES

/** 一份**完整**的配置。字段不多不少，就是 `REQUIRED_ENFORCEMENT_CONFIG` 那几个。 */
const CONFIG_OK = Object.freeze({
  hubUrl: 'http://hub.invalid:8787',
  actor: 'alice',
  scope: 'space-1',
  action: 'write',
  cwd: CWD,
})

/** 装一次组合根所需的全部显式输入（端口是假件，**不进任何真 ToolRuntime**）。 */
function inputOk(over = {}) {
  return {
    config: { ...CONFIG_OK },
    decide: () => ({ kind: 'allow' }),
    requestApproval: async () => 'rejected',
    ...over,
  }
}

/**
 * 一个**只实现本套件要观察的口**的假 Context。
 *
 * `plugin(p)` 直接把 `p.apply(ctx)` 跑在同一个 ctx 上：这足以回答
 * "这一行到底注册了 listener 没有"。它**不**建模 `inject` 的等待、
 * 也不建模子 fiber 的独立作用域——那两件事是真运行时的契约，
 * 由 `enforcement-plugin.test.mjs` 对着真 DSH 守。
 */
function fakeContext() {
  const listeners = new Map()
  const seen = { on: [], plugins: [] }
  const ctx = {
    logger: { info() {} },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      seen.on.push(event)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    plugin(plugin) {
      seen.plugins.push(plugin)
      plugin.apply(ctx)
      return { dispose() {} }
    },
  }
  return { ctx, listeners, seen }
}

/** 把抛出来的错误取出来（好让"抛的是哪一个码"能被逐字断言，而不是只断言抛了）。 */
function thrownBy(fn) {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

// ---------------------------------------------------------------------------
// 假件：宿主端口 / 组合树观察 / 沙箱 / hub io
// ---------------------------------------------------------------------------

const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

function hostOk() {
  return {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() {
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun() {
      return { result: new Promise(() => {}), dispose: async () => {} }
    },
  }
}

function compositionOk() {
  return {
    rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
    // 运行期行（`pre-execute` / `approval-answerer`）的证据不在组合树里：
    // 它们 `module: null`，永远不会是 loader 条目。见 `patch-layer.mjs` 对账那一节。
    inProcessMounted: [...RUNTIME_ONLY_ROW_IDS],
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

const hubIo = Object.freeze({
  async post() { return { status: 200, body: {} } },
  async get() { return { status: 200, body: {} } },
})

const envOf = (over = {}) => ({
  TEAM_HUB_URL: CONFIG_OK.hubUrl,
  LEGION_ACTOR: CONFIG_OK.actor,
  LEGION_SCOPE: CONFIG_OK.scope,
  LEGION_ENFORCEMENT_ACTION: CONFIG_OK.action,
  LEGION_CWD: CONFIG_OK.cwd,
  ...over,
})

afterEach(() => {
  resetEnforcementRoot()
  resetDshRuntimeBinding()
})

// ===========================================================================
// ① 配置：没给来源 / 配了个空 / 配坏了 —— 三个不同的码
// ===========================================================================

test('★ 配置：没给来源 / 配了个空 / 配坏了 是**三个不同的码**', () => {
  const missing = resolveEnforcementConfig({})
  const empty = resolveEnforcementConfig({ env: {} })
  const unreadable = resolveEnforcementConfig({ config: '{"hubUrl": ' })

  assert.equal(missing.code, CODES.CONFIG_MISSING)
  assert.equal(empty.code, CODES.CONFIG_EMPTY)
  assert.equal(unreadable.code, CODES.CONFIG_UNREADABLE)

  // ★ 三者必须互不相同：合成一个码，一份**解析失败**的配置会长成一份
  //   **从未被设置**的配置，而两者的修法完全不同。
  assert.equal(new Set([missing.code, empty.code, unreadable.code]).size, 3)
})

test('配置：读不出来的几种形状都归 `UNREADABLE`（且不等于 EMPTY / MISSING）', () => {
  const cases = [
    ['config 是数字', { config: 42 }],
    ['config 是数组', { config: [1, 2] }],
    ['config 是布尔', { config: true }],
    ['config 文本解析成数组', { config: '[]' }],
    ['env 不是对象', { env: 'TEAM_HUB_URL=x' }],
    ['env 是数组', { env: [] }],
  ]
  for (const [what, input] of cases) {
    const got = resolveEnforcementConfig(input)
    assert.equal(got.code, CODES.CONFIG_UNREADABLE, `${what} 的码是 ${got.code}`)
    assert.notEqual(got.code, CODES.CONFIG_EMPTY)
    assert.notEqual(got.code, CODES.CONFIG_MISSING)
  }
})

test('配置：空白字符串是"配了个空"，不是"读坏了"也不是"没配"', () => {
  assert.equal(resolveEnforcementConfig({ config: '' }).code, CODES.CONFIG_EMPTY)
  assert.equal(resolveEnforcementConfig({ config: '   ' }).code, CODES.CONFIG_EMPTY)
  assert.equal(resolveEnforcementConfig({ config: '{}' }).code, CODES.CONFIG_EMPTY)
})

// ===========================================================================
// ② 不造身份、不造 hub 地址、不补其余字段
// ===========================================================================

test('★★ 配置：绝不造默认 hub 地址 / actor（缺哪个报哪个，**不补**其余）', () => {
  const noHub = resolveEnforcementConfig({ env: envOf({ TEAM_HUB_URL: undefined }) })
  assert.equal(noHub.code, CODES.NO_HUB_URL)

  const noActor = resolveEnforcementConfig({
    config: { hubUrl: CONFIG_OK.hubUrl, scope: 's', action: 'w', cwd: CWD },
  })
  assert.equal(noActor.code, CODES.NO_ACTOR)

  // 逐个字段：只缺一个时，报的必须是**它自己**的码，且 missing 只有它。
  const cases = [
    ['hubUrl', CODES.NO_HUB_URL],
    ['actor', CODES.NO_ACTOR],
    ['scope', CODES.NO_SCOPE],
    ['action', CODES.NO_ACTION],
    ['cwd', CODES.NO_CWD],
  ]
  for (const [field, code] of cases) {
    const cfg = { ...CONFIG_OK }
    delete cfg[field]
    const got = resolveEnforcementConfig({ config: cfg })
    assert.equal(got.ok, false, `缺 ${field} 竟然解析成功了`)
    assert.equal(got.code, code, `缺 ${field} 时报的是 ${got.code}`)
    assert.deepEqual(got.missing, [field])
  }
})

test('★★ 配置：只填了一部分 —— 报第一个缺的，且拒绝时**不给**一份补过默认值的 values', () => {
  const partial = resolveEnforcementConfig({
    config: { hubUrl: CONFIG_OK.hubUrl, actor: CONFIG_OK.actor },
  })
  assert.equal(partial.ok, false)
  assert.equal(partial.code, CODES.NO_SCOPE)
  assert.deepEqual(partial.missing, ['scope', 'action', 'cwd'])
  // ★ 这一条是"不补其余"的机械判据：拒绝的返回里**根本没有** values，
  //   所以不可能存在一份"hub/actor 有了、其余是编的"的半成品。
  assert.equal(partial.values, undefined, '拒绝时返回了 values —— 那里面只可能塞着编出来的默认值')
})

test('配置：全给齐时必须真的成功，且取的就是给的（没给的 token / taskId 保持 null）', () => {
  const ok = resolveEnforcementConfig({ config: { ...CONFIG_OK } })
  assert.equal(ok.ok, true)
  assert.equal(ok.values.hubUrl, CONFIG_OK.hubUrl)
  assert.equal(ok.values.actor, CONFIG_OK.actor)
  assert.equal(ok.values.hubToken, null, '没给 token 就必须是 null，不能编一个')
  assert.equal(ok.values.taskId, null)
  assert.equal(ok.sources.actor, 'config')

  // env 与 config 混用时，逐字段记录**来源**，config 优先。
  const mixed = resolveEnforcementConfig({
    env: envOf({ LEGION_ACTOR: 'from-env' }),
    config: { hubUrl: CONFIG_OK.hubUrl, scope: 's', action: 'w', cwd: CWD },
  })
  assert.equal(mixed.ok, true)
  assert.equal(mixed.values.actor, 'from-env')
  assert.equal(mixed.sources.actor, 'env')
  assert.equal(mixed.sources.hubUrl, 'config')
})

// ===========================================================================
// ③ 单例：只装一次，两行共用同一份桥与同一本登记簿（身份）
// ===========================================================================

test('★★★ 组合根只装一次：两行拿到的是**同一个**桥对象与**同一本**登记簿（身份，不是形状）', () => {
  const decidePort = () => ({ kind: 'allow' })
  const approvalPort = async () => 'rejected'
  const first = installEnforcementRoot(inputOk({ decide: decidePort, requestApproval: approvalPort }))
  assert.equal(first.ok, true, JSON.stringify(first))
  const root = first.root

  const pre = bindingOf(root.rows.preExecute)
  const ans = bindingOf(root.rows.approvalAnswerer)
  assert.notEqual(pre, null, 'bindingOf 拿不到 pre-execute 行的绑定——那这条断言什么都没验')
  assert.notEqual(ans, null, 'bindingOf 拿不到 answerer 行的绑定——那这条断言什么都没验')

  // ★ 身份。两份各自 createInFlightRegistry() 出来的登记簿有一模一样的形状，
  //   所以形状断言在这里**恒真**，什么都证明不了。
  //   而这里读的是**行自己报出来的**实际绑定（不可枚举属性），
  //   不是装配方记下的传参——后者在"真的传了两本"时照样绿。
  assert.equal(pre.registry, ans.registry, '两行看到的不是同一本登记簿')
  assert.equal(pre.registry, root.registry)

  // 桥与端口的身份也要钉住，但要说清**非对称**：
  //   · 两行共用的会合点是**登记簿**；
  //   · `pre-execute` 拿到的是桥，`approval-answerer` 拿到的是审批端口
  //     （它不需要桥——投影是 pre-execute 写进登记簿的）。
  //   所以"同一个桥"只能对 pre-execute 断言，对 answerer 断言的是端口身份。
  assert.equal(root.rows.preExecute.bridge, root.bridge)
  assert.equal(root.rows.approvalAnswerer.port, approvalPort,
    'answerer 拿到的不是调用方注入的那个审批端口')
  assert.equal(root.rows.approvalAnswerer.bridge, undefined, 'answerer 不该拿到桥；它靠登记簿取投影')

  // 两行仍然是两行（不是同一个对象被复用了两次）。
  assert.notEqual(root.rows.preExecute, root.rows.approvalAnswerer)

  // 诊断属性必须**不可枚举**：它们是活对象，不能被序列化带出去。
  assert.deepEqual(Object.keys(root.rows.preExecute), ['name', 'inject', 'apply'])
  assert.equal(JSON.stringify(root.rows.preExecute).includes('registry'), false,
    '诊断属性是可枚举的 —— 它会被 JSON.stringify 带出去')

  // 第二次装：**不重建**，返回同一个 root，并说清这次参数没被用上。
  const second = installEnforcementRoot(inputOk({ config: { ...CONFIG_OK, actor: 'bob' } }))
  assert.equal(second.ok, false)
  assert.equal(second.code, CODES.ALREADY_INSTALLED)
  assert.equal(second.root, root)
  assert.equal(enforcementRoot(), root)
  assert.equal(enforcementInstallation().root, root)
})

test('★ 反向对照：重置之后重装得到**另一份** —— 证明"单例"不是模块级常量', () => {
  const first = installEnforcementRoot(inputOk())
  resetEnforcementRoot()
  const second = installEnforcementRoot(inputOk())
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.notEqual(second.root, first.root)
  assert.notEqual(second.root.registry, first.root.registry)
})

test('组合根：装了但拒绝之后**允许重试**（失败不留在单例里）', () => {
  const refused = installEnforcementRoot({ env: {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, CODES.CONFIG_EMPTY)
  assert.equal(enforcementRoot(), null)

  const ok = installEnforcementRoot(inputOk())
  assert.equal(ok.ok, true)
  assert.equal(enforcementRoot(), ok.root)
})

// ===========================================================================
// ④ 行模块：组合根拿不到时**拒绝**，且不挂一个空的 listener
// ===========================================================================

test('★★★ 组合根从没装过：两行都拒绝（具名码），且**不注册任何 listener**', () => {
  resetEnforcementRoot()

  const pre = fakeContext()
  const preErr = thrownBy(() => preExecuteRow.apply(pre.ctx))
  assert.equal(preErr?.code, PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT)
  // ★ 断言的是**坏行为不在**，不只是"它抛了"：
  //   一个"抛之前先挂个空 listener"的实现同样是抛，而它更坏。
  assert.deepEqual(pre.seen.on, [], '拒绝时不该注册任何事件监听')
  assert.equal(pre.listeners.has('tools/pre-execute'), false, '拒绝时不该留下一个什么都不做的 listener')
  assert.deepEqual(pre.seen.plugins, [], '拒绝时不该挂任何子行')

  const ans = fakeContext()
  const ansErr = thrownBy(() => approvalAnswererRow.apply(ans.ctx))
  assert.equal(ansErr?.code, APPROVAL_ANSWERER_ROW_CODES.NO_COMPOSITION_ROOT)
  assert.deepEqual(ans.seen.on, [])
  assert.equal(ans.listeners.has('approval/request'), false)
  assert.deepEqual(ans.seen.plugins, [])
})

test('★★ 组合根**装过但被拒绝**：报的是另一个码，且把真因透传出来（不吞）', () => {
  const refused = installEnforcementRoot({ env: {} })
  assert.equal(refused.code, CODES.CONFIG_EMPTY)

  const pre = fakeContext()
  const err = thrownBy(() => preExecuteRow.apply(pre.ctx))
  assert.equal(err?.code, PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED)
  // 真因没有被吞掉：底层码在消息里。
  assert.match(err.message, /ENFORCEMENT_ROOT_CONFIG_EMPTY/)
  assert.deepEqual(pre.seen.plugins, [])
  assert.deepEqual(pre.seen.on, [])

  // "从没装过"与"装了但拒绝"必须是**两个**码：一个要去找安装点，一个要去看配置。
  assert.notEqual(
    PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT,
    PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED,
  )
  assert.notEqual(
    APPROVAL_ANSWERER_ROW_CODES.NO_COMPOSITION_ROOT,
    APPROVAL_ANSWERER_ROW_CODES.COMPOSITION_ROOT_REFUSED,
  )
})

test('★★ 组合根被拒绝的**每一种**理由都能透传到行模块（缺端口 / 坏 JSON 各有其码）', () => {
  const cases = [
    ['缺 decide 端口', inputOk({ decide: null }), CODES.NO_DECIDE_PORT],
    ['缺审批端口', inputOk({ requestApproval: null }), CODES.NO_APPROVAL_PORT],
    ['配置读不出来', { config: '{oops', decide: () => ({ kind: 'allow' }), requestApproval: async () => 'rejected' }, CODES.CONFIG_UNREADABLE],
    ['配置缺 actor', { config: { ...CONFIG_OK, actor: undefined }, decide: () => ({ kind: 'allow' }), requestApproval: async () => 'rejected' }, CODES.NO_ACTOR],
  ]
  for (const [what, input, expected] of cases) {
    resetEnforcementRoot()
    const inst = installEnforcementRoot(input)
    assert.equal(inst.ok, false, `${what} 竟然装成功了`)
    assert.equal(inst.code, expected, `${what} 的码是 ${inst.code}`)

    const ans = fakeContext()
    const err = thrownBy(() => approvalAnswererRow.apply(ans.ctx))
    assert.equal(err?.code, APPROVAL_ANSWERER_ROW_CODES.COMPOSITION_ROOT_REFUSED)
    assert.match(err.message, new RegExp(expected), `${what} 的底层码没有出现在消息里`)
    assert.deepEqual(ans.seen.on, [], `${what}：拒绝时注册了监听`)
  }
})

test('★★★ 反向对照：组合根装好时，两行**真的**把组合根里那一行挂了上来', () => {
  const installed = installEnforcementRoot(inputOk())
  assert.equal(installed.ok, true)
  const root = installed.root

  const pre = fakeContext()
  preExecuteRow.apply(pre.ctx)
  assert.equal(pre.seen.plugins.length, 1)
  // ★ 身份：挂上来的必须**就是**组合根那一行（同一份桥、同一本登记簿），
  //   不是"一个长得一样的行"。
  assert.equal(pre.seen.plugins[0], root.rows.preExecute)
  assert.equal(pre.listeners.get('tools/pre-execute')?.length, 1, '装好了却没有挂上策略门')

  const ans = fakeContext()
  approvalAnswererRow.apply(ans.ctx)
  assert.equal(ans.seen.plugins.length, 1)
  assert.equal(ans.seen.plugins[0], root.rows.approvalAnswerer)
  assert.equal(ans.listeners.get('approval/request')?.length, 1, '装好了却没有加入 answerer 链')
})

// ===========================================================================
// ⑤ 端口：只能注入；工厂拿到的是**解析出来的**配置
// ===========================================================================

test('端口：缺 `decide` / 缺 `requestApproval` 各有其码，互不相同', () => {
  const noDecide = installEnforcementRoot(inputOk({ decide: null }))
  assert.equal(noDecide.ok, false)
  assert.equal(noDecide.code, CODES.NO_DECIDE_PORT)

  resetEnforcementRoot()
  const noPort = installEnforcementRoot(inputOk({ requestApproval: null }))
  assert.equal(noPort.ok, false)
  assert.equal(noPort.code, CODES.NO_APPROVAL_PORT)

  assert.notEqual(noDecide.code, noPort.code)
})

test('端口工厂拿到的是**解析出来的**配置：hub 地址是被用的，不是编的', () => {
  let seen = null
  const inst = installEnforcementRoot({
    config: { ...CONFIG_OK, hubToken: 'tok-1' },
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: (values) => {
      seen = values
      return async () => 'rejected'
    },
  })
  assert.equal(inst.ok, true, JSON.stringify(inst))
  assert.equal(seen.hubUrl, CONFIG_OK.hubUrl)
  assert.equal(seen.hubToken, 'tok-1')
  assert.equal(seen.actor, CONFIG_OK.actor)
  assert.equal(seen.scope, CONFIG_OK.scope)
})

test('端口工厂返回非函数 → `BAD_WIRING`（不静默变成一个永远放行的端口）', () => {
  const inst = installEnforcementRoot({
    config: { ...CONFIG_OK },
    decide: () => ({ kind: 'allow' }),
    createRequestApproval: () => null,
  })
  assert.equal(inst.ok, false)
  assert.equal(inst.code, CODES.BAD_WIRING)
})

// ===========================================================================
// ⑥ 绑定：`bind` 真的翻转 `productionExecutorProvider()`（生产调用方证明）
// ===========================================================================

test('★★★ `root.bind` 把 provider 从 `HOST_PORT_REQUIRED` 翻成可用；`unbind` 翻回去（且幂等）', async () => {
  const installed = installEnforcementRoot(inputOk())
  const root = installed.root

  const before = await productionExecutorProvider({ ...hubIo, env: { LEGION_BUDGET_ACTOR: 'w-1' } })
  assert.equal(before.ok, false)
  assert.equal(before.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)

  const unbind = root.bind({
    host: hostOk(),
    selfCheck: async () => ({ state: 'effective', autoExecutionForbidden: false, checks: [] }),
    canRead: () => true,
  })
  assert.equal(dshRuntimeBound(), true)

  const bound = await productionExecutorProvider({ ...hubIo, env: { LEGION_BUDGET_ACTOR: 'w-1' } })
  assert.equal(bound.ok, true, `绑定之后仍拿不到引擎：${bound.code} ${bound.message}`)
  assert.equal(typeof bound.executor?.execute, 'function')

  // 幂等注销：拆两次不报错，且"已经拆掉"这个事实不变。
  unbind()
  unbind()
  assert.equal(dshRuntimeBound(), false)
  const after = await productionExecutorProvider({ ...hubIo, env: { LEGION_BUDGET_ACTOR: 'w-1' } })
  assert.equal(after.ok, false)
  assert.equal(after.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
})

test('★★ `bind` 缺 `selfCheck` 当场抛（**不补一个"自检通过"的默认值**），且不注册', () => {
  const root = installEnforcementRoot(inputOk()).root
  const err = thrownBy(() => root.bind({ host: hostOk(), canRead: () => true }))
  assert.equal(err?.constructor, TypeError)
  assert.match(err.message, /selfCheck/)
  assert.equal(dshRuntimeBound(), false, '抛了却仍然注册上了')
})

// ===========================================================================
// ⑦ bootstrap：`canRead` 可选（缺席如实记成 null），"挂了个坏的"仍然 fail closed
// ===========================================================================

test('★★ `root.bootstrap` 的 `canRead` 缺席**合法**（如实记成 null）；给了个不是函数的 → `BAD_WIRING`，且什么都不注册', async () => {
  resetDshRuntimeBinding()
  const root = installEnforcementRoot(inputOk()).root
  const absent = await root.bootstrap({
    runtimeHost: hostOk(),
    composition: compositionOk(),
    sandbox: sandboxOk(),
  })
  assert.equal(absent.ok, true, `canRead 缺席不该拦下装配：${JSON.stringify(absent).slice(0, 300)}`)
  assert.equal(dshRuntimeBound(), true)
  absent.unbind?.()

  const bad = await root.bootstrap({
    runtimeHost: hostOk(),
    composition: compositionOk(),
    sandbox: sandboxOk(),
    canRead: 'yes',
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, BOOTSTRAP_CODES.BAD_WIRING)
  assert.equal(dshRuntimeBound(), false, '自检入口拒绝了，端口却已经注册上了')
  resetDshRuntimeBinding()
})

test('★★ `root.bootstrap` 给齐输入 → 注册成功；它返回的 `unbind` 真的能拆掉', async () => {
  const root = installEnforcementRoot(inputOk()).root
  const r = await root.bootstrap({
    runtimeHost: hostOk(),
    composition: compositionOk(),
    sandbox: sandboxOk(),
    canRead: () => true,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(dshRuntimeBound(), true)

  const provision = await productionExecutorProvider({ ...hubIo, env: { LEGION_BUDGET_ACTOR: 'w-1' } })
  assert.equal(provision.ok, true, `自检通过之后仍拿不到引擎：${provision.code}`)

  r.unbind()
  assert.equal(dshRuntimeBound(), false)
})

test('★★ `bindingOf` 对陌生对象返回 `null`，且**不伪造**缺失的那一侧', () => {
  // 反向对照：如果它对任何对象都编一份 `{bridge, registry}`，
  // 那么"两行共用同一本"这条断言就可以在一个**没有装配**的实现上为真。
  assert.equal(bindingOf({ name: 'x', apply() {} }), null)
  assert.equal(bindingOf(null), null)
  assert.equal(bindingOf(undefined), null)
  assert.equal(bindingOf('not-an-object'), null)

  // 只有一侧有诊断时：把**实际有的那一侧**如实报出来，缺的那一侧是 `null`，
  // **不能**补一个看起来能用的登记簿上去。
  //
  // 这一条不是假想的：`rows.approvalAnswerer` 的合法形状**就是**
  // `{bridge: null, registry}` —— 它不需要桥（投影由 pre-execute 写进登记簿）。
  // 所以"两个都必须是对象"这种断言会把一个正确的装配判红。
  const onlyRegistry = { peek() {} }
  assert.deepEqual(bindingOf({ registry: onlyRegistry }), { bridge: null, registry: onlyRegistry })
  const onlyBridge = { preExecute() {} }
  assert.deepEqual(bindingOf({ bridge: onlyBridge }), { bridge: onlyBridge, registry: null })
})

test('★★ Context 形状不对：两行报的是 `NO_CONTEXT`（**不是**"找不到组合根"）', () => {
  // 修法完全不同：一个是"挂错了地方"，一个是"没装配"。
  // 合成一个码会让"把这一行挂到了别的宿主上"被读成"配置没接上"。
  const preErr = thrownBy(() => preExecuteRow.apply({ logger: {} }))
  assert.equal(preErr?.code, PRE_EXECUTE_ROW_CODES.NO_CONTEXT)

  const ansErr = thrownBy(() => approvalAnswererRow.apply(null))
  assert.equal(ansErr?.code, APPROVAL_ANSWERER_ROW_CODES.NO_CONTEXT)

  assert.notEqual(PRE_EXECUTE_ROW_CODES.NO_CONTEXT, PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT)
  assert.notEqual(APPROVAL_ANSWERER_ROW_CODES.NO_CONTEXT, APPROVAL_ANSWERER_ROW_CODES.NO_COMPOSITION_ROOT)
})

test('★ 两行的码表**没有一个是共用的值**：复制粘贴出来的同码会丢掉"是哪一行"', () => {
  const pre = Object.values(PRE_EXECUTE_ROW_CODES)
  const ans = Object.values(APPROVAL_ANSWERER_ROW_CODES)
  assert.equal(pre.length, 4)
  assert.equal(ans.length, 4)
  const overlap = pre.filter((c) => ans.includes(c))
  assert.deepEqual(overlap, [], `两行共用了码 ${overlap.join(', ')}——排障时看不出是哪一行`)
  // 每一行的码必须是具名的两段式常量，而不是空串或 undefined。
  for (const c of [...pre, ...ans]) {
    assert.match(c, /^(PRE_EXECUTE|APPROVAL_ANSWERER)_ROW_[A-Z_]+$/)
  }
})

test('★ `resetEnforcementRoot()` 之后诊断口如实说"从没装过"', () => {
  installEnforcementRoot(inputOk())
  assert.notEqual(enforcementInstallation(), null)
  assert.notEqual(enforcementRoot(), null)

  resetEnforcementRoot()
  assert.equal(enforcementInstallation(), null, '重置之后仍报"装过"——行模块会报错的码')
  assert.equal(enforcementRoot(), null)

  // 而且此时行模块报的必须是 NO_COMPOSITION_ROOT（而不是 REFUSED）。
  const pre = fakeContext()
  const err = thrownBy(() => preExecuteRow.apply(pre.ctx))
  assert.equal(err?.code, PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT)
})

test('★★★ 本模块会读的 env 键名是**一个被钉住的闭集**（加第六个就会报红）', () => {
  // ⚠️ 诚实边界：`runtime/` **不是** `scripts/config/scan.mjs` 登记的进程目录
  //   （`SCHEMA_FILES` 里只有 team-hub / workbench / whiteboard / plugins /
  //   board-plugin / services-plugin / product / orchestrator），
  //   所以 `scan --check` **看不见**这几个键名——它不会因为这里多一个键而报红。
  //
  //   本仓库的硬规矩是"每一个新的 SCREAMING_SNAKE_CASE 字面量都要在所属进程的
  //   config-schema.mjs 里声明"，而 `runtime/` **没有**所属 schema 可声明。
  //   在把 `runtime` 登记进 `SCHEMA_FILES`（那是另一件事）之前，
  //   这一条用例是**唯一**会拦住"悄悄多读一个环境变量"的判据。
  //
  //   > 一个没有机器判据的规矩，与一条不存在的规矩，
  //   > 在"它到底拦住了什么"上是同一个东西。
  const envKeys = Object.values(ENFORCEMENT_CONFIG_FIELDS)
    .flatMap((spec) => [...spec.envKeys])
    .sort()
  assert.deepEqual(envKeys, [
    // ★ 三个是**本批次新引入**的，没有任何既有权威来源；
    //   它们集中在一处（`ENFORCEMENT_CONFIG_FIELDS`），改名只动那一处。
    'LEGION_ACTOR',
    'LEGION_CWD',
    'LEGION_ENFORCEMENT_ACTION',
    'LEGION_SCOPE',
    'LEGION_TASK_ID',
    // 这两个是仓库**既有**约定（`orchestrator/worker/run.mjs` 的 WORKER_ENV），
    // 且已在 `orchestrator/config-schema.mjs` 的 ENV_NAMES 里声明。
    'TEAM_HUB_TOKEN',
    'TEAM_HUB_URL',
  ])
})

// ===========================================================================
// ⑨ 补丁层：两种"造不出来"必须不同形，且 runtimeModule 真的存在
// ===========================================================================

test('★★ 补丁层：两行 `module` 仍是 null，但 `runtimeModule` 指向**真实存在**的模块', () => {
  const pre = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}pre-execute`)
  const ans = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}approval-answerer`)
  assert.notEqual(pre, undefined)
  assert.notEqual(ans, undefined)

  for (const row of [pre, ans]) {
    // `module` 不能声称一个"加载时就炸"的静态模块（见 patch-layer.mjs 的 runtimeModule 一段）。
    assert.equal(row.module, null, `${row.id} 竟然声明了静态模块`)
    assert.equal(typeof row.runtimeModule, 'string')
    const abs = resolve(HERE, row.runtimeModule)
    assert.ok(existsSync(abs), `${row.id} 的 runtimeModule ${row.runtimeModule} 解析到 ${abs}，而它不存在`)
  }

  // 静态文档里**不能**有这两行：它们装不了。
  const report = renderPatchReport()
  assert.equal(report.renderedRowIds.includes(pre.id), false, '装不了的行进了静态文档')
  assert.equal(report.renderedRowIds.includes(ans.id), false)
  assert.equal(report.renderedRowIds.includes(`${LEGION_ROW_PREFIX}hard-floor`), true)
})

test('★★ 报告：模块"不存在"与"存在但静态层装不了"是两种不同的读数', () => {
  const report = renderPatchReport()
  const byId = Object.fromEntries(report.unbuildable.map((u) => [u.id, u]))

  assert.equal(byId[`${LEGION_ROW_PREFIX}pre-execute`].moduleState, 'runtime-only')
  assert.equal(byId[`${LEGION_ROW_PREFIX}pre-execute`].runtimeModule, './plugins/pre-execute-row.mjs')
  assert.equal(byId[`${LEGION_ROW_PREFIX}approval-answerer`].moduleState, 'runtime-only')
  assert.equal(byId[`${LEGION_ROW_PREFIX}approval-answerer`].runtimeModule, './plugins/approval-answerer-row.mjs')

  // runtimeOnly 单列一份：读的人不必从 detail 散文里猜。
  assert.deepEqual(
    report.runtimeOnly.map((r) => r.id).sort(),
    [`${LEGION_ROW_PREFIX}approval-answerer`, `${LEGION_ROW_PREFIX}pre-execute`].sort(),
  )

  // 反向：一个"模块真的不存在"的行仍然是 `absent`，而且两者**不同**。
  const absent = toPatchDocument({
    rows: [{ id: 'legion-enforcement-nope', mount: { anchor: 'insert' }, module: null }],
  }).unbuildable
  assert.equal(absent.length, 1)
  assert.equal(absent[0].moduleState, 'absent')
  assert.equal(absent[0].runtimeModule, null)
  assert.notEqual(absent[0].moduleState, byId[`${LEGION_ROW_PREFIX}pre-execute`].moduleState)

  // 这一层仍然**不完整**：那两行确实还没进文档。
  assert.equal(report.complete, false)
})

// ===========================================================================
// ⑨ ★★★ F-21 连接器那一半：**两半一起上，或者两半都不上**
//
// 这一组存在的原因是 §10 量出来的那件事：`registry.mjs` 的 `decide()` 读熔断器，
// 而改它的 `recordOutcome()` 生产调用方是 0 处。于是"只接判定面"得到的是
// **一个永远合闸、且一行错都不报**的熔断器。
//
//   > 一个"接了连接器判定、但反馈面没装"的强制面，
//   > 与一个"连接器从来不会因为失败而被拦下"的强制面，是同一个东西——
//   > 只不过前者的组合树看起来是接好的。
//
// 所以 ⑨① 断言的是**结构**（一个不给另一个 ⇒ 抛具名码），
// ⑨② 断言的是**读数**（装齐之后 `connectorFeedback` 真的翻成 true），
// ⑨③ 是**端到端**的：真挂上、真跑一次失败、熔断器真的开路。
// ===========================================================================

/** 一条最小的连接器声明（只含执行面会读的字段）。 */
const CONNECTOR_DECL = Object.freeze({
  connectorId: 'github',
  transport: 'stdio',
  command: 'npx mcp-github',
  policy: 'allow',
  tools: Object.freeze([Object.freeze({ name: 'list_issues', capabilities: Object.freeze(['repo:read']) })]),
  secretRefs: Object.freeze([]),
})

test('⑨① ★★★ `connectorDeclarations` 与 `resolveConnectorId` **必须成对**给（否则抛具名码）', () => {
  // 只给 declarations ⇒ 装出一个永远合闸的熔断器。必须**响亮地拒绝**。
  // ★ 组合根把装配期错误**包**成 `ASSEMBLY_FAILED`（那是它的记账口径：它
  //   记的是"装失败了"，真因透传在 `reasons[0]`）。所以这里断的是**两层**——
  //   只断外层会让"为什么失败"变成不可区分，只断内层则绕过了组合根的记账。
  const wrapped = (r) => {
    assert.equal(r.ok, false, '竟然装成功了——那正是"永远合闸的熔断器"')
    assert.equal(r.code, 'ENFORCEMENT_ROOT_ASSEMBLY_FAILED')
    return r.reasons[0]
  }

  const onlyDecl = installEnforcementRoot(inputOk({
    connectorDeclarations: [CONNECTOR_DECL], resolveConnectorId: null,
  }))
  assert.equal(wrapped(onlyDecl), 'ASSEMBLE_NO_CONNECTOR_RESOLVER',
    '只给 declarations 必须被拒（它正是"永远合闸的熔断器"）')

  resetEnforcementRoot()
  // 只给 resolver ⇒ 没有任何连接器可记。
  const onlyRes = installEnforcementRoot(inputOk({
    connectorDeclarations: null, resolveConnectorId: () => 'github',
  }))
  assert.equal(wrapped(onlyRes), 'ASSEMBLE_NO_CONNECTOR_RESOLVER')

  resetEnforcementRoot()
  // 给了个不是函数的 resolver ⇒ 同上（不静默当成"没给"）。
  const badFn = installEnforcementRoot(inputOk({
    connectorDeclarations: [CONNECTOR_DECL], resolveConnectorId: 'github',
  }))
  assert.equal(wrapped(badFn), 'ASSEMBLE_NO_CONNECTOR_RESOLVER')

  resetEnforcementRoot()
  // ★ 反向对照：**两个都不给**是合法的（就是本批之前的行为），
  //   而且读数如实报 false。少了这一条，上面三条无法区分
  //   "成对校验在工作"与"这个参数根本装不上"。
  const neither = installEnforcementRoot(inputOk())
  assert.equal(neither.ok, true, JSON.stringify(neither))
  assert.equal(neither.root.enforcementSurfaces().connectorFeedback, false,
    '没给连接器 ⇒ 反馈面读数必须是 false（"没装"要看得见）')
  assert.equal(neither.root.rows.connectorFeedback, null, '没给连接器 ⇒ 不该造出一个空行')

  resetEnforcementRoot()
  // ★★ 成对给了 ⇒ 装得起来，且两半**都在**。
  const both = installEnforcementRoot(inputOk({
    connectorDeclarations: [CONNECTOR_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(both.ok, true, JSON.stringify(both))
  assert.equal(both.root.enforcementSurfaces().connectorFeedback, true,
    '装齐了两半，反馈面读数却是 false')
  assert.notEqual(both.root.rows.connectorFeedback, null, '装齐了两半，却没有那一行')
  resetEnforcementRoot()
})

test('⑨② ★★ 反馈面那一行**真的**被 mount 挂上，并且订阅的是 `tools/result`', async () => {
  const installed = installEnforcementRoot(inputOk({
    connectorDeclarations: [CONNECTOR_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const root = installed.root

  const fake = fakeContext()
  await root.mount(fake.ctx)

  // ★ 身份：挂上来的必须**就是**组合根那一行。
  assert.equal(fake.seen.plugins.includes(root.rows.connectorFeedback), true,
    'mount 没有把反馈面那一行挂上')
  assert.equal(fake.listeners.get('tools/result')?.length, 1, '挂上了却没有订阅 tools/result')
  assert.equal(fake.listeners.get('tools/pre-execute')?.length, 1, '判定面照旧（两半都在）')

  // ★ 挂载账要**同时**包含三行——两半都在场这件事，在这里也要读得出来。
  // ★ 组合根上的读法叫 `mountedEnforcementRows()`（不是 assemble 内部的
  //   `mountedRowNames()`——那个在 root 上不暴露）。
  const names = root.mountedEnforcementRows()
  assert.equal(names.includes(root.rows.connectorFeedback.name), true,
    `挂载账里没有反馈行：${JSON.stringify(names)}`)
  assert.equal(names.includes(root.rows.preExecute.name), true)

  // 反向对照：没给连接器时，**不许**挂那一行、也不许订阅。
  resetEnforcementRoot()
  const bare = installEnforcementRoot(inputOk())
  assert.equal(bare.ok, true)
  const bareFake = fakeContext()
  await bare.root.mount(bareFake.ctx)
  assert.equal(bareFake.listeners.get('tools/result'), undefined,
    '没给连接器却订阅了 tools/result —— 那是一个"挂了但什么都不记"的空行')
  assert.equal(bare.root.mountedEnforcementRows().includes('legion-enforcement-connector-feedback'), false)
  resetEnforcementRoot()
})

test('⑨③ ★★★ 端到端：挂上之后，连续失败的**真结果**会让熔断器开路（这就是接线在干什么）', async () => {
  const installed = installEnforcementRoot(inputOk({
    connectorDeclarations: [CONNECTOR_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const root = installed.root
  const fake = fakeContext()
  await root.mount(fake.ctx)

  const fire = fake.listeners.get('tools/result')[0]

  // ★ 先钉住前提：**在收结果之前**，熔断器是合闸的（否则下面那三条绿不了
  //   也不能说明是反馈起了作用）。
  const listenerOfRoot = root.rows.connectorFeedback.listener
  assert.equal(listenerOfRoot.receipts().recorded, 0, '前提：还没有任何结果被记过')

  // 喂进真正的 DSH 形状（`ToolExecutionResult`：判别子是必填字面量 `isError`）。
  for (let i = 0; i < 3; i += 1) {
    fire({ name: 'list_issues', callId: `c${i}` }, { isError: true, error: { message: 'refused' }, content: [] })
  }
  assert.equal(listenerOfRoot.receipts().failed, 3, '三次失败没有被记上——反馈面是空的')
  assert.equal(listenerOfRoot.receipts().recorded, 3)

  // 而登记的**效果**必须能从那半边的读数里看出来。
  //   ⚠️ 这里不直接读 `decide()`——那需要连接器 id 的解析器与登记表在
  //      `root` 上的引用，而 `root` 只暴露 `rows`/`bridge`。
  //      所以这一条断的是"反馈真的被记进了那一本账"，
  //      而"记进去之后 decide() 会 deny"由 `outcome-port.test.mjs` ① 端到端钉住。
  //      两条合起来才是完整的一条链，任一条单独都不够。
  const okFire = fake.listeners.get('tools/result')[0]
  okFire({ name: 'list_issues', callId: 'c9' }, { isError: false, value: {}, content: [] })
  assert.equal(listenerOfRoot.receipts().ok, 1, '成功结果没有被记上')
  assert.equal(listenerOfRoot.receipts().failed, 3, '成功不许清掉失败计数（那是 registry 的事，不是计数器的）')

  // ★ 读不懂的输入**一条都不记**（第三个桶），而且要在计数里分得开。
  okFire({ name: 'list_issues', callId: 'c10' }, { isError: undefined })
  assert.equal(listenerOfRoot.receipts().unclassifiable, 1)
  assert.equal(listenerOfRoot.receipts().recorded, 4, '读不懂的输入不许被记进熔断器')
  resetEnforcementRoot()
})

// ---------------------------------------------------------------------------
// ⑨ ★★★ F-21 **判定面**那一半（2026-09-18 加）
//
//   上面 ⑨①～⑨③ 建起了**反馈**那一半。这一组建起**判定**那一半，
//   并证明两半终于在**同一份 registry** 上接成一条环。
//
//   ★ 夹具必须用 `tool-capability.mjs` **认识**的工具名（下面 `JUDGE_DECL` 用
//     `git-status`）。用不认识的名字时**投影这一步**就失败了
//     （`tool-request-target-missing`），根本走不到连接器判定——
//     我第一版就写了 `list_issues`，于是"拒绝"读起来像判定面在起作用，
//     其实是**投影失败**。那是本批第二个"看起来在工作"。
// ---------------------------------------------------------------------------

/** 判定面用的声明：工具名是执行面**认识**的那一个。 */
const JUDGE_DECL = Object.freeze({
  connectorId: 'github',
  transport: 'stdio',
  command: 'npx mcp-github',
  policy: 'allow',
  tools: Object.freeze([
    Object.freeze({ name: 'git-status', capabilities: Object.freeze(['repo:read']) }),
  ]),
  secretRefs: Object.freeze([]),
})

/** 一次能**投影成功**的调用（有 cwd、有目标）。 */
const judgeCall = (name, callId) => ({ name, callId, arguments: { path: `${CWD}/x` } })

test('⑨④ ★★★ 装齐之后 `connectorJudgment` 翻成 true，且判定面**真的**在决策路径上', async () => {
  // ── 前提：不装连接器时两格都是 false。
  const bare = installEnforcementRoot(inputOk({}))
  assert.equal(bare.ok, true, JSON.stringify(bare))
  assert.equal(bare.root.enforcementSurfaces().connectorJudgment, false)
  assert.equal(bare.root.enforcementSurfaces().connectorFeedback, false)
  assert.equal(bare.root.bridge.connectorJudgment, null, '没给连接器 ⇒ 决策路径上不该多一层')
  // ★ 前提对照：**没有**判定面时，一次未声明的工具调用是**放行**的
  //   （政策门说 allow，而没有别人说话）。少了这条，下面那个 deny
  //   无法区分"判定面拒的"与"别处本来就会拒"。
  const bareAllow = await bare.root.bridge.preExecute(judgeCall('git-commit', 'b1'))
  assert.equal(bareAllow.kind, 'allow', `前提：没接判定面时应当放行，实得 ${bareAllow.kind}`)
  resetEnforcementRoot()

  const installed = installEnforcementRoot(inputOk({
    connectorDeclarations: [JUDGE_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const root = installed.root

  // ── 读数：两格**同时**翻成 true（它们是一对，但分别报）。
  assert.equal(root.enforcementSurfaces().connectorJudgment, true,
    '装了连接器登记表，判定面却没上 —— 登记的 policy 就永远不生效')
  assert.equal(root.enforcementSurfaces().connectorFeedback, true)
  // ★ 而 `policy` 那一格**照旧**是 true：判定面是接在政策门**外面**的一层，
  //   不是它的替代品。两格同时 true 正说明它们不是同一件事。
  assert.equal(root.enforcementSurfaces().policy, true)

  // ── 结构：桥真的拿着那个端口，且它包的**就是**本桥的 `decide`。
  const port = root.bridge.connectorJudgment
  assert.notEqual(port, null, '判定面没有被交给桥')
  assert.equal(typeof port, 'function')
  assert.equal(port.inner, root.bridge.decide,
    '判定面包的不是本桥的政策门 —— 那会把政策门整个绕过去')

  // ── ★★★ 后果是真的：一次**本连接器未声明**的工具调用被拒，
  //    而同一个调用在没有判定面时是放行的（见上面那条前提对照）。
  const fake = fakeContext()
  await root.mount(fake.ctx)
  const decision = await root.bridge.preExecute(judgeCall('git-commit', 'c-x'))
  assert.equal(decision.kind, 'deny',
    `未声明的工具被放行了（实得 ${decision.kind}）—— 判定面没接上`
    + '（"没见过就放行"等于任何人在外部加一个工具就等于加一个后门）')
  assert.match(decision.reason, /没有声明工具/, `拒绝不是连接器层给的：${decision.reason}`)
  assert.match(decision.reason, /git-commit/, `理由没说清是哪个工具：${decision.reason}`)
  // ★ 反向对照：**本连接器声明过**的那个工具照旧放行。
  const declared = await root.bridge.preExecute(judgeCall('git-status', 'c-y'))
  assert.equal(declared.kind, 'allow', `声明过的工具被拒了：${JSON.stringify(declared)}`)
  assert.equal(root.bridge.connectorJudgment.receipts().connectorDecided, 1,
    '连接器层更严的次数必须是 1（那是"连接器策略真的起作用"的唯一读数）')
  resetEnforcementRoot()
})

test('⑨⑤ ★★★ 端到端闭环：**判定面**因熔断开路而拒绝 ⇒ **反馈面**把结果记回去 ⇒ 熔断器合闸', async () => {
  const installed = installEnforcementRoot(inputOk({
    connectorDeclarations: [JUDGE_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const root = installed.root
  const fake = fakeContext()
  await root.mount(fake.ctx)
  const fire = fake.listeners.get('tools/result')[0]
  const port = root.bridge.connectorJudgment
  const listener = root.rows.connectorFeedback.listener

  // ── ① 合闸时放行（前提，否则下面"开路"不能说明任何事）。
  const first = await root.bridge.preExecute(judgeCall('git-status', 'c1'))
  assert.equal(first.kind, 'allow', `前提：一开始应当放行，实得 ${first.kind}`)

  // ── ② 三次失败经**反馈面**记进去 ⇒ 熔断器开路。
  for (let i = 0; i < 3; i += 1) {
    fire({ name: 'git-status', callId: `f${i}` }, { isError: true, error: { message: 'refused' }, content: [] })
  }
  assert.equal(listener.receipts().recorded, 3, '反馈面没把失败记进去')

  // ── ③ 判定面**立刻**改口：开路期间拒绝，且理由说的是熔断（不是策略）。
  const denied = await root.bridge.preExecute(judgeCall('git-status', 'c2'))
  assert.equal(denied.kind, 'deny',
    `熔断开路之后仍然放行（实得 ${denied.kind}）—— 两半各记各的账，不是一条环`)
  assert.match(denied.reason, /熔断|开路/, `理由没说清是熔断拒的：${denied.reason}`)
  assert.equal(port.receipts().connectorDecided >= 1, true,
    '更严的是连接器层 ⇒ 必须记在 connectorDecided')

  // ── ④ 闭合：探针成功 ⇒ 熔断器合闸 ⇒ 判定面恢复放行。
  //     ★ 这一步是"环"的定义：没有它，上面③只证明"开了就永远不开"。
  port.registry.recordOutcome({ connectorId: 'github', ok: true })
  const healed = await root.bridge.preExecute(judgeCall('git-status', 'c3'))
  assert.equal(healed.kind, 'allow',
    `探针成功之后应当恢复放行，实得 ${healed.kind}（熔断器没合闸 = 只开不合）`)
  resetEnforcementRoot()
})

test('⑨⑥ ★★ 判定面与反馈面共用**同一份** registry（否则两半各记各的账）', async () => {
  const installed = installEnforcementRoot(inputOk({
    connectorDeclarations: [JUDGE_DECL],
    resolveConnectorId: () => 'github',
  }))
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const root = installed.root

  // ★ 两半必须指着**同一个对象**。指着两份的后果很具体：
  //   判定面读的熔断器永远合闸（没人写它），而反馈面写的那个没人读
  //   —— 于是"连接器失败会被拦下"这件事**永远不发生**，
  //   而两边的读数各自看起来都很正常。
  assert.equal(root.bridge.connectorJudgment.registry, root.rows.connectorFeedback.listener.registry,
    '判定面与反馈面指着两份 registry —— 熔断器永远不会被读到同一个状态')
  assert.equal(root.rows.connectorFeedback.listener.registry, root.bridge.connectorJudgment.registry)

  // ── 反证：在同一本账上记三次失败，**判定面**立刻看得见。
  const registry = root.bridge.connectorJudgment.registry
  for (let i = 0; i < 3; i += 1) registry.recordOutcome({ connectorId: 'github', ok: false })
  const fake = fakeContext()
  await root.mount(fake.ctx)
  const d = await root.bridge.preExecute(judgeCall('git-status', 'c1'))
  assert.equal(d.kind, 'deny', '在同一本账上记的失败，判定面却没看见')
  resetEnforcementRoot()
})

