// team-hub/scripts/grant-orphan-spaces.test.mjs
// BUG-048 的另一半：**存量**孤儿空间（一条角色行都没有）的补授权脚本。
//
// 这一组守的是"脚本会把什么写进生产库"，所以每一条都在**真的 SQLite 库**上跑，
// 而不是对着 mock 断言调用顺序。四条最要紧的性质：
//   ① 默认**不写**（只读盘点）—— 一个"跑一下看看"就改了权限的脚本，不会有人敢跑；
//   ② 没指名用户时**拒绝**写 —— "谁该拿到 owner"只能由人指定，猜是错的；
//   ③ 真写 = 角色行 + 审计行同一个事务，审计形状与自动授予那条路径**逐字同源**；
//   ④ 幂等：跑完一次，那些空间就不再是孤儿，第二次一行都不写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  applyOrphanGrants, formatPlan, parseArgs, planOrphanGrants,
} from './grant-orphan-spaces.mjs'

// ── 夹具：与生产同形的四张表（DDL 抄自 `team-hub/team.db` 的 sqlite_master）────────
const SCHEMA = [
  `CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT, updatedAt TEXT,
     private INTEGER DEFAULT 0, local_dir TEXT, remote_url TEXT, scene_preset TEXT)`,
  `CREATE TABLE hub_users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, disabled_at_ms INTEGER,
     system_role TEXT NOT NULL DEFAULT 'none', display_name TEXT)`,
  `CREATE TABLE hub_space_roles (user_id TEXT NOT NULL, space TEXT NOT NULL, role TEXT NOT NULL,
     granted_by TEXT NOT NULL, granted_at_ms INTEGER NOT NULL, PRIMARY KEY(user_id, space))`,
  `CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, member TEXT, scope TEXT,
     action TEXT, taskId TEXT, detail TEXT, goalId TEXT, actor_kind TEXT, addressed TEXT,
     human INTEGER, event_id TEXT)`,
]

const withDb = (mutate) => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-orphan-'))
  const db = new DatabaseSync(join(dir, 'team.db'))
  try {
    for (const sql of SCHEMA) db.exec(sql)
    return mutate(db)
  } finally {
    try { db.close() } catch { /* 已关 */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

const addUser = (db, { id, name, systemRole = 'none', disabled = false }) => {
  db.prepare('INSERT INTO hub_users (id,name,name_key,password_hash,created_at_ms,disabled_at_ms,system_role) VALUES(?,?,?,?,?,?,?)')
    .run(id, name, name.trim().toLowerCase(), 'x', 1, disabled ? 1 : null, systemRole)
}
const addSpace = (db, id, name = id) => {
  db.prepare('INSERT INTO spaces (id,name,private,local_dir) VALUES(?,?,0,\'\')').run(id, name)
}
// `node:sqlite` 的行是 **null 原型**对象，`deepEqual`（strict）会连原型一起比 ——
// 所以这里摊平成普通对象再断言。不是洁癖：不摊平的话，一条**对**的读数会以
// "prototype 不同"的名义红掉，而下一个人会去改断言而不是查它到底对不对。
const rows = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }))
const roles = (db) => rows(db, 'SELECT user_id, space, role, granted_by FROM hub_space_roles ORDER BY space')
const grantAudits = (db) => rows(db, "SELECT member, scope, detail FROM audit WHERE action='identity:grant-role' ORDER BY seq")

// ══════════════════════ ① 命令行：默认只读 ══════════════════════

test('① ★★ 默认**不写**：只有 --apply 才改库（`--user` 不给也行，那是纯盘点）', () => {
  assert.equal(parseArgs([]).apply, false)
  assert.equal(parseArgs([]).user, null)
  assert.equal(parseArgs(['--user', 'general']).user, 'general', '★ 空格写法的那个值不许被当成位置参数丢掉')
  assert.equal(parseArgs(['--user=general']).user, 'general')
  assert.equal(parseArgs(['--user', 'general']).apply, false, '★★ 点名用户 ≠ 同意写库')
  assert.equal(parseArgs(['--user', 'general', '--apply']).apply, true)
  assert.equal(parseArgs(['--db=D:/x/team.db']).dbPath, 'D:/x/team.db')
  assert.equal(parseArgs(['--help']).help, true)
})

// ══════════════════════ ② 盘点：只认"一条角色行都没有" ══════════════════════

