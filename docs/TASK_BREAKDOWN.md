# T-105 任务拆解：环节产出文档在任务详情直接打开预览（岗位文档契约 → 自动登记 → 详情直达预览）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-105（分支 w/T-105 独立 worktree，HEAD = 8e75005 promote T-104）
> 上游：T-103 需求澄清（docs/REQUIREMENTS.md 现行版，本特性唯一权威需求基线；含 R-1~R-4 编号需求、AC-R1-1..5 / AC-R2-1..5 / AC-R3-1..7 / AC-R4-1..3 可测口径、D-1~D-10 默认值）→ T-104 方案搜索（docs/RESEARCH.md 现文 = 本特性 T-104 报告；一等选型 K1-A..K10-A + 闸门 G-R1..G-R8 建议默认值，本拆解全部按 RESEARCH §12/§13 一等落点执行）
> 下游：守护解析本文件「## slices」注册 coder_Si → tester_Si 微链 → 逐切片开发/测试 → S8 集成回归锚定
> 依据：LEGION.md 纪律、本任务验收标准与边界、T-103 REQUIREMENTS §5（R-1~R-4 与 AC-*）、§8（D-1~D-10 默认值即基线）、T-104 RESEARCH §12.1 实施拓扑（文件域建议）与 §16 回归面命令级清单

> **取代关系**：本文档**取代**同文件 T-097 拆解（四能力批，其切片已交付合入 main，仅历史留存）；旧版经 git 历史回溯（git log --follow docs/TASK_BREAKDOWN.md）。docs/REQUIREMENTS.md 现行版 = T-103 需求（本特性基线）；docs/RESEARCH.md 现行版 = T-104 报告（本特性方案）。
>
> **闸门默认值放行声明（沿用仓库惯例：将军未否决即按默认推进）**：T-103 D-1~D-10 与 T-104 G-R1..G-R8 全部按建议默认值执行——G-R1 roles.json stage.docs（与 artifact/gate 同源）；G-R2 软门禁（契约文档**缺才停 in_review**，有文档的文档型岗位照旧流转；gate 岗照旧人工验收）；G-R3 不放行新依赖 → 渲染器自研（K6-A 零依赖）；G-R4 不豁免 dangerouslySetInnerHTML 红线；G-R5 预览上限 512KB 截断可下载；G-R6 不做字节级历史回看；G-R7 单机部署假设成立（预览服务与仓库同机、spaces.local_dir=仓库根）；G-R8 存量绝对路径记录读取期兼容、不跑迁移。若将军对某条裁定不同，请在验收评论逐条答复，S1/S2/S4/S5 相应验收语句将随答复修订。

## 0. 结论速览（TL;DR）

- 拆解产物：**8 个切片（S1~S8）**，按功能层分组（数据面 → 内容面 → 渲染/UI 面 → 集成收口）：
  - **R-1 岗位文档契约 + 自动登记（P0，2 片）**：S1 = roles.json 七文档岗新增 stage.docs 契约字段 + plugins 解析（{taskId} 模板、docs 缺省回退 artifact）；S2 = done 结算自动登记（commitWorktree 后、autoPromote 前，仓库相对路径、双写 hub/v1、多轮幂等追加）+ 缺失软门禁提示 + 完成评论产出清单。同 plugins/src/index.ts 函数域串行：S1 → S2。
  - **R-3 v2 内容通道（P0，1 片）**：S3 = team-hub 新增只读 GET /api/artifact/content（记录驱动 + 仓库根白名单 + realpath/.git 防逃逸 + worktree 目录优先/主仓库兜底 + 存量绝对路径兼容 + 截断/二进制/错误码）。
  - **R-3 渲染 + R-2 S1 详情直达（P0，2 片）**：S4 = 自研 MarkdownDocView 子集渲染器（React 元素直出、零依赖、原始 HTML 按文本、协议白名单、文本兜底）；S5 = TaskDetailModal「产出文档」直达区 + 同屏内嵌预览 + 多轮倒序 + 空态（api.ts 取内容、types 扩展）。
  - **R-4 S2 经典看板补齐（P1，2 片）**：S6 = render.mjs 产物区逐条可交互 + serve.mjs /api/artifact 逐条内容服务；S7 = board-plugin /api/artifact 同语义逐条化（DSH 托管态）。
  - **S8 集成回归锚定**（docs/TEST_REPORT.md，收口验证，仿 T-097 S12 惯例）。
- 全批**零新增运行时依赖**（契约字段 JSON、守护登记逻辑、hub 读端点、自研渲染组件、S1/S2 UI 均为仓库内代码；一等路线 RESEARCH §17 复核）。
- **文件域纪律（并行合入安全的前提）**：同一文件只允许 1 个切片并发持有；跨切片同文件场景全部**同文件硬串行**并以注册顺序保证（当前生产单 worker 按注册顺序派工，天然串行）：
  - plugins/src/index.ts 链：**S1 → S2**（契约解析/StageDef 段 → done 结算/recordArtifact 段）；workbench/src/index.css 只属 S5（S4 样式走新增独立 css，禁改 index.css）。
