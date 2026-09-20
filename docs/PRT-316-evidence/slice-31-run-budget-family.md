<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 31：第二十九族 = 单次运行预算账本（6 条）—— 第一个用**显式路径表**取族的族

- **族**：`run-budget`（`team-hub/routes/run-budget.mjs`），**6 条 / 121 行**：
  - `POST /api/runtime/run-budget/reserve` · `/observe` · `/settle` · `/resolve`
  - `GET /api/runtime/run-budget`（列表）· `GET /api/runtime/run-budget/<attemptId>`（单条，**prefix**）
- **参考提交**：搬走前 `430d3dc`
- **规模**：区间 121 行（注释 20、路由 6）、**外来 0**、**分段 1**

---

## 1. 为什么是它，以及为什么**不能**用前缀

`/api/runtime` 那一段共 26 条，被 **16 个 `router.dispatch` 接缝**切碎，区间里还夹着 6 条别的族。
本族是其中**唯一一簇"名字像一族"**的（6 条 / 121 行）。

★★★ **前缀取不到它**：`/api/runtime/run-budget/may-switch-model` 落在**下一个簇**里（接缝另一侧），
而它同样以 `/api/runtime/run-budget` 开头 ⇒ 前缀会把它一起圈进来。

> 一个"族就是一个前缀"的印象，与一个"前缀只是**恰好**能圈住前 28 族"的事实，
> 在我没有数一下"还剩下几个前缀能圈住"的时候是同一个东西。

⇒ 本片是切片 30 那个 `F.paths` 能力的**第一次真正使用**：按**显式路径表**（6 条）取族。
D 段当场确认：`区间 L5591-L5703 内除本族外一条条件都没有，也没有接缝（6 条填满）`。

---

## 2. ★★★ 第一次用就逼出了**三处工具**的同一个缺陷

搬完第一遍，`wire-family` 报：

```
✔ ③ 被删区间 L5589-5735（147 行；其中方法条件 7 条，期望 6）
```

**区间是 147 行、7 条条件** —— 多出来的那一条正是 `may-switch-model`。
`wire-family` 的守卫当场拦住，**没有写盘**（事后 `git diff` 为空、`may-switch-model` 还在）。

根因：`wire-family` 的 `routeAt` 是 **`L[i].includes("'<prefix>")`** —— **前缀匹配**。
前 28 族的前缀恰好都能圈住自己，所以一直没暴露。

★ 顺着查下去，**同一个判据在三个工具里各抄了一份**：

| 工具 | 原来的判据 |
| --- | --- |
| `gen-family.mjs` | `F.prefix`（切片 30 已加 `F.paths`） |
| `wire-family.mjs` | `L[i].includes("'<prefix>")` |
| `check-region-lines.mjs` | `L[i].includes("'<prefix>")` |
| `pair-routes.mjs` | `familyFrom(src, prefixes)` / `residueLoose(src, prefixes)` |

`check-region-lines.mjs` 的注释里**明写着**："与 wire-family.mjs **同一套**区间算法
（刻意各写一份：两边不一致时要响）"。

> **一个"两份独立实现互相校验"的设计，与一个"两份抄的是同一条前缀判据、于是会一起错"的事实，
> 在这条判据从来没被第三种情况逼过的时候是同一个东西。**

★★ **这次"两边不一致就响"确实没响** —— 因为它们错成了同一个样子。
真正把它顶出来的是 `wire-family` 自己那道 `nCond !== expected` 守卫（7 ≠ 6）。
**是对条数的那道守卫救的场，不是"两份实现"那道。**

### 2.1 修法：让工具去**问模块**

模块是权威（生成器写的，且已过 D 段）。三个工具都改成：
从 `team-hub/routes/<族>.mjs` 里读 `path: '…'` 那一列，用它当"谁属于我"。

`wire-family` 另加一道**反方向**核查：模块声明的每一条路径，都必须在 `server.mjs` 里
**恰好找得到一条**（少一条 = 模块里有服务端没有的路由；多一条 = 同名路由没被模块覆盖）。

`pair-routes.mjs` 的 ①②③⑤ 四道口径随之全部改口（否则 ③⑤ 会把 `may-switch-model` 报成"残留"）。

---

## 3. ★★★ 破验量出来的三个**真缺口**（然后补上了）

本族**已经有强判据**：`team-hub/budget-routes.test.mjs`，**23 例 / 31 个真 HTTP 请求点**。
所以第一轮破验拿它当判据，结果：

```
15/20 咬住；真缺口 5 条
```

逐条查下去，**五条里两条可证等价、三条是真缺口**：

| 变异 | 判定 | 依据 |
| --- | --- | --- |
| M7 `budget: body.budget ?? null` 去掉 | **可证等价** | `reserve()` 第一句就是 `if (budget === null \|\| budget === undefined)` ⇒ 同一分支 |
| M8 `locked: r.locked === true` 改成原值 | **可证等价** | `settle()` **两条出口都显式给布尔**（锁定时 `true`、结算时 `false`），永远不是 `undefined` |
| **M12** `?state=` 过滤去掉 | **真缺口** | 带真夹具量过：不带 3 条 / `settled` 1 条 / `reserved` 2 条 |
| **M19** `match:'exact'` 松成 `prefix` | **真缺口** | `POST /api/runtime/run-budget/reserveX` 现在 404；松了会落进 `reserve` 的体（变 400） |
| **M20** `heldAmount(scope)` 改成常量 `'default'` | **真缺口** | `?scope=default`→`held=[{USD,100}]`、`?scope=other`→`[{USD,7}]`、`?scope=nope`→`[]` |

