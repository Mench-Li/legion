// 破验公共件：锚点替换 + 跑判据 + 跑一整轮破验。
//
// ★ 切片 17 起从各片脚本里抽出（"抄就抄错"）。★★★★★ 切片 70 才把它**搬进仓库** ——
//   在那之前它一直住在 `.worktrees/_prt-handoff/`（**未跟踪**的助手区）。
//   把量具留在助手区，等于"守着一份没人能复现的判据"：
//   > 一个「我这套破验一直在跑，所以这些读数可信」的印象，
//   > 与一个「跑它的那个文件**不在仓库里**、随工作树一起消失」的事实，
//   > 在我把它 `git add` 进来之前是同一个东西。
//   （与切片 51「全量回归 82 套件全绿」的错觉同类：读数来自一个不可复现的东西。）
//
// ★ 判据在 `scripts/prt/mutate-lib.test.mjs`（6 例）。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

/** 按"忽略缩进、逐字匹配"把 from 换成 to；to 沿用 from 首行的缩进。
 *
 *  ★★★ 必须**换行符无关**（切片 19）：`git checkout --` 之后 autocrlf 会把文件重新
 *  写成 CRLF，而锚点里写的是 LF。旧实现在 `\n` 上切、不剥尾部的 `\r`，于是
 *  `await r.run(req, res, ctx)\r` 永远不等于 `await r.run(req, res, ctx)` ⇒
 *  锚点"没命中"。这不是锚点写错了，是**同一份内容有两种换行写法**。
 *
 *    > 一个"锚点没命中说明代码变了"的判断，与一个"只是换行符变了"的事实，
 *    > 在我把 `\r` 留着不剥的时候是同一个东西。
 */
export function applyMutation(src, from, to, all = false) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const strip = (s) => s.replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '')
  const bare = (lines) => lines.map((l) => l.replace(/\r$/, '')).join('\n')
  const once = (s) => {
    const lines = s.split(/\r?\n/)
    const indents = lines.map((l) => (l.match(/^[ \t]*/) ?? [''])[0])
    const bareText = lines.map((l, i) => l.slice(indents[i].length).replace(/\r$/, '')).join('\n')
    const want = strip(from)
    const first = bareText.indexOf(want)
    if (first < 0) throw new Error('锚点没命中')
    if (bareText.indexOf(want, first + 1) >= 0 && !all) throw new Error('锚点命中多处')
    const startLine = bareText.slice(0, first).split('\n').length - 1
    const beforeInLine = first - (bareText.lastIndexOf('\n', first - 1) + 1)
    const wantLines = want.split('\n')
    const endLine = startLine + wantLines.length - 1
    const endInLine = wantLines.length === 1 ? beforeInLine + want.length : wantLines.at(-1).length
    const startCol = indents[startLine].length + beforeInLine
    const endCol = indents[endLine].length + endInLine
    const out = lines.slice()
    const head = lines[startLine].slice(0, startCol)
    const tail = lines[endLine].slice(endCol)
    const repl = to === '' ? [] : strip(to).split('\n')
    if (repl.length === 0) out.splice(startLine, endLine - startLine + 1, head + tail)
    else if (endLine === startLine) out.splice(startLine, 1, head + repl.join('\n') + tail)
    else {
      const ind = indents[startLine]
      const b = repl.map((l, k) => (k === 0 ? head + l : ind + l))
      b[b.length - 1] += tail
      out.splice(startLine, endLine - startLine + 1, ...b)
    }
    return out.join(eol)
  }
  let cur = once(src)
  if (!all) return cur
  for (;;) {
    const lines = cur.split(/\r?\n/)
    const indents = lines.map((l) => (l.match(/^[ \t]*/) ?? [''])[0])
    const bareText = lines.map((l, i) => l.slice(indents[i].length).replace(/\r$/, '')).join('\n')
    if (!bareText.includes(strip(from))) return cur
    cur = once(cur)
  }
}

