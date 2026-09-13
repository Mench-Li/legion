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
