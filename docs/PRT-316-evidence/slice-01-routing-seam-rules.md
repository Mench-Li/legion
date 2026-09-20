<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片记录 · 第 1 片：路由层的**缝** + 第一族（rules）

> 业主 2026-09-20 裁决：走 `docs/review/PRT-PRE-REFACTOR-CANDIDATES.md:140` 的
> 「批次 3（两个热点文件降温后，**或按「一个切片一次对拍」做**）」那一支，
> 照 `PRT-315`（同为阶段 3，已 ✅）的先例逐片提取。硬约束：**每片能独立对拍与回滚**
> （`spec :1282`），**不允许一次性重写两个大文件**。

## 0. 这一片到底交付了什么

**不是**"少了两条路由"。交付物是**这个家**：

| 文件 | 角色 |
| --- | --- |
| `team-hub/router.mjs`（新增，82 行） | 路由层的缝：`createRouter(families)`，逐族问"归你管吗" |
| `team-hub/routes/rules.mjs`（新增，101 行） | 第一个搬进去的族（rules），依赖全部注入 |
| `team-hub/server.mjs` | 只改三处：+2 行 import、+7 行装配、15 行路由块 → 3 行 `dispatch` |

理由在 `docs/PRT-212-evidence/verify-evidence.md:122` 逐字写着：

> 真实审批箱接线 —— 需要 PRT-316 先把 team-hub 的**路由层**提取出来；
> 现在直连会把新代码**焊死在 `server.mjs`** 上。

> 一个"把路由搬走一半"的提取，与一个"给路由留下一个能搬进去的家"的提取，
> 在没有下一族路由要接的时候是同一个东西——
> 只不过前者在第二族路由到来时，会再抄一遍同一套 if 链。

## 1. 为什么第一族挑 `rules`

因为"搬对了没有"这个问题，在本族上有一个**不用新写**的判据：
`team-hub/rules.test.mjs`，7 例，走**真实 HTTP**（临时 `TEAM_HUB_DB` +
dynamic import `server.mjs` + `listen(0)` + fetch），覆盖建表幂等 / 老库自动建表且存量无损 /
未设置的回读 / 保存后逐字回读 + `audit rules:update` + SSE 帧 / 四类 400 且零落库 /
边界 3000 字与 upsert / GET 不产生 audit。

> 一个"搬完之后需要新写一批用例才能证明没搬坏"的切片，
> 与一个"既有用例原样跑就是判据"的切片，在**没写那批用例**时是同一个东西——
> 只不过前者会把"还没验证"读成"已验证"。

## 2. 语义等价性：**逐条**，不是"差不多"

`handle` 里的形状是 `if (方法 === X && path === Y) { …; return }`。
`createRouter` 的顺序语义与之一一对应：

| # | 原 `if` 链 | `router.dispatch` |
| --- | --- | --- |
| ① | 从上往下按出现顺序匹配 | 按 `families` 注册顺序、族内按 `routes` 声明顺序 |
| ② | 命中 → 执行 → `return` | 命中 → `await run(...)` → 返回 `true` → 调用方 `return` |
| ③ | 都不命中 → 继续往下 | 返回 `false` → 调用方继续走既有 if 链 |

★ ③ 是**需要**的：写成"抛错"会让未知路径从 404 变 500。

## 3. 判据一：逐字对拍（`spec :1282` 的"可对拍"）

脚本 `.worktrees/_prt-handoff/pair-rules-routes.mjs`，四件事分别断言：

1. **方法+路径+顺序**：旧 `if` 条件 `[["GET","/api/rules"],["POST","/api/rules"]]`
   与模块声明式表**一一对应**（含顺序）；
2. **函数体逐行字面相同**（仅缩进不同）：GET 体 7 行、POST 体 1 行，逐行命中；
3. **无副本**：`server.mjs` 里 `req.method === 'GET' && path === '/api/rules'` 与
   POST 那条**均已消失**（两处各留一份就是本仓见过的那种失效）；
4. **装配到位**：`router.dispatch` 调用点恰好 **1** 处，且 `rules` 族确实在 `createRouter` 里。

结果：**✅ 全通**。

★ 为什么函数体可以做到"逐字"而不是"归一化后相等"：`json` / `handleWrite` /
`validRuleScope` / `getRule` / `saveRule` 以及 `url` 全部从注入参数或 `ctx` 到达**同名**绑定，
于是**没有一处需要改写**（`routes/rules.mjs` 里零注入改写）。

> 一份"归一化之后相等"的对拍，与一份"字面相等"的对拍，
> 在只跑一次的场景里是同一个东西——只不过前者的归一化规则**本身没人对拍**。

## 4. 判据二：破验（5/5 咬住，0 漏网）

