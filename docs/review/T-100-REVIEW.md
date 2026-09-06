# T-100 代码审查报告（review）——四能力批（R-1 跨空间技能共享 / R-2 分层规范 / R-3 移除空间 / R-4 对话 AI 回复）

> 审查对象（本任务 = T-099 编码 diff 的独立代码审查）：
> - coder 提交 **104f99a**（分支 w/T-099，23 文件 +2576/-344，基线 = promote T-105 fa9c568），经 promote **a018666**（mediator merge，另一父 e0e529f = promote T-106）合入当前 HEAD；
> - blob 级核对：本次审查工作树 w/T-100 @ **a018666**，被审代码与 104f99a 逐字节一致（merge 仅解决 docs 侧 TEST_CASES.md/T106-evidence 文档冲突，业务文件无二次改动）；
> - 审查基线 AC = 四能力批产物：scratch/baseline/REQUIREMENTS-T095.md（R-1..R-4 与 AC-Rx-y）、TASK_BREAKDOWN-T097.md（S1..S12 机器验收行）、TEST_CASES-T098.md（109 条用例 TC-Sx-yy / I-1..12 / D 系列默认值）。当前 main 的 docs/REQUIREMENTS.md 等已被 T-103/T-105/T-106（「环节产出文档预览」新特性）取代，故以 scratch/baseline 三文档为唯一 AC 基线。
> 审查方式：23 个改动文件逐一正读（server.mjs 相关段 + 路由/DAO 上下文、plugins 新纯函数模块全文 + index.ts 接线、workbench 组件全文 + api/App/Sidebar）+ 独立复跑（team-hub 5 套件 + L1 冒烟 + plugins 3 套件 + tsc x2）+ 静态检查（XSS 面 / 级联一致性 / CSS 覆盖 / 残留引用）。只给反馈，未改任何实现代码。
> 结论分级：**必须修改**（AC 未达成 / 实测行为缺陷 / 安全承诺失实）与**建议优化**（可排期）。严重度 高=红 / 中=橙 / 低=黄。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 环境 | node v24.19.0；沙箱 workspace-write；worktree w/T-100 @ HEAD a018666 | 与 coder 自述环境一致（plugins/workbench node_modules 在 worktree 内；team-hub 仅用 node: 内置模块） |
| S1 skills 套件 | node team-hub/skills.test.mjs | **20/20 fail 0，exit 0**（既有 12 + S1 新增 8：跨空间可见/撤销幂等/草稿收口/门禁矩阵/审计形状/非法入参/级联） |
| S4 rules 套件 | node team-hub/rules.test.mjs | **7/7 fail 0，exit 0**（建表幂等/旧库迁移/GET 默认/POST 回读+audit+SSE<=5s/非法 400 零落库/3000 边界/清空 upsert/GET 无副作用） |
| S7 spaces 套件 | node team-hub/spaces.test.mjs | **5/5 fail 0，exit 0**（造数 Z 删除 11 表 removed 计数 + 零残留 + 无幽灵 + audit 保留 / 保护与 confirm/门禁矩阵 / 在办允许删 / 他空间不误删） |
| S9 chat 套件 | node team-hub/chat.test.mjs | **23/23 fail 0，exit 0**（既有 13 + S9 新增 10：settings 默认/持久化/per-scope、awaiting 标记、身份防自触发、队列+上下文+limit+隔离、CAS 回写幂等、超龄 failed、retry、8000 边界、HTTP 路由与非法入参 400） |
| calendar 回归 | node team-hub/calendar.test.mjs | 13/13 fail 0，exit 0（不回归） |
| L1 冒烟 | node team-hub/chat-l1-smoke.mjs | **35/35 断言通过，进程级异常 0，exit 0**（A 无 token 8 项 + B token 鉴权 4 项 + S9 新增 13 项 settings/awaiting/SSE<=5s/replied/超龄 + S9T 超龄 3 项） |
| plugins 纯函数套件 | node plugins/tests/skills-fingerprint.test.mjs / norms.test.mjs / chat-responder.test.mjs | **6/6 + 7/7 + 4/4 = 17/17 fail 0，均 exit 0**（TC-S3/S5/S10 纯函数契约，依赖 plugins/lib 即 coder 构建产物，含新模块） |
| plugins typecheck | node workbench/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit | **exit 0，0 诊断**（worktree 内 plugins/node_modules 缺 typescript 二进制 → 借 workbench 内同版本 tsc 复跑；coder 自述宿主 pnpm build 亦 0 诊断） |
| workbench typecheck | node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit | **exit 0，0 诊断**（strict + noUnusedLocals/noUnusedParameters） |
| vite build | 未复跑（沙箱既有边界：esbuild 子进程 spawn 被拦截，T-047/T-060 同因先例） | 登记 3.待宿主；tsc 环节已 0 错误 |
| XSS 面静态核对 | grep RulesPanel/SkillsPanel/SpaceSettingsModal/ChatView/App + plugins index/norms/chatResponder | 零 dangerouslySetInnerHTML/innerHTML/insertAdjacentHTML 使用（ChatView 唯一命中为第 69 行既有注释声明）；服务端规范/技能/影响清单/消息正文均走 React 文本节点 |
| 改动范围 | git diff fa9c568 104f99a --stat；git status | 23 文件全落在四能力文件域（server.mjs + 4 前端组件/壳 + plugins 4 文件 + 6 测试/冒烟 + 2 文档）；零新增运行时依赖（无 package.json 变更）；本审查仅新增 docs/review/T-100-REVIEW.md（+ scratch 临时目录未跟踪） |
| 级联一致性静态核对 | impact 11 类计数 vs delete 11 表 vs spaces.test 造数断言 vs README 3.1 | 三处表集合逐字一致（tasks/roster/agent_models/exec_requests/skills/goal/exec_state/conversations/messages/calendar_events/members） |
| CSS 覆盖核对 | 精确比对 index.css 是否含新增 className（.danger-zone*/.rules-*/.chip-x/.chat-ai-state/.me-row/.bot-row） | **全部不存在**（index.css 最近改动为 T-087 5c402f8，T-099 未改 CSS）→ 见 O1 |
| 残留引用 | git grep 旧函数/旧形态（readRepoRules / 长度比较 / member 单形态授权等） | 无实质残留；README/LEGION 均同步（3.1/3.8/3.8.1 + 分层总纲段） |

