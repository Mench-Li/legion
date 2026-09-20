<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 37：第三十五族 = 运行面（9 条）

> 这一族是**第一次不得不把 `/api/runtime` 劈开**：这个前缀在源文件里是**两段**，
> 中间还夹着一条别人的路由。而它开工时，**生成器当场拒了我猜出来的依赖清单**。

## 1. 本族长什么样

「运行面（PRT-302/303/313）：带权威时间与 leaseEpoch 的领取/续租/提交/放弃」——
9 条，**全部 `exact`**：

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/api/runtime/claim` | L5303 |
| POST | `/api/runtime/heartbeat` | L5312 |
| POST | `/api/runtime/transition` | L5322 |
| POST | `/api/runtime/release` | L5359 |
| POST | `/api/runtime/recover` | L5368 |
| GET | `/api/runtime/status` | L5390 |
| POST | `/api/runtime/fail` | L5395 |
| GET | `/api/runtime/held` | L5436 |
| POST | `/api/runtime/resolve` | L5448 |

段首那段说明写的是它与**上面那些看板写操作**的区别：

> 看板操作的主体是人（成员 `by`），运行操作的主体是 worker。
> 两者的失败语义不同——看板冲突要提示用户重试，
> 运行面的 epoch 冲突要求 worker **停手**，因此不能共用一条路径。

## 2. ★★★ 为什么这一族**不能**用前缀取

`/api/runtime` 这个前缀在源文件里**横跨两段**，而且中间夹着一条**别人的**路由：

```
L5303–L5464   本段 9 条（本片搬走的那段）
L5465–L5467   接缝：context-snapshots（已提取）
L5468–L5548   ⋯ 中间有 GET /api/team-plan + 十几族接缝 ⋯
L5549–L5552   接缝：run-budget / price-tables（已提取）
L5553–L5692   第二段 7 条（validate / validations / handoff / handoffs / run-results / run-events / run-budget/may-switch-model）
```

★ `group-remaining` 早就把这一族报成「**外来 1，分段 2**」—— 那个"外来 1"就是夹在中间的
`GET /api/team-plan`。**用前缀取会一次捞到 16 条、跨过 3 个接缝和一条别人的路由。**

所以本片用**显式路径表**（`F.paths`）取第一段，并把第二段那 7 条**逐条列成判据**：

> 一个「前缀是 `/api/runtime` 的都属于这一族」的印象，
> 与一个「同一个前缀下住着**两段**、中间还塞着一条别人的路由」的事实，
> 在我没有把那个前缀下**每一条**都列出来看一遍之前是同一个东西。

## 3. ★★★ 生成器**当场拒了我猜的依赖清单**

我按路由体读了一遍，列了 5 个依赖（`handleRun` / `runStore` / `requireString` / `getTask` / `settleGoalsOfScope`）。
生成器 fail closed：

```
✖ 有未登记的名字（要么加进 deps，要么它是本体内局部绑定）：
    recordRunEventsBestEffort  ← /api/runtime/transition, /api/runtime/fail
```

它是对的：`transition` 与 `fail` 各有一行
`const evOutcome = recordRunEventsBestEffort({...})`，而这个辅助函数在 `server.mjs`
里是一份**留在原处的函数声明**（L4583）。

> 一个「我照着路由体读了一遍、依赖都列全了」的印象，
> 与一个「有两行调用了一个我没注意到的辅助函数」的事实，
> 在生成器**替我把每个名字都点一遍**之前是同一个东西。

★ 这是这道判据**第二次**实打实地拦住我（切片 18 起它一直在跑），而且这次拦的是**人读**的疏漏，
不是工具的缺陷 —— 两者都值得记。

## 4. ★★ 一段**我自己的**数错：6 POST / 3 GET

接线后核验里我写了 `POST 应为 6 条 / GET 应为 3 条`，核验当场红了。实际是 **7 POST + 2 GET** ——
只读的只有 `status` 与 `held` 两条。

> 一个「有 3 条只读的」的印象，与一个「只读的其实只有 2 条」的事实，
> 在我没有把 9 条**逐条列出来数一遍**之前是同一个东西。

★ 顺带一条**实测的顺序事实**：`transition` 指向不存在的尝试时回
**404 `ATTEMPT_NOT_FOUND`** —— 也就是说 `to` 的必填校验**在尝试查找之后**。
"尝试不存在"优先于"参数不全"报出来。已写进判据。

## 5. ★★★ M15 的根因：这一族有 74 个请求点，却**没有一条 run 走到过 `Completed`**

survey：这 9 条路径**全都有判据**，请求点合计 **74**（7 套套件）。破验无我方判据时 **17/23，真缺口 6**：

```
✖ M11 ★★★ resolve 的 `decision` 传个非法值
✖ M15 ★★★ transition / fail 之后**不结算目标**
✖ M21 ★★★ dispatch 不看方法
✖ M22 ★★★ dispatch 认领了却回 false
✖ M23 ★★★ `exact` 退化成 `startsWith`
✖ M24 ★★  缺注入不再 fail closed
```

★★★ 其中 **M15 的根因**是探针量出来的：从 `Running` 再往前走要 `contextSnapshot` **证据** ——

```
BuildingContext → Running   ⇒ 409 EVIDENCE_MISSING
「迁移 BuildingContext → Running 声明要先落库的证据不存在：contextSnapshot。
  这不是"数据还没写好"的时序问题，而是"这一步的结论没有依据"——
  例如一条没有验收记录的尝试进入 Completed，等于把"没人验收过"写成"已验收"」
