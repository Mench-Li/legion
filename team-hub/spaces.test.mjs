// team-hub/spaces.test.mjs — 空间删除（R-3，S7）契约测试：级联全表 + 预检 impact + 保护/门禁矩阵 + 审计保留。
// 运行：node team-hub/spaces.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test team-hub/spaces.test.mjs）
// HTTP 范式仿 calendar.test.mjs：临时 TEAM_HUB_DB + import server.mjs + mod.server.listen(0) + fetch。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-spaces-'))
let mod
let dbFile
let base = ''
const Z = 'space-z'

before(async () => {
  dbFile = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_DB = dbFile
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function httpJson(method, path, { body, headers = {} } = {}) {
  const init = { method, headers }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(base + path, init)
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const post = (path, body) => httpJson('POST', path, { body, headers: { 'content-type': 'application/json' } })
const get = (path) => httpJson('GET', path)

/** 造数：注册空间 Z 并向各表插造数（计数供 impact/removed 断言）；返回计数期望。 */
function seedSpaceZ() {
  const t = '2026-08-01T00:00:00.000Z'
  // tasks 3（1 in_progress + 1 in_review + 1 done）
  mod.db.prepare("INSERT INTO tasks (id, title, scope, status, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run('T-Z1', 'z 进行中', Z, 'in_progress', 'coder', t, t)
  mod.db.prepare("INSERT INTO tasks (id, title, scope, status, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run('T-Z2', 'z 待验收', Z, 'in_review', 'coder', t, t)
  mod.db.prepare("INSERT INTO tasks (id, title, scope, status, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run('T-Z3', 'z 已完成', Z, 'done', 'coder', t, t)
  // roster 2
  mod.db.prepare("INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)").run(Z, 'coder', '编码兵', 'agent', '🤖', 0)
  mod.db.prepare("INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)").run(Z, 'tester', '测试兵', 'agent', '🧪', 1)
  // agent_models 2 / exec_requests 1 / skills 2 / goal 1 / exec_state 1
  mod.db.prepare("INSERT INTO agent_models (scope, role, provider, model) VALUES (?, ?, ?, ?)").run(Z, 'coder', 'p', 'm1')
  mod.db.prepare("INSERT INTO agent_models (scope, role, provider, model) VALUES (?, ?, ?, ?)").run(Z, 'tester', 'p', 'm2')
  mod.db.prepare("INSERT INTO exec_requests (taskId, scope, status, createdAt) VALUES (?, ?, ?, ?)").run('T-Z1', Z, 'running', t)
  mod.db.prepare("INSERT INTO skills (id, name, prompt, scope, owner, grants, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run('z-skill-1', 'zs1', 'p1', Z, 'general', '[]', 1, 'published', 'h', t, t)
  mod.db.prepare("INSERT INTO skills (id, name, prompt, scope, owner, grants, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run('z-skill-2', 'zs2', 'p2', Z, 'general', '[]', 1, 'pending', 'h', t, t)
  mod.db.prepare("INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)").run(Z, 'z 目标', t, t)
  mod.db.prepare("INSERT INTO exec_state (scope, enabled, updatedAt) VALUES (?, ?, ?)").run(Z, 1, t)
  // conversations 2 + messages 5
  const c1 = mod.db.prepare("INSERT INTO conversations (scope, title, kind, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(Z, '会话1', 'space', t, t).lastInsertRowid
  mod.db.prepare("INSERT INTO conversations (scope, title, kind, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(Z, '会话2', 'space', t, t)
  for (let i = 1; i <= 5; i++) {
    mod.db.prepare("INSERT INTO messages (conv_id, scope, author, kind, body, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(c1, Z, 'general', 'text', 'm' + i, '{}', t)
  }
  // calendar_events 2 / members 2
  mod.db.prepare("INSERT INTO calendar_events (scope, title, start, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(Z, '日程1', '2026-08-10T10:00', t, t)
  mod.db.prepare("INSERT INTO calendar_events (scope, title, start, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(Z, '日程2', '2026-08-11T10:00', t, t)
  mod.db.prepare("INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?)").run('m-z-1', Z, 'agent', t, 1)
  mod.db.prepare("INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?)").run('m-z-2', Z, 'agent', t, 0)
  // 之前删除遗漏的 scope 数据：回复设置、附件、规则、技能来源及磁盘附件。
  mod.db.prepare("INSERT INTO chat_reply_settings (scope, enabled, updatedAt) VALUES (?, ?, ?)").run(Z, 1, t)
  mod.db.prepare("INSERT INTO rules (key, scope, content, updatedAt) VALUES (?, ?, ?, ?)").run(Z, Z, 'z rule', t)
  mod.db.prepare("INSERT INTO skill_sources (scope, url, branch, updatedAt) VALUES (?, ?, ?, ?)").run(Z, 'https://example.test/z.git', 'main', t)
  const relAttachment = Z + '/deadbeef'
  const absAttachment = join(tmpRoot, 'uploads', relAttachment)
  mkdirSync(join(tmpRoot, 'uploads', Z), { recursive: true })
  writeFileSync(absAttachment, 'z attachment')
  mod.db.prepare("INSERT INTO chat_attachments (scope, file_name, size, kind, sha1, path, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(Z, 'z.txt', 12, 'text', 'deadbeef', relAttachment, 'sent', t)
}

/** 各表 scope=Z 剩余计数。 */
function leftovers() {
  const keys = ['tasks', 'roster', 'agent_models', 'exec_requests', 'skills', 'goal', 'exec_state', 'conversations', 'messages', 'calendar_events', 'members', 'chat_reply_settings', 'chat_attachments', 'rules', 'skill_sources']
  const out = {}
  for (const k of keys) out[k] = mod.db.prepare("SELECT COUNT(*) AS c FROM " + k + " WHERE scope = ?").get(Z).c
  out.spaces = mod.db.prepare("SELECT COUNT(*) AS c FROM spaces WHERE id = ?").get(Z).c
  return out
}

describe('TC-S7-01..04 正常删除：removed 逐表计数 + 收口断言 + audit 保留', () => {
  it('造数空间 Z 删除 → removed 计数匹配、全表零残留、列表不含 Z、audit 保留 space:delete', async () => {
    await post('/api/spaces', { id: Z, name: '测试空间', by: 'general' })
    seedSpaceZ()
    const impactBefore = await get('/api/spaces/impact?id=' + Z)
    assert.equal(impactBefore.status, 200)
    const c = impactBefore.json.counts
    assert.equal(c.tasks, 3)
    assert.equal(c.roster, 2)
    assert.equal(c.skills, 2)
    assert.equal(c.goal, 1)
    assert.equal(c.execState, 1)
    assert.equal(c.execRequests, 1)
    assert.equal(c.agentModels, 2)
    assert.equal(c.conversations, 2)
    assert.equal(c.messages, 5)
    assert.equal(c.calendarEvents, 2)
    assert.equal(c.members, 2)
    assert.equal(c.chatReplySettings, 1)
    assert.equal(c.chatAttachments, 1)
    assert.equal(c.rules, 1)
    assert.equal(c.skillSources, 1)
    assert.equal(impactBefore.json.running.tasks.length, 2, '在办任务(进行中+待验收) 2 条')
    const again = await get('/api/spaces/impact?id=' + Z)
    assert.deepEqual(again.json.counts, impactBefore.json.counts, '只读预检：两次调用间零变化')
    const del = await post('/api/spaces/delete', { id: Z, confirm: 'delete-space:' + Z, by: 'general' })
    assert.equal(del.status, 200, '删除 200：' + del.text)
    assert.equal(del.json.task.id, Z)
    assert.equal(del.json.task.removed.tasks, 3)
    assert.equal(del.json.task.removed.skills, 2)
    assert.equal(del.json.task.removed.conversations, 2)
    assert.equal(del.json.task.removed.messages, 5)
    assert.equal(del.json.task.removed.calendarEvents, 2)
    assert.equal(del.json.task.removed.members, 2)
    assert.equal(del.json.task.removed.chatReplySettings, 1)
    assert.equal(del.json.task.removed.chatAttachments, 1)
    assert.equal(del.json.task.removed.rules, 1)
    assert.equal(del.json.task.removed.skillSources, 1)
    assert.equal(existsSync(join(tmpRoot, 'uploads', Z)), false, '空间附件目录已清理')
    const remain = leftovers()
    for (const k of Object.keys(remain)) assert.equal(remain[k], 0, k + ' 零残留')
    const scopes = (await get('/api/scopes')).json.scopes
    assert.ok(!scopes.includes(Z), '/api/scopes 不含 Z（无幽灵分区）')
    const spaces = (await get('/api/spaces')).json.spaces
    assert.ok(!spaces.some(s => s.id === Z), '/api/spaces 不含 Z')
    const auditRow = mod.db.prepare("SELECT * FROM audit WHERE action = 'space:delete' AND scope = ?").get(Z)
    assert.ok(auditRow, '审计保留 space:delete（历史可追溯）')
    const detail = JSON.parse(auditRow.detail)
    assert.equal(detail.removed.messages, 5, 'audit detail 含 removed 计数')
  })
})

describe('TC-S7-05/06 护栏：受保护空间 + confirm/门禁 4xx 矩阵', () => {
  it('software/default 删除被拒（400 + 受保护文案）', async () => {
    for (const id of ['software', 'default']) {
      const r = await post('/api/spaces/delete', { id, confirm: 'delete-space:' + id, by: 'general' })
      assert.equal(r.status, 400)
      assert.ok(/受保护/.test(r.json?.error ?? ''), '文案含受保护')
    }
  })
  it('confirm 缺/错配、未知空间、非 general（无 forceGeneral）→ 4xx 且零删除', async () => {
    await post('/api/spaces', { id: 'space-k', name: 'k', by: 'general' })
    const matrix = [
      { body: { id: 'space-k', by: 'general' }, re: /confirm/ },
      { body: { id: 'space-k', confirm: 'delete-space:WRONG', by: 'general' }, re: /confirm/ },
      { body: { id: 'ghost-zz', confirm: 'delete-space:ghost-zz', by: 'general' }, re: /未知空间|ghost/ },
      { body: { id: 'space-k', confirm: 'delete-space:space-k', by: 'coder' }, re: /general/ },
    ]
    for (const m of matrix) {
      const r = await post('/api/spaces/delete', m.body)
      assert.ok(r.status >= 400 && r.status < 500, '4xx：' + r.text)
      assert.ok(r.json?.error && m.re.test(r.json.error), '可读文案：' + (r.json?.error ?? r.text))
    }
    const still = (await get('/api/spaces')).json.spaces
    assert.ok(still.some(s => s.id === 'space-k'), '零删除：space-k 仍在')
    const impact = await get('/api/spaces/impact?id=ghost-zz')
    assert.ok(impact.status === 400 || impact.status === 404, '未知空间 impact 400/404')
  })
})

describe('TC-S7-08 在办空间允许删除（D-11）+ audit 保留 + impact 未删前可查', () => {
  it('含 in_progress 任务的空间按正确 confirm + general 可删；removed.tasks 含在办行', async () => {
    await post('/api/spaces', { id: 'space-r', name: '在办空间', by: 'general' })
    const t = '2026-08-01T00:00:00.000Z'
    mod.db.prepare("INSERT INTO tasks (id, title, scope, status, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run('T-R1', '在办任务', 'space-r', 'in_progress', 'coder', t, t)
    const imp = await get('/api/spaces/impact?id=space-r')
    assert.equal(imp.json.counts.tasks, 1)
    assert.equal(imp.json.running.tasks[0].id, 'T-R1')
    const del = await post('/api/spaces/delete', { id: 'space-r', confirm: 'delete-space:space-r', by: 'general' })
    assert.equal(del.status, 200, '在办允许删除（D-11 服务端口径）')
    assert.equal(del.json.task.removed.tasks, 1)
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'space:delete' AND scope = 'space-r'").get().c === 1, 'audit 保留')
  })
})

describe('TC-S7-09 级联改动不回归 chat/skills 语义', () => {
  it('删除只含 tasks 的空间不影响其他空间数据；skills 跨空间引用随源空间删除同步移除', async () => {
    await post('/api/spaces', { id: 'space-keep', name: '保留', by: 'general' })
    const t = '2026-08-01T00:00:00.000Z'
    mod.db.prepare("INSERT INTO skills (id, name, prompt, scope, owner, grants, version, status, contentHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run('keep-skill', 'ks', 'p', 'space-keep', 'general', '[]', 1, 'published', 'h', t, t)
    const keepConv = mod.db.prepare("INSERT INTO conversations (scope, title, kind, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run('space-keep', '保留会话', 'space', t, t).lastInsertRowid
    mod.db.prepare("INSERT INTO messages (conv_id, scope, author, kind, body, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(keepConv, 'space-keep', 'general', 'text', 'keep msg', '{}', t)
    await post('/api/spaces/delete', { id: 'space-k', confirm: 'delete-space:space-k', by: 'general' })
    assert.ok((await get('/api/spaces')).json.spaces.some(s => s.id === 'space-keep'), 'space-keep 不受影响')
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conv_id = ?").get(keepConv).c === 1, '保留空间消息未误删')
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM skills WHERE scope = 'space-keep'").get().c === 1, '保留空间技能未误删')
  })
})
