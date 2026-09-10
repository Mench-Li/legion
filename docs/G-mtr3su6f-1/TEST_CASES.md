<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `0a58ecb`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-122 测试用例 / 验收测试：对话中心「可回答闭环修复 + 上下文输入（关联工作空间 / 上传文件）」

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-122（[auto-goal]｜所属目标 G-mtr3su6f-1 · software · chain）
> 上游：T-119 需求澄清（docs/G-mtr3su6f-1/REQUIREMENTS.md：R-1~R-5，AC-R1-1..8 / AC-R2-1..5 / AC-R3-1..6 / AC-R4-1..6 / AC-R5-1..3，D-1~D-8 默认值即基线）→ T-120 方案搜索（docs/G-mtr3su6f-1/RESEARCH.md：决策 A1/B1+B2/C1/D1/E1/F1/G1 与 §8.2 默认值表）→ T-121 任务拆解（docs/G-mtr3su6f-1/TASK_BREAKDOWN.md：**「## slices」9 个切片 S1~S9**，每片机器验收行 = 本用例唯一翻译基准）
> 下游：coder（T-123）按本文档 §4 用例 + §9 附录 B 骨架把 P0 用例落成机器断言与契约测试（逐切片文件域归 TASK_BREAKDOWN §1 第 2 段）；reviewer（T-124）按用例复核实现；tester（T-125）按 §2 分层逐条执行并把结果写入 docs/G-mtr3su6f-1/TEST_REPORT.md；devops（T-126）按 §2/§3 接入 CI 门禁。
> 依据：T-121 TASK_BREAKDOWN §1 机器验收行（每片 DoD 分句）、T-119 REQUIREMENTS §5 AC-* 口径与 §6 端到端总口径、T-120 RESEARCH 决策/默认值与 §11.2 验证链、LEGION.md 纪律与 T-122 阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望与通过判据；关键业务规则正反向成对）。
>
> **权威基线/命名空间提醒**：本目标分析文档目录 = docs/G-mtr3su6f-1/。仓库根 docs/TEST_CASES.md 等根槽位属其他目标/遗留链，**禁止读写**。本用例只写本文（docs/G-mtr3su6f-1/TEST_CASES.md）+ 自检证据（docs/G-mtr3su6f-1/T122-evidence/，供 runner/tester 复跑）；**不预写切片域内可执行测试文件**（TASK_BREAKDOWN §1 第 2 段已把各测试文件划给对应 coder 文件域，预写必与 coder 合入冲突），只交付用例 + 可照抄骨架（§9 附录 B）。
>
> **工作区状态**：分支 w/T-122，HEAD 5909dfd（promote T-121）。docs/G-mtr3su6f-1/ 现仅 REQUIREMENTS.md、RESEARCH.md、TASK_BREAKDOWN.md（本文为 T-122 首次产出，无旧版）；docs/goals/G-mtr3su6f-1.md 的 M 为派工/守护目标镜像快照，本阶段未触碰。实测基线（本 worktree 复跑）：node v24.19.0；node team-hub/chat.test.mjs = 23 tests / pass 23 / exit 0。

## 0. 结论速览（TL;DR）

