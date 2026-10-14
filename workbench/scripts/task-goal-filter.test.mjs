// workbench/scripts/task-goal-filter.test.mjs
// ============================================================================
// 任务中心「🎯 按目标筛选」：目标这条轴上的判据。
//
// ## 这份用例守的是哪一类错
//
//   · **筛没了**：没有挂目标的任务（手工建的、老库里 goalId 为空的）在筛选器里
//     没有对应的胶囊 ⇒ 一旦用户点了任意一个目标，那些任务就**从看板上消失**，
//     而界面上没有任何东西说"还有一群不在任何目标下的任务"。
//     这与"真的没有任务"长得一模一样。
//   · **数字会跳**：胶囊计数若按"当前筛选后的任务"算，点一个目标，其余胶囊的数字
//     一起变 —— 用户只会以为任务被筛丢了，于是把刚点的那个再点掉。
//   · **判据分叉**：`goalId` 的空值有四种写法（null / undefined / '' / '   '）。
//     组件里各判一遍、手机端再判一遍，两端都不报错，只是各筛各的。
//
// 所以这里既测**行为**（纯函数），也测**接线**（读 TaskCenterView / App 源码）：
// 底层对而没接上，与底层错是同一个结果（上一批 `reject-path.test.mjs` 的教训）。
//
// 运行：node --experimental-strip-types workbench/scripts/task-goal-filter.test.mjs
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NO_GOAL_KEY,
  buildGoalFilter,
  goalFilterKey,
  goalFilterLabel,
  matchesGoalFilter,
  normalizeGoalId,
  shortenObjective,
} from '../src/taskGoalFilter.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8')

/** 剥掉整行注释（与 `no-classic-board.test.mjs` / `reject-path.test.mjs` 同法）。 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const keys = (list) => list.map((o) => o.key)
const byKey = (list, key) => list.find((o) => o.key === key)
/** 取一项，缺了就报清楚（而不是 `undefined.count` 那种看不出所以然的 TypeError）。 */
const pick = (list, key) => {
  const o = byKey(list, key)
  assert.ok(o, `筛选器里没有「${key}」这一项（实际：${keys(list).join('、') || '空'}）`)
  return o
}

describe('goalId 归一化：四种空值是同一件事', () => {
  test('null / undefined / 空串 / 纯空白 ⇒ 都是"没有目标"', () => {
    for (const v of [null, undefined, '', '   ', '\t\n']) {
      assert.equal(normalizeGoalId(v), null, `${JSON.stringify(v)} 应当被认作没有目标`)
      assert.equal(goalFilterKey({ goalId: v }), NO_GOAL_KEY)
    }
  })

  test('★ 两侧空白被剪掉 ⇒ `" G-1 "` 与 `"G-1"` 是同一个目标', () => {
    // 不剪的话，同一条链在筛选器里会裂成两个胶囊（一个带空格、一个不带），
    // 而两个胶囊各自显示一半的任务数。
    assert.equal(normalizeGoalId(' G-1 '), 'G-1')
    assert.equal(goalFilterKey({ goalId: ' G-1 ' }), goalFilterKey({ goalId: 'G-1' }))
  })

  test('非字符串（数字/对象）不猜，一律当作没有目标', () => {
    for (const v of [123, {}, [], true]) assert.equal(normalizeGoalId(v), null)
  })
})

