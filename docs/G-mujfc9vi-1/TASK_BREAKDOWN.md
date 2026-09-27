<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-168 HEAD 09b50ce）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 .ci/<run>/summary.json。
<!-- evidence-banner:end -->

# T-168 任务拆解：并行任务文件冲突治理（按设计文档落地）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-168（[auto-goal]｜所属目标 G-mujfc9vi-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-166 需求，R-1~R-9 + AC-R* + D-1~D-10 默认值即基线）→ [RESEARCH.md](./RESEARCH.md)（T-167 方案，方案 A 推荐 + D-P1~D-P9 选型）
> 设计基线：[2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)（自述状态「待评审」；其 §3~§11 产品规则与 §11.1 九场景为验收主口径）
> 下游：守护解析本文件「## slices」小节注册派工；阶段链 T-169 用例设计 → T-170 coder → T-171 review → T-172 test → T-173 devops
> 评估基准：w/T-168 HEAD 09b50ce（本会话实测）。本文 file:line 均指本 worktree 内容；**本阶段只产出本文档，不改任何仓库实现**。

---

## 0. 结论速览（TL;DR）

拆解产物：**8 个切片（S1~S8）**，全部映射设计 §12 的 6 个实施切片与 R-1~R-9，优先级 **P0 先行**：

- **纯函数基座（P0）**：S1 = 路径规范化/文件目录匹配/相交判定（R-1）+ 仓库身份 common-dir 归一与能力探测（R-7/R-4）。
- **team-hub 权威（P0）**：S2 = 写入意图与预约事务 + claim 接线（R-2，含 R-3 服务端候选选择）；S3 = 交付子状态/集成 job store + 单仓库集成 worker + 集成后验证与 journal 恢复（R-4）；S4 = 上述能力的 HTTP 路由接线 + 指标只读端点 + 迁移开关（R-2/R-4/R-8）。
- **守护与用户面（P0/P1）**：S5 = plugins 写入资格/等待/扩域/pre-execute 接线（R-3，P0）；S6 = plugins legacy 收敛（autoPromote/mediation → 唯一集成 worker）与 done 语义/回滚（R-6，P1）；S7 = Workbench 交付徽标/等待说明/冲突裁决（R-5，P1）。
- **收口（P2）**：S8 = CI 注册 + 仓库验证命令声明 .legion/delivery.json + 受影响文档同步（R-9）。

三条硬约束：

1. **零新增第三方依赖**（REQUIREMENTS A-6、RESEARCH §5.1）：只用 Node 内置模块与本机 Git 子命令。
2. **文件域纪律**：除 `plugins/src/index.ts` 由 S5→S6 **硬串行**共享外，**无任何文件出现在两个切片**；该链在 §5 明示并禁止并发派工。
3. **沙箱管道限制（本会话实测）**：Node 以默认管道 stdio spawn 子进程会 `EPERM`（既有 `team-hub/run-concurrency.test.mjs` 在本沙箱 exit 1 即此因，非本次改动回归）。所有涉及 git/子进程的切片必须用非管道 stdio（§8 给出可复制的两种写法）。

范围提示（对齐 REQUIREMENTS D-1 默认值）：本文覆盖设计全 6 切片 + 度量 + 文档；**P0 = S1~S5**。若将军只批首个可验证增量，按 §5 的 blockedBy 交付 S1~S4 即可独立验收，S6~S8 顺延。

---

## 1. 拆解口径与依据

- 上游 REQUIREMENTS §5 的 R-1~R-9 与 AC-R* 是**验收条款**，RESEARCH §6.1 的模块落点是**文件域骨架**；本文只做切分与排序，不改变任何需求语义与方案结论（任务边界「不做：不改变需求语义与方案结论」）。
- 切片粒度 = 一个士兵一轮可独立实现、独立验收的垂直单元（AC 可自动验证）；切片数量 8，落在允许区间 2~12。
- 同一文件的独占原则：设计面 4 处大文件（`team-hub/server.mjs`、`plugins/src/index.ts`、`workbench/src/api.ts`、`scripts/ci/run-ci.mjs`）各自只归一个切片；`team-hub/run-store.mjs` 与 `team-hub/claim-policy.mjs` 归 S2（claim 事务是 R-2 的权威落点）。
- 不写实现、不跑 taskctl、不 push、不联网（LEGION.md 变更纪律）。

---

## 2. 需求 → 切片映射（覆盖性检查）

