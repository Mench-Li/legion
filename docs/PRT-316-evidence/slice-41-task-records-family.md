<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 · 切片 41：第三十九族 = 任务上的五张记录表（5 条）

> **一句话**：把 `handle()` 里 **5 条连续的路由**搬进 `team-hub/routes/task-records.mjs`；
> 这 5 条**跨 5 个不同前缀**，却是行号上紧挨着的一整块 ——
> 而在给它们加判据的过程中，**当场挖出一个既有缺陷**：
> 所谓"逐文件验收意见"，**每次都把之前所有文件的意见冲掉**。

| 项 | 值 |
| --- | --- |
| 族号 / 切片号 | 第 39 族 / 切片 41 |
| 模块 | `team-hub/routes/task-records.mjs`（215 行） |
| 判据 | `team-hub/task-records-routes.test.mjs`（**19 例**） |
| 搬走的 5 条 | `POST /api/progress`、`POST /api/patch`、`POST /api/review-notes`、`POST /api/artifact`、`POST /api/test-report`（全 `exact`） |
| 注入面 | `json, handleWrite, getTask, db, now, parseJson, audit`（7） |
| 规模 | `server.mjs` 6139 → **6038**（−101）；`handle()` 路由条件 22 → **17**；`dispatch` 调用点 38 → **39**；族模块 38 → **39** |
| 被删区间 | **111 行**（注释 7，路由 5），丢注释 0 / 丢代码 0 |
| 破验 | 有我方判据 **27/28 咬住**；**不给我方判据 0/28** ← 本片头条 |
| 回归 | 73 套件 / 1251 例 / 1251 pass / 0 fail |

---

## 一、★★★ 本片最重要的发现：「一个族 = 一个前缀」到这里**彻底不成立**

我照切片 39/40 的教训**先数间隔**，按**前缀**分组，得到的结论是：

> 剩余 22 条里，**没有任何一个前缀能凑出 2 条连续**。

按那个结论，我只能一条一条地搬。**但那个结论是错的，错在我的分组方式。**

`GET /api/roster`（L5552）与 `GET /api/overlaps`（L5616）是**两个不同的前缀**，
所以被判成"两个单条"；可它们在**行号上紧挨着** —— 中间什么都没有。

再往下一层才看清：`wire-family` 要的从来不是"同前缀"，
而是**任意一段连续的条件块** —— 前缀只是我一直用的**启发式**。

按行号重排之后，剩余 22 条的**前 5 条**恰好是连续的一整块（L5206–L5295，中间没有接缝）：

```
L5206  POST /api/progress      ★★★ 零判据
L5219  POST /api/patch         ★★★ 零判据
L5252  POST /api/review-notes  ★★★ 零判据
L5274  POST /api/artifact          有 1 处提及
L5295  POST /api/test-report   ★★★ 零判据
```

> 一个「按前缀分组就能看出哪些能凑成一段」的印象，
> 与一个「两个**不同**前缀的路由恰好紧挨着、本来就该一起搬」的事实，
> 在我按前缀而不是按**行号相邻**去分组的时候是同一个东西。

★ **顺带修正一个数**：`/api/artifact` 那 2 条相隔 **773 行** —— "一个前缀 = 一族"在这里
连**两条**都凑不齐。台账里把它记成"2 条一族"是错的。

---

## 二、★★★ 而它们还是**同一个形状**

5 条都是：`handleWrite` → 校验 → 改任务上**一张 JSON 记录表** → `version+1` → 回任务。

| 路由 | 记的表 | 语义 |
| --- | --- | --- |
| `POST /api/progress` | `claimedAt` | 上报进度 |
| `POST /api/patch` | `patches` | 改动补丁（文件清单 + diff） |
| `POST /api/review-notes` | `review_notes` | 逐文件验收意见（按 `file` 覆盖） |
| `POST /api/artifact` | `artifacts` | 产物登记 |
| `POST /api/test-report` | `testReport` | 测试报告 |

