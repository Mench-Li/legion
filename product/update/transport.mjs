// product/update/transport.mjs
// ============================================================================
// 取件 —— 设计 §6 的超时、限长与"取消不影响当前程序"
//
// 这一层只做三件事，但三件都必须做对：
//
//   ① **超时是两段。** 设计 §6 line 134：「请求空闲超时 60 秒，清单整体
//      超时 30 秒」。
//      "空闲"与"整体"不是同一个限制：一个每 50 秒发一个字节的服务端能让
//      整体超时永远不触发，而一个慢但持续的大文件下载不该被 30 秒砍掉。
//      所以本模块给下载用**空闲**超时，给清单一类小文件用**整体**超时。
//
//   ② **限长要在读完之前生效。** 清单上限 256 KiB（设计 §6）。先
//      `await res.arrayBuffer()` 再检查长度是"让对方决定你分配多少内存"，
//      所以这里是边收边算，超了立刻 abort。
//
//   ③ **重定向自己处理。** `redirect: 'manual'` + 自己判定 Location，
//      否则 `fetch` 会替你跟随到别的 origin，而设计 §5 明确禁止跨 origin
//      重定向。用 `follow` 的实现永远看不到这件事。
//
// 另外：请求头主动禁缓存（设计 §4 line 79），失败一律返回**数据**而不是
// 抛异常——"检查更新失败"是一个正常结果，不是异常。
// ============================================================================

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { evaluateRedirect, evaluateResponse, lookupHeader, requestHeaders } from './host.mjs'

/** 设计 §6 line 134 的三个数字。 */
export const IDLE_TIMEOUT_MS = 60_000
export const MANIFEST_TIMEOUT_MS = 30_000
export const MAX_MANIFEST_BYTES = 256 * 1024

/** 单个发布文件的大小上限（防"清单说要下一个无限大的包"）。 */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024

export const TRANSPORT_CODES = Object.freeze({
  OFFLINE: 'net-offline',
  TIMEOUT: 'net-timeout',
  IDLE_TIMEOUT: 'net-idle-timeout',
  HTTP_STATUS: 'net-http-status',
  TOO_LARGE: 'net-too-large',
  TOO_SMALL: 'net-too-small',
  DIGEST_MISMATCH: 'net-digest-mismatch',
  CANCELLED: 'net-cancelled',
  REDIRECT: 'net-redirect',
  // ★ 这里原本还有一个 `BAD_HEADERS: 'net-bad-headers'`，已删除。
  //
  //   它**从来没有被任何分支返回过**——声明了却不发出的错误码，与一条不存在
  //   的判据是同一回事：读代码的人会以为"响应头有问题"这个情形被处理了。
  //
  //   实际情况是：头的唯一用途是读 `Content-Length`，而
  //   `declaredLengthOf()` 对"缺失"与"非法"给同一个答案 `null`（跳过
  //   声明值与实际值的比对），真正的上限由 `TransformLimit` 那条**流式**
  //   上限兜住，内容再由签名清单里的摘要兜住。所以这里没有缺一条判据，
  //   缺的是"这个码有意义"这件事——那就把码删掉。
  //
  //   处置与 `release.mjs` 的 `BAD_MIGRATION_PLAN` 相反（那一个改成了真的会
  //   发出），因为那一次**确实缺一条判据**，而这一次不缺。判断依据是同一个
  //   问题：**这个码背后该有一个检查吗？**
  WRITE_FAILED: 'net-write-failed',
})

function transportResult(ok, code, reason, extra = {}) {
  return Object.freeze({ ok, code: ok ? null : code, reason, ...extra })
}

/**
 * 把 `AbortSignal` 与空闲计时器合成一个信号。
 *
 * 每一次读到字节就重置空闲计时器；`overallMs` 给定时额外挂一个总时限。
 * 取消（用户点"取消下载"）走外部 signal，且必须与超时**区分开**：
 * 超时要退避重试，取消不能退避重试——否则用户点了取消，客户端自己
 * 十五分钟后又开始下。
 */
