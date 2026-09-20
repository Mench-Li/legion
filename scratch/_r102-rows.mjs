// scratch/_r102-rows.mjs —— 第 102 轮：修掉 CI 里"登记闸门当场 return"⇒ 它一直把全部测量吞掉
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 48)}`); return }
  t = t.replace(f, tt)
}
sub('**第 101 轮结束时的读数**（全部可复跑）：', '**第 102 轮结束时的读数**（全部可复跑）：')
sub('本文件已**复核到第 101 轮**', '本文件已**复核到第 102 轮**')

const ANCHOR = '#### ★★★★★ 第 101 轮：顺着第 100 轮那个洞'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 101 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 102 轮：**修掉我自己那个"会让 CI 撒谎"的洞** —— 而它当场翻出一个我 40 轮没见过的东西',
    '',
    '第 100 轮里程碑量到：全量 9 阶段里 `test` FAIL、**4974ms** 就退了。',
    '★ 当时我的结论是"它挡住了产品侧那 22 条红"。',
    '★★★★★ **本轮我顺着那 4974ms 去读代码，发现那个数比我想的更糟** ——',
    '',
    '```js',
    'if (missing.length > 0) {',
    '  return { ok: false, detail: ... }   // ← 当场 return',
    '}',
    'for (const s of suites) { ... 跑每个套件 ... }   // ← 这一行从来没被执行到',
    '```',
    '',
    '⇒ **那扇"套件清单不完备"的闸门在 L4384 直接 return，而跑套件的 for 循环在它后面** ——',
    '所以 `test` 阶段**一个用例都没跑**，`4974ms` 全部花在"清点文件、发现 30 个没登记"上。',
    '',
    '> ★★★★★ 一个"清单不完备所以整个阶段不跑"的设计，与一个"清单不完备、但**产品照样量一遍**"的设计，',
    '> 在"这次 CI 说明了产品什么"这件事上不是同一个东西：',
    '> **前者只说明清单错了，后者同时说明产品现在什么样。**',
    '',
    '#### ★★★ 而这条闸门的注释里，写着它当初**为什么**存在',
    '',
    '`run-ci.mjs` 在那段旁边留着一句（2026-09-16 合并时补的）：',
    '',
    '> 21 条断言一次都不会跑，**而 CI 摘要上看不出任何异常**。',
    '',
    '⇒ 它当年修的正是"摘要上看不出异常"。**而它自己的 return 又造出了同一个病**：',
    '「`test FAIL`」这一行下面**什么都没量** —— 摘要上看得出异常，却**看不出产品哪里异常**。',
    '',
    '#### ★ 修法：判定不变，只是不许它把后面的测量一起吞掉',
    '',
    '```js',
    'let listingIncomplete = false          // 记下这条失败，继续往下跑',
    '...',
    'return { ok: allOk && !listingIncomplete, ... }   // 结论与从前一致',
    '```',
    '',
    '#### ★★★★★ 而这一改，当场翻出一个**我 40 轮没见过**的套件',
    '',
    '| | 修前 | 修后 |',
    '|---|---|---|',
    '| `test` 阶段耗时 | **4974ms** | **1020036ms（约 17 分钟）** |',
    '| 跑到的套件数 | **0** | **全部** |',
    '| 报告出来的失败套件 | 1 条闸门 | 闸门 + **6 个真套件** |',
    '',
    '★★★ **新露出来的那个是 `model-config`（PRT-252）**：',
    '',
    '```',
    'FAIL model-config（PRT-252：校验不了 ≠ 配置错了 / 合法 ≠ 能跑 / 配置错误要在配置时说出来）:',
    '     exit=1 tests=18 pass=17 fail=1',
    '     FAIL: ✖ **路由真的接上了校验**（这条守的是"接线被拔掉"）',
    '```',
    '',
    '⇒ **`17 通过 / 1 失败`，而它此前从未出现在任何一次读数里** ——',
    '既不在我报的"5 套件 / 22 条红"里（**那个数是不完整的**），也不在第 100 轮那次 8/9 的 CI 里。',
    '',
    '#### ★★★★★ 而它的根因，与第 91 轮那条**是同一个**（逐条读核过，不是"看着像"）',
    '',
    '那条用例（`runtime/contracts/model-config.test.mjs:221`）在 L232 只读**一个文件**：',
    '',
    '```js',
    "const src = readFileSync(new URL('../../team-hub/server.mjs', import.meta.url), 'utf8')",
    "assert.match(src, /validateAgentModelSelection\\(\\{ provider, model, profiles: modelStore\\.list\\(\\) \\}\\)/)",
    "assert.match(src, /throw modelConfigErrorFor\\(verdict\\)/)",
    "assert.match(src, /if \\(typeof e\\?\\.field === 'string'\\) extra\\.field = e\\.field/)",
    '```',
    '',
    '★ 实测那三处要找的代码**现在在哪**：',
    '',
    '| 断言要找的字符串 | 现在在哪 |',
    '|---|---|',
    '| `validateAgentModelSelection({...})` | **`team-hub/routes/models.mjs`** ← 被搬走了 |',
    '| `throw modelConfigErrorFor(verdict)` | **`team-hub/routes/models.mjs`** ← 被搬走了 |',
    '| `if (typeof e?.field === \'string\') extra.field = e.field` | `team-hub/server.mjs` ← 还在 |',
    '',
    '⇒ **3 条断言里 2 条失败，正是因为那个 handler 搬去了 `routes/models.mjs`** ——',
    '而 `server.mjs` 现在 5637 行、`routes/` 下 **49 个文件**。',
    '',
    '★★★ 所以"**源码断言把一个文件钉死**"这一族，现在是 **2 条用例 / 2 个套件**：',
    '`model-api` ③（「每条路径都必须在平台契约里真实存在」）与 `model-config`（「路由真的接上了校验」）。',
    '两条都是并行会话那次路由迁移的落地余波。',
    '',
    '#### ★ 一条我必须写下来的代价',
    '',
    '`test` 阶段现在要跑 **约 17 分钟**（从前是 5 秒 —— 因为什么都没跑）。',
    '★ 这不是本修改引入的成本，而是**那份成本一直都在、只是从前被藏起来了**。',
    '⚠ 而它带来一个实际约束：CI 单条命令的时限是 **600s** ⇒ 现在**必须**在后台/更长时限里跑 `run-ci.mjs`，',
    '否则会在跑完之前被杀掉。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK 第 102 轮小节已插入')
}

