<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `0a58ecb`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-121 任务拆解：对话中心「可回答闭环修复 + 上下文输入（关联工作空间 / 上传文件）」

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-121（[auto-goal]｜所属目标 G-mtr3su6f-1 · software · chain）
> 上游：T-119 需求澄清（docs/G-mtr3su6f-1/REQUIREMENTS.md，R-1~R-5 + AC-R* + D-1~D-8 默认值即基线）→ T-120 方案搜索（docs/G-mtr3su6f-1/RESEARCH.md，决策 A~G 结论 + §11 切片建议与依赖）
> 下游：守护解析本文件「## slices」注册 coder_Si → tester_Si 微链 → 逐切片开发/测试；阶段链 T-122 用例设计 → T-123 coder → T-124 review → T-125 test → T-126 devops
> 评估基准：w/T-121 HEAD 5da024f（promote T-120；本文 file:line 均指本 worktree 内容，本会话 read/grep 实测确认）
> 依据：LEGION.md 纪律、本任务验收标准与边界、REQUIREMENTS §5（AC-R1-1..8 / AC-R2-1..5 / AC-R3-1..6 / AC-R4-1..6 / AC-R5-1..3）、§8 D-1..D-8（默认值即基线）、RESEARCH §11（8 条切片建议 + 依赖与文件域警示 Rk-5）
>
> **权威基线/命名空间提醒（重要）**：本目标分析文档目录 = docs/G-mtr3su6f-1/。仓库根 docs/REQUIREMENTS.md、docs/TASK_BREAKDOWN.md 等根槽位属其他目标/遗留链，**禁止读写**。本拆解只写本文（docs/G-mtr3su6f-1/TASK_BREAKDOWN.md），不改任何仓库实现。
>
> **工作区状态**：分支 w/T-121，HEAD 5da024f（T-120 promote）。docs/G-mtr3su6f-1/ 现仅 REQUIREMENTS.md 与 RESEARCH.md（本文为 T-121 首次产出，无旧版）；docs/goals/G-mtr3su6f-1.md 的 M 标记为派工/守护产生的目标镜像快照，本阶段未触碰。实测基线：node v24.19.0；node team-hub/chat.test.mjs = tests 23 / suites 14 / pass 23 / fail 0 / exit 0。

## 0. 结论速览（TL;DR）

- 拆解产物：**9 个切片（S1~S9）**，按需求分组并收口共享文件域（RESEARCH §11.1 的 S1~S8 建议经合并/调序后落地）：
  - **R-1 可回答闭环（P0，先）**：S1 执行层失败可行动化（错误分类器+透传+隔离复现锚点）；S2 健康端点+守护心跳+daemon 状态；S7 UI 前置（全部空间选空间入口 + 健康状态条 + 回复设置弹窗，接线既有 retry 闭环）。
  - **R-2 关联工作空间（P0）**：S4 空间摘要纯模块（fixture 可测）；S5 提示词构建器扩展（摘要/附件上下文块+预算+降级占位）；S6 守护上下文接线（取绑定仓库内容注入）；入口/切换归 S7。
  - **R-3 上传文件（P0）**：S3 附件数据面（chat_attachments 表 + 上传/取回/绑定/清理 + 服务端护栏）；S8 UI 附件行（选择/预检/移除 + 消息附件标识）；注入进 S5/S6。
  - **R-4 公共护栏（P1，横切）**：不单列大切片——服务端护栏/审计/TTL 归 S3；预算截断纯函数与降级占位归 S5；取回预算与隔离归 S6。
  - **R-5 文档收口（P2，最后）**：S9（FEATURES §3.9 / README / workbench README + check-docs 门禁）。
- 全批**零新增运行时/开发依赖**：沿用 node:sqlite / node:http / Node fetch / TextDecoder / 原生 React 表单与手写 CSS / 守护子代理（决策 A1/B1+B2/C1/D1/E1/F1/G1，RESEARCH §9）。
- **文件域纪律（并行合入安全前提）**：同一文件只允许 1 个切片并发持有；跨切片同文件场景全部**同文件硬串行**并以注册顺序保证（当前生产单 worker 按注册顺序派工，天然串行）：
  - team-hub/server.mjs 链：**S2 → S3**（health 段 → attachments 段；chat.test.mjs 用例同链追加）；
  - plugins/src/index.ts 链：**S1 → S2 → S6**（失败分支段 → 心跳/daemon 状态段 → 上下文拼装段）；
  - workbench ChatView.tsx + api.ts 链：**S7 → S8**（入口/健康/设置段 → 附件行段）；
  - plugins/src/chatResponder.ts 只属 S5；workbench/src/types.ts 只属 S8；新文件（chatErrorClassifier.ts / spaceDigest.ts / 两个新测试）各只属一个切片。
- **禁止**在提升并发槽位后同时派工同文件域的相邻切片（§2.2 给出可并行组合清单）。

## 1. 机器可读切片清单（守护据此注册并行派工，逐行严格遵循：每行四段用 | 分隔，段内不再出现 |；第 2 段文件逗号分隔；第 4 段验收分号分隔）