- **禁止**在提升并发槽位后同时派工同文件域的相邻切片（§2.2 给出可并行组合清单）。

## 1. 机器可读切片清单（守护据此注册并行派工，逐行严格遵循：每行四段用 | 分隔，段内不再出现 |；第 2 段文件逗号分隔；第 4 段验收分号分隔）

## slices
- S1 | R-1a 岗位文档契约数据模型：roles.json 七文档岗新增 stage.docs 数组字段（reviewer 含 {taskId} 模板段），plugins StageDef/roles 解析支持 docs 与缺省回退 artifact，消费方兼容不回归 | roles.json, plugins/src/index.ts, plugins/tests/doc-contract.test.mjs | node --test plugins/tests/doc-contract.test.mjs 全绿（需先 pnpm --dir plugins build 产出 lib 后直跑，宿主受限时记录复现步骤不冒充通过）;断言 roles.json 七文档岗 requirement/researcher/breaker/test-designer/reviewer/tester/devops 各含 stage.docs 且 path 与角色 prompt 现行约定一致（requirement→docs/REQUIREMENTS.md、researcher→docs/RESEARCH.md、breaker→docs/TASK_BREAKDOWN.md、test-designer→docs/TEST_CASES.md、reviewer→docs/review/{taskId}-REVIEW.md、tester→docs/TEST_REPORT.md、devops→docs/DEPLOY.md），coder 等非文档岗无 docs（AC-R1-1）;解析纯函数断言：docs 数组字段存在时按模板展开 {taskId}，docs 缺省时回退既有 stage.artifact 单值语义（researcher 等价），未知角色/缺 docs 不报错（AC-R1-5 前置兼容）;roles.json 既有字段语义逐字节不变（git diff roles.json 仅新增 docs 相关字段，prompt/gate/artifact/next 原文不动），roles.json JSON.parse 合法（board-plugin /api/config 整读等消费方不破坏）;plugins typecheck 0 诊断（tsc -p plugins/tsconfig.json --noEmit，受限时记录复现步骤）;node --test plugins/tests/worker-regression.test.mjs 既有用例不回归（宿主受限时如实记录）;零新增运行时依赖（plugins/package.json 无新增项）
- S2 | R-1b 结算自动登记与缺失门禁：done 结算在 commitWorktree 后 autoPromote 前按契约逐条登记（仓库相对路径、双写 hub/v1、多轮追加且同 path 字节未变幂等），契约文档缺失停 in_review 并写明确提示评论，完成评论给产出文档清单 | plugins/src/index.ts, plugins/tests/artifact-register.test.mjs | node --test plugins/tests/artifact-register.test.mjs 全绿（fixture 回放 requirement 岗 done：结算后任务记录 artifacts 追加 docs/REQUIREMENTS.md 条目，kind=file、path=仓库相对路径、by=守护、含登记时间；worker 报告未填 artifact 亦登记，AC-R1-2）;reviewer 岗结算把 {taskId} 解析为 docs/review/T-0xx-REVIEW.md 实际登记（AC-R1-3）;契约文档缺失时任务停在 in_review 不误判成功流转且评论含期望路径与已登记清单的明确提示（AC-R1-4），文档补全后重跑登记成功、提示消除并照常流转（G-R2 默认软门禁：缺才停）;gate 岗 researcher 既有行为不回归：文档存在时登记后仍走 in_review 人工验收评论，缺失走缺失提示（AC-R1-5）；非文档型岗位（coder）不产生任何契约登记，worker 自填 artifact 既有登记路径（plugins:1289）不回退;登记先于 autoPromote 执行（存在性以 worktree 目录为基准），hub 可用时 POST /api/artifact 双写否则走既有 taskctl artifact 路径，与既有 recordArtifact 双路径一致（plugins:943-949 惯例）;同任务同 path 与上一条登记字节未变时不重复登记（幂等防打回刷屏），变化则追加新条目（多轮倒序的数据源，AC-R2-3 前端依赖）;完成评论仅在有登记/有缺失时给产出文档清单摘要不刷屏（R-11）;plugins typecheck 0 诊断（受限时记录复现步骤）;node --test plugins/tests/worker-regression.test.mjs 既有用例不回归;零新增依赖
- S3 | R-3 v2 内容通道：team-hub 新增只读 GET /api/artifact/content（路径只取任务登记记录 + 仓库根白名单 + realpath/.git 防逃逸 + worktree 目录优先/主仓库兜底 + 存量绝对路径读取期兼容 + 超长截断/二进制/错误码） | team-hub/server.mjs, team-hub/artifact-content.test.mjs | node --test team-hub/artifact-content.test.mjs 全绿（临时 TEAM_HUB_DB + spaces.local_dir 指向临时仓库根 fixture，仿 skills.test.mjs 范式）;主分支态逐字一致：登记相对路径 docs/x.md 后 GET /api/artifact/content 返回内容与该文件 readFileSync 逐字一致（字节 diff 为空，AC-R3-1）;分支态逐字一致：同路径在 临时仓库根/.legion-worktrees/<id>/docs/ 下存在时返回 worktree 目录文件（source=worktree），删除该 worktree 目录后自动回退主仓库根文件（source=main）且内容逐字一致（AC-R3-2，K5-A worktree 优先/主仓兜底，零 git CLI）;路径安全：查询串 ?path= 等一律忽略/拒绝，登记路径含 ../ 越权、盘符、任一层 .git、仓库根外符号链接经 realpath 复检拒绝并返回 403 可区分错误（AC-R3-3）;读取规范：超 512KB 返回截断标志与可下载全文提示，含 NUL/非法 UTF-8 二进制返回 previewable=false 不白屏不报错（AC-R3-6）；错误码可区分 404（任务/条目/文件不存在）与 400（i 越界、无登记）（K9）;存量绝对路径记录兼容：命中 worktreeRoot/<id>/ 或 local_dir 前缀则剥前缀按同规则解析，否则 404 或明确文案（K10 读取期兼容，不跑迁移脚本）;端点为只读、不新增审计写动作，既有 hub 套件（skills/chat/calendar.test.mjs）不回归;零新增运行时依赖
- S4 | R-3 markdown 渲染组件：自研 MarkdownDocView 子集渲染器（React 元素直出、零依赖、原始 HTML 一律按文本、链接 href 协议白名单、不支持语法文本回退）及结构/安全自动化测试 | workbench/src/components/MarkdownDocView.tsx, workbench/scripts/doc-render.test.mjs | pnpm --dir workbench build 全绿（tsc --noEmit 0 诊断 + vite 产物，新组件参与编译；受限时记录复现步骤并附 tsc 结果）;node --test workbench/scripts/doc-render.test.mjs 全绿（node --test 或直跑等效；经 vite ssrLoadModule 载入组件 + react-dom/server renderToString 断言，无新增依赖）;结构可读：含 标题/段落/粗斜体/行内代码/围栏代码块/有序无序列表含嵌套/表格/引用/分割线/链接 的样例 md 渲染出对应结构且关键文本可见（AC-R3-4，D-5 可读等价）;渲染安全：含 script 标签注入、img onerror、javascript: 链接的样例渲染输出无 script 标签、无事件属性、无 javascript: 协议且内容按文本原样出现（AC-R3-5 冒烟等价断言）;代码审查断言：本切片源码 grep dangerouslySetInnerHTML 0 匹配，链接协议白名单常量集中一处可审计（http/https/mailto/相对路径/#），不支持的语法按文本回退不崩溃（K6-A 子集契约，AC-R3-5 审查面）;真实文档冒烟（宿主可用时）：docs/REQUIREMENTS.md、docs/RESEARCH.md 节选渲染不崩溃且标题/表格关键文本可见（R-6 缓解，不可达记录复现步骤）;样式落新增独立 css 或组件内联，不改 workbench/src/index.css（S5 文件域）;workbench/package.json 零新增依赖
- S5 | R-2 S1 详情产出文档直达区：TaskDetailModal 新增小节（标题+岗位+时间+路径小字可复制 + 点击同屏内嵌 MarkdownDocView 渲染视图 + 多轮倒序最新高亮 + 空态占位），api.ts 新增 fetchHubDocContent 取内容，types.ts 扩展产物类型 | workbench/src/components/TaskDetailModal.tsx, workbench/src/api.ts, workbench/src/types.ts, workbench/src/index.css | pnpm --dir workbench build 全绿（tsc 0 诊断，受限时记录复现步骤）;宿主冒烟（workbench/scripts/serve.mjs 托管 + hub，不可达时记录复现步骤不冒充通过）：打开文档型 in_review 任务详情存在「产出文档」区且列出登记文档 ≥1 条（标题+岗位+时间+相对路径），无需展开 diff、无需输入或复制任何路径（AC-R2-1）;点击条目后同屏出现内嵌渲染视图（max-height 滚动容器 + 截断提示），可见文档全文而非仅摘要/路径/下载按钮，经 MarkdownDocView 渲染（AC-R2-2，D-9 内嵌为主 + 新标签钮可选）;多轮可见：同一任务两条及以上登记按时间倒序最新在首并高亮，旧条目仍可打开（AC-R2-3，条目数据由 S2 结算追加）;非文档型岗位或无登记任务不显示「产出文档」区或显示中性占位且页面不报错（AC-R2-4）;既有产物区 url 外链/file 下载/html 语义逐条保留不回退（AC-R2-5）；内容拉取 404/403/超长截断/二进制等错误呈现明确文案不白屏（K9 前端守卫）;渲染安全：详情内容一律经 MarkdownDocView 文本节点渲染，grep 断言无 dangerouslySetInnerHTML 直插服务端内容
- S6 | R-4 S2 经典看板详情逐条可交互（服务态）：render.mjs 产物区升级为逐条条目（kind 徽标+title+时间+路径，md/txt 安全预览弹层，多条 html 逐条独立 iframe，url/file 语义保留，file:// 双击模式明确降级提示），serve.mjs /api/artifact 升级为逐条内容服务（md 按 text/markdown，白名单相对路径解析） | scrum/render.mjs, scrum/serve.mjs, scrum/artifact-detail.test.mjs | node --test scrum/artifact-detail.test.mjs 全绿（fixture 任务库经临时替换或环境注入实现、测试自清理真实数据不受影响，仿 taskctl.ttl.test.mjs 范式）;node scrum/render.mjs --out 临时目录生成 kanban.html：产物区出现逐条条目（kind 徽标 + title + 时间 + 路径），md/txt 条目带「预览」动作，两条 html 各带独立预览入口而非仅最新一条（AC-R4-1/2，K8-A）;md 预览为安全渲染：输出全部转义、仅白名单协议或 pre 纯文本兜底，生成 HTML 不含未转义直插的原始 HTML，含 script 注入的样例 md 按文本显示无执行（K6 同规则 v1 面，AC-R4-1 安全）;url 外链/file 下载语义保留（AC-R4-3）；file:// 双击模式（无服务）预览动作降级为显示路径与「服务模式（serve.mjs / DSH /api）下可预览」提示（K8-C 边界，生成文件含降级分支）;serve.mjs GET /api/artifact 按任务与条目序 i 返回对应条目真实文件内容（md 按 text/markdown），i 缺省时兼容既有语义取最新一条，i 越界/未知任务返回 4xx 可区分，相对路径按 repoRoot 白名单解析、../ 与 .git 段拒绝（AC-R3-3 v1 面，K4-B）;node scrum/render.mjs（真实任务库）无错，node --test scrum/taskctl.ttl.test.mjs 既有用例不回归;零新增依赖
- S7 | R-4 DSH board-plugin 内容服务逐条化：/api/artifact 由仅最新一条（board:86 slice(-1)）升级为按条目序 i 逐条 + md/text 语义，artifactAllowed 白名单兼容仓库相对路径与分支态目录 | board-plugin/src/index.ts | pnpm --dir board-plugin typecheck 0 诊断（tsc -p tsconfig.json --noEmit，受限时记录复现步骤）;pnpm --dir board-plugin build（bash scripts/build.sh + tsdown，宿主可跑时）无错且产物 lib/ 生成;GET /api/artifact 按任务与条目序 i 逐条返回与 serve.mjs 同语义：i 缺省兼容取最新，i 越界/未知任务 4xx，md 文件按 text/markdown，raw 分支字节直读（K4-B，board:75-110 升级）;相对路径条目经 artifactAllowed（repoRoot+artifactRoots 白名单，board:66-73）normalize 后解析，../ 越权、盘符、.git 段、符号链接逃逸拒绝;与 S6 共用同一 client 契约：DSH 托管态 kanban.html 逐条预览可点通（宿主可达时冒烟，不可达记录复现步骤）;既有 DSH 看板/拖拽/SSE/board 路由不回归（宿主可用时）；零新增依赖
- S8 | 集成回归锚定与端到端验收：全批各套件逐项运行记录 + 任务详情预览 E2E 清单写入 docs/TEST_REPORT.md（主分支态/未 promote 分支态/缺失提示/打回多轮/渲染安全样例） | docs/TEST_REPORT.md | docs/TEST_REPORT.md 记录全批运行输出要点：node --test team-hub/artifact-content.test.mjs 与既有 team-hub 套件全绿;node --test plugins/tests/doc-contract.test.mjs 与 plugins/tests/artifact-register.test.mjs 全绿（宿主受限时如实记录环境+复现步骤）;node --test scrum/artifact-detail.test.mjs 全绿;pnpm --dir workbench build 与 pnpm --dir board-plugin typecheck 均 0 诊断;E2E 场景（宿主可用时执行，不可达如实记录）：requirement 型任务（T-103 样例或等价回放）结算后任务记录 artifacts 含 docs/REQUIREMENTS.md 条目（AC-R1-2），workbench 详情「产出文档」区点击内嵌预览与主仓库该路径文件逐字一致（AC-R2-1/2、AC-R3-1）;未 promote 分支态 fixture：预览内容与 w/<id> 分支文件逐字一致（AC-R3-2）；契约文档缺失任务停 in_review 且评论提示含期望路径（AC-R1-4）；打回重做后多轮条目按时间倒序可见且最新可预览（AC-R2-3）;S2 经典看板（serve.mjs 或 DSH 托管任一）打开同任务 md 条目出现可读预览、两条 html 逐条可预览（AC-R4-1/2）；含 script/img onerror/javascript: 注入的样例 md 无脚本执行（AC-R3-5）;零新增运行时依赖复核（git diff 无 package.json 依赖变更）；本批新增/修改源码 grep dangerouslySetInnerHTML 0 匹配（AC-R3-5 审查断言）

