// product/update/transport.test.mjs
// ============================================================================
// 取件层的**网络行为**判据 —— 设计 §5 line 124、§6 line 134/140
//
// ★★ 这个文件此前**不存在**，而 `transport.mjs` 的自检里写着：
//
//   > 自检只覆盖**纯函数**部分：网络行为的证据在 `transport.test.mjs` 里，
//   > 用真实的 fetch 替身驱动。
//
//   那句话指向的是一个**从来没有被写出来的文件**。而 `transport.mjs` 正是
//   三条设计要求的落点：
//
//     · §5 line 124「禁止绝对地址、父目录穿越、编码绕过和**跨 origin 重定向**」
//     · §6 line 134「请求空闲超时 60 秒，清单整体超时 30 秒，清单上限 256 KiB」
//     · §6 line 140「下载写入 `.part`，**流式限制大小**并计算摘要」
//
//   自检能做的只有"三个常量等于设计里的数字"——它证明不了那三个数字
//   **被强制执行**。常量对不对，与"超时真的会中止请求"是两件事：
//
//   > 一个把 60 秒写进常量、而在流上从不看它的实现，
//   > 与一个超时是 0 秒的实现，在"用户会不会永远卡在正在检查"上
//   > 是同一个东西。
//
//   所以本文件用**注入的 fetch 替身**逐条驱动这些行为。替身要能表达四件事：
//   重定向、声明长度、**边收边停**（stall）与外部中止。
// ============================================================================

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import {
  IDLE_TIMEOUT_MS, MANIFEST_TIMEOUT_MS, MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES,
  TRANSPORT_CODES, commitDownload, createTransport, discardDownload,
} from './transport.mjs'
import { createHostConfig } from './host.mjs'

const ORIGIN = 'https://updates.example.com'
const PREFIX = '/legion'
const OTHER = 'https://evil.example.net'

function host() {
  const created = createHostConfig({ origin: ORIGIN, prefix: PREFIX, channel: 'stable' })
  assert.equal(created.ok, true, created.reason)
  return created.host
}

const HEADERS = (extra = {}) => Object.freeze({ ...extra })

/** 一个响应替身：`body` 可以是数组（分块）、`null`（走 arrayBuffer 分支）或一个异步生成器。 */
function response(status, headers, body) {
  return {
    status,
    headers,
    body,
    async arrayBuffer() {
      if (body === null || body === undefined) return Buffer.alloc(0)
      const chunks = []
      for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return Buffer.concat(chunks)
    },
  }
}

/** 从一组 chunk 造一个异步可迭代的 body（`for await` 能读）。 */
function bodyOf(chunks) {
  return Readable.from(chunks)
}

/**
 * 一个永不产出字节、也不结束的 body（用来驱动超时）。
 *
 * ★ 它**必须响应 `options.signal`**：真实 `fetch` 在 signal 触发时会以
 *   `AbortError` 结束 body 的迭代。一个忽略它的替身会让超时用例**永远挂着**
 *   （第一版就是这样，跑了五分钟没结束）——而那是替身的缺陷，不是实现的：
 *   超时确实触发了，只是没人听。
 *
 *   > 一个不响应取消的替身，会让"超时生效了"与"超时根本没接上"
 *   > 在读数上完全一样：两者都是**一直没有返回**。
 */
function stalledBody(signal = null) {
  const abortError = () => {
    const error = new Error('aborted by fake fetch')
    error.name = 'AbortError'
    return error
  }
  async function* generator() {
    await new Promise((_resolve, rejectPromise) => {
      if (signal === null) return                       // 永不结束（用例不该这么用）
      if (signal.aborted) { rejectPromise(abortError()); return }
      signal.addEventListener('abort', () => rejectPromise(abortError()), { once: true })
    })
    yield Buffer.from('never')
  }
  return generator()
}

/**
 * 一个按 URL 分发的 fetch 替身。
 *
 * `routes` 是 `路径 → () => response`（或直接一个 response）。函数形式让
 * 每条用例能造出"每次请求都不一样"的响应（例如重定向链）。
 * `calls` 记录真实发出的请求，用来断言"被拒之后没有继续请求"。
 */
