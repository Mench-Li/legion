<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 17：第十六族 = **配置包导出/导入（config-bundle，3 条）**

- 切片：17（新增 `team-hub/routes/config-bundle.mjs`）
- 提交：见 `git log`（`feat(PRT-316 切片 17)`）
- ★ **这是十七片里第一次真的把既有判据跑红** —— 而且红得对。

## 一、选族：订正后的筛选器把这一族从队尾提到了前面

上一轮（切片 16）发现我的"有没有真 hub 判据"筛选器写成**子串** `includes('listen(0)')`，
只在 `.listen()` 实参恰好为空时成立。订正成正则 `/\.listen\(\s*0\b/` 之后重排，

`/api/config-bundle` 露出 **1 套强判据 / 24 个请求点**（`config-bundle-routes.test.mjs`，18 例）——
而我此前记的是"**没有任何真 hub 判据**"。

> 一个"这族没有强判据、排到后面去"的结论，与一个"我的判据筛选器写错了"的事实，
> 在我不去核对筛选器本身的时候是同一个东西。

同批被同一根因压下去、订正后露出强判据的还有 `model-bindings`（23 点）、`price-tables`（7 点）。

## 二、规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7580 | **7432**（−148） | 9221（累计 **−1789**） |
| `handle()` 路由条件（抽取器口径） | 109 | **106** | 191 |
| `router.dispatch` 调用点 | 15 | **16** | 0 |
| `routes/` 族模块 | 15 | **16** | 0 |
| 平台契约 `httpRoutes` | 188 | **188** | — |

**106 剩余 + 82 已搬 = 188** ✓ · 被删区间 **158 行**（注释 32、路由 3），**丢注释 0 / 丢代码 0**

## 三、★★★★ 本片的真收获：三道闸门同时没看见同一件事

装配完之后 `config-bundle-routes.test.mjs` **18 例挂了 13 例**（500）。
对照 HEAD 版同套件 **18/18 绿** ⇒ 是我的搬运弄坏的。根因是**两个**未绑定标识符：

| 缺什么 | 为什么三道闸门都看不见 |
| --- | --- |
| `handleRun` | 生成期核对把它当"可用"（它在 `ALWAYS` 名单里），可装配清单**从来不给它** |
| `BundleError` | 核对只认 `NAME(` 与 `NAME.` 两种形态，而它出现在 `e instanceof BundleError` —— **两边都不沾** |

而三道闸门为何都放过：

- **生成期"自由标识符核对"**：判据是"**被调用的名字 + 取成员的根**"，不是"所有自由标识符"；
- **`node --check`**：语法完全合法（未绑定标识符是运行期的事）；
- **逐字对拍**：只比"体"，而体是逐字搬过来的 —— **它本来就该相同**。

> 一条"我搬过来的字一个不差"的判据，与一条"搬过来之后还能跑"的判据，
> 在被搬的代码没有引用任何外部名字的时候是同一个东西。

### 两条修法（都往"判据要看事实"的方向）

1. **核对与装配用同一个集合**。先扫一遍记下"体里真正出现过的名字"，
   再让 `ALWAYS ∩ 出现过` **自动进装配清单**，最后**用装配清单**去核对。
   顺带修了一个副作用：`json` 是签名里硬编码解构的，必须显式进放行名单（第一版漏了，它被报成"未登记"）。
2. **判据从"被调用/取成员"扩到"值位置"**：补上 `instanceof` / `typeof` / `new` / `delete` / `void` / `await` / `in` / `of`。

## 四、★★★ 新增常设判据：`check-free-identifiers.mjs`

只修生成器不够 —— 这一族栽的是"**搬过来之后还能跑**"，而生成器只在"搬的那一刻"存在。
所以新增一条**独立于生成器、只看产物**的判据：扫 `team-hub/routes/*.mjs` 全部 **16** 个模块，
报"自由标识符里没有来源"的那些。

**先自证会咬、且不假红**（`verify-free-identifiers-bites.mjs`，6/6）：

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| B1 体里加 `e instanceof NotInjectedError`（**就是本片栽的那个形态**） | 咬住 | ✔ |
| B2 签名里删掉 `handleRun,`（用了但没给） | 咬住 | ✔ |
| B3 签名里把 `json` 改名 | 咬住 | ✔ |
| B4 体里加 `mysteryHelper()` | 咬住 | ✔ |
| B5 对照组：只加注释 | 不报 | ✔ |
| B6 对照组：加一个纯局部变量并使用 | 不报 | ✔ |

逐字节还原 ✔、还原后复绿 ✔。对 16 个模块实跑：**未绑定名字合计 0**。

★ 写这条判据时它自己先假红了 16/16（把每个族的 `url` 报成未绑定）——
因为 `url` 是从**第三个参数的解构**里来的（`async run(req, res, { url }) {`），
而我的参数解析只认裸标识符。
*一条"我收集了所有局部绑定"的判据，与一条"我只收集了裸标识符参数"的判据，
在被搬的代码恰好没有一个解构参数的时候是同一个东西。*

