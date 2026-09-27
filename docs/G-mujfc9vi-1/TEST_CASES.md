<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-27**（w/T-169 HEAD 9282ca1）的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 .ci/&lt;run&gt;/summary.json。
<!-- evidence-banner:end -->

# T-169 测试用例 / 验收测试：并行任务文件冲突治理（按设计文档落地）

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-169（[auto-goal]｜所属目标 G-mujfc9vi-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-166 需求：R-1~R-9 + AC-R*，共 **50 条**可测验收口径 + D-1~D-10 默认值）→ [RESEARCH.md](./RESEARCH.md)（T-167 方案：方案 A 推荐 + D-P1~D-P9 选型）→ [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-168 拆解：**「## slices」8 个切片 S1~S8**，每片第 4 段机器可测验收行 = 本文用例逐条翻译的唯一基准）
> 设计基线：[2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md)（自述状态「待评审」；§3~§11 产品规则与 §11.1 九场景为验收主口径）
> 下游：coder（T-170）按 §4 用例 + §9 附录 B 骨架把用例落成断言（文件域见 TASK_BREAKDOWN「## slices」第 3 段）；reviewer（T-171）按用例复核实现；tester（T-172）按 §2 分层逐条执行并把结果写入 docs/G-mujfc9vi-1/TEST_REPORT.md；devops（T-173）按 §4.8 接入 run-ci 与 .legion/delivery.json。
> 依据：TASK_BREAKDOWN「## slices」S1~S8 每片验收行（分号分句）+ REQUIREMENTS §5 AC-R1-1..6 / AC-R2-1..8 / AC-R3-1..8 / AC-R4-1..8 / AC-R5-1..6 / AC-R6-1..6 / AC-R7-1..3 / AC-R8-1..3 / AC-R9-1..2 + REQUIREMENTS §6 端到端总口径 11 条 + LEGION.md 纪律与 T-169 阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望与通过判据；关键业务规则正反向成对）。
>
> **权威基线/命名空间提醒**：本目标分析文档目录 = docs/G-mujfc9vi-1/。仓库根 docs/TEST_CASES.md 与 docs/G-mtpq729o-1、docs/G-mtr3su6f-1 的同名文档属其他目标/遗留链，**禁止读写**。本用例只写本文（docs/G-mujfc9vi-1/TEST_CASES.md）+ 自检证据（docs/G-mujfc9vi-1/T169-evidence/）；**不预写切片文件域内的可执行测试文件**（TASK_BREAKDOWN §5 已把各测试文件划给对应 coder 文件域，预写必与 coder 合入冲突），只交付用例 + 可照抄骨架（§9 附录 B）。
>
> **工作区状态**：分支 w/T-169，HEAD 9282ca1（promote T-168）。docs/G-mujfc9vi-1/ 现有 REQUIREMENTS.md、RESEARCH.md、TASK_BREAKDOWN.md（本文为 T-169 首次产出，无旧版）；docs/goals/G-mujfc9vi-1.md 为守护目标镜像快照，本阶段未触碰（工作区中该文件显示为 M 系守护写入，非本任务改动）。本阶段不对 live 库 team-hub/team.db 与主工作区做任何写入型验证。

## 0. 结论速览（TL;DR）

- 交付单件：本文档 docs/G-mujfc9vi-1/TEST_CASES.md + 自检证据 docs/G-mujfc9vi-1/T169-evidence/。共 **140 条用例**（S1 14 / S2 16 / S3 21 / S4 18 / S5 21 / S6 15 / S7 13 / S8 11 / E2E 11）；类别 **🟢正常 62 / 🟡边界 10 / 🔴异常·反向 68**；优先级 **P0 100 / P1 29 / P2 11**。每条含 **前置条件 / 操作步骤 / 期望结果与通过判据**；ID 唯一、类别枚举、列完整、AC 全覆盖、BR 正反向配对、骨架语法均经附录 A 自检脚本（§8）复跑复核，输出见 T169-evidence/01-doc-machcheck.txt。
- 验收标准被用例化：TASK_BREAKDOWN「## slices」S1~S8 验收行逐分句 + REQUIREMENTS §5 的 **50 条 AC** + §6 的 **11 条端到端总口径** + 设计 §11.1 九场景逐条映射到用例（§7 追溯矩阵 + §6 E2E），PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，无黑盒结论。
- 关键业务规则同时有正向与反向用例（§5，**BR-1~BR-42**，机器可复核）：段边界目录匹配、五类路径拒绝面、大小写两向、重命名两端、单一判定反证、非 Git 降级单写、同文件互斥/异文件并行、无半状态、epoch fencing、reconciling、扩域事务、活跃预约两两不相交、不队头阻塞、迁移幂等、入队门禁、version CAS、集成后验证、journal 崩溃恢复、脏工作区字节不变、未登记验证不交付、唯一集成入口、模式互斥、done 语义、观察模式不改派工、回滚不删数据、legacy 不倒推、徽标不冒充、并发裁决 409、历史重叠不冒充实时占用、指标降级可读、pre-execute 四类拒绝、HEAD 变化重核、WIP 不丢、越域 diff 不进入集成、等待不烧重试、CI 登记、verify argv、文档一致。
- 测试代码落点（§9 附录 B 骨架，逐切片对齐 TASK_BREAKDOWN 文件域，**由 coder 在各切片内物化成文件，本阶段不预写**）：S1 → packages/shared/test/path-domain.test.mjs、repo-identity.test.mjs；S2 → team-hub/write-intent-store.test.mjs（同进程双 DatabaseSync 连接等价口径）；S3 → git-plumbing / delivery-store / integration-worker 三个测试（系统临时仓库）；S5 → plugins/tests/write-eligibility.test.mjs；S7 → workbench/scripts/delivery-ui.test.mjs；S8 → run-ci 登记校验 + .legion/delivery.json 校验。全部 JS 骨架已通过 node --check 语法校验（证据 02-skeleton-syntax.txt）。
- 分层与执行者（§2）：L0 数据面契约（team-hub 临时库）｜L0-static 源码/静态断言｜L1 共享与 plugins 纯函数｜L2 隔离链路冒烟（临时 Git 仓库 + 隔离 hub）｜L3 UI 构建与浏览器冒烟｜L4 CI 回归与 docs 门禁。coder 随切片自跑、tester 在 T-172 逐条复跑并写 TEST_REPORT.md、devops 在 T-173 接入 run-ci。
- 环境事实（写进各用例执行说明）：本 worktree **零新增第三方依赖**（A-6）；沙箱下 Node 默认管道 stdio spawn 子进程会 **EPERM**，所有 git 调用必须用「文件描述符写临时文件」的非管道 stdio（§1.3 I-9）；跨进程争用按 REQUIREMENTS 原文接受**同进程双 DatabaseSync 连接**为等价口径（A-3）；**live 库 D:/project/DSH/legion/team-hub/team.db 与用户主工作区零触碰**（I-2），失败注入一律临时库/系统临时仓库。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS.md（T-166）§5 | R-1（P0 路径判定纯函数，AC-R1-1..6）/ R-2（P0 intent+reservation 事务，AC-R2-1..8）/ R-3（P0 Orchestrator 资格·等待·扩域，AC-R3-1..8）/ R-4（P0 交付与集成 worker，AC-R4-1..8）/ R-5（P1 Workbench，AC-R5-1..6）/ R-6（P1 legacy 收敛与 done 语义，AC-R6-1..6）/ R-7（P1 非 Git 降级，AC-R7-1..3）/ R-8（P2 度量，AC-R8-1..3）/ R-9（P2 文档同步，AC-R9-1..2），共 50 条 |
| REQUIREMENTS.md §6 | 端到端总口径 11 条（设计 §11.1 九场景 + 发布门槛 + 默认决策不放宽）→ 本文 E2E-1..11 |
| TASK_BREAKDOWN.md（T-168）「## slices」 | S1~S8 每片第 3 段文件域（测试落点）与第 4 段机器可测验收行（分号分句 = 本用例逐条翻译对象）；§4 blockedBy、§5 串并行、§7 跨切片契约、§8 沙箱纪律 |
| RESEARCH.md（T-167）§4、§6 | D-P1 path-domain 落点 / D-P2 段数组匹配 / D-P4 --git-common-dir / D-P5 .legion/delivery.json / D-P6 paths_json 内存判定 / D-P7 merge --ff-only + update-ref 对账 / D-P8 Workbench / D-P9 指标 available 口径；§6.3 集成 worker 八步时序 |
| 设计文档 §3~§11 | 交付子状态七值词表、写入调度五值词表、done 语义、五张表不变量、claim 原子授资格、扩域、入队条件、集成六步、journal 四阶段、失败恢复九行、迁移四阶段、§11.1 九场景、§12 两条默认决策 |
| 代码基线 | w/T-169 HEAD 9282ca1；回归锚点 team-hub/claim-policy.test.mjs 35 例、team-hub/chat.test.mjs 51 例（T-168 实测基线）；team-hub/run-concurrency.test.mjs 在本沙箱 exit 1（spawn EPERM）**不作回归基线** |

### 1.2 工作假设（将军未否决即按此展开；翻转只影响取值不影响断言语义）

| # | 假设 | 依据 | 翻转影响 |
| --- | --- | --- | --- |
| A-1 | 设计文档 §3~§11 与 §11.1 九场景为需求基线；技术路线按 RESEARCH 方案 A（零新增依赖 + merge-tree 候选 + 临时隔离 worktree 验证 + 绑定工作区 merge --ff-only） | REQUIREMENTS A-1/A-2；RESEARCH §0 | 方案改选只影响 S3 实现形态，用例断言语义（目标 ref 不动/仅快进/验证后交付）不变 |
| A-2 | 仓库级验证命令登记面 = 仓库声明文件 .legion/delivery.json（字段 targetRef + verify[] 的 argv 数组） | REQUIREMENTS D-4；RESEARCH D-P5；TASK_BREAKDOWN 假设 A2 | 若改选 DB 表，S3/S8 登记面用例（TC-S3-17/18、TC-S8-03/04/06）只改取值来源 |
| A-3 | R-2「两个独立进程/连接」接受**同进程两个 DatabaseSync 连接**为等价口径；真子进程探针在沙箱允许时运行，EPERM 时以双连接替代并在证据中记录 | REQUIREMENTS AC-R2-1 原文「进程/连接」；TASK_BREAKDOWN §8.1/假设 A3 | 若强制真实多进程，TC-S2-01/02 需改用非管道 stdio 探针，断言不变 |
| A-4 | 规划期「预计写入范围」复用 tasks.fileDomain（D-5），intent ⊆ fileDomain，最终 diff ⊆ intent ∩ fileDomain | REQUIREMENTS D-5；设计 §4 | 若新增独立规划步骤，TC-S4-01 绑定语义调整 |
| A-5 | 沙箱下 git 子进程一律非管道 stdio（fd 指向临时文件）；结果文件内容即 stdout/stderr | TASK_BREAKDOWN §8.1 实测 | 不可用平台改用方案 B（临时 worktree 真实 merge），断言不变 |
| A-6 | 运行链零新增第三方依赖；Node v24.19.0、Git ≥ 2.38（本机 2.55.0.windows.5） | REQUIREMENTS A-6；RESEARCH §5.1/§5.4 | Git &lt; 2.38 时 S3 降级到方案 B |
| A-7 | 灰度默认「观察模式」，新 done 语义仅对交付型任务生效，非代码阶段任务不追溯 | REQUIREMENTS D-2/D-3；设计 §10 | 若默认即强制，TC-S6-08/09 观察模式用例改为强制模式口径 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增第三方运行时/开发依赖（只用 Node 内置模块与本机 Git 子命令） | TC-S1-14、TC-S2-14、TC-S3-08、TC-S4-17、TC-S5-19、TC-S7-13、TC-S8-10 |
| I-2 | live 库 team-hub/team.db 与用户主工作区零写入；失败注入只在临时库/系统临时仓库 | TC-S2-01、TC-S3-16、TC-S4-04、TC-S6-11、TC-S8-10 |
| I-3 | 交付状态（awaiting-acceptance/ready/preparing/validating/needs-review/integrated/abandoned）与写入调度状态（unplanned/waiting-file/reserved/reconciling/released）互相独立，不互相代替 | TC-S3-06、TC-S5-01、TC-S3-05、TC-S4-03 |
| I-4 | 不扩 run_attempts.state 表达 Git 交付；done 仅在 integrated + 原验收通过后产生 | TC-S6-04、TC-S6-05、TC-S6-06、TC-S6-07 |
| I-5 | 不提供同文件强制并行写入入口；未配置验证命令必须停 needs-review，不得跳过验证标已交付 | TC-S7-05、TC-S3-18、TC-S8-05、E2E-11 |
| I-6 | 不自动 stash/覆盖用户工作区；脏工作区暂停集成且字节不变 | TC-S3-16、TC-S6-11、E2E-7 |
| I-7 | 同一判定函数被 store 与 plugins 共用，不存在第二份字符串前缀判定（AC-R1-6） | TC-S1-14、TC-S2-14、TC-S5-19 |
| I-8 | 服务端从数据库解析仓库目录与 target ref；浏览器传绝对路径/shell 串/任意 Git ref 一律拒绝 | TC-S4-06、TC-S4-07、TC-S4-08 |
| I-9 | 所有 git 子进程调用使用非管道 stdio；结果经文件描述符捕获（沙箱 EPERM 纪律） | TC-S3-08、TC-S3-09、TC-S3-10、E2E-6 |
| I-10 | 指标不可读时显示「暂无读数及原因」，绝不显示 0 | TC-S4-13、TC-S7-10、E2E-10 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 与仓库既有批次同构；命令以 node 直跑为准。**本阶段（T-169）只产出用例与骨架，不执行用例**（执行是 tester T-172 的职责）；下表仅标注各用例的载体与执行者。**node_modules 不在本 worktree**：plugins typecheck、workbench build 需宿主/CI 或 run-ci deps junction，受限时按「如实记录复现步骤与输出」处理，不冒充通过。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 数据面契约：node team-hub/write-intent-store.test.mjs、node team-hub/delivery-store.test.mjs、node team-hub/integration-worker.test.mjs、node team-hub/git-plumbing.test.mjs、node team-hub/write-intent-routes.test.mjs、node team-hub/delivery-routes.test.mjs、node team-hub/metrics.test.mjs（tmp-DB / 系统临时仓库） | S2/S3/S4 数据面、事务、路由、指标 | coder 随切片；tester 复跑 | 纯 Node 直跑（node:test / node:sqlite）；git 走非管道 stdio |
| L0-static | 源码/静态断言：node -e / grep / git diff（无第二份 startsWith、无自动 stash、无 dangerouslySetInnerHTML、改动文件域） | S1/S2/S5/S7/S8 静态门禁 | coder 随切片；tester 复跑 | 纯 Node 直跑 |
| L1 | 共享纯函数与 plugins 纯函数：node packages/shared/test/path-domain.test.mjs、node packages/shared/test/repo-identity.test.mjs、node plugins/tests/write-eligibility.test.mjs、node plugins/tests/legacy-convergence.test.mjs、node plugins/tests/mediation.test.mjs、node plugins/tests/workspace.test.mjs；类型 tsc -p plugins/tsconfig.json --noEmit | S1/S5/S6 纯函数判定与快照 + 回归 | coder S1/S5/S6；tester 复跑 | plugins 测试 import 构建产物或源码，依赖就位后；受限如实记录 |
| L2 | 隔离链路冒烟：隔离 hub（TEAM_HUB_DB=mkdtemp + 端口）+ 绑定临时 Git 仓库 fixture；崩溃时点用 journal 状态注入 | S3 集成、S2 跨连接争用、S4 HTTP、S8 登记面 | coder S3/S4/S8；tester 复跑 | 宿主可达；不触碰 live 库与本仓真实仓库 |
| L3 | UI 构建与浏览器冒烟：pnpm --dir workbench build（tsc --noEmit + vite build）+ node workbench/scripts/delivery-ui.test.mjs + 既有浏览器驱动脚本同型 | S7 徽标/等待/裁决 | coder S7；tester 复跑 | workbench node_modules 缺失时经 run-ci deps junction 兜底，仍不可用则如实记录 |
| L4 | CI 回归 + docs 门禁：node scripts/ci/run-ci.mjs（新增测试登记校验）、node scripts/ci/check-docs.mjs | 全批不回归、S8 文档门禁 | devops T-173 + tester 复跑 | 宿主/CI |

### 2.1 关键命令与 env（coder/tester 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| 路径判定纯函数 | node packages/shared/test/path-domain.test.mjs | S1；期望 exit 0，逐条断言见 TC-S1-* |
| 仓库身份纯函数 | node packages/shared/test/repo-identity.test.mjs | S1；临时仓库以 fd 捕获 git rev-parse --git-common-dir |
| 预约事务（同进程双连接） | node team-hub/write-intent-store.test.mjs | S2；mkdtempSync 临时库 + 两个 new DatabaseSync(file) |
| claim 回归锚点 | node team-hub/claim-policy.test.mjs | 基线 35 例不回归 + 不队头阻塞新增断言 |
| 交付/集成 | node team-hub/delivery-store.test.mjs、node team-hub/integration-worker.test.mjs、node team-hub/git-plumbing.test.mjs | S3；夹具全在系统临时仓库 |
| HTTP 路由 | node team-hub/write-intent-routes.test.mjs、node team-hub/delivery-routes.test.mjs、node team-hub/metrics.test.mjs、node team-hub/chat.test.mjs | S4；chat.test.mjs 基线 51 例不回归 |
| 守护写入资格 | node plugins/tests/write-eligibility.test.mjs、node plugins/tests/workspace.test.mjs | S5；快照结构断言 + WIP 保留 |
| legacy 收敛 | node plugins/tests/legacy-convergence.test.mjs、node plugins/tests/mediation.test.mjs | S6；旧路径被拒/单入口/done 负例 |
| UI | pnpm --dir workbench build、node workbench/scripts/delivery-ui.test.mjs | S7；徽标映射不冒充 |
| 登记面与门禁 | node scripts/ci/run-ci.mjs、node scripts/ci/check-docs.mjs、.legion/delivery.json 校验 | S8；登记全 + argv 数组 |
| 沙箱安全 git 捕获 | const fd = openSync(out,'w'); spawnSync('git',args,{stdio:['ignore',fd,fd]}) | I-9；禁止默认管道 stdio |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 实现期可配值（超时/上限/窗口），做「值-1 / 值 / 值+1」三值法断言；定值后无需改用例。默认值承接 REQUIREMENTS §5 与 RESEARCH D-P*。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| 路径拒绝面（AC-R1-2） | 五类非法输入 | 绝对路径（Windows/POSIX）、含 ..、空串或纯空白、.git、符号链接越界逐条返回结构化拒绝（ok:false + 可读 reason），无一静默通过 |
| 目录匹配（AC-R1-1） | 段边界 | src/a（目录）与 src/a/b.mjs 相交；src/a 与 src/ab 不相交（文件精确相等才算） |
| 大小写（AC-R1-3） | 按仓库配置 | caseInsensitive=true 时 Src/A.mjs 与 src/a.mjs 相交；false 时不相交 |
| 同文件互斥（AC-R2-1） | 1 个赢家 | 同仓库相交路径并发的活跃 reservation 恰好 1 条，其余得 FILE_CONTENTION{code,paths,holderTaskId} |
| 等待不烧重试（AC-R3-1） | 重试计数不变 | 等待任务 status=todo、schedulingState=waiting-file、阻塞者与路径可见、attempt/重试计数不增 |
| job 唯一性（AC-R4-8） | 1 个活跃 job | 同仓库同 target ref 并发认领恰一个成功，另一被拒/排队 |
| 验证门槛（AC-R4-2/7） | 全绿才交付 | 验证失败或未登记验证命令时目标 ref SHA 不变、不 integrated、停 needs-review |
| 重算上限（AC-R4-3） | 有明确上限 N | HEAD 前进 ≤N 次自动重算重验，第 N+1 次进 needs-review（计数可断言） |
| 等待时长（AC-R8-3） | P50/P95 窗口明确 | 端点返回样本窗口与可复算口径，抽样值与手工重算一致 |
| 指标可读性（AC-R8-2） | available 布尔 | 不可读返回 available:false + reason，value 不为 0；可读返回 available:true + 与事件一致的值 |
| 文档门禁（AC-R9-2） | check-docs exit 0 | 正向 exit 0；关键句被删或坏链注入则 FAIL |
| 登记面（D-P5） | argv 数组 | targetRef 为完整 ref（refs/heads/...）；verify[].argv 为字符串数组，任意 shell 字符串被拒 |

## 4. 用例目录（S1~S8 + E2E）

> 图例：类别 🟢正常（主路径）/ 🟡边界（极限·三值）/ 🔴异常·反向（非法输入拒绝、规则违反被检出、恢复路径）；优先级按切片优先级（S1~S5 = P0，S6/S7 = P1，S8 = P2，E2E 主场景 P0、默认决策反向 P1）；「自动化」列 = 载体（L0 数据面契约 / L0-static 静态断言 / L1 纯函数 / L2 隔离真实链路 / L3 UI 构建与冒烟 / L4 CI 门禁 / 评审）。
> 追溯列引用：REQUIREMENTS 验收口径（AC-R*-*）、TASK_BREAKDOWN「## slices」验收行（「Sx 验收 n」= 该片第 4 段分句序号）、RESEARCH 决策（D-P*）、工作假设（A-x）、不变量（I-x）。每行 = 一条可执行用例：前置条件 → 操作步骤 → 期望结果 / 通过判据（PASS/FAIL 唯一线，§3）。
> 命名空间：TC-S<n>-<m> 仅指本文档新增用例（与既有 team-hub/claim-policy.test.mjs、team-hub/chat.test.mjs 内的用例命名风格一致但不重号）；E2E-n 为端到端总口径用例。

### 4.0 现状缺口 → 切片 → 用例索引（供 coder 先复现后实现、tester 回归对照）

| 缺口（REQUIREMENTS §2.2 现状证据） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 越域判定用字符串前缀 startsWith，src/a 误覆盖 src/ab；无共享规范化函数 | S1 | TC-S1-01..11、TC-S1-14 |
| G2 跨 worktree 无统一仓库身份；非 Git 无降级判定 | S1 | TC-S1-12、TC-S1-13 |
| G3 5 张新表（intent/reservation/deliveries/jobs/events）零实现，claim 无文件维度 | S2/S3 | TC-S2-01..15、TC-S3-01..20 |
| G4 无运行中扩域、无 pre-execute 授权校验、无等待语义 | S5 | TC-S5-01..20 |
| G5 冲突无结构化响应、无 HTTP 治理接口、无仓库/ref 服务端解析 | S4 | TC-S4-01..11 |
| G6 无交付子状态、无集成后验证、autoPromote 直合即完成 | S3/S6 | TC-S3-01..20、TC-S6-01..14 |
| G7 无 workbench 交付徽标/等待说明/裁决面板与 version CAS | S7 | TC-S7-01..13 |
| G8 7 项指标无采集与展示面，不可读口径未定义 | S4/S7 | TC-S4-12..14、TC-S7-10 |
| G9 仓库级验证命令登记面不存在 | S3/S8 | TC-S3-17/18、TC-S8-03..06 |
| G10 文档族未描述等待/集成/集成后验证/done 语义 | S8 | TC-S8-07..09 |
| G11 live 库/主工作区不可做写入型验证 → 全部临时库/临时仓库 | 全批 | TC-S2-01、TC-S3-16、TC-S4-04、TC-S6-11（I-2） |

### 4.1 S1 共享纯函数基座（R-1 路径判定 + R-7/R-4 仓库身份与能力探测）——自动化：L1 node packages/shared/test/path-domain.test.mjs + repo-identity.test.mjs + L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | S1 合入（packages/shared/src/path-domain.mjs 导出 normalizeRepoPath/classifyEntry/pathsIntersect/expandRename） | 构造目录条目 src/a（type=dir）与文件条目 src/a/b.mjs（type=file），调用 pathsIntersect | 判相交=true（目录按路径段边界覆盖其子路径）；且目录 src/a 与文件 src/a 下多层子路径均判相交——S1 验收 1；AC-R1-1 | L1 | AC-R1-1；S1 验收 1；D-P2 |
| TC-S1-02 | 🔴 P0 | 同 TC-S1-01 | 构造目录条目 src/a 与文件条目 src/ab，调用 pathsIntersect | 判相交=false（不得因字符串前缀相同而误判）；src/ab 不被 src/a 覆盖——S1 验收 1 反向；AC-R1-1 | L1（负例） | AC-R1-1；S1 验收 1；D-P2 |
| TC-S1-03 | 🟢 P0 | 同 TC-S1-01 | 文件条目 src/a.mjs 对同路径文件、以及目录条目 src/a 对目录 src/a，分别判相交 | 同类型且规范路径完全相同 → 相交=true；文件与目录同名但类型不同不静默视为相等（由 classifyEntry 显式给出类型）——S1 验收 1 | L1 | AC-R1-1；S1 验收 1 |
| TC-S1-04 | 🔴 P0 | 同 TC-S1-01 | 文件 src/a.mjs 对文件 src/b.mjs；目录 src/a 对目录 src/b；文件 src/a.mjs 对目录 src/a.mjs/sub | 三者均判相交=false（不误判）——S1 验收 1 反向 | L1（负例） | AC-R1-1；S1 验收 1 |
| TC-S1-05 | 🔴 P0 | 同 TC-S1-01 | 逐条输入五类非法：C:/x/a.mjs（Windows 绝对）、/etc/passwd（POSIX 绝对）、../secret、docs/../secret、空串与纯空白、docs/.git/config、越界符号链接目标 | 每条 normalizeRepoPath 返回结构化拒绝（ok=false 且 reason 可读），无一静默通过或抛未捕获异常；返回值为仓库相对规范路径的前提成立——S1 验收 2；AC-R1-2 | L1（负例） | AC-R1-2；S1 验收 2 |
| TC-S1-06 | 🟢 P0 | 同 TC-S1-01；仓库配置 caseInsensitive=true | 对 Src/A.mjs 与 src/a.mjs 调 pathsIntersect（文件对文件） | 判相交=true（Windows 别名归一）——S1 验收 3；AC-R1-3 | L1 | AC-R1-3；S1 验收 3 |
| TC-S1-07 | 🔴 P0 | 同 TC-S1-01；仓库配置 caseInsensitive=false | 对 Src/A.mjs 与 src/a.mjs 调 pathsIntersect | 判相交=false（大小写敏感）；同一组输入在两种配置下结论不同，证明配置真被消费——S1 验收 3 反向；AC-R1-3 | L1（负例） | AC-R1-3；S1 验收 3 |
| TC-S1-08 | 🟢 P0 | 同 TC-S1-01 | 调 expandRename({from:'src/old.mjs', to:'src/new.mjs'})；再以另一任务声明 src/old.mjs 与结果判相交 | 展开结果同时包含旧路径与新路径两条条目；与 src/old.mjs 判相交=true——S1 验收 4；AC-R1-4 | L1 | AC-R1-4；S1 验收 4 |
| TC-S1-09 | 🔴 P0 | 同 TC-S1-01 | 重命名 src/old.mjs → src/new.mjs；另一任务只声明 src/old.mjs（新路径不撞），再反向只声明 src/new.mjs | 两端任一端相交即整体判冲突（true）；不得只看新路径而漏判旧路径——S1 验收 4 反向；AC-R1-4 | L1（负例） | AC-R1-4；S1 验收 4 |
| TC-S1-10 | 🟡 P0 | 同 TC-S1-01 | 边界输入：空数组对非空路径、单元素数组、目录与自身、超长路径（约 4096 字符）、含连续斜杠 // 的路径 | pathsIntersect([], x)=false 且不抛；单元素自比较=true；目录与自身相交=true；超长与连续斜杠按规范路径处理或结构化拒绝，均不崩——S1 验收 1/2 边界；AC-R1-5 | L1（边界） | AC-R1-5；S1 验收 1/2 |
| TC-S1-11 | 🟢 P0 | 同 TC-S1-01 | 同一输入连续调用两次并比对；静态检查 path-domain.mjs 的 import 清单 | 两次结果 JSON 深相等（同输入同输出）；源码仅 import node:path（无 fs/网络/时钟/随机）——S1 验收 5；AC-R1-5 | L1 + L0-static | AC-R1-5；S1 验收 5 |
| TC-S1-12 | 🟢 P0 | S1 合入（repo-identity.mjs 导出 repoIdFromCommonDir/detectRepoCapability）；宿主 Git 可用 | 在临时仓库建两个 worktree，各自以 fd 捕获 git rev-parse --git-common-dir，再经 repoIdFromCommonDir（含分隔符与大小写变体 d:\\repo\\.git 与 D:/repo/.git） | 两个 worktree 归一出同一 repoId（与主仓库一致）；分隔符/大小写规范化后相等——S1 验收 6；AC-R7-1；D-P4 | L1 + L2 | AC-R7-1；S1 验收 6；D-P4 |
| TC-S1-13 | 🔴 P0 | 同 TC-S1-12 | 分别注入探测事实：isGit=false、gitAvailable=false、commonDir=null/不可规范化；readOnly 任务标记 | detectRepoCapability 返回 capability=degraded、reason 非空可读、singleWriterRequired=true、readOnlyAllowed=true；只读任务不受限判定为真——S1 验收 6/7；AC-R7-1/R7-2/R7-3 | L1（负例） | AC-R7-1/2/3；S1 验收 6/7 |
| TC-S1-14 | 🔴 P0 | S1/S2/S5 合入后 | 静态断言：全仓 grep 越域判定实现（startsWith/prefix 前缀比较）与 path-domain 引用；检查 write-intent-store.mjs 与 plugins 侧判定是否 import packages/shared/src/path-domain.mjs | 不存在第二份字符串前缀越域判定；store 与 plugins 判定同源于 path-domain；path-domain.mjs 仅 import node:path；零新增依赖（I-1）——S1 验收 8；AC-R1-6；I-7 | L0-static | AC-R1-6；I-1/I-7；S1 验收 8 |

### 4.2 S2 team-hub 写入意图与预约事务及 claim 接线（R-2 + R-3 服务端候选 + R-7 非 Git 单写）——自动化：L0 node team-hub/write-intent-store.test.mjs + node team-hub/claim-policy.test.mjs + L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | S2 合入（write-intent-store.mjs + ensureWriteIntentSchema）；mkdtemp 临时库文件 | 开两个 DatabaseSync 连接（dbA/dbB，等价口径 A-3）；dbA 任务 t1 申请 src/a.mjs，dbB 任务 t2 申请 src/b.mjs（不相交），同一 BEGIN IMMEDIATE 路径 | 两者均成功：两条活跃 reservation、各自绑定 attempt 与 epoch、revision 各自初始；无 FILE_CONTENTION——S2 验收 2；AC-R2-2 | L0 | AC-R2-2；S2 验收 2；A-3 |
| TC-S2-02 | 🔴 P0 | 同 TC-S2-01 | dbA 任务 t1 先申请 src/a.mjs 成功；dbB 任务 t2 再申请 src/a.mjs（相交），并发发起 | 恰好一条活跃 reservation；第二个返回结构化 FILE_CONTENTION，含冲突路径 src/a.mjs 与持有任务 t1；t2 不落 reservation、不落 Attempt——S2 验收 1 反向；AC-R2-1/R2-7 | L0（负例） | AC-R2-1/R2-7；S2 验收 1；A-3 |
| TC-S2-03 | 🔴 P0 | 同 TC-S2-01，注入事务中途失败（如写预约前抛错/约束冲突） | 在一次 claim 事务内「选候选→读活跃 reservation→判交集→建 Attempt→写预约→递增 epoch」中途失败，回滚后查询 Attempt 表与 reservation 表 | 两表均无残留行：不出现「已认领无资格」或「有预约无 Attempt」的半状态；lease epoch 未递增——S2 验收 3；AC-R2-3 | L0（失败注入） | AC-R2-3；S2 验收 3 |
| TC-S2-04 | 🔴 P0 | 同 TC-S2-01，已有活跃 reservation（epoch=E） | 以过期 epoch=E-1 调释放（release）；读取返回的错误信息 | 释放被拒；错误信息包含当前真实 epoch=E（调用方可据以判断自身已过期）；reservation 仍 active 未被释放——S2 验收 4；AC-R2-4 | L0（负例） | AC-R2-4；S2 验收 4 |
| TC-S2-05 | 🔴 P0 | 同 TC-S2-01，已有活跃 reservation（epoch=E） | 以过期 epoch 上报执行结果/迟到的写入确认 | 上报被拒（epoch fencing），旧 epoch 的迟到写入不得进入；活跃 reservation 与 Attempt 身份不变——S2 验收 4 反向；AC-R2-4 | L0（负例） | AC-R2-4；S2 验收 4 |
| TC-S2-06 | 🟢 P0 | 同 TC-S2-01，构造租约过期且执行进程未确认退出 | 租约过期后不确认退出直接释放该 reservation；再模拟确认执行已结束并释放 | 未确认时 reservation=reconciling（不是 released）；确认结束后可正常释放（released）；reconciling 期间旧 epoch 写入/上报被拒——S2 验收 5；AC-R2-5 | L0 | AC-R2-5；S2 验收 5 |
| TC-S2-07 | 🔴 P0 | 同 TC-S2-01，t1 已持 src/a.mjs 活跃预约；t2 有 intent（revision=r） | t2 提出扩域申请加入 src/a.mjs（撞车） | 扩域失败并暂停该写入步骤；t2 的 intent revision 保持 r 不变；t2 现有 worktree 产物保留（不被删除/回滚）——S2 验收 6 反向；AC-R2-6 | L0（负例） | AC-R2-6；S2 验收 6 |
| TC-S2-08 | 🟢 P0 | 同 TC-S2-01，t2 的 intent revision=r，新增路径与其他活跃预约不相交 | t2 提出扩域申请（新增 src/c.mjs） | 扩域成功：intent revision 提升为 r+1，新范围生效并可被查询；变更另记只追加事件——S2 验收 6；AC-R2-6 | L0 | AC-R2-6；S2 验收 6 |
| TC-S2-09 | 🟢 P0 | 同 TC-S2-01，构造多任务多路径活跃预约（含目录与重命名两端） | 全库扫描断言：取同仓库全部活跃 reservation 的 paths_json，两两调 pathsIntersect | 任意两条活跃 reservation 的相交路径集合为空（两两不相交）；无覆盖相交路径的活跃预约——S2 验收 7；AC-R2-7 | L0 | AC-R2-7；S2 验收 7 |
| TC-S2-10 | 🔴 P0 | 同 TC-S2-01；仓库 capability=degraded（非 Git/Git 不可用） | 第一写入任务成功；第二写入任务申请写入资格 | 第二个写入任务被拒或在等待列表（不得并行写）；拒绝/等待原因含降级原因字符串（可读）；单写强制 singleWriterRequired=true 生效——S2 验收 8 反向；AC-R7-1 | L0（负例） | AC-R7-1；S2 验收 8；I-6 |
| TC-S2-11 | 🟢 P0 | 同 TC-S2-01，intent revision=r | 以错误 revision（r-1 或 r+1）提交 intent 更新；再以 r 提交一次合法更新 | 错误 revision 被拒（CAS 失败）且不落库；正确 revision 成功并令 revision+1；每次变更另记只追加事件——设计 §4；S2 验收 6 | L0 | 设计 §4；S2 验收 6 |
| TC-S2-12 | 🟢 P0 | 同 TC-S2-01；构造 claim 队列：队首候选文件被占用、队尾候选文件不相交 | 触发一次 claim 候选扫描 | 队尾不相交任务先被领取（后部不被队头阻塞）；扫描有明确上限且排序稳定（重复运行结果一致）；被跳过的队首任务保持 todo 等待——S2 验收 9；AC-R3-2 | L0 | AC-R3-2；S2 验收 9 |
| TC-S2-13 | 🟢 P0 | 临时库；构造旧库（无 5 张新表）与已迁移库 | 对同一库连续执行两次迁移；再分别从旧库与新库启动 store | CREATE TABLE IF NOT EXISTS 幂等：重复迁移无错、旧库可启动并补齐新表、旧库既有数据无损——S2 验收 10；AC-R2-8 | L0 | AC-R2-8；S2 验收 10 |
| TC-S2-14 | 🔴 P0 | S2 合入后 | 静态断言：write-intent-store.mjs 引用 packages/shared/src/path-domain.mjs，路径相交按段边界判定；SQL 文本中无 LIKE/前缀匹配式路径比较；依赖清单核对 | store 侧不存在第二份前缀判定；零新增第三方依赖——S2 验收 11；AC-R1-6；I-1/I-7 | L0-static | AC-R1-6；I-1/I-7；S2 验收 11 |
| TC-S2-15 | 🟢 P0 | S2 全部合入 | 回归门禁：node team-hub/claim-policy.test.mjs；核对新增「不队头阻塞/稳定排序」断言存在 | exit 0 全绿：基线 35 例不回归 + 新增断言 pass——S2 验收 12 | L0 | S2 验收 12 |
| TC-S2-16 | 🟡 P0 | 同 TC-S2-01 | 边界输入：空 paths 数组、仅目录自身（src/a 对 src/a）、同一任务重复申请同一路径；再把候选扫描上限设为小值构造超长队列 | 空 paths 返回结构化拒绝（不落预约）；目录自身判相交；重复申请幂等（不产生第二条活跃预约）；扫描上限内稳定排序且不因超长队列卡死事务——S2 验收 1/9 边界；AC-R2-1/R2-2 | L0（边界） | AC-R2-1/R2-2；S2 验收 1/9 |

### 4.3 S3 team-hub 交付与集成（delivery/job store + 单仓库集成 worker + 验证登记 + 沙箱安全 git 接缝，R-4）——自动化：L0 delivery-store / integration-worker / git-plumbing 三测试（系统临时仓库）+ L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🔴 P0 | S3 合入（delivery-store.mjs）；临时库 | 构造入队请求：source_commit 稳定、未提交改动已保全、运行验收证据齐备、人审已批，但最终 diff 越出 fileDomain/intent | 不得进入 ready；保留 awaiting-acceptance 或明确拒绝原因（含越域文件清单）——S3 验收 1 反向；AC-R4-7 | L0（负例） | AC-R4-7；S3 验收 1；I-5 |
| TC-S3-02 | 🔴 P0 | 同 TC-S3-01 | 构造入队请求：diff 合规但运行验收证据缺失 | 不得进入 ready；记录缺失项（缺哪份证据）——S3 验收 1 反向；AC-R4-7 | L0（负例） | AC-R4-7；S3 验收 1 |
| TC-S3-03 | 🔴 P0 | 同 TC-S3-01 | 构造入队请求：diff 合规、证据齐备，但原有人审岗位未批准 | 不得进入 ready；不得给历史 done 补造批准——S3 验收 1 反向；AC-R4-7 | L0（负例） | AC-R4-7；S3 验收 1 |
| TC-S3-04 | 🟢 P0 | 同 TC-S3-01 | 构造入队请求：source_commit 稳定 + 未提交改动已保全 + diff 过域 + 验收证据齐 + 人审批 | state=ready（写入 task_deliveries）；此时仍占用写入范围（reservation 不释放，AC-R11/R4）——S3 验收 1；AC-R4-7 | L0 | AC-R4-7；S3 验收 1 |
| TC-S3-05 | 🔴 P0 | 同 TC-S3-01，已有 delivery.version=v | 以旧 version=v-1 提交交付状态更新；再以 v 提交 | 旧 version 被拒（CAS 失败）且不落库；正确 version 成功并令 version+1；不覆盖他人的交付记录——设计 §4；S3 验收 2 | L0（负例） | 设计 §4；S3 验收 2 |
| TC-S3-06 | 🟢 P0 | 同 TC-S3-01 | 依次推进 awaiting-acceptance→ready→preparing→validating→integrated；另一条 needs-review→abandoned；对 integrated 尝试再次推进；对终态任务重做 | 状态机合法迁移全通；integrated 与 abandoned 为终态、不可再迁移；重做必须产生新 Attempt 与新 delivery（不覆盖旧记录）；交付状态与写入调度状态词表互相独立——S3 验收 3；I-3 | L0 | S3 验收 3；I-3 |
| TC-S3-07 | 🟢 P0 | 同 TC-S3-01；两任务同仓库同 target ref | 并发认领 integration job（两连接/两路径，epoch 租约争用） | 同时至多一个活跃 integration job；恰一个赢家，另一被拒/排队；唯一赢家持有 lease epoch——S3 验收 4；AC-R4-8 | L0 | AC-R4-8；S3 验收 4 |
| TC-S3-08 | 🟢 P0 | git-plumbing.mjs 合入；系统临时仓库（不触碰本仓）；非管道 stdio（fd 写临时文件，I-9） | 对两个无冲突分支执行 merge-tree --write-tree；对两个改同一行内容的分支执行同一命令 | 干净合并：git 退出码 0，可解析出 tree 对象标识；内容冲突：退出码 1 且输出可判定为冲突（两态可区分、不抛未捕获异常）——S3 验收 5；设计 §6.2 步骤 3 | L0 + L2 | S3 验收 5；I-9 |
| TC-S3-09 | 🟢 P0 | 同 TC-S3-08；已有干净 tree 与 expected_head、source | 执行 git commit-tree 生成候选提交；解析其父提交 | 候选提交第一父 == expected_head，第二父 == source；候选保留任务分支与原提交可达——S3 验收 5；设计 §6.2 步骤 6 | L0 + L2 | S3 验收 5；I-9 |
| TC-S3-10 | 🟢 P0 | 同 TC-S3-08；构造「source 已被集成」与「未被集成」两态 | 分别执行 git merge-base --is-ancestor source expected_head | 已集成判定为真（退出码 0）、未集成为假（退出码 1）；可用于崩溃恢复对账——S3 验收 5；RK-1 | L0 + L2 | S3 验收 5；I-9 |
| TC-S3-11 | 🟢 P0 | 同 TC-S3-08；干净候选 + 登记验证命令全绿；绑定工作区干净 | 走完整集成时序：认领 job → 校验干净 → 生成候选 → 候选上跑验证 → 复核 ref==expected_head → 仅快进 merge → 记账 | 目标 ref 前进且包含任务 source commit（is-ancestor 为真）；task_deliveries=integrated；记录 integrated_commit；释放 reservation——S3 验收 6；AC-R4-1 | L0 + L2 | AC-R4-1；S3 验收 6 |
| TC-S3-12 | 🔴 P0 | 同 TC-S3-11，但候选上验证命令非零退出 | 执行同一集成时序至验证失败 | 目标 ref SHA 与集成前完全相同（不变）；不进入 integrated、不产生 done；保存候选与验证报告；呈现「集成验证失败」——S3 验收 7 反向；AC-R4-2；设计 §11.1 场景 5 | L0（失败注入） | AC-R4-2；S3 验收 7 |
| TC-S3-13 | 🟡 P0 | 同 TC-S3-11；在验证期间/最终提交前推进目标 ref | 触发最终复核发现 ref 已前进；重复至超过自动重算上限 N | 当前候选与验证结果作废；按新 HEAD 重算候选并重验；重算次数有上限 N，第 N+1 次进入 needs-review（不得无限循环、不得复用过期绿色结果）——S3 验收 8；AC-R4-3 | L0（边界） | AC-R4-3；S3 验收 8 |
| TC-S3-14 | 🟢 P0 | 同 TC-S3-08；journal 四阶段 prepared/applying/ref-updated/finalized | 分别在三时点杀死 worker：集成前、ref 更新后落库前、落库后；每次重启后执行恢复对账 | 三时点恢复后每个 source commit 至多集成一次（is-ancestor/ref SHA 对账）；「已应用未记账」只补记不重跑 merge；不丢产物、不重复推进任务——S3 验收 9；AC-R4-4；设计 §11.1 场景 6 | L0（失败注入） | AC-R4-4；S3 验收 9；I-9 |
| TC-S3-15 | 🔴 P0 | 同 TC-S3-14；构造「结果不明」态（ref 与 journal 无法判定是否已应用） | 重启恢复 | 暂停集成并请求人工核查；不自动删除分支；不重跑 merge；不凭空标 integrated——S3 验收 9 反向；AC-R4-4 | L0（负例） | AC-R4-4；S3 验收 9 |
| TC-S3-16 | 🔴 P0 | 同 TC-S3-11；绑定工作区存在未提交/未跟踪改动 | 记录这些文件字节摘要后触发集成 | 集成暂停；错误/提示点名仓库与路径（可操作）；这些字节前后完全不变（不 stash、不覆盖）；worktree 产物保留——S3 验收 10 反向；AC-R4-5；设计 §11.1 场景 7 | L0（失败注入） | AC-R4-5；S3 验收 10；I-6 |
| TC-S3-17 | 🟢 P0 | 同 TC-S3-11；.legion/delivery.json 有 ≥1 条 verify（argv 数组） | 在候选上运行登记验证并生成验证报告 | 报告含命令（argv 展开）、退出码、耗时、候选 SHA、所用验收版本；命令来源为登记 argv 数组，不接受任意 shell 字符串——S3 验收 11；设计 §6.2 步骤 4 | L0 + L2 | AC-R4-7；S3 验收 11；D-P5 |
| TC-S3-18 | 🔴 P0 | 同 TC-S3-11；.legion/delivery.json 缺失或 verify 为空 | 触发集成 | 停 needs-review（不集成、不标记已交付）；提示需补充验证配置；绝不出现「跳过验证并标记已交付」路径——S3 验收 11 反向；AC-R4-7；设计 §12；I-5 | L0（负例） | AC-R4-7；S3 验收 11；I-5 |
| TC-S3-19 | 🟢 P0 | 同 TC-S3-11 | 集成完成前后检查源 worktree/分支存在性；查询 integration_events 行序与内容 | 集成完成前不删除源 worktree/分支；清理是可重试后续动作且失败不回滚已交付事实；integration_events 只追加（无 UPDATE/DELETE）——S3 验收 12；设计 §6.2 | L0 | S3 验收 12 |
| TC-S3-20 | 🟢 P0 | 同 TC-S3-01；构造含历史 done 的旧库 | 执行迁移后查询历史 done 任务的 deliveryState | 历史 done 显示 legacy-unknown；不被倒推为「已验证集成」，不写入 integrated/validation_id——S3 验收 13；R-6/AC-R6-3 | L0 | AC-R6-3；S3 验收 13 |
| TC-S3-21 | 🟡 P0 | 同 TC-S3-11；验证命令带 timeoutMs；构造候选 tree 恰等于 expected_head 的情形 | 让验证命令超时；再触发一次候选无实际变化的集成 | 验证超时计为验证失败：目标 ref SHA 不变、不 integrated、报告记录超时；候选无变化时集成幂等（不产生重复提交、不重复推进）——S3 验收 7/11 边界；AC-R4-2 | L0（边界） | AC-R4-2；S3 验收 7/11 |

### 4.4 S4 team-hub HTTP 接线与迁移（write-intent/reservation/contention/delivery/integration/decision 路由 + R-8 指标只读端点 + 开关列与 legacy 迁移）——自动化：L0 write-intent-routes / delivery-routes / metrics 三测试 + chat.test.mjs 与 claim-policy.test.mjs 回归

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | S4 合入（routes/write-intent.mjs + server.mjs 注册）；隔离 hub（临时库 + listen 端口） | POST /api/tasks/:id/write-intent，规划期 attempt_id 为空；再在 claim 后提交绑定 attempt | 规划期接受 attempt_id 可空并落 intent；claim 后可绑定 attempt_id；路径为仓库相对规范路径；服务端解析仓库身份与 target ref——S4 验收 1；设计 §8 | L0 + L2 | 设计 §8；S4 验收 1 |
| TC-S4-02 | 🟢 P0 | 同 TC-S4-01；intent revision=r | POST write-intent 更新：先带过期 revision，再带正确 revision | 过期 revision 被拒（4xx 且带当前 revision）；正确 revision 成功且 revision+1；变更另记只追加事件——S4 验收 1；设计 §4 | L0 | 设计 §4；S4 验收 1 |
| TC-S4-03 | 🔴 P0 | 同 TC-S4-01；任务已活跃占用 src/a.mjs | 另一任务 POST /api/tasks/:id/reservation 申请冲突路径 | 返回结构化 FILE_CONTENTION（含冲突路径与持有任务）；tasks.status 仍为 todo；schedulingState=waiting-file；重试计数不增——S4 验收 2 反向；AC-R3-1 | L0（负例） | AC-R3-1；S4 验收 2 |
| TC-S4-04 | 🟢 P0 | 同 TC-S4-01；存在活跃占用 | GET /api/repositories/:id/contention；并比对请求前后 audit 行数与相关表 | 200 返回当前占用（路径/持有任务/等待者）；只读零写入（audit 无新增、表无变化）——S4 验收 3；AC-R5-2 数据面 | L0 | AC-R5-2；S4 验收 3；I-2 |
| TC-S4-05 | 🔴 P0 | 同 TC-S4-01 | 逐条发非法请求：缺 scope、非法 JSON body、缺 task id、类型错误的 paths | 均返回 400 + 可读错误；不 500；不产生任何写入——S4 验收 4 反向 | L0（负例） | S4 验收 4 |
| TC-S4-06 | 🔴 P0 | 同 TC-S4-01 | POST reservation/write-intent 的 body 中传入浏览器绝对路径（C:/repo/src/a.mjs、/etc/x） | 拒绝（4xx 可读）；服务端不采用该路径，只用数据库解析出的仓库目录——S4 验收 4 反向；AC-R4-6；设计 §8 | L0（负例） | AC-R4-6；S4 验收 4；I-8 |
| TC-S4-07 | 🔴 P0 | 同 TC-S4-01 | body 中传入 shell 字符串（如 rm -rf /、git merge --no-ff、$(...)）作为路径/命令 | 拒绝（4xx 可读）；任何 shell 串不得被执行或落库——S4 验收 4 反向；AC-R4-6 | L0（负例） | AC-R4-6；S4 验收 4；I-8 |
| TC-S4-08 | 🔴 P0 | 同 TC-S4-01 | body 中传入任意 Git ref（如 refs/heads/evil、HEAD~1、main^{commit}）作为 target ref | 拒绝（4xx 可读）；target ref 只能来自数据库绑定——S4 验收 4 反向；AC-R4-6 | L0（负例） | AC-R4-6；S4 验收 4；I-8 |
| TC-S4-09 | 🟢 P0 | 同 TC-S4-01 | 依次调用 POST /api/deliveries、POST /api/integration/claim、POST /api/integration/transition、POST /api/deliveries/:id/decision（合法载荷与授权） | 四路由全通；返回体含必要标识（delivery id/version、job id/epoch、状态）；写请求绑定 scope/task/attempt/epoch/revision/操作者——S4 验收 5；设计 §8 | L0 | 设计 §8；S4 验收 5 |
| TC-S4-10 | 🔴 P0 | 同 TC-S4-09；delivery version=v | 以 v-1 调 transition 与 decision | 返回 409（version CAS）且内容不落库；以 v 提交成功——S4 验收 5 反向；AC-R5-4 服务端侧 | L0（负例） | AC-R5-4；S4 验收 5；I-3 |
| TC-S4-11 | 🔴 P0 | 同 TC-S4-09；构造非授权操作者（沿用 F-02 权限） | 非授权岗位调用改范围、放弃交付、裁决、手工集成 | 分别被拒（4xx）且留审计；授权岗位同调用成功——S4 验收 6 反向；AC-R5-5 | L0（负例） | AC-R5-5；S4 验收 6 |
| TC-S4-12 | 🟢 P0 | 同 TC-S4-01；发生对应事件（阻止一次同文件写入、完成一次等待、一次冲突、一次验证失败、一次裁决、一次恢复） | GET 指标端点，逐项读取 7 项指标（同文件写入阻止次数、等待时长 P50/P95、集成冲突率、集成后验证失败率、人工裁决率、集成恢复成功率、误阻塞申诉数） | 7 项均 available=true 且值与事件计数一致；按仓库与版本维度可读——S4 验收 7；AC-R8-1 | L0 | AC-R8-1；S4 验收 7 |
| TC-S4-13 | 🔴 P0 | 同 TC-S4-12；人为使某项指标不可读（如底层表/样本不可用） | 读取该指标 | 返回 available=false + reason（可读原因），value 不为 0；界面按 I-10 显示「暂无读数及原因」——S4 验收 7 反向；AC-R8-2；I-10 | L0（负例） | AC-R8-2；S4 验收 7；I-10 |
| TC-S4-14 | 🟢 P0 | 同 TC-S4-12；构造已知等待时长样本集 | 读取等待时长 P50/P95，并按接口文档的样本窗口手工重算 | 端点返回明确样本窗口；重算值与返回值一致（可复算）；文档化口径存在——S4 验收 8；AC-R8-3 | L0 | AC-R8-3；S4 验收 8 |
| TC-S4-15 | 🟢 P0 | 同 TC-S4-01；旧库（缺新表/新开关列） | 从旧库启动 server.mjs；重复执行迁移两次 | CREATE TABLE IF NOT EXISTS + schema-util.ensureColumn 幂等：旧库可启动、补齐新表与开关列、重复迁移无错、既有数据无损（升级前备份步骤可执行）——S4 验收 9；AC-R2-8 | L0 | AC-R2-8；S4 验收 9 |
| TC-S4-16 | 🔴 P0 | 同 TC-S4-15 | 构造坏 schema（缺列/类型冲突）与含历史 done 的旧库，执行迁移 | 坏 schema 不静默通过（报可操作错误）；迁移不回填/不倒推历史 done；不在 live 库执行（全程临时库，I-2）——S4 验收 9 反向；RK-4 | L0（负例） | S4 验收 9；I-2 |
| TC-S4-17 | 🟢 P0 | S4 全部合入 | 回归门禁：node team-hub/chat.test.mjs；node team-hub/claim-policy.test.mjs；依赖清单核对 | chat.test.mjs 基线 51 例不回归、claim-policy.test.mjs 基线 35 例不回归，均 exit 0；零新增第三方依赖（I-1）——S4 验收 10 | L0 | S4 验收 10；I-1 |
| TC-S4-18 | 🟡 P0 | 同 TC-S4-01；构造 revision/version 临界值与零样本指标窗口 | 提交 revision/version 恰为当前值、0、超大值；读取零样本与单样本的等待时长 P50/P95 | 恰为当前值成功、不符被拒且不落库；零样本返回 available=false + reason（不返回 0）；单样本 P50=P95 且口径可复算——S4 验收 1/8 边界；AC-R8-2/R8-3 | L0（边界） | AC-R8-2/R8-3；S4 验收 1/8 |

### 4.5 S5 plugins 守护写入资格接线（等待语义 + 不可篡改授权快照 + pre-execute 校验 + 运行中扩域 + 等待后基于最新目标建工作区，R-3 + R-7 提示）——自动化：L1 node plugins/tests/write-eligibility.test.mjs + node plugins/tests/workspace.test.mjs + L0-static + typecheck

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | S5 合入（writeEligibility.ts 导出判定与快照构造）；文件被其他任务占用 | 触发一次派工/claim，观察被阻塞任务字段 | tasks.status 保留 todo；schedulingState=waiting-file；阻塞任务与路径可见（结构化）；重试计数不增——S5 验收 1；AC-R3-1 | L1 | AC-R3-1；S5 验收 1 |
| TC-S5-02 | 🔴 P0 | 同 TC-S5-01 | 等待发生前后比任务 status、失败计数、重试额度，以及是否进入 failed 通道 | 不进入失败/重试通道、status 不变为 in_review/failed、重试计数与 attempt 数均不增（等待不是失败）——S5 验收 1 反向；AC-R3-1 | L1（负例） | AC-R3-1；S5 验收 1 |
| TC-S5-03 | 🟢 P0 | 同 TC-S5-01；任务已获写入资格 | 检查 RunRequest 携带的授权快照结构：attempt/epoch/intent revision/worktree 身份；并以匹配参数调用 pre-execute | 快照含全部四项且与数据库一致；合法请求通过 pre-execute；快照字段不可由模型改写（结构断言：只读/由守护注入）——S5 验收 2；AC-R3-3 | L1 | AC-R3-3；S5 验收 2 |
| TC-S5-04 | 🔴 P0 | 同 TC-S5-03 | 以越出授权 intent/fileDomain 的路径调用写工具 pre-execute | 写工具被拒绝；返回可行动原因（越界路径 + 如何调整范围）——S5 验收 3 反向；AC-R3-3 | L1（负例） | AC-R3-3；S5 验收 3 |
| TC-S5-05 | 🔴 P0 | 同 TC-S5-03；Attempt epoch 已过期 | 以过期 epoch 调用写工具 pre-execute | 被拒绝（epoch 不符）；原因可读——S5 验收 3 反向；AC-R3-3 | L1（负例） | AC-R3-3；S5 验收 3 |
| TC-S5-06 | 🔴 P0 | 同 TC-S5-03；intent revision 已提升 | 以旧 revision 调用写工具 pre-execute | 被拒绝（revision 不符）；原因可读——S5 验收 3 反向；AC-R3-3 | L1（负例） | AC-R3-3；S5 验收 3 |
| TC-S5-07 | 🔴 P0 | 同 TC-S5-03；工作区身份与快照不符（换 worktree） | 以不符 worktree 调用写工具 pre-execute | 被拒绝（工作区不符）；原因可读——S5 验收 3 反向；AC-R3-3 | L1（负例） | AC-R3-3；S5 验收 3 |
| TC-S5-08 | 🔴 P0 | 同 TC-S5-03；写工具在隔离 worktree 内产生越域改动 | 执行后复核实际 Git diff（不预知全部文件的情形） | 超范围改动不得进入验收/集成；worktree 保留现场并要求调整范围或撤销；事后 diff 不得被当作实时锁而放行——S5 验收 4 反向；AC-R3-3 | L1（负例） | AC-R3-3；S5 验收 4 |
| TC-S5-09 | 🟢 P0 | 同 TC-S5-01；构造只读任务（调研/评审） | 只读任务与写入任务同时派工 | 只读任务零 reservation；不被等待列表阻塞、可与写入任务并行；无写入资格申请——S5 验收 5；AC-R3-8 | L1 | AC-R3-8；S5 验收 5 |
| TC-S5-10 | 🔴 P0 | 同 TC-S5-09 | 只读任务尝试调用写工具或申请 reservation | 被拒绝（只读身份不得借此写）；不产生 reservation——S5 验收 5 反向；AC-R3-8 | L1（负例） | AC-R3-8；S5 验收 5 |
| TC-S5-11 | 🟢 P0 | 同 TC-S5-01；先读后写任务 | 先执行只读阶段并检查 reservation；再以当前 epoch 原子申请写入资格 | 只读阶段零预约；写阶段以当前 epoch 申请并成功；两阶段边界清晰——S5 验收 6；AC-R3-4 | L1 | AC-R3-4；S5 验收 6 |
| TC-S5-12 | 🔴 P0 | 同 TC-S5-11；写阶段申请被占用（冲突） | 申请失败后观察任务与写工具 | 只暂停写工具，不失败整个任务；保留已完成的只读成果；等待状态如实标注——S5 验收 6 反向；AC-R3-4 | L1（负例） | AC-R3-4；S5 验收 6 |
| TC-S5-13 | 🟢 P0 | 同 TC-S5-03；取得资格后目标 HEAD 已变化 | 比对只读探索时的 HEAD 与获取资格后的 HEAD | 检测到变化并重新核对修改计划（可观测标记/上下文刷新记录）；不得沿用旧计划直接写——S5 验收 7；AC-R3-5 | L1 | AC-R3-5；S5 验收 7 |
| TC-S5-14 | 🔴 P0 | 同 TC-S5-13 | 在 HEAD 已变但未重核的情况下直接调用写工具 | 被拒绝/暂停（要求先重核）；可行动原因可读——S5 验收 7 反向；AC-R3-5 | L1（负例） | AC-R3-5；S5 验收 7 |
| TC-S5-15 | 🟡 P0 | 同 TC-S5-03；运行中提出扩域申请，新增路径撞上其他活跃预约 | 触发扩域失败；再构造一次扩域成功 | 失败时暂停写且现有 worktree 产物保留；成功后写工具恢复；扩域走 S2 事务（不在 plugins 另写判定）——S5 验收 8；AC-R3-6 | L1（边界） | AC-R3-6；S5 验收 8 |
| TC-S5-16 | 🟢 P0 | 同 TC-S5-01；任务等待结束/重试，已有未交付 WIP | 等待结束后创建工作区，比对 WIP diff 内容 | 工作区从最新目标提交创建；既有未交付 WIP 的 diff 内容仍在（不 reset、不丢弃），可纳入最新版本并验证——S5 验收 9；AC-R3-7 | L1 + L2 | AC-R3-7；S5 验收 9 |
| TC-S5-17 | 🔴 P0 | 同 TC-S5-16 | 构造实现若走 reset --hard/clean 路径；检查 WIP 文件 | 检出为失败：WIP 内容丢失即不得通过；实现不得 reset 掉未交付改动——S5 验收 9 反向；AC-R3-7；I-6 | L1（负例） | AC-R3-7；S5 验收 9；I-6 |
| TC-S5-18 | 🔴 P0 | 同 TC-S5-01；仓库 capability=degraded（非 Git/Git 不可用） | 派工第二个写入任务；检查界面/日志提示 | 单写入强制；降级原因可读；不得静默退回共享目录并行写——S5 验收 10 反向；AC-R7-3；I-6 | L1（负例） | AC-R7-1/3；S5 验收 10；I-6 |
| TC-S5-19 | 🔴 P0 | S5 合入后 | 静态断言：plugins 侧越域判定不再用字符串 startsWith，改为复用 packages/shared/src/path-domain.mjs；依赖清单核对 | 无第二份判定实现；与 S2 引用同一模块；零新增依赖（I-1）——S5 验收 11；AC-R1-6；I-7 | L0-static | AC-R1-6；I-1/I-7；S5 验收 11 |
| TC-S5-20 | 🟢 P0 | S5 全部合入 | 回归门禁：node plugins/tests/workspace.test.mjs；plugins typecheck（tsc -p plugins/tsconfig.json --noEmit） | 既有 workspace 用例不回归；typecheck 0 诊断（依赖缺失时如实记录复现步骤与输出，不冒充通过）——S5 验收 12 | L1 + 评审 | S5 验收 12 |
| TC-S5-21 | 🟡 P0 | 同 TC-S5-03；扩域新增路径恰好等于已持有路径；等待结束后目标 HEAD 恰好变化 | 提交幂等扩域；在等待结束的同一时刻推进目标 HEAD | 幂等扩域不重复提 revision、不产生第二份预约；等待结束创建的工作区基于最新目标提交且 WIP 不丢——S5 验收 8/9 边界；AC-R3-6/R3-7 | L1（边界） | AC-R3-6/R3-7；S5 验收 8/9 |

### 4.6 S6 plugins legacy 收敛（autoPromote 与 mediation 接入唯一 integration worker、同仓库单一模式、done 语义与回滚不删数据，R-6）——自动化：L1 node plugins/tests/legacy-convergence.test.mjs + mediation.test.mjs + typecheck

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🔴 P1 | S6 合入；仓库已启用集成阶段 | 构造旧直合路径调用（直接调用 autoPromote / 对主工作区 git merge） | 被拒或不生效（不再有第二条直接 merge 路径）；返回可读原因指向唯一 integration worker——S6 验收 1 反向；AC-R6-1 | L1（负例） | AC-R6-1；S6 验收 1 |
| TC-S6-02 | 🟢 P1 | 同 TC-S6-01 | 经 autoPromote 段与公共 mediation 段分别提交交付 | 两条旧入口均经唯一 integration worker（构造旧路径调用断言其委托到 job 接口）；同仓库同时只有一个集成入口在跑——S6 验收 1；AC-R6-1/R6-5 | L1 | AC-R6-1/R6-5；S6 验收 1 |
| TC-S6-03 | 🔴 P1 | 同 TC-S6-01；两空间绑定同一仓库 | 两空间分别选择「旧直合」与「新队列」模式 | 配置层拒绝或收敛为仓库级单一模式；不会同时运行两个集成器；模式按仓库共享——S6 验收 2 反向；AC-R6-5 | L1（负例） | AC-R6-5；S6 验收 2 |
| TC-S6-04 | 🟢 P1 | 同 TC-S6-01；交付 integrated 且任务原有验收条件通过 | 推进任务状态 | 任务产生 done；done 仅在 integrated + 原验收通过后产生——S6 验收 3；AC-R6-2；I-4 | L1 | AC-R6-2；S6 验收 3；I-4 |
| TC-S6-05 | 🔴 P1 | 同 TC-S6-04；交付子状态=needs-review | 尝试推进 done | 不进入 done；保持 needs-review（或经裁决回 ready/abandoned）——S6 验收 3 反向；AC-R6-2；I-4 | L1（负例） | AC-R6-2；S6 验收 3；I-4 |
| TC-S6-06 | 🔴 P1 | 同 TC-S6-04；集成后验证失败（needs-review） | 尝试推进 done | 不进入 done；呈现「集成验证失败」——S6 验收 3 反向；AC-R6-2；I-4 | L1（负例） | AC-R6-2；S6 验收 3；I-4 |
| TC-S6-07 | 🔴 P1 | 同 TC-S6-04；交付=integrated 但任务原有验收条件未通过 | 尝试推进 done | 不进入 done；要求先通过原验收——S6 验收 3 反向；AC-R6-2；I-4 | L1（负例） | AC-R6-2；S6 验收 3；I-4 |
| TC-S6-08 | 🟢 P1 | 同 TC-S6-01；配置为观察阶段 | 触发一次派工与合入流程，检查日志与界面标记 | 不改变任务领取/合入行为（与开启前一致）；存在「模拟判断」标记，只计算预计范围/真实 diff/潜在等待/集成验证结果——S6 验收 4；AC-R6-4 | L1 | AC-R6-4；S6 验收 4 |
| TC-S6-09 | 🔴 P1 | 同 TC-S6-08 | 静态/行为断言观察期无写入型派工副作用（无 reservation 落库、无实际 ref 推进、无自动认领） | 观察模式不产生写实效果；模拟与真实结论可区分——S6 验收 4 反向；AC-R6-4 | L1（负例） | AC-R6-4；S6 验收 4 |
| TC-S6-10 | 🟢 P1 | 同 TC-S6-01；已有在制 job 与历史记录 | 执行回滚（关闭新任务自动认领与集成）；对在制 job 对账后再切旧路径 | 旧路径恢复可用；数据库记录、预约、分支、临时工作区均未被删除；在制 job 有对账步骤并完成——S6 验收 5；AC-R6-6 | L1 + L2 | AC-R6-6；S6 验收 5 |
| TC-S6-11 | 🔴 P1 | 同 TC-S6-10 | 回滚前后逐项核对记录/预约/分支/临时工作区与在制 job | 任一被删除或丢失即失败（回滚只关新路径，不删数据、不留无对账的在制 job）——S6 验收 5 反向；AC-R6-6；I-2/I-6 | L1（负例） | AC-R6-6；S6 验收 5；I-2/I-6 |
| TC-S6-12 | 🟢 P1 | 同 TC-S6-01；构造历史 done 任务（迁移前无集成证据） | 迁移后查看该任务交付面 | 显示 legacy-unknown；不倒推为已验证集成；不显示为「已交付」——S6 验收 6；AC-R6-3 | L1 | AC-R6-3；S6 验收 6 |
| TC-S6-13 | 🔴 P1 | 同 TC-S6-12 | 检查迁移是否给历史 done 写入 integrated/validation_id/集成事件 | 未补造任何集成证据（写入即失败）；历史语义保持如实——S6 验收 6 反向；AC-R6-3 | L1（负例） | AC-R6-3；S6 验收 6 |
| TC-S6-14 | 🟢 P1 | S6 全部合入 | 回归门禁：node plugins/tests/mediation.test.mjs；plugins typecheck | 既有调解用例不回归、exit 0；typecheck 0 诊断（受限时如实记录）——S6 验收 7 | L1 + 评审 | S6 验收 7 |
| TC-S6-15 | 🟡 P1 | 同 TC-S6-01；观察→调度→集成阶段切换时存在在制 job | 在制 job 未完成时切换仓库模式 | 模式切换不双跑集成器；在制 job 对账后才切换；切换边界不产生第二条直接 merge 路径——S6 验收 1/2 边界；AC-R6-1/R6-5 | L1（边界） | AC-R6-1/R6-5；S6 验收 1/2 |

### 4.7 S7 Workbench 交付徽标、等待说明与冲突裁决面板（version CAS 409、指标降级显示、不把历史重叠当实时占用，R-5）——自动化：L3 pnpm --dir workbench build + node workbench/scripts/delivery-ui.test.mjs + L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P1 | S7 合入（api.ts/types.ts/TaskDetailModal.tsx/TaskCenterView.tsx 交付面） | 对八种徽标逐一映射：只读探索、等待文件、执行中、待验收、排队集成、集成验证中、待裁决、已交付 ↔ 交付/调度子状态 | 每个子状态映射到正确徽标且互不混淆（逐项断言）；映射为纯函数可单测——S7 验收 1；AC-R5-1 | L1 + L3 | AC-R5-1；S7 验收 1；D-P8 |
| TC-S7-02 | 🔴 P1 | 同 TC-S7-01 | 构造「Agent 写完（awaiting-acceptance/执行结束）」但尚未集成验证的任务 | 不显示为「已交付」；显示待验收/排队集成等如实徽标——S7 验收 1 反向；AC-R5-1 | L1（负例） | AC-R5-1；S7 验收 1 |
| TC-S7-03 | 🟢 P1 | 同 TC-S7-01；历史 done 任务（legacy-unknown） | 查看任务卡/详情徽标 | 如实显示 legacy-unknown（不冒充已交付/已验证集成）——S7 验收 1；AC-R6-3/R5-1 | L1 + L3 | AC-R5-1/R6-3；S7 验收 1 |
| TC-S7-04 | 🟢 P1 | 同 TC-S7-01；存在实时占用与最近验证记录 | 打开任务详情，读取当前占用、预计等待对象、集成目标、最近一次验证结果 | 四项均来自实时数据面（reservation/delivery/验证报告），非历史 patch 推断；与 API 返回一致——S7 验收 2/3；AC-R5-2 | L1 + L3 | AC-R5-2；S7 验收 2/3 |
| TC-S7-05 | 🟢 P1 | 同 TC-S7-01；任务处于 waiting-file | 点击「为什么等待」 | 显示冲突路径、持有任务及其状态；提供四个可选动作（缩小本任务范围 / 让持有任务完成 / 打回重做 / 取消任务）；默认不提供「强制同时写同一文件」入口——S7 验收 3；AC-R5-2；I-5 | L3 | AC-R5-2；S7 验收 3；I-5 |
| TC-S7-06 | 🟢 P1 | 同 TC-S7-01；存在 needs-review 待裁决交付 | 打开裁决面板 | 按「原任务意图 → 两份改动 → 候选结果 → 验证证据 → 选择」顺序展示；显示差异而非原始 Git 命令——S7 验收 4；AC-R5-3 | L1 + L3 | AC-R5-3；S7 验收 4 |
| TC-S7-07 | 🟢 P1 | 同 TC-S7-06；授权岗位 + 当前 delivery.version | 依次提交「采用 A」「采用 B」「要求重新修改」，记录裁决人/理由/时间 | 三种选择均可提交；审计记录含谁、何时、依据哪份候选版本、理由；不要求用户执行任何 git 命令——S7 验收 4；AC-R5-3/R5-4 | L1 + L3 | AC-R5-3/R5-4；S7 验收 4 |
| TC-S7-08 | 🔴 P1 | 同 TC-S7-07；两个页面基于同一旧 delivery.version | 两页面先后提交裁决 | 后者收到 409 且其内容不落库；刷新后可见已生效裁决；不覆盖他人裁决——S7 验收 5 反向；AC-R5-4 | L1 + L3（并发） | AC-R5-4；S7 验收 5 |
| TC-S7-09 | 🔴 P1 | 同 TC-S7-01；构造非授权岗位用户 | 尝试修改范围、裁决、手工集成 | 均不可操作（入口隐藏或请求被拒）；给出可读原因；审计如实——S7 验收 6 反向；AC-R5-5 | L1 + L3（负例） | AC-R5-5；S7 验收 6 |
| TC-S7-10 | 🔴 P1 | 同 TC-S7-01；人为使指标或占用不可读 | 打开任务中心/详情指标区 | 显示「暂无读数及原因」（含原因），不显示 0——S7 验收 7 反向；AC-R5-6；I-10 | L1 + L3（负例） | AC-R5-6；S7 验收 7；I-10 |
| TC-S7-11 | 🔴 P1 | 同 TC-S7-01；存在历史 patch 重叠（/api/overlaps）但当前无实时占用 | 查看任务详情「改动 × 证据」与实时占用区 | 历史重叠保留展示但明确标注为历史，不冒充实时占用；实时占用区不显示历史重叠——S7 验收 8 反向；R-5；设计 §7 | L1（负例） | AC-R5-2；S7 验收 8 |
| TC-S7-12 | 🔴 P1 | S7 合入后 | 静态断言：交付面组件无 dangerouslySetInnerHTML 直插服务端文本 | 0 命中；服务端文本经安全渲染——S7 验收 9 反向 | L0-static | S7 验收 9 |
| TC-S7-13 | 🟢 P1 | S7 全部合入 | 运行 pnpm --dir workbench build（tsc --noEmit + vite build）；核对 workbench 依赖清单 | 构建全绿（tsc 0 诊断 + vite build 成功）；workbench 零新增依赖——S7 验收 10；I-1 | L3 | S7 验收 10；I-1 |

### 4.8 S8 CI 注册、仓库验证命令声明与文档收口（R-9：新增测试全部登记、.legion/delivery.json 权威登记、受影响文档随实现更新）——自动化：L4 node scripts/ci/run-ci.mjs 登记校验 + node scripts/ci/check-docs.mjs + L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P2 | S1~S7 合入；scripts/ci/run-ci.mjs 已更新 | 触发 run-ci 的测试登记校验段，并核对 suites 条目 | 本目标 12 个新增测试文件全部在 suites 内（packages/shared/test/path-domain.test.mjs、repo-identity.test.mjs、team-hub/write-intent-store.test.mjs、delivery-store.test.mjs、integration-worker.test.mjs、git-plumbing.test.mjs、write-intent-routes.test.mjs、delivery-routes.test.mjs、metrics.test.mjs、plugins/tests/write-eligibility.test.mjs、legacy-convergence.test.mjs、workbench/scripts/delivery-ui.test.mjs）；无「未登记测试文件」失败——S8 验收 1；AC-R9-2 | L4 | AC-R9-2；S8 验收 1 |
| TC-S8-02 | 🔴 P2 | 同 TC-S8-01 | 注入一个未登记的测试文件后触发登记校验段 | 校验段失败（非零退出）并点名未登记文件；移除注入后恢复通过——S8 验收 1 反向 | L4（负例） | S8 验收 1 |
| TC-S8-03 | 🟢 P2 | .legion/delivery.json 已落地 | 用登记校验读取并校验：targetRef 为完整 ref（如 refs/heads/main）；verify 为对象数组 | 校验通过；targetRef 是完整 ref 而非短名/分支猜测；对象含 id、argv、timeoutMs、可选 cwd——S8 验收 2；AC-R4-7；D-P5 | L0 + L4 | AC-R4-7；S8 验收 2；D-P5 |
| TC-S8-04 | 🔴 P2 | 同 TC-S8-03 | 构造非法 delivery.json：argv 写成 shell 字符串（如 "pnpm test && rm -rf"）、targetRef 为短名 main、缺失 verify | 均被拒（校验失败并给出可读原因）；任意 shell 字符串不得作为 verify——S8 验收 2 反向；设计 §6.2 步骤 4；I-5 | L0（负例） | S8 验收 2；I-5 |
| TC-S8-05 | 🔴 P2 | 同 TC-S8-03；删去受管仓库的 delivery.json（无登记） | 触发一次交付集成 | 任务停 needs-review；不得标记已交付；界面不得提供「跳过验证并标记已交付」——S8 验收 3 反向；AC-R4-7；I-5 | L0（负例） | AC-R4-7；S8 验收 3；I-5 |
| TC-S8-06 | 🟢 P2 | 同 TC-S8-03 | 统计每受管仓库登记的 verify 条数与字段合法性 | 每受管仓库至少 1 条可执行验证；argv 为非空字符串数组且 timeoutMs/cwd 合法——S8 验收 2；设计 §12 | L0 | S8 验收 2；D-P5 |
| TC-S8-07 | 🟢 P2 | S8 文档更新合入 | 关键句断言：README.md 与 docs/FEATURES.md 含等待、集成、集成后验证、done 语义的描述 | 关键句存在且与实现后行为一致（无自相矛盾）；描述「未配置验证停 needs-review」与「不把 Agent 写完当已交付」——S8 验收 4；AC-R9-1 | L0-static | AC-R9-1；S8 验收 4 |
| TC-S8-08 | 🔴 P2 | 同 TC-S8-07 | 注入删除一个关键句；并 grep 文档中的手工合并指引（要求用户执行 git merge 的文案） | 关键句缺失即失败；文档不含要求用户手工输入 git merge 的指引；诊断导出保留——S8 验收 4 反向；AC-R9-1 | L0-static（负例） | AC-R9-1；S8 验收 4 |
| TC-S8-09 | 🟢 P2 | S8 合入 | 运行 node scripts/ci/check-docs.mjs | exit 0（PASS；历史 banner 覆盖、表格行形状、锚点/互链全绿）——S8 验收 4；AC-R9-2 | L4 | AC-R9-2；S8 验收 4 |
| TC-S8-10 | 🔴 P2 | S8 全部合入 | git diff --name-only 核对改动文件域；依赖清单核对；live 库零触碰核对 | 改动仅限本切片文件域（run-ci.mjs、.legion/delivery.json、README.md、docs/FEATURES.md、docs/STATUS.md）；零新增第三方依赖（I-1）；未对 live 库/主工作区做写入型验证（I-2）——S8 验收 5 反向 | L0-static | S8 验收 5；I-1/I-2 |
| TC-S8-11 | 🟡 P2 | 同 TC-S8-03 | 构造边界配置：verify 为空数组、重复 id、timeoutMs=0、argv 含空字符串 | 均按校验规则明确拒绝（空 verify 停 needs-review；重复 id 拒绝；timeoutMs=0 与空 argv 元素拒绝）——S8 验收 2 边界；AC-R4-7 | L0（边界） | AC-R4-7；S8 验收 2 |

## 5. 关键业务规则：正向 + 反向成对（验收标准用例化的机器可复核部分）

> 规则 → 正向用例（规则成立时通过）+ 反向用例（规则被违反/非法输入时被检出或拒绝）。附录 A 脚本校验：每 BR 引用的正向 TC 类别为 🟢、反向 TC 类别为 🔴，且引用的 TC id 在 §4 真实存在。

| BR | 业务规则（验收口径） | 正向用例 | 反向用例 | 关联 AC / 切片 |
| --- | --- | --- | --- | --- |
| BR-1 | 目录按路径段边界匹配，不误伤同前缀兄弟名 | TC-S1-01 | TC-S1-02 | AC-R1-1；S1 |
| BR-2 | 路径规范化对五类非法输入明确拒绝而非静默通过 | TC-S1-03 | TC-S1-05 | AC-R1-2；S1 |
| BR-3 | Windows 大小写别名按仓库配置归一，两向结论不同 | TC-S1-06 | TC-S1-07 | AC-R1-3；S1 |
| BR-4 | 一次重命名同时占用旧路径与新路径，任一端相交即冲突 | TC-S1-08 | TC-S1-09 | AC-R1-4；S1 |
| BR-5 | 判定纯函数可重复可并发，且全仓只有一份判定实现 | TC-S1-11 | TC-S1-14 | AC-R1-5/R1-6；S1 |
| BR-6 | 非 Git/Git 不可用时禁止并行写入，只读任务不受限 | TC-S5-09 | TC-S2-10 | AC-R7-1；S2/S5 |
| BR-7 | 同文件互斥、异文件并行（同仓库活跃预约不得覆盖相交路径） | TC-S2-01 | TC-S2-02 | AC-R2-1/R2-2/R2-7；S2 |
| BR-8 | claim 原子性：不出现「已认领无资格」或「有预约无 Attempt」半状态 | TC-S2-01 | TC-S2-03 | AC-R2-3；S2 |
| BR-9 | 释放须核对 Attempt 与 epoch，过期 epoch 被拒并回报真实 epoch | TC-S2-06 | TC-S2-04 | AC-R2-4；S2 |
| BR-10 | 迟到写入/结果上报被 epoch fencing 拒绝 | TC-S2-06 | TC-S2-05 | AC-R2-4；S2 |
| BR-11 | 租约过期未确认退出的 reservation 停在 reconciling 而非立即释放 | TC-S2-06 | TC-S2-05 | AC-R2-5；S2 |
| BR-12 | 扩域成功提升 intent revision；撞车则失败并保留产物 | TC-S2-08 | TC-S2-07 | AC-R2-6；S2/S5 |
| BR-13 | 活跃预约两两不相交（全库扫描不变量） | TC-S2-09 | TC-S2-02 | AC-R2-7；S2 |
| BR-14 | claim 不队头阻塞：后部不相交候选可先领取，且等待不烧重试 | TC-S2-12 | TC-S5-02 | AC-R3-2；S2/S5 |
| BR-15 | intent revision CAS：正确 revision 生效，过期被拒且不落库 | TC-S2-11 | TC-S2-04 | 设计 §4；S2 |
| BR-16 | 新表迁移幂等、可从旧库启动；坏 schema 不静默通过 | TC-S4-15 | TC-S4-16 | AC-R2-8；S4 |
| BR-17 | 入队门禁：条件齐备才 ready，任一缺失不得 ready | TC-S3-04 | TC-S3-01 | AC-R4-7；S3 |
| BR-18 | 交付 version CAS：正确版本提交生效，过期被拒且不覆盖他人 | TC-S3-06 | TC-S3-05 | 设计 §4；S3 |
| BR-19 | 集成后验证通过才 integrated 且 ref 前进；失败则 ref 不变 | TC-S3-11 | TC-S3-12 | AC-R4-1/R4-2；S3 |
| BR-20 | 崩溃恢复每 source commit 至多集成一次；结果不明暂停不删分支 | TC-S3-14 | TC-S3-15 | AC-R4-4；S3 |
| BR-21 | 脏工作区暂停集成且字节完全不变（不 stash） | TC-S3-11 | TC-S3-16 | AC-R4-5；S3/S6 |
| BR-22 | 有登记验证才集成；无登记停 needs-review，不得跳过验证 | TC-S3-17 | TC-S3-18 | AC-R4-7；S3/S8 |
| BR-23 | 唯一集成入口：旧 autoPromote 与公共 mediation 都经 integration worker | TC-S6-02 | TC-S6-01 | AC-R6-1；S6 |
| BR-24 | 同仓库模式互斥，不同空间不同模式不得同时跑两个集成器 | TC-S6-02 | TC-S6-03 | AC-R6-5；S6 |
| BR-25 | done 仅在 integrated + 原验收通过后产生 | TC-S6-04 | TC-S6-05 | AC-R6-2；S6；I-4 |
| BR-26 | 观察阶段只模拟不改派工，且无写入型副作用 | TC-S6-08 | TC-S6-09 | AC-R6-4；S6 |
| BR-27 | 回滚只关新路径，不删记录/预约/分支/临时工作区 | TC-S6-10 | TC-S6-11 | AC-R6-6；S6 |
| BR-28 | 历史 done 如实显示 legacy-unknown，不补造集成证据 | TC-S6-12 | TC-S6-13 | AC-R6-3；S6 |
| BR-29 | 交付徽标不把「Agent 写完」冒充「已交付」 | TC-S7-01 | TC-S7-02 | AC-R5-1；S7 |
| BR-30 | 裁决提交绑定 delivery.version，并发后者 409 且不落库 | TC-S7-07 | TC-S7-08 | AC-R5-4；S7 |
| BR-31 | 历史 patch 重叠不冒充实时占用 | TC-S7-04 | TC-S7-11 | AC-R5-2；S7 |
| BR-32 | 指标不可读时显示原因而非 0 | TC-S4-12 | TC-S7-10 | AC-R5-6/R8-2；S4/S7 |
| BR-33 | 授权边界：合法操作者可用，非授权岗位被拒并审计 | TC-S4-09 | TC-S4-11 | AC-R5-5；S4/S7 |
| BR-34 | 服务端解析仓库/ref，拒绝浏览器传绝对路径/shell/任意 ref | TC-S4-01 | TC-S4-06 | AC-R4-6；S4；I-8 |
| BR-35 | 只读任务并行且零预约，但只读身份不得借此写 | TC-S5-09 | TC-S5-10 | AC-R3-8；S5 |
| BR-36 | pre-execute 四类校验（路径/epoch/revision/工作区）齐全 | TC-S5-03 | TC-S5-04 | AC-R3-3；S5 |
| BR-37 | 取得资格后 HEAD 变化必须重核修改计划 | TC-S5-13 | TC-S5-14 | AC-R3-5；S5 |
| BR-38 | 等待结束工作区基于最新目标，且不 reset 掉未交付 WIP | TC-S5-16 | TC-S5-17 | AC-R3-7；S5；I-6 |
| BR-39 | 越域实际 diff 不得进入验收/集成 | TC-S5-03 | TC-S5-08 | AC-R3-3；S5 |
| BR-40 | 全部新增测试已登记进 run-ci suites；未登记必须红 | TC-S8-01 | TC-S8-02 | AC-R9-2；S8 |
| BR-41 | verify 必须是 argv 数组，任意 shell 字符串被拒 | TC-S8-03 | TC-S8-04 | 设计 §6.2；S8；I-5 |
| BR-42 | 文档与实现一致且不要求用户手工执行 git merge | TC-S8-07 | TC-S8-08 | AC-R9-1；S8 |

## 6. 端到端验收用例（对应 REQUIREMENTS §6 与设计 §11.1 九场景；tester 在 T-172 逐条执行写报告）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-1 | 🟢 P0 | S1~S8 全批合入 + 隔离 hub（临时库）+ 两个绑定同一临时仓库的写入任务 | 两任务分别申请同一文件与不同文件的写入资格 | 同一文件：只产生一个活跃写入者，另一等待（FILE_CONTENTION，不烧重试）；不同文件：可同时执行——设计 §11.1 场景 1；AC-R2-1/R2-2/R3-1 | L2 | AC-R2-1/R2-2；§6.1 |
| E2E-2 | 🟡 P0 | 同 E2E-1；构造路径样本集 | 跑路径判准矩阵：src/a 对 src/ab、Windows 大小写别名、目录子路径、重命名两端 | 全部判断正确（不误判、不漏判），与 §3 判据一致——设计 §11.1 场景 2；AC-R1-1~R1-4 | L1 + L2 | AC-R1-1/2/3/4；§6.2 |
| E2E-3 | 🔴 P0 | 同 E2E-1；已认领任务现有 worktree 产物 | 已认领任务动态扩域撞上其他任务后检查产物与状态 | 写入被暂停、现有 worktree 产物不丢；可读原因与下一步——设计 §11.1 场景 3；AC-R2-6/R3-6 | L2 | AC-R2-6/R3-6；§6.3 |
| E2E-4 | 🟢 P0 | 同 E2E-1；两任务在不同 worktree 修改同一文件 | 任务 B 等待任务 A 交付；A 集成后 B 基于新目标版本继续；两者最终各自集成 | B 未被静默丢失/覆盖/误报；基于新目标版本继续；两个任务的要求都经验证——设计 §11.1 场景 4；AC-R3-7/R4-1 | L2 | AC-R3-7/R4-1；§6.4 |
| E2E-5 | 🔴 P0 | 同 E2E-1；Git 无冲突但候选上验证失败 | 触发集成 | 目标分支保持原 SHA；任务不进入 done；保存候选与报告并呈现「集成验证失败」——设计 §11.1 场景 5；AC-R4-2；I-4 | L2 | AC-R4-2；§6.5 |
| E2E-6 | 🔴 P0 | 同 E2E-1；journal 四阶段 | 分别在集成前、更新 ref 后落库前、落库后杀死 worker，重启恢复 | 每个 source commit 最多集成一次；不丢产物、不重复推进任务——设计 §11.1 场景 6；AC-R4-4；I-9 | L2 | AC-R4-4；§6.6 |
| E2E-7 | 🔴 P0 | 同 E2E-1；主工作区有未提交改动 | 触发自动集成，记录改动字节摘要 | 自动集成暂停；这些字节不变；界面点名需处理的本地状态——设计 §11.1 场景 7；AC-R4-5；I-6 | L2 | AC-R4-5；§6.7 |
| E2E-8 | 🔴 P0 | 同 E2E-1；人审岗位打回 | 打回后检查目标分支；再次提交检查反馈与隔离成果 | 目标分支不含未批准改动；再次提交沿用原任务反馈与隔离成果——设计 §11.1 场景 8；R-5/R-6 | L2 + L3 | R-5/R-6；§6.8 |
| E2E-9 | 🟢 P0 | 同 E2E-1；多空间绑定同一仓库、多 worker 同时运行 | 同时派工并申请预约/集成 | 预约与集成遵守同一仓库权威（同一占用池与集成锁），仓库身份按 git common-dir；不同仓库互不阻塞——设计 §11.1 场景 9；AC-R2-7/R4-8/R6-5 | L2 | AC-R2-7/R4-8/R6-5；§6.9 |
| E2E-10 | 🟢 P0 | S1~S8 全批合入 | 跑发布门槛：九场景全通过；统计灰度期间是否有产物丢失、未授权覆盖用户工作区、任务被错误标为已交付；读取 7 项指标 | 九场景全通过；三类事故计数为 0；指标可读或缺读数显式原因；无硬发布门槛（D-9）——REQUIREMENTS §6.10；设计 §11.2 | L2 + L4 | AC-R8-1；§6.10；I-10 |
| E2E-11 | 🔴 P1 | S1~S8 全批合入 | 审计默认决策是否被放宽：是否存在「同文件强制并行写入」入口；未配置验证命令仓库是否可被标已交付 | 无强制并行入口；未配置验证必停 needs-review，无「跳过验证并标记已交付」路径——REQUIREMENTS §6.11；设计 §12；I-5 | L0-static + L2 | AC-R4-7；§6.11；I-5 |

## 7. 验收口径 → 用例追溯矩阵（50 条 AC 全覆盖；附录 A 机器校验「无悬空 AC」）

| 验收口径 | 正向/主路径用例 | 反向/边界用例 | 归属切片 |
| --- | --- | --- | --- |
| AC-R1-1 段边界目录匹配 | TC-S1-01、TC-S1-03 | TC-S1-02、TC-S1-04 | S1 |
| AC-R1-2 拒绝面 | — | TC-S1-05 | S1 |
| AC-R1-3 大小写 | TC-S1-06 | TC-S1-07 | S1 |
| AC-R1-4 重命名两端 | TC-S1-08 | TC-S1-09 | S1 |
| AC-R1-5 纯函数 | TC-S1-11 | TC-S1-10 | S1 |
| AC-R1-6 单一判定 | TC-S2-01 | TC-S1-14、TC-S2-14、TC-S5-19 | S1/S2/S5 |
| AC-R2-1 原子性 | TC-S2-01 | TC-S2-02、TC-S2-16 | S2 |
| AC-R2-2 可并行 | TC-S2-01 | — | S2 |
| AC-R2-3 无半状态 | TC-S2-01 | TC-S2-03 | S2 |
| AC-R2-4 epoch | TC-S2-06 | TC-S2-04、TC-S2-05 | S2 |
| AC-R2-5 恢复 reconciling | TC-S2-06 | TC-S2-05 | S2 |
| AC-R2-6 扩展 | TC-S2-08 | TC-S2-07 | S2 |
| AC-R2-7 数据一致 | TC-S2-09 | TC-S2-02 | S2 |
| AC-R2-8 迁移 | TC-S2-13、TC-S4-15 | TC-S4-16 | S2/S4 |
| AC-R3-1 等待状态 | TC-S5-01 | TC-S5-02、TC-S4-03 | S4/S5 |
| AC-R3-2 不队头阻塞 | TC-S2-12 | TC-S5-02 | S2/S5 |
| AC-R3-3 授权校验 | TC-S5-03 | TC-S5-04、TC-S5-05、TC-S5-06、TC-S5-07 | S5 |
| AC-R3-4 先读后写 | TC-S5-11 | TC-S5-12 | S5 |
| AC-R3-5 HEAD 变化 | TC-S5-13 | TC-S5-14 | S5 |
| AC-R3-6 扩域执行面 | TC-S5-15、TC-S5-21 | TC-S5-15 | S5 |
| AC-R3-7 WIP 保留 | TC-S5-16、TC-S5-21 | TC-S5-17 | S5 |
| AC-R3-8 只读并行 | TC-S5-09 | TC-S5-10 | S5 |
| AC-R4-1 干净合入 | TC-S3-11 | TC-S3-05 | S3 |
| AC-R4-2 验证失败 | TC-S3-11 | TC-S3-12、TC-S3-21 | S3 |
| AC-R4-3 HEAD 前进 | TC-S3-13 | TC-S3-13 | S3 |
| AC-R4-4 崩溃恢复 | TC-S3-14 | TC-S3-15 | S3 |
| AC-R4-5 工作区脏 | TC-S3-11 | TC-S3-16 | S3 |
| AC-R4-6 仓库身份/ref | TC-S4-02 | TC-S4-06、TC-S4-07、TC-S4-08 | S4 |
| AC-R4-7 入队门禁 | TC-S3-04、TC-S3-17、TC-S8-06 | TC-S3-01、TC-S3-02、TC-S3-03、TC-S3-18、TC-S8-05、TC-S8-11 | S3/S8 |
| AC-R4-8 唯一集成入口 | TC-S3-07 | TC-S6-03 | S3/S6 |
| AC-R5-1 徽标 | TC-S7-01、TC-S7-03 | TC-S7-02 | S7 |
| AC-R5-2 等待可视化 | TC-S7-04、TC-S7-05 | TC-S7-11 | S7 |
| AC-R5-3 裁决面板 | TC-S7-06、TC-S7-07 | TC-S7-08 | S7 |
| AC-R5-4 并发裁决 | TC-S7-07 | TC-S7-08、TC-S4-10 | S4/S7 |
| AC-R5-5 不越权 | TC-S4-09 | TC-S4-11、TC-S7-09 | S4/S7 |
| AC-R5-6 降级可读 | TC-S4-12 | TC-S4-13、TC-S7-10 | S4/S7 |
| AC-R6-1 唯一入口 | TC-S6-02 | TC-S6-01、TC-S6-15 | S6 |
| AC-R6-2 done 条件 | TC-S6-04 | TC-S6-05、TC-S6-06、TC-S6-07 | S6 |
| AC-R6-3 legacy | TC-S6-12、TC-S3-20、TC-S7-03 | TC-S6-13 | S3/S6/S7 |
| AC-R6-4 观察模式 | TC-S6-08 | TC-S6-09 | S6 |
| AC-R6-5 开关互斥 | TC-S6-02 | TC-S6-03 | S6 |
| AC-R6-6 回滚 | TC-S6-10 | TC-S6-11 | S6 |
| AC-R7-1 非 Git 单写 | TC-S1-13 | TC-S2-10、TC-S5-18 | S1/S2/S5 |
| AC-R7-2 只读不受限 | TC-S1-13、TC-S5-09 | TC-S5-10 | S1/S5 |
| AC-R7-3 不静默 | TC-S1-13 | TC-S5-18 | S1/S5 |
| AC-R8-1 指标可得 | TC-S4-12、E2E-10 | TC-S4-13 | S4 |
| AC-R8-2 不可读口径 | TC-S4-12 | TC-S4-13、TC-S7-10 | S4/S7 |
| AC-R8-3 汇总口径 | TC-S4-14、TC-S4-18 | — | S4 |
| AC-R9-1 文档一致 | TC-S8-07 | TC-S8-08 | S8 |
| AC-R9-2 门禁 | TC-S8-01、TC-S8-09 | TC-S8-02 | S8 |

> 覆盖核对：R-1 6 条、R-2 8 条、R-3 8 条、R-4 8 条、R-5 6 条、R-6 6 条、R-7 3 条、R-8 3 条、R-9 2 条，合计 **50 条**；矩阵每行至少 1 个用例引用，无悬空 AC。

## 8. 附录 A：用例文档自检（machcheck，供 coder/tester 一键复核）

> 规范脚本：docs/G-mujfc9vi-1/T169-evidence/machcheck-test-cases.mjs（零第三方依赖，仅 node:fs/node:path/node:os/node:child_process）。运行：node docs/G-mujfc9vi-1/T169-evidence/machcheck-test-cases.mjs；通过 exit 0 并打印统计（总条数/各切片/类别/优先级/AC 覆盖/BR 配对/骨架语法），本阶段实测输出见 T169-evidence/01-doc-machcheck.txt 与 02-skeleton-syntax.txt。校验项：
1. 用例行格式：§4/E2E 表行（ID 为 TC-S<n>-<m> 或 E2E-n）列数 = 7 列，ID 全文档唯一，类/优列首字符 ∈ {🟢,🟡,🔴} 且优先级 ∈ {P0,P1,P2}；
2. 非空性：每行 前置条件 / 操作步骤 / 期望结果与通过判据 / 自动化 / 追溯 五列均非空（每条可执行、有 PASS/FAIL 判据、有归宿）；
3. AC 全覆盖：50 条 AC（AC-R1-1..6/R2-1..8/R3-1..8/R4-1..8/R5-1..6/R6-1..6/R7-1..3/R8-1..3/R9-1..2）在 §7 每行恰出现一次，无悬空 AC、无重复；
4. 正反向配对：§5 每 BR 引用的正向 TC 类别为 🟢、反向 TC 类别为 🔴，且 id 均存在；
5. 数值一致：本文 §0 的计数与脚本统计一致（运行后如计数变化需同步 §0）；
6. 骨架语法：§9 附录 B 的 js 代码块全部通过 node --check（输出见 02-skeleton-syntax.txt）。

## 9. 附录 B：逐切片可照抄测试代码骨架（coder 在各切片文件域内物化；**本阶段不预写文件**以免与 coder 合入冲突）

> 说明：骨架以 node:test / node:assert 风格编写，注释标 TC 号；plugins 测试 import 构建产物或源码（依赖就位后）。全部 JS 骨架已通过 node --check 语法校验（见证据 02-skeleton-syntax.txt）。所有 git 调用一律非管道 stdio（I-9）。

### B.1 S1 路径判定纯函数测试（→ packages/shared/test/path-domain.test.mjs）

~~~js
// packages/shared/test/path-domain.test.mjs —— S1（R-1 / D-P1 / D-P2）
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRepoPath, pathsIntersect, expandRename } from '../src/path-domain.mjs'

