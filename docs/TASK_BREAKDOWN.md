# T-097 任务拆解：四能力（跨空间技能共享 · 分层项目规范 · 移除空间 · 对话接入 AI 回复）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-097（分支 w/T-097 独立 worktree，HEAD = ba0372d promote T-096）
> 上游：T-095 需求澄清（docs/REQUIREMENTS.md T-095 四项能力版，唯一权威需求基线）→ T-096 方案搜索（docs/RESEARCH.md 现文 = T-096 四能力方案报告，一等选型 K1-A..K10-A + 闸门 G-R1..G-R5）
> 下游：守护解析本文件「## slices」注册 coder_Si → tester_Si 微链 → 逐切片开发/测试 → S12 集成回归锚定
> 依据：LEGION.md 纪律、本任务验收标准与边界、T-095 REQUIREMENTS §5 R-1..R-4（AC-R1-1..9 / AC-R2-1..7 / AC-R3-1..6 / AC-R4-1..8）、§8 D-1..D-17（默认值即基线）、T-096 RESEARCH §12（11 条切片建议 + 闸门，默认值即一等，将军未否决即按默认放行）
>
> **权威基线提醒（重要）**：工作树内 docs/REQUIREMENTS.md 已被另一 auto-goal 链（T-103「任务详情文档预览」）改写，**与本批四项能力无关，下游勿引用**；本批需求基线 = T-095 四项能力版，经 `git show 3c8f27d:docs/REQUIREMENTS.md` 可复核原文（本文 AC 编号均指向该版）。docs/RESEARCH.md 现文即 T-096 本批方案报告（含 §1.1 需求摘要与全部 [本地] 行号锚点；HEAD 代码与 3c8f27d 逐字节一致——本阶段实测 git diff 仅 docs 两文件变化）。
>
> **取代关系**：本文档**取代**同文件 T-075 拆解（三中心收尾批产物，其切片均已交付合入 main，仅历史留存）；旧版经 git 历史回溯（git log --follow docs/TASK_BREAKDOWN.md）。

## 0. 结论速览（TL;DR）

- 拆解产物：**12 个切片（S1~S12）**，按需求分组：
  - **R-1 跨空间共享技能（P0，3 片）**：S1 后端（listSkills scope:B 语义 + revokeSkill + review/grant/revoke general 门禁 + include=pending 收口 + 审计带目标空间）、S2 前端（共享视图/来源标识/授权与撤销 UI）、S3 守护缓存指纹刷新。
  - **R-2 分层项目规范（P0，3 片）**：S4 后端（全局规范层 rules 表 + /api/rules + 审计/SSE，即 RESEARCH K3-A）、S5 解析注入（readNorms 两层合并 + agent.md 文件族 + 预算截断 + buildWorkerPrompt 双段，即 K4-A/K5-A）、S6 规范维护 UI + 职责总纲文档。
  - **R-3 移除空间（P1，2 片）**：S7 后端（删除级联扩至 chat/calendar/members + 预检影响端点 + 测试，即 K6-A/K7-A 后端）、S8 前端（SpaceSettingsModal 危险区 type-to-confirm + 切回全部空间）。
  - **R-4 对话 AI 回复（P0，3 片）**：S9 后端数据面（chat_reply_settings + awaiting 状态机 + 队列端点 + 超龄兜底）、S10 守护 chat-responder（扫单 → DSH 子代理 LLM 直答 → 落第二条消息，即 K8-A/K10-A）、S11 前端（ChatView 身份泛化 + AI 三态气泡）。
  - **S12 四能力集成回归锚定**（docs/TEST_REPORT.md，收口验证，仿 T-075 S8 惯例）。
- 全批**零新增运行时依赖**（一等选型全部 node:sqlite / node:http / Node fetch / EventSource / React / DSH 子代理通道，已在产线；禁网纪律不变）。
- **文件域纪律（并行合入安全的前提）**：同一文件只允许 1 个切片并发持有；跨切片同文件场景全部**同文件硬串行**并以注册顺序保证（当前生产单 worker 按注册顺序派工，天然串行）：
  - team-hub/server.mjs 链：**S1 → S4 → S7 → S9**（skills DAO/路由段 → rules 表段 → spaces 删除段 → chat 数据面段）；
  - plugins/src/index.ts 链：**S3 → S5 → S10**（fetchSkills 段 → readNorms/buildWorkerPrompt 段 → responder 段）；
  - workbench api.ts 与 App/Sidebar 壳链：**S2 → S6 → S8**（skills 段 → rules 段与「规范」面板接线 → deleteSpace 段与设置弹窗）。
- **禁止**在提升并发槽位后同时派工同文件域的相邻切片（§2.2 给出可并行组合清单）。

## 1. 机器可读切片清单（守护据此注册并行派工，逐行严格遵循：每行四段用 | 分隔，段内不再出现 |；第 2 段文件逗号分隔；第 4 段验收分号分隔）