### 0.1 审查口径注记
- 本任务 = T-095（需求）-> T-097（拆解 12 片）-> T-098（用例 109 条）-> T-099（编码 S1-S11 一次性交付 + S12 收口 TEST_REPORT）-> T-100（本审查）。审查按 **S1..S12 机器验收行 + AC-Rx-y + TC-Sx-yy** 逐条核对（下表 1），不重复评审更早批次已合入的等价面（chat/calendar/skills 基础契约由回归锚定）。
- 沙箱环境限制如实登记：vite build（esbuild EPERM）无法复跑，宿主需补跑（与 T-047/T-060 同因）；plugins tsc 借 workbench tsc 完成，0 诊断。
- 浏览器级（L2）UI 形态（三态气泡视觉、危险区交互、规范面板布局）本次以代码/静态核对 + 数据面冒烟为准，GUI 勾选登记 3.L2 清单——其中 M1 属可静态定性的行为缺陷（非仅观感），不依赖 L2 即成立。

---

## 1. 验收口径逐条核对

| # | 口径（T-095 §5 / TASK_BREAKDOWN S1..S12 / TEST_CASES） | 结论 | 依据 |
| --- | --- | --- | --- |
| S1 / AC-R1-1..4,6,7（后端共享语义） | ✅ 通过（1 项语义注记 → M2） | 代码 + skills.test 20/20：grant scope:B 后 scope=B（member 省略/单值两形态）含 S 且 prompt 全、C 不含（TC-S1-01/02/10）；revoke 即不可见 + 幂等（TC-S1-03/04）；非 general 调 review/grant/revoke → 400 文案含 general、register 不门禁（TC-S1-05）；审计 detail 含 skillScope + 目标、audit.scope=归属空间（TC-S1-06）；include=pending 仅 member=general（TC-S1-07/08）；删除源空间级联无悬空（TC-S1-09）；非法入参矩阵（TC-S1-11）。**注记**：改版（register 内容变化→pending）时 grants 保留，scope=B&member=general&include=pending 视图会带出 A 的待审草稿 → M2 |
| S2 / AC-R1-8（前端共享视图） | ✅ 通过（代码/静态；L2 待勾选） | SkillsPanel：共享条目「来自空间 X」来源标注 + 只读（isOwn/isShared 分支）+ prompt details 全文；授权目标空间复选框（grantableSpaces）+ 成员输入 + 行内撤销 ✕（chip-x）；全部空间视图不带 include=pending；纯文本渲染（I-5）；非 general 错误透传 toast 由既有模式覆盖。CSS 缺失见 O1（观感） |
| S3 / AC-R1-5（指纹刷新） | ✅ 通过 | skillsCache.ts 纯函数按 id 排序 (id:version:contentHash) 序列；fetchSkills 由长度比较改 skillsChanged；skills 列表 API 返回含 version/contentHash 全列 → 指纹真实有效；同量改版刷新/同指纹不刷/移除与新增刷（TC-S3-01..04）；拉取失败保留旧缓存（TC-S3-05）；顺序 shuffle 不刷（TC-S3-06）——6/6 单测绿 + 代码核对 |
| S4 / AC-R2-6 后端（rules 表/API） | ✅ 通过 | rules 表（key PK/scope/content/updatedAt）CREATE IF NOT EXISTS；GET 默认空串；POST 经 handleWrite（by 必填）+ DAO audit rules:update（detail 带 contentLength/preview）+ SSE（TC-S4-03 实测 <=5s）；MAX_RULES_LEN=3000 env 可配；非法输入 400 零落库零 audit；3000 恰过/清空/upsert 无重复行；GET 无副作用——rules.test 7/7 + smoke 覆盖 |
| S5 / AC-R2-1..5（分层解析注入） | ✅ 通过（1 项边界注记 → O8） | norms.ts 纯函数：两段 [全局]+[空间] 顺序稳定、空间层带「优先于全局层」声明与来源标注（TC-S5-01）；文件族按序读全部存在者、回退 scrumDir/LEGION.md（TC-S5-02）；仅 LEGION.md 无全局层 → REPO_RULES_HEADER 逐字兼容（TC-S5-03）；无内容 → [] 不报错（TC-S5-04）；段落边界截断 + 真实数字提示 + 围栏配对 + 合计预算（TC-S5-05）；预算 env 可配（TC-S5-06）；全局拉取失败降级只空间层（TC-S5-08）；buildWorkerPrompt 规则小节 = readNormsSync 输出（TC-S5-07 代码核对） |
| S6 / AC-R2-6,7（规范前端 + 总纲） | ✅ 通过（小瑕疵 O5） | RulesPanel 两分区（全局层编辑保存 POST /api/rules + 空间层文件族路径/跳转指引）；Sidebar「📜 规范」+ App 接线；职责总纲段入 README §3.8.1 与 LEGION.md（四类载体矩阵，TC-S6-07 grep 通过）；保存/失败 toast、前端 3000 字护栏；hub 不可达提示；纯文本渲染 |
| S7 / AC-R3-4,5（删除语义收口） | ✅ 通过 | POST /api/spaces/delete 事务级联扩至 11 表 + spaces 行，removed 计数与 impact 三处一致；confirm/未知/受保护/非 general 矩阵 4xx 零删除；GET /api/spaces/impact 只读预检（计数 + running 在办，两次调用零变化）；/api/scopes 无幽灵；audit space:delete 保留（含 detail.removed）——spaces.test 5/5 + TC-S1-09 级联 |
| S8 / AC-R3-1..3（前端删除危险区） | ✅ 通过（代码/静态；L2 待勾选） | SpaceSettingsModal 危险区仅非 software/default 显示；展开先 GET impact 渲染 11 类计数 + 在办强提示（黄色警示）；type-to-confirm 精确匹配门控确认按钮；成功回调 App handleSpaceDeleted 关弹窗/重拉列表/删当前空间切回 scope=null；失败透传 toast。CSS 缺失见 O1（观感） |
| S9 / AC-R4-1..7 数据面 | ✅ 通过（2 项注记 → M3/O7） | chat_reply_settings 表幂等建表/旧库迁移（TC-S9-01）；默认开/关持久化/per-scope 隔离/重启保持（TC-S9-02）；postMessage 开关开 + 发送者≠identity → meta.aiStatus=awaiting 同事务零迁移（TC-S9-03/04）；identity 默认 <scope>-assistant、identity 消息不自我触发（TC-S9-05）；GET replies 队列（scope 过滤 + 最近 12 条上下文 + limit 防爆 + sinceMsgId）（TC-S9-06）；超龄 120s（env 可配）兜底 failed+error（TC-S9-07 小值注入实测）；postAiReply CAS awaiting→replied 同事务落回复（author=by、audit chat:message、SSE<=5s 实测）且重复回写 skipped 不产生第二条（TC-S9-08/11）；retry/failAiReply 幂等（TC-S9-10 族）；8000/8001 边界；HTTP 路由 + 非法入参 400（TC-S9-09）——chat.test 23/23 + smoke S9-13 全 PASS。**注记**：markStaleAwaiting/队列扫描窗口受限 → M3；fail/retry 无 SSE 即时刷 → 并入 M1 |
| S10 / AC-R4-1..4（守护执行） | ✅ 通过（静态+纯函数；宿主 E2E 受限如实登记） | plugins/src/index.ts sweepChatReplies：30s 节拍并入 sweep、拉本 scope awaiting 队列 → chatBusy 去重 + CHAT_REPLY_PER_SWEEP=3 防爆发 → settings.model ?? 空间 agent_models ?? 默认模型（TC-S10-06）→ ensureForeman + 无仓库工具轻量子代理（buildChatAnswerPrompt 含禁工具声明）→ 服务器 CAS answer 回写；子代理失败/超时/空回复 → failAiReply CAS 回写 failed（TC-S10-02）；author=identity 消息双保险跳过（TC-S10-04）；开关关 settings.enabled=false 空转零出站（TC-S10-05）；team-hub 零出站模型调用（K8-A 纪律，I-7）；TS 经 tsc 0 诊断。宿主端到端（发送→<=120s 收回复）因沙箱无守护/LLM 通道不可达，如实登记 §3（与 coder 自述一致） |
| S11 / AC-R4-2,4,7 UI | ⚠️ **M1（必须修改）** | ChatView author 泛化 isMe(general=我)/其余对方 + isBot(🤖 + aiModel 徽标)（TC-S11-01）；三态渲染骨架齐备（awaiting 等待提示/failed 附 aiError + 重试按钮/replied 正文）（TC-S11-02/03）；旧消息无 meta 兼容（TC-S11-07）；纯文本渲染（TC-S11-04）。**缺陷**：mergeNewest 只增不覆盖 → 源消息 awaiting→replied/failed 的 meta 流转本地不刷新，⏳ 常驻/❌ 与重试不出现，需重开会话才正确（详见 M1） |
| S12 / 集成回归锚定 | ✅ 通过（本审查独立复跑） | 5 套件 68 用例 0 失败 + smoke 35/35 + plugins 17/17 + tsc x2 0 诊断；TEST_REPORT.md 已由 coder 收口（328 行精简）；端到端清单 R-1..R-4 的宿主部分（守护注入/浏览器）登记 §3 受限项 |
| 波次验收 1 | 对照验收标准与编码规范逐条审查，每条结论有依据 | ✅ 本报告 §1/§2 |
| 波次验收 2 | 问题清单含严重度 + 位置 + 修改建议 | ✅ §2 |
| 波次验收 3 | 明确区分「必须修改」与「建议优化」 | ✅ §2.1 / §2.2 |

