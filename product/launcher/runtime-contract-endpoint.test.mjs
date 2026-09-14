// product/launcher/runtime-contract-endpoint.test.mjs
// ============================================================================
// Runtime Contract **消费侧**的判据（PRT-253 续批四）
//
// 本套件回答三个问题，每一个都对应一条真实会发生的处境：
//
//   ① **两份副本没漂**：写侧（`runtime/dsh-composition/`）与读侧（本目录）
//      各自写了一份发布格式。三样东西必须逐字相同：版本、相对路径片段、字段清单。
//      少了这条判据，一次"只改了一边"的重构会让读侧在**运行期**才失效，
//      而失效的样子是"发布缺失"——一个把人指向完全错误方向的读数。
//
//   ② **配额与凭证的纪律**：每次启动一份、生成不出来就 fail closed、
//      拒绝里不含任何值。
//
//   ③ **读回来的每一条拒绝都可分辨**：不在 / 读不了 / 内容非法 / 是旧进程的 /
//      连路径都不知道——五条各自的下一步动作都不一样。
//
// ## 测试形状纪律
//
//   · 断言**具名码本身**（`r.code === CODES.X`），不是"它失败了"；
//   · 不用 `[...].includes(code)` 代替相等——那是"其中一条就行"，
//     而本套件要的恰恰是"只能是这一条"；
//   · 反向对照：同一个读数在两种处境下**必须不同**（`.published` 那种
//     "两种处境同形"的断言在这里是不合格的）。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RUNTIME_CONTRACT_ENDPOINT_CODES,
  RUNTIME_CONTRACT_ENDPOINT_VERSION,
  RUNTIME_CONTRACT_PUBLICATION_FIELDS,
  RUNTIME_CONTRACT_PUBLICATION_RELPATH,
  RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS,
  RUNTIME_CONTRACT_PUBLICATION_VERSION,
  RUNTIME_CONTRACT_RETRYABLE_CODES,
  RUNTIME_CONTRACT_TOKEN_BYTES,
  RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED,
  generateRuntimeToken,
  readRuntimeContractEndpoint,
  runtimeContractDiagnostic,
  runtimeContractEndpointPath,
  waitForRuntimeContractEndpoint,
} from './runtime-contract-endpoint.mjs'
import { LOOPBACK_HOSTS } from '../process-manifest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 写侧模块 —— 本套件要拿它做**两份副本的对账**。 */
const WRITER = join(HERE, '..', '..', 'runtime', 'dsh-composition', 'runtime-contract-publication.mjs')
const WIRE = join(HERE, '..', '..', 'runtime', 'contracts', 'wire.mjs')

const SELF_PID = process.pid
const DATA_DIR = join(tmpdir(), 'legion-rcendpoint', 'data')
const PUB_PATH = join(DATA_DIR, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)

/** 一个只读的 fs 替身：内容由 `text` 决定，或由 `throwCode` 决定怎么失败。 */
function readFs({ text = null, throwCode = null } = {}) {
  const calls = []
  return {
    calls,
    readFileSync(p, enc) {
      calls.push([p, enc])
      if (throwCode !== null) throw Object.assign(new Error(`${throwCode}: 注入的失败`), { code: throwCode })
      return text
    },
    rmSync(p, o) { calls.push(['rm', p, o]) },
  }
}

/** 一份合法的发布记录。 */
function record(over = {}) {
  return { version: RUNTIME_CONTRACT_PUBLICATION_VERSION, pid: SELF_PID, host: '127.0.0.1', port: 51814, wireVersion: RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED, ...over }
}

// ═══════════════════════════════════════════ ① 两份副本的对账