| 需求 | 优先级 | 承载切片 | 覆盖说明 |
| --- | --- | --- | --- |
| R-1 路径规范化与冲突判定纯函数 | P0 | S1 | 判定基座；S2/S5 的 AC-R1-6 反证单一判定 |
| R-2 intent/reservation 事务 | P0 | S2 + S4 | 事务与表在 S2；HTTP 面在 S4 |
| R-3 Orchestrator 资格/等待/扩域 | P0 | S2（服务端 claim 候选）+ S5（执行面） | 队头阻塞与候选排序属 claim，归 S2；pre-execute/快照/扩域归 S5 |
| R-4 delivery + 集成 worker | P0 | S3 + S4 | store/worker 在 S3；路由与迁移在 S4 |
| R-5 Workbench | P1 | S7 | 徽标、等待说明、裁决面板 |
| R-6 legacy 收敛与 done 语义 | P1 | S6（plugins）+ S3/S4（store/迁移/开关） | 单入口与回滚在 S6；legacy-unknown 与开关列在 S3/S4 |
| R-7 非 Git 降级与只读并行 | P1 | S1（判定）+ S2（单写强制）+ S5/S6（提示） | 能力探测纯函数在 S1，执行面拦截在 S2，用户可读提示在 S5/S6 |
| R-8 度量与可观测 | P2 | S4 | 只读聚合端点 + available/reason 口径 |
| R-9 受影响文档同步 | P2 | S8 | .legion/delivery.json + README/FEATURES/STATUS + CI 注册 |
| 设计 §11.1 九场景 | 验收主口径 | 分布到 S1~S8 | 九场景逐条挂到切片，见 §10 |

> 无遗漏：R-1~R-9 与设计 §12 的 6 个实施切片全部有承载切片；无「无法验收的悬空任务」（每条切片均可跑真实命令）。

---

