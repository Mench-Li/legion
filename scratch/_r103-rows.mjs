// scratch/_r103-rows.mjs —— 第 103 轮：把"产品侧到底有几条红"从**一次真的跑完了全部套件的 CI**里逐条数出来
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
sub('**第 102 轮结束时的读数**（全部可复跑）：', '**第 103 轮结束时的读数**（全部可复跑）：')
sub('本文件已**复核到第 102 轮**', '本文件已**复核到第 103 轮**')

const ANCHOR = '#### ★★★★★ 第 102 轮：**修掉我自己那个"会让 CI 撒谎"的洞**'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 102 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 103 轮：把那份"产品侧红名单"**从我手里换成 CI 手里** —— 它一直是不完整的',
    '',
    '第 102 轮修好闸门之后，CI 第一次**真的跑完了全部套件**，并把每个失败套件的原始输出落盘到',
    '`.ci/r102-fixgate/suites/*.log`（7 个文件）。★ 本轮就从那 7 个文件里**逐条数**，不再靠"我挑几个跑"。',
    '',
    '```',
    'summary.json：[{"name":"test","status":"FAIL","ms":1019999,"skipped":1}]',
    '```',
    '',
    '| 套件 | 通过 / 失败 |',
    '|---|---|',
    '| `runtime-contract-cross-process` | 10 / **9** |',
    '| `dsh-composition-runtime-host-row-dsh-process` | 5 / **5** |',
    '| `dsh-composition-runtime-host-binding-unblocked` | 3 / **4** |',
    '| `boundary-facts`（★ **我自己的**判据套件） | 62 / **2** |',
    '| `dsh-composition-runtime-host-registrar-dsh-process` | 4 / **2** |',
    '| `model-api` | 14 / **1** |',
    '| `model-config` | 17 / **1** |',
    '| **合计** | **115 通过 / 24 失败**（7 个套件） |',
    '',
    '⇒ 扣掉**我自己**那个 `boundary-facts`（那 2 条是台账行号漂移，非产品），',
    '**产品侧 = 6 个套件 / 22 条红**。',
    '',
    '#### ★★★★★ 而这一轮真正要说的是：**那个 22 是对的，但它的对是碰巧的**',
    '',
    '| 我什么时候报的 | 报的数 | 那个数是怎么来的 |',
    '|---|---|---|',
    '| 第 63 / 85 轮 | 5 套件 / **21** 条 | 我**挑了几个套件去跑** —— 不是"CI 枚举了全部" |',
    '| 第 100 轮 | 5 套件 / **22** 条 | 同上，只是某一条的读数变了 |',
    '| 第 103 轮（本轮） | **6 套件 / 22 条** | ★ 从**一次真的跑完了全部套件的 CI**的原始输出里数 |',
    '',
    '★★★ ⇒ **套件数一直是错的（5 vs 6）**，而"22 条"看起来对，只是**漏掉的那个套件恰好只贡献 1 条**，',
    '而**另一处恰好少算了 1 条**（`runtime-host-row` 我先前量到 6）。**两个错互相抵消，总数看着是对的。**',
    '',
    '> ★★★ 两个错误互相抵消，与两个读数都对，在"这个总数可不可信"上是同一个东西 ——',
    '> **直到有人去数每一行**。',
    '',
    '#### ★★★★ 而漏掉的那个套件（`model-config`），恰恰只有**修好测量**才能露出来',
    '',
    '它不是我没跑，而是**那次 CI 根本没跑到任何套件**（第 102 轮那条 `return`）。',
    '⇒ **"名单不完整"与"测量被吞掉"是同一个病的两面**：',
    '后者让我以为前者是完整的。',
    '',
    '#### ★★★★★ 附：一处**不可复现**的读数，如实记下来',
    '',
    '第 100 轮我单独跑 `runtime-host-row-dsh-process` 时量到 **4 通过 / 6 失败**（共 10 条）；',
    '而本轮它在 CI 里是 **5 / 5**（**同样 10 条**），我随即**单独连跑 3 次**，三次都是 **5 / 5**。',
    '',
    '⇒ ★ **"4/6" 今天复现不出来**。两次的**总条数一样、分裂不同** —— 这正是那类"看着一样其实不一样"的形状。',
    '★ 最可能的解释：那次测量时该文件正被改写（当时 `git status` 显示它"空着"，',
    '但那只说明**那一刻**没有工作区改动，不说明**我跑它的时候**没有）。',
    '',
    '★ 所以本轮**不把它当成"产品变好了"**来报 —— 只报今天稳定量到的 **5 / 5**，',
    '并把那次不可复现的读数连同它的不确定一起写下来。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK 第 103 轮小节已插入')
}

