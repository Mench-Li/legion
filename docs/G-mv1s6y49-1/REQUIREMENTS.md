<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-10**（commit `272e23a7`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-195 需求说明：给 Agent 起人性化（且体现功能属性）的名字 + 赋予人性化头像

> 阶段：需求澄清（requirement）｜任务：T-195（[auto-goal]，所属目标 G-mv1s6y49-1 · software · chain）
> 上游 goal 原句（将军）：**我需要给我的Agent起人性化（但是能体现其功能属性的名字），并且赋予人性化头像**
> 本目标文档目录：docs/G-mv1s6y49-1/（本文即该目录 REQUIREMENTS.md；不写/不碰仓库根 docs/ 槽位与其他目标目录下的同名阶段文档）
> 下游：T-196 researcher（RESEARCH.md）→ T-197 breaker（TASK_BREAKDOWN.md）→ T-198 test-designer（TEST_CASES.md）→ T-199 coder → T-200 reviewer → T-201 tester（TEST_REPORT.md）→ T-202 devops（DEPLOY.md）
> 评估基准：w/T-195 HEAD 58172b9c（2026-10-10）；本文 file:line 均指本 worktree 内容

## 0. 文档状态与阅读说明

- 三类标注（全文统一）：
  - ✅ **已确认口径**：由源码 / 测试 / 设计文档钉死，下游可直接依据；
  - ⚖️ **待将军裁决（D-*）**：影响范围/语义/优先级的关键分歧；裁决前按「倾向 + 默认值」推进，**默认值是假设不是结论**（§8）；
  - ❓ **开放问题（O-*）**：默认取值已写明，供将军补充输入（§8）。
- **本阶段只产出本文档**：不做技术选型与实现细节（头像载体、文件格式、生成算法、存储与迁移、前端组件改造方式 → 交 T-196 researcher 与后续阶段）、不写代码、不改仓库实现、不调用 taskctl / 看板写接口、不 push。
- 所有「验收口径」写成**可测语句**（断言 / 命令 / 判据），供 breaker 切分、test-designer 直转用例、将军对照验收。
- **归属边界**：本目标 = 展示层（名称与头像）改造。与身份模型、任务归属、流水线契约的交互只做「不破坏」约束，不改其语义（§5.2）。

## 1. 目标解读：将军诉求 → 可验收语义

| 原句片段 | 澄清后语义 | 现状定性（证据见 §2） | 对应需求 |
| --- | --- | --- | --- |
| 「**给我的 Agent**」 | 「我的 Agent」= Legion 指挥台（workbench）**编队成员**，即 team-hub roster 中以 (scope, role) 唯一标识的智能体：5 个空间 25 个岗位 + 将军自建成员；**不含** DSH 子代理角色名、**不含**外部执行者伪成员 | roster 表 (scope, role, name, kind, avatar, sort)，team-hub/server.mjs:1328；读出口 team-hub/routes/team-views.mjs:73-117 | 对象边界 ⚖️D-3 |
| 「**起人性化（但是能体现其功能属性的名字）**」 | 展示名要是**对人的称呼**（有可辨识个体感），同时能读出岗位职能；不是机器键、不是纯职称清单、不是编号 | 现状 25 个 name **全是职能职称**（team-hub/scripts/seed-roster.mjs:19-55）：满足「体现功能属性」，但不像对人的称呼，且跨空间同 role 完全同名 = 岗位名而非成员名 | R-1、R-2、R-5 |
| 「**并且赋予人性化头像**」 | 每个成员有**人形 / 拟人视觉形象**，稳定、可区分、在列表与头部等展示面可辨；不是纯符号 emoji、不是名称首字、不是几何色块 | 现状 avatar 是**单个 emoji 字符**（缺省 '🤖'），以文本 font-size 渲染；0 个岗位是人形形象，且无图片通道 | R-3、R-4、R-9、R-11 |
| （隐含）「**我的**」= 我要能决定 | 两种读法：A 产品默认就给我人性化的名与头像；B 给我自己起名/换头像的入口 | 后端 POST /api/agents 已支持 name/avatar upsert（team-hub/routes/agent-intake.mjs:82-86），但界面只有「新建智能体」没有「编辑成员」 | ⚖️D-1 → R-6、R-7 |

## 2. 现状盘点（✅ 证据锚定）

### 2.1 数据面：成员名称与头像是什么、从哪来

