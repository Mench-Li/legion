<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 · 切片 45：第四十三族 = 工作空间注册 + 流水线配置

> **一句话**：把 `POST /api/spaces` 与 `POST /api/pipeline` 搬进 `team-hub/routes/space-config.mjs`。
> 破验两侧都很有信息量：**不给我方判据 11 咬住 / 14 漏网**（既有套件把**流水线状态机**守得很好，
> 却几乎没守**空间注册的校验**）；而我方 26 个变异里有**一个被测出是"可证等价"** —— 判据根本补不出来。

| 项 | 值 |
| --- | --- |
| 族号 / 切片号 | 第 43 族 / 切片 45 |
| 模块 | `team-hub/routes/space-config.mjs`（165 行） |
| 判据 | `team-hub/space-config-routes.test.mjs`（**19 例**） |
| 搬走的 2 条 | `POST /api/spaces`、`POST /api/pipeline`（全 `exact`） |
| 注入面 | 11 项（`json` + `db, now, audit, handleWrite, SCOPE_KEY_RE, normalizeStages, normalizeRuntime, withTx, readPipeline, pipelineWarnings`） |
| 规模 | `server.mjs` 5859 → **5804**（−55）；路由条件 11 → **9**；`dispatch` 调用点 42 → **43**；族模块 42 → **43** |
| 被删区间 | **67 行**（注释 6，路由 2），丢注释 0 / 丢代码 0 |
| 破验 | 有我方判据 **25/25 咬住、真缺口 0**；不给我方判据 **11 咬住 / 14 漏网** |
| 回归 | 77 套件 / 1324 例 / 1324 pass / 0 fail |

---

## 一、★★★ 接缝注释会**过期** —— 而没有任何判据会发现

切片 39 的接缝里写着：

```
// ⚠️ **前缀下还有不属于本族的**（别顺手搬走）：POST /api/spaces , POST /api/spaces/
```

那是当时**对的**。本片把 `POST /api/spaces` 搬走之后，**前一半变成了一句指着空气的警告** ——
它叫后来的人"别顺手搬走"一条**已经不在这个文件里**的路由。

`wire-family` 会把**新**接缝的兄弟算对（本片新接缝如实只列了 `POST /api/spaces/`），
但**没有任何东西会回头改旧接缝**。

> 一个「那句警告是给未来的人看的、所以一直有效」的印象，
> 与一个「它描述的是**此刻这个文件里**还剩什么，搬走一条就过期一条」的事实，
> 在我搬完却忘了回头改它之前是同一个东西。

★ 本片**修好了那一行**，并在 `verify45.mjs` 里补上了**此前完全没有的判据**：
扫出所有「别顺手搬走」警告，逐条读出它列的路由，断言**每一条此刻仍在 `server.mjs` 里**。
第一次跑就是这个形状：`共列了 5 条路由，过期 0 条`（修完之后）。

★★ 这正是待办里那条「**23 条接缝注释断言的不变量没有任何判据覆盖**」的第一块补丁。

---

## 二、★★★ 一个"真缺口"补不出来的变异：`body.scope` 那一行是**冗余**的

破验报 M18（`body.scope` 不再覆盖写作用域）"没咬住"。我本来要去补判据，补之前先把三条路算了一遍：

| `body.scope` | 路由原来算出的 `targetScope` | 改成 `scope` 之后 | |
| --- | --- | --- | --- |
| `'x'` | `'x'` | `handleWrite` 里 `scope = 'x'` | 同 |
| `''` | `scope` = `'default'` | `'default'` | 同 |
| 缺省 | `scope` = `'default'` | `'default'` | 同 |

★ 因为 `handleWrite` 里 `scope = readScope(body) = body.scope.trim() || 'default'` ——
**同一个值已经被算进 `scope` 了**，所以那三行是**冗余**的。

> 一个「这一行在覆盖写作用域，是个独立语义」的印象，
> 与一个「`handleWrite` 已经把同一个值算进了 `scope`，这一行恒等于它」的事实，
> 在我把三个分支挨个代进去之前是同一个东西。

⇒ **不是缺口，是等价**（"没咬住"的第二种）。判据**补不出来**，M18 已删，
但那段推导**留在变异文件里**，免得下一个人再试一次。

---

## 三、★★★ 只有一处分得开「权限闸的两个半句」

`/api/pipeline` 的闸是：

```js
if (body.by !== 'general' && by !== 'general' && body.forceGeneral !== true) throw …
```

破验 M6（**删掉操作者身份那一半**）第一遍"没咬住"。原因是
`handleWrite` 里 `by = requireMember(body)` = **`body.by.trim()`** ——
**没有空白时两个半句是同一个值**，怎么测都分不开。

★ 唯一分得开的情形是 `body.by` **带空白**：`body.by = ' general '` ⇒
`body.by !== 'general'`（原值）成立，但 `by === 'general'`（trim 后）——
**只有"操作者身份那一半"能放行**。加上这条用例，M6 才咬住。

