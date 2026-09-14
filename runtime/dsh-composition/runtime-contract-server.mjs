// runtime/dsh-composition/runtime-contract-server.mjs
// ============================================================================
// Runtime Contract 的**服务端**（PRT-253 跨进程边界 · 运行在 DSH Runtime 进程里）
//
// ## 它补的是哪一截
//
// 部署里有两个进程（`product/process-manifest.mjs`）：`runtime` 与 `orchestrator`。
// DSH 执行引擎住在 runtime 进程里，而消费它的 worker 住在 orchestrator 进程里。
// 此前的全部装配（`runtime-host-row.mjs` → `bootstrap.mjs` → `bindDshRuntime()`）
// 都是**进程内**的：注册口是一个模块级栈，worker 在另一个进程里 import 不到。
//
//   > 一个"绑定得非常好"的进程内注册口，在一个两进程的部署里，
//   > 与一个从未被注册过的注册口，产生的是同一个 worker 读数。
//
// 本模块是那台**监听器**：把七个契约方法（+ `enforcement` 附加端点）
// 以 `node:http` 暴露在回环地址上，用**进程内**那台真的适配器回答请求。
//
// ## 零第三方依赖
//
// 只用 `node:http`。这与仓库其余进程一致（team-hub / workbench 都是裸 `node:http`），
// 理由不是"省一个包"，而是：Runtime 进程是**最不能因为依赖装不上而起不来**的那个。
//
// ## ★ 鉴权 fail closed（本模块最要紧的一条）
//
//   ① 需要鉴权的操作**永不**在没有 token 的进程上提供服务：
//      不是"放行但记一条日志"，而是**具名拒绝** `RUNTIME_CONTRACT_NO_TOKEN`。
//   ② 出示的 token 不匹配 → `RUNTIME_CONTRACT_UNAUTHORIZED`。
//   ③ 两条**必须可分**：一个是"这台机器没配"，一个是"你给的凭证不对"，
//      修法完全不同（去配 vs 去取对的）。
//   ④ `execute` / `cancel` / `recover` **永不匿名**——匿名表在
//      `runtime/contracts/wire.mjs` 里有装载期断言兜着。
//
// 唯一匿名的是 `GET health`。判据与代价写在 `WIRE_ANONYMOUS_OPERATIONS` 的注释里：
// 它不含模型清单、能力表或任何一次运行的输入，**没有可被骗的东西**；
// 而 Launcher 的就绪探测恰好在还没有任何凭证的时刻要问它。
// 代价是：一个能连到本端口的本地进程可以知道"这里有没有一个执行引擎在跑"。
// 这个端口本来就只监听回环，威胁模型里已经包含本地进程。
//
// ## `execute` 的终止纪律（与 wire.mjs 的失败语义逐条对应）
//
//   · 请求体不合法 → 400 + JSON 拒绝，**流一个字节都不写**（客户端不会误以为"流开始了"）。
//   · 适配器在**第一个事件之前**抛 → 500 + JSON 拒绝（同上）。
//   · 适配器在第一个事件之前就结束（没有终态）→ 502 + JSON 拒绝
//     `RUNTIME_CONTRACT_STREAM_NO_TERMINAL`。**这是服务端自己的判定**，不是客户端猜的。
//   · 流已经开始之后出任何问题 → `res.destroy()`，**绝不** `res.end()`。
//     对端因此看到的是**传输失败**，而不是"这条流好好地说完了"。
//   · 终态之后又来了事件 → 同样 `res.destroy()`（终态必须是最后一个）。
//
// 最后两条是本模块存在的理由里最容易被写错的一半：
// 一个"出错时 `res.end()`"的实现，会让每一次断流都长得像一次成功收尾。
//
// ## 端口与地址：默认值里只有一个是安全的
//
// `host` 缺省是 `127.0.0.1`。理由：这个默认值**只能更严格**——
// 它不可能把监听面意外放大到局域网上（spec §10「默认只监听 loopback」）。
// `port` **没有默认值**：缺了就具名拒绝。给一个默认端口会让
// "没配"与"配在此端口上"在读数上同形，而端口冲突的现场（EADDRINUSE）
// 与"服务没起来"是完全不同的两件事。
// `port: 0` 是**允许**的（内核分配临时端口），分配到的端口从 `address()` 读回——
// 测试与任何不想占用固定端口的部署都用它。
// ============================================================================

