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
import { assembleContext, describeAssembly } from '../runtime/context/assembler.mjs'
import { createConservativeTokenizer, tokenizerForProfile } from '../runtime/context/tokenizer.mjs'
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
import { loadConfig } from '../packages/shared/src/config.mjs'
import { SCHEMA as CONFIG_SCHEMA } from './config-schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// P3-2 统一配置：核心项（host/port/token/db）经统一引擎解析——优先级 CLI > env > 默认，
// 类型/范围/枚举校验，非法值报错退出（不静默回退），并把脱敏摘要打出来。
// 其余 CHAT_*/MAX_RULES_LEN 等键仍按原样读取，但**已在 schema 中声明**（scan --check 强制），
// 其默认值由 scripts/config/config.test.mjs 做漂移比对。
const CFG = loadConfig(CONFIG_SCHEMA, { env: process.env, argv: process.argv.slice(2) })
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
})

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

// PRT-409：上下文快照存储。惰性建表（与 probeService 同一手法），
// 因为模块顶层建表会让 `import` 这个文件本身就产生副作用。
let contextStoreInstance = null
/**
 * 精确 tokenizer 的注册表（PRT-413）。
 *
 * **默认为空**，因为本项目零依赖、拿不到任何供应商的词表。空表不是缺陷，
 * 而是如实：拿不到精确 tokenizer 时用**明确标记的**保守估算器（spec §6.5），
 * 于是 `tokens.kind` 会如实写成 `conservative-estimate`。
 *
 * 有词表时在这里 `set(model, defineExactTokenizer({ ... }))` 即可——
 * 本表的存在是为了让"精确"有一个**接入点**，而不是让默认值看起来精确。
 */
const TOKENIZER_REGISTRY = new Map()

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
db.exec(`
  CREATE TABLE IF NOT EXISTS permission_requests (
    requestId TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    taskId TEXT,
    operation TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    decidedBy TEXT,
    reason TEXT,
    createdAt TEXT NOT NULL,
    expiresAt INTEGER,
    decidedAt TEXT,
    consumedAt TEXT
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_permission_requests_scope_status ON permission_requests (scope, status, createdAt)')
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
// P2-5 增量列（幂等，零迁移脚本）：老库自动补列；已存在则 ALTER 抛错被吞。
for (const col of ['taskId TEXT', 'goalId TEXT', 'recurrence TEXT']) {
  try { db.exec('ALTER TABLE calendar_events ADD COLUMN ' + col) } catch { /* 列已存在 */ }
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
// 老库迁移：skills 先于 bundle 列存在，旧内容只有 prompt → 生成单件 bundle（main=prompt），
// 并按「bundle 化」新公式重算 contentHash，保证旧技能「同内容重复提交」幂等、改内容才 bump version。
// （skillContentHash / normalizeBundle 为函数声明，已提升，可在建表后调用。）
for (const r of db.prepare("SELECT id, name, description, prompt, scope FROM skills WHERE (bundle IS NULL OR bundle = '') AND prompt IS NOT NULL AND prompt != ''").all()) {
  const bundle = normalizeBundle({ main: r.prompt, config: '', scripts: [], cases: [] })
  const hash = skillContentHash({ name: r.name, description: r.description, scope: r.scope, bundle })
  db.prepare('UPDATE skills SET bundle=?, contentHash=? WHERE id=?').run(JSON.stringify(bundle), hash, r.id)
}
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
    audit(by, targetScope, 'goal:publish', goalId, { goal: goalId, objective: objective.trim(), mode: chain.mode, stages: chain.count }, goalId)
    return { goal: goalView(getGoal(goalId)), stages: chain.count, mode: chain.mode, objective: objective.trim() }
  })
}

/**
 * 目标状态迁移（POST /api/goal/status 的函数体，仅将军）：
 * active ↔ paused（暂停/恢复）；done / canceled 为终态（自动收尾或将军手动）。
 * canceled 同步取消该目标**未开工**（backlog/todo/blocked）的链任务；在办/待验收留给将军收尾，不硬杀。
 * 返回 { goal, changed, canceledTasks }。
 */
function setGoalState(id, to, by = 'general', forceGeneral = false) {
  return withTx(() => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
    if (!GOAL_STATUSES.includes(to)) throw new Error(`status 必须是 ${GOAL_STATUSES.join('|')}`)
    if (by !== 'general' && forceGeneral !== true) throw new Error('目标状态仅允许将军（by=general）变更')
    const g = getGoal(id)
    if (g.status === to) return { goal: goalView(g), changed: false, canceledTasks: 0 }
    if (g.status === 'canceled') throw new Error(`目标 ${id} 已取消，不可再变更`)
    if (to === 'active' && g.status !== 'paused') throw new Error(`只有 paused 的目标可恢复（当前 ${g.status}）`)
    if (to === 'paused' && g.status !== 'active') throw new Error(`只有 active 的目标可暂停（当前 ${g.status}）`)
    if (to === 'canceled' && g.status === 'done') throw new Error('已完成的目标无需取消（如需归档可直接忽略）')
    const at = now()
    const terminal = to === 'done' || to === 'canceled'
    db.prepare('UPDATE goal SET status=?, version=version+1, updatedAt=?, endedAt=? WHERE id=?')
      .run(to, at, terminal ? at : null, id)
    let canceledTasks = 0
    if (to === 'canceled') {
      // 只取消未开工的链任务（in_progress/in_review 属于在办，交给将军收尾）
      canceledTasks = db.prepare("UPDATE tasks SET status='canceled', version=version+1, updatedAt=? WHERE goalId=? AND status IN ('backlog','todo','blocked')").run(at, id).changes
    }
    const action = to === 'paused' ? 'goal:pause' : to === 'active' ? 'goal:resume' : to === 'done' ? 'goal:done' : 'goal:cancel'
    audit(by, g.scope, action, id, { goal: id, objective: g.objective, canceledTasks }, id)
    return { goal: goalView(getGoal(id)), changed: true, canceledTasks }
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

export function checkPermission(input = {}) {
  const operation = normalizeOperation(input)
  const requestId = input.permissionRequestId ? String(input.permissionRequestId) : null
  if (requestId) {
    const row = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(requestId)
    if (row && row.status === 'approved') {
      if (JSON.stringify(JSON.parse(row.operation)) !== JSON.stringify(operation)) throw new Error('permission operation mismatch')
      const consumed = withTx(() => db.prepare("UPDATE permission_requests SET status='consumed', consumedAt=? WHERE requestId=? AND status='approved'").run(now(), requestId))
      if (consumed.changes === 1) { audit(operation.actor, operation.scope, 'permission:consume', requestId, { action: operation.action, target: operation.target }); return { allowed: true, decision: 'allow', status: 'consumed', requestId, operation } }
    }
  }
  const result = evaluatePermission(operation, permissionRows(), { now: Date.now() })
  if (result.status !== 'pending') return result
  const existing = db.prepare("SELECT * FROM permission_requests WHERE scope=? AND actor=? AND action=? AND target=? AND status='pending'").get(operation.scope, operation.actor, operation.action, operation.target)
  if (existing) return { ...result, requestId: existing.requestId }
  const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  withTx(() => db.prepare(`INSERT INTO permission_requests (requestId,scope,actor,action,target,taskId,operation,mode,status,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, operation.scope, operation.actor, operation.action, operation.target, operation.taskId, JSON.stringify(operation), result.mode, 'pending', now(), Date.now() + 15 * 60 * 1000))
  audit(operation.actor, operation.scope, 'permission:request', id, { action: operation.action, target: operation.target, mode: result.mode })
  return { ...result, requestId: id }
}

