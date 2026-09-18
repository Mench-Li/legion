// orchestrator/worker/run-peak-resource.test.mjs
// ============================================================================
// PRT-009 `peak-resource` 的 worker 侧：**先认端点，再信 pid**。
//
// 本文件里最要紧的一条是「发布说的是别人的进程时，一个数都不采」。
// 它不是防御性编程：worker 只能拿到 `LEGION_RUNTIME_URL`，拿不到 pid，
// 所以一份**属于上一次运行**的发布文件在它眼里与本次那份**形状完全相同**，
// 而那个 pid 可能早已被系统回收给了一个毫不相干的进程。
// 照它采样不会报错、也不会采到 0——它会**采到别人的数**。
//
// 第二条要紧的是「采样失败永远不许让一次 Run 失败」：资源是可观测量，
// 不是正确性条件。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RUN_PEAK_SAMPLE_MS,
  RUN_PEAK_CODES,
  attachRunPeakResource,
  parseRuntimeEndpoint,
  readRuntimePublication,
  resolveRuntimePidForSampling,
  withRunPeakResource,
} from './run-peak-resource.mjs'

const DATA_DIR = 'D:\\data'
const URL_OK = 'http://127.0.0.1:4567'

/** 一份**形状合法**的发布记录。 */
const RECORD = Object.freeze({ version: 1, pid: 4242, host: '127.0.0.1', port: 4567, wireVersion: 1 })

const fsWith = (text) => ({ readFileSync: () => text })
const fsMissing = () => ({ readFileSync: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e } })
const fsDenied = () => ({ readFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e } })

// ── 端点解析 ────────────────────────────────────────────────────────────────

test('parseRuntimeEndpoint：正常 URL 取出 host/port', () => {
  assert.deepEqual(parseRuntimeEndpoint('http://127.0.0.1:4567'), { host: '127.0.0.1', port: 4567 })
  assert.deepEqual(parseRuntimeEndpoint('http://localhost:80'), { host: 'localhost', port: 80 })
})

test('parseRuntimeEndpoint：IPv6 的方括号要剥掉（否则正常的 IPv6 部署会被判成"别人的进程"）', () => {
  // `new URL('http://[::1]:4567').hostname` 给的是 `[::1]`，而发布文件里是 `::1`。
  assert.deepEqual(parseRuntimeEndpoint('http://[::1]:4567'), { host: '::1', port: 4567 })
})

test('parseRuntimeEndpoint：省略的端口取**协议默认值**（那不是猜，是规范）', () => {
  // ★ WHATWG 的 URL 会把默认端口规范化掉：`http://localhost:80` 的 `.port` 是空串。
  //   第一版据此返回 `null`，理由写的是"不能猜 80"——那个理由是错的，
  //   于是 `http://localhost` 这个完全可解析的端点被报成 BAD_RUNTIME_URL。
  assert.deepEqual(parseRuntimeEndpoint('http://localhost'), { host: 'localhost', port: 80 })
  assert.deepEqual(parseRuntimeEndpoint('http://localhost:80'), { host: 'localhost', port: 80 })
  assert.deepEqual(parseRuntimeEndpoint('https://example.test'), { host: 'example.test', port: 443 })
})

test('parseRuntimeEndpoint：**不认识**的协议一律 null（那时默认端口才是猜的）', () => {
  assert.equal(parseRuntimeEndpoint('ftp://127.0.0.1:4567'), null)
  assert.equal(parseRuntimeEndpoint('不是 URL'), null)
  assert.equal(parseRuntimeEndpoint(''), null)
  assert.equal(parseRuntimeEndpoint(null), null)
  assert.equal(parseRuntimeEndpoint(undefined), null)
})

// ── 发布文件的形状校验 ──────────────────────────────────────────────────────

