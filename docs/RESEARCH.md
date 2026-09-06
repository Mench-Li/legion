# T-096 方案搜索与选型报告（四能力：跨空间技能共享 · 分层项目规范 · 移除空间 · 对话接入 AI 回复）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜任务：T-096（分支 w/T-096 独立 worktree，HEAD = 3c8f27d promote T-095；代码文件相对 REQUIREMENTS 基线 41fd406 无变化，本报告 [本地] 行号均按 w/T-096 本阶段 read/grep 实测）
> 输入：docs/REQUIREMENTS.md（T-095 需求澄清，本任务唯一权威需求基线；含 R-1~R-4 需求清单、可测验收口径 AC-*、D-1~D-17 待将军裁决项与默认值）
> 下游：breaker（docs/TASK_BREAKDOWN.md，须写「## slices」）→ test-designer → coder → reviewer → tester → devops
> 替换关系：本文档**取代**同文件 T-074 报告成为当前阶段依据；T-074 报告全文（含其存档的 T-044 全文）已原样移入文末「存档附录」（内容一字未删），经 git 亦可回溯（T-074 提交 edaada6）。
>
> **结论一句话**：四项能力在**既有架构内即可闭环，v1 推荐全部走「零新增运行时依赖」路线**——① 技能共享 = 引用式共享（现状 grants 模型）补齐「服务端 scope:B 可读 + revoke + general 门禁 + 按 version/contentHash 刷缓存 + 跨空间视图」；② 分层规范 = 新增「全局规范层」（v1 推荐 team-hub DB 承载，备选守护配置指向的全局文件）+ 空间/项目层文件族合并注入（兼容现状 LEGION.md/AGENTS.md 读法），配总预算截断与职责总纲；③ 移除空间 = 把已合入 main 的 POST /api/spaces/delete（6e01ef1）接到指挥台用户面 + 级联收口（并入 chat/calendar/members 清孤儿与幽灵分区）+ 类型化二次确认；④ 对话 AI 回复 = 每空间开关 + 消息「待回复」状态位（messages.meta，零迁移），**回复执行 v1 推荐由守护插件（dsh-scrum-worker）以轻量子代理「LLM 直答」完成**（复用 DSH 既有模型/凭据通道，符合 D-12 默认），team-hub 保持零出站模型调用、可单测；备选 = team-hub 内嵌 OpenAI 兼容 HTTP 队列（需将军确认本机端点与凭据形态，见闸门 G-R4-1/G-R4-2）。

## 0. 结论速览（TL;DR）

| 需求（REQUIREMENTS §5） | 一等（推荐） | 备选 | 排除 |
| --- | --- | --- | --- |
| R-1 跨空间共享技能（P0） | **引用式共享原地补齐**：listSkills 语义扩展（scope=B 自动含 grants 含 scope:B 的已发布技能，UI 带来源标识）+ 新增 revokeSkill（general 门禁）+ 审计带目标空间 + 守护按 (version/contentHash) 指纹刷新缓存 + 共享视图只读含 prompt 全文（D-4 默认） | 独立共享关系表 skill_grants（规范三范式，支持撤销历史/来源反查，技能数增长后再迁） | 复制分叉（D-1 排除）；ReBAC 关系表（SpiceDB 式，过度） |
| R-2 分层项目规范（P0） | **两层注入**：全局层 = team-hub 新表+API（或守护配置全局文件，见 G-R1）；空间/项目层 = 空间绑定仓库根文件族 {LEGION.md, AGENTS.md, agent.md} 合并；顺序 = 全局层→空间层（空间层后置并显式声明优先，满足 D-8）；总预算默认 7000 字（全局 3000 + 空间 4000，可配），段落边界截断+提示；buildWorkerPrompt 独立小节注入 | 全局层存守护配置文件指向的宿主文件（不改 DB，编辑走文件中心） | 每仓库复制全局文件（漂移）；单层现状（不满足 AC-R2-1） |
| R-3 移除空间（P1） | **用户面闭环 + 级联收口**：SpaceSettingsModal「危险区」type-to-confirm（输入 delete-space:<id>）+ 影响清单预检端点 + 删除当前空间自动切「全部空间」；服务端删除事务扩至 chat/conversations+messages/calendar_events/members（消孤儿与幽灵分区，audit 保留，D-10 默认） | 软删除 tombstone（spaces.deleted_at + 全查询过滤；将军若要求可恢复再启用） | 前端 confirm() 弹窗直删（信息不足）；维持现状（不满足诉求） |
| R-4 对话 AI 回复（P0） | **数据面薄扩展 + 守护执行**：per-scope 开关表 chat_reply_settings（默认开，D-13）+ 消息 meta.aiStatus=awaiting/replied/failed（零迁移列扩展）；守护新增 chat-responder 扫单（队列式 GET /api/chat/replies → 轻量子代理生成 → POST /api/chat/messages 落第二条消息，author=回复方身份，D-15 异步落消息） | team-hub 内嵌 LLM 队列直连本机 OpenAI 兼容端点（开关/端点/密钥经 env 配置；适合不依赖守护的部署） | 独立 sidecar 服务（部署面大）；前端直调模型（token 暴露/违 hub 代理纪律） |

---

## 1. 输入、范围与方法

### 1.1 需求输入（T-095 REQUIREMENTS.md，唯一权威基线）

- **R-1（P0）跨空间共享技能闭环**：B 空间可见/管理 A 空间授权技能；可撤销；review/grant/revoke general 门禁；审计带目标空间；守护注入按 version/contentHash 刷新；级联与草稿安全；测试锚定（AC-R1-1..9）。
- **R-2（P0）分层项目规范**：全局层 + 空间/项目层规范文件族；稳定合并顺序与层级覆盖（默认空间层 > 全局层）；不破坏既有 LEGION.md/AGENTS.md 兜底语义；预算与超限策略；维护/预览入口与审计；职责总纲（AC-R2-1..7）。
- **R-3（P1）移除空间用户面闭环**：前端入口 + 二次确认（列明影响）+ 删除当前激活空间切回全部空间；受保护空间 UX；后端语义收口（D-10/D-11）；错误呈现；spaces/delete 测试（AC-R3-1..6）。
- **R-4（P0）对话接入 AI/Agent 回复**：回复触发/身份/开关/模型来源（默认本机 DSH 已部署模型，A-5）/超时失败护栏/数据面扩展（零迁移）/UI 三态/审计 SSE/渲染安全（AC-R4-1..8）。
- 硬性不变量（REQUIREMENTS §4.2 + 本仓库纪律）：零新增运行时依赖（禁网，先本地盘点）；写统一 handleWrite（by 必填 + audit + SSE）；author=by 防冒名；渲染安全（不直插 HTML）；老库零迁移（IF NOT EXISTS 幂等）；本次**只产 docs/RESEARCH.md**（不改代码/不调 taskctl/不 push）。

### 1.2 现状代码证据（本阶段 read/grep 实测锚点，w/T-096 HEAD=3c8f27d，均可复核）

