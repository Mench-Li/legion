<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 18：第十七族 = **价目表（price-tables，3 条）**

- 切片：18（新增 `team-hub/routes/price-tables.mjs`）
- ★ 本片**没搬**判据最强的候选 —— 被一条新判据拦下了；而本族的搬运又把搬运脚本的真 bug 逼了出来。

## 一、选族：先被新判据拦下一个"更好的"候选

订正后的选族器（判据强度 × 区间内聚）给出的第一名不是 `price-tables`，而是 **`/api/config`**
（1 条条件 / **37 个请求点**）。但为它做依赖调研时发现：它读宿主的 `deliveryBookkeepingFailures`，
而那是 `let deliveryBookkeepingFailures = 0`，并且在**三处**被 `+= 1`。

装配发生在**模块加载**时 —— 之后计数再涨，模块里那个值**永远停在 0**。

### ★★★ 第四类"四道判据全看不见"的错误

| 判据 | 为什么看不见 |
| --- | --- |
| `node --check` | 语法合法 |
| 逐字对拍 | 体**逐字相同**（本来就该相同） |
| 自由标识符判据（切片 17 新增） | 它**确实**被注入了 |
| 门禁 | 契约（路由表）没变 |

只有"涨过计数再读一次"的**行为**判据才看得见，而 `/api/config` 上恰好没有。

> 一个"这个依赖被注入了"的判据，与一个"注入之后它还跟着宿主变"的判据，
> 在这个依赖恰好从不被重新赋值的时候是同一个东西。

### 新增守卫（在生成器里，**响亮拒绝**）

`gen-family.mjs` 现在会拿 `INJECT` 里的每个名字去 `team-hub/server.mjs` 里找
`^\s*(let|var)\s+<名字>`；命中就抛错，除非该族显式声明 `mutable: true`。

**先自证**（`verify-mutable-guard.mjs`，**9/9**）：

| 用例 | 可变？ | 期望 | 结果 |
| --- | --- | --- | --- |
| `deliveryBookkeepingFailures` | 是 | 拒绝 | ✔ |
| `eventClients` / `db` / `PORT` / `budgetPriceTables` / `createPriceTable` / `BUDGET_ERRORS` / `tokenizerRegistryStatus` | 否 | 放行 | ✔ |
| 不存在的名字 | 否 | 不该被这条判据报 | ✔ |

佐证（机械读数）：宿主里 `let` 声明 = **true**，自增处 = **3**。
⇒ **`/api/config` 是"判据最强但不能搬"的族，先放着**；改选 `price-tables`（17 行 / 3 条 / 内聚）。

## 二、规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7432 | **7403**（−29） | 9221（累计 **−1818**） |
| `handle()` 路由条件（抽取器口径） | 106 | **103** | 191 |
| `router.dispatch` 调用点 | 16 | **17** | 0 |
| `routes/` 族模块 | 16 | **17** | 0 |
| 平台契约 `httpRoutes` | 188 | **188** | — |

**103 剩余 + 85 已搬 = 188** ✓ · 被删区间 **38 行**（注释 2、路由 3），**丢注释 0 / 丢代码 0**

机械核对：删除块里**恰好** 3 条方法条件行，全部是 `/api/price-tables`；
`/api/runtime/run-budget` 的 6 条路由（`observe` / `settle` / `resolve` / `run-budget` / 前缀 / `may-switch-model`）**逐一仍在**。

## 三、★★★ 本族把搬运脚本的真 bug 逼了出来：被夹在别人的区间里

`price-tables` 的 3 条条件**夹在** `/api/runtime/run-budget` 的**第 5 条与第 6 条之间**，
自己没有 `// ──` 分隔符。于是 `wire-family.mjs` 算出的区间是 **L5658-5806 / 149 行 / 8 条条件** ——
它把 run-budget 一起吞了。

守卫 `nCond !== expected` 当场报"边界抓错了"（**守卫是对的，区间是错的**），
且 `server.mjs` 未被写坏（仍是 7431 行、git 干净）——fail closed 生效。

**根因**：下边界早就会"先撞上别人的条件行就停"（L111-117），
但**上边界一直在无条件往上找最近的分隔符** —— 而那个分隔符是**别人的**。

> 一个"往上找到最近的分隔符就是本族的段首"的判据，
> 与一个"往上找到的那个分隔符可能属于**别人**"的事实，
> 在这一族恰好没有被夹进别人区间里的时候是同一个东西。

修法：给上边界加**同一条**规则（撞上别的族的条件行就停）。

### ★ 同一个便利写法抄了两份

`check-region-lines.mjs` 里有一份**同样**的算法，它开头还写着"刻意各写一份：两边不一致时要响"。
修完 `wire-family` 再跑它，它报 `price-tables 区间 149 行 丢注释 11 / 丢代码 53` ——
**两边一起错了**，所以"互为判据"从来没成立过：那不是两条独立判据，是同一段代码的两个副本。

> 一个"两边独立实现所以能互相校验"的判据，与一个"同一段便利代码抄了两份"的事实，
> 在这段代码从一开始就没被独立推导过的时候是同一个东西。

修完两边之后：`price-tables 区间 38 行（注释 2、路由 3）丢 0/0`，
且**前 16 族的读数一字未变**（全部 0/0）⇒ 修法是向后兼容的。

## 四、★ 一次"名字差一个字母"

把 `price-tables` 的依赖登记进对拍脚本时，我从上一族（`config-bundle`）的条目里**抄**了一份，
抄成了 `BUNDLE_ERRORS` —— 而本族要的是 **`BUDGET_ERRORS`**（开预算），
两个常量只差一个字母、都存在。

