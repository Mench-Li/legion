<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 30：剩下 79 条的**真实形状** —— 族不是前缀，是**区间**（附：生成器可复现性缺口）

- **本片是工具片**：不改 `server.mjs`、不搬路由，只把"剩下的搬不动"这件事查清楚，并把缺的那件能力做出来。
- **参考提交**：`87abae3`（切片 29 后）
- **进度**：已搬 **109** / 188（58.0%），剩 **79** 条。

---

## 1. 为什么停下搬运来查一次

切片 29 之后，`/api/model-bindings` 与 `/api/runtime` 两个"大块头"都被判为**搬不动**。
按"一片一次对拍"，我需要知道：**剩下的 79 条到底长什么样、还有几个能一个区间搬走。**

于是写了两个探针（`.worktrees/_prt-handoff/shape-probe.mjs`、`cluster-probe.mjs`），
判据是"**区段内没有别的族、没有 `router.dispatch` 接缝**"。

### 1.1 结果：79 条被接缝切成 **14 个连续簇**，32 个前缀组

| 条数 | 行数 | 路径 |
| --- | --- | --- |
| 15 | 270 | `/api/progress` `/api/patch` `/api/review-notes` `/api/artifact` … 共 15 种 |
| 14 | 489 | `/api/spaces` `/api/pipeline` `/api/goal` … 共 14 种 |
| 11 | 147 | `/api/runtime/reconciliations` `/api/claim` `/api/transition` … 共 11 种 |
| 8 | 119 | `/api/board` `/api/task` `/api/missions` `/api/scopes` … 共 8 种 |
| 7 | 107 | `/api/runtime/run-budget/may-switch-model` `/api/runtime/validate` … 共 7 种 |
| 6 | 85 | `/api/runtime/run-budget/{reserve,observe,settle,resolve}` + 两条 |
| 6 | 101 | `/api/skills/{register,review,grant,revoke}` `/api/documents{,/delete}` |
| 3 | 19 | `/api/model-bindings` `/api/model-bindings/resolve` |
| 2 | 13 | `/api/model-bindings/<scope>/<role>` ×2 |
| 2 | 47 | `/api/task-feedback` `/api/heartbeat` |
| 2 | 65 | `/api/roster` `/api/overlaps` |
| 1 | — | `/api/team-plan` · `/api/activity` · `/api/artifact/content` |

### 1.2 ★★★ 没有任何一个前缀能干净圈住剩下的**任何一簇**

两个量出来的实例：

```
前缀 /api/model-bindings        ⇒ 多捞 /api/model-bindings/resolve（在接缝另一侧）
前缀 /api/runtime/run-budget    ⇒ 多捞 /api/runtime/run-budget/may-switch-model（在接缝另一侧）
```

前缀取样是 `path.startsWith(prefix) || path === prefix`，它**看不见接缝**；
而"接缝"才是这段代码真正的分界。

> 一个"族就是一个前缀"的印象，与一个"前缀只是**恰好**能圈住前 28 族"的事实，
> 在我没有数一下"还剩下几个前缀能圈住"的时候是同一个东西。

---

## 2. 新增能力：`F.paths`（显式路径表）+ **D 段两道断言**

族的真正定义是**一段连续区间**：`router.dispatch` 接缝把 `handle()` 切成簇，一簇＝一个天然可搬单位。
于是给生成器开一条 `paths: [...]` 的路子（`gen-family.mjs`）。

★ 显式表有个前缀**没有**的风险：**中间可能夹着没被选中的条件** ——
那正是"搬走一半、表面全绿"的事故形状。所以加了 D 段，把三件事**当断言查**：

| 查什么 | 为什么 |
| --- | --- |
| ① 区间内每一个 `if (method && path…)` 都必须在取到的表里 | 防"静默少搬一族" |
| ② 区间内不许有 `router.dispatch` 接缝 | 接线是"一个区间整段替换成一个接缝"⇒ 有内嵌接缝就会把它**一起删掉** |
| ③ 相邻两条不重叠、首尾就是第一条/最后一条 | 防"取了中间一段" |

★ ② 这条不是假想：`wire-family.mjs` 的 `L.splice(start, end - start, ...NEW)` 就是**整段替换**，
而它原有的守卫只数**条件条数**、**数不到接缝** —— 这是一个此前没有被覆盖的洞。

### 2.1 ★ 第一版把两个"起点"混成一个，四族当场误报

第一版用 `sectionCommentStart(第一条路由)` 作为区间的起点。而那个函数**向上扫过 `//` 注释块**，
于是会扫进**上一个族的接缝注释**（`// ── … 已提取到 …`），区间起点正好落在接缝那一行 ⇒
`connectors` / `packs` / `role-packs` / `usage` 四族全部误报"区间里夹着接缝"。

**改正**：拆成两个起点 ——

- `headStartLine`：段首说明起点，**向上扫过注释块**（用于"取前言"）
- `spanStartLine`：代码区间起点，就是第一条路由那一行（用于"查夹带/查接缝"）

> 一个"我的区间从段首说明开始"的印象，与一个"那段说明其实**是上一个族的接缝注释**"的事实，
> 在我没有把"取前言"和"查夹带"这两件事用同一个起点去做的时候是同一个东西。

改正后四族全部通过。

---

## 3. ★★★ 顺手量出来的第二个缺口：生成器**不可复现**

