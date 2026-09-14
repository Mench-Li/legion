// orchestrator/worker/runtime-contract-client.mjs
// ============================================================================
// Runtime Contract 的**客户端适配器**（PRT-253 跨进程边界 · 运行在 orchestrator worker 进程里）
//
// ## 它补的是哪一截
//
// `orchestrator/worker/executor.mjs` 里那句
//
//     adapterFactory = createDshRuntimeAdapter
//
// 是本文件要接的**注入点**。它默认去 import DSH 适配器——那在 worker 进程里
// 是 import 得到、跑不起来的（`host` 端口只有 DSH Runtime 进程里有）。
//
//   > 一个 import 得到的模块，与一个用得到的模块，是两件事。
//   > 前者在 `node --test` 里看不出来：测试是在同一个进程里跑的。
//
// 本模块提供**同一个形状的另一个实现**：`RuntimeAdapter` 的七个方法，
// 但每一个都是往 Runtime 进程的契约端点发一次请求。于是 `executor.mjs` 的
// 执行逻辑一行不改，只是把 `adapterFactory` 换成
// `(host) => createRuntimeContractAdapter(host)`。
//
// ## ★ `execute` 的失败语义（这个文件里最要紧的一段）
//
// 见 `runtime/contracts/wire.mjs` 的 `WIRE_EXECUTE_ENDINGS`。落到代码上：
//
//   · 只有**终态事件**才结束这次运行；异步生成器把终态**yield 出去**，
//     然后正常返回。
//   · 传输失败（读错误/连接中断）→ **抛** `WIRE_CODES.STREAM_BROKEN`。
//   · 对端干净关闭却没有终态 → **抛** `WIRE_CODES.STREAM_NO_TERMINAL`。
//   · 一行不是合法 RunEvent → **抛** `WIRE_CODES.STREAM_MALFORMED`。
//   · 终态之后还有事件 → **抛** `WIRE_CODES.STREAM_AFTER_TERMINAL`。
//
// 后四种都会在 `executor.mjs` 里被它自己的 `try/catch` 收成
// `EXECUTOR_RUN_NOT_COMPLETED`——**与"运行成功"不同形**。这是刻意的：
// 一个能在网络抖动时静默成功的客户端，比一个会失败的客户端危险得多。
//
// ## 为什么 `probe()` 要复用 `probeRuntime()`
//
// `executor.mjs` 在第一次执行前调 `adapter.probe()`。跨进程时，"探测"这件事
// 发生在**对端**（能力表只有引擎那一侧读得到），而**判定**可以在这一侧做。
// 所以 `probe()` 只做两件事：把对端的版本+能力取回来，交给
// `runtime/adapters/dsh/probe.mjs` 的 `probeRuntime()` 得出**同一套**结论。
//
//   > 一个在本进程里再写一遍"哪些能力算数"的探测，
//   > 与一个"两处判定迟早不一样"的探测，是同一个东西。
//
// ## 默认值纪律
//
// `baseUrl` 与 `token` **都没有默认值**：缺 baseUrl 是本进程接线错
// （`BAD_WIRING`），缺 token 由调用方（`executor-binding.mjs`）在**更早**
// 就具名拒绝。`requestTimeoutMs` 是一个**上界**，不是对引擎的承诺——
// 给控制类请求一个默认上界是安全的（它只能让失败更早地被看见），
// 而给端点/凭证一个默认值会让"没配"与"配好了"在读数上同形。
//
// `execute` **不设**超时上界：一次真实运行的长度由 `RunRequest.timeoutMs`
// 决定，而它由**服务端**适配器的看门狗强制执行。在这里再设一个会让
// "运行超时"与"网络超时"混成一个读数。
// ============================================================================

import { probeRuntime } from '../../runtime/adapters/dsh/probe.mjs'
import { RUNTIME_CONTRACT_VERSION } from '../../runtime/contracts/adapter.mjs'
import {
  RUNTIME_CONTRACT_WIRE_VERSION,
  WIRE_AUTH_HEADER,
  WIRE_AUTH_SCHEME,
  WIRE_CODES,
  WIRE_ROUTES,
  decodeEventLine,
  isWireTerminalEvent,
  readEnvelope,
  wireRequest,
} from '../../runtime/contracts/wire.mjs'

/** 客户端**没有**对端可选：这些是最坏情况下的传输上界（控制类请求）。 */
export const RUNTIME_CONTRACT_CLIENT_DEFAULT_TIMEOUT_MS = 30_000