test('② ★★★ 只有**一条角色行都没有**的空间算孤儿；已经有任何角色的空间一律不动', () => withDb((db) => {
  addUser(db, { id: 'u1', name: 'general', systemRole: 'admin' })
  addSpace(db, 'personal-profile', '个人履历')
  addSpace(db, 'nantai', 'nantai')
  addSpace(db, 'software', '软件流水线')
  // software 里有人是 viewer —— 它不是孤儿（哪怕只是 viewer）
  db.prepare("INSERT INTO hub_space_roles VALUES('u9','software','viewer','u9',1)").run()

  const r = planOrphanGrants(db)
  assert.deepEqual(r.orphans.map((s) => s.id), ['nantai', 'personal-profile'])
  assert.equal(r.user, null)
  assert.deepEqual(r.plan, [], '★ 没指名用户时不给计划 —— 不给"顺手授给谁"的机会')
  assert.equal(r.error, null)
}))

test('③ ★★ 用户名按 name_key 归一查（Trim + 大小写），查不到/停用都**拒绝并说清**', () => withDb((db) => {
  addUser(db, { id: 'u1', name: 'General', systemRole: 'admin' })
  addUser(db, { id: 'u2', name: 'gone', disabled: true })
  addSpace(db, 'orphan')

  const hit = planOrphanGrants(db, { userName: '  general ' })
  assert.equal(hit.error, null)
  assert.equal(hit.user.id, 'u1')
  assert.deepEqual(hit.plan, [{ space: 'orphan', userId: 'u1', role: 'owner' }])

  const missing = planOrphanGrants(db, { userName: 'nobody' })
  assert.match(String(missing.error), /找不到用户/)
  assert.deepEqual(missing.plan, [])

  const disabled = planOrphanGrants(db, { userName: 'gone' })
  assert.match(String(disabled.error), /已停用/)
  assert.deepEqual(disabled.plan, [])
}))

// ══════════════════════ ④ 真写：角色 + 审计同事务 ══════════════════════

test('④ ★★★ 真写：授 owner 并留审计（形状与自动授予那条路径同源），且**幂等**', () => withDb((db) => {
  addUser(db, { id: 'u1', name: 'general', systemRole: 'admin' })
  addSpace(db, 'personal-profile', '个人履历')

  const planned = planOrphanGrants(db, { userName: 'general' })
  const done = applyOrphanGrants(db, planned.plan, { now: () => '2026-11-20T02:30:00.000Z' })
  assert.equal(done.granted, 1)
  assert.deepEqual(done.spaces, ['personal-profile'])

  assert.deepEqual(roles(db), [{ user_id: 'u1', space: 'personal-profile', role: 'owner', granted_by: 'system' }],
    '★★ granted_by 必须是 system：这次授予的依据是"人明确指定"，不是某个空间里的权限')
  const audits = grantAudits(db)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].member, 'system')
  assert.equal(audits[0].scope, 'personal-profile')
  const detail = JSON.parse(audits[0].detail)
  assert.equal(detail.userId, 'u1', '★★ 审计里要指名被授权的人 —— 否则以后没人说得清这次授权从哪来')
  assert.equal(detail.role, 'owner')
  assert.equal(detail.via, 'grant-orphan-spaces', '★ 补授权与自动授予要能分辨')

  // 幂等：同一个库再来一次，孤儿已经没有了。
  const again = planOrphanGrants(db, { userName: 'general' })
  assert.deepEqual(again.orphans, [])
  assert.equal(applyOrphanGrants(db, again.plan).granted, 0)
  assert.equal(roles(db).length, 1, '★★ 重复跑不许写出第二行')
  assert.equal(grantAudits(db).length, 1)
}))

// ══════════════════════ ⑤ 措辞：默认路径必须说"未写入" ══════════════════════

test('⑤ ★★ 只读路径的措辞里必须出现"未写入"，并给出下一步命令', () => withDb((db) => {
  addUser(db, { id: 'u1', name: 'general' })
  addSpace(db, 'orphan')

  const dry = formatPlan(planOrphanGrants(db, { userName: 'general' }), { apply: false, dbPath: 'team.db' })
  const text = dry.join('\n')
  assert.match(text, /未写入/)
  assert.match(text, /--apply/)
  assert.deepEqual(roles(db), [], '★ 打印不写库')

  // 连用户都没给时：说清"这只是盘点"，并且给出两条命令。
  const bare = formatPlan(planOrphanGrants(db), { apply: false, dbPath: 'team.db' }).join('\n')
  assert.match(bare, /只读/)
  assert.match(bare, /--user/)

  // 没有孤儿时不要输出一份"空计划"让人以为还要操作。
  db.prepare("INSERT INTO hub_space_roles VALUES('u1','orphan','owner','system',1)").run()
  assert.match(formatPlan(planOrphanGrants(db), {}).join('\n'), /不需要补授权/)
}))
