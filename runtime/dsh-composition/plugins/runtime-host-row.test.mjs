// runtime/dsh-composition/plugins/runtime-host-row.test.mjs
// ============================================================================
// PRT-253（续）：`runtime-host-row.mjs` 的套件。
//
// ## 这套件断言什么、不断言什么
//
// 它验的是**这一行的接线与拒绝**：四样输入各自的来源、少一样时的具名码、
// 以及"结论被发布出去 / 绑定随 Fiber 撤销"这三件事。
//
// 它**不**验"绑定真的生效"——那是 `runtime-host-row-dsh-process.test.mjs` 的事，
// 因为 `bindDshRuntime()` 的生效只有在一个**真 DSH 进程**里读
// `productionExecutorProvider()` 才看得见。这里用替身组合根，所以这里也只许
// 断言"这一行把什么交给了组合根"，不许断言"引擎因此能跑"。
//
//   > 一条"这一行调了 bootstrap"的断言，与一条"绑定生效了"的断言，
//   > 在替身组合根在场时完全同形——只不过后者根本没有被验过。
//
// ## 测试形状纪律
//
//   · 断言的是**具名码本身**（`e.code ===`），不是"它抛了"；
//   · 反向对照：缝清空之后同一个读数**必须变**，恢复之后必须变回来；
//   · 每个断言都能红：把对应那一句删掉就会被咬住（见本批文档 §5 的断验证记录）。
// ============================================================================

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import runtimeHostRow, {
  ACTIVE_FIBER_STATE,
  RUNTIME_HOST_BINDING_SERVICE,
  RUNTIME_HOST_ROW_CODES,
  RUNTIME_HOST_ROW_PLUGIN_NAME,
  dshRuntimeInputsFactory,
  observeComposition,
  resetDshRuntimeInputsFactory,
  setDshRuntimeInputsFactory,
} from './runtime-host-row.mjs'
import { ENFORCEMENT_ROOT_SERVICE } from './root-row.mjs'
import { PATCH_LAYER_ROWS, RUNTIME_ONLY_ROW_IDS } from '../patch-layer.mjs'

/**
 * 声明里的行 id 与那条 `patch-over` 行 —— **从产品声明推导**，不在用例里另抄一份。
 * 抄一份的话，补丁层加一行而用例还绿着，这些断言就会静默地少验一行。
 */
const DECLARED_ROW_IDS = PATCH_LAYER_ROWS.map((r) => r.id)
const PATCH_OVER_ROW = PATCH_LAYER_ROWS.find((r) => r.mount?.anchor === 'patch-over')
const PRESETS_ROW_ID = PATCH_OVER_ROW.id
const PRESETS_TARGET_ID = PATCH_OVER_ROW.mount.target

/**
 * 一份"全都装上了"的组合树条目。
 *
 * `insert` 行用声明的 id；`patch-over` 行用它的**靶子** id（树里就是那样的）+
 * 一份 Legion preset 表。
 */
function treeEntriesOk(presets = { 'legion-attended': {}, 'legion-unattended': {} }) {
  return PATCH_LAYER_ROWS.map((r) => ({
    options: r.mount?.anchor === 'patch-over'
      ? { id: r.mount.target, name: `file:///${r.mount.target}.mjs`, config: { presets } }
      : { id: r.id, name: `file:///${r.id}.mjs` },
    fiber: { state: ACTIVE_FIBER_STATE },
  }))
}

const DSH = process.env.DSH_CHECKOUT ?? null
const CORDIS = DSH === null ? null : join(
  DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js',
)
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CORDIS)
    ? `DSH 检出里找不到 cordis（${CORDIS}）——依赖未安装？`
    : false
const SKIP = UNAVAILABLE === false ? false : UNAVAILABLE

let Context = null
if (SKIP === false) ({ Context } = await import(pathToFileURL(CORDIS).href))

/**
 * 真 Context 上要先把**加载器**支起来：本行的 `composition` 来自它。
 *
 * 在真 DSH 进程里这个服务由 boot 提供（本批实测：`ctx.get('loader')` 拿到 loader
 * 对象）；在一个裸 `new Context()` 上没有它，所以这里显式给一个**只回答 entries
 * 的替身**——它替的是"组合树长什么样"，**不替**被测的那条接线。
 */
const ROW_ENTRIES_FOR_REAL_CTX = Object.freeze(treeEntriesOk().map((e) => Object.freeze({
  options: Object.freeze({ ...e.options }),
  fiber: Object.freeze({ ...e.fiber }),
})))

function provideLoader(ctx) {
  ctx.provide('loader', { entries: () => ROW_ENTRIES_FOR_REAL_CTX })
}

