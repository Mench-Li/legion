<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-166 HEAD a3abf4e）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 .ci/<run>/summary.json。
<!-- evidence-banner:end -->

# T-166 需求说明：并行任务文件冲突治理（按设计文档落地）

> 阶段：需求澄清（requirement）｜任务：T-166（[auto-goal]，所属目标 G-mujfc9vi-1 · software · chain）
> 上游 goal 原句（将军）：**[auto-goal] 目标：docs/superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md，按照设计文档为我完成开发**
> 本目标文档目录：docs/G-mujfc9vi-1/（本文即该目录 REQUIREMENTS.md；**不写/不碰仓库根 docs/ 与其他目标目录的同名阶段文档**）
> 下游：researcher（docs/G-mujfc9vi-1/RESEARCH.md）→ breaker（TASK_BREAKDOWN.md）→ test-designer（TEST_CASES.md）→ coder → reviewer → tester（TEST_REPORT.md）→ devops（DEPLOY.md）
> 评估基准：w/T-166 HEAD a3abf4e；上游设计文档 [2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)（设计自述状态：**待评审**）。本文 file:line 均指本 worktree 内容。

## 0. 文档状态与阅读说明

- 本文件是 T-166「需求澄清」阶段产出，落在**目标级文档目录** docs/G-mujfc9vi-1/（守护按目标隔离注入；先例 docs/G-mtpq729o-1/REQUIREMENTS.md、docs/G-mtr3su6f-1/REQUIREMENTS.md）。
- 沿用仓库标注惯例区分三类内容：
  - ✅ **已确认口径**：由代码 / 测试 / 设计文档 / 历史证据钉死，下游可直接依据；
  - ⚖️ **待将军裁决**：影响范围/形态/优先级的关键分歧，裁决前默认按「倾向 + 默认值」推进，该默认值是**假设**不是结论（§8 D-*，将军在验收评论逐条答复或修正）；
  - ❓ **遗留/开放问题**：默认取值见各条，明示假设，供将军补充输入（§8 O-*）。
- **本阶段只产出本文档**：不做技术选型与实现细节（新表如何建、事务怎么写、集成 worker 放哪、UI 组件怎么改 → researcher/coder）、不写代码、不改仓库实现、不跑 taskctl/看板写接口、不 push。所有「验收口径」写成**可测语句**（行为断言 / 命令 / 判据），供 breaker 切分、test-designer 直转用例、将军对照验收。
- **本阶段完成 ≠ 目标全部完成**：本文交付「明确可验收的需求说明 + 范围边界 + 需求清单 + 风险依赖假设 + 显式裁决项」；实现由后续阶段按流水线推进。
- **口径来源纪律**：本目标是「按设计文档开发」，因此**设计文档 §3~§11 的产品规则与 §11.1 九场景是需求基线**；设计文档未写死的技术形态留给下游。设计文档自身标注「待评审」的默认决策（§12 末尾两条）与本文 §8 D-* 一并呈将军确认。

## 1. 目标解读：将军诉求 → 可验收语义

> 上游是一份**完整的设计文档**（12 节），不是一句需求。本阶段把它翻译成「可开发、可验证」的需求清单；设计文档的角色 = 需求输入源，最终验收以设计 §11.1 的九个场景为准。

| 设计文档片段 | 澄清后语义 | 现状定性（证据见 §2） | 对应需求 |
| --- | --- | --- | --- |
| 标题「Legion 并行任务文件冲突治理设计」+ §1 摘要 | 要交付的是「**同仓库多任务写入调度 + 成果集成 + 冲突裁决**」这一整套受管能力：开工前识别写入重叠、执行时隔离并监测实际改动、完成后按仓库串行集成并验证集成结果。目标是**用户无需知道 worktree/Git 冲突标记/手工合并命令** | 已有 worktree 隔离与 fileDomain、/api/overlaps、autoPromote、调解员、claim+epoch 等**分散资产**，缺「预防（开工前占位）」与「交付（集成+集成后验证）」两端（§2.2） | R-1 ~ R-6 |
| §1 成功标准 1「同一物理目录不同时写；已知重叠不同时获得写入资格」 | 写入资格由 team-hub 原子授予；同仓库相交路径不得有两个活跃写入者 | 现状 claim 只按任务队列领取，**不看文件**；越域检查在 merge 前、/api/overlaps 基于已生成补丁（§2.2） | R-2 / R-3 |
| §1 成功标准 2「后完成的任务不静默丢失/覆盖/误报产出」 | 写入范围持续占用到交付完成或明确放弃；等待者基于最新目标版本重启工作区且不重置 WIP | 现状 autoPromote 直合主工作区，无交付子状态（§2.2） | R-3 / R-4 / R-6 |
| §1 成功标准 3「Git 自动合并成功后仍要在集成后代码上验证；失败不得记为已交付」 | 集成必须走「临时隔离集成工作区产出候选合并 → 在候选上跑验收 → 仅快进接到目标分支」；验证失败目标分支不动 | 现状直合且**无集成后验证**（§2.2） | R-4 |
| §1 成功标准 4「冲突/崩溃/本地未提交改动均保留可恢复产物并给明确下一步」 | 全量 journal + 对账恢复；不 stash 用户改动；非 Git/不可规范化明确降级 | 现状合入失败 abort + 保留分支（part），无 journal/恢复协议（§2.2） | R-4 / R-6 / R-7 |
| §1 成功标准 5「任务卡区分执行/等待集成/待裁决/已交付，不把 Agent 写完当已交付」 | 任务卡新增交付子状态；done 仅在交付为 integrated 且原验收通过后产生 | tasks.status 现为 backlog/todo/in_progress/in_review/blocked/done/canceled（server.mjs:375-382），无交付子状态（§2.2） | R-5 / R-6 |
| §3.1 用户可见规则（范围可编辑 / 未声明只读 / 等待说明 / 待集成与已交付 / 语义裁决 / 本地脏改动暂停集成） | 六条用户可感知行为，逐条可测（见 §5 各 R 验收口径与 §6） | 现状均无（§2.2） | R-3 / R-5 / R-6 |
| §3.2 状态分层（交付子状态词表；写入调度状态词表；done 语义） | 不扩 run_attempts.state；新增 task_deliveries 与独立写入调度状态；done 口径改写 | 现状无（§2.2） | R-4 / R-6 |
| §4 核心数据与权威边界（5 张表 / 文件域=许可上界 / 路径匹配规则） | team-hub SQLite 唯一调度事实源；仓库身份按 git common-dir；一仓库一目标 ref；intent ⊆ fileDomain；文件/目录两类明确匹配 | 现状 tasks.fileDomain 存在（许可上界）但无 intent/reservation 表；越域判定用字符串前缀 startsWith（§2.2） | R-1 / R-2 |
| §5 调度协议（claim 原子授资格 / 冲突跳过不烧重试 / 队列不队头阻塞 / 授权快照不可模型改 / 运行中扩域 / 迟到写入 reconciling） | 开工前与执行时的完整写入资格协议 | 现状全无（§2.2） | R-2 / R-3 |
| §6 集成队列与交付协议（入队条件 / 单仓库步骤 1-6 / Git 与 SQLite 非原子 / 冲突裁决 4 类） | 唯一 integration worker + journal + 集成后验证 + 冲突分类处理 | 现状 autoPromote 直合、mediation.ts 独立调解（§2.2） | R-4 / R-6 |
| §7 Workbench 交互（交付徽标 / 当前占用 / 为什么等待 / 裁决面板 / version CAS 409） | 用户全程不必敲 git 命令 | 现状只有 patch 重叠分组展示（TaskDetailModal.tsx:578）（§2.2） | R-5 |
| §8 API 与模块边界（4 组接口 + 权限沿用 F-02） | 服务端解析仓库/ref，不接受浏览器传绝对路径/shell/任意 ref | 现状部分接口有（/api/overlaps 等），治理接口全无（§2.2） | R-2 / R-4 / R-5 |
| §9 失败、恢复与边界条件（9 行表） | 每种失败都有确定行为与可恢复产物 | 现状部分有（merge abort），多数无（§2.2） | R-2 / R-3 / R-4 / R-6 / R-7 |
| §10 迁移与发布（观察→调度→集成→收口；开关按仓库/空间；回滚不删数据） | 分阶段灰度 + 可回滚，不一步到位强推 | 现状无治理能力故无迁移（§2.2） | R-6 |
| §11 验收与度量（9 个必须通过场景 + 7 项指标 + 发布门槛） | 本目标的**验收主口径**（§6 逐条转写）；指标不可读时显示「暂无读数及原因」，不显示为零 | 现状无（§2.2） | R-8 + §6 |
| §12 实施切片 1~6（路径纯函数 / intent+reservation 事务 / Orchestrator 接线 / delivery+集成 worker / Workbench / legacy 迁移收口） | 需求清单的天然优先级排序（R-1..R-6） | 切片全部未落地（grep 零命中，§2.2） | R-1 ~ R-6 |
| §12 末尾两条默认决策（不提供同文件强制并行写；每受管仓库必须配置 ≥1 可执行集成验证，未配置停在 needs-review，不得跳过验证） | 首版产品策略，**实现不得自行放宽** | 现状无（§2.2） | R-4 / R-5（D-4/D-9 供确认） |

