<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 23：第二十二族 = `/api/members` —— 一个**从来没有判据**的端点

- **族**：`members`（`team-hub/routes/members.mjs`），1 条路由：`GET /api/members`（精确）
- **参考提交**：搬走前 `def30e3`
- **为什么是它**：见 §1 —— 这一轮**先做了一张"剩下 98 条都在哪"的地图**，再挑的族。

---

## 1. 先画地图：剩下 98 条已经不是"一族一个前缀"的形状了

新写了 `rank-remaining.mjs`（按精确路径分组，附体量/外来条款）与 `find-runs.mjs`
（找**连续的条件段**）。读数：

```
剩余方法条件合计 98 条，涉及 86 个不同路径字面量
```

**86 个路径 / 98 条条件** —— 也就是说剩下的绝大多数是**零散的单条端点**。
前十族那种"一个前缀下面挂 5～13 条"的形状已经没有了。

最干净的一批（外来条款 0）全是单条：`/api/runtime/status`（4 行）、
`/api/exec/requests`（5 行）、`/api/goal/status`（5 行）、`/api/members`（8 行）…

### 1.1 挑 `/api/members` 的理由：它**一把判据都没有**

`survey-judges2.mjs /api/members` 的读数：

```
本族 /api/members 的判据（✅ = 起真 hub 且走真 HTTP）：
⇒ 强判据 0 套，请求点合计 0
```

**8 行代码、从来没有被任何用例看过一眼**，而它算的东西（"谁还在线"）
是**会随时间自己变**的 —— 这正是最该有判据、却最容易被跳过的形状。

（对照：`/api/task` 有 58+10 例、`/api/runtime/status` 有 30 例；
`/api/scopes` 只有 1 个点 0 例。选 members 是因为"0 判据"这件事本身就是价值。）

---

## 2. ★★ 先量后写，量出来三件不看就会写错的事

### 2.1 回执是**裸数组**，不是 `{ok, members}`

```js
json(res, 200, rows.map((r) => ({ … })))
```

本片之前 22 族里，绝大多数读端点都是 `{ok: true, …}` 外壳
（`/api/team-plans` 是 `{ok, plans, count, serverTimeMs}`）。
这一条**直接返回数组**。照惯例写 `r.body.plans` 就会一路 undefined。

### 2.2 `member` 取的是库里的 `id`，不是 `scope`

```js
member: r.id, scope: r.scope, kind: r.kind, lastSeenAt: r.lastSeenAt,
```

*一个"名册里那一列叫 member"的判据，与一个"它取自哪个物理列"的问题，
在我只看到键名、没看到右边的表达式时是同一个东西* —— 而取错列的表现是
**前端画出两个同名的"人"**。

### 2.3 `online` 里的 `?? 0` 守的其实不是 `online`

```js
online: Date.now() - new Date(r.lastSeenAt ?? 0).getTime() < 60000
```

去掉 `?? 0`：`new Date(null)` → Invalid Date → `NaN`，而 **`NaN < 60000` 也是 `false`**。
所以两种写法对 `online` 的**取值完全一样**。`?? 0` 真正守的是**不抛异常**
（`new Date(null).getTime()` 是 `NaN`，不是异常；但若哪天改成 `.toISOString()` 就会抛）。

⇒ 判据写成"`lastSeenAt` 为 null ⇒ `online === false` **且不抛**"，
并在注释里写明这一格**测的不是取值**。*把"取值一样"和"行为一样"分开写，
才不会让一条永远绿不了的断言伪装成一条有用的断言。*

---

## 3. ★★ 破验的边界夹具被 HTTP 往返打败了

第一版夹具用 `59999 / 60000 / 60001` 毫秒做 60 秒边界，跑出来**四条全是 `false`**：

```
b-59999    实测年龄= 60015ms  online=false
b-60000    实测年龄= 60016ms  online=false
b-60001    实测年龄= 60016ms  online=false
b-60500    实测年龄= 60514ms  online=false
```

原因：**一次 HTTP 往返就要十几毫秒**，等我读到它时四条都已经过了 60 秒。

> 一个"正好卡在边界上"的夹具，与一个"边界在到达断言之前就已经被时间推过去了"的事实，
> 在我把余量留成零的时候是同一个东西。

⇒ 改成 **59 秒 / 61 秒**（两边各留 1 秒余量），才真正区分开。

---

## 4. 破验终局：**17/17 咬住**（真缺口 0，可证等价 0）

**连续第三个满咬合切片**（21 片 19/19、22 片 17/17、本片 17/17）。

★ 本片的顺序与前两片**相反**：前两片是"先拿既有判据跑破验 → 看漏了什么 → 再补判据"；
本族**一把既有判据都没有**，破验的基线要求套件全绿，所以**先写判据、再破验**。
"哪 8 条没人管"这个问题在这一族没有意义 —— 答案是**全部**。

守住的 17 条里，最要紧的四条：

