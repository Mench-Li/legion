// workbench/scripts/task-goal-filter.test.mjs
// ============================================================================
// 任务中心「🎯 按目标筛选」：目标这条轴上的判据。
//
// ## 这份用例守的是哪一类错
//
//   · **筛没了**：没有挂目标的任务（手工建的、老库里 goalId 为空的）在筛选器里
//     没有对应的项 ⇒ 一旦用户选了任意一个目标，那些任务就**从看板上消失**，
//     而界面上没有任何东西说"还有一群不在任何目标下的任务"。
//     这与"真的没有任务"长得一模一样。
//   · **数字会跳**：计数若按"当前筛选后的任务"算，选一个目标，其余项的数字
//     一起变 —— 用户只会以为任务被筛丢了，于是把刚选的那个再取消掉。
//   · **判据分叉**：`goalId` 的空值有四种写法（null / undefined / '' / '   '）。
//     组件里各判一遍、手机端再判一遍，两端都不报错，只是各筛各的。
//   · 「搜不到」与「没有这个目标」：目标是长句，用户记得的是其中几个字、且常常**不连续**
//     （输「手机空间」找「手机端任务串空间」）。只做子串匹配的话这种输入回空列表，
//     而空列表与"没有这个目标"长得一样 —— 所以模糊匹配必须**真的**在跑，且有判据。
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
  fuzzyScore,
  goalFilterKey,
  goalFilterLabel,
  hasRealGoal,
  matchesGoalFilter,
  normalizeGoalId,
  rankGoalOptions,
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

