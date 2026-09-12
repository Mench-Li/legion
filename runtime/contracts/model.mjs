// runtime/contracts/model.mjs
// ============================================================================
// 模型档案与可用模型描述（PRT-102）
//
// 纯模块，不依赖 Cordis/DSH。Team-hub 只保存**非敏感**模型配置与 secretRef；
// 明文密钥永远不进入业务库（spec §6.7）。
//
// 这里刻意把「拒绝明文密钥」做成**结构化校验**而不是文档约定：
// spec §3.1 把「模型密钥不进入提示词、业务数据库正文、日志、导出证据或能力包」
// 列为产品目标，靠评审纪律守不住，必须让写入路径直接拒绝。
// ============================================================================

/** 模型档案中允许出现的字段。未知字段一律拒绝——避免密钥搭便车。 */
export const MODEL_PROFILE_FIELDS = Object.freeze([
  'id',
  'displayName',
  'runtimeType',
  'provider',
  'model',
  'endpoint',
  'secretRef',
  'reasoningEffort',
  'limits',
])

/** 推测为「明文密钥载体」的字段名（大小写与分隔符无关）。 */
const SECRET_LIKE_KEY_RE =
  /(api[-_]?key|apikey|secret|password|passwd|token|credential|bearer|private[-_]?key|access[-_]?key)/i

/** 密钥值形态：常见真实密钥前缀，用于抓「值写在 id/endpoint 里」的走私。 */
const SECRET_VALUE_PATTERNS = Object.freeze([
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^gho_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^AIza[0-9A-Za-z_-]{30,}$/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
])

/** secretRef 允许的形态：本机密钥库引用，不是密钥本身。 */
const SECRET_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

