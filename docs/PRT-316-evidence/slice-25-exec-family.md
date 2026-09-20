<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 25：第二十四族 = 自动执行开关与请求队列（`/api/exec` 五条）—— 破验 26/26 满咬合

- **族**：`exec`（`team-hub/routes/exec.mjs`），**5 条**：
  - `GET /api/exec`（读开关）/ `POST /api/exec`（写开关，upsert + audit）
  - `GET /api/exec/queue`（该自动执行的任务，**排掉已登记的**）
  - `POST /api/exec/request`（登记一个执行请求）/ `GET /api/exec/requests`（看已登记的）
- **参考提交**：搬走前 `cc04471`
- **规模**：48 行、5 条、**外来 0**、**分段 1** —— 剩下 94 条里**最大的一个干净多条目**

---

## 1. 先按"前缀组"重新画一次地图（比上一轮那张更准）

上一轮用"精确路径 + 连续段"扫，这一轮换成**按前缀段分组**（`group-remaining.mjs`），
专门看"还有哪些一族多条"：

```
94 条条件，归成 37 个前缀组
```

**干净的多条组**（外来 0、分段 1）：

| 前缀组 | 条数 | 行数 | 路径 |
| --- | --- | --- | --- |
| **`/api/exec`** | **5** | **48** | `/api/exec` ×2、`/api/exec/queue`、`/api/exec/request`、`/api/exec/requests` |
| `/api/models` | 3 | 42 | `/api/models` ×2、`/api/models/clear` |
| `/api/web` | 3 | 80 | `/api/web/history` ×2、`/api/web/history/clear` |
| `/api/model-migration` | 2 | 49 | `plan` / `apply` |
| `/api/skill-source` | 2 | 14 | 单数 ×2 |

而**纠缠的**（外来多、被切成好几段）：`/api/runtime`（26 条 / 外来 8 / 分段 2）、
`/api/spaces`（6 条 / 外来 22 / 分段 **4**）、`/api/skills`、`/api/goal`、`/api/documents` …
**单条的有 23 个**（`/api/board`、`/api/task`、`/api/scopes`、`/api/activity` …）。

⇒ 挑 `/api/exec`：条数最多、最干净、前缀**量过无碰撞**（只捞这 5 条）。
★ 顺带说明：上一轮说"`F.paths` 大概率绕不开"——**到这一片仍然不需要**，
因为 `/api/exec` 这个前缀本身就是一族。

---

## 2. ★ 本族搬走前**一把判据都没有**

`survey-judges2.mjs` 对四个路径全报 **"强判据 0 套、请求点合计 0"**。
5 条路由、48 行、其中还有**自动执行的开关**（打开它＝让机器自己干活），
**从来没有被任何用例看过一眼**。

⇒ 与前两片不同（那两片是"先拿既有判据跑破验 → 看漏什么 → 再补"），
本族**先写判据、再破验**（破验的基线要求套件全绿）。

---

## 3. ★★★ 量出来的形状：**两个写门面的信封不一样**

| 门面 | 回执 |
| --- | --- |
| `handleWrite`（本族的写开关/登记请求） | `{ok: true, task: <结果>}` —— 结果**裹在 `task` 里** |
| `handleRun`（切片 22/24 那些） | `{ok: true, ...<结果>}` —— 结果**摊开来** |

切片 24 我刚量过 `handleRun` 那条（`{ok, manifest, created}` 是摊平的），
这一片又是 `handleWrite` 的 `{ok, task:{…}}`。

> 一个"写门面只有一个信封"的印象，与一个"两条写门面各自裹法不同"的事实，
> 在我只照着**上一条**端点的回执去解这一条的时候是同一个东西。

### 3.1 其余量出来的事实（全部进了判据）

| 事实 | 读数 |
| --- | --- |
| 读开关**永远 200** | 没有这个空间也 200：`{scope, enabled:false, updatedAt:null}`，**不 404** |
| 写要 `body.by` | 缺了/全空白 → 400 `缺少操作者身份 by`；`by` **会 trim** |
| `enabled` 是**严格** `=== true` | `1` / `'true'` / `'yes'` / `'on'` / `null` → **全算 false** |
| `scope` 缺省 | `body.scope` 缺或全空白 → 落到 `readScope(body)` 的 **`'default'`**；给了会 trim |
| `queue` 三重筛选 | 描述含 `[auto-goal]` **且** 状态 todo/in_progress **且** 角色不在 `NON_AUTO_ROLES` |
| `queue` 的 scope | 带了就是它，不带是 **`'all'`** |
| ★★ 合流 | 登记过的任务**从 queue 里消失**（`pending` 集合过滤） |
| `requests` | **裸数组**，每行恰好 `{taskId, scope, createdAt}` —— **没有 `status`**（这条只看 pending） |
| `requests` 排序 | `createdAt` **升序** |
| 重复登记 | `ON CONFLICT` 幂等，不新增行 |

### 3.2 ★ 又一处"相邻的两个字段，一个 trim 一个不 trim"

```js
const by = body.by                                   // requireMember：by.trim().length === 0 ⇒ **会 trim**
if (typeof id !== 'string' || id.length === 0) …     // request：只看 length ⇒ **不 trim**
```

