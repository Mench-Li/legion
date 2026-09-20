<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 · 切片 43：第四十一族 = 两个只读视图（技能目录 / 显式文档读）

> **一句话**：把 `GET /api/skills` 与 `GET /api/documents` 搬进 `team-hub/routes/content-reads.mjs`。
> 破验给出一个很**精确**的结论：既有套件守得住「pending 确实被挡住了」，
> 却**守不住「是谁挡的」和「挡的时候说了什么」** —— 三个变异里全是**安全**的那一半。

| 项 | 值 |
| --- | --- |
| 族号 / 切片号 | 第 41 族 / 切片 43 |
| 模块 | `team-hub/routes/content-reads.mjs`（131 行） |
| 判据 | `team-hub/content-reads-routes.test.mjs`（**19 例**） |
| 搬走的 2 条 | `GET /api/skills`、`GET /api/documents`（全 `exact`） |
| 注入面 | `json, getSkill, listSkills, listDocuments`（4） |
| 规模 | `server.mjs` 5944 → **5908**（−36）；路由条件 15 → **13**；`dispatch` 调用点 40 → **41**；族模块 40 → **41** |
| 被删区间 | **45 行**（注释 14，路由 2），丢注释 0 / 丢代码 0 |
| 破验 | 有我方判据 **13/13 咬住、真缺口 0**；不给我方判据 **5 咬住 / 3 漏网** |
| 回归 | 75 套件 / 1287 例 / 1287 pass / 0 fail |

---

## 一、★★★ 本片最精确的一条结论：既有套件守的是"挡住了"，不是"谁挡的"

这**不是**切片 41/42 那种"一条判据都没有"。既有套件（`skills.test.mjs`、
`skills-documents-routes.test.mjs`、`context-prt406-trust.test.mjs` …）确实守着这一族的一部分：

| 变异 | 不给我方判据时 |
| --- | --- |
| M1/M2 把两条路径改成不存在的 | ✔ 咬住 |
| M3 `wantPending` 的「与」变成「或」 | ✔ 咬住 |
| M7 未发布技能直接放行（不判 status） | ✔ 咬住 |
| M8 `include=pending` 取值放宽到 truthy | ✔ 咬住 |
| **M4 复审身份判定放宽成 `Boolean(member)`** | ✖ **漏网** |
| **M5 复审身份判定放宽成「有 `member` 参数就行」** | ✖ **漏网** |
| **M6 未发布技能不再伪装成"不存在"，改成泄露式报错** | ✖ **漏网** |

★★★ 漏网的**三个全是安全的那一半**：
既有判据验的是「没授权的人**确实拿不到** pending」，
它**没有**验「**凭什么**判定他是复审身份」，也**没有**验「拒绝时**说的是什么**」。

> 一个「`pending` 收口有既有套件守着」的印象，
> 与一个「它守的是"确实被挡住了"，而**没有**守"是**谁**挡的、以及挡的时候**说了什么**」的事实，
> 在我把这三个变异投进去之前是同一个东西。

★ 而 M6 尤其值得单独说：把 404 `skill_not_found: <id>` 换成
`技能 <id> 未发布（status=pending）`，**既有判据一个都没红** ——
也就是说「未发布技能对普通视角要**按不存在处理**、不泄露存在性」这条**纪律**，
在加上本片判据之前，**没有任何东西守着**。

---

## 二、★★★ 生成器连拦两次（第二次是切片 42 刚加的那道）

第一遍我按"段 A 里同质的 4 条"填了路径表，生成器报出 **14 个**未登记名字，其中两个是**危险**的：

```
eventClients          ← /api/events, /api/event-delivery   ← ★★★ 可变共享注册表
setInterval           ← /api/events
clearInterval         ← /api/events
writeEventFrame       ← /api/events
withTx                ← /api/events
```

★★ `eventClients` 正是本项目历史上踩过的第 (4) 类失败「**注入的可变宿主绑定被按值捕获**」；
而 `setInterval` / `clearInterval` + `writeEventFrame` 说明 `/api/events` 是
**长轮询/SSE** 端点，它还带 `withTx`（所以那一段根本不是"只读"）。

> 一个「剩下的都是小路由了」的印象，
> 与一个「最后几条里藏着全篇唯一一个**长连接 + 可变共享绑定**的端点」的事实，
> 在我把注入项真的数出来之前是同一个东西。

★ 于是本片**再收一次**：只取最干净的 `skills` + `documents`（3 个域函数、零 node 内建、
零可变绑定），把 `events`/`event-delivery` 那对**留给专门的一片**（要按 `live()` 口径处理可变绑定）。

★★ 第二次拦下的是**切片 42 刚加的去重断言**：它当场印出
`★ 装配清单去重：5 → 4（去掉与硬编码 json 重复的）` ——
**上一片修的那个缺陷，这一片立刻就复现了**（我又在 `deps` 里写了 `json`）。
第三次是第二道判据报 `db` 没用到（这两条压根不碰库，活儿全在三个域函数里）。

---

## 三、★★★ 我的 verify 断言写反了 —— 工具是对的

接缝说「归属 `/api/documents` , `/api/skills` 的那 2 条**都在这里了**」（**没有**兄弟警告），
我的断言却认为"这两个前缀下明明还有别的路由（技能的写/删、文档的写/读单条），应当警告"。

