# PRT-315（切片 6）：拆分 `plugins/src/index.ts` —— 流水线阶段交接（交接边界）

spec（`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md:882`）：

> `PRT-315`：按仓储、状态机、workspace、验收和交接边界拆分 `plugins/src/index.ts`，每次只迁移一个切片。

前五个切片：`./mediation.ts`（交接·合入调解）、`./reclamation.ts`（仓储）、`./stateMachine.ts`（状态机）、
`./workspace.ts`（workspace）、`./acceptance.ts`（验收）。本切片是**第 6 个**，取「交接边界」的正中间那一步：
**一个阶段任务 done 之后，把接力棒交给下一角色**——`advancePipeline(doneTask)`。

新模块：`plugins/src/handoff.ts`（221 行，LF）；新用例：`plugins/tests/handoff.test.mjs`（478 行 / 32 条）；
另在既有 e2e 文件 `plugins/tests/slice-orchestration.test.mjs` 增 1 条**调用点用例**（+81 行）。

---

## 1. 搬了什么、没搬什么

### 搬了（57 行 → 逐字搬）

| 段 | 内容 | 提取坐标（改前 `index.ts`） |
| --- | --- | --- |
| `advancePipeline` | JSDoc + 函数体（切片/fix/分析前缀尾三道闸门 → 查 stage/next → 查后继 → 拼 title/description → `useHub ? /api/create : taskctl create` → log + activity → catch 只记日志） | 1486–1542（57 行） |

对外形状与其它切片一致：`createHandoff(deps)` 返回 `{ advancePipeline }`；`index.ts` 只做接线，
两处调用点照旧（`runWorker` 的常规 done 分支、`sweep()` 的 `// 4.`）。

### 提成函数（本切片**唯一**超出"逐字搬"的改动，逐条声明）

| 改动 | 从哪到哪 | 为什么 |
| --- | --- | --- |
| `isSliceTesterTask(stage, t)` | `index.ts` 的**两处内联条件**（`buildWorkerPrompt` 的「测试士兵纪律」段 + `runWorker` 的 D7' 机器闸门）→ `handoff.ts` 的**一个纯函数**导出 | 这串条件此前在两处各写了一遍。搬一格内联等于把"同一判定两处写法"照抄过来；提成纯函数后两处**共用同一个定义**（任务不变量 §5）。条件与短路次序一字未改，纯函数、无可观测差异。它是 D7' **交接绕行**的判定，与 `advancePipeline` 是同一问题的两个面，故放在一起。 |

### 没搬（**每一处都点名**）

| 没搬的东西 | 为什么 |
| --- | --- |
| D7' 闸门的**动作** `settleSliceTest()` | 要 hub `/api/test-report`、`commitWorktree`/`recordPatch`、按预算建 fix 任务——跨**执行面 + workspace 边界**。本切片只搬它的**谓词**（上表）。 |
| D7' 闸门在 `runWorker` 里的**位置**（必须早于常规 done 分支） | 那是控制流的形状，不是模块能表达的东西。是否被用例钉住见 §8。 |
| `launchPipeline()`（讨论收敛 → 建**首阶段**任务） | 它是**讨论 → 流水线**的入口交接，不是"阶段 → 阶段"的交接：触发者是 `runDiscussion`（需求讨论群聊边界），读的是 `pipeline.stages[0]`（**有序阶段表**，不是 role→stage 映射）。**这是一个边界判断，不是硬约束**——它是本切片最近的未搬邻居，见 §8 诚实边界第 9 条。 |
| `stageOf(t)`（任务 → 阶段） | `sweep()` 的 `// 4.` 过滤式与 `./stateMachine.ts` 都读它。搬进来要么留第二份（同一逻辑两处），要么让状态机反向依赖交接模块。故与切片 3 同形：单一定义留在 `index.ts`，调用点注入。 |
| `SLICE_ANALYSIS_TAIL` / `isSliceGoalTask` | 同上：`orchestrateSlices()`（切片编排边界，`// 5.`）也读它们。单一定义留 `index.ts`，按**值**注入。 |
| 两处**调用点**本身（含 `if (isPipeline)` 守卫与 `stageOf(x) !== undefined` 过滤式） | 调用点是控制流，留在 `spaceWorker()`；§8 说明它们各自被什么钉住。 |

