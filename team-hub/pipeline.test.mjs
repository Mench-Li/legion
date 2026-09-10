// team-hub/pipeline.test.mjs — SP-P0「编队即流水线」契约测试。
//
// 覆盖目标（对治 T-127 现场：目标发布成功、链也建对，却因「空间无守护实例 / 编队与流水线不一致」
// 静默停在 todo 十几小时，而指挥台毫无提示）：
//   - GET /api/pipeline：空态、回读、version 内容指纹（未变则不变）；
//   - POST /api/pipeline：写入期校验矩阵（role/label/next/gate/docs/runtime/general 门禁）+ 整批覆盖 + audit；
//   - 建链：入链 = 编队 ∩ 流水线启用岗位（非执行岗不再入链 → 机制性消除 blockedBy 链死锁）+ 阶段名取自流水线 label；
//   - 建链护栏：编队与流水线零交集 → 4xx 且零残留（目标记录也随之回滚）；
//   - GET /api/spaces/provision：开通预检清单（流水线/编队一致性/守护在线/工作区绑定/队列停滞）；
//   - 级联：空间删除清理 space_stages / space_runtime（spaces.test.mjs 另有一份零残留断言）。
// 运行：node --test team-hub/pipeline.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-pipeline-'))
let mod
let base = ''

const S = 'space-oz'          // 契约主空间（模拟业务空间）
const R = 'space-ro'          // provision 预检专用空间
const T = '2026-09-10T00:00:00.000Z'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
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

