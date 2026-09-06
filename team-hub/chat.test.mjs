// team-hub/chat.test.mjs — 对话中心「会话/消息」契约测试（对齐 docs/TEST_CASES.md TC-S1-01..18）。
// 运行：node team-hub/chat.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test team-hub/chat.test.mjs）
// 通过 TEAM_HUB_DB 指向临时库，动态 import server.mjs（import 不占端口，见 isMain 守卫）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-chat-'))
let mod
let dbFile

before(async () => {
  dbFile = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_DB = dbFile
  mod = await import('./server.mjs')
})

after(() => {
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 审计快照（scope + action 顺序），供 TC-S1-13 断言 chat:* 留痕形状。 */
function auditRows() {
  return mod.db.prepare('SELECT seq, member, scope, action, detail FROM audit ORDER BY seq ASC').all()
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }))
}

describe('TC-S1-01/02/04/05 会话创建与 scope 列表', () => {
  it('TC-S1-01 创建会话 → 含 id/createdAt/updatedAt/last_message_at=null；列表按 updatedAt desc 排首', () => {
    const c1 = mod.createConversation({ scope: 'software', title: '软件流水线讨论', kind: 'space', participants: ['general', 'coder'], by: 'general' })
    assert.equal(typeof c1.id, 'number')
    assert.ok(c1.id > 0)
    assert.ok(c1.createdAt && c1.updatedAt)
    assert.equal(c1.last_message_at, null)
    assert.deepEqual(c1.participants, ['general', 'coder'])
    const c2 = mod.createConversation({ scope: 'software', title: '第二次会话', kind: 'space', by: 'general' })
    const list = mod.listConversations({ scope: 'software' })
    assert.equal(list.length, 2)
    assert.equal(list[0].id, c2.id)
    assert.ok(list[0].updatedAt >= list[1].updatedAt)
  })

  it('TC-S1-02 scope 过滤：software 列表不含 default/marketing 会话', () => {
    mod.createConversation({ scope: 'default', title: '默认空间会话', kind: 'space', by: 'general' })
    mod.createConversation({ scope: 'marketing', title: '市场会话', kind: 'space', by: 'general' })
    const list = mod.listConversations({ scope: 'software' })
    assert.ok(list.every(c => c.scope === 'software'))
    assert.ok(!list.some(c => c.title === '默认空间会话' || c.title === '市场会话'))
  })

  it('TC-S1-04 kind 非法 → 拒绝并指明合法枚举；TC-S1-05 缺 by 被拒且无 chat 审计留痕', () => {
    assert.throws(() => mod.createConversation({ scope: 'software', title: 'x', kind: 'channel', by: 'general' }), /kind 必须/)
    assert.throws(() => mod.createConversation({ scope: 'software', title: 'x', kind: 'space', by: '' }), /缺少操作者身份 by/)
    const beforeCount = mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'chat:%'").get().c
    assert.throws(() => mod.createConversation({ scope: 'software', title: '无身份', kind: 'space' }), /缺少操作者身份 by/)
    assert.throws(() => mod.postMessage({ conv: 1, body: 'hi', by: '' }), /缺少操作者身份 by/)
    const afterCount = mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'chat:%'").get().c
    assert.equal(afterCount, beforeCount)
  })
})

