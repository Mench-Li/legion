# 军团编排架构 v3 —— 把切片流水线架设在 DSH 原生机制上

> 状态：**设计稿 v0.1**（待将军在文末决策点清单确认后定稿）
> 关联：`README.md`（现状）· `PLUGINS.md`（插件族）· `team-hub/server.mjs`（状态库）· `plugins/src/index.ts`（执行守护）· `roles.json`（岗位）· `workflows/`（将军侧模板）
> 一句话：**不再把 team-hub 改造成 DAG 引擎；编排收敛回 DSH 插件层（调度守护），team-hub 退守「权威状态库 + 审计 + 验收台」。**

---

## 0. 决策摘要（TL;DR）

1. **执行侧唯一引擎 = `dsh-scrum-worker` 守护插件**（`plugins/src/index.ts`，DSH daemon-loop 形态，经 `ctx.subagents` 派一次性 worker subagent）。它是现成的、DSH 原生形态的调度宿主，**升级它而不是另起炉灶**。
2. **串行的三个真实来源**（按代码核实）：
   - 目标发布生成**全串单链**（`createGoalChain`：每岗位 1 任务、`blockedBy=[prev]`）；
   - 守护并发闸门 `maxWorkers` **默认 1**（1..8）；
   - 依赖解锁是**惰性的**（`openDeps`/`assertUnblocked`）——机制本身支持 DAG，只是没人生成 DAG。
3. **目标形态**：目标发布生成「分析前缀链 + 编码切片束」。切片 = 一项可独立验收的编码→测试闭环；切片之间**无依赖**，只有切片内部微链（编码 → 测试）。「coder 不等 tester」由此在**调度决策集**里天然成立：`S_i 在测` 与 `S_{i+1} 在写` 是两个不同的可认领集合，互不阻塞。
4. **谁修失败**：tester worker **只出结构化报告**（JSON，含失败用例/日志/复现命令）；守护把失败项**回炉重派 coder worker**（fix 任务 + 报告进提示词），`maxFixPerSlice` 预算内自动、超预算升级将军。验证者独立 + 写码者自修，与 Codex/Claude/DSH 的行业收敛一致。※实现修订：`fixOf` 字段指向**失败的 tester 任务**（回炉源，而非源 coder），`fixCount` 记在 tester 上（见 §3.2/§5）。
5. **改动集中、可增量**：三处代码面——`team-hub/server.mjs`（+切片字段/端点）、`plugins/src/index.ts`（决策集）、`workbench`（呈现），分 P0–P3 落地，每阶段可独立验收。

---

## 1. 为什么是这条路线（三段论证）

- **对比 A「把 team-hub 改成 DAG 流水线引擎」**：状态机/认领/审计已足够通用，真正要改的只有生成函数——但**改完之后依然没有执行者去并行**，因为执行在守护里。等于改了 A 处还要在 B 处再改一遍。
- **对比 B「将军 goal-loop 亲自主导派发」**（持久士兵 + send_message 续聊修）：判断力强但**与将军会话生命周期绑定**、主上下文易失忆、多目标多切片时调度表靠 agent 记忆不可靠。
- **选 C「守护演进（本稿）」**：调度规则**进代码**（确定性、可测试、不依赖 agent 记性），实现单元仍是一次性 worker subagent（DSH 内建、上下文干净、worktree 续做），将军只保留**判断性职责**（闸门/验收/仲裁/升级）。这正是 Codex/Claude 收敛到的形态，也是 DSH 插件层的正统用法。

---

## 2. 现状精确盘点（代码级）

### 2.1 谁在跑（已核实）

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| team-hub v2 | `team-hub/server.mjs` | 无状态 API：任务/目标/roster/审计/SSE；**不执行任何 AI** |
| 调度守护 | `plugins/src/index.ts`（`@dsh-external/dsh-scrum-worker`） | 每 `intervalMs` 扫单：认领 → 建 worktree → 派 worker → 收报 → 提交/合入 → 流转 |
| worker | 守护 `ctx.subagents.start('spawn')` 派出的**一次性 subagent**，父 = 惰性 foreman agent | 只做实现，回报 `{status, summary, evidence, blocker}` |
| 将军（你） | DSH 会话 + workbench | 闸门验收（`gate` 阶段 in_review）、打回、hold、❓答复、模型/并发配置 |
| 遗留 | v1 `scrum/tasks.json` + taskctl + mesh + COMMAND.md 持久士兵模式 | 早期模式；v2 是日常主体，本文档不再扩展它 |