export function listPermissionInbox(scope = null) {
  const rows = scope ? db.prepare('SELECT * FROM permission_requests WHERE scope=? ORDER BY createdAt DESC').all(scope) : db.prepare('SELECT * FROM permission_requests ORDER BY createdAt DESC').all()
  const current = Date.now()
  return rows.map(row => ({ ...row, operation: JSON.parse(row.operation), expired: row.status === 'pending' && Number(row.expiresAt) <= current }))
}

export function decidePermission({ requestId, decision, by = 'general', reason = '' } = {}) {
  if (by !== 'general') throw new Error('仅允许 general 决定权限审批')
  const id = String(requestId ?? '').trim()
  if (!id || !['approve', 'deny'].includes(decision)) throw new Error('审批参数非法')
  const row = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(id)
  if (!row) throw new Error('审批请求不存在')
  if (row.status !== 'pending') return { ...row, operation: JSON.parse(row.operation) }
  if (Number(row.expiresAt) <= Date.now()) {
    db.prepare("UPDATE permission_requests SET status='expired' WHERE requestId=? AND status='pending'").run(id)
    return { ...row, status: 'expired', operation: JSON.parse(row.operation) }
  }
  const status = decision === 'approve' ? 'approved' : 'denied'
  withTx(() => db.prepare('UPDATE permission_requests SET status=?, decidedBy=?, reason=?, decidedAt=? WHERE requestId=? AND status=\'pending\'').run(status, by, String(reason), now(), id))
  const updated = db.prepare('SELECT * FROM permission_requests WHERE requestId=?').get(id)
  audit(by, row.scope, `permission:${status}`, id, { action: row.action, target: row.target, reason: String(reason) })
  return { ...updated, operation: JSON.parse(updated.operation) }
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
      db.prepare("INSERT INTO skills (id, name, description, prompt, bundle, scope, owner, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)")
        .run(id, name, description, bundle.main, JSON.stringify(bundle), scope, input.owner ?? null, hash, now(), now())
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

function commentTask(id, by, text, isEvidence) {
  return withTx(() => {
    const t = getTask(id)
    const field = isEvidence ? 'evidence' : 'comments'
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

/** 推一条完整 SSE data 帧：id: 行（seq，供 EventSource Last-Event-ID 断线续传）+ data JSON。 */
function writeEventFrame(res, entry) {
  res.write(`id: ${entry.seq}\n`)
  res.write(`data: ${JSON.stringify(entry)}\n\n`)
}

function broadcastAudit(entry) {
  for (const client of eventClients) {
    if (client.scope === undefined || client.scope === entry.scope) writeEventFrame(client.res, entry)
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
        const r = runStore.transition({
          attemptId: requireString(body, 'attemptId'),
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
        return r
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
        const r = runStore.failAndRetry({
          attemptId: requireString(body, 'attemptId'),
          leaseEpoch: body.leaseEpoch ?? null,
          actor: requireString(body, 'workerId'),
          failureCode: body.failureCode ?? null,
          detail: body.detail ?? null,
          reason: body.reason ?? 'failure-reported',
          nowMs: body.nowMs ?? null,
        })
        try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
        return r
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
    // 服务端装配（PRT-407）。这条路由的存在有两层意义：
    //   ① 装配器有了**真实调用方**（此前它只有用例）；
    //   ② 装配与持久化在同一个请求里完成，于是"冻结在 Running 之前"
    //      不是一条靠人记住的约定。
    if (req.method === 'POST' && path === '/api/context-snapshots/assemble') {
      await handleRun(req, res, (body) => {
        const scope = body.scope ?? 'default'
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

        if (!Array.isArray(body.candidates)) {
          json(res, 400, { ok: false, code: 'CONTEXT_BAD_CANDIDATE', error: 'candidates 必须是数组（没有来源时给空数组）' })
          return
        }
        // 用 `createContextSource` 构造来源：于是来源的**形状约束**
        //（默认不可信、不许带权威字段、未知字段拒绝）在这一层同样生效，
        // 而不是只在用例里生效。
        const candidates = body.candidates.map((c, i) => {
          if (c === null || typeof c !== 'object' || c.source === null || typeof c.source !== 'object') {
            throw Object.assign(new Error(`candidates[${i}] 必须是 { source } 形状`), { statusCode: 400, code: 'CONTEXT_BAD_CANDIDATE' })
          }
          return {
            source: createContextSource(c.source),
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
          frozenAtMs: body.frozenAtMs ?? Date.now(),
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
    if (req.method === 'GET' && path.startsWith('/api/context-snapshots/')) {
      const PREFIX = '/api/context-snapshots/'
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
        const task = commentTask(id, by, text.trim(), body.isEvidence === true)
        audit(by, scope, body.isEvidence === true ? 'evidence' : 'comment', id, {}, task.goalId)
        return task
      })
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
        const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM roster WHERE scope = ?').get(targetScope).s
        db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar`)
          .run(targetScope, role.trim(), name.trim(),
            typeof body.kind === 'string' ? body.kind : '',
            typeof body.avatar === 'string' && body.avatar.trim() ? body.avatar.trim() : '🤖', sort)
        audit(by, targetScope, 'agent:create', null, { role: role.trim(), name: name.trim() })
        return { scope: targetScope, role: role.trim(), name: name.trim() }
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
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      const client = { res, scope: eventScope }
      eventClients.add(client)
      // Last-Event-ID 断线续传（P2-3 S2）：带合法序号则只回放 seq > N 的增量；
      // 无/非法则回放最近 30 条（契约 §6.2：seq 单调，配合 id: 行 EventSource 原生续传）。
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
      for (const r of replay) writeEventFrame(res, auditEvent(r))
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
      req.on('close', () => { clearInterval(heartbeat); eventClients.delete(client) })
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      // `runPlane: true` 是能力发现位（PRT-301 起）：worker 用它判断「这个 hub 支不支持
      // 带 epoch 的运行面」。没有这个位时，一个升级了一半的部署（hub 还是旧的）
      // 会让 worker 收到 404，而 404 的文案无法区分「路由不存在」与「路径拼错」。
      json(res, 200, { auth: TOKEN !== '', db: DB_FILE, port: PORT, runPlane: true })
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
}

export { db, server, handle, registerSkill, reviewSkill, listSkills, grantSkill, revokeSkill, getSkill,
  getSkillSource, setSkillSource,
  publishGoalRecord, setGoalState, setGoalContext, listGoals, goalView, settleGoalsOfScope, createGoalChain,
  goalDocDirOf, goalDocPathOf,
  expandGoalSlices, createTask }
