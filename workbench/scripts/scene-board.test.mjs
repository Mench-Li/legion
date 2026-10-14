// workbench/scripts/scene-board.test.mjs
// 办公室看板与气泡的**契约判据**：状态颜色齐全、看板列不漏状态、气泡气色取"最要紧那件事"、
// 以及"谁该去走一趟看板"的派生（认领/完结各自必须同时成立的那几条）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_COLUMNS, BOARD_VISIT_MS, MOOD_STYLE, SCENE_HIDDEN_STATUSES, STATUS_BAR_COLOR, STATUS_STYLE,
  boardColumnFor, boardHeadline, byStaff, columnCounter, deriveBoardVisits, groupTasksByColumn,
  isTaskVisibleInScene, moodFor, visibleSceneTasks,
} from '../src/scene/sceneBoard.ts'

const ALL_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']

test('① 每个任务状态都有颜色与中文名（新增状态时这条先红，颜色不许缺）', () => {
  for (const status of ALL_STATUSES) {
    const style = STATUS_STYLE[status]
    assert.ok(style, `${status} 没有配色 —— 气泡/卡片会渲染成透明`)
    assert.match(style.color, /^#[0-9a-f]{6}$/i, `${status} 的颜色必须是 #rrggbb`)
    assert.ok(style.label.length > 0, `${status} 要有中文名`)
  }
  // 反过来：表里不许有枚举外的键（拼错的状态名会静默变成"永不命中"）
  assert.deepEqual(Object.keys(STATUS_STYLE).sort(), [...ALL_STATUSES].sort())
})

test('② 要显示的状态**恰好**落在一列里；隐藏状态一个都不落（不漏、不重）', () => {
  const seen = new Map()
  for (const column of BOARD_COLUMNS) {
    for (const status of column.statuses) {
      const hit = seen.get(status)
      assert.equal(hit, undefined, `${status} 同时落在 ${hit} 与 ${column.key} —— 卡片会被画两遍`)
      seen.set(status, column.key)
    }
  }
  for (const status of ALL_STATUSES) {
    if (SCENE_HIDDEN_STATUSES.includes(status)) {
      assert.equal(boardColumnFor(status), null, `${status} 被隐藏了，就不该有任何列收它`)
      continue
    }
    assert.ok(seen.has(status), `${status} 没有归属的列 —— 这类任务的卡片会凭空消失`)
  }
  // ★ 这份名单 + 各列状态 = 全部状态，不多不少：新增状态时这条会先红，
  //   逼你明确决定"它进不进场景"（而不是让它静默消失）
  const covered = [...new Set([...seen.keys(), ...SCENE_HIDDEN_STATUSES])].sort()
  assert.deepEqual(covered, [...ALL_STATUSES].sort(), '有状态既不在列里、也不在隐藏名单里（或反之）')
  // 列的 key 与顺序稳定（从左到右就是任务推进顺序）——**完成列已按需求移除**
  assert.deepEqual(BOARD_COLUMNS.map(column => column.key), ['todo', 'in_progress', 'in_review', 'blocked'])
  assert.ok(!BOARD_COLUMNS.some(column => column.key === 'done'), '已完成不再单独占一列')
})

test('★★★ 已完成与已取消都**不进场景**（将军：已完成的就不要显示了）', () => {
  // 这条是需求（2026-10-14），不是实现细节：场景显示的是"现在有什么要办"，
  // 完成的任务是历史 —— 它会平白占掉一排位置，把真正在动的列挤窄。
  assert.deepEqual([...SCENE_HIDDEN_STATUSES].sort(), ['canceled', 'done'])
  assert.equal(isTaskVisibleInScene('done'), false)
  assert.equal(isTaskVisibleInScene('canceled'), false)
  for (const status of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked']) {
    assert.equal(isTaskVisibleInScene(status), true, `${status} 是在办的任务，必须显示`)
  }
  // 过滤函数对"任何带 status 的东西"都成立（HubTask 与 chip 共用一条路）
  const tasks = [
    { id: 'T-1', title: 'a', status: 'todo' },
    { id: 'T-2', title: 'b', status: 'done' },
    { id: 'T-3', title: 'c', status: 'canceled' },
    { id: 'T-4', title: 'd', status: 'in_progress' },
  ]
  assert.deepEqual(visibleSceneTasks(tasks).map(task => task.id), ['T-1', 'T-4'])
})

test('③ 分列：已完成与已取消都不上板、同列内按 id 稳定排序（刷新不许让卡片换位置）', () => {
  const tasks = [
    { id: 'T-3', title: 'c', status: 'done' },
    { id: 'T-1', title: 'a', status: 'todo' },
    { id: 'T-9', title: 'x', status: 'canceled' },
    { id: 'T-2', title: 'b', status: 'backlog' },
    { id: 'T-4', title: 'd', status: 'blocked' },
  ]
  const grouped = groupTasksByColumn(tasks)
  assert.deepEqual(grouped.get('todo').map(task => task.id), ['T-1', 'T-2'], 'backlog 与 todo 合成"待办"列，且按 id 排')
  assert.deepEqual(grouped.get('blocked').map(task => task.id), ['T-4'])
  assert.equal(grouped.has('done'), false, '完成列已被移除（将军：已完成的就不要显示了）')
  assert.equal([...grouped.values()].flat().length, 3, 'done 与 canceled 都不许出现在任何列里')
  assert.deepEqual(groupTasksByColumn(tasks).get('todo').map(t => t.id), ['T-1', 'T-2'], '两次分组结果一致（稳定）')
})

test('④ 列计数：空空间写"空"，不写 0/0', () => {
  assert.equal(columnCounter([], 0), '空')
  assert.equal(columnCounter([{ id: 'a', title: 'a', status: 'todo' }], 5), '1/5')
  assert.equal(columnCounter([], 5), '0/5', '有任务但这个 Agent 这列是空的 ⇒ 照实写 0')
})

test('⑤ 气泡气色取"最要紧那件事"：受阻 > 待验收 > 进行中 > 待命', () => {
  const of = (...statuses) => moodFor(statuses.map((status, i) => ({ id: `T-${i}`, title: 't', status })))
  assert.equal(of(), 'idle')
  assert.equal(of('todo', 'backlog'), 'idle')
  assert.equal(of('in_progress', 'todo'), 'busy')
  assert.equal(of('in_review', 'in_progress'), 'review')
  assert.equal(of('blocked', 'in_review', 'in_progress'), 'blocked')
  assert.equal(of('done', 'blocked'), 'blocked', '做完一堆也盖不住一条受阻')
  // 气色的颜色必须与任务状态的颜色**同源**（同一个人头顶与板上卡片不许两种颜色）
  assert.equal(MOOD_STYLE.busy.color, STATUS_STYLE.in_progress.color)
  assert.equal(MOOD_STYLE.review.color, STATUS_STYLE.in_review.color)
  assert.equal(MOOD_STYLE.blocked.color, STATUS_STYLE.blocked.color)
  assert.equal(MOOD_STYLE.idle.color, STATUS_STYLE.todo.color)
  assert.deepEqual(Object.keys(MOOD_STYLE).sort(), ['blocked', 'busy', 'idle', 'review'])
})

// ── 走看板的派生 ────────────────────────────────────────────────────────────
const TS = new Date(1000).toISOString()
const roster = [{ role: 'dev', name: 'dev', scope: 'lab', external: false, avatar: '🤖' }]
const rosterRunner = [roster[0], { role: 'runner', name: 'runner', scope: 'lab', external: true, avatar: '🤖' }]
const task = (id, status, extra = {}) => ({ id, title: `任务 ${id}`, role: 'dev', soldier: 'dev', status, scope: 'lab', blockedBy: [], goalId: null, ...extra })
const ev = (seq, taskId, action, payload = {}) => ({ seq, taskId, action, scope: 'lab', ts: TS, payload })
const facts = (tasks, list = roster) => ({ scope: 'lab', roster: list, tasks })

test('⑥ 认领 ⇒ 去取卡；完结 ⇒ 去贴卡（两条各自成立）', () => {
  const claim = deriveBoardVisits(facts([task('T-1', 'todo')]), facts([task('T-1', 'in_progress')]), [ev(7, 'T-1', 'claim', { soldier: 'dev' })], 1500, true)
  assert.equal(claim.length, 1)
  assert.equal(claim[0].kind, 'claim')
  assert.equal(claim[0].role, 'dev')
  assert.equal(claim[0].taskId, 'T-1')
  assert.equal(claim[0].title, '任务 T-1', '卡片要带标题，否则人走到板前不知道取哪张')
  assert.equal(claim[0].status, 'in_progress', '取卡时卡片已进"进行中"列')
  assert.equal(claim[0].expiresAtMs, 1500 + BOARD_VISIT_MS, '有效期 = 动画总时长（同一个常量）')
  assert.equal(claim[0].id, '7:T-1:claim')

  const done = deriveBoardVisits(facts([task('T-2', 'in_progress')]), facts([task('T-2', 'done')]), [ev(8, 'T-2', 'advance')], 1500, true)
  assert.equal(done.length, 1)
  assert.equal(done[0].kind, 'complete')
  assert.equal(done[0].status, 'done')
  const transition = deriveBoardVisits(facts([task('T-3', 'in_review')]), facts([task('T-3', 'done')]), [ev(9, 'T-3', 'transition', { to: 'done' })], 1500, true)
  assert.equal(transition[0].kind, 'complete', 'transition→done 也算完结')
})

test('⑦ 认领的四条闸门缺一不可（否则会演出假的：改派/重复认领/机器人自言自语）', () => {
  const before = facts([task('T-1', 'todo')])
  const after = facts([task('T-1', 'in_progress')])
  const base = [ev(7, 'T-1', 'claim', { soldier: 'dev' })]
  assert.equal(deriveBoardVisits(before, after, base, 1500, true).length, 1)
  assert.equal(deriveBoardVisits(before, after, [ev(7, 'T-1', 'claim', { soldier: 'other' })], 1500, true).length, 0, '认领人不是他 ⇒ 不该他去')
  assert.equal(deriveBoardVisits(facts([task('T-1', 'in_progress')]), after, base, 1500, true).length, 0, '本来就是进行中 ⇒ 不是"这一刻认领"')
  assert.equal(deriveBoardVisits(before, facts([task('T-1', 'in_review')]), base, 1500, true).length, 0, '没进进行中 ⇒ 不是认领')
  assert.equal(deriveBoardVisits(before, after, [ev(7, 'T-1', 'transition', { soldier: 'dev' })], 1500, true).length, 0, '别的动作不触发取卡')
})

test('⑧ 完结的两条闸门：之前不是 done、这一刻是 done；其余动作不触发', () => {
  const before = facts([task('T-1', 'in_progress')])
  const after = facts([task('T-1', 'done')])
  assert.equal(deriveBoardVisits(before, after, [ev(8, 'T-1', 'advance')], 1500, true).length, 1)
  assert.equal(deriveBoardVisits(facts([task('T-1', 'done')]), after, [ev(8, 'T-1', 'advance')], 1500, true).length, 0, '早就 done ⇒ 不重演')
  assert.equal(deriveBoardVisits(before, after, [ev(8, 'T-1', 'transition', { to: 'in_review' })], 1500, true).length, 0, '不是转 done')
  assert.equal(deriveBoardVisits(before, after, [ev(8, 'T-1', 'cancel')], 1500, true).length, 0, '取消不是完结')
  assert.equal(deriveBoardVisits(before, facts([task('T-1', 'canceled')]), [ev(8, 'T-1', 'advance')], 1500, true).length, 0)
})

test('⑨ 时间窗与可见性：陈旧事件不许重演，看不见时零出站，没上一条快照就什么都不演', () => {
  const before = facts([task('T-1', 'in_progress')])
  const after = facts([task('T-1', 'done')])
  const e = [ev(8, 'T-1', 'advance')]
  assert.equal(deriveBoardVisits(before, after, e, 1500, true).length, 1)
  assert.equal(deriveBoardVisits(before, after, e, 9001, true).length, 0, '超过 8 秒的历史事件 ⇒ 重连补数据不许把旧事重演一遍')
  assert.equal(deriveBoardVisits(before, after, [{ ...e[0], ts: new Date(9000).toISOString() }], 1500, true).length, 0, '未来 1 秒以后的事件 ⇒ 时钟漂移下的假事件')
  assert.equal(deriveBoardVisits(before, after, e, 1500, false).length, 0, '页面不可见 ⇒ 不演')
  assert.equal(deriveBoardVisits(null, after, e, 1500, true).length, 0, '第一条快照没有"之前"可比 ⇒ 不演')
  assert.equal(deriveBoardVisits(before, { ...after, scope: 'other' }, e, 1500, true).length, 0, '换空间 ⇒ 不演')
  assert.equal(deriveBoardVisits(before, after, [{ ...e[0], scope: 'other' }], 1500, true).length, 0, '别的空间的事件 ⇒ 不演')
})

test('⑩ 归属算不出来 ⇒ 没人去；未入编执行者按 soldier 去；一次事件最多一条', () => {
  const before = facts([task('T-1', 'todo')])
  const after = facts([task('T-1', 'in_progress')])
  const e = [ev(7, 'T-1', 'claim', { soldier: 'dev' })]
  assert.equal(deriveBoardVisits(before, after, e, 1500, true).length, 1)
  assert.equal(deriveBoardVisits(before, facts([task('T-1', 'in_progress')], []), e, 1500, true).length, 0, 'roster 里没有他 ⇒ 归不到人，谁都不许去')
  const external = task('T-2', 'in_progress', { role: 'someone-else', soldier: 'runner' })
  const extBefore = facts([{ ...external, status: 'todo' }], rosterRunner)
  const extAfter = facts([external], rosterRunner)
  const ext = deriveBoardVisits(extBefore, extAfter, [ev(11, 'T-2', 'claim', { soldier: 'runner' })], 1500, true)
  assert.equal(ext.length, 1)
  assert.equal(ext[0].role, 'runner', '未入编执行者按 soldier 归属')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑪ 将军 2026-10-14 的三条：
//    · 「任务看板 0项统计可以固定在场景顶部，不随场景旋转」
//    · 「看板放大，可以标注具体的任务编号」
//    · 「下方编队，进行中的提示可以随员工固定并收缩」
// ══════════════════════════════════════════════════════════════════════════

test('⑪★ 按员工汇总：口径与看板/气泡同源，未认领的不进任何员工行', () => {
  const staffRoster = [{ role: 'dev', name: '开发' }, { role: 'qa', name: '测试' }]
  const cards = [
    { id: 'T-1', title: 'a', status: 'in_progress', role: 'dev' },
    { id: 'T-2', title: 'b', status: 'blocked', role: 'dev' },
    { id: 'T-3', title: 'c', status: 'in_review', role: 'qa' },
    { id: 'T-4', title: 'd', status: 'todo', role: null },   // 未认领
  ]
  const rows = byStaff(cards, staffRoster)
  assert.deepEqual(rows.map(row => row.role), ['dev', 'qa'], '受阻的排前面（最需要人管）')
  const dev = rows.find(row => row.role === 'dev')
  assert.equal(dev.name, '开发', '显示名取自 roster，不显示岗位 key')
  assert.equal(dev.total, 2)
  assert.equal(dev.blocked, 1)
  assert.equal(dev.mood, 'blocked', '气色用同一个 moodFor')
  const qa = rows.find(row => row.role === 'qa')
  assert.equal(qa.total, 1)
  assert.equal(qa.blocked, 0)
  assert.equal(qa.mood, 'review', '待验收 ⇒ 蓝色之外的那一档')
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 3, '未认领的那件不许被塞给任何人')
  // 计数总和必须等于"看板上的卡片数减去未认领"
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), cards.filter(card => card.role !== null).length)
  assert.deepEqual(byStaff([], staffRoster), [], '没有在办任务 ⇒ 没有任何员工行')
})