### 2.2 串行从哪来（三个来源）

1. **生成层**：`createGoalChain`（team-hub ~L649）——按空间编队顺序，**每岗位恰好 1 个任务**、`blockedBy=[上一个]`，形成 8 段单链；
2. **闸门层**：守护 `maxWorkers` **默认 1**（schema ~L81），哪怕有可并行任务也一次只派一个 worker；
3. **解锁层**：`openDeps`（守护 ~L1298）/ `assertUnblocked`（team-hub ~L362）惰性判断——**依赖全 done 才认领**，单链上天然串行。

### 2.3 已有的并行件（复用它，别重造）

| 已有能力 | 位置 | 说明 |
| --- | --- | --- |
| 认领互斥 + 乐观锁 | `claimTask` | 谁先 claim 谁干，多守护/多请求安全 |
| worktree 隔离 | 守护 `prepareWorktree`（~L601） | 每任务独立分支 `w/<任务id>`，复用续做、pre-push 拦截、autoPromote |
| 看门狗 / 租约 / 退避 | watchdog ~L915、`releaseStaleTasks`、abortRetry | worker 挂死/超时不会卡死整条线 |
| 打回纠错续做 | `workReturned`（~L1324/L1340） | in_progress 收到他人评论 → 带反馈重派、复用同一 worktree |
| 阶段流转 | `advancePipeline`（~L1343） | 中间阶段 done → 自动创建/解锁下一角色任务 |
| 闸门 | `gate:true` + `artifact`（roles.json） | 方案类阶段停在 in_review 等将军 |

> 结论：**并行需要的一切机制都在，缺的只是「生成层别再串」+「闸门放行」+「失败回炉」三件事。**

---

## 3. 目标模型：切片（Slice）

### 3.1 依赖图变化

```
今天（全串单链）                          目标（切片束）
T_req → T_res → T_breaker → T_td          T_req → T_res → T_breaker → T_td（分析前缀，仍串）
        → T_coder → T_rev → T_tester                 │ T_td done 后扇出
        → T_devops                              ┌─────┼──────┐
                                          coder_S1→tester_S1   coder_S2→tester_S2 …
                                          （切片间无依赖；S2 编码与 S1 测试并行）
                                                        全部 tester 通过后
                                                              │
                                                         T_devops（目标级收尾）
```

- **分析前缀**（需求→方案[闸门]→拆解→用例设计）保留现状串行——它们本来就该串行；
- **用例设计之后不再生成单任务**，改由拆解产物**注册切片**；
- 每个切片 = `coder_Si → tester_Si` 微链（reviewer 是否介入是策略选项 D5）；`tester_Si` 只 `blockedBy` 自己的 `coder_Si`，**与其他切片无关**；
- 目标级收尾 `devops`（部署/发布）`blockedBy = 全部 tester done`。

### 3.2 team-hub 数据增量（P1 已落地，实现即此）

`tasks` 表新增列（幂等迁移 `ensureColumn`）：

```sql
ALTER TABLE tasks ADD COLUMN slice    TEXT;     -- 切片归属键：coder/tester = `${tdId}:S<n>`；devops 尾 = tdId
ALTER TABLE tasks ADD COLUMN sliceIdx INTEGER;  -- 片内序号（1 基）
ALTER TABLE tasks ADD COLUMN fixOf    TEXT;     -- 仅 fix 任务：指向失败的 tester 任务 id（回炉源，非源 coder）
ALTER TABLE tasks ADD COLUMN fixCount INTEGER DEFAULT 0; -- tester 侧已回炉轮数（守护以「同 fixOf 非取消 fix 任务数」推导）
ALTER TABLE tasks ADD COLUMN testReport TEXT;   -- tester 结构化报告 JSON {passed, failures:[{name,log,repro}], summary, at, by}
ALTER TABLE tasks ADD COLUMN artifacts TEXT DEFAULT '[]'; -- 产物登记列
```

