<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 13：第十三族 = 模型档案（model-profiles）

- 切片：13／13 族
- 提交：见 `git log`（`feat(PRT-316 切片 13)`）
- 业主裁决依据：2026-09-20「乙：按『一片一次对拍』开工」
- 硬约束：`docs/superpowers/specs/*` `:1282`（每片能独立对拍与回滚）、`:1283`（§13 Program 级停止条件优先于排期）

## 一、选族

| 候选 | 路由数 | 跨度 | 既有 HTTP 套件 | 结论 |
| --- | --- | --- | --- | --- |
| **model-profiles** | **7** | 133 行 | `model-routes.test.mjs`（14 例） | **本片选它** |
| models | 3 | 31 | 有 | 留下片 |
| price-tables | 3 | 16 | 有 | 留下片 |
| config-bundle / usage | 3 / 3 | 56 / 64 | 有 | 留下片 |
| runtime | 26 | 2182 行 | — | **不内聚**，跨度太大 |

选它的理由：**7 条**是本片为止单族最多；区间连续、无夹入他族；且它带着一套看着很厚的既有套件。

## 二、★★★ 本片真正的产出：三种"没有判据"是不同的东西

上一片（切片 12）翻出的是一条**一直是空的**断言。这一片翻出的是**一整条没有 HTTP 判据的路由**，以及**一份判据名单漏掉了一整个套件**。

### 2.1 `POST /api/model-profiles/<id>/probe` 此前**没有任何 HTTP 层判据**

- `team-hub/model-routes.test.mjs`：14 例，覆盖 list／create／GET 单条／PATCH／PUT／DELETE／审计／401 —— **`probe` 一条都没有**。
- `team-hub/probe-service.test.mjs`：`listen(0)` **0** 次、`fetch(` **0** 次 —— 它验的是**服务层**（直接 import 那个函数）。

于是这一条路由的五个校验分支、墓碑 409、以及「没探测过 ⇒ 503」，**在搬走之前就没有判据**；搬走之后当然也没有。

> 一条"这一族有既有套件"的印象，与一条"既有套件真的覆盖了这条路由"的事实，
> 在没有人为**每一条**路由点过名的时候是同一个东西。

### 2.2 一条"按路径认族"的判据，漏掉了一整个套件

我最初是按 `grep '/api/model-profiles'` 去列"哪些套件判这一族"的。`probe-service.test.mjs` **一次都没提过这个路径** —— 但它里面有一条**结构化断言**：

```js
assert.match(server, /probeModelProfile\(/, '必须有路由调用它')
```

它是被判据覆盖的，只是**不在我列的那张名单上**。它由**全量回归**抓出来（51 套件里 1 红），不是由我那张名单。

> 这与会话里反复出现的那一族同形：判据本身是**对的**，错的是"我以为它看的是哪些文件"。

### 2.3 那条断言与切片 12 的测试⑤是**同一族**

搬家之后它**如实**变红 —— 但红的原因不是"没有调用方了"，而是"调用方换了住处"。修法是把判据**跟着代码的去处走**：不再钉死 `server.mjs`，改成按 `ROUTE_FAMILY_SOURCES`（"路由代码现在住哪"的唯一权威名单）去找。

修完的判据**更强**：它现在还会核对"调用方真的是某一族路由，且是模型档案族"，而不只是"某个文件里有这串字"。并单独验过它**真的会咬**（只看**这一条**红没红）：

| 注入 | 整份套件 | 目标用例是否咬住 |
| --- | --- | --- |
| 基线 | 绿 | 否（应当如此） |
| 删掉模块里唯一的 `probeModelProfile(` 调用 | 红 | ✅ |
| 把它改名成 `probeModelProfileRenamed(` | 红 | ✅ |

## 三、★★★ 第一个带「块前言」的族

`model-profiles` 的前 2 条路由在裸块**外面**，后 5 条裹在一个裸块里，块内先声明两个**共享局部**：

```js
{
  const MODEL_PREFIX = '/api/model-profiles/'
  const modelId = () => { … decodeURIComponent(path.slice(MODEL_PREFIX.length)) … }
  if (req.method === 'POST' && path.startsWith('…') && path.endsWith('/probe')) { … }   // ← 后 5 条
}
```

前十二族都是"每条路由各管各的"，所以生成器（和"路由 = 一条独立的体"这个模型）**没有前言这个概念**。它**响亮地失败了**（`✖ 有未登记的名字：modelId`），而不是安静地搬走一半 —— 这正是 `node --check` 看不见的那种错：`modelId is not defined` 是**运行时**才炸的。

处置（三条都不许省）：

