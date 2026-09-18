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
import { spawn } from 'node:child_process'
import {
  PEAK_RESOURCE_CODES,
  PEAK_RESOURCE_METHODS,
  createPeakResourceSampler,
  normalizePid,
  parseProcStat,
  parseProcStatus,
  parseWin32ProcessJson,
} from './peak-resource.mjs'

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

// ============================================================================
// PRT-009 `peak-resource`：执行期外部采样
//
// 这些用例**留在这个文件里**是有意的：本模块的接线点在 `supervisor.mjs`
// （被监督的那台进程就是生产里的长驻 DSH Runtime），而 `run-ci.mjs` 的
// 套件清单此刻被另一个会话持有未提交改动，新增一个套件文件需要改那一行——
// 那就是"git add 扫到别人的共享文件"那类事故的入口（本仓 84ef8d7 记过一次）。
// 所以它们先走已登记的 `product-launcher` 套件，等清单空出来再拆成独立套件。
//
// 纪律：**测不到写 `null`，不写 0**。`0` 是测量结论，不是"不知道"。
// ============================================================================

test('peak-resource：pid 归一化——`0`/负数/小数/非数字都不算 pid', () => {
  assert.equal(normalizePid(123), 123)
  assert.equal(normalizePid('456'), 456)
  // ★ `0` 在 win32 上是"系统空闲进程"，把它当成"没有 pid"是**两个不同的意思**，
  //   但对采样来说都不可用——所以拒绝，而不是回落到 0。
  assert.equal(normalizePid(0), null)
  assert.equal(normalizePid(-1), null)
  assert.equal(normalizePid(1.5), null)
  assert.equal(normalizePid('abc'), null)
  assert.equal(normalizePid(''), null)
  assert.equal(normalizePid(null), null)
  assert.equal(normalizePid(undefined), null)
})

test('peak-resource：win32 的 JSON——三个字段各自判空，一个读不到不牵连另外两个', () => {
  const full = parseWin32ProcessJson('{"WorkingSet64":1048576,"PeakWorkingSet64":2097152,"CPU":1.5}')
  assert.equal(full.workingSetBytes, 1048576)
  assert.equal(full.peakWorkingSetBytes, 2097152)
  assert.equal(full.cpuMs, 1500)

  // `PeakWorkingSet64` 拿不到时，另外两个**仍然有效**。
  const partial = parseWin32ProcessJson('{"WorkingSet64":1048576,"PeakWorkingSet64":null,"CPU":2}')
  assert.equal(partial.workingSetBytes, 1048576)
  assert.equal(partial.peakWorkingSetBytes, null)
  assert.equal(partial.cpuMs, 2000)

  // 全空 / 垃圾 ⇒ `null`（"没读到"），而不是一个零填充的对象。
  assert.equal(parseWin32ProcessJson('{"WorkingSet64":null,"PeakWorkingSet64":null,"CPU":null}'), null)
  assert.equal(parseWin32ProcessJson('not json'), null)
  assert.equal(parseWin32ProcessJson(''), null)
})

test('peak-resource：/proc/<pid>/status 的 kB 要换算成字节', () => {
  const text = 'Name:\tnode\nVmPeak:\t  204800 kB\nVmHWM:\t  153600 kB\nVmRSS:\t  102400 kB\n'
  const r = parseProcStatus(text)
  assert.equal(r.peakRssBytes, 153600 * 1024)
  assert.equal(r.rssBytes, 102400 * 1024)
  assert.equal(parseProcStatus('Name:\tnode\n'), null)
})

test('peak-resource：/proc/<pid>/stat 的进程名带空格与括号也不能错位', () => {
  // comm 里带空格与括号（内核允许）——按空格切会让后面每个字段整体错位，
  // 而错位**不会报错**，只会把 utime/stime 读成完全无关的两个数。
  //
  // 字段位置要对准：切开 `)` 之后 `rest[0]` 是 state（原第 3 字段），
  // 所以 utime(第 14)/stime(第 15) 落在 `rest[11]`/`rest[12]`。
  const rest = ['S', ...Array.from({ length: 10 }, (_, k) => String(k + 1)), '30', '70']
  const stat = `1234 (node (weird) name) ${rest.join(' ')}`
  const r = parseProcStat(stat, { clockTicksPerSecond: 100 })
  // utime=30, stime=70 ⇒ 100 ticks ⇒ 1000ms
  assert.equal(r.cpuMs, 1000)
  assert.equal(parseProcStat('garbage'), null)
})