## slices
- S1 | 执行层失败可行动化：错误分类器 + answerChatMessage 失败分支透传 + 隔离复现锚点（R-1 决策 A1） | plugins/src/chatErrorClassifier.ts, plugins/src/index.ts, plugins/tests/chat-error-classifier.test.mjs | plugins build（bash scripts/build.sh 需 DSH_CHECKOUT；产物 plugins/lib 不入文件域）+ node plugins/tests/chat-error-classifier.test.mjs 全绿：五类别 model-unavailable/provider-error/timeout-aborted/foreman-down/empty-other 各 ≥1 断言;输入 stopReason=error 或含 error/undefined 原文 → 输出不含裸「回复子代理未完成（error）」且含恢复指引（AC-R1-3）;timeout 与 foreman-down 类别沿用「超时/中止」「守护 foreman 不可用」既有语义断言;index.ts answerChatMessage 失败分支（:2439-2441 笼统文案与 :2455-2458 catch 吞错区）改用分类器生成可行动文案经 markChatFailed 回写，成功分支日志含实际选用 provider/model（回写契约不变 aiError ≤500）;含隔离复现锚点用例：注入 fake 子代理 stopReason=error → 断言 failed 回写为分类文案（临时库不碰 live 库，AC-R1-1）;plugins typecheck 0 诊断（受限时如实记录复现步骤与输出）;node team-hub/chat.test.mjs exit 0 既有 23 例不回归;静态断言 plugins/src 不再出现裸「回复子代理未完成（」兜底文案，且无新增自动重试与历史消息自动回填逻辑（D-5/D-8 不变）;零新增运行时依赖
- S2 | 对话健康端点 GET /api/chat/health + 守护心跳上报与 daemon chat 状态（R-1 决策 B1+B2） | team-hub/server.mjs, team-hub/chat.test.mjs, plugins/src/index.ts | node team-hub/chat.test.mjs exit 0：既有 23 例不回归 + 新增健康用例（scope 缺省与非法 400;守护在线判定 members lastSeenAt 60s 窗;settings.enabled;模型解析链 settings.model 与 agent_models role=assistant 与守护默认合成结果;最近 failed 消息 aiError 透出）;plugins/src/index.ts 周期性 POST /api/heartbeat kind=worker（宿主可达冒烟：GET /api/members 该成员 online=true；不可达记录复现步骤）;daemon.json 增 chat 状态字段（lastReplyAt/lastFailAt/lastFailReason）随 writeDaemonStatus 写出（cat 断言存在）;健康端点只读且诚实标注「已解析不代表 provider 实际可用」;plugins typecheck 0（受限记录）;零新增运行时依赖
- S3 | 附件数据面：chat_attachments 表 + 上传/取回/绑定/清理端点 + 服务端护栏常量（R-3/R-4 决策 E1+G1 服务端侧） | team-hub/server.mjs, team-hub/chat.test.mjs | node team-hub/chat.test.mjs exit 0：既有 23 例不回归 + 新增附件用例全绿（合法 UTF-8 文本上传返回 id/fileName/size 且落盘;黑名单扩展名与非法 UTF-8 → 4xx 可读文案;超大小与超数量（env 小值覆写断言）→ 拒绝;postMessage 带 attachmentIds → meta.attachments 引用 + status=sent + body 不含文件内容;content 取回按会话归属校验拒绝跨会话跨 scope;staged 孤儿 24h 与 sent 过期 7 天清理可断言）;audit 含 chat:attachment* 行且 detail 带 fileName/size/scope（AC-R4-4）;表 CREATE TABLE IF NOT EXISTS 幂等零迁移;uploads 落盘目录与 TEAM_HUB_DB 同基（测试临时库隔离，live 库零写入）;附件内容不入 messages.body/meta（AC-R4-3 断言）;零新增运行时依赖
- S4 | 空间摘要纯模块 buildSpaceDigest（R-2 决策 C1） | plugins/src/spaceDigest.ts, plugins/tests/space-digest.test.mjs | plugins build + node plugins/tests/space-digest.test.mjs 全绿：tmp fixture 仓库断言 allowlist 文件片段与顶层结构入摘要、.git/node_modules/构建产物等噪声跳过、顺序稳定、超预算截断并带标记（AC-R2-3 与 AC-R4-1 摘要侧）;无绑定/空目录/读取失败 → 空摘要或明示占位且不抛;只读 fs 实现且不 spawn 子进程（源码断言无 child_process 引用）;未修改 plugins/src/index.ts（git diff 断言为空）;plugins typecheck 0（受限记录）;零新增运行时依赖
- S5 | 提示词构建器扩展：ChatAnswerInput 增空间摘要与附件上下文 + 分块注入与预算降级占位（R-2/R-3/R-4 决策 D1 纯函数层） | plugins/src/chatResponder.ts, plugins/tests/chat-responder.test.mjs | plugins build + node plugins/tests/chat-responder.test.mjs 全绿：既有 TC-S10-* 不回归（身份解析/禁工具声明/无历史不崩）;新增断言：含 spaceDigest → 输出「工作空间只读上下文（生成于 ts）」块且内容置入;含 attachments → 输出「本次随消息上传的文件」块（文件名+大小+内容）;两者皆空不产对应块;超预算先裁摘要保附件且截断带标记（AC-R4-1/6）;空摘要降级占位「（当前空间未绑定可读本地仓库…）」与附件读取失败占位「（附件 name 读取失败…）」可断言（AC-R2-4/AC-R4-5）;输出仍为纯文本无 HTML 注入面（静态断言）;plugins typecheck 0（受限记录）;零新增运行时依赖
- S6 | 守护上下文接线：answerChatMessage 取空间摘要与附件内容并注入提示词（R-2/R-3/R-4 决策 D1+E1 守护侧收口） | plugins/src/index.ts | plugins typecheck 0（受限时如实记录复现步骤与输出）;answerChatMessage 在 buildChatAnswerPrompt 前构造 spaceDigest（经 S4 模块 + 绑定仓库根）与 attachments 文本（meta.attachments 逐个 GET /api/chat/attachments/content 取回，单附件 ≤4000 字符截断并标记）;摘要/附件读取失败走降级占位且不把源消息标 failed（异常只进日志，AC-R2-4/AC-R4-5）;预算分配（摘要+附件合计 ≤8000 字符默认，先裁摘要后裁附件，env 可覆写）经 S5 纯函数并附断言;附件内容仅进当次提示词、不写入任何消息体/meta（静态断言）;宿主可达 L1 冒烟（隔离 hub+守护+绑定仓库）：绑定仓库事实题 → 回复引用真实内容;上传带独有事实文件提问 → 回复引用该事实;连续两问第二问不含第一问附件内容（不可达记录复现步骤，AC-R2-3/AC-R3-2/AC-R4-6）;node team-hub/chat.test.mjs exit 0 不回归;零新增运行时依赖
- S7 | UI 前置（R-1/R-2）：全部空间选空间入口 + 对话健康状态条 + 回复设置弹窗 | workbench/src/components/ChatView.tsx, workbench/src/App.tsx, workbench/src/api.ts | pnpm --dir workbench build 全绿（tsc --noEmit 0 诊断 + vite build；workbench/node_modules 缺失时经 run-ci deps junction 兜底，仍失败如实记录复现步骤）;!scope 死路卡（ChatView.tsx:250-261）改为「选择工作空间开始对话」入口：复用 api.ts fetchSpaces 列空间，点选经新增 onPickScope → App.setScope 进入该空间会话态（AC-R1-6/AC-R2-1；宿主可用浏览器驱动冒烟断言，不可达记录复现步骤）;chat-head 区（:345-354）健康状态点接 GET /api/chat/health：绿=守护在线+开关开+模型已解析;黄=前提缺失并给出修复动作;红=最近失败可行动文案+重试指引;端点缺失灰态不误导（AC-R1-3 可见化）;回复设置弹窗接线既有 fetch/saveChatReplySettings：每空间开关 enabled 必含，model/identity/systemHint 可选;关 → 后续发送零 awaiting 零出站（宿主冒烟断言 messages.meta 无 aiStatus=awaiting，AC-R1-5）;失败 toast 透传后端文案不静默;无 dangerouslySetInnerHTML 直插服务端文本;既有 chat 前端（chat-s2-smoke/无附件发送）不回归;零新增依赖
- S8 | UI 附件行（R-3 决策 F1 附件部分）：composer 附件选择/预检/移除 + 消息附件标识 | workbench/src/components/ChatView.tsx, workbench/src/api.ts, workbench/src/types.ts | pnpm --dir workbench build 全绿（tsc 0 诊断）;composer 出现 📎 入口（隐藏 input type=file multiple + 发送前附件 chip 行可移除 + 客户端预检大小/数量/黑名单）;api.ts 增 uploadChatAttachment（PUT /api/chat/attachments）并扩展 postChatMessage 携带 attachmentIds;发送成功清附件槽、失败保留并 toast（对齐 send 失败保留草稿语义）;消息旁渲染 meta.attachments 附件标识（文件名+大小，纯文本）且 body 不含文件全文（AC-R3-1）;发送中/上传中禁用发送按钮防竞态;宿主冒烟：上传含独有事实文本文件发送 → 附件标识出现且服务端 meta.attachments 引用存在、body 无文件内容;黑名单/超限/超数量 → 可读错误且消息不进队列（AC-R3-3）;移除后请求不含附件（AC-R3-4）;无附件发送不回归;types.ts 增 ChatAttachmentRef（id/name/size）;渲染安全无 dangerouslySetInnerHTML;零新增依赖
- S9 | 文档收口（R-5）：FEATURES §3.9 / README / workbench README 同步实现后行为 | docs/FEATURES.md, README.md, workbench/README.md | docs/FEATURES.md §3.9 与 README 含三要素（回复设置入口位置;关联工作空间与上传文件操作步骤与边界;「AI 不回或回复失败怎么办」含守护在线与模型前提与重试指引），node 断言关键句各 ≥1 + 人工核对（AC-R5-1/2）;§2.6 不一致消除：FEATURES 关于每空间 AI 开关的表述与实现后 UI 一致且带入口位置（不再「文档超前 UI」）;node scripts/ci/check-docs.mjs exit 0（既有 docs 门禁不回归，AC-R5-3）;改动仅限上述三个文档文件;零新增依赖
## 2. 依赖关系、执行顺序与并行（给人看）

