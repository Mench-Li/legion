// team-hub/agent-identity-tokens.test.mjs — S3 接口面：新建自动分配人形令牌 + 读出口兜底收敛。
// 运行：node team-hub/agent-identity-tokens.test.mjs（临时库 + 真端口；不写 live 库）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-agent-tokens-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const TOKEN_RE = /^human:[a-z0-9-]+$/
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const get = async (p) => {
  const res = await fetch(base + p)
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const row = (scope, role) => mod.db.prepare('SELECT * FROM roster WHERE scope = ? AND role = ?').get(scope, role)
const reset = () => { mod.db.prepare('DELETE FROM roster').run(); mod.db.prepare('DELETE FROM audit').run() }
const auditCount = () => mod.db.prepare('SELECT COUNT(*) c FROM audit').get().c

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

test('TC-S3-01/02 不带/空/emoji avatar 都落 human 令牌（AC-R7-2）', async () => {
  reset()
  for (const avatar of [undefined, '', '\u{1F916}']) {
    const body = { by: 'general', scope: 'software', role: 'requirement', name: '析言' }
    if (avatar !== undefined) body.avatar = avatar
    const res = await post('/api/agents', body)
    assert.ok(res.status < 400, 'HTTP ' + res.status + ' ' + JSON.stringify(res.body))
    assert.equal(row('software', 'requirement').avatar, 'human:requirement')
  }
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM roster WHERE avatar = ?').get('\u{1F916}').c, 0)
})

test('TC-S3-03 自建 role 取最小未占用 sNN 且互不相同（AC-R3-3）', async () => {
  reset()
  await post('/api/agents', { by: 'general', scope: 'software', role: 'hr-analyst', name: '甄才' })
  await post('/api/agents', { by: 'general', scope: 'software', role: 'legal-advisor', name: '衡法' })
  const a = row('software', 'hr-analyst').avatar
  const b = row('software', 'legal-advisor').avatar
  assert.match(a, TOKEN_RE); assert.match(b, TOKEN_RE); assert.notEqual(a, b)
  assert.match(a, /^human:s\d{2}$/)
})

test('TC-S3-04 跨 scope 同 role 恒同令牌（AC-R5-1）', async () => {
  reset()
  for (const scope of ['software', 'marketing', 'product', 'ops', 'default']) {
    await post('/api/agents', { by: 'general', scope, role: 'coder', name: '衡码' })
  }
  const vals = mod.db.prepare("SELECT DISTINCT avatar FROM roster WHERE role = 'coder'").all().map((r) => r.avatar)
  assert.deepEqual(vals, ['human:coder'])
})

test('TC-S3-05/06 空名与非法 role 被拒且零写入（AC-R6-3）', async () => {
  reset()
  const bads = [
    { role: 'coder' }, { role: 'coder', name: '' }, { role: 'coder', name: '   ' },
    { role: 'Coder', name: 'x' }, { role: 'a b', name: 'x' }, { role: '编码', name: 'x' },
    { role: 'a'.repeat(65), name: 'x' }, { role: '', name: 'x' },
  ]
  for (const bad of bads) {
    const res = await post('/api/agents', Object.assign({ by: 'general' }, bad))
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM roster').get().c, 0, '拒绝时必须零写入')
})

test('TC-S3-13 非法 avatar 绝不原样落库（AC-R3-1）', async () => {
  reset()
  const bads = ['not-a-token', '<img src=x onerror=alert(1)>', '\u{1F916}\u{1F98A}', 'x'.repeat(200), 'human:', 'HUMAN:coder']
  let i = 0
  for (const bad of bads) {
    const role = 'bad-' + i; i += 1
    const res = await post('/api/agents', { by: 'general', scope: 'software', role, name: '验一', avatar: bad })
    assert.ok(res.status < 400, JSON.stringify(res.body))
    const stored = row('software', role).avatar
    assert.match(stored, TOKEN_RE, '必须归一为合法令牌，实际=' + stored)
    assert.ok(!EMOJI_RE.test(stored))
    assert.ok(!stored.includes('<'))
  }
})

test('TC-S3-07 读出口成员头像不再是 emoji（AC-R7-1）', async () => {
  reset()
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,NULL,?)').run('rv', 'no-avatar', '无像', 'ai', 0)
  mod.db.prepare("INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)").run('rv', 'old-emoji', '旧像', 'ai', '\u{1F98A}', 1)
  mod.db.prepare("INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)").run('rv', 'token-ok', '令牌', 'ai', 'human:coder', 2)
  const agents = (await get('/api/roster?scope=rv')).body.agents
  const by = Object.fromEntries(agents.map((a) => [a.role, a.avatar]))
  assert.equal(by['no-avatar'], '', '缺失头像 → 占位语义而不是 emoji')
  assert.equal(by['old-emoji'], '', '旧 emoji → 收敛为占位语义')
  assert.equal(by['token-ok'], 'human:coder', '合法令牌原样投影')
  for (const a of agents) assert.ok(!a.external),
  assert.ok(agents.every((a) => !EMOJI_RE.test(String(a.avatar))))
})

test('TC-S3-08 跨空间首见合并后同 role 的 name/avatar 单值（AC-R5-1）', async () => {
  reset()
  for (const scope of ['software', 'marketing']) await post('/api/agents', { by: 'general', scope, role: 'writer', name: '执笔' })
  const json = (await get('/api/agents')).body
  const w = json.agents.find((a) => a.role === 'writer')
  assert.ok(w)
  assert.equal(w.name, '执笔')
  assert.equal(w.avatar, 'human:writer')
})

test('TC-S3-09 选人入编原样复制令牌（I-4）', async () => {
  reset()
  await post('/api/agents', { by: 'general', scope: 'lib', role: 'src-coder', name: '源码', avatar: 'human:coder' })
  const res = await post('/api/spaces/target/agents', { by: 'general', roles: ['src-coder'] })
  assert.ok(res.status < 400, JSON.stringify(res.body))
  assert.equal(row('target', 'src-coder').avatar, 'human:coder')
})

test('TC-S3-10 读端点零写入（AC-R9-2）', async () => {
  reset()
  await post('/api/agents', { by: 'general', scope: 'software', role: 'coder', name: '衡码', avatar: 'human:coder' })
  mod.db.prepare("UPDATE roster SET avatar = '\u{1F98A}' WHERE scope = 'software' AND role = 'coder'").run()
  const before = auditCount()
  await get('/api/roster'); await get('/api/agents')
  assert.equal(row('software', 'coder').avatar, '\u{1F98A}', '读不得写回原始值')
  assert.equal(auditCount(), before, '读端点不得写审计')
})
