// runtime/contracts/wire.mjs
// ============================================================================
// Runtime Contract 的**线上表示**（PRT-253 跨进程边界）
//
// ## 为什么需要这一层
//
// `runtime/contracts/adapter.mjs` 定义了 `RuntimeAdapter` 的**七个方法形状**，
// 而它是**进程内**的形状：一个对象上有七个函数。部署里 Legion 有两个进程
// （`product/process-manifest.mjs`：`runtime` 与 `orchestrator`），
// 而 worker 在 orchestrator 进程里——它 import 不到 DSH 执行引擎那一侧。
//
//   > 一个"形状定义得很清楚、但只能在同一进程里传递"的契约，
//   > 与一个没有契约的实现，在跨进程部署上是同一个东西。
//
// 本模块就是那七个方法的**线上表示**：路由、载荷、鉴权头、执行流的帧格式，
// 以及**失败语义**。它刻意只做三件事：
//
//   ① 复用 `runtime/contracts/*` 已有的形状（不发明平行的 RunEvent /
//      RunRequest / 错误码 / 能力表）；
//   ② 把"线上怎么传"写成可被两侧同时 import 的常量与纯函数；
//   ③ 把 `execute` 的**失败语义**写成可判定的枚举（见下面 `WIRE_EXECUTE_ENDINGS`）。
//
// ## ★ `execute` 的失败语义（本模块最要紧的一段）
//
// `execute` 是一条流。流会在四种不同的情况下结束，而其中**只有一种**是
// "这次运行成功结束"：
//
//   · `terminal`         —— 对端发来了终态事件（`run.completed` / `run.failed` /
//                           `run.cancelled` / `run.outcome_unknown`）。结论由**终态**
//                           给出，不由"连接正常关闭"给出。
//   · `no-terminal`      —— 对端**正常关闭**了流，却没有给终态。这是协议违规。
//   · `transport-failed` —— 连接中断 / 读失败 / 超时。**这次运行到底发生了什么，
//                           客户端并不知道。**
//   · `malformed-line`   —— 收到一行不是合法 RunEvent 的东西。
//
// 后三种一律让客户端**抛出**，从而让"流断了"与"运行成功"在类型上就分得开：
//
//   > 一个把"连接关闭"读成"运行成功"的客户端，
//   > 与一个把任何结果都读成成功的客户端，在用户看来是同一个东西——
//   > 只不过前者只在网络抖动的那一天出错，而那天没人会去查它。
//
// 特别地：`no-terminal` 与 `transport-failed` **不得**合成一个读数。
// 前者是"对端说完了，但没说结论"（多半是适配器违约），
// 后者是"我们没听完"（多半是网络/进程）。两者的排障方向完全不同。
//
// ## 鉴权
//
// 一个 `authorization: Bearer <token>` 头。契约只定义**怎么传**与**怎么比**
// （`tokensMatch` 用定时安全比较），不定义 token 从哪来——
// 那是部署的事（`LEGION_RUNTIME_TOKEN`），而**本模块不提供任何默认值**。
//
// 唯一允许匿名读的操作是 `getHealth`（见 `WIRE_ANONYMOUS_OPERATIONS`）。
// 它对"这个进程活着吗"给出一个不需要凭证的答案，且**不含**任何
// 模型列表、能力表或运行请求；判据是「读它不需要相信调用方」。
// 其余六个操作、以及 `enforcement` 这个附加端点，一律**必须**凭证。
//
// ## 语言的诚实说明
//
// 本模块在 `runtime/contracts/` 下，因此**必须**是纯模块（不依赖 Cordis/DSH）。
// 它只 import `node:crypto` 与同目录的契约模块——与 `run.mjs` 用 `node:crypto`
// 算幂等键是同一条既有口径。
// ============================================================================

import { timingSafeEqual } from 'node:crypto'

import { ADAPTER_METHODS, RUNTIME_CONTRACT_VERSION } from './adapter.mjs'
import { isKnownEventType, isTerminalEventType, validateRunEvent } from './run.mjs'

/** 线上格式版本。**帧格式或路由语义**变化时递增（与 `RUNTIME_CONTRACT_VERSION` 分开）。 */
export const RUNTIME_CONTRACT_WIRE_VERSION = 1