describe('TC-S1-03/06/07 scope 隔离 + author 绑定', () => {
  it('TC-S1-03 scope 隔离反向：default 列表查不到 software 会话；跨 scope 写不串（消息 scope = 会话 scope）', () => {
    const sw = mod.createConversation({ scope: 'software', title: '隔离会话', kind: 'space', by: 'general' })
    const defList = mod.listConversations({ scope: 'default' })
    assert.ok(!defList.some(c => c.id === sw.id))
    const m = mod.postMessage({ conv: sw.id, kind: 'text', body: 'hello 隔离', by: 'general', scope: 'marketing' })
    assert.equal(m.scope, 'software')
    assert.equal(mod.listMessages({ conv: sw.id }).length, 1)
    assert.equal(mod.listMessages({ conv: sw.id })[0].body, 'hello 隔离')
  })

  it('TC-S1-06 发消息 → author=by、createdAt 有值、会话 last_message_at 更新', () => {
    const sw = mod.createConversation({ scope: 'software', title: '主会话', kind: 'space', by: 'general' })
    const before = mod.listConversations({ scope: 'software' }).find(c => c.id === sw.id)
    const m = mod.postMessage({ conv: sw.id, kind: 'text', body: 'hello', clientTs: '2026-01-01T00:00:00.000Z', by: 'general' })
    assert.equal(m.author, 'general')
    assert.ok(m.createdAt)
    const conv = mod.listConversations({ scope: 'software' }).find(c => c.id === sw.id)
    assert.ok(conv.last_message_at, 'last_message_at 已更新')
    assert.ok(new Date(conv.last_message_at) >= new Date(before.updatedAt))
  })

  it('TC-S1-07 author 冒名被服务端绑定：传入 author:other 恒等于 by', () => {
    const conv = mod.createConversation({ scope: 'software', title: '冒名会话', kind: 'space', by: 'general' })
    const m = mod.postMessage({ conv: conv.id, kind: 'text', body: '署名测试', by: 'general', author: 'other' })
    assert.equal(m.author, 'general')
    assert.notEqual(m.author, 'other')
  })
})

describe('TC-S1-08/09 分页与边界', () => {
  it('TC-S1-08 25 条消息 limit=10 → 三页 10/10/5，页内升序、拼接无重无漏', () => {
    const conv = mod.createConversation({ scope: 'software', title: '分页会话', kind: 'space', by: 'general' })
    for (let i = 1; i <= 25; i += 1) mod.postMessage({ conv: conv.id, kind: 'text', body: 'msg-' + String(i).padStart(2, '0'), by: 'general' })
    const all = mod.listMessages({ conv: conv.id })
    assert.equal(all.length, 25)
    const ids = all.map(m => m.id)
    assert.ok(ids.every((id, idx) => idx === 0 || id > ids[idx - 1]), '整体升序')
    const p1 = mod.listMessages({ conv: conv.id, limit: 10 })
    assert.equal(p1.length, 10)
    const p2 = mod.listMessages({ conv: conv.id, limit: 10, before: p1[0].id })
    assert.equal(p2.length, 10)
    const p3 = mod.listMessages({ conv: conv.id, limit: 10, before: p2[0].id })
    assert.equal(p3.length, 5)
    for (const page of [p1, p2, p3]) {
      const pids = page.map(m => m.id)
      assert.ok(pids.every((id, idx) => idx === 0 || id > pids[idx - 1]), '页内升序')
    }
    const joined = [...p1, ...p2, ...p3]
    assert.equal(new Set(joined.map(m => m.id)).size, 25, '无重复')
    assert.deepEqual(new Set(joined.map(m => m.id)), new Set(ids), '无遗漏')
    assert.ok(p2.every(m => m.id < p1[0].id) && p3.every(m => m.id < p2[0].id), '页间游标连续')
  })

  it('TC-S1-09 分页边界：空会话 []、超界游标 []、缺省 limit=50、非法 limit 拒绝', () => {
    const empty = mod.createConversation({ scope: 'software', title: '空会话', kind: 'space', by: 'general' })
    const conv = mod.createConversation({ scope: 'software', title: '边界会话', kind: 'space', by: 'general' })
    for (let i = 1; i <= 3; i += 1) mod.postMessage({ conv: conv.id, kind: 'text', body: 'b' + i, by: 'general' })
    assert.deepEqual(mod.listMessages({ conv: empty.id }), [])
    const msgs = mod.listMessages({ conv: conv.id })
    assert.deepEqual(mod.listMessages({ conv: conv.id, before: msgs[0].id - 1 }), [], '游标早于最旧 → 空')
    assert.equal(mod.listMessages({ conv: conv.id, before: msgs[msgs.length - 1].id + 1 }).length, 3, '游标晚于最新 → 全量（分页尾部语义）')
    assert.equal(mod.listMessages({ conv: conv.id }).length, 3)
    assert.equal(mod.listMessages({ conv: conv.id, limit: 50 }).length, 3)
    for (const bad of [0, -1, 1.5, 'abc']) assert.throws(() => mod.listMessages({ conv: conv.id, limit: bad }), /limit/)
  })

  it('TC-S1-10 未知会话发消息/列消息 → 拒绝且不落任何消息行', () => {
    assert.throws(() => mod.postMessage({ conv: 999999, kind: 'text', body: 'x', by: 'general' }), /会话不存在/)
    assert.throws(() => mod.listMessages({ conv: 999999 }), /会话不存在/)
  })

  it('TC-S1-11 空正文被拒', () => {
    const conv = mod.createConversation({ scope: 'software', title: '空正文会话', kind: 'space', by: 'general' })
    assert.throws(() => mod.postMessage({ conv: conv.id, kind: 'text', body: '', by: 'general' }), /不能为空/)
    assert.throws(() => mod.postMessage({ conv: conv.id, kind: 'text', body: '   ', by: 'general' }), /不能为空/)
  })

  it('TC-S1-12 正文长度上限 MAX_CHAT_BODY：恰好通过、+1 拒绝且不落库', () => {
    const conv = mod.createConversation({ scope: 'software', title: '长度会话', kind: 'space', by: 'general' })
    const max = mod.MAX_CHAT_BODY
    const okMsg = mod.postMessage({ conv: conv.id, kind: 'text', body: 'a'.repeat(max), by: 'general' })
    assert.equal(okMsg.body.length, max)
    assert.throws(() => mod.postMessage({ conv: conv.id, kind: 'text', body: 'a'.repeat(max + 1), by: 'general' }), /超长/)
    assert.equal(mod.listMessages({ conv: conv.id }).length, 1)
  })
})

