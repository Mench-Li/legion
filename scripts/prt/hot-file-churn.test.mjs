// scripts/prt/hot-file-churn.test.mjs — 阶段 3 评审闸门探针单测
//
// 只测能纯函数化的部分（窗口切分），以及**测量方法本身**：
// 本工具存在的理由是「随手写的那句 git log 是错的」，所以有一条用例
// 直接锁定正确写法与错误写法的差异——否则下一个人很容易「简化」回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOT_FILES, collectChurn, windowRanges } from './hot-file-churn.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/**
 * `git` 包装。第二个参数可选，用来喂 stdin（`--stdin` 的几处要用）。
 * 不传时行为与原来完全一致。
 */
const git = (args, opts = {}) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
}).trim()

// ---------------------------------------------------------------- 窗口切分

test('① 窗口覆盖且不重叠', () => {
  const w = windowRanges(100, 40, 6)
  assert.equal(w.length, 3, '100 个提交 / 窗口 40 应有 3 个窗口')
  assert.deepEqual(w.map((x) => [x.from, x.to]), [[0, 40], [40, 80], [80, 100]])
  // 不重叠：相邻窗口首尾相接
  for (let i = 1; i < w.length; i++) assert.equal(w[i].from, w[i - 1].to)
})

test('① 不足一个窗口时只返回一个不完整窗口，且标记 complete=false', () => {
  const w = windowRanges(17, 40, 6)
  assert.equal(w.length, 1)
  assert.equal(w[0].complete, false)
  assert.deepEqual([w[0].from, w[0].to], [0, 17])
})

test('① 恰好整除时最后一个窗口是完整的（off-by-one 高发处）', () => {
  const w = windowRanges(80, 40, 6)
  assert.equal(w.length, 2)
  assert.equal(w[1].complete, true)
  assert.deepEqual([w[1].from, w[1].to], [40, 80])
})

test('① 空仓库不产生窗口', () => {
  assert.deepEqual(windowRanges(0, 40, 6), [])
})

test('① 非法参数抛错而不是静默返回空', () => {
  assert.throws(() => windowRanges(100, 0, 6), /window 必须是正整数/)
  assert.throws(() => windowRanges(100, -1, 6), /window 必须是正整数/)
  assert.throws(() => windowRanges(100, 40, 0), /windows 必须是正整数/)
})

// ---------------------------------------------------------------- 测量方法

/**
 * **精确**数法：把窗口的那 N 个哈希逐字交给 git（`--no-walk`），
 * 让它说出每个提交动了哪些文件（`--name-only`），**路径过滤我们自己判**。
 *
 * ★ 这个 helper 的形状改过两次，两次都是因为"基准"本身错了：
 *
 *   1. 最初两处用例各自内联了 `` git log `${oldest}^..${all[0]}` `` ——
 *      那**正是**被测实现当时的写法。于是"正确基准"是**被测对象自己**：
 *      实现写错时基准一起错，用例照样绿。
 *   2. 改成 `--no-walk --stdin -- <path>` —— 看着对，其实 `--no-walk`
 *      让 git 不再做历史行走，**路径过滤整个失效**，于是它恒等于窗口大小。
 *      用它当基准的话，"实现返回 40/40"会被判为正确。
 *
 *   > 一个"与被测实现共用同一个错误假设"的基准，
 *   > 与没有基准，在判定上是同一个东西。
 */
const exactWindowCount = (commits, f, cwd = ROOT) => {
  const out = git(['log', '--no-walk', '--format=%x1f%h', '--stdin', '--name-only'],
    { input: commits.join('\n') + '\n', cwd })
  let n = 0
  for (const chunk of out.split('\x1f')) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    if (lines.length > 0 && lines.slice(1).includes(f)) n++
  }
  return n
}

test('② 正确写法：窗口内路径过滤 = 「这 N 个提交里有几个碰了该文件」', () => {
  const all = git(['rev-list', 'HEAD']).split('\n').filter(Boolean)
  const f = HOT_FILES[0]
  const n = Math.min(40, all.length)
  const correct = exactWindowCount(all.slice(0, n), f)
  // 必须 ≤ 窗口大小——这正是错误写法唯一不可能满足的性质
  assert.ok(correct <= n, `窗口内计数 ${correct} 不应超过窗口 ${n}`)
})

