// product/launcher/supervisor.test.mjs
// ============================================================================
// PRT-704 监督行为的判据。
//
// 现有 `services-plugin/index.js` 的重启逻辑只有一行退避、**没有熔断**：
// 一个启动期就崩溃的进程会以 30 秒周期永远重启。它的症状是「产品一直连不上」，
// 也就是最像「什么都没发生」的故障形态。这里的三条断言就是针对它：
//   ① 快速失败累计到阈值 → circuit-open，不再自动重启；
//   ② 存活超过 healthyAfterMs 的退出 → 退避归零（偶发故障应立刻恢复）；
//   ③ 关闭要杀进程树（否则孙进程留着占端口，「重启」变成「端口被占用」）。
//
// 时间全部注入，因此这些判据在毫秒级完成，而不是真的等 30 秒退避。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createSupervisedProcess, createSupervisor, defaultKillTree } from './supervisor.mjs'
import { materializeProcessPlan } from '../process-manifest.mjs'

const SPEC = Object.freeze({
  key: 'team-hub',
  label: 'team-hub',
  command: Object.freeze({ file: 'node', args: Object.freeze(['server.mjs']) }),
  cwd: 'C:\\Legion',
  envNames: Object.freeze([]),
})

/**
 * 假子进程：可控地「活着」或「退出」。
 * `exit()` 触发 exit 事件（真实的 `child.once('exit')` 语义）。
 */
function makeFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.kills = []
  child.kill = (sig) => {
    child.kills.push(sig)
    child.killed = true
    // 真实语义：SIGTERM 之后进程会退出（这里让测试显式调用 exitNow 更可控）
    return true
  }
  child.exitNow = (code = 0) => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  return child
}

/** 注入式时钟 + 定时器队列，让退避在毫秒级被验证。 */
function makeClock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const handle = { fn, at: t + ms, cleared: false }
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => { if (handle !== undefined && handle !== null) handle.cleared = true },
    /** 推进时间并触发到期定时器。 */
    advance(ms) {
      const target = t + ms
      for (;;) {
        const due = timers.filter((h) => !h.cleared && h.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        due.cleared = true
        t = due.at
        due.fn()
      }
      t = target
    },
    pending: () => timers.filter((h) => !h.cleared).length,
  }
}

const ENV = { env: Object.freeze({ PATH: '/usr/bin' }) }

test('快速失败累计到阈值 → circuit-open，且不再安排重启', () => {
  const clock = makeClock()
  const children = []
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c },
    envFor: () => ENV,
    backoff: { baseMs: 100, factor: 2, maxMs: 1000, healthyAfterMs: 5000, circuitThreshold: 3 },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  })
  h.start()
  assert.equal(h.status().state, 'starting')
  // 三次「几乎立刻退出」
  for (let i = 0; i < 3; i += 1) {
    children[children.length - 1].exitNow(1)
    clock.advance(2000)
  }
  const st = h.status()
  assert.equal(st.state, 'circuit-open')
  assert.equal(st.restarts, 2, '熔断前只重启了 2 次（第 3 次快速失败直接熔断）')
  assert.match(st.lastError, /连续 3 次/)
  assert.equal(h.start().started, false, '熔断状态下 start 被拒绝')
  assert.equal(h.start().reason, 'circuit-open')
  assert.equal(clock.pending(), 0, '熔断后不得还有待触发的重启定时器')
})

test('熔断后 reset 可以人工重试（对应产品里的「重试」按钮）', () => {
  const clock = makeClock()
  const children = []
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c },
    envFor: () => ENV,
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1000, circuitThreshold: 2 },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  })
  h.start()
  children[0].exitNow(1)
  clock.advance(50)
  children[1].exitNow(1)
  assert.equal(h.status().state, 'circuit-open')
  assert.equal(h.reset(), 'pending')
  assert.equal(h.start().started, true)
  // 存活足够久之后再退出：退避必须归零（偶发故障，立刻恢复）
  clock.advance(2000)
  children[2].exitNow(0)
  const st = h.status()
  assert.equal(st.consecutiveFastFailures, 0)
  assert.equal(st.state, 'restarting')
})

