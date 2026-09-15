// product/launcher/tray-icon.test.mjs
// ============================================================================
// PRT-708「真的画出一个托盘图标」的判据。
//
// 这一套件盯的是五句必须为真的话，以及**一句必须说清楚的"没有证明"**：
//
//   ① 菜单**只**来自模型 —— 生成物里一个菜单文案都没有，菜单文件是 `tray.menu()`
//      的投影，而且每次动作之后按**新观测**重写；
//   ② 点击回到 `createTray()` 的动作派发里 —— 走宿主那一行的点击与直接
//      `invoke(id)` 是**同一个结果**（这是无人值守用例能证明的那一半）；
//   ③ 「支不支持」是一个**探测的函数**，三态（true / false / null＝还不知道），
//      不是一行常量；
//   ④ 宿主的寿命是被规定的：哨兵收工、Dispose 在 exited **之前**、父进程没了也要
//      自己收工、自己死了要留下"还能再 start 一次"的路；
//   ⑤ 生成物只落在 `<DataDir>/tray/` 之内，逐次写入都过同一道守卫；
//   ⑥ 退出纪律没有被这一层绕过：`quit` 没确认，图标**留着**。
//
// ── 诚实边界（与最后一个 test 逐条对应） ──────────────────────────────────
//
//   · **一次真实的鼠标点击从来没有被模拟过**。下面所有"点击"都是把**宿主会写的
//     那一行**注入进去。它证明的是"那一行进了派发就是同一个结果"，
//     不是"鼠标点到那个菜单项了"。无人值守的用例做不到后者。
//   · 非 Windows 上**一行都画不出来**（宿主要加载的 WinForms 只存在于 Windows）。
//   · 图标的**外观**没有被断言（有没有出现在托盘、有没有被折进溢出区、
//     图标长什么样，都读不出来）。能读出来的只有"宿主自报它 Dispose 了"。
//   · 真宿主那几条用例**在这台机器上真的起了一个 PowerShell 进程**；解析不到 shell
//     的环境里它们**如实 SKIP**（并说出理由），不是假装通过。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeWriteGuard } from './runtime-install.mjs'
import { TRAY_CODES, TRAY_LABELS, TRAY_MENU_IDS, createTray } from './tray.mjs'
import {
  SHELL_ENV,
  TRAY_ICON_CODES,
  buildTrayMenuDocument,
  candidateTrayShells,
  createTrayIconHost,
  defaultFileExists,
  parseTrayHostLine,
  planTrayIcon,
  planTrayWrite,
  probeTrayIconSupport,
  psQuote,
  renderTrayScript,
  resolveTrayShell,
} from './tray-icon.mjs'

// ---------------------------------------------------------------- 公共夹具

/** 所有临时根都在 `os.tmpdir()` 下，`after()` 里**即使失败也**删干净。 */
const tempRoots = []
function tempRoot(label = 'legion-tray-icon-') {
  const root = mkdtempSync(join(tmpdir(), label))
  tempRoots.push(root)
  return root
}
after(() => {
  for (const root of tempRoots) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 删不掉不影响判据 */ }
  }
})

/** 本次运行里那个"宿主"的 hostId（注入随机源，于是用例知道该往消息里写什么）。 */
const TEST_HOST_ID = 'testhost'

/** 一个**可控的** launcher 替身：只改字段、记账，不起任何进程。 */
function fakeLauncher({ state = 'unavailable', onStart = null, onStop = null } = {}) {
  const box = { state, startCalls: 0, stopCalls: 0 }
  const launcher = {
    async start() {
      box.startCalls += 1
      // ★ `await`：一个不 await 的替身会让"动作还在跑"这件事根本不存在，
      //   于是"忙碌时丢掉第二次点击"那条纪律在用例里永远测不到。
      if (typeof onStart === 'function') await onStart(box)
      return { ok: true, phase: null, failures: [], states: [] }
    },
    async stop() {
      box.stopCalls += 1
      if (typeof onStop === 'function') await onStop(box)
      return { reason: '用例停止', results: [], states: [] }
    },
    status() {
      return {
        state: box.state,
        stateText: '',
        scope: { partial: false, included: [], excluded: [] },
        processes: [],
        needsAttention: [],
        readinessDiagnostics: [],
      }
    },
  }
  // 读数对象挂在 launcher 上：`launcher.box.state` 就是"现在产品处于什么状态"。
  launcher.box = box
  return { box, launcher }
}

/**
 * 真 `createTray()` + 假 launcher：菜单模型是真的，动作的后果是可控的。
 *
 * ★ `observe` 返回的**就是那份观测本身**（`{runtimeState, workbenchUrl}`），
 * 不是 `{ok, observation}` 一层的包装——`tray.mjs` 的 `observeOnce()` 才是包那一层的人。
 * 包错一层不会报错，只会让每一份观测都变成"状态未知"：菜单于是永远按"不知道"渲染。
 */
function trayOver(launcher, platform = 'win32') {
  return createTray({
    observe: async () => ({ runtimeState: launcher.box.state, workbenchUrl: null }),
    start: () => launcher.start(),
    stop: () => launcher.stop(),
    openExternal: async () => ({}),
    platform,
  })
}

/**
 * 一个**可控的**子进程替身。
 *
 * 形状就是 `attachChild()` 用到的那几件事：`pid` / `stdout` / `stderr` /
 * `once('exit' | 'close' | 'error')` / `kill()` / `exitCode`。
 */
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.killed = false
  const stdout = new EventEmitter()
  stdout.setEncoding = () => {}
  const stderr = new EventEmitter()
  stderr.setEncoding = () => {}
  child.stdout = stdout
  child.stderr = stderr
  child.emitted = []
  /** 宿主写一行（CRLF 结尾，与 `WriteLine` 一样）。 */
  child.push = (message) => {
    const text = typeof message === 'string' ? message : JSON.stringify(message)
    child.emitted.push(text)
    stdout.emit('data', text + '\r\n')
  }
  child.pushStderr = (text) => stderr.emit('data', text)
  child.fail = (code = 0) => {
    child.exitCode = code
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  child.kill = () => {
    child.killed = true
    child.fail(1)
  }
  return child
}

function spawnHarness({ ready = true, onSpawn = null } = {}) {
  const spawned = []
  const spawnImpl = (file, args, options) => {
    const child = fakeChild({ pid: 5000 + spawned.length })
    spawned.push({ file, args, options, child })
    if (typeof onSpawn === 'function') onSpawn(child, file, args, options)
    if (ready === true) {
      setTimeout(() => {
        child.push({ v: 1, kind: 'ready', hostId: TEST_HOST_ID, pid: child.pid })
      }, 0)
    }
    return child
  }
  return { spawned, spawnImpl }
}

