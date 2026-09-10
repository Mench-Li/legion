// ⚠️ 本文件是同步副本，请勿直接编辑。
// 唯一实现：packages/shared/src/config.mjs
// 同步命令：node scripts/config/sync.mjs        校验：node scripts/config/sync.mjs --check
// ---- 以下内容与根实现逐字节一致 ----
// config.mjs — 统一配置引擎（P3-2）
//
// 定位：**声明式配置面**的唯一实现。三进程（team-hub / workbench / whiteboard）各自声明 schema，
// 由本引擎完成：默认值 → 环境变量 → 命令行参数的合并、类型与范围校验、脱敏、启动摘要。
//
// 设计取舍（与 P3-2 决策一致）：
//   · 不引入配置文件：环境变量/CLI 仍是唯一注入面，运行时语义零变更，部署零风险。
//   · 优先级固定为 **CLI > env > default**，且解析结果带 sources，能回答「这个值从哪来」。
//   · 校验失败**不静默回退**：非法值进 errors（启动时报错退出），缺省值才回退 default。
//   · 脱敏是引擎职责而非调用方职责：secret 字段只以 `***`+长度提示出现，任何摘要/日志都走同一条路径。
//   · 动态 env 读取（`process.env[name]`）与「疑似 env 字面量」需在 schema 中显式登记，
//     由 scripts/config/scan.mjs --check 强制（防止配置偷偷长出来却不可见）。
//
// 本文件是纯数据和纯函数，无副作用、无 Node 专有依赖，可被单测直接调用。

/** 值来源 */
export const SOURCE = Object.freeze({ CLI: 'cli', ENV: 'env', DEFAULT: 'default' })

/** 支持的字段类型 */
export const TYPES = Object.freeze(['string', 'int', 'bool', 'enum', 'csv', 'path'])

/** 脱敏后的占位（附长度提示，便于判断「是否配了」而不泄漏内容） */
export function maskSecret(value) {
  if (value === undefined || value === null || value === '') return ''
  const s = String(value)
  if (s.length <= 4) return '***'
  return `***(${s.length} 位)`
}

/**
 * 定义并冻结一个进程的配置 schema。
 * 字段：key（内部名）/ env（环境变量名）/ cli（可选命令行开关）/ type / default /
 *      sensitive / choices / min / max / doc / mustExist（path 类型，仅用于校验提示）
 */
export function defineSchema(spec) {
  const { process: proc, title, fields } = spec
  if (!proc || typeof proc !== 'string') throw new Error('schema 必须提供 process 名')
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(`${proc}: schema 必须提供非空 fields`)
  const seenKey = new Set()
  const seenEnv = new Set()
  const norm = fields.map((f) => {
    if (!f.key || !f.env) throw new Error(`${proc}: 字段必须同时提供 key 与 env`)
    if (seenKey.has(f.key)) throw new Error(`${proc}: key 重复：${f.key}`)
    if (seenEnv.has(f.env)) throw new Error(`${proc}: env 重复：${f.env}`)
    seenKey.add(f.key)
    seenEnv.add(f.env)
    if (f.type && !TYPES.includes(f.type)) throw new Error(`${proc}.${f.key}: 未知类型 ${f.type}`)
    if (f.type === 'enum' && (!Array.isArray(f.choices) || f.choices.length === 0)) {
      throw new Error(`${proc}.${f.key}: enum 类型必须提供 choices`)
    }
    return Object.freeze({ type: 'string', sensitive: false, ...f })
  })
  const schema = {
    process: proc,
    title: title ?? proc,
    prefixes: Object.freeze([...(spec.prefixes ?? [])]),
    fields: Object.freeze(norm),
    nonEnvLiterals: Object.freeze([...(spec.nonEnvLiterals ?? [])]),
    dynamicEnvReads: Object.freeze([...(spec.dynamicEnvReads ?? [])]),
    foreignEnv: Object.freeze([...(spec.foreignEnv ?? [])]),
    notes: Object.freeze([...(spec.notes ?? [])]),
    /** 全部 env 名（供 scan --check 对照） */
    envNames() { return norm.map((f) => f.env) },
    /** 全部内部键名 */
    keys() { return norm.map((f) => f.key) },
    field(key) { return norm.find((f) => f.key === key) },
    /** secret 字段的内部键 */
    secretKeys() { return norm.filter((f) => f.sensitive).map((f) => f.key) },
  }
  return Object.freeze(schema)
}

