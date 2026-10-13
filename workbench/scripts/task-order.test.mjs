// workbench/scripts/task-order.test.mjs — 任务中心/看板的展示顺序：**最新的在最上面**。
// 运行：node --experimental-strip-types workbench/scripts/task-order.test.mjs
//
// ## 这份用例守的是哪次事故
//
// 泳道原来按**任务号升序**排（`normId(a.id, b.id)`）。这在"号随时间递增"的世界里
// 看起来等价于按时间排 —— 直到有人**重做**了一条老任务：
//
//   T-199 是 10-10 建的单、**10-12 才重做完成**，号却比更早完成的 T-200..T-202 小。
//   按号排 ⇒ 真正最新完成的那条被压在三条更早的**上面**，而最新的沉在下面。
//   用户的原话：**「尤其是已完成，任务很多，但是最新完成的在最底下」**。
//
//   > 一个"任务号越大就越新"的假设，与一个"任务会被重做"的事实，
//   > 在**没有重做发生**的时候是同一个读数 ——
//   > 而重做这条路是**同一天**刚打开的。
//
// 所以第一条用例直接用**真实的 T-199/T-200..T-202 数据**复现那个错序。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareByMostRecent,
  compareTaskId,
  sortByMostRecent,
  taskTimeMs,
} from '../src/taskOrder.ts'
import { boardColumns, compareByMostRecent as mobileCompare, sortByMostRecent as mobileSort, taskTimeMs as mobileTimeMs } from '../mobile/board.mjs'

const ids = (list) => list.map((t) => t.id)