> ⚠️ **「按设计文档完成开发」的两处口径澄清（本阶段最重要结论）**
> 1. **设计文档自身尚未评审通过**：其第 3 行状态为「待评审」，且 §12 明言「评审可修改」。因此本文默认「照设计实现」，但把设计里的默认决策与显式分叉汇成 §8 D-*，请将军逐条确认后由守护带回下游（不阻塞，默认按倾向推进）。
> 2. **这是一份体量很大的设计**（5 张表、跨进程事务、集成 worker、UI、迁移灰度），而本目标链只有一名 coder/reviewer/tester。本文默认按 §12 切片顺序**全量交付、P0 先行**；若将军只想要首个可验证增量，请按 §8 D-1 裁决范围（不裁决则按默认推进）。

## 2. 现状盘点与缺口判定（✅ 证据锚定）

### 2.1 已有资产（设计 §2.2 复核，逐条命中）

| 设计所称现有资产 | 复核证据（w/T-166 HEAD a3abf4e） | 结论 |
| --- | --- | --- |
| 每任务独立 worktree；产品运行面要求 worktree 在仓库外 | plugins/src/workspace.ts:1-34（prepareWorktree/commitWorktree/workspace 解析）；orchestrator/workspace/index.mjs:19-21、:139-173（worktree 落 DataDir/worktrees/...，与仓库重叠即报错） | ✅ 存在，保留隔离 |
| tasks.fileDomain 作为许可上界，守护在合入前检测越域，为空时不拦 | team-hub/server.mjs:1693-1705（列定义）；plugins/src/index.ts:1286-1304（changedFilesOfBranch/outsideDomainFiles）；:1529-1536（提示词文件域约束段） | ✅ 存在，但**判定为字符串前缀 startsWith**（:1298-1303），无文件/目录类型区分、无 Windows 大小写与越界规范化 |
| GET /api/overlaps 从已有 patch 记录回看同文件改动 | team-hub/routes/team-views.mjs:126-163（按补丁文件分组）；workbench/src/api.ts:469；TaskDetailModal.tsx:167、:578-583（展示） | ✅ 存在，明确是**事后审计**，无法阻止同时开工 |
| autoPromote 对主工作区直接 git merge，失败 abort 并保留任务分支 | plugins/src/index.ts:1470-1490（merge --no-ff → 失败 abort；成功 worktree remove --force + branch -D） | ✅ 存在，是**唯一集成入口的收敛对象** |
| mediation 对失败 merge 调 AI 调解员并尝试提交 | plugins/src/mediation.ts（createMergeMediation，:272 起主流程）；plugins/src/index.ts:523（进程内 mediating Set）、:2538-2566（sweep） | ✅ 存在，且设计正确指出**进程内 Set 不是跨进程仓库锁** |
| team-hub run-store：Task/Attempt/Lease/Run 分离，claim 与 epoch fencing 已存在 | team-hub/run-store.mjs:1421-1468（claim：withTx 内条件 UPDATE + lease_epoch 递增 + 事件），:253/:299/:328...（各表 lease_epoch 列），:230（BEGIN IMMEDIATE 内重读） | ✅ 存在，是 R-2 事务扩展的底座 |
| 看板 tasks.status | team-hub/server.mjs:375-382（backlog/todo/in_progress/in_review/blocked/done/canceled 及合法迁移） | ✅ 存在；R-6 要改的是 **done 的产生条件**，不是词表 |

### 2.2 缺口（负向 grep 与结构证据）

| 缺口 | 证据 |
| --- | --- |
| 设计新增的 5 张表 / 关键概念**零实现** | 全仓 grep task_write_intents / write_reservations / task_deliveries / integration_jobs / integration_events / schedulingState / deliveryState / FILE_CONTENTION **仅命中设计文档本身**，无任何代码/迁移/测试命中 |
| 开工前文件占用判断 | claim（run-store.mjs:1421+）按任务队列领取，**没有文件维度**；不存在任何 reservation/占用池代码 |
| 运行中的写入资格校验与扩域 | 无 pre-execute 路径/epoch/intent revision 校验；无扩域申请接口；工作区只在 prepareWorktree 时创建（plugins/src/workspace.ts） |
| 交付子状态与集成 job | 无 task_deliveries / integration_jobs / integration_events；tasks.status 直接由流水线推进 |
| 集成后验证 | autoPromote（plugins:1470）只做 git merge，**合并成功后无任何验证步骤**；「已合入」即被后续流程当作完成 |
| 仓库级「已登记验证命令」 | 全仓 grep verifyCommand / verificationCommand / commands_json / registeredCommands 零命中；team-hub/acceptance-store 的 validations 是 **attempt 级验收结论**（acceptance-store.test.mjs），不是「仓库可执行命令清单」。设计 §6.2 步骤 4 所依赖的登记面**当前不存在**（§8 D-4） |
| Workbench 交付面 | 无交付徽标、无「当前占用/为什么等待」、无裁决面板与 version CAS；现有只有 patch 重叠分组（TaskDetailModal.tsx:578） |
| 指标 | 设计 §11 的 7 项指标无采集与展示面 |

### 2.3 本阶段的「按文档开发」风险定性

- 设计覆盖 6 个切片、跨越 **team-hub（数据/事务/API）+ plugins 守护（编排/集成）+ workbench（UI）+ orchestrator（工作区）** 四个面，且含跨进程崩溃恢复与数据库迁移；单条目标链的容量是主要不确定性（§7 RK-7）。
- 设计明确「Git 与 SQLite 不能组成单一原子事务」「外部 Git 进程不受 Legion 租约约束」——这些是**验收必须覆盖的失败注入点**，不是可省略的边角（§6 场景 6、§5 R-4）。
- 自举风险：本仓正是 Legion 自身，若治理一落地就对**正在实现它的任务**生效，可能自我阻塞（§8 D-2/D-3）。

## 3. 关键术语表（本文件口径，消除歧义）