### 2.1 blockedBy 一览（注册顺序 = 派工顺序；同文件域 = 硬串行；跨域 = 可并行）

| 切片 | blockedBy | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | R-1 执行层失败修复是全部 R-1 文案与健康语义的根；plugins/src/index.ts 链起点 | M |
| S2 | S1（同 plugins/src/index.ts 硬串行） | 健康端点要聚合「最近失败类别」与模型解析链，失败分类（S1）先定文案面；index.ts 心跳段须在 S1 改动后落 | M |
| S7 | S2（健康端点语义） | 健康状态条消费 GET /api/chat/health；回复设置与入口复用既有端点与 spaces，无需等 R-2/R-3 执行层 | L |
| S3 | S2（同 team-hub/server.mjs 与 chat.test.mjs 硬串行） | attachments 段（表/路由/护栏）在 health 段之后追加，chat.test.mjs 用例同链；与 S1/S4/S5/S6/S7 文件域不相交 | L |
| S4 | 无（纯新文件，可并行） | buildSpaceDigest 独立新模块 + fixture 单测，不依赖任何改动；摘要输入契约本文 §3.1 定稿 | M |
| S5 | S3 + S4（建议；输入契约 §3.1 定稿则可不依赖，注册序置后便于 S6 收口） | chatResponder.ts 的附件/摘要块输入形状须与 meta.attachments（S3）和摘要文本（S4）一致；纯函数域独立，可与 S1/S2/S7 并行 | M |
| S6 | S2（同 plugins/src/index.ts 硬串行）+ S3 + S4 + S5 | answerChatMessage 接线消费：健康心跳已在 S2、附件 content 端点在 S3、digest 模块在 S4、提示词字段在 S5，齐备后才完整可验 | L |
| S8 | S3（upload/绑定契约）+ S7（同 ChatView.tsx/api.ts 硬串行） | UI 附件行依赖服务端上传端点；ChatView/api 由 S7 先行改入口/健康/设置段 | M |
| S9 | S1 + S3 + S7 + S8（行为定稿后可写真实行为） | 文档须描述实现后真实行为（设置入口位置/失败怎么办/上传操作与边界），故排最后 | M |