test('存活超过 healthyAfterMs 的退出 → 快速失败计数归零并立刻重试', () => {
  const clock = makeClock()
  const children = []
  const delays = []
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c },
    envFor: () => ENV,
    backoff: { baseMs: 100, factor: 2, maxMs: 1000, healthyAfterMs: 3000, circuitThreshold: 5 },
    now: clock.now,
    setTimeoutImpl: (fn, ms) => { delays.push(ms); return clock.setTimeout(fn, ms) },
    clearTimeoutImpl: clock.clearTimeout,
  })
  h.start()
  children[0].exitNow(1)   // 立刻失败 → fastFailure=1，延迟 100
  clock.advance(100)
  clock.advance(5000)      // 第二个进程活了 5s
  children[1].exitNow(0)   // 久活后退出
  const st = h.status()
  assert.equal(st.consecutiveFastFailures, 0, '久活退出必须归零，否则偶发故障会被误判为启动期错误')
  assert.deepEqual(delays, [100, 100], '第二次重启回到 baseMs，不继续翻倍')
})

test('stop：SIGTERM 优雅退出；超过 graceMs 则强制杀进程树', async () => {
  const clock = makeClock()
  let killed = null
  const child = makeFakeChild()
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    killTree: async (c) => { killed = c.pid; return true },
  })
  h.start()
  const stopping = h.stop({ graceMs: 5000 })
  clock.advance(5000)       // 不给它退出的机会 → 走强杀
  const r = await stopping
  assert.equal(r.forced, true)
  assert.equal(killed, 4242, '必须杀进程树：只杀直接子进程会留下占端口的孙进程')
  assert.equal(h.status().state, 'stopped')
})

test('stop：进程在 grace 期内退出则不调用强杀', async () => {
  const clock = makeClock()
  let killed = false
  const child = makeFakeChild()
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    killTree: async () => { killed = true; return true },
  })
  h.start()
  const stopping = h.stop({ graceMs: 5000 })
  assert.deepEqual(child.kills, ['SIGTERM'])
  child.exitNow(0)
  const r = await stopping
  assert.equal(r.forced, false)
  assert.equal(killed, false)
})

test('未提供 envFor / spawnOptions.env 时抛错（不得默认继承宿主环境）', () => {
  const h = createSupervisedProcess(SPEC, { spawnImpl: () => makeFakeChild(), now: () => 0 })
  assert.throws(() => h.start(), /必须按白名单构造 env/)
})

test('markUnready(fatal) 直接熔断 —— 不可重试的失败等下去不会变好', () => {
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => makeFakeChild(),
    envFor: () => ENV,
    now: () => 0,
  })
  h.start()
  h.markUnready({ fatal: true, detail: '端口上是别的实例' })
  assert.equal(h.status().state, 'circuit-open')
  assert.equal(h.status().lastError, '端口上是别的实例')
})

test('createSupervisor：跳过入口未解析的进程，且 requiresAttention 只报需要人处理的', () => {
  const plan = materializeProcessPlan({
    layout: { installDir: 'C:\\Legion', platform: 'win32' },
    runtimeCommand: null,
  })
  const sup = createSupervisor(plan, { spawnImpl: () => makeFakeChild(), envFor: () => ENV, now: () => 0 })
  // runtime 的 command 为 null（entryKind=configured 未配置）→ 不参与监督
  assert.equal(sup.handles.has('runtime'), false)
  assert.equal(sup.handles.has('team-hub'), true)
  assert.deepEqual([...sup.requiresAttention()], [])
  sup.dispose()
})

test('defaultKillTree：非 Windows 用 SIGKILL；无 pid 时如实返回 false', async () => {
  const child = makeFakeChild()
  const ok = await defaultKillTree(child, { platform: 'linux' })
  assert.equal(ok, true)
  assert.deepEqual(child.kills, ['SIGKILL'])
  assert.equal(await defaultKillTree({ pid: undefined }, { platform: 'linux' }), false)
})

test('defaultKillTree：Windows 走 taskkill /T /F（杀树）', async () => {
  const child = makeFakeChild({ pid: 777 })
  const calls = []
  const fakeSpawn = (file, args) => {
    calls.push([file, ...args])
    const k = new EventEmitter()
    k.once = (ev, fn) => { if (ev === 'exit') setImmediate(() => fn(0)); return k }
    return k
  }
  const ok = await defaultKillTree(child, { platform: 'win32', spawnImpl: fakeSpawn })
  assert.equal(ok, true)
  assert.deepEqual(calls, [['taskkill', '/PID', '777', '/T', '/F']])
})
