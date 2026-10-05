# BUG-009｜三处「配置看起来合法、行为是坏的」护栏

> 发现于 2026-10-05 处置 T-178/T-179 卡死期间。三条**各自独立**，但形状相同：
> schema/注释写着一个硬关系或一个前提，**没有任何强制**，于是配置照常通过、守护照常启动，
> 而坏掉的地方离配置很远（交付不了 / 两个写者 / 队列被已交付的任务堵住）。
> 处置一律是**在能判定的最早时刻判定**，并且**不可知时不拦人**。

## 1. BUG-009-a：声明域全是 gitignored ⇒ 建任务时就拒绝

**现场**：T-179（tester）的 `fileDomain` 声明成 `["scratch/"]`，而 `scratch/` 在 `.gitignore` 里。
worker 老老实实干完了 —— 213 行 / 23KB 的逐套件判定报告（S01–S12、复跑命令、最小修复方案）——
却**永远交付不了**：分支 `w/T-179` 提交数 **0**、`git status` 干净、闸门那边还会因为"越域文件"
报出 14 个主分支新增的文件。**一条 5 小时的活烂在一个被忽略的目录里。**
报告作者自己也发现了，在正文里写："允许写入只有 scratch/，本文件即交付物。"

**修法**：`team-hub/file-domain-guard.mjs`（纯决策 + 真实 git 探测分离），在**两个建任务入口**调用：
`createTask()`（`/api/create` 走的公开入口，建任务前、进事务前）与 `insertGoalTask()`（目标分解路径）。

三条纪律：

| # | 纪律 | 为什么 |
| --- | --- | --- |
| ① | **只在"全部条目都被忽略"时拒绝** | 那是无歧义的交付不了；部分忽略是合法用法（`["scratch/","docs/"]` = 临时区 + 交付区），只告警 |
| ② | **不可知一律放行** | 仓库没绑定 / 不是 git 仓库 / git 命令出错 ⇒ 我们*不知道*域是否可交付，而"不知道"不该让人建不了任务（一个因为探不到 git 就挡住建任务的闸门，比它要防的问题更坏） |
| ③ | 判定用**真实 git**（`check-ignore`） | 嵌套 `.gitignore`、取反规则、目录通配都不是"自己抄一遍"能对的东西 |

## 2. BUG-009-b：`staleMinutes` 必须 > `workerTimeoutMs/60000`

**形状**：这条关系只写在 `Config` 的字段注释里：

```ts
/** 认领租约：in_progress 认领超过该分钟数无进展则由守护释放回 todo（须 > workerTimeoutMs/60000）。 */
staleMinutes: number
```

而 schema 是 `z.number().min(5).default(30)` —— **没有任何强制**。副作用很具体：
worker 在 `workerTimeoutMs` 到点后被中止；如果回收器比它更早动手（staleMinutes 更小），
就会在 **worker 还活着**的时候把任务释放回 todo 并被另一个 worker 认领 ⇒ **两个写者改同一片文件**。

这次调超时（25 → 45 分钟）时正好撞上：`staleMinutes: 40 < 45`。若只改一个字段，配置依然通过。

**修法**：`plugins/src/configSanity.ts` 的 `resolveStaleMinutes()`，在 `spaceWorker` 启动时校正，
**并打印一行**（静默改配置比不校正更坏），校正后的值贯穿两个消费者（心跳 `writeDaemonStatus`
与 `createReclamation` 的 `release-stale`）。

选"校正 + 打印"而不是"拒绝加载"：配置写错时，一个**起不来**的守护与一个**把原因写在日志里**的守护，
后者才能让人自己发现原因（前者只会让人以为插件坏了）。

## 3. BUG-009-c：进 `in_review` 释放写入预约

**现场**：T-178 已交付进 main、任务停在 `in_review`，它的预约却继续握着
`workbench/ security/ orchestrator/ team-hub/ runtime/`，把同域切片 T-184 挡在 `waiting-file`
**四十多分钟**，直到人工调释放接口才解开。

`in_review` 的语义是"这一轮写完并提交了"（worker 提交后才自己转到该状态）——**它不再写任何文件**。
继续占着域不是"有人在写"，纯粹是账本没结清。

**修法**：`team-hub/server.mjs` 的 `transitionTask` 里加一行
`if (to === 'in_review') finishTaskReservationInTx(id)`（与既有的 done/canceled 同列）。

用 `release` 而不是 `markReconciling`：`in_review` 的前提是 worker 已经收工（不是"不知道停了没"），
不存在 BUG-007 那种"未能确认停止"的语义。将军若打回 `todo`，守护下一轮会重新认领并重新预约。

## 4. 判据

