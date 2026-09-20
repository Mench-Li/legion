<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 32：第三十族 = 技能写面 + 文档写面（6 条）—— 第一族**横跨两个命名空间**，第一个 `(方法, 路径)` 二元条目

- **族**：`skills-documents`（`team-hub/routes/skills-documents.mjs`），**6 条 / 116 行**，**全是 `POST`**：
  - `/api/skills/register` · `/api/skills/review` · `/api/skills/grant` · `/api/skills/revoke`
  - `/api/documents` · `/api/documents/delete`
- **参考提交**：搬走前 `17f0ccc`
- **规模**：区间 116 行（注释 20、路由 6）、**外来 0**、**分段 1**（中间有个 `// ── PRT-406 ──` 子分隔符，属本族）

---

## 1. ★★★ 同名不同法：`/api/documents` 出现**两次**，分属两簇

本族的 `POST /api/documents`（L6335）与**另一个簇**里的 `GET /api/documents`（L6778）
是**同一个路径字面量**。同理 `/api/skills/register` 之外还有个 `GET /api/skills`。

> 一个"路径就是这条路由的身份"的印象，与一个"同一个路径可以挂两种方法、分属两簇"的事实，
> 在我没有碰到第一条**同名不同法**的路由之前是同一个东西。

⇒ 取族判据从「路径表」升级成 **`(方法, 路径)` 二元表**：

- `gen-family.mjs`：路径表条目可以是 `'POST /api/documents'`；
- `wire-family.mjs` / `check-region-lines.mjs` / `pair-routes.mjs`：都改成从模块里读
  `method:` + `path:` 配成对，按二元匹配。

★ 这是**上一片（31）就预告过的**：切片 31 的结论里写着
「三个工具的修法只落在助手区，**不把这条判据固化下来，下一簇会再撞一次同样的墙**」。
**它真的又撞了一次**，只是换了个形状（那次是"前缀跨接缝"，这次是"路径跨方法"）。

### 1.1 守卫救了第二次场

`wire-family` 第一遍就报：

```
✔ ③ 被删区间 L6265-6380（116 行；其中方法条件 6 条，期望 6）
✖ 被删区间里混进了别的族：if (req.method === 'POST' && path === '/api/documents') { | ...
```

★ 两次**都不是**"两份独立实现互相校验"发现的，而是**对条数/归属的那道守卫**。
（切片 31 的原话：**是对条数的那道守卫救的场，不是"两份实现"那道。**）

---

## 2. 接缝注释**不能说一句没核对过的话**

`wire-family` 原来的模板写死了：

```js
// 整段搬走：`server.mjs` 里现在**不再有** `<前缀>` 路由，该命名空间只住一个地方。
```

前 29 族恰好都满足（前缀 = 族 = 命名空间）。本族**不满足**：
`GET /api/skills` 与 `GET /api/documents` 本来就住在别的簇里、也本来就不该搬。

接缝注释是**唯一**留在 `server.mjs` 里的线索（`wire-family` 自己的注释就这么写）——
**于是读它的人会读到一句假话，而假话比没有话更坏。**

修法：注释改成**只声明核对过的事实**，并把同名不同法的那几条点名：

```js
// ── 技能仓库与文档库的写入面（…） —— 已提取到 `./routes/skills-documents.mjs`（PRT-316 第 30 族 / 切片 32）──
// 本族这 6 条已全部搬进模块，`server.mjs` 里不再有它们。
// ★ **同名不同法**的这几条不属本族、仍留在下面，别顺手搬走：GET /api/documents
if (await router.dispatch(req, res, { path, url })) return
```

★ 写这段时我第一版把**本族自己那 6 条**也报成了"同名不同法仍在 server.mjs"
（漏了 `!modKeys.includes(k)`）—— 被判据当场打回。

> 一个"路径在我的族里"的谓词，与一个"这条路由**就是我族的这一条**"的事实，
> 在我没有把它和"本族的键"再比一次的时候是同一个东西。

---

## 3. ★★★ 破验量出来的 **13 个真缺口**（然后补上了）

