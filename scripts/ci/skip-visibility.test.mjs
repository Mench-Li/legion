// scripts/ci/skip-visibility.test.mjs
// ============================================================================
// 门禁自己的判据：**"跳过了多少条断言"必须出现在摘要里**。
//
// ## 它防的是什么
//
// `run-ci.mjs` 的四处注释都写着「`skipped: N` 看得见」「摘要里留下 `skipped: N`」，
// 而实现里 `counts` 只解析了 `tests` / `pass` / `fail` —— **`skipped` 从来没被解析过**，
// 摘要行里也没有它。于是那两句注释是**假的**，而后果是：
//
//   实测（2026-09-17，本机 `DSH_CHECKOUT` 未设、而那份检出就在 `D:/project/DSH/dsh/`
//   盘上）：四个真进程套件 **38 条断言跳过 20 条**，CI 那四行的读数是
//   `exit=0 tests=38 pass=18 fail=0` —— 摘要里一个字都没说"有 20 条没跑"。
//   把 `DSH_CHECKOUT` 指向那份检出后，同一批变成 **36 pass / 1 skip**。
//
//   > 一个"跳过了 20 条真进程断言"的 PASS，
//   > 与一个"全部跑过"的 PASS，在摘要行上是同一个东西——
//   > 只不过前者的绿来自**没跑**，而注释还在替它保证"看得见"。
//
// ## 这一组钉什么
//
// 不钉 `node --test` 的行为（那是 Node 的），钉**本仓那条解析与汇总**：
//   ① `skipped` 被解析出来（不是靠算 `tests - pass - fail` 反推）；
//   ② 摘要行里带 `skipped=`；
//   ③ 有跳过时**额外汇总一行**，并给出"怎么分辨合法跳过与没配上环境"；
//   ④ `summary.json` 里带 `skippedTotal`；
//   ⑤ 跳过**不判红**（这是刻意的：跳过的合法理由有三种，把它判红会用
//      "所有没装 DSH 的机器 CI 全红"去换一个小得多的故障）。
//
// ★ 用**源码级**断言（读 `run-ci.mjs` 的文本）而不是 import 它：
//   那个文件在被 import 时会跑整个 CLI（顶层有 main），而本组要验的是
//   它**写下的那几行**，不是它跑一次的结果。这与 `encoding-check.test.mjs`
//   是同一个形状。
//
// ★★ 第 35 轮：解析与那半行摘要**搬了家**（搬进 `scripts/ci/parse-suite-output.mjs`），
//   所以本组读**两份**源码。搬家本身带一个风险——**代码搬走了、没人调它**
//   （那正是本仓反复抓的那种"声明了但没接上"），所以额外多一条**接线**断言：
//   `run-ci.mjs` 必须**真的调用**那个模块。搬走之后这一组比原来更严，而不是更松。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'run-ci.mjs'), 'utf8')
/** ★ 第 35 轮起：计数解析与摘要片段在这里。 */
const MOD_SRC = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'parse-suite-output.mjs'), 'utf8')

test('① ★★★ 真的解析了 `skipped`，而不是只解析 tests/pass/fail', () => {
  // 判据必须落在**解析那几行**上。只断言"文件里出现过 skipped"是不够的：
  // 那几句话（"`skipped: N` 看得见"）本来就是注释，而正是它们让这处缺口
  // 看起来像已经处理过了。
  // ★ 第 35 轮：解析在 `parse-suite-output.mjs` 的 `pick()` 那几行里。
  const m = /const tests = pick\([\s\S]*?return \{ tests: tests\.last[^\n]*/.exec(MOD_SRC)
  assert.ok(m !== null, '找不到 pick 那段——本组要验的对象已经不在了，先更新这一组')
  const block = m[0]
  for (const key of ['tests', 'pass', 'fail', 'skipped']) {
    assert.match(block, new RegExp(`\\b${key}:\\s*${key}\\.last`),
      `没有解析 ${key}（` + '`skipped` 漏掉时，摘要行无法说出"有几条没跑"）')
    assert.match(block, new RegExp(`const ${key} = pick\\(/\\\\b${key}\\\\s`),
      `${key} 的取值正则不在——解析器改形状了`)
  }
  // 反向：`skipped` **不能**是用 `tests - pass - fail` 算出来的。
  // 算出来的读数与解析出来的读数，在"跳过的是哪一批"上不是同一件事。
  assert.doesNotMatch(MOD_SRC, /skipped:\s*[^,]*-\s*counts\.pass/,
    '`skipped` 是反推出来的——反推不会告诉你跳过的是哪一批，也不该冒充解析')
})

test('①b ★★★ 接线：`run-ci.mjs` 必须**真的调用**那个模块（搬走了不等于接上了）', () => {
  // 没有这一条，"解析器存在"与"CI 用它解析"就分开了：
  // 把代码搬进一个没人 import 的文件里，①② 可以照样绿，而 CI 的读数回到原样。
  assert.match(SRC, /import \{[^}]*parseSuiteCounts[^}]*\} from '\.\/parse-suite-output\.mjs'/,
    '`run-ci.mjs` 没有 import 计数解析器（代码搬走了、没人调它）')
  assert.match(SRC, /const counts = parseSuiteCounts\(all\)/,
    '`run-ci.mjs` 没有真的调用 `parseSuiteCounts(all)`')
  assert.match(SRC, /label \+ ': exit=' \+ r\.code \+ ' ' \+ countsFragment\(counts\)/,
    'detail 行没有用 `countsFragment(counts)`——摘要行又回到手写那几个数了')
})