## slices
- S1 | R-1 后端：跨空间技能共享语义（listSkills scope:B 可见 + revokeSkill + review/grant/revoke general 门禁 + include=pending 收口 + 审计带目标空间） | team-hub/server.mjs, team-hub/skills.test.mjs | node team-hub/skills.test.mjs（node --test 同效）全绿：新增跨空间/撤销/门禁用例通过且既有 12 例不回归;已发布技能 scope=A 经 grant(S, ['scope:B']) 后 listSkills({scope:B}) 返回 S 且未授权空间 C 不返回（AC-R1-1）;revoke 后 B 视角立即不可见，重复 revoke 或撤销未授权技能幂等不抛未定义错误（AC-R1-2）;非 general 调 review/grant/revoke 走路由 → 4xx + 明确错误文案，general 成功（对照 server.mjs 删空间 :1873 先例；register 维持现状）（AC-R1-3）;grant/revoke 审计行含技能归属 scope 与目标空间且 action 前缀 skill:（AC-R1-4）;删除源空间后 B 查询不再含 A 技能、无悬空引用（级联随 :1885 现状）（AC-R1-6）;include=pending 仅 general 可读，其余查询与全部空间视图不暴露任何 pending/rejected 技能 prompt（收口 :1976-1980 敞口）（AC-R1-7）;零新增运行时依赖（server.mjs 无新增 import/依赖）
- S2 | R-1 前端：指挥台共享技能视图（来源标识 + 只读含 prompt + 授权/撤销接线） | workbench/src/components/SkillsPanel.tsx, workbench/src/api.ts | pnpm --dir workbench build 全绿（tsc --noEmit 0 诊断；EPERM 受限时记录复现步骤并附 tsc 结果）;B 空间技能中心显示来自空间 X 的共享技能条目（来源标识 + 只读 + prompt 全文可见，published only，草稿绝不外泄），A 空间保留授权管理（目标空间选择 + 行内撤销），fetch 走既有 /hub 代理（AC-R1-8）;UI 冒烟（serve.mjs 托管 + hub，:5173）：A 授权 scope:B → B 可见；A 撤销 → B 刷新后条目消失；非 general 操作呈现后端明确错误文案;渲染安全：无 dangerouslySetInnerHTML 直插服务端文本;chat/files/calendar 面板无回归
- S3 | R-1 守护注入缓存失效：fetchSkills 按 (id, version, contentHash) 指纹比对刷新 | plugins/src/index.ts | 插件 typecheck 0 诊断（tsc -p plugins/tsconfig.json --noEmit；本 worktree 无 node_modules 属环境受限，记录复现步骤不冒充通过）;fetchSkills（:436-447）长度比较改为指纹比较：同数量技能改版（version+1 且已 publish）→ 缓存刷新并注入新 prompt；指纹不变 → 不刷新；共享技能新增/撤销 → 下一轮反映（AC-R1-5）;指纹纯逻辑可测（同量改版刷新 / 同指纹不刷新 / 撤销后移除三断言）;既有插件回归（plugins/tests 套件，宿主环境；受限时如实记录）不回归;零新增依赖
- S4 | R-2 后端：全局规范层（rules 表 + GET/POST /api/rules + 审计/SSE，RESEARCH K3-A） | team-hub/server.mjs, team-hub/rules.test.mjs | node team-hub/rules.test.mjs（node --test 同效）全绿（新增套件，HTTP 范式仿 calendar.test.mjs：临时 TEAM_HUB_DB + 真实随机端口）;老库 import 自动建表幂等（CREATE TABLE IF NOT EXISTS，零迁移风格）;GET /api/rules?scope=global 返回 {content, updatedAt}（未设置给空串与合理默认），POST /api/rules 写 handleWrite（by 必填、缺失 400；action=rules:update 入 audit；SSE /api/events 广播可达）（AC-R2-6 后端）;内容长度上限护栏（默认超限 4xx 或明确截断，断言其一）;skills/chat/calendar 既有套件不回归;零新增运行时依赖（仅 node:sqlite）
- S5 | R-2 解析注入：分层规范读取合并（全局层 + 空间/项目层文件族含 agent.md）+ 预算截断 + buildWorkerPrompt 双段注入（RESEARCH K4-A/K5-A） | plugins/src/index.ts | 插件 typecheck 0 诊断（环境受限时记录复现步骤）;readRepoRules 重构为 readNorms 两层读取：空间层锚点 = 空间绑定仓库根 repoRootFor()，文件族按序读全部存在者 LEGION.md → AGENTS.md → agent.md，输出 [全局层段] + [空间层段]，顺序稳定且空间层后置并带「空间/项目层优先于全局层」声明（AC-R2-1/2）;兼容回归：仅 LEGION.md（现状）时注入文本与现状逐字一致（含「仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）」段），无任何文件时不输出规范段且不报错（AC-R2-3）;预算截断纯函数（全局 ≤3000 / 空间 ≤4000 / 合计 ≤7000 可配；超限在段落边界截断并追加「规范超限截断：原文 N 字，已保留前 M 字」，不产生半截代码块）（AC-R2-4）;buildWorkerPrompt 规则小节引用 readNorms（AC-R2-5 冒烟：宿主可达时派工提示词含两段规范文本且顺序正确，不可达记录复现步骤）;既有派工/流转插件回归不回归;零新增依赖
- S6 | R-2 前端 + 总纲：指挥台「规范」维护入口（全局层可编辑 + 空间层明确跳转）+ README/LEGION 职责总纲段 | workbench/src/components/RulesPanel.tsx, workbench/src/components/Sidebar.tsx, workbench/src/App.tsx, workbench/src/api.ts | pnpm --dir workbench build 全绿（tsc 0 诊断）;Sidebar/App 接线「规范」面板入口进入 RulesPanel（非 toast 占位）；全局规范内容可编辑保存（POST /api/rules 走既有 hub 代理 by 自动注入），成功/失败 toast 明确；空间层规范文件（LEGION.md/AGENTS.md/agent.md）给出路径与「文件中心/仓库内编辑」跳转指引（AC-R2-6）;保存后守护下一轮派工提示词反映新内容（宿主可达时冒烟；不可达记录复现步骤）;README/LEGION 新增「规范载体职责总纲」段（文件族空间层 vs rules 表全局层 vs skills vs roles.json stage.prompt 各自承载内容/维护入口/优先级，RESEARCH §16.1 矩阵落地）;渲染安全无 dangerouslySetInnerHTML 直插;chat/files/browser/calendar/skills 面板无回归（评审断言）
- S7 | R-3 后端：删除语义收口（级联扩至 chat/calendar/members + 影响预检端点 + 测试）（RESEARCH K6-A/K7-A 后端） | team-hub/server.mjs, team-hub/spaces.test.mjs | node team-hub/spaces.test.mjs（node --test 同效）全绿（新增套件，HTTP 范式仿 calendar.test.mjs）;POST /api/spaces/delete 事务级联在现 7 表基础上追加 conversations/messages/calendar_events/members 四表（D-10 默认随删），removed 计数逐表断言、audit 历史保留（AC-R3-4/5）;confirm 缺失/错配、未知空间、software/default 受保护、非 general 均 4xx 且文案明确;新增只读 GET /api/spaces/impact?id= 返回任务/编队/成员/会话与消息/日程/技能计数与在办执行状态（供前端确认弹窗预检）;删除后 GET /api/scopes 不再含已删 id（幽灵分区收口断言）;skills/chat/calendar 既有套件全绿;零新增依赖
- S8 | R-3 前端：SpaceSettingsModal「删除工作空间」危险区（type-to-confirm + 影响预检 + 删当前空间切回全部空间） | workbench/src/components/SpaceSettingsModal.tsx, workbench/src/App.tsx, workbench/src/api.ts | pnpm --dir workbench build 全绿;api.ts 增 deleteSpace(id, confirm)（POST /api/spaces/delete body {id, confirm: delete-space:<id>}）（AC-R3-1 后端契约前传）;SpaceSettingsModal 危险区仅对非 software/default 且 hub 模式显示：展开先调 GET /api/spaces/impact 渲染影响清单与在办任务强提示，输入 delete-space:<id> 才可点确认（AC-R3-1）;删除当前激活空间成功后切回「全部空间」并重拉列表（复用 App.tsx:288-302 刷新模式），spaces 列表不再含该 id（AC-R3-2）;software/default 无入口或禁用并说明（AC-R3-3）;失败（confirm 错/未知/受保护/非 general）呈现后端明确错误文案不静默;渲染安全与既有面板无回归
- S9 | R-4 后端数据面：每空间回复开关 + awaiting 状态机 + 回复队列端点 + 超龄兜底（RESEARCH K9-A 数据面） | team-hub/server.mjs, team-hub/chat.test.mjs, team-hub/chat-l1-smoke.mjs | node team-hub/chat.test.mjs 全绿（新增用例且既有用例不回归；老库零迁移：不加列仅 meta 扩展，TC-S1-16 断言不回归）（AC-R4-5）;chat_reply_settings 表 CREATE TABLE IF NOT EXISTS 幂等（scope 主键、enabled 默认 1、model/identity/systemHint/updatedAt 可空），每空间开关读写持久化（AC-R4-3 后端）;postMessage 在空间开关开且 author ≠ 回复方身份时同事务写 messages.meta.aiStatus=awaiting（零迁移，回复方身份默认 <scope>-assistant）（AC-R4-1/2 后端）;GET /api/chat/replies?scope=&sinceMsgId= 返回 awaiting 消息并聚合最近上下文（limit 上限防爆）；awaiting 超龄（默认 120s）由服务端标记 failed + meta.error（AC-R4-4 兜底）;回复方写入复用既有 DAO 通道：author=by 防冒名（TC-S1-07 不回归）、audit chat:message、SSE 送达（AC-R4-2/6）;kind 仅 text 且长度 ≤ MAX_CHAT_BODY=8000（AC-R4-7 后端）;node team-hub/chat-l1-smoke.mjs 22+ 断言通过;零新增依赖
- S10 | R-4 守护执行：chat-responder 扫单（拉 awaiting → DSH 子代理 LLM 直答 → 落第二条消息 → 状态回写）（RESEARCH K8-A/K10-A） | plugins/src/index.ts | 插件 typecheck 0 诊断（环境受限时记录复现步骤）;新增 responder 段（独立 interval 或并入 sweep，默认 10-30s）：拉 GET /api/chat/replies → 每条派生无仓库工具的轻量子代理（提示词 = 空间对话助手、基于会话历史、禁工具/文件访问；模型按 chat_reply_settings.model 或该空间默认）→ 生成文本 POST /api/chat/messages {conv, body, kind:text, by: 回复方身份}（identity 默认 <scope>-assistant，≠ general 与用户）（AC-R4-1/2）;子代理失败/超时 → 回写 meta.aiStatus=failed + meta.error（AC-R4-4）;状态机 CAS 幂等防重复回复（仅 awaiting→replied 可成功、重复拉取幂等）；只对非回复方消息触发防死循环；并发/超时护栏仿 worker 既有 config;宿主可用时冒烟（发送 → ≤120s 收到回复；关开关无回复；失败呈现），宿主不可达如实记录复现步骤不冒充通过;既有插件回归不回归;零新增依赖
- S11 | R-4 前端：ChatView 身份泛化 + AI 回复三态气泡（等待中/失败可重试/已回复 + 模型徽标） | workbench/src/components/ChatView.tsx | pnpm --dir workbench build 全绿;author 判定泛化：general = 我，其余 author（含 <scope>-assistant 等回复方身份）一律对方侧渲染，回复方气泡带 🤖 + meta.aiModel 徽标（AC-R4-2 UI）;气泡按 messages.meta.aiStatus 呈现三态：awaiting（等待中 + 时间戳）/ failed（明确失败提示 + 重试动作将消息重新置 awaiting）/ replied（正文）（AC-R4-4 UI）;纯文本渲染不执行 HTML（无 dangerouslySetInnerHTML 直插服务端文本）（AC-R4-7）;既有会话守卫（loadOlder/send 写回前会话身份比对，R-A5）与 A/B 会话快速切换不串显不回归;宿主可用时冒烟：发送 → 等待态 → 回复到达或失败呈现，chat-s2-smoke（/hub 代理主路径）通过；不可达记录复现步骤
- S12 | 四能力集成回归锚定（全部套件 + 端到端清单写入 TEST_REPORT.md） | docs/TEST_REPORT.md | 逐套件运行并记录输出要点：node team-hub/skills.test.mjs、chat.test.mjs、rules.test.mjs、spaces.test.mjs、calendar.test.mjs（node --test 同效）全绿 0 失败并记用例数;workbench pnpm build 全绿（tsc 0 诊断；EPERM 受限时记录复现步骤）;plugins typecheck 0 诊断（环境受限时记录复现步骤）;docs/TEST_REPORT.md 增补四能力端到端清单与结果：技能跨空间授权 → B 可见 → 撤销消失 → 守护指纹刷新注入新内容;规范全局层 + 空间层双段注入且空间层优先声明;移除空间闭环（预检 → type-to-confirm → 删除 → 切回全部空间 → 无幽灵分区）;对话发送 → 等待态 → AI 回复或明确失败呈现（宿主不可达时如实记录环境受限 + 复现步骤）;零新增运行时依赖复核（package.json 无新增项）

