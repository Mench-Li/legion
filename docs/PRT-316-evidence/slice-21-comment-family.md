<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 21：第二十族 = `/api/comment`（追加批注，1 条）—— 破验 5/19 逼出第二套族专属判据

- **族**：`comment`（`team-hub/routes/comment.mjs`），1 条路由：`POST /api/comment`（精确）
- **参考提交**：搬走前 `a0ae72d`
- **为什么是它**：切片 20 之后候选表里请求点最多的一族（8 点），16 行、无外来条件、
  无可变绑定、无顶层声明、无前缀冲突。

---

## 1. 破验第一轮 **5/19** —— 又是一族"没有专属判据"

既有那几把（`sources-loader` 58 例 / `team-hub-parity` / `v1v2-contract`）只钉住
"能追加进去"和两端一致，钉不住**追加到哪一列**、什么算反馈、什么算证据、审计记成什么：

| 变异 | 是什么 | 第一轮 |
| --- | --- | --- |
| M1 | text 只挡空串、不挡**全是空格** | ✖ |
| M2 | 非字符串 text 不再拦 | ✖ |
| M3 | 空 id 不再拦 | ✖ |
| M4/M5 | 两条报错文案改了 | ✖ |
| M6 | 存进去的 text 不再 trim | ✖ |
| M7 | **`kind` 与 `isEvidence` 的优先级反了**（反馈存进证据列） | ✖ |
| M8 | `isEvidence` 不再要求字面 `true` | ✖ |
| M9 | `kind === 'feedback'` 改成看真值 | ✖ |
| M12 | **审计动作恒为 `comment`**（反馈/证据在审计里看不见） | ✖ |
| M13 | 审计丢掉 goalId | ✖ |
| M14 | 不落审计 | ✖ |
| M16 | 不 await 写门面 | ✖ |
| M18 | dispatch 不看方法 | ✖ |

M10/M11（三条路径全落到 `comments`）被咬住了 —— 但那只是因为既有判据里**恰好有**
一条用了 `isEvidence`。**"恰好有一条用例碰过"与"这一族被判据守着"是两件事。**

⇒ 补 `team-hub/comment-routes.test.mjs`（**11 例**）。

### 1.1 ★★ 这次是**先量后写**，11 例一次全绿

切片 20 的教训（我照注释想象出一个 `kind` 字段，那是**汇编器**的读数）这次没有重演：
先把三列的形状、优先级、两条错误文案、审计动作序列**全部打印出来**，再照着写断言 ⇒ 11/11 一次过。

量出来四件**不看就写错**的事：

| # | 量出来的事实 | 不量会怎样 |
| --- | --- | --- |
| ① | 批注条目是 `{by, at, text}` | 会去断言 `note` / `content` |
| ② | **`kind:'feedback'` 压过 `isEvidence:true`** | 会把优先级写反，然后**去改产品** |
| ③ | **`id` 不 trim**：只含空格的 id 通过"非空"检查、死在 `未知任务    ` 上 | 会以为它和 `text` 一样会 trim |
| ④ | 空 id 是 `缺少参数 id`，空格 id 是 `未知任务    ` —— **两条不同的文案** | 会把两种坏法当成一种 |

> 一个"我知道这一族长什么样"的判据，与一个"我记得的是**另一族**的形状"的事实，
> 在我不去把它打出来看一眼的时候是同一个东西。

### 1.2 ★★ ③④ 值得单独说：同一个字段的两种"坏"

`id` 用的是 `id.length === 0`，而 `text` 用的是 `text.trim().length === 0`。
于是：

```
id = ''      → 400 「缺少参数 id」      （我忘了传）
id = '   '   → 400 「未知任务    」      （传了，但不在）
text = '   ' → 400 「缺少参数 text」     （trim 之后算没给）
```

这不是不一致，而是**两条不同的判断**：

- `text` 是**内容**，"全是空格"等于没内容 ⇒ 归到"没给"；
- `id` 是**标识**，"全是空格"是一个**合法形状的标识**（只是不存在）⇒ 归到"查不到"。

调用方靠这两句话区分"我忘了传"和"这个任务不在"。本片**把它钉住**（⑦），
但**没有去"统一"它** —— 那是产品语义的事，不是搬家的事。

---

## 2. 破验终局：**19/19 咬住**（真缺口 0，可证等价 0）