## 五、破验：20 处，两轮

| 轮 | 结果 | 那 5 条"没咬住" |
| --- | --- | --- |
| 1 | **15/20** | **全是真缺口**（M1、M3、M8、M14、M20） |
| 2 | **20/20** | 真缺口 **0**、可证等价 **0** |

逐字节还原 ✔、还原后复绿 ✔。

### ★★★ 其中 M1/M3 是本片最值得记的一条：**空库上的断言什么也证明不了**

`kind` 过滤（只要档案 / 只要绑定 / 全要）**看起来**被测了：既有用例确实请求了
`?kind=model-profiles` 并断言 `bindings` 为空。但那时绑定库**本来就是空的** ——

> 一个"过滤掉了它"的判据，与一个"库里本来就没有它"的判据，在库是空的时候是同一个东西。

所以补的两条判据**先造出一条真实绑定**（并断言它建成功了），再断言过滤 —— 让这件事可观测。
实测（`probe-slice17-gaps.mjs`）：不给 `kind` ⇒ `kind="full"`、profiles 1、bindings 1；
`kind=model-profiles` ⇒ profiles 1、bindings **0**；`kind=model-bindings` ⇒ profiles **0**、bindings 1。

### 另外 3 条真缺口

`plan` 收到不合法计划时 `applicable` 必须是 `null`（拿坏计划判"能不能应用"会让前端把
"计划本身不合法"读成"不可以应用"）；`apply` 坏包的具名码；成功 `apply` 必须自报 `applied: true`。

★ 量出来的两件事改了草稿：具名码是 **`BUNDLE_PROFILE_INVALID`**（不是 `PROFILE_INVALID`）；
档案的体是 `{ actor, profile: {...} }`（顶层并列），而绑定要 `actor` 在**自己这一层**。

## 六、★★★ 第三个坑：一个**永远为假**的哨兵

补判据时我复用了切片 16 的追加脚本，只改文件名 —— 而它没改成功（`node -e` 里的嵌套引号），
于是它**又给 `context-retention.test.mjs` 追加了一遍切片 16 的契约块**：763 → 857 行，36 → 43 例，**全绿**。

为什么幂等守卫没拦住？因为它写的是 `PRT-316 切片 16 契约块`（中间一个空格），
而块里实际写的是 `PRT-316 切片 16 · 契约块`（中间一个 `·`）—— **守卫永远为假**。

> 一个"防重复"的判据，与一个"永远为假"的判据，
> 在哨兵那句话并不出现在被守卫的内容里的时候是同一个东西。

已 `git checkout HEAD` 复原（36 例）并改为通用脚本 `append-block.mjs`：
**哨兵从被追加的内容里取**，且**当场断言它真的在里面**（不可能命中的哨兵 = 不可能生效的守卫）、
追加后**再断言**它出现了。第二次运行**确实拒绝**（"已经追加过（哨兵命中：…）"）。

## 七、判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 16 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同 |
| 被删区间逐行核对 | ✅ 158 行（注释 32）丢 0 / 丢 0 |
| 无跨族遮蔽 | ✅ |
| **自由标识符常设判据** | ✅ 16 模块 / 未绑定 0（自证 6/6 会咬、不假红） |
| 破验 | ✅ **20/20**，真缺口 0 |
| `config-bundle-routes` | ✅ **23/23**（18 → +5） |
| 全量回归 | ✅ **51 套件 / 901 例 / 901 pass / 0 fail**（+5 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅ 25/25 |

## 八、本片**没有**做

- 域逻辑（`buildBundle` / `planImport` / `validateBundle` / `assertApplicable` / `BundleError`）
  仍在原处，**只搬路由**。
- `check-free-identifiers.mjs` 与 `append-block.mjs` 目前住在 `.worktrees/_prt-handoff/`（助手区，
  **不进仓库**）。把它们做成仓内常设闸门（`scripts/prt/…` + 一条 `run-ci`）是**独立的一件事**，
  本片不夹带。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补。
- 其余 **106** 条路由条件仍在 `handle()`。

## 九、复现命令

```powershell
node .worktrees/_prt-handoff/rank-remaining.mjs                              # 订正后的选族排序
node .worktrees/_prt-handoff/gen-family.mjs config-bundle
node .worktrees/_prt-handoff/wire-family.mjs config-bundle /api/config-bundle createConfigBundleRoutes
node .worktrees/_prt-handoff/check-free-identifiers.mjs                      # ★ 常设判据
node .worktrees/_prt-handoff/verify-free-identifiers-bites.mjs               # ★ 自证会咬
node .worktrees/_prt-handoff/probe-slice17-gaps.mjs
node .worktrees/_prt-handoff/append-block.mjs team-hub/config-bundle-routes.test.mjs .worktrees/_prt-handoff/slice17-contract-block.txt
node .worktrees/_prt-handoff/mutate-slice17.mjs
```