describe('TC-S1-13 审计留痕（chat 写统一 audit：by + scope + SSE 广播前置）', () => {
  it('create + message 各产生 chat:* 审计行（member/scope/detail 形状 + seq 升序）', () => {
    const conv = mod.createConversation({ scope: 'software', title: '审计会话', kind: 'space', by: 'general' })
    mod.postMessage({ conv: conv.id, kind: 'text', body: '审计测试', by: 'coder' })
    const rows = auditRows().filter(r => r.action.startsWith('chat:'))
    assert.ok(rows.some(r => r.action === 'chat:create' && r.member === 'general' && r.scope === 'software' && r.detail.conv === conv.id))
    assert.ok(rows.some(r => r.action === 'chat:message' && r.member === 'coder' && r.scope === 'software' && typeof r.detail.msg === 'number'))
    const seqs = rows.map(r => r.seq)
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), '审计 seq 升序')
  })
})

describe('TC-S1-16 老库迁移：无 chat 表旧库自动建表 + 存量数据无损', () => {
  it('旧 schema（tasks/skills 有数据、无 conversations/messages）import 后自动建两表且 chat 可用', async () => {
    const oldFile = join(tmpRoot, 'old-team.db')
    const old = new DatabaseSync(oldFile)
    old.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', acceptance TEXT DEFAULT '[]', boundary TEXT DEFAULT '[]', priority TEXT DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1, soldier TEXT, scope TEXT DEFAULT 'default', comments TEXT DEFAULT '[]', evidence TEXT DEFAULT '[]', patches TEXT DEFAULT '[]', createdAt TEXT, updatedAt TEXT)")
    old.prepare('INSERT INTO tasks (id, title, status, scope, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('T-OLD', '存量任务', 'todo', 'software', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.exec("CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', prompt TEXT DEFAULT '', scope TEXT DEFAULT 'default', owner TEXT, grants TEXT DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT 'pending', contentHash TEXT DEFAULT '', reviewedAt TEXT, createdAt TEXT, updatedAt TEXT)")
    old.prepare('INSERT INTO skills (id, name, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', '存量技能', 'published', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.close()

    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import('./server.mjs?migration=' + Date.now())
    const tables = m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables.includes('conversations') && tables.includes('messages'), '自动建 chat 两表')
    const task = m2.db.prepare("SELECT * FROM tasks WHERE id = 'T-OLD'").get()
    assert.equal(task.title, '存量任务')
    assert.equal(m2.getSkill('legacy').status, 'published')
    const conv = m2.createConversation({ scope: 'software', title: '迁移后新会话', kind: 'space', by: 'general' })
    const m = m2.postMessage({ conv: conv.id, kind: 'text', body: 'migration ok', by: 'general' })
    assert.ok(m.id > 0)
    m2.db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// S9（R-4）对话 AI 回复数据面：chat_reply_settings + awaiting 状态机 + 队列 + CAS 回写 + 超龄兜底
// 对齐 docs/TEST_CASES.md TC-S9-01..13（追加 describe）
// ─────────────────────────────────────────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
function msgMeta(msg) { return msg?.meta ?? {} }
function replyAuditRows(actionPrefix) {
  return mod.db.prepare('SELECT seq, member, scope, action, detail FROM audit ORDER BY seq ASC').all()
    .filter(r => actionPrefix === undefined || r.action.startsWith(actionPrefix))
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }))
}

describe('S9 TC-S9-01 chat_reply_settings 建表幂等 + 旧库自动建表', () => {
  it('新库含 chat_reply_settings；旧库（无此表）import 自动建表且 chat 存量完整', async () => {
    const tables = mod.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables.includes('chat_reply_settings'), '自动建 chat_reply_settings 表')
    const cols = mod.db.prepare('PRAGMA table_info(chat_reply_settings)').all().map(c => c.name)
    for (const c of ['scope', 'enabled', 'model', 'identity', 'systemHint', 'updatedAt']) assert.ok(cols.includes(c), '列 ' + c)
    // 旧库：只有 chat 两表（无 chat_reply_settings）→ import 自动补建，chat 存量完整
    const oldFile = join(tmpRoot, 'old2-team.db')
    const old = new DatabaseSync(oldFile)
    old.exec("CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'space', participants TEXT DEFAULT '[]', createdAt TEXT, updatedAt TEXT, last_message_at TEXT)")
    old.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'default', author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL, meta TEXT DEFAULT '{}', client_ts TEXT, createdAt TEXT)")
    const c = old.prepare("INSERT INTO conversations (scope, title, kind, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run('software', '存量会话', 'space', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').lastInsertRowid
    old.prepare("INSERT INTO messages (conv_id, scope, author, kind, body, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(c, 'software', 'general', 'text', '存量消息', '{}', '2026-01-01T00:00:00.000Z')
    old.close()
    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import('./server.mjs?migration-s9=' + Date.now())
    const tables2 = m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables2.includes('chat_reply_settings'), '旧库自动建 chat_reply_settings')
    assert.equal(m2.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1, 'chat 存量完整')
    const msg = m2.db.prepare('SELECT * FROM messages LIMIT 1').get()
    assert.equal(JSON.parse(msg.meta).aiStatus, undefined, '旧消息 meta 默认无 aiStatus（兼容渲染）')
    m2.db.close()
  })
})