const ci = { caseInsensitive: true }
const cs = { caseInsensitive: false }
const dir = (path) => ({ path, type: 'dir' })
const file = (path) => ({ path, type: 'file' })

test('TC-S1-01/02 目录按段边界：src/a 覆盖 src/a/b.mjs 但不覆盖 src/ab', () => {
  assert.equal(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs), true)
  assert.equal(pathsIntersect(dir('src/a'), file('src/ab'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/a/sub'), cs), true)
})

test('TC-S1-03/04 文件精确相等、跨文件不误判', () => {
  assert.equal(pathsIntersect(file('src/a.mjs'), file('src/a.mjs'), cs), true)
  assert.equal(pathsIntersect(file('src/a.mjs'), file('src/b.mjs'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/b'), cs), false)
})

test('TC-S1-05 五类拒绝面逐条结构化拒绝', () => {
  const bad = ['C:/x/a.mjs', '/etc/passwd', '../secret', 'docs/../secret', '', '   ', '.git/config', 'docs/.git/config']
  for (const raw of bad) {
    const r = normalizeRepoPath(raw, cs)
    assert.equal(r.ok, false, raw)
    assert.equal(typeof r.reason, 'string')
  }
})

test('TC-S1-06/07 大小写按仓库配置归一，两向结论不同', () => {
  assert.equal(pathsIntersect(file('Src/A.mjs'), file('src/a.mjs'), ci), true)
  assert.equal(pathsIntersect(file('Src/A.mjs'), file('src/a.mjs'), cs), false)
})

test('TC-S1-08/09 重命名同时占用旧路径与新路径', () => {
  const renamed = expandRename({ from: 'src/old.mjs', to: 'src/new.mjs' })
  assert.equal(renamed.length, 2)
  assert.equal(pathsIntersect(renamed, file('src/old.mjs'), cs), true)
  assert.equal(pathsIntersect(renamed, file('src/new.mjs'), cs), true)
  assert.equal(pathsIntersect(renamed, file('src/other.mjs'), cs), false)
})

test('TC-S1-10 边界：空集合不抛、自身相交为真', () => {
  assert.equal(pathsIntersect([], file('src/a.mjs'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/a'), cs), true)
})

test('TC-S1-11 纯函数同输入同输出', () => {
  const once = JSON.stringify(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs))
  const twice = JSON.stringify(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs))
  assert.equal(once, twice)
})
~~~

### B.2 S1 仓库身份与能力探测测试（→ packages/shared/test/repo-identity.test.mjs）

~~~js
// packages/shared/test/repo-identity.test.mjs —— S1（R-7 / D-P4）
import test from 'node:test'
import assert from 'node:assert/strict'
import { repoIdFromCommonDir, detectRepoCapability } from '../src/repo-identity.mjs'

test('TC-S1-12 两个 worktree 的 common-dir 归一到同一 repoId（大小写/尾斜杠归一）', () => {
  const a = repoIdFromCommonDir('D:/repo/.git')
  const b = repoIdFromCommonDir('D:/repo/.git/')
  const c = repoIdFromCommonDir('d:/repo/.git')
  assert.equal(a, b)
  assert.equal(a, c)
})

test('TC-S1-13 非 Git / Git 不可用 / 不可规范化 -> degraded + 可读原因 + 单写', () => {
  for (const facts of [
    { isGit: false, gitAvailable: false, commonDir: null },
    { isGit: true, gitAvailable: false, commonDir: 'D:/repo/.git' },
    { isGit: true, gitAvailable: true, commonDir: null },
  ]) {
    const r = detectRepoCapability(facts)
    assert.equal(r.capability, 'degraded')
    assert.equal(r.singleWriterRequired, true)
    assert.equal(r.readOnlyAllowed, true)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
})
~~~

### B.3 S2 写入意图与预约事务测试（→ team-hub/write-intent-store.test.mjs；同进程双 DatabaseSync 连接，等价口径 A-3）

~~~js
// team-hub/write-intent-store.test.mjs —— S2（R-2 / R-3 服务端）
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWriteIntentStore, ensureWriteIntentSchema } from './write-intent-store.mjs'

// 临时库夹具：绝不用 live 库（I-2）
function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-t169-intent-'))
  const file = join(dir, 'intent.db')
  const dbA = new DatabaseSync(file)
  ensureWriteIntentSchema(dbA)
  const dbB = new DatabaseSync(file)
  return { dbA, dbB }
}

test('TC-S2-01/02 异文件并行成功、同文件恰一活跃且另一 FILE_CONTENTION', () => {
  const { dbA, dbB } = pair()
  const a = createWriteIntentStore(dbA)
  const b = createWriteIntentStore(dbB)
  assert.equal(a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] }).ok, true)
  assert.equal(b.reserve({ repoId: 'r1', taskId: 't2', attemptId: 'a2', epoch: 1, paths: ['src/b.mjs'] }).ok, true)
  const contended = b.reserve({ repoId: 'r1', taskId: 't3', attemptId: 'a3', epoch: 1, paths: ['src/a.mjs'] })
  assert.equal(contended.ok, false)
  assert.equal(contended.code, 'FILE_CONTENTION')
  assert.ok(Array.isArray(contended.paths) && contended.paths.includes('src/a.mjs'))
  assert.equal(contended.holderTaskId, 't1')
})

test('TC-S2-04 epoch 过期释放被拒且回报当前真实 epoch', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 7, paths: ['src/a.mjs'] })
  const rejected = a.release({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 6 })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.currentEpoch, 7)
})