---

## 三、★★★ 本条最重的结果：**不给我方判据，28 个变异一个都没咬住**

| 破验方向 | 咬住 | 真缺口 | 可证等价 |
| --- | --- | --- | --- |
| 有我方判据 | **27 / 28** | 0 | 1（M18） |
| **不给我方判据** | **0 / 28** | **28** | 0 |

**不给我方判据时，28 个变异——包括 5 条把路径改成不存在的路径——没有一个被任何既有判据抓住。**

> 一个「这 5 条是 hub 的写面路由，总该有人守着吧」的印象，
> 与一个「把它们**整条删掉**都没人吭声」的事实，
> 在我**逐条**把这些变异投进去之前是同一个东西。

★ M18（去掉"同文件覆盖"的 `filter`）在**缺陷仍在**的前提下是**可证等价**：
`list` 恒为 `[]`，过滤与不过滤结果相同 —— 所以它"没咬住"不是判据薄，
而是那个缺陷**把这条语义整个吞掉了**。（M19 证明了那条路径是活的：一旦把缺陷"修好"，M18 的语义才会开始起作用。）

---

## 四、★★★ 当场挖出的既有缺陷：**逐文件意见攒不起来**

> **这不是本片引入的**（逐字对拍证明提取是忠实的），
> **它的根因是列名与接口字段名不一致。**

模块 `L127`：

```js
const list = parseJson(t.review_notes ?? '[]', [])
```

而 `getTask()` 回的是**接口形状**的任务 —— 它的字段叫 **`reviewNotes`**（驼峰），
**没有** `review_notes` 这个键（实测：34 个键里有 `reviewNotes`，`review_notes` 是 `undefined`）。

⇒ `t.review_notes` **恒为 `undefined`** ⇒ `list` **恒为 `[]`** ⇒ `others` 也恒为 `[]`
⇒ 只 `push` 这一条新意见，再把它**整张写回去**。

**实测（三连击）**：

```
put a.mjs/ok    ⇒ [{a}]      ✓
put b.mjs/issue ⇒ [{b}]      ← a.mjs 被冲掉了
put a.mjs/clear ⇒ []         ← b.mjs 也没了
```

**净效果**：所谓"逐文件验收意见"**根本不逐文件** ——
每写一条就把**之前所有文件**的意见冲掉；`verdict='clear'` 更是把**整张表**清空。

★ **这条路由此前一条判据都没有** —— 缺陷就住在没人看的地方。
★ 本片**只钉不修**：改它等于改行为，要业主裁决。
判据 `④b` 如实断言**当前**行为，并在注释里写明"修好之后这两条断言必须改"
（破验 M19 证明了这条判据是活的：把缺陷"修好"，`④b` 当场变红）。

---

## 五、★★★ 两条**注释里一个字都没写**的状态闸

| 路由 | 状态闸 | 错误文案 |
| --- | --- | --- |
| `POST /api/progress` | 只收 `in_progress` | `仅 in_progress 任务可上报进度（当前 todo）` |
| `POST /api/test-report` | 只收 `in_progress` / `in_review` | `仅 in_progress/in_review 可写报告（当前 todo）` |

★ `test-report` 的注释只写了"仅 tester 任务可写"，**没写**状态闸；
`progress` 的注释什么都没写。两条都是本片**实测**出来的。

★★ 另有一条同样没写进注释的规则：**`passed` 不是 `true` 时，`failures` 必须非空**
（L185：`if (!passed && failures.length === 0) throw`）——
传 `failures: []` **一样 400**（我第一版就栽在这儿）。

---

## 六、★★★ 生成器**连着第五片**拦住我，而且这次"点名字"点到了字符串里

第一道报未登记名字：**`audit`**（37 漏 `recordRunEventsBestEffort`、38 漏 `requireString`、39 漏 10 个、40 漏 3 个 + 多写 5 个）。