import { createServer } from 'node:http'

import { assertAdapter } from '../contracts/adapter.mjs'
import { validateRunRequest } from '../contracts/run.mjs'
import {
  RUNTIME_CONTRACT_WIRE_VERSION,
  WIRE_AUTH_HEADER,
  WIRE_CODES,
  WIRE_MAX_BODY_BYTES,
  WIRE_NDJSON_CONTENT_TYPE,
  WIRE_JSON_CONTENT_TYPE,
  decodeEventLine,
  encodeControlFrame,
  encodeEventLine,
  isAnonymousOperation,
  isWireTerminalEvent,
  parseAuthorization,
  readRequestEnvelope,
  routeFor,
  tokensMatch,
  wireRefusal,
  wireSuccess,
} from '../contracts/wire.mjs'

/** 本模块的具名码（**运行期的服务端**：造不出来 / 听不上）。 */
export const RUNTIME_CONTRACT_SERVER_CODES = Object.freeze({
  /** 传进来的适配器不满足 `RuntimeAdapter` 形状（七个方法 + 契约版本）。 */
  BAD_ADAPTER: 'RUNTIME_CONTRACT_SERVER_BAD_ADAPTER',
  /** 没有给监听端口。**不给默认值**——见文件头。 */
  NO_BIND_PORT: 'RUNTIME_CONTRACT_SERVER_NO_BIND_PORT',
  /** 没有给适配器。 */
  NO_ADAPTER: 'RUNTIME_CONTRACT_SERVER_NO_ADAPTER',
  /** `listen()` 失败（端口被占、地址不可用）。**与"没配端口"是两件事**。 */
  LISTEN_FAILED: 'RUNTIME_CONTRACT_SERVER_LISTEN_FAILED',
})

/**
 * 缺省监听地址。**只能更严格**的默认值（见文件头）。
 * 与 `product/process-manifest.mjs` 的 `LOOPBACK_HOSTS` 同一个取值。
 */
export const RUNTIME_CONTRACT_DEFAULT_HOST = '127.0.0.1'

/** 需要 JSON body 的操作。 */
const BODY_OPERATIONS = Object.freeze(['validateProfile', 'execute', 'cancel', 'recover'])

function refuse(code, message, reasons = [], extra = {}) {
  return Object.freeze({
    ok: false,
    code,
    message: String(message ?? ''),
    reasons: Object.freeze([...reasons]),
    ...extra,
  })
}

/** 读 JSON 请求体，带上限。**不吞**解析错误——调用方要把它变成具名拒绝。 */
function readJsonBody(req, limit = WIRE_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; fn(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        done(reject, Object.assign(new Error(`请求体超过 ${limit} 字节`), { code: WIRE_CODES.BODY_TOO_LARGE }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return done(resolve, {})
      try {
        done(resolve, JSON.parse(text))
      } catch (e) {
        done(reject, Object.assign(new Error(`请求体不是合法 JSON：${e?.message ?? String(e)}`), { code: WIRE_CODES.BAD_REQUEST }))
      }
    })
    req.on('error', (e) => done(reject, Object.assign(new Error(`读请求体失败：${e?.message ?? String(e)}`), { code: WIRE_CODES.BAD_REQUEST })))
  })
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': WIRE_JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 造一个 Runtime Contract 服务端。
 *
 * **返回判别式联合**（与 `createProductionExecutor` / `runWorkerProcess` 同一约定）：
 *   · `{ok:false, code, message, reasons}` —— 造不出来，且说得清为什么；
 *   · `{ok:true, listen, close, address, state}` —— 造出来了，但**还没监听**。
 *
 * 之所以不在 `create` 里就 `listen`：`listen` 是异步的、会失败（EADDRINUSE），
 * 而"造出来"与"听上了"在调用方那里需要分别处理（前者是接线错，后者是环境冲突）。
 *
 * @param {object} input
 * @param {object} input.adapter 真适配器（`createDshRuntimeAdapter` 的产物）。
 * @param {string|null} [input.token] 鉴权 token。`null`/空 → 需要鉴权的操作具名拒绝。
 * @param {(() => Promise<object>)|null} [input.enforcement] 强制面结论来源。缺 → 该端点具名拒绝。
 * @param {string} [input.host] 监听地址（缺省只回环）。
 * @param {number} input.port 监听端口（`0` = 内核分配；**无默认值**）。
 * @param {number} [input.requestTimeoutMs] 单次请求的**服务端**上限（`execute` 除外）。
 */