本族**已经有强判据**：`team-hub/context-prt406-trust.test.mjs`（真 HTTP，两个命名空间都覆盖）+
`team-hub/skills.test.mjs`（域层）+ `orchestrator/worker/sources-loader.test.mjs`（58 例）。
拿这三套当判据、把路由层逐条改坏：

```
9/22 咬住；真缺口 13 条
```

**22 条里只有 9 条会红。** 逐条量出来的读数（`probe32*.mjs`）：

| 变异 | 量出来的读数 |
| --- | --- |
| M3 `registerX` | **404**（松成 prefix 会变成 400「缺少参数 id」） |
| M4 register 不验 name | 缺失/全空白 → **400「缺少参数 name」**；正常值**会 trim** |
| M8/M9 `body.scope ?? scope` | **缺席→`default`、`null`→`default`、空串→`''`**（★ 空串**不**被 `??` 顶掉） |
| M18 删除 id 不 trim | 带空白 → **`deleted:true` 且 id 已 trim** |
| M14/M15/M21 审计 | 表叫 **`audit`**（不是 `audit_log`）；`detail` 是 JSON 字符串；`bodyBytes` 是**字节数**（5 个汉字 = 15） |
| M10/M11 无人值守 grant | **202** + `{error:'权限审批待处理', requestId, permission.status:'pending'}` |
| M12 权限被拒 | ★★ **全仓没有任何用例提到过 `权限拒绝`** —— 那条 `if` 从来没被执行过 |
| M16/M17/M22 dispatch | 命中回 `true`、不命中回 `false`、**恰好跑一次** |
| M22 返回 false | 会让 `handle()` 继续往下走、**再答复一次** —— 三套判据**一条都不红** |

### 3.1 补上：`team-hub/skills-documents-routes.test.mjs`（21 例）

覆盖上面 13 处，其中两块是这次特意做扎实的：

- **⑨ 接缝契约（单元级）**：给工厂喂桩依赖，直接验 `dispatch` 的**四种**情形 ——
  路径不命中 → `false` 且**一条都没跑**；方法不命中 → `false`（★ 钉 M16）；
  命中 → `true` 且**恰好跑一次**（★ 钉 M17/M22）；`/api/documents/delete` **不能被
  `/api/documents` 抢先**（★ 钉 M2）。再核对六条路由的顺序。
  ★ 本片的交付物**就是这根缝**，所以它值得有自己的判据。
- **⑩ 权限被拒那条路**：往 `permission_rules` 塞一条全局 `deny`，
  验 400「权限拒绝」**且一条授权都没写进去**，然后删掉规则、验它回到 202。
  ★ 清理那步第一次假红：`DELETE` 那条也要求 `by`（`requireMember(body)`），
  不带体的 DELETE 会 400、规则留着不走。

**补完之后同一个破验：`21/22 咬住；真缺口 0 条；可证等价 1 条`。**

### 3.2 唯一那条"可证等价"：一句**够不到的死代码**

```js
const skillForPermission = getSkill(id)
if (!skillForPermission) throw new Error('技能不存在')
```

`getSkill()` **自己就会 `throw new Error(\`未知技能 ${id}\`)`**，永远不返回假值
（`server.mjs` L2832-2834）。⇒ 路由那句 `技能不存在` **永远轮不到**，
真正发出去的是域层那句「未知技能 …」（探针实测）。

> 一个"我在路由上守了一道存在性检查"的印象，与一个"域层**先**抛了、于是这道永远轮不到"的事实，
> 在我没有把那条路真的走一次、看回执上写的是哪句话的时候是同一个东西。

**本片不修它**（改错误文案会动对外契约），只在判据里钉住"回执上是哪句话"。

---

## 4. ★★ 记录一处 **pre-existing 不对称**（本片**没修**）

```js
let before = null
try { before = getDocument(id) } catch { before = null }   // ← 用**没去空白**的 id
const out = deleteDocument(id.trim())                      // ← 用去空白的
audit(by, before?.scope ?? scope, 'document:delete', id.trim(), {...})
```