/** 解析 CLI 参数（--flag value / --flag=value / 裸开关 --flag）
 *  裸开关规则：下一个 token 以 `--` 开头或不存在时视为 'true'，否则**被当作它的取值**
 *（与仓库既有 workbench/scripts/serve.mjs 的解析约定一致，避免同一命令行两套语义）。
 *  不支持位置参数语义；非 -- 开头的 token 一律忽略。 */
export function parseArgv(argv = []) {
  const out = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) { out.set(a.slice(2, eq), a.slice(eq + 1)); continue }
    const name = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out.set(name, next); i += 1 } else { out.set(name, 'true') }
  }
  return out
}

/** 按类型转换并校验单个原始字符串值；返回 { ok, value } 或 { ok:false, message } */
export function coerce(field, raw) {
  const label = field.env
  switch (field.type) {
    case 'int': {
      const s = String(raw).trim()
      if (!/^-?\d+$/.test(s)) return { ok: false, message: `${label} 必须是整数，实际 "${raw}"` }
      const n = Number(s)
      if (field.min !== undefined && n < field.min) return { ok: false, message: `${label} 不得小于 ${field.min}，实际 ${n}` }
      if (field.max !== undefined && n > field.max) return { ok: false, message: `${label} 不得大于 ${field.max}，实际 ${n}` }
      return { ok: true, value: n }
    }
    case 'bool': {
      const s = String(raw).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return { ok: true, value: true }
      if (['0', 'false', 'no', 'off', ''].includes(s)) return { ok: true, value: false }
      return { ok: false, message: `${label} 必须是布尔值（1/0、true/false、yes/no、on/off），实际 "${raw}"` }
    }
    case 'enum': {
      const s = String(raw).trim()
      if (!field.choices.includes(s)) return { ok: false, message: `${label} 只能是 ${field.choices.join(' / ')}，实际 "${raw}"` }
      return { ok: true, value: s }
    }
    case 'csv': {
      return { ok: true, value: String(raw).split(',').map((x) => x.trim()).filter(Boolean) }
    }
    case 'path': {
      const s = String(raw)
      if (!s.trim()) return { ok: false, message: `${label} 不能为空` }
      return { ok: true, value: s }
    }
    default:
      return { ok: true, value: String(raw) }
  }
}

/**
 * 合并三来源并按 schema 校验。
 * 返回 { values, sources, errors, warnings, unknownEnv }
 *   · errors 非空 = 配置不可用（调用方应报错退出）
 *   · unknownEnv = 前缀命中但未声明的环境变量（疑似拼错；默认只告警）
 */
