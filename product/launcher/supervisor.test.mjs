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

// ============================================================================
// ★★★ 这根线**有没有人在看**——本组是补的，补的是一个已经发生过的洞
//
// 上面那些用例证明的是"采样器本身对"（喂字符串 → 解析对）。
// 而它们**全都**直接 `new` 采样器，绕过了 `supervisor.mjs` 的接线。
// 于是有一件事谁都没问过：
//
//   > `supervisor` 采出来的那个读数，**有没有任何消费者**？
//
// 实测答案（`scratch/verify-peak-resource-wired.mjs`，4 条变异**全部没咬住**）：
//
//   · 让 `peakResource()` 恒返回 `null`   → launcher 四套件全绿
//   · 把 `peakResource()` **整个删掉**     → 全绿
//   · 关掉周期采样                        → 全绿
//   · 让它谎报"采到了，是 0"               → 全绿
//
// 也就是说：采样器每 5 秒真采一次（win32 上起一台 PowerShell），
// 窗口维护得好好的，**而把这个数丢掉不会有任何判据发现**。
// 这正是 `peak-resource.mjs` 文件头第 32～34 行警告过的那种接线：
//
//   > 按它写采样器，会得到一个永远采不到东西、却看起来接好了的接线。
//
// 它还挡住了一件具体的事：PRT-009 的 `peak-resource` 缺一个读数，
// 而**就算真跑一次执行，那个数也会被算出来然后丢掉**——
// 那一项于是永远关不掉，理由还不是"没跑"，是"跑了也没人接"。
//
// 下面三条判据把消费者钉住：拔掉它，这里必须红。
// ============================================================================

/** 一个**注定采得到**的替身 io：不碰真进程，只喂一条合法的 win32 JSON。 */
function makePeakIo(initial = {}) {
  let t = 1_000
  const state = {
    workingSetBytes: 8 * 1024 * 1024,
    peakWorkingSetBytes: 64 * 1024 * 1024,
    cpuSeconds: 2.5,
    ...initial,
  }
  return {
    /** 让"被测进程"的内存**长上去**——周期采样的意义就在这里。 */
    set(next) { Object.assign(state, next) },
    platform: 'win32',
    now: () => (t += 100),
    readFile: () => { throw new Error('win32 路径不该读文件') },
    exec: () => ({
      ok: true,
      error: null,
      stdout: JSON.stringify({
        WorkingSet64: state.workingSetBytes,
        PeakWorkingSet64: state.peakWorkingSetBytes,
        CPU: state.cpuSeconds,
      }),
    }),
  }
}

test('★★★ peak-resource：进程退出时，读数必须真的**被交出去**（消费者存在）', () => {
  const logs = []
  const child = makeFakeChild({ pid: 5150 })
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    logger: (e) => logs.push(e),
    peakIo: makePeakIo(),
    peakSampleMs: 1000,
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1, circuitThreshold: 3 },
  })
  h.start()
  child.exitNow(0)

  const lines = logs.map((e) => e.message).filter((m) => typeof m === 'string' && m.includes('peak-resource'))
  assert.equal(lines.length, 1,
    `退出时应当**恰好一条** peak-resource 日志，实得 ${lines.length} 条：${JSON.stringify(lines)}`)
  // 读数要真是那个数，不是一句"有采样"的废话
  assert.match(lines[0], /peakWorkingSet=64MiB/)
  assert.match(lines[0], /cpu=2500ms/)
  assert.match(lines[0], /pid=5150/)

  // ★ 而 `status()` 上也拿得到——**结构性**的消费者，不只那一条日志
  assert.equal(h.status().peakResource.peakWorkingSetBytes, 64 * 1024 * 1024)
  // ★ 句柄上那个方法**自己**也得在：只断言 `status()` 的话，把
  //   `peakResource` 从句柄上摘掉是发现不了的（变异 ㊁ 实测全绿）。
  //   调用方是按 `handle.peakResource()` 拿的。
  assert.equal(h.peakResource().peakWorkingSetBytes, 64 * 1024 * 1024)
  assert.equal(h.peakResource().ok, true)
})