test('readRuntimePublication：没有 DataDir ⇒ 具名拒绝（不猜路径）', () => {
  const r = readRuntimePublication({ dataDir: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUN_PEAK_CODES.NO_DATA_DIR)
  assert.equal(r.path, null)
})

test('readRuntimePublication：文件不在 与 读不动 是两个码（修法不同）', () => {
  const absent = readRuntimePublication({ dataDir: DATA_DIR, fs: fsMissing(), joinImpl: (...p) => p.join('/') })
  assert.equal(absent.code, RUN_PEAK_CODES.PUBLICATION_ABSENT)
  const denied = readRuntimePublication({ dataDir: DATA_DIR, fs: fsDenied(), joinImpl: (...p) => p.join('/') })
  assert.equal(denied.code, RUN_PEAK_CODES.PUBLICATION_UNREADABLE)
  assert.notEqual(absent.code, denied.code)
})

test('readRuntimePublication：坏 JSON / 坏字段 / 未知字段一律 INVALID——不回落成"文件在就用"', () => {
  const j = (...p) => p.join('/')
  const cases = [
    ['不是 JSON', 'oops'],
    ['顶层是数组', '[1,2]'],
    ['version 不对', JSON.stringify({ ...RECORD, version: 99 })],
    // ★ pid 就是消费侧唯一的陈旧判据；它必须是正整数。`undefined` 传给
    //   `Get-Process -Id undefined` 会得到一个**语法错误**，那不是"采不到"。
    ['pid 不是正整数', JSON.stringify({ ...RECORD, pid: 0 })],
    ['pid 是字符串', JSON.stringify({ ...RECORD, pid: '4242' })],
    ['host 不是回环', JSON.stringify({ ...RECORD, host: '0.0.0.0' })],
    ['port 越界', JSON.stringify({ ...RECORD, port: 70000 })],
    ['wireVersion 不对', JSON.stringify({ ...RECORD, wireVersion: 2 })],
    ['多出未知字段', JSON.stringify({ ...RECORD, extra: 1 })],
  ]
  for (const [why, text] of cases) {
    const r = readRuntimePublication({ dataDir: DATA_DIR, fs: fsWith(text), joinImpl: j })
    assert.equal(r.ok, false, `${why} 应当被拒`)
    assert.equal(r.code, RUN_PEAK_CODES.PUBLICATION_INVALID, `${why} 应当是 INVALID`)
  }
  // 合法的那份必须过——否则上面每一条都可以靠"永远拒绝"通过。
  const good = readRuntimePublication({ dataDir: DATA_DIR, fs: fsWith(JSON.stringify(RECORD)), joinImpl: j })
  assert.equal(good.ok, true)
  assert.equal(good.record.pid, 4242)
})

// ── 先认端点，再信 pid（本文件的核心） ──────────────────────────────────────

test('★★★ resolveRuntimePidForSampling：发布说的是**别人的**进程时，一个数都不采', () => {
  const j = (...p) => p.join('/')
  // 端口不符：这正是"上一次运行留下的那份发布"的形状。
  const foreign = resolveRuntimePidForSampling({
    dataDir: DATA_DIR, runtimeUrl: URL_OK,
    fs: fsWith(JSON.stringify({ ...RECORD, port: 9999 })), joinImpl: j,
  })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.code, RUN_PEAK_CODES.PUBLICATION_FOREIGN)
  assert.equal(foreign.pid, undefined, 'FOREIGN 时**不得**把那个 pid 交出去')

  // host 不符同理。
  const foreignHost = resolveRuntimePidForSampling({
    dataDir: DATA_DIR, runtimeUrl: 'http://localhost:4567',
    fs: fsWith(JSON.stringify(RECORD)), joinImpl: j,
  })
  assert.equal(foreignHost.code, RUN_PEAK_CODES.PUBLICATION_FOREIGN)
})

test('resolveRuntimePidForSampling：端点与发布一致时才交出 pid', () => {
  const r = resolveRuntimePidForSampling({
    dataDir: DATA_DIR, runtimeUrl: URL_OK,
    fs: fsWith(JSON.stringify(RECORD)), joinImpl: (...p) => p.join('/'),
  })
  assert.equal(r.ok, true)
  assert.equal(r.pid, 4242)
  assert.equal(r.host, '127.0.0.1')
  assert.equal(r.port, 4567)
  assert.ok(r.path.endsWith('runtime/runtime-contract.json'), `路径应当是发布文件：${r.path}`)
})