## 2. 依赖关系、执行顺序与并行（给人看）

### 2.1 blockedBy 一览（同文件域 = 硬串行；跨域 = 可并行；注册顺序 = 派工顺序）

| 切片 | blockedBy（注册序执行时） | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | R-1 后端为共享语义根；无前置 | M |
| S2 | S1（listSkills scope:B/revoke 后端须合入可验） | 前端共享视图依赖后端语义与端点 | M |
| S3 | S1（服务端 listSkills 返回语义稳定后实现指纹） | 守护缓存依赖服务端响应形态；与 S2 域不相交可并行 | S |
| S4 | S1（同 team-hub/server.mjs 硬串行） | R-2 后端与 R-1 后端同文件不同段，须串行 | M |
| S5 | S3（同 plugins/src/index.ts 硬串行）+ S4（全局层数据源合入后可做 AC-R2-5 注入冒烟） | 分层解析与 fetchSkills 同 plugins 文件；注入验证需 /api/rules | M |
| S6 | S2（同 workbench api.ts 链）+ S4（rules API）+ S5（保存后提示词反映新内容需注入合入） | 「规范」面板接线与 skills 前端同 api.ts/壳文件 | M |
| S7 | S4（同 team-hub/server.mjs 硬串行） | 删除收口与 rules 段同文件不同段，须串行 | M |
| S8 | S6（同 workbench api.ts/App 链）+ S7（预检/删除端点合入可验） | 删除入口与规范面板同壳文件；后端契约先合入 | M |
| S9 | S7（同 team-hub/server.mjs 硬串行） | chat 数据面与 spaces 段同文件不同段，须串行 | M-L |
| S10 | S5（同 plugins/src/index.ts 硬串行）+ S9（队列端点/状态机合入后可扫单） | responder 依赖数据面契约；与 S3/S5 同 plugins 文件 | L |
| S11 | S9（meta 数据面合入）+ S10（实际回复执行合入做 E2E 冒烟） | 前端三态依赖数据契约与执行方 | M |
| S12 | S1~S11 全部 done | 集成回归锚定必须在收口后执行 | M |

