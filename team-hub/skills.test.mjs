// team-hub/skills.test.mjs — 技能库「版本 + review + 幂等 + 迁移」契约测试。
// 运行：node --test team-hub/skills.test.mjs
// 通过 TEAM_HUB_DB 指向临时库，动态 import server.mjs（import 不占端口，见 isMain 守卫）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-skills-'))
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

const SKILL = { id: 'csharp-conventions', name: 'C# 编码规范', description: '命名/异常/异步约定', prompt: '用 var 省略显式类型', scope: 'software' }

describe('registerSkill — 提交进入 pending，幂等 + 版本', () => {
  it('新技能提交 → status=pending, version=1', () => {
    const s = mod.registerSkill(SKILL)
    assert.equal(s.status, 'pending')
    assert.equal(s.version, 1)
    assert.ok(s.contentHash.length === 64)
  })

  it('同内容重复提交 → 幂等，version/status 不变', () => {
    const again = mod.registerSkill(SKILL)
    assert.equal(again.version, 1)
    assert.equal(again.status, 'pending')
  })

  it('内容变化 → version+1 且回 pending（需复审）', () => {
    const changed = mod.registerSkill({ ...SKILL, prompt: '禁止隐式 var，显式声明类型' })
    assert.equal(changed.version, 2)
    assert.equal(changed.status, 'pending')
  })

  it('非法 id 拒绝', () => {
    assert.throws(() => mod.registerSkill({ ...SKILL, id: 'Bad_ID!' }), /id 非法/)
  })
})

describe('listSkills — 默认只露 published', () => {
  it('未发布时默认列表为空', () => {
    assert.deepEqual(mod.listSkills({ scope: 'software' }), [])
  })

  it('includePending 能看到待审', () => {
    const rows = mod.listSkills({ scope: 'software', includePending: true })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, SKILL.id)
  })
})

describe('reviewSkill — publish/reject 门禁', () => {
  it('publish 后默认列表可见', () => {
    mod.reviewSkill(SKILL.id, 'publish')
    const rows = mod.listSkills({ scope: 'software' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'published')
  })

  it('已发布后再审 → 拒绝（只有 pending 可审）', () => {
    assert.throws(() => mod.reviewSkill(SKILL.id, 'publish'), /只有 pending 可审/)
  })

  it('reject 后从默认列表消失', () => {
    mod.registerSkill({ ...SKILL, prompt: '第二版：改回 var' }) // version 3, pending
    mod.reviewSkill(SKILL.id, 'reject')
    assert.deepEqual(mod.listSkills({ scope: 'software' }), [])
    assert.equal(mod.getSkill(SKILL.id).status, 'rejected')
  })

  it('非法 action 拒绝', () => {
    assert.throws(() => mod.reviewSkill(SKILL.id, 'nuke'), /action 必须是 publish 或 reject/)
  })
})

describe('grantSkill — 授权过滤不受 review 影响', () => {
  it('grant 到角色 + scope 通配后按 scope/member 过滤', () => {
    mod.registerSkill({ ...SKILL, prompt: '终版' })
    mod.reviewSkill(SKILL.id, 'publish')
    mod.grantSkill(SKILL.id, ['coder', 'scope:software'])
    assert.equal(mod.listSkills({ scope: 'software' }).length, 1)
    assert.equal(mod.listSkills({ member: 'coder' }).length, 1)
    assert.equal(mod.listSkills({ scope: 'other' }).length, 0)
    assert.equal(mod.listSkills({ member: 'stranger' }).length, 0)
  })
})

describe('旧库迁移 — 缺列补齐且存量行默认 pending', () => {
  it('旧 schema 的 skills 表加载后带 status/contentHash/reviewedAt', async () => {
    const oldFile = join(tmpRoot, 'old-team.db')
    const old = new DatabaseSync(oldFile)
    old.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        prompt TEXT DEFAULT '', scope TEXT DEFAULT 'default', owner TEXT,
        grants TEXT DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT, updatedAt TEXT
      )
    `)
    old.prepare('INSERT INTO skills (id,name,description,prompt,scope,owner,grants,version,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('legacy', 'Legacy', '', '', 'default', null, '[]', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    old.close()

    process.env.TEAM_HUB_DB = oldFile
    const m2 = await import(`./server.mjs?migration=${Date.now()}`)
    const cols = m2.db.prepare('PRAGMA table_info(skills)').all().map(c => c.name)
    for (const c of ['status', 'contentHash', 'reviewedAt']) assert.ok(cols.includes(c), `缺列 ${c}`)
    const row = m2.getSkill('legacy')
    assert.equal(row.status, 'pending')
    assert.equal(row.version, 3) // 存量 version 保留
    m2.db.close()
  })
})