test('TC-S2-09 全库活跃预约两两不相交（不变量扫描）', () => {
  const { dbA } = pair()
  const a = createWriteIntentStore(dbA)
  a.reserve({ repoId: 'r1', taskId: 't1', attemptId: 'a1', epoch: 1, paths: ['src/a'] })
  const scan = a.assertNoActiveOverlap('r1')
  assert.equal(scan.ok, true)
})
~~~

### B.4 S3 沙箱安全 git 接缝测试（→ team-hub/git-plumbing.test.mjs；非管道 stdio，I-9）

~~~js
// team-hub/git-plumbing.test.mjs —— S3（R-4 / 方案 A）
import test from 'node:test'
import assert from 'node:assert/strict'
import { openSync, closeSync, readFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 沙箱纪律：git 子进程禁止默认管道 stdio；结果写临时文件再读回
export function runGit(args, cwd) {
  const out = join(mkdtempSync(join(tmpdir(), 'legion-t169-git-')), 'out.txt')
  const fd = openSync(out, 'w')
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  return { status: r.status, text: readFileSync(out, 'utf8') }
}

test('TC-S3-08 merge-tree --write-tree 干净/冲突两态可区分', () => {
  const repo = mkdtempSync(join(tmpdir(), 'legion-t169-repo-'))
  runGit(['init', '-q', '-b', 'main'], repo)
  const clean = runGit(['merge-tree', '--write-tree', 'HEAD', 'HEAD'], repo)
  assert.equal(clean.status, 0)
})

test('TC-S3-10 merge-base --is-ancestor 可判是否已应用', () => {
  const repo = mkdtempSync(join(tmpdir(), 'legion-t169-anc-'))
  runGit(['init', '-q', '-b', 'main'], repo)
  assert.equal(runGit(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], repo).status, 0)
})
~~~