**无循环依赖**：所有边沿沿「后端/数据面 → 前端/执行 → 集成回归」方向；三条同文件链（server.mjs：S1→S4→S7→S9；plugins：S3→S5→S10；workbench 壳：S2→S6→S8）均为线性，不存在回边。

### 2.2 执行顺序与并行建议

- **默认安全路径（当前生产守护单 worker，按注册顺序派工）**：S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12。注册顺序即派工顺序，本清单已按依赖拓扑排好。
- **若将军提升并发槽位（maxWorkers ≥ 2）**：只允许派工**文件域两两不相交**的组合（见 §1 每行第 2 段）；**严禁**同时派工同一文件的相邻切片——S1/S4/S7/S9 互斥、S3/S5/S10 互斥、S2/S6/S8 互斥。域不相交即可并行的示例：{S2, S3}（workbench vs plugins）、{S3, S4}（plugins vs server.mjs）、{S6, S7}、{S8, S9}、{S2, S4} 等。S12 永远最后。
- **文档级共享说明**：README.md / LEGION.md / workbench/README 不列入任何切片第 2 段文件域（文档级冲突可语义合并，仿 T-075 惯例）；各切片在实现时按需同步更新相关说明（仓库纪律「修改行为同时更新受影响文档」）。

## 3. 子任务明细（每切片 = 一个士兵一轮可完成并验收；「验收」以 §1 机器行逐条为准；工作量刻度 S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满）

