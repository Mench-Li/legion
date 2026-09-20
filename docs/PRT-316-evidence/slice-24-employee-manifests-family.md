<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 24：第二十三族 = 岗位清单三件套 —— 顺带挖出**一条真缺陷**和**一个抄了两份的边界算法**

- **族**：`employee-manifests`（`team-hub/routes/employee-manifests.mjs`），**3 条**路由：
  - `GET /api/employee-manifest`（读一份，要 `scope` + `role|employeeId`）
  - `GET /api/employee-manifests`（列一版，`scope`/`limit`）
  - `POST /api/employee-manifests`（存一版，走 `handleRun`）
- **参考提交**：搬走前 `df698a6`
- **为什么是它**：§0 的"剩下 98 条都在哪"读数说 **86 个路径 / 98 条条件**、
  "一个前缀 = 一族"已经用完。这一族是那次扫描里**少见的、真的内聚的多条族**：
  三条全走 `contextPlanStore()`，而且**单数前缀就能把复数一起收进来**
  （`'/api/employee-manifests'.startsWith('/api/employee-manifest')` 为真，反过来为假）——
  于是不需要给接缝加新能力就能一片搬完。

---

## 0. 一片开工前的读数（上一轮那张地图的兑现）

```
剩余方法条件合计 98 条，涉及 86 个不同路径字面量
```

我在上一片的结论里写"`F.paths`（显式路径集）大概率是下一步绕不开的"。
**这一片证明它可以再等一等**：`/api/employee-manifest` 这个前缀
恰好同时是单数路由的精确路径、又是复数两条的前缀 ⇒ 一族三条、零机制改动。
（`F.paths` 仍然欠着 —— 见 §7 的两族。）

---

## 1. ★★★ 一条**真缺陷**：`code` 是 `undefined`，而它被 `JSON.stringify` 静默丢掉了

`GET /api/employee-manifest` 找不到时，源码写的是：

```js
json(res, 404, {
  ok: false, code: CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND,
  error: `空间 ${scope} 里没有 ${role ?? employeeId} 的岗位清单`,
  serverTimeMs: Date.now(),
})
```

**量出来的实际回执**：

```json
{"ok":false,"error":"空间 nowhere 里没有 dev-4 的岗位清单","serverTimeMs":1789908255839}
```

**没有 `code`。** 原因是键名写错了 —— `CONTEXT_PLAN_ERRORS` 的键叫
**`MANIFEST_NOT_FOUND`**，它的**值**才是字符串 `'EMPLOYEE_MANIFEST_NOT_FOUND'`：

| 常量键 | 值 |
| --- | --- |
| `PLAN_NOT_FOUND` | `'TEAM_PLAN_NOT_FOUND'` |
| `PLAN_INVALID` | `'TEAM_PLAN_INVALID'` |
| `MANIFEST_NOT_FOUND` | `'EMPLOYEE_MANIFEST_NOT_FOUND'` |
| `MANIFEST_INVALID` | `'EMPLOYEE_MANIFEST_INVALID'` |
| `SCOPE_UNKNOWN` | `'CONTEXT_SOURCE_SCOPE_UNKNOWN'` |

于是 `CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND` === **`undefined`**，
而 `JSON.stringify` 会把 `undefined` 的键**整个删掉** ⇒ 回执里那一格凭空消失。

> 一个"我写了 `code: <那个码>`"的判据，与一个"那个键名根本不存在、
> 于是 `undefined` 被 `JSON.stringify` 静默丢掉"的事实，
> 在我**不把回执打出来、只看见源码里那行字**的时候是同一个东西。

### 1.1 ★ 它**不是本片引入的**

`git show df698a6:team-hub/server.mjs` 的 L5467 一字不差就是这个写法 ——
生成器是**逐字抄**的体，连缺陷一起抄过来了。全仓扫一遍，同型**共 2 处**：

| 位置 | 写法 | 正确键 |
| --- | --- | --- |
| `routes/employee-manifests.mjs:80`（本片搬的） | `CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND` | `MANIFEST_NOT_FOUND` |
| `server.mjs:5437`（**还没搬**的 `/api/team-plan`） | `CONTEXT_PLAN_ERRORS.TEAM_PLAN_NOT_FOUND` | `PLAN_NOT_FOUND` |

（全仓 `CONTEXT_PLAN_ERRORS.<key>` 引用 **35 处**，只有这 2 处键名是错的。）

### 1.2 为什么它躲了这么久：契约上那个码"存在"

`team-hub/config-schema.mjs` L474-475 把 `'TEAM_PLAN_NOT_FOUND'`、
`'EMPLOYEE_MANIFEST_NOT_FOUND'` 列成了**合法错误码**。
也就是说在契约里它是"有的"，只是这两条路由**永远发不出来**。

### 1.3 本片**只钉住现状，没有修**