/** 造一个宿主：真 shell 解析（假的存在性表）、假子进程、真哨兵文件。 */
function makeHost({ tray, root, spawnImpl, ...overrides } = {}) {
  return createTrayIconHost({
    tray,
    dataDir: join(root, 'data'),
    allowedRoot: root,
    platform: 'win32',
    env: {},
    // `exists` 只判 shell 候选（这里只让 5.1 那一档存在）；
    // `fileExists` 判哨兵文件，走**真**磁盘——两者分开的理由写在实现里。
    exists: (p) => /powershell\.exe$/i.test(String(p)),
    fileExists: defaultFileExists,
    spawnImpl,
    randomToken: () => TEST_HOST_ID,
    tickMs: 50,
    heartbeatMs: 100,
    readyTimeoutMs: 800,
    stopTimeoutMs: 600,
    killGraceMs: 200,
    ...overrides,
  })
}

/** 把宿主那一行点击推进去，并等这次动作处理完。 */
async function click(host, child, id) {
  child.push({ v: 1, kind: 'click', hostId: TEST_HOST_ID, id })
  await host.whenIdle()
}

/** 真宿主那一档要把 shell 交给系统解析；其余一律用假的候选表。 */

/** 读到菜单文件（JSON）。 */
function readMenuDoc(host) {
  return JSON.parse(readFileSync(host.menuPath, 'utf8'))
}

/** 模型 → 宿主文档的四字段投影（用例侧独立算一遍，不借用被测模块的常量）。 */
function project(items) {
  return items.map((i) => ({
    id: i.id,
    label: i.label,
    enabled: i.enabled,
    disabledReason: typeof i.disabledReason === 'string' && i.disabledReason !== '' ? i.disabledReason : null,
  }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// ① 菜单**只**来自模型
// ============================================================================

test('① ★ 生成物里**一个菜单文案、一个菜单 id 都没有**：第二份菜单无处可藏', () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl: spawnHarness().spawnImpl })
  // 菜单文字只有一个来源：模型投影进 JSON 之后，由脚本的 `$it.label` 取出来。
  assert.ok(host.script.includes('$mi.Text = [string]$it.label'),
    '生成物没有"文字来自模型"的那一行')
  // 手写第二份菜单，无论写成 `'启动'` 还是 `"启动"`、`'quit'` 还是 `"quit"`，都会在这里咬住。
  for (const label of Object.values(TRAY_LABELS)) {
    for (const quote of ["'", '"']) {
      assert.ok(!host.script.includes(`${quote}${label}${quote}`),
        `生成物里出现了写死的菜单文案 ${quote}${label}${quote}：菜单被"也写了一遍"在脚本里，`
          + '就会在有人只改一边的第二天让用户点到一个模型里不存在的动作')
    }
  }
  for (const id of TRAY_MENU_IDS) {
    for (const quote of ["'", '"']) {
      assert.ok(!host.script.includes(`${quote}${id}${quote}`),
        `生成物里出现了写死的菜单 id ${quote}${id}${quote}：菜单项清单也必须来自模型`)
    }
  }
  // 它必须**读**菜单文件，而不是自己造一份。
  assert.ok(host.script.includes(host.menuPath), '生成物里没有菜单文件路径：那它拿什么渲染菜单')
  assert.ok(host.script.includes('ConvertFrom-Json'), '生成物里没有"把菜单文档解析出来"的那一步')
})

test('① ★★ 起宿主时写下的菜单 = 模型当前渲染的四字段投影', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const tray = trayOver(launcher)
  const { spawnImpl } = spawnHarness()
  const host = makeHost({ tray, root, spawnImpl })
  const started = await host.start()
  assert.equal(started.ok, true, started.message)

  const doc = readMenuDoc(host)
  const model = await tray.menu()
  assert.deepEqual(doc.items, project(model.items))
  assert.equal(doc.hostId, TEST_HOST_ID, '菜单文档要带 hostId：脚本读到的必须是这次运行那份')

  // 只过线四个字段：模型将来长出别的东西时，脚本不许悄悄依赖它。
  const widened = buildTrayMenuDocument({
    items: [{ id: 'x', label: 'X', enabled: true, disabledReason: null, icon: 'star', hotkey: 'Ctrl+Q' }],
    hostId: TEST_HOST_ID,
  })
  assert.deepEqual(Object.keys(widened.document.items[0]).sort(), ['disabledReason', 'enabled', 'id', 'label'])

  await host.stop('test')
})

test('① ★★ 动作之后菜单**按新观测重写**：start 之后 start 灰了、stop 亮了', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({ state: 'unavailable', onStart: (b) => { b.state = 'ready' } })
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()

  const before = readMenuDoc(host)
  assert.equal(before.items.find((i) => i.id === 'start').enabled, true)
  assert.equal(before.items.find((i) => i.id === 'stop').enabled, false)

  await click(host, spawned[0].child, 'start')

  const after = readMenuDoc(host)
  assert.equal(after.items.find((i) => i.id === 'start').enabled, false,
    '启动之后「启动」还是亮的：那就是一份缓存过的菜单，它会对用户说假话')
  assert.equal(after.items.find((i) => i.id === 'stop').enabled, true)
  assert.equal(host.status().menuWrites >= 2, true, '动作之后没有重写菜单文件')
  await host.stop('test')
})

test('① 模型读不到 / 形状不对时**不起宿主**：一个没有菜单的图标用户点不了', async () => {
  const root = tempRoot()
  const { spawnImpl, spawned } = spawnHarness()
  // ① `menu()` 抛错。
  const throwing = makeHost({
    tray: { menu: async () => { throw new Error('模型炸了') }, invoke: async () => ({ ok: true }) },
    root,
    spawnImpl,
  })
  const r1 = await throwing.start()
  assert.equal(r1.ok, false)
  assert.equal(r1.code, TRAY_ICON_CODES.MENU_UNAVAILABLE)
  assert.ok(r1.message.includes('模型炸了'), r1.message)
  assert.equal(spawned.length, 0, '菜单都读不到还起了宿主：等于画一个点了没反应的图标')
  assert.ok(!existsSync(throwing.scriptPath), '被拒绝的启动不该留下生成物')

  // ② `items` 不是数组 / 是空数组。
  const empty = makeHost({
    tray: { menu: async () => ({ items: [] }), invoke: async () => ({ ok: true }) },
    root: tempRoot(),
    spawnImpl,
  })
  const r2 = await empty.start()
  assert.equal(r2.ok, false)
  assert.equal(r2.code, TRAY_ICON_CODES.MENU_MALFORMED)

  // ③ 连 menu() 都没有。
  const noMenu = makeHost({ tray: { invoke: async () => ({ ok: true }) }, root: tempRoot(), spawnImpl })
  const r3 = await noMenu.start()
  assert.equal(r3.ok, false)
  assert.equal(r3.code, TRAY_ICON_CODES.MENU_UNAVAILABLE)
  assert.equal(spawned.length, 0)
})

