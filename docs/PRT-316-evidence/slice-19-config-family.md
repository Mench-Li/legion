<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 19：第十八族 = `/api/config`（能力发现）—— 走**活绑定**的第一族

- **族**：`config`（`team-hub/routes/config.mjs`），1 条路由：`GET /api/config`（精确）
- **参考提交**：搬走前 `b92dc6e`
- **为什么是它**：见 §1 —— 本片选族依据被**两次订正**，两次都推翻了"最强判据"的结论

---

## 1. 选族：被两条自己的判据连续拦住三次

### 1.1 第一轮（切片 18 结尾）：`/api/config` = 37 个请求点，判据最强

订正后的选族器给出第一名 `/api/config`（**37 点**）。为它做依赖调研时发现它读宿主的
`let deliveryBookkeepingFailures`，而那个变量在三处被 `+= 1` ⇒ **被可变绑定守卫拦下**。

当时我把它报成"判据最强但不能搬"，并说下一步去试"不改写体的第三条路"。

### 1.2 ★★★ 第二轮：37 是假的 —— 那是我自己的选族器在**子串**上匹配

先做了一件更基础的事：量清"**到底有几个族被可变绑定挡住**"（若只挡一族，不值得为它改接缝；
若挡一片，才值得）。为此写了 `rank3.mjs`。第一版跑出 **0 个族被挡住** —— 与已知事实矛盾。

自检（`debug-rank3.mjs`）抓到两处：

| # | 缺陷 | 后果 |
| --- | --- | --- |
| ① | 区间取成 `L.slice(首条条件, 末条条件)` | 对**单条**条件的族，这就是**那一行 `if` 本身** ⇒ 体里的名字一个都扫不到 |
| ② | 判据扫描用 `includes(key)` | `/api/config` 是 `/api/config-bundle` 的**前缀** ⇒ `config-bundle-routes.test.mjs` 的 **30 个请求点**被算到 `/api/config` 头上 |

> 一个"这一族的区间我取进来了"的判据，与一个"我取的是区间首尾那两行、而单条条件的族首尾就是同一行"
> 的事实，在这一族恰好只有一条路由的时候是同一个东西。

> 一个"这个套件提到了本族路径"的判据，与一个"本族路径是**另一个族路径的前缀**"的事实，
> 在我用子串而不是边界去匹配的时候是同一个东西。

修完（花括号配平求体结束位置 + 路径边界正则）后的**真实**读数：

| 族 | 真实请求点 | 可变绑定 |
| --- | --- | --- |
| `/api/config` | **7**（不是 37） | ⛔ `deliveryBookkeepingFailures` |
| `/api/events` | 6 | ⛔ 同一个 |
| `/api/create` | 10 | — |
| `/api/comment` | 8 | — |
| `/api/team-plans` | 7 | — |

⇒ 内聚族里被可变绑定挡住的：**2 个 / 2 条路由 / 13 个请求点**。

**结论没变**（`/api/config` 仍是"判据最强但被挡住"的族），但**理由和数字都换了**。

### 1.3 ★★★ 第三轮：第三条路存在，而且不需要改写体

上一轮我说"要搬得先决定对策（注入取值函数），而那会**改写体**、与零注入改写冲突"。
这句话是错的 —— 我漏了一种写法：

把可变名字声明成**工厂作用域里的 `let`**，并在**本族自己的 `dispatch` 开头**从宿主给的
`live()` 重取一次。

```js
// 生成的壳（体一字未改）
export function createConfigRoutes({ json, TOKEN, DB_FILE, PORT,
                                     tokenizerRegistryStatus, eventClients, live }) {
  if (typeof live !== 'function') throw new TypeError('缺注入项：live（可变绑定需要每请求同步）')
  let deliveryBookkeepingFailures = live().deliveryBookkeepingFailures
  const syncLive = () => {
    const v = live()
    if (v.deliveryBookkeepingFailures === undefined || v.deliveryBookkeepingFailures === null)
      throw new TypeError(`live() 没给 deliveryBookkeepingFailures`)
    deliveryBookkeepingFailures = v.deliveryBookkeepingFailures
  }
  // …路由体里照旧写 `bookkeepingFailures: deliveryBookkeepingFailures`，一字未改…
  return {
    async dispatch(req, res, ctx) {
      syncLive()                                   // ← 唯一的同步点
      for (const r of routes) { /* … */ }
    },
  }
}
```

宿主装配处：`live: () => ({ deliveryBookkeepingFailures })` —— **每次请求现取**。

三条性质同时成立：

| 性质 | 为什么 |
| --- | --- |
| 体**一字未改** | 体里还是读那个名字，只是它现在是工厂作用域的 `let` |
| 值**每次请求都是新的** | 同步发生在 dispatch 里，任何路由体之前 |
| **接缝 `router.mjs` 一行都没动** | 同步在族**自己的** dispatch 里，不在接缝上 |

