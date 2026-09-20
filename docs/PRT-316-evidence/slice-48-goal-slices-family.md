<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 · 切片 48：第四十六族 = 切片展开

> **一句话**：把 `POST /api/goal/slices` 搬进 `team-hub/routes/goal-slices.mjs`。
> 探针很小（9 行），但它量出两件东西：**域层两条 return 的形状不一样**，
> 以及**既有套件对这条路由是零覆盖**。

| 项 | 值 |
| --- | --- |
| 族号 / 切片号 | 第 46 族 / 切片 48 |
| 模块 | `team-hub/routes/goal-slices.mjs`（91 行） |
| 判据 | `team-hub/goal-slices-routes.test.mjs`（**15 例**） |
| 搬走的 1 条 | `POST /api/goal/slices`（`exact`） |
| 注入面 | 3 项（`json, handleWrite, expandGoalSlices`） |
| 规模 | `server.mjs` 5665 → **5665**（净 0）；路由条件 6 → **5**；`dispatch` 调用点 45 → **46**；族模块 45 → **46** |
| 被删区间 | **9 行**（注释 1，路由 1），丢注释 0 / 丢代码 0 |
| 破验 | 有我方判据 **13/13 咬住、真缺口 0**；不给我方判据 **0 咬住 / 13 漏网** |
| 回归 | 80 套件 / 1376 例 / 1376 pass / 0 fail |

---

## 一、★★★★★ 域层两条 return 的**形状不一样**

`expandGoalSlices` 在两条路上返回的**键不同**：

```js
// 首次展开
return { mode: 'slice', testDesignerTaskId: td.id, created, devops: devops.id }
// 重放（已经有切片了）
return { mode: 'slice', testDesignerTaskId: td.id, created: [], existed: existing.map(x => x.id) }
```

★★★ **首次那条根本没有 `existed` 这个键**，重放那条根本没有 `devops`。

> 一个「两条 return 都是同一个形状，只是字段值不同」的印象，
> 与一个「**键本身**只在一半的路径上存在」的事实，
> 在我把两条 return 逐字打出来看之前是同一个东西。

★ 判据钉住了这一点（首次 `existed === undefined`，且 `!'existed' in task`）。
★ 调用方若无条件读 `task.existed`，在首次展开时会拿到 `undefined` —— 而 `undefined.length` 会炸。

---

## 二、★★★★★ 既有套件对这条路由是**零覆盖**

不给我方判据：**0 咬住 / 13 漏网**。

★★ `goal-lifecycle-routes.test.mjs` 与 `goal.test.mjs` 都提到这个路径 /
这个域层函数，但 **13 个变异一个都没被抓住** —— 包括
**M3（`testDesignerTaskId` 必填那道闸整条删掉）**、
**M7（不再调域层）**、**M10（`by` 改成从 `body.by` 取 ⇒ 身份可被伪造）**。

> 一个「有 `goal.test.mjs`，所以这条路由是测过的」的印象，
> 与一个「它一个判据都没盖到这条缝上」的事实，
> 在我把 13 个变异投进去之前是同一个东西。

★ 这已经是**连续第三片**出现这个模式（切片 44 `task-feedback` 16 全漏、
切片 47 `team-plan` 24 全漏、本片 13 全漏）—— 而这三条**都恰好是"只有一条路由、
看着不值得单独写判据"的那些**。

---

## 三、★★★ 我自己的判据有一个**只锚左端**的正则

破验 M6（把报错文案 `缺少参数 testDesignerTaskId` 改成 `…TaskIdX`）**第一遍没咬住**。

★ 原因是我 ① 里写的是 `assert.match(error, /缺少参数 testDesignerTaskId/)` ——
**它连 `…TaskIdX` 也照样匹配**（正则没锚右端）。

> 一个「我断言了那句报错文案」的印象，
> 与一个「我的正则只钉住了它的**前缀**」的事实，
> 在有人往那句话后面多打一个字母之前是同一个东西。

⇒ 改成**逐字相等**（`assert.equal`）。同类问题在切片 41 的 `usedCtx`、
切片 43 的断言方向、切片 45 的 `m[2]`/`m[1]` 上都出现过 —— **正则判据要锚两端**。

---

## 四、★★★ 兄弟警告**第三次**过期

切片 45 立的那道判据（「别顺手搬走」里列的路由必须**此刻仍在 `server.mjs` 里**）
本片一跑就报：

```
✖ L5443 的警告已过期：它说别搬 POST /api/goal/slices，但那条已经不在 server.mjs 里了
```

