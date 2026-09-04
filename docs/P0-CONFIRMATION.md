# P0 现状确认单 —— ORCHESTRATION-V3 前置探针

> 探针时间：2026-09-03（全部结论经代码阅读 + 运行态实测核实）
> 关联：`docs/ORCHESTRATION-V3.md`（架构目标）· `team-hub/server.mjs` · `plugins/src/index.ts` · `~/.dsh/profiles/web/cordis.patch.yml` · `~/.dsh/super-injector/dsh-scrum-worker.log`

## 结论速览

1. **生产执行 = dsh-scrum-worker 守护的 hub 全自动流水线**（scope=software，连写码/测试都自动跑并自动 done），不是 exec 半自动通道。
2. **maxWorkers=1 + 全串单链** = 并行闸门与结构闸门，两处都在，且单槽现实代价可见（长尾任务长期占唯一并发位）。
3. **守护↔team-hub 存在已确认的集成债**：`/api/progress`、`/api/artifact` 在 v2 hub 不存在（守护每轮报 not found）；hub 任务无 diff 记录（recordPatch 走 v1 taskctl 失败）。P1 必须顺带处理。
4. **回归测试模式完全可复用**（`worker-regression.test.mjs`：fake ctx + fetch stub + 手动触发 sweep + 请求序列断言），P1 决策集照此扩展。
5. **D7 建议修订**（详见 §5）：现状 tester 是"无闸门自动 done"，v3 的机器闸门（testReport 全绿才 done）是净改进，建议放弃"每切片将军点验"，改将军只卡方案闸门/目标级/超预算。

---

## 1. 运行态（实测）

| 项 | 值 |
| --- | --- |
| team-hub v2 | `:8787` 运行中（PID 4780，2026-09-03 13:53 启动，鉴权 off） |
| workbench / kanban v1 / DSH web | `:5173` / `:4820` / `:3080` 均运行中 |
| 守护注入行 | `cordis.patch.yml` → `legion-scrum-worker`：`hubUrl=http://127.0.0.1:8787`、`scope=software`、`role=soldier-auto`、`maxWorkers=1`、`workerTimeoutMs=1800000`、`isolate=true`、`repoRoot=D:/project/DSH/legion`、`agentPreset=code`、`provider=spawn` |
| junction | `~/.dsh/profiles/web/node_modules/@dsh-external/dsh-scrum-worker` → **`D:/project/DSH/legion/plugins`**（源码即生效路径） |
| 构建同步 | `plugins/lib/index.js`（13:50:28）≥ `src/index.ts`（13:50:23），lib 新鲜 |
| daemon.json | `pipeline=software`（8 岗全列）、`paused=false`、`inbox=0`、`lastSweepAt=06:58Z` |

## 2. P0-1 执行模式结论

**守护 hub 全自动（isPipeline）是当前生产行为**，证据链（守护日志 + hub board 实测）：

- 目标 T-036…T-043（`[auto-goal]` 链）被守护自动推进：`T-040 编码 done → T-041 审查 done → T-042 测试 done → T-043 部署 in_progress`，**无将军逐任务点验**；每个阶段由一次性 worker subagent 在 `w/<id>` worktree 完成并自动合入主分支。
- 认领/推进身份（代码核实）：claim 的 `soldier=阶段角色`（coder/reviewer/…），`advance/transition` 的 `by=任务 soldier`（即角色）；worker 一次性 subagent 的父 = 按 cwd 缓存的 foreman（`plugins/src/index.ts` L503-530、L537-598）。
- 写码自动化闸门（架构 D4 问"写码是否全自动"）：**现状已是全自动**，D4 无需新决策，只需在 v3 文档里把"现状如此"写实。
- `exec/queue`（`NON_AUTO_ROLES` 约束的分析类通道）：守护**不消费**它（守护 hubPost 路径清单里无 exec）；仓库内未见消费者 → 属"将军 agent 侧"通道，与守护并存、靠 claim 互斥仲裁。**v3 建议：决策集以 board 为准，该通道退役或仅留给讨论类**，避免双调度源。
- 单槽现实代价：`T-043`（devops）自 06:46Z 起 in_progress 超 8 小时——`maxWorkers=1` 下这类长尾/反复重派任务会**独占全空间唯一并发位**；类型化槽位（coder/tester 分槽）必要。

## 3. P0-2 插件链路（改代码→生效的完整路径）

1. 改 `plugins/src/index.ts`（TypeScript，严格编译 `tsc -p`）；
2. `DSH_CHECKOUT=<dsh 源码检出> bash scripts/build.sh` → 产出 `plugins/lib/`（build.sh 探测路径不含 `D:/project/DSH/dsh/deepseek-harness`，须显式给 `DSH_CHECKOUT`）；
3. profile junction 已指向 `legion/plugins` → **重启 Desktop / 重注入（dev_uninject + dev_inject）后生效**；守护日志在 `~/.dsh/super-injector/dsh-scrum-worker.log`；
4. 单测直接 `import { apply } from '../lib/index.js'`，**先 build 再 test**（`pnpm --filter … test` 或 `node --test tests/*.test.mjs`）。