if (!/^\| 103 \|/m.test(t)) {
  const ROW = '| 103 | ★★★★★ **把那份"产品侧红名单"从我手里换成 CI 手里 —— 它一直是不完整的**。'
    + '第 102 轮修好闸门后，CI 第一次**真的跑完了全部套件**并把失败套件的原始输出落盘到 `.ci/r102-fixgate/suites/*.log`（7 个）；'
    + '本轮从那 7 个文件**逐条数**（不再靠"我挑几个跑"）：`runtime-contract-cross-process` 10/**9** · '
    + '`runtime-host-row-dsh-process` 5/**5** · `runtime-host-binding-unblocked` 3/**4** · '
    + '`boundary-facts`（★**我自己的**）62/**2** · `runtime-host-registrar-dsh-process` 4/**2** · `model-api` 14/**1** · `model-config` 17/**1** '
    + '⇒ **合计 115 通过 / 24 失败（7 个套件）**；扣掉我自己那个 `boundary-facts`（2 条是台账行号漂移、非产品）⇒ **产品侧 = 6 个套件 / 22 条红**。'
    + '★★★★★ 而真正要说的是：**那个 22 是对的，但它的对是碰巧的** —— '
    + '第 63/85 轮报「5 套件 / 21 条」、第 100 轮报「5 套件 / 22 条」，两次都来自"**我挑了几个套件去跑**"而不是"CI 枚举了全部"；'
    + '本轮是 **6 套件** ⇒ **套件数一直是错的（5 vs 6）**，而"22 条"看着对，只是**漏掉的那个恰好只贡献 1 条、另一处恰好少算 1 条**（`runtime-host-row` 我先前量到 6）——'
    + '**两个错互相抵消，总数看着是对的**。'
    + '> 两个错误互相抵消，与两个读数都对，在"这个总数可不可信"上是同一个东西 —— **直到有人去数每一行**。'
    + '★★★★ 而漏掉的那个 `model-config`，恰恰**只有修好测量才能露出来**（它不是我漏跑，而是那次 CI 根本没跑到任何套件）'
    + '⇒ **"名单不完整"与"测量被吞掉"是同一个病的两面**：后者让我以为前者是完整的。'
    + '★★★★★ 附：一处**不可复现**的读数，如实记下 —— 第 100 轮我单独跑 `runtime-host-row-dsh-process` 量到 **4 通过 / 6 失败**（共 10 条），'
    + '而本轮 CI 里是 **5/5**（**同样 10 条**），单独连跑 3 次也都是 **5/5** ⇒ **"4/6" 今天复现不出来**；'
    + '两次**总条数一样、分裂不同**，最可能是那次测量时该文件正被改写（当时 `git status` 显示它"空着"，但那只说明**那一刻**没有工作区改动）。'
    + '★ 所以**不当成"产品变好了"**来报，只报今天稳定量到的 **5/5**。 |'
  const lines = t.split('\n')
  const i102 = lines.findIndex((l) => /^\| 102 \|/.test(l))
  if (i102 < 0) bad.push('  x 找不到 | 102 |')
  else { lines.splice(i102 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 103 行') }
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