---

## 2. 行数与用例

| | 改前 | 改后 |
| --- | --- | --- |
| `plugins/src/index.ts` | **2862 行**（全 CRLF，裸 LF = 0） | **2829 行**（全 CRLF，裸 LF = 0） |
| `plugins/src/handoff.ts` | — | **221 行**（全 LF） |
| `plugins/tests/handoff.test.mjs` | — | **478 行 / 32 条**（全 LF） |
| `plugins/tests/slice-orchestration.test.mjs` | 571 行 | **652 行**（+81，1 条新 e2e） |
| `runtime/adapters/dsh/parity.mjs` | 614 行 | **637 行**（全 CRLF；只增 JSDoc 注释块） |

```
$ git diff --stat -- plugins/src/index.ts
 plugins/src/index.ts | 89 +++++++++++++++++-----------------------------------
 1 file changed, 28 insertions(+), 61 deletions(-)
```

净 **−33 行**，逐项可对账：

| 改动 | 行数 |
| --- | --- |
| 摘掉 `advancePipeline` 定义（57 行）→ 留 5 行指路注释 | **−52** |
| `import { createHandoff, isSliceTesterTask }` | **+1** |
| `buildWorkerPrompt` 里那串条件 → `isSliceTesterTask(...)` | 0（1 → 1） |
| D7' 闸门旁 3 行指路注释 | **+3** |
| `const handoff = createHandoff({...})` 接线 | **+15** |
| 两处调用点 `advancePipeline(t)` → `handoff.advancePipeline(t)` | 0 |
| 合计 | **−33** ✓ |

用例：**337 → 370**（`handoff.test.mjs` +32、`slice-orchestration.test.mjs` +1），**0 fail**。

```
ℹ tests 370
ℹ suites 10
ℹ pass 370
ℹ fail 0
```

---

## 3. ★ 状态 / 取值函数 / 结构性类型

1. **没有任何状态**。`advancePipeline` 不持有跨轮状态（连每实例状态都没有）：它只做**读**
   （本实例流水线定义 + `listTasks()` 的任务快照）与**一次创建调用**。
   `superviseSpaces()` 会在同一进程里按空间把 `spaceWorker` mount 成多个子实例
   （`index.ts` 的 `mountRunner`），它们共用一个模块注册表——所以本模块**连一个模块级 `let` 都没有**
   （顶部只有 import、interface、两个函数）。模块级记忆会让空间 A 的流转把空间 B 的**同名 taskId**
   一起挡住（多空间部署里撞号是常态）。用例里有一条直接钉这条（同一任务调两次 = 两次创建）。
2. **取值函数**（运行期会被重新赋值的 `let`，一律传 `() => x`）：
   - `pipeline`：`applyPipeline()` 换来源时整体改写，数据面清空还会**退回 null**（双向都动）；
   - `stageByRole`：`applyPipeline()` 每次把整个 `Map` **替换**成新的；
   - `useHub`：`detectHub()` 探测成功后改写。
   传值 = 构造时冻结旧快照，症状**一行日志都没有**：`pipeline` 快照成 null → 整条流水线永不流转；
   `stageByRole` 快照 → 换编队后"下一角色"查旧表查不到；`useHub` 快照成 false → 有 hub 却去 fork taskctl。
   三条都在 `handoff.test.mjs` 里有**活性用例**（构造后改 `h.state.*` 立刻生效）。
3. **传值**：`scope`（`const`）、`listTasks`（身份稳定的 `const` 箭头，内部自带 `useHub` 分派）、
   `hubPost` / `runTaskctl`（函数声明）、`log` / `activity`（`const` 箭头）、
   `SLICE_ANALYSIS_TAIL`（常量）、`isSliceGoalTask`（身份稳定的箭头函数）。
4. **`config` 用结构性类型**（`{ role, scrumDir }`）而不是 import `Config`：与五个前切片同源，
   import 会形成**真的**运行时循环依赖。调用点传的是真的 `Config`，TypeScript 在赋值处校验。

---

## 4. 逐字对拍（谁证明了"搬得没走样"）

`_prt-handoff/prt315f-compare.mjs`：按**锚点**（不是行号）从 pristine `index.ts` 与 `handoff.ts`
各切一次 `advancePipeline` 块（57 行），对旧块施加**穷尽白名单**（3 条正则）后逐行比较：