describe('目标选项：计数、顺序、边界', () => {
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
    assert.equal(byKey(opts, 'G-D'), undefined, 'G-D 一条任务都没有 ⇒ 不该给一个 0 的项')
  })

  test('★ 已取消的任务不进筛选器（与岗位过滤同一口径）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    assert.equal(byKey(opts, 'G-C'), undefined, '只有已取消任务的目标不进展板，也不进筛选器')
    assert.equal(pick(opts, 'G-A').count, 2)
  })

  test('★ 没有目标的任务在筛选器里有名有姓（不是"不在任何选项下"）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    const none = pick(opts, NO_GOAL_KEY)
    assert.equal(none.count, 2, 'goalId:null 与缺字段都算"未挂目标"')
    assert.equal(none.goalId, null)
    assert.equal(none.label, '未挂目标')
  })

  test('★ 各项计数之和 = 未被取消的任务数（一条都不许漏）', () => {
    const opts = buildGoalFilter(TASKS, GOALS)
    const sum = opts.reduce((a, o) => a + o.count, 0)
    assert.equal(sum, TASKS.filter((t) => t.status !== 'canceled').length)
  })

  test('顺序固定且不随输入顺序变化（下拉打开时列表不跳）', () => {
    const one = keys(buildGoalFilter(TASKS, GOALS))
    const two = keys(buildGoalFilter([...TASKS].reverse(), [...GOALS].reverse()))
    assert.deepEqual(two, one, '同一批数据换个到达顺序，列表顺序必须一样')

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
    assert.equal(o.objective, null, '文案读不到就是 null，不是空串')
    assert.equal(o.status, null, '读不到状态就不报状态')
    assert.match(o.title, /未读到目标文案/)
  })

  test('★ 截断只发生在 label 上：objective 必须是**完整**文案（模糊匹配要打在它身上）', () => {
    const long = '第一行\n第二行'.repeat(8)
    const opts = buildGoalFilter([{ goalId: 'G-A', status: 'todo' }], [{ id: 'G-A', objective: long, status: 'active' }])
    const o = pick(opts, 'G-A')
    assert.ok(o.label.length <= 19, `列表文案要截断，实际 ${o.label.length} 字`)
    assert.ok(!o.label.includes('\n'), '列表每项是一行：换行要压掉')
    assert.equal(o.objective, long, '★ objective 是完整原文（用户可能输的是后半段）')
    assert.ok(o.title.includes(long), '悬停里要能看到完整文案')
    assert.ok(o.title.includes('G-A'), '悬停里要有目标 id（卡片上的徽标就是 id）')
  })

  test('空/null 输入不炸', () => {
    assert.deepEqual(buildGoalFilter([], []), [])
    assert.deepEqual(buildGoalFilter(null, null), [])
    assert.deepEqual(buildGoalFilter(undefined), [])
  })

  test('★ hasRealGoal：只有「未挂目标」时这条轴不该出现在界面上', () => {
    assert.equal(hasRealGoal(buildGoalFilter(TASKS, GOALS)), true, '有真实目标 ⇒ 出现')
    assert.equal(hasRealGoal(buildGoalFilter([{ goalId: null, status: 'todo' }], [])), false,
      '★ 一个空间只有手工任务时，下拉里唯一的内容是「未挂目标」——那是按钮占位，不是筛选轴')
    assert.equal(hasRealGoal([]), false)
    assert.equal(hasRealGoal(null), false)
    // 目标记录读不到但任务挂着 goalId（「全部空间」模式）：仍然算有真实目标
    assert.equal(hasRealGoal(buildGoalFilter([{ goalId: 'G-A', status: 'todo' }], [])), true)
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

  test('界面说法：没有筛选为 null，筛着但选项读不到时回落到键本身', () => {
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

// ============================================================================
// 🎯 下拉 + 模糊匹配
//
// 这一组守的是**用户输得出来、列表就得找得到**：目标是长句，记得的是几个字、
// 而且常常不连续。只做子串匹配时，这类输入回的是空列表 ——
// 而"搜不到"与"没有这个目标"在空列表里长得一样。
// ============================================================================
describe('模糊匹配打分', () => {
  test('完全相同 / 前缀 / 子串 / 子序列，四档依次靠后', () => {
    const exact = fuzzyScore('手机端任务串空间', '手机端任务串空间')
    const prefix = fuzzyScore('手机端任务串空间', '手机端')
    const inner = fuzzyScore('手机端任务串空间', '任务串')
    const sub = fuzzyScore('手机端任务串空间', '手空')
    for (const [name, v] of [['exact', exact], ['prefix', prefix], ['inner', inner], ['sub', sub]]) {
      assert.notEqual(v, null, `${name} 应当命中`)
    }
    assert.ok(exact < prefix, '完全相同要排在前缀前面')
    assert.ok(prefix < inner, '前缀要排在子串前面')
    assert.ok(inner < sub, '子串要排在子序列前面')
  })

  test('★ 子序列命中：不连续的几个字也算命中（这是"模糊"的那一半）', () => {
    assert.notEqual(fuzzyScore('手机端任务串空间', '手机空间'), null)
    assert.notEqual(fuzzyScore('头像黑边（上传后右下角有黑块）', '头像黑块'), null)
  })

  test('★ 跨度越小越靠前（越连贯越像它）', () => {
    const tight = fuzzyScore('头像黑边黑块', '黑块')
    const loose = fuzzyScore('黑a b c d块', '黑块')
    assert.ok(tight < loose, `连着的应当排在散开的前面（${tight} vs ${loose}）`)
  })

  test('大小写与首尾空白都不敏感', () => {
    assert.equal(fuzzyScore('G-MUJFC9VI-1', 'g-mujfc9vi-1'), 0)
    assert.equal(fuzzyScore('  甲目标  ', '甲目标'), 0)
  })

  test('空查询 = 全部命中（分数 0）；空文本不命中', () => {
    assert.equal(fuzzyScore('任意', ''), 0)
    assert.equal(fuzzyScore('任意', '   '), 0)
    assert.equal(fuzzyScore('', '任意'), null, '★ 空文本是"没命中"，不是"分数 0"')
    assert.equal(fuzzyScore(null, '任意'), null)
  })

  test('★ 不命中回 null，而不是一个很大的数（调用方要能分辨"没命中"）', () => {
    assert.equal(fuzzyScore('甲目标', '乙目标'), null)
    assert.equal(fuzzyScore('甲目标', '甲目标乙'), null, '查询比文本长 ⇒ 不命中')
  })
})

describe('下拉列表（rankGoalOptions）', () => {
  const OPTS = buildGoalFilter(
    [
      { goalId: 'G-1', status: 'in_progress' },
      { goalId: 'G-1', status: 'todo' },
      { goalId: 'G-2', status: 'todo' },
      { goalId: null, status: 'todo' },
    ],
    [
      { id: 'G-1', objective: '手机端任务串空间', status: 'active' },
      { id: 'G-2', objective: '头像上传后有黑边', status: 'paused' },
    ],
  )

  test('空查询 ⇒ 全量，且「全部目标」在最前、其余顺序 = buildGoalFilter 的顺序', () => {
    const menu = rankGoalOptions(OPTS, '', 4)
    assert.equal(menu[0].key, null, '「全部目标」永远第一项（它是出口）')
    assert.equal(menu[0].label, '全部目标')
    assert.equal(menu[0].count, 4, '「全部目标」的数字 = 该范围内未被取消的任务数')
    assert.deepEqual(menu.slice(1).map(o => o.key), OPTS.map(o => o.key), '其余顺序不许被重排')
  })

  test('★ 输目标名的一部分 ⇒ 只留命中的那些（打在**完整**文案上）', () => {
    const menu = rankGoalOptions(OPTS, '头像', 4)
    assert.deepEqual(menu.map(o => o.key), ['G-2'])
  })

  test('★ 输目标 id 也能搜到（粘贴 id 是常见操作），且 id 全字命中排第一', () => {
    const menu = rankGoalOptions(OPTS, 'G-2', 4)
    assert.equal(menu[0].key, 'G-2')
  })

  test('★ 输不连续的字（模糊）：仍然能找到那一条', () => {
    const menu = rankGoalOptions(OPTS, '手机空间', 4)
    assert.deepEqual(menu.map(o => o.key), ['G-1'])
  })

  test('「未挂目标」也搜得到（按名字与口语别名）', () => {
    for (const q of ['未挂', '手工', 'no-goal']) {
      const menu = rankGoalOptions(OPTS, q, 4)
      assert.deepEqual(menu.map(o => o.key), [NO_GOAL_KEY], `用「${q}」应当能搜到未挂目标那一项`)
    }
  })

  test('「全部目标」搜得到（它是出口，不许因为搜索而消失）', () => {
    for (const q of ['全部', '所有', 'all']) {
      const menu = rankGoalOptions(OPTS, q, 4)
      assert.equal(menu[0].key, null, `用「${q}」应当能搜到「全部目标」`)
    }
  })

  test('★ 一条都不命中 ⇒ 空列表（界面据此说"没有匹配的目标"，而不是静默空白）', () => {
    assert.deepEqual(rankGoalOptions(OPTS, '完全不相干的东西', 4), [])
  })

  test('★ 同分保持原相对次序（列表不许在用户眼皮底下跳）', () => {
    // 三条文案都含"目标"二字 ⇒ 命中位置相同 ⇒ 同分，只能靠原次序决胜
    const same = buildGoalFilter(
      [{ goalId: 'G-X', status: 'todo' }, { goalId: 'G-Y', status: 'todo' }, { goalId: 'G-Z', status: 'todo' }],
      [
        { id: 'G-X', objective: '目标甲', status: 'active' },
        { id: 'G-Y', objective: '目标乙', status: 'active' },
        { id: 'G-Z', objective: '目标丙', status: 'active' },
      ],
    )
    const before = same.map(o => o.key)
    const menu = rankGoalOptions(same, '目标', 3)
    assert.deepEqual(menu.filter(e => e.key !== null).map(e => e.key), before, '同分时顺序 = 原顺序')
    // ★ 「全部目标」也含"目标"二字 ⇒ 它同样命中，只是排在"从头命中"的那些之后。
    //   它**不许被搜掉**：那是取消筛选的出口。
    assert.ok(menu.some(e => e.key === null), '★ 出口（全部目标）不许因为搜索而消失')
  })

  test('空/null 输入不炸', () => {
    assert.deepEqual(rankGoalOptions(null, '').map(o => o.key), [null], '没有目标时至少给「全部目标」')
    assert.deepEqual(rankGoalOptions(undefined, '').map(o => o.key), [null])
    // 查询谁也不命中 ⇒ 空列表（界面据此说"没有匹配的目标"），不是崩溃、也不是硬塞一个出口进去
    assert.deepEqual(rankGoalOptions(undefined, 'zzz', 2), [])
  })
})

describe('接线：任务中心真的挂上了这条轴', () => {
  const view = codeOnly(read('src/components/TaskCenterView.tsx'))
  const app = codeOnly(read('src/App.tsx'))

  test('★ 判据在纯函数里：组件用 buildGoalFilter / matchesGoalFilter，自己不判 goalId', () => {
    assert.match(view, /buildGoalFilter\(rows \?\? \[\], goals\)/, '选项要用纯函数生成')
    assert.match(view, /matchesGoalFilter\(r, goalFilter\)/, '筛选要用同一个判据')
    assert.doesNotMatch(view, /NO_GOAL_KEY|__no_goal__/, '★ 哨兵只许留在 taskGoalFilter.ts 里，组件不许自己拼')
  })

  test('★ 计数取全量 rows（不是 filtered）：数字不随筛选变', () => {
    assert.doesNotMatch(view, /buildGoalFilter\(filtered/, '★ 用筛选后的任务算计数 ⇒ 选一下其余项的数字全变')
  })

  test('★ 是**下拉 + 输入模糊匹配**，不是一排胶囊（目标一多，胶囊会把屏幕塞满）', () => {
    assert.match(view, /<input[\s\S]{0,400}tc-goal-search/, '下拉里要有搜索框')
    assert.match(view, /rankGoalOptions\(/, '列表内容与顺序来自纯函数')
    assert.match(view, /role="listbox"/, '列表要有 listbox 语义（键盘/读屏能用）')
    assert.match(view, /aria-expanded=\{goalOpen\}/, '触发按钮要报开合状态')
    assert.match(view, /tc-goal-trigger/, '有一个触发按钮（显示当前筛的是哪个目标）')
    assert.match(view, /hasRealGoal\(goalOptions\)/, '★ 一个真实目标都没有时整条不出现（判据也在纯函数里）')
    // ★ 反向判据：整排自动渲染的胶囊一旦回来，就是"目标多了塞满屏幕"那个问题回来了
    assert.doesNotMatch(view, /goalOptions\.map\(/, '★ 不许再把所有目标平铺成一行胶囊')
    assert.doesNotMatch(view, /tc-pill-goal/, '★ 胶囊样式已退役（下拉取代）')
  })

  test('★ 下拉里必须能键盘操作（否则键盘用户只能一个个点）', () => {
    assert.match(view, /ArrowDown/, '支持 ↓ 移游标')
    assert.match(view, /setGoalCursor/, '有游标状态')
    assert.match(view, /onKeyDown=\{onGoalKeyDown\}/, '搜索框接了键盘处理')
  })

  test('★ 点外面 / Esc 都能关掉（下拉不许赖在屏幕上）', () => {
    assert.match(view, /goalPickerRef/, '要有容器引用用来判断"点在外面"')
    assert.match(view, /addEventListener\('mousedown'/, '点外面关掉')
    assert.match(view, /e\.key === 'Escape'/, 'Esc 关掉')
    // 但也不能用全屏遮罩：那会把泳道的拖拽一起挡掉
    assert.doesNotMatch(view, /tc-goal-mask/, '不用遮罩：遮罩会盖住泳道')
  })

  test('★ 「全部目标」是出口：选它 = 取消目标筛选', () => {
    assert.match(view, /chooseGoal\(null\)|chooseGoal\(entry\.key\)/, '列表项走同一个 chooseGoal')
    assert.match(view, /setGoalFilter\(key\)/, '选中即写筛选键（null = 不筛）')
  })

  test('★ 「清除过滤」把目标也一起清掉（不然它看起来清了、其实还筛着）', () => {
    assert.match(view, /setQuery\(''\); setRoleFilter\(null\); setGoalFilter\(null\)/, '清除过滤必须同时清空 搜索 + 岗位 + 目标')
  })

  test('筛成空时说得清是哪一条轴筛空的', () => {
    assert.match(view, /没有符合当前条件的任务/)
    assert.match(view, /目标：\$\{goalFilterWording/, '空态要念出当前筛着的目标')
    assert.match(view, /没有匹配的目标/, '下拉里"搜不到"要明说，不能只留一片空白')
  })

  test('★ 目标文案来自上层：App 把 goals 交给 TaskCenterView', () => {
    // 「读不到就只显示 id」是允许的降级，所以这条守的是**接线**：
    // 上层明明有目标记录（/api/goal）却没传下去，列表里就永远只有 id。
    assert.match(app, /goals=\{hubMode \? \(goalInfo\?\.goals \?\? \[\]\) : \[\]\}/)
    assert.match(read('src/components/TaskCenterView.tsx'), /goals\?: HubGoal\[\]/)
  })
})
