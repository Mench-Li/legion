// ============================================================================
// PRT-708 的判据。
//
// 这一组盯的**不是**"菜单项画得对不对"，而是**点了「退出」之后进程还在不在跑**。
//
// 一个把图标藏起来、进程还在跑的「退出」，与一个根本没有退出按钮的托盘，
// 在"用户以为关了的时候产品还在不在跑"上是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RUNNING_STATES,
  STOPPED_STATES,
  TRAY_CODES,
  TRAY_LABELS,
  TRAY_MENU_IDS,
  buildTrayMenu,
  createTray,
} from './tray.mjs'

/** 一个可控的观测源：`state` 可以被测试改动。 */
function fakeObserver(initial = { runtimeState: 'ready', workbenchUrl: 'http://127.0.0.1:8788/' }) {
  const box = { observation: initial, calls: 0 }
  return {
    box,
    observe: async () => { box.calls += 1; return box.observation },
  }
}

function byId(items, id) { return items.find((i) => i.id === id) }

// ── 菜单结构 ────────────────────────────────────────────────────────────────

test('① 菜单有五个动作，顺序固定，且每个都有标签', () => {
  assert.deepEqual([...TRAY_MENU_IDS], ['open-workbench', 'status', 'start', 'stop', 'quit'])
  const items = buildTrayMenu({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  assert.deepEqual(items.map((i) => i.id), [...TRAY_MENU_IDS])
  for (const i of items) assert.ok(typeof i.label === 'string' && i.label.length > 0, i.id)
  assert.equal(Object.isFrozen(items), true)
  for (const i of items) assert.equal(Object.isFrozen(i), true)
})

test('① 「退出」的标签写清它**会停掉组件**（"退出"两个字会被读成"关掉窗口"）', () => {
  assert.ok(TRAY_LABELS.quit.includes('停止'), TRAY_LABELS.quit)
})

test('① 可用性全部来自**观测**（`running` 与 `start` 互斥）', () => {
  const running = buildTrayMenu({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  assert.equal(byId(running, 'start').enabled, false)
  assert.equal(byId(running, 'stop').enabled, true)

  const stopped = buildTrayMenu({ runtimeState: 'unavailable', workbenchUrl: 'http://x/' })
  assert.equal(byId(stopped, 'start').enabled, true)
  assert.equal(byId(stopped, 'stop').enabled, false)
})

test('① ★ 每个 `unavailable` 与"状态未知"下的可用性都要说得出理由', () => {
  // 一个灰掉的菜单项不解释自己，用户只会以为坏了。
  for (const o of [
    { runtimeState: 'ready', workbenchUrl: 'http://x/' },
    { runtimeState: 'unavailable', workbenchUrl: null },
    {},
  ]) {
    for (const i of buildTrayMenu(o)) {
      if (i.enabled === false) {
        assert.ok(typeof i.disabledReason === 'string' && i.disabledReason.length > 0,
          `${i.id} 灰掉了却没说为什么`)
      }
    }
  }
})

test('① ★ `unavailable` **不算**"在跑"（图标还在不等于产品活着）', () => {
  assert.ok(!RUNNING_STATES.includes('unavailable'))
  assert.deepEqual([...STOPPED_STATES], ['unavailable'])
  // 四种活着的状态都算在跑
  for (const s of ['ready', 'starting', 'degraded', 'upgrading']) {
    assert.ok(RUNNING_STATES.includes(s), `${s} 不算在跑`)
  }
})

test('① ★ `open-workbench` 在**没有观测到地址**时不可点', () => {
  const items = buildTrayMenu({ runtimeState: 'ready', workbenchUrl: null })
  const i = byId(items, 'open-workbench')
  assert.equal(i.enabled, false)
  assert.ok(i.disabledReason.includes('打不开'), i.disabledReason)
})

test('① ★ `quit` **永远可点**（状态不明时也必须能退出）', () => {
  for (const o of [{}, { runtimeState: null }, { runtimeState: 'unavailable' }, { runtimeState: '乱写的' }]) {
    assert.equal(byId(buildTrayMenu(o), 'quit').enabled, true,
      `${JSON.stringify(o)} 下退不出去——用户被困在一个无法关闭的产品里`)
  }
})

test('① 状态未知时 `start` 可点（那正是"用户觉得没跑"的时候）', () => {
  const items = buildTrayMenu({})
  assert.equal(byId(items, 'start').enabled, true)
  assert.equal(byId(items, 'stop').enabled, false)
})

test('① `status` 菜单项的标签带上**观测到的**状态文案', () => {
  const i = byId(buildTrayMenu({ runtimeState: 'degraded' }), 'status')
  assert.ok(i.label.includes('部分能力不可用'), i.label)
  const unknown = byId(buildTrayMenu({}), 'status')
  assert.ok(unknown.label.includes('未知'), unknown.label)
})

test('① 不认识的运行时状态**不冒充**成已知的那一个', () => {
  const i = byId(buildTrayMenu({ runtimeState: 'wat' }), 'status')
  assert.ok(i.label.includes('未知状态'), i.label)
  assert.ok(i.label.includes('wat'), i.label)
})

// ── ★★ 退出必须真的停掉 ─────────────────────────────────────────────────────

test('② ★★ 「退出」真的把产品停掉时才允许退出（正向对照）', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  let stopped = 0
  const tray = createTray({
    observe: obs.observe,
    stop: async () => { stopped += 1; obs.box.observation = { runtimeState: 'unavailable', workbenchUrl: null } },
  })
  const r = await tray.invoke('quit')
  assert.equal(r.ok, true)
  assert.equal(r.exited, true)
  assert.equal(stopped, 1)
  assert.equal(r.state, 'unavailable')
})

test('② ★★ 停止**没成功**时**不允许退出**，并报出来（图标不能藏起来）', async () => {
  // 这是本模块的核心。
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({
    observe: obs.observe,
    // stop() 假装成功，但产品其实还在跑
    stop: async () => ({ ok: true }),
  })
  const r = await tray.invoke('quit')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
  assert.equal(r.exited, undefined, '没确认停下来却给了"可以退出"')
  assert.ok(r.message.includes('没有完成'), r.message)
  assert.ok(r.message.includes('托盘会继续留着'), r.message)
  assert.ok(tray.diagnostics().some((d) => d.code === TRAY_CODES.QUIT_UNCONFIRMED && d.severity === 'error'))
})

test('② ★★ 退出时**观测失败**也不能算停掉了', async () => {
  // "看不出来"与"停掉了"是两件事。
  let calls = 0
  const tray = createTray({
    observe: async () => {
      calls += 1
      if (calls === 1) return { runtimeState: 'ready', workbenchUrl: 'http://x/' }
      throw new Error('探针炸了')
    },
    stop: async () => ({ ok: true }),
  })
  const r = await tray.invoke('quit')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
  assert.ok(r.message.includes('观测失败'), r.message)
})

test('② ★ 退出时 `stop()` 抛错也要报出来，且**不确认退出**', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({
    observe: obs.observe,
    stop: async () => { throw new Error('杀进程失败') },
  })
  const r = await tray.invoke('quit')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
  assert.ok(tray.diagnostics().some((d) => d.message.includes('杀进程失败')))
})

test('② ★ 退出**必须重新观测**，不能只信 `stop()` 的返回值', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({ observe: obs.observe, stop: async () => ({ ok: false }) })
  const before = obs.box.calls
  await tray.invoke('quit')
  assert.ok(obs.box.calls > before + 1,
    '退出只看了一次观测——无法判断"停完之后"是什么状态')
})

test('② 退出时状态是 `starting` / `degraded` 也算没停（只有 `unavailable` 算）', async () => {
  for (const leftover of ['ready', 'starting', 'degraded', 'upgrading']) {
    const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
    const tray = createTray({
      observe: obs.observe,
      stop: async () => { obs.box.observation = { runtimeState: leftover, workbenchUrl: null } },
    })
    const r = await tray.invoke('quit')
    assert.equal(r.ok, false, `停完观测到 ${leftover} 却允许退出了`)
    assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
  }
})

test('② 没有配置 `stop` 时退出也**不确认**（不能因为没得停就说停了）', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({ observe: obs.observe })
  const r = await tray.invoke('quit')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.QUIT_UNCONFIRMED)
})