```
旧块行数（归一化前/后）= 57 / 57
新块行数（归一化前/后）= 57 / 57

✔ 57 行逐字一致（归一化后；已施加 3 条注入改写）

改写规则白名单（穷尽，共 3 条）：
  \buseHub\b  →  useHub()        命中 1 处
  \bpipeline\b  →  pipeline()    命中 1 处
  \bstageByRole\b  →  stageByRole()  命中 2 处

✔ 改后 index.ts 已无「async function advancePipeline(doneTask:…」
✔ 改后 index.ts 已无「log(`${doneTask.id} 流转失败：…」」

D7' 谓词：旧 index.ts 内联出现 2 处；改后 index.ts 出现 0 处；
  handoff.ts 里的纯函数体 = `return stage?.role === 'tester' && ...` → true
✔ D7' 谓词：两处内联条件 → 一个纯函数定义，条件逐字未改
```

"改前"副本经 `prt315f-verify-pristine.mjs` 与 **git HEAD blob** 逐字节核对（归一化 CRLF 后 sha256 相同）：

```
✔ plugins/src/index.ts（归一化 CRLF 后逐字节相同）
   HEAD blob  sha256=90d59ff2… bytes=166604 行=2862
   改前副本   sha256=2be6b861… bytes=169466 行=2862
✔ runtime/adapters/dsh/parity.mjs（归一化 CRLF 后逐字节相同）
   HEAD blob  sha256=d266e08e… bytes=29829 行=614
   改前副本   sha256=0260333e… bytes=30443 行=614
```

（工作区检出为 CRLF、仓库 blob 存 LF，字节数差 = 行数，正是行尾转换。）

---

## 5. ★ 断验证（变异 → 红 → 逐字节还原）

脚本：`_prt-handoff/prt315f-mut.mjs`（M1–M6）、`prt315f-mut7.mjs`（M7）。
每次：**改源码 → `npm run build` → 跑测 → 打原始红 → 从快照逐字节还原（sha256 相等）→ 重建**。

| # | 改哪 | 变异 | 跑什么 | 结果 |
| --- | --- | --- | --- | --- |
| M1 | `handoff.ts` | 删 `if (doneTask.slice != null) return` | `tests/handoff.test.mjs` | **1 fail / 31 pass** |
| M2 | `handoff.ts` | 后继识别去掉 `t.status !== 'canceled'` | 同上 | **1 fail / 31 pass** |
| M3 | `handoff.ts` | 后继识别去掉 `t.scope === scope` | 同上 | **1 fail / 31 pass** |
| M4 | `index.ts` | 接线 `useHub: () => useHub` → `() => false`（快照可变绑定） | 全量 370 | **2 fail / 368 pass** |
| M5 | `index.ts` | 整块删掉 D7' 机器闸门 | 全量 370 | **2 fail / 368 pass** |
| M6 | `index.ts` | 删掉 `sweep()` 的 `// 4.` 补流转调用点 | 全量 | **改前 370 全绿（不咬）→ 补 e2e 后 1 fail** |
| M7 | `index.ts` | 把 D7' 闸门搬到常规 done/blocked 分支**之后** | 全量 370 | **1 fail / 369 pass** |

原始红（摘录，完整在 `_prt-handoff/prt315f-mut-M*.log`）：

```
===== M1 =====
✖ ★★ 切片测试任务（tester + T-4:S1）即使被喂进 advancePipeline 也不建常规后继 (1.4803ms)
ℹ tests 32   ℹ pass 31   ℹ fail 1

===== M2 =====
✖ ★★ canceled 是唯一不算存在的状态：blockedBy 命中但 status=canceled → 照常补建 (1.2855ms)
ℹ tests 32   ℹ pass 31   ℹ fail 1

===== M3 =====
✖ ★ 同角色同 parent 但**不同 scope** → 不算后继（多空间部署：任务 id 跨空间会撞号） (0.7474ms)
ℹ tests 32   ℹ pass 31   ℹ fail 1

===== M4（全量）=====
✖ 多轮同 path 字节未变不重复登记（幂等）；变化则追加新条目（AC-R2-3 多轮倒序数据源） (10049ms)
✖ ★ 人工/验收 done 的中间阶段任务：下轮 sweep 的 `// 4.` 补流转建下一角色任务（PRT-315 切片 6 调用点） (10020ms)
ℹ tests 370   ℹ pass 368   ℹ fail 2