/** 路由前缀。带版本，于是"路由换了"与"契约换了"可以分别判定。 */
export const WIRE_BASE_PATH = '/legion/runtime/v1'

export const WIRE_JSON_CONTENT_TYPE = 'application/json'

/**
 * `execute` 的帧格式：**NDJSON**——一行一个 RunEvent，行内是 `JSON.stringify(event)`。
 *
 * 为什么是 NDJSON 而不是 SSE / 一个 JSON 数组：
 *   · SSE 需要自己发明 `event:` / `data:` 的映射，而我们要传的对象已经有一个
 *     `type` 字段了——再包一层等于把同一个语义写两遍，两遍迟早不一样；
 *   · 一个 JSON 数组要求"先收完再解析"，于是**流式**这件唯一重要的事没有了：
 *     一次长运行会在最后一次性吐出来，而客户端在此之前无法取消、无法采用量。
 *   · NDJSON 的每一行都能**独立**用 `validateRunEvent` 校验，
 *     于是"这一行坏了"与"这一行晚了"是两个可分辨的读数。
 */
export const WIRE_NDJSON_CONTENT_TYPE = 'application/x-ndjson'

/** 鉴权头（小写，Node 的 `req.headers` 键是小写）。 */
export const WIRE_AUTH_HEADER = 'authorization'

/** 鉴权方案。只认这一个——多认一种就是多一条没被测过的路径。 */
export const WIRE_AUTH_SCHEME = 'Bearer'

/** 请求体上限。超过即 413。它是**防御性**的：没有上限的 JSON body 是一条内存耗尽的入口。 */
export const WIRE_MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * ★ 流内**控制帧**的键。`execute` 的流里除了 RunEvent，只允许这一种帧。
 *
 * ## 为什么需要它（而不是靠 TCP 语义去区分）
 *
 * 头的字节一旦发出去，HTTP 状态码就定死了。此后适配器中途抛错、或事件流
 * 没有终态就结束，服务端**知道**发生了什么，但已经没法用一个状态码说出来。
 * 剩下的选择只有两种，两种都更差：
 *
 *   · `res.end()`：客户端只能读到"干净结束却没有终态"，于是
 *     "适配器中途抛了"与"适配器正常结束但忘了发终态"在读数上同形；
 *   · `res.destroy()`：客户端读到的是**传输失败**，于是
 *     "适配器违约"与"服务端进程崩了/网络断了"同形——
 *     而这两件事的排障方向完全相反。
 *
 * 控制帧把服务端**已经知道**的那件事如实带过去：一条与 RunEvent 不可能混淆的
 * 记录（它没有 `type`，因此 `validateRunEvent` 一定拒绝它），
 * 带上**具名码**。于是四种结束方式各自可分辨，而**没有一种**是"看起来像成功"。
 *
 *   > 服务端知道答案却只肯说"连接断了"，与它不知道答案，对排障的人是同一回事。
 */
export const WIRE_CONTROL_KEY = '__legionWire'

/** 控制帧的种类。目前只有一种：错误。**不预留空种类**。 */
export const WIRE_CONTROL_FRAMES = Object.freeze({
  ERROR: 'error',
})

/**
 * 路由表。
 *
 * `operations` 里有七个名字，**与 `ADAPTER_METHODS` 逐字相同**——这是一条断言，
 * 不是巧合（见下面 `assertWireCoversContract`）。多出来的 `enforcement` 不是
 * `RuntimeAdapter` 的方法，见它的注释。
 */