| 术语 | 定义（本需求采用） |
| --- | --- |
| 写入范围（预计修改范围） | 任务规划期给出的、本次计划写入的仓库相对路径集合；调度依据，不能被 Agent 提示词替代 |
| 写入意图（write intent） | 一次「我打算写哪些路径」的持久声明（设计表 task_write_intents），是本次真正计划范围；必须是任务「许可上界」的子集 |
| 许可上界（fileDomain） | 任务被允许修改的**最大**范围（现有 tasks.fileDomain）；intent ⊆ 许可上界，最终 diff ⊆ intent |
| 写入预约（write reservation） | 对某仓库某路径集合的**活跃占用**（设计表 write_reservations）；同仓库活跃预约不得覆盖相交路径 |
| 写入资格 | 一个任务获得在某仓库写入的权利：由 claim 事务原子授予 Attempt lease + 首次 reservation；无资格时只能用只读工具 |
| 路径规范化 | 拒绝绝对路径、..、空路径、.git、符号链接越界后得到的仓库相对规范路径；再按仓库配置处理 Windows 大小写差异 |
| 文件 / 目录两类匹配 | 不接受任意 glob：文件按精确路径；目录按**路径段边界**匹配（src/a 不得覆盖 src/ab） |
| 冲突（文件重叠） | 同一仓库内两个活跃预约/意图的路径相交（含重命名的旧路径与新路径两端）；同文件不同代码段首版仍视为重叠 |
| 等待写入资格 | 任务因文件被占用而未获资格；看板状态保留 todo，另设 schedulingState=waiting-file；**不是**执行失败，不消耗重试额度 |
| 交付（delivery） | 一次「把某 Attempt 的成果集成为目标分支」的实体与子状态机（设计表 task_deliveries）；一次交付唯一、版本 CAS |
| 交付子状态 | 固定词表：awaiting-acceptance / ready / preparing / validating / needs-review / integrated / abandoned（integrated 与 abandoned 为终态） |
| 写入调度状态 | 独立词表：unplanned / waiting-file / reserved / reconciling / released；不得用交付状态代替文件占用状态 |
| 集成 job | 对某仓库某目标 ref 的一次受管 Git 集成操作（设计表 integration_jobs）；同仓库同时至多一个，带 epoch 租约 |
| 集成工作区 | 从 expected_head 生成候选合并提交的**临时隔离工作区**；候选合并与验证在此完成，不占用用户工作区 |
| expected_head | 认领集成 job 时读到的目标 ref SHA；最终提交前必须复核目标 ref 仍等于它，否则候选作废重算 |
| 集成后验证 | 在**候选合并提交**上运行任务指定验证 + 仓库规定的受影响回归；命令来自仓库已登记的命令及参数列表（非模型任意 shell 字符串） |
| epoch fencing | 以 Attempt/租约 epoch 拒绝过期写入与结果上报；旧 epoch 的迟到写入不得进入 |
| reconciling（冻结/对账中） | 取消/重试/租约过期时先冻结旧 epoch；在旧执行进程或 Git 状态未确认结束前，reservation 停在 reconciling 而非立即释放 |
| 崩溃 journal | 集成 job 的 prepared → applying → ref-updated → finalized 持久日志；恢复时与 Git SHA/可达性对账 |
| legacy-unknown | 历史任务的 done 不倒推为「已验证集成」，迁移时显示的交付状态，避免制造假成功证据 |
| 语义冲突 | 两个任务修改同一接口行为/校验规则/配置默认值等，需要**需求取舍**的冲突（与 Git 内容冲突分开处理） |
| 受管仓库 | 被 Legion 治理的、绑定 Git 仓库并配置了交付目标 ref 的仓库；非 Git 工作区只允许一个写入任务 |
| 仓库身份 | 规范化的 **Git common-dir 实路径**，不能只用空间 ID（多个空间可绑同一仓库） |
| 只读任务 | 不申请 write reservation 的任务（调研/评审/无关文件任务）；始终可并行 |

## 4. 范围边界（总纲：做什么 / 明确不做什么）

### 4.1 总「做什么」（✅ 本阶段与后续阶段共同边界）

- DO-1：产出编号需求清单 R-1~R-9 + 优先级 + 每条 背景/目标/做什么/不做什么/可测验收口径（§5）。
- DO-2：把设计文档 §3~§11 的产品规则逐条转成可测语句，以 §11.1 九场景为 E2E 主口径（§1、§6）。
- DO-3：现状与缺口全部以真实证据锚定（§2、§11），不把设计文档的自述当成已验证事实。
- DO-4：关键歧义显式列出（§8 D-1~D-10 各带倾向与默认值；默认值明示为假设），供将军裁决后由守护带回下游。
- DO-5：后续阶段按需求清单实现并逐条验证：researcher 选型 → breaker 按文件域切片 → coder 实现 → tester 真实命令验证（含 §6 失败注入场景）→ devops 迁移/灰度/回滚文档。
- DO-6：实现只落当前 worktree（分支 w/T-166），不 push，不联网下依赖；验证用真实命令（typecheck / build / test / run-ci 至少其一，且逐条对应验收）。

### 4.2 总「明确不做什么」（🚫 所有阶段共同，源出设计 §1/§5/§6/§10 的显式边界）

- 🚫 **不做行级协同编辑**，不实现「两个任务同时编辑同一文件同一区域」的合并编辑能力（设计 §1）。
- 🚫 **不自动理解所有语义冲突**，不承诺机器自动判断接口行为/规则冲突并替用户取舍（设计 §1、§6.3）。
- 🚫 **不做跨主机分布式锁**（设计 §1、§9）。
- 🚫 **不自动 stash 用户的未提交改动**，不覆盖用户工作区（设计 §3.1、§6.2 步骤 2、§9）。
- 🚫 **不提供「同文件强制并行写入」**按钮/开关（设计 §7、§12 首版默认决策）；需要并行的用户只能拆成只读调研或互不相交文件任务。
- 🚫 **首版不管理一仓库多个交付目标分支**；一个受管仓库绑定一个目标 ref，切分支则集成暂停并要求重新绑定（设计 §4）。
- 🚫 **不改 run_attempts.state 去表达 Git 交付**（设计 §3.2）。
- 🚫 **不把交付状态当文件占用状态用**（两套状态独立，设计 §3.2/§4）。
- 🚫 **不做符号/代码区域级放行**（首版同文件不同代码段仍视为重叠；后续按验证数据再议，设计 §9）。
- 🚫 **非 Git 工作区不做版本快照与回滚机制**，只做「单写入 + 明确降级提示」（设计 §1、§9）。
- 🚫 **不提供「跳过验证并标记已交付」**；未配置仓库验证命令的任务停在 needs-review（设计 §12）。
- 🚫 **不在集成时对用户工作区重做一次可能产生不同结果的冲突调解**；候选与验证只在临时集成工作区完成（设计 §6.2 步骤 6）。
- 🚫 本阶段不写代码、不改仓库实现、不跑 taskctl/看板写接口、不 push、不下依赖。
- 🚫 不在生产库/生产仓库上做写入型验证与失败注入；后续阶段验证一律隔离实例/临时库/临时仓库（§7 RK-8）。

## 5. 需求清单（编号 + 优先级 + 验收口径）

> 优先级与设计 §12 切片顺序对齐：R-1~R-4 = **P0**（预防 + 调度 + 集成 + 集成后验证，缺一则目标不成立）；R-5/R-6 = **P1**（用户面与收口）；R-7 = **P1**（降级边界）；R-8/R-9 = **P2**（度量/文档）。验收口径均为**可测语句**；机制与技术形态由 researcher/breaker/coder 落定，本文只钉行为与判据。

### R-1（P0）路径规范化与冲突判定纯函数（设计 §4、§12 切片 1）

**背景**：设计把「谁和谁冲突」建立在确定的路径语义上：文件/目录两类明确类型、拒绝绝对路径/..//空路径/.git/符号链接越界、Windows 大小写差异、目录按段边界、重命名占两端。现状越域判定（plugins/src/index.ts:1298-1303）只是字符串前缀 startsWith，src/a 会错误覆盖 src/ab；工作区内也没有共享的规范化函数，/api/overlaps（team-views.mjs:126）只按补丁里的字符串分组。

**目标**：产出一组**纯函数**（无 I/O、确定性、可单测）完成：路径规范化、文件/目录两类匹配、相交判定（含重命名两端、Windows 大小写别名、目录子路径）。它是后续 reservation 事务与越域校验的公共判定基座。

**做什么（scope in）**
1. 规范化：拒绝绝对路径、..、空路径、.git、符号链接越界；输出仓库相对规范路径。
2. 两种明确类型：文件（精确）与目录（路径段边界）；不接受任意 glob。
3. 相交判定：路径集合相交（含目录子路径、重命名旧路径+新路径）；大小写按仓库配置归一。
4. 判据可被 team-hub（SQLite 侧事务筛选）与 plugins（pre-execute/越域）共用（具体包形态 researcher 定，避免两份判定漂移）。

**明确不做什么（scope out）**
- 🚫 不做任意 glob、符号链接解析、代码区域/符号级匹配。
- 🚫 不做「事后以实际已改到这里为由自动扩大范围」。
- 🚫 不改现有 fileDomain 的「许可上界」语义。

