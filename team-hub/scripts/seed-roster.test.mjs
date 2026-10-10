// team-hub/scripts/seed-roster.test.mjs — S2 数据面：两段式展示名 + 令牌 + 迁移保护 + 幂等。
// 运行：node team-hub/scripts/seed-roster.test.mjs（临时库由本文件自建；禁止写 live team.db）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-seed-roster-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../server.mjs')
const seed = await import('./seed-roster.mjs')

const NAME_RE = /^[\u4e00-\u9fa5]{2,6}$/
const MACHINE_RE = /[a-z0-9_-]/
const TOKEN_RE = /^human:[a-z0-9-]+$/
const SCOPES = ['software', 'marketing', 'product', 'ops', 'default']

const allRows = () => mod.db.prepare('SELECT * FROM roster ORDER BY scope, role').all()
const reset = () => { mod.db.prepare('DELETE FROM roster').run(); mod.db.prepare('DELETE FROM spaces').run() }
const apply = () => seed.applyRosterSeed(mod.db, { quiet: true })

after(() => {
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

test('TC-S2-01/02/03/04 空库播种：形态/唯一/令牌/跨空间一致（AC-R1-1/R2-1/R7-1/R5-1）', () => {
  reset(); apply()
  const all = allRows()
  assert.equal(all.length, 25, '5 空间 25 岗位')
  for (const r of all) {
    assert.match(r.name, NAME_RE, '名字形态：' + r.name)
    assert.equal(MACHINE_RE.test(r.name), false, '不得含机器键字符：' + r.name)
    assert.match(r.avatar, TOKEN_RE, '令牌形态：' + r.avatar)
    assert.ok(r.kind && r.kind.length > 0, 'kind 职能副标题不得为空：' + r.role)
  }
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM roster WHERE avatar = ?').get('\u{1F916}').c, 0)
  assert.equal(mod.db.prepare('SELECT scope, name, COUNT(*) c FROM roster GROUP BY scope, name HAVING c > 1').all().length, 0)
  assert.equal(mod.db.prepare('SELECT COUNT(DISTINCT name) c FROM roster').get().c, 25)
  const perRole = mod.db.prepare('SELECT role, COUNT(DISTINCT name) n, COUNT(DISTINCT avatar) a FROM roster GROUP BY role').all()
  assert.equal(perRole.length, 25)
  for (const r of perRole) { assert.equal(r.n, 1, r.role + ' 跨空间 name 分叉'); assert.equal(r.a, 1, r.role + ' 跨空间 avatar 分叉') }
})

test('TC-S2-05/08 幂等 + 行数与主键集合不变（AC-R7-3/R10-3）', () => {
  reset(); apply()
  const before = allRows()
  apply()
  const after = allRows()
  assert.deepEqual(after, before, '连跑两次结果集逐行相同')
  const keyOf = (rows) => rows.map(r => r.scope + '/' + r.role)
  assert.deepEqual(keyOf(after), keyOf(before))
  assert.equal(new Set(keyOf(after)).size, after.length)
})

test('TC-S2-06/07/14 迁移只替换旧默认值、保留自定义（AC-R10-1/R10-2）', () => {
  reset(); apply()
  mod.db.prepare('UPDATE roster SET name = ?, avatar = ? WHERE scope = ? AND role = ?')
    .run('我起的名字', 'human:zz9', 'software', 'coder')
  apply()
  const custom = mod.db.prepare('SELECT name, avatar FROM roster WHERE scope = ? AND role = ?').get('software', 'coder')
  assert.equal(custom.name, '我起的名字', '用户自定义名必须保留')
  assert.equal(custom.avatar, 'human:zz9', '用户自定义令牌必须保留')
  mod.db.prepare('UPDATE roster SET name = ?, avatar = ? WHERE scope = ? AND role = ?')
    .run('需求分析师', '\u{1F9ED}', 'software', 'requirement')
  apply()
  const replaced = mod.db.prepare('SELECT name, avatar FROM roster WHERE scope = ? AND role = ?').get('software', 'requirement')
  assert.notEqual(replaced.name, '需求分析师', '旧职称名必须被替换')
  assert.match(replaced.avatar, TOKEN_RE, '旧 emoji 必须被替换为新令牌')
})

test('TC-S2-09/11/12 kind 保留、role 契约键不变、身份键不变（AC-R1-3、I-7、AC-R2-3）', () => {
  reset(); apply()
  const roles = allRows().map(r => r.role)
  assert.equal(new Set(roles).size, 25)
  const expected = seed.buildRosterSeed().map(r => r.role)
  assert.deepEqual([...roles].sort(), [...new Set(expected)].sort(), 'role 集合与种子表一一对应，无删除无新增')
  const schema = mod.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'roster'").get().sql
  assert.match(schema, /PRIMARY KEY \(scope, role\)/, '主键仍是 (scope, role)')
  assert.ok(!/UNIQUE[^)]*(name|avatar)/i.test(schema), 'name/avatar 不得进唯一约束')
})

test('TC-S2-13 buildRosterSeed 纯函数 + CLI 读数（S2 DoD）', () => {
  const rows = seed.buildRosterSeed()
  assert.equal(rows.length, 25)
  assert.deepEqual([...new Set(rows.map(r => r.scope))].sort(), [...SCOPES].sort())
  for (const row of rows) assert.match(row.avatar, TOKEN_RE)
  const result = apply()
  assert.equal(result.upserted, 25)
  assert.ok(Array.isArray(result.scopes) && result.scopes.length === 5, 'CLI 读数含逐 scope 计数')
})

test('TC-S2-16 自建 role 行保留不动、缺失 space 行被补齐（AC-R10-1/R10-3 边界）', () => {
  reset(); apply()
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run('software', 'hr-analyst', '我招的人', '人事', 'human:s09', 99)
  mod.db.prepare('DELETE FROM spaces WHERE id = ?').run('ops')
  apply()
  const custom = mod.db.prepare('SELECT * FROM roster WHERE scope = ? AND role = ?').get('software', 'hr-analyst')
  assert.equal(custom.name, '我招的人', '自建 role 不得被删改')
  assert.equal(custom.avatar, 'human:s09')
  assert.ok(mod.db.prepare('SELECT * FROM spaces WHERE id = ?').get('ops'), '缺失的 space 行必须补齐')
  assert.equal(allRows().length, 26, '迁移不丢行：25 岗位 + 1 自建')
})
