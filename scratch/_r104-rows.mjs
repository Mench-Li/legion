// scratch/_r104-rows.mjs —— 第 104 轮：源码注释里那条 `文件:行` 引用**漂了 414 行**，而没有任何判据看着它
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
sub('**第 103 轮结束时的读数**（全部可复跑）：', '**第 104 轮结束时的读数**（全部可复跑）：')
sub('本文件已**复核到第 103 轮**', '本文件已**复核到第 104 轮**')

const ANCHOR = '#### ★★★★★ 第 103 轮：把那份"产品侧红名单"'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 103 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 104 轮：一条**漂了 414 行**的引用，而它落在**所有判据的视野之外**',
    '',
    '起因是我想核对那句"引擎契约与实际不符"的证据（`cancel-and-timeout` 为什么报未确认）。',
    '★ 顺着 `runtime/adapters/dsh/port.mjs` 那段去读，查到 `plugins/src/index.ts:2241` 时发现：',
    '',
    '```',
    'HEAD 的 plugins/src/index.ts 第 2241 行  =  const focus = lastFocus',
    '而那句原文「abort 不保证杀死子代理」在        :1827（另一处变体在 :2019）',
    '```',
    '',
    '⇒ ★ **指针漂了 414 行**，而且 `plugins/src/index.ts` **干净**（没有未提交改动）⇒ **HEAD 上就是错的**。',
    '',
    '#### ★★★ 而它为什么活了这么久：**没有任何判据读源码注释**',
    '',
    '| 判据 | 它读什么 | 管得到这条吗 |',
    '|---|---|---|',
    '| `ledger-line-citations-resolve`（`boundary-facts` ⑪a） | **台账** `PRT-PROGRESS.md` 里的 `文件:行` | ✖ 台账之外不看 |',
    '| `dsh-pin-drift` | DSH 检出的 **3 个文件 / 6 条结论**（全在 `packages/` 下） | ✖ 引的不是那三份 |',
    '',
    '★★★★★ ⇒ **`runtime/` 里注释写的 `文件:行` 引用，一条都不在门禁视野里。**',
    '',
    '> ★ 一个"指针写错 414 行"的注释，与一个"指针指对了"的注释，在**读的人**眼里是同一个东西：',
    '> 他会照那个行号去看，看到 `const focus = lastFocus`，然后**不再相信这段注释**。',
    '> 而这段注释正是 `cancel-and-timeout` 报"未确认"的**证据本身**。',
    '',
    '#### ★★★★★ 本轮的一个**自我更正**：我起先把它报成"DSH 引擎文件不存在"',
    '',
    '★ 第一版探针把 `plugins/src/index.ts` 按 **DSH 检出**去解析，于是报"目标文件不存在"，',
    '我一度准备写成一条大发现。★★ 而核对后发现：**那个文件在 Legion 里**（`Legion/plugins/src/index.ts`，2853 行，',
    '是 Legion 自己的 DSH 插件 `@dsh-external/dsh-scrum-worker`）—— 引用**本来就该按 Legion 解析**。',
    '',
    '⇒ 于是那半个发现**塌了**（根本不是"引了不存在的引擎文件"），剩下的是**行号漂移**这一半。',
    '★ 第二版探针另有两个假阳性，也一并记下：① 引文**跨行**（开引号在本行、闭引号在下一行）而第一版逐行扫 ⇒ 漏掉 `port.mjs`；',
    '② 目标常是**相对引用文件自己**的路径，而第一版一律按仓库根解析 ⇒ 误报"文件不存在"。',
    '',
    '> ★★ 三个假阳性都来自同一个毛病：**把"我以为它在哪"当成"它在哪"**。',
    '',
    '#### ★ 已修：`port.mjs` 的指针 `2241 → 1827`',
    '',
    '```',
    '第 104 轮实测（`scratch/_probe-r104b-origincites.mjs`）：',
    '  修前  3 处"路径:行 + 原文"引用，对得上 0 / 对不上 3',
    '  修后  对得上 1 / 对不上 2   ← 剩下 2 处是并行会话**正在编辑**的 launcher 文件（两个都是 ` M `）',
    '```',
    '',
    '★ 剩下那 2 处**本轮不动**：`product/launcher/legacy-data-adoption.mjs` 与它的 `.test.mjs` 都是 ` M `，',
    '行号漂移正是他们那次编辑造成的（`.test.mjs` 说 `launcher.mjs:108`，实际在 `:118`，差 10 行）。',
    '',
    '#### ★ 还没做的（下一轮第一件事）',
    '',
    '**给这一类立判据**：形如 `路径:行 …原文：「…」` 的源码注释，其引文必须出现在那个行号上。',
    '★ 本轮只修了**一处实例**，没修**产生它的机制** —— 而这正是我第 96/97 轮反复讲的那件事：',
    '**修一处实例，与让那一类不再产生，不是同一个东西。**',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK 第 104 轮小节已插入')
}