## slices
- S1 | 共享纯函数基座（R-1 路径判定 + R-7/R-4 仓库身份与能力探测） | packages/shared/src/path-domain.mjs, packages/shared/src/path-domain.d.mts, packages/shared/src/repo-identity.mjs, packages/shared/src/repo-identity.d.mts, packages/shared/test/path-domain.test.mjs, packages/shared/test/repo-identity.test.mjs | node packages/shared/test/path-domain.test.mjs 退出码 0：src/a（目录）与 src/ab（文件）判不相交、src/a（目录）与 src/a/b.mjs 判相交、文件类型精确相等；绝对路径、含 .. 、空串、.git、符号链接越界逐条返回明确拒绝而非静默通过；大小写不敏感配置下 Src/A.mjs 与 src/a.mjs 判相交、敏感配置下判不相交；一次重命名同时占用旧路径与新路径且任一与其他任务相交即判冲突；同输入同输出且无 fs/网络/时钟依赖（源码断言仅 import node:path）；node packages/shared/test/repo-identity.test.mjs 退出码 0：不同 worktree 的 git-dir 归一为同一 common-dir（分隔符与大小写规范化）、非 Git 或 Git 不可用或路径不能规范化时 capability=degraded 且带可读原因、只读任务不受限判定为真、探测事实注入即纯函数；临时仓库实测 git rev-parse --git-common-dir 以文件描述符捕获输出（默认管道 stdio 的 spawn 在本机返回 EPERM，必须用 stdio 数组指向临时文件，见 §8）；零新增第三方依赖
- S2 | team-hub 写入意图与预约事务及 claim 接线（R-2 + R-3 服务端候选选择 + R-7 非 Git 单写） | team-hub/write-intent-store.mjs, team-hub/run-store.mjs, team-hub/claim-policy.mjs, team-hub/claim-policy.test.mjs, team-hub/write-intent-store.test.mjs, team-hub/scripts/claim-probe.mjs, team-hub/scripts/reservation-probe.mjs | node team-hub/write-intent-store.test.mjs 退出码 0：同一进程两个 DatabaseSync 连接在同一临时库上同时申请同一文件时恰好一个 active reservation、另一个得到结构化 FILE_CONTENTION（含冲突路径与持有任务）；申请不相交文件双方均成功；claim 事务任一步失败时 Attempt 与 reservation 都不落（无半状态）；过期 epoch 调释放或上报被拒且错误含当前真实 epoch；租约过期且未确认进程退出时 reservation=reconciling 而非立即释放、确认结束后可释放；扩域撞车失败且 intent revision 不变、成功则 revision+1；全库扫描断言同仓库活跃预约两两不相交；非 Git 仓库第二个写入任务被拒或等待且降级原因可读；新表 CREATE TABLE IF NOT EXISTS 幂等、可从旧库启动、重复迁移无错；node team-hub/claim-policy.test.mjs 退出码 0（基线 35 例不回归）且新增断言：队列前部为冲突任务而后部为不相交任务时后部先被领取（不队头阻塞）、候选扫描有上限且稳定排序；静态断言 write-intent-store 引用 packages/shared/src/path-domain.mjs 并按段边界判定（AC-R1-6 的 store 侧反证）；真子进程探针在沙箱允许时运行，EPERM 时以同进程双连接等价断言替代并在证据中记录（§8）；零新增第三方依赖
- S3 | team-hub 交付与集成（delivery/job store + 单仓库集成 worker + 仓库验证命令登记 + 沙箱安全 git 接缝，R-4） | team-hub/delivery-store.mjs, team-hub/integration-worker.mjs, team-hub/verify-config.mjs, team-hub/git-plumbing.mjs, team-hub/delivery-store.test.mjs, team-hub/integration-worker.test.mjs, team-hub/git-plumbing.test.mjs | node team-hub/delivery-store.test.mjs 退出码 0：入队门禁逐条负例（最终 diff 越域、验收证据缺失、人审未批均不得进入 ready）；version CAS 过期提交被拒；状态机 awaiting-acceptance→ready→preparing→validating→integrated 及 needs-review→abandoned，integrated 与 abandoned 为终态、重做产生新 Attempt 与新 delivery；同仓库同 target ref 同时至多一个活跃 integration job（epoch 租约争用唯一赢家）；integration_events 只追加；legacy-unknown 迁移不倒推历史 done；node team-hub/git-plumbing.test.mjs 退出码 0：临时仓库内以文件描述符捕获 git 输出，merge-tree --write-tree 干净退出 0 与内容冲突退出 1 可区分、commit-tree 首父等于 expected_head、merge-base --is-ancestor 可判已应用；node team-hub/integration-worker.test.mjs 退出码 0（夹具全在系统临时仓库、不触碰本仓真实仓库）：干净合入后目标 ref 前进且包含 source commit、deliveries=integrated、记录 integrated_commit、释放 reservation；Git 无冲突但候选上验证失败时目标 ref SHA 不变且不 integrated；集成中 HEAD 前进时候选与验证作废并按新 HEAD 重算重验、超自动重算上限进 needs-review；journal prepared→applying→ref-updated→finalized 三时点崩溃恢复后每个 source commit 至多集成一次且不丢产物；绑定工作区脏时集成暂停且这些字节前后不变；未配置仓库验证命令时停 needs-review 且不集成；验证报告含命令、退出码、耗时、候选 SHA、验收版本，命令取自登记 argv 数组并拒绝任意 shell 字符串；零新增第三方依赖
- S4 | team-hub HTTP 接线与迁移（write-intent/reservation/contention/delivery/integration/decision 路由 + R-8 指标只读端点 + 开关列与 legacy 迁移） | team-hub/server.mjs, team-hub/routes/write-intent.mjs, team-hub/routes/delivery.mjs, team-hub/routes/metrics.mjs, team-hub/write-intent-routes.test.mjs, team-hub/delivery-routes.test.mjs, team-hub/metrics.test.mjs | node team-hub/write-intent-routes.test.mjs 退出码 0：POST /api/tasks/:id/write-intent（规划期 attempt_id 可空、claim 后绑定、revision CAS）；POST /api/tasks/:id/reservation 冲突时返回结构化 FILE_CONTENTION（含冲突路径与持有任务）且 tasks.status 仍为 todo、schedulingState=waiting-file、重试计数不增；GET /api/repositories/:id/contention 只读；缺 scope 或非法 body 返回 400；服务端从数据库解析仓库目录与 target ref，浏览器传绝对路径、shell 串、任意 Git ref 一律拒绝（逐条负例）；node team-hub/delivery-routes.test.mjs 退出码 0：POST /api/deliveries、POST /api/integration/claim、POST /api/integration/transition、POST /api/deliveries/:id/decision 全通，version CAS 过期返回 409 且不落库，权限负例被拒（沿用 F-02）；node team-hub/metrics.test.mjs 退出码 0：7 项指标在发生对应事件后可读且口径与事件一致、人为不可读时返回 available=false 与原因而非 0、等待时长 P50/P95 有明确样本窗口与可复算说明；node team-hub/chat.test.mjs 与 node team-hub/claim-policy.test.mjs 退出码 0（基线 51 例与 35 例不回归）；新表与开关列迁移幂等（CREATE TABLE IF NOT EXISTS 加 schema-util.ensureColumn）、可从旧库启动、升级前备份步骤可执行；零新增第三方依赖
- S5 | plugins 守护写入资格接线（等待语义 + 不可篡改授权快照 + pre-execute 校验 + 运行中扩域 + 等待后基于最新目标建工作区，R-3 + R-7 提示） | plugins/src/index.ts, plugins/src/writeEligibility.ts, plugins/src/workspace.ts, plugins/tests/write-eligibility.test.mjs, plugins/tests/workspace.test.mjs | node plugins/tests/write-eligibility.test.mjs 退出码 0：文件被占用时任务 status=todo 且 schedulingState=waiting-file、阻塞任务与路径可见、重试计数不增（AC-R3-1）；RunRequest 携带 attempt/epoch/intent revision/worktree 身份且模型不可修改（结构断言）；pre-execute 对路径越界、epoch 过期、revision 不符、工作区不符逐项拒绝写工具并给出可行动原因，且越域实际 diff 不得进入验收或集成；只读任务零预约且不被等待列表阻塞（AC-R3-8）；先读后写时只读阶段零预约、写阶段申请失败只暂停写而不失败任务；取得资格后目标 HEAD 已变则重新核对修改计划（可观测标记）；扩域撞车时暂停写且现有 worktree 产物保留、成功后写工具恢复；非 Git 或 Git 不可用降级提示可读；静态断言 plugins 侧复用 packages/shared/src/path-domain.mjs 且不再用字符串 startsWith 判定越域（AC-R1-6，与 S2 同一函数）；node plugins/tests/workspace.test.mjs 退出码 0（既有用例不回归）且新增断言：等待结束与重试的工作区从最新目标提交创建、既有未交付 WIP 的 diff 内容仍在（不 reset）；plugins typecheck 0 诊断（依赖缺失时如实记录复现步骤与输出）；零新增第三方依赖
- S6 | plugins legacy 收敛（autoPromote 与 mediation 接入唯一 integration worker、同仓库单一模式、done 语义与回滚不删数据，R-6；与 S5 共享 plugins/src/index.ts，硬串行） | plugins/src/index.ts, plugins/src/mediation.ts, plugins/src/legacyConvergence.ts, plugins/tests/legacy-convergence.test.mjs, plugins/tests/mediation.test.mjs | node plugins/tests/legacy-convergence.test.mjs 退出码 0：启用集成阶段后旧直合路径被拒或不生效、autoPromote 与公共 mediation 均经唯一 integration worker 入口（构造旧路径调用断言）；同仓库两空间选择不同模式时不会同时运行两个集成器（配置层拒绝或收敛为仓库级单一模式）；done 仅在交付子状态 integrated 且任务原有验收条件通过后产生（逐条负例：needs-review、集成验证失败、原验收未过）；观察模式不改派工且存在「模拟判断」标记；回滚只关闭新任务自动认领与集成，数据库记录、预约、分支、临时工作区均未被删除且含在制 job 对账步骤；node plugins/tests/mediation.test.mjs 退出码 0（既有调解用例不回归）；plugins typecheck 0 诊断（依赖缺失时如实记录）；零新增第三方依赖
- S7 | Workbench 交付徽标、等待说明与冲突裁决面板（version CAS 409、指标降级显示、不把历史重叠当实时占用，R-5） | workbench/src/api.ts, workbench/src/types.ts, workbench/src/components/TaskDetailModal.tsx, workbench/src/components/TaskCenterView.tsx, workbench/scripts/delivery-ui.test.mjs | pnpm --dir workbench build 全绿（tsc --noEmit 0 诊断加 vite build；workbench/node_modules 缺失时经 run-ci deps junction 兜底，仍不可用则如实记录复现步骤）；node workbench/scripts/delivery-ui.test.mjs 退出码 0：交付子状态到徽标映射逐项断言且「Agent 写完」不得显示为「已交付」、legacy-unknown 如实显示；任务详情展示当前占用、预计等待对象、集成目标与最近一次验证结果，点「为什么等待」显示冲突路径、持有任务及其状态与四个可选动作；裁决面板按「原任务意图→两份改动→候选结果→验证证据→选择」排序，提交采用 A、采用 B、要求重新修改并记录裁决人、理由、时间；两页面基于同一旧 delivery.version 提交时后者收到 409 且内容不落库、刷新后可见已生效裁决；指标或占用不可读时显示「暂无读数及原因」而非 0；历史 patch 重叠不得冒充实时占用（数据面断言）；非授权岗位不能修改范围、裁决、手工集成（权限负例）；无 dangerouslySetInnerHTML 直插服务端文本；workbench 零新增依赖
- S8 | CI 注册、仓库验证命令声明与文档收口（R-9：新增测试全部登记、.legion/delivery.json 权威登记、受影响文档随实现更新） | scripts/ci/run-ci.mjs, .legion/delivery.json, README.md, docs/FEATURES.md, docs/STATUS.md | node scripts/ci/run-ci.mjs 的测试登记校验段（或全量运行）通过：本目标全部新增测试文件已进入 suites（packages/shared/test/path-domain.test.mjs、packages/shared/test/repo-identity.test.mjs、team-hub/write-intent-store.test.mjs、team-hub/delivery-store.test.mjs、team-hub/integration-worker.test.mjs、team-hub/git-plumbing.test.mjs、team-hub/write-intent-routes.test.mjs、team-hub/delivery-routes.test.mjs、team-hub/metrics.test.mjs、plugins/tests/write-eligibility.test.mjs、plugins/tests/legacy-convergence.test.mjs、workbench/scripts/delivery-ui.test.mjs）且无「未登记测试文件」失败；node scripts/ci/check-docs.mjs 退出码 0（基线实测 PASS）；.legion/delivery.json 存在且校验通过：targetRef 为完整 ref、verify 为 argv 数组（拒绝任意 shell 字符串）、每受管仓库至少 1 条可执行验证、未配置时任务停 needs-review 不得标记已交付；README.md 与 docs/FEATURES.md 关键句断言等待、集成、集成后验证、done 语义与实现一致且不含要求用户手工输入 git merge 的指引；改动仅限本切片文件域；零新增第三方依赖

