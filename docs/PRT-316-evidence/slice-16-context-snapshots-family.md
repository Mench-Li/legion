<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 16：第十五族 = **上下文快照（context-snapshots，6 条）**

- 切片：16（新增 `team-hub/routes/context-snapshots.mjs`）
- 提交：见 `git log`（`feat(PRT-316 切片 16)`）

## 一、为什么选这一族

选族的判据不是"条件行少"，而是**有没有强判据**。按这个判据重扫，这一族远好过
`models` / `price-tables` / `config-bundle`（各 3 条，**没有任何真 hub 判据**）：

| 套件 | 例数 | 请求点 | 覆盖本族 |
| --- | --- | --- | --- |
| `team-hub/context-retention.test.mjs` | 29 | 27 | **6/6 条** |
| `team-hub/context-export.test.mjs` | 16 | 7 | export 面 |
| `team-hub/context-e2e.test.mjs` | 22 | 3 | 读面 + assemble |
| `workbench/scripts/snapshot-view.test.mjs` | 33 | 6 | 四类 |
| `team-hub/context-replay-run.test.mjs` | 8 | 5 | 单条 + verify |
| 其余 7 套 | — | — | assemble 等 |
| **合计** | | **60** | **12 套强判据** |

体量最大的一族：被删区间 **440 行**，其中**注释 100 行**。

## 二、★★★★ 这一片最大的收获：**我的判据筛选器坏了两次**

### 第一次：把"提到"当成"判"

第一轮破验选了 `run-routes`（30 例）+ `run-plane-e2e`（20 例），
结果是 **0/10 咬住** —— 看上去像"这族产品没人守"。

真相是：**这两套各自只调本族 6 条里的 1 条**（`POST /api/context-snapshots/assemble`）。
它们确实提到本族路径，也确实在做真 HTTP，**但没有一条打在其余 5 条上**。

> 一条"这个套件提到了这个路径"的判据，与一条"这个套件**请求了**这个路径"的判据，
> 在这个套件恰好只用到其中一条路由的时候是同一个东西。

### 第二次（更贵）：HTTP 判据写成了**子串**

`c.includes('listen(0)')` —— 它只在 `.listen()` 的实参**恰好为空**时成立：

```js
mod.server.listen(0)                              // ← 含 'listen(0)'
mod.server.listen(0, '127.0.0.1', resolve)        // ← **不含**（0 后面是逗号）
```

而本族**最强的那套判据**（`context-retention.test.mjs`，29 例 / 27 请求点 / 覆盖 6/6 条）
写的正是第二种。⇒ 它被我判成"非 HTTP"，**于是没进破验的判据集**。

> 一个"这个套件里出现了 `listen(0)`"的判据，与一个"这个套件真的起了 hub"的判据，
> 在这个套件恰好写成 `listen(0)`（不带别的实参）的时候是同一个东西。

正确判据是**正则** `/\.listen\(\s*0\b/`。订正后：本族有 **12 套强判据 / 60 个请求点**。

★★★ **这一条不只是本片的事**：先前几片"这族没有真 HTTP 判据"的结论是按同一个坏判据得出的，
因此**偏保守的方向错了** —— 被我跳过的一些族很可能有强判据。
⇒ 订正后的筛选器留作 `survey-judges2.mjs`，后续选族一律用它。

## 三、规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 8008 | **7580**（−428） | 9221（累计 **−1641**） |
| `handle()` 路由条件（抽取器） | 115 | **109** | 191 |
| `router.dispatch` 调用点 | 14 | **15** | 0 |
| `routes/` 族模块 | 14 | **15** | 0 |
| 平台契约 `httpRoutes` | 188 | **188** | — |

**109 剩余 + 79 已搬 = 188** ✓（`assertRouteFamilyCoverage` 通过，15 族）

★ 记一笔口径：按原始正则数条件行会数出 **110**，抽取器（权威）数 **109** ——
差的那一条是**路径不是字符串字面量**的守卫，抽取器按设计不认它。
⇒ 两个数都对，**但它们回答的不是同一个问题**；本片一律以抽取器为准。

## 四、逐字对拍（15 族）

```
✅ 对拍通过：15 族路由一条没丢、体逐行按位置相同、无副本（两种口径）、装配到位
独立口径残留合计 0 条
✔ 没有跨族遮蔽
```

族内 6 条，方法/匹配方式/顺序逐条对应：
`GET 列表`、`GET /retention`、`POST /purge`、`GET /tombstones`、`POST /assemble`、
`GET /<id>`（前缀，内部再分 `/<id>` 与 `/<id>/export` 两半）。

★ 逐行核对被删区间：**440 行（注释 100、路由 6）→ 丢注释 0 / 丢代码 0**。
本族有 **4 个内部子分隔符**（retention / purge / tombstones / 导出），
而 `assemble` 那条**上面没有分隔符** ——
"有的路由有说明、有的没有"两种形态第一次同时出现，生成器两种都对。
5 段子说明（5/5/1/4/15 行）全部逐字搬入。

★ 本族的模块**没有 `authorized()` 调用** —— 生成器的"登记项必须被用到"守卫当场拦下，
逼我去找原因。答案是**对的**：`server.mjs` L5046 有一道**全局**鉴权闸门
（`if (readAuthRequired() && path !== '/api/config' && !authorized(req))`），
所以这几条路由从来不需要自己判。
（*一个"这族少了鉴权"的判据，与一个"鉴权在上一层做掉了"的判据，
只在这几行里看的时候是同一个东西。*）

## 五、破验：四轮，25 处