**无循环依赖**：依赖沿「执行层/数据面 → 注入 → UI → 文档」单方向（S1→S2→S3→S6→S8→S9 主轴 + S7 支线 + S4/S5 汇入 S6），无回边。

### 2.2 执行顺序与并行建议

- **默认安全路径（当前生产守护单 worker，按注册顺序派工）**：S1 → S2 → S7 → S3 → S4 → S5 → S6 → S8 → S9。注册顺序即派工顺序，已按依赖拓扑排好，且保证 **R-1 先行（D-7 默认）**：S1/S2/S7 先把「可回答 + 失败可行动 + 入口/健康/设置」闭环落地，再进入 R-2/R-3 上下文面。
- **若将军提升并发槽位（maxWorkers ≥ 2）**：只允许派工**文件域两两不相交**的组合；**严禁**同时派工同一文件的相邻切片——server.mjs 与 chat.test.mjs 的 S2/S3 互斥、plugins/src/index.ts 的 S1/S2/S6 互斥、ChatView.tsx 与 api.ts 的 S7/S8 互斥。域不相交即可并行的示例：{S1, S4}、{S2, S4}、{S7, S4}、{S3, S4}、{S1, S5}、{S7, S5}（S8 依赖 S3+S7 完成后才可派，仅域不相交不够）。
- **共享文件警示（RK-5/RR-6）**：team-hub/server.mjs、plugins/src/index.ts、ChatView.tsx、api.ts 为多切片共享文件，已按上述链串行排布；这些文件亦可能被在途其他目标触碰，合入冲突交由既有 mediator/gate 调解。plugins/src/chatResponder.ts 仅 S5 持有；docs/FEATURES.md 与 README.md 仅 S9 持有（文档级共享说明见 §5）。

## 3. 子任务明细（每切片 = 一个士兵一轮可完成并验收；「验收」以 §1 机器行逐条为准；工作量刻度 S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满）

### 3.1 纯函数与数据契约（各切片共用，先行定稿避免歧义）

- 附件数据面契约（S3/S5/S6/S8 共用）：消息 meta 增 attachments 引用数组 [{id, fileName, size}]（只存引用，不存正文）；上传端点 PUT /api/chat/attachments?scope=（raw body）；取回端点 GET /api/chat/attachments/content?id= 按会话归属校验后返回 UTF-8 文本。
- 提示词输入契约（S5/S6 共用，扩展 ChatAnswerInput）：可选字段 spaceDigest（含来源说明与生成时间，由 S6 拼好）与 attachments 数组（元素含 id/fileName/size/content，content 为已取回文本或失败占位文案）。块顺序 = 角色 → 行为约束 → systemHint → 工作空间上下文块 → 上传文件块 → 会话历史 → 提问。
- 摘要模块契约（S4/S6 共用）：buildSpaceDigest({dir, budget}) → {text, truncated, sources} 纯只读；allowlist 与噪声规则、预算默认值按 REQUIREMENTS §8 D-6 与 RESEARCH §4.2/§8.2（README/README.zh/LEGION/AGENTS/docs-FEATURES/PLUGINS/package.json/COMMAND 等存在即读；顶层目录在前；噪声含 .git/node_modules/dist/build/.legion-worktrees；单文件与摘要块 ≤4000、合计 ≤8000 默认，env 可覆写）。
- 运行命令事实（本 worktree 实测）：node team-hub/chat.test.mjs exit 0（tests 23 / pass 23）；plugins 测试需先构建出 plugins/lib（bash plugins/scripts/build.sh，需 DSH_CHECKOUT）；plugins/workbench 依赖宿主或 junction（run-ci deps 兜底），受限时如实记录复现步骤（仓库惯例）。

