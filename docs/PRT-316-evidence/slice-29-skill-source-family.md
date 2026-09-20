<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 29：第二十八族 = 技能来源（`/api/skill-source` 两条）—— 写入成功、回执成功，而那条数据**谁都拿不到**

- **族**：`skill-source`（`team-hub/routes/skill-source.mjs`），**2 条**：
  - `GET /api/skill-source`（读某空间绑定的团队技能仓库）
  - `POST /api/skill-source`（写入；走 `handleWrite`：by 必填 + 审计 + SSE）
- **参考提交**：搬走前 `476ffab`
- **规模**：15 行、2 条、**外来 0**、**分段 1**

---

## 1. 为什么挑它

`/api/model-migration` 搬走后，这是**最后一个干净的多条组**（2 条 / 14 行）。
前缀 `/api/skill-source` 只捞这 2 条 —— `/api/skills`（**带 s**）是另一条路径，量过不碰撞。
★ 而且本族**连域模块都没有独立文件**：`getSkillSource` / `setSkillSource` 就住在 `server.mjs` 里。

## 2. ★★ 搬走前**零判据**，且**域函数也没有自己的套件**

`survey-judges2` 报"强判据 0 套"；`team-hub/` 下没有 `skill-source*` 文件、也没有任何用例提到这条路径。
⇒ 先写判据、再破验（16 例）。

---

## 3. ★★★ 本片钉住的真缺陷：`handleWrite` 递进来的 `scope` 被**丢掉**了

`handleWrite` 的签名是 `run(body, by, scope)`：

```js
async function handleWrite(req, res, run) {
  if (!authorized(req)) { … }
  const body = await readBody(req)
  const by = requireMember(body)        // '缺少操作者身份 by'
  const scope = readScope(body)         // ← ★ 算好了，作为**第三个参数**递进回调
  const result = await run(body, by, scope)
  json(res, 200, { ok: true, task: result })
}

function readScope(body) {
  return typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : 'default'
}
```

**而本族的路由回调写的是 `(body, by) => …`** —— 丢掉第三个参数，直接用 `body.scope` 原值：

```js
await handleWrite(req, res, (body, by) => setSkillSource({ scope: body.scope, url: body.url, branch: body.branch }))
//                                              ^^^^^^^^^^^^^^^^ 原值
```

### 3.1 四类后果（全部量过）

| 写入的 `scope` | 库里存成 | `?scope=<原值>` 能读回来吗 |
| --- | --- | --- |
| 不给 | `default` | ✅ |
| `null` | **NULL** | ❌ |
| `''` | `''` | ✅（但与"不给"落成**两个空间**） |
| `'   '` | `'   '` | ✅（原样） |
| `'  a  '` | `'  a  '` | ❌（`?scope=a` 读不到） |
| `123` | **`"123.0"`** | ❌（得念 `123.0`） |
| `true` / 数组 / 对象 | — | 400（驱动原文漏出，见 §3.3） |

**`scope: null` 最重**：`scope` 是 `PRIMARY KEY`，而 SQLite 里 **NULL 互不相等** ⇒
`ON CONFLICT(scope) DO UPDATE` **永不触发** ⇒ **每写一次多一行**：

```
第 1 次 → 200  库里行数=1
第 2 次 → 200  库里行数=2
第 3 次 → 200  库里行数=3
?scope=default → 空    ?scope= → 空    ?scope=null → 空   ← 三行谁都读不到
```

> 一个"写入接口返回 200 就说明它写好了"的印象，与一个"它确实写进去了、
> 但**没有任何一个读接口能把那一行取回来**"的事实，
> 在我没有换一个 `scope` 再试一次的时候是同一个东西。

`readScope` 会把 `null` / `''` / `'   '` **全都**归成 `'default'`（量过）；
路由只要用第三个参数（`(body, by, scope) => …`），上面四类后果**全部消失** —— **一个 token 的改动**。

### 3.2 ★★★ 最狠的一条：`scope: {}` ⇒ 200，而**位置参数整体错位一格**

```
POST { scope: {}, url: 'https://shifted/', branch: 'b', by: 'x' }  ⇒  200
库里那一行： scope='https://shifted/'   url='b'   branch='2026-09-20T…'   updatedAt=NULL
```

