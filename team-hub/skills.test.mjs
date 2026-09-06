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

// ─────────────────────────────────────────────────────────────
// S1（R-1）跨空间共享语义：scope:B 可见 + revoke + general 门禁 + 草稿收口 + 审计 + 级联
// 对齐 docs/TEST_CASES.md TC-S1-01..13（追加 describe；HTTP 层用例仿 calendar.test.mjs listen(0) 范式）
// ─────────────────────────────────────────────────────────────
const S_A = 'space-a'
const S_B = 'space-b'
const S_C = 'space-c'

function freshSkill(id, scope, extra = {}) {
  return { id, name: '共享技能-' + id, description: 'desc', prompt: 'prompt-' + id + ' 完整指引文本', scope, ...extra }
}

function publish(mod2, id) {
  mod2.reviewSkill(id, 'publish')
  return mod2.getSkill(id)
}

function skillAuditRows(actionPrefix) {
  return mod.db.prepare('SELECT seq, member, scope, action, detail FROM audit ORDER BY seq ASC').all()
    .filter(r => actionPrefix === undefined || r.action.startsWith(actionPrefix))
    .map(r => ({ ...r, detail: JSON.parse(r.detail) }))
}

describe('S1 TC-S1-01/02/10 跨空间共享可见性（listSkills scope:B 服务端判定）', () => {
  it('grant scope:B 后 scope=B 列表含 S（member 省略与单值两形态等价）；scope=C 不含；未授权互不污染', () => {
    const s = publish(mod, (mod.registerSkill(freshSkill('doc-review', S_A)).id))
    mod.grantSkill(s.id, ['scope:' + S_B])
    const byScope = mod.listSkills({ scope: S_B })
    const hit = byScope.find(x => x.id === s.id)
    assert.ok(hit, 'scope=B 列表含共享技能')
    assert.equal(hit.prompt, s.prompt, 'prompt 全文可见')
    assert.equal(hit.scope, S_A, '来源标注仍为归属空间 A')
    assert.ok(mod.listSkills({ scope: S_B, member: 'coder' }).some(x => x.id === s.id), 'member 单值形态同可见')
    assert.ok(!mod.listSkills({ scope: S_C }).some(x => x.id === s.id), 'scope=C 不含 S')
    // 反向控制：B 自有技能不出现在 A；A 自身列表不受授权影响
    const bOwn = publish(mod, mod.registerSkill(freshSkill('b-own', S_B)).id)
    assert.ok(!mod.listSkills({ scope: S_A }).some(x => x.id === bOwn.id), '未授权 A 不含 B 自有技能')
    assert.ok(mod.listSkills({ scope: S_A }).some(x => x.id === s.id), 'A 自身列表仍含 S')
  })
})

describe('S1 TC-S1-03/04 撤销：立即不可见 + 幂等', () => {
  it('revoke 后 scope=B 立即空、grants 不再含 scope:B；重复 revoke/撤销未授权目标幂等不抛错；技能仍 published', () => {
    const s = mod.getSkill('doc-review')
    mod.revokeSkill(s.id, ['scope:' + S_B])
    assert.ok(!mod.listSkills({ scope: S_B }).some(x => x.id === s.id), '撤销后 B 立即不可见')
    assert.ok(!mod.listSkills({ scope: S_B, member: 'coder' }).some(x => x.id === s.id), 'member 形态同不可见')
    assert.ok(!mod.getSkill(s.id).grants.includes('scope:' + S_B), 'grants 不再含 scope:B')
    assert.equal(mod.getSkill(s.id).status, 'published', '技能本身仍 published')
    assert.ok(mod.listSkills({ scope: S_A }).some(x => x.id === s.id), 'A 本空间仍可见')
    // 幂等：重复 revoke / 撤销未授权目标 / 重复 grant（并集无重复项）
    assert.doesNotThrow(() => mod.revokeSkill(s.id, ['scope:' + S_B]))
    assert.doesNotThrow(() => mod.revokeSkill(s.id, ['scope:' + S_C]))
    mod.grantSkill(s.id, ['scope:' + S_B, 'scope:' + S_B])
    assert.deepEqual(mod.getSkill(s.id).grants.filter(g => g === 'scope:' + S_B), ['scope:' + S_B], '重复 grant 为并集无重复项')
  })
})