export const WIRE_ROUTES = Object.freeze({
  getHealth: Object.freeze({ method: 'GET', path: `${WIRE_BASE_PATH}/health`, readonly: true }),
  getCapabilities: Object.freeze({ method: 'GET', path: `${WIRE_BASE_PATH}/capabilities`, readonly: true }),
  listModels: Object.freeze({ method: 'GET', path: `${WIRE_BASE_PATH}/models`, readonly: true }),
  validateProfile: Object.freeze({ method: 'POST', path: `${WIRE_BASE_PATH}/validate-profile`, readonly: true }),
  execute: Object.freeze({ method: 'POST', path: `${WIRE_BASE_PATH}/execute`, readonly: false, streams: true }),
  cancel: Object.freeze({ method: 'POST', path: `${WIRE_BASE_PATH}/cancel`, readonly: false }),
  recover: Object.freeze({ method: 'POST', path: `${WIRE_BASE_PATH}/recover`, readonly: false }),
  /**
   * ★ `enforcement`：**不是** `RuntimeAdapter` 的第八个方法——这一点必须说清。
   *
   * 它要传的是"这个进程里的强制面生效了吗"（`startupSelfCheck` 的结论）。
   * 那件事的权威在 **DSH Runtime 进程**里（组合树 + 沙箱端口都在那边），
   * 而消费它在 **worker 进程**里（`createProductionExecutor` 的 `selfCheck` 接缝）。
   *
   * 为什么不能塞进 `getHealth()`：`RuntimeHealth` 的形状是**冻结**的
   * （`runtimeHealth()` 只产出 state / contractVersion / runtimeVersion / detail /
   * productState），往里加一个 `enforcement` 字段就是改契约形状；
   * 而把结论塞进 `detail` 字符串等于把一个**判定**降级成一句散文——
   * 读它的代码只能靠正则，而正则会在文案改动的当天失效。
   *
   * 所以它是一个**附加端点**，与七个方法同名空间、同鉴权纪律，但语义上属于
   * 「Legion 产品层跨进程搬运自己的强制面结论」，不属于「RuntimeAdapter」。
   * 这个区分让"契约版本变了"与"强制面结论的搬运方式变了"可以分别判定。
   */
  enforcement: Object.freeze({ method: 'GET', path: `${WIRE_BASE_PATH}/enforcement`, readonly: true, adjunct: true }),
})

/** 全部操作名（七个契约方法 + `enforcement`）。 */
export const WIRE_OPERATIONS = Object.freeze(Object.keys(WIRE_ROUTES))

/** 映射到 `RuntimeAdapter` 的七个操作。 */
export const WIRE_ADAPTER_OPERATIONS = Object.freeze(
  WIRE_OPERATIONS.filter((op) => WIRE_ROUTES[op].adjunct !== true),
)

/**
 * 匿名允许的读操作：**只有** `getHealth`。
 *
 * 判断依据是「读它需要相信调用方吗」：
 *   · `getHealth` 返回的是这个进程自己对自己的判断（state + 引擎版本 + 一句 detail），
 *     里面没有模型清单、没有能力表、没有任何一次运行的输入——**没有可被骗的东西**；
 *   · 它在"Runtime 起没起来"这件事上是唯一有用的读数，而 Launcher 的就绪探测
 *     （`product/process-manifest.mjs` 的 `readiness`）恰好要在还没有任何凭证的
 *     时刻问这一句。
 *
 * 其余一切（尤其是 `execute` / `cancel` / `recover`）**永不匿名**：
 * `cancel`/`recover` 能改别的运行的状态，`execute` 会花钱并产生外部副作用。
 */
export const WIRE_ANONYMOUS_OPERATIONS = Object.freeze(['getHealth'])

/**
 * 线上失败码。**服务端产生的**与**客户端判定的**都在这里，
 * 因为它们是同一个协议的两半——分开写会让两侧各有一份"协议"。
 *
 * 命名口径与仓库其余具名码一致：说清是**哪一种处境**，
 * 而不是一句笼统的"请求失败"。它们会被运维与用例跨进程读。
 */