function createDeadline({ idleMs, overallMs = null, signal = null }) {
  const controller = new AbortController()
  let idleTimer = null
  let overallTimer = null
  let reason = null

  const clear = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
    if (overallTimer !== null) { clearTimeout(overallTimer); overallTimer = null }
  }
  const armIdle = () => {
    if (idleMs === null) return
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      reason = TRANSPORT_CODES.IDLE_TIMEOUT
      controller.abort()
    }, idleMs)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  if (overallMs !== null) {
    overallTimer = setTimeout(() => {
      reason = TRANSPORT_CODES.TIMEOUT
      controller.abort()
    }, overallMs)
    if (typeof overallTimer.unref === 'function') overallTimer.unref()
  }
  armIdle()

  const onExternalAbort = () => { reason = TRANSPORT_CODES.CANCELLED; controller.abort() }
  if (signal !== null) {
    if (signal.aborted) onExternalAbort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  return {
    signal: controller.signal,
    /** 每收到一块就调用：重新武装空闲计时。 */
    touch: armIdle,
    /**
     * ★ 主动中止这次取件（流式限长超出时用）。
     *
     *   `transformLimit` 超限时的注释是「继续收下去等于让对方决定我们要写多少
     *   磁盘」，所以要**真的把请求掐掉**。而原先调用点给的是 `() => deadline.signal`
     *   ——那是一个**信号对象**，不是"中止"这个动作：调用它得到的是
     *   `AbortSignal`，再对它加 `?.()` 就抛 `TypeError`。
     *
     *   后果不是"少停一次"：那条 TypeError **顶替**了设计好的
     *   `NET_TOO_LARGE`，于是上层把它归到 `net-offline`（"网络不可达"），
     *   而理由里泄露一句内部实现错误。见 `transport.test.mjs` 里那条
     *   "对方发得比清单说得多"的用例。
     */
    abort() { controller.abort() },
    stop() {
      clear()
      if (signal !== null) signal.removeEventListener('abort', onExternalAbort)
    },
    get reason() { return reason },
  }
}

function classifyError(error, deadline) {
  if (deadline.reason !== null) {
    if (deadline.reason === TRANSPORT_CODES.CANCELLED) return TRANSPORT_CODES.CANCELLED
    if (deadline.reason === TRANSPORT_CODES.TIMEOUT) return TRANSPORT_CODES.TIMEOUT
    return TRANSPORT_CODES.IDLE_TIMEOUT
  }
  if (error?.name === 'AbortError') return TRANSPORT_CODES.TIMEOUT
  const code = error?.cause?.code ?? error?.code ?? null
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET'
    || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return TRANSPORT_CODES.OFFLINE
  }
  return TRANSPORT_CODES.OFFLINE
}

/**
 * 建立取件器。
 *
 * @param {object} args
 * @param {Function} [args.fetchImpl]       注入点（测试用）
 * @param {number}   [args.idleTimeoutMs]
 * @param {number}   [args.manifestTimeoutMs]
 * @param {number}   [args.maxManifestBytes]
 * @param {Function} [args.now]
 */