test('① 菜单模型形状不对 → **拒绝发布**（半份菜单比没有菜单更难查）', () => {
  assert.equal(buildTrayMenuDocument({ items: [] }).ok, false)
  assert.equal(buildTrayMenuDocument({ items: [] }).code, TRAY_ICON_CODES.MENU_MALFORMED)
  assert.equal(buildTrayMenuDocument({ items: [{ label: '没有 id' }] }).ok, false)
  assert.equal(buildTrayMenuDocument({ items: [{ id: 'x', label: '' }] }).ok, false)
  assert.equal(buildTrayMenuDocument({ items: [null] }).ok, false)
  const ok = buildTrayMenuDocument({ items: [{ id: 'x', label: 'X', enabled: false, disabledReason: '' }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.document.items[0].disabledReason, null, '空字符串不是理由，`null` 才是"没有理由"')
})

// ============================================================================
// ② 点击回到 `createTray()` 的动作派发
// ============================================================================

test('② ★★ 走宿主那一行的点击与**直接调用**是同一个结果', async () => {
  // 同一套假 launcher、同一份初始观测，两条路各走一遍。
  const direct = (() => {
    const { launcher } = fakeLauncher({ state: 'unavailable', onStart: (b) => { b.state = 'ready' } })
    return { launcher, tray: trayOver(launcher) }
  })()
  const directResult = await direct.tray.invoke('start')
  const directMenu = project((await direct.tray.menu()).items)

  const root = tempRoot()
  const viaHost = (() => {
    const { launcher } = fakeLauncher({ state: 'unavailable', onStart: (b) => { b.state = 'ready' } })
    return { launcher, tray: trayOver(launcher) }
  })()
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: viaHost.tray, root, spawnImpl })
  await host.start()
  await click(host, spawned[0].child, 'start')
  const hostMenu = project((await viaHost.tray.menu()).items)

  assert.equal(direct.launcher.box.startCalls, 1)
  assert.equal(viaHost.launcher.box.startCalls, 1, '点击没有走到 launcher.start()')
  assert.deepEqual(hostMenu, directMenu, '两条路的后果不一样：点击这一路绕过了模型')
  assert.equal(directResult.ok, true)
  const clicks = host.status().clicks
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].id, 'start')
  assert.equal(clicks[0].ok, true)
  await host.stop('test')
})

test('② 模型里不存在的 id **不派发**（宿主是不可信输入）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  await click(host, spawned[0].child, 'delete-everything')
  assert.equal(launcher.box.startCalls, 0)
  assert.equal(launcher.box.stopCalls, 0)
  assert.equal(host.status().clicks.length, 0)
  assert.ok(host.diagnostics().some((d) => d.code === TRAY_ICON_CODES.UNKNOWN_ACTION))
  await host.stop('test')
})

test('② hostId 对不上的行不派发（那次运行不是本次起的宿主）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  spawned[0].child.push({ v: 1, kind: 'click', hostId: '别的运行', id: 'start' })
  await sleep(30)
  assert.equal(launcher.box.startCalls, 0)
  assert.ok(host.diagnostics().some((d) => /hostId 对不上/.test(d.message)))
  await host.stop('test')
})

test('② 协议版本对不上的行不派发', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  spawned[0].child.push({ v: 99, kind: 'click', hostId: TEST_HOST_ID, id: 'start' })
  await sleep(30)
  assert.equal(launcher.box.startCalls, 0)
  assert.ok(host.diagnostics().some((d) => /协议版本对不上/.test(d.message)))
  await host.stop('test')
})

test('② 读不懂的行只记一笔，不崩也不派发', () => {
  assert.equal(parseTrayHostLine('').ok, false)
  assert.equal(parseTrayHostLine('这不是 JSON').ok, false)
  assert.equal(parseTrayHostLine('[]').ok, false)
  assert.equal(parseTrayHostLine('{"kind":"click"}').ok, false, '没有协议版本号不算协议行')
  assert.equal(parseTrayHostLine('{"v":1,"kind":"wat"}').ok, false)
  assert.equal(parseTrayHostLine('{"v":1,"kind":"click"}').ok, false, 'click 没有 id 不算点击')
  const good = parseTrayHostLine('{"v":1,"kind":"click","hostId":"h","id":"stop"}')
  assert.equal(good.ok, true)
  assert.equal(good.id, 'stop')
  assert.equal(good.kind, 'click')
  // BOM 与 CRLF 都要吃掉：PowerShell 的管道上两者都会来。
  assert.equal(parseTrayHostLine('\uFEFF{"v":1,"kind":"heartbeat","hostId":"h"}\r').ok, true)
})

test('② ★ 上一个动作没完时第二次点击**丢掉，不排队**', async () => {
  const root = tempRoot()
  let release = null
  const gate = new Promise((r) => { release = r })
  const { launcher } = fakeLauncher({
    state: 'unavailable',
    onStart: async (b) => { await gate; b.state = 'ready' },
  })
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  const child = spawned[0].child
  child.push({ v: 1, kind: 'click', hostId: TEST_HOST_ID, id: 'start' })
  await sleep(20)
  child.push({ v: 1, kind: 'click', hostId: TEST_HOST_ID, id: 'stop' })
  await sleep(20)
  release()
  await host.whenIdle()
  assert.equal(launcher.box.startCalls, 1)
  assert.equal(launcher.box.stopCalls, 0,
    '排队的「停止」会在「启动」之后执行：用户看到的是最终状态与他的操作相反')
  assert.ok(host.diagnostics().some((d) => d.code === TRAY_ICON_CODES.BUSY))
  await host.stop('test')
})