## 2. 依赖关系、执行顺序与并行（给人看）

### 2.1 blockedBy 一览（注册序执行时）与工作量

| 切片 | blockedBy（注册序执行时） | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | R-1 契约数据模型为登记（S2）的前置；仅新增字段不动既有语义 | M |
| S2 | S1（同 plugins/src/index.ts 硬串行 + 契约模型先合入） | 结算登记/门禁在 S1 的 StageDef.docs 解析之上实现 | L |
| S3 | 无（行内起点，fixture 自造登记数据先行；真实登记数据语义在 S2，验收不互卡） | hub 内容端点只消费既有 artifacts 条目字段，不依赖 S1/S2 代码 | L |
| S4 | 无（行内起点） | 渲染组件为独立新文件，可先行开发与单测 | L |
| S5 | S2（登记条目在真实数据面出现后做 E2E 冒烟）+ S3（内容端点合入可拉取）+ S4（MarkdownDocView 合入可 import） | S1 详情直达区依赖内容通道与渲染组件；冒烟样例数据依赖 S2 | M |
| S6 | S2（相对路径登记语义合入后真实库可验收，fixture 可先行） | S2 经典看板逐条预览针对登记文档；服务端读相对路径 | M |
| S7 | S6（render.mjs kanban.html 逐条 UI 与 client 契约先合入，DSH 冒烟才成立） | board-plugin 与 S6 共用同一前端契约，端点语义对齐 serve.mjs | S |
| S8 | S1~S7 全部 done | 集成回归锚定必须在收口后执行 | M |