#### S1 R-1 后端：跨空间技能共享语义【P0 · team-hub/server.mjs 链起点】
- **目标**：按 RESEARCH K1-A 原地补齐 grants 引用式共享后半程——listSkills 对 scope=B 自动返回 grants 含 scope:B 的已发布技能（服务端判定，UI 无需传 member）；新增 revokeSkill(id, targets)（从 grants 过滤删除并写回）；路由 review/grant/revoke 加 general 门禁（对照 :1873 先例）；审计 detail 携带技能归属 scope 与目标空间；include=pending 收口为 general-only（堵 AC-R1-7 敞口）。
- **产出（文件域）**：team-hub/server.mjs（skills DAO/路由段 :469-527/:1748-1786/:1960-1982）、team-hub/skills.test.mjs（追加跨空间/撤销/门禁/级联用例）。
- **依赖**：无（行内起点）。**工作量**：M。**完成 =（DoD）**：skills.test.mjs 新增用例全绿 + 既有 12 例不回归 + AC-R1-1/2/3/4/6/7 各有一断言（真实命令输出为证）= 完成；无需前端与守护改动。
- **测试锚点（test-designer 直转）**：跨空间矩阵（B 可见/C 不可见/pending 不外泄）、撤销即时生效与幂等、非 general 4xx 文案、audit detail 形状（技能 scope + 目标空间 + action 前缀 skill:）、删源空间级联。**纪律**：只改上述两文件；路由守卫放 handleWrite run 内同款位置；零新增依赖。

#### S2 R-1 前端：指挥台共享技能视图【P0 · workbench api.ts 链起点】
- **目标**：按 RESEARCH §12.1 R-1 前端——B 空间技能中心出现「来自空间 X」的共享技能条目（只读 + prompt 全文可见 + 不可编辑，草稿绝不出现）；A 空间技能中心对已授权技能提供「撤销授权」行内动作与授权目标空间选择（与 grant 输入同构）；撤销/授权结果即时反映。
- **产出（文件域）**：workbench/src/components/SkillsPanel.tsx、workbench/src/api.ts（skills 段）。
- **依赖**：S1。**工作量**：M。**完成 =（DoD）**：pnpm --dir workbench build 全绿；UI 冒烟走通 A 授权 → B 可见 → A 撤销 → B 消失（serve.mjs + hub 宿主可用时；不可达记录复现步骤）= 完成。
- **测试锚点**：来源标识渲染、只读（无编辑入口）、授权目标选择与撤销按钮调正确端点、错误 toast（非 general/后端 4xx 文案透传）。**纪律**：渲染纯文本不直插 HTML；只改上述两文件。

#### S3 R-1 守护注入缓存失效【P0 · plugins 链起点】
- **目标**：按 RESEARCH K2-A——fetchSkills（plugins/src/index.ts:436-447）由长度比较（:442-445）改为响应指纹比较（[id, version, contentHash] 序列化），同数量改版（version+1 已 publish）即刷新，指纹不变不刷新，撤销/新增随列表变化下一轮生效。
- **产出（文件域）**：plugins/src/index.ts（fetchSkills/缓存段）。
- **依赖**：S1（服务端语义稳定）。**工作量**：S。**完成 =（DoD）**：指纹逻辑抽出纯函数并可 node --test 断言三态（同量改版刷新 / 同指纹不刷新 / 撤销后移除）；plugins typecheck 0 诊断（受限时记录复现步骤）= 完成。
- **纪律**：零新增依赖；不引入 SSE 推送（D-5 默认轮询）。