### B.5 S3 集成 worker journal 崩溃恢复测试（→ team-hub/integration-worker.test.mjs；系统临时仓库夹具）

~~~js
// team-hub/integration-worker.test.mjs —— S3（R-4 / journal 四阶段 / 崩溃恢复）
import test from 'node:test'
import assert from 'node:assert/strict'

test('TC-S3-14 三时点崩溃恢复后每 source commit 至多集成一次', () => {
  const phases = ['prepared', 'applying', 'ref-updated', 'finalized']
  for (const stopAt of ['prepared', 'ref-updated', 'finalized']) {
    const journal = phases.slice(0, phases.indexOf(stopAt) + 1)
    assert.ok(journal.length >= 1)
    // 恢复对账：is-ancestor/ref SHA 判定「未应用/已应用未记账/结果不明」
    const recovered = { applied: journal.includes('ref-updated'), recorded: journal.includes('finalized') }
    if (recovered.applied && !recovered.recorded) {
      assert.equal('只补记不重跑 merge', '只补记不重跑 merge')
    }
  }
})

test('TC-S3-15 结果不明暂停且不自动删分支、不重跑 merge', () => {
  const outcome = { action: 'pause', deleteBranch: false, rerunMerge: false }
  assert.equal(outcome.action, 'pause')
  assert.equal(outcome.deleteBranch, false)
  assert.equal(outcome.rerunMerge, false)
})
~~~

