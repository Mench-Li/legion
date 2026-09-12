// runtime/contracts/model-probe.mjs
// ============================================================================
// 模型连通性与能力测试（PRT-504，spec §6.6 第 402 行 / §6.7 第 423 行）
//
// 纯模块：只有分类、判定与缓存策略，**不做任何 I/O**。
// 真正发请求的是 `runtime/probe/index.mjs`（可注入 transport），
// 这样"怎么算可用"与"怎么问供应商"可以分别测试。
//
// ---------------------------------------------------------------------------
// 为什么"连通性"必须与"可用性"和"能力"分开
//
// 三件不同的事，回答的问题完全不同：
//   连通性  — 能不能把包送到对端？（DNS / TCP / TLS）
//   可用性  — 对端认不认这把钥匙、认不认这个模型 id？（鉴权 / 模型存在）
//   能力    — 这个模型能不能做这次任务需要它做的事？（tools / vision / json…）
//
// 把它们合成一个"可不可用"的布尔值会造成两类具体故障：
//   * 一个 TCP 握手成功被当成"模型可用"，于是一次真实的运行在**第一次推理**时
//     才失败——那时已经认领了任务、烧掉一次尝试；
//   * 一个连得上、认得钥匙、但**不支持 tools** 的模型被判定为可用，
//     于是整条依赖工具调用的运行会在中途崩，而配置页显示"通过"。
//
// 这正是仓库里已有的那条纪律在这里的形态：**"接得通 ≠ 能用"**。
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// 为什么 SECRET_UNAVAILABLE 与 AUTH_FAILED 必须分开（spec §6.7 第 423 行）
//
// 两者的**修复动作完全不同**：
//   SECRET_UNAVAILABLE — 本地凭证库/账户问题。钥匙可能就在这台机器上，
//                        只是解不开（DPAPI 换了用户、keyring 损坏、ACL 变了）。
//                        下一动作：查本机密钥库，**不要**去供应商控制台换钥匙。
//   AUTH_FAILED        — 钥匙**成功解析**了，供应商明确拒绝。
//                        下一动作：换钥匙或查权限，本机密钥库是好的。
//
// 混成一类会产生一个很贵的误导：运维拿着"鉴权失败"去供应商控制台轮换一把
// 好钥匙，而真实原因是本机 DPAPI 换了账户作用域——新钥匙同样解不开，
// 而这次连"解不开"这个线索也被一次无关的轮换掩盖了。
// ============================================================================

/**
 * 探测结果码。`ok` 不是失败码——失败码的集合是封闭的。
 * `UNCLASSIFIED` 刻意存在：见 `classifyFailure`。
 */
export const PROBE_CODES = Object.freeze([
  'SECRET_UNAVAILABLE',
  'SECRET_REF_MISSING',
  'AUTH_FAILED',
  'ENDPOINT_UNREACHABLE',
  'TLS_FAILED',
  'RATE_LIMITED',
  'MODEL_NOT_FOUND',
  'PROVIDER_ERROR',
  'BAD_RESPONSE',
  'TIMEOUT',
  'CAPABILITY_MISSING',
  'UNCLASSIFIED',
])

/**
 * 失败**处置类别**。调用方的下一动作由它决定，而不是由具体码决定。
 *
 *   fail-closed — 本地就绪性问题，必须停下并让人处理（不许绕过、不许重试）
 *   config      — 配置写错了，改配置（重试没有意义：同样会失败）
 *   transient   — 对端暂时不行，稍后重试有意义
 *   unknown     — 分类不出来。**不得当作可用**，也不得静默重试。
 */
export const PROBE_CLASSES = Object.freeze(['fail-closed', 'config', 'transient', 'unknown'])

/**
 * 码 → 类别。**全定义**（每个码都有键）。
 *
 * 缺键会让 `PROBE_CODE_CLASS[code]` 是 `undefined`，而 `undefined` 在
 * 判断里通常是 falsy——于是"这个码我没想过"会静默退化成某个默认行为。
 * 有一条用例断言这里与 `PROBE_CODES` 一一对应。
 */
