// team-hub/goal.test.mjs — 多目标（goal v2）契约测试：并存互不取消 / 状态生命周期(active/paused/done/canceled)
// + 版本号 / 链任务 goalId 归属 / 自动收尾 / 取消只取消自己未开工任务 / 非将军护栏。
// 运行：node --test team-hub/goal.test.mjs
// 通过 TEAM_HUB_DB 指向临时库，动态 import server.mjs（import 不占端口，见 isMain 守卫）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-goal-'))
let mod
let dbFile

function seedRoster(scope = 'software') {
  const ins = mod.db.prepare('INSERT OR IGNORE INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(scope, 'requirement', '需求官', '', '🤖', 0)
  ins.run(scope, 'coder', '码农', '', '🤖', 1)
}

/** 查某空间某目标（未取消任务）链任务。 */
function chainTasks(goalId) {
  return mod.db.prepare("SELECT id, status, role, goalId FROM tasks WHERE goalId = ? AND status != 'canceled' ORDER BY id").all(goalId)
}

/** 任务行读取视图（getTask 未导出：hold 归一为 boolean、comments 解析为数组）。 */
function taskRow(id) {
  const r = mod.db.prepare('SELECT id, status, hold, version, comments FROM tasks WHERE id = ?').get(id)
  return { ...r, hold: r.hold === 1, comments: JSON.parse(r.comments ?? '[]') }
}

before(async () => {
  dbFile = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_DB = dbFile
  mod = await import('./server.mjs')
}) 

after(() => {
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('老库迁移：旧 goal 表（scope 主键 / 无 goalId 任务）→ 多目标模型 + 历史链回填', () => {
  it('import 时自动迁移：目标升级为 G-xxx 记录，未取消 [auto-goal] 链任务回填 goalId', async () => {
    // 构造老库：goal 为 scope 主键；tasks 无 goalId 列（迁移的 ensureColumn 会补齐）
    const legacyFile = join(tmpRoot, 'legacy.db')
    {
      const legacyDb = new DatabaseSync(legacyFile)
      legacyDb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, scope TEXT, role TEXT)')
      legacyDb.exec('CREATE TABLE goal (scope TEXT PRIMARY KEY, objective TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)')
      legacyDb.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
        .run('software', '遗留目标：旧库目标甲', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')
      const ins = legacyDb.prepare('INSERT INTO tasks (id, title, description, status, scope, role) VALUES (?, ?, ?, ?, ?, ?)')
      ins.run('T-900', '旧链任务1', '[auto-goal]\n目标：遗留目标：旧库目标甲\n本阶段：需求讨论', 'done', 'software', 'requirement')
      ins.run('T-901', '旧链任务2', '[auto-goal]\n目标：遗留目标：旧库目标甲\n本阶段：代码开发', 'todo', 'software', 'coder')
      ins.run('T-902', '无关手工任务', '手工建的任务', 'todo', 'software', 'coder')
      legacyDb.close()
    }
    // 以 cache-bust 查询串二次 import → 独立模块实例，用 legacy.db 走一遍启动迁移
    const prev = process.env.TEAM_HUB_DB
    process.env.TEAM_HUB_DB = legacyFile
    const legacyMod = await import(`./server.mjs?legacy=${Date.now()}`)
    process.env.TEAM_HUB_DB = prev
    try {
      const goals = legacyMod.listGoals('software')
      assert.equal(goals.length, 1, '旧单目标应迁移为一条记录')
      const g = goals[0]
      assert.match(g.id, /^G-/, '迁移目标应分配 G-xxx id')
      assert.equal(g.objective, '遗留目标：旧库目标甲')
      assert.equal(g.status, 'active')
      assert.equal(g.version, 1)
      // 未取消的 [auto-goal] 链任务应回填 goalId（含已 done 的历史链）；手工任务不挂
      const attached = legacyMod.db.prepare('SELECT id FROM tasks WHERE goalId = ?').all(g.id).map(r => r.id)
      assert.deepEqual(attached.sort(), ['T-900', 'T-901'])
      const manual = legacyMod.db.prepare('SELECT goalId FROM tasks WHERE id = ?').get('T-902')
      assert.equal(manual.goalId, null)
      const v = legacyMod.goalView(legacyMod.db.prepare('SELECT * FROM goal WHERE id = ?').get(g.id))
      assert.equal(v.done, 1)
      assert.equal(v.total, 2)
      assert.equal(v.percent, 50)
    } finally {
      try { legacyMod?.db?.close() } catch { /* 已关闭 */ }
    }
  })
})

describe('多目标发布：并存互不取消，各自独立链', () => {
  it('连续发布两个目标 → 两条记录都 active，链任务互不干扰', () => {
    seedRoster()
    const pa = mod.publishGoalRecord('software', '目标甲：双目标并发 A', 'chain', 'general')
    const ga = pa.goal
    assert.equal(ga.status, 'active')
    assert.equal(ga.version, 1)
    assert.equal(pa.stages, 2, '编队 2 岗 → 链应 2 段')
    assert.match(ga.id, /^G-/)

    const pb = mod.publishGoalRecord('software', '目标乙：双目标并发 B', 'chain', 'general')
    const gb = pb.goal
    assert.equal(gb.status, 'active')

    const goals = mod.listGoals('software')
    assert.equal(goals.length, 2)
    // 关键语义：发布 B 不再取消 A 的链
    assert.equal(chainTasks(ga.id).length, 2, 'A 的链任务保持原样')
    assert.equal(chainTasks(gb.id).length, 2, 'B 有自己的 2 段链')
    // goalId 归属
    for (const t of chainTasks(ga.id)) assert.equal(t.goalId, ga.id)
    for (const t of chainTasks(gb.id)) assert.equal(t.goalId, gb.id)
    mod.settleGoalsOfScope('software') // 不影响 active
    assert.equal(mod.listGoals('software').filter(g => g.status === 'active').length, 2)
  })

  it('进度按各自链统计：B 链全 done 只收尾 B，A 保持 active', () => {
    const goals = mod.listGoals('software')
    const a = goals.find(g => g.objective.includes('目标甲'))
    const b = goals.find(g => g.objective.includes('目标乙'))
    assert.ok(a && b)
    const view = (id) => mod.goalView(mod.db.prepare('SELECT * FROM goal WHERE id = ?').get(id))
    const bt = chainTasks(b.id)
    for (const t of bt) {
      mod.db.prepare("UPDATE tasks SET status='done', version=version+1, updatedAt=? WHERE id=?").run(new Date().toISOString(), t.id)
    }
    const settled = mod.settleGoalsOfScope('software')
    assert.equal(settled, 1)
    const bAfter = view(b.id)
    const aAfter = view(a.id)
    assert.equal(bAfter.status, 'done')
    assert.equal(bAfter.version, 2, '收尾应版本 +1')
    assert.ok(bAfter.endedAt, '终态应记 endedAt')
    assert.equal(aAfter.status, 'active', 'A 不受 B 收尾影响')
    assert.equal(bAfter.done, 2)
    assert.equal(bAfter.total, 2)
    assert.equal(bAfter.percent, 100)
  })
})

describe('目标状态生命周期与护栏', () => {
  it('active ↔ paused 切换 + 版本递增', () => {
    const g = mod.listGoals('software').find(x => x.status === 'active')
    assert.ok(g)
    const r1 = mod.setGoalState(g.id, 'paused', 'general')
    assert.equal(r1.goal.status, 'paused')
    assert.equal(r1.goal.version, g.version + 1)
    const r2 = mod.setGoalState(g.id, 'active', 'general')
    assert.equal(r2.goal.status, 'active')
    assert.equal(r2.goal.version, g.version + 2)
  })

  it('取消目标 → 只取消该目标未开工链任务，其他目标链不受影响', () => {
    const ga = mod.listGoals('software').find(x => x.objective.includes('目标甲'))
    const other = mod.listGoals('software').find(x => x.id !== ga.id)
    const beforeOther = mod.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE goalId = ? AND status != 'canceled'").get(other.id).c
    const aTodo = mod.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE goalId = ? AND status IN ('todo','blocked','backlog')").get(ga.id).c
    assert.ok(aTodo > 0, 'A 应还有未开工任务')
    const r = mod.setGoalState(ga.id, 'canceled', 'general')
    assert.equal(r.goal.status, 'canceled')
    assert.equal(r.canceledTasks, aTodo)
    const aCanceled = mod.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE goalId = ? AND status = 'canceled'").get(ga.id).c
    assert.equal(aCanceled, aTodo, 'A 未开工任务应全部被取消')
    const aRunning = mod.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE goalId = ? AND status IN ('in_progress','in_review')").get(ga.id).c
    assert.equal(aRunning, 0)
    // 其他目标链（B done）不被误伤
    const afterOther = mod.db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE goalId = ? AND status != 'canceled'").get(other.id).c
    assert.equal(afterOther, beforeOther)
  })

  // T-141 现场：目标取消时 in_review 的任务不会被硬杀（有意设计），但也必须留痕 + 挂起，
  // 否则它既没有下游、也没人推进，会静默躺在「待我决定」直到将军偶然发现。
  it('取消目标 → 在办/待验收任务留痕并置 hold（不静默滞留）', () => {
    const g = mod.publishGoalRecord('software', '目标庚：在办留痕测试', 'chain', 'general').goal
    const chain = chainTasks(g.id)
    assert.equal(chain.length, 2)
    const [running, reviewing] = chain
    mod.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(running.id)
    mod.db.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(reviewing.id)
    const beforeVersion = taskRow(reviewing.id).version

    const r = mod.setGoalState(g.id, 'canceled', 'general')
    assert.equal(r.goal.status, 'canceled')
    assert.deepEqual([...r.strandedTasks].sort(), [running.id, reviewing.id].sort(), '两条在办任务都应留痕')
    assert.equal(r.canceledTasks, 0, '在办任务不计入硬取消数')

    for (const id of [running.id, reviewing.id]) {
      const t = taskRow(id)
      assert.notEqual(t.status, 'canceled', '在办任务保持原状态（不静默处决）')
      assert.equal(t.hold, true, '应置 hold，挡住守护自动认领/流转')
      const last = t.comments.at(-1)
      assert.equal(last.by, 'general')
      assert.match(last.text, /所属目标 .* 已取消/, '应留一条显式提示评论')
      assert.match(last.text, /验收通过/, '应给出将军的处置路径')
    }
    assert.equal(taskRow(reviewing.id).version, beforeVersion + 1, '留痕应版本 +1')

    // 反向：已 done 的任务不因目标取消而被 hold（它本来就没有下游）
    const g2 = mod.publishGoalRecord('software', '目标辛：done 不挂起', 'chain', 'general').goal
    const doneTask = chainTasks(g2.id)[0]
    mod.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(doneTask.id)
    const r2 = mod.setGoalState(g2.id, 'canceled', 'general')
    assert.deepEqual(r2.strandedTasks, [], '无在办任务 → 留痕列表为空')
    assert.equal(taskRow(doneTask.id).hold, false, 'done 任务不在留痕范围')
  })

  it('护栏：非将军不可改状态；canceled 是终态', () => {
    const live = mod.publishGoalRecord('software', '目标丙：护栏测试', 'chain', 'general').goal
    assert.equal(live.status, 'active')
    assert.throws(() => mod.setGoalState(live.id, 'paused', 'soldier-1'), /仅允许将军/)
    const canceled = mod.listGoals('software').find(x => x.status === 'canceled')
    assert.ok(canceled)
    assert.throws(() => mod.setGoalState(canceled.id, 'active', 'general'), /已取消/)
    assert.throws(() => mod.setGoalState('G-no-such', 'active', 'general'), /未知目标/)
  })

  it('非法 status 拒绝', () => {
    const live = mod.publishGoalRecord('software', '目标丁：非法状态测试', 'chain', 'general').goal
    assert.throws(() => mod.setGoalState(live.id, 'archived', 'general'), /status 必须是/)
  })
})

describe('目标级上下文（goal:context，同目标共享上下文）+ 审计 goalId + 文件域', () => {
  function goalRow(id) {
    return mod.goalView(mod.db.prepare('SELECT * FROM goal WHERE id = ?').get(id))
  }

  it('setGoalContext：更新 context 并递增 contextVersion，goalView 携带', () => {
    const g = mod.publishGoalRecord('software', '目标戊：上下文测试', 'chain', 'general').goal
    assert.equal(g.context, '', '新目标 context 默认空')
    assert.equal(g.contextVersion, 0, '新目标 contextVersion 默认 0')
    const r1 = mod.setGoalContext(g.id, '  设计约束：不动 team-hub 存储层；文件域地图见各切片声明。  ', 'general')
    assert.equal(r1.changed, true)
    assert.equal(r1.goal.contextVersion, 1)
    assert.equal(r1.goal.context, '设计约束：不动 team-hub 存储层；文件域地图见各切片声明。', 'context 应去除首尾空白')
    const r2 = mod.setGoalContext(g.id, 'v2：追加验收口径：全量契约测试绿。', 'general')
    assert.equal(r2.goal.contextVersion, 2)
    const row = goalRow(g.id)
    assert.equal(row.context, 'v2：追加验收口径：全量契约测试绿。')
    assert.equal(row.contextVersion, 2)
    assert.equal(row.version, 1, 'context 更新不动目标状态版本')
  })

  it('setGoalContext 护栏：非将军拒绝 / 缺 id / 空 text / 终态拒绝', () => {
    const g = mod.publishGoalRecord('software', '目标己：上下文护栏', 'chain', 'general').goal
    assert.throws(() => mod.setGoalContext(g.id, 'x', 'soldier-1'), /仅允许将军/)
    assert.throws(() => mod.setGoalContext('', 'x', 'general'), /缺少参数 id/)
    assert.throws(() => mod.setGoalContext(g.id, '   ', 'general'), /context 必须是非空字符串/)
    mod.setGoalState(g.id, 'canceled', 'general')
    assert.throws(() => mod.setGoalContext(g.id, 'x', 'general'), /已 canceled/)
    assert.throws(() => mod.setGoalContext('G-no-such', 'x', 'general'), /未知目标/)
  })

  it('audit：goal:publish / goal:context 行带 goalId（per-goal 活动视图数据源）', () => {
    const g = mod.listGoals('software').find(x => x.objective.includes('目标戊：上下文测试'))
    assert.ok(g)
    mod.setGoalContext(g.id, 'v3：审计校验用。', 'general')
    const rows = mod.db.prepare("SELECT action, taskId, goalId FROM audit WHERE action IN ('goal:publish','goal:context') AND (taskId = ? OR goalId = ?) ORDER BY seq").all(g.id, g.id)
    assert.ok(rows.length >= 2, '应有 publish + context 审计')
    for (const r of rows) {
      assert.equal(r.goalId, g.id, `audit 行 ${r.action} 应带 goalId`)
      assert.equal(r.taskId, g.id)
    }
    // /api/activity?goalId 同款过滤 SQL：目标事件 + 该目标链任务事件都能捞到
    const gFiltered = mod.db.prepare('SELECT DISTINCT action FROM audit WHERE goalId = ? OR (taskId IN (SELECT id FROM tasks WHERE goalId = ?)) ORDER BY action')
      .all(g.id, g.id).map(r => r.action)
    assert.ok(gFiltered.includes('goal:publish') && gFiltered.includes('goal:context'), `per-goal 过滤应含目标事件，实际 ${gFiltered.join(',')}`)
  })

  it('createTask：goalId 显式透传；带 slice 键且无 goalId 时从前缀任务反查回填', () => {
    const g = mod.listGoals('software').find(x => x.objective.includes('目标戊：上下文测试'))
    const chain = mod.db.prepare('SELECT id FROM tasks WHERE goalId = ? AND status != ? ORDER BY id').all(g.id, 'canceled')
    assert.ok(chain.length >= 1, '目标戊应有链任务')
    const td = mod.createTask({
      title: '修复任务（slice 反查）', role: 'coder', scope: 'software', status: 'todo',
      slice: `${chain[0].id}:S1`, sliceIdx: 1, fixOf: 'T-fix-me',
      description: '[auto-goal]\n[fix]\n反查测试',
    })
    assert.equal(td.goalId, g.id, 'slice 前缀任务在库 → 反查回填同一 goalId')
    const fd = mod.createTask({
      title: '显式 goalId 任务', role: 'coder', scope: 'software', status: 'todo', goalId: g.id,
    })
    assert.equal(fd.goalId, g.id)
  })

  it('expandGoalSlices：coder/tester 落 fileDomain + goalId；devops 尾同目标', () => {
    const g = mod.publishGoalRecord('software', '目标庚：切片文件域', 'slice', 'general').goal
    // 直接构造一个带 goalId 的 test-designer done 任务（绕开完整分析前缀链）
    const td = mod.createTask({
      title: '【测试用例设计】切片目标庚', role: 'test-designer', scope: 'software', status: 'todo',
      goalId: g.id, description: '[auto-goal]\n[slice-mode]\n目标：切片目标庚\n本阶段：测试用例设计',
    })
    mod.db.prepare("UPDATE tasks SET status='done', version=version+1, updatedAt=? WHERE id=?").run(new Date().toISOString(), td.id)
    const slices = [
      { title: '切片一：登录', files: ['src/auth.ts', 'src/auth.test.ts'], acceptance: ['注册 201; 密码错 401'] },
      { title: '切片二：资料页', files: ['src/profile.tsx'], acceptance: ['渲染用户信息'] },
    ]
    const r = mod.expandGoalSlices({ testDesignerTaskId: td.id, slices, by: 'general' })
    assert.equal(r.created.length, 5, '2 切片 × (coder+tester) + devops 尾')
    const coder = mod.db.prepare('SELECT * FROM tasks WHERE slice = ? AND role = ?').get(`${td.id}:S1`, 'coder')
    assert.deepEqual(JSON.parse(coder.fileDomain ?? 'null'), ['src/auth.ts', 'src/auth.test.ts'])
    assert.equal(coder.goalId, g.id)
    const tester = mod.db.prepare('SELECT * FROM tasks WHERE slice = ? AND role = ?').get(`${td.id}:S2`, 'tester')
    assert.deepEqual(JSON.parse(tester.fileDomain ?? 'null'), ['src/profile.tsx'])
    assert.equal(tester.goalId, g.id)
    assert.ok(String(tester.description ?? '').includes(`${g.docsDir}/TEST_CASES.md`), '目标化目标的切片测试应指向目标目录的 TEST_CASES.md')
    const devops = mod.db.prepare("SELECT * FROM tasks WHERE role = 'devops' AND slice = ?").get(td.id)
    assert.equal(devops.goalId, g.id)
    assert.equal(devops.fileDomain, null, 'devops 尾无文件域声明（不限制）')
  })

  it('遗留目标（docsDir=null）切片测试仍指向根 docs/TEST_CASES.md；goalDocPathOf 双模式解析', () => {
    // 无 goalId 的 test-designer（模拟本列上线前的遗留链）→ 回退根 docs/TEST_CASES.md
    const td = mod.createTask({
      title: '【测试用例设计】遗留链', role: 'test-designer', scope: 'software', status: 'todo',
      description: '[auto-goal]\n[slice-mode]\n目标：遗留链\n本阶段：测试用例设计',
    })
    mod.db.prepare("UPDATE tasks SET status='done', version=version+1, updatedAt=? WHERE id=?").run(new Date().toISOString(), td.id)
    const slices = [{ title: '切片一：登录', files: ['src/auth.ts'], acceptance: ['注册 201'] }]
    const r = mod.expandGoalSlices({ testDesignerTaskId: td.id, slices, by: 'general' })
    const tester = mod.db.prepare('SELECT * FROM tasks WHERE slice = ? AND role = ?').get(`${td.id}:S1`, 'tester')
    assert.ok(String(tester.description ?? '').includes('docs/TEST_CASES.md'), '遗留链切片测试应指向根 docs/TEST_CASES.md')
    assert.ok(!/docs\/[^/\s]+\/TEST_CASES\.md/.test(String(tester.description ?? '')), '遗留链不得出现目标目录')
    assert.equal(r.created.length, 3, '1 切片 × (coder+tester) + devops 尾')
    // 双模式解析 helper
    const g = mod.listGoals('software').find(x => x.docsDir)
    assert.ok(g, '应有 docsDir 的目标')
    assert.equal(mod.goalDocPathOf(g.id, 'REQUIREMENTS.md'), `${g.docsDir}/REQUIREMENTS.md`)
    assert.equal(mod.goalDocPathOf(g.id, 'docs/REQUIREMENTS.md'), `${g.docsDir}/REQUIREMENTS.md`)
    assert.equal(mod.goalDocPathOf(null, 'REQUIREMENTS.md'), 'docs/REQUIREMENTS.md')
    assert.equal(mod.goalDocPathOf('G-no-such', 'REQUIREMENTS.md'), 'docs/REQUIREMENTS.md', '未知目标回退根 docs/')
    assert.equal(mod.goalDocDirOf('G-no-such'), null)
  })

  it('发布目标自带目标级文档目录 docsDir=docs/<goalId>；老库迁移目标 docsDir=null', async () => {
    const g = mod.publishGoalRecord('software', '目标辛：文档目录', 'chain', 'general').goal
    assert.equal(g.docsDir, `docs/${g.id}`, '新发布目标应分配 docs/<goalId> 文档目录')
    const row = mod.db.prepare('SELECT docsDir FROM goal WHERE id = ?').get(g.id)
    assert.equal(row.docsDir, `docs/${g.id}`)
    // 老库迁移出的目标没有 docsDir（遗留语义 = 根 docs/ 槽位）
    const legacyFile = join(tmpRoot, 'legacy-docsdir.db')
    {
      const legacyDb = new DatabaseSync(legacyFile)
      legacyDb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, scope TEXT, role TEXT)')
      legacyDb.exec('CREATE TABLE goal (scope TEXT PRIMARY KEY, objective TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)')
      legacyDb.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
        .run('software', '遗留目标：无文档目录', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')
      legacyDb.close()
    }
    const prev = process.env.TEAM_HUB_DB
    process.env.TEAM_HUB_DB = legacyFile
    const legacyMod = await import(`./server.mjs?docsdir=${Date.now()}`)
    process.env.TEAM_HUB_DB = prev
    try {
      const lg = legacyMod.listGoals('software')[0]
      assert.equal(lg.docsDir, null, '老库迁移目标 docsDir 应为 null（沿用根 docs/ 槽位）')
    } finally {
      try { legacyMod?.db?.close() } catch { /* 已关闭 */ }
    }
  })
})
