# T-103 需求说明：环节产出文档在任务详情直接打开预览（免人工查找路径）

> 阶段：需求澄清（requirement）｜任务：需求澄清/方案确认等所有产生文档的环节，在任务详情中要能够直接打开预览其所产出的文档，避免再去人工查找路径
> 上游 goal 原句（将军）：**[auto-goal] 需求澄清/方案确认等所有产生文档的环节，在任务详情中要能够直接打开预览对于产生的文档，避免再去人工查找路径**（任务标题「【需求澄清】需求澄清/方案确认等所有产生文档的环节，在任务详情中要能够直接打开预览对于产生的文档」）
> 标记：[auto-goal]；下游：researcher（docs/RESEARCH.md）→ breaker（docs/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
> 评估基准：w/T-103 HEAD == main == `3c8f27d`（promote T-095；本文件所有 file:line 均指向该提交的仓库内容）

## 0. 文档状态与阅读说明

- 本文件是 T-103「需求澄清」阶段产出，**取代**同目录旧产物 docs/REQUIREMENTS.md（T-095 四项能力版；旧版经 git 历史可回溯——仓库既定惯例：T-095 取代 T-073 版、T-073 复核 T-014 版时同法处理）。
- 本文沿用仓库标注惯例区分三类内容：
  - ✅ **已确认口径**：由代码/历史证据钉死、下游可直接依据的现状与边界；
  - ⚖️ **待将军裁决**：影响范围/优先级/语义的关键分歧，裁决前**默认按「倾向 + 默认值」推进**，但该默认值是「假设」不是「结论」——将军可在本任务验收评论逐条答复或修正；
  - ❓ **遗留/开放问题**：默认取值见各条，明示假设，供将军补充输入。
- **本阶段只产出本文档**：不写实现、不做技术选型（文档内容如何被取出/预览视图形态/渲染器选型等留给 researcher）、不改仓库实现、不调 taskctl、不 push。所有「验收口径」写成**可测语句**（行为断言/命令/判据），供 breaker 切分与 test-designer 直转用例。
- **本阶段完成 ≠ 目标全部完成**：本文交付「明确、可验收的需求说明 + 范围边界 + 需求清单 + 风险依赖」；实现由后续阶段按流水线推进。

---

## 1. 目标解读：将军诉求 → 可验收语义

| 原句 | 澄清后语义 | 现状定性（证据见 §2） | 对应需求 |
| --- | --- | --- | --- |
| 「需求澄清/方案确认等**所有产生文档的环节**」 | 指流水线中**以文档为交付物**的岗位环节，含：需求澄清(requirement)、方案搜索/确认(researcher)、任务拆解(breaker)、测试用例设计(test-designer)、代码审查(reviewer)、测试执行(tester)、部署与发布(devops)等——凡角色职责里写明「产出写进 docs/…」的环节。**判定依据 = 角色 prompt/岗位契约里声明了文档产出**（roles.json），不是笼统的「聊天/评论」。 | 各岗位的**文档路径契约只以 prompt 文本形式存在**（roles.json），唯一带机器字段（`artifact`）的岗位是 researcher（roles.json:19-20）；任务记录上没有「本任务产出文档」的结构化字段 | R-1 |
| 「在**任务详情**中」 | 将军验收任务时打开的**任务详情视图**。现存的将军可交互任务详情面共两处：**S1 = 军团指挥台（workbench）任务详情弹窗 TaskDetailModal**（中枢模式主控面，守护完成评论里「任务详情『✓ 验收通过』」即指它）；**S2 = 经典看板 scrum/kanban.html 卡片详情弹窗**（文件模式/服务模式 + DSH GUI 看板抽屉内嵌同一页面）。**S1/S2 之外的 console.html/总指挥部只做总览，无单任务详情，不算验收面** | S1：产物区只显示**路径文本**（html/file 均无打开/预览动作，仅 url 有外链），TaskDetailModal.tsx:419-434；S2：仅**最新一条 html** 产物 iframe 预览、file=下载、url=跳转，render.mjs:437 | R-2/R-4 |
| 「能够直接打开预览…所产生的文档」 | 将军在任务详情内**点击即读**到该环节产出文档的**内容**（markdown 渲染阅读视图或同等级可读形态），而不是拿到一串路径后自己去文件中心/文件系统/编辑器里找文件打开 | 全链路现状：详情内无 md 渲染；hub 无产物内容服务端点；v1 /api/artifact 只服务「已登记」且只读最新 html；文档唯一可读通道 = 审计区**逐文件 diff**（非渲染、6000 字符截断）或**文件中心人工导航** | R-2/R-3/R-4 |
| 「避免再去人工查找路径」 | 完成态 = 将军**不需要知道/复制文档的仓库相对路径**即可阅读该环节产出；路径只作为辅助信息展示 | 现状：产出路径散落在 worker evidence 文本/守护完成评论（如「方案文档 docs/RESEARCH.md 已合入主分支」，plugins:1315）与补丁文件清单里，将军需据此人工定位 | R-1/R-2 |
| 「需求澄清/方案确认等**所有**」 | 能力是**通用机制**（按岗位契约注册 → 详情可预览），不是只给某两三个岗位硬编码入口；新增文档型岗位无需改代码即可生效 | 现状：机器契约只覆盖 researcher 一个岗位（stage.artifact，roles.json:20） | R-1（配置驱动） |

