// product/launcher/tray-wiring.test.mjs
// ============================================================================
// PRT-708「接线」的判据。
//
// 这一套件盯的**不是**菜单画得对不对（那是 `tray.test.mjs` 的事），
// 而是接线这一层有没有把两句话说成真的：
//
//   ① 「打开 Workbench」用**观测到的**地址 —— 计划里那个默认端口拼出来的
//      地址在 workbench 没就绪时**一个字都不许出去**；
//   ② 「退出」不许被接线层绕过 —— 观测到产品还在跑时，返回的必须是
//      `TRAY_QUIT_UNCONFIRMED`，并且托盘留着。
//
// 全程用**假的 launcher**：不起任何真进程；默认打开器那条路径也只换掉
// `spawn`，不打开任何浏览器。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { DEFAULT_PORTS } from '../process-manifest.mjs'
import { PRODUCT_STATE_TEXT } from './launcher.mjs'
import { READINESS_VERIFIED_CODE, readinessResultToDiagnostic } from './readiness.mjs'
import { TRAY_CODES, TRAY_MENU_IDS } from './tray.mjs'
import {
  NATIVE_ICON_SUPPORTED,
  NO_NATIVE_ICON_REASON,
  TRAY_WIRING_CODES,
  TRAY_WIRING_READINESS_VERIFIED,
  createLauncherTray,
  createPlatformOpener,
} from './tray-wiring.mjs'

/**
 * **计划里**那个地址：`ports.workbench ?? defaultPort` 拼出来的样子
 * （`process-manifest.mjs:282` 与 `:318`）。它是本套件要盯住"不许当回落"的东西。
 */
const PLAN_DEFAULT_WORKBENCH_URL = `http://127.0.0.1:${DEFAULT_PORTS.workbench}`

/**
 * **观测到的**那个地址：刻意与计划里的不同。
 * 用同一个字符串的话，"到底用了哪一个"就分不出来了——那种用例是绿的，
 * 但它证明不了任何事。
 */
const OBSERVED_WORKBENCH_URL = 'http://127.0.0.1:54321'

/**
 * 那个"就绪判据真的量过并过了"的码，**取自生产方**，不是取自已测模块。
 *
 * ★ 这一行是本套件的要害，第一版写反了：夹具原本 import 的是
 * `tray-wiring.mjs` 导出的那个常量——也就是**被测模块自己的期望值**。
 * 那是个恒真结构：模块若把码抄成字面量、生产方某天改了名，夹具与被测模块
 * **一起漂移**，用例照样全绿，而生产上「打开 Workbench」会安静地恒灰。
 *
 *   > 一个"用被测模块自己的常量来构造期望"的夹具，
 *   > 与一个"正确地跟着生产方"的断言，在没人改那个码的那些天里是同一个东西——
 *   > 只不过前者的绿是"两边一起错"换来的。
 *
 * 这里连字面量都不用，而是走一遍**生产方真正的转换函数**：下面的 `readiness`
 * 字段就是 `readinessResultToDiagnostic()` 在就绪时的真产物。于是"接线认不认
 * 这份记录"这件事，用的是生产方自己的读数，而不是我手写的一份期望。
 */
const VERIFIED_READINESS_CODE = READINESS_VERIFIED_CODE

/** workbench 那一行的一个"正常就绪"样本；覆盖字段即构造各种缺口。 */
function workbenchRow(overrides = {}) {
  return {
    key: 'workbench',
    label: 'Legion Workbench（指挥台静态服务与代理）',
    state: 'ready',
    pid: 4242,
    url: PLAN_DEFAULT_WORKBENCH_URL,
    port: DEFAULT_PORTS.workbench,
    // ★ 走生产方的转换函数，不手写 `{ code: ..., elapsedMs: ... }`。
    readiness: readinessResultToDiagnostic(
      'workbench',
      { url: PLAN_DEFAULT_WORKBENCH_URL, expectJson: { port: 1 } },
      { ok: true, elapsedMs: 12, attempts: [{}] },
    ),
    ...overrides,
  }
}