describe('目标胶囊：计数、顺序、边界', () => {
  const TASKS = [
    { id: 'T-1', goalId: 'G-A', status: 'in_progress' },
    { id: 'T-2', goalId: 'G-A', status: 'todo' },
    { id: 'T-3', goalId: 'G-B', status: 'done' },
    { id: 'T-4', goalId: null, status: 'todo' },
    { id: 'T-5', status: 'in_review' }, // goalId 缺字段
    { id: 'T-6', goalId: 'G-C', status: 'canceled' },
  ]
  const GOALS = [
    { id: 'G-A', objective: '手机端任务串空间', status: 'active' },
    { id: 'G-B', objective: '头像黑边', status: 'done' },
    { id: 'G-C', objective: '已取消的目标', status: 'canceled' },
    { id: 'G-D', objective: '还没有任何任务的目标', status: 'active' },
  ]

  test('只列**真的有任务**的目标；空目标不出现', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    assert.deepEqual(keys(opts).sort(), ['G-A', 'G-B', NO_GOAL_KEY].sort())
    assert.equal(byKey(opts, 'G-D'), undefined, 'G-D 一条任务都没有 ⇒ 不该给一个 0 的胶囊')
  })

  test('★ 已取消的任务不进筛选器（与岗位胶囊同一口径）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    assert.equal(byKey(opts, 'G-C'), undefined, '只有已取消任务的目标不进展板，也不进筛选器')
    assert.equal(pick(opts, 'G-A').count, 2)
  })

  test('★ 没有目标的任务在筛选器里有名有姓（不是"不在任何胶囊下"）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    const none = pick(opts, NO_GOAL_KEY)
    assert.equal(none.count, 2, 'goalId:null 与缺字段都算"未挂目标"')
    assert.equal(none.goalId, null)
    assert.equal(none.label, '未挂目标')
  })

  test('★ 各胶囊计数之和 = 未被取消的任务数（一条都不许漏）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    const sum = opts.reduce((a, o) => a + o.count, 0)
    assert.equal(sum, TASKS.filter((t) => t.status !== 'canceled').length)
  })

  test('顺序固定且不随输入顺序变化（点选前后位置不跳）', () => {
    const one = keys(buildGoalFilter(TASKS, GOALS))
    const two = keys(buildGoalFilter([...TASKS].reverse(), [...GOALS].reverse()))
    assert.deepEqual(two, one, '同一批数据换个到达顺序，胶囊顺序必须一样')

    // 进行中 → 已暂停 → 未知 → 已完成 → 未挂目标
    assert.ok(one.indexOf('G-A') < one.indexOf('G-B'), 'active 排在 done 前面')
    assert.equal(one[one.length - 1], NO_GOAL_KEY, '「未挂目标」永远排最后：它不是目标')
  })

  test('同档按任务数降序，再按 id（顺序总是确定的）', () => {
    const opts = buildGoalFilter(
      [
        { goalId: 'G-X', status: 'in_progress' },
        { goalId: 'G-Y', status: 'in_progress' },
        { goalId: 'G-Y', status: 'in_progress' },
        { goalId: 'G-Z', status: 'in_progress' },
        { goalId: 'G-Z', status: 'in_progress' },
      ],
      [
        { id: 'G-X', status: 'active' }, { id: 'G-Y', status: 'active' }, { id: 'G-Z', status: 'active' },
      ],
    )
    assert.deepEqual(keys(opts), ['G-Y', 'G-Z', 'G-X'], '两个的排前面（Y 与 Z 同数按 id），一个的最后')
  })

  test('读不到目标记录 ⇒ 只显示 id，**不猜**文案（「全部空间」模式的降级）', () => {
    const opts = buildGoalFilter([{ goalId: 'G-A', status: 'todo' }], [])
    const o = pick(opts, 'G-A')
    assert.equal(o.label, 'G-A')
    assert.equal(o.status, null, '读不到状态就不报状态')
    assert.match(o.title, /未读到目标文案/)
  })

  test('文案压成一行并截断；悬停里保留完整文案与目标 id', () => {
    const long = '第一行\n第二行'.repeat(8)
    const opts = buildGoalFilter([{ goalId: 'G-A', status: 'todo' }], [{ id: 'G-A', objective: long, status: 'active' }])
    const o = pick(opts, 'G-A')
    assert.ok(o.label.length <= 19, `胶囊文案要截断，实际 ${o.label.length} 字`)
    assert.ok(!o.label.includes('\n'), '胶囊是单行控件：换行要压掉')
    assert.ok(o.title.includes(long), '悬停里要能看到完整文案')
    assert.ok(o.title.includes('G-A'), '悬停里要有目标 id（卡片上的徽标就是 id）')
  })

  test('空/null 输入不炸', () => {
    assert.deepEqual(buildGoalFilter([], []), [])
    assert.deepEqual(buildGoalFilter(null, null), [])
    assert.deepEqual(buildGoalFilter(undefined), [])
  })
})