> 一个「两个半句嘛，随便测一个就能盖住两个」的印象，
> 与一个「它们平时是**同一个值**，只有输入带空白时才分得开」的事实，
> 在我把 `by` 的来源追到 `requireMember` 之前是同一个东西。

---

## 四、★★ 另一处"护栏被自己守护的迁移追上了"

搬完之后 `baseline-snapshot --check` 报红：

```
FAIL 基线提取失败：HTTP 路由只提取到 9 条（下限 10），抽取规则可能已与源码脱节
```

`MIN_ROUTES = 10` 是写在 `server.mjs` 里还有 **191** 条路由的时候的。PRT-316 逐片搬走之后，
**应当**剩下的条数降到了 9 —— 于是这道"抽取器是不是坏了"的护栏，**在做得对的那一次**报了红。

> 一个「阈值 10 离真实值 191 很远，永远不会误报」的印象，
> 与一个「它守护的那件事**每成功一步**，真实值就朝阈值走一步」的事实，
> 在这个迁移快做完的时候是同一个东西。

⇒ 降到 **5**（仍能抓住"抽取器彻底脱节"），并把这段理由写进源码注释。
★ 真正该守的"搬家没搬丢"由 `assertRouteFamilyCoverage` 逐族核对，**不依赖这个魔数**（自身测试 25/25 仍绿）。

---

## 五、钉住的语义（19 例判据）

### `POST /api/spaces`

- 幂等 upsert：同 id 再来一次是**更新**（不新增行），且**审计分得开** `space:create` / `space:update`。
- `id` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`（64 字符要过、65 字符要拒、大写/下划线要拒）。
- `name` 非空白；`localDir` ≤512、`remoteUrl` ≤1024（正好到上限要过）。
- `localDir`/`remoteUrl` 会 `trim()`；**非字符串不报错**，按空串处理。
- `private` 真值判定（回布尔、存 0/1）；`agentCount` 只数**该空间**的编队。

### `POST /api/pipeline`

- ★★★ **只有 `general` 能改流水线**：`body.by`、操作者身份、`forceGeneral: true` 三个入口，
  且 `forceGeneral` 只认真 `true`（`'yes'` 不算）；**被拒时一行都不落库**。
- `stages` 必须是非空数组、role 唯一、`label` 必填、`gate:true` 必须有 `artifact`。
- **整批 upsert 会删掉没提交的旧阶段**并在 `dropped` 里报出来；`next` 必须指得到。
- `runtime` 校验（`maxWorkers` 1~8 整数）；★ **不给就一行都不动**（不能顺手写默认值）。
- ★★ **是事务**：中途失败时旧阶段还在、新阶段**没有**落进去。
- 响应带 `version` / `activeRoles` / `warnings`（★ `version` 实测是**字符串**）；
  `updatedAt` 必须是**刚刚**的时间（写死的常量不行）。

---

## 六、九道门禁与回归

- 九道门禁 **9/9**
- 全量回归 **77 套件 / 1324 例 / 1324 pass / 0 fail**（+1 套件、+19 例）
- 逐字对拍：**43 族**路由一条没丢、体逐行按位置相同、无副本、装配到位
- `check-region-lines`：区间 **67 行**，丢注释 0 / 丢代码 0，**43 族全部零丢失**
- `check-free-identifiers`：**43 模块 / 未绑定 0**
- `baseline-snapshot --check`：无漂移（`MIN_ROUTES` 调整后自身测试 25/25）

---

## 七、⚠️ 本片**没有做**

- ★★★ **`/api/events` 与 `/api/event-delivery` 仍故意留着**（14 个注入项、含可变共享绑定
  `eventClients` 与 SSE）—— 按默认路线**留到最后单独决策**。
- ★★★ 域层没搬（本片只搬路由）。
- ★★★ 四个工具的修法**仍只落在助手区**（已拖到**第十四片**）。
- ★★★ `mutate-lib.mjs` 的"中途抛错静默截断"**仍未修**。
- ★★★ 破验的 `TESTS` 清单仍是**手工维护**；**没有任何东西阻止"边测边动同一棵工作树"**。
- ★ 接缝契约只给 13 族补过，其余 **30 族**的 `dispatch` 契约仍无判据。
- ★★★ **兄弟警告的判据目前只写在 `verify45.mjs` 里**（助手区），**没进仓库** ——
  这是"工具修法拖了十四片"那条待办的又一个实例。
- ★★★ 回归选择器**只扫 `team-hub/`**；切片 1~5 丢失的注释仍未补。
- 余下 **9 条**：`POST /api/agents`、`POST /api/spaces/`、`GET /api/events`、
  `GET /api/event-delivery`、`POST /api/goal/slices`、`GET /api/team-plan`、
  `POST /api/runtime/run-budget/may-switch-model`、`GET /api/activity`、`GET /api/artifact/content`。