describe('S9 TC-S9-02 回复开关：默认开 + 持久化 + per-scope 隔离', () => {
  it('未设置默认 enabled=true；POST enabled:false 持久化；software/marketing 互不影响；重启（新 import 同库）后保持', async () => {
    const d = mod.getReplySettings('software')
    assert.equal(d.enabled, true, '未设置默认开（D-13）')
    assert.equal(d.model, null)
    assert.equal(d.identity, null)
    const saved = mod.saveReplySettings({ scope: 'software', enabled: false, by: 'general' })
    assert.equal(saved.enabled, false)
    assert.equal(mod.getReplySettings('software').enabled, false, '回读 false')
    assert.equal(mod.getReplySettings('marketing').enabled, true, 'marketing 不受影响')
    // 重启/重连（同库新 import，只读不写——双实例共享库时写会与主实例审计 seq 冲突）后仍 false
    process.env.TEAM_HUB_DB = dbFile
    const m2 = await import('./server.mjs?reopen-s9=' + Date.now())
    assert.equal(m2.getReplySettings('software').enabled, false, '重启后持久化 false')
    m2.db.close()
    const restored = mod.saveReplySettings({ scope: 'software', enabled: true, by: 'general' })
    assert.equal(restored.enabled, true, '恢复 true')
    assert.ok(replyAuditRows('chat:reply-settings').some(r => r.scope === 'software' && r.detail.enabled === false), 'settings 写留 chat:reply-settings 审计')
  })
})

