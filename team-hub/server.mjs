#!/usr/bin/env node
/**
 * team-hub 独立服务（v2）—— 军团团队协作中枢，脱离 DSH webServer 独立进程运行。
 *
 * 用 node:sqlite（WAL）作为任务池 + 成员在线状态 + 审计日志的单一后端，
 * 暴露 HTTP API（任务 CRUD/状态机/乐观锁/scope 鉴权）+ SSE 事件流，多机器的
 * 守护（dsh-scrum-worker）、看板（dsh-scrum-board）经它读写同一任务池。
 *
 * 启动：node team-hub/server.mjs
 * 环境变量：
 *   TEAM_HUB_PORT  监听端口（默认 8787）
 *   TEAM_HUB_DB    SQLite 文件（默认 team-hub/team.db）
 *   TEAM_HUB_TOKEN 团队 token。token 三种携带方式（与 v1 serve.mjs 对齐）：
 *     Authorization: Bearer <t> / x-dsh-token: <t> / ?token=<t>（?token= 供 EventSource 等无法自定 header 的读订阅）。
 *     非空时写操作需 token；且非回环监听（TEAM_HUB_HOST ≠ 127.0.0.1/localhost/::1）时
 *     全部读端点与 SSE 同样需 token（P2-2 读面门禁，/api/config 能力探测除外）。
 *     本地回环开发模式读面保持开放（不回退）。
 *
 * API：
 *   GET  /api/board?scope=&status=&soldier=&role=   任务列表（SQLite，scope 一等字段）
 *   GET  /api/missions?scope=                       任务集聚合视图（scopeAware=true，真分区）
 *   GET  /api/scopes                                真实存在的分区（tasks+members 的 distinct scope）
 *   GET  /api/spaces                               工作空间列表（注册名 + private + 仓库绑定 localDir/remoteUrl）
 *   POST /api/spaces                               注册/更新工作空间（id/name/private/localDir/remoteUrl；幂等 upsert）
 *   POST /api/spaces/delete                        删除工作空间及 scope 数据（body: id + confirm=`delete-space:<id>`；拒绝 software/default）
 *   GET  /api/goal?scope=                          目标列表（**多目标并发模型**：scope 全部目标，每目标含 id/objective/
 *                                                   status(active|paused|done|canceled)/version/mode/docsDir + 按该目标链任务算的进度）
 *                                                   docsDir = 目标级分析文档目录（docs/<goalId>；NULL = 遗留目标沿用根 docs/ 槽位）
 *   POST /api/goal                                发布目标：每次**新建**一个目标并生成其独立阶段任务链（不取消既有目标/旧链）
 *   POST /api/goal/status                         目标状态迁移 {id,status}（active↔paused；done/canceled 终态；仅将军）
 *   POST /api/goal/slices                         切片展开（守护在 test-designer done 后注册切片束，幂等）
 *   GET  /api/activity?limit=                      最近动态（审计）
 *   GET  /api/members                              成员在线状态
 *   GET  /api/events                               SSE 事件流
 *   POST /api/create|claim|transition|advance|reassign|release-stale|comment|heartbeat   写操作（body 带 by + scope）
 *       —— create/目标链生成任务时**自动注入验收标准 + 边界**（做什么/不做什么，按岗位模板，
 *          stage-standards.mjs）；调用方可传自定义 acceptance/boundary 覆盖。
 *       —— reassign 转派 = soldier 与 role 一并改为目标岗位（转派后守护仍按新 role 自动接管执行）；
 *          POST /api/hold {id, hold} = 将军逐任务拦截（守护不得自动认领）/放行。
 *   POST /api/skills/register|review|grant|revoke   团队共享技能（scope-owned + grant/revoke；general 门禁；audit skill:* 带目标空间）
 *   GET  /api/skills[?scope=&member=&id=&include=]   技能查询（默认 published only；include=pending 仅 member=general 复审视角，草稿不外泄）
 *   GET/POST /api/rules[?scope=]                   分层规范-全局层（rules 表：global/space 分层 upsert；audit rules:update；S4/R-2）
 *   GET  /api/chat/health[?scope=]                对话健康聚合（守护在线/回复开关/模型解析链/最近失败；只读；S2/R-1）
 *   PUT  /api/chat/attachments?scope=&by=&fileName= 附件上传（raw UTF-8 文本 → staged；S3/R-3）
 *   GET  /api/chat/attachments/content?id=&conv=&scope= 附件内容取回（按会话归属校验；S3/R-3）
 *   GET/POST /api/chat/reply-settings             对话 AI 回复开关/模型/身份设置（per-scope；默认开；S9/R-4）
 *   GET  /api/chat/replies[?scope=&sinceMsgId=]    对话 AI 回复队列（awaiting 消息 + 最近上下文；超龄自动 failed）
 *   POST /api/chat/replies/answer|retry|fail       回复状态回写（CAS awaiting→replied/failed；幂等；S9/S10）
 *   GET/POST /api/chat/conversations|messages       对话中心（会话/消息；scope 分区；写 by 必填 + audit/SSE，见 S1）
 *   GET/POST /api/calendar/events                 日程日历事件（scope 过滤 + 日期窗 [from,to] 闭区间；写 by 必填 + audit/SSE，见 S5）
 *   POST /api/calendar/events/update              更新日程事件（局部更新 + scope 归属校验；audit calendar:update）
 *   POST /api/calendar/events/delete              删除日程事件（id + confirm=yes + scope 归属校验；audit calendar:delete）
 *   GET  /api/calendar/conflicts                  冲突检测（start/end/allDay/excludeId；返回重叠实例，仅提示不阻断）
 *   GET  /api/calendar/events/by-link             按 taskId/goalId 查关联日程（任务详情双向展示用）
 *   GET  /api/spaces/impact?id=                   删除预检（只读计数 + 在办任务列表；S7/R-3）
 *   GET  /api/spaces/provision?id=                开通预检（只读自检清单：流水线/编队一致性/守护在线/工作区绑定；SP-P0）
 *   GET/POST /api/pipeline[?scope=]               空间流水线（编队即流水线：阶段契约 + 执行配置；写仅 general；SP-P0）
 *   GET  /api/artifact/content?task=&i=            任务登记产物文件内容（R-3/S3 只读：md/txt 预览 + 截断/二进制降级 + 错误码 400/403/404 可区分）
 *
 * 状态机 + 乐观锁 + 角色纪律与 taskctl.mjs 一致；scope 是任务分区的一等字段。
 */
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standardsFor } from './stage-standards.mjs'
import { evaluatePermission, normalizeOperation } from './permission-engine.mjs'
import {
  APPROVAL_ATTEMPT_COLUMN,
  BINDING_HASH_COLUMN,
  BINDING_CODES,
  CONSUME_OUTCOMES,
  computeBindingHash,
  consumeBinding,
  ensureApprovalSchema,
  isBoundHash,
  operationOfRow,
  verifyBinding,
} from './approval-binding.mjs'
import {
  ALLOW_ONCE_CODES,
  CLAIM_OUTCOMES,
  claimOnce,
  ensureAllowOnceSchema,
  releaseClaim,
} from './allow-once.mjs'
import {
  APPROVAL_TTL_DEFAULT_MS,
  EXPIRE_OUTCOMES,
  evaluateApprovalExpiry,
  evaluateApprovalHeartbeat,
  leaseRenewalBoundMs,
  markApprovalExpired,
  resolveApprovalTtlMs,
} from './approval-ttl.mjs'
import { createRunStore, RunError } from './run-store.mjs'
import { MODEL_ERRORS, ModelError, createModelStore, ensureModelSchema } from './model-store.mjs'
import {
  BINDING_STORE_ERRORS, BindingStoreError, createBindingStore, ensureBindingSchema,
} from './binding-store.mjs'
import {
  BUDGET_ERRORS, BudgetError, createBudgetLedger, createPriceTableRegistry, ensureBudgetSchema,
} from './budget-ledger.mjs'
import { createPriceTable } from '../runtime/contracts/price-table.mjs'
import { modelConfigErrorFor, validateAgentModelSelection } from '../runtime/contracts/model-config.mjs'
// 模型探测（PRT-504 的实现，PRT-507 的「测试连接」）。**在此之前它没有任何非测试调用方**：
// 整套实现 + 两个套件 + 文档都在，而没有任何入口能触发它——
// **一个没有任何入口的功能，和一个不存在的功能，从用户角度看完全一样。**
import { createProbeService } from './probe-service.mjs'
// spec §6.7 的写一半：凭证的新增/更新/轮换/删除。读路径早已接上
// （`runtime/probe/secret-resolver.mjs`），写路径此前**零调用方**。
import { createSecretAdmin } from './secret-admin.mjs'
// PRT-506：把老的非敏感模型配置（agent_models）迁到档案 + 岗位绑定。
// **只搬能确定的东西**：老数据里没有 runtimeType、没有 endpoint、没有凭证，
// 三者都**不猜**——猜出来的档案会看起来可用，直到第一次运行才失败。
import { applyModelMigration, describeMigration, planModelMigration } from './model-migration.mjs'
// PRT-409：上下文快照的持久化与查看。
//
// 阶段 4 的完成标准是「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因」。
// 在写入这张表之前，那份快照只存在于一次函数调用的栈上——**没有持久化就无从查看**，
// 于是完成标准无法达成，无论装配器做得多对。
import { createContextStore } from './context-store.mjs'
// PRT-402：TeamPlan 与 EmployeeManifest 的数据面。**新建在独立模块**——
// 与 `run-store.mjs` / `context-store.mjs` 的方向一致，不再往 server.mjs 里堆表结构。
//
// ★ `CONTEXT_PLAN_ERRORS` 要在这里用，不是死导入：路由的 404 必须回**与 store
//   同一个常量**。第一版我在路由里手打了 `'TEAM_PLAN_NOT_FOUND'` 这个字符串，
//   于是同一个错误码有了两份字面量——而两份字面量迟早有一份改不到。
//
//   > 一个"路由手打错误码、store 定义错误码"的实现，
//   > 与一个"两边用同一个常量"的实现，在谁都没改过它的时候是同一个东西——
//   > 只不过前者会让一次码改名变成"store 报了新码、路由还在报旧码"，
//   > 而调用方按新码写的分支从此**永远不命中**。
import {
  CONTEXT_PLAN_ERRORS, createContextPlanStore, ensureContextPlanSchema,
} from './context-plan-store.mjs'
// PRT-409 右半部分：快照导出（自验证 + 离线可验）。
import {
  buildSnapshotExport, verifySnapshotExport, ContextExportError, CONTEXT_EXPORT_CODES,
} from './context-export.mjs'
// PRT-409 收尾：快照保留策略（时间/容量判据 + 墓碑）。
import { planSnapshotRetention } from './context-retention.mjs'
import { assembleContext, describeAssembly } from '../runtime/context/assembler.mjs'
import { createConservativeTokenizer, tokenizerForProfile } from '../runtime/context/tokenizer.mjs'
import { createLazyTokenizerRegistry } from '../runtime/context/tokenizer-registry.mjs'
// PRT-402~406：把系统里的真实对象归一成候选。**没有它，候选只能由调用方手工拼**——
// 而"装配器能装配"与"系统里的东西真的装配得进来"是两件事。
import { SourceError, collectCandidates } from '../runtime/context/sources.mjs'
import { createContextSource, SOURCE_TRUST } from '../runtime/contracts/context.mjs'
// 配置导入导出（PRT-508）：**导出永远不含密钥**。契约层负责"包里有没有
// 密钥"与"这包能不能导"，路由层只负责读写与把拒绝翻成状态码。
import {
  BUNDLE_ERRORS, BundleError, assertApplicable, buildBundle, planImport, validateBundle,
} from '../runtime/contracts/config-bundle.mjs'
// `/api/runtime/next-post` 用「这条任务后面还有没有岗位」这个判定。
// 与运行仓储里用的是**同一个**函数：两处各写一遍判定，迟早会出现
// "接口说有下一岗位、交接时却按链尾收口"这种不一致。
import { resolveNextPost } from '../orchestrator/pipeline/index.mjs'
import { columnExists as columnExistsImpl, ensureColumn as ensureColumnImpl } from './schema-util.mjs'
import { createEventDeliveryStore } from './event-delivery.mjs'
import {
  AUTOMATION_ERRORS,
  createAutomationStore,
  ensureAutomationSchema,
  projectOccurrences,
} from './automation-store.mjs'
import { createCompactionStore, ensureCompactionSchema } from './compaction-store.mjs'
import {
  appendExperienceRecord,
  draftCounts,
  ensureExperienceSchema,
  experienceAccount,
  experienceRecords,
  exportExperience,
  settleDraft,
} from './experience-store.mjs'
import {
  appendIncident,
  connectorCounts,
  connectorIncidents,
  connectorRegistrations,
  ensureConnectorSchema,
  exportConnectors,
  freezeDeclaration,
  getDeclaration,
} from './connector-store.mjs'
import {
  ROLE_PACK_STORE_ERRORS,
  ensureRolePackSchema,
  exportRolePacks,
  freezeRolePack,
  getRolePack,
  listRolePacks,
  rolePackCounts,
} from './role-pack-store.mjs'
import {
  PACK_FACT_ERRORS,
  appendPackFact,
  ensurePackFactSchema,
  exportPackFacts,
  packAccount,
  packFactCounts,
  packFacts,
} from './pack-facts.mjs'
import { ROLLUP_DIMENSIONS, rollupBy, usageTotals } from './usage-rollup.mjs'
import { loadConfig } from '../packages/shared/src/config.mjs'
import { SCHEMA as CONFIG_SCHEMA } from './config-schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// P3-2 统一配置：核心项（host/port/token/db）经统一引擎解析——优先级 CLI > env > 默认，
// 类型/范围/枚举校验，非法值报错退出（不静默回退），并把脱敏摘要打出来。
// 其余 CHAT_*/MAX_RULES_LEN 等键仍按原样读取，但**已在 schema 中声明**（scan --check 强制），
// 其默认值由 scripts/config/config.test.mjs 做漂移比对。
const CFG = loadConfig(CONFIG_SCHEMA, { env: process.env, argv: process.argv.slice(2) })

/**
 * PRT-615：审批 TTL（spec §6.4）。
 *
 * 配置值非法时**装载时抛错**，不静默回落默认值——一条写错的
 * `LEGION_APPROVAL_TTL_MS` 如果被静默换回默认值，表现是"配置改了但没生效"，
 * 而这类问题的排查方向完全错误（运维会去看配置有没有被加载，而不是看那个值本身）。
 *
 *   > 一个「配置写错了就用默认值继续」的解析，
 *   > 与一个「配置项根本没接线」的解析，在「改了到底有没有用」上是同一个东西。
 *
 * ★ PRT-413 修正：这里原本读的是 `CFG.approvalTtlMs`，而解析后的值在
 *   **`CFG.values`** 下面（`loadConfig` 返回 `{values, sources, errors, ...}`）。
 *   于是 `CFG.approvalTtlMs` 恒为 `undefined`，而 `resolveApprovalTtlMs`
 *   把 `undefined` 当成"用默认值"——**这条配置从来没有生效过**。
 *
 *   这正是上面那段注释所警告的那种失败，而它偏偏发生在写那段注释的同一个地方：
 *   `values.dbFile` / `values.port` / `values.token` / `values.host` 都是对的，
 *   只有这一处漏了 `.values`——**一个在四行正确代码里错了一行的解析**。
 *
 *   > 一个"配置声明了、校验了、文档写了、但取值时少了一层"的接线，
 *   > 与一个"配置完全没接线"的实现，在用户改了配置之后是同一个东西——
 *   > 只不过前者会让那条配置**看起来是支持的**（它有 schema、有区间校验、
 *   > 有 `/api/config` 之外的文档），于是没人会去怀疑它。
 */
const APPROVAL_TTL_MS = resolveApprovalTtlMs(CFG.values.approvalTtlMs)
/** 本模块是「被 node 直接运行」还是「被 import」。
 *  为什么必须区分：本文件既作 CLI 入口，也被宿主外壳 `team-hub/src/index.ts`（L70 `import('../server.mjs')`）
 *  与大量契约测试 import。若在 import 路径上 `process.exit(1)`，一处配置错误会**直接杀掉宿主进程/测试进程**，
 *  调用方连报告与降级的机会都没有（P3-2 首版即如此，属真实危险）。因此：
 *    - 入口 → 打印错误 + exit 1（CLI 语义，启动脚本能拿到非零码）
 *    - 被 import → 抛错（调用方有栈可查、可决定降级/跳过） */
const IS_ENTRY = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  const a = resolve(entry)
  const b = fileURLToPath(import.meta.url)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
})()
if (CFG.errors.length) {
  for (const e of CFG.errors) console.error(`[config] team-hub 配置错误：${e.message}`)
  console.error('[config] 用 `node scripts/config/check.mjs --process=team-hub` 查看完整配置面')
  if (IS_ENTRY) process.exit(1)
  throw new Error(`team-hub 配置无效：${CFG.errors.map((e) => e.message).join('；')}`)
}
for (const w of CFG.warnings) console.error(`[config] team-hub 配置告警：${w.message}`)

// 语义与改造前一致：显式提供（env/CLI）时**按原样使用**（相对路径交由 OS 按 cwd 解析），
// 未提供时才回退到仓库根下的默认库路径。
const DB_FILE = CFG.sources.dbFile === 'default' ? join(ROOT, 'team-hub', 'team.db') : String(CFG.values.dbFile)
/** 默认库路径（P1-1：宿主插件未显式配置 dbPath 时与独立进程同库，保证单数据池）。 */
export const DEFAULT_DB_FILE = DB_FILE
// S3/R-3（决策 E1）：聊天附件落盘目录与库同基（TEAM_HUB_DB 所在目录的 uploads/ 下）。
// 测试临时库 → uploads 自动落在 mkdtemp 内（TC-S3-16 隔离断言）；live 库目录零写入纪律不受影响。
const UPLOADS_ROOT = join(dirname(DB_FILE), 'uploads')
const PORT = CFG.values.port
const TOKEN = CFG.values.token
const HOST = CFG.values.host
/** 启动时打印的脱敏配置摘要（含实际生效的 DB 路径）；供日志与故障排查使用，绝不包含 token 原文。 */
export function configSummaryLine() {
  return `${CFG.summary} dbFile=${DB_FILE}`
}

export function isLoopbackHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

/**
 * 远程监听是否需要读面鉴权（P2-2）：
 * 非回环监听 + 已配置 token → 全部 /api/* 读端点与 SSE 都必须携带 token；
 * 本地回环（无论是否配 token）→ 读面保持开放（开发体验不回退；写面仍按 token 有无门禁）。
 */
export function readAuthRequired({ host = HOST, token = TOKEN } = {}) {
  return !isLoopbackHost(host) && String(token ?? '').trim() !== ''
}

export function validateSecurityConfig({ host = HOST, token = TOKEN } = {}) {
  const normalizedHost = String(host ?? '').trim().toLowerCase()
  const loopback = isLoopbackHost(normalizedHost)
  if (!loopback && String(token ?? '').trim() === '') {
    throw new Error('TEAM_HUB_TOKEN 必须配置：team-hub 非回环监听禁止空鉴权')
  }
  return { host: normalizedHost || '127.0.0.1', authenticated: String(token ?? '').trim() !== '' }
}

const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']
const TRANSITIONS = {
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'todo', 'in_progress', 'blocked', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: ['in_progress', 'canceled'],
  canceled: [],
}
const PRIORITIES = ['high', 'medium', 'low']

// ── SQLite ──
mkdirSync(dirname(DB_FILE), { recursive: true })
const db = new DatabaseSync(DB_FILE)
// busy_timeout 先设：普通写事务（BEGIN IMMEDIATE）靠它等待数据库锁，实测生效
// （另一连接持锁时按预算等待后成功）。注意它**不覆盖**下面那条 journal_mode 切换——原因见 enableWal。
db.exec('PRAGMA busy_timeout = 5000')
enableWal()

/**
 * PRT-607 审批箱：为一次进入 `AwaitingApproval` 的迁移**建出一条真的待批准请求**。
 *
 * 它是 `createRunStore` 的 `createApproval` 端口，会在**运行仓储的事务里**被调用
 * （同一个连接、同一个 `BEGIN IMMEDIATE`）。因此这里**不能**再用本文件的 `withTx`
 * ——那会把 `BEGIN IMMEDIATE` 发第二次（两个 `withTx` 各记各的账），SQLite 直接报
 * "cannot start a transaction within a transaction"。与 `createTaskInTx` 是同一条纪律。
 *
 * 绑定用的操作是**合成**的：这次等待往往不是一次工具调用，而是"结果等着人工批准"，
 * 没有调用方给的 operation。`target` 取 attemptId，让每条 Attempt 的待批准请求彼此
 * 独立——用 taskId 会让重试后的新尝试复用上一条的审批，而那正是 PRT-615 反复强调的
 * "审批算错了依据"。
 *
 * `atMs` 用运行仓储给的权威时间（不是 `Date.now()`）：TTL 的截止时刻必须与
 * `run_attempts.updated_at_ms` 同源，否则"审批什么时候到期"会有两个说法。
 */
function createAwaitingApprovalInTx({ attemptId, taskId = null, scope = null, returnTo = null, atMs = null, context = {} } = {}) {
  const operation = normalizeOperation({
    scope: scope ?? 'default',
    actor: 'system:awaiting-approval',
    action: 'runtime:delivery-approval',
    target: String(attemptId),
    taskId: taskId ?? null,
    unattended: false,
    metadata: { returnTo: returnTo ?? null, reason: context?.detail ?? null },
  })
  // 幂等：这条 Attempt 已经有一条开放（pending/approved）的审批行时复用它，不再插第二条。
  // 同一个 Attempt 短时间内两次进入 AwaitingApproval（重放 / 重扫）不该产生两条待办
  // ——那会让人批准其中一条，而另一条永远挂着，Attempt 也就永远等不到收口。
  const open = db
    .prepare(`SELECT requestId, ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE ${APPROVAL_ATTEMPT_COLUMN}=? AND status IN ('pending','approved') ORDER BY createdAt DESC`)
    .get(attemptId)
  if (open !== undefined && open !== null) {
    return Object.freeze({ requestId: open.requestId, bindingHash: open.h, reused: true })
  }
  const bindingHash = computeBindingHash(operation)
  const boundMs = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const requestId = `perm-await-${attemptId}`
  db.prepare(
    `INSERT INTO permission_requests (requestId,scope,actor,action,target,taskId,operation,mode,status,createdAt,expiresAt,${BINDING_HASH_COLUMN},${APPROVAL_ATTEMPT_COLUMN})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    requestId, operation.scope, operation.actor, operation.action, operation.target,
    operation.taskId, JSON.stringify(operation), 'ask', 'pending',
    new Date(boundMs).toISOString(), boundMs + APPROVAL_TTL_MS, bindingHash, attemptId,
  )
  return Object.freeze({ requestId, bindingHash, reused: false })
}

/**
 * 运行实体仓储（PRT-302/303/313）。
 *
 * 与上面那些**看板**写操作的关键差别：这里的每一次写入都带 `leaseEpoch`，
 * 且时间只认本进程的时钟。看板操作是「人在指挥台点一下」，
 * 运行操作是「一个可能已经死掉的 worker 在说话」——对后者必须能拒绝。
 *
 * 接在这一个文件里（而不是新建服务）是因为它必须是**同一个库、同一个事务域**：
 * 领取要用 `BEGIN IMMEDIATE` 与看板任务表竞争同一把写锁，
 * 分成两个进程/两个库就不可能做到「同一条任务只被领一次」。
 */
const runStore = createRunStore({
  db,
  // PRT-308 交接要**建出下一岗位的任务**并读流水线，而 `tasks`（30 个列）与
  // `space_stages` 的 schema 属于本文件。注入而不是让运行仓储去认识它们——
  // 但它们会在运行仓储的事务里被调用（同一个连接），因此
  // 「建后继任务」与「本尝试收口」是**一个事务**。spec 第 333 行要的
  // 「原子创建/释放下一岗位任务」就是这件事。
  //
  // `readPipeline` 返回的是一个视图对象，这里取它的 `stages`：
  // 运行仓储只想知道"有哪些岗位、各自的 next 是谁"。
  // 注意 `readPipeline` 默认 `includeDisabled: true`——这是**必须**的，
  // 因为一个被停用的下一岗位必须能被识别成"链断了"，
  // 而不是"根本查不到这个岗位"（两者都要报错，但理由不同）。
  // `createTaskInTx` 而不是 `createTask`：交接已经在运行仓储的事务里了，
  // 再开一个会把 `BEGIN IMMEDIATE` 发第二次（两个 `withTx` 各记各的账）。
  createTask: (payload) => createTaskInTx(payload),
  readPipeline: (scope) => readPipeline(scope).stages,
  // PRT-607 审批箱：进入 `AwaitingApproval` 必须在同一次事务里建出一条待批准请求，
  // 否则一条任务会停在"等待审批"而**没有任何东西可批**——界面上它是一个待办，
  // 而人会一直等下去。`permission_requests` 的 schema 属于本文件 / approval-binding.mjs，
  // 所以那一行由这里注入的端口写（运行仓储不认识它）。
  createApproval: (payload) => createAwaitingApprovalInTx(payload),
  // ★ PRT-214 第二步：**这次 Run 的权限档位**在认领时定下来。
  //
  // 来源就是员工清单那一行——它住在本文件同一个 `db` 上，但它的列与
  // "清单是内容、不是授权"这条纪律属于 `context-plan-store.mjs`，
  // 所以那一行由这里注入的端口读（与 `createApproval` 完全同一个模式）。
  //
  // 三件刻意的选择：
  //
  //   · **岗位从 `tasks` 那一行读**。`run_attempts` 上没有 `role`
  //     （它的列里根本没有这一项），所以"这次是哪个岗位"只有本文件知道
  //     ——`tasks` 的 30 个列属于这里。而 hub 的编队本来就是按 role 的
  //     （`roster(scope, role)`），`putEmployeeManifest` 的唯一键也是
  //     `(scope, role)`。凭空传一个 employeeId 去查，会让"查不到"与
  //     "清单不存在"变成同一个读数。
  //   · 查不到就返回 `null`——**正常结果**，不是错误。它让租约上
  //     没有权限字段，worker 那侧具名拒绝（`run-floor-permissions-missing`）。
  //     绝不返回 `{allowedTools: []}`：那个形状说的是"这个员工不能用任何工具"。
  //   · `approvalPolicy` **原样带出去、不解释**：它在这一侧是自由文本，
  //     翻成执行面的 preset 是执行面那一侧的事（`executor.mjs` 的
  //     `permissionsFromLease`），因为只有那一侧知道 preset 的闭集。
  resolveRunPermissions: ({ taskId, scope }) => {
    const task = db.prepare('SELECT role FROM tasks WHERE id = ?').get(taskId)
    const role = task?.role
    if (typeof role !== 'string' || role.trim() === '') {
      // 这条任务没有被指派给任何岗位。不是 `null`（"清单不存在"），
      // 而是调度上的另一个问题——但两者对 worker 是同一件事（没人告诉它
      // 这次能干什么），所以这里同样返回 `null`。
      return null
    }
    const manifest = contextPlanStore().readEmployeeManifest({ scope, role })
    if (manifest === null || manifest === undefined) return null
    return {
      allowedTools: manifest.allowedTools,
      deniedTools: manifest.deniedTools,
      approvalPolicy: manifest.approvalPolicy,
    }
  },
})

/**
 * F-16 自动化计划仓储（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.4）。
 *
 * 与 `runStore` 同一个库、同一个连接，理由也同一个：物化一次运行会去建
 * 任务/Attempt（或至少要在同一个事务域里推进"计划的 next"），
 * 分成两个库就不可能做到"一条计划在同一时刻只物化一次"。
 *
 * 本对象只**持有**仓储。真正的调度 tick 与 HTTP 路由在下面各自的段落里，
 * 因为"什么时候该 tick"是进程生命周期的事，不是仓储语义的事。
 */
const automationStore = (() => {
  // 建表**显式**放在这里，不像 `runStore` 那样藏在构造函数里：
  // 自动化那两张表有一条 `UNIQUE(schedule_id, planned_at_ms)` 与三条
  // 老库补列，而"表在不在"是排查"为什么物化不生效"时的第一个问题。
  // 显式一行让它在这份文件里可 grep 到。
  ensureAutomationSchema(db)
  return createAutomationStore({ db })
})()

/**
 * F-16 调度 tick 的**唯一**实现，供 HTTP 路由（显式 `POST /api/automation/tick`）
 * 与 `isMain` 下的定时器共用。
 *
 * 为什么两处共用一个函数而不是各写一遍：定时器那条路**在生产上没人看着**，
 * 而路由那条路是有人在测的。两份实现里的任何一处漂移（比如定时器那份忘了
 * 传 `scope`）都会表现为"手动 tick 是对的、自动 tick 是错的"，
 * 而后者只在生产上发生。
 *
 * **不抛**：一个把整个 team-hub 主循环带死的调度 tick，比"这一次没物化"
 * 坏得多——而"这一次没物化"是下一轮 tick 会自己修好的。
 */
/**
 * 到点的计划 → 物化运行 → **可领取的任务**。
 *
 * 这是 `wired:false` 的收口。在此之前本函数返回
 * `{ wired: false, note: '……需要计划→目标的映射（未接线）' }`：它建出了
 * `scheduled` 状态的运行行，而没有任何东西会去跑它们。那个读数是对的，
 * 但一个"记录了一堆没人执行的运行"的日历，与一个真正的调度器，
 * 在运行历史里长得一样——都是每天一行。
 *
 * 现在补上那一步，方法有两条**都要守住**的纪律：
 *
 * ① **物化与建任务是两步，且各自幂等**。
 *    `materializeDue()` 靠 `UNIQUE(schedule_id, planned_at_ms)` 幂等；
 *    建任务靠 `bindTask` 的 CAS（`WHERE task_id IS NULL`）幂等。
 *    把两步合成一个事务会让"任务建好了但运行行没写上"变成一个
 *    无法自愈的状态；分开之后，下一轮 tick 会看到那条运行仍然
 *    `task_id IS NULL` 并把它补上。
 *
 * ② **一条计划没配 payload 时就只物化、不建任务**，且这不是错误。
 *    纯提醒型的计划是合法用法。**绝不**建一个标题为空的占位任务：
 *    那会让 worker 领到一张写着"要做点什么"的卡——而它只能靠猜。
 *
 * ★ 建任务走 `createTask()`（`server.mjs` 里那个**唯一**的对外入口），
 *   不自己拼 INSERT。任务的验收标准、目标归属、状态词表校验都在那里；
 *   绕过它去写 `tasks` 表就是让第二份校验规则开始漂移。
 */
function automationTick({ scope = null, nowMs = null, limit = null } = {}) {
  try {
    const r = automationStore.materializeDue({
      scope,
      nowMs,
      ...(Number.isSafeInteger(limit) && limit > 0 ? { limit: Math.min(limit, 2000) } : {}),
    })
    if (r.ok !== true) return { ...r, wired: true, tasksCreated: 0, taskErrors: [] }

    let tasksCreated = 0
    const taskErrors = []
    // 只处理**刚物化出来**的那些（`action === 'materialized'`）。
    // 不去扫全表补建历史遗留：那会让一次 tick 顺手建出几百张卡，
    // 而那些卡对应的运行可能早就过期了。
    for (const item of r.results ?? []) {
      if (item.action !== 'materialized' || item.runId === undefined) continue
      const run = automationStore.runOf(item.runId)
      if (run === null || run.taskId !== null) continue
      const sched = automationStore.scheduleOf(run.scheduleId)
      const payload = sched?.payload ?? null
      if (payload === null) continue   // 纯提醒型计划：只物化，不建任务
      try {
        // scope 取**计划的 scope**，不取调用方传的：一条计划属于哪个空间
        // 在它被创建时就定了，而 tick 的 scope 只是"这一轮扫哪些空间"。
        const task = createTask({
          title: payload.title,
          description: payload.description ?? '',
          role: payload.role ?? null,
          priority: payload.priority ?? 'medium',
          status: 'todo',
          scope: sched.scope,
          goalId: payload.goalId ?? null,
        })
        const b = automationStore.bindTask(item.runId, task.id)
        if (b.bound === true) tasksCreated += 1
        else {
          // 没绑上：要么并发已经绑了（不是错误，报出来即可），
          // 要么 CAS 抢输了。两种情况都要让调用方看得见——
          // 静默当作成功会让"这条运行永远不会被执行"没有任何痕迹。
          taskErrors.push({ runId: item.runId, taskId: task.id, code: 'BIND_NOT_APPLIED', reason: b.reason })
        }
      } catch (e) {
        // ★ 建任务失败**不中断整轮 tick**：一个坏 payload 不该让
        //   这一批里其它计划全部不物化。逐条记账，下一轮会重试。
        taskErrors.push({
          runId: item.runId,
          code: e?.code ?? 'SCHEDULE_TASK_CREATE_FAILED',
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    return {
      ...r,
      // ★ `wired: true` 的含义是"物化出来的运行**有机会**被执行"，
      //   不是"它们都跑起来了"。真正的执行仍要 worker 去认领那些任务。
      wired: true,
      tasksCreated,
      taskErrors,
      note: r.results?.some((x) => x.action === 'materialized')
        ? '物化的运行已按计划的任务模板建出可领取任务'
        : '本轮没有物化出新运行',
    }
  } catch (e) {
    return { ok: false, atMs: nowMs ?? Date.now(), code: e?.code ?? 'AUTOMATION_TICK_FAILED', error: e instanceof Error ? e.message : String(e), results: [] }
  }
}

/**
 * F-17 长会话压缩仓储（§4.3「不可变原文 + 版本化摘要 + 引用回原文」）。
 *
 * 与 `contextStore` 的分工（这一条决定了它不能合并进那一个）：
 * `context-store` 存的是**一次 Run 的上下文快照**（按 attemptId 定位、
 * 不可变、带哈希）；本对象存的是**一段会话的压缩产物**（按 session 定位、
 * 有版本、原文永久保留）。合成一个会让"压缩把快照改了"变成可能——
 * 而快照的第一条纪律就是不可变。
 */
const compactionStore = (() => {
  ensureCompactionSchema(db)
  return createCompactionStore({ db })
})()

/**
 * 能力包安装事实（F-20 缺口③，spec §4.4）。
 *
 * 这张表存的是 `runtime/packs/store.mjs` 产出的**记录**，不是"当前装了什么"。
 * 那一层已经定下"记录是唯一的账、`stateOf()` 是账的推导"，所以控制面这边
 * 再存一份推导结果就会有两份真相——而它们漂移的那一天，
 * "账上写着装了、表上写着没装"没有任何东西能判定谁对。
 *
 * 于是这里只做两件事：**追加**记录，以及**把整本账交出去**
 * （`packAccount()` 的形态就是 `createPackStore({ history })` 认的那个）。
 * 推导只有一处实现。
 */
ensurePackFactSchema(db)

/**
 * F-19：冻结的岗位包。
 *
 * 主键 `(scope, role_pack_id, version)` —— **多版本共存**是"冻结"的全部含义。
 * 它与 `employee_manifests`（主键 `(scope, role)`、就地更新、"这个岗位**现在**
 * 是什么"）是两张表，因为"现在是什么"与"当时是哪一版"是两个问题：
 * 把后者塞进前者，第二次修改就会把第一次的答案覆盖掉。
 */
ensureRolePackSchema(db)

/**
 * F-18：经验图谱 / 摩擦学习。
 *
 * 一本**只追加**的记录流（`experience_records`），事件种类封闭：
 * node / edge / retract / draft / promote / discard。
 * "图现在长什么样"与"这条草稿现在是什么状态"都是它的**推导**——
 * 所以这张表没有 UPDATE 路径，也没有"保存整张图"的接口。
 */
ensureExperienceSchema(db)

/**
 * F-21 连接器登记表。
 *
 * 两张表，都是**只追加**：`connector_registrations`（按内容哈希冻结的声明）
 * 与 `connector_incidents`（点名的熔断事件）。
 *
 * ★ 这里**不**去 import 执行面的 `runtime/connectors/registry.mjs` 来校验：
 * 单向产品边界不允许，而且"放不放过去"是执行面的判断——
 * 控制面只负责记住"当时声明的是什么"。
 * 两边的词表由 `connector-store.test.mjs` 用例①**从执行面源码里抽出来**
 * 逐字比对钉住（再抄一遍互相核对时，两边一起写错它全绿）。
 */
ensureConnectorSchema(db)

/**
 * 模型档案仓储（PRT-501，spec §6.6）。
 *
 * 审计注入 `audit(...)`：`model-store.mjs` 不认识 `audit` 表 30 个列的 schema，
 * 但它知道**审计载荷不得含密文**——那条守卫在仓储里，在调用写入器之前。
 *
 * `actor` 在这里被映射到 audit 的 `member`，`scope` 固定为 `'*'`：
 * 模型档案是**跨空间**的产品级配置（同一个模型可以被任何空间的岗位绑定），
 * 因此它不该被塞进某个空间的审计视图里假装属于那个空间。
 */
// 探测服务（PRT-507）。懒构造：不点「测试连接」就不解析布局、不开密钥库。
let probeServiceInstance = null
function probeService() {
  if (probeServiceInstance === null) probeServiceInstance = createProbeService({ env: process.env })
  return probeServiceInstance
}

// 凭证管理（spec §6.7 的写一半）。同样懒构造——不录密钥就不开密钥库。
//
// **`onCredentialsChanged` 就是 `invalidate()` 一直缺的那个调用方。**
// `probe-service.mjs:39` 写着「提供一个 `invalidate()` 由轮换/修改凭证的路径调用」，
// 而它从来没有被调用过：写路径不存在，两条线一直在互相等。
//
// 缓存里存的是**上一次探测的结论**，而结论是按当时那把钥匙得出的。
// 轮换完密钥、界面点「测试连接」，若不失效就会拿到**用旧钥匙得出的旧结论**
// ——而它看起来完全像一次新的验证。
let secretAdminInstance = null
function secretAdmin() {
  if (secretAdminInstance === null) {
    // 只传 env。**接线的默认值就是生产值**（见 `createHubSecretAdmin` 的
    // `getProbeService`）：默认参数指向真实的懒构造访问器，而不是在这里
    // 再写一遍 `probeService().invalidate()`——上一版正是那样写的，
    // 结果是**接线藏在三行访问器里，而任何用例都覆盖不到那三行**。
    secretAdminInstance = createHubSecretAdmin({ env: process.env })
  }
  return secretAdminInstance
}

/**
 * 装上凭证管理面，并把**「凭证变了 → 探测缓存失效」**这条线接起来。
 *
 * ## 为什么它是导出的，而且默认参数就是生产值
 *
 * 这是本特性唯一一处"把两块各自有套件的东西接起来"的地方：
 * `secret-admin.mjs` 负责在写成功之后喊一声，`probe-service.mjs` 负责
 * 把缓存丢掉——而"喊"与"丢"之间那根线，属于**没有任何一块自己的套件能看见**的接缝。
 *
 *   > 一个没有证据的接线，与一根没接的线，在"能不能用"上是同一个答案。
 *
 * 所以注入点放在**探测服务实例**上，而不是放在"失效回调"上：
 *
 *   ✗ 上一版：`server.mjs` 传 `probeInvalidate: () => probeService().invalidate()`。
 *     那让接线本身落在访问器里，而用例只能验一个**被整体替换掉的**回调——
 *     把那一行改成 `null`、或者干脆删掉，全部用例照样绿。
 *   ✓ 现在：接线写在本函数里（被用例覆盖），默认取真实探测服务；
 *     用例只替换 `getProbeService` 返回的**那个对象**。
 *
 * `probeServiceInstance === null` 时**不构造**探测服务：没点过「测试连接」
 * 就为了失效而开一次密钥库是白花代价，而"缓存本来就是空的"与"缓存被清了"
 * 在这里是同一个结果（都没有可用结论）。
 *
 * @param {object} deps
 * @param {object}   [deps.env]
 * @param {Function} [deps.getProbeService]     探测服务访问器（默认 = 生产线）
 * @param {Function} [deps.openSecrets]         `openProductSecrets` 的注入点（用例用）
 * @param {Function} [deps.resolveLayoutImpl]   `resolveLayout` 的注入点（用例用）
 * @param {Function} [deps.onAudit]             覆盖默认的审计转发
 */
export function createHubSecretAdmin({
  env = process.env,
  getProbeService = () => probeServiceInstance,
  openSecrets = null,
  resolveLayoutImpl = null,
  onAudit = null,
} = {}) {
  const deps = {
    env,
    // ACL 加固的目标主体。**不猜**：猜错就是"给了别人权限"（fail open）。
    // 与 `product/secrets.mjs` 同一条纪律——拿不到就如实报"没加固"。
    owner: resolveSecretsOwner(env),
    onCredentialsChanged: () => {
      // 这里的 try 只兜**访问器自己抛**。`invalidate()` 抛出的异常**不在这里兜**：
      // "失效失败不能把一次成功的写入报成失败"这条规则只在 `secret-admin.mjs`
      // 里写一处。两处都写的话，两处会各自演化，而**只有一处会真的生效**
      // （外层那个先兜住）——于是另一处变成一段永远不执行的死代码，
      // 而它看起来像一道防线。
      let svc
      try {
        svc = getProbeService()
      } catch {
        return 0
      }
      // 还没构造过探测服务 → 没有缓存可失效。**不为了失效去构造一个**。
      if (svc === null || svc === undefined) return 0
      return svc.invalidate()
    },
  }
  if (openSecrets !== null) deps.openSecrets = openSecrets
  if (resolveLayoutImpl !== null) deps.resolveLayoutImpl = resolveLayoutImpl
  deps.onAudit = onAudit ?? ((event) => {
    // 密钥库自己的审计（载荷已被白名单限死为 action/ref/at/purpose）→
    // 汇进 hub 的审计流，于是"谁在什么时候加/换/删了哪把钥匙"进得了审计视图。
    // **审计里没有值、也没有密文**：这条路径上不存在能带上密钥的字段。
    try {
      audit('system', '*',
        `secret:${String(event?.action ?? 'unknown').replace(/^secret\./, '')}`,
        null, { ref: event?.ref ?? null, purpose: event?.purpose ?? null })
    } catch { /* 审计写不进去不该让一次成功的凭证操作失败 */ }
  })
  return createSecretAdmin(deps)
}

/**
 * ACL 加固要授权给哪个主体。
 *
 * Windows 上 `icacls` 的输出**不标出**所有者，所以要显式给出。这里取
 * `USERDOMAIN\USERNAME`——它就是当前进程的账户，也正是密钥库文件的所有者。
 * spec §6.7 说的"Launcher / hub / Workbench / DSH 以同一个 Windows 用户运行"
 * 正是这个前提。
 *
 * **不给 env 覆盖开关。** 第一版写了一个 `LEGION_SECRETS_OWNER`，删掉的理由是
 * 它开了一条 fail-open 的路：把一个主体**别人**的名字填进去，
 * `hardenFileAcl` 就会照着授权——而"给错人权限"是这一层唯一不可接受的失败方向。
 * 派生自 OS 变量没有这个口子：拿不到就是拿不到。
 *
 * **取不到就返回 `null`**，于是 `hardenFileAcl` 如实报"不知道所有者，无法收紧"。
 * 这不影响密钥库可用（DPAPI 保护的仍然是内容），但它**不会**看起来像已加固。
 */
function resolveSecretsOwner(env = process.env) {
  const user = env.USERNAME ?? env.USER ?? null
  const domain = env.USERDOMAIN ?? null
  if (typeof user !== 'string' || user === '') return null
  if (typeof domain === 'string' && domain !== '') return `${domain}\\${user}`
  return user
}

// PRT-409：上下文快照存储。惰性建表（与 probeService 同一手法），
// 因为模块顶层建表会让 `import` 这个文件本身就产生副作用。
let contextStoreInstance = null
/**
 * 精确 tokenizer 的注册表（PRT-413）。
 *
 * 在此之前这里是一个硬编码的空 `Map`，注释写着"有词表时在这里
 * `set(model, defineExactTokenizer({ ... }))` 即可"——那句话把"精确"永远挂在
 * **别人来改这段代码**上。
 *
 *   > 一个"留了接入点、但没有任何东西能走进去"的注册表，
 *   > 与一个"根本没有注册表"的实现，在没人提供词表的时候是同一个东西——
 *   > 只不过前者会让"精确 tokenizer 这条路径"看起来是**通的**。
 *
 * 现在它是一个**惰性装载器**：`LEGION_TOKENIZER_DIR` 下的 `*.tokenizer.json`
 * 在第一次真正需要时读盘、校验、算 sha256 并按 `model` 注册。
 * 词表仍然必须由使用者提供（零依赖 + 数据许可），但"提供"到"用上"之间
 * **不再需要改代码**。
 *
 * ★ 坏产物**让装载失败而不是被跳过**（见 tokenizer-registry.mjs）。
 *   跳过会让运维把"这个模型的预算是精确的"当成事实，而它其实在用保守估算。
 *
 * ★ 这里**不吞掉**装载异常：`get()` 会把它抛出去，于是那次请求失败、
 *   栈里有文件路径与原因。一个"读不到词表就悄悄用估算"的实现，
 *   会让 `tokens.kind` 这一个字段承担全部告知责任——而没人会去看它，
 *   除非已经超限了。
 */
const TOKENIZER_REGISTRY = createLazyTokenizerRegistry(() => CFG.values.tokenizerDir || null)

/** 诊断用：本进程的 tokenizer 注册表状态（`/api/config` 的 runPlane 之外单独一栏）。 */
function tokenizerRegistryStatus() {
  return TOKENIZER_REGISTRY.status()
}

// PRT-402：TeamPlan / EmployeeManifest 的存储。**延迟构造**，与 contextStore 同形——
// 这样只跑只读路由的进程不会因为建表而写库。
let contextPlanStoreInstance = null
function contextPlanStore() {
  if (contextPlanStoreInstance === null) {
    contextPlanStoreInstance = createContextPlanStore({
      db,
      // 与 contextStore 同一处适配：本文件的 `audit` 是**位置参数**的，
      // 而 store 按对象形态调用（见 `context-store.mjs` 里那段注释——
      // 直接把函数本身传进去会让 SQLite 绑定报错，而那次异常发生在**写入之后**，
      // 于是"一次成功的写入被报成失败"）。
      writeAudit: ({ action, scope, detail, actor }) =>
        audit(actor ?? null, scope ?? '*', action, '*', detail),
    })
  }
  return contextPlanStoreInstance
}

function contextStore() {
  if (contextStoreInstance === null) {
    contextStoreInstance = createContextStore({
      db,
      // **必须适配**：本文件的 `audit` 是**位置参数**的
      // `audit(member, scope, action, taskId, detail, goalId)`，而 store 按
      // `writeAudit(payload)` 的对象形态调用（与 modelStore / bindingStore 同一约定）。
      //
      // 第一版直接把 `audit` 函数本身传了进去，于是 `member` 收到一个对象、
      // `scope` 收到 `undefined` → SQLite 绑定错误。它不是"审计没写成"那么轻：
      // 异常发生在**快照已经落库之后**，所以客户端拿到 400 而库里已经有了那一行。
      // **一次成功的写入被报成失败**——调用方会重试，而重试命中幂等分支，
      // 于是它最终以为成功、而那次操作的审计永远缺失。
      // （幂等分支现在也写审计，见 context-store.mjs 的说明。）
      writeAudit: ({ action, attemptId, runId, detail, actor }) =>
        audit(actor ?? null, runId ?? '*', action, attemptId, detail),
    })
  }
  return contextStoreInstance
}

const modelStore = createModelStore({
  db,
  clock: () => Date.now(),
  writeAudit: ({ action, id, detail, actor }) => audit(actor, '*', action, id, detail),
})

/**
 * 岗位模型绑定仓储（PRT-502，spec §6.6）。
 *
 * `readProfiles` 把**含墓碑**的档案喂给解析器：只有传了墓碑才能把
 * "档案被下线了"与"档案根本不存在"分开报——两者的运维动作完全不同
 * （前者去找谁下线的，后者去查是不是 id 打错了）。`list({includeDeleted:true})`
 * 正好给这个形状，因此这里不用 `get`。
 *
 * 审计的 `taskId` 位置传的是 `scope/role`：`audit` 表的那个列是自由文本，
 * 而"改的是哪个岗位的绑定"必须能从审计里直接读出来，不该埋在 detail 里。
 */
const bindingStore = createBindingStore({
  db,
  clock: () => Date.now(),
  readProfiles: () => modelStore.list({ includeDeleted: true }),
  writeAudit: ({ action, scope, employeeRole, detail, actor }) =>
    audit(actor, scope ?? '*', action, `${scope ?? '*'}/${employeeRole}`, detail),
})

/**
 * 价目表登记处与预算账本（PRT-511 / PRT-503 / PRT-510）。
 *
 * 顺序是**必须**的：账本的 `priceTableFor` 依赖登记处。而且这里不能用
 * "先构造账本、再晚点接上价目表"的写法——`createBudgetLedger` 强制要求
 * `priceTableFor`，因此一个没有价目表来源的账本根本构造不出来。
 * 那条约束不是形式主义：没有它，结算就只能按现价重算，而 spec 明确禁止。
 *
 * 审计的 `taskId` 位置放 attemptId（账本的键），`scope` 放真实 scope。
 */
const budgetPriceTables = createPriceTableRegistry({
  db,
  clock: () => Date.now(),
  writeAudit: ({ action, detail }) => audit('system', '*', action, '*', detail),
})
const budgetLedger = createBudgetLedger({
  db,
  clock: () => Date.now(),
  priceTableFor: (version) => budgetPriceTables.get(version),
  writeAudit: ({ action, attemptId, scope, taskId, detail }) =>
    audit('system', scope ?? '*', action, attemptId ?? taskId ?? '*', detail),
})

/**
 * F-15 用量汇总（§4.4）。
 *
 * 与账本**共用同一个库**但**不共用闸门**：`budgetLedger` 是"能不能花"，
 * 本模块是"花了多少、花在哪"。两者刻意不合并——闸门的判据必须是
 * "当下这一笔"，而报表的判据是"到现在为止的全部"。
 * 把报表接进闸门，会让一次全表统计出现在每一次预留的热路径上；
 * 把闸门接进报表，会让"读一下总额"变成一次可能被拒绝的写。
 *
 * 只读：本模块没有任何写路径（它读 `usage_records` 与 `run_attempts`）。
 */
const usageRollup = Object.freeze({ rollupBy, usageTotals })

/**
 * 运行面路由的公共外壳。
 *
 * 不复用 `handleWrite`：那条路径要求 `by`（看板成员），而运行面的主体是 **worker**，
 * 不是成员。硬把 worker 塞进 `by` 会让审计日志里出现一个假的成员名，
 * 也会让「谁的这次写入」这件事在两张表里各有一套说法。
 */
async function handleRun(req, res, run) {
  try {
    if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
    const body = await readBody(req)
    const result = await run(body ?? {})
    // **回调可能已经自己写过响应**（大量路由在校验失败时直接
    // `json(res, 400/409, ...)` 然后 return）。这时再写一次会抛
    // `ERR_HTTP_HEADERS_SENT`，而那个异常会被本函数自己的 catch 再写一次
    // 响应（又抛），最后逃到外层被 `if (res.headersSent) res.end()` 静默吞掉。
    //
    // 结果：客户端拿到的响应是对的，但**没有任何一处记录发生过异常**——
    // 而"错误悄悄消失"正是这个项目明确要避免的那一类。所以在这里显式
    // 判断，不依赖外层兜底来擦屁股。
    if (!res.headersSent) json(res, 200, { ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = Number(e?.statusCode) || 400
    // 具名码原样交给调用方：worker 要靠 `LEASE_EPOCH_STALE` 决定「停手」，
    // 靠 `LEASE_EXPIRED` 决定「加快」——两者的下一步动作完全不同。
    //
    // 响应已经发出却还走到这里，说明**回调写过响应之后又有东西抛了**——
    // 那永远是个缺陷（正常路径是回调自己写、然后 return）。此时错误正文
    // 写不进去了，但绝不能什么都不留：`ERR_HTTP_HEADERS_SENT` 被静默吞掉
    // 正是"客户端看到正常响应、服务端毫无记录"这类最难查的问题。
    if (res.headersSent) {
      console.error(`[team-hub] 响应已发出后 handleRun 仍捕获到异常：${message}`)
      return
    }
    json(res, status, {
      error: message,
      code: e?.code ?? null,
      stateMachineCode: e?.stateMachineCode ?? null,
      // 证据闸门（`EVIDENCE_MISSING`）：**缺的是哪几项**必须能结构化地读到。
      //
      // 原来只写在 `error` 那段散文里（"…证据不存在：runResult"），于是调用方
      // 要判断"缺的是不是我补得上的那一项"就只能去匹配中文字符串。这与本文件
      // 别处"具名码原样交给调用方"的口径不一致，而且一旦措辞改了，调用方的
      // 判断会**静默失效**——它不报错，只是永远匹配不上。
      missing: e?.missing ?? null,
      // F-18：草稿"已经处置过"时必须带上**现状**（状态 + 谁 + 什么理由）。
      // 不带的话调用方只能再查一次，而两步之间那条草稿的状态可能已经变了
      // ——于是它据此做的判断是在回答一个过期的问题。
      currentSettlement: e?.currentSettlement ?? null,
      currentEpoch: e?.currentEpoch,
      currentWorkerId: e?.currentWorkerId,
      leaseExpiresAtMs: e?.leaseExpiresAtMs,
      // PRT-501：CAS 冲突必须带上**当前版本**。不带的话调用方只能反复盲试，
      // 而"重新读取后再改"这件事就变成了猜。
      currentVersion: e?.currentVersion,
      // PRT-510：状态拒绝必须带上**真实当前状态**。"你的状态是 settled，不是
      // locked"这句话本身就说明该改哪里；只给一句"状态不符"会让调用方去猜
      // 自己现在到底是什么状态——而这正是幂等重放最常见的失败原因。
      state: e?.state,
      lockReason: e?.lockReason,
      fromAmount: e?.fromAmount,
      toAmount: e?.toAmount,
      currency: e?.currency,
      // PRT-402：计划被冻结时必须带上**是哪一版**、是哪个 id、以及哪几个字段
      // 出了问题。不带 id/version 的话调用方只收到一句"已经冻结"，
      // 而它要做的是发一个新版本——那需要知道当前冻到第几版。
      id: e?.id,
      version: e?.version,
      field: e?.field,
      fields: e?.fields,
      serverTimeMs: Date.now(),
    })
  }
}

/** 同步等待，供启动期重试退避用（Atomics.wait 不忙转 CPU）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 把库切到 WAL 日志模式（**并发启动安全**）。
 *
 * 为什么不能只靠 busy_timeout：`PRAGMA journal_mode = WAL` 在真正需要切换时要拿**排他锁**，
 * 而该语句**不受 busy_timeout 约束** —— 实测另一个连接持锁时它 106ms 内直接抛
 * `database is locked`（errcode 5），busy handler 根本没有参与等待
 * （对照实测：同样的锁争用下，普通写 `BEGIN IMMEDIATE` 会按 busy_timeout 等待 2066ms 后成功）。
 * 后果：本仓库既有部署形态是「8787 独立进程 + 3080 宿主 v2 外壳」两进程同时打开同一个库（P1-1），
 * 新库首次切 WAL 时后到者会在**模块加载期崩溃**退出；宿主侧表现为 /team-hub 路由缺失 +
 * 一条加载失败日志（外壳有 .catch，不会带走宿主进程），直到重启。
 * 因此这一步必须自己等待：有界重试（默认约 6s，与 busy_timeout 同量级）。
 * 已处于 WAL 的库是空操作，重试会立即返回。
 */
function enableWal({ attempts = 50, intervalMs = 120 } = {}) {
  for (let i = 1; ; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return i
    } catch (e) {
      if (i >= attempts) {
        throw new Error(`无法把库切到 WAL（等待约 ${(((attempts - 1) * intervalMs) / 1000).toFixed(1)}s 后库仍被占用）：${e?.message ?? e}`)
      }
      sleepSync(intervalMs)
    }
  }
}

/**
 * 幂等补列（启动期迁移的**唯一**入口）。
 *
 * 为什么不能写成 `if (!cols.includes(c)) db.exec('ALTER TABLE ...')`：
 * 本仓库的既有部署形态就是**两进程同时打开同一个库**（8787 独立进程 + 3080 宿主 v2 外壳），
 * 两者启动时会并发跑同一批迁移。`PRAGMA table_info` 检查与 `ALTER TABLE` 之间没有互斥，
 * 两个进程都会读到「列不存在」，于是都执行 ALTER —— 后者拿到
 * `SQLite error: duplicate column name: xxx`（真实复现：同时启动两个 server.mjs 指向同一新库，
 * 其中一个在模块加载期即崩溃，进程退出；宿主侧表现为 /team-hub 路由缺失并打一条加载失败日志，直到重启）。
 *
 * 做法：在 BEGIN IMMEDIATE 里**重读一次**列名再决定是否 ALTER —— IMMEDIATE 直接取写锁
 * （不走 DEFERRED 的读→升写路径，避免并发下的锁升级死锁），把「检查 + 变更」变成原子操作。
 * 拿不到写锁时最多等待 busy_timeout，超时会抛错：这是既有语义（迁移失败不静默继续）。
 */
// 启动期迁移的原子原语已提取到 ./schema-util.mjs（PRT-314/316）：
// 那里说明了「为什么非原子写法会让两个并发启动的进程崩掉一个」。
// 这里保留同名薄包装只是因为本文件有 30 多处调用点，包装把 db 参数补上，
// 实现**只有一份**。
function ensureColumn(table, column, ddl) {
  return ensureColumnImpl(db, table, column, ddl)
}

function columnExists(table, column) {
  return columnExistsImpl(db, table, column)
}
// ★ PRT-404：`feedback` 是**与 `comments` / `evidence` 并列的第三个批注列**，
//   不是往 `comments` 里加的一个 `kind` 标记。
//
//   > 一个"把反馈塞进 comments 数组、加个 kind 字段"的实现，
//   > 与一个"给它自己的列"的实现，在只看反馈的时候是同一个东西——
//   > 只不过前者要求**每一个**读 comments 的地方都记得过滤掉它，
//   > 而漏掉一处就会让同一条反馈同时以"同事的评论"和"用户的反馈"
//   > 两种身份进模型上下文。
//
//   那个漏掉的地方不是假设：装配器正是按 `task.comments` 读评论的
//   （`sources-loader.mjs` 的 `toComments`）。分成两列之后，"不混淆"这件事
//   **在结构上**成立，而不是靠每一处读点自觉。
//
//   ⚠️ 注意：SQL 的模板字符串里**不能写 `//` 注释**（SQLite 不认），也不能出现
//   反引号（会把模板字符串截断）。第一版我把上面这段话写进了 CREATE TABLE 里，
//   `node --check` 当场报 `missing ) after argument list`——那还是**幸运**的：
//   若那段话里没有反引号，它会变成一段被 SQLite 拒绝的 DDL，而报错发生在**启动期**。
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    acceptance TEXT DEFAULT '[]',
    boundary TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'backlog',
    version INTEGER NOT NULL DEFAULT 1,
    soldier TEXT,
    claimedRound INTEGER,
    claimedAt TEXT,
    ttlMinutes INTEGER,
    expiresAt TEXT,
    claimRequestId TEXT,
    ordersVersion INTEGER DEFAULT 1,
    parent TEXT,
    role TEXT,
    scope TEXT DEFAULT 'default',
    hold INTEGER DEFAULT 0,
    blocks TEXT DEFAULT '[]',
    blockedBy TEXT DEFAULT '[]',
    comments TEXT DEFAULT '[]',
    evidence TEXT DEFAULT '[]',
    feedback TEXT DEFAULT '[]',
    patches TEXT DEFAULT '[]',
    artifacts TEXT DEFAULT '[]',
    slice TEXT,
    sliceIdx INTEGER,
    fixOf TEXT,
    fixCount INTEGER DEFAULT 0,
    testReport TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    scope TEXT DEFAULT 'default',
    kind TEXT DEFAULT 'unknown',
    lastSeenAt TEXT,
    online INTEGER DEFAULT 0
  )
`)
// 编队（roster）：每个工作空间（scope）的专属智能体队伍——不同空间不同职业，
// 任务分区 + 编队分区双管齐下，空间间智能体差异化、专业化。
db.exec(`
  CREATE TABLE IF NOT EXISTS roster (
    scope TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT DEFAULT '',
    avatar TEXT DEFAULT '🤖',
    sort INTEGER DEFAULT 0,
    PRIMARY KEY (scope, role)
  )
`)
// 工作空间实体（scope 的注册名；未注册的既有 scope 由 GET /api/spaces 推导合并）。
// local_dir / remote_url = 该空间绑定的「本地文件夹 + 远程仓库」——不同空间可对应不同的
// 目录与仓库组合（如 legion 主仓 vs 业务私有空间），由军团指挥台配置、守护/派工按空间消费。
db.exec(`
  CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    private INTEGER DEFAULT 0,
    local_dir TEXT DEFAULT '',
    remote_url TEXT DEFAULT '',
    createdAt TEXT,
    updatedAt TEXT
  )
`)
// 迁移：为既有数据库补充 private（本地/私有标记）与仓库绑定列（local_dir/remote_url）。
// 走 ensureColumn（BEGIN IMMEDIATE 内重读）——双进程同时启动时会并发跑同一批迁移，非原子写法会崩。
ensureColumn('spaces', 'private', 'private INTEGER DEFAULT 0')
ensureColumn('spaces', 'local_dir', "local_dir TEXT DEFAULT ''")
ensureColumn('spaces', 'remote_url', "remote_url TEXT DEFAULT ''")
// ── SP-P0 空间流水线：编队即流水线 ────────────────────────────────────────────
// 背景（T-127 现场）：阶段定义原本只存在于守护宿主的 roles.json（部署面文件），与空间编队（roster，数据面）
// 是两份必须手工对齐的数据；新增空间一旦漏配，目标链会静默停在 todo。本层把阶段定义搬进数据面：
//   - space_stages：该空间的阶段/岗位契约（role 必须与 roster.role 逐字一致）；enabled=0 = 该岗位**不参与流水线**
//     （建链与派工都跳过——从机制上消除「非执行岗入编 → blockedBy 链死锁」）；
//   - space_runtime：该空间的执行配置（是否开通自动执行 / 并发 / 是否隔离 worktree）。
// 守护每轮扫单按 GET /api/pipeline 读取（hub 优先，部署面 rolesFile 作离线兜底）。
db.exec(`
  CREATE TABLE IF NOT EXISTS space_stages (
    scope TEXT NOT NULL,
    role TEXT NOT NULL,
    label TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    next TEXT DEFAULT NULL,
    gate INTEGER DEFAULT 0,
    artifact TEXT DEFAULT NULL,
    docs TEXT DEFAULT NULL,
    sort INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    updatedAt TEXT,
    PRIMARY KEY (scope, role)
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS space_runtime (
    scope TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    maxWorkers INTEGER DEFAULT 1,
    isolate INTEGER DEFAULT 1,
    updatedAt TEXT
  )
`)

// 迁移：members 补充 model 列（S2/R-1 决策 B1：守护心跳可携带当前选用模型，供 GET /api/chat/health 聚合展示；
// 列可空，既有成员行/插入语句零影响）。走 ensureColumn：双进程并发启动时非原子写法会崩在这里
// （实测 `duplicate column name: model`，见 scripts/ci/dual-write-smoke.test.mjs 的并发启动用例）。
ensureColumn('members', 'model', 'model TEXT DEFAULT NULL')
// 空间目标（goal）：一个工作空间可**并存多个目标**（多目标并发，互不取消），任务集围绕各自目标推进。
// 每行 = 一个目标记录：
//   id        目标唯一标识（G-xxx）
//   scope     所属工作空间
//   objective 目标文案
//   status    状态生命周期：active 进行中 / paused 将军暂停 / done 链任务全部完成(自动或将军收尾) / canceled 将军取消
//   version   目标级乐观锁版本（每次状态/内容变更 +1），界面与任务一样报告 version + status
//   mode      建链模式：chain 全串阶段链 / slice 切片前缀链（test-designer 后由守护展开切片束）
//   docsDir   该目标**分析文档目录**（相对仓库根，如 'docs/G-x'）：阶段产物文档（REQUIREMENTS.md/RESEARCH.md/
//             TASK_BREAKDOWN.md/TEST_CASES.md/TEST_REPORT.md/DEPLOY.md）的目标独立命名空间——
//             不同目标写各自的目录，分析前缀阶段跨目标可安全并行（与切片文件域隔离同一思想）。
//             NULL = 遗留目标（本列上线前发布）：沿用仓库根 docs/ 固定槽位，行为不变（旧链兼容）。
//   endedAt   done/canceled 的终态时间
db.exec(`
  CREATE TABLE IF NOT EXISTS goal (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    mode TEXT DEFAULT 'chain',
    createdAt TEXT,
    updatedAt TEXT,
    endedAt TEXT,
    docsDir TEXT
  )
`)
// 老库迁移：旧 goal 表是「scope 主键 + 单目标 upsert」，无 id/status/version。
// 启动时若发现还是旧形状（无 id 列），重建为多目标模型：旧行逐一升级为独立目标记录（status=active）。
//
// 这是**破坏性**迁移（DROP + CREATE + 逐行搬迁），因此整段放进单个 BEGIN IMMEDIATE：
// 双进程同时启动时若各自读到「旧形状」，会互相 DROP 对方的表、重复搬迁旧行；
// 取写锁 + 锁内重读形状判断，保证只有一个进程执行、另一个看到已是新形状而跳过。
// 迁移失败即抛错（不静默继续）——避免半迁移状态被当成正常库使用。
{
  const needsRebuild = () => !columnExists('goal', 'id')
  if (needsRebuild()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (needsRebuild()) {
        const legacy = db.prepare('SELECT scope, objective, createdAt, updatedAt FROM goal').all()
        db.exec('DROP TABLE goal')
        db.exec(`
          CREATE TABLE goal (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            objective TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            version INTEGER NOT NULL DEFAULT 1,
            mode TEXT DEFAULT 'chain',
            createdAt TEXT,
            updatedAt TEXT,
            endedAt TEXT,
            docsDir TEXT
          )
        `)
        legacy.forEach((r, i) => {
          const id = `G-${String(i + 1).padStart(3, '0')}`
          const created = r.createdAt ?? now()
          db.prepare('INSERT INTO goal (id, scope, objective, status, version, mode, createdAt, updatedAt, endedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, r.scope, r.objective, 'active', 1, 'chain', created, r.updatedAt ?? created, null)
        })
        if (legacy.length > 0) console.log(`[team-hub] goal 表迁移为多目标模型：${legacy.length} 条旧目标升级为独立目标记录（G-001…）`)
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      throw e
    }
  }
}
// 持续执行编排：每空间开关 + 用户点「派 AI 执行」的请求队列。
db.exec(`
  CREATE TABLE IF NOT EXISTS exec_state (
    scope TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    updatedAt TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS exec_requests (
    taskId TEXT PRIMARY KEY,
    scope TEXT,
    status TEXT DEFAULT 'pending',
    createdAt TEXT
  )
`)
// 智能体默认模型配置（每空间每角色）：执行该角色任务时使用的模型，用于按任务复杂度省 token。
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_models (
    scope TEXT NOT NULL,
    role TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    updatedAt TEXT,
    PRIMARY KEY (scope, role)
  )
`)
// 不会自动执行的任务角色（写码/审查/测试/部署等改动仓库的阶段，交给用户点「派 AI 执行」把关）。
const NON_AUTO_ROLES = new Set([
  'coder', 'developer', 'engineer', 'reviewer', 'tester', 'qa', 'devops', 'deploy', 'release', 'test-designer', 'implementer',
  '编码', '实现', '审查', '测试', '部署', '发布', '运维', '工程师', '开发',
])
db.exec(`
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    member TEXT,
    scope TEXT,
    action TEXT,
    taskId TEXT,
    detail TEXT
  )
`)
// P2-8①：浏览器助手按空间的抓取历史（团队级共享、可审计；serve.mjs 侧只写库、不负责保留策略）。
// 唯一键 (scope,url)：同一 URL 重复抓取只更新最近一次结果（更新时间/状态/字节/耗时/错误码/缓存命中），
// 避免历史里堆满同一地址的重复行；URL 计数与「最近抓了什么」都读这张表。
db.exec(`
  CREATE TABLE IF NOT EXISTS web_fetch_history (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    url TEXT NOT NULL,
    finalUrl TEXT,
    host TEXT,
    title TEXT,
    excerpt TEXT,
    status INTEGER,
    bytes INTEGER,
    ms INTEGER,
    errorCode TEXT,
    cached INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_web_history_scope_url ON web_fetch_history (scope, url)')
db.exec('CREATE INDEX IF NOT EXISTS idx_web_history_scope_updated ON web_fetch_history (scope, updatedAt)')
db.exec(`
  CREATE TABLE IF NOT EXISTS permission_rules (
    id TEXT PRIMARY KEY,
    scope TEXT,
    actor TEXT,
    action TEXT,
    target TEXT,
    mode TEXT NOT NULL,
    taskId TEXT,
    expiresAt INTEGER,
    createdBy TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_permission_rules_match ON permission_rules (scope, action, target)')

// PRT-608/615：审批表的结构由 `approval-binding.mjs` 拥有。
//
// 搬到那里去的理由与 PRT-411 把 `run_context_snapshots` 交给 context-store 一样：
// 表结构与"什么算一条合法审批"是同一份知识。分裂成两份（生产一份、夹具一份）时，
// 夹具手抄的列名会在增删时**静默**与真实结构脱节——插入报错还算好的。
//
//   > 一个"生产建一份、夹具抄一份"的表结构，
//   > 与一个"迟早只有一份是对的"的表结构，在「新加的列到底有没有生效」上是同一个东西。
ensureApprovalSchema(db)

// PRT-616：`allow-once` 的占位账本。
//
// 它**必须**有一张自己的表，而不是复用 `permission_requests` 的一列：账本记的是
// "这一次放行被用掉了"这个**事实**，而审批行记的是"有人申请过"。前者是不可回收的
// 安全事实，后者会被清理/过期。把不可回收的事实放进一张会被清理的表里，
// 表现是"清理跑完之后，同一操作又能被放行一次"。
ensureAllowOnceSchema(db)

// PRT-402：TeamPlan 与 EmployeeManifest 两张表。
//
// 与 `ensureApprovalSchema` 同一条理由：**表结构与"什么算一条合法记录"
// 是同一份知识**，所以它住在 `context-plan-store.mjs` 里，生产与夹具调**同一个**函数。
// 在这里建一份、夹具里抄一份的后果不是"重复劳动"，是夹具手抄的列名会在增删时
// **静默**与真实结构脱节——插入报错还算好的。
ensureContextPlanSchema(db)

// PRT-608：**有意不回填**既有行的绑定哈希。
//
// 回填意味着"用今天的规范化规则，替一批旧行算出它们的身份"。而那些行的身份
// 本来就是按**旧规则**定的——回填会把一次规则变更的影响静默抹平：
// 一条旧规则下绑定的审批，会变成一条新规则下绑定的审批，而没有人知道它变过。
//
// 代价是迁移瞬间仍然 `pending` 的那些请求会变成"没有哈希"，于是被
// `verifyBinding` 以 `approval-unbound` **拒绝**（fail-closed），用户需要重新发起。
// 审批 TTL 是 15 分钟，所以受影响的窗口最多 15 分钟。
//
//   > 一个"给旧行补算哈希"的迁移，与一个"把旧审批的含义改写成今天的含义"的迁移，
//   > 是同一个东西——而它的方向是**放行**。

db.exec(`
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    prompt TEXT DEFAULT '',
    scope TEXT DEFAULT 'default',
    owner TEXT,
    grants TEXT DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT DEFAULT 'pending',
    contentHash TEXT DEFAULT '',
    reviewedAt TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )
`)
// ── 对话中心（chat）：会话 / 消息两级存储（G-1 默认：team-hub 单库；scope 分区与 by 写纪律与任务同构）──
// 老库自动建表（CREATE TABLE IF NOT EXISTS 幂等），无需手工迁移；conversations/messages 均为
// AUTOINCREMENT 整数主键，保证服务端生成、非空、稳定排序（分页游标按 id）。
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'space',
    participants TEXT DEFAULT '[]',
    createdAt TEXT,
    updatedAt TEXT,
    last_message_at TEXT
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'default',
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    body TEXT NOT NULL,
    meta TEXT DEFAULT '{}',
    client_ts TEXT,
    createdAt TEXT
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conv_id, id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations (scope, updatedAt)')
// ── 对话 AI 回复设置（R-4，S9）：每空间独立开关 + 模型/身份/systemHint 覆盖 ──
// 老库自动建表（CREATE TABLE IF NOT EXISTS 幂等，零迁移）；默认 enabled=1（D-13 默认开）。
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_reply_settings (
    scope TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    identity TEXT,
    systemHint TEXT,
    updatedAt TEXT
  )
`)
// ── 对话附件（S3/R-3 决策 E1）：chat_attachments 行 + uploads 落盘目录（内容不入 messages 表）──
// 状态机：staged（已上传未绑定消息，24h 孤儿清理）→ sent（随消息绑定；7 天 TTL 清理）。
// 内容只存 uploads/<scope>/<sha1>（sha1 命名天然去重）；messages.meta.attachments 只存 [{id,fileName,size}] 引用
// （AC-R3-1 / AC-R4-3：body/meta 不含文件全文，断言点）。
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    conv_id INTEGER,
    msg_id INTEGER,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    sha1 TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'staged',
    createdAt TEXT
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_attachments_scope_status ON chat_attachments (scope, status, createdAt)')
db.exec('CREATE INDEX IF NOT EXISTS idx_chat_attachments_status ON chat_attachments (status, createdAt)')
// ── 日程日历（calendar）：单表事件存储（R-B1 数据面；G-1 默认单库，scope 分区 + by 写纪律与 chat/tasks 同构）──
// 老库自动建表（CREATE TABLE IF NOT EXISTS 幂等，S5 验收 1：旧库无 calendar_events 时 import 自动补建，零迁移脚本）。
// 事件带 start/end（ISO 时间串，end 可空）+ all_day（全天标记）+ meta JSON；日期窗过滤按 start 的 YYYY-MM-DD 前缀（闭区间）。
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    taskId TEXT,
    goalId TEXT,
    recurrence TEXT,
    meta TEXT DEFAULT '{}',
    createdAt TEXT,
    updatedAt TEXT
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_scope_start ON calendar_events (scope, start, id)')
// P2-5 增量列（幂等，零迁移脚本）：老库自动补列。
//
// **不能**写成 `try { db.exec('ALTER TABLE … ADD COLUMN …') } catch { /* 列已存在 */ }`。
// 那个形状把两件完全不同的事吞成同一个结果：
//
//   · `duplicate column name` —— 列已经有了，**正常**；
//   · 磁盘满 / 表被锁 / 库只读 / SQL 写错 —— 列**真的没加上**，而这里一声不响。
//
// 后者的后果不在启动期出现，而在几周后某个不相干的查询报 `no such column: taskId`：
// 那时没人会想到"几个月前的一次启动时那条 ALTER 失败了"。
//
//   > 一个「把'加列失败'吞成'已经有了'」的迁移，
//   > 与一个「某个查询在几周后报 no such column」的迁移，是同一个东西——
//   > 只不过前者在启动日志里看起来一切正常。
//
// `ensureColumn`（本文件 655 行那个包装）在 `BEGIN IMMEDIATE` 内**重读**列名，
// 只在"重读确认列已存在"时才把异常当作成功，其它异常照抛
// （`schema-util.mjs` 头注释有完整理由；本文件其余 33 处补列早就走它了，
// 这里是漏掉的一处）。
for (const [name, ddl] of [['taskId', 'TEXT'], ['goalId', 'TEXT'], ['recurrence', 'TEXT']]) {
  ensureColumn('calendar_events', name, ddl)
}
db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_task ON calendar_events (taskId, start)')
db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_goal ON calendar_events (goalId, start)')
// ── 规范（rules）：全局规范层 + 空间层扩展点（R-2，S4；RESEARCH K3-A）──
// 老库自动建表（CREATE TABLE IF NOT EXISTS 幂等，零迁移）。key = scope（全局层固定 'global'，空间层预留扩展点）；
// content 为规范文本（markdown），长度受 MAX_RULES_LEN 护栏；写走统一 handleWrite（audit rules:update + SSE）。
db.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    key TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'global',
    content TEXT NOT NULL DEFAULT '',
    updatedAt TEXT
  )
`)
// ── 技能来源（skill_sources）：每个空间绑定的团队技能仓库（github URL + 分支），供一键「拉取同步」。──
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_sources (
    scope TEXT PRIMARY KEY,
    url TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    updatedAt TEXT
  )
`)
// 老库迁移：skills 表先于 status/contentHash/reviewedAt 三列存在，缺列补上。
// （ensureColumn 定义在文件上方 SQLite 初始化处：它是启动期迁移的唯一入口，且必须是原子的。）
ensureColumn('skills', 'status', "status TEXT DEFAULT 'pending'")
ensureColumn('skills', 'contentHash', "contentHash TEXT DEFAULT ''")
ensureColumn('skills', 'reviewedAt', 'reviewedAt TEXT')
ensureColumn('skills', 'bundle', "bundle TEXT DEFAULT ''")
// ── PRT-406：skills 的**来源**（谁把它放进来的），用于上下文可信性判定 ────────────
//
// spec §6.5 / PRT-406 要求区分「运维安装的 skill（系统内容）」与
// 「团队成员登记/从仓库读来的 skill（外部内容）」——同一个类型 `skill` 里两者都有。
//
// ★ 为什么是**入库时由 hub 写死**、而不是请求体里带：
//   如果 `origin` 来自 body，那么一个成员只要在自己的 register 请求里写
//   `origin: 'operator'`，就能把自己的技能**升格成系统指示**。
//
//     > 一个"由提交者声明自己可信"的来源字段，
//     > 与一个"任何人都可以自称可信"的字段，在没人恶意提交的时候是同一个东西——
//     > 只不过前者会把**信任这件事，交给被信任的那一方去填**。
//
//   所以两条写入路径各自**硬编码**一个值（registerSkill → 'member'、
//   installSkill → 'operator'），谁都不读 `input.origin`。
//
// ★ 默认值取 `'member'`（不可信那一侧）：迁移前就存在的那些 skill 都是成员登记的，
//   而"老数据"与"运维安装"是两件事——把它们默认成系统内容，等于用一次迁移
//   悄悄给全部历史内容升格。
ensureColumn('skills', 'origin', "origin TEXT DEFAULT 'member'")
// 老库迁移：skills 先于 bundle 列存在，旧内容只有 prompt → 生成单件 bundle（main=prompt），
// 并按「bundle 化」新公式重算 contentHash，保证旧技能「同内容重复提交」幂等、改内容才 bump version。
// （skillContentHash / normalizeBundle 为函数声明，已提升，可在建表后调用。）
for (const r of db.prepare("SELECT id, name, description, prompt, scope FROM skills WHERE (bundle IS NULL OR bundle = '') AND prompt IS NOT NULL AND prompt != ''").all()) {
  const bundle = normalizeBundle({ main: r.prompt, config: '', scripts: [], cases: [] })
  const hash = skillContentHash({ name: r.name, description: r.description, scope: r.scope, bundle })
  db.prepare('UPDATE skills SET bundle=?, contentHash=? WHERE id=?').run(JSON.stringify(bundle), hash, r.id)
}
// ── PRT-406：显式文档（context source 里的 `document` 那一类）──────────────────
//
// spec §6.5 把「显式文档」与「已发布 Skills」并列为上下文来源。`skill` 那一半
// 走 `/api/skills`，`document` 那一半此前**根本没有数据面**——`collectCandidates`
// 的 `input.documents` 一直是硬编码的 `[]`。
//
//   > 一个"每份文档都不存在"的世界，
//   > 与一个"产品还没做这件事"的世界，在快照上是同一个东西——
//   > 只不过前者会出现在来源清单的 `read-empty` 那一栏，
//   > 而后者必须出现在 `not-attempted` 那一栏。
//
// ★ `origin` 与 skills 同一套纪律：入库时由路由**硬编码**，不读 body
//   （成员登记 → 'member'；运维安装 → 'operator'，走本机 CLI）。
// ★ `body` 是**内容本身**：文档与 skill 一样，正文进上下文是一个预算决定，
//   所以快照侧走 `allowTruncate`，而不是在这里截断（截断理由要能被记下来）。
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    path TEXT DEFAULT '',
    body TEXT DEFAULT '',
    scope TEXT DEFAULT 'default',
    origin TEXT DEFAULT 'member',
    version INTEGER NOT NULL DEFAULT 1,
    sha256 TEXT DEFAULT '',
    createdAt TEXT,
    updatedAt TEXT
  )
`)
// 老库幂等补齐（本表随 PRT-406 引入，无老库，保留 ensureColumn 是为了
// 与其它表的迁移纪律一致：将来加列走同一条路，不再手写 ALTER）。
ensureColumn('documents', 'origin', "origin TEXT DEFAULT 'member'")
ensureColumn('documents', 'sha256', "sha256 TEXT DEFAULT ''")
// 任务 TTL/幂等/转派列（老 tasks 表补齐）
ensureColumn('tasks', 'ttlMinutes', 'ttlMinutes INTEGER')
ensureColumn('tasks', 'expiresAt', 'expiresAt TEXT')
ensureColumn('tasks', 'claimRequestId', 'claimRequestId TEXT')
// 边界列（做什么/不做什么 JSON：{"do":[],"dont":[]}）——任务生成必须带验收标准与边界
ensureColumn('tasks', 'boundary', "boundary TEXT DEFAULT '[]'")
// 拦截列（将军逐任务拦截：hold=1 时守护不自动认领/执行，见 POST /api/hold）
ensureColumn('tasks', 'hold', 'hold INTEGER DEFAULT 0')
// 切片流水线列（v3 slice 模式，见 docs/ORCHESTRATION-V3.md）：切片归属键 / fix 回炉计数 /
// 结构化测试报告 / 产物登记。老库幂等补齐，无破坏。
ensureColumn('tasks', 'artifacts', "artifacts TEXT DEFAULT '[]'")
ensureColumn('tasks', 'slice', 'slice TEXT')
ensureColumn('tasks', 'sliceIdx', 'sliceIdx INTEGER')
ensureColumn('tasks', 'fixOf', 'fixOf TEXT')
ensureColumn('tasks', 'fixCount', 'fixCount INTEGER DEFAULT 0')
ensureColumn('tasks', 'testReport', 'testReport TEXT')
// 审计批注列（L2 审计工作台）：review_notes JSON = [{ file:'*'|相对路径, verdict:'ok'|'issue', note, by, at }]
ensureColumn('tasks', 'review_notes', "review_notes TEXT DEFAULT '[]'")
// PRT-404 用户反馈列：feedback JSON = [{ by, at, text }]。老库幂等补齐。
// 与 `comments` 分开存（不是加 kind 标记）——理由见 CREATE TABLE tasks 里那段说明。
ensureColumn('tasks', 'feedback', "feedback TEXT DEFAULT '[]'")
// 目标归属列（多目标并发）：链任务带 goalId 关联到具体目标（goal 表 id）。
// 进度/取消按 goalId 统计——不同目标的任务链互不干扰、可并行推进。
ensureColumn('tasks', 'goalId', 'goalId TEXT')
// 目标级上下文（同一目标共享上下文，防任务并行"窜台"）：
// 1) goal.context/contextVersion —— 目标上下文正文（markdown）+ 版本（更新 bump，下一派工对齐，语义同 v1 mesh orders）；
// 2) tasks.fileDomain —— 切片文件域声明（JSON 数组，守护在 merge 前做越域机器校验，B 层防窜台）；
// 3) audit.goalId —— 目标/任务事件的目标归属（per-goal 活动视图 /api/activity?goalId= 的数据源）。
ensureColumn('goal', 'context', "context TEXT DEFAULT ''")
ensureColumn('goal', 'contextVersion', 'contextVersion INTEGER DEFAULT 0')
// 4) goal.docsDir —— 目标级分析文档命名空间（docs/<goalId>）：NULL = 遗留目标沿用根 docs/ 槽位。
ensureColumn('goal', 'docsDir', 'docsDir TEXT')
// 5) docSync（RC-2 修复，T-117 实测）——「用户可见行为变更需同步功能手册+README」声明通道。
//    goal.docSync：目标级声明（发布时 body.docSync/feature）；tasks.docSync：任务级权威字段
//    （守护 registerContractDocs 消费 t.docSync===true → done 结算追加 docs/FEATURES.md + README.md 契约）。
//    发布目标时只把声明落到链上 coder 岗位任务（实现+更新文档的执行者），避免全链误伤前段分析岗。
ensureColumn('goal', 'docSync', 'docSync INTEGER DEFAULT 0')
ensureColumn('tasks', 'docSync', 'docSync INTEGER DEFAULT 0')
ensureColumn('tasks', 'fileDomain', 'fileDomain TEXT')
ensureColumn('audit', 'goalId', 'goalId TEXT')
// 历史链回填：老库「一空间一目标」时代的 [auto-goal] 任务没有 goalId。
// 启动时把该空间**未取消**的自动目标链任务挂到本空间迁移后的目标记录上（老模型每空间至多一条 active 目标）。
try {
  const rows = db.prepare("SELECT id, scope FROM goal WHERE status != 'canceled'").all()
  for (const g of rows) {
    // 挂接全部未取消的自动目标链任务（含已 done——保证老链进度/自动收尾统计完整；canceled 属被替换的旧目标，不挂）
    const updated = db.prepare("UPDATE tasks SET goalId = ? WHERE scope = ? AND goalId IS NULL AND description LIKE '%[auto-goal]%' AND status != 'canceled'").run(g.id, g.scope).changes
    if (updated > 0) console.log(`[team-hub] 历史目标链回填 goalId：目标 ${g.id}（${g.scope}）挂接 ${updated} 个任务`)
  }
} catch { /* 回填失败不影响启动 */ }
// 老链回填：已生成、未完成的自动目标链任务若没有验收标准/边界，按岗位模板补种，
// 保证"生成任务的同时必须生成验收标准与边界（做什么/不做什么）"对历史在途任务也成立。
try {
  const stale = db.prepare("SELECT id, role FROM tasks WHERE description LIKE '%[auto-goal]%' AND status NOT IN ('done','canceled') AND (acceptance IS NULL OR acceptance = '[]')").all()
  for (const s of stale) {
    const std = standardsFor(s.role ?? '')
    db.prepare('UPDATE tasks SET acceptance=?, boundary=?, updatedAt=? WHERE id=?')
      .run(JSON.stringify(std.acceptance), JSON.stringify({ do: std.do, dont: std.dont }), now(), s.id)
  }
  if (stale.length > 0) console.log(`[team-hub] 历史目标链补种验收标准/边界：${stale.length} 个任务（按岗位模板）`)
} catch { /* 回填失败不影响启动 */ }

function now() {
  return new Date().toISOString()
}

/** 解析 JSON 列：兼容「原始字符串」与「已被 rowToTask 解析过的数组/对象」两种输入。
 *  历史上 commentTask 等对 getTask 返回（已解析的数组）再次 parseJson 会抛错回退空数组，
 *  导致评论每次写入都整体替换（任务永远只剩最后一条评论）。幂等化后追加语义恢复。 */
function parseJson(text, fallback) {
  if (Array.isArray(text) || (text !== null && typeof text === 'object')) return text
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 归一化任务的验收标准与边界：调用方没给（或给空）时按该任务 role 的岗位模板生成——
 * "生成任务的同时，必须生成验收标准与边界（做什么/不做什么）"。
 * acceptance 自定义则保留（boundary 仍补模板默认，边界纪律是全局的）。
 */
function taskStandards(role, acceptance, boundary) {
  const std = standardsFor(role ?? '')
  const clean = (list) => Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim().length > 0) : []
  const acc = clean(acceptance)
  const b = boundary && typeof boundary === 'object' ? boundary : {}
  const doList = clean(b.do)
  const dontList = clean(b.dont)
  return {
    acceptance: acc.length > 0 ? acc : std.acceptance,
    boundary: {
      do: doList.length > 0 ? doList : std.do,
      dont: dontList.length > 0 ? dontList : std.dont,
    },
  }
}

/** legion/roles.json 的流水线角色 → 中文标签表（任务集命名用；SP-P0 后仅作无空间流水线时的兜底）。 */
function pipelineLabels() {
  const labels = { unassigned: '未指派' }
  try {
    const r = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'))
    for (const s of r.stages ?? []) labels[s.role] = s.label
  } catch { /* roles.json 缺失/损坏则回退原始 role 名 */ }
  return labels
}

// ── SP-P0 空间流水线读写（数据面单源；守护 GET /api/pipeline 消费，POST /api/pipeline 维护）──
const ROLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 空间注册/编队管理的规范形状（POST /api/spaces、/api/agents 等写路径仍用这条）。 */
const SCOPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/**
 * 分区键形状（读面用）：scope 是任务/目标/流水线的分区键，历史上与自定义实例存在
 * 下划线等非规范 scope（如夹具 __p13fixture__、内嵌板 default）；读面若比同族接口更严，
 * 会让这类实例静默拿不到自己的流水线。故读面放宽到「字母/数字/下划线/连字符」。
 */
const SCOPE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
const STAGE_LIMIT = 32
const PROMPT_LIMIT = 20000
const DOCS_LIMIT = 16

/** 单条阶段行的校验 + 归一化（写路径用；抛错即 400）。 */
function normalizeStage(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`stages[${index}] 必须是对象`)
  const role = typeof raw.role === 'string' ? raw.role.trim() : ''
  if (!ROLE_ID_RE.test(role)) throw new Error(`stages[${index}].role 非法（小写字母/数字开头，可含连字符，≤64 字符）`)
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (label.length === 0) throw new Error(`stages[${index}]（${role}）缺少 label（岗位中文名）`)
  if (label.length > 64) throw new Error(`stages[${index}]（${role}）label 过长（≤64 字符）`)
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
  if (prompt.length > PROMPT_LIMIT) throw new Error(`stages[${index}]（${role}）prompt 过长（≤${PROMPT_LIMIT} 字符）`)
  const next = raw.next === null || raw.next === undefined || raw.next === '' ? null : String(raw.next).trim()
  if (next !== null && !ROLE_ID_RE.test(next)) throw new Error(`stages[${index}]（${role}）.next 非法`)
  const gate = raw.gate === true
  const artifact = typeof raw.artifact === 'string' && raw.artifact.trim().length > 0 ? raw.artifact.trim() : null
  if (artifact !== null && artifact.length > 512) throw new Error(`stages[${index}]（${role}）.artifact 过长（≤512 字符）`)
  // 人工闸门的产物路径若为空，闸门永远无法通过（守护按 <目标docsDir>/<basename> 校验）→ 写入期即拦截。
  if (gate && artifact === null) throw new Error(`stages[${index}]（${role}）配了 gate:true 但没有 artifact（闸门将永远无法通过）`)
  let docs = null
  if (raw.docs !== null && raw.docs !== undefined) {
    if (!Array.isArray(raw.docs)) throw new Error(`stages[${index}]（${role}）.docs 必须是字符串数组`)
    if (raw.docs.length > DOCS_LIMIT) throw new Error(`stages[${index}]（${role}）.docs 最多 ${DOCS_LIMIT} 条`)
    const clean = []
    for (const d of raw.docs) {
      const p = typeof d === 'string' ? d.trim().replace(/\\/g, '/') : ''
      if (p.length === 0) continue
      if (p.length > 512) throw new Error(`stages[${index}]（${role}）.docs 路径过长（≤512 字符）`)
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(s => s === '..' || s === '')) throw new Error(`stages[${index}]（${role}）.docs 路径必须是仓库相对路径且不含 ..：${p}`)
      clean.push(p)
    }
    docs = clean.length > 0 ? clean : null
  }
  const sort = Number.isFinite(raw.sort) ? Math.trunc(raw.sort) : index
  const enabled = raw.enabled === false ? 0 : 1
  return { role, label, prompt, next, gate: gate ? 1 : 0, artifact, docs, sort, enabled }
}

/** 写路径整批校验：role 唯一 + next 指向本批或存量阶段。 */
function normalizeStages(scope, rawStages) {
  if (!Array.isArray(rawStages) || rawStages.length === 0) throw new Error('stages 必须是非空数组')
  if (rawStages.length > STAGE_LIMIT) throw new Error(`stages 最多 ${STAGE_LIMIT} 条`)
  const stages = rawStages.map((s, i) => normalizeStage(s, i))
  const seen = new Set()
  for (const s of stages) {
    if (seen.has(s.role)) throw new Error(`stages 中 role 重复：${s.role}`)
    seen.add(s.role)
  }
  const existing = new Set(db.prepare('SELECT role FROM space_stages WHERE scope = ?').all(scope).map(r => r.role))
  for (const s of stages) {
    if (s.next !== null && !seen.has(s.next) && !existing.has(s.next)) throw new Error(`阶段 ${s.role} 的 next=${s.next} 既不在本次提交里，也不是该空间既有阶段`)
  }
  return stages
}

function normalizeRuntime(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runtime 必须是对象')
  const enabled = raw.enabled === true
  const maxWorkers = raw.maxWorkers === undefined ? 1 : Number(raw.maxWorkers)
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) throw new Error('maxWorkers 必须是 1..8 的整数')
  const isolate = raw.isolate !== false
  return { enabled, maxWorkers, isolate }
}

/** 读该空间流水线（读路径：守护每轮 + 指挥台展示共用）。 */
function readPipeline(scope, { includeDisabled = true } = {}) {
  const rows = db.prepare('SELECT * FROM space_stages WHERE scope = ? ORDER BY sort, role').all(scope)
  const stages = rows.map(r => ({
    role: r.role,
    label: r.label,
    prompt: r.prompt ?? '',
    next: r.next ?? null,
    gate: r.gate === 1,
    artifact: r.artifact ?? null,
    docs: parseJson(r.docs, null),
    sort: r.sort ?? 0,
    enabled: r.enabled !== 0,
    updatedAt: r.updatedAt ?? null,
  }))
  const rt = db.prepare('SELECT * FROM space_runtime WHERE scope = ?').get(scope)
  const runtime = rt
    ? { enabled: rt.enabled === 1, maxWorkers: rt.maxWorkers ?? 1, isolate: rt.isolate !== 0, updatedAt: rt.updatedAt ?? null }
    : { enabled: false, maxWorkers: 1, isolate: true, updatedAt: null }
  const effective = stages.filter(s => s.enabled)
  return {
    scope,
    name: scope,
    version: pipelineVersion(stages),
    runtime,
    stages: includeDisabled ? stages : effective,
    activeRoles: effective.map(s => s.role),
  }
}

/** 稳定指纹：内容变化才变（守护据此零成本判「无需重建」）。 */
function pipelineVersion(stages) {
  const h = createHash('sha1')
  for (const s of stages) {
    h.update([s.role, s.label, s.enabled ? 1 : 0, s.next ?? '', s.gate ? 1 : 0, s.artifact ?? '', (s.docs ?? []).join(','), s.prompt.length].join('\u0001'))
    h.update('\u0002')
  }
  return h.digest('hex').slice(0, 16)
}

/** 该空间 stage 行（按 role），建链/校验用。 */
function stagesByRoleOf(scope) {
  return new Map(db.prepare('SELECT role, label, enabled FROM space_stages WHERE scope = ?').all(scope).map(r => [r.role, r]))
}

/**
 * 编队 × 流水线 一致性告警（写路径回执与开通预检共用）。
 * 关键一条：编队里有、流水线里没有（或 enabled=0）的成员 = 不会进链（安全）；
 * 但**如果没有配置任何流水线**而编队非空，则建链会退回「全编队」——此时非执行岗会重新入链并造成死锁，
 * 因此「未配置流水线」本身是 error 级告警。
 */
function pipelineWarnings(scope, view) {
  const warnings = []
  const roster = db.prepare('SELECT role, name FROM roster WHERE scope = ? ORDER BY sort, role').all(scope)
  const rosterRoles = new Set(roster.map(r => r.role))
  const stageRoles = new Set(view.stages.map(s => s.role))
  const active = new Set(view.activeRoles)
  if (view.stages.length === 0) {
    if (roster.length > 0) {
      warnings.push({
        level: 'error', code: 'pipeline-missing',
        message: `空间 ${scope} 未配置流水线（编队 ${roster.length} 人）——发布目标会按「全编队」建链，非执行岗将造成 blockedBy 链死锁`,
        roles: roster.filter(r => !active.has(r.role)).map(r => r.role),
      })
    }
    return warnings
  }
  const orphanRoster = roster.filter(r => !active.has(r.role)).map(r => r.role)
  if (orphanRoster.length > 0) {
    warnings.push({
      level: 'warn', code: 'roster-not-in-pipeline',
      message: `编队中 ${orphanRoster.length} 个成员不参与流水线（不会进目标链，也不会被派工）：${orphanRoster.join('、')}`,
      roles: orphanRoster,
    })
  }
  const orphanStage = view.stages.filter(s => s.enabled && !rosterRoles.has(s.role)).map(s => s.role)
  if (orphanStage.length > 0) {
    warnings.push({
      level: 'warn', code: 'stage-not-in-roster',
      message: `流水线中 ${orphanStage.length} 个岗位不在编队里（无编队成员 → 目标链不会生成该环，目前是冗余配置）：${orphanStage.join('、')}`,
      roles: orphanStage,
    })
  }
  const badGate = view.stages.filter(s => s.gate && !s.artifact).map(s => s.role)
  if (badGate.length > 0) {
    warnings.push({
      level: 'error', code: 'gate-without-artifact',
      message: `人工闸门缺少产物路径（闸门将永远无法通过）：${badGate.join('、')}`,
      roles: badGate,
    })
  }
  return warnings
}

function rowToTask(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    acceptance: parseJson(row.acceptance, []),
    boundary: parseJson(row.boundary, { do: [], dont: [] }),
    hold: row.hold === 1,
    priority: row.priority,
    status: row.status,
    version: row.version,
    soldier: row.soldier,
    claimedRound: row.claimedRound,
    claimedAt: row.claimedAt,
    ordersVersion: row.ordersVersion,
    parent: row.parent,
    role: row.role,
    scope: row.scope,
    blocks: parseJson(row.blocks, []),
    blockedBy: parseJson(row.blockedBy, []),
    comments: parseJson(row.comments, []),
    evidence: parseJson(row.evidence, []),
    // PRT-404：任务行把三列都摊开（写入的响应要能回读到自己刚写的那一条）。
    // ★ 摊开**不等于**会被装配进上下文：`sources.mjs` 的 `taskSource` 用的是
    //   显式字段白名单（`['id','scope','title','description','status','role',
    //   'assignee','goalId','createdAtMs','updatedAtMs']`），`feedback` 不在里面；
    //   而 `comments` 那一栏由装载器的 `toComments(task)` 只读 `task.comments`。
    //   也就是说"反馈不会被误当成评论"这件事**不靠这里的取舍**，靠的是
    //   两个来源各自读各自的那一列。这一条的用例在 sources-loader 套件里。
    feedback: parseJson(row.feedback, []),
    patches: parseJson(row.patches, []),
    artifacts: parseJson(row.artifacts, []),
    slice: row.slice ?? null,
    sliceIdx: row.sliceIdx ?? null,
    fixOf: row.fixOf ?? null,
    fixCount: row.fixCount ?? 0,
    goalId: row.goalId ?? null,
    fileDomain: parseJson(row.fileDomain, null),
    docSync: !!row.docSync,
    testReport: parseJson(row.testReport, null),
    reviewNotes: parseJson(row.review_notes ?? '[]', []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function listTasks(filter = {}) {
  const where = []
  const params = {}
  if (filter.status) { where.push('status = $status'); params.status = filter.status }
  if (filter.soldier) { where.push('soldier = $soldier'); params.soldier = filter.soldier }
  if (filter.role) { where.push('role = $role'); params.role = filter.role }
  if (filter.scope) { where.push('scope = $scope'); params.scope = filter.scope }
  const sql = `SELECT * FROM tasks${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`
  const rows = db.prepare(sql).all(params)
  return rows.map(rowToTask)
}

function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!row) throw new Error(`未知任务 ${id}`)
  return rowToTask(row)
}

// ── 多目标（goal）辅助：每目标独立记录 + 按 goalId 统计链进度 ──
const GOAL_STATUSES = ['active', 'paused', 'done', 'canceled']
/** 目标行 → API 对象。 */
function rowToGoal(row) {
  if (!row) return null
  return {
    id: row.id,
    scope: row.scope,
    objective: row.objective,
    status: row.status,
    version: row.version,
    mode: row.mode ?? 'chain',
    docsDir: row.docsDir ?? null,
    // 幂等转换：goalView(getGoal()) 会把已转换对象二次传入 rowToGoal，
    // 严格 ===1 对二次传入的 boolean true 恒 false（RC-2 现场）；!! 对 1/0/true/false 均正确且幂等。
    docSync: !!row.docSync,
    context: row.context ?? '',
    contextVersion: row.contextVersion ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt ?? null,
  }
}
function getGoal(id) {
  const row = db.prepare('SELECT * FROM goal WHERE id = ?').get(id)
  if (!row) throw new Error(`未知目标 ${id}`)
  return rowToGoal(row)
}
/** 目标的分析文档目录（相对仓库根）：有 docsDir（docs/<goalId>）用目标目录；遗留目标/未知目标返回 null（= 根 docs/ 固定槽位）。 */
function goalDocDirOf(goalId) {
  if (typeof goalId !== 'string' || goalId.length === 0) return null
  try {
    const g = getGoal(goalId)
    return g.docsDir || null
  } catch {
    return null
  }
}
/** 目标作用域下的阶段文档路径：docsDir 非空 → `${docsDir}/<文件>`；否则遗留 → `docs/<文件>`。 */
function goalDocPathOf(goalId, filename) {
  const dir = goalDocDirOf(goalId)
  const base = String(filename).split('/').pop() || filename
  return dir ? `${dir}/${base}` : `docs/${base}`
}
/** 目标链任务统计：该目标（goalId 关联）未取消任务的完成情况（canceled 链任务不计入分母）。 */
function goalStats(goal) {
  const rows = db.prepare("SELECT status, COUNT(*) AS c FROM tasks WHERE goalId = ? AND status != 'canceled' GROUP BY status").all(goal.id)
  const done = rows.filter(r => r.status === 'done').reduce((a, r) => a + Number(r.c), 0)
  const total = rows.reduce((a, r) => a + Number(r.c), 0)
  return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 }
}
/** 目标行 + 实时统计（API 列表用）。 */
function goalView(row) {
  return { ...rowToGoal(row), ...goalStats(row) }
}
/** scope 的目标列表：active/paused 在前（新的在前），done/canceled 归档在后。 */
function listGoals(scope) {
  const rank = { active: 0, paused: 1, done: 2, canceled: 3 }
  return db.prepare('SELECT * FROM goal WHERE scope = ?').all(scope)
    .map(rowToGoal)
    .sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(b.id).localeCompare(String(a.id)))
}
/** 目标自动收尾：active 目标若其链任务全部完成（total>0 且 done==total）→ done（记审计，终态时间）。 */
function settleGoalsOfScope(scope, by = 'general') {
  const active = listGoals(scope).filter(g => g.status === 'active')
  let settled = 0
  for (const g of active) {
    const s = goalStats(g)
    if (s.total > 0 && s.done === s.total) {
      const at = now()
      db.prepare("UPDATE goal SET status='done', version=version+1, updatedAt=?, endedAt=? WHERE id=? AND status='active'").run(at, at, g.id)
      audit(by, scope, 'goal:done', g.id, { objective: g.objective }, g.id)
      settled += 1
    }
  }
  return settled
}

/** 目标是否已收口（done/canceled）。目标行不存在时返回 false（新建目标的正常路径）。 */
function goalIsClosed(goalId) {
  if (typeof goalId !== 'string' || goalId.length === 0) return false
  const g = db.prepare('SELECT status FROM goal WHERE id = ?').get(goalId)
  return g !== undefined && (g.status === 'done' || g.status === 'canceled')
}

/**
 * 建任务前的收口断言：**拒绝**给已 done/canceled 的目标新建任务。
 *
 * 动机（T-156 现场 → 2026-09-16 复发）：给流水线末环补 `next`（新增运营/投广阶段）时，历史**已收口**
 * 目标的末环任务被守护判为「该有后继」，于是凭空长出新任务链——与当前目标的同岗位链并存，
 * 产物路径相同会互相覆盖。
 *
 * 守护侧虽有「目标终态不补建后继」判断，但它读的是**守护进程内的缓存**，且缓存缺失时**放行**
 * （fail-open）——旧代码、或缓存尚未就绪的窗口里都拦不住（2026-09-16 实测：守护比该防御早启动 27 分钟，
 * 于是历史收口目标上长出了 4 个任务，其中 1 个已在跑）。故在**数据层**补唯一收口点：
 * 无论谁建（守护补建、切片展开、fix 回炉、手工 /api/create）都拦得住。
 *
 * 恢复路径：done/canceled 都是**终态，不可恢复为 active**（见 setGoalState：只有 paused 可恢复）。
 * 确实要续做该目标的工作，应**发布新目标**（POST /api/goal）承接——目标是工作的单位，
 * 收口即结束；续做是新目标的事，不应由后台补建隐式塞回旧目标。
 */
function assertGoalOpen(goalId) {
  if (!goalIsClosed(goalId)) return
  const g = db.prepare('SELECT status, objective FROM goal WHERE id = ?').get(goalId)
  throw new Error(
    `目标 ${goalId} 已 ${g.status}（${String(g.objective).slice(0, 40)}）——收口目标不再接受新任务；` +
    `done/canceled 是终态不可恢复，如需续做请发布**新目标**（POST /api/goal）承接`,
  )
}

/** 目标 ID 分配：G-<毫秒时间戳36进制>-<进程内递增>，进程内/跨重启均不碰撞。 */
let goalSeq = 0
function nextGoalId() {
  goalSeq += 1
  return `G-${Date.now().toString(36)}-${goalSeq.toString(36)}`
}

/**
 * 发布目标（多目标并发模型，POST /api/goal 的函数体）：
 * 每次**新建**一个目标记录（active，version=1）+ 为该目标生成独立阶段任务链（链任务挂 goalId）。
 * **不取消**该空间既有目标/旧链任务——目标并存、各自推进。返回 { goal, stages, mode, objective }。
 * 目标级分析文档命名空间：新目标分配 docsDir = `docs/<goalId>`（阶段产物文档进目标独立目录，
 * 跨目标分析前缀可安全并行）；本列上线前已发布的目标 docsDir=NULL，沿用根 docs/ 固定槽位（旧链兼容）。
 */
function publishGoalRecord(targetScope, objective, mode = 'chain', by = 'general', docSync = false) {
  return withTx(() => {
    const rawMode = mode === 'slice' ? 'slice' : 'chain'
    const t = now()
    const goalId = nextGoalId()
    db.prepare('INSERT INTO goal (id, scope, objective, status, version, mode, createdAt, updatedAt, endedAt, docsDir, docSync) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(goalId, targetScope, objective.trim(), 'active', 1, rawMode, t, t, null, `docs/${goalId}`, docSync === true ? 1 : 0)
    const chain = createGoalChain(goalId, targetScope, objective.trim(), rawMode)
    // 记录实际生效的模式（slice 缺岗会回退 chain）
    if (chain.mode !== rawMode) {
      db.prepare('UPDATE goal SET mode=?, updatedAt=? WHERE id=?').run(chain.mode, now(), goalId)
    }

    // ── PRT-402：**目标创建时冻结这一版的团队计划** ──────────────────────
    //
    // spec 第 7 行把 TeamPlan 定义为「目标创建时**冻结**的团队、岗位、流水线
    // 和能力包组合快照」。这句话里"目标创建时"是**时间点**，而在此之前
    // 没有任何地方做这件事——读端点、表、装载器都齐了，只有那个时点没接。
    //
    //   > 一个"读写两端都齐、只是没人写"的数据面，
    //   > 与一个"根本没有这张表"的数据面，在**第一次运行**的时候是同一个东西——
    //   > 只不过前者的用例是绿的。
    //
    // ★ 这里**刻意不把目标正文（`objective`）抄进计划**。`teamPlanSource` 会
    //   序列化 `title`/`objective`，而这两样是**用户散文**；计划里放它们会带来
    //   一个没人要的新失败模式：一句长得像密钥的正文会让**发布目标**失败，
    //   而真正把正文发给供应商的那条路（目标上下文，PRT-403）一点没变。
    //
    //   > 一个"把目标正文抄进团队计划"的冻结，
    //   > 与一个"只冻结团队、岗位与流水线"的冻结，在正文不含密钥时是同一个东西——
    //   > 只不过前者会让一次发布目标因为一句像密钥的正文而**失败**，
    //   > 而那条真正的泄漏路径一点没变。
    //
    //   正文仍然进上下文——走目标来源，那是它唯一该走的地方。
    //   计划只说自己该说的话：这次运行时，团队与流水线是什么样。
    //
    // ★ 空编队也**照样冻结**（`stages: []`）。那是一句**真话**："创建这一刻
    //   流水线是空的"，而 `missing` 说的是"我们没去看"。两者在跑起来之后
    //   完全一样（都没有阶段），但在快照上一个是事实、一个是缺口。
    const frozen = contextPlanStore().putTeamPlan({
      id: goalId,
      version: 1,
      goalId,
      title: `目标 ${goalId} 的团队计划`,
      stages: chain.tasks.map((t) => ({ role: t.role, label: t.label })),
      note: `目标创建时冻结（编队 ∩ 流水线，${chain.mode} 模式，${chain.count} 个阶段）`,
    }, { scope: targetScope, actor: by })

    audit(by, targetScope, 'goal:publish', goalId, { goal: goalId, objective: objective.trim(), mode: chain.mode, stages: chain.count }, goalId)
    return {
      goal: goalView(getGoal(goalId)),
      stages: chain.count,
      mode: chain.mode,
      objective: objective.trim(),
      // 冻结结果的引用：调用方与验收用例要能一眼看到"计划被冻住了、冻的是第几版"。
      teamPlan: { id: frozen.plan.id, version: frozen.plan.version, stages: frozen.plan.stages.length },
    }
  })
}

/**
 * 目标状态迁移（POST /api/goal/status 的函数体，仅将军）：
 * active ↔ paused（暂停/恢复）；done / canceled 为终态（自动收尾或将军手动）。
 * canceled 同步取消该目标**未开工**（backlog/todo/blocked）的链任务；在办/待验收留给将军收尾，不硬杀，
 * 但逐条追加提示评论并置 hold（strandOpenTasksOfCanceledGoal）——否则它们会静默滞留在「待我决定」。
 * 返回 { goal, changed, canceledTasks, strandedTasks }。
 */
/**
 * 目标取消后的**在办任务留痕**（setGoalState 的 to==='canceled' 分支专用）：
 *
 * 纪律：取消目标只硬杀未开工（backlog/todo/blocked）的链任务；in_progress / in_review 属于在办，
 * 不静默处决（可能已有真实产出待裁决）。但"不杀"不等于"不用管"——目标一旦取消，这些任务
 * 既没有下游流转、也没有人会再推进它，若不留痕就会静默躺在「待我决定」里直到将军偶然发现
 * （T-141 现场：目标于 20:36 取消，任务停在 in_review 无人知，1.5 小时后将军从看板上才发现）。
 *
 * 因此逐条：① 追加一条显式提示评论（说明所属目标已取消 + 三条可选处置）；② 置 hold=1，
 * 挡住守护对它的自动认领/自动流转，把裁决权收回到将军（放行/验收/取消都在任务详情里一键完成）。
 * 返回被留痕的任务 id 列表（审计字段 strandedTasks）。
 */
function strandOpenTasksOfCanceledGoal(goalId, by, at) {
  const STATUS_LABEL = { in_progress: '进行中', in_review: '待验收' }
  const open = db.prepare("SELECT id, status FROM tasks WHERE goalId=? AND status IN ('in_progress','in_review') ORDER BY id").all(goalId)
  const stranded = []
  for (const row of open) {
    const t = getTask(row.id)
    const comments = parseJson(t.comments, [])
    comments.push({
      by,
      at,
      text: `⚠ 所属目标 ${goalId} 已取消（goal:cancel）：本任务当前停在「${STATUS_LABEL[row.status] ?? row.status}」，`
        + '不会再有下游流转，也不会被自动推进。已自动标「将军拦截」以免守护继续认领/流转。'
        + '请将军裁决：产出可用 → 验收通过（推进 done，如 T-141 式的历史产物）／无保留价值 → 取消／仍需交付 → 转派重做。',
    })
    db.prepare('UPDATE tasks SET hold=1, comments=?, version=version+1, updatedAt=? WHERE id=?')
      .run(JSON.stringify(comments), at, row.id)
    stranded.push(row.id)
  }
  return stranded
}

function setGoalState(id, to, by = 'general', forceGeneral = false) {
  return withTx(() => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
    if (!GOAL_STATUSES.includes(to)) throw new Error(`status 必须是 ${GOAL_STATUSES.join('|')}`)
    if (by !== 'general' && forceGeneral !== true) throw new Error('目标状态仅允许将军（by=general）变更')
    const g = getGoal(id)
    if (g.status === to) return { goal: goalView(g), changed: false, canceledTasks: 0, strandedTasks: [] }
    if (g.status === 'canceled') throw new Error(`目标 ${id} 已取消，不可再变更`)
    if (to === 'active' && g.status !== 'paused') throw new Error(`只有 paused 的目标可恢复（当前 ${g.status}）`)
    if (to === 'paused' && g.status !== 'active') throw new Error(`只有 active 的目标可暂停（当前 ${g.status}）`)
    if (to === 'canceled' && g.status === 'done') throw new Error('已完成的目标无需取消（如需归档可直接忽略）')
    const at = now()
    const terminal = to === 'done' || to === 'canceled'
    db.prepare('UPDATE goal SET status=?, version=version+1, updatedAt=?, endedAt=? WHERE id=?')
      .run(to, at, terminal ? at : null, id)
    let canceledTasks = 0
    let strandedTasks = []
    if (to === 'canceled') {
      // 只取消未开工的链任务（in_progress/in_review 属于在办，交给将军收尾）
      canceledTasks = db.prepare("UPDATE tasks SET status='canceled', version=version+1, updatedAt=? WHERE goalId=? AND status IN ('backlog','todo','blocked')").run(at, id).changes
      strandedTasks = strandOpenTasksOfCanceledGoal(id, by, at)
    }
    const action = to === 'paused' ? 'goal:pause' : to === 'active' ? 'goal:resume' : to === 'done' ? 'goal:done' : 'goal:cancel'
    audit(by, g.scope, action, id, { goal: id, objective: g.objective, canceledTasks, strandedTasks }, id)
    return { goal: goalView(getGoal(id)), changed: true, canceledTasks, strandedTasks }
  })
}

/**
 * 更新目标级上下文（POST /api/goal/context 的函数体，仅将军）：
 * 目标上下文 = 同目标所有衍生任务共享的"目标级订单"（objective 之外的设计约束/文件域地图/验收口径）。
 * 更新 bump contextVersion（乐观锁 + 审计 + SSE）——语义 = 下一派工对齐（正在跑的 worker 不打断，
 * 下一次派工把最新 context/版本注入提示词与镜像文件）。
 */
function setGoalContext(id, text, by = 'general', forceGeneral = false) {
  return withTx(() => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
    if (typeof text !== 'string' || text.trim().length === 0) throw new Error('context 必须是非空字符串')
    if (by !== 'general' && forceGeneral !== true) throw new Error('目标上下文仅允许将军（by=general）变更')
    const g = getGoal(id)
    if (g.status === 'done' || g.status === 'canceled') throw new Error(`目标 ${id} 已 ${g.status}，不可再更新上下文`)
    const clean = text.trim()
    const nextVersion = (g.contextVersion ?? 0) + 1
    const at = now()
    db.prepare('UPDATE goal SET context=?, contextVersion=?, updatedAt=? WHERE id=?')
      .run(clean, nextVersion, at, id)
    audit(by, g.scope, 'goal:context', id, { goal: id, contextVersion: nextVersion, chars: clean.length }, id)
    return { goal: goalView(getGoal(id)), changed: true }
  })
}

function assertUnblocked(t, force) {
  if (force) return
  const open = t.blockedBy.filter((b) => {
    const dep = db.prepare('SELECT status FROM tasks WHERE id = ?').get(b)
    return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
  })
  if (open.length > 0) throw new Error(`任务被未完成依赖阻塞：${open.join(', ')}（确认后加 force）`)
}

/** 写事务：BEGIN IMMEDIATE 串行化写 + 版本检查（乐观锁）。
 *  支持嵌套：内层以 SAVEPOINT 实现（发布目标 publishGoalRecord 外层 + createGoalChain 内层等场景）。 */
let txDepth = 0
function withTx(mutate) {
  const nested = txDepth > 0
  const name = `tx_sp_${txDepth + 1}`
  if (nested) db.exec(`SAVEPOINT ${name}`)
  else db.exec('BEGIN IMMEDIATE')
  txDepth += 1
  try {
    const result = mutate()
    if (nested) db.exec(`RELEASE ${name}`)
    else db.exec('COMMIT')
    txDepth -= 1
    return result
  } catch (e) {
    try {
      if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) }
      else db.exec('ROLLBACK')
    } catch { /* 已回滚 */ }
    txDepth -= 1
    throw e
  }
}

function nextId() {
  // 必须按「现有最大 T- 编号 + 1」分配，而不是 COUNT(*)+1：
  // COUNT 在库里出现过删除（清空间/清理）产生空号后 < 最大编号，会撞上仍存在的任务
  // （实测 115 行 / max T-118 → COUNT+1 得 T-116，命中 T-116 → UNIQUE constraint failed: tasks.id）。
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS m FROM tasks WHERE id GLOB 'T-[0-9]*'").get()
  const m = row && Number.isFinite(row.m) ? row.m : 0
  return `T-${String(m + 1).padStart(3, '0')}`
}

function audit(member, scope, action, taskId, detail, goalId = null) {
  // P1-1 第 2 步现场：audit.seq 曾用进程内内存计数器（启动读一次 MAX(seq)，此后 nextSeq++），
  // 8787 独立进程与 3080 宿主 v2 外壳双进程写同一 team.db 时各自从同起点递增 → 撞
  // UNIQUE constraint failed: audit.seq（写冒烟 400 实证）。改为与 INSERT 同一写事务内
  // 读库 MAX 分配：BEGIN IMMEDIATE 由 SQLite 数据库级锁串行化（busy_timeout 5000 兜底等待），
  // 跨进程不再撞号。withTx 支持嵌套（外层事务内调用走 SAVEPOINT，广播语义不变）。
  return withTx(() => {
    const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM audit').get()
    const seq = (row?.m ?? 0) + 1
    db.prepare('INSERT INTO audit (seq, ts, member, scope, action, taskId, detail, goalId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      // `detail ?? null` 不是多余的防御：`JSON.stringify(undefined)` 返回的是
      // **`undefined`**（不是字符串），于是绑定到 SQLite 参数时抛
      // 「Provided value cannot be bound to SQLite parameter 7」——
      // 一个"某处少传了一个可选字段"的错误，以一条 SQLite 绑定错误的形式
      // 出现在完全无关的层。PRT-503 实测撞到过：账本的无预算分支没传 detail。
      //
      // 审计字段是**诊断**，不该让真实业务操作失败；但它也不能被静默丢掉
      // ——所以落 `null`（"没有诊断载荷"），而不是省略这一列。
      .run(seq, now(), member, scope, action, taskId, JSON.stringify(detail ?? null), goalId)
    broadcastAudit(auditEvent({ seq, ts: now(), member, scope, action, taskId, goalId, detail }))
    return seq
  })
}

function permissionRuleView(row) {
  if (!row) return null
  return { ...row }
}

export function upsertPermissionRule(input = {}) {
  const mode = String(input.mode ?? '')
  if (!['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy'].includes(mode)) throw new Error('permission mode 非法')
  const id = String(input.id ?? '').trim()
  if (!id) throw new Error('缺少规则 id')
  const scope = input.scope == null ? null : String(input.scope).trim() || null
  const actor = input.actor == null ? null : String(input.actor).trim() || null
  const action = input.action == null ? null : String(input.action).trim() || null
  const target = input.target == null ? null : String(input.target).trim() || null
  const taskId = input.taskId == null ? null : String(input.taskId).trim() || null
  const stamp = now()
  withTx(() => db.prepare(`INSERT INTO permission_rules (id,scope,actor,action,target,mode,taskId,expiresAt,createdBy,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,actor=excluded.actor,action=excluded.action,target=excluded.target,mode=excluded.mode,taskId=excluded.taskId,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt`)
    .run(id, scope, actor, action, target, mode, taskId, input.expiresAt == null ? null : Number(input.expiresAt), String(input.by || 'general'), stamp, stamp))
  audit(String(input.by || 'general'), scope || 'global', 'permission:rule', id, { mode, scope, actor, action, target, taskId })
  return permissionRuleView(db.prepare('SELECT * FROM permission_rules WHERE id=?').get(id))
}

export function deletePermissionRule(id, by = 'general') {
  const key = String(id ?? '').trim()
  if (!key) throw new Error('缺少规则 id')
  const result = withTx(() => db.prepare('DELETE FROM permission_rules WHERE id=?').run(key))
  if (!result.changes) throw new Error('规则不存在')
  audit(by, 'global', 'permission:rule-delete', key, {})
  return { id: key, deleted: true }
}

function permissionRows() {
  return db.prepare('SELECT * FROM permission_rules').all().map(permissionRuleView)
}

/**
 * 权限判定入口。
 *
 * `deps.consume` 是一个**可注入的接缝**（默认就是 `consumeBinding`），存在的唯一
 * 理由是让"CAS 没抢到"那条路径可以被**真的走到**：那条路径只有在并发时序恰好
 * 落在两次调用之间时才会发生，而一个只能靠时序触发的分支，与一个不存在的分支，
 * 在"它到底拦不拦得住"上是同一个东西。
 *
 * 它不可能被 HTTP 调用方利用：函数不能经 JSON 传进来，而路由只传请求体。
 * 这与 `createLauncher` / `createWizard` / `createTray` 收依赖的方式是同一套。
 */
export function checkPermission(input = {}, { consume = consumeBinding } = {}) {
  // PRT-615：先让到期的审批结清，再判这一次。
  // 不先扫的话，一次已经越过 TTL 的 `pending` 行会被当成"还在等"——
  // 于是自动拒绝永远只在**下一次**有人问起时才发生（如果还有人问的话）。
  sweepApprovalsLazily()
  const operation = normalizeOperation(input)
  const requestId = input.permissionRequestId ? String(input.permissionRequestId) : null
  if (requestId) {
    const row = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(requestId)
    // PRT-608：消费走 `verifyBinding`，它**先看这一行绑了什么**，再看这次调用是不是它。
    //
    // 顺序是有意的。PRT-611 把这里换成了 `sameOperation(row.operation, operation)`，
    // 那是拿"当场重算的指纹"与"当场重算的指纹"比——对一条没有绑定哈希的旧行，
    // 它**恒等**，于是通过。而"这行绑了什么"在旧行上恰好是一个没有答案的问题。
    //
    //   > 一个"老的审批行没有哈希，那就跳过哈希校验"的回退，
    //   > 与一个"任何审批都放行"的回退，是同一个东西。
    const verdict = verifyBinding({ row, operation, nowMs: Date.now() })
    if (!verdict.ok) {
      // 哪些拒绝该**大声报错**、哪些该**继续走策略判定**，是一个有意的划分：
      //
      //   大声报错（下面的表）：调用方**声称**自己持有一次对这次调用的批准，
      //     而那个声称不成立。静默落回策略判定会把"你拿的这张票不对"伪装成
      //     "这次需要新的批准"，于是没有人会去看那张票为什么不对。
      //
      //   继续走策略（NOT_APPROVED / ALREADY_CONSUMED）：调用方只是**提起**了
      //     一个请求，而这次调用本来就还没被批准（或那次一次性批准已经用掉了）。
      //     落回策略判定会正常产生一条新的待批准请求——这正是"一次性"该有的样子。
      //     把 ALREADY_CONSUMED 也改成抛错，会让"用掉之后再发起"变成一个错误，
      //     而它其实是一次**正常的新申请**。
      //
      //   找不到行：同理，落回策略。
      const LOUD = new Set([
        BINDING_CODES.OPERATION_CHANGED,
        BINDING_CODES.UNBOUND,
        BINDING_CODES.EXPIRED,
      ])
      if (LOUD.has(verdict.code)) {
        audit(operation.actor, operation.scope, 'permission:binding-rejected', requestId, {
          action: operation.action, target: operation.target, code: verdict.code,
          bindingHash: verdict.bindingHash, actualHash: verdict.actualHash ?? null,
        })
        throw new Error(`permission operation mismatch（${verdict.code}：${verdict.userText}）`)
      }
    }
    if (verdict.ok) {
      // PRT-608：CAS 单独导出成 `consumeBinding`，这样"没抢到"那条路径可以被
      // 真的走到。一个只能靠并发时序才能触发的分支，与一个不存在的分支，
      // 在"它到底拦不拦得住"上是同一个东西。
      //
      // PRT-616：**行级 CAS 不够**。它保证的是"这一行只被消费一次"，而危险场景里
      // 根本不存在"这一行"：同一个 Attempt 内两次参数完全相同的并发调用会各自
      // 写下一条待批准行，各被批准一次，然后**各自**成功消费一次——行级 CAS
      // 全程尽职，而同一个操作执行了两次。
      //
      //   > 一个「每一行都只被消费一次」的 CAS，
      //   > 与一个「同一个操作被放行两次」的 CAS，在「它到底防住了什么」上是同一个东西。
      //
      // 所以再上一把按**(attemptId, bindingHash)** 的锁，两步放进**同一个事务**：
      // 要么占位 + 消费都成立，要么都不成立。
      const attemptId = input.attemptId == null ? null : String(input.attemptId).trim() || null
      const callId = input.callId == null ? null : String(input.callId)
      const claim = withTx(() => {
        const claimed = claimOnce({
          db, attemptId, bindingHash: verdict.bindingHash, requestId, consumedAtText: now(), callId,
        })
        if (claimed.outcome !== CLAIM_OUTCOMES.CLAIMED) return { stage: 'claim-lost', claimed }
        const taken = consume({ db, requestId, bindingHash: verdict.bindingHash, consumedAtText: now() })
        if (taken.outcome !== CONSUME_OUTCOMES.CONSUMED) {
          // 占位成功、行级 CAS 输了 → 这一次**没有**放行，占位必须退回。
          // 不退的话，一次竞争会把这张票**永久**废掉：用户批准了，没人执行，
          // 而且之后无论怎么重试都是"这个操作已经用过了"。
          releaseClaim({ db, key: claimed.key })
          return { stage: 'row-lost', claimed }
        }
        return { stage: 'consumed', claimed }
      })
      if (claim.stage === 'consumed') {
        audit(operation.actor, operation.scope, 'permission:consume', requestId, {
          action: operation.action, target: operation.target, bindingHash: verdict.bindingHash,
          attemptId, attemptScoped: claim.claimed.attemptScoped, callId,
        })
        return {
          allowed: true, decision: 'allow', status: 'consumed', requestId,
          bindingHash: verdict.bindingHash, operation,
          attemptId, attemptScoped: claim.claimed.attemptScoped,
        }
      }
      if (claim.stage === 'claim-lost') {
        // ★ 同一 Attempt 内同一个 canonical 哈希已经被放行过一次。
        // 这正是 spec §6.5 要挡的那件事：**不得放行两次**。
        audit(operation.actor, operation.scope, 'permission:allow-once-duplicate', requestId, {
          action: operation.action, target: operation.target, bindingHash: verdict.bindingHash,
          attemptId, code: ALLOW_ONCE_CODES.ATTEMPT_DUPLICATE, callId,
        })
        throw new Error(
          `permission operation mismatch（${ALLOW_ONCE_CODES.ATTEMPT_DUPLICATE}：`
          + '同一个 Attempt 内这个操作已经放行过一次，不得重复放行）',
        )
      }
      // CAS 没成功：这一行在我们校验之后被别人消费掉了（或被换成了另一条绑定）。
      // **不能**回退到"再查一次然后放行"——那就是一次批准放行两次。
      audit(operation.actor, operation.scope, 'permission:binding-lost-race', requestId, {
        action: operation.action, target: operation.target, bindingHash: verdict.bindingHash,
      })
      throw new Error(`permission operation mismatch（${BINDING_CODES.ALREADY_CONSUMED}：这条审批已被并发消费）`)
    }
  }
  const result = evaluatePermission(operation, permissionRows(), { now: Date.now() })
  if (result.status !== 'pending') return result
  // PRT-611/608：去重必须用**与消费时同一个**身份判定。
  //
  // 原来这里按 scope/actor/action/target 四个字段去重，而消费时按规范化后的
  // **全部**字段比对。两条不同粒度的判断放在一起，表现是：一次 `taskId` 不同的
  // 调用会复用上一次的待批准请求，用户批准之后消费方却因为指纹不同而拒绝——
  // 用户看到的是"我批了，它说操作不匹配"。
  //
  //   > 一个用四个字段去重的待批准表，与一个用全部字段去绑定的消费检查，
  //   > 是同一个东西——只不过它表现出来是"我明明批了，它说操作不匹配"。
  //
  // PRT-608 之后这一步就是**直接比哈希**：写进那一行的哈希是我们自己算的，
  // 不需要再解析 JSON、再跑一遍规范化。
  //
  // PRT-616 补上 `attempt_id`：**同一个**原则（去重的粒度必须等于消费的粒度）
  // 在这里还有一处没做到。消费侧的粒度现在是 `(attemptId, bindingHash)`，
  // 而去重侧只有哈希——于是**另一条 Attempt** 的待批准行会被本次复用。
  // 那意味着：Attempt #2 的模型发起同一个操作时，用户看到的是 Attempt #1 的申请，
  // 批准之后审计里挂在 Attempt #1 上，而实际执行发生在 Attempt #2。
  // `attempt_id IS ?` 是 SQLite 的 null 安全比较：没有 Attempt 的调用只与
  // 同样没有 Attempt 的行配对，不会去认领一条有主的。
  const wantedHash = computeBindingHash(operation)
  const dedupAttemptId = input.attemptId == null ? null : String(input.attemptId).trim() || null
  const existing = db
    .prepare(`SELECT * FROM permission_requests WHERE scope=? AND actor=? AND action=? AND target=? AND status='pending' AND ${BINDING_HASH_COLUMN}=? AND ${APPROVAL_ATTEMPT_COLUMN} IS ?`)
    .get(operation.scope, operation.actor, operation.action, operation.target, wantedHash, dedupAttemptId)
  if (existing) return { ...result, requestId: existing.requestId, bindingHash: wantedHash }
  const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // PRT-615：TTL 来自配置（`LEGION_APPROVAL_TTL_MS`，schema 里声明了合法区间），
  // 不再是写死的 15 分钟。写错的配置值在**装载时**就抛（`resolveApprovalTtlMs`），
  // 而不是静默换回默认值——那会表现成"配置改了但没生效"，排查方向完全错误。
  const ttlMs = APPROVAL_TTL_MS
  const attemptId = input.attemptId == null ? null : String(input.attemptId).trim() || null
  // PRT-608：**批准的那一刻**把哈希算出来并写进这一行。之后一切都以那一行为准。
  //
  //   > 一个"每次验证时按当前规则重算身份"的审批绑定，
  //   > 与一个"审批的含义由你读它的那一刻的代码决定"的绑定，
  //   > 是同一个东西——只不过前者的失效方式是**静默重绑**。
  //
  // PRT-615：同时写下 `attemptId`——"哪一个 Attempt 在等这份审批"。
  // 它与 `taskId` 不是一回事：任务重试之后是一条新 Attempt 而 taskId 不变，
  // 用 taskId 匹配会把上一条 Attempt 的审批算成本次的依据。
  withTx(() => db.prepare(`INSERT INTO permission_requests (requestId,scope,actor,action,target,taskId,operation,mode,status,createdAt,expiresAt,${BINDING_HASH_COLUMN},${APPROVAL_ATTEMPT_COLUMN}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, operation.scope, operation.actor, operation.action, operation.target, operation.taskId, JSON.stringify(operation), result.mode, 'pending', now(), Date.now() + ttlMs, wantedHash, attemptId))
  audit(operation.actor, operation.scope, 'permission:request', id, {
    action: operation.action, target: operation.target, mode: result.mode,
    bindingHash: wantedHash, attemptId, ttlMs,
  })
  return { ...result, requestId: id, bindingHash: wantedHash, expiresAtMs: Date.now() + ttlMs, attemptId }
}

/** 审批行的对外视图。**不把哈希藏起来**——UI 与审计要看到同一个字符串。 */
function permissionRequestView(row) {
  if (row === null || row === undefined) return null
  const operation = operationOfRow(row)
  return {
    ...row,
    operation,
    bindingHash: isBoundHash(row[BINDING_HASH_COLUMN]) ? row[BINDING_HASH_COLUMN].trim() : null,
    expiresAtMs: Number(row.expiresAt),
  }
}

export function listPermissionInbox(scope = null) {
  sweepApprovalsLazily()
  const rows = scope ? db.prepare('SELECT * FROM permission_requests WHERE scope=? ORDER BY createdAt DESC').all(scope) : db.prepare('SELECT * FROM permission_requests ORDER BY createdAt DESC').all()
  const current = Date.now()
  // PRT-608：`expired` 曾经是一个**算出来的**字段，而 `status` 仍然是 `pending`
  // ——同一件事有两个说法，而两个说法会在某个时刻不一致。
  // 现在过期是**先写库再返回**：`status` 变成 `expired`，视图里不再有第二个真相。
  const out = []
  for (const row of rows) {
    if (row.status === 'pending' && Number(row.expiresAt) <= current) {
      db.prepare("UPDATE permission_requests SET status='expired' WHERE requestId=? AND status='pending'").run(row.requestId)
      out.push(permissionRequestView({ ...row, status: 'expired' }))
      continue
    }
    out.push(permissionRequestView(row))
  }
  return out
}

export function decidePermission({ requestId, decision, by = 'general', reason = '' } = {}) {
  if (by !== 'general') throw new Error('仅允许 general 决定权限审批')
  // PRT-615：用户点批准之前先结清到期的。否则一条**已经越过 TTL** 的请求
  // 会先被"用户批准"这一步接受（只要没人先扫过），把"自动拒绝"变成一句空话——
  // 而用户看到的是"我批成功了"，实际上它早就该被拒了。
  sweepApprovalsLazily()
  const id = String(requestId ?? '').trim()
  if (!id || !['approve', 'deny'].includes(decision)) throw new Error('审批参数非法')
  const row = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(id)
  if (!row) throw new Error('审批请求不存在')
  if (row.status !== 'pending') return permissionRequestView(row)
  if (Number(row.expiresAt) <= Date.now()) {
    db.prepare("UPDATE permission_requests SET status='expired' WHERE requestId=? AND status='pending'").run(id)
    audit(by, row.scope, 'permission:expired', id, { action: row.action, target: row.target })
    return permissionRequestView({ ...row, status: 'expired' })
  }
  // PRT-608：**拒绝批准一条没有绑定哈希的请求**。
  //
  // 如果放它过去，这一行会变成 `approved` 且哈希仍为 NULL，于是用户在界面上
  // 看到"已批准"，执行时却拿到 `approval-unbound`。用户会以为是执行侧坏了。
  // 一条绑不了东西的审批，不该被允许变成"已批准"——**批准这个动作本身就该失败**，
  // 而且要告诉用户怎么办。
  if (!isBoundHash(row[BINDING_HASH_COLUMN])) {
    throw new Error('这条审批请求没有绑定哈希（旧版本创建），无法批准——请让发起方重新发起一次')
  }
  const status = decision === 'approve' ? 'approved' : 'denied'
  withTx(() => db.prepare('UPDATE permission_requests SET status=?, decidedBy=?, reason=?, decidedAt=? WHERE requestId=? AND status=\'pending\'').run(status, by, String(reason), now(), id))
  const updated = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(id)
  // 审计里带上哈希：值班的人要能从日志直接看出"批的是哪一次调用"，
  // 而不是去猜两个 action/target 相同、metadata 不同的请求是哪一个。
  audit(by, row.scope, `permission:${status}`, id, {
    action: row.action, target: row.target, reason: String(reason),
    bindingHash: row[BINDING_HASH_COLUMN].trim(),
  })
  return permissionRequestView(updated)
}

/**
 * PRT-615：审批 TTL 到期 → 自动拒绝 → Attempt 转为 `blocked`。
 *
 * spec §6.4：「`AwaitingApproval` 期间 heartbeat 继续、lease 随 heartbeat 续期，
 * 但受审批 TTL 约束；审批 TTL 到期自动 deny，Attempt 转为 `blocked`，
 * 写入 audit 并通知用户。」
 *
 * ## 为什么这里必须**同时**做两件事，而不是只改审批行的状态
 *
 * 只把审批行标成 `expired` 的话，Attempt 会**继续停在 `AwaitingApproval`**：
 * 界面上它是一条"等待审批"的待办，而审批已经过期了——于是它既不会被批准，
 * 也不会进入待人工处置列表，任务安静地停在那里。
 *
 *   > 一个「审批已过期、而 Attempt 还在等这份审批」的状态，
 *   > 与一个「任务永远停在那里、谁也不管」的状态，是同一个东西。
 *
 * ## 为什么用 `failAndRetry` 而不是直接改状态
 *
 * `AwaitingApproval → RetryableFailure` 只是**中间态**。停在那里的话，任务既没有
 * 新尝试可领（队列里没有 Queued），也不在等人工列表里（它不是 DeadLetter），
 * 表现是"失败了，但没人会去处理它"。`failAndRetry` 是「失败了按策略处置」的**唯一**
 * 入口，它会把重试额度判定也走完：有额度 → 新 attempt（任务回 todo）；
 * 没额度 → DeadLetter（任务进 **blocked**，正是 spec 要的那个终局）。
 *
 * ## `attemptId` 为空的行怎么办
 *
 * 老行（PRT-615 之前创建的）没有 `attemptId`。它们**照样**要过期和写审计，
 * 但**不动**任何 Attempt——无从判断该动哪一条。凭 `taskId` 猜一条是错的：
 * 同一个任务可能已经重试到第 5 条 Attempt，把第 1 条判成 blocked 会改错历史。
 * 所以这类行进单独的结果桶，并在审计里标明它没有被联动。
 */
/**
 * PRT-615：到期扫描的**唯一**入口，带重入保护。
 *
 * 为什么需要重入保护：这个函数会被 `checkPermission` / `listPermissionInbox` /
 * `decidePermission` 在**入口处**懒调用（见下面 `sweepApprovalsLazily`）。
 * 没有保护时，一次扫描里对每一条到期的审批都会走到 `runStore.failAndRetry`，
 * 而那条路径上的任何一次权限判定都会**再触发一次扫描** —— 递归。
 *
 * 重入时**直接返回上一次的结果**而不是空结果：调用方拿到的应当是"这一轮扫描的
 * 真实结论"，而一个空结果会被读成"扫描过了，没有到期的"——那是假的。
 */
let sweepInFlight = false
let lastSweepResult = null
export function sweepApprovalsOnce({ nowMs = Date.now(), actor = 'system:approval-ttl', store = runStore } = {}) {
  // ⚠️ 这里必须用一个**布尔标记**，不能靠 `sweepInFlight !== null`：
  // `sweepInFlight = sweepExpiredApprovals(...)` 的赋值是在函数**返回之后**才发生的，
  // 所以执行期间 `sweepInFlight` 仍然是 null —— 那个写法看起来有保护，其实一次都拦不住。
  //
  //   > 一个「看起来有重入保护、其实拦不住任何一次重入」的保护，
  //   > 与一个没有重入保护的保护，是同一个东西。
  if (sweepInFlight) return lastSweepResult
  sweepInFlight = true
  try {
    lastSweepResult = sweepExpiredApprovals({ nowMs, actor, store })
    return lastSweepResult
  } finally {
    sweepInFlight = false
  }
}

/**
 * 懒扫描：在权限面的**每个**读/写入口调一次。
 *
 * 为什么不只靠 `isMain` 下那个 `setInterval`：team-hub 既作独立进程运行，也被
 * 宿主外壳 `team-hub/src/index.ts` **import**（那条路径下 `isMain === false`，
 * 于是定时器根本不会装）。
 *
 *   > 一个「只在独立进程模式下才跑」的到期扫描，
 *   > 与一个「在宿主外壳模式下永远不跑」的到期扫描，是同一个东西——
 *   > 只不过它的表现是「有的人的审批会过期，有的人的不会」。
 *
 * 懒扫描让**正确性不再依赖启动模式**；定时器只是把"没人来问"的那段时间也覆盖到。
 * 扫描本身失败必须**吞掉并继续**：一个清理动作把正常的权限判定变成 500，
 * 比它没跑更糟。
 */
export function sweepApprovalsLazily(nowMs = Date.now()) {
  try {
    return sweepApprovalsOnce({ nowMs })
  } catch (e) {
    try {
      audit('system:approval-ttl', 'global', 'permission:ttl-sweep-failed', null, {
        message: String(e?.message ?? e),
      })
    } catch { /* 审计也失败时不掩盖原始错误 */ }
    return null
  }
}

export function sweepExpiredApprovals({ nowMs = Date.now(), actor = 'system:approval-ttl', store = runStore } = {}) {
  const atMs = Number(nowMs)
  if (!Number.isFinite(atMs)) throw new Error(`审批到期扫描需要合法时点，收到 ${JSON.stringify(nowMs)}`)
  const candidates = db.prepare(
    `SELECT * FROM permission_requests WHERE status IN ('pending','approved') ORDER BY expiresAt ASC`,
  ).all()
  const expired = []
  const released = []
  const orphaned = []
  for (const row of candidates) {
    const verdict = evaluateApprovalExpiry({ row, nowMs: atMs, ttlMs: APPROVAL_TTL_MS })
    if (!verdict.expired) continue
    // CAS：只把**仍然是开放状态**的那一行改成 expired（`markApprovalExpired`）。
    // 不带状态条件时，一次与用户点击批准并发的扫描会把"用户批准了"改写成"过期了"
    // ——两条都进终态，但用户在界面上看到的原因不同。
    const updated = withTx(() => markApprovalExpired({ db, requestId: row.requestId, reason: verdict.reason }))
    if (updated.outcome !== EXPIRE_OUTCOMES.EXPIRED) continue
    expired.push(row.requestId)
    audit(actor, row.scope, 'permission:ttl-expired', row.requestId, {
      action: row.action, target: row.target, reason: verdict.reason,
      deadlineMs: verdict.deadlineMs, attemptId: row[APPROVAL_ATTEMPT_COLUMN] ?? null,
      bindingHash: isBoundHash(row[BINDING_HASH_COLUMN]) ? row[BINDING_HASH_COLUMN].trim() : null,
    })
    const attemptId = row[APPROVAL_ATTEMPT_COLUMN] == null ? null : String(row[APPROVAL_ATTEMPT_COLUMN])
    if (attemptId === null || attemptId === '') {
      orphaned.push(row.requestId)
      audit(actor, row.scope, 'permission:ttl-expired-unlinked', row.requestId, {
        note: '这一行没有 attemptId（PRT-615 之前创建），无法判断该动哪一条 Attempt——不动任何 Attempt',
      })
      continue
    }
    try {
      // 系统侧不带 epoch：`failAndRetry` 在没有 epoch 时用自己的 CAS 语义。
      // 这里**不能**拿库里的 epoch 传进去——那等于"替当前持有者做决定"，
      // 而扫描本来就该能回收一条连心跳都停了的尝试。
      //
      // `store` 可注入（默认就是生产的 `runStore`）：唯一的用途是让
      // "重试额度用完 → 任务进 blocked"这条结局可以被**真的走到**——
      // 额度是 store 级的构造参数，注入不了就只能靠反复失败去耗尽它。
      // 与 `checkPermission` 的 `consume`、`createLauncher` 收依赖是同一套做法：
      // 函数不能经 JSON 传进来，HTTP 调用方无法利用。
      store.failAndRetry({
        attemptId, actor, failureCode: 'APPROVAL_TTL_EXPIRED',
        detail: `审批 ${row.requestId} 在 TTL 到期后自动拒绝（${verdict.reason}）`,
        reason: 'approval-ttl-expired',
      })
      const after = db.prepare('SELECT state FROM run_attempts WHERE id=?').get(attemptId)
      released.push({ requestId: row.requestId, attemptId, attemptState: after?.state ?? null })
    } catch (e) {
      // 联动失败**不能**吞掉：审批已经过期了，而 Attempt 还停在 AwaitingApproval，
      // 那正是本函数开头说的"任务安静地停在那里"。留一条能被查到的痕迹。
      audit(actor, row.scope, 'permission:ttl-release-failed', row.requestId, {
        attemptId, code: e?.code ?? null, message: String(e?.message ?? e),
      })
      released.push({ requestId: row.requestId, attemptId, attemptState: null, error: e?.code ?? 'ERROR' })
    }
  }
  return Object.freeze({
    nowMs: atMs, scanned: candidates.length,
    expired: Object.freeze(expired),
    released: Object.freeze(released),
    orphaned: Object.freeze(orphaned),
  })
}

/**
 * PRT-615：`AwaitingApproval` 期间的心跳续租。
 *
 * 续到审批截止时刻，**绝不超过它**（`evaluateApprovalHeartbeat` 是唯一的事实来源）。
 * 越过截止时刻后**拒绝续期**——而不是续一个很短的租约：续短租约会让 lease 先于
 * 自动拒绝到期，于是另一个 worker 领走同一条任务并**重复执行**它正在等审批的那个
 * 外部写操作，直接违背 §15。
 *
 *   > 一个「在审批到期的前一刻把任务让给别人重做」的暂停，
 *   > 与一个「把同一件已经做过一半的外部写操作再交给第二个人做一遍」的暂停，
 *   > 是同一个东西。
 */
export function heartbeatAwaitingApproval({ requestId, nowMs = Date.now(), requestedTtlMs = null } = {}) {
  const id = String(requestId ?? '').trim()
  if (!id) throw new Error('缺少 requestId')
  const row = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(id)
  if (row === null || row === undefined) throw new Error('审批请求不存在')
  const atMs = Number(nowMs)
  const beat = evaluateApprovalHeartbeat({ row, nowMs: atMs, ttlMs: APPROVAL_TTL_MS, requestedTtlMs })
  if (beat.action === 'expire') {
    audit(row.actor, row.scope, 'permission:heartbeat-refused', id, {
      action: row.action, target: row.target, reason: beat.reason, deadlineMs: beat.deadlineMs,
    })
    return Object.freeze({
      ok: false, action: 'expire', reason: beat.reason, deadlineMs: beat.deadlineMs,
      requestId: id, expiresAtMs: null,
    })
  }
  return Object.freeze({
    ok: true, action: 'renew', reason: null, deadlineMs: beat.deadlineMs,
    requestId: id, expiresAtMs: beat.expiresAtMs, boundMs: beat.boundMs,
  })
}

function touchMember(member, scope, kind, modelText) {
  db.prepare(`
    INSERT INTO members (id, scope, kind, lastSeenAt, online, model) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, kind=excluded.kind, lastSeenAt=excluded.lastSeenAt, online=1, model=excluded.model
  `).run(member, scope, kind, now(), typeof modelText === 'string' && modelText.length > 0 ? modelText : null)
}

// ── 技能（scope-owned + grant + 版本/review，借鉴 QM shared skills + RFC-032）──
// 技能内容 = 多部件 bundle：主提示(SKILL.md) + 配置(config.yaml) + 脚本 + 案例。所有字段先规范化再存储/哈希。
function skillContentHash(s) {
  return createHash('sha256').update(JSON.stringify({
    name: s.name, description: s.description ?? '', scope: s.scope ?? 'default', bundle: s.bundle,
  })).digest('hex')
}

/** 规范化部件数组（脚本/案例）：仅保留 {name, content} 且至少一项非空的对象。 */
function normalizeParts(parts) {
  if (!Array.isArray(parts)) return []
  return parts
    .map(p => (p && typeof p === 'object' ? { name: String(p.name ?? '').trim(), content: String(p.content ?? '') } : null))
    .filter(p => p && (p.name.length > 0 || p.content.length > 0))
}

/** 由提交输入构造规范化 bundle（兼容旧的 prompt 单文本提交 → 映射为 main）。 */
function normalizeBundle(input) {
  const src = input ?? {}
  return {
    main: String(src.main ?? src.prompt ?? ''),
    config: String(src.config ?? ''),
    scripts: normalizeParts(src.scripts),
    cases: normalizeParts(src.cases),
  }
}

/** 从行读取解析 bundle；bundle 为空时回退到 prompt（旧行/未迁移兜底）。 */
function parseBundle(row) {
  const raw = row.bundle && String(row.bundle).trim() ? JSON.parse(row.bundle) : null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizeBundle({ main: raw.main, config: raw.config, scripts: raw.scripts, cases: raw.cases })
  }
  return { main: row.prompt ?? '', config: '', scripts: [], cases: [] }
}

function getSkill(id) {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
  if (!row) throw new Error(`未知技能 ${id}`)
  const bundle = parseBundle(row)
  return { ...row, grants: parseJson(row.grants, []), bundle, prompt: bundle.main }
}

/**
 * 提交技能：同 (id, content) 幂等（返回已有行，不 bump version）；
 * 内容变化 → version+1 并回 pending 待复审；新技能 → pending。
 * 提交不自动发布：发布须经 reviewSkill。
 */
function registerSkill(input) {
  return withTx(() => {
    const id = input.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error('技能 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
    }
    const name = input.name
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error('技能名称为空')
    const description = input.description ?? ''
    const scope = input.scope ?? 'default'
    const bundle = normalizeBundle(input)
    const hash = skillContentHash({ name, description, scope, bundle })
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    if (existing) {
      if (existing.contentHash === hash) return getSkill(id) // 幂等：同内容重复提交不产生新版本
      db.prepare("UPDATE skills SET name=?, description=?, prompt=?, bundle=?, scope=?, version=version+1, status='pending', contentHash=?, reviewedAt=NULL, updatedAt=? WHERE id=?")
        .run(name, description, bundle.main, JSON.stringify(bundle), scope, hash, now(), id)
    } else {
      // ★ PRT-406：`origin` **写死 'member'**，不读 `input.origin`。
      //
      //   本路由是**成员**登记技能的那条路（`handleWrite` → token + `by`）。
      //   如果它接受 body 里的 `origin`，那么拿得到 token 的人只要在自己的
      //   请求里写 `origin: 'operator'`，就能把自己的技能**升格成系统指示**——
      //   而下游的可信性判定正是按这个字段做的。
      //
      //     > 一个"由提交者声明自己可信"的来源字段，
      //     > 与一个"任何人都可以自称可信"的字段，在没人恶意提交的时候
      //     > 是同一个东西——只不过前者会把**信任这件事，交给被信任的那一方去填**。
      //
      //   运维的安装路径是另一个函数（`installSkill`），它不经 HTTP。
      //   两条路径各自硬编码一个值，是"谁写的"这件事**唯一**的出处。
      db.prepare("INSERT INTO skills (id, name, description, prompt, bundle, scope, owner, origin, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', 1, 'pending', ?, ?, ?)")
        .run(id, name, description, bundle.main, JSON.stringify(bundle), scope, input.owner ?? null, hash, now(), now())
    }
    return getSkill(id)
  })
}

/**
 * ★ PRT-406：**运维安装**技能——`origin` 写死 `'operator'`，直接 `published`。
 *
 * 为什么它是**一个函数**而不是一条路由：
 * 运维安装这件事的真实边界是**文件系统**，不是 HTTP token。做成路由的话，
 * 任何拿得到 token 的成员都能调用它，于是"运维安装"这个名字就成了一句
 * 谁都能说的话——而它正是"系统内容"的唯一依据。
 *
 *   > 一个"任何 token 持有者都能说自己是在安装系统内容"的入口，
 *   > 与一个"系统内容由部署者写入"的入口，在没人滥用的时候是同一个东西——
 *   > 只不过前者会让"系统内容"这个身份，变成一句**客户端自己填的声明**。
 *
 * 所以它只被 `team-hub/scripts/install-skill.mjs`（本机 CLI）调用：
 * 走 HTTP 的登记一律 `'member'`，走本机 CLI 的一律 `'operator'`。
 *
 * 直接 `published`：运维装进来的东西**已经是他审过的**，再走一遍复审队列
 * 只会让人以为"运维的安装也需要另一个成员批准"。
 */
export function installSkill(input) {
  return withTx(() => {
    const id = input.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error('技能 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
    }
    const name = input.name
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error('技能名称为空')
    const description = input.description ?? ''
    const scope = input.scope ?? 'default'
    const bundle = normalizeBundle(input)
    const hash = skillContentHash({ name, description, scope, bundle })
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    if (existing) {
      if (existing.contentHash === hash && existing.origin === 'operator') return getSkill(id)
      db.prepare("UPDATE skills SET name=?, description=?, prompt=?, bundle=?, scope=?, origin='operator', version=version+1, status='published', contentHash=?, reviewedAt=?, updatedAt=? WHERE id=?")
        .run(name, description, bundle.main, JSON.stringify(bundle), scope, hash, now(), now(), id)
    } else {
      db.prepare("INSERT INTO skills (id, name, description, prompt, bundle, scope, owner, origin, version, status, contentHash, reviewedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'operator', 1, 'published', ?, ?, ?, ?)")
        .run(id, name, description, bundle.main, JSON.stringify(bundle), scope, 'operator', hash, now(), now(), now())
    }
    return getSkill(id)
  })
}

/** 复审技能：pending → published | rejected。只有 pending 可审。 */
function reviewSkill(id, action) {
  return withTx(() => {
    if (action !== 'publish' && action !== 'reject') throw new Error('action 必须是 publish 或 reject')
    const s = getSkill(id)
    if (s.status !== 'pending') throw new Error(`技能 ${id} 当前 ${s.status}，只有 pending 可审`)
    db.prepare('UPDATE skills SET status=?, reviewedAt=?, updatedAt=? WHERE id=?').run(action === 'publish' ? 'published' : 'rejected', now(), now(), id)
    return getSkill(id)
  })
}

/** 技能来源：读取某空间绑定的团队技能仓库（github url + 分支），无则返回空占位。 */
function getSkillSource(scope = 'default') {
  const row = db.prepare('SELECT scope, url, branch, updatedAt FROM skill_sources WHERE scope = ?').get(scope)
  return row ?? { scope, url: '', branch: '', updatedAt: null }
}

/** 技能来源：设置/更新某空间的团队技能仓库（upsert）。 */
function setSkillSource({ scope = 'default', url = '', branch = '' }) {
  const cleanUrl = String(url ?? '').trim()
  const cleanBranch = String(branch ?? '').trim()
  db.prepare('INSERT INTO skill_sources (scope, url, branch, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET url=excluded.url, branch=excluded.branch, updatedAt=excluded.updatedAt')
    .run(scope, cleanUrl, cleanBranch, now())
  return getSkillSource(scope)
}

/**
 * 列出技能。默认只返回 published（守护/士兵只该拿到已发布的）；
 * `includePending=true` 供复审者查看待审/被拒。
 */
function listSkills({ scope, member, includePending } = {}) {
  const rows = db.prepare('SELECT * FROM skills ORDER BY id').all()
  return rows.map((r) => {
    const bundle = parseBundle(r)
    return { ...r, grants: parseJson(r.grants, []), bundle, prompt: bundle.main }
  })
    .filter((s) => {
      if (includePending !== true && s.status !== 'published') return false
      if (scope === undefined && member === undefined) return true
      const inScope = scope !== undefined && s.scope === scope
      // 跨空间共享（R-1）：scope=B 查询自动包含 grants 含 scope:B 的已发布技能（服务端判定，UI 无需传 member）；
      // member 单值授权（如 'coder'）在 member 查询形态下同样可见（现状语义保持）。
      const grantedByScope = scope !== undefined && s.grants.includes(`scope:${scope}`)
      const grantedToMember = member !== undefined && s.grants.includes(member)
      return inScope || grantedByScope || grantedToMember
    })
}

/**
 * ★ PRT-406：显式文档的 DAO。
 *
 * 与 skills 的两个不同之处，都是刻意的：
 *   ① **没有状态机**。skill 走「成员登记 → 复审 → 发布」，因为它会被员工
 *      当指令执行；文档是**参考资料**，登记即生效——给它加一道复审队列
 *      只会让人以为"文档也需要批准"（而审批的真实边界是 ToolGuard 与权限，
 *      不是这张表）。
 *   ② **正文随条目返回**。文档的全部用处就是它的正文；只给元数据等于
 *      没接。正文进上下文是一个**预算**决定，所以截断发生在装配侧并记理由，
 *      而不是在这里悄悄砍掉。
 */
function listDocuments({ scope, id } = {}) {
  const rows = db.prepare('SELECT * FROM documents ORDER BY id').all()
  return rows.filter((d) => {
    if (id !== undefined && id !== null && String(id) !== '' && d.id !== String(id)) return false
    // scope 未指定 = 不限空间（与 /api/skills 的"全缺省即全部"同口径）
    if (scope === undefined || scope === null || String(scope) === '') return true
    return d.scope === String(scope)
  })
}

/** 内容哈希：正文 + 标题 + 路径。同内容重复登记幂等，改内容才 bump version。 */
function documentContentHash({ title, path, body }) {
  return createHash('sha256')
    .update(`${title}\u0000${path}\u0000${body}`, 'utf8')
    .digest('hex')
}

/**
 * 登记/更新一份显式文档。
 *
 * ★ `origin` **写死 'member'**，与 `registerSkill` 同一条纪律：不读 `input.origin`。
 *   内容哈希不含 `origin`——"谁放进去的"变了，内容没变，就不该产生新版本
 *   （否则一次运维接手会让全部文档的版本号凭空 +1，而正文一字未改）。
 */
function registerDocument(input) {
  return withTx(() => {
    const id = input.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) {
      throw new Error('文档 id 非法：小写字母/数字开头，可含 . _ -，≤128 字符')
    }
    const title = typeof input.title === 'string' ? input.title : ''
    const path = typeof input.path === 'string' ? input.path : ''
    const body = typeof input.body === 'string' ? input.body : ''
    if (title.trim() === '' && body.trim() === '') {
      throw new Error('文档必须有 title 或 body（两者都空等于登记了一份空文档）')
    }
    const scope = input.scope ?? 'default'
    const hash = documentContentHash({ title, path, body })
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    if (existing) {
      // 幂等：同内容重复登记不产生新版本、也不动 origin。
      if (existing.sha256 === hash) return getDocument(id)
      db.prepare('UPDATE documents SET title=?, path=?, body=?, scope=?, version=version+1, sha256=?, updatedAt=? WHERE id=?')
        .run(title, path, body, scope, hash, now(), id)
    } else {
      db.prepare("INSERT INTO documents (id, title, path, body, scope, origin, version, sha256, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'member', 1, ?, ?, ?)")
        .run(id, title, path, body, scope, hash, now(), now())
    }
    return getDocument(id)
  })
}

function getDocument(id) {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
  if (!row) throw new Error(`文档不存在：${id}`)
  return row
}

/** ★ PRT-406：运维安装文档——`origin` 写死 'operator'，与 `installSkill` 同边界。 */
export function installDocument(input) {
  return withTx(() => {
    const id = input.id
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) {
      throw new Error('文档 id 非法：小写字母/数字开头，可含 . _ -，≤128 字符')
    }
    const title = typeof input.title === 'string' ? input.title : ''
    const path = typeof input.path === 'string' ? input.path : ''
    const body = typeof input.body === 'string' ? input.body : ''
    if (title.trim() === '' && body.trim() === '') {
      throw new Error('文档必须有 title 或 body（两者都空等于登记了一份空文档）')
    }
    const scope = input.scope ?? 'default'
    const hash = documentContentHash({ title, path, body })
    const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    if (existing) {
      if (existing.sha256 === hash && existing.origin === 'operator') return getDocument(id)
      db.prepare("UPDATE documents SET title=?, path=?, body=?, scope=?, origin='operator', version=version+1, sha256=?, updatedAt=? WHERE id=?")
        .run(title, path, body, scope, hash, now(), id)
    } else {
      db.prepare("INSERT INTO documents (id, title, path, body, scope, origin, version, sha256, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'operator', 1, ?, ?, ?)")
        .run(id, title, path, body, scope, hash, now(), now())
    }
    return getDocument(id)
  })
}

/** 删除文档（按 id）。不存在时**不抛**：删除是幂等的（与 revokeSkill 同口径）。 */
function deleteDocument(id) {
  return withTx(() => {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    if (!row) return { deleted: false, id }
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    return { deleted: true, id }
  })
}

function grantSkill(id, grants) {
  return withTx(() => {
    const s = getSkill(id)
    const merged = [...new Set([...s.grants, ...grants.map(String)])]
    db.prepare('UPDATE skills SET grants=?, updatedAt=? WHERE id=?').run(JSON.stringify(merged), now(), id)
    return getSkill(id)
  })
}

/** 撤销跨空间授权（R-1 AC-R1-2）：从 grants 过滤删除目标并写回；撤销未授权目标/重复撤销幂等不抛错。 */
function revokeSkill(id, targets) {
  return withTx(() => {
    const s = getSkill(id)
    const tset = new Set(targets.map(String))
    const remaining = s.grants.filter(g => !tset.has(g))
    if (remaining.length !== s.grants.length) {
      db.prepare('UPDATE skills SET grants=?, updatedAt=? WHERE id=?').run(JSON.stringify(remaining), now(), id)
    }
    return getSkill(id)
  })
}

// ── 对话中心（chat）DAO：会话 / 消息（scope 分区 + 统一写纪律）──
// 写纪律（I3）：createConversation / postMessage 内部一律走 audit()（by 必填 + SSE 广播），
// 与 tasks 的「路由层 audit」不同——chat 的 DAO 即写入口（含未来 AI 直写场景），把审计放进 DAO
// 保证任何调用路径都留痕；author 恒等于 by（服务端绑定，防冒名，TC-S1-07）。
export const CHAT_CONV_KINDS = ['space', 'direct', 'task']
// 对话 AI 回复（R-4，S9）：超龄兜底时间窗（⚖️ env 可配，默认 120s，三值法断言）
export const CHAT_REPLY_TIMEOUT_MS = Number(process.env.CHAT_REPLY_TIMEOUT_MS || 120000)
// 供给回复方的同会话上下文条数（S9 队列聚合）
export const CHAT_REPLY_CONTEXT_LIMIT = 12
// ── 对话附件护栏（S3/R-4 决策 G1，承接 REQUIREMENTS D-6 默认值；env 可覆写，CHAT_REPLY_TIMEOUT_MS 先例）──
export const CHAT_ATTACH_MAX_BYTES = Number(process.env.CHAT_ATTACH_MAX_BYTES || 10 * 1024 * 1024) // 单附件大小上限（默认 10MB）
export const CHAT_ATTACH_MAX_PER_MSG = Number(process.env.CHAT_ATTACH_MAX_PER_MSG || 3) // 每消息附件数量上限
export const CHAT_ATTACH_BLACKLIST_EXT = (process.env.CHAT_ATTACH_BLACKLIST_EXT || 'exe,dll,bin,zip,rar,7z,tar,gz,png,jpg,jpeg,gif,webp,svg,ico,pdf,doc,docx,xls,xlsx')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean) // 扩展名黑名单（可配置；白名单 = 非黑名单 + UTF-8 校验通过）
export const CHAT_ATTACH_STAGED_TTL_MS = Number(process.env.CHAT_ATTACH_STAGED_TTL_MS || 24 * 3600 * 1000) // staged 孤儿清理（默认 24h）
export const CHAT_ATTACH_TTL_MS = Number(process.env.CHAT_ATTACH_TTL_MS || 7 * 24 * 3600 * 1000) // sent 过期清理（默认 7 天，生命周期文档化 D-3）
export const CHAT_MSG_KINDS = ['text', 'markdown', 'system']
export const MAX_CHAT_BODY = 8000 // 消息正文长度上限（⚖️ 三值法断言的常量，见 TEST_CASES §3）

function convToObj(row) {
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    kind: row.kind,
    participants: parseJson(row.participants, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    last_message_at: row.last_message_at,
  }
}

function msgToObj(row) {
  return {
    id: row.id,
    convId: row.conv_id,
    scope: row.scope,
    author: row.author,
    kind: row.kind,
    body: row.body,
    meta: parseJson(row.meta, {}),
    clientTs: row.client_ts,
    createdAt: row.createdAt,
  }
}

function getConversation(id) {
  const num = Number(id)
  const row = Number.isInteger(num) && num > 0 ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(num) : undefined
  if (!row) throw new Error(`会话不存在：${id}`)
  return convToObj(row)
}

/** 创建会话（scope 归一 + by 必填 + 审计）；kind ∈ {space,direct,task}。 */
export function createConversation(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = readScope(input ?? {})
  const title = input?.title
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
  const kind = input?.kind ?? 'space'
  if (!CHAT_CONV_KINDS.includes(kind)) throw new Error(`kind 必须 ∈ {${CHAT_CONV_KINDS.join(',')}}，实际收到：${kind}`)
  const participants = Array.isArray(input?.participants)
    ? [...new Set(input.participants.map(p => typeof p === 'string' ? p.trim() : '').filter(p => p.length > 0))].slice(0, 128)
    : []
  if (title.trim().length > 200) throw new Error('会话标题过长（≤200 字符）')
  return withTx(() => {
    const t = now()
    const r = db.prepare("INSERT INTO conversations (scope, title, kind, participants, createdAt, updatedAt, last_message_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(scope, title.trim(), kind, JSON.stringify(participants), t, t)
    const conv = getConversation(r.lastInsertRowid)
    audit(by, conv.scope, 'chat:create', null, { conv: conv.id, title: conv.title, kind: conv.kind })
    return conv
  })
}

/** 会话列表：scope 过滤（TC-S1-01/02）；按 updatedAt desc、id desc（新建/活跃优先）。 */
export function listConversations({ scope } = {}) {
  const where = typeof scope === 'string' && scope.trim().length > 0 ? 'WHERE scope = ?' : ''
  const params = typeof scope === 'string' && scope.trim().length > 0 ? [scope.trim()] : []
  const rows = db.prepare(`SELECT * FROM conversations ${where} ORDER BY updatedAt DESC, id DESC`).all(...params)
  return rows.map(convToObj)
}

/** 发消息（统一写纪律：by 必填 + author=by 防冒名 + 审计/SSE；消息 scope 恒等于会话 scope，跨 scope 写不串）。 */
export function postMessage(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const convId = Number(input?.conv)
  if (!Number.isInteger(convId) || convId <= 0) throw new Error('缺少参数 conv')
  const conv = getConversation(convId)
  const kind = input?.kind ?? 'text'
  if (!CHAT_MSG_KINDS.includes(kind)) throw new Error(`kind 必须 ∈ {${CHAT_MSG_KINDS.join(',')}}，实际收到：${kind}`)
  const body = input?.body
  if (typeof body !== 'string') throw new Error('缺少参数 body')
  if (body.trim().length === 0) throw new Error('消息正文不能为空')
  if (body.length > MAX_CHAT_BODY) throw new Error(`消息正文超长（上限 ${MAX_CHAT_BODY} 字符）`)
  const clientTs = typeof input?.clientTs === 'string' && input.clientTs.length > 0 ? input.clientTs.slice(0, 64) : null
  return withTx(() => {
    const t = now()
    // R-4/S9：回复开关开 + 发送者非本空间回复方身份 → meta.aiStatus=awaiting（同事务写入，零迁移 meta 扩展）。
    // 回复方身份消息（by === <scope>-assistant）不标 awaiting，防自我触发死循环（TC-S9-05/AC-R4-2/I-12）。
    const replySettings = getReplySettings(conv.scope)
    const identity = replyIdentityFor(conv.scope)
    // S3/R-3（决策 E1）：附件引用校验（存在/同 scope/未绑定/数量上限）先于消息插入执行；
    // 校验失败抛错 → 事务回滚，消息与绑定零落库（AC-R3-3 / TC-S3-05/10）。
    const attRefs = validateAttachmentRefs(conv.scope, input?.attachmentIds)
    const meta0 = (typeof input?.meta === 'object' && input.meta) ? { ...input.meta } : {}
    if (attRefs.length > 0) meta0.attachments = attRefs // 只存 [{id,fileName,size}] 引用；内容不入 body/meta（AC-R4-3）
    if (replySettings.enabled && by.trim() !== identity && meta0.aiStatus !== 'failed' && meta0.aiStatus !== 'replied') {
      meta0.aiStatus = 'awaiting'
      meta0.aiStatusAt = t
    }
    const r = db.prepare('INSERT INTO messages (conv_id, scope, author, kind, body, meta, client_ts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(convId, conv.scope, by.trim(), kind, body, JSON.stringify(meta0), clientTs, t)
    const msgId = Number(r.lastInsertRowid)
    if (attRefs.length > 0) applyAttachmentBind(conv.scope, convId, msgId, attRefs, by.trim())
    db.prepare('UPDATE conversations SET last_message_at = ?, updatedAt = ? WHERE id = ?').run(t, t, convId)
    const msg = msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId))
    audit(by, conv.scope, 'chat:message', null, { conv: convId, msg: msg.id, kind: msg.kind })
    return msg
  })
}

/**
 * 消息分页（TC-S1-08/09）：返回按 id 升序；limit 默认 50；before = 上一页最旧消息 id，
 * 取 id < before 的最新 limit 条再倒转 → 从新到旧翻页、页内升序、无重无漏。
 */
export function listMessages({ conv, limit = 50, before } = {}) {
  const convId = Number(conv)
  if (!Number.isInteger(convId) || convId <= 0) throw new Error('缺少参数 conv')
  getConversation(convId) // 不存在 → 抛错（400）
  const lim = Number(limit)
  if (!Number.isInteger(lim) || lim <= 0) throw new Error('limit 必须是正整数')
  const LIMIT_CAP = 200
  const n = Math.min(lim, LIMIT_CAP)
  const beforeNum = before === undefined || before === null ? null : Number(before)
  if (beforeNum !== null && (!Number.isInteger(beforeNum) || beforeNum <= 0)) throw new Error('before 必须是消息 id 或省略')
  const conds = ['conv_id = ?']
  const params = [convId]
  if (beforeNum !== null) { conds.push('id < ?'); params.push(beforeNum) }
  const rows = db.prepare(`SELECT * FROM messages WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, n)
  rows.reverse()
  return rows.map(msgToObj)
}

// ── 对话 AI 回复（R-4，S9）：回复设置 / awaiting 队列 / CAS 回写 / 超龄兜底 ──
/** 每空间回复设置（未设置 → 合理默认：enabled=true，D-13）。 */
export function getReplySettings(scope) {
  const sc = (typeof scope === 'string' && scope.trim().length > 0) ? scope.trim() : 'default'
  const row = db.prepare('SELECT * FROM chat_reply_settings WHERE scope = ?').get(sc)
  if (!row) return { scope: sc, enabled: true, model: null, identity: null, systemHint: null, updatedAt: null }
  return {
    scope: row.scope,
    enabled: row.enabled === 1,
    model: row.model ?? null,
    identity: row.identity ?? null,
    systemHint: row.systemHint ?? null,
    updatedAt: row.updatedAt ?? null,
  }
}

/** 回复方身份（D-15/G-R4-2 默认）：<scope>-assistant；可被 settings.identity 覆盖。 */
export function replyIdentityFor(scope) {
  const sc = (typeof scope === 'string' && scope.trim().length > 0) ? scope.trim() : 'default'
  const row = db.prepare('SELECT identity FROM chat_reply_settings WHERE scope = ?').get(sc)
  if (row && typeof row.identity === 'string' && row.identity.trim().length > 0) return row.identity.trim()
  return `${sc}-assistant`
}

/** 保存回复设置（写纪律：by 必填 + audit chat:reply-settings + SSE；per-scope 隔离持久化）。 */
export function saveReplySettings(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope.trim())) throw new Error('scope 非法：小写字母/数字开头，可含连字符，≤64 字符')
  const sc = scope.trim()
  const enabled = input?.enabled !== false
  const model = typeof input?.model === 'string' && input.model.trim().length > 0 ? input.model.trim().slice(0, 200) : null
  const identity = typeof input?.identity === 'string' && input.identity.trim().length > 0 ? input.identity.trim().slice(0, 200) : null
  const systemHint = typeof input?.systemHint === 'string' && input.systemHint.trim().length > 0 ? input.systemHint.trim().slice(0, 2000) : null
  return withTx(() => {
    const t = now()
    db.prepare('INSERT INTO chat_reply_settings (scope, enabled, model, identity, systemHint, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, model=excluded.model, identity=excluded.identity, systemHint=excluded.systemHint, updatedAt=excluded.updatedAt')
      .run(sc, enabled ? 1 : 0, model, identity, systemHint, t)
    audit(by, sc, 'chat:reply-settings', null, { scope: sc, enabled, model, identity })
    return getReplySettings(sc)
  })
}

/** 把超龄（> CHAT_REPLY_TIMEOUT_MS，按 aiStatusAt 或 createdAt 起算）的 awaiting 消息兜底标记 failed（AC-R4-4 后端兜底）。 */
function markStaleAwaiting(scope, nowMs = Date.now()) {
  const cutoff = nowMs - CHAT_REPLY_TIMEOUT_MS
  const rows = db.prepare('SELECT id, meta, createdAt FROM messages WHERE scope = ? ORDER BY id DESC LIMIT 500').all(scope)
  for (const row of rows) {
    const meta = parseJson(row.meta, {})
    if (meta.aiStatus !== 'awaiting') continue
    const at = meta.aiStatusAt ? new Date(meta.aiStatusAt).getTime() : new Date(row.createdAt).getTime()
    if (at < cutoff) {
      meta.aiStatus = 'failed'
      meta.aiError = `回复超时（${CHAT_REPLY_TIMEOUT_MS}ms 内未收到回复方应答）`
      db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id)
    }
  }
}

/**
 * awaiting 回复队列：返回 scope 下 aiStatus=awaiting 的消息（id > sinceMsgId），
 * 每条带同会话最近 CHAT_REPLY_CONTEXT_LIMIT 条消息作为应答上下文；读取前先执行超龄兜底。
 */
export function listAwaitingReplies({ scope, sinceMsgId = 0, limit = 20 } = {}) {
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope')
  const sc = scope.trim()
  const since = Number(sinceMsgId)
  if (!Number.isInteger(since) || since < 0) throw new Error('sinceMsgId 必须是 ≥0 的整数')
  const lim = Number(limit)
  if (!Number.isInteger(lim) || lim <= 0) throw new Error('limit 必须是正整数')
  const n = Math.min(lim, 200)
  markStaleAwaiting(sc)
  const rows = db.prepare('SELECT * FROM messages WHERE scope = ? AND id > ? ORDER BY id ASC LIMIT ?').all(sc, since, Math.min(n * 4, 800))
  const out = []
  for (const row of rows) {
    const meta = parseJson(row.meta, {})
    if (meta.aiStatus !== 'awaiting') continue
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(row.conv_id)
    const ctxRows = db.prepare('SELECT id, author, kind, body, createdAt FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(row.conv_id, row.id, CHAT_REPLY_CONTEXT_LIMIT)
    ctxRows.reverse()
    out.push({
      ...msgToObj(row),
      convId: row.conv_id,
      convTitle: conv?.title ?? '',
      context: ctxRows.map(c => ({ id: c.id, author: c.author, kind: c.kind, body: c.body, createdAt: c.createdAt })),
    })
    if (out.length >= n) break
  }
  return out
}

/**
 * CAS 回写（I-12）：回复方应答一条 awaiting 消息——同事务内插入回复消息（author=by，审计 chat:message + SSE）
 * 并把源消息 meta.aiStatus awaiting→replied（meta.replyMsg=回复 id）。重复/并发回写幂等：
 * 源已非 awaiting 时返回 { skipped:true }，不产生第二条回复、不抛未定义错误（TC-S9-11）。
 */
export function postAiReply(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const msgId = Number(input?.msgId)
  if (!Number.isInteger(msgId) || msgId <= 0) throw new Error('缺少参数 msgId')
  const sourceRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)
  if (!sourceRow) throw new Error(`消息不存在：${msgId}`)
  const kind = input?.kind ?? 'text'
  if (!CHAT_MSG_KINDS.includes(kind)) throw new Error(`kind 必须 ∈ {${CHAT_MSG_KINDS.join(',')}}，实际收到：${kind}`)
  const body = input?.body
  if (typeof body !== 'string') throw new Error('缺少参数 body')
  if (body.trim().length === 0) throw new Error('回复正文不能为空')
  if (body.length > MAX_CHAT_BODY) throw new Error(`消息正文超长（上限 ${MAX_CHAT_BODY} 字符）`)
  const model = typeof input?.model === 'string' && input.model.trim().length > 0 ? input.model.trim().slice(0, 200) : null
  return withTx(() => {
    const s2 = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)
    const meta2 = parseJson(s2?.meta, {})
    if (!s2 || meta2.aiStatus !== 'awaiting') {
      return { skipped: true, reason: meta2?.aiStatus ?? 'none', source: s2 ? msgToObj(s2) : null }
    }
    const conv = getConversation(s2.conv_id)
    const t = now()
    const r = db.prepare('INSERT INTO messages (conv_id, scope, author, kind, body, meta, client_ts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s2.conv_id, conv.scope, by.trim(), kind, body, JSON.stringify({ replyTo: msgId, aiModel: model }), null, t)
    db.prepare('UPDATE conversations SET last_message_at = ?, updatedAt = ? WHERE id = ?').run(t, t, s2.conv_id)
    meta2.aiStatus = 'replied'
    meta2.repliedAt = t
    meta2.replyMsg = r.lastInsertRowid
    delete meta2.aiError
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta2), msgId)
    audit(by.trim(), conv.scope, 'chat:message', null, { conv: s2.conv_id, msg: r.lastInsertRowid, replyTo: msgId, ai: true, model })
    const reply = msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid))
    return { skipped: false, source: msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)), reply }
  })
}

/** 重试（UI 失败重试）：把 failed 的 awaiting 源消息重置回 awaiting（仅开关开时；已 replied 拒绝）。 */
export function retryAiReply(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const msgId = Number(input?.msgId)
  if (!Number.isInteger(msgId) || msgId <= 0) throw new Error('缺少参数 msgId')
  return withTx(() => {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)
    if (!row) throw new Error(`消息不存在：${msgId}`)
    const meta = parseJson(row.meta, {})
    if (meta.aiStatus === 'replied') throw new Error('该消息已收到回复，无需重试')
    const settings = getReplySettings(row.scope)
    if (!settings.enabled) throw new Error('该空间已关闭 AI 回复，无法重试')
    meta.aiStatus = 'awaiting'
    meta.aiStatusAt = now()
    delete meta.aiError
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), msgId)
    audit(by.trim(), row.scope, 'chat:retry', null, { msg: msgId })
    return msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId))
  })
}

/**
 * 显式失败回写（S10 守护 chat-responder 用，TC-S10-02）：CAS awaiting→failed + meta.error（≤500 字）。
 * 幂等：源已非 awaiting（replied/failed）→ 返回 { skipped:true }，不覆盖 replied 终态、不抛未定义错误。
 */
export function failAiReply(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const msgId = Number(input?.msgId)
  if (!Number.isInteger(msgId) || msgId <= 0) throw new Error('缺少参数 msgId')
  const error = typeof input?.error === 'string' && input.error.trim().length > 0 ? input.error.trim().slice(0, 500) : null
  if (error === null) throw new Error('缺少参数 error（失败原因）')
  return withTx(() => {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)
    if (!row) throw new Error(`消息不存在：${msgId}`)
    const meta = parseJson(row.meta, {})
    if (meta.aiStatus !== 'awaiting') return { skipped: true, reason: meta.aiStatus ?? 'none', source: msgToObj(row) }
    meta.aiStatus = 'failed'
    meta.aiError = error
    meta.failedAt = now()
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), msgId)
    audit(by.trim(), row.scope, 'chat:fail', null, { msg: msgId })
    return { skipped: false, source: msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId)) }
  })
}

// ── 对话附件（S3/R-3 决策 E1）：上传 / 绑定 / 取回 / 清理 DAO（服务端护栏 G1；内容不入 messages 表）──
/** 扩展名黑名单命中 → 拒绝（可读文案；AC-R3-3 / AC-R4-2）。 */
function rejectBlacklistedExt(fileName) {
  const dot = fileName.lastIndexOf('.')
  const ext = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  if (CHAT_ATTACH_BLACKLIST_EXT.includes(ext)) {
    throw new Error(`扩展名类型不支持作为上下文：.${ext}（仅文本类 UTF-8 文件可作回复上下文）`)
  }
}

/** UTF-8 fatal 校验（伪装文本的二进制/非 UTF-8 → 拒绝；AC-R3-3 / AC-R4-2）。 */
function requireUtf8Text(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    throw new Error('无法作为上下文（非 UTF-8 文本）：仅支持 UTF-8 文本类文件')
  }
}

/** 上传：raw UTF-8 文本 → staged 行 + uploads/<scope>/<sha1> 落盘（sha1 命名天然去重）。返回引用形状。 */
export function uploadChatAttachment(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = readScope(input ?? {})
  const fileNameRaw = input?.fileName
  const buf = input?.content
  if (typeof fileNameRaw !== 'string' || fileNameRaw.trim().length === 0) throw new Error('缺少参数 fileName')
  if (fileNameRaw.length > 255) throw new Error('fileName 过长（≤255 字符）')
  if (/[\\/\u0000-\u001f]/.test(fileNameRaw)) throw new Error('fileName 非法：不能含路径分隔符/控制符')
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('缺少上传内容（body 为空）')
  if (buf.length > CHAT_ATTACH_MAX_BYTES) throw new Error(`附件超大小（上限 ${CHAT_ATTACH_MAX_BYTES} 字节）`)
  if (!CHAT_SCOPE_RE.test(scope)) throw new Error('scope 非法：小写字母/数字开头的空间 id（≤64 字符）')
  rejectBlacklistedExt(fileNameRaw.trim())
  requireUtf8Text(buf)
  const sha1 = createHash('sha1').update(buf).digest('hex')
  const relPath = scope + '/' + sha1
  const absPath = join(UPLOADS_ROOT, relPath)
  mkdirSync(dirname(absPath), { recursive: true })
  if (!existsSync(absPath)) {
    const tmp = absPath + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, buf)
    renameSync(tmp, absPath)
  }
  const t = now()
  const r = db.prepare('INSERT INTO chat_attachments (scope, file_name, size, kind, sha1, path, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(scope, fileNameRaw.trim(), buf.length, 'text', sha1, relPath, 'staged', t)
  const id = Number(r.lastInsertRowid)
  audit(by.trim(), scope, 'chat:attachment:upload', null, { id, fileName: fileNameRaw.trim(), size: buf.length, scope })
  return { id, fileName: fileNameRaw.trim(), size: buf.length, kind: 'text', status: 'staged', scope }
}

/**
 * 预校验（postMessage 事务内调用，只读）：校验附件引用（存在 + 同 scope + staged 未绑定 + 数量 ≤ CHAT_ATTACH_MAX_PER_MSG），
 * 返回 [{id,fileName,size}] 引用；悬空/跨 scope/重复绑定 → 抛错（消息事务回滚，AC-R3-3 / TC-S3-05/10）。
 */
function validateAttachmentRefs(scope, attachmentIds) {
  const ids = Array.isArray(attachmentIds) ? attachmentIds : []
  if (ids.length > CHAT_ATTACH_MAX_PER_MSG) throw new Error(`附件数量超限（每消息至多 ${CHAT_ATTACH_MAX_PER_MSG} 个）`)
  const refs = []
  for (const raw of ids) {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new Error('attachmentIds 必须是正整数 id 数组')
    const row = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(id)
    if (!row) throw new Error(`附件不存在：${id}（悬空引用拒绝）`)
    if (row.scope !== scope) throw new Error(`附件 ${id} 不属于该空间（跨空间引用拒绝）`)
    if (row.status !== 'staged') throw new Error(`附件 ${id} 已被绑定，不能重复使用`)
    refs.push({ id, fileName: row.file_name, size: row.size })
  }
  return refs
}

/** 绑定落库（postMessage 事务内、消息插入后调用）：行状态 → sent + conv/msg 关联 + chat:attachment:bind 审计。 */
function applyAttachmentBind(scope, convId, msgId, refs, by) {
  for (const ref of refs) {
    db.prepare('UPDATE chat_attachments SET status = ?, conv_id = ?, msg_id = ? WHERE id = ?').run('sent', convId, msgId, ref.id)
    audit(by, scope, 'chat:attachment:bind', null, { id: ref.id, fileName: ref.fileName, size: ref.size, scope, conv: convId, msg: msgId })
  }
}

/**
 * 取回（守护答问用）：按会话归属校验后返回 UTF-8 文本内容。
 * 仅当附件已绑定到该会话（status=sent + conv_id 匹配）且 scope 一致才可读；跨会话/跨 scope → 403 语义（AC-R3-5 / TC-S3-08/09）。
 */
export function readChatAttachmentContent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('缺少参数 id（附件 id 正整数）')
  const conv = Number(input?.conv)
  if (!Number.isInteger(conv) || conv <= 0) throw new Error('缺少参数 conv（附件所属会话 id）')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope')
  const row = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(id)
  if (!row) throw new Error(`附件不存在：${id}`)
  if (row.scope !== scope.trim() || row.status !== 'sent' || row.conv_id !== conv) {
    throw new Error('附件不属于该会话（跨会话/跨空间不可读取）')
  }
  const absPath = join(UPLOADS_ROOT, String(row.path))
  // 路径自生成（scope/sha1）防逃逸复检：realpath 必须在 UPLOADS_ROOT 内
  try {
    const realAbs = toPosix(realpathSync(absPath))
    const realRoot = toPosix(realpathSync(UPLOADS_ROOT))
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + '/')) throw new Error('附件路径异常（拒绝读取）')
  } catch (e) {
    if (e instanceof Error && e.message.includes('附件路径异常')) throw e
    throw new Error(`附件文件不存在：${row.file_name}`)
  }
  const content = readFileSync(absPath, 'utf8')
  audit(by.trim(), scope.trim(), 'chat:attachment:read', null, { id, fileName: row.file_name, size: row.size, scope: scope.trim(), conv })
  return { id, fileName: row.file_name, size: row.size, content }
}

/** 清理：staged 孤儿（超 STAGED_TTL）与 sent 过期（超 TTL）行 + 落盘文件；返回删除数。供测试直调与 hub 周期任务调用。 */
export function cleanupChatAttachments({ scope, nowMs = Date.now() } = {}) {
  const cutoffStaged = new Date(nowMs - CHAT_ATTACH_STAGED_TTL_MS).toISOString()
  const cutoffSent = new Date(nowMs - CHAT_ATTACH_TTL_MS).toISOString()
  const conds = []
  const params = []
  if (typeof scope === 'string' && scope.trim().length > 0) { conds.push('scope = ?'); params.push(scope.trim()) }
  const rows = db.prepare(`SELECT * FROM chat_attachments WHERE ${conds.length > 0 ? conds.join(' AND ') + ' AND ' : ''} ((status = 'staged' AND createdAt < ?) OR (status = 'sent' AND createdAt < ?))`).all(...params, cutoffStaged, cutoffSent)
  let removed = 0
  for (const row of rows) {
    const absPath = join(UPLOADS_ROOT, String(row.path))
    try {
      if (existsSync(absPath)) { rmSync(absPath, { force: true }); removed += 1 }
    } catch { /* 文件缺失不阻塞行删除 */ }
    db.prepare('DELETE FROM chat_attachments WHERE id = ?').run(row.id)
  }
  if (rows.length > 0) {
    audit('system', (typeof scope === 'string' && scope.trim()) || 'default', 'chat:attachment:cleanup', null,
      { removed: rows.length, staged: rows.filter(r => r.status === 'staged').length, sent: rows.filter(r => r.status === 'sent').length, filesRemoved: removed })
  }
  return { removed: rows.length, filesRemoved: removed }
}

// ── 对话健康（S2/R-1 决策 B1）：GET /api/chat/health 聚合（只读零写入）──
// 聚合四输入：①守护在线（members lastSeenAt 60s 窗，优先 kind=worker；与 GET /api/members 判定口径一致）
// ②本空间回复开关 enabled（getReplySettings）③模型解析链（settings.model → agent_models role=assistant → 守护心跳上报的当前模型）
// ④最近一条 failed 消息的 aiError（供 UI 展示「如何恢复」）。
// 诚实标注：模型「已解析」不代表 provider 实际可用（实际可用性以最近一次回复/失败原因为准，防假绿 RK-6）。
export const CHAT_DAEMON_ONLINE_MS = 60000 // 成员心跳在线窗（与 GET /api/members 的 60s 判定一致）
export const CHAT_SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function chatHealth(rawScope) {
  const scope = typeof rawScope === 'string' ? rawScope.trim() : ''
  if (scope.length === 0) throw new Error('缺少参数 scope')
  if (!CHAT_SCOPE_RE.test(scope)) throw new Error('scope 非法：小写字母/数字开头的空间 id（≤64 字符）')
  const nowMs = Date.now()
  const fresh = (row) => Boolean(row && row.lastSeenAt && (nowMs - new Date(row.lastSeenAt).getTime() < CHAT_DAEMON_ONLINE_MS))
  const workerRow = db.prepare("SELECT * FROM members WHERE scope = ? AND kind = 'worker' ORDER BY lastSeenAt DESC LIMIT 1").get(scope)
  const anyFreshRow = db.prepare('SELECT * FROM members WHERE scope = ? ORDER BY lastSeenAt DESC LIMIT 1').get(scope)
  // 守护在线：kind=worker 心跳新鲜；尚无 worker 心跳历史时按「任意成员新鲜」兜底（兼容旧部署成员 kind 未标 worker）。
  const online = fresh(workerRow) || (!workerRow && fresh(anyFreshRow))
  // 守护当前选用模型（心跳上报，members.model JSON）
  let daemonModel = null
  try {
    const m = workerRow?.model ? JSON.parse(workerRow.model) : null
    if (m && (m.model || m.provider)) daemonModel = { provider: m.provider ?? null, model: m.model ?? null }
  } catch { /* 坏 JSON 按无 */ }
  const settings = getReplySettings(scope)
  const amRow = db.prepare("SELECT scope, role, provider, model FROM agent_models WHERE scope = ? AND role = ?").get(scope, 'assistant')
  let model = null
  if (settings.model && settings.model.trim().length > 0) model = { provider: null, model: settings.model.trim(), source: 'reply-settings' }
  else if (amRow?.model) model = { provider: amRow.provider ?? null, model: amRow.model, source: 'agent_models' }
  else if (daemonModel?.model) model = { ...daemonModel, source: 'daemon-heartbeat' }
  const terminal = db.prepare("SELECT id, conv_id, meta, createdAt FROM messages WHERE scope = ? ORDER BY id DESC LIMIT 200").all(scope)
  let lastFail = null
  for (const row of terminal) {
    const meta = parseJson(row.meta, {})
    if (meta.aiStatus === 'failed') {
      lastFail = { msgId: row.id, convId: row.conv_id, aiError: meta.aiError ?? '', failedAt: meta.failedAt ?? null }
      break
    }
    if (meta.aiStatus === 'replied') break
  }
  return {
    scope,
    okAt: new Date().toISOString(),
    online,
    daemon: online ? { member: (workerRow ?? anyFreshRow)?.id ?? null, kind: (workerRow ?? anyFreshRow)?.kind ?? null, lastSeenAt: (workerRow ?? anyFreshRow)?.lastSeenAt ?? null } : null,
    enabled: settings.enabled,
    model,
    modelResolved: model !== null && typeof model.model === 'string' && model.model.length > 0,
    lastFail,
    honestNote: '模型「已解析」不代表 provider 实际可用：实际可用性以最近一次 AI 回复/失败原因为准。',
  }
}

// ── 日程日历（calendar）DAO：事件 CRUD + 日期窗 + 重复展开 + 冲突检测 + 任务/目标关联（R-B1 数据面，S5/P2-5）──
// 写纪律（同 chat I-3）：create/update/deleteCalendarEvent 内部一律 audit()（by 必填 + SSE 广播），
// 机制复用 audit() 与 /api/events 单一事件流（I-8）；author/member 恒等于 by（防冒名）。
//
// P2-5 语义决策（用户拍板，见 docs/REMAINING-TASKS.md P2-5）：
//   ① **时间语义 = 字面本地时间（naive local）**：start/end 原样存储、原样返回、不做时区换算
//      （既不转 UTC 也不套浏览器时区）；跨时区参与者需自行换算。理由：本地优先单机部署、
//      全天 date-only 事件语义天然正确、零迁移、无 DST 陷阱。
//   ② **重复 = 简单规则**（daily/weekly/monthly + interval + until/count + 例外日），
//      规则存列、**查询侧展开**成实例（不落多行），单次例外用 exdates 排除；删除支持「仅本次」与「整串」。
//   ③ **关联 = 双向**：事件可带 taskId/goalId（入库列），并提供反向查询端点供任务详情展示关联日程。
export const MAX_CALENDAR_TITLE = 100 // 事件标题长度上限（⚖️ 三值法断言的常量，见 TEST_CASES §3）
export const MAX_CALENDAR_INSTANCES = 400 // 单条重复规则在查询窗内的展开上限（防失控放大）

// 时间入参解析：接受 YYYY-MM-DD（date-only，全天事件）或 YYYY-MM-DDTHH:mm[:ss][Z]；
// 逐分量范围校验 + Date.UTC 回环校验（拒 2026-13-99 / 2026-02-30 / garbage 等）；
// 返回 { raw（规范化原样存储）, date（YYYY-MM-DD 日期前缀，窗过滤用）, key（UTC 毫秒，end>=start 排序比较用）}。
// ⚠️ 字面语义：这里用 Date.UTC 仅作**单调比较/运算**，不表示该值被解释为 UTC 时刻；
//    存储与返回一律用 raw 原样字符串（naive local），故 'Z' 后缀被接受但不去做时区换算。
export function parseCalendarTime(raw, label = '时间') {
  if (raw === undefined || raw === null) throw new Error(`缺少参数 ${label}`)
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error(`${label} 必须是合法时间字符串`)
  const v = raw.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/.exec(v)
  if (!m) throw new Error(`${label} 非法（须为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm[:ss]，实际：${v.slice(0, 40)}）`)
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const hh = m[4] === undefined ? 0 : Number(m[4])
  const mi = m[5] === undefined ? 0 : Number(m[5])
  const ss = m[6] === undefined ? 0 : Number(m[6])
  if (mo < 1 || mo > 12) throw new Error(`${label} 非法：月份 ${mo} 超出 1-12`)
  if (d < 1 || d > 31) throw new Error(`${label} 非法：日期 ${d} 超出 1-31`)
  if (hh > 23) throw new Error(`${label} 非法：小时 ${hh} 超出 0-23`)
  if (mi > 59) throw new Error(`${label} 非法：分钟 ${mi} 超出 0-59`)
  if (ss > 59) throw new Error(`${label} 非法：秒 ${ss} 超出 0-59`)
  const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`${label} 非法：日期不存在（${m[1]}-${m[2]}-${m[3]}）`)
  return { raw: v, date: `${m[1]}-${m[2]}-${m[3]}`, key: dt.getTime() }
}

// ── 重复规则（P2-5）：{ freq: 'daily'|'weekly'|'monthly', interval ≥1, until?: 'YYYY-MM-DD', count?: N, exdates?: ['YYYY-MM-DD'] } ──
/** 规则校验与规范化（null/undefined → null = 单次事件）。 */
export function parseRecurrence(raw, label = 'recurrence') {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 必须是对象`)
  const freq = raw.freq
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') throw new Error(`${label}.freq 必须是 daily/weekly/monthly`)
  const intervalRaw = raw.interval === undefined || raw.interval === null ? 1 : Number(raw.interval)
  if (!Number.isInteger(intervalRaw) || intervalRaw < 1 || intervalRaw > 99) throw new Error(`${label}.interval 必须是 1-99 的整数`)
  const out = { freq, interval: intervalRaw }
  if (raw.until !== undefined && raw.until !== null && String(raw.until).trim() !== '') {
    out.until = parseCalendarTime(String(raw.until), `${label}.until`).date
  }
  if (raw.count !== undefined && raw.count !== null && String(raw.count).trim() !== '') {
    const c = Number(raw.count)
    if (!Number.isInteger(c) || c < 1 || c > MAX_CALENDAR_INSTANCES) throw new Error(`${label}.count 必须是 1-${MAX_CALENDAR_INSTANCES} 的整数`)
    out.count = c
  }
  if (out.until && out.count) throw new Error(`${label}：until 与 count 不可同时指定（结束条件二选一）`)
  if (raw.exdates !== undefined && raw.exdates !== null) {
    if (!Array.isArray(raw.exdates)) throw new Error(`${label}.exdates 必须是日期数组`)
    const dates = [...new Set(raw.exdates.map((d) => parseCalendarTime(String(d), `${label}.exdates`).date))]
    if (dates.length > MAX_CALENDAR_INSTANCES) throw new Error(`${label}.exdates 过多（上限 ${MAX_CALENDAR_INSTANCES}）`)
    if (dates.length > 0) out.exdates = dates.sort()
  }
  return out
}

/** 日期算术（纯字符串/Y-M-D 分量，避免时区参与）。 */
function ymdParts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) throw new Error(`非法日期：${dateStr}`)
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
}
function ymdOf(dt) {
  const p = (n) => String(n).padStart(2, '0')
  return String(dt.getUTCFullYear()) + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate())
}
/** 在 date-only 的 UTC 网格上加减天数（纯日期运算，无时区语义）。 */
function addDays(dateStr, n) {
  const { y, mo, d } = ymdParts(dateStr)
  return ymdOf(new Date(Date.UTC(y, mo - 1, d + n)))
}
/** 月份推进：钳制日（1/31 每月 → 2/28、4/30），不产生"跳过整月"。 */
function addMonthsClamped(dateStr, n) {
  const { y, mo, d } = ymdParts(dateStr)
  const total = (y * 12 + (mo - 1)) + n
  const ty = Math.floor(total / 12)
  const tm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  return ymdOf(new Date(Date.UTC(ty, tm - 1, Math.min(d, lastDay))))
}

/**
 * 把一条（可能重复的）事件展开为 [from,to] 窗内的实例日期列表（date-only，闭区间）。
 * 规则：从 start 日期起按 interval 步进（daily=天 / weekly=7 天 / monthly=月），
 * 依次应用 count（计数上限，含被例外的实例）与 until（日期上界），跳过 exdates；
 * 上限 MAX_CALENDAR_INSTANCES 防放大失控（超出即抛错，要求收窄窗或调整规则）。
 *
 * monthly 关键细节：**每次都以原始 start 的日号**计算第 k 次（addMonthsClamped(start, k*interval)），
 * 而不是在钳制后的日期上继续步进——否则 1/31 → 2/28 → 3/28 会持续漂移（丢失月末语义）。
 */
export function expandCalendarDates(event, from, to) {
  const startDate = String(event.start).slice(0, 10)
  const rec = event.recurrence ?? null
  if (rec === null) {
    return startDate >= from && startDate <= to ? [startDate] : []
  }
  const exdates = new Set(rec.exdates ?? [])
  const out = []
  let produced = 0 // 规则自身产生的实例计数（含例外，用于 count 语义）
  const stepDays = rec.freq === 'daily' ? 1 : rec.freq === 'weekly' ? 7 : 0
  let guard = 0
  for (let k = 0; ; k++) {
    if (guard++ > MAX_CALENDAR_INSTANCES * 4) throw new Error(`重复事件展开超出上限（规则或窗过大）：事件 ${event.id}`)
    // 第 k 个实例：monthly 始终基于 start 的日号（月内日钳制），其余按天数步进
    const day = rec.freq === 'monthly' ? addMonthsClamped(startDate, k * rec.interval) : addDays(startDate, k * stepDays * rec.interval)
    if (rec.until && day > rec.until) break
    produced += 1
    if (rec.count && produced > rec.count) break
    if (day > to) break // 窗右侧：日期单调递增，可直接停
    if (day >= from && !exdates.has(day)) {
      out.push(day)
      if (out.length > MAX_CALENDAR_INSTANCES) throw new Error(`重复事件在窗口内实例过多（上限 ${MAX_CALENDAR_INSTANCES}）：事件 ${event.id}`)
    }
    if (k > 0 && day <= (rec.freq === 'monthly' ? addMonthsClamped(startDate, (k - 1) * rec.interval) : addDays(startDate, (k - 1) * stepDays * rec.interval))) {
      throw new Error(`重复规则未推进（内部错误）：事件 ${event.id}`)
    }
  }
  return out
}

/** 事件对象映射（含 P2-5 新字段：taskId/goalId/recurrence）。
 *  occurrenceDate/recurring 在单条读取时按「首次实例」给出，列表展开时按实例覆盖。 */
function eventToObj(row) {
  const rec = parseJson(row.recurrence, null)
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    start: row.start,
    end: row.end ?? null,
    allDay: row.all_day === 1,
    taskId: row.taskId ?? null,
    goalId: row.goalId ?? null,
    recurrence: rec,
    occurrenceDate: String(row.start).slice(0, 10),
    recurring: rec !== null,
    meta: parseJson(row.meta, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function getCalendarEvent(id) {
  const num = Number(id)
  const row = Number.isInteger(num) && num > 0 ? db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(num) : undefined
  if (!row) throw new Error(`事件不存在：${id}`)
  return eventToObj(row)
}

/** 关联字段校验：任务/目标 id 为 T-xxx / G-xxx 形状或 null（空串视为未关联）。 */
function parseCalendarLink(raw, label) {
  if (raw === undefined || raw === null) return null
  const v = String(raw).trim()
  if (v.length === 0) return null
  if (v.length > 64) throw new Error(`${label} 过长（≤64 字符）`)
  return v
}

/** 公共入参校验（create/update 共用）：title/start/end/allDay/link/recurrence。 */
function validateCalendarInput(input, { partial }) {
  const out = {}
  if (!partial || input?.title !== undefined) {
    const title = input?.title
    if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
    if (title.trim().length > MAX_CALENDAR_TITLE) throw new Error(`标题过长（上限 ${MAX_CALENDAR_TITLE} 字符）`)
    out.title = title.trim()
  }
  let start = null
  if (!partial || input?.start !== undefined) {
    start = parseCalendarTime(input?.start, 'start')
    out.start = start.raw
  }
  if (!partial || input?.end !== undefined) {
    const endRaw = input?.end
    if (endRaw === undefined || endRaw === null || String(endRaw).trim() === '') out.end = null
    else {
      const end = parseCalendarTime(endRaw, 'end')
      if (start && end.key < start.key) throw new Error('end 必须 ≥ start（事件结束不得早于开始）')
      out.end = end.raw
      out._endKey = end.key
    }
  }
  if (!partial || input?.allDay !== undefined) out.allDay = input?.allDay === true
  if (!partial || input?.taskId !== undefined) out.taskId = parseCalendarLink(input?.taskId, 'taskId')
  if (!partial || input?.goalId !== undefined) out.goalId = parseCalendarLink(input?.goalId, 'goalId')
  if (!partial || input?.recurrence !== undefined) out.recurrence = parseRecurrence(input?.recurrence)
  if (!partial || input?.meta !== undefined) {
    out.meta = input?.meta !== null && typeof input?.meta === 'object' && !Array.isArray(input.meta) ? input.meta : {}
  }
  return out
}

/** 创建事件（by + scope 必填 + 审计/SSE）；start 必填可解析、end 可选须 ≥ start、title ≤ MAX_CALENDAR_TITLE。 */
export function createCalendarEvent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope（日程事件须归属明确的工作空间）')
  const v = validateCalendarInput(input, { partial: false })
  return withTx(() => {
    const t = now()
    const r = db.prepare('INSERT INTO calendar_events (scope, title, start, end, all_day, taskId, goalId, recurrence, meta, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(scope.trim(), v.title, v.start, v.end, v.allDay ? 1 : 0, v.taskId, v.goalId, v.recurrence ? JSON.stringify(v.recurrence) : null, JSON.stringify(v.meta), t, t)
    const ev = getCalendarEvent(Number(r.lastInsertRowid))
    audit(by, ev.scope, 'calendar:create', null, { event: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, taskId: ev.taskId, goalId: ev.goalId, recurrent: ev.recurrence !== null })
    return ev
  })
}

/**
 * 更新事件（P2-5 新增）：局部更新（仅传要改的字段）+ scope 归属校验（越权不可改）+ 审计 calendar:update。
 * start 变更时若未同时给 end，则重新校验旧的 end ≥ 新 start（避免产生倒序区间）。
 */
export function updateCalendarEvent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope（更新须指明事件所属空间）')
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('缺少参数 id')
  return withTx(() => {
    const ev = getCalendarEvent(id)
    if (ev.scope !== scope.trim()) throw new Error(`越权：事件 ${id} 属于 scope=${ev.scope}，不能用 scope=${scope.trim()} 更新`)
    const v = validateCalendarInput(input, { partial: true })
    // start 单独变更时的 end 校验（end 未随请求给出 → 用既有 end 兜底比较）
    if (v.start !== undefined && v.end === undefined && ev.end) {
      const newStart = parseCalendarTime(v.start, 'start')
      const oldEnd = parseCalendarTime(ev.end, 'end')
      if (oldEnd.key < newStart.key) throw new Error('end 必须 ≥ start（事件结束不得早于开始）')
    }
    const sets = []
    const params = []
    const assign = (col, val) => { sets.push(col + ' = ?'); params.push(val) }
    if (v.title !== undefined) assign('title', v.title)
    if (v.start !== undefined) assign('start', v.start)
    if (v.end !== undefined) assign('end', v.end)
    if (v.allDay !== undefined) assign('all_day', v.allDay ? 1 : 0)
    if (v.taskId !== undefined) assign('taskId', v.taskId)
    if (v.goalId !== undefined) assign('goalId', v.goalId)
    if (v.recurrence !== undefined) assign('recurrence', v.recurrence ? JSON.stringify(v.recurrence) : null)
    if (v.meta !== undefined) assign('meta', JSON.stringify(v.meta))
    if (sets.length === 0) throw new Error('没有可更新字段（title/start/end/allDay/taskId/goalId/recurrence/meta 至少一项）')
    assign('updatedAt', now())
    params.push(id)
    db.prepare('UPDATE calendar_events SET ' + sets.join(', ') + ' WHERE id = ?').run(...params)
    const next = getCalendarEvent(id)
    audit(by, next.scope, 'calendar:update', null, { event: id, title: next.title, fields: sets.map(s => s.split(' ')[0]).filter(c => c !== 'updatedAt') })
    return next
  })
}

/**
 * 事件列表：scope 过滤（缺省 = 全部，与 chat listConversations 同构）+ 日期窗 [from,to]（闭区间）。
 * P2-5：**重复事件在窗内展开**为实例（同一 id 多个日期，`occurrenceDate` 标注实例日、`recurring:true`），
 * 单次事件行为不变（`occurrenceDate` = 其 start 日期）。排序 occurrenceDate asc、start asc、id asc（稳定）。
 */
export function listCalendarEvents({ scope, from, to } = {}) {
  const conds = []
  const params = []
  if (typeof scope === 'string' && scope.trim().length > 0) { conds.push('scope = ?'); params.push(scope.trim()) }
  let f, t
  if (from !== undefined && from !== null && String(from).trim() !== '') {
    f = parseCalendarTime(String(from), 'from')
  }
  if (to !== undefined && to !== null && String(to).trim() !== '') {
    t = parseCalendarTime(String(to), 'to')
  }
  if (f && t && f.date > t.date) throw new Error('日期窗非法：from 不得晚于 to')
  // 窗下界需前推：重复事件可能在窗之前开始（DB 层按 start 前缀过滤会漏掉），因此
  // 有窗时只用 scope 过滤取候选，再在内存按展开结果精确过滤；无窗时退化为原语义（全部事件）。
  const sql = `SELECT * FROM calendar_events${conds.length ? ' WHERE ' + conds.join(' AND ') : ''}`
  const rows = db.prepare(sql).all(...params).map(eventToObj)
  // 无窗 = 不展开（每条事件一行，occurrenceDate 为其首次实例日，避免无界重复规则被强行展开）
  if (!f && !t) return rows.sort(compareOccurrence)
  const winFrom = f ? f.date : '0000-01-01'
  const winTo = t ? t.date : '9999-12-31'
  const out = []
  for (const ev of rows) {
    const dates = expandCalendarDates(ev, winFrom, winTo)
    if (dates.length === 0) continue
    const recurring = ev.recurrence !== null
    for (const day of dates) out.push({ ...ev, occurrenceDate: day, recurring })
  }
  return out.sort(compareOccurrence)
}

/** 实例排序：实例日 → 原始 start → id（稳定）。 */
function compareOccurrence(a, b) {
  if (a.occurrenceDate !== b.occurrenceDate) return a.occurrenceDate < b.occurrenceDate ? -1 : 1
  if (a.start !== b.start) return a.start < b.start ? -1 : 1
  return a.id - b.id
}

/**
 * 冲突检测（P2-5）：给定时间区间，返回同 space 内与之重叠的事件（展开后的实例区间）。
 * 规则：全天事件按整天 [date, date+1) 参与比较；非全天用 [start, end)（end 缺省 = start 起 1 小时，
 * 与前端默认时长一致）；同一事件可返回多个实例。仅作提示，**不阻断写入**。
 */
export function findCalendarConflicts({ scope, start, end, allDay = false, excludeId = null } = {}) {
  const s = parseCalendarTime(start, 'start')
  const e = end !== undefined && end !== null && String(end).trim() !== '' ? parseCalendarTime(end, 'end') : null
  const startMs = s.key
  const endMs = e ? e.key : s.key + 60 * 60 * 1000
  if (endMs < startMs) throw new Error('end 必须 ≥ start')
  const dayStart = s.date
  const dayEndExclusive = addDays(e ? e.date : s.date, 1)
  const winFrom = allDay ? dayStart : addDays(dayStart, -1)
  const winTo = allDay ? addDays(dayEndExclusive, 0) : addDays(e ? e.date : s.date, 1)
  const candidates = listCalendarEvents({ scope, from: winFrom, to: winTo })
  const out = []
  for (const ev of candidates) {
    if (excludeId !== null && ev.id === Number(excludeId)) continue
    let aStart, aEnd
    if (ev.allDay) {
      const d = ev.occurrenceDate
      aStart = parseCalendarTime(d, 'start').key
      aEnd = parseCalendarTime(addDays(d, 1), 'end').key
    } else {
      const day = ev.occurrenceDate
      const timeOf = (raw, fallback) => {
        const m = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(raw))
        if (!m) return null
        return day + 'T' + m[1] + ':' + m[2] + (m[3] ? ':' + m[3] : '')
      }
      const sTxt = timeOf(ev.start)
      if (sTxt === null) continue // date-only 但非 allDay：无时间点，不参与区间冲突
      aStart = parseCalendarTime(sTxt, 'start').key
      const eTxtRaw = ev.end ? timeOf(ev.end) : null
      const eTxt = eTxtRaw === null ? null : (String(ev.end).length <= 10 ? day + 'T23:59:59' : eTxtRaw)
      aEnd = eTxt === null ? aStart + 60 * 60 * 1000 : parseCalendarTime(eTxt, 'end').key
      // 跨日 end（end 日期 > start 日期）：按原始差值补齐天数
      if (ev.end && String(ev.end).length > 10 && String(ev.end).slice(0, 10) !== String(ev.start).slice(0, 10)) {
        const sameDayDiff = parseCalendarTime(String(ev.end).slice(0, 10) + 'T00:00', 'x').key - parseCalendarTime(String(ev.start).slice(0, 10) + 'T00:00', 'x').key
        aEnd += sameDayDiff
      }
    }
    if (aStart < endMs && aEnd > startMs) {
      out.push({ id: ev.id, title: ev.title, occurrenceDate: ev.occurrenceDate, start: ev.start, end: ev.end, allDay: ev.allDay, recurring: ev.recurring, overlapMs: Math.min(aEnd, endMs) - Math.max(aStart, startMs) })
    }
  }
  return out.sort((a, b) => (a.occurrenceDate === b.occurrenceDate ? b.overlapMs - a.overlapMs : (a.occurrenceDate < b.occurrenceDate ? -1 : 1)))
}

/**
 * 关联查询（P2-5 双向关联）：按 taskId 或 goalId 查关联日程，供任务详情面板展示「关联日程」。
 * 语义：**带窗**（from/to）→ 重复事件展开为实例；**无窗** → 每条事件返回一行（occurrenceDate =
 * 首次实例日），不强行展开无界规则（避免把「每天、无结束」这类规则展开爆掉）。
 */
export function listCalendarEventsByLink({ taskId = null, goalId = null, from, to } = {}) {
  const t = parseCalendarLink(taskId, 'taskId')
  const g = parseCalendarLink(goalId, 'goalId')
  if (!t && !g) throw new Error('必须指定 taskId 或 goalId')
  const conds = []
  const params = []
  if (t) { conds.push('taskId = ?'); params.push(t) }
  if (g) { conds.push('goalId = ?'); params.push(g) }
  const rows = db.prepare('SELECT * FROM calendar_events WHERE ' + conds.join(' OR ') + ' ORDER BY start ASC, id ASC').all(...params).map(eventToObj)
  if (from === undefined && to === undefined) return rows.sort(compareOccurrence)
  const winFrom = from !== undefined && from !== null && String(from).trim() !== '' ? parseCalendarTime(String(from), 'from').date : '0000-01-01'
  const winTo = to !== undefined && to !== null && String(to).trim() !== '' ? parseCalendarTime(String(to), 'to').date : '9999-12-31'
  const out = []
  for (const ev of rows) {
    for (const day of expandCalendarDates(ev, winFrom, winTo)) {
      out.push({ ...ev, occurrenceDate: day, recurring: ev.recurrence !== null })
    }
  }
  return out.sort(compareOccurrence)
}

/** 删除事件：二次确认 confirm=yes + scope 归属校验（越权不可删他人空间事件）+ 审计 calendar:delete。
 *  P2-5 重复事件删除：`mode: 'series'`（默认，整串删除）或 `mode: 'occurrence'` + `occurrenceDate`
 *  （仅删该实例 → 记入 recurrence.exdates，规则本身保留；已是最后实例时按整串处理并说明）。 */
export function deleteCalendarEvent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope（删除须指明事件所属空间）')
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('缺少参数 id')
  if (input?.confirm !== 'yes') throw new Error('缺少二次确认：confirm 必须为 yes')
  const mode = input?.mode === undefined || input?.mode === null ? 'series' : String(input.mode)
  if (mode !== 'series' && mode !== 'occurrence') throw new Error('mode 必须是 series（整串）或 occurrence（仅本次）')
  return withTx(() => {
    const ev = getCalendarEvent(id)
    if (ev.scope !== scope.trim()) throw new Error(`越权：事件 ${id} 属于 scope=${ev.scope}，不能用 scope=${scope.trim()} 删除`)
    if (mode === 'occurrence') {
      if (ev.recurrence === null) throw new Error('单次事件不支持 occurrence 删除（请用 mode=series 或直接删除）')
      const day = parseCalendarTime(input?.occurrenceDate, 'occurrenceDate').date
      if (day < String(ev.start).slice(0, 10)) throw new Error('occurrenceDate 不得早于事件开始日')
      const exdates = [...new Set([...(ev.recurrence.exdates ?? []), day])].sort()
      const remaining = expandCalendarDates({ ...ev, recurrence: { ...ev.recurrence, exdates } }, '0000-01-01', '9999-12-31')
      if (remaining.length === 0) {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
        audit(by, ev.scope, 'calendar:delete', null, { event: id, title: ev.title, mode: 'occurrence', occurrenceDate: day, seriesRemoved: true })
        return { deleted: true, event: id, scope: ev.scope, title: ev.title, mode: 'occurrence', occurrenceDate: day, seriesRemoved: true }
      }
      db.prepare('UPDATE calendar_events SET recurrence = ?, updatedAt = ? WHERE id = ?').run(JSON.stringify({ ...ev.recurrence, exdates }), now(), id)
      audit(by, ev.scope, 'calendar:update', null, { event: id, title: ev.title, mode: 'occurrence', occurrenceDate: day, exdates: exdates.length })
      return { deleted: true, event: id, scope: ev.scope, title: ev.title, mode: 'occurrence', occurrenceDate: day, seriesRemoved: false, remaining: remaining.length }
    }
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
    audit(by, ev.scope, 'calendar:delete', null, { event: id, title: ev.title, mode: 'series' })
    return { deleted: true, event: ev.id, scope: ev.scope, title: ev.title, mode: 'series' }
  })
}

// ── 规范（rules）DAO：全局层 + 空间层扩展点（R-2，S4）──
// 写纪律同 chat/calendar：by 必填 + audit（rules:update）+ SSE；author/scope 服务端绑定。
export const MAX_RULES_LEN = Number(process.env.MAX_RULES_LEN || 3000) // 规范内容长度上限（⚖️ env 可配，三值法断言）

/** 合法规范 scope：global（全局层）或空间/项目层 id（与 spaces id 同构，预留扩展点）。 */
export function validRuleScope(scope) {
  return typeof scope === 'string' && scope.trim().length > 0 && /^[a-z0-9][a-z0-9-]{0,63}$/.test(scope.trim())
}

/** 读规范：未设置 → { scope, content: '', updatedAt: null }（合理默认，不报错）。 */
export function getRule(scope = 'global') {
  const sc = (scope ?? 'global').trim() || 'global'
  const row = db.prepare('SELECT scope, content, updatedAt FROM rules WHERE scope = ?').get(sc)
  return row ?? { scope: sc, content: '', updatedAt: null }
}

/** 保存规范：幂等 upsert（key=scope）；content 须字符串且 ≤ MAX_RULES_LEN；写由路由层 audit（handleWrite 纪律）。 */
export function saveRule({ scope = 'global', content, by }) {
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const sc = (typeof scope === 'string' && scope.trim().length > 0 ? scope.trim() : 'global')
  if (!validRuleScope(sc)) throw new Error('scope 非法：global 或小写字母/数字开头的空间 id（≤64 字符）')
  if (typeof content !== 'string') throw new Error('content 必须是字符串')
  if (content.length > MAX_RULES_LEN) throw new Error(`规范内容超长（上限 ${MAX_RULES_LEN} 字符）`)
  return withTx(() => {
    const t = now()
    db.prepare('INSERT INTO rules (key, scope, content, updatedAt) VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt')
      .run(sc, sc, content, t)
    audit(by, sc, 'rules:update', null, { scope: sc, contentLength: content.length, preview: content.slice(0, 80) })
    return { scope: sc, content, updatedAt: t }
  })
}

// ── 写操作 ──
/**
 * 建任务（**已在事务内**的版本）。
 *
 * 拆出来是因为运行仓储的交接（PRT-308）需要在**它自己的**事务里建后继任务
 * ——spec 第 333 行要的「原子创建/释放下一岗位任务」就是这件事。
 *
 * 为什么不能直接调 `createTask`：本文件与 `run-store.mjs` 各自有一个 `withTx`，
 * 两个闭包各自维护自己的 `txDepth`。server 的 `createTask` 进到
 * run-store 已开启的事务里时，它认为自己在最外层，于是又发一次 `BEGIN IMMEDIATE`
 * ——报 `cannot start a transaction within a transaction`，而这条错误
 * 看起来像"夹具的问题"，实际是"两处各自记账"的必然结果。
 *
 * 因此把函数体单独拿出来，由调用方声明"我已经在事务里了"。
 */
function createTaskInTx(input) {
  {
    const id = nextId()
    const std = taskStandards(input.role, input.acceptance, input.boundary)
    // 目标归属回填：显式 goalId 优先；否则若带 slice 键（如 'T-004:S2' 或 devops 尾 'T-004'），
    // 从切片前缀任务反查其 goalId —— 保证 fix 回炉/守护补建任务也挂到同一目标（per-goal 统计/上下文注入不漏）。
    let goalId = typeof input.goalId === 'string' && input.goalId.length > 0 ? input.goalId : null
    if (goalId === null && typeof input.slice === 'string' && input.slice.trim() !== '') {
      const prefix = String(input.slice).split(':')[0].trim()
      if (/^T-\d+$/.test(prefix)) {
        const src = db.prepare('SELECT goalId FROM tasks WHERE id = ?').get(prefix)
        if (src?.goalId) goalId = src.goalId
      }
    }
    // 收口目标的唯一收口点（解析后的 goalId，显式传入与切片前缀反查两条路径都覆盖）
    assertGoalOpen(goalId)
    const t = {
      id,
      title: input.title.trim(),
      description: input.description ?? '',
      acceptance: std.acceptance,
      boundary: std.boundary,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'backlog',
      version: 1,
      soldier: null,
      claimedRound: null,
      claimedAt: null,
      ordersVersion: input.ordersVersion ?? 1,
      parent: input.parent ?? null,
      role: input.role ?? null,
      scope: input.scope ?? 'default',
      blocks: [],
      blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy.map(String).filter(Boolean) : [],
      comments: [],
      evidence: [],
      patches: [],
      artifacts: [],
      slice: input.slice ?? null,
      sliceIdx: input.sliceIdx ?? null,
      fixOf: input.fixOf ?? null,
      fixCount: input.fixCount ?? 0,
      goalId,
      fileDomain: Array.isArray(input.fileDomain) ? input.fileDomain.map(String).filter(Boolean) : null,
      docSync: input.docSync === true,
      createdAt: now(),
      updatedAt: now(),
    }
    if (t.title.length === 0) throw new Error('title 必须是非空字符串')
    if (!PRIORITIES.includes(t.priority)) throw new Error(`非法优先级 ${t.priority}`)
    if (t.status !== 'backlog' && t.status !== 'todo') throw new Error(`非法初始状态 ${t.status}`)
    if (t.parent !== null && !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(t.parent)) throw new Error(`父任务 ${t.parent} 不存在`)
    db.prepare(`
      INSERT INTO tasks (id, title, description, acceptance, boundary, priority, status, version, soldier, claimedRound, claimedAt,
        ordersVersion, parent, role, scope, blocks, blockedBy, comments, evidence, patches, artifacts, slice, sliceIdx, fixOf, fixCount, goalId, fileDomain, docSync, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t.id, t.title, t.description, JSON.stringify(t.acceptance), JSON.stringify(t.boundary), t.priority, t.status, t.ordersVersion, t.parent, t.role, t.scope, JSON.stringify(t.blockedBy), t.slice, t.sliceIdx, t.fixOf, t.fixCount, t.goalId, t.fileDomain ? JSON.stringify(t.fileDomain) : null, t.docSync ? 1 : 0, t.createdAt, t.updatedAt)
    return getTask(id)
  }
}

/** 建任务的**唯一对外入口**：自己开一个事务，然后走上面那个函数体。 */
function createTask(input) {
  return withTx(() => createTaskInTx(input))
}

// ── 目标自动分解：发布目标时按空间编队生成「阶段任务链」，指派给对应智能体 ──
// 通用阶段标签（按编队 sort 顺序逐个分派；超出循环）。software 编队天然按流水线排序，
// 故 requirement→需求讨论 / researcher→方案设计 / breaker→任务拆分 … 语义一一对应。
const GOAL_STAGE_LABELS = ['需求讨论', '方案设计', '任务拆分', '用例设计', '代码开发', '代码审查', '测试验收', '发布部署']

/** 建一个 [auto-goal] 任务行（chain / slice 展开共用）。goalId = 所属目标（多目标并发按目标挂接）。返回新任务。 */
function insertGoalTask({ title, description, acceptance, boundary, role, scope, blockedBy = [], status = 'todo', parent = null, slice = null, sliceIdx = null, fixOf = null, fixCount = 0, priority = 'high', goalId = null, fileDomain = null, docSync = false }) {
  assertGoalOpen(goalId)
  const id = nextId()
  db.prepare(`
    INSERT INTO tasks (id, title, description, acceptance, boundary, priority, status, version, soldier, claimedRound, claimedAt,
      ordersVersion, parent, role, scope, blocks, blockedBy, comments, evidence, patches, artifacts, slice, sliceIdx, fixOf, fixCount, goalId, fileDomain, docSync, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 1, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, JSON.stringify(acceptance), JSON.stringify(boundary), priority, status, parent, role, scope, JSON.stringify(blockedBy), slice, sliceIdx, fixOf, fixCount, goalId, Array.isArray(fileDomain) ? JSON.stringify(fileDomain) : null, docSync === true ? 1 : 0, now(), now())
  return getTask(id)
}

/**
 * 发布目标 → 任务链。两种模式：
 * - chain（默认，v2 现状）：按空间编队全串阶段链（blockedBy=[prev]）；
 * - slice（v3 切片流水线）：只生成「分析前缀链」（需求→方案→拆解→用例设计，到 test-designer 为止），
 *   并带 [slice-mode] 标记；test-designer done 后由守护解析 TASK_BREAKDOWN.md →
 *   POST /api/goal/slices 展开「编码切片束」（coder_Si→tester_Si 微链 + devops 目标级收尾），
 *   切片之间无依赖 → coder_Si+1 编码与 tester_Si 测试天然并行（架构见 docs/ORCHESTRATION-V3.md）。
 *
 * 多目标并发：本函数**只新建**给定目标（goalId）自己的链，链任务全部挂 goalId；
 * **不再取消**该空间其他目标/历史链的任务——目标并存、各自推进、互不干扰
 * （将军可在指挥台按目标 暂停/恢复/取消 收尾）。
 */
function createGoalChain(goalId, scope, objective, mode = 'chain') {
  return withTx(() => {
    const goal = getGoal(goalId)
    if (goal.scope !== scope) throw new Error(`目标 ${goalId} 不属于空间 ${scope}`)
    const roster = db.prepare('SELECT role, name, kind, avatar FROM roster WHERE scope = ? ORDER BY sort, role').all(scope)
    const pipe = pipelineLabels()
    // SP-P0：空间流水线（space_stages）优先——入链 = 编队 ∩ 流水线启用岗位。
    // 这一层是「非执行岗入编导致 blockedBy 链死锁」的机制性消除：编队里没配阶段（或显式 enabled=0）的成员
    // 不再进链，链上每一环都保证有守护认领方；编队与流水线的差异由 GET /api/spaces/provision 报给将军。
    const spaceStages = stagesByRoleOf(scope)
    const route = spaceStages.size > 0
      ? roster.filter(r => {
        const st = spaceStages.get(r.role)
        return st !== undefined && st.enabled !== 0
      })
      : roster
    // slice 模式前置条件：编队含分析尾（test-designer）与构建岗位（coder/tester）；缺则回退 chain
    const tdIdx = route.findIndex(r => r.role === 'test-designer')
    const sliced = mode === 'slice' && tdIdx >= 0 && route.some(r => r.role === 'coder') && route.some(r => r.role === 'tester')
    const build = sliced ? route.slice(0, tdIdx + 1) : route
    if (build.length === 0 && roster.length > 0) {
      // 只有在「编队有人、但流水线一个都没启用」时才拦：这种情况建出的链没有任何认领方，
      // 会永远停在 todo（T-127 现场那类静默停滞）。**编队本身为空**属于既有合法态
      // （如通知中心冒烟/空空间先发目标后补编队）——保持 0 环建链，不改变既有行为。
      throw new Error(`空间 ${scope} 编队与流水线没有交集（编队 ${roster.length} 人：${roster.map(r => r.role).join('、')}；流水线启用岗位 ${[...spaceStages.values()].filter(s => s.enabled !== 0).map(s => s.role).join('、') || '（无）'}）——请先为该空间配置流水线或调整编队`)
    }
    const created = []
    let prev = null
    build.forEach((r, i) => {
      // 阶段名：空间流水线 label > roles.json 标签 > 通用阶段标签（与任务集泳道名保持一致）
      const stageLabel = spaceStages.get(r.role)?.label
      const named = stageLabel && stageLabel !== r.role ? stageLabel : (pipe[r.role] && pipe[r.role] !== r.role ? pipe[r.role] : null)
      const label = named ?? GOAL_STAGE_LABELS[i % GOAL_STAGE_LABELS.length]
      const description = sliced
        ? `[auto-goal]\n[slice-mode]\n目标：${objective.trim()}\n本阶段：${label}（${r.name}）`
        : `[auto-goal]\n目标：${objective.trim()}\n本阶段：${label}（${r.name}）`
      // 生成任务必须同时生成验收标准 + 边界（做什么/不做什么）——按该岗位模板注入
      const s = standardsFor(r.role)
      // RC-2：docSync 目标 → 落到链上 coder 岗位（实现+同步手册/README 的执行者）；
      // 前段分析岗/测试岗/发布岗不背 docSync（避免 FEATURES 尚不存在时误停前段 in_review）。
      const chainTaskDocSync = goal.docSync === true && r.role === 'coder'
      const task = insertGoalTask({
        title: `【${label}】${objective.trim().slice(0, 40)}`,
        description,
        acceptance: s.acceptance,
        boundary: { do: s.do, dont: s.dont },
        role: r.role,
        scope,
        blockedBy: prev ? [prev] : [],
        goalId,
        docSync: chainTaskDocSync,
      })
      created.push({ id: task.id, role: r.role, label })
      prev = task.id
    })
    return { count: created.length, tasks: created, mode: sliced ? 'slice' : 'chain' }
  })
}

/** 按岗位模板取切片任务的验收/边界（role 缺省模板，供切片展开时合并）。 */
function sliceStandards(role, acceptance, extraDo = [], extraDont = []) {
  const std = standardsFor(role)
  const clean = (list) => Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim().length > 0) : []
  const acc = clean(acceptance)
  return {
    acceptance: acc.length > 0 ? acc : std.acceptance,
    boundary: {
      do: [...std.do, ...extraDo],
      dont: [...std.dont, ...extraDont],
    },
  }
}

/**
 * 切片展开（slice 模式专用，守护在 test-designer done 后调用）：
 * 每个切片生成 coder_Si（blockedBy=test-designer 任务）→ tester_Si（blockedBy=coder_Si）微链；
 * 全部切片注册后生成 devops 目标级收尾（blockedBy=全部 tester）。
 * 幂等：同 testDesignerTaskId 已展开过（存在 slice 行）则直接返回既有，不重复建。
 */
function expandGoalSlices({ testDesignerTaskId, slices, by }) {
  return withTx(() => {
    const td = getTask(testDesignerTaskId)
    if (td.role !== 'test-designer') throw new Error(`切片展开需要 test-designer 任务，实际 role=${td.role}`)
    if (String(td.description ?? '').indexOf('[auto-goal]') === -1) throw new Error(`任务 ${td.id} 不是自动目标链任务，不可展开切片`)
    if (td.status !== 'done') throw new Error(`分析前缀未完成（${td.id} 当前 ${td.status}）：先完成测试用例设计再展开切片`)
    const prefix = `${td.id}:S`
    const existing = db.prepare('SELECT id, slice FROM tasks WHERE scope = ? AND (slice LIKE ? OR slice = ?)').all(td.scope, `${prefix}%`, td.id)
    if (existing.length > 0) return { mode: 'slice', testDesignerTaskId: td.id, created: [], existed: existing.map(x => x.id) }
    if (!Array.isArray(slices) || slices.length === 0 || slices.length > 16) throw new Error('slices 必须是 1..16 个切片的数组')
    const objectiveLine = String(td.description ?? '').split('\n').find(l => l.startsWith('目标：')) ?? '目标：（见分析前缀任务）'
    // 切片任务归属同一目标（沿用 test-designer 任务的 goalId；老链无 goalId 时为 null，不影响建链）
    const goalId = td.goalId ?? null
    // RC-2：docSync 目标 → 每个 coder_Si 带 docSync（切片实现各自同步手册相关小节）
    let goalDocSync = false
    if (goalId) { try { goalDocSync = getGoal(goalId).docSync === true } catch { /* 目标缺失则不强制 */ } }
    // 测试用例文档按目标目录解析（docs/<goalId>/TEST_CASES.md；遗留目标回退根 docs/TEST_CASES.md）
    const testCasesPath = goalDocPathOf(goalId, 'TEST_CASES.md')
    const created = []
    const testerIds = []
    slices.forEach((sli, idx) => {
      if (!sli || typeof sli.title !== 'string' || sli.title.trim().length === 0) throw new Error(`切片 ${idx + 1} 缺少 title`)
      const title = sli.title.trim()
      const files = Array.isArray(sli.files) ? sli.files.map(String).filter(Boolean) : []
      const sAcc = Array.isArray(sli.acceptance) ? sli.acceptance.map(String).filter(Boolean) : []
      const si = idx + 1
      const sliceKey = `${td.id}:S${si}`
      // coder_Si：只做本切片（文件域约束写进边界），验收 = 切片验收 / 岗位默认
      const coderStd = sliceStandards('coder', sAcc, files.length ? [`只改动本切片文件域：${files.join(', ')}`] : [])
      const coder = insertGoalTask({
        title: `【切片 S${si} 编码】${title.slice(0, 36)}`,
        description: `[auto-goal]\n[slice]\n${objectiveLine}\n切片 S${si}：${title}${files.length ? `\n文件域：${files.join(', ')}` : ''}`,
        acceptance: coderStd.acceptance,
        boundary: coderStd.boundary,
        role: 'coder',
        scope: td.scope,
        blockedBy: [td.id],
        slice: sliceKey,
        sliceIdx: si,
        goalId,
        fileDomain: files,
        docSync: goalDocSync,
      })
      // tester_Si：只测不修；验收 = 结构化 testReport（passed=true 才自动 done，D7' 机器闸门）
      const testerStd = sliceStandards('tester', [], [], ['不得修改任何源码/测试用例（只测不修）'])
      const tester = insertGoalTask({
        title: `【切片 S${si} 测试】${title.slice(0, 30)}`,
        description: `[auto-goal]\n[slice-test]\n${objectiveLine}\n切片 S${si}：${title}\n要求：运行测试用例（${testCasesPath} 覆盖本切片的部分），只测不修；结构化回报 testReport={passed, failures:[{name,log,repro}]}。`,
        acceptance: testerStd.acceptance,
        boundary: testerStd.boundary,
        role: 'tester',
        scope: td.scope,
        blockedBy: [coder.id],
        slice: sliceKey,
        sliceIdx: si,
        goalId,
        fileDomain: files,
      })
      created.push(coder.id, tester.id)
      testerIds.push(tester.id)
    })
    // devops 目标级收尾：全部 tester done 才解锁
    const objectiveText = objectiveLine.replace(/^目标：/, '').slice(0, 36)
    const devopsStd = sliceStandards('devops')
    const devops = insertGoalTask({
      title: `【发布部署】${objectiveText || '目标级收尾'}`,
      description: `[auto-goal]\n[slice-tail]\n${objectiveLine}\n本阶段：发布部署（devops）——全部切片测试通过后执行目标级收尾。`,
      acceptance: devopsStd.acceptance,
      boundary: devopsStd.boundary,
      role: 'devops',
      scope: td.scope,
      blockedBy: testerIds,
      slice: td.id,
      goalId,
    })
    created.push(devops.id)
    audit(by, td.scope, 'goal:slices', td.id, { testDesignerTaskId: td.id, slices: slices.length, created: created.length }, goalId)
    return { mode: 'slice', testDesignerTaskId: td.id, created, devops: devops.id }
  })
}

function claimTask(id, soldier, ifVersion, force, round, requestId, ttlMinutes) {
  return withTx(() => {
    const t = getTask(id)
    if (ifVersion !== undefined) {
      if (!Number.isInteger(ifVersion)) throw new Error(`ifVersion 必须是整数`)
      if (t.version !== ifVersion) throw new Error(`乐观锁冲突：任务 ${id} 当前 version=${t.version}，你期望 ${ifVersion}`)
    }
    // 幂等命中：同 request-id + 同士兵 + 已 in_progress → 视为上次认领已生效，不重复写
    if (requestId !== undefined && t.claimRequestId === requestId && t.soldier === soldier && t.status === 'in_progress') {
      return t
    }
    if (t.soldier !== null && t.soldier !== soldier) throw new Error(`任务 ${t.id} 已被 ${t.soldier} 认领，不得抢占`)
    if (t.status !== 'todo' && t.status !== 'blocked') throw new Error(`无法认领：任务 ${t.id} 当前 ${t.status}`)
    if (t.hold) throw new Error(`任务 ${t.id} 被将军拦截（hold），先在任务详情「放行」后再自动执行`)
    assertUnblocked(t, force)
    const at = now()
    const ttl = ttlMinutes !== undefined ? ttlMinutes : t.ttlMinutes
    const expires = ttl !== null && ttl !== undefined ? new Date(new Date(at).getTime() + ttl * 60_000).toISOString() : null
    db.prepare('UPDATE tasks SET status=\'in_progress\', soldier=?, claimedRound=?, claimedAt=?, ttlMinutes=?, expiresAt=?, claimRequestId=?, version=version+1, updatedAt=? WHERE id=?')
      .run(soldier, round ?? null, at, ttl ?? null, expires, requestId ?? null, now(), id)
    return getTask(id)
  })
}

function transitionTask(id, to, by, ifVersion, force) {
  return withTx(() => {
    const t = getTask(id)
    if (ifVersion !== undefined) {
      if (!Number.isInteger(ifVersion)) throw new Error(`ifVersion 必须是整数`)
      if (t.version !== ifVersion) throw new Error(`乐观锁冲突：任务 ${id} 当前 version=${t.version}，你期望 ${ifVersion}`)
    }
    const allowed = TRANSITIONS[t.status] ?? []
    if (!allowed.includes(to)) throw new Error(`非法迁移 ${t.status} → ${to}（允许：${allowed.join(', ')}）`)
    if (to === 'in_progress') {
      if (t.soldier !== null && t.soldier !== by) throw new Error(`任务 ${t.id} 已绑定 ${t.soldier}，不能由 ${by} 开工`)
      assertUnblocked(t, force)
      // 开工/认领统一记 claimedAt：避免「in_progress 但无认领时间」的孤儿任务无法被租约回收
      if (by) db.prepare('UPDATE tasks SET soldier=?, claimedAt=?, claimedRound=NULL WHERE id=?').run(by, now(), id)
    }
    if (to === 'done') {
      if (t.status !== 'in_review') throw new Error('只有 in_review 可完成；先迁移到 in_review')
      if (by !== 'general') throw new Error('只有将军（by=general）能在用户接受后把任务移到 done')
    }
    if (to === 'in_review' && by && t.soldier !== null && t.soldier !== by) {
      throw new Error(`任务 ${t.id} 由 ${t.soldier} 负责，不能由 ${by} 提交验收`)
    }
    if (to === 'todo') {
      db.prepare('UPDATE tasks SET soldier=NULL, claimedAt=NULL, claimedRound=NULL WHERE id=?').run(id)
    }
    db.prepare('UPDATE tasks SET status=?, version=version+1, updatedAt=? WHERE id=?').run(to, now(), id)
    return getTask(id)
  })
}

function advanceTask(id, by, ifVersion) {
  return withTx(() => {
    const t = getTask(id)
    if (ifVersion !== undefined && t.version !== ifVersion) throw new Error(`乐观锁冲突：任务 ${id} 当前 version=${t.version}`)
    if (t.status !== 'in_progress' && t.status !== 'in_review') throw new Error(`无法推进：任务 ${id} 当前 ${t.status}`)
    const expected = t.role ?? t.soldier
    if (expected !== null && expected !== by) throw new Error(`只有 ${expected} 可推进任务 ${id}`)
    db.prepare('UPDATE tasks SET status=\'done\', version=version+1, updatedAt=? WHERE id=?').run(now(), id)
    return getTask(id)
  })
}

/**
 * 往任务的某个批注列追加一条 `{ by, at, text }`。
 *
 * 三个列各有各的意思，**不是**同一个东西的三种标签：
 *   · `comments` —— 同事/同事型智能体的批注（peer 的话）
 *   · `evidence` —— 验收证据
 *   · `feedback` —— **用户反馈**（PRT-404）：人说的话，装配时进 `user-feedback` 来源
 *
 * ★ 这里**不再**留一个 `commentTask(id, by, text, isEvidence)` 的兼容包装。
 *   加反馈那一批我确实先写了它，然后把路由改成直接调本函数——包装就成了
 *   **只有定义、没有调用**的死代码。
 *
 *   > 一个"留着给旧调用方用"的兼容包装，
 *   > 与一个"已经没有任何调用方"的死函数，在现在这一刻是同一个东西——
 *   > 只不过前者会让下一个人以为还有别的调用方，于是不敢改它的语义。
 *
 * @param {'comments'|'evidence'|'feedback'} field
 */
function appendTaskNote(id, by, text, field) {
  return withTx(() => {
    const t = getTask(id)
    const list = parseJson(t[field], [])
    list.push({ by, at: now(), text })
    db.prepare(`UPDATE tasks SET ${field}=?, version=version+1, updatedAt=? WHERE id=?`).run(JSON.stringify(list), now(), id)
    return getTask(id)
  })
}

// ── 转派 / 租约回收 / 离线 inbox ──
// 转派 = 把任务交给另一岗位（role）的智能体实现：soldier 与 role 一并改为目标岗位，
// 守护按 role 认领/派工，保证「将军转派后任务仍由对应 agent 自动接管执行」；
// 目标 role 不在流水线内（如外部协作岗）则守护跳过，成为人工托管任务。
function reassignTask(id, soldier, by) {
  return withTx(() => {
    const t = getTask(id)
    if (t.status === 'done' || t.status === 'canceled') throw new Error(`任务 ${id} 已 ${t.status}，不可转派`)
    if (t.soldier === soldier && t.role === soldier) throw new Error(`任务 ${id} 已由 ${soldier} 负责，无需转派`)
    const prev = t.soldier ?? '（未分配）'
    const comments = parseJson(t.comments, [])
    comments.push({ by, at: now(), text: `转派：${prev} → ${soldier}（由 ${by}，岗位同步为 ${soldier}）` })
    db.prepare('UPDATE tasks SET soldier=?, role=?, comments=?, version=version+1, updatedAt=? WHERE id=?').run(soldier, soldier, JSON.stringify(comments), now(), id)
    return getTask(id)
  })
}

/** 守护批量回收：认领超过 olderThan 分钟无进展、或已过 expiresAt 的 in_progress 任务释放回 todo。
 *  claimedAt 为空的历史孤儿（旧「开工」未记认领时间）按 updatedAt 起算，避免永久卡死。
 *  ids 提供时只回收列出的任务（守护重启孤儿回收专用：无视超时，立即释放）。 */
function releaseStaleTasks(olderThanMinutes, by, ids) {
  return withTx(() => {
    const cutoff = Date.now() - olderThanMinutes * 60_000
    const nowMs = Date.now()
    const rows = db.prepare("SELECT id, claimedAt, expiresAt, updatedAt FROM tasks WHERE status='in_progress'").all()
    const released = []
    for (const r of rows) {
      if (Array.isArray(ids)) {
        if (!ids.includes(r.id)) continue
        const reason = `守护重启检测到孤儿在办任务（worker 已随进程消失），自动释放回 todo 重新认领续做`
        const t = getTask(r.id)
        const comments = parseJson(t.comments, [])
        comments.push({ by, at: now(), text: reason })
        db.prepare('UPDATE tasks SET status=\'todo\', soldier=NULL, claimedAt=NULL, claimedRound=NULL, ttlMinutes=NULL, expiresAt=NULL, claimRequestId=NULL, comments=?, version=version+1, updatedAt=? WHERE id=?')
          .run(JSON.stringify(comments), now(), r.id)
        released.push(r.id)
        continue
      }
      const base = r.claimedAt !== null && r.claimedAt !== undefined ? new Date(r.claimedAt).getTime() : new Date(r.updatedAt ?? '').getTime()
      const staleByAge = !Number.isNaN(base) && base <= cutoff
      const staleByTtl = r.expiresAt !== null && r.expiresAt !== undefined && new Date(r.expiresAt).getTime() <= nowMs
      if (!staleByAge && !staleByTtl) continue
      const reason = staleByTtl
        ? `守护检测到任务已过 TTL（expiresAt=${r.expiresAt}），自动释放回 todo`
        : `守护检测到认领超过 ${olderThanMinutes} 分钟无进展，自动释放回 todo`
      const t = getTask(r.id)
      const comments = parseJson(t.comments, [])
      comments.push({ by, at: now(), text: reason })
      db.prepare('UPDATE tasks SET status=\'todo\', soldier=NULL, claimedAt=NULL, claimedRound=NULL, ttlMinutes=NULL, expiresAt=NULL, claimRequestId=NULL, comments=?, version=version+1, updatedAt=? WHERE id=?')
        .run(JSON.stringify(comments), now(), r.id)
      released.push(r.id)
    }
    return released
  })
}

/** 离线 inbox：某士兵/角色名下待处理（todo/blocked 未认领）任务计数与 id 列表。 */
function inboxCount({ role, soldier, scope }) {
  const conds = ["status IN ('todo','blocked')", 'soldier IS NULL']
  const params = {}
  if (role !== undefined) { conds.push('role = :role'); params.role = role }
  if (soldier !== undefined) { conds.push('role = :soldier'); params.soldier = soldier }
  if (scope !== undefined) { conds.push('scope = :scope'); params.scope = scope }
  const rows = db.prepare(`SELECT id, status FROM tasks WHERE ${conds.join(' AND ')} ORDER BY id`).all(params)
  return { count: rows.length, tasks: rows }
}

// ── SSE ──
const eventClients = new Set()

// ============================================================================
// F-05 投递状态机（`team-hub/event-delivery.mjs`）
//
// 改动前这里只有 `eventClients` 一个内存 Set 与下面那句静默 `continue`：
//
//     if (client.scope === undefined || client.scope === entry.scope) writeEventFrame(client.res, entry)
//
// 两个出口没有记录：① scope 不匹配（一个 `continue`）；② `res.write` 失败
// （返回值被丢掉，异常被事件循环吞掉）。**"发不出去也不说"与"从没打算发"
// 在"用户有没有看到"上是同一个东西。**
//
// 现在每一次投递都落一行可查的状态。两条纪律决定了下面对 `broadcastAudit` 的改写：
//
//   · **记账不许拖垮广播**。SSE 是热路径，而投递记账要写库。所以整段包在
//     一次 `withTx` 里（一次事务，不是每条事件一次），并且**任何异常都不许
//     冒泡到 `audit()`**——审计是业务操作的诊断，不是它的前置条件。
//     但失败**要被数出来**（`deliveryBookkeepingFailures`），不能静默。
//   · **拆不开的两种情况要拆开**。投递失败 = `markFailed`（可重试）；
//     取走被拒 = 两个投递者抢同一行（CAS 让一个赢），**不是失败**，
//     所以不记 `failed`——记了会把"正常并发"读成"投递坏了"。
// ============================================================================
const deliveryStore = createEventDeliveryStore({ db, clock: () => Date.now() })
/** 记账本身失败的次数。它**不**进审计、不抛错，但必须在 `/api/config` 上看得见。 */
let deliveryBookkeepingFailures = 0

/**
 * 订阅者的稳定身份。
 *
 * 一个订阅者 = 一个 `(scope, kind, clientId)` 三元组。`clientId` 由前端生成并
 * 存在 localStorage 里（与它已经存着的游标成对），**不**用连接序号——
 * 刷新页面必须仍是同一个订阅者，否则游标永远从 0 开始，整段历史每次重连都重投。
 *
 * 三项都缺失（比如 `curl` 直接连）时退化成 `anonymous:<连接序号>`：
 * 一个不声称自己是谁的连接**不该**冒用别人的游标，那会让真正的那个订阅者
 * 的游标被一次匿名连接带偏。
 */
let anonymousSeq = 0
function subscriberIdFor({ clientId, kind, scope }) {
  const k = typeof kind === 'string' && kind.trim() !== '' ? kind.trim() : 'anonymous'
  const c = typeof clientId === 'string' && clientId.trim() !== '' ? clientId.trim() : null
  if (c === null) {
    anonymousSeq += 1
    return `anonymous:${k}:${anonymousSeq}`
  }
  // scope 进 id：同一个浏览器在两个 scope 页签里是**两个订阅者**，
  // 各有自己的游标（它们的可见集合不同，合成一个会让另一边的洞把它卡住）。
  return `${k}:${scope === undefined ? '*' : scope}:${c}`
}

/** 把一个 SSE 连接登记进投递仓储。**登记失败不阻止连接**（只读面必须继续可用）。 */
function registerEventClient(client) {
  try {
    deliveryStore.registerSubscriber({ subscriberId: client.subscriberId, kind: client.kind, scope: client.scope ?? null })
  } catch {
    deliveryBookkeepingFailures += 1
  }
}

/**
 * F-05 前半：把终态请求里带来的一次 Run 事件明细**尽力**落库。
 *
 * ## 为什么是"尽力"，以及为什么这个措辞**不等于**静默
 *
 * 明细是**复盘材料**，不是状态迁移的证据。它写失败时唯一正确的处置是
 * **让终态照常成立**并把失败如实带出来：
 *
 *   · 让它回滚终态 → 一次真实的运行结果因为一段日志没写成而作废，
 *     接着会被重试——而重试是**真的再花一次钱、再写一次外部系统**。
 *     这个方向本仓反复禁止。
 *   · 静默吞掉 → "明细写失败了"与"这次运行没有明细"长得一样，
 *     而后者是完全正常的（更老的 worker 不上报 `runEvents`）。
 *
 * 所以：**不抛错、不改判定，但把读数放进返回值**。三态分得开：
 *   · `null`  —— 这次请求**没有**带明细（老调用方 / 非终态路径），不是失败；
 *   · `{ok:false, code}` —— 带了但没写成，带具名原因；
 *   · `{ok:true, written, …}` —— 写成功。
 */
function recordRunEventsBestEffort({ attemptId, context, leaseEpoch }) {
  const raw = context && typeof context === 'object' ? context.runEvents : null
  if (!Array.isArray(raw)) return null
  try {
    // `known` 由**仓储**按契约判定（`run-store.mjs` 的 `isKnownEventType`）。
    // 这里**不**再判一次：两处都判，就会有两份会漂移的名单，而漂移的表现是
    // "新事件被标成未知"或"未知被标成已知"——两者都不会报错。
    const events = raw.map((e) => ({ seq: e?.seq, type: e?.type, event: e?.event ?? e }))
    const r = runStore.recordRunEvents({ attemptId, events, leaseEpoch: leaseEpoch ?? null })
    return { ok: true, ...r, truncated: context.runEventsTruncated === true }
  } catch (e) {
    return {
      ok: false,
      code: 'RUN_EVENTS_NOT_RECORDED',
      error: e instanceof Error ? e.message : String(e),
      // 条数照样报出来：调用方要能判断"丢了多少"。
      offered: raw.length,
    }
  }
}

function parseEventScope(raw) {
  if (raw === null || raw === undefined) return undefined
  const scope = String(raw).trim()
  if (scope.length === 0) throw new Error('scope 不能为空')
  return scope
}

function parseSinceSeq(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  const value = String(raw)
  if (!/^\d+$/.test(value)) throw new Error('sinceSeq 必须是非负整数')
  const seq = Number(value)
  if (!Number.isSafeInteger(seq)) throw new Error('sinceSeq 超出安全整数范围')
  return seq
}

/** audit 行 → 对外事件对象（REST /api/activity 与 SSE /api/events 共用，P2-3 统一信封）：
 *  既有平铺字段（seq/ts/member/scope/action/taskId/goalId/detail）保持不变，
 *  补 event(=action)/id(=seq)/payload(=detail) 兼容目标信封字段名（契约 CONTRACT-V1V2.md §6.3）。 */
function auditEvent(r) {
  const seq = r.seq
  const ts = r.ts
  const scope = r.scope
  const action = r.action
  const taskId = r.taskId
  const goalId = r.goalId ?? null
  const detail = parseJson(r.detail, {})
  return { seq, ts, scope, event: action, action, taskId, member: r.member, goalId, id: seq, payload: detail, detail }
}

/**
 * 推一条完整 SSE data 帧：id: 行（seq，供 EventSource Last-Event-ID 断线续传）+ data JSON。
 *
 * 返回值是**这次写有没有被接受**——`res.write` 返回 `false` 表示内核缓冲区已满
 * （背压），那不是失败但也**不是"已经发出去了"**；`res.destroyed` / 抛错才是失败。
 * 调用方按这个布尔决定记 `delivered` 还是 `failed`。
 *
 * 改动前这个函数的返回值被整个丢掉，于是**浏览器已经走了、连接被 RST、
 * 缓冲区撑爆……一律表现为"发过了"**。
 */
function writeEventFrame(res, entry) {
  try {
    if (res.destroyed === true || res.writableEnded === true) return { ok: false, reason: 'socket-closed' }
    res.write(`id: ${entry.seq}\n`)
    const accepted = res.write(`data: ${JSON.stringify(entry)}\n\n`)
    // `accepted === false` 只是背压，字节已经进了内核缓冲 —— 记成**成功**但把
    // 背压信号带出去，让调用方能在诊断页看到"这个订阅者在被推着走"。
    return { ok: true, backpressure: accepted === false }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 广播一条审计事件，并**为每个订阅者落一行投递状态**。
 *
 * 三种结局各自有出口，一个都不静默：
 *   · 不匹配该订阅者   → `suppressed` + 原因 `'scope-mismatch'`（由 `plan()` 落）；
 *   · 写了至少一个 socket → `delivered`（带 `fanout` = 真实写过的连接数）；
 *   · 一个都没写成功   → `failed` + 具体错误（`markFailed` 不推进游标，所以可重试）。
 *
 * 整段包一次 `withTx`：**一次事件一个事务**，不是每个订阅者一个。
 * 异常绝不冒泡到 `audit()`——但被数进 `deliveryBookkeepingFailures`。
 */
function broadcastAudit(entry) {
  if (eventClients.size === 0) return
  // 按订阅者分组：同一订阅者可能有多个活连接（多个标签页）。
  const bySubscriber = new Map()
  for (const client of eventClients) {
    const s = bySubscriber.get(client.subscriberId)
    if (s === undefined) bySubscriber.set(client.subscriberId, [client])
    else s.push(client)
  }
  const subscriberIds = [...bySubscriber.keys()]
  try {
    withTx(() => {
      // ① 落投递意图。scope 不匹配的在这里变成 `suppressed` + 原因。
      for (const sid of subscriberIds) {
        const client = bySubscriber.get(sid)[0]
        deliveryStore.plan({
          subscriberId: sid,
          events: [{ seq: entry.seq, scope: entry.scope ?? null, event: entry.event }],
        })
        void client
      }
      // ② 取走（CAS）。抢不到的那一个**不是失败** —— 另一个投递者正在做同一件事。
      for (const sid of subscriberIds) {
        const taken = deliveryStore.takeUp({ subscriberId: sid, seqs: [entry.seq] })
        if (taken.claimed.length === 0) {
          // 已经被别的路径投过了，或者这一行是 suppressed（终态）。
          continue
        }
        // ③ 真的写。
        let fanout = 0
        let lastError = null
        for (const client of bySubscriber.get(sid)) {
          const r = writeEventFrame(client.res, entry)
          if (r.ok === true) fanout += 1
          else lastError = r.reason
        }
        if (fanout > 0) {
          deliveryStore.markDelivered({ subscriberId: sid, seqs: [entry.seq], fanout })
        } else {
          deliveryStore.markFailed({
            subscriberId: sid,
            seqs: [entry.seq],
            error: lastError ?? '所有连接都写失败（没有可用的 socket）',
          })
        }
      }
    })
  } catch {
    // 记账失败**不许**影响审计与分析。数出来，让它在 `/api/config` 上可见。
    deliveryBookkeepingFailures += 1
  }
}

// ── HTTP ──
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      try { resolve(raw.length === 0 ? {} : JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * token 三种携带方式（与 v1 scrum/serve.mjs 对齐）：
 *   Authorization: Bearer <t> / x-dsh-token: <t> / ?token=<t>。
 * ?token= 供浏览器 EventSource 等无法自定 header 的读面订阅使用（token 未配置时恒放行）。
 */
function authorized(req) {
  if (TOKEN === '') return true
  const header = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const custom = req.headers['x-dsh-token'] ?? ''
  let query = ''
  try { query = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '' } catch { /* 保持空 */ }
  return header === TOKEN || custom === TOKEN || query === TOKEN
}

function requireMember(body) {
  const by = body.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  return by.trim()
}

/** 读原始请求体（S3 上传用，PUT raw body）：超出 cap 字节 → reject（TOO_LARGE）；未超返回 Buffer。 */
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(cl) && cl > cap) {
      reject(Object.assign(new Error('附件超大小'), { statusCode: 413 }))
      return
    }
    const chunks = []
    let total = 0
    let finished = false
    req.on('data', (d) => {
      if (finished) return
      total += d.length
      if (total > cap) {
        finished = true
        req.removeAllListeners('data')
        req.resume()
        reject(Object.assign(new Error('附件超大小'), { statusCode: 413 }))
        return
      }
      chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) => reject(e))
  })
}

function readScope(body) {
  return typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : 'default'
}

/** 运行面必填字符串参数。缺参数要报出**参数名**，否则 worker 只看到「400」。 */
function requireString(body, field) {
  const v = body?.[field]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw Object.assign(new Error(`缺少参数 ${field}`), { code: 'MISSING_PARAM', statusCode: 400 })
  }
  return v.trim()
}

/**
 * 可选的整数查询参数。**读不出来时返回 `null`，而不是 0**。
 *
 * 为什么必须分开：时间窗与上限这类参数的 `0` 是一个**合法且极端**的取值
 * （`sinceMs=0` 是"从纪元开始"，`limit=0` 是"一条都不要"）。
 * 把 `?sinceMs=abc` 或缺失都折叠成 `0`，会让"我没传这个参数"
 * 变成"我要看全部历史"——而那是一次可能扫全表的查询。
 *
 * 非法值同样返回 `null`（=不设限），理由与仓库里其它读入口一致：
 * 一个拼错的参数名不该让请求失败，但更不该被当成一个**别的**取值。
 */
function optionalIntParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

async function handleWrite(req, res, run) {
  try {
    if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
    const body = await readBody(req)
    const by = requireMember(body)
    const scope = readScope(body)
    const result = await run(body, by, scope)
    json(res, 200, { ok: true, task: result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = Number(e?.statusCode) || (message.includes('乐观锁') ? 409 : 400)
    if (e?.permission) { json(res, status, { error: message, requestId: e.permission.requestId, permission: e.permission }); return }
    // 结构化字段**只在存在时**附加：不改变其它路由的响应形状，
    // 但让"能落到具体输入框上的错误"可以一路走到前端。
    // 逐个字段判断而不是展开 e，避免把 stack / 内部字段带出去。
    const extra = {}
    if (typeof e?.code === 'string') extra.code = e.code
    if (typeof e?.field === 'string') extra.field = e.field
    if (typeof e?.hint === 'string') extra.hint = e.hint
    if (Array.isArray(e?.candidates)) extra.candidates = e.candidates
    if (Array.isArray(e?.errors)) extra.errors = e.errors
    json(res, status, Object.keys(extra).length > 0 ? { error: message, ...extra } : { error: message })
  }
}

// ── R-3 内容通道（S3）：任务登记产物的只读文件内容服务 ──────────────────────────────
// 只读「任务记录里的登记路径」+ 白名单解析（worktree 目录优先、主仓库根兜底、realpath 防逃逸）；
// 存量绝对路径记录读取期剥前缀兼容（K10，不跑迁移脚本）；超 512KB 截断、二进制/NUL 降级 previewable=false；
// 错误码可区分：400（参数/无登记/i 越界/非 file）、403（路径越权/逃逸）、404（任务/文件不存在）。
const ARTIFACT_CONTENT_LIMIT = 512 * 1024

/** 反斜杠统一为 /（纯字符级替换，避免正则转义）。 */
function toPosix(p) {
  return String(p).split(String.fromCharCode(92)).join('/')
}

/** 防逃逸白名单解析：把「登记路径记录」安全化成 root 下的可读绝对路径。
 *  返回 { rel, source: 'worktree'|'main', abs } | { unsafe: true }（403 语义）| null（文件不存在 = 404 语义）。
 *  记录可以是仓库相对路径（docs/x.md，S2 契约登记）或存量绝对路径（K10：命中 .legion-worktrees/<taskId>/ 或绑定根前缀剥掉）。 */
export function resolveArtifactReadTarget(taskId, recordPath, root) {
  const norm = toPosix(recordPath).trim()
  if (norm.length === 0) return null
  const rootAbs = toPosix(resolve(root)).replace(/\/+$/g, '')
  const taskSeg = '.legion-worktrees/' + taskId
  let rel = norm
  // 存量绝对路径（K10 读取期兼容，不迁移）：按前缀剥成相对；根外（含其他任务 worktree）一律拒读。
  if (/^[A-Za-z]:/.test(norm) || norm.startsWith('/') || norm.startsWith('./') || norm.startsWith('../')) {
    const wtTask = rootAbs + '/.legion-worktrees/' + taskId
    if (norm === wtTask || norm === rootAbs) return null
    if (norm.startsWith(wtTask + '/')) rel = taskSeg + norm.slice(wtTask.length)
    else if (norm.startsWith(rootAbs + '/')) rel = norm.slice(rootAbs.length + 1)
    else return { unsafe: true }
  }
  if (rel.startsWith('./')) rel = rel.slice(2)
  // 段级安全：任一层拒绝 .. / .git / 盘符；.legion-worktrees 首段必须是本任务 id（他人工作树不可越读）。
  const segs = rel.split('/')
  for (let k = 0; k < segs.length; k += 1) {
    const s = segs[k]
    if (s === '..' || s === '' || s.toLowerCase() === '.git' || /^[A-Za-z]:/.test(s)) return { unsafe: true }
  }
  if (segs[0] === '.legion-worktrees' && (segs[1] ?? '') !== taskId) return { unsafe: true }
  rel = segs.join('/')
  // 候选顺序：登记于本任务 worktree 分支态目录的文件优先（K5-A worktree 优先/主仓兜底），主仓库根兜底。
  let wtAbs = null
  let mainRel = rel
  if (rel.startsWith(taskSeg + '/')) {
    wtAbs = join(root, rel)
    mainRel = rel.slice(taskSeg.length + 1)
  } else {
    wtAbs = join(root, '.legion-worktrees', taskId, rel)
  }
  const mainAbs = join(root, mainRel)
  let abs = null
  let source = 'main'
  if (existsSafe(wtAbs)) { abs = wtAbs; source = 'worktree' }
  else if (existsSafe(mainAbs)) { abs = mainAbs; source = 'main' }
  else return null
  // realpath 复检：文件真实路径必须落在 root 真实路径内（防仓库内符号链接指向根外 → 403）。
  try {
    const realAbs = toPosix(realpathSync(abs))
    const realRoot = toPosix(realpathSync(resolve(root)))
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + '/')) return { unsafe: true }
  } catch {
    return null // 文件/root 不存在
  }
  return { rel: mainRel, source, abs }
}

function existsSafe(p) {
  try { return existsSync(p) } catch { return false }
}

/** 任务所属空间绑定的本地目录；未绑定/缺失 → hub 同仓根兜底（默认部署 local_dir=仓库根时二者等价）。 */
function boundLocalDirFor(scopeId) {
  try {
    const row = db.prepare('SELECT local_dir FROM spaces WHERE id = ?').get(scopeId ?? '')
    if (row && typeof row.local_dir === 'string' && row.local_dir.trim().length > 0) return row.local_dir.trim()
  } catch { /* 表/查询异常按兜底处理 */ }
  return ROOT
}

/** 读端点核心（纯函数便于单测）：给定 task + 登记序号 i，返回 {status, body}。 */
export function artifactContent(taskId, rawI) {
  if (typeof taskId !== 'string' || taskId.trim().length === 0) return { status: 400, body: { error: '缺少参数 task' } }
  let t
  try { t = getTask(taskId) } catch (e) { return { status: 404, body: { error: e instanceof Error ? e.message : String(e) } } }
  const list = Array.isArray(t.artifacts) ? t.artifacts : []
  if (list.length === 0) return { status: 400, body: { error: '任务 ' + taskId + ' 无登记产物' } }
  let i = rawI === undefined || rawI === null || rawI === '' ? list.length - 1 : Number(rawI)
  if (!Number.isFinite(i)) i = list.length - 1 // 非法 i 也按缺省取最新（兼容 v1 语义）
  i = Math.trunc(i)
  if (i < 0 || i >= list.length) return { status: 400, body: { error: '产物序号越界：i=' + rawI + '（共 ' + list.length + ' 条）' } }
  const a = list[i]
  if (a.kind !== 'file') return { status: 400, body: { error: '产物 ' + i + ' 非 file 类型（' + a.kind + '），无文件内容' } }
  const root = boundLocalDirFor(t.scope)
  const target = resolveArtifactReadTarget(taskId, a.path, root)
  if (target && target.unsafe) return { status: 403, body: { error: '产物路径不在允许读取范围内：' + a.path } }
  if (!target) return { status: 404, body: { error: '产物文件不存在：' + a.path } }
  let buf
  try { buf = readFileSync(target.abs) } catch { return { status: 404, body: { error: '产物文件不存在：' + a.path } } }
  const size = buf.length
  let previewable = true
  let truncated = false
  if (buf.includes(0)) previewable = false
  if (previewable) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { previewable = false }
  }
  let content = ''
  if (previewable) {
    truncated = size > ARTIFACT_CONTENT_LIMIT
    content = buf.subarray(0, Math.min(size, ARTIFACT_CONTENT_LIMIT)).toString('utf8')
  }
  const ext = extname(target.rel).toLowerCase()
  const mime = ext === '.md' || ext === '.markdown' ? 'text/markdown' : ext === '.txt' ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  const body = {
    taskId: taskId, i: i, path: a.path, relPath: target.rel, source: target.source,
    size: size, limit: ARTIFACT_CONTENT_LIMIT, truncated: truncated, previewable: previewable, mime: mime, content: content,
  }
  return { status: 200, body }
}

async function handle(req, res, stripPrefix) {
  const url = new URL(req.url ?? '/', 'http://x')
  let path = url.pathname
  // P1-1 宿主集成：DSH webServer 把前缀路由（如 /team-hub）下所有请求交给本 handle，
  // stripPrefix 非空时先把前缀裁掉，使 handle 与独立进程（无前缀）共享同一套路由表。
  if (typeof stripPrefix === 'string' && stripPrefix.length > 1) {
    if (path === stripPrefix) path = '/'
    else if (path.startsWith(`${stripPrefix}/`)) path = path.slice(stripPrefix.length)
  }
  res.setHeader('access-control-allow-origin', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-dsh-token, content-length' })
    res.end()
    return
  }

  try {
    // P2-2 读面鉴权门禁：远程监听（非回环）+ 已配 token 时，除能力发现 /api/config 与 OPTIONS
    // 预检外的全部端点（读/SSE/写）都必须带 token。写路径本就在 handleWrite/上传端自我校验，
    // 此门禁统一覆盖读端点与 SSE；未知路径在远程门禁下同样 401（不泄露端点存在性）。
    if (readAuthRequired() && path !== '/api/config' && !authorized(req)) {
      json(res, 401, { error: '未授权：Bearer token 无效' })
      return
    }
    // 写接口
    if (req.method === 'POST' && path === '/api/create') {
      await handleWrite(req, res, (body, by, scope) => {
        const title = body.title
        if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
        const task = createTask({
          title: title.trim(), description: body.description, acceptance: body.acceptance, boundary: body.boundary,
          priority: body.priority, status: body.status, parent: body.parent, role: body.role,
          scope, ordersVersion: body.ordersVersion,
          blockedBy: body.blockedBy, slice: body.slice, sliceIdx: body.sliceIdx, fixOf: body.fixOf, fixCount: body.fixCount,
          goalId: body.goalId, fileDomain: body.fileDomain, docSync: body.docSync === true,
        })
        audit(by, scope, 'create', task.id, { title: task.title }, task.goalId)
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/progress') {
      // 守护进度心跳（v1 遗留缺口补平，见 docs/P0-CONFIRMATION.md §5）：租约保鲜 + 遥测。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const t = getTask(id)
        if (t.status !== 'in_progress') throw new Error(`仅 in_progress 任务可上报进度（当前 ${t.status}）`)
        db.prepare('UPDATE tasks SET claimedAt=?, updatedAt=?, version=version+1 WHERE id=?').run(now(), now(), id)
        audit(by, t.scope, 'progress', id, { percent: Number.isFinite(Number(body.percent)) ? Number(body.percent) : 0 }, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/patch') {
      // hub 版 diff 登记（v1 taskctl patch 的等价物）：守护 recordPatch 在 hub 模式下调用。
      // L1 审计：files 支持结构化数组 [{path,status,add,del}]（守护 numstat 解析）；兼容旧 string。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const t = getTask(id)
        const diff = typeof body.diff === 'string' ? body.diff : ''
        if (diff.length > 200000) throw new Error('diff 过大（>200KB），拒绝登记')
        let files
        if (Array.isArray(body.files)) {
          files = body.files.slice(0, 200).map(f => {
            const path = typeof f?.path === 'string' ? f.path.slice(0, 500) : ''
            if (!path) return null
            const status = typeof f.status === 'string' && /^[AMDRCUX]$/.test(f.status) ? f.status : 'M'
            const add = Number.isFinite(Number(f.add)) ? Math.max(0, Number(f.add)) : 0
            const del = Number.isFinite(Number(f.del)) ? Math.max(0, Number(f.del)) : 0
            return { path, status, add, del }
          }).filter(Boolean)
        } else {
          files = (typeof body.files === 'string' ? body.files.slice(0, 2000) : '')
            .split(',').map(s => s.trim()).filter(Boolean)
            .map(path => ({ path, status: 'M', add: 0, del: 0 }))
        }
        const list = parseJson(t.patches ?? '[]', [])
        list.push({ by, at: now(), summary: typeof body.summary === 'string' ? body.summary.slice(0, 200) : '', files, diff })
        if (list.length > 40) list.splice(0, list.length - 40)
        db.prepare('UPDATE tasks SET patches=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(list), now(), id)
        audit(by, t.scope, 'patch', id, { files: files.map(f => f.path).join(',') }, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/review-notes') {
      // L2 审计批注：任务（或任务内某文件）的 OK/问题 标记。file='*' = 整体结论；verdict=clear 清除。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const t = getTask(id)
        if (!t) throw new Error(`未知任务 ${id}`)
        const file = typeof body.file === 'string' && body.file.trim() ? body.file.trim().slice(0, 500) : '*'
        const verdict = body.verdict
        if (verdict !== 'ok' && verdict !== 'issue' && verdict !== 'clear') throw new Error('verdict 必须是 ok|issue|clear')
        if (typeof body.note !== 'string') throw new Error('缺少参数 note')
        const note = body.note.trim().slice(0, 2000)
        const list = parseJson(t.review_notes ?? '[]', [])
        const others = list.filter(x => x.file !== file)
        if (verdict !== 'clear') others.push({ file, verdict, note, by, at: now() })
        db.prepare('UPDATE tasks SET review_notes=?, version=version+1, updatedAt=? WHERE id=?')
          .run(JSON.stringify(others), now(), id)
        audit(by, t.scope, 'review-note', id, { file, verdict, note: note.slice(0, 200) }, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/artifact') {
      // hub 版产物登记（html/file/url），与 v1 taskctl artifact 等价。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const t = getTask(id)
        const kind = body.kind
        const path = body.path
        if (typeof kind !== 'string' || (kind !== 'html' && kind !== 'file' && kind !== 'url')) throw new Error('kind 必须是 html|file|url')
        if (typeof path !== 'string' || path.length === 0) throw new Error('缺少产物路径 path')
        const list = parseJson(t.artifacts ?? '[]', [])
        const entry = { by, at: now(), kind, path, title: typeof body.title === 'string' ? body.title.slice(0, 120) : '' }
        // S2 契约登记幂等：守护登记时带内容 sha256 digest，服务端原样落库（v1 无 digest → 读取期缺省不比对）。
        if (typeof body.digest === 'string' && /^[0-9a-f]{16,}$/.test(body.digest)) entry.digest = body.digest
        list.push(entry)
        db.prepare('UPDATE tasks SET artifacts=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(list), now(), id)
        audit(by, t.scope, 'artifact', id, { kind, path, digest: entry.digest ? 1 : 0 }, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/test-report') {
      // tester worker 结构化报告（D7' 机器闸门的输入，见 docs/ORCHESTRATION-V3.md §4/§10）：仅 tester 任务可写。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const t = getTask(id)
        if (t.role !== 'tester') throw new Error(`test-report 仅 tester 任务可写（role=${t.role}）`)
        if (t.status !== 'in_progress' && t.status !== 'in_review') throw new Error(`仅 in_progress/in_review 可写报告（当前 ${t.status}）`)
        const passed = body.passed === true
        const failures = Array.isArray(body.failures)
          ? body.failures.map(f => (f && typeof f === 'object')
              ? { name: String(f.name ?? '').slice(0, 200), log: String(f.log ?? '').slice(0, 4000), repro: String(f.repro ?? '').slice(0, 2000) }
              : { name: String(f).slice(0, 200), log: '', repro: '' }).slice(0, 200)
          : []
        if (!passed && failures.length === 0) throw new Error('passed=false 时必须给出 failures')
        const report = { passed, failures, summary: typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '', at: now(), by }
        db.prepare('UPDATE tasks SET testReport=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(report), now(), id)
        audit(by, t.scope, 'test-report', id, { passed, failures: failures.length }, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/goal/slices') {
      // 切片展开：守护在 test-designer done 后解析 TASK_BREAKDOWN.md 并注册切片（见 ORCHESTRATION-V3）。
      await handleWrite(req, res, (body, by, scope) => {
        const testDesignerTaskId = body.testDesignerTaskId
        if (typeof testDesignerTaskId !== 'string' || testDesignerTaskId.length === 0) throw new Error('缺少参数 testDesignerTaskId')
        return expandGoalSlices({ testDesignerTaskId, slices: body.slices, by })
      })
      return
    }
    // ── 运行面（PRT-302/303/313）：带权威时间与 leaseEpoch 的领取/续租/提交/放弃 ──
    // 与上面 /api/claim 等**看板**写操作并存而不是替换：看板操作的主体是人（成员 `by`），
    // 运行操作的主体是 worker。两者的失败语义不同——看板冲突要提示用户重试，
    // 运行面的 epoch 冲突要求 worker **停手**，因此不能共用一条路径。
    if (req.method === 'POST' && path === '/api/runtime/claim') {
      await handleRun(req, res, (body) => runStore.claim({
        workerId: body.workerId,
        scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
        leaseTtlMs: body.leaseTtlMs ?? null,
        nowMs: body.nowMs ?? null,
      }))
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/heartbeat') {
      await handleRun(req, res, (body) => runStore.heartbeat({
        attemptId: requireString(body, 'attemptId'),
        leaseEpoch: body.leaseEpoch,
        workerId: body.workerId,
        leaseTtlMs: body.leaseTtlMs ?? null,
        nowMs: body.nowMs ?? null,
      }))
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/transition') {
      await handleRun(req, res, (body) => {
        const attemptId = requireString(body, 'attemptId')
        // F-05 前半：终态迁移与事件明细**同一个请求**。
        //
        // ★ 顺序是**明细先写、迁移后做**，这个顺序是实质的：
        //   明细带 `leaseEpoch`，而迁移会把 epoch 推进（终态之后这条租约就不再有效）。
        //   反过来写在失败路径上是**必然**的：`failAndRetry` 会推进 epoch，
        //   于是"用同一个 epoch 写明细"会被 epoch 闸门拒掉——
        //   而那个拒绝看起来像"明细功能坏了"，实际是"探针/顺序错了"。
        //
        //   明细属于**这次运行**，所以它必须用**这次运行**的 epoch 去写。
        //
        // 它**不**参与迁移判定：明细写失败不该让一次已经成功的终态回滚——
        // 那会把"复盘材料缺了一点"升级成"这次运行的结果不成立"，
        // 接着会被重试（真的再花一次钱）。方向是反的。
        // 但失败**要被看见**：读数放进返回值。
        const evOutcome = recordRunEventsBestEffort({ attemptId, context: body.context, leaseEpoch: body.leaseEpoch })
        const r = runStore.transition({
          attemptId,
          leaseEpoch: body.leaseEpoch,
          workerId: body.workerId,
          to: body.to ?? null,
          outcome: body.outcome ?? null,
          context: body.context ?? {},
          reason: body.reason ?? null,
          nowMs: body.nowMs ?? null,
        })
        // 状态迁移后可能收尾目标链（与看板 /api/transition 的行为对齐，
        // 否则运行面完成的任务与看板完成的任务对目标的结算不一致）
        try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
        // ★ 键**恒在**（没带明细时是 `null`）：`undefined` 在 JSON 里会被丢掉，
        //   于是"这次请求没带明细"与"这个字段还没上线"在响应上长得一样。
        return { ...r, runEvents: evOutcome }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/release') {
      await handleRun(req, res, (body) => runStore.release({
        attemptId: requireString(body, 'attemptId'),
        leaseEpoch: body.leaseEpoch,
        workerId: body.workerId,
        reason: body.reason ?? 'released',
      }))
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/recover') {
      await handleRun(req, res, (body) => {
        // 「哪些状态已越过外部写边界」必须由调用方给。给不出就拒绝回收——
        // 猜错的方向是「把一个可能已经付过费的任务重跑一遍」。
        const from = body.externalEffectPossibleStates
        if (!Array.isArray(from) || from.length === 0) {
          throw Object.assign(new Error(
            '缺少 externalEffectPossibleStates（已越过外部写边界的尝试状态数组）。' +
            '这一条不能猜：判成「可重试」会在已发生外部副作用时重复执行，' +
            '判成「未知」会让本可自动恢复的任务挂起'),
          { code: 'EXTERNAL_EFFECT_UNKNOWN', statusCode: 400 })
        }
        const set = new Set(from)
        const r = runStore.recoverExpired({
          externalEffectPossible: (attempt) => set.has(attempt.state),
          scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
          limit: Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 500) : 50,
        })
        return { ...r, externalEffectPossibleStates: [...set] }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/status') {
      json(res, 200, { ok: true, ...runStore.stats() })
      return
    }
    // ── 运行面（PRT-309/310/311）：失败结算、等人工清单、人工处置 ──
    if (req.method === 'POST' && path === '/api/runtime/fail') {
      // worker 报告失败的**唯一**入口。为什么不让 worker 自己发
      // `transition({to:'RetryableFailure'})` 再另外排重试：分成两步时，
      // 漏掉第二步的后果是任务永远停在 RetryableFailure——它既没有可领的队列，
      // 也不在等人工列表里，从任何界面看都只是"失败了"，而没有人会去处理它。
      await handleRun(req, res, (body) => {
        const attemptId = requireString(body, 'attemptId')
        // F-05 前半：**失败路径的明细最要紧**——"它在炸之前做了什么"。
        //
        // ★ 必须先于 `failAndRetry` 写：那一步会推进 `lease_epoch`，
        //   而明细用**这次运行**的 epoch 写。反过来写会被 epoch 闸门拒掉，
        //   而那个拒绝看起来像"明细功能坏了"。
        //
        // 明细放在 body 顶层（不是 `context` 里）：`fail` 与 `transition`
        // 的 body 形状本就不同，让两处共用一个嵌套键只会诱使下一个调用方去猜。
        const evOutcome = recordRunEventsBestEffort({
          attemptId,
          context: { runEvents: body.runEvents, runEventsTruncated: body.runEventsTruncated },
          leaseEpoch: body.leaseEpoch ?? null,
        })
        const r = runStore.failAndRetry({
          attemptId,
          leaseEpoch: body.leaseEpoch ?? null,
          actor: requireString(body, 'workerId'),
          failureCode: body.failureCode ?? null,
          detail: body.detail ?? null,
          reason: body.reason ?? 'failure-reported',
          // `Running → RetryableFailure` 声明了 `requiresPersist: ['attempt','runResult']`。
          // 引擎**抛错**时调用方手里没有结果（`executor.mjs` 的 catch 路径），
          // 那就只能由仓储从失败事实合成一行；引擎若正常返回了失败终态，
          // 调用方可以把 `result` 一起带上，那一行就是**真凭据**。
          // 两种来源在库里分得开（`run_results.source`）。
          runResult: body.runResult ?? null,
          nowMs: body.nowMs ?? null,
        })
        try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
        // 与 `transition` 同形：键恒在。
        return { ...r, runEvents: evOutcome }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/held') {
      // 「等人工处置」清单：UnknownOutcome（结果不可确认）与 DeadLetter（额度耗尽）。
      // 这两类必须能从界面上看到并逐个结掉，否则状态机保证的"不会静默重跑"
      // 会变成"静默消失"——队列看起来只是没有任务。
      const scope = url.searchParams.get('scope')
      const limitRaw = url.searchParams.get('limit')
      json(res, 200, runStore.listHeld({
        scope: scope !== null && scope.length > 0 ? scope : null,
        limit: limitRaw === null ? 100 : Number(limitRaw),
      }))
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/resolve') {
      // 人工处置：对账结论是**输入**，不是可以默认的东西。
      // 四个决定各自对应一个不同的事实（已发生 / 未发生 / 放弃 / 取消），
      // 没有"默认当成没发生"这种便利入口——那正是重复付费的来源。
      await handleRun(req, res, (body) => {
        const r = runStore.resolveAttempt({
          attemptId: requireString(body, 'attemptId'),
          decision: requireString(body, 'decision'),
          actor: requireString(body, 'actor'),
          note: body.note ?? null,
          nowMs: body.nowMs ?? null,
        })
        try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
        return r
      })
      return
    }
    // ── 上下文快照（PRT-407 / PRT-409，spec §6.5）──
    //
    // 读面是重点：spec §6.5 要求「还原其实际输入、来源版本、过滤和裁剪原因」，
    // 而这句话只有在**存下来并能读回来**之后才有意义。
    if (req.method === 'GET' && path === '/api/context-snapshots') {
      const runId = url.searchParams.get('runId')
      const scope = url.searchParams.get('scope')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
      const items = contextStore().list({ runId, scope, limit })
      json(res, 200, { ok: true, snapshots: items, count: contextStore().count(), serverTimeMs: Date.now() })
      return
    }
    // ── 快照保留策略：**先看计划，再决定清不清**（PRT-409 收尾，spec line 748） ──
    //
    // 这条是**只读**的：它算一份计划，什么都不删。
    // 把"看计划"与"执行"拆成两条路由，是因为清理证据是不可撤回的，
    // 而一个"调用即删除"的接口没有让人反悔的地方。
    if (req.method === 'GET' && path === '/api/context-snapshots/retention') {
      const q = url.searchParams
      // 两个参数都**必须显式给**（值可以是 `null` 表示不设上限）。
      // 不给就用默认值会让"我这次想不设上限"与"我忘了传"变成同一个请求。
      const ageRaw = q.get('maxAgeDays')
      const bytesRaw = q.get('maxBytes')
      if (ageRaw === null || bytesRaw === null) {
        json(res, 400, {
          ok: false, code: 'RETENTION_POLICY_REQUIRED',
          error: '必须显式给出 maxAgeDays 与 maxBytes（不设上限写 null）：'
            + '"这次不设上限"与"我忘了传"必须能区分——后者会让一次查询悄悄变成一次全清',
          serverTimeMs: Date.now(),
        })
        return
      }
      const policy = {
        maxAgeDays: ageRaw === 'null' ? null : Number(ageRaw),
        maxBytes: bytesRaw === 'null' ? null : Number(bytesRaw),
      }
      if ((policy.maxAgeDays !== null && !(Number.isInteger(policy.maxAgeDays) && policy.maxAgeDays > 0))
        || (policy.maxBytes !== null && !(Number.isInteger(policy.maxBytes) && policy.maxBytes > 0))) {
        json(res, 400, {
          ok: false, code: 'RETENTION_POLICY_INVALID',
          error: `maxAgeDays/maxBytes 只能是正整数或 null，收到 ${JSON.stringify(policy)}`,
          serverTimeMs: Date.now(),
        })
        return
      }
      // 仍在跑的 Run 的 id 由调用方给：hub 的 **Run 状态**是 run-store 的事，
      // 快照账本不知道"谁还在跑"。这里不猜、不高估——猜错的方向是删掉活着的证据。
      const activeRunIds = q.getAll('activeRunId')
      const plan = planSnapshotRetention({
        rows: contextStore().retentionRows(), policy, nowMs: Date.now(), activeRunIds,
      })
      json(res, 200, {
        ok: true,
        // 只回计划，不回正文：预览一份计划不需要看到证据内容。
        policy,
        usage: plan.usage,
        cap: plan.cap,
        purge: plan.purge,
        findings: plan.findings,
        keepCount: plan.keep.length,
        versions: { retention: plan.version },
        serverTimeMs: Date.now(),
      })
      return
    }
    // ── 执行清理。**必须显式 `dryRun:false`**，且必须给 actor 与 reason ──
    //
    // 校验失败一律**抛**（带 statusCode + code），不是 `return {ok:false}`：
    // `handleRun` 会把回调的返回值展开成 **HTTP 200**，
    // 于是"缺 actor"会变成一次成功的响应——调用方以为清理发生了。
    if (req.method === 'POST' && path === '/api/context-snapshots/purge') {
      await handleRun(req, res, (body) => {
        const bad = (code, message) => Object.assign(new Error(message), { statusCode: 400, code })
        // `dryRun` 没有默认值。一个"没传就真的删了"的清理接口，
        // 与一个"手滑就删掉审计证据"的清理接口，是同一个东西——
        // 而 `dryRun` 默认 `true` 也好不到哪去：它会让调用方以为自己删了，
        // 于是真正该删的时候删不掉，而报错里没有一个字解释为什么。
        if (typeof body.dryRun !== 'boolean') {
          throw bad('RETENTION_DRYRUN_REQUIRED',
            '必须显式给出布尔 dryRun。不给默认值：'
            + '"没传就是预演"会让真的清理静默失效，"没传就是执行"会让一次查询删掉证据')
        }
        if (typeof body.actor !== 'string' || body.actor.trim() === '') {
          throw bad('RETENTION_ACTOR_REQUIRED', '必须给出 actor：清掉审计证据必须能定位到人')
        }
        if (typeof body.reason !== 'string' || body.reason.trim() === '') {
          throw bad('RETENTION_REASON_REQUIRED', '必须给出 reason：墓碑要能回答"以什么理由清的"')
        }
        const policy = body.policy ?? {}
        if (!Object.hasOwn(policy, 'maxAgeDays') || !Object.hasOwn(policy, 'maxBytes')) {
          throw bad('RETENTION_POLICY_REQUIRED',
            '策略必须显式给出 maxAgeDays 与 maxBytes（不设上限写 null）')
        }
        const nowMs = Number.isInteger(body.nowMs) ? body.nowMs : Date.now()
        const plan = planSnapshotRetention({
          rows: contextStore().retentionRows(),
          policy,
          nowMs,
          activeRunIds: Array.isArray(body.activeRunIds) ? body.activeRunIds : [],
        })
        if (body.dryRun === true) {
          // 预演**什么都不做**，包括不写墓碑——预演不是一次"差点发生的事故"。
          return {
            dryRun: true,
            wouldPurge: plan.purge.length,
            wouldFreeBytes: plan.usage.purgeBytes,
            purge: plan.purge,
            findings: plan.findings,
            usage: plan.usage,
            cap: plan.cap,
          }
        }
        if (plan.purge.length === 0) {
          return { dryRun: false, purged: 0, note: '没有可清理的快照', findings: plan.findings }
        }
        // 一次一个 attemptId，各自一个事务。**不做一次大事务**：
        // 中途失败时要能说清"已经清了哪几份"，而一个回滚掉的大事务
        // 会把"清了一半"与"什么都没清"变成同一个结果。
        const purged = []
        for (const e of plan.purge) {
          const r = contextStore().purge(e.attemptId, {
            reason: body.reason.trim(), actor: body.actor.trim(), nowMs,
          })
          purged.push({ attemptId: e.attemptId, bytes: e.bytes, alreadyPurged: r.alreadyPurged })
        }
        return {
          dryRun: false,
          purged: purged.length,
          freedBytes: purged.reduce((a, e) => a + e.bytes, 0),
          attempted: plan.purge.length,
          findings: plan.findings,
          counts: contextStore().counts(),
        }
      })
      return
    }
    // ── 墓碑清单（"丢过什么、谁清的、为什么"） ──
    if (req.method === 'GET' && path === '/api/context-snapshots/tombstones') {
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
      json(res, 200, {
        ok: true,
        tombstones: contextStore().listTombstones({ limit }),
        counts: contextStore().counts(),
        serverTimeMs: Date.now(),
      })
      return
    }
    // 服务端装配（PRT-407）。这条路由的存在有两层意义：
    //   ① 装配器有了**真实调用方**（此前它只有用例）；
    //   ② 装配与持久化在同一个请求里完成，于是"冻结在 Running 之前"
    //      不是一条靠人记住的约定。
    if (req.method === 'POST' && path === '/api/context-snapshots/assemble') {
      await handleRun(req, res, (body) => {
        const scope = body.scope ?? 'default'

        // **先校验配置，再看状态**：缺字段是调用方写错了请求，不是运行状态的问题。
        //
        // 这三项此前会一路走到 `assembleContext` 才炸，结果是 `code: null` 的 400——
        // 消息能读、但客户端**无从程序化判断**。而 `CONTEXT_PERMISSION_REQUIRED`
        // 那条就在这里返回了带码的 400：同一个路由上两种风格并存，
        // 调用方只能靠匹配错误文本，那是会随文案变更而碎的判据。
        for (const [key, why] of [
          ['attemptId', '快照以 attemptId 为主键——没有它无法回答"这是哪一次尝试的输入"'],
          ['runId', '快照要按 run 归档，并且密钥轮换只影响轮换后创建的 Run'],
        ]) {
          if (typeof body[key] !== 'string' || body[key].trim() === '') {
            json(res, 400, {
              ok: false, code: 'CONTEXT_BAD_REQUEST',
              error: `${key} 必须是非空字符串：${why}`,
              serverTimeMs: Date.now(),
            })
            return
          }
        }
        if (!Number.isInteger(body.frozenAtMs)) {
          json(res, 400, {
            ok: false, code: 'CONTEXT_BAD_REQUEST',
            error: 'frozenAtMs 必须是整数毫秒：冻结时刻是快照哈希的一部分，缺了它两次装配无法判定"是不是同一份"。',
            serverTimeMs: Date.now(),
          })
          return
        }

        // **权限判定必须由调用方给出，路由不替它决定。**
        // 不写就默认放行，是这一段里最危险的一种默认值：一次漏传会让
        // 越权来源静默进入上下文，而快照上看不出任何异常。
        const allowAll = body.canReadAll === true
        const allowIds = Array.isArray(body.canReadIds) ? body.canReadIds : null
        if (!allowAll && allowIds === null) {
          json(res, 400, {
            ok: false, code: 'CONTEXT_PERMISSION_REQUIRED',
            error: '必须显式给出 canReadIds（可读来源 id 列表）或 canReadAll: true。路由不替调用方决定权限——默认放行会让越权来源静默进入上下文。',
            serverTimeMs: Date.now(),
          })
          return
        }
        const allowed = new Set(allowIds ?? [])
        const canRead = (meta) => (allowAll ? true : allowed.has(meta.id))

        if (!Array.isArray(body.candidates) && body.sources === undefined) {
          json(res, 400, {
            ok: false, code: 'CONTEXT_BAD_CANDIDATE',
            error: '必须给出 candidates（现成的候选数组）或 sources（高层输入：teamPlan/employeeManifest/goal/task/comments/…）。'
              + '没有来源时给 candidates: []。',
          })
          return
        }
        if (!Array.isArray(body.candidates) && Array.isArray(body.sources)) {
          json(res, 400, {
            ok: false, code: 'CONTEXT_BAD_CANDIDATE',
            error: 'sources 是对象（各来源的输入），不是数组。数组形式请用 candidates。',
          })
          return
        }

        // 两条入口：
        //   · `sources`   —— 高层输入，由 PRT-402~406 归一成候选（系统里的东西走这条）
        //   · `candidates`—— 现成的候选（调用方自己装配，或来自别处）
        // 两条都收敛到同一个装配器，所以形状约束与账本规则不会分叉。
        let rawCandidates
        if (Array.isArray(body.candidates)) {
          rawCandidates = body.candidates
        } else {
          try {
            rawCandidates = collectCandidates({
              ...body.sources,
              // scope 以路由上的为准：调用方不该能通过 sources.scope
              // 把来源放进另一个空间——那正是"不可信内容改变作用域"的入口。
              scope: body.scope,
            })
          } catch (e) {
            if (e instanceof SourceError) {
              json(res, 400, { ok: false, code: 'CONTEXT_BAD_SOURCE', error: e.message, serverTimeMs: Date.now() })
              return
            }
            throw e
          }
        }

        // 用 `createContextSource` 构造来源：于是来源的**形状约束**
        //（默认不可信、不许带权威字段、未知字段拒绝）在这一层同样生效，
        // 而不是只在用例里生效。
        //
        // **这里必须自己接住并给具名码。** `createContextSource` 抛的是普通
        // `Error`（没有 `code`），而 `handleRun` 对没有码的异常一律发
        // `code: null` 的 400。于是这条路由上**最要紧的一次拒绝**——
        // "不可信内容想携带 `grants`" ——与"别的什么 400"在响应里长得一模一样，
        // 调用方只能去匹配错误文案，而文案会随措辞变更而碎。
        //
        // 与 `CONTEXT_PERMISSION_REQUIRED` 同一条口径：拒绝必须是**可程序化判断**的。
        // 复用 `CONTEXT_BAD_SOURCE` 而不是新造一个码，让"来源本身不合法"
        // 在这条路由上只有一个名字，不管它来自 `collectCandidates` 还是这里。
        const candidates = rawCandidates.map((c, i) => {
          if (c === null || typeof c !== 'object' || c.source === null || typeof c.source !== 'object') {
            throw Object.assign(new Error(`candidates[${i}] 必须是 { source } 形状`), { statusCode: 400, code: 'CONTEXT_BAD_CANDIDATE' })
          }
          let source
          try {
            source = createContextSource(c.source)
          } catch (e) {
            throw Object.assign(
              new Error(`candidates[${i}].source 被拒绝：${e.message}`),
              { statusCode: 400, code: 'CONTEXT_BAD_SOURCE' },
            )
          }
          return {
            source,
            scope: c.scope ?? undefined,
            required: c.required === true,
            allowTruncate: c.allowTruncate === true,
            supersededBy: c.supersededBy ?? undefined,
            // `missing`：调用方**试着取过**但产物不在。没有这条通路时，
            // "我取不到"唯一能做的事就是不提这个候选，而快照会看起来完整。
            missing: c.missing === true,
            missingReason: c.missingReason ?? undefined,
          }
        })

        // tokenizer：能按模型找到精确的就用精确的，否则**明说**是估算。
        // 注册表默认为空——本项目零依赖，拿不到任何供应商的词表。
        const tokenizer = body.model === undefined
          ? createConservativeTokenizer()
          : tokenizerForProfile({ model: body.model }, TOKENIZER_REGISTRY)

        const snapshot = assembleContext({
          attemptId: body.attemptId,
          runId: body.runId,
          frozenAtMs: body.frozenAtMs,
          associations: body.associations ?? {},
          candidates,
          policy: { scope, canRead, priority: body.priority, maxTokens: body.maxTokens ?? null },
          tokenizer,
        })
        const rec = contextStore().record(snapshot, { scope, actor: body.actor ?? null })
        return { recorded: rec, summary: describeAssembly(snapshot), snapshotHash: snapshot.snapshotHash }
      })
      return
    }
    // ── 导出一次 Attempt 的上下文快照（PRT-409 右半部分：spec line 897「导出」） ──
    //
    // ★ 导出与"读一条快照"共用**同一个** `path.startsWith('/api/context-snapshots/')`
    //   守卫，而不是各写一条。第一版是两条独立的路由，于是：
    //
    //   ① 基线快照的"同一条路由不得被写两次"检查报了
    //      `GET /api/context-snapshots/ ×2`——抽取器按**路径字面量**计数，
    //      两条守卫用了同一个字面量，于是看起来是后者遮蔽了前者；
    //   ② 真正的风险是**顺序**：如果 `/export` 那条写在通配那条**之后**，
    //      通配那条会把含 `/` 的 id 判成 400 `MISSING_PARAM`，
    //      导出路由**永远走不到**——而它看起来像"路由写好了"。
    //
    //   合并成一条守卫同时消掉这两件事：只有一条路由被声明，
    //   也就不存在"谁在前面"这个问题。这也是 `duplicate route` 那条检查
    //   真正想说的是：**同一段路径不该被判断两次。**
    if (req.method === 'GET' && path.startsWith('/api/context-snapshots/')) {
      const PREFIX = '/api/context-snapshots/'

      if (path.endsWith('/export')) {
        let exportAttemptId
        try {
          exportAttemptId = decodeURIComponent(path.slice(PREFIX.length, -'/export'.length))
        } catch {
          json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: 'attemptId 不是合法的 URL 编码' })
          return
        }
        if (exportAttemptId === '' || exportAttemptId.includes('/')) {
          json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/context-snapshots/<attemptId>/export' })
          return
        }
        // 导出人必须有名字，导出时刻必须**显式给**。
        //
        // 不拿"现在"当 exportedAtMs 的默认值：一个没写时间的导出会被读成
        // "就是刚导的"，而那是一次无法复核的猜测——而导出存在的意义正是可复核。
        const by = url.searchParams.get('by')
        const atMsRaw = url.searchParams.get('atMs')
        if (by === null || by.trim() === '') {
          json(res, 400, {
            ok: false, code: 'EXPORT_BY_REQUIRED',
            error: '缺少 by：导出必须记下**是谁导的**。一个无名的导出与一份匿名证据是同一种东西',
            serverTimeMs: Date.now(),
          })
          return
        }
        const atMs = atMsRaw === null ? NaN : Number(atMsRaw)
        if (!Number.isInteger(atMs)) {
          json(res, 400, {
            ok: false, code: 'EXPORT_AT_REQUIRED',
            error: '缺少整数毫秒 atMs：不拿"现在"当默认值——导出时间是要被复核的',
            serverTimeMs: Date.now(),
          })
          return
        }
        const rec = contextStore().get(exportAttemptId)
        if (rec === null) {
          // 404 而不是一份"空的但格式正确"的导出：后者会被下游当成有效证据。
          json(res, 404, {
            ok: false, code: 'CONTEXT_NOT_FOUND', error: `没有这份上下文快照：${exportAttemptId}`,
            serverTimeMs: Date.now(),
          })
          return
        }
        try {
          const exported = buildSnapshotExport(rec, {
            exportedBy: by,
            exportedAtMs: atMs,
            exportedReason: url.searchParams.get('reason'),
          })
          json(res, 200, {
            ok: true,
            export: exported,
            // 顺手把验证结论也带上：调用方不必自己再实现一遍哈希。
            verification: verifySnapshotExport(exported),
            serverTimeMs: Date.now(),
          })
        } catch (e) {
          if (e instanceof ContextExportError) {
            json(res, e.code === CONTEXT_EXPORT_CODES.RECORD_NOT_VERIFIED
              || e.code === CONTEXT_EXPORT_CODES.STORE_HASH_MISMATCH ? 409 : 400, {
              ok: false, code: e.code, error: e.message, serverTimeMs: Date.now(),
            })
            return
          }
          throw e
        }
        return
      }

      let attemptId
      try {
        attemptId = decodeURIComponent(path.slice(PREFIX.length))
      } catch {
        json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: 'attemptId 不是合法的 URL 编码' })
        return
      }
      if (attemptId === '' || attemptId.includes('/')) {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/context-snapshots/<attemptId>' })
        return
      }
      const found = contextStore().get(attemptId)
      if (found === null) {
        // ★ 三种状态，不是两种。
        //
        //   `get()` 的 `null` 把两件完全不同的事压成了同一个：
        //   "从来没存在过"与"被保留策略清掉了"。
        //
        //     > 一份"被策略清掉"的快照，与一份"从来没有过"的快照，
        //     > 在只看 `get()` 的代码里是同一个 `null`——
        //     > 只不过前者意味着"这次的输入我们已经丢掉了"，
        //     > 而后者意味着"你查错了 id"。
        //
        //   对一个以"可还原"为卖点的产品，这两件事的差别就是全部意义。
        //   所以这里给 **410 Gone**（它曾经在，现在不在了）而不是 404，
        //   并把墓碑一并返回——审计要说得出"丢了什么、谁清的、为什么"。
        const spot = contextStore().locate(attemptId)
        if (spot.kind === 'purged') {
          json(res, 410, {
            ok: false,
            code: 'CONTEXT_SNAPSHOT_PURGED',
            error: `快照 ${attemptId} 存在过，已被保留策略清理（${spot.tombstone.reason}）——`
              + '正文没有了，但这次运行确实发生过',
            tombstone: spot.tombstone,
            serverTimeMs: Date.now(),
          })
          return
        }
        json(res, 404, { ok: false, code: 'CONTEXT_NOT_FOUND', error: `没有这份上下文快照：${attemptId}` })
        return
      }
      // `?verify=1`：读回时**再验一次哈希**。库里的记录可能被外部改过，
      // 而一份被改过的记录会让往后每一次"还原"都建立在假前提上。
      const withVerify = url.searchParams.get('verify') === '1'
      json(res, 200, {
        ok: true,
        ...found,
        ...(withVerify ? { verification: contextStore().verify(attemptId) } : {}),
        serverTimeMs: Date.now(),
      })
      return
    }
    // ── PRT-402：TeamPlan 与 EmployeeManifest 的读面 ────────────────────────
    //
    // 这两条来源在 `runtime/context/sources.mjs` 里都是 `required: true`，
    // 而 hub 一直没有读端点，于是 `sources-loader.mjs` 只能传 `null`——
    // **每次运行**都产出两条 `missing` 候选。那两条不是"世界就是这样"，
    // 是"产品的这一块还没做"；而两者在账本上长得一模一样。
    //
    //    > 一个"每次运行都缺两条必需来源"的产品，
    //    > 与一个"这次运行确实没有团队计划"的运行，在快照上长得一模一样——
    //    > 只不过前者的那两条缺失**永远**不会消失，于是没有人会去看它们。
    //
    // 缺席一律 **404**（不是 200 带 null）：装配器把 404 翻成 `null`，
    // 再由 `sources.mjs` 产出一条**带原因**的 `missing` 候选。若这里回 200 + null，
    // "读到了、它是空的"与"读不到"就分不开了——而那正是整个装载器要防的事。
    if (req.method === 'GET' && path === '/api/team-plan') {
      const scope = url.searchParams.get('scope')
      if (scope === null || scope.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope：计划是挂在空间上的' })
        return
      }
      const versionRaw = url.searchParams.get('version')
      let version = null
      if (versionRaw !== null && versionRaw.trim() !== '') {
        version = Number(versionRaw)
        if (!Number.isInteger(version) || version < 1) {
          json(res, 400, { ok: false, code: 'BAD_VERSION', error: 'version 必须是 >= 1 的整数' })
          return
        }
      }
      const plan = contextPlanStore().readTeamPlan(
        url.searchParams.get('id'),
        { scope, version, goalId: url.searchParams.get('goalId') },
      )
      if (plan === null) {
        // 说清是**哪一种**缺席：没有这个 id，还是没有这个目标下的计划。
        // 两者的修复动作不同（建一份计划 vs 把目标接上计划）。
        const askId = url.searchParams.get('id')
        const askGoal = url.searchParams.get('goalId')
        json(res, 404, {
          ok: false,
          code: CONTEXT_PLAN_ERRORS.TEAM_PLAN_NOT_FOUND,
          error: askId !== null && askId.trim() !== ''
            ? `空间 ${scope} 里没有团队计划 ${askId}${version === null ? '' : ` 的第 ${version} 版`}`
            : `空间 ${scope} 里没有挂在目标 ${askGoal} 下的团队计划`,
          serverTimeMs: Date.now(),
        })
        return
      }
      json(res, 200, { ok: true, plan, serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/team-plans') {
      const scope = url.searchParams.get('scope')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
      const items = contextPlanStore().listTeamPlans({ scope, limit })
      json(res, 200, { ok: true, plans: items, count: items.length, serverTimeMs: Date.now() })
      return
    }
    // 冻结一版团队计划（PRT-402 的**写**一半）。
    //
    // 没有这条路由，读面永远返回 404，而"读面做好了"与"库里永远为空"
    // 在用户那里是同一件事（与 PRT-505 的 `store.put` 零调用方同源）。
    if (req.method === 'POST' && path === '/api/team-plans') {
      await handleRun(req, res, (body) => {
        const r = contextPlanStore().putTeamPlan(body.plan ?? body, {
          scope: body.scope, actor: body.actor ?? body.by ?? null,
        })
        return { plan: r.plan, idempotent: r.idempotent }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/employee-manifest') {
      const scope = url.searchParams.get('scope')
      if (scope === null || scope.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope：岗位边界是按空间定的' })
        return
      }
      const role = url.searchParams.get('role')
      const employeeId = url.searchParams.get('employeeId')
      if ((role === null || role.trim() === '') && (employeeId === null || employeeId.trim() === '')) {
        // 两个都不给就**不猜**：返回"任意一份清单"会让模型读到别人的边界，
        // 而它看起来完全正常。
        json(res, 400, {
          ok: false, code: 'MISSING_PARAM',
          error: '缺少 role 或 employeeId：不指定身份就取不到"我的边界"，'
            + '而随便给一份会让模型照着一个不是它的岗位约束干活',
        })
        return
      }
      const manifest = contextPlanStore().readEmployeeManifest({ scope, role, employeeId })
      if (manifest === null) {
        json(res, 404, {
          ok: false, code: CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND,
          error: `空间 ${scope} 里没有 ${role ?? employeeId} 的岗位清单`,
          serverTimeMs: Date.now(),
        })
        return
      }
      json(res, 200, { ok: true, manifest, serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/employee-manifests') {
      const scope = url.searchParams.get('scope')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw === null ? 100 : Math.min(Math.max(Number(limitRaw) || 0, 1), 500)
      const items = contextPlanStore().listEmployeeManifests({ scope, limit })
      json(res, 200, { ok: true, manifests: items, count: items.length, serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/employee-manifests') {
      await handleRun(req, res, (body) => {
        const r = contextPlanStore().putEmployeeManifest(body.manifest ?? body, {
          scope: body.scope, actor: body.actor ?? body.by ?? null,
        })
        return { manifest: r.manifest, created: r.created }
      })
      return
    }
    // ── 凭证管理（spec §6.7 的**写**一半） ──
    //
    // 在 PRT-505 / PRT-254 之前，密钥库只有**读**被接上
    // （`runtime/probe/secret-resolver.mjs`）；`store.put` / `rotate` / `remove`
    // 在整个仓库里**零生产调用方**，也没有任何路由。于是：
    //
    //   · `secretRef` 只能指向别人（手写的文件、DSH 的凭证文件）放进去的东西；
    //   · spec §6.7 要求的"新增/更新/轮换/删除写审计记录"——四个动作一个都发不出来。
    //
    //   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
    //
    // 四条纪律，逐条都能追到一次具体的失败：
    //
    // ① **响应里永远没有值。** 返回的是 `freezeMeta` 的产物（ref/purpose/
    //    scheme/时间戳），不含 blob、不含明文。错误对象由 `SecretStoreError`
    //    构造，它的上下文本身就是白名单（ref/platform/cause）——所以
    //    "顺手把密钥塞进错误里"这条路在类型层面就不成立。
    //
    // ② **打不开就 fail closed，没有降级开关。** `requireProtected: true`
    //    在 `secret-admin.mjs` 里写死。读路径上明文后端只是让人看到不该看的
    //    东西；写路径上它会**把用户的真实密钥明文落盘**。
    //
    // ③ **写成功之后必须让探测缓存失效**（§6.7）。`probe-service.mjs:39`
    //    早就写了 `invalidate()` 给"轮换/修改凭证的路径"用，而它**从来没有
    //    被调用过**——因为写路径不存在，两条线一直在互相等。不失效的后果很具体：
    //    轮换完密钥、界面点"测试连接"，拿到的还是**用旧钥匙得出的旧结论**，
    //    而它看起来完全像一次新的验证。
    //
    // ④ **每次写完都重新核验文件权限。** 写入走 `写临时文件 + rename`，
    //    而 Windows 上 `mode:0o600` 基本被忽略、新文件的 ACE 继承自目录——
    //    也就是说上一次加固出来的"仅所有者可读"会被**每一次写入**重置。
    //    详见 `team-hub/secret-admin.mjs` 的文件头。
    //
    // 路径一律用**字面量**（不用常量）：`scripts/prt/baseline-snapshot.mjs`
    // 的抽取器只认字符串字面量，用常量写会让这些路由**静默地**不进平台契约基线，
    // 而基线照样报"与已记录一致"。
    if (req.method === 'GET' && path === '/api/secrets/status') {
      await handleRun(req, res, async () => {
        const s = await secretAdmin().describe()
        // 自检形态的只读结果：**只有计数，没有引用名**。
        // 引用名能画出"这台机器配了哪些供应商"，而这个结果会被显示与记录
        // （与 `product/secrets.mjs` ④ 同一条纪律）。要列名请走 GET /api/secrets。
        return { status: s }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/secrets') {
      await handleRun(req, res, async () => {
        const r = await secretAdmin().list()
        return { secrets: r.entries, aclVerified: r.aclVerified }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/secrets') {
      await handleRun(req, res, async (body) => {
        // `ref` / `value` 的缺失与形态由密钥库自己判（`assertSecretRef` 是唯一判据）。
        // API 层不重复校验——重复的后果不是多一道防线，而是两处判据会漂移。
        const r = await secretAdmin().put({ ref: body?.ref, value: body?.value, purpose: body?.purpose })
        audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:put', null,
          { ref: r.meta?.ref ?? null, purpose: r.meta?.purpose ?? null, aclVerified: r.aclVerified })
        // 只回元数据（ref/purpose/scheme/时间戳）。**永远没有值**。
        // `aclVerified` 与 `aclNote` 必须一起给出：文件权限在每一次写入之后
        // 都会被重置再加固，而"没核验过"不能看起来像"已确认安全"。
        return {
          secret: r.meta,
          aclVerified: r.aclVerified,
          acl: r.acl,
          aclNote: r.aclNote,
        }
      })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/secrets/') && path.endsWith('/rotate')) {
      const rawRef = path.slice('/api/secrets/'.length, path.length - '/rotate'.length)
      if (rawRef === '') { json(res, 400, { ok: false, error: '缺少 secretRef', code: 'MISSING_PARAM' }); return }
      let rotateRef
      try {
        rotateRef = decodeURIComponent(rawRef)
      } catch {
        json(res, 400, { ok: false, error: 'secretRef 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
      }
      await handleRun(req, res, async (body) => {
        const r = await secretAdmin().rotate({ ref: rotateRef, value: body?.value, purpose: body?.purpose })
        audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:rotate', null,
          { ref: r.meta?.ref ?? null, purpose: r.meta?.purpose ?? null, aclVerified: r.aclVerified })
        // 只回元数据（ref/purpose/scheme/时间戳）。**永远没有值**。
        // `aclVerified` 与 `aclNote` 必须一起给出：文件权限在每一次写入之后
        // 都会被重置再加固，而"没核验过"不能看起来像"已确认安全"。
        return {
          secret: r.meta,
          aclVerified: r.aclVerified,
          acl: r.acl,
          aclNote: r.aclNote,
        }
      })
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/secrets/')) {
      const rawRef = path.slice('/api/secrets/'.length)
      if (rawRef === '') { json(res, 400, { ok: false, error: '缺少 secretRef', code: 'MISSING_PARAM' }); return }
      let delRef
      try {
        delRef = decodeURIComponent(rawRef)
      } catch {
        json(res, 400, { ok: false, error: 'secretRef 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
      }
      if (delRef.includes('/')) {
        // 多段路径不是引用名：明确拒绝，不去猜用户想要哪一个。
        json(res, 400, { ok: false, error: 'secretRef 不能包含斜杠', code: 'BAD_ID_ENCODING' }); return
      }
      await handleRun(req, res, async (body) => {
        const r = await secretAdmin().remove(delRef)
        audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:delete', null,
          { ref: delRef, removed: r.removed, aclVerified: r.aclVerified })
        return { removed: r.removed, aclVerified: r.aclVerified, acl: r.acl, aclNote: r.aclNote }
      })
      return
    }

    // ── 模型档案（PRT-501，spec §6.6） ──
    //
    // 这些路由**不接受**任何密钥字段：`validateProfile` 会拒绝未知字段与明文
    // 密钥形态（含 endpoint 内嵌凭证）。API 层不重复校验——重复的后果不是
    // 多一道防线，而是两处判据会漂移，而漂移的那一次就是把密钥写进库的那一次。
    //
    // `actor` 必填：谁改的模型配置必须留痕。审计里**只有** provider/model/
    // 字段名清单/「引用变了没有」，没有任何值——包括引用名本身。
    if (req.method === 'GET' && path === '/api/model-profiles') {
      // 默认只给未删除的。要连墓碑一起看必须显式 `?includeDeleted=1`：
      // 默认带上会让界面上出现"已经被删掉的模型"，而它其实选不了。
      const includeDeleted = url.searchParams.get('includeDeleted') === '1'
      json(res, 200, {
        ok: true,
        profiles: modelStore.list({ includeDeleted }),
        serverTimeMs: Date.now(),
      })
      return
    }
    if (req.method === 'POST' && path === '/api/model-profiles') {
      await handleRun(req, res, (body) => modelStore.create(body.profile ?? body, { actor: body.actor }))
      return
    }
    {
      // `/api/model-profiles/<id>` 的三件事（读/改/删）。
      //
      // 写成 `req.method === '…' && path.startsWith('…')` 这个**同一行**的形态，
      // 不是风格洁癖：`scripts/prt/baseline-snapshot.mjs` 的抽取规则只认这一种
      // 与 `path === '…'`。把 method 判断嵌进块里（或改用正则 exec）会让这条
      // 路由对**契约基线不可见**，于是它能不经评审地增删——平台契约里少一条，
      // 而没有任何门禁会说话。
      const MODEL_PREFIX = '/api/model-profiles/'
      // 解 id；不是合法编码时回 null，空串时回 ''
      const modelId = () => {
        try {
          return decodeURIComponent(path.slice(MODEL_PREFIX.length))
        } catch {
          return null
        }
      }
      // 测试连接（PRT-507）。**位置必须在下面那批 startsWith 之前**：
      // 否则 /api/model-profiles/p1/probe 会被当成 id = "p1/probe" 查档案，
      // 然后以一个完全指向错误方向的 404 结束。
      //
      // 路径用**字面量**而不是上面那个 MODEL_PREFIX 常量：PRT-007 的路由抽取器
      // 只认字符串字面量，用常量写会让这条路由**静默地**不进平台契约基线——
      // 基线照样报「与已记录一致」，而它少了一条真实端点。
      // （`baseline-snapshot.mjs` 现在会主动拒绝这种写法，见 findOpaqueRouteGuards。）
      if (req.method === 'POST' && path.startsWith('/api/model-profiles/') && path.endsWith('/probe')) {
        const rawId = path.slice('/api/model-profiles/'.length, path.length - '/probe'.length)
        if (rawId === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
        let probeId
        try {
          probeId = decodeURIComponent(rawId)
        } catch {
          json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
        }
        if (probeId.includes('/')) {
          // 多段路径不是 id：明确拒绝，不去猜用户想要哪一个档案。
          json(res, 400, { ok: false, error: '模型档案 id 不能包含斜杠', code: 'BAD_ID_ENCODING' }); return
        }
        await handleRun(req, res, async (body) => {
          const profile = modelStore.get(probeId)
          if (profile === null) {
            const hist = modelStore.resolveForHistory(probeId)
            if (hist !== null) {
              const err = new Error('模型档案 ' + probeId + ' 已被删除')
              err.statusCode = 409
              err.code = MODEL_ERRORS.PROFILE_DELETED
              throw err
            }
            const err = new Error('没有这个模型档案：' + probeId)
            err.statusCode = 404
            err.code = MODEL_ERRORS.PROFILE_NOT_FOUND
            throw err
          }
          // force 默认为 **true**：这是用户主动按下的按钮。
          // 按钮按下去若只回一个缓存里的旧结论，用户会以为“刚才那次点击验证了现在”。
          // 缓存的价值在于**自动**重复检查（后台巡检），不在于回应一次点击。
          const force = body.force !== false
          const requiredCapabilities = Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities : []
          const verdict = await probeService().probeModelProfile(profile, { requiredCapabilities, force })
          // 「没探测过」用 **503**：它不是客户端错误（用户没做错），也不是 200
          // （那会让前端把它当成一个判定）。503 = 现在没法提供这项服务。
          if (verdict.unavailable === true) {
            const err = new Error(verdict.message)
            err.statusCode = 503
            err.code = verdict.code
            throw err
          }
          return { probe: verdict, profileId: probeId }
        })
        return
      }
      if (req.method === 'GET' && path.startsWith('/api/model-profiles/')) {
        const id = modelId()
        if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
        if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
        const p = modelStore.get(id)
        if (p === null) {
          // 墓碑与"从没存在过"分开报：混成一个 404 会让
          // 「删掉再用同名建」看起来像一次干净的首次创建。
          const hist = modelStore.resolveForHistory(id)
          if (hist !== null) {
            json(res, 409, {
              ok: false, code: MODEL_ERRORS.PROFILE_DELETED,
              error: `模型档案 ${id} 已被删除`,
              deletedAtMs: hist.deletedAtMs, serverTimeMs: Date.now(),
            })
            return
          }
          json(res, 404, { ok: false, code: MODEL_ERRORS.PROFILE_NOT_FOUND, error: `没有这个模型档案：${id}` })
          return
        }
        json(res, 200, { ok: true, profile: p, serverTimeMs: Date.now() })
        return
      }
      if (req.method === 'PATCH' && path.startsWith('/api/model-profiles/')) {
        const id = modelId()
        if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
        if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
        await handleRun(req, res, (body) =>
          modelStore.update(id, body.profile ?? body, { actor: body.actor, version: body.version }))
        return
      }
      if (req.method === 'PUT' && path.startsWith('/api/model-profiles/')) {
        const id = modelId()
        if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
        if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
        await handleRun(req, res, (body) =>
          modelStore.update(id, body.profile ?? body, { actor: body.actor, version: body.version }))
        return
      }
      if (req.method === 'DELETE' && path.startsWith('/api/model-profiles/')) {
        const id = modelId()
        if (id === null) { json(res, 400, { ok: false, error: '模型档案 id 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return }
        if (id === '') { json(res, 400, { ok: false, error: '缺少模型档案 id', code: 'MISSING_PARAM' }); return }
        await handleRun(req, res, (body) => modelStore.remove(id, { actor: body.actor, version: body.version }))
        return
      }
    }
    // ── 岗位模型绑定与 fallback（PRT-502，spec §6.6） ──
    //
    // 键是 (scope, employee_role)：同一条流水线里编码岗与审查岗可以绑不同模型，
    // 不同空间也可以各绑各的。
    //
    // **写入时就要验主档案能解析**：等到运行时才发现 `primaryProfile` 打错了，
    // 那次运行已经认领了任务、烧掉一次尝试，而错误出现在运行日志里——
    // 不是在"保存配置"这个动作上，后者才是真正能改的地方。
    if (req.method === 'GET' && path === '/api/model-bindings') {
      const scope = url.searchParams.get('scope')
      json(res, 200, { ok: true, bindings: bindingStore.list(scope), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/model-bindings') {
      await handleRun(req, res, (body) => {
        const b = bindingStore.upsert({
          scope: body.scope,
          employeeRole: body.employeeRole,
          primaryProfile: body.primaryProfile,
          fallbackProfiles: body.fallbackProfiles ?? [],
          perRunBudget: body.perRunBudget ?? null,
        }, { actor: body.actor })
        return { binding: b }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/model-bindings/resolve') {
      // 「这个岗位现在该依次用哪些模型，为什么」。
      // 绑定不存在时 404 而不是 200 带空链：空链会被下游读成"没有可用的模型"，
      // 而真实情况是"没有绑定"——前者要人去建档案，后者要人去建绑定。
      const scope = url.searchParams.get('scope')
      const role = url.searchParams.get('role')
      // 显式验参数，**不靠异常决定状态码**：`bindingStore.resolve` 在缺 role 时
      // 会抛 ROLE_REQUIRED，而这个分支没有包在 `handleRun` 里——异常逃到外层
      // 兜底处理器就变成 500。于是"调用方少传一个参数"报成了"服务端出错"，
      // 运维会去查服务端日志，而真正要做的是补上参数。
      if (scope === null || scope.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少 scope（绑定是 (scope, role) 二元的）' })
        return
      }
      if (role === null || role.trim() === '') {
        json(res, 400, { ok: false, code: 'ROLE_REQUIRED', error: '缺少 role：没有岗位就没有"该用哪个模型"的主语' })
        return
      }
      const r = bindingStore.resolve(scope, role)
      if (r.code === BINDING_STORE_ERRORS.BINDING_NOT_FOUND) {
        json(res, 404, { ok: false, code: r.code, error: r.message, serverTimeMs: Date.now() })
        return
      }
      json(res, 200, { ok: true, resolution: r, serverTimeMs: Date.now() })
      return
    }
    // ── PRT-506：迁移老的非敏感模型配置 ──
    //
    // 计划与执行**分开**，而且执行时**服务端重新算一遍**再比对用户确认过的指纹。
    // 理由：客户端送回来的计划可能已经过期（别的窗口改了配置、上次跑过一半），
    // 而服务端自己重算又会让"用户确认的"和"实际执行的"变成两件事。
    // 所以两者必须逐字节一致才动手。
    if (req.method === 'GET' && path === '/api/model-migration/plan') {
      // runtimeType 不在查询串里时**不报 400**：这是一个只读的"报告"，
      // 而"必须选一种协议"正是报告要告诉用户的第一件事。返回 200 + 计划本身，
      // 前端才能据此渲染一个选择器，而不是先撞一个错误再猜该传什么。
      const runtimeType = (url.searchParams.get('runtimeType') ?? '').trim()
      const legacyRows = db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
      const plan = planModelMigration({
        legacyRows,
        runtimeType,
        existingProfiles: modelStore.list().map((x) => x.id),
        existingBindings: bindingStore.list(null),
      })
      // 顶层刻意**不放** `ok`：计划自己有一个 `ok`，两个 `ok` 在不同层级上
      // 是真正会读错的东西（一个说"这次查询成功了"，一个说"这份计划能不能执行"）。
      json(res, 200, { plan, summary: describeMigration(plan), legacyRowCount: legacyRows.length, serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/model-migration/apply') {
      await handleRun(req, res, async (body) => {
        const legacyRows = db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
        const plan = planModelMigration({
          legacyRows,
          runtimeType: body.runtimeType,
          existingProfiles: modelStore.list().map((x) => x.id),
          existingBindings: bindingStore.list(null),
          actor: body.actor,
        })
        if (plan.ok !== true) {
          const err = new Error(plan.message ?? '这份迁移计划不可执行')
          // 409：请求本身没问题，是**当前状态**不允许执行（比如没给协议、源里有密钥）。
          err.statusCode = 409
          err.code = plan.code
          err.plan = plan
          throw err
        }
        const result = await applyModelMigration(plan, {
          modelStore, bindingStore, actor: body.actor, expectedDigest: body.expectedDigest ?? null,
        })
        if (result.ok !== true) {
          const err = new Error(result.message ?? '迁移未完成')
          err.statusCode = 409
          err.code = result.code
          err.migration = result
          throw err
        }
        return { migration: result, plan }
      })
      return
    }
    if (path.startsWith('/api/model-bindings/')) {
      const BINDING_PREFIX = '/api/model-bindings/'
      const parts = () => {
        // `/api/model-bindings/<scope>/<role>`：两段都允许被百分号编码，
        // 各自单独解码（整段解码会把 scope 里的 `/` 也解出来，于是切错位置）。
        const raw = path.slice(BINDING_PREFIX.length)
        const segs = raw.split('/')
        if (segs.length !== 2) return null
        try {
          return [decodeURIComponent(segs[0]), decodeURIComponent(segs[1])]
        } catch {
          return 'BAD_ENCODING'
        }
      }
      if (req.method === 'GET' && path.startsWith('/api/model-bindings/')) {
        const segs = parts()
        if (segs === 'BAD_ENCODING') { json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '绑定路径不是合法的 URL 编码' }); return }
        if (segs === null) { json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/model-bindings/<scope>/<role>' }); return }
        const b = bindingStore.get(segs[0], segs[1])
        if (b === null) {
          json(res, 404, { ok: false, code: BINDING_STORE_ERRORS.BINDING_NOT_FOUND, error: `没有这个岗位绑定：${segs[0]}/${segs[1]}` })
          return
        }
        json(res, 200, { ok: true, binding: b, serverTimeMs: Date.now() })
        return
      }
      if (req.method === 'DELETE' && path.startsWith('/api/model-bindings/')) {
        const segs = parts()
        if (segs === 'BAD_ENCODING') { json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '绑定路径不是合法的 URL 编码' }); return }
        if (segs === null) { json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/model-bindings/<scope>/<role>' }); return }
        await handleRun(req, res, (body) => bindingStore.remove(segs[0], segs[1], { actor: body.actor }))
        return
      }
    }
    // ── 配置导入导出（PRT-508，spec §6.6 第 403 行「导出不包含密钥」） ──
    //
    // 三条产品纪律：
    //   ① **导出永远不含密钥，也不含 `secretRef`**（契约层强制，这里不再放宽）。
    //      导出物带 `credentialRequired` 说明"这条档案需要凭证"，但不说
    //      "从哪台机器的哪个槽位取"——后者跨机器没有意义。
    //   ② 导入是**两段式**：先 `plan`（dry run，什么都不写），再 `apply`。
    //      理由是导入会改变"哪条任务用哪个模型"，而那同时改变成本、质量与
    //      数据去了哪。一次性静默应用意味着这三件事都在无人看到的情况下变了。
    //   ③ `apply` 只做计划里 `create`/`update` 的那些；**不删除**包里没有的
    //      档案。否则一份不完整的包会清空整台机器的配置，而"不完整"是常态
    //      （比如只导出一条模型做灰度）。
    if (req.method === 'GET' && path === '/api/config-bundle') {
      const kind = url.searchParams.get('kind') ?? 'full'
      try {
        // `modelStore.list()` 给的是 descriptor（含 `hasCredential`，**不含**
        // `secretRef`）——正好是导出需要的形态：凭证"要不要"是档案的属性，
        // "从哪取"是本机的属性。`hasCredential` 转成 `credentialRequired`。
        const profiles = kind === 'model-bindings' ? [] : modelStore.list().map((d) => ({
          id: d.id,
          displayName: d.displayName,
          runtimeType: d.runtimeType,
          provider: d.provider,
          model: d.model,
          endpoint: d.endpoint,
          reasoningEffort: d.reasoningEffort,
          limits: d.limits,
          credentialRequired: d.hasCredential === true,
        }))
        const bindings = kind === 'model-profiles' ? [] : bindingStore.list()
        const bundle = buildBundle({
          profiles,
          bindings,
          kind,
          exportedAtMs: Date.now(),
          exportedBy: url.searchParams.get('actor'),
          note: url.searchParams.get('note'),
        })
        json(res, 200, { ok: true, bundle })
      } catch (e) {
        // 出口门禁触发（配置里混进了密钥形态的东西）。这不是"服务端出错"，
        // 而是**配置本身有问题**，所以要 400 + 一个能让人找到那条档案的码。
        if (e instanceof BundleError) {
          json(res, 400, { ok: false, code: e.code, error: e.message, hits: e.hits ?? null, serverTimeMs: Date.now() })
          return
        }
        throw e
      }
      return
    }
    if (req.method === 'POST' && path === '/api/config-bundle/plan') {
      await handleRun(req, res, (body) => {
        const plan = planImport({
          bundle: body.bundle,
          existingProfiles: modelStore.list(),
          existingBindings: bindingStore.list(),
          conflictPolicy: body.conflictPolicy ?? 'fail',
          actor: body.actor ?? null,
        })
        if (plan.ok !== false) {
          // 计划本身合法时，同时告诉调用方**能不能直接应用**——
          // 否则前端要自己重算一遍"有没有冲突/悬空引用"，而两份判定必然漂移。
          return { plan, applicable: assertApplicable(plan) }
        }
        return { plan, applicable: null }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/config-bundle/apply') {
      await handleRun(req, res, (body) => {
        const validated = validateBundle(body.bundle)
        if (!validated.ok) {
          json(res, 400, {
            ok: false,
            code: BUNDLE_ERRORS.PROFILE_INVALID,
            error: `导入包不合法：${validated.errors.join('；')}`,
            errors: validated.errors,
            serverTimeMs: Date.now(),
          })
          return
        }
        const plan = planImport({
          bundle: body.bundle,
          existingProfiles: modelStore.list(),
          existingBindings: bindingStore.list(),
          conflictPolicy: body.conflictPolicy ?? 'fail',
          actor: body.actor ?? null,
        })
        const gate = assertApplicable(plan)
        if (gate.ok !== true) {
          // 冲突与悬空引用都是**"应用了会坏"**而不是"应用了会不完整"，
          // 所以拒绝而不是尽力而为。409 而不是 400：请求本身没写错，
          // 是当前状态不允许——调用方要做的是选一个冲突策略或先建档案。
          json(res, 409, {
            ok: false, code: gate.code, error: gate.reason,
            plan, serverTimeMs: Date.now(),
          })
          return
        }
        if (typeof body.actor !== 'string' || body.actor.trim() === '') {
          json(res, 400, {
            ok: false, code: BUNDLE_ERRORS.ACTOR_REQUIRED,
            error: '缺少 actor：导入会改变哪条任务用哪个模型，必须记下是谁做的',
            serverTimeMs: Date.now(),
          })
          return
        }

        const incomingProfiles = new Map(validated.value.profiles.map((p) => [p.id, p]))
        const incomingBindings = new Map(
          validated.value.bindings.map((b) => [`${b.scope}\u0000${b.employeeRole}`, b]))

        const written = { profiles: [], bindings: [] }
        for (const action of plan.actions) {
          if (action.action !== 'create' && action.action !== 'update') continue
          if (action.kind === 'profile') {
            const p = incomingProfiles.get(action.id)
            if (p === undefined) continue
            // `credentialRequired` 是导出附加字段，模型档案契约不认识它，写库前摘掉。
            const { credentialRequired, ...profileInput } = p
            if (action.action === 'create') {
              modelStore.create(profileInput, { actor: body.actor })
            } else {
              // CAS：用计划里读到的那个版本，不用"现在最新"的版本。
              // 中间被别人改过就应当冲突失败，而不是把别人的改动盖掉。
              modelStore.update(action.id, profileInput, { actor: body.actor, version: action.currentVersion })
            }
            written.profiles.push({ id: action.id, action: action.action, credentialRequired: credentialRequired === true })
          } else {
            const b = incomingBindings.get(action.id.replace('/', '\u0000'))
            if (b === undefined) continue
            bindingStore.upsert({
              scope: b.scope,
              employeeRole: b.employeeRole,
              primaryProfile: b.primaryProfile,
              fallbackProfiles: b.fallbackProfiles,
              perRunBudget: b.perRunBudget,
            }, { actor: body.actor })
            written.bindings.push({ id: action.id, action: action.action })
          }
        }

        return {
          applied: true,
          written,
          // 导入方要知道**还得去密钥库补哪些引用**：导出包里没有引用名，
          // 所以这些档案导入后是"需要凭证但没有引用"的状态。
          // 不说清楚的话，用户会以为导入完就能跑，然后第一次运行才失败。
          needsCredential: written.profiles.filter((p) => p.credentialRequired).map((p) => p.id),
          // 策略 `keep` 下"包里有、但因为内容不同而没进去"的条数。
          // 单独报出来是因为 `keep` 会把冲突转成 `skip`，于是
          // `conflicts` 变成 0——只报 `conflicts` 会让回执看起来是成功的，
          // 而包里那些改动一处都没进去。
          keptLocal: plan.summary.keptLocal,
        }
      })
      return
    }
    // ── 单次运行预算账本与价目表（PRT-503 / PRT-510 / PRT-511，spec §6.6） ──
    //
    // 这是全仓唯一一处"花的是真钱"的接口面。它的错误都比别处贵：
    // 预留漏了 → 超支；预留重复 → 余额被占两次；结算两次 → 余额释放两次；
    // 锁定被结算 → 结果未知的那笔钱被当成已结清。
    //
    // 因此这里的原则是**宁可拒绝，不可猜**：状态码要能让调用方分辨
    // 「参数不对（400）」「状态不符（409）」「根本没有这笔预留（404）」。
    if (req.method === 'POST' && path === '/api/runtime/run-budget/reserve') {
      await handleRun(req, res, (body) => {
        // ── 参数校验**必须**排在状态检查之前 ──
        //
        // 顺序错了会把"你没传 attemptId"（400，改请求）报成
        // "没有价目表版本 undefined"（409，去发布一张表）——
        // 调用方会去修一个不存在的问题。
        if (typeof body.attemptId !== 'string' || body.attemptId.trim() === '') {
          json(res, 400, {
            ok: false, code: BUDGET_ERRORS.ATTEMPT_REQUIRED,
            error: '缺少 attemptId：账本的键是一次 Attempt，没有它无法定位预留',
            serverTimeMs: Date.now(),
          })
          return
        }
        // 没有预算 = 显式 unbounded，此时**不需要**价目表（不预留就不用算钱）。
        // 有预算但价目表取不到时给一条运维看得懂的错，而不是把
        // `createPriceTable` 的开发者断言漏出去。
        const needsPrice = body.budget !== null && body.budget !== undefined
        const priceTable = needsPrice ? budgetPriceTables.get(body.priceTableVersion) : null
        if (needsPrice && priceTable === null) {
          json(res, 409, {
            ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE,
            error: `没有价目表版本 ${JSON.stringify(body.priceTableVersion)}：` +
              '有预算就必须有价目表——否则"上限"没有办法换算成钱，预留也就无从谈起',
            serverTimeMs: Date.now(),
          })
          return
        }
        const r = budgetLedger.reserve({
          attemptId: body.attemptId, scope: body.scope, taskId: body.taskId,
          modelProfileId: body.modelProfileId,
          budget: body.budget ?? null,
          priceTable,
          tokensIn: body.tokensIn, tokensOut: body.tokensOut,
        })
        return { reservation: r.reservation, budgetState: r.budgetState }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/run-budget/observe') {
      await handleRun(req, res, (body) => {
        const r = budgetLedger.observe({
          attemptId: body.attemptId,
          tokensIn: body.tokensIn, tokensOut: body.tokensOut,
          modelProfileId: body.modelProfileId,
        })
        return {
          cancel: r.cancel, kind: r.kind, used: r.used, limit: r.limit,
          currency: r.currency, message: r.message, estimateOk: r.estimateOk,
        }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/run-budget/settle') {
      await handleRun(req, res, (body) => {
        const r = budgetLedger.settle({
          attemptId: body.attemptId, tokensIn: body.tokensIn, tokensOut: body.tokensOut,
          outcome: body.outcome, actor: body.actor,
          modelProfileId: body.modelProfileId, reason: body.reason,
        })
        return { reservation: r.reservation, locked: r.locked === true, overrun: r.overrun ?? null }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/run-budget/resolve') {
      // 人工处置 / 恢复：解开 locked 的**唯一**出口。
      await handleRun(req, res, (body) => budgetLedger.resolveLocked({
        attemptId: body.attemptId,
        disposition: body.disposition,
        actor: body.actor,
        tokensIn: body.tokensIn, tokensOut: body.tokensOut,
        reason: body.reason,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/run-budget') {
      const r = budgetLedger.list({ scope: url.searchParams.get('scope'), state: url.searchParams.get('state') })
      json(res, 200, {
        ok: true, reservations: r, held: budgetLedger.heldAmount(url.searchParams.get('scope')),
        serverTimeMs: Date.now(),
      })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/runtime/run-budget/')) {
      // `/api/runtime/run-budget/<attemptId>`：Attempt id 形如 `att:T-1:1`，
      // 含冒号，因此必须百分号编码。这里**整段解码**（不像绑定那样按段切）——
      // 路径里只有一段。
      const BUDGET_PREFIX = '/api/runtime/run-budget/'
      const rawId = path.slice(BUDGET_PREFIX.length)
      let attemptId = null
      try {
        attemptId = decodeURIComponent(rawId)
      } catch {
        json(res, 400, { ok: false, code: 'BAD_ID_ENCODING', error: '预算路径不是合法的 URL 编码' })
        return
      }
      if (attemptId.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/runtime/run-budget/<attemptId>' })
        return
      }
      const reservation = budgetLedger.get(attemptId)
      if (reservation === null) {
        json(res, 404, {
          ok: false, code: BUDGET_ERRORS.RESERVATION_NOT_FOUND,
          error: `Attempt ${attemptId} 没有预算预留（未配置预算的运行不会留下预留——那是显式的 unbounded，不是遗漏）`,
          serverTimeMs: Date.now(),
        })
        return
      }
      json(res, 200, { ok: true, reservation, usage: budgetLedger.usageOf(attemptId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/price-tables') {
      await handleRun(req, res, (body) => {
        // 版本只增不改：同版本再发布是 409，不是 200 覆盖。
        const table = createPriceTable({
          version: body.version, currency: body.currency,
          effectiveAtMs: body.effectiveAtMs, models: body.models ?? {},
        })
        const saved = budgetPriceTables.publish(table, { actor: body.actor })
        return { priceTable: { version: saved.version, currency: saved.currency, effectiveAtMs: saved.effectiveAtMs, models: Object.keys(saved.models) } }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/price-tables') {
      json(res, 200, { ok: true, priceTables: budgetPriceTables.list(), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path.startsWith('/api/price-tables/')) {
      const version = path.slice('/api/price-tables/'.length)
      if (version.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '路径应为 /api/price-tables/<version>' })
        return
      }
      const table = budgetPriceTables.get(version)
      if (table === null) {
        json(res, 404, { ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE, error: `没有价目表版本 ${version}` })
        return
      }
      // 只回结构与单价，**不回**任何与密钥相关的东西（价目表本来就没有，但保持同一条纪律）
      json(res, 200, {
        ok: true,
        priceTable: {
          version: table.version, currency: table.currency,
          effectiveAtMs: table.effectiveAtMs, models: table.models,
        },
        serverTimeMs: Date.now(),
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/run-budget/may-switch-model') {
      await handleRun(req, res, (body) => {
        const priceTable = budgetPriceTables.get(body.priceTableVersion)
        if (priceTable === null) {
          // 没有价目表就**无法比较**贵不贵，因此无法批准——这是 409 而不是 400：
          // 请求本身没错，是缺一张表。而且绝不能因为"查不清"就放行。
          json(res, 409, {
            ok: false, code: BUDGET_ERRORS.PRICE_TABLE_GONE,
            error: `没有价目表版本 ${JSON.stringify(body.priceTableVersion)}：` +
              '不比较费用就无法判断是否更贵，而"不得在未获用户批准时自动切换到更昂贵模型"' +
              '不能靠"查不清"来满足',
            serverTimeMs: Date.now(),
          })
          return
        }
        const d = budgetLedger.maySwitchModel({
          from: body.from, to: body.to, priceTable,
          tokensIn: body.tokensIn, tokensOut: body.tokensOut, approved: body.approved === true,
        })
        return { allowed: d.allowed, code: d.code, fromAmount: d.fromAmount, toAmount: d.toAmount, currency: d.currency }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/validate') {
      // 机器验收（PRT-307）：执行成功之后的**独立关卡**。
      //
      // `criteria` 是可选覆盖：不传时按任务契约（`tasks.acceptance`）判，
      // 传了则以传入的为准（人工复审给出机器判据的场景）。覆盖是**显式**的，
      // 因为"当时按什么验的"必须能从事后记录里读回来（结论与判据一起落库）。
      //
      // `hasNextPost` 不在这里给默认值：它决定验收通过后是 Completed 还是 HandingOff，
      // 而这两个方向猜错的后果（静默掐断任务链 / 创建没有承接方的任务）都不报错。
      // 状态机与仓储都会在缺它时拒绝，这里只负责**不替调用方做主**。
      await handleRun(req, res, (body) => {
        const r = runStore.recordValidation({
          attemptId: requireString(body, 'attemptId'),
          leaseEpoch: body.leaseEpoch ?? null,
          actor: requireString(body, 'actor'),
          runResult: body.runResult,
          criteria: body.criteria ?? null,
          hasNextPost: body.hasNextPost,
          nextPost: body.nextPost ?? null,
          reason: body.reason ?? null,
        })
        try { settleGoalsOfScope(getTask(runStore.getAttempt(body.attemptId).taskId).scope) } catch { /* 任务不存在时不结算 */ }
        return r
      })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/validations') {
      // 验收结论与**当时用的判据**一起读回来。
      // 只回结论是不够的：判据可以被人工复审覆盖，因此"不通过"到底是
      // 按契约判的还是按复审判的，不看判据就分不清。
      const attemptId = url.searchParams.get('attemptId')
      if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, attemptId, validations: runStore.validationsOf(attemptId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/runtime/handoff') {
      // 交接（PRT-308，spec 第 333 行）：当前 Task 收口并**原子创建**下一岗位任务。
      //
      // `prevSummary` 是上一阶段的收口结论（一行）；缺它时交接描述里会明说
      // 「上一阶段未留下收口结论」，而不是省略整行——省略会让下一岗位以为
      // 交接没发生过，于是它不会去问"上一环到底做完了什么"。
      //
      // 这里**不**接受调用方指定下一岗位：下一岗位由流水线决定。
      // 让调用方指定等于让执行者自己决定流水线怎么走。
      await handleRun(req, res, (body) => {
        const r = runStore.handoff({
          attemptId: requireString(body, 'attemptId'),
          leaseEpoch: body.leaseEpoch ?? null,
          actor: requireString(body, 'actor'),
          prevSummary: body.prevSummary ?? null,
          reason: body.reason ?? null,
        })
        try {
          const scope = getTask(runStore.getAttempt(body.attemptId).taskId).scope
          settleGoalsOfScope(scope)
        } catch { /* 任务不存在时不结算 */ }
        return r
      })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/handoffs') {
      // 交接记录（只读）：后继是谁、谁交的、什么时候。
      // 这条记录同时是 `HandingOff → Completed` 要的证据，因此排查
      // 「为什么收不了口」时要能直接看到它。
      const attemptId = url.searchParams.get('attemptId')
      if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, attemptId, handoffs: runStore.handoffsOf(attemptId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/run-results') {
      // 运行结果（只读）：这次运行**产出了什么**。
      //
      // 它同时是 `Running → Validating / RetryableFailure / UnknownOutcome` 要的证据，
      // 因此排查"为什么它推不动 / 当初到底跑出了什么"时要能直接看到。
      //
      // `source` 必须透出去：`'engine'`（有引擎产出的原文）与
      // `'report-only'`（没有引擎产出，只有"谁报的、结局是什么"，`result` 为 null）
      // 是**两个不同的事实**，读成同一个会让人以为"引擎当时输出了 null"。
      const attemptId = url.searchParams.get('attemptId')
      if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, attemptId, runResults: runStore.runResultsOf(attemptId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/run-events') {
      // F-05 前半的读面：**运行明细**（13 种 RunEvent，按契约序号升序）。
      //
      // 这条路由存在的理由与 `/api/runtime/run-results` 完全相同，只是粒度更细：
      // `run_results` 回答"这次运行**结局**是什么"，`run_events` 回答
      // "这次运行**过程**里发生了什么"——用了哪个模型、请求了哪些工具、
      // 工具是成了还是败了、模型说了什么。
      //
      // 两条只读参数：
      //   · `type`  —— 只看某一类（"这次调了哪些工具"用 `tool.requested`）；
      //   · `counts=1` —— 只要按类型的计数（13 种事件逐个数），不要正文。
      //
      // `known` 必须透出去：`known: false` 的行说明**上游产生了一种本控制面
      // 不认识的事件**。那是一个要被看见的信号；过滤掉它会让"上游新增了事件
      // 但我们不记"与"上游什么都没产生"长得一样。
      const attemptId = url.searchParams.get('attemptId')
      if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
      if (url.searchParams.get('counts') === '1') {
        json(res, 200, { ok: true, ...runStore.runEventCountsOf(attemptId), serverTimeMs: Date.now() })
        return
      }
      const type = url.searchParams.get('type')
      const limitRaw = url.searchParams.get('limit')
      json(res, 200, {
        ok: true,
        attemptId,
        events: runStore.runEventsOf(attemptId, {
          type: type === null || type.length === 0 ? null : type,
          limit: limitRaw === null ? 1000 : Number(limitRaw),
        }),
        serverTimeMs: Date.now(),
      })
      return
    }
    // ── F-16 自动化计划 / 运行历史 ──────────────────────────────────────
    //
    // 五条路由，刻意把**写**与**投影**分开：
    //   · `GET  /api/automation/calendar`  纯投影，不写任何行（"日历只做投影"）
    //   · `GET  /api/automation/schedules` 计划清单
    //   · `POST /api/automation/schedules` 建计划
    //   · `POST /api/automation/schedules/update` 改计划（含启停）
    //   · `POST /api/automation/tick`      显式物化（与生产定时器共用同一个函数）
    //   · `GET  /api/automation/runs`      运行历史
    //   · `GET  /api/automation/summary`   汇总
    if (path === '/api/automation/summary' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope')
      json(res, 200, { ok: true, ...automationStore.summary({ scope: scope !== null && scope.length > 0 ? scope : null }) })
      return
    }
    if (path === '/api/automation/schedules' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope')
      const enabledRaw = url.searchParams.get('enabled')
      const limitRaw = url.searchParams.get('limit')
      json(res, 200, {
        ok: true,
        schedules: automationStore.listSchedules({
          scope: scope !== null && scope.length > 0 ? scope : null,
          enabled: enabledRaw === null ? null : enabledRaw === '1' || enabledRaw === 'true',
          limit: limitRaw === null ? 200 : Number(limitRaw),
        }),
      })
      return
    }
    if (path === '/api/automation/schedules' && req.method === 'POST') {
      await handleRun(req, res, (body) => ({
        ok: true,
        schedule: automationStore.createSchedule({
          id: requireString(body, 'id'),
          scope: requireString(body, 'scope'),
          name: requireString(body, 'name'),
          spec: body.spec,
          timezone: requireString(body, 'timezone'),
          enabled: body.enabled !== false,
          overlapPolicy: body.overlapPolicy ?? 'skip',
          catchUpPolicy: body.catchUpPolicy ?? 'once',
          createdBy: body.by ?? null,
          note: body.note ?? null,
          // 任务模板：给了就"到点建一张可领的任务卡"，省略就只物化运行。
          // **不写成 `body.payload ?? null`** —— 那会把"没给"与"显式给 null"
          // 折成同一个值，而它们在建计划时语义相同（都不建任务），
          // 到了 `update` 那一侧就必须分开（见 `updateSchedule` 的三态说明）。
          ...(body.payload === undefined ? {} : { payload: body.payload }),
        }),
      }))
      return
    }
    if (path === '/api/automation/schedules/update' && req.method === 'POST') {
      await handleRun(req, res, (body) => ({
        ok: true,
        schedule: automationStore.updateSchedule({
          id: requireString(body, 'id'),
          enabled: body.enabled === undefined ? null : body.enabled === true,
          overlapPolicy: body.overlapPolicy ?? null,
          catchUpPolicy: body.catchUpPolicy ?? null,
          spec: body.spec ?? null,
          timezone: body.timezone ?? null,
          name: body.name ?? null,
          note: body.note ?? null,
          // 三态：不传 = 不改 / `null` = 显式清掉（此后不再建任务）/ 对象 = 换掉。
          // 用 `body.payload ?? null` 会让"清掉"与"不改"同形——用户想把
          // 一条计划从"建任务"改成"只提醒"，调用返回成功，而计划继续建任务。
          ...(body.payload === undefined ? {} : { payload: body.payload }),
        }),
      }))
      return
    }
    if (path === '/api/automation/calendar' && req.method === 'GET') {
      // ★ **纯投影**：这条路由是一段只读计算，库里一行都不会多。
      //
      // 参数里没有 `persist` / `materialize` 这种开关，是刻意的：
      // 一个"顺手把投影落库"的选项，会在某一次翻页之后让运行历史里
      // 多出一批**因为有人看了一眼**而产生的行。
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const id = url.searchParams.get('id')
      if (id === null || id.length === 0) { json(res, 400, { ok: false, error: '缺少 id', code: 'MISSING_PARAM' }); return }
      const sched = automationStore.scheduleOf(id)
      if (sched === null) { json(res, 404, { ok: false, error: `没有这条计划：${id}`, code: AUTOMATION_ERRORS.SCHEDULE_NOT_FOUND }); return }
      const fromRaw = Number(url.searchParams.get('fromMs'))
      const toRaw = Number(url.searchParams.get('toMs'))
      const fromMs = Number.isSafeInteger(fromRaw) ? fromRaw : Date.now()
      const toMs = Number.isSafeInteger(toRaw) ? toRaw : fromMs + 7 * 24 * 3600 * 1000
      const capRaw = Number(url.searchParams.get('max'))
      try {
        json(res, 200, {
          ok: true,
          scheduleId: id,
          // `projected: true` 是一个**能力发现位**：读的人要能一眼看出
          // 这些时刻不是运行记录，而是算出来的。
          projected: true,
          occurrences: projectOccurrences(sched, {
            fromMs, toMs,
            maxOccurrences: Number.isSafeInteger(capRaw) && capRaw > 0 ? Math.min(capRaw, 2000) : 500,
          }),
          serverTimeMs: Date.now(),
        })
      } catch (e) {
        json(res, Number(e?.statusCode) || 400, { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code ?? AUTOMATION_ERRORS.BAD_WINDOW })
      }
      return
    }
    if (path === '/api/automation/runs' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scheduleId = url.searchParams.get('scheduleId')
      const scope = url.searchParams.get('scope')
      const state = url.searchParams.get('state')
      const limitRaw = url.searchParams.get('limit')
      json(res, 200, {
        ok: true,
        runs: automationStore.runsOf({
          scheduleId: scheduleId !== null && scheduleId.length > 0 ? scheduleId : null,
          scope: scope !== null && scope.length > 0 ? scope : null,
          state: state !== null && state.length > 0 ? state : null,
          limit: limitRaw === null ? 200 : Number(limitRaw),
        }),
      })
      return
    }
    if (path === '/api/automation/tick' && req.method === 'POST') {
      // 显式 tick。与生产定时器**共用 `automationTick`**——两条实现漂移的
      // 表现是"手动 tick 对、自动 tick 错"，而后者只在生产上发生。
      await handleRun(req, res, (body) => automationTick({
        scope: typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : null,
        nowMs: body.nowMs ?? null,
        limit: body.limit ?? null,
      }))
      return
    }
    // ── F-17 长会话压缩 ────────────────────────────────────────────────
    //
    // 四条路由，**没有任何一条会删原文**——这是本模块的核心纪律：
    //   · `POST /api/compaction/messages`    追加原文（只追加，重复 seq 拒绝）
    //   · `POST /api/compaction/summarize`   写入一版摘要（baseVersion 是 CAS）
    //   · `GET  /api/compaction/context`     拼出"现在该给模型看什么"
    //   · `GET  /api/compaction/state`       压缩程度读数
    //
    // `POST /api/compaction/summarize` **接受已经算好的摘要文本**，本层不调用
    // 任何模型：决定"什么时候压、压多少"是产品策略（在这里），
    // 决定"这段文字怎么概括"是执行面能力。混在一起会让一次"摘要没写好"
    // 表现为"压缩功能坏了"，而修法完全不同。
    if (path === '/api/compaction/messages' && req.method === 'POST') {
      await handleRun(req, res, (body) => ({
        ok: true,
        message: compactionStore.appendMessage({
          sessionId: requireString(body, 'sessionId'),
          seq: body.seq,
          role: requireString(body, 'role'),
          content: typeof body.content === 'string' ? body.content : '',
        }),
      }))
      return
    }
    if (path === '/api/compaction/summarize' && req.method === 'POST') {
      await handleRun(req, res, (body) => compactionStore.proposeSummary({
        sessionId: requireString(body, 'sessionId'),
        coversFromSeq: body.coversFromSeq,
        coversToSeq: body.coversToSeq,
        summary: requireString(body, 'summary'),
        author: body.author ?? 'model',
        // `baseVersion` **原样透传，包括 `undefined`**：把它折叠成 `null`
        // 会让"我以为还没有摘要"与"我没传这个参数"变成同一件事，
        // 而后者是一个应该被报出来的调用错误（否则并发压缩会静默通过）。
        baseVersion: body.baseVersion === undefined ? null : body.baseVersion,
        createdBy: requireString(body, 'by'),
        reason: body.reason ?? null,
      }))
      return
    }
    if (path === '/api/compaction/context' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
      const maxRaw = Number(url.searchParams.get('maxTokens'))
      try {
        const ctx = compactionStore.effectiveContext(sessionId, {
          maxTokens: Number.isSafeInteger(maxRaw) && maxRaw > 0 ? maxRaw : null,
        })
        json(res, 200, { ok: true, sessionId, ...ctx })
      } catch (e) {
        json(res, Number(e?.statusCode) || 400, { ok: false, error: e instanceof Error ? e.message : String(e), code: e?.code ?? 'COMPACTION_FAILED' })
      }
      return
    }
    if (path === '/api/compaction/state' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, ...compactionStore.compactionState(sessionId) })
      return
    }
    if (path === '/api/compaction/summaries' && req.method === 'GET') {
      // 版本史：**每个版本都可读**，因为"曾经有过一个更好的摘要"这件事
      // 只有在旧版还在的时候才能被证明。
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId.length === 0) { json(res, 400, { ok: false, error: '缺少 sessionId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, sessionId, summaries: compactionStore.summariesOf(sessionId) })
      return
    }
    // ── F-20 能力包安装事实 ────────────────────────────────────────────
    //
    // 四条路由，围绕着**一本只追加的账**：
    //   · `POST /api/packs/facts`          追加一条记录（seq 由 CAS 算出来）
    //   · `GET  /api/packs/facts`          读账（可按包 / 按 seq 增量）
    //   · `GET  /api/packs/account`        整本账，形态直接喂给 `createPackStore`
    //   · `GET  /api/packs/export`         导出成可提交进 Git 的文本
    //
    // **刻意没有"改一条记录"或"删一条记录"的路由**：账是"只追加、记录不可变"的，
    // 而一次"顺手修正"会让"这条记录是谁改的"永远无法回答。
    // 写路径只有一条，且它不接受"当前状态"这种入参——那条状态是**推导**出来的，
    // 由 hub 存一份就等于有第二份真相。
    if (path === '/api/packs/facts' && req.method === 'POST') {
      await handleRun(req, res, (body) => ({
        ok: true,
        ...appendPackFact({
          db,
          record: {
            at: body.at,
            kind: body.kind,
            packId: body.packId,
            version: body.version,
            packType: body.packType ?? null,
            packProtocolVersion: body.packProtocolVersion ?? null,
            contentHash: body.contentHash ?? null,
            declaredContentHash: body.declaredContentHash ?? null,
            trust: body.trust ?? null,
            fromVersion: body.fromVersion ?? null,
            fromContentHash: body.fromContentHash ?? null,
            preflightVersion: body.preflightVersion ?? null,
            verdictCodes: body.verdictCodes ?? [],
          },
        }),
      }))
      return
    }
    if (path === '/api/packs/facts' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const packId = url.searchParams.get('packId')
      json(res, 200, {
        ok: true,
        packId: packId === null || packId.length === 0 ? null : packId,
        records: packFacts({
          db,
          packId,
          sinceSeq: optionalIntParam(url, 'sinceSeq') ?? 0,
          limit: optionalIntParam(url, 'limit'),
        }),
        counts: packFactCounts({ db }),
      })
      return
    }
    if (path === '/api/packs/account' && req.method === 'GET') {
      // 这一条的形状**就是** `createPackStore({ history })` 认的那个：
      // 重启之后控制面不必自己再推一遍状态，而"两份推导"是这一层最想避免的事。
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      json(res, 200, { ok: true, ...packAccount({ db }) })
      return
    }
    if (path === '/api/packs/export' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const { text } = exportPackFacts({ db })
      // 返回**文本**而不是 JSON 对象：这份东西的用途是进 diff、被人审阅，
      // 而一个被包在 HTTP JSON 里的对象到了调用方手里又要被 `JSON.stringify`
      // 一次——那一次与这一份的缩进、键序都可能不同，于是"审阅的是哪一份"就成了问题。
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="legion-pack-install-facts.json"',
      })
      res.end(text)
      return
    }
    // ── F-19 冻结的岗位包 ──────────────────────────────────────────────
    //
    // 三条路由，围绕着**只追加的版本化冻结**：
    //   · `POST /api/role-packs`            冻结一版（幂等或 409，没有第三种）
    //   · `GET  /api/role-packs`            列各版本 / 取一版（不传 version = 最新）
    //   · `GET  /api/role-packs/export`     导出成可提交进 Git 的审阅文本
    //
    // ★ **刻意没有"改一版"或"删一版"的路由**：冻结的全部含义就是"当时是哪一版"，
    // 而一条改/删的路由会让那个问题在**写的那一刻**失去答案。
    // 确实改了内容就再冻一版——`freezeRolePack` 会拒绝"同版本换内容"。
    //
    // 与 F-20 那组的分工：那一组存的是**能力包**的安装事实（装了什么），
    // 这一组存的是**岗位**的冻结描述（这个岗位当时是哪一版）。两者都不做推导。
    if (path === '/api/role-packs' && req.method === 'POST') {
      await handleRun(req, res, (body) => {
        const r = freezeRolePack({
          db,
          scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
          record: {
            // `pack` 原样收下（见 `role-pack-store.mjs` 文件头 ③）：
            // 控制面不挑字段、不重排、不补默认值——挑字段就是一份多余的转写。
            pack: body.pack,
            frozenAtMs: body.frozenAtMs,
            frozenBy: body.frozenBy ?? null,
          },
        })
        return {
          ok: true,
          frozen: r.frozen,
          // `created:false` 是**幂等重放**，不是"已经有一模一样的了所以不算数"。
          // 调用方需要能分清"我冻了新的一版"与"这一版早就冻过"。
          created: r.created,
          rolePackId: r.record.projected.rolePackId,
          version: r.record.projected.version,
          contentHash: r.record.projected.contentHash,
          frozenAtMs: r.record.frozenAtMs,
        }
      })
      return
    }
    if (path === '/api/role-packs' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const rolePackId = url.searchParams.get('rolePackId')
      const version = url.searchParams.get('version')
      const role = url.searchParams.get('role')
      const scope = url.searchParams.get('scope') ?? 'default'
      // ★ **形状不随查询参数变**：永远是 `records`（一个清单）+ `latest`（可能是 null）。
      //
      //   早先的写法是"给了 rolePackId 就返回单条 `record`，否则返回 `records`"——
      //   于是调用方必须知道"我刚才给没给 rolePackId"才知道该读哪个字段，
      //   而一份"读哪个字段取决于我传了什么参数"的响应，与一份随机的响应
      //   在调用方代码里是同一个东西（它只能两个都试一遍）。
      //
      //   `version` 只是**过滤**这个清单，不改变它的形状。
      const all = listRolePacks({ db, role, rolePackId, scope, limit: optionalIntParam(url, 'limit') })
      const records = version === null || version === ''
        ? all
        : all.filter((r) => r.pack?.version === version)
      json(res, 200, {
        ok: true,
        records,
        // "这个 id 现在该用哪一版"是另一个问题，同一个请求一并回答——
        // 但它按 `frozen_at_ms DESC, version DESC` 定序，**不依赖数组顺序**。
        latest: rolePackId === null || rolePackId === ''
          ? null
          : getRolePack({ db, rolePackId, scope }),
        counts: rolePackCounts({ db, scope }),
      })
      return
    }
    if (path === '/api/role-packs/export' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const text = exportRolePacks({ db, scope })
      // 与包事实的导出同一条理由：返回**文本**，因为这份东西的用途是进 diff。
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="legion-role-packs-frozen.json"',
      })
      res.end(text)
      return
    }
    // ── F-18 经验图谱 / 摩擦学习 ────────────────────────────────────────
    //
    // 四条路由，全部围绕**一本只追加的记录流**：
    //   · `POST /api/experience/records`  追加一条（node/edge/retract/draft）
    //   · `GET  /api/experience/records`  读流（可按草稿/边/种类、支持 sinceSeq）
    //   · `POST /api/experience/drafts/:id/settle`  处置一条草稿（promote/discard）
    //   · `GET  /api/experience/export`   导出成可提交进 Git 的审阅文本
    //   · `GET  /api/experience/account`  整本账（重启后供控制面重建）
    //
    // ★ **刻意没有"改一条记录"或"删一条记录"的路由**，也**没有**"保存整张图"
    //   的路由：记录是唯一的真相，"图现在长什么样"与"这条草稿现在是什么状态"
    //   都是从记录流**推导**出来的。存一份推导出来的状态，就等于有第二份真相，
    //   而它与记录流不一致时**没有任何东西能判定谁对**。
    //
    // ★ 处置单独一条路由（而不是往记录流里 POST 一条 `promote`）：
    //   那个检查是"这条草稿现在是不是还没被处置"，而它必须**在同一处**完成，
    //   否则调用方要先读一次再写一次，两步之间另一个进程可以插进来。
    if (path === '/api/experience/records' && req.method === 'POST') {
      await handleRun(req, res, (body) => ({
        ok: true,
        ...appendExperienceRecord({
          db,
          scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
          record: {
            kind: body.kind,
            atMs: body.atMs,
            draftId: body.draftId,
            subject: body.subject ?? null,
            score: body.score ?? null,
            payload: body.payload ?? null,
            edgeId: body.edgeId,
            from: body.from,
            to: body.to,
            edgeKind: body.edgeKind,
            source: body.source,
            by: body.by,
            reason: body.reason ?? null,
            nodeKind: body.nodeKind,
            id: body.id,
          },
        }),
      }))
      return
    }
    if (path === '/api/experience/records' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const records = experienceRecords({
        db,
        scope,
        draftId: url.searchParams.get('draftId'),
        edgeId: url.searchParams.get('edgeId'),
        kind: url.searchParams.get('kind'),
        sinceSeq: optionalIntParam(url, 'sinceSeq') ?? 0,
        limit: optionalIntParam(url, 'limit'),
      })
      json(res, 200, { ok: true, records, counts: draftCounts({ db, scope }) })
      return
    }
    if (path === '/api/experience/account' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      json(res, 200, { ok: true, ...experienceAccount({ db, scope }) })
      return
    }
    // `/api/experience/drafts/<id>/settle`
    //
    // ★ 形状刻意与 PRT-507 的 `/api/model-profiles/<id>/probe` 一致：
    //   `startsWith` + `endsWith` 配**字面量**，而不是一个正则守卫。
    //   原因不是风格：`scripts/prt/baseline-snapshot.mjs` 的抽取器只认
    //   字面量（`path === '…'` / `path.startsWith('…')`），而它用
    //   `findOpaqueRouteGuards` **主动拒绝**用常量做守卫的写法。
    //   一个正则守卫两条都躲得过——于是这条路由会**悄悄**不进平台契约，
    //   而 `--record` 会写下一份"看起来正常、少了一条端点"的基线。
    //
    //   这正是本仓库记过的最贵的一条：**一道看不见某类改动的闸门，
    //   比没有闸门更危险**——它给人"已经守住了"的错觉。
    //   所以这里按既有约定写成字面量 + startsWith/endsWith。
    if (req.method === 'POST' && path.startsWith('/api/experience/drafts/') && path.endsWith('/settle')) {
      const rawId = path.slice('/api/experience/drafts/'.length, path.length - '/settle'.length)
      // 中间那段必须是**一段** id，不能为空、也不能再带 `/`：
      // 否则 `/api/experience/drafts/a/b/settle` 会被当成一个合法 id，
      // 而那个 id 永远不会有对应的草稿——报出来的是"来源丢了"，
      // 而不是"你的路径写错了"，于是调用方会去查一条根本不存在的草稿。
      if (rawId === '' || rawId.includes('/')) {
        json(res, 400, {
          error: `草稿 id 必须是一段路径（收到 ${JSON.stringify(rawId)}），` +
            '带 `/` 的 id 永远不会对应到一条草稿',
          code: 'EXPERIENCE_RECORD_MALFORMED',
        })
        return
      }
      const draftId = decodeURIComponent(rawId)
      await handleRun(req, res, (body) => ({
        ok: true,
        ...settleDraft({
          db,
          scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
          draftId,
          action: body.action,
          // 理由原样交给下面的层去校验封闭词表：在这里再存一份词表
          // 就是第二份会各自漂移的词表。
          by: body.by,
          reason: body.reason,
          atMs: Number.isInteger(body.atMs) ? body.atMs : Date.now(),
        }),
      }))
      return
    }
    if (path === '/api/experience/export' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const { text } = exportExperience({ db, scope })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="legion-experience.json"',
      })
      res.end(text)
      return
    }
    // ── F-21 连接器登记表 ──────────────────────────────────────────────
    //
    // 四条路由，围绕**按内容哈希冻结的声明** + **点名的故障事件**：
    //   · `POST /api/connectors`             冻结一份声明（幂等或 409，没有第三种）
    //   · `GET  /api/connectors`             列登记（可按 connectorId / sinceSeq）
    //   · `GET  /api/connectors/incidents`   读熔断事件（点名是哪一个连接器）
    //   · `GET  /api/connectors/export`      导出成可提交进 Git 的审阅文本
    //
    // ★ **刻意没有"改一份声明"或"删一个连接器"的路由**：连接器声明说的是
    //   "一个外部进程能拿到什么权限"，而一条改/删的路由会让"当时放行了哪些工具"
    //   在**写的那一刻**失去答案。确实改了内容就递增版本号再冻一版——
    //   `freezeDeclaration` 会拒绝"同版本换内容"。
    //
    // ★ 事件路由的 `connectorId` 是**必填**的：只记"某处发生了故障"时，
    //   一次隔离良好的单点故障与一次大面积故障长得一样。这一层不做默认值
    //   填充（填一个 'default' 会让"忘了传"与"就是那个连接器"同形）。
    if (path === '/api/connectors' && req.method === 'POST') {
      await handleRun(req, res, (body) => {
        const r = freezeDeclaration({
          db,
          scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
          // `declaration` 原样收下（与 F-19 的 `pack` 同一条理由）：
          // 控制面不挑字段、不重排、不补默认值——挑字段就是一份多余的转写，
          // 而转写会漂移，漂移之后"当时声明的是什么"就没有唯一的答案了。
          declaration: body.declaration,
          version: body.version,
          frozenAtMs: Number.isInteger(body.frozenAtMs) ? body.frozenAtMs : Date.now(),
          frozenBy: body.frozenBy ?? null,
        })
        return {
          ok: true,
          frozen: r.frozen,
          // `created:false` 是**幂等重放**，不是"已经有一模一样的了所以不算数"。
          created: r.created,
          connectorId: r.connectorId,
          version: r.version,
          contentHash: r.contentHash,
          toolCount: r.toolCount,
          frozenAtMs: r.frozenAtMs,
        }
      })
      return
    }
    if (path === '/api/connectors' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const connectorId = url.searchParams.get('connectorId')
      const version = url.searchParams.get('version')
      const sinceSeq = optionalIntParam(url, 'sinceSeq') ?? 0
      // ★ 形状不随查询参数变（与 F-19 同一条）：永远是 `records` + `registration`
      //   + `counts`。一份"读哪个字段取决于我传了什么参数"的响应，
      //   与一份随机的响应在调用方代码里是同一个东西。
      //
      // ★★ `version` **必须真的被用上**。第一版收了这个参数却只把它丢在一边
      //   （`getDeclaration` 没收到它），于是"不传 version = 最新"这条默认
      //   静默地覆盖了每一次带版本的查询：调用方问"1.0.0 当时放行了哪些工具"，
      //   拿回的是 2.0.0 的工具清单——**答案来自另一版，而响应里没有任何地方
      //   提示这件事**。这个坑比"不支持 version"深得多：不支持时会报错或者
      //   返回 null，而静默忽略会给出一个看起来完全正常的答案。
      const filtered = version === null
        ? connectorRegistrations({ db, scope, connectorId, sinceSeq })
        : connectorRegistrations({ db, scope, connectorId, sinceSeq }).filter((r) => r.version === version)
      json(res, 200, {
        ok: true,
        scope,
        records: filtered,
        // 不传 connectorId 或那一版还没冻过时是 null——而"还没冻过"与"这行坏了"
        // 是两件事，所以 `readable` 一并带出去。
        registration: connectorId === null ? null : getDeclaration({ db, connectorId, version, scope }),
        counts: connectorCounts({ db, scope }),
      })
      return
    }
    if (path === '/api/connectors/incidents' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const connectorId = url.searchParams.get('connectorId')
      const sinceSeq = optionalIntParam(url, 'sinceSeq') ?? 0
      json(res, 200, {
        ok: true,
        scope,
        records: connectorIncidents({ db, scope, connectorId, sinceSeq }),
        counts: connectorCounts({ db, scope }),
      })
      return
    }
    if (path === '/api/connectors/export' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const scope = url.searchParams.get('scope') ?? 'default'
      const { text } = exportConnectors({ db, scope })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="legion-connectors.json"',
      })
      res.end(text)
      return
    }
    // `/api/connectors/<id>/incidents` —— 记一条熔断事件
    //
    // ★ 与 F-18 的 settle 同形：**字面量** + `startsWith`/`endsWith`，
    //   而不是正则守卫。理由见上面那段长注释（`baseline-snapshot.mjs` 的
    //   抽取器只认字面量，正则守卫会**悄悄**不进平台契约）。
    if (req.method === 'POST' && path.startsWith('/api/connectors/') && path.endsWith('/incidents')) {
      const rawId = path.slice('/api/connectors/'.length, path.length - '/incidents'.length)
      // 中间那段必须是**一段** id（同 F-18 的 settle）：否则
      // `/api/connectors/a/b/incidents` 会被当成一个合法 id，
      // 而那个 id 永远不会有对应的连接器。
      if (rawId === '' || rawId.includes('/')) {
        json(res, 400, {
          error: `连接器 id 必须是一段路径（收到 ${JSON.stringify(rawId)}），` +
            '带 `/` 的 id 永远不会对应到一个连接器',
          code: 'CONNECTOR_EVENT_MALFORMED',
        })
        return
      }
      const connectorId = decodeURIComponent(rawId)
      await handleRun(req, res, (body) => ({
        ok: true,
        ...appendIncident({
          db,
          scope: typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'default',
          connectorId,
          kind: body.kind,
          circuitState: body.circuitState,
          // `atMs` 必填且必须是整数：`undefined` 与"当时就是 0"同形。
          atMs: body.atMs,
          reason: body.reason ?? null,
          actor: body.actor ?? null,
        }),
      }))
      return
    }
    // ── F-15 用量汇总 ──────────────────────────────────────────────────
    //
    // 两条只读路由。**刻意没有写路径**：这张报表读的是已经记下的账，
    // 而"记一笔账"是 `budget-ledger` 的 `reserve/observe/settle`——
    // 那条链是闸门，需要 attemptId + leaseEpoch，不该有一条"手工记一笔"
    // 的后门（那会让账本里的钱与实际花掉的钱脱钩，而两者看起来一样）。
    if (path === '/api/usage/totals' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      json(res, 200, {
        ok: true,
        ...usageRollup.usageTotals({
          db,
          sinceMs: optionalIntParam(url, 'sinceMs'),
          untilMs: optionalIntParam(url, 'untilMs'),
          scope: url.searchParams.get('scope'),
        }),
      })
      return
    }
    if (path === '/api/usage/rollup' && req.method === 'GET') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const dimension = url.searchParams.get('dimension')
      try {
        json(res, 200, {
          ok: true,
          ...usageRollup.rollupBy({
            db,
            dimension,
            sinceMs: optionalIntParam(url, 'sinceMs'),
            untilMs: optionalIntParam(url, 'untilMs'),
            scope: url.searchParams.get('scope'),
          }),
        })
      } catch (e) {
        // 未知维度是**调用方的错**，所以 400 + 具名码，并把可选值列出来——
        // 只说"不认识的维度"会让调用方去翻源码。
        json(res, Number(e?.statusCode) || 400, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          code: e?.code ?? 'ROLLUP_FAILED',
          dimensions: ROLLUP_DIMENSIONS,
        })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/reconciliations') {
      // 对账记录（只读）：这条尝试被谁、以什么决定、按哪种结论处置过。
      //
      // 这条记录同时是 `UnknownOutcome` 四条出边要的证据，因此排查
      // 「为什么它推进不了 / 当初是谁把它判成'写成功了'」时要能直接看到它——
      // 而不是去打开数据库文件。
      //
      // 与 `/api/runtime/handoffs`、`/api/runtime/validations` 同一个形状：
      // 一份只写不读的证据，与一份没写的证据，在"事后能不能回答谁判的"上
      // 是同一个东西——只不过前者占了一张表。
      const attemptId = url.searchParams.get('attemptId')
      if (attemptId === null || attemptId.length === 0) { json(res, 400, { ok: false, error: '缺少 attemptId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, attemptId, reconciliations: runStore.reconciliationsOf(attemptId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/next-post') {
      // 「这条任务后面还有没有岗位、是谁」——验收前要能先看到，
      // 否则调用方只能靠猜来决定 `hasNextPost`。
      // 链断/岗位不存在时返回 ok:false + 具名码，而**不是** hasNext:false。
      const taskId = url.searchParams.get('taskId')
      if (taskId === null || taskId.length === 0) { json(res, 400, { ok: false, error: '缺少 taskId', code: 'MISSING_PARAM' }); return }
      // 直接查两列而不是 `getTask`：后者对不存在的任务**抛异常**，
      // 于是"任务不存在"会变成 500，而它明明是 404（调用方给错了 id）。
      // 用异常做正常流程控制会让状态码失去意义。
      const task = db.prepare('SELECT id, scope, role FROM tasks WHERE id = ?').get(taskId)
      if (task === undefined) { json(res, 404, { ok: false, error: `任务不存在：${taskId}`, code: 'TASK_NOT_FOUND' }); return }
      const resolved = resolveNextPost({ stages: readPipeline(task.scope ?? 'default').stages, role: task.role ?? null })
      if (resolved.ok !== true) {
        json(res, 409, { ok: false, error: resolved.message, code: resolved.code, brokenEdge: resolved.brokenEdge ?? null, serverTimeMs: Date.now() })
        return
      }
      json(res, 200, {
        ok: true, taskId, role: task.role ?? null,
        hasNextPost: resolved.hasNext, nextRole: resolved.nextRole, nextLabel: resolved.nextLabel,
        reason: resolved.reason, serverTimeMs: Date.now(),
      })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/budget') {
      // 重试额度读数：界面上要能回答"这条任务还能自动重试几次、下次什么时候"。
      // 答不出来时用户看到的只是"它又失败了"，而无法判断该不该干预。
      //
      // **注意：这条路径归"重试预算"，不归"费用预算"。** PRT-503 新增费用账本时
      // 一度也用了 `/api/runtime/budget`，于是这条成为不可达的死代码，而
      // `prt-007-baseline.json` 因为路由清单是 Set 去重的，**看不出任何变化**。
      // 费用账本因此改用 `/api/runtime/run-budget`——两个"budget"在 URL 上必须分开，
      // 否则后写的静默遮蔽先写的，而遮蔽的表现是"界面上那个读数的字段名变了"。
      const taskId = url.searchParams.get('taskId')
      if (taskId === null || taskId.length === 0) { json(res, 400, { ok: false, error: '缺少 taskId', code: 'MISSING_PARAM' }); return }
      json(res, 200, { ok: true, budget: runStore.retryBudgetOf(taskId), serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'GET' && path === '/api/runtime/attempt') {
      // 诊断用只读端点：一条尝试 + 它所属任务的全部历史 + 事件流。
      // 「试过几次、每次错在哪」如果只能靠翻日志，那它实际上是不可查的。
      const attemptId = url.searchParams.get('attemptId')
      const taskId = url.searchParams.get('taskId')
      if (attemptId) {
        const attempt = runStore.getAttempt(attemptId)
        if (attempt === null) { json(res, 404, { ok: false, error: `运行尝试不存在：${attemptId}` }); return }
        json(res, 200, { ok: true, attempt, history: runStore.historyOf(attempt.taskId), events: runStore.eventsOf(attemptId) })
        return
      }
      if (taskId) {
        json(res, 200, { ok: true, taskId, history: runStore.historyOf(taskId) })
        return
      }
      json(res, 400, { ok: false, error: '缺少参数 attemptId 或 taskId' })
      return
    }

    if (req.method === 'POST' && path === '/api/claim') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const soldier = typeof body.soldier === 'string' && body.soldier.length > 0 ? body.soldier : by
        const ttl = typeof body.ttlMinutes === 'number' && Number.isInteger(body.ttlMinutes) && body.ttlMinutes > 0 ? body.ttlMinutes : undefined
        const task = claimTask(id, soldier, body.ifVersion, body.force === true, body.round, body.requestId, ttl)
        audit(by, scope, 'claim', id, { soldier }, task.goalId)
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/transition') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const to = body.to
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof to !== 'string' || to.length === 0) throw new Error('缺少参数 to')
        const task = transitionTask(id, to, by, body.ifVersion, body.force === true)
        audit(by, scope, 'transition', id, { to }, task.goalId)
        if (task.goalId || task.status === 'done' || task.status === 'canceled') settleGoalsOfScope(task.scope) // 链收尾 → 目标自动 done
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/advance') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const task = advanceTask(id, by, body.ifVersion)
        audit(by, scope, 'advance', id, {}, task.goalId)
        settleGoalsOfScope(task.scope) // 推进 done → 目标自动收尾
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/reassign') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const soldier = body.soldier
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof soldier !== 'string' || soldier.trim().length === 0) throw new Error('缺少参数 soldier')
        const task = reassignTask(id, soldier.trim(), by)
        audit(by, scope, 'reassign', id, { soldier: soldier.trim() }, task.goalId)
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/hold') {
      // 将军逐任务拦截/放行：hold=true 时守护不得自动认领执行（claimTask 拒绝），
      // 将军放行后恢复自动交接。done/canceled 不可再改。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const hold = body.hold === true
        const t = db.prepare('SELECT status, goalId FROM tasks WHERE id = ?').get(id)
        if (!t) throw new Error(`未知任务 ${id}`)
        if (t.status === 'done' || t.status === 'canceled') throw new Error(`任务 ${id} 已 ${t.status}，不可拦截/放行`)
        db.prepare('UPDATE tasks SET hold=?, version=version+1, updatedAt=? WHERE id=?').run(hold ? 1 : 0, now(), id)
        audit(by, scope, hold ? 'hold' : 'unhold', id, {}, t.goalId)
        return getTask(id)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/release-stale') {
      await handleWrite(req, res, (body, by, scope) => {
        const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : undefined
        const minutes = Number(body.olderThan ?? 60)
        if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('olderThan 必须是正整数分钟数')
        const released = releaseStaleTasks(minutes, by, ids)
        audit(by, scope, 'release-stale', '*', { released })
        return { released }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/inbox') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? undefined
        const role = url.searchParams.get('role') ?? undefined
        const soldier = url.searchParams.get('soldier') ?? undefined
        if (role === undefined && soldier === undefined) throw new Error('inbox 需要 role 或 soldier 参数')
        json(res, 200, inboxCount({ role, soldier, scope: scopeParam }))
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/comment') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const text = body.text
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof text !== 'string' || text.trim().length === 0) throw new Error('缺少参数 text')
        // PRT-404：`kind: 'feedback'` 写的是**用户反馈**列，与评论、证据分开存。
        // 三条路径共用一个写入口是有意的：它们都是"往任务的某个批注列追加一条"，
        // 分成三个路由只会把同一段校验抄三遍。
        const kind = body.kind === 'feedback' ? 'feedback' : body.isEvidence === true ? 'evidence' : 'comments'
        const task = appendTaskNote(id, by, text.trim(), kind)
        audit(by, scope, kind === 'evidence' ? 'evidence' : kind === 'feedback' ? 'feedback' : 'comment', id, {}, task.goalId)
        return task
      })
      return
    }
    if (req.method === 'GET' && path === '/api/task-feedback') {
      // PRT-404：用户反馈的**独立读端点**。
      //
      // 为什么不是"读 /api/task 然后自己挑"：`/api/task` 回来的是整行任务，
      // 里面有几个不同性质的批注列（comments / evidence / feedback）。
      // 让每个消费者自己去挑，等于把"哪一列是用户反馈"这件事复制到每个读点——
      // 而 PRT-404 全部的意义就是让它**只有一个答案**。
      //
      //   > 一个"从任务行里自己挑反馈"的读法，
      //   > 与一个"问专门那个端点"的读法，在只有一种批注的时候是同一个东西——
      //   > 只不过前者会在有人忘了挑、顺手把 `comments` 也当反馈时，
      //   > 把"同事说了一句话"读成"用户要求调整"。
      const askId = url.searchParams.get('taskId')
      if (askId === null || askId.trim() === '') {
        json(res, 400, { ok: false, code: 'MISSING_PARAM', error: '缺少参数 taskId', serverTimeMs: Date.now() })
        return
      }
      const scopeParam = url.searchParams.get('scope')
      const task = db.prepare('SELECT id, scope, feedback FROM tasks WHERE id = ?').get(askId.trim())
      if (task === undefined || task === null) {
        // 404 而不是 `{feedback: []}`：**"任务不存在"与"这个任务没有反馈"是两件事**，
        // 而一个空数组会让两者在调用方那里长得一样。装配器把 404 翻成 `null`，
        // 再由 `sources.mjs` 决定这是不是致命。
        json(res, 404, {
          ok: false,
          code: 'TASK_NOT_FOUND',
          error: `任务 ${askId.trim()} 不存在`,
          serverTimeMs: Date.now(),
        })
        return
      }
      // 空间必须对得上：任务 id 是全库唯一的，但拿别空间的 id 来问
      // 仍然是一次越权读取（装配是**按空间**做的）。调用方给了 scope 就校验。
      if (scopeParam !== null && scopeParam.trim() !== '' && task.scope !== scopeParam.trim()) {
        json(res, 404, {
          ok: false,
          code: 'TASK_NOT_FOUND',
          error: `任务 ${askId.trim()} 不在空间 ${scopeParam.trim()} 里`,
          serverTimeMs: Date.now(),
        })
        return
      }
      const feedback = parseJson(task.feedback, [])
      json(res, 200, { ok: true, taskId: task.id, count: feedback.length, feedback, serverTimeMs: Date.now() })
      return
    }
    if (req.method === 'POST' && path === '/api/heartbeat') {
      await handleWrite(req, res, (body, by, scope) => {
        // S2/R-1（决策 B1）：kind=worker 的心跳可附带 model {provider,model}（守护当前选用模型），
        // 供 GET /api/chat/health 的模型解析链聚合展示（members.model 列，可空）。
        const m = body?.model && typeof body.model === 'object' && body.model !== null ? body.model : null
        const modelText = m && (typeof m.model === 'string' || typeof m.provider === 'string')
          ? JSON.stringify({ provider: typeof m.provider === 'string' ? m.provider : '', model: typeof m.model === 'string' ? m.model : '' })
          : undefined
        touchMember(by, scope, typeof body.kind === 'string' ? body.kind : 'unknown', modelText)
        return { member: by, scope, online: true }
      })
      return
    }

    if (req.method === 'GET' && path === '/api/exec') {
      const scopeParam = url.searchParams.get('scope') ?? ''
      const hit = scopeParam ? db.prepare('SELECT * FROM exec_state WHERE scope = ?').get(scopeParam) : undefined
      json(res, 200, { scope: scopeParam, enabled: !!hit?.enabled, updatedAt: hit?.updatedAt ?? null })
      return
    }
    if (req.method === 'POST' && path === '/api/exec') {
      await handleWrite(req, res, (body, by, scope) => {
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        const enabled = body.enabled === true
        db.prepare('INSERT INTO exec_state (scope, enabled, updatedAt) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, updatedAt=excluded.updatedAt')
          .run(targetScope, enabled ? 1 : 0, now())
        audit(by, targetScope, 'exec:toggle', null, { enabled })
        return { scope: targetScope, enabled }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/exec/queue') {
      // 应由编排自动执行的任务：自动目标链中「非写码角色」的待办/进行中任务。
      const scopeParam = url.searchParams.get('scope') ?? undefined
      const rows = listTasks({ scope: scopeParam }).filter(t =>
        (t.status === 'todo' || t.status === 'in_progress') &&
        String(t.description ?? '').includes('[auto-goal]') &&
        !NON_AUTO_ROLES.has(t.role ?? ''),
      )
      const pending = new Set(db.prepare("SELECT taskId FROM exec_requests WHERE status='pending'").all().map(r => r.taskId))
      json(res, 200, { scope: scopeParam ?? 'all', tasks: rows.filter(t => !pending.has(t.id)) })
      return
    }
    if (req.method === 'POST' && path === '/api/exec/request') {
      // 用户点「派 AI 执行」：记录请求（含写码类任务），由执行守护消费。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.taskId
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 taskId')
        const t = db.prepare('SELECT scope FROM tasks WHERE id = ?').get(id)
        if (!t) throw new Error(`未知任务 ${id}`)
        db.prepare('INSERT INTO exec_requests (taskId, scope, status, createdAt) VALUES (?, ?, \'pending\', ?) ON CONFLICT(taskId) DO UPDATE SET status=\'pending\'')
          .run(id, t.scope, now())
        audit(by, t.scope, 'exec:request', id, {})
        return { taskId: id, scope: t.scope, status: 'pending' }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/exec/requests') {
      const rows = db.prepare("SELECT * FROM exec_requests WHERE status='pending' ORDER BY createdAt").all()
      json(res, 200, rows.map(r => ({ taskId: r.taskId, scope: r.scope, createdAt: r.createdAt })))
      return
    }

    // 智能体默认模型配置
    if (req.method === 'GET' && path === '/api/models') {
      const scopeParam = url.searchParams.get('scope') ?? undefined
      const rows = scopeParam
        ? db.prepare('SELECT scope, role, provider, model FROM agent_models WHERE scope = ?').all(scopeParam)
        : db.prepare('SELECT scope, role, provider, model FROM agent_models').all()
      json(res, 200, rows)
      return
    }
    if (req.method === 'POST' && path === '/api/models') {
      await handleWrite(req, res, (body, by, scope) => {
        const role = typeof body.role === 'string' ? body.role.trim() : ''
        if (!role) throw new Error('缺少参数 role')
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (!provider || !model) throw new Error('缺少 provider 或 model')
        // 产品化校验（PRT-252）：**配置错误必须在配置的那一刻、用用户能看懂的话说出来**。
        // 校验不过 → 400 + 结构化字段（code/field/hint/candidates），前端据此落到具体输入框。
        //
        // 顺带说明为什么这里**不**降级成"只警告"：写出一个跑不起来的绑定，
        // 代价是用户在一次真实运行失败之后才回头怀疑配置；而拒绝的代价
        // 只是他改一下下拉框。两者不对称，所以拒绝。
        const verdict = validateAgentModelSelection({ provider, model, profiles: modelStore.list() })
        if (verdict.ok !== true) throw modelConfigErrorFor(verdict)
        db.prepare('INSERT INTO agent_models (scope, role, provider, model, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, role) DO UPDATE SET provider=excluded.provider, model=excluded.model, updatedAt=excluded.updatedAt')
          .run(targetScope, role, provider, model, now())
        audit(by, targetScope, 'model:set', null, { role, provider, model })
        return { scope: targetScope, role, provider, model }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/models/clear') {
      await handleWrite(req, res, (body, by, scope) => {
        const role = typeof body.role === 'string' ? body.role.trim() : ''
        if (!role) throw new Error('缺少参数 role')
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        db.prepare('DELETE FROM agent_models WHERE scope = ? AND role = ?').run(targetScope, role)
        audit(by, targetScope, 'model:clear', null, { role })
        return { scope: targetScope, role }
      })
      return
    }

    // 读接口
    if (req.method === 'GET' && path === '/api/board') {
      json(res, 200, listTasks({
        status: url.searchParams.get('status') ?? undefined,
        soldier: url.searchParams.get('soldier') ?? undefined,
        role: url.searchParams.get('role') ?? undefined,
        scope: url.searchParams.get('scope') ?? undefined,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/task') {
      // 单任务详情（任务详情视图数据源）。
      const id = url.searchParams.get('id')
      if (!id) { json(res, 400, { error: '缺少参数 id' }); return }
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      if (!row) { json(res, 404, { error: `未知任务 ${id}` }); return }
      json(res, 200, rowToTask(row))
      return
    }
    if (req.method === 'GET' && path === '/api/missions') {
      // 真 scope 分区：按 tasks.scope 过滤聚合（与 serve.mjs /api/missions 响应同构，scopeAware=true）。
      const scopeParam = url.searchParams.get('scope') ?? undefined
      const rows = listTasks({ scope: scopeParam })
      const labels = pipelineLabels()
      const byRole = new Map()
      for (const t of rows) {
        if (t.status === 'canceled') continue
        const role = t.role ?? t.soldier ?? 'unassigned'
        const arr = byRole.get(role) ?? []
        arr.push(t)
        byRole.set(role, arr)
      }
      const missions = [...byRole.entries()].map(([role, list]) => {
        const done = list.filter(t => t.status === 'done').length
        const inProgress = list.filter(t => t.status === 'in_progress').length
        const inReview = list.filter(t => t.status === 'in_review').length
        const blocked = list.filter(t => t.status === 'blocked').length
        const waiting = list.filter(t => t.status === 'todo' || t.status === 'backlog').length
        const total = list.length
        const percent = total === 0 ? 0 : Math.round((done / total) * 100)
        let status = 'running'
        if (blocked > 0) status = 'blocked'
        else if (done === total) status = 'done'
        else if (inProgress === 0 && inReview === 0) status = 'waiting'
        return {
          role,
          name: labels[role] ?? role,
          total,
          done,
          inProgress,
          inReview,
          blocked,
          waiting,
          percent,
          status,
          tasks: list.map(t => ({ id: t.id, title: t.title, status: t.status })),
        }
      })
      const rank = { running: 0, waiting: 1, blocked: 2, done: 3 }
      missions.sort((a, b) => rank[a.status] - rank[b.status] || b.percent - a.percent)
      json(res, 200, { generatedAt: now(), scope: scopeParam ?? null, scopeAware: true, missions })
      return
    }
    if (req.method === 'GET' && path === '/api/scopes') {
      // 真实存在的分区：任务 + 成员表中的 distinct scope。
      const fromTasks = db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all()
      const fromMembers = db.prepare("SELECT DISTINCT scope FROM members WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all()
      const scopes = [...new Set([...fromTasks, ...fromMembers].map(r => r.scope))]
      json(res, 200, { scopes })
      return
    }
    if (req.method === 'GET' && path === '/api/spaces') {
      // 工作空间列表：spaces 表注册名 + 未注册的既有 scope（roster/tasks）推导合并。
      const known = db.prepare('SELECT * FROM spaces ORDER BY id').all()
      const fromRoster = db.prepare("SELECT DISTINCT scope FROM roster WHERE scope != '' ORDER BY scope").all().map(r => r.scope)
      const fromTasks = db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all().map(r => r.scope)
      const byId = new Map(known.map(k => [k.id, k]))
      const ids = [...new Set([...byId.keys(), ...fromRoster, ...fromTasks])]
      const countStmt = db.prepare('SELECT COUNT(*) AS c FROM roster WHERE scope = ?')
      const spaces = ids.map(id => {
        const k = byId.get(id)
        return {
          id, name: k?.name ?? id, private: !!k?.private,
          localDir: k?.local_dir ?? '', remoteUrl: k?.remote_url ?? '',
          agentCount: countStmt.get(id).c,
        }
      })
      json(res, 200, { spaces })
      return
    }
    if (req.method === 'GET' && path === '/api/goal') {
      // 目标列表（多目标并发模型）：scope 全部目标，每行 = 目标记录 + 按该目标链任务（goalId）实时算的进度。
      // objective/done/total/percent = 汇总兼容字段（未取消目标的任务合计；objective = 最新 active 目标文案）。
      const scopeParam = url.searchParams.get('scope') ?? ''
      if (scopeParam) settleGoalsOfScope(scopeParam) // 链全部完成 → 目标自动 done（幂等，只有状态变化才写）
      const goals = scopeParam ? listGoals(scopeParam).map(goalView) : []
      const counted = goals.filter(g => g.status !== 'canceled')
      const done = counted.reduce((a, g) => a + g.done, 0)
      const total = counted.reduce((a, g) => a + g.total, 0)
      const latestActive = goals.find(g => g.status === 'active') ?? null
      json(res, 200, {
        scope: scopeParam,
        goals,
        objective: latestActive?.objective ?? null,
        done, total,
        percent: total > 0 ? Math.round((done / total) * 100) : 0,
        updatedAt: latestActive?.updatedAt ?? null,
      })
      return
    }
    if (req.method === 'GET' && path === '/api/pipeline') {
      // SP-P0：空间流水线（数据面单源）。守护每轮扫单读这里（hub 优先，部署面 rolesFile 兜底）；
      // 指挥台用它渲染岗位契约。version = 内容指纹：未变化时守护零成本跳过重建。
      const scopeParam = (url.searchParams.get('scope') ?? '').trim()
      if (!SCOPE_KEY_RE.test(scopeParam)) { json(res, 400, { error: 'scope 非法（字母/数字/下划线/连字符，≤64 字符）' }); return }
      const includeDisabled = (url.searchParams.get('include') ?? '') !== 'active'
      json(res, 200, readPipeline(scopeParam, { includeDisabled }))
      return
    }
    if (req.method === 'GET' && path === '/api/agents') {
      // 全局智能体目录：所有空间编队的并集（按 role 去重，标注来源空间），供选人入编。
      const rows = db.prepare('SELECT scope, role, name, kind, avatar FROM roster ORDER BY role, scope').all()
      const byRole = new Map()
      for (const r of rows) {
        const e = byRole.get(r.role) ?? { role: r.role, name: r.name, kind: r.kind, avatar: r.avatar, scopes: [] }
        e.scopes.push(r.scope)
        byRole.set(r.role, e)
      }
      json(res, 200, { agents: [...byRole.values()] })
      return
    }
    if (req.method === 'GET' && path === '/api/members') {
      const rows = db.prepare('SELECT * FROM members ORDER BY lastSeenAt DESC').all()
      json(res, 200, rows.map((r) => ({
        member: r.id, scope: r.scope, kind: r.kind, lastSeenAt: r.lastSeenAt,
        online: Date.now() - new Date(r.lastSeenAt ?? 0).getTime() < 60000,
      })))
      return
    }
    if (req.method === 'GET' && path === '/api/roster') {
      // 工作空间专属编队：scope 的智能体队伍 + 每人当前状态/任务（按该空间任务实时投影）。
      // 合流：编队岗位（roster.role 匹配任务的 role/soldier）之外，未入编队但认领了该空间
      // 任务的执行者（如旧士兵名）也一并返回，避免切换空间后信息丢失。
      // scope 缺省(或空)= 聚合全部空间（供「全部空间」视图），每个智能体带 scope 标注。
      const scopeParam = (url.searchParams.get('scope') ?? '').trim()
      const scopes = scopeParam
        ? [scopeParam]
        : [...new Set([
            ...db.prepare("SELECT DISTINCT scope FROM roster WHERE scope != '' ORDER BY scope").all().map(r => r.scope),
            ...db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != '' ORDER BY scope").all().map(r => r.scope),
          ])]
      const agents = []
      for (const scope of scopes) {
        const roster = db.prepare('SELECT * FROM roster WHERE scope = ? ORDER BY sort, role').all(scope)
        const rosterRoles = new Set(roster.map(r => r.role))
        const tasks = listTasks({ scope })
        const bySoldier = new Map()
        for (const t of tasks) {
          if (t.status === 'canceled' || !t.soldier) continue
          if (rosterRoles.has(t.role ?? t.soldier)) continue
          const arr = bySoldier.get(t.soldier) ?? []
          arr.push(t)
          bySoldier.set(t.soldier, arr)
        }
        const summarize = (id, label, list, kind = '', avatar = '🤖', external = false) => {
          const mine = list.filter(t => t.status !== 'done')
          const done = list.filter(t => t.status === 'done').length
          const inProgress = mine.filter(t => t.status === 'in_progress').length
          const inReview = mine.filter(t => t.status === 'in_review').length
          const blocked = mine.filter(t => t.status === 'blocked').length
          const waiting = mine.filter(t => t.status === 'todo' || t.status === 'backlog').length
          let mode = 'idle'
          if (blocked > 0) mode = 'blocked'
          else if (inReview > 0) mode = 'review'
          else if (inProgress > 0) mode = 'busy'
          const chips = []
          if (inProgress > 0) chips.push({ label: `进行中 ${inProgress}`, cls: 'green' })
          if (inReview > 0) chips.push({ label: `待验收 ${inReview}`, cls: 'yellow' })
          if (blocked > 0) chips.push({ label: `受阻 ${blocked}`, cls: 'red' })
          if (waiting > 0) chips.push({ label: `待命 ${waiting}`, cls: '' })
          if (chips.length === 0) {
            // 无在办任务：有历史则「已完成 N」，否则「待命」
            if (done > 0) chips.push({ label: `已完成 ${done}`, cls: '' })
            else chips.push({ label: '待命', cls: '' })
          }
          return {
            role: id, name: label, kind, avatar, mode, chips, done, total: list.length,
            external, scope,
            tasks: mine.map(t => ({ id: t.id, title: t.title, status: t.status })),
          }
        }
        // 编队岗位优先，再追加未入编队的活跃执行者
        for (const r of roster) {
          const mine = tasks.filter(t => t.status !== 'canceled' && (t.role ?? t.soldier) === r.role)
          agents.push(summarize(r.role, r.name, mine, r.kind, r.avatar, false))
        }
        for (const [soldier, list] of bySoldier) {
          agents.push(summarize(soldier, `${soldier} · 执行中`, list, '', '⚙️', true))
        }
      }
      json(res, 200, { scope: scopeParam || 'all', agents })
      return
    }
    if (req.method === 'GET' && path === '/api/overlaps') {
      // L3 跨任务改动重叠审计：扫描空间内所有有补丁记录的任务，按「改到同一文件」分组。
      // 8 波次并行合入场景下，两个任务改同一文件 = 潜在冲突/语义重叠，供将军决定验收与合入顺序。
      const scopeParam = url.searchParams.get('scope')
      const only = url.searchParams.get('id')
      const minTasks = Math.max(2, Number(url.searchParams.get('min') ?? 2) || 2)
      const tasks = listTasks(scopeParam ? { scope: scopeParam } : {}).filter(t => t.status !== 'canceled')
      const updatedAt = new Map(tasks.map(t => [t.id, t.updatedAt ?? t.createdAt ?? '']))
      const patchFilesOf = (p) => {
        if (!p) return []
        if (typeof p === 'string') return [p] // 旧库：纯文件名条目
        if (Array.isArray(p.files)) return p.files.map(f => (f && typeof f.path === 'string' ? f.path : '')).filter(Boolean)
        if (typeof p.files === 'string') return p.files.split(',').map(s => s.trim()).filter(Boolean)
        return []
      }
      const byFile = new Map()
      for (const t of tasks) {
        const set = new Set()
        for (const p of t.patches ?? []) for (const f of patchFilesOf(p)) set.add(f)
        if (set.size === 0) continue
        for (const f of set) {
          const arr = byFile.get(f) ?? []
          arr.push({ id: t.id, title: t.title, status: t.status, updatedAt: updatedAt.get(t.id) ?? '' })
          byFile.set(f, arr)
        }
      }
      let groups = [...byFile].map(([file, list]) => ({
        file,
        tasks: list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
      })).filter(g => g.tasks.length >= minTasks)
      if (only) groups = groups.filter(g => g.tasks.some(x => x.id === only))
      groups.sort((a, b) => {
        const ra = Math.max(...a.tasks.map(t => new Date(t.updatedAt || 0).getTime()))
        const rb = Math.max(...b.tasks.map(t => new Date(t.updatedAt || 0).getTime()))
        return rb - ra || a.file.localeCompare(b.file)
      })
      json(res, 200, { scope: scopeParam || 'all', groups })
      return
    }
    // P2-8①：浏览器助手抓取历史（按空间；serve.mjs 抓取后回写，前端读最近 N 条）。
    // 语义：同 (scope,url) 只保留一行并累加 hits —— 历史是「抓过哪些地址、结果如何」，不是逐次流水
    //（逐次审计已在 serve.mjs 的 web 审计 JSONL 里，两者分工不同，不重复记）。
    if (req.method === 'POST' && path === '/api/web/history') {
      const body = await readBody(req)
      const scope = String(body.scope ?? '').trim()
      const rawUrl = String(body.url ?? '').trim()
      if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
      if (!rawUrl) { json(res, 400, { error: '缺少 url' }); return }
      const now = new Date().toISOString()
      let host = ''
      try { host = new URL(rawUrl).host } catch { /* 非法 URL 也记：错误码本身就是历史的一部分 */ }
      const row = db.prepare('SELECT id, hits, createdAt FROM web_fetch_history WHERE scope = ? AND url = ?').get(scope, rawUrl)
      const errCode = body.errorCode == null ? null : String(body.errorCode)
      const fields = {
        finalUrl: body.finalUrl == null ? null : String(body.finalUrl),
        host,
        title: body.title == null ? null : String(body.title).slice(0, 300),
        excerpt: body.excerpt == null ? null : String(body.excerpt).slice(0, 500),
        status: Number.isFinite(Number(body.status)) ? Number(body.status) : null,
        bytes: Number.isFinite(Number(body.bytes)) ? Number(body.bytes) : null,
        ms: Number.isFinite(Number(body.ms)) ? Number(body.ms) : null,
        errorCode: errCode,
        cached: body.cached ? 1 : 0,
      }
      if (row) {
        db.prepare(`UPDATE web_fetch_history SET finalUrl = ?, host = ?, title = ?, excerpt = ?, status = ?,
                    bytes = ?, ms = ?, errorCode = ?, cached = ?, hits = hits + 1, updatedAt = ? WHERE id = ?`)
          .run(fields.finalUrl, fields.host, fields.title, fields.excerpt, fields.status, fields.bytes, fields.ms, fields.errorCode, fields.cached, now, row.id)
        json(res, 200, { ok: true, id: row.id, hits: row.hits + 1, updated: true })
        return
      }
      const id = 'wh_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
      db.prepare(`INSERT INTO web_fetch_history
                  (id, scope, url, finalUrl, host, title, excerpt, status, bytes, ms, errorCode, cached, hits, createdAt, updatedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, scope, rawUrl, fields.finalUrl, fields.host, fields.title, fields.excerpt, fields.status, fields.bytes, fields.ms, fields.errorCode, fields.cached, now, now)
      // 空间级容量上限：只保留每空间最近 N 条（防止长期使用把库撑大；被清理的地址下次抓取会重新入表）
      const overflow = Number(body.maxPerScope ?? 200)
      const cap = Number.isFinite(overflow) && overflow > 0 ? Math.min(overflow, 2000) : 200
      const count = db.prepare('SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
      let trimmed = 0
      if (count > cap) {
        trimmed = count - cap
        db.prepare(`DELETE FROM web_fetch_history WHERE scope = ? AND id IN (
                      SELECT id FROM web_fetch_history WHERE scope = ? ORDER BY updatedAt ASC LIMIT ?)`)
          .run(scope, scope, trimmed)
      }
      json(res, 200, { ok: true, id, hits: 1, updated: false, trimmed })
      return
    }
    if (req.method === 'GET' && path === '/api/web/history') {
      const scope = url.searchParams.get('scope')
      if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 200)
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      let rows = db.prepare('SELECT * FROM web_fetch_history WHERE scope = ? ORDER BY updatedAt DESC LIMIT ?').all(scope, q ? 200 : limit)
      if (q) rows = rows.filter(r => String(r.url).toLowerCase().includes(q) || String(r.title ?? '').toLowerCase().includes(q)).slice(0, limit)
      const total = db.prepare('SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
      const failed = db.prepare("SELECT COUNT(*) AS n FROM web_fetch_history WHERE scope = ? AND errorCode IS NOT NULL").get(scope).n
      const bytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM web_fetch_history WHERE scope = ?').get(scope).n
      json(res, 200, {
        scope,
        items: rows.map(r => ({
          id: r.id, url: r.url, finalUrl: r.finalUrl, host: r.host, title: r.title, excerpt: r.excerpt,
          status: r.status, bytes: r.bytes, ms: r.ms, errorCode: r.errorCode, cached: !!r.cached,
          hits: r.hits, createdAt: r.createdAt, updatedAt: r.updatedAt,
        })),
        stats: { total, failed, bytes, shown: rows.length },
      })
      return
    }
    if (req.method === 'POST' && path === '/api/web/history/clear') {
      const body = await readBody(req)
      const scope = String(body.scope ?? '').trim()
      if (!scope) { json(res, 400, { error: '缺少 scope' }); return }
      const id = body.id == null ? '' : String(body.id).trim()
      const removed = id
        ? db.prepare('DELETE FROM web_fetch_history WHERE scope = ? AND id = ?').run(scope, id).changes
        : db.prepare('DELETE FROM web_fetch_history WHERE scope = ?').run(scope).changes
      json(res, 200, { ok: true, removed })
      return
    }
    if (req.method === 'GET' && path === '/api/activity') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)
      const scopeParam = url.searchParams.get('scope')
      const taskIdParam = url.searchParams.get('taskId')
      const goalIdParam = url.searchParams.get('goalId')
      let rows
      if (goalIdParam) {
        // per-goal 活动视图：goal 事件（audit.goalId）+ 该目标链任务的 task 事件（反查 tasks.goalId）。
        rows = db.prepare(`SELECT * FROM audit WHERE goalId = ? OR (taskId IN (SELECT id FROM tasks WHERE goalId = ?)) ORDER BY seq DESC LIMIT ?`)
          .all(goalIdParam, goalIdParam, limit)
      } else if (taskIdParam) {
        rows = db.prepare('SELECT * FROM audit WHERE taskId = ? ORDER BY seq').all(taskIdParam)
      } else if (scopeParam) {
        rows = db.prepare('SELECT * FROM audit WHERE scope = ? ORDER BY seq DESC LIMIT ?').all(scopeParam, limit)
      } else {
        rows = db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
      }
      json(res, 200, rows.map(auditEvent))
      return
    }

    // ── 规范（rules）：GET/POST /api/rules（全局层维护；写走 handleWrite：by 必填 + audit rules:update + SSE）──
    if (req.method === 'GET' && path === '/api/rules') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? 'global'
        if (!validRuleScope(scopeParam)) throw new Error('scope 非法：global 或小写字母/数字开头的空间 id')
        json(res, 200, { ok: true, rules: getRule(scopeParam) })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/rules') {
      await handleWrite(req, res, (body, by) => saveRule({ scope: body.scope, content: body.content, by }))
      return
    }

    // ── 权限治理（F-02）：策略、检查与审批箱 ──
    if (req.method === 'POST' && path === '/api/permissions/check') {
      await handleWrite(req, res, (body, by) => checkPermission({ ...body, actor: body.actor ?? by }))
      return
    }
    if (req.method === 'GET' && path === '/api/permissions/inbox') {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      json(res, 200, { ok: true, requests: listPermissionInbox(url.searchParams.get('scope') || null) })
      return
    }
    if (req.method === 'POST' && path === '/api/permissions/decide') {
      await handleWrite(req, res, (body, by) => decidePermission({ ...body, by }))
      return
    }
    if (req.method === 'POST' && path === '/api/permissions/rules') {
      await handleWrite(req, res, (body, by) => upsertPermissionRule({ ...body, by }))
      return
    }
    if (req.method === 'DELETE' && path.startsWith('/api/permissions/rules/')) {
      if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
      const body = await readBody(req)
      const by = requireMember(body)
      try { json(res, 200, { ok: true, rule: deletePermissionRule(path.slice('/api/permissions/rules/'.length), by) }) }
      catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }) }
      return
    }

    // ── 技能（scope-owned + grant，借鉴 QM shared skills）──
    if (req.method === 'POST' && path === '/api/skills/register') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const name = body.name
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
        const skill = registerSkill({
          id: id.trim(), name: name.trim(), description: body.description,
          main: body.main, config: body.config, scripts: body.scripts, cases: body.cases,
          prompt: body.prompt, // 兼容旧单文本提交（映射为 bundle.main）
          scope: body.scope ?? scope, owner: by,
        })
        // register 不设 general 门禁（任意成员可提交 pending 草稿，D-2）；审计归到技能归属空间。
        audit(by, skill.scope, 'skill:submit', id, { name: skill.name, version: skill.version, skillScope: skill.scope })
        return skill
      })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/review') {
      await handleWrite(req, res, (body, by, scope) => {
        // 门禁（D-2/AC-R1-3）：复审仅 general 可执行；register 不在此列（维持现状）。
        if (by !== 'general') throw new Error('仅允许 general 执行技能复审（skill:review）')
        const id = body.id
        const action = body.action
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof action !== 'string' || action.length === 0) throw new Error('缺少参数 action')
        const skill = reviewSkill(id, action)
        audit(by, skill.scope, 'skill:review', id, { action, status: skill.status, skillScope: skill.scope })
        return skill
      })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/grant') {
      await handleWrite(req, res, (body, by, scope) => {
        // 门禁（D-2/AC-R1-3）：授权仅 general 可执行。
        if (by !== 'general') throw new Error('仅允许 general 执行技能授权（skill:grant）')
        const id = body.id
        const grants = body.grants
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (!Array.isArray(grants) || grants.length === 0) throw new Error('缺少参数 grants')
        if (body.unattended === true || body.permissionRequestId) {
          const skillForPermission = getSkill(id)
          if (!skillForPermission) throw new Error('技能不存在')
          const permission = checkPermission({ scope: skillForPermission.scope, actor: by, action: 'skill:grant', target: grants.map(String).sort().join(','), taskId: body.taskId, unattended: false, metadata: { unattended: body.unattended === true }, permissionRequestId: body.permissionRequestId })
          if (permission.status === 'pending') { const err = new Error('权限审批待处理'); err.statusCode = 202; err.permission = permission; throw err }
          if (!permission.allowed) throw new Error(`权限拒绝：${permission.reason}`)
        }
        const skill = grantSkill(id, grants.map(String))
        // 审计 detail 携带技能归属空间与目标空间（AC-R1-4）：audit.scope = 技能归属空间（跨空间操作不归错 scope）。
        audit(by, skill.scope, 'skill:grant', id, { grants: grants.map(String), skillScope: skill.scope })
        return skill
      })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/revoke') {
      await handleWrite(req, res, (body, by, scope) => {
        // 门禁（D-2/AC-R1-3）：撤销仅 general 可执行。
        if (by !== 'general') throw new Error('仅允许 general 执行技能授权撤销（skill:revoke）')
        const id = body.id
        const targets = body.targets
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (!Array.isArray(targets) || targets.length === 0) throw new Error('缺少参数 targets')
        const skill = revokeSkill(id, targets.map(String))
        audit(by, skill.scope, 'skill:revoke', id, { targets: targets.map(String), skillScope: skill.scope })
        return skill
      })
      return
    }
    // ── PRT-406：显式文档的写面（登记 / 删除）──
    //
    // 与技能写面的一处**刻意不同**：这里**没有 review 路由**。
    // 技能走「登记 → 复审 → 发布」，因为它会被员工当指令执行；文档是参考资料，
    // 登记即生效。给它加一道复审队列只会让人以为"文档也需要批准"——
    // 而审批的真实边界是 ToolGuard 与权限栈，不是这张表。
    //
    // ⚠️ `origin` **不由 body 决定**（registerDocument 里写死 'member'）：
    //   否则任何拿得到 token 的成员都能把自己的文档标成系统内容。
    if (req.method === 'POST' && path === '/api/documents') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const doc = registerDocument({
          id: id.trim(),
          title: body.title,
          path: body.path,
          body: body.body,
          // 归属空间：显式 body.scope 优先，否则用写路径解析出来的 scope
          // （与 registerSkill 同口径）。
          scope: body.scope ?? scope,
        })
        // ★ 审计的 detail 里**不带正文**：审计是"谁改了什么"的记录，
        //   把 body 塞进去等于给每一份文档另存一份全文（还包括被删掉的那些）。
        audit(by, doc.scope, 'document:register', doc.id, {
          title: doc.title, path: doc.path, version: doc.version, sha256: doc.sha256,
          docScope: doc.scope, bodyBytes: Buffer.byteLength(doc.body, 'utf8'),
        })
        return doc
      })
      return
    }
    if (req.method === 'POST' && path === '/api/documents/delete') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        // 删除前先读一次：审计要记的是"删掉了什么"，而删完之后再读就没有了。
        let before = null
        try { before = getDocument(id) } catch { before = null }
        const out = deleteDocument(id.trim())
        audit(by, before?.scope ?? scope, 'document:delete', id.trim(), {
          deleted: out.deleted, title: before?.title ?? null, version: before?.version ?? null,
        })
        return out
      })
      return
    }
    // ── 技能来源（skill-source）：每个空间绑定的团队技能仓库（github url + 分支，供一键拉取同步）──
    if (req.method === 'GET' && path === '/api/skill-source') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? 'default'
        json(res, 200, { ok: true, source: getSkillSource(scopeParam) })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/skill-source') {
      // 写入走统一 handleWrite（by 必填 + 审计 + SSE）；不设 general 门禁（只是 URL 配置，拉取时另行白名单校验）。
      await handleWrite(req, res, (body, by) => setSkillSource({ scope: body.scope, url: body.url, branch: body.branch }))
      return
    }
    // ── 对话中心（chat）：会话 / 消息 REST（scope 分区 + by 写纪律；审计/SSE 在 DAO 内统一留痕）──
    if (req.method === 'POST' && path === '/api/chat/conversations') {
      await handleWrite(req, res, (body, by) => createConversation({ ...body, by }))
      return
    }
    if (req.method === 'GET' && path === '/api/chat/conversations') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? undefined
        json(res, 200, { scope: scopeParam ?? null, conversations: listConversations({ scope: scopeParam }) })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/chat/messages') {
      await handleWrite(req, res, (body, by) => postMessage({ ...body, by }))
      return
    }
    if (req.method === 'GET' && path === '/api/chat/messages') {
      try {
        const conv = url.searchParams.get('conv')
        if (!conv) throw new Error('缺少参数 conv')
        const limitRaw = url.searchParams.get('limit')
        const beforeRaw = url.searchParams.get('before')
        const messages = listMessages({
          conv: Number(conv),
          limit: limitRaw === null ? 50 : Number(limitRaw),
          before: beforeRaw === null ? undefined : Number(beforeRaw),
        })
        json(res, 200, { conv: Number(conv), messages })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    // ── 对话附件（S3/R-3 决策 E1）：上传 PUT / 取回 GET（服务端护栏 + audit；内容不入 messages 表）──
    if (req.method === 'PUT' && path === '/api/chat/attachments') {
      try {
        if (!authorized(req)) { json(res, 401, { error: '未授权：Bearer token 无效' }); return }
        const scopeParam = (url.searchParams.get('scope') ?? '').trim()
        const byParam = (url.searchParams.get('by') ?? '').trim()
        const fileName = (url.searchParams.get('fileName') ?? '').trim()
        if (!byParam) throw new Error('缺少操作者身份 by')
        cleanupChatAttachments({ scope: scopeParam }) // 顺带孤儿/过期清理（hub 周期宿主之一）
        const buf = await readRawBody(req, CHAT_ATTACH_MAX_BYTES)
        const att = uploadChatAttachment({ scope: scopeParam, fileName, content: buf, by: byParam })
        json(res, 200, att)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const code = e && typeof e === 'object' && 'statusCode' in e ? e.statusCode : 400
        json(res, code >= 400 && code < 500 ? code : 400, { error: message })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/chat/attachments/content') {
      try {
        const scopeParam = (url.searchParams.get('scope') ?? '').trim()
        const byParam = (url.searchParams.get('by') ?? '').trim()
        const out = readChatAttachmentContent({ id: url.searchParams.get('id'), conv: url.searchParams.get('conv'), scope: scopeParam, by: byParam })
        json(res, 200, out)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const status = /不属于该会话|越权|跨会话/.test(message) ? 403 : /不存在|附件文件/.test(message) ? 404 : 400
        json(res, status, { error: message })
      }
      return
    }

    // ── 对话健康（S2/R-1 决策 B1）：只读聚合（守护在线/开关/模型解析链/最近失败）──
    if (req.method === 'GET' && path === '/api/chat/health') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? ''
        json(res, 200, chatHealth(scopeParam))
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    // ── 对话 AI 回复（R-4，S9）：reply-settings / replies 队列 / answer CAS 回写 / retry 重试 ──
    if (req.method === 'GET' && path === '/api/chat/reply-settings') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? 'default'
        if (typeof scopeParam !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scopeParam.trim())) throw new Error('scope 非法：小写字母/数字开头的空间 id（≤64 字符）')
        json(res, 200, getReplySettings(scopeParam.trim()))
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/chat/reply-settings') {
      await handleWrite(req, res, (body, by) => saveReplySettings({ ...body, by }))
      return
    }
    if (req.method === 'GET' && path === '/api/chat/replies') {
      try {
        const scopeParam = url.searchParams.get('scope')
        if (!scopeParam || scopeParam.trim().length === 0) throw new Error('缺少参数 scope')
        const sinceRaw = url.searchParams.get('sinceMsgId')
        const limitRaw = url.searchParams.get('limit')
        const since = sinceRaw === null ? 0 : Number(sinceRaw)
        if (!Number.isInteger(since) || since < 0) throw new Error('sinceMsgId 必须是 ≥0 的整数')
        const lim = limitRaw === null ? 20 : Number(limitRaw)
        if (!Number.isInteger(lim) || lim <= 0) throw new Error('limit 必须是正整数')
        const convRaw = url.searchParams.get('conv')
        const convFilter = convRaw === null ? null : Number(convRaw)
        if (convFilter !== null && (!Number.isInteger(convFilter) || convFilter <= 0)) throw new Error('conv 必须是会话 id')
        let messages = listAwaitingReplies({ scope: scopeParam.trim(), sinceMsgId: since, limit: lim })
        if (convFilter !== null) messages = messages.filter(m => m.convId === convFilter)
        json(res, 200, { scope: scopeParam.trim(), sinceMsgId: since, limit: lim, messages })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/chat/replies/answer') {
      // 回复方应答：body { msgId, body, model?, kind? }；by 须为回复方身份（author=by 防冒名在 DAO 内绑定）。
      await handleWrite(req, res, (body, by) => postAiReply({ ...body, by }))
      return
    }
    if (req.method === 'POST' && path === '/api/chat/replies/fail') {
      // 守护 chat-responder 显式失败回写（body: msgId + error + by；CAS awaiting→failed，幂等）。
      await handleWrite(req, res, (body, by) => failAiReply({ ...body, by }))
      return
    }
    if (req.method === 'POST' && path === '/api/chat/replies/retry') {
      // UI 失败重试：把 failed 的 awaiting 源消息重置回 awaiting。
      await handleWrite(req, res, (body, by) => retryAiReply({ ...body, by }))
      return
    }

    // ── 日程日历（calendar）：事件 REST（scope 必填写纪律 + audit/SSE；写走 handleWrite，见 S5/R-B1 数据面）──
    // P2-5：+ 更新（局部）/ 冲突检测（只读提示，不阻断）/ 关联查询（taskId|goalId，供任务详情双向展示）；
    //       列表带日期窗时对重复事件做**实例展开**（occurrenceDate/recurring）。
    if (req.method === 'GET' && path === '/api/calendar/events') {
      try {
        const scopeParam = url.searchParams.get('scope') ?? undefined
        const from = url.searchParams.get('from') ?? undefined
        const to = url.searchParams.get('to') ?? undefined
        json(res, 200, { scope: scopeParam ?? null, events: listCalendarEvents({ scope: scopeParam, from, to }) })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/calendar/conflicts') {
      try {
        const scopeParam = url.searchParams.get('scope')
        if (!scopeParam || scopeParam.trim().length === 0) throw new Error('缺少参数 scope')
        const conflicts = findCalendarConflicts({
          scope: scopeParam.trim(),
          start: url.searchParams.get('start'),
          end: url.searchParams.get('end'),
          allDay: url.searchParams.get('allDay') === '1' || url.searchParams.get('allDay') === 'true',
          excludeId: url.searchParams.get('excludeId'),
        })
        json(res, 200, { scope: scopeParam.trim(), conflicts })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/calendar/events/by-link') {
      try {
        const events = listCalendarEventsByLink({
          taskId: url.searchParams.get('taskId'),
          goalId: url.searchParams.get('goalId'),
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
        })
        json(res, 200, { taskId: url.searchParams.get('taskId') ?? null, goalId: url.searchParams.get('goalId') ?? null, events })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/calendar/events') {
      await handleWrite(req, res, (body, by) => createCalendarEvent({ ...body, by }))
      return
    }
    if (req.method === 'POST' && path === '/api/calendar/events/update') {
      await handleWrite(req, res, (body, by) => updateCalendarEvent({ ...body, by }))
      return
    }
    if (req.method === 'POST' && path === '/api/calendar/events/delete') {
      await handleWrite(req, res, (body, by) => deleteCalendarEvent({ ...body, by }))
      return
    }

    // ── 工作空间 + 编队管理 ──
    if (req.method === 'POST' && path === '/api/spaces') {
      // 注册/更新工作空间（幂等 upsert：id + name 必填）。除 private 外支持仓库绑定：
      // localDir = 本地文件夹（该空间对应的本机目录），remoteUrl = 远程仓库 URL（空 = 仅本地/不进共享仓库）。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const name = body.name
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
        if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
        const localDir = typeof body.localDir === 'string' ? body.localDir.trim() : ''
        const remoteUrl = typeof body.remoteUrl === 'string' ? body.remoteUrl.trim() : ''
        if (localDir.length > 512) throw new Error('localDir 过长（≤512 字符）')
        if (remoteUrl.length > 1024) throw new Error('remoteUrl 过长（≤1024 字符）')
        const existed = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
        db.prepare(`INSERT INTO spaces (id, name, private, local_dir, remote_url, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, private=excluded.private, local_dir=excluded.local_dir, remote_url=excluded.remote_url, updatedAt=excluded.updatedAt`)
          .run(id, name.trim(), body.private ? 1 : 0, localDir, remoteUrl, now(), now())
        const count = db.prepare('SELECT COUNT(*) AS c FROM roster WHERE scope = ?').get(id).c
        audit(by, scope, existed ? 'space:update' : 'space:create', null, { space: id, name: name.trim(), private: !!body.private, localDir, remoteUrl })
        return { id, name: name.trim(), private: !!body.private, localDir, remoteUrl, agentCount: count }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/pipeline') {
      // SP-P0：写入空间流水线（阶段契约 + 执行配置）。整批 upsert（含删除未提交的旧阶段）。
      // 校验在写入期完成：role 形状/唯一性、next 可达、gate 必须有 artifact、docs 必须是仓库相对路径。
      // 编队与流水线的一致性**不在此处硬拦**（便于先配流水线后选人入编），由 GET /api/spaces/provision 报给将军。
      await handleWrite(req, res, (body, by, scope) => {
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        if (!SCOPE_KEY_RE.test(targetScope)) throw new Error('scope 非法（字母/数字/下划线/连字符，≤64 字符）')
        if (body.by !== 'general' && by !== 'general' && body.forceGeneral !== true) throw new Error('流水线配置仅允许 general 执行（body.by 或操作者身份须为 general）')
        const stages = normalizeStages(targetScope, body.stages)
        const runtime = body.runtime === undefined ? null : normalizeRuntime(body.runtime)
        const result = withTx(() => {
          const prevRoles = new Set(db.prepare('SELECT role FROM space_stages WHERE scope = ?').all(targetScope).map(r => r.role))
          const upsert = db.prepare(`INSERT INTO space_stages (scope, role, label, prompt, next, gate, artifact, docs, sort, enabled, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, role) DO UPDATE SET label=excluded.label, prompt=excluded.prompt, next=excluded.next,
              gate=excluded.gate, artifact=excluded.artifact, docs=excluded.docs, sort=excluded.sort, enabled=excluded.enabled, updatedAt=excluded.updatedAt`)
          const ts = now()
          for (const s of stages) {
            upsert.run(targetScope, s.role, s.label, s.prompt, s.next, s.gate, s.artifact, s.docs === null ? null : JSON.stringify(s.docs), s.sort, s.enabled, ts)
          }
          const keep = stages.map(s => s.role)
          const dropped = [...prevRoles].filter(r => !keep.includes(r))
          if (dropped.length > 0) {
            const del = db.prepare('DELETE FROM space_stages WHERE scope = ? AND role = ?')
            for (const r of dropped) del.run(targetScope, r)
          }
          if (runtime !== null) {
            db.prepare(`INSERT INTO space_runtime (scope, enabled, maxWorkers, isolate, updatedAt) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled, maxWorkers=excluded.maxWorkers, isolate=excluded.isolate, updatedAt=excluded.updatedAt`)
              .run(targetScope, runtime.enabled ? 1 : 0, runtime.maxWorkers, runtime.isolate ? 1 : 0, ts)
          }
          audit(by, targetScope, 'pipeline:update', null, {
            stages: stages.length,
            added: stages.filter(s => !prevRoles.has(s.role)).map(s => s.role),
            dropped,
            runtime,
          })
          return { scope: targetScope, stages: stages.length, dropped, added: stages.filter(s => !prevRoles.has(s.role)).length, runtime }
        })
        const view = readPipeline(targetScope)
        return { ...result, version: view.version, activeRoles: view.activeRoles, warnings: pipelineWarnings(targetScope, view) }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/spaces/impact') {
      // 删除预检（只读，AC-R3-1）：返回该空间将影响的数据面计数 + 在办执行状态；调用不产生 audit/SSE。
      try {
        const id = url.searchParams.get('id') ?? ''
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
        const existing = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
        if (!existing) throw new Error(`未知空间 ${id}`)
        const countOf = (sql) => db.prepare(sql).get(id).c
        const counts = {
          tasks: countOf('SELECT COUNT(*) AS c FROM tasks WHERE scope = ?'),
          roster: countOf('SELECT COUNT(*) AS c FROM roster WHERE scope = ?'),
          agentModels: countOf('SELECT COUNT(*) AS c FROM agent_models WHERE scope = ?'),
          execRequests: countOf('SELECT COUNT(*) AS c FROM exec_requests WHERE scope = ?'),
          skills: countOf('SELECT COUNT(*) AS c FROM skills WHERE scope = ?'),
          goal: countOf('SELECT COUNT(*) AS c FROM goal WHERE scope = ?'),
          execState: countOf('SELECT COUNT(*) AS c FROM exec_state WHERE scope = ?'),
          conversations: countOf('SELECT COUNT(*) AS c FROM conversations WHERE scope = ?'),
          messages: countOf('SELECT COUNT(*) AS c FROM messages WHERE scope = ?'),
          calendarEvents: countOf('SELECT COUNT(*) AS c FROM calendar_events WHERE scope = ?'),
          members: countOf('SELECT COUNT(*) AS c FROM members WHERE scope = ?'),
          chatReplySettings: countOf('SELECT COUNT(*) AS c FROM chat_reply_settings WHERE scope = ?'),
          chatAttachments: countOf('SELECT COUNT(*) AS c FROM chat_attachments WHERE scope = ?'),
          rules: countOf('SELECT COUNT(*) AS c FROM rules WHERE scope = ?'),
          skillSources: countOf('SELECT COUNT(*) AS c FROM skill_sources WHERE scope = ?'),
          spaceStages: countOf('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?'),
          spaceRuntime: countOf('SELECT COUNT(*) AS c FROM space_runtime WHERE scope = ?'),
        }
        const running = db.prepare("SELECT id, title, status FROM tasks WHERE scope = ? AND status IN ('in_progress','in_review','blocked') ORDER BY id").all(id)
        json(res, 200, { id, counts, running: { tasks: running } })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'GET' && path === '/api/spaces/provision') {
      // SP-P0 开通预检（只读，不产生 audit/SSE）：把「这个空间现在能不能自动循环」变成一份可执行清单。
      // 直接对治 T-127 现场：目标发布成功、链也建对了，却因为「没有绑定的守护实例 / 编队与流水线不一致」
      // 静默停在 todo 十几小时，而指挥台没有任何提示。
      try {
        const id = (url.searchParams.get('id') ?? '').trim()
        if (!SCOPE_KEY_RE.test(id)) throw new Error('空间 id 非法（字母/数字/下划线/连字符，≤64 字符）')
        const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id)
        const roster = db.prepare('SELECT role, name FROM roster WHERE scope = ? ORDER BY sort, role').all(id)
        const view = readPipeline(id)
        const checks = []
        const add = (level, code, message, fix = null) => checks.push({ level, code, message, fix })

        // 1) 空间注册（warn 而非 error：未注册的 scope 仍可跑通循环——夹具 __p13fixture__ 即如此；
        //    真正的后果是「无工作区绑定 → 回落注入默认仓库」，由下面的 workspace-unbound 一并说明）
        if (!space) add('warn', 'space-missing', `空间 ${id} 未注册（spaces 表无记录）——无工作区绑定，守护会回落到注入的默认仓库根`, `POST /api/spaces {id:"${id}", name:"…", localDir:"<仓库路径>"}`)

        // 2) 编队
        if (roster.length === 0) add('warn', 'roster-empty', '该空间编队为空——发布目标无法生成任何阶段任务', '指挥台「空间设置 → 智能体」选人入编')

        // 3) 流水线（含编队一致性）
        if (view.stages.length === 0) {
          add('error', 'pipeline-missing', '该空间未配置流水线——守护按角色过滤时会跳过全部任务（或建链退回全编队造成死锁）',
            `POST /api/pipeline {scope:"${id}", stages:[…]}（或 node team-hub/scripts/seed-pipeline.mjs --scope ${id} --file <roles.json>）`)
        } else {
          add('ok', 'pipeline-configured', `流水线 ${view.activeRoles.length} 环：${view.activeRoles.join(' → ')}（version ${view.version}）`)
        }
        // pipelineWarnings 会在「流水线为空且编队非空」时再报一次 pipeline-missing：
        // 上面那条已给出可执行的修复命令（seed-pipeline），故此处按 code 去重（含前面已加入的项），
        // 避免清单里出现两条同名阻塞项。
        const addedCodes = new Set(checks.map(c => c.code))
        for (const w of pipelineWarnings(id, view)) {
          if (addedCodes.has(w.code)) continue
          addedCodes.add(w.code)
          add(w.level, w.code, w.message, null)
        }

        // 4) 执行配置
        if (!view.runtime.enabled) {
          add('warn', 'runtime-disabled', '该空间执行配置未开启（space_runtime.enabled=false）——P1 起守护据此跳过该空间', `POST /api/pipeline {scope:"${id}", runtime:{enabled:true}}`)
        }

        // 5) 守护实例在线（当前部署形态：一个空间一个守护实例/scope）
        const nowMs = Date.now()
        const workers = db.prepare("SELECT id, lastSeenAt FROM members WHERE kind = 'worker' AND scope = ?").all(id)
        const online = workers.filter(w => nowMs - new Date(w.lastSeenAt ?? 0).getTime() < 60000)
        if (online.length === 0) {
          add('error', 'daemon-offline', workers.length > 0
            ? `守护实例过期心跳（最后 ${workers[0].lastSeenAt}）——目标链不会被认领`
            : `该空间没有守护实例（无 scope=${id} 的 worker 心跳）——这是目标停在 todo 的最常见原因`,
          `在 DSH profile 的 cordis.patch.yml 增加一行 legion-scrum-worker-${id}（scope:"${id}"、rolesFile 指向该空间流水线导出文件）`)
        } else {
          add('ok', 'daemon-online', `守护实例在线：${online.map(w => w.id).join('、')}`)
        }

        // 6) 工作区绑定（隔离 worktree / 合入都依赖它）
        const localDir = space?.local_dir ?? ''
        if (localDir.length === 0) {
          add('warn', 'workspace-unbound', '未绑定本地文件夹（localDir）——守护会回落到注入的默认仓库根，产物可能落在错误目录', `POST /api/spaces {id:"${id}", name:"…", localDir:"<仓库路径>"}`)
        } else if (!existsSync(localDir)) {
          add('error', 'workspace-missing', `绑定的本地文件夹不存在：${localDir}`, '修正 localDir 或先 clone 该仓库')
        } else if (!existsSync(join(localDir, '.git'))) {
          add('warn', 'workspace-not-git', `绑定的文件夹不是 git 仓库：${localDir}——无法做 w/<任务ID> 隔离与自动合入`, '绑定一个 git 仓库（或使用 P2 的无仓库模式）')
        } else {
          let ignoreWarn = null
          try {
            const gi = readFileSync(join(localDir, '.gitignore'), 'utf8')
            if (!gi.includes('.legion-worktrees')) ignoreWarn = '绑定仓库的 .gitignore 未忽略 .legion-worktrees/（隔离工作树会污染 git status）'
          } catch { ignoreWarn = '绑定仓库没有 .gitignore（建议忽略 .legion-worktrees/）' }
          if (ignoreWarn !== null) add('warn', 'worktree-not-ignored', ignoreWarn, '在绑定仓库 .gitignore 追加一行 .legion-worktrees/')
          else add('ok', 'workspace-bound', `工作区绑定可用：${localDir}（git 仓库）`)
        }

        // 7) 在办任务可见性
        const running = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope = ? AND status IN ('in_progress','in_review')").get(id).c
        const todo = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope = ? AND status = 'todo'").get(id).c
        if (todo > 0 && online.length === 0) add('error', 'queue-stalled', `有 ${todo} 个 todo 任务但没有在线守护——队列不会前进`)
        else add('ok', 'queue-visible', `队列：todo ${todo} / 在办 ${running}`)

        json(res, 200, {
          id,
          name: space?.name ?? id,
          ok: !checks.some(c => c.level === 'error'),
          checkedAt: now(),
          pipeline: { version: view.version, stages: view.stages.length, activeRoles: view.activeRoles },
          runtime: view.runtime,
          checks,
        })
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
    if (req.method === 'POST' && path === '/api/spaces/delete') {
       // 删除工作空间及其 scope 数据（级联所有 scope 表 + uploads/<scope> 文件；audit 行保留供追溯）。
      // 安全护栏：software/default 等受保护空间一律拒绝；调用方须显式 confirm=`delete-space:<id>`。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
        if (id === 'software' || id === 'default') throw new Error(`受保护空间 ${id} 不可删除`)
        if (body.confirm !== `delete-space:${id}`) throw new Error('缺少确认：confirm 须为 delete-space:<id>（该操作会删除该空间全部任务/目标/编队/模型/技能/对话/日程数据）')
        if (by !== 'general' && body.forceGeneral !== true) throw new Error('删除空间仅允许 general 执行')
        const existing = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
        if (!existing) throw new Error(`未知空间 ${id}`)
        const removed = withTx(() => {
          const counts = {}
          for (const [key, sql] of [
            ['tasks', 'DELETE FROM tasks WHERE scope = ?'],
            ['roster', 'DELETE FROM roster WHERE scope = ?'],
            ['agentModels', 'DELETE FROM agent_models WHERE scope = ?'],
            ['execRequests', 'DELETE FROM exec_requests WHERE scope = ?'],
            ['skills', 'DELETE FROM skills WHERE scope = ?'],
            ['goal', 'DELETE FROM goal WHERE scope = ?'],
            ['execState', 'DELETE FROM exec_state WHERE scope = ?'],
             ['conversations', 'DELETE FROM conversations WHERE scope = ?'],
             ['messages', 'DELETE FROM messages WHERE scope = ?'],
             ['calendarEvents', 'DELETE FROM calendar_events WHERE scope = ?'],
             ['members', 'DELETE FROM members WHERE scope = ?'],
             ['chatReplySettings', 'DELETE FROM chat_reply_settings WHERE scope = ?'],
             ['chatAttachments', 'DELETE FROM chat_attachments WHERE scope = ?'],
             ['rules', 'DELETE FROM rules WHERE scope = ?'],
             ['skillSources', 'DELETE FROM skill_sources WHERE scope = ?'],
             ['spaceStages', 'DELETE FROM space_stages WHERE scope = ?'],
             ['spaceRuntime', 'DELETE FROM space_runtime WHERE scope = ?'],
           ]) counts[key] = db.prepare(sql).run(id).changes
           db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
           return counts
         })
         // scope 已通过严格正则校验；附件路径约定为 uploads/<scope>/<sha1>，删除整个空间目录以清理孤儿文件。
         const scopeUploads = join(UPLOADS_ROOT, id)
         try { rmSync(scopeUploads, { recursive: true, force: true }) } catch { /* 文件清理失败不回滚已完成的 DB 删除 */ }
         audit(by, id, 'space:delete', null, { space: id, removed })
        return { id, removed }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/goal') {
      // 发布目标（多目标并发）：每次都**新建**一个目标记录（G-xxx，status=active，version=1），
      // 并为其生成独立阶段任务链（链任务全部挂 goalId）。**不取消**该空间既有目标/旧链任务——
      // 多个目标可并存、各自的链由守护并行推进；将军可对单个目标 暂停/恢复/取消（/api/goal/status）。
      await handleWrite(req, res, (body, by, scope) => {
        const objective = body.objective
        if (typeof objective !== 'string' || objective.trim().length === 0) throw new Error('缺少参数 objective')
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        // RC-2：body.docSync / body.feature=true → 目标级 docSync 声明（链上 coder 任务承接，见 createGoalChain）
        const docSync = body.docSync === true || body.feature === true
        return publishGoalRecord(targetScope, objective, body.mode === 'slice' ? 'slice' : 'chain', by, docSync)
      })
      return
    }
    if (req.method === 'POST' && path === '/api/goal/context') {
      // 目标级上下文（同目标共享上下文）：仅将军；bump contextVersion；审计 + SSE。
      // 语义 = 下一派工对齐：正在跑的 worker 不打断，下一次派工注入最新 context/版本（守护写镜像 docs/goals/<id>.md）。
      await handleWrite(req, res, (body, by) => setGoalContext(body.id, body.text, by, body.forceGeneral === true))
      return
    }
    if (req.method === 'POST' && path === '/api/goal/status') {
      // 目标状态生命周期（仅将军）：active ↔ paused；done/canceled 终态（见 setGoalState）。
      await handleWrite(req, res, (body, by) => setGoalState(body.id, body.status, by, body.forceGeneral === true))
      return
    }
    if (req.method === 'POST' && path === '/api/agents') {
      await handleWrite(req, res, (body, by, scope) => {
        const role = body.role
        const name = body.name
        if (typeof role !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(role)) throw new Error('智能体 role 非法：小写字母/数字开头，可含连字符，≤64 字符')
        if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope

        // ★ PRT-402：编队那一行与岗位清单必须**一起成或一起不成**。
        //
        // 这是用例 `★ 边界内容里带明文密钥 → 拒绝，且编队那一行也不该被写进去`
        // **量出来的**：第一版没有包事务，于是清单写失败时编队那一行**已经落库**了，
        // 结果是"编队里有这个人、但他的清单没有"——而那种状态看起来一切正常
        // （列表里有他、任务照样派给他），只是他的岗位边界永远是 `missing`。
        //
        //   > 一个"先写编队再写清单、失败就报错"的接口，
        //   > 与一个"两件事在同一个事务里"的接口，在清单从不失败的时候是同一个东西——
        //   > 只不过前者会在清单失败的那一次留下一个**半成品**，
        //   > 而调用方从错误响应里看不出编队已经被改了。
        return withTx(() => {
        const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM roster WHERE scope = ?').get(targetScope).s
        db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar`)
          .run(targetScope, role.trim(), name.trim(),
            typeof body.kind === 'string' ? body.kind : '',
            typeof body.avatar === 'string' && body.avatar.trim() ? body.avatar.trim() : '🤖', sort)
        audit(by, targetScope, 'agent:create', null, { role: role.trim(), name: name.trim() })

        // ── PRT-402：编队变更时同步写一份岗位清单 ───────────────────────
        //
        // 这是 EmployeeManifest 的**生产触发点**：在此之前的实情是"表有了、
        // 读端点了、装载器会读了，但没有任何地方写"——与 `TeamPlan` 那半边同源。
        //
        // ★ **只有在调用方真的给了边界内容时才写。** 编队记录本来只有
        //   role/name/kind/avatar，没有"允许用什么工具、要不要审批"。
        //   此时若替它写一份**空**清单，`allowedTools: []` 会被模型读成
        //   "这个岗位不允许使用任何工具"——那是一条**假规则**。
        //
        //   > 一个"没配置就写一份空清单"的实现，与一个"没配置就不写"的实现，
        //   > 在界面上都显示"没有"——只不过前者会让模型读到一条它自己
        //   > 编出来的岗位规则，而那句话会**改变它的行为**。
        //
        //   不写，装载器就产出一条带原因的 `missing`（"这次运行没有关联任何
        //   员工清单"），那才是实话。
        //
        // ★ `employeeId` 是**岗位在这个空间里的地址**，不是一个人。
        //   hub 的编队是按 role 的（`roster(scope, role)`），没有"某个员工"
        //   这个实体；写一个凭空的个人 id 比写这个可读地址更坏。
        //   调用方要给真身份就显式传 `employeeId`。
        const boundary = {
          responsibilities: body.responsibilities,
          allowedTools: body.allowedTools,
          deniedTools: body.deniedTools,
          approvalPolicy: body.approvalPolicy,
          limits: body.limits,
        }
        const hasBoundary = Object.values(boundary).some((v) => v !== undefined && v !== null)
        let manifestRef = null
        if (hasBoundary) {
          const written = contextPlanStore().putEmployeeManifest({
            role: role.trim(),
            employeeId: typeof body.employeeId === 'string' && body.employeeId.trim() !== ''
              ? body.employeeId.trim()
              : `${targetScope}/${role.trim()}`,
            displayName: name.trim(),
            responsibilities: boundary.responsibilities ?? [],
            allowedTools: boundary.allowedTools ?? [],
            deniedTools: boundary.deniedTools ?? [],
            approvalPolicy: boundary.approvalPolicy ?? null,
            limits: boundary.limits ?? {},
          }, { scope: targetScope, actor: by })
          manifestRef = { role: written.manifest.role, version: written.manifest.version, created: written.created }
        }

        return { scope: targetScope, role: role.trim(), name: name.trim(), employeeManifest: manifestRef }
        })
      })
      return
    }
    if (req.method === 'POST' && path.startsWith('/api/spaces/') && path.endsWith('/agents')) {
      // 选人入编：把全局目录中的若干智能体（按 role）复制进该空间编队。
      await handleWrite(req, res, (body, by, scope) => {
        const id = decodeURIComponent(path.slice('/api/spaces/'.length, -'/agents'.length))
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法')
        if (!Array.isArray(body.roles) || body.roles.length === 0) throw new Error('缺少参数 roles（智能体 role 数组）')
        const roles = [...new Set(body.roles.map(String))]
        const placeholders = roles.map(() => '?').join(',')
        const rows = db.prepare(`SELECT role, name, kind, avatar FROM roster WHERE role IN (${placeholders})`).all(...roles)
        const byRole = new Map()
        for (const r of rows) if (!byRole.has(r.role)) byRole.set(r.role, r)
        const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM roster WHERE scope = ?').get(id).s
        let added = 0
        for (const role of roles) {
          const src = byRole.get(role)
          if (!src) continue
          db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar`)
            .run(id, src.role, src.name, src.kind, src.avatar, sort + added)
          added += 1
        }
        audit(by, id, 'space:add-agents', null, { roles })
        return { space: id, added, roles }
      })
      return
    }
    if (req.method === 'GET' && path === '/api/skills') {
      // include=pending 收口（AC-R1-7）：仅 member=general（复审身份）可看 pending/rejected 及其 prompt；
      // 其余任何查询（含 scope/member 全缺省的「全部空间」视图）一律只返回 published，草稿不外泄。
      const reviewerView = url.searchParams.get('member') === 'general'
      const wantPending = reviewerView && url.searchParams.get('include') === 'pending'
      const skillId = url.searchParams.get('id')
      if (skillId) {
        try {
          const s = getSkill(skillId)
          // 未发布且非复审视角 → 对普通成员按「不存在」处理，不泄露待审内容
          if (s.status !== 'published' && !wantPending) {
            json(res, 404, { error: `skill_not_found: ${skillId}` })
            return
          }
          json(res, 200, s)
        } catch (e) {
          json(res, 404, { error: e instanceof Error ? e.message : String(e) })
        }
        return
      }
      json(res, 200, listSkills({
        scope: url.searchParams.get('scope') ?? undefined,
        member: url.searchParams.get('member') ?? undefined,
        includePending: wantPending,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/documents') {
      // ★ PRT-406：显式文档读端点（`document` 来源族的唯一出处）。
      //
      //   形状与 `/api/skills` **刻意不同**：技能返回 `prompt`（会被当指令执行的
      //   那一段），文档返回 `body`（参考资料）。两者都带 `origin`，于是装配侧
      //   可以**逐条**判可信性，而不是整批一刀切。
      //
      //   ⚠️ `origin` 是**服务端写死**的字段（见 registerDocument / installDocument），
      //   客户端改不动——这正是它能被用来做判定前提的原因。
      //
      //   与 `/api/skills` 的另一个不同：**没有 status 过滤**。文档不走向导机
      //   （理由见 listDocuments 的注释）。
      json(res, 200, listDocuments({
        scope: url.searchParams.get('scope') ?? undefined,
        id: url.searchParams.get('id') ?? undefined,
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/events') {
      let eventScope
      let sinceSeq
      try {
        eventScope = parseEventScope(url.searchParams.get('scope'))
        sinceSeq = parseSinceSeq(url.searchParams.get('sinceSeq'))
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        return
      }
      // 订阅者身份三项：`clientId` 由前端持久化（与它自己的游标成对），
      // `kind` 区分来源（workbench / board / 未来的外部渠道）。
      const clientId = url.searchParams.get('clientId')
      const clientKind = url.searchParams.get('kind') ?? 'workbench'
      const subscriberId = subscriberIdFor({ clientId, kind: clientKind, scope: eventScope })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      const client = { res, scope: eventScope, subscriberId, kind: typeof clientKind === 'string' ? clientKind : 'workbench' }
      eventClients.add(client)
      // 登记进投递仓储（失败不阻止连接：只读面必须继续可用）。
      registerEventClient(client)
      // Last-Event-ID 断线续传（P2-3 S2）：带合法序号则只回放 seq > N 的增量；
      // 无/非法则回放最近 30 条（契约 §6.2：seq 单调，配合 id: 行 EventSource 原生续传）。
      //
      // ★ F-05：`Last-Event-ID` 头**只是客户端的一面之词**，所以它不推进服务端游标。
      //   服务端游标由**真的写成功过**的投递推进（`markDelivered` → `advanceCursor`），
      //   那是唯一一个"字节确实出去了"的证据。两者是不同的东西：
      //   头部说的是"我收到过哪一条"，游标说的是"我们确实投到了哪一条"。
      const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10)
      const cursor = Number.isFinite(lastEventId) ? lastEventId : sinceSeq
      const where = []
      const params = []
      let replay
      if (eventScope !== undefined) {
        where.push('scope = ?')
        params.push(eventScope)
      }
      if (cursor !== null && cursor !== undefined) {
        where.push('seq > ?')
        params.push(cursor)
        replay = db.prepare(`SELECT * FROM audit WHERE ${where.join(' AND ')} ORDER BY seq ASC`).all(...params)
      } else {
        replay = db.prepare(`SELECT * FROM audit${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT 30`).all(...params).reverse()
      }
      // 回放帧**同样要走投递记账**：回放是投递的一种，把历史的洞补上也算投出去。
      // 这里逐条写而不是走 `broadcastAudit`（那条路径是"广播给所有人"，
      // 而回放只写给**这一个**订阅者）。一条回放失败不影响其余条目。
      for (const r of replay) {
        const entry = auditEvent(r)
        let frame = { ok: false, reason: 'not-attempted' }
        try {
          withTx(() => {
            deliveryStore.plan({ subscriberId, events: [{ seq: entry.seq, scope: entry.scope ?? null, event: entry.event }] })
            const taken = deliveryStore.takeUp({ subscriberId, seqs: [entry.seq] })
            if (taken.claimed.length === 1) {
              frame = writeEventFrame(res, entry)
              if (frame.ok === true) deliveryStore.markDelivered({ subscriberId, seqs: [entry.seq] })
              else deliveryStore.markFailed({ subscriberId, seqs: [entry.seq], error: frame.reason ?? '回放写失败' })
            } else {
              // 已经是终态（投过了/被抑制）——补投会被 CAS 拒，这正是想要的。
              frame = { ok: true, skipped: true }
            }
          })
        } catch {
          deliveryBookkeepingFailures += 1
          // 记账失败时仍然把帧写出去：**宁可少一条记录，不可少一帧**。
          frame = writeEventFrame(res, entry)
        }
        if (frame.ok !== true && frame.reason !== undefined && frame.reason !== 'not-attempted') {
          // 连接已经不可写：继续回放没有意义，直接收尾。
          break
        }
      }
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
      req.on('close', () => { clearInterval(heartbeat); eventClients.delete(client) })
      return
    }
    if (req.method === 'GET' && path === '/api/event-delivery') {
      // F-05 投递读数（只读）：**"发不出去也不说"这件事本身要能被看见**。
      //
      // 三种问法：
      //   · 不带 subscriberId → 全部订阅者的六态汇总（诊断页用）；
      //   · 带 subscriberId   → 这一个订阅者的完整读数（含 `oldestOutstandingSeq`）；
      //   · `?recover=1`      → 顺手回收租约过期的 `delivering` → `unknown`。
      //
      // `recover` 做成**显式动作而不是每次读都顺手做**：回收会把 `delivering`
      // 写死成 `unknown`（终态、不可自动重投），那是一个会改变后续行为的写操作，
      // 不该藏在一次 GET 里。谁要它，谁说出来。
      const subscriberId = url.searchParams.get('subscriberId')
      const wantRecover = url.searchParams.get('recover') === '1'
      const recovered = wantRecover ? deliveryStore.recoverExpired() : { recovered: [] }
      if (subscriberId !== null && subscriberId.length > 0) {
        const st = deliveryStore.stateOf(subscriberId)
        if (st.exists !== true) {
          json(res, 404, { ok: false, error: `订阅者不存在：${subscriberId}`, code: 'SUBSCRIBER_NOT_FOUND', serverTimeMs: Date.now() })
          return
        }
        json(res, 200, {
          ok: true,
          subscriber: st,
          rows: deliveryStore.rowsOf(subscriberId, { limit: 200 }),
          recovered: recovered.recovered,
          bookkeepingFailures: deliveryBookkeepingFailures,
          serverTimeMs: Date.now(),
        })
        return
      }
      json(res, 200, {
        ok: true,
        ...deliveryStore.summary(),
        recovered: recovered.recovered,
        bookkeepingFailures: deliveryBookkeepingFailures,
        liveConnections: eventClients.size,
      })
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      // `runPlane: true` 是能力发现位（PRT-301 起）：worker 用它判断「这个 hub 支不支持
      // 带 epoch 的运行面」。没有这个位时，一个升级了一半的部署（hub 还是旧的）
      // 会让 worker 收到 404，而 404 的文案无法区分「路由不存在」与「路径拼错」。
      //
      // PRT-413 加一栏 `tokenizer`：**"配了目录"与"真的用上了"是两件事**，
      // 而它们只在 `tokens.kind` 里分得开——那个字段没人会去看，除非已经超限。
      // 这里把它变成可探测的。★ `status()` **不读盘、不抛错**，
      // 所以这个免鉴权的探测端点不会因为一个坏词表目录而变慢或 500
      // （真正的读盘发生在第一次需要 tokenizer 时，失败会在那次请求上抛出）。
      //
      // F-05 加一栏 `eventDelivery`：投递记账是**旁路**，它的失败被刻意设计成
      // 不影响审计。一个被刻意设计成"不影响主流程"的失败，若没有任何地方能看见，
      // 就会永远没人知道——所以它必须在这里有一个读数。
      json(res, 200, {
        auth: TOKEN !== '', db: DB_FILE, port: PORT, runPlane: true,
        tokenizer: tokenizerRegistryStatus(),
        eventDelivery: {
          // 能力发现位：老客户端不认识它就不传 `clientId`，退化成匿名订阅者（不共用游标）。
          subscribers: true,
          bookkeepingFailures: deliveryBookkeepingFailures,
          liveConnections: eventClients.size,
        },
      })
      return
    }

    if (req.method === 'GET' && path === '/api/artifact/content') {
      // R-3/S3 只读内容端点：任务登记产物文件内容（task + i；i 缺省取最新一条）。
      const result = artifactContent(url.searchParams.get('task') ?? '', url.searchParams.get('i') ?? undefined)
      json(res, result.status, result.body)
      return
    }

    json(res, 404, { error: `not found: ${path}` })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (res.headersSent) {
      // 已经发过响应的异常**不能就这么 `end()` 掉**：那会让"响应发出之后
      // 才炸"这件事完全不留痕迹，而这正是最难查的一类问题（客户端看到
      // 一个正常的响应，服务端没有任何记录）。至少要留下一条记录。
      console.error(`[team-hub] 响应已发出后仍抛出异常：${message}`)
      res.end()
    } else json(res, 500, { error: message })
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res)
})

/**
 * P1-1 宿主集成：dispose 当前 v2 实例的 SSE 客户端（宿主插件 teardown 时调用；
 * 心跳 interval 随各连接 req close 自清；附件清理 interval 仅独立进程 isMain 时存在且 unref）。
 *
 * F-05：连接断开**不再等于**没投出去。`res.end()` 只是把 socket 关掉——
 * 此刻若有 `delivering` 的行，它们会一直挂到租约过期。这里**不**顺手把它们
 * 标成 `delivered` 或 `failed`：进程退出时我们同样不知道字节到没到，
 * 唯一诚实的处置是留给租约回收（→ `unknown`）。
 * 所以本函数只做"关连接 + 清集合"，并**不**推进任何投递状态。
 */
export function disposeHub() {
  for (const client of eventClients) client.res.end()
  eventClients.clear()
}

// 直接运行（node server.mjs）才监听；被 import 时（测试/复用）不占端口。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  console.log(configSummaryLine()) // P3-2：启动即打印脱敏后的最终配置（token 只显示是否设置）
  validateSecurityConfig()
  server.listen(PORT, HOST, () => {
    console.log(`[team-hub] v2 独立服务已启动：http://${HOST}:${PORT}（db=${DB_FILE}，鉴权=${TOKEN !== '' ? 'on' : 'off'}）`)
  })
  // S3/R-3（决策 E1）：附件清理周期宿主（staged 孤儿 24h / sent 过期 7 天；另有上传时顺带清理）。
  setInterval(() => {
    try { cleanupChatAttachments() } catch { /* 清理失败不崩主服务，下一轮再试 */ }
  }, 3600 * 1000).unref()
  // PRT-615：审批到期扫描的加速器。
  //
  // **正确性不靠它**——权限面的每个入口都会懒扫一次（`sweepApprovalsLazily`），
  // 所以宿主外壳模式（`isMain === false`）下也一样会过期。这个定时器只覆盖
  // 「审批过期了，但没有任何人来问任何事」的那段时间。
  //
  // `unref()`：一个会阻止进程退出的定时器，与一个**关不掉的**后台任务，是同一个东西
  // （测试进程会因此永远不结束——PRT-708 那次"测试卡住"就是这么来的）。
  setInterval(() => { sweepApprovalsLazily() }, Math.max(5000, Math.floor(APPROVAL_TTL_MS / 5))).unref()
  // F-05：投递租约回收。
  //
  // 覆盖的是「取走了一条事件去投，然后那个进程死了/连接断了，再也没有人说话」
  // 那段时间。**正确性不靠它**——读到投递读数时也可以显式 `?recover=1`；
  // 这个定时器只保证"不放着不管"。回收把 `delivering` 写成 `unknown`
  // （终态、不可自动重投），因此**不会**造成重复投递。
  //
  // 判据是**租约**而不是进程自述：本仓库的部署形态是两个进程同时打开同一个库，
  // "启动时把所有 delivering 清掉"会让后启动的进程收掉另一个进程正在投的行。
  setInterval(() => {
    try { deliveryStore.recoverExpired() } catch { /* 回收失败不崩主服务，下一轮再试 */ }
  }, 30000).unref()
  // F-16：自动化计划的物化 tick。
  //
  // 与投递回收同一个形状，但**这一条是功能本身**，不是兜底：
  // 计划到点之后必须有人去把它变成运行行，而"有没有人打开页面"不能是
  // 那个条件（那正是"日历只做投影"要禁止的）。
  //
  // 30s 一次：比 `validateSpec` 允许的最短间隔（60s）快一倍，
  // 于是"每分钟一次"的计划不会被 tick 频率拖成 90s 一次。
  // 更密没有意义——计划的最小粒度就是分钟。
  //
  // `unref()`：与上面那条同一个理由，一个会阻止进程退出的定时器会让
  // 测试进程永远不结束（PRT-708 那次"测试卡住"就是这么来的）。
  setInterval(() => { automationTick() }, 30000).unref()
}

export { db, server, handle, registerSkill, reviewSkill, listSkills, grantSkill, revokeSkill, getSkill,
  getSkillSource, setSkillSource,
  publishGoalRecord, setGoalState, setGoalContext, listGoals, goalView, settleGoalsOfScope, createGoalChain,
  goalDocDirOf, goalDocPathOf,
  expandGoalSlices, createTask }
