# T-095 需求说明：平台四项能力补全（跨空间共享技能 · 分层项目规范 · 移除空间 · 对话接入 AI/Agent 回复）

> 阶段：需求澄清（requirement）｜任务：继续完善 ① 跨空间共享技能建设 ② 项目规范建设（类似全局 agent.md + 项目/空间层面 agent.md）③ 移除空间功能 ④ 对话功能（发送后没有 LLM/Agent 与之对话）
> 上游 goal 原句（将军）：[auto-goal] 继续完善：1.跨空间共享技能建设；2.项目规范建设（类似全局的agent.md+项目/空间层面的agent.md）；3.没有移除空间的功能；4.对话功能不可用，发送后，并没有LLM大模型或者Agent与之对话
> 标记：[auto-goal]；下游：researcher（docs/RESEARCH.md）→ breaker（docs/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
> 评估基准：w/T-095 HEAD == main == `41fd406`（本文件所有 file:line 均指向该提交的仓库内容）

## 0. 文档状态与阅读说明

- 本文件是 T-095「需求澄清」阶段产出，**取代**同目录旧产物 docs/REQUIREMENTS.md（T-073 三中心收尾需求说明；旧版经 git 历史可回溯——先例：T-073 文档亦取代 T-014 版本）。
- 本文沿用仓库既定标注惯例区分三类内容：
  - ✅ **已确认口径**：由代码/历史证据钉死、下游可直接依据的现状与边界；
  - ⚖️ **待将军裁决**：影响范围/优先级/产品语义的关键分歧，裁决前**默认按「倾向 + 默认值」推进**，但该默认值是「假设」不是「结论」——将军可在本任务验收评论逐条答复或修正；
  - ❓ **遗留/开放问题**：默认取值见各条，明示假设，供将军补充输入。
- **本阶段只产出本文档**：不写实现、不做技术选型（存放位置/回复链路机制/推送方式等留给 researcher）、不改仓库实现、不调 taskctl、不 push。所有「验收口径」写成**可测语句**（行为断言/命令/判据），供 breaker 切分与 test-designer 直转用例。
- **本阶段完成 ≠ 目标全部完成**：本文交付「明确、可验收的需求说明 + 范围边界 + 需求清单 + 风险依赖」；实现由后续阶段按流水线推进。

---

## 1. 目标解读：将军四条诉求 → 可验收语义

| 原句 | 澄清后语义 | 现状定性（证据见 §2） | 对应需求 |
| --- | --- | --- | --- |
| ① 跨空间共享技能建设 | 让「空间 A 已发布技能」能被授权共享到空间 B，并被 B 空间的智能体/将军消费、管理、审计——**建设** = 补齐共享全链路（可见性/授权/撤销/注入/联动/测试），不是从零造技能体系 | 已有 scope-owned + grants(`member`/`scope:xxx`) 雏形，但**无跨空间消费用例、无撤销、无管理 UX、守护注入缓存陈旧、审计归属错位** | R-1 |
| ② 项目规范建设（类似全局 agent.md + 项目/空间层 agent.md） | 建立「**全局规范层 + 项目/空间规范层**」的规范文件族，派工/执行时按明确优先级合并注入 agent；缺全局层、缺分层合并、缺维护入口 | 现状只有 readRepoRules 读**绑定仓库根单文件**（LEGION.md→AGENTS.md→scrumDir，单层、单文件、4000 字截断），无任何全局/空间分层 | R-2 |
| ③ 没有移除空间的功能 | 用户侧（指挥台）**没有移除空间的入口与闭环**；后端已有删除端点但前端零接入、零测试、级联语义存在未决边界 | `POST /api/spaces/delete` 已存在且已合入 main（6e01ef1），workbench 无任何调用 | R-3 |
| ④ 对话功能不可用，发送后没有 LLM 大模型或 Agent 与之对话 | 对话中心缺「**回复方**」：消息发送即终态，无人接话。目标 = 发送后由 LLM 直答或空间内 Agent 在会话中回复 | 全仓 chat 为纯人-人消息存储：无回复触发、无回复方、无 reply/role/status 数据面、UI 无 AI 侧渲染 | R-4 |

> ⚠️ **关于 ④「对话功能不可用」的边界澄清（重要）**：经证据核实，人→人收发链路本身是可用且被测试锚定的（team-hub/chat.test.mjs 18 例 + chat-l1-smoke.mjs 22 断言全绿，含 SSE ≤5s 送达；README §3.8）。「不可用」的准确含义 = **没有 AI/Agent 回复方**（见 §2.4）。若将军实际还遇到「人-人收发也不通」（如端口/令牌/代理问题），属环境排障而非本需求范围，需另行带复现步骤报障——本需求默认按「补 AI/Agent 回复方」推进（假设 A-4）。

---

## 2. 现状盘点与缺口判定（✅ 证据锚定）

