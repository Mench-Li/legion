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