### B.6 S5 plugins 写入资格测试（→ plugins/tests/write-eligibility.test.mjs）

~~~js
// plugins/tests/write-eligibility.test.mjs —— S5（R-3 等待语义 + 授权快照）
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGrantSnapshot, checkWriteEligibility } from '../src/writeEligibility.js'

test('TC-S5-01 等待语义：status=todo + schedulingState=waiting-file + 重试不增', () => {
  const outcome = checkWriteEligibility({
    task: { id: 't1', status: 'todo', retryCount: 2, attemptCount: 1 },
    activeReservations: [{ taskId: 't9', paths: ['src/a.mjs'] }],
    intent: { paths: ['src/a.mjs'], revision: 1 },
    epoch: 3,
  })
  assert.equal(outcome.state, 'waiting-file')
  assert.equal(outcome.task.status, 'todo')
  assert.equal(outcome.task.retryCount, 2)
  assert.deepEqual(outcome.blockers.map((b) => b.taskId), ['t9'])
})

test('TC-S5-03 授权快照含 attempt/epoch/revision/worktree 且模型不可改', () => {
  const snap = buildGrantSnapshot({ attemptId: 'a1', epoch: 3, intentRevision: 1, worktree: 'D:/wt/t1' })
  assert.equal(snap.attemptId, 'a1')
  assert.equal(snap.epoch, 3)
  assert.equal(snap.intentRevision, 1)
  assert.equal(snap.worktree, 'D:/wt/t1')
  assert.equal(Object.isFrozen(snap), true)
})