**总体结论：四能力后端语义与数据面（S1/S3/S4/S5/S7/S9/S10 纯函数部分）实现正确、测试扎实（独立复跑 68+17+35 全绿），前端接线完整；无 P0 级正确性/安全问题。存在 3 项必须修改（M1 对话三态实时刷新缺陷——S11 核心 UI 行为；M2 共享技能改版 pending 期草稿跨空间带出——R-1「published only」语义违例；M3 awaiting 兜底扫描窗口受限的队列可靠性）与 8 项建议优化。build 最终绿证与宿主 E2E / 浏览器 L2 需宿主/将军环境完成（已登记）。**
---

## 2. 问题清单

### 2.1 必须修改（promote 前建议处理；M1 阻塞 S11 验收，M2/M3 为语义/可靠性修正）

#### M1 🟠 ChatView mergeNewest 只增不覆盖 → AI 回复三态不实时流转（S11 核心 AC-R4-4 UI 行为缺陷）
- **位置**：workbench/src/components/ChatView.tsx mergeNewest（159-172 行）与 SSE/15s 轮询刷新路径（181-198 行）。
- **问题**：mergeNewest 拉回最新一页后按 prev 末条 id 取 maxId，只把更新的消息追加进列表，同 id 的既有消息（源消息）即使服务端 meta 已变（awaiting→replied / awaiting→failed）也不覆盖。时序推演：用户在会话发消息 → 本地落 awaiting 态（⏳ 提示）→ 回复方 CAS 回写成功（源消息 meta=replied）并落第二条消息 → SSE chat:message 触发 mergeNewest → **回复气泡被追加显示，但源消息气泡仍停留在「⏳ 等待回复…」**；失败路径同理——chat:fail/chat:retry 事件不触发 mergeNewest（181-187 行只处理 chat:message/chat:create），即便 15s 轮询 mergeNewest 也只追加不覆盖 → **失败消息永远不呈现 ❌ + 重试按钮**，用户无法在实时会话里点重试（重试入口只在 failed 态气泡上，而 failed 态需切换会话/刷新页面才出现）。TC-S11-02/03「awaiting → replied / failed → 重试」的 UI 状态机实时流转未达成（数据面正确，视图状态滞后或永远不更新）。
- **修改建议**（约 5-8 行）：mergeNewest 去掉 append-only 过滤，改为整页 mergeById(prev, list)（list 是最近 PAGE 条，重叠 id 被服务端行覆盖 → meta 更新；更早历史不在 list 中、原样保留——mergeById 本身即按 id 去重置换，语义安全）；并在 SSE 分支补 chat:fail / chat:retry 时对同会话触发一次 mergeNewest（身份守卫已覆盖切会话竞态）。改动后回归：同会话轮询刷新不再丢失更早分页（由 mergeById 保证）。