test('resolveRuntimePidForSampling：URL 缺失 ⇒ 具名拒绝（没有端点就无从判断身份）', () => {
  const r = resolveRuntimePidForSampling({ dataDir: DATA_DIR, runtimeUrl: null })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUN_PEAK_CODES.BAD_RUNTIME_URL)
})

// ── 按 Run 开合的窗口 ───────────────────────────────────────────────────────

function fakeExecutor(result = { outcome: 'completed' }) {
  return { execute: async () => result }
}

function fakeSamplerFactory(peak = 1234) {
  const calls = { sample: 0, window: 0 }
  return {
    calls,
    create: () => ({
      sample: () => { calls.sample += 1; return { ok: true } },
      window: () => { calls.window += 1; return { ok: true, pid: 4242, peakWorkingSetBytes: peak } },
    }),
  }
}

const okResolve = () => ({ ok: true, pid: 4242, host: '127.0.0.1', port: 4567, path: 'p' })

test('withRunPeakResource：没有出口就不包（"接了但没人读"与"没接"不许同形）', () => {
  const ex = fakeExecutor()
  assert.equal(withRunPeakResource(ex, { resolvePid: okResolve }), ex, '没有 onReading 时应当原样返回')
  assert.equal(withRunPeakResource(ex, { onReading: () => {}, resolvePid: null }), ex, '没有 resolvePid 时应当原样返回')
  assert.equal(withRunPeakResource(null, { onReading: () => {}, resolvePid: okResolve }), null)
})

test('withRunPeakResource：一次 Run 开一个窗口、关一次、交一次读数', async () => {
  const f = fakeSamplerFactory(2048)
  const seen = []
  const wrapped = withRunPeakResource(fakeExecutor({ outcome: 'completed' }), {
    onReading: (reading, ctx) => seen.push([reading, ctx]),
    resolvePid: okResolve,
    createSampler: f.create,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  })
  const out = await wrapped.execute({ a: 1 })
  assert.deepEqual(out, { outcome: 'completed' }, '执行的返回值必须原样透传')
  assert.equal(seen.length, 1, '一次 Run 应当**恰好**交一次读数')
  assert.equal(seen[0][0].peakWorkingSetBytes, 2048)
  assert.equal(seen[0][1].pid, 4242)
  assert.ok(f.calls.sample >= 1, '开窗口时应当先采一次（否则短命的 Run 一个读数都没有）')
})

test('★★★ withRunPeakResource：解析不出 pid 时，Run **照常成功**，只是没有读数', async () => {
  const seen = []
  const wrapped = withRunPeakResource(fakeExecutor({ outcome: 'completed' }), {
    onReading: (r) => seen.push(r),
    resolvePid: () => ({ ok: false, code: RUN_PEAK_CODES.PUBLICATION_FOREIGN, message: '不是这台' }),
    createSampler: () => { throw new Error('不该被调用') },
  })
  const out = await wrapped.execute()
  assert.deepEqual(out, { outcome: 'completed' })
  assert.deepEqual(seen, [], '没有 pid 就不该交读数')
})

test('★★★ withRunPeakResource：出口抛错也不许把一次成功的 Run 变成失败', async () => {
  const wrapped = withRunPeakResource(fakeExecutor({ outcome: 'completed' }), {
    onReading: () => { throw new Error('出口坏了') },
    resolvePid: okResolve,
    createSampler: fakeSamplerFactory().create,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  })
  const out = await wrapped.execute()
  assert.deepEqual(out, { outcome: 'completed' }, '资源读数是可观测量，不是正确性条件')
})

test('withRunPeakResource：执行抛错时窗口仍然关闭（不泄漏定时器），错误原样上抛', async () => {
  let cleared = 0
  const wrapped = withRunPeakResource(
    { execute: async () => { throw new Error('引擎炸了') } },
    {
      onReading: () => {},
      resolvePid: okResolve,
      createSampler: fakeSamplerFactory().create,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => { cleared += 1 },
    },
  )
  await assert.rejects(() => wrapped.execute(), /引擎炸了/)
  assert.equal(cleared, 1, '失败路径也必须把定时器清掉')
})