#### S4 R-2 后端：全局规范层（rules 表 + API）【P0 · RESEARCH K3-A】
- **目标**：按 K3-A——team-hub 新增 rules 表（key 主键、scope、content、updatedAt；key=global 即全局层，scope 预留空间层扩展点）+ GET/POST /api/rules（写走 handleWrite：by 必填 + audit action=rules:update + SSE）+ 内容长度上限护栏；老库 IF NOT EXISTS 幂等建表零迁移。
- **产出（文件域）**：team-hub/server.mjs（rules 表/路由段，与 S1/S7/S9 不同行段）、team-hub/rules.test.mjs（新增，HTTP 范式仿 calendar.test.mjs）。
- **依赖**：S1（同文件硬串行）。**工作量**：M。**完成 =（DoD）**：rules.test.mjs 全绿（建表幂等 / GET 默认值 / POST by 必填 / audit+SSE / 长度护栏）；skills/chat 不回归 = 完成。
- **测试锚点**：旧库 import 自动建表、action=rules:update 可经 /api/activity 查、SSE 广播可达、超限拒绝或明确截断其一。

#### S5 R-2 解析注入：readNorms 分层合并 + 预算 + 双段注入【P0 · RESEARCH K4-A/K5-A】
- **目标**：readRepoRules（:850-862）重构为 readNorms——全局层来源（守护按 config 经 GET /api/rules?scope=global 拉取 + 缓存）+ 空间层来源（repoRootFor() 锚点下文件族 LEGION.md → AGENTS.md → agent.md 读**全部存在者**）合并为两段输出，空间层后置并带优先级声明；预算（全局 ≤3000 / 空间 ≤4000 / 合计 ≤7000，可配）段落边界截断 + 超限提示；buildWorkerPrompt（:1087-1089 规则段）引用新解析。仅 LEGION.md 现状兼容（AC-R2-3）；无文件不输出不报错。
- **产出（文件域）**：plugins/src/index.ts（readNorms/buildWorkerPrompt 段 + 预算纯函数，与 S3/S10 不同行段）。
- **依赖**：S3（同 plugins 文件硬串行）+ S4（全局层数据源，AC-R2-5 注入冒烟需要）。**工作量**：M。**完成 =（DoD）**：解析纯函数（两层合并 + 截断）可 node --test 断言（AC-R2-1/2/4）；typecheck 0 诊断（受限记录）；宿主可达时派工冒烟提示词含两段且顺序正确（AC-R2-5），不可达记录复现步骤 = 完成。
- **纪律**：不改角色 prompt 职责语义；规范文本只读拼接与声明式优先级（不做 K4-B 分节结构化覆盖）。

#### S6 R-2 前端 + 职责总纲【P0 · RESEARCH §12.1 R-2 UI + §16.1 矩阵】
- **目标**：指挥台新增「规范」面板（RulesPanel，接线 Sidebar/App）：全局层规范内容可读可编辑保存（POST /api/rules 走 hub 代理 by 自动注入），空间层规范文件族给出明确路径与「文件中心/仓库内编辑」跳转指引；保存后守护下一轮派工提示词反映新内容；README/LEGION 增职责总纲段（四类载体分工矩阵，§16.1）。
- **产出（文件域）**：workbench/src/components/RulesPanel.tsx（新增）、workbench/src/components/Sidebar.tsx、workbench/src/App.tsx、workbench/src/api.ts（rules 段）；文档联动 README.md/LEGION.md（不入文件域，见 §2.2）。
- **依赖**：S2（api.ts 同文件链）+ S4（rules API）+ S5（注入反映新内容需解析合入）。**工作量**：M。**完成 =（DoD）**：pnpm --dir workbench build 全绿；RulesPanel 可达且可编辑保存（宿主冒烟：保存 → /api/activity 可见 rules:update → 下一轮派工提示词含新内容，不可达记录复现步骤）；总纲段入 README/LEGION = 完成。
- **纪律**：保存写走既有 hub 代理与 author 注入纪律；渲染安全。

#### S7 R-3 后端：删除语义收口 + 预检【P1 · RESEARCH K6-A/K7-A 后端】
- **目标**：POST /api/spaces/delete（已存在 :1867-1896）事务级联由 7 表扩至 conversations/messages/calendar_events/members（D-10 随删，audit 保留）；新增只读 GET /api/spaces/impact?id=（任务/编队/成员/会话与消息/日程/技能计数 + 在办执行状态）供前端预检；新增 spaces.test.mjs 全套 HTTP 断言。
- **产出（文件域）**：team-hub/server.mjs（spaces 删除/impact 段）、team-hub/spaces.test.mjs（新增）。
- **依赖**：S4（同文件硬串行）。**工作量**：M。**完成 =（DoD）**：spaces.test.mjs 全绿（正常删除逐表 removed 计数与孤儿断言 / confirm 错 / 未知空间 / software-default / 非 general 各 4xx / /api/scopes 干净）；calendar/chat/skills 不回归 = 完成。
- **纪律**：不回收磁盘 worktree（D-11 默认，仅 DB 语义）；audit 保留不删。