| 轮 | 判据集 | 结果 | 那 9 条"没咬住"是什么 |
| --- | --- | --- | --- |
| 1 | `run-routes` + `run-plane-e2e`（**选错**） | 0/10 | 不是缺口 —— **判据集错了** |
| 2 | 订正后的 5 套 | 16/25 | 8 条真缺口 + **1 条我瞄错**（M5） |
| 3 | +7 条契约用例 | 24/25 | M13 是**我这一刀没切全** |
| 4 | 订正 M13 的锚点 | **25/25** | **真缺口 0、可证等价 0** |

逐字节还原 ✔、还原后复绿 ✔。

### 那 8 条真缺口（都已补成判据）

| 缺口 | 为什么此前没人问 |
| --- | --- |
| M1/M2 列表的 `count` / `snapshots` | 这条路由**一条判据都没有** |
| M8 `/retention` 200 的 `policy` 回显 | "我按什么策略算的这张表"看不见，表就没法复核 |
| M6 ★★★ `activeRunId` 透传 | 领域函数 `planSnapshotRetention()` 测得**很足**，而**路由有没有把查询串传下去**没人问 |
| M11/M13 assemble 的两个具名码 | 只测了 `CONTEXT_PERMISSION_REQUIRED` / `CONTEXT_BAD_SOURCE` |
| M15 export 的空白 `by` | 测了"缺 `by`"，没测"`by` 是空白" |
| M24 id 里带 `%2F` | 测了"缺 id"，没测"路径形状不对" |

★★ M6 是**本片最值钱的一条**：它正是一年前那类形状 ——
**领域面测得很足，接口面没接上**。
（`activeRunId` 没被透传时，一次预览会**如实报出**"这些都被清掉了"，
包括正在跑的那次运行的证据 —— 而删掉活着的证据是不可逆的。）

### 两条"没咬住"其实是**我的工具**错

- **M5**：我放宽的是 `maxBytes` 那一支，而套件打的是 `?maxAgeDays=0&maxBytes=null`。
  *一个"我改坏了产品"的判据，与一个"我改的地方恰好没人测"的判据，
  在我不去核对套件到底打的是哪一支的时候是同一个东西。*
- **M13**：锚点带了**尾逗号** `code: 'CONTEXT_BAD_CANDIDATE',`，于是只命中两处
  `json(res, 400, …)`，**漏掉抛出来的那一处**（那行没有尾逗号）——
  而新增的判据 ⑩ 打的**正是**抛出这条路。
  *一个"我把这个具名码全改了"的判据，与一个"我改了两次、漏掉第三次"的判据，
  在第三次恰好是唯一被断言的那条路的时候是同一个东西。*

⇒ 两轮都是**先怀疑判据、结果查出是靶子/工具**。这正是本会话那条规矩：
**先怀疑量具，再怀疑产品。**

## 六、判据与新增用例

`team-hub/context-retention.test.mjs` 末尾追加 **7 条**契约用例（29 → **36** 例）：
⑥ 列表 `count` 与长度一致 + 每条带 `snapshotHash`；⑦ `/retention` 回显 `policy`；
⑧ ★★★ `activeRunId` 真的透传（先断言"不带它本来会被清掉"作为前提，再断言带上它不被清 + 留下 `PINNED` finding）；
⑨ `CONTEXT_BAD_REQUEST`；⑩ `CONTEXT_BAD_CANDIDATE`；⑪ 空白 `by`；⑫ `%2F` → `MISSING_PARAM`。

★ 期望值**全部先量出来再写死**（`probe-slice16-gaps.mjs`）。量出来的两件事改了我的草稿：
`assemble` 的 candidate 兜底体里还有 `stateMachineCode`/`missing`/`currentSettlement` 三个键
（所以只能断言 `code`，不能 `deepEqual` 整个体）；`by=%20` 与 `by=` **都**回 `EXPORT_BY_REQUIRED`。

★ 契约块放在**独立文件**（`slice16-contract-block.txt`）再追加，是因为第一版写成 JS 模板字面量，
块里的反引号与定界符打架。
*一段"要用它自己的引号规则转义一遍"的文本，与原文，在原文里没有那种引号的时候是同一个东西。*

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` `node --check` | ✅ |
| 15 族逐字对拍 ①②③⑤ | ✅ 一条没丢 |
| 被删区间逐行核对 | ✅ 丢注释 0 / 丢代码 0 |
| 无跨族遮蔽 | ✅ |
| 破验 | ✅ **25/25**，真缺口 0 |
| `context-retention` | ✅ **36/36** |
| 全量回归 | ✅ **51 套件 / 896 例 / 896 pass / 0 fail**（+7 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25 |

## 七、本片**没有**做

- 域逻辑（`planSnapshotRetention` / `assembleContext` / `buildSnapshotExport` …）仍在原处，
  **只搬路由**。
- `%2F` 的 400 用的是 `MISSING_PARAM`（"路径应为 …"）—— 与"缺参数"共用一个码，
  语义上偏窄；**记录为既有不对称，本片不改**（改它要动对外契约）。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补。
- 其余 **109** 条路由条件仍在 `handle()`。

## 八、复现命令

```powershell
node .worktrees/_prt-handoff/survey-judges2.mjs /api/context-snapshots   # ★ 订正后的选族判据
node .worktrees/_prt-handoff/gen-family.mjs context-snapshots
node .worktrees/_prt-handoff/wire-family.mjs context-snapshots /api/context-snapshots createContextSnapshotsRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/probe-slice16-gaps.mjs
node .worktrees/_prt-handoff/add-context-contract-tests.mjs
node .worktrees/_prt-handoff/mutate-slice16.mjs
```