function makeFetch(routes) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url, options })
    const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : new URL(url).pathname
    const route = routes[path] ?? routes[url] ?? routes['*']
    if (route === undefined) throw new Error(`替身没有为 ${url} 配路由`)
    return typeof route === 'function' ? route(url, options, calls.length) : route
  }
  impl.calls = calls
  return impl
}

function cacheDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-transport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// ① 设计 §6 line 134 的三个数字：常量对，而且**真的生效**
// ---------------------------------------------------------------------------

test('① 三个超时/上限常量等于设计里的数字（§6 line 134）', () => {
  assert.equal(IDLE_TIMEOUT_MS, 60_000, '空闲超时不是 60 秒')
  assert.equal(MANIFEST_TIMEOUT_MS, 30_000, '清单整体超时不是 30 秒')
  assert.equal(MAX_MANIFEST_BYTES, 256 * 1024, '清单上限不是 256 KiB')
  assert.equal(MAX_ARTIFACT_BYTES, 4 * 1024 * 1024 * 1024, '发布文件上限变了')
})

test('① ★★ 空闲超时**真的会中止**请求（常量对 ≠ 生效）', async () => {
  // ★ 这条是"常量对"与"行为对"分开的证据。替身永不产出字节，
  //   于是只有空闲计时器能结束这次请求。
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/feeds/stable/win-x64.json': (url, options) => response(200, HEADERS(), stalledBody(options.signal)) }),
    idleTimeoutMs: 30,                      // 用例里缩短，判据不变
    manifestTimeoutMs: null,                // 只留空闲计时器，避免两条超时混淆
  })
  const started = Date.now()
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/feeds/stable/win-x64.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.IDLE_TIMEOUT, `不是空闲超时：${JSON.stringify(result)}`)
  assert.ok(Date.now() - started < 5_000, '空闲超时没有在用例时限内生效')
})

test('① ★★ 清单整体超时**真的会中止**请求（与空闲超时是两条码）', async () => {
  // ★ 两条超时必须**可区分**：整体超时说的是"这个文件取太久了"，
  //   空闲超时说的是"对方不说话了"。处置不同（前者可以重试，
  //   后者更像链路问题），所以码不同——而"不同"要有证据。
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/feeds/stable/win-x64.json': (url, options) => response(200, HEADERS(), stalledBody(options.signal)) }),
    idleTimeoutMs: null,
    manifestTimeoutMs: 30,
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/feeds/stable/win-x64.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TIMEOUT, `不是整体超时：${JSON.stringify(result)}`)
  assert.notEqual(TRANSPORT_CODES.TIMEOUT, TRANSPORT_CODES.IDLE_TIMEOUT)
})