/**
 * 客户端的具名失败。
 *
 * `code` 取自 `WIRE_CODES`（协议的两半共用一份码表）；
 * `innerCode` 在**对端**给了它自己的具名码时填上——"谁拒绝的"与"拒绝成什么样"
 * 必须分得开，否则运维只能看到一句笼统的"运行时拒绝了"。
 */
export class RuntimeContractClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'RuntimeContractClientError'
    this.code = code
    if (extra.innerCode !== undefined) this.innerCode = extra.innerCode
    if (extra.status !== undefined) this.status = extra.status
    if (extra.details !== undefined) this.details = extra.details
    this.outcomeUnknown = extra.outcomeUnknown === true
  }
}

/** 归一化 baseUrl：去尾斜杠。**不补默认主机、不补默认端口、不补协议。** */
function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  return text.replace(/\/+$/, '')
}

/**
 * 造一个走 Runtime Contract 的 `RuntimeAdapter`。
 *
 * @param {object} host
 * @param {string} host.baseUrl Runtime 进程契约端点的根（如 `http://127.0.0.1:3080`）。
 * @param {string} [host.token] 与 Runtime 进程约定的凭证。**没有默认值。**
 * @param {Function} [host.fetchImpl] 注入的 fetch（测试用）。
 * @param {number} [host.requestTimeoutMs] 控制类请求的上界。
 */