我把 28 个已提交的族模块逐个"生成器重跑 + 逐字节比 + 恢复原字节"（`.worktrees/_prt-handoff/check-gen-regression.mjs`）。
**全程不碰 git** —— `git checkout` 会按 `core.autocrlf=true` 把文件重新物化成 CRLF，那种"差异"是工具造的。

| 结果 | 数量 | 说明 |
| --- | --- | --- |
| 归一 EOL 后**一字不变** | **19 / 28** | 生成器确实是**构造**出来的 |
| 只差 EOL | 4 | `automation` `config` `packs` `secrets` —— git 物化出来的 CRLF |
| **有内容漂移** | **5** | `calendar` `compaction` `connectors` `experience` `tool-calls` |
| 生成器**认不出** key | **4** | `chat` `permissions` `rules`（无条目）+ `model-profiles`（生成期自检失败） |

**5 个漂移族的漂移内容全是"后续生成器特性"**（量过，不是猜的）：

- `calendar`（切片 4）· `compaction`（切片 5）：模块头部的说明文字被后续版本**重写**过，
  并多出「## 本族 N 条的形态分布」那一节。
- `connectors`（切片 12）· `experience`（切片 8）· `tool-calls`（切片 11）：
  缺「原文的子段说明（N 行，逐字搬来、未改写）」那一块 —— 正是台账里记着的
  **切片 1～5 注释丢失**那一类的**工具侧**成因。

⇒ **"逐字保真应该是构造出来的"这条承诺，目前只对 19/28 族成立。**
其余 9 族的模块里有**生成器复现不出来的字节**。它们不是错的（全部经过对拍+门禁+回归），
但"能不能重跑生成器验一遍"这件事，在那 9 族上**等于没有**。

★ `model-profiles`（切片 13）更直接：生成器自己的 `生成期核对失败` 自检**当场抛错**，
而那一族的模块在仓库里是好的 ⇒ 是**生成器**与**模块**已经对不上了。

> 一个"生成器能重建这些模块"的印象，与一个"9 族里有生成器复现不出来的字节、
> 其中一族连生成都过不去"的事实，在我没有把 28 族**逐个重跑一遍并逐字节比**的时候是同一个东西。

### 3.1 为什么本片可以确认"漂移不是本片造成的"

本片对生成器的改动一共 5 处，其中只有 2 处会进到**输出字节**里（两行注释文案），
而它们在 `F.paths` 缺席时求值结果与改前**逐字相同**；其余 3 处只改**控制台输出**或**抛错**。
所以本片**不可能**改动任何非 `paths` 族的输出 —— 上面那 9 族是**先前就有的**漂移。

这条不是"我觉得"，是可以逐处对照的：`inFamily` 的 `F.paths` 分支不生效、
`FAMILY_LABEL` 只在 `console.log` 里、D 段只在 `throw` 里。

---

## 4. 本片**没有**做

- ★★★ **一条路由都没搬**（本片是工具片）。
- ★★★ `scope` 那个归一缺陷（切片 29）**依然没修** —— 待业主裁决。
- ★★ 生成器那 9 族的漂移**没有修**（修它要决定"以生成器为准还是以模块为准"，属工具治理）。
  `model-profiles` 的 `生成期核对失败` 也**没有查下去**。
- ★ 定形信封（`err.plan`/`err.migration`）、`limit=2.7` 那一个形状三处、
  `CONTEXT_PLAN_ERRORS` 键名错、模型配置警告被丢、`null` 与"没给"落成两个值 —— 都没修。
- 助手工具仍住在 `.worktrees/_prt-handoff/`（**不进仓库**）；那把只按目录选套件的回归选择器**没有改**。
- 块前言与裸块（`model-profiles` 那种共享局部）的搬法**没有动**。

---

## 5. 下一步（切片 31 起）

能力已经就位，剩下 79 条按**簇**推进，每簇一片、各自独立对拍+破验+可回滚：

1. **6 条 / 85 行** `/api/runtime/run-budget/*`（唯一"名字像一族"的簇）
2. **6 条 / 101 行** `/api/skills/{register,review,grant,revoke}` + `/api/documents{,/delete}`
3. **8 条 / 119 行** `/api/board` `/api/task` `/api/missions` `/api/scopes` …
4. **11 条 / 147 行**（`/api/claim` 那一簇）
5. **7 条 / 107 行**（`/api/runtime/validate` 那一簇）
6. **2 条 / 13 行** `/api/model-bindings/<scope>/<role>`（同簇里那 3 条 exact 先走）
7. **5 条 / 80 行** `/api/model-bindings` 整体（★ 第 3 条与 2 条 prefix 之间**夹着 model-migration 的接缝** ⇒
   需要分成两簇，或确认模型迁移那一族已搬走、接缝位置稳定）

⚠️ 每簇都要先跑 `shape-probe.mjs` + D 段，确认"区间内除本族外一条条件都没有"。

---

## 6. 复现命令

```powershell
node .worktrees/_prt-handoff/shape-probe.mjs /api/runtime        # ⇒ 16 个接缝、6 条别的族 ⇒ 搬不动
node .worktrees/_prt-handoff/cluster-probe.mjs                   # ⇒ 79 条被切成 14 个连续簇
node .worktrees/_prt-handoff/check-gen-regression.mjs            # ⇒ 归一 EOL 后 19/28 一字不变
node .worktrees/_prt-handoff/show-gen-drift.mjs calendar compaction connectors experience tool-calls
node .worktrees/_prt-handoff/gen-family.mjs model-profiles       # ⇒ 生成期核对失败
```