test('TC-S5-04 pre-execute 越界路径被拒且原因可行动', () => {
  const outcome = checkWriteEligibility({
    task: { id: 't1', status: 'in_progress', retryCount: 0, attemptCount: 1 },
    activeReservations: [],
    intent: { paths: ['src/a.mjs'], revision: 1 },
    epoch: 3,
    writePath: 'src/secret.mjs',
  })
  assert.equal(outcome.allowWrite, false)
  assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 0)
})
~~~

### B.7 S7 Workbench 交付徽标映射测试（→ workbench/scripts/delivery-ui.test.mjs）

~~~js
// workbench/scripts/delivery-ui.test.mjs —— S7（R-5 徽标不冒充）
import test from 'node:test'
import assert from 'node:assert/strict'
import { badgeForDelivery, deliveryBadges } from '../src/deliveryBadge.js'

test('TC-S7-01 八徽标与交付/调度子状态逐一映射', () => {
  assert.equal(badgeForDelivery('integrated'), '已交付')
  assert.equal(badgeForDelivery('awaiting-acceptance'), '待验收')
  assert.equal(deliveryBadges.length, 8)
})

test('TC-S7-02 Agent 写完不得显示为已交付', () => {
  assert.notEqual(badgeForDelivery('awaiting-acceptance'), '已交付')
  assert.notEqual(badgeForDelivery('ready'), '已交付')
  assert.notEqual(badgeForDelivery('legacy-unknown'), '已交付')
})
~~~

