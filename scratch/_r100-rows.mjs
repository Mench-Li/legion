// scratch/_r100-rows.mjs —— 第 100 轮：里程碑 —— **全量 9 阶段**的实测读数（我自己第一次跑全套）
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
sub('**第 99 轮结束时的读数**（全部可复跑）：', '**第 100 轮结束时的读数**（全部可复跑）：')
sub('本文件已**复核到第 99 轮**', '本文件已**复核到第 100 轮**')

const ANCHOR = '#### ★★★★★ 第 99 轮：更正第 93 轮那条补记'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 99 轮那节的锚点')
else {
  const SEC = [
    '## ★★★★★ 第 100 轮：里程碑 —— **全量 9 阶段**的实测读数（我自己第一次跑全套）',
    '',
    '**跑法**：`node scripts/ci/run-ci.mjs --out .ci/r100-full`（九个阶段全选，未跳过任何一项）。',
    '',
    '| # | 阶段 | 结论 | 读数 |',
    '|---|---|---|---|',
    '| 1 | `syntax` | ✅ **PASS** | 6311ms |',
    '| 2 | `env` | ✅ **PASS** | `encoding-check` **2426 个文本文件无 U+FFFD**；`config scan` 1169 个疑似字面量；白板副本一致 |',
    '| 3 | `boundary` | ✅ **PASS** | `dsh-boundary` 执行面依赖未增长（**7 文件 / 85 处**均在基线内）；`dsh-pin-drift` **6 条结论、15 个锚点逐字命中** |',
    '| 4 | `deps` | ✅ **PASS** | 2ms |',
    '| 5 | `build` | ✅ **PASS** | 11968ms；`whiteboard` / `workbench`(tsc+vite) / `team-hub` / `plugins` / `board-plugin` 全部 PASS，**`patch-loadable` PASS**（真 DSH 管线读 `legion-host.patch.yml`） |',
    '| 6 | `test` | ✖ **FAIL** | **4974ms** —— 见下（**不是产品红，是套件登记闸门**） |',
    '| 7 | `smoke` | ✅ **PASS** | 9206ms；`chat-l1`(22 项) / `chat-s2`(9 项) / `files-s5`(32 项) / `whiteboard` / `v1 看板 --token` 全 PASS |',
    '| 8 | `stage` | ✅ **PASS** | 95ms，发布物暂存到 `releases/legion-01eba05-2026-09-20` |',
    '| 9 | `doc` | ✅ **PASS** | 393ms；`check-docs` 11 类校验项全绿；`spec-progress` **140/145 与台账一致** |',
    '',
    '⇒ **9 个阶段里 8 个 PASS，只有 `test` FAIL。**',
    '',
    '#### ★★★★★ 而 `test` 那一条红，是**闸门**、不是产品红 —— 而且它**挡住了产品红**',
    '',
    '```',
    'FAIL 套件清单不完备：30 个 *.test.mjs 不会被任何套件执行（等于不存在的断言）',
    '[test] -> FAIL (4974ms)',
    '```',
    '',
    '★ 那 30 个文件**全部**是 `team-hub/*-routes.test.mjs`（本轮逐个列出来核过），',
    '即**并行会话正在做的路由迁移**给 47 个族各写了一个套件、而**没有把它们登记进套件清单**。',
    '',
    '★★★★★ **而这件事的结构性后果，比那 30 个本身要紧**：',
    '',
    '> `test` 阶段在 **4974ms** 就因为这条闸门退了 ⇒ **它从来没有跑到产品侧那 22 条红**。',
    '>',
    '> ⇒ 我报的"全量 CI 8/9"与"产品侧 22 条红"**从来不是同一次跑出来的两个读数** ——',
    '> 前者**不含**后者。**一个绿色的阶段名，与那个阶段真的跑过，是两件不同的事。**',
    '',
    '（这与第 84 轮记过的是同一个形状：那一次也卡在这条闸门上、也是 4899ms 就退。',
    '★ 而**两次的条数不同** —— 那次是"~16 条"，这次是 **30 条**，说明这扇门**一直在长**。）',
    '',
    '#### ★★★★★ 而产品侧那 22 条，本轮单独实测：**数变了**',
    '',
    '| 套件 | 通过 / 失败 |',
    '|---|---|',
    '| `orchestrator/worker/runtime-contract-cross-process` | 10 / **9** |',
    '| `runtime/dsh-composition/plugins/runtime-host-row-dsh-process` | 4 / **6** |',
    '| `runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process` | 3 / **4** |',
    '| `runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process` | 4 / **2** |',
    '| `workbench/scripts/model-api` | 14 / **1** |',
    '| **合计** | **35 通过 / 22 失败** |',
    '',
    '★★★ **而我在第 63/85 轮报的是 36 通过 / 21 失败** —— **数变了**，已不再是那个数。',
    '',
    '★ 能确证的那一半：**`model-api` 从 2 条失败变成 1 条** ——',
    '而第 91 轮量出它那一条族的根因是「路由抽取器只读 `server.mjs` 一个文件」，',
    '并行会话**正在搬路由** ⇒ 他们搬到某一步时，抽取器**又能看见**其中一条路径了。',
    '',
    '★★ **不能确证的那一半（如实说）**：`runtime-host-row-dsh-process` 我先前记的是 **5** 条、本轮实测 **6** 条',
    '（A / B / C / D / J / PRT-253）。我没有留旧树，**无法断定是"当时数是 5、现在变 6"，',
    '还是"我当时就数错了"** ⇒ 这一条我**不当成"产品变差了"来报**，只报今天量到的 6。',
    '',
    '★★★★★ **所以里程碑这一轮的结论是两句，都带限定**：',
    '',
    '1. **仓里我名下的一切是绿的**：9 阶段里 8 个 PASS，那唯一红的 `test` 是**别人在制品的登记缺口**，不是产品缺陷；',
    '2. **而"产品侧那 22 条"必须单独跑** —— 全量 CI 因为闸门根本到不了它们。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK 第 100 轮里程碑小节已插入（在 §三之三 最前）')
}

