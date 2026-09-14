# PRT-315（切片 7）：拆分 `plugins/src/index.ts` —— 切片流水线编排

> **这一片不在 spec 点名的五条边界里。** spec
> （`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md:882`）点名的是
> 「按**仓储、状态机、workspace、验收和交接**边界拆分 `plugins/src/index.ts`，每次只迁移一个切片」。
> 切片 1–6 已经把五条**全部取完**：`mediation`（交接·合入调解）、`reclamation`（仓储·租约回收）、
> `stateMachine`（状态机·迁移决策）、`workspace`（workspace·worktree 隔离）、`acceptance`（验收·结算自检）、
> `handoff`（交接·阶段流转）。
>
> 本切片取的是它们的**邻居**：`sweep()` 的 `// 5.` 块（`orchestrateSlices` + 它的私有助手
> `parseSlices`）。写清楚这一点，是因为「按边界拆」读到第七篇很容易被读成「凡是拆出来的都对应某个
> 点名边界」——**它不是**。它是「五条点名边界之外，`sweep()` 里唯一还自带完整语义的一整块」。

---

## 1. 搬了什么、没搬什么

### 搬了（两段，逐字搬）

| 源（pristine `index.ts`） | 行数 | 去向 | 搬法 |
|---|---|---|---|
| `orchestrateSlices` JSDoc + 函数体，行 **2217–2284** | 68 | `plugins/src/sliceOrchestration.ts` 内 `createSliceOrchestration()` 闭包 | 逐字；仅施加 §4 的穷尽白名单 |
| `parseSlices` JSDoc + 函数体，行 **740–761** | 22 | 同文件，**模块级** 导出函数 | 逐字；去掉块首 2 空格缩进、`function` 前加 `export ` |

`parseSlices` 此前是 `spaceWorker()` 闭包里的 `function` 声明。它**全仓只有编排一个读者**
（`plugins/src` 下唯一的调用点在 `orchestrateSlices` 里），且是**纯函数**：只读入参 `text`，
不碰闭包、不碰文件、不碰 hub、不碰 git。它描述的是本界的**输入格式**——「breaker 写进
`TASK_BREAKDOWN.md` 的机器可读切片清单长什么样」。所以随边界一起搬，并 `export` 出来，
让用例能**直接**钉住那份格式契约，而不是只能隔着 `sweep()` 端到端间接验证。

### 没搬（**每一处都点名**）

1. **`if (useHub) { try { … } catch (e) { log(...) } }` 这一圈** —— 留在调用点。
   它是**调用方的控制流语义**：hub 不可达时不编排；编排抛错时只记一行日志、本轮照常收尾
   （`writeDaemonStatus` 仍会跑）。搬进模块 = 让模块自己决定「hub 不可达算不算失败」。
   → 这一条**有可执行用例**（§8.1 的 A7 / A8），不是口头声明。
2. **`SLICE_ANALYSIS_TAIL` / `isSliceGoalTask` / `isSliceBeam` / `goalDocPath` 四个判据的**定义****
   —— 留在 `index.ts`，按**值**注入。
   - `SLICE_ANALYSIS_TAIL`（`'test-designer'`）、`isSliceGoalTask`、`goalDocPath`：**各有第二个读者**
     （`./handoff.ts`、`registerContractDocs` / 契约登记），搬走就要么在 `index.ts` 留第二份
     （同一逻辑两处），要么让它们反向依赖本模块。
   - `isSliceBeam`：目前**只有本界一个读者**。留它是一次**判断**，不是硬约束——理由见 §8.5 第 4 条。
3. **`expandRetryAt` / `goalCtxById` 的**所有权**** —— 留在 `spaceWorker()` 闭包，只借去读改。
   理由见 §3。

### 提成函数

**没有。** 本切片对两段被搬代码**只做白名单内的正则改写**（4 处 `workspace.xxxFor()` → `xxxFor()`，
全部是依赖注入的形状变化），没有把任何语句「提成函数」、没有合并/拆分行、没有调整 `if` 次序。
这是与切片 6 的差别（切片 6 有一次「提成函数」并逐条声明）；本切片**零**。

---

## 2. 行数与用例

| 指标 | before | after | 净 |
|---|---|---|---|
| `plugins/src/index.ts` 总行数 | 2829 | **2763** | **−66** |
| ├ `spaceWorker()` 本体（花括号配平实测） | 2159 | 2092 | −67 |
| └ `spaceWorker()` 占全文 | 76.3% | **75.7%** | −0.6pt |
| `plugins/src/sliceOrchestration.ts` | — | **308**（新） | +308 |
| `plugins/tests/sliceOrchestration.test.mjs` | — | **625**（新） | +625 |
| `plugins/tests/slice-orchestration.test.mjs` | 652 | **785** | +133 |
| 插件套件用例数 | 370 | **404** | **+34** |