test('② 错误写法会返回窗口大小的假象（本工具存在的原因）', () => {
  // ★★ 这一条**必须**在一个人造仓库上验，不能在本仓上验——而它原来是在本仓上验的。
  //
  //   原来的写法是：`wrong = git log -n 40 -- <f>`（先按路径过滤再截断），
  //   然后断言 `wrong !== correct`。而 `correct` 取的是本仓最后 40 个提交里
  //   碰过 `HOT_FILES[0]` 的个数——**本仓那个文件的答案是 40**，
  //   于是两种写法给出**同一个数**，`notEqual` 直接失败。
  //
  //   而这不是"本仓刚好不巧"：只要一个文件被窗口里**每一个**提交碰过，
  //   两种写法就必然一致（一个返回 n 因为截断，一个返回 n 因为都碰了）。
  //   换句话说，这条用例的力气一直取决于**本仓有多巧**——
  //   它此前能过，只是因为 `correct` 当时算的是别的（错的）东西。
  //
  //  > 一条"用本仓某次恰好成立的数字"来区分对错的用例，
  //  > 与一条"什么都没验"的用例，在报告上是同一个东西——
  //  > 只不过前者的绿来自运气，而运气会随着仓库变热而消失。
  //
  //   人造仓库给出的是**确定**的窗口内容，所以两种写法必须分开。
  const dir = mkdtempSync(join(tmpdir(), 'prt-churn-wrong-'))
  const g = (args, opts = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...opts }).trim()
  try {
    g(['init', '-q'])
    g(['config', 'user.email', 'churn@test'])
    g(['config', 'user.name', 'churn'])
    // 5 个提交，`hot.txt` 只在 第 2、第 4 个 提交里被碰过（窗口取最近 2 个 ⇒ 精确值应为 1）
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `f${i}.txt`), String(i))
      if (i === 2 || i === 4) writeFileSync(join(dir, 'hot.txt'), `v${i}`)
      g(['add', '-A'])
      g(['commit', '-q', '-m', `c${i}`])
    }
    const n = 2
    const all = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    // 先把人造仓库自身的性质钉住：否则下面的对比可能只是巧合
    assert.equal(g(['log', '--format=%h', '--', 'hot.txt']).split('\n').filter(Boolean).length, 2,
      '夹具前提：`hot.txt` 在全部历史里只被碰过 2 次')
    assert.ok(all.length >= n, '夹具前提：提交数不少于窗口')

    // ❌ 先按路径过滤再截断 ⇒ 恒返回窗口大小（与窗口内容无关）
    const wrong = g(['log', '-n', String(n), '--format=%h', '--', 'hot.txt']).split('\n').filter(Boolean).length
    assert.equal(wrong, n, '错误写法应恒返回窗口大小——这正是"最近 n 个提交都在改它"这个假象的来源')

    // ✅ 先取窗口的那 n 个提交，再数其中几个碰了它
    const correct = exactWindowCount(all.slice(0, n), 'hot.txt', dir)
    assert.equal(correct, 1, `窗口是最近 ${n} 个提交（c5、c4），只有 c4 碰过 hot.txt ⇒ 精确值应为 1`)

    assert.notEqual(wrong, correct,
      '两种写法必须给出不同结果，否则这条用例失去意义')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ②·续 ★★★ 第二种错法：`<oldest>^..<newest>` **在合并历史上不是窗口**
// ②·续二 ★★★ 第三种错法：`--no-walk --stdin -- <path>` 会被 `--no-walk` 关掉路径过滤
// ══════════════════════════════════════════════════════════════════════════