// ── 打开 Workbench 用观测到的地址 ───────────────────────────────────────────

test('③ ★ 打开 Workbench 用**观测到的**地址（不是配置里的默认端口）', async () => {
  const opened = []
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://127.0.0.1:54321/' })
  const tray = createTray({ observe: obs.observe, openExternal: async (u) => opened.push(u) })
  const r = await tray.invoke('open-workbench')
  assert.equal(r.ok, true)
  assert.deepEqual(opened, ['http://127.0.0.1:54321/'])
})

test('③ ★ 没观测到地址时**不打开**（打开一个打不开的页面比不打开更糟）', async () => {
  const opened = []
  const tray = createTray({
    observe: async () => ({ runtimeState: 'ready', workbenchUrl: null }),
    openExternal: async (u) => opened.push(u),
  })
  const r = await tray.invoke('open-workbench')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.WORKBENCH_NOT_READY)
  assert.equal(opened.length, 0)
  assert.ok(r.message.includes('打不开'), r.message)
})

test('③ 打开失败时报出来（不是静默成功）', async () => {
  const tray = createTray({
    observe: async () => ({ runtimeState: 'ready', workbenchUrl: 'http://x/' }),
    openExternal: async () => { throw new Error('没有默认浏览器') },
  })
  const r = await tray.invoke('open-workbench')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.OPEN_FAILED)
  assert.ok(r.message.includes('没有默认浏览器'))
})