#### M2 🟠 共享技能改版回 pending 期间 grants 保留 → include=pending 复审视图跨空间带出草稿（R-1「published only 才跨空间可见」语义违例）
- **位置**：team-hub/server.mjs registerSkill（内容变化分支：只改 status/version/contentHash，**grants 未清**）+ listSkills 过滤 + workbench SkillsPanel load（scope 视图固定带 member=general&include=pending）。
- **问题**：技能 S（scope=A）已发布并 grant 给 scope:B。A 随后用新内容重交 registerSkill → S 变 pending（v+1），**grants 数组原样保留**。此时：① B 的普通列表（published only）不再含 S——正确（B 消费方看不到未发布内容）；② 但将军在 B 空间打开技能中心（SkillsPanel 固定请求 include=pending&member=general）→ listSkills 过滤链：includePending=true 使 status 过滤失效 → grantedByScope（grants 含 scope:B）成立 → **A 的 pending 草稿（含新 prompt 全文）以「共享技能」条目出现在 B 视角**。这违反 AC-R1-7「只 published 才可被跨空间共享消费」的收口精神与「草稿不外泄」承诺——草稿经保留的 grants 借道复审视图流入了曾授权空间。
- **修改建议**：registerSkill 内容变化分支把 grants 清为 []（发布后才重新授权，语义 = 每次发布版本重新确认共享面）；或在 listSkills 过滤加一条「非 published 的技能即使 includePending 也只对其归属 scope 可见（跨 scope 不显示 pending/rejected）」——推荐前者（状态更干净，撤销列表同时驱动 S2 UI）。补一条 TC-S1-07 变体断言：A 改版后 scope=B&include=pending&member=general 不得含 S。