test('⑪★ 顶部统计条的口径：没有任务时给一句"暂无"，而不是一串 0', () => {
  assert.equal(boardHeadline({ total: 0, staff: 0, blocked: 0, busiest: null }), '任务看板 · 暂无在办任务')
  assert.equal(boardHeadline({ total: 3, staff: 2, blocked: 0, busiest: { name: '开发', total: 2 } }),
    '任务看板 · 在办 3 项 · 员工 2 人 · 最多 开发 2 项', '没有受阻就不提受阻')
  assert.equal(boardHeadline({ total: 3, staff: 2, blocked: 1, busiest: null }),
    '任务看板 · 在办 3 项 · 员工 2 人 · 受阻 1', '有受阻必须报出来')
  // 条色必须与状态色同源（同一份颜色契约，不许另起一套）
  assert.equal(STATUS_BAR_COLOR.in_progress, STATUS_STYLE.in_progress.color)
  assert.equal(STATUS_BAR_COLOR.blocked, STATUS_STYLE.blocked.color)
  assert.deepEqual(Object.keys(STATUS_BAR_COLOR).sort(), ['blocked', 'in_progress', 'in_review', 'todo'])
})

test('⑪★ 分组要把归属人带出去（泛型不许把 role 削掉）', () => {
  const cards = [{ id: 'T-9', title: 'x', status: 'todo', role: 'coder' }]
  const grouped = groupTasksByColumn(cards)
  assert.equal(grouped.get('todo')[0].role, 'coder', '看板卡片上的归属人不能被分组丢在半路')
})
