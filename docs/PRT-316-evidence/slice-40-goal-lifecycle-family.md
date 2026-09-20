<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 40：第三十八族 = 目标的发布与生命周期（3 条）

> 这一片是**判据最薄的一片**：破验无我方判据时 **1/14 咬住、真缺口 13**。
> 而这 3 条里的 2 条，`survey` 之前报的是「强判据 0 套 / 请求点 0」。

## 1. 本族长什么样

「目标的发布与生命周期：发布（含阶段任务链）/ 读取目标上下文 / 暂停·恢复·取消」——
3 条，**全部 `exact`**：

| 方法 | 路径 | 行 |
|---|---|---|
| POST | `/api/goal` | L5767 |
| POST | `/api/goal/context` | L5781 |
| POST | `/api/goal/status` | L5787 |

## 2. ★★★ 先数间隔（切片 39 的教训，本片照做）

`/api/goal` 共 **4** 条，间隔读数是：

```
L5311  POST /api/goal/slices     上邻 22 行前（POST /api/test-report）   ← **孤一条，在 400+ 行之外**
L5767  POST /api/goal            上邻 48 行前（POST /api/pipeline）
L5781  POST /api/goal/context    上邻  6 行前（POST /api/goal）
L5787  POST /api/goal/status     上邻  6 行前（POST /api/goal/context）
```

⇒ 后 3 条**是连续的**（L5767–L5791，区间内零外来路由），上界正是**切片 39 刚留下的接缝**，
下界是 `POST /api/agents`。`goal/slices` **留给后面的片**。

★ 与切片 39 的区别：那一片是「**没有**连续区间可用、只能取 3/5」，
这一片是「连续区间**正好**是 3 条、第 4 条孤在别处」——**同一个前缀，两种碎法**。

★ 工具的**前缀兄弟检测**第二次生效，自己印出 `POST /api/goal/slices`，
接缝随之变成「⚠️ **前缀下还有不属于本族的**（别顺手搬走）：POST /api/goal/slices」。

## 3. ★★★ 生成器**连着第四片**拦住我，而且这次**两个方向都拦**

第一道（漏名字）：

```
✖ 有未登记的名字：publishGoalRecord ← /api/goal
                  setGoalContext   ← /api/goal/context
                  setGoalState     ← /api/goal/status
```

切片 37 漏 `recordRunEventsBestEffort`、38 漏 `requireString`、39 漏 10 个（含 4 个 node 内建）、
本片漏 3 个。**四次都是同一件事**：*"我在路由体里读到的名字" ≠ "路由体实际用到的名字"*。
本片漏的这三个长得像"域层自带的动作"，我读的时候没把它们当成**依赖**。

第二道（多写了）：

```
✖ 这些注入项在函数体里没被用到（配置过期？）：handleRun, getTask, db, now, audit
```

★ 我凭印象写上的 5 个**一个都没用到** —— 本族只有 `handleWrite` 一条写面入口，
域动作全在三个域函数**里面**，路由体自己并不碰 `db`/`now`。

> 一个「这些名字到处都是，当然要注入」的印象，
> 与一个「它们全都躲在被调用的域函数里、路由体一个字都没提」的事实，
> 在第二道判据开口之前是同一个东西。

★★ **两道判据合起来才是有用的**：只查"漏"会把配置写成越来越肥的清单，
只查"多"会把必需的删掉。**一个只往一个方向看的判据，两边都会失守。**

## 4. ★★★ 这一族 3 条里有 2 条**从来没被任何判据碰过**

`survey` 的原始读数：

```
/api/goal          ⇒ 强判据 3 套，请求点合计 11
/api/goal/context  ⇒ 强判据 0 套，请求点合计 0      ★★★
/api/goal/status   ⇒ 强判据 0 套，请求点合计 0      ★★★
```

全仓库搜过：

- `goal/context` —— **连一个调用方都没有**（只有文档、模块自身、`server.mjs` 的定义与注释）。
- `goal/status` —— 只在 `scratch/verify-cancel-strand.mjs` 与 `scripts/prt/gf001-run.mjs` 里被调过，
  而那两处**不在回归选择器里**（选择器只扫 `team-hub/*.test.mjs` 且要含 `server.mjs`）。

> 一个「这一族有 3 套判据」的印象，
> 与一个「3 条里有 2 条从来没被任何判据碰过，其中一条连调用方都没有」的事实，
> 在我**逐条**去问请求点之前是同一个东西。

★★ 旁证：`scrum/incidents.md:55` 记着一次真实事故 ——
*「初版错误提示写「用 `/api/goal/status` 恢复为 active」，**实测发现 done 是终态、不可恢复**」*。
**一条出过事故的路由，事后仍然没有判据。**

## 5. ★★★ 破验：1/14 咬住，真缺口 13