test('① ★★ 外部取消给出 `CANCELLED`，与两种超时都不同', async () => {
  // ★ 设计 §6 line 134 的退避只对失败生效。把"用户点了取消"混进超时里，
  //   会让客户端在用户取消之后十五分钟又自己开始下。
  const controller = new AbortController()
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/feeds/stable/win-x64.json': (url, options) => response(200, HEADERS(), stalledBody(options.signal)) }),
    idleTimeoutMs: null,
    manifestTimeoutMs: null,
  })
  setTimeout(() => controller.abort(), 20)
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/feeds/stable/win-x64.json`,
    { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.CANCELLED, `不是取消：${JSON.stringify(result)}`)
})

// ---------------------------------------------------------------------------
// ② 大小上限：声明值在**读之前**判，实际值在**读的过程中**判
// ---------------------------------------------------------------------------

test('② ★★★ 声明的 Content-Length 超上限 ⇒ 在读 body **之前**就拒', async () => {
  // ★ "在读完之前生效"是设计 §6 的原话（`transport.mjs` 的头部注释也是这么写的）。
  //   一个先读完再判长度的实现，在"对方声明 10 GB"时就先把 10 GB 拉下来了。
  //   所以这里不仅断言码，还断言**body 一次都没被拉过**。
  let pulled = 0
  const body = {
    [Symbol.asyncIterator]() {
      pulled += 1
      return (async function* () { yield Buffer.alloc(1024) })()
    },
  }
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/x.json': () => response(200, HEADERS({ 'content-length': '999999' }), body) }),
    maxManifestBytes: 1024,
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_LARGE, JSON.stringify(result))
  assert.equal(pulled, 0, '声明已经超上限，却仍然开始拉 body 了')
  assert.match(result.reason, /超过上限/)
})

test('② ★★★ 声明值不超、实际流超上限 ⇒ 边收边停（不是先收完再判）', async () => {
  // ★ 这条是"流式限制大小"的本体：对方**撒谎**（声明 10 字节、实际一直发）。
  //   一个只在结束时判总长的实现会把内存吃满。
  const chunks = Array.from({ length: 50 }, () => Buffer.alloc(100))   // 5000 字节
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/x.json': () => response(200, HEADERS({ 'content-length': '10' }), bodyOf(chunks)),
    }),
    maxManifestBytes: 1000,
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_LARGE, JSON.stringify(result))
  // ★ 它必须停在中途：收到的字节数应当**刚过**上限，而不是全部 5000。
  assert.ok(result.bytes > 1000 && result.bytes < 5000,
    `没有在中途停下（bytes=${result.bytes}）——那是"先收完再判"`)
  assert.match(result.reason, /中止/)
})

test('② ★★ 没有 body 的响应走 arrayBuffer 分支，同样受上限约束', async () => {
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/x.json': () => response(200, HEADERS(), bodyOf([Buffer.alloc(4096)])),
    }),
    maxManifestBytes: 1024,
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_LARGE)
})

test('② ★ 合法响应：字节、状态、头部都如实返回', async () => {
  const payload = Buffer.from('{"ok":true}')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/feeds/stable/win-x64.json': () => response(200,
        HEADERS({ 'cache-control': 'no-store', 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/feeds/stable/win-x64.json`)
  assert.equal(result.ok, true, result.reason)
  assert.deepEqual(result.body, payload)
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('② ★★ 分块传输（没有 Content-Length）不能被读成"声明了 0 字节"', async () => {
  // ★ `declaredLengthOf` 的注释记着这个坑：`Number(null) === 0`，
  //   于是一次**没有** Content-Length 的正常响应会被判成"声明 0 字节"。
  const payload = Buffer.from('chunked-body')
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/x.json': () => response(200, HEADERS(), bodyOf([payload])) }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, true, `分块响应被误判：${result.reason}`)
  assert.deepEqual(result.body, payload)
})

// ---------------------------------------------------------------------------
// ③ 重定向：跨 origin 一律拒（设计 §5 line 124）
// ---------------------------------------------------------------------------

test('③ ★★★ 跨 origin 重定向被拒（设计 §5 line 124）', async () => {
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/x.json': () => response(302, HEADERS({ location: `${OTHER}/legion/x.json` }), null),
    }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.REDIRECT, JSON.stringify(result))
  assert.match(result.reason, /跨|origin|重定向/)
})

test('③ ★★ 同 origin 的路径重定向可以跟随', async () => {
  const payload = Buffer.from('after-redirect')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/x.json': () => response(302, HEADERS({ location: `${PREFIX}/moved.json` }), null),
      '/legion/moved.json': () => response(200, HEADERS(), bodyOf([payload])),
    }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, true, `同 origin 重定向被拒了：${result.reason}`)
  assert.deepEqual(result.body, payload)
})

test('③ ★★ 重定向次数超上限被拒（不能无限跟）', async () => {
  // 每一跳都指向自己 ⇒ 永远 302。判据是"跳数有上限"，不是"能跟到尽头"。
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/loop.json': (url) => response(302, HEADERS({ location: `${PREFIX}/loop.json` }), null),
    }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/loop.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.REDIRECT)
  assert.match(result.reason, /次数/)
})