export const WIRE_CODES = Object.freeze({
  // ── 请求形态 ────────────────────────────────────────────────────────────
  /** 请求体不是合法 JSON / 缺少该操作必填的字段。 */
  BAD_REQUEST: 'RUNTIME_CONTRACT_BAD_REQUEST',
  /** 路径不在路由表里。**与"方法不对"分开**：一个是地址写错了，一个是动词写错了。 */
  UNKNOWN_ROUTE: 'RUNTIME_CONTRACT_UNKNOWN_ROUTE',
  /** 路径在，但方法不对（对 `GET` 端点用了 `POST`）。 */
  METHOD_NOT_ALLOWED: 'RUNTIME_CONTRACT_METHOD_NOT_ALLOWED',
  /** 请求体超过 `WIRE_MAX_BODY_BYTES`。 */
  BODY_TOO_LARGE: 'RUNTIME_CONTRACT_BODY_TOO_LARGE',
  // ── 鉴权（两条都必须 fail closed，且必须互相可分）────────────────────────
  /** 服务端**没有**配置 token：所有需要鉴权的操作一律拒绝，且理由与"你给错了"不同。 */
  NO_TOKEN: 'RUNTIME_CONTRACT_NO_TOKEN',
  /** 客户端没有出示凭证，或出示的凭证不匹配。 */
  UNAUTHORIZED: 'RUNTIME_CONTRACT_UNAUTHORIZED',
  // ── 适配器 ──────────────────────────────────────────────────────────────
  /** 适配器自己抛了。**带上它抛的消息**，不吞。 */
  ADAPTER_THREW: 'RUNTIME_CONTRACT_ADAPTER_THREW',
  /** 适配器返回了不符合契约的东西（例如 `execute` 没返回异步可迭代对象）。 */
  ADAPTER_SHAPE_INVALID: 'RUNTIME_CONTRACT_ADAPTER_SHAPE_INVALID',
  /**
   * 服务端在**还没开始写流**之前就发现事件流没有终态。
   *
   * 与 `STREAM_BROKEN` 分开的理由：这一条是"对端说完了但没说结论"，
   * 那一条是"我们没听完"。两者的排障方向不同（前者看适配器，后者看网络与进程）。
   */
  STREAM_NO_TERMINAL: 'RUNTIME_CONTRACT_STREAM_NO_TERMINAL',
  /**
   * 客户端在读流时**传输失败**（连接中断 / 读错误 / 超时）。
   * 这次运行到底发生了什么，**客户端不知道**——绝不可读成成功。
   */
  STREAM_BROKEN: 'RUNTIME_CONTRACT_STREAM_BROKEN',
  /** 客户端读到一行不是合法 RunEvent 的东西。 */
  STREAM_MALFORMED: 'RUNTIME_CONTRACT_STREAM_MALFORMED',
  /** 客户端在终态事件之后又收到了事件（`run.mjs` 的终态契约禁止这样）。 */
  STREAM_AFTER_TERMINAL: 'RUNTIME_CONTRACT_STREAM_AFTER_TERMINAL',
  // ── 传输层（客户端判定）──────────────────────────────────────────────────
  /** 连不上：进程没起、端口没人听、DNS/连接被拒。**与 `NO_TOKEN` 是两件事。** */
  UNREACHABLE: 'RUNTIME_CONTRACT_UNREACHABLE',
  /** 对端答了，但答的不是本协议的东西（非 JSON / `wireVersion` 不对 / 形状不对）。 */
  BAD_RESPONSE: 'RUNTIME_CONTRACT_BAD_RESPONSE',
  /** 客户端自己的接线不对（缺 baseUrl 等）。**不是**对端的问题。 */
  BAD_WIRING: 'RUNTIME_CONTRACT_BAD_WIRING',
  // ── 附加端点 ────────────────────────────────────────────────────────────
  /** 服务端进程里没有强制面结论的来源。**不是**"强制面没生效"，两者必须可分。 */
  ENFORCEMENT_UNAVAILABLE: 'RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE',
})

/**
 * ★ `execute` 的五种结束方式，以及**哪一种允许被读成"有结论"**。
 *
 * 这张表是本文件存在的核心：它把"不把断流读成成功"从一句注释变成一条
 * 可被用例断言的机器事实——`WIRE_ENDING_YIELDS_OUTCOME` 里**恰好一项是 true**。
 *
 *   · `terminal`            唯一一种给出运行结论的方式；
 *   · `noTerminal`          对端正常关闭却没给终态 → 客户端抛 `STREAM_NO_TERMINAL`；
 *   · `transportFailed`     连接中断/读失败 → 客户端抛 `STREAM_BROKEN`；
 *   · `malformedLine`       收到非法行 → 客户端抛 `STREAM_MALFORMED`；
 *   · `eventsAfterTerminal` 终态之后还有事件 → 客户端抛 `STREAM_AFTER_TERMINAL`。
 */
export const WIRE_EXECUTE_ENDINGS = Object.freeze({
  TERMINAL: 'terminal',
  NO_TERMINAL: 'no-terminal',
  TRANSPORT_FAILED: 'transport-failed',
  MALFORMED_LINE: 'malformed-line',
  EVENTS_AFTER_TERMINAL: 'events-after-terminal',
})

