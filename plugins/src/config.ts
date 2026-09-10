/**
 * 插件配置解析（P3-4 插件配置面统一）：把 plugins/ 从进程环境读取的护栏项交给统一配置引擎。
 *
 * 为什么要有这一层：
 *   · 此前 4 个文件各自 `Number(process.env.X || 默认值)`，同一变量在两处按不同语义、不同默认值读取
 *     （docs/review/T-124-REVIEW.md S4），且 chatContext 直接用硬编码 4000 绕过 env；
 *   · 引擎给出统一语义：**默认值 → 环境变量**（插件无 CLI）、类型/范围校验、`sources`（值从哪来）、
 *     脱敏摘要，以及 schema 里声明的一致性规则（rules）。
 *
 * 两条纪律：
 *   ① **解析一次**（模块加载期），与既有「模块级读 env」的行为逐字一致——运行中改环境变量对已加载的
 *      插件无效（宿主需重启），这一点不做改变；
 *   ② **非法值大声降级，不退出宿主**：插件跑在 DSH 宿主进程里，"报错退出" 等于连带杀掉整个宿主
 *      （P3-2 在 CI 上已实测过 import 期 exit 的破坏力）。因此这里的口径是：该字段回退 schema 默认值，
 *      同时把错误行交给调用方打印（`pluginConfigLogLines()`），并在摘要里标出。
 *      这三进程（team-hub / workbench / whiteboard）是独立进程，仍按 P3-2 的「非法即退出」执行。
 */
import { resolveConfig, redactConfig, formatSummary, summaryObject } from '../../packages/shared/src/config.mjs'
import type { ConfigRuleViolation } from '../../packages/shared/src/config.mjs'
import { SCHEMA } from '../config-schema.mjs'

export interface PluginConfigValues {
  /** 单次回复外部上下文总预算（摘要+附件合计）——chatResponder。 */
  chatCtxBudgetChars: number
  /** 空间摘要子预算——spaceDigest / chatContext。 */
  chatCtxDigestBudgetChars: number
  /** 单文件/单附件注入片段上限。 */
  chatCtxFileCapChars: number
  /** 全局层规范预算。 */
  normsGlobalMax: number
  /** 空间/项目层规范预算。 */
  normsSpaceMax: number
  /** 规范合计预算。 */
  normsTotalMax: number
}

/** 模块加载期解析一次（插件无 CLI 参数面：argv 固定为空）。 */
const resolved = resolveConfig(SCHEMA, {
  env: process.env as Record<string, string | undefined>,
  argv: [],
  checkUnknownEnv: true,
})

/** schema 声明的一致性规则（跨预算的包含关系等）；违反只是提示，不影响取值。 */
const ruleViolations: ConfigRuleViolation[] = SCHEMA.rules.flatMap((rule) => rule(resolved.values))

/** 插件生效的配置值（已按 schema 校验；非法字段已回退默认值，见 pluginConfigDiagnostics）。 */
export const pluginConfig: Readonly<PluginConfigValues> = Object.freeze({
  chatCtxBudgetChars: Number(resolved.values.chatCtxBudgetChars),
  chatCtxDigestBudgetChars: Number(resolved.values.chatCtxDigestBudgetChars),
  chatCtxFileCapChars: Number(resolved.values.chatCtxFileCapChars),
  normsGlobalMax: Number(resolved.values.normsGlobalMax),
  normsSpaceMax: Number(resolved.values.normsSpaceMax),
  normsTotalMax: Number(resolved.values.normsTotalMax),
})

/** 每个值来自哪里（default / env）——排查「我设了怎么没生效」时先看它。 */
export function pluginConfigSources(): Record<string, string> {
  return { ...resolved.sources }
}

/** 校验与规则的结论：errors 非空表示有字段被回退成默认值（不是「配置生效」）。 */
export function pluginConfigDiagnostics(): { errors: string[]; warnings: string[]; ruleViolations: ConfigRuleViolation[] } {
  return {
    errors: resolved.errors.map((e) => e.message),
    warnings: resolved.warnings.map((w) => w.message),
    ruleViolations: ruleViolations.map((v) => ({ ...v })),
  }
}

/** 脱敏单行摘要（与三进程的启动摘要同一路径：redactConfig 是唯一出口）。 */
export function pluginConfigSummary(): string {
  const base = formatSummary(SCHEMA, resolved, { showSource: true })
  const red = redactConfig(SCHEMA, resolved.values)
  const overridden = SCHEMA.fields
    .filter((f) => resolved.sources[f.key] !== 'default')
    .map((f) => `${f.env}=${String(red[f.key])}`)
  return overridden.length > 0 ? `${base} ← 覆盖：${overridden.join(', ')}` : `${base}（全部取默认值）`
}

/** 机器可读形态（脱敏），供诊断端点/测试复用。 */
export function pluginConfigJson(): Record<string, unknown> {
  return {
    ...summaryObject(SCHEMA, resolved, { showSource: true }),
    ruleViolations: ruleViolations.map((v) => ({ ...v })),
  }
}

/**
 * 启动时要打印到守护日志的行（摘要 + 错误 + 提示 + 规则告警）。
 * 由 index.ts 的 `logConfigOnce()` 在首个守护实例启动时调用（**每进程一次**：配置是进程级的，
 * 多空间监督者下逐实例重复没有信息量）。
 */
export function pluginConfigLogLines(): string[] {
  const lines = [pluginConfigSummary()]
  for (const e of resolved.errors) lines.push(`配置非法（已回退默认值）：${e.message}`)
  for (const w of resolved.warnings) lines.push(`配置提示：${w.message}`)
  for (const v of ruleViolations) lines.push(`配置规则[${v.level}/${v.code}]：${v.message}`)
  return lines
}
