<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **P4-7 切片当时**的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）｜[README.md](../../README.md)（总览）｜[docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-7 `notify` 套件「用例全绿却卡死」的根因定位与修复 —— 验证证据

> 任务来源：`docs/REMAINING-TASKS.md` 候选 **#3**「`notify` 套件曾超时一次、未复现（2026-09-10）」。
> 原登记：「被套件级 300s 超时杀掉，落盘日志显示 hub-smoke 的 2 个用例都已通过（391ms / 5068ms）、
> 此后无任何输出……故**未得出机制级结论**」。

## 1. 先把记录里的一个错误前提纠正掉

原登记的推理链是：

> 「hub-smoke 的 2 个用例都已通过」→（因为它把结果打印出来了）→「它的进程已退出」→
> 「所以卡住的是**另一个文件**（notify.test.mjs，但它是纯函数、无子进程无定时器）」→ 自相矛盾、无法结论。

第一步就不成立。**实测 `node --test` 的输出语义**（三文件哨兵实验：`fast` 正常退出、
`slow` 用例后拖 3s、`hang` 用例后永不退出）：

```
3037 FAST import      3056 HANG import      3081 SLOW import     ← 文件**并行**执行
3085 SLOW test-returned                     6100 SLOW exiting
--- 此时（10s，进程仍存活）stdout 只有：---
✔ FAST 用例 (1.3496ms)                                            ← 只有 fast 的结果
```

结论有两条，都与原推理相反：

1. **文件是并行执行的**（三个文件的 import 都在 300ms 内完成）；
2. **一个文件的结果在它的「用例跑完」时就输出，不等该文件进程退出**（hang 文件永不退出，
   它的结果**始终没有**被打印，而 fast 的已打印）。

因此「日志里看到 hub-smoke 的用例通过」**不能**推出「hub-smoke 的进程已退出」。
正确的推论是：**hub-smoke 的用例全绿，但它的进程没有退出** —— 与「另一个纯函数文件卡住」的
假设相反，卡住的就是 hub-smoke 自己。原登记之所以走进死胡同，是因为这个前提错了。

## 2. 定位：三条真实缺陷，都能独立造成「全绿却卡死」

hub-smoke 会起真实 hub 进程、建 SSE 订阅、跑就绪轮询 —— 三处都有句柄泄漏面。用哨兵变体实测：

| 缺陷 | 实测读数 | 后果 |
| --- | --- | --- |
| ① **就绪轮询在就绪后不停** | `__pollTicks = 41`；此刻 `getActiveResourcesInfo()` = `{PipeWrap:2, ProcessWrap:1, **Timeout:4**}` | 连上之后仍每 120ms 打 HTTP 到 15s 期限，留下一个始终 pending 的 Timeout |
| ② **轮询的请求没有上界** | 黑洞服务端（accept 后永不出响应）：裸 `fetch` **20s 内既不 resolve 也不 reject**；加 `AbortSignal.timeout(150)` 则 **159ms** 被截断 | undici 默认 `headersTimeout` = **300s**，**与套件级硬上限同值** |
| ③ **SSE 订阅的 `off()` 不在 `finally`** | 真正泄漏（三处关闭全去掉）+ 注入中途失败 → **卡死 >75s**；有任一关闭路径 → 5s 退出 | 中途失败/用例被 abort 时 `off()` 永不执行，`MiniEventSource` 每 300ms **无上限**重连 |

**最贴合记录症状的是 ②。** 它是 fire-and-forget 的后台轮询：hub 若已 accept 却迟迟不回响应
（重负载下事件循环被阻塞、或进程在错误时刻被杀），那个请求会挂到 ~300s，
**测试本身照常全绿**，而进程因为还挂着一个未结请求无法退出 → 被 300s 上限杀掉。
这与记录的三个细节全部吻合：用例全绿、此后无输出、恰好 300s。

（① 单独只值 15s，不足以撑到 300s；③ 需要「有断言失败」才触发，而记录里用例是全绿的。
所以 ② 是主因，①③ 是同一类风险的两个旁证。）

## 3. 修复

`workbench/scripts/notify-hub-smoke.test.mjs`：

1. **可取消的有界轮询** `waitForReady()`：就绪即 `stop()`；超时即 `stop()` 再抛；
   暴露 `ticks()/stopped()` 供断言。取代原来「每个 tick 的 `finally` 只要没到 15s 就再排一个 tick」的递归写法。
2. **每个探测请求带上界**：`fetch(url, { signal: AbortSignal.timeout(perRequestMs) })`（默认
   `max(1000, intervalMs*10)`）。任何一次探测都不可能超过 `perRequestMs`，**不可能挂到 300s**。
3. **订阅在 `finally` 关闭**：`off()` 从 try 末尾移到 `finally`；同时 `cleanup()` 扫掉遗留订阅，
   `afterAll()` 再断言一次（三道闸）。失败因此是「干净的失败」，不会升级成「卡死」。
4. **句柄登记 + 兜底自检**：`LIVE_CHILDREN` / `LIVE_SUBSCRIPTIONS` / `LIVE_WAITS` 三张表，
   `afterAll` 断言 `子进程=0 / 订阅=0 / 轮询=0`，把「静默卡死」变成**带名字的失败**。
5. 文件头注释按 §1 的实测语义改写（原来那句「只有在测试进程退出后才会输出结果」是错的）。

## 4. 验证证据

### 4.1 确定性回归用例（新增 2 例，不需要 hub）

| 用例 | 断言 |
| --- | --- |
| 就绪轮询：连上即停、超时即停 | 首次成功**只轮询 1 次**（旧实现：41 次）、就绪后 300ms 内 `ticks` 不增长、就绪后不再打 HTTP；超时路径抛错且停止轮询 |
| 就绪轮询：服务端 accept 后永不出响应仍须按时收敛 | 黑洞服务端下必须**在自身期限内**收敛（实测 <5s 断言，实际 ~0.9s），且 `ticks>=2`（说明每轮都被上界截断后继续） |

### 4.2 套件读数（A/B）

| | 修复前 | 修复后 |
| --- | --- | --- |
| 用例数 | 15 | **17** |
| 单跑耗时 | 19s（3 次一致） | **10–11s**（连跑 6 次一致） |
| `afterAll` 时的 pending Timeout | **4** | 0（自检断言） |
| 就绪后轮询次数 | **41** | 1 |

耗时从 19s 降到 11s，正是「不再空转到 15s 期限」的直接体现。

### 4.3 负向对照与隔离实验

| 实验 | 结果 |
| --- | --- |
| 三文件哨兵（fast/hang/slow） | 证明并行执行 + 结果随用例完成输出（§1） |
| 裸 `fetch` vs 黑洞服务端 | 20s **未收敛**（会到 undici 的 300s）；`AbortSignal.timeout(150)` → 159ms |
| 订阅真泄漏 + 注入中途失败 | **卡死 >75s** |
| 同一注入 + 三处关闭路径齐全 | **5s 正常退出**（失败是干净的失败） |
| 修复前实现的轮询（哨兵变体） | `__pollTicks=41`、`Timeout:4` |

## 5. 未覆盖 / 已知边界（诚实登记）

1. **原历史实例无法重放**：单跑 12 次全绿、2026-09-10 之后的多轮全量门禁也未再出现。
   本切片给出的是**机制级定位**（可确定性复现的同类条件），不是对当年那一刻的现场复原。
2. **未测「hub 真的卡住」的真实成因**：黑洞服务端是人为构造的等价条件。
   hub 在什么负载下会 accept 而不响应，未做定位（那属于 team-hub 自身的性能问题）。
3. **`AbortSignal.timeout` 依赖 Node ≥17.3**（本仓要求 ≥22，不构成实际约束）。
4. **`afterAll` 的订阅断言是「兜底」而非「主闸」**：`cleanup()` 已经会扫掉订阅，
   所以这条断言在正常路径上恒真；它的价值在于「若将来有人在 `cleanup` 之外泄漏订阅」时能报出来。
5. **未给 team-hub 客户端统一加请求超时**：本切片只修了测试里的轮询。
   `workbench/src/api.ts` 的其它 `fetch` 仍无显式上界（受 undici 默认值约束）——
   这是**独立**的可用性议题，未在本切片处理。
6. **`process.getActiveResourcesInfo()` 只用于诊断**，未作为断言依据（它会把测试运行器自身的
   `PipeWrap` 等一并列出，无法稳定区分归属）。
7. **未改变 hub 的启动超时（15s）与套件级 300s 上限**：本切片只保证「不会无声地卡到上限」。

## 6. 复跑命令

```bash
# 套件（含 2 条新回归用例）
node --experimental-strip-types --test \
  workbench/scripts/notify.test.mjs workbench/scripts/notify-hub-smoke.test.mjs

# 全量门禁（env + test + doc）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci/p4-7
```
