#!/usr/bin/env node
// scripts/prt/hot-file-churn.mjs
// ============================================================================
// 热点文件改动节奏探针（阶段 3 评审闸门用）
//
// 回答一个问题：`plugins/src/index.ts` 与 `team-hub/server.mjs` 的日更节奏
// **降温了吗**？阶段 3（PRT-315/316）要重写这两个文件，在途功能若还在改它们，
// 冲突不是「分支对不上」而是「持续追着 main 跑」。
//
// ## 为什么需要一个工具，而不是随手跑一句 git log
//
// 因为**随手跑的那句是错的**。这两种写法看着像，结论完全不同：
//
//   git log -n 40 -- <file>        ❌ 先按路径过滤，再取 40 条
//                                    → 只要该文件被改过 ≥40 次，永远返回 40，
//                                      「最近 40 个提交都在改它」这一假象
//   git rev-list -n 40 HEAD        ✅ 先取最近 40 个提交，再数其中几个碰了该文件
//   git log <oldest>^..HEAD -- <f>
//
// 本工具用后者。第一版我用了前者，得出「两个文件在最近 40 个提交里被改了 40 次」，
// 差点据此判定「不能开工」；修正后是 1/40 与 2/40——**结论正好相反**。
// 一个会把「该开工」读成「不能开工」的测量方法，比没有测量更糟。
//
// 另注：`git log -- <file> | wc -l` 给出的是**全history累计**次数（实测 52 / 39），
// 它常被误当成「近期频率」——原计划里的「近 60 个提交被改 51/35 次」就是这一类。
//
// 用法：
//   node scripts/prt/hot-file-churn.mjs
//   node scripts/prt/hot-file-churn.mjs --json
//   node scripts/prt/hot-file-churn.mjs --window=40 --windows=6
//   node scripts/prt/hot-file-churn.mjs --help
//
// ## ★ 退出码（2026-09-21 复核后补）
//
// 三个码各说一件事，**不合并**：
//
//   0  读到了，判定「已降温」
//   2  **读不到**（不是 git 仓库 / HEAD 解不开）——这是一个**坏掉的读数**
//   3  读到了，判定「未降温」（仅在 `--strict` 下；不加则仍是 0）
//
// ★ 2 与 3 必须分开，虽然它们"都是非 0"。第一版把两者都给了 2，而那正好是
// 本文件要防的那类错的重演：
//
//   > 一个"闸门读不到"的读数，与一个"闸门读到了、判定不该开工"的读数，
//   > 在只看退出码的调用方眼里是同一个东西——只不过前者要修的是探针，
//   > 后者要修的是排期。
//
// 而调用方恰好会同时需要这两件事：CI 要把"未降温"如实**记下来**（那不是失败），
// 却应当把"读不到"当成一件要人看的事。见 `run-ci.mjs` 的 `stageDoc`。
//
// 默认**不**因判定而变（不加 `--strict` 时"未降温"也给 0）：未降温是本探针的
// **正常输出**，不是运行失败——本文件自己的单测要在这棵工作树上跑，
// 若未降温就非 0，每个在途提交都会把 CI 弄红。
// ============================================================================
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 阶段 3 要动的两个大文件（也是历史上争用最激烈的两个）。 */
export const HOT_FILES = Object.freeze([
  'plugins/src/index.ts',
  'team-hub/server.mjs',
])

/**
 * 把「最近 total 个提交」切成 size 大小的连续窗口（从新到旧）。
 *
 * 抽成纯函数是因为这里的边界最容易被写错（off-by-one 会让窗口重叠或跳过），
 * 而它又是整个探针的结论来源。窗口用**提交下标**表示，闭开区间 `[from, to)`。
 */