> 一个「这五条就是"改一个字段、version+1、回任务"」的印象，
> 与一个「它们还各自落一条审计」的事实，
> 在生成器替我点名字之前是同一个东西。

★★★ 但本片真正值得记的是**第二处**：生成出来的 `artifact` 路由是

```js
async run(req, res, { path, url }) {     // ← 两个都没用
```

- `path` 下面第 8 行就被 `const path = body.path` **遮蔽**了；
- `url` 从头到尾**没出现** —— 它是从 **`kind !== 'url'` 这个字符串字面量**里认出来的。

生成器 `gen-family.mjs` 的 `usedCtx`（L1501）**只剥了注释、没剥字符串字面量**；
而**下一行**（`usedPro`，L1507）早就写了 `blankLiterals(l)`。

> 一个「剥掉注释就够了」的印象，
> 与一个「它是从**字符串字面量** `'url'` 里认出来的」的事实，
> 在我看到**下一行**早就用了 `blankLiterals` 之前是同一个东西。

- ★ 已修：`usedCtx` 也走 `blankLiterals`（`check-blankliterals.mjs` 复核：`url` 消失）。
- ⚠️ **仍未修**：`path` 那一半 —— 它是本体内的**局部绑定**，同名遮蔽了 `ctx.path`。
  剥字面量治不了它，要连"本体内声明过的名字"一起排除。
- ★★★ 抓到它的是 **`check-free-identifiers`** —— `node --check` 与逐字对拍**都看不见**。
  这是"自由标识符"这一类失败的**又一次**现身，也是本片唯一一个**真缺陷**（已就地修掉）。

---

## 七、★★★ 破验中途抛错会**静默截断**（切片 39 的坑，本片又踩了两次）

`M10` 与 `M24` 的锚点各错一次：

- `M10` 我写的是 `if (!f || typeof f !== 'object') return null`，
  真身是 **`if (!path) return null`**（L91）；
- `M24` 我写的是 `if (req.method !== r.method) continue`，
  真身是 **`if (req.method !== r.method || !matches(r, ctx.path)) continue`**（L208）。

两次都是**整轮破验中断**，输出却像跑完了（`M11–M24` / `M25` 之后一条都没跑）。

> 一个「它列了这么多条，应该都跑过了」的印象，
> 与一个「它在第 10 条就抛了、后面 14 条一条没跑」的事实，
> 在输出末尾那句 `Error:` 被我当成收尾而不是中断的时候是同一个东西。

⚠️ **仍未修**：`mutate-lib.mjs` 应当在中断时**大声报出"只跑了 k / n 条"**。

★ 也正因为第一遍截断了，`M10c/M10d/M10e` 这三处（CSV 字符串输入分支、`diff` 大小上限、
文件数上限）**第一遍根本没被测**，是第二遍才暴露出来、再补判据的：

```
M10c  CSV 字符串那条输入分支        ← 第一遍漏掉：/api/patch 的 files 也收 'a.mjs,b.mjs'
M10d  diff > 200000 拒绝            ← 第一遍漏掉
M10e  文件清单截到 200              ← 第一遍漏掉
```

---

## 八、判据清单（19 例）

