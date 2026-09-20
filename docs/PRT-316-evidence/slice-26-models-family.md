<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 26：第二十五族 = 智能体默认模型配置（`/api/models` 三条）—— 又挖出一条真缺陷：**警告被丢掉**

- **族**：`models`（`team-hub/routes/models.mjs`），**3 条**：
  - `GET /api/models`（读一版，可按 scope 过滤）
  - `POST /api/models`（配一个 —— PRT-252 产品化校验 + 结构化错误）
  - `POST /api/models/clear`（清一个）
- **参考提交**：搬走前 `f889921`
- **规模**：42 行、3 条、**外来 0**、**分段 1**（干净三条目里行数最少的那一组之一）

---

## 1. 为什么挑它

按上一片新画的"前缀组"地图，干净的多条组按条数排是
`/api/exec`（5 条，切片 25 已搬）、**`/api/models`（3 条 / 42 行）**、`/api/web`（3 条 / 80 行）、
`/api/model-migration`（2 条）、`/api/skill-source`（2 条）。

挑 `/api/models` 的两个理由：

1. **前缀不撞车**（这一条是量过的，不是看出来的）：
   `/api/model-bindings` 与 `/api/model-migration` **都不**以 `/api/models` 开头 ——
   第 11 个字符一个是 `/`、一个是 `-`。
2. 它守着 PRT-252 那套产品化校验，是本项目里**唯一**一处
   "配置错误必须在配置的那一刻、用用户能看懂的话说出来"的落地。

---

## 2. ★★ 本族搬走前**一把判据都没有**

`survey-judges2.mjs` 对三个路径全报 **"强判据 0 套、请求点合计 0"**。

而这一族守着一件**会静默地毁掉一次真实运行**的事（配了一个跑不起来的模型），
**从来没有被任何用例看过一眼**。

⇒ 与前几片一样，**先写判据、再破验**。19 条用例的形状全部是量出来的。

---

## 3. ★★★ 挖出一条真缺陷：契约明写不许存在的状态，**就在这条路由上**

`runtime/contracts/model-config.mjs` 的段首（L51）逐字写着：

> **不允许存在"看起来成功了但跑不了"的沉默状态。**

而同一个文件（L173-175）说它为此做了什么：

> ⑥ 通过了。但"合法"不等于"能跑"——把两件会**静默地**导致跑不起来的事
> 作为 warning 带出去（不拒绝，因为"先登记后补凭证"是合法顺序）。

### 3.1 它**确实**算出了警告 —— 量给你看

```
validateAgentModelSelection({ provider:'prov-c', model:'model-z',
                              profiles:[{provider:'prov-c', model:'model-z', hasCredential:false}] })
  ⇒ ok=true, code="MODEL_CONFIG_OK",
    warnings=[{ code:"MODEL_CONFIG_NO_CREDENTIAL",
                message:"模型档案「mp-nocred」还没有配置凭证，现在保存可以，但**运行会失败**。" }]
```

### 3.2 而路由把它**丢掉**了

```js
const verdict = validateAgentModelSelection({ provider, model, profiles: modelStore.list() })
if (verdict.ok !== true) throw modelConfigErrorFor(verdict)
// ★ 从这里往下，`verdict` 再也没有被读过
…
return { scope: targetScope, role, provider, model }     // ⇒ 回执里没有 warnings
```

量出来的回执（`mp-nocred` 的 `secret_ref` 是 `NULL`）：

```
POST /api/models {by, role:'r-nocred', provider:'prov-c', model:'model-z'}
  ⇒ 200 {"ok":true,"task":{"scope":"default","role":"r-nocred","provider":"prov-c","model":"model-z"}}
                              ↑ task 恰好四格，`warnings` **连键都没有**
```

**用户看到 200，跑的时候才发现没凭证** —— 正是契约禁止的那个状态。

### 3.3 ★ 而唯一会用警告的那个函数，**只挂在失败路径上**

`describeModelConfigResult` 的整个存在意义就是"把校验结果压成一行给 toast 用，**警告也一并带出**"。
它有**用例守着**：

```js
// runtime/contracts/model-config.test.mjs
assert.match(describeModelConfigResult(warned), /运行会失败/)
```

而它**只被 `modelConfigErrorFor` 调用一次**，`modelConfigErrorFor` 又只在
`verdict.ok !== true` 时被调用 —— 而警告只在 `ok === true` 时存在。

**两根线接不上。** 那个警告分支在这条链上是**死代码**：