- **roster 表**：字段 scope/role/name/kind/avatar/sort。avatar 是 **TEXT**，缺省 **'🤖'**（team-hub/server.mjs:1328）。name = 展示名，kind = 职能副标题，role = 岗位机器键。
- **写入口 1**：POST /api/agents（team-hub/routes/agent-intake.mjs:82-86）按 (scope, role) upsert name/kind/avatar，avatar 缺省 '🤖'；:153-163 从全局目录按 role 复制 name/kind/avatar 入编。
- **写入口 2**：种子脚本 team-hub/scripts/seed-roster.mjs —— 幂等 upsert，且**会覆盖** name/kind/avatar/sort（seed-roster.mjs:66-69）。
- **注册表**：agent_registry 复制 roster 的 name/avatar，ON CONFLICT(scope, role) 只更新 name/avatar（team-hub/agent-conversations.mjs:61-64）。
- **读出口**：GET /api/roster（team-views.mjs:73-114，缺省头像 '🤖'、外部执行者 '⚙️'）；GET /api/agents（team-hub/routes/read-models.mjs:221-224 **按 role 跨空间合并、首见名胜**）；3D 场景投影（workbench/src/scene/sceneState.ts:61-77）。

### 2.2 现状名称与头像清单（25 个岗位，来源 seed-roster.mjs:19-55）

| 空间 | role | 现展示名 | 现头像 | 判定 |
| --- | --- | --- | --- | --- |
| software | requirement | 需求分析师 | 🧭 | 职称，非人形 |
| software | researcher | 方案研究员 | 🔍 | 职称，非人形 |
| software | breaker | 任务拆解师 | ✂️ | 职称，非人形 |
| software | test-designer | 测试设计师 | 🧪 | 职称，非人形 |
| software | coder | 编码工程师 | 💻 | 职称，非人形 |
| software | reviewer | 代码审查员 | 🔎 | 职称，非人形 |
| software | tester | 测试执行员 | 🧹 | 职称，非人形 |
| software | devops | 部署运维员 | 🚀 | 职称，非人形 |
| marketing | market-analyst | 市场分析师 | 📊 | 职称，非人形 |
| marketing | content-planner | 内容策划 | ✍️ | 职称，非人形 |
| marketing | ad-optimizer | 投放优化师 | 🎯 | 职称，非人形 |
| marketing | growth-hacker | 用户增长 | 📈 | 职称，非人形 |
| marketing | brand-copy | 品牌文案 | 💬 | 职称，非人形 |
| product | product-manager | 产品经理 | 🧩 | 职称，非人形 |
| product | ux-designer | 交互设计师 | 🖌️ | 职称，非人形 |
| product | ui-designer | 视觉设计师 | 🎨 | 职称，非人形 |
| product | user-researcher | 用户研究员 | 🔬 | 职称，非人形 |
| product | data-analyst | 数据分析师 | 📐 | 职称，非人形 |
| ops | ops-specialist | 运营专员 | 🗂️ | 职称，非人形 |
| ops | campaign-planner | 活动策划 | 🎪 | 职称，非人形 |
| ops | support-lead | 客服主管 | 🎧 | 职称，非人形 |
| ops | data-ops | 数据运营 | 📉 | 职称，非人形 |
| default | assistant | 通用助理 | 🤖 | 职称，非人形 |
| default | research-assistant | 调研助手 | 🔦 | 职称，非人形 |
| default | writer | 文字编辑 | ✒️ | 职称，非人形 |

> 结论：名称 **25/25 非空且体现职能**（✅ 满足「功能属性」），但 **25/25 是职称而非对人的称呼**，且跨空间同 role 一律同名（❌ 「人性化」的个体感不足，性质上是**岗位名**而不是**成员名**）。头像 **25/25 是符号/物件 emoji，0 个人形**（❌ 未满足「人性化头像」）。

### 2.3 渲染面清单（现状：3 套互不一致的来源 + 首字回退）

