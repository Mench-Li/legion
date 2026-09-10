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
 *   POST /api/calendar/events/delete              删除日程事件（id + confirm=yes + scope 归属校验；audit calendar:delete）
 *   GET  /api/spaces/impact?id=                   删除预检（只读计数 + 在办任务列表；S7/R-3）
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB_FILE = process.env.TEAM_HUB_DB || join(ROOT, 'team-hub', 'team.db')
/** 默认库路径（P1-1：宿主插件未显式配置 dbPath 时与独立进程同库，保证单数据池）。 */
export const DEFAULT_DB_FILE = DB_FILE
// S3/R-3（决策 E1）：聊天附件落盘目录与库同基（TEAM_HUB_DB 所在目录的 uploads/ 下）。
// 测试临时库 → uploads 自动落在 mkdtemp 内（TC-S3-16 隔离断言）；live 库目录零写入纪律不受影响。
const UPLOADS_ROOT = join(dirname(DB_FILE), 'uploads')
const PORT = Number(process.env.TEAM_HUB_PORT || 8787)
const TOKEN = process.env.TEAM_HUB_TOKEN || ''
const HOST = process.env.TEAM_HUB_HOST || '127.0.0.1'

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
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 5000')
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
{
  const spaceCols = db.prepare('PRAGMA table_info(spaces)').all().map(c => c.name)
  if (!spaceCols.includes('private')) db.exec('ALTER TABLE spaces ADD COLUMN private INTEGER DEFAULT 0')
  if (!spaceCols.includes('local_dir')) db.exec("ALTER TABLE spaces ADD COLUMN local_dir TEXT DEFAULT ''")
  if (!spaceCols.includes('remote_url')) db.exec("ALTER TABLE spaces ADD COLUMN remote_url TEXT DEFAULT ''")
}
// 迁移：members 补充 model 列（S2/R-1 决策 B1：守护心跳可携带当前选用模型，供 GET /api/chat/health 聚合展示；
// 列可空，既有成员行/插入语句零影响）。
{
  const memberCols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name)
  if (!memberCols.includes('model')) db.exec('ALTER TABLE members ADD COLUMN model TEXT DEFAULT NULL')
}
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
{
  const goalCols = db.prepare('PRAGMA table_info(goal)').all().map(c => c.name)
  if (!goalCols.includes('id')) {
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
    meta TEXT DEFAULT '{}',
    createdAt TEXT,
    updatedAt TEXT
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_scope_start ON calendar_events (scope, start, id)')
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
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
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

/** legion/roles.json 的流水线角色 → 中文标签表（任务集命名用）。 */
function pipelineLabels() {
  const labels = { unassigned: '未指派' }
  try {
    const r = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'))
    for (const s of r.stages ?? []) labels[s.role] = s.label
  } catch { /* roles.json 缺失/损坏则回退原始 role 名 */ }
  return labels
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
      .run(seq, now(), member, scope, action, taskId, JSON.stringify(detail), goalId)
    broadcastAudit(auditEvent({ seq, ts: now(), member, scope, action, taskId, goalId, detail }))
    return seq
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

// ── 日程日历（calendar）DAO：事件 CRUD + 日期窗（R-B1 数据面，S5；scope 分区 + 统一写纪律）──
// 写纪律（同 chat I-3）：createCalendarEvent / deleteCalendarEvent 内部一律 audit()（by 必填 + SSE 广播），
// 机制复用 audit() 与 /api/events 单一事件流（I-8）；author/member 恒等于 by（防冒名）。
export const MAX_CALENDAR_TITLE = 100 // 事件标题长度上限（⚖️ 三值法断言的常量，见 TEST_CASES §3）

// 时间入参解析：接受 YYYY-MM-DD（date-only，全天事件）或 YYYY-MM-DDTHH:mm[:ss][Z]；
// 逐分量范围校验 + Date.UTC 回环校验（拒 2026-13-99 / 2026-02-30 / garbage 等）；
// 返回 { raw（规范化原样存储）, date（YYYY-MM-DD 日期前缀，窗过滤用）, key（UTC 毫秒，end>=start 排序比较用）}。
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

function eventToObj(row) {
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    start: row.start,
    end: row.end ?? null,
    allDay: row.all_day === 1,
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

/** 创建事件（by + scope 必填 + 审计/SSE）；start 必填可解析、end 可选须 ≥ start、title ≤ MAX_CALENDAR_TITLE。 */
export function createCalendarEvent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope（日程事件须归属明确的工作空间）')
  const title = input?.title
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('缺少参数 title')
  if (title.trim().length > MAX_CALENDAR_TITLE) throw new Error(`标题过长（上限 ${MAX_CALENDAR_TITLE} 字符）`)
  const start = parseCalendarTime(input?.start, 'start')
  const endRaw = input?.end
  let end = null
  if (endRaw !== undefined && endRaw !== null && String(endRaw).trim() !== '') {
    end = parseCalendarTime(endRaw, 'end')
    if (end.key < start.key) throw new Error('end 必须 ≥ start（事件结束不得早于开始）')
  }
  const allDay = input?.allDay === true
  const meta = input?.meta !== null && typeof input?.meta === 'object' && !Array.isArray(input.meta) ? input.meta : {}
  return withTx(() => {
    const t = now()
    const r = db.prepare('INSERT INTO calendar_events (scope, title, start, end, all_day, meta, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(scope.trim(), title.trim(), start.raw, end ? end.raw : null, allDay ? 1 : 0, JSON.stringify(meta), t, t)
    const ev = getCalendarEvent(Number(r.lastInsertRowid))
    audit(by, ev.scope, 'calendar:create', null, { event: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay })
    return ev
  })
}

/**
 * 事件列表：scope 过滤（缺省 = 全部，与 chat listConversations 同构）+ 日期窗 [from,to]（闭区间，
 * 按 start 的 YYYY-MM-DD 日期前缀比较，全天 date-only 事件同口径，R-16）；排序 start asc、id asc（稳定）。
 */
export function listCalendarEvents({ scope, from, to } = {}) {
  const conds = []
  const params = []
  if (typeof scope === 'string' && scope.trim().length > 0) { conds.push('scope = ?'); params.push(scope.trim()) }
  let f, t
  if (from !== undefined && from !== null && String(from).trim() !== '') {
    f = parseCalendarTime(String(from), 'from')
    conds.push('substr(start, 1, 10) >= ?'); params.push(f.date)
  }
  if (to !== undefined && to !== null && String(to).trim() !== '') {
    t = parseCalendarTime(String(to), 'to')
    conds.push('substr(start, 1, 10) <= ?'); params.push(t.date)
  }
  if (f && t && f.date > t.date) throw new Error('日期窗非法：from 不得晚于 to')
  const sql = `SELECT * FROM calendar_events${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY start ASC, id ASC`
  return db.prepare(sql).all(...params).map(eventToObj)
}

/** 删除事件：二次确认 confirm=yes + scope 归属校验（越权不可删他人空间事件）+ 审计 calendar:delete。 */
export function deleteCalendarEvent(input) {
  const by = input?.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  const scope = input?.scope
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope（删除须指明事件所属空间）')
  const id = Number(input?.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('缺少参数 id')
  if (input?.confirm !== 'yes') throw new Error('缺少二次确认：confirm 必须为 yes')
  return withTx(() => {
    const ev = getCalendarEvent(id)
    if (ev.scope !== scope.trim()) throw new Error(`越权：事件 ${id} 属于 scope=${ev.scope}，不能用 scope=${scope.trim()} 删除`)
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
    audit(by, ev.scope, 'calendar:delete', null, { event: id, title: ev.title })
    return { deleted: true, event: ev.id, scope: ev.scope, title: ev.title }
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
function createTask(input) {
  return withTx(() => {
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
  })
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
    // slice 模式前置条件：编队含分析尾（test-designer）与构建岗位（coder/tester）；缺则回退 chain
    const tdIdx = roster.findIndex(r => r.role === 'test-designer')
    const sliced = mode === 'slice' && tdIdx >= 0 && roster.some(r => r.role === 'coder') && roster.some(r => r.role === 'tester')
    const build = sliced ? roster.slice(0, tdIdx + 1) : roster
    const created = []
    let prev = null
    build.forEach((r, i) => {
      // 阶段名：优先 roles.json 流水线标签（与该空间任务集泳道名一致），否则用通用阶段标签
      const named = pipe[r.role] && pipe[r.role] !== r.role ? pipe[r.role] : null
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
    const status = message.includes('乐观锁') ? 409 : 400
    json(res, status, { error: message })
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
    if (req.method === 'POST' && path === '/api/calendar/events') {
      await handleWrite(req, res, (body, by) => createCalendarEvent({ ...body, by }))
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
        }
        const running = db.prepare("SELECT id, title, status FROM tasks WHERE scope = ? AND status IN ('in_progress','in_review','blocked') ORDER BY id").all(id)
        json(res, 200, { id, counts, running: { tasks: running } })
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
      json(res, 200, { auth: TOKEN !== '', db: DB_FILE, port: PORT })
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
    if (res.headersSent) res.end()
    else json(res, 500, { error: message })
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