> 一个"警告这条路径有用例守着"的印象，与一个"那条用例**直接调函数**、
> 而没有任何路由会把一个带警告的结果递进去"的事实，
> 在我把"有用例"当成"接线了"的时候是同一个东西。
>
> 那条用例证明的是**函数**对；缺口在**那根线**上。

### 3.4 这是第三个同族缺口，但**比前两个更强**

| 切片 | 缺陷 | 强度 |
| --- | --- | --- |
| 22 | `limit=2.7` → 500 | 输入校验 |
| 24 | `code: CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND` 键名错 ⇒ `undefined` 被丢掉 | 回执字段静默消失 |
| **26** | **契约明写不许存在的"沉默成功"，就发生在这条路由上** | **有明文契约 + 有单测守着却仍断线** |

**验过不是我引入的**：`git show 2f5a4b3:team-hub/server.mjs` L7843 与
`git show f889921:team-hub/server.mjs` L6147 逐字相同（生成器逐字抄体，把缺陷一起抄来）。

**本片只钉住现状、不修**（同切片 22、24 的处理）：修它属产品语义变更。
判据写成了**双向**的 —— 见 §5 的 M21。

---

## 4. 其余量出来的事实（全部进了判据）

| 事实 | 读数 |
| --- | --- |
| 读是**裸数组** | 每行恰好 `{scope, role, provider, model}` —— 库里那张表有 `updatedAt`，**这条 SELECT 没选它** |
| `?scope=` | 过滤；未知空间给 `[]`（**不 404**） |
| 写要 `body.by` | 缺了 → 400，且**什么都没写进去** |
| `role` | 会 trim；缺/全空白 → 400「缺少参数 role」 |
| `provider`/`model` | 缺一不可 → 400「缺少 provider 或 model」 |
| ★ 四条校验档 | 空库 `NO_PROFILES`（**不是**"未知供应商"）· 未知供应商 `UNKNOWN_PROVIDER`（`field=provider`，**点名本机登记过的**供应商）· 未知型号 `UNKNOWN_MODEL`（候选**只列该供应商下**的型号）· 通过 |
| `scope` | 缺/全空白 → `'default'`；给了会 trim |
| upsert | `ON CONFLICT(scope, role)` ⇒ 只留一行、取后写的 |
| `clear` | **幂等**（清不存在的也 200）；**限定 scope**（不然清一个角色会误伤所有空间） |

★ **一个易错点**：库里**先**得有档案，才走得到"配得上去"那条路 ——
一个档案都没有时校验器一律给 `NO_PROFILES`。
我第一版把造档案放进了用例 ⑧，于是它**前面**的 ②③⑤⑦ 全红。
**修法是把播种挪进 `before()`**，不是放宽断言。

---

## 5. 破验：**21/21 咬住**（真缺口 0，可证等价 0）

第一次跑是 **20/21**，`M8`（删掉 `if (!provider || !model)`）**没咬住**。

### 5.1 ★ M8 是真缺口，但缺口在**我的断言**上，不在产品上

我原来的断言只有一句：`assert.match(r.body.error, /provider|model/)`。

而校验器在 provider/model 为空时给的是
`MODEL_CONFIG_EMPTY_SELECTION`，文案是 **"没有选择模型：缺少 provider/model"** ——
**也含这两个词**。于是把守卫删掉之后，请求**换了一条路被拒**，
错误文案仍然匹配，断言通过。

两条拒绝路径真正的差别在**信封**上：

| 路径 | 回执 |
| --- | --- |
| 手写守卫 `throw new Error('缺少 provider 或 model')` | 只有 `{error}` —— **没有 code/field/hint** |
| 校验器 `modelConfigErrorFor(verdict)` | 带 `code` / `field` / `hint` / `candidates` |

**修法**：给用例 ⑥ 补上"这一档**不带** `code`/`field`/`hint`"三条断言。
补完再跑 ⇒ **21/21**。

> 一个"我把缺参数的情况也断言过了"的印象，与一个"我的正则同时匹配了**另一条**路径的文案、
> 于是把它删掉也不会红"的事实，在我只比那一句话的时候是同一个东西。

### 5.2 ★ M21 是**反方向**的：把警告接出来（＝修对了）**必须**让判据变红

```js
// M21：return { … } ⇒ return { …, warnings: verdict.warnings }
✔ 咬住  M21 ★★★ **把警告接出来**（＝修对了）—— 钉住现状的判据应当因此变红
```