| # | 展示面 | 位置 | 现状 |
| --- | --- | --- | --- |
| S1 | 人员目录列表行 | workbench/src/components/WorkspaceNavigation.tsx:62 | 头像取**名称首字**（workspace.css 的 .directory-avatar 37px 圆形文本徽章）❌ 与 avatar 无关 |
| S2 | Agent 工作区头部 | workbench/src/components/AgentWorkspace.tsx:111 | 目录头像 = agent.name.slice(0, 1)，**不用 avatar** ❌ |
| S3 | 中心面板 Agent 卡 | workbench/src/components/CenterPanel.tsx:216、:236 | 文本 emoji |
| S4 | 中心面板 v1 兜底 | CenterPanel.tsx:21、:49 | 8 个**动物** emoji 轮换（第三套来源）❌ |
| S5 | 服务端兜底 | team-hub/routes/team-views.mjs:84、:117 | roster 缺失给 '🤖'；外部执行者给 '⚙️' |
| S6 | 3D 场景员工标签 | workbench/src/components/Employee3D.tsx:123-126 | 显示名称，不显示头像 |
| S7 | 3D 场景人物外观 | Employee3D.tsx:50 + sceneState.ts:49-53、:75 | 由 identitySeed(scope\0role) 决定调色板，**与 avatar 无关** ⚖️O-3 |
| S8 | 场景 Agent 列表 | workbench/src/components/SceneAgentList.tsx:15 | 文本 emoji |
| S9 | 新建空间选人 / 新建智能体 | workbench/src/components/NewSpaceModal.tsx:12、:28、:182、:197 | 25 个 emoji 下拉（AVATAR_CHOICES）+ 缺省 '🤖' |
| S10 | 模型设置成员行 | workbench/src/components/ModelConfigModal.tsx:122 | 文本 emoji |
| S11 | 技能授权成员名 | workbench/src/components/SkillsPanel.tsx:318、:767、:786 | 拼成「avatar + 空格 + name」纯文本 |
| S12 | 任务弹窗成员 | workbench/src/components/AgentTasksModal.tsx:95 | 文本 emoji |
| S13 | 移动端 | workbench/mobile/app.mjs:404 | 只有 「name（role）」，**无头像** |

> 全部头像均以**文本字符**渲染：.agent-avatar 是 32×32 文本徽章、font-size 14px（workbench/src/index.css:708-718）；.ao-avatar font-size 14px（index.css:2548）；.scene-agent-avatar font-size 12px（index.css:845）。**没有图片/矢量渲染通道**。

### 2.4 设计与纪律约束（✅ 不可违背，非假设）

- **身份红线**：docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:81 —— 「名字、头像、模型和规则是**可变化属性，不能用来生成身份**」；:79 唯一约束 (scope, rosterKey)；:83 多实例未启用前禁止「先复制两个头像，再继续用 role 归属」。
- **界面规范**：docs/superpowers/specs/2026-10-02-legion-interface-design.md:93（每行含头像 + 名称 + 副标题）、:111（顶部显示头像与名称）、:140（「**头像使用图片或名称首字**」——设计已预留图片形态；列表行 56–64px、图标点击区 ≥40px）。
- **仓库纪律**：禁止联网下载依赖（LEGION.md）→ 头像与名称能力须**离线自足**（R-8）。
- **role 是契约键**：任务路由 / 文件域 / 流水线阶段均按 role（roles.json:5-66、team-views.mjs:113）；改名**不得**动 role。

### 2.5 缺口判定

- **G1** ❌ 名称不够「人性化」：25 个是职称集合，无个体感；跨空间同 role 同名（岗位名，非成员名）。
- **G2** ❌ 无「人性化头像」：0 个岗位有人形形象；avatar 字段是**单字符文本**。
- **G3** ❌ 展示不一致：3 套来源（roster.avatar / CenterPanel 动物兜底 / team-views '🤖'+'⚙️'）+ 名称首字回退，同一成员在不同面可能显示不同视觉。
- **G4** ❌ 无成员编辑入口：只能新建时设定，之后无法在界面改名/换头像（后端 upsert 已支持）。
- **G5** ⚠️ 无迁移保护：seed-roster 重跑会覆盖 name/avatar（seed-roster.mjs:68）。

## 3. 术语表（本文档唯一口径，下游不得另作解释）

