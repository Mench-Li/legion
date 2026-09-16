// team-hub/goal-closed.test.mjs — 「收口目标不再接受新任务」契约测试。
//
// 背景（T-156 现场 → 2026-09-16 复发）：给流水线末环补 `next` 时，历史**已收口**目标的末环任务
// 被守护判为「该有后继」，凭空长出新链（与当前目标同岗位链产物路径相同→互相覆盖）。
// 守护侧判断读进程内缓存且缓存缺失时放行（fail-open），旧代码/缓存未就绪时拦不住；
// 故在数据层加唯一收口点 assertGoalOpen。
//
// 本测试两侧都钉住：① 已收口目标必须拦住（含各条建任务路径）；② 正常建链不能被误伤。
// 运行：node --test team-hub/goal-closed.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-goalclosed-'))
let mod

/** 建目标并返回 goalId（走真实发布路径，顺带覆盖「新目标不被误伤」）。 */
function publish(scope, objective) {
  return mod.publishGoalRecord(scope, objective).goal.id
}

/** 直接把目标置终态（只关心 status 读路径，不牵扯状态机细节）。 */
function setStatus(goalId, status) {
  mod.db.prepare('UPDATE goal SET status = ? WHERE id = ?').run(status, goalId)
}

function createTask(goalId, role = 'coder') {
  return mod.createTask({ title: `探针任务 ${role}`, role, scope: 'software', status: 'todo', goalId })
}

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  mod = await import('./server.mjs')
  const ins = mod.db.prepare('INSERT OR IGNORE INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('software', 'requirement', '需求官', '', '🤖', 0)
  ins.run('software', 'coder', '码农', '', '🤖', 1)
})

after(() => {
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('收口目标不再接受新任务（数据层唯一收口点）', () => {
  it('目标 done 后 createTask 抛错，且错误文案给出真实可行的续做路径', () => {
    const g = publish('software', '收口测试：done 目标')
    setStatus(g, 'done')
    assert.throws(
      () => createTask(g),
      (e) => {
        assert.match(e.message, /收口目标不再接受新任务/, '应命中收口语义')
        assert.match(e.message, /新目标/, '应指向真实可行的续做路径（新目标）')
        assert.match(e.message, new RegExp(g), '应点名目标')
        // 反例锚定：done/canceled 不可恢复为 active，所以提示语不得承诺恢复——
        // 这是实测抓到的一次真实误导（setGoalState 只允许 paused→active）。
        assert.doesNotMatch(e.message, /恢复为 active/, 'done 是终态，不得承诺恢复为 active')
        return true
      },
    )
  })

  it('目标 canceled 后 createTask 同样被拦', () => {
    const g = publish('software', '收口测试：canceled 目标')
    setStatus(g, 'canceled')
    assert.throws(() => createTask(g), /收口目标不再接受新任务/)
  })

  it('目标 paused（可恢复态）**不**被拦——暂停不是终态', () => {
    const g = publish('software', '收口测试：paused 目标')
    setStatus(g, 'paused')
    assert.ok(createTask(g), 'paused 目标应可继续建任务（暂停是可恢复态）')
  })

  it('active 目标正常建任务（不误伤）', () => {
    const g = publish('software', '收口测试：active 目标')
    assert.ok(createTask(g))
  })

  it('无 goalId 的手工任务不受影响', () => {
    assert.ok(mod.createTask({ title: '手工任务', role: 'coder', scope: 'software', status: 'todo' }))
  })

  it('未知 goalId 保持既有行为（不因查不到目标而拦）', () => {
    assert.ok(createTask('G-does-not-exist'))
  })

  it('目标链条路径也被拦：createGoalChain 对已收口目标抛错', () => {
    const g = publish('software', '收口测试：链路径')
    setStatus(g, 'done')
    assert.throws(() => mod.createGoalChain(g, 'software', '收口测试：链路径'), /收口目标不再接受新任务/)
  })

  it('真实收尾路径：链任务全 done → settleGoalsOfScope 收口 → 建后继被拦', () => {
    const g = publish('software', '收口测试：真实收尾路径')
    const chain = mod.db.prepare("SELECT id FROM tasks WHERE goalId = ? AND status != 'canceled'").all(g)
    assert.ok(chain.length > 0, '新目标应生成链任务')
    for (const t of chain) mod.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id)
    // 收尾：done === total → 目标自动 done（与 /api/advance 触发的是同一函数）
    assert.equal(mod.settleGoalsOfScope('software'), 1, '应恰好收口 1 个目标')
    assert.equal(mod.listGoals('software').find(x => x.id === g).status, 'done')
    // 此刻守护若补建后继 → 必须被拦
    assert.throws(() => createTask(g), /收口目标不再接受新任务/)
  })

  it('真实续做路径：旧目标保持关闭，新目标承接（这是 done 目标唯一受支持的续做方式）', () => {
    const old = publish('software', '收口测试：旧目标')
    setStatus(old, 'done')
    assert.throws(() => createTask(old), /收口目标不再接受新任务/)
    // done 是终态：状态机不允许恢复为 active（只有 paused 可恢复）
    assert.throws(
      () => mod.setGoalState(old, 'active', 'general', true),
      /只有 paused 的目标可恢复/,
      'done 不可恢复为 active —— 故续做只能走新目标',
    )
    // 续做 = 发布新目标；旧目标状态不受影响
    const fresh = publish('software', '收口测试：承接旧目标的新目标')
    assert.notEqual(fresh, old)
    assert.ok(createTask(fresh), '新目标可正常建任务')
    assert.equal(mod.listGoals('software').find(x => x.id === old).status, 'done', '旧目标应保持 done')
  })

  it('新目标发布不被误伤：publishGoalRecord 仍生成完整链', () => {
    const g = publish('software', '收口测试：新目标回归')
    const chain = mod.db.prepare("SELECT id, role, status FROM tasks WHERE goalId = ?").all(g)
    assert.equal(chain.length, 2, '编队 2 人应生成 2 环链')
    assert.ok(chain.every(t => t.status === 'todo'), '新链任务应为 todo')
  })
})