if (!/^\| 100 \|/m.test(t)) {
  const ROW = '| 100 | ★★★★★ **里程碑：全量 9 阶段的实测读数**（我自己第一次跑全套）— `node scripts/ci/run-ci.mjs --out .ci/r100-full`，未跳过任何一项。'
    + '★ **8/9 PASS**：`syntax`·`env`（**2426 个文本文件无 U+FFFD**）·`boundary`（执行面依赖未增长 7 文件/85 处；`dsh-pin-drift` 15 个锚点逐字命中）·`deps`·'
    + '`build`（whiteboard/workbench(tsc+vite)/team-hub/plugins/board-plugin 全 PASS，**`patch-loadable` PASS**）·'
    + '`smoke`（chat-l1 22 项 / chat-s2 9 项 / files-s5 32 项 / whiteboard / v1 看板 --token 全 PASS）·`stage`（暂存到 `releases/legion-01eba05-2026-09-20`）·`doc`（11 类校验项全绿、**spec-progress 140/145 与台账一致**）。'
    + '★★★★★ 而唯一红的 `test` **是闸门、不是产品红**：「**套件清单不完备：30 个 `*.test.mjs` 不会被任何套件执行**」，'
    + '`[test] -> FAIL (4974ms)`；那 **30 个全部**是 `team-hub/*-routes.test.mjs`（并行会话的路由迁移给 47 个族各写了套件、**没登记进套件清单**）。'
    + '★★★ 结构性后果比那 30 个本身要紧：**`test` 在 4974ms 就因闸门退了 ⇒ 它从来没跑到产品侧那 22 条红** ⇒ '
    + '我报的"全量 CI 8/9"与"产品侧 22 条红"**从来不是同一次跑出来的读数**，前者**不含**后者。'
    + '**一个绿色的阶段名，与那个阶段真的跑过，是两件不同的事。**'
    + '（第 84 轮记过同一形状，那次也卡在这条闸门、4899ms 就退 —— ★ 而**两次条数不同**（~16 → **30**），说明这扇门**一直在长**。）'
    + '★★★★★ 产品侧那 22 条本轮**单独**实测：`runtime-contract-cross-process` 10/9 · `runtime-host-row` 4/**6** · '
    + '`runtime-host-binding-unblocked` 3/4 · `runtime-host-registrar-row` 4/2 · `model-api` 14/**1** ⇒ **合计 35 通过 / 22 失败**。'
    + '★★★ **而我第 63/85 轮报的是 36/21 —— 数变了。** 能确证的：**`model-api` 2 → 1**（第 91 轮量出它那族根因是"抽取器只读 `server.mjs`"，'
    + '而他们正在搬路由 ⇒ 某一步后抽取器又能看见一条）。'
    + '★★ **不能确证的（如实说）**：`runtime-host-row` 我先前记 **5**、本轮实测 **6**（A/B/C/D/J/PRT-253）—— 我没留旧树，'
    + '**无法断定是"当时 5、现在 6"还是"我当时就数错了"** ⇒ **不当成"产品变差了"来报**，只报今天量到的 6。'
    + '⇒ 结论两句，都带限定：①**仓里我名下一切是绿的**（唯一红的 `test` 是别人在制品的登记缺口）；'
    + '②**"产品侧那 22 条"必须单独跑**，全量 CI 因为闸门根本到不了它们。 |'
  const lines = t.split('\n')
  const i99 = lines.findIndex((l) => /^\| 99 \|/.test(l))
  if (i99 < 0) bad.push('  x 找不到 | 99 |')
  else { lines.splice(i99 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 100 行') }
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