1. **前言逐字搬走**，包成"接收 ctx 的小函数"，在 `dispatch` 里**按请求**求值 ⇒ 与前缀路由**同一套逐条绑定**，不新开一条路。
2. 前言里逐字引用的 `path` 由 `dispatch` 传进来 —— **不能平铺进工厂体**：工厂体里没有 `path`。
3. 前言里声明的名字（`MODEL_PREFIX`、`modelId`）按**每条路由的体**核算谁真的用了，只给那些路由解构。

> 平移进工厂体，与包成按请求求值的函数，
> 在**没人核对前言那个作用域**的时候看起来是同一件事。

## 四、★★★ 破验 23/24 —— 9 条真缺口**集中在同一类**

第一轮 **15/24 咬住、9 条真缺口**，9 条**全部**是"这条路由从来没有 HTTP 判据"：

| 缺口 | 真行为 | 为什么没被发现 |
| --- | --- | --- |
| **K8** | `?includeDeleted=1` 是**字面量**比较，`=0`／`=x` 都不带墓碑 | 既有 14 例里只有 `=1` 被喂过 |
| **K9** | 列表回 `serverTimeMs` | 断言过 `profiles`，**没断言过**时间戳 |
| **K10** | `body.profile ?? body` 的顶层兜底 | 顶层形态**必然** 400（见下），没人喂过 |
| **K11** | `/probe` 空 id → 400 `MISSING_PARAM` | probe 路由**零** HTTP 判据 |
| **K12** | 编码斜杠 `%2F` → 400 `BAD_ID_ENCODING` | 同上（且与 GET 那条是**两套代码**） |
| **K13** | 坏编码 → 400 `BAD_ID_ENCODING` | 同上 |
| **K14** | 墓碑 → 409 `PROFILE_DELETED`（**不是** 404） | 同上 |
| **K15** | `force` 默认 **true** | 同上 |
| **K16** | `unavailable` → 503（不是 200） | 同上 |
| **K20** | PUT 是**整体替换**，缺 version → 400、旧版本 → 409 | PUT 一条判据都没有（PATCH 有） |
| **K22** | `/probe` 后缀是**必需**的，别的后缀落回 404 | 只喂过"刚刚好正确"的路径 |
| **K23** | PATCH／PUT／DELETE 的 id 守卫（400 ×2） | 只有 GET 的那两条有判据 |

> 一个"收了参数并把它传下去"的路由，与一个"收了参数然后丢掉"的路由，
> 在没有用例问过**那个参数的效果**的时候，是同一个东西。

这与切片 8／9／10／11／12 是**同一族**：**用例只喂过"刚刚好正确"的输入**。补判据后 **23/24 咬住、0 真缺口**，仅 K7（把"每请求求值前言"改成"求值一次"）判为**可证等价** —— 求值本身无副作用，且判定结果与被测请求无关。

★ 缺口里的 **K10 值得单记**：`body.profile ?? body` 看着像"两种形态都收"，但 `actor` **必填**且从 body 顶层读，而它同时是 profile 的**未知字段** ⇒ 顶层形态在带 actor 时**必然** 400 `INVALID_PROFILE`。这一条**不修**（零改写是纪律），**记成契约**钉住，与 secrets 那两处 claimed-vs-actual 同类。

## 五、★★★ 我自己写坏了四处，全部是"前提没被核对"

1. **`usedCtx` 与 `r.usedCtx` 用错** —— 日志打的是 `r.usedCtx`（说 `→{modelId}`），文件里写的是局部的 `usedCtx`（写 `async run(req, res) {`）。
   ⇒ 运行期 `modelId is not defined`，**500**；而 `node --check` **通过**，生成期自由标识符核对**也通过**（它只核名字有没有登记，不核解构里有没有它）。
   > 一份"说它会绑定"的日志，与一份"真的绑定了"的代码，在两者不是同一个变量的时候看起来是一致的。
   抓到它的不是哪道门禁，是**既有的 14 例端到端用例**（10 红）。
2. **追加测试块时把 LF 拼进了 CRLF 文件** ⇒ 文件变成**混合换行**，而 `node --check` 通过、`includes('\r\n')` 也通过（前 253 行都是 CRLF）。
   > 一个"这个文件是 CRLF"的判据，与一个"这个文件的**每一行**都是 CRLF"的判据，在只有最后追加的那几十行是 LF 的时候是同一个东西。
   现在追加脚本逐行核验"每一行都以 NL 结尾"，并断言"无裸 LF"。