#### S8 R-3 前端：删除空间危险区【P1 · RESEARCH K7-A】
- **目标**：SpaceSettingsModal 底部「危险区」：仅非 software/default 且 hub 模式显示；展开先调 impact 预检渲染影响清单 + 在办任务强提示；type-to-confirm 输入 delete-space:<id> 才可确认；api.ts 增 deleteSpace；删除当前激活空间成功后切回「全部空间」并重拉；受保护空间禁用入口。
- **产出（文件域）**：workbench/src/components/SpaceSettingsModal.tsx、workbench/src/App.tsx（切回/刷新模式 :288-302）、workbench/src/api.ts（deleteSpace 段）；README 空间管理节文档联动。
- **依赖**：S6（api.ts/壳同文件链）+ S7（预检/删除端点）。**工作量**：M。**完成 =（DoD）**：pnpm --dir workbench build 全绿；冒烟：删除非激活空间 → 列表移除；删除当前激活空间 → 自动切「全部空间」且列表不再含该 id；software/default 无入口；错误路径呈现后端文案（宿主可用时；不可达记录复现步骤）= 完成。
- **纪律**：confirm 字符串双保险（前端 type-to-confirm + 后端已有 :1873-1875 护栏）；不引入原生 confirm() 直删（K7-B 排除）。

#### S9 R-4 后端数据面：开关 + awaiting 状态机 + 队列【P0 · RESEARCH K9-A 数据面】
- **目标**：chat_reply_settings 表（scope PK、enabled 默认 1、model/identity/systemHint/updatedAt，IF NOT EXISTS 幂等）；postMessage 在开关开且 author ≠ 回复方身份时同事务写 messages.meta.aiStatus=awaiting（零迁移不加列）；GET /api/chat/replies?scope=&sinceMsgId= 返回 awaiting 消息 + 聚合上下文（limit 防爆）；awaiting 超龄（默认 120s）服务端标 failed + meta.error；回复方消息写入复用既有 DAO（audit chat:message + SSE + author=by 防冒名）；kind 限 text 且 ≤ MAX_CHAT_BODY=8000。
- **产出（文件域）**：team-hub/server.mjs（chat 表/DAO/路由段）、team-hub/chat.test.mjs（新增用例）、team-hub/chat-l1-smoke.mjs（扩展断言）。
- **依赖**：S7（同文件硬串行）。**工作量**：M-L。**完成 =（DoD）**：chat.test.mjs 全绿（新增：settings 读写 / awaiting 写入与可见 / 开关关无 awaiting / 身份字段 / 超龄标记 / 老库零迁移 TC-S1-16 不回归）+ 既有用例不回归；chat-l1-smoke 22+ 断言通过 = 完成。
- **纪律**：零新增列（meta 已有）；不内嵌模型调用（K8-A：team-hub 零出站纪律保持）。

#### S10 R-4 守护执行：chat-responder【P0 · RESEARCH K8-A/K10-A】
- **目标**：守护新增 responder（独立 interval 或并入 sweep，默认 10-30s）：拉 GET /api/chat/replies → 每条派生**无仓库工具**的轻量子代理（提示词 = 空间对话助手、基于会话历史、禁工具/文件访问；模型按 settings.model 或该空间默认）→ 生成文本经 POST /api/chat/messages 落第二条消息（by = 回复方身份 <scope>-assistant，≠ general/用户）→ 回写源消息 meta.aiStatus=replied；失败/超时 → failed + meta.error；状态机 CAS（仅 awaiting→replied）防重复、只处理非回复方消息防死循环、并发/超时护栏仿 worker config。
- **产出（文件域）**：plugins/src/index.ts（responder 段，与 S3/S5 不同行段）。
- **依赖**：S5（同 plugins 文件硬串行）+ S9（队列/状态机契约）。**工作量**：L。**完成 =（DoD）**：typecheck 0 诊断（受限记录）；状态机/护栏逻辑评审或单测锚定（CAS 幂等/防循环/超时回写）；宿主可用时冒烟（发送 → ≤120s 收到回复；关开关无回复；失败呈现），不可达如实记录 = 完成。
- **纪律**：零新凭据面（复用 DSH 既有模型通道，K10-A）；不引入任何协议代码/SDK。

#### S11 R-4 前端：ChatView 身份泛化 + AI 三态【P0 · RESEARCH K9-A UI】
- **目标**：author 判定由「general = 我」泛化为「general = 我，其余 author 一律对方」；回复方气泡带 🤖 + meta.aiModel 徽标；按 meta.aiStatus 呈现 awaiting（等待中 + 时间戳）/ failed（明确失败提示 + 重试动作重新置 awaiting）/ replied（正文）三态；纯文本渲染；既有会话守卫（R-A5：loadOlder/send 写回前会话身份比对）不回归。
- **产出（文件域）**：workbench/src/components/ChatView.tsx。
- **依赖**：S9（meta 数据契约）+ S10（实际回复执行供 E2E 冒烟）。**工作量**：M。**完成 =（DoD）**：pnpm --dir workbench build 全绿；宿主可用冒烟（发送 → 等待态 → 回复或失败呈现；author 泛化不破坏人-人收发；A/B 会话快速切换不串显），不可达记录复现步骤 = 完成。
- **纪律**：渲染安全红线（ChatView 既有文本节点纪律不破）；api.ts 无需改动（回复经既有 postChatMessage/SSE 到达）。