test('③ ★★★ 取件地址不在 origin 之内 ⇒ 根本不发请求', async () => {
  // ★ 这是**第一道**判据（在 fetch 之前）。一个"先发请求再看结果"的实现在
  //   这里会把请求发到一个不受信任的地址上——那已经晚了。
  const fetchImpl = makeFetch({ '/legion/x.json': () => response(200, HEADERS(), null) })
  const transport = createTransport({ fetchImpl })
  const result = await transport.fetchBytes(host(), `${OTHER}/legion/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.REDIRECT)
  assert.equal(fetchImpl.calls.length, 0, '越界的地址仍然发出了请求')
})

test('③ ★★ 非 200（且没配 relativePath 策略）报 HTTP_STATUS', async () => {
  const transport = createTransport({
    fetchImpl: makeFetch({ '/legion/x.json': () => response(404, HEADERS(), null) }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.HTTP_STATUS)
  assert.equal(result.status, 404)
})

test('③ ★★★ 给了 relativePath 时缓存策略由 host.mjs 判（不是只判 200）', async () => {
  // ★ 设计 §4 line 79：通道清单必须 `no-store`。这里证明 transport 把
  //   **路径与头部**一起交给了 `evaluateResponse`，而不是自己只看状态码。
  const payload = Buffer.from('{}')
  const transport = createTransport({
    fetchImpl: makeFetch({
      // 200 但缓存头不对 ⇒ 必须拒。
      '/legion/feeds/stable/win-x64.json': () => response(200,
        HEADERS({ 'cache-control': 'public, max-age=300', 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/feeds/stable/win-x64.json`,
    { relativePath: 'feeds/stable/win-x64.json' })
  assert.equal(result.ok, false, '缓存策略不对却被接受了')
  assert.equal(result.code, TRANSPORT_CODES.HTTP_STATUS)
  assert.match(result.reason, /no-store|缓存/)
})

// ---------------------------------------------------------------------------
// ④ 下载到文件：流式限长、摘要、以及"**不改名**"
// ---------------------------------------------------------------------------

test('④ ★★★ 下载成功时**不**改名：就绪文件必须由验签之后的 `commitDownload` 产生', async (t) => {
  // ★ 设计 §6 line 140 的原话是「下载完成**及签名检查通过后**原子改名」。
  //   把改名放在下载里会让"字节完整"冒充"已验证"——而重启后的
  //   "复用有效缓存"路径会把它当成好的。
  const dir = cacheDirFor(t)
  const target = join(dir, 'legion-win-x64.zip')
  const payload = Buffer.from('PK\u0003\u0004 pretend zip')
  const sha256 = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(200, HEADERS({ 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: payload.length, expectedSha256: sha256,
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.partPath, `${target}.part`)
  assert.equal(existsSync(result.partPath), true, '没有留下 .part 文件')
  assert.equal(existsSync(target), false,
    '下载就把目标文件改名出来了 —— 那"字节完整"会冒充"已验证"')
  // 验签之后才提交。
  const committed = commitDownload(result.partPath, target)
  assert.equal(committed.ok, true, committed.reason)
  assert.equal(existsSync(target), true)
  assert.equal(existsSync(result.partPath), false)
})

test('④ ★★★ 流超上限 ⇒ TOO_LARGE + 不留 `.part` + **真的把请求掐掉**', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const chunks = Array.from({ length: 20 }, () => Buffer.alloc(100))   // 2000 字节
  let pulled = 0
  const counted = async function* () {
    for (const chunk of chunks) { pulled += 1; yield chunk }
  }
  const fetchImpl = makeFetch({ '/legion/pkg.zip': () => response(200, HEADERS(), counted()) })
  const transport = createTransport({ fetchImpl })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: 500, expectedSha256: 'a'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_LARGE, JSON.stringify(result))
  assert.equal(existsSync(`${target}.part`), false, '失败之后留下了半个包')

  // ★★★ 而它必须**真的把请求掐掉**——这是"流式限制大小"那句话的另一半。
  //
  //   `transport.mjs` 在那一步的注释是：「超限即中止请求：继续收下去等于让对方
  //   决定我们要写多少磁盘。」
  //
  //   ★ 这条断言是**变异测试逼出来的**：第一版只断言了码与清理，于是把调用点
  //   改回 `() => deadline.signal`（那个坏掉的写法）时**用例照样全绿**——
  //   因为 `TransformLimit` 已改成只调用一次回调，拿到信号对象丢掉也不会抛错，
  //   `NET_TOO_LARGE` 仍然照常发出。**唯一失去的是"中止"这个动作。**
  //
  //   > 一条只断言"结果对不对"的用例，看不见"副作用有没有发生"——
  //   > 而这次那个副作用（掐掉请求）正是设计原话要的东西。
  const signal = fetchImpl.calls.at(-1)?.options?.signal
  assert.ok(signal !== undefined && signal !== null, '替身没有拿到 signal')
  assert.equal(signal.aborted, true,
    '限长触发之后请求信号没有被中止 —— 对方可以继续把字节推过来')
  // 而且源流必须**停在中途**（不是把 20 块全拉完再判）。
  assert.ok(pulled < chunks.length,
    `源流被拉完了（${pulled}/${chunks.length}）—— 说明没有在超限时停下`)
})