新端点（写纪律统一 `by` + audit + SSE，P1 已落地）：
- `POST /api/goal/slices` —— 展开切片束（coder_Si→tester_Si 微链 + devops 尾 blockedBy=全部 tester；幂等：同 test-designer 任务已展开则返回既有）；
- `POST /api/test-report` —— tester 结构化报告（D7' 机器闸门输入；仅 tester 任务、in_progress/in_review 可写，passed=false 必须给 failures）；
- `POST /api/progress` —— 守护进度心跳（租约保鲜，补 v1「/api/progress 404」缺口）；
- `POST /api/artifact` —— 产物登记（hub 版 taskctl artifact）；
- `POST /api/patch` —— diff 登记（hub 版 taskctl patch；守护 recordPatch 的 hub 落点）。

进度聚合：目标 percent 由「切片测试全通过」计，不再被中间任务稀释（细节见 P1）。

### 3.3 roles.json / 提示词

- 岗位 persona（roles.json 各 stage prompt）**不变**，继续作为 worker 提示词基底；
- coder worker 提示词追加：切片范围 + 切片验收 + **文件域约束**（只改本切片声明拥有的文件/目录）；
- tester worker 提示词追加：**只测不修** + 必须按 schema 回报 `{passed, failures:[{case,log,repro}], summary}`；
- fix worker（回炉重派的 coder）= coder persona + 失败报告 + fixCount 说明。

---

## 4. 调度守护 v3：每轮扫单决策集（核心）

保留现有扫单骨架（暂停/租约回收/看门狗/幂等），把「todo 全收」改为**按决策集收**。每轮 `sweep()` 计算：

```
输入：board（本 scope 全部任务）+ 配置（槽位/预算）+ testReport
① 释放过期租约（现状不变）
② readyToTest = tester 任务 todo/blocked && 依赖(coder_Si)done && tester 槽有空
   → 认领派 tester worker（独立上下文 = 验证者独立）
③ readyToCode = coder 任务 todo/blocked && 依赖(分析前缀)done && coder 槽有空
   → 认领派 coder worker（fix 任务同样走此道，占 coder 槽）
   ※ 关键：②与③互不依赖 —— S1 在测时 S2 仍可派 = 流水线重叠
④ D7' 机器闸门失败侧（fix 回炉）：tester 报告 passed=false → testReport 登记、tester 转 in_review，
   按预算建 fix coder 任务（role coder, fixOf=该 tester, slice 同片, blockedBy=[] 由守护条件把关，防 openDeps 死锁）；
   预算 = 同 fixOf 非取消 fix 数 ≥ maxFixPerSlice → 不建，❓升级将军（此后该 tester 绝不自动重开）；
   fix 合入 done → 守护重开 tester（in_review→todo）→ 下轮重派重测（提示词带上一轮 testReport）
⑤ 收尾：全部 tester done → 解锁 devops 尾（expandGoalSlices 预建，blockedBy=全部 tester）
⑥ 现状的 blocked 续做 / in_progress 反馈纠错 / 闸门等待逻辑全部保留
```

并发闸门升级为**类型化槽位**（替换单一 `maxWorkers`）：

```
coderSlots: 2   -- 同一切片只能 1 个 coder 在跑（防同 worktree 写冲突），跨切片并行
testerSlots: 2  -- 并行测试数（受环境隔离约束，见 §7）
perGoalCap: 4   -- 单目标在跑上限（跨目标公平）
maxFixPerSlice: 2
```

槽位空闲即从决策集按序取；`inflight` 记账沿用。规则全在代码 → 可单测，不靠 agent 记性。

---

## 5. 谁修失败（规则固定）

| 角色 | 职责 | 依据 |
| --- | --- | --- |
| tester worker | 只测、只报告（结构化 JSON），**永不修代码** | 验证者独立（LEGION.md/COMMAND 纪律） |
| 修复者 | **同切片的 coder**（守护重派，复用 `w/<任务id>` worktree 续做 + 失败报告进提示词） | 写码者上下文在文件/分支里，报告补全信息，冷启但信息全 |
| 守护 | 读 `testReport` → 建 fix 任务 / 计数 / 超预算升级 | 决策在代码 |
| 将军 | fixCount 超预算 → blocked+❓ 时介入仲裁；验收 tester done | 人留判断 |

