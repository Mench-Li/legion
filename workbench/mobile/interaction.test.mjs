// workbench/mobile/interaction.test.mjs
// 手机端交互决策的判据。守的是三件"只在手机上手才知道"的事：
//   ① 看板是不是**真的**一屏一列、空列不出现、未知状态不丢；
//   ② 横向手势会不会**抢走**纵向滚动/系统返回手势/控件点击；
//   ③ 向上读历史时会不会被新消息拽到底部。
//
// 这些判断原先住在 app.mjs 里 —— 而那个文件在 Node 里 import 就抛（顶层读
// sessionStorage），于是它们**一条都测不了**。这与 outbox / read-cache 抽出去的
// 理由相同：不可测的判断，只能靠人记得去手机上试。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SWIPE_MIN_DX, SWIPE_EDGE_GUARD, SWIPE_AXIS_SLOP, SWIPE_ANIM_MS, READ_BOTTOM_PX,
  UNKNOWN_PAGE_ID, UNKNOWN_PAGE_TITLE, gestureAxis, boardPages, clampPageIndex, decideSwipe,
  pageAnnouncement, distanceToBottom, nearBottom, timelineScrollPlan,
} from './interaction.mjs'
import { BOARD_COLUMNS } from './board.mjs'
import { EN, DYNAMIC_KEYS, t } from './i18n.mjs'

const task = (id, status, extra = {}) => ({ id, status, title: id, ...extra })

// ── 页集合（看板的核心形态）─────────────────────────────────────────────────

test('★ 六列一屏一页，顺序与 BOARD_COLUMNS 逐字一致', () => {
  const tasks = BOARD_COLUMNS.flatMap((c, i) => c.statuses.map((s) => task(`T-${i}-${s}`, s)))
  const pages = boardPages(tasks)
  // canceled 与 done 同列 ⇒ 五页（in_review/blocked/... 都非空）。
  assert.deepEqual(pages.map((p) => p.id), ['blocked', 'in_review', 'in_progress', 'todo', 'backlog', 'done'])
  assert.equal(pages.reduce((n, p) => n + p.count, 0), tasks.length, '任务总数不许丢')
})

test('★★ 空列不生成页（一个空白页会让用户以为滑到了尽头）', () => {
  const pages = boardPages([task('T-1', 'in_review'), task('T-2', 'in_review')])
  assert.deepEqual(pages.map((p) => p.id), ['in_review'])
  assert.equal(pages[0].count, 2)
})

test('★★ 未知状态单独成页，任务与原文都还在', () => {
  const pages = boardPages([task('T-1', 'weird_new_state'), task('T-2', 'todo')])
  assert.deepEqual(pages.map((p) => p.id), ['todo', 'unknown'], '未知状态排在已知列之后（与现有分组一致）')
  const unknown = pages[1]
  assert.equal(unknown.id, UNKNOWN_PAGE_ID)
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.count, 1)
  assert.equal(unknown.tasks[0].status, 'weird_new_state', '原文标注不许被改写')
  assert.ok(unknown.title.length > 0)
})

test('★ 没有任务时没有页（渲染层据此显示"还没有任务"）', () => {
  assert.deepEqual(boardPages([]), [])
  assert.equal(clampPageIndex(3, 0), 0, '没有页时索引落回 0')
})

test('★★ 列变化后页索引被夹取，不会停在空白页', () => {
  assert.equal(clampPageIndex(5, 3), 2)
  assert.equal(clampPageIndex(-2, 3), 0)
  assert.equal(clampPageIndex(1, 3), 1)
  assert.equal(clampPageIndex(NaN, 3), 0)
  assert.equal(clampPageIndex('2', 3), 2)
})

// ── 手势轴锁定 ──────────────────────────────────────────────────────────────

test('★★★ 小位移不判轴（8px 以内还没决定，不许提前切页）', () => {
  assert.equal(gestureAxis({ dx: 0, dy: 0 }), 'undecided')
  assert.equal(gestureAxis({ dx: 5, dy: 6 }), 'undecided')
  assert.equal(gestureAxis({ dx: SWIPE_AXIS_SLOP - 1, dy: 0 }), 'undecided')
})

test('★★★ 纵向优先：纵向占优就彻底不切列（斜滑不许同时滚+翻页）', () => {
  assert.equal(gestureAxis({ dx: 10, dy: 80 }), 'vertical')
  assert.equal(gestureAxis({ dx: 60, dy: 60 }), 'vertical', '平局算纵向：滚动更常见')
  assert.equal(gestureAxis({ dx: 80, dy: 10 }), 'horizontal')
})

// ── 手势提交 ────────────────────────────────────────────────────────────────

const swipe = (o) => decideSwipe({ pageCount: 5, pageIndex: 2, viewportWidth: 390, startX: 200, ...o })

test('★★★ 水平 ≥48px 且水平 ≥1.2×垂直才切页', () => {
  assert.deepEqual(swipe({ dx: -60, dy: 0 }).action, 'next')
  assert.deepEqual(swipe({ dx: 60, dy: 0 }).action, 'prev')
  assert.equal(swipe({ dx: -SWIPE_MIN_DX + 1, dy: 0 }).action, 'none', '差 1px 也不切')
  assert.equal(swipe({ dx: -60, dy: 55 }).action, 'none', '水平占优不够（<1.2×）')
  assert.equal(swipe({ dx: -60, dy: 45 }).action, 'next', '1.2× 之内才算横向')
})

test('★★★ 起点在控件上不接手势（让按钮自己处理点击）', () => {
  const r = swipe({ dx: -120, dy: 0, targetInteractive: true })
  assert.deepEqual(r, { action: 'none', pageIndex: 2, reason: 'interactive' })
})

