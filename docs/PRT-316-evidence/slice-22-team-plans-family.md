<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 22：第二十一族 = `/api/team-plans`（2 条）—— 破验 9/17，而**我自己的登记工具把门禁脚本写坏了**

- **族**：`team-plans`（`team-hub/routes/team-plans.mjs`），**2 条**路由共用同一个 path：
  `GET /api/team-plans`（读一版）/ `POST /api/team-plans`（冻结一版，PRT-402 的写一半）
- **参考提交**：搬走前 `ba8dce6`
- **为什么是它**：候选表里请求点最多（7 点）；21 行、0 外来条件、无宿主名写入、无前缀冲突。
  （`/api/board` 只有 9 行 / 1 条 / 5 点，本片选它是因为两条路由 + 7 个请求点的单位风险产出更高。）

---

## 1. ★★★ 本片最重的一件事：**我的登记工具把 `baseline-snapshot.mjs` 写成了语法错误**

`register-baseline.mjs` 把族名直接拼成属性名：

```js
const camel = `routes${name[0].toUpperCase()}${name.slice(1)}`
// name = 'team-plans'  ⇒  routesTeam-plans     ← 连字符不是合法标识符
```

写出来的行是：

```js
SOURCES.routesTeam-plans = join(ROOT, 'team-hub', 'routes', 'team-plans.mjs')
```

后果是连锁的，而且**每一环都是红的**：

| 症状 | 读数 |
| --- | --- |
| `node --check scripts/prt/baseline-snapshot.mjs` | **exit 1**（`Invalid left-hand side in assignment`） |
| `baseline-snapshot --record` / `--check` | **exit 1**，门禁直接失效 |
| `baseline-snapshot.test.mjs` 里两把判据 | **2 红**（⑤ F-21 路由可见性、探测有非测试调用方） |

而**工具自己报了 ✔**：

```
✔ baseline-snapshot：+SOURCES.routesTeam-plans = join(ROOT, 'team-hub', 'routes', 'team-plans.mjs')
✔ baseline-snapshot：+{ module: 'routesTeam-plans', family: 'team-plans', factory: 'createTeamPlansRoutes' },
```

> 一个"我登记进去了"的 ✔，与一个"我写出来的东西根本跑不起来"的事实，
> 在我把**"写成功"当成"写对了"**的时候是同一个东西。

### 1.1 为什么潜伏了 20 片

前 20 族的名字**全是单个单词**：`rules` / `permissions` / `chat` / `calendar` / `compaction` /
`secrets` / `automation` / `experience` / `packs` / `role-packs`…
—— 等一下，`role-packs`、`price-tables`、`config-bundle`、`tool-calls`、`model-profiles`、
`context-snapshots` **都带连字符**。它们没炸，是因为它们的 `SOURCES.*` 行是**手写**进去的
（写成 `routesPriceTables` / `routesConfigBundle` …），没走这个工具。
**这个工具是切片 20 才写的，而它写出的前两族恰好叫 `create` 和 `comment`。**

> 一个"这个工具已经成功用了两次"的判据，与一个"它对**连字符**这一类输入从来没被跑过"的事实，
> 在我只拿两个不含连字符的输入试过它的时候是同一个东西。

### 1.2 修法：既修伤，也修造成伤的那把工具

**伤**（`scripts/prt/baseline-snapshot.mjs`，两处）：`routesTeam-plans` → `routesTeamPlans`。

**工具**（`register-baseline.mjs`）：加了两道**它自己**的判据 ——

1. 族名先归一成合法标识符（按 `-` / `_` / `.` 分段、每段首字母大写），并断言结果匹配 `^[A-Za-z_$][\w$]*$`；
2. ★ **写完必须自己 `node --check` 一遍**：落盘前先验旧文本、再验新文本，
   落盘后**再验一次**；任何一步不合法就**回滚并抛**，绝不报 ✔。

修复后的证明：用同一个族名重跑，工具**拒绝**了 —— 说明它算出来的 `camel`
是 `routesTeamPlans`（已存在），而不是又写一遍 `routesTeam-plans`。

---

## 2. 破验：第一轮 **9/17** —— 8 条真缺口

本族**只有一把**既有判据：`orchestrator/worker/sources-loader.test.mjs`（58 例、7 个请求点）。
它守住了路由可见性、scope、`count`、`plans`、`idempotent` 的最基本用法，但漏了：

| 变异 | 是什么 | 第一轮 |
| --- | --- | --- |
| M5 | **limit 下钳位** 1 → 0（`limit=0` 返回空） | ✖ |
| M6 | **limit 上钳位** 500 → 10000 | ✖ |
| M7 | `serverTimeMs` 不再返回 | ✖ |
| M10 | 只认 `body.plan`，不认直接给 body | ✖ |
| M12 | 丢掉 `actor` / `by` 兜底 | ✖ |
| M13 | 回执不再带 `idempotent` | ✖ |
| M14 | `idempotent` 恒为 false | ✖ |
| M15 | 不 await 写门面 | ✖ |

⇒ 补 `team-hub/team-plans-routes.test.mjs`（**12 例**）⇒ 终局 **17/17 咬住（真缺口 0，可证等价 0）**。
连续第二个满咬合切片。

### 2.1 ★ 两条边界要"看得见"是有代价的，而代价必须先量

- **上钳位 500**：要有 >500 条才观测得到。量出来 **501 次 POST ≈ 7.4 秒**，
  这条断言的全部成本就是这个数，量过之后才敢写。
- **下钳位 1**：`limit=0` / `-5` / `abc` 三个值都要落到 1。
  *一个"limit 是 0 就返回 0 条"的实现，与一个"这个范围里没有计划"的实现，
  在调用方那里是**看起来一样**的两种东西。*