**无循环依赖**：所有边沿沿「契约/数据面（S1/S2）→ 内容面（S3）→ 渲染/UI 面（S4/S5、S6/S7）→ 集成回归（S8）」方向；同文件链仅 plugins/src/index.ts（S1→S2）与 board 契约链（S6→S7），均为线性无回边。R-1~R-4 全部 AC-* 均有归属切片（§2.3），无遗漏。

### 2.2 执行顺序与并行建议

- **默认安全路径（当前生产守护单 worker，按注册顺序派工）**：S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8。注册顺序即派工顺序，本清单已按依赖拓扑排好。
- **若将军提升并发槽位（maxWorkers ≥ 2）**：只允许派工**文件域两两不相交**的组合（见 §1 每行第 2 段）；**严禁**同时派工同一文件的相邻切片——S1/S2 互斥（同 plugins/src/index.ts）。域不相交且无 blockedBy 即可并行的示例：{S3, S4}（team-hub vs workbench）、{S1, S3, S4}（契约解析 vs hub 端点 vs 渲染器）、{S2, S3}（结算 vs 内容端点，S2 不依赖 S3）、{S4, S6} 等。S5 必须在 S3/S4 之后，S7 必须在 S6 之后，S8 永远最后。
- **同文件跨切片唯一场景**：plugins/src/index.ts 归 S1 与 S2 两个不同函数域（S1=StageDef/roles 契约解析段，S2=done 结算/recordArtifact 登记段）——按注册顺序天然串行，禁止并发；workbench/src/index.css 只归 S5（S4 样式落新增独立 css 文件，避免同文件交叉）。
- **文档级共享说明**：README.md / LEGION.md / workbench/README / scrum/README 等不列入任何切片第 2 段文件域（文档级冲突可语义合并，仿 T-097 惯例）；各切片实现时按需同步更新受影响说明（仓库纪律「修改行为同时更新受影响文档」）。
- **验收样例数据（供下游直接用，见 REQUIREMENTS §10.3）**：T-103（requirement 岗，docs/REQUIREMENTS.md 已 promote 进主仓库）与 T-104（researcher gate，docs/RESEARCH.md 已 promote）即 R-1/R-2/R-3 的主分支态天然验收样例；「未 promote 分支态」用 devops/末环节点任务或合入失败样例/fixture 模拟（AC-R3-2）。