test('★★★ 屏幕左右边缘 20px 不接手势（系统返回手势优先）', () => {
  for (const startX of [0, 5, SWIPE_EDGE_GUARD - 1, 390 - SWIPE_EDGE_GUARD + 1, 389]) {
    assert.equal(swipe({ dx: -120, dy: 0, startX }).action, 'none', `startX=${startX} 不该接`)
  }
  assert.equal(swipe({ dx: -120, dy: 0, startX: SWIPE_EDGE_GUARD }).action, 'next', '保护带之外要能滑')
})

test('★★ 边界回弹不循环（第一页右滑、最后一页左滑都不动）', () => {
  assert.equal(swipe({ dx: 120, dy: 0, pageIndex: 0 }).action, 'none')
  assert.equal(swipe({ dx: -120, dy: 0, pageIndex: 4 }).action, 'none')
  // 目标页必须是**合法页**。
  assert.equal(swipe({ dx: -120, dy: 0, pageIndex: 3 }).pageIndex, 4)
})

test('★★ 纵向占优/未决/坏输入一律无副作用', () => {
  assert.equal(swipe({ dx: -60, dy: 120 }).action, 'none')
  assert.equal(swipe({ dx: 3, dy: 2 }).action, 'none')
  assert.equal(swipe({ dx: NaN, dy: 0 }).action, 'none')
  assert.equal(swipe({ dx: -120, dy: 0, pageIndex: 99 }).pageIndex, 4, '坏页索引先夹取')
})

test('★ 手势动画时长在需求要求的 180–250ms 内', () => {
  assert.ok(SWIPE_ANIM_MS >= 180 && SWIPE_ANIM_MS <= 250)
})

test('★★ 页码指示是"键 + 变量"，不是拼好的句子（否则永远查不到英文）', () => {
  const a = pageAnnouncement({ index: 1, pageCount: 5, title: '待验收', count: 3 })
  assert.ok(a.key.includes('{index}') && a.key.includes('{pageCount}') && !/\d/.test(a.key))
  assert.deepEqual(a.vars, { index: '2', pageCount: '5', title: '待验收', count: '3' })
  // 页索引越界时按夹取后的值播报（读屏念的必须是屏幕上那一页）。
  assert.equal(pageAnnouncement({ index: 9, pageCount: 2, title: 'x', count: 0 }).vars.index, '2')
})

test('★★★ 这个模块产出的每一条中文，英文表里都查得到', () => {
  // ★ 本模块不在 app.mjs 里，而 i18n 那族判据只扫 app.mjs 的 `t('…')` 字面量 ——
  //   所以一条只在这里产出的 key 漏翻时，不会有任何东西变红。
  const produced = [UNKNOWN_PAGE_TITLE, pageAnnouncement({ index: 0, pageCount: 1, title: 'x', count: 1 }).key]
  for (const s of produced) {
    assert.ok(s.length > 0)
    assert.notEqual(t(s, { index: '1', pageCount: '1', title: 'x', count: '1' }, 'en'), s,
      `英文表里没有 ${JSON.stringify(s)} —— 英文模式下它会原样显示中文`)
  }
  // 显式键与英文表都不许出现重复定义（后一个会静默覆盖前一个）。
  assert.ok(Object.keys(DYNAMIC_KEYS).includes('@newMessages'))
  assert.ok(Object.keys(DYNAMIC_KEYS).includes('@sheetWhere'))
  assert.ok(EN['查看与操作'] !== undefined)
})

// ── 对话阅读位置 ────────────────────────────────────────────────────────────

test('★★★ 距底 >40px 时刷新不跟底；≤40px 时跟底', () => {
  assert.equal(READ_BOTTOM_PX, 40)
  assert.deepEqual(timelineScrollPlan({ scrollTop: 0, scrollHeight: 1000, clientHeight: 600 }), { follow: false, pending: 0 })
  assert.deepEqual(timelineScrollPlan({ scrollTop: 399, scrollHeight: 1000, clientHeight: 600 }), { follow: true, pending: 0 })
  assert.deepEqual(timelineScrollPlan({ scrollTop: 350, scrollHeight: 1000, clientHeight: 600 }), { follow: false, pending: 0 })
})

test('★★ 不在底部时累计"新消息"，回到底部清零', () => {
  assert.deepEqual(timelineScrollPlan({ scrollTop: 0, scrollHeight: 1000, clientHeight: 600, incoming: 3 }),
    { follow: false, pending: 3 })
  // 用户手动滚到底之后再刷新：跟着走、并且清零。
  assert.deepEqual(timelineScrollPlan({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600, incoming: 2 }),
    { follow: true, pending: 0 })
})

test('★★ 发送成功/切 Agent 用 forceFollow 强制到底（这是新内容）', () => {
  assert.deepEqual(timelineScrollPlan({ scrollTop: 0, scrollHeight: 900, clientHeight: 600, forceFollow: true }),
    { follow: true, pending: 0 })
})

test('★ 坏读数不炸：distanceToBottom 认不出来就当"不在底部"', () => {
  assert.equal(distanceToBottom({ scrollTop: 'x', scrollHeight: 100, clientHeight: 50 }), Infinity)
  assert.equal(distanceToBottom({ scrollTop: NaN, scrollHeight: 100, clientHeight: 50 }), Infinity)
  assert.equal(distanceToBottom({ scrollTop: 100, scrollHeight: 100, clientHeight: 50 }), 0, '滚过头夹到 0')
  assert.equal(nearBottom({}), false, '读不到尺寸 ⇒ 不自动跳底（不猜）')
})

test('★ 负的 incoming 不产生负数 pending', () => {
  assert.deepEqual(timelineScrollPlan({ scrollTop: 0, scrollHeight: 1000, clientHeight: 600, incoming: -5 }),
    { follow: false, pending: 0 })
})