| # | 变异 | 无我方判据 |
|---|---|---|
| M1 | ★★★ `/api/goal` 路径 | ✔ 咬住（**唯一**一条） |
| M2 | ★★★ `goal/context` 路径 | ✖ 真缺口 |
| M3 | ★★★ `goal/status` 路径 | ✖ 真缺口 |
| M4 | ★★★ `mode` 映射反了 | ✖ 真缺口 |
| M5 | ★★★ 丢掉 `docSync` 的第二个来源 `feature` | ✖ 真缺口 |
| M6 | ★★★ 丢掉**作用域回落** | ✖ 真缺口 |
| M7 | ★★★ `forceGeneral` 不再严格 `=== true` | ✖ 真缺口 |
| M8 | ★★★ `context` 的参数**搬串**（text 换位） | ✖ 真缺口 |
| M9 | ★★★ `status` 传成 `id` | ✖ 真缺口 |
| M10 | ★★★ 不检查 `objective` 必填 | ✖ 真缺口 |
| M11 | ★★★ dispatch 不看方法 | ✖ 真缺口 |
| M12 | ★★★ dispatch 认领了却回 false | ✖ 真缺口 |
| M13 | ★★★ `exact` 退化成 `startsWith` | ✖ 真缺口 |
| M14 | ★★ 缺注入不再 fail closed | ✖ 真缺口 |

**M2/M3 值得单独看**：把一条路由的 `path` 改成一个**不存在的路径**，
**没有任何既有的判据变红** —— 也就是说这两条路由的"存在"本身都没人确认过。

补判据后 **14/14 咬住，真缺口 0，可证等价 0**。新增 `team-hub/goal-lifecycle-routes.test.mjs`，**17 例**。

## 6. ★★★ 本片判据的重点：**注入点上的参数搬运契约**

这三条路由本身几乎只是**胶水** —— 真正的活儿全在 `publishGoalRecord` /
`setGoalContext` / `setGoalState` 三个**被注入**的域函数里。
所以判据用 `spy` 钉住"递进去的到底是什么"：

| 契约 | 实际规则 |
|---|---|
| 作用域回落 | `body.scope` 是非空字符串 ⇒ 用 `body.scope.trim()`；否则用 `handleWrite` 递进来的 `scope`（非字符串、纯空白都算没给） |
| `mode` | 路由把**请求的** mode 原样递进去（`body.mode === 'slice' ? 'slice' : 'chain'`） |
| `docSync` | **两个来源**：`body.docSync === true` **或** `body.feature === true`；严格 `=== true`，`1`/`'true'` 都不算 |
| `forceGeneral` | 严格 `=== true` —— 它是绕过"仅将军"的那把钥匙，`1`/`'true'` **不算** |
| 参数顺序 | `setGoalContext(id, text, by, forceGeneral)` / `setGoalState(id, status, by, forceGeneral)`；`text` 与 `status` 各在自己的第 2 位 |

★ M8/M9 就是把这两条的参数**换位**的变异 —— 之前全都没人看。

## 7. ★★★ `mode: slice` 会**静默回落**成 `chain`

我第一版判据写的是「给了 `mode: 'slice'` 就该得到 `slice`」——**当场红了**。
去读域层，`server.mjs` L2124 写着：

```js
const chain = createGoalChain(goalId, targetScope, objective.trim(), rawMode)
// 记录实际生效的模式（slice 缺岗会回退 chain）
if (chain.mode !== rawMode) {
  db.prepare('UPDATE goal SET mode=?, updatedAt=? WHERE id=?').run(chain.mode, now(), goalId)
}
```

★ 所以回复里的 `mode` 是**实际生效**的那个，不是**请求**的那个：
一个空空间没有人手 ⇒ `slice` 建不出阶段链 ⇒ 回落 `chain`，**并把记录也改成 chain**。

> 一个「给了 `mode: slice` 就得到 slice」的印象，
> 与一个「它按**编队能不能站满**决定实际模式、还可能回头改记录」的事实，
> 在我读到那行注释之前是同一个东西。

★ 改判据时把两件事**分开**钉：**回复里的 mode**（实际生效，空空间是 `chain`）
与 **spy 收到的 mode**（原样是 `slice`）—— "路由搬对了"和"域层决定了什么"是两件事。

## 8. ★★★ 桩的错，**两个方向**都会犯

- **切片 39**：`handleWrite` 的桩**无条件调回调** —— 比真的**宽松**，
  于是"测出来的是桩的行为"。
- **切片 40（本片）**：`handleWrite` 的桩**没把回调包在 try/catch 里** —— 比真的**严**，
  于是 ⑥ 里用空 body 驱动 `/api/goal` 时，回调抛的「缺少参数 objective」**直接穿出 dispatch**，
  一条本该测"命中回 true"的判据变成了"路由会抛异常"。