test('withRunPeakResource：采样器抛错被吞掉，Run 不受影响', async () => {
  const wrapped = withRunPeakResource(fakeExecutor({ outcome: 'completed' }), {
    onReading: () => {},
    resolvePid: okResolve,
    createSampler: () => { throw new Error('采样器起不来') },
  })
  const out = await wrapped.execute()
  assert.deepEqual(out, { outcome: 'completed' })
})

// ── 接在 executorProvider 上的那条策略（会**静默失效**的那一处） ────────────

/** `executor.mjs:614` 的真实成功形状。 */
const PROVIDED_OK = (execute) => ({ ok: true, executor: { buildContext: async () => {}, execute }, selfCheck: { ok: true } })

const opts = () => ({
  onReading: () => {},
  resolvePid: okResolve,
  createSampler: fakeSamplerFactory().create,
  setIntervalImpl: () => ({ unref() {} }),
  clearIntervalImpl: () => {},
})

test('★★★ attachRunPeakResource：成功形状必须被**真的包上**（否则就是"接上了但一条读数都没有"）', async () => {
  const orig = PROVIDED_OK(async () => ({ outcome: 'completed' }))
  const out = attachRunPeakResource(orig, opts())
  assert.equal(out.ok, true)
  assert.notEqual(out.executor, orig.executor, 'executor 必须是**新的**（被包过的）那个')
  assert.notEqual(out, orig, '外壳也应当是一个新对象')
  // 包过之后仍然保留其余字段（selfCheck 不能被吃掉）。
  assert.deepEqual(out.selfCheck, { ok: true })
  // 而且真的能跑。
  assert.deepEqual(await out.executor.execute(), { outcome: 'completed' })
})

test('★★★ attachRunPeakResource：失败形状**原样**返回——不合成一个新的拒绝', () => {
  for (const bad of [
    { ok: false, code: 'EXECUTOR_HOST_PORT_REQUIRED', message: 'm', reasons: [] },
    { ok: false, code: 'EXECUTOR_BAD_WIRING', message: 'm', reasons: [] },
  ]) {
    const out = attachRunPeakResource(bad, opts())
    assert.equal(out, bad, '失败形状必须**同一个引用**返回：调用方那句具名拒绝才是该报出来的')
    assert.equal(out.code, bad.code, '码不能被顶掉')
  }
})

test('★★ attachRunPeakResource：形状不对（缺 executor / 不是对象）也不炸、也不改', () => {
  // `ok: true` 但没有 executor —— 这正是"形状判断写错就会静默不生效"的那一类。
  const noExec = { ok: true, selfCheck: {} }
  assert.equal(attachRunPeakResource(noExec, opts()), noExec)
  assert.equal(attachRunPeakResource(null, opts()), null)
  assert.equal(attachRunPeakResource(undefined, opts()), undefined)
  assert.equal(attachRunPeakResource(42, opts()), 42)
})

test('★★ attachRunPeakResource：没有出口时**同一个引用**返回（不换壳，免得不生效被新 identity 盖住）', () => {
  const orig = PROVIDED_OK(async () => ({}))
  // 没有 onReading ⇒ withRunPeakResource 原样返回 executor ⇒ 这里也该原样返回。
  const out = attachRunPeakResource(orig, { resolvePid: okResolve })
  assert.equal(out, orig)
})

test('默认采样周期与 supervisor 那份取同一个数（0 表示不采样）', () => {
  assert.equal(DEFAULT_RUN_PEAK_SAMPLE_MS, 5000)
  const answered = []
  const wrapped = withRunPeakResource(fakeExecutor(), {
    onReading: () => answered.push(1),
    resolvePid: okResolve,
    sampleMs: 0,
    createSampler: () => { throw new Error('sampleMs<=0 时不该造采样器') },
  })
  return wrapped.execute().then(() => {
    // sampleMs<=0 时窗口是 null，但 closeWindow 对 null 是空操作——
    // 也就是说**不会**交读数，也不会抛。
    assert.deepEqual(answered, [])
  })
})