> ⚠️ **关于标题/目标文字的语病（需记录，不影响语义）**：goal 原句「直接打开预览**对于产生的文档**」应为「直接打开预览**其所产生的文档**」（或「对其产生的文档直接打开预览」）。本文按「对其产生的文档直接打开预览」理解，如将军原意不同请在验收评论纠正。

---

## 2. 现状盘点与缺口判定（✅ 证据锚定）

> 全部 file:line 相对仓库根（评估基准 3c8f27d）。核心证据链：roles.json（岗位→文档契约）、plugins/src/index.ts（守护结算/产物登记/完成评论）、team-hub/server.mjs（v2 任务库）、workbench/src/components/TaskDetailModal.tsx + api.ts（S1 详情）、scrum/render.mjs + serve.mjs + board-plugin/src/index.ts（S2 详情与内容服务）。

### 2.1 「产生文档的环节」：岗位→文档路径契约（R-1 输入）

- roles.json 的 software 流水线 8 岗中，**prompt 声明写文档的岗位与路径**（全部为提示词文本，非机器字段）：
  - requirement「需求澄清」→ worktree 的 `docs/REQUIREMENTS.md`（roles.json:11）；
  - researcher「方案搜索」→ `docs/RESEARCH.md`（roles.json:17），且是唯一带**机器契约**的岗位：`"gate": true, "artifact": "docs/RESEARCH.md"`（roles.json:19-20）；
  - breaker「任务拆解」→ `docs/TASK_BREAKDOWN.md`（:25）；test-designer「测试用例设计」→ `docs/TEST_CASES.md`（:31）；
  - reviewer「代码审查」→ `docs/review/<任务ID>-REVIEW.md`（:43，文件名含任务 ID 动态部分）；
  - tester「测试执行」→ `docs/TEST_REPORT.md`（:49）；devops「部署与 CI/CD」→ `docs/DEPLOY.md`（:55）。
- 守护结算侧：仅对 **gate 且声明 artifact 的岗位**（现只有 researcher）在完成后做「文档必须存在」校验并写完成评论（plugins:1300-1318，docOk 校验 :1306）。requirement 等岗位**没有** stage.artifact → 守护不校验、不登记、不提示——「产出 REQUIREMENTS.md」只靠角色 prompt 文本要求 worker 自觉写入，**产物数据面零记录**。
- 结论：**「环节应产出哪些文档」目前是分散在 prompt 里的人类可读约定，缺一份机器可读、逐岗位的产物文档契约**；worker 是否把文档同步声明为任务产物，完全依赖其自选（提示词只写「artifact 可选」，plugins:1104-1106）。

### 2.2 任务记录上的「产物」数据面（R-1/R-2 输入）

- v2（team-hub SQLite）：tasks 表带 `artifacts TEXT DEFAULT '[]'` 列（server.mjs:94-100、:282-287），`POST /api/artifact` 追加登记 {kind, path, title, by, at}（:1260-1273，audit 记 `artifact`）；GET /api/task 原样返回（:378-384）。**hub 侧没有任何「按登记产物返回文件内容」的 GET 端点**。
- v1（scrum/tasks.json + taskctl）：`taskctl artifact <id> --kind --path --title` 登记（taskctl.mjs），serve.mjs 提供内容服务 `GET /api/artifact?task=<id>[&raw=1]`（serve.mjs:452-473）：path 只取 tasks.json 登记记录（不读查询串）+ repoRoot 白名单；html → iframe 预览、file → 下载、url → 302。
- 登记的唯一触发点：worker 完成报告 JSON 里自填 `artifact` 字段 → 守护 recordArtifact（plugins:943-950 hub/taskctl 双路径，调用点 :1139/:1289）。**报告里没填 = 任务永远没有产物记录**（无任何自动兜底）。
- 结论：**「能否在详情里看到产物/文档」目前 = 运气取决于 worker 是否自愿声明**；且 v2 登记后也没有内容预览，只有一行路径。

### 2.3 两处「任务详情」对产物的展示现状（R-2/R-4 输入）

- **S1 workbench 任务详情弹窗**（v2 中枢模式主验收面，守护评论所指的「任务详情」）：
  - 结构：AI 执行过程（evidence+评论时间流）、🧾 审计工作台（改动文件逐文件 diff/批注 + testReport + 产物）、⏱ 时间线、描述/验收/边界、操作按钮（TaskDetailModal.tsx:333-505）。
  - 产物区（:419-434）：逐条渲染「📦 产物 + kind + title — path」**纯路径文本**；仅 `kind==='url'` 时是 <a> 外链，**html/file 都没有打开、下载或预览动作**。审计区逐文件「▾ 查看 diff」是把该文件**变更 diff** 展开在 <pre>（:452-484，单文件 6000 字符截断）——文档类产物只能靠读 diff 间接看。
  - 数据面：fetchHubTask → GET /api/task?id=（api.ts:270-272）；api.ts 里**没有任何取产物文件内容/预览的客户端函数**。
- **S2 经典看板卡片详情弹窗**（v1；kanban.html 由 render.mjs 生成模板，serve.mjs/双击文件两模式）：
  - 产物区（render.mjs:437）：仅当存在登记产物且**最新一条是 html** 时给 iframe（`/api/artifact?task=<id>&raw=1`）；file → 下载链接；url → 外链。**markdown/文本类文档没有预览**；且 html 只支持最新一条、file 只支持下载。
- **console.html / board-plugin「总指挥部」**：守护状态 + 任务实时总览（三列卡片 + 评论预览 + 动态），无单任务详情（board-plugin/src/client/index.ts、scrum/console.html），**不承担「任务详情验收」职责**（范围排除）。