工厂自身的装配守卫当场抛 `缺注入项：BUDGET_ERRORS`（**fail closed，正是它该做的**）。

> 一个"这一族也要那个 ERRORS 常量"的推断，与一个"两族的 ERRORS 常量名字差一个字母"的事实，
> 在我不逐字核对名字的时候是同一个东西。

## 五、破验：20 处，两轮 11/20 → **19/20**（真缺口 0）

逐字节还原 ✔、还原后复绿 ✔。一轮那 7 条"没咬住"里，**1 条刀不快、1 条可证等价、5 条真缺口**。

### ★★ 刀不快：砍在"结果已经写出去之后"

第一版 M18 是"把 `dispatch` 的 `return true` 改成 `return false`"。它**没被咬住** ——
因为那句 `return` 在 `await r.run(...)` **之后**，响应早写完了。

> 一把砍在"结果已经被写出去之后"的刀，与一把没砍的刀，
> 在被砍的那个表达式的值不影响任何可观测输出的时候是同一把。

已换成"在 `run` **之前**就认领"（三条路由真的失效）⇒ 咬住。

### ★★ 可证等价：砍在恒等号上

M5（回执 `version` 用 `body.version` 而非 `saved.version`）—— 本套件第一条用例就钉住
"同版本再发布是 409" ⇒ 版本是**按请求给的**存进去的，两个表达式**恒等**。归类为可证等价，不改产品。

### ★★★ 只在"没人测过的那条路径"上可观测

第二轮新加的 M20（前缀路由的 `path` 去掉尾斜杠）我一度判它"不该被咬住"，
理由是"精确路由在前、切前缀用的是字面量" —— 那个理由对**已测过的**路径都成立。

但 `/api/price-tablesX` 能分清：带尾斜杠 ⇒ 不匹配 ⇒ **404**；去掉 ⇒ 被认领 ⇒ 空版本号 ⇒ **400**。

> 一个"这个改动不可观测"的判断，与一个"这个改动只在没人测过的那条路径上可观测"的事实，
> 在我只跑了已有用例的时候是同一个东西。

⇒ 补第 ⑫ 条判据钉住"前缀必须真的以 `/` 结尾"。

### 5 条真缺口 ⇒ 补 6 条契约用例

`POST` 不带 `models` 要落到**空表**（不是 `undefined`）；发布回执的 `models` 是**键名数组**；
列表回执带 `ok` 与 `serverTimeMs` 且真的列出已发布的表；按版本取的 `version`/`effectiveAtMs` 忠实；
按版本取的 `models` 是**规范化后的对象**（空表回 `{}`）。

★ 量出来的两件事改了草稿：**发布回执的 `models` 是键名数组**（`["cheap"]`），
而**按版本取的 `models` 是规范化对象**（补出 `perUnitIn`/`perUnitOut`/`hasPeak`…）——
两个端点对同一字段用两种形状。不量就会写错断言，然后去改产品。

## 六、判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 17 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 38 行（注释 2）丢 0 / 丢 0；**前 16 族读数未变** |
| 删除块只含本族条件 | ✅ 恰好 3 条，run-budget 6 条逐一仍在 |
| 无跨族遮蔽 | ✅ |
| **自由标识符常设判据** | ✅ 17 模块 / 未绑定 0（自证 6/6） |
| **可变绑定守卫** | ✅ 放行本族；自证 **9/9**；拦下 `/api/config` |
| 破验 | ✅ **19/20 咬住**，真缺口 0、可证等价 1 |
| `budget-routes` | ✅ **23/23**（17 → +6） |
| 全量回归 | ✅ **51 套件 / 907 例 / 907 pass / 0 fail**（+6 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25 |

## 七、本片**没有**做

- **`/api/config`（37 个请求点，判据最强）没有搬** —— 它读宿主的 `let`，
  按值注入会永久陈旧。要搬它得先决定对策（注入取值函数、由宿主在请求时读），
  而那会**改写体**、与"零注入改写"冲突，属**单独裁决**的事。
- `model-bindings` 仍**夹着** `/api/model-migration`（2 条），要搬得先决定两者是否拆开。
- 域逻辑（`createPriceTable` / `budgetPriceTables` / `BUDGET_ERRORS`）仍在原处，**只搬路由**。
- `check-free-identifiers.mjs` / `append-block.mjs` / `mutate-lib.mjs` / `check-region-lines.mjs`
  等仍住在 `.worktrees/_prt-handoff/`（助手区，**不进仓库**）；做成仓内常设闸门是**独立的一件事**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **103** 条条件仍在 `handle()`。

## 八、复现命令

```powershell
node .worktrees/_prt-handoff/rank2.mjs                                        # 判据 × 内聚 选族
node .worktrees/_prt-handoff/probe-cohesion.mjs /api/price-tables             # 看夹入/分隔符/顶层声明
node .worktrees/_prt-handoff/verify-mutable-guard.mjs                         # ★ 可变绑定守卫自证
node .worktrees/_prt-handoff/gen-family.mjs price-tables
node .worktrees/_prt-handoff/wire-family.mjs price-tables /api/price-tables createPriceTablesRoutes
node .worktrees/_prt-handoff/check-region-lines.mjs                           # ★ 与 wire-family 同一条边界规则
node .worktrees/_prt-handoff/probe-slice18-gaps.mjs
node .worktrees/_prt-handoff/append-block.mjs team-hub/budget-routes.test.mjs .worktrees/_prt-handoff/slice18-contract-block.txt
node .worktrees/_prt-handoff/mutate-slice18.mjs
```