**验收口径（可测语句）**
- AC-R1-1 边界：src/a 与 src/ab 判定**不相交**；src/a（目录）与 src/a/b.mjs 判定相交（目录段边界正确）。
- AC-R1-2 拒绝面：绝对路径、含 ..、空串、.git、越界符号链接输入 → 明确拒绝（返回错误而非静默通过），有单元用例逐条断言。
- AC-R1-3 大小写：配置为大小写不敏感时 Src/A.mjs 与 src/a.mjs 判定相交；配置敏感时不相交（Windows 别名场景）。
- AC-R1-4 重命名：一次重命名同时占用旧路径与新路径，任一与其他任务相交即判冲突。
- AC-R1-5 纯函数：同输入同输出、无文件系统/网络/时钟依赖（测试可重复、可并发）。
- AC-R1-6 复用一致：reservation 事务与越域校验使用同一判定函数（或同一份判定结果），不存在两套规则（可由代码引用/单测断言反证）。

### R-2（P0）team-hub 写入意图与写入预约事务（设计 §4、§5.1 步骤 2、§9、§12 切片 2）

**背景**：设计要「team-hub SQLite 是唯一调度事实源」，且 **claim 事务同时授予 Attempt lease 与首次写入预约**，任何一步失败整体回滚，不允许「已认领但没有写入资格」。现状 claim（team-hub/run-store.mjs:1421-1468）只有任务队列与 epoch，没有文件维度；5 张新表零实现（§2.2）。

**目标**：在 team-hub 落地 task_write_intents 与 write_reservations 的存储与事务：规划期可登记 intent（attempt_id 可空），claim 后绑定 Attempt；同一 BEGIN IMMEDIATE 内完成「选候选 → 读活跃 reservation → 判路径交集 → 建 Attempt → 写预约 → 递增 lease epoch」；提供冲突查询、扩域、释放与恢复。

**做什么（scope in）**
1. 表与不变量：task_write_intents（revision CAS，变更另记只追加事件）、write_reservations（活跃预约不得在同仓库覆盖相交路径；释放须核对 Attempt 与 epoch）。
2. 事务：路径相交与预约写入在同一事务内完成；并发只有一个赢家。
3. 冲突响应：结构化 FILE_CONTENTION + 冲突路径 + 持有任务。
4. 扩域：动态扩域必须重走预约事务；成功提升 intent revision，失败暂停且保留产物。
5. 释放与恢复：取消/重试/租约过期先冻结旧 epoch；未确认结束则进 reconciling，迟到写入/结果上报被拒（epoch fencing）。

**明确不做什么（scope out）**
- 🚫 不做跨主机/跨进程文件锁（OS 锁、文件锁）；权威只在 SQLite 事务。
- 🚫 不把 tasks.fileDomain 与运行时 intent 合并成一列。
- 🚫 不扩 run_attempts.state；不修改 attempt 状态机语义。

**验收口径（可测语句）**
- AC-R2-1 原子性：两个独立进程/连接同时申请同一文件的写入资格 → **恰好一个** reservation 活跃，另一个得到 FILE_CONTENTION（含冲突路径与持有任务）。
- AC-R2-2 可并行：两个任务申请不相交文件 → 同时获得资格。
- AC-R2-3 无半状态：claim 事务任一步失败时，Attempt 与 reservation 都不落（不出现「已认领无资格」或「有预约无 Attempt」）。
- AC-R2-4 epoch：用过期 epoch 调释放/上报 → 被拒，且错误信息包含**当前真实 epoch**（可据以判断自身已过期）。
- AC-R2-5 恢复：模拟租约过期但进程未确认退出 → reservation = reconciling（非立即释放）；确认结束后可正常释放。
- AC-R2-6 扩展：扩域撞上其他活跃预约 → 失败并暂停该写入步骤，现有 worktree 产物不丢；扩域成功则 intent revision 提升。
- AC-R2-7 数据一致：活跃 reservation 的相同仓库相交路径集合两两不相交（可用查询/断言扫描全库证明）。
- AC-R2-8 迁移：新表迁移可重复执行、可从旧库启动；升级前备份（tester/devops 以临时库验证）。

### R-3（P0）Orchestrator：写入资格申请、等待语义与运行中扩域（设计 §5、§9、§12 切片 3）

**背景**：现状派工不含写入资格；claim 只看任务队列；没有 pre-execute 路径/epoch/intent 校验，也没有扩域接口。设计要求的「等待不烧重试、队列不被单个冲突任务堵死、只读任务不受限、取得资格后基于最新目标 HEAD 重读」全无。

**目标**：把 R-2 的事务与 R-1 的判定接到执行面：claim 候选扫描跳过被占用者并继续看后续候选（有上限与稳定排序）；等待任务保持 todo + schedulingState=waiting-file 且不计失败；成功后在 RunRequest 携带**模型不可改**的授权快照；运行中写工具做 pre-execute 校验；扩域走 R-2 事务；超范围的实际 diff 不得进入验收/集成。

**做什么（scope in）**
1. claim 候选选择：文件被占用的候选暂时跳过，继续检查队列后续无冲突任务；扫描有上限与稳定排序（避免长队列拖慢事务/高优先级永久饥饿）。
2. 等待语义：tasks.status 保留 todo，另设 schedulingState=waiting-file 与阻塞者信息；不进入失败/重试通道。
3. 授权快照：RunRequest 携带 attempt/epoch/intent revision/worktree 身份，模型不可修改；worker 写前核对。
4. 只读与先读后写：只读任务不申请预约；先读后写者先只读执行，再以当前 epoch 原子申请；等待期间暂停写工具。
5. 获得资格后重读目标 HEAD：与只读探索时不同则更新上下文并重新核对修改计划。
6. 运行中扩域：Agent 提扩域申请 → R-2 事务判定 → 成功更新授权、失败暂停且保留产物。
7. 实际 diff 复核：超范围改动不得进入验收/集成，保留现场并要求调整范围或撤销。
8. 等待结束后工作区从**最新目标提交**创建；重试任务已有未交付 WIP 时先纳入最新目标版本并验证，不重置 WIP。

**明确不做什么（scope out）**
- 🚫 不做「等待即失败/自动重试」；等待不消耗重试额度。
- 🚫 不允许 Agent 用一句提示词替代声明范围。
- 🚫 事后 diff 不作为实时文件锁的替代（两者都要）。
- 🚫 旧版不支持该协议的 worker 不得认领已启用治理的仓库（设计 §5.1 步骤 4；实现形态 downstream 定）。

**验收口径（可测语句）**
- AC-R3-1 等待状态：文件被占用时任务 status=todo、schedulingState=waiting-file，含阻塞任务与路径；重试计数不增加（断言 + 可观测字段）。
- AC-R3-2 不队头阻塞：队列前面是冲突任务、后面有不相交任务时，后面的任务能先被领取（构造队列断言）。
- AC-R3-3 提交不带未授权范围：pre-execute 校验失败（路径/epoch/revision/工作区不符）时写工具被拒，且给出可行动原因。
- AC-R3-4 先读后写：只读阶段零预约；写阶段申请失败时暂停写、不失败整个任务。
- AC-R3-5 HEAD 变化：取得资格后目标 HEAD 已变 → 重新核对计划（有可观测证据，如上下文刷新/计划重核）。
- AC-R3-6 扩域：扩域撞车暂停且产物保留（与 AC-R2-6 同场景，执行面断言）；扩域成功后写工具恢复。
- AC-R3-7 WIP 保留：等待结束的工作区基于最新目标提交，且既有未交付 WIP 不丢（diff 内容仍在，纳入最新版本并验证）。
- AC-R3-8 只读并行：只读任务在任意时间可与写入任务并行，不申请预约、不被等待列表阻塞。

### R-4（P0）交付子状态与单仓库集成 worker（设计 §3.2、§6、§9、§12 切片 4）

**背景**：现状 autoPromote（plugins/src/index.ts:1470-1490）主工作区直接 merge，成功即被当完成；没有交付子状态、没有 integration job、没有 journal、**合并成功后不跑任何验证**。设计明确「Git 自动合并成功不等于交付成立」。