===== M5（全量）=====
✖ a passing slice tester report auto-advances done under tester identity (D7 gate) (34.3621ms)
✖ a failing slice tester parks in_review and creates a bounded fix task (10034ms)
ℹ tests 370   ℹ pass 368   ℹ fail 2

===== M6（全量，**补 e2e 之前**）=====
ℹ tests 369   ℹ pass 369   ℹ fail 0        ← ★ 不咬：整块调用点删掉，全套件绿

===== M6（全量，补 e2e 之后）=====
✖ ★ 人工/验收 done 的中间阶段任务：下轮 sweep 的 `// 4.` 补流转建下一角色任务（PRT-315 切片 6 调用点） (10025ms)
ℹ tests 370   ℹ pass 369   ℹ fail 1

===== M7（全量）=====
✖ a failing slice tester parks in_review and creates a bounded fix task (44.279ms)
ℹ tests 370   ℹ pass 369   ℹ fail 1
```

还原判据（每次变异后都打印，且末次重建全绿）：

```
✔ index 已按快照逐字节还原：04ebdfe6960c6988dfb71d49cba5ca25be3d5f5d2f8406861a9b281d1a4c5318
✔ handoff 已按快照逐字节还原：99a7d0f803602de2fc47787d2b621e3acfa68de0684c249b028230925a7a3e02
```

### ★ 那次**不咬**的变异（M6）以及我做了什么

`sweep()` 的 `// 4.`（"将军人工合入/验收后手动 done 的中间阶段任务 → 补建下一角色任务"）
**整块删掉，370 条全绿**。这正是切片 5 那条教训在本切片的实例：
`handoff.test.mjs` 只喂 `advancePipeline` 本身，**看不见 `index.ts` 里的调用点**——
"调用点写在注释里"和"调用点被用例钉住"，在绿套件里长得一模一样。

处置（对齐切片 5 的标准）：在 `slice-orchestration.test.mjs` 补一条**真 e2e 调用点用例**
（`fakeContext` + 打桩 hub，`mkdtemp` 临时目录）：

- board 只有一条**人工 done 的 coder 阶段任务**（`roles.json`：coder → tester），跑一轮扫单；
- 断言 `POST /api/create` 的 body **逐字段**（`title` 为 `【测试执行】登录接口`、
  `description` 的三段拼法、`role/parent/priority/status/by/scope`），
  并断言 `goalId` **键不在** body 里（`JSON.stringify` 丢掉 `undefined`，
  不是传 `null`——这条此前只写在代码里，没人钉过）；
- 第二轮扫单前把新任务放进 board（模拟 hub 落库）→ 断言**不再重复补建**（幂等）。

补完后 M6 咬住（1 fail）。同一文件里既有的两条 D7' e2e 用例是 M5 的咬点。

---

## 6. "逻辑只有一处"（按**构建产物**查）

`_prt-handoff/prt315f-singleplace.mjs`：

```
lib/index.js = 2729 行；lib/handoff.js = 188 行（存在=true）

搬走的运行期指纹（应在 handoff.js，不在 index.js）：
  ✔ "流水线流转："      handoff.js=true  index.js=false
  ✔ "流转失败："        handoff.js=true  index.js=false
  ✔ "流水线流转 "       handoff.js=true  index.js=false
  ✔ "[前序阶段] "       handoff.js=true  index.js=false
  ✔ "  async function advancePipeline"  handoff.js=true  index.js=false

留在 index.js 的兄弟能力（应在 index.js，不在 handoff.js）：
  ✔ "讨论收敛 → 启动流水线首阶段" / "启动流水线失败：" / "讨论收敛 → 启动流水线 "
      index.js=true  handoff.js=false

handoff.js 对执行面记号的贡献（必须为 0）：
  ✔ 不含 "@deepseek-ai/dsh-" / "inject:" / "subagents"
```

## 7. 两道棘轮

### 7.1 `dsh-parity`：锚点 1790 → **1739**（对拍出来的）