⇒ `POST /api/documents/delete {id:'  asym-1  '}` **删得掉**那个文档，
但审计里的 `title`/`version` 变成 `null`、行的 `scope` 退回**写路径**的 `default`
（而文档其实属于 `software`）。**删是删了，账记不清。**

判据 ⑧b 把这个读数钉住了。

---

## 5. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7008 | **6904**（−104；`+12/−116`） | 9221（累计 **−2317**） |
| `handle()` 路由条件 | 73 | **67** | 191 |
| `router.dispatch` 调用点 | 29 | **30** | 0 |
| `routes/` 族模块 | 29 | **30** | 0 |

**67 剩余 + 121 已搬 = 188** ✓ —— **已搬过 64.4%**（121 / 188）
被删区间 **116 行**（注释 20、路由 6），**丢注释 0 / 丢代码 0**

---

## 6. 判据

| 判据 | 结果 |
| --- | --- |
| 30 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 29 族读数未变** |
| **自由标识符常设判据** | ✅ 30 模块 / 未绑定 0 |
| 破验（补判据**前**） | **9/22**，真缺口 13 |
| 破验（补判据**后**） | ✅ **21/22 咬住**，真缺口 0、可证等价 1 |
| `context-prt406-trust`（既有强判据） | ✅ |
| `skills-documents-routes`（本片补的 21 例） | ✅ **21/21** |
| `orchestrator/worker/sources-loader` | ✅ **58/58**（★ 只按目录选套件的选择器**扫不到**它） |
| 全量回归 | ✅ **64 套件 / 1106 例 / 1106 pass / 0 fail**（+1 套件、+21 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 121 / sources 48 / 族 30） |

---

## 7. 本片**没有**做

- ★★★ 四个工具（gen / wire / check-region-lines / pair-routes）的修法**仍只落在助手区**
  （`.worktrees/_prt-handoff/`，**不进仓库**）。**切片 31 已经预告过一次，这次果然又撞了一面新墙。**
  不固化下来，下一簇还会撞第三次。
- ★★ 本片**没有**给 30 个族各补接缝契约的判据 —— 只在 `skills-documents` 这一族做了（⑨）。
  其余 29 族的 `dispatch` 契约（命中回 true、恰好跑一次）**仍然没有判据**。
- ★★ 第 4 节那处 pre-existing 不对称、以及第 3.2 节那句死代码 —— **都没修**（待业主裁决）。
- ★ 既有缺陷仍未修：切片 29 的 `scope` 归一、切片 28 的定形信封、切片 24 的
  `CONTEXT_PLAN_ERRORS` 键名、切片 26 的模型配置警告、`limit=2.7` 那一个形状三处。
- 剩下的 **11 个簇**未动；`/api/events` 仍未搬（需要增量写回 `live.bump`）。
- 域逻辑仍在原处（`registerSkill`/`reviewSkill`/`grantSkill`/`revokeSkill`/
  `registerDocument`/`deleteDocument`/`getDocument`/`checkPermission` 都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；切片 1～5 丢失的注释仍未补。

---

## 8. 复现命令

```powershell
node .worktrees/_prt-handoff/cluster-probe.mjs                       # ⇒ 本簇 6 条 / L6258-L6372
node .worktrees/_prt-handoff/probe32-skills-documents.mjs            # ⇒ 13 处缺口的读数
node .worktrees/_prt-handoff/probe32b-audit.mjs                      # ⇒ audit 表形状与两行 detail
node .worktrees/_prt-handoff/gen-family.mjs skills-documents         # ⇒ D 段 + 反向自检
node .worktrees/_prt-handoff/wire-family.mjs skills-documents /api/skills createSkillsDocumentsRoutes
node .worktrees/_prt-handoff/verify32.mjs                            # ⇒ GET /api/documents 等**没被碰**
node .worktrees/_prt-handoff/register-family.mjs skills-documents 17f0ccc /api/skills team-hub/routes/skills-documents.mjs createSkillsDocumentsRoutes
node .worktrees/_prt-handoff/register-baseline.mjs skills-documents team-hub/routes/skills-documents.mjs skills-documents createSkillsDocumentsRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/skills-documents-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice32.mjs
```