## 4. 依赖关系（blockedBy）与工作量估计

工作量刻度：S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满 ｜ XL ≈ 1.5 轮（需拆分派工）。

| 切片 | blockedBy | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | 纯函数基座，是 S2/S5 判定与 S3 仓库身份的公共前置 | M |
| S2 | S1 | 预约事务用 path-domain 的段边界判定与 repo-identity 的仓库身份 | L |
| S3 | S1, S2 | 集成 worker 依赖 reservation 释放语义与 Attempt/epoch 身份 | L |
| S4 | S2, S3 | 路由只做接线，导入两个 store 的接口；迁移与指标读新表 | L |
| S5 | S2, S4 | 守护经 HTTP 申请写入资格/扩域并读等待原因 | L |
| S6 | S5（同 plugins/src/index.ts 硬串行）+ S3, S4 | autoPromote/mediation 收敛到集成 worker，须先有 job 接口（S3/S4）与 index.ts 前序改动（S5） | L |
| S7 | S4 | UI 消费 team-hub API 与既有审计 SSE | L |
| S8 | S1, S2, S3, S4, S5, S6, S7 | 登记全部新增测试文件；文档须描述实现后真实行为 | M |

**无循环依赖**：依赖沿「纯函数基座 → team-hub 权威 → HTTP 接线 → 守护/UI → 收口」单方向（S1→S2→S3→S4→{S5,S7}→S6→S8），无回边。