| 变异 | 表现 |
| --- | --- |
| M4 `online` 恒 true | **离线的人也显示在线** |
| M2 排序 DESC → ASC | "谁最近上线"整个反过来 |
| M9 `member` 取错列 | 名册里出现两个同名的人 |
| M13 回执裹成 `{ok, members}` | 接口形状变了，前端拿不到数组 |

---

## 5. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7358 | **7358**（净 0；`+8/−8`） | 9221（累计 **−1863**） |
| `handle()` 路由条件（抽取器口径） | 98 | **97** | 191 |
| `router.dispatch` 调用点 | 21 | **22** | 0 |
| `routes/` 族模块 | 21 | **22** | 0 |

**97 剩余 + 91 已搬 = 188** ✓ · 被删区间 **8 行**（注释 0、路由 1），**丢注释 0 / 丢代码 0**

★ 本片行数**净 0**：删掉 8 行、加回 8 行（1 行 import + 4 行装配 + 3 行段注释）。
**"行数没变"不等于"什么都没做"** —— 条件数 98→97、族数 21→22 才是读数。

---

## 6. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 22 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 21 族读数未变** |
| **自由标识符常设判据** | ✅ 22 模块 / 未绑定 0 |
| 破验 | ✅ **17/17 咬住**，真缺口 0、可证等价 0 |
| `members-routes`（本片新判据，本族**首个**判据） | ✅ **8/8** |
| 全量回归 | ✅ **56 套件 / 959 例 / 959 pass / 0 fail**（+1 套件、+8 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25（188 / 已搬 91 / sources 40 / 族 22） |

---

## 7. ★ 发现并**记录**了一个需要裁决的结构性分岔（本片没做它）

`/api/model-bindings` 是**新的形态**：外面套着一个**不看方法**的
`if (path.startsWith('/api/model-bindings/')) {`，它在体内声明共享局部
`BINDING_PREFIX` 与 `parts()`，两条路由都用。

量出来的事实：

```
取到 5 条路由（前缀 /api/model-bindings/）：
  L5503  GET    exact   = /api/model-bindings
  L5508  POST   exact   = /api/model-bindings
  L5521  GET    exact   = /api/model-bindings/resolve
  L5616  GET    prefix  ^= /api/model-bindings/
  L5628  DELETE prefix  ^= /api/model-bindings/
✖ 有未登记的名字：BINDING_STORE_ERRORS ← …/resolve, …/；parts ← …/
```

**3 条在块外面、2 条在块里面**，生成器当场**拒了**（✔ fail closed）。
解法有两条 —— 拆成两族，或给接缝加"**显式路径集**"能力（`F.paths`）。
这一族在早期轮次里就被标过"**不内聚**、需要裁决怎么拆"，本片只是把读数补全了。

⇒ 已把结论与阻塞原因写进 `gen-family.mjs` 的 `FAMILIES` 条目（`blocked:` 字段），
**本片不碰它**：它要么改接缝能力、要么拆族，那是**独立的一件事**。
顺带说，剩下 86 个路径 / 98 条条件里绝大多数是零散单条，
"一个前缀 = 一族"这个假设**已经用完了** —— `F.paths` 大概率是下一步绕不开的。

---

## 8. 本片**没有**做

- **`/api/model-bindings` 没做**（见 §7），原因与读数都留在了 `gen-family.mjs` 里。
- `/api/task`（58+10 例判据）/ `/api/scopes` / `/api/runtime/status` / `/api/board`
  / `/api/artifact/content` / `/api/exec/requests` 等候选**未动**。
- **`/api/events`（77 行 / 6 点）仍未搬** —— 它**写**宿主那个可变计数（`+= 1`），
  需要把活绑定扩成**增量写回**（`live.bump`），仍是**单独一片**。
- 域逻辑（members 表的写入侧 / `upsertMember`）仍在原处，**只搬路由**。
- `/api/hello` 是 404（量出来的）—— 成员不是通过它写进去的；**没有**去追写入口，
  那不是搬家的事。
- 那把只按目录选套件的回归选择器**没有改**。
- 助手判据（含本片新增的 `rank-remaining.mjs` / `find-runs.mjs`）仍住在
  `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **97** 条条件仍在 `handle()`。

---

## 9. 复现命令

```powershell
node .worktrees/_prt-handoff/rank-remaining.mjs    # 剩下 98 条按路径分组
node .worktrees/_prt-handoff/find-runs.mjs         # 找连续条件段
node .worktrees/_prt-handoff/survey-judges2.mjs /api/members   # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe23-members.mjs   # 先量形状（含边界夹具的教训）
node .worktrees/_prt-handoff/gen-family.mjs members
node .worktrees/_prt-handoff/wire-family.mjs members /api/members createMembersRoutes
node .worktrees/_prt-handoff/register-family.mjs members def30e3 /api/members team-hub/routes/members.mjs createMembersRoutes
node .worktrees/_prt-handoff/register-baseline.mjs members team-hub/routes/members.mjs members createMembersRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/members-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice23.mjs
```