test('① ★★★ 读侧与写侧的格式**逐段**对账：版本 / 相对路径 / 字段清单', async () => {
  const w = await import(`file:///${WRITER.replace(/\\/g, '/')}`)

  assert.equal(RUNTIME_CONTRACT_PUBLICATION_VERSION, w.RUNTIME_CONTRACT_PUBLICATION_VERSION,
    '发布格式版本漂了：读侧会把自己这一版当成唯一正确答案，然后拒绝写侧写的每一份')
  assert.deepEqual([...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS], [...w.RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS],
    '相对路径片段漂了：读侧会在错误的路径上找发布，而"找不到"会被报成"Runtime 没发布"')
  assert.equal(RUNTIME_CONTRACT_PUBLICATION_RELPATH, w.RUNTIME_CONTRACT_PUBLICATION_RELPATH)
  assert.deepEqual([...RUNTIME_CONTRACT_PUBLICATION_FIELDS], [...w.RUNTIME_CONTRACT_PUBLICATION_FIELDS],
    '字段清单漂了：多一个/少一个都会让读侧静默读到 undefined')
  // 回环集合两边同源：写侧只允许回环，读侧也只接受回环
  assert.deepEqual([...w.RUNTIME_CONTRACT_PUBLICATION_HOSTS].sort(), [...LOOPBACK_HOSTS].sort(),
    '写侧允许的回环地址与 Launcher 认的不是同一组')
})

test('① ★★ 读侧认的线上协议版本 == `runtime/contracts/wire.mjs` 的那一个', async () => {
  const w = await import(`file:///${WIRE.replace(/\\/g, '/')}`)
  assert.equal(RUNTIME_CONTRACT_WIRE_VERSION_EXPECTED, w.RUNTIME_CONTRACT_WIRE_VERSION,
    '协议版本与 wire.mjs 不一致：一个"端口能用但版本对不上"的端点会让每一次请求都在解析处失败')
})

test('① 读侧与写侧**真的能对上**：真写一份，读回来逐字相等（真盘往返）', async () => {
  const w = await import(`file:///${WRITER.replace(/\\/g, '/')}`)
  const root = mkdtempSync(join(tmpdir(), 'legion-rcrt-'))
  try {
    const dataDir = join(root, 'data')
    const written = w.publishRuntimeContractEndpoint({ dataDir, host: '127.0.0.1', port: 51999, pid: SELF_PID })
    assert.equal(written.ok, true, `${written.code} ${written.message}`)
    const read = readRuntimeContractEndpoint({ dataDir, expectedPid: SELF_PID })
    assert.equal(read.ok, true, `${read.code} ${read.message}`)
    assert.equal(read.url, 'http://127.0.0.1:51999')
    assert.equal(read.port, 51999)
    assert.equal(read.pid, SELF_PID)
    assert.equal(read.path, join(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS))
    // 写侧发布的 pid 是它自己的；读侧换一个期望 pid → 必须判 STALE（不是"成功"）
    const stale = readRuntimeContractEndpoint({ dataDir, expectedPid: SELF_PID + 1 })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════ ② 凭证

test('② 每次调用生成一份新凭证：长度够、无空白、base64url 字符集、且两次**不相同**', () => {
  const a = generateRuntimeToken()
  const b = generateRuntimeToken()
  assert.equal(a.ok, true, `${a.code} ${a.message}`)
  assert.equal(b.ok, true)
  assert.match(a.token, /^[A-Za-z0-9_-]+$/, `凭证里有非 base64url 字符：${a.token.length} 个字符`)
  assert.ok(a.token.length >= RUNTIME_CONTRACT_TOKEN_BYTES, `凭证太短：${a.token.length}`)
  assert.equal(/\s/.test(a.token), false)
  // ★ "每次启动一份"的反面证据：两次生成不能撞。
  //   撞了说明实现变成了"一个常量"或"一个可预测的派生"。
  assert.notEqual(a.token, b.token, '两次生成拿到了同一份凭证——那说明它不是每次新生成的')
})

test('② 随机源抛错 → `TOKEN_GENERATION_FAILED`，且**不返回任何 token 字段**（fail closed）', () => {
  const boom = () => { throw new Error('ENODEV: 没有随机源') }
  const r = generateRuntimeToken({ randomBytesImpl: boom })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED)
  assert.equal('token' in r, false, '失败路径上还留着 token 字段——调用方可能照用')
  assert.match(r.message, /ENODEV/)
  assert.ok(r.reasons.some((s) => s.includes('不注入任何凭证')))
})

test('② 随机源返回不可用的值（不是缓冲/太短/带空白）→ 同样 fail closed', () => {
  for (const bad of ['not-a-buffer', { toString: () => 'short' }, 42, null, undefined]) {
    const r = generateRuntimeToken({ randomBytesImpl: () => bad })
    assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED,
      `随机源返回 ${String(bad)} 竟然成功了`)
    assert.equal('token' in r, false)
  }
  // 带空白的"长"值也不行：一个含空白的凭证在 HTTP 头里会被截断，
  // 而症状是"凭证不对"——离真因很远。
  const spaced = generateRuntimeToken({ randomBytesImpl: () => ({ toString: () => 'a'.repeat(44).slice(0, 20) + ' ' + 'b'.repeat(24) }) })
  assert.equal(spaced.code, RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED)
})

// ═══════════════════════════════════════════ ③ 读回来的五条拒绝

test('③ 发布不在 → `PUBLICATION_ABSENT`，且结果里**没有一个可用的 url**', () => {
  const fs = readFs({ throwCode: 'ENOENT' })
  const r = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT)
  assert.equal('url' in r, false, '拒绝里带着 url —— 调用方可能顺手用它，那就等于编了一个 URL')
  assert.equal(r.path, PUB_PATH)
  assert.match(r.message, /不编一个 URL/)
  // 而且 reasons 里必须说清**发布与监听的方向**：有发布必有监听器，
  // 但"没有发布"不等于"没有监听器"——一台没拿到 dataDir 的在听监听器也是这样。
  assert.ok(r.reasons.some((s) => s.includes('listen()')), 'reasons 没说发布与监听的先后')
  assert.ok(r.reasons.some((s) => s.includes('NO_PUBLICATION_DIR')), 'reasons 没给出那条"在听但发布不出来"的具名码')
})

