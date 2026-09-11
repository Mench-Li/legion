// runtime/adapters/dsh/schema.mjs
// ============================================================================
// 结构化输出校验（PRT-204）
//
// ## 为什么 DSH 已经校验过，我们还要再校验一次
//
// `subagents.start` 接受 `outputSchema` 并由引擎侧校验（plugins/src/index.ts:1260）。
// 再校验一遍不是不信任引擎，而是**产品不能把「引擎说它校验过了」当作证据**：
//
//   ① 引擎能力是可协商的。`RuntimeCapabilities` 里结构化输出是**可选**能力，
//      某个运行时/版本可能只是把 schema 透传给模型、并不真校验。
//   ② 「完成」的判定必须发生在我们的边界内。spec §6.4 的状态机以
//      「结构化结果有效」为 `HandingOff` 的前置；如果把判定权交给引擎，
//      状态机的输入就来自外部，无法做确定性测试（阶段 1 的成果会被削弱）。
//   ③ 校验失败必须是**可归因**的：我们要能说出「缺哪个 field」，
//      而不是「引擎说输出不合法」。
//
// ## 支持子集
//
// 有意只实现仓库实际使用到的子集（见 plugins 里的 outputSchema 字面量）：
// type / properties / required / additionalProperties / items / enum / const / oneOf。
// **未识别的 `type` 一律判失败（fail closed）**——一个我们不认识的类型
// 意味着我们无法确认它合法，此时放行等于放弃校验。
// ============================================================================