### 3.2 S1 执行层失败可行动化【R-1 · plugins 链起点 · 工作量 M】
- **目标**：落地 AC-R1-3/AC-R1-1——把 live 现场「回复子代理未完成（error）」的笼统失败升级为分类可行动文案。新增纯函数模块 plugins/src/chatErrorClassifier.ts（输入 stopReason/error 文本 → 类别 + 可行动文案；类别：model-unavailable / provider-error / timeout-aborted / foreman-down / empty-other，各带恢复指引）；index.ts answerChatMessage 两处失败路径（:2439-2441 非 completed 统一文案、:2455-2458 catch 吞错）改为调分类器后 markChatFailed 回写（aiError ≤500 契约不变，server.mjs:1204）；成功分支日志保留实际选用 provider/model；含隔离复现锚点测试（fake 子代理注入 stopReason=error，临时库断言 failed 回写为分类文案，不碰 live 库）。
- **产出（文件域）**：plugins/src/chatErrorClassifier.ts（新建）、plugins/src/index.ts（失败分支行级改动）、plugins/tests/chat-error-classifier.test.mjs（新建）。
- **依赖**：无。**工作量**：M。**完成 =（DoD）**：§1 S1 行逐条有真实命令输出为证（新测试全绿含 5 类别与 error/undefined 负例、typecheck 0、chat.test 23 例不回归、静态断言无裸文案且无自动重试/自动回填）= 完成。
- **测试锚点（test-designer 直转）**：分类表逐类输入输出映射、裸 error 负例、timeout/foreman 旧语义保留、fake 子代理集成场景（AC-R1-3 文案断言「含恢复语义」「不含裸 error/undefined 样式文案」）。
- **纪律**：不改服务端回写契约、不引入自动重试（D-8 默认）、不回填历史旧消息（D-5 默认）；零新增依赖。

### 3.3 S2 健康端点 + 守护心跳【R-1 · server.mjs 链起点 · 工作量 M】
- **目标**：落地 AC-R1-3「运行前提可见化」后端——team-hub 新增 GET /api/chat/health?scope= 聚合 ①守护在线（members 按 lastSeenAt < 60s，复用 :2378-2384 判定）②回复开关（getReplySettings :1041）③模型解析链结果（settings.model → agent_models role=assistant → 守护默认）④最近一条 failed 消息的 aiError（供 UI 展示「如何恢复」）；诚实标注「已解析不代表 provider 实际可用」。plugins/src/index.ts 每轮（或独立 interval）向 POST /api/heartbeat 上报 kind=worker（复用 :2163 端点），并把最近 chat 成败写进 daemon.json（writeDaemonStatus :746-780 扩展 chat 状态字段，B2 辅助）。
- **产出（文件域）**：team-hub/server.mjs（health 聚合函数 + 路由，与 S3 不同段）、team-hub/chat.test.mjs（健康用例 describe 追加）、plugins/src/index.ts（心跳调用 + writeDaemonStatus chat 字段，与 S1/S6 不同段）。
- **依赖**：S1（index.ts 同文件链）。**工作量**：M。**完成 =（DoD）**：§1 S2 行逐条命令输出为证（健康用例全绿、daemon.json cat 断言、plugins typecheck 0、宿主冒烟可选记录）= 完成。
- **测试锚点**：health 字段形状与三输入聚合（members 60s 边界：新鲜在线 / 过期离线 / 无守护行）、模型解析矩阵（settings.model 有/无 × agent_models 有/无）、最近失败透出、HTTP 400 非法 scope。
- **纪律**：健康端点只读零写入；心跳不新增依赖；daemon.json 字段仅追加不破坏既有键。

### 3.4 S3 附件数据面（服务端）【R-3/R-4 · 工作量 L】
- **目标**：落地 AC-R3-1/3/5 与 AC-R4-2/3/4/6 后端——按 RESEARCH E1：team-hub 新增 chat_attachments 表（id/scope/conv_id/msg_id/file_name/size/kind/sha1/path/status/createdAt，CREATE TABLE IF NOT EXISTS 零迁移）+ uploads 落盘目录（与 TEAM_HUB_DB 同基）+ PUT /api/chat/attachments（raw body + Content-Length 预检 + 临时文件原子改名，写纪律复用 workbench/scripts/serve.mjs 先例）+ GET /api/chat/attachments/content（会话归属校验）+ postMessage 绑定 attachmentIds（meta.attachments 引用 + 状态置 sent，body 不含文件内容）+ 孤儿（staged 24h）/过期（sent 7 天）TTL 清理 + 审计 chat:attachment*；服务端护栏常量 + env 覆写（大小/每消息数量/扩展名黑名单/UTF-8 fatal 解码，承接 REQUIREMENTS D-6 与 RESEARCH §8.2 默认值表）。
- **产出（文件域）**：team-hub/server.mjs（chat DAO/路由段 :920-1230 与 :2643-2690 区域扩展）、team-hub/chat.test.mjs（附件 describe 追加）；uploads 目录为运行时数据不入文件域。
- **依赖**：S2（同文件硬串行）。**工作量**：L。**完成 =（DoD）**：§1 S3 行逐条命令输出为证 = 完成。
- **测试锚点**：上传/拒绝/绑定/取回/清理全矩阵（黑名单、非法 UTF-8、超大小超数量 env 小值、跨会话取回 4xx、孤儿与过期清理、audit shape、body 无文件内容）。
- **纪律**：live 库零写入（测试临时库）；附件内容不入 messages 表；TTL 默认值文档化（REQUIREMENTS D-3 要求）。