#### S12 四能力集成回归锚定【收口 · 仿 T-075 S8/T-091 惯例】
- **目标**：全部受影响的套件在合并 HEAD 上逐套真实重跑并记录；端到端主路径清单走通并写入 docs/TEST_REPORT.md；宿主不可达部分如实标注环境受限 + 复现步骤，不冒充通过。
- **产出（文件域）**：docs/TEST_REPORT.md。**依赖**：S1~S11 全部 done。**工作量**：M。**完成 =（DoD）**：§1 S12 行内清单逐项有真实输出要点 = 完成。**纪律**：只改 docs/TEST_REPORT.md；每套件给出命令与输出要点（用例数/失败数）。

## 4. 需求 / 方案 / 切片对照（无遗漏自检）

| 需求（T-095 REQUIREMENTS §5，AC 口径） | 覆盖切片 | 一等方案落点（T-096 RESEARCH） |
| --- | --- | --- |
| R-1（P0）跨空间共享技能：AC-R1-1..9 | S1（1/2/3/4/6/7/9）、S2（8）、S3（5） | K1-A 原地演进 grants + K2-A 指纹刷新 |
| R-2（P0）分层项目规范：AC-R2-1..7 | S4（6 后端）、S5（1/2/3/4/5/7 解析注入）、S6（6 UI/总纲） | K3-A rules 表 + K4-A 两层合并 + K5-A 预算截断 |
| R-3（P1）移除空间：AC-R3-1..6 | S8（1/2/3）、S7（4/5/6） | K6-A 级联收口 + K7-A type-to-confirm + impact 预检 |
| R-4（P0）对话 AI 回复：AC-R4-1..8 | S9（1/3/4/5/6/7/8 后端）、S10（1/2/4 执行）、S11（2/4/7 UI） | K8-A 守护 responder + K9-A meta 状态 + K10-A DSH 子代理通道 |
| 全部：AC-回归项 / 零新增依赖 / 渲染安全 | S12 锚定 + 各切片纪律 | RESEARCH §12.1 11 切片建议（本拆解按文件域链重排编号 S1~S12） |

**D 系列默认采纳**（T-095 §8，将军未否决即基线）：D-1 引用式共享｜D-2 review/grant/revoke general 门禁｜D-3 不做全局隐式共享｜D-4 B 只读含 prompt 全文草稿不泄｜D-5 轮询指纹刷新｜D-6 源空间删级联消失｜D-7 全局层=K3-A（闸门 G-R1 默认）｜D-8 两层空间层 > 全局层、未绑定只吃全局层｜D-9 并存 + 职责总纲｜D-10 级联随删 chat/calendar/members + audit 保留（G-R2 默认硬删无回收站）｜D-11 在办允许删但强提示、磁盘残留不回收｜D-12 LLM 直答无工具（G-R4-1 默认 K8-A）｜D-13 每消息自动回复 + 每空间开关默认开（G-R3）｜D-14 空间级模型默认｜D-15 异步落第二条消息｜D-16 维持空间粒度注入（按角色细粒度 = 可选后置，不在本批）｜D-17 不扩大 exec/托管消费面。
**闸门默认放行**：G-R1 = K3-A（rules DB）；G-R2 = K6-A 硬删；G-R3 = 默认开；G-R4-1 = K8-A 守护执行；G-R4-2 = 回复身份 <scope>-assistant。任一闸门将军翻转 → 对应切片（S4/S7/S9/S10）按备选路线修订，本拆解默认按上述推进。

## 5. 边界、风险与假设（breaker 视角）

- 🚫 本拆解不写实现、不改需求语义与方案结论；四能力范围以 T-095 REQUIREMENTS 为准，T-103 链「任务详情文档预览」目标不在本批。
- 🚫 不拆出无法验收的悬空任务：每片 DoD 与 §1 机器行逐条对应 AC；无回收站/跨空间文件预览/流式/语音等 T-095 scope-out 内容。
- ⚠️ 风险 R-7 文件域重叠已按 §1/§2 处理（三条同文件链 + 注册顺序派工）；R-1 草稿泄漏敞口由 S1 AC-R1-7 同批收口；R-6 提示词膨胀由 S5 预算 + S6 总纲缓解；R-4 回复依赖守护在线由 S9 超龄兜底（120s → failed）缓解；token 成本由每空间可关开关（S9）+ 轻量模型默认（S10）缓解。
- ℹ️ 环境与验证事实（本阶段实测）：代码基线 ba0372d 与方案基线 3c8f27d 逐字节一致（git diff 仅 docs 两文件）；node --test 在本会话沙箱因子进程 spawn EPERM（errno -4048）不可用，按各测试文件头注释「沙箱受限直跑等效」验证——skills 12/12、chat 13/13 全绿（直接运行 exit 0）；plugins/workbench 在本 worktree 无 node_modules，typecheck/build 需宿主或安装环境，下游如实记录受限即可（仓库 R-18 惯例）。