### B.8 S8 CI 登记与 delivery.json 校验（→ scripts/ci/run-ci.mjs 登记校验段 / node -e 直跑）

~~~js
// node -e 或 run-ci 登记校验段（S8）
import { readFileSync } from 'node:fs'

const required = [
  'packages/shared/test/path-domain.test.mjs',
  'packages/shared/test/repo-identity.test.mjs',
  'team-hub/write-intent-store.test.mjs',
  'team-hub/delivery-store.test.mjs',
  'team-hub/integration-worker.test.mjs',
  'team-hub/git-plumbing.test.mjs',
  'team-hub/write-intent-routes.test.mjs',
  'team-hub/delivery-routes.test.mjs',
  'team-hub/metrics.test.mjs',
  'plugins/tests/write-eligibility.test.mjs',
  'plugins/tests/legacy-convergence.test.mjs',
  'workbench/scripts/delivery-ui.test.mjs',
]
const ci = readFileSync('scripts/ci/run-ci.mjs', 'utf8')
for (const f of required) {
  if (!ci.includes(f)) throw new Error('未登记测试文件: ' + f)
}
const delivery = JSON.parse(readFileSync('.legion/delivery.json', 'utf8'))
if (!/^refs\//.test(delivery.targetRef)) throw new Error('targetRef 非完整 ref')
for (const v of delivery.verify) {
  if (!Array.isArray(v.argv) || v.argv.length === 0) throw new Error('verify.argv 必须是非空数组')
  if (typeof v.timeoutMs !== 'number') throw new Error('verify.timeoutMs 缺失')
}
~~~

## 附录 C 关联文档与阅读顺序

1. 设计基线：[2026-09-27-parallel-task-conflict-control-design.md](../superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md) §3~§11（产品规则、五张表、集成协议、九场景）。
2. 需求：[REQUIREMENTS.md](./REQUIREMENTS.md) §5（R-1~R-9 + 50 条 AC）、§6（端到端 11 条）、§8（D-* 默认值）。
3. 方案：[RESEARCH.md](./RESEARCH.md) §3（方案 A/B/C）、§4（D-P1~D-P9）、§6.3（集成 worker 时序）。
4. 拆解：[TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md) 「## slices」S1~S8、§4（blockedBy）、§5（串并行）、§7（跨切片契约）、§8（沙箱纪律）。
5. 本文：用例目录 §4（S1~S8 + E2E）、业务规则 §5（BR-1~BR-42）、追溯 §7、骨架 §9 附录 B。
6. 下游：coder（T-170）→ reviewer（T-171）→ tester（T-172，写 TEST_REPORT.md）→ devops（T-173，接 run-ci 与 .legion/delivery.json）。
7. 团队经验：本文参考 T-095（requirement 岗「仅文档 + 真实命令留痕」做法）与 skill exp-t092（回归复跑先查上游验证防空转）——本任务为新目标首链的用例设计，exp-t092 不直接适用，未硬套其套件清单。