test('③ 读不了（EACCES）与"不在"（ENOENT）**是两个码**——修法不同', () => {
  const denied = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ throwCode: 'EACCES' }) })
  assert.equal(denied.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE)
  const absent = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ throwCode: 'ENOENT' }) })
  assert.equal(absent.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT)
  assert.notEqual(denied.code, absent.code)
})

test('③ 内容不是 JSON → `PUBLICATION_UNREADABLE`（"写坏了"与"没写过"分开）', () => {
  const r = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: '{ 半截' }) })
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE)
  // 半截 JSON 与空文件是同一类：都读不成对象
  const empty = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: '' }) })
  assert.equal(empty.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_UNREADABLE)
})

test('③ ★ 内容非法：六种各自被点名（不是笼统一个"坏掉了"）', () => {
  const cases = [
    ['version', record({ version: 99 }), /version/],
    ['pid', record({ pid: 0 }), /pid/],
    ['host', record({ host: '0.0.0.0' }), /host/],
    ['port0', record({ port: 0 }), /port/],
    ['portHigh', record({ port: 70000 }), /port/],
    ['wire', record({ wireVersion: 2 }), /wireVersion/],
    ['array', [record()], /顶层/],
    ['null', null, /顶层/],
  ]
  for (const [tag, value, re] of cases) {
    const r = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: JSON.stringify(value) }) })
    assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_INVALID, `${tag} 判成了别的码`)
    assert.match(r.message, re, `${tag} 的报错没有点出是哪个字段`)
    assert.equal('url' in r, false, `${tag}：非法内容却给出了 url`)
    assert.ok(Array.isArray(r.problems) && r.problems.length > 0, `${tag}：没有列出问题`)
  }
  // ★ 反向：非回环 host 与"port 是 0"都必须**被拒绝**，不许当成可用端点。
  //   0.0.0.0 会被读成一个"能连上所有网卡"的地址——那是一次静默的暴露面扩张。
  const ok = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: JSON.stringify(record()) }) })
  assert.equal(ok.ok, true, `${ok.code} ${ok.message}`)
})