/**
 * 只有 `terminal` 允许被读成"这次运行有结论"。
 *
 * 把这张表写成数据而不是写成 `if`，是为了让用例能断言**恰好一项为真**：
 * 一个把 `transport-failed` 也标成 true 的实现，会在那条断言上变红，
 * 而它的其余用例（"运行成功时能拿到 completed"）**全都还是绿的**。
 */
export const WIRE_ENDING_YIELDS_OUTCOME = Object.freeze({
  [WIRE_EXECUTE_ENDINGS.TERMINAL]: true,
  [WIRE_EXECUTE_ENDINGS.NO_TERMINAL]: false,
  [WIRE_EXECUTE_ENDINGS.TRANSPORT_FAILED]: false,
  [WIRE_EXECUTE_ENDINGS.MALFORMED_LINE]: false,
  [WIRE_EXECUTE_ENDINGS.EVENTS_AFTER_TERMINAL]: false,
})

/** 每一种结束方式对应的客户端失败码（`terminal` 没有失败码——它不抛）。 */
export const WIRE_ENDING_FAILURE_CODE = Object.freeze({
  [WIRE_EXECUTE_ENDINGS.TERMINAL]: null,
  [WIRE_EXECUTE_ENDINGS.NO_TERMINAL]: WIRE_CODES.STREAM_NO_TERMINAL,
  [WIRE_EXECUTE_ENDINGS.TRANSPORT_FAILED]: WIRE_CODES.STREAM_BROKEN,
  [WIRE_EXECUTE_ENDINGS.MALFORMED_LINE]: WIRE_CODES.STREAM_MALFORMED,
  [WIRE_EXECUTE_ENDINGS.EVENTS_AFTER_TERMINAL]: WIRE_CODES.STREAM_AFTER_TERMINAL,
})

// ───────────────────────────────────────────────────────────────────────────
// 装载期断言（形状纪律）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 七个契约方法**恰好**等于七个线上操作。
 *
 * 少一个：某个 `RuntimeAdapter` 方法在跨进程时根本传不过去，
 * 而调用方会在 `undefined is not a function` 里发现它——离真因很远。
 * 多一个：线上协议比契约宽，于是"契约没要求的东西"悄悄变成了要求。
 *
 * 这条断言在**装载期**跑（与 `runtime-host-registrar-row.mjs` 的
 * `CAPABILITY_TABLE_CHECKED` 同一手法）：它不依赖任何人记得跑用例。
 */
export function assertWireCoversContract() {
  const missing = ADAPTER_METHODS.filter((m) => !WIRE_ADAPTER_OPERATIONS.includes(m))
  const extra = WIRE_ADAPTER_OPERATIONS.filter((m) => !ADAPTER_METHODS.includes(m))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `wire 路由与 RuntimeAdapter 契约不一致（少：${missing.join(', ') || '无'}；多：${extra.join(', ') || '无'}）。` +
      '少一个会让那个方法在跨进程时不可达，多一个会让线上协议比契约更宽——两者都必须在装载期拦下',
    )
  }
  // 匿名表只能是契约方法的子集，且不得包含任何会改状态的操作。
  for (const op of WIRE_ANONYMOUS_OPERATIONS) {
    if (!WIRE_OPERATIONS.includes(op)) throw new Error(`匿名操作 ${op} 不在路由表里`)
    if (WIRE_ROUTES[op].readonly !== true) throw new Error(`匿名操作 ${op} 不是只读的——匿名只允许只读`)
  }
  for (const op of ['execute', 'cancel', 'recover']) {
    if (WIRE_ANONYMOUS_OPERATIONS.includes(op)) {
      throw new Error(`操作 ${op} 不得匿名：它会花钱、改状态或产生外部副作用`)
    }
  }
  return true
}

/** 装载期结论（`true`；不成立就抛）。 */
export const WIRE_CONTRACT_CHECKED = assertWireCoversContract()

// ───────────────────────────────────────────────────────────────────────────
// 路由与鉴权（纯函数；两侧共用，不各写一份）
// ───────────────────────────────────────────────────────────────────────────