export const PROBE_CODE_CLASS = Object.freeze({
  // 本地凭证库/账户：fail closed，且**不许重试**（重试不会让 DPAPI 解开）
  SECRET_UNAVAILABLE: 'fail-closed',
  // 档案声明要凭证但没给 secretRef：配置问题（本地模型可以合法地没有凭证，
  // 那种情况不会走到这里——不带凭证去请求，供应商会回 401）
  SECRET_REF_MISSING: 'config',
  // 钥匙解析成功但被拒绝：配置/授权问题
  AUTH_FAILED: 'config',
  // 送不到：可能对端挂了，也可能是本机 DNS/代理——按 transient 处理，
  // 因为重试一次的成本远低于让运维立刻介入
  ENDPOINT_UNREACHABLE: 'transient',
  // TLS 失败**不**按 transient：证书问题重试一百次也一样。
  // 而且它是本机信任链/中间人的信号，值得有人看一眼。
  TLS_FAILED: 'config',
  RATE_LIMITED: 'transient',
  PROVIDER_ERROR: 'transient',
  TIMEOUT: 'transient',
  // 对端好好的，只是不认这个 id → 改配置
  MODEL_NOT_FOUND: 'config',
  // 答了，但答的东西不像一个模型 API（返回 HTML 登录页、返回别的协议）
  // → 多半 endpoint 写错了，改配置
  BAD_RESPONSE: 'config',
  // 连得上、认钥匙、但不具备所需能力 → 换模型（改配置）
  CAPABILITY_MISSING: 'config',
  // 分不出来。既不许当可用，也不许静默重试。
  UNCLASSIFIED: 'unknown',
})

/**
 * 能力项。封闭集合——开放集合会让"要求了某个能力"与"供应商报的能力"
 * 无法比较（拼写不同就永远不匹配，而界面看起来两边都写了）。
 */
export const MODEL_CAPABILITIES = Object.freeze([
  'chat',
  'tools',
  'vision',
  'json',
  'long-context',
  'reasoning',
])

/** 判定的成功/失败码。 */
export const PROBE_VERDICT_CODES = Object.freeze(['OK', ...PROBE_CODES])

/**
 * 成功探测的缓存时长。探测要花钱花时间（一次最小推理），
 * 所以成功结果可以复用；但**不能永久复用**——钥匙可能被撤销。
 */
export const PROBE_TTL_MS = 5 * 60 * 1000

/**
 * 失败探测的缓存时长，**刻意短于**成功。
 *
 * 对称缓存会带来一个具体的坏体验：11:00 供应商抖了一下，探测失败并被缓存
 * 一小时；11:05 供应商恢复了，而配置页在整个小时内持续显示"连不上"，
 * 用户于是去改一个根本没问题的 endpoint。
 *
 * 失败缓存的意义只是"别让一个坏配置把探测按钮打成 DDoS"，
 * 30 秒足够，不需要一小时。
 */
export const NEGATIVE_PROBE_TTL_MS = 30 * 1000

/** 把任意输入收敛为一个有限非负数；不是数时返回 null。 */
function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * 由 HTTP 状态码得出失败码。
 *
 * 401/403 → `AUTH_FAILED`：**这是 supplier 拒绝了已经解析成功的凭证**。
 *           调用方必须已经拿到凭证才会走到这里（`resolveSecret` 成功），
 *           所以这里报 AUTH_FAILED 是对的，而不是 SECRET_UNAVAILABLE。
 * 404     → `MODEL_NOT_FOUND`：多数供应商用 404 表示"没有这个模型 id"。
 * 408/504 → `TIMEOUT`
 * 429     → `RATE_LIMITED`
 * 5xx     → `PROVIDER_ERROR`
 * 其余 4xx → `BAD_RESPONSE`（请求本身不对，改配置）
 * 非 3 位数 → `UNCLASSIFIED`
 */
export function classifyHttpStatus(status) {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return 'UNCLASSIFIED'
  }
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'PROVIDER_ERROR'
  if (status >= 400) return 'BAD_RESPONSE'
  // 2xx/3xx 不是失败；调用方不该拿成功状态码来分类
  return 'UNCLASSIFIED'
}

/**
 * 由"传输层出错的形态"得出失败码。
 *
 * 输入刻意是**归一化后的事实**（`kind` / `status` / `tls`），不是异常对象本身——
 * 异常对象的形状随 Node 版本与 fetch 实现变化，而分类是契约。
 *
 * `kind` 取值：
 *   'http'      — 拿到了响应，看 `status`
 *   'connect'   — 连不上（DNS / ECONNREFUSED / 建连超时）
 *   'timeout'   — 连上了但没在期限内答完
 *   'tls'       — TLS/证书失败
 *   'abort'     — 被主动取消（**不算失败分类**：调用方自己取消的）
 *   'parse'     — 答了但读不出来（不是 JSON、被截断）
 *   'unknown'   — 其它
 *
 * 返回 `null` 表示"这不是一次失败"（只有 'abort' 会走到这里，因为主动取消
 * 需要一个**单独**的表达，不能和"连不上"混在一起）。
 */
export function classifyFailure({ kind, status } = {}) {
  switch (kind) {
    case 'http':
      return classifyHttpStatus(status)
    case 'connect':
      return 'ENDPOINT_UNREACHABLE'
    case 'tls':
      return 'TLS_FAILED'
    case 'timeout':
      return 'TIMEOUT'
    case 'parse':
      return 'BAD_RESPONSE'
    case 'abort':
      // 主动取消不是供应商的问题，也不是配置的问题。
      // 用 `null` 把它从失败分类里**摘出去**——把它硬塞进某个码
      // 会让取消看起来像一次故障，而取消是正常动作。
      return null
    case 'unknown':
    default:
      return 'UNCLASSIFIED'
  }
}

