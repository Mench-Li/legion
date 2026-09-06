// team-hub/rules.test.mjs — 规范层（rules）契约测试（R-2，S4；RESEARCH K3-A）。
// 运行：node team-hub/rules.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test team-hub/rules.test.mjs）
// HTTP 范式仿 calendar.test.mjs：临时 TEAM_HUB_DB + import server.mjs + mod.server.listen(0) + fetch；SSE 收集断言 ≤5s。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as httpMod from 'node:http'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-rules-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let mod
let dbFile
let base = ''
const openCollectors = []

before(async () => {
  dbFile = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_DB = dbFile
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  for (const req of openCollectors) { try { req.destroy() } catch { /* 已关闭 */ } }
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

function auditRows(actionPrefix) {
  return mod.db.prepare('SELECT seq, member, scope, action, taskId, detail FROM audit ORDER BY seq ASC').all()
    .filter(r => actionPrefix === undefined || r.action.startsWith(actionPrefix))
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }))
}
const ruleCount = () => mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action LIKE 'rules:%'").get().c
const tableNames = () => mod.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)

/** SSE 订阅收集器：连接后忽略旧回放，等匹配 live 帧（≤5s）。 */
function sseCollector() {
  const seen = []
  let closed = false
  const req = httpMod.get(base + '/api/events', (res) => {
    let buf = ''
    res.on('data', (d) => {
      buf += d.toString()
      const frames = buf.split('\n\n')
      buf = frames.pop()
      for (const f of frames) {
        const m = /^data: (.+)$/m.exec(f)
        if (!m) continue
        try { const ev = JSON.parse(m[1]); if (ev && ev.action) seen.push(ev) } catch { /* 忽略 */ }
      }
    })
  })
  req.on('error', () => { closed = true })
  openCollectors.push(req)
  return {
    seen,
    waitFor(pred, timeoutMs = 5000) {
      return new Promise((resolve) => {
        const t0 = Date.now()
        const tick = () => {
          const hit = seen.find(pred)
          if (hit) return resolve(hit)
          if (Date.now() - t0 > timeoutMs) return resolve(null)
          setTimeout(tick, 25)
        }
        tick()
      })
    },
    close() { if (!closed) { try { req.destroy() } catch { /* 已关闭 */ } } },
  }
}

describe('TC-S4-01 rules 建表幂等 + 旧库自动建表', () => {
  it('新库表结构；同库二次 import 幂等', async () => {
    assert.ok(tableNames().includes('rules'), '自动建 rules 表')
    const cols = mod.db.prepare('PRAGMA table_info(rules)').all().map(c => c.name)
    for (const c of ['key', 'scope', 'content', 'updatedAt']) assert.ok(cols.includes(c), '列 ' + c)
    const m2 = await import('./server.mjs?same-db-rules=' + Date.now())
    assert.ok(m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rules'").get(), '再 import 幂等')
    m2.db.close()
  })

  it('旧库（无 rules 表、有 chat/skills 存量）import 自动建表且存量无损', async () => {
    const oldFile = join(tmpRoot, 'old-team.db')
    const old = new DatabaseSync(oldFile)
    old.exec("CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', prompt TEXT DEFAULT '', scope TEXT DEFAULT 'default', owner TEXT, grants TEXT DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT 'pending', contentHash TEXT DEFAULT '', reviewedAt TEXT, createdAt TEXT, updatedAt TEXT)")
    old.prepare('INSERT INTO skills (id, name, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', '存量技能', 'published', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'default', author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL, meta TEXT DEFAULT '{}', client_ts TEXT, createdAt TEXT)")
    old.prepare('INSERT INTO messages (conv_id, scope, author, kind, body, meta, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1, 'software', 'general', 'text', '存量消息', '{}', '2026-01-01T00:00:00.000Z')
    old.close()
    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import('./server.mjs?migration-rules=' + Date.now())
    const tables = m2.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert.ok(tables.includes('rules'), '旧库自动建 rules 表')
    assert.equal(m2.getSkill('legacy').status, 'published', '存量技能无损')
    assert.equal(m2.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1, '存量消息无损')
    m2.db.close()
  })
})

describe('TC-S4-02 GET 默认值', () => {
  it('未设置 → 200 {ok, rules:{scope, content 空串, updatedAt:null}}；预留空间层 scope 不 500', async () => {
    const g = await get('/api/rules?scope=global')
    assert.equal(g.status, 200)
    assert.equal(g.json.ok, true)
    assert.equal(g.json.rules.scope, 'global')
    assert.equal(g.json.rules.content, '')
    assert.equal(g.json.rules.updatedAt, null)
    const s = await get('/api/rules?scope=software')
    assert.equal(s.status, 200)
    assert.equal(s.json.rules.scope, 'software')
    assert.equal(s.json.rules.content, '')
    const bad = await get('/api/rules?scope=BAD_Scope!')
    assert.equal(bad.status, 400, '非法 scope 400')
  })
})

describe('TC-S4-03 POST 写入 → 回读一致 + audit + SSE ≤5s', () => {
  it('保存全局规范 → GET 回读逐字一致 + audit rules:update + SSE 帧', async () => {
    const marker = '团队规范-SSE-' + Date.now()
    const collector = sseCollector()
    try {
      const r = await post('/api/rules', { scope: 'global', content: marker, by: 'general' })
      assert.equal(r.status, 200, 'POST 200：' + r.text)
      assert.equal(r.json.ok, true)
      assert.equal(r.json.task.content, marker)
      assert.ok(r.json.task.updatedAt, 'updatedAt 已刷新')
      const g = await get('/api/rules?scope=global')
      assert.equal(g.json.rules.content, marker, '回读逐字一致')
      const rows = auditRows('rules:')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].action, 'rules:update')
      assert.equal(rows[0].member, 'general')
      assert.equal(rows[0].scope, 'global')
      assert.equal(rows[0].detail.scope, 'global')
      assert.equal(rows[0].detail.contentLength, marker.length)
      const live = await collector.waitFor((e) => e.action === 'rules:update' && e.member === 'general' && e.detail && e.detail.contentLength === marker.length)
      assert.ok(live, '≤5s 收到 SSE rules:update 帧')
      const act = await get('/api/activity?scope=global')
      assert.ok(act.json.some(x => x.action === 'rules:update'), '/api/activity 可查 rules:update')
    } finally { collector.close() }
  })
})