处理方式与切片 22 的 `limit=2.7 → 500` 相同：**修它属于产品语义变更，不是搬家**。
判据写成"现状是**没有** `code`；若这条红了，说明有人把键名修对了 ——
请改成断言 `EMPLOYEE_MANIFEST_NOT_FOUND`，并顺手处理 `server.mjs` 里 `/api/team-plan` 那一处"。

> 一条**会因修复而变红**的断言，与一条**永远不可能失败**的断言，
> 区别就在这里 —— 前者把缺陷关在有人看着的格子里，后者把同一件事放进"没人走过"的格子。

**⇒ 这一条要报给业主**（`/api/team-plan` 那处还在 `server.mjs` 里，本片没资格碰它）。

---

## 2. ★★ 同一段区间算法抄了两份 ⇒ 它们**同时**错了，谁也不会先响

到这一片之前，两个工具的"往上找族首"都是：

```js
for (let i = first - 1; i >= 0; i--) {
  if (/^\s*if \(.*req\.method/.test(L[i])) break
  if (/^\s*\/\/ ── /.test(L[i])) { start = i; break }
}
```

而 `employee-manifest` 的**正上方恰好是 team-plans 的接缝**：

```
L5444  // ── 团队计划… 已提取到 ./routes/team-plans.mjs ──
L5445  if (await router.dispatch(req, res, { path, url })) return      ← 别人的接缝！
L5446  if (req.method === 'GET' && path === '/api/employee-manifest') {
```

`router.dispatch` 那行**既不是 `req.method` 行、也不是空行** ⇒ 上扫**穿过它**、
停在**属于 team-plans** 的分隔符上。

| 工具 | 后果 |
| --- | --- |
| `wire-family.mjs` | 区间会**真删掉** team-plans 的接缝（靠 ⑥ 号对拍 dispatch 22→21 才会响） |
| `check-region-lines.mjs` | 区间多算 3 行 ⇒ 报 **"丢注释 2 / 丢代码 1"**（**检查工具本身过期，产物是对的**） |

★ 关键在这一句：`check-region-lines.mjs` 文件头上写着
**"与 wire-family.mjs 同一套区间算法（刻意各写一份：两边不一致时要响）"** ——
而这次两边**一起**错了。所以它们不是"互为判据"，而是**同一个便利写法抄了两份**。

> 一个"两边各写一份就能互相校验"的设计，与一个"两边抄的是同一段、
> 于是会一起错"的事实，在这段算法从来没被第三种情况逼过的时候是同一个东西。

**修法**：两边同步加一条 `if (/router\.dispatch|createRouter\(/.test(L[i])) break`。
修完：

```
✔ employee-manifests 区间   47 行（注释   2，路由 3）  丢注释   0 / 丢代码 0
✅ 切片 6 起：被删区间里一行都没丢；代码行**23 族全部零丢失**
```

---

## 3. 破验：第一轮 **10/22**（12 条真缺口），终局 **21/22 咬住 · 真缺口 0 · 可证等价 1**

判据 = **既有**的 `orchestrator/worker/sources-loader.test.mjs`
（58 例、两个路径共 **10 个请求点**）。第一轮漏掉的 12 条：

`M5` scope 必填 · `M10` 错误码 · `M11` limit 下钳位 · `M12` limit 上钳位 ·
`M13` limit 缺省 · `M15` `count` · `M16` `serverTimeMs` · `M17` 直接给 body ·
`M18` `created` · `M19` `created` 第二次为 false · `M20` `by` 兜底 · `M22` 不 await 写门面

⇒ 补 `team-hub/employee-manifests-routes.test.mjs`（**19 例**）⇒ 终局 **21/22**。

### 3.1 ★ 相邻的两道守卫，既有判据只守了后一道

```
M5  scope 缺失        → ✖ 没咬住
M6  role/employeeId 都不给 → ✔ 咬住
```

这两道守卫在源码里是**紧挨着的两行**，既有判据咬了后面那道、**放过了前面那道**。

> 一个"这两道守卫都有人管"的印象，与一个"用例只碰过其中一道"的事实，
> 在我没有把它们**分开**各咬一次的时候是同一个东西。

### 3.2 ★ 边界的可见性又是要花钱的：上钳位 500 得先造 501 行

`M11`（下钳位 1）用 `limit=0/-5/abc` 三个值就够了；`M12`（上钳位 500）
必须**真的有 >500 行**才观测得到。这次没有走 501 次 HTTP POST（切片 22 量过 ≈7.4 s），
而是**直接 `db.prepare(INSERT)` 落 501 行** —— 快得多，且判据守的是同一件事。

### 3.3 ★★ M22 判为**可证等价**：理由是查出来的，不是猜的