| 术语 | 定义 | 明确不指 |
| --- | --- | --- |
| Agent（成员） | team-hub roster 中以 (scope, role) 唯一标识的编队智能体 | DSH 子代理角色名、外部执行者伪成员（team-views.mjs:117） |
| 展示名 name | 面向人阅读的成员称呼，可变 | role 机器键、agentId |
| 职能副标题 kind | 一句话职能说明（如「需求澄清与拆解」，seed-roster.mjs:21） | 展示名、模型/provider |
| 岗位键 role | 契约字段（requirement/coder…），**不可改** | 展示名 |
| 成员身份 agentId / rosterKey | 持久身份，键为 (scope, rosterKey)，**不随 name/avatar 变化** | name / avatar |
| 头像 avatar | 成员的人形视觉形象（图片 / 矢量 / 程序化人形） | 装饰图标、状态点、空间讨论图标 |
| 人性化（名称） | 读起来像**对人的称呼**（人名/昵称/拟人称呼），有可辨识个体感 | 纯职称、机器键、编号 |
| 体现功能属性 | 仅看展示名 + 紧邻的 kind 可推断该成员职能 | 名字里必须出现岗位全称 |
| 人性化头像 | 呈现**人形/拟人面貌（脸或身）**的视觉形象 | 纯符号 emoji、名称首字、几何色块、动物 emoji |
| 展示面 | §2.3 列出的 S1–S13 共 13 个界面位置 | 数据模型内部字段 |
| 回退 | 头像资源不可用时显示的占位（名称首字或占位人形） | 默认头像来源 |

## 4. 需求清单（编号 + 优先级 + 背景/目标/验收口径）

优先级：**P0** 本目标验收门槛；**P1** 应做；**P2** 可延后（须在验收时显式说明）。

### R-1 [P0] 每个成员有一个「人性化展示名」
- **背景**：现状 25 个名称全是职能职称（§2.2），能体现功能属性但不像对人的称呼。
- **目标**：全部在编成员拥有 2–6 个汉字的类人称呼，且名称或紧邻的 kind 可读出职能。
- **验收口径**：
  - **AC-R1-1 覆盖**：对每个空间调 GET /api/roster，返回的每个成员 name 非空、去首尾空白后长度 2–6 个汉字（或等长可读称呼），且不含 role 机器键字符集（a-z0-9-_）。
  - **AC-R1-2 人性化（人工判据）**：随机抽 5 个名称，≥4 个被独立评审判定「像对人的称呼」（非职称直述、非编号）。
  - **AC-R1-3 功能可读**：抽检 10 个成员，仅凭 name + kind 能正确匹配回 role，错误 0。
  - **AC-R1-4 将军确认**：最终 25 人名单经将军确认（O-1），确认记录落在本目标文档目录或任务评论。

### R-2 [P0] 名称唯一性与身份稳定
- **背景**：同空间重名则目录/联系人无法区分；身份红线要求 name 不得参与身份。
- **目标**：同空间成员展示名唯一；改名不影响身份、会话与任务归属。
- **验收口径**：
  - **AC-R2-1 唯一**：断言 SELECT scope, name, COUNT(*) FROM roster GROUP BY scope, name HAVING COUNT(*) > 1 为空（比较前做大小写与首尾空白归一）。
  - **AC-R2-2 身份不变**：对某 role 用 POST /api/agents 改名后，agent_registry 中该 (scope, role) 的 agent_id 不变，历史会话与任务归属不变（agent-conversations.mjs:63 的 ON CONFLICT 只更新 name/avatar）。
  - **AC-R2-3 无身份派生**：检索断言不存在以 name 或 avatar 作为身份键/唯一约束/前端 key 的用法（现有 key = scope + role，sceneState.ts:69）。

### R-3 [P0] 每个成员有一个「人性化头像」
- **背景**：现状 avatar 是单字符 emoji，0 个人形（§2.2）。
- **目标**：每个成员有一个稳定、可区分、可辨识的人形/拟人视觉形象。
- **验收口径**：
  - **AC-R3-1 形态**：每个成员（25 岗位 + 自建）在 roster 有一个非空头像引用，解析后渲染为**图形图像或矢量人形**（img/svg/canvas 节点），而**不是单个 Unicode 字符文本节点**。
  - **AC-R3-2 人形可辨**：32px 尺寸人工抽检 ≥5 个，≥4 个被评审判定「能看出是人形/人脸」。
  - **AC-R3-3 可区分**：同一空间内任意两名成员头像不同；25 个岗位头像两两不同，不得共用同一默认图。
  - **AC-R3-4 稳定**：同一 (scope, role) 多次刷新/重进，头像不变（确定性，无随机漂移）。