> 一个"要在'体不改'与'值不陈旧'之间二选一"的取舍，
> 与一个"把变量提到作用域里、再在每次请求时同步"的写法，
> 在我不去看"这个名字到底是在哪里被读的"的时候，看起来才是二选一。

**生成器/接线脚本的改动**（都在助手区，不进仓库）：
- `gen-family.mjs`：新增 `MUTABLE` 探测（拿每个注入项去宿主里找 `^\s*(let|var)\s+NAME`）；
  可变的**不进** `deps`（改从 `live()` 取），另发 `let` + `syncLive` + dispatch 首句；
  `FAMILIES` 加 `'config'` 条目并显式写 `mutable: true`。
- `wire-family.mjs`：`readSyncDeps()` 识别签名末尾的 `live`，改发
  `live: () => ({ … })`，**那些名字从模块自己的 `let X = live().X` 行里读**（唯一真相源）。
- `register-family.mjs`（本片新增）：依赖**从模块签名里读**，不从命令行传。

---

## 2. ★★★ 本片最重的一条：我的破验工具**弄坏了产品**

破验第一轮跑超时，被 pwsh 杀掉。之后所有"验"都开始卡死：套件 135 秒只输出一个 TAP 头。

追下去发现：**杀掉的那次运行没能走到 `finally`**，`team-hub/routes/config.mjs` 被留在
**M15**（"先认领再执行"）的状态 —— `return true` 排在 `await r.run(...)` 之前，
于是这条端点**永远不回响应**。现象看上去完全像"产品坏了"。

> 一个"我会在 `finally` 里还原"的保证，与一个"进程可能根本走不到 `finally`"的事实，
> 在这个进程恰好没有被打断的时候是同一个东西。

**修法（三道防线）**，并**先自证会咬**：

| 防线 | 做法 |
| --- | --- |
| ① 开跑前 | 若存在 `<target>.pristine` ⇒ **先还原**（上一次被杀了），并响亮说明 |
| ② 开跑时 | 原文件写成 `<target>.pristine`；正常结束才删 |
| ③ 运行中 | 接 `SIGINT/SIGTERM/SIGHUP` ⇒ 还原后退出（`SIGKILL` 接不住，靠 ①② 兜） |
| ④ 附加核对 | 目标必须与 `git show :<path>` 一致，否则**拒绝开跑**并给出 `git checkout --` 的补救 |

自证：故意把 `runPlane: true` 改成 `false`（一个与索引不一致的目标）⇒
守卫报 `与 git 索引**不一致** —— 拒绝在一个可能已被上次运行改坏的文件上做破验。` ✔

### 2.1 ★ 同一片里还咬出：`mutate-lib` 的锚点是**换行符相关**的

`git checkout --` 之后 autocrlf 把文件重写成 CRLF，而锚点里写的是 LF ⇒ `M15 锚点没命中`。
根因不是锚点写错，是**同一份内容有两种换行写法**：

> 一个"锚点没命中说明代码变了"的判断，与一个"只是换行符变了"的事实，
> 在我把 `\r` 留着不剥的时候是同一个东西。

修法：按 `\r?\n` 切、剥行尾 `\r`、重建时**沿用文件原本的 EOL**。往返一致性自证 ✔。

### 2.2 ★ 破验跑不完的第二个原因：`node:test` **没有默认超时**

M15 这类"端点不再应答"的坏法会让判据**永不返回**。修法：`execFileSync` 加 `timeout`，
超时**按"咬住"计**并打印说明（"端点不再应答"本身就是最响的一种坏法）。

---

## 3. 破验：17 处，两轮 13/17 → **16/17**（真缺口 0，可证等价 1）

- 逐字节还原 ✔、还原后复绿 ✔
- ★★★ **M1 / M2（把活绑定打断）都被咬住** —— 这两条正是"四道判据结构上看不见"的那一类

第一轮 4 条没咬住，逐条归类：

| 变异 | 归类 | 依据 |
| --- | --- | --- |
| M3 初始值不取自 `live()` | **可证等价** | `syncLive()` 是 dispatch 第一句、变量只在路由体里读 ⇒ 初始值是 dead store。已用**结构不变式**用例 ⑪ 把那个顺序钉住（构造时 42 / 建后改 43，第一次请求必须读 43） |
| M9 `port` 恒报 0 | 真缺口 | 原用例只断言 `typeof === 'number'` ⇒ 补 ⑨ |
| M14 `liveConnections` 恒报 0 | 真缺口 | 原用例只断言"空闲时是 0"，而**恒报 0 也满足它** ⇒ 补 ⑩（开一条真 SSE，断言 0→1→0） |
| M16 `dispatch` 不看方法 | 真缺口 | 原用例只发 GET ⇒ 补 ⑧（POST/PUT/DELETE 必须 404） |