**目标**：新增 task_deliveries、integration_jobs、integration_events 与唯一 integration worker：入队条件齐全 → state=ready（仍占用写入范围）；集成分步为「认领 job（带 epoch）→ 检查目标工作区干净 → 临时隔离集成工作区生成候选合并 → 在候选上跑任务验证 + 仓库规定回归 → 复核 expected_head 未前进 → 仅快进接到目标分支 → 记录 integrated_commit 并释放预约」；Git 与 SQLite 非原子，用 journal + SHA 对账恢复。

**做什么（scope in）**
1. 入队条件：任务分支有稳定 source_commit、未提交改动已显式保全、最终 diff 过文件域检查、运行验收证据齐备、原人审岗位已批准 → ready。
2. 交付状态机与版本 CAS；needs-review 可由裁决回 ready 或进 abandoned；integrated/abandoned 终态，重做产生新 Attempt + 新 delivery。
3. 集成 job 唯一性：同仓库同目标 ref 同时至多一个受管 Git 集成操作；不同守护进程/公共调解员走同一入口（进程内 Set 仅减少重复请求）。
4. 干净前置：目标工作区有未提交/未跟踪改动、处于其他 merge/rebase、仓库身份不符 → 暂停并给可操作原因；不自动 stash。
5. 候选与验证：临时隔离集成工作区从 expected_head 生成候选（保留任务分支与原提交）；验证命令来自仓库已登记清单，含命令/退出码/耗时/候选 SHA/验收版本；失败不改目标分支。
6. 仅快进应用：在仓库级受管互斥区内对干净的绑定工作区执行仅允许快进的集成；候选以 expected_head 为第一父提交。
7. journal 与恢复：prepared → applying → ref-updated → finalized；崩溃后读 Git 目标 ref/源提交可达性/journal 判「未应用／已应用未记账／结果不明」，已应用未记账只补记不重跑 merge，结果不明暂停并请求核查、不自动删分支。
8. 清理：集成完成前不删源 worktree/分支；清理是可重试后续动作，失败不回滚已交付事实。

**明确不做什么（scope out）**
- 🚫 不假装 Git 与 SQLite 是单一原子事务；不做「必须一次成功」的合入。
- 🚫 不在用户工作区重跑冲突调解；不自动删除用户改动/分支。
- 🚫 不跳过验证标已交付；未配置仓库验证命令时停在 needs-review（D-4 确认登记面）。
- 🚫 不在候选过期后复用绿色验证结果。

**验收口径（可测语句）**
- AC-R4-1 干净合入：无冲突且验证通过 → 目标 ref 前进到包含任务 source commit 的候选，task_deliveries=integrated、记录 integrated_commit、释放预约（断言目标提交包含源提交）。
- AC-R4-2 集成后验证失败：Git 无冲突但候选上验证失败 → **目标 ref SHA 不变**，任务不进入 done，保存候选与报告，界面呈现「集成验证失败」（设计 §11.1 场景 5）。
- AC-R4-3 集成中 HEAD 前进：候选与验证作废，按新 HEAD 重算重验；限定自动重算次数，超限进待裁决（有计数上限断言）。
- AC-R4-4 崩溃恢复（三时点）：集成前 / 更新 ref 后落库前 / 落库后分别杀死 worker → 恢复后**每个 source commit 最多集成一次**，不丢产物、不重复推进任务（设计 §11.1 场景 6）。
- AC-R4-5 工作区脏：绑定工作区存在未提交改动 → 集成暂停并点名仓库与路径，这些字节前后**完全不变**（设计 §11.1 场景 7）。
- AC-R4-6 仓库身份/目标 ref：服务端从数据库解析仓库目录与目标 ref；浏览器传入绝对路径/任意 ref/shell 字符串被拒（设计 §8）。
- AC-R4-7 入队门禁：未满足入队条件（diff 越域/验收证据缺失/人审未批）不得进入 ready（逐条负例）。
- AC-R4-8 唯一集成入口：同仓库同时只有一个受管集成操作在跑（多 worker/多进程构造断言）。

### R-5（P1）Workbench：交付徽标、等待说明与冲突裁决（设计 §3.1、§7、§8、§12 切片 5）

**背景**：设计要「用户不需要知道 worktree、Git 冲突标记或手工合并命令」就能看清：任务为什么等待、谁占用文件、哪项成果已进入主版本、冲突需要自己决定什么。现状只有基于补丁的重叠分组（TaskDetailModal.tsx:578）；无交付徽标、无实时占用、无裁决面板。

**目标**：任务中心新增交付徽标（只读探索 / 等待文件 / 执行中 / 待验收 / 排队集成 / 集成验证中 / 待裁决 / 已交付）；任务详情新增**当前占用**、预计等待对象、集成目标、最近一次验证结果；「为什么等待」可看冲突路径/持有任务/其状态，并可选：缩小本任务范围 / 让持有任务完成 / 打回重做 / 取消任务；冲突裁决面板按「原任务意图 → 两份改动 → 候选结果 → 验证证据 → 选择」排序；所有操作绑定当前 delivery.version，过期提交 409 并刷新；审计记录谁/何时/依据哪份候选。

**做什么（scope in）**
1. 交付徽标与详情字段（消费 team-hub API 与现有审计 SSE）。
2. 当前占用与等待原因；历史重叠（/api/overlaps）保留但明确不冒充实时占用。
3. 裁决面板与三种选择（采用 A / 采用 B / 要求重新修改），记录裁决人、理由、时间。
4. version CAS：页面携带 delivery.version，过期 → 409 + 刷新，不覆盖他人裁决。
5. 权限：范围修改、放弃交付、冲突裁决、手工集成分别授权并审计（沿用 F-02）。

**明确不做什么（scope out）**
- 🚫 不提供「强制同时写同一文件」按钮/开关。
- 🚫 不要求用户输入/执行任何 git 命令。
- 🚫 不把历史 patch 重叠当作实时占用展示。

**验收口径（可测语句）**
- AC-R5-1 徽标：任务卡/详情按交付子状态显示对应徽标，且「Agent 写完」不显示为「已交付」（状态映射断言）。
- AC-R5-2 等待可视化：点「为什么等待」→ 显示冲突路径、持有任务及其状态、可选四个动作（浏览器驱动冒烟）。
- AC-R5-3 裁决面板：依次展示原任务意图/两份改动/候选结果/验证证据/选择；提交 A 或 B 或「要求重新修改」→ 记录决策人与理由（数据面断言 + audit）。
- AC-R5-4 并发裁决：两个页面基于同一旧 delivery.version 提交，后者得 409 且其内容不落库；刷新后能看到已生效的裁决。
- AC-R5-5 不越权：非授权岗位不能修改范围/裁决/手工集成（权限负例）。
- AC-R5-6 降级可读：指标/占用读不到时显示「暂无读数及原因」，不显示为零（设计 §11）。

### R-6（P1）legacy 调解迁移、done 语义收口与灰度（设计 §3.2、§10、§12 切片 6）

**背景**：现状存在两条交付路径——autoPromote 直合（plugins:1470）与 mediation.ts 调解提交；进程内 mediating Set（index.ts:523）不能充当跨进程仓库锁。设计要求收敛为唯一 integration worker，并改 done 的产生条件；历史 done 不得倒推为已验证集成。

**目标**：autoPromote 与公共 mediation 接到唯一 integration worker；同仓库不得同时运行旧直合与新队列；done 仅在交付子状态 integrated 且任务原有验收条件通过后产生；历史任务 done 迁移显示 legacy-unknown；按「观察 → 调度 → 集成 → 收口」分阶段灰度，开关按仓库/空间配置且同仓库共享一个模式；回滚只关闭新任务的自动认领与集成，不删数据库记录/预约/分支/临时工作区，在制 job 对账后再切旧路径。