if (!/^\| 102 \|/m.test(t)) {
  const ROW = '| 102 | ★★★★★ **修掉我自己那个"会让 CI 撒谎"的洞 —— 而它当场翻出一个我 40 轮没见过的东西**。'
    + '第 100 轮量到 `test` FAIL、**4974ms** 就退，我当时说"它挡住了产品侧那 22 条红"；'
    + '本轮顺着那 4974ms 读代码，发现更糟：那扇"套件清单不完备"的闸门在 **L4384 直接 `return`**，'
    + '而**跑套件的 `for` 循环在它后面** ⇒ `test` 阶段**一个用例都没跑**。'
    + '> 一个"清单不完备所以整个阶段不跑"的设计，与一个"清单不完备、但**产品照样量一遍**"的设计，'
    + '> 在"这次 CI 说明了产品什么"上不是同一个东西：**前者只说明清单错了，后者同时说明产品现在什么样。**'
    + '★★★ 而那条闸门自己的注释写着它当初为什么存在：「21 条断言一次都不会跑，**而 CI 摘要上看不出任何异常**」——'
    + '**它自己的 return 又造出了同一个病**（摘要看得出异常，却看不出**产品哪里**异常）。'
    + '★ 修法：判定不变（登记不全 ⇒ FAIL），只是**不许它把后面的测量一起吞掉**（`ok: allOk && !listingIncomplete`）。'
    + '★★★★★ 而这一改**当场翻出一个我 40 轮没见过的套件**：`test` 阶段 **4974ms → 1020036ms（约 17 分钟）**、'
    + '跑到的套件 **0 → 全部**、报告出的失败 **1 条闸门 → 闸门 + 6 个真套件**。'
    + '★★★ 新露出来的是 **`model-config`（PRT-252）`18 通过 / 1 失败`**：'
    + '「**路由真的接上了校验**（这条守的是"接线被拔掉"）」—— 它此前**从未出现在任何一次读数里**，'
    + '既不在我报的"5 套件 / 22 条红"里（**那个数是不完整的**），也不在第 100 轮那次的 8/9 里。'
    + '★★★★★ 而它的根因与第 91 轮那条**是同一个**（逐条读核过）：该用例 L232 只读**一个文件**'
    + '（`readFileSync(new URL("../../team-hub/server.mjs", ...))`），三条 `assert.match` 断言那三处代码在 `server.mjs` 里；'
    + '实测 `validateAgentModelSelection({...})` 与 `throw modelConfigErrorFor(verdict)` **都已搬进 `team-hub/routes/models.mjs`**、'
    + '只有第三条还在 `server.mjs` ⇒ **3 条断言里 2 条失败**（`server.mjs` 5637 行、`routes/` 下 **49 个文件**）。'
    + '⇒ 「**源码断言把一个文件钉死**」这一族现在是 **2 条用例 / 2 个套件**（`model-api` ③ 与 `model-config`），都是那次路由迁移的余波。'
    + '★ 必须写下的代价：`test` 现在要跑约 **17 分钟**（从前 5 秒）—— **这不是本修改引入的成本，而是那份成本一直都在、从前被藏起来了**；'
    + '⚠ 而 CI 单条命令时限 **600s** ⇒ 现在**必须**在后台/更长时限里跑 `run-ci.mjs`。 |'
  const lines = t.split('\n')
  const i101 = lines.findIndex((l) => /^\| 101 \|/.test(l))
  if (i101 < 0) bad.push('  x 找不到 | 101 |')
  else { lines.splice(i101 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 102 行') }
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
