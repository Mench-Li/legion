<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 34：第三十二族 = 任务交接与运行时读数（11 条）—— **整个仓库里只有一个人在看 `claim`**

- **族**：`task-lifecycle`（`team-hub/routes/task-lifecycle.mjs`），**11 条 / 158 行**
  - runtime 只读 4 条：`/api/runtime/reconciliations` · `/api/runtime/next-post` · `/api/runtime/budget` · `/api/runtime/attempt`
  - 任务交接写面 6 条：`/api/claim` · `/api/transition` · `/api/advance` · `/api/reassign` · `/api/hold` · `/api/release-stale`
  - 队列读数 1 条：`/api/inbox`
- **参考提交**：搬走前 `54c254d`
- **规模**：区间 158 行（注释 27、路由 11）、**外来 0**、**分段 1**、**内缝 0**

---

## 1. ★★★ 这一族**没有共同前缀**，是「族 = 一个前缀」这个印象第一次真正碎掉的地方

前 31 族都能找到 `F.prefix`（哪怕只是「恰好能圈住」）。这一族横跨 **8 个命名空间**：

```
/api/runtime/{reconciliations,next-post,budget,attempt}
/api/{claim,transition,advance,reassign,hold,release-stale,inbox}
```

`/api/` 圈进来的东西比这 11 条多得多，`/api/runtime/` 只圈住 4 条。**没有中间那一层。**
于是 `F.paths`（一张 `(方法, 路径)` 表）从「有些族需要」变成「这一族只能这样」。

> *一个「族就是一个前缀」的印象，与一个「前缀只是**恰好**能圈住前 N 族」的事实，
> 在第三十二族面前是同一个东西。*

顺带一提，这一族的接缝注释是**空的** —— 一段 `router.dispatch` 缝正压在它头上，
于是生成器里「段首注释起点」与「路由起点」两个量**塌成同一行**，
它第一次印出 `⚠ 源头的段首注释为空（这一段本来就没有说明）`。

## 2. ★★★ survey 量出来的第一件事不是「判据够不够」，而是「**有没有人在看**」

| 路径 | 强判据 | 请求点 |
|---|---|---|
| `/api/claim` | **1 套** | **1** |
| `/api/transition` | 3 套 | 14 |
| `/api/runtime/attempt` | 3 套 | 12 |
| `/api/runtime/next-post` | 1 套 | 6 |
| `/api/runtime/reconciliations` | 1 套 | 3 |
| `/api/runtime/budget` | 1 套 | 2 |
| `/api/advance` | **0** | **0** |
| `/api/reassign` | **0** | **0** |
| `/api/hold` | **0** | **0** |
| `/api/release-stale` | **0** | **0** |
| `/api/inbox` | **0** | **0** |

`/api/claim` 是 **PRT-214 裁决围绕的那条**（`claim()` 现在要写 11 个键、权限档位已经搬到 worker 侧），
而整个仓库里碰过它的**只有一个请求点**，在 `team-hub/run-routes.test.mjs` 里。

`/api/hold` 是**将军逐任务拦截/放行**这条路 —— 它一个判据都没有。

> *一个「claim 是安全关键路径、所以肯定有人守着」的印象，
> 与一个「整套判据里只有**一个请求点**碰过它」的事实，
> 在我没有逐条去数「谁请求过它」的时候是同一个东西。*

## 3. ★★★ 破验：**45 条里只有 11 条会红，34 个真缺口**

```
切片 34 基线：✔ 套件全绿
11/45 咬住；真缺口 34 条；可证等价 0 条
```

没咬住的包括：`claim` 不验 `id`、`claim` 的 `soldier` 不回退到 `by`、`claim` 把 `round` 与 `requestId` 传反、
`transition` 不验 `to`、`transition` 不再收尾目标、`advance` 的路径改掉没人管、
`hold` 不再拦 `done/canceled`、`release-stale` 的默认 `olderThan` 从 60 改成 0、
`inbox` 不再要求 `role` 或 `soldier`、`dispatch` **不看方法**……

