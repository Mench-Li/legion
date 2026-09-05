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
 *   TEAM_HUB_TOKEN 团队 token（非空时写操作需 Authorization: Bearer <token>）
 *
 * API：
 *   GET  /api/board?scope=&status=&soldier=&role=   任务列表（SQLite，scope 一等字段）
 *   GET  /api/missions?scope=                       任务集聚合视图（scopeAware=true，真分区）
 *   GET  /api/scopes                                真实存在的分区（tasks+members 的 distinct scope）
 *   GET  /api/spaces                               工作空间列表（注册名 + private + 仓库绑定 localDir/remoteUrl）
 *   POST /api/spaces                               注册/更新工作空间（id/name/private/localDir/remoteUrl；幂等 upsert）
 *   POST /api/spaces/delete                        删除工作空间及 scope 数据（body: id + confirm=`delete-space:<id>`；拒绝 software/default）
 *   GET  /api/activity?limit=                      最近动态（审计）
 *   GET  /api/members                              成员在线状态
 *   GET  /api/events                               SSE 事件流
 *   POST /api/create|claim|transition|advance|reassign|release-stale|comment|heartbeat   写操作（body 带 by + scope）
 *       —— create/目标链生成任务时**自动注入验收标准 + 边界**（做什么/不做什么，按岗位模板，
 *          stage-standards.mjs）；调用方可传自定义 acceptance/boundary 覆盖。
 *       —— reassign 转派 = soldier 与 role 一并改为目标岗位（转派后守护仍按新 role 自动接管执行）；
 *          POST /api/hold {id, hold} = 将军逐任务拦截（守护不得自动认领）/放行。
 *   POST /api/skills/register|review|grant         团队共享技能（scope-owned + grant）
 *   GET/POST /api/chat/conversations|messages       对话中心（会话/消息；scope 分区；写 by 必填 + audit/SSE，见 S1）
 *   GET/POST /api/calendar/events                 日程日历事件（scope 过滤 + 日期窗 [from,to] 闭区间；写 by 必填 + audit/SSE，见 S5）
 *   POST /api/calendar/events/delete              删除日程事件（id + confirm=yes + scope 归属校验；audit calendar:delete）
 *   GET  /api/skills[?scope=&member=&id=]          技能查询（默认只返回 published）
 *
 * 状态机 + 乐观锁 + 角色纪律与 taskctl.mjs 一致；scope 是任务分区的一等字段。
 */
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standardsFor } from './stage-standards.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB_FILE = process.env.TEAM_HUB_DB || join(ROOT, 'team-hub', 'team.db')
const PORT = Number(process.env.TEAM_HUB_PORT || 8787)
const TOKEN = process.env.TEAM_HUB_TOKEN || ''
const HOST = process.env.TEAM_HUB_HOST || '0.0.0.0'

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
// 空间目标（goal）：每个工作空间一个 objective，任务集围绕它推进。
db.exec(`
  CREATE TABLE IF NOT EXISTS goal (
    scope TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    createdAt TEXT,
    updatedAt TEXT
  )
`)
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
// 老库迁移：skills 表先于 status/contentHash/reviewedAt 三列存在，缺列补上。
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
ensureColumn('skills', 'status', "status TEXT DEFAULT 'pending'")
ensureColumn('skills', 'contentHash', "contentHash TEXT DEFAULT ''")
ensureColumn('skills', 'reviewedAt', 'reviewedAt TEXT')
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

let nextSeq = 1
try {
  const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM audit').get()
  nextSeq = (row?.m ?? 0) + 1
} catch { /* 空表 */ }

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

function assertUnblocked(t, force) {
  if (force) return
  const open = t.blockedBy.filter((b) => {
    const dep = db.prepare('SELECT status FROM tasks WHERE id = ?').get(b)
    return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
  })
  if (open.length > 0) throw new Error(`任务被未完成依赖阻塞：${open.join(', ')}（确认后加 force）`)
}

/** 写事务：BEGIN IMMEDIATE 串行化写 + 版本检查（乐观锁）。 */
function withTx(mutate) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = mutate()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

function nextId() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM tasks').get()
  return `T-${String((row?.c ?? 0) + 1).padStart(3, '0')}`
}