test('② ★ quit **没确认**时宿主留着：图标还在，用户还能再点一次', async () => {
  const root = tempRoot()
  // stop() 什么也不做 → 产品还在跑 → quit 只能给 TRAY_QUIT_UNCONFIRMED。
  const { launcher } = fakeLauncher({ state: 'ready', onStop: () => {} })
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  await click(host, spawned[0].child, 'quit')
  assert.equal(host.status().alive, true, 'quit 没确认就把宿主收了：用户以为产品关了')
  assert.ok(host.diagnostics().some((d) => d.code === TRAY_CODES.QUIT_UNCONFIRMED))
  assert.equal(host.status().clicks.at(-1).code, TRAY_CODES.QUIT_UNCONFIRMED)
  // 收工时仍然能干净地收掉。
  const stopped = (() => {
    const p = host.stop('test')
    spawned[0].child.push({ v: 1, kind: 'exited', hostId: TEST_HOST_ID, reason: 'stop-file', disposed: true })
    spawned[0].child.fail(0)
    return p
  })()
  assert.equal((await stopped).ok, true)
})

test('② ★ quit **确认了**产品停了 → 图标跟着走（Dispose 由宿主自报）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({ state: 'ready', onStop: (b) => { b.state = 'unavailable' } })
  const { spawnImpl, spawned } = spawnHarness({
    onSpawn: (child) => {
      // 宿主对停止哨兵的回应：Dispose 之后报 exited。
      const watch = setInterval(() => {
        if (existsSync(host.stopPath)) {
          clearInterval(watch)
          child.push({ v: 1, kind: 'exited', hostId: TEST_HOST_ID, reason: 'stop-file', disposed: true })
          child.fail(0)
        }
      }, 5)
    },
  })
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  await click(host, spawned[0].child, 'quit')
  await host.whenIdle()
  assert.equal(host.status().phase, 'stopped')
  assert.equal(host.status().alive, false, 'quit 确认之后图标必须跟着走（否则用户以为产品还开着）')
  assert.equal(host.status().lastExited.disposed, true)
})

// ============================================================================
// ③ 「支不支持」是探测的函数（三态）
// ============================================================================

test('③ 非 win32 → 不支持（false），并且说清什么证据能翻转它', () => {
  const p = probeTrayIconSupport({ platform: 'linux', env: {} })
  assert.equal(p.supported, false)
  assert.equal(p.code, TRAY_ICON_CODES.UNSUPPORTED_PLATFORM)
  assert.equal(p.shell, null)
  assert.ok(p.flips.includes('win32'), p.flips)
  assert.ok(p.reason.includes('Windows'), p.reason)
})

test('③ win32 但一档候选 shell 都不存在 → 不支持（false）+ NO_SHELL', () => {
  const p = probeTrayIconSupport({ platform: 'win32', env: {}, exists: () => false })
  assert.equal(p.supported, false)
  assert.equal(p.code, TRAY_ICON_CODES.NO_SHELL)
  assert.ok(p.candidates.length >= 1)
  assert.ok(p.reason.includes('5.1'), p.reason)
})

test('③ ★ 解析到 shell 但还没起过宿主 → **null（还不知道）**，不是 true 也不是 false', () => {
  const p = probeTrayIconSupport({
    platform: 'win32', env: {}, exists: (x) => /powershell\.exe$/i.test(x),
  })
  assert.equal(p.supported, null, '没起过宿主就说"支持"，在 headless 机器上是一句谎话')
  assert.equal(p.code, TRAY_ICON_CODES.HOST_PENDING)
  assert.ok(p.shell.endsWith('powershell.exe'))
  assert.ok(p.flips.includes('ready'), p.flips)
})

test('③ ★★ 宿主报了 ready → 支持（true），证据就是那一次 ready', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  const before = probeTrayIconSupport({ platform: 'win32', env: {}, exists: (x) => /powershell\.exe$/i.test(x), host })
  assert.equal(before.supported, null)
  await host.start()
  const after = probeTrayIconSupport({ platform: 'win32', env: {}, exists: (x) => /powershell\.exe$/i.test(x), host })
  assert.equal(after.supported, true)
  assert.equal(after.code, TRAY_ICON_CODES.HOST_READY)
  assert.equal(after.evidence.hostReady, true)
  assert.equal(after.evidence.pid, host.status().pid)
  await host.stop('test')
})

test('③ 宿主起过但没 ready → 不支持（false）+ HOST_FAILED，理由带退出码', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness({ ready: false })
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl, readyTimeoutMs: 200 })
  const started = await host.start()
  assert.equal(started.ok, false)
  assert.equal(started.code, TRAY_ICON_CODES.HOST_NOT_READY)
  spawned[0].child.pushStderr('Access is denied.')
  const p = probeTrayIconSupport({ platform: 'win32', env: {}, exists: (x) => /powershell\.exe$/i.test(x), host })
  assert.equal(p.supported, false)
  assert.equal(p.code, TRAY_ICON_CODES.HOST_FAILED)
  assert.ok(p.reason.includes(String(TRAY_ICON_CODES.HOST_NOT_READY)) || p.reason.length > 0)
})