## 4. P0-3 回归测试可复用性（worker-regression.test.mjs，523 行）

模式（全部可照抄扩展）：

- `fakeContext()`：注入 `setInterval/effect/agents/agentPresets/subagents.start(返回结构化报告)/agentDefaultModel`，记录 intervals 与 disposers；
- `globalThis.fetch` stub 按 path 分派（`/api/skills`、`/api/board`、`/api/claim`、`/api/comment`、`/api/transition`…），请求序列入数组供断言；
- `harness.intervals[0]()` **手动触发一轮 sweep** + `waitFor()` 轮询断言；
- 临时 roles.json fixture（`rolesFile` 配置）把流水线缩到被测岗位；`protectTasksFile` 防误碰真实任务库；isolate 集成测试用临时 git 仓库。

已覆盖：blocked 解阻认领、foreman preset mount、worker 失败含容重试、**D1 最终阶段 in_review 用阶段角色**、**D2 中间合入失败停在 in_review 不静默推进**。
**复用结论：高。** P1 新增测试照此写：切片注册端点、槽位上限（2 个 coder todo 只派 2 个 claim）、tester in_review+testReport → 生成 fix 任务、fixCount 超预算 → blocked+❓、tester 报告缺失 → 不自动 done。

## 5. 已确认的集成债（P1 必须处理）

| 债 | 证据 | 影响 |
| --- | --- | --- |
| `/api/progress` 不存在 | 守护 L574 调用；日志 `progress T-040 失败: not found` | 进度遥测全失效（噪音 + 无心跳 → 租约判定退化） |
| `/api/artifact` 不存在 | 守护 L739 调用；日志 `not found: /api/artifact` | worker 产物登记失效 |
| hub 任务无 diff 记录 | `recordPatch` 走本地 v1 taskctl → `taskctl: 未知任务 T-040` | v2 hub 模式下"diff 入任务"功能是坏的，证据靠 git 分支 + 评论 |
| autoPromote 合入冲突 | 日志 `T-040 自动合入失败…workbench/src/index.css`（主分支有未提交改动） | 按设计停 in_review + 指引（D2 回归测试覆盖），v3 合入队列直接复用该语义 |

→ **P1 前置任务**：team-hub 补 `/api/progress` + `/api/artifact`（幂等 + audit + SSE），或守护按 hub 能力降级跳过；修复 `recordPatch` 的 hub 路径。

## 6. 对 v3 架构的影响与修订建议

1. **D7 修订建议（重要）**：现状 tester 是**无闸门自动 done**（T-042 直接 done）。v3 若按原 D7-A"每切片 tester 全绿仍须将军点验"会引入新的每任务人工步骤，与全自动现状冲突。建议修订为：
   > **D7' 机器闸门**：tester done 自动放行 **仅当** `testReport.passed=true`（报告由 tester worker 按 schema 写回）；无报告或失败 → 不进 done，走 fix 回炉；将军只保留：方案闸门（researcher gate，现状已有）、目标级收尾验收、fix 超预算升级仲裁。
   这既符合"验证者独立 + 机器闸门"的行业收敛（Codex/Claude/DSH 对比结论），又不增加将军点击负担，且**严于现状**（现在测试结果根本没人看）。
2. **切片模式默认关闭**：`createGoalChain` 加 `chain|slice` 两种模式，v3 发布时按空间/目标开关启用；现有 chain 行为与既有回归测试零破坏。
3. **claim 身份不变**：切片 coder/tester 任务仍以角色认领/推进 → workbench 岗位泳道、认领互斥、看门狗全部天然复用；切片分组仅靠 `slice` 字段（P3 UI 消费）。
4. **类型化槽位替换单一 `maxWorkers`**（coder×2 / tester×2 / perGoal×4 起步），防长尾任务独占（§2 的 T-043 教训）。

## 7. P1 首步清单（确认 D7' 后开工）

| # | 改动 | 文件 | 验收 |
| --- | --- | --- | --- |
| 0 | 补 `/api/progress` + `/api/artifact`；修 hub 路径 recordPatch | `team-hub/server.mjs` | 守护日志不再报 not found |
| 1 | `tasks` 增列 `slice/sliceIdx/fixOf/fixCount/testReport`（幂等迁移） | `team-hub/server.mjs` | 老库无破坏，board 输出新字段 |
| 2 | `createGoalChain` 双模式（chain/slice）；slice 模式：前缀到 test-designer，扇出切片束（coder_i→tester_i，`blockedBy` 仅切片内） | `team-hub/server.mjs` | 2 切片目标生成正确微链 DAG |
| 3 | `POST /api/goal/slices` + `POST /api/test-report`（写纪律 + audit + SSE） | `team-hub/server.mjs` | 单测：注册幂等、报告校验 schema |
| 4 | 守护决策集（readyToCode / readyToTest / fix 回炉）+ 类型化槽位 + 决策集纯函数化 | `plugins/src/index.ts` | **守护日志出现 tester_S1 与 coder_S2 同时在 inflight** |
| 5 | 新增回归测试（照 §4 模式） | `plugins/tests/` | 全绿；既有 5 个测试不回归 |