test('★★ peak-resource：周期采样**真的在推进**（不是只在 spawn 那一次采）', () => {
  // ★ 这一条补的是变异 ㊂：关掉 `setInterval` 那一段，本组原先**全绿**。
  //   原因是替身子进程立刻退出，周期根本没机会跑——
  //   于是"周期采样在推进"这件事，没有一条判据问过。
  //   而它恰恰是长驻进程（生产里的 DSH Runtime 活很久）唯一有用的那部分。
  let tick = null
  let cleared = 0
  const io = makePeakIo({ peakWorkingSetBytes: 4 * 1024 * 1024, cpuSeconds: 0.5 })
  const child = makeFakeChild({ pid: 5160 })
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    peakIo: io,
    peakSampleMs: 1000,
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} } },
    clearIntervalImpl: () => { cleared += 1; tick = null },
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1, circuitThreshold: 3 },
  })
  h.start()

  assert.equal(h.peakResource().samples, 1, 'spawn 之后应当**立刻**采过一次')
  assert.equal(h.peakResource().peakWorkingSetBytes, 4 * 1024 * 1024)
  assert.ok(typeof tick === 'function', '应当注册了周期采样定时器')

  // 让"被测进程"长到 16MB，然后走一个采样周期
  io.set({ peakWorkingSetBytes: 16 * 1024 * 1024, cpuSeconds: 3 })
  tick()

  const w = h.peakResource()
  assert.equal(w.samples, 2, `一个周期之后 samples 必须是 2，实得 ${w.samples}`)
  // ★ 窗口取**最大**：后来采到更大的要反映出来，早先的小读数不能被顶替掉
  assert.equal(w.peakWorkingSetBytes, 16 * 1024 * 1024, '窗口要取最大，不是取最后一次')
  assert.equal(w.cpuMs, 3000)

  // 而"关闭"真的把它关了（否则 unref 之后还可能继续采，白开 PowerShell）
  h.dispose()
  assert.equal(cleared >= 1, true, 'dispose 必须清掉采样定时器')
})

test('★★★ peak-resource：**采不到时不许印 0**（"不知道"与"零"必须不同形）', () => {
  const logs = []
  const child = makeFakeChild({ pid: 5151 })
  // 采不到的 io：PowerShell 起不来（进程没了、权限、解释器不在）
  const deadIo = {
    platform: 'win32',
    now: () => 1,
    readFile: () => { throw new Error('nope') },
    exec: () => ({ ok: false, stdout: '', error: new Error('Get-Process: 找不到进程') }),
  }
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    logger: (e) => logs.push(e),
    peakIo: deadIo,
    peakSampleMs: 1000,
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1, circuitThreshold: 3 },
  })
  h.start()
  child.exitNow(0)

  const lines = logs.map((e) => e.message).filter((m) => typeof m === 'string' && m.includes('peak-resource'))
  assert.equal(lines.length, 1, '采不到**也要报**——安静地不报会让"采不到"与"压根没接线"同形')
  assert.match(lines[0], /采不到/)
  assert.match(lines[0], /PEAK_RESOURCE_/)
  // ★ 核心：这一行里**不许出现任何看起来像读数的 0**
  assert.equal(/\b0MiB\b|\bcpu=0ms\b|\bsamples=0 采到/.test(lines[0]), false,
    `采不到时印了一个像读数的 0：${lines[0]}`)
  assert.match(lines[0], /不是 0/)
  // 窗口本身也不许被零填充
  assert.equal(h.status().peakResource.ok, false)
  assert.equal(h.status().peakResource.peakWorkingSetBytes, null)
})

test('★★ peak-resource：**没开采样**时不写那条日志（配置不同 ≠ 采不到）', () => {
  const logs = []
  const child = makeFakeChild({ pid: 5152 })
  const h = createSupervisedProcess(SPEC, {
    spawnImpl: () => child,
    envFor: () => ENV,
    logger: (e) => logs.push(e),
    peakSampleMs: 0,                 // ← 明确关掉
    backoff: { baseMs: 10, factor: 2, maxMs: 100, healthyAfterMs: 1, circuitThreshold: 3 },
  })
  h.start()
  child.exitNow(0)
  const lines = logs.map((e) => e.message).filter((m) => typeof m === 'string' && m.includes('peak-resource'))
  // ★ 与上一条**成对**：那一条要求"采不到必须报"，这一条要求"没开采样不必报"。
  //   两条都在，才说明写的人分得清这两种情况——
  //   只有一条的话，"安静地不报"既能表示"没开"也能表示"漏了"，又回到同形。
  assert.equal(lines.length, 0, `关掉采样后不该有 peak-resource 日志：${JSON.stringify(lines)}`)
  assert.equal(h.status().peakResource, null)
})

test('★★ peak-resource：`describePeakResource` 把"从未采样"与"采不到"分开说', async () => {
  const { describePeakResource } = await import('./supervisor.mjs')
  assert.match(describePeakResource(null), /从未采样/)
  const failed = describePeakResource({ ok: false, pid: 7, samples: 3, lastCode: PEAK_RESOURCE_CODES.PROCESS_GONE })
  assert.match(failed, /PEAK_RESOURCE_PROCESS_GONE/)
  assert.match(failed, /unknown/)
  const okd = describePeakResource({
    ok: true, pid: 7, samples: 2, peakWorkingSetBytes: 3 * 1024 * 1024, peakRssBytes: null, cpuMs: 250,
  })
  assert.match(okd, /peakWorkingSet=3MiB/)
  assert.match(okd, /peakRss=unknown/)       // 分量各自判空
  assert.match(okd, /cpu=250ms/)
  // ★ 三句话两两不同——与检出解析器那组同一条纪律：
  //   一个把三种情况说成两句的渲染器，会让读日志的人分不清该去修什么。
  assert.equal(new Set([describePeakResource(null), failed, okd]).size, 3)
})

