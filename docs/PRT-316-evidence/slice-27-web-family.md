<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 27：第二十六族 = 浏览器助手抓取历史（`/api/web` 三条）—— `limit=2.7` 那个 500 是**一个形状**

- **族**：`web`（`team-hub/routes/web.mjs`），**3 条**：
  - `POST /api/web/history`（入表 / 累加）
  - `GET /api/web/history`（读一版 + 统计）
  - `POST /api/web/history/clear`（清一个 / 清一空间）
- **参考提交**：搬走前 `6d50295`
- **规模**：80 行、3 条、**外来 0**、**分段 1**

---

## 1. 为什么挑它

按"前缀组"地图，干净的多条组里 `/api/web`（3 条 / 80 行）是**行数最多**的那一组
（其余干净组：`/api/model-migration` 2 条 / 49 行、`/api/skill-source` 2 条 / 14 行）。
前缀 `/api/web` 只捞这 3 条（量过无碰撞）。

★ 与前几片**相反**的一点：本族**自己**读体（`readBody`），**不走 `handleWrite`** ——
所以它**没有** `{ok:true, task:{…}}` 那个信封，也**不需要 `body.by`**。
整族三条都没有操作者那道门。

## 2. ★★ 搬走前**一把判据都没有**

`survey-judges2` 对三个路径全报 **"强判据 0 套、请求点合计 0"**。
⇒ 同样**先写判据、再破验**（形状全部是量出来的）。

---

## 3. ★★★ 切片 22 那个 `limit=2.7` → 500 **不是一处巧合，是一个形状**

切片 22 在 `/api/team-plans` 上量到 `limit=2.7` → 500。这一片在
`/api/web/history` 上量到**一模一样**的读数：

```
GET /api/web/history?scope=r1&limit=2.7  ⇒  500 {"error":"datatype mismatch"}
```

于是我不再当它是两处巧合，而是去找**那个形状**：

```js
const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 200)
//                                                     ↑ 2.7 通过了 Math.min（它是有限数）
… db.prepare('… LIMIT ?').all(scope, limit)            // ← 2.7 直接进了 SQL 的 LIMIT
```

我数了全仓，这个形状**还剩 2 处**（`Math.min(Number(...), N)`），
其中一处就是我刚搬的这一条，另一处**还在 `server.mjs` 里**
（`/api/activity`，那个 `?? 50 || 50, 500`）。我又直接量了它：

```
GET /api/activity?scope=default&limit=2.7  ⇒  500 {"error":"datatype mismatch"}
```

**三处同形、三处同读数、错误指纹都是 `datatype mismatch`。**

> 一个"`limit=2.7` 是那一族的一个 bug"的印象，
> 与一个"它是**一个形状**、而我只在恰好搬到的那一族上撞见了它"的事实，
> 在我没有拿着那个形状去全仓数一遍的时候是同一个东西。

**修法**（我没做，属产品语义，要业主裁决）：三处都该
`Math.floor` + 显式区间夹取；`limit=0` 与负数也该各有一个明确语义
（现在是"0 落回 30"、"负数把上限整个绕过去"，见 §4）。

---

## 4. 其余量出来的事实（全部进了判据）

| 事实 | 读数 |
| --- | --- |
| 写是 `{ok, id, hits, updated, trimmed}` | ★ **只有新建那条路有 `trimmed`**（容量裁剪只发生在新建时） |
| ★ **不需要 `body.by`** | 与 `/api/models`、`/api/exec` 那些走 `handleWrite` 的族**相反** |
| 累加 | 同 `(scope,url)` 复用同一行、`hits` 递增（**历史是"抓过哪些地址"，不是逐次流水**） |
| `host` | 从 URL 取；★ **非法 URL 也照记**（host 落空串）—— 抓失败本身也要留痕 |
| 截断 | `title` ≤ 300、`excerpt` ≤ 500（边界两侧都量过：299/300/301） |
| 读 | `{scope, items(14 格), stats{total,failed,bytes,shown}}`；缺 scope → 400；未知空间 → 200 空 |
| ★ `q=` | 大小写不敏感、匹配 url **与** title、**只筛 items** —— `stats` 仍是**全空间**的 |
| `limit` | 默认 30；`0` 落回 **30**（不是"一条都不要"）；`abc` 落回 30；**负数 = 不限**（SQLite 的负 LIMIT）；夹到 200 |
| `clear` | `{ok, removed}`；给 `id` 删一条、不给删一空间；**幂等**；只动自己那个空间 |
| `maxPerScope` | 默认 200、夹到 2000；裁掉**最旧**的（`ORDER BY updatedAt ASC`）；`0`/负数/非数字落回 200 |