- 交付单件：本文档 docs/G-mtr3su6f-1/TEST_CASES.md + 自检证据 docs/G-mtr3su6f-1/T122-evidence/。共 **112 条用例**（S1 12 / S2 11 / S3 17 / S4 10 / S5 12 / S6 10 / S7 13 / S8 12 / S9 9 / E2E 6；🟢正常 53 / 🟡边界 14 / 🔴异常·反向 45；P0=93 / P1=10 / P2=9），每条含 前置条件 / 操作步骤 / 期望结果与通过判据；计数/ID 唯一/类别枚举/列完整性/AC 全覆盖/正反向配对经附录 A 自检脚本复核（输出见 T122-evidence/01-doc-machcheck.txt）。
- 验收标准用例化：T-121 TASK_BREAKDOWN §1 机器验收行（S1~S9）逐分句 + T-119 AC-R1-1..8 / AC-R2-1..5 / AC-R3-1..6 / AC-R4-1..6 / AC-R5-1..3 + 设计决策默认值（D-1~D-8、常量默认表）+ 硬性不变量（I-1~I-9，§1.3）逐条映射到用例（§4 追溯列 + §7 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，无黑盒结论。
- 关键业务规则正反向成对（§5，BR-1~BR-17，机器可复核）：失败文案可行动性（分类映射 vs 裸 error 负例）、兜底不崩（隔离复现回写 vs 空输入兜底）、D-5/D-8 不变（沿用语义 vs 无自动重试/回填静态负例）、附件内容不进 body/meta（引用进 meta vs 正文含文件内容负例）、附件归属隔离（同会话可取 vs 跨会话 4xx）、上传类型护栏（文本可传 vs 黑名单拒）、大小/数量护栏（常规可传 vs 超限拒）、摘要确定性取数（allowlist+结构入摘要 vs 噪声不得入）、降级不崩（占位继续 vs 读取失败不得标 failed）、附件当次隔离（连续两问第二问无附件 vs 内容落持久面负例）、附件标识与移除（发送携带引用 vs 移除后请求无附件）、防竞态（失败保留 vs 发送中不禁用即失败）、健康三态诚实（绿态 vs 失败红态可行动）、设置开关语义（关→开恢复 vs 关后零 awaiting）、空间入口（选择空间可对话 vs 死路卡残留负例）、文档三要素（关键句存在 vs 注入删除后失败）、docs 门禁（正向 exit 0 vs 坏链负例）。
- 测试代码落点（§9 附录 B 骨架，逐切片对齐 TASK_BREAKDOWN 文件域，**由 coder 在各切片内物化成文件，本阶段不预写**）：S1 → plugins/tests/chat-error-classifier.test.mjs（新文件，全骨架）；S2 → team-hub/chat.test.mjs 追加「health」describe + plugins/src/index.ts 心跳/daemon 字段冒烟；S3 → team-hub/chat.test.mjs 追加「attachments」describe（含 env 小值覆写 + TTL + audit + 归属矩阵）；S4 → plugins/tests/space-digest.test.mjs（新文件，tmp fixture 仓库全骨架）；S5 → plugins/tests/chat-responder.test.mjs 追加（摘要/附件块/预算/占位/HTML 负例）；S6 → 隔离 hub+守护 fake-subagent L1 冒烟脚本（prompt 捕获断言 + 连续两问隔离）；S7/S8 → workbench 浏览器驱动冒烟 + api.ts/组件源码断言；S9 → node -e 关键句断言 + check-docs 门禁。
- 分层与执行者（§2）：L0 数据面契约（team-hub tmp-DB：node team-hub/chat.test.mjs）｜L1 plugins 纯函数（node plugins/tests/*.test.mjs，需先 pnpm build 出 plugins/lib）｜L2 真实链路隔离冒烟（fake provider + 绑定仓库 fixture）｜L3 UI 浏览器冒烟（S7/S8）｜L4 CI 回归与 docs 门禁。coder 随切片自跑、tester 在 T-125 逐条复跑并写 TEST_REPORT.md、devops 在 T-126 接入 run-ci。
- 环境事实（写进各用例执行说明，仓库 R-18 惯例）：本 worktree **无 node_modules/dist**；plugins 构建/typecheck、workbench build 需宿主/CI 或 run-ci deps junction，受限时按「如实记录复现步骤与输出」处理，不冒充通过；沙箱子进程捕获 EPERM 时以普通终端直跑等效；**live 库 D:/project/DSH/legion/team-hub/team.db 零触碰**（全部用例临时库/隔离实例，RK-4）。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入与假设

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS（T-119，docs/G-mtr3su6f-1/REQUIREMENTS.md）§5 | R-1（P0 可回答 AC-R1-1..8）/ R-2（P0 关联工作空间 AC-R2-1..5）/ R-3（P0 上传文件 AC-R3-1..6）/ R-4（P1 护栏 AC-R4-1..6）/ R-5（P2 文档 AC-R5-1..3）；§6 端到端总口径 6 条；D-1~D-8 默认值即基线（本用例按默认展开，将军改判仅影响对应断言取值） |
| TASK_BREAKDOWN.md（T-121）§1 | S1~S9 机器验收行（分号分隔的 DoD 分句 = 本用例逐条翻译对象）；每片测试文件域（§1 第 2 段）与依赖顺序（§2.1 blockedBy） |
| RESEARCH.md（T-120） | A1 分类器五类别（model-unavailable / provider-error / timeout-aborted / foreman-down / empty-other）；B1 健康端点三输入 + 诚实标注；C1 摘要规格（allowlist/噪声/预算）；D1 分块注入与降级占位文案；E1 chat_attachments 表 + uploads 落盘 + staged/sent 状态 + TTL；F1 原生控件；G1 常量默认值表（§8.2）与审计 chat:attachment* |
| 代码基线 | w/T-122 HEAD == promote T-121（代码与上游一致；T-119/T-120/T-121 仅改 docs）；chat.test.mjs 现有 23 例（suites 14）全绿为回归基线 |
| 假设 A-1 | 服务端护栏常量以同名 env 覆写（RESEARCH §8.2 默认值表：CHAT_ATTACH_MAX_BYTES=10MB / CHAT_ATTACH_MAX_PER_MSG=3 / CHAT_ATTACH_BLACKLIST_EXT / CHAT_CTX_BUDGET_CHARS=8000 / CHAT_CTX_FILE_CAP_CHARS=4000 / CHAT_ATTACH_STAGED_TTL_MS=24h / CHAT_ATTACH_TTL_MS=7d / CHAT_REPLY_TIMEOUT_MS=120s，沿用 CHAT_REPLY_TIMEOUT_MS 的 env 先例 server.mjs:912）。若实现采用不同前缀，仅改用例的 env 名常量，断言语义不变 |
| 假设 A-2 | 附件数据面契约：PUT /api/chat/attachments?scope=（raw body）→ {id,fileName,size}，status=staged；postMessage 携带 attachmentIds 同事务绑定 msg/conv 并置 status=sent；GET /api/chat/attachments/content?id= 按会话归属校验返回 UTF-8 文本；messages.meta.attachments=[{id,fileName,size}] 只存引用（TASK_BREAKDOWN §3.1 契约已定稿） |
| 假设 A-3 | S5 提示词输入契约（TASK_BREAKDOWN §3.1）：ChatAnswerInput 增可选 spaceDigest 与 attachments[{id,fileName,size,content}]；块顺序 = 角色→行为约束→systemHint→工作空间上下文块→上传文件块→会话历史→提问 |
| 假设 A-4 | 降级占位文案定稿（RESEARCH §5.2）：空摘要「（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）」；附件读取失败「（附件 <name> 读取失败：原因）」；截断标记「（已截断）」；预算先裁摘要后裁附件 |
| 假设 A-5 | S2 健康端点字段形状由实现定稿（聚合守护在线/开关/模型解析/最近失败），本用例断言其语义与诚实标注，字段名以实现为准；UI 三态语义 绿=守护在线+开关开+模型已解析 / 黄=某前提缺失+修复动作 / 红=最近失败+重试指引 / 灰=端点缺失 |
| 假设 A-6 | 隔离复现/真实链路冒烟注入 fake 子代理/假 provider（对齐 chat.test.mjs tmp-DB + 动态 import 范式；plugins 侧既有 worker 冒烟先例），不触碰 live 库；守护在线 = 宿主可达前提，不可达时按仓库惯例记录复现步骤而非黑盒 PASS |

### 1.2 决策闸门默认值（D 系列，本用例判定依据；将军未否决即按默认展开）

| 闸门/决策 | 默认（本用例按此展开） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| D-1 产品对象 | Legion workbench 💬 对话中心（software 空间会话为现场） | 其他对话面 | 全部用例 scope 语义变化 |
| D-2 关联空间语义 | 选择/切换工作空间 + 绑定仓库**只读真实内容摘要**为回复上下文（C1，不给工具） | 仅分区选择 | S4/S5/S6 上下文生效类用例取消/改写 |
| D-3 上传边界 | 仅当次回复上下文 + TTL 清理，不建长期记忆/跨会话共享 | 长期会话记忆 | S6 隔离类用例翻转 |
| D-4 回复设置 UI | 对话中心暴露每空间「AI 回复」开关（model/identity/systemHint 可选） | 仅后端 | S7 设置弹窗用例取消、R-5 文档口径扩大 |
| D-5 历史遗留消息 | 不回填不自动轰炸；既有 failed 由用户手动重试 | 自动回填 | S1-10 静态负例翻转 |
| D-6 限制默认值 | ≤10MB、≤3 附件、扩展名黑名单 + UTF-8 fatal 解码、外部上下文预算 ~8000 字符 | 更紧/更松值 | S3/S4/S5/S6 常量断言取值变化 |
| D-7 交付顺序 | R-1 先行（S1/S2/S7 前置）→ R-2/R-3 → R-5 | 分轮 | 执行顺序变化 |
| D-8 时间窗/重试 | ≤120s（可配置）、超龄 failed、无自动重试、手动重试 | 60s/自动重试 | S1 无自动重试静态断言翻转 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增运行时/开发依赖（全批；RESEARCH §9 结论 0 依赖） | TC-S1-12 / S2-11 / S3-17 / S4-10 / S5-12 / S6-10 / S7-13 / S8-12 / S9-08 |
| I-2 | live 库 team-hub/team.db 零写入；一切验证临时库（TEAM_HUB_DB=mkdtemp）或隔离 hub 实例 | TC-S1-11 / S3-16 / S6-07/08/09 |
| I-3 | 附件内容（文件全文）绝不进入 messages.body / messages.meta，只存引用且只进当次提示词 | TC-S3-07 / S3-15 / S6-06 / S8-06 |
| I-4 | 不引入自动重试；不自动回填历史遗留消息（D-5/D-8 不变） | TC-S1-10 |
| I-5 | 提示词输出纯文本、无 HTML 注入面；UI 无 dangerouslySetInnerHTML 直插服务端文本 | TC-S5-09 / S7-12 / S8-12 |
| I-6 | 回复子代理无工具/自由读文件权限；上下文只读、显式、预算内提供 | TC-S4-07 / S6-06 |
| I-7 | 上下文当次有效不跨消息/会话持久；附件按 TTL 清理 | TC-S6-09 / S3-11 / S3-12 |
| I-8 | 健康端点只读且诚实标注「已解析不代表 provider 实际可用」，不冒充 | TC-S2-07 / S2-08 |
| I-9 | 改动只落切片文件域；本文档只写目标级目录 docs/G-mtr3su6f-1/ | TC-S4-08 / S9-08 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 与仓库既有批次同构；命令以 node <file> 直跑等效为准。**node_modules 不在本 worktree**：plugins build/typecheck、workbench build 需宿主/CI 或 run-ci deps junction（受限时按 R-18「如实记录复现步骤与输出」），不冒充通过。执行职责：coder 随各切片自跑（切片 DoD 要求），tester 在 T-125 对本文 §4 全量复跑并把结果写入 TEST_REPORT.md，devops 在 T-126 把关键命令接入 scripts/ci/run-ci.mjs（chat 阶段已登记 :190）。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 数据面契约：`node team-hub/chat.test.mjs`（tmp-DB + 动态 import server.mjs；既有 23 例 + S2 健康 describe + S3 附件 describe 追加） | S2/S3 服务端契约与护栏、回归基线 | coder S2/S3 自跑；tester 复跑 | 纯 Node 直跑（node:test/node:sqlite），沙箱可跑；本 worktree 实测 23/23 exit 0 |
| L0-static | 源码/文件静态断言：`node -e`/grep/git diff（裸文案残留、无自动重试/回填、只读不 spawn、body 不含全文、渲染安全、改动文件清单） | S1/S4/S5/S6/S7/S8/S9 静态门禁 | coder 随切片；tester 复跑 | 纯 Node 直跑 |
| L1 | plugins 纯函数：`node plugins/tests/chat-error-classifier.test.mjs`、`node plugins/tests/space-digest.test.mjs`、`node plugins/tests/chat-responder.test.mjs`（既有 TC-S10-* + S5 追加）；类型 `tsc -p plugins/tsconfig.json --noEmit` | S1/S4/S5 纯函数分类/摘要/提示词 + 回归 | coder S1/S4/S5；tester 复跑 | 测试 import plugins/lib/*（需先 plugins/scripts/build.sh 产 lib，DSH_CHECKOUT 指向 D:/project/DSH/dsh/deepseek-harness）；受限按 R-18 记录 |
| L2 | 真实链路隔离冒烟（隔离 hub TEAM_HUB_DB=tmp + TEAM_HUB_PORT + 守护 + fake 子代理/假 provider + fixture 绑定仓库）：fake error → failed 分类文案回写（S1 锚点）；fake completed → replied；prompt 捕获断言含摘要/附件事实与第二问隔离（S6）；既有 run-ci chat-l1-smoke（22 项）与 chat-s2-smoke（9 项）不回归 | AC-R1-1/2、AC-R2-3/4、AC-R3-2、AC-R4-6 的确定性代理 | coder S1/S6；tester 复跑 | 宿主可达；守护在线为前提，不可达记录复现步骤 |
| L3 | UI 浏览器驱动冒烟（T-082/T-087/T-088 同型）：全部空间选空间入口、健康三态、回复设置开关、附件行上传/移除/标识 | S7/S8 用户可感知行为（AC-R1-5/6、R2-1/2、R3-1/3/4） | coder S7/S8；tester 复跑 | workbench dev server 宿主；不可达记录复现步骤 |
| L4 | CI 回归 + docs 门禁：`node scripts/ci/run-ci.mjs`（chat 阶段 :190、L1/S2 smoke :253-256、check-docs 阶段 :333-336）；`node scripts/ci/check-docs.mjs` | 全批不回归、R-5 文档门禁 | devops T-126 + tester 复跑 | 宿主/CI |

### 2.1 关键命令与 env（coder/tester 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| 数据面回归基线 | `node team-hub/chat.test.mjs` | 既有 23 例 + S2/S3 新增 describe；期望 exit 0（本 worktree 实测 23/23） |
| 附件护栏小值覆写 | `CHAT_ATTACH_MAX_BYTES=32 CHAT_ATTACH_MAX_PER_MSG=1 CHAT_ATTACH_STAGED_TTL_MS=50 CHAT_ATTACH_TTL_MS=60 node team-hub/chat.test.mjs`（或测试内 process.env 前置注入，对齐 CHAT_REPLY_TIMEOUT_MS 先例） | S3 边界/TTL 断言用小值注入缩短等待 |
| 分类器纯函数 | `node plugins/tests/chat-error-classifier.test.mjs`（先 `bash plugins/scripts/build.sh` 或 DSH_CHECKOUT=... 产 lib） | S1 五类别断言 |
| 摘要纯函数 | `node plugins/tests/space-digest.test.mjs` | S4 fixture 断言 |
| 提示词纯函数 | `node plugins/tests/chat-responder.test.mjs` | S5 + 既有 TC-S10 不回归 |
| plugins 类型 | `tsc -p plugins/tsconfig.json --noEmit`（node_modules 就位后） | S1/S4/S5/S6 DoD；受限按 R-18 记录 |
| workbench 构建 | `pnpm --dir workbench build`（tsc --noEmit 0 诊断 + vite build） | S7/S8 DoD；受限记录复现步骤 |
| 健康端点冒烟 | 隔离 hub 起服后 `GET /api/chat/health?scope=software`（curl/Node fetch） | S2 |
| 守护心跳/daemon 状态 | 宿主守护跑数轮后 `GET /api/members` 查 kind=worker 成员 online=true；`cat <scrumDir>/daemon.json` 查 chat.lastReplyAt/lastFailAt/lastFailReason | S2 |
| 附件端点冒烟 | 隔离 hub 起服后 PUT/GET /api/chat/attachments*（curl/Node fetch raw body） | S3 |
| 文档关键句断言 | `node -e "<见附录 B.8>"` | S9 AC-R5-1/2 |
| docs 门禁 | `node scripts/ci/check-docs.mjs`（正向 exit 0；坏链注入 exit ≠ 0） | S9 AC-R5-3 |
| 附件内容不入库断言 | `node -e "...（对 meta/body JSON 做文件正文片段正则，=0）"` | S3-15 / S6-06 / S8-06 |
| UI 冒烟 | 既有浏览器驱动脚本同型（T-082/T-087/T-088） | S7/S8 |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 实现期可配值（大小/数量/预算/时间窗/TTL），做「值-1 / 值 / 值+1」三值法断言；定值后无需改用例。常量默认值承接 RESEARCH §8.2（假设 A-1）。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| 失败文案可行动（R-1） | 5 类别 | 分类器每类 ≥1 输入输出断言成立；文案不含裸「回复子代理未完成（error）」/裸 undefined；含恢复指引（重试/配置/模型）关键词；aiError ≤500 字符（AC-R1-3） |
| 数据面回归（R-1） | node team-hub/chat.test.mjs | 既有 23 例 + 新增用例全部 pass、exit 0（AC-R1-7） |
| 健康状态（R-1） | 60s 心跳窗 | members lastSeenAt<60s=online；<60s/≥60s/无行三值判定；端点只读、诚实标注（AC-R1-3） |
| 回复时间窗（D-8） | 120s（CHAT_REPLY_TIMEOUT_MS） | 窗口内 awaiting→replied/failed；超龄兜底 failed（既有 TC-S9-07 不回归） |
| 上传大小（R-4/D-6） | ≤10MB（CHAT_ATTACH_MAX_BYTES） | size<上限 接受；==上限 接受（三值上界）；+1 拒绝 4xx 可读 |
| 每消息附件数（R-4/D-6） | ≤3（CHAT_ATTACH_MAX_PER_MSG） | ≤3 接受；4 拒绝可读 |
| 类型护栏（R-4/D-6） | 黑名单 + UTF-8 fatal | 黑名单扩展名 4xx；非 UTF-8 字节 4xx「无法作为上下文（非 UTF-8 文本）」；合法 UTF-8 文本接受 |
| 上下文预算（R-4） | 外部上下文合计 ≤8000 字符（CHAT_CTX_BUDGET_CHARS）；单文件/单摘要块 ≤4000（CHAT_CTX_FILE_CAP_CHARS） | 预算内完整注入；超限先裁摘要保附件、截断带「（已截断）」标记；不抛未定义错误（AC-R4-1） |
| 附件生命周期（R-4/D-3） | staged 孤儿 24h / sent 保留 7 天 | 过期清理行+文件；未过期保留（小值覆写断言）（AC-R4-6） |
| 归属隔离（R-3/R-4） | 会话归属 | 拥有会话可取回；跨会话/跨 scope 4xx；附件仅该会话可见（AC-R3-5） |
| 审计（R-4） | chat:attachment* | 上传/绑定/取回/清理留 audit，detail 含 fileName/size/scope/conv 可断言（AC-R4-4） |
| 内容不进 body（R-3/R-4） | — | messages.body/meta 无文件正文片段（正则 0 命中）（AC-R3-1/R4-3） |
| docs 门禁（R-5） | check-docs exit 0 | 正向 exit 0；注入坏锚点 exit ≠ 0（AC-R5-3） |
| 零新增依赖（全批） | 0 | package.json 无新增依赖；无新 import 第三方（I-1） |

## 4. 用例目录（S1~S9 + E2E）

> 图例：类别 🟢正常（主路径）/ 🟡边界（极限·三值）/ 🔴异常·反向（非法输入拒绝、规则违反被检出、恢复路径）；优先级 P0（切片验收门槛，R-1~R-3 与回归）/ P1（R-4 护栏）/ P2（R-5 文档）；「自动化」列 = 载体（L0 数据面契约 / L0-static 静态断言 / L1 plugins 纯函数 / L2 隔离真实链路 / L3 UI 冒烟 / L4 CI 门禁 / 评审）。
> 追溯列引用：T-119 验收口径（AC-R1-x / AC-R2-x / AC-R3-x / AC-R4-x / AC-R5-x）、T-121 TASK_BREAKDOWN §1 机器验收行（「Sx 验收 n」= 该片 DoD 分句序号）、决策/默认值（A1/G1/D-x 等）、不变量（I-x）、假设（A-x）。每行 = 一条可执行用例：前置条件 → 操作步骤 → 期望结果 / 通过判据（PASS/FAIL 唯一线，§3）。
> 命名空间：TC-S<n>-<m> 仅指本文档新增用例（与 chat.test.mjs 既有 TC-S1-xx / TC-S9-xx 命名风格一致但不冲突；plugins 既有 TC-S10-* 作为回归基线被引用不重号）。

### 4.0 现状缺口 → 切片 → 用例索引（供 coder 先复现后实现、tester 回归对照）

| 缺口（REQUIREMENTS §2 现状证据） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 执行层笼统失败文案「回复子代理未完成（error）」不可行动（live msg2 现场） | S1 | TC-S1-01..08 |
| G2 运行前提（守护/模型/开关）对 UI 不可见、无预防提示 | S2/S7 | TC-S2-01..09、TC-S7-04..07 |
| G3 「全部空间」视图对话中心无选择入口（死路卡） | S7 | TC-S7-01/02/03 |
| G4 回复设置 UI 无入口（文档超前 UI） | S7 | TC-S7-08/09/10 |
| G5 回复方无空间真实内容上下文（无仓库可见性） | S4/S5/S6 | TC-S4-01..09、TC-S5-02/06、TC-S6-01/03/07 |
| G6 无附件数据面（编辑器纯文本、messages 无附件概念） | S3/S8 | TC-S3-01..17、TC-S8-01..12 |
| G7 无公共护栏（预算/类型/审计/TTL/隔离） | S3/S5/S6 | TC-S3-11..16、TC-S4-04/05、TC-S5-05/10、TC-S6-05/09 |
| G8 文档超前 UI + 排障表缺「AI 不回/失败怎么办」 | S9 | TC-S9-01..09 |
| G9 live 库不可写入 → 全部验证临时库/隔离实例 | 全批 | TC-S1-11、TC-S3-16、TC-S6-07/08/09（I-2） |

### 4.1 S1 执行层失败可行动化【R-1 · plugins 链起点】——自动化：L1 node plugins/tests/chat-error-classifier.test.mjs（需先 build lib）+ L2 fake 子代理隔离复现 + L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | S1 合入（plugins/src/chatErrorClassifier.ts 导出纯函数；plugins/lib 已构建） | 运行分类映射表用例：对五类别各 ≥1 组代表性输入（model-unavailable：stopReason=error 且 error 含 unknown model / model not found / not authorized；provider-error：error 含 key / 401 / 429 / quota / connection / ECONNREFUSED；timeout-aborted：result=null 与 timeout 语义；foreman-down：守护 foreman 不可用语义；empty-other：其余）断言返回类别与可行动文案 | 每类别 ≥1 断言通过；类别枚举恰为 model-unavailable / provider-error / timeout-aborted / foreman-down / empty-other 五类；每类文案非空且含恢复指引语义（重试/配置/模型等关键词至少其一）；node plugins/tests/chat-error-classifier.test.mjs exit 0——S1 DoD 分句 1 | L1 | AC-R1-3；S1 验收 1；A1 |
| TC-S1-02 | 🟢 P0 | 同 TC-S1-01 | timeout-aborted 输入 → 断言文案沿用「超时/中止」语义；foreman-down 输入 → 断言文案含「守护 foreman 不可用」 | 两条语义断言通过，与既有 server.mjs 超龄兜底 / index.ts:2409 foreman 文案口径一致（沿用不改语义）——S1 DoD 分句 3 | L1 | D-8；S1 验收 3 |
| TC-S1-03 | 🔴 P0 | 同 TC-S1-01 | 负例注入：输入 stopReason=error 且 error 原文为 error / undefined 风格（如 error 文本 "error: undefined"），运行分类器并检查输出 | 输出不含裸「回复子代理未完成（error）」子串、不含裸 undefined 样式文案；含恢复指引（如何恢复语义）；类别落 model-unavailable 或 empty-other 且可行动——AC-R1-3 与 S1 DoD 分句 2（负例） | L1（负例） | AC-R1-3；S1 验收 2 |
| TC-S1-04 | 🔴 P0 | 同 TC-S1-01 | 边界输入：stopReason 为空串 / undefined / null；error 为 undefined / 超长（约 5000 字符） | 不抛异常；落 empty-other 兜底；文案含 error 原文片段（截断 ≤500）并带重试指引——兜底不崩（S1 DoD 分句 5 兜底语义 + 边界） | L1（边界/异常） | AC-R1-3；S1 验收 5；D-8 |
| TC-S1-05 | 🟢 P0 | TC-S1-01 + 临时库（TEAM_HUB_DB=mkdtemp） | 集成锚点：answerChatMessage 以 fake 子代理注入 stopReason=error（error 文本含 unknown model）→ 走分类器 → markChatFailed 回写 | 源消息 meta.aiStatus=failed、aiError=分类可行动文案（含恢复指引、不含裸文案）、aiError ≤500、消息退出 awaiting 队列；全程临时库（I-2）——AC-R1-3 与 S1 DoD 分句 4/5 | L2（fake 子代理 + tmp-DB） | AC-R1-1/3；S1 验收 4/5 |
| TC-S1-06 | 🟢 P0 | 同 TC-S1-05 | 成功分支：fake 子代理 stopReason=completed 且含回复 → answerChatMessage 走 replied 路径，检查日志/审计 | 回复消息落库（author=配置身份）；源消息 meta.aiStatus=replied；成功分支日志（log 捕获或审计）含实际选用 provider 与 model 名——S1 DoD 分句 4 后半 | L2 | AC-R1-2；S1 验收 4 |
| TC-S1-07 | 🟡 P0 | 同 TC-S1-05 | 构造超长 error 文本（>600 字符）经分类器回写 | 服务端 failAiReply 上限 500 契约不回归：aiError 存储长度 ≤500，UTF-8 安全截断（不产生半个代理字符）——server.mjs:1204 | L2（tmp-DB） | AC-R1-3；server.mjs:1204 契约 |
| TC-S1-08 | 🔴 P0 | 同 TC-S1-05 | catch 吞错路径负例注入：让 answerChatMessage 在子代理 start 阶段抛异常（fake start 直接 throw） | 异常被 catch 后仍经分类器/兜底生成可行动文案回写（含原文片段 ≤300 亦可，但**不得**为裸「回复子代理未完成（error）」）；消息不悬挂在 awaiting——S1 DoD 分句 4 catch 区改造 | L2（负例注入） | AC-R1-3；S1 验收 4 |
| TC-S1-09 | 🔴 P0 | S1 实现合入后 | L0-static：grep plugins/src 全目录「回复子代理未完成（」兜底文案 | 命中数 =0（旧笼统文案全量替换为分类器输出）——S1 DoD 分句 6 | L0-static（grep） | AC-R1-3；S1 验收 6 |
| TC-S1-10 | 🔴 P0 | S1 实现合入后 | L0-static：grep 自动重试逻辑（重试计数/退避/定时自动重答）与历史消息自动回填逻辑（对无 aiStatus 旧消息批量标记或重答的函数/调用） | 无新增自动重试、无历史消息自动回填逻辑（D-5/D-8 不变）；手动重试仍走既有 retryChatReply/API retry——S1 DoD 分句 7 | L0-static（grep + git diff） | D-5；D-8；AC-R1-8；S1 验收 7 |
| TC-S1-11 | 🟢 P0 | S1 实现合入 + 隔离 hub 可达 | AC-R1-1 隔离复现锚点：临时库构造同构 awaiting 消息（software 会话「hi」型），fake 子代理 error，CHAT_REPLY_TIMEOUT_MS 注入小值，观察完整时序并记录命令+输出 | 复现记录含：发送 → meta.aiStatus=awaiting → 窗口内 → failed + 分类可行动文案（含恢复指引）；复现脚本内无 live 库路径引用断言（I-2）——AC-R1-1 | L2 复现脚本 | AC-R1-1；S1 验收 5 |
| TC-S1-12 | 🔴 P0 | S1 全部合入 | 回归门禁：node team-hub/chat.test.mjs（既有 23 例）；plugins typecheck（环境受限时记录复现步骤与输出）；依赖清单核对 | chat.test.mjs exit 0（既有 23 例不回归）；plugins typecheck 0 诊断或如实记录受限证据；零新增运行时依赖（I-1）——S1 DoD 收尾 | L0 + L1 + 评审 | AC-R1-7；I-1 |

### 4.2 S2 对话健康端点 + 守护心跳 + daemon chat 状态【R-1 · server.mjs 链起点】——自动化：L0 node team-hub/chat.test.mjs「health」describe + L2 心跳冒烟 + L0-static daemon.json

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | S2 合入（server.mjs health 聚合 + 路由；chat.test.mjs 追加 describe） | GET /api/chat/health?scope=software（listen(0) 或 DAO 直调） | 200 JSON 含四输入聚合：守护在线判定（members lastSeenAt 60s 窗）、本空间回复开关 enabled、模型解析结果（settings.model → agent_models role=assistant → 守护默认合成）、最近 failed 消息 aiError（无则空/缺省可空）——S2 DoD 分句 1 | L0 | AC-R1-3；S2 验收 1 |
| TC-S2-02 | 🟡 P0 | 同 TC-S2-01 | members 心跳窗三值：构造 lastSeenAt 距今 59s / 61s / 无守护行三种（时间插桩或直写 members 表） | <60s → 守护在线=true；≥60s → false；无行 → false 不误判；与既有 members online 判定（server.mjs:2378-2384）口径一致——S2 DoD 分句 1 边界 | L0（三值） | AC-R1-3；S2 验收 1 |
| TC-S2-03 | 🟢 P0 | 同 TC-S2-01 | saveReplySettings(enabled:false) 后 GET health | health 报 enabled=false（UI 黄态数据源）；回复开关持久化契约 TC-S9-02 不回归 | L0 | AC-R1-5；S2 验收 1 |
| TC-S2-04 | 🟢 P0 | 同 TC-S2-01 | 模型解析链矩阵：settings.model 有/无 × agent_models role=assistant 行 有/无 → health.model | 与实现解析函数一致：settings.model 优先 → agent_models → 守护默认；全部缺失 → null/空并带诚实标注；矩阵 ≥2 组断言——S2 DoD 分句 1 | L0 | S2 验收 1 |
| TC-S2-05 | 🟢 P0 | 同 TC-S2-01 | 构造一条 failed 消息（aiError=分类可行动文案）→ GET health | 最近失败字段透出该 aiError 文案（UI 红态数据源）——S2 DoD 分句 1 | L0 | AC-R1-3；S2 验收 1 |
| TC-S2-06 | 🔴 P0 | 同 TC-S2-01 | HTTP 非法入参：GET /api/chat/health 无 scope 参数；scope 含非法字符 | 400 + 可读错误文案；不 500；不产生任何写——S2 DoD 分句 1 | L0（HTTP） | S2 验收 1 |
| TC-S2-07 | 🟢 P0 | 同 TC-S2-01 | GET health 前后比对 audit 行数与 conversations/messages/chat_reply_settings 内容 | 只读零写入：audit 无新增行、四表无变化（I-8）——S2 DoD 分句 4 | L0 | I-8；S2 验收 4 |
| TC-S2-08 | 🟢 P0 | 同 TC-S2-01 | 断言 health 响应含诚实标注 | 响应含「已解析不代表 provider 实际可用」语义（字段/文案），不冒充可用性（防假绿 RK-6）——S2 DoD 分句 4 | L0 | AC-R1-3；S2 验收 4 |
| TC-S2-09 | 🟢 P0 | S2 合入 + 宿主守护可达 | 守护运行数轮（触发心跳）后 GET /api/members | 存在 kind=worker 的守护成员且 online=true（lastSeenAt<60s）；复用 POST /api/heartbeat（server.mjs:2163）；宿主不可达时如实记录复现步骤与输出（R-18）——S2 DoD 分句 2 | L2 冒烟 | S2 验收 2 |
| TC-S2-10 | 🟢 P0 | S2 合入 | 守护跑至少一轮 chat sweep 后读取 daemon.json（writeDaemonStatus 输出路径） | daemon.json 含 chat.lastReplyAt / chat.lastFailAt / chat.lastFailReason 字段（追加不破坏既有键）——S2 DoD 分句 3 | L0-static | S2 验收 3；B2 |
| TC-S2-11 | 🔴 P0 | S2 全部合入 | 回归门禁：node team-hub/chat.test.mjs（既有 23 + 健康用例）；plugins typecheck（受限记录） | exit 0 全绿（既有 23 例不回归 + 健康用例 pass）；plugins typecheck 0 或如实记录受限证据；零新增运行时依赖（I-1）——S2 DoD 分句 1/5 | L0 + 评审 | AC-R1-7；I-1 |

### 4.3 S3 附件数据面（服务端）【R-3/R-4 · 决策 E1+G1】——自动化：L0 node team-hub/chat.test.mjs「attachments」describe（env 小值覆写）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | S3 合入（chat_attachments 表 + 上传/取回/绑定/清理端点） | PUT /api/chat/attachments?scope=software（raw body = 合法 UTF-8 文本，内含独有事实串 QX-7788，正常 Content-Length） | 200 {id,fileName,size}；行 status=staged；uploads 落盘文件存在且内容一致（临时目录内）——S3 DoD 分句 1 | L0 | AC-R3-1；S3 验收 1 |
| TC-S3-02 | 🔴 P0 | 同 TC-S3-01 | 黑名单扩展名上传：evil.exe / archive.zip / image.png 各一次 | 每次 4xx + 可读拒绝文案；无行、无落盘——S3 DoD 分句 2（反向） | L0（负例） | AC-R3-3；AC-R4-2；S3 验收 2 |
| TC-S3-03 | 🔴 P0 | 同 TC-S3-01 | 伪装 .txt 的非法 UTF-8 字节流上传（如含 0xFF 0xFE 序列） | 4xx 文案含「无法作为上下文（非 UTF-8 文本）」；无行、无落盘——UTF-8 fatal 校验（S3 DoD 分句 2） | L0（负例） | AC-R3-3；AC-R4-2；S3 验收 2 |
| TC-S3-04 | 🔴 P0 | 同 TC-S3-01 + CHAT_ATTACH_MAX_BYTES=32 | 上传 33 字节文本（Content-Length 预检） | 4xx 可读（超大小）；无行、无落盘——S3 DoD 分句 3 | L0（env 小值） | AC-R3-3；S3 验收 3 |
| TC-S3-05 | 🔴 P0 | 同 TC-S3-01 + CHAT_ATTACH_MAX_PER_MSG=1 | postMessage 携带 2 个 attachmentIds | 4xx 可读（超数量）；消息不落库——S3 DoD 分句 3 | L0（env 小值） | AC-R3-3；S3 验收 3 |
| TC-S3-06 | 🟡 P0 | 同 TC-S3-01 + CHAT_ATTACH_MAX_BYTES=32 | 三值上界：上传恰 32 字节文本 | 接受成功（==上限 通过）；33 字节拒绝（TC-S3-04 佐证）——三值法上界断言 | L0（边界） | AC-R3-3；§3 三值法 |
| TC-S3-07 | 🟢 P0 | 同 TC-S3-01 | 先上传 2 个合法文本 → postMessage(body=普通文本, attachmentIds=[a1,a2]) | 消息落库；meta.attachments=[{id,fileName,size}] 只存引用；attachments 行 status=sent 且 msg_id/conv_id 绑定；messages.body 不含任何文件全文——S3 DoD 分句 4 | L0 | AC-R3-1；AC-R4-3；S3 验收 4 |
| TC-S3-08 | 🟢 P0 | 同 TC-S3-01 | GET /api/chat/attachments/content?id=<本人会话已绑定附件> | 200 返回 UTF-8 文本原文；仅拥有会话/scope 可读——S3 DoD 分句 5 | L0 | AC-R3-5；S3 验收 5 |
| TC-S3-09 | 🔴 P0 | 同 TC-S3-01 | 跨会话/跨 scope 取回：同 scope 另一会话、另一 scope 会话分别请求同一附件 id | 均 4xx（403/404，归属校验拒绝）且响应不含文件内容——S3 DoD 分句 5（反向） | L0（负例） | AC-R3-5；S3 验收 5 |
| TC-S3-10 | 🔴 P0 | 同 TC-S3-01 | postMessage 携带悬空 attachmentIds（不存在 id / 他 scope 的 staged 附件 id） | 400 可读（悬空引用拒绝）；消息不落库——引用完整性 | L0（负例） | AC-R3-3 |
| TC-S3-11 | 🟡 P1 | 同 TC-S3-01 + CHAT_ATTACH_STAGED_TTL_MS=50 | 上传后不绑定（保持 staged），等 TTL 到期触发清理（或直调清理函数） | staged 孤儿行 + 落盘文件被清理；未到期（时间未过）不清理——孤儿 24h 默认语义小值覆写（S3 DoD 分句 6） | L0（TTL 小值） | AC-R4-6；S3 验收 6 |
| TC-S3-12 | 🟡 P1 | 同 TC-S3-01 + CHAT_ATTACH_TTL_MS=60 | 绑定为 sent 后等 TTL 到期触发清理 | sent 过期行 + 文件被清理（默认 7 天语义小值覆写）；TTL 默认值与生命周期在代码注释/文档化（D-3）——S3 DoD 分句 6 | L0（TTL 小值） | AC-R4-6；S3 验收 6；D-3 |
| TC-S3-13 | 🟢 P1 | 同 TC-S3-01 | 依序执行 上传 / 绑定 / 取回 / 清理 四动作后查询 audit 表 | 每动作产生 chat:attachment* 审计行，detail JSON 含 fileName/size/scope（绑定/取回含 conv/msg_id 可断言）——S3 DoD 分句 7 / AC-R4-4 | L0 | AC-R4-4；S3 验收 7 |
| TC-S3-14 | 🟢 P0 | 同 TC-S3-01 | 新库启动含表；另构造无 chat_attachments 表的旧库（含 conversations/messages 存量数据）后 import server.mjs | CREATE TABLE IF NOT EXISTS 幂等：两种库均自动建表、旧库 chat 存量完整无损、可继续上传/绑定（零迁移）——S3 DoD 分句 8 | L0 | S3 验收 8 |
| TC-S3-15 | 🔴 P1 | S3 实现合入后 | 负例断言：对 TC-S3-07 落库消息做 messages.body 与 meta JSON 的文件正文片段正则（独有事实串 QX-7788） | 文件内容片段在 body/meta 中 0 命中（只存引用）——AC-R4-3 直接断言（S3 DoD 分句 10） | L0-static + L0 | AC-R3-1；AC-R4-3；S3 验收 10 |
| TC-S3-16 | 🟡 P0 | 同 TC-S3-01 | 检查 uploads 落盘目录基路径与测试产物 | uploads 与 TEAM_HUB_DB 同基（临时库 → uploads 落在 mkdtemp 内）；测试产物路径不含 live 库目录（I-2）——S3 DoD 分句 9 | L0（路径断言） | I-2；S3 验收 9 |
| TC-S3-17 | 🔴 P0 | S3 全部合入 | 回归门禁：node team-hub/chat.test.mjs（既有 23 + 健康 + 附件全部用例）；依赖清单核对 | exit 0 全绿（既有 23 例不回归 + 附件用例全绿）；零新增运行时依赖（I-1）——S3 DoD 收尾 | L0 + 评审 | AC-R3-6；AC-R1-7；I-1 |

### 4.4 S4 空间摘要纯模块 buildSpaceDigest【R-2 · 决策 C1】——自动化：L1 node plugins/tests/space-digest.test.mjs（tmp fixture 仓库）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | S4 合入（plugins/src/spaceDigest.ts 导出 buildSpaceDigest） | 构造 tmp fixture 仓库（含 allowlist 文件 README.md / LEGION.md / AGENTS.md，内容含已知事实串；含子目录与普通文件）→ buildSpaceDigest({dir, budget}) | digest.text 含 allowlist 文件内容片段与顶层目录/文件结构（目录在前）；sources 含读取来源清单；truncated=false——AC-R2-3 摘要侧与 S4 DoD 分句 1 | L1（fixture） | AC-R2-3；AC-R4-1；S4 验收 1 |
| TC-S4-02 | 🔴 P0 | 同 TC-S4-01 | 向 fixture 塞入噪声（.git / node_modules / dist / build / .legion-worktrees 及其内部文件）→ buildSpaceDigest | digest.text **不含**噪声目录名/其内部文件名（0 命中）；噪声目录不进 sources——S4 DoD 分句 1 反向 | L1（负例） | AC-R2-3；S4 验收 1 |
| TC-S4-03 | 🟢 P0 | 同 TC-S4-01 | 同一 fixture 连续两次 buildSpaceDigest，比对输出与顺序 | 两次输出完全一致（确定性）；顶层结构目录在前文件在后、allowlist 顺序稳定——S4 DoD 分句 1（顺序稳定） | L1 | AC-R2-3；S4 验收 1 |
| TC-S4-04 | 🟡 P1 | 同 TC-S4-01 | budget 小值（如 120 字符）→ buildSpaceDigest | 输出 ≤budget、truncated=true、截断处带「（已截断）」标记；不抛——摘要侧预算截断（S4 DoD 分句 1 超预算截断，AC-R4-1） | L1（边界） | AC-R4-1；S4 验收 1 |
| TC-S4-05 | 🟡 P1 | 同 TC-S4-01 | fixture 内 allowlist 文件内容超单文件上限（CHAT_CTX_FILE_CAP_CHARS 小值覆写或构造超长文件） | 单文件片段被截断并带标记；不整体丢弃该文件且不抛——S4 DoD 分句 1 单文件截断 | L1（边界） | AC-R4-1；S4 验收 1 |
| TC-S4-06 | 🟡 P0 | 同 TC-S4-01 | 边界输入：目录不存在 / 空目录 / 只读权限不足目录 / allowlist 文件为二进制（UTF-8 解码失败） | 不抛异常；返回空摘要或明示占位（text 空 + 原因标记）——无绑定/读取失败不崩（S4 DoD 分句 2，AC-R2-4 摘要侧） | L1（边界） | AC-R2-4；S4 验收 2 |
| TC-S4-07 | 🔴 P0 | S4 合入后 | 源码静态断言：spaceDigest.ts 无 child_process / spawn / exec 引用；对 fixture 调用前后比对目录内容（文件清单+内容哈希） | 源码 0 子进程引用（只读 fs 实现）；调用不产生任何写（目录快照前后一致）——S4 DoD 分句 3 | L0-static + L1 | I-6；S4 验收 3 |
| TC-S4-08 | 🔴 P0 | S4 合入后 | git diff 检查 S4 合入 commit 的文件清单 | plugins/src/index.ts 未被 S4 修改（diff 为空；改动仅 spaceDigest.ts + 其测试）——S4 DoD 分句 4（接线归 S6） | L0-static（git diff） | S4 验收 4 |
| TC-S4-09 | 🟢 P0 | 同 TC-S4-01 | allowlist 空数组/仅元数据场景 → buildSpaceDigest | 无 allowlist 时仍产出空间元数据块 + 顶层结构块（不为空或明示无内容），不抛——模块输入契约边界 | L1 | S4 验收 1（allowlist 可配） |
| TC-S4-10 | 🔴 P0 | S4 全部合入 | 回归门禁：node plugins/tests/space-digest.test.mjs（需先 build lib；受限记录）；plugins typecheck；依赖清单 | 测试全绿 exit 0 或如实记录受限证据；plugins typecheck 0（受限记录）；零新增运行时依赖（I-1）——S4 DoD 收尾 | L1 + 评审 | I-1；S4 DoD 收尾 |

### 4.5 S5 提示词构建器扩展【R-2/R-3/R-4 · 决策 D1 纯函数层】——自动化：L1 node plugins/tests/chat-responder.test.mjs（既有 TC-S10-* + 新 describe）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | S5 合入（chatResponder.ts ChatAnswerInput 扩展） | 运行既有 TC-S10-* 全套（chatIdentityFor 身份解析 / 禁工具声明 / 无历史不崩 / 纯文本基座） | 既有用例全部 pass 不回归——S5 DoD 分句 1 | L1（回归） | S5 验收 1 |
| TC-S5-02 | 🟢 P0 | 同 TC-S5-01 | 输入含 spaceDigest（含来源说明+生成时间）→ buildChatAnswerPrompt | 输出含「工作空间只读上下文」块，来源/生成时间可见，内容置入且在会话历史块之前——S5 DoD 分句 2 | L1 | AC-R2-3；S5 验收 2 |
| TC-S5-03 | 🟢 P0 | 同 TC-S5-01 | 输入含 attachments=[{id,fileName,size,content}] → buildChatAnswerPrompt | 输出含「本次随消息上传的文件」块（文件名+大小+内容），位于摘要块之后、会话历史之前——S5 DoD 分句 3 | L1 | AC-R3-2；S5 验收 3 |
| TC-S5-04 | 🟢 P0 | 同 TC-S5-01 | 输入 spaceDigest 与 attachments 均缺省 → buildChatAnswerPrompt | 不产出「工作空间只读上下文」块与「上传文件」块；输出与旧版基座语义一致（向后兼容）——S5 DoD 分句 4 | L1 | S5 验收 4 |
| TC-S5-05 | 🟡 P1 | 同 TC-S5-01 | 构造 摘要+附件 合计超预算（CHAT_CTX_BUDGET_CHARS 小值或超长输入）→ buildChatAnswerPrompt | 预算分配先裁摘要保附件：摘要被裁/标记、用户最新附件保留完整或带「（已截断）」标记；输出仍完整可解析（角色→…→提问顺序不缺）——S5 DoD 分句 5（AC-R4-1） | L1（边界） | AC-R4-1；AC-R4-6；S5 验收 5 |
| TC-S5-06 | 🟢 P0 | 同 TC-S5-01 | 输入 spaceDigest 为空/未绑定语义（text 空 + 原因标记）→ buildChatAnswerPrompt | 输出含明示降级占位「（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）」，回答继续不冒充——AC-R2-4（S5 DoD 分句 6） | L1 | AC-R2-4；AC-R4-5；S5 验收 6 |
| TC-S5-07 | 🔴 P0 | 同 TC-S5-01 | 输入 attachments 元素 content 为失败占位标记（如 {error:读取失败} 或 content=null 且带 name）→ buildChatAnswerPrompt | 输出该附件块为「（附件 <name> 读取失败：原因）」占位，不含假内容，其余块正常——附件失败占位（AC-R4-5） | L1（负例注入） | AC-R4-5；S5 验收 6 |
| TC-S5-08 | 🟢 P0 | 同 TC-S5-01 | 全量输入（摘要+附件+历史）→ 子串位置断言 | 块顺序 = 角色 → 行为约束/禁工具 → systemHint → 工作空间上下文 → 上传文件 → 会话历史 → 提问，各块 index 单调递增——TASK_BREAKDOWN §3.1 契约 | L1 | S5 验收 2/3 |
| TC-S5-09 | 🔴 P0 | 同 TC-S5-01 | 在 systemHint / 附件内容 / 历史中注入 HTML 危险串（script 标签、img onerror 等）→ buildChatAnswerPrompt | 输出不含原样可执行 HTML 注入面（纯文本输出，无 script 等原文标签或已剔除）；静态断言无 dangerouslySetInnerHTML——I-5（S5 DoD 分句 7） | L1 + L0-static | I-5；S5 验收 7 |
| TC-S5-10 | 🟡 P1 | 同 TC-S5-01 | 单个附件内容超单文件上限（CHAT_CTX_FILE_CAP_CHARS 小值）→ buildChatAnswerPrompt | 单附件截断并带「（已截断）」标记，文件名/大小横幅保留——S5 DoD 分句 5 附件侧（AC-R4-1） | L1（边界） | AC-R4-1；S5 验收 5 |
| TC-S5-11 | 🔴 P0 | 同 TC-S5-01 | 异常输入：attachments 非数组 / 元素缺 name / content 非字符串 → buildChatAnswerPrompt | 不抛异常；按占位/跳过处理，输出不崩——纯函数输入契约兜底 | L1（异常） | S5 验收 6（兜底） |
| TC-S5-12 | 🔴 P0 | S5 全部合入 | 回归门禁：node plugins/tests/chat-responder.test.mjs（既有 TC-S10 + 新增）；plugins typecheck（受限记录） | 全绿 exit 0 或如实记录受限证据；零新增运行时依赖（I-1）——S5 DoD 收尾 | L1 + 评审 | I-1；S5 DoD 收尾 |

### 4.6 S6 守护上下文接线【R-2/R-3/R-4 · 决策 D1+E1 守护侧收口】——自动化：L2 隔离 hub+守护+fake 子代理（prompt 捕获断言）+ L0-static

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P0 | S1/S2/S3/S4/S5 合入 + 隔离 hub | answerChatMessage 前经 spaceDigest 模块构造摘要（绑定仓库根，即 spaceBinding.localDir）并传入 buildChatAnswerPrompt | fake 子代理捕获到的最终 prompt 含 spaceDigest 内容（allowlist 片段/顶层结构）；无绑定仓库 → 摘要为空并走占位——S6 DoD 分句 1 | L2（prompt 捕获） | AC-R2-3；S6 验收 1 |
| TC-S6-02 | 🟢 P0 | 同 TC-S6-01 | 消息 meta.attachments 有引用 → 守护逐个 GET /api/chat/attachments/content 取回文本并注入 | prompt 含附件内容块（名+大小+内容）；单附件超 CHAT_CTX_FILE_CAP_CHARS 被截断带标记；取回次数与附件数一致——S6 DoD 分句 2 | L2 | AC-R3-2；S6 验收 2 |
| TC-S6-03 | 🔴 P0 | 同 TC-S6-01（无绑定仓库 fixture） | 摘要构造失败/仓库不可读 → answerChatMessage | 源消息**不**被标 failed（异常仅进日志）；prompt 走降级占位；消息等待正常回复或后续处理——AC-R2-4/AC-R4-5（S6 DoD 分句 3） | L2（负例注入） | AC-R2-4；AC-R4-5；S6 验收 3 |
| TC-S6-04 | 🔴 P1 | 同 TC-S6-01 | 附件取回失败（content 端点 403/404/网络错误）→ answerChatMessage | 该附件块降级占位（不注入假内容）、源消息不标 failed、回复仍可进行——S6 DoD 分句 3 附件侧 | L2（负例注入） | AC-R4-5；S6 验收 3 |
| TC-S6-05 | 🟡 P1 | 同 TC-S6-01 + CHAT_CTX_BUDGET_CHARS 小值 | 摘要+附件合计超预算 → 预算分配经 S5 纯函数执行 | 先裁摘要后裁附件；最终注入合计 ≤预算且用户最新附件保留；截断处带标记——S6 DoD 分句 4（AC-R4-1） | L2（env 小值） | AC-R4-1；S6 验收 4 |
| TC-S6-06 | 🔴 P0 | S6 合入后 | 负例断言：发送带附件消息 → fake completed 回复后，检查源消息与回复消息的 body/meta | 附件文件全文在 messages.body / meta（含回复消息）0 命中；内容仅出现在当次 prompt——S6 DoD 分句 5 静态+集成（AC-R4-3） | L0-static + L2 | AC-R4-3；S6 验收 5 |
| TC-S6-07 | 🟢 P0 | 同 TC-S6-01（fixture 绑定仓库含已知事实） | 绑定仓库空间提问事实题（如「仓库顶层有哪些目录」）→ fake 子代理捕获 prompt | prompt 含绑定仓库真实结构/allowlist 事实（确定性代理：回答「能引用真实内容」的前提成立）；真模型定性抽测由 E2E-2 在 tester L2 执行——AC-R2-3 | L2 | AC-R2-3；S6 验收 6 |
| TC-S6-08 | 🟢 P0 | 同 TC-S6-01 | 上传含独有事实串（如 UNIQ-FACT-4417）的文本随消息发送 → 捕获 prompt；对照组：同一问题不带附件发送 | 带附件组 prompt 含 UNIQ-FACT-4417；不带附件组 prompt 不含该串——AC-R3-2 对照断言（上下文真实生效） | L2（对照） | AC-R3-2；S6 验收 6 |
| TC-S6-09 | 🟢 P0 | 同 TC-S6-01 | 连续两问：第一问带附件（含 UNIQ-FACT-4417），第二问不带附件 → 捕获第二问 prompt | 第二问 prompt 不含 UNIQ-FACT-4417（附件上下文仅当次有效，不跨消息持久）——AC-R4-6（S6 DoD 分句 6） | L2 | AC-R4-6；S6 验收 6 |
| TC-S6-10 | 🔴 P0 | S6 全部合入 | 回归门禁：node team-hub/chat.test.mjs exit 0；plugins typecheck（受限记录）；依赖清单核对 | chat.test.mjs 不回归 exit 0；plugins typecheck 0 或如实记录受限证据；零新增运行时依赖（I-1）——S6 DoD 收尾 | L0 + 评审 | AC-R1-7；I-1；S6 DoD 收尾 |

### 4.7 S7 UI 前置：选空间入口 + 健康状态条 + 回复设置【R-1/R-2 · 决策 B1+F1】——自动化：L3 浏览器驱动冒烟 + L0-static 源码断言 + pnpm build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🔴 P0 | S7 合入 | L0-static：grep ChatView.tsx !scope 分支（:250-261 区域） | 旧死路卡文案（「请先选择具体工作空间」「全部空间视图不可发消息」式提示独占视图）已被替换；存在「选择工作空间开始对话」入口元素/文案——AC-R1-6/R2-1 反向残留检测 | L0-static + L3 | AC-R1-6；AC-R2-1；S7 验收 1 |
| TC-S7-02 | 🟢 P0 | S7 合入 + workbench dev server | 冒烟：默认全部空间视图 → 点击「选择工作空间开始对话」→ 空间列表（fetch /api/spaces）→ 选 software | 经 onPickScope → App.setScope(software) 进入会话态；composer 可输入可发送；会话按 software 加载——AC-R1-6/AC-R2-1（S7 DoD 分句 1） | L3 | AC-R1-6；AC-R2-1；S7 验收 1 |
| TC-S7-03 | 🟢 P0 | 同 TC-S7-02 | 在 software 会话发消息 → 切到另一空间（如 marketing）→ 回 software | 会话头部标识当前关联空间；切换后会话列表/消息/回复身份随新空间（无串显，沿用 R-A5 守卫）；回 software 历史完整——AC-R2-2（S7 DoD 分句 1/4） | L3 | AC-R2-2；S7 验收 1 |
| TC-S7-04 | 🟢 P0 | 同 TC-S7-02（守护在线 + 开关开 + 模型已解析） | 打开对话中心 chat-head 区 | 健康状态点绿态（守护在线+开关开+模型已解析），无修复动作提示——S7 DoD 分句 2 | L3 | AC-R1-3；S7 验收 2 |
| TC-S7-05 | 🟡 P0 | 同 TC-S7-02（守护离线或开关关或模型未解析之一） | 打开对话中心 | 状态点黄态 + 对应修复动作文案（如「守护离线：请启动守护进程」「回复未开启」「模型未配置」），不静默——AC-R1-3 可见化（S7 DoD 分句 2） | L3（状态注入） | AC-R1-3；S7 验收 2 |
| TC-S7-06 | 🔴 P0 | 同 TC-S7-02（最近一次回复 failed） | 打开对话中心 | 状态点红态 + 可行动失败文案 + 重试指引（消费 S1 分类文案），不得显示绿态——失败不得静默/假绿（AC-R1-3；S7 DoD 分句 2 反向） | L3 | AC-R1-3；S7 验收 2 |
| TC-S7-07 | 🟡 P0 | 同 TC-S7-02（/api/chat/health 端点缺失 404） | 打开对话中心 | 状态点灰态（端点缺失不误导），界面其余功能正常——S7 DoD 分句 2 灰态 | L3（端点 stub） | S7 验收 2 |
| TC-S7-08 | 🟢 P0 | S7 合入 | 打开回复设置弹窗（chat-head 齿轮） | fetchChatReplySettings 回填：enabled 开关必含且默认开；model/identity/systemHint 为可选字段；保存调用 saveChatReplySettings 并持久化——AC-R1-5（S7 DoD 分句 3） | L3 | AC-R1-5；S7 验收 3 |
| TC-S7-09 | 🔴 P0 | 同 TC-S7-08 | 设置 enabled=false → 发送一条普通消息 → 查服务端 | 该消息 meta 无 aiStatus=awaiting（零出站、不进回复队列）；人-人消息本身正常可见——AC-R1-5 反向（S7 DoD 分句 3） | L3 + L0 | AC-R1-5；S7 验收 3 |
| TC-S7-10 | 🟢 P0 | 接 TC-S7-09 | 再设置 enabled=true → 发送新消息 → 查服务端 | 新消息 meta.aiStatus=awaiting（开关恢复出站）；与 TC-S9-03/04 既有语义一致——AC-R1-5 恢复路径 | L3 + L0 | AC-R1-5；S7 验收 3 |
| TC-S7-11 | 🔴 P0 | 同 TC-S7-02（构造一次失败回复） | 发送消息 → 回复失败 → 观察 UI | 源消息下 ❌ 气泡显示与后端一致的分类可行动文案（不透传裸 error/undefined）；「↻ 重试」按钮存在可点——AC-R1-3/4（S7 DoD 分句 4） | L3 | AC-R1-3；AC-R1-4；S7 验收 4 |
| TC-S7-12 | 🔴 P0 | S7 合入 | L0-static：grep ChatView.tsx / api.ts dangerouslySetInnerHTML 与内联 HTML 直插 | 命中 0（服务端文本/附件名渲染安全，I-5）——S7 DoD 分句 5 | L0-static | I-5；S7 验收 5 |
| TC-S7-13 | 🔴 P0 | S7 全部合入 | 回归门禁：pnpm --dir workbench build（tsc 0 诊断 + vite build）；既有 chat 前端冒烟（无附件发送、chat-s2-smoke 9 项） | build 全绿 0 诊断（受限如实记录复现步骤）；无附件发送与既有前端不回归；零新增依赖（I-1）——S7 DoD 收尾 | L3 + 评审 | AC-R1-6；I-1；S7 DoD 收尾 |

### 4.8 S8 UI 附件行【R-3 · 决策 F1 附件部分】——自动化：L3 浏览器驱动冒烟 + L0-static + pnpm build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P0 | S8 合入（S3+S7 已完成） | 打开对话 composer 区 | 存在 📎 附件入口（隐藏 input type=file multiple 触发）——S8 DoD 分句 1 | L3/L0-static | AC-R3-1；S8 验收 1 |
| TC-S8-02 | 🟢 P0 | 同 TC-S8-01 | 选择 1 个文本文件 | 发送前附件 chip 行出现（文件名+大小），可移除（×按钮）——S8 DoD 分句 1 | L3 | AC-R3-1；S8 验收 1 |
| TC-S8-03 | 🔴 P0 | 同 TC-S8-01 | 选择黑名单扩展名文件（.exe/.zip/.png） | 客户端预检给出可读错误（红 toast/内联文案），文件不进附件槽、不触发上传——S8 DoD 分句 1/4（AC-R3-3） | L3（负例） | AC-R3-3；S8 验收 1/4 |
| TC-S8-04 | 🔴 P0 | 同 TC-S8-01 | 选择 >10MB 文件（或预检阈值注入小值） | 客户端预检可读错误（超大小），不触发上传——AC-R3-3 客户端侧 | L3（负例） | AC-R3-3；S8 验收 1 |
| TC-S8-05 | 🔴 P0 | 同 TC-S8-01 | 选择第 4 个文件（超每消息 ≤3） | 客户端预检可读错误（超数量），第 4 个不进附件槽——AC-R3-3 客户端侧 | L3（负例） | AC-R3-3；S8 验收 1 |
| TC-S8-06 | 🟢 P0 | 同 TC-S8-01 | 选择 1 个含独有事实串的文本 → 随消息发送 | 发送成功；请求经 uploadChatAttachment + postChatMessage(attachmentIds) 携带；服务端 meta.attachments 引用存在、body 无文件内容；消息旁渲染附件标识（文件名+大小，纯文本）——S8 DoD 分句 2/3/5（AC-R3-1） | L3 + L0 | AC-R3-1；AC-R4-3；S8 验收 2/3/5 |
| TC-S8-07 | 🟢 P0 | 同 TC-S8-01 | 发送失败场景（服务端 4xx/网络）→ 观察附件槽 | 发送失败保留附件槽并 toast（对齐 send 失败保留草稿语义 ChatView.tsx:312-316）；可重试——S8 DoD 分句 3 | L3 | AC-R3-3；S8 验收 3 |
| TC-S8-08 | 🔴 P0 | 同 TC-S8-01 | 上传中/发送中点击发送按钮（竞态注入） | 发送/上传中按钮禁用（disabled 或点击无效），不产生重复提交/重复上传——S8 DoD 分句 4 | L3（负例注入） | S8 验收 4 |
| TC-S8-09 | 🔴 P0 | 同 TC-S8-01 | 客户端绕过预检直发服务端拒绝场景（黑名单/超限） | UI 透传服务端可读错误（toast 非静默），消息不进队列——AC-R3-3（S8 DoD 分句 4 服务端拒绝联动） | L3 | AC-R3-3；S8 验收 4 |
| TC-S8-10 | 🔴 P0 | 同 TC-S8-01 | 添加附件 → 点 × 移除 → 发送消息 | 请求 payload 不含该附件（attachmentIds 为空）；服务端消息无附件引用——AC-R3-4（S8 DoD 分句 1 可移除） | L3 + L0 | AC-R3-4；S8 验收 1 |
| TC-S8-11 | 🟢 P0 | 同 TC-S8-01 | 不带附件直接发送消息（普通文本） | 与基线一致：发送成功、无附件标识、行为同 AC-R1-2/3 回归——AC-R3-6（S8 DoD 分句 7） | L3 | AC-R3-6；S8 验收 7 |
| TC-S8-12 | 🔴 P0 | S8 全部合入 | 回归门禁：types.ts 含 ChatAttachmentRef（id/name/size）；pnpm --dir workbench build（tsc 0）；grep dangerouslySetInnerHTML=0；依赖清单 | build 全绿 0 诊断（受限如实记录）；类型存在且渲染安全（I-5）；零新增依赖（I-1）——S8 DoD 收尾 | L0-static + 评审 | AC-R3-1；I-1/I-5；S8 DoD 收尾 |

### 4.9 S9 文档收口【R-5 · P2】——自动化：L0 node -e 关键句断言 + L4 check-docs 门禁

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S9-01 | 🟢 P2 | S9 合入（S1/S3/S7/S8 行为定稿） | node 断言 docs/FEATURES.md §3.9 含三要素关键句：回复设置入口位置 / 关联工作空间与上传文件操作步骤与边界 | 三要素各 ≥1 关键句命中（断言见附录 B.8）；人工核对操作步骤与实现后行为一致——AC-R5-1 | L0（node -e） | AC-R5-1；S9 验收 1 |
| TC-S9-02 | 🟢 P2 | 同 TC-S9-01 | node 断言 FEATURES/README 排障区存在「AI 不回/回复失败怎么办」行 | 含守护在线前提 + 模型前提 + 重试指引关键句 ≥1——AC-R5-2（S9 验收 2） | L0（node -e） | AC-R5-2；S9 验收 2 |
| TC-S9-03 | 🔴 P2 | 同 TC-S9-01 | 负例注入：临时删除某关键句后重跑 TC-S9-01/02 断言 | 断言失败（exit ≠ 0，证明断言真实有效）；还原后通过——AC-R5-1/2 反向 | L0（负例） | AC-R5-1；S9 验收 1 |
| TC-S9-04 | 🟢 P2 | 同 TC-S9-01 | node 断言 FEATURES §3.9 每空间 AI 开关表述 | 与实现后 UI 一致：含「对话中心内回复设置入口」位置表述，不再「文档超前 UI」（§2.6 不一致消除）——AC-R5-1 | L0（node -e） | AC-R5-1；S9 验收 1 |
| TC-S9-05 | 🔴 P2 | 同 TC-S9-01 | 负例注入：写回旧的超前表述（声称开关仅 API/无 UI 入口） | 断言失败检出矛盾表述——AC-R5-1 反向（§2.6 防回退） | L0（负例） | AC-R5-1；S9 验收 1 |
| TC-S9-06 | 🟢 P2 | 同 TC-S9-01 | 运行 node scripts/ci/check-docs.mjs | exit 0（既有 docs 门禁不回归，功能索引 F-09 锚点有效、README↔FEATURES 互链有效）——AC-R5-3 | L4 | AC-R5-3；S9 验收 3 |
| TC-S9-07 | 🔴 P2 | 同 TC-S9-01 | 负例注入：制造一个失效锚点/坏链后运行 check-docs.mjs | exit ≠ 0 且报错指向具体文件/锚点；还原后 exit 0——AC-R5-3 反向 | L4（负例） | AC-R5-3；S9 验收 3 |
| TC-S9-08 | 🔴 P2 | S9 合入后 | git diff 核对 S9 改动文件清单 | 改动仅限 docs/FEATURES.md、README.md、workbench/README.md 三文档（I-9）——S9 DoD 分句 4 | L0-static | I-9；S9 验收 4 |
| TC-S9-09 | 🟢 P2 | 同 TC-S9-01 | node 断言 README.md 引导段（:98 区域）与 workbench/README.md | 含对话中心 AI 直答/上下文操作指引关键句与 FEATURES 互链，未失效——AC-R5-1/3 | L0（node -e） | AC-R5-1；AC-R5-3；S9 验收 1 |

## 5. 关键业务规则：正向 + 反向成对（验收标准用例化的机器可复核部分）

> 规则 → 正向用例（规则成立时通过）+ 反向用例（规则被违反/非法输入时被检出或拒绝）。附录 A 脚本校验：每 BR 引用的 正向 TC 类别为 🟢、反向 TC 类别为 🔴，且引用的 TC id 在 §4 真实存在。

| BR | 业务规则（验收口径） | 正向用例 | 反向用例 | 关联 AC / 切片 |
| --- | --- | --- | --- | --- |
| BR-1 | 失败必须被分类为可行动文案（含恢复指引），而非笼统「回复子代理未完成（error）」 | TC-S1-01 | TC-S1-03 | AC-R1-3；S1 |
| BR-2 | 分类器对空/未知输入兜底不崩且仍可行动（empty-other + 原文片段 + 重试指引） | TC-S1-05 | TC-S1-04 | AC-R1-3；S1 |
| BR-3 | D-8/D-5 不变：timeout/foreman 沿用既有语义；不引入自动重试、不自动回填历史消息 | TC-S1-02 | TC-S1-10 | D-5/D-8；S1 |
| BR-4 | 附件内容只存引用，绝不进入 messages.body / meta（防泄漏进人-人面） | TC-S3-07 | TC-S3-15 | AC-R3-1/R4-3；S3 |
| BR-5 | 附件会话/scope 归属隔离：仅拥有会话可读，跨会话/跨 scope 拒绝 | TC-S3-08 | TC-S3-09 | AC-R3-5；S3 |
| BR-6 | 上传类型护栏：合法 UTF-8 文本可上传；黑名单扩展名被拒 | TC-S3-01 | TC-S3-02 | AC-R3-3/R4-2；S3 |
| BR-7 | 上传大小/数量护栏：预算内可传；超大小、超数量被拒（上限恰好值边界见 TC-S3-06，🟡） | TC-S3-01 | TC-S3-04、TC-S3-05 | AC-R3-3；S3；§3 |
| BR-8 | 摘要确定性取数：allowlist 与顶层结构入摘要；噪声（.git/node_modules 等）绝不入 | TC-S4-01 | TC-S4-02 | AC-R2-3；S4 |
| BR-9 | 上下文降级不崩不冒充：读取失败/未绑定时占位继续，源消息不标 failed | TC-S5-06 | TC-S6-03 | AC-R2-4/R4-5；S5/S6 |
| BR-10 | 附件/摘要内容仅当次提示词有效，不写入任何消息体/meta 持久面 | TC-S6-09 | TC-S6-06 | AC-R4-3/R4-6；S6 |
| BR-11 | 上传发送闭环：发送携带附件引用 + 消息旁附件标识；移除后请求不含附件 | TC-S8-06 | TC-S8-10 | AC-R3-1/R3-4；S8 |
| BR-12 | 发送/上传防竞态：失败保留附件槽可重试；发送中不得重复提交 | TC-S8-07 | TC-S8-08 | AC-R3-3；S8 |
| BR-13 | 健康状态诚实呈现：前提满足绿态；最近失败必须红态可行动而非静默/假绿 | TC-S7-04 | TC-S7-06 | AC-R1-3；S2/S7 |
| BR-14 | 回复设置开关语义：关 → 零 awaiting 零出站；开 → 新消息恢复 awaiting | TC-S7-10 | TC-S7-09 | AC-R1-5；S7 |
| BR-15 | 「全部空间」入口可用：可选空间开始对话；死路卡文案不得残留 | TC-S7-02 | TC-S7-01 | AC-R1-6/R2-1；S7 |
| BR-16 | 文档三要素（设置入口/上下文操作/失败怎么办）与实现后行为一致 | TC-S9-01 | TC-S9-03 | AC-R5-1/2；S9 |
| BR-17 | docs 门禁：check-docs 正向 exit 0；坏链/失效锚点必须 FAIL | TC-S9-06 | TC-S9-07 | AC-R5-3；S9 |

## 6. 端到端验收用例（对应 REQUIREMENTS §6 六条总口径，tester 在 T-125 的 L2/L3 逐条执行写报告）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-1 | 🟢 P0 | S1~S9 全批合入 + 隔离 hub + 守护在线 + 模型可用（fake completed；真模型宿主可选） | 选中 software 空间 → 打开/新建会话 → 输入「你好」→ 观察时间窗 | ≤120s（CHAT_REPLY_TIMEOUT_MS 可小值注入）内会话出现回复消息（author=配置身份或 software-assistant、body 非空、同一会话、audit 含 chat:message）；源消息 meta awaiting→replied；失败分支（fake error）→ ❌ 分类可行动文案 + 重试按钮可用——REQUIREMENTS §6.1 | L2/L3 | AC-R1-2/3/4；AC-R2-5；§6.1 |
| E2E-2 | 🟢 P0 | 同 E2E-1 + software 绑定真实 legion 仓库 | 从「全部空间」视图选 software 开始对话 → 事实题 ≥2（如「用一句话说明仓库顶层有哪些目录」「README 讲的产品是什么」） | 回复引用仓库真实内容：关键实体（真实顶层目录名/README 产品句）出现且无编造目录名；未绑定空间对照走降级占位不冒充——REQUIREMENTS §6.2 | L2（真模型宿主）/L3 | AC-R2-1/3/4；§6.2 |
| E2E-3 | 🟢 P0 | 同 E2E-1 | 上传含独有事实的文本文件（带特殊编号）→ 基于文件提问 → 同问不带附件对照 | 带附件回复引用独有事实；不带附件同问无该事实（对照成立，证明上下文真实生效）——REQUIREMENTS §6.3 | L2/L3 | AC-R3-1/2；§6.3 |
| E2E-4 | 🟢 P0 | 同 E2E-1（模型配置可注入不可用态） | 模型不可用 → 发消息 → 观察失败呈现 → 修复配置 → 点「↻ 重试」 | ❌ 气泡含「如何恢复」语义文案 + 健康条黄/红提示；修复配置后重试成功（awaiting→replied，幂等无第二条回复）——REQUIREMENTS §6.4 | L2/L3 | AC-R1-3/4；§6.4 |
| E2E-5 | 🟢 P0 | 同 E2E-1 | 回归面全跑：人-人收发 / 无附件消息 / node team-hub/chat.test.mjs / run-ci chat 阶段与 chat-l1/s2 smoke / 产物库路径核对 | 人-人收发正常、无附件消息行为与 R-1 一致；数据面既有 23 + 新增用例全绿 exit 0；CI chat 阶段 PASS；chat-l1-smoke（22 项）与 chat-s2-smoke（9 项）不回归；核对产物确认 live 库零写入（I-2）——REQUIREMENTS §6.5 | L0/L4 | AC-R1-7；AC-R3-6；AC-R4-3；I-2；§6.5 |
| E2E-6 | 🟢 P0 | S9 合入 | 通读 docs/FEATURES.md §3.9 与 README 对话引导段 → 运行 node scripts/ci/check-docs.mjs | 文档与实现一致：含 回复设置入口 / 关联工作空间与上传文件操作与边界 / AI 不回或回复失败怎么办 三要素 + 排障行；check-docs exit 0——REQUIREMENTS §6.6 | L0/L4 | AC-R5-1/2/3；§6.6 |

## 7. 验收口径 → 用例追溯矩阵（28 条 AC 全覆盖；附录 A 机器校验「无悬空 AC」）

| 验收口径 | 正向/主路径用例 | 反向/边界用例 | 归属切片 |
| --- | --- | --- | --- |
| AC-R1-1 隔离复现锚定 | TC-S1-05、TC-S1-11 | — | S1 |
| AC-R1-2 可回答主路径 | TC-S1-06、E2E-1 | — | S1/S7 |
| AC-R1-3 失败可行动 | TC-S1-01、TC-S5-06、TC-S7-04、TC-S2-08 | TC-S1-03、TC-S1-04、TC-S1-08、TC-S7-06 | S1/S2/S7 |
| AC-R1-4 重试闭环 | E2E-1、E2E-4、TC-S7-11 | — | S1/S7 |
| AC-R1-5 设置开关 | TC-S7-08、TC-S7-10、TC-S2-03 | TC-S7-09 | S2/S7 |
| AC-R1-6 入口可用 | TC-S7-02、TC-S7-13 | TC-S7-01 | S7 |
| AC-R1-7 数据面回归 | TC-S1-12、TC-S2-11、E2E-5 | — | S1/S2 |
| AC-R1-8 遗留消息口径 | TC-S1-10 | TC-S1-10 | S1 |
| AC-R2-1 选择空间开始对话 | TC-S7-02 | TC-S7-01 | S7 |
| AC-R2-2 关联正确/切换无串显 | TC-S7-03 | TC-S7-03（切换反向守卫） | S7 |
| AC-R2-3 上下文引用真实内容 | TC-S4-01、TC-S4-03、TC-S5-02、TC-S6-01、TC-S6-07、E2E-2 | TC-S4-02（噪声负例） | S4/S5/S6 |
| AC-R2-4 降级不崩 | TC-S4-06、TC-S5-06 | TC-S6-03 | S4/S5/S6 |
| AC-R2-5 身份与审计正确 | E2E-1（audit 断言）、TC-S1-06 | —（回归靠既有 TC-S9-05） | S1/S7 |
| AC-R3-1 上传可发送+标识+引用 | TC-S3-01、TC-S3-07、TC-S8-01、TC-S8-02、TC-S8-06 | TC-S8-10、TC-S3-15 | S3/S8 |
| AC-R3-2 基于文件作答 | TC-S5-03、TC-S6-02、TC-S6-08、E2E-3 | TC-S6-08（对照组） | S5/S6 |
| AC-R3-3 拒绝路径 | TC-S3-10、TC-S8-07 | TC-S3-02、TC-S3-03、TC-S3-04、TC-S3-05、TC-S8-03、TC-S8-04、TC-S8-05、TC-S8-09 | S3/S8 |
| AC-R3-4 移除与取消 | TC-S8-10 | TC-S8-10 | S8 |
| AC-R3-5 安全/审计/仅会话 | TC-S3-08、TC-S3-13、TC-S3-14、TC-S3-16 | TC-S3-09 | S3 |
| AC-R3-6 无附件回归 | TC-S8-11、TC-S3-17、E2E-5 | — | S3/S8 |
| AC-R4-1 预算断言 | TC-S4-04、TC-S4-05、TC-S5-05、TC-S5-10、TC-S6-05 | —（超限不截断即失败，见各用例判据） | S4/S5/S6 |
| AC-R4-2 类型断言 | TC-S3-01 | TC-S3-02、TC-S3-03 | S3 |
| AC-R4-3 泄漏断言 | TC-S3-07、TC-S8-06 | TC-S3-15、TC-S6-06 | S3/S6/S8 |
| AC-R4-4 审计断言 | TC-S3-13 | — | S3 |
| AC-R4-5 降级断言 | TC-S5-06、TC-S6-04 | TC-S5-07、TC-S6-03 | S5/S6 |
| AC-R4-6 清理与隔离断言 | TC-S3-11、TC-S3-12、TC-S6-09 | TC-S6-09 | S3/S6 |
| AC-R5-1 三要素文档一致 | TC-S9-01、TC-S9-04、TC-S9-09 | TC-S9-03、TC-S9-05 | S9 |
| AC-R5-2 排障表行 | TC-S9-02 | TC-S9-03 | S9 |
| AC-R5-3 docs 门禁不回归 | TC-S9-06、TC-S9-09 | TC-S9-07 | S9 |

## 8. 附录 A：用例文档自检（machcheck，供 runner/tester 一键复核）

> 规范脚本：docs/G-mtr3su6f-1/T122-evidence/machcheck-test-cases.mjs（零第三方依赖，仅 node:fs/node:path）。运行：`node docs/G-mtr3su6f-1/T122-evidence/machcheck-test-cases.mjs`；通过 exit 0 并打印统计（总条数/各切片/类别/优先级/AC 覆盖/BR 配对），本阶段实测输出见 docs/G-mtr3su6f-1/T122-evidence/01-doc-machcheck.txt。校验项：
1. 用例行格式：§4/E2E 表行（ID 为 TC-S<n>-<m> 或 E2E-n）列数 = 7 列，ID 全文档唯一，类别列 ∈ {🟢,🟡,🔴} × 优先级 P0/P1/P2；
2. 非空性：每行 前置/步骤/期望/自动化/追溯 五列均非空（每条用例可执行、有 PASS/FAIL 判据、有归宿）；
3. AC 全覆盖：28 条 AC（AC-R1-1..8/R2-1..5/R3-1..6/R4-1..6/R5-1..3）每条约 ≥1 用例引用（追溯列），无悬空 AC；
4. 正反向配对：§5 每 BR 引用的正向 TC 类别为 🟢、反向 TC 类别为 🔴，且 id 均存在；
5. 数值一致：本文 §0 的计数与脚本统计一致（运行后如计数变化需同步 §0）；
6. 骨架语法：附录 B 的 js 代码块通过 node --check（输出见 T122-evidence/02-skeleton-syntax.txt）。

## 9. 附录 B：逐切片可照抄测试代码骨架（coder 在各切片文件域内物化；**本阶段不预写文件**以免与 coder 合入冲突）

> 说明：骨架以 node:test / node:assert 风格编写，注释标 TC 号；plugins 测试 import 构建产物 plugins/lib/*.js（先跑 plugins/scripts/build.sh，需 DSH_CHECKOUT）。B.7/B.8 为 bash/node -e 命令。全部 JS 骨架已通过 node --check 语法校验（见证据 02-skeleton-syntax.txt）。

### B.1 S1 错误分类器测试（→ plugins/tests/chat-error-classifier.test.mjs）

```js
// plugins/tests/chat-error-classifier.test.mjs —— S1（R-1 决策 A1）错误分类器契约骨架
// 运行：bash plugins/scripts/build.sh（DSH_CHECKOUT 指向 dsh checkout）→ node plugins/tests/chat-error-classifier.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyChatError, CATEGORIES } from '../lib/chatErrorClassifier.js'

test('TC-S1-01 五类别映射：每类 ≥1 输入 → 类别 + 可行动文案（含恢复指引）', () => {
  const cases = [
    { in: { stopReason: 'error', error: 'model not found: x-unknown-9' }, cls: 'model-unavailable' },
    { in: { stopReason: 'error', error: 'unauthorized: invalid api key 401' }, cls: 'provider-error' },
    { in: { stopReason: 'error', error: 'ECONNREFUSED connection refused' }, cls: 'provider-error' },
    { in: { stopReason: null, error: 'timeout' }, cls: 'timeout-aborted' },
    { in: { stopReason: 'aborted', error: '' }, cls: 'timeout-aborted' },
    { in: { stopReason: 'error', error: '守护 foreman 不可用' }, cls: 'foreman-down' },
    { in: { stopReason: 'error', error: 'weird upstream noise text' }, cls: 'empty-other' },
  ]
  assert.deepEqual([...CATEGORIES].sort(), ['empty-other', 'foreman-down', 'model-unavailable', 'provider-error', 'timeout-aborted'])
  for (const c of cases) {
    const out = classifyChatError(c.in)
    assert.equal(out.category, c.cls, 'input ' + JSON.stringify(c.in))
    assert.ok(out.message && out.message.length > 0)
    assert.ok(out.message.length <= 500, 'aiError ≤500 契约')
    assert.ok(/(重试|配置|模型|恢复)/.test(out.message), '含恢复指引: ' + out.message)
  }
})

test('TC-S1-03 负例：error/undefined 原文不得产出裸「回复子代理未完成（error）」', () => {
  for (const bad of ['error: undefined', 'undefined', 'Error: error']) {
    const out = classifyChatError({ stopReason: 'error', error: bad })
    assert.ok(!out.message.includes('回复子代理未完成（error）'), '无裸兜底文案: ' + out.message)
    assert.ok(!/回复子代理未完成/.test(out.message))
  }
})

test('TC-S1-04 边界：空/未知/超长输入兜底不抛，原文片段截断 ≤500', () => {
  const inputs = [{ stopReason: '' }, { stopReason: undefined }, {}, { stopReason: null, error: 'x'.repeat(5000) }]
  for (const i of inputs) {
    const out = classifyChatError(i)
    assert.ok(CATEGORIES.includes(out.category))
    assert.ok(out.message.length <= 500)
    assert.ok(out.message.length > 0)
  }
})

test('TC-S1-02 timeout/foreman 沿用既有语义文案', () => {
  const t = classifyChatError({ stopReason: 'error', error: 'timeout 120s 预算中止' })
  assert.ok(t.category === 'timeout-aborted' && /超时|中止/.test(t.message))
  const f = classifyChatError({ stopReason: 'error', error: 'foreman down' })
  assert.ok(f.category === 'foreman-down' && f.message.includes('守护 foreman 不可用'))
})
```

### B.2 S2 健康端点用例（→ team-hub/chat.test.mjs 追加 describe；HTTP 范式照抄同文件 S9 HTTP describe 的 listen(0) 段）

```js
// team-hub/chat.test.mjs 追加 —— S2 健康端点（TC-S2-*）
// getJson/postJson 复用同文件 S9 HTTP describe 内既有的 fetch helper（listen(0)）
describe('S2 TC-S2-01..08 chat/health 聚合 + 只读 + 诚实标注', () => {
  it('TC-S2-01/05/08 形状 + 最近失败透出 + 诚实标注', async () => {
    // 准备：software scope 会话 + 一条 failed 消息（aiError='未配置可用模型：请在模型配置中选择 assistant 可用模型后重试'）
    const health = await getJson('/api/chat/health?scope=software')
    assert.equal(typeof health.online, 'boolean')
    assert.ok('enabled' in health && 'model' in health)
    assert.ok(health.lastFail && health.lastFail.aiError.includes('模型配置'), '最近失败透出分类文案')
    assert.ok(/不代表/.test(JSON.stringify(health)) || health.honestNote, '诚实标注「已解析不代表 provider 实际可用」')
  })
  it('TC-S2-02 心跳窗三值（直写 members.lastSeenAt 插桩）', async () => {
    // 59s 前 → online=true；61s 前 → online=false；无行 → false
  })
  it('TC-S2-03 settings.enabled=false → health.enabled=false', async () => { /* saveReplySettings false 后断言 */ })
  it('TC-S2-07 只读：GET health 前后 audit seq 与业务表行数不变', async () => { /* 比对 */ })
  it('TC-S2-06 非法 scope/缺省 → 400 可读', async () => { /* /api/chat/health 与 scope=.. 非法串 */ })
})
```

### B.3 S3 附件数据面用例（→ team-hub/chat.test.mjs 追加 describe；env 小值覆写）

```js
// team-hub/chat.test.mjs 追加 —— S3 附件数据面（TC-S3-*）
// 上传助手：raw body PUT；护栏小值通过测试前 process.env 注入（CHAT_ATTACH_*，与 CHAT_REPLY_TIMEOUT_MS 同 env 先例）
async function uploadRaw(urlPath, bodyBuf, extraHeaders) {
  // 复用 S9 HTTP describe 的 fetch 基座：method PUT + Content-Length + raw Buffer
  throw new Error('由 coder 接既有 fetch helper 实现')
}