#### M3 🟠 awaiting 超龄兜底与队列扫描仅限「最新 500/N*4 条」窗口 → 高活跃空间里队列可靠性缺口（AC-R4-4 兜底语义）
- **位置**：team-hub/server.mjs markStaleAwaiting（ORDER BY id DESC LIMIT 500 全 scope 扫描）与 listAwaitingReplies（WHERE id > ? ORDER BY id ASC LIMIT min(n*4,800) 后再 JS 过滤 aiStatus）。
- **问题**：两处都只覆盖消息窗口内的 awaiting：
  1. **超龄兜底漏网**：markStaleAwaiting 只扫描该 scope 最新 500 条消息；若消息总量 >500，窗口外的老 awaiting（如回复方宕机 10 分钟后才重启、期间聊天继续灌入）永不被标 failed，卡在 awaiting 幽灵态（不进队列、UI 永远 ⏳）。
  2. **队列饥饿**：listAwaitingReplies 先按 id 取 LIMIT n*4（≤800）条再 JS 过滤 awaiting——高活跃空间若最近 800 条里 awaiting 占比低，即使前面有更老的 awaiting（id 更小但尚未被取走）也会被窗口截掉，守护反复空转；且每次守护拉取都全量触发一次 markStale 的 500 行扫描，队列 GET 频率高时有冗余 IO。