```bash
node --test team-hub/file-domain-guard.test.mjs                     # 9 例（纯决策 5 + 真实 git 4）
node --test team-hub/in-review-releases-reservation.test.mjs        # 1 例（三半对照，真 hub + 临时库）
node --experimental-strip-types --test plugins/tests/config-sanity.test.mjs   # 6 例
```

### 4.1 ★ 活体验证抓出护栏 a 的第一版**是坏的**（这条比测试本身更值得记）

修完之后我按老办法重启 8787、用一个探针任务做活体验证：

```bash
POST /api/create  { "title": "【探针】…", "fileDomain": ["scratch/"] }
→ HTTP 200  ← 应当 400。护栏**没有响**，任务真的建出来了（T-185）
```

单元测试 8/8 全绿，而生产上它形同不存在。查下去发现是**问错了问题**：

| 问法 | git 的回答 | 为什么 |
| --- | --- | --- |
| `git check-ignore scratch/`（第一版） | **未忽略（1）** | `scratch/` 下面**已经有 447 个被跟踪的文件**，而 git 的规则是「**已跟踪路径永不被忽略**」 |
| `git check-ignore scratch/__probe__`（修正版） | **被忽略（0）** | 这正是我们的问题：**往这个域里新写一个文件，会不会被忽略** |

差别不是措辞：「域本身没被忽略」与「域装不下新产出」在交付上是两件事，而要防的恰恰是后者
（worker 写进去、`git add` 带不上、分支永远 0 提交 —— T-179 就是这样）。

**修法**：对每个域名目问两处 —— 它自己，以及一个假想子路径
`<entry>/__legion_domain_probe__`，任一命中即判该条目装不下新文件。
并补了一条**按生产形态构造**的用例（目录里有已跟踪文件 + `.gitignore` 忽略同一目录），
它先断言"陷阱成立"（问目录得到 1、问新文件得到 0），再断言探测器给出正确结论。

> **为什么第一版测试没抓到**：那条用例的临时仓库里 `scratch/` **完全不存在**，
> 于是"问目录"与"问新文件"答案相同，两种问法都能过。**一个用干净夹具测出来的护栏，
> 与一个在"目录里已经有历史跟踪文件"的现实里工作的护栏，不是同一个东西** ——
> 而这个差别只有活体验证（真仓库 + 真 .gitignore + 真历史）才暴露出来。
>
> 顺带一句：我原以为"重启后调一次接口"只是走个形式，结果它是这次唯一有效的判据。
> 单元测试全绿 + 生产不生效，这个组合本身就是"测试夹具不真实"的信号。

**反向验证**（逐条改坏 → 必须红 → 还原即绿，全部实测）：

| 改坏什么 | 结果 |
| --- | --- |
| a① 全部忽略时改为放行 | ✅ 红（2 例） |
| a② 探测失败当成"未被忽略"（在非 git 环境下假装校验过） | ✅ 红 |
| a③ 部分忽略也拒绝（把合法用法挡了） | ✅ 红（2 例） |
| a④ 只问域条目本身、不问假想子路径（回到第一版的坏问法） | ✅ 红（用例 ⑨ 与 ⑥） |
| b 不校正（回到"只写注释不强制"） | ✅ 红（4 例） |
| b′ 相等也当满足（严格大于松成 >=） | ✅ 红（2 例） |
| c 进 in_review 不释放（回到现场缺陷） | ✅ 红 |

连带不回归：`claim-reservation` / `claim-policy` / `write-intent-store` / `write-intent-routes` /
`contention-paths` 共 **67 例**，`branch-scope` / `write-eligibility` / `timeout-settlement` /
`legacy-convergence` 共 **24 例**，全绿。

## 5. 边界

- **a、c 都要等重启才生效**：两者都在 `team-hub/`（`file-domain-guard.mjs` + `server.mjs` 的
  `transitionTask`），随 8787 那个进程重启生效（改完可以直接重启中枢，不需要动宿主）。
  **b 在宿主内的 `plugins/lib`**（`configSanity.ts` + `index.ts`），要宿主重启才生效。
- **没有做**（明确留白，避免顺手扩大）：
  - 没做"改已存在任务的 `fileDomain`"——**全仓没有这个写点**（只有创建时能设，API 与前端都没有编辑入口）。
    所以 a 是"在源头不产生坏域"，而不是"事后修坏域"。这也是当时 T-179 只能靠人搬运交付物的原因。
  - 没把 `staleMinutes` 的关系写进 schema 做**拒绝加载**（选了校正 + 打印，理由见 §2）。
  - 没动 `in_review → done/canceled` 之外的任何迁移语义。
- **一处顺带纠正的说法**：本文初稿把 a 的调用点写成"只在 `/api/create`"，
  实际还包含目标分解的 `insertGoalTask()` —— 两条路径都会产生带 `fileDomain` 的切片任务。