node:sqlite 把**对象**当**具名参数**，于是后面那些位置参数**整体往前提了一格**：
`scope←url`、`url←branch`、`branch←now()`、`updatedAt←NULL`。
HTTP 回的是 **200**，回执里包着这行**已经错位**的数据。

### 3.3 ★★ 布尔 / 数组 / 对象 ⇒ 400，而**驱动原文**直接漏给客户端

```
scope=true   → 400  "Provided value cannot be bound to SQLite parameter 1."
scope=[]     → 400  "Unknown named parameter '0'"
scope={a:1}  → 400  "Unknown named parameter 'a'"
```

既没翻译、也没包成具名码 —— 直接把 `node:sqlite` 的内部措辞漏出去了。

### 3.4 同类邻居

这与切片 24（键名不存在 ⇒ `undefined` 被 `JSON.stringify` 丢掉）、切片 26（模型配置警告被丢）、
切片 28（`err.plan` / `err.migration` 被定形信封丢掉）是**同一类**：
**写入成功、回执成功，而那条数据谁都拿不到。**

---

## 4. 其余量出来的事实（全部进了判据）

| 事实 | 读数 |
| --- | --- |
| GET | 200 `{ok, source}`；查不到时是**空占位** `{scope,url:'',branch:'',updatedAt:null}`（**不是 404**） |
| ★ `?scope=`（空串） | 落成 `scope:''` —— `'' ?? 'default'` 是 `''`（**空串不是 null**）；读的时候**不 trim** |
| POST 信封 | `{ok, task}` —— `handleWrite` 把结果**包在 `task` 里**（不是 spread） |
| ★ 缺 `by` | **400** `缺少操作者身份 by`（不是 401）；且一个字节都没写 |
| `url`/`branch` | **会** trim；`url` 缺/`null` ⇒ 空串；数字 ⇒ `'12345'` |
| ★ **完全不校验 URL** | `'这不是 URL'`、`javascript:alert(1)`、`file:///etc/passwd` 一律 200 |
| 空 `url` | 也是**合法写入** ⇒ "清空绑定"与"从来没绑过"在这一层长得一样（只差 `updatedAt`） |
| 同 scope 再写 | **upsert**，同一 `rowid`（不是删了重插） |
| 表结构 | `skill_sources(scope TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', updatedAt TEXT)` |

---

## 5. 破验：**12/16 咬住（真缺口 0、可证等价 4）+ 反方向 2/2**

### 5.1 ★★★ 反方向那一组是本片的主角

本片钉的是"`scope` 没走 `readScope`"这个**现状**，所以反方向就是**把它修对**：

```
✔ 咬住  R1  用上 `handleWrite` 的第三个参数 `(body, by, scope) => setSkillSource({ scope, … })`
            ⇒ ⑦⑧⑨⑩⑫ 全部变红
✔ 咬住  R2  只兜一层 `?? 'default'`（**部分**修复）
            ⇒ ⑦ 变红，而 ⑩（数字）/⑫（对象）**依然红** —— 部分修复只盖住一半
```

R2 咬住这件事本身有价值：它证明我的断言分得清"**修了一半**"与"**修完了**"。

### 5.2 4 条"可证等价"，理由全是查出来的

| 变异 | 为什么真的等价 |
| --- | --- |
| M4 GET 不再给空占位（`?? null`） | `getSkillSource` **永远**返回对象（`return row ?? {…}`）⇒ `?? null` 是**死代码** |
| M5 GET 不再 `try/catch` | 量过 **12 种** scope 取值（空串 / NUL / 4000 字 / 引号 / 分号 / 反斜杠 / 换行 / emoji / 数字 / 中文 / 重复参数）**全部 200**；`searchParams.get()` 拿到的永远是 `string`，域函数喂非字符串也不抛 ⇒ 那个 catch 是**防御性**的、没有可达路径 |
| M12 POST 不再接收 `by` | **回调本来就没引用 `by`**（`(body, by) => …`）；强制在 `handleWrite` 的 `requireMember` 里 |
| M13 去掉 `await handleWrite` | `handleWrite` **自吞异常且自写响应**，客户端拿到的 200/400 都在它把活儿干完之后才发出 |

> 一个"我少接了一个参数"的印象，与一个"那个参数**本来就没人用**"的事实，
> 在我没有先看看它被用在哪里的时候是同一个东西。

### 5.3 咬住的那 12 条里最要紧的