describe('S9 TC-S9-03/04 awaiting 状态机：开关开标 awaiting；开关关无 awaiting 且人-人消息正常', () => {
  it('开关开（默认）发送 → meta.aiStatus=awaiting；author=general；会话更新正常', async () => {
    const conv = mod.createConversation({ scope: 's9-on', title: '开关开会话', kind: 'space', by: 'general' })
    const m = mod.postMessage({ conv: conv.id, body: '你好，请帮我总结', by: 'general' })
    assert.equal(m.author, 'general')
    assert.equal(msgMeta(m).aiStatus, 'awaiting', '返回消息带 meta.aiStatus=awaiting')
    assert.ok(msgMeta(m).aiStatusAt, 'awaiting 带时间戳')
    const after = mod.listConversations({ scope: 's9-on' }).find(x => x.id === conv.id)
    assert.ok(after.last_message_at && after.updatedAt, '会话正常更新')
  })
  it('开关关（enabled:false）发送 → 无 aiStatus；不进队列；人-人消息本身正常', async () => {
    mod.saveReplySettings({ scope: 's9-off', enabled: false, by: 'general' })
    const conv = mod.createConversation({ scope: 's9-off', title: '开关关会话', kind: 'space', by: 'general' })
    const m = mod.postMessage({ conv: conv.id, body: '你好（开关关）', by: 'general' })
    assert.equal(msgMeta(m).aiStatus, undefined, '开关关不标 awaiting（或无 aiStatus）')
    assert.equal(m.author, 'general')
    assert.equal(m.body, '你好（开关关）', '人-人消息本身正常存储')
    assert.deepEqual(mod.listAwaitingReplies({ scope: 's9-off' }), [], '不进回复队列')
  })
})

describe('S9 TC-S9-05 回复方身份：默认 <scope>-assistant；identity 消息不自我触发', () => {
  it('replyIdentityFor 默认 = scope+-assistant；该身份发消息 author=by 且不被再标 awaiting', async () => {
    assert.equal(mod.replyIdentityFor('s9-id'), 's9-id-assistant', '身份默认 <scope>-assistant')
    assert.notEqual(mod.replyIdentityFor('s9-id'), 'general')
    const conv = mod.createConversation({ scope: 's9-id', title: '身份会话', kind: 'space', by: 'general' })
    const m = mod.postMessage({ conv: conv.id, body: '回复内容', by: 's9-id-assistant' })
    assert.equal(m.author, 's9-id-assistant', 'author=by 防冒名不回归')
    assert.equal(msgMeta(m).aiStatus, undefined, 'identity 消息不标 awaiting（防自我触发死循环）')
    // identity 自定义覆盖
    mod.saveReplySettings({ scope: 's9-id', identity: 's9-bot', by: 'general' })
    assert.equal(mod.replyIdentityFor('s9-id'), 's9-bot', 'settings.identity 覆盖默认')
  })
})