脚本 `.worktrees/_prt-handoff/mutate-slice1.mjs`，用**既有** `rules.test.mjs` 当探测器：

| # | 变异 | 结果 |
| --- | --- | --- |
| K1 | GET 响应丢掉 `ok` 字段 | ✔ 咬住 |
| K2 | GET 不校验 scope（非法 scope 也 200） | ✔ 咬住 |
| K3 | POST 不落库（`saveRule` 变 no-op） | ✔ 咬住 |
| K4 | `dispatch` 永不命中（两条路由变 404） | ✔ 咬住 |
| K5 | 400 分支不再区分错误形状 | **✖ 第一轮没咬住** |

逐字节还原（原字节写回）后复绿。

### 4.1 K5 的漏网**不是本片引入的**，是一条既有的覆盖缺口

`rules.test.mjs` 原文（`TC-S4-02`）对 GET 的非法 scope **只钉了状态码**：

```js
assert.equal(bad.status, 400, '非法 scope 400')
```

于是把响应包换成 `{error:'err'}` 也全绿。

> 一个只断言"400"的用例，与一个断言"400 且说清了哪个字段"的用例，
> 在只看状态码时是同一个东西；只不过前者放行了一个说不出原因的 400。

**已补**（`team-hub/rules.test.mjs`，+5 行）：

```js
assert.ok(bad.json && bad.json.error && /scope/.test(bad.json.error), '400 要说明是 scope 的问题：' + bad.text)
```

补后破验 **5/5 咬住、0 漏网**。补它的理由是：这一片把这条分支搬了家，
而"搬过的边界要有判据"。

## 5. 判据三：全量回归

`team-hub/` 下**所有** import 了 `server.mjs` 的套件 —— **51 个 · 775 例 · 775 pass · 0 fail**。

## 6. 门禁发现的真问题：抽取器不认"搬过家"的路由

第一次跑 `baseline-snapshot --check` 报：

```
- 路由: GET /api/rules
- 路由: POST /api/rules
```

**把两条路由报成了被删除。** 根因：`extractRoutes()` 只扫 `server.mjs` 里
`req.method === 'X' && path === 'Y'` 这种**字面量 if 链**。

> 一个只认识"路由长什么样"的抽取器，与一个认识"路由住在哪里"的抽取器，
> 在被提取之前是同一个东西——只不过前者会把每一次提取都报成一次删除。

**修法（改抽取器，不是改基线）**：

1. 新增 `extractDeclaredRoutes()`：认 `method: 'X', path: 'Y'`（两种书写顺序都认）；
2. 新增 `ROUTE_FAMILY_SOURCES`：路由族模块**逐个列名**（与 `SCHEMA_SOURCES` 同一纪律——
   glob 会漏掉新文件，而漏掉是静默的）；
3. 新增 `assertRouteFamilyCoverage()`：以 `server.mjs` 的 `createRouter([...])`
   **装配处为权威**核对列名——"新增一族却忘了登记"必须红；
4. `httpRoutes` 改为**并集**，且族文件纳入 `sources` 哈希（漂移可归因）。

★ 写在测试里的一条自己抓自己的缺陷：`extractDeclaredRoutes` 的第一版正则
**要求 `method:` 与 `path:` 之间必须有换行**，于是"写在同一行"的族会被**整族漏掉**。
新增用例 ⑧ 立刻报红（25 例里 fail 1），改成 `,\s*` 后同时接受同行与换行。

## 7. 这一片**没有**做（如实记，免得下一片以为做完了）

| 没做 | 为什么 | 归属 |
| --- | --- | --- |
| 域逻辑 `MAX_RULES_LEN` / `validRuleScope` / `getRule` / `saveRule` 仍在 `server.mjs`（L4006-4052） | 本片只搬**路由**；它们对四个的 `export` 一字未动（是 63 个导出面的一部分） | 后续片 |
| 其余 191 条路由条件仍在 `handle` 里 | 一片一族 | 后续片 |
| `handle` 仍是 **4222 行**（9221 → 9218 行） | 本片是"立缝 + 首族"，不是"拆完" | 后续片 |
| 真实审批箱接线（PRT-212 那条依赖） | 缝已就位，但接线本身是另一项工作 | PRT-212 |

## 8. 可复核判据

```bash
cd <repo>
node team-hub/rules.test.mjs                       # 7/7（含新增的 400 响应包断言）
node --test scripts/prt/baseline-snapshot.test.mjs  # 25/25
node scripts/prt/baseline-snapshot.mjs --check      # 无漂移
node .worktrees/_prt-handoff/pair-rules-routes.mjs  # 逐字对拍（工作区脚本，不入库）
node .worktrees/_prt-handoff/mutate-slice1.mjs      # 破验 5/5
```

九道门禁 **9/9 `exit=0`**。