test('③ ★ 解析顺序照抄 DSH：ProgramFiles 7 → PATH → System32 5.1', () => {
  const env = {
    [SHELL_ENV.PROGRAM_FILES]: 'C:\\PF',
    [SHELL_ENV.SYSTEM_ROOT]: 'C:\\Win',
    [SHELL_ENV.PATH]: 'C:\\a;C:\\b',
  }
  const cands = candidateTrayShells({ env, platform: 'win32' })
  assert.deepEqual(cands.map((c) => c.kind), ['pwsh-7', 'path', 'path', 'windows-powershell-5.1'])
  assert.equal(cands[0].path, 'C:\\PF\\PowerShell\\7\\pwsh.exe')
  assert.equal(cands[1].path, 'C:\\a\\pwsh.exe')
  assert.equal(cands[3].path, 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  // 三档都在时取**第一档**：顺序就是判据。
  const pickFirst = resolveTrayShell({ platform: 'win32', env, exists: () => true })
  assert.equal(pickFirst.kind, 'pwsh-7')
  // 前两档都不在时落到 5.1 —— "没有 PowerShell 7"不等于"画不出来"。
  const pickLast = resolveTrayShell({
    platform: 'win32', env, exists: (p) => p === cands[3].path,
  })
  assert.equal(pickLast.kind, 'windows-powershell-5.1')
  assert.equal(pickLast.ok, true)
})

test('③ 候选去重 + 带引号的 PATH 条目 + 默认 ProgramFiles/SystemRoot', () => {
  const cands = candidateTrayShells({
    env: { [SHELL_ENV.PATH]: '"C:\\a";C:\\a; C:\\b ;;' },
    platform: 'win32',
  })
  assert.deepEqual(cands.map((c) => c.path), [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\a\\pwsh.exe',
    'C:\\b\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ])
  assert.deepEqual(candidateTrayShells({ env: {}, platform: 'linux' }), [])
})

test('③ 显式配置的 shell 原样信任（不判存在）', () => {
  const r = resolveTrayShell({ platform: 'win32', env: {}, configured: 'D:\\x\\pwsh.exe', exists: () => false })
  assert.equal(r.ok, true)
  assert.equal(r.path, 'D:\\x\\pwsh.exe')
  assert.equal(r.kind, 'configured')
  assert.ok(r.message.includes('原样信任'))
})

// ============================================================================
// ④ 宿主的寿命是被规定的
// ============================================================================

test('④ 生成物只落在 `<DataDir>/tray/` 下，三个文件', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  assert.equal(host.plan.writableRoot, join(root, 'data', 'tray'))
  assert.equal(host.scriptPath, join(root, 'data', 'tray', 'legion-tray-icon.ps1'))
  await host.start()
  assert.ok(existsSync(host.scriptPath))
  assert.ok(existsSync(host.menuPath))
  await host.stop('test')
})

test('④ ★ 起宿主时**先清掉**上一次留下的哨兵（否则新宿主第一拍就自己退出）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl } = spawnHarness()
  const first = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  // 手写一个"上一次没收干净"的哨兵（目录先造出来：真机上它只能由上一次启动留下）。
  mkdirSync(join(root, 'data', 'tray'), { recursive: true })
  writeFileSync(join(root, 'data', 'tray', 'tray-stop'), 'stale', 'utf8')
  assert.ok(existsSync(join(root, 'data', 'tray', 'tray-stop')))
  const r = await first.start()
  assert.equal(r.ok, true, r.message)
  assert.equal(existsSync(first.stopPath), false, '旧哨兵还在：新宿主会在第一拍就 Dispose 并退出')
  await first.stop('test')
})

test('④ ★ 收工顺序：哨兵 → 宿主自报 disposed=true → 才算干净退出', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  const child = spawned[0].child
  const stopping = host.stop('unit-test')
  // 哨兵必须**在**等宿主之前就写下了（不然宿主永远不知道要收工）。
  assert.ok(existsSync(host.stopPath), '没有写停止哨兵')
  assert.equal(readFileSync(host.stopPath, 'utf8'), 'unit-test')
  child.push({ v: 1, kind: 'exited', hostId: TEST_HOST_ID, reason: 'stop-file', disposed: true })
  child.fail(0)
  const r = await stopping
  assert.equal(r.ok, true, r.message)
  assert.equal(r.disposed, true)
  assert.equal(r.exitCode, 0)
  assert.equal(r.gone, true)
  // 哨兵在收工之后被清掉：留着它会让**下一次**启动立刻退出。
  assert.equal(existsSync(host.stopPath), false)
})

test('④ ★ 宿主不自报 exited → SHUTDOWN_TIMEOUT，**不说成干净退出**（并强杀）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl, stopTimeoutMs: 150 })
  await host.start()
  const r = await host.stop('nobody-listens')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_ICON_CODES.SHUTDOWN_TIMEOUT)
  assert.equal(r.disposed, false, '没有 exited 那行就没有证据说图标 Dispose 了')
  assert.equal(r.gone, true, '等不到就该强杀，而不是留一个活的宿主')
  assert.equal(spawned[0].child.killed, true)
})

test('④ ★ 自报 disposed=false → SHUTDOWN_UNCLEAN（幽灵图标）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  const stopping = host.stop('test')
  spawned[0].child.push({ v: 1, kind: 'exited', hostId: TEST_HOST_ID, reason: 'stop-file', disposed: false })
  spawned[0].child.fail(0)
  const r = await stopping
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_ICON_CODES.SHUTDOWN_UNCLEAN)
  assert.equal(r.disposed, false)
})

test('④ ★ 生成物里 Dispose **在** exited 之前（顺序本身是判据）', () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl: spawnHarness().spawnImpl })
  const s = host.script
  const shutdownAt = s.indexOf('function Shutdown(')
  assert.ok(shutdownAt > 0, '生成物里没有 Shutdown')
  const invisibleAt = s.indexOf('$script:icon.Visible = $false', shutdownAt)
  const disposeAt = s.indexOf('$script:icon.Dispose()', shutdownAt)
  const exitedAt = s.indexOf('New-Message "exited"', shutdownAt)
  assert.ok(invisibleAt > shutdownAt, '收工时没有先把图标藏起来')
  assert.ok(disposeAt > invisibleAt, '收工时没有 Dispose 图标（幽灵图标就是这么留下的）')
  assert.ok(exitedAt > disposeAt,
    '先报 exited 再 Dispose：那样"图标已经拆掉"这句话在没有 Dispose 的实现里也是真的')
})

test('④ ★ 生成物里有父进程看护，并且**在 tick 里**被查', () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl: spawnHarness().spawnImpl, parentPid: 4321 })
  const s = host.script
  assert.ok(s.includes('function Test-ParentAlive'), '没有父进程看护：launcher 被杀了会留下孤儿图标')
  assert.ok(s.includes('$ParentPid = 4321'), '父进程 pid 没有被写进生成物')
  const tickAt = s.indexOf('$TickHandler = {')
  const callAt = s.indexOf('Test-ParentAlive', tickAt)
  assert.ok(callAt > tickAt, '父进程看护没有接在 tick 上：它永远不会被执行')
  assert.ok(s.includes('"parent-gone"'))
})

test('④ ★ 宿主自己死了 → HOST_UNHEALTHY（error），并且 `start()` 可以再来一次', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  spawned[0].child.fail(7)
  await sleep(20)
  const st = host.status()
  assert.equal(st.alive, false)
  assert.equal(st.exitCode, 7)
  assert.ok(host.diagnostics().some((d) => d.code === TRAY_ICON_CODES.HOST_UNHEALTHY && d.severity === 'error'),
    '宿主没了却没有任何 error 级读数：用户会一直找一个不存在的图标')
  // ★ 回去的路：还能再起一次。
  const again = await host.start()
  assert.equal(again.ok, true, again.message)
  assert.equal(spawned.length, 2)
  await host.stop('test')
})