> 一个"这个读数在空闲时是对的"的判据，与一个"这个读数是常数"的实现，是同一个东西。

> 一个"这条端点能读"的判据，与一个"这条端点只认 GET"的契约，
> 在套件只发 GET 的时候是同一个东西。

补断言前**先量**（`probe-config-sse.mjs`）：`PORT` 未从 `server.mjs` 导出；
`/api/events?clientId=…` 能把 `liveConnections` 从 0 推到 1、断开回 0；POST/PUT → 404。

★ 另一处"先量再写"：tokenizer 那一栏我照 `server.mjs` 注释里的 `tokens.kind` 写了个 `kind` 字段 ——
**那是汇编器的读数，不是这个 status 的**。实际是 `{ dir, loaded, count, models, error }`。

> 一个"我知道这一栏长什么样"的判据，与一个"我记得的是**另一个**模块的同名字段"的事实，
> 在我不去把它打出来看一眼的时候是同一个东西。

---

## 4. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7403 | **7387**（−16） | 9221（累计 **−1834**） |
| `handle()` 路由条件（抽取器口径） | 103 | **102** | 191 |
| `router.dispatch` 调用点 | 17 | **18** | 0 |
| `routes/` 族模块 | 17 | **18** | 0 |

**102 剩余 + 86 已搬 = 188** ✓ · 被删区间 **26 行**（注释 14、路由 1），**丢注释 0 / 丢代码 0**

> ★ 被删区间 26 行里 **14 行是注释** —— 这一族的注释体量（PRT-301 / PRT-413 / F-05 三段来龙去脉）
> 是它本来"没人愿意碰"的原因之一，正好是本片最该逐字保住的东西。

---

## 5. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 18 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 17 族读数未变** |
| 无跨族遮蔽 | ✅ |
| **自由标识符常设判据** | ✅ 18 模块 / 未绑定 0 |
| **可变绑定守卫** | ✅ 本族走活绑定；守卫自证"与索引不一致即拒绝" |
| 破验 | ✅ **16/17 咬住**，真缺口 0、可证等价 1 |
| `config-routes`（本族新判据） | ✅ **11/11** |
| 既有判据 `tokenizer-registry-wiring` / `team-hub-parity` | ✅ 8/8、1/1 |
| 全量回归 | ✅ **52 套件 / 918 例 / 918 pass / 0 fail**（+1 套件、+11 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25 |

---

## 6. 本片**没有**做

- **`/api/events`（6 点）没有搬** —— 它读**同一个** `deliveryBookkeepingFailures`，
  现在机制已就绪，但它还有 10 个别的依赖（`registerEventClient` / `writeEventFrame` /
  `deliveryStore` / `withTx` …），是另一片的事。
- **`router.mjs` 一行都没改** —— 活绑定的同步点在族自己的 dispatch 里。
  代价是"每族自己多 6 行"，换来的是接缝保持不动；若日后走活绑定的族变多，
  再把 `sync` 提成接缝上的可选钩子（那会是**接缝的一次变更**，值得单独一片）。
- 域逻辑（`TOKEN` / `DB_FILE` / `PORT` / `tokenizerRegistryStatus` / `eventClients`）仍在原处，
  **只搬路由**。
- 助手判据仍住在 `.worktrees/_prt-handoff/`（`check-free-identifiers` / `append-block` /
  `mutate-lib` / `check-region-lines` / `rank3` / `register-family`），**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **102** 条条件仍在 `handle()`。
- 本片**没有**为 `/api/config` 的 `port` 一栏建立"等于配置端口"的强判据，
  只钉了"是个正整数"（`PORT` 未从 `server.mjs` 导出，要钉死得先导出它 —— 那是接口面的事）。

---

## 7. 复现命令

```powershell
node .worktrees/_prt-handoff/gen-family.mjs config
node .worktrees/_prt-handoff/wire-family.mjs config /api/config createConfigRoutes
node --check team-hub/routes/config.mjs; node --check team-hub/server.mjs
node .worktrees/_prt-handoff/register-family.mjs config b92dc6e /api/config team-hub/routes/config.mjs createConfigRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node .worktrees/_prt-handoff/mutate-slice19.mjs
node --test team-hub/config-routes.test.mjs
node --test runtime/context/tokenizer-registry-wiring.test.mjs tests/contract/team-hub-parity.test.mjs
# 选族依据（本片两次订正的那把尺子）
node .worktrees/_prt-handoff/rank3.mjs
```