export function makeRunner(target, tests, { timeoutMs = 45000 } = {}) {
  // ★★★★★ 子进程必须**摘掉** `NODE_TEST_CONTEXT`。
  //
  //   `node --test` 会把这个变量**导出给子进程**。于是当"跑破验的进程"本身
  //   也是 `node --test` 起的（比如破验工具自己的判据），
  //   子进程的那次 `node --test <file>` 会认为自己在**嵌套**，打印
  //     `Warning: node:test run() is being called recursively within a test file. skipping running files.`
  //   然后**一个测试文件都不跑**。
  //
  //   后果的形态极其危险：子进程跑 **0** 个测试 ⇒ 输出里没有 `ℹ fail 0`
  //   ⇒ 被读成"没绿" ⇒ 读成"**这个变异被咬住了**"。
  //   于是**每一个变异都"咬住"**，而实际**一个测试都没跑**。
  //
  //     > 一个「我起个子进程跑另一个套件，看它绿不绿」的印象，
  //     > 与一个「父进程是 `node --test`，它把 `NODE_TEST_CONTEXT` 传给了子进程，
  //     > 于是子进程**一个文件都没跑**就说 skipping」的事实，
  //     > 在我看到那行 warning 之前是同一个东西。
  //
  //   ★ 与切片 51 的"代理判据"同类：**读数来自一个什么都没跑的运行**。
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  const run = () => {
    const ran = []
    for (const t of tests) {
      ran.push(t)
      try {
        const o = execFileSync('node', ['--test', t], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: timeoutMs, env })
        if (!/ℹ fail 0/.test(o)) return { green: false, ran: ran.slice() }
      } catch (e) {
        // ★★ 超时要当成"咬住"并**记下来**（切片 19）：
        //   有些变异（比如"先认领再执行"）会让这条端点**永不回响应**，
        //   而 `node:test` 没有默认超时 ⇒ 判据永远不返回 ⇒ 整个破验跑不完。
        //   "端点不再应答"本身就是最响的一种坏法。
        if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
          console.log(`      （${t} 超时 ${timeoutMs}ms —— 端点不再应答，按"咬住"计）`)
          return { green: false, ran: ran.slice() }
        }
        return { green: false, ran: ran.slice() }
      }
    }
    return { green: true, ran: ran.slice() }
  }
  // ★★★ `tests` 是**手工维护**的清单（切片 17 起）。跑完把"我到底跑了哪几个文件、
  //   一共几个测试文件"报出来，好让"清单漏了一个套件"这件事**看得见**。
  run.manifest = () => ({ declared: tests.length, files: tests.slice() })
  return run
}

/** 跑一整轮破验：先证基线绿，逐条改坏、跑判据、还原，最后断言逐字节还原并复绿。
 *
 * ★★★★★ 切片 41/43/46/47/50 各踩过一次的坑（**这条是破验工具自己的缺陷**）：
 *   某条变异的**锚点没命中** ⇒ 旧实现在这里 `throw` ⇒ 整个循环**中断**，
 *   排在它后面的变异**一条都没跑**，而末尾那段总结**永远不会打印**。
 *
 *   于是现象是"输出里一条 `没咬住` 都没有" —— 那**看起来**与"全部咬住"一模一样。
 *   > 一个「破验输出里没有"没咬住"，所以都咬住了」的印象，
 *   > 与一个「脚本在中间那个锚点没命中时**抛异常退出**，后面那些变异**根本没跑**」的事实，
 *   > 在我数输出行数与 `MUT` 条数对不对得上之前是同一个东西。
 *
 *   三道防线：
 *     ① 每条变异**独立 try/catch**，锚点没命中就**记一条并继续**，绝不中断整轮；
 *     ② 总结里**永远**打印 `跑了 N/M 条`，并单列"锚点没命中"那一类；
 *     ③ 锚点没命中 / 真缺口**都**让退出码非零（"没跑成"不等于"通过"）。
 */