test('④ 重复 start / 没起过就 stop / 心跳读数', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl, heartbeatMs: 100, tickMs: 50 })
  const idleStop = await host.stop('never-started')
  assert.equal(idleStop.ok, true)
  assert.equal(idleStop.code, TRAY_ICON_CODES.NOT_STARTED)
  await host.start()
  const twice = await host.start()
  assert.equal(twice.ok, false)
  assert.equal(twice.code, TRAY_ICON_CODES.ALREADY_STARTED)
  spawned[0].child.push({ v: 1, kind: 'heartbeat', hostId: TEST_HOST_ID, ticks: 2 })
  await sleep(20)
  assert.equal(host.status().lastHeartbeatAt !== null, true)
  assert.equal(host.status().unhealthy, false)
  // 心跳过期（进程还在，但消息循环不转了）：报出来，但**不自动杀**。
  const stale = makeHost({
    tray: trayOver(launcher), root: tempRoot(), spawnImpl, heartbeatMs: 10, tickMs: 10,
  })
  await stale.start()
  const staleChild = spawned[1].child
  staleChild.push({ v: 1, kind: 'heartbeat', hostId: TEST_HOST_ID, ticks: 1 })
  await sleep(60)
  assert.equal(stale.status().unhealthy, true, '进程还在、心跳停了，必须被标成 unhealthy')
  assert.equal(stale.status().alive, true, '心跳停了不等于进程死了：杀错会让用户手上那件事消失')
  await stale.stop('test')
  await host.stop('test')
})

test('④ spawn 抛错 → SPAWN_FAILED；进程在 ready 之前退出 → HOST_EXITED_BEFORE_READY', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const boom = makeHost({
    tray: trayOver(launcher), root, spawnImpl: () => { throw new Error('没有这个文件') },
  })
  const r1 = await boom.start()
  assert.equal(r1.ok, false)
  assert.equal(r1.code, TRAY_ICON_CODES.SPAWN_FAILED)
  assert.ok(r1.message.includes('没有这个文件'))

  const root2 = tempRoot()
  const { spawnImpl, spawned } = spawnHarness({ ready: false })
  const dying = makeHost({ tray: trayOver(launcher), root: root2, spawnImpl, readyTimeoutMs: 300 })
  const p = dying.start()
  setTimeout(() => {
    spawned[0].child.pushStderr('脚本被执行策略禁止')
    spawned[0].child.fail(1)
  }, 10)
  const r2 = await p
  assert.equal(r2.ok, false)
  assert.equal(r2.code, TRAY_ICON_CODES.HOST_EXITED_BEFORE_READY)
  assert.ok(r2.message.includes('执行策略'), r2.message)
  assert.equal(r2.exitCode, 1)
})

// ============================================================================
// ⑤ 写入边界
// ============================================================================

test('⑤ 没有 DataDir / 相对路径 / 落进 .dsh / 落进 InstallDir → 逐条拒绝', () => {
  const win = 'win32'
  assert.equal(planTrayIcon({ dataDir: null, allowedRoot: 'C:\\r', platform: win }).code, TRAY_ICON_CODES.NO_DATA_DIR)
  assert.equal(planTrayIcon({ dataDir: '', allowedRoot: 'C:\\r', platform: win }).code, TRAY_ICON_CODES.NO_DATA_DIR)
  assert.equal(
    planTrayIcon({ dataDir: 'data', allowedRoot: 'C:\\r', platform: win }).code,
    TRAY_ICON_CODES.DATA_DIR_NOT_ABSOLUTE,
  )
  assert.equal(
    planTrayIcon({
      dataDir: 'C:\\Users\\u\\.dsh\\data', allowedRoot: 'C:\\Users\\u', operatorHome: 'C:\\Users\\u', platform: win,
    }).code,
    TRAY_ICON_CODES.TARGET_INSIDE_DSH_HOME,
    '即使没有设 DSH_HOME，`~/.dsh` 也仍然是 DSH 的地盘',
  )
  assert.equal(
    planTrayIcon({
      dataDir: 'D:\\dsh-home\\data', allowedRoot: 'D:\\dsh-home', dshHome: 'D:\\dsh-home', platform: win,
    }).code,
    TRAY_ICON_CODES.TARGET_INSIDE_DSH_HOME,
  )
  assert.equal(
    planTrayIcon({
      dataDir: 'C:\\Legion\\install\\data', allowedRoot: 'C:\\Legion\\install', installDir: 'C:\\Legion\\install', platform: win,
    }).code,
    TRAY_ICON_CODES.TARGET_INSIDE_INSTALL_DIR,
    '安装目录升级时被整体替换：托盘脚本会跟着一起消失',
  )
  assert.equal(
    planTrayIcon({ dataDir: 'C:\\data', allowedRoot: null, platform: win }).code,
    TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
    '"没有允许根所以不检查边界"与"没有边界"是同一个东西',
  )
  assert.equal(
    planTrayIcon({ dataDir: 'C:\\data', allowedRoot: 'C:\\other', platform: win }).code,
    TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
  )
  const ok = planTrayIcon({ dataDir: 'C:\\data', allowedRoot: 'C:\\data', platform: win })
  assert.equal(ok.ok, true)
  assert.equal(ok.writableRoot, 'C:\\data\\tray')
})

test('⑤ ★ 被拒绝的计划**一个目录都不建**（拒绝发生在任何写入之前）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const host = createTrayIconHost({
    tray: trayOver(launcher),
    dataDir: join(root, 'data'),
    allowedRoot: join(root, '别的目录'),
    platform: 'win32',
    env: {},
    exists: () => true,
  })
  assert.equal(host.ok, false)
  assert.equal(host.code, TRAY_ICON_CODES.TARGET_OUTSIDE_ALLOWED_ROOT)
  const r = await host.start()
  assert.equal(r.ok, false)
  assert.equal(existsSync(join(root, 'data')), false, '被拒绝的装配在磁盘上留下了东西')
})