```

而 `Validating` 前面也走不通（`BuildingContext → Validating` 不是合法迁移）。
**要把一条 run 走到底，得先把上下文冻结起来**；既有的 74 个请求点**没有一条走到底**。

于是 `transition` / `fail` 里那句

```js
try { settleGoalsOfScope(getTask(r.attempt.taskId).scope) } catch { /* 任务不存在时不结算 */ }
```

**整句删掉，74 个请求点一个都不会红**。而它的后果是实打实的：
目标只在**所有任务都 done** 时才结算 ⇒ 少了这一句，目标会**永远停在 `active`**。

> 一个「这一族有 74 个请求点守着」的印象，
> 与一个「它从没把一条 run 走到过 `Completed`」的事实，
> 在我没有去看那 74 个请求点**走到哪一步**的时候是同一个东西。

★ 修法：**用注入 spy 直接把这条契约钉住**，不必真的走到 `Completed` ——
断言成功迁移时 `settleGoalsOfScope` 被以**该尝试所属任务的作用域**调用一次。
这是这一族**第一条不看返回值、只看副作用**的判据。

★★ M11 同理：`resolve` 的 `decision` 非法值，**域层**（`run-store.mjs` 的 `BAD_DECISION`）会拒，
但**没有一条用例送过非法值**。补上之后，"缺参（`MISSING_PARAM`）"与"值非法（`BAD_DECISION`）"
这两个**不同的事实**就分开了 —— 后者被前者顶掉的话，调用方会以为是自己拼错了词。

补判据后 **23/23 咬住，真缺口 0，可证等价 0**。新增 `team-hub/runtime-lease-routes.test.mjs`，**11 例**。

## 6. ★★ 几处实测的读数（本片**不修**，只钉）

- `POST /api/runtime/claim` ⇒ 200 `{ok, claimed:{attemptId, taskId, scope, attemptNo, leaseEpoch, leaseExpiresAtMs, state:'Leased', serverTimeMs, ...}}`
- `GET /api/runtime/status` ⇒ 200 `{ok:true, byState:{…13 项…}}` —— **`ok` 少了，读到的统计与一次失败答复长得一样**
- `GET /api/runtime/held` ⇒ 200 `{ok, serverTimeMs, total, actionable, items:[], ignoredClientFields:[]}`
- `resolve` 缺 `decision` ⇒ 400 `MISSING_PARAM`「缺少参数 decision」；
  `decision` 非法 ⇒ 400 `BAD_DECISION`「未知的处置决定「nope」。可选：external-effect-happened / external-effect-absent / dead-letter / cancel」
- `recover` 的 `from` 缺 / 空 / 非数组 ⇒ 400 `EXTERNAL_EFFECT_UNKNOWN`
  「这一条不能猜：判成「可重试」会在已发生外部副作用时重复执行，判成「未知」会让本可自动恢复的任务挂起」
- `transition` 未知尝试 ⇒ **404 `ATTEMPT_NOT_FOUND`**（`to` 的必填校验在尝试查找**之后**）
- 13 项 `byState` **一项不少**（少一项 = 那一类尝试在统计里静默消失）

## 7. 规模

| 量 | 改前 | 改后 |
|---|---|---|
| `server.mjs` 行数 | 6574 | **6418**（−156） |
| `handle()` 路由条件 | 43 | **34** |
| `router.dispatch` 调用点 | 34 | **35** |
| 族模块 | 34 | **35** |

累计：**188 = 152 已搬 + 34 剩余**（80.9%）；`sources` 53。

被删区间 **166 行**（注释 49，路由 9），`check-region-lines` 报 **丢注释 0 / 丢代码 0**；
**35 族全部零丢失**。

## 8. 判据

| 判据 | 结果 |
|---|---|
| 差集核验（对 `9953da5`） | ✔ 消失的**恰好**本族 9 条，新增 0 |
| **同前缀第二段 7 条** | ✔ 一条没动（逐条断言） |
| 夹在两段中间的 `GET /api/team-plan` | ✔ 还在 |
| 逐字对拍（35 族） | ✔ 一条没丢、体逐行按位置相同、无副本、装配到位 |
| 区间行数 | ✔ 丢注释 0 / 丢代码 0 |
| 自由标识符 | ✔ 35 个模块，未绑定名字合计 **0** |
| 破验（无我方判据） | 17/23 咬住，真缺口 6 |
| 破验（含我方 11 例） | **23/23 咬住，真缺口 0** |
| 逐字节还原 | ✔ 与原始相同；还原后复绿 ✔ |
| 全量回归 | ✔ **69 套件 / 1194 例 / 1194 pass / 0 fail** |
| 基线 | ✔ `--check` 无漂移 |

## 9. 本片**没有**做

- `/api/runtime` **第二段 7 条**（`validate` / `validations` / `handoff` / `handoffs` /
  `run-results` / `run-events` / `run-budget/may-switch-model`）留给**切片 38** ——
  本片已为它们写了**反向判据**（本族一条都不许吃掉）。
- **域逻辑全留在原处**（`run-store.mjs` 一字未动；`recordRunEventsBestEffort` 与
  `settleGoalsOfScope` 的声明仍在 `server.mjs`）—— 本片**只搬路由**。
- ★ M15 的判据用的是**注入 spy**（钉住"路由调了它、且用的是哪个作用域"），
  **不是**端到端地走到 `Completed` 看目标真的翻成 `done` ——
  后者要驱动上下文冻结，是**另一件事**（记在这里，不假装做了）。
- `group-remaining.mjs` 的「分段」算法**仍没修**（它报的"分段 2"这次是**对的**，
  但它报「分段 1」那次是错的 —— 见切片 36 证据 §9）。
- 四个工具的修法**仍只落在助手区**（**第七片**）。