describe('S9 TC-S9-06 回复队列：awaiting 列表含上下文 + limit + 跨空间隔离', () => {
  it('两会话 awaiting → 队列含两者（conv/msg id/body/context 最近 N 条）；limit 上限防爆；marketing 不含 software', async () => {
    const c1 = mod.createConversation({ scope: 's9-q', title: '队列会话1', kind: 'space', by: 'general' })
    mod.postMessage({ conv: c1.id, body: 'q1 前置1', by: 'general' })
    mod.postMessage({ conv: c1.id, body: 'q1 前置2', by: 'coder' })
    const m1 = mod.postMessage({ conv: c1.id, body: 'q1 提问', by: 'general' })
    const c2 = mod.createConversation({ scope: 's9-q', title: '队列会话2', kind: 'space', by: 'general' })
    const m2 = mod.postMessage({ conv: c2.id, body: 'q2 提问', by: 'coder' })
    const queue = mod.listAwaitingReplies({ scope: 's9-q', sinceMsgId: 0 })
    assert.ok(queue.some(x => x.id === m1.id), '队列含 m1')
    assert.ok(queue.some(x => x.id === m2.id), '队列含 m2')
    const q1 = queue.find(x => x.id === m1.id)
    assert.equal(q1.convId, c1.id)
    assert.ok(q1.body.length > 0)
    assert.ok(Array.isArray(q1.context) && q1.context.length === 2, 'context 聚合最近 2 条（不含自身）')
    assert.equal(q1.context[0].body, 'q1 前置1', 'context[0] = 更早的前置消息')
    assert.equal(q1.context[1].body, 'q1 前置2', 'context[1] = 最近一条前置消息（不含自身）')
    const lim = mod.listAwaitingReplies({ scope: 's9-q', limit: 1 })
    assert.equal(lim.length, 1, 'limit 生效')
    const other = mod.listAwaitingReplies({ scope: 'marketing' })
    assert.deepEqual(other, [], 'marketing 队列不含 s9-q awaiting（跨空间隔离）')
    // sinceMsgId 语义：从 id 之后开始
    const since = mod.listAwaitingReplies({ scope: 's9-q', sinceMsgId: m1.id })
    assert.ok(!since.some(x => x.id === m1.id), 'sinceMsgId 过滤更早 awaiting')
  })
})

describe('S9 TC-S9-08/11 CAS 回写：awaiting→replied；重复/并发幂等不产生第二条回复', () => {
  it('postAiReply 落回复消息（author=by）+ 源消息 replied + audit/SSE；第二次回写幂等 skipped', async () => {
    const conv = mod.createConversation({ scope: 's9-cas', title: 'CAS 会话', kind: 'space', by: 'general' })
    const src = mod.postMessage({ conv: conv.id, body: '需要总结的问题', by: 'general' })
    const beforeAudit = replyAuditRows('chat:message').length
    const out = mod.postAiReply({ msgId: src.id, body: '这是 AI 的总结回复', by: 's9-cas-assistant', model: 'deepseek-chat' })
    assert.equal(out.skipped, false)
    assert.equal(out.reply.author, 's9-cas-assistant', '回复 author=by')
    assert.equal(out.reply.convId, conv.id)
    assert.equal(out.reply.meta.replyTo, src.id)
    assert.equal(out.reply.meta.aiModel, 'deepseek-chat', '回复带模型徽标 meta')
    assert.equal(out.source.meta.aiStatus, 'replied', '源消息状态回写 replied')
    const rows = replyAuditRows('chat:message').slice(beforeAudit)
    assert.ok(rows.some(r => r.member === 's9-cas-assistant' && r.detail.ai === true), '审计 chat:message member=回复方')
    const queue = mod.listAwaitingReplies({ scope: 's9-cas' })
    assert.ok(!queue.some(x => x.id === src.id), '已 replied 不再出现在队列')
    const dup = mod.postAiReply({ msgId: src.id, body: '第二条重复回复', by: 's9-cas-assistant' })
    assert.equal(dup.skipped, true, '第二次回写幂等（skipped）')
    const msgs = mod.db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id').all(conv.id).map(m => m.id)
    const replies = msgs.slice(msgs.indexOf(src.id) + 1)
    assert.equal(replies.length, 1, '不产生第二条回复')
  })
})