describe('筛选本身', () => {
  test('选中一个目标 ⇒ 只留这个目标的任务', () => {
    assert.equal(matchesGoalFilter({ goalId: 'G-A' }, 'G-A'), true)
    assert.equal(matchesGoalFilter({ goalId: 'G-B' }, 'G-A'), false)
    assert.equal(matchesGoalFilter({ goalId: null }, 'G-A'), false)
    assert.equal(matchesGoalFilter({ goalId: ' G-A ' }, 'G-A'), true, '归一化后再比')
  })

  test('选「未挂目标」⇒ 只留没有目标的任务', () => {
    for (const t of [{ goalId: null }, { goalId: '' }, { goalId: '   ' }, {}]) {
      assert.equal(matchesGoalFilter(t, NO_GOAL_KEY), true)
    }
    assert.equal(matchesGoalFilter({ goalId: 'G-A' }, NO_GOAL_KEY), false)
  })

  test('没有筛选 ⇒ 一条都不筛（空键 = 全部）', () => {
    for (const key of [null, undefined, '']) {
      assert.equal(matchesGoalFilter({ goalId: 'G-A' }, key), true)
      assert.equal(matchesGoalFilter({ goalId: null }, key), true)
      assert.equal(matchesGoalFilter(null, key), true)
    }
  })

  test('界面说法：没有筛选为 null，筛着但胶囊读不到时回落到键本身', () => {
    const opts = buildGoalFilter([{ goalId: 'G-A', status: 'todo' }], [{ id: 'G-A', objective: '甲目标' }])
    assert.equal(goalFilterLabel(opts, null), null)
    assert.equal(goalFilterLabel(opts, 'G-A'), '甲目标')
    assert.equal(goalFilterLabel(opts, 'G-没了'), 'G-没了', '★ 筛着的条件不许在文案里消失')
  })

  test('shortenObjective：空白压成一行、超长截断、空文案给空串', () => {
    assert.equal(shortenObjective('  a\nb  '), 'a b')
    assert.equal(shortenObjective(''), '')
    assert.equal(shortenObjective(null), '')
    assert.equal(shortenObjective('一二三四五', 3), '一二三…')
  })
})

describe('接线：任务中心真的挂上了这条轴', () => {
  const view = codeOnly(read('src/components/TaskCenterView.tsx'))
  const app = codeOnly(read('src/App.tsx'))

  test('★ 判据在纯函数里：组件用 buildGoalFilter / matchesGoalFilter，自己不判 goalId', () => {
    assert.match(view, /buildGoalFilter\(rows \?\? \[\], goals\)/, '胶囊要用纯函数生成')
    assert.match(view, /matchesGoalFilter\(r, goalFilter\)/, '筛选要用同一个判据')
    assert.doesNotMatch(view, /NO_GOAL_KEY|__no_goal__/, '★ 哨兵只许留在 taskGoalFilter.ts 里，组件不许自己拼')
  })

  test('★ 计数取全量 rows（不是 filtered）：点选前后数字与位置都不跳', () => {
    assert.doesNotMatch(view, /buildGoalFilter\(filtered/, '★ 用筛选后的任务算计数 ⇒ 点一下其余胶囊的数字全变')
  })

  test('过滤条有「全部」与「目标」标题，且点选能取消', () => {
    assert.match(view, /🎯 目标/, '过滤条要能认出这是目标那条轴')
    assert.match(view, /setGoalFilter\(/)
    assert.match(view, /tc-pill-goal/)
    assert.match(view, /🎯/, '目标胶囊沿用卡片上的 🎯 记号')
  })

  test('★ 「清除过滤」把目标也一起清掉（不然它看起来清了、其实还筛着）', () => {
    const clear = /setQuery\(''\); setRoleFilter\(null\); setGoalFilter\(null\)/.exec(view)
    assert.ok(clear, '清除过滤必须同时清空 搜索 + 岗位 + 目标')
  })

  test('筛成空时说得清是哪一条轴筛空的', () => {
    assert.match(view, /没有符合当前条件的任务/)
    assert.match(view, /目标：\$\{goalFilterWording/, '空态要念出当前筛着的目标')
  })

  test('★ 目标文案来自上层：App 把 goals 交给 TaskCenterView', () => {
    // 「读不到就只显示 id」是允许的降级，所以这条守的是**接线**：
    // 上层明明有目标记录（/api/goal）却没传下去，胶囊就永远只有 id。
    assert.match(app, /goals=\{hubMode \? \(goalInfo\?\.goals \?\? \[\]\) : \[\]\}/)
    assert.match(read('src/components/TaskCenterView.tsx'), /goals\?: HubGoal\[\]/)
  })
})
