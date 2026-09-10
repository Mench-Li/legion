// config-schema.mjs — 士兵守护插件族（plugins/）的配置声明（P3-4 插件配置面统一）
//
// 边界：插件的**主配置面是宿主 composition（cordis options）**——role / intervalMs / maxWorkers /
// hubUrl / scope / rolesFile … 都由 `~/.dsh/profiles/web/cordis.patch.yml` 的 config 块提供，
// 本 schema **不接管**它们。这里纳管的是插件**从进程环境读取**的少数护栏项（提示词预算），
// 它们此前散落在 4 个文件里各自 `process.env.X || 默认值`，且同一变量被两处按不同语义、
// 不同默认值读取（docs/review/T-124-REVIEW.md S4）。
//
// 依据：scripts/config/scan.mjs 扫出的真实读取点（plugins/src/**）。新增 env 读取必须同时补进本文件，
// 否则 `scan --check` 失败。
import { defineSchema } from '../packages/shared/src/config.mjs'

export const DEFAULT_CHAT_CTX_BUDGET_CHARS = 8000
export const DEFAULT_CHAT_CTX_DIGEST_BUDGET_CHARS = 4000
export const DEFAULT_CHAT_CTX_FILE_CAP_CHARS = 4000
export const DEFAULT_NORMS_GLOBAL_MAX = 3000
export const DEFAULT_NORMS_SPACE_MAX = 4000
export const DEFAULT_NORMS_TOTAL_MAX = 7000

export const SCHEMA = defineSchema({
  process: 'plugins',
  title: '士兵守护插件族（plugins/：scrum-worker / mediator）',
  prefixes: ['CHAT_CTX_', 'NORMS_'],
  fields: [
    // ── 对话外部上下文的三个预算（chatResponder 总预算 / spaceDigest 摘要子预算 / 单块上限）──
    { key: 'chatCtxBudgetChars', env: 'CHAT_CTX_BUDGET_CHARS', type: 'int', default: DEFAULT_CHAT_CTX_BUDGET_CHARS, min: 1, doc: '单次回复外部上下文总预算（摘要+附件合计，字符）' },
    { key: 'chatCtxDigestBudgetChars', env: 'CHAT_CTX_DIGEST_BUDGET_CHARS', type: 'int', default: DEFAULT_CHAT_CTX_DIGEST_BUDGET_CHARS, min: 1, doc: '空间摘要子预算（字符，应 ≤ 总预算）' },
    { key: 'chatCtxFileCapChars', env: 'CHAT_CTX_FILE_CAP_CHARS', type: 'int', default: DEFAULT_CHAT_CTX_FILE_CAP_CHARS, min: 1, doc: '单文件/单附件注入片段上限（字符）' },
    // ── 分层规范注入的三个预算（S5-06 三值法）──
    { key: 'normsGlobalMax', env: 'NORMS_GLOBAL_MAX', type: 'int', default: DEFAULT_NORMS_GLOBAL_MAX, min: 1, doc: '全局层规范预算（字符）' },
    { key: 'normsSpaceMax', env: 'NORMS_SPACE_MAX', type: 'int', default: DEFAULT_NORMS_SPACE_MAX, min: 1, doc: '空间/项目层规范预算（字符）' },
    { key: 'normsTotalMax', env: 'NORMS_TOTAL_MAX', type: 'int', default: DEFAULT_NORMS_TOTAL_MAX, min: 1, doc: '规范合计预算（字符，应 ≥ 各层之和）' },
  ],
  rules: [normsAndCtxRules],
  notes: [
    'CHAT_CTX_BUDGET_CHARS 是**总预算**（chatResponder，默认 8000）；空间摘要子预算自 P3-4 起有独立变量 ' +
      'CHAT_CTX_DIGEST_BUDGET_CHARS（默认 4000）。此前摘要子预算复用同一个变量（默认 4000），' +
      '「一个变量两种语义」正是被收口的问题；如需让摘要跟随总预算，显式设置这个新变量。',
    '插件在 DSH 宿主进程内运行：配置非法时**不退出宿主**，而是打印 `[config]` 错误行并把该字段回退默认值（大声降级）。',
  ],
})

/** 进程内一致性规则：三类预算之间的包含关系（违反了不会崩，但注入效果与预期不符）。 */
export function normsAndCtxRules(values) {
  const out = []
  const total = Number(values.chatCtxBudgetChars)
  const digest = Number(values.chatCtxDigestBudgetChars)
  const fileCap = Number(values.chatCtxFileCapChars)
  const globalMax = Number(values.normsGlobalMax)
  const spaceMax = Number(values.normsSpaceMax)
  const normsTotal = Number(values.normsTotalMax)
  if (digest > total) {
    out.push({
      level: 'warning', code: 'ctx_digest_over_total',
      message: `摘要子预算 CHAT_CTX_DIGEST_BUDGET_CHARS=${digest} 大于总预算 CHAT_CTX_BUDGET_CHARS=${total}：摘要会先被自身预算放行、再由总预算二次截断`,
      hint: '让摘要子预算 ≤ 总预算（默认 4000 / 8000）',
    })
  }
  if (fileCap > total) {
    out.push({
      level: 'warning', code: 'ctx_file_cap_over_total',
      message: `单块上限 CHAT_CTX_FILE_CAP_CHARS=${fileCap} 大于总预算 CHAT_CTX_BUDGET_CHARS=${total}：任何单块都不可能用满该上限`,
      hint: '让单块上限 ≤ 总预算（默认 4000 / 8000）',
    })
  }
  if (globalMax + spaceMax > normsTotal) {
    out.push({
      level: 'warning', code: 'norms_layers_over_total',
      message: `规范各层预算之和 ${globalMax}+${spaceMax}=${globalMax + spaceMax} 大于合计预算 NORMS_TOTAL_MAX=${normsTotal}：层内放行的内容会被合计预算二次截断`,
      hint: '让各层之和 ≤ NORMS_TOTAL_MAX（默认 3000+4000 = 7000）',
    })
  }
  return out
}

export default SCHEMA