export function createRuntimeContractAdapter(host = {}) {
  const baseUrl = normalizeBaseUrl(host?.baseUrl)
  if (baseUrl === null) {
    throw new RuntimeContractClientError(
      WIRE_CODES.BAD_WIRING,
      'createRuntimeContractAdapter 需要 host.baseUrl：没有它就没有可到达的 Runtime 进程' +
      '（本模块**不**提供默认端点：猜出来的地址会让"没配"与"配对了"在读数上同形）',
    )
  }
  const token = typeof host?.token === 'string' && host.token.trim() !== '' ? host.token.trim() : null
  const fetchImpl = typeof host?.fetchImpl === 'function' ? host.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new RuntimeContractClientError(
      WIRE_CODES.BAD_WIRING,
      'createRuntimeContractAdapter 需要一个 fetch 实现（Node 18+ 有全局 fetch）',
    )
  }
  const requestTimeoutMs = Number.isInteger(host?.requestTimeoutMs)
    ? host.requestTimeoutMs
    : RUNTIME_CONTRACT_CLIENT_DEFAULT_TIMEOUT_MS

  /** 每个操作一个 URL。路由表是**共享的**，不在这里再写一遍路径字符串。 */
  const urlFor = (operation) => `${baseUrl}${WIRE_ROUTES[operation].path}`

  function headers(extra = {}) {
    const h = { accept: 'application/json', ...extra }
    if (token !== null) h[WIRE_AUTH_HEADER] = `${WIRE_AUTH_SCHEME} ${token}`
    return h
  }

  /** 把一次传输层的失败归成 `UNREACHABLE`。**不吞原始消息。** */
  async function doFetch(operation, init) {
    let res
    try {
      res = await fetchImpl(urlFor(operation), init)
    } catch (e) {
      throw new RuntimeContractClientError(
        WIRE_CODES.UNREACHABLE,
        `连不上 Runtime 契约端点（${WIRE_ROUTES[operation].path}）：${e?.message ?? String(e)}`,
        { details: { operation, baseUrl } },
      )
    }
    return res
  }

  /** 读一个 JSON 信封；非 2xx 或信封错误一律抛具名错误。 */
  async function readJsonResponse(operation, res) {
    let body
    let text = ''
    try {
      text = await res.text()
    } catch (e) {
      throw new RuntimeContractClientError(
        WIRE_CODES.UNREACHABLE,
        `读 ${operation} 的响应失败：${e?.message ?? String(e)}`,
        { details: { operation, status: res.status } },
      )
    }
    try {
      body = text.trim() === '' ? null : JSON.parse(text)
    } catch {
      throw new RuntimeContractClientError(
        WIRE_CODES.BAD_RESPONSE,
        `${operation} 的响应不是 JSON（HTTP ${res.status}）——先看对端是不是本协议的服务`,
        { status: res.status, details: { operation } },
      )
    }
    const envelope = readEnvelope(body)
    if (!envelope.ok) {
      // 对端**具名拒绝**（或答了不合协议的东西）。把它的码原样带在 innerCode 上：
      // 它回答的是"为什么"，我们这里只回答"这是对端说的"。
      throw new RuntimeContractClientError(
        res.status === 401 || res.status === 403 ? WIRE_CODES.UNAUTHORIZED : envelope.code,
        `Runtime 契约端点拒绝了 ${operation}（HTTP ${res.status}）：${envelope.message}`,
        { innerCode: envelope.code, status: res.status, details: envelope.details ?? null },
      )
    }
    return envelope.result
  }

  /** 控制类请求：GET 无体 / POST 带 `{wireVersion, ...}`。 */
  async function callJson(operation, payload) {
    const route = WIRE_ROUTES[operation]
    const init = {
      method: route.method,
      headers: route.method === 'POST'
        ? headers({ 'content-type': 'application/json' })
        : headers(),
      signal: AbortSignal.timeout(requestTimeoutMs),
    }
    if (route.method === 'POST') init.body = JSON.stringify(wireRequest(payload ?? {}))
    const res = await doFetch(operation, init)
    return readJsonResponse(operation, res)
  }

  /**
   * `execute`：NDJSON over HTTP。
   *
   * 只在**收到终态事件**时正常返回；其余一切结束方式都抛（见文件头）。
   */
  async function* execute(request) {
    const res = await doFetch('execute', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', accept: 'application/x-ndjson' }),
      body: JSON.stringify(wireRequest({ request })),
      // **不设 signal**：运行的长度由 RunRequest.timeoutMs 决定，
      // 由服务端适配器的看门狗强制执行（见文件头）。
    })

    if (res.status !== 200) {
      // 流**一个字节都没开始**：这是对端的具名拒绝，不是断流。
      await readJsonResponse('execute', res)
      throw new RuntimeContractClientError(
        WIRE_CODES.BAD_RESPONSE,
        'execute 返回了 200 之外的状态却没有可读的拒绝信封',
        { status: res.status },
      )
    }
    if (res.body === null || typeof res.body?.getReader !== 'function') {
      throw new RuntimeContractClientError(
        WIRE_CODES.BAD_RESPONSE,
        'execute 的响应没有可读的流主体——不能把整段正文当成一条流来读',
        { status: res.status },
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let terminalSeen = false
    let sawAny = false

    const onLine = (line) => {
      const decoded = decodeEventLine(line)
      if (!decoded.ok) {
        if (decoded.control !== undefined) {
          // ★ 服务端**知道**发生了什么，并用具名码说了出来。
          //   这不可能是"运行成功"：控制帧只在流没有正常收尾时出现。
          throw new RuntimeContractClientError(
            decoded.control.code ?? WIRE_CODES.BAD_RESPONSE,
            `execute 的流被对端以控制帧终止：${decoded.control.message ?? ''}`,
            { outcomeUnknown: true, details: decoded.control.details ?? null, innerCode: decoded.control.code ?? null },
          )
        }
        throw new RuntimeContractClientError(
          WIRE_CODES.STREAM_MALFORMED,
          `execute 的流里有一行不是合法 RunEvent：${decoded.errors.join('；')}`,
          { outcomeUnknown: true, details: { line: line.slice(0, 200) } },
        )
      }
      if (decoded.empty) return null
      if (terminalSeen) {
        throw new RuntimeContractClientError(
          WIRE_CODES.STREAM_AFTER_TERMINAL,
          `execute 的流在终态事件之后又给了事件 ${decoded.event.type}——终态必须是最后一个`,
          { outcomeUnknown: true, details: { type: decoded.event.type } },
        )
      }
      if (isWireTerminalEvent(decoded.event)) terminalSeen = true
      return decoded.event
    }

    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (e) {
        // ★ 传输失败：**绝不能**在这里返回（那会被上游读成"流正常结束"）。
        throw new RuntimeContractClientError(
          WIRE_CODES.STREAM_BROKEN,
          `execute 的事件流在读到终态之前中断了：${e?.message ?? String(e)}`,
          {
            outcomeUnknown: true,
            details: { terminalSeen: false, sawAnyEvent: sawAny },
          },
        )
      }
      if (chunk.done === true) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const event = onLine(line)
        if (event !== null) { sawAny = true; yield event }
        nl = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const event = onLine(buffer)
      if (event !== null) { sawAny = true; yield event }
    }

    if (!terminalSeen) {
      // ★ 对端**干净关闭**却没有终态。这与"传输中断"不同（对端说完了，
      //   只是没说结论），但**同样不能**被读成一次成功。
      throw new RuntimeContractClientError(
        WIRE_CODES.STREAM_NO_TERMINAL,
        'execute 的事件流读完了却没有终态事件——契约要求它以一个终态事件结束',
        { outcomeUnknown: true, details: { sawAnyEvent: sawAny } },
      )
    }
  }

  const adapter = {
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,

    /**
     * 探测：把对端的版本与能力取回来，交给**同一个** `probeRuntime()` 判定。
     *
     * 先读 health 再读 capabilities：health 是唯一匿名的端点，而服务端在第一次
     * 读 health/capabilities 时执行**那一次真的探测**（见 server 的 `ensureProbed`）。
     */
    async probe() {
      const health = await callJson('getHealth')
      const capabilities = await callJson('getCapabilities')
      const version = health !== null && typeof health === 'object' && typeof health.runtimeVersion === 'string'
        ? health.runtimeVersion
        : null
      const result = await probeRuntime({
        probeRuntime: async () => ({ version, capabilities }),
      })
      // 对端自报的健康状态一并带上，好让调用方分清
      // 「引擎自己说它不可用」与「契约协商不过」。
      return { ...result, healthState: health?.state ?? null }
    },

    getHealth: () => callJson('getHealth'),
    getCapabilities: () => callJson('getCapabilities'),
    listModels: () => callJson('listModels'),
    validateProfile: (profile) => callJson('validateProfile', { profile }),
    cancel: (runId) => callJson('cancel', { runId }),
    recover: (runId) => callJson('recover', { runId }),
    execute,
  }

  return adapter
}