### 2.3 需求 → 切片覆盖映射（无遗漏检查）

| 需求（T-103 §5） | 覆盖切片 | 对应验收口径 |
| --- | --- | --- |
| R-1 岗位文档契约 + 自动登记 + 缺失提示（P0） | S1 + S2 | AC-R1-1..5（S1：契约存在性/兼容；S2：自动登记/动态文件名/缺失提示/gate 不回归） |
| R-2 S1 详情「产出文档」直达区（P0） | S5 | AC-R2-1..5 |
| R-3 文档内容预览（P0） | S3（服务端通道与逐字/安全/边界）+ S4（md 渲染结构与安全）+ S5（内嵌接入）；v1 面另由 S6/S7 覆盖 | AC-R3-1/2/3/6（S3）、AC-R3-4/5（S4，审查断言 S4/S5/S8）、AC-R3-7（S6/S7 + S8 回归） |
| R-4 S2 经典看板详情补齐（P1） | S6 + S7 | AC-R4-1/2（S6）、AC-R4-2 服务面（S6/S7）、AC-R4-3（S6/S8） |
| REQUIREMENTS §6 端到端总口径（happy path + 缺失/未 promote/打回/安全边界） | S8 | §6 1~5 全部条目 |

## 3. 子任务明细（每切片 = 一个士兵一轮可完成并验收；「验收」以 §1 机器行逐条为准；工作量刻度 S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满）