describe('S3 TC-S3-01..17 chat_attachments 数据面', () => {
  it('TC-S3-01 合法 UTF-8 文本上传 → id/fileName/size + staged + 落盘', async () => {
    const res = await uploadRaw('/api/chat/attachments?scope=software', Buffer.from('附件独有事实 QX-7788', 'utf8'))
    assert.equal(res.status, 200)
    assert.ok(res.id > 0 && res.fileName.endsWith('.txt') && res.size > 0)
  })
  it('TC-S3-02/03 黑名单扩展名与非法 UTF-8 → 4xx 可读文案', async () => {
    for (const name of ['evil.exe', 'archive.zip', 'image.png']) {
      const r = await uploadRaw('/api/chat/attachments?scope=software&fileName=' + name, Buffer.from('x'))
      assert.ok(r.status >= 400 && r.status < 500 && r.message.length > 0)
    }
    const bad = await uploadRaw('/api/chat/attachments?scope=software&fileName=t.txt', Buffer.from([0xff, 0xfe, 0x00, 0x61]))
    assert.ok(bad.status >= 400 && /UTF-8/.test(bad.message))
  })
  it('TC-S3-04/05 env 小值：超大小与超数量被拒（CHAT_ATTACH_MAX_BYTES=32 / CHAT_ATTACH_MAX_PER_MSG=1）', async () => {
    // 超大小：33 字节 → 4xx；超数量：postMessage attachmentIds 长度 2 → 4xx 且消息不落库
  })
  it('TC-S3-07/15 postMessage 绑定：meta.attachments 只存引用 + body 不含文件全文', async () => {
    // 上传 2 个 → postMessage({conv, body:'hi', attachmentIds:[a,b]})
    // 断言 msg.meta.attachments 长度 2 且元素仅 id/fileName/size；body 不含 'QX-7788'
  })
  it('TC-S3-08/09 归属取回：拥有会话 200；跨会话/跨 scope 4xx', async () => { /* ... */ })
  it('TC-S3-11/12 TTL 小值：staged 孤儿与 sent 过期被清理', async () => { /* CHAT_ATTACH_STAGED_TTL_MS=50 / CHAT_ATTACH_TTL_MS=60 + 等待/直调清理 */ })
  it('TC-S3-13 audit：chat:attachment* 行 detail 含 fileName/size/scope', async () => { /* 复用 auditRows() */ })
  it('TC-S3-14 旧库无表 import 自动建表且存量无损', async () => { /* 同 TC-S1-16 老库迁移范式 */ })
})
```

### B.4 S4 空间摘要纯模块测试（→ plugins/tests/space-digest.test.mjs）

```js
// plugins/tests/space-digest.test.mjs —— S4（R-2 决策 C1）buildSpaceDigest 契约骨架
// tmp fixture 仓库：mkdtemp 下建 README.md/LEGION.md/AGENTS.md（含已知事实串）+ 子目录 + 噪声目录
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpaceDigest } from '../lib/spaceDigest.js'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'digest-fixture-'))
  mkdirSync(join(root, 'sub', 'nested'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '产品说明 FACT-README-TOP')
  writeFileSync(join(root, 'LEGION.md'), '仓库规则 FACT-LEGION')
  writeFileSync(join(root, 'AGENTS.md'), '代理规则 FACT-AGENTS')
  writeFileSync(join(root, 'plain.txt'), '普通文件 FACT-PLAIN')
  writeFileSync(join(root, 'sub', 'a.ts'), '代码文件')
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'NOISE-NM')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  return root
}