export function runMutations(target, tests, MUT, label, { setExitCode = true } = {}) {
  const rec = `${target}.pristine`
  const norm = (s) => s.replace(/\r\n/g, '\n')

  // ★★★ 崩溃安全（切片 19 的教训，**这条是我的破验工具自己的 bug**）：
  //   前几轮的破验跑超时后被 pwsh 杀掉，`finally` 没来得及还原 ⇒
  //   `routes/config.mjs` 被留在 M15（"先认领再执行"）的状态 ⇒
  //   这条端点**永远不回响应**，而现象是"套件卡死"，看上去像产品坏了。
  //
  //     > 一个"我会在 finally 里还原"的保证，与一个"进程可能根本走不到 finally"的事实，
  //     > 在这个进程恰好没有被打断的时候是同一个东西。
  //
  //   三道防线：
  //     ① 开跑前先看有没有上次留下的 `<target>.pristine` ⇒ 有就**先还原**（并响亮说明）；
  //     ② 开跑前把原文件写成 `<target>.pristine`；正常结束才删；
  //     ③ 接 SIGINT/SIGTERM/SIGHUP ⇒ 还原后退出（SIGKILL 接不住，靠 ①② 兜）。
  if (existsSync(rec)) {
    writeFileSync(target, readFileSync(rec))
    unlinkSync(rec)
    console.log(`  ⚠ 发现上一次留下的恢复文件 —— 已先把 ${target} 还原（上一次的运行被杀了）`)
  }
  const ORIG = readFileSync(target, 'utf8')
  // ★ 再核一遍：目标必须与 git 索引一致。否则说明"可能已经被上次运行改坏"，直接拒绝。
  try {
    const indexed = execFileSync('git', ['show', `:${target}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
    if (norm(indexed) !== norm(ORIG)) {
      throw new Error(`${target} 与 git 索引**不一致** —— 拒绝在一个可能已被上次运行改坏的文件上做破验。\n` +
        `  先跑：git checkout -- ${target}`)
    }
  } catch (e) {
    if (/拒绝在一个可能已被上次运行改坏/.test(e.message)) throw e
    console.log(`  （${target} 不在 git 索引里，跳过"与索引一致性"这一道核对）`)
  }

  writeFileSync(rec, ORIG, 'utf8')
  const restore = () => { writeFileSync(target, ORIG, 'utf8') }
  const onSignal = (sig) => {
    restore()
    try { unlinkSync(rec) } catch { /* 已删 */ }
    console.log(`\n  ⚠ 收到 ${sig} —— 已还原 ${target}，退出`)
    process.exit(130)
  }
  const handlers = {}
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = () => onSignal(sig)
    process.on(sig, handlers[sig])
  }

  const run = makeRunner(target, tests)
  const man = run.manifest()
  console.log(`  ${label} 判据清单：**${man.declared}** 个套件`)
  const base = run()
  console.log(`  ${label} 基线：${base.green ? '✔ 套件全绿' : '✖ 基线就是红的'}`)
  assert.ok(base.green, '基线必须是绿的')
  const results = []
  try {
    for (const [name, from, to, opt] of MUT) {
      // ① 每条独立 —— 锚点没命中只影响这一条，绝不中断整轮。
      let m
      try {
        m = applyMutation(ORIG, from, to, opt?.all === true)
      } catch (e) {
        results.push({ name, caught: false, equivalent: false, anchorMissed: true, why: e.message })
        console.log(`  ✖ **锚点没命中（这条没跑成）**  ${name}\n      ${e.message}`)
        continue
      }
      let green
      try { writeFileSync(target, m, 'utf8'); green = run().green } finally { restore() }
      results.push({ name, caught: !green, equivalent: opt?.equivalent === true })
      console.log(`  ${!green ? '✔ 咬住' : opt?.equivalent === true ? '≈ 没咬住（**可证等价**）' : '✖ 没咬住（**真缺口**）'}  ${name}`)
    }
  } finally {
    restore()
    try { unlinkSync(rec) } catch { /* 已删 */ }
    for (const sig of Object.keys(handlers)) process.off(sig, handlers[sig])
  }
  console.log(`\n  逐字节还原：${readFileSync(target, 'utf8') === ORIG ? '✔ 与原始相同' : '✖ 不同'}`)
  assert.equal(readFileSync(target, 'utf8'), ORIG)
  console.log(`  还原后复绿：${run().green ? '✔' : '✖'}`)
  const gap = results.filter((r) => !r.caught && !r.equivalent && !r.anchorMissed)
  const equiv = results.filter((r) => !r.caught && r.equivalent)
  const missed = results.filter((r) => r.anchorMissed)
  const bitten = results.filter((r) => r.caught)
  // ② 永远打印 `跑了 N/M 条` —— "没跑成"必须自己站出来，不能靠读者去数。
  console.log(`\n  **跑了 ${results.length}/${MUT.length} 条**` +
    `（咬住 ${bitten.length}；真缺口 ${gap.length} 条${gap.length ? `（${gap.map((m) => m.name.split('：')[0]).join(', ')}）` : ''}` +
    `；可证等价 ${equiv.length} 条；**锚点没命中 ${missed.length} 条**` +
    `${missed.length ? `（${missed.map((m) => m.name.split('：')[0]).join(', ')}）` : ''}）`)
  if (results.length !== MUT.length) {
    console.log(`  ✖✖✖ **这一轮不完整**：声明了 ${MUT.length} 条、只处理了 ${results.length} 条 —— 读数不可用！`)
  }
  // ③ 真缺口与"没跑成"**都**让退出码非零。
  //
  // ★ 同时**返回**一份结构化总结：这样它能被**判据**检查（而不是只能靠人读输出），
  //   而这个套件自己调用时可以关掉 `setExitCode`，免得把退出码漏给 `node --test` 进程。
  const summary = {
    declared: MUT.length,
    processed: results.length,
    complete: results.length === MUT.length,
    bitten: bitten.map((r) => r.name),
    gaps: gap.map((r) => r.name),
    equivalent: equiv.map((r) => r.name),
    anchorMissed: missed.map((r) => ({ name: r.name, why: r.why })),
    restoredByteIdentical: readFileSync(target, 'utf8') === ORIG,
  }
  const bad = gap.length > 0 || missed.length > 0 || !summary.complete
  if (setExitCode) process.exitCode = bad ? 1 : 0
  return summary
}