### R-4 [P0] 全部展示面一致（消除 3 套来源与首字回退）
- **背景**：§2.3 有 3 套来源 + 首字回退，同一成员在不同面视觉不一致。
- **目标**：同一成员在 S1–S6、S8–S12 显示同一展示名与同一头像。
- **验收口径**：
  - **AC-R4-1 单一来源**：S1–S12 全部读取 roster 的 name/avatar（或其接口投影）；代码检索不存在硬编码兜底头像表（CenterPanel.tsx:21 AVATARS）与名称首字头像（AgentWorkspace.tsx:111）被当作成员头像使用。
  - **AC-R4-2 逐面一致**：对同一成员，抓取 S1/S2/S3/S8/S10/S11/S12 渲染出的名称与头像标识，两两相等。
  - **AC-R4-3 无破图**：13 个展示面 × 5 空间 × 25 成员遍历，无破图、无裸露 alt 文本、无未加载占位。
  - **AC-R4-4 回退面计数 = 0**：旧的三套来源全部移除或收敛为同一实现。

### R-5 [P1] 跨空间同 role 的名称与头像一致
- **背景**：GET /api/agents 按 role 跨空间合并、**首见名胜**（read-models.mjs:221-224）；若各空间同 role 名称/头像不同，全局目录会随 SQL 排序漂移，展示不稳定。
- **目标**：同一 role 在 5 个空间的展示名与头像一致；若将军选择允许不同，则全局目录必须显式按空间区分展示——二选一，不得沉默。
- **验收口径**：
  - **AC-R5-1 默认口径（一致）**：SELECT role, COUNT(DISTINCT name), COUNT(DISTINCT avatar) FROM roster GROUP BY role，各计数恒为 1。
  - **AC-R5-2 若改选「允许不同」**：/api/agents 不得再做首见合并，须返回 role + scope 维度且前端逐条展示空间（本项待 ⚖️D-3 裁决后修订）。

### R-6 [P1，依赖 ⚖️D-1] 成员编辑入口与持久化
- **背景**：后端 upsert 已支持 name/kind/avatar（agent-intake.mjs:82-86），但界面只有「新建智能体」（NewSpaceModal.tsx:191-202），无「编辑成员」。
- **目标**：将军可在界面为已有成员改名/换头像，保存后各展示面即时一致。
- **验收口径**：
  - **AC-R6-1 入口存在**：成员菜单/设置里有「编辑资料」，含名称输入与头像选择；无权限时给出明确原因（遵循 interface-design:89 的口径）。
  - **AC-R6-2 保存生效**：改名/换头像后刷新，S1–S12 同步更新，旧值不再出现。
  - **AC-R6-3 校验**：空名、超长、同空间重名、非法头像引用被拒并给出可读错误；被拒时数据库不变。
  - **AC-R6-4 鉴权不变**：写操作沿用现有令牌/身份校验，不新增绕过路径。

### R-7 [P1] 默认开箱即用 + 新建不再默认 '🤖'
- **背景**：新建智能体缺省 avatar '🤖'（NewSpaceModal.tsx:28、agent-intake.mjs:86）；种子的 25 个值形态不合格（§2.2）。
- **目标**：安装即得人性化名 + 头像；新建成员默认分配一个未被占用的名称与头像。
- **验收口径**：
  - **AC-R7-1 冷启动**：空库执行种子后，5 空间 25 岗位 100% 具备符合 R-1/R-3 的 name/avatar；断言 COUNT(name IS NULL OR name = '') = 0 且 COUNT(avatar = '🤖') = 0。
  - **AC-R7-2 新建**：新建成员不填头像时得到人形头像且不与同空间他人重复；不填名字时被拒绝（不允许空名）。
  - **AC-R7-3 幂等**：连续执行种子两次，结果集与第一次相同（无重复、不抖动）。

### R-8 [P1] 离线自足、零新增外部依赖
- **背景**：仓库纪律禁止联网下载依赖（LEGION.md）。
- **目标**：头像与名称能力完全离线可用。
- **验收口径**：
  - **AC-R8-1 断网可用**：屏蔽外网下构建 + 启动 + 展示 25 个成员，头像全部正常渲染；Network 面板/服务端日志无外部域名请求。
  - **AC-R8-2 依赖零新增**：git diff 的 package.json 无新增运行时依赖；若方案阶段认为必须新增，须将军批准并在 RESEARCH.md 说明（默认假设 A-6 不批）。