test('④ ★★ 收得比清单少 ⇒ TOO_SMALL（"少"与"大"是两条码）', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(200, HEADERS(), bodyOf([Buffer.from('short')])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: 500, expectedSha256: 'a'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_SMALL, JSON.stringify(result))
  assert.equal(existsSync(`${target}.part`), false)
})

test('④ ★★ 字节数对、摘要不对 ⇒ DIGEST_MISMATCH，且不留 `.part`', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const payload = Buffer.from('0123456789')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(200, HEADERS({ 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: payload.length, expectedSha256: 'b'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.DIGEST_MISMATCH, JSON.stringify(result))
  assert.equal(existsSync(`${target}.part`), false)
})

test('④ ★★ 声明的 Content-Length 与清单不符 ⇒ 在读之前就拒', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(200, HEADERS({ 'content-length': '999' }), bodyOf([Buffer.from('x')])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: 10, expectedSha256: 'a'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.TOO_LARGE)
  assert.match(result.reason, /不一致/)
})

test('④ ★★ 下载**不跟随重定向**（与取件那条不同，且理由要说明）', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(302, HEADERS({ location: `${PREFIX}/elsewhere.zip` }), null),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: 10, expectedSha256: 'a'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.REDIRECT)
  assert.match(result.reason, /不跟随重定向/)
})

test('④ ★★ 参数不合法时给具名拒绝，而不是开始下载', async (t) => {
  const dir = cacheDirFor(t)
  const fetchImpl = makeFetch({ '*': () => response(200, HEADERS(), null) })
  const transport = createTransport({ fetchImpl })
  const bad = [
    [{ targetPath: '' }, TRANSPORT_CODES.WRITE_FAILED, '空 targetPath'],
    [{ targetPath: join(dir, 'a'), expectedSize: 0, expectedSha256: 'a'.repeat(64) }, TRANSPORT_CODES.TOO_SMALL, 'expectedSize=0'],
    [{ targetPath: join(dir, 'b'), expectedSize: 10, expectedSha256: 'not-hex' }, TRANSPORT_CODES.DIGEST_MISMATCH, '伪摘要'],
    [{ targetPath: join(dir, 'c'), expectedSize: MAX_ARTIFACT_BYTES + 1, expectedSha256: 'a'.repeat(64) }, TRANSPORT_CODES.TOO_LARGE, '超上限'],
  ]
  for (const [args, code, label] of bad) {
    const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, args)
    assert.equal(result.ok, false, `${label}：被接受了`)
    assert.equal(result.code, code, `${label}：码是 ${result.code}`)
  }
  assert.equal(fetchImpl.calls.length, 0, '参数不合法却发出了请求')
})