`index.ts` 的 −66 逐项对账（脚本 `prt315g-index.mjs` 自己打印的，非手算）：

```
import                            +1
parseSlices 定义 −22 +3           -19
orchestrateSlices 定义 −68 +3     -65
接线                              +13
守卫注释 1 → 5                       +4
调用点 1 → 1                       0
合计                              -66
```

`spaceWorker()` 的 −67 与总体的 −66 差 1，差的正是那个落在 `spaceWorker()` **外面**的 `import` 行。

用例数 +34 的构成：新文件 `sliceOrchestration.test.mjs` **32** 条（全为注入替身的白盒用例）＋
`slice-orchestration.test.mjs` **2** 条（调用点守卫 / 调用点吞错）。

**为什么 `spaceWorker()` 仍然有 2092 行**：它 76% 是 `sweep()` 的各个步骤内联体与
`superviseSpaces`/`mountRunner`/`writeDaemonStatus` 等**必须共享闭包状态**的代码。
本切片只切走了「自带完整语义、且依赖面可以收窄成一张接口」的那一块；剩下来的不是「没来得及切」，
而是**切不动或不该切**（§8.4 逐条列了）。

---

## 3. ★ 状态 / 取值函数 / 结构性类型

前六个切片反复强调「运行期会被重新赋值的绑定必须传**取值函数**」。**本切片刻意没有这一节**，
因为 `orchestrateSlices` **一个可变绑定都不读**：

| 绑定 | 本界读吗 | 处理 |
|---|---|---|
| `useHub`（`let`） | **不读** | `if (useHub)` 守卫留在调用点（§1 第 1 条） |
| `pipeline` / `stageByRole` / `isPipeline`（`let`） | **不读** | 切片束任务的「下一环」由 `blockedBy` **预建**，不走 `roles.json` 的 `next` |
| `hubUrl`（`let`） | 不读 | `hubPost` 是闭包函数，运行时自己读当前的 `hubUrl` |
| `scope`（`const`） | 读 | **传值**（const，身份稳定） |
| `config`（`apply()` 形参） | 读 4 个字段 | **传对象身份**（见下） |

`orchestrateSlices` 里**没有**取值函数。所以本切片新增的是**活性检查**（证明"接口是活的、
不是构造时快照"），而不是取值函数：

- **A11** —— 构造之后替换 `deps.config.maxFixPerSlice`，行为**立刻**改变（不是快照）。
- **A12/A13** —— 两个实例各持一份退避表；同一实例连续两轮都注册（模块不记忆状态）。

### 两个容器：**不搬所有权**，只借

- **`expandRetryAt: Map<string, number>`** —— 所有权留在 `spaceWorker()` 闭包。
  它是「切片展开重试退避」，看起来最该搬。不搬是因为它的**语义单位是 `spaceWorker` 实例**：
  `superviseSpaces()` 会在同一进程里按空间把 `spaceWorker` mount 成多个子实例，它们共用一个
  模块注册表。一个模块级 `Map` 会让空间 A 的退避时间戳挡住空间 B 的展开——而两边撞上同一个
  test-designer taskId 在多空间部署里是常态。**每实例一份**闭包天然做到，模块级变量天然做不到。
  → **A12 直接钉它**（两个实例、同一 taskId、只有 B 注册成功）。

- **`goalCtxById: { get: (id) => GoalCtxRef | undefined }`** —— 所有权留在闭包，且**接口收窄**。
  它**根本不是这一界的状态**：「目标级上下文缓存」由 `refreshGoals()`（`sweep()` 每轮从 hub
  `/api/goal` 刷新）写，被 `registerContractDocs`、worker 提示词、目标文件镜像等**非本界**读者读。
  搬走所有权 = 把一条「全实例共享的目标视图」塞进一个只读它一格的模块里，下一个读它的人就得
  反过来 import 本模块。所以接口里它**不是 `Map`**，而是一个 `{ get }` 结构类型——把契约收窄到
  「本界只读」。

### `config`：**结构性类型**，不 import `Config`

与六个前作同源：`Config` 是 `index.ts` 里由 zod schema 推出来的值，import 它形成**真的**运行时
循环依赖。这里只声明本切片真正读的 4 个字段：`role` / `intervalMs` / `maxFixPerSlice` / `isolate`。
调用点传的是**真的** `Config`，TypeScript 在赋值处校验可赋值性——字段改名的那天红在**调用点**。

这不是洁癖，其中两个字段各有自己的**静默症状**：

- `maxFixPerSlice` 读不到 → `fixes.length > undefined` 恒为 false → 重测重开**绕过预算闸门**
  （「不报错、只是一直重测」）；
- `isolate` 读不到 → `if (config.isolate)` 恒假 → 重测**跳过换基线**，复用上一轮的 tester
  worktree，重测跑在合入修复前的代码上。

### `goalDocPath` 为什么写成**方法**而不是函数类型属性