test('③ 空字符串地址也算没观测到（`""` 不是地址）', async () => {
  const opened = []
  const tray = createTray({
    observe: async () => ({ runtimeState: 'ready', workbenchUrl: '' }),
    openExternal: async (u) => opened.push(u),
  })
  assert.equal((await tray.invoke('open-workbench')).ok, false)
  assert.equal(opened.length, 0)
})

// ── 启动 / 停止 ─────────────────────────────────────────────────────────────

test('④ 停止同样要**看结果**，不能只听返回值', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({
    observe: obs.observe,
    // 返回 ok:true 但产品还在跑
    stop: async () => ({ ok: true }),
  })
  const r = await tray.invoke('stop')
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('还在运行'), r.message)
})

test('④ 停止成功时报 `unavailable`', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({
    observe: obs.observe,
    stop: async () => { obs.box.observation = { runtimeState: 'unavailable', workbenchUrl: null } },
  })
  const r = await tray.invoke('stop')
  assert.equal(r.ok, true)
  assert.equal(r.state, 'unavailable')
})

test('④ 启动返回非正面结论时不算成功', async () => {
  for (const bad of [undefined, null, {}, { ok: false, phase: 'plan' }]) {
    const tray = createTray({
      observe: async () => ({ runtimeState: 'unavailable', workbenchUrl: null }),
      start: async () => bad,
    })
    const r = await tray.invoke('start')
    assert.equal(r.ok, false, `启动返回 ${JSON.stringify(bad)} 却算成功了`)
    assert.equal(r.code, TRAY_CODES.ACTION_FAILED)
  }
})

test('④ 启动抛错时报出来', async () => {
  const tray = createTray({
    observe: async () => ({ runtimeState: 'unavailable', workbenchUrl: null }),
    start: async () => { throw new Error('端口被占') },
  })
  const r = await tray.invoke('start')
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('端口被占'))
})

test('④ `status` 动作给出状态与"在不在跑"，且**不改动产品**', async () => {
  let mutated = 0
  const tray = createTray({
    observe: async () => ({ runtimeState: 'degraded', workbenchUrl: null }),
    start: async () => { mutated += 1; return { ok: true } },
    stop: async () => { mutated += 1; return { ok: true } },
  })
  const r = await tray.invoke('status')
  assert.equal(r.ok, true)
  assert.equal(r.state, 'degraded')
  assert.equal(r.running, true)
  assert.equal(mutated, 0, '「查看状态」改动了产品')
})

// ── 观测失败时的行为 ────────────────────────────────────────────────────────