一条**只会因"改坏"而变红**的判据，与一条**"改对了也变红"**的判据，
区别就在这里 —— 后者才说明它真的钉住了**现状**。

### 5.3 21 条变异里最要紧的几条

| 变异 | 表现 |
| --- | --- |
| M11 | ★★ `if (verdict.ok !== true)` 关掉 ⇒ **跑不起来的绑定也存进去** |
| M12 | `profiles: []` ⇒ 永远 `NO_PROFILES` |
| M13 | ★★ 候选换成**前端那份硬编码表** ⇒ PRT-252 要修的那个缺口**原样复活** |
| M16 | ★★ `DELETE` 不限定 `scope` ⇒ 清一个角色**误伤所有空间** |
| M5/M6 | `?scope=` 不过滤 / 过滤反了 |
| M4 | 回执多带一列 `updatedAt`（形状变了） |
| M14 | upsert 变普通 INSERT |
| M19/M20 | `dispatch` 不看方法 / 先认领再执行 |

逐字节还原 ✔、还原后复绿 ✔。

---

## 6. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7280 | **7247**（−33；`+10/−43`） | 9221（累计 **−1974**） |
| `handle()` 路由条件（抽取器口径） | 89 | **86** | 191 |
| `router.dispatch` 调用点 | 24 | **25** | 0 |
| `routes/` 族模块 | 24 | **25** | 0 |

**86 剩余 + 102 已搬 = 188** ✓ —— **已搬过 54%**（102 / 188 = 54.3%）
被删区间 **42 行**（注释 6、路由 3），**丢注释 0 / 丢代码 0**

★ 顺手清掉一行**孤儿注释**：`wire-family` 的区间是从**第一条路由**起算的
（上扫在本族正上方那道"别人的接缝"就停了），所以路由上方那行
`// 智能体默认模型配置` **没进区间**、孤零零留在了新接缝上面，
而新接缝的正文说的正是同一件事。删掉（`+10/−43` 里的那个 `−1`）。

> 一个"注释跟着路由一起走了"的印象，与一个"我的区间是从**条件行**起算的、
> 所以紧挨在上面的那行说明不在区间里"的事实，
> 在我没有把写回后的那几行打出来看的时候是同一个东西。

---

## 7. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 25 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 24 族读数未变** |
| **自由标识符常设判据** | ✅ 25 模块 / 未绑定 0 |
| 破验 | ✅ **21/21 咬住**，真缺口 0、可证等价 0 |
| `models-routes`（本片新判据，本族**首个**判据） | ✅ **19/19** |
| 全量回归 | ✅ **59 套件 / 1018 例 / 1018 pass / 0 fail**（+1 套件、+19 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 102 / sources 43 / 族 25） |

---

## 8. 本片**没有**做

- `/api/web`（3 条 / 80 行，干净）、`/api/model-migration`（2 条）、`/api/skill-source`（2 条）—— 都留着。
- `/api/model-bindings`（前缀跨两个作用域，仍欠"拆族或加 `F.paths`"的裁决）。
- 纠缠族（`/api/runtime`、`/api/spaces`、`/api/skills`、`/api/goal`、`/api/documents`）与 23 个单条组**未动**。
- **`/api/events` 仍未搬**（写宿主可变计数，需要增量写回 `live.bump`）。
- ★ **切片 22 / 24 / 26 三条缺陷都没修**（本片只钉住现状）：
  `limit=2.7` → 500、`CONTEXT_PLAN_ERRORS` 键名错（含 `server.mjs` 里 `/api/team-plan` 那处）、
  **模型配置警告被丢掉**。三条都**该报给业主**。
- 域逻辑仍在原处（本族的表、`modelStore`、校验器都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；助手工具仍住在 `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **86** 条条件仍在 `handle()`。

---

## 9. 复现命令

```powershell
node .worktrees/_prt-handoff/group-remaining.mjs
node .worktrees/_prt-handoff/survey-judges2.mjs /api/models    # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe26-models.mjs               # 先量三条的真实形状
node .worktrees/_prt-handoff/gen-family.mjs models
node .worktrees/_prt-handoff/wire-family.mjs models /api/models createModelsRoutes
node .worktrees/_prt-handoff/drop-orphan-comment26.mjs
node .worktrees/_prt-handoff/register-family.mjs models f889921 /api/models team-hub/routes/models.mjs createModelsRoutes
node .worktrees/_prt-handoff/register-baseline.mjs models team-hub/routes/models.mjs models createModelsRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/models-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice26.mjs
```
