<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 38：第三十六族 = 机器验收与交接（6 条）

> 这一片的**区间上界不是接缝，而是一条"故意留着"的路由**。
> 我先把那条路由误读成一个没人看着的漏网缺陷，**读记录之后发现完全相反** ——
> 而顺着那次误读，才挖出工具里一处**真的**过度声明。

## 1. 本族长什么样

「机器验收与交接（PRT-307）：验收一条 / 列验收 / 交接一条 / 列交接 + 运行产物读取」——
6 条，**全部 `exact`**：

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/api/runtime/validate` | L5420 |
| GET | `/api/runtime/validations` | L5446 |
| POST | `/api/runtime/handoff` | L5455 |
| GET | `/api/runtime/handoffs` | L5480 |
| GET | `/api/runtime/run-results` | L5489 |
| GET | `/api/runtime/run-events` | L5503 |

## 2. ★★★ 本片的新形状：上界落在一条**决定不搬**的路由身上

到切片 37 为止，每一族的区间上界都是**接缝**（或前一段已被搬走的空地）。
本族不是 —— 它上面紧挨着的是：

```js
L5397  if (req.method === 'POST' && path === '/api/runtime/run-budget/may-switch-model') {  ← 活的，而且**决定不搬**
```

## 3. ★★★ 我先把这条路由误读成缺陷，而记录里**明文警告过**

我看到 `may-switch-model` 用的是 `budgetLedger` / `budgetPriceTables` / `BUDGET_ERRORS` ——
**与 run-budget 族同一套域对象** —— 于是断定：

> ❌ 这是前缀被切碎留下的**漏网路由**，命名空间住在了两个地方，而**没有任何判据看着它**。

**读完记录之后发现完全相反**，而且有**两处**都写着：

- `run-budget` 的生成器条目：*"本族是**第一个用 `paths` 而不是 `prefix` 取族的**……
  为什么不能用前缀：`/api/runtime/run-budget/may-switch-model` 落在**本区间之外**"*
- `server.mjs` 里 run-budget 的接缝注释（L5392）：
  *"**同名前缀**的 `POST /api/runtime/run-budget/may-switch-model` **不属本族**、
  仍留在下面，**别顺手搬走**。"*

★★ 而这句话**恰恰是写给本族这一片的**：本族与它同前缀、同属 `/api/runtime` 那一段、
区间上界就落在它身上。

> 一个「一个用着同一套域对象、却留在原地的路由」的印象，
> 与一个「它被**明文点名排除**、而且那句话就是写给未来的我看的」的事实，
> 在我读那条接缝注释**之前**是同一个东西。

★ 所以本片**没有**去动它，并且把「不许搬走」写成了**第一条判据**（§6）。

## 4. ★★★ 但顺着那次误读，挖出工具里一处**真的**过度声明

接线跑完之后，工具印出来的接缝注释是：

```
    // 本族这 6 条已全部搬进模块，`server.mjs` 里不再有它们。
    // 归属 /api/runtime 的那 6 条都在这里了。        ← ★★★ 这句是**假的**
```

**假在哪**：`/api/runtime` 这个前缀下**还有一条**（`may-switch-model`）住在 `server.mjs` 里。
那句话读起来像"这个前缀已经清空了"。

### 根因：查的关系不是要说的那个关系

`wire-family.mjs` 里**本来就有**一道检查，叫 `samePathOthers`：

```js
if (k !== null && !modKeys.includes(k) && famPaths.has(k.split(' ')[1])) samePathOthers.push(k)
```

它查的是「**同一个路径**、另一个方法」。查到了就印一句正经的警告，
**查不到**就退回到 §上面那句兜底文案。

★ 而 `may-switch-model` 与 `runtime-verification` 的关系是
「**同一个前缀**、另一条路径、另一个方法」—— **不是**它查的那一种。
于是它一声不响地退回到兜底文案，而那句文案**在"前缀没被清空"的时候是错的**。

> 一个「同一个路径、另一个方法」的关系，
> 与一个「同一个前缀、另一条路径」的关系，
> 在那一族恰好**独占**自己的前缀时是同一个东西。

★★ 这类"查的关系不是要说的那个关系"在本项目里是**第三次**了（切片 33 是
`startsWith('/api/task')` 吞掉 `/api/task-feedback`；切片 35/36 是"前缀圈不住"）。

### 修法

给 `wire-family` 加**前缀兄弟**扫描：拿本族每条路由的命名空间前缀（段数 < 4 时**不退化**
成 `/api`，否则整个 API 都算"同前缀"），扫一遍替换后的文本，
把仍留在 `server.mjs` 里、同前缀的**别的**路由列出来，**顶掉**那句兜底文案。

实测（重跑同一片）：

```
★★ 同前缀的兄弟仍在 server.mjs：POST /api/runtime/run-budget/may-switch-model
```

生成的接缝变成：

```
    // ⚠️ **前缀下还有不属于本族的**（别顺手搬走）：POST /api/runtime/run-budget/may-switch-model
```

★ 自带修完这条，**下一片就不会"顺手搬走"它了** —— 这正是 run-budget 那句警告想要的效果。

## 5. ★★★ 生成器**连着第二片**拦住我

我按路由体数依赖，报了 4 个，生成器 fail closed：

```
✖ 有未登记的名字：requireString  ← /api/runtime/validate, /api/runtime/handoff
```

> 切片 37 漏的是 `recordRunEventsBestEffort`，本片漏的是 `requireString` —— **连着两片**。

★ 两片都在同一件事上出错：**"我在路由体里读到的名字" ≠ "路由体实际用到的名字"**。
这道判据是唯一能看见它的东西。

## 6. 判据前后

survey：6 条路径**全有判据**，请求点合计 **40**（6 套套件）。
破验无我方判据时 **12/19，真缺口 7**：

```
✖ M8  ★★★ 两条写面都不结算目标
✖ M9  ★★★ handoff 不结算目标
✖ M15 ★★★ validate 不传 actor
✖ M16 ★★★ dispatch 不看方法
✖ M17 ★★★ dispatch 认领了却回 false
✖ M18 ★★★ `exact` 退化成 `startsWith`
✖ M19 ★★  缺注入不再 fail closed
```

★★ 与切片 37 的缺口**是同一批类别**（结算/接缝契约/fail closed）——
两族都是 `/api/runtime` 下的相邻两段，**判据的盲区也跟着相邻**。

> 一个「这个前缀下的两段都已经搬完了」的印象，
> 与一个「两段各自都有 7 条没人看的行，而且**是同一批**」的事实，
> 在我把两族的破验结果并排看之前是同一个东西。

补判据后 **19/19 咬住，真缺口 0，可证等价 0**。新增 `team-hub/runtime-verification-routes.test.mjs`，**11 例**。

★★ M18 在这一族特别值得判：本族的 6 条路径**互相是前缀**
（`/api/runtime/validate` 是 `/api/runtime/validations` 的前缀），
而更宽的是整个 `/api/runtime/run-` 家族 —— 退化成 `startsWith` 会横扫切片 37 那 9 条。

## 7. ★★ 几处实测读数（本片**不修**，只钉）

- 四条读面缺 `attemptId` ⇒ 400 `{ok:false, error:'缺少 attemptId', code:'MISSING_PARAM'}`
- ★★ **不存在的 attemptId ⇒ 200 带空数组**（不是 404）：
  `{ok:true, attemptId, validations:[] / handoffs:[] / runResults:[] / events:[], serverTimeMs}` ——
  "这条尝试没有任何记录"与"这条尝试不存在"在这里是**同一个答案**
- ★ `run-events` **两个分支**：`counts=1` ⇒ `{ok, attemptId, byType:{}, total:0, unknownTypeCount:0}`；
  否则 ⇒ `{ok, attemptId, events:[]}`。**`counts` 只认字符串 `'1'`**（`'0'`、`'true'` 都走默认分支）
- `validate` / `handoff` 缺 `attemptId`、缺 `actor` ⇒ 400 `MISSING_PARAM`，
  且错误里**明说是哪个参数**（`缺少参数 actor`）

## 8. 规模

| 量 | 改前 | 改后 |
|---|---|---|
| `server.mjs` 行数 | 6418 | **6311**（−107） |
| `handle()` 路由条件 | 34 | **28** |
| `router.dispatch` 调用点 | 35 | **36** |
| 族模块 | 35 | **36** |

累计：**188 = 160 已搬 + 28 剩余**（85.1%）；`sources` 54。

被删区间 **117 行**（注释 45，路由 6）；**36 族全部零丢失**。

## 9. 判据

| 判据 | 结果 |
|---|---|
| 差集核验（对 `2eb88ec`） | ✔ 消失的**恰好**本族 6 条，新增 0 |
| ★★★ `may-switch-model` 仍在 | ✔ 明文点名的排除，本片照办 |
| 切片 37 的 9 条不回来 | ✔ |
| `/api/runtime` 段在 `server.mjs` 里**只剩 1 条** | ✔ 逐条列出并断言 |
| 逐字对拍（36 族） | ✔ 一条没丢、体逐行按位置相同、无副本、装配到位 |
| 区间行数 | ✔ 丢注释 0 / 丢代码 0 |
| 自由标识符 | ✔ 36 个模块，未绑定名字合计 **0** |
| 破验（无我方判据） | 12/19 咬住，真缺口 7 |
| 破验（含我方 11 例） | **19/19 咬住，真缺口 0** |
| 逐字节还原 | ✔ 与原始相同；还原后复绿 ✔ |
| 全量回归 | ✔ **70 套件 / 1205 例 / 1205 pass / 0 fail** |
| 基线 | ✔ `--check` 无漂移 |

## 10. 本片**没有**做

- `POST /api/runtime/run-budget/may-switch-model` **仍住在 `server.mjs` 里** ——
  它是 run-budget 的账，本片**照那句警告没动它**。它还留在那儿这件事本身
  记在这里：`/api/runtime` 段**不是空的**。
- ★ 本片订正的是**本族自己的**接缝注释；**切片 37 那条接缝**也印着同一句过度声明
  （「归属 /api/runtime 的那 9 条都在这里了」，而当时前缀下还剩 7 条）——
  它在**已提交的区域**里，属于一次**纯注释**的另修，**本片不夹带**（记在这里）。
- 域逻辑全留在原处（`run-store.mjs` 一字未动）。
- M8/M9 用的是**注入 spy**（钉住"路由调了它、用的是哪个作用域"），
  不是端到端走到 `Completed` —— 与切片 37 同一条限制。
- `group-remaining.mjs` 的「分段」算法**仍没修**。
- 四个工具的修法**仍只落在助手区**（**第八片**）—— 虽然本片实打实改了其中一个。