### 3.5 S4 空间摘要纯模块【R-2 · 工作量 M】
- **目标**：落地 AC-R2-3/AC-R4-1 摘要侧——按 RESEARCH C1 新建 plugins/src/spaceDigest.ts：从绑定仓库根确定性构造空间摘要（空间元数据块 + 顶层结构块 + allowlist 关键文件块），只读 fs、UTF-8 解码失败即跳过、预算截断加标记、不 spawn 子进程；fixture 目录单测（已知文件 + 噪声）。本期只做模块本身（不接线 index.ts，接线归 S6），使 R-2 核心可独立验收。
- **产出（文件域）**：plugins/src/spaceDigest.ts（新建）、plugins/tests/space-digest.test.mjs（新建，tmp fixture 仓库）。
- **依赖**：无。**工作量**：M。**完成 =（DoD）**：§1 S4 行逐条命令输出为证（fixture 测试全绿、git diff 断言未改 index.ts、typecheck 0）= 完成。
- **测试锚点**：allowlist 命中/噪声跳过/顺序稳定/截断标记/空目录与读取失败不抛。
- **纪律**：纯只读；不执行任意命令；零新增依赖。

### 3.6 S5 提示词构建器扩展【R-2/R-3/R-4 纯函数 · 工作量 M】
- **目标**：落地 AC-R2-3/4、AC-R3-2、AC-R4-1/5/6 提示词层——扩展 plugins/src/chatResponder.ts 的 ChatAnswerInput 与 buildChatAnswerPrompt：可选 spaceDigest 与 attachments 输入；按 §3.1 契约分块注入（工作空间上下文块带来源/时间、上传文件块带名/大小/内容）；空块不产出；预算截断纯函数（先裁摘要保附件、截断带「（已截断）」标记）；空摘要/附件读取失败占位文案可断言；维持纯文本、身份解析语义不变。
- **产出（文件域）**：plugins/src/chatResponder.ts、plugins/tests/chat-responder.test.mjs（新增 describe）。
- **依赖**：建议 S3+S4（输入形状对齐；纯函数域与 S1/S2/S7 不相交可并行）。**工作量**：M。**完成 =（DoD）**：§1 S5 行逐条命令输出为证 = 完成。
- **测试锚点**：四象限（有/无摘要 × 有/无附件）块产出、顺序断言、预算截断标记、降级占位文案、无 HTML 注入面、既有 TC-S10 不回归。
- **纪律**：不改 chatIdentityFor 与既有提示词基座语义（TC-S10-04/05 断言保留）；零新增依赖。

### 3.7 S6 守护上下文接线【R-2/R-3/R-4 · 工作量 L】
- **目标**：把 S4 摘要 + S3 附件取回接进 answerChatMessage——模型解析与开关逻辑不变，在 buildChatAnswerPrompt（index.ts :2413-2419 拼装区）前：构造 spaceDigest（经 spaceDigest 模块，源 = repoRootFor 绑定仓库根；无绑定 → 降级占位）；读 msg.meta.attachments 逐个 GET /api/chat/attachments/content 取文本（单附件 ≤4000 截断）；预算分配（合计 ≤8000 默认，先裁摘要后裁附件，env 可覆写）经 S5 纯函数；摘要/附件读取失败走降级占位且不把源消息标 failed（异常只进日志——上下文失败不阻断会话）；附件内容仅进当次提示词、不落消息体/meta、不跨消息缓存。
- **产出（文件域）**：plugins/src/index.ts（answerChatMessage 上下文拼装段；预算纯函数可置于 chatResponder.ts 以可单测）。
- **依赖**：S2（index.ts 链收尾）+ S3 + S4 + S5。**工作量**：L。**完成 =（DoD）**：§1 S6 行逐条命令输出为证（typecheck 0、静态断言、预算断言、宿主 L1 冒烟或记录复现步骤）= 完成。
- **测试锚点**：摘要/附件块出现在最终 prompt、预算先裁摘要、失败占位不标 failed、跨消息无附件泄漏（连续两问）。
- **纪律**：不给回复方工具权限（C1 而非 C2）；上下文只读/预算内/当次有效；零新增依赖。