---

## 5. 执行顺序与并行关系

### 5.1 注册顺序 = 派工顺序（守护按注册顺序派工）

S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8。注册顺序已按拓扑排好，直接满足全部 blockedBy。

### 5.2 可并行组合（仅当并发槽位 ≥ 2 时）

| 组合 | 是否可并行 | 依据 |
| --- | --- | --- |
| S5 与 S7 | ✅ 可并行（S4 完成后） | 文件域完全不相交：plugins/src/* 对 workbench/src/* 对 workbench/scripts/* |
| S5 与 S6 | 🚫 严禁同时派工 | 二者同持 `plugins/src/index.ts`，为唯一硬串行链（S6 blockedBy S5） |
| S3 与 S7 | 🚫 不建议 | S7 依赖 S4 提供的交付/等待 API，而 S4 依赖 S3 |
| S1 与任何后续切片 | 🚫 不建议 | S1 是所有判定基座，后续切片均引用其导出 |

### 5.3 硬串行说明（必须遵守）

- **唯一共享文件链**：`plugins/src/index.ts` 由 S5（R-3 接线）与 S6（R-6 收敛）先后修改，S5 必须先完成并合入，S6 才可开工。守护按注册顺序派工天然满足；若开启多 worker，请勿同时启动 S5 与 S6。
- 其余切片文件域两两不相交（本会话逐文件核对，见 §0 约束 2）。

---

## 6. 子任务明细（完成 = 什么 / 依赖 / 测试锚点 / 纪律）

> 每切片的**可测口径以「## slices」对应行的第 4 段为准**，以下为给人看的落地要点与测试锚点。

### 6.1 S1 共享纯函数基座【R-1 + R-7/R-4 · 工作量 M】

- **目标**：实现设计 §4 的路径语义（拒绝绝对路径/../空路径/.git/符号链接越界；文件精确、目录按段边界；Windows 大小写可配置；重命名占两端）与仓库身份（`git rev-parse --git-common-dir` 归一 + 能力探测），产出一份 team-hub 与 plugins **共同 import** 的判定（RESEARCH D-P1/D-P2/D-P4）。
- **产出**：`packages/shared/src/path-domain.mjs`（+ 手写 `.d.mts`）、`packages/shared/src/repo-identity.mjs`（+ `.d.mts`）、两个单测。
- **DoD**：`node packages/shared/test/path-domain.test.mjs` 与 `node packages/shared/test/repo-identity.test.mjs` 均 exit 0，且逐条覆盖 AC-R1-1~5；零新增依赖。
- **测试锚点（test-designer 直转）**：src/a 对 src/ab（不相交）与 src/a 对 src/a/b.mjs（相交）、五类拒绝面、大小写两向、重命名两端、纯函数性；common-dir 归一、降级能力、只读不受限。
- **纪律**：纯函数、无 I/O 分支（探测结果注入）；不改 `packages/shared/src/artifact-policy.mjs` 的既有语义，只划清分工（artifact-policy 管文件服务读取，path-domain 管写入预约）。

### 6.2 S2 team-hub 写入意图与预约事务【R-2 + R-3 服务端 · 工作量 L】

- **目标**：落地 `task_write_intents` / `write_reservations` 与 `BEGIN IMMEDIATE` 事务：claim 同时授予 Attempt lease 与首次 reservation，任一步失败整体回滚；路径交集用 S1 纯函数在内存判定（RESEARCH D-P6，不写 SQL 前缀）；提供结构化 FILE_CONTENTION、扩域、释放与 reconciling 恢复；claim 候选扫描跳过被占用者并继续后续候选（有上限与稳定排序）。
- **产出**：`team-hub/write-intent-store.mjs`；`team-hub/run-store.mjs` 与 `team-hub/claim-policy.mjs` 的 claim 接线；`team-hub/write-intent-store.test.mjs`；逐步探针 `team-hub/scripts/claim-probe.mjs`、`team-hub/scripts/reservation-probe.mjs`。
- **DoD**：`node team-hub/write-intent-store.test.mjs` 与 `node team-hub/claim-policy.test.mjs` 均 exit 0（后者基线 35 例不回归 + 不队头阻塞新断言）。
- **测试锚点**：同文件双连接唯一赢家、异文件并行、无半状态、epoch 过期拒绝（错误含真实 epoch）、reconciling、扩域成败、全库两两不相交扫描、非 Git 单写、迁移幂等。
- **纪律**：不做跨主机/文件锁（权威只在 SQLite 事务）；不合并 `tasks.fileDomain` 与运行时 intent；不扩 `run_attempts.state`。

### 6.3 S3 team-hub 交付与集成【R-4 · 工作量 L】

- **目标**：落地 `task_deliveries` / `integration_jobs` / `integration_events` 与唯一 integration worker：入队门禁、交付状态机与版本 CAS、job epoch 租约；按 RESEARCH §6.3 时序用 `merge-tree --write-tree` + `commit-tree`（第一父 = expected_head）生成候选、临时隔离 worktree 跑登记验证、复核 ref 后 `merge --ff-only`；journal 四阶段 + Git SHA 对账恢复。
- **产出**：`team-hub/delivery-store.mjs`、`team-hub/integration-worker.mjs`、`team-hub/verify-config.mjs`、`team-hub/git-plumbing.mjs`（沙箱安全 runGit 接缝）与三个测试。
- **DoD**：三个测试均 exit 0；全夹具在系统临时仓库，不触碰本仓真实仓库与 live 库。
- **测试锚点**：入队负例、版本 CAS、状态机终态、job 唯一、干净合入、集成后验证失败目标 ref 不变、HEAD 前进重算、journal 三时点恢复、脏工作区字节不变、未配置验证停 needs-review。
- **纪律**：不假装 Git+SQLite 原子；不在用户工作区重做调解；不跳过验证标已交付；候选过期不复用绿色结果。

### 6.4 S4 team-hub HTTP 接线与迁移【R-2/R-4/R-6/R-8 · 工作量 L】

- **目标**：按设计 §8 与仓库「一族一模块」风格新增 `routes/write-intent.mjs`、`routes/delivery.mjs`、`routes/metrics.mjs` 并在 `team-hub/server.mjs` 注册；迁移用 `CREATE TABLE IF NOT EXISTS` + `schema-util.ensureColumn`（幂等、可从旧库启动）；服务端解析仓库目录与 target ref，拒绝浏览器传绝对路径/shell/任意 ref；R-8 指标返回 available=true/false+reason（不可读不显示 0）。
- **产出**：`team-hub/server.mjs`、三个 route 模块、三个路由测试。
- **DoD**：三个测试 exit 0；`node team-hub/chat.test.mjs`（基线 51 例）与 `node team-hub/claim-policy.test.mjs`（基线 35 例）不回归。
- **测试锚点**：intent/reservation/contention 正负例、409 version CAS、权限负例、指标 available 口径、迁移幂等。
- **纪律**：不改既有路由语义；只读端点零写入；`team-hub/server.mjs` 只由本切片持有。

### 6.5 S5 plugins 守护写入资格接线【R-3 + R-7 提示 · 工作量 L】

- **目标**：等待不烧重试（tasks.status 保留 todo + schedulingState=waiting-file + 阻塞者信息）；RunRequest 携带模型不可改的授权快照；写工具 pre-execute 校验路径/epoch/revision/工作区；运行中扩域走 S2 事务；等待结束后从最新目标提交建工作区且不重置 WIP；只读任务始终并行。
- **产出**：`plugins/src/writeEligibility.ts`（可单测的判定与快照构造）、`plugins/src/index.ts`（claim/派工/pre-execute 段）、`plugins/src/workspace.ts`（最新目标建/复用工作区）与测试。
- **DoD**：`node plugins/tests/write-eligibility.test.mjs` 与 `node plugins/tests/workspace.test.mjs` exit 0；plugins typecheck 0（依赖缺失如实记录）。
- **测试锚点**：等待状态与不烧重试、授权快照不可模型改、pre-execute 四类拒绝、只读并行、先读后写、HEAD 变化重核、扩域撞车保留产物、WIP 不丢。
- **纪律**：不做「等待即失败/自动重试」；不许提示词替代范围声明；事后 diff 不替代实时锁；AC-R1-6 反证 plugins 复用 S1 判定。

### 6.6 S6 plugins legacy 收敛与非 Git 降级【R-6 · 工作量 L · 硬串行于 S5】

- **目标**：`autoPromote` 与公共 `mediation` 收敛为唯一 integration worker 入口；同仓库模式互斥（不得新旧并行）；done 仅在 integrated 且原验收通过后产生；历史 done 不倒推；回滚只关新任务自动认领与集成、不删数据；非 Git 降级单写 + 可读提示。
- **产出**：`plugins/src/legacyConvergence.ts`、`plugins/src/mediation.ts`、`plugins/src/index.ts`（收敛段）与测试。
- **DoD**：`node plugins/tests/legacy-convergence.test.mjs` 与 `node plugins/tests/mediation.test.mjs` exit 0；plugins typecheck 0。
- **测试锚点**：旧直合被拒、单入口、模式互斥、done 负例、观察模式不改派工、回滚不删数据、非 Git 单写与只读不受限。
- **纪律**：不一次性强推全空间；回滚不删记录/预约/分支/临时工作区；不给历史 done 补造集成证据。

### 6.7 S7 Workbench 交付面与裁决【R-5 · 工作量 L】

- **目标**：交付徽标（只读探索/等待文件/执行中/待验收/排队集成/集成验证中/待裁决/已交付）；详情新增当前占用、预计等待对象、集成目标、最近验证；「为什么等待」四个动作；裁决面板与 version CAS 409；指标不可读显示原因不显示 0。
- **产出**：`workbench/src/api.ts`、`workbench/src/types.ts`、`workbench/src/components/TaskDetailModal.tsx`、`workbench/src/components/TaskCenterView.tsx`、`workbench/scripts/delivery-ui.test.mjs`。
- **DoD**：`pnpm --dir workbench build` 全绿（tsc 0 + vite build）；`node workbench/scripts/delivery-ui.test.mjs` exit 0。
- **测试锚点**：徽标映射（含 legacy-unknown 与「写完≠已交付」）、等待可视化与四动作、裁决顺序与记录、409 不覆盖他人、指标降级、历史重叠不冒充实时占用。
- **纪律**：不提供同文件强制并行入口；不要求用户执行 git 命令；前端零新增依赖。

### 6.8 S8 CI 注册、验证命令声明与文档收口【R-9 · 工作量 M】

- **目标**：把 S1~S7 的新增测试全部登记进 `scripts/ci/run-ci.mjs` 的 suites（否则触发「未登记测试文件」红）；落地仓库内声明文件 `.legion/delivery.json`（targetRef + verify[] 的 argv 数组，禁 shell 串），作为 D-P5 默认登记面；同步 README/FEATURES/STATUS 的等待、集成、集成后验证、done 语义。
- **产出**：`scripts/ci/run-ci.mjs`、`.legion/delivery.json`、`README.md`、`docs/FEATURES.md`、`docs/STATUS.md`。
- **DoD**：登记校验段通过；`node scripts/ci/check-docs.mjs` exit 0。
- **纪律**：不新造文档体系；不改其它目标的阶段文档；`.legion/` 未被 gitignore（`.legion-worktrees/` 才是），可随仓库版本化。

---

## 7. 跨切片共享契约（防止两份判定漂移）

- **path-domain 导出契约（S1 定稿，S2/S5 消费）**：`normalizeRepoPath(raw, opts)`、`classifyEntry`（file/dir）、`pathsIntersect(a, b, opts)`、`expandRename({from,to})`；`opts` 含 `caseInsensitive`（按仓库配置）。**任何切片不得自写第二份 startsWith/前缀判定**（AC-R1-6）。
- **repo-identity 导出契约（S1 定稿，S2/S4 消费）**：`repoIdFromCommonDir(commonDir)`、`detectRepoCapability(facts)` → `{ capability: git 或 degraded, reason, readOnlyAllowed: true, singleWriterRequired }`。
- **write-intent-store 契约（S2 定稿，S4/S5 消费）**：intent 的 `revision` CAS、`FILE_CONTENTION` 结构（`{ code, paths, holderTaskId }`）、reservation 状态的五值词表（unplanned/waiting-file/reserved/reconciling/released）与交付子状态七值词表**互相独立**，不得互相代替（设计 §3.2/§4）。
- **HTTP 契约（S4 定稿，S5/S7 消费）**：设计 §8 的四组接口路径；所有写请求绑定 scope、task、Attempt/lease epoch、revision/version 与操作者；服务端从数据库解析仓库路径与 ref。
- **验证命令登记契约（S3 解析，S8 落地实例）**：`.legion/delivery.json` 形如 `{ targetRef: "refs/heads/main", verify: [{ id, argv: string[], timeoutMs, cwd? }] }`；`argv` 为数组、拒绝任意 shell 字符串；无登记 → 停 needs-review（RESEARCH D-P5，对应 REQUIREMENTS D-4，默认按推荐方案推进）。

---

## 8. 环境约束与验证纪律（本会话实测，下游必须遵守）

### 8.1 沙箱子进程管道限制（已实测）

实测命令与结果：

- `node -e "spawnSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'})"` → `status=null`，`error.code=EPERM`（默认管道 stdio 被沙箱拒绝）。
- `node -e "spawnSync('git',['rev-parse','--short','HEAD'],{stdio:['ignore','inherit','inherit']})"` → `status=0`（非管道 stdio 可用）。
- 文件描述符捕获：`const fd=fs.openSync(out,'w'); spawnSync('git',args,{stdio:['ignore',fd,fd]}); fs.closeSync(fd)` → `status=0` 且 `out` 内容为 `09b50ce`（可复制）。
- 既有 `node team-hub/run-concurrency.test.mjs` → **exit 1（spawn EPERM）**，为沙箱环境限制、与本次改动无关，**不得作为回归基线**。

**强制要求**：S1/S3（以及任何新增 git 调用）必须使用非管道 stdio；跨进程争用用例优先用**同进程两个 DatabaseSync 连接**（REQUIREMENTS AC-R2-1 原文即「进程/连接」），或 spawn 时用 `stdio:'ignore'` + 结果文件，并在证据中记录替代口径。

### 8.2 数据与仓库隔离

测试一律用临时库（沿用 `TEAM_HUB_DB` 等环境变量）与系统临时 Git 仓库；**禁止**对 live 库、本仓真实工作区做写入型验证与失败注入（REQUIREMENTS §4.2、RK-8）。

### 8.3 基线命令（本会话实测，供逐条对照）

| 命令 | 本会话基线 | 用途 |
| --- | --- | --- |
| `node scripts/ci/check-docs.mjs` | exit 0（PASS，12705 表行 0 异常） | S8 文档门禁；本阶段写本文后需复跑 |
| `node packages/shared/test/artifact-policy.test.mjs` | exit 0（3 pass） | S1 新增同族测试的范式 |
| `node team-hub/claim-policy.test.mjs` | exit 0（35 pass） | S2 回归锚点 |
| `node team-hub/chat.test.mjs` | exit 0（51 pass） | S4 回归锚点 |
| `node team-hub/run-concurrency.test.mjs` | exit 1（spawn EPERM，环境限制） | 跨进程范式参考，不作基线 |

> `git rev-parse HEAD` = `09b50ce6887566e742e8c46a63d3b7d9bbdba50b`；`node --version` = v24.19.0。

---

## 9. 风险、边界与不做

| 风险 | 影响切片 | 缓解 |
| --- | --- | --- |
| Git 与 SQLite 非原子（RK-1） | S3 | journal 四阶段 + `merge-base --is-ancestor` 对账；结果不明暂停不删分支 |
| done 语义爆炸半径（RK-2） | S6 | 仅交付型任务改 done、观察模式优先、开关按仓库 |
| 仓库验证命令登记面原为零实现（RK-3/D-4） | S3/S8 | 默认采用 `.legion/delivery.json`；无登记停 needs-review，不跳过验证 |
| 迁移与回滚（RK-4） | S4 | 幂等迁移 + 可从旧库启动 + 回滚不删数据 |
| 跨进程并发正确性（RK-5） | S2/S4 | epoch fencing + 双连接/子进程探针；沙箱受限时记录替代口径 |
| Windows 路径/大小写/symlink（RK-6） | S1 | 纯函数 + 配置化大小写 + 五类拒绝面 |
| 自举：本仓正被治理（RK-9） | S5/S6/S8 | 实现期间默认不启用强制；观察模式 + 仓库级开关 |
| 体量与单链容量（RK-7/D-1） | 全批 | P0 先行；S6~S8 可顺延；S5/S6 已拆为两轮 |

**不做（沿用 REQUIREMENTS §4.2，任一切片不得越界）**：行级协同编辑；自动理解所有语义冲突；跨主机分布式锁；自动 stash 用户改动；同文件强制并行写入入口；一仓库多交付目标分支；用 run_attempts.state 表达交付；用交付状态代替占用状态；符号/代码区域级放行；非 Git 的版本快照/回滚；跳过验证标已交付；在用户工作区重做冲突调解；在生产库/仓库做失败注入。

---

## 10. 设计 §11.1 九场景与本任务验收标准对照

| 设计 §11.1 场景 | 主承载切片 | 对应 AC |
| --- | --- | --- |
| 1 同文件互斥、异文件并行 | S2 | AC-R2-1/2/7 |
| 2 路径判准（src/a 对 src/ab、大小写、目录子路径、重命名） | S1 | AC-R1-1~4 |
| 3 动态扩域撞车保留产物 | S2 + S5 | AC-R2-6、AC-R3-6 |
| 4 同文件串行交付 | S3 + S5 | AC-R3-7、AC-R4-1 |
| 5 集成后验证失败目标 ref 不变 | S3 | AC-R4-2 |
| 6 崩溃恢复每源提交至多集成一次 | S3 | AC-R4-4 |
| 7 本地脏工作区暂停且字节不变 | S3 | AC-R4-5 |
| 8 人审打回与隔离成果 | S6 | R-5/R-6 |
| 9 多空间同仓库、多 worker 同一权威 | S2 + S3 + S4 | AC-R2-7、AC-R4-8、AC-R6-5 |

| 本任务（T-168）验收标准 | 本文落点 |
| --- | --- |
| 把需求/方案拆成可独立认领、可独立验收的子任务 | §2 覆盖性映射 + §0 八切片 + 各切片独立文件域与独立 DoD |
| 每个子任务带验收标准 + 依赖关系（blockedBy）+ 工作量估计 | 「## slices」第 4 段（可测验收）+ §4（blockedBy 与工作量） |
| 每个子任务有「完成 = 什么」的可测口径 | 各切片验收均为「命令 + 期望（退出码 0 / 逐条断言）」，见 slices 第 4 段与 §6 DoD |
| 任务顺序/并行关系明确，无循环依赖、无遗漏 | §5 注册顺序与并行表 + §4 无回边说明 + §2 全覆盖检查 |

---

## 11. 本阶段假设与待将军确认

- **假设 A1**：设计文档虽自述「待评审」，但 REQUIREMENTS §8 D-1 默认「按 §12 全量推进、P0 先行」；本文据此拆 8 切片并让 P0 在前。若将军只批增量，按 §5 blockedBy 交付 S1~S4。
- **假设 A2**：验证命令登记面采用 RESEARCH D-P5 推荐（仓库声明文件 `.legion/delivery.json`，argv 数组）；对应 REQUIREMENTS D-4，仍待将军拍板。若改选 DB 表，S3/S8 的解析落点从文件改为表，其余契约不变。
- **假设 A3**：R-2 的「两个独立进程/连接」按 REQUIREMENTS 原文接受**同进程双连接**作为等价口径（§8.1 已证明子进程管道在沙箱被拒）。
- 本阶段不改需求语义与方案结论；上述假设若被将军修正，由守护带回并只影响 S3/S8 的登记面落点。