第一轮 `M22`（把 `await handleRun(...)` 的 `await` 去掉）报"没咬住"。
我一开始把它当**真缺口**，还专门写了一条"失败路径"的判据（测试 ⑲：投一份含
`sk-live-…` 的清单，逼 `handleRun` 走进 catch）——**仍然没咬住**。

于是去查它到底能不能被观测：`server.mjs` L970-995 的 `handleRun`
**整个包在 `try { … } catch (e) { … }` 里**，连"响应已发出后又抛"那条路都单独处理了
⇒ **它返回的 promise 永远不会 reject**。所以 await 与不 await 之间，
HTTP 调用方能观测到的差别是**零**：回执照样在它内部发出，成功与失败两条路我都分别咬过。

> 一个"我少写了个 await"的判据，与一个"那个函数自己吞掉了所有异常、
> 所以没人能观测到这个差别"的事实，
> 在我只看见 diff 里少了四个字母的时候是同一个东西。

⇒ 在破验脚本里把它标成 `{ equivalent: true }`（工具本来就有这一档），
**没有删掉它** —— 留着并标成"等价"，比删掉更能说明**这里被查过**。

### 3.4 ★ 顺带量出的一处形状不对称

成功回执 **有** `ok: true`；**错误回执根本没有 `ok` 字段**（是 `{error, code, stateMachineCode, missing, …}`）。

> 一个"回执总有 `ok`"的印象，与一个"错误那条路走的是另一个信封"的事实，
> 在我只数成功路径的字段时是同一个东西。

已写进判据（⑲）钉住。

---

## 4. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7358 | **7319**（−39；`+8/−47`） | 9221（累计 **−1902**） |
| `handle()` 路由条件（抽取器口径） | 98 | **94** | 191 |
| `router.dispatch` 调用点 | 22 | **23** | 0 |
| `routes/` 族模块 | 22 | **23** | 0 |

**94 剩余 + 94 已搬 = 188** ✓ —— **正好一半** ·
被删区间 **47 行**（注释 2、路由 3），**丢注释 0 / 丢代码 0**

---

## 5. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 23 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 22 族读数未变** |
| ★ team-plans 的接缝仍在（L5448-5450，查过） | ✅ |
| **自由标识符常设判据** | ✅ 23 模块 / 未绑定 0 |
| 破验 | ✅ **21/22 咬住**，真缺口 **0**、可证等价 1（M22，理由见 §3.3） |
| `employee-manifests-routes`（本片新判据） | ✅ **19/19** |
| 既有判据 `orchestrator/worker/sources-loader.test.mjs` | ✅ **58/58** |
| 全量回归 | ✅ **57 套件 / 978 例 / 978 pass / 0 fail**（+1 套件、+19 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 94 / sources 41 / 族 23） |

---

## 6. 本片**没有**做

- ★ **`CONTEXT_PLAN_ERRORS` 那两处键名错误没有修**（§1.3）—— 只钉住现状，
  修它属于产品语义变更。**其中 `server.mjs:5437` 那处（`/api/team-plan`）本片没资格碰**。
- `/api/model-bindings`（前缀跨两个作用域，仍欠"拆族或加 `F.paths`"的裁决）、
  `/api/model-bindings` 之外的 `/api/task` / `/api/scopes` / `/api/runtime/status` /
  `/api/board` / `/api/artifact/content` / `/api/exec/requests` 等候选**未动**。
- **`/api/events`（77 行 / 6 点）仍未搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`），仍是**单独一片**。
- 域逻辑（`context-plan-store.mjs`）仍在原处，**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**。
- 两个助手工具（`wire-family.mjs` / `check-region-lines.mjs`）的修复**留在助手区**，
  **不进仓库** —— 与"把助手判据搬进仓内常设闸门"是同一件独立的事。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **94** 条条件仍在 `handle()`。

---

## 7. 复现命令

```powershell
node .worktrees/_prt-handoff/probe24-secret.mjs   # 量明文密钥那条失败路径的回执形状
node .worktrees/_prt-handoff/gen-family.mjs employee-manifests
node .worktrees/_prt-handoff/wire-family.mjs employee-manifests /api/employee-manifest createEmployeeManifestsRoutes
node .worktrees/_prt-handoff/register-family.mjs employee-manifests df698a6 /api/employee-manifest team-hub/routes/employee-manifests.mjs createEmployeeManifestsRoutes
node .worktrees/_prt-handoff/register-baseline.mjs employee-manifests team-hub/routes/employee-manifests.mjs employee-manifests createEmployeeManifestsRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/employee-manifests-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice24.mjs
# 复现那条真缺陷：
git show df698a6:team-hub/server.mjs | Select-String 'CONTEXT_PLAN_ERRORS\.'
node -e "import('./team-hub/context-plan-store.mjs').then(m=>console.log(m.CONTEXT_PLAN_ERRORS.EMPLOYEE_MANIFEST_NOT_FOUND))"
```