### R-9 [P2] 回退与降级
- **背景**：图片加载失败、移动端、Service Worker 缓存等场景可能裸露破图。
- **目标**：任何头像不可用时显示确定回退，不出现破图。
- **验收口径**：
  - **AC-R9-1 404 降级**：模拟头像资源 404，该成员显示名称首字或占位人形，无破图图标、无裸露 alt。
  - **AC-R9-2 回退不落库**：回退只是渲染态，不写回 roster。
  - **AC-R9-3 移动端不报错**：头像缺失时移动端（app.mjs:404）降级为纯名称，不报错。

### R-10 [P2] 无损迁移与自定义保护
- **背景**：seed-roster.mjs:68 的 upsert 会覆盖 name/kind/avatar；手动改过的成员会被重跑种子回滚。
- **目标**：升级/重跑种子不覆盖**用户显式设置**的名称与头像（只替换未曾自定义的默认值）。
- **验收口径**：
  - **AC-R10-1 自定义保留**：构造 name = 我起的名字 的成员，重跑种子后该行不变。
  - **AC-R10-2 默认替换**：默认值（'🤖' 等）按新规范替换；迁移前后成员条数不变（无重复/无丢失）。
  - **AC-R10-3 主键不变**：迁移不改变 (scope, role) 唯一键与 agent_registry.agent_id。

### R-11 [P2] 移动端与 3D 场景覆盖
- **背景**：移动端不显示头像（app.mjs:404）；3D 标签只显示名称（Employee3D.tsx:123-126），人物外观由 identitySeed 决定（sceneState.ts:75）。
- **目标**：移动端与 3D 场景在 P2 范围内接入同一名称/头像来源；3D 人物外观与头像的关系由 ❓O-3 决定。
- **验收口径**：
  - **AC-R11-1 移动端**：成员选择/会话头显示同一头像；若头像缺失按 AC-R9-3 降级。
  - **AC-R11-2 3D 标签**：3D 员工标签的 name 与 S1 一致；若 O-3 判为联动，则人物外观与头像可对应（人工抽检 ≥4/5）。

## 5. 范围边界

### 5.1 做什么（In scope）

1. 全部在编成员的展示名规范化（R-1、R-2）。
2. 全部在编成员的人形头像（R-3）与全展示面一致（R-4、R-11）。
3. 跨空间同 role 的名称/头像一致性（R-5）。
4. 成员编辑入口与持久化（R-6，依赖 ⚖️D-1）。
5. 默认值 / 种子 / 新建路径的开箱即用与幂等（R-7）。
6. 离线自足（R-8）、回退（R-9）、无损迁移（R-10）。
7. 文档同步：README、docs/FEATURES.md 中涉及成员名称/头像的描述更新（实现阶段完成）。

### 5.2 明确不做什么（Out of scope）

1. **不做技术选型与实现细节**：头像载体（位图/矢量/程序化人形）、文件格式、生成算法、存储与迁移方案、前端组件改造方式 → T-196 researcher 与后续阶段（本阶段只给判据）。
2. **不改身份模型**：不引入 name/avatar 作为身份键，不做岗位多实例（rosterKey 扩展），不动 agent_registry 主键语义（design:79-83）。
3. **不改 role 机器键与流水线契约**：roles.json 的 role、阶段链、文件域规则不变。
4. **不做 AI 生成人像 / 在线图床**，不做头像上传与裁剪器（默认 ⚖️D-5 列入 backlog）。
5. **不做移动端重设计、不做 3D 场景美术重做**：只接入同一来源；外观联动见 ❓O-3。
6. **不做权限/审计新契约**：编辑入口沿用现有鉴权。
7. **不碰其他目标/其他任务的文件与产物**（工作区纪律；只提交本任务文档）。
8. **本阶段不写代码、不跑 taskctl、不 push**。

## 6. 成功标准（可度量，可测试）