/**
 * 递归查找疑似明文密钥。返回命中的路径列表（空数组表示干净）。
 * 导出供 team-hub 写入路径与导出/诊断包路径**共用同一判据**，避免两处漂移。
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function findPlaintextSecrets(value, path = '$') {
  const hits = []
  if (value === null || value === undefined) return hits
  if (typeof value === 'string') {
    for (const re of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) {
        hits.push(path)
        break
      }
    }
    return hits
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findPlaintextSecrets(v, `${path}[${i}]`)))
    return hits
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const child = `${path}.${k}`
      // 键名像密钥载体，且值**是字符串** → 直接判定。
      //
      // 「值是字符串」这个附加条件不是放宽，是修正：密钥永远是字符串，
      // 而 `maxTokens` / `tokenLimit` / `maxOutputTokens` 这类**限额字段**
      // 天然含 "token" 一词。此前它们一律被判成"检测到疑似明文密钥"，
      // 于是任何带 token 限额的模型档案**根本写不进去**——
      // 报的还是一句"检测到疑似明文密钥：$.limits.maxTokens"，
      // 而那里一个密钥都没有。这是把正常配置报成安全事故。
      //
      // 递归仍在下面照常进行：键名像密钥而值是对象时（`{ token: { a: 1 } }`），
      // 真正的字符串密钥会在更深处被键名或形态规则抓到，不需要靠这一条兜。
      if (SECRET_LIKE_KEY_RE.test(k) && typeof v === 'string' && v !== '') {
        const isRefField = /ref$/i.test(k)
        if (!isRefField) hits.push(child)
      }
      hits.push(...findPlaintextSecrets(v, child))
    }
    return hits
  }
  return hits
}

/**
 * 校验 ModelProfile。
 *
 * @param {object} profile
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validateProfile(profile) {
  const errors = []
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, errors: ['profile 必须是对象'], value: null }
  }

  // 1) 未知字段：拒绝而非忽略。忽略会让密钥字段被静默写进库。
  for (const key of Object.keys(profile)) {
    if (!MODEL_PROFILE_FIELDS.includes(key)) {
      errors.push(`未知字段 ${key}：模型档案只接受受控字段，避免密钥搭便车`)
    }
  }

  // 2) 明文密钥门禁
  const secretHits = findPlaintextSecrets(profile)
  if (secretHits.length > 0) {
    errors.push(`检测到疑似明文密钥：${secretHits.join(', ')}。只允许保存 secretRef 引用`)
  }

  // 3) 必填与形态
  const requireString = (key) => {
    const v = profile[key]
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`${key} 必填且必须是非空字符串`)
      return null
    }
    return v.trim()
  }
  const id = requireString('id')
  const displayName = requireString('displayName')
  const runtimeType = requireString('runtimeType')
  const provider = requireString('provider')
  const model = requireString('model')

  if (id !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    errors.push('id 只允许字母数字与 . _ -，长度 1..64')
  }

  // endpoint 可选；给出时必须是无凭证的 http(s) URL
  let endpoint = null
  if (profile.endpoint !== undefined && profile.endpoint !== null && profile.endpoint !== '') {
    endpoint = requireString('endpoint')
    if (endpoint !== null) {
      let parsed = null
      try {
        parsed = new URL(endpoint)
      } catch {
        errors.push('endpoint 必须是合法 URL')
      }
      if (parsed !== null) {
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          errors.push('endpoint 只允许 http/https')
        }
        // URL 里内嵌凭证是密钥走私的常见形态（https://user:pass@host）
        if (parsed.username !== '' || parsed.password !== '') {
          errors.push('endpoint 不得内嵌用户名或密码，请改用 secretRef')
        }
      }
    }
  }

  // secretRef 可选（本地模型可无凭证），给出时必须是引用形态
  let secretRef = null
  if (profile.secretRef !== undefined && profile.secretRef !== null && profile.secretRef !== '') {
    secretRef = requireString('secretRef')
    if (secretRef !== null && !SECRET_REF_RE.test(secretRef)) {
      errors.push('secretRef 必须是本机密钥库引用名，不得包含空格或密钥内容')
    }
  }

  // reasoningEffort 可选
  if (
    profile.reasoningEffort !== undefined &&
    profile.reasoningEffort !== null &&
    ![ 'low', 'medium', 'high' ].includes(profile.reasoningEffort)
  ) {
    errors.push('reasoningEffort 只允许 low / medium / high')
  }

  // limits 可选，给定时字段必须是正有限数
  let limits = null
  if (profile.limits !== undefined && profile.limits !== null) {
    if (typeof profile.limits !== 'object' || Array.isArray(profile.limits)) {
      errors.push('limits 必须是对象')
    } else {
      limits = {}
      for (const [k, v] of Object.entries(profile.limits)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          errors.push(`limits.${k} 必须是正的有限数`)
        } else {
          limits[k] = v
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, value: null }

  return {
    ok: true,
    errors: [],
    value: Object.freeze({
      id,
      displayName,
      runtimeType,
      provider,
      model,
      endpoint,
      secretRef,
      reasoningEffort: profile.reasoningEffort ?? 'medium',
      limits: limits === null ? Object.freeze({}) : Object.freeze(limits),
    }),
  }
}

/** ValidationResult：连通性/能力验证的返回形态（`validateProfile` 的运行时版本）。 */
export function validationResult({ ok, code = null, message = '', latencyMs = null, capabilities = null }) {
  return Object.freeze({
    ok: ok === true,
    code: ok === true ? null : code,
    message: String(message ?? ''),
    latencyMs: typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? latencyMs : null,
    capabilities: capabilities === null || capabilities === undefined ? null : Object.freeze({ ...capabilities }),
  })
}

/**
 * 把 ModelProfile 归一化为 ModelDescriptor（对外只读描述，绝不含 secretRef 值）。
 * 产品配置要展示给用户与写进审计，这里保证 secretRef **只以引用的存在性**出现。
 */
export function toModelDescriptor(profile) {
  const res = validateProfile(profile)
  if (!res.ok) {
    throw new Error(`无法转换非法 ModelProfile：${res.errors.join('; ')}`)
  }
  const p = res.value
  return Object.freeze({
    id: p.id,
    displayName: p.displayName,
    runtimeType: p.runtimeType,
    provider: p.provider,
    model: p.model,
    endpoint: p.endpoint,
    reasoningEffort: p.reasoningEffort,
    limits: p.limits,
    // 只暴露「有没有引用」，不暴露引用名本身——引用名也是可枚举的攻击面
    hasCredential: p.secretRef !== null,
  })
}
