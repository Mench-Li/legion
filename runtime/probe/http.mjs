// runtime/probe/http.mjs
// ============================================================================
// 真实 HTTP transport（PRT-504）
//
// `createModelProbe` 只要求 transport 是一个"给定档案与凭证，返回归一化观测"
// 的异步函数。这里提供默认的那个实现：向 BYOK endpoint 发一次**最小**请求。
//
// ---------------------------------------------------------------------------
// 为什么用"列模型"而不是"发一次推理"
//
// 两种都验证得了连通性与鉴权，但代价差一个数量级：
//   * 列模型（`GET {endpoint}/v1/models`）—— 几乎不花钱，通常 < 1s；
//   * 最小推理 —— 按 token 计费，且会把一次真实生成记进供应商侧用量。
//
// 配置页上的"测试连接"是用户会**反复点**的按钮。让它每次点都花钱，
// 结果一定是没人敢点——而一个没人敢点的验证按钮等于没有验证。
// 真正要花钱的能力验证（工具调用能否真的跑通）属于 PRT-504 之后的
// 真实运行，不在配置页里做。
//
// ---------------------------------------------------------------------------
// 能力发现必须**有据可依**，否则宁可什么都不说
//
// 供应商的 `/v1/models` 响应格式各家不同，而且大多数**根本不报能力**。
// 这时唯一诚实的答案是"没有证据" —— 返回空能力表，而不是一份猜测。
//
// 猜的代价很具体：猜错成"支持 tools"会让一条依赖工具调用的运行在半途崩；
// 猜错成"不支持"会让一个本来能用的模型被排除在候选链之外。两种都比
// "不知道"更糟，因为"不知道"至少会让调用方去问一次知道的人。
//
// 因此本模块只提取**响应里明确写了**的能力，并且每条都有可追溯的来源。
// ============================================================================

import { MODEL_CAPABILITIES } from '../contracts/model-probe.mjs'

/** 默认的探测路径（OpenAI 兼容）。 */
export const DEFAULT_MODELS_PATH = '/v1/models'

/** 一个"需要管理员声明能力"的显式信号（供调用方决定要不要提示用户）。 */
export const CAPABILITY_EVIDENCE = Object.freeze({
  /** 响应里没有任何能力信息——调用方不该把空表读成"什么都不支持" */
  NONE: 'no-evidence',
  MODEL_LIST: 'model-list',
  SUPPORTED_PARAMETERS: 'supported-parameters',
  ARCHITECTURE: 'architecture',
  CONTEXT_LENGTH: 'context-length',
})

/**
 * 把供应商报的 `supported_parameters`（OpenRouter 风格）映射到封闭能力集。
 * 只映射**已知**的条目；未知条目忽略（不猜）。
 */
const PARAM_TO_CAPABILITY = Object.freeze({
  tools: 'tools',
  tool_choice: 'tools',
  response_format: 'json',
  structured_outputs: 'json',
  json_schema: 'json',
  reasoning: 'reasoning',
  include_reasoning: 'reasoning',
})

/** 长上下文的判定门槛（token）。 */
export const LONG_CONTEXT_MIN_TOKENS = 100_000

/**
 * 从一条模型记录里提取能力证据。返回 `{capabilities, evidence}`。
 *
 * 只做**保守**推断：
 *   - 出现在模型列表里 → `chat`（这是一个聊天/补全模型列表）
 *   - `supported_parameters` 含 tools / response_format / reasoning → 对应能力
 *   - `architecture.input_modalities` 含 `image` → `vision`
 *   - `context_length`/`top_provider.context_length` ≥ 门槛 → `long-context`
 *
 * 任何一条都不成立时**不写任何键**——空表就是"没有证据"。
 */