export function createTransport({
  fetchImpl = globalThis.fetch,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  manifestTimeoutMs = MANIFEST_TIMEOUT_MS,
  maxManifestBytes = MAX_MANIFEST_BYTES,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createTransport 需要 fetch 实现')

  /**
   * 取一个小文件（清单）并返回字节。
   *
   * 返回字节而不是 JSON：解析必须走 `parseJsonStrict`（重复键判据在那里），
   * 而这一层不该知道 JSON 的事。
   */
  async function fetchBytes(host, url, {
    maxBytes = maxManifestBytes, signal = null, overallMs = manifestTimeoutMs, relativePath = null,
  } = {}) {
    const sameOrigin = url.startsWith(host.origin)
    if (!sameOrigin) {
      return transportResult(false, TRANSPORT_CODES.REDIRECT, `拒绝取件：${url} 不在 ${host.origin} 之内`)
    }
    const deadline = createDeadline({ idleMs: idleTimeoutMs, overallMs, signal })
    const startedAtMs = now()
    try {
      let current = url
      for (let hop = 0; hop <= 3; hop += 1) {
        const response = await fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          headers: requestHeaders(),
          signal: deadline.signal,
        })
        deadline.touch()
        if (response.status >= 300 && response.status < 400) {
          const verdict = evaluateRedirect(current, lookupHeader(response.headers, 'location'), host)
          if (!verdict.ok) {
            return transportResult(false, TRANSPORT_CODES.REDIRECT, verdict.reason, { status: response.status, elapsedMs: now() - startedAtMs })
          }
          current = verdict.url
          continue
        }
        // 缓存与状态码的判据在 host.mjs（可测、且与发布端自检共用）。
        if (relativePath !== null) {
          const policy = evaluateResponse(relativePath, {
            status: response.status,
            headers: Object.fromEntries(caseInsensitiveEntries(response.headers)),
          })
          if (!policy.ok) {
            return transportResult(false, TRANSPORT_CODES.HTTP_STATUS,
              policy.problems.map((p) => p.message).join('；'), { status: response.status, elapsedMs: now() - startedAtMs })
          }
        } else if (response.status !== 200) {
          return transportResult(false, TRANSPORT_CODES.HTTP_STATUS, `HTTP ${response.status}`, { status: response.status })
        }

        const declared = declaredLengthOf(response.headers)
        if (declared !== null && declared > maxBytes) {
          return transportResult(false, TRANSPORT_CODES.TOO_LARGE,
            `Content-Length ${declared} 超过上限 ${maxBytes}`, { status: response.status, bytes: declared })
        }

        const chunks = []
        let total = 0
        if (response.body === null || response.body === undefined) {
          const buffer = Buffer.from(await response.arrayBuffer())
          total = buffer.length
          if (total > maxBytes) {
            return transportResult(false, TRANSPORT_CODES.TOO_LARGE, `响应 ${total} 字节超过上限 ${maxBytes}`)
          }
          chunks.push(buffer)
        } else {
          for await (const chunk of response.body) {
            deadline.touch()
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += buffer.length
            if (total > maxBytes) {
              // ★ 边收边判：不放任对方决定我们要分配多少内存。
              deadline.stop()
              return transportResult(false, TRANSPORT_CODES.TOO_LARGE,
                `响应超过上限 ${maxBytes}（收到 ${total} 字节时中止）`, { status: response.status, bytes: total })
            }
            chunks.push(buffer)
          }
        }
        return transportResult(true, null, null, {
          status: response.status,
          bytes: total,
          body: Buffer.concat(chunks, total),
          headers: Object.fromEntries(caseInsensitiveEntries(response.headers)),
          elapsedMs: now() - startedAtMs,
        })
      }
      return transportResult(false, TRANSPORT_CODES.REDIRECT, '重定向次数超过上限')
    } catch (error) {
      const code = classifyError(error, deadline)
      const reason = code === TRANSPORT_CODES.CANCELLED ? '已取消'
        : code === TRANSPORT_CODES.TIMEOUT ? `超过总时限 ${overallMs ?? idleTimeoutMs} 毫秒`
          : code === TRANSPORT_CODES.IDLE_TIMEOUT ? `空闲超过 ${idleTimeoutMs} 毫秒`
            : `网络不可达：${error?.message ?? error}`
      return transportResult(false, code, reason, { elapsedMs: now() - startedAtMs })
    } finally {
      deadline.stop()
    }
  }

  /**
   * 下载一个发布文件到 `targetPath.part`，校验大小与摘要，再原子改名。
   *
   * 设计 §6 line 140：「下载写入 CacheDir 的 `.part` 文件，流式限制大小并
   * 计算摘要；下载完成及签名检查通过后原子改名。」
   */
  async function downloadToFile(host, url, {
    targetPath, expectedSize, expectedSha256, signal = null, onProgress = null, maxBytes = MAX_ARTIFACT_BYTES,
  } = {}) {
    if (typeof targetPath !== 'string' || targetPath === '') {
      return transportResult(false, TRANSPORT_CODES.WRITE_FAILED, 'downloadToFile 需要 targetPath')
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      return transportResult(false, TRANSPORT_CODES.TOO_SMALL, 'downloadToFile 需要正的 expectedSize')
    }
    if (expectedSize > maxBytes) {
      return transportResult(false, TRANSPORT_CODES.TOO_LARGE, `目标大小 ${expectedSize} 超过上限 ${maxBytes}`)
    }
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      return transportResult(false, TRANSPORT_CODES.DIGEST_MISMATCH, 'downloadToFile 需要 64 位十六进制 expectedSha256')
    }
    if (!url.startsWith(host.origin)) {
      return transportResult(false, TRANSPORT_CODES.REDIRECT, `拒绝下载：${url} 不在 ${host.origin} 之内`)
    }
    const partPath = `${targetPath}.part`
    mkdirSync(dirname(targetPath), { recursive: true })
    const deadline = createDeadline({ idleMs: idleTimeoutMs, overallMs: null, signal })
    let received = 0
    let lastReported = 0
    // 进度节流：每 64 KiB 或每 1% 报一次。不节流的话，一个 500 MB 的包会
    // 产生几万次 IPC 消息，而界面根本渲染不过来。
    const progressStep = Math.max(64 * 1024, Math.floor(expectedSize / 100))
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', cache: 'no-store', headers: requestHeaders(), signal: deadline.signal,
      })
      deadline.touch()
      if (response.status >= 300 && response.status < 400) {
        const verdict = evaluateRedirect(url, lookupHeader(response.headers, 'location'), host)
        return transportResult(false, TRANSPORT_CODES.REDIRECT,
          verdict.ok ? '下载遇到重定向：为保持"一次请求一个文件"的语义，下载不跟随重定向' : verdict.reason,
          { status: response.status })
      }
      if (response.status !== 200) {
        return transportResult(false, TRANSPORT_CODES.HTTP_STATUS, `HTTP ${response.status}`, { status: response.status })
      }
      const declared = declaredLengthOf(response.headers)
      if (declared !== null && declared !== expectedSize) {
        return transportResult(false, TRANSPORT_CODES.TOO_LARGE,
          `Content-Length ${declared} 与清单声明的 ${expectedSize} 不一致`, { status: response.status })
      }

      const source = Readable.from(response.body ?? Readable.from([]))
      source.on('data', (chunk) => {
        deadline.touch()
        received += chunk.length
        // 设计 §7 line 148：「下载页显示**真实字节进度**」。
        // 进度挂在**流过的字节**上，而不是"已写入磁盘的字节"——后者要等
        // flush，用户看到的数字会明显滞后于实际下载。
        //
        // ★ `|| received === expectedSize` 这一半是给**小文件**的。
        //   节流阈值是 64 KiB，而一个 24 字节的包永远跨不过它——于是一次
        //   成功的下载在界面上完全没有任何进度回报。用户看到的是"点了
        //   下载，然后什么都没有"，直到状态突然变成"已就绪"。
        if (typeof onProgress === 'function'
          && (received - lastReported >= progressStep || received === expectedSize)) {
          lastReported = received
          try { onProgress(received, expectedSize) } catch { /* 界面回调不该影响下载 */ }
        }
      })
      const limit = new TransformLimit(expectedSize, () => deadline.abort())
      const sink = createWriteStream(partPath, { flags: 'w' })
      try {
        await pipeline(source, limit, sink)
      } catch (error) {
        try { rmSync(partPath, { force: true }) } catch { /* 尽力清理 */ }
        if (error?.code === 'NET_TOO_LARGE') {
          return transportResult(false, TRANSPORT_CODES.TOO_LARGE,
            `下载字节超过清单声明的大小 ${expectedSize}`, { bytes: received })
        }
        throw error
      }

      if (received !== expectedSize) {
        try { rmSync(partPath, { force: true }) } catch { /* 尽力清理 */ }
        return transportResult(false, TRANSPORT_CODES.TOO_SMALL,
          `下载到 ${received} 字节，清单声明 ${expectedSize}`, { bytes: received })
      }
      const actual = await hashFileOnDisk(partPath)
      if (actual !== expectedSha256) {        // 摘要必须与**落盘的字节**对上，所以是对文件重算，而不是复用
        // "边收边算"的中间状态——真正被解压的是文件，不是内存里的副本。
        try { rmSync(partPath, { force: true }) } catch { /* 尽力清理 */ }
        return transportResult(false, TRANSPORT_CODES.DIGEST_MISMATCH,
          `内容摘要不符：清单 ${expectedSha256}，实际 ${actual}`, { bytes: received, actualSha256: actual })
      }
      // ★ 这里**不改名**。
      //
      //   设计 §6 line 140 的原话是「下载完成**及签名检查通过后**原子改名」。
      //   把改名放在本函数里会让"字节完整"冒充"已验证"：调用方只要忘了
      //   验签，缓存目录里就已经存在一个看起来就绪的文件，而重启后的
      //   "复用有效缓存"路径会把它当成好的。改名由调用方在验签之后
      //   显式调用 `commitDownload` 完成。
      return transportResult(true, null, null, {
        partPath, bytes: received, sha256: actual, elapsedMs: null,
      })
    } catch (error) {
      try { rmSync(partPath, { force: true }) } catch { /* 尽力清理 */ }
      const code = classifyError(error, deadline)
      return transportResult(false, code, code === TRANSPORT_CODES.CANCELLED ? '已取消' : `下载失败：${error?.message ?? error}`,
        { bytes: received })
    } finally {
      deadline.stop()
    }
  }

  return Object.freeze({ fetchBytes, downloadToFile, idleTimeoutMs, manifestTimeoutMs, maxManifestBytes })
}

