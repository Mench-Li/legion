// scratch/_r91-correct.mjs —— 第 91 轮：**更正第 63/85 轮** —— 那 21 条**不是一个原因**
//
// ★ 第 63 轮说「13 条套件级 FAIL = 9 争用 + 1 真簇」，第 85 轮我说「那 21 条**同一个原因**（设计常量）」。
//   本轮逐条读失败标题 + 追到源码，量到 **`model-api` 那 2 条是另一个原因**：
//   它 L316 做的是 `extractRoutes(readFileSync('team-hub/server.mjs'))` ——
//   而并行会话已把 **188 条路由中的 145+ 条搬出 `server.mjs`** 到 `team-hub/routes/*.mjs` 族模块
//   ⇒ 抽取器看不到 ⇒ 报「这些路径在 team-hub 的路由表里不存在」⇒ **假阳性**。
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 46)}`); return }
  t = t.replace(f, tt)
}
sub('**第 90 轮结束时的读数**（全部可复跑）：', '**第 91 轮结束时的读数**（全部可复跑）：')

const ANCHOR = '#### ★★★★ 第 90 轮：把 **§5 第 16 条**摊开'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 90 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 91 轮：**更正第 63/85 轮** —— 那 21 条**不是一个原因**（其中 2 条不是这条缝）',
    '',
    '第 63 轮写的是「13 条套件级 FAIL = 9 条争用 + **1 个真簇**」；',
    '第 85 轮我又把它写成「**同一个原因**（设计常量）」并说「与第 63 轮一字不差」。',
    '',
    '★ 本轮**逐条去读失败标题**（不是看条数），量到 **`model-api` 那 2 条是另一个原因**：',
    '',
    '```',
    '✖ api.ts 里用到的每个 /api/ 路径都能在源码抽出的路由表里找到',
    'AssertionError: 这些路径在 team-hub 的路由表里不存在（前端写了个不存在的端点，用户只会看到一个 404）',
    '```',
    '',
    '追到那一行（`workbench/scripts/model-api.test.mjs:316`）：',
    '',
    '```js',
    'const routes = extractRoutes(readFileSync(resolve(ROOT, \'team-hub/server.mjs\'), \'utf8\'))',
    '```',
    '',
    '⇒ 它**只从 `team-hub/server.mjs` 一个文件里抽路由**。',
    '而并行会话已把 188 条路由里的 **145 条以上搬出 `server.mjs`**、落到 `team-hub/routes/*.mjs` 族模块',
    '（`server.mjs` 现在剩 **15** 条左右）⇒ **抽取器看不到** ⇒ 报"这些路径不存在" ⇒ **假阳性**。',
    '',
    '#### ⇒ 两条更正',
    '',
    '1. ★★ **那 21 条不是一个簇，至少是两个**：',
    '',
    '| 簇 | 条数 | 是什么 | 谁的 |',
    '|---|---|---|---|',
    '| **自检恒不兼容**（设计常量） | 19 | 那几条断言"自检通过 / 服务发布 / `dshRuntimeBound() === true` / 绑定解除阻塞" —— 都是**构造上不可达**的状态 | ★ **产品侧** ⇒ 裁决 **Ⅰ** |',
    '| **路由抽取器只读一个文件** | 2 | `extractRoutes(server.mjs)` 看不见已搬进族模块的路由 | ★ **并行会话的搬运工作**（`scripts/prt/baseline-snapshot.mjs` 是他们的在制品） |',
    '',
    '2. ★★★ **因此裁决 Ⅰ 比我先前说的小 2 条** —— 那 2 条不归 Ⅰ，而归"搬运时要同步抽取器"。',
    '',
    '★★★★★ **而这一轮最有价值的不是这个数，是我为什么会写错**：',
    '',
    '> 第 85 轮我**复跑**了那五个套件、数出 **36 通过 / 21 失败**，与第 63 轮**一字不差**，',
    '> 于是写下"**同一个原因**"、并说"那一批读数被独立复现了"。',
    '>',
    '> ★ 我复现的是**条数**，不是**原因**。同一个 21，可以是 19+2。',
    '> **两个不同的原因，会给出同一个总数** —— 而"总数一样"恰恰是我当成"同一件事"的那个证据。',
    '',
    '★ 这与第 90 轮那个毛病**同族**（"我手上的那一个样本"与"这一类实际有多少个"），',
    '但方向相反：第 90 轮是**从一个样本推广**，本轮是**从一个总数推广**。',
    '而两次我都**没有逐条去看**。',
    '',
    '★ 修复的动作也就很朴素：**逐条读失败标题**（不是数条数、不是比总数）。',
    '这一次逐条读，第一屏就撞出来了。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK §三之三 已插入第 91 轮更正节')
}

if (!/^\| 91 \|/m.test(t)) {
  const ROW = '| 91 | ★★★★★ **更正第 63/85 轮：那 21 条不是一个原因**（其中 2 条不是那条缝）—— '
    + '第 63 轮写「13 条套件级 FAIL = 9 争用 + **1 个真簇**」；第 85 轮我复跑出 **36 通过 / 21 失败**、'
    + '与第 63 轮**一字不差**，于是写下"**同一个原因**（设计常量）"。'
    + '★ 本轮**逐条读失败标题**（不是数条数），量到 **`model-api` 那 2 条是另一个原因**：'
    + '它的失败文案是「这些路径在 team-hub 的路由表里**不存在**」，追到 `workbench/scripts/model-api.test.mjs:316` —— '
    + '`extractRoutes(readFileSync(resolve(ROOT, \'team-hub/server.mjs\'), \'utf8\'))` ⇒ '
    + '**只从 `server.mjs` 一个文件抽路由**，而并行会话已把 188 条里的 **145 条以上搬进 `team-hub/routes/*.mjs` 族模块**'
    + '（`server.mjs` 现在剩 **15** 条左右）⇒ 抽取器看不到 ⇒ **假阳性**。'
    + '⇒ **那 21 条至少是两个簇**：**19** 条 = 自检恒不兼容（断言"自检通过/服务发布/`dshRuntimeBound()===true`/解除阻塞"这类**构造上不可达**的状态）⇒ ★ **裁决 Ⅰ**；'
    + '**2** 条 = 路由抽取器只读一个文件 ⇒ ★ **并行会话的搬运工作**（`baseline-snapshot.mjs` 是他们的在制品）。'
    + '★★ 因此**裁决 Ⅰ 比我先前说的小 2 条**。'
    + '★★★★★ 而这一轮最有价值的不是这个数，是**我为什么会写错**：'
    + '> 我复现的是**条数**，不是**原因**。同一个 21，可以是 19+2。'
    + '> **两个不同的原因，会给出同一个总数** —— 而"总数一样"恰恰是我当成"同一件事"的那个证据。'
    + '★ 这与第 90 轮那个毛病**同族**（第 90 轮是**从一个样本推广**，本轮是**从一个总数推广**），而两次我都**没有逐条去看**。 |'
  const lines = t.split('\n')
  const i90 = lines.findIndex((l) => /^\| 90 \|/.test(l))
  if (i90 < 0) bad.push('  x 找不到 | 90 |')
  else { lines.splice(i90 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 91 行') }
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