test('⑤ ★ 观测失败时**除退出外**的动作都不执行（否则结果可能与意图相反）', async () => {
  for (const id of ['start', 'stop', 'status', 'open-workbench']) {
    let acted = 0
    const tray = createTray({
      observe: async () => { throw new Error('读不到状态') },
      start: async () => { acted += 1; return { ok: true } },
      stop: async () => { acted += 1; return { ok: true } },
      openExternal: async () => { acted += 1 },
    })
    const r = await tray.invoke(id)
    assert.equal(r.ok, false, `${id} 在观测失败时仍然执行了`)
    assert.equal(r.code, TRAY_CODES.OBSERVE_FAILED)
    assert.equal(acted, 0)
  }
})

test('⑤ 观测失败时 `menu()` 仍能渲染（按"未知"渲染，而不是崩掉）', async () => {
  const tray = createTray({ observe: async () => { throw new Error('炸了') } })
  const m = await tray.menu()
  assert.equal(m.observed, false)
  assert.deepEqual(m.items.map((i) => i.id), [...TRAY_MENU_IDS])
  // 未知状态下"退出"依然可点
  assert.equal(byId(m.items, 'quit').enabled, true)
})

test('⑤ ★ `menu()` **每次都重新观测**（缓存过的菜单会说假话）', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({ observe: obs.observe })
  await tray.menu()
  obs.box.observation = { runtimeState: 'unavailable', workbenchUrl: null }
  const m2 = await tray.menu()
  assert.equal(byId(m2.items, 'stop').enabled, false, '菜单缓存了旧状态')
  assert.equal(byId(m2.items, 'start').enabled, true)
})

// ── 动作串行化 / 释放 / 未知动作 ─────────────────────────────────────────────

test('⑥ 不认识的动作用**单独的码**报出来', async () => {
  const tray = createTray({ observe: async () => ({ runtimeState: 'ready' }) })
  const r = await tray.invoke('nonsense')
  assert.equal(r.ok, false)
  assert.equal(r.code, TRAY_CODES.UNKNOWN_ACTION)
})

test('⑥ ★ 上一个动作没结束时**不排队**（排队的"停止"会与"启动"错位）', async () => {
  let release = null
  const gate = new Promise((res) => { release = res })
  const tray = createTray({
    observe: async () => ({ runtimeState: 'unavailable', workbenchUrl: null }),
    start: async () => { await gate; return { ok: true } },
  })
  const first = tray.invoke('start')
  const second = await tray.invoke('stop')
  assert.equal(second.ok, false)
  assert.equal(second.code, TRAY_CODES.BUSY)
  release()
  await first
})

test('⑥ 动作历史被记账（用户点了什么、成没成）', async () => {
  const obs = fakeObserver({ runtimeState: 'ready', workbenchUrl: 'http://x/' })
  const tray = createTray({ observe: obs.observe, stop: async () => { obs.box.observation = { runtimeState: 'unavailable' } } })
  await tray.invoke('status')
  await tray.invoke('stop')
  const st = tray.status()
  assert.deepEqual(st.acted.map((a) => a.id), ['status', 'stop'])
  assert.equal(st.acted[0].ok, true)
})

test('⑥ ★ `dispose()` 之后所有动作都拒绝（释放后仍能点"启动"很危险）', async () => {
  const tray = createTray({ observe: async () => ({ runtimeState: 'ready' }) })
  tray.dispose()
  assert.equal(tray.status().disposed, true)
  for (const id of TRAY_MENU_IDS) {
    const r = await tray.invoke(id)
    assert.equal(r.ok, false, `${id} 在释放后仍然执行了`)
  }
})

test('⑥ 托盘对象与诊断都是冻结的', () => {
  const tray = createTray({ observe: async () => ({ runtimeState: 'ready' }) })
  assert.equal(Object.isFrozen(tray), true)
  assert.equal(Object.isFrozen(tray.diagnostics()), true)
  assert.equal(Object.isFrozen(tray.status()), true)
})

test('⑥ 三个主流平台都算支持（`supported` 反映平台）', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.equal(createTray({ platform: p, observe: async () => ({}) }).status().supported, true, p)
  }
  assert.equal(createTray({ platform: 'aix', observe: async () => ({}) }).status().supported, false)
})