### 2.2 ★ 量出来的形状：读与写的回执**不一样**

| | 形状 |
| --- | --- |
| 读回执 | `{ok, plans, count, serverTimeMs}`，**`plans` 里的条目就是计划本身** |
| 写回执 | `{ok, plan, idempotent}` |

草稿里我本来要断言 `plans[0].plan.id`（照写回执的样子套）——量出来 `plans[0]` 没有 `.plan` 外壳。
**同一个端点的两个方向形状不同**，不分别打出来就会写错一边。

### 2.3 ★ 测试先抓到我一次：`actor` 缺省**不是**兜到 `by`

我写的断言是"没给 actor 时缺省兜到 `by`"，量出来 `member` 是 **`null`**：

```js
actor: body.actor ?? body.by ?? null
```

这里的 `by` 是**调用方给的 `by`**，不是"缺省叫 by 的那个东西"。

> 一个"没传就兜到某个默认身份"的判据，与一个"没传就是没有身份"的事实，
> 在我没把三种情况（都不给 / 只给 `by` / 给 `actor`）**各跑一次**的时候是同一个东西。

改成三级兜底各断言一次之后，M12 才真正被咬住。

### 2.4 ★ 一条**已知缺陷**，本片把现状钉住

`limit=2.7` → **500**：`Math.min(Math.max(Number('2.7') || 0, 1), 500)` = 2.7，
小数一路走到 SQLite 的 `LIMIT` 就抛。

**这不是本片引入的**，是量出来的既有行为。处理方式是**把现状钉住**而不是假装它是对的：

```js
assert.equal(r.status, 500, '现状是 500。若这条红了：说明有人把非整数 limit 修成了别的行为 —— ' +
  '请把它改成断言**新行为**，并顺手把 ⑨ 那条边界补上"非整数"这一格。')
```

*一个"把已知缺陷写成断言"的做法，看起来像在给 bug 背书；
但一条**会因修复而变红**的断言，与一条**永远不可能失败**的断言，区别就在这里 ——
前者把 500 关在有人看着的格子里，后者把同一件事放进"没人走过"的格子。*

---

## 3. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7371 | **7358**（−13；`+8/−21`） | 9221（累计 **−1863**） |
| `handle()` 路由条件（抽取器口径） | 100 | **98** | 191 |
| `router.dispatch` 调用点 | 20 | **21** | 0 |
| `routes/` 族模块 | 20 | **21** | 0 |

**98 剩余 + 90 已搬 = 188** ✓ · 被删区间 **21 行**（注释 **4**、路由 2），**丢注释 0 / 丢代码 0**

★ 这 4 行注释正是 PRT-402 的来龙去脉（"没有这条路由，读面永远返回 404，
而'读面做好了'与'库里永远为空'在用户那里是同一件事"）—— 本片要保的就是它，
而**判据该守的正是这句话**（写面真的能把东西放进库里、读面真的读得到）。

---

## 4. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 21 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 20 族读数未变** |
| 无跨族遮蔽（两条路由共用 path、不与别族冲突） | ✅ |
| **自由标识符常设判据** | ✅ 21 模块 / 未绑定 0 |
| 破验 | ✅ **17/17 咬住**，真缺口 0、可证等价 0 |
| `team-plans-routes`（本片新判据） | ✅ **12/12** |
| 既有判据 `orchestrator/worker/sources-loader.test.mjs` | ✅ **58/58** |
| 全量回归 | ✅ **55 套件 / 951 例 / 951 pass / 0 fail**（+1 套件、+12 例） |
| 九道门禁 | ✅ **9/9**（修好之前是 baseline 那道红） |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 90 / sources 39 / 族 21） |

---

## 5. 本片**没有**做

- **`limit=2.7` → 500 这个既有缺陷没有修** —— 只钉住了现状（理由见 §2.4）。
  修它属于产品语义（"非整数 limit 该 400 还是该取整"），不是搬家。
- `/api/board`（9 行 / 1 条 / 5 点）/ `/api/task-feedback`（46 行）/ `/api/activity`（20 行）等候选**未动**。
- **`/api/events`（77 行 / 6 点）仍未搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`），仍是**单独一片**。
- 域逻辑（`contextPlanStore` / `putTeamPlan` / `listTeamPlans`）仍在原处，**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**（`sources-loader.test.mjs` 仍靠人单独跑）。
- `register-baseline.mjs` 的修复**留在助手区**（`.worktrees/_prt-handoff/`），**不进仓库** ——
  与"把助手判据搬进仓内常设闸门"是同一件独立的事。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **98** 条条件仍在 `handle()`。

---

## 6. 复现命令

```powershell
node .worktrees/_prt-handoff/probe-candidates.mjs /api/team-plans /api/board
node .worktrees/_prt-handoff/probe22-team-plans.mjs    # 先量：读到的是"没有条件"还是"合法计划"
node .worktrees/_prt-handoff/probe22b-team-plans.mjs   # 有效载荷形状
node .worktrees/_prt-handoff/probe22c-team-plans.mjs   # actor 可见性 + 501 条的成本
node .worktrees/_prt-handoff/gen-family.mjs team-plans
node .worktrees/_prt-handoff/wire-family.mjs team-plans /api/team-plans createTeamPlansRoutes
node .worktrees/_prt-handoff/register-family.mjs team-plans ba8dce6 /api/team-plans team-hub/routes/team-plans.mjs createTeamPlansRoutes
node .worktrees/_prt-handoff/register-baseline.mjs team-plans team-hub/routes/team-plans.mjs team-plans createTeamPlansRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node .worktrees/_prt-handoff/mutate-slice22.mjs
node --test team-hub/team-plans-routes.test.mjs
node --test orchestrator/worker/sources-loader.test.mjs
```