test('TC-S4-01 allowlist 与顶层结构入摘要（目录在前）；TC-S4-02 噪声不入', () => {
  const root = makeFixture()
  try {
    const out = buildSpaceDigest({ dir: root, budget: 4000 })
    assert.ok(out.text.includes('FACT-README-TOP'))
    assert.ok(out.text.includes('FACT-LEGION'))
    assert.ok(out.text.includes('FACT-AGENTS'))
    assert.ok(!out.text.includes('NOISE-NM') && !out.text.includes('node_modules'))
    assert.ok(!out.text.includes('.git') && !out.text.includes('dist'))
    assert.equal(out.truncated, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-03 确定性：同 fixture 两次输出一致', () => {
  const root = makeFixture()
  try {
    const a = buildSpaceDigest({ dir: root, budget: 4000 })
    const b = buildSpaceDigest({ dir: root, budget: 4000 })
    assert.equal(a.text, b.text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-04/05 预算与单文件截断：带「已截断」标记、truncated=true、不抛', () => {
  const root = makeFixture()
  try {
    const out = buildSpaceDigest({ dir: root, budget: 120 })
    assert.ok(out.text.length <= 120)
    assert.equal(out.truncated, true)
    assert.ok(out.text.includes('已截断'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-06 空目录/不存在目录/二进制文件 → 不抛', () => {
  const root = makeFixture()
  try {
    const empty = buildSpaceDigest({ dir: join(root, 'sub', 'nested'), budget: 4000 })
    assert.ok(empty.text.length >= 0)
    const gone = buildSpaceDigest({ dir: join(root, 'no-such-dir'), budget: 4000 })
    assert.ok(gone.text.length >= 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

### B.5 S5 提示词构建器扩展用例（→ plugins/tests/chat-responder.test.mjs 追加）

```js
// plugins/tests/chat-responder.test.mjs 追加 —— S5（决策 D1）摘要/附件上下文块骨架
import { buildChatAnswerPrompt } from '../lib/chatResponder.js'

test('TC-S5-02/03/08 摘要与附件块注入 + 块顺序', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software',
    identity: 'software-assistant',
    context: [{ id: 1, author: 'general', body: '仓库里有什么？' }],
    spaceDigest: { text: '空间摘要内容 QX-DIGEST', sourceNote: '取自绑定仓库', generatedAt: '2026-09-08T00:00:00Z' },
    attachments: [{ id: 9, fileName: 'facts.txt', size: 12, content: 'UNIQ-FACT-4417' }],
  })
  assert.ok(p.includes('工作空间只读上下文') && p.includes('QX-DIGEST'))
  assert.ok(p.includes('本次随消息上传的文件') && p.includes('facts.txt') && p.includes('UNIQ-FACT-4417'))
  const iSpace = p.indexOf('工作空间只读上下文')
  const iFile = p.indexOf('本次随消息上传的文件')
  const iHist = p.indexOf('会话历史')
  assert.ok(iSpace > -1 && iFile > -1 && iSpace < iFile && iFile < iHist, '块顺序：摘要 → 附件 → 历史')
})

test('TC-S5-04 摘要附件均缺省 → 不产对应块（向后兼容基座）', () => {
  const p = buildChatAnswerPrompt({ scope: 'software', identity: 'software-assistant', context: [] })
  assert.ok(!p.includes('工作空间只读上下文') && !p.includes('本次随消息上传的文件'))
})

test('TC-S5-06/07 降级占位：空摘要与附件失败不冒充', () => {
  const empty = buildChatAnswerPrompt({ scope: 'software', identity: 'software-assistant', context: [], spaceDigest: null, attachments: [] })
  assert.ok(empty.includes('（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）'))
  const fail = buildChatAnswerPrompt({
    scope: 'software', identity: 'software-assistant', context: [],
    attachments: [{ id: 2, fileName: 'broken.txt', size: 5, content: null, readError: '读取失败：404' }],
  })
  assert.ok(/附件 broken\.txt 读取失败/.test(fail) && !fail.includes('undefined'))
})

test('TC-S5-09 HTML 注入负例：危险标签不原样出现在输出', () => {
  const p = buildChatAnswerPrompt({
    scope: 'software', identity: 'software-assistant',
    context: [{ id: 1, author: 'general', body: '<script>alert(1)</script> 正常问题' }],
    spaceDigest: { text: '<img src=x onerror=alert(2)> 摘要' },
    attachments: [{ id: 3, fileName: 'a.txt', size: 3, content: '<script>x</script>' }],
  })
  assert.ok(!/<script/i.test(p), '无原样 script 标签')
})
```

### B.6 S6 守护上下文接线冒烟要点（写进 chat-l1-smoke 同型 L2 脚本或新隔离脚本）

```js
// L2 隔离冒烟（TC-S6-*）要点骨架：隔离 hub（TEAM_HUB_DB=tmp + TEAM_HUB_PORT）+ 守护 + fake 子代理捕获 prompt
// 断言点：
//  TC-S6-01/07：fake 子代理捕获的最终 prompt 含 spaceDigest 事实（allowlist 片段/顶层目录），不含 → FAIL
//  TC-S6-02/08：带附件消息 prompt 含 UNIQ-FACT-4417；对照组（不带附件）同问不含 → FAIL
//  TC-S6-09：第二问 prompt 不含第一问附件事实串 → FAIL
//  TC-S6-03/04：摘要/附件读取失败 → 源消息不标 failed（meta.aiStatus 保持 awaiting 或正常处理），仅日志
// 宿主不可达时按仓库惯例如实记录复现步骤与输出（R-18），不冒充 PASS
```

### B.7 S7/S8 UI 静态断言命令（bash；期望见注释）

```bash
# TC-S7-01 死路卡替换（期望 0 / ≥1）
grep -c "请先选择具体工作空间|全部空间视图不可发消息" workbench/src/components/ChatView.tsx   # 期望 0
grep -c "选择工作空间开始对话" workbench/src/components/ChatView.tsx                            # 期望 ≥1
# TC-S7-12 / TC-S8-12 渲染安全（期望合计 0）
grep -c "dangerouslySetInnerHTML" workbench/src/components/ChatView.tsx workbench/src/api.ts
# TC-S8-01 附件入口（期望 ≥1）
grep -c "type=.file." workbench/src/components/ChatView.tsx
```

### B.8 S9 文档关键句断言（bash + node -e；期望输出 OK）

```bash
# TC-S9-01/02/09 三要素 + 排障行（FEATURES §3.9 / README / workbench README）
node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');const r=fs.readFileSync('README.md','utf8');const keys=['回复设置','工作空间','上传文件','失败','重试'];for(const k of keys){if(!t.includes(k)&&!r.includes(k)){console.error('missing: '+k);process.exit(1)}}console.log('S9 关键句 OK')"
# TC-S9-06/07 docs 门禁正向（期望 exit 0）；坏链注入后反向（期望 exit != 0）
node scripts/ci/check-docs.mjs
```

## 附录 C 关联文档与阅读顺序

- 上游：docs/G-mtr3su6f-1/REQUIREMENTS.md（T-119）、RESEARCH.md（T-120）、TASK_BREAKDOWN.md（T-121）。
- 本文件：docs/G-mtr3su6f-1/TEST_CASES.md（T-122 用例设计）。
- 自检证据：docs/G-mtr3su6f-1/T122-evidence/（machcheck-test-cases.mjs + 01-doc-machcheck.txt + 02-skeleton-syntax.txt）。
- 下游：docs/G-mtr3su6f-1/TEST_REPORT.md（T-125 测试执行）；docs/G-mtr3su6f-1/DEPLOY.md（T-126）。
- 关系：本用例只认定 docs/G-mtr3su6f-1/ 目录版本；仓库根 docs/TEST_CASES.md（其他目标/遗留链）无承接关系。chat.test.mjs 内既有 TC-S1-xx / TC-S9-xx / plugins TC-S10-xx 为历史契约用例（回归基线），本文新增 TC-S<n>-<m> 与其同风格不冲突。

*（本文件由 T-122 测试用例设计士兵产出，仅落在 docs/G-mtr3su6f-1/TEST_CASES.md + T122-evidence/；未改任何仓库实现、未预写切片域内测试文件、未调用 taskctl/看板写接口、未 push。）*