- **验收链**：fix coder done（守护 advance）→ 重派 tester 跑**同一组失败用例 + 该切片回归** → 全绿才 tester done（将军验收）→ 切片闭环。
- **为什么不用"持久士兵 send_message 续聊"做修复**：守护的原生形态是一次性 worker + worktree 持久，`send_message` 续聊需要守护维护常驻 subagent id 生命周期——复杂度更高、收益（上下文热）有限；现有「worktree 复用 + 反馈进提示词」已能承载修复（打回纠错路径已被生产验证）。策略选项 D6：分析类岗位仍可走持久士兵。

---

## 6. 验证者独立与闸门

- tester 每次都是**全新 worker 上下文**，看不到 coder 的推理过程——确认偏误天然隔离；
- 中间切片任务沿用现状：非 gate 阶段 worker done 即 autoPromote + advance；`tester_Si` 的 done 默认**仍须将军验收**（或按 D7 策略改为 testReport 全绿即自动 done，将军只卡目标级收尾）；
- 目标级：将军对 devops/收尾验收 = 「目标 done」的唯一入口（现状不变）。

---

## 7. 并行测试的隔离约束（硬前提）

- **文件域**：breaker 拆解时必须给每个切片声明**不相交的文件/目录域**（写入切片定义），守护可校验重叠并拒绝注册/打回——这是并行 merge 不冲突的根本保证；
- **merge 冲突策略**：切片并行各自合入主分支可能冲突 → 每空间**顺序合入队列**（一次一个 autoPromote），冲突则该切片 blocked 交将军裁决（现状已有失败保留分支的手工合入指引）；
- **测试环境**：并行 tester 各跑在自己的 worktree 上；共享的依赖安装/构建缓存/端口/测试库需要按任务隔离或加锁（沿用现状单 worker 已验证的做法，只是多份并发——P2 实现细节里确认，必要时测试用临时 DB/独立端口）；
- **跨目标**：同空间多目标共享同一仓库时同样受合入队列约束（perGoalCap 控制激进程度）。

---

## 8. 将军与 UI 变化

- 将军职责**不变多**：闸门验收、打回、hold、❓仲裁、模型配置、暂停、目标级验收；新增一个只读视图需求——「切片全景」。
- workbench（P3）：
  - 任务集按 **目标 → 切片** 分组（泳道仍按岗位）；
  - 切片卡片显示 `编码中 / 测试中 / fix×N / 已通过`；
  - tester 报告可读视图（failures 列表 + repro 命令）；
  - `⚡ 持续执行编排 / 🤖 派 AI 执行`（exec queue 通道）与守护自动交接的关系在 P0 确认后收敛（决策点 D4），避免双调度源。

---

## 9. 分阶段落地与验收

| 阶段 | 改动面 | 验收标准 |
| --- | --- | --- |
| **P0 探针** | 不改代码。确认：① 当前生产走守护 hub 全自动还是 exec queue 半自动（`NON_AUTO_ROLES` 边界）；② `plugins` 的 junction/构建/注入链路（`pnpm build` → `lib/` → profile）；③ 现有 `worker-regression.test.mjs` 的 mock 模式可复用程度 | 一份「现状确认单」+ 复现一次人工触发全自动流水线 |
| **P1 切片束 + 并行重叠** | team-hub：`slice` 列族 + `/api/goal/slices` + 目标发布双模式（chain/slice）；守护：决策集 ②③ + 类型化槽位；`createGoalChain` 在 coder 岗位处截断 | 2 切片目标的守护日志出现 **tester_S1 与 coder_S2 同时 in flight**；现有回归测试全绿 |
| **P2 fix 回炉** | `testReport` 列 + `/api/test-report`；守护决策集 ④ + `maxFixPerSlice` + 升级路径；tester worker 提示词（只测不修 + schema） | 故意留 bug 的切片：自动经历 fail → fix → retest → 通过；超预算切片自动 blocked + ❓ |
| **P3 呈现与打磨** | workbench 切片全景；合入队列与文件域校验；跨目标公平与并发上限配置化；清理 exec queue/遗留通道 | 将军全程只做闸门与目标验收，可完成 3 切片目标全自动闭环 |