describe('TC-S4-04 非法输入矩阵 → 400 零落库零 audit', () => {
  it('缺 by / 非法 scope / content 非字符串 / 超 MAX_RULES_LEN → 400 + 可读文案，零落库', async () => {
    const beforeAudit = ruleCount()
    const max = mod.MAX_RULES_LEN
    const cases = [
      { body: { scope: 'global', content: 'x' }, re: /by/ },
      { body: { scope: 'global', content: 'x', by: '   ' }, re: /by/ },
      { body: { scope: 'Bad!', content: 'x', by: 'general' }, re: /scope/ },
      { body: { scope: 'global', content: 42, by: 'general' }, re: /content/ },
      { body: { scope: 'global', content: { a: 1 }, by: 'general' }, re: /content/ },
      { body: { scope: 'global', content: 'a'.repeat(max + 1), by: 'general' }, re: /超长/ },
    ]
    for (const c of cases) {
      const r = await post('/api/rules', c.body)
      assert.equal(r.status, 400, '400：' + r.text)
      assert.ok(r.json && r.json.error && c.re.test(r.json.error), '错误指明字段：' + (r.json?.error ?? r.text))
    }
    assert.equal(ruleCount(), beforeAudit, '零 rules:update audit')
    const before = (await get('/api/rules?scope=global')).json.rules.content
    const g = await get('/api/rules?scope=global')
    assert.equal(g.json.rules.content, before, '零落库（回读值不变）')
  })
})

describe('TC-S4-05 边界值：恰 3000 / 清空 / 覆盖更新 upsert', () => {
  it('content 恰 3000 → 200；清空 → 200 且回读空串；同一 key 重复 POST → upsert 不产生重复行', async () => {
    const max = mod.MAX_RULES_LEN
    const r1 = await post('/api/rules', { scope: 'global', content: 'a'.repeat(max), by: 'general' })
    assert.equal(r1.status, 200, '恰 3000 放行：' + r1.text)
    const r2 = await post('/api/rules', { scope: 'global', content: '', by: 'general' })
    assert.equal(r2.status, 200)
    const g2 = await get('/api/rules?scope=global')
    assert.equal(g2.json.rules.content, '', '清空生效')
    await post('/api/rules', { scope: 'global', content: '新内容-v2', by: 'general' })
    const g3 = await get('/api/rules?scope=global')
    assert.equal(g3.json.rules.content, '新内容-v2')
    const cnt = mod.db.prepare("SELECT COUNT(*) AS c FROM rules WHERE scope = 'global'").get().c
    assert.equal(cnt, 1, 'upsert 无重复行')
  })
})

describe('TC-S4-06 GET 无副作用 + 读写纪律', () => {
  it('GET /api/rules 不产生任何 audit 行', async () => {
    const beforeAudit = ruleCount()
    await get('/api/rules?scope=global')
    await get('/api/rules?scope=software')
    assert.equal(ruleCount(), beforeAudit, 'GET 无写审计副作用')
  })
})