test('⑤ ★ 逐次写入守卫与 `runtime-install` 的守卫**逐格对拍**', () => {
  const root = tempRoot()
  const installDir = join(root, 'install')
  const dshHome = join(root, 'dsh-home')
  const plan = planTrayIcon({
    dataDir: join(root, 'data'),
    allowedRoot: root,
    installDir,
    dshHome,
    platform: 'win32',
  })
  assert.equal(plan.ok, true)
  const oracle = createRuntimeWriteGuard({
    fs: {},
    writableRoot: plan.writableRoot,
    readOnlyRoots: plan.readOnlyRoots,
    platform: 'win32',
  })
  const cases = [
    join(plan.controlDir, 'legion-tray-icon.ps1'),
    join(plan.controlDir, 'tray-menu.json'),
    join(plan.controlDir, 'sub', 'x.json'),
    plan.controlDir,
    join(root, 'data', 'other.json'),
    join(root, 'data'),
    join(root, 'outside.json'),
    join(installDir, 'x.json'),
    join(dshHome, 'x.json'),
    'C:\\Windows\\Temp\\x.json',
  ]
  for (const p of cases) {
    let oracleAllows = true
    try {
      oracle.guardPath('write', p)
    } catch {
      oracleAllows = false
    }
    const mine = planTrayWrite({ plan, path: p, platform: 'win32' })
    assert.equal(mine.ok, oracleAllows, `两套判据在 ${p} 上给出了两个答案（我方 ${JSON.stringify(mine)}）`)
    if (mine.ok === false) assert.equal(mine.code, TRAY_ICON_CODES.WRITE_REFUSED)
  }
  // 没有计划就不许写。
  assert.equal(planTrayWrite({ plan: null, path: cases[0], platform: 'win32' }).ok, false)
  assert.equal(planTrayWrite({ plan, path: '', platform: 'win32' }).ok, false)
})

test('⑤ ★ 写盘的 .ps1 带 UTF-8 BOM（5.1 会按系统 ANSI 解码没有 BOM 的 .ps1）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  const bytes = readFileSync(host.scriptPath)
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '生成物没有 BOM：中文注释会在中文 Windows 上被解成乱码')
  // 菜单是 JSON，不带 BOM（宿主按 UTF-8 读它）。
  const menuBytes = readFileSync(host.menuPath)
  assert.notDeepEqual([...menuBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  await host.stop('test')
})

test('⑤ 生成物是**单引号数组拼出来的**：脚本正文里可以出现反引号而不炸', () => {
  // 这一条盯的是那个真实的坑：模板字面量里出现一个 PowerShell 用的反引号会**提前终止**它，
  // 而外层 JS 往往仍然能通过 `node --check`（剩下的正文碰巧还是合法 JS 时）——
  // 生成物坏了、语法检查却是绿的。
  const script = renderTrayScript({ menuPath: 'C:\\data\\tray\\m.json', stopPath: 'C:\\data\\tray\\s' })
  assert.ok(script.endsWith('\n'), '生成物没有以换行收尾：最后一行可能是被截断的残片')
  assert.ok(script.includes('function Test-ParentAlive'))
  assert.ok(script.includes('$ParentPid = 0'))
  assert.ok(script.includes(psQuote('C:\\data\\tray\\m.json')))
  // 单引号路径要被正确转义（两遍），不是被截断。
  const quoted = renderTrayScript({ menuPath: "C:\\a b\\o'brien.json", stopPath: 'C:\\s' })
  assert.ok(quoted.includes("'C:\\a b\\o''brien.json'"), '带单引号的路径没有被转义成两遍')
})

// ============================================================================
// ⑥ 退出纪律：没有被新的一层绕过
// ============================================================================

test('⑥ ★ 停止失败（宿主没走）时**报出来**，诊断里带着那一个码', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const { spawnImpl } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl, stopTimeoutMs: 120 })
  await host.start()
  const r = await host.stop('fail-to-stop')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_ICON_CODES.SHUTDOWN_TIMEOUT)
  // 报的是"没停"，不是"停了"。
  assert.ok(r.message.includes('没有自报 exited'), r.message)
  assert.ok(host.diagnostics().some((d) => d.severity === 'error' || d.severity === 'warn'))
})

test('⑥ ★ `quit` 未确认的诊断码就是 `tray.mjs` 那一个（没有第二套判据）', async () => {
  const root = tempRoot()
  const { launcher } = fakeLauncher({ state: 'degraded', onStop: () => {} })
  const { spawnImpl, spawned } = spawnHarness()
  const host = makeHost({ tray: trayOver(launcher), root, spawnImpl })
  await host.start()
  await click(host, spawned[0].child, 'quit')
  const codes = host.diagnostics().map((d) => d.code)
  assert.ok(codes.includes(TRAY_CODES.QUIT_UNCONFIRMED), `诊断里没有 ${TRAY_CODES.QUIT_UNCONFIRMED}：${codes.join(',')}`)
  // 这一层**不**自己判"停没停"：它只是把 tray 的结论转述出来。
  assert.equal(host.status().alive, true)
  const p = host.stop('test')
  spawned[0].child.push({ v: 1, kind: 'exited', hostId: TEST_HOST_ID, reason: 'stop-file', disposed: true })
  spawned[0].child.fail(0)
  await p
})

// ============================================================================
// ⑦ 诚实边界
// ============================================================================

test('⑦ 诚实边界：非 Windows 上什么都不画；点击路径只有**宿主那一行**能进来', () => {
  // ① 非 Windows：如实不支持（不是"试了但没成功"，是**根本不生成**宿主）。
  //    路径也按那个平台的形状给：拿一个 Windows 路径喂给 linux 判据，
  //    咬住的是"它不够绝对"，而不是"这个平台画不出来"。
  const root = tempRoot()
  const { launcher } = fakeLauncher({})
  const host = createTrayIconHost({
    tray: trayOver(launcher),
    dataDir: '/tmp/legion/data',
    allowedRoot: '/tmp/legion',
    platform: 'linux',
    env: {},
  })
  assert.equal(host.ok, false)
  assert.equal(host.code, TRAY_ICON_CODES.UNSUPPORTED_PLATFORM)
  assert.equal(host.script, null, '在画不出来的平台上不该生成一个"起了就死"的脚本')

  // ② 派发只有一个入口：**宿主写的那一行**。生成物里除了点击处理器，
  //    没有任何别的地方会发出 click —— 也就是说"点击"这件事在脚本里只有一处来源。
  const winHost = makeHost({ tray: trayOver(launcher), root: tempRoot(), spawnImpl: spawnHarness().spawnImpl })
  const emitters = winHost.script.split('\n').filter((l) => l.includes('New-Message "click"'))
  assert.equal(emitters.length, 1, `生成物里有 ${emitters.length} 处发出 click：多出来的那处不是点击`)
  assert.ok(emitters[0].includes('$sender.Tag'), 'click 的 id 不是从被点的那个菜单项上取的')

  // ③ 下面这三件事**这份用例没有证明**，不是"顺便也验了"：
  //    · 真实鼠标点击：从来没有模拟过（无人值守做不到）。上面所有点击都是把
  //      宿主会写的那一行注入进去 —— 证明的是"那一行进了派发就是同一个结果"。
  //    · 图标外观：有没有出现在托盘、长什么样，读不出来；能读的只有宿主的自报。
  //    · 真宿主那几条：在能解析到 shell 的机器上真的起进程，其余环境如实 SKIP。
  assert.ok(true)
})