#### S1 R-1a 岗位文档契约数据模型【P0 · R-1 数据面起点（roles.json + plugins 解析段）】
- **目标**：按 RESEARCH K1-A/K10——roles.json 七个文档型 stage 各新增 docs 数组字段（对象含 path/title/required 或简化字符串均可，字段形态以 K1-A 建议为准），path 与各岗 prompt 现行路径约定逐字一致（reviewer 模板 docs/review/{taskId}-REVIEW.md）；plugins StageDef 增加 docs 契约解析（含 {taskId} 占位语义，与 roles 载入/消费段 :151-171/:473-479 同区）；读取兼容统一为 docs 缺省时回退 artifact 单值（即 docs = stage.docs ?? (stage.artifact ? [stage.artifact] : [])）；researcher 既有 gate/artifact 字段与 gate 语义**逐字节不动**。roles.json 全仓消费方（board-plugin /api/config 整读、taskctl/守护 pipeline）协议不被破坏。
- **产出（文件域）**：roles.json（七岗各加 docs，仅新增字段）；plugins/src/index.ts（StageDef.docs 与解析/兼容函数段）；plugins/tests/doc-contract.test.mjs（新增：契约清单 + 模板展开 + 回退兼容 + 非法输入断言）。
- **依赖**：无（行内起点）。**工作量**：M。**完成 =（DoD）**：doc-contract.test.mjs 全绿（host build 后直跑；受限时记录复现步骤不冒充通过）+ roles.json 仅新增 docs 字段的 git diff 核对 + plugins typecheck 0 诊断 = 完成；不引入任何登记/流转行为变化。
- **测试锚点（test-designer 直转）**：七岗契约 path 与 prompt 对照逐条断言；{taskId} 占位解析（含 reviewer）；docs 缺省回退 artifact；非文档岗/未知角色空契约不抛错；roles.json JSON 合法与既有字段逐字节（git diff）。
- **纪律**：不改任何 prompt/gate/artifact/next 文本；零新增依赖；只改上述三文件。

#### S2 R-1b 结算自动登记与缺失门禁【P0 · plugins 结算段，S1 的串行后继】
- **目标**：按 RESEARCH K2-A/K3-A（G-R2 默认软门禁）——done 结算主路径（plugins:1285-1334）在 commitWorktree（:1287）之后、autoPromote（:1292）之前执行「契约逐条登记」：解析 {taskId} 模板 → relPath → 以 worktree 目录为基准做存在性检查 → 登记条目（kind=file、path=relPath、title=岗位标签+文档说明、by=守护、at=当前时间）；hub 可用时 POST /api/artifact、否则走既有 taskctl artifact 双写（沿用 recordArtifact :943-949 双路径）。登记动作与现有 worker 自填 artifact（:1289）共存不互斥；同 path 与上一条登记字节未变 → 幂等跳过，变化 → 追加（多轮数据源）。缺失 → 任务停 in_review + 明确提示评论（含期望路径与已登记清单）；存在 → 非 gate 岗照旧流转、gate 岗（researcher）照旧 in_review 人工验收评论。完成评论泛化给出「产出文档清单」摘要（仅登记/缺失时写，防刷屏 R-11）。
- **产出（文件域）**：plugins/src/index.ts（done 结算段 :1285-1334 与 recordArtifact 段周边重构）；plugins/tests/artifact-register.test.mjs（新增：回放 requirement/reviewer 岗 done 的登记/缺失/幂等/双写断言，仿 worker-regression.test.mjs 的 fake-hub fixture 范式）。
- **依赖**：S1。**工作量**：L。**完成 =（DoD）**：artifact-register.test.mjs 全绿 + worker-regression.test.mjs 不回归 + AC-R1-2/3/4/5 各有一断言（真实命令输出为证）+ plugins typecheck 0 诊断 = 完成。
- **测试锚点**：requirement 岗自动登记（worker 未填 artifact）；reviewer 动态文件名解析登记；缺失文档 → in_review + 评论期望路径；补齐重跑提示消除；researcher gate 行为不回归；coder 零登记 + 自填 artifact 不回退；登记先于 autoPromote（fixture 断言合入前条目已存在）；双写两分支（hub mock / taskctl argv）；幂等与多轮追加。
- **纪律**：登记时机不得晚于 autoPromote（否则 worktree 已删无法存在性检查）；路径一律仓库相对；零新增依赖。