- **修改建议**：给 awaiting 状态加专用游标而不是靠消息表窗口——① markStaleAwaiting 改按专门索引/游标分批确保不漏（或维护轻量 awaiting 游标表）；② listAwaitingReplies 改为「awaiting 专用查询先取足 n 条」而非「先 LIMIT 再过滤」。若按「低活跃本地工具」接受窗口限制，请在头注释与 TEST_CASES 记录边界（现 §3 量化判据未注明窗口），并补一条「>500 消息后的老 awaiting 被兜底」的说明性用例。

### 2.2 建议优化（可排期；按影响降序）

#### O1 🟡 四个前端组件的新增 className 全部无对应 CSS（新 UI 裸奔；观感与交互反馈缺失）
- **位置**：workbench/src/index.css 未随 T-099 更新；受影响：SpaceSettingsModal（.danger-zone/.danger-zone-head/.danger-zone-body——展开区无边框/间距，头部无 hover 光标反馈）、RulesPanel（.rules-section-head/.rules-global-input/.rules-input-bar/.rules-file-row 等——textarea 无高度/字体样式、文件族行无布局）、SkillsPanel（.chip-x——chip 内嵌默认浏览器按钮样式突兀）、ChatView（.chat-ai-state/.me-row/.bot-row——bot/me 行无差异化布局，状态行主要靠内联样式）。
- **问题**：相比既有面板（chat-bubble/calendar/skill 均有完整样式），这批新 UI 只有内联样式兜底。功能可用但视觉/交互不达标，浏览器 L2 走查大概率被标记观感问题（危险区可点击头无任何 affordance）。
- **建议**：为上述 className 补一组样式（对齐既有 .panel/.chip/.btn 变量与配色），预计 60-100 行 CSS。