| 编号 | 标准 | 判据 |
| --- | --- | --- |
| M-1 | 覆盖 | 5 空间 25 岗位 25/25 有符合 R-1/R-3 的 name/avatar；自建成员走 AC-R7-2 |
| M-2 | 唯一 | 同空间重名 0（AC-R2-1）；同空间头像重复 0；跨空间同 role 名称/头像分叉 0（AC-R5-1，默认口径） |
| M-3 | 一致 | S1–S12 每成员的名称/头像两两相等；硬编码兜底来源与首字头像 0 处（AC-R4-1/4） |
| M-4 | 稳定 | 改名/换头像后 agent_id、会话、任务归属不变（AC-R2-2）；同 (scope, role) 头像确定性不变（AC-R3-4） |
| M-5 | 离线 | 断网 0 外部请求；package.json 新增运行时依赖 0（AC-R8-1/2） |
| M-6 | 可辨 | 人工抽检「人形可辨」≥4/5；「像对人的称呼」≥4/5（AC-R1-2、AC-R3-2） |
| M-7 | 无破图 | 13 个展示面 × 5 空间 × 25 成员遍历，破图/裸露 alt 0（AC-R4-3） |

## 7. 风险与依赖假设

### 7.1 风险

| 编号 | 风险 | 影响 | 证据/来源 | 需求侧缓解 |
| --- | --- | --- | --- | --- |
| RK-1 | avatar 是单字符 TEXT（server.mjs:1328），图片形态需数据形态/资源通道变更 | 迁移与旧值兼容复杂 | server.mjs:1328 | R-10 无损迁移 + AC-R3-4；迁移步骤由方案阶段给出 |
| RK-2 | seed-roster upsert 覆盖 name/avatar（seed-roster.mjs:68） | 手动改名被回滚 | seed-roster.mjs:66-69 | R-10 / AC-R10-1 |
| RK-3 | 渲染面 12+ 处，CSS 均为文本徽章（index.css:708-718、:2548、:845） | 回归面大、易漏面 | §2.3 | R-4 逐面 AC；breaker 须按展示面切片并显式声明文件域 |
| RK-4 | 身份红线（design:81） | 用 name/avatar 派生 key 会引入身份漂移 | agent-conversations.mjs:61-64 | AC-R2-3；reviewer 必查 |
| RK-5 | 跨空间同 role 首见名胜（read-models.mjs:221-224） | 全局目录名称不稳定 | read-models.mjs:221-224 | R-5 / AC-R5-1 |
| RK-6 | 3D 人物外观由 identitySeed(scope+role) 决定（sceneState.ts:49-53、:75；Employee3D.tsx:50） | 头像与场景人物无关联，期望可能落空 | 同上 | ❓O-3：默认不联动，避免范围膨胀 |
| RK-7 | 「人性化」是主观判据 | 验收易起争执 | — | AC-R1-2 用抽检判据 + O-1 名单经将军确认 |
| RK-8 | Service Worker 缓存旧资源（workbench/mobile/sw.js:86-100 对非代码走 cacheFirst） | 旧头像残留导致不一致误判 | sw.js:86-100 | AC-R6-2 刷新一致；缓存版本由实现阶段处理 |

### 7.2 依赖与假设（显式标注，**不当作结论**）

- **A-1 对象**：Legion 指挥台编队成员（workbench + team-hub roster），非 DSH 子代理、非外部执行者。
- **A-2 语言**：中文界面 + 中文展示名（当前 GUI 全中文）。
- **A-3 语义**：「赋予」默认 = 产品**开箱即用**（P0）+ 可选编辑入口（P1）；若 ⚖️D-1 判为「只要入口」，则 R-6 升 P0、R-7 部分降级。
- **A-4 范围**：5 空间 25 岗位全量 + 自建成员走默认分配；若 ⚖️D-3 判为「仅 software 8 岗位」，则 R-1/R-3 覆盖数改为 8/8。
- **A-5 头像**：人形图形形象（图片/矢量/程序化人形），emoji 不算；具体载体由方案阶段定。
- **A-6 依赖**：不新增外部网络依赖（LEGION.md 纪律）。
- **A-7 契约**：不改 role 机器键与身份/任务归属语义。
- **A-8 交付**：本阶段不提供代码，下游可读本目录文档。

## 8. 待裁决项（⚖️D-*）与开放问题（❓O-*）

### 8.1 待将军裁决（裁决前按倾向默认推进）

- **⚖️D-1**「我的 Agent」是**产品默认就人性化**（A）还是**给我配置入口**（B）？
  倾向：A 为 P0 + B 为 P1（原句既可读作要能力也可读作要结果；A 覆盖两者且不阻塞下游）。依据：§1 末行、R-6/R-7。