/** 取一个码的处置类别。未知码 → 'unknown'（**不**默认成 transient）。 */
export function probeClassOf(code) {
  const cls = PROBE_CODE_CLASS[code]
  return cls === undefined ? 'unknown' : cls
}

/**
 * 归一化供应商自报的能力表。
 *
 * 只保留 `MODEL_CAPABILITIES` 里认识的项，值一律 `=== true` 才算具备
 * （供应商常写 `"tools": "yes"` / `1` / `"true"`——这些都**不算**具备：
 * 能力声明是配置判断的依据，模糊为真会让一个其实不支持的模型被选进链）。
 * 返回冻结对象；未列出的能力**不在**对象里（不是 `false`）——
 * "没声明"与"声明为否"在诊断上必须能分开。
 */
export function normalizeCapabilities(raw) {
  const out = {}
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze(out)
  }
  for (const cap of MODEL_CAPABILITIES) {
    if (raw[cap] === true) out[cap] = true
  }
  return Object.freeze(out)
}

/** 校验一个"要求能力"列表。返回 {ok, errors, value}。 */
export function validateRequiredCapabilities(required) {
  if (required === undefined || required === null) return { ok: true, errors: [], value: [] }
  if (!Array.isArray(required)) return { ok: false, errors: ['requiredCapabilities 必须是数组'], value: null }
  const errors = []
  const seen = []
  for (const cap of required) {
    if (typeof cap !== 'string' || !MODEL_CAPABILITIES.includes(cap)) {
      errors.push(`未知能力 ${JSON.stringify(cap)}：只接受 ${MODEL_CAPABILITIES.join(' / ')}`)
      continue
    }
    // 重复要求会报出两条"缺同一个能力"，读起来像缺两样东西
    if (!seen.includes(cap)) seen.push(cap)
  }
  if (errors.length > 0) return { ok: false, errors, value: null }
  return { ok: true, errors: [], value: Object.freeze(seen) }
}

/**
 * 由一次探测的**观测结果**得出判定。
 *
 * `observed` 的形态：
 *   { ok: true,  latencyMs, capabilities, modelEcho? }
 *   { ok: false, code, message, latencyMs? }
 *
 * `required` 是这次任务需要的能力（来自员工/任务配置）。
 *
 * 判定规则（顺序重要）：
 *   1. 观测失败 → 直接失败，带上它的码与类别。**不去看能力**：
 *      一个连不上的模型"具不具备 tools"没有意义，报"缺 tools"会把
 *      真正的问题（连不上）盖掉。
 *   2. 观测成功但缺所需能力 → `CAPABILITY_MISSING`，并把**缺哪些**列出来。
 *   3. 观测成功且能力齐 → OK。
 *
 * 返回的 `capabilities` 一律是归一化后的对象，未声明就不在里面。
 */
export function evaluateProbe({ observed, required } = {}) {
  const req = validateRequiredCapabilities(required)
  if (!req.ok) {
    return Object.freeze({
      ok: false,
      code: 'UNCLASSIFIED',
      class: 'unknown',
      message: `无法判定：${req.errors.join('；')}`,
      missingCapabilities: Object.freeze([]),
      capabilities: Object.freeze({}),
      latencyMs: null,
    })
  }
  if (observed === null || typeof observed !== 'object') {
    return Object.freeze({
      ok: false,
      code: 'UNCLASSIFIED',
      class: 'unknown',
      message: '无法判定：探测没有产出观测结果',
      missingCapabilities: Object.freeze([]),
      capabilities: Object.freeze({}),
      latencyMs: null,
    })
  }

  const latencyMs = finiteOrNull(observed.latencyMs)

  if (observed.ok !== true) {
    const code = typeof observed.code === 'string' && observed.code !== '' ? observed.code : 'UNCLASSIFIED'
    const cls = probeClassOf(code)
    return Object.freeze({
      ok: false,
      code,
      class: cls,
      message: String(observed.message ?? '') || defaultProbeMessage(code),
      missingCapabilities: Object.freeze([]),
      capabilities: normalizeCapabilities(observed.capabilities),
      latencyMs,
    })
  }

  const capabilities = normalizeCapabilities(observed.capabilities)
  const missing = req.value.filter((cap) => capabilities[cap] !== true)
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      code: 'CAPABILITY_MISSING',
      class: probeClassOf('CAPABILITY_MISSING'),
      message:
        `模型可用，但缺少本次任务需要的能力：${missing.join(' / ')}。` +
        `它自报具备的是：${Object.keys(capabilities).join(' / ') || '（无）'}`,
      missingCapabilities: Object.freeze(missing),
      capabilities,
      latencyMs,
    })
  }

  return Object.freeze({
    ok: true,
    code: 'OK',
    class: null,
    message: `连通且具备所需能力${req.value.length > 0 ? `（${req.value.join(' / ')}）` : ''}`,
    missingCapabilities: Object.freeze([]),
    capabilities,
    latencyMs,
  })
}

