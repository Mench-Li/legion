<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-20**（commit `db8e2cc`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-316 切片 28：第二十七族 = 模型配置迁移（`/api/model-migration` 两条）—— 半途报告被一个**定形信封**吃掉

- **族**：`model-migration`（`team-hub/routes/model-migration.mjs`），**2 条**：
  - `GET /api/model-migration/plan`（算一份计划，只读）
  - `POST /api/model-migration/apply`（按**确认过的指纹**执行）
- **参考提交**：搬走前 `9071278`
- **规模**：55 行、2 条、**外来 0**、**分段 1**（这一族的段首是 `// ── PRT-506：…` 分隔线注释，
  上扫会在它那里停下、6 行说明**跟着区间一起搬走** —— 所以本片**没有**片子 26/27 那种孤儿注释）

---

## 1. 为什么挑它

干净的多条组里，`/api/model-migration`（2 条 / 49 行）是 `/api/web` 搬走之后**行数最多**的一组
（另一个干净组 `/api/skill-source` 只有 2 条 / 14 行）。
前缀 `/api/model-migration` 只捞这 2 条（量过无碰撞）。

## 2. ★★ 搬走前：**路由**零判据 —— 而**域函数**有 17 例

`survey-judges2` 对这两条路径报 "强判据 0 套"。
`team-hub/model-migration.test.mjs` 确实有 17 例，但**测的全是函数**
（`planModelMigration` / `applyModelMigration` / `digestOf`）。

> 一个"这一族有 17 例守着"的印象，与一个"那 17 例**直接调函数**、
> 而没有任何一条会把一个真实请求递进去"的事实，
> 在我把"有测试"当成"接线测过了"的时候是同一个东西 ——
> 函数对，缺口在**那根线**上。

---

## 3. ★★★ 本片钉住的真缺陷：`err.plan` 与 `err.migration` **都被静默丢掉**

`handleRun` 的 catch 是一个**定形白名单**信封（`server.mjs` L1002-1039）：

```
error · code · stateMachineCode · missing · currentSettlement · currentEpoch ·
currentWorkerId · leaseExpiresAtMs · currentVersion · state · lockReason ·
fromAmount · toAmount · currency · id · version · field · fields · serverTimeMs
```

而这两条路由**刻意**往 err 上挂了两个**不在名单里**的东西：

| 挂的地方 | 什么时候挂 | 结果 |
| --- | --- | --- |
| `err.plan = plan` | 计划**不可执行**时（`plan.ok !== true`） | **丢掉** |
| `err.migration = result` | 域层**写库中途失败**时 | **丢掉** |

`err.migration` 那一条尤其重。域模块自己的注释（`model-migration.mjs` L336-338）写着：

> 半途失败必须**如实报告已写入的部分**：报成"整体失败"会让用户重跑，
> 而重跑会因为"已存在"而跳过——于是他永远不知道第一次到底做成了什么。

**意图写下来了，代码写下来了（`err.migration = result`），信封把它吃了。**
量到的回执（`apply` 不给 `actor`）：

```
status=409  键=error,code,stateMachineCode,missing,currentSettlement,serverTimeMs
```

同一个域函数对同一份计划**确实**返回了那三格 —— 本片用例 ⑫ 用**真** store 走了一遍做两边对照：

```
域函数返回键 = bound, code, created, failed, message, ok
                 ↑                ↑
              就是回执里缺掉的那些（`failed:{created:0,bound:0}` = "第一次到底做成了什么"的答案）
```

这与切片 24（`code: CONTEXT_PLAN_ERRORS.\<不存在的键名\>` ⇒ `undefined` 被 `JSON.stringify` 丢掉）、
切片 26（模型配置警告被丢）是**同一类**：一个路由刻意挂上的结构化字段，
被一个固定形状的信封静默丢弃。

### 3.1 ★★ 指纹那条也一样

`MIGRATION_PLAN_STALE` 时，域层返回里带着 `actualDigest`（"你该重新确认哪一个"的答案），
路由把它塞进 `err.migration` ⇒ 同样丢掉。用户收到的只有一句
"这份计划已经变了，请重新看一眼"，而**变成哪一个指纹**这个数被吃了。