```
调用点总数 = 4 （上一批记录 4）
各行号 = 994, 1739, 1955, 2382
  行   994  选项 = [label, prompt, parent, signal, outputSchema]
  行  1739  选项 = [label, prompt, parent, signal, outputSchema, ...spread]   ← ★ 与期望完全一致
  行  1955  选项 = [label, prompt, parent, signal, outputSchema]
  行  2382  选项 = [label, prompt, parent, signal, outputSchema, agentOptions]
与期望选项集完全一致的调用点 = 1 个： 1739
  算术（本批锚点之上净 −52 行）会给出 1738
★ 结论：新行号应为 1739（原 1790）——唯一
  位移 = -51 行 ；与实际相差 1 行 ⇒ ★ 算术错了，必须以对拍为准
```

**算术为什么错 1 行**：只算了"被搬走的那块"（57 → 5 = −52），**漏了新增的那个 import**
（`import { createHandoff, isSliceTesterTask } …`，+1）——它也在锚点之上，而"数一数被搬走的块"
这种算法天然看不见自己刚加的那一行。锚点之上净 **−51**，锚点之下（闸门注释 +3、接线 +15）不影响它。

`parity.mjs` 里只增了一个 JSDoc 注释块（**插在收尾 `*/` 之前**，避免切片 3 那种"解析红"）；
`line:` 由 1790 改为 1739。改后：

```
$ node --test runtime/adapters/dsh/parity.test.mjs
ℹ tests 36   ℹ pass 36   ℹ fail 0

$ node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
```

（`handoff.ts` 的执行面记号贡献为 0，故基线不动；注释里也**不写出**执行面记号的整串字面形式。）

---

## 8. ★★ 诚实边界

### 8.1 哪些不变量**有可执行用例**（370 条套件里的具体条目）

**行为用例（`handoff.test.mjs`，替身注入，32 条）**——断言的是**精确 id / role / 字段 / 文案**：

1. 后继已存在的**两条识别**各自单独成立（`parent === 本任务`，**任意状态含 canceled**；
   `blockedBy` 命中且 `parent` 为空）；
2. ★ `canceled` 是**唯一**不算存在的状态（其余状态都算）——真被砍掉才允许补建；
3. ★ 同 role 同 parent 但**不同 scope** 不算后继（多空间撞号）；
4. 切片任务（`slice != null`）不建常规后继；**并配同形对照**（摘掉 slice 键的同一任务照常建
   devops），证明拦住它的是这道闸门而不是"tester 不流转"；
5. `fixOf != null` 不建；分析前缀尾 + `[slice-mode]` 不建（**含对照**：不带标记时照常建）；
6. 无 stage / `next === null` / `next` 指向不存在的角色（三种"没有下一棒"）；
7. hub 路径 `POST /api/create` 的 body **逐字段**；非 hub 路径 `runTaskctl` argv **逐条**；
   `log` 与 `activity` 文案**逐字**、`res.id` 缺失时空串占位；
8. 创建失败（hub 抛 / taskctl 抛）→ **只记日志、不抛出、不发 activity**；失败后同实例仍可工作；
9. 三个取值函数的**活性**（构造后改 `pipeline` / `stageByRole` / `useHub` 立刻生效）；
10. `isSliceTesterTask` **真值表**（7 组：角色 / slice 为空 / 无 `:S` / 多位数序号 / stage 未定义）；
11. 无模块级状态（同一任务调两次 = 两次创建；两个实例互不影响）。

**e2e 用例（`slice-orchestration.test.mjs`，真 `apply()` + 打桩 hub + 临时目录）**：

12. ★ **`sweep()` 的 `// 4.` 调用点**：人工/验收 done 的中间阶段任务 → 下一轮补建下一角色任务
    （逐字段 body + `goalId` 键不存在），且 board 出现后继后**不再重复补建**（本切片新加，专治 M6）；
13. D7' **闸门**：通过的切片 tester 自动 done（不落 in_review）；失败的落 in_review + 建 fix（既有两条）。

### 8.2 哪些只是**注释里写着**（没有可执行用例钉住）

1. **`runWorker` 里 `await handoff.advancePipeline(t)` 的先后**：它排在
   `advanceTo` → `safeComment` → `activity` → `log` 之后，且只在 `report.status === 'done'`
   分支里。把这一步与前面几条对调，**没有任何用例会红**（我没有做这个变异，这是从"哪条用例断言了什么"
   读出来的结论，不是跑出来的）。