GET 缺省 `?? 'default'` 去掉 · GET 恒 `default`（不听查询串）· GET 顶层不回 `ok` ·
POST 不再走 `handleWrite`（by/审计/SSE 全没了，信封也变了）· POST 的 `scope` 落常量 ·
POST 的 `url`/`branch` 不传下去 · dispatch 不看方法 · dispatch 先认领再执行 ·
`match: 'exact'` 改成 `prefix`（`/api/skill-source/x` 会被捞住）。

逐字节还原 ✔、还原后复绿 ✔。

---

## 6. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7127 | **7120**（−7；`+8/−15`） | 9221（累计 **−2101**） |
| `handle()` 路由条件（抽取器口径） | 81 | **79** | 191 |
| `router.dispatch` 调用点 | 27 | **28** | 0 |
| `routes/` 族模块 | 27 | **28** | 0 |

**79 剩余 + 109 已搬 = 188** ✓ —— **已搬过 58.0%**（109 / 188）
被删区间 **15 行**（注释 2、路由 2），**丢注释 0 / 丢代码 0**
（本族段首是 `// ──` 分隔线注释 ⇒ 那 1 行跟着区间一起搬走，没有孤儿注释）

---

## 7. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 28 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 27 族读数未变** |
| **自由标识符常设判据** | ✅ 28 模块 / 未绑定 0 |
| 破验（正方向） | ✅ **12/16 咬住**，真缺口 0、可证等价 4（理由见 §5.2） |
| 破验（**反方向**：修 `scope` 归一） | ✅ **2/2 咬住**（含一条"只修一半"） |
| `skill-source-routes`（本族**首个**判据，也是这两条路由的首个判据） | ✅ **16/16** |
| 全量回归 | ✅ **62 套件 / 1077 例 / 1077 pass / 0 fail**（+1 套件、+16 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 109 / sources 46 / 族 28） |

---

## 8. 本片**没有**做

- ★★★ **`scope` 那个归一缺陷一处都没修**（本片只钉住现状、只把四类后果量清）。
  修法是**一个 token**（用 `handleWrite` 的第三个参数），但它会改**写入语义**
  （`''`/`'   '`/`null` 从"各自成空间"变成 `'default'`）—— **属行为契约变更，待业主裁决**。
- ★★ **`scope: {}` 那条位置参数错位、以及布尔/数组/对象的驱动原文外泄**，同样没修。
- 干净的多条组**已经搬完**了：还剩 `/api/model-bindings`（前缀跨两个作用域，欠"拆族或加 `F.paths`"的裁决）。
- 纠缠族与剩下的 **23 个单条组**未动；**`/api/events` 仍未搬**（需要增量写回 `live.bump`）。
- ★ 切片 22 / 24 / 26 / 27 / 28 的缺陷也都没修（`limit=2.7` → 500 **一个形状三处**，
  其中 `/api/activity` 还在 `server.mjs` 里；`CONTEXT_PLAN_ERRORS` 键名错；模型配置警告被丢；
  `null` 与"没给"在 `status`/`bytes`/`ms` 上落成两个值；定形信封吞掉 `err.plan`/`err.migration`）。
- 域逻辑仍在原处（`getSkillSource`/`setSkillSource` 连**独立文件都没有**），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；助手工具仍住在 `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释仍未补；其余 **79** 条条件仍在 `handle()`。

---

## 9. 复现命令

```powershell
node .worktrees/_prt-handoff/survey-judges2.mjs /api/skill-source    # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe29-skill-source.mjs                # 先量两条的形状
node .worktrees/_prt-handoff/probe29b-skill-source.mjs               # scope 没走 readScope 的四类后果
node .worktrees/_prt-handoff/probe29c-skill-source.mjs               # 每种 scope 类型的写入状态码
node .worktrees/_prt-handoff/probe29d-m5-reach.mjs                   # GET 那个 catch 有没有可达路径
node .worktrees/_prt-handoff/gen-family.mjs skill-source
node .worktrees/_prt-handoff/wire-family.mjs skill-source /api/skill-source createSkillSourceRoutes
node .worktrees/_prt-handoff/register-family.mjs skill-source 476ffab /api/skill-source team-hub/routes/skill-source.mjs createSkillSourceRoutes
node .worktrees/_prt-handoff/register-baseline.mjs skill-source team-hub/routes/skill-source.mjs skill-source createSkillSourceRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/skill-source-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice29.mjs
```