test('③ pid 对不上 → `PUBLICATION_STALE`（**不是** INVALID：文件是好的，是身份不对）', () => {
  const r = readRuntimeContractEndpoint({
    dataDir: DATA_DIR, expectedPid: SELF_PID + 7, fs: readFs({ text: JSON.stringify(record()) }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE)
  assert.equal(r.publishedPid, SELF_PID)
  assert.equal(r.expectedPid, SELF_PID + 7)
  assert.equal('url' in r, false)
  assert.notEqual(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_INVALID)
})

test('③ 没有 DataDir → `PATH_UNAVAILABLE`（且**一个字节都不读**）', () => {
  for (const dataDir of [null, undefined, '', '   ']) {
    const fs = readFs({ text: JSON.stringify(record()) })
    const r = readRuntimeContractEndpoint({ dataDir, expectedPid: SELF_PID, fs })
    assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_PATH_UNAVAILABLE, `dataDir=${String(dataDir)}`)
    assert.equal(fs.calls.length, 0, '连路径都不知道就已经去读盘了')
    assert.equal(runtimeContractEndpointPath(dataDir), null)
  }
})

test('③ 成功：url 逐字是 `http://<host>:<port>`；IPv6 回环要加方括号', () => {
  const v4 = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: JSON.stringify(record({ port: 51999 })) }) })
  assert.equal(v4.url, 'http://127.0.0.1:51999')
  const v6 = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: JSON.stringify(record({ host: '::1', port: 52000 })) }) })
  assert.equal(v6.url, 'http://[::1]:52000', 'IPv6 字面量没有加方括号——那个 URL 不成立')
  const local = readRuntimeContractEndpoint({ dataDir: DATA_DIR, expectedPid: SELF_PID, fs: readFs({ text: JSON.stringify(record({ host: 'localhost' })) }) })
  assert.equal(local.url, 'http://localhost:51814')
})

test('③ 可重试集合**恰好**是那四条（多一条会让"永久坏了"被反复重试，少一条会让正常启动被报成缺发布）', () => {
  const C = RUNTIME_CONTRACT_ENDPOINT_CODES
  assert.deepEqual([...RUNTIME_CONTRACT_RETRYABLE_CODES].sort(), [
    C.PUBLICATION_ABSENT, C.PUBLICATION_INVALID, C.PUBLICATION_STALE, C.PUBLICATION_UNREADABLE,
  ].sort())
  // 反向：这两条**不该**在集合里（等下去它们不会变好）
  assert.equal(RUNTIME_CONTRACT_RETRYABLE_CODES.includes(C.PUBLICATION_PATH_UNAVAILABLE), false)
  assert.equal(RUNTIME_CONTRACT_RETRYABLE_CODES.includes(C.TOKEN_GENERATION_FAILED), false)
  // 诊断转换带上 process，且只用于拒绝
  const d = runtimeContractDiagnostic({ ok: false, code: C.PUBLICATION_ABSENT, message: 'x', reasons: ['y'] })
  assert.equal(d.severity, 'error')
  assert.equal(d.process, 'orchestrator')
  assert.equal(d.code, C.PUBLICATION_ABSENT)
  // ★ 严重级可以由调用点给：`--include` 不含 runtime 的那条刻意受限启动里，
  //   根因已经由 `PROCESS_EXCLUDED_BY_SCOPE`（warn）说过一次，
  //   而这条诊断**不经过**那段作用域降级（它跑在启动计划那一步）。
  //   一个不阻塞启动的 error 只会训练人忽略 error。
  const w = runtimeContractDiagnostic({ ok: false, code: C.PUBLICATION_ABSENT, message: 'x' }, { severity: 'warn' })
  assert.equal(w.severity, 'warn')
  assert.equal(w.code, C.PUBLICATION_ABSENT, '降的是严重级，不是码——码要说的是"没人发布"这件事实')
  assert.equal(w.process, 'orchestrator', 'process 只影响"人去哪里找"，不参与作用域降级')
})

test('③ 接口版本常量在（改签名/码集时它要动，用例把它钉在这里）', () => {
  assert.equal(RUNTIME_CONTRACT_ENDPOINT_VERSION, 1)
})

// ═══════════════════════════════════════════ 等待（Loader 并发建行）

test('④ ★ 等：先"不在"、后出现 → 最终成功，且**两次读数是不同的**', async () => {
  let reads = 0
  const fs = {
    readFileSync() {
      reads += 1
      if (reads < 3) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return JSON.stringify(record())
    },
    rmSync() {},
  }
  const r = await waitForRuntimeContractEndpoint({
    dataDir: DATA_DIR, expectedPid: SELF_PID, fs, timeoutMs: 5_000, intervalMs: 1,
  })
  assert.equal(r.ok, true, `${r.code} ${r.message}`)
  assert.equal(r.url, 'http://127.0.0.1:51814')
  // ★ "读数不同"：第一次读到的必须是 ABSENT（不是"没有读数"），成功后是 ok。
  //   一条"它最终成功了"的断言不说明等待发生过——把等待删掉它照样绿，
  //   只不过 attempts 会是 1。所以这里断言 attempts 严格大于 1。
  assert.ok(r.attempts >= 3, `没有真的重试（attempts=${r.attempts}）`)
  assert.equal(reads, r.attempts)
})