/**
 * 验签**通过之后**才允许调用的原子改名。
 *
 * 单独一个函数而不是 downloadToFile 里的一个参数，是因为"改名"这一步
 * 在流程上属于"我已确认这个字节是可信的"，而不是"我写完了文件"。
 */
export function commitDownload(partPath, targetPath) {
  if (typeof partPath !== 'string' || typeof targetPath !== 'string') {
    return Object.freeze({ ok: false, code: TRANSPORT_CODES.WRITE_FAILED, reason: 'commitDownload 需要两个路径', path: null })
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    renameSync(partPath, targetPath)
    return Object.freeze({ ok: true, code: null, reason: null, path: targetPath })
  } catch (error) {
    return Object.freeze({ ok: false, code: TRANSPORT_CODES.WRITE_FAILED, reason: `改名失败：${error?.message ?? error}`, path: null })
  }
}

/** 丢弃一个未提交的 `.part`。取消下载、验签失败、重启清理都走这里。 */
export function discardDownload(partPath) {
  try { rmSync(partPath, { force: true }); return true } catch { return false }
}

function caseInsensitiveEntries(headers) {
  if (headers === null || headers === undefined) return []
  if (typeof headers.entries === 'function') return [...headers.entries()]
  return Object.entries(headers)
}

/**
 * 读 `Content-Length`，**缺失或非法时返回 `null`**。
 *
 * ★ 不能写成 `Number(lookupHeader(headers, 'content-length'))`。
 *   `lookupHeader` 在没有这个头时返回 `null`，而 `Number(null) === 0`：
 *   于是一次**没有 Content-Length 的响应**会被读成"声明了 0 字节"，
 *   然后在一个正常的下载上得到一句"Content-Length 0 与清单声明的
 *   N 不一致"。真实的 HTTP 服务器对分块传输就不会给这个头。
 *
 *   这类 bug 的形态很典型：**判据对着，输入是 null**。
 */