> 全部 file:line 相对仓库根。核心证据链：team-hub/server.mjs（后端）、workbench/src（前端）、plugins/src/index.ts（守护派工注入）、team-hub/*.test.mjs（测试锚定）。

### 2.1 技能体系现状（R-1 输入）

**数据与接口（team-hub/server.mjs）**
- skills 表：`id/name/description/prompt/scope(默认 'default')/owner/grants(JSON)/version/status(pending)/contentHash/reviewedAt`（:201-215，老库缺列幂等补 :264-271）。单 scope 列，无 tags、无 published 快照。
- `registerSkill`（:469-491）：新技能一律 pending；同 (id,内容) 幂等不 bump；内容变化 version+1 并回 pending 待复审。`reviewSkill`（:493-502）：仅 pending 可 publish/reject。`grantSkill`（:520-527）：**只做并集追加，无撤销 API**。
- `listSkills`（:504-518）过滤语义：默认只露 published；scope 过滤 = **精确相等**（:514）；授权分支要求调用方**带 member 参数**才生效（:515 `grants.includes(member) || grants.includes('scope:'+scope)`）。
- 路由：POST register/review/grant（:1748-1786）**无 by=general/归属门禁**（对照删空间 :1875 有 general 检查）；GET /api/skills（:1960-1982）列表支持 scope/member/include=pending；?id= 单查未发布且无 include=pending → 404 防泄漏（:1966-1969）。
- 空间删除级联 `DELETE FROM skills WHERE scope=?`（:1885）。

**消费侧（plugins/src/index.ts，dsh-scrum-worker 守护）**
- `fetchSkills`（:436-447）：每轮扫单拉 `/api/skills?scope=<守护scope>&member=<config.role>`；**内存缓存只在数组长度变化时刷新**（:442-445）→ 同数量技能改版守护不重载；mediator 模式不拉技能。
- 注入点 `buildWorkerPrompt`（:1090-1092）：拼「团队共享技能（必须遵守，来自 team-hub）：【name】prompt」，位于仓库规则段（:1087-1089）之后。流水线单守护处理 8 角色（:1923-1926），member 过滤用**守护级单值 config.role**，即技能注入粒度 = 守护实例/空间，非 worker 角色。

**前端（workbench）**
- SkillsPanel.tsx：注册（表单 scope 可编辑 :268-271）、发布/驳回（:167-176）、授权（自由文本输入成员或 scope:xxx，placeholder「scope:software」:198-199）；**无空间选择器、无「共享到其他空间」入口、无被共享视图**；scope=null=「全部空间」聚合（:123-126）；15s 轮询（:47）。
- api.ts `fetchSkills` 只传 scope/include、**从不传 member**（:393-398）→ UI 侧授权分支永不触发，将军在 B 空间看不到 A 授权来的技能。

**测试（skills.test.mjs 5 组 12 例）**：register 幂等/版本/非法 id、list 默认只 published、review 门禁、grant 按 member/scope 过滤（:89-99，**无「B 空间消费 A 授权技能」跨空间用例**）、旧库迁移补列。仓库内无跨空间共享设计文档。

**结论**：跨空间共享 = **引用式共享的既定雏形（grants=`scope:xxx`）缺后半程**——目标空间不可见、不可撤销、无治理门禁、注入缓存陈旧、级联/草稿暴露面未定义（详见 §2.1 引用的 A 侧证据与 §7 风险 R-3）。

### 2.2 规范注入现状（R-2 输入）

- `readRepoRules()`（plugins/src/index.ts:849-862）：候选 = [`repoRootFor()/LEGION.md` → `repoRootFor()/AGENTS.md` → `config.scrumDir/LEGION.md`]（:852-854），**取第一个存在文件**，内容 `slice(0, 4000)`（:858）。不合并、不叠加、无分层。
- `repoRootFor()`（:560）= 空间绑定仓库根优先（spaceBinding.repoRoot），否则注入配置 repoRoot。空间绑定由 `refreshSpaceBinding`（:530-557）每轮从 `GET /api/spaces` 刷新，localDir 上溯 git toplevel（:543-545）——**规范与「空间绑定的仓库」绑定，空间本身无规范字段**。
- 注入时机：**每次派工实时重读磁盘**（`buildWorkerPrompt` :1039-1040，worker subagent 启动 :1231）；worker 在隔离 worktree 中只收到注入文本、看不到规范文件本身（:1048 隔离声明）→ **提示词注入是唯一通道**。
- team-hub：spaces 表无 rules/规范列（:130-147）；skills 表是唯一「规范类内容」DB 载体（注册→pending→publish，带 version/contentHash/reviewedAt）。
- 仓库现状：根目录**只有 LEGION.md**（自述「由守护插件在每次派工前自动读入并注入」），全仓**无 AGENTS.md / agent.md**；roles.json（岗位流水线提示词基底，守护启动时读一次 :460-472）、stage-standards.mjs（建任务自动带验收/边界模板）与规范注入相互独立、无总纲。
- UI：无任何编辑 LEGION.md/AGENTS.md 的入口（文件中心只读预览+写文件接口；空间设置只管 localDir/remoteUrl）。

**结论**：现状 = **单仓库根单文件（单层）**。目标 = 增加「**全局层**（对所有空间/仓库生效）+ **空间/项目层**（随空间绑定生效、可覆盖全局）」并可测合并注入、可维护。层数与优先级默认值见 R-2 与 D-7/D-8。

### 2.3 空间管理现状（R-3 输入）

- spaces 表（team-hub/server.mjs:130-147）：id/name/private/local_dir/remote_url/createdAt/updatedAt。GET /api/spaces（:1570-1588）= 注册行 ∪ roster ∪ tasks 的 distinct scope 合并，返回 agentCount（仅计 roster）。
- **POST /api/spaces/delete 已存在且完整**（:1867-1896，由 commit 6e01ef1 引入、已合入 main；git log -L 仅此一条 diff）：护栏 = 拒绝 software/default（:1873）+ confirm 须为 `delete-space:<id>`（:1874）+ by 须 general 或 forceGeneral（:1875）+ 未知空间拒绝（:1876-1877）；事务内级联删 **7 张表** tasks/roster/agent_models/exec_requests/skills/goal/exec_state（:1880-1888）+ spaces 行（:1889）；audit 记 `space:delete` 但**历史保留**（:1892）。原用途 = 运维清理沙箱空间（docs/P0-CONFIRMATION.md 记录删 slice-verify 空间）。
- **前端零接入**：api.ts 无 deleteSpace 客户端（仅有 fetchSpaces/createSpace/updateSpaceConfig/addSpaceAgents）；Sidebar 空间行只有切换+⚙设置；SpaceSettingsModal 只有编辑保存；App 无删除后刷新/切走逻辑。**测试零覆盖**（team-hub 三个 test.mjs 均无 spaces/delete 用例）。
- 删除影响面未闭合（数据依赖判定）：
  - scope 字段存在于 12 张表（tasks/roster/goal/exec_state/exec_requests/agent_models/skills/conversations/messages/calendar_events/audit/members）。
  - **只删 7 张**；conversations/messages/calendar_events 残留为孤儿（calendar 列表无未知 scope 守卫，:730-746 仍可查）；**members 全文件无 DELETE**，而 /api/scopes 由 tasks+members 推导（:1564-1566）→ 删除后幽灵分区仍出现在 /api/scopes。
  - 磁盘零操作：不触碰 local_dir、不回收守护按任务建的 .legion-worktrees/w/*（plugins :766-801）与在办 worker。

**结论**：需求 = 「**用户面移除空间闭环 + 删除语义收口 + 测试锚定**」；后端能力已存在，**不是从零建删除能力**（本需求最关键的澄清结论之一）。

### 2.4 对话现状（R-4 输入）

- 数据面：conversations（:221-231）/messages（:233-244），**无 role/reply_to/assistant/状态字段**；author 恒等于 by（服务端防冒名，:618-619，TC-S1-07）；kind 白名单 text|markdown|system（:533-534）。
- 行为面：postMessage 落库+审计 chat:message+SSE 后返回 = **发送即终态**（:603-625）；SSE 是单一 /api/events 审计流（:1983-1994），无「待回复/回答完成/流片段」语义。
- 前端：ChatView 发送 = POST + 本地气泡合并（:267-297），无等待/typing/assistant 渲染；「自己」判定唯一条件是 author==='general'（:24-26/:358-359）；Composer 无回复对象/模型选择；hubPost 恒注入 by='general'（api.ts:379-390）。
- 全仓检索结论：**无任何回复链路**——team-hub server 零出站模型调用；agent_models 表（:174-183）只是「每空间每角色→任务执行模型」配置，无 chat 引用；exec_state/exec_requests（:158-172）是将军 agent 侧的派活通道（仓库内无消费者，docs/P0-CONFIRMATION.md）；plugins 守护 0 处 chat；scrum/sidebar-mockup.html 的 assistant 气泡是标注「mockup 不是真实 GUI」的设计稿；mesh/ 是另一套 agent↔agent 总线，与 chat 表不相通。
- 测试：chat.test.mjs（18 例 DAO 契约）、chat-l1-smoke.mjs（22 断言 HTTP+SSE+token）、chat-s2-smoke.mjs（/hub 主路径），**均无 AI/回复覆盖**。

**结论**：到「发送后有回复」目标 = **整条链路缺失**（无触发器/回复方/数据面/UI 面），这是 R-4 的起点；「回复方 = LLM 直答 or 空间 Agent」是最大的产品口径分叉（D-12）。

---

## 3. 关键术语表（本文件口径，消除歧义）

| 术语 | 定义（本需求采用） |
| --- | --- |
| 空间（scope） | team-hub 分区实体；id/name/private/local_dir/remote_url；`software`/`default` 为受保护空间不可删 |
| 编队（roster） | 空间专属智能体岗位表（role/name/kind/avatar） |
| 技能（skill） | skills 表记录：scope-owned + 状态机 pending→published/rejected + grants 授权（member 或 scope:xxx） |
| 跨空间共享技能 | 空间 A 已 published 技能经授权在空间 B 可被查询/注入/管理（默认 = 引用式共享，见 D-1） |
| 规范文件（agent.md 族） | 注入 agent 提示词的规则/规范载体（现 LEGION.md/AGENTS.md；本需求扩展出 全局/空间 两层） |
| 规范注入 | plugins 守护派工拼装提示词时把规范文本并入（`buildWorkerPrompt`） |
| 移除空间 | 删除空间实体及随 scope 归属的数据；不含磁盘/worktree 回收（默认，见 D-10/D-11） |
| 回复方 | 对话中心里对用户消息产生回复消息的一方：LLM 直答或空间 Agent（D-12 裁决） |
| AI 回复可用 | 发送 → 有回复方应答 → 会话出现回复消息（author ≠ 用户），可感知时间窗内完成或明确失败 |
| 引用式共享 | 技能单行单源（scope=A），靠 grants=['scope:B'] 指向 B，不做复制（与复制分叉相对） |
| 幽灵分区 | 空间删除后因 members 等残留使 /api/scopes 仍列出已删 id |

---

## 4. 范围边界（总纲：做什么 / 明确不做什么）

### 4.1 总「做什么」（✅ 本阶段与后续阶段共同边界）

- DO-1：围绕 4 条目标产出编号需求（R-1~R-4）+ 优先级 + 每条的 背景/目标/做什么/不做什么/可测验收口径（本文件）。
- DO-2：全部现状/缺口表述以真实代码证据锚定（§2 + §10 证据索引），不把假设当结论。
- DO-3：关键歧义显式列出（§8），各带倾向与默认值；默认值明示为假设，供将军逐条裁决。
- DO-4：后续阶段按需求清单实现并逐条验证（breaker 分片 / test-designer 转用例 / coder / tester 锚定）。

### 4.2 总「明确不做什么」（🚫 所有阶段共同）

- 🚫 不做技术选型与实现细节（规范文件存哪/回复链路机制/推送方式/缓存策略选型等 → researcher）。
- 🚫 本阶段不写代码、不改仓库实现、不跑 taskctl/看板写接口、不 push、不下依赖。
- 🚫 不把模糊点悄悄留给下游：默认值即假设，重要分叉（D-1/D-7/D-8/D-10/D-12/D-13）必须将军裁决或显式标注后才可当作需求基线。
- 🚫 不重写既有三中心/看板/守护架构为新技术栈；不动 roles.json 岗位语义与 stage-standards 模板。
- 🚫 不引入需要外网/新密钥才能成立的需求基线（模型来源默认本机 DSH 目录，见假设 A-5）。

---

## 5. 需求清单（编号 + 优先级 + 验收口径）

> 优先级建议：R-1/R-2/R-4 = **P0**（将军明示缺失或不可用的能力）；R-3 = **P1**（后端已存在、闭环成本低、误用风险中等）。将军可在验收评论调整。
> 验收口径均为**可测语句**；「（命令）node team-hub/xxx.test.mjs」等为仓库既有测试运行方式的引用，最终用例形态由 test-designer 落定，实现机制由 researcher/breaker 落定。

### R-1（P0）跨空间共享技能闭环

**背景**：技能体系已具备 scope-owned + grants 雏形（server.mjs:201-527），但空间 A 的已发布技能无法被空间 B 正常消费与管理：UI 查询不带 member 导致授权分支永不触发（api.ts:393-398 vs server.mjs:515）、无撤销 API、review/grant 无 general 门禁（:1748-1786）、守护注入缓存长度比较导致改版不刷新（plugins:442-445）、B 空间无被共享视图。将军诉求 = 把「共享」做成闭环能力。

**目标**：任一空间将军可将本空间已发布技能授权给其他空间（或撤销）；目标空间可见、可管理、其 worker 派工注入生效；全链路（授权/撤销/审计/级联/草稿安全）有测试锚定。

**做什么（scope in）**
1. 技能中心的跨空间可见性与管理 UX：B 空间出现「来自他空间的共享技能」视图（只读；prompt 全文可见性 = D-4 口径），A 空间可发起/撤销对 B 的授权（授权对象可来自空间列表，非仅手打文本）。
2. 授权可撤销：新增 revoke 语义（服务端 + UI），撤销后 B 立即不可见。
3. 权限门禁：review/grant/revoke 服务端限定 by=general（默认，D-2）；非 general 一律拒绝并返回明确错误。
4. 审计：skill:grant / skill:revoke 审计记录携带技能 id、技能归属 scope 与目标空间（修复现跨空间操作审计归错 scope 的问题，server.mjs:1763-1786 未带目标 scope）。
5. 守护注入刷新：注入技能按 version/contentHash 变化刷新（替代长度比较），B 空间 worker 派工提示词能拿到最新共享技能 prompt。
6. 级联/安全：技能归属空间被删除（级联 :1885）后，其他空间的共享视图同步移除（D-6 默认：引用式消失）；pending/rejected/草稿在任何跨空间查询/「全部空间」视图中对非复审者不可见。
7. 测试与文档：skills.test.mjs 增跨空间用例（A 授权给 B → B 按 scope+member 可见、撤销后不可见、非 general 拒绝、A 删除后 B 移除）；README 技能节更新。

**明确不做什么（scope out）**
- 🚫 不做复制式共享/技能分叉（默认引用式，D-1）。
- 🚫 不做隐式「全局技能 scope=*」一次发布全平台（默认显式逐空间授权，D-3）。
- 🚫 不改技能注入在提示词中的位置/职责（规范段职责划分归 R-2 总纲）。

**验收口径（可测语句）**
- AC-R1-1 服务端断言：技能 S（scope=A，published）经 `grant(S, ['scope:B'])` 后，`listSkills({ scope:'B', member:'<B空间某role>' })` 返回 S；未授权空间 C 不返回 S。
- AC-R1-2 撤销断言：revoke 后 B 视角立即不可见（同查询为空）；重复 revoke/撤销未授权技能不报错或返回幂等结果（以实现为准，测试断言其不抛未定义错误）。
- AC-R1-3 权限断言：非 general 调用 grant/review/revoke → 服务端 4xx + 明确错误文案；general 成功。
- AC-R1-4 审计断言：grant/revoke 审计行包含技能 scope 与目标空间（`audit.detail` 可断言），action 前缀 `skill:`。
- AC-R1-5 注入断言：模拟守护 fetch（同 plugins:439 请求形态）在 B 空间返回共享技能；技能内容改版（version+1 且已 publish）后，守护缓存刷新并注入新 prompt（断言缓存按 hash/version 失效的单元逻辑）。
- AC-R1-6 级联断言：删除 A 空间后，B 空间技能查询不再包含 A 技能，无悬空引用（skills.test 新增用例）。
- AC-R1-7 安全断言：带 `include=pending` 之外的所有查询（含全部空间视图）不得暴露任何 pending/rejected 技能的 prompt（对照现 GET include=pending 面，server.mjs:1976-1980）。
- AC-R1-8 UI 冒烟：指挥台 B 空间技能中心可见共享技能条目与来源；A 空间可发起/撤销授权；全部走既有 /hub 代理链路（chat-s2-smoke 同型脚本可参照）。
- AC-R1-9 回归：`node team-hub/skills.test.mjs` 全绿；plugins typecheck/build 0 诊断；workbench pnpm build 通过。

### R-2（P0）分层项目规范（全局 agent.md + 空间/项目层 agent.md）

**背景**：派工规范注入目前只有单一来源（repoRoot LEGION.md→AGENTS.md→scrumDir LEGION.md，取首个、单层、4000 字硬截断，plugins/src/index.ts:849-862）；**不存在**「对所有空间生效的全局规范层」与「随空间/项目独立维护并可覆盖全局的空间层」；worker 在隔离 worktree 只能收到注入文本；规范与「空间绑定仓库」耦合，两空间共仓即共享同一文件无法区分；无任何维护/预览入口。将军诉求 = 类似「全局 agent.md + 项目/空间层面 agent.md」的分层规范建设。

**目标**：建立 ≥2 层的规范体系（全局层 + 空间/项目层），派工/执行提示词中按明确规则合并注入；各层有维护/预览入口与审计；冲突与预算有可测策略。

**做什么（scope in）**
1. 定义规范分层与解析锚点：全局层（对所有空间/仓库生效）+ 空间/项目层（随空间绑定生效）；层内支持文件名族扩展（与既有 LEGION.md/AGENTS.md 同族，默认不破坏既有读取语义——兼容读 LEGION.md/AGENTS.md 的现状）。
2. 合并与优先级：注入顺序稳定且可测（默认：空间/项目层 > 全局层 > 既有 LEGION/AGENTS 兜底；同主题冲突按层覆盖，默认值见 D-8）。
3. 注入通道不变：仍经 buildWorkerPrompt 注入（隔离 worktree 不读文件）；无任何层规范时行为 = 现状降级不报错。
4. 预算与超限：合并注入总量有上限与明确超限策略（默认：可配置上限 + 截断并提示，4000 字单文件现状提升为分层合并预算，见 D-9）。
5. 维护与预览入口：指挥台可查看/编辑空间层规范（或明确引导到文件中心对应文件），全局层规范入口明确；改动留审计（编辑走 handleWrite 写纪律 or 文件写留审计，以方案为准）；提供「注入预览」（可选）。
6. 职责总纲：一份简短文档/README 段说明 LEGION.md/AGENTS.md(文件) vs skills(DB) vs roles.json stage.prompt vs stage-standards 各自承载什么，避免四套载体冲突无总纲（D-9 建议：并存 + 文档化分工）。
7. 测试：解析/合并单测 + 派工提示词冒烟断言两段规范文本都存在且顺序正确 + 预算截断用例。

**明确不做什么（scope out）**
- 🚫 不迁移/废弃既有 LEGION.md/AGENTS.md/skills/stage-standards/roles.json 语义（并存 + 总纲，D-9）。
- 🚫 本阶段不定「全局规范存哪」（DB 新表 vs 各仓库复制 vs 宿主 profile）——机制选型留给 researcher；**语义基线**：全局层必须存在且独立于单一仓库根。
- 🚫 不做规范内容治理（写什么内容的规范由将军/用户自行维护，平台只提供分层+注入+入口+审计机制）。

**验收口径（可测语句）**
- AC-R2-1 分层断言：解析函数在「全局层有内容、空间层有内容」时输出两段；顺序稳定（空间层在前 or 全局层在前按 D-8 默认，测试固定断言）。
- AC-R2-2 优先级断言：空间层与全局层同主题冲突时，注入结果 = 空间层覆盖（D-8 默认）——用两文件各写一条同主题规则做文本断言。
- AC-R2-3 兼容回归：仓库只有 LEGION.md（现状）时，注入文本与现状一致（含「仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）」段）；无任何文件时注入无此段、不报错。
- AC-R2-4 预算断言：总长度超限时按既定策略（截断+提示或分层各自预算）生效，且不产生半截语法破坏（如截断在代码块内需说明）。
- AC-R2-5 注入可达断言：隔离 worktree 派工提示词含全局与空间层规范文本（沿用 buildWorkerPrompt 路径，插件冒烟）。
- AC-R2-6 UI/维护断言：指挥台存在规范维护入口（空间层可编辑或明确跳转）；保存后再次派工提示词反映新内容；操作留 audit（action 可断言）。
- AC-R2-7 回归：plugins typecheck/build 0 诊断；既有派工/流转测试（plugins/tests 若存在）不回归；README/LEGION 相关文档同步更新。

### R-3（P1）移除空间（用户面闭环 + 语义收口）

**背景**：将军反馈「没有移除空间的功能」。代码事实：后端 `POST /api/spaces/delete` 已存在（team-hub/server.mjs:1867-1896，6e01ef1 引入、已合入 main），但指挥台无任何入口、无自动化测试、级联语义有未决边界（孤儿数据/幽灵分区/在办任务/worktree 残留，§2.3）。**需求 = 把已有删除能力接到用户面并收口语义**，而非从零实现删除。

**目标**：将军可在指挥台安全完成「移除空间」（含确认、影响提示、删除后状态正确）；删除语义按将军裁决收口并有测试锚定；受保护空间不可误删。

**做什么（scope in）**
1. 前端闭环：api.ts 增 `deleteSpace(id, confirm)` 客户端；Sidebar 空间行或 SpaceSettingsModal 提供「删除空间」入口 + 二次确认（确认内容列明将删数据面，按 D-10 口径）；删除后若删的是当前激活 scope 则切回「全部空间」并重拉列表（复用 App.tsx:288-302 刷新模式）。
2. 受保护空间 UX：software/default 不提供删除入口或明确禁用并说明原因（对齐后端 :1873）。
3. 后端语义收口（按将军裁决）：级联范围（是否并入 chat/calendar/members，消除孤儿与幽灵分区，D-10）；在办任务/执行中空间的删除策略（拒绝 or 强确认，D-11）；保护名单是否可配置（D-4 之保护名单子项）。
4. 错误与确认契约：前端删除失败（confirm 错/未知空间/非 general/受保护）呈现后端明确错误文案，不静默失败。
5. 自动化测试：team-hub 新增 spaces/delete 用例（HTTP 范式可复用 calendar.test.mjs）：正常删除（断言 7+ 表删行数与返回 removed）、confirm 错误、未知空间、受保护空间、非 general 拒绝；按 D-10 口径断言孤儿表行为。
6. 文档：README §3.1/§4 空间管理补「移除空间」说明。

**明确不做什么（scope out）**
- 🚫 不做磁盘/worktree 回收实现（.legion-worktrees/w/*、已合入分支）——若将军要求回收需另立语义（D-11 子项），本需求默认删除=纯 DB 语义并**在 UI 提示**磁盘残留由运维处理。
- 🚫 不做批量/多选删除；不做删除恢复/回收站（默认，D-10）。
- 🚫 不改受保护空间名单的硬编码语义（除非将军扩展，D-4 子项）。

**验收口径（可测语句）**
- AC-R3-1 前端存在「删除空间」入口；点击后出现二次确认（含空间 id 与影响说明）；确认后发起 `POST /api/spaces/delete`（body 含 id + confirm=`delete-space:<id>`）。
- AC-R3-2 删除当前激活空间后：UI 切到「全部空间」，spaces 列表不再含该 id（api 层断言 + UI 冒烟）。
- AC-R3-3 software/default 不可删除：UI 无入口/禁用 + 服务端测试断言拒绝（:1873）。
- AC-R3-4 服务端用例（新增 spaces.test.mjs 或并入既有）：正常删除 removed 计数与逐表断言、confirm 错误 4xx、未知空间 4xx、非 general 4xx（by 非 general 且无 forceGeneral）。
- AC-R3-5 按 D-10 裁决后的孤儿表断言：删除后 conversations/messages/calendar_events/members（或 /api/scopes）行为与裁决一致（测试锚定，不留二义）。
- AC-R3-6 回归：既有 calendar/chat/skills 测试全绿；/api/spaces 正常返回；workbench build 通过。

### R-4（P0）对话接入 AI/Agent 回复

**背景**：chat 链路 = 纯人-人消息存储，发送即终态（server.mjs:603-625）；全仓无任何 LLM/Agent 回复方（§2.4 检索结论）。将军诉求 = 「发送后，有 LLM 大模型或 Agent 与之对话」。

**目标**：用户在对话中心发消息后，在可感知时间窗内收到回复方的回复消息（同会话可见、留审计、纯文本安全渲染）；回复方不可用时行为明确且不影响人-人收发；每空间可配置。

**做什么（scope in）**
1. 回复触发与身份：定义发送后如何触发回复、回复方身份（by=谁，不得冒充用户；服务端 author=by 纪律延续）、回复消息归属同一会话。
2. 数据面扩展：消息模型需表达「回复方消息/待生成/失败」（新增列或 meta 扩展，保持老库零迁移——chat.test TC-S1-16 迁移锚定不回归）；回复方写入走既有 DAO 审计/SSE 通道（server.mjs:603-625 同构）。
3. UI 面：ChatView 区分「我/回复方」气泡（现唯一判定 author==='general' 需泛化），提供等待中/失败呈现；回复方身份/模型徽标可见（默认）。
4. 配置与护栏：每空间 AI 回复开关（默认值 D-13）；回复可用的模型来源默认本机 DSH 已部署模型目录（README §3.7 同源，避免外网依赖，假设 A-5）；单条回复超时/长度护栏；失败重试次数（默认 0-1 次）与错误呈现。
5. 审计与通知隔离：回复方消息留 chat:* 审计 + SSE 广播（实时送达沿用）；通知中心不被每轮 AI 回复刷屏（NotifyView 对 chat:* 现默认排除，api.ts:589-602 需按口径复核）。
6. 测试：chat 契约扩展（AI 身份消息/待生成状态/失败路径）+ 冒烟（发送→收到回复，含超时与关闭开关两条路径）+ CI 全绿。

**明确不做什么（scope out）**
- 🚫 本阶段不定回复链路机制（LLM 直答实现细节 / 是否流式 / 用哪个模型通道）→ researcher；但**产品口径**（回复方形态、触发、开关默认、身份、保留策略）由将军在 D-12/D-13 裁决。
- 🚫 不改 mesh 总线与任务流水线语义；默认不把 chat 回复接到任务板（除非将军选「空间 Agent 回复」路线才评估与 roster/exec 的关系，D-12）。
- 🚫 不做语音/富媒体/多人会议等新会话形态。

**验收口径（可测语句）**
- AC-R4-1 回复可达：空间开关开启时，发送一条消息后在配置时间窗（默认 ≤120s，可配置）内会话出现一条回复消息，author = 回复方身份（非用户 by），body 与提问相关（冒烟断言：同会话内新增消息、内容非空）。
- AC-R4-2 身份安全：回复方消息 author 不可能等于用户（服务端 author=by 防冒名契约不回归，TC-S1-07 用例保持通过）。
- AC-R4-3 开关：关闭空间 AI 回复后发送消息不产生回复；重新开启恢复；开关状态持久化（per-scope）。
- AC-R4-4 失败路径：回复方不可用/超时 → UI 呈现明确失败（或「回复失败」消息），不影响继续发送人-人消息（可用性回归）。
- AC-R4-5 数据与迁移：老库（无新列）加载后 chat 既有 18 例契约全绿（零迁移风格，TC-S1-16 断言不回归）。
- AC-R4-6 审计与实时：回复方写入产生 chat:message 审计且 SSE 送达（chat-l1-smoke 扩展：≤5s 实时断言沿用）。
- AC-R4-7 渲染安全：回复消息按纯文本渲染（不执行 HTML，README §3.8 安全红线不回归）；长度沿用 MAX_CHAT_BODY=8000（chat.test 常量断言）。
- AC-R4-8 回归：`node team-hub/chat.test.mjs` 全绿；chat-l1-smoke 22+ 断言通过；workbench build 通过；既有 chat-s2-smoke（/hub 代理主路径）通过。

---

## 6. 关键澄清结论（给将军的速览）

1. **④「对话不可用」= 缺 AI/Agent 回复方，不是收发坏**：人-人链路有 18+22 用例锚定可用；需求范围 = 补回复链路（R-4）。
2. **③「没有移除空间功能」= 后端已有、前端没有**：POST /api/spaces/delete（server.mjs:1867-1896）已在 main；需求 = 用户面闭环 + 语义收口 + 测试（R-3），不是从零建删除。
3. **①「跨空间共享技能」= 引用式共享雏形缺后半程**：grants='scope:xxx' 已预留，但目标空间不可见/不可撤销/无门禁/缓存陈旧（R-1）。
4. **②「项目规范」= 现状单仓库根单文件单层**：无全局层、无空间层、无分层合并、无维护入口（R-2）。
5. **四条需求的实现面高度集中在三个文件族**：team-hub/server.mjs、workbench/src、plugins/src/index.ts——breaker 分片时必须按文件域切分（R-1/R-2 同碰 plugins 注入与 team-hub server；R-3/R-4 同碰 team-hub server），见 §7 风险 R-7。

---

## 7. 风险与依赖假设

### 7.1 风险清单

| # | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| R-1 | 技能草稿跨空间泄漏（已存在敞口） | GET /api/skills 列表 + include=pending 与「全部空间」视图无鉴权可读全库草稿含 prompt（server.mjs:1976-1980） | R-1 AC-R1-7 在共享功能落地前/同步修复 |
| R-2 | 空间删除误操作数据丢失 | confirm 字符串即唯一护栏；删除 7 表不可恢复 | R-3 二次确认含影响预览 + 测试锚定 + audit 保留 |
| R-3 | 共享技能随源空间删除断供 | server.mjs:1885 级联删 skills；被引用后删除即断供 | D-6 默认引用式消失 + UI 告警文案 |
| R-4 | 守护注入缓存陈旧 | plugins:442-445 长度比较，同数量改版不刷新 | R-1 AC-R1-5 按 hash/version 失效 |
| R-5 | AI 回复的模型出站依赖与成本 | 每消息自动推理 = token 消耗 + 出站调用；与「禁网/本地优先」基调冲突 | 模型默认本机 DSH 目录（假设 A-5）、每空间开关、超时/失败护栏（R-4） |
| R-6 | 上下文/提示词膨胀 | 规范分层 + 技能全量注入叠加（plugins:1087-1092 均「必须遵守」） | R-2 预算与超限策略 + 分层职责总纲 |
| R-7 | 文件域重叠导致并行切片冲突 | R-1/R-2 同碰 plugins prompt 组装与 team-hub server；R-3/R-4 同碰 team-hub server | breaker 分片时给足独立文件域提示（本 §7 明示）；见 docs/TASK_BREAKDOWN 机器格式纪律 |
| R-8 | 删除后幽灵分区/孤儿数据 | members 无 DELETE + /api/scopes 由 tasks+members 推导 → 已删空间复现 | D-10 裁决后测试锚定 |
| R-9 | 前端「身份恒 general」假设被 AI 回复打破 | hubPost 恒注入 by='general'；author 渲染判定 author==='general'（ChatView:24-26） | R-4 泛化身份模型并更新 S2 smoke |

### 7.2 依赖与假设（✅ 明示为假设，非结论）

- A-1 本仓库（worktree w/T-095 == main 41fd406）是被完善产品的唯一代码基准；§2 全部 file:line 均基于该提交。
- A-2 四条诉求为并列待办特性；本文件给出建议优先级（R-1/R-2/R-4=P0，R-3=P1），将军可调。
- A-3 「agent.md」指代注入 agent 提示词的规范/规则文件族（与现 LEGION.md/AGENTS.md 同族）；具体文件命名/存放由方案阶段定，本需求只定分层语义与验收。
- A-4 ④「对话不可用」默认解读 = 缺 AI/Agent 回复方（证据见 §2.4）；若将军实际遇到人-人也不可用，属环境排障另报（需复现步骤），不在本需求内。
- A-5 回复方模型来源默认 = 本机 DSH 已部署模型目录（README §3.7 所述 `~/.dsh/settings.yaml` 候选），不默认引入外网/新密钥；若将军指定云端模型则属范围外追加（需批准）。
- A-6 引用式共享、显式逐空间授权、级联消失、audit 保留等默认口径 = D 系列假设，将军裁决前按默认值推进并在文档标注。
- A-7 技能/规范的消费面默认仅限守护派工链路（buildWorkerPrompt 注入），exec 通道与人工托管任务是否消费由将军在 D 系列补充（默认：与现状一致，不扩大）。

---

## 8. 待将军裁决与遗留问题（⚖️ / ❓ 汇总）

> 每条均附**倾向与默认值**。默认值已作为需求基线写入 §5；将军不同意的条目请在验收评论中逐条答复，守护会把答复带给后续阶段修订。

| # | 归属 | 问题 | 倾向 / 默认值（默认按此推进） |
| --- | --- | --- | --- |
| D-1 | R-1 | 跨空间共享 = 引用式共享（单行单源 + grants 指向）还是复制分叉？ | **引用式共享**（现 schema grants/scope:xxx 已预留；复制会分裂 version/review 历史） |
| D-2 | R-1 | 技能 review/grant/revoke 是否限定将军（服务端 by=general 门禁）？ | **是**（对照删空间 :1875 先例；否则单令牌即全权，跨空间无边界可言） |
| D-3 | R-1 | 是否需要隐式「全局技能」一次发布全平台生效？ | **先不做**；显式逐空间授权更符合 per-scope 分区纪律 |
| D-4 | R-1 | B 空间对共享技能可见到什么程度（含 prompt 全文？只读？） | 已发布技能：**B 空间只读可见含 prompt 全文**（便于判断是否采用）；草稿绝不外泄 |
| D-5 | R-1 | 共享技能内容改版后 B 何时生效？ | 守护按 **version/contentHash 增量刷新**（轮询，不引入 SSE 推送） |
| D-6 | R-1 | 源空间删除后共享技能行为？ | **级联消失**（B 视图同步移除，无悬空引用；快照会冻结 prompt 违背单源版本语义） |
| D-7 | R-2 | 全局规范层放哪（各仓库复制文件 / team-hub DB / 宿主 profile）？ | **机制选型留给 researcher**；语义要求：全局层独立于单一仓库根且对所有空间生效。若将军有偏好请明示 |
| D-8 | R-2 | 规范层级与冲突规则：需要哪几层？覆盖顺序？未绑定空间归属？ | **两层（全局 + 空间/项目），空间/项目层 > 全局层**；未绑定空间只吃全局层；解析锚点默认 = 空间绑定仓库根（沿用现 toplevel 语义，plugins:543-545） |
| D-9 | R-2 | 与既有载体（LEGION.md/AGENTS.md/skills/stage-standards/roles.json）关系？ | **并存 + 文档化职责分工**（总纲段），不迁移不废弃；同主题重复时按 D-8 层级裁决 |
| D-10 | R-3 | 删除级联范围：是否并入 chat/calendar/members（消孤儿与幽灵分区）？audit 保留？ | **audit 历史保留**（仓库纪律）；conversations/messages/calendar_events/members **随删**（消除孤儿与幽灵分区，/api/scopes 推导随之干净）——若将军选「保留审计追溯聊天记录」则改为保留并接受孤儿，需明示 |
| D-11 | R-3 | 有在办任务/执行中（exec_state 开启/worker 在跑）的空间可否删除？磁盘 worktree 残留？ | 删除**允许但 UI 强提示**（列在办任务数与编排状态 + 二次确认）；磁盘 .legion-worktrees/w/* 残留**不在本需求回收**（UI 提示由运维 git worktree prune） |
| D-12 | R-4 | 回复方形态：LLM 直答（以会话历史为上下文）还是空间内 Agent（带工具/可动文件）？ | **LLM 直答**（无工具/文件访问，安全面小、不涉任务流水线）；空间 Agent 路线作为后续扩展（牵涉 roster/exec/安全面，成本高） |
| D-13 | R-4 | 触发与开关默认：每消息自动回复？默认开还是关？ | **每消息自动回复 + 每空间开关，默认开**（契合「发送后有人对话」诉求；成本顾虑经 A-5 本机模型缓解）；将军若顾虑 token 成本可改默认关 + 显式按钮 |
| D-14 | R-4 | 回复绑定与模型选择粒度？ | **空间级默认**（agent_models 按 scope/role 配模型可复用）+ 会话级覆盖（可选，P1 后置） |
| D-15 | R-4 | 回复以什么形态回到会话（异步落第二条消息 vs 流式片段）？ | **异步落第二条消息**（现有 HTTP+SSE 审计架构零侵入、测试最稳）；流式后置为可选增强 |
| D-16 | 全局 | 各需求是否需要「按角色消费技能/规范」的细粒度（现守护注入按 config.role 单值，plugins:439）？ | 默认**维持空间粒度注入**，worker 实际角色过滤作为 R-1 优化项（可选项，将军勾选才做） |
| D-17 | 全局 | exec（将军 agent 侧派活）与人工托管任务是否也要吃技能/规范注入？ | 默认**不扩大**（与现状一致，A-7）；将军需要则追加范围 |

---

## 9. 下游衔接说明（供 breaker / test-designer 直接使用）

1. **需求 → 切片文件域建议**（breaker 据此给互不重叠文件域，防并行冲突，见风险 R-7）：
   - R-1：team-hub/server.mjs（skills 段）+ team-hub/skills.test.mjs + workbench/src/components/SkillsPanel.tsx + workbench/src/api.ts + plugins/src/index.ts（fetchSkills/注入缓存段）+ README 技能节。
   - R-2：plugins/src/index.ts（readRepoRules→分层解析/合并/预算段）+ team-hub/server.mjs（若走 DB 承载全局层则新增表/接口 + 测试）+ workbench（规范维护 UI）+ 文档（职责总纲）。
   - R-3：workbench/src/api.ts + components/SpaceSettingsModal.tsx|Sidebar.tsx|App.tsx + team-hub/server.mjs（删除语义收口段）+ 新增 team-hub/spaces.test.mjs（HTTP 范式参考 calendar.test.mjs）+ README。
   - R-4：team-hub/server.mjs（chat 数据面/回复端点/开关段）+ team-hub/chat.test.mjs + chat-l1-smoke.mjs + workbench/src/components/ChatView.tsx + api.ts + plugins（若回复方走守护则新增 chat responder 段，按 D-12 裁决）。
   - ⚠️ R-1 与 R-2 都触碰 plugins/src/index.ts 与 team-hub/server.mjs，R-3/R-4 都触碰 team-hub/server.mjs——breaker 需在同一文件内划清不同函数/路由域（如 R-1=skills DAO/路由，R-3=spaces 路由，R-4=chat DAO/路由，R-2=注入解析）或排先后串行，避免并行合入冲突。
2. **测试面锚定**：四需求全部落在既有 7 套件 CI 面内（chat/skills/files-api/web/contracts/whiteboard + calendar），新增用例必须保持 0 失败基线；迁移一律 IF NOT EXISTS 幂等风格（老库零迁移，chat TC-S1-16 先例）。
3. **文档联动**：README §3.1/§3.7/§3.8、workbench/README、LEGION.md（若新增分层语义）需随实现同步更新（仓库纪律）。

---

## 10. 附录：证据索引与文档关系

### 10.1 核心证据（file:line，均基于 main 41fd406）

| 主题 | 证据 |
| --- | --- |
| skills 表/schema | team-hub/server.mjs:201-215、264-271 |
| 技能 DAO（register/review/grant/list） | team-hub/server.mjs:469-527（listSkills 授权分支 :515） |
| 技能路由（无 general 门禁） | team-hub/server.mjs:1748-1786；GET 列表 :1960-1982（include=pending 敞口 :1976-1980） |
| 技能级联删除 | team-hub/server.mjs:1885 |
| 技能测试（无跨空间用例） | team-hub/skills.test.mjs（grant 组 :89-99） |
| 技能 UI/api | workbench/src/components/SkillsPanel.tsx:123-126/:167-181/:198-199/:268-271；api.ts:393-398 |
| 规范注入（单文件单层） | plugins/src/index.ts:849-862（readRepoRules）、:1039-1040（每派工重读）、:1087-1092（注入段） |
| 守护拉技能（长度比较缓存） | plugins/src/index.ts:434-447、:1892 |
| 空间绑定/仓库根 | plugins/src/index.ts:528-557（refreshSpaceBinding）、:560（repoRootFor）、:543-545（toplevel） |
| spaces 表与路由 | team-hub/server.mjs:130-147、:1570-1588（GET）、:1845-1866（POST） |
| spaces/delete（后端已存在） | team-hub/server.mjs:1867-1896（7 表级联 :1880-1888、护栏 :1873-1875）；引入 commit 6e01ef1 已合入 main |
| 前端无删除入口 | workbench/src/api.ts（无 deleteSpace）、components/SpaceSettingsModal.tsx、Sidebar.tsx、App.tsx |
| 幽灵分区根因 | team-hub/server.mjs:1564-1566（/api/scopes 由 tasks+members 推导）、members 无 DELETE |
| chat 表与 DAO | team-hub/server.mjs:221-244（无 role/reply 字段）、:533-534（kind 白名单）、:603-625（发送即终态）、:631-647（分页） |
| chat 路由/SSE | team-hub/server.mjs:1788-1821、:1983-1994（单一审计 SSE） |
| chat UI（author==='general' 判定） | workbench/src/components/ChatView.tsx:24-26、:267-297（send）、:358-359；api.ts:379-390（hubPost by=general） |
| 全仓无回复链路 | team-hub/server.mjs（零出站模型调用）；agent_models :174-183（仅任务执行用）；exec_requests :158-172（无仓库内消费者）；plugins 0 处 chat |
| 测试锚定现状 | team-hub/chat.test.mjs（18 例）、chat-l1-smoke.mjs（22 断言）、chat-s2-smoke.mjs、skills.test.mjs（12 例） |
| 受保护空间/写纪律先例 | team-hub/server.mjs:1873-1875（删空间 general 门禁）、:1150-1163（handleWrite by+token） |

### 10.2 与既有文档关系

- 本文件取代 docs/REQUIREMENTS.md（T-073 版本），旧版可经 git 历史回溯（仓库既有惯例：T-073 取代 T-014 版时同法处理）。
- 关联阅读：根 README.md（平台总览/三中心/技能中心 §3.8、模型目录 §3.7）、workbench/README.md（组件细节）、docs/TEST_REPORT.md（7 套件 225 用例基线）、docs/ORCHESTRATION-V3.md（切片流水线纪律）。