### 3.2 ★ 成功时却**有** `plan` —— 又一处信封不对称

`apply` 成功时路由 `return { migration: result, plan }` ⇒ 200 `{ok:true, migration, plan}`（12 个键）；
失败时 `plan` 一个字节都出不去。**同一个东西，两条路上只有一条能看到。**

---

## 4. 其余量出来的事实（全部进了判据）

| 事实 | 读数 |
| --- | --- |
| ★ 不给 `runtimeType` **刻意不报 400** | 200 + 一份 `plan.ok=false` 的计划 —— 它是个"报告"，"必须选协议"正是它要说的第一件事 |
| ★★ 顶层**刻意不放 `ok`** | 顶层恰 4 键；`ok` 只在 `plan` 里（两个 `ok` 在不同层级会读错） |
| `plan` | 12 键：`ok,code,message,toCreate,toBind,needsAttention,skipped,refused,conflicts,empty,hasAttention,digest` |
| `digest` | `<档案数>.<绑定数>.<8位十六进制>`；空计划恒为 `0.0.4b6234d0` |
| 去重 | 同 `(provider,model)` 压成一个档案；**绑定不去重**（两个岗位两条） |
| `skipped` | 同 id 的档案已存在 ⇒ 不覆盖（"迁移不修改既有配置"） |
| `refused` | 源里疑似密钥 ⇒ `{index,code,reason}` |
| `conflicts` | 两个不同模型折成同一个 id ⇒ `{id,a,b}` |
| ★★ `ID_COLLISION` 被拒时 **`toCreate` 仍然列着** | 计划只是"报告"；真正拦住它的是 `apply` 那句 `plan.ok !== true` |
| `apply` 需要 `actor` | 由**写库那一步**拦（域层 `ACTOR_REQUIRED`）⇒ 一个档案都没建 |
| ★ `expectedDigest` 省略/`null`/**空串** | 三者都**跳过**指纹比对 —— 这是一个"可以关掉的闸"（空串 ≠ 写错，而是"关掉它"） |
| 幂等重放 | 迁移跑过之后旧指纹必然陈旧 ⇒ `MIGRATION_PLAN_STALE` |
| 空计划 apply | 200 + `created:[]`/`bound:[]` —— "无事可做"与"半途失败"分得开 |
| `GET plan` | 只读（查两次库里行数不变）；不查授权（与别的读路径一致） |

---

## 5. 破验：**24/28 咬住（真缺口 0、可证等价 4）+ 反方向 3/3**

### 5.1 ★★★ 4 条"可证等价"，理由全是查出来的

| 变异 | 为什么真的等价 |
| --- | --- |
| M7 路由不再 `trim()` `runtimeType` | 域函数 `planModelMigration` **自己**也判 `runtimeType.trim() === ''`（`model-migration.mjs:117`）⇒ 全空白照样被拦 |
| M12 去掉 `plan.ok !== true` 那道 | 域函数 `applyModelMigration` **第一句就重新判** `plan?.ok !== true`；查过**4 处非 OK 的 `finish(...)` 全都带 message**（`message ??` 那条兜底永远用不上）；唯一会多出来的 `err.plan` **本来就被信封丢掉** |
| M24 去掉 `?? null` | 域层签名是 `{ …, expectedDigest = null }` —— **解构默认值对 `undefined` 生效**；量过 `null`/`undefined`/键都不给三种写法**读数完全一样** |
| M25 去掉 `await handleRun` | `handleRun` **自吞异常且自写响应**；被 await 的是外层 `dispatch` ⇒ 对"读到什么状态码/正文"没有可观测差别 |

> 一个"我把守门那道去掉就一定出事"的印象，与一个"域层**本来就**守着同一道、
> 而唯一会多出来的那个字段恰好被另一个缺陷吃掉了"的事实，
> 在我没有把两层都看一遍的时候是同一个东西。

★★ 有意思的是：M12 之所以"等价"，**正是**因为 §3 那个信封缺陷 ——
两个缺陷叠在一起，把一个本该可观测的差别抹平了。这条单独记在这里。

### 5.2 ★★★ 反方向那一组抓出了我自己一条**永远不会失败**的断言

本片的 ⑫/⑭ 钉的是"信封把 `plan`/`migration` 吃了"这个**现状**，
而信封在 `server.mjs` ⇒ 反方向要往 `handleRun` 里加字段才验得出来。加了三条：

```
✔ 咬住  R1  信封里加 `migration`        （⑫ 变红）
✖ 没咬住 R2  信封里加 `plan`            （⑫ **没有**变红）
✔ 咬住  R3  信封里加 `actualDigest`      （⑭ 变红）
```

R2 没咬住 ⇒ 查出来：⑫ 走的是"计划**是**可执行的、域层写库时才抛"那条路，
而 `err.plan` **只在那条计划被拒的路上**才被挂上。
所以 ⑫ 里那句 `assert.equal('plan' in r.body, false)` 是**永远为真**的
（信封加了 `plan: e?.plan` 之后，`e.plan` 是 `undefined` ⇒ `JSON.stringify` 照样丢掉它）。

> 一条**会因修复而变红**的断言，与一条**永远不可能失败**的断言，区别就在这里。

**修法**：把那句从 ⑫ 挪到 ⑯（`ID_COLLISION`，`err.plan` 真正被挂上的地方）⇒ 反方向组变成 **3/3 咬住**。

**这已经是本会话第三次**由"改**对**了要变红"的那一半抓出问题（前两次是切片 26 的 M8、切片 27 的 M9/M9b）。
只验"改坏了会红"永远发现不了这类断言。

### 5.3 其余咬住里最要紧的

不给 `runtimeType` 改成 400（把那个刻意的设计去掉）· 顶层加上 `ok` · `runtimeType` **加默认值**（＝替用户做判断）·
GET 不传 `existingProfiles`/`existingBindings` · `expectedDigest` 不传下去（指纹闸整根失效）·
`actor` 不传下去 · `err.code` 不挂 · 状态码改 400 · 成功时不回 `plan`/`migration` ·
`result.ok !== true` 去掉 · dispatch 不看方法 · dispatch 先认领再执行。

逐字节还原 ✔、还原后复绿 ✔。

---

## 6. ★ 本片踩到并修掉的三个**工具/夹具**坑（都不是产品问题）

1. **★★★ 清理挂 `process.on('exit')` ⇒ 整个进程挂死。**
   服务器开着时事件循环**永不空**、`exit` **永不触发**。
   > 一个"我保证了收尾"的印象，与一个"那个收尾挂在永远不会到来的事件上"的事实，
   > 在我没有让它自己跑完一次的时候是同一个东西。
2. **★★★ 用 PowerShell 给含中文的测试文件做 `Get-Content -Raw` + `Set-Content` ⇒ 全文变乱码。**
   读的时候没带 `-Encoding utf8`，于是按 ANSI 解码、再写回去就烂了
   （`鈶?鈽?` 那种）。**含 CJK 的文件一律用编辑工具改，不走 PowerShell 文本往返。**
3. **★★ `mutate-lib` 的锚点匹配会去掉所有行首缩进**（`strip()` 里 `/^[ \t]+/gm`）
   ⇒ **用缩进区分 GET/POST 是无效的**，必须用**内容**区分
   （`runtimeType: body.runtimeType,` 只在 POST 里）。
   另外：工具调用里的 `\n` 会变成**真换行**，而多行锚点需要文件里存的是两个字符 —— 这一条也踩了一次。

## 7. 规模

| 指标 | 本片前 | 本片后 | 原始 |
| --- | --- | --- | --- |
| `server.mjs` 行数 | 7172 | **7127**（−45） | 9221（累计 **−2094**） |
| `handle()` 路由条件（抽取器口径） | 83 | **81** | 191 |
| `router.dispatch` 调用点 | 26 | **27** | 0 |
| `routes/` 族模块 | 26 | **27** | 0 |

**81 剩余 + 107 已搬 = 188** ✓ —— **已搬过 56.9%**（107 / 188）
被删区间 **55 行**（注释 12、路由 2），**丢注释 0 / 丢代码 0**（本族段首是分隔线注释，跟着搬走了）

---

## 8. 判据

| 判据 | 结果 |
| --- | --- |
| 模块 + `server.mjs` + 判据文件 `node --check` | ✅ |
| 27 族逐字对拍 ①②③⑤ | ✅ 一条没丢、体逐行相同、无副本、装配到位 |
| 被删区间逐行核对 | ✅ 丢 0 / 丢 0；**前 26 族读数未变** |
| **自由标识符常设判据** | ✅ 27 模块 / 未绑定 0 |
| 破验（正方向） | ✅ **24/28 咬住**，真缺口 0、可证等价 4（理由见 §5.1） |
| 破验（**反方向**：修信封） | ✅ **3/3 咬住**（并修掉一条永假断言） |
| `model-migration-routes`（本片新判据，这两条路由**首个**判据） | ✅ **20/20** |
| 全量回归 | ✅ **61 套件 / 1061 例 / 1061 pass / 0 fail**（+1 套件、+20 例） |
| 九道门禁 | ✅ **9/9** |
| `baseline-snapshot.test.mjs` | ✅（188 / 已搬 107 / sources 45 / 族 27） |

---

## 9. 本片**没有**做

- `/api/skill-source`（2 条 / 14 行，干净）—— 留着。
- `/api/model-bindings`（前缀跨两个作用域，仍欠"拆族或加 `F.paths`"的裁决）。
- 纠缠族与剩下的 **23 个单条组**未动；**`/api/events` 仍未搬**（需要增量写回 `live.bump`）。
- ★★★ **那个定形信封一处都没改**（本片只钉住现状、只把形状说清）。
  `err.plan` / `err.migration` 依然丢。修它要动 `handleRun` 的公共形状，
  影响**所有**走 `handleRun` 的族 —— **属跨族契约，待业主裁决**。
- ★ 切片 22 / 24 / 26 / 27 的缺陷也都没修：`limit=2.7` → 500（**一个形状、三处**，
  其中 `/api/activity` 还在 `server.mjs` 里）· `CONTEXT_PLAN_ERRORS` 键名错 ·
  模型配置警告被丢 · `null` 与"没给"在 `status`/`bytes`/`ms` 上落成两个值。
- 域逻辑仍在原处（`planModelMigration`/`applyModelMigration`/`digestOf`/stores 都没搬），**只搬路由**。
- 那把只按目录选套件的回归选择器**没有改**；助手工具仍住在 `.worktrees/_prt-handoff/`，**不进仓库**。
- 切片 1～5 丢失的注释（chat 3、compaction 10）仍未补；其余 **81** 条条件仍在 `handle()`。

---

## 10. 复现命令

```powershell
node .worktrees/_prt-handoff/survey-judges2.mjs /api/model-migration    # ⇒ 强判据 0 套
node .worktrees/_prt-handoff/probe28-migration.mjs                      # 先量两条的形状
node .worktrees/_prt-handoff/probe28b-migration.mjs                     # 成功路径要 actor
node .worktrees/_prt-handoff/probe28c-migration.mjs                     # 计划各格 + ID_COLLISION
node .worktrees/_prt-handoff/check-m24.mjs                              # null/undefined/空串 三种写法
node .worktrees/_prt-handoff/check-m12-m15.mjs                          # 域层重守 + 锚点命中数
node .worktrees/_prt-handoff/gen-family.mjs model-migration
node .worktrees/_prt-handoff/wire-family.mjs model-migration /api/model-migration createModelMigrationRoutes
node .worktrees/_prt-handoff/register-family.mjs model-migration 9071278 /api/model-migration team-hub/routes/model-migration.mjs createModelMigrationRoutes
node .worktrees/_prt-handoff/register-baseline.mjs model-migration team-hub/routes/model-migration.mjs model-migration createModelMigrationRoutes
node .worktrees/_prt-handoff/pair-routes.mjs
node .worktrees/_prt-handoff/check-region-lines.mjs
node .worktrees/_prt-handoff/check-free-identifiers.mjs
node --test team-hub/model-migration-routes.test.mjs
node .worktrees/_prt-handoff/mutate-slice28.mjs
```