function declaredLengthOf(headers) {
  const raw = lookupHeader(headers, 'content-length')
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null
  return value
}

/**
 * 一个只做限长的流。超限时销毁管道并给出一个**可识别**的错误码，
 * 让上层能把这个失败归到"包比清单说的大"，而不是"网络断了"。
 */
class TransformLimit extends Transform {
  #limit
  #seen = 0
  #onTrip

  constructor(limit, onTrip) {
    super()
    this.#limit = limit
    this.#onTrip = onTrip
  }

  _transform(chunk, _encoding, callback) {
    this.#seen += chunk.length
    if (this.#seen > this.#limit) {
      // ★ 超限即中止请求：继续收下去等于让对方决定我们要写多少磁盘。
      //
      //   ★ `#onTrip?.()` 只调用**一次**（回调本身）。原先写的是
      //   `this.#onTrip()?.()`——那会去调用回调的**返回值**。调用点给的是
      //   `() => deadline.abort()`（返回 undefined），于是 `?.()` 恰好是空操作，
      //   看起来"没坏"；但调用点一旦给一个**返回可调用物**的回调（例如原先把
      //   信号对象当动作传），它就会在超限这条路径上抛 TypeError，把
      //   `NET_TOO_LARGE` 顶掉。
      //
      //   > 一个"恰好是空操作"的 `?.()`，与一个真正的空操作，
      //   > 只在回调返回什么的那一天才看得出区别——而那天正好是限长生效的那天。
      this.#onTrip?.()
      const error = new Error(`NET_TOO_LARGE:${this.#seen}`)
      error.code = 'NET_TOO_LARGE'
      callback(error)
      return
    }
    callback(null, chunk)
  }
}

