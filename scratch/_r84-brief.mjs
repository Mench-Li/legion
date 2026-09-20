// scratch/_r84-brief.mjs —— 第 84 轮：DECISION-BRIEF.md 里的 第 28 条 也还挂着一份"要你裁决"
//
// ★ 这份文档的**唯一用途**就是"把那 29 条压成你要说的那一句话" ⇒ 它是最危险的传播缺口：
//   一个只读它的人会去**说一句不需要说的话**。
import { readFileSync, writeFileSync } from 'node:fs'

const D = 'D:/project/DSH/legion/docs/DECISION-BRIEF.md'
let t = readFileSync(D, 'utf8')
const bad = []
const sub = (from, to) => {
  const n = t.split(from).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 46)}`); return }
  t = t.replace(from, to)
}

// ① 第 28 条那一行：加"已被撤回为一个非裁决"的注
sub(
  '| **28** | 那条**出站车道**的文件放哪个目录 |',
  '| ~~**28**~~ | ~~那条**出站车道**的文件放哪个目录~~ ★ **第 84 轮：这一条已不是裁决，见本行末** |',
)

// 把三个选项那段后面接上撤回说明
sub(
  '**唯一与已裁决逐字一致**，最贵） | PRT-610 的车道**已建、环已在真 SQLite 上走通**，而生产里没人调它 ⇒ `decisionSourceRecorded` **永远没有产出者**，发布门禁永远判否——**而它判否的理由读起来完全正确** |',
  '**唯一与已裁决逐字一致**，最贵） | PRT-610 的车道**已建、环已在真 SQLite 上走通**，而生产里没人调它 ⇒ `decisionSourceRecorded` **永远没有产出者**，发布门禁永远判否——**而它判否的理由读起来完全正确**。<br>★★★★★ **第 84 轮撤回上面那三个选项**：第 75 轮量到这件事**不是位置决定** —— `product/config-schema.mjs:88` 定义了这个产品**唯一**的 `dataDir`（`LEGION_DATA_DIR`，落点由**冻结的目录布局**决定），`:1043`/`:1045` 已把它派给 **runtime** 与 **orchestrator**，而 `product/process-manifest.mjs:111` 显示 `team-hub` 是**同一份进程清单里的兄弟进程**，只是**没被登记进那张表** ⇒ **两边用的是同一个 `layout.dataDir`，不是猜的**。缺的是**三处**改动（第 76 轮已钉到行），被**另一会话正占着那三个文件**挡着，**不是被裁决挡着**。⇒ **这一条不需要您说话。** |',
)

// ② 依赖它的那条施工项
sub(
  '| **1** | 第 28 条定路径后：接上 `spool`/`toolcall-drain` 那条车道（解 **L7** 软缺口） | 半天～一天，等 **第 28 条** |',
  '| **1** | 接上 `spool`/`toolcall-drain` 那条车道（解 **L7** 软缺口） | 半天～一天。★ **第 84 轮更正**：原来写"等 **第 28 条**"，而第 28 条**已不是裁决**（见上）⇒ 它等的是**三处接线**（第 76 轮已钉到行），而工期被**另一会话占着那三个文件**挡着 |',
)

// ③ L7 那一行
sub(
  '| L7 | 产物验收/交接/审计/用量 | △ 软缺口（`spool`/`toolcall-drain` 没人挂） |',
  '| L7 | 产物验收/交接/审计/用量 | △ 软缺口（`spool`/`toolcall-drain` 没人挂）★ **第 84 轮**：根因已定 —— 不是缺一个落点决定，是 hub **没被登记进派生表**（第 75/76 轮） |',
)

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(D, t)
console.log('  OK DECISION-BRIEF.md 三处已更正')