每阶段新增/更新 `plugins/tests/*.test.mjs`（沿用假 hub HTTP mock），守护决策集写成**纯函数**便于单测。

---

## 10. 决策点清单（待将军确认，默认项=推荐）

| # | 决策点 | 选项 | 推荐 |
| --- | --- | --- | --- |
| D1 | 调度宿主 | A. 守护插件演进（本稿） / B. 将军 goal-loop 派发 / C. 混合 | **A**（机械调度进代码；将军只留判断） |
| D2 | 切片来源 | A. breaker 经结构化注册 / B. 解析 `TASK_BREAKDOWN.md` / C. 固定 N 片 | **A**；实现走混合：breaker 写机器可读 `## slices` 清单 → 守护解析 → `POST /api/goal/slices`（breaker worker 不能直连 HTTP，见 §4/P1-4）✅已落地 |
| D3 | 切片文件域约束 | A. 拆解时声明 + 守护校验重叠 / B. 仅纪律不校验 | **A**（并行合入安全的前提） |
| D4 | 写码自动化闸门 | A. 切片化后守护全自动跑写码（沿用现状非 gate 自动 advance）/ B. 每切片人工「派 AI 执行」 | **A**（v3 目标就是去掉阶段 barrier；将军保留 tester done 验收） |
| D5 | reviewer 是否介入微链 | A. 不介入（coder→tester）/ B. 介入（coder→reviewer→tester） | **A 起步**，需要时每切片加 reviewer 槽 |
| D6 | 修复模式 | A. 一次性 worker 重派 + worktree 续做 / B. 持久士兵 send_message 续聊 | **A**（守护原生形态，已被打回纠错验证）；分析类岗位可另走 B |
| D7 | tester done 验收 | A. 全绿仍须将军验收 / B. testReport 全绿自动 done，将军只卡目标级 | **D7'（机器闸门，将军确认版 B 修订）**：passed=true 才自动 done；失败 → fix 回炉；fix 预算用尽 ❓ 升级将军。✅已落地（§4 ④） |
| D8 | maxFixPerSlice / 槽位 | coder×2、tester×2、perGoal×4、fix×2 | 默认如上（守护配置 sliceCoderSlots/sliceTesterSlots/perGoalSliceCap/maxFixPerSlice）✅已落地 |

---

## 附：术语映射（DSH ↔ Legion）

| DSH 原生 | Legion 里对应 | 说明 |
| --- | --- | --- |
| daemon 插件（timer + subagent runtime） | 调度守护 v3 | 机械调度的宿主 |
| 一次性 subagent（`ctx.subagents.start`） | worker（每任务一个） | 实现单元，上下文干净 |
| worktree / 文件记忆 | `w/<任务id>` 分支 + 产物文档 | 跨轮状态，worker 冷启但信息全 |
| 后台任务完成通知 | 守护轮询 board（`intervalMs`） | daemon 场景轮询优于事件 |
| goal 自动续轮 | 将军（你）的判断性轮次 | 只处理闸门/仲裁/升级 |
| workflow 扇出 | `workflows/batch-execute.js` | 一次性批量（分析/调研）仍可用 |
| send_message 续聊 | 持久士兵（mesh） | 仅分析/讨论类岗位保留 |

---

## 附：P1 实施记录（v0.2 增补）

**已落地（P1-0..P1-7，2026-09 实现，非仅设计稿）：**