### 3.1 补上：`team-hub/task-lifecycle-routes.test.mjs`（30 例）

补完 **44/45 咬住，真缺口 0，可证等价 1**。11 条路由的分支、状态码、具名码、审计行、库行都钉住了。

### 3.2 一处**可证等价**，不是「懒得补」

`release-stale` 的 `ids` 去不去非字符串 —— **不可能**改变结果：

- 域层是 `Array.isArray(ids)` + `ids.includes(r.id)`，
- 而 `r.id` 是**字符串**，`includes` 用 SameValueZero 比较。

往数组里留几个非字符串，对「某个字符串在不在里面」这个问题**没有任何影响**。
八种输入形态（不给 / `undefined` / `[]` / `[{}]` / 单元素 / 混数字 / 非数组字符串 / 非数组数字）
在原版与变异体上**逐个一致**，故记 `≈` 而不是「缺口」。

## 4. ★★★ 本片最大的教训不是代码，是**我自己的量法**

45 条变异 × 8 套判据超过一次命令的 10 分钟上限，我把它**放进后台**跑；
然后**在同一个仓库里**继续量读数、跑回归、看模块。

而破验的工作方式正是：**逐条把那个文件改坏 → 跑判据 → 还原**。

于是我在那个窗口里量到：

```
═══ 9. /api/hold ═══
  已 done 的任务        ⇒ 200   ← 这是**变异体**的行为
```

我据此写下「done 的任务竟然还能被拦截」的结论，并把测试期望值改成 `200`。
**真值是 `400`。**

同一窗口里跑的 **32 族逐字对拍**、**全量回归 65 套件 / 1129 例**，也都是在
被测文件正处于某个变异体的状态下跑出来的 —— 它们**全绿**，什么也没说。

> *一个「后台任务不影响我这边」的印象，
> 与一个「它正在**改我马上要读的那个文件**」的事实，
> 在我没有先问一句「它到底动了什么」的时候是同一个东西。*

**好在索引里那份是对的**：我在启动破验**之前**已经 `git add` 过，
所以 `git checkout` 一次就回到正身。kill 之后残留的 `.pristine` 与工作区**内容不同**，
正是「它当时停在中间」的物证。

**工具没有这道闸。** 没有任何东西阻止「边测边动同一棵工作树」——
本片是我自己发现并中止的，这一条记在「没有做」里。

## 5. ★★ 补判据时又踩一次：**夹具自己把缺口盖住**

`ins()` 里我写的是 `o.scope ?? 'default'`。
于是「空 scope 回退到 default」那条判据的任务，**从来就不是空 scope**。

更隐蔽的是：**不配流水线时**，`readPipeline('default')` 与 `readPipeline(null)`
都是空 stages、都回同一个 `409 UNKNOWN_ROLE` —— **毫无区分度**。
只有先给 `default` 配出一条真的流水线，两种实现才会分岔（`200` vs `409`）。

改成 `o.scope === null ? null : ...` 之后，M39 立刻咬住。

> *一个「我量过了、没有区分度」的印象，
> 与一个「**夹具是空的**、所以什么都没量到」的事实，
> 在我没有去把那一行插进去的**值**念一遍的时候是同一个东西。*

## 6. 两处实测的**不对称**（本片**不修**，只钉读数）

1. `hold` 的判据是 `body.hold === true`（**恒等**）。
   字符串 `"true"` / `1` / `"yes"` 全部落到「放行」分支 ——
   若前端某处把表单值当字符串发过来，**「将军按下拦截」会真的把任务放行**。
2. `inbox` 的判据是 `soldier === undefined`，
   而 `?soldier=`（空串）**算「给了参数」**。

两处都写进了用例，作为**契约**钉住，而不是当成缺陷改掉。

## 7. ★ 生成期的两处防呆：`undefined` 能被写进**注释**，没有一道门禁看得见