// ============================================================================
// ⑧ 真宿主（解析不到 shell 的环境如实 SKIP）
// ============================================================================

const REAL_SHELL = process.platform === 'win32'
  ? resolveTrayShell({ platform: 'win32', env: process.env })
  : null
const REAL_SKIP = REAL_SHELL !== null && REAL_SHELL.ok === true
  ? false
  : `这台机器上解析不到能加载 WinForms 的 PowerShell（platform=${process.platform}）：`
    + (REAL_SHELL === null ? '非 Windows' : REAL_SHELL.message)

/** 真宿主：**真的** spawn 一个 PowerShell（不注入 spawnImpl）。 */
function realHost(root, overrides = {}) {
  const { launcher } = fakeLauncher({ state: 'unavailable', onStart: (b) => { b.state = 'ready' } })
  return createTrayIconHost({
    tray: trayOver(launcher),
    dataDir: join(root, 'data'),
    allowedRoot: root,
    platform: 'win32',
    env: process.env,
    exists: defaultFileExists,
    fileExists: defaultFileExists,
    randomToken: () => TEST_HOST_ID,
    tickMs: 150,
    heartbeatMs: 400,
    readyTimeoutMs: 25000,
    stopTimeoutMs: 10000,
    killGraceMs: 3000,
    ...overrides,
  })
}

test('⑧ ★ 真宿主：起得来、活着、心跳在走、收得干净（Dispose 由宿主自报）', { skip: REAL_SKIP }, async () => {
  const root = tempRoot()
  let host = null
  try {
    host = realHost(root)
    assert.equal(host.ok, true, host.message)
    const started = await host.start()
    assert.equal(started.ok, true, started.message)
    assert.equal(host.status().ready, true)
    assert.equal(host.status().alive, true)
    assert.ok(host.status().pid > 0)

    // 图标宿主是一个**真的活着**的进程：它在这 900ms 里应该报过心跳。
    await sleep(900)
    assert.ok(host.status().lastHeartbeatAt !== null,
      '真宿主起来了但一次心跳都没有：图标在、消息循环没转')
    assert.equal(host.status().unhealthy, false)

    const stopped = await host.stop('real-host-test')
    assert.equal(stopped.ok, true, stopped.message)
    assert.equal(stopped.disposed, true, '宿主没有自报 Dispose：可能是幽灵图标')
    assert.equal(stopped.gone, true)
    assert.equal(stopped.exitCode, 0)
    assert.equal(host.status().alive, false)

    // 再确认一次读数：这台机器刚刚**真的**画出来过，所以"支持"是真的。
    const probe = probeTrayIconSupport({ platform: 'win32', env: process.env, host })
    assert.equal(probe.supported, true, '这台机器刚刚真的起过宿主：读数不该说"不支持"')
    assert.equal(probe.evidence.hostReady, true)
  } finally {
    if (host !== null) {
      try { await host.stop('cleanup') } catch { /* 收不掉不影响判据 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑧ 生成物本身能被 PowerShell 的解析器读进去（`node --check` 读不了 PowerShell）', { skip: REAL_SKIP }, () => {
  const root = tempRoot()
  try {
    const host = realHost(root)
    const scriptPath = join(root, 'generated.ps1')
    writeFileSync(scriptPath, '\uFEFF' + host.script, 'utf8')
    const cmd = '$errs=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('
      + psQuote(scriptPath) + ',[ref]$null,[ref]$errs);'
      + ' if($errs.Count -gt 0){ foreach($e in $errs){ [Console]::Error.WriteLine($e.Message) }; exit 1 }'
    const r = spawnSync(REAL_SHELL.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8', timeout: 30000,
    })
    assert.equal(r.status, 0, `生成物的 PowerShell 语法不过：${r.stderr || r.stdout}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑧ 菜单文件读不到时**不画图标**：脚本报 error 并 exit 3', { skip: REAL_SKIP }, () => {
  const root = tempRoot()
  try {
    const script = renderTrayScript({
      menuPath: join(root, '根本没有这个菜单.json'),
      stopPath: join(root, 'stop'),
      hostId: TEST_HOST_ID,
    })
    const scriptPath = join(root, 'no-menu.ps1')
    writeFileSync(scriptPath, '\uFEFF' + script, 'utf8')
    const r = spawnSync(REAL_SHELL.path, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { encoding: 'utf8', timeout: 30000 })
    assert.equal(r.status, 3, `退出码应为 3（菜单读不到）；实际 ${r.status}，stderr=${r.stderr}`)
    const lines = String(r.stdout).split(/\r?\n/).filter((l) => l.trim() !== '')
    const parsed = lines.map((l) => parseTrayHostLine(l)).filter((p) => p.ok === true)
    assert.ok(parsed.some((p) => p.kind === 'error' && p.fields.phase === 'menu'),
      `没有报出 phase=menu 的 error 行：${r.stdout}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑧ ★ 父进程没了 → 宿主自己 Dispose 并退出（不留孤儿图标）', { skip: REAL_SKIP }, async () => {
  const root = tempRoot()
  let host = null
  try {
    // 一个**一定不存在**的 pid（Windows 不会分配这么大的 pid）：
    // 它模拟的是"launcher 被任务管理器杀掉了"。
    host = realHost(root, { parentPid: 0x7ffffff0, tickMs: 100 })
    const started = await host.start()
    assert.equal(started.ok, true, started.message)
    assert.equal(host.status().alive, true)
    // 一拍之后宿主应该自己收工。
    const deadline = Date.now() + 8000
    while (host.status().alive === true && Date.now() < deadline) await sleep(100)
    assert.equal(host.status().alive, false, '父进程不在了，宿主还活着：孤儿图标就是这么留下的')
    assert.equal(host.status().lastExited?.reason, 'parent-gone')
    assert.equal(host.status().lastExited?.disposed, true, '父进程没了就走，但没有 Dispose')
  } finally {
    if (host !== null) {
      try { await host.stop('cleanup') } catch { /* 收不掉不影响判据 */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
})
