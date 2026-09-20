<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 20：第十九族 = `/api/create`（建任务，1 条）—— 破验 7/16 逼出一整套族专属判据

- **族**：`create`（`team-hub/routes/create.mjs`），1 条路由：`POST /api/create`（精确）
- **参考提交**：搬走前 `b952854`
- **为什么是它**：切片 19 之后，`rank3` 的订正版读数里它的**请求点最多**（10 点），
  体量最小（16 行）、无外来条件、无可变绑定、无顶层声明 —— 单位风险的产出最高。

---

## 1. 选族：两把尺子都先被自己的判据打回一次

### 1.1 `probe-candidates.mjs` 第一版只数出 **4** 条条件（实际 102）

我把 rank3 里**两条**分开的正则合成了一条：

```
path\s*(?:===|\.startsWith)\(   ← 要求 `===` 后面跟 `(`
```

而 `path === '…'` **后面没有括号**，只有 `path.startsWith('…')` 才有。

> 一个"我把两种路径比较都认了"的判据，与一个"只认了带括号那种"的正则，
> 在我要匹配的那一族恰好是精确路由的时候是同一个东西。

实测：109 → **5**。分开写之后恢复 102 ✓。
**这就是为什么 §1.2 那个"候选表"值得先跑一遍**：不先量就会照着错的读数挑族。

### 1.2 订正后的候选表

| 族 | 位置 | 体量 | 条件 | 外来条款 | 请求点 |
| --- | --- | --- | --- | --- | --- |
| **`/api/create`** | L5080-5095 | **16 行** | 1 | 0 | **10** |
| `/api/comment` | L6101-6116 | 16 行 | 1 | 0 | 8 |
| `/api/team-plans` | L5436-5456 | 21 行 | 2 | 0 | 7 |
| `/api/board` | L6271-6279 | 9 行 | 1 | 0 | 5 |
| `/api/events` | L7175-7251 | **77 行** | 1 | 0 | 6 |

### 1.3 ★ `/api/events` 被**写回**问题挡住（不是这一片的事）

它读**同一个** `deliveryBookkeepingFailures`，但**不只读** —— L7239 是 `deliveryBookkeepingFailures += 1`。
切片 19 的活绑定是**只读**的，按它搬会得到一个更坏的结果：
自增落在模块局部的副本上，宿主的计数**永远不涨**，而 `/api/config` 的读数**永远是 0**。

要搬它得给机制加**写回**，且必须是**增量**写回而不是终值写回：

> 一个"把最终值写回"的同步，与一个"把增量写回"的同步，在只有一个请求在跑的时候是同一个东西 ——
> 只不过前者会在两个请求交错时**丢掉一次自增**（A 读到 0、B 读到 0、各加 1、各写回 1 ⇒ 结果 1 而不是 2）。
> 增量是可交换的，终值不是。

那是**接缝能力的一次扩张**（`live` 要长出 `bump`），值得单独一片 ⇒ 本片不碰它。
本片也不因此停住：**同一份候选表里就有 4 个不需要新机制的族**。

---

## 2. 破验：第一轮 **7/16**，9 条真缺口

既有判据（`v1v2-contract` / `team-hub-parity` / `context-replay-run`）只钉住：
`{ok:true, task}` 的形状、公开字段两端一致、以及"没有 title 要 400"。
**其余全是没人管的**：

| 变异 | 是什么 | 第一轮 |
| --- | --- | --- |
| M1 | 只挡空串、不挡**全是空格** | ✖ 缺口 |
| M2 | 非字符串 title 不再拦 | ✔ |
| M3 | 报错文案改了 | ✔ |
| M4 | 存进去的 title 不再 trim | ✖ |
| M5 | **丢掉 scope**（任务落到错误的范围） | ✖ |
| M6 | **丢掉 goalId**（任务与目标脱钩） | ✖ |
| M7 | `docSync` 不再要求字面 true | ✖ |
| M8 | 丢掉 blockedBy | ✖ |
| M9 | 丢掉 acceptance | ✔ |
| M10 | 不落审计 | ✔ |
| M11 | 审计丢掉 goalId | ✖ |
| M12 | 不返回建好的任务 | ✔ |
| M13 | **不 await 写门面** | ✖ |
| M14 | path 多一个字符 | ✔ |
| M15 | dispatch 不看方法（GET 也能建任务） | ✖ |
| M16 | dispatch 先认领再执行 | ✔ |

⇒ **9 条真缺口**：这一族**没有**专属判据。于是补 `team-hub/create-routes.test.mjs`（**10 例**）。

### 2.1 ★ M13 是"只在没人走过的那一路上可观测"

`await handleWrite(...)` 去掉之后，happy path 看起来**完全一样** ——
`handleWrite` 内部有完整的 try/catch，自己会把错误写成 400，响应照样出去。

差别只在**它 catch 块里那句 `json(...)` 也抛**的时候（比如客户端已经断开）：
有 await ⇒ 异常沿 `run` → `dispatch` 传出来；
没有 await ⇒ 变成**未处理的 promise**，在 Node 15+ 默认**直接杀掉进程**。

> 一个"这段代码有没有 await 看起来一样"的判据，与一个"差别只在这一路上没人走过"的事实，
> 在我只跑 happy path 的时候是同一个东西。

判据做成**确定性的**：直接调工厂、注入一个会抛的 `handleWrite` 桩，
断言 `dispatch` **必须 reject**。去掉 await 时它 resolve ⇒ 咬住 ✓。

### 2.2 ★★ 两条**可证等价**（而且理由在**另一个函数**里）

M4（不 trim）与 M7（不严格判 docSync）都咬不住。根因不在路由层：

| 变异 | 证据 |
| --- | --- |
| M4 | `createTaskInTx` 里 `title: input.title.trim()` —— **又 trim 了一次** |
| M7 | `createTaskInTx` 里 `docSync: input.docSync === true` —— **又判了一次** |

⇒ 路由层这两句是 **dead store**（冗余的纵深防御，不是缺口）。

**但要注意 M1 与 M7 的区别**：M1 打的是**校验**用的 `title.trim().length`，
那一层**没有**兜底（`createTaskInTx` 只管存，不管"是不是空的"）⇒ M1 是真缺口、已被咬住。
**同一个 `.trim()` 出现在两个位置，一个可观测、一个不可观测** —— 不去分辨就会把两条当成一类。

### 2.3 ★ 量出来一条与直觉相反的字段

草稿里我本来要断言"`fileDomain` 存下来了"。量出来是：

```
传入 fileDomain: 'fd'  →  回执 null   读回 null
```

⇒ 路由体里那句 `fileDomain: body.fileDomain` 是**惰性**的，
改掉它**没有任何可观测差别**。不先量就会为它写一条**永远不可能失败**的断言。

> 一个"我知道这个字段存下来了"的判据，与一个"这个字段在本层根本没被采纳"的事实，
> 在我不去把它读回来打印一次的时候是同一个东西。

---

## 3. 破验终局：**14/16 咬住**，真缺口 0，可证等价 2

逐字节还原 ✔、还原后复绿 ✔。

---

## 4. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7387 | **7379**（−8；`+8/−16`） | 9221（累计 **−1842**） |
| `handle()` 路由条件（抽取器口径） | 102 | **101** | 191 |
| `router.dispatch` 调用点 | 18 | **19** | 0 |
| `routes/` 族模块 | 18 | **19** | 0 |

**101 剩余 + 87 已搬 = 188** ✓ · 被删区间 **16 行**（注释 0、路由 1），**丢注释 0 / 丢代码 0**

---

## 5. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 19 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 18 族读数未变** |
| 无跨族遮蔽（`/api/create` 无前缀冲突） | ✅ |
| **自由标识符常设判据** | ✅ 19 模块 / 未绑定 0 |
| 破验 | ✅ **14/16 咬住**，真缺口 0、可证等价 2 |
| `create-routes`（本片新判据） | ✅ **10/10** |
| 既有判据 `v1v2-contract` / `team-hub-parity` / `context-replay-run` | ✅ 17/17、1/1、8/8 |
| 全量回归 | ✅ **53 套件 / 928 例 / 928 pass / 0 fail**（+1 套件、+10 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 87 / sources 37 / 族 19） |

★ 门禁再一次**先于**我做完：`register-baseline.mjs` 因一句写错的断言而**什么都没写**，
紧接着 `baseline-snapshot --record` 就以
`装配了未登记的路由族：createCreateRoutes ⇒ 它们的路由对基线不可见`
**退出 2** 并拒绝记录 —— 而不是安静地记下一份少一族的基线。

---

## 6. 本片**没有**做

- **`/api/events`（77 行 / 6 点）没有搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`）。那是接缝能力的一次扩张，**单独一片**。
- `/api/comment`（8 点）/ `/api/team-plans`（7 点）/ `/api/board`（5 点）等候选**未动**。
- 域逻辑（`createTask` / `createTaskInTx` / `audit`）仍在原处，**只搬路由**。
- `fileDomain` 那一句是惰性的（量出来的事实），**没有**去改它 —— 那是产品语义的事，
  不属于"搬家"；本片只是**不再为它写假断言**。
- 助手判据仍住在 `.worktrees/_prt-handoff/`（含本片新增的 `probe-candidates.mjs` /
  `register-baseline.mjs`），**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **101** 条条件仍在 `handle()`。

---

## 7. 复现命令

```powershell
node .worktrees/_prt-handoff/probe-candidates.mjs /api/create /api/comment /api/events
node .worktrees/_prt-handoff/gen-family.mjs create
node .worktrees/_prt-handoff/wire-family.mjs create /api/create createCreateRoutes
node .worktrees/_prt-handoff/register-family.mjs create b952854 /api/create team-hub/routes/create.mjs createCreateRoutes
node .worktrees/_prt-handoff/register-baseline.mjs create team-hub/routes/create.mjs create createCreateRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node .worktrees/_prt-handoff/probe20-create.mjs   # 量形状（先量再写断言）
node .worktrees/_prt-handoff/mutate-slice20.mjs
node --test team-hub/create-routes.test.mjs
```