describe('S1 TC-S1-07/08 草稿安全：pending/rejected 对非复审查询零泄漏', () => {
  it('默认列表（含全部空间视图）不含 pending/rejected 及其 prompt；includePending 仅 general 复审视角', () => {
    mod.registerSkill(freshSkill('draft-x', S_A, { prompt: '敏感草稿文本-pending' }))
    mod.registerSkill(freshSkill('draft-r', S_A, { prompt: '敏感草稿文本-rejected' }))
    mod.reviewSkill('draft-r', 'reject')
    const allView = mod.listSkills({})
    assert.ok(!allView.some(x => x.id === 'draft-x' || x.id === 'draft-r'), '全部空间视图不泄 pending/rejected')
    assert.ok(!allView.some(x => (x.prompt ?? '').includes('敏感草稿')), 'prompt 不泄')
    assert.ok(!mod.listSkills({ scope: S_B }).some(x => x.id === 'draft-x'), 'scope=B 不泄 A 的 pending')
    assert.ok(!mod.listSkills({ scope: S_A }).some(x => x.id === 'draft-x'), 'scope=A 默认列表不含本空间 pending')
    const pending = mod.listSkills({ scope: S_A, includePending: true })
    assert.ok(pending.some(x => x.id === 'draft-x') && pending.some(x => x.id === 'draft-r'), 'includePending=true 可见 pending+rejected')
    assert.ok(pending.every(x => x.scope === S_A), '复审视图按 scope 过滤')
  })
})