test('④ ★★ 越界地址的下载根本不发请求', async (t) => {
  const dir = cacheDirFor(t)
  const fetchImpl = makeFetch({ '*': () => response(200, HEADERS(), null) })
  const transport = createTransport({ fetchImpl })
  const result = await transport.downloadToFile(host(), `${OTHER}${PREFIX}/pkg.zip`, {
    targetPath: join(dir, 'pkg.zip'), expectedSize: 10, expectedSha256: 'a'.repeat(64),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.REDIRECT)
  assert.equal(fetchImpl.calls.length, 0)
})

test('④ ★★ 进度按真实字节回报，而且**小文件也有**一次回报', async (t) => {
  // ★ `transport.mjs` 的注释记着这个缺陷：节流阈值 64 KiB，而一个 24 字节的包
  //   永远跨不过它 ⇒ 一次成功的下载在界面上完全没有进度回报。
  //   用户看到的是"点了下载，然后什么都没有"。
  const dir = cacheDirFor(t)
  const target = join(dir, 'tiny.zip')
  const payload = Buffer.from('PK\u0003\u0004 tiny')
  const sha256 = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex')
  const seen = []
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/tiny.zip': () => response(200, HEADERS({ 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/tiny.zip`, {
    targetPath: target, expectedSize: payload.length, expectedSha256: sha256,
    onProgress: (bytes, total) => seen.push([bytes, total]),
  })
  assert.equal(result.ok, true, result.reason)
  assert.ok(seen.length >= 1, '小文件下载没有任何进度回报')
  assert.deepEqual(seen.at(-1), [payload.length, payload.length])
  assert.equal(readFileSync(result.partPath).length, payload.length)
})

// ---------------------------------------------------------------------------
// ⑤ 丢弃：取消/失败/重启清理走同一个函数
// ---------------------------------------------------------------------------

test('⑤ `discardDownload` 幂等：文件在不在都不抛', async (t) => {
  const dir = cacheDirFor(t)
  const path = join(dir, 'x.part')
  assert.equal(discardDownload(path), true, '删一个不存在的文件应当算成功（幂等）')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, 'half')
  assert.equal(discardDownload(path), true)
  assert.equal(existsSync(path), false)
})

test('⑤ `commitDownload` 在源文件不存在时给具名失败，而不是抛', () => {
  const result = commitDownload('/definitely/not/here.part', '/tmp/legion-nope.zip')
  assert.equal(result.ok, false)
  assert.equal(result.code, TRANSPORT_CODES.WRITE_FAILED)
  assert.match(result.reason, /改名失败/)
})

test('⑤ `commitDownload` / `discardDownload` 传错类型时的行为是明确定义的', () => {
  assert.equal(commitDownload(null, 'x').ok, false)
  assert.equal(commitDownload('x', null).ok, false)
  // 丢弃给个不合法输入也不该抛（它会在 catch 路径上被调用）。
  assert.equal(typeof discardDownload(null), 'boolean')
})

test('⑤ 大小上限是**真**上限：一个刚好等于上限的响应被接受', async (t) => {
  // ★ 边界：`>` 而不是 `>=`。写成 `>=` 会把"正好 256 KiB 的清单"判成超大，
  //   而那是合法的一份清单。
  const payload = Buffer.alloc(1024, 0x41)
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/x.json': () => response(200, HEADERS({ 'content-length': String(payload.length) }), bodyOf([payload])),
    }),
    maxManifestBytes: 1024,
  })
  const result = await transport.fetchBytes(host(), `${ORIGIN}${PREFIX}/x.json`)
  assert.equal(result.ok, true, `正好等于上限的响应被拒了：${result.reason}`)
  assert.equal(result.bytes, 1024)
})

test('⑤ 落盘的文件大小与收到的字节一致（不是"报告了一个数、写了另一个数"）', async (t) => {
  const dir = cacheDirFor(t)
  const target = join(dir, 'pkg.zip')
  const payload = Buffer.alloc(5000, 0x42)
  const sha256 = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex')
  const transport = createTransport({
    fetchImpl: makeFetch({
      '/legion/pkg.zip': () => response(200, HEADERS({ 'content-length': String(payload.length) }),
        bodyOf([payload.subarray(0, 2000), payload.subarray(2000)])),
    }),
  })
  const result = await transport.downloadToFile(host(), `${ORIGIN}${PREFIX}/pkg.zip`, {
    targetPath: target, expectedSize: payload.length, expectedSha256: sha256,
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.bytes, payload.length)
  assert.equal(statSync(result.partPath).size, payload.length, '报告的大小与实际落盘不一致')
})