export function capabilitiesFromModelRecord(record) {
  const caps = {}
  const evidence = []
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { capabilities: caps, evidence }
  }

  // 列表里出现即视为聊天模型
  if (typeof record.id === 'string' && record.id !== '') {
    caps.chat = true
    evidence.push(CAPABILITY_EVIDENCE.MODEL_LIST)
  }

  const params = record.supported_parameters
  if (Array.isArray(params)) {
    let hit = false
    for (const p of params) {
      if (typeof p !== 'string') continue
      const cap = PARAM_TO_CAPABILITY[p]
      if (cap !== undefined) {
        caps[cap] = true
        hit = true
      }
    }
    if (hit) evidence.push(CAPABILITY_EVIDENCE.SUPPORTED_PARAMETERS)
  }

  const modalities = record.architecture?.input_modalities
  if (Array.isArray(modalities) && modalities.some((m) => m === 'image')) {
    caps.vision = true
    evidence.push(CAPABILITY_EVIDENCE.ARCHITECTURE)
  }

  const ctxLen = typeof record.context_length === 'number'
    ? record.context_length
    : typeof record.top_provider?.context_length === 'number' ? record.top_provider.context_length : null
  if (ctxLen !== null && ctxLen >= LONG_CONTEXT_MIN_TOKENS) {
    caps['long-context'] = true
    evidence.push(CAPABILITY_EVIDENCE.CONTEXT_LENGTH)
  }

  // 兜底：只保留封闭集合里的键
  const out = {}
  for (const cap of MODEL_CAPABILITIES) if (caps[cap] === true) out[cap] = true
  return { capabilities: out, evidence }
}

/** 从整个 `/v1/models` 载荷里挑出目标模型那一条。 */
export function findModelRecord(payload, modelId) {
  const list = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : null
  if (list === null) return null
  for (const rec of list) {
    if (rec !== null && typeof rec === 'object' && rec.id === modelId) return rec
  }
  return null
}

/** 载荷里到底有没有一份模型清单——决定"没找到"该不该判失败。 */
export function hasModelList(payload) {
  return Array.isArray(payload?.data) || Array.isArray(payload?.models)
}

/**
 * 创建真实 HTTP transport。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  注入的 fetch（测试与宿主适配用）
 * @param {string}   [opts.modelsPath]
 * @param {boolean}  [opts.verifyModelId] 列表里没有这个 id 时判 `MODEL_NOT_FOUND`
 * @param {Function} [opts.clock]
 */
export function createHttpTransport({
  fetchImpl,
  modelsPath = DEFAULT_MODELS_PATH,
  verifyModelId = true,
  clock = () => Date.now(),
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new TypeError(
      'createHttpTransport 需要一个 fetch 实现（Node 18+ 有全局 fetch）：' +
      '没有它就无法真的发起探测，而"没探测过"不能被当成"可用"',
    )
  }

  return async function httpTransport({ profile, credential }) {
    const startedAtMs = clock()
    const base = String(profile.endpoint ?? '').replace(/\/+$/, '')
    const url = `${base}${modelsPath}`

    const headers = { accept: 'application/json' }
    if (typeof credential === 'string' && credential !== '') {
      headers.authorization = `Bearer ${credential}`
    }

    // 网络层异常**原样抛出**，由执行器的 `normalizeTransportError` 归一化。
    // 在这里自己 try/catch 再映射一次会让分类逻辑存在两份，而两份必然漂移。
    const res = await doFetch(url, { method: 'GET', headers })

    const latencyMs = clock() - startedAtMs
    const status = res.status

    if (status < 200 || status >= 300) {
      // 不读正文：错误正文里可能回显被提交的凭证（部分供应商会这么干），
      // 而这份观测最终会进诊断。分类只需要状态码。
      return { kind: 'http', status, latencyMs }
    }

    let payload = null
    let parseFailed = false
    try {
      payload = await res.json()
    } catch {
      parseFailed = true
    }
    if (parseFailed) {
      // 答了 200 但读不出 JSON（HTML 登录页、被网关改写）→ 这不是一个模型 API
      return { kind: 'parse', latencyMs }
    }

    // 模型可用性验证：清单里有它才算"可用"。
    // 只在载荷**确实是一份清单**时判——否则"没有 data 字段"会被误判成
    // "没有这个模型"，而很多代理只返回单个对象。
    if (verifyModelId && hasModelList(payload)) {
      const rec = findModelRecord(payload, profile.model)
      if (rec === null) {
        return { kind: 'http', status: 404, latencyMs }
      }
      const { capabilities } = capabilitiesFromModelRecord(rec)
      return { kind: 'http', status: 200, latencyMs, capabilities }
    }

    // 没有清单可对：只确认了连通与鉴权，**只报 chat 之外的零证据**
    return { kind: 'http', status: 200, latencyMs, capabilities: {} }
  }
}