/**
 * ★ 跨进程的**强制面结论**读取（`enforcement` 附加端点）。
 *
 * 单独一个函数而不是 `RuntimeAdapter` 的第八个方法：它的语义属于
 * 「Legion 把 Runtime 进程里的强制面判定搬过来」，不属于执行引擎契约
 * （见 `runtime/contracts/wire.mjs` 里 `enforcement` 路由的注释）。
 *
 * 它把对端的结论**原样**返回（`{autoExecutionForbidden, state, checks, reasons}`），
 * 不做任何默认填充：一个"读不到就当它通过"的包装，会把
 * 「禁止自动执行」这条保证变成一个装饰。
 */
export async function fetchEnforcementVerdict(host = {}) {
  const baseUrl = normalizeBaseUrl(host?.baseUrl)
  if (baseUrl === null) {
    throw new RuntimeContractClientError(WIRE_CODES.BAD_WIRING, 'fetchEnforcementVerdict 需要 host.baseUrl')
  }
  const token = typeof host?.token === 'string' && host.token.trim() !== '' ? host.token.trim() : null
  const fetchImpl = typeof host?.fetchImpl === 'function' ? host.fetchImpl : globalThis.fetch
  const requestTimeoutMs = Number.isInteger(host?.requestTimeoutMs)
    ? host.requestTimeoutMs
    : RUNTIME_CONTRACT_CLIENT_DEFAULT_TIMEOUT_MS
  const h = { accept: 'application/json' }
  if (token !== null) h[WIRE_AUTH_HEADER] = `${WIRE_AUTH_SCHEME} ${token}`
  let res
  try {
    res = await fetchImpl(`${baseUrl}${WIRE_ROUTES.enforcement.path}`, {
      method: WIRE_ROUTES.enforcement.method,
      headers: h,
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (e) {
    throw new RuntimeContractClientError(
      WIRE_CODES.UNREACHABLE,
      `连不上 Runtime 契约端点（${WIRE_ROUTES.enforcement.path}）：${e?.message ?? String(e)}`,
    )
  }
  let body = null
  try { body = JSON.parse(await res.text()) } catch { body = null }
  const envelope = readEnvelope(body)
  if (!envelope.ok) {
    throw new RuntimeContractClientError(
      res.status === 401 || res.status === 403 ? WIRE_CODES.UNAUTHORIZED : envelope.code,
      `读取强制面结论失败（HTTP ${res.status}）：${envelope.message}`,
      { innerCode: envelope.code, status: res.status },
    )
  }
  return envelope.result
}

/** 线上格式版本（供诊断打印）。 */
export const RUNTIME_CONTRACT_CLIENT_WIRE_VERSION = RUNTIME_CONTRACT_WIRE_VERSION