#### S3 R-3 v2 内容通道【P0 · team-hub 读端点，独立可先行】
- **目标**：按 RESEARCH K4-A/K5-A/K9/K10——team-hub 新增只读 GET /api/artifact/content：任务记录取第 i 条 artifacts.path（不读任意查询串）→ 归属空间 scope → spaces.local_dir 作仓库根 → 规范化 relPath（.. 拒绝 + realpath 前缀复检 + 任一层 .git 拒绝，照 wserve:9-16/:384 纪律）→ 文件系统解析「.legion-worktrees/<id>/<rel> 优先、local_dir/<rel> 兜底」→ 返回 content/truncated/size/source(worktree|main)/relPath（md 按 text/markdown；超 512KB 截断带提示；NUL/非法 UTF-8 → previewable=false）；存量绝对路径前缀（worktreeRoot/<id>/、local_dir）剥除兼容；404/400/403 错误码可区分。
- **产出（文件域）**：team-hub/server.mjs（新增端点 + 白名单读函数 + 解析规则；消费 spaces 表 local_dir :130-147）；team-hub/artifact-content.test.mjs（新增，仿 skills.test.mjs：临时 TEAM_HUB_DB + 临时仓库根 fixture 双树：主树 + .legion-worktrees/<id>/ 分支树）。
- **依赖**：无（行内起点；fixture 自造任务与登记条目）。**工作量**：L。**完成 =（DoD）**：artifact-content.test.mjs 全绿且 AC-R3-1/2/3/6 各有断言 + 错误码/legacy 用例 + 既有 hub 套件不回归 = 完成。
- **测试锚点**：主分支态逐字（读文件字节比对）；分支态 worktree 优先与删目录后回退；../、盘符、.git、符号链接逃逸 403；512KB 截断提示；二进制 previewable=false；404/400 枚举；legacy 绝对路径前缀兼容；只读无审计写。
- **纪律**：路径只取自登记记录；不跨空间（按 scope.local_dir）；零 git CLI、零新增依赖；端点不写库不动审计。

#### S4 R-3 markdown 渲染组件【P0 · workbench 新组件，独立可先行】
- **目标**：按 RESEARCH K6-A + D 兜底（G-R3/G-R4 默认：不放行依赖、不豁免 innerHTML 红线）——自研可控子集渲染器 MarkdownDocView.tsx：支持 标题/段落/粗斜体/行内代码/围栏代码块/有序无序列表（含嵌套）/表格/引用/分割线/链接/图片；原始 HTML 一律按文本显示；href 协议白名单（http/https/mailto/相对路径/#）集中常量；输出 React 元素树（无 dangerouslySetInnerHTML）；不支持语法（脚注/删除线/任务列表等）按文本回退并在文件头注释写明契约（D-5 纯文本为合法最低档，超长/异常共用 pre 文本兜底）。样式落新增独立 css（组件 import）或内联，**不改 index.css**。
- **产出（文件域）**：workbench/src/components/MarkdownDocView.tsx（新增，可含同目录新增样式文件）；workbench/scripts/doc-render.test.mjs（新增：经 vite ssrLoadModule 载入 + react-dom/server renderToString 的结构/安全断言；无新增依赖）。
- **依赖**：无（行内起点）。**工作量**：L。**完成 =（DoD）**：doc-render.test.mjs 全绿（结构样例 + 脚本注入安全样例）+ 构建全绿 + grep 无 dangerouslySetInnerHTML + 真实文档冒烟（宿主可用时）= 完成。
- **测试锚点**：六类结构样例关键文本；script/img onerror/javascript: 注入无执行且按文本；未知语法回退不崩溃；协议白名单命中集中常量；真实文档（REQUIREMENTS/RESEARCH 节选）渲染冒烟。
- **纪律**：零新增依赖；不引入 dangerouslySetInnerHTML；不改 index.css（S5 文件域）。

#### S5 R-2 S1 详情「产出文档」直达区【P0 · workbench 壳文件，S1 主验收面】
- **目标**：按 RESEARCH K7-A——TaskDetailModal 产物区（:419-434）上方新增「产出文档」小节：来源 = 任务记录 artifacts 中 kind=file 且扩展名 md/markdown/txt 的条目（叠加既有手工 artifact 不互斥）；每条 = 标题（岗位标签）+ 时间 +「打开」钮 + 路径小字可复制；点击 → 同屏展开内嵌渲染面板（MarkdownDocView，max-height 滚动容器 + 截断提示），「新标签打开」钮可选（D-9）；多轮按时间倒序、最新高亮、旧条目标注可打开（AC-R2-3）；非文档岗/无登记显示中性空态不报错（AC-R2-4）；拉取失败/超长/二进制给明确文案。api.ts 新增 fetchHubDocContent(taskId, i) → hub GET /api/artifact/content（走既有 hubBase 代理）；types.ts 扩展内容响应类型。
- **产出（文件域）**：workbench/src/components/TaskDetailModal.tsx、workbench/src/api.ts、workbench/src/types.ts、workbench/src/index.css（本小节样式，S4 不得染指）。
- **依赖**：S2（E2E 冒烟数据）+ S3（内容端点）+ S4（渲染组件 import）。**工作量**：M。**完成 =（DoD）**：pnpm --dir workbench build 全绿 + 宿主冒烟走通「详情 → 产出文档区 → 点击 → 内嵌预览全文」（不可达记录复现步骤）+ 无 innerHTML 直插 = 完成。
- **测试锚点**：列表字段渲染/倒序/空态；点击拉取与渲染；404/403/截断/二进制错误文案；url/html/file 既有条目逐条不回退；路径复制。
- **纪律**：渲染一律走 MarkdownDocView 文本节点；只改上述四文件；不新增依赖。