- team-hub `server.mjs`：切片列族幂等迁移；`createGoalChain(scope, objective, mode)` 双模式（chain 全串 / slice 前缀链至 test-designer，缺岗自动回退 chain）；`POST /api/goal` 支持 `mode:'slice'`；新增 `POST /api/goal/slices`（展开 coder_Si→tester_Si + devops 尾，幂等）、`POST /api/test-report`、`POST /api/progress`、`POST /api/patch`、`POST /api/artifact`（全带 by+audit+SSE 写纪律）；`createTask`/`/api/create` 支持 `blockedBy/slice/sliceIdx/fixOf`。
- 守护 `plugins/src/index.ts`：`Task`/`WorkerReport`+schema 增 testReport；配置增 `sliceCoderSlots/sliceTesterSlots/perGoalSliceCap/maxFixPerSlice`；`parseSlices()` 解析 breaker 机器可读清单；`advancePipeline` 对切片/fix/分析尾跳过（防重复建任务）；扫单新增切片类型化槽位闸门 + step5 `orchestrateSlices`（readyToExpand 注册切片束、fix 全 done 后重开 tester 重测、预算用尽不再自动重开）；D7' `settleSliceTest`（pass→advance done by tester；fail→in_review+建 fix/升级）；`recordPatch` hub 落点 `/api/patch`（消除「taskctl: 未知任务 T-0xx」噪音）。
- `roles.json` breaker 提示词：产出 `## slices` 机器可读切片清单（`- S1 | 标题 | 文件域 | 验收`）。
- 测试 `plugins/tests/slice-orchestration.test.mjs`（4 例：展开注册解析 / pass 自动 done / fail 建 fix / fix done 重开+预算护栏）+ 既有 worker-regression 7 例 —— **11/11 绿**；`DSH_CHECKOUT=D:/project/DSH/dsh/deepseek-harness bash scripts/build.sh` 编译通过。

**验收偏差（实现相对初稿的语义修订）：**
- `fixOf` 指向**失败的 tester 任务**（回炉源），`fixCount` 归 tester；初稿曾写「源 coder」。
- fix coder 任务 `blockedBy=[]`（创建由守护条件闸门把关），避免与 in_review tester 的 openDeps 死锁。
- tester 失败后**留在 in_review**（不自动 blocked）；重测 = fix 合入后守护重开 `in_review→todo`。
- 升级条件：同 fixOf 非取消 fix 数 ≥ maxFixPerSlice（预算 2 → 第 3 次测试失败升级）。

**未落地（需在部署侧执行，不在本会话内做）：**
- 生产 profile（`~/.dsh/profiles/web/cordis.patch.yml`）`maxWorkers` 提升（≥2）与守护/team-hub 重启（当前进程即宿主，重启会中断本会话）；
- 以 `mode:'slice'` 发布真实目标 → 守护日志出现 tester_S1 与 coder_S2 同时 inflight（P1 验收线的现场证据）。
  现场执行步骤已整理为独立 runbook：**`docs/P1-LIVE-ROLLOUT.md`**（沙箱 scope + profile 改动 + 重启 + 日志证据点）。

**v0.4 现场验收（2026-09-04 ✅ 已执行，见 `docs/P0-CONFIRMATION.md §9`）：**
- 按 runbook 在沙箱 scope `slice-verify`（真实守护/真实 team-hub v2/真实 worker，临时 `maxWorkers:2`）完成验收：
  切片束注册（2N+1=7）→ 两切片 coder 并行（coder×2 槽位）→ **tester_S1 与 coder_S2 同时 inflight（重叠 ≥113s）** → 三切片 tester 全部 `done（D7' 机器闸门通过）` 自动 done。
- 原始日志证据：`D:\tmp\slice-acceptance-evidence.txt`；生产已回滚（scope=software / maxWorkers=1），新 team-hub v2 与守护均带 P1 代码运行。
- 观察项：devops 尾任务 worker 在沙箱环境两次挂起（看门狗正常接管重派）；software 空间记录已还原为空绑定（守护回退注入默认 repoRoot，日志验证）；沙箱空间 `slice-verify` 已清理——team-hub 新增 `POST /api/spaces/delete`（受保护端点：拒绝 software/default、需 `confirm=delete-space:<id>`、事务内删 scope 数据、保留 audit），删除 15 任务 + 8 编队 + 1 目标 + 空间行。

**v0.3 修订（实现审查补丁）：**
- 重测换基线：fix 合入后守护重开 tester 前，先清理 tester 上一轮的 worktree/分支（`worktree remove --force` + `branch -D w/<testerId>`），
  使重测在**包含修复的最新主分支**上重建——修复了「prepareWorktree 复用旧快照 → 重测跑在合入修复前的代码」的缺陷（打回纠错=续做复用；重测=换基线重建，语义分离）。