describe('S9 TC-S9-07 超龄兜底：CHAT_REPLY_TIMEOUT_MS 小值注入 → failed + error，退出队列', () => {
  it('awaiting 超时后被标 failed（含 timeout 语义）且不再出现在 replies', async () => {
    const oldFile = join(tmpRoot, 'timeout-team.db')
    process.env.CHAT_REPLY_TIMEOUT_MS = '200'
    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import('./server.mjs?timeout-s9=' + Date.now())
    const conv = m2.createConversation({ scope: 's9-to', title: '超时会话', kind: 'space', by: 'general' })
    const src = m2.postMessage({ conv: conv.id, body: '会超时的提问', by: 'general' })
    assert.equal(src.meta.aiStatus, 'awaiting')
    await sleepMs(300)
    const queue = m2.listAwaitingReplies({ scope: 's9-to' })
    assert.deepEqual(queue, [], '超龄消息退出队列')
    const failed = m2.db.prepare('SELECT meta FROM messages WHERE id = ?').get(src.id).meta
    const meta = JSON.parse(failed)
    assert.equal(meta.aiStatus, 'failed', '兜底标 failed')
    assert.ok(/timeout|超时/i.test(meta.aiError ?? ''), 'error 含超时语义')
    m2.db.close()
  })
})

describe('S9 retry 重试 + 边界（TC-S9-10 族）', () => {
  it('failed 消息重试回 awaiting；已 replied 拒绝重试；回复正文 8000 边界', async () => {
    const conv = mod.createConversation({ scope: 's9-rty', title: '重试会话', kind: 'space', by: 'general' })
    const src = mod.postMessage({ conv: conv.id, body: '需重试的提问', by: 'general' })
    // 直接置 failed（模拟超时/失败路径）
    const meta = { ...src.meta, aiStatus: 'failed', aiError: '模拟失败' }
    mod.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), src.id)
    const retried = mod.retryAiReply({ msgId: src.id, by: 'general' })
    assert.equal(retried.meta.aiStatus, 'awaiting', '重试回 awaiting')
    assert.equal(retried.meta.aiError, undefined, '失败原因清除')
    const queue = mod.listAwaitingReplies({ scope: 's9-rty' })
    assert.ok(queue.some(x => x.id === src.id), '重试后重新入队')
    // 已 replied 拒绝重试
    const out = mod.postAiReply({ msgId: src.id, body: '真回复', by: 's9-rty-assistant' })
    assert.equal(out.skipped, false)
    assert.throws(() => mod.retryAiReply({ msgId: src.id, by: 'general' }), /无需重试/)
    // failAiReply（S10 守护显式失败回写）：awaiting → failed + error；二次幂等 skipped
    const conv3 = mod.createConversation({ scope: 's9-fl', title: '失败回写会话', kind: 'space', by: 'general' })
    const src3 = mod.postMessage({ conv: conv3.id, body: '失败注入的提问', by: 'general' })
    const f1 = mod.failAiReply({ msgId: src3.id, by: 's9-fl-assistant', error: '模型不存在（模拟）' })
    assert.equal(f1.skipped, false)
    assert.equal(f1.source.meta.aiStatus, 'failed')
    assert.match(f1.source.meta.aiError, /模型不存在/)
    const f2 = mod.failAiReply({ msgId: src3.id, by: 's9-fl-assistant', error: '再次失败尝试' })
    assert.equal(f2.skipped, true, '非 awaiting 幂等跳过')
    assert.ok(replyAuditRows('chat:fail').some(r => r.detail.msg === src3.id), 'audit chat:fail 留痕')
    // 回复正文 8000 恰过 / 8001 拒绝（MAX_CHAT_BODY 常量断言）
    const conv2 = mod.createConversation({ scope: 's9-bd', title: '边界会话', kind: 'space', by: 'general' })
    const src2 = mod.postMessage({ conv: conv2.id, body: '边界提问', by: 'general' })
    const ok = mod.postAiReply({ msgId: src2.id, body: 'a'.repeat(mod.MAX_CHAT_BODY), by: 's9-bd-assistant' })
    assert.equal(ok.skipped, false, '恰 8000 放行')
    assert.throws(() => mod.postAiReply({ msgId: src2.id, body: 'a'.repeat(mod.MAX_CHAT_BODY + 1), by: 's9-bd-assistant' }), /超长/, '8001 拒绝')
  })
})