**做什么（scope in）**
1. 单集成入口：旧直合与调解改为经 integration worker；同一仓库模式互斥（不得新旧并行）。
2. done 语义：仅 integrated + 原验收通过；needs-review 不产生 done。
3. 历史不倒推：迁移时 legacy-unknown。
4. 灰度四阶段与仓库/空间开关；观察阶段只计算预计范围/真实 diff/潜在等待/集成验证结果、不改派工，并区分「模拟判断」。
5. 回滚安全：只关新任务自动认领与集成；在制 job 对账后切换；迁移可重复、可从旧库启动、升级前备份。

**明确不做什么（scope out）**
- 🚫 不一次性强推全空间启用（默认按迁移阶段/开关）。
- 🚫 回滚不删记录/预约/分支/临时工作区。
- 🚫 不给历史 done 补造集成证据。

**验收口径（可测语句）**
- AC-R6-1 唯一入口：启用集成阶段后，同仓库不存在第二条直接 merge 路径（构造旧路径调用被拒/不生效的断言）。
- AC-R6-2 done 条件：交付非 integrated 或原验收未通过时，任务不得进入 done（负例逐条）；integrated + 验收通过才 done。
- AC-R6-3 legacy：迁移后历史 done 任务显示 legacy-unknown，不被标记为已验证集成。
- AC-R6-4 观察模式不改派工：观察阶段开启时不改变任务领取/合入行为（行为断言 + 「模拟判断」标记存在）。
- AC-R6-5 开关互斥：同仓库两空间选择不同模式时，不会同时运行两个集成器（配置层拒绝或收敛为仓库级单一模式）。
- AC-R6-6 回滚：关闭新路径后旧路径恢复，且记录/预约/分支/临时工作区未被删除；在制 job 有对账步骤。

### R-7（P1）非 Git / 不可规范化降级与只读并行（设计 §1、§9）

**背景**：设计明确「非 Git、Git 不可用或路径不能规范化 → 禁止并行写入；清晰提示降级原因，不默默退回共享目录并行写」；只读任务不受此限制。现状无该降级判定。

**目标**：非 Git/不可规范化仓库只允许一个写入任务；只读任务始终并行；降级原因对用户可读。

**做什么（scope in）**
1. 判定与限制：非 Git / Git 不可用 / 路径不能规范化 → 单写入。
2. 清晰降级提示（不静默退回共享目录并行写）。
3. 只读任务不受限。

**明确不做什么（scope out）**
- 🚫 首版不做非 Git 的版本快照/回滚机制（设计 §1）。

**验收口径（可测语句）**
- AC-R7-1 非 Git 单写：非 Git 工作区第二个写入任务被拒/等待，理由可读（含降级原因）。
- AC-R7-2 只读不受限：只读任务在非 Git 工作区仍可与唯一写入任务并行（负例：不被拒）。
- AC-R7-3 不静默：不出现「无提示地在共享目录并行写」的路径（断言降级提示存在）。

### R-8（P2）度量与可观测（设计 §11）

**背景**：设计要求按仓库与版本记录 7 项指标，并规定「指标不可读时显示暂无读数及原因，不展示为零」。

**目标**：采集并展示：同文件写入阻止次数、等待时长 P50/P95、集成冲突率、集成后验证失败率、人工裁决率、集成恢复成功率、误阻塞申诉数。

**做什么（scope in）**
1. 采集与展示（按仓库/版本）。
2. 不可读时显式「暂无读数及原因」，不显示 0。

**明确不做什么（scope out）**
- 🚫 不做外部遥测/联网上报（仓库禁联网纪律）。
- 🚫 首版不把指标设为硬发布门槛（D-9 确认）。

**验收口径（可测语句）**
- AC-R8-1 指标可得：7 项指标在发生对应事件后可读出且口径与事件一致（抽样断言）。
- AC-R8-2 不可读口径：人为使某指标不可读 → 展示「暂无读数及原因」而非 0（断言）。
- AC-R8-3 汇总口径：等待时长 P50/P95 有明确样本窗口与计算说明（可复算）。

### R-9（P2）受影响的仓库文档同步（LEGION.md 代码纪律）

**背景**：LEGION.md 要求「修改行为的同时更新受影响文档」；本设计改变执行/集成/done 语义与守护行为，README/FEATURES/docs 族必然过时。

**目标**：实现落地后同步更新受影响文档：任务生命周期与 done 语义、等待/集成/裁决的用法与排障、灰度与回滚操作。

**做什么（scope in）**
1. 更新与交付治理相关的产品/运维文档（具体清单 breaker/devops 定，例如 README、docs/FEATURES.md、docs/ORCHESTRATION-V3.md、docs/SPACE-DAEMON-RUNBOOK.md、docs/DEPLOY.md）。
2. 既有文档门禁（node scripts/ci/check-docs.mjs）不回归。

**明确不做什么（scope out）**
- 🚫 不在实现定型前提前承诺具体交互细节。
- 🚫 不新造与本设计无关的文档体系。

**验收口径（可测语句）**
- AC-R9-1 文档一致：文档描述的等待/集成/done 语义与实现一致，无自相矛盾（人工核对 + 关键句文本断言）。
- AC-R9-2 门禁：node scripts/ci/check-docs.mjs exit 0（本 worktree 当前实测 PASS，§11.2）。

## 6. 端到端验收总口径（设计 §11.1 九个必过场景 + 发布门槛，供将军快速验收）

> 以下为**验收主口径**，test-designer 可直转用例；每条都要求真实命令/隔离实例，不得用「应该没问题」结论替代。

1. **同文件互斥、异文件并行**（场景 1 / AC-R2-1/2）：两个独立进程同时申请同一文件，只产生一个活跃写入者；不同文件可同时执行。
2. **路径判准**（场景 2 / AC-R1-1~4）：src/a 与 src/ab 不误判；Windows 大小写别名、目录子路径、重命名两端正确判重。
3. **动态扩域撞车**（场景 3 / AC-R2-6、AC-R3-6）：已认领任务扩域撞上其他任务 → 写入暂停且现有 worktree 产物不丢。
4. **同文件串行交付**（场景 4 / AC-R3-7、AC-R4-1）：两任务在不同 worktree 改同一文件，后者等待前者交付后基于新目标版本继续；最终两个任务要求都经验证。
5. **集成后验证失败**（场景 5 / AC-R4-2）：Git 无冲突但集成后测试失败 → 目标分支保持原 SHA，任务不进入 done。
6. **崩溃恢复**（场景 6 / AC-R4-4）：集成前、更新 ref 后、落库前分别杀死 worker；恢复后每个 source commit 最多集成一次，不丢产物、不重复推进。
7. **本地脏工作区**（场景 7 / AC-R4-5、§3.1）：用户主工作区有未提交改动时自动集成暂停，且这些字节不变。
8. **人审打回**（场景 8 / R-5、R-6）：人审岗位打回后目标分支不含其未批准改动；再次提交沿用原任务反馈与隔离成果。
9. **多空间同仓库/多 worker**（场景 9 / AC-R2-7、AC-R4-8、AC-R6-5）：多空间绑定同一仓库、多 worker 同时运行时，预约与集成仍遵守同一仓库权威。
10. **发布门槛**（§11.2）：上述场景全通过；灰度期间**无任务产物丢失、无未经授权覆盖用户工作区、无任务被错误标为已交付**。
11. **默认决策不做放宽**（§12）：不存在「同文件强制并行写入」入口；每受管仓库必须配置 ≥1 可执行集成验证，未配置停在 needs-review（AC-R4-7、D-4/D-9）。

## 7. 风险与依赖假设

### 7.1 风险清单

| # | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| RK-1 | Git 与 SQLite 不能组成单一原子事务 | 集成中崩溃会留下「已应用未记账」或「结果不明」 | R-4 journal + SHA/可达性对账；结果不明暂停不自动删分支（AC-R4-4） |
| RK-2 | done 语义变更是高爆炸半径改动 | 影响看板、守护流转、目标链推进、历史任务 | R-6 灰度 + 开关 + legacy-unknown；只对交付型任务生效（D-2）；AC-R6-2/3 |
| RK-3 | 仓库级验证命令登记面不存在 | 设计 §6.2 步骤 4 依赖「已登记命令列表」，现状零实现（§2.2） | D-4 显式裁决来源；无登记则停 needs-review，不跳过验证 |
| RK-4 | 数据库迁移与回滚 | 新 5 张表/字段、历史 done 迁移 | 迁移可重复、可从旧库启动、升级前备份；回滚不删数据（AC-R6-6） |
| RK-5 | 跨进程并发正确性难验证 | 多守护/多空间同仓库 | R-2 事务 + epoch fencing；AC-R2-1/7、AC-R4-8、场景 9 |
| RK-6 | Windows 路径/大小写与 symlink 越界 | 现有越域用字符串前缀，语义不足 | R-1 纯函数 + 配置化大小写；AC-R1-1~4 |
| RK-7 | 设计体量与单链容量不匹配 | 6 切片跨 4 个面，单 coder/reviewer/tester | D-1 显式范围裁决；P0 先行；breaker 按文件域切片并显式串行 |
| RK-8 | 在生产库/仓库做失败注入会污染真实数据 | 崩溃/脏工作区场景需要写入型注入 | 全部验证用隔离实例/临时库/临时仓库；live 只读（§4.2） |
| RK-9 | 自举：治理先于其实现落地会阻塞本仓任务 | 本仓正是 Legion 自身，T-166 链自身在 w/T-166 写文件 | D-2/D-3 默认「不追溯、观察优先、开关按仓库」；实现期间默认不启用强制 |
| RK-10 | 与并行任务/其他目标冲突 | 本目标链写 team-hub/plugins/workbench 大文件，仓库自身也在被治理 | breaker 按文件域划界并排先后；沿用 gate/调解闭环 |
| RK-11 | 等待者基于过期主版本先行写同一区域 | 设计要求交付完成前持续占用 | R-2/R-4 占用持续到 integrated/abandoned；AC-R2-7 |

### 7.2 依赖与假设（✅ 明示为假设，非结论）

- A-1 **设计文档是需求基线**：docs/superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md §3~§11 的产品规则与 §11.1 九场景为本目标验收依据；技术形态留给下游（researcher 选型）。
- A-2 **设计文档状态为「待评审」**：本文默认照实现推进；§8 D-1~D-10 未裁决时按各条「倾向/默认值」执行，默认值是假设。
- A-3 现有资产保留并复用，不另造工作区/调度系统：worktree 隔离（plugins/src/workspace.ts、orchestrator/workspace/index.mjs）、fileDomain（server.mjs:1693-1705、plugins:1286-1304）、/api/overlaps（team-views.mjs:126）、autoPromote（plugins:1470）、mediation.ts、run-store claim/epoch（run-store.mjs:1421+）。
- A-4 team-hub SQLite 是唯一调度事实源；仓库身份按 Git common-dir 实路径；首版一仓库一交付目标 ref（设计 §4）。
- A-5 首版两条产品默认决策成立且实现不得自行放宽：不提供同文件强制并行写入；每受管仓库必须配置 ≥1 可执行集成验证，未配置停 needs-review（设计 §12）。
- A-6 运行前提：受管仓库绑定 Git 且有可检出的目标分支；Node 版本与既有测试/CI 约定（node --test、scripts/ci/run-ci.mjs）沿用；**零新增外部依赖**。
- A-7 后续阶段纪律：不 push、不联网、改动只落 worktree；验证用真实命令（typecheck/build/test/run-ci 至少其一）；逐条对应验收标准。
- A-8 本文写入 docs/G-mujfc9vi-1/REQUIREMENTS.md；不读写仓库根 docs/ 或其他目标目录的同名阶段文档。

## 8. 待将军裁决与遗留问题（⚖️ / ❓ 汇总）

> 每条附**倾向与默认值**。默认值已作为需求基线写入 §5/§6；将军不同意的条目请在验收评论逐条答复，守护会把答复带给后续阶段修订。默认推进不阻塞。

| # | 归属 | 问题 | 倾向 / 默认值（默认按此推进） |
| --- | --- | --- | --- |
| D-1 | 全局 | 「按设计文档完成开发」的范围：一次交付设计全部 6 切片 + 度量，还是先交付首个可验证增量？ | **按 §12 顺序全量推进、P0 先行**（R-1~R-4 必须本次完成；R-5/R-6/R-8 若容量不足可拆后续目标）。若要更小增量请指定切片边界 |
| D-2 | R-6 | 新 done 语义是否只对「写受管仓库代码的交付型任务」生效，而纯文档/看板阶段任务（含本目标链各阶段）沿用现有 promote 行为？ | **仅交付型任务改 done**；非代码阶段任务不追溯、不改口径，避免卡死本目标自身 |
| D-3 | R-6/R-7 | 自举默认模式：实现期间是否默认关闭强制（观察模式），按仓库/空间再灰度开启？ | **默认观察模式**（只计算与展示，不改派工/合入）；新治理按仓库配置开启，本仓实现期间不启用强制 |
| D-4 | R-4/R-6 | 仓库级「已登记验证命令」来源：设计未给现有载体（现状零实现，§2.2），首版从哪来、由谁维护？ | **新增仓库级验证命令登记面**（由将军/仓库配置维护）；无登记 → 停 needs-review，禁止跳过验证；具体形态给 researcher |
| D-5 | R-1/R-3 | 「规划器给出预计修改范围」的产出方：复用现有拆解产出的 tasks.fileDomain，还是新增规划步骤？ | **复用现有 fileDomain 作为预计范围**（必要时扩展为 intent），不新增独立规划器 |
| D-6 | R-5 | Workbench 首版深度：必须交付完整「等待说明 + 当前占用 + 裁决面板」，还是允许先只读展示、裁决走 API/评论？ | **完整交付**（R-5/P1）；容量紧张时可先只读展示并显式标注未完成项 |
| D-7 | R-2 | 多空间绑定同一仓库时，是否确认「共用同一集成锁与路径占用池、仓库身份按 git common-dir」？ | **确认**（设计 §4/§9 口径），不按空间分池 |
| D-8 | R-2/R-4 | 新增 5 张表与只追加事件的保留/清理策略？ | **审计事件长期保留；intent/reservation 终态后保留最小历史**（researcher 定并文档化）；不静默删除 |
| D-9 | R-8 | 度量是否作为发布硬门槛？ | **先采集不设硬门槛**；灰度数据积累后再由将军决定启用 |
| D-10 | R-4/R-6 | 冲突裁决首版默认：同文件冲突默认要求用户审查（不自动接受 AI 候选），可否按仓库策略放宽？ | **默认要求用户审查**；「是否自动接受由仓库策略决定」留作可配置项，但首版默认关闭自动接受 |
| O-1 | 全局 | 设计文档标注「待评审」：将军是否认可其全部内容与两条首版默认决策（A-5）？是否有要修改的条目？ | 若有修改请指明设计节号；未答复按「照设计实现」推进 |
| O-2 | §6 | 验收是否以设计 §11.1 九场景为唯一主口径？是否要求真实多进程/多守护灰度（场景 9），还是允许隔离实例模拟？ | **以九场景为主口径**；优先隔离实例模拟，真实多进程灰度按环境可行性由 tester 说明 |
| O-3 | R-8 | 7 项指标的展示面（看板/详情/独立页）与样本窗口有无期望？ | 默认随任务/仓库详情展示，窗口口径由 researcher 定并文档化 |

## 9. 关键澄清结论（给将军的速览）