### 4.1 ★★ `null` 与"没给"落成**两个不同的值**

`status`/`bytes`/`ms` 的判据是 `Number.isFinite(Number(body.x)) ? Number(body.x) : null`：

| 输入 | `Number(x)` | 回执 |
| --- | --- | --- |
| **省略** | `Number(undefined)` = **NaN** | `null` |
| **显式 `null`** | `Number(null)` = **0**（有限！） | **`0`** |
| **空串 `''`** | `Number('')` = **0** | **`0`** |
| `false` | `Number(false)` = **0** | **`0`** |
| `'abc'` | NaN | `null` |

于是**显式传 `{"status": null}` 的客户端拿到的是 `status: 0`**（看着像"HTTP 0"），
而**省略**同一个键拿到的是 `null`。

> 一个"没给就是 null"的判据，与一个"`Number(null)` 是 0、`Number(undefined)` 是 NaN"的事实，
> 在我没有把「省略」和「显式 null」**各试一次**的时候是同一个东西。

### 4.2 ★ `errorCode: ''` 会被算成**一次失败**

入库那步是 `body.errorCode == null ? null : String(body.errorCode)` ⇒ 空串存成**空串**；
统计那步判的是 `errorCode IS NOT NULL` ⇒ 空串**算失败**。

★ 这一格我第一版**写错了**：我断言 `failed === 1`（以为空串 ≈ 没给），红了 —— **是我错了**。
判据改成钉住现状（`failed === 2`），并写明"若这条红了说明有人把空串归一成 NULL 了，那是修对了"。

---

## 5. 破验：**32/33 咬住**（真缺口 0，可证等价 1）

### 5.1 第一次跑是 28/32 —— 四条没咬住，**全部是我的断言不够**

| 变异 | 我为什么没咬住 | 修法 |
| --- | --- | --- |
| M16 `limit` 不再夹 200 | 那个空间**只有 12 行** ⇒ "夹到 200"与"根本不夹"**同一个读数** | 直接用 SQL 造 **260 行**再读 |
| M26 给不给 `id` 都清整个空间 | 那个空间**恰好只有 1 行** ⇒ 两种行为**同一个读数** | 造 **2 行**、按 id 删一条、断言另一条还在 |
| M30 `maxPerScope` 不夹 2000 | 只有 1 行 | 造 **2001 行**再写一条 |
| M9 `status` 归一改坏 | 见 §5.2（它**真的**等价） | 标成可证等价 |

> 一个"我测过上限"的印象，与一个"我测的那个空间**装不到上限**、
> 于是有没有夹完全看不出来"的事实，在我没有把行数造过上限的时候是同一个东西。

### 5.2 ★★★ M9 判可证等价的理由，与 M9b 构成一对

`status` 只有**两条出口**：回执里 `status: r.status`（经 `JSON.stringify`）与库里那一列。
而量过 node:sqlite 对 `NaN`/`±Infinity` 的处理：

```
写入 NaN       ⇒ 读回 null  typeof=null
写入 Infinity  ⇒ 读回 null  typeof=real     ← 存的是 Inf，只是 JSON.stringify 把它变成 null
求和：SUM(a) = null
```

`JSON.stringify(NaN/Infinity/null)` **一律是 null**，而 `status` **没有任何聚合** ⇒ 两条出口都看不出差别。

★ 但**同一个改动放在 `bytes` 上就不等价了**，因为 `stats.bytes` 是 `SUM(bytes)`：

```
✖ M9  （改 status）→ 没咬住 …… 可证等价
✔ M9b（改 bytes） → 咬住
```

**同样的改法、不同的字段、不同的结论** —— 而且理由是**那条聚合**。
这是能给出的最强形式的证明：它不是"我断言写少了"，而是"这个字段真的没有出口"。

### 5.3 其余 31 条里最要紧的

`(scope,url)` 不再累加（改成永远插新行）· 更新时 `hits` 不再 +1 ·
`stats` 跟着筛完的 rows 走（不再是全空间）· `failed` 不看 `errorCode` ·
裁剪方向反了（裁掉**最新**的）· `DELETE` 不限定 `scope` · `q` 大小写敏感 / 不匹配 title ·
更新那条也回 `trimmed`（把不对称抹平）· `title`/`excerpt` 不截断 · `cached` 改成严格判真。