test('② ★★ 摘要行里带 `skipped=`（跳过数不再是"要靠减法才知道"的那个数）', () => {
  // ★ 第 35 轮：那半行搬进了 `countsFragment()`。
  assert.match(MOD_SRC, /skipped=' \+ \(Number\.isNaN\(counts\.skipped\)/,
    '摘要片段里没有 skipped= —— 于是 `tests=38 pass=18 fail=0` 这一行既可以说'
    + '"20 条跳过了"，也可以说"这 38 条就是这么分类的"，而读的人只能自己减')
})

test('③ ★★ 有跳过时**额外汇总一行**，且给出"怎么分辨合法跳过与没配上环境"', () => {
  // 为什么需要一个**总**数而不只是逐套件的 `skipped=N`：
  // 逐套件的那几十行在 CI 输出里散得很开，而人读的是 `test PASS` 那一行。
  assert.match(SRC, /const totalSkipped = skippedSuites\.reduce/,
    '没有跨套件的跳过总数——"这次一共跳了多少条"在几十行里是读不出来的')
  assert.match(SRC, /⚠ 跳过 \$\{totalSkipped\} 条断言/,
    '没有那一行汇总输出')
  // ★ 最要紧的一句：跳过**不一定**是坏事，而 `skipped=N` 这一个数字
  //   分不出"这台机器不该有这些跳过"与"这台机器正好缺那样东西"。
  assert.match(SRC, /const SKIPPED_NOTE/,
    '没有 SKIPPED_NOTE —— 一个不解释的 `skipped=N` 会让人以为跳过一定是缺陷')
  // 取值到**下一个语句**为止（不是到空行为止：常量与函数之间只有一个换行，
  // 而"锚点依赖空行"这种写法会在有人顺手删掉一个空行时假红）。
  const note = /const SKIPPED_NOTE = ([\s\S]*?)\n(?!\s*\+)/.exec(SRC)
  assert.ok(note !== null, 'SKIPPED_NOTE 的形状变了，先更新这一组')
  for (const phrase of ['合法', 'DSH_CHECKOUT']) {
    assert.ok(note[1].includes(phrase),
      `SKIPPED_NOTE 里没有提到「${phrase}」——它必须说到能**分辨**为止，`
      + '否则读的人只会得到"这里跳过了 21 条"这一个数字')
  }
})

test('④ ★★ `summary.json` 里带 `skippedTotal`，SUMMARY 每一行带 `skipped=`', () => {
  // summary.json 是机器读的那一份：报告、工单、后续比对都从它取数。
  // 它不带 skippedTotal 时，任何"这次跑了什么"的自动化都看不见跳过。
  assert.match(SRC, /failed, skippedTotal,/, 'summary.json 里没有 skippedTotal 字段')
  assert.match(SRC, /r\.name\.padEnd\(6\) \+ ' ' \+ r\.status[\s\S]{0,80}skipped=/,
    'SUMMARY 的每一行没有跟着 skipped= —— 那一行是唯一会被贴进对话/工单的地方')
})

test('⑤ ★★ 跳过**不判红**（刻意的取舍，不是漏了）', () => {
  // 判据：`ok` 仍然只由 exit code 与 fail 数决定，跳过数不进 `ok`。
  // 这条**反向**断言比正向那条更要紧：一个"有跳过就 FAIL"的门禁，
  // 会让所有没装 DSH 的机器（以及 posix 上的 win32 分支）CI 全红，
  // 而那时人们会去关掉整道门禁——用一个**大得多**的故障换一个小故障。
  const m = /const ok = r\.code === 0[^\n]*/.exec(SRC)
  assert.ok(m !== null, '找不到 ok 的计算')
  assert.doesNotMatch(m[0], /skipped/,
    '`ok` 里出现了 skipped —— 那会让"没装 DSH 的机器"整片 CI 变红。'
    + '跳过的正确处置是**变成读数**，不是变成红')
  // 而 summary.json 的 process.exit 也只由 failed 决定。
  assert.match(SRC, /process\.exit\(failed === 0 \? 0 : 1\)/,
    'CI 的退出码不再只由 failed 决定——跳过数可能被塞进了退出码')
})

test('⑥ ★ 反向：本组自己不能是"读注释就算过"的那种判据', () => {
  // 自检：上面每一条都必须能**具体地**失败。做法是验它们用的锚点
  // 在文件里真实存在且**不是**注释行——`①` 第一次写时就踩过这个坑
  // （锚点命中了注释里抄的那份旧代码）。
  const lineOf = (src, re) => src.split('\n').findIndex((l) => re.test(l))
  for (const [src, re, what] of [
    [MOD_SRC, /const tests = pick\(/, '解析器（pick 段）'],
    [MOD_SRC, /skipped=' \+ \(Number\.isNaN/, '摘要片段的 skipped='],
    [SRC, /const counts = parseSuiteCounts\(all\)/, 'run-ci 的接线'],
    [SRC, /const totalSkipped = skippedSuites\.reduce/, '跳过总数'],
  ]) {
    const i = lineOf(src, re)
    assert.ok(i >= 0, `${what} 找不到`)
    assert.doesNotMatch(src.split('\n')[i].trim(), /^\/\//,
      `${what} 的锚点落在**注释**里（第 ${i + 1} 行）——` +
      '一个锚在注释上的判据会在代码改坏之后仍然全绿')
  }
})