/** 去掉尾斜杠（`/health/` 与 `/health` 是同一个地址；多一条同义路由就多一条没测过的路）。 */
function normalizePath(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return ''
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

/**
 * 把一个请求解析成路由决策。
 *
 * @returns {{kind:'ok', operation:string, route:object}
 *   | {kind:'unknown-route', operation:null}
 *   | {kind:'method-not-allowed', operation:string, allowed:string}}
 */
export function routeFor(method, pathname) {
  const path = normalizePath(pathname)
  const verb = typeof method === 'string' ? method.toUpperCase() : ''
  let pathMatched = null
  for (const operation of WIRE_OPERATIONS) {
    if (WIRE_ROUTES[operation].path !== path) continue
    pathMatched = operation
    if (WIRE_ROUTES[operation].method === verb) {
      return { kind: 'ok', operation, route: WIRE_ROUTES[operation] }
    }
  }
  if (pathMatched === null) return { kind: 'unknown-route', operation: null }
  return { kind: 'method-not-allowed', operation: pathMatched, allowed: WIRE_ROUTES[pathMatched].method }
}

/** 这个操作是否允许匿名。 */
export function isAnonymousOperation(operation) {
  return WIRE_ANONYMOUS_OPERATIONS.includes(operation)
}

/**
 * 解析 `authorization` 头。
 *
 * 只认 `Bearer <token>`。**不**接受裸 token、不接受 `Basic`——
 * 多认一种就多一条在任何地方都没被行使过的路径，而鉴权的每一条路径都必须被测过。
 *
 * @returns {{scheme:string, token:string}|null} 形状不对时返回 `null`（**不是**空串）
 */
export function parseAuthorization(headerValue) {
  if (typeof headerValue !== 'string') return null
  const text = headerValue.trim()
  if (text === '') return null
  const sp = text.indexOf(' ')
  if (sp <= 0) return null
  const scheme = text.slice(0, sp)
  const token = text.slice(sp + 1).trim()
  if (scheme.toLowerCase() !== WIRE_AUTH_SCHEME.toLowerCase()) return null
  if (token === '') return null
  return { scheme, token }
}

/**
 * 定时安全比较。
 *
 * 长度不同时直接返回 `false`：`timingSafeEqual` 要求等长缓冲，
 * 而"长度不同"本身已经泄漏了长度——那是所有 bearer 比较都有的性质，
 * 不是这里引入的。长度**相同**时用定时安全比较，避免逐字节提前返回。
 */
export function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  if (presented === '' || expected === '') return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ───────────────────────────────────────────────────────────────────────────
// 信封（请求 / 响应）
// ───────────────────────────────────────────────────────────────────────────

/** 成功信封。`{ok:true, wireVersion, result}`。 */
export function wireSuccess(result, wireVersion = RUNTIME_CONTRACT_WIRE_VERSION) {
  return Object.freeze({ ok: true, wireVersion, result })
}

/** 拒绝信封。`{ok:false, wireVersion, code, message, details}`。 */
export function wireRefusal(code, message, details = null) {
  return Object.freeze({
    ok: false,
    wireVersion: RUNTIME_CONTRACT_WIRE_VERSION,
    code: String(code),
    message: String(message ?? ''),
    ...(details === null || details === undefined ? {} : { details }),
  })
}

/** 请求信封。POST 操作的 body 一律是 `{wireVersion, ...}`。 */
export function wireRequest(payload = {}, wireVersion = RUNTIME_CONTRACT_WIRE_VERSION) {
  return { wireVersion, ...payload }
}

/**
 * 检查一个**请求**信封（`{wireVersion, ...}`）。
 *
 * `wireVersion` 不匹配时具名拒绝，而不是"尽力解析"：
 * 一个版本对不上的请求里，字段的含义可能已经变了——
 * 猜着读会让一次协议升级表现成"运行时给了一个奇怪的答案"。
 */
export function readRequestEnvelope(body) {
  const version = body?.wireVersion
  if (version !== RUNTIME_CONTRACT_WIRE_VERSION) {
    return {
      ok: false,
      code: WIRE_CODES.BAD_REQUEST,
      message: `请求信封的 wireVersion 是 ${JSON.stringify(version)}，本服务端说 ${RUNTIME_CONTRACT_WIRE_VERSION}`,
    }
  }
  return { ok: true }
}

/**
 * 检查一个**响应**信封是不是本协议的东西。
 *
 * `wireVersion` 不匹配时判 `BAD_RESPONSE` 而不是"尽力解析"：
 * 一个版本对不上的响应里，字段的含义可能已经变了——
 * 猜着读会让一次协议升级表现成"运行时给了一个奇怪的答案"。
 */
export function readEnvelope(body) {
  const version = body?.wireVersion
  if (version !== RUNTIME_CONTRACT_WIRE_VERSION) {
    return {
      ok: false,
      code: WIRE_CODES.BAD_RESPONSE,
      message: `响应信封的 wireVersion 是 ${JSON.stringify(version)}，本客户端说 ${RUNTIME_CONTRACT_WIRE_VERSION}`,
    }
  }
  if (body?.ok === true) return { ok: true, result: body.result }
  if (body?.ok === false) {
    return {
      ok: false,
      code: typeof body.code === 'string' && body.code !== '' ? body.code : WIRE_CODES.BAD_RESPONSE,
      message: typeof body.message === 'string' ? body.message : '',
      details: body.details ?? null,
    }
  }
  return { ok: false, code: WIRE_CODES.BAD_RESPONSE, message: '响应信封没有布尔字段 ok' }
}

// ───────────────────────────────────────────────────────────────────────────
// NDJSON 帧
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把一个 RunEvent 编码成一行。
 *
 * **发之前先校验**：一个发不出去的坏事件，不能让对端在解析时才看到——
 * 那时"引擎发了个畸形事件"会表现成"客户端读流失败"，把排障指向网络。
 * 校验失败时**抛**（由调用方决定怎么终止流），不静默换一个空行。
 */
export function encodeEventLine(event) {
  const check = validateRunEvent(event)
  if (!check.ok) {
    const err = new Error(`RunEvent 不合法，拒绝编码：${check.errors.join('；')}`)
    err.code = WIRE_CODES.ADAPTER_SHAPE_INVALID
    err.errors = check.errors
    throw err
  }
  return `${JSON.stringify(event)}\n`
}

/**
 * 解码一行。空行返回 `{ok:true, empty:true}`——尾随换行是 NDJSON 的正常现象，
 * **不是**一条坏事件，也不是一条事件。
 *
 * 控制帧（`__legionWire`）**不是**事件：返回 `{ok:false, control:frame}`，
 * 由调用方按它自己的码处理。把它当成事件解析会得到一句"未知事件类型"，
 * 而那会丢掉服务端真正想说的那个码。
 */
export function decodeEventLine(line) {
  const text = typeof line === 'string' ? line : String(line ?? '')
  const trimmed = text.endsWith('\r') ? text.slice(0, -1) : text
  if (trimmed.trim() === '') return { ok: true, empty: true, event: null, errors: [] }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, empty: false, event: null, errors: [`不是合法 JSON：${e?.message ?? String(e)}`] }
  }
  if (isControlFrame(parsed)) return { ok: false, empty: false, event: null, control: parsed, errors: [] }
  const check = validateRunEvent(parsed)
  if (!check.ok) return { ok: false, empty: false, event: null, errors: check.errors }
  return { ok: true, empty: false, event: parsed, errors: [] }
}