function audit(member, scope, action, taskId, detail) {
  const seq = nextSeq++
  db.prepare('INSERT INTO audit (seq, ts, member, scope, action, taskId, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(seq, now(), member, scope, action, taskId, JSON.stringify(detail))
  broadcastAudit({ seq, ts: now(), member, scope, action, taskId, detail })
  return seq
}

function touchMember(member, scope, kind) {
  db.prepare(`
    INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, kind=excluded.kind, lastSeenAt=excluded.lastSeenAt, online=1
  `).run(member, scope, kind, now())
}

// ── 技能（scope-owned + grant + 版本/review，借鉴 QM shared skills + RFC-032）──
function skillContentHash(s) {
  return createHash('sha256').update(JSON.stringify({
    name: s.name, description: s.description ?? '', prompt: s.prompt ?? '', scope: s.scope ?? 'default',
  })).digest('hex')
}

function getSkill(id) {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
  if (!row) throw new Error(`未知技能 ${id}`)
  return { ...row, grants: parseJson(row.grants, []) }
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
    const description = input.description ?? ''
    const prompt = input.prompt ?? ''
    const scope = input.scope ?? 'default'
    const hash = skillContentHash({ name, description, prompt, scope })
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    if (existing) {
      if (existing.contentHash === hash) return getSkill(id) // 幂等：同内容重复提交不产生新版本
      db.prepare('UPDATE skills SET name=?, description=?, prompt=?, scope=?, version=version+1, status=\'pending\', contentHash=?, reviewedAt=NULL, updatedAt=? WHERE id=?')
        .run(name, description, prompt, scope, hash, now(), id)
    } else {
      db.prepare('INSERT INTO skills (id, name, description, prompt, scope, owner, grants, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, \'pending\', ?, ?, ?)')
        .run(id, name, description, prompt, scope, input.owner ?? null, '[]', hash, now(), now())
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

/**
 * 列出技能。默认只返回 published（守护/士兵只该拿到已发布的）；
 * `includePending=true` 供复审者查看待审/被拒。
 */
function listSkills({ scope, member, includePending } = {}) {
  const rows = db.prepare('SELECT * FROM skills ORDER BY id').all()
  return rows.map((r) => ({ ...r, grants: parseJson(r.grants, []) }))
    .filter((s) => {
      if (includePending !== true && s.status !== 'published') return false
      if (scope === undefined && member === undefined) return true
      const inScope = scope !== undefined && s.scope === scope
      const granted = member !== undefined && (s.grants.includes(member) || (scope !== undefined && s.grants.includes(`scope:${scope}`)))
      return inScope || granted
    })
}

function grantSkill(id, grants) {
  return withTx(() => {
    const s = getSkill(id)
    const merged = [...new Set([...s.grants, ...grants])]
    db.prepare('UPDATE skills SET grants=?, updatedAt=? WHERE id=?').run(JSON.stringify(merged), now(), id)
    return getSkill(id)
  })
}

// ── 对话中心（chat）DAO：会话 / 消息（scope 分区 + 统一写纪律）──
// 写纪律（I3）：createConversation / postMessage 内部一律走 audit()（by 必填 + SSE 广播），
// 与 tasks 的「路由层 audit」不同——chat 的 DAO 即写入口（含未来 AI 直写场景），把审计放进 DAO
// 保证任何调用路径都留痕；author 恒等于 by（服务端绑定，防冒名，TC-S1-07）。
export const CHAT_CONV_KINDS = ['space', 'direct', 'task']
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
    const r = db.prepare('INSERT INTO messages (conv_id, scope, author, kind, body, meta, client_ts, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(convId, conv.scope, by.trim(), kind, body, JSON.stringify(typeof input?.meta === 'object' && input.meta ? input.meta : {}), clientTs, t)
    db.prepare('UPDATE conversations SET last_message_at = ?, updatedAt = ? WHERE id = ?').run(t, t, convId)
    const msg = msgToObj(db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid))
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

// ── 写操作 ──
function createTask(input) {
  return withTx(() => {
    const id = nextId()
    const std = taskStandards(input.role, input.acceptance, input.boundary)
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
      createdAt: now(),
      updatedAt: now(),
    }
    if (t.title.length === 0) throw new Error('title 必须是非空字符串')
    if (!PRIORITIES.includes(t.priority)) throw new Error(`非法优先级 ${t.priority}`)
    if (t.status !== 'backlog' && t.status !== 'todo') throw new Error(`非法初始状态 ${t.status}`)
    if (t.parent !== null && !db.prepare('SELECT 1 FROM tasks WHERE id=?').get(t.parent)) throw new Error(`父任务 ${t.parent} 不存在`)
    db.prepare(`
      INSERT INTO tasks (id, title, description, acceptance, boundary, priority, status, version, soldier, claimedRound, claimedAt,
        ordersVersion, parent, role, scope, blocks, blockedBy, comments, evidence, patches, artifacts, slice, sliceIdx, fixOf, fixCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?)
    `).run(t.id, t.title, t.description, JSON.stringify(t.acceptance), JSON.stringify(t.boundary), t.priority, t.status, t.ordersVersion, t.parent, t.role, t.scope, JSON.stringify(t.blockedBy), t.slice, t.sliceIdx, t.fixOf, t.fixCount, t.createdAt, t.updatedAt)
    return getTask(id)
  })
}

// ── 目标自动分解：发布目标时按空间编队生成「阶段任务链」，指派给对应智能体 ──
// 通用阶段标签（按编队 sort 顺序逐个分派；超出循环）。software 编队天然按流水线排序，
// 故 requirement→需求讨论 / researcher→方案设计 / breaker→任务拆分 … 语义一一对应。
const GOAL_STAGE_LABELS = ['需求讨论', '方案设计', '任务拆分', '用例设计', '代码开发', '代码审查', '测试验收', '发布部署']

/** 建一个 [auto-goal] 任务行（chain / slice 展开共用）。返回新任务。 */
function insertGoalTask({ title, description, acceptance, boundary, role, scope, blockedBy = [], status = 'todo', parent = null, slice = null, sliceIdx = null, fixOf = null, fixCount = 0, priority = 'high' }) {
  const id = nextId()
  db.prepare(`
    INSERT INTO tasks (id, title, description, acceptance, boundary, priority, status, version, soldier, claimedRound, claimedAt,
      ordersVersion, parent, role, scope, blocks, blockedBy, comments, evidence, patches, artifacts, slice, sliceIdx, fixOf, fixCount, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 1, ?, ?, ?, '[]', ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, JSON.stringify(acceptance), JSON.stringify(boundary), priority, status, parent, role, scope, JSON.stringify(blockedBy), slice, sliceIdx, fixOf, fixCount, now(), now())
  return getTask(id)
}

/**
 * 发布目标 → 任务链。两种模式：
 * - chain（默认，v2 现状）：按空间编队全串阶段链（blockedBy=[prev]）；
 * - slice（v3 切片流水线）：只生成「分析前缀链」（需求→方案→拆解→用例设计，到 test-designer 为止），
 *   并带 [slice-mode] 标记；test-designer done 后由守护解析 TASK_BREAKDOWN.md →
 *   POST /api/goal/slices 展开「编码切片束」（coder_Si→tester_Si 微链 + devops 目标级收尾），
 *   切片之间无依赖 → coder_Si+1 编码与 tester_Si 测试天然并行（架构见 docs/ORCHESTRATION-V3.md）。
 */
function createGoalChain(scope, objective, mode = 'chain') {
  return withTx(() => {
    const nowIso = now()
    // 重置：取消该空间旧的「自动目标链」任务（未完成的，含旧 slice 任务），避免重复发布累积
    const old = db.prepare("SELECT id FROM tasks WHERE scope = ? AND description LIKE '%[auto-goal]%' AND status NOT IN ('done','canceled')").all(scope)
    for (const o of old) {
      db.prepare("UPDATE tasks SET status='canceled', version=version+1, updatedAt=? WHERE id=?").run(nowIso, o.id)
    }
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
      const task = insertGoalTask({
        title: `【${label}】${objective.trim().slice(0, 40)}`,
        description,
        acceptance: s.acceptance,
        boundary: { do: s.do, dont: s.dont },
        role: r.role,
        scope,
        blockedBy: prev ? [prev] : [],
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
      })
      // tester_Si：只测不修；验收 = 结构化 testReport（passed=true 才自动 done，D7' 机器闸门）
      const testerStd = sliceStandards('tester', [], [], ['不得修改任何源码/测试用例（只测不修）'])
      const tester = insertGoalTask({
        title: `【切片 S${si} 测试】${title.slice(0, 30)}`,
        description: `[auto-goal]\n[slice-test]\n${objectiveLine}\n切片 S${si}：${title}\n要求：运行测试用例（docs/TEST_CASES.md 覆盖本切片的部分），只测不修；结构化回报 testReport={passed, failures:[{name,log,repro}]}。`,
        acceptance: testerStd.acceptance,
        boundary: testerStd.boundary,
        role: 'tester',
        scope: td.scope,
        blockedBy: [coder.id],
        slice: sliceKey,
        sliceIdx: si,
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
    })
    created.push(devops.id)
    audit(by, td.scope, 'goal:slices', td.id, { testDesignerTaskId: td.id, slices: slices.length, created: created.length })
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
function broadcastAudit(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`
  for (const res of eventClients) res.write(payload)
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

function authorized(req) {
  if (TOKEN === '') return true
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  return token === TOKEN
}

function requireMember(body) {
  const by = body.by
  if (typeof by !== 'string' || by.trim().length === 0) throw new Error('缺少操作者身份 by')
  return by.trim()
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

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname
  res.setHeader('access-control-allow-origin', '*')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' })
    res.end()
    return
  }

  try {
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
        })
        audit(by, scope, 'create', task.id, { title: task.title })
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
        audit(by, t.scope, 'progress', id, { percent: Number.isFinite(Number(body.percent)) ? Number(body.percent) : 0 })
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
        audit(by, t.scope, 'patch', id, { files: files.map(f => f.path).join(',') })
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
        audit(by, t.scope, 'review-note', id, { file, verdict, note: note.slice(0, 200) })
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
        list.push({ by, at: now(), kind, path, title: typeof body.title === 'string' ? body.title.slice(0, 120) : '' })
        db.prepare('UPDATE tasks SET artifacts=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(list), now(), id)
        audit(by, t.scope, 'artifact', id, { kind, path })
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
        audit(by, t.scope, 'test-report', id, { passed, failures: failures.length })
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
        audit(by, scope, 'claim', id, { soldier })
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
        audit(by, scope, 'transition', id, { to })
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/advance') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        const task = advanceTask(id, by, body.ifVersion)
        audit(by, scope, 'advance', id, {})
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
        audit(by, scope, 'reassign', id, { soldier: soldier.trim() })
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
        const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)
        if (!t) throw new Error(`未知任务 ${id}`)
        if (t.status === 'done' || t.status === 'canceled') throw new Error(`任务 ${id} 已 ${t.status}，不可拦截/放行`)
        db.prepare('UPDATE tasks SET hold=?, version=version+1, updatedAt=? WHERE id=?').run(hold ? 1 : 0, now(), id)
        audit(by, scope, hold ? 'hold' : 'unhold', id, {})
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
        audit(by, scope, body.isEvidence === true ? 'evidence' : 'comment', id, {})
        return task
      })
      return
    }
    if (req.method === 'POST' && path === '/api/heartbeat') {
      await handleWrite(req, res, (body, by, scope) => {
        touchMember(by, scope, typeof body.kind === 'string' ? body.kind : 'unknown')
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
      // 空间目标：objective + 按该空间任务实时算进度（done / 非 canceled 总数）。
      const scopeParam = url.searchParams.get('scope') ?? ''
      const hit = scopeParam ? db.prepare('SELECT * FROM goal WHERE scope = ?').get(scopeParam) : undefined
      const tasks = scopeParam ? listTasks({ scope: scopeParam }).filter(t => t.status !== 'canceled') : []
      const done = tasks.filter(t => t.status === 'done').length
      const total = tasks.length
      json(res, 200, {
        scope: scopeParam,
        objective: hit?.objective ?? null,
        done, total,
        percent: total > 0 ? Math.round((done / total) * 100) : 0,
        updatedAt: hit?.updatedAt ?? null,
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
      let rows
      if (taskIdParam) {
        rows = db.prepare('SELECT * FROM audit WHERE taskId = ? ORDER BY seq').all(taskIdParam)
      } else if (scopeParam) {
        rows = db.prepare('SELECT * FROM audit WHERE scope = ? ORDER BY seq DESC LIMIT ?').all(scopeParam, limit)
      } else {
        rows = db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit)
      }
      json(res, 200, rows.map((r) => ({
        seq: r.seq, ts: r.ts, member: r.member, scope: r.scope, action: r.action, taskId: r.taskId,
        detail: parseJson(r.detail, {}),
      })))
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
          prompt: body.prompt, scope: body.scope ?? scope, owner: by,
        })
        audit(by, scope, 'skill:submit', id, { name: skill.name, version: skill.version })
        return skill
      })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/review') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const action = body.action
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (typeof action !== 'string' || action.length === 0) throw new Error('缺少参数 action')
        const skill = reviewSkill(id, action)
        audit(by, scope, 'skill:review', id, { action, status: skill.status })
        return skill
      })
      return
    }
    if (req.method === 'POST' && path === '/api/skills/grant') {
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        const grants = body.grants
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
        if (!Array.isArray(grants) || grants.length === 0) throw new Error('缺少参数 grants')
        const skill = grantSkill(id, grants.map(String))
        audit(by, scope, 'skill:grant', id, { grants: grants.map(String) })
        return skill
      })
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
    if (req.method === 'POST' && path === '/api/spaces/delete') {
      // 删除工作空间及其 scope 数据（tasks/goal/roster/exec_state/exec_requests/agent_models/skills）。
      // 安全护栏：software/default 等受保护空间一律拒绝；调用方须显式 confirm=`delete-space:<id>`。
      await handleWrite(req, res, (body, by, scope) => {
        const id = body.id
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
        if (id === 'software' || id === 'default') throw new Error(`受保护空间 ${id} 不可删除`)
        if (body.confirm !== `delete-space:${id}`) throw new Error('缺少确认：confirm 须为 delete-space:<id>（该操作会删除该空间全部任务/目标/编队/模型/技能数据）')
        if (by !== 'general' && body.forceGeneral !== true) throw new Error('删除空间仅允许 general 执行')
        const existing = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
        if (!existing) throw new Error(`未知空间 ${id}`)
        const removed = withTx(() => {
          const counts = {}
          for (const [key, sql] of [
            ['tasks', 'DELETE FROM tasks WHERE scope = ?'],
            ['roster', 'DELETE FROM roster WHERE scope = ?'],
            ['agent_models', 'DELETE FROM agent_models WHERE scope = ?'],
            ['exec_requests', 'DELETE FROM exec_requests WHERE scope = ?'],
            ['skills', 'DELETE FROM skills WHERE scope = ?'],
            ['goal', 'DELETE FROM goal WHERE scope = ?'],
            ['exec_state', 'DELETE FROM exec_state WHERE scope = ?'],
          ]) counts[key] = db.prepare(sql).run(id).changes
          db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
          return counts
        })
        audit(by, id, 'space:delete', null, { space: id, removed })
        return { id, removed }
      })
      return
    }
    if (req.method === 'POST' && path === '/api/goal') {
      // 发布空间目标：每个工作空间一个 objective（upsert），并自动按编队生成阶段任务链分发给智能体。
      await handleWrite(req, res, (body, by, scope) => {
        const objective = body.objective
        if (typeof objective !== 'string' || objective.trim().length === 0) throw new Error('缺少参数 objective')
        const targetScope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scope
        const t = now()
        db.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET objective=excluded.objective, updatedAt=excluded.updatedAt')
          .run(targetScope, objective.trim(), t, t)
        // 自动分解为阶段任务链（chain 全串 / slice 前缀链，见 ORCHESTRATION-V3）
        const mode = body.mode === 'slice' ? 'slice' : 'chain'
        const chain = createGoalChain(targetScope, objective.trim(), mode)
        const tasks = listTasks({ scope: targetScope }).filter(x => x.status !== 'canceled')
        const done = tasks.filter(x => x.status === 'done').length
        audit(by, targetScope, 'goal:publish', null, { objective: objective.trim(), mode: chain.mode, stages: chain.count })
        return { scope: targetScope, objective: objective.trim(), mode: chain.mode, done, total: tasks.length, percent: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0, stages: chain.count }
      })
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
      const skillId = url.searchParams.get('id')
      if (skillId) {
        try {
          const s = getSkill(skillId)
          // 未发布且非复审视角 → 对普通成员按「不存在」处理，不泄露待审内容
          if (s.status !== 'published' && url.searchParams.get('include') !== 'pending') {
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
        includePending: url.searchParams.get('include') === 'pending',
      }))
      return
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('retry: 2000\n\n')
      eventClients.add(res)
      const recent = db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 30').all().reverse()
      for (const r of recent) {
        res.write(`data: ${JSON.stringify({ seq: r.seq, ts: r.ts, member: r.member, scope: r.scope, action: r.action, taskId: r.taskId, detail: parseJson(r.detail, {}) })}\n\n`)
      }
      const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000)
      req.on('close', () => { clearInterval(heartbeat); eventClients.delete(res) })
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      json(res, 200, { auth: TOKEN !== '', db: DB_FILE, port: PORT })
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

// 直接运行（node server.mjs）才监听；被 import 时（测试/复用）不占端口。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`[team-hub] v2 独立服务已启动：http://${HOST}:${PORT}（db=${DB_FILE}，鉴权=${TOKEN !== '' ? 'on' : 'off'}）`)
  })
}

export { db, server, registerSkill, reviewSkill, listSkills, grantSkill, getSkill }