/** 一个**可控的** launcher 替身：只改字段、记账，不起进程。 */
function fakeLauncher({ state = 'unavailable', processes = [], onStart = null, onStop = null } = {}) {
  const box = { state, processes, startCalls: 0, stopCalls: 0, statusCalls: 0 }
  const launcher = {
    async start() {
      box.startCalls += 1
      if (typeof onStart === 'function') onStart(box)
      return { ok: true, phase: null, failures: [], states: box.processes, elapsedMs: 1 }
    },
    async stop() {
      box.stopCalls += 1
      if (typeof onStop === 'function') onStop(box)
      return { reason: '用例停止', results: [], states: box.processes }
    },
    status() {
      box.statusCalls += 1
      return {
        state: box.state,
        stateText: PRODUCT_STATE_TEXT[box.state] ?? String(box.state),
        scope: { partial: false, included: [], excluded: [] },
        processes: box.processes,
        needsAttention: [],
        readinessDiagnostics: [],
      }
    },
  }
  return { box, launcher }
}

/** 只换掉"起了哪个进程"，不换掉任何别的：用例永远不弹浏览器。 */
function fakeSpawnInto(spawned) {
  return (file, args, options) => {
    const rec = { file, args: Object.freeze([...args]), options, unref: false }
    spawned.push(rec)
    return {
      once(event, fn) {
        if (event === 'spawn') queueMicrotask(() => fn())
        return this
      },
      unref() { rec.unref = true; return this },
    }
  }
}

function byId(items, id) { return items.find((i) => i.id === id) }

// ── ① 观测：状态映射 + 地址只在"真的观测到就绪"时发布 ──────────────────────

test('① observe() 把 launcher 的产品状态搬进 runtimeState', async () => {
  for (const state of ['unavailable', 'starting', 'ready', 'degraded', 'upgrading']) {
    const { launcher, box } = fakeLauncher({
      state,
      processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL, port: 54321 })],
    })
    const w = createLauncherTray({ launcher })
    const o = await w.observe()
    assert.equal(o.runtimeState, state, `runtimeState 没有如实反映 launcher.status().state`)
    assert.ok(box.statusCalls > 0, 'observe() 根本没有去读 launcher.status()')
  }
})

test('① 读不到 `state` 时不冒充任何一个已知状态', async () => {
  const bare = {
    status: () => ({ processes: [] }),
    start: async () => ({ ok: true }),
    stop: async () => ({}),
  }
  const w = createLauncherTray({ launcher: bare })
  const o = await w.observe()
  assert.equal(o.runtimeState, null)
  // 状态未知时菜单仍然渲染，「退出」仍然可点（用户不能被困住）
  const m = await w.menu()
  assert.equal(byId(m.items, 'quit').enabled, true)
})

test('① ★ 只有 workbench 被**观测到就绪**时才发布地址（并因此可点）', async () => {
  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL, port: 54321 })],
  })
  const w = createLauncherTray({ launcher })
  const o = await w.observe()
  assert.equal(o.workbenchUrl, OBSERVED_WORKBENCH_URL)
  // ★ 计划里的那个默认端口**没有被用**：地址来自那一行，不是来自配置/清单默认值。
  assert.ok(!o.workbenchUrl.includes(String(DEFAULT_PORTS.workbench)),
    `地址里出现了计划默认端口 ${DEFAULT_PORTS.workbench}：${o.workbenchUrl}`)
  const item = byId((await w.menu()).items, 'open-workbench')
  assert.equal(item.enabled, true)
  assert.equal(item.disabledReason, null)
})