两条**反方向**的判据（改**对**了要变红）也咬住了：
M10（把 `null` 与"没给"同归 null）与 M18（给 `limit` 取整 ⇒ 那个 500 被修掉）。

逐字节还原 ✔、还原后复绿 ✔。

---

## 6. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7247 | **7172**（−75；`+8/−83`） | 9221（累计 **−2049**） |
| `handle()` 路由条件（抽取器口径） | 86 | **83** | 191 |
| `router.dispatch` 调用点 | 25 | **26** | 0 |
| `routes/` 族模块 | 25 | **26** | 0 |

**83 剩余 + 105 已搬 = 188** ✓ —— **已搬过 55.9%**（105 / 188）
被删区间 **80 行**（注释 1、路由 3），**丢注释 0 / 丢代码 0**
（`−83` 里的另外 3 行是下面那处孤儿注释。）

★ 又清掉一处**孤儿注释**（这次是 **3 行**的段首说明）。根因与切片 26 同一个，
但这一片把机制说清楚了：**生成器早把这段注释当"段首说明"逐字搬进了模块，
而接线工具删的是另一个区间** —— 一边抄了、另一边没删。

★ 顺带量到一个**新事实**：生成器搬注释时会**归一化** `//x` → `// x`
（原文第 3 行是 `//（逐次审计`，模块里成了 `// （逐次审计`）。
生成器那句"逐字搬入"核对的是**行数与有没有缺行**，不是字节相等 ——
我的删除脚本第一版按字节比，因此**没找到**那 3 行。

> 一个"逐字搬入"的 ✔，与一个"它搬的是**归一化之后**的形态"的事实，
> 在我拿原文的字节去比之前是同一个东西。

---

## 7. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 26 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 25 族读数未变** |
| **自由标识符常设判据** | ✅ 26 模块 / 未绑定 0 |
| 破验 | ✅ **32/33 咬住**，真缺口 0、可证等价 1（M9，理由见 §5.2） |
| `web-routes`（本片新判据，本族**首个**判据） | ✅ **23/23** |
| 全量回归 | ✅ **60 套件 / 1041 例 / 1041 pass / 0 fail**（+1 套件、+23 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 105 / sources 44 / 族 26） |

---

## 8. 本片**没有**做

- `/api/model-migration`（2 条 / 49 行，干净）、`/api/skill-source`（2 条 / 14 行，干净）—— 都留着。
- `/api/model-bindings`（前缀跨两个作用域，仍欠"拆族或加 `F.paths`"的裁决）。
- 纠缠族与剩下的 **23 个单条组**未动。
- **`/api/events` 仍未搬**（写宿主可变计数，需要增量写回 `live.bump`）。
- ★★ **那三处 `limit=2.7` → 500 一处都没修**（本片只钉住现状、只把形状数清楚）；
  `/api/activity` 那一处**还在 `server.mjs` 里**，本片依然没碰。
- ★ **切片 22 / 24 / 26 的缺陷也都没修**：`limit=2.7`（本片已升级为"一个形状、三处") ·
  `CONTEXT_PLAN_ERRORS` 键名错（含 `server.mjs` 里 `/api/team-plan` 那处）· 模型配置警告被丢掉。
- 域逻辑仍在原处（本族的表、`readBody` 都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；助手工具仍住在 `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **83** 条条件仍在 `handle()`。

---

## 9. 复现命令

```powershell
node .worktrees/_prt-handoff/group-remaining.mjs
node .worktrees/_prt-handoff/survey-judges2.mjs /api/web          # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe27-web.mjs                      # 先量三条的形状
node .worktrees/_prt-handoff/probe27b-web.mjs                     # limit 与数值归一（要多行）
node .worktrees/_prt-handoff/probe27c-activity.mjs                # 第三处同形（还在 server.mjs 里）
node .worktrees/_prt-handoff/probe27d-nan.mjs                     # NaN/Infinity 能不能观测
node .worktrees/_prt-handoff/count-limit-pattern.mjs              # 数那个形状还剩几处
node .worktrees/_prt-handoff/gen-family.mjs web
node .worktrees/_prt-handoff/wire-family.mjs web /api/web createWebRoutes
node .worktrees/_prt-handoff/drop-orphan-comment27.mjs
node .worktrees/_prt-handoff/register-family.mjs web 6d50295 /api/web team-hub/routes/web.mjs createWebRoutes
node .worktrees/_prt-handoff/register-baseline.mjs web team-hub/routes/web.mjs web createWebRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/web-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice27.mjs
```