#### S6 R-4 S2 经典看板逐条可交互（服务态）【P1 · scrum 面】
- **目标**：按 RESEARCH K8-A/B/C——render.mjs 详情产物区（render:437）升级为逐条条目：每条 kind 徽标 + title/时间 + 路径；md/txt（kind=file 且扩展名 md/txt）条目带「预览」钮 → 弹层以与 K6 同规则的安全小渲染（全部转义/白名单协议/pre 纯文本兜底，不透传原始 HTML）呈现；html 多条逐条独立 iframe（解除仅最新 slice(-1)）；url 外链、file 下载保留；file:// 双击模式（无服务，无法 fetch）预览动作降级为路径 + 服务模式提示。serve.mjs /api/artifact（serve:452-480）升级为按任务与条目序 i 逐条取（i 缺省兼容最新），md 按 text/markdown，repoRoot 白名单 + ../ 与 .git 拒绝，错误码可区分。
- **产出（文件域）**：scrum/render.mjs、scrum/serve.mjs；scrum/artifact-detail.test.mjs（新增：fixture 任务库 → render 产物断言 + serve 端点逐条断言，测试经临时任务库替换或环境注入自清理，真实数据不受影响）。
- **依赖**：S2（登记语义合入后真实库可验收；fixture 可先行）。**工作量**：M。**完成 =（DoD）**：artifact-detail.test.mjs 全绿 + node scrum/render.mjs 真实库无错 + taskctl.ttl.test.mjs 不回归 = 完成。
- **测试锚点**：逐条条目渲染；md 安全预览（脚本样例按文本）；两条 html 各自可预览；url/file 保留；file:// 降级分支存在；serve i 参数逐条与越界 4xx；相对路径白名单解析。
- **纪律**：与 K6 同规则安全渲染（v1 无 React，转义/白名单为底线）；零新增依赖。

#### S7 R-4 DSH board-plugin 内容服务逐条化【P1 · DSH 托管态】
- **目标**：按 RESEARCH K4-B——board-plugin /api/artifact（board:66-110）由「仅取登记最后一条」（:86 slice(-1)）升级为按条目序 i 逐条 + md/text 语义（raw 分支字节直读），artifactAllowed 白名单（repoRoot+artifactRoots :66-73）兼容仓库相对路径（含 .legion-worktrees 分支态目录在根内）；i 缺省兼容；与 S6 共用同一前端契约，DSH 托管 kanban.html 上逐条预览可点通。
- **产出（文件域）**：board-plugin/src/index.ts。
- **依赖**：S6（client 契约与 kanban.html 逐条 UI 先行合入，DSH 冒烟成立）。**工作量**：S。**完成 =（DoD）**：typecheck 0 诊断 + build 产物（宿主可跑时）+ 端点语义代码审查对齐 serve.mjs + DSH 冒烟（宿主可达时）= 完成。
- **测试锚点**：i 逐条返回/缺省兼容/越界 4xx/md content-type；相对路径与越权拒绝；raw 分支。
- **纪律**：与 serve.mjs 等价语义不产生第三套行为；零新增依赖。

#### S8 集成回归锚定【收口 · 全批】
- **目标**：全批套件逐项运行并记录输出要点到 docs/TEST_REPORT.md；端到端验收清单覆盖 REQUIREMENTS §6 全部边界（主分支态逐字、未 promote 分支态逐字、缺失提示、打回多轮倒序、渲染安全样例）；零新增依赖与 innerHTML 红线全仓复核。
- **产出（文件域）**：docs/TEST_REPORT.md（增补本批 E2E 清单与结果）。
- **依赖**：S1~S7 全部 done。**工作量**：M。**完成 =（DoD）**：TEST_REPORT.md 落盘 + 各套件真实运行记录（宿主受限处如实标注环境与复现步骤，不冒充通过）+ E2E 条目逐条有结果 = 完成。
- **测试锚点**：§1 S8 机器行逐条（命令 + 期望）。
- **纪律**：只做验证与报告；不改实现代码。