★ 那是**切片 40**（`goal-lifecycle`）的接缝。★★ 而本片搬走 `POST /api/goal/slices` 之后，
**`/api/goal` 这个前缀在 `server.mjs` 里一个兄弟都不剩** ⇒ 那句警告整条删掉。

> 一个「上一片核对过这些警告」的印象，
> 与一个「它们各自描述的是**那一刻**还剩什么，每搬一条就变一次」的事实，
> 在我把这道判据每一片都真的跑一遍之前是同一个东西。

★ 判据首跑与二跑：**过期 1 条 → 0 条**（共列 3 条 → 2 条）。
★★ **同一片里还证明了反面**：切片 41 那句「别顺手搬走：`GET /api/artifact/content`」
**仍然有效**（那条确实还没搬，是剩下 5 条之一），判据专门断言了它**在**且**指得准**
—— 说明这道判据**两个方向都会响**，不是"见警告就报错"。

---

## 五、钉住的语义（15 例判据）

- ★★★ `testDesignerTaskId` 必填（缺/空串/非字符串都 400，**文案逐字**）；
  ★ **全空白不算"缺少参数"**（判的是 `length === 0` 而非 `trim()` —— 量出来的行为，钉住）。
- ★★ 缺操作者身份 ⇒ 400（`handleWrite` 的第一道闸）。
- ★★★ 任务不存在 ⇒ 400，且**一条切片任务都不建**（域层包了 `withTx`）。
- ★★★ 域层三道前置闸经由本缝可达：`role` 必须是 `test-designer` → 必须带 `[auto-goal]` → 必须 `done`；
  ★ 三道都不满足时报的是**第一条**（顺序钉住）；每次被拒都**零落库**。
- ★★★ `slices` 必须是 1..16 个；每个切片必须有 `title`（空白不算）；**第二个非法 ⇒ 第一个也不留**。
- ★★★ 成功形状（首次 vs 重放**键不同**）；★ 1 切片 ⇒ `created` **3** 条
  （coder + tester + devops）、落库 3 行、三种角色各一。
- ★★★ **`devops` 行的 `slice` 是 `td.id` 本身**（不是 `:S<n>`）—— 它是**目标级**收尾。
- ★★★ 幂等重放：`created: []`、`existed` 非空、**任务数不变**。
- ★★★ 路由**真的**调域层并把三件套原样递过去；★★★ **`by` 取的是写闸给的身份，不是 `body.by`**
  （否则审计可被伪造）。

---

## 六、九道门禁与回归

- 九道门禁 **9/9**
- 全量回归 **80 套件 / 1376 例 / 1376 pass / 0 fail**（+1 套件、+15 例）
- 逐字对拍：**46 族**路由一条没丢、体逐行按位置相同、无副本、装配到位
- `check-region-lines`：区间 **9 行**，丢注释 0 / 丢代码 0，**46 族全部零丢失**
- `check-free-identifiers`：**46 模块 / 未绑定 0**
- `baseline-snapshot --check`：无漂移
- ★★ `verify48` 的反自检：工作树模块 == 重新生成一遍（**逐字节相同，没留下变异体**）

---

## 七、⚠️ 本片**没有做**

- ★★★ **第 20 条钉住未修的缺陷**（切片 47 量出）：`GET /api/team-plan` 的 404 **没有 `code`**。
- ★★★ **`/api/events` 与 `/api/event-delivery` 仍故意留着** —— 按默认路线**留到最后单独决策**。
- ★★★ 域层没搬（本片只搬路由；`expandGoalSlices` 仍在 `server.mjs`）。
- ★★★ 四个工具的修法**仍只落在助手区**（已拖到**第十七片**）。
- ★★★ `mutate-lib.mjs` 的"中途抛错静默截断"**仍未修**；
  ★★ 而"被杀 ⇒ 变异留在工作树"这个**连续两片踩过**的坑，
  现在只被 `verify48` 里那段**反自检**挡着 —— **它仍在助手区，没进仓库**。
- ★★★ 破验的 `TESTS` 清单仍是**手工维护**。
- ★ **我没有补 `verify47.mjs`**（切片 35–46、48 都有，唯独 47 缺）——
  上一片记账时说过要在本片补，本片没补上，继续挂着。
- ★ 接缝契约只给 16 族补过，其余 **30 族**的 `dispatch` 契约仍无判据。
- ★★★ 回归选择器**只扫 `team-hub/`**；切片 1~5 丢失的注释仍未补。
- 余下 **5 条**：`POST /api/runtime/run-budget/may-switch-model`、`GET /api/activity`、
  `GET /api/events`、`GET /api/event-delivery`、`GET /api/artifact/content`。