test('②·续 ★★★ `A^..B` 在带合并的历史上**两个方向都会错**（且能超过窗口大小）', () => {
  // ## 这条防的是什么
  //
  // 本探针的第一版用 `<oldest>^..<newest> -- <file>`，注释写着
  // 「语义正是『这 40 个提交里有几个碰了该文件』」。**那句话在带合并的
  // 历史上是错的**：`A^..B` 的语义是「B 可达且 A^ 不可达」，于是
  // **B 经过合并的第二个父亲能带进来一大批不在窗口里的提交**。
  //
  // 实测（`HEAD=eed4058`、窗口 40、本仓 101 个合并）：
  //
  //     窗口 1  plugins/src/index.ts   区间 9  / 精确 1    ← 多算 9 倍
  //     窗口 1  team-hub/server.mjs    区间 41 / 精确 9    ← 超过窗口大小
  //     窗口 6  team-hub/server.mjs    区间 9  / 精确 10   ← 这个方向又少算
  //
  // 窗口 1 的 `9 vs 1` 正是本文件头警告过的那件事：真实答案 1 说明该文件
  // **已经降温**，而 9 会把 `recentMax <= 2` 的判据推成「没降温，不能开工」。
  //
  //   > 一个会把「该开工」读成「不能开工」的测量方法，比没有测量更糟——
  //   > 而它换了个地方又长回来了。
  //
  // 同时它还会让 `collectChurn` 那条守卫（`count <= windowSize`）变红，
  // 并给出**完全错误的诊断**：
  //
  //     team-hub/server.mjs 第 1 窗口计数 41 > 40：可能又改成错误写法了
  //
  // 它把一个**测量方法的缺陷**说成了一次**实现回归**。
  //
  // ## 判据
  //
  // ① 精确写法**永远**不超过窗口大小（它是对的）；
  // ② 区间写法**确实**超过窗口（它是错的证据）；
  // ③ 区间写法**确实**给出与精确值不同的数（否则本仓形状暴露不出它）。
  //
  // ★ 用**人造仓库**把"两个方向都错"钉死，而不是只靠本仓的当下形状：
  //   本仓的数会随历史增长而改变，而一条"靠本仓这次恰好成立"的用例，
  //   与一条什么都没验的用例，在报告上是同一个东西。
  const dir = mkdtempSync(join(tmpdir(), 'prt-churn-merge-'))
  /**
   * `env` 用来钉住提交时间——这是本夹具的**关键**，见下面 `DATES` 那段。
   * 不传时行为与普通 `git` 一样。
   */
  const g = (args, env) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  }).trim()
  try {
    g(['init', '-q'])
    g(['config', 'user.email', 'churn@test'])
    g(['config', 'user.name', 'churn'])
    // ★ 不假设初始分支叫 `main`（`init.defaultBranch` 因机器而异，实测本机是
    //   `master`），也**不能**用 `rev-parse --abbrev-ref HEAD` 去问——
    //   那个仓库此刻还没有任何提交，`HEAD` 解析不了，于是那条命令**失败**
    //   并打出 `fatal: ambiguous argument 'HEAD'`。
    //   `symbolic-ref` 直接读那面还没指向任何提交的引用，是唯一在"零提交"
    //   状态下也能用的问法。
    const trunk = g(['symbolic-ref', '--short', 'HEAD'])
    assert.ok(trunk !== '', '夹具前提：应当能读出初始分支名')

    // ── 为什么必须钉住提交时间 ─────────────────────────────────────────────
    //
    // `git rev-list` 默认按**提交日期**倒序排（不是拓扑序）。这正是
    // `A^..B` 出错的机制：一个**很久以前创建、最近才合进来**的侧枝，
    // 它的提交日期很旧，于是它们在 `rev-list` 里排在**很后面**（不在窗口里），
    // 但它们**从最新提交可达**——于是 `oldest^..newest` 会把它们全捞进来。
    //
    // 我第一版夹具忘了这一点：侧枝提交的日期比主线还新，于是它们**就在
    // 窗口里**，区间写法给出的数与精确值一样，用例直接失败在"前提不成立"上。
    // 那不是用例太严，是**夹具没造出要验的形状**。
    const day = (n) => `${n} 12:00:00 +0000`
    const at = (n) => ({ GIT_AUTHOR_DATE: day(n), GIT_COMMITTER_DATE: day(n) })

    // 主线 6 个提交（2021 年 1 月，逐日）。`hot.txt` **从不**在主线被碰过。
    for (let i = 1; i <= 6; i++) {
      writeFileSync(join(dir, `base${i}.txt`), String(i))
      g(['add', '-A'])
      g(['commit', '-q', '-m', `m${i}`], at(`2021-01-0${i}`))
    }
    const mainTip = g(['rev-parse', 'HEAD'])
    const m1 = g(['rev-parse', 'HEAD~5'])
    // 侧枝从 m1 出发，3 个提交**每个都碰 hot.txt**，日期落在 2020 年（**比主线旧**）。
    g(['checkout', '-q', '-b', 'side', m1])
    writeFileSync(join(dir, 'hot.txt'), 'side-base')
    g(['add', '-A']); g(['commit', '-q', '-m', 's1'], at('2020-01-01'))
    for (let i = 2; i <= 3; i++) {
      writeFileSync(join(dir, 'hot.txt'), `side${i}`)
      g(['add', '-A']); g(['commit', '-q', '-m', `s${i}`], at(`2020-01-0${i}`))
    }
    g(['checkout', '-q', trunk])
    assert.equal(g(['rev-parse', 'HEAD']), mainTip, '夹具前提：切回主线后 HEAD 应仍是主线顶端')
    g(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], at('2021-02-01'))
    const merges = g(['rev-list', '--merges', 'HEAD']).split('\n').filter(Boolean).length
    assert.equal(merges, 1, '夹具前提：应当恰好有 1 个合并提交')

    const n = 2
    const all = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    const window = all.slice(0, n)
    const oldest = window[n - 1]
    const newest = window[0]

    // 夹具前提：窗口是「合并提交 + 主线最新那个」，**两个都没碰过 hot.txt**
    assert.equal(exactWindowCount(window, 'hot.txt', dir), 0,
      `夹具前提：窗口（最近 ${n} 个提交）里没有任何提交碰过 hot.txt ⇒ 精确值应为 0`)
    // 而侧枝的 3 个提交确实碰过它——它们只是**不在窗口里**
    assert.equal(g(['log', '--format=%h', '--', 'hot.txt']).split('\n').filter(Boolean).length, 3,
      '夹具前提：`hot.txt` 在全部历史里被碰过 3 次（全在侧枝上）')

    // ① 精确写法：窗口里 0 个碰过
    const viaExact = exactWindowCount(window, 'hot.txt', dir)

    // ② 区间写法把侧枝那 3 个（日期很旧、不在窗口里）全捞了进来
    const viaRange = g(['log', '--format=%h', `${oldest}^..${newest}`, '--', 'hot.txt'])
      .split('\n').filter(Boolean).length
    assert.equal(viaRange, 3,
      `区间写法给出 ${viaRange}，本应捞进侧枝那 3 个提交（它们在窗口外但可从最新提交到达）`)
    assert.ok(viaRange > viaExact,
      `区间写法 ${viaRange} 精确值 ${viaExact} —— 区间本应多算；前提不成立，先确认夹具形状`)
    assert.ok(viaRange > n,
      `区间写法给出 ${viaRange} > 窗口大小 ${n}（这正是"计数 > 窗口"那个假红的来源）`)
    console.log(`  ✔ ②·续：人造仓库上 区间=${viaRange} / 精确=${viaExact}（窗口 ${n}）——多算且超过窗口`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // ③ 本仓上再核一遍：精确写法在任何窗口都不超过窗口大小（真正的判据）
  const all = git(['rev-list', 'HEAD']).split('\n').filter(Boolean)
  const size = 40
  for (let w = 0; w * size < all.length; w++) {
    const window = all.slice(w * size, (w + 1) * size)
    for (const f of HOT_FILES) {
      const viaExact = exactWindowCount(window, f)
      assert.ok(viaExact <= window.length,
        `★ 精确写法在窗口 ${w + 1} 上给出 ${viaExact} > ${window.length}（${f}）——它才是对的`)
    }
  }
})