| 主题 | 证据 | 含义 |
| --- | --- | --- |
| 技能 schema（grants JSON 列） | team-hub/server.mjs:200-216 | 单行 grants='[]' 数组存 JSON；id 主键；status/version/contentHash 齐备 |
| registerSkill / reviewSkill | :469-491 / :493-502 | 内容幂等；变更 version+1 回 pending；仅 pending 可 publish/reject |
| listSkills 授权分支 | :504-518（granted 判定 :515） | **只有传 member 才触发 grants 分支**；scope 过滤=精确相等（:514）；默认只 published |
| grantSkill 只追加无撤销 | :520-527 | 并集合并写回，**无 revoke API**；撤销缺失是本轮要补的最小缺件 |
| 技能路由无 general 门禁 | :1748-1786 | register/review/grant 只经 handleWrite（任意 by 均可审/授），对照删空间 :1875 有 general 检查 |
| GET /api/skills | :1960-1982 | ?id= 未发布且无 include=pending → 404（防泄漏 :1966-1969）；列表 include=pending 全量可见（敞口，AC-R1-7 要求收口） |
| 技能级联删除 | :1885（DELETE FROM skills WHERE scope=?） | 源空间删 → 共享技能消失（D-6 引用式消失默认与代码现状一致） |
| 守护拉技能 + 缓存 | plugins/src/index.ts:436-447（fetchSkills；长度比较 :442-445） | **同数量技能改版守护不刷新**（缓存陈旧根因）；member 参数=config.role 单值（:439） |
| readRepoRules（单文件单层） | plugins/src/index.ts:849-862（候选 :851-855、截断 :858 slice(0,4000)） | LEGION.md→AGENTS.md→scrumDir/LEGION.md 取**首个存在文件**，不合并不叠加 |
| 注入点 | buildWorkerPrompt :1039-1092（规则段 :1087-1089、技能段 :1090-1092）；每派工实时重读 :1040 | 提示词注入是 worker 唯一通道（隔离 worktree 不读文件） |
| 空间仓库绑定 | refreshSpaceBinding :530-557；repoRootFor :560 | 规范与「空间绑定的仓库根」绑定；空间本身无规范字段 |
| chat 表 | server.mjs:220-246（conversations/messages 无 role/reply 字段，meta JSON 列已存在 :240） | 数据面扩展可走 meta 或 IF NOT EXISTS 加列 |
| postMessage 发送即终态 | :603-625（DAO 内 audit+SSE；author=by 绑定 requireMember :1140-1144） | 回复方消息可复用同 DAO/审计/SSE 通道（D-15 异步落第二条消息） |
| 全仓无回复链路 | team-hub 零出站（grep fetch( 仅 URL 构造 :1166）；plugins 零 chat 引用（grep）；agent_models :174-183 仅任务执行配置 | 整条回复链路缺失是 R-4 起点 |
| spaces/delete 已存在 | :1867-1896（护栏 :1872-1875；7 表级联 :1880-1888；audit :1892） | **后端能力已就绪**；前端零接入、测试零覆盖 |
| 幽灵分区根因 | /api/scopes :1562-1567 由 tasks+members 推导；members 全文件无 DELETE（grep 实测）；conversations/messages/calendar_events 无 scope 级 DELETE（grep 实测，calendar 仅按 id 删 :760） | 删除需并入这 4 张表才干净（D-10 默认） |
| 前端技能 UI | workbench/src/components/SkillsPanel.tsx:35/:42（fetch 只带 scope+includePending）、:97-105（授权自由文本）、:178-199（授权 UI）、:223-271（注册 scope 可编辑） | UI 从不传 member → 授权分支永不触发（跨空间不可见根因之一） |
| api.ts 技能/聊天 | api.ts:392-398（fetchSkills 无 member 参数）、:379-390（hubPost 恒注入 by=general）、:480-488（postChatMessage）、:490-501（SSE chat:* 订阅） | 回复方身份 ≠ general 时需 UI 泛化 author 判定 |
| ChatView 身份判定 | ChatView.tsx:24-26/:358-359（author==='general' → 我/右侧） | AI 回复方 author 取非 general 名即可在对方侧渲染；等待/失败态需新增 |
| 守护主循环 | plugins/src/index.ts:1870+（sweep；:1890 refreshSpaceBinding、:1892 fetchSkills） | R-4 回复扫单可挂同轮或独立 interval |
| 测试面 | team-hub/skills.test.mjs（grant 组 :89-99 均为同 scope，无跨空间用例）；chat.test.mjs 18 例；chat-l1-smoke 22 断言（REQUIREMENTS §2/§10） | 跨空间/回复链路测试待 test-designer 增补 |
| 模型配置 | README §3.7 :127-138（agent_models per scope/role；候选=本机 DSH 部署模型 ~/.dsh/settings.yaml）；agent_models 表 server.mjs:174-183、模型路由 :1467-1492 | R-4「回复模型」按空间可配的事实底座已存在（复用或新建 chat 级配置） |
| 报告载体 | roles.json:14-21（researcher 阶段 gate，artifact=docs/RESEARCH.md） | 本文件即本阶段唯一交付物 |

### 1.3 评估维度与引用分级

- 每决策域按「候选 ≥2 / 适配度 / 成熟度与许可证 / 成本（实现+运维+学习）/ 风险 / 结论（一等·备选·排除）」评估；推荐理由锚定 [本地] 行号（可离线复核）或 [公开·待核] URL。
- 引用分级沿用 T-074 惯例：`[本地]` = 本仓库文件/行号/命令输出；`[公开·待核]` = 公开项目/规范/许可证事实。本环境 **web_search 实测 Insufficient Balance（2026-09-06 本阶段已复测，与 T-074 记录一致）**，仓库纪律同时禁网；故公开事实一律标「待核」并给规范 URL，**不编造 star 数/版本号/发布日期/下载量**；对外部库的「维护活跃度」只给定性判断（成熟项目/社区活跃等），不写量化数字。
- 「新引入技术/依赖」判定以实际引入为准：v1 一等路线**零新增运行时依赖**（node:sqlite/node:http/Node fetch/React/EventSource 均已在产线）；§16 逐项列出候选依赖的影响与前置条件。

---

## 2. 决策域 K1（R-1）：跨空间共享的技能授权模型与 API 面

> 目标：空间 A 的已发布技能可授权给 B（scope:B）、B 空间可见、A 可撤销、全程可审计（AC-R1-1/2/3/4）。D-1 已默认引用式共享（单行单源 + grants 指向），D-2 默认 general 门禁，D-4 默认 B 只读可见含 prompt 全文、草稿绝不外泄。

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K1-A（推荐）原地演进 grants 列**：listSkills 语义扩展——`scope=B` 时除 s.scope===B 外，**自动返回 grants 含 'scope:B' 的已发布技能**（服务端判定，UI 不必传 member）；新增 DAO revokeSkill(id, targets)= 从 grants 过滤删除并写回；路由 review/grant/revoke 前加 `if (by !== 'general') throw`（对照 :1875 先例）；audit 的 detail 携带技能归属 scope 与目标空间；查询侧对 pending/rejected 默认不可见（现有 :512 保持），include=pending 仅限 general | 高：正中「B 不可见/不可撤销/无门禁」三缺口；改动集中在 server.mjs skills DAO/路由段 + SkillsPanel（跨空间标识） | 低-中：零迁移（grants JSON 列不动）；listSkills 加约 3 行过滤 + 1 个 revoke 函数 + 3 处路由守卫；skills.test 增跨空间/撤销/门禁用例即可直转 AC-R1-1..4 | 低：规模小（几十技能）时全表 JS 过滤足够；撤销即时生效（每次读实时过滤）；audit 已全量保留（撤销留痕靠 audit，不新增历史表） | **一等**：改动最小、与 D-1..D-6 默认完全一致、测试面清晰（[本地] :504-527、:1748-1786） |
| K1-B 独立共享关系表 skill_grants(skill_id, target_type∈{member,scope}, target, granted_by, granted_at) | 中-高：三范式，可反查「B 收到哪些共享」「谁授的/何时」；撤销=删行；天然支持未来 per-member 级授权审计 | 中：新表 + 迁移（IF NOT EXISTS）+ register/review/list/revoke/级联全路径改写 + UI 增来源查询；skills 表 grants 列或保留（兼容）或废弃（读旧列迁移） | 中：改造面大、与既有 register/grant 语义（:469-527）双写易错；对「几空间 × 几十技能」规模属过度设计 | 备选/演进：当技能数上百、或将军要「来源列表/撤销历史」专门视图时再迁；v1 不建议（成本收益比低） |
| K1-C ReBAC 关系元组表（SpiceDB/Zanzibar 式 object#relation@subject，开源实现如 SpiceDB） | 中：关系模型最通用（空间=namespace，技能=object，reader=relation） | 高：引入外部依赖/服务或自研关系引擎；与单库 SQLite 现状割裂 | 高：新存储/新鉴权层/运维面，明显超出本需求规模 | 排除（过度）；仅作为**概念参考**引用（[公开·待核] Google Zanzibar 论文：https://research.google/pubs/pub48190/ ；SpiceDB 文档：https://authzed.com/docs/spicedb/concepts/relations） |

**设计要点（供 breaker/designer）**：①B 空间「共享视图」= 列表项带来源标识（skill.scope ≠ 当前 scope 即标注「来自空间 X」+ 只读，prompt 全文可见，D-4）；②revoke 对象粒度 = member 或 scope:B 字符串，与 grant 输入同构（UI 复用授权输入框，行内「撤销授权」）；③路由层 general 门禁放 handleWrite run 内（:1748-1786 同款），对照删空间守卫 :1875 措辞；④GET /api/skills 的 include=pending 仅 general（防草稿泄漏 AC-R1-7；当前 listSkills includePending 无鉴权，需在路由层加 by==='general' 校验或由授权表控制）；⑤级联：技能归属空间删除后 B 视图随 :1885 消失，无需额外逻辑（D-6），UI 无需悬空处理。

---

## 3. 决策域 K2（R-1）：守护注入缓存失效策略（AC-R1-5）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K2-A（推荐）响应指纹比对**：fetchSkills 每次拉取后计算技能列表的指纹 `JSON.stringify(skills.map(s=>[s.id,s.version,s.contentHash]))`（或直接 JSON hash），指纹变化才替换 sharedSkills 缓存（替换现有长度比较 :442-445）；拉取间隔沿用守护 intervalMs（默认 30s，[本地] plugins:92） | 高：正中「改版不刷新」（同数量技能 version+1 后指纹即变）；无需改 hub API（响应已含 version/contentHash） | 极低：~5 行改动 | 低：B 空间新增「共享技能出现/撤销消失」也随指纹变化即时进入下一轮派工；轮询延迟 ≤ intervalMs（D-5 默认轮询，不引 SSE 推送） | **一等**：直转单测（同数量不同 version → 刷新；同指纹 → 不刷新；撤销后 → 移除） |
| K2-B 全量 JSON 深度比较（不预计算指纹） | 中 | 低 | 每轮 JSON.stringify 全量 + deepEqual；语义同 K2-A 只是实现差异 | 并入 K2-A 实现细节（用 hash 即可） |
| K2-C hub 端 SSE/WebSocket 推送技能变更事件 | 中：实时性最好 | 中-高：新事件源或并入 /api/events 需守护开 SSE 长连（plugins 现状为轮询架构）；与 D-5 默认冲突 | 中：守护进程生命周期/重连处理复杂化 | 排除（D-5 默认轮询 + 指纹已满足 ≤30s 收敛） |

**设计要点**：指纹只做「变更检测」，不依赖 server 端新端点；技能被撤销/空间删除导致列表变化同样触发刷新（AC-R1-5 断言涵盖「内容改版」「撤销后 B 不可见」两个方向）。

---

## 4. 决策域 K3（R-2）：全局规范层载体（D-7 机制选型）

> D-7 语义基线：全局层必须存在、独立于单一仓库根、对所有空间/仓库生效；机制由 researcher 定。AC-R2-6 要求指挥台存在规范维护入口且操作留 audit（action 可断言）。

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K3-A（推荐）team-hub DB 新表 rules + API**：表 `rules(key TEXT PRIMARY KEY, scope TEXT, content TEXT, updatedAt)`，key='global' 为全局层（scope='*'），另预留 space 级 rules（scope=<spaceId>）作「DB 空间层」扩展点；`GET /api/rules?scope=global|space` 供守护拉取，`POST /api/rules` 走 handleWrite（by 必填 + audit `rules:update` + SSE，仿 chat 写纪律）；守护每轮 fetchRules 缓存于内存（同 fetchSkills 模式 :436-447） | 高：单源单事实、跨仓库可用（不同空间守护从同一 hub 取全局层）、审计/维护入口天然（workbench「规范」卡，保存即 audit）、不依赖文件落盘位置 | 中-低：1 表 + 2 路由 + 守护 fetch + 前端一页；与既有 chat/calendar 扩表先例同构（零迁移 IF NOT EXISTS） | 低：内容规模小（K 级文本）；SQLite 无压力；守护多空间同时拉 = 只读 GET 无害 | **一等**：AC-R2-6「维护入口 + audit 可断言」最直接达成；全局层与任何单一仓库解耦（正中 D-7 语义） |
| K3-B 守护配置指向的全局文件（如 config.globalRulesFile = <某共享路径>/agent.global.md，每派工实时读盘合并） | 高：编辑体验 = 直接改 md 文件，可 git 管理、diff/评审自然；readRepoRules 现读盘实现 :849-862 可顺手统一 | 低：配置文件 + readFileSync；无需新表 | 中：维护入口 = 文件系统（指挥台内编辑需 serve.mjs 文件中心放开该目录或引导到外部编辑器）；**audit 弱**（文件写留痕依赖既有文件中心审计，路径不在 local_dir 内时无入口）；多守护部署时每守护需同文件可见 | 备选：适合「将军只想要一个 md、不想碰 DB/UI」的场景；若选此路线需把 AC-R2-6 的 audit 口径降级为「经文件中心写文件留痕」（要另立入口） |
| K3-C 每仓库复制一份全局文件 | 低：多仓库各自副本必然漂移 | 低 | 高：全局层语义被仓库绑定破坏（两空间共仓即共享同一文件，REQUIREMENTS §2.2 已指出此问题） | 排除（D-7 语义要求独立于单一仓库根） |

**设计要点（供 breaker）**：K3-A 数据面 + K4 的「空间层读盘」可同时成立（全局层在 DB、空间层在仓库文件，互不冲突）；守护 fetchRules 失败降级 = 只用空间层（不报错）；内容长度上限沿用 §6 预算。

---

## 5. 决策域 K4（R-2）：空间/项目层文件族与合并/优先级（D-8/D-9）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K4-A（推荐）空间层文件族 + 全局层顺序合并**：解析锚点 = 空间绑定仓库根（repoRootFor() :560，未绑定用注入 repoRoot）；文件族按固定顺序读**全部存在者**：`LEGION.md → AGENTS.md → agent.md`（兼容现状 LEGION/AGENTS 读法；agent.md 为新增族成员，与 T-095 A-3「agent.md 指代注入文件族」一致）；输出 = [全局层段] + [空间层段]，段首各加明确优先级声明「以下为**空间/项目层**规范（优先于全局层）」；readRepoRules 重构为 readNorms()（global → space 两层，各自带来源标注），buildWorkerPrompt 规则小节引用之 | 高：正中「无全局层、无分层合并」缺口；保持 LEGION.md/AGENTS.md 兜底语义（AC-R2-3）；worker 提示词含两段可断言顺序（AC-R2-1） | 低-中：重构 readRepoRules（:849-862）→ 分层读取 + 拼接 + 预算（~30 行）+ 守护接入全局层来源；plugins typecheck/build 回归 | 中：提示词文本「优先级」靠声明而非覆盖过滤——对 LLM 属可接受的软优先级（与 Claude Code CLAUDE.md 子目录就近优先精神一致，[公开·待核] Anthropic 文档：https://docs.anthropic.com/en/docs/claude-code/memory）；同主题硬冲突的确定性裁决由「空间层声明优先 + 全局层兜底」文案承担，测试按文本断言（AC-R2-2） | **一等**：AC-R2-1/2/3/5 全部直接可测（解析函数单测 + 冒烟断言两段存在且顺序正确） |
| K4-B 严格结构化覆盖（按主题小节合并去重，如「#安全」「#命名」分区后以空间层为准替换全局层同主题块） | 中-高：冲突裁决最确定 | 高：需解析 md 标题结构、维护主题注册表；提示词内容千差万别，分节不可靠 | 高：语法/主题识别脆弱；过度工程 | 排除（v1）；文档化声明 + 顺序已满足需求口径 |
| K4-C 单一合成 blob（层信息丢失） | 低 | 低 | 无法区分来源/优先级，AC-R2-1/2 不可测 | 排除 |

**设计要点**：①每层截断预算与超限提示见 §6；②新增 agent.md 族成员 = 解析锚点 `join(repoRoot,'agent.md')`，若将军想要「项目/空间层 agent.md」独立于 AGENTS.md 语义，由 breaker 按本候选落；③规则段文案从「来自 LEGION.md/AGENTS.md」泛化为「来自规范层（全局/空间）」需同步 README/LEGION 相关说明（AC-R2-7 文档联动）。

---

## 6. 决策域 K5（R-2）：注入预算与超限策略（D-9 子项/AC-R2-4）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K5-A（推荐）分层预算 + 段落边界截断 + 提示标记**：默认 全局层 ≤3000 字、空间层 ≤4000 字、合计 ≤7000 字（现状单文件 4000 的升级口径，均可在守护 config 覆盖：globalRulesMaxChars/spaceRulesMaxChars）；每层超限在**段落边界**（\\n\\n）截断并追加「（规范超限截断：原文 N 字，已保留前 M 字）」 | 高：预算可测（AC-R2-4 截断+提示）、不产生半截代码块（段落边界） | 低：纯函数 maxLenAtParagraph(text, n) 可 node --test | 低：截断语义透明、不静默 | **一等** |
| K5-B 单层独立预算各自截断（不设合计） | 中 | 低 | 两段都满时合计仍可能超长（提示词膨胀 R-6） | 否（K5-A 含合计兜底） |
| K5-C 超限即报错拒绝派工 | 低 | 低 | 规范写长一点就打断流水线，体验差 | 排除（截断+提示优于拒绝） |

---

## 7. 决策域 K6（R-3）：删除级联范围与孤儿/幽灵分区收口（D-10/AC-R3-5）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K6-A（推荐）删除事务扩至 chat/calendar/members**：在现 7 表事务（:1880-1888）追加 `DELETE FROM conversations WHERE scope=?`、`DELETE FROM messages WHERE scope=?`（messages 表已有 scope 列 :237，直接按 scope 删即可）、`DELETE FROM calendar_events WHERE scope=?`、`DELETE FROM members WHERE scope=?`；audit 保留（不删 audit 行，审计历史纪律）；removed 计数逐表返回 | 高：一次性消除孤儿（conversations/messages/calendar_events 残留）与幽灵分区（members 清后 /api/scopes :1562-1567 推导干净） | 低：server.mjs 内 ~8 行 + spaces.test 用例断言逐表删行数与 /api/scopes 不含已删 id | 低-中：messages 按 scope 删依赖该列始终与会话 scope 一致（DAO :618 写入时恒等于会话 scope，:608 getConversation 保证）——测试锚定即可 | **一等**：与 D-10 默认一致；对照代码事实：members 现无任何 DELETE（grep 实测）、messages/conversations/calendar_events 无 scope 级 DELETE（calendar 仅按 id :760）——缺口正好被本候选闭合 |
| K6-B 保留孤儿 + 查询侧过滤（/api/scopes、calendar、chat 对未知 scope 屏蔽） | 中 | 中：每处读取都要带「已删空间名单」 | 中：历史消息仍留在库内可被未来同名 scope 复活误读；多处守卫易漏（calendar 列表现无守卫，REQUIREMENTS §2.3） | 排除（D-10 默认随删；守卫式治标不治本） |
| K6-C 软删除 tombstone（spaces.deleted_at=1 + 全查询 WHERE deleted_at IS NULL） | 中-高：可恢复性好 | 中-高：所有 spaces/scope 相关查询/推导加过滤；skill/chat/calendar 数据仍留库；回收机制（何时物理清）未定 | 中：与 D-10 默认冲突；「已删空间数据仍可查」语义复杂化 | 备选：**仅当将军裁决要「可恢复/回收站」时启用**（闸门 G-R3-1），v1 按 K6-A 推进 |

---

## 8. 决策域 K7（R-3）：用户面删除 UX、保护与确认（D-11/AC-R3-1..3）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K7-A（推荐）设置弹窗「危险区」+ type-to-confirm + 影响预检**：SpaceSettingsModal 底部新增「删除工作空间」危险区（仅非 software/default 且 hub 模式）；展开后展示预检影响清单（新增只读 `GET /api/spaces/impact?id=` 返回任务数/编队数/消息数/日程数/技能数/在办执行状态）+ 在办任务强提示（D-11 默认允许删但明示）+ 输入框要求输入 `delete-space:<id>` 才可点确认（type-to-confirm，对齐 GitHub 删除仓库需输入仓库名确认的业界实践，[公开·待核] https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository）；确认后调 api.ts 新增 deleteSpace(id, confirm)；若删的是当前激活 scope → 切回「全部空间」并重拉（复用 App.tsx:288-302 刷新模式） | 高：正面补「用户面移除空间闭环」；预检信息让确认有意义 | 中：SpaceSettingsModal 增危险区区块 + api.ts deleteSpace + team-hub 增 impact 只读端点 + 前端 scope 切换（/hub 代理通用，serve.mjs 无涉） | 中：误删由 type-to-confirm + 后端 confirm 字符串双保险（服务端护栏已存在 :1872-1875）；**删除后磁盘/worktree 残留不在本需求回收**（D-11），UI 文案明示由运维 git worktree prune | **一等** |
| K7-B Sidebar 行内垃圾桶 + 原生 confirm() | 低-中 | 低 | confirm() 无法展示影响清单/无 type-to-confirm；误删风险高；受保护空间处理粗糙 | 排除（确认质量不足） |
| K7-C 仅接入 api.ts 无 UI 入口（后端闭环不接用户面） | 低 | — | 不满足诉求（将军原话「没有移除空间的功能」= 用户面缺失，REQUIREMENTS §6.2） | 排除 |

**设计要点**：①预检端点也可被 tests 断言（AC-R3-4 前传）；②删除失败（confirm 错/未知/受保护/非 general）呈现后端 error 文案（api.ts hubPost 已抛 `status：error`，:385-388 复用）；③受保护空间判定：id ∈ {software, default}（后端硬编码 :1873，前端同名单禁用入口即可）。


---

## 9. 决策域 K8（R-4）：回复执行通道（D-12 落点/AC-R4-1..4）

> 现状事实：team-hub 零出站模型调用（grep 实测）；守护插件是仓库内唯一有「模型 + 凭据」接入能力的执行层（README §3.7 明示按角色/空间配置模型；worker/讨论均经 DSH subagent 派生）；chat 数据面/审计/SSE 通道已完备（:603-625）。「回复方」必须由某处调用模型——三选一：team-hub 内嵌调用 / 守护插件执行 / 独立 sidecar。

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K8-A（推荐）守护插件 chat-responder（队列式）**：①team-hub 侧只做薄状态面——per-scope 开关表 `chat_reply_settings(scope PK, enabled, model?, identity?, systemHint?, updatedAt)`（默认 enabled=1 且可关，D-13）+ 发消息时若该空间开关开且 author ≠ 回复方身份 → messages.meta 写 `{aiStatus:'awaiting'}`（零迁移：meta JSON 已存在 :240；与消息落库同一事务原子完成）；②新增只读队列端点 `GET /api/chat/replies?scope=&sinceMsgId=` 返回 awaiting 消息（按 conv 聚合最近上下文，limit 上限防爆）；③plugins 守护新增轻量扫单（独立 setInterval 或并入 sweep 轮，默认 10-30s）：拉 awaiting → 对每条派生**无仓库工具的子代理**（agentPreset 同源、模型按 agent_models 该空间默认或 chat_reply_settings.model、提示词 =「你是该空间对话助手，基于会话历史回答，禁止工具/文件访问」→ 即 D-12 默认的 LLM 直答形态）→ 生成回复文本 → `POST /api/chat/messages {conv, body, kind:'text', by:<identity>}`（回复方身份默认 settings.identity ?? `<scope>-assistant`，**≠ general** → 前端显示为对方，author=by 纪律不破坏 AC-R4-2）→ 更新源消息 meta.aiStatus='replied'；子代理失败/超时 → meta.aiStatus='failed' + meta.error；对 awaiting 超龄（如 >120s 无执行方）由守护或 UI 呈现失败（AC-R4-4） | 高：正中「无回复链路」根因且**复用 DSH 既有模型通道**（A-5 默认「本机 DSH 已部署模型」= 守护能调用的同一批模型）；team-hub 保持零模型耦合 → 可单测（chat.test 扩展直接注入 meta 断言，不依赖真模型）；符合 D-15 异步落第二条消息、审计/SSE 走既有 DAO（:603-625 同构） | 中：守护端新增 responder 模式（~80-120 行：扫单/并发上限/超时/失败回写）+ team-hub 端开关表与队列端点 + UI 三态 | 中：依赖守护在线（每空间需有守护实例；现运行中已有 software 空间守护）；回复延迟 = 扫单间隔 + 生成时长（默认 ≤120s 窗口内可达成，AC-R4-1 需测试锚定）；多守护/重入防重复回复靠状态机 CAS（仅 awaiting→replied 可成功，重复拉取幂等）；token 成本受 D-13 默认开影响（§13 R-4c） | **一等**：与既有架构耦合最浅、测试最稳；执行方失败不影响人-人收发（AC-R4-4） |
| K8-B team-hub 内嵌 LLM 队列（直连 OpenAI 兼容端点） | 中-高：对话闭环不依赖守护；延迟最低 | 高：team-hub 引入首个出站能力——端点/baseURL/key 配置（env：TEAM_HUB_LLM_*）+ 并发队列 + 重试/超时状态机 + 前端等待；密钥管理与「零出站」纪律冲突 | 高：~/.dsh/settings.yaml 是 DSH harness 私有格式，team-hub 直读耦合宿主；密钥泄漏面；本地端点形态未确认（A-5 语义依赖将军确认「本机模型目录」实际形态） | 备选：**当将军确认存在本机 OpenAI 兼容端点（Ollama/llama.cpp/LM Studio/DSH 网关）且希望对话不依赖守护时启用**（闸门 G-R4-1）；协议层选型见 K10 |
| K8-C 独立 sidecar 回复服务 | 中：职责单一、可水平扩展 | 高：新进程/新配置/新部署单元 + 与 hub/守护的认证 | 高：部署面与运维成本明显上升 | 排除（v1）；未来多空间高并发再评估 |

**设计要点（供 breaker/designer）**：①防死循环：只对 author ≠ 回复方身份的普通消息触发（assistant 消息不回）；②并发上限/超时护栏仿 worker（maxWorkers/workerTimeoutMs 既有 config）；③回复长度沿用 MAX_CHAT_BODY=8000（:535）；④kind 保持 text（纯文本渲染红线，README §3.8）；⑤NotifyView 对 chat:* 现默认排除（api.ts:589-602 区域，REQUIREMENTS §2.4）→ 回复不刷通知中心，需复核保持。

---

## 10. 决策域 K9（R-4）：回复数据面与 UI 呈现（AC-R4-5/6/7）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K9-A（推荐）meta 状态 + author 泛化 + 三态 UI**：消息数据面**不加新列**，状态走 messages.meta（aiStatus/aiModel/aiError，老库零迁移，chat.test TC-S1-16 保持全绿）；ChatView 泛化「我/对方」判定——现 author==='general' 为唯一「我」（:24-26/:358-359）→ 保留 general=我，其余 author（含回复方身份）统一「对方」，回复方气泡加 🤖/模型徽标（meta.aiModel）；三态：awaiting（等待中 + 时间戳）、failed（失败提示，提供「重试」= 重新置 awaiting）、replied（正文）；渲染仍纯文本 | 高：零迁移 + 复用现有 chat 通道 + UI 改动集中在 ChatView 身份判定与气泡状态 | 低-中：ChatView ~40 行 + api.ts 无改（回复经同一 postChatMessage/SSE 到达） | 低：老库加载无新列不炸（meta 已在表内 :240）；author 泛化不破坏 TC-S1-07 防冒名（author=by 服务端绑定不变） | **一等** |
| K9-B 消息表加列 role/reply_to/status（IF NOT EXISTS） | 中：查询/索引友好 | 中：迁移列 + DAO 全路径（:603-625）带新列 + 老库断言适配 | 中：偏离「零迁移」风格口径（REQUIREMENTS 明确保留零迁移基线） | 备选：未来做「按回复关系树展示/引用」再落列；v1 meta 足够 |
| K9-C 独立 ai_messages 表 + 前端合并 | 低-中 | 高：双表排序合并/分页复杂 | 高：与既有消息分页（:631-647）割裂 | 排除 |

---

## 11. 决策域 K10（R-4）：回复协议/模型接入层（配合 K8 的执行方）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **K10-A（推荐 v1）守护子代理 = DSH 原生模型通道**：不写任何协议代码；模型选择复用 agent_models（每空间每角色 → provider/model，README §3.7）或 chat_reply_settings.model；凭据/端点由 DSH harness 管理（A-5 默认「本机 DSH 已部署模型」即此通道） | 高：零协议/零 SDK；与现派工同源 | 低 | 低 | **一等**（与 K8-A 配套；无需新增技术） |
| K10-B（备选 v2）OpenAI 兼容 chat/completions HTTP：Node 内置 fetch 直连本机端点（`POST {base}/v1/chat/completions`，JSON {model,messages}），零依赖（OpenAI 兼容接口是本地推理服务事实标准：[公开·待核] https://platform.openai.com/docs/api-reference/chat ；Ollama 兼容层 https://docs.ollama.com/openai ；llama.cpp server https://github.com/ggml-org/llama.cpp ） | 中-高（若走 K8-B） | 中：端点/密钥配置 + 流控 + 错误映射 | 中：依赖将军确认端点形态与密钥策略 | 备选：仅当 G-R4-1 翻转（K8-B）时采用；**不引入 OpenAI SDK 等新依赖**（npm openai MIT，[公开·待核] https://www.npmjs.com/package/openai ——本地无此包，禁网纪律 = blocker） |
| K10-C 引入 ollama-js/llamafile 等 SDK | 低 | — | 新依赖 + 禁网安装 = blocker | 排除 |

---

## 12. 一等选型汇总 → 直接支撑 breaker 拆片

### 12.1 实施拓扑建议（含边界与文件域；breaker 据此给互不重叠文件域）

| 需求 | 推荐切片 | 文件域（互不重叠） | 关键验收锚点 |
| --- | --- | --- | --- |
| R-1 | S1 技能共享后端（listSkills scope:B 语义 + revokeSkill + general 门禁 + include=pending 收口 + 审计目标空间） | team-hub/server.mjs（skills DAO/路由段）+ team-hub/skills.test.mjs | AC-R1-1..7、R1-9（skills.test 全绿） |
| R-1 | S2 技能共享前端（共享视图/来源标识/撤销按钮/授权对象选择） | workbench/src/components/SkillsPanel.tsx + workbench/src/api.ts（skills 段） | AC-R1-8 UI 冒烟 |
| R-1 | S3 守护注入缓存指纹刷新 | plugins/src/index.ts（fetchSkills :436-447 段） | AC-R1-5（plugins typecheck/build 0 诊断） |
| R-2 | S4 规范解析与注入（readNorms 分层 + agent.md 族 + 预算截断 + buildWorkerPrompt 小节） | plugins/src/index.ts（readRepoRules→readNorms :849-862、buildWorkerPrompt :1087-1092 段） | AC-R2-1..5、R2-7 |
| R-2 | S5 全局规范层（rules 表 + /api/rules + 守护 fetchRules） | team-hub/server.mjs（新增表/路由段，与 S1 同文件不同函数域——breaker 须按「行段」划分或先后串行）+ 新增 rules 测试 | AC-R2-6（维护入口+audit） |
| R-2 | S6 规范维护 UI + 职责总纲文档 | workbench（新 RulesPanel 或并入设置）+ README/LEGION.md（职责总纲段） | AC-R2-6 UI |
| R-3 | S7 删除收口与预检（级联 4 表 + /api/spaces/impact + 测试） | team-hub/server.mjs（spaces 删除/impact 路由段）+ 新增 team-hub/spaces.test.mjs | AC-R3-4/5、R3-6 |
| R-3 | S8 前端删除入口（危险区 + type-to-confirm + 切回全部空间） | workbench/src/components/SpaceSettingsModal.tsx + Sidebar.tsx（可选入口）+ App.tsx + api.ts（deleteSpace） | AC-R3-1..3 |
| R-4 | S9 对话数据面（chat_reply_settings + 队列端点 + meta 状态机 + 测试） | team-hub/server.mjs（chat 段）+ team-hub/chat.test.mjs | AC-R4-1..8（契约部分） |
| R-4 | S10 守护 chat-responder（扫单/子代理/回写/失败） | plugins/src/index.ts（新 responder 段，注意与 S3/S4 同文件不同函数域或独立文件拆分） | AC-R4-1/3/4（守护侧冒烟） |
| R-4 | S11 前端 AI 三态与身份泛化 | workbench/src/components/ChatView.tsx | AC-R4-2/7（渲染安全） |

> ⚠️ **同文件域冲突提示（REQUIREMENTS §7 R-7 落地）**：S1/S5/S7/S9 都碰 team-hub/server.mjs、S3/S4/S10 都碰 plugins/src/index.ts——breaker 需把同一文件的不同**函数/路由行段**划给互不重叠切片（skills DAO 段 / rules 表段 / spaces 路由段 / chat 段 / fetchSkills 段 / readNorms 段 / responder 段），或按依赖先后串行（R-2 S4→S5 有注入依赖；R-4 S9→S10 有数据面依赖）。

### 12.2 决策闸门（G-R1..G-R5，请将军裁决；建议默认值即上文一等）

- **G-R1（R-2 全局层载体）**：默认 K3-A（team-hub DB + /api/rules + UI 维护 + audit）；将军若更希望「全局规范 = 一个可 git 管理的 md 文件（放共享目录，配置指向）」→ 翻转 K3-B（audit 口径需同步降级为文件写留痕/引导外部编辑）。
- **G-R2（R-3 删除语义）**：默认 K6-A（chat/calendar/members 随删 + audit 保留 + 无回收站）；将军若要求「可恢复/回收站」→ 启用 K6-C 软删除（涉及全查询过滤与物理清理时机，范围扩大，需重排 P1 内优先级）。
- **G-R3（R-4 开关默认）**：REQUIREMENTS D-13 默认「每消息自动回复 + 每空间开关默认开」。默认采纳；若将军顾虑 token 成本 → 翻转默认关 + 对话输入框显式「请求 AI 回复」按钮（此变体使 AC-R4-1 触发条件改为按钮触发，需 test-designer 同步口径）。
- **G-R4-1（R-4 执行通道）**：默认 K8-A（守护 chat-responder 执行，LLM 直答无工具）；若将军确认存在本机 OpenAI 兼容端点并希望对话闭环不依赖守护在线 → 翻转 K8-B（team-hub 内嵌队列 + K10-B 协议；需提供 baseURL/模型/key 或确认可从 ~/.dsh/settings.yaml 派生——派生方式本身需将军/运维给出凭据读取授权，见 §13 R-4a）。
- **G-R4-2（R-4 回复身份）**：默认回复方身份 = 空间配置 identity（默认 `<scope>-assistant`，区别于 general 与 roster 名防混淆）；将军可选 roster 中某角色（则需确认该角色不派任务、只应答对话，牵涉 D-17 范围）。

### 12.3 与 T-095 D 系列对照（默认值采纳情况）

| D | 采纳 | 落点 |
| --- | --- | --- |
| D-1 引用式共享 / D-3 不做全局隐式共享 / D-4 B 只读含 prompt 全文 / D-5 轮询指纹刷新 / D-6 源空间删→共享消失 | ✅ | K1/K2 |
| D-2 review/grant/revoke general 门禁 | ✅ | K1-A（路由守卫） |
| D-7 全局层机制 | ✅ 本报告落推荐 | K3-A（默认，G-R1） |
| D-8 两层、空间层>全局层、未绑定只吃全局层、锚点=空间绑定仓库根 | ✅ | K4-A/K3 |
| D-9 与既有载体并存 + 职责总纲 | ✅ | K4-A/K5 + S6 职责总纲文档 |
| D-10 删除并入 chat/calendar/members、audit 保留 | ✅（默认） | K6-A（G-R2 可翻软删除） |
| D-11 在办任务允许删但强提示、磁盘残留不回收 | ✅ | K7-A |
| D-12 回复方=LLM 直答 / D-13 默认开（G-R3）/ D-14 空间级模型默认+会话级后置 / D-15 异步落第二条消息 / D-16 空间粒度注入 / D-17 不扩大 exec/托管 | ✅（默认） | K8-A/K9-A/K10-A + 闸门 |

---

## 13. 风险与未知（含备选方案）

- **R-4a（对话回复）出站/凭据边界**：K8-A 由守护经 DSH 通道调模型（既有授权路径），不新增凭据面；若将军翻 G-R4-1 到 K8-B，team-hub 将首次出站并持有端点凭据——密钥管理、端点可达性与「零出站」纪律需将军明示授权与存放方式（备选：维持 K8-A）。
- **R-4b（对话回复）守护离线/无守护空间**：回复方是守护，空间无守护实例或守护重启窗口内 awaiting 无人消费 → 需 server 侧超龄标记（awaiting 超 120s → failed）兜底 + UI 呈现明确失败（AC-R4-4 已要求）；并发重复回复靠状态机 CAS（仅 awaiting→replied）幂等。
- **R-4c（对话回复）token 成本**：D-13 默认开 = 每条用户消息触发一次模型推理；空间默认模型若为旗舰档（README §3.7）成本高。缓解：chat_reply_settings.model 默认轻量档、G-R3 可翻默认关、超时护栏失败不计费。
- **R-4d 防循环/身份**：只对非回复方消息触发；回复方身份 ≠ general 且 ≠ 用户（AC-R4-2）；author 泛化需回归 ChatView 既有会话守卫（R-A5/TC-S3 不回归）。
- **R-1a 草稿泄漏敞口（存量）**：GET /api/skills?include=pending 无鉴权（:1976-1980）。K1-A 已在路由层收口为 general-only（AC-R1-7），与共享功能同批落地（REQUIREMENTS §7 R-1 缓解）。
- **R-2a 提示词膨胀**：分层规范 + 技能 + 角色职责 + 任务上下文叠加（REQUIREMENTS §7 R-6）。K5-A 分层预算 + 职责总纲文档（S6）+ 技能段保持独立是缓解；若将军后续要求技能段也限长需另立预算项。
- **R-3a 误删不可恢复**：K6-A 为硬删（audit 保留可回溯明细，无内容恢复）。UI type-to-confirm + 影响预检 + 在办强提示三重缓解；将军要可恢复 → G-R2 软删除。
- **R-3b 删除与在办 worker**：删除时该空间可能有守护在跑（sweep 循环、worktree w/*）。DB 删除不影响守护进程存活，但其后续扫单对该 scope 无任务（空转）；磁盘 worktree 与分支残留按 D-11 提示由运维 git worktree prune；守护实例是否需要停/重建由运维决策（本需求范围外，UI 提示即可）。
- **R-5（跨切片）文件域重叠**：server.mjs/plugins/src/index.ts 多切片同文件（§12.1 警告）——breaker 严格按行段划分或串行；合入冲突由既有 L3 重叠扫描（README §3.10）兜底。
- **R-6（环境）公开事实待核**：web_search Insufficient Balance（本阶段实测）+ 禁网纪律 → §14.2 [公开·待核] 列表全部留待联网复核；本报告未引用任何未核实量化数字（star/版本/日期）。
- **R-7（维护）职责总纲载体未定**：四类「规范类载体」的职责分工文档放 README 新段 or LEGION.md 附录由 breaker 在 S6 落实，本报告 §16.1 给出建议分工矩阵。

---

## 14. 引用与来源清单

### 14.1 [本地] 可复核（本阶段 read/grep 实测，行号以 w/T-096 HEAD=3c8f27d 为准）

- 技能表/DAO/路由/级联：team-hub/server.mjs:200-216、:469-527、:1748-1786、:1885、:1960-1982
- 守护技能拉取与缓存：plugins/src/index.ts:436-447、:1890-1892；config intervalMs 默认 30000 :92
- 规范读取与注入：plugins/src/index.ts:849-862（readRepoRules）、:1039-1092（buildWorkerPrompt）、:560（repoRootFor）、:530-557（refreshSpaceBinding）
- chat 表/DAO/路由/SSE：team-hub/server.mjs:220-246、:603-625、:631-647、:1788-1804、:1983-1994；MAX_CHAT_BODY=8000 :535；handleWrite/authorized/requireMember :1134-1163
- spaces 与删除：team-hub/server.mjs:105-113（members）、:130-147（spaces）、:1562-1567（/api/scopes）、:1570-1588（/api/spaces）、:1867-1896（delete 7 表）
- agent_models：team-hub/server.mjs:174-183、:1467-1492
- 前端：workbench/src/api.ts:379-398（hubPost/fetchSkills）、:480-501（chat/SSE）；SkillsPanel.tsx:35/:42/:97-105/:178-199/:223-271；ChatView.tsx:24-26/:267-297/:358-359；SpaceSettingsModal.tsx:18-40；Sidebar.tsx:59-60/:111-140；App.tsx:288-302（刷新模式）
- 测试现状：team-hub/skills.test.mjs（grant 组 :89-99）；chat.test.mjs 18 例 / chat-l1-smoke 22 断言（REQUIREMENTS §2.4/§10）
- 模型档位与产品语义：README.md:127-138（§3.7）、:140-147（§3.8 技能中心/安全）；roles.json:14-21（researcher 报告载体）
- 需求基线：docs/REQUIREMENTS.md（T-095）§5/§7/§8/§9/§10

### 14.2 [公开·待核]（web_search Insufficient Balance + 禁网纪律 → 无法在线复核；URL 供联网复核，未引用未核实数字）

| 主题 | 候选 URL（待核） |
| --- | --- |
| 分层记忆/规则文件（全局+项目+就近优先）— Claude Code CLAUDE.md 层级与子目录就近覆盖 | https://docs.anthropic.com/en/docs/claude-code/memory |
| agent.md / AGENTS.md 通用约定（AI 编码智能体读取项目说明文件） | https://agents.md ；https://github.com/openai/codex（仓库内 AGENTS.md 文档） |
| Cursor 全局/项目规则文件 | https://docs.cursor.com/context/rules |
| GitHub Copilot 仓库自定义指令（.github/copilot-instructions.md） | https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot |
| 关系型授权（Zanzibar 论文 / SpiceDB 文档，K1-C 概念参考） | https://research.google/pubs/pub48190/ ；https://authzed.com/docs/spicedb/concepts/relations |
| 危险操作 type-to-confirm（GitHub 删除仓库确认输入仓库名） | https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository |
| OpenAI 兼容 chat/completions 协议（R-4 备选通道） | https://platform.openai.com/docs/api-reference/chat |
| 本机推理服务 OpenAI 兼容层：Ollama | https://docs.ollama.com/openai |
| llama.cpp HTTP server | https://github.com/ggml-org/llama.cpp |
| npm openai SDK（MIT；本报告**未采纳**，禁网不可本地安装） | https://www.npmjs.com/package/openai |
| SQLite JSON1（grants JSON 列）与版权（公共域） | https://www.sqlite.org/json1.html ；https://www.sqlite.org/copyright.html |
| HTTP 缓存/ETag（指纹刷新概念的协议背景） | https://httpwg.org/specs/rfc9110.html#field.etag |
| Server-Sent Events（既有 /api/events 实时通道背景） | https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events |

---

## 15. 本阶段验收对照（researcher 自拟，逐条对应任务验收）

- **AC-1 方案覆盖需求要点，每决策域 ≥2 候选对比（优缺/成本/风险）**：§2-§11 共 10 个决策域（K1-K10），每域 2-4 候选并给适配度/成熟度/许可证/成本/风险/结论列；覆盖 R-1..R-4 全部需求要点（含 AC 断言锚点）。✅
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：一等推荐逐条锚定 [本地] 行号（§1.2/§14.1，本阶段 read/grep 实测，可离线复核）；公开事实因 web_search Insufficient Balance（本阶段复测）标注 [公开·待核] 并给规范 URL（§14.2），未编造任何量化数字/日期。✅
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§16 逐项表（v1 零新增运行时依赖；候选依赖全部列出前置与影响）。✅
- **AC-4 结论可直接支撑后续任务拆解**：§12.1 给出 11 条切片建议（文件域 + 验收锚点 + 同文件冲突警告）、§12.2 五个决策闸门 G-R1..G-R5（建议默认值）、§12.3 D 系列对照；breaker 可直接落「## slices」。✅
- **边界遵守**：本阶段只产出 docs/RESEARCH.md（未改代码/未调 taskctl/未 push/未下载任何依赖）；不确定项列为 §13 风险与备选；历史评论无退回反馈。✅

---

## 16. 新技术/依赖逐项影响（AC-3：许可 · 维护 · 学习成本 · 生态）

> 注：v1 一等路线**零新增运行时依赖**（node:sqlite / node:http / Node fetch / EventSource / React 均已在产线）。下表列「候选/备选增强」逐项标注许可（[公开·待核]）与前置条件，任何一项落地都先本地盘点（禁网纪律 = 缺失即 blocker）。

| 名称 | 许可证（待核） | 维护活跃度 | 学习成本 | 生态/与本项目契合 | 用途与前置 |
| --- | --- | --- | --- | --- | --- |
| （无新增）node:sqlite / node:http / fetch / EventSource | Node.js 平台内置 / WHATWG 标准 | 高（随 Node LTS） | 低 | 已在产线 | v1 全部路线（K1/K2/K5/K6/K9）零新增 |
| （无新增）DSH 守护子代理（K8-A/K10-A） | 内部 harness 通道 | — | 低（复用既有派工机制） | 与 agent_models 模型配置同源 | 回复执行 v1；不引入 npm 包 |
| OpenAI 兼容 HTTP（K10-B，仅 K8-B 翻转时） | 协议无许可；端点服务许可按所选实现（Ollama MIT / llama.cpp MIT，待核） | 见所选实现 | 低（fetch + JSON） | Node fetch 内置，零 SDK | 需将军确认本机端点与密钥策略（G-R4-1） |
| npm openai / ollama-js SDK | MIT（待核） | 高 | 低 | 生态标准但**本地无包** | 排除（禁网安装 = blocker）；需要时将军批准联网 + SPDX 复核 |
| SpiceDB / Zanzibar 引擎（K1-C） | Apache-2.0 / 论文 | 高 | 高 | 关系授权通用方案 | 排除（R-1 规模过度）；仅作概念参考 |
| Ollama / llama.cpp / LM Studio（本机推理服务） | MIT / MIT（逐项待核） | 高 | 中 | 本地模型服务事实标准 | 仅 K8-B 路线需要（且需将军确认已部署形态）；**不默认引入**（A-5 默认 = 复用 DSH 已部署模型） |

### 16.1 职责总纲建议矩阵（R-2 S6 落地内容，供 breaker 抄写）

| 载体 | 承载内容 | 维护入口 | 优先级/覆盖 |
| --- | --- | --- | --- |
| 规范层文件族（LEGION.md/AGENTS.md/agent.md，空间仓库根） | 空间/项目级规则（强制） | 仓库文件/文件中心 | 空间层 > 全局层 |
| 全局规范层（rules 表全局行，K3-A） | 平台级通用规则（强制） | 指挥台「规范」面板（K3-A） | 低于空间层 |
| skills（DB） | 可复用技能/规范片段（按需注入，published 才生效） | 技能中心 | 独立段，与规范段并列 |
| roles.json stage.prompt | 各岗位职责提示词基底 | roles.json | 角色职责段 |
| stage-standards 模板 | 建任务默认验收/边界模板 | scripts（taskctl 侧） | 建任务时 |

---

# 存档附录：历史方案搜索报告（T-074 全文，非当前阶段依据）

> 本附录原样保留上一版 docs/RESEARCH.md（T-074 报告及其存档的 T-044 全文），内容一字未删，仅整体降级为一节置于文件尾部；经 git 亦可回溯（T-074 提交 edaada6）。当前阶段（T-096）以本文档 §0-§16 为准；附录供历史回溯与三中心/平台既有设计的依据引用。

# T-074 方案搜索与选型报告（第二批：三中心收尾 + 平台剩余功能）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜任务：T-074（分支 w/T-074 独立 worktree，HEAD = 72d8ef8 promote T-073）
> 输入：docs/REQUIREMENTS.md（T-073 需求澄清，本批唯一权威需求基线）+ 本仓库本地代码盘点（本报告全部 [本地] 行号均为本阶段 read/grep 实测）
> 下游：breaker（docs/TASK_BREAKDOWN.md，须写「## slices」）→ test-designer → coder → reviewer → tester → devops
> 替换关系：本文档**取代**同文件 T-044 报告成为当前阶段依据；T-044 全文已原样移入文末「存档」附录（内容一字未删，仅标题降级一级），经 git 亦可回溯。
>
> **结论一句话**：本批（三中心收尾 + 平台剩余功能）**不是新架构选型，而是「缺陷修复方案 + 两占位模块选型」**。推荐主线——①缺陷面（R-A1~R-A6）：在既有 serve.mjs / ChatView.tsx 内做**最小单点加固**，全部零新增依赖：F1 = .git 守卫升级为「任一层段 .git 即拒 + realpath 后复检（防符号链接绕入）」；F2 = serve.mjs 顶层整体 try/catch + URIError→4xx（进程绝不死）；A3 = 浏览器抓取审计落**本地 JSONL（静态 ROOT 之外）+ console**（满足「日志链路可查」验收）；A4 = body stall 在 body 读取单一归类点判 timeout（不再冒泡成 web_error/abort）；A5 = ChatView loadOlder/send 写回前做**会话身份守卫**（复用既有 activeRef/cancelled 模式）；A6 = **直接沿用 w/T-051**（BrowserPanel→BrowserView + 错误态 + IME 守卫已实现并有证据，零新依赖）。②平台剩余功能：日程日历 = **自研月视图（CSS grid，仿 FilesView/ChatView 先例）+ team-hub 扩表扩 API（仿 chat S1：表 + REST + handleWrite + SSE）**；通知中心 = **由既有 audit 表派生（单数据源，零新表）+ 本地已读游标 + 既有 Toast 即时提示**。③第三方候选（react-big-calendar / FullCalendar / tui.calendar / react-calendar / react-markdown / DOMPurify / CodeMirror 等）**本批默认全部不引入**：workbench node_modules/.pnpm 本地盘点（130 项）无这些包，落地需 pnpm install（禁网纪律 = blocker），除非将军批准联网安装。

## 0. 结论速览（TL;DR）

| 需求（REQUIREMENTS §5） | 一等（推荐） | 备选 | 排除 |
| --- | --- | --- | --- |
| R-A1/F1 嵌套 .git 防护 | **assertNotGitInternal 任一层段 .git 即拒 + realpath 复检**（serve.mjs 内 ~10 行，9 处调用点不变） | 仅 realpath 全链夹逼 | 白名单/隐藏段禁用（仓库含合法隐藏文件） |
| R-A2/F2 畸形路径防崩溃 | **createServer 顶层 try/catch（整体兜底）+ decodeURIComponent URIError→400** | 安全解码 fallback；预校验正则 | 进程崩溃现状（不可接受） |
| R-A3 web fetch 审计 | **本地 JSONL + console（文件置于静态 ROOT 外，容量轮转）** | 经 hub 转写 team-hub audit（action=web:fetch） | 仅 console 无持久（不满足可查） |
| R-A4 body stall 归类 | **body 读取单一归类点：abort/deadline → code=timeout；错误码枚举常量表收口** | catch 内按 message 匹配 'abort' | 现状（误分类为 web_error/code=undefined） |
| R-A5 ChatView 会话守卫 | **写回前会话身份守卫（activeRef 快照比对，仿既有 cancelled 模式）；纯逻辑抽函数可 node --test** | AbortController 取消在途只读请求（辅助） | 状态按 conv 分桶重构（v1 过重） |
| R-A6 浏览器前端收口 | **沿用 w/T-051 合入**（改名 BrowserView + isErrorResult/errorText + IME 守卫；evidence 齐全） | 在 main 上重做同款收口 | 维持 BrowserPanel 现状（不满足命名/错误态验收） |
| R-B1 日程日历 | **自研月视图 + team-hub 扩表扩 API（仿 chat S1 写纪律）** | react-big-calendar / FullCalendar（需将军批准联网安装） | 云日历 SaaS |
| R-B2 通知中心 | **audit 派生视图（单数据源）+ 本地已读游标 + Toast 即时提示** | 独立 notifications 表（跨端/精确投递时才做） | 纯第三方 toast（无列表/未读语义） |
| R-A7/R-B3 回归 | **既有契约套件扩用例（files-api/web/team-hub/contracts/whiteboard）+ pnpm build + 浏览器手工清单** | 新增 vitest（本地无 → 需安装，不采纳） | 无回归验证（不满足交付判据） |

## 1. 输入、范围与方法

### 1.1 需求输入（T-073 REQUIREMENTS.md，唯一权威基线）

本批待办 = §2.3 待办表 + §5 R-A1..R-C3：
- **Part A 三中心收尾（P0/P1，必做）**：R-A1(F1 嵌套 .git 泄密/P0)、R-A2(F2 畸形路径崩溃/P0)、R-A3(S6 抓取审计留痕零实现/P0)、R-A4(body stall 归类/P1)、R-A5(ChatView 串显/P1)、R-A6(浏览器前端收口/P1)、R-A7(主路径+实时/断线回归锚定/P1)。
- **Part B 平台剩余（P1/P2，待将军确认是否纳入）**：R-B1 日程日历（建议 P1）、R-B2 通知中心（建议 P1）、R-B3 存量回归（P1）、R-B4 双账本收敛（P2）、R-B5 旧文档归档（P2）。
- **Part C 交付与工程（P2）**：R-C1 候选增强 X-1~X-5、R-C2 生产发布、R-C3 构建链路。
- 硬性不变量（§4.2，本批方案不得违反）：I-1 零新增运行时依赖；I-2 仅回环 + 写需 token；I-3 chat 写统一 handleWrite；I-5 渲染安全（无未净化 HTML 直插 DOM）；I-7 SSRF 防护；I-8 实时并入单一 /api/events；I-9 任何请求不得崩溃进程；I-10 文件面不得暴露非顶层 .git 内部。

### 1.2 现状代码证据（本阶段 read/grep 实测锚点，均可复核）

| 证据点 | 位置（当前 main 源码，w/T-074 HEAD=72d8ef8） | 含义 |
| --- | --- | --- |
| F1：assertNotGitInternal 只判首段 .git | workbench/scripts/serve.mjs:208-212（`if (parts[0] === '.git')`）；调用点 274/301/327/339/352/381/390/391/407 覆盖 list/read/download/upload/mkdir/rename/delete 各入口 | 嵌套仓库 subrepo/.git/config 首段非 .git → 绕过（T-062 §5 F1 已实测 200 泄出） |
| F2：顶层 decodeURIComponent 无捕获 | serve.mjs:942-944（createServer 回调内直接 decodeURIComponent(url.pathname)，942-1001 无 try/catch）；:963-968 /api/web/fetch；:969-973 /api/files | 单请求 /api/files%zz → URIError → 进程 exit（T-062 §5 F2 已实测） |
| A3：web fetch 零审计 | serve.mjs:809-821 handleWebApi（:810 isLoopback、:814 webFetch、:816-819 catch code=err.code??'web_error'）；全文件 console 仅 :999 启动横幅（grep 实测）；createWriteStream 仅 :473 上传临时文件 | S6 AC5「审计留痕」零实现（T-057 M1/T-059 M1） |
| A4：body 读取错误归类缺口 | serve.mjs:730-743 readBodyLimited（:735 仅在 await 前查 signal.aborted；await reader.read() 若被 abort reject → 无捕获）；:751-806 webFetch（:765 timer→ac.abort；:770-772 fetch 段 abort→timeout；body 段无同款）；:816-819 兜底 web_error | headers 已回、body stall 超时被归类为 web_error/code=undefined（T-057 M2/T-059 M2） |
| A5：ChatView 异步写回无守卫 | workbench/src/components/ChatView.tsx:160-180 loadOlder（await 后无条件 setMsgs）；:232-256 send（postChatMessage resolve 后无条件 setDraft/setMsgs）；对照：:64-92 activeId effect 与 :95-115 scope effect 已有 cancelled flag；:49-51 activeRef 已存在 | 切会话/空间竞态可串显（T-060 review M1） |
| A6：main 仍是 BrowserPanel | workbench/src/App.tsx:351-356（chat→ChatView、files→FilesView、browser→BrowserPanel）；w/T-051 分支已有 BrowserView.tsx（改名 + errorText 全码映射 :37-52 + isErrorResult :56-62，含 too_many_redirects/web_error；提交 a524951，evidence docs/T051-evidence/） | 收口实现已存在未合入 |
| 占位模块 | workbench/src/components/Sidebar.tsx:21-22（calendar/notify 定义）、:63（notify 计数=inReview）、:78-79（点击仅 toast 占位） | B1/B2 待实现 |
| 实时/审计底座 | team-hub/server.mjs:188 audit 表、:413-415 audit()、:1573-1583 GET /api/activity（scope/taskId/limit）、:1807-1817 /api/events SSE（回放最近 30 条 audit、retry 2000、15s hb）、:1633-1666 /api/chat/* 路由（写走 handleWrite）；api.ts:489-491 subscribeHubAudit（单一 EventSource /api/events 按 action chat:* 过滤） | B2 通知中心可派生复用；chat 写纪律是 B1 数据面模板 |
| 依赖面 | workbench/package.json（dependencies 仅 react/react-dom/three/@react-three/fiber|drei；engines >=22.5）；workbench/node_modules/.pnpm 实测 130 项 = 仅自身依赖闭包 | 任何第三方组件本地均不可得 → 引入需 pnpm install（禁网 = blocker） |
| w/T-051 与 A6 | git diff main...w/T-051：BrowserPanel.tsx→BrowserView.tsx + App.tsx + README×2 + evidence（build/typecheck/web-test 绿） | A6 可直接采纳合入 |

### 1.3 评估维度与引用分级

- 每决策域按「候选 ≥2 / 适配度 / 成本 / 风险 / 迁移量」评估；推荐理由锚定 [本地] 行号（可离线复核）或 [公开·待核] URL。
- 引用分级沿用 T-044 惯例：`[本地]` = 本仓库文件/行号/命令输出；`[公开·待核]` = 公开项目主页/许可证事实。本环境 **web_search 实测 Insufficient Balance（本阶段已复测）** 且仓库纪律禁网，公开事实一律标「待核」并给规范 URL，**不编造 star 数/版本号/日期**。
- 「本地盘点」结论以实际探测为准：workbench/node_modules/.pnpm 目录清单 130 项，逐一按关键字探测 **react-big-calendar / fullcalendar / toast-ui / react-calendar / react-markdown / dompurify / codemirror / readability / turndown / cheerio / hot-toast / vitest / testing-library / tanstack 均不存在**（pwsh Get-ChildItem 实测）。

## 2. 决策域 J1：文件中心 .git 内部防护策略（R-A1/F1）【P0·安全】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J1-A（推荐）任一层段 .git 即拒 + realpath 后复检**：assertNotGitInternal 由 `parts[0]==='.git'` 升级为 `parts.some(p=>p==='.git')`；同时在既有 resolveWithinRoot 的 realpath 结果上对「根相对路径」再跑同判定（防符号链接指向 .git 内部，如 subrepo/link → .git/config） | 高（正中 F1 复现面） | 极低（~10 行，9 处调用点签名不变） | 低：顶层 .git 行为不变（首段仍拦）；嵌套任意层 .git/config、.git/objects 403；submodule/.git 文件（gitdir: 指针）与 git worktree 的实体均在父 .git/modules/worktrees 下 → 含 .git 段被拦；realpath 复检补上「链接绕入」。Windows 大小写不敏感（.GIT）建议比较前 toLowerCase | **一等**：可测试语句直转（嵌套矩阵 + 顶层对照 + 符号链接夹具） |
| J1-B 仅 realpath 全链夹逼（不查 rel 段） | 中-高 | 中（需祖先遍历 + 大小写/别名处理） | 中：能拦链接绕入但依赖 realpath 成功路径；失败路径（不存在文件/坏链接）需另定语义；.git 文件（非目录）场景需额外识别 | 作为 J1-A 的补充而非替代 |
| J1-C 白名单/「禁隐藏段」通用过滤 | 低 | 低 | 仓库内合法隐藏文件（.env 样例/.gitignore 等）会被误伤；不可行 | 排除 |

**设计要点（供 breaker/designer）**：①写路径（upload/mkdir/rename/delete 的 from/to）与读路径同强度（R-A1.3）；②list 的 rel 若含 .git 段（任一层）在守卫升级后应 403——listDirEntries:274 已在入口调用守卫，升级即覆盖 list/read/download/写面同强度；父目录列表对点条目本就隐藏（listDirEntries:277 过滤 `. 前缀条目（含 .git）`，界面不可导航入 .git，已满足「不暴露」呈现），无需额外改动；③回归夹具矩阵进 files-api.test.mjs（现状 34/34 全绿基线）。

## 3. 决策域 J2：畸形 percent-encoding 防进程崩溃（R-A2/F2）【P0·健壮性/DoS】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J2-A（推荐）顶层整体 try/catch + URIError→4xx**：把 createServer 回调（含 :944 decodeURIComponent 与后续路由分发/静态服务）整体包入 try/catch；decode 失败显式捕获 → 400（body 给提示）；其余意外同步异常 → 500 且进程存活。可选把 decode 移入独立函数 safeDecode（try 内 decodeURIComponent，失败返回 null → 400） | 高（正中 DoS 面，且兜底未来一切同步异常，直接落实 I-9） | 低（1 层包裹 + ~8 行） | 低：现有路由行为不变（catch 只拦未捕获）；畸形输入统一 400/404 可测；需防「catch 内再写响应抛错」（复用 :824-829 httpErr 的断连保护） | **一等**：验收直转（/api/files%zz → 400 且进程存活、后续 /api/config 200；注入矩阵；10 并发不崩） |
| J2-B 安全解码 fallback（decode 失败返回原样字符串继续路由） | 中 | 低 | 中：非法字符静默下传，后续 parse/路径 join 可能再抛或语义错乱；治标不治本 | 仅作 J2-A 内部降级细节，不作为独立方案 |
| J2-C 请求行预校验（% 后必须 2 位 hex，非法即拒） | 中 | 中 | 中：重复实现 URL 规范解析易漏（overlong/surrogate/大小写 hex）；新增一处可绕过面 | 否（规范解析交给 URL/decodeURIComponent + 顶层兜底） |

## 4. 决策域 J3：浏览器抓取审计留痕通道（R-A3/S6-AC5）【P0·审计】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J3-A（推荐）serve.mjs 本地结构化日志（JSONL + console）**：每次 /api/web/fetch 完成（成功/失败/拦截都算）append 一行 `{ts, by:'general', url, finalUrl, status, code, ms, bytes?}` 到**静态 ROOT（serve.mjs:26 = workbench/dist）之外**的数据目录（如 <workbench>/data/web-audit.jsonl，.gitignore 追加 data/）+ console 一行；文件按大小上限轮转 | 高（满足验收 R-A3.3「既有 /api/activity **或日志链路**查询到」） | 低（~20 行零依赖；Node 内置 fs appendFile） | 低-中：文件放 ROOT 外避免被静态服务 GET；容量轮转（如 5MB 截断/按天）；hub 不在线也能审计（浏览器面板本就不依赖 hub）；by 默认 general | **一等**：成功与失败（ssrf_blocked/timeout/too_large/http_<n>）皆留痕，验收 1/2/3 全可测 |
| J3-B serve→hub 转写 team-hub audit（新增 action=web:fetch 端点，写走 handleWrite） | 中-高（进 /api/activity + 实时动态流） | 中-高（新 hub 端点 + serve 侧转发 + 跨服务耦合；每次抓取多一次写） | 中：hub 挂则审计丢失/阻塞抓取；SSE 广播会刷「实时动态」；跨文件改动面大 | 备选/增强：若将军要求抓取痕迹进指挥台审计时间线再启用；v1 不做 |
| J3-C 仅 console 无持久 | 低 | 极低 | console 不落盘不可查（浏览器端看不到 serve 控制台），不满足「可查询」 | 排除 |

## 5. 决策域 J4：body stall 超时归类（R-A4/S6-M2）【P1·正确性】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J4-A（推荐）body 读取单一归类点 + 错误码枚举收口**：readBodyLimited 在 `await reader.read()` 外层加 catch——若 `ac.signal.aborted`（含共享 deadline 触发）→ 一律 webErr('timeout')；只有连接层真失败才保持 fetch_error；handleWebApi 兜底 code 保持 err.code ?? 'web_error'；同时把 webErr 的 code 枚举（invalid_url/protocol_blocked/ssrf_blocked/too_many_redirects/timeout/too_large/fetch_error/http_<n>/unsupported/empty_content/web_error）抽为常量表，供后端 emit、前端映射（w/T-051 errorText）、TC-S6 三方对齐 | 高（正中 T-059 M2 复现面） | 低（~10 行 + 常量表） | 低-中：undici abort 传播行为差异 → 用 ac.signal.aborted 状态而非错误 message 判据；顺带修复 w/T-051 前端映射含后端不发出的 dns_error 之类漂移（见 §13 R-13） | **一等**：验收 1/2 直转（注入「headers 已回、body 挂起」本地 http server 夹具 → code='timeout'；整链超时同码） |
| J4-B handleWebApi catch 按 e.message==='abort'/AbortError 判 timeout | 中 | 极低 | message 匹配脆弱（undici/不同 Node 版本文案可变） | 否 |
| J4-C 放弃 AbortController 改 fetch 原生 timeout | 低 | — | Node fetch 无标准超时属性；丢共享 deadline 语义 | 排除 |

## 6. 决策域 J5：ChatView 会话/空间身份守卫（R-A5/S2-M1）【P1·正确性】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J5-A（推荐）异步写回前会话身份守卫**：loadOlder 在 await fetchChatMessages 后、send 在 await postChatMessage 后，回写 setMsgs/setDraft/setLoadingOlder/setSending 前比对「发起时 convId === activeRef.current」；不匹配则仅复位 loading/sending 标志并丢弃合并（消息数据不动）；doCreate 的 setActiveId 后如 scope 已切同样忽略。复用既有 activeRef（ChatView.tsx:49-51）与 cancelled flag 模式（:71-91/:103-113）。建议把判定抽成纯函数/小 hook（如 `isStale(convAtCall, now)`），使核心逻辑可进 node --test（前端无 test runner，R-3） | 高（正中 T-060 M1 复现面） | 低（~15 行 + 纯函数） | 低：不改变数据流/协议；对 send 不可用 AbortController（消息可能已入库，abort 会造成「已发但 UI 未知」）——守卫即可 | **一等**：验收 1/2/3 直转（A/B 会话快速切换、跨空间竞态、主路径回归） |
| J5-B 守卫 + AbortController 取消在途只读请求（loadOlder/messages） | 中 | 中 | 只读取消省流量、防旧响应（守卫已防写回）；POST 不 abort | 可选叠加，非必需 |
| J5-C 状态按 convId 分桶（msgsByConv Map）从结构隔离 | 中 | 高（滚动/分页/实时合并全部按桶重构，测试面大） | 改动大、回归风险高 | v1 不做，v2 再评估 |

## 7. 决策域 J6：浏览器助手前端收口（R-A6/S7）【P1·收口】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J6-A（推荐）沿用 w/T-051 合入**：diff main...w/T-051 = BrowserPanel.tsx→BrowserView.tsx（改名对齐 ChatView/FilesView；errorText 全错误码映射 :37-52；isErrorResult 把 too_many_redirects/web_error/http_*/timeout 等全部归错误态 :56-62）+ App.tsx import 替换 + README×2；提交 a524951 自带 evidence（build/typecheck/web-test 绿，docs/T051-evidence/），零新依赖 | 高（R-A6 四项验收已在分支实现：命名/错误态/IME 守卫/入口一致） | 极低（合入 + 验收复核） | 低：App.tsx 与其他切片文件域重叠风险 → breaker 拆片时 A6 独占 App.tsx 或最先合入；合入后跑 R-A7 回归 | **一等**：验收 1/2/3/4 已在分支证据中覆盖，tester 复核即可 |
| J6-B 在 main 上重做同款收口 | 中 | 中（重复劳动） | w/T-051 已实现且验证，重做浪费且无额外收益 | 仅在 w/T-051 合入受阻时兜底 |
| J6-C 维持 BrowserPanel 现状 | 低 | — | 不满足命名/错误态验收（A6 必做） | 排除 |

## 8. 决策域 J7：日程日历模块（R-B1）【P1·建议纳入，待将军确认】

数据面与视图面分开评估；若将军 OQ-3 裁定不纳入本批，本节作预研存档。

### 8.1 数据面（候选 ≥2）

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J7-A（推荐）team-hub 扩表扩 API（仿 chat S1 模板）**：calendar_events(id, scope, title, start, end?, allDay?, meta JSON, createdAt/updatedAt) + GET/POST /api/calendar/events（scope 分区、分页或按日期窗）+ 写走 handleWrite（by 必填 + audit + SSE，机制复用 server.mjs:1633-1666 chat 路由同构）| 高：与既有数据/写纪律/审计模型完全一致；事件可跨标签实时（SSE）；scope 隔离天然 | 中-低（1 表 + 2 路由 + DAO，全 node:sqlite/内置） | 低：SQLite 串行写压力（日历写入频率远低于 chat，无 R-4 式担忧）；I-3 只约束 chat 写，calendar 写沿用同纪律即可 | **一等**（单库单服务零新依赖） |
| J7-B 事件存空间 local_dir 的 JSON 文件（走 serve.mjs 文件面） | 中 | 低 | 事件文件混入用户仓库内容（污染/误删/证据混淆）；无审计无 SSE；并发写文件需锁 | 否 |
| J7-C localStorage-only | 低 | 极低 | 单浏览器、清缓存即丢、无审计无 scope 共享，与平台其余模块数据语义割裂 | 否 |

### 8.2 视图面（候选 ≥2；[公开·待核] 许可证）

| 候选 | 适配度 | 许可证/维护（待核） | 迁移/学习成本 | 结论 |
| --- | --- | --- | --- | --- |
| **J7-D（推荐）自研月视图**：CSS grid 7×N 周网格 + 弹层创建/删除（复用既有 Toast/Modal/按钮样式），渲染纯文本防注入（I-5）；数据接 J7-A | 高（MVP：创建/查看/删除 + 时间/标题/scope + 月视图，全部可测） | 无新依赖 | 低（~300-500 行，仿 FilesView/ChatView 先例） | **一等**：符合 I-1 零依赖；主题一致；验收 R-B1.1-4 全部可覆盖 |
| J7-E react-big-calendar（MIT，[公开·待核] https://github.com/jquense/react-big-calendar） | 中-高（月/周/日/拖拽/议程齐全） | MIT；维护活跃（待核） | 中-高：日期适配层（date-fns/dayjs）、样式覆写贴近指挥台、包体 | 备选：仅当将军批准联网安装（本地盘点无此包，pnpm install 即 blocker）且需要周/日/拖拽时 |
| J7-F FullCalendar / @fullcalendar/react（MIT 标准版，premium 插件商业，[公开·待核] https://fullcalendar.io / https://github.com/fullcalendar/fullcalendar） | 中-高（功能最强） | MIT(标准)/商业(premium)（待核） | 中-高：React 封装 + 样式/时区/插件树 | 同上备选；premium 授权需将军知悉 |
| J7-G @toast-ui/react-calendar（MIT，[公开·待核] https://github.com/nhn/tui.calendar） | 中 | MIT；TOAST UI 系（维护状态待核） | 中 | 备选同上 |
| J7-H react-calendar（MIT，[公开·待核] https://github.com/wojtekmaj/react-calendar） | 中（纯月历选择组件，非日程管理） | MIT（待核） | 低 | 若只缺「月历选择」小件可参考，不构成日程模块 |
| 云日历（Google Calendar API 等） | 低 | 商业/平台 | 高 | 数据出境/断网不可用，与本地定位冲突；排除 |

## 9. 决策域 J8：通知中心模块（R-B2）【P1·建议纳入，待将军确认】

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **J8-A（推荐）audit 派生视图（单数据源）**：通知面板 = GET /api/activity?scope=…（team-hub:1573-1583，既有）+ SSE /api/events 实时增量（:1807-1817，面板自身订阅，与 ChatView 同模式）；前端按「通知 action 白名单」过滤（任务 claim/transition/advance/review-note/test-report/patch/evidence/artifact、goal:publish、space:*、model:* 等；chat:* 建议默认排除防刷屏，可加开关）；未读数 = audit.seq > 本地已读游标（localStorage per scope）；点击通知 → 跳转任务详情/对应面板；侧栏 badge（Sidebar:63 已有 inReview 计数先例）| 高：R-B2.3「与既有事件流同源、避免第三数据源」字面满足；scope 隔离天然（audit 有 scope）；零新表零新写接口 | 低（前端面板 + 过滤 + 游标，纯展示） | 中：audit 含全动作，需白名单降噪；本地游标跨标签不同步（v1 单浏览器可接受，列文档）；「通知已读」不落 audit（避免已读写刷审计）——用 localStorage | **一等**：验收 1/2/3/4 可测（列出+未读+跳转+与事件流同源）；点击跳转复用任务详情弹窗 |
| J8-B 独立 notifications 表 + /api/notifications + 写走 handleWrite | 中-高（精确 receiver/已读持久/跨端一致） | 中-高（新表 + 路由 + producer 定义「哪些事件转通知」+ 双写一致性） | 新增数据面与 audit 投影重叠；producer 挂点散落 audit() 各调用点（server.mjs:413-415）需逐个决策 | 备选：将军要求跨设备/指定接收人/服务端已读持久时再做；v1 不引入 |
| J8-C 纯第三方 toast 库（react-hot-toast 等，MIT [公开·待核]） | 低 | 低（本地无 → 需安装） | 只有即时浮层，无列表/未读/跳转语义；不构成「通知中心」 | 排除（即时提示沿用既有自研 Toast.tsx，作为 J8-A 的补充） |

## 10. 决策域 J9：回归锚定与存量回归（R-A7 / R-B3）

| 候选 | 适配度 | 成本 | 结论 |
| --- | --- | --- | --- |
| **J9-A（推荐）既有契约套件扩用例 + 构建 + 浏览器清单**：A1/A2/A4 的新用例**追加进既有文件**（workbench/scripts/files-api.test.mjs 现状 34/34、web.test.mjs 12/12 基线，T-062 evidence）；A5 守卫纯函数可入 team-hub 或 workbench scripts 的 node --test（chat.test.mjs 先例）；存量回归 = tests/contract/contracts.test.mjs（56 基线）+ whiteboard node --test（67 基线）+ 前端 pnpm build/tsc + 浏览器主路径手工清单（三中心实时/断线/隔离/渲染安全，见 REQUIREMENTS R-A7 验收 1-3） | 高 | 中-低 | **一等**：R-B3 宿主项（board-plugin 注入 DSH Desktop）不可达时按「环境受限 + 复现步骤」如实记录（REQUIREMENTS R-6/OQ-8） |
| J9-B 新引 vitest/@testing-library 做 React 单测 | 中 | 高（需安装 vitest/jsdom——本地盘点无 → blocker；配置/改造 tsconfig） | 否（沿用既有 R-3 结论：纯逻辑下沉 node --test、UI 走构建 + 浏览器清单） |
| J9-C 仅手工回归 | 低 | 低 | 无自动化证据，不满足仓库「真实验证」纪律 | 否（作为 J9-A 的补充而非替代） |

## 11. 一等选型汇总 → 直接支撑 breaker 拆片的建议

### 11.1 实施拓扑建议（含边界与文件域，breaker 可据此定 slice）

1. **R-A1（F1）+ R-A2（F2）同属 serve.mjs（共用文件）**：建议合成一个 slice 或两个**串行** slice（文件域 = workbench/scripts/serve.mjs + workbench/scripts/files-api.test.mjs），避免同文件并行叠加（REQUIREMENTS R-4/R-5 已预警）。实现=J1-A + J2-A；回归=嵌套 .git 读/写矩阵 + 畸形路径注入矩阵 + 进程存活断言。
2. **R-A3（A3）+ R-A4（A4）同属 serve.mjs webFetch 域**：可与 A1/A2 同 slice 或同文件串行第二 slice（文件域 = serve.mjs + web.test.mjs + 新数据目录 .gitignore）。实现=J3-A + J4-A + 错误码常量表收口。
3. **R-A5（A5）**：文件域 = workbench/src/components/ChatView.tsx（+ 可选新纯函数文件便于 node --test）。实现=J5-A。
4. **R-A6（A6）**：合入 w/T-051（文件域 = workbench/src/components/BrowserView.tsx + App.tsx 1 行 + README）；与其它 slice 的 App.tsx 改动错开（breaker 排序列）。
5. **R-B1（日历）**：若将军纳入：slice 文件域 = team-hub/server.mjs（表+2 路由）+ workbench/src/components/CalendarView.tsx（新）+ App.tsx/Sidebar.tsx（接线）+ 样式；仿 chat S1 的 DAO/audit/SSE 模板。
6. **R-B2（通知）**：若将军纳入：slice 文件域 = workbench/src/components/NotifyView.tsx（新）+ App.tsx/Sidebar.tsx（接线 + badge）+ api.ts（list/游标）；后端零改动（纯派生）。
7. **R-A7/R-B3（回归）**：tester/devops 阶段执行；契约文件扩展随各 coder slice 一起（不单列或单列「回归聚合」）。
8. **Part C / B4 / B5（增强/双账本/归档/发布/环境）**：非技术选型面；按 REQUIREMENTS §6 顺序由 devops/general 处理，breaker 可标注归属不拆 coder slice（X-1~X-5 仅当将军勾选才拆，前置=本地盘点）。

### 11.2 决策闸门（新增 G-8..G-14；建议默认值即上文一等）

- G-8 F1 采用「段级 + realpath 复检」且 list 默认隐藏嵌套 .git 条目（默认✅；否 = 仅段级 / list 显示条目点击 403）
- G-9 F2 采用顶层整体 try/catch + URIError→400（默认✅）
- G-10 web fetch 审计 = 本地 JSONL + console（默认✅；否 = hub audit 转写，需 hub 在线）
- G-11 错误码枚举收口为常量表（默认✅，顺带修前端映射漂移）
- G-12 A6 沿用 w/T-051 合入（默认✅；否 = main 重做）
- G-13 B1/B2 是否本批实现（默认✅=按将军 OQ-3 裁决；若纳入：数据走 J7-A、视图 J7-D、通知 J8-A）
- G-14 第三方日历/通知/markdown 库一律不引入（默认✅；将军批准联网安装才追加，前置=本地盘点）

## 12. 新引入技术/依赖逐项影响（AC-3：许可 · 维护 · 学习成本 · 生态）

> 本批一等路线（R-A1~R-A6 + B1/B2 按推荐实现）**零新增运行时依赖**。下表为「候选外部库」逐项影响；**本地盘点结论：workbench node_modules/.pnpm（130 项）均无以下包**，任何采纳都需 pnpm install（当前禁网纪律下 = blocker，除非将军批准联网或提供离线缓存）。

| 名称 | 许可证（待核） | 维护活跃度 | 学习成本 | 生态/与本项目契合 | 用途与前置（本批状态） |
| --- | --- | --- | --- | --- | --- |
| react-big-calendar | MIT | 高（jquense 系，待核） | 中-高（日期适配层） | React 生态日程组件主流 | R-B1 备选视图；前置=联网安装；**默认不引入** |
| FullCalendar（@fullcalendar/react + core） | MIT(标准)/商业(premium)（待核） | 高 | 中-高（插件树/时区） | 功能最强但 premium 授权需知悉 | 同上备选 |
| @toast-ui/react-calendar | MIT（待核） | 中（维护状态待核） | 中 | TOAST UI 系 | 同上备选 |
| react-calendar | MIT（待核） | 高 | 低 | 纯月历小件 | 仅参考/小件，不构成日程模块 |
| react-hot-toast / notistack / sonner | MIT（待核） | 高 | 低 | 即时浮层 | 既有自研 Toast.tsx 已够；不引入 |
| react-markdown / remark 系 | MIT（待核） | 极高 | 低 | React markdown 事实标准 | X-1 增强（R-C1）；将军勾选 + 联网安装才引入 |
| DOMPurify | MIT 或 MPL-2.0（待核；MPL-2.0 为弱 copyleft 文件级） | 极高 | 低 | 前端净化标准库 | X-4 增强：仅当走「远端 HTML 直接渲染」路径才必需（默认文本/markdown 渲染可避免）；将军勾选 + 联网安装才引入 |
| CodeMirror 6 | MIT（待核） | 高 | 中 | 轻量编辑器 | X-2 文件在线编辑；默认不做 |
| Monaco（@monaco-editor/react） | MIT（待核） | 极高 | 中-高（worker/体积） | 完整 IDE | v2 场景；默认不做 |
| @mozilla/readability / cheerio / Turndown | Apache-2.0 / MIT / MIT（待核） | 高 | 低 | 正文抽取生态 | X-3 正文精抽取（现为零依赖正则版，serve.mjs:700-727）；默认不替换 |
| ws | MIT（待核） | 极高 | 低 | Node WebSocket 标准 | 实时通道仍走 SSE（I-8），不引入 |
| vitest / @testing-library/react | MIT（待核） | 极高 | 中 | 前端测试 | 前端无 test runner 现状（R-3）维持；纯逻辑下沉 node --test |
| Playwright / Puppeteer | Apache-2.0（待核） | 极高 | 中-高 | 浏览器自动化 | 需下载 Chromium 二进制，禁网 blocker；v2 单独立项 |

## 13. 许可证与合规总表

| 项 | 许可证 | 置信度 | 结论 |
| --- | --- | --- | --- |
| node:sqlite / node:http / node:fs / node:test / EventSource | Node.js MIT / 平台标准 | 高（产线在用） | 采纳 |
| React 19 / Vite 7 / three / @react-three/* | MIT（产线已有，workbench/package.json） | 高 | 沿用 |
| 本批一等路线新增 | **无**（全部 Node 内置 + 自研 + 沿用 w/T-051 零新依赖） | 高 | 采纳 |
| react-big-calendar / FullCalendar(标准) / tui.calendar / react-calendar / react-markdown / DOMPurify(择 MIT 分支) / CodeMirror / Monaco / readability / cheerio / Turndown / ws / vitest | MIT / Apache-2.0（逐项[公开·待核]） | 中-高 | 均**默认不引入**；待将军批准联网安装 + 落地前 SPDX 复核（沿用 T-044 §14 R10 待核清单） |
| FullCalendar premium / 云日历 / Jina Reader | 商业/ToS | 高 | 排除（授权/数据出境） |

## 14. 风险与未知（追加 R-11..R-18；与 REQUIREMENTS §7 R-1..R-9 叠加）

- **R-11（w/T-051 合入冲突）**：A6 与其它切片同改 App.tsx/Sidebar.tsx → breaker 拆片时给 A6 独占或排序最先；w/T-051 自带 evidence，合入成本低。
- **R-12（serve.mjs 共用文件域）**：R-A1/A2/A3/A4 全在 serve.mjs（~1000 行单体）→ 拆片须串行或按函数域（守卫层/服务器层/webFetch 域）切分，禁止并行叠加（同 REQUIREMENTS R-4/R-5）。
- **R-13（错误码枚举漂移）**：w/T-051 前端映射含后端未发出的 dns_error；TC-S6 与实现偶有漂移（REQUIREMENTS R-9/OQ-7）→ J4-A 常量表收口时三方对齐，测试以枚举表为准。
- **R-14（嵌套 .git 边界口径）**：符号链接→.git 内部、Windows 大小写（.GIT）、.git 文件（submodule/worktree 指针）、list 是否隐藏条目——两可选项均可测（G-8 默认隐藏）；tester 定口径并在用例矩阵覆盖。
- **R-15（通知噪音/游标）**：audit 全量作源需 action 白名单（chat:* 默认排除）；已读游标 localStorage 跨标签不同步（v1 接受，文档注明；需服务端已读时走 J8-B）。
- **R-16（日历 MVP 扩展成本）**：自研若后续要拖拽/时区/重复事件成本上升 → 切 J7-E/J7-F 备选（需将军批准安装）。
- **R-17（审计文件安全/膨胀）**：JSONL 必须置于静态 ROOT（workbench/dist）之外 + 容量轮转；勿把审计写入可被 GET 的目录。
- **R-18（环境/禁网）**：与 REQUIREMENTS R-1/R-2/R-3/R-6 相同：第三方一律本地盘点、缺失即 blocker；vite build EPERM / worktree 无 node_modules / board-plugin 宿主注入按「环境受限 + 复现步骤」如实记录，不冒充通过。
- **OQ 假设**：本报告按 T-073 §9 默认倾向推进（A 项必做；B1/B2 建议纳入；X-1~X-5 默认不勾选；200-envelope 口径）。若将军对 OQ-1/OQ-3/OQ-7 有不同裁决，受影响面仅 B1/B2 纳入与否与 X 勾选，Part A 方案不受影响。

## 15. 引用与来源清单

### 15.1 [本地] 可复核（本阶段 read/grep 实测，行号以当前 w/T-074 HEAD=72d8ef8 为准）
- workbench/scripts/serve.mjs:26（ROOT=dist）、:69（writeToken）、:208-212（assertNotGitInternal 只判首段 .git）、:274/301/327/339/352/381/390/391/407（守卫调用点）、:473（上传临时文件 createWriteStream）、:700-727（零依赖正文抽取）、:730-743（readBodyLimited abort/too_large）、:751-806（webFetch：协议白名单 :761 / SSRF :763 / manual redirect :769 / 递归跳转 :775-782 / 共享 deadline :756-758）、:809-821（handleWebApi：loopback :810 / catch code=err.code??web_error :816-819）、:824-829（httpErr 断连保护）、:839-846（classifyFilesError）、:942-1001（createServer 顶层 decodeURIComponent :944 无 try/catch）、:963-968（/api/web/fetch 路由）、:969-973（/api/files 路由）、:999（唯一 console=启动横幅）
- workbench/src/components/ChatView.tsx:49-51（activeRef）、:64-92（activeId effect cancelled flag）、:95-115（scope effect cancelled flag）、:118-130（mergeNewest）、:133-151（SSE chat:* 过滤 + 15s 轮询，写回有 activeRef 守卫）、:160-180（loadOlder 无守卫）、:232-256（send 无守卫）、:315-320（纯文本渲染）
- workbench/src/components/Sidebar.tsx:21-22/63/78-79（calendar/notify 占位 + notify 计数先例）
- workbench/src/App.tsx:348-359（chat/files/browser 面板分支，browser 仍是 BrowserPanel）
- workbench/src/components/BrowserView.tsx（w/T-051 分支）:37-52（errorText 全码映射）、:56-62（isErrorResult 错误态收口）——与 main 的 diff：git diff main...w/T-051
- team-hub/server.mjs:37/45/64-66（node:sqlite DatabaseSync + WAL + busy_timeout + DB_FILE）、:188（audit 表）、:413-415（audit()）、:1573-1583（GET /api/activity）、:1633-1666（/api/chat/* 路由：写走 handleWrite）、:1807-1817（/api/events SSE：回放 30 条 + retry 2000 + 15s hb）
- workbench/src/api.ts:489-491（subscribeHubAudit 单一 /api/events）
- workbench/package.json（deps = react/react-dom/three/@react-three/*；engines >=22.5）；workbench/node_modules/.pnpm 130 项清单（pwsh 实测，无日历/markdown/editor/通知类包）
- w/T-051 提交 a524951 + docs/T051-evidence/（build/typecheck/web-test）；REQUIREMENTS.md 附录 C（T-073 复核，同 HEAD 断言 F1/F2/A3/接线/占位仍在源码）
- 基线套件计数（历史证据引用，非本阶段运行）：files-api.test.mjs 34/34、web.test.mjs 12/12（docs/T062-evidence/）；chat.test.mjs、skills.test.mjs（team-hub）；contracts.test.mjs 56（tests/contract/README.md）；whiteboard node --test（whiteboard/docs/DEPLOY.md 零第三方依赖先例）

### 15.2 [公开·待核]（web_search 实测 Insufficient Balance + 禁网纪律 → 无法在线复核；本报告不引用未核实数字/日期）
- Node.js node:sqlite / 内置模块：https://nodejs.org/api/sqlite.html
- Server-Sent Events（EventSource）：https://html.spec.whatwg.org/multipage/server-sent-events.html ／ https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- react-big-calendar（MIT）：https://github.com/jquense/react-big-calendar
- FullCalendar（标准 MIT / premium 商业）：https://fullcalendar.io ／ https://github.com/fullcalendar/fullcalendar
- @toast-ui/react-calendar / tui.calendar（MIT）：https://github.com/nhn/tui.calendar
- react-calendar（MIT）：https://github.com/wojtekmaj/react-calendar
- react-markdown（MIT）：https://github.com/remarkjs/react-markdown
- DOMPurify（MIT/MPL-2.0）：https://github.com/cure53/DOMPurify
- CodeMirror 6（MIT）：https://codemirror.net ／ Monaco（MIT）：https://microsoft.github.io/monaco-editor/
- @mozilla/readability（Apache-2.0）：https://github.com/mozilla/readability ／ cheerio（MIT）：https://github.com/cheeriojs/cheerio ／ Turndown（MIT）：https://github.com/mixmark-io/turndown
- ws（MIT）：https://github.com/websockets/ws
- vitest / @testing-library/react（MIT）：https://vitest.dev ／ https://testing-library.com
- Playwright（Apache-2.0）：https://playwright.dev ／ Puppeteer（Apache-2.0）：https://pptr.dev

## 16. 本阶段验收对照（researcher 自拟，逐条对应任务验收）

- **AC-1 方案覆盖需求要点且每决策域 ≥2 候选对比（优缺/成本/风险）**：§2-§10 共 9 决策域（J1-J9），每域 2-6 候选并给适配度/成本/风险与优缺点结论，覆盖 R-A1..R-A7、R-B1/R-B2、R-A7/R-B3 全部需求要点；B4/B5/C 类过程项在 §11.1 标注归属。✅
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：每个一等推荐锚定 [本地] 行号（§1.2/§15.1，本阶段 read/grep 实测可离线复核）；公开事实因 web_search 实测 Insufficient Balance + 禁网，标 [公开·待核] 并给规范 URL（§15.2），未编造任何数字。✅
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§12 逐项表（含本地盘点实证：.pnpm 130 项无候选包）+ §13 合规总表 + §14 R-11..R-18。✅
- **AC-4 结论可直接支撑后续任务拆解**：§11.1 按 slice 边界给文件域/串并行建议 + §11.2 决策闸门 G-8..G-14；breaker 可直接产出「## slices」。✅
- **边界遵守**：只产出本文档；未改任何实现代码、未调 taskctl、未 push、未下载依赖；「不确定项」全部列为风险/备选/OQ 假设（§14）。✅
- **真实验证记录**：本阶段无运行代码（文档阶段），验证 = ①全部 [本地] 行号经 read/grep 实测（serve.mjs/ChatView/Sidebar/App/api.ts/team-hub/workbench package.json 等）；②本地盘点经 pwsh Get-ChildItem 实测（node_modules/.pnpm 130 项、候选库全缺、w/T-051 差异 diff main...w/T-051 实测）；③web_search 复测 Insufficient Balance。见 §1.2/§15.1。

---

## 存档附录：T-044 报告全文（已执行完毕的历史选型，非当前阶段依据）

> 以下为 T-044「三中心从零建造」阶段的方案搜索全文（按仓库「续写/覆盖 + 取代声明」惯例原样保留，仅标题降级一级，内容未删改）。当前阶段（T-074）以本文档 §0-§16 为准；T-044 供历史回溯与三中心既有设计的依据引用。

## T-044 方案搜索与选型报告：交付剩余 Legion 指挥团任务（对话中心 · 文件中心 · 浏览器助手）

> 角色：researcher（方案搜索）｜阶段：方案搜索｜执行任务：T-044（分支 w/T-044 独立 worktree）
> 输入：T-036 需求澄清（evidence 全文，经 `GET http://127.0.0.1:8787/api/task?id=T-036` 只读读取）+ 本仓库本地代码盘点（见 §1.2 行号证据表）
> 下游：breaker（docs/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
>
> **结论一句话**：三个占位中心全部走「**零新运行时依赖自研 + 复用既有层**」主线——① 对话中心 = team-hub v2 扩表扩 API（conversations/messages，node:sqlite 已有）+ 复用 `/api/events` SSE 推送 + 指挥台自研 React 会话面板；② 文件中心 = 扩展现有 `/api/fs`（仅回环 + git 仓库探测，已有）为 `/api/files` 文件面 + 自研目录树/文件表 + 轻量文本预览；③ 浏览器助手 v1 = 服务端 fetch 代理 + 正文抽取（零二进制，SSRF 必须防护），v2 再评估无头浏览器（Playwright/Puppeteer，受禁网安装限制）；④ 导航接线 = App.tsx 按 `active` 挂面板 + `React.lazy`（仿 SkillsPanel / Scene3D 既有先例）。所有第三方组件一律「先本地盘点可用再采纳，缺失即 blocker，不联网下载」。

### 0. 结论速览（TL;DR）

| 域 | 一等（推荐） | 备选 | 排除 |
| --- | --- | --- | --- |
| 对话中心·后端 | **team-hub 扩表扩 API**（conversations/messages + REST + 复用 /api/events SSE + 统一 handleWrite/审计） | 独立消息微服务（ws/Socket.IO） | Rocket.Chat / Zulip / Mattermost / Matrix(Synapse)；Stream/Sendbird 云 |
| 对话中心·实时 | **复用 SSE**（EventSource 自动重连已有先例） | WebSocket（引入 `ws`） | 长轮询为主通道；第三方推送云 |
| 对话中心·前端 | **自研 ChatView**（与指挥台主题一致） | chatscope/chat-ui-kit-react | stream-chat-react（绑其后端）；iframe 嵌聊天服务器 |
| 文件中心·后端 | **扩展 workbench `/api/fs` → `/api/files`**（仅回环 + token 写 + 目录根=空间 local_dir/仓库根） | filebrowser sidecar；DSH fs 工具面代理 | Nextcloud/Seafile/云盘（WebDAV/S3） |
| 文件中心·前端 | **自研树/表 + 文本预览**（v1 `<pre>`，需编辑时 CodeMirror 6） | Monaco Editor（@monaco-editor/react） | 整套网盘式 UI |
| 浏览器助手·引擎 | **v1 服务端 fetch 代理 + 正文抽取**（readability/cheerio；SSRF 防护） | v2 Playwright / Puppeteer sidecar；Jina Reader 云（开关默认关） | browser-use 等 Python 框架；无头浏览器进 v1（禁网装不了浏览器二进制） |
| 浏览器助手·前端 | **自研阅读面板**（地址栏 + markdown 预览；抓回 HTML 需 DOMPurify） | sandbox iframe 受限预览 | 直接把远程页 iframe 进主应用（X-Frame-Options/CSP 普遍禁嵌） |
| 导航接线 | **App.tsx 按 `active` 渲染面板 + React.lazy 分 chunk** | react-router 引入 | 每模块独立 HTML 页 |

### 1. 输入、范围与方法

#### 1.1 上游结论（T-036 需求盘点，requirement evidence 要点）

1. **现状盘点**：scrum v1（:4820 遗留）/ team-hub v2（:8787 SQLite 任务池）/ workbench 军团指挥台（:5173 React）/ board-plugin / whiteboard（零依赖 CRDT 白板，测试/ADR 齐）/ mesh+workflows。
2. **目标点名项现状**（占位区）：
   - **对话中心(chat)缺失**：仅 Sidebar 模块项，点击 toast「后续步骤接入」，全仓无聊天 UI/后端；
   - **文件中心(files)缺失**：Sidebar + QuickTools「DSH 文件工具」均未接线；
   - **浏览器助手(browser)有极雏形**：QuickTools→openKanban() 只跳经典看板，非真浏览。
3. **P0/P1/P2 清单**：P0-1 三中心需求澄清（已完成）；P0-2 对话中心=会话/消息存储与 API + 前端视图；P0-3 文件中心=文件浏览/上传/存储 + 真实 DSH 文件工具面接线；P0-4 浏览器助手=真网页抓取/浏览能力；P1-5 workbench 导航接线（files/browser/chat/calendar/notify 占位改真实路由）；P1-6 双账本收敛（v1/v2 写源统一）；P1-7 存量验收（whiteboard 起服联调、board-plugin 注入宿主验证）；P2-8 旧流水线文档归档。
4. 蓝图参考：scrum/sidebar-mockup.html（聊天区 + 看板侧栏面板的视觉效果，非实现约束）。

#### 1.2 盘点方法：本地代码行号证据（均可复核）

| 证据点 | 位置（本地可核） | 含义 |
| --- | --- | --- |
| 侧栏 9 模块含 files/browser/chat/calendar/notify | workbench/src/components/Sidebar.tsx:13-21 | 目标点名项 = 侧栏占位模块 |
| 占位点击行为（tasks→openKanban，其余 toast「后续步骤接入」） | Sidebar.tsx:66-77（70/74/77） | 对话/文件/浏览器点不动是「导航未接线」 |
| 面板渲染仅 skills 有真实现 | workbench/src/App.tsx:346-350 | 新面板挂在 App 同款分支即可 |
| 懒加载先例（Scene3D = lazy） | workbench/src/components/CenterPanel.tsx:8 | 大模块按需分 chunk 的先例 |
| 快捷工具 DSH_TOOLS（files/browser/ocr/voice）占位 | workbench/src/components/QuickTools.tsx | 仅 browser→openKanban()，其余 toast |
| 已有目录浏览 /api/fs（仅回环 403）与 /hub 代理 | workbench/scripts/serve.mjs:8-10, 48, 135, 139-148, 163-166 | 文件中心可直接扩展同款端点 |
| 客户端 SSE 订阅（EventSource 自动重连）+ /api/fs 客户端 | workbench/src/api.ts:107, 119-120, 222-235 | 对话实时推送复用同款通道模式 |
| team-hub = node:sqlite DatabaseSync + WAL + busy_timeout | team-hub/server.mjs:35, 62-64 | 后端存储/并发前提 |
| 现成表结构 tasks/members/roster/spaces/goal/exec_*/agent_models | server.mjs:66-173 | conversations/messages 沿用同构建表 + JSON 列约定 |
| SSE 事件流 /api/events（text/event-stream） | server.mjs:1291-1302 | 聊天事件推送挂同通道 |
| 工作台技术栈与 Node 版本要求 | workbench/package.json（react19/vite7/three；engines >=22.5） | 新增依赖须与之兼容 |
| 零第三方运行时依赖先例 | whiteboard/docs/DEPLOY.md:9（Node≥22.5 内置 node:sqlite） | 「零依赖自研」路线在本环境已验证可行 |

#### 1.3 评估维度与引用分级

- 每决策域按「适配度 / 成熟度 / 许可证 / 维护活跃度 / 迁移成本」评估。
- **引用分级**：`[本地]` = 本仓库文件行号，可离线复核（上表）；`[公开·待核]` = 公开项目主页/许可证，因本环境禁网且 web_search 工具不可用（实测报 Insufficient Balance），按既有知识定性并显式标注「待核」，**不编造 star/版本号/日期**。落地前（coder/devops 或将军）按 §14 待核清单复核。

### 2. 需求要点 → 决策域映射

| 需求要点（T-036） | 决策域 | 关键取舍点 |
| --- | --- | --- |
| 对话中心：会话/消息存储与 API + 前端视图 | A（存储/API）/ B（实时）/ C（UI） | 数据放哪、推送通道、UI 自研还是组件库 |
| 文件中心：浏览/上传/存储 + 真实文件工具面接线 | D（后端访问面）/ E（前端） | 端点位置、写权限、目录根语义、预览/编辑能力 |
| 浏览器助手：真网页抓取/浏览 | F（引擎）/ G（呈现） | 无头浏览器 vs 轻量抓取、SSRF 防护、JS 渲染边界 |
| P1-5 导航接线（5 个占位） | H（导航/模块化） | 面板挂接方式、懒加载、v1 覆盖范围 |
| 依赖纪律（禁网，缺失即 blocker） | 横切 | 默认零新依赖；外部库先本地盘点 |

### 3. 决策域 A：对话中心 —— 存储与 API

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **A1（推荐）team-hub v2 扩表扩 API**：conversations/messages + REST（GET/POST `/api/chat/*`）+ 统一 handleWrite/审计 + 复用 /api/events | 高 | 极高（产线已有） | 无新增（node:sqlite 属 Node 运行时） | 极低 | 优：单库单服务零新依赖；scope 分区与 by 审计模型现成（tasks 同构，server.mjs:66-173）；消息可与任务/evidence 关联（AI 执行过程写回）；运维/迁移成本最低。缺：聊天与任务写共享 SQLite（DatabaseSync 串行写，busy_timeout=5000）；高并发聊天需节制——v1 局域网多将军单机场景完全够用，风险低 |
| A2 独立消息服务（Node + 自有存储 + ws） | 中 | 高 | 引入 ws(MIT) | 中-高 | 优：隔离、可独立扩、协议自由。缺：重复基建（成员/空间/任务数据跨服务联查）、双服务运维、破坏「轻量单体」现状；无独立价值 |
| A3 整机聊天平台（Rocket.Chat MIT / Zulip Apache-2.0 / Mattermost / Matrix-Synapse） | 低 | 极高 | MIT/Apache-2.0（逐项待核） | 高 | 优：频道/私信/富文本/移动端全套。缺：独立服务 + 独立认证体系，与 team-hub 任务/编队数据、审计 SSE、scope 语义完全不融合；v1 明显过度，维护面爆炸 |
| A4 云聊天 SaaS（Stream/Sendbird 等） | 低 | 高 | 商业 | 高 | 数据出境 + 订阅成本 + 断网不可用，与本项目「本地自托管」定位冲突；排除 |

**建议 v1 数据形态（供 breaker，非实现）：** conversations(id, scope, title, kind∈{space,direct,task}, participants JSON, created/updated, last_message_at) + messages(id, conv_id, scope, author, kind∈{text,markdown,system}, body, meta JSON, clientTs, createdAt)，JSON-in-TEXT 列与现有表同构；`POST /api/chat/messages` 走统一 handleWrite（by 必填 → 审计 + SSE 广播，机制复用 server.mjs 现状）。

### 4. 决策域 B：对话中心 —— 实时通道

| 候选 | 适配度 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **B1 复用 Server-Sent Events（推荐）** | 高 | 零新增：EventSource 浏览器原生（[公开] WHATWG 标准，待核），服务端 text/event-stream 已实现（server.mjs:1291-1302），客户端订阅先例在 api.ts:119-120 | 低。注意 HTTP/1.1 每源连接上限约 6 条：v1 已用 board/activity 两条事件源，建议把 chat 事件并入单一 `/api/events` 流按 kind 过滤，或走 `/hub` 同源合并，避免连接数撞顶 | **一等**：单向下行天然够聊天推送；消息上行走 REST POST（与现状一致）；EventSource 自动重连免费获得 |
| B2 WebSocket（引入 `ws` MIT） | 中 | 新增依赖 `ws`；Node 内置无 ws server（服务端需手写 upgrade 或引库） | 低-中：双向低延迟，但引入新依赖 + 新连接管理代码 | 备选：若未来需要在线状态/输入中/强双向交互再切 |
| B3 轮询兜底 | 低 | 零 | 延迟 3-15s，聊天体感差 | 仅作 SSE 断线兜底（workbench 已有 15s board 轮询先例） |

### 5. 决策域 C：对话中心 —— 前端 UI

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **C1 自研轻量 ChatView（推荐）**：会话列 + 消息气泡 + 输入框 + 分页加载 | 高 | 无新依赖 | 低 | 与指挥台暗色/3D 风格完全一致；交互参照 DSH Web GUI 的 ui-conversation 范式（[本地] packages/client/ui-conversation 存在可参考，非复用代码）；消息渲染 markdown 可选 react-markdown(MIT，待核) |
| C2 chatscope/chat-ui-kit-react | 中 | MIT（待核），维护中 | 中 | 现成气泡/输入/引用组件省时间，但样式主题需大量覆写以贴近指挥台；纯 UI 不绑后端，可作备选 |
| C3 stream-chat-react | 低 | SDK MIT（待核），核心能力绑定其后端 | 高 | 后端/定价耦合；排除 |
| C4 iframe 嵌现成聊天页 | 低 | 绑定 A3 | 高 | 与 A3 同排除 |

### 6. 决策域 D：文件中心 —— 后端文件访问面

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **D1（推荐）扩展 `/api/fs` → `/api/files`**（workbench serve.mjs，与 /hub 代理同源）：list(类型/大小/mtime/.git 标记)、read(文本截断+行数)、write/rename/mkdir/delete、上传(PUT raw body)、下载；目录根 = 当前空间 local_dir（未绑定回退显式配置根/仓库根）；沿用「仅回环可访问 + token 写」边界（serve.mjs:135 已有 403 先例） | 高 | 极高（目录浏览/git 探测已在产线，serve.mjs:139-148） | 无新增（node:fs/path/http 内置） | 低 | 优：零依赖；文件=空间绑定的真实仓库目录（任务证据/文档就在其中），语义自洽；只读默认、写操作要 token + 仅回环，攻击面小。缺：上传 multipart 需手写解析——用「fetch PUT raw bytes」规避（免 busboy/multer）；大文件需限尺寸与流式落盘 |
| D2 filebrowser sidecar（Apache-2.0，待核） | 中 | 高 | Apache-2.0 | 中-高 | 优：现成网盘式管理（分享/搜索/编辑器/用户）。缺：Go 二进制整机 + 独立用户/权限模型 + 新端口进程托管（services-plugin 需扩展）；面向家目录而非「当前空间 git 仓库根」语义；v1 重 |
| D3 DSH harness 文件工具面代理（把 DSH 的 fs 能力封装为 HTTP） | 中 | 高（宿主内） | 随 DSH | 高 | 优：复用沙箱语义。缺：DSH 文件工具是 agent 沙箱接口，浏览器直连需鉴权/路径策略 + 依赖 Desktop 插件运行时在线；定位 v2 深度接线；QuickTools「DSH 文件工具」卡片可先由 D1 目录浏览器充当真实能力面（即「接线」） |
| D4 云盘/WebDAV/S3 | 低 | 高 | 平台侧 | 中 | 不在「本地仓库目录」语义内；v2 另议 |

### 7. 决策域 E：文件中心 —— 前端浏览/预览/编辑

| 候选 | 适配度 | 许可证/维护 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- |
| **E1（推荐）自研目录树 + 文件表 + 文本预览**：导航/样式复用 FolderPickerModal 的既有交互（[本地] workbench/src/components/FolderPickerModal.tsx / api.ts:222-235）；v1 预览用受控 `<pre>`（防 XSS：textContent 渲染），按扩展名出图标/行数 | 高 | 无新依赖 | 低 | 覆盖「浏览/定位/下载/上传」核心诉求；对仓库内文本查看够用 |
| E2 CodeMirror 6（MIT，待核） | 中-高 | MIT，活跃 | 中 | 轻量（相对 Monaco），懒加载分 chunk 后可做「文本查看 + 简易编辑」；若 v1 就要编辑则推荐（先本地盘点依赖） |
| E3 Monaco Editor / @monaco-editor/react（MIT，待核） | 中 | MIT，微软维护 | 中-高 | 完整 IDE 体验，但包体大 + worker 配置复杂（与现有 Vite 构建要专门处理）；v2「在指挥台内写代码/改配置」再引入 |
| E4 react-arborist 等现成树组件（MIT，待核） | 中 | 中 | 中 | 可选小件；树不复杂时自研更贴合现有样式 |

### 8. 决策域 F：浏览器助手 —— 抓取引擎

**语义**：将军在指挥台内「喂 URL → 看页面内容/快照」，替代 QuickTools「跳看板」占位；未来演进为可操作浏览。

| 候选 | 适配度 | 成熟度/维护 | 许可证 | 迁移成本 | 优点 / 缺点与风险 |
| --- | --- | --- | --- | --- | --- |
| **F1（推荐 v1）服务端 fetch 代理 + 正文抽取**：workbench serve.mjs（或 team-hub）加 `POST /api/web/fetch`（url 入参）；Node 内置 fetch(undici) 拉取 → 抽取：纯 HTML→标题/文本/链接摘要（零依赖）；正文精抽取用 @mozilla/readability(Apache-2.0，待核) 或 cheerio(MIT，待核)；可选 Turndown(MIT，待核) 转 Markdown | 高（v1 阅读场景） | 高 | 零二进制新依赖 | 低 | 优：轻、快、无需浏览器二进制（禁网环境唯一可行）；响应限长/超时/Content-Type 白名单可控。缺：**不能执行 JS**——SPA/反爬/需登录页拿不到正文（v2 无头浏览器补）；**服务端外呼=SSRF 高危**：必须禁私有网段/回环/内网、URL 协议白名单 http/https、重定向链校验、限大小超时、审计日志（本地已有 loopback-only 先例 serve.mjs:48,135 可扩展为「仅允许显式外网」策略） |
| F2 v2 无头浏览器 sidecar：Playwright（Apache-2.0）/ Puppeteer（Apache-2.0，均待核） | 中-高（未来） | 极高 | Apache-2.0 | 高 | 优：完整渲染/截图/DOM 操作，才是「浏览器助手」完全体。缺：需下载 Chromium（约 120-300MB，**禁网环境无法安装 → 实施时本地盘点即 blocker，不擅自下载**）；进程管理/内存开销；远控浏览器攻击面大；v1 不做 |
| F3 云阅读服务（Jina AI Reader r.jina.ai 等） | 中 | 服务可用性依赖第三方 | 商业 ToS | 低 | 内容经第三方、隐私/合规不可控、断网不可用；仅作「显式开关、默认关」选项 |
| F4 window.open / iframe 直嵌目标站 | 低 | — | — | 低 | 非通用方案：X-Frame-Options/CSP 普遍禁嵌，跨域不可读；保留 openKanban 新窗口作为「打开内部看板」快捷入口，不算浏览能力本体 |

### 9. 决策域 G：浏览器助手 —— 前端呈现

| 候选 | 适配度 | 结论 |
| --- | --- | --- |
| **G1 自研阅读面板（推荐）**：地址栏 + 请求态 + 结果视图。结果若为 Markdown → react-markdown(MIT) 渲染；若直接渲染抓回 HTML → 必须先 DOMPurify(MIT/MPL-2.0，待核) 净化（防存储型 XSS——抓取内容不可信） | 高 | 一等：默认把抓回内容转 Markdown/文本渲染，**避免把远端 HTML 直接落 DOM**，从根上收窄注入面 |
| G2 sandbox iframe 受限预览 | 中 | 辅助：对同意被嵌的站（X-Frame-Options 放行）用 sandbox 属性只读预览 |
| G3 DSH Web GUI 自身浏览器 | 低 | 宿主浏览器能力面（tab/窗口）与 workbench 集成属另一主题，v2 评估 |

### 10. 决策域 H：导航接线与模块化（横切 P1-5）

| 候选 | 适配度 | 迁移成本 | 结论 |
| --- | --- | --- | --- |
| **H1（推荐）App.tsx 按 `active` 渲染面板**：仿既有 skills 分支（App.tsx:346-350）为 chat/files/browser 各挂懒加载面板（React.lazy 仿 Scene3D，CenterPanel.tsx:8 先例）；Sidebar.clickModule 把这 3 个 id 从 toast 分支移入 onNavigate 分支（Sidebar.tsx:66-77）；「任务中心」维持 openKanban 外部经典看板页；calendar/notify 维持 toast（P1 后续再接线） | 高 | 低 | 一等：改动集中在 App/Sidebar 两个文件；无路由库依赖；三个面板各自独立 chunk，首屏体积不涨 |
| H2 引入 react-router | 中 | 中 | 备选：模块到两位数/需要 URL 深链（如 `#/chat/conv/1` 可分享）时再引入；当前 state 切换够用，避免过度工程 |
| H3 每模块独立 HTML 入口 | 低 | 高 | 与 SPA + 弹窗 + 独立看板页现状割裂；否 |

### 11. 一等选型汇总 → 直接支撑任务拆解的 v1 建议

#### 11.1 实施拓扑建议（供 breaker 取舍，含边界）

1. **对话中心 v1**：team-hub 新增 conversations/messages 表 + `/api/chat/conversations|messages`（scope/分页/审计）→ 复用 /api/events 推 chat 事件 → workbench 侧 ChatView（会话列/气泡/发送/markdown 可选）+ Sidebar/App 接线。不做：富文本/文件附件/已读回执/多端同步（v2）。
2. **文件中心 v1**：serve.mjs 扩 `/api/files`（list/read/download/upload-PUT + 受限写操作，仅回环 + token）→ 目录根=当前空间 local_dir/仓库根 → workbench FilesView（树+表+预览）→ QuickTools「文件浏览」卡与侧栏 files 接线。不做：跨机器访问、权限系统、版本历史（git 已天然有）、在线编辑（v1 预览只读）。
3. **浏览器助手 v1**：`/api/web/fetch` 代理（SSRF 防护：协议白名单 + 私网阻断 + 限长超时 + 审计）→ 正文抽取（先零依赖正则版，可后挂 readability/cheerio）→ BrowserView 阅读面板（结果以文本/markdown 呈现，HTML 必须净化）→ QuickTools「打开浏览器」卡拆为「打开内部看板」与「浏览网页」两个入口。不做：JS 渲染页、登录态、点击/表单操作（v2 无头浏览器）。
4. **导航接线**：按 H1；calendar/notify 仍占位。
5. **依赖纪律**：以上 v1 全部零新依赖；若采纳 E2/react-markdown/readability 等，coder 首步先本地盘点（node_modules/pnpm store/仓库缓存），缺失即 blocker，不下载（§14 风险 R1）。

#### 11.2 决策闸门（G-1..G-7，请将军裁决；建议默认值即上文一等）

- G-1 对话数据入 team-hub 单库（默认✅，否=A2 独立服务）
- G-2 实时通道 = 复用 SSE（默认✅，否=ws 新依赖）
- G-3 对话 UI 自研（默认✅，否=chat-ui-kit-react）
- G-4 文件端点放 workbench serve.mjs（默认✅，否=team-hub 或 filebrowser sidecar）；写默认只读+token
- G-5 浏览器引擎 = v1 fetch+抽取 / v2 无头（默认✅）；JS 渲染/登录页明示为 v1 边界
- G-6 导航 v1 范围 = chat/files/browser 三模块（默认✅；calendar/notify 仍占位）
- G-7 新依赖引入策略 = 先本地盘点、缺失即 blocker（默认✅，全 v1 路线零新依赖即自动满足）

### 12. 新技术 / 依赖逐项影响（许可 · 维护 · 学习成本 · 生态）

> 注：v1 一等路线**零新运行时依赖**（node:sqlite / node:http / node:fs / EventSource / 自研 React 均已在产线）。下表列的是「可选增强 / v2」候选，逐项标注影响与前置条件。

| 名称 | 许可证（待核） | 维护活跃度 | 学习成本 | 生态/与本项目契合 | 用途与前置 |
| --- | --- | --- | --- | --- | --- |
| @mozilla/readability | Apache-2.0 | 高（Mozilla 维护，社区活跃） | 低（单函数 read()） | Node 可跑；主流正文抽取事实标准 | 浏览器助手正文抽取（v1 增强）；前置=本地可安装 |
| cheerio | MIT | 高（长期活跃） | 低 | Node 生态最普及的 HTML 解析 | 结构化抓取/链接提取备选 |
| Turndown | MIT | 中（成熟少动） | 低 | 常用 HTML→Markdown | 抽取结果转 Markdown 的可选项 |
| DOMPurify | MIT 或 MPL-2.0 双许可 | 极高 | 低 | 前端净化标准库 | 抓回/用户 HTML 渲染前的必需净化（若走 HTML 渲染路径） |
| react-markdown | MIT | 高（remark 生态活跃） | 低 | React 生态标准 markdown 渲染 | 聊天/网页摘要 markdown 渲染（可选项） |
| CodeMirror 6 | MIT | 高 | 中（API 与现代编辑器不同） | 轻量、无 worker 包袱 | 文件中心在线查看/编辑（v2 或 v1 增强） |
| Monaco Editor（@monaco-editor/react） | MIT | 极高（微软） | 中（体积与 worker 配置是主要成本） | VSCode 同源，能力最强 | 「在指挥台写代码」场景（v2） |
| chatscope/chat-ui-kit-react | MIT | 中 | 中 | 纯 UI 组件 | 对话 UI 备选（不绑后端） |
| ws | MIT | 极高 | 低 | Node WebSocket 事实标准 | 若 G-2 翻转选 ws 通道 |
| filebrowser | Apache-2.0 | 高 | 低（整机服务） | Go 生态 | 文件中心 sidecar 备选（v2） |
| Playwright / Puppeteer | Apache-2.0 | 极高 | 中-高（浏览器自动化心智） | 浏览器自动化事实标准 | 浏览器助手 v2 无头引擎；**前置=可下载 Chromium，禁网环境大概率 blocker** |
| Jina AI Reader | 商业 ToS | 服务 | 极低 | 云依赖 | 开关默认关的云兜底 |
| Rocket.Chat / Zulip / Mattermost / Matrix | MIT / Apache-2.0（逐项待核） | 高 | 高（整机运维） | 独立社区/认证生态 | 排除（数据模型与本地定位不融合） |

### 13. 许可证与合规总表

| 项 | 许可证 | 置信度 | 结论 |
| --- | --- | --- | --- |
| node:sqlite / node:http / node:fs / EventSource | Node.js MIT / 平台标准 | 高 | 采纳（已在产线） |
| React / react-dom / Vite / TS / three / @react-three/fiber / drei | MIT（Vite 亦 MIT） | 高 | 已在用，采纳 |
| @mozilla/readability / cheerio / Turndown / react-markdown / CodeMirror / Monaco / ws / filebrowser / Playwright / Puppeteer | 见 §12 | 中-高 | 待核后按需采纳（全部非 copyleft 类） |
| DOMPurify | MIT 或 MPL-2.0 双许可 | 中 | 待核（MPL-2.0 为弱 copyleft，文件级） |
| chatscope chat-ui-kit-react / stream-chat-react | MIT（后者的核心后端为商业） | 中 | 前者可采纳，后者排除 |
| Rocket.Chat / Zulip / Mattermost / Matrix-Synapse | MIT / Apache-2.0 等 | 中 | 排除（过度） |
| Jina Reader 等云服务 | 商业 ToS | 高 | 默认关闭选项 |

风险提示：DOMPurify 双许可含 MPL-2.0 需按文件级合规评估（若采纳选 Apache-2.0 分支即可）；Playwright/Puppeteer 引入的是浏览器二进制下载而非纯 npm 依赖，禁网环境下先盘点再决定。

### 14. 风险与未知（含备选方案）

- **R1（环境）禁网/禁下载**：外部库一律先本地盘点，缺失列为 blocker 不擅自安装（与 LEGION.md 纪律、白板先例一致）。v1 一等路线零新依赖即为此设计。备选：任何外部库不可得时用「零依赖自研等价物」降级（正则抽取、`<pre>` 预览等）。
- **R2（浏览器助手）SSRF**：服务端 fetch 代理是 SSRF 高危点——协议白名单 + 私有网段/回环/链路本地阻断 + 重定向链校验 + 响应限长与超时 + 操作审计 + 默认不开（显式按钮触发）。参考已有 loopback-only 边界实现（serve.mjs:48,135）。
- **R3（浏览器助手）JS 渲染页不可抓**：v1 明确边界（SPA/反爬/登录页只返回提示），v2 无头浏览器补；备选 = Jina Reader 云开关（默认关，隐私自负）。
- **R4（对话中心）SQLite 写竞争**：chat 高频写与任务写共享 DatabaseSync 串行写；单机场景够用，压力上限需 breaker/test-designer 量化（如 ≤100 msg/min 冒烟 + P95 写延迟断言）；备选 = 独立消息库/表分文件。
- **R5（实时）HTTP/1.1 连接数**：事件源建议并流（单一 /api/events 按 kind 过滤）防撞约 6 连接/源上限。
- **R6（文件中心）越权与误删**：写默认只读 + token + 仅回环 + 路径规范化（禁越出目录根，禁符号链接逃逸）；删除/覆盖需二次确认。
- **R7（抓回内容注入）**：远端内容不可信——默认转文本/markdown 渲染；HTML 渲染路径必须 DOMPurify（§9 G1）。
- **R8（双账本 P1-6 / 存量验收 P1-7 / 归档 P2-8）**：属 devops/tester/requirement 后续任务，本报告仅标注依赖与顺序（文件中心建在 workbench serve.mjs 上时注意与 team-hub 双写源纪律一致——v1 只写 team-hub 或只写 v1，避免再引入第三写源）。
- **R9（SaaS/重平台诱惑）**：云聊天/云文件/整机聊天或网盘产品均因「数据本地、认证隔离、模型不融合、运维重」排除；若未来将军要「公网多用户」，再单独立项评估（含认证/安全专题）。
- **R10（待核清单，联网后复核）**：§12/§13 各许可证 SPDX 复核（readability/cheerio/Turndown/DOMPurify/CodeMirror/Monaco/chatscope/filebrowser/Playwright/Puppeteer/Rocket.Chat/Zulip/Mattermost/Matrix）；node:sqlite 在 Node 24 的稳定性级别；各库最近 release 与维护活跃度量化。

### 15. 引用与来源清单

#### 15.1 [本地] 可复核（本仓库文件/接口，行号见 §1.2 证据表）
- workbench/src/components/Sidebar.tsx:13-21,66-77（占位模块与点击行为）
- workbench/src/components/QuickTools.tsx（DSH_TOOLS 占位卡，仅 browser→openKanban）
- workbench/src/App.tsx:346-350（模块面板渲染分支）；CenterPanel.tsx:8（lazy 先例）
- workbench/scripts/serve.mjs:8-10,48,135,139-148,163-166（/api/fs 与 /hub 代理，仅回环边界）
- workbench/src/api.ts:107,119-120,222-235（SSE 订阅与 /api/fs 客户端）
- team-hub/server.mjs:35,62-64,66-173,1291-1302（node:sqlite/WAL、表结构、/api/events SSE）
- workbench/package.json（React19/Vite7/three；engines ≥22.5）；whiteboard/docs/DEPLOY.md:9（零第三方运行时依赖先例）
- T-036 需求盘点 evidence：`GET http://127.0.0.1:8787/api/task?id=T-036`（只读）

#### 15.2 [公开·待核]（禁网不可实时抓取，URL 供联网复核；本报告未引用未核实数字）
- SQLite 公共域声明：https://www.sqlite.org/copyright.html
- Node.js 内置 SQLite（node:sqlite）：https://nodejs.org/api/sqlite.html
- Server-Sent Events：https://html.spec.whatwg.org/multipage/server-sent-events.html（MDN: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events）
- @mozilla/readability（Apache-2.0）：https://github.com/mozilla/readability
- cheerio（MIT）：https://cheerio.js.org ／ https://github.com/cheeriojs/cheerio
- Turndown（MIT）：https://github.com/mixmark-io/turndown
- DOMPurify（MIT/MPL-2.0）：https://github.com/cure53/DOMPurify
- react-markdown（MIT）：https://github.com/remarkjs/react-markdown
- CodeMirror（MIT）：https://codemirror.net ／ Monaco Editor（MIT）：https://microsoft.github.io/monaco-editor/
- chatscope chat-ui-kit-react（MIT）：https://github.com/chatscope/chat-ui-kit-react
- ws（MIT）：https://github.com/websockets/ws
- filebrowser（Apache-2.0）：https://filebrowser.org ／ https://github.com/filebrowser/filebrowser
- Playwright（Apache-2.0）：https://playwright.dev ／ Puppeteer（Apache-2.0）：https://pptr.dev
- Jina AI Reader：https://jina.ai/reader
- Rocket.Chat（MIT）：https://rocket.chat ／ Zulip（Apache-2.0）：https://zulip.com ／ Mattermost：https://mattermost.com ／ Matrix/Synapse（Apache-2.0）：https://matrix.org

### 16. 本阶段验收标准（researcher 自拟，因任务 acceptance 留空）

- **AC-1 方案覆盖需求要点且每决策域 ≥2 候选对比（优缺/成本/风险）**：§3-§10 共 8 个决策域，每域 2-4 候选并给适配度/成熟度/许可/迁移成本与优缺点风险列。✅ 本文档 §3-§10。
- **AC-2 有明确推荐与理由，依据真实可查来源并注明引用**：推荐逐条锚定 [本地] 行号证据（§1.2/§15.1，可离线复核）；公开事实因本环境禁网（web_search 实测 Insufficient Balance）标注 [公开·待核] 并给规范 URL（§15.2），未编造任何数字。✅ §1.3/§15。
- **AC-3 新引入技术/依赖逐项说明影响（许可/维护/学习/生态）**：§12 逐项表 + §13 合规总表 + §14 R10 待核清单。✅
- **AC-4 结论可直接支撑后续任务拆解**：§11 给出 v1 实施拓扑（三中心 + 导航 + 依赖纪律）、边界（不做什么）、决策闸门 G-1..G-7 与建议默认值；breaker 可据此拆 S 系列子任务。✅
- **边界遵守**：本阶段只产出本文件，无代码改动、未调 taskctl、未 push、未下载任何依赖；「不确定项列为风险与备选」见 §14（R1-R10）。✅