2. **`sweep()` 的 `// 4.` 守卫形状**：`if (isPipeline)` 与
   `x.status === 'done' && stageOf(x) !== undefined` 两处。新 e2e 只证明"人工 done 的中间阶段任务会被补建"；
   去掉 `isPipeline`、或把 `stageOf(x) !== undefined` 放宽，行为在**单角色模式**下会变而套件可能仍绿。
3. **两道闸门的分工理由**（D7' 闸门 vs `advancePipeline` 自己的 `slice != null`）只在文件头注释里。
   可执行的部分是：`isSliceTesterTask` 真值表 + 切片任务不建后继 + 既有两条 e2e；
   但"D7' 闸门是为切片测试任务**改道结算**（而不是仅仅不流转）"这层语义，是那两条 e2e 顺带盖住的，
   不是本切片专门钉的。
4. **`SLICE_ANALYSIS_TAIL` / `isSliceGoalTask` 的"单一定义"**：靠的是 `index.ts` 里只有一个定义 +
   注入两个消费者；没有任何断言防止第三处再抄一份。

### 8.3 切片的顺序/调用点：**钉住了多少**（切片 5 那条教训的正面回答）

| 不变量 | 钉住方式 | 强度 |
| --- | --- | --- |
| 切片任务在 `advancePipeline` 里不建后继 | 行为用例（M1 咬） | 强 |
| "后继已存在则跳过"的两条识别与 canceled 口子 | 行为用例（M2/M3 咬） | 强 |
| `sweep()` 的 `// 4.` **调用点存在** | 新 e2e（M6 咬） | 中（只证明"人工 done 的中间阶段任务会被补建"这一条路径） |
| D7' 闸门**存在** | 既有两条 e2e（M5 咬） | 强 |
| D7' 闸门**早于**常规 done 分支 | 既有 e2e（M7 咬，**只红 1 条**：失败路径断言 `!advance:`；通过路径仍绿） | **弱**——把闸门挪到 done 分支之后，370 条里只红那一条；换句话说这条次序被"间接顺带"钉了个角 |
| `runWorker` 里 `advancePipeline` 与 `advanceTo` 的相对次序 | 无 | **无** |
| 接线把三个 `let` 按**取值函数**交出 | 无专门用例；`handoff.test.mjs` 测的是**模块侧**活性，看不到 `index.ts` 的接线。M4 会红，但红的是一条**不相干**的 e2e（`artifact-register`，经 taskctl fork 超时 10s）与本切片新加的那条 | **弱且间接** |

### 8.4 仍然纠缠在 `spaceWorker()` / `sweep()` 里的东西

本切片只搬了"一次交接"的函数体。下列东西**仍在** `index.ts`（按边界归属）：

- **两处调用点**：`runWorker` 的 done 分支（它在 `advanceTo`/评论/活动流之后）、
  `sweep()` 的 `// 4.` 循环（含 `if (isPipeline)` 与 `stageOf` 过滤式）；
- **D7' 闸门的动作** `settleSliceTest()`：hub test-report、worktree 提交、fix 任务预算与升级；
- **`launchPipeline()`**：讨论收敛 → 建首阶段任务（讨论边界 / 入口交接，见 §1 "没搬"）；
- **`orchestrateSlices()`**（`// 5.`）：切片束注册、fix 全 done 后重开 tester、`SLICE_ANALYSIS_TAIL` /
  `isSliceGoalTask` 的另一批读者；
- **`stageOf()`**：任务 → 阶段的查表，仍是单一定义、供调用点与 `./stateMachine.ts` 共用；
- **`advanceTo` / `safeComment` / `activity` / `workTree` / `recordPatch` / `commitWorktree`**：
  `autoPromote`、契约登记、产物登记等（`./workspace.ts` + 未拆的结算段）。

### 8.5 其它诚实限制

1. 用例的 `hubPost` / `runTaskctl` / `listTasks` 是**替身**：证明的是"以哪份 body / 哪组 argv 调了谁、
   调几次、顺序如何"，**不**证明真实 team-hub `/api/create` 与真实 `taskctl create` 的行为。