test('②·续二 ★★★ `--no-walk --stdin -- <path>` 会被 `--no-walk` 关掉路径过滤（第二种修法错在哪）', () => {
  // ## 这条防的是什么
  //
  // 发现 `A^..B` 错了之后的**第一个**修法是把窗口的哈希喂给
  // `git log --no-walk --stdin -- <path>`，理由看着很直：
  // 「`--no-walk` 保证只看这 N 个提交，`-- <path>` 再做路径过滤」。
  //
  // **`--no-walk` 会把路径过滤整个关掉。** 实测：本仓每个窗口每个文件
  // 都恒返回窗口大小（`40/40`），两条满格的条形图，而窗口 2 的真实答案是 0。
  //
  //   > 一个"每个格子都是 40/40"的探针，看起来像一份**最坏**的报告，
  //   > 于是它骗人的方向是"让人不敢开工"——
  //   > 而它其实什么都没测，因为路径过滤被那面 `--no-walk` 的旗子关掉了。
  //
  // ## 判据
  //
  // 在人造仓库上：`--no-walk --stdin -- hot.txt` 会**连没碰过该文件的提交
  // 一起返回**（返回窗口大小），而精确写法只返回真正碰过的那个。
  const dir = mkdtempSync(join(tmpdir(), 'prt-churn-nowalk-'))
  const g = (args, input) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    ...(input === undefined ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
  }).trim()
  try {
    g(['init', '-q'])
    g(['config', 'user.email', 'churn@test'])
    g(['config', 'user.name', 'churn'])
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, `f${i}.txt`), String(i))
      if (i === 2 || i === 4) writeFileSync(join(dir, 'hot.txt'), `v${i}`)
      g(['add', '-A']); g(['commit', '-q', '-m', `c${i}`])
    }
    const n = 2
    const all = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    const window = all.slice(0, n)
    // 夹具前提：窗口是 c5、c4，而只有 c4 碰过 hot.txt
    assert.equal(g(['log', '--format=%h', '--', 'hot.txt']).split('\n').filter(Boolean).length, 2,
      '夹具前提：`hot.txt` 在全部历史里被碰过 2 次')

    const exact = exactWindowCount(window, 'hot.txt', dir)
    assert.equal(exact, 1, '精确写法：窗口（c5、c4）里只有 c4 碰过 hot.txt ⇒ 1')

    const viaNoWalk = g(['log', '--no-walk', '--format=%h', '--stdin', '--', 'hot.txt'],
      window.join('\n') + '\n').split('\n').filter(Boolean).length
    assert.equal(viaNoWalk, n,
      `\`--no-walk --stdin -- <path>\` 返回了 ${viaNoWalk}，本应恒等于窗口大小 ${n}`
      + '（即路径过滤被关掉了）—— 而它给出的小于窗口大小就意味着这条夹具没能暴露该缺陷')
    assert.notEqual(viaNoWalk, exact,
      '两种写法必须给出不同结果，否则这条用例失去意义')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- collectChurn

