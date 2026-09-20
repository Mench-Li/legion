// scratch/_r93b-red.mjs —— 第 93 轮补记：那一红**不是我的**，而它暴露了我一直报的那个门禁**有隐藏依赖**
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []

const ANCHOR = '★ 而这一步之所以走到，仍然只是因为**逐条读**（第 91 轮读标题、第 92 轮读输入、本轮读**文件头**）。'
const SUB = ANCHOR.split('\n').join(eol)
if (t.split(SUB).length - 1 !== 1) bad.push('  x 锚点不唯一')
else {
  const ADD = [
    '',
    '#### ★★★★★ 补记：这一轮提交之后门禁**红了一条**，而它不是我的',
    '',
    '提交后我照例跑那三个套件，读到 `boundary-facts` **59 通过 / 2 失败**（此前一直是 61/61）。',
    '逐条读它说了什么：',
    '',
    '```',
    'AssertionError: 有坏引用：["server.mjs:2375（这一行是空的，或只有收尾符——引用指的地方没有内容：\\"\\"）"]',
    '```',
    '',
    '**三条核对，确认不是本轮改动引起的**：',
    '',
    '1. 那处引用在 **`docs/superpowers/prt/PRT-PROGRESS.md:181`**（台账的 PRT-611 行）——',
    '   本轮我**没有碰过**那个文件（`git status` 显示它是干净的）；',
    '2. 本轮提交 `081c1f2` 只改了两个文件（本文件 + 一个 scratch 脚本），',
    '   而 `git show HEAD -- … | grep \'server.mjs:\'` **一条都没匹配**；',
    '3. `team-hub/server.mjs` 此刻是 **`M `（已进索引）** —— ★ **并行会话正在搬路由**。',
    '',
    '★ 真因：他们把路由搬出 `server.mjs`（现在 **5706** 行），行号整体位移 ⇒',
    '台账里那条 `server.mjs:2375` 落到了**空行**上。',
    '',
    '#### ★★★ 而这件事比那条红更要紧：**我一直在报的那个门禁，有一个隐藏依赖**',
    '',
    '`boundary-facts` 读的是**工作区**。而工作区里的 `server.mjs` 正被**另一个会话实时改写**。',
    '',
    '⇒ 所以我先前报的「`boundary-facts` **89/89** / CLI **23/23 红 0**」',
    '**不是我这批提交的性质**，而是「**我跑它的那一刻，那棵树恰好是一致的**」。',
    '同一个套件、同样的我的改动，隔一轮就可能变成 59/2。',
    '',
    '> 一个"门禁全绿"的读数，与一个"门禁在**那一刻**是绿的"的事实，',
    '> 在我没有问"**它读的那些文件里，有没有别人正在写**"的时候是同一个东西。',
    '',
    '★ 这也解释了本轮之前那些"自愈"的观察（第 64 轮记过"`boundary-facts` 61/61 自愈"）：',
    '那**不是**自愈，是**另一个会话把文件改回了它要的样子**。',
    '',
    '★ 处置：**不动**。那条引用归他们（他们会一起把行号更新掉）；',
    '`ledger-line-citations-resolve` 这条判据**本来就该在这里响** —— 它是这套东西里少见的"抓到了真漂移"的一条。',
    '',
    '★★★★★ 而值得记的是：**这一轮我从"逐条读用例"换到"逐条读门禁的失败"，第一屏就又撞出一件事** ——',
    '只不过这次撞出的不是用例的问题，是**我自己的报数方式**的问题。',
    '',
  ].join('\n')
  t = t.replace(SUB, SUB + ADD.split('\n').join(eol))
  console.log('  OK 第 93 轮已补记那条红（不是我的 + 门禁的隐藏依赖）')
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
