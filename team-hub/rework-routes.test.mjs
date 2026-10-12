// ============================================================================
// `POST /api/rework` —— 验收不满意 → 打回重做 + 重建下游链
//
// ## 这份用例在守什么
//
// 这条路由是**看板拖拽**唯一会走到的新写路径，而它一次做四件事（作废旧链 / 发新目标 /
// 建链 / 回填改动点）。四件事里任何一件**只做了一半**，都会留下一个看得见却不自洽的状态：
//
//   · 只作废下游、不作废本环  ⇒ 看板上"T-199 已验收"与"它的重做正在进行"同时为真；
//   · 只建链、不作废旧链      ⇒ 同一个目标下两条同岗位链并存，产物路径相同会互相覆盖
//                              （这正是 T-156 的形态，也是 `assertGoalOpen` 存在的理由）；
//   · 只回退状态、不建下游    ⇒ 重做完成的产出没有任何人接棒，链在 coder 处断掉；
//   · 改动点丢了              ⇒ 执行者按原样再交一次，而"又交了一遍同样的东西"
//                              与"根本没重做"在验收时看不出区别。
//
// ★ 还有一件**必须被测到**的事：这次**不给已收口目标开例外**。
//   重做走的是"发新目标承接"（本仓对 T-156 的裁决），旧目标保持 done 不动。
//   用例把这一条钉住：旧目标状态、旧链上游任务，一个都不许被这次重做改动。
//
// 运行：node --test team-hub/rework-routes.test.mjs
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-rework-'))
const S = 'space-rw'
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关 */ }
  try { mod?.db?.close() } catch { /* 已关 */ }
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

/** 五环流水线：分析尾 → 编码 → 审查 → 测试 → 部署（与 software 空间同形，截短一截）。 */
const STAGES = [
  { role: 'test-designer', label: '测试用例设计', prompt: '用例……', next: 'coder' },
  { role: 'coder', label: '编码实现', prompt: '实现……', next: 'reviewer' },
  { role: 'reviewer', label: '代码审查', prompt: '审查……', next: 'tester' },
  { role: 'tester', label: '测试执行', prompt: '测试……', next: 'devops' },
  { role: 'devops', label: '部署与 CI/CD', prompt: '部署……', next: null },
]