★ 量 M12/M20 时**第一版夹具是空的**（价目表没发出去 ⇒ 一笔预留都没建 ⇒ 三项全报"无区分度"）。
**空夹具会让"不可观测"和"没夹具"长得一模一样** —— 所以我在探针里加了一句
`if (pub.status !== 200) throw new Error('夹具没造出来')`。

> 一个"我量过了、没有区分度"的印象，与一个"夹具**是空的**、所以什么都没量到"的事实，
> 在我没有先断言"夹具造出来了"的时候是同一个东西。

### 3.1 补上：`team-hub/run-budget-routes.test.mjs`（8 例）

专钉那三处，不重复已有 23 例：

- ⑫ `?state=` 真在过滤（3 / 1 / 2）+ 认不出的 state 回**空**（不是悄悄退化成"全都要"）+ 与 `scope` 同时给
- ⑭ `held` 跟着 `scope` 走（100 / 7 / `[]`）+ 不带 scope 时是**全空间合计**（107）
- ⑮ `reserveX` 必须 404（exact 不松）+ 成对地钉"单条读那条**是** prefix" + 多段路径 404

**补完之后同一个破验：`18/20 咬住；真缺口 0 条；可证等价 2 条`。**
—— 这就是"补丁真的补上了"的证据：**补之前这三条不红，补之后红了。**

---

## 4. 其余量出来的事实

| 事实 | 读数 |
| --- | --- |
| 信封 | `handleRun` 的 **spread** 形状：`{ok:true, reservation:null, budgetState:'unbounded'}`（**不**包在 `task` 里） |
| `reserve` 不给 `budget` | 200 `{reservation:null, budgetState:'unbounded'}` —— "没有预算"是**显式的 unbounded**，不是遗漏 |
| 有预算但价目表取不到 | 409 `PRICE_TABLE_GONE`（不是把开发期断言漏出去） |
| `settle` 结果未知 | 转 `locked`，**不结算**；`locked` 只能走 `/api/runtime/run-budget/resolve` 人工处置 |
| `held` | 只算 `HOLDING_STATES`（`reserved`/`cancel-requested`/`cancelled`/`locked`）；`settled` 不占 |
| 单条读的键 | `att:T-1:1` 含冒号 ⇒ **必须百分号编码**；这条是**整段**解码（不像 model-bindings 按段切） |

---

## 5. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7120 | **7008**（−112；`+9/−121`） | 9221（累计 **−2213**） |
| `handle()` 路由条件 | 79 | **73** | 191 |
| `router.dispatch` 调用点 | 28 | **29** | 0 |
| `routes/` 族模块 | 28 | **29** | 0 |

**73 剩余 + 115 已搬 = 188** ✓ —— **已搬过 61.2%**（115 / 188）
被删区间 **121 行**（注释 20、路由 6），**丢注释 0 / 丢代码 0**

---

## 6. 判据

| 判据 | 结果 |
| --- | --- |
| 29 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 28 族读数未变** |
| **自由标识符常设判据** | ✅ 29 模块 / 未绑定 0 |
| 破验（补判据**前**） | **15/20**，真缺口 5（量清后：2 等价 + 3 缺口） |
| 破验（补判据**后**） | ✅ **18/20 咬住**，真缺口 0、可证等价 2 |
| `budget-routes`（既有强判据） | ✅ **23/23** |
| `run-budget-routes`（本片补的 8 例） | ✅ **8/8** |
| 全量回归 | ✅ **63 套件 / 1085 例 / 1085 pass / 0 fail**（+1 套件、+8 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 115 / sources 47 / 族 29） |

---

## 7. 本片**没有**做

- ★★★ 三个工具（`wire-family` / `check-region-lines` / `pair-routes`）的修法**只落在助手区**
  （`.worktrees/_prt-handoff/`，**不进仓库**）—— 与其余助手工具同命。
  **不修它们，下一簇（同样要 `paths`）会再撞一次同样的墙。**
- ★★ 切片 29 的 `scope` 归一缺陷、切片 28 的定形信封、切片 24 的 `CONTEXT_PLAN_ERRORS` 键名、
  切片 26 的模型配置警告、`limit=2.7` 那一个形状三处 —— 都**没修**（待业主裁决）。
- ★ 切片 30 量出来的**生成器不可复现**（19/28）**没有修**；`model-profiles` 的生成期失败**没查下去**。
- 剩下的 12 个簇**未动**；`/api/events` 仍未搬（需要增量写回 `live.bump`）。
- 域逻辑仍在原处（`budgetLedger` / `budgetPriceTables` / `BUDGET_ERRORS` 都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；切片 1～5 丢失的注释仍未补。

---

## 8. 复现命令

```powershell
node .worktrees/_prt-handoff/shape-probe.mjs /api/runtime          # ⇒ 16 个接缝，搬不动
node .worktrees/_prt-handoff/cluster-probe.mjs                     # ⇒ 本簇 6 条 / L5591-L5703
node .worktrees/_prt-handoff/probe31-run-budget.mjs                # ⇒ M12/M19/M20 都真可观测
node .worktrees/_prt-handoff/gen-family.mjs run-budget             # ⇒ D 段通过（6 条填满、无接缝）
node .worktrees/_prt-handoff/wire-family.mjs run-budget /api/runtime/run-budget createRunBudgetRoutes
node .worktrees/_prt-handoff/register-family.mjs run-budget 430d3dc /api/runtime/run-budget team-hub/routes/run-budget.mjs createRunBudgetRoutes
node .worktrees/_prt-handoff/register-baseline.mjs run-budget team-hub/routes/run-budget.mjs run-budget createRunBudgetRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/budget-routes.test.mjs team-hub/run-budget-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice31.mjs
```