这一族的段首注释为空 ⇒ 生成器拿到 `F.summary === undefined`，
把它**字面量**写进了模块头的第 3 行；装配工具又读回来，把 `// ── undefined ──` 写进了 `server.mjs`。

`node --check` 通过、逐字对拍通过、九道门禁**没有一道**看得见 —— 因为它**是注释**。

已修：生成器在 `summary` 缺失/为空时**直接失败**；装配工具加同样一道闸；
本族的 `summary` 手写补上。

> *一个「我把族号/切片号写进注释了、指针是全的」的印象，
> 与一个「那一行里最关键的那半句是 `undefined`」的事实，
> 在我没有**把生成出来的文件头打开看一眼**的时候是同一个东西。*

## 8. 规模

| 量 | 改前 | 改后 |
|---|---|---|
| `server.mjs` | 6787 | **6642**（−145；`+13/−158`；累计 vs 原始 9221 = **−2579**） |
| `handle()` 路由条件 | 59 | **48** |
| `router.dispatch` 调用点 | 31 | **32** |
| 族模块 | 31 | **32** |
| 已搬路由 | 129 | **140**（**74.5%**，140 / 188） |

**48 剩余 + 140 已搬 = 188** ✓

## 9. 判据

- 32 族逐字对拍：一条没丢、体逐行按位置相同、无副本、装配到位
- 被删区间 158 行：**丢注释 0 / 丢代码 0**
- 自由标识符常设判据：**32** 模块 / 未绑定 **0**
- 破验：补前 **11/45**（真缺口 34）→ 补后 **44/45**（真缺口 0、可证等价 1）；本片新补 **30/30**
- `orchestrator/worker/sources-loader`：**58/58**（★ 只按目录选套件的回归选择器**扫不到它**）
- 全量回归：**66 套件 / 1159 例 / 1159 pass / 0 fail**（+1 套件、+30 例）
- `baseline-snapshot.test.mjs`：`httpRoutes` 188、已搬 140、`sources` 50、族 32

## 10. 本片**没有**做

- ★★★ 四个工具的 `(方法, 路径)` 修法**仍只落在助手区**（**不进仓库**）—— 已是**第四片**
- ★★★ 破验的 `TESTS` 清单**仍是手工维护**的（本片改成 `--no-mine` 开关，但
  「漏加一套就静默测旧判据」这件事**没有被机制挡住**）
- ★★★ **没有任何东西阻止「边测边动同一棵工作树」** —— 见 §4
- ★★ 只给 `read-models` `skills-documents` 两族补了接缝契约，其余 **30 族**的 `dispatch` 契约仍无判据
- §6 的两处不对称、切片 33 的 `/api/scopes` 并集无序、切片 32 的文档删除审计不对称、
  切片 29 的 `scope` 归一、切片 28 的定形信封、切片 24 的 `CONTEXT_PLAN_ERRORS` 键名、
  切片 26 的模型配置警告、`limit=2.7` 那一个形状三处、切片 30 的生成器不可复现 —— 都**没修**
- 剩下的 **9 个簇**未动；`/api/events` 仍未搬（需要增量写回 `live.bump`）
- 域逻辑仍在原处、**只搬路由**；那把只按目录选套件的回归选择器**没有改**
- 切片 1~5 丢失的注释仍未补

## 11. 复现命令

```powershell
node .worktrees/_prt-handoff/verify34.mjs                 # 差集 / 残留 / 邻居 / 接缝
node .worktrees/_prt-handoff/pair-routes.mjs              # 32 族逐字对拍
node .worktrees/_prt-handoff/check-region-lines.mjs       # 区间丢行
node .worktrees/_prt-handoff/check-free-identifiers.mjs   # 32 模块 / 未绑定 0
node --test team-hub/task-lifecycle-routes.test.mjs       # 本片新补 30 例
node .worktrees/_prt-handoff/mutate-slice34.mjs --no-mine # 既有判据读数
node .worktrees/_prt-handoff/mutate-slice34.mjs           # 补后读数
```