3. **我自己新写的断言错了**：`assert.equal(res.body.probe, 'ok')`，而判定对象是**原样透传**的 ⇒ 实际是 `{ verdict: 'ok' }`。**改的是断言，不是产品**。
4. **`\'` → `'` 的变换把测试标题打断**（**两次**）：`test('⑧ probe 的 '/probe' …` ⇒ `SyntaxError: missing ) after argument list`。这是切片 11 那族的**第三、四次**复发：**字符串里的错误被报成调用语法错误**。改用双引号标题即可。

## 六、★ 一个数字差点被用错

我用私有正则数 `handle()` 里的路由条件，得 **119**；权威抽取器（`extractRoutes`）给 **118**。差的那一条是：

```
L5029: if (req.method === 'OPTIONS') {   ← CORS 预检，没有 path
```

抽取器**正确地**不把它当路由。若照私有正则报数，`已搬 + 剩余 = 188` 这条独立旁证就会**差一**，而那条旁证正是本片最硬的对拍依据。

> 一个"以 `req.method` 开头"的正则，与一个"真的是路由"的判据，
> 在文件里没有 CORS 预检的时候是同一个东西。

## 七、判据

| 判据 | 结果 |
| --- | --- |
| 十三族逐字对拍 ①②③⑤ | ✅ 全过；`dispatch` **13** 处；路由表合计 **70** 条 |
| 跨族遮蔽 | ✅ 无遮蔽 |
| 块前言专项核对（新增 `check-prologue.mjs`） | ✅ 16 行逐字相同、`return` 名单一致、形参覆盖、4 个 `modelId` 调用点全部解构 |
| 破验 | **23/24 咬住 / 0 真缺口 / 1 可证等价** |
| 迁移后既有套件 | `model-routes` **14 → 28**、`probe-service` **13**、`config-bundle-routes` 18、`binding-routes` 10 —— 全绿 |
| 全量回归 | **51 套件 / 881 例 / 881 pass / 0 fail** |
| 九道门禁 | **9/9**；元测试 25/25、49/49、18/18 |
| 基线 | 仍 **188** 条路由、**丢失 0**、`sources` 30 → **31** |

★ **独立计数旁证（抽取器口径）**：**70 已搬 + 118 剩余 = 188** = `httpRoutes` 188。

### 为什么前言要单独一件判据

`pair-routes.mjs` 的判据②是"**体**逐行按位置相同"，而前言**不属于任何一条路由的体** —— 它是对拍的一个结构性盲区。这与切片 6 那条同源（"对拍只比函数体，而理由从来不在函数体里"）。所以新增 `check-prologue.mjs`，把原文裸块里那道前言与模块里 `prologue` 函数体逐行比。

## 八、规模

| 量 | 10 后 | 11 后 | 12 后 | **13 后** |
| --- | --- | --- | --- | --- |
| `server.mjs` | 8494 | 8413 | 8292 | **8160** |
| `handle()` | 3425 | 3336 | 3207 | **3069** |
| 路由条件（抽取器口径） | 133 | 130 | 125 | **118** |

本片 **−132 行 / −138 行 / −7 条**；累计 **−1061 行**（原始 9221）。

## 九、本片**没有**做

- 域逻辑（`modelStore` 的 CRUD、`validateProfile`、版本/CAS、`probeService`）仍在各自模块里。
- 其余 **118** 条路由条件仍在 `handle()`；`handle` 仍 **3069 行**。
- `body.profile ?? body` 的顶层兜底**可达但必败**（见 4.10）—— 只记成契约，未"修"。
- `probe` 路由的 `force` 在**真 HTTP** 下不可观测（本环境没有可填 endpoint 的档案，永远停在 503）；那一条走的是**计数桩**（⑦ 段），已在文档中标明。
- 段首注释三处**过期数字**（automation「五条」/experience「四条」/connectors「四条」）仍未改。
- `runtime`（26 条、跨度 2182 行、分散）等不内聚大族未动。

## 十、复现命令

```powershell
node .worktrees/_prt-handoff/gen-family.mjs model-profiles
node .worktrees/_prt-handoff/wire-family.mjs model-profiles /api/model-profiles createModelProfilesRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-shadowing.mjs
node .worktrees/_prt-handoff/check-prologue.mjs
node .worktrees/_prt-handoff/mutate-slice13.mjs
node .worktrees/_prt-handoff/verify-probe-service-test-bites.mjs
node .worktrees/_prt-handoff/probe-slice13-behavior.mjs   # 量 probe 的真实行为
node .worktrees/_prt-handoff/probe-slice13-gaps.mjs       # 量 K20/K22/K23 的真实行为
node .worktrees/_prt-handoff/count-routes13.mjs           # 抽取器口径的 70 + 118 = 188
node --test team-hub/model-routes.test.mjs
node --test team-hub/probe-service.test.mjs
```