function seedSpace() {
  const roster = mod.db.prepare('INSERT OR IGNORE INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  STAGES.forEach((s, i) => roster.run(S, s.role, s.label, 'agent', '🙂', i))
  const rt = mod.db.prepare('INSERT OR IGNORE INTO space_runtime (scope, enabled, maxWorkers, isolate, updatedAt) VALUES (?, 1, 1, 1, ?)')
  rt.run(S, new Date().toISOString())
}

/** 发布一个真实链目标，然后把全链人为置 done（模拟"整条链都验收过了"）。 */
async function publishDoneChain(objective) {
  const r = await post('/api/goal', { by: 'general', scope: S, objective })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const goalId = r.json.task.goal.id
  mod.db.prepare("UPDATE tasks SET status='done' WHERE goalId=?").run(goalId)
  const tasks = mod.db.prepare('SELECT id, role FROM tasks WHERE goalId=? ORDER BY id').all(goalId)
  return { goalId, tasks, byRole: new Map(tasks.map(t => [t.role, t.id])) }
}

describe('POST /api/rework 契约', () => {
  before(async () => {
    seedSpace()
    const p = await post('/api/pipeline', { by: 'general', scope: S, stages: STAGES })
    assert.equal(p.status, 200, JSON.stringify(p.json))
  })

  it('① 先过 handleWrite 的操作者闸，再校验改动点必填', async () => {
    const noBy = await post('/api/rework', { id: 'T-1' })
    assert.equal(noBy.status, 400)
    assert.match(String(noBy.json.error), /缺少操作者身份 by/)

    const noReason = await post('/api/rework', { by: 'general', id: 'T-1' })
    assert.equal(noReason.status, 400)
    assert.match(String(noReason.json.error), /改动点/)
    assert.equal(noReason.json.code, 'REWORK_REASON_REQUIRED')

    const blank = await post('/api/rework', { by: 'general', id: 'T-1', reason: '   ' })
    assert.equal(blank.status, 400)
    assert.equal(blank.json.code, 'REWORK_REASON_REQUIRED')
  })

  it('② 只收 done / in_review：开发中的任务请走「打回」', async () => {
    const r = await post('/api/goal', { by: 'general', scope: S, objective: '重做用例：开发中不可重做' })
    const goalId = r.json.task.goal.id
    const coder = mod.db.prepare("SELECT id FROM tasks WHERE goalId=? AND role='coder'").get(goalId)
    const res = await post('/api/rework', { by: 'general', id: coder.id, reason: '还没做完就想重做' })
    assert.equal(res.status, 409)
    assert.equal(res.json.code, 'REWORK_STATE')
    assert.match(String(res.json.error), /打回/)
  })

  it('③ 未知任务 / 越空间：报得出来，且不留下半个新目标', async () => {
    const unknown = await post('/api/rework', { by: 'general', id: 'T-999999', reason: 'x' })
    assert.equal(unknown.status, 400)
    assert.match(String(unknown.json.error), /未知任务/)

    const chain = await publishDoneChain('重做用例：越空间')
    const goalsBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n
    const cross = await post('/api/rework', { by: 'general', scope: 'other-space', id: chain.byRole.get('coder'), reason: 'x' })
    assert.equal(cross.status, 403)
    assert.equal(cross.json.code, 'SCOPE_MISMATCH')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n, goalsBefore, '越空间被拒后不许留下新目标')
  })

  it('④ 乐观锁：ifVersion 过期 ⇒ 409，且不动任何一条任务', async () => {
    const chain = await publishDoneChain('重做用例：乐观锁')
    const coderId = chain.byRole.get('coder')
    const stale = await post('/api/rework', { by: 'general', scope: S, id: coderId, reason: 'x', ifVersion: 999 })
    assert.equal(stale.status, 409)
    assert.match(String(stale.json.error), /乐观锁冲突/)
    assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(coderId).status, 'done', '冲突不许改动任务')
  })

  it('⑤ ★★★ 主路径：作废本环+下游、保留上游、发新目标、新链 blockedBy 串好', async () => {
    const chain = await publishDoneChain('把 Agent 名字与头像做得更像人')
    const coderId = chain.byRole.get('coder')
    const before = {
      goal: mod.db.prepare('SELECT * FROM goal WHERE id=?').get(chain.goalId),
      upstream: mod.db.prepare("SELECT id, status FROM tasks WHERE goalId=? AND role='test-designer'").get(chain.goalId),
    }

    const r = await post('/api/rework', {
      by: 'general', scope: S, id: coderId,
      reason: '头像裁切里有黑边；名字要能体现职能，不要用编号',
    })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.ok, true)
    // 响应是**展平**的报告（不是 {task:...}）：调用方要拿新链的 id 去刷新泳道
    assert.equal(r.json.reworked.id, coderId)
    assert.equal(r.json.reworked.fromStatus, 'done')

    // ① 新目标：active、承接重做，与旧目标是两条记录
    const goal = r.json.goal
    assert.ok(goal.id && goal.id !== chain.goalId, '重做必须发**新**目标承接（不给已收口目标开例外）')
    assert.equal(goal.status, 'active')
    assert.match(String(goal.objective), /重做/)
    assert.match(String(goal.objective), new RegExp(coderId))

    // ② 新链 = 本岗位 → 沿流水线 next 到链尾
    assert.deepEqual(r.json.created.map(c => c.role), ['coder', 'reviewer', 'tester', 'devops'])
    assert.deepEqual(r.json.roles, ['coder', 'reviewer', 'tester', 'devops'])
    const newIds = r.json.created.map(c => c.id)
    const rows = newIds.map(id => mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(id))
    assert.deepEqual(rows.map(x => x.status), ['todo', 'todo', 'todo', 'todo'], '新链全部待认领')
    assert.deepEqual(rows.map(x => JSON.parse(x.blockedBy)), [[], [newIds[0]], [newIds[1]], [newIds[2]]], 'blockedBy 必须一环扣一环')
    assert.deepEqual(rows.map(x => x.goalId), newIds.map(() => goal.id), '新链全部挂新目标')
    assert.equal(rows[0].role, 'coder')
    assert.match(String(rows[0].title), /编码|coder|Agent/, '首环沿用原任务标题（人一眼认得出重做的是哪张卡）')
    assert.match(String(rows[0].description), /头像裁切里有黑边/, '改动点必须进新任务正文')
    assert.match(String(rows[3].title), /部署/, '下游标题换成自己那一环的阶段名')

    // ③ 改动点同时留成评论：守护把它当"将军答复"带进下一轮提示词
    const firstComments = JSON.parse(rows[0].comments)
    assert.ok(firstComments.some(c => String(c.text).includes('头像裁切里有黑边')), '改动点要有一条评论')
    assert.ok(firstComments.some(c => c.by === 'general'))

    // ④ 作废集：本环 + 下游；上游（test-designer）一条都不许动
    assert.deepEqual([...r.json.superseded].sort(), ['coder', 'reviewer', 'tester', 'devops']
      .map(role => chain.byRole.get(role)).sort())
    for (const role of ['coder', 'reviewer', 'tester', 'devops']) {
      const row = mod.db.prepare('SELECT status, comments FROM tasks WHERE id=?').get(chain.byRole.get(role))
      assert.equal(row.status, 'canceled', `${role} 必须被作废`)
      assert.ok(JSON.parse(row.comments).some(c => String(c.text).includes('已被重做取代') && String(c.text).includes(goal.id)),
        `${role} 上要留一条指向新目标的评论`)
    }
    const upstream = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(before.upstream.id)
    assert.equal(upstream.status, 'done', '上游分析任务（test-designer）不该被这次重做作废')

    // ⑤ 旧目标一动不动：状态、上游任务都保持原样
    const after = mod.db.prepare('SELECT status, objective FROM goal WHERE id=?').get(chain.goalId)
    assert.equal(after.status, before.goal.status)
    assert.equal(after.objective, before.goal.objective)
  })

  it('⑥ 下游不会抢跑：新链第二环被第一环挡着（blockedBy 是机器闸，不是注释）', async () => {
    const chain = await publishDoneChain('重做用例：拦截下游抢跑')
    const r = await post('/api/rework', { by: 'general', scope: S, id: chain.byRole.get('coder'), reason: '重做' })
    const [first, second] = r.json.created.map(c => c.id)
    const blocked = await post('/api/claim', { by: 'general', scope: S, id: second, soldier: 'reviewer' })
    assert.equal(blocked.status, 400, JSON.stringify(blocked.json))
    assert.match(String(blocked.json.error), /未完成依赖阻塞/)
    const allowed = await post('/api/claim', { by: 'general', scope: S, id: first, soldier: 'coder' })
    assert.equal(allowed.status, 200, '首环无依赖，必须能认领')
  })

  it('⑦ 重放同一张卡：第二次重做被拒（作废态不可再发起），不会长出第二条链', async () => {
    const chain = await publishDoneChain('重做用例：重放')
    const coderId = chain.byRole.get('coder')
    const first = await post('/api/rework', { by: 'general', scope: S, id: coderId, reason: '第一次' })
    assert.equal(first.status, 200)
    const goalsAfterFirst = mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n
    const again = await post('/api/rework', { by: 'general', scope: S, id: coderId, reason: '第二次' })
    assert.equal(again.status, 409)
    assert.equal(again.json.code, 'REWORK_STATE')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n, goalsAfterFirst, '被拒的重放不许留下新目标')
  })

  it('⑧ 岗位不在启用流水线里 ⇒ 409 并说清是哪一环', async () => {
    const chain = await publishDoneChain('重做用例：岗位缺失')
    const coderId = chain.byRole.get('coder')
    mod.db.prepare("UPDATE space_stages SET enabled=0 WHERE scope=? AND role='coder'").run(S)
    try {
      const r = await post('/api/rework', { by: 'general', scope: S, id: coderId, reason: 'x' })
      assert.equal(r.status, 409)
      assert.equal(r.json.code, 'REWORK_STAGE_MISSING')
      assert.match(String(r.json.error), /coder/)
    } finally {
      mod.db.prepare("UPDATE space_stages SET enabled=1 WHERE scope=? AND role='coder'").run(S)
    }
  })

  it('⑨ 审计留痕：rework（域）与 rework:chain（路由）两条都在', async () => {
    const chain = await publishDoneChain('重做用例：审计')
    const coderId = chain.byRole.get('coder')
    const r = await post('/api/rework', { by: 'general', scope: S, id: coderId, reason: '审计留痕' })
    const goalId = r.json.goal.id
    const rows = mod.db.prepare("SELECT action, detail FROM audit WHERE action IN ('rework','rework:chain') AND scope=? ORDER BY rowid DESC LIMIT 4").all(S)
    const domain = rows.find(x => x.action === 'rework')
    const route = rows.find(x => x.action === 'rework:chain')
    assert.ok(domain, '域层要记一条 rework')
    assert.ok(route, '路由层要记一条 rework:chain')
    assert.equal(JSON.parse(domain.detail).newGoalId, goalId)
    assert.deepEqual(JSON.parse(route.detail).created, r.json.created.map(c => c.id))
  })
})
