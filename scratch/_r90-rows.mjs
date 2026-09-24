// scratch/_r90-rows.mjs —— 第 90 轮：把 §5 第 16 条**摊开**（11 个模块、三种形状），并记下我又一次"从一个样本推广"
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
sub('**第 89 轮结束时的读数**（全部可复跑）：', '**第 90 轮结束时的读数**（全部可复跑）：')

const ANCHOR = '#### ★★★ 第 89 轮：那条"绝对日期"的规矩'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 89 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★ 第 90 轮：把 **§5 第 16 条**摊开 —— **11 个模块、三种形状**（第 86 轮只看了 1 个）',
    '',
    '第 86 轮我读了 `product/lifecycle/retention.mjs`，见它是**纯函数**，就写下',
    '「§5 第 16 条是**归属**问题（谁来提供 `entries`、谁来按节奏触发）」。',
    '',
    '★ 本轮把 `reachability` 里指向第 16 条的模块**全数点出来**：**11 个**（不是 1 个），',
    '而它们**不是同一种形状**：',
    '',
    '| 形状 | 模块 | 缺的是什么（`reachability` 的原话） |',
    '|---|---|---|',
    '| **A. 没有 CLI 面** | `lifecycle/data-classes` · `lifecycle/data-export` · `lifecycle/retention` · `lifecycle/uninstall` | 「阶段 9 产品动作：**模块 + 用例齐备，没有 CLI 面**」 |',
    '| **B. 缺"谁来看"** | `metrics-source` · `metrics-spec7-source` · `metrics-spec7` | 「**数据在库里、读出口也写好了，缺的是"谁来看"**」 |',
    '| **C. 零生产 import 者** | `release/checklist` · `release/privacy` · `support/runbook` · `diagnostics/crash-report` | 「零生产 import 者」 |',
    '',
    '★ 11 个里 **10 个是纯的**（不碰 `process.env` / 文件系统）—— 只有 `product/release/checklist.mjs` 会碰 IO。',
    '',
    '#### 顺带量到的一件事：这个产品**没有 CLI 面**',
    '',
    '- 仓库根**没有 `package.json`**（`package.json` 只在 `team-hub/` `workbench/` 等子项目里）；',
    '- **没有 `bin/` 或 `cli/` 目录**；',
    '- `product/index.mjs` 只有 **75 行**、是**再导出**，**不按 `argv` 分派**任何子命令。',
    '',
    '⇒ 这个产品把自己暴露成**一组进程**（Launcher / Runtime / Orchestrator / team-hub），**不是**一个命令行工具。',
    '所以 A 那一组说的「没有 CLI 面」是**字面意思**：**产品今天根本没有操作者面**。',
    '',
    '#### ⇒ 这对您意味着什么',
    '',
    '第 16 条要裁的**不是**一个归属，而是**一层要不要存在的东西**：',
    '',
    '> 这四个"产品级动作"（数据分类 / 导出 / 保留期 / 卸载）与这几份文档化的面',
    '> （发布清单 / 隐私与出流 / 运维手册 / 崩溃报告），**要不要有一个操作者面**？',
    '',
    '★ 三条路各有代价（都**不是**我该替您选的）：',
    '',
    '| 路 | 代价 |',
    '|---|---|',
    '| 加一个**操作者 CLI**（新的一层） | 那是一个**新产品面**：命令面一旦存在，就要有它的版本、兼容、文档与判据 |',
    '| 把这些动作**挂进既有进程**（例如 Launcher 的子命令 / hub 的路由） | 不动产品形状，但会把"运维动作"塞进一个职责是"管进程"的地方 |',
    '| **先不做**，如实记成"模块与用例齐备、产品还没有这一面" | ★ 零风险，而台账上这 11 个模块会**长期**停在 `[gap]` |',
    '',
    '★★★★★ **而本轮同样要记下我自己的一个毛病（第四次）**：',
    '',
    '> 第 86 轮我读了 **1 个**模块，就写下"第 16 条是什么形状"；',
    '> 而它名下**有 11 个**模块，**三种**形状。',
    '',
    '★ 这与第 87 轮（从"#28 是接线"这一个样本推广成"整条改判为施工"）**是同一个毛病**；',
    '也与第 88 轮（把"症状"当"根因"）、第 89 轮（一条规矩只写在一处）同族 ——',
    '**都是"我手上的那一个样本"与"这一类实际有多少个"之间的距离**。',
    '',
    '> 一个"我读过了、是纯函数"的印象，与一个"这一类有 11 个、分三种"的事实，',
    '> 在我**没有去数这一类到底有几个**的时候是同一个东西。',
    '',
    '★ 所以本轮的做法是：**先去数，再下结论**。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK §三之三 已插入第 90 轮那节')
}

if (!/^\| 90 \|/m.test(t)) {
  const ROW = '| 90 | ★★★★ **把 §5 第 16 条摊开：11 个模块、三种形状**（第 86 轮只看了 1 个）—— '
    + '第 86 轮我读了 `product/lifecycle/retention.mjs`、见它是**纯函数**，就写下"第 16 条是**归属**问题"。'
    + '★ 本轮把 `reachability` 里指向第 16 条的模块**全数点出来**：**11 个**，而它们**不是同一种形状**：'
    + '**A. 没有 CLI 面**（`lifecycle/data-classes`·`data-export`·`retention`·`uninstall`，原话「阶段 9 产品动作：**模块 + 用例齐备，没有 CLI 面**」）；'
    + '**B. 缺"谁来看"**（`metrics-source`·`metrics-spec7-source`·`metrics-spec7`，原话「**数据在库里、读出口也写好了，缺的是"谁来看"**」）；'
    + '**C. 零生产 import 者**（`release/checklist`·`release/privacy`·`support/runbook`·`diagnostics/crash-report`）。'
    + '★ 11 个里 **10 个是纯的**（不碰 `process.env`/文件系统）。'
    + '★★ 顺带量到：**这个产品没有 CLI 面** —— 仓库根**没有 `package.json`**（只在 `team-hub/` 等子项目里）、**没有 `bin/` 或 `cli/`**、'
    + '`product/index.mjs` 只有 **75 行**且是**再导出**、**不按 `argv` 分派**子命令 ⇒ 它把自己暴露成**一组进程**，不是一个命令行工具。'
    + '⇒ 所以第 16 条要裁的**不是**一个归属，而是「**这一层操作者面要不要存在**」：'
    + '三条路（加一个操作者 CLI＝一个新产品面；挂进既有进程＝把运维动作塞进管进程的地方；先不做＝零风险但 11 个模块长期停在 `[gap]`），**都不该我替您选**。'
    + '★★★★★ **本轮也要记下我自己的一个毛病（第四次）**：第 86 轮我读了 **1 个**模块，就写下"第 16 条是什么形状"，'
    + '而它名下有 **11 个**、**三种**形状。★ 这与第 87 轮（从一个样本推广成"整条改判为施工"）**是同一个毛病**，'
    + '也与第 88（症状当根因）、第 89（规矩只写一处）同族 —— 都是「**我手上的那一个样本**」与「**这一类实际有多少个**」之间的距离。'
    + '> 一个"我读过了、是纯函数"的印象，与一个"这一类有 11 个、分三种"的事实，在我**没有去数这一类到底有几个**的时候是同一个东西。'
    + '★ 所以本轮的做法是：**先去数，再下结论**。 |'
  const lines = t.split('\n')
  const i89 = lines.findIndex((l) => /^\| 89 \|/.test(l))
  if (i89 < 0) bad.push('  x 找不到 | 89 |')
  else { lines.splice(i89 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 90 行') }
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