逐字节还原 ✔、还原后复绿 ✔。这是十八片以来第一个**满咬合**的切片 ——
不是因为它特别，而是因为这一族的**专属判据补齐之后**，19 条变异里再没有"没人管"的角落。

★ **其中 M16（不 await 写门面）与切片 20 是同一条**，判据也是同一个写法：
直接调工厂、注入一个会抛的 `handleWrite` 桩、断言 `dispatch` **必须 reject**。
happy path 上有没有 `await` 看起来一样；差别只在 `handleWrite` 的 catch 块里
那句 `json(...)` 也抛的时候（比如客户端已断开）——那时没有 await 就是**未处理的 promise**，
Node 15+ 默认**直接杀掉进程**。

---

## 3. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7379 | **7371**（−8；`+8/−16`） | 9221（累计 **−1850**） |
| `handle()` 路由条件（抽取器口径） | 101 | **100** | 191 |
| `router.dispatch` 调用点 | 19 | **20** | 0 |
| `routes/` 族模块 | 19 | **20** | 0 |

**100 剩余 + 88 已搬 = 188** ✓ · 被删区间 **16 行**（注释 **3**、路由 1），**丢注释 0 / 丢代码 0**

★ 这 3 行注释正是 PRT-404 的来龙去脉（"三条路径共用一个写入口是有意的：
它们都是'往任务的某个批注列追加一条'，分成三个路由只会把同一段校验抄三遍"）——
本片要保的就是它，而**判据要守的正是这句话描述的行为**（三列不能混）。

---

## 4. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 20 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 19 族读数未变** |
| 无跨族遮蔽（`/api/comment` 无前缀冲突） | ✅ |
| **自由标识符常设判据** | ✅ 20 模块 / 未绑定 0 |
| 破验 | ✅ **19/19 咬住**，真缺口 0、可证等价 0 |
| `comment-routes`（本片新判据） | ✅ **11/11** |
| 既有判据 `team-hub-parity` / `v1v2-contract` | ✅ 1/1、17/17 |
| 既有判据 `orchestrator/worker/sources-loader.test.mjs` | ✅ **58/58** |
| 全量回归 | ✅ **54 套件 / 939 例 / 939 pass / 0 fail**（+1 套件、+11 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 88 / sources 38 / 族 20） |

★ `sources-loader.test.mjs` 住在 `orchestrator/worker/` 下，**不在**我那把
`team-hub/*.test.mjs` 的全量回归选择器里 —— 而它是本族 5 个请求点的判据。
**这不是本片引入的问题，是本片发现的**：那把选择器的口径是"目录"而不是"判据"，
所以它对这条路径的覆盖一直是靠人记得单独跑。本片单独跑了它（58/58 ✔），
但**没有去改那把选择器** —— 那是"把助手判据搬进仓内常设闸门"那件独立的事。

---

## 5. 本片**没有**做

- `/api/team-plans`（7 点 / 2 条）/ `/api/board`（5 点）等候选**未动**。
- **`/api/events`（77 行 / 6 点）仍未搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`），仍是**单独一片**。
- 域逻辑（`appendTaskNote` / `audit`）仍在原处，**只搬路由**。
- `id` 与 `text` 的 trim 口径**没有去"统一"** —— 量清楚、钉住了，但那是产品语义的事。
- 那把只按目录选套件的回归选择器**没有改**（见 §4 末）。
- 助手判据仍住在 `.worktrees/_prt-handoff/`（含本片新增的 `probe21-comment.mjs`），**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **100** 条条件仍在 `handle()`。

---

## 6. 复现命令

```powershell
node .worktrees/_prt-handoff/probe-candidates.mjs /api/comment
node .worktrees/_prt-handoff/probe21-comment.mjs   # 先量形状（三列 / 优先级 / 两条文案）
node .worktrees/_prt-handoff/gen-family.mjs comment
node .worktrees/_prt-handoff/wire-family.mjs comment /api/comment createCommentRoutes
node .worktrees/_prt-handoff/register-family.mjs comment a0ae72d /api/comment team-hub/routes/comment.mjs createCommentRoutes
node .worktrees/_prt-handoff/register-baseline.mjs comment team-hub/routes/comment.mjs comment createCommentRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node .worktrees/_prt-handoff/mutate-slice21.mjs
node --test team-hub/comment-routes.test.mjs
node --test orchestrator/worker/sources-loader.test.mjs
```