describe('S9 HTTP 层：settings/replies/answer 路由契约 + 非法入参 400（listen(0)）', () => {
  let base = ''
  before(async () => {
    await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
    base = 'http://127.0.0.1:' + mod.server.address().port
  })
  after(() => {
    try { mod.server.closeAllConnections?.() } catch { /* 无连接 */ }
    try { mod.server.close() } catch { /* 已关闭 */ }
  })
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  const get = async (path) => {
    const res = await fetch(base + path)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  it('GET/POST /api/chat/reply-settings 读写；GET /api/chat/replies 队列与非法入参 400', async () => {
    const g = await get('/api/chat/reply-settings?scope=http-s9')
    assert.equal(g.status, 200)
    assert.equal(g.json.enabled, true, 'HTTP 默认开')
    const p = await post('/api/chat/reply-settings', { scope: 'http-s9', enabled: false, by: 'general' })
    assert.equal(p.status, 200)
    assert.equal(p.json.task.enabled, false)
    const g2 = await get('/api/chat/reply-settings?scope=http-s9')
    assert.equal(g2.json.enabled, false)
    const conv = mod.createConversation({ scope: 'http-s9', title: 'http 会话', kind: 'space', by: 'general' })
    // 开关关 → 无 awaiting → replies 空
    await post('/api/chat/messages', { conv: conv.id, body: '关闭时发送', by: 'general' })
    const empty = await get('/api/chat/replies?scope=http-s9')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.messages, [], '关闭无队列')
    // 恢复开启 → awaiting 可见
    await post('/api/chat/reply-settings', { scope: 'http-s9', enabled: true, by: 'general' })
    const m = await post('/api/chat/messages', { conv: conv.id, body: '开启后发送', by: 'general' })
    assert.equal(m.json.task.meta.aiStatus, 'awaiting')
    const q = await get('/api/chat/replies?scope=http-s9&sinceMsgId=0')
    assert.ok(q.json.messages.some(x => x.id === m.json.task.id), '开启后入队')
    // 非法入参 → 400
    for (const [path, re] of [
      ['/api/chat/replies?scope=', /scope/],
      ['/api/chat/replies?scope=http-s9&sinceMsgId=abc', /sinceMsgId/],
      ['/api/chat/replies?scope=http-s9&sinceMsgId=-1', /sinceMsgId/],
      ['/api/chat/replies?scope=http-s9&limit=0', /limit/],
      ['/api/chat/replies?scope=http-s9&limit=-3', /limit/],
    ]) {
      const r = await get(path)
      assert.equal(r.status, 400, path + ' 400：' + r.text)
      assert.ok(r.json?.error && re.test(r.json.error), '可读错误：' + (r.json?.error ?? r.text))
    }
    const alive = await get('/api/config')
    assert.equal(alive.status, 200, '进程存活无 500')
  })
})