> 一个「桩只要把回调调起来就行」的印象，
> 与一个「真 `handleWrite` 的两件事（查 `by`、**把回调包进 try/catch**）都要照抄」的事实，
> 是同一个东西 —— 而**两次**我都是被红判据推回去才发现的。

★ 另外两处小错：判据标题里写了单引号（`'slice'`）导致**语法错误**（两次，`node --check` 抓到）；
`gid` 取成 `body.goal.id` 而实际是 `body.task.goal.id`，于是所有"正常路径"都掉进了
「缺少参数 id」—— **先看后写**正是为了这个。

## 9. 实测读数（本片**不修**，只钉）

- 三条都先过 `handleWrite` 的操作者闸：空 body ⇒ 400「缺少操作者身份 by」（**`by` 排在最前**）
- `POST /api/goal`：缺/空白 `objective` ⇒ 400「缺少参数 objective」；
  正常 ⇒ **200** `{ok, task:{goal:{id:'G-…-1', status:'active', version:1, mode:'chain', docSync:false, context:'', contextVersion:0, …}}}`
- `POST /api/goal/context`：缺 `id` ⇒ 400「缺少参数 id」；空 `text` ⇒ 400「context 必须是非空字符串」；
  未知目标 ⇒ 400「未知目标 G-nope」；正常 ⇒ **`contextVersion` +1**
- `POST /api/goal/status`：缺 `status` ⇒ 400「status 必须是 active|paused|done|canceled」（**逐个列出合法取值**）；
  `paused` ⇒ 200、`version:2`；`active` ⇒ 200、`version:3`；非 general ⇒ 400「目标状态仅允许将军（by=general）变更」
- ★★ **`version` 与 `contextVersion` 都是自增的乐观锁** —— 判据钉住了

## 10. 规模

| 量 | 改前 | 改后 |
|---|---|---|
| `server.mjs` 行数 | 6154 | **6139**（−15） |
| `handle()` 路由条件 | 25 | **22** |
| `router.dispatch` 调用点 | 37 | **38** |
| 族模块 | 37 | **38** |

累计：**188 = 166 已搬 + 22 剩余**（88.3%）；`sources` 56。
被删区间 **25 行**（注释 7，路由 3）；**38 族全部零丢失**。

## 11. 判据

| 判据 | 结果 |
|---|---|
| 差集核验（对 `f6be274`） | ✔ 消失的**恰好**本族 3 条，新增 0 |
| ★★★ 第 4 条 `goal/slices` 仍在 | ✔ 逐条钉住 |
| ★★★ 上下界与外 3 条邻居 | ✔ 一条没动 |
| ★★★ 接缝不再印过度声明 | ✔ 且列出了同前缀的兄弟 |
| 逐字对拍（38 族） | ✔ 一条没丢、体逐行按位置相同、无副本、装配到位 |
| 区间行数 | ✔ 丢注释 0 / 丢代码 0 |
| 自由标识符 | ✔ 38 个模块，未绑定名字合计 **0** |
| 破验（无我方判据） | **1/14 咬住，真缺口 13** |
| 破验（含我方 17 例） | **14/14 咬住，真缺口 0** |
| 逐字节还原 | ✔ 与原始相同；还原后复绿 ✔ |
| 全量回归 | ✔ **72 套件 / 1232 例 / 1232 pass / 0 fail** |
| 基线 | ✔ `--check` 无漂移 |

## 12. 本片**没有**做

- `POST /api/goal/slices`（L5311）**仍在 `server.mjs` 里** —— 孤在 400+ 行之外，本片取不到。
- ★★★ `POST /api/goal/context` **一个调用方都没有** —— 本片只给它补了判据，
  **没有**去判断它该不该存在（那要问业主）。
- ★ `mode: slice` 回落 `chain` 是**设计**，本片只钉住，**没改**。
- 域逻辑全留在原处（三个域函数一字未动）。
- ★★ `scrum/incidents.md:55` 那次事故（`done` 是终态、不可恢复）本片**没去核**。
- ★★★ 四个工具的修法**仍只落在助手区**（**第十片**）；
  ★★★ 破验的 `TESTS` 清单仍是**手工维护**；★★★ **没有任何东西阻止"边测边动同一棵工作树"**；
  ★★★ 破验中途抛错会**静默截断**（切片 39 亲身踩过）。
- ★★★ **回归选择器只扫 `team-hub/`** 这一条本片给出了第二个反例：
  `goal/status` 的调用方在 `scratch/` 与 `scripts/` 里，**选择器永远看不见它们**。
- 接缝契约只给 8 族补过，其余 **30 族**的 `dispatch` 契约仍无判据。
- `group-remaining.mjs` 的「分段」算法**仍没修**。
- 切片 1~5 丢失的注释仍未补；`/api/events` 仍未搬；余下：`goal/slices`、`POST /api/spaces`、
  `POST /api/spaces/`、`/api/artifact` 2 条、单条 15 个。