test('peak-resource：采不到时给**具名码**，不给 0', () => {
  const io = { platform: 'win32', now: () => 1000 }

  // ① 没有 pid
  const noPid = createPeakResourceSampler({ pid: null, io })
  assert.equal(noPid.readOnce().ok, false)
  assert.equal(noPid.readOnce().code, PEAK_RESOURCE_CODES.NO_PID)
  assert.equal(noPid.window().ok, false)
  assert.equal(noPid.window().peakWorkingSetBytes, null)

  // ② 平台没实现（既不是 win32 也不是有 /proc 的 posix）
  const alien = createPeakResourceSampler({ pid: 42, io: { ...io, platform: 'aix' } })
  assert.equal(alien.readOnce().code, PEAK_RESOURCE_CODES.UNSUPPORTED_PLATFORM)

  // ③ 进程没了：命令失败且 stdout 为空 ⇒ `PROCESS_GONE`（不是 `UNPARSEABLE`）
  const gone = createPeakResourceSampler({
    pid: 42, io: { platform: 'win32', now: () => 1, exec: () => ({ ok: false, stdout: '', error: new Error('no such process') }) },
  })
  assert.equal(gone.readOnce().code, PEAK_RESOURCE_CODES.PROCESS_GONE)

  // ④ 命令成功但读不出来 ⇒ `UNPARSEABLE`——**不能**当成"采到了"。
  const junk = createPeakResourceSampler({
    pid: 42, io: { platform: 'win32', now: () => 1, exec: () => ({ ok: true, stdout: 'oops' }) },
  })
  assert.equal(junk.readOnce().code, PEAK_RESOURCE_CODES.UNPARSEABLE)

  // ⑤ 采样本身抛 ⇒ `SAMPLE_FAILED`，且不带出原始异常之外的东西
  const boom = createPeakResourceSampler({
    pid: 42, io: { platform: 'win32', now: () => 1, exec: () => { throw new Error('EACCES') } },
  })
  assert.equal(boom.readOnce().code, PEAK_RESOURCE_CODES.SAMPLE_FAILED)
})

test('peak-resource：窗口取最大；失败的那一次不抹掉已有读数', () => {
  // ★ 读数序列由**调用序号**驱动，不由 `now()` 驱动：`now()` 在构造时也会被调一次，
  //   用它当游标会让"第几次采样"取决于构造函数内部调了几次 now——
  //   那种用例测的是实现的调用顺序，不是它该保证的性质。
  const seq = [
    { ok: true, stdout: '{"WorkingSet64":100,"PeakWorkingSet64":100,"CPU":1}' },
    { ok: true, stdout: '{"WorkingSet64":500,"PeakWorkingSet64":500,"CPU":2}' },
    { ok: true, stdout: '{"WorkingSet64":300,"PeakWorkingSet64":300,"CPU":3}' },
    { ok: false, stdout: '', error: new Error('gone') },
  ]
  let i = 0
  const io = {
    platform: 'win32',
    now: () => 1_000 + i * 10,
    exec: () => seq[Math.min(i++, seq.length - 1)],
  }
  const s = createPeakResourceSampler({ pid: 7, io })
  s.sample(); s.sample(); s.sample()
  const w = s.window()
  assert.equal(w.ok, true)
  assert.equal(w.samples, 3)
  // 峰值是**窗口内的最大**，不是最后一次。
  assert.equal(w.peakWorkingSetBytes, 500)
  assert.equal(w.cpuMs, 3000)
  assert.equal(w.lastCode, null)

  // 之后再采失败一次：读数**保留**，同时 `lastCode` 说出最后是怎么结束的。
  const after = s.sample()
  assert.equal(after.ok, false)
  const w2 = s.window()
  assert.equal(w2.ok, true, '采到过就是采到过——进程后来死了不改变已经观测到的峰值')
  assert.equal(w2.peakWorkingSetBytes, 500)
  assert.equal(w2.lastCode, PEAK_RESOURCE_CODES.PROCESS_GONE)
})

test('peak-resource：对一台**真**进程采样（win32 走 Get-Process；采样不到就如实红）', { skip: process.platform !== 'win32' }, async () => {
  // 这一条不是替身：起一个真子进程、让它真的占内存，再从**进程外部**采它。
  // 没有它，上面那些用例只证明"解析器对喂进去的字符串是对的"。
  const child = spawn(process.execPath, [
    '-e',
    'const a=[];for(let i=0;i<120;i++)a.push(Buffer.alloc(1024*1024,7));setTimeout(()=>{},20000)',
  ], { stdio: 'ignore', windowsHide: true })
  try {
    const sampler = createPeakResourceSampler({ pid: child.pid })
    const peak = () => sampler.window().peakWorkingSetBytes ?? 0
    let reading = sampler.sample()
    const firstOk = reading.ok ? reading : null
    // 采到"看得见那 120MB"为止；内存是逐步上去的，所以第一次可能还很小。
    for (let i = 0; i < 10 && reading.ok && peak() < 100 * 1024 * 1024; i++) {
      await new Promise((r) => setTimeout(r, 300))
      reading = sampler.sample()
    }
    const w = sampler.window()
    // ★ 判据落在**窗口**上，不落在"最后一次采样"上：窗口保留已经观测到的峰值，
    //   而最后一次采样完全可能发生在进程退出**之后**——那时外部采样只能得到
    //   `PROCESS_GONE`，那是"这次没采到"，不是"峰值没了"。
    //   （第一版就是断言在最后一次读数上，于是子进程活到 8s 自然退出时误红。）
    assert.equal(w.ok, true, `一次都没采到：${reading.code ?? ''} ${reading.error ?? ''}`)
    assert.equal(w.pid, child.pid)
    assert.equal(firstOk?.method, PEAK_RESOURCE_METHODS.WIN32_GET_PROCESS)
    assert.ok(w.samples > 0)
    assert.ok(w.peakWorkingSetBytes > 100 * 1024 * 1024, `峰值应当 > 100MB，实得 ${w.peakWorkingSetBytes}`)
  } finally {
    try { child.kill() } catch { /* 已经退了 */ }
  }
})