于是 `taskId: '   '` 会**通过**校验、去查库、查不到才报 —— 量出来的错误是
**`未知任务    `**（带三个空格），而不是 `缺少参数 taskId`。

判据把它**钉住现状**（同切片 22 的 `limit=2.7`、切片 24 的 `code: undefined` 处理方式），
并写明"若这条红了说明有人给 taskId 加了 trim，请改成断言 `缺少参数 taskId`，
并顺手看看 `by` 那条是否也该统一"。

*一个"两个字段都校验过了"的判据，与一个"一个 trim 了、另一个只看长度"的事实，
在我没有拿**带空白**的输入各试一次的时候是同一个东西。*

---

## 4. 破验：**26/26 咬住**（真缺口 0，可证等价 0）—— 第四个连续满咬合切片

本族判据是**本片新写的那把**（21 例）。26 条变异逐条：

| 变异 | 表现 |
| --- | --- |
| M1–M5 | 五条路径各多一个字符 ⇒ 逐条失效 |
| M6/M7 | 读开关 `enabled` 恒 false / `updatedAt` 恒 null |
| M8 | 没开过的空间改成 404（**没开过 ≠ 不存在**） |
| M9 | ★★ `enabled` 判真变宽松 ⇒ `1`/`"true"`/`"yes"` 都会**打开自动执行** |
| M10/M11 | `scope` 不 trim / 缺时不落缺省 |
| M12 | ★★ `queue` 不再排写码类角色（coder 也被派出去） |
| M13 | ★★ `queue` 不再要求 `[auto-goal]`（普通任务也被自动执行） |
| M14 | `queue` 不看状态（做完的也被派出去） |
| M15 | ★★★ `queue` 不再排掉**已登记**的（同一件事被反复派） |
| M16 | 不带 scope 时 `'all'` 丢掉 |
| M17/M18 | 不校验 `taskId` / 不确认任务存在 |
| M19/M20 | 回执 scope 不取自任务表 / status 不是 pending |
| M21 | ★★ `requests` 不按 status 筛（做完的一直在队列里） |
| M22 | `requests` 排序反了 |
| M23/M24 | 多回一格 `status` / 裹成 `{ok, requests}`（裸数组变了） |
| M25/M26 | `dispatch` 不看方法 / 先认领再执行 |

逐字节还原 ✔、还原后复绿 ✔。

---

## 5. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7319 | **7280**（−39；`+9/−48`） | 9221（累计 **−1941**） |
| `handle()` 路由条件（抽取器口径） | 94 | **89** | 191 |
| `router.dispatch` 调用点 | 23 | **24** | 0 |
| `routes/` 族模块 | 23 | **24** | 0 |

**89 剩余 + 99 已搬 = 188** ✓ —— **已搬过了半**（99 / 188 = 52.7%）·
被删区间 **48 行**（注释 2、路由 5），**丢注释 0 / 丢代码 0**

---

## 6. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 24 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 23 族读数未变** |
| **自由标识符常设判据** | ✅ 24 模块 / 未绑定 0 |
| 破验 | ✅ **26/26 咬住**，真缺口 0、可证等价 0 |
| `exec-routes`（本片新判据，本族**首个**判据） | ✅ **21/21** |
| 全量回归 | ✅ **58 套件 / 999 例 / 999 pass / 0 fail**（+1 套件、+21 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 99 / sources 42 / 族 24） |

---

## 7. 本片**没有**做

- `/api/models`（3 条 / 42 行，干净）、`/api/web`（3 条 / 80 行，干净）、
  `/api/model-migration`（2 条）、`/api/skill-source`（2 条）—— **都量过是干净的，都留着**。
- `/api/model-bindings`（前缀跨两个作用域，仍欠"拆族或加 `F.paths`"的裁决）。
- `/api/runtime`（26 条但外来 8、分段 2）、`/api/spaces`（分段 4，外来 22）等**纠缠族未动**。
- 23 个单条的最小组也**未动**。
- **`/api/events` 仍未搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`），仍是**单独一片**。
- ★ **切片 24 报的两条缺陷仍未处理**：`CONTEXT_PLAN_ERRORS` 那两处键名错误
  （其中 `server.mjs` 里 `/api/team-plan` 那处本片依然没碰）。
- 域逻辑仍在原处（本族的表/`listTasks`/`NON_AUTO_ROLES` 都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；助手工具仍住在 `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **89** 条条件仍在 `handle()`。

---

## 8. 复现命令

```powershell
node .worktrees/_prt-handoff/group-remaining.mjs    # 按前缀组重新画地图
node .worktrees/_prt-handoff/survey-judges2.mjs /api/exec   # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe25-exec.mjs       # 先量五条的真实形状
node .worktrees/_prt-handoff/gen-family.mjs exec
node .worktrees/_prt-handoff/wire-family.mjs exec /api/exec createExecRoutes
node .worktrees/_prt-handoff/register-family.mjs exec cc04471 /api/exec team-hub/routes/exec.mjs createExecRoutes
node .worktrees/_prt-handoff/register-baseline.mjs exec team-hub/routes/exec.mjs exec createExecRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/exec-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice25.mjs
```