### 3.8 S7 UI 前置：选空间入口 + 健康状态条 + 回复设置【R-1/R-2 · 工作量 L】
- **目标**：落地 AC-R1-5/6、AC-R2-1/2、AC-R1-3 可见化——ChatView 三处改造：①!scope 死路卡（:250-261）→「选择工作空间开始对话」空间列表（复用 api.ts fetchSpaces :168，新增 props spaces 与 onPickScope，App.tsx :447 挂载处传 setScope）②chat-head（:345-354）健康状态点（api.ts 新增 fetchChatHealth → GET /api/chat/health；绿/黄/红三态，端点缺失灰态）③回复设置弹窗（齿轮入口，接线既有 fetch/saveChatReplySettings api.ts:601-618：开关必含、model/identity/systemHint 可选）。既有 awaiting/replied/failed 三态与重试按钮（:407-441）保持并消费 S1 的可行动文案。
- **产出（文件域）**：workbench/src/components/ChatView.tsx、workbench/src/App.tsx（挂载处传 props）、workbench/src/api.ts（fetchChatHealth 等）。
- **依赖**：S2。**工作量**：L。**完成 =（DoD）**：§1 S7 行逐条命令输出为证（pnpm build 全绿、源码断言死路卡替换、宿主冒烟或记录复现步骤）= 完成。
- **测试锚点**：入口冒烟（全部空间 → 选 software → 可发消息）、健康三态、开关关后发送无 awaiting、toast 透传错误、渲染安全。
- **纪律**：渲染纯文本不直插 HTML（既有 S2 安全断言不回归）；切换空间走既有 setScope + R-A5 身份守卫；零新增依赖。

### 3.9 S8 UI 附件行【R-3 · 工作量 M】
- **目标**：落地 AC-R3-1/3/4、AC-R3-6——ChatView composer（:442-464 区域）加 📎 附件行：隐藏 input type=file multiple、chip 行（文件名+大小）可移除、客户端预检（大小 ≤10MB/数量 ≤3/黑名单扩展名）；api.ts 增 uploadChatAttachment（PUT /api/chat/attachments，raw Blob）并把 postChatMessage 扩展为携带 attachmentIds；发送成功清槽、失败保留 + toast（对齐既有 send 失败保留草稿 :312-316）；发送/上传中禁用按钮；消息旁渲染 meta.attachments 附件标识（纯文本）；types.ts 增 ChatAttachmentRef。
- **产出（文件域）**：workbench/src/components/ChatView.tsx（附件段，与 S7 不同函数区）、workbench/src/api.ts（附件函数段）、workbench/src/types.ts。
- **依赖**：S3（upload/绑定契约）+ S7（同文件链）。**工作量**：M。**完成 =（DoD）**：§1 S8 行逐条命令输出为证 = 完成。
- **测试锚点**：上传成功/预检拒绝/移除后请求无附件/发送 payload 无文件正文/附件标识渲染/无附件回归。
- **纪律**：附件内容不进 draft/body；渲染安全；与既有文件中心 upload（api.ts filesUpload）不同端点不混淆；零新增依赖。

### 3.10 S9 文档收口【R-5 · 工作量 M】
- **目标**：落地 AC-R5-1/2/3——docs/FEATURES.md §3.9（:133-140 区域）与功能索引（:224）与排障表（:249 区域）更新到实现后行为（回复设置入口位置、关联空间与上传文件操作与边界、AI 不回/回复失败排查行含守护与模型前提与重试指引）；README.md（:98 引导 + §6 故障排查 :155 起）同步；workbench/README.md 同步；消除 §2.6「文档超前 UI」不一致；过既有 docs 门禁（scripts/ci/check-docs.mjs / run-ci doc 阶段）不回归。
- **产出（文件域）**：docs/FEATURES.md、README.md、workbench/README.md。
- **依赖**：S1/S3/S7/S8（行为定稿后落笔）。**工作量**：M。**完成 =（DoD）**：§1 S9 行逐条命令输出为证（关键句断言 + check-docs exit 0）= 完成。
- **纪律**：只改上述三文档；不扩写新手册章节结构；随真实行为落笔不提前承诺（R-5 scope）。

## 4. 需求 / 方案 / 切片对照（无遗漏自检）

| 需求（REQUIREMENTS §5，AC 口径） | 覆盖切片（文件域） | 方案落点（RESEARCH） |
| --- | --- | --- |
| R-1（P0）可回答闭环：AC-R1-1/2/3/4/6 | S1（隔离复现锚点 AC-R1-1、分类可行动文案 AC-R1-3）；S2（健康/心跳/daemon 状态）；S7（入口 AC-R1-6、设置开关 AC-R1-5、健康条 AC-R1-3 可见化）；AC-R1-2/4（真回复与重试闭环）与 AC-R1-7（回归）由 S1 的 chat.test 不回归断言 + S7 宿主冒烟 + 后续 tester 隔离 L1 承接 | A1（分类器）+ B1+B2（健康/心跳） |
| R-2（P0）关联工作空间：AC-R2-1..5 | S4（摘要模块）+ S6（注入接线，AC-R2-3/4）+ S7（入口/切换 AC-R2-1、身份正确沿用既有守卫回归 AC-R2-2/5）+ S5（摘要块与降级占位） | C1（确定性摘要）+ D1（分块注入/降级） |
| R-3（P0）上传文件：AC-R3-1..6 | S3（数据面：上传/绑定/取回/清理，AC-R3-1/3/5 后端）+ S8（附件 UI：选择/预检/移除/标识，AC-R3-1/3/4）+ S5/S6（附件内容进当次提示词，AC-R3-2）+ 回归（AC-R3-6） | E1（chat_attachments + uploads）+ F1（原生附件控件） |
| R-4（P1）护栏：AC-R4-1..6 | 服务端护栏/审计/TTL（AC-R4-2/3/4/6）→ S3；预算截断纯函数与降级占位（AC-R4-1/5）→ S5；取回预算分配与当次隔离（AC-R4-1/6）→ S6 | G1 常量+env + D1 预算/占位（横切归入宿主切片） |
| R-5（P2）文档收口：AC-R5-1/2/3 | S9（三文档 + check-docs 门禁） | RESEARCH §11.1 S8 说明（无技术决策） |
| 全局：零新增运行时依赖 | 全切片纪律（每片零新增依赖断言） | RESEARCH §9 结论（0 运行时依赖） |