const guarded = (name, fn) => test(name, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

afterEach(() => {
  resetDshRuntimeInputsFactory()
})

// ─────────────────────────────────────────── 假件（**只**用来读这一行交出了什么）

/**
 * 一个假组合根服务。
 *
 * ★ 它发的形状**必须与 `root-row.mjs` 发的一样**：服务值是
 * `installEnforcementRoot()` 的**安装结果** `{ok, code, message, root}`，
 * `bootstrap` 在 `root.bootstrap` 上。第一版这里发的是 `{bootstrap(){}}`，
 * 于是"把服务值当组合根用"这个形状错误在替身上全绿——
 * 真 DSH 进程那套件一跑就把它咬出来了（见 PRT-253 文档 §4）。
 *
 *   > 替身发一个比产品"更好用"的形状，就等于把被测的那条接线藏起来。
 */
function fakeRoot({ result = null, installation = null } = {}) {
  const calls = []
  const unbinds = []
  const root = {
    async bootstrap(deps) {
      calls.push(deps)
      if (result !== null) return result
      return {
        ok: true,
        state: 'enforcement-effective',
        patchVersion: 1,
        checks: [{ name: 'composition-patch-layer', ok: true }],
        unbind: () => { unbinds.push(1); return true },
      }
    },
  }
  const service = installation ?? { ok: true, code: null, message: null, root }
  return { calls, unbinds, service, installation: service }
}

/**
 * 一个**最小**的假 Context。
 *
 * 它只实现本行用到的面（`get` / `provide` / `effect`），并且**刻意不建模
 * `inject` 的等待语义**——依赖语义由真 Context 那几条测。
 *
 * 加载器走 `get('loader')`（本行就是这么读的，见 `observeComposition`），
 * 所以它是一个**服务**，不是一个直接属性。
 */
function fakeContext({ root = null, sandbox = undefined, entries = null } = {}) {
  const services = new Map()
  if (root !== null) services.set(ENFORCEMENT_ROOT_SERVICE, root)
  if (sandbox !== undefined) services.set('sandbox', sandbox)
  const loader = { entries: () => (entries === null ? [] : entries) }
  services.set('loader', loader)
  const effects = []
  const ctx = {
    // ★ 第二个参数是 **strict**，不是 fallback：服务不在时返回 `undefined`。
    //   （真 cordis 就是 `get(name, strict = true)`——第一版假件返回 fallback，
    //   于是一个"服务不在"在假件上变成 `false`，被读成"服务在、但拒绝了"。）
    get(name) {
      return services.has(name) ? services.get(name) : undefined
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(fn) {
      // 照 cordis 的语义：`effect` 收的是**返回 disposer 的回调**。
      const disposer = fn()
      effects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    services,
    effects,
  }
  return ctx
}

/** 一个只有 `get` 的 ctx——给 `observeComposition()` 的直调用例用。 */
function ctxWithLoader(entries) {
  return { get: (name) => (name === 'loader' ? { entries: () => entries } : undefined) }
}

/** 一次**合法**的输入工厂：端口与 canRead 都是**同一批对象**，好按 `===` 钉住。 */
function inputsOk(over = {}) {
  const runtimeHost = over.runtimeHost ?? {
    async probeRuntime() { return { version: '0.1.5-rc.2', capabilities: {} } },
    async startRun() { return { result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} } },
  }
  const canRead = over.canRead ?? (() => true)
  return { runtimeHost, canRead }
}

/** 一份**能让本行走到 bootstrap** 的默认局面：真组合树读数用假的 entries 顶。 */
function readyContext(over = {}) {
  const root = over.root ?? fakeRoot()
  const sandbox = over.sandbox ?? { async confine(argv) { return { enforcement: 'full', argv: ['x', ...argv] } } }
  const entries = over.entries ?? treeEntriesOk()
  return { ctx: fakeContext({ root: root.service, sandbox, entries }), root }
}

/** 等一次微任务，好让 `apply` 里那条 `await` 结算。 */
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * 等 cordis 把"服务到了 → 依赖它的行激活"这条路走完。
 *
 * 本行的 `apply` 是 **async**（它要 await 组合根的 `bootstrap`），所以"激活"发生在
 * 一个微任务链的末尾。只等一个 tick 的话，用例会读到一个**还没走完**的中间态，
 * 而那与被测行为无关。
 */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await tick()
}

// ============================================================================
// ① 组合树观察：真来源的形状
// ============================================================================

describe('PRT-253 runtime-host-row：组合树观察', () => {
  test('① 行 id 取 `options.id`，激活取 `fiber.state === 2`，并**区分**未激活', () => {
    const observation = observeComposition(ctxWithLoader([
      { options: { id: 'legion-enforcement-hard-floor' }, fiber: { state: ACTIVE_FIBER_STATE } },
      { options: { id: 'legion-enforcement-root' }, fiber: { state: 1 } },
      { options: { name: 'file:///no-id.mjs' }, fiber: { state: ACTIVE_FIBER_STATE } },
      { options: { id: 'permission', config: { presets: { 'legion-attended': {}, 'legion-unattended': {} } } }, fiber: { state: ACTIVE_FIBER_STATE } },
    ]))
    const byId = Object.fromEntries(observation.rows.map((r) => [r.id, r.activated]))
    assert.equal(byId['legion-enforcement-hard-floor'], true)
    assert.equal(byId['legion-enforcement-root'], false, '未激活（state 1）必须读成未激活，不是"行不在"')
    const presets = observation.rows.find((r) => r.id === PRESETS_ROW_ID)
    assert.equal(presets?.activated, true, 'patch-over 行必须报成它靶子的激活状态')
    assert.equal(presets?.treeId, PRESETS_TARGET_ID, '它的树条目 id 是靶子，不是声明的 id')
    assert.deepEqual(observation.permissionPresets, ['legion-attended', 'legion-unattended'])
  })

  test('①b ★ `patch-over` 行报的是**声明 id**，树里没有那个 id 也算在场', () => {
    // 这条是核心：只用 `options.id` 一对一读的观察器会为 patch-over 那一行
    // 永远报 ROW_MISSING（真 DSH 进程里量到过），于是启动自检永远拒绝注册。
    const observation = observeComposition(ctxWithLoader([
      { options: { id: PRESETS_TARGET_ID, config: { presets: { 'legion-attended': {} } } }, fiber: { state: ACTIVE_FIBER_STATE } },
    ]))
    const ids = observation.rows.map((r) => r.id)
    assert.ok(ids.includes(PRESETS_ROW_ID), `声明 id 必须出现：${ids.join(', ')}`)
    // 而靶子自己的 id **不该**被当成一行报出去——它不是声明里的行。
    assert.equal(ids.includes(PRESETS_TARGET_ID), false, `树条目 id 不该被当成声明行：${ids.join(', ')}`)
  })

  test('①c `patch-over` 的靶子不在树里 → 那一行 `activated: false` 且 `present: false`', () => {
    const observation = observeComposition(ctxWithLoader([
      { options: { id: 'cordis:include' }, fiber: { state: ACTIVE_FIBER_STATE } },
    ]))
    const presets = observation.rows.find((r) => r.id === PRESETS_ROW_ID)
    assert.equal(presets.present, false)
    assert.equal(presets.activated, false)
    // "靶子不在"与"靶子在但没激活"必须可分。
    const pending = observeComposition(ctxWithLoader([
      { options: { id: PRESETS_TARGET_ID, config: { presets: {} } }, fiber: { state: 1 } },
    ])).rows.find((r) => r.id === PRESETS_ROW_ID)
    assert.equal(pending.present, true)
    assert.equal(pending.activated, false)
  })

  test('② 没有 permission 行 → `permissionPresets` 是 `null`，**不是** `[]`', () => {
    const observation = observeComposition(ctxWithLoader([
      { options: { id: 'legion-enforcement-hard-floor' }, fiber: { state: 2 } },
    ]))
    // 「没读到」与「读到了、是空的」必须分得开：后者会让自检说"preset 表里没有 Legion 项"，
    // 而真因是那一行根本不在树里。
    assert.equal(observation.permissionPresets, null)
    // 而"读到了、但是空的"确实是 `[]`：这两种输入给的是**不同**的读数。
    assert.deepEqual(observeComposition(ctxWithLoader([
      { options: { id: PRESETS_TARGET_ID, config: { presets: {} } }, fiber: { state: 2 } },
    ])).permissionPresets, [])
  })

  test('③ 加载器不在 / 形状不对 / 读了一半抛错 / 零条目 → `null`（不给半份结果）', () => {
    assert.equal(observeComposition({}), null, '没有 ctx.get')
    assert.equal(observeComposition({ get: () => undefined }), null, 'ctx.get 说没有 loader')
    assert.equal(observeComposition({ get: () => ({}) }), null, 'loader 上没有 entries')
    assert.equal(observeComposition({ get: () => ({ entries: () => [] }) }), null,
      '零条目 = "没读到组合"，不是"读到了一份空组合"：真 profile 里永远至少有 cordis:include')
    assert.equal(observeComposition({ get: () => ({ entries: () => { throw new Error('boom') } }) }), null)
    assert.equal(observeComposition(null), null)
    // 而"树里有别的行、只是声明里那几行不在"是一个**有效的**观察结果——
    // 判"补丁层有没生效"是 `reconcilePatchLayer()` 的职责，不是观察器的。
    const unrelated = observeComposition({ get: () => ({ entries: () => [
      { options: { id: 'cordis:include' }, fiber: { state: 2 } },
    ] }) })
    assert.equal(unrelated.rows.length, DECLARED_ROW_IDS.length)
    assert.ok(unrelated.rows.every((r) => r.present === false))
  })

  /**
   * 一个同时有 loader 与组合根服务的 ctx：观察器要能**同时**从两个来源读。
   *
   * `loader` 的那一份固定用 `treeEntriesOk()`（本套件既有的"全都在"假树）；
   * 被测的是组合根那一侧。
   */
  function ctxWithRoot(service) {
    return {
      get: (name) => {
        if (name === 'loader') return { entries: () => treeEntriesOk() }
        if (name === ENFORCEMENT_ROOT_SERVICE) return service
        return undefined
      },
    }
  }

  test('③b ★★ 观察结果带出组合根的**进程内挂载账**（运行期行唯一的证据来源）', () => {
    assert.ok(RUNTIME_ONLY_ROW_IDS.length > 0, '没有运行期行 —— 这条用例是空的')
    const mounted = [...RUNTIME_ONLY_ROW_IDS]
    const observation = observeComposition(ctxWithRoot({
      ok: true,
      code: null,
      message: null,
      root: { mountedEnforcementRows: () => mounted },
    }))
    assert.deepEqual(observation.inProcessMounted, mounted,
      '挂载账没有被带出来 —— 运行期行会永远 ROW_MISSING')

    // 反向对照：同一棵 loader 树、组合根服务不在 ⇒ **没有**账。
    const noRoot = { get: (name) => (name === 'loader' ? { entries: () => treeEntriesOk() } : undefined) }
    assert.equal(observeComposition(noRoot).inProcessMounted, null,
      '组合根不在却读到了挂载账 —— 那是一份编出来的证据')
  })

  // ─────────── ③d ★★★ 读账之前必须**等这次挂载 settle**（PRT-214 收口续二）
  //
  // 背景（本批量到的，不是推的）：挂载账原来只有一本，且写在第一个 `await` 之前，
  // 于是 `mount()` 一同步返回它就已经宣布两行已挂载——而那一刻两个 `apply`
  // **一个都还没被调用**。顺着 `startupSelfCheck()` 第①项到
  // `bootstrapDshRuntime()` 注册端口，这个窗口上开着的是最关键的那条保证：
  // 「强制面未生效时禁止自动执行」。
  //
  //   > 一本"挂载一发起就宣布挂好了"的账，
  //   > 与一本"根本没记挂载"的账，在没有并发读者的世界里是同一个东西——
  //   > 只不过前者的假绿只在**读的时刻恰好在窗口里**才看得见。
  //
  // 修法是两半：证据账改成"逐行 settle 之后才写"，**且**读账的一方先等 settle。
  // 只做前一半会把假绿换成假红（观察者在窗口里读到空账 ⇒ 判未生效 ⇒ 拒绝注册 ⇒
  // 一个健康的部署起不来）。下面这条用例钉的是**后一半**。
  test('③d ★★★ 载入前先等 `mountSettled()`：在"账要等 settle 才有行"的组合根上仍判生效', async () => {
    assert.ok(RUNTIME_ONLY_ROW_IDS.length > 0, '没有运行期行 —— 这条用例是空的')

    // 一个**只在 settle 之后才报行**的组合根——正是修好之后的生产形状。
    // 观察方若不等就直接读，读到的是空集。
    let settled = false
    let readEarly = false
    const calls = []
    const inner = {
      async mountSettled() { await tick(); settled = true },
      mountedEnforcementRows() {
        if (!settled) readEarly = true
        return settled ? [...RUNTIME_ONLY_ROW_IDS] : []
      },
      async bootstrap(deps) {
        calls.push(deps)
        return {
          ok: true,
          state: 'enforcement-effective',
          patchVersion: 1,
          checks: [{ name: 'composition-patch-layer', ok: true }],
          unbind: () => true,
        }
      },
    }
    // `readyContext` 要的是 `fakeRoot()` 那个形状（`{service: {ok, code, message, root}}`）。
    const { ctx } = readyContext({
      root: { service: { ok: true, code: null, message: null, root: inner } },
    })
    setDshRuntimeInputsFactory(() => inputsOk())
    await runtimeHostRow.apply(ctx)

    assert.equal(calls.length, 1, '组合根没被调用 —— 夹具不成立')
    assert.equal(readEarly, false,
      '观察方在挂载 settle **之前**就把账读了 —— 那正是把假绿换成假红的那一半')
    assert.deepEqual([...calls[0].composition.inProcessMounted], [...RUNTIME_ONLY_ROW_IDS],
      '交给自检的观察结果里**没有**挂载账 —— 两行会被报成 ROW_MISSING、'
      + '自检判未生效、拒绝注册（假红：一个健康的部署起不来）')
  })

  test('③d ★★ 判决把"账是不是在已 settle 的证据上读的"写成字段', async () => {
    // 与 `reconcilePatchLayer()` 的 `mountSource` 同一个口径：把"哪个宇宙"写出来，
    // 读者就不用回去看代码才知道自己读到的是哪一种。
    const root = fakeRoot()
    root.service.root.mountSettled = async () => {}
    const { ctx } = readyContext({ root })
    setDshRuntimeInputsFactory(() => inputsOk())
    await runtimeHostRow.apply(ctx)
    const published = ctx.services.get(RUNTIME_HOST_BINDING_SERVICE)
    assert.equal(published.mountSettled, true, '等过了却没记下来')
    assert.equal(published.mountSettledReason, null)

    // 反向：组合根没这个口（形状不是本仓库这一份）⇒ 如实记"没等到"，而不是假装等过。
    // 假装等过会让"账是在未 settle 的证据上读的"这件事从读数上消失。
    const legacy = fakeRoot()
    const { ctx: ctx2 } = readyContext({ root: legacy })
    setDshRuntimeInputsFactory(() => inputsOk())
    await runtimeHostRow.apply(ctx2)
    const p2 = ctx2.services.get(RUNTIME_HOST_BINDING_SERVICE)
    assert.equal(p2.mountSettled, false, '没等到却记成等过了 —— 那会让假绿重新看不见')
    assert.equal(p2.mountSettledReason, 'no-mount-settled')
  })

  test('③c ★★ 挂载账读不出来时一律 `null`（fail closed），不给半份', () => {
    const cases = [
      ['服务缺席', undefined],
      ['服务是 null', null],
      ['服务在但被**拒绝**（ok=false）', { ok: false, code: 'ENFORCEMENT_ROOT_CONFIG_MISSING', message: '缺配置', root: { mountedEnforcementRows: () => RUNTIME_ONLY_ROW_IDS } }],
      ['root 缺席', { ok: true, root: null }],
      ['root 上没有那个方法', { ok: true, root: {} }],
      ['那个方法不是函数', { ok: true, root: { mountedEnforcementRows: RUNTIME_ONLY_ROW_IDS } }],
      ['那个方法抛了', { ok: true, root: { mountedEnforcementRows() { throw new Error('boom') } } }],
      ['返回的不是数组', { ok: true, root: { mountedEnforcementRows: () => 'legion-enforcement-pre-execute' } }],
      ['返回空数组', { ok: true, root: { mountedEnforcementRows: () => [] } }],
      ['数组里没有可用的行 id', { ok: true, root: { mountedEnforcementRows: () => ['', 3, null] } }],
    ]
    for (const [label, service] of cases) {
      assert.equal(observeComposition(ctxWithRoot(service)).inProcessMounted, null,
        `${label} 被读成了一份证据 —— 未观察被当成了已挂载`)
    }
    // ★ 反向对照：**同一组输入**里，一份合法的账必须被读出来。
    //   没有这一条，上面那十条在一个"永远返回 null"的实现上同样全绿。
    const good = observeComposition(ctxWithRoot({
      ok: true,
      root: { mountedEnforcementRows: () => [...RUNTIME_ONLY_ROW_IDS, 3, ''] },
    }))
    assert.deepEqual(good.inProcessMounted, [...RUNTIME_ONLY_ROW_IDS],
      '合法的账没被读出来 —— 上面那十条 fail-closed 断言是恒真的')
  })
})

// ============================================================================
// ② 四样输入各自的拒绝码（每一样一个码，不许混）
// ============================================================================

describe('PRT-253 runtime-host-row：缺哪一样就报哪一个码', () => {
  const applyRejects = async (ctx) => {
    try {
      await runtimeHostRow.apply(ctx)
    } catch (e) {
      return e
    }
    throw new Error('本行没有拒绝——那这些反向对照就是假的')
  }

  test('④ 不是 Context → `NO_CONTEXT`', async () => {
    const e = await applyRejects(null)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.NO_CONTEXT)
  })

  test('⑤ 组合根服务不在 → `NO_ENFORCEMENT_ROOT`（不是别的码）', async () => {
    const ctx = fakeContext({ sandbox: { async confine() { return { enforcement: 'full', argv: ['x'] } } } })
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.NO_ENFORCEMENT_ROOT)
    // 与"没人注册工厂"必须分得开：这两样缺失的修法完全不同。
    assert.notEqual(e.code, RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY)
  })

  test('⑤b 服务在但是一份**拒绝** → `ENFORCEMENT_ROOT_REFUSED`，且带出内层码', async () => {
    const root = fakeRoot({ installation: { ok: false, code: 'ENFORCEMENT_ROOT_NO_ACTOR', message: '缺 actor', reasons: ['actor 缺失'], root: null } })
    const { ctx } = readyContext({ root })
    setDshRuntimeInputsFactory(() => inputsOk())
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.ENFORCEMENT_ROOT_REFUSED)
    assert.equal(e.innerCode, 'ENFORCEMENT_ROOT_NO_ACTOR')
    assert.deepEqual([...e.reasons], ['actor 缺失'])
    // 与"服务不在"必须分开：一个是"从来没装"，一个是"装了但拒绝了"。
    assert.notEqual(e.code, RUNTIME_HOST_ROW_CODES.NO_ENFORCEMENT_ROOT)
  })

  test('⑤c ★ 服务形状读错（把服务值当组合根用）→ `ROOT_SHAPE_INVALID`，**不是**"服务不在"', async () => {
    // 这就是真 DSH 进程咬出来的那个错误：`root-row.mjs` 发布的是安装结果
    // `{ok, code, message, root}`，而 `bootstrap` 在 `root.bootstrap` 上。
    // 一个把服务值直接当组合根的实现在这里必须报**形状**错，
    // 否则排查方向会指向"组合根没装"，而真因是这一行读错了形状。
    const root = fakeRoot()
    const { ctx } = readyContext({ root })
    // 换成一个"像组合根但其实不是"的服务值：有 bootstrap 在顶层？不——这里给的是
    // 安装结果被**少包了一层**的样子（顶层有 ok，但没有 root.bootstrap）。
    ctx.services.set(ENFORCEMENT_ROOT_SERVICE, { ok: true, code: null, message: null })
    setDshRuntimeInputsFactory(() => inputsOk())
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.ROOT_SHAPE_INVALID)
    assert.notEqual(e.code, RUNTIME_HOST_ROW_CODES.NO_ENFORCEMENT_ROOT)
  })

  test('⑥ 没人注册工厂 → `NO_INPUTS_FACTORY`；注册之后同一个局面**变**了', async () => {
    const { ctx } = readyContext()
    const before = await applyRejects(ctx)
    assert.equal(before.code, RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY)

    const undo = setDshRuntimeInputsFactory(() => inputsOk())
    assert.equal(typeof dshRuntimeInputsFactory(), 'function', '注册之后缝上必须有工厂')
    await runtimeHostRow.apply(ctx)
    // 读的是**服务**，不是 `apply` 的返回值：cordis 会把异步 `apply` 的返回值
    // 当效果收集，返回一个对象会报 `Invalid effect`（见产品文件里那段注释）。
    // 所以"绑上了没有"这个事实只能从服务上读，这也正是发布它的原因。
    assert.equal(ctx.services.get(RUNTIME_HOST_BINDING_SERVICE)?.ok, true, '注册之后不该再以缺工厂拒绝')

    // 反向：注销之后必须**变回**原来那个码——一个"注销不掉"的缝，
    // 与一个"注册得上"的缝，在"注册成功"这个读数上完全一样。
    assert.equal(undo(), true)
    assert.equal(dshRuntimeInputsFactory(), null)
    const after = await applyRejects(readyContext().ctx)
    assert.equal(after.code, RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY)
    assert.equal(undo(), false, '注销函数必须幂等')
  })

  test('⑦ 工厂抛错 → `INPUTS_FACTORY_THREW`，并带出它抛了什么', async () => {
    const { ctx } = readyContext()
    setDshRuntimeInputsFactory(() => { throw Object.assign(new Error('端口造不出来'), { code: 'HUB_URL_MISSING' }) })
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW)
    assert.match(e.message, /端口造不出来/)
    assert.match(e.message, /HUB_URL_MISSING/)
  })

  test('⑧ 工厂没给端口 → `NO_HOST_PORT`；`canRead` **缺席合法**、给个不是函数的才 `NO_CAN_READ`', async () => {
    const noPortCtx = readyContext().ctx
    setDshRuntimeInputsFactory(() => ({ canRead: () => true }))
    const noPort = await applyRejects(noPortCtx)
    assert.equal(noPort.code, RUNTIME_HOST_ROW_CODES.NO_HOST_PORT)

    // ★ 缺席**不**在这里拒：本行跑在 DSH Runtime 进程里，那里没有任何东西读
    //   `canRead`（测量见 `runtime-host-registrar-row.mjs` 文件头）。缺席如实交下去，
    //   由真正要执行的那一侧（worker 的 productionExecutorProvider）具名拒绝。
    const absentCtx = readyContext().ctx
    setDshRuntimeInputsFactory(() => ({ runtimeHost: inputsOk().runtimeHost }))
    const absent = await runtimeHostRow.apply(absentCtx)
      .then(() => absentCtx.services.get(RUNTIME_HOST_BINDING_SERVICE), (e) => e)
    assert.equal(absent?.ok, true, `canRead 缺席不该拦下这一行：${JSON.stringify(absent)?.slice(0, 300)}`)
    assert.notEqual(absent?.code ?? absent, RUNTIME_HOST_ROW_CODES.NO_CAN_READ)

    // 但**挂一个不是函数的** → 仍然当场拒。静默丢掉它，就再没有人看得出
    // 有人试图挂它——而那正是最该被看见的一种接线错误。
    const badCtx = readyContext().ctx
    setDshRuntimeInputsFactory(() => ({ runtimeHost: inputsOk().runtimeHost, canRead: 'yes' }))
    const bad = await applyRejects(badCtx)
    assert.equal(bad.code, RUNTIME_HOST_ROW_CODES.NO_CAN_READ)
    assert.notEqual(noPort.code, bad.code, '两样缺失必须报两个码')
  })

  test('⑨ 组合树读不到 → `NO_COMPOSITION`（**不是**"补丁层未生效"）', async () => {
    // 零条目的树 = "没读到组合"，不是"读到了一份空组合"：真 profile 里永远至少有
    // `cordis:include` 那一行。报成"读到零行"会让自检去逐行判未生效，而真因是读错了。
    const { ctx } = readyContext({ entries: [] })
    setDshRuntimeInputsFactory(() => inputsOk())
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.NO_COMPOSITION)
    // 这条与"读到行但没激活"是两件事：这里根本没读到行，所以不许报成自检的结论。
    assert.equal(e.code.includes('BOOTSTRAP'), false)
  })

  test('⑨b 树读到了、但**声明里的行一个都不在** → 不是 `NO_COMPOSITION`，而是交给自检', async () => {
    // 这一条划清边界：观察器**不**替自检判定"补丁层有没生效"。
    // 树里有别的行（真 profile 一定有的那种）时，本行照常把观察结果交出去，
    // 由 `reconcilePatchLayer()` 逐行报 ROW_MISSING —— 那才是它的职责。
    const { ctx } = readyContext({ entries: [{ options: { id: 'cordis:include' }, fiber: { state: ACTIVE_FIBER_STATE } }] })
    setDshRuntimeInputsFactory(() => inputsOk())
    // 假组合根照旧回答 ok（这里是替身，不跑真自检），所以本行**不该**以
    // `NO_COMPOSITION` 拒绝——两份观察在读数上必须不同形。
    const published = await runtimeHostRow.apply(ctx).then(() => ctx.services.get(RUNTIME_HOST_BINDING_SERVICE), (e) => e)
    assert.notEqual(published?.code ?? published, RUNTIME_HOST_ROW_CODES.NO_COMPOSITION)
    assert.equal(published.ok, true)
  })

  test('⑩ 沙箱服务不在 → `NO_SANDBOX_PORT`（那正是自检要拦的处境）', async () => {
    const ctx = fakeContext({ root: fakeRoot().service, sandbox: undefined, entries: [
      { options: { id: 'a' }, fiber: { state: ACTIVE_FIBER_STATE } },
    ] })
    setDshRuntimeInputsFactory(() => inputsOk())
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.NO_SANDBOX_PORT)
  })

  test('⑪ 组合根拒绝时把**内层码**原样带出来（两种"装不上"可分）', async () => {
    const root = fakeRoot({ result: { ok: false, code: 'BOOTSTRAP_SELF_CHECK_INCOMPATIBLE', message: '自检没过', reasons: ['沙箱仅 partial'] } })
    const { ctx } = readyContext({ root })
    setDshRuntimeInputsFactory(() => inputsOk())
    const e = await applyRejects(ctx)
    assert.equal(e.code, RUNTIME_HOST_ROW_CODES.BIND_REFUSED)
    assert.equal(e.innerCode, 'BOOTSTRAP_SELF_CHECK_INCOMPATIBLE')
    assert.deepEqual([...e.reasons], ['沙箱仅 partial'])
  })
})