export function createRuntimeContractServer(input = {}) {
  const {
    adapter = null,
    token = null,
    enforcement = null,
    host = RUNTIME_CONTRACT_DEFAULT_HOST,
    port = null,
    requestTimeoutMs = 60_000,
  } = input

  if (adapter === null || typeof adapter !== 'object') {
    return refuse(RUNTIME_CONTRACT_SERVER_CODES.NO_ADAPTER, '没有适配器：服务端没有可回答的东西', [
      '把 createDshRuntimeAdapter(host) 的产物传进来；本模块不自己造适配器，也不提供一个空壳',
    ])
  }
  const shape = assertAdapter(adapter)
  if (!shape.ok) {
    return refuse(RUNTIME_CONTRACT_SERVER_CODES.BAD_ADAPTER, '适配器不满足 RuntimeAdapter 形状', shape.errors)
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    return refuse(RUNTIME_CONTRACT_SERVER_CODES.NO_BIND_PORT, '没有给监听端口（或它不是 0..65535 的整数）', [
      '端口没有默认值：给一个默认端口会让"没配"与"配在这个端口上"在读数上同形',
      '用 0 表示由内核分配临时端口，分配结果从 address() 读回',
    ])
  }

  /** token 是不是一个"配了"的凭证。空串与空白一律算没配。 */
  const configuredToken = typeof token === 'string' && token.trim() !== '' ? token : null
  const enforcementSource = typeof enforcement === 'function' ? enforcement : null

  /**
   * 探测**只跑一次**，由第一次读 health/capabilities 触发。
   *
   * 为什么在这里探测：`DshRuntimeAdapter.getCapabilities()` 只上报**探测确认过的**能力
   * （未探测时是空集，`checkCompatibility` 因此判不兼容——那是想要的 fail closed）。
   * 一个从不探测的服务端会永远报"不兼容"，而那不是**这台引擎**的结论，
   * 是"没人问过它"的结论。两者在读数上必须分得开，而唯一的办法就是真的问一次。
   *
   * 探测失败**不吞**：记在 `probeFailure` 里，health 以具名拒绝回答
   * （`ADAPTER_THREW`），而不是回落成"starting"——"我不知道"与"它在启动"是两件事。
   */
  let probeStarted = null
  let probeFailure = null
  async function ensureProbed() {
    if (probeStarted !== null) return probeStarted
    probeStarted = (async () => {
      if (typeof adapter.probe !== 'function') return
      try {
        await adapter.probe()
      } catch (e) {
        probeFailure = { message: e?.message ?? String(e) }
      }
    })()
    return probeStarted
  }

  /** 鉴权判定。**只返回判定**，不写响应——调用方决定怎么答。 */
  function authorize(req, operation) {
    if (isAnonymousOperation(operation)) return { ok: true, anonymous: true }
    if (configuredToken === null) {
      return {
        ok: false,
        status: 403,
        code: WIRE_CODES.NO_TOKEN,
        message: `本进程没有配置 Runtime Contract token，操作 ${operation} 一律不提供服务`,
        details: { operation, remedy: '给 Runtime 进程配置 token，并把它交给 worker 一侧' },
      }
    }
    const presented = parseAuthorization(req.headers[WIRE_AUTH_HEADER])
    if (presented === null) {
      return {
        ok: false,
        status: 401,
        code: WIRE_CODES.UNAUTHORIZED,
        message: `操作 ${operation} 需要 authorization: Bearer <token>`,
        details: { operation },
      }
    }
    if (!tokensMatch(presented.token, configuredToken)) {
      return {
        ok: false,
        status: 401,
        code: WIRE_CODES.UNAUTHORIZED,
        message: `操作 ${operation} 的凭证不匹配`,
        details: { operation },
      }
    }
    return { ok: true, anonymous: false }
  }

  /** 把适配器的一次调用变成一个响应。异常一律具名，不向上抛成 500 空体。 */
  async function answerJson(res, status, fn) {
    let value
    try {
      value = await fn()
    } catch (e) {
      sendJson(res, 500, wireRefusal(WIRE_CODES.ADAPTER_THREW, `适配器抛出：${e?.message ?? String(e)}`))
      return
    }
    sendJson(res, status, wireSuccess(value))
  }

  async function handleExecute(req, res, body) {
    const request = body?.request
    const check = validateRunRequest(request)
    if (!check.ok) {
      sendJson(res, 400, wireRefusal(WIRE_CODES.BAD_REQUEST, 'RunRequest 不合法', check.errors))
      return
    }

    let iterator
    try {
      const stream = adapter.execute(request)
      if (stream === null || typeof stream !== 'object' || typeof stream[Symbol.asyncIterator] !== 'function') {
        sendJson(res, 500, wireRefusal(
          WIRE_CODES.ADAPTER_SHAPE_INVALID,
          'execute() 没有返回异步可迭代对象——这不是一条流，不能当作流来读',
          [`收到 ${stream === null ? 'null' : typeof stream}`],
        ))
        return
      }
      iterator = stream[Symbol.asyncIterator]()
    } catch (e) {
      sendJson(res, 500, wireRefusal(WIRE_CODES.ADAPTER_THREW, `execute() 抛出：${e?.message ?? String(e)}`))
      return
    }

    // ★ 先拉第一个事件**再写头**。这样"适配器一开始就炸"是一个 4xx/5xx 的具名拒绝，
    //   而不是一个已经开始了、却一个事件都没有的 200 流——后者在对端读起来
    //   与"运行正常但什么都没发生"太像了。
    let first
    try {
      first = await iterator.next()
    } catch (e) {
      sendJson(res, 500, wireRefusal(WIRE_CODES.ADAPTER_THREW, `事件流在第一个事件之前抛出：${e?.message ?? String(e)}`))
      return
    }
    if (first === null || typeof first !== 'object' || first.done === true) {
      sendJson(res, 502, wireRefusal(
        WIRE_CODES.STREAM_NO_TERMINAL,
        '事件流在产生任何事件之前就结束了——契约要求它以终态事件结束',
        ['这条读数与"传输中断"是两件事：对端说完了，只是没说结论'],
      ))
      return
    }

    if (res.writableEnded || res.destroyed) return
    res.writeHead(200, {
      'content-type': WIRE_NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store',
      // 明确禁用压缩与分块缓冲间的任何猜测：帧边界就是换行。
      'x-accel-buffering': 'no',
    })

    /** 流已经开始之后，**唯一的报错方式**是控制帧 + 干净收尾。
     *
     * 为什么不是 `res.destroy()`：毁了连接之后，对端读到的是**传输失败**，
     * 于是"适配器违约"与"服务端进程崩了 / 网络断了"在读数上同形——
     * 而这两件事的排障方向完全相反。控制帧把服务端**已经知道**的那件事
     * 原样带过去（见 `runtime/contracts/wire.mjs` 的 `WIRE_CONTROL_KEY`）。
     *
     * `destroy` 只在一处保留：对端自己走了（写不下去）。
     */
    const failStream = (code, message, details = null) => {
      if (res.writableEnded || res.destroyed) return
      try {
        res.write(encodeControlFrame(code, message, details))
      } catch {
        // 连控制帧都写不出去：这时只剩毁连接一条路。
        try { res.destroy() } catch { /* 已经关了 */ }
        return
      }
      res.end()
    }

    let terminalSeen = false
    let current = first
    try {
      for (;;) {
        const event = current.value
        if (isWireTerminalEvent(event)) {
          if (terminalSeen) {
            failStream(WIRE_CODES.STREAM_AFTER_TERMINAL, '终态事件出现了两次')
            return
          }
          terminalSeen = true
        } else if (terminalSeen) {
          // 终态之后还有事件：终态必须是最后一个（run.mjs 的终态契约）。
          failStream(
            WIRE_CODES.STREAM_AFTER_TERMINAL,
            `终态事件之后仍有事件：${String(event?.type ?? '(无 type)')}`,
          )
          return
        }
        let line
        try {
          line = encodeEventLine(event)
        } catch (e) {
          // 引擎发了个畸形事件。**不能**换一个空行发出去：那会让对端读到
          // 一个语法正确、语义空洞的流，而真正的问题（适配器违约）消失。
          failStream(
            WIRE_CODES.ADAPTER_SHAPE_INVALID,
            `事件流出产了不合契约的事件：${e?.message ?? String(e)}`,
          )
          return
        }
        if (res.writableEnded || res.destroyed) {
          // 对端走了。停手——让生成器的 finally 有机会回收（abort / dispose）。
          return
        }
        res.write(line)
        current = await iterator.next()
        if (current === null || typeof current !== 'object' || current.done === true) break
      }
    } catch (e) {
      failStream(WIRE_CODES.ADAPTER_THREW, `事件流在播出过程中抛出：${e?.message ?? String(e)}`)
      return
    }

    if (!terminalSeen) {
      // 走到了自然结束却没有终态。**这不是**成功收尾：整条流是协议违规。
      failStream(
        WIRE_CODES.STREAM_NO_TERMINAL,
        '事件流结束了却没有终态事件——契约要求它以终态事件结束',
      )
      return
    }
    if (!res.writableEnded && !res.destroyed) res.end()
  }

  async function handle(req, res) {
    const decision = routeFor(req.method, (req.url ?? '/').split('?')[0])
    if (decision.kind === 'unknown-route') {
      sendJson(res, 404, wireRefusal(WIRE_CODES.UNKNOWN_ROUTE, `没有这条路由：${req.method} ${req.url}`))
      return
    }
    if (decision.kind === 'method-not-allowed') {
      sendJson(res, 405, wireRefusal(
        WIRE_CODES.METHOD_NOT_ALLOWED,
        `${decision.operation} 只接受 ${decision.allowed}`,
        [`收到 ${req.method}`],
      ))
      return
    }

    const { operation } = decision
    const auth = authorize(req, operation)
    if (!auth.ok) {
      sendJson(res, auth.status, wireRefusal(auth.code, auth.message, auth.details ?? null))
      return
    }

    if (operation === 'enforcement') {
      if (enforcementSource === null) {
        sendJson(res, 503, wireRefusal(
          WIRE_CODES.ENFORCEMENT_UNAVAILABLE,
          '这个 Runtime 进程里没有强制面结论的来源',
          [
            '这与"强制面没生效"是两件事：这里连判定都没有人做过',
            '接线方必须把 selfCheck 的来源交给本行（不给默认值：默认"通过"会让禁止自动执行的保证失效）',
          ],
        ))
        return
      }
      let verdict
      try {
        verdict = await enforcementSource()
      } catch (e) {
        sendJson(res, 503, wireRefusal(WIRE_CODES.ENFORCEMENT_UNAVAILABLE, `强制面结论的来源抛出：${e?.message ?? String(e)}`))
        return
      }
      if (verdict === null || typeof verdict !== 'object' || typeof verdict.autoExecutionForbidden !== 'boolean') {
        sendJson(res, 503, wireRefusal(
          WIRE_CODES.ENFORCEMENT_UNAVAILABLE,
          '强制面结论的形状不对：必须是带布尔字段 autoExecutionForbidden 的对象',
          [`收到 ${verdict === null ? 'null' : typeof verdict}`],
        ))
        return
      }
      sendJson(res, 200, wireSuccess(verdict))
      return
    }

    if (BODY_OPERATIONS.includes(operation) && operation !== 'execute') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (e) {
        const code = e?.code === WIRE_CODES.BODY_TOO_LARGE ? WIRE_CODES.BODY_TOO_LARGE : WIRE_CODES.BAD_REQUEST
        sendJson(res, code === WIRE_CODES.BODY_TOO_LARGE ? 413 : 400, wireRefusal(code, e?.message ?? String(e)))
        return
      }
      const envelope = readRequestEnvelope(body)
      if (!envelope.ok) {
        // 请求侧的信封也得合协议：`wireVersion` 对不上说明对端按另一版协议说话。
        sendJson(res, 400, wireRefusal(WIRE_CODES.BAD_REQUEST, envelope.message))
        return
      }
      if (operation === 'validateProfile') {
        const profile = body?.profile
        if (profile === null || typeof profile !== 'object') {
          sendJson(res, 400, wireRefusal(WIRE_CODES.BAD_REQUEST, 'validateProfile 需要 body.profile 对象'))
          return
        }
        await answerJson(res, 200, () => adapter.validateProfile(profile))
        return
      }
      if (operation === 'cancel') {
        const runId = body?.runId
        if (typeof runId !== 'string' || runId.trim() === '') {
          sendJson(res, 400, wireRefusal(WIRE_CODES.BAD_REQUEST, 'cancel 需要 body.runId 字符串'))
          return
        }
        await answerJson(res, 200, () => adapter.cancel(runId))
        return
      }
      if (operation === 'recover') {
        const runId = body?.runId
        if (typeof runId !== 'string' || runId.trim() === '') {
          sendJson(res, 400, wireRefusal(WIRE_CODES.BAD_REQUEST, 'recover 需要 body.runId 字符串'))
          return
        }
        await answerJson(res, 200, () => adapter.recover(runId))
        return
      }
    }

    if (operation === 'execute') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (e) {
        const code = e?.code === WIRE_CODES.BODY_TOO_LARGE ? WIRE_CODES.BODY_TOO_LARGE : WIRE_CODES.BAD_REQUEST
        sendJson(res, code === WIRE_CODES.BODY_TOO_LARGE ? 413 : 400, wireRefusal(code, e?.message ?? String(e)))
        return
      }
      await handleExecute(req, res, body)
      return
    }

    if (operation === 'getHealth') {
      await ensureProbed()
      if (probeFailure !== null) {
        sendJson(res, 503, wireRefusal(
          WIRE_CODES.ADAPTER_THREW,
          `运行时探测抛出：${probeFailure.message}`,
          ['"探测失败"与"健康状态是 starting"是两件事——前者是不知道，后者是一个结论'],
        ))
        return
      }
      await answerJson(res, 200, () => adapter.getHealth())
      return
    }
    if (operation === 'getCapabilities') {
      await ensureProbed()
      if (probeFailure !== null) {
        sendJson(res, 503, wireRefusal(WIRE_CODES.ADAPTER_THREW, `运行时探测抛出：${probeFailure.message}`))
        return
      }
      await answerJson(res, 200, () => adapter.getCapabilities())
      return
    }
    if (operation === 'listModels') {
      await answerJson(res, 200, () => adapter.listModels())
      return
    }

    // 路由表里新增了操作而这里没有分支：**具名拒绝**，不静默 404。
    // 一个静默 404 会让"忘了实现"表现成"地址写错了"。
    sendJson(res, 501, wireRefusal(WIRE_CODES.UNKNOWN_ROUTE, `路由 ${operation} 有声明但没有实现分支`))
  }

  let bound = null
  const server = createServer((req, res) => {
    res.setHeader('x-legion-wire-version', String(RUNTIME_CONTRACT_WIRE_VERSION))
    Promise.resolve(handle(req, res)).catch((e) => {
      sendJson(res, 500, wireRefusal(WIRE_CODES.ADAPTER_THREW, `服务端内部错误：${e?.message ?? String(e)}`))
    })
  })
  server.requestTimeout = requestTimeoutMs
  server.headersTimeout = requestTimeoutMs

  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    reasons: Object.freeze([]),
    /** 监听。`{ok:true, host, port}` / `{ok:false, code, message, reasons}`。 */
    listen() {
      return new Promise((resolve) => {
        const onError = (e) => {
          resolve(refuse(RUNTIME_CONTRACT_SERVER_CODES.LISTEN_FAILED, `listen 失败：${e?.message ?? String(e)}`, [
            '端口被占用与"没有配端口"是两件事：前者要改端口或停掉占用者',
          ]))
        }
        server.once('error', onError)
        server.listen(port, host, () => {
          server.removeListener('error', onError)
          const addr = server.address()
          bound = { host: addr.address, port: addr.port, family: addr.family }
          resolve(Object.freeze({ ok: true, code: null, message: null, reasons: Object.freeze([]), ...bound }))
        })
      })
    },
    /** 关掉。幂等（已关时直接返回）。 */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) { resolve(false); return }
        try { server.closeAllConnections?.() } catch { /* 老版本没有这个方法 */ }
        server.close(() => resolve(true))
      })
    },
    /** 实际监听地址；没监听时是 `null`。**临时端口（`port: 0`）从这里读回。** */
    address() {
      return bound === null ? null : { ...bound }
    },
    /** 可观测状态：谁在听、鉴权与强制面结论各自配没配。**不含 token 值本身。** */
    state() {
      return Object.freeze({
        listening: server.listening,
        address: bound === null ? null : { ...bound },
        wireVersion: RUNTIME_CONTRACT_WIRE_VERSION,
        tokenConfigured: configuredToken !== null,
        enforcementConfigured: enforcementSource !== null,
        wireChecked: true,
        probed: probeStarted !== null,
      })
    },
    /** 仅测试与诊断用：底层 http.Server。**不要拿它绕过上面的判定。** */
    _httpServer: server,
  })
}