if (!/^\| 104 \|/m.test(t)) {
  const ROW = '| 104 | ★★★★★ **一条漂了 414 行的引用，落在所有判据的视野之外**。'
    + '起因是核 `cancel-and-timeout` 报"未确认"的证据，读到 `runtime/adapters/dsh/port.mjs` 引的 `plugins/src/index.ts:2241`：'
    + '实测 `HEAD` 的 `:2241` 是 `const focus = lastFocus`，而那句原文「abort 不保证杀死子代理」在 **`:1827`**（变体在 `:2019`）'
    + '⇒ ★ **指针漂了 414 行**，而 `plugins/src/index.ts` **干净** ⇒ **HEAD 上就是错的**。'
    + '★★★ 它活了这么久是因为**没有任何判据读源码注释**：`ledger-line-citations-resolve` 只读**台账**（`PRT-PROGRESS.md`）、'
    + '`dsh-pin-drift` 只读 DSH 检出的 **3 个文件 / 6 条结论**（全在 `packages/` 下）⇒ **`runtime/` 里注释写的 `文件:行` 一条都不在门禁视野里**。'
    + '> ★ 一个"指针写错 414 行"的注释，与一个"指针指对了"的注释，在**读的人**眼里是同一个东西：'
    + '> 他会照那个行号去看，看到 `const focus = lastFocus`，然后**不再相信这段注释** —— 而它正是那条能力的证据本身。'
    + '★★★★★ 而本轮有一次**自我更正**：第一版探针把 `plugins/src/index.ts` 按 **DSH 检出**解析、报"目标文件不存在"，'
    + '我一度准备写成大发现；核对后发现**那个文件在 Legion 里**（`Legion/plugins/src/index.ts`，2853 行，是 Legion 自己的 DSH 插件）⇒ 那半个发现**塌了**，'
    + '剩下的是**行号漂移**。★ 第二版另有两个假阳性：① 引文**跨行**而第一版逐行扫 ⇒ 漏掉 `port.mjs`；② 目标常**相对引用文件自己**而第一版按仓库根解析 ⇒ 误报不存在。'
    + '> ★★ 三个假阳性都来自同一个毛病：**把"我以为它在哪"当成"它在哪"**。'
    + '★ 已修 `port.mjs` 的指针 **2241 → 1827**（实测：修前 3 处引用对得上 0/对不上 3，修后 **1 / 2**）。'
    + '★ 剩下 2 处**本轮不动**：`legacy-data-adoption.mjs` 与它的 `.test.mjs` 都是 ` M `（并行会话正在编辑，漂移正是那次编辑造成的：`.test.mjs` 说 `launcher.mjs:108`、实际 `:118`）。'
    + '★★ **还没做（下一轮第一件事）**：给这一类**立判据**（`路径:行 …原文：「…」` 的引文必须在那个行号上）——'
    + '本轮只修了**一处实例**，没修**产生它的机制**。 |'
  const lines = t.split('\n')
  const i103 = lines.findIndex((l) => /^\| 103 \|/.test(l))
  if (i103 < 0) bad.push('  x 找不到 | 103 |')
  else { lines.splice(i103 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 104 行') }
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