const churn = collectChurn({ size: 40, windows: 3 })

test('③ collectChurn 报告 HEAD、总数与两个热点文件', () => {
  assert.equal(churn.ok, true)
  assert.ok(churn.totalCommits > 50, `提交数 ${churn.totalCommits} 偏少，探针可能读错仓库`)
  assert.deepEqual(Object.keys(churn.files).sort(), [...HOT_FILES].sort())
})

test('③ 每个文件的窗口计数都不超过窗口大小（防错误写法回归）', () => {
  for (const v of Object.values(churn.files)) {
    assert.ok(v.windows.length > 0, `${v.path} 无窗口`)
    for (const w of v.windows) {
      assert.ok(w.count <= churn.windowSize, `${v.path} 第 ${w.rank} 窗口计数 ${w.count} > ${churn.windowSize}：可能又改成错误写法了`)
    }
  }
})

test('③ ★★★ 每个窗口的计数**逐格等于**独立算出的精确值（这才是钉住实现对错的判据）', () => {
  // ## 为什么必须补这一条
  //
  // 上一版只有「计数 ≤ 窗口大小」那一条。而那就是**全部**的约束——
  // 于是下面两种坏实现**都能通过它**：
  //
  //   · `--no-walk --stdin -- <file>`（路径过滤被 `--no-walk` 关掉）
  //     ⇒ 每个窗口恒等于窗口大小 ⇒ `40 <= 40` ✔ 全绿；
  //   · 让 `countWindowTouches` 直接 `return slice.length`
  //     ⇒ 同样恒等于窗口大小 ⇒ 同样全绿。
  //
  // 实测：把实现改成上面任一种，整个套件**一条都不红**。
  //
  //   > 一条只写下"不许超过 40"的规矩，管不住"每次都答 40"——
  //   > 而"每次都答 40"正是本探针两次修错时的样子。
  //
  // 所以这里做的是**交叉核对**：把 `collectChurn` 交出来的每一格，
  // 与 `exactWindowCount` 用另一条路径（`--no-walk --name-only` + 自己解析）
  // 算出的值逐一对上。两条路径没有共用任何假设，所以它们同时错得一样的
  // 概率极低。
  //
  // ★★★ 用 `churn.revList`（本次采集**实际用的**那份快照），
  //   而**不是**再 `git rev-list HEAD` 读一次。
  //
  //   这里此前是 `git(['rev-list', 'HEAD'])`，于是本用例在共享工作树上会
  //   **随机红**：`churn` 在模块加载时算出，而这一行在十几分钟后才跑，
  //   中间只要有人提交，两次读到的历史就不同——窗口随之后移一格，
  //   逐格比对全线错位。
  //
  //   实测：2026-09-18 04:23–04:36 UTC 那次 CI 期间落了 3 个提交
  //   （`69da8fd`/`5c1d698`/`4046dd4`），本用例红了，而红的理由与
  //   "窗口切分对不对"毫无关系。
  //
  //   > 一个在模块加载时读一次仓库、在用例里再读一次的判据，
  //   > 在有人同时提交的仓库里，测的是"这两次读之间有没有人提交"。
  //
  //   ⚠️ 共用同一份**提交表**不会削弱本用例：它要钉的是
  //   "窗口切分 + 路径过滤"对不对，而那仍然由**另一条路径**
  //   （`exactWindowCount` 的 `--no-walk --name-only` + 自己解析）独立算出。
  //   共用的是"查哪个提交"，不是"怎么数"。
  const all = [...churn.revList]
  const size = churn.windowSize
  let cells = 0
  for (const v of Object.values(churn.files)) {
    for (const w of v.windows) {
      // `w.from`/`w.to` 是 1-based 的提交序号，对应 `all` 的 [from-1, to)
      const slice = all.slice(w.from - 1, w.to)
      assert.equal(slice.length, w.to - w.from + 1,
        `窗口 ${w.rank}（${v.path}）的切片长度与报告的范围不一致——先修窗口切分`)
      const expected = exactWindowCount(slice, v.path)
      assert.equal(w.count, expected,
        `${v.path} 第 ${w.rank} 窗口：探针报 ${w.count}，独立算出来是 ${expected}。`
        + '两者不一致时**先怀疑探针**（本探针历史上错过两次：区间写法多算、--no-walk 关掉路径过滤）')
      cells++
    }
  }
  assert.ok(cells > 0, '一格都没核对到——这条用例什么都没验')
  console.log(`  ✔ ③ 交叉核对：${cells} 格（${Object.keys(churn.files).length} 个文件 × ${size} 窗口）逐格一致`)
})