test('④ 一直不在 → 超时后报的是**最后一次的那个码**（`ABSENT`），不是合成的 TIMEOUT', async () => {
  const fs = { readFileSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, rmSync() {} }
  const r = await waitForRuntimeContractEndpoint({
    dataDir: DATA_DIR, expectedPid: SELF_PID, fs, timeoutMs: 20, intervalMs: 5,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT,
    '合成一个新的"超时"码会把"从来没发布过"与"一直是旧进程那一份"压成同一个读数')
  assert.ok(r.attempts > 1, `没有重试（attempts=${r.attempts}）`)
  assert.match(r.message, /仍未出现/)
  assert.equal('url' in r, false)
})

test('④ 一直是旧进程那一份 → 超时后报 `STALE`（与"没人发布"必须分得开）', async () => {
  const fs = { readFileSync: () => JSON.stringify(record({ pid: SELF_PID + 1 })), rmSync() {} }
  const r = await waitForRuntimeContractEndpoint({
    dataDir: DATA_DIR, expectedPid: SELF_PID, fs, timeoutMs: 20, intervalMs: 5,
  })
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE)
  const absentFs = { readFileSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, rmSync() {} }
  const absent = await waitForRuntimeContractEndpoint({
    dataDir: DATA_DIR, expectedPid: SELF_PID, fs: absentFs, timeoutMs: 20, intervalMs: 5,
  })
  assert.notEqual(r.code, absent.code, '两种处境读出了同一个码')
})

test('④ 不可重试的码**立刻**返回（不为一个等不来的东西耗满超时）', async () => {
  let reads = 0
  const fs = {
    readFileSync() { reads += 1; return JSON.stringify(record()) },
    rmSync() {},
  }
  const r = await waitForRuntimeContractEndpoint({
    dataDir: null, expectedPid: SELF_PID, fs, timeoutMs: 10_000, intervalMs: 5,
  })
  assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_PATH_UNAVAILABLE)
  assert.equal(reads, 0, '没有 DataDir 却还是去读了盘')
  assert.equal(r.attempts, 1)
})

test('④ 真的等到了真盘上的一份发布（写侧写、读侧等）', async () => {
  const w = await import(`file:///${WRITER.replace(/\\/g, '/')}`)
  const root = mkdtempSync(join(tmpdir(), 'legion-rcwait-'))
  try {
    const dataDir = join(root, 'data')
    // 先起一个"发布马上就到"的定时器，再开始等——模拟 Loader 并发建行。
    const timer = setTimeout(() => {
      w.publishRuntimeContractEndpoint({ dataDir, host: '127.0.0.1', port: 52111, pid: SELF_PID })
    }, 30)
    try {
      const r = await waitForRuntimeContractEndpoint({ dataDir, expectedPid: SELF_PID, timeoutMs: 5_000, intervalMs: 5 })
      assert.equal(r.ok, true, `${r.code} ${r.message}`)
      assert.equal(r.url, 'http://127.0.0.1:52111')
      assert.ok(r.attempts > 1, `没有等到就成功了（attempts=${r.attempts}）——那说明等待没被测到`)
    } finally { clearTimeout(timer) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════ 真盘上的一份"坏发布"

test('⑤ 真盘上的陈旧发布（上一次运行留下的）→ `STALE`，并且**不**被当成可用的端点', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-rcstale-'))
  try {
    const dataDir = join(root, 'data')
    const path = join(dataDir, ...RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS)
    mkdirSync(join(dataDir, 'runtime'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ version: 1, pid: 999_999, host: '127.0.0.1', port: 51234, wireVersion: 1 })}\n`)
    const r = readRuntimeContractEndpoint({ dataDir, expectedPid: SELF_PID })
    assert.equal(r.code, RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_STALE)
    assert.equal(r.publishedPid, 999_999)
    assert.equal('url' in r, false)
    // 反向：万一它是**本次**那个 pid，才允许被采用——证明上面那条不是"永远拒绝"
    const same = readRuntimeContractEndpoint({ dataDir, expectedPid: 999_999 })
    assert.equal(same.ok, true, `${same.code} ${same.message}`)
    assert.equal(same.port, 51234)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
