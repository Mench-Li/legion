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
node --test team-hub/file-domain-guard.test.mjs                     # 8 例（纯决策 5 + 真实 git 3）
node --test team-hub/in-review-releases-reservation.test.mjs        # 1 例（三半对照，真 hub + 临时库）
node --experimental-strip-types --test plugins/tests/config-sanity.test.mjs   # 6 例
```

**反向验证**（逐条改坏 → 必须红 → 还原即绿，全部实测）：

| 改坏什么 | 结果 |
| --- | --- |
| a① 全部忽略时改为放行 | ✅ 红（2 例） |
| a② 探测失败当成"未被忽略"（在非 git 环境下假装校验过） | ✅ 红 |
| a③ 部分忽略也拒绝（把合法用法挡了） | ✅ 红（2 例） |
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