2. 新 e2e 是"真 `apply()` + **打桩 fetch**"：证明守护的控制流，不证明真实 hub 协议。
3. **未跑全量 CI**（任务禁止 `scripts/ci/run-ci.mjs`）；只跑了任务点名的门禁 + `plugins` 的 build/test/typecheck。
4. `launchPipeline()` 留在原地是**边界判断**：若评审认为"讨论 → 首阶段"也算阶段交接，
   那它就是本切片漏掉的一半（下一刀应把它一起搬，本模块因此需要 `pipeline().stages` 而不是只判空）。
5. M4 的红来自一条**不相干**的 e2e（`artifact-register`），说明"接线传值"这件事**没有专门的守卫**，
   只是被别的路径顺带踩到。这是真实的覆盖弱点，已列在 §8.3。
6. 用例只覆盖 `mkdtempSync(os.tmpdir())` 下的临时目录；**没有**读写操作员真实的 `~/.dsh`。

---

## 9. 复核命令与原始输出

（全部在 `D:\project\DSH\legion\.worktrees\prt-runtime`，`$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'`；
完整输出见 `_prt-handoff/prt315f-final.txt`）

```
$ (cd plugins) npm run typecheck
> tsc -p tsconfig.json --noEmit            # exit 0

$ (cd plugins) npm test
ℹ tests 370   ℹ suites 10   ℹ pass 370   ℹ fail 0

$ node --test runtime/adapters/dsh/parity.test.mjs
ℹ tests 36    ℹ pass 36     ℹ fail 0

$ node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）

$ git diff --stat -- plugins/src/index.ts
 plugins/src/index.ts | 89 +++++++++++++++++-----------------------------------
 1 file changed, 28 insertions(+), 61 deletions(-)
```

---

## 10. 猜测 / 不确定的地方

1. **`launchPipeline` 的归属**是判断，不是事实（§8.5 第 4 条）。
2. §8.2 第 1 条（`advancePipeline` 与 `advanceTo` 的对调不咬）是**从用例断言反推**的结论，
   我没有真去跑这个变异；§8.2 第 2 条同理。凡是"我跑过"的，都在 §5 的表里。
3. `isSliceTesterTask` 提成纯函数是否算"改行为"：我的判断是**不算**（纯函数、条件与短路次序逐字未改、
   两处旧条件与函数体做过字符串级核对）。但它确实**不是**纯粹的"逐字搬"，所以单列在 §1。
4. M7 的"只红 1 条"是本次实验的读数；若以后那条失败路径用例被改动，这个"弱钉"会静默消失。

---

## 11. 留痕（scratch 脚本，都在 `D:\project\DSH\legion\.worktrees\_prt-handoff\`）

| 脚本 | 作用 |
| --- | --- |
| `prt315f-module.mjs` | 从 pristine `index.ts` 切块 + 白名单改写 → 组装 `handoff.ts` |
| `prt315f-index.mjs` | 摘定义、换调用点、换 D7' 谓词、插接线、收 import（CRLF 原样写回） |
| `prt315f-compare.mjs` | 独立第二次抽取 → 逐行对拍 + D7' 谓词条件核对（§4） |
| `prt315f-singleplace.mjs` | 按构建产物查"逻辑只有一处"（§6） |
| `prt315f-hash.mjs` | pristine / post 快照的 sha256 |
| `prt315f-verify-pristine.mjs` | "改前副本" vs **git HEAD blob** 逐字节核对（§4） |
| `prt315f-rederive-parity.mjs` | 用 `parity.mjs` 自己的抽取器重钉锚点（§7.1） |
| `prt315f-repin-parity.mjs` | 写回新行号 + JSDoc 注释（插在 `*/` **之前**） |
| `prt315f-mut.mjs` | M1–M6 变异 + 快照还原（§5） |
| `prt315f-mut7.mjs` | M7：D7' 闸门搬到 done 分支之后（§5） |
| `prt315f-count.mjs` | 行数 / CRLF 精确读数（§2） |
| `prt315f-probe-sweep.mjs` | 调试探针（新 e2e 定位用，非交付） |
| `prt315f-mut-M*.log` | 各组变异的**原始红输出** |
| `prt315f-final.txt` | 最终 typecheck / npm test / parity / boundary / diff --stat |