### 2.4 文档内容的既有可读通道（人工路径 = 被投诉对象）

- worker evidence/守护完成评论里的路径文本（如「✅ 方案搜索完成，方案文档 docs/RESEARCH.md 已合入主分支」，plugins:1315；evidence 自由文本）。
- **文件中心**（workbench FilesView，serve.mjs /api/files，根 = 空间 local_dir）：可导航到仓库内 docs/*.md 并文本预览（截断+行数，非渲染）——需要将军**人工逐层导航**（workbench README §文件中心）。
- 审计区 diff（见 2.3）——非渲染、截断、针对变更而非全文。
- 文件系统/编辑器人工打开 worktree 路径。
- 结论：**不存在「从任务详情一步到文档可读视图」的通道**；这正是 goal 要补的核心能力。

### 2.5 内容与分支时序约束（预览方案必须回答的现状约束）

- 环节任务（如 T-103 这类）在隔离 worktree（w/<id>）产出文档，提交在 w/<id> 分支（plugins:1287 commitWorktree → :1292 autoPromote / :1326-1331 末环节点留 in_review 待 promote）。
- **验收发生在「可能尚未 promote」的时间点**：非末环节点/门禁自动合入后文档在主分支（plugins:1290-1318）；末环节点与「停 in_review 待将军验收」的任务（:1326-1331）在验收那一刻文档只存在于 w/<id> 分支或已手工 promote。→ **「任务详情可预览」必须覆盖两种内容来源状态**：主仓库已合入文件 与 仅存在于该任务 w/<id> 分支（或隔离 worktree 目录）的文件；预览内容须与该真实来源逐字一致（验收见 AC-R3-3）。

### 2.6 渲染安全红线（预览实现不得破坏的既有纪律）

- 仓库渲染纪律：React 一律文本节点、无 dangerouslySetInnerHTML（ChatView.tsx:13/:49、FilesView 渲染安全注释、ActivityFeed :72 同）——markdown 渲染若引入 HTML/脚本通道必须满足同等级「预览不执行 HTML/脚本」红线（验收 AC-R3-5）。

---

## 3. 关键术语表（本文件口径，消除歧义）

| 术语 | 定义（本需求采用） |
| --- | --- |
| 任务详情 | 将军验收任务时打开的**单任务详情视图**：S1 = 军团指挥台（workbench）TaskDetailModal（中枢模式主面）；S2 = 经典看板 kanban.html 卡片详情弹窗（v1 与 DSH GUI 看板抽屉同页）。总指挥部 console 不在内 |
| 环节（stage/岗位） | 流水线中的角色环节（roles.json stages：requirement…devops），每个任务对应一个环节 |
| 产生文档的环节 | 角色 prompt/岗位契约声明「产出写进 docs/…」的环节（§2.1 七岗）；判定依据是岗位契约而非任务标题 |
| 产出文档（阶段文档） | 某环节按契约应产出的交付文档，如 requirement → docs/REQUIREMENTS.md、reviewer → docs/review/<T-ID>-REVIEW.md；路径可能含任务 ID 动态段 |
| 产物（artifact） | 任务记录里的通用产物条目 {kind: html/file/url, path, title}（v1 taskctl artifact / v2 POST /api/artifact）；产出文档是产物的一种（kind=file、path=仓库相对路径） |
| 岗位文档契约（doc contract） | 机器可读的「环节 → 应产出文档路径模板」配置（本需求 R-1 新增；现状仅 researcher 有单条 stage.artifact） |
| 直接打开预览 | 在任务详情内点击产出文档 → 出现可读视图（markdown 渲染阅读或明文全文），无需离开页面找文件；等于或优于「下载后在本地打开」 |
| promote | 验收通过后把 w/<id> 分支合入主仓库分支的动作（自动 promote / 将军手工 promote） |
| 白名单内容服务 | 只读仓库根（repoRoot，v1 另含 artifactRoots）内文件的内容读取端点；禁止任意路径读取（serve.mjs:452-473、board-plugin/src/index.ts:67-96 先例） |

---

## 4. 范围边界（总纲：做什么 / 明确不做什么）

### 4.1 总「做什么」（✅ 本阶段与后续阶段共同边界）

- DO-1：产出编号需求清单（R-1~R-4）+ 优先级 + 每条 背景/目标/做什么/不做什么/可测验收口径（本文件 §5）。
- DO-2：全部现状/缺口表述以真实代码证据锚定（§2 + §9 证据索引），不把假设当结论。
- DO-3：关键歧义显式列出（§8），各带倾向与默认值；默认值明示为假设，供将军逐条裁决。
- DO-4：后续阶段按需求清单实现并逐条验证（breaker 分片 / test-designer 转用例 / coder / tester 锚定）。

### 4.2 总「明确不做什么」（🚫 所有阶段共同）

- 🚫 不做技术选型与实现细节（文档内容取用通道形态：hub 新端点 vs 复用文件中心 / 渲染器选型 / 是否新增任务列 vs 派生视图等 → researcher）。
- 🚫 本阶段不写代码、不改仓库实现、不跑 taskctl/看板写接口、不 push、不下依赖。
- 🚫 不把模糊点悄悄留给下游：默认值即假设，重要分叉（D-1~D-10）必须将军裁决或显式标注后才可当作需求基线。
- 🚫 不重写既有看板/任务库/守护架构；不改变 roles.json 各岗位的职责语义（可**新增**机器字段，不改 prompt 语义，见 R-1 边界）。
- 🚫 不做「文档编辑/在线修改」能力（本需求只管**读与预览**；写文档是 worker 在 worktree 内完成的事）。
- 🚫 不做全文检索/文档管理库等超出「任务详情预览本任务产出」的新产品形态。
- 🚫 默认不把「全部空间」/非本空间仓库的文件纳入预览源（沿用空间绑定仓库根 + 白名单纪律，D-10）。

---

## 5. 需求清单（编号 + 优先级 + 验收口径）

> 优先级建议：R-1/R-2/R-3 = **P0**（缺失即目标不成立）；R-4 = **P1**（同能力在 v1 看板面的补齐，将军若日常验收都在 workbench S1 可降为 P2）。将军可在验收评论调整。
> 验收口径均为**可测语句**；「（样例）……」中的命令形态供 test-designer 直转，具体实现机制由 researcher/breaker 落定。

### R-1（P0）岗位文档契约：环节产出文档自动进入任务记录

**背景**：产出文档路径目前只写在角色 prompt 文本里（roles.json，§2.1），机器契约仅 researcher 一岗；worker 报告不自填 artifact 时，任务记录上没有任何「本环节产出了什么文档」，任务详情自然无从预览。goal 点名「需求澄清/方案确认等**所有**产生文档的环节」，需要把「环节→文档」变成通用、配置驱动的机制。

**目标**：任何文档型岗位任务，其应产出文档在任务完成结算时被**自动登记为该任务的结构化条目**（不依赖 worker 手工声明）；任务详情据此渲染「产出文档」区。登记信息至少含：任务 ID、岗位、文档路径（仓库相对或可解析到仓库根）、标题/说明、登记时间。

**做什么（scope in）**
1. 定义机器可读的**岗位文档契约**：每个文档型岗位 → 文档路径模板（requirement→docs/REQUIREMENTS.md；researcher→docs/RESEARCH.md；breaker→docs/TASK_BREAKDOWN.md；test-designer→docs/TEST_CASES.md；reviewer→docs/review/<T-ID>-REVIEW.md（模板含任务 ID）；tester→docs/TEST_REPORT.md；devops→docs/DEPLOY.md），并支持 1 岗多文档（如 evidence 目录等，按将军裁决 D-2）。
2. 契约落点建议沿用 roles.json stage 定义（新增字段），保持与既有 stage.artifact/gate 同源；**不动既有岗位 prompt 的职责语义**（D-1）。
3. 守护在 worker 完成结算（done 报告路径，plugins:1285-1334）时，按任务 role 的契约**自动登记产出文档条目**；登记动作与现有 recordArtifact（plugins:943-950）同链路（hub：POST /api/artifact；v1：taskctl artifact），产物条目 kind 为文档（file/markdown 语义按 D-4）。
4. 完成评论同步给出「产出文档清单」可读摘要（如「产出文档：docs/REQUIREMENTS.md」），替代/增强现「方案文档 … 已合入主分支」仅 researcher 享有的提示（plugins:1315 泛化）。
5. 文档缺失时的显式处理：契约文档在结算时不存在 → 在任务上写明确提示（对照现 researcher docOk 校验 plugins:1306-1312 泛化到全部契约岗位），**不静默**。

**明确不做什么（scope out）**
- 🚫 不改变各岗位职责/验收模板语义（roles.json stage.standards 与 prompt 不动，仅**新增**字段）。
- 🚫 不为「非文档型岗位」（coder 等以代码为交付物）伪造文档契约。
- 🚫 不做契约的界面管理（将军手动编辑契约 UI 属可选后置，D-3；本期可用 roles.json/配置直接维护）。

**验收口径（可测语句）**
- AC-R1-1 契约存在性：roles.json（或等价配置）中七个文档型岗位各有一条文档契约，路径模板与 §2.1 prompt 现行约定一致（reviewer 模板含任务 ID 段）。
- AC-R1-2 自动登记：以一条 requirement 岗位任务回放（或新建样例任务跑完 worker）→ 结算后任务记录 artifacts/产出文档区出现 `docs/REQUIREMENTS.md` 条目（by=守护、含时间），**worker 报告未填 artifact 字段也能登记**（自动兜底）。
- AC-R1-3 reviewer 动态文件名：reviewer 任务结算后登记路径解析为 `docs/review/<该任务ID>-REVIEW.md`（模板替换正确）。
- AC-R1-4 缺失提示：模拟「契约文档不存在」结算 → 任务评论出现明确缺失提示（含期望路径），任务仍停 in_review（不误判为成功流转）；文档补上重跑后提示消除。
- AC-R1-5 兼容回归：researcher 既有 gate/artifact 行为不回归（现有插件测试/冒烟用例通过）；非文档型岗位不新增任何登记条目。

### R-2（P0）任务详情「产出文档」直达区：点击即打开

**背景**：即使 R-1 完成登记，S1 workbench 任务详情现有产物区也只是路径文本（TaskDetailModal.tsx:419-434），将军仍要「拿路径去找文件」——goal 的核心痛点在详情面。

**目标**：S1 任务详情出现「产出文档」直达区（按文档型岗位任务显示），每条 = 文档标题 + 岗位/时间 + 「打开/预览」动作，**点击即可读内容**（内容视图形态与来源规则见 R-3）；同时保留/优化既有通用「产物」展示（不删除 url/html/file 既有行为）。

**做什么（scope in）**
1. S1 详情新增「产出文档」区（或在既有产物区内升级）：来源 = 任务记录中按 R-1 登记的文档条目（叠加既有手工 artifact）；按时间倒序、多文档/多轮修订可见（最新优先）。
2. 每条文档提供明确的打开动作；路径降级为辅助信息展示（title/说明优先，路径可复制）。
3. 预览面与详情同屏（内嵌渲染视图）或新标签可读页，两者至少其一；同屏时详情不因文档长而卡死（滚动/容器上限）。
4. 通用产物区保留：url 外链、html 预览、file 下载等既有语义不因新能力回归（对照 S1 现状 :427-429 至少保持）。
5. 无契约文档的任务（非文档型岗位、或 worker 未产出）不显示空区误导，给出中性占位文案（可含「该环节不要求文档」或「尚未产出」）。

**明确不做什么（scope out）**
- 🚫 不做文档编辑；不做文档版本管理 UI（多轮修订以列表时间呈现即可）。
- 🚫 详情区不做 markdown 编辑器/图表等重渲染能力（渲染安全与范围，D-5）。

**验收口径（可测语句）**
- AC-R2-1 可达性：打开任一 in_review 的文档型岗位任务详情 → 存在「产出文档」区且列出该任务契约文档（≥1 条），无需展开 diff、无需输入/复制任何路径。
- AC-R2-2 打开动作：点击文档条目 → 出现可读视图（内嵌或新标签），视图中可见文档全文而非仅摘要/路径/下载按钮。
- AC-R2-3 多轮可见：同一任务经历 打回→重做 后，多轮文档条目按时间倒序可见（最新在首），旧版不丢失。
- AC-R2-4 无文档任务：非文档型岗位任务详情不出现「产出文档」区（或明确占位），页面不报错。
- AC-R2-5 回归：url/html/file 既有产物语义不回退（S1 既有冒烟/用例保持通过）；workbench pnpm build 0 错误。

### R-3（P0）文档内容预览：所见 = 真实文件内容（含未 promote 分支态）

**背景**：S1 现状无任何 md/文本内容预览通道（§2.3/§2.4）；同时环节文档在验收时刻可能只在 w/<id> 分支（§2.5）。预览必须回答「内容从哪来、怎么保证与真实文件一致、怎么防任意文件读取」。

**目标**：任务详情预览的文档内容 = 该任务当前产出文档的**真实文件内容**（可逐字比对）；覆盖「已合入主分支」与「仅存在于该任务 w/<id> 分支/隔离目录」两种时序态；读取受既有仓库根白名单纪律约束；markdown 以可读渲染呈现且不执行 HTML/脚本。

**做什么（scope in）**
1. 提供从任务详情到**文档文件内容**的读取通道（形态由 researcher 定，需满足下述约束）：路径解析自任务登记（不读任意查询串——对照 serve.mjs:452-473 先例）；来源解析规则明确：主仓库已合入文件 → 该任务 w/<id> 分支/隔离目录文件（内容一致即通过，机制不限）。
2. markdown 文档渲染阅读视图：标题/列表/表格/代码块/引用等可读；含脚本/HTML 的内容不执行（渲染安全红线，§2.6）。
3. 大文档与截断策略明确可测（默认：常规文档（如 REQUIREMENTS.md 数百行）完整可读；超长文档有明确上限与提示，不留「静默截断不可感知」）。
4. 二进制/非文本文档给出中性处理（下载/提示不可预览），不报错。
5. 白名单纪律：只允许读该任务归属仓库根内文件（v2/v1 各自 repoRoot；沿用 serve.mjs/board-plugin artifact 白名单先例），**预览通道不得成为任意文件读取口**。

**明确不做什么（scope out）**
- 🚫 不规定内容通道的技术形态（hub 端点 / serve.mjs 端点 / 复用文件中心 / git show 分支内容等）→ researcher。
- 🚫 不做跨仓库/跨空间文件预览（默认 D-10）。
- 🚫 不承诺渲染与 GitHub/本地编辑器的像素级一致（可读等价即可，D-5）。

**验收口径（可测语句）**
- AC-R3-1 内容一致（主分支态）：对已 promote 的文档型任务样例，预览内容与主仓库该路径文件**逐字一致**（比对命令示例：预览接口输出与 git show main:<path> 输出 diff 为空，或等价字节/文本断言）。
- AC-R3-2 内容一致（分支态）：模拟文档仅存在于 w/<id>（未 promote）的 in_review 任务 → 预览内容与该分支文件逐字一致（git show w/<id>:<path> 比对）。
- AC-R3-3 路径安全：预览通道不接受任意查询串指定文件（如 ?path=… 一律拒绝/忽略）；路径逃逸（../、盘符、仓库根外符号链接）被拒；返回错误与正常预览可区分（测试断言 4xx/错误文案）。
- AC-R3-4 markdown 可读：渲染视图对含标题/表格/代码块的样例 md 呈现正确结构（冒烟断言关键文本可见、代码块按预格式化呈现）。
- AC-R3-5 渲染安全：预览含 <script> / <img onerror> / javascript: 链接的 md 后**无脚本执行**、无弹窗（e2e 或等价冒烟断言）；页面无 dangerouslySetInnerHTML 新引入（代码审查断言）。
- AC-R3-6 超长/二进制：超上限文档有明确截断提示或分页；二进制文件走下载/提示路径不白屏不报错。
- AC-R3-7 回归：既有 v1 html iframe 预览、file 下载、url 跳转（serve.mjs/api/artifact）与文件中心不受影响（相关既有测试通过）。

### R-4（P1）经典看板（S2）详情预览补齐

**背景**：S2 kanban.html 详情只支持「最新一条 html iframe / file 下载 / url 外链」（render.mjs:437），且前提是产物已登记；将军若在经典看板/DSH GUI 看板抽屉验收文档型任务，同样面临「不能直接预览 md 文档」。

**目标**：S2 任务详情在 R-1 登记基础上获得与 R-2/R-3 对齐的产出文档预览能力（markdown 可读预览，多条目列表，不再只认最新一条 html）。

**做什么（scope in）**
1. S2 详情产物/产出文档区改为**逐条可交互**：md/文本条目提供预览（复用 R-3 内容通道语义，v1 已有 /api/artifact raw 服务可扩展）；html 条目保留 iframe 预览且支持多条（不再只最新一条）；url/file 保留跳转/下载。
2. 与 R-1 登记的 v1 侧条目贯通（taskctl artifact 或等价登记路径）。
3. 文档缺失/不可预览时有明确文案。

**明确不做什么（scope out）**
- 🚫 若将军确认日常验收均在 S1（workbench），本需求可整体降 P2 或砍掉（D-6）；不双倍实现。

**验收口径（可测语句）**
- AC-R4-1 在 S2 打开已登记文档型任务详情 → 产出文档条目可点击，出现可读预览（md 渲染或明文全文），内容与真实文件一致（比对同 AC-R3-1/R3-2 方法）。
- AC-R4-2 多条 html 产物逐条可预览（v1 既有只最新一条的行为升级后有测试锚定）。
- AC-R4-3 url/file/html 既有语义不回退；render.mjs 生成产物通过（node scrum/render.mjs 无错）。

---

## 6. 端到端验收总口径（happy path + 关键边界，供将军快速验收）

1. **典型主路径（将军验收场景）**：T-103 这类 requirement 任务完成进入 in_review → 将军在 S1 任务详情看到「产出文档」区列出 `docs/REQUIREMENTS.md`（或打开后该文件内容正确）→ 点击直接阅读 markdown 全文（标题/表格/列表可读、无脚本执行）→ 对照验收标准在详情里「✓ 验收通过」。全程**无需**离开任务详情去文件中心/文件系统找路径。
2. **未 promote 边界**：验收发生在文档尚在 w/<id> 分支时 → 预览仍可得且内容与分支文件一致（R-3 AC-R3-2）。
3. **缺失边界**：worker 没产出契约文档 → 任务停在 in_review 且评论/详情明确提示缺 `docs/<约定路径>`（R-1 AC-R1-4），将军可打回让补全，不出现「任务完成却无处看文档」。
4. **打回重做边界**：打回重做后新文档替换/新增条目，最新可见、旧版可查（R-2 AC-R2-3）。
5. **安全边界**：预览通道读不到仓库根外的任意文件（AC-R3-3），md 预览不执行脚本（AC-R3-5）。

---

## 7. 风险与依赖假设

### 7.1 风险清单

| # | 风险 | 说明 | 缓解 |
| --- | --- | --- | --- |
| R-1 | 登记靠 worker 自觉 → 数据面为空 | 现状产物登记完全依赖报告 artifact 自填（plugins:1289、1104-1106） | R-1 守护按岗位契约自动兜底登记 |
| R-2 | 预览内容与「将军实际要验收的文件」不一致（分支/主分支/旧轮次混淆） | 文档在 w/<id> 与主分支间有时序差；多轮修订时点错条目 | R-3 内容来源规则 + 逐字一致验收（AC-R3-1/2）+ 多轮按时间倒序 |
| R-3 | 文档内容通道变成任意文件读取口 | 详情预览若按用户路径直接读文件 → 目录穿越/越权读 | 路径只取自任务登记记录 + 仓库根白名单（serve.mjs:452-473 先例）+ AC-R3-3 |
| R-4 | markdown 渲染引入 XSS/脚本执行 | 仓库红线：React 文本节点、无 dangerouslySetInnerHTML（ChatView/FilesView/ActivityFeed 注释） | 渲染净化/白名单策略 + AC-R3-5 断言 + 审查把关 |
| R-5 | 与 T-095 流水线（四能力）并行改 roles.json/守护结算区 | R-1 动 roles.json（新增字段）与 plugins 结算路径；若四能力链仍在跑，可能合入冲突 | 只新增字段不动语义（R-1 边界）；breaker 分片按文件域隔离（§10）；合入调解员兜底（仓库已有 mediator） |
| R-6 | 文档型岗位清单/路径与将军认知不符 | 「所有产生文档的环节」是目标原文，具体岗位清单是本文归纳（§2.1） | D-2 将军确认/增删；契约配置驱动便于调整 |
| R-7 | S1/S2 双面实现重复或漏一端 | 将军可能主要在某一面验收 | D-6 确认主验收面；R-4 可降级 |

### 7.2 依赖与假设（✅ 明示为假设，非结论）

- A-1 本仓库（w/T-103 == main 3c8f27d）是目标产品的唯一代码基准；§2 全部 file:line 均基于该提交。
- A-2 任务详情 = §3 定义（S1 workbench TaskDetailModal + S2 kanban.html 详情弹窗）；总指挥部 console 不是验收面。
- A-3 「产生文档的环节」清单 = §2.1 七岗（requirement/researcher/breaker/test-designer/reviewer/tester/devops）；文档路径契约 = 现 prompt 声明的 docs/* 路径（D-2 待将军确认增删）。
- A-4 文档在**验收时刻可能尚未 promote**，预览必须兼容（R-3）；若将军确认「只要求在合入主分支后可见」可缩小范围（D-7）。
- A-5 预览文件读取限于该任务归属仓库根（空间绑定仓库根，plugins repoRootFor 语义）+ 白名单；不跨空间读（D-10）。
- A-6 渲染安全红线（无脚本执行、无新 dangerouslySetInnerHTML）延续仓库纪律，预览实现不得豁免。
- A-7 roles.json 岗位语义不变（仅允许新增字段）；stage-standards 验收模板不动。

---

## 8. 待将军裁决与遗留问题（⚖️ / ❓ 汇总）

> 每条均附**倾向与默认值**。默认值已作为需求基线写入 §5；将军不同意的条目请在验收评论中逐条答复，守护会把答复带给后续阶段修订。

| # | 归属 | 问题 | 倾向 / 默认值（默认按此推进） |
| --- | --- | --- | --- |
| D-1 | R-1 | 岗位文档契约放哪/怎么维护？ | **roles.json stage 新增字段（如 docs: [路径模板]）**，与现有 artifact/gate 同源同文件；不改 prompt 文本语义。若将军不想动 roles.json，备选 = 守护侧独立配置表（同 repo），由 breaker/实现选 |
| D-2 | R-1 | 「产生文档的环节」清单与文档路径是否按 §2.1 七岗 + 每岗单文档执行？是否还要纳入 evidence 目录（docs/T###-evidence/）等附加产物？ | 默认 = **§2.1 七岗主文档各一条**；evidence 目录等**不默认登记**（内容多且非「阅读型」文档），将军如需要看 evidence 可在验收评论勾选（作为 R-1 的可选扩展，1 岗多文档契约已支持） |
| D-3 | R-1 | 将军是否需要可视化编辑岗位文档契约？ | **本期不需要**（配置/roles.json 维护即可）；契约编辑 UI 后置为可选项 |
| D-4 | R-1/R-2 | 产出文档登记为既有 artifact 的 kind=file 还是引入 kind=markdown（渲染语义）？ | 倾向 **登记为 file（或等价）并让预览按扩展名识别 md 渲染**——不动 v1/v2 的 kind 白名单语义（html/file/url 三种既有值不破坏）；若实现发现需显式 kind=markdown 才能安全区分渲染/下载，可在 D-4 补记后由实现方说明 |
| D-5 | R-3 | markdown 渲染的呈现基准（渲染到哪种程度算合格）？ | **可读等价**：标题/列表/表格/代码块/引用等结构正确呈现、无脚本执行即可；不追求与 GitHub/本地编辑器像素一致（纯文本回退也是合法最低档，但默认给渲染视图） |
| D-6 | R-4 | 将军日常验收主要在哪个面？S2（经典看板/DSH GUI 抽屉）是否必须同能力？ | 默认 **S1（workbench 任务详情）为 P0 主面**；S2 补齐为 P1——若将军主要在 S2 验收请明示（则 S2 升 P0、S1 保持 P0） |
| D-7 | R-3 | 验收时刻文档尚未 promote（只在 w/<id>）时是否必须可预览？ | **必须**（默认）：这是将军「人工找路径」痛点的重要来源（详情里看到路径却打不开分支文件）；若将军接受「promote 后才可预览」请明示（可缩小内容通道范围） |
| D-8 | R-3 | 文档多轮修订（打回重做）在详情如何呈现？ | **按时间倒序列表 + 最新可预览**（旧版保留条目，点开可预览或标注已被新版本取代——实现按数据可得性二选一，默认保留可预览） |
| D-9 | R-3 | 预览的读取形态：内嵌同屏 vs 新标签独立页？ | **两者至少其一，默认内嵌同屏 + 可新标签打开**（长文档滚动手感与验收对照便利；由实现决定是否给「新标签」钮） |
| D-10 | 全局 | 预览文件读取范围是否含「全部空间」视图（跨空间文档）？ | **不跨空间**（默认）：只读本任务归属仓库根内文件；「全部空间」视图聚合时若文档归属另一空间仓库，显示占位/跳转提示而不是去读它 |

---

## 9. 关键澄清结论（给将军的速览）

1. **目标 = 通用机制而非单点功能**：「需求澄清/方案确认等**所有**产生文档的环节」→ 系统化「岗位文档契约 → 自动登记 → 详情直达预览」，新增文档型岗位不改代码即生效（R-1）。
2. **现状最硬的缺口有两个**：(a) 文档登记完全依赖 worker 报告里自选 artifact（requirement 等岗位通常不填 → 记录上零产物，§2.2）；(b) 即便登记了，S1 详情只有**路径文本**、S2 只认**最新一条 html**——**任何一处都不能直接预览 md 文档**（§2.3）。
3. **「任务详情」= 两处将军可交互验收面**：S1 workbench TaskDetailModal（中枢主面）、S2 经典看板详情（v1/DSH 抽屉同页）；总指挥部 console 无详情、不算验收面（§2.3 结论）。
4. **预览必须兼容「未 promote」时序**：环节文档在验收时刻可能只在 w/<id> 分支；仅支持主分支文件会重现「人工找路径/等合入」的痛点（D-7 默认必须兼容，AC-R3-2）。
5. **安全与渲染红线不豁免**：内容通道沿用仓库根白名单（serve.mjs:452-473 先例）；md 渲染无脚本执行（§2.6 纪律）。
6. **给下游的三个实现自由度**：内容通道技术形态、渲染器选型、详情区 UI 布局——均留给 researcher/breaker（本文件只钉行为与验收）。

---

## 10. 下游衔接说明（供 breaker / test-designer 直接使用）

1. **需求 → 切片文件域建议**（breaker 据此给互不重叠文件域）：
   - R-1：roles.json（或守护配置）+ plugins/src/index.ts（settle/结算与 recordArtifact 区 :943-950/:1285-1334、契约解析）+ team-hub/server.mjs（若 hub 侧登记需扩展 POST /api/artifact 或等价，:1260-1273）。
   - R-2：workbench/src/components/TaskDetailModal.tsx（产物区 :419-434 升级）+ workbench/src/api.ts（客户端取文档条目/内容）+ types.ts（HubTask/产物类型）。
   - R-3：内容通道（researcher 定形态；v1 候选 = scrum/serve.mjs /api/artifact 扩展 :452-473；v2 候选 = team-hub 新端点 或 workbench 复用文件中心 /api/files）+ 渲染视图组件（含净化）。
   - R-4：scrum/render.mjs（详情模板 :437 产物区升级）+ serve.mjs /api/artifact。
   - ⚠️ R-1 与 R-3（v1 候选）同碰 serve.mjs/plugins 附近文件、R-1 与 R-2 跨 workbench 与 plugins——breaker 需在同一文件内划不同函数域或排先后串行，避免并行合入冲突（仓库已有 mediator 兜底）。
2. **测试面锚定**：新用例落在既有套件面内——workbench（web.test.mjs 型冒烟）、team-hub（server 契约）、scrum（render/serve 型冒烟：node scrum/render.mjs 无错）；渲染安全断言参照 ChatView/FilesView 既有安全用例风格；迁移一律幂等（老库零迁移，chat TC-S1-16 先例）。
3. **回放/样例数据**：本任务（T-103）本身就是 requirement 型任务、其产出 docs/REQUIREMENTS.md 可作 R-1/R-2/R-3 的天然验收样例；promote 后主分支亦存在同路径文件，便于主分支态比对（AC-R3-1）。

---

## 11. 附录：证据索引与文档关系

### 11.1 核心证据（file:line，均基于 main 3c8f27d）

| 主题 | 证据 |
| --- | --- |
| 岗位→文档路径契约（prompt 文本） | roles.json:11（requirement）、:17/:19-20（researcher + gate/artifact）、:25（breaker）、:31（test-designer）、:43（reviewer 动态文件名）、:49（tester）、:55（devops） |
| 守护 gate/artifact 校验（仅 researcher） | plugins/src/index.ts:1300-1318（docOk :1306、完成评论 :1315） |
| 产物登记触发点（worker 报告自填） | plugins/src/index.ts:943-950（recordArtifact）、:1289（done 结算调用）、:1104-1106（提示词「artifact 可选」） |
| v2 任务产物数据面 | team-hub/server.mjs:94-100/:282-287（artifacts 列）、:378-384（返回）、:1260-1273（POST /api/artifact，无内容 GET） |
| S1 详情产物区（纯路径文本） | workbench/src/components/TaskDetailModal.tsx:419-434（url 外链 :427-429；file/html 无动作）；审计 diff 单文件 6000 截断 :452-484 |
| S1 取数（无内容函数） | workbench/src/api.ts:269-272（fetchHubTask）；types.ts:290-315（HubTask.artifacts 结构） |
| S2 详情产物区（最新 html iframe/file 下载/url） | scrum/render.mjs:437 |
| v1 内容服务（白名单、只读登记路径） | scrum/serve.mjs:452-473（GET /api/artifact）；board-plugin/src/index.ts:67-96（artifactAllowed/根白名单） |
| 内容时序（autoPromote vs 留 in_review 待 promote） | plugins/src/index.ts:1287-1334（commitWorktree→autoPromote :1292、末环节点 in_review :1326-1331） |
| 渲染安全红线（无 dangerouslySetInnerHTML） | workbench/src/components/ChatView.tsx:13/:49、FilesView.tsx 渲染安全注释、ActivityFeed.tsx:72（同族注释） |
| 人工兜底通道（文件中心导航） | workbench README §文件中心（FilesView + serve.mjs /api/files 文本预览） |

### 11.2 与既有文档关系

- 本文件取代 docs/REQUIREMENTS.md（T-095 四项能力版），旧版可经 git 历史回溯（仓库既定惯例：T-095 取代 T-073 版、T-073 复核 T-014 版时同法处理）。
- 关联阅读：roles.json（岗位/流水线）、plugins/src/index.ts（守护结算与产物登记）、workbench/README.md §任务详情与 AI 执行过程、scrum/README.md §产物自动挂载/卡片动态预览、docs/ORCHESTRATION-V3.md（切片流水线纪律）。

### 11.3 本阶段验收对照（需求分析四条目 → 本文件位置）

| 验收条目（stage-standards requirement） | 落点 |
| --- | --- |
| 逐条覆盖目标核心诉求：每条需求含 背景/目标/验收口径 | §5 R-1~R-4 每条含 背景/目标/做什么/不做什么/可测验收口径（AC-*） |
| 明确范围边界：做什么 / 明确不做什么 | §4（总纲）+ 每条 R 的 scope in/out |
| 关键术语无歧义，成功标准可度量可测试 | §3 术语表；§5 AC 均为可测语句；§6 端到端口径 |
| 输出下游可用需求清单（编号+优先级），并列出风险与依赖假设 | §5（R-1/2/3=P0、R-4=P1）、§7 风险与假设、§8 待将军裁决（默认值）、§10 下游衔接 |