#### O2 🟡 workbench api.ts 各写接口双解包返回 undefined 的契约不一致（首个消费返回值的调用方是 retryChatReply）
- **位置**：workbench/src/api.ts hubPost（返回完整响应体 {ok:true, task}）vs postChatMessage/createConversation/retryChatReply 等调用方取 .task。
- **问题**：workbench 版 hubPost **不解包** .task，调用方再取一次 .task → undefined（服务端语义经 handleWrite 固定包 {ok, task}）。既有面板（chat/skills/rules/space 保存等）从不消费返回值所以从未暴露；retryChatReply 是首个消费方——ChatView.doRetry 拿到 undefined 后访问 updated.id 抛错进 catch → toast「重试失败」：**每次重试都报错且气泡不变**（服务端其实已成功重置 awaiting）。与 M1 修复配套必查。
- **建议**：统一解包约定——建议 hubPost 内做 data.task ?? data 解包（与 plugins 版一致），调用方直接用返回值；或全部调用方删除 .task 链。改动后 postChatMessage 等同步回归（用不用返回值均可）。同时补一条前端评审断言防回归。

#### O3 🟡 retryAiReply 允许对「从未 awaiting 的普通消息」置 awaiting（服务端缺少 failed-only 前置）
- **位置**：team-hub/server.mjs retryAiReply：仅拒绝 replied 与开关关，无 aiStatus/非 failed 的消息也会被置 awaiting 入队。
- **问题**：若任一调用方对普通历史消息误调 retry（或 UI 误接），会把任意旧消息送进 AI 队列；当前 UI 只在 failed 态暴露按钮所以不致触发，属纵深防御缺口；awaiting 中连点重试还会刷新 aiStatusAt 延长超时窗口。
- **建议**：加前置「仅 aiStatus=failed 的消息可重试；awaiting 中重试返回幂等跳过或 4xx」。

#### O4 🟡 chat:fail / chat:retry / 超龄标 failed 均无事件驱动即时 UI（可并入 M1 一并修）
- **位置**：ChatView SSE 分支只处理 chat:message/chat:create；服务端 audit 有 chat:fail/chat:retry 帧但无人消费。
- **问题**：失败/重试结果要等轮询或重开会话才可见——M1 修复后建议在 SSE 分支对 chat:fail（同 conv）与 chat:retry 事件同样触发 mergeNewest，把端到端延迟从「页面重载」降到「事件到达即刷新」。

#### O5 🟡 RulesPanel「还原」不清 dirty / load() 不重置编辑态（保存按钮状态错乱）
- **位置**：workbench/src/components/RulesPanel.tsx load 回调不 setDirty(false)；save 成功后 setDirty(false)。
- **问题**：点「还原」拉回服务端内容后 dirty 仍为 true → 「保存」仍可点、会重复提交内容一致的规范；还原后「还原」按钮因 !dirty 为假仍可点（语义：还原后应禁用直至再次编辑）。
- **建议**：load() 成功路径加 setDirty(false)；同步让 dirty 纳入 effect 依赖（可选）。

#### O6 🟡 前端 MAX_RULES_LEN=3000 硬编码与服务端 env 可配上限脱钩
- **位置**：workbench/src/components/RulesPanel.tsx MAX_RULES_LEN=3000 常量；服务端 server.mjs MAX_RULES_LEN 可被 env 覆盖。
- **问题**：宿主调大（如 5000）时面板仍拦 3000；调小（如 2000）时面板允许 2500 而后端拒绝——两向不一致，可能造成「面板提示可保存但后端 400」。
- **建议**：从 GET /api/rules（或 /api/config）下发上限并缓存；或至少注释声明「与 server.mjs 默认一致，env 调整需同步」。