★★★ **真相是**：兄弟检测报的是「**仍留在 `server.mjs` 里**的同前缀路由」——
而那些技能写/删、文档写路由**早就被别的族搬走了**，此刻 `server.mjs` 里**没有**这两前缀的兄弟。

> 一个「这两个前缀下明明还有别的路由，怎么不警告」的印象，
> 与一个「那些路由早就不在 `server.mjs` 里了，警告的**只是还没搬走的**」的事实，
> 在我把"同前缀"理解成"曾经同前缀"而不是"**此刻还在同一个文件里**"的时候是同一个东西。

★ 这个语义恰恰是**对的**：那句警告的用途是"别顺手搬走**还在这个文件里的**兄弟"。

---

## 四、钉住的语义（19 例判据）

### `GET /api/skills`

- 按 `id` 取：已发布 ⇒ 200，带 `prompt`（**会被当指令执行的那一段**）、`bundle`、`grants`（**解析成数组**）。
- ★★★ 未发布且非复审视角 ⇒ **404 `skill_not_found: <id>`** ——
  **伪装成"不存在"**，不许说"未发布"（那等于确认它存在）。
- ★★★ `pending` 收口要 `member=general` **且** `include=pending`（**与**，不是**或**）；
  只满足一个 ⇒ 仍然 404。
- ★★ `member=general` 是**严格相等**（`General` / `GENERAL` / `general ` / `xgeneral` 都不算）。
- ★ 真正未知的 id ⇒ 404 带「未知技能 X」（文案与"未发布"**不同** → 可区分）。
- ★★★ **列表形态的"复审视角"同时把自己关进了 grants 过滤里**：
  `member` 一旦给了，`listSkills` 里那句「全缺省即全部」就不再放行 ⇒
  看到的**不是**"全部三态"，而是"**授权给我的**那些三态"。
- ★★★ 由此推出一条**无法问出的问题**：**没有**"列出全部空间的所有 pending"这个形态 ——
  一条没被 grant 给 `general` 的 pending 技能，**任何查询形态都看不到它**
  （但按 `id` 直取能拿到，那条分支**不**受 grants 过滤 —— 与列表形态口径不同）。

### `GET /api/documents`

- ★★★ 返回 `body`（参考资料），**不是** `prompt`；**没有** `status` 过滤（表里根本没这列）。
- `id` 走 `String(id)` 比较；**空串 = 不过滤**。
- `scope` 空串或缺省 = **不限空间**（与技能"全缺省即全部"同口径）。
- ★ `origin` 是**服务端写死**的字段（装配侧逐条判可信性的前提）。

---

## 五、九道门禁与回归

- 九道门禁 **9/9**
- 全量回归 **75 套件 / 1287 例 / 1287 pass / 0 fail**（+1 套件、+19 例）
- 逐字对拍：**41 族**路由一条没丢、体逐行按位置相同、无副本、装配到位
- `check-region-lines`：区间 **45 行**，丢注释 0 / 丢代码 0，**41 族全部零丢失**
- `check-free-identifiers`：**41 模块 / 未绑定 0**
- `baseline-snapshot --check`：无漂移

---

## 六、⚠️ 本片**没有做**

- ★★★ **`/api/events` 与 `/api/event-delivery` 故意没搬**（仍在 `server.mjs`）——
  它们要 14 个注入项、含**可变共享绑定** `eventClients` 与 SSE 的 `setInterval`/`clearInterval`，
  得按 `live()` 口径**专门开一片**。
- ★★★ **域层的列表过滤没搬**（`listSkills`/`listDocuments`/`getSkill` 仍全在 `server.mjs`）——
  本片**只搬路由**。破验第一遍我误把 5 个变异打在域层锚点上、整轮在 M9 就断了
  （见 `mutate-slice43.mjs` 里那段注释）。
- ★ `POST /api/agents` 与 `POST /api/spaces/`（段 A 里那两条**写**路由）留给下一片。
- ★★★ 四个工具的修法**仍只落在助手区**（已拖到**第十二片**：EOL 容忍 /
  前缀兄弟检测 / `blankLiterals` / 生成器去重+断言）。
- ★★★ `mutate-lib.mjs` 的"中途抛错静默截断"**仍未修**（本片又踩一次，在 M9）。
- ★★★ 破验的 `TESTS` 清单仍是**手工维护**；**没有任何东西阻止"边测边动同一棵工作树"**。
- ★ 接缝契约只给 11 族补过，其余 **29 族**的 `dispatch` 契约仍无判据。
- ★★★ 回归选择器**只扫 `team-hub/`**。
- 切片 1~5 丢失的注释仍未补。
- 余下 **13 条**：`POST /api/agents`、`POST /api/spaces/`、`GET /api/events`、
  `GET /api/event-delivery`、`GET /api/task-feedback`、`POST /api/heartbeat`、
  `POST /api/spaces`、`POST /api/pipeline`、`POST /api/goal/slices`、`GET /api/team-plan`、
  `POST /api/runtime/run-budget/may-switch-model`、`GET /api/activity`、`GET /api/artifact/content`。