/** 这一帧是不是控制帧。 */
export function isControlFrame(frame) {
  return frame !== null && typeof frame === 'object' && typeof frame[WIRE_CONTROL_KEY] === 'string'
}

/** 编码一条错误控制帧。`code` 必须是 `WIRE_CODES` 里登记过的码。 */
export function encodeControlFrame(code, message, details = null) {
  const known = Object.values(WIRE_CODES)
  if (!known.includes(code)) {
    throw new Error(`控制帧使用了未登记的码：${String(code)}`)
  }
  return `${JSON.stringify({
    [WIRE_CONTROL_KEY]: WIRE_CONTROL_FRAMES.ERROR,
    code,
    message: String(message ?? ''),
    ...(details === null || details === undefined ? {} : { details }),
  })}\n`
}

/** 这个事件是不是终态。转发契约的判定，**不在这里再抄一遍那四个字符串**。 */
export function isWireTerminalEvent(event) {
  return event !== null && typeof event === 'object' && isTerminalEventType(event.type)
}

/** 事件类型是不是契约里登记过的。 */
export function isWireKnownEventType(type) {
  return isKnownEventType(type)
}

/** 契约主版本（转发，供线上握手打印用）。 */
export const WIRE_CONTRACT_VERSION = RUNTIME_CONTRACT_VERSION