1. **目标定性 = 把一份完整设计文档落地**，不是一句功能诉求：核心是「**开工前占位（预防）+ 执行时隔离与监测 + 完成后串行集成并在集成后代验证**」三段式，最终验收以设计 §11.1 九场景 + 发布门槛为准（§6）。
2. **需求拆解为 9 条**：R-1 路径判定纯函数、R-2 intent+reservation 事务、R-3 Orchestrator 资格/等待/扩域、R-4 交付子状态与集成 worker（P0）；R-5 Workbench、R-6 legacy 迁移与 done 收口、R-7 非 Git 降级（P1）；R-8 度量、R-9 文档同步（P2）——与设计 §12 六切片一一对应（§5）。
3. **现状已复核**：worktree 隔离、fileDomain 越域检查、/api/overlaps 事后重叠、autoPromote 直合、mediation.ts 调解、run-store claim+epoch 均真实存在（§2.1）；但 5 张新表与治理概念**零实现**，且**集成后验证完全缺失**、**仓库级验证命令登记面不存在**（§2.2）——这是本目标真正的增量与依赖缺口。
4. **最硬的两处缺口**：①「Git 合并成功 ≠ 交付成立」——现状合并成功后不跑任何验证（R-4）；②「done 语义」——现状由流水线直接产生，新口径要求 integrated + 原验收通过（R-6，高爆炸半径，需灰度，D-2/D-3）。
5. **设计边界（不应被实现放宽）**：不做行级协同编辑、不自动理解语义冲突、不做跨主机锁、不自动 stash、**不提供同文件强制并行写**、首版一仓库一目标 ref、不跳过验证标已交付（§4.2、A-5）。
6. **自举风险已显式化**：本仓正是 Legion 自身，治理先落地会阻塞正在实现它的任务——默认「观察优先 + 按仓库开关 + 不追溯历史 + 仅交付型任务改 done」（D-2/D-3、RK-9）。
7. **给下游的自由度**：表结构细节、事务与模块形态、集成 worker 归属、验证命令登记形态、UI 组件、指标采集方式——均留给 researcher/breaker/coder；本文钉行为与可测验收。

## 10. 下游衔接说明（供 breaker / test-designer / coder 直接使用）

1. **需求 → 切片文件域建议**（breaker 据此给互不重叠或显式串行的文件域）：
   - R-1：新增纯函数模块（候选落点 = team-hub 与 plugins 共用面；researcher 定），+ 单测文件。
   - R-2：team-hub 存储/迁移/路由（服务端 server.mjs、routes 模块、新 store 模块、测试）。
   - R-3：plugins 守护（plugins/src/index.ts 的 claim/派工/pre-execute 段 + workspace 段）+ 相关测试。
   - R-4：team-hub delivery/integration 存储与 job 入口 + 集成 worker（plugins 或独立模块，researcher 定）+ 测试。
   - R-5：workbench 组件（TaskDetailModal/任务卡）+ workbench/src/api.ts。
   - R-6：plugins 的 autoPromote/mediation 收敛段 + team-hub 迁移/开关 + 测试。
   - R-7：team-hub/plugins 降级判定段。
   - R-8：指标采集/展示面。R-9：README/docs 族。
   - ⚠️ 共享文件（plugins/src/index.ts、team-hub/server.mjs、workbench/src/api.ts）与并行目标同改风险高：breaker 须按函数域/段落划界并排先后（§7 RK-10）。
2. **测试面锚定**：事务/并发/崩溃恢复走 team-hub 现有 node --test 临时库范式（run-store.test/acceptance-store.test 同型）；集成 Git 操作走**临时仓库夹具**（不得用本仓真实仓库）；UI 走既有浏览器驱动冒烟范式；指标/文档走零依赖 Node 脚本。
3. **失败注入素材**：场景 6 的三个杀死时点（集成前 / ref-updated 后落库前 / 落库后 finalized 前）直接对应 journal 四阶段；场景 7 的脏工作区字节比对；场景 9 的多进程构造。
4. **与既有文档关系**：本设计是 docs/superpowers/specs/ 下的设计稿；本目标是目标级 REQUIREMENTS.md，与仓库根 docs/REQUIREMENTS.md（他目标/遗留）无承接关系。

## 11. 附录：证据索引与本阶段验收对照

### 11.1 核心证据（file:line / 命令，基于 w/T-166 HEAD a3abf4e）

| 主题 | 证据 |
| --- | --- |
| 设计文档全文（12 节 / §11.1 九场景 / §12 六切片与两条默认决策） | docs/superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md:1-209（成功标准 :14-22、状态分层 :62-74、数据边界 :80-90、调度 :94-107、集成 :111-135、Workbench :137-143、API :145-155、失败恢复 :157-171、迁移 :173-180、验收度量 :182-196、切片与默认决策 :198-209） |
| worktree 隔离与生命周期 | plugins/src/workspace.ts:1-34、:271（prepareWorktree/commitWorktree/workspace 解析）；orchestrator/workspace/index.mjs:19-21、:139-173（worktree 落 DataDir/worktrees，与仓库重叠报错） |
| fileDomain 列与越域校验（字符串前缀判定） | team-hub/server.mjs:1693-1705；plugins/src/index.ts:1286-1304（changedFilesOfBranch/outsideDomainFiles）、:1529-1536（提示词约束段） |
| GET /api/overlaps（事后补丁重叠） | team-hub/routes/team-views.mjs:126-163；workbench/src/api.ts:469；workbench/src/components/TaskDetailModal.tsx:167、:578-583 |
| autoPromote 直合 + abort 保留分支 | plugins/src/index.ts:1470-1490 |
| 合入调解与进程内 mediating Set | plugins/src/mediation.ts（:272 起）；plugins/src/index.ts:523、:2538-2566 |
| claim 事务与 epoch fencing | team-hub/run-store.mjs:1421-1468（withTx + 条件 UPDATE + lease_epoch 递增 + 事件）、:230（BEGIN IMMEDIATE 重读）、:253/:299/:328（lease_epoch 列） |
| 看板状态词表与合法迁移 | team-hub/server.mjs:375-382 |
| 治理概念零实现（负向证据） | 全仓 grep task_write_intents / write_reservations / task_deliveries / integration_jobs / integration_events / schedulingState / deliveryState / FILE_CONTENTION → 仅命中设计文档 |
| 无仓库级验证命令登记（负向证据） | 全仓 grep verifyCommand / verificationCommand / commands_json / registeredCommands → 0 命中；team-hub/acceptance-store.test.mjs（attempt 级 validations，非仓库命令登记） |
| 需求岗验收标准 | team-hub/stage-standards.mjs:31-46（requirement acceptance/do/dont） |
| 文档门禁（本 worktree 实测） | node scripts/ci/check-docs.mjs → exit 0（历史 banner 覆盖完整；docs/+README 共 12400 表行 0 异常；11 类校验全绿，见 §11.2） |
| 仓库文档纪律 | LEGION.md（改行为同步文档；不 push；不联网；验证以真实命令为准） |

### 11.2 本阶段验收对照（stage-standards requirement 四条目 → 本文件位置）

| 验收条目 | 落点 |
| --- | --- |
| 逐条覆盖目标核心诉求：每条需求含 背景 / 目标 / 验收口径 | §1 逐条解读表（设计各节 → R-1~R-9）；§5 每条含 背景/目标/做什么/不做什么/可测 AC-* |
| 明确范围边界：列出「做什么」与「明确不做什么」（不把假设当结论） | §4.1 DO-1~DO-6 + §4.2 逐条 🚫（源出设计显式边界）；§5 每条 scope in/out；§7.2 假设 A-1~A-8 明示为假设 |
| 关键术语无歧义，成功标准可度量、可测试 | §3 术语表（24 项）；§5 AC 均为可测语句；§6 设计九场景 + 发布门槛转写为验收主口径 |
| 输出下游可用需求清单（编号 + 优先级），并列出风险与依赖假设 | §5（P0：R-1~R-4；P1：R-5~R-7；P2：R-8/R-9）；§7 风险 RK-1~11 + 假设 A-1~A-8；§8 待裁决 D-1~D-10 与开放问题 O-1~O-3；§10 下游衔接 |

### 11.3 本阶段实际验证命令与输出要点

- git status --short（w/T-166，a3abf4e）：本阶段仅新增 docs/G-mujfc9vi-1/REQUIREMENTS.md（及已存在的未跟踪 docs/goals/G-mujfc9vi-1.md 镜像），无实现文件改动——符合「不写代码、不改仓库实现」边界。
- node scripts/ci/check-docs.mjs：exit 0（PASS）。
- 参考团队经验：T-095（requirement 岗，唯一改动 docs/REQUIREMENTS.md、以 git status 证明范围）——本阶段沿用其「仅文档 + 真实命令留痕」做法；skill exp-t092（回归复跑先查上游验证）与本任务（新目标首链需求澄清）不适用，未硬套。