#### O7 🟡 /api/chat/replies 上下文聚合为无鉴权读（继承性观察：本地信任模型可接受，鉴权打开场景需复核）
- **位置**：team-hub/server.mjs GET /api/chat/replies 与 listAwaitingReplies 上下文聚合（每条 awaiting 附最近 12 条同会话全文）。
- **问题**：GET 端点不校验身份（与既有 GET /api/chat/messages 一致，T-060 O7 同类继承项）；本端点额外把整段会话上下文聚合给「任何能访问 hub 的进程」。TEAM_HUB_TOKEN 只拦写不拦读；默认本地回环部署风险低，但一旦暴露端口即泄漏对话全文。
- **建议**：登记服务端鉴权后续项（读接口按 token/member 过滤，与 T-060 O7 合并）；本批无需改动。

#### O8 🟡 norms.ts legacy 单段分支（仅 LEGION.md 且无全局层）绕过全部预算（截断/合计均不生效）
- **位置**：plugins/src/norms.ts buildNormSections 兼容回归分支（仅 LEGION.md + 无全局层 → 直接返回逐字全文，truncated:false）。
- **问题**：兼容回归优先于预算——若某空间仓库 LEGION.md 超 4000 字，legacy 形态下整份注入不截断（旧 readRepoRules 有 slice(0,4000) 行为），与「现状逐字一致」仅在 ≤4000 时成立；TC-S5-03 夹具短文本未覆盖长文件差异。当前仓库 LEGION.md 体量小，实际无碍，但作为纯函数契约建议补边界说明。
- **建议**：legacy 分支在 content ≤ spaceMax 时返回逐字兼容；>spaceMax 时走截断路径（仍以 REPO_RULES_HEADER 起头，最大程度兼容）。补一条长文件单测（>4000 的 LEGION.md：输出被截断且围栏不半截）。

---

## 3. 结论与放行建议
- **功能判定**：四能力实现正确性总体达标——R-1/R-2/R-3/R-4 后端语义与数据面逐条成立（AC-R1-1..9 / R2-1..7 / R3-1..6 / R4-1..8 除 M1 外均达成），独立复跑：team-hub 5 套件 68/68、L1 冒烟 35/35、plugins 纯函数 17/17、workbench+plugins tsc 0 诊断。渲染安全红线（I-5）、写纪律（I-2/by 必填/audit/SSE）、老库零迁移（I-4）、零新增依赖（I-1）均有代码 + 测试双重证据。
- **必须修改（3 项，均改动量小）**：M1（ChatView 合并策略 + SSE 分支，约 8 行）阻塞 S11「三态实时流转/失败重试」验收；M2（registerSkill 清 grants 或 listSkills 跨 scope 过滤 pending，2-3 行 + 1 条断言）恢复 R-1「published only」跨空间语义；M3（awaiting 专用游标/查询或显式记录窗口边界）保证 AC-R4-4 兜底完整。建议 promote 前落地 M1+M2（改动集中、风险低），M3 可紧随小修。
- **建议优化（8 项）**：O1（CSS 补齐，建议与 M 批同轮做，L2 观感依赖）> O2（retry 解包——与 M1 同路径的连带缺陷，建议并入 M1 修复验证）> O3/O4/O5/O6/O7/O8 可排期。
- **待宿主/将军确认项（不阻塞本 review 结论，阻塞 promote 前放行）**：
  1. 宿主补跑 cd workbench && pnpm build（vite/esbuild 沙箱 EPERM，T-047/T-060 同因复现，非代码问题）；
  2. 宿主 E2E：S10 守护 chat-responder 真实一轮（发送 → ≤120s 收到 author=<scope>-assistant 回复 / 失败呈现 / 关开关零出站）——沙箱无守护与 LLM 通道不可达，已如实登记；
  3. 浏览器 L2 清单：TC-S2-01/03/04、TC-S6-01..04、TC-S8-01..07、TC-S11-01..07 逐条勾选（M1 修复后重点验证三态实时流转与重试路径）。
- **promote 建议**：M1+M2 修复后可 promote；M3 建议紧随；O1 建议同批补 CSS 避免 L2 观感返工。

