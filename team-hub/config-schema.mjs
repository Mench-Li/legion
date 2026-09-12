// config-schema.mjs — team-hub v2 的配置声明（P3-2 统一配置系统）
//
// 依据：scripts/config/scan.mjs 扫出的真实读取点（team-hub/server.mjs 与 team-hub/scripts/*）。
// 新增 env 读取必须同时补进本文件，否则 `scan --check` 失败。
import { defineSchema } from '../packages/shared/src/config.mjs'

export const SCHEMA = defineSchema({
  process: 'team-hub',
  title: 'team-hub v2（对话/日程数据面 + SSE + 审计）',
  prefixes: ['TEAM_HUB_', 'CHAT_', 'LEGION_HUB_'],
  fields: [
    // ── 监听、鉴权、存储（P3-2 统一项）──
    // 0 是**合法值**：Node `listen(0)` 语义 = 由 OS 分配空闲端口。契约测试
    // （tests/contract/team-hub-parity.test.mjs）就是「env 设 0 + 自己 listen(0)」，且 /api/config
    // 要求把 0 原样透出——因此这里不能要求 >= 1（P3-2 首版曾误设 min:1，直接打断了该契约测试）。
    { key: 'port', env: 'TEAM_HUB_PORT', cli: 'port', type: 'int', default: 8787, min: 0, max: 65535, doc: '监听端口（0 = 由调用方/OS 分配，配合 listen(0) 的导入式用法）' },
    { key: 'host', env: 'TEAM_HUB_HOST', cli: 'host', type: 'string', default: '127.0.0.1', doc: '监听地址；非回环必须配 token' },
    { key: 'token', env: 'TEAM_HUB_TOKEN', cli: 'token', type: 'string', default: '', sensitive: true, doc: '访问 token（读写鉴权）' },
    { key: 'dbFile', env: 'TEAM_HUB_DB', type: 'path', default: 'team-hub/team.db', doc: 'SQLite 数据库文件（WAL）' },
    // ── 附件（P3-2 统一项：附件目录相关限值）──
    { key: 'attachMaxBytes', env: 'CHAT_ATTACH_MAX_BYTES', type: 'int', default: 10 * 1024 * 1024, min: 1, doc: '单附件大小上限（字节）' },
    { key: 'attachMaxPerMsg', env: 'CHAT_ATTACH_MAX_PER_MSG', type: 'int', default: 3, min: 1, doc: '每条消息附件数量上限' },
    { key: 'attachBlacklistExt', env: 'CHAT_ATTACH_BLACKLIST_EXT', type: 'csv', default: 'exe,dll,bin,zip,rar,7z,tar,gz,png,jpg,jpeg,gif,webp,svg,ico,pdf,doc,docx,xls,xlsx', doc: '附件扩展名黑名单（逗号分隔）' },
    { key: 'attachStagedTtlMs', env: 'CHAT_ATTACH_STAGED_TTL_MS', type: 'int', default: 24 * 3600 * 1000, min: 1, doc: 'staged 孤儿清理阈值（ms）' },
    { key: 'attachTtlMs', env: 'CHAT_ATTACH_TTL_MS', type: 'int', default: 7 * 24 * 3600 * 1000, min: 1, doc: 'sent 附件过期清理阈值（ms）' },
    // ── 对话行为 ──
    { key: 'replyTimeoutMs', env: 'CHAT_REPLY_TIMEOUT_MS', type: 'int', default: 120000, min: 1, doc: 'AI 回复等待超时（ms），超时标记 failed' },
    { key: 'maxRulesLen', env: 'MAX_RULES_LEN', type: 'int', default: 3000, min: 1, doc: '规范内容长度上限（字符）' },
    // ── 运维脚本 ──
    { key: 'hubUrl', env: 'LEGION_HUB_URL', type: 'string', default: 'http://127.0.0.1:8787', doc: 'seed-pipeline 脚本要写入的 hub 地址' },
  ],
  nonEnvLiterals: [
    'COMMIT', 'ROLLBACK', 'DELETE', 'OPTIONS', 'SIGINT', 'SIGTERM', 'ENOENT',
    // 运行面（PRT-302/303/313）的具名错误码，来自 team-hub/run-store.mjs 的 RUN_ERRORS。
    // 逐个登记而不是加前缀通配：这份清单的价值在于「每一条都被看过一次」。
    'WORKER_REQUIRED', 'EPOCH_REQUIRED', 'BAD_LEASE_TTL', 'ATTEMPT_NOT_FOUND',
    'LEASE_EPOCH_STALE', 'LEASE_NOT_HELD', 'LEASE_EXPIRED',
    'UNKNOWN_OUTCOME', 'TRANSITION_REJECTED', 'ALREADY_FINISHED',
    'UNKNOWN_ATTEMPT_STATE',
    // SQL 列类型名：`ALTER TABLE ... ADD COLUMN ... INTEGER` 里的 INTEGER 形如 env 键
    // （全大写单词），但它不是配置。登记它是为了让扫描器把「真实读取点」与这类噪声分开。
    'INTEGER', 'TEXT',
    // PRT-309/310/311 新增：额度配置非法、处置决定非法、状态不需要处置
    'BAD_MAX_ATTEMPTS', 'BAD_DECISION', 'NOT_HELD', 'TASK_NOT_CLAIMABLE', 'SCOPE_REQUIRED',
    // 路由层参数校验码（server.mjs 的 requireString）
    'MISSING_PARAM',
    // 回收接口的拒绝码：调用方未给出「哪些状态已越过外部写边界」时必须拒绝，
    // 这个字符串就是那条拒绝对外可见的名字（server.mjs 与 worker/run.mjs 都会用到）
    'EXTERNAL_EFFECT_UNKNOWN',
    // PRT-307 机器验收新增：
    //   EVIDENCE_MISSING       — 迁移声明要先落库的证据不存在（409，见 run-store）
    //   NOT_VALIDATING         — 尝试不在可验收的状态上
    //   BAD_ACCEPTANCE_CRITERIA— tasks.acceptance 不是合法 JSON 数组（数据问题，500）
    //   UNKNOWN_DECISION       — 验收结论不在三种之内，不得默认去向（来自
    //                            orchestrator/acceptance/index.mjs，经 run-store 抛出）
    'EVIDENCE_MISSING', 'NOT_VALIDATING', 'BAD_ACCEPTANCE_CRITERIA', 'UNKNOWN_DECISION',
    // PRT-307 机器验收的契约错误码（orchestrator/acceptance/index.mjs 的
    // ACCEPTANCE_ERRORS，经 run-store 转成 ContractError 抛出）
    'CRITERIA_NOT_ARRAY', 'RUN_RESULT_INVALID',
    // PRT-308 交接新增：
    //   NOT_HANDING_OFF   — 不在 HandingOff 上不能交接
    //   HANDOFF_REJECTED  — 链断 / 岗位不存在 / 两处判断不一致
    //   HANDOFF_NOT_WIRED — 没注入 createTask/readPipeline（500，不降级成"没有下一岗位"）
    //   TASK_NOT_FOUND    — /api/runtime/next-post 的任务不存在（404）
    'NOT_HANDING_OFF', 'HANDOFF_REJECTED', 'HANDOFF_NOT_WIRED', 'TASK_NOT_FOUND',
  ],
  // team-hub 的 CHAT_ 前缀覆盖了插件的提示词预算变量（CHAT_CTX_*）：它们是**插件**读的配置，
  // team-hub 不读，登记为外来变量，避免误报成「拼写错误」（P3-4）。
  foreignEnv: [
    { name: 'CHAT_CTX_BUDGET_CHARS', owner: 'plugins（士兵守护）', reason: '提示词总预算由插件读取，team-hub 不读（P3-4）' },
    { name: 'CHAT_CTX_DIGEST_BUDGET_CHARS', owner: 'plugins（士兵守护）', reason: '空间摘要子预算由插件读取，team-hub 不读（P3-4）' },
    { name: 'CHAT_CTX_FILE_CAP_CHARS', owner: 'plugins（士兵守护）', reason: '单文件/单附件片段上限由插件读取，team-hub 不读（P3-4）' },
  ],
  notes: [
    'team-hub 的 token 与 workbench 的 TEAM_HUB_TOKEN 必须一致：workbench 用它调用 hub 读接口（P2-2 权限模型）。',
  ],
})

export default SCHEMA
