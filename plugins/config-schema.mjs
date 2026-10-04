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
    // ── T-170（并行任务文件冲突治理 S6 / R-6）：合入通道模式 ──
    //
    // ★ 这把键**是真实的进程环境读取**（不是字面量误报）：`plugins/src/legacyConvergence.ts:29`
    //   的 `resolveIntegrationMode(env = process.env)` 直接读 `env.LEGION_INTEGRATION_MODE`，
    //   非三个合法值一律**回落 legacy**（未灰度仓库行为不变）。team-hub 侧
    //   `routes/delivery.mjs` / `routes/write-intent.mjs` / `server.mjs` 读的是**同一把键**，
    //   因此两份 schema 的 choices / default 必须逐字相同——同一变量两种语义正是 P3-4 收口过的问题。
    //
    // 三个值是三个**不同的系统状态**，不是同一件事的三种强度：
    //   · legacy      —— 默认。autoPromote / mediation 的旧 direct merge 通道照旧。
    //   · observation —— 只记录"本应走集成 worker"的模拟判定，**不改派工**
    //                    （`decideIntegrationPath` 回 `OBSERVE_ONLY`，`changesDispatch:false`）。
    //   · integration —— 旧 direct merge 一律拒绝（`LEGACY_INTEGRATION_DISABLED`）并转唯一集成入口。
    //
    // 为什么默认取 legacy 而不是 integration：这是**灰度开关**，没灰度的仓库必须行为不变
    // （README / docs 与 plugins 侧 `resolveIntegrationMode` 的回落值写的都是 legacy）。
    { key: 'integrationMode', env: 'LEGION_INTEGRATION_MODE', type: 'enum', choices: ['legacy', 'observation', 'integration'], default: 'legacy', doc: '合入通道模式（与 team-hub 同一把键）：legacy=旧直合并通道照旧；observation=只模拟判定不改派工；integration=旧通道一律拒绝并转唯一集成 worker（S6/R-6）' },
    // ── OS 提供的可执行搜索路径 ──
    //
    // ★ 这是**真实读取**（`plugins/src/workflowTestRunner.ts:74` 的 `process.env.PATH ?? ''`），
    //   用途是解析 npm/node 可执行文件的位置；不是 Legion 的可配置项，也不该由产品去"设默认值"。
    //   登记为 fields（而不是 nonEnvLiterals）是本仓一贯口径：真的读了就按字段登记并说明它不是产品配置
    //   （同 team-hub 的 USERNAME / USER / USERDOMAIN）。
    { key: 'processPath', env: 'PATH', type: 'string', default: '', doc: 'OS 提供的可执行搜索路径（不是产品配置）：测试运行器用它定位 npm/node，并把解析结果转发给子进程' },
  ],
  // 动态下标读取：`runnerEnvironment()` 把白名单里的 OS 变量**逐字**复制给测试子进程
  //（`env[key] = source[key]`）。这里登记的是"转发"，不是"按配置键取自己的配置"——
  // 键名集合由同文件写死的字面量数组给定（见上方 nonEnvLiterals 的第一组）。
  dynamicEnvReads: [
    { file: 'plugins/src/workflowTestRunner.ts', expr: 'env[key]', reason: 'runnerEnvironment() 按白名单（PATH/PATHEXT/SystemRoot/WINDIR/TEMP/TMP/TMPDIR）把 OS 变量转发给测试子进程；键名来自同文件字面量数组，不是配置键' },
  ],
  // 登记的是「看起来像 env 键、其实不是」的字符串常量（P3-4 的`nonEnvLiterals`机制）：
  // 插件不读它们，而是把它们放进**工具调用的拒绝结果**与守卫日志里给模型/值班的人看。
  nonEnvLiterals: [
    // ── T-170（S5 · R-3 / S6 · R-6）：写入资格判定与旧通道收敛的具名码 ──
    //
    // 来源：plugins/src/writeEligibility.ts（`evaluatePreExecute` 每个拒绝分支一个码）、
    //       plugins/src/productionWriteGuard.ts（集成模式下更外层的工具/租约判定）、
    //       plugins/src/legacyConvergence.ts（旧通道收敛判定）。
    //
    // 逐条登记而不是加前缀通配：这份清单的价值在于「每一条都被看过一次」。分组理由：
    //   · ALLOWED / READ_PHASE_NO_RESERVATION —— **放行**的两个码：只读工具永远放行，
    //     且**不申请写入预约**（"允许"与"允许但不占位"是两件事，写在 message 里说不清）。
    //   · WORKSPACE_MISMATCH / EPOCH_STALE / REVISION_MISMATCH —— fencing 三码，三种修法不同
    //     （换工作区要重新认领 / 租约纪元过期要重新认领 / revision 变了要基于最新范围重试）。
    //   · PATH_REJECTED / OUT_OF_SCOPE —— 路径本身不合法 vs 路径合法但越出本次范围
    //     （后者走 write-intent 扩域事务，不是改路径）。
    //   · TRANSPORT_ONLY / READ_ONLY / OPAQUE_COMMAND / UNKNOWN_TOOL / WRITE_LEASE_CHANGED /
    //     PATH_UNKNOWN —— productionWriteGuard 的外层判定：run_code 只是传输、只读放行、
    //     无法预知写入目标的 shell 命令拒绝（验证由集成服务执行）、判不出是否写入的工具拒绝、
    //     租约/revision 变了要重新认领、解析不出目标路径拒绝。
    //   · LEGACY_ALLOWED / LEGACY_INTEGRATION_DISABLED / OBSERVE_ONLY / REPO_MODE_CONFLICT ——
    //     S6 收敛判定：允许旧通道 / 旧通道已停用 / 仅观察 / 同一仓库被绑成不同模式。
    'ALLOWED', 'READ_PHASE_NO_RESERVATION', 'WORKSPACE_MISMATCH', 'EPOCH_STALE', 'REVISION_MISMATCH',
    'PATH_REJECTED', 'OUT_OF_SCOPE',
    'TRANSPORT_ONLY', 'READ_ONLY', 'OPAQUE_COMMAND', 'UNKNOWN_TOOL', 'WRITE_LEASE_CHANGED', 'PATH_UNKNOWN',
    'LEGACY_ALLOWED', 'LEGACY_INTEGRATION_DISABLED', 'OBSERVE_ONLY', 'REPO_MODE_CONFLICT',

    // ── 测试运行器的 OS 变量名单与进程信号（plugins/src/workflowTestRunner.ts）──
    //
    // 这一组**不是本进程的配置面**，而是"转发给子进程的白名单"与"杀进程的信号名"：
    //   · PATHEXT / WINDIR / TMPDIR —— `runnerEnvironment()` 的白名单数组
    //     （`['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR']`）里的名字。
    //     它们被**逐字复制**到测试子进程的 env 里（子进程是 node，需要这些才能解析可执行文件
    //     与临时目录）；插件自己从不按这些名字读配置。同数组里的 PATH 是**真实读取**
    //     （`process.env.PATH ?? ''` 用于解析 npm 所在目录），因此它登记在下方 fields，
    //     而不是这里——"白名单里的名字"与"我真的读了它"是两件事，混在一处会让这份清单说谎。
    //   · SIGKILL —— `process.kill(-child.pid, 'SIGKILL')` 的信号名。
    //   · EXTERNAL_AGENT_START_FAILED —— 插件把 Runtime 契约的外部智能体启动失败码
    //     透传给将军/值班人看（plugins/src/index.ts），与上面 S5/S6 那批同族。
    'PATHEXT', 'WINDIR', 'TMPDIR', 'SIGKILL',
    'EXTERNAL_AGENT_START_FAILED',
  ],
  rules: [normsAndCtxRules],
  notes: [
    'CHAT_CTX_BUDGET_CHARS 是**总预算**（chatResponder，默认 8000）；空间摘要子预算自 P3-4 起有独立变量 ' +
      'CHAT_CTX_DIGEST_BUDGET_CHARS（默认 4000）。此前摘要子预算复用同一个变量（默认 4000），' +
      '「一个变量两种语义」正是被收口的问题；如需让摘要跟随总预算，显式设置这个新变量。',
    'LEGION_INTEGRATION_MODE 与 team-hub/config-schema.mjs 的 integrationMode 是**同一把键**：' +
      '插件侧只看"是不是 integration"以外还会用 observation 做模拟判定，team-hub 侧只区分 integration。' +
      '两边的 choices 与默认值必须一致（legacy），否则"同一个环境变量在两个进程里有两种语义"。',
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