export function windowRanges(total, size, maxWindows) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`window 必须是正整数，收到 ${size}`)
  if (!Number.isInteger(maxWindows) || maxWindows <= 0) throw new Error(`windows 必须是正整数，收到 ${maxWindows}`)
  const out = []
  for (let i = 0; i < maxWindows; i++) {
    const from = i * size
    const to = Math.min(from + size, total)
    if (from >= total) break
    out.push({ from, to, rank: i + 1, complete: to - from === size })
  }
  return out
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * 与 `git` 相同，但**吞掉 stderr**。
 *
 * 「不是 git 仓库」这类探测失败是**预期分支**，git 会往 stderr 打一行 fatal；
 * 不吞掉它，调用方（含测试输出与 CI 日志）会看起来像出错了。
 */
function tryGit(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * 与 `git` 相同，但把**一批提交哈希从 stdin 喂进去**。
 *
 * 为什么要 stdin 而不是把它们拼进 argv：窗口大小是命令行给的
 * （`--window=N`），N 大起来（几百到几千）时 40 字符一个哈希会撑爆
 * Windows 的 argv 上限，而**那时的表现是 `git` 报一个与本次测量毫无关系的
 * 错误**（"文件名或扩展名太长"），读的人会去查那个不存在的文件。
 *
 * `stdio` 的 stdin 设成 `pipe`（要喂数据），stdout 照常、stderr 也留着
 * （这一条不吞 stderr：它只在"窗口的哈希真的不在这个仓库里"时才失败，
 * 而那是一种**我们想知道**的失败，不是一个预期分支）。
 */
function gitWithStdin(args, input, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * 数「窗口里的这 N 个提交」有几个碰了某个文件。
 *
 * ## 为什么不能写成 `<oldest>^..<newest> -- <file>`
 *
 * 那是本探针的第一版，注释写着「语义正是『这 40 个提交里有几个碰了该文件』」。
 * **那句话在带合并的历史上是错的**，而本仓的历史**满是合并提交**
 * （`--merges` 数出 101 个）。原因是 `A^..B` 的语义是「B 可达且 A^ 不可达」，
 * 于是 **B 经过合并的第二个父亲能带进来一大批不在窗口里的提交**。
 *
 * 实测（2026-09-17，`HEAD=eed4058`，窗口 40，本仓）：
 *
 * ```text
 * 窗口 1  plugins/src/index.ts   区间写法 9  / 精确 1     ← 多算 9 倍
 * 窗口 1  team-hub/server.mjs    区间写法 41 / 精确 9     ← 超过窗口大小
 * 窗口 6  team-hub/server.mjs    区间写法 9  / 精确 10    ← 这个方向又少算
 * 区间里的提交数（窗口 1）        217（而窗口只有 40）
 * ```
 *
 * 两个方向都错。而**多算那一边正是本文件头警告过的那件事**：
 *
 *   > 一个会把「该开工」读成「不能开工」的测量方法，比没有测量更糟。
 *
 * 窗口 1 的真实答案是 1（该文件已经降温），区间写法却说 9；
 * 而 9 会把 `recentMax <= 2` 的判据推成「没降温，不能开工」。
 * 第一版手工发现的那个"结论正好相反"的坑，**换了个地方又长回来了**。
 *
 * 而且它还会触发 `hot-file-churn.test.mjs` 那条守卫
 * （`count <= windowSize`）并给出**完全错误的诊断**：
 *
 * ```text
 * team-hub/server.mjs 第 1 窗口计数 41 > 40：可能又改成错误写法了
 * ```
 *
 * 它把一个**测量方法的缺陷**说成了一次**实现回归**。
 *
 * ## 为什么也不能写成 `git log --no-walk --stdin -- <file>`
 *
 * 这是本轮的**第二次**修法，它同样是错的——而且错得更隐蔽：
 * `--no-walk` 让 git 不再做历史行走，于是**路径过滤整个失效**，
 * 输出恒等于喂进去的那 N 个提交。实测：本仓每个窗口每个文件都恒返回
 * `40/40`，两条漂亮的满格条形图，而窗口 2 的真实答案是 0。
 *
 *   > 一个"每个格子都是 40/40"的探针，看起来像一份**最坏**的报告，
 *   > 于是它骗人的方向是"让人不敢开工"——
 *   > 而它其实什么都没测，因为路径过滤被那面 `--no-walk` 的旗子关掉了。
 *
 * ## 正确写法：让 git 自己说出每个提交动了哪些文件
 *
 * ```text
 * git log --no-walk --format=%x1f%h --stdin --name-only    ← 哈希从 stdin 喂
 * ```
 *
 * `--no-walk` 保证**只**看喂进去的这 N 个提交（这正是我们要的集合），
 * `--name-only` 让 git 逐个提交列出它改动的文件——**路径过滤交给我们自己做**，
 * 于是它不会再被 `--no-walk` 关掉。
 *
 * 用 `%x1f`（unit separator）而不是换行做提交分隔：文件名里可以出现任何
 * 非 NUL 字节（包括形如短哈希的字符串），拿"第一行是哈希"去解析会在
 * 某个恰好这么命名的文件上崩掉。`\x1f` 不会出现在路径里。
 *
 * ⚠️ 边界：这一条数的是"**这次提交本身**改了这个文件"。
 * 合并提交在默认 diff 下不显示改动，因此**不计入**——这既是我们想要的
 * （一次合并不是一次"改动"），也与「先按路径过滤再截断」那种写法在
 * 合并上的行为一致。它**不能**用来回答"这个文件历史上被改过多少次"：
 * 那个量是 `lifetimeCommits`，由另一条命令（全 history 的 `git log -- <file>`）算。
 */
function countWindowTouches(slice, file, cwd = ROOT) {
  const out = gitWithStdin(
    ['log', '--no-walk', '--format=%x1f%h', '--stdin', '--name-only'],
    slice.join('\n') + '\n',
    cwd,
  )
  let n = 0
  for (const chunk of out.split('\x1f')) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    if (lines.length === 0) continue
    // 第一行是这个提交的哈希，其余是它改动的文件路径
    if (lines.slice(1).includes(file)) n++
  }
  return n
}

/**
 * 采集改动节奏。
 */
export function collectChurn({ files = HOT_FILES, size = 40, windows = 6, cwd = ROOT } = {}) {
  const head = tryGit(['rev-parse', 'HEAD'], cwd)
  if (!head) return { ok: false, reason: '不是 git 仓库，或 HEAD 无法解析' }

  /**
   * ★★★ 用**刚解析出来的那个哈希**，而不是再写一次 `HEAD`。
   *
   * 这里此前是 `git rev-list HEAD`——于是本函数内部就有一次竞态：
   * `rev-parse HEAD` 与 `rev-list HEAD` 之间若有新提交落地，
   * 两次读到的就是**两个不同的历史**，而本函数会把它们当成同一个
   * （`head` 报的是旧的、`all` 数的是新的）。
   *
   * 这不是理论问题：本仓有**另一个会话在同时提交**。实测一次 CI（2026-09-18
   * 04:23–04:36 UTC）期间落了 3 个提交（`69da8fd`/`5c1d698`/`4046dd4`），
   * 于是 `hot-file-churn.test.mjs` 的用例 ③ 红了——它红的原因与
   * "窗口切分对不对"毫无关系，只是**两次读之间有人提交**。
   *
   *   > 一个在模块加载时读一次仓库、在用例里再读一次的判据，
   *   > 在有人同时提交的仓库里，测的是"这两次读之间有没有人提交"。
   *
   * 快照必须是一个**具体的提交**；`HEAD` 是一个会动的名字，不是快照。
   */
  const all = git(['rev-list', head], cwd).split('\n').filter(Boolean)
  const ranges = windowRanges(all.length, size, windows)
  // ★ 交出去之前先挡一次**空读数**（2026-09-21 复核后补）。
  //
  // 这里的 `perFile` 是**每个文件**各量一次；只要 `recentMax` 落在 ≤2 那一侧，
  // 判定就是「已降温」。而**一个文件都没取到读数**时 `recentCounts` 是空数组、
  // `Math.max(...[], 0)` 恰好等于 **0** ⇒ `0 <= 2` ⇒ **判「已降温」**。
  //
  //   > *一个"量了、且最近确实没动过"的读数，与一个"一个文件都没量到"的读数，
  //   > 在判定那一行上是同一个东西——只不过后者的结论是**反的**：
  //   > 它把"什么都不知道"印成了"可以安排开工"。
  //
  // 正常调用永远取不到这条分支（`files` 默认是那两个热点文件），
  // 所以它是一条**便宜的自检**，不是日常路径。
  if (all.length === 0) {
    return { ok: false, reason: `空读数：提交数 ${all.length}——不判定` }
  }

  const perFile = {}
  for (const f of files) {
    const lifetime = git(['log', '--format=%h', '--', f], cwd).split('\n').filter(Boolean).length
    const lastHash = tryGit(['log', '-1', '--format=%H', '--', f], cwd)
    const lastDistance = lastHash ? all.indexOf(lastHash) : null
    const lastMeta = lastHash
      ? git(['log', '-1', '--format=%ad|%h|%s', '--date=short', '--', f], cwd).split('|')
      : null

    const perWindow = ranges.map((r) => {
      // 窗口的**那 N 个哈希本身**（就是切出来的那一片），逐个交给 git。
      const slice = all.slice(r.from, r.to)
      const count = countWindowTouches(slice, f, cwd)
      return { rank: r.rank, from: r.from + 1, to: r.to, count, complete: r.complete }
    })

    perFile[f] = {
      path: f,
      lifetimeCommits: lifetime,
      lastChangeDistance: lastDistance,
      lastChangeDate: lastMeta?.[0] ?? null,
      lastChangeCommit: lastMeta?.[1] ?? null,
      lastChangeSubject: lastMeta?.[2] ?? null,
      windows: perWindow,
      recent: perWindow[0]?.count ?? null,
    }
  }

  // 判定：最近一个窗口里「任何热点文件」被触及的次数。
  //
  // 阈值取**绝对值 2**，而不是与历史峰值比比例：阶段 3 的风险来自
  // 「我改这个文件时别人也在改」，2/40 意味着大约每 20 个提交才撞一次，
  // 手工 rebase 完全可承受；比例判据在历史峰值本身很低时会误判「未降温」。
  // 同时要求 recentMax ≤ 历史峰值——否则说明这是史上最热的窗口，不该开工。
  // `historicalPeak` 取 rank>1 的窗口，避免拿自己跟自己比。
  //
  // ★ 先挡"一个文件都没量到"（2026-09-21 复核后补）：`recentCounts` 为空时
  //   `Math.max(...[], 0)` 恰好是 **0**，而 `0 <= 2` ⇒ **判「已降温」**。
  //   *一个"量了、且最近确实没动过"的读数，与一个"一个文件都没量到"的读数，
  //   在判定那一行上是同一个东西——只不过后者的结论是**反的**。*
  if (Object.keys(perFile).length === 0) {
    return { ok: false, reason: `空读数：取到读数的文件数 0（files=${JSON.stringify(files)}）——不判定` }
  }
  const recentCounts = Object.values(perFile).map((v) => v.recent ?? 0)
  const busiestPast = Math.max(
    ...Object.values(perFile).flatMap((v) => v.windows.filter((w) => w.rank > 1).map((w) => w.count)),
    0,
  )
  const recentMax = Math.max(...recentCounts, 0)
  const COOLED_ABSOLUTE_BAR = 2
  // ★ 判定仍必须由**两个**量同时成立才算降温：
  //   · 绝对阈值（≤2）——阶段 3 的风险来自"每落一个提交都要手工 rebase"，绝对值才是那个风险；
  //   · 且不高于历史峰值——"最近比历史更热"时，即使这个数很小也不该判降温
  //     （历史峰值本身很低时，比比例判据可靠）。
  //   ⚠️ 第二个条件在历史峰值恒 ≥1 时恒真（`Math.max(busiestPast, 1)`）；
  //      它在 `busiestPast === 0`（整段历史一次都没碰过热点文件）时才会咬住。
  const cooled = recentMax <= COOLED_ABSOLUTE_BAR && recentMax <= Math.max(busiestPast, 1)
  return {
    ok: true,
    head: head.slice(0, 7),
    /**
     * ★ 本次采集**实际用的那个提交**（完整哈希）与它展开的提交表。
     *
     * 交出去是为了让"交叉核对"的调用方对着**同一份快照**核，
     * 而不是自己再读一次 `HEAD`。见上面 `all` 那段：
     * 在共享工作树上，两次读 `HEAD` 之间随时可能有人提交。
     */
    headFull: head,
    revList: Object.freeze(all.slice()),
    totalCommits: all.length,
    windowSize: size,
    files: perFile,
    verdict: {
      recentMax,
      recentPerFile: Object.fromEntries(Object.entries(perFile).map(([k, v]) => [k, v.recent])),
      historicalPeak: busiestPast,
      absoluteBar: COOLED_ABSOLUTE_BAR,
      cooled,
      reason: cooled
        ? `最近 ${size} 个提交中任一热点文件最多被触及 ${recentMax} 次（阈值 ≤${COOLED_ABSOLUTE_BAR}），历史峰值 ${busiestPast}`
        : `最近 ${size} 个提交中热点文件被触及 ${recentMax} 次（阈值 ≤${COOLED_ABSOLUTE_BAR}），历史峰值 ${busiestPast}`,
    },
  }
}

// ---------------------------------------------------------------------------
// 退出码的**唯一**映射（纯函数，2026-09-21 复核后补）
//
// 抽出来是为了让两条反向控制能对着**夹具**跑：
//
//   ① `main()` 里的 `collectChurn` 用模块级 `ROOT`，**不接受 cwd 参数**，
//      所以从夹具目录 spawn 本 CLI 读到的**永远是本仓**——夹具那几条只能直接
//      调 `collectChurn({cwd})`，走不到退出码那一行；
//   ② 于是"降温 ⇒ 0 / 未降温 ⇒ 3 / 读不到 ⇒ 2"这三支里，
//      真仓今天只能走到"未降温"那一支，另外两支**一次都没被走到**。
//
//   > 一支没被走到的分支，与一支不存在的分支，在用例数上是同一个东西。
//
// 映射写成纯函数之后，三支都能被钉住，而 `main()` 只是它的一个调用方。
//
//   0  读到了，判定「已降温」
//   2  **读不到**（`ok === false`）——探针坏了，读数不可信
//   3  读到了，判定「未降温」（仅在 `strict` 下；否则 0）
// ---------------------------------------------------------------------------

/**
 * 三种**互不相同**的退出码，具名导出。
 *
 * 调用方（`run-ci.mjs` 的 `doc` 阶段）必须用这些常量分流，不许写裸数字：
 * 裸数字那版被破验当场证伪过一次（`scratch/_mutate-r115-churn.mjs` 的 M6）——
 * 把 `rh.code === 3` 误改成 `rh.code === 2` 时，**没有任何判据会红**，
 * 而"探针读不到"那条告警会静默变成死代码。
 *
 *   > 一个"合并两个退出码"的改动，与一个"两个码本来就是一个"的实现，
 *   > 在只看源码（`2`/`3` 散落在条件里）的时候是同一个东西。
 *
 * 所以这里给名字，CI 侧按名字分流 —— 名字对不上就是 `undefined`，
 * 而不是一个"恰好等于另一个码"的数字。
 */
export const CHURN_EXIT = Object.freeze({
  COOLED: 0,
  UNREADABLE: 2,
  NOT_COOLED: 3,
})

/**
 * 退出码映射。**只**由这里决定，`main()` 不许自己再写一份。
 *
 * @param {{ok: boolean, cooled?: boolean}} res `collectChurn` 的返回
 * @param {{strict?: boolean}} [opts]
 * @returns {0|2|3}
 */
export function exitCodeFor(res, { strict = false } = {}) {
  if (!res || res.ok !== true) return CHURN_EXIT.UNREADABLE
  if (!strict) return CHURN_EXIT.COOLED
  // `verdict` 缺席时**不能**当好话来读：一个没有判定的运行与一个判成"降温"的
  // 运行，在只看退出码的调用方眼里是同一个东西——所以缺判定按最保守的 3 收场。
  if (res.verdict?.cooled !== true) return CHURN_EXIT.NOT_COOLED
  return CHURN_EXIT.COOLED
}

function usage() {
  console.log('hot-file-churn.mjs — 热点文件改动节奏探针（阶段 3 评审闸门）')
  console.log('')
  console.log('  --window=<n>    窗口大小（默认 40）')
  console.log('  --windows=<n>   窗口个数（默认 6）')
  console.log('  --json          机器可读')
  console.log('  --strict        判定「未降温」时以退出码 3 收场（见文件头那段）')
  console.log('  --help          本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const size = Number(argv.find((a) => a.startsWith('--window='))?.slice('--window='.length)) || 40
  const windows = Number(argv.find((a) => a.startsWith('--windows='))?.slice('--windows='.length)) || 6

  const res = collectChurn({ size, windows })
  const code = exitCodeFor(res, { strict: argv.includes('--strict') })
  if (!res.ok) {
    console.error(`FAIL ${res.reason}`)
    process.exit(code)
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2))
    return
  }

  console.log(`HEAD ${res.head}　共 ${res.totalCommits} 个提交　窗口 ${res.windowSize}`)
  console.log('')
  for (const v of Object.values(res.files)) {
    console.log(`${v.path}`)
    console.log(`  累计触及 ${v.lifetimeCommits} 次（**全history**，不是近期频率）`)
    console.log(`  最近一次：${v.lastChangeDate} ${v.lastChangeCommit}（${v.lastChangeDistance} 个提交之前）`)
    console.log(`            ${v.lastChangeSubject}`)
    for (const w of v.windows) {
      const bar = '█'.repeat(w.count)
      console.log(`  第 ${String(w.from).padStart(3)}–${String(w.to).padStart(3)} 个提交  ${String(w.count).padStart(3)}/${res.windowSize}  ${bar}`)
    }
    console.log('')
  }
  const v = res.verdict
  console.log(`判定：最近 ${res.windowSize} 个提交中任一热点文件最多被触及 ${v.recentMax}/${res.windowSize}，历史峰值 ${v.historicalPeak}/${res.windowSize}`)
  console.log(`      ${v.reason}`)
  // ★ 给调用方一行**机器可读**的结论（2026-09-21 复核后补）。
  //
  //   `run-ci.mjs` 的 `doc` 阶段要把这一行如实记进 CI 日志，而它此前只能去
  //   **猜文案**（匹配「已降温」/「未降温」）——*一个靠匹配中文措辞来判断
  //   机器状态的调用方，会在这句话被改写的那天静默失准*，而措辞是最容易改的。
  //   所以这里给一个稳定形状，让 CI 解析它、不再解析散文。
  console.log(`CHURN_VERDICT cooled=${v.cooled} recentMax=${v.recentMax}/${res.windowSize} historicalPeak=${v.historicalPeak}/${res.windowSize} head=${res.head}`)
  console.log(v.cooled
    ? '  → **已降温**：阶段 3 的文件争用风险低，可安排开工'
    : '  → **未降温**：在途功能仍在改这两个文件，阶段 3 应推迟')
  // 退出码由 `exitCodeFor` 单独决定（纯函数，三支都能被夹具钉住）。
  // 不在这里再写一份判断：两份判断迟早会分叉，而分叉的那天没人会知道。
  process.exitCode = code
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