export function resolveConfig(schema, { env = {}, argv = [], checkUnknownEnv = true } = {}) {
  const values = {}
  const sources = {}
  const errors = []
  const warnings = []
  const cli = parseArgv(argv)

  for (const f of schema.fields) {
    let raw
    let source = SOURCE.DEFAULT
    if (f.cli && cli.has(f.cli)) {
      raw = cli.get(f.cli)
      source = SOURCE.CLI
    } else if (env[f.env] !== undefined && env[f.env] !== '') {
      raw = env[f.env]
      source = SOURCE.ENV
    }

    if (source === SOURCE.DEFAULT) {
      values[f.key] = f.default
      sources[f.key] = SOURCE.DEFAULT
      // 声明为必填（default === undefined）且没有来源 → 报错
      if (f.default === undefined && f.required) {
        errors.push({ key: f.key, env: f.env, message: `${f.env} 必填（可用 CLI --${f.cli ?? f.key} 或环境变量提供）` })
      }
      continue
    }

    const r = coerce(f, raw)
    if (!r.ok) {
      errors.push({ key: f.key, env: f.env, message: r.message })
      values[f.key] = f.default
      sources[f.key] = SOURCE.DEFAULT
      continue
    }
    values[f.key] = r.value
    sources[f.key] = source
  }

  const unknownEnv = []
  if (checkUnknownEnv && schema.prefixes.length) {
    const declared = new Set(schema.envNames())
    // 本进程前缀下、但属于**其他系统**的变量（如 DSH 宿主的 DSH_WEB_URL 与 workbench 的 DSH_WEB_* 撞名）
    const foreign = new Set(schema.foreignEnv.map((x) => (typeof x === 'string' ? x : x.name)))
    for (const name of Object.keys(env)) {
      if (declared.has(name) || foreign.has(name)) continue
      if (schema.prefixes.some((p) => name.startsWith(p))) unknownEnv.push(name)
    }
    unknownEnv.sort()
    for (const name of unknownEnv) {
      warnings.push({ key: null, message: `环境变量 ${name} 前缀属于本进程但未在 schema 中声明（拼写错误？或需要补进 config-schema）` })
    }
  }
  return { values, sources, errors, warnings, unknownEnv }
}

/** 生成脱敏后的可打印对象。
 *  · sensitive=true → 整体掩码（只留长度提示）
 *  · 提供 redact(v) 钩子 → 由字段自己脱敏（例如 `roomId:token:role` 这种**部分敏感**的复合值：
 *    保留可运维的房间与角色，隐去 token）。钩子的存在是为了让「部分脱敏」也走引擎这一条路径，
 *    而不是散落到各进程的日志代码里。 */
export function redactConfig(schema, values) {
  const out = {}
  for (const f of schema.fields) {
    const v = values[f.key]
    if (f.sensitive) out[f.key] = maskSecret(v)
    else if (typeof f.redact === 'function') out[f.key] = f.redact(v)
    else if (Array.isArray(v)) out[f.key] = v.join(',')
    else out[f.key] = v
  }
  return out
}

/** 单行/多行启动摘要（脱敏；showSource 时标出每个值的来源，便于排查「值从哪来」） */
export function formatSummary(schema, resolved, { showSource = false } = {}) {
  const red = redactConfig(schema, resolved.values)
  const parts = schema.fields.map((f) => {
    const shown = f.sensitive
      ? `${f.key}=${red[f.key] || '(未设置)'}`
      : `${f.key}=${formatValue(red[f.key])}`
    const src = showSource ? `(${resolved.sources?.[f.key] ?? SOURCE.DEFAULT})` : ''
    return shown + src
  })
  return `[config] ${schema.process} ${parts.join(' ')}`
}

function formatValue(v) {
  if (v === undefined || v === null) return '(未设置)'
  if (typeof v === 'string' && v === '') return '(空)'
  if (typeof v === 'string' && /\s/.test(v)) return JSON.stringify(v)
  return String(v)
}

/** 摘要的 JSON 形态（供 /metrics 或诊断端点复用；同样已脱敏） */
export function summaryObject(schema, resolved, { showSource = true } = {}) {
  const red = redactConfig(schema, resolved.values)
  return {
    process: schema.process,
    title: schema.title,
    values: red,
    sources: showSource ? { ...resolved.sources } : undefined,
    warnings: resolved.warnings.map((w) => w.message),
    errors: resolved.errors.map((e) => e.message),
  }
}

/** 便捷入口：一次性完成「定义 → 解析 → 脱敏摘要」 */
export function loadConfig(schema, { env = {}, argv = [], checkUnknownEnv = true } = {}) {
  const resolved = resolveConfig(schema, { env, argv, checkUnknownEnv })
  return { ...resolved, redacted: redactConfig(schema, resolved.values), summary: formatSummary(schema, resolved) }
}