// ============================================================================
// ③ 交出去的东西：四样输入的**身份**与结论的发布
// ============================================================================

describe('PRT-253 runtime-host-row：交给组合根的到底是什么', () => {
  test('⑫ 四样输入逐一按引用核对：端口 / canRead / 沙箱是**那两个**对象，组合树是本行读的', async () => {
    const root = fakeRoot()
    const sandbox = { async confine(argv) { return { enforcement: 'full', argv: ['x', ...argv] } } }
    const mine = inputsOk()
    // 一棵"声明里每一行都装上了"的树，从**声明**推出来（见 `treeEntriesOk`）。
    const entries = treeEntriesOk({ 'legion-attended': {} })
    const ctx = fakeContext({ root: root.service, sandbox, entries })
    const undo = setDshRuntimeInputsFactory(() => mine)

    await runtimeHostRow.apply(ctx)

    assert.equal(root.calls.length, 1, '必须恰好调一次 bootstrap')
    const deps = root.calls[0]
    assert.equal(deps.runtimeHost, mine.runtimeHost, '交给组合根的必须是工厂给的那一个端口对象')
    assert.equal(deps.canRead, mine.canRead, 'canRead 必须按引用原样交出，不许包一层')
    assert.equal(deps.sandbox, sandbox, '沙箱端口必须是 ctx.sandbox 那一个')
    // 组合树是**本行自己从 ctx.loader 读的**——所以它必须与 entries 对得上，
    // 而不是某一份注入进来的常量。
    //
    // 断言里带上**全部**声明行，而不是挑两行：挑两行的话，补丁层加一行而这里
    // 没跟上，"读全了"这句话就悄悄变成了假话。
    assert.deepEqual([...deps.composition.rows].map((r) => r.id).sort(), [...DECLARED_ROW_IDS].sort())
    assert.ok(deps.composition.rows.every((r) => r.activated === true),
      `entries 全都是 ACTIVE，读出来却不全激活：${JSON.stringify(deps.composition.rows)}`)
    assert.deepEqual(deps.composition.permissionPresets, ['legion-attended'])

    const published = ctx.services.get(RUNTIME_HOST_BINDING_SERVICE)
    assert.equal(published?.ok, true)
    assert.equal(published.state, 'enforcement-effective')
    assert.equal(published.rowVersion, 1)
    assert.equal(undo(), true)
  })

  test('⑫c ★ `canRead` 缺席时交给组合根的是 `null`——**不是** undefined、不是函数、不是空对象', async () => {
    // "没有来源"必须是一个**分得开**的值。`undefined` 与"工厂忘了写这个键"同形；
    // 一个替身函数与"有来源"同形；空对象与"来源是空的"同形。三者在这里都被排除。
    const root = fakeRoot()
    const ctx = fakeContext({ root: root.service, sandbox: { async confine(a) { return { enforcement: 'full', argv: ['x', ...a] } } }, entries: treeEntriesOk() })
    const factory = setDshRuntimeInputsFactory(() => ({ runtimeHost: inputsOk().runtimeHost }))
    try {
      await runtimeHostRow.apply(ctx)
      assert.equal(root.calls.length, 1, '必须恰好调一次 bootstrap')
      const deps = root.calls[0]
      assert.equal(deps.canRead, null, `缺席必须原样交成 null，实际 ${JSON.stringify(deps.canRead)}`)
      assert.equal(deps.canRead === undefined, false, 'undefined 与"工厂没写这个键"同形，不许用它表示缺席')
      assert.equal('canRead' in deps, true, '这个键必须在场，值是 null')
    } finally { factory() }
  })

  test('⑫b `apply` **不返回**任何东西（cordis 会把返回值当效果收集）', async () => {
    const { ctx } = readyContext()
    setDshRuntimeInputsFactory(() => inputsOk())
    const returned = await runtimeHostRow.apply(ctx)
    // 返回一个普通对象会让 cordis 的 `safeCollect` 报 `Invalid effect`，
    // 并**连带回滚**这一行已经 provide 出去的服务。这条断言是可红的：
    // 把 `return published` 加回去，真 Context 那两条会立刻红。
    assert.equal(returned, undefined)
  })

  test('⑬ 结论**没有**被发布成本行自己的失败形状：拒绝时服务不该在', async () => {
    const root = fakeRoot({ result: { ok: false, code: 'BOOTSTRAP_COMPOSITION_UNOBSERVED', message: '没观察结果' } })
    const { ctx } = readyContext({ root })
    setDshRuntimeInputsFactory(() => inputsOk())
    await assert.rejects(() => runtimeHostRow.apply(ctx))
    assert.equal(ctx.services.has(RUNTIME_HOST_BINDING_SERVICE), false,
      '拒绝却发布了"绑定结论"——那会让下游读到一个不存在的绑定')
  })

  test('⑭ 注册的 Fiber 撤销函数真的把绑定撤掉（`ctx.effect` 那一条接线）', async () => {
    const root = fakeRoot()
    const { ctx } = readyContext({ root })
    setDshRuntimeInputsFactory(() => inputsOk())
    await runtimeHostRow.apply(ctx)
    assert.equal(ctx.effects.length, 1, '必须把 unbind 注册成 Fiber 的副作用')
    assert.equal(root.unbinds.length, 0, '还没撤销就不该已经撤过')
    // `ctx.effect` 的回调必须返回**disposer**（不是"调用一下"）——照 cordis 的语义调它。
    assert.equal(typeof ctx.effects[0], 'function', 'effect 回调返回的必须是 disposer')
    ctx.effects[0]()
    assert.equal(root.unbinds.length, 1, 'Fiber 撤销时必须调组合根给的 unbind')
  })
})