test('① ★★ 计划里的默认端口**不是**回落：workbench 没就绪时菜单项灰掉并给出理由', async () => {
  // ★ 这是本套件的核心。
  //
  //   注意每一行给的 `url` 都是**完全合法的**（就是计划里那个配置默认端口拼出来的
  //   地址），唯一的区别是它**没有**一条"就绪判据真的量过并且过了"的记录。
  //   一个 `workbenchUrl = proc?.url ?? null` 的实现在这里会把地址发出去，
  //   菜单项可点，而用户点开得到的是"浏览器打不开这个页面"。
  const cases = [
    { name: '进程还在起', state: 'starting', processes: () => [workbenchRow({ state: 'starting', pid: null, readiness: null })] },
    { name: '标着 ready 但没有验证记录', state: 'ready', processes: () => [workbenchRow({ state: 'ready', readiness: null })] },
    // 这两行的 `readiness` 也走生产方的失败路径：`readinessResultToDiagnostic()`
    // 在 `ok !== true` 时按成因给出 `READINESS_FAILED` / `READINESS_TIMEOUT`。
    // 手写这两个码等于把生产方的分类抄一遍，抄错了这条用例也照样绿。
    {
      name: '标着 ready 但判据是失败的',
      state: 'degraded',
      processes: () => [workbenchRow({
        state: 'ready',
        readiness: readinessResultToDiagnostic('workbench', { url: PLAN_DEFAULT_WORKBENCH_URL },
          { ok: false, code: 'http-status-mismatch', elapsedMs: 30, attempts: [{}] }),
      })],
    },
    {
      name: '标着 ready 但判据超时了',
      state: 'degraded',
      processes: () => [workbenchRow({
        state: 'ready',
        readiness: readinessResultToDiagnostic('workbench', { url: PLAN_DEFAULT_WORKBENCH_URL },
          { ok: false, code: 'readiness-timeout', elapsedMs: 30000, attempts: [{}] }),
      })],
    },
    { name: '就绪了但没有地址', state: 'ready', processes: () => [workbenchRow({ url: null, port: null })] },
    { name: '这次启动根本没包含 workbench', state: 'ready', processes: () => [] },
  ]
  for (const c of cases) {
    const { launcher } = fakeLauncher({ state: c.state, processes: c.processes() })
    const w = createLauncherTray({ launcher })
    const o = await w.observe()
    assert.equal(o.workbenchUrl, null, `${c.name}：计划里的地址被当成了观测结果`)
    assert.ok(typeof o.detail === 'string' && o.detail.length > 0, `${c.name}：没有说为什么`)
    assert.ok(!String(o.detail).includes(PLAN_DEFAULT_WORKBENCH_URL), `${c.name}：把计划地址写进了读数`)
    const item = byId((await w.menu()).items, 'open-workbench')
    assert.equal(item.enabled, false, `${c.name}：地址没观测到，菜单项却是可点的`)
    assert.ok(typeof item.disabledReason === 'string' && item.disabledReason.length > 0,
      `${c.name}：灰掉了却不说为什么`)
  }
})

test('① ★ 观测到的地址不是 http(s) 时按"没观测到"处理（不给浏览器一个垃圾串）', async () => {
  const { launcher } = fakeLauncher({ state: 'ready', processes: [workbenchRow({ url: 'not a url' })] })
  const w = createLauncherTray({ launcher })
  const o = await w.observe()
  assert.equal(o.workbenchUrl, null)
  assert.ok(o.detail.includes('http'), o.detail)
  assert.equal(byId((await w.menu()).items, 'open-workbench').enabled, false)
})

// ── ② 启动 / 停止 / 退出的转发 ─────────────────────────────────────────────

test('① ★★ 接线认的那个码**就是生产方写的那个码**（跨模块不许有两份字面量）', () => {
  // 这条断言很小，但它守的是一类安静的失败：接线把生产方的码**抄成字面量**。
  // 抄了之后，生产方某天改名，接线那道闸
  // `proc?.readiness?.code !== <抄来的字面量>` 就**永远为真**——
  // 「打开 Workbench」从此恒灰，而没有任何东西报错。
  //
  //   > 一个"由生产方写死、消费方再抄一遍"的码，
  //   > 与一个"从生产方引用过来"的码，在生产方不改它的那些天里是同一个东西——
  //   > 只不过前者会在改名那天安静地把功能关掉。
  //
  // 上面那条正向用例喂的是**生产方真产物**，所以"抄一份"会同时让这条与那条红。
  assert.equal(TRAY_WIRING_READINESS_VERIFIED, READINESS_VERIFIED_CODE)
  assert.equal(VERIFIED_READINESS_CODE, READINESS_VERIFIED_CODE)
  // 而且生产方就绪时的真产物，其 `code` 必须正是这个值——
  // 否则上面那些"正常就绪"样本喂进去的东西根本不是接线的通行证。
  assert.equal(workbenchRow().readiness.code, READINESS_VERIFIED_CODE)
})