/** 已落盘文件的摘要（重启后复用缓存前必须重算一次，设计 §6 line 140）。 */export async function hashFileOnDisk(path) {
  if (!existsSync(path)) return null
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** 文件大小（不存在返回 null）。 */
export function sizeOfFile(path) {
  try { return statSync(path).size } catch { return null }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 一个可编排的 fetch 替身：按 URL 队列返回响应，并记录收到的请求。 */
export function createFetchStub(routes = []) {
  const calls = []
  const queue = [...routes]
  async function stub(url, options = {}) {
    calls.push({ url, options })
    const route = queue.shift()
    if (route === undefined) throw Object.assign(new Error('no route'), { code: 'ENOTFOUND' })
    if (typeof route === 'function') return route(url, options)
    if (route.throw !== undefined) throw route.throw
    return makeResponse(route)
  }
  stub.calls = calls
  return stub
}

function makeResponse({ status = 200, headers = {}, body = '', chunks = null }) {
  const encoded = chunks === null ? [Buffer.from(body)] : chunks.map((c) => Buffer.from(c))
  const stream = Readable.from(encoded)
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    body: stream,
    async arrayBuffer() { return Buffer.concat(encoded) },
  }
}

export function selfCheckTransport() {
  const problems = []
  // 自检只覆盖**纯函数**部分：网络行为的证据在 transport.test.mjs 里，
  // 用真实的 fetch 替身驱动。
  if (IDLE_TIMEOUT_MS !== 60_000) problems.push('空闲超时不是设计要求的 60 秒')
  if (MANIFEST_TIMEOUT_MS !== 30_000) problems.push('清单整体超时不是设计要求的 30 秒')
  if (MAX_MANIFEST_BYTES !== 256 * 1024) problems.push('清单上限不是设计要求的 256 KiB')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    limits: Object.freeze({ IDLE_TIMEOUT_MS, MANIFEST_TIMEOUT_MS, MAX_MANIFEST_BYTES }),
  })
}

export const TRANSPORT_CHECKED = selfCheckTransport()