真实 `goalDocPath` 收的是完整的 `GoalCtx`（6 个字段），而本界只把 `goalCtxById.get()` 拿到的
`GoalCtxRef`（1 个字段）交给它。写成函数类型属性时 TypeScript 按**逆变**检查参数，
`(goal: GoalCtx) => string` 不能赋给 `(goal: GoalCtxRef) => string`，typecheck 直接报
`TS2322`（**这是本轮真实撞到的一次**，原文见 §9）。写成**方法**（`goalDocPath(a): string`）
是有意的：方法参数按**双变**检查，调用点因此不必写 `as` 断言——而 `as` 会把「字段改名」这种
真错一起吞掉，这条链上的静默症状是「契约文档登记到错的目录」。

---

## 4. 逐字对拍（谁证明了"搬得没走样"）

`_prt-handoff/prt315g-compare.mjs` —— **独立第二次抽取**（不复用组装脚本的锚点顺序与行号）：

```
== 块 1：orchestrateSlices ==
旧块行数（归一化前/后）= 68 / 68
新块行数（归一化前/后）= 68 / 68
✔ 68 行逐字一致（归一化后；已施加 2 条注入改写）
✔ 白名单 1 命中 3 处（声明 3）：repoRootFor()
✔ 白名单 2 命中 1 处（声明 1）：worktreeRootFor()
✔ 改写后旧块已无 `workspace.` 残留（0 处）

== 块 2：parseSlices ==
旧块行数（归一化前/后）= 22 / 22
新块行数（归一化前/后）= 22 / 22
✔ 22 行逐字一致（归一化后；已施加「去 2 空格缩进」+「加 export 」）

== 改后 index.ts 的残留检查 ==
✔ 改后 index.ts 已无「async function orchestrateSlices(…」
✔ 改后 index.ts 已无「function parseSlices(…」
✔ 改后 index.ts 已无「log(`${tester.id} → todo（fix 完成，第 ${fixes.leng…」
✔ 改后 index.ts 已无「out.push({ title, files, acceptance })…」
✔ 调用点 `sliceOrchestration.orchestrateSlices(` 出现 1 处（期望 1）
✔ 旧裸调用 `await orchestrateSlices(` 出现 0 处（期望 0）

结论：PASS
```

### 注入改写白名单（**穷尽，共 4 处，全是同一形状**）

| # | 改写 | 命中 | 为什么 |
|---|---|---|---|
| A | `workspace.repoRootFor()` → `repoRootFor()` | **3** | workspace 边界的取值函数，注入不搬 |
| B | `workspace.worktreeRootFor()` → `worktreeRootFor()` | **1** | 同上 |

**只搬这两个**，不把 `workspace` 整个对象拖进来：对本界而言 workspace 只有两个只读问题
（「仓库根在哪」「worktree 根在哪」）。把它整个交出去 = 让本模块有权调 `prepareWorktree` /
`commitWorktree`——越界不会报错，只会让「谁负责 worktree」这件事重新说不清。

另有两处**非正则**的搬迁变换（只在 `parseSlices` 上）：去块首 2 空格缩进（闭包内 → 模块级）、
`function` 前加 `export `。两者都在对拍脚本里显式施加并逐行核对。

---

## 5. ★ 断验证（变异 → 红 → 逐字节还原）

15 组变异，**除 1 组经判定不是缺陷外全部咬住**。每组都是：改单处 → **重建**（不重建就是拿旧
产物跑，假绿的头号来源）→ 跑目标套件 → 记原始输出 → **逐字节还原**（`sha256` 相等才算数）→
重建回绿色。原始输出在 `_prt-handoff/prt315g-mut-*.log`。

### 咬住的（14 组）

| # | 变异（都在 `sliceOrchestration.ts` 内，除注明） | 目标套件 | 红 |
|---|---|---|---|
| M1 | 拿掉「切片束已注册」幂等判据 | `sliceOrchestration` | 2 |
| M2 | 拿掉「预算已用尽」不重开闸门 | 同上 | 1 |
| M3 | 拿掉 fix 数超预算闸门 | 同上 | 2 |
| M4 | 拿掉「清单为空」那句 `return` | 同上 | 2 |
| M5 | 拿掉 `activity('slices', …)` | 同上 | 1 |
| M6 | `canceled` 的 fix 也算进计数 | 同上 | 1 |
| M7 | 失败日志丢掉 `\|\| out` 兜底 | 同上 | 1 |
| M8 | 把吞掉的「读取失败」改成抛出 | 同上 | 1 |
| M14 | 模块内把 ② 重测重开挪到 ① 展开就绪之前 | 同上 | 1 |
| M9 | **调用点**：整块删掉 `// 5.` | `slice-orchestration` | 4 |
| M10 | **调用点**：去掉 `if (useHub)` 守卫 | 同上 | 1 |
| M11 | **调用点**：去掉 `try/catch`（异常掀翻本轮） | 同上 | 1 |
| M12 | **调用点**：把 `tasks` 换成 `[]` | 同上 | 4 |
| M15 | **调用点**：`catch` 末尾加 `return`（跳过心跳） | 同上 | 1 |

M9 / M12 各红 4 条，其中 3 条是**既有的端到端用例**——本切片的调用点改动没有把老用例改绿。

### ★ 唯一**不咬**的一组（M13）以及我做了什么

M13 = 「把 `// 5.` 整块挪到 `writeDaemonStatus(...)` **之后**」，不咬。

**判定：它不是缺陷，M13 本就不该咬。** 整块挪到心跳之后，编排抛错时心跳**已经写过了**——
注释里那句「本轮照常收尾（`writeDaemonStatus` 仍会跑）」依然成立。这是**顺序相对位置**，
不是被声明的不变量。

**但它逼出了一个真缺口。** 顺着「那到底有没有东西钉住『心跳仍会跑』」去查，发现**没有**：
`writeDaemonStatus(0)` 在 `apply()` 挂载时就写过一次心跳，而 `daemon.json` 一旦存在、
`lastSweepAt` 一直在，断言「文件存在 + 有 lastSweepAt」在**任何**情况下都成立——
包括「本轮写心跳被整个跳过」时。于是我第一版给 M15 写的断言是**空转的**，
M15 当时**也不咬**（这是本轮最有价值的一次失败：一个看起来在钉不变量、实际上恒真的断言）。

**处置：把断言钉结实，并用 M15 反证它真的会红。**

- 挂载后先把 `daemon.json` 内容踩成哨兵 `{"lastSweepAt":"哨兵-不该留到最后"}`；
- 触发这一轮 sweep，`waitFor` 哨兵**被真实心跳覆盖**；
- M15（`catch` 末尾 `return`）现在**咬住（红 1）**，原始红：

```
test at tests\slice-orchestration.test.mjs:717:1
✖ ★ `sweep()` 的 `// 5.` try/catch：编排抛错 → 只记一行「切片编排失败」，本轮照常收尾（PRT-315 切片 7 调用点）
  Error: 编排抛错后本轮没写心跳：catch 接住之后必须继续走到 writeDaemonStatus
      at waitFor (...tests/slice-orchestration.test.mjs:72:39)
      at async TestContext.<anonymous> (...tests/slice-orchestration.test.mjs:773:5)
```

> **教训（本批第二次同类）**：切片 6 的教训是「验红要看**是不是解析失败**」；
> 本切片的是它的对偶——**验红之前先确认那条断言有没有可能变红**。
> 一条在两种实现下都成立的断言，和一粒没有装药的子弹是同一种东西。

### 另外两次**自己写错的**变异（不算数，记下来）

- **M15 第 1、2 版**：`C5.replace('        }', …)` 命中的是 **`try` 的**收尾括号，于是 `return`
  被放进 `try` 块里——而这条用例里 `orchestrateSlices` **一定抛**，`try` 里的 `return` **永远
  执行不到**，变异等于没改。（第 3 版改成显式锚定 `catch` 的三行才命中。）
- **M11 第 1 版**：删 `try/catch` 时把括号写坏了（`TS1005: 'try' expected`），构建失败 ⇒
  **不计入**。变异脚本对「构建失败」单独归类为「无效」，而不是算进「不咬」——否则一个写坏的
  变异会被记成「这条不变量没被钉住」。

---

## 6. "逻辑只有一处"（按**构建产物**查）

`_prt-handoff/prt315g-singleplace.mjs` 查的是 `plugins/lib/*.js`（构建产物），不是源码：

- **15 个被搬走的界面标记**（① 的四条日志、两条评论/活动串、`/api/goal/slices`、② 的评论/活动/
  日志/换基线/清理失败日志、`parseSlices` 的 JSDoc 与两条正则形态）：`index.js` **全部 0 处**，
  `sliceOrchestration.js` **全部 ≥1 处**。
- **6 个必须留下的界面**（调用点代码行、接线调用、`// 5.` 守卫注释、调用点吞错日志、四个判据的定义、
  `parseSlices` 指路注释）：`index.js` **≥1**，模块内 **0**。
- **名字只许出现在注释里**：`orchestrateSlices` / `parseSlices` 在 `index.js` 里只出现在 **2 行
  注释**（指路注释 + 判据注释的提及）与 **1 行调用**；`function orchestrateSlices` /
  `function parseSlices` / `parseSlices(readFileSync` 全部 **0 处**。

```
结论：PASS（同一逻辑只有一处）
index.js 行数 = 2651，sliceOrchestration.js 行数 = 250
```

---

## 7. 两道棘轮

### 7.1 `dsh-parity`：锚点 **1739 → 1721**（对拍出来的）

`LEGACY_CALL_SITE = { file: 'plugins/src/index.ts', line: 1721, … }`。

**不是用算术算出来的**：用模块**自己的抽取器** `extractLegacyCallOptions` 逐个调用点求顶层选项
集合，再要求与 `LEGACY_CALL_OPTIONS` `deepEqual` 的**恰好一个**。原始输出：

```
调用点总数 = 4 （上一批记录 4）
各行号 = 976, 1721, 1937, 2312

逐行抽取选项集（抽取器返回 {line, options}）：
  行   976  选项 = [label, prompt, parent, signal, outputSchema]
  行  1721  选项 = [label, prompt, parent, signal, outputSchema, ...spread]   ← ★ 与期望完全一致
  行  1937  选项 = [label, prompt, parent, signal, outputSchema]
  行  2312  选项 = [label, prompt, parent, signal, outputSchema, agentOptions]

与期望选项集完全一致的调用点 = 1 个： 1721

★ 结论：新行号应为 1721（原 1739）——唯一，可安全改写 LEGACY_CALL_SITE.line
  位移 = -18 行
```

**算术这次对了——但是"按锚点之上净变化"算才对**：−19（`parseSlices` 定义 −22 +3）
＋ 1（新 `import`）＝ **−18**，落在 1721。

而"这一批一共删了多少行"（**−66**，即总行数 2829 → 2763 的净变化）给出 **1673**，**差 48 行**。
原因：最大的那一块 `orchestrateSlices`（−65）**整个在锚点之下**，它一动，锚点纹丝不动。

| 算法 | 结果 | 对错 |
|---|---|---|
| 对拍（抽取器 + `deepEqual`） | **1721** | ✔ 权威 |
| 锚点**之上**净变化（−19 + 1） | 1721 | ✔ 这次对了 |
| 本批**总**净变化（−66） | 1673 | ✘ 差 48 |

> 锚点动不动，只由**它上面净改了几行**决定——而「哪几行在它上面」必须逐块核对行号，
> 不能凭「这一批一共删了多少行」来推。切片 2 / 3 / 6 的算术都不对，4 / 5 / 7 的对；
> 决定对不对的从来不是记性。**规矩不变：每次都重新对拍，算术只用来解释位移。**

注记**插在收尾 `*/` 之前**（切片 3 那次的教训：插到 `*/` 之后 ⇒ 测试文件**解析**失败，而
「文件读不出来」与「断言失败」在只看"红没红"的时候长得一模一样）。插完后全文 `*/` 出现次数
**15 → 15 不变**，作为「没把注释块提前闭合」的机械证据。

顺手修掉一个自己引入的瑕疵：第一版注记让末句**重复了一次**（第 179/180 行同文），
`prt315g-repin-fix.mjs` 删掉后 `parity.mjs` 从 663 → **662** 行（全 CRLF）。`dsh-parity` **36/36**。

### 7.2 `dsh-boundary --check`：PASS（**3 文件 / 26 处，与基线一致**）

新模块**执行面记号贡献 = 0**：它只经 `hubPost`（HTTP）与 `runGit` 触碰外界，没有一行 `ctx.*`。
本模块的注释里**也不写出**执行面记号的整串字面形式——写成整串会被记成「执行面依赖 +1」，
那是往坏的方向错的假阳性（`parity.mjs` 的注记同样遵守这条）。

---

## 8. ★★ 诚实边界

### 8.1 哪些不变量**有可执行用例**（404 条套件里的具体条目）

| # | 不变量 | 用例 | 文件 |
|---|---|---|---|
| A1 | ① 的 4 条日志 / 2 条评论活动串 / POST body **逐字** | ★ 分析前缀尾 done → 解析 → POST | `sliceOrchestration.test` |
| A2 | `res.created ?? []`（缺字段记 0，不崩不跳评论） | ★ `res` 里没有 `created` → n=0 | 同上 |
| A3 | 幂等：`:S` 前缀 / devops 尾 `slice === td.id` 两条各自成立 | ★ 幂等 ×2 | 同上 |
| A4 | 退避窗 `intervalMs*6`：窗内**连文件都不读**、窗后立刻重试 | ★ 退避窗内不重试 | 同上 |
| A5 | 清单为空 → 退避 + 日志 + **本轮 ② 整段不跑**（那句 `return`） | ★ 清单为空 | 同上 |
| A6 | 读得动但读炸（EISDIR）→ 吞掉 + 两条日志 + 退避 + **不抛** | ★ 文件读得动但读炸 | 同上 |
| A7 | 注册失败 → 退避 + 逐字日志 + 不发评论/活动 + **不抛** | ★ 注册失败 | 同上 |
| A8 | 目标目录解析：`goalId` 命中 → 读 `docs/<goalId>/`，**不**读根 `docs/` | ★ 目标目录解析 | 同上 |
| A9 | ② 三条闸门：预算评论 / fix 数超预算 / fix 未全 done | ★ 已升级将军 + 四种都不重开 | 同上 |
| A10 | `canceled` 的 fix **不计入** | ★ 半 canceled | 同上 |
| A11 | 换基线：`worktree remove --force` + `branch -D w/<id>`，argv 与**次序** | ★ isolate=true | 同上 |
| A12 | `remove` 失败 → `(err \|\| out).trim()` 两条分支 + 分支仍删 + tester 仍重开 | ★ 失败 / ★ err 空 | 同上 |
| A13 | `stale` 目录不存在 → 只删分支；`isolate=false` → 零 git 调用 | ★ 不存在 / isolate=false | 同上 |
| A14 | `config` 是**活的**（构造后改 `maxFixPerSlice` 立刻生效） | ★ config 是活的 | 同上 |
| A15 | **无模块级状态**：两实例各持一份退避表；同实例两轮都注册 | ★ ×2 | 同上 |
| A16 | `parseSlices` 格式契约（段头 / `\|` 四段 / `:` / `S` 可省 / `*` / CJK 逗号分号 / 空标题 / 下一标题即止 / 无段头） | 4 条 | 同上 |
| A17 | 非本 scope / `hold` / `canceled` / 无 `[slice-mode]` 不算切片任务 | 3 条 | 同上 |
| A18 | **调用点**：`if (useHub)` 守卫——本地模式**不**编排 | ★ 调用点守卫 | `slice-orchestration.test` |
| A19 | **调用点**：`try/catch` 吞错成一行日志 + **本轮心跳仍写** | ★ 调用点 try/catch | 同上 |

### 8.2 哪些是**弱钉**（变异只红到部分相关用例 / 靠端到端顺带覆盖）

- **A1 的"逐字"只有 ① 那一支**：② 的评论/活动/日志在 ★ 重开用例里逐字断言了，但
  **`activity('worktree', …)` 与 `activity('retest', …)` 两条文案**只有一条用例各钉一次；
  改文案会红，但只红一条（**M5 那种一击必中是因为 `activity('slices')` 只被一条用例覆盖**）。
- **`safeComment` 的失败**（`throw`）没有被单独钉：本界对 `safeComment` 的异常**没有**内层
  catch——它会冒到 `// 5.` 的 `try/catch`。这条路径由 **A19 的变异（M15/M11）间接覆盖**，
  但没有一条用例**直接**让 `safeComment` 抛。
- **`hubPost` 的非 `Error` 抛出**（抛字符串）：日志用 `String(e)`，行为一致但无用例。

### 8.3 哪些**只在注释里写着**（没有可执行用例钉住）—— 已逐条处置

| 只有注释写着的claim | 处置 |
|---|---|
| 「devops 尾 slice 键 = 目标级收尾」的**语义**（为什么 devops 尾不算"新切片束"） | **不可执行**：这是格式约定，钉的是**行为**（A3 已钉"devops 尾 T-001 时不再注册"）。语义本身留在注释。 |
| 「切片之间互不依赖、可并行派工」 | **不在本界**：`blockedBy` 由注册端预建，本界只发 body。**未钉**，且不该在本界钉。 |
| 「② 重测是『换基线』语义，不是『打回续做』」 | A11（argv 与次序）+ A13（`isolate=false` 时零 git 调用）已把**行为**钉住；注释解释的是**为什么**。 |
| 「每实例一份状态」的**部署理由**（多空间 mount） | A12 钉住了**结果**（两实例不串台）；「`superviseSpaces` 会 mount 多个实例」这半句在 `index.ts`，**未钉**（属 `superviseSpaces` 的边界）。 |
| 调用点注释「本轮照常收尾（`writeDaemonStatus` 仍会跑）」 | **原本是空的，本轮补上了真断言**（A19 + M15，见 §5）。 |
| `parseSlices` 全角 `：` **不做分隔符** | A16 已**显式**钉住这条（写成"把现行行为逐字继承"，而不是"这是对的"）。 |

### 8.4 仍然纠缠在 `spaceWorker()` / `sweep()` 里的东西（切片后的状态）

`spaceWorker()` 2092 行，仍是全文 75.7%。**仍未拆出、且我在本轮判断为"切不动或不该切"**的：

1. **`sweep()` 的骨架本身**（读控制位 → 模式分派 → 刷新绑定/流水线/心跳/技能/规范 → 对话回写 →
   `listTasks` → `fetchGoals` → 房间/槽位计算 → 派工循环 → 各 `// n.` 补流转 → `writeDaemonStatus`）。
   它每一步都直接读写闭包里的 `let`（`inflight`、`lastTasks`、`recallCorpusCache`、
   `spaceBinding`、`hubUrl`…）。拆它需要先把**共享可变状态**整体外置或改成显式上下文对象——
   那是一次改行为的重构，**不是切片**。
2. **`refreshGoals` / `refreshPipelineFromHub` / `hubHeartbeat` / `ensureForeman` / `fetchSkills` /
   `refreshNorms` / `sweepChatReplies` 七个刷新函数**：各自读写自己的 `let` 缓存，
   彼此之间**没有**「自带完整语义」的边界，拆出去只会把闭包状态也一起拖出去。
3. **派工循环**（`sliceRoomOk` / `goalBusy` / `inflight` / 类型化槽位）：它读的
   `inflight` 与 `config.maxWorkers` 是**跨 sweep 存活**的调度状态，与 `superviseSpaces` 的
   worker 生命周期绑在一起。
4. **`isSliceBeam` 的定义**（本界唯一读者却仍留在 `index.ts`）：它与 `sliceGoalKey`、
   `isSliceGoalTask`、`parseSlices` 同属「切片键判据」一家；只搬 `isSliceBeam` 会让
   「什么算切片任务」分散到两个文件。**这是一次判断，不是硬约束**——如果下一位认为
   「同族判据应随首个消费者走」，可以把它搬进本模块，代价是 `index.ts` 要 import 回来
   给 `// 4.`/`// 5.` 之外的调用点用（`grep` 已确认目前**只有本界**一个调用点）。

### 8.5 其它诚实限制

1. **替身不是真系统**：`hubPost` / `safeComment` / `transitionTo` / `runGit` 都是注入的替身。
   新用例证明的是「以哪一份 body / 哪一组 argv 调了谁、几次、什么次序」，**不**证明真实
   team-hub `/api/goal/slices`、`/api/transition` 与真实 git 的行为。真实端到端仍由
   `slice-orchestration.test.mjs` 里既有的 3 条 e2e 用例覆盖（M9/M12 证明它们仍然有效）。
2. **`activity(...)` 的落盘行为未验**：只断言了「以哪三元组调了 `activity`」。
3. **多空间串台只验到"两个实例不共享退避表"**：没有真的 mount 两个 `spaceWorker` 再并发跑。
4. **`hooks` / 时间**：A4 用 `Date.now()` 与 `intervalMs*6` 的真实比较；在极端慢的机器上
   「窗内不重试」可能因耗时跨过窗口而假红（概率极低，但未注入假时钟）。
5. **`docs/STATUS.md` 等批次台账**：切片 6 的提交动过它们；本切片**未改**（见 §11 第 3 条）。

---

## 9. 复核命令与原始输出

全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`，`$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'`。

| 命令 | 结果 |
|---|---|
| `cd plugins; npm run typecheck` | **exit 0** |
| `cd plugins; npm run build && node --test tests/*.test.mjs` | **404 pass / 0 fail**（10 套件；`duration_ms 4992`） |
| `node --test runtime/adapters/dsh/parity.test.mjs` | **36 pass / 0 fail** |
| `node --test tests/sliceOrchestration.test.mjs` | **32 pass / 0 fail** |
| `node --test tests/slice-orchestration.test.mjs` | **9 pass / 0 fail** |
| `git diff --stat -- plugins/src/index.ts` | `1 file changed, 25 insertions(+), 91 deletions(-)` |
| `git diff --cached --stat` | 5 files, 1118 insertions(+), 93 deletions(-) |
| `node scripts/config/scan.mjs --check` | **PASS**（558 个疑似字面量） |
| `node scripts/ci/ci-syntax.mjs` | **PASS**（50 个脚本） |
| `node scripts/ci/encoding-check.mjs --all --quiet` | **PASS**（1940 个文本文件；无 U+FFFD） |
| `node scripts/ci/check-docs.mjs` | **PASS**（10 类校验项全绿） |
| `node scripts/ci/dsh-boundary.mjs --check` | **PASS**（3 文件 / 26 处，与基线一致） |
| `node scripts/prt/topology-inventory.mjs --diff` | **与清单一致（无漂移）** |
| `node scripts/prt/baseline-snapshot.mjs --check` | **平台契约与基线一致（无漂移）** |

git 状态（`git add -A` 之后）：

```
M  plugins/src/index.ts
A  plugins/src/sliceOrchestration.ts
M  plugins/tests/slice-orchestration.test.mjs
A  plugins/tests/sliceOrchestration.test.mjs
M  runtime/adapters/dsh/parity.mjs
```

**本轮真实撞到的那次 typecheck 红**（原文，供后人对照）：

```
src/index.ts(2037,33): error TS2322: Type '(goal: GoalCtx | null | undefined, legacyPath: string | null | undefined) => string' is not assignable to type '(goal: GoalCtxRef | null | undefined, legacyPath: string | null | undefined) => string'.
  Types of parameters 'goal' and 'goal' are incompatible.
    Type 'GoalCtxRef' is not assignable to type 'GoalCtx'.
      Type 'GoalCtxRef' is missing the following properties from type 'GoalCtx': id, scope, objective, status, and 2 more.
```

**未跑**：`scripts/ci/run-ci.mjs`（全量 CI，按本轮约定不跑）。

---

## 10. 猜测 / 不确定的地方

1. **`isSliceBeam` 留在 `index.ts` 是判断，不是硬约束**（§8.4 第 4 条）。我按「同族判据不拆散」
   选了留下；如果评判标准是「判据随首个（唯一）消费者走」，那它**应该**搬进来。两种都能自圆其说。
2. **`expandRetryAt` 不搬**的理由是「多空间 mount 共用一个模块注册表」。我**核对了**
   `superviseSpaces` 会按空间 mount 多个 `spaceWorker`，但**没有**写一条真的并发多实例用例去
   证明串台会发生——A12 证明的是「两个 `createSliceOrchestration` 各持一份表」。
3. **`docs/STATUS.md` / `PRT-IMPLEMENTATION-REPORT.md` / `PRT-PROGRESS.md` 我没有更新**：
   切片 6 的提交动过它们，但本轮任务把交付物明确限定为「新模块 + 用例 + 本文件 + 棘轮重置」，
   且这三个台账文件的更新口径（时间戳、计数、章节增删）没有在任务里给出。**这是本轮留下的
   一个明确的未完成项**，需要批次负责人决定是补一条还是由收尾统一写。
4. **新模块头部的注释量（约 200 行注释 / 308 行文件）比前作更密**：因为本切片要额外解释
   「为什么不在 spec 点名的五条边界里」「为什么这一片没有取值函数」「两个容器为什么只借不搬」。
   如果评审认为注释过密，可压缩的是「注入改写白名单」与「边界」两节（它们与 §1/§4 有重叠）。
5. **`spaceWorker()` 的 −67 是按花括号配平脚本量的**（`prt315g-measure.mjs`）。脚本会跳过
   注释与引号串里的括号，但**不解析**正则字面量里的 `{`/`}`（本文件的 `parseSlices` 正则有
   `{2,3}` / `{1,6}`）。我在改后实测 `spaceWorker()` 从 485→486 起、2643→2577 止，
   与逐项对账（−68+3+13+4−22+3 = −67）**吻合**，故认为配平正确；这是一个**弱证据**。

---

## 11. 留痕（scratch 脚本，都在 `D:\project\DSH\legion\.worktrees\_prt-handoff\`）

| 脚本 | 作用 |
|---|---|
| `prt315g-pristine.mjs` | 存 pristine 副本并核对与 HEAD blob 逐字节一致（sha256 `84c97eb6c6afbf5c…`） |
| `prt315g-cut.mjs` | 量出被搬块的行号与 sha256 |
| `prt315g-header.txt` | 新模块的文件头（当**外部文本**读入，避免模板字符串转义写坏 CJK 反引号） |
| `prt315g-module.mjs` | 组装 `sliceOrchestration.ts`（真实函数体一律从 pristine 切，不手打） |
| `prt315g-index.mjs` | 逐行改 `index.ts`（**先全量断言再施加**，任一行不符立即停手不写文件） |
| `prt315g-compare.mjs` | 逐字对拍 + 白名单命中数 + 残留检查 |
| `prt315g-singleplace.mjs` | 按**构建产物**查"同一逻辑只有一处" |
| `prt315g-probe.mjs` | 探针：`readFileSync(目录)` 抛 EISDIR；`parseSlices` 十种输入的实际读数 |
| `prt315g-measure.mjs` | 花括号配平量 `spaceWorker()` 前后 |
| `prt315g-rederive-parity.mjs` | 用模块**自己的抽取器**重导锚点（权威），算术只用来解释位移 |
| `prt315g-repin-parity.mjs` / `prt315g-repin-fix.mjs` | 改写 `LEGACY_CALL_SITE.line` + 插注记（**在收尾 `*/` 之前**）+ 删掉重复末句 |
| `prt315g-addcallsite.mjs` | 把 2 条调用点用例追加进 `slice-orchestration.test.mjs`（CRLF 逐行拼） |
| `prt315g-fix-heartbeat.mjs` | 把空转的心跳断言改成"哨兵必须被覆盖" |
| `prt315g-mut.mjs` / `prt315g-mut-order.mjs` / `prt315g-mut-M15b.mjs` / `prt315g-mut-M15c.mjs` | 15 组变异（改 → 重建 → 跑 → 逐字节还原） |
| `prt315g-mut-*.log` / `prt315g-anchor.log` | 变异的**原始输出**留痕 |
| `prt315g-index.ts.pristine` | pristine `index.ts` 备份 |

> `index.ts` 是 **CRLF**、新模块与新用例是 **LF**（与既有六个切片一致；`core.autocrlf=true`，
> git 提交时两侧归一化，`git diff --stat` 证明没有整文件行尾变更）。所有写入都走
> `write`/`edit` 或上述脚本，**从不** `Get-Content -Raw` + `Set-Content`（会毁掉 CJK）。