describe('任务顺序：最新在前', () => {
  test('★ 真实事故复现：重做过的 T-199 必须排在更早完成的 T-200/T-201/T-202 之前', () => {
    // 时间取自 live team.db 的真实读数
    const real = [
      { id: 'T-195', updatedAt: '2026-10-10T09:08:45.197Z' },
      { id: 'T-196', updatedAt: '2026-10-10T09:26:41.823Z' },
      { id: 'T-197', updatedAt: '2026-10-10T09:36:51.850Z' },
      { id: 'T-198', updatedAt: '2026-10-10T09:46:45.853Z' },
      { id: 'T-199', updatedAt: '2026-10-12T10:33:42.041Z' }, // ← 10-12 重做完成
      { id: 'T-200', updatedAt: '2026-10-10T10:30:32.077Z' },
      { id: 'T-201', updatedAt: '2026-10-10T11:40:56.012Z' },
      { id: 'T-202', updatedAt: '2026-10-10T13:07:17.649Z' },
    ].reverse() // 故意乱序传入，证明排序真的发生了（不是靠入参顺序）

    const got = ids(sortByMostRecent(real))
    assert.equal(got[0], 'T-199', '★ 最新完成的那条必须排第一（按号排时它排第 5）')
    assert.equal(got[1], 'T-202', '其次是 10-10 里最晚的')
    assert.deepEqual(got, ['T-199', 'T-202', 'T-201', 'T-200', 'T-198', 'T-197', 'T-196', 'T-195'])

    // 把"按号排会得到什么"写下来，让这条用例自证它防的是什么
    const byId = [...real].sort((a, b) => compareTaskId(a.id, b.id))
    assert.equal(ids(byId)[4], 'T-199', '按号升序时 T-199 在第 5 位 —— 这就是当初的错序')
  })

  test('新的在前（基本方向）', () => {
    const list = [
      { id: 'T-1', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'T-2', updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'T-3', updatedAt: '2026-02-01T00:00:00Z' },
    ]
    assert.deepEqual(ids(sortByMostRecent(list)), ['T-2', 'T-3', 'T-1'])
  })

  test('时间字段的优先级：updatedAt → createdAt → claimedAt', () => {
    // updatedAt 优先
    assert.equal(taskTimeMs({ id: 'T-1', updatedAt: '2026-05-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
      Date.parse('2026-05-01T00:00:00Z'))
    // 缺 updatedAt ⇒ 退到 createdAt
    assert.equal(taskTimeMs({ id: 'T-1', createdAt: '2026-01-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z'))
    // 两者都缺 ⇒ 退到 claimedAt
    assert.equal(taskTimeMs({ id: 'T-1', claimedAt: '2026-02-01T00:00:00Z' }), Date.parse('2026-02-01T00:00:00Z'))
  })

  test('★ 没有任何可用时间 ⇒ null（**不是 0**）', () => {
    // 返回 0 会被当成"1970 年"，把"不知道时间"悄悄说成"很旧"。两者必须分得开。
    for (const t of [{ id: 'T-1' }, { id: 'T-1', updatedAt: null }, { id: 'T-1', updatedAt: '' }, null, undefined]) {
      assert.equal(taskTimeMs(t), null, '无可用时间必须是 null：' + JSON.stringify(t))
    }
  })

  test('坏掉的时间串不炸，也不会被当成有效时间', () => {
    assert.equal(taskTimeMs({ id: 'T-1', updatedAt: '昨天' }), null)
    assert.equal(taskTimeMs({ id: 'T-1', updatedAt: '2026-13-45' }), null)
    // 坏串时继续往下找下一个字段
    assert.equal(taskTimeMs({ id: 'T-1', updatedAt: 'garbage', createdAt: '2026-01-01T00:00:00Z' }),
      Date.parse('2026-01-01T00:00:00Z'))
    // 坏串与缺字段混在一起时，整列仍然排得出来
    const list = [{ id: 'T-1', updatedAt: 'garbage' }, { id: 'T-2', updatedAt: '2026-01-01T00:00:00Z' }]
    assert.deepEqual(ids(sortByMostRecent(list)), ['T-2', 'T-1'])
  })

  test('有时间的一律排在"不知道时间"的前面（不靠 1970 兜底）', () => {
    const list = [
      { id: 'T-1' },
      { id: 'T-2', updatedAt: '1999-01-01T00:00:00Z' }, // 很旧，但**知道**时间
    ]
    assert.deepEqual(ids(sortByMostRecent(list)), ['T-2', 'T-1'])
  })

  test('平局与无时间都用**任务号降序**兜底 ⇒ 顺序总是确定的', () => {
    const same = '2026-01-01T00:00:00Z'
    assert.deepEqual(ids(sortByMostRecent([
      { id: 'T-2', updatedAt: same }, { id: 'T-10', updatedAt: same }, { id: 'T-9', updatedAt: same },
    ])), ['T-10', 'T-9', 'T-2'], '同一时刻按号降序，且号要数字感知（T-10 > T-9）')
    assert.deepEqual(ids(sortByMostRecent([{ id: 'T-2' }, { id: 'T-10' }, { id: 'T-9' }])),
      ['T-10', 'T-9', 'T-2'], '全都没有时间时同样确定')
  })

  test('任务号比较是数字感知的（T-9 < T-10，不是字典序）', () => {
    assert.ok(compareTaskId('T-9', 'T-10') < 0)
    assert.ok(compareTaskId('T-100', 'T-99') > 0)
  })

  test('★ 不改原数组（调用方可能还在用它的顺序）', () => {
    const list = [{ id: 'T-1', updatedAt: '2026-01-01T00:00:00Z' }, { id: 'T-2', updatedAt: '2026-02-01T00:00:00Z' }]
    const snapshot = ids(list)
    const out = sortByMostRecent(list)
    assert.notEqual(out, list, '必须返回新数组')
    assert.deepEqual(ids(list), snapshot, '原数组顺序不许被改')
    assert.deepEqual(ids(out), ['T-2', 'T-1'])
  })

  test('空/null 输入不炸', () => {
    assert.deepEqual(sortByMostRecent([]), [])
    assert.deepEqual(sortByMostRecent(null), [])
    assert.deepEqual(sortByMostRecent(undefined), [])
  })
})

describe('两端一致（桌面 taskOrder.ts ↔ 手机 board.mjs）', () => {
  /** 同一个 fixture 喂给两端，必须排出**同一个序**。 */
  const FIXTURE = [
    { id: 'T-199', updatedAt: '2026-10-12T10:33:42.041Z' },
    { id: 'T-202', updatedAt: '2026-10-10T13:07:17.649Z' },
    { id: 'T-9', updatedAt: '2026-10-10T13:07:17.649Z' },   // 与 T-202 平局
    { id: 'T-10' },                                          // 无时间
    { id: 'T-100', updatedAt: 'garbage', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'T-2', claimedAt: '2026-08-01T00:00:00Z' },
    { id: 'T-3', updatedAt: '' },
  ]

  test('★ 同一个 fixture 两端排出同一个序', () => {
    assert.deepEqual(ids(mobileSort(FIXTURE)), ids(sortByMostRecent(FIXTURE)))
  })

  test('两端的 taskTimeMs 与比较器逐项一致', () => {
    for (const t of FIXTURE) assert.equal(mobileTimeMs(t), taskTimeMs(t), '时间读数不一致：' + t.id)
    for (const a of FIXTURE) {
      for (const b of FIXTURE) {
        const d = compareByMostRecent(a, b)
        const m = mobileCompare(a, b)
        assert.equal(Math.sign(m), Math.sign(d), `比较器方向不一致：${a.id} vs ${b.id}（桌面 ${d} / 手机 ${m}）`)
      }
    }
  })
})

describe('看板分列时的顺序', () => {
  test('★ 每一列内部都按时间倒序（手机端 boardColumns）', () => {
    const r = boardColumns([
      { id: 'T-1', status: 'done', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'T-3', status: 'done', updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'T-2', status: 'done', updatedAt: '2026-02-01T00:00:00Z' },
      { id: 'T-11', status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'T-12', status: 'in_progress', updatedAt: '2026-05-01T00:00:00Z' },
    ])
    const col = (id) => r.columns.find((c) => c.id === id)
    assert.deepEqual(ids(col('done').tasks), ['T-3', 'T-2', 'T-1'], '已完成列：最新完成的在最上面')
    assert.deepEqual(ids(col('in_progress').tasks), ['T-12', 'T-11'])
  })

  test('canceled 与 done 同列，也一起按时间排（终态混排不破坏顺序）', () => {
    const r = boardColumns([
      { id: 'T-1', status: 'canceled', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'T-2', status: 'done', updatedAt: '2026-06-01T00:00:00Z' },
    ])
    assert.deepEqual(ids(r.columns.find((c) => c.id === 'done').tasks), ['T-2', 'T-1'])
  })

  test('boardColumns 不改入参顺序（排序发生在内部的新数组上）', () => {
    const input = [
      { id: 'T-1', status: 'done', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'T-2', status: 'done', updatedAt: '2026-02-01T00:00:00Z' },
    ]
    const snapshot = ids(input)
    boardColumns(input)
    assert.deepEqual(ids(input), snapshot, '入参顺序不许被改')
  })
})