test('② start 与 stop 被转发到 launcher（接线层不夹带第二套判据）', async () => {
  const stopped = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL })],
    onStop: (box) => { box.state = 'unavailable'; box.processes = [] },
  })
  const w1 = createLauncherTray({ launcher: stopped.launcher })
  const r1 = await w1.invoke('stop')
  assert.equal(stopped.box.stopCalls, 1)
  assert.equal(stopped.box.startCalls, 0)
  assert.equal(r1.ok, true)
  assert.equal(r1.state, 'unavailable')

  const started = fakeLauncher({ state: 'unavailable', processes: [] })
  const w2 = createLauncherTray({ launcher: started.launcher })
  const r2 = await w2.invoke('start')
  assert.equal(started.box.startCalls, 1)
  assert.equal(started.box.stopCalls, 0, '「启动」顺手停了一次')
  assert.equal(r2.ok, true)
})

test('② ★★ 退出后观测到还在跑时**不确认退出**，并说明托盘还留着', async () => {
  // `stop()` 被调了、也返回了 —— 但**重新观测**看到的仍然是运行中。
  // 这正是"把图标藏起来而进程还在跑"那个形状，接线层不许把它变成成功。
  const { box, launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL })],
    // onStop 刻意什么都不改：产品没停下来
  })
  const w = createLauncherTray({ launcher })
  const r = await w.invoke('quit')
  assert.equal(box.stopCalls, 1, '退出根本没有去停产品')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
  assert.equal(r.exited, undefined, '没确认停下来却给了"可以退出"')
  assert.ok(r.message.includes('托盘会继续留着'), r.message)
  assert.ok(w.diagnostics().some((d) => d.code === TRAY_CODES.QUIT_UNCONFIRMED && d.severity === 'error'),
    '没确认退出却没有一条 error 级诊断')
  // 托盘还在：菜单照样渲染、动作照样能点（用户还能再试一次）
  const m = await w.menu()
  assert.equal(m.observed, true)
  assert.equal(byId(m.items, 'quit').enabled, true)
})

test('② 退出确认之后才允许退出（正向对照）', async () => {
  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL })],
    onStop: (box) => { box.state = 'unavailable'; box.processes = [] },
  })
  const w = createLauncherTray({ launcher })
  const r = await w.invoke('quit')
  assert.equal(r.ok, true)
  assert.equal(r.exited, true)
  assert.equal(r.state, 'unavailable')
})

// ── ③ 打开 Workbench 用观测到的地址 ────────────────────────────────────────

test('③ openExternal 收到的是**观测到的**地址', async () => {
  const opened = []
  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL, port: 54321 })],
  })
  const w = createLauncherTray({ launcher, openExternal: async (u) => { opened.push(u) } })
  const r = await w.invoke('open-workbench')
  assert.equal(r.ok, true)
  assert.deepEqual(opened, [OBSERVED_WORKBENCH_URL])
})

test('③ 没观测到地址时**从不**调用 openExternal', async () => {
  const opened = []
  const { launcher } = fakeLauncher({
    state: 'starting',
    processes: [workbenchRow({ state: 'starting', pid: null, readiness: null })],
  })
  const w = createLauncherTray({ launcher, openExternal: async (u) => { opened.push(u) } })
  const r = await w.invoke('open-workbench')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.WORKBENCH_NOT_READY)
  assert.deepEqual(opened, [])
})

test('③ 默认打开器：只换掉 spawn，用例绝不弹浏览器', async () => {
  const spawned = []
  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL, port: 54321 })],
  })
  const w = createLauncherTray({ launcher, platform: 'win32', spawnImpl: fakeSpawnInto(spawned) })
  const r = await w.invoke('open-workbench')
  assert.equal(r.ok, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].file, 'cmd')
  assert.deepEqual([...spawned[0].args], ['/c', 'start', '', `"${OBSERVED_WORKBENCH_URL}"`])
  assert.equal(spawned[0].unref, true, 'detached 的子进程没有 unref，会把托盘进程拖住')
})

test('③ 默认打开器只接受 http(s) 地址', async () => {
  const spawned = []
  const open = createPlatformOpener({ platform: 'win32', spawnImpl: fakeSpawnInto(spawned) })
  await assert.rejects(() => open('not a url'), (e) => e.code === TRAY_WIRING_CODES.OPEN_BAD_URL)
  await assert.rejects(() => open('file:///etc/passwd'), (e) => e.code === TRAY_WIRING_CODES.OPEN_BAD_URL)
  assert.equal(spawned.length, 0)
})