describe('S1 HTTP 路由：general 门禁 + revoke 端点 + include=pending 收口 + 审计形状（listen(0)）', () => {
  let base = ''
  let server
  before(async () => {
    server = mod.server
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = 'http://127.0.0.1:' + server.address().port
    // 注册测试空间行（删除级联用例需要 spaces 表存在该 id）
    for (const sid of [S_A, S_B, S_C]) {
      await fetch(base + '/api/spaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sid, name: sid, by: 'general' }) })
    }
  })
  after(() => {
    try { server.closeAllConnections?.() } catch { /* 无连接 */ }
    try { server.close() } catch { /* 已关闭 */ }
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

  it('TC-S1-05 非 general 调 review/grant/revoke → 4xx + 文案含 general；general 成功；register 无门禁', async () => {
    const pub = mod.registerSkill(freshSkill('gate-skill', S_A))
    mod.reviewSkill(pub.id, 'publish')
    for (const [path, body] of [
      ['/api/skills/review', { id: pub.id, action: 'publish', by: 'coder' }],
      ['/api/skills/grant', { id: pub.id, grants: ['scope:' + S_B], by: 'coder' }],
      ['/api/skills/revoke', { id: pub.id, targets: ['scope:' + S_B], by: 'coder' }],
    ]) {
      const r = await post(path, body)
      assert.equal(r.status, 400, path + ' 非 general 4xx：' + r.text)
      assert.ok(r.json && /general/.test(r.json.error), '错误文案含 general：' + (r.json?.error ?? ''))
    }
    // register 无门禁：非 general 可提交 pending
    const reg = await post('/api/skills/register', { id: 'by-coder', name: 'coder 提交', scope: S_A, by: 'coder' })
    assert.equal(reg.status, 200, 'register 不门禁')
    // general 三动作成功
    const rv = await post('/api/skills/review', { id: 'by-coder', action: 'publish', by: 'general' })
    assert.equal(rv.status, 200)
    const gr = await post('/api/skills/grant', { id: 'by-coder', grants: ['scope:' + S_B], by: 'general' })
    assert.equal(gr.status, 200)
    const rk = await post('/api/skills/revoke', { id: 'by-coder', targets: ['scope:' + S_B], by: 'general' })
    assert.equal(rk.status, 200)
  })

  it('TC-S1-06 审计：action=skill:grant/revoke 且 detail 含 skillScope 与目标空间；scope=技能归属空间', async () => {
    const before = skillAuditRows('skill:').length
    const s = mod.getSkill('by-coder')
    await post('/api/skills/grant', { id: s.id, grants: ['scope:' + S_B], by: 'general' })
    await post('/api/skills/revoke', { id: s.id, targets: ['scope:' + S_B], by: 'general' })
    const rows = skillAuditRows('skill:').slice(before)
    const grantRow = rows.find(r => r.action === 'skill:grant')
    const revokeRow = rows.find(r => r.action === 'skill:revoke')
    assert.ok(grantRow && revokeRow, '出现 skill:grant + skill:revoke 审计行')
    for (const row of [grantRow, revokeRow]) {
      assert.equal(row.detail.skillScope, s.scope, 'detail 含技能归属 scope')
      assert.equal(row.scope, s.scope, 'audit.scope = 技能归属空间（跨空间不归错）')
    }
    assert.deepEqual(grantRow.detail.grants, ['scope:' + S_B], 'grant detail 含目标空间')
    assert.deepEqual(revokeRow.detail.targets, ['scope:' + S_B], 'revoke detail 含目标空间')
  })

  it('TC-S1-07 HTTP include=pending 收口：member=general 才可见 pending；非复审不带出草稿', async () => {
    mod.registerSkill(freshSkill('http-draft', S_B, { prompt: '草稿不泄-http' }))
    const r1 = await get('/api/skills?scope=' + S_B + '&include=pending')
    assert.equal(r1.status, 200)
    assert.ok(!r1.json.some(x => x.id === 'http-draft'), '非复审 include=pending 被收口（不泄 pending）')
    const r2 = await get('/api/skills?scope=' + S_B + '&include=pending&member=general')
    assert.ok(r2.json.some(x => x.id === 'http-draft'), 'member=general 复审视角可见 pending')
    const r3 = await get('/api/skills?id=http-draft')
    assert.equal(r3.status, 404, '普通单查对 pending 返回 404 不泄内容')
    assert.ok(!/草稿不泄/.test(r3.text), '404 响应体不含 prompt')
  })

  it('TC-S1-11 非法输入矩阵 → 4xx + 可读文案，零副作用、无 500', async () => {
    const cases = [
      { path: '/api/skills/grant', body: { by: 'general' }, re: /id|grants/ },
      { path: '/api/skills/grant', body: { id: 'doc-review', by: 'general' }, re: /grants/ },
      { path: '/api/skills/grant', body: { id: 'doc-review', grants: [], by: 'general' }, re: /grants/ },
      { path: '/api/skills/revoke', body: { id: 'doc-review', targets: [], by: 'general' }, re: /targets/ },
      { path: '/api/skills/grant', body: { id: 'BAD_ID', grants: ['scope:' + S_B], by: 'general' }, re: /未知技能|id/ },
      { path: '/api/skills/revoke', body: { id: 'unknown-skill', targets: ['scope:' + S_B], by: 'general' }, re: /未知技能/ },
    ]
    for (const c of cases) {
      const r = await post(c.path, c.body)
      assert.ok(r.status >= 400 && r.status < 500, c.path + ' 4xx：' + r.text)
      assert.ok(r.json && r.json.error && c.re.test(r.json.error), '错误可读且指明字段：' + (r.json?.error ?? r.text))
    }
    const alive = await get('/api/config')
    assert.equal(alive.status, 200, '进程存活：后续请求 200')
  })

  it('TC-S1-09 删除源空间 → 其他空间共享视图同步移除、无悬空引用（级联）', async () => {
    const s = publish(mod, mod.registerSkill(freshSkill('cascade-skill', S_A)).id)
    mod.grantSkill(s.id, ['scope:' + S_B])
    assert.ok(mod.listSkills({ scope: S_B }).some(x => x.id === s.id), '级联前置：B 可见')
    const del = await post('/api/spaces/delete', { id: S_A, confirm: 'delete-space:' + S_A, by: 'general' })
    assert.equal(del.status, 200, '删除源空间成功')
    assert.ok(!mod.listSkills({ scope: S_B }).some(x => x.id === s.id), 'B 查询不再含 A 技能')
    const remains = mod.db.prepare('SELECT COUNT(*) AS c FROM skills WHERE scope = ?').get(S_A).c
    assert.equal(remains, 0, 'skills 表无 scope=A 残留')
  })
})