async function httpJson(method, path, { body } = {}) {
  const init = { method, headers: {} }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
  const res = await fetch(base + path, init)
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const post = (path, body) => httpJson('POST', path, { body })
const get = (path) => httpJson('GET', path)

/** 三环流水线样本：role 与编队逐字一致；末环 next=null。 */
function stagesFixture() {
  return [
    { role: 'soldier-research', label: '需求调研', prompt: '调研……', next: 'soldier-selection', docs: ['research/ozon/rerun-brief.md'] },
    { role: 'soldier-selection', label: '选品与类目', prompt: '选品……', next: 'soldier-listing' },
    { role: 'soldier-listing', label: '上架准备', prompt: '上架……', next: null, docs: ['research/ozon/listing/listing-draft-sharpener.md'] },
  ]
}

function seedRoster(scope, withObserver = false) {
  const ins = mod.db.prepare('INSERT OR IGNORE INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(scope, 'soldier-research', '调研参谋', 'agent', '🔎', 0)
  ins.run(scope, 'soldier-selection', '选品参谋', 'agent', '🎯', 1)
  ins.run(scope, 'soldier-listing', '上架参谋', 'agent', '📦', 2)
  if (withObserver) ins.run(scope, 'observer', '观察员（不参与流水线）', 'human', '👀', 3)
}

function chainOf(goalId) {
  return mod.db.prepare("SELECT id, status, role, title, blockedBy, soldier FROM tasks WHERE goalId = ? AND status != 'canceled' ORDER BY id").all(goalId)
}

describe('TC-SP-P0-01/02 读写：空态 → 写入 → 回读 → version 指纹', () => {
  it('未配置空间返回空流水线（runtime 默认未开通），version 稳定可复现', async () => {
    const a = await get('/api/pipeline?scope=' + S)
    assert.equal(a.status, 200, a.text)
    assert.deepEqual(a.json.stages, [])
    assert.deepEqual(a.json.activeRoles, [])
    assert.equal(a.json.runtime.enabled, false)
    assert.equal(a.json.runtime.maxWorkers, 1)
    const b = await get('/api/pipeline?scope=' + S)
    assert.equal(a.json.version, b.json.version, '空态 version 亦稳定（守护可据此跳过重建）')
  })

  it('POST 写入 → GET 回读逐字段一致、version 变化、audit pipeline:update、warnings 报出未入链成员', async () => {
    await post('/api/spaces', { id: S, name: 'ozon 业务空间', by: 'general' })
    seedRoster(S, true) // 编队 4 人，其中 observer 不参与流水线
    const before = (await get('/api/pipeline?scope=' + S)).json.version
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: stagesFixture(),
      runtime: { enabled: true, maxWorkers: 2, isolate: true },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 3)
    assert.equal(r.json.task.added, 3)
    assert.deepEqual(r.json.task.activeRoles, ['soldier-research', 'soldier-selection', 'soldier-listing'])
    const warn = r.json.task.warnings.find(w => w.code === 'roster-not-in-pipeline')
    assert.ok(warn, '应报出 observer 不参与流水线')
    assert.deepEqual(warn.roles, ['observer'])

    const view = (await get('/api/pipeline?scope=' + S)).json
    assert.notEqual(view.version, before, '内容变化 → version 变化')
    assert.equal(view.stages.length, 3)
    assert.deepEqual(view.stages.map(s => s.role), ['soldier-research', 'soldier-selection', 'soldier-listing'], '按 sort 稳定排序')
    const first = view.stages[0]
    assert.equal(first.label, '需求调研')
    assert.equal(first.next, 'soldier-selection')
    assert.equal(first.gate, false)
    assert.deepEqual(first.docs, ['research/ozon/rerun-brief.md'])
    assert.equal(view.runtime.enabled, true)
    assert.equal(view.runtime.maxWorkers, 2)

    const auditRow = mod.db.prepare("SELECT * FROM audit WHERE action = 'pipeline:update' AND scope = ?").get(S)
    assert.ok(auditRow, '审计保留 pipeline:update')
    assert.equal(JSON.parse(auditRow.detail).stages, 3)

    const again = await get('/api/pipeline?scope=' + S)
    assert.equal(again.json.version, view.version, '重复读 version 不变（守护零成本判无变化）')
  })

  it('include=active 只回启用阶段；enabled=false 的岗位保留但不进 activeRoles', async () => {
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: stagesFixture().map(s => s.role === 'soldier-selection' ? { ...s, enabled: false } : s),
    })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.task.activeRoles, ['soldier-research', 'soldier-listing'])
    const active = (await get('/api/pipeline?scope=' + S + '&include=active')).json
    assert.deepEqual(active.stages.map(s => s.role), ['soldier-research', 'soldier-listing'])
    const all = (await get('/api/pipeline?scope=' + S)).json
    assert.equal(all.stages.length, 3, '默认含停用阶段（指挥台编辑用）')
    // 复位（后续用例依赖三环都在）
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-03 写入期校验矩阵：非法输入 4xx 且零写入', () => {
  it('role/label/next/gate/docs/runtime/门禁 逐项被拒且文案可读', async () => {
    const good = stagesFixture()
    const matrix = [
      { name: 'stages 非数组', body: { stages: 'x' }, re: /非空数组/ },
      { name: 'stages 空', body: { stages: [] }, re: /非空数组/ },
      { name: 'role 非法', body: { stages: [{ ...good[0], role: 'Soldier X' }] }, re: /role 非法/ },
      { name: 'label 缺失', body: { stages: [{ ...good[0], label: '  ' }] }, re: /label/ },
      { name: 'role 重复', body: { stages: [good[0], { ...good[1], role: good[0].role }] }, re: /重复/ },
      { name: 'next 未知', body: { stages: [{ ...good[0], next: 'ghost-role' }] }, re: /next=ghost-role/ },
      { name: 'gate 无 artifact', body: { stages: [{ ...good[0], gate: true }] }, re: /artifact/ },
      { name: 'docs 绝对路径', body: { stages: [{ ...good[0], docs: ['C:/tmp/x.md'] }] }, re: /相对路径/ },
      { name: 'docs 含 ..', body: { stages: [{ ...good[0], docs: ['a/../../etc/passwd'] }] }, re: /相对路径/ },
      { name: 'docs 非数组', body: { stages: [{ ...good[0], docs: 'a.md' }] }, re: /数组/ },
      { name: 'runtime.maxWorkers 越界', body: { stages: good, runtime: { maxWorkers: 99 } }, re: /maxWorkers/ },
      { name: 'scope 非法', body: { scope: 'Space X', stages: good }, re: /scope 非法/ },
      { name: '非 general', body: { stages: good }, by: 'coder', re: /general/ },
    ]
    const snapshot = async () => JSON.stringify((await get('/api/pipeline?scope=' + S)).json.stages)
    const before = await snapshot()
    for (const m of matrix) {
      const r = await post('/api/pipeline', { scope: S, by: m.by ?? 'general', ...m.body })
      assert.equal(r.status, 400, m.name + ' 应 400：' + r.text)
      assert.ok(m.re.test(r.json?.error ?? ''), m.name + ' 文案：' + (r.json?.error ?? r.text))
    }
    assert.equal(await snapshot(), before, '全部非法提交后流水线未变（零写入）')
  })

  it('gate:true + artifact 合法 → 接受（闸门可被校验）', async () => {
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: [stagesFixture()[0], { ...stagesFixture()[1], gate: true, artifact: 'docs/REQUIREMENTS.md' }, stagesFixture()[2]],
    })
    assert.equal(r.status, 200, r.text)
    const stage = (await get('/api/pipeline?scope=' + S)).json.stages.find(s => s.role === 'soldier-selection')
    assert.equal(stage.gate, true)
    assert.equal(stage.artifact, 'docs/REQUIREMENTS.md')
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-04 整批覆盖语义：未提交的旧阶段被删除', () => {
  it('提交 2 环 → 旧的第 3 环被 dropped，activeRoles 同步收敛', async () => {
    const two = stagesFixture().slice(0, 2)
    const r = await post('/api/pipeline', { scope: S, by: 'general', stages: two })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.task.dropped, ['soldier-listing'], '未提交阶段被删（整批覆盖语义）')
    const view = (await get('/api/pipeline?scope=' + S)).json
    assert.deepEqual(view.activeRoles, ['soldier-research', 'soldier-selection'])
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ? AND role = ?').get(S, 'soldier-listing').c, 0)
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-05/06 建链：编队 ∩ 流水线 + 阶段名 + 零交集护栏', () => {
  it('入链只含流水线启用岗位（观察员不入链）→ 链全程有人认领，阶段名用流水线 label', async () => {
    const r = await post('/api/goal', { scope: S, objective: '重新跑一次 ozon 选品', by: 'general' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 3, 'observer 不入链（编队 4 人 → 链 3 环）')
    const chain = chainOf(r.json.task.goal.id)
    assert.deepEqual(chain.map(c => c.role), ['soldier-research', 'soldier-selection', 'soldier-listing'])
    assert.ok(!chain.some(c => c.role === 'observer'), '非执行岗不在链上（消除 blockedBy 死锁）')
    assert.match(chain[0].title, /^【需求调研】/, '阶段名取自流水线 label 而不是位置套用的通用标签')
    assert.match(chain[2].title, /^【上架准备】/)
    assert.equal(chain[0].status, 'todo')
    assert.equal(chain[0].soldier, null)
    assert.deepEqual(JSON.parse(chain[0].blockedBy ?? '[]'), [], '首环无依赖')
    assert.deepEqual(JSON.parse(chain[1].blockedBy ?? '[]'), [chain[0].id], '串链依赖')
    assert.deepEqual(JSON.parse(chain[2].blockedBy ?? '[]'), [chain[1].id])
  })

  it('编队与流水线零交集 → 4xx 可读文案，且目标记录一并回滚（零残留）', async () => {
    await post('/api/spaces', { id: 'space-void', name: '零交集空间', by: 'general' })
    mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)').run('space-void', 'solo-worker', '独行侠', 'agent', '🤖', 0)
    await post('/api/pipeline', { scope: 'space-void', by: 'general', stages: [{ role: 'other-role', label: '别的岗位', prompt: '', next: null }] })
    const r = await post('/api/goal', { scope: 'space-void', objective: '不该建出任何链', by: 'general' })
    assert.equal(r.status, 400, r.text)
    assert.match(r.json.error, /交集|流水线/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM goal WHERE scope = ?').get('space-void').c, 0, '目标记录随事务回滚（不产生半个目标）')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE scope = ?').get('space-void').c, 0)
  })

  it('空间未配置流水线时退回全编队建链（向后兼容 software 等既有空间）', async () => {
    await post('/api/spaces', { id: 'space-legacy', name: '未配流水线', by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('space-legacy', 'requirement', '需求官', 'agent', '🤖', 0)
    ins.run('space-legacy', 'coder', '码农', 'agent', '💻', 1)
    const r = await post('/api/goal', { scope: 'space-legacy', objective: '兼容性目标', by: 'general' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 2, '无空间流水线 → 按全编队建链（既有行为不变）')
  })

  it('编队为空的空间仍可发布目标（0 环，保持既有合法行为）', async () => {
    // 回归锚：零交集护栏只应拦「编队有人但流水线全停用」；编队本身为空是既有合法态
    // （先发目标后补编队 / 通知中心冒烟建库），必须仍能发布并留下 goal:publish 审计。
    await post('/api/spaces', { id: 'space-noroster', name: '空编队空间', by: 'general' })
    const r = await post('/api/goal', { scope: 'space-noroster', objective: '空编队目标', by: 'general' })
    assert.equal(r.status, 200, '空编队不应被护栏拦下：' + r.text)
    assert.equal(r.json.task.stages, 0, '链 0 环（编队为空）')
    assert.equal(r.json.task.goal.objective, '空编队目标')
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'goal:publish' AND scope = ?").get('space-noroster').c === 1, 'goal:publish 审计应落库')
  })
})

describe('TC-SP-P0-07 开通预检 GET /api/spaces/provision', () => {
  function makeRepo(name, { git = true, gitignore = true } = {}) {
    const dir = join(tmpRoot, name)
    mkdirSync(dir, { recursive: true })
    if (git) mkdirSync(join(dir, '.git'), { recursive: true })
    if (gitignore) writeFileSync(join(dir, '.gitignore'), '.legion-worktrees/\n', 'utf8')
    return dir
  }

  it('未注册空间：可读报错（400）', async () => {
    const r = await get('/api/spaces/provision?id=Not A Space')
    assert.equal(r.status, 400)
    assert.match(r.json.error, /id 非法/)
  })

  it('预检清单不出现重复 code（pipeline-missing 只报一次，带可执行修复命令）', async () => {
    // 回归锚：编队非空 + 流水线为空时，预检自身的检查项与 pipelineWarnings 会各报一次
    // pipeline-missing；清单是给人照着做的，重复项会让人以为有两件事要修。
    const S = 'space-dupcheck'
    await post('/api/spaces', { id: S, name: '重复项检查', by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run(S, 'requirement', '需求官', 'agent', '🤖', 0)
    const r = await get('/api/spaces/provision?id=' + S)
    assert.equal(r.status, 200, r.text)
    const codes = r.json.checks.map(c => c.code)
    assert.equal(new Set(codes).size, codes.length, '预检清单 code 必须唯一：' + codes.join(','))
    assert.equal(codes.filter(c => c === 'pipeline-missing').length, 1)
    const miss = r.json.checks.find(c => c.code === 'pipeline-missing')
    assert.ok(/seed-pipeline/.test(miss.fix ?? ''), '应给出可执行的修复命令：' + JSON.stringify(miss))
  })

  it('自定义分区键（含下划线）可用：读面不因非规范 scope 而拒绝', async () => {
    // 回归锚：夹具 daemon（scope=__p13fixture__）这类非规范分区键必须能读自己的流水线，
    // 否则会静默回落部署面 rolesFile（排障时极难发现）。
    const r = await get('/api/pipeline?scope=__p13fixture__')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.stages, [])
    const p = await get('/api/spaces/provision?id=__p13fixture__')
    assert.equal(p.status, 200, p.text)
    assert.ok(p.json.checks.some(c => c.code === 'space-missing'), '未注册只降级为 warn')
    assert.equal(p.json.checks.find(c => c.code === 'space-missing').level, 'warn')
  })

  it('无流水线 + 无守护 + 未绑工作区 → 全部落地为 error/warn 清单（不产生 audit）', async () => {
    await post('/api/spaces', { id: R, name: '预检空间', by: 'general' })
    const auditBefore = mod.db.prepare('SELECT COUNT(*) AS c FROM audit').get().c
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, false)
    const codes = r.json.checks.map(c => c.code)
    for (const want of ['roster-empty', 'pipeline-missing', 'runtime-disabled', 'daemon-offline', 'workspace-unbound']) {
      assert.ok(codes.includes(want), '缺检查项 ' + want + '：' + codes.join(','))
    }
    const p = r.json.checks.find(c => c.code === 'pipeline-missing')
    assert.equal(p.level, 'error')
    assert.ok(p.fix && p.fix.includes('seed-pipeline'), '给出一键修复指引：' + p.fix)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM audit').get().c, auditBefore, '预检是只读的：零 audit')
  })

  it('流水线 + 编队在位 + 守护心跳 + git 工作区 → ok=true，逐项 ok 明细', async () => {
    seedRoster(R)
    await post('/api/pipeline', { scope: R, by: 'general', stages: stagesFixture(), runtime: { enabled: true, maxWorkers: 1 } })
    const repo = makeRepo('repo-ro')
    await post('/api/spaces', { id: R, name: '预检空间', localDir: repo, remoteUrl: 'git@github.com:x/y.git', by: 'general' })
    mod.db.prepare('INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?)').run('soldier-auto@' + R, R, 'worker', new Date().toISOString(), 1)
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true, '清单：' + JSON.stringify(r.json.checks))
    const ok = new Set(r.json.checks.filter(c => c.level === 'ok').map(c => c.code))
    for (const want of ['pipeline-configured', 'daemon-online', 'workspace-bound', 'queue-visible']) assert.ok(ok.has(want), '缺 ok 项 ' + want)
    assert.equal(r.json.pipeline.activeRoles.length, 3)
  })

  it('工作区存在但非 git、且 .gitignore 未忽略隔离目录 → 分级告警而非 error', async () => {
    const repo = makeRepo('repo-nogit', { git: false, gitignore: false })
    await post('/api/spaces', { id: R, name: '预检空间', localDir: repo, by: 'general' })
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    const codes = r.json.checks.map(c => c.code)
    assert.ok(codes.includes('workspace-not-git'), '非 git 工作区应告警：' + codes.join(','))
    assert.equal(r.json.ok, true, '非 git 只是告警（P2 有无仓库模式）')
  })

  it('待办任务 + 守护离线 → queue-stalled 明确点名「队列不会前进」', async () => {
    mod.db.prepare('INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lastSeenAt=excluded.lastSeenAt, online=excluded.online').run('soldier-auto@' + R, R, 'worker', '2026-01-01T00:00:00.000Z', 0)
    await post('/api/create', { scope: R, title: '排队任务', role: 'soldier-research', status: 'todo', by: 'general' })
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.json.ok, false)
    const stalled = r.json.checks.find(c => c.code === 'queue-stalled')
    assert.ok(stalled, '应报 queue-stalled：' + JSON.stringify(r.json.checks.map(c => c.code)))
    assert.match(stalled.message, /队列不会前进/)
  })
})

describe('TC-SP-P0-08 级联：空间删除清理流水线数据', () => {
  it('删除空间 → space_stages/space_runtime 清零，audit 保留', async () => {
    assert.ok(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?').get(R).c > 0)
    const impact = await get('/api/spaces/impact?id=' + R)
    assert.equal(impact.json.counts.spaceStages, 3)
    assert.equal(impact.json.counts.spaceRuntime, 1)
    const del = await post('/api/spaces/delete', { id: R, confirm: 'delete-space:' + R, by: 'general' })
    assert.equal(del.status, 200, del.text)
    assert.equal(del.json.task.removed.spaceStages, 3)
    assert.equal(del.json.task.removed.spaceRuntime, 1)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?').get(R).c, 0)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_runtime WHERE scope = ?').get(R).c, 0)
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'pipeline:update' AND scope = ?").get(R).c > 0, 'audit 保留')
  })

  it('空间删除后 GET /api/pipeline 回到空态', async () => {
    const r = await get('/api/pipeline?scope=' + R)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.stages, [])
    assert.equal(r.json.runtime.enabled, false)
  })
})
