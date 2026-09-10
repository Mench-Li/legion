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
  ],
  notes: [
    'team-hub 的 token 与 workbench 的 TEAM_HUB_TOKEN 必须一致：workbench 用它调用 hub 读接口（P2-2 权限模型）。',
  ],
})

export default SCHEMA
