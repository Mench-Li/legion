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
    // ── PRT-615 审批 TTL（spec §6.4）──
    //
    // `AwaitingApproval` 期间 heartbeat **继续**、lease 随 heartbeat 续期，但受本 TTL 约束。
    // 两种退化都不接受：停止 heartbeat 会让 lease 到期并被别的 worker 领走（同一 Task
    // 重复执行，违背 §15）；无限续期会让一个无人处理的审批永久占用 lease（违背 §6.3）。
    //
    // 上下界与 `team-hub/approval-ttl.mjs` 的 `APPROVAL_TTL_MIN_MS`/`APPROVAL_TTL_MAX_MS`
    // **必须一致**：下界 1s（比一次往返还短的 TTL 与「所有审批都立即过期」同形）、
    // 上界 24h（以「天」为单位的等待不是审批而是搁置，那种情况该取消任务而不是继续占租约）。
    // 两侧由用例断言"写在这里的 min/max 等于模块里的两个常量"——一个必须靠人记得同步的
    // 上下界，与一个迟早会不同步的上下界，在「配置校验到底拦不拦得住」上是同一个东西。
    {
      key: 'approvalTtlMs', env: 'LEGION_APPROVAL_TTL_MS', type: 'int',
      default: 15 * 60 * 1000, min: 1000, max: 24 * 60 * 60 * 1000,
      doc: '审批 TTL（ms）：AwaitingApproval 期间 lease 续期的上界，到期自动 deny 并把 Attempt 判为 blocked（§6.4）',
    },
    // ── PRT-413：精确 tokenizer 的产物目录 ──
    //
    // 默认空串 = **没有配置** = 用保守估算器（`kind: conservative-estimate`）。
    // 这与"配置了一个读不到的目录"是两件事：后者会让装载失败并抛错，
    // 因为"配了但没用上"与"没配"在快照里长得一样，而前者是运维以为它生效了。
    //
    //   > 一个"配置写错了就静默回落到空词表"的装载，
    //   > 与一个"配置项根本没接线"的装载，在「配置改了有没有用」上是同一个东西——
    //   > 只不过前者会把一次拼错的路径，记成"这个模型没有精确 tokenizer"。
    {
      key: 'tokenizerDir', env: 'LEGION_TOKENIZER_DIR', type: 'path', default: '',
      doc: 'tokenizer 产物目录（*.tokenizer.json）；留空 = 用保守估算器（§6.5）',
    },
    { key: 'maxRulesLen', env: 'MAX_RULES_LEN', type: 'int', default: 3000, min: 1, doc: '规范内容长度上限（字符）' },
    // ── 运维脚本 ──
    { key: 'hubUrl', env: 'LEGION_HUB_URL', type: 'string', default: 'http://127.0.0.1:8787', doc: 'seed-pipeline 脚本要写入的 hub 地址' },
    // ── 操作系统给的"我是谁"（spec §6.7 的 ACL 加固要用）──
    //
    // 这三个**不是 Legion 的配置项**：没有默认值、没有可写的覆盖开关、
    // 也不出现在 `/api/config`（那个端点只回 auth/db/port/runPlane）。
    // 声明在这里的唯一理由是**把读取点记在账上**——扫描器的判据是
    // "要么是已声明的读取点，要么是外来变量"，而 team-hub 现在真的读它们，
    // 所以只能选前者。把真实读取点登记成"我不读"（foreignEnv）
    // 等于把它从账上抹掉，那正是这份清单要防的。
    //
    // 用途：`hardenFileAcl` 必须显式知道"把权限收紧到哪个主体"。
    // Windows 上 `icacls` 的输出**不标出所有者**，而复核（`evaluateWindowsPrincipals`）
    // 是按名字比对的——`AMENCH\x` 与 `x` 不相等，所以域也要一起拼。
    { key: 'osUserName', env: 'USERNAME', type: 'string', default: '', doc: 'Windows 上的当前账户名（OS 提供，非产品配置）' },
    { key: 'osUser', env: 'USER', type: 'string', default: '', doc: 'POSIX 上同一件事的变量名' },
    { key: 'osUserDomain', env: 'USERDOMAIN', type: 'string', default: '', doc: 'Windows 上的域/机器名，与账户名拼成 DOMAIN\\user' },
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
    // PRT-615 审批 TTL 到期自动拒绝时的失败码（`sweepExpiredApprovals` →
    // run-store.failAndRetry）。它必须是一个**可检索的字面量**而不是自由文本：
    // 值班的人要能把"这条 Attempt 为什么被 blocked"与"哪一次审批过期"对上，
    // 而一段中文描述在按失败码统计时是查不到的。
    'APPROVAL_TTL_EXPIRED',
    // PRT-607（审批箱那一半）：进入 `AwaitingApproval` 时**必须**真的建出一条可批的审批行。
    //
    //   · APPROVAL_NOT_WIRED   — 没有注入建审批行的端口。这是**配置/装配**的错，
    //                            不是这次请求的错：整条 worker 链路都少了这个端口。
    //   · APPROVAL_NOT_CREATED — 端口调过了，但那之后**查不到**属于这条 Attempt 的审批行。
    //                            这是**端口实现**的错（它静默什么都没做）。
    //
    // 两个码分开，是因为修的地方不同。把它报成一个通用错误，值班的人会去改请求。
    //
    //   > 一个「把装配缺失报成请求非法」的诊断，
    //   > 与一个「值班的人去改请求、而端口一直没接上」的诊断，是同一个东西。
    'APPROVAL_NOT_WIRED', 'APPROVAL_NOT_CREATED',
    // PRT-214 第二步：认领时解析"这次 Run 的权限档位"的那一步自己坏了。
    //
    // 与"这个员工没有清单"**必须**分开，虽然两者都会让这次 Run 在下游被拒：
    //
    //   · 员工没有清单（端口返回 null）—— 租约上**没有**权限字段，
    //     下游是 `run-floor-permissions-missing`。修法是**配置那个员工**。
    //   · `RUN_TIER_UNRESOLVABLE` —— 控制面**自己读不出来**（清单表坏了、
    //     端口形状不对）。修法是**查控制面**。
    //
    // 折成一个码的后果是排障会去查那个员工的配置，而真正坏掉的是另一张表。
    'RUN_TIER_UNRESOLVABLE',
    // PRT-307 机器验收的契约错误码（orchestrator/acceptance/index.mjs 的
    // ACCEPTANCE_ERRORS，经 run-store 转成 ContractError 抛出）
    'CRITERIA_NOT_ARRAY', 'RUN_RESULT_INVALID',
    // PRT-308 交接新增：
    //   NOT_HANDING_OFF   — 不在 HandingOff 上不能交接
    //   HANDOFF_REJECTED  — 链断 / 岗位不存在 / 两处判断不一致
    //   HANDOFF_NOT_WIRED — 没注入 createTask/readPipeline（500，不降级成"没有下一岗位"）
    //   TASK_NOT_FOUND    — /api/runtime/next-post 的任务不存在（404）
    'NOT_HANDING_OFF', 'HANDOFF_REJECTED', 'HANDOFF_NOT_WIRED', 'TASK_NOT_FOUND',
    // PRT-501 模型档案（team-hub/model-store.mjs 的 MODEL_ERRORS，经路由抛出）：
    //   INVALID_PROFILE   — 档案不合法（非法字段 / 明文密钥形态 / endpoint 内嵌凭证）
    //   PROFILE_NOT_FOUND — 没有这个档案（404）
    //   PROFILE_EXISTS    — 同名已存在，要改请用 update（409）
    //   PROFILE_DELETED   — 墓碑，与"不存在"分开（409）
    //   VERSION_CONFLICT  — CAS 版本不符，带上 currentVersion（409）
    //   VERSION_REQUIRED  — 没给 version，不默认最后一版（400）
    //   ACTOR_REQUIRED    — 谁改的模型配置必须留痕（400）
    //   AUDIT_WOULD_LEAK  — 审计载荷含疑似明文密钥，拒绝写（500，fail closed）
    'INVALID_PROFILE', 'PROFILE_NOT_FOUND', 'PROFILE_EXISTS', 'PROFILE_DELETED',
    'VERSION_CONFLICT', 'VERSION_REQUIRED', 'ACTOR_REQUIRED', 'AUDIT_WOULD_LEAK',
    // PRT-501 路由自有的契约错误：id 不是合法的 URL 编码（400）
    'BAD_ID_ENCODING',
    // PRT-502 岗位模型绑定（team-hub/binding-store.mjs 的 BINDING_STORE_ERRORS）：
    //   BINDING_NOT_FOUND  — 这个 (scope, role) 没有绑定（404）
    //   ROLE_REQUIRED      — 缺 employeeRole（400）
    //   SCOPE_REQUIRED     — 缺 scope（400）
    //   BINDING_EXISTS     — 绑定数据损坏，需要人工处置（不是"没有"）
    //   ACTOR_REQUIRED     — 谁改的绑定必须留痕（400）
    //   PRIMARY_UNRESOLVED — 主档案解析不出来 → 拒绝保存，不降级到 fallback（409）
    //   UNKNOWN_PROFILE    — 引用了未知档案
    // 路由自有的：BAD_ENCODING（绑定路径不是合法 URL 编码）
    'BINDING_NOT_FOUND', 'ROLE_REQUIRED', 'SCOPE_REQUIRED', 'BINDING_EXISTS',
    'ACTOR_REQUIRED', 'PRIMARY_UNRESOLVED', 'UNKNOWN_PROFILE', 'BAD_ENCODING',
    // PRT-503/510/511 单次运行预算账本（team-hub/budget-ledger.mjs 的 BUDGET_ERRORS）：
    //   预留：ATTEMPT_REQUIRED / RESERVATION_EXISTS / BUDGET_REQUIRED / BUDGET_INVALID
    //         / CURRENCY_MISMATCH
    //   状态机：ILLEGAL_TRANSITION / RESERVATION_LOCKED / ALREADY_SETTLED
    //         / RESERVATION_NOT_FOUND / OUTCOME_REQUIRED / ACTOR_REQUIRED（已在上）
    //   价目表冻结：PRICE_TABLE_GONE（版本取不到 → 拒绝结算，不用现价重算）
    //         / PRICE_TABLE_INVALID / PRICE_TABLE_IMMUTABLE（版本只增不改）
    //   换模型：MORE_EXPENSIVE_NEEDS_APPROVAL（不得自动切到更贵模型）
    'ATTEMPT_REQUIRED', 'RESERVATION_EXISTS', 'RESERVATION_NOT_FOUND', 'RESERVATION_LOCKED',
    'BUDGET_REQUIRED', 'BUDGET_INVALID', 'CURRENCY_MISMATCH', 'ILLEGAL_TRANSITION',
    'ALREADY_SETTLED', 'OUTCOME_REQUIRED', 'PRICE_TABLE_GONE', 'PRICE_TABLE_INVALID',
    'PRICE_TABLE_IMMUTABLE', 'MORE_EXPENSIVE_NEEDS_APPROVAL',
    // PRT-507 模型探测（team-hub/probe-service.mjs 的 PROBE_UNAVAILABLE_CODES）。
    //
    // **这三个码刻意不是"探测判定码"，而是"没有判定"的码。** 登记在这里是为了
    // 让「这次没有探测过」这件事在协议上有一个名字——没有名字的失败，
    // 前端只能把它塞进"探测失败"，而那正是要避免的（用户会去查网络）。
    //   PROBE_LAYOUT_BLOCKED    — 产品目录布局没定下来，不知道密钥库在哪
    //   PROBE_SECRETS_UNAVAILABLE — 密钥库打不开（DPAPI/损坏/平台不支持）
    //   PROBE_NO_CREDENTIAL_REF — 没给出档案 / 档案没有 endpoint
    'PROBE_LAYOUT_BLOCKED', 'PROBE_SECRETS_UNAVAILABLE', 'PROBE_NO_CREDENTIAL_REF',
    // PRT-506 迁移（team-hub/model-migration.mjs 的 MIGRATION_CODES / 一处 refused 码）：
    //   MIGRATION_OK                  — 计划可执行
    //   MIGRATION_RUNTIME_TYPE_REQUIRED — 没给 runtimeType。老数据里没有这个字段，
    //                                    猜它会让请求以错误的协议发出去
    //   MIGRATION_ID_COLLISION        — 归一化后两个不同的模型落到同一个 id。
    //                                    这是一次**静默合并**，必须拒绝整个计划
    //   MIGRATION_SECRET_IN_SOURCE    — 源数据里出现疑似密钥。非敏感迁移不该看到密钥
    //   MIGRATION_BAD_SOURCE          — 源不是数组
    //   MIGRATION_PLAN_STALE          — 用户确认的计划与服务端现在算出来的不一致
    //   MIGRATION_INVALID_PROFILE     — 构造出的档案没通过权威校验（res.right 是 errors）
    //   MIGRATION_PARTIAL             — 执行中途失败（会带上已完成的部分）
    'MIGRATION_OK', 'MIGRATION_RUNTIME_TYPE_REQUIRED', 'MIGRATION_ID_COLLISION',
    'MIGRATION_SECRET_IN_SOURCE', 'MIGRATION_BAD_SOURCE', 'MIGRATION_PLAN_STALE',
    'MIGRATION_INVALID_PROFILE', 'MIGRATION_PARTIAL',
    // PRT-409 上下文快照（team-hub/context-store.mjs）与 PRT-407 装配路由：
    //   CONTEXT_ATTEMPT_REQUIRED   — 快照没带 attemptId（它是主键）
    //   CONTEXT_NOT_FOUND          — 查不到这份快照
    //   CONTEXT_SNAPSHOT_CONFLICT  — 同一 attemptId 已有**不同**内容的快照。
    //                                同一次运行的上下文不可能有两个版本，故拒绝而非覆盖
    //   CONTEXT_SNAPSHOT_INVALID   — 哈希与内容不符（被改过），或写入后复读不一致
    //   CONTEXT_BAD_PAYLOAD        — 库里的 payload 不是合法 JSON。**不当作空快照**
    //   CONTEXT_PERMISSION_REQUIRED— 装配路由没被告知权限。路由不替调用方决定权限：
    //                                默认放行会让越权来源静默进入上下文
    //   CONTEXT_BAD_CANDIDATE      — candidates 不是数组 / 元素形状不对
    //   CONTEXT_BAD_SOURCE         — `sources`（PRT-402~406 的高层输入）归一失败：
    //                                缺版本 / 缺取得时间 / 同一类型混了不可信与可信而没声明。
    //                                **不降级成"少一个来源"**——那会让快照看起来完整
    //   CONTEXT_BAD_REQUEST        — 请求本身缺字段（attemptId/runId/frozenAtMs）。
    //                                与"运行状态不允许"不同：这是调用方写错了请求。
    //                                有码可判，客户端才不必去匹配错误文本
    'CONTEXT_ATTEMPT_REQUIRED', 'CONTEXT_NOT_FOUND', 'CONTEXT_SNAPSHOT_CONFLICT',
    'CONTEXT_SNAPSHOT_INVALID', 'CONTEXT_BAD_PAYLOAD', 'CONTEXT_PERMISSION_REQUIRED',
    'CONTEXT_BAD_CANDIDATE', 'CONTEXT_BAD_SOURCE', 'CONTEXT_BAD_REQUEST',
    // PRT-409 右半部分：快照**导出**（team-hub/context-export.mjs + 导出路由）。
    //
    // 导出有**两个**哈希：`snapshotHash` 盖住正文，`exportHash` 盖住封皮与整份文档。
    // 下面这几个码就是按"哪一个不对"分的——**故意不合成一个 `EXPORT_TAMPERED`**：
    //   · CONTEXT_EXPORT_SNAPSHOT_TAMPERED — **正文**被改过（内容不可信）
    //   · CONTEXT_EXPORT_ENVELOPE_TAMPERED — **封皮**被改过（这份文件在说谎关于它
    //     从哪来）。这一条必须单独存在：正文一字未动时单哈希验证会**照样通过**，
    //     而一份指着错误 Attempt 的文件"验过了"比没有导出更坏——它是**盖过章的错证据**
    //   · CONTEXT_EXPORT_BAD_RECORD        — 给的记录形状不对（缺 attemptId/正文/导出人/时间）
    //   · CONTEXT_EXPORT_RECORD_NOT_VERIFIED — 导出**前**自检发现正文哈希对不上。
    //     拒绝把一份验不过的记录导出，否则等于把一次篡改**洗白**成"带哈希的正规文件"
    //   · CONTEXT_EXPORT_STORE_HASH_MISMATCH — 正文自洽，但库里那一行记的哈希是另一个
    //     （整行连同 payload 一起被换成了另一份**自洽**的快照）。只验正文自洽会漏掉它
    //   · CONTEXT_EXPORT_MALFORMED_DOC     — 待验证的导出文档结构不合法，
    //     或封面版本不是本实现认识的版本（**不按未知版本猜字段语义**）
    //   · EXPORT_BY_REQUIRED / EXPORT_AT_REQUIRED — 导出路由缺 `by` / `atMs`。
    //     两者给**不同**的码：同一个码会让调用方不知道该补哪一个。
    //     不拿"现在"当 `atMs` 的默认值——一个没写时间的导出会被读成"就是刚导的"，
    //     而那是一次无法复核的猜测，导出存在的意义正是可复核
    'CONTEXT_EXPORT_BAD_RECORD', 'CONTEXT_EXPORT_RECORD_NOT_VERIFIED',
    'CONTEXT_EXPORT_MALFORMED_DOC', 'CONTEXT_EXPORT_SNAPSHOT_TAMPERED',
    'CONTEXT_EXPORT_ENVELOPE_TAMPERED', 'CONTEXT_EXPORT_STORE_HASH_MISMATCH',
    'EXPORT_BY_REQUIRED', 'EXPORT_AT_REQUIRED',
    // PRT-409 收尾：快照**保留策略**与墓碑（team-hub/context-retention.mjs + 清理路由）。
    //
    //   · CONTEXT_SNAPSHOT_PURGED —— 这份快照**存在过**，被保留策略清掉了。
    //     **不是** CONTEXT_NOT_FOUND：后者是"你查错了 id"。
    //     一个借用 404 的实现会让一次静默的数据丢失伪装成一次输错。
    //     它是 410 Gone（它曾经在，现在不在了），并带上墓碑。
    //   · CONTEXT_PURGE_BAD_REQUEST —— 清理请求本身不合法（store 层）。
    //   · RETENTION_POLICY_REQUIRED / _INVALID —— 路由层的策略校验。
    //     两个码分开：前者是"你没给"，后者是"你给的不对"，
    //     而调用方对这两件事的下一步动作完全不同（补参数 vs 改参数）。
    //     `maxAgeDays`/`maxBytes` 必须**显式**给出（不设上限写 null）：
    //     默认一个值会让"我这次想不设上限"与"我忘了传"变成同一个请求。
    //   · RETENTION_DRYRUN_REQUIRED —— 没有默认值。默认 true 会让真的清理
    //     静默失效（调用方以为删了），默认 false 会让一次查询删掉审计证据。
    //   · RETENTION_ACTOR_REQUIRED / RETENTION_REASON_REQUIRED —— 清掉审计证据
    //     必须能定位到人、说得出理由。两者分开，理由同 POLICY_REQUIRED/_INVALID。
    'CONTEXT_SNAPSHOT_PURGED', 'CONTEXT_PURGE_BAD_REQUEST',
    'RETENTION_POLICY_REQUIRED', 'RETENTION_POLICY_INVALID',
    'RETENTION_DRYRUN_REQUIRED', 'RETENTION_ACTOR_REQUIRED', 'RETENTION_REASON_REQUIRED',
    // F-05（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.1）——投递状态机与运行明细。
    //
    // 这一组码刻意**逐个**存在，而不是折成一个 `DELIVERY_FAILED` 之类的东西：
    // 它们各自指向**不同的修法**，而折起来之后读的人只会去查同一个地方。
    //
    //   · SUBSCRIBER_NOT_FOUND    — 问了一个仓储里没有的订阅者（404）。
    //     与"这个订阅者存在但什么都没有"**必须**分开：后者是一个正常的空读数
    //     （它刚登记、还没有事件），而前者是**调用方搞错了身份**。
    //     两者都给空数组时，「订阅根本没接上」会伪装成「暂时没有事件」。
    //   · DELIVERY_ROW_MISSING    — 想标一条投递，但那一行不存在。
    //     这是**内部不一致**（plan 没跑、或序号算错了），不是调用方的错。
    //   · DELIVERY_NOT_SUPPRESSIBLE — 想抑制一条投递，但它的状态已经不允许抑制
    //     （已经 delivered / 已经 suppressed）。一个可以静默改写的抑制
    //     会让"这条到底有没有投出去"事后无法回答。
    //   · RUN_EVENTS_NOT_RECORDED  — 终态请求带了事件明细但**没写成**。
    //     它**不**让终态回滚（复盘材料缺一点 ≠ 这次运行不成立），
    //     但必须让调用方读得到——否则"明细丢在路上"与"这次没有明细"同形。
    'SUBSCRIBER_NOT_FOUND', 'DELIVERY_ROW_MISSING', 'DELIVERY_NOT_SUPPRESSIBLE',
    'RUN_EVENTS_NOT_RECORDED',
    // F-16（§4.4）自动化计划的具名码。逐个存在的理由同上一组：
    //   · BAD_SCHEDULE_SPEC  — spec 不是三种形状之一（**包括 cron 字符串**：
    //     它没有被实现，而"看不懂就当每小时"会让一条计划静默变成另一种语义）
    //   · BAD_TIMEZONE       — 时区名认不出来。**绝不回落服务器本地时区**：
    //     回落时计划每天都会成功，只不过跑在错的时间上
    //   · BAD_OVERLAP_POLICY / BAD_CATCH_UP_POLICY — 策略不在封闭词表里。
    //     自由文本会让"重叠时怎么办"退化成一句备注，而它是要被机器执行的分支
    //   · SCHEDULE_ID_REQUIRED / SCHEDULE_NOT_FOUND / SCHEDULE_RUN_NOT_FOUND
    //   · ILLEGAL_RUN_TRANSITION / RUN_ALREADY_FINISHED — 终态不可改写
    //   · APPROVAL_ID_REQUIRED — 进 awaiting-approval 必须带审批 id，
    //     否则那是一条**永远醒不过来**的行（没有任何东西会把它推回 running）
    //   · BAD_CALENDAR_WINDOW — 投影窗口不合法
    //   · AUTOMATION_TICK_FAILED — tick 自己坏了（它**不抛**，因为把主循环
    //     带死比"这一次没物化"坏得多；下一轮 tick 会自己修好）
    'BAD_SCHEDULE_SPEC', 'BAD_TIMEZONE', 'BAD_OVERLAP_POLICY', 'BAD_CATCH_UP_POLICY',
    'SCHEDULE_ID_REQUIRED', 'SCHEDULE_NOT_FOUND', 'SCHEDULE_RUN_NOT_FOUND',
    'ILLEGAL_RUN_TRANSITION', 'RUN_ALREADY_FINISHED', 'APPROVAL_ID_REQUIRED',
    'BAD_CALENDAR_WINDOW', 'AUTOMATION_TICK_FAILED',
    // F-17（§4.3）压缩的具名码。核心是 `COMPACTION_DANGLING_REFERENCE`：
    // 它说的是"摘要引用了一段库里不存在的原文"，那是**内容完整性**问题
    // 而不是参数问题——读的人会因此以为摘要代表了一段并不存在的历史。
    // `COMPACTION_RANGE_ALREADY_COVERED` 同理：区间重叠时同一条消息会被
    // 两版摘要同时代表，拼上下文的人会把它算两次。
    'COMPACTION_SESSION_REQUIRED', 'COMPACTION_ACTOR_REQUIRED', 'COMPACTION_BAD_RANGE',
    'COMPACTION_SUMMARY_REQUIRED', 'COMPACTION_DANGLING_REFERENCE', 'COMPACTION_SESSION_NOT_FOUND',
    'COMPACTION_VERSION_NOT_FOUND', 'COMPACTION_VERSION_CONFLICT', 'COMPACTION_RANGE_ALREADY_COVERED',
    'COMPACTION_FAILED',
    // F-15（§4.4）用量汇总的具名码。只有两个，因为这块**只有读**：
    // `BAD_ROLLUP_DIMENSION` —— 维度名不在封闭词表里。它必须被具名拒绝，
    // 否则"按员工看"会落进一个永远为空的桶，而报表仍然显示成功。
    // `ROLLUP_FAILED` —— 兜底的读失败（它不该发生；留着是为了让
    // "算不出来"有一个具名出口，而不是一个空的 200）。
    'BAD_ROLLUP_DIMENSION', 'ROLLUP_FAILED',
    // F-16 收口（物化 → 可领取任务）：
    // `BAD_SCHEDULE_PAYLOAD` —— 计划的任务模板非法。**在建计划时就拒绝**，
    //   而不是等到物化时才失败：到点才发现模板是坏的，那一次运行
    //   （`scheduled` 行）已经产生了，于是坏模板变成一批永远建不出任务的
    //   孤儿运行行。
    // `BIND_NOT_APPLIED` —— 运行行已经有主了（CAS 没生效）。它不是错误，
    //   而是"我绑了"与"早就绑了别的"必须分得开；静默当作成功会让
    //   "这条运行永远不会被执行"没有任何痕迹。
    // `SCHEDULE_TASK_CREATE_FAILED` —— 由 payload 建任务时失败。
    //   逐条记账、**不中断整轮 tick**：一个坏模板不该让这一批里
    //   其它计划全部不物化，而下一轮 tick 会自己重试。
    'BAD_SCHEDULE_PAYLOAD', 'BIND_NOT_APPLIED', 'SCHEDULE_TASK_CREATE_FAILED',
    // F-20 缺口③ 安装事实的具名码（team-hub/pack-facts.mjs）。
    //
    // 账这一层的每一个拒绝都必须能说清**是哪一种坏**，因为它们的修法完全不同：
    // `PACK_FACT_MALFORMED` —— 记录本身缺字段/字段类型不对（调用方的问题）。
    // `PACK_FACT_UNKNOWN_KIND` —— 记录类型读不出来。**单独一个码**的理由：
    //   账里出现一个不认识的类型时，整本账的可信度取决于读的人敢不敢说
    //   "我不知道"；把它并进 MALFORMED，等于把一个未来的格式变化
    //   当成一次手滑。
    // `PACK_FACT_SEQ_CONFLICT` —— 另一个写入者抢先占了那个 seq（409）。
    //   文案必须说清"这次写入**没有**发生"，而且**绝不重编号**：
    //   重编号会静默改掉记录的顺序，而顺序是复盘时唯一能确定因果的东西。
    // `PACK_FACT_WRITE_FAILED` / `PACK_FACT_READ_FAILED` —— 兜底。
    //   写失败是 5xx、seq 冲突是 409：把磁盘错误报成 409 会让调用方
    //   **无限重试**同一个坏盘。
    'PACK_FACT_MALFORMED', 'PACK_FACT_UNKNOWN_KIND', 'PACK_FACT_SEQ_CONFLICT',
    'PACK_FACT_WRITE_FAILED', 'PACK_FACT_READ_FAILED',
    // F-19 冻结岗位包的具名码（team-hub/role-pack-store.mjs）。
    //
    // 这几个码的**状态码**也是有意的，不只是名字：
    // `ROLE_PACK_VERSION_CONFLICT` —— **409**。它不是"你请求写错了"，
    //   而是"这个身份已经被别的内容占了"。报 400 会让调用方以为格式不对，
    //   于是永远不去递增版本号，只会反复重试同一个请求。
    // `ROLE_PACK_SECTIONS_MISMATCH` —— 七类（含**顺序**）对不上。
    //   顺序单独成码，因为它不是"少写了一节"那种显眼错误：七节全在、
    //   只是顺序不同，而顺序是内容哈希的输入，于是同一份岗位包会有两个身份。
    // `ROLE_PACK_WRITE_FAILED` —— **500**。把磁盘错误报成 4xx 会让调用方
    //   放弃一个其实可以重试的写入。
    // `ROLE_PACK_RECORD_MALFORMED` / `ROLE_PACK_NOT_FOUND` / `ROLE_PACK_READ_FAILED`
    //   —— 形状错误、找不到、读失败。
    'ROLE_PACK_RECORD_MALFORMED', 'ROLE_PACK_SECTIONS_MISMATCH',
    'ROLE_PACK_VERSION_CONFLICT', 'ROLE_PACK_NOT_FOUND',
    'ROLE_PACK_WRITE_FAILED', 'ROLE_PACK_READ_FAILED',
    // F-18 经验图谱 / 摩擦学习的具名码（team-hub/experience-store.mjs）。
    //
    // ★ 这里**没有** `EXPERIENCE_SEQ_CONFLICT`（F-20 的账有）。
    //   F-20 的 seq 是应用层 `MAX(seq)+1` 算的，两个进程会抢同一个号；
    //   这一本用 `INTEGER PRIMARY KEY AUTOINCREMENT`——数据库分配，
    //   由 SQLite 自己串行化，所以"号被抢"不可能发生。
    //   登记一个永远抛不出的码，与登记一段被注释掉的代码是同一个东西，
    //   只不过前者让错误码清单看起来更完整。
    // `EXPERIENCE_DRAFT_ALREADY_SETTLED` —— **409**。它不是"请求写错了"，
    //   而是"这条草稿已经处置过了"。报 400 会让调用方去改请求体，
    //   而它该做的是去读那条草稿现在是什么状态。
    'EXPERIENCE_RECORD_MALFORMED', 'EXPERIENCE_KIND_UNKNOWN',
    'EXPERIENCE_DRAFT_NOT_FOUND', 'EXPERIENCE_DRAFT_ALREADY_SETTLED',
    'EXPERIENCE_WRITE_FAILED', 'EXPERIENCE_READ_FAILED',
    // F-21 连接器登记表的具名码（team-hub/connector-store.mjs）。
    //
    // `CONNECTOR_VERSION_CONFLICT` —— **409**，与 `ROLE_PACK_VERSION_CONFLICT`
    //   同一条理由，但后果更重：连接器声明说的是"一个**外部进程**能拿到什么权限"。
    //   报 400 会让调用方以为请求格式不对，于是永远不去递增版本号；
    //   而"同一个版本号对应两份权限不同的声明"意味着事后复盘时
    //   "当时放行了哪些工具"这个问题**不再有唯一答案**。
    // `CONNECTOR_TRANSPORT_UNKNOWN` / `CONNECTOR_TOOLS_EMPTY` /
    //   `CONNECTOR_TOOL_DUPLICATE` / `CONNECTOR_RECORD_MALFORMED` /
    //   `CONNECTOR_EVENT_MALFORMED` / `CONNECTOR_CIRCUIT_STATE_UNKNOWN`
    //   —— 400：调用方写错了请求（形状、封闭词表、必填项）。
    //   `CONNECTOR_EVENT_MALFORMED` 里有一条刻意的话：事件**必须点名**是哪个
    //   连接器。只记"某处发生了故障"时，一次隔离良好的单点故障与一次大面积
    //   故障长得一样。
    // `CONNECTOR_WRITE_FAILED` / `CONNECTOR_READ_FAILED` —— 500：
    //   本表没登记的内部码收敛到这里（不猜状态码）。
    //   ★ 这里**没有** `CONNECTOR_NOT_FOUND`：`getDeclaration` 找不到时返回
    //   `null`——那是一个正常读数（"这个连接器还没登记过"），不是错误。
    //   登记一个永远抛不出的码，与登记一段被注释掉的代码是同一个东西。
    'CONNECTOR_RECORD_MALFORMED', 'CONNECTOR_TRANSPORT_UNKNOWN',
    'CONNECTOR_VERSION_CONFLICT', 'CONNECTOR_TOOL_DUPLICATE', 'CONNECTOR_TOOLS_EMPTY',
    'CONNECTOR_EVENT_MALFORMED', 'CONNECTOR_CIRCUIT_STATE_UNKNOWN',
    'CONNECTOR_WRITE_FAILED', 'CONNECTOR_READ_FAILED',
    // PRT-610 工具调用账的读面（`GET /api/tool-calls*`，team-hub/server.mjs）。
    //
    // 这两个码是**读**路径上的，而读路径之所以需要具名码，是因为它们各自
    // 对应一个**不同的动作**：
    //
    // `TOOL_CALL_REPAIR_NEEDS_CALL_ID` —— **400**。值班的人问"这条拒绝该去改哪里"，
    //   而修复动作由**它的来源**决定（§6.8 line 480：策略拒绝与沙箱兜底的修法不同）。
    //   没有 callId 时唯一能做的就是猜，而猜错的修复动作会把人指向错误的文件。
    //   ★ 这里**不是** 404：404 的意思是"你要的那条记录不存在"，
    //   而这件事是"你没说是哪一条"——两者的下一步动作完全不同。
    //
    // `TOOL_CALL_NOT_FOUND` —— **404**。这次是"确实没有这条记录"，
    //   与上面那个码刻意分开：`0 与不知道必须分得开`。
    //   把它写成 400 会让调用方去改请求体，而它该做的是去查为什么这次调用
    //   根本没有落账（那本身就是一个应该被追的问题）。
    'TOOL_CALL_REPAIR_NEEDS_CALL_ID', 'TOOL_CALL_NOT_FOUND',
    // spec §6.7 凭证管理的**写**一半（team-hub/secret-admin.mjs）。
    //
    // 在它之前，`security/secrets/store.mjs` 的 put/rotate/remove 在整个仓库里
    // **零生产调用方**——有实现、有套件、有文档，而没有任何入口能触发它们。
    //   · STORE_UNAVAILABLE（管理面自有码）— 密钥库打不开。**不是"密钥不存在"**：
    //     说成后者会让用户去重新录入一把其实好端端躺在本机的钥匙。
    //     它是 503（现在没法提供这项服务），而写路径上**没有**明文降级——
    //     读路径上明文后端只是让人看到不该看的东西，写路径上它会把真实密钥落盘。
    //   · REF_INVALID / VALUE_EMPTY — 调用方写错了请求（400，先于状态检查）
    //   · NOT_FOUND — 轮换/删除一个没录入过的引用（404）。
    //     删除是例外：删一个不存在的引用是**幂等**的 false，不是 404——
    //     删除的意图是"让它不存在"，而它已经不存在了。
    //   · WRITE_FAILED — 本表没登记的内部码收敛到这里（503，不猜状态码）
    'SECRET_ADMIN_STORE_UNAVAILABLE', 'SECRET_REF_INVALID', 'SECRET_VALUE_EMPTY',
    'SECRET_NOT_FOUND', 'SECRET_STORE_WRITE_FAILED',
    // PRT-212 审批端口（team-hub/approval-port.mjs）的失败码。
    //
    // 它们是**这个端口**对外可见的名字，而端口要回答的问题恰恰是
    // "为什么这次审批问不到人"——所以每一个都必须是不同的一件事：
    //   · BAD_WIRING / BAD_POLL_INTERVAL — 接线错了（构造期就抛，不是运行期）
    //   · CHECK_FAILED                   — 审批箱不可达（**故障**）
    //   · INBOX_FAILED                   — 读审批箱失败或形状不对（**故障**）
    //   · UNKNOWN_STATUS / ROW_MALFORMED — 审批箱答了，但我们读不懂（**不可信**）
    //   · REQUEST_ID_MISSING             — 说好待批准却没给票号（批准之后消费不了）
    //   · ROW_VANISHED                   — 说好待批准的那一行查不到
    //                                      （**不是"还没人批"**，见该模块文件头 §二）
    //   · TTL_NOT_ANSWERED               — 等满了预算，没人处理（申请本身是好的）
    //   · ABORTED                        — 调用方撤回（不是任何一方的故障）
    //   · BAD_OPERATION                  — 投影造不出合法主体（桥那一层缺字段）
    //
    // 合并其中任何两个，都会让"连不上"与"等不到人"在日志上长得一样——
    // 而这两件事的排查方向完全相反。
    'APPROVAL_PORT_BAD_WIRING', 'APPROVAL_PORT_BAD_POLL_INTERVAL',
    'APPROVAL_PORT_BAD_OPERATION', 'APPROVAL_PORT_CHECK_FAILED',
    'APPROVAL_PORT_INBOX_FAILED', 'APPROVAL_PORT_UNKNOWN_STATUS',
    'APPROVAL_PORT_REQUEST_ID_MISSING', 'APPROVAL_PORT_ROW_VANISHED',
    'APPROVAL_PORT_ROW_MALFORMED', 'APPROVAL_PORT_TTL_NOT_ANSWERED',
    'APPROVAL_PORT_ABORTED',

    // PRT-214 续：审批端口**注册方**（`team-hub/approval-registrar-row.mjs`）的具名码。
    //
    // 这个模块在 DSH 进程里造审批端口，它的码会经 root 行透传进启动失败消息——
    // 也就是说，值班的人看到的第一行就是它。两个码是**两件不同的坏事**：
    //   · HUB_URL_MISSING      — 组合根没交来 hub 地址。没有审批箱可问。
    //     （真部署里通常先被组合根的 `ENFORCEMENT_ROOT_NO_HUB_URL` 拦下；保留它
    //      是为了直接调工厂的调用方也拿得到一个说得清"缺地址"的码，而不是 TypeError。）
    //   · HUB_IO_BAD_RESPONSE  — hub 客户端返回的不是 `{status, body}`。这是**接线错**，
    //     与"审批箱答了但我们读不懂"（`APPROVAL_PORT_UNKNOWN_STATUS`）不是一回事：
    //     合并两者会让一次适配器接错被记成"hub 升级换了状态串"。
    'APPROVAL_REGISTRAR_HUB_URL_MISSING', 'APPROVAL_REGISTRAR_HUB_IO_BAD_RESPONSE',

    // ── PRT-402：TeamPlan / EmployeeManifest 的具名错误码 ────────────────
    //
    // `team-hub/context-plan-store.mjs` 的 `CONTEXT_PLAN_ERRORS` 的值，加上
    // `server.mjs` 那六条新路由自己回的两个码（`MISSING_PARAM` 上面已登记）。
    //
    // 它们不是配置键：进程不"读"它们，而是把它们放进响应与错误对象给调用方看。
    // 名字是 SCREAMING_SNAKE，所以扫描器会怀疑它们是环境变量——不是。
    //
    // ★ 这一组有一条与上面各组都不同的性质：**状态码分两档**。
    //   `TEAM_PLAN_FROZEN` 是 409（请求合法，是**状态**不允许——要做的是发新版本），
    //   其余是 400/404（请求本身该改）。所以码在 `code`、状态码在 `statusCode`，
    //   调用方不该从 HTTP 状态反推该改哪儿。
    //
    //   > 一个"所有错误都回 400"的接口，与一个"按修复动作分档"的接口，
    //   > 在调用方只有一种修法的时候是同一个东西——只不过前者会让
    //   > "发一个新版本"（409）与"把 scope 填上"（400）看起来是同一种失败。
    'TEAM_PLAN_NOT_FOUND', 'TEAM_PLAN_INVALID', 'TEAM_PLAN_FROZEN',
    'EMPLOYEE_MANIFEST_NOT_FOUND', 'EMPLOYEE_MANIFEST_INVALID',
    // 明文密钥 fail closed 的码。**与 model-store 共用同一个判据**
    // （`findPlaintextSecrets`），但码不同：model 档案拒收与上下文来源拒收
    // 是两条不同的修复路径（前者改档案、后者改计划/清单正文）。
    'CONTEXT_SOURCE_PLAINTEXT_SECRET',
    // 缺 scope / 缺 role（或 employeeId）——"不猜"的两处。
    'CONTEXT_SOURCE_SCOPE_UNKNOWN',
    // `server.mjs` 的 `/api/team-plan?version=` 校验用。**故意不带前缀**：
    // 它的语义就是"这个查询参数不合法"，与 `MISSING_PARAM` 同族，
    // 而加 `TEAM_PLAN_` 前缀会让它看起来像 store 的错误码——
    // 那会让调用方以为要去看 store 的实现，而它只需改 URL。
    'BAD_VERSION',
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