test('③ ★★★ 快照必须对「核对期间又有人提交」免疫（模拟共享工作树）', () => {
  // ## 这一条钉的是一个**真实发生过**的红
  //
  // 2026-09-18 04:23–04:36 UTC 那次 CI，`test` 阶段报
  // `FAIL prt-churn … ✖ ③ 每个窗口的计数逐格等于独立算出的精确值`。
  // 而那次失败**与窗口切分毫无关系**：本仓有另一个会话在同时提交，
  // 那 13 分钟里落了 3 个提交（`69da8fd`/`5c1d698`/`4046dd4`）。
  //
  // `churn` 在**模块加载时**算出，而用例 ③ 在十几分钟后才自己
  // `git rev-list HEAD` 再读一次——两次读到的是**两个不同的历史**，
  // 窗口随之后移一格，逐格比对全线错位。
  //
  //   > 一个在模块加载时读一次仓库、在用例里再读一次的判据，
  //   > 在有人同时提交的仓库里，测的是"这两次读之间有没有人提交"。
  //
  // 修法：`collectChurn` 用**刚解析出来的那个哈希**展开提交表
  // （`rev-list <hash>`，而不是 `rev-list HEAD`），并把那份快照
  // 作为 `revList` 交出来；核对方对着**同一份快照**核。
  //
  //   > 快照必须是一个**具体的提交**；`HEAD` 是一个会动的名字，不是快照。
  //
  // ## 为什么这条用例必须有**反向对照**
  //
  // 只断言"核对通过"是不够的——把 `all` 写死成空数组也能让某些断言通过。
  // 所以这里同时证明：**用移动过的 `HEAD` 去核，一定对不上**。
  // 那才说明这条用例真的在区分"快照"与"会动的名字"。
  const dir = mkdtempSync(join(tmpdir(), 'prt-churn-snapshot-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  try {
    g(['init', '-q'])
    g(['config', 'user.email', 'churn@test'])
    g(['config', 'user.name', 'churn'])
    // 5 个提交，每个都碰 hot.txt ⇒ 任一窗口的计数都非零，逐格比对才有意义
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir, 'hot.txt'), `v${i}\n`)
      g(['add', '-A'])
      g(['commit', '-q', '-m', `c${i}`])
    }

    const c = collectChurn({ files: ['hot.txt'], size: 2, windows: 2, cwd: dir })
    assert.equal(c.ok, true)
    const snapshotLen = [...c.revList].length
    assert.equal(snapshotLen, 5, `夹具前提：快照应有 5 个提交，实得 ${snapshotLen}`)

    // ── 模拟"核对期间又有人提交" ────────────────────────────────────
    writeFileSync(join(dir, 'hot.txt'), 'v6\n')
    g(['add', '-A'])
    g(['commit', '-q', '-m', 'c6'])
    const movedHead = g(['rev-parse', 'HEAD'])
    assert.notEqual(movedHead, c.headFull, '夹具前提：HEAD 必须真的动了')
    assert.equal(g(['rev-list', 'HEAD']).split('\n').filter(Boolean).length, 6,
      '夹具前提：历史必须真的长了一条')

    // ── ① 快照不随 HEAD 移动 ────────────────────────────────────────
    assert.equal([...c.revList].length, snapshotLen,
      '`revList` 必须是**快照**：HEAD 动了它不许跟着动')
    assert.equal(c.revList[0], c.headFull, '快照的第一个提交就是采集时的 HEAD')

    // ── ② 对着快照逐格核对：仍然对得上 ──────────────────────────────
    const wins = c.files['hot.txt'].windows
    assert.ok(wins.length > 0, '夹具前提：应当有窗口')
    let checked = 0
    for (const w of wins) {
      const slice = [...c.revList].slice(w.from - 1, w.to)
      assert.equal(slice.length, w.to - w.from + 1, '窗口切片长度应与报告范围一致')
      assert.equal(w.count, exactWindowCount(slice, 'hot.txt', dir),
        `窗口 ${w.rank} 与独立路径算出的值不一致`)
      checked += 1
    }
    assert.ok(checked > 0, '一格都没核到——这条用例什么都没验')

    // ── ③ ★ 反向对照：用**移动过的** HEAD 去核，必须对不上 ────────────
    //
    //   没有这一段，本用例可能是恒真的（比如 `all` 被写死）。
    const moved = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    const w0 = wins[0]
    const movedSlice = moved.slice(w0.from - 1, w0.to)
    const movedCount = exactWindowCount(movedSlice, 'hot.txt', dir)
    // 6 个提交、窗口 2：移动后同一格覆盖的是**不同的两个提交**，
    // 于是计数应当与快照那一格不同（或至少切片内容不同）。
    assert.notDeepEqual(movedSlice, [...c.revList].slice(w0.from - 1, w0.to),
      '★ 反向对照失效：移动 HEAD 之后同一格切出来的提交竟然一样，'
      + '那说明这条用例区分不出"快照"与"会动的名字"')
    // 6 个提交全都是 `hot.txt`，所以计数恰好相等——这里断言的是**切片不同**，
    // 而不是计数不同。两件事要分开说，否则这条反向对照是假的。
    assert.equal(movedCount, w0.count,
      '夹具事实：本夹具里每个提交都碰 hot.txt，所以计数恰好相等——'
      + '这正是为什么上面断言的是**切片**而不是计数')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ ★★ 路径必须**精确相等**才算碰上（`endsWith` 会把同名的子路径算进来）', () => {
  // `includes` 与 `endsWith` 在"只关心整仓里唯一那个路径"时看不出差别——
  // 而本仓恰好有两个不同的路径，且都不是彼此的结尾。
  // 也就是说：这条缺陷在本仓上**恒不可见**，只有人造仓库能暴露。
  //
  //   > 一条"恰好因为本仓的文件名不构成后缀关系"而看不出来的缺陷，
  //   > 与一条不存在的缺陷，在报告上是同一个东西。
  const dir = mkdtempSync(join(tmpdir(), 'prt-churn-suffix-'))
  // ★ `input` 必须转发：不转发时 `--stdin` 那条命令会**永远等输入**，
  //   而表现是整个测试文件挂死（不是一条失败）——比失败更难定性。
  const g = (args, input) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8',
    ...(input === undefined ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
  }).trim()
  try {
    g(['init', '-q'])
    g(['config', 'user.email', 'churn@test'])
    g(['config', 'user.name', 'churn'])
    mkdirSync(join(dir, 'sub'), { recursive: true })
    // 两个**互为后缀**的路径：`hot.txt` 与 `sub/hot.txt`
    writeFileSync(join(dir, 'hot.txt'), 'top')
    writeFileSync(join(dir, 'sub', 'hot.txt'), 'nested')
    g(['add', '-A']); g(['commit', '-q', '-m', 'both'])
    writeFileSync(join(dir, 'other.txt'), 'x')
    g(['add', '-A']); g(['commit', '-q', '-m', 'other'])

    const all = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    const slice = all.slice(0, 2)

    // 精确：顶层那个只在第 1 个提交里被碰过
    assert.equal(exactWindowCount(slice, 'hot.txt', dir), 1,
      '夹具前提：窗口（2 个提交）里只有第 1 个碰过顶层 `hot.txt`')
    // 而 `endsWith` 会把 `sub/hot.txt` 也算成 `hot.txt`
    const viaEndsWith = (() => {
      const out = g(['log', '--no-walk', '--format=%x1f%h', '--stdin', '--name-only'], slice.join('\n') + '\n')
      let n = 0
      for (const chunk of out.split('\x1f')) {
        const lines = chunk.split('\n').map((l) => l.trim()).filter((l) => l !== '')
        if (lines.length > 0 && lines.slice(1).some((l) => l.endsWith('hot.txt'))) n++
      }
      return n
    })()
    assert.equal(viaEndsWith, 1,
      '`endsWith` 在这一格上应当同样给 1（第 1 个提交同时改了顶层与嵌套两处）——'
      + '所以它在这个夹具上分不出来；分得出来的是**另一个**形状，见下面那条断言')
    // 真正分得出来的是：一个提交**只**改了嵌套的那个
    writeFileSync(join(dir, 'sub', 'hot.txt'), 'nested2')
    g(['add', '-A']); g(['commit', '-q', '-m', 'nested-only'])
    const all2 = g(['rev-list', 'HEAD']).split('\n').filter(Boolean)
    const onlyNested = all2.slice(0, 1)
    assert.equal(exactWindowCount(onlyNested, 'hot.txt', dir), 0,
      '精确：那个提交**只**改了 `sub/hot.txt`，没碰顶层的 `hot.txt` ⇒ 0')
    const out = g(['log', '--no-walk', '--format=%x1f%h', '--stdin', '--name-only'], onlyNested.join('\n') + '\n')
    const lines = out.split('\x1f')[1].split('\n').map((l) => l.trim()).filter((l) => l !== '')
    assert.ok(lines.slice(1).some((l) => l.endsWith('hot.txt')),
      '夹具前提：`endsWith` 确实会在这一格上命中（于是它会报 1 而精确值是 0）')
    assert.ok(!lines.slice(1).includes('hot.txt'),
      '夹具前提：`includes` 在这一格上**不**命中（于是精确值是 0）')

    // ★★★ 最要紧的一步：让**被测实现**在这个仓库上跑一遍。
    //
    //   上面那些断言只证明"两种判据在这个夹具上分得开"——
    //   而它们**没有**证明 `collectChurn` 用的是对的那种。
    //   实测：把实现里的 `.includes` 换成 `.endsWith`，不跑这一步时
    //   整个套件一条都不红（因为本仓没有互为后缀的两个路径，
    //   而上面那段只验了两种写法"理论上"分得开）。
    //
    //   > 一条证明了"这里有个坑"的用例，
    //   > 与一条证明了"实现没掉进这个坑"的用例，是两件事——
    //   > 而只有后者会在实现掉进去时变红。
    const res = collectChurn({ files: ['hot.txt'], size: 3, windows: 1, cwd: dir })
    assert.equal(res.ok, true, `夹具仓库上 collectChurn 应当可用：${res.reason ?? ''}`)
    const w1 = res.files['hot.txt'].windows[0]
    // 窗口 = 全部 3 个提交（nested-only、other、both）：
    //   · `both`          → 改了**顶层** `hot.txt` ⇒ 算一次
    //   · `nested-only`   → 只改了 `sub/hot.txt`   ⇒ **不算**
    //   · `other`         → 没碰过                 ⇒ 不算
    // 于是精确值是 1；而 `endsWith` 会把 `nested-only` 也算上，给出 2。
    assert.equal(w1.count, 1,
      `窗口 3 个提交里只有 \`both\` 改过**顶层** \`hot.txt\` ⇒ 应为 1；`
      + `实际 ${w1.count}（若为 2，说明实现把 \`sub/hot.txt\` 也算成了 \`hot.txt\`）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 累计次数与最近窗口计数是两个不同的量（不能互相替代）', () => {
  for (const v of Object.values(churn.files)) {
    assert.ok(v.lifetimeCommits >= v.recent, `${v.path} 累计 ${v.lifetimeCommits} 应 ≥ 最近窗口 ${v.recent}`)
  }
})

test('③ 记录了最近一次触及的日期与提交（评审要能追到具体那次改动）', () => {
  for (const v of Object.values(churn.files)) {
    assert.match(v.lastChangeDate, /^\d{4}-\d{2}-\d{2}$/, `${v.path} 缺最近改动日期`)
    assert.match(v.lastChangeCommit, /^[0-9a-f]{7,}$/, `${v.path} 缺最近改动提交`)
    assert.ok(typeof v.lastChangeDistance === 'number' && v.lastChangeDistance >= 0)
    assert.ok(typeof v.lastChangeSubject === 'string' && v.lastChangeSubject.length > 0)
  }
})

test('④ 判定给出理由与阈值，而不是一个孤立的布尔', () => {
  const v = churn.verdict
  assert.equal(typeof v.cooled, 'boolean')
  assert.equal(typeof v.recentMax, 'number')
  assert.equal(typeof v.historicalPeak, 'number')
  assert.equal(typeof v.absoluteBar, 'number')
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0, '判定必须带理由')
  assert.ok(v.recentMax <= churn.windowSize)
})

test('④ 非 git 目录返回可读原因而非抛错（不向 stderr 漏 fatal）', () => {
  // 用新建的临时目录：确定不是任何仓库的一部分（往仓库上层走可能仍是别的仓库）
  const outside = mkdtempSync(join(tmpdir(), 'prt-churn-nogit-'))
  try {
    const res = collectChurn({ cwd: outside })
    assert.equal(res.ok, false)
    assert.match(res.reason, /不是 git 仓库/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