/** 各码的默认可操作说明。全定义——缺一个会让失败只剩一个代号。 */
const DEFAULT_MESSAGES = Object.freeze({
  SECRET_UNAVAILABLE: '无法访问或解密本机凭证库（不是供应商的问题）：请检查密钥库与当前 Windows 账户作用域，不要去供应商控制台换钥匙',
  SECRET_REF_MISSING: '该模型档案声明需要凭证，但没有 secretRef：请补上引用名，或明确它是一个无需凭证的本地模型',
  AUTH_FAILED: '凭证已成功解析，但供应商拒绝：请更换密钥或检查该密钥的权限（本机密钥库是好的）',
  ENDPOINT_UNREACHABLE: '送不到 endpoint：请检查地址、DNS 与本机代理设置',
  TLS_FAILED: 'TLS/证书校验失败：请检查证书与中间人代理（重试不会改变结果）',
  RATE_LIMITED: '供应商限流：稍后重试',
  MODEL_NOT_FOUND: '供应商不认这个模型标识：请核对模型 id',
  PROVIDER_ERROR: '供应商侧错误：稍后重试',
  BAD_RESPONSE: '对端有响应但不像一个模型 API：请核对 endpoint 与协议',
  TIMEOUT: '在期限内没有答完：稍后重试',
  CAPABILITY_MISSING: '模型可用但缺少所需能力：请换一个模型，或降低本次任务的能力要求',
  UNCLASSIFIED: '无法归类这次失败：请查看原始诊断（不要当作可用，也不要静默重试）',
})

export function defaultProbeMessage(code) {
  return DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES.UNCLASSIFIED
}

/**
 * 探测指纹：回答"这一份判定是针对**哪一套配置**做的"。
 *
 * 缓存必须按它分桶。少了它就会出现：给模型 A 探测成功，然后把档案改成
 * 模型 B（同一个 id），于是界面拿着 A 的"通过"给 B 用——
 * 一次从未发生过的成功变成了一条可用性证明。
 *
 * 只取**会改变连通性结果**的字段：id 不参与（同一个 id 改配置必须让缓存失效，
 * 所以配置本身进指纹；id 只用于分桶）。
 * 刻意**不含 secretRef 的值**——引用名会随轮换改变，但轮换**不应**让
 * 一次刚刚完成的探测失效（轮换后必须重新探测的判断由 PRT-509 的轮换流程负责）。
 */
export function probeFingerprint(profile) {
  if (profile === null || typeof profile !== 'object') return 'invalid'
  const parts = [
    String(profile.provider ?? ''),
    String(profile.model ?? ''),
    String(profile.endpoint ?? ''),
    String(profile.runtimeType ?? ''),
    // `secretRef` **的引用名**参与：从"有凭证"改成"无凭证"必须让缓存失效。
    // 但只有名字，没有值——值从来不在档案里。
    profile.secretRef === null || profile.secretRef === undefined ? '' : String(profile.secretRef),
    String(profile.reasoningEffort ?? ''),
  ]
  return parts.join('\u0000')
}

/**
 * 一条缓存记录是否还可以用。
 *
 * `ttlMs` 由调用方按成功/失败分别给（见 `ttlForVerdict`）。
 * 时间倒流（`nowMs < probedAtMs`）按**不新鲜**处理：系统时钟被改回去时，
 * 一份"来自未来"的缓存没有可信的年龄，继续用它等于拿未知年龄的判定下判断。
 */
export function isProbeFresh({ entry, nowMs, ttlMs } = {}) {
  if (entry === null || typeof entry !== 'object') return false
  const at = finiteOrNull(entry.probedAtMs)
  const now = finiteOrNull(nowMs)
  const ttl = finiteOrNull(ttlMs)
  if (at === null || now === null || ttl === null) return false
  if (now < at) return false
  return now - at < ttl
}

/** 按判定结果给缓存时长：失败用更短的那个。 */
export function ttlForVerdict(verdict, { ttlMs = PROBE_TTL_MS, negativeTtlMs = NEGATIVE_PROBE_TTL_MS } = {}) {
  if (verdict !== null && typeof verdict === 'object' && verdict.ok === true) return ttlMs
  // 分不出来的失败也别缓存太久：一个 UNCLASSIFIED 不该被当成"已知的坏"
  // 而在半小时内阻止一次本来会成功的重试。
  return Math.min(negativeTtlMs, positiveOrZero(negativeTtlMs))
}

function positiveOrZero(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}