// ============================================================================
// ④ 真 cordis Context：依赖机制（**顺序无关**由 Cordis 保证，不由本行的写法保证）
// ============================================================================

describe('PRT-253 runtime-host-row（真 cordis Context）', () => {
  guarded('⑮ 组合根**后**加载时本行先 pending，服务一出现就自己激活', async () => {
    const ctx = new Context()
    provideLoader(ctx)
    ctx.provide('sandbox', { async confine(argv) { return { enforcement: 'full', argv: ['x', ...argv] } } })
    const undo = setDshRuntimeInputsFactory(() => inputsOk())
    const bound = []
    try {
      const row = await ctx.plugin(runtimeHostRow)
      await settle()
      // ① 服务还没来：**不许抛**，只许 pending（抛了它就再也不会自己恢复），
      //    而且**一次 bootstrap 都不许发生**。
      assert.equal(row._error, undefined, `组合根还没来就失败了：${row._error?.message ?? ''}`)
      assert.equal(bound.length, 0, '组合根还没发布，本行就已经绑定了——那是假的')

      // ② 组合根到了。形状与 `root-row.mjs` 发的一致：安装结果包着 `root`。
      ctx.provide(ENFORCEMENT_ROOT_SERVICE, {
        ok: true,
        code: null,
        message: null,
        root: {
          async bootstrap(deps) {
            bound.push(deps)
            return { ok: true, state: 'enforcement-effective', patchVersion: 1, checks: [], unbind: () => true }
          },
        },
      })
      await settle()
      assert.equal(bound.length, 1, '服务出现之后本行没有激活——依赖声明写错了')
      assert.equal(ctx.get(RUNTIME_HOST_BINDING_SERVICE, null)?.ok, true)
      assert.equal(row._error, undefined, `本行不该以失败收场：${row._error?.message ?? ''}`)
    } finally {
      undo()
    }
  })

  guarded('⑯ 反向控制：组合根**先**在时本行立即激活（不是"必须先"）', async () => {
    const ctx = new Context()
    provideLoader(ctx)
    ctx.provide('sandbox', { async confine(argv) { return { enforcement: 'full', argv: ['x', ...argv] } } })
    const bound = []
    ctx.provide(ENFORCEMENT_ROOT_SERVICE, {
      ok: true,
      code: null,
      message: null,
      root: {
        async bootstrap(deps) {
          bound.push(deps)
          return { ok: true, state: 'enforcement-effective', patchVersion: 1, checks: [], unbind: () => true }
        },
      },
    })
    const undo = setDshRuntimeInputsFactory(() => inputsOk())
    try {
      const row = await ctx.plugin(runtimeHostRow)
      await settle()
      assert.equal(bound.length, 1, '组合根先加载时反而没激活——依赖声明写错了')
      assert.equal(row._error, undefined)
    } finally {
      undo()
    }
  })

  guarded('⑰ 真 Context 里缺工厂时的**具名拒绝**：码是 `NO_INPUTS_FACTORY`', async () => {
    const ctx = new Context()
    provideLoader(ctx)
    ctx.provide('sandbox', { async confine() { return { enforcement: 'full', argv: ['x'] } } })
    ctx.provide(ENFORCEMENT_ROOT_SERVICE, {
      ok: true,
      code: null,
      message: null,
      root: { async bootstrap() { return { ok: true, state: 'enforcement-effective', patchVersion: 1, checks: [], unbind: () => true } } },
    })
    // cordis 在 `apply` 抛错时把错误**抛给** `await ctx.plugin()`（而不是塞进
    // `_error`），所以这里断言的是拒绝本身，不是"某个字段被设成了什么"。
    await assert.rejects(
      async () => { await ctx.plugin(runtimeHostRow) },
      (e) => {
        assert.equal(e.code, RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY)
        return true
      },
    )
  })
})

if (SKIP !== false) {
  test('PRT-253 runtime-host-row 的真 Context 部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