**D 系列默认采纳**（REQUIREMENTS §8，将军未否决即基线）：D-1 对象 = Legion workbench 对话中心；D-2 关联空间语义 = 只读真实内容摘要注入（C1，不给工具）；D-3 上传 = 当次回复上下文 + TTL 清理（S3）；D-4 回复设置 UI 入口 = 对话中心暴露开关（S7）；D-5 历史遗留消息 = 不回填不自动轰炸（S1 静态断言）；D-6 限制默认值（≤10MB/≤3 附件/黑名单/预算 8000）= S3/S5/S6 常量与 env；D-7 交付顺序 = R-1 先行（注册序 S1→S2→S7 前置）；D-8 时间窗/重试 = 沿用（S1 不引入自动重试）。

## 5. 边界、风险与假设（breaker 视角）

- 🚫 本拆解不写实现、不改需求语义与方案结论；范围以 REQUIREMENTS R-1~R-5 为准；不拆 out-of-scope 内容（不做流式打字机、不做回复方自由工具/MCP 工具面、不做跨空间聚合上下文、不做非文本多模态、不做 RAG/长期记忆、不新增第三方依赖）。
- 🚫 不拆出无法验收的悬空任务：每片 DoD 与 §1 机器行逐条对应 AC；宿主不可达的 L1 冒烟项一律带「如实记录复现步骤」兜底而非黑盒跳过。
- ⚠️ 风险 RK-1（根因可能为环境/模型通道）：S1 分类器把根因「分类暴露」+ S2/S7 可见化 + S9 文档排障行；若隔离复现证明 provider 本身不可用 = 部署环境问题，按 REQUIREMENTS §4.2 另行报障，不属于切片实现。RK-2/RK-3（上下文出站风险/预算膨胀）：R-4 护栏（S3/S5/S6）全量落地。RK-4（live 库零写入）：全部测试临时库范式；S1 复现锚点用 fake 子代理 + 临时库。RK-5/RR-6（共享文件冲突）：同文件硬串行 + 注册顺序 + mediator 调解。RK-6（健康「假绿」）：端点诚实标注「已解析不代表可用」+ 红/黄/绿由最后一次实际结果校准（S2/S7）。RK-7（附件留存面）：TTL 清理 + 生命周期文档化（S3/S9）。
- ℹ️ 环境与验证事实：本 worktree 无 node_modules；plugins 构建需 DSH_CHECKOUT（build.sh 探针未覆盖本机 checkout 路径时需显式传 DSH_CHECKOUT）；plugins/workbench 的 typecheck/build 需宿主或 junction（run-ci deps），受限时如实记录复现步骤与输出（仓库惯例）。chat.test.mjs 基线实测 exit 0（23/23）。S3 的 uploads 目录与测试临时库同基自动隔离；禁止在任何验证中触碰 live 库 D:/project/DSH/legion/team-hub/team.db。
- ℹ️ 文档级共享说明：README.md 与 docs/FEATURES.md 仅 S9 持有（本文档自身不把文档级文件列入其它切片文件域）；改动行为时按仓库纪律同步受影响说明由各切片内联完成。

## 6. 端到端验收总口径（供将军快速验收，对应 REQUIREMENTS §6）

1. **可回答主路径**：选中 software 空间 → 发送「你好」→ 守护在线+模型可用时 ≤120s 收到回复（awaiting→replied）；失败时 ❌ + 分类可行动文案 + 重试可用（R-1，S1+S7 承接，隔离 L1 由 tester 实跑）。
2. **上下文输入 · 工作空间**：全部空间视图一键选择工作空间开始对话；software 会话问「顶层目录/README 讲了什么」→ 回答引用绑定仓库真实内容（R-2，S4/S6/S7）。
3. **上下文输入 · 上传文件**：上传含独有事实的文本文件提问 → 回答引用该事实；不传无此事实（对照断言）（R-3，S3/S5/S6/S8）。
4. **失败可行动**：模型配置不可用 → ❌ +「如何恢复」文案 + 重试；健康条黄/红提示（R-1，S1/S2/S7）。
5. **不误伤回归**：人-人收发、无附件消息、数据面 23 例、CI chat 阶段全绿；live 库零写入（S1/S3/S5/S6/S7/S8 各自回归断言）。
6. **文档一致**：FEATURES §3.9 / README 与实现一致，含失败排查与上下文操作说明（R-5，S9 + check-docs 门禁）。

*（本文件由 T-121 任务拆解士兵产出，仅落在 docs/G-mtr3su6f-1/TASK_BREAKDOWN.md；未改任何仓库实现、未调用 taskctl/看板写接口、未 push。）*