/** 支持的类型集合。 */
export const SUPPORTED_TYPES = Object.freeze(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const MAX_DEPTH = 32
const MAX_ERRORS = 25

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function typeMatches(expected, value) {
  const actual = typeOf(value)
  if (expected === 'number' && actual === 'integer') return true
  if (expected === 'integer' && actual === 'number') return Number.isInteger(value)
  return expected === actual
}

/**
 * 校验 `value` 是否满足 `schema`。
 *
 * 返回 `{ ok, errors }`。`errors` 是**面向排障**的路径化描述
 * （如 `output.report.status: 缺 required 字段`），可以直接进审计。
 */
export function validateStructured(schema, value) {
  const errors = []

  // 未声明 schema → fail closed。RunRequest.expectedOutput.schema 是必填项，
  // 缺失说明调用方没走契约；此时「跳过校验」等于把契约要求变成可选。
  if (schema === undefined || schema === null) {
    return { ok: false, errors: ['未声明 outputSchema，无法校验（不许假装通过）'] }
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, errors: [`outputSchema 必须是对象，收到 ${Array.isArray(schema) ? 'array' : typeof schema}`] }
  }

  const walk = (sch, val, path, depth) => {
    if (errors.length >= MAX_ERRORS) return
    if (depth > MAX_DEPTH) {
      errors.push(`${path}: 超出最大校验深度 ${MAX_DEPTH}`)
      return
    }
    if (sch === null || typeof sch !== 'object') {
      errors.push(`${path}: schema 节点不是对象`)
      return
    }

    if (sch.const !== undefined && val !== sch.const) {
      errors.push(`${path}: 不等于 const（期望 ${JSON.stringify(sch.const)}，实得 ${JSON.stringify(val)}）`)
    }
    if (Array.isArray(sch.enum) && !sch.enum.some((e) => e === val)) {
      errors.push(`${path}: 不在 enum 内（${JSON.stringify(sch.enum)}）`)
    }
    if (Array.isArray(sch.oneOf) && sch.oneOf.length > 0) {
      // oneOf 语义要求「恰好一个」分支匹配。
      // 分支探测必须在**隔离的错误缓冲**里跑，否则分支里的错误会污染外层结果。
      const counts = sch.oneOf.map((s) => countErrors(s, val, path, depth + 1))
      const matched = counts.filter((c) => c === 0).length
      if (matched === 0) errors.push(`${path}: oneOf 无分支匹配`)
      else if (matched > 1) errors.push(`${path}: oneOf 有 ${matched} 个分支同时匹配（歧义）`)
    }

    if (sch.type !== undefined) {
      const expected = Array.isArray(sch.type) ? sch.type : [sch.type]
      for (const t of expected) {
        if (!SUPPORTED_TYPES.includes(t)) {
          errors.push(`${path}: 不支持的 schema type「${t}」（fail closed）`)
          return
        }
      }
      if (!expected.some((t) => typeMatches(t, val))) {
        errors.push(`${path}: 类型不符（期望 ${expected.join('|')}，实得 ${typeOf(val)}）`)
        return
      }
    }

    if (typeOf(val) === 'object') {
      if (Array.isArray(sch.required)) {
        for (const k of sch.required) {
          if (!Object.hasOwn(val, k) || val[k] === undefined) errors.push(`${path}.${k}: 缺 required 字段`)
        }
      }
      if (sch.properties && typeof sch.properties === 'object') {
        for (const [k, sub] of Object.entries(sch.properties)) {
          if (Object.hasOwn(val, k)) walk(sub, val[k], path === '' ? k : `${path}.${k}`, depth + 1)
        }
      }
      if (sch.additionalProperties === false) {
        const allowed = new Set(Object.keys(sch.properties ?? {}))
        for (const k of Object.keys(val)) {
          if (!allowed.has(k)) errors.push(`${path}.${k}: additionalProperties=false 禁止的字段`)
        }
      }
    }

    if (typeOf(val) === 'array' && sch.items !== undefined) {
      if (Array.isArray(sch.items)) {
        // 元组形式：逐位置校验，多出的元素报错（与 additionalItems 语义一致）
        for (let i = 0; i < val.length; i++) {
          if (i < sch.items.length) walk(sch.items[i], val[i], `${path}[${i}]`, depth + 1)
          else if (sch.additionalItems === false) errors.push(`${path}[${i}]: 超出元组长度且 additionalItems=false`)
        }
      } else {
        for (let i = 0; i < val.length; i++) walk(sch.items, val[i], `${path}[${i}]`, depth + 1)
      }
    }

    if (typeof val === 'string') {
      if (typeof sch.minLength === 'number' && val.length < sch.minLength) errors.push(`${path}: 短于 minLength ${sch.minLength}`)
      if (typeof sch.maxLength === 'number' && val.length > sch.maxLength) errors.push(`${path}: 长于 maxLength ${sch.maxLength}`)
    }
    if (typeof val === 'number') {
      if (typeof sch.minimum === 'number' && val < sch.minimum) errors.push(`${path}: 小于 minimum ${sch.minimum}`)
      if (typeof sch.maximum === 'number' && val > sch.maximum) errors.push(`${path}: 大于 maximum ${sch.maximum}`)
    }
  }

  /**
   * 在隔离的错误缓冲里跑一次校验，返回新增错误数。
   *
   * 用于 oneOf 分支探测：分支内部产生的错误必须被**收回**，
   * 否则「探测分支」这个动作本身就会把外层校验判为失败。
   */
  function countErrors(sch, val, path, depth) {
    const saved = errors.length
    walk(sch, val, path, depth)
    const added = errors.length - saved
    if (added > 0) errors.splice(saved, added)
    return added
  }

  walk(schema, value, 'output', 0)
  return { ok: errors.length === 0, errors: errors.slice(0, MAX_ERRORS) }
}

/** 校验 `RunRequest.expectedOutput`：schema 与验收说明都必须存在。 */
export function validateExpectedOutput(expectedOutput) {
  const errors = []
  if (expectedOutput === null || typeof expectedOutput !== 'object') {
    return { ok: false, errors: ['expectedOutput 必须是对象'] }
  }
  if (expectedOutput.schema === undefined || expectedOutput.schema === null) {
    errors.push('expectedOutput.schema 未声明')
  }
  if (typeof expectedOutput.acceptance !== 'string' || expectedOutput.acceptance.trim() === '') {
    errors.push('expectedOutput.acceptance 未声明（机器可判定的验收说明）')
  }
  return { ok: errors.length === 0, errors }
}