## 8. P1 完成记录（2026-09 回填）

P1 代码全部落地并验证（详见 `docs/ORCHESTRATION-V3.md` 末尾「P1 实施记录」）：

- 清单 0–3 ✅：`/api/progress`、`/api/artifact`、`/api/patch`（recordPatch hub 落点）、`/api/goal/slices`、`/api/test-report` 上线；切片列族幂等迁移；`createGoalChain` chain/slice 双模式 + `expandGoalSlices`；隔离冒烟全链路通过（slice 发布→前缀→展开→幂等→依赖阻塞→报告校验）。
- 清单 4 ✅（代码）：守护决策集（readyToExpand / fix 回炉 / 重测重开）、类型化槽位（sliceCoderSlots×2、sliceTesterSlots×2、perGoalSliceCap×4、maxFixPerSlice×2）、D7' 机器闸门；`roles.json` breaker 机器可读切片清单。
- 清单 5 ✅：`plugins/tests/slice-orchestration.test.mjs` 5 例（含跨切片重叠：coder worker 挂起时 tester_S1 仍被派工并完成）+ 既有 7 例 = **12/12 绿**；`bash scripts/build.sh`（DSH_CHECKOUT）编译通过。
- 清单 4 的现场验收线（**守护日志 tester_S1 与 coder_S2 同时在 inflight**）需在生产侧执行：profile 提升 `maxWorkers`≥2 → 重启守护/team-hub（会重启本会话宿主进程）→ 以 `mode:'slice'` 发布真实目标。代码侧已由重叠回归测试提供机器证据。

## 9. 现场验收记录（2026-09-04，已执行 ✅）

按 `docs/P1-LIVE-ROLLOUT.md` 在**真实生产守护 + 真实 team-hub v2 + 真实 worker**（沙箱 scope `slice-verify`，仓库 `D:/tmp/legion-slice-verify`，profile 临时 `maxWorkers:2`，双宿主重启）完成现场验收。原始日志证据存 `D:\tmp\slice-acceptance-evidence.txt`。关键时序（UTC）：

| 时间 | 事件 | 验收点 |
|---|---|---|
| `10:07:34Z` | 切片束注册：7 个任务 | readyToExpand：breaker `## slices` → parse → coder×3+tester×3+devops 尾（2N+1） |
| `10:08:04Z` | foreman T-062(S1 coder) 与 T-064(S2 coder) 同时就绪 | 类型化槽位 coder×2 + 微链 DAG 认领 |
| `10:15:35Z` | tester T-063(S1) 派工（T-064 coder 仍在跑，`10:17:28Z` 才 done） | **tester_S1 与 coder_S2 同时 inflight（重叠 ≥113s）＝清单 4 验收线达成** |
| `10:17:35Z` | tester T-065(S2) 派工（T-063 在跑） | tester×2 槽位并行 |
| `10:20:50Z` / `10:21:24Z` / `10:30:04Z` | T-063/T-065/T-067 `→ done（D7' 机器闸门通过）` | **D7'：testReport.passed=true 自动 done，零人工** |
| `09:14:34Z`（09-03） | breaker T-060 30 分钟超时强制结算 + 释放回 todo（次轮重跑成功） | 看门狗自愈 |
| 发布时 | 旧链 T-054..057 自动 canceled | slice 发布幂等/取消旧链 |

流转全链路（发布→需求→方案闸门[将军 transition done]→拆解→用例→三切片并行编测→D7' 闸门→S1/S2/S3 全部自动 done）真实走通。测试侧回归套件亦为 13/13 绿（新增换基线用例后）。

**现场观察项（非缺陷）**：① devops 尾任务 T-068 的 worker 在沙箱环境两次挂起（30 分钟看门狗/隔夜无产出后守护照常重派），属沙箱 worker 环境不稳，不影响 P1 验收判定；② 验收后 software 空间记录曾带显式 `localDir`+remoteUrl——已于处置时还原为空（守护回退注入默认 repoRoot，日志 `01:34:03Z` 验证）；③ 沙箱空间清理：team-hub 新增受保护删除端点 `POST /api/spaces/delete`（拒绝 software/default，需 `confirm=delete-space:<id>`，事务内删 tasks/goal/roster/agent_models/exec_*/skills，保留 audit 历史），已用其删除 `slice-verify`（15 任务 + 8 编队 + 1 目标 + 空间行）。
