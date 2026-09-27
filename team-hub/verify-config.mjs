// team-hub/verify-config.mjs
// ============================================================================
// 仓库验证命令登记（并行任务文件冲突治理 S3 / R-4 / D-P5）
//
// 设计 §6.2 第 4 条：验证命令**从仓库已登记的命令及参数列表中选择**，
// 不能由模型把任意 shell 字符串写进配置。首版登记面是仓库内的
// .legion/delivery.json：{ targetRef, verify: [{ id, argv: string[], timeoutMs, cwd? }] }。
//
// 无登记 => 任务停在 needs-review（不得跳过验证标已交付）。
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_DELIVERY_CONFIG_PATH = '.legion/delivery.json'

function looksLikeShellString(value) {
  return typeof value === 'string' && /[;&|><`$]/.test(value)
}

/** 校验一份 delivery.json 的**内存对象**。 */
export function parseDeliveryConfig(input) {
  const errors = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return Object.freeze({ ok: false, errors: Object.freeze(['delivery.json 必须是一个对象']), config: null })
  }
  const targetRef = input.targetRef
  if (typeof targetRef !== 'string' || !/^refs\//.test(targetRef)) {
    errors.push('targetRef 必须是完整 ref（形如 refs/heads/main）')
  }
  if (typeof input.command === 'string' || typeof input.shell === 'string') {
    errors.push('不接受任意 shell 字符串（command/shell）；请使用 verify[].argv 数组')
  }
  if (looksLikeShellString(input.targetRef)) errors.push('targetRef 不得包含 shell 元字符')
  const verify = input.verify
  let normalized = null
  if (!Array.isArray(verify)) {
    errors.push('verify 必须是数组')
  } else {
    if (verify.length === 0) errors.push('每个受管仓库至少需要 1 条可执行验证命令')
    normalized = []
    verify.forEach((v, i) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        errors.push(`verify[${i}] 必须是对象`)
        return
      }
      if (typeof v.id !== 'string' || v.id.length === 0) errors.push(`verify[${i}].id 缺失`)
      if (!Array.isArray(v.argv) || v.argv.length === 0 || v.argv.some((x) => typeof x !== 'string' || x.length === 0)) {
        errors.push(`verify[${i}].argv 必须是非空字符串数组`)
      } else if (v.argv.some(looksLikeShellString)) {
        errors.push(`verify[${i}].argv 含有 shell 元字符：请把命令与参数拆成 argv 数组`)
      }
      if (typeof v.timeoutMs !== 'number' || !(v.timeoutMs > 0)) errors.push(`verify[${i}].timeoutMs 必须是正数`)
      normalized.push(Object.freeze({
        id: typeof v.id === 'string' ? v.id : 'verify-' + i,
        argv: Array.isArray(v.argv) ? Object.freeze([...v.argv]) : Object.freeze([]),
        timeoutMs: typeof v.timeoutMs === 'number' ? v.timeoutMs : 0,
        cwd: typeof v.cwd === 'string' ? v.cwd : null,
      }))
    })
  }
  if (errors.length > 0) return Object.freeze({ ok: false, errors: Object.freeze(errors), config: null })
  return Object.freeze({
    ok: true, errors: Object.freeze([]),
    config: Object.freeze({ targetRef, verify: Object.freeze(normalized) }),
  })
}

/** 从仓库读取并校验登记面。文件缺失 => {ok:false, missing:true}，由调用方停 needs-review。 */
export function loadDeliveryConfig(repoRoot, { configPath = DEFAULT_DELIVERY_CONFIG_PATH } = {}) {
  const file = join(repoRoot, configPath)
  if (!existsSync(file)) {
    return Object.freeze({ ok: false, missing: true, errors: Object.freeze(['未找到 ' + configPath + '：请登记仓库验证命令']), config: null, file })
  }
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    return Object.freeze({ ok: false, missing: false, errors: Object.freeze(['delivery.json 不是合法 JSON：' + e.message]), config: null, file })
  }
  return Object.freeze({ ...parseDeliveryConfig(parsed), missing: false, file })
}

/** 是否配置了至少一条可执行验证。 */
export function hasExecutableVerification(config) {
  return Boolean(config && Array.isArray(config.verify) && config.verify.length > 0)
}
