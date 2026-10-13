// team-hub/scripts/migrate-avatars.test.mjs — 头像迁移：令牌化、幂等、备用池、覆盖自建 role。
// 运行：node team-hub/scripts/migrate-avatars.test.mjs（临时库由本文件自建；禁止写 live team.db）
//
// 这份用例守的是**这次真实事故**：功能上线了、界面接好了，而库里 24 行全是旧 emoji
// ⇒ 全部渲染成同一个灰阶占位人形 ⇒ 用户看到的结论是"这个功能没做"。
// 所以重点不是"迁移能不能跑"，而是：
//   · 迁完之后**每一行都能解析成位面**（否则等于没迁）；
//   · 自建/空间专属 role 也能拿到位面（种子名单覆盖不到它们）；
//   · 同空间内多个自建 role **不会各自拿到同一个备用位面**；
//   · 幂等、且用户自定义过的合法令牌不被改写。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-migrate-avatars-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../server.mjs')
const mig = await import('./migrate-avatars.mjs')
const { isAvatarToken } = await import('../agent-avatars.mjs')

const TOKEN_RE = /^human:[a-z0-9][a-z0-9-]*$/
/** 40 个真实位面 key —— "能解析"必须对着这张表判，而不是只看令牌格式。 */
const BUILTIN = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]
const SPARES = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))
const RESOLVABLE = new Set([...BUILTIN, ...SPARES])

const insert = (scope, role, avatar, name = role) =>
  mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,0)')
    .run(scope, role, name, 'agent', avatar)
const allRows = () => mod.db.prepare('SELECT scope, role, name, avatar FROM roster ORDER BY scope, role').all()
const reset = () => mod.db.prepare('DELETE FROM roster').run()
/** 行 → 该头像令牌能否查到真实位面（这是渲染器的唯一判据）。 */
const resolvable = (row) => isAvatarToken(row.avatar) && RESOLVABLE.has(String(row.avatar).slice('human:'.length))