| # | 判据 |
| --- | --- |
| ① | 五条都要 `id`，且排在其它校验**之前** |
| ①b | 未知任务 ⇒ 400「未知任务 X」 |
| ①c | 五条都走 `handleWrite` 的操作者闸（`by` 最前） |
| ② | ★★★ `progress` 只收 `in_progress`（注释没写） |
| ③ | ★★★ `patch` 归一化：`status` 回落 `M`、`add/del` 取非负、`path` 截 500、非法项**丢弃** |
| ③b | ★★★ `patch` 也收 **CSV 字符串**（另一条输入分支） |
| ③c | ★★ `patch` 的 `diff` 有 200KB 上限（`>` 不是 `>=`） |
| ③d | ★★ 文件清单最多 200 条（截尾部） |
| ④ | ★★★ `review-notes` 的 `verdict` 只认 `ok\|issue\|clear`（**不是** pass/fail） |
| ④b | ★★★ 【钉住既有缺陷】逐文件意见攒不起来 + `clear` 清空 |
| ⑤ | ★★★ `artifact` 的 `kind` 只认 `html\|file\|url`，`path` 必填 |
| ⑤b | ★★ `digest` 只在十六进制长度 ≥16 时落库 |
| ⑥ | ★★★ `test-report` 仅 `tester`（注释写了）+ 仅 `in_progress/in_review`（**没写**） |
| ⑥b | ★★★ `passed` 严格 `=== true`；`passed=false` 时 `failures` **必须非空** |
| ⑥c | ★★ `failures` 归一化：三字段、非对象包成对象、最多 200、各自截断 |
| ⑦ | ★★★ 五条**都** `version+1`（乐观锁） |
| ⑧ | ★★★ dispatch 契约：看方法、命中回 true、不命中 false、`exact` 不退化成 `prefix` |
| ⑨ | ★★★ 不许吃掉同前缀的兄弟 `GET /api/artifact/content`（它在 L6047，不属本片） |
| ⑩ | ★★ 缺注入项 ⇒ **构造时**就抛（fail closed） |

---

## 九、九道门禁与回归

- 九道门禁 **9/9**
- 全量回归 **73 套件 / 1251 例 / 1251 pass / 0 fail**（+1 套件、+19 例）
- 逐字对拍：**39 族**路由一条没丢、体逐行按位置相同、无副本、装配到位
- `check-region-lines`：区间 **111 行**，丢注释 0 / 丢代码 0，**39 族全部零丢失**
- `check-free-identifiers`：**39 模块 / 未绑定 0**
- `baseline-snapshot --check`：无漂移

---

## 十、⚠️ 本片**没有做**

- `POST /api/artifact/content`（`GET`，L6047）**仍在 `server.mjs` 里** —— 它与本族的
  `/api/artifact` 同前缀但相隔 773 行，**不属本片**；接缝已明文标注"别顺手搬走"。
- ★★★ **`/api/review-notes` 那个缺陷本片只钉不修** —— 改它等于改行为，要业主裁决。
- ★ `gen-family.mjs` 的 `usedCtx` 对**本体内局部绑定**的误判（`path` 那一半）**仍未修**。
- ★★★ `mutate-lib.mjs` 的"中途抛错静默截断"**仍未修**。
- ★★★ 四个工具的修法**仍只落在助手区**（**第十一片**）：EOL 容忍、前缀兄弟检测、`blankLiterals`。
- ★★★ 破验的 `TESTS` 清单仍是**手工维护**。
- ★★★ **没有任何东西阻止"边测边动同一棵工作树"**。
- ★ 接缝契约只给 9 族补过，其余 **30 族**的 `dispatch` 契约仍无判据。
- ★★★ 回归选择器**只扫 `team-hub/`** —— 本片又添一个反例：这 5 条的语义靠的是
  `scratch/` 与 `scripts/` 里的调用方，而那些**不在选择器里**。
- `group-remaining.mjs` 的「分段」算法**仍没修**（本片又一次证明了它为什么错）。
- 切片 1~5 丢失的注释仍未补；`/api/events` 仍未搬。
- 余下 **17 条**：`POST /api/goal/slices`、`POST /api/spaces`、`POST /api/spaces/`、
  `GET /api/artifact/content`、`POST /api/runtime/run-budget/may-switch-model`、
  `GET /api/team-plan`、`GET /api/task-feedback`、`POST /api/heartbeat`、`GET /api/roster`、
  `GET /api/overlaps`、`GET /api/activity`、`POST /api/pipeline`、`POST /api/agents`、
  `GET /api/skills`、`GET /api/documents`、`GET /api/events`、`GET /api/event-delivery`。