test('③ 没有既定打开方式的平台：报 OPEN_FAILED，而不是静默成功', async () => {
  const spawned = []
  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL })],
  })
  const w = createLauncherTray({ launcher, platform: 'aix', spawnImpl: fakeSpawnInto(spawned) })
  const r = await w.invoke('open-workbench')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.OPEN_FAILED)
  assert.ok(r.message.includes('aix'), r.message)
  assert.equal(spawned.length, 0)
})

// ── ④ 诚实边界：本模块不产生原生图标 ──────────────────────────────────────

test('④ ★ 本模块不产生原生托盘图标（诚实边界）', async () => {
  assert.equal(NATIVE_ICON_SUPPORTED, false)
  assert.ok(NO_NATIVE_ICON_REASON.includes('不产生原生托盘图标'), NO_NATIVE_ICON_REASON)
  assert.ok(NO_NATIVE_ICON_REASON.includes('原生外壳'), NO_NATIVE_ICON_REASON)

  const { launcher } = fakeLauncher({
    state: 'ready',
    processes: [workbenchRow({ url: OBSERVED_WORKBENCH_URL })],
  })
  const w = createLauncherTray({ launcher })
  assert.equal(w.nativeIcon, false)
  assert.equal(w.iconNotice, NO_NATIVE_ICON_REASON)

  // 它交出去的渲染面只有"菜单模型 + 动作派发"——图标由原生外壳去画。
  const m = await w.menu()
  assert.deepEqual(m.items.map((i) => i.id), [...TRAY_MENU_IDS])
  assert.equal(typeof w.tray, 'object')
  assert.equal(typeof w.tray.invoke, 'function')

  // ★ 静态边界：**没有原生绑定被拉进来**（systray / node-tray / electron ...）——
  //   一个"真的生成了图标"的实现不可能不 import 点什么来做这件事。
  //
  //   这里断言的是那条**性质**，不是一份写死的清单。第一版写的是
  //   `assert.deepEqual(specifiers, ['node:child_process', './tray.mjs'])`，
  //   它在本模块**变好**的那一天红了：`READINESS_VERIFIED` 那个码原本是从
  //   `readiness.mjs` 抄来的字面量，改成从生产方引用之后就多了一条内部 import。
  //
  //     > 一个"清单必须逐字相等"的断言，
  //     > 与一个"不许出现第三方/原生依赖"的断言，
  //     > 在没人动 import 的那些天里是同一个东西——
  //     > 只不过前者会在加一条**正当的**内部 import 时红，
  //     > 而那条红说的是"你改的不是我要守的东西"。
  //
  //   所以：node 内建允许，同目录的内部模块允许，**第三方包一律不允许**。
  const src = readFileSync(new URL('./tray-wiring.mjs', import.meta.url), 'utf8')
  const specifiers = [...src.matchAll(/^\s*import\s[^\n]*from\s+'([^']+)'/gm)].map((mm) => mm[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) {
    assert.ok(
      s.startsWith('node:') || s.startsWith('./'),
      `拖进来了一个非内建、非同目录的依赖（原生托盘绑定就是这么进来的）：${s}`,
    )
  }
  // 反向钉住：那几个真能画图标的包名一个都不许出现。
  for (const banned of ['systray', 'node-tray', 'electron', 'trayicon', 'node-notifier']) {
    assert.ok(!specifiers.some((s) => s.includes(banned)), `不许 import ${banned}`)
  }
})

// ── ⑤ 接不上的时候要有话 ───────────────────────────────────────────────────

test('⑤ 没有 launcher 时给出具名拒绝，而不是一个假装能用的托盘', async () => {
  const w = createLauncherTray()
  assert.equal(w.ok, false)
  assert.equal(w.code, TRAY_WIRING_CODES.MISSING_LAUNCHER)
  assert.equal(w.tray, null)
  assert.equal((await w.invoke('start')).code, TRAY_WIRING_CODES.MISSING_LAUNCHER)
  assert.equal((await w.menu()).ok, false)
  assert.equal(w.nativeIcon, false)
})

test('⑤ 装配抛错时兜住并报 FAILED（不把半成品交出去）', () => {
  const { launcher } = fakeLauncher({})
  const w = createLauncherTray({ launcher, trayFactory: () => { throw new Error('工厂炸了') } })
  assert.equal(w.ok, false)
  assert.equal(w.code, TRAY_WIRING_CODES.FAILED)
  assert.ok(w.message.includes('工厂炸了'), w.message)
  assert.equal(w.tray, null)
})