after(() => {
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

test('① ★ 全部旧 emoji 迁完之后，每一行都真的能解析成位面（不是只符合格式）', () => {
  reset()
  // 照抄 live 库那 24 行的真实形态：内置岗位走 emoji，自建 role 也走 emoji
  insert('software', 'requirement', '\u{1F9ED}')
  insert('software', 'coder', '\u{1F4BB}')
  insert('software', 'devops', '\u{1F680}')
  insert('default', 'assistant', '\u{1F916}')
  insert('default', 'writer', '\u2709\uFE0F')
  insert('gf001', 'implementer', '\u{1F4BB}')
  insert('gf001', 'planner', '\u{1F4CB}')
  insert('ozon', 'soldier-listing', '\u{1F3F7}\uFE0F')
  insert('ozon', 'soldier-profit', '\u{1F9EE}')

  const before = allRows()
  assert.equal(before.filter(resolvable).length, 0, '前提：迁之前一行都解析不了（这正是事故形态）')

  const out = mig.runMigration(mod.db, { quiet: true })
  assert.equal(out.changed, 9)
  assert.equal(out.scanned, 9)

  const after = allRows()
  for (const row of after) {
    assert.ok(resolvable(row), `${row.scope}/${row.role} 迁完仍解析不了：${JSON.stringify(row.avatar)}`)
  }
  // 内置岗位 → 跨空间恒同的 human:<role>
  assert.equal(after.find(r => r.scope === 'software' && r.role === 'coder').avatar, 'human:coder')
  assert.equal(after.find(r => r.scope === 'gf001' && r.role === 'implementer').avatar, 'human:s01')
  assert.equal(after.find(r => r.scope === 'gf001' && r.role === 'planner').avatar, 'human:s02')
  assert.equal(after.find(r => r.scope === 'ozon' && r.role === 'soldier-listing').avatar, 'human:s01',
    '备用池按**空间**分配：ozon 自己的 s01 与 gf001 的 s01 互不影响')
  assert.equal(after.find(r => r.scope === 'ozon' && r.role === 'soldier-profit').avatar, 'human:s02')
})

test('② ★ 同一空间内多个自建 role 不会各自拿到同一个备用位面', () => {
  reset()
  const roles = ['a-role', 'b-role', 'c-role', 'd-role', 'e-role']
  for (const r of roles) insert('sp', r, '\u{1F600}')
  mig.runMigration(mod.db, { quiet: true })
  const tokens = allRows().filter(r => r.scope === 'sp').map(r => r.avatar)
  assert.equal(new Set(tokens).size, roles.length,
    '五个自建 role 必须拿到五个不同位面，实际：' + JSON.stringify(tokens))
  for (const t of tokens) assert.ok(resolvable({ avatar: t }), '必须是能解析的位面：' + t)
})

test('③ 幂等：连跑两次结果逐行相同，且第二次零改动', () => {
  reset()
  insert('software', 'coder', '\u{1F4BB}')
  insert('ozon', 'soldier-x', '\u{1F600}')
  const first = mig.runMigration(mod.db, { quiet: true })
  const snapshot = JSON.stringify(allRows())
  const second = mig.runMigration(mod.db, { quiet: true })
  assert.equal(first.changed, 2)
  assert.equal(second.changed, 0, '第二次不该再改任何行')
  assert.equal(JSON.stringify(allRows()), snapshot, '两次结果必须逐行相同')
})

test('④ 用户自定义过的合法令牌原样保留（不覆盖别人的选择）', () => {
  reset()
  insert('software', 'coder', 'human:s07', '我自己起的名字')
  insert('software', 'tester', '\u{1F600}')
  mig.runMigration(mod.db, { quiet: true })
  const rows = allRows()
  assert.equal(rows.find(r => r.role === 'coder').avatar, 'human:s07', '已是合法令牌 ⇒ 不动')
  assert.equal(rows.find(r => r.role === 'coder').name, '我自己起的名字', '迁移不碰 name')
  assert.equal(rows.find(r => r.role === 'tester').avatar, 'human:tester')
})

test('⑤ --scope 只动指定空间；--dry 一个字节都不写', () => {
  reset()
  insert('software', 'coder', '\u{1F4BB}')
  insert('ozon', 'soldier-x', '\u{1F600}')

  const dry = mig.runMigration(mod.db, { dry: true, quiet: true })
  assert.equal(dry.dry, true)
  assert.equal(dry.changed, 2, '预演要报出会改 2 行')
  assert.equal(allRows().filter(r => r.avatar === '\u{1F4BB}').length, 1, '★ 预演不许写库')

  const scoped = mig.runMigration(mod.db, { scope: 'ozon', quiet: true })
  assert.equal(scoped.changed, 1)
  assert.equal(allRows().find(r => r.scope === 'software').avatar, '\u{1F4BB}', '限定 scope 时别的空间不许被动')
  assert.equal(allRows().find(r => r.scope === 'ozon').avatar, 'human:s01')
})

test('⑥ parseArgs 认 --dry / --names / --scope=（缺值与空值都退化为"全库"）', () => {
  assert.deepEqual(mig.parseArgs([]), { dry: false, names: false, scope: null })
  assert.deepEqual(mig.parseArgs(['--dry']), { dry: true, names: false, scope: null })
  assert.deepEqual(mig.parseArgs(['--scope=ozon']), { dry: false, names: false, scope: 'ozon' })
  assert.deepEqual(mig.parseArgs(['--scope=']), { dry: false, names: false, scope: null })
  assert.deepEqual(mig.parseArgs(['--dry', '--scope=software']), { dry: true, names: false, scope: 'software' })
  assert.deepEqual(mig.parseArgs(['--names']), { dry: false, names: true, scope: null })
})

test('⑦ ★ --names 只改旧职称名、只动已有行（不新建空间、不新建 Agent）', () => {
  reset()
  mod.db.prepare("INSERT INTO spaces (id, name, createdAt, updatedAt) VALUES ('software','软件流水线','x','x')").run()
  insert('software', 'coder', '\u{1F4BB}', '编码工程师')      // 旧职称名 ⇒ 应改成「衡码」
  insert('software', 'tester', '\u{1F600}', '我起的名字')      // 用户自定义 ⇒ 不动
  insert('ozon', 'soldier-x', '\u{1F600}', '编外侦探')         // 种子表没有 ozon ⇒ 不动
  const spacesBefore = mod.db.prepare('SELECT COUNT(*) c FROM spaces').get().c
  const rowsBefore = allRows().length

  const out = mig.runMigration(mod.db, { names: true, quiet: true })
  assert.deepEqual(out.nameChanges, [{ scope: 'software', role: 'coder', from: '编码工程师', to: '衡码' }])

  const rows = allRows()
  assert.equal(rows.find(r => r.role === 'coder').name, '衡码', '旧职称名要被换掉')
  assert.equal(rows.find(r => r.role === 'tester').name, '我起的名字', '用户自定义的名字不许动')
  assert.equal(rows.find(r => r.scope === 'ozon').name, '编外侦探', '种子表没覆盖的空间不许动')
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM spaces').get().c, spacesBefore, '★ 不许新建空间')
  assert.equal(allRows().length, rowsBefore, '★ 不许新建 Agent 行')
})