- **⚖️D-2**「人性化头像」的最低形态：图片/矢量人形 vs 更拟人的 emoji（🧑‍💻）？
  倾向：**不接受纯 emoji**——否则「人性化」与现状无差别（现状 25 个已全是 emoji）。依据：§2.2、A-5。
- **⚖️D-3** 覆盖范围：仅 software 8 岗位 / 5 空间全量 25 岗位 / 含自建？
  倾向：**5 空间全量 25 岗位**（全局目录按 role 合并，只改 8 个会让其余 17 个不达标、且同 role 跨空间分叉）。依据：read-models.mjs:221-224、R-5。
- **⚖️D-4** 命名风格：「拟人称呼 + 职能副标题」两段式（如「析言 · 需求澄清」）/ 保留职称（如「需求分析师」）/ 英文名？
  倾向：**两段式**——展示名给个体感，kind 保留职能（现状 kind 已是职能短语）。依据：AC-R1-3。
- **⚖️D-5** 是否允许将军**上传自定义图片**作头像？
  倾向：v1 不允许（从内置人形库选取），上传 + 裁剪留 backlog（避免存储/尺寸/审核链路膨胀）。依据：§5.2-4。

### 8.2 开放问题（默认取值已写明，供将军补充）

- **❓O-1 25 人最终名单谁定、何时确认？** 默认：coder 阶段按命名规则产出「25 人名单草案」随实现提交，将军在 T-199/T-201 验收时确认（供 AC-R1-4）。
- **❓O-2 头像风格与载体？** 默认：与现有浅色工作台视觉一致的人形插画或程序化人形；由 T-196 researcher 给 2–3 个备选与取舍。
- **❓O-3 3D 场景人物外观是否与头像联动？** 默认：v1 **不联动**，只保证 3D 标签名称一致（避免美术范围膨胀）。
- **❓O-4 内置人形头像库规模？** 默认：≥30 张且互不撞脸（覆盖 25 岗位 + 自建余量），同一空间内不复用。
- **❓O-5 旧的非默认自定义 emoji 头像如何处置？** 默认：一律替换为人形，但**迁移前备份原值并在任务评论公示**；若将军要保留个别，用 D-5/O-5 答复。

## 9. 下游交接（本目录文档链）

- **给 T-196 researcher（只给问题边界，不给答案）**：需要评估——离线/零依赖的人形头像来源（内置 SVG 自绘、程序化人形、或复用现有 3D 人物视觉语言）；avatar 数据形态与旧值迁移；13 个展示面的改造范围与风险；命名规则的可落地方案。输出 2–3 备选 + 取舍理由。
- **给 T-197 breaker**：建议按文件域切片——① team-hub 数据/种子/接口（team-hub/**）；② workbench 展示面（workbench/src/**）；③ 头像资源库（**新增资源目录须显式声明文件域，不得留空**）；④ 文档同步（docs/**、README.md）。R-5（跨空间一致性）与 R-10（迁移）须与数据切片同域。
- **给 T-198 test-designer**：可直接转用例的判据 = M-1~M-7 与 AC-R1-1/2/3、AC-R2-1/2/3、AC-R3-1/3/4、AC-R4-1/3、AC-R5-1、AC-R7-1/2/3、AC-R8-2、AC-R10-1/2。
- **给 T-200 reviewer 的必查项**：AC-R2-3（身份红线）、AC-R4-1（无硬编码兜底/首字头像）、AC-R10-1（不覆盖自定义）、AC-R8-2（无新增依赖）。
- **给 T-201 tester**：验收需含「13 个展示面遍历」与「人工抽检判据（M-6）」，后者须记录评审人与结论。

## 10. 本阶段自检（逐条对应任务验收标准）

1. **逐条覆盖核心诉求**：§1 表格逐片段澄清，§4 每条需求均含 **背景 / 目标 / 验收口径** ✅
2. **范围边界**：§5.1 做什么 7 条 + §5.2 明确不做什么 8 条；不确定项集中在 §7.2 / §8 **显式标注为假设**，未把假设当结论 ✅
3. **术语无歧义**：§3 术语表给出「不指」列；**成功标准可度量**：§6 M-1~M-7 每条指向可执行断言 ✅
4. **下游可用需求清单**：R-1~R-11 含编号 + 优先级 + AC；风险与依赖假设见 §7 ✅
5. **不越界**：未做技术选型（只给判据，载体交 researcher）、未写代码、未改实现、未调用 taskctl、未 push ✅
