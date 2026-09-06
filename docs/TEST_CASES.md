# T-106 测试用例 / 验收测试：环节产出文档在任务详情直接打开预览（岗位文档契约 → 自动登记 → 详情直达预览）

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-106（分支 w/T-106 独立 worktree）
> 上游：T-103 需求澄清（docs/REQUIREMENTS.md 现行版 = 本特性唯一权威需求基线：R-1~R-4 编号需求 + AC-R1-1..5 / AC-R2-1..5 / AC-R3-1..7 / AC-R4-1..3 可测口径 + D-1~D-10 默认值 + §6 端到端总口径）→ T-104 方案搜索（docs/RESEARCH.md 现行版：K1-A..K10-A 一等选型 + 闸门 G-R1..G-R8）→ T-105 任务拆解（docs/TASK_BREAKDOWN.md 现行版：**「## slices」8 个切片 S1~S8**，本用例唯一拆解基准；每片机器验收行含命令/期望/DoD，均已映射 R-1~R-4 的 AC-* 口径）
> 下游：守护按 TASK_BREAKDOWN 注册 coder_Si → tester_Si 微链；coder 按本文档 §4 各表「自动化」列与附录 B 骨架把 P0 用例落成对应测试文件断言；tester 按 §2 分层逐条执行并把结果写入 docs/TEST_REPORT.md（S8 收口）
> 依据：TASK_BREAKDOWN §1 机器验收行（每片 DoD/验收标准分句逐条翻译，下文以「Sx 验收 n」引用）、T-103 REQUIREMENTS §5/§6/§8、T-104 RESEARCH 闸门与设计要点、LEGION.md 纪律与本任务阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望与通过判据；验收标准用例化；关键业务规则正反向成对）。
>
> **取代声明**：本文档取代 docs/TEST_CASES.md（T-098 第三批四能力版；该批切片已交付合入 main，执行记录在 docs/TEST_REPORT.md 与各 Tx-evidence/）。旧版经 git 历史回溯（git log --follow docs/TEST_CASES.md）。历史测试文件头注释中的「TC-Sx-yy」编号指更早批次快照，不再与本文档对齐——本批追溯列一律以「S1~S8 机器验收行 / AC-Rx-y / §6 E2E-n」为准。

## 0. 结论速览

- 交付单件：本文档（+ 证据目录 docs/T106-evidence/，含机器复核 01-doc-machcheck.txt）。共 **82 条用例**（S1 13 / S2 10 / S3 15 / S4 12 / S5 10 / S6 8 / S7 6 / S8 8；🟢正常 46 / 🟡边界 18 / 🔴异常 18；P0=71 / P1=11，机器复核 PASS 见附录 C），每条含 前置条件 / 操作步骤 / 期望结果与通过判据；计数/ID 唯一性/表结构/追溯引用完整性已经一次性 Node 脚本复核（docs/T106-evidence/01-doc-machcheck.txt），无重复 ID、无引用缺失。
- 验收标准用例化：TASK_BREAKDOWN §1 机器验收行（S1~S8 每行分句）+ T-103 AC-R1-1..5 / AC-R2-1..5 / AC-R3-1..7 / AC-R4-1..3 + REQUIREMENTS §6 E2E 1~5 逐条映射到用例（§4 各表「追溯」列 + §6 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，无黑盒结论。
- 关键业务规则正反向成对（§5）：文档契约解析（模板展开/回退/不回归）、自动登记（登记成功/缺失停 in_review/补齐重跑）、双写与幂等（登记先于 autoPromote/重复登记不刷屏/变化追加）、内容通道（主分支态逐字/分支态优先与兜底/路径逃逸 403/只读）、读取规范（512KB 截断/二进制/错误码/存量绝对路径兼容）、渲染（md 结构可读/脚本注入不执行/协议白名单/未知语法文本回退）、UI 直达（产出文档区可达/空态/多轮倒序/错误文案/既有产物语义不回退）、S2 看板逐条（逐条可预览/多条 html/file:// 降级/url/file 语义保留）——均给正向 + 反向用例。
- 测试代码落点：S1→plugins/tests/doc-contract.test.mjs（新增）、S2→plugins/tests/artifact-register.test.mjs（新增）、S3→team-hub/artifact-content.test.mjs（新增，HTTP 范式仿 calendar.test.mjs / skills.test.mjs）、S4→workbench/scripts/doc-render.test.mjs（新增，vite ssrLoadModule + renderToString）、S6→scrum/artifact-detail.test.mjs（新增，仿 taskctl.ttl.test.mjs）、S7→board-plugin 端点语义评审 + DSH 冒烟、S5/S7 前端 → L2 浏览器清单 + 评审（grep/build 断言）、S8→docs/TEST_REPORT.md 收口。骨架与代码片段见附录 B。**本阶段不新增/不预写切片域内可执行测试文件**（同既往批次惯例：S1~S8 目标代码未实现，预写必全红；测试文件所有权已由 TASK_BREAKDOWN §1 第 2 段划给各 coder 文件域），仅交付用例 + 可照抄骨架。
- 现存基线（仅环境事实，本阶段不执行用例——执行为 tester 职责）：本 worktree 无 node_modules/dist（不随 git 分发）；plugins typecheck（tsc -p plugins/tsconfig.json --noEmit）、workbench build（pnpm --dir workbench build）、board-plugin typecheck/build 需宿主/CI 或 junction，按「环境受限 + 复现步骤」记录不冒充通过（仓库 R-18 惯例）；沙箱因子进程 spawn EPERM 史 → node --test 受限时以 node 直跑等效或如实记录。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入与假设

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS（T-103 现行版，本 worktree docs/REQUIREMENTS.md）§5/§6 | R-1（P0 岗位文档契约+自动登记 AC-R1-1..5）/ R-2（P0 S1 详情直达区 AC-R2-1..5）/ R-3（P0 内容预览 AC-R3-1..7）/ R-4（P1 S2 看板补齐 AC-R4-1..3）+ §6 E2E 1~5 + D-1~D-10 默认值——验收口径逐条可测试 |
| TASK_BREAKDOWN.md（T-105 现行版）§1 | S1~S8 机器验收行（每行命令/期望/DoD 分句）——本用例逐条翻译对象；§2.1 blockedBy 与工作量；§2.3 需求→切片覆盖映射 |
| RESEARCH.md（T-104 现行版） | K1-A..K10-A 一等落点 + 闸门 G-R1..G-R8（G-R2 软门禁、G-R3 零新依赖、G-R4 不豁免 innerHTML、G-R5 512KB、G-R6 不做字节级历史回看、G-R7 单机同仓、G-R8 读取期兼容不迁移） |
| 代码基线 | w/T-106 HEAD == fa9c568 promote T-105（T-103/T-104/T-105 仅改 docs，代码与需求 §2 证据所指 main 同源；S1~S8 目标代码未实现，本文件以「目标行为」描述用例） |
| 假设 H-1 | roles.json stage.docs 字段形态 = 对象数组（含 path/title/required 或等价），与 stage.artifact/gate 同源同文件；实现简化成字符串数组亦可，本文件断言以「归一化后每元素可解析出 path」为准（K1-A；D-1） |
| 假设 H-2 | 契约文档缺失 = 结算时以 worktree 目录为基准判存在（登记先于 autoPromote，D-7/G-R2）；缺失提示评论含期望路径与已登记清单 |
| 假设 H-3 | v2 内容端点形状：GET /api/artifact/content?task=<id>&i=<n>（任务记录取第 i 条登记 path；不读任意查询串指定文件）；响应 {ok, content, truncated, size, source, relPath, previewable}，md 按 text/markdown；v1 端点 serve.mjs /api/artifact 扩展 i 参数同语义（K4-A/K4-B；实现若改参数名仅改请求形状，断言语义不变） |
| 假设 H-4 | 分支态目录布局 = <仓库根>/.legion-worktrees/<任务ID>/<relPath>（K5-A worktree 目录优先、主仓库根兜底、零 git CLI；G-R7 单机同仓成立） |
| 假设 H-5 | 预览上限 512KB（G-R5）：超限返回 truncated=true + 截断提示 + 可下载全文提示；不静默截断 |
| 假设 H-6 | md 渲染 = 自研 MarkdownDocView 子集（K6-A 零依赖）：支持 标题/段落/粗斜体/行内代码/围栏代码块/有序无序列表（含嵌套）/表格/引用/分割线/链接/图片；原始 HTML 一律按文本；不支持语法（脚注/删除线/任务列表等）文本回退并在文件头注释写明契约；链接协议白名单常量集中一处（http/https/mailto/相对路径/#） |
| 假设 H-7 | 完成评论产出清单仅在「有登记或有缺失」时写（R-11 防刷屏），格式含「产出文档：docs/…」行 |
| 假设 H-8 | S2 详情「产出文档」区条目 = 任务记录 artifacts 中 kind=file 且扩展名 md/markdown/txt 的条目（叠加既有手工 artifact 不互斥；多轮修订按登记时间倒序，最新高亮；AC-R2-3 依赖 S2 幂等/追加语义） |

### 1.2 决策闸门默认值（G-R1..G-R8 + D 系列，本用例判定依据；将军未否决即按默认展开）

| 闸门/决策 | 默认（本用例按此展开） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| G-R1 = D-1 | roles.json stage 新增 docs 字段（与 artifact/gate 同源） | 守护侧独立配置表 | S1 整组从 roles.json 断言改为配置表断言 |
| G-R2 = D-7 | 软门禁：契约文档缺才停 in_review + 缺失提示；有文档的文档型岗位照旧流转；gate 岗（researcher）照旧 in_review 人工验收 | 缺失不拦截 / 全岗硬门禁 | TC-S2-03/04 期望翻转 |
| G-R3 | 不放行新运行时依赖 → 渲染器自研零依赖 | 引入 react-markdown/marked | S4 整组断言面改变（依赖面审查 I-1 失效=FAIL） |
| G-R4 | 不豁免 dangerouslySetInnerHTML 红线 | 渲染可 innerHTML | TC-S4-11/TC-S5-08/TC-S8-08 grep 断言翻转 |
| G-R5 | 预览上限 512KB 截断可下载 | 不限长 | TC-S3-07 期望变化 |
| G-R6 | 不做字节级历史回看（多轮以登记条目呈现） | 版本库 | S3/S5 不新增历史断言面 |
| G-R7 | 单机部署：预览服务与仓库同机、spaces.local_dir=仓库根 | 远程内容网关 | S3 fixture 形态变化 |
| G-R8 | 存量绝对路径记录读取期兼容、不跑迁移 | 迁移脚本 | TC-S3-10 期望变化 |
| D-2/D-4 | 七岗各一条主文档登记；evidence 目录不默认登记；kind=file + 扩展名识别 md 渲染（不动 html/file/url 既有 kind 白名单） | 登记 evidence/新增 kind=markdown | TC-S2-09 期望翻转；S5 条目过滤条件变化 |
| D-8/D-9 | 多轮按时间倒序列表、最新可预览、旧版保留条目；内嵌同屏 + 新标签钮可选 | 只显示最新 | TC-S5-04 期望变化 |
| D-10 | 预览不跨空间：只读本任务归属仓库根内文件 | 全部空间聚合跨空间读 | TC-S3-15 期望翻转 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（全批各 package.json 无新增项） | TC-S1-12 / TC-S2-10 / TC-S3-13 / TC-S4-11 / TC-S6-08 / TC-S8-08 |
| I-2 | 渲染安全红线：React 一律文本节点、无 dangerouslySetInnerHTML 直插服务端/远端内容；v1（无 React）输出全转义或 pre 纯文本兜底；链接协议白名单集中一处可审计 | TC-S4-04/05/06/11 / TC-S5-08 / TC-S6-03 / TC-S8-07 |
| I-3 | 内容通道只读：路径只取任务登记记录（不读任意查询串）；仓库根白名单 + realpath 前缀复检 + 任一层 .git 拒绝；端点不新增审计写动作 | TC-S3-04/05/06/11 / TC-S6-05 |
| I-4 | roles.json 只新增 docs 字段：prompt/gate/artifact/next 原文逐字节不变；board-plugin /api/config 整读、taskctl/守护 pipeline 读 roles 不破坏 | TC-S1-05/06/12 |
| I-5 | 老库零迁移：存量绝对路径登记记录读取期兼容（剥前缀按同规则解析），不跑迁移脚本 | TC-S3-10 / TC-S6-05（既有语义不回退） |
| I-6 | 结算登记时机与幂等：登记在 commitWorktree 后、autoPromote 前；同 path 同字节幂等跳过、变化追加；双写 hub/v1（与既有 recordArtifact 双路径一致） | TC-S2-05/06 / TC-S2-01 |
| I-7 | 软门禁（G-R2）：契约文档缺失 → 任务停 in_review + 明确提示（含期望路径与已登记清单）；文档存在照常流转；非文档岗零契约登记 | TC-S2-03/04/08 |
| I-8 | 预览内容与真实来源逐字一致：主分支态（source=main）与分支态（source=worktree，.legion-worktrees/<id>/ 优先）均字节级一致 | TC-S3-01/02/03 |
| I-9 | 回归面：scrum/render.mjs 真实库无错、taskctl.ttl.test.mjs、hub 既有套件（skills/chat/calendar）、plugins worker-regression、workbench build 不回归 | TC-S1-12 / TC-S2-10 / TC-S3-13 / TC-S6-06 / TC-S5-09 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 命令形态按宿主能力分档：沙箱/无 node_modules 时以「环境受限 + 复现步骤」记录，不冒充通过（仓库 R-18 惯例）；tester 验收复跑以真实命令输出为证。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 契约测试：S1 node --test plugins/tests/doc-contract.test.mjs（需先 pnpm --dir plugins build 产出 lib；宿主受限记录）；S2 node --test plugins/tests/artifact-register.test.mjs；S3 node --test team-hub/artifact-content.test.mjs（临时 TEAM_HUB_DB + 临时仓库根 fixture，仿 skills.test.mjs）；S6 node --test scrum/artifact-detail.test.mjs（fixture 任务库临时替换/环境注入，仿 taskctl.ttl.test.mjs） | 各切片纯逻辑 + 路由/端点契约 | coder 随实现自跑；tester 验收复跑 | node_modules 就位后跑；spawn EPERM 时 node 直跑等效并记录 |
| L1 | 真进程 HTTP 冒烟：team-hub 端（S3 内容端点：真 listen(0) 端口 + 临时双树仓库）；scrum serve.mjs /api/artifact 逐条（S6） | 路由/鉴权/错误码/白名单端到端 | tester（各后端切片后） | env：TEAM_HUB_DB/TEAM_HUB_PORT/TEAM_HUB_TOKEN/spaces.local_dir |
| L2 | 浏览器手工验收（workbench build 产物 + scrum kanban.html）：S5 详情「产出文档」区主路径与错误态；S6/S7 看板逐条预览 | 交互主路径 + 渲染安全 + 空态/降级 | tester + 将军验收（§7 清单） | 改前端后须 build 再验；宿主/CI 执行 |
| L3 | 集成回归 + 宿主端到端（S8）：全量 L0+L1+build + §4.8 E2E 清单（主分支态/分支态/缺失/多轮/渲染安全样例） | S8 / 宿主可达面（workbench serve.mjs 托管 + hub 冒烟、DSH 托管态 S7 冒烟） | tester / devops | 宿主不可达部分如实标注「环境受限 + 复现步骤」，不冒充通过 |

### 2.1 关键命令与 env（tester/coder 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| S1 契约 | pnpm --dir plugins build 后 node --test plugins/tests/doc-contract.test.mjs | 断言 roles.json 七岗 docs、模板展开、回退 artifact、既有字段逐字节 |
| S2 契约 | node --test plugins/tests/artifact-register.test.mjs | fixture 回放 requirement/reviewer done 结算；登记/缺失/幂等/双写 |
| S3 契约 | node --test team-hub/artifact-content.test.mjs | 临时库 + 双树仓库 fixture（主树 + .legion-worktrees/<id>/）；字节比对 |
| S3 宿主面 | TEAM_HUB_DB=<tmp> TEAM_HUB_PORT=<p> node team-hub/server.mjs（spaces.local_dir 指向临时仓库根） | L1 用；随机端口 + /api/config 回读确认 |
| S4 渲染 | node --test workbench/scripts/doc-render.test.mjs（vite ssrLoadModule 载入组件 + react-dom/server renderToString） | 结构/安全断言；零新增依赖 |
| S4/S5/S7 构建 | pnpm --dir workbench build（S4/S5）；pnpm --dir board-plugin typecheck / pnpm --dir board-plugin build（S7） | tsc 0 诊断为最严证据；EPERM/无 node_modules 时按 R-18 记录 |
| S6 渲染 | node scrum/render.mjs --out <临时目录> + node scrum/render.mjs（真实库无错）+ node --test scrum/artifact-detail.test.mjs | kanban.html 逐条产物断言 + serve /api/artifact 逐条断言 |
| 存量回归 | node --test plugins/tests/worker-regression.test.mjs、node --test scrum/taskctl.ttl.test.mjs、hub 既有 skills/chat/calendar 套件 | 各切片 DoD 回归面 |
| 渲染安全 grep | grep -rn dangerouslySetInnerHTML workbench/src plugins board-plugin/src scrum | I-2 红线（S4/S5/S8 审查断言） |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 为实现期可配值：实现必须导出常量或读 env/配置，测试用「三值法」（值-1 / 值 / 值+1）断言；定值后无需改用例。默认值沿用 T-104 G-R 系列与 REQUIREMENTS D-4/D-5。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| 契约存在性（R-1） | roles.json stage.docs（七岗各一） | 七文档岗 docs 存在且 path 与 roles prompt 现行约定一致；coder 无 docs；既有字段逐字节（TC-S1-01/05） |
| {taskId} 模板展开 | docs/review/{taskId}-REVIEW.md | taskId=T-106 → docs/review/T-106-REVIEW.md；数字补齐/未知角色不抛错（TC-S1-02/04） |
| docs 缺省回退 | docs ?? (artifact ? [artifact] : []) | researcher 无 docs 时等价 stage.artifact 单值；非文档岗空数组（TC-S1-03） |
| 自动登记（R-1） | 结算时 kind=file、path=仓库相对、by=守护、含时间 | requirement 回放后 artifacts 含 docs/REQUIREMENTS.md，worker 未填 artifact 亦登记（TC-S2-01） |
| 缺失门禁（G-R2） | 契约文档缺失 → 停 in_review + 提示评论 | 不误判成功流转；评论含期望路径；补齐重跑提示消除照常流转（TC-S2-03/04） |
| 双写/时序（I-6） | 登记先于 autoPromote；hub 可用 POST /api/artifact 否则 taskctl artifact | fixture 断言合入前条目已存在；双分支可测（TC-S2-05） |
| 幂等/多轮（AC-R2-3 数据源） | 同 path 同字节跳过、变化追加 | 打回重做不刷屏；变化追加新条目供前端倒序（TC-S2-06） |
| 内容逐字（R-3） | readFileSync 字节比对 | source=main 与 source=worktree 两态 diff 为空（TC-S3-01/02/03） |
| 读取上限（G-R5） | 512KB（⚖️ 可配） | >512KB → truncated=true + 提示 + 可下载；≤512KB 全量（TC-S3-07） |
| 白名单/逃逸（I-3） | 路径只取登记记录 + repoRoot 白名单 + realpath | ?path= 忽略/拒绝；../、盘符、.git 段、根外符号链接 → 403 可区分（TC-S3-04/05/06） |
| 错误码（K9） | 404 任务/条目/文件不存在；400 i 越界/无登记；403 越权 | 三码可区分、文案明确（TC-S3-09） |
| 二进制/非 UTF-8 | previewable=false 不白屏 | NUL/非法 UTF-8 → previewable=false + 中性提示（TC-S3-08） |
| md 结构（D-5） | 可读等价子集 | 标题/表格/代码块等关键文本可见、结构正确（TC-S4-01/02） |
| 渲染安全（I-2） | 无脚本执行、无 javascript: 协议 | renderToString 输出无 script 标签/事件属性/javascript:；原始 HTML 按文本（TC-S4-04/05/06） |
| 详情直达（R-2） | 点击条目 → 同屏内嵌 MarkdownDocView | 全文可见（非摘要/路径/下载钮）；多轮倒序最新高亮（TC-S5-02/04） |
| 空态（AC-R2-4） | 非文档岗/无登记 → 中性占位或区不显示 | 不报错、无误导空区（TC-S5-05） |
| S2 看板逐条（R-4） | 每条目独立可交互 + serve/board 按 i 服务 | md 预览安全；两条 html 各自预览；url/file 保留；file:// 降级提示（TC-S6-xx/TC-S7-xx） |

## 4. 用例目录

> 图例：类别 🟢正常 / 🟡边界 / 🔴异常；优先级 P0（切片验收门槛，P0 用例 coder 必须落成断言）/ P1 / P2；「自动化」= 测试文件（coder 落盘）/ L1 curl / L2 浏览器 / 评审（grep + 代码审查断言）。
> 追溯列引用：T-103 验收口径（AC-R1-x / AC-R2-x / AC-R3-x / AC-R4-x）、TASK_BREAKDOWN §1 机器验收行（Sx 验收 n = 该片 DoD 第 n 个分句，按 §1 行内分号顺序计数）、§6 E2E-n、闸门（G-Rx）、决策（D-x）、不变量（I-x）、假设（H-x）。
> 缺口索引（§4.0）给「现状缺口 → 代码证据 → 本批切片 → 用例」映射，供 coder 先复现后实现、tester 回归时对照；现状证据引用以 REQUIREMENTS §2/§11 的 file:line 为准（基线 fa9c568）。

### 4.0 现状缺口 → 切片 → 用例索引

| 缺口（现状证据，REQUIREMENTS §2） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 岗位→文档契约仅 prompt 文本；唯一机器契约 = researcher stage.artifact/gate（roles.json:17-20）；requirement/breaker/test-designer/reviewer/tester/devops 六岗零机器字段（§2.1） | S1 | TC-S1-01/02/03/04 |
| G2 守护仅对 gate+artifact 岗做 docOk 校验与完成评论（plugins:1300-1318），requirement 等岗不校验不登记零提示 | S1/S2 | TC-S2-01/03/04 |
| G3 登记完全依赖 worker 报告自填 artifact（plugins:1289/1104-1106），不填 = 任务永远无产物记录 | S2 | TC-S2-01/08 |
| G4 v2 hub 只有 POST /api/artifact 登记（server.mjs:1260-1273），没有任何「按登记条目返回文件内容」的 GET 端点（§2.2） | S3 | TC-S3-01..15 |
| G5 S1 详情产物区渲染纯路径文本，html/file 无打开/下载/预览动作、仅 url 外链（TaskDetailModal.tsx:419-434）；api.ts 无取内容函数（§2.3） | S5 | TC-S5-01/02/03/07 |
| G6 任务详情无任何 md/文本可读通道（§2.3/§2.4）；渲染纪律：React 文本节点无 dangerouslySetInnerHTML（§2.6） | S4（渲染组件）+ S5（接入） | TC-S4-01..12 / TC-S5-02/08 |
| G7 验收时刻文档可能只在 w/<id> 分支/隔离目录（plugins:1287-1334 autoPromote/in_review 时序，§2.5） | S3 | TC-S3-02/03/10 |
| G8 S2 详情仅「最新一条 html」iframe、file=下载、url=外链（render.mjs:437）；md 文本类无预览 | S6 | TC-S6-01/02/04/05 |
| G9 DSH board-plugin /api/artifact 只取登记最后一条 slice(-1)（board:86） | S7 | TC-S7-01/06 |
| G10 内容读取无白名单外防逃逸与错误码可区分性契约（现仅 v1 白名单先例 serve.mjs:452-473、board-plugin:67-96） | S3/S6/S7 | TC-S3-04/05/06/09 / TC-S6-05 / TC-S7-03 |

### 4.1 S1 R-1a 岗位文档契约数据模型：roles.json 七文档岗新增 stage.docs + plugins 契约解析（模板展开/回退/兼容）【P0 · R-1 数据面起点】
自动化：plugins/tests/doc-contract.test.mjs（新增；断言 roles.json 实际文件 + 解析纯函数，仿 worker-regression fixture 范式）｜评审 + typecheck

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | roles.json 现状（八岗 stages 数组）；S1 实现完成 | 读取 roles.json 并解析：对七文档岗（requirement/researcher/breaker/test-designer/reviewer/tester/devops）逐岗断言 stage.docs 存在；对 coder 岗断言无 docs | 七岗各含 stage.docs 且各 path 与角色 prompt 现行约定逐字一致：requirement→docs/REQUIREMENTS.md、researcher→docs/RESEARCH.md、breaker→docs/TASK_BREAKDOWN.md、test-designer→docs/TEST_CASES.md、reviewer→docs/review/{taskId}-REVIEW.md（模板含动态段）、tester→docs/TEST_REPORT.md、devops→docs/DEPLOY.md；coder 等非文档岗无 docs 字段——AC-R1-1 | doc-contract.test.mjs（契约清单断言） | AC-R1-1；S1 验收 2；I-4 |
| TC-S1-02 | 🟢 P0 | 解析纯函数已导出（如 expandDocContract(role, taskId) 或等价） | 调解析：reviewer 岗 docs 模板 docs/review/{taskId}-REVIEW.md 分别以 taskId=T-106、T-009、T-1234 展开 | 展开结果 = docs/review/T-106-REVIEW.md、docs/review/T-009-REVIEW.md、docs/review/T-1234-REVIEW.md（占位替换正确、零丢失字符）；无占位模板原样返回（其余六岗 path 不含 {taskId}） | doc-contract.test.mjs（模板展开组） | AC-R1-3 前置；S1 验收 3 |
| TC-S1-03 | 🟡 P0 | 构造 stage 变体：有 docs、无 docs 仅有 artifact、两者皆无 | 分别调归一化函数（docs 缺省时回退 artifact 单值） | 有 docs → 原 docs 数组；无 docs 有 artifact → 等价单值 [artifact]（researcher 语义：docs/RESEARCH.md）；两者皆无 → 空数组；均不抛错 | doc-contract.test.mjs（回退组） | AC-R1-5 前置兼容；S1 验收 3 |
| TC-S1-04 | 🟡 P0 | 非法/异常输入构造：role 未知、docs 为 null/非数组字符串/空数组/元素缺 path、docs 元素含空串 | 调解析与归一化函数 | 未知 role / 缺 docs → 返回空契约不抛错不崩溃；docs=字符串按单元素处理或明确报错（断言以实现归一化语义为准：任何输入不导致未捕获异常）；空元素被忽略或保留（断言其一）且不产生非法 path | doc-contract.test.mjs（健壮性组） | S1 验收 3 反向；AC-R1-5 |
| TC-S1-05 | 🟢 P0 | S1 实现完成；git 基线 fa9c568 | git diff roles.json 核对：新增 docs 相关字段范围；JSON.parse(roles.json) 合法；七岗 prompt/gate/artifact/next 文本逐字节比对基线 | roles.json 仅新增 docs 相关字段（prompt、gate、artifact、next、label 原文不动，git diff 无这些行）；JSON 解析合法（board-plugin /api/config 整读等消费方不破坏）——AC-R1-5 兼容 | doc-contract.test.mjs（字节比对组）+ 评审 | S1 验收 4；AC-R1-5；I-4 |
| TC-S1-06 | 🟢 P0 | 同 TC-S1-05 | 以消费方视角：读 roles.json → 走既有 pipeline/stage 消费逻辑（board-plugin /api/config 整读、taskctl pipeline、守护 StageDef 载入） | 消费方对新增 docs 字段零感知：pipeline 顺序、stage.standards、gate/artifact 语义与基线一致；无 JSON 解析错误、无字段冲突（未知字段被忽略或按扩展读取） | 评审 + 宿主冒烟（/api/config 回读） | S1 验收 4；AC-R1-5；I-4 |
| TC-S1-07 | 🟢 P0 | 解析纯函数已导出 | 对 roles.json 实际七岗逐岗调 expandAllDocs(role)（reviewer 注入任务 ID 前置） | 每岗返回的契约条目数与 stage.docs 一致；requirement 等单文档岗 = 1 条；reviewer 展开后 = docs/review/<任务ID>-REVIEW.md；空契约岗返回空数组 | doc-contract.test.mjs | AC-R1-1/3 数据面；S1 验收 2/3 |
| TC-S1-08 | 🔴 P0 | 守卫输入：roles.json 损坏（截断/非法 JSON）/ 解析函数收到非对象 | 以损坏 roles.json 内容调解析入口；以非对象参数调纯函数 | 抛出可读错误（含文件/字段定位）而非静默返回错误数据；纯函数对 null/undefined 参数返回可读错误或空契约不崩溃；进程存活 | doc-contract.test.mjs（守卫组） | S1 验收 3 反向；I-9 |
| TC-S1-09 | 🟢 P1 | docs 元素含 title/required 等附加字段（D-1 对象形态） | 逐条读取 title/required 并断言默认 | 无 title 时回退默认标题（岗位标签 + 文档说明，S2 评论/登记 title 数据源）；required 缺省视为 true（主文档必须存在）；契约对象可含扩展字段不影响 path 解析 | doc-contract.test.mjs | D-1/D-2；S1 验收 2 |
| TC-S1-10 | 🟡 P1 | reviewer 任务 ID 形态差异（T-9、T-0009、无 ID） | 以不同 taskId 展开 reviewer 模板 | 统一规范化为 T-0xx 后展开或按原样替换（断言以实现规范化为准：结果必须是合法文件名段，不含路径分隔符或 ../ 注入）；taskId 含 ../ 或盘符 → 拒绝或消毒后不越权 | doc-contract.test.mjs（模板守卫） | AC-R1-3 边界；S1 验收 3 |
| TC-S1-11 | 🟢 P0 | S1 实现完成 | 跑 plugins typecheck：tsc -p plugins/tsconfig.json --noEmit（node_modules 缺失时记录复现步骤）；git diff plugins/package.json | typecheck 0 诊断（或受限如实记录 + 复现步骤）；plugins/package.json 无新增依赖项 | L0 build + 评审 | S1 验收 5/7；I-1 |
| TC-S1-12 | 🟢 P0 | S1 实现完成 | 跑 node --test plugins/tests/worker-regression.test.mjs（宿主受限时如实记录）；node --test plugins/tests/doc-contract.test.mjs | worker-regression 既有用例不回归（0 失败）；doc-contract 全绿 | L0（回归照跑） | S1 验收 1/6；AC-R1-5；I-9 |
| TC-S1-13 | 🟢 P1 | S1 实现完成 | 评审：roles.json 七岗 docs path 与 TASK_BREAKDOWN §1 / REQUIREMENTS §2.1 逐条人工对照 | 七岗 path 与本文 TC-S1-01 期望表一致；researcher docs 与既有 stage.artifact 值 docs/RESEARCH.md 一致（双通道同值，防语义分叉） | 评审 | AC-R1-1；S1 验收 2 |

### 4.2 S2 R-1b 结算自动登记与缺失门禁：done 结算按契约逐条登记（双写 hub/v1、幂等追加）+ 缺失软门禁提示 + 完成评论清单【P0 · plugins 结算段，S1 串行后继】
自动化：plugins/tests/artifact-register.test.mjs（新增；fixture 回放 requirement/reviewer done 结算，仿 worker-regression fake-hub fixture 范式）｜评审 + typecheck

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | fixture：requirement 岗任务（role=requirement）done 结算，worktree 目录含 docs/REQUIREMENTS.md；worker 报告**未填** artifact 字段 | 回放 done 结算主路径（commitWorktree 后、autoPromote 前） | 任务记录 artifacts 追加 docs/REQUIREMENTS.md 条目：kind=file、path=docs/REQUIREMENTS.md（仓库相对路径）、by=守护、含登记时间 at；worker 报告未填 artifact 亦登记（自动兜底）——AC-R1-2 | artifact-register.test.mjs | AC-R1-2；S2 验收 1；I-6 |
| TC-S2-02 | 🟢 P0 | fixture：reviewer 岗任务 done，worktree 目录含 docs/review/T-106-REVIEW.md | 回放 reviewer done 结算 | {taskId} 被解析为实际任务 ID：登记 path=docs/review/T-106-REVIEW.md（AC-R1-3）；登记标题含岗位标签；reviewer 模板替换不产生 {taskId} 残留字面量 | artifact-register.test.mjs | AC-R1-3；S2 验收 2 |
| TC-S2-03 | 🔴 P0 | fixture：requirement 岗任务 done 结算，但 worktree 目录**无** docs/REQUIREMENTS.md | 回放 done 结算（软门禁 G-R2） | 任务停在 in_review 不误判成功流转（不 autoPromote/不 done）；任务评论出现明确缺失提示（含期望路径 docs/REQUIREMENTS.md 与当前已登记清单）——AC-R1-4 | artifact-register.test.mjs（缺失组） | AC-R1-4；S2 验收 3；G-R2；I-7 |
| TC-S2-04 | 🟢 P0 | 同 TC-S2-03 后：把 docs/REQUIREMENTS.md 补入 worktree 目录 | 再次回放 done 结算 | 登记成功（artifacts 含条目）；缺失提示消除；非 gate 岗照常流转（next 阶段推进）；照常出完成评论——AC-R1-4 正向闭环 | artifact-register.test.mjs | AC-R1-4；S2 验收 3；G-R2 |
| TC-S2-05 | 🟢 P0 | fixture：researcher（gate 岗）任务 done，worktree 含 docs/RESEARCH.md；hub mock 可用 | 回放 researcher done 结算 | 登记 docs/RESEARCH.md（等价既有 stage.artifact 语义）；gate 岗照旧：登记后仍走 in_review 人工验收评论（不因登记改变流转语义）；hub mock 下走 POST /api/artifact 双写；hub 不可用 mock 下走既有 taskctl artifact argv 路径（与 recordArtifact 双路径 plugins:943-949 一致）——AC-R1-5 | artifact-register.test.mjs（gate/双写组） | AC-R1-5；S2 验收 4/5；I-6 |
| TC-S2-06 | 🟡 P0 | fixture：同一 requirement 任务两次结算，中间 docs/REQUIREMENTS.md 内容未变；另造一次内容变化（追加一段） | 连续回放：结算①（内容 A 登记）→ 结算②（内容 A 未变）→ 结算③（内容 B = A 追加段） | 结算②同 path 同字节 → 幂等跳过不重复登记（无重复条目、不刷屏）；结算③内容变化 → 追加新条目（保留旧条目，多轮倒序数据源）——AC-R2-3 数据面 | artifact-register.test.mjs（幂等/多轮组） | AC-R2-3 数据源；S2 验收 6；I-6 |
| TC-S2-07 | 🟡 P0 | fixture：完成一次有登记的结算（TC-S2-01）与一次缺失结算（TC-S2-03）；另造一次无登记无缺失的非文档岗结算 | 检查三场景完成评论文本 | 有登记 → 评论含「产出文档」清单摘要（含 docs/REQUIREMENTS.md）；有缺失 → 评论含缺失提示（期望路径）；无登记无缺失（非文档岗）→ 评论不含产出文档清单（不刷屏）；评论格式稳定可断言 | artifact-register.test.mjs（评论组） | S2 验收 7；H-7；R-11 |
| TC-S2-08 | 🔴 P0 | fixture：coder（非文档岗）任务 done，worker 报告自填 artifact {kind:file, path:src/foo.ts} | 回放 coder done 结算 | coder 不产生任何契约登记（无 docs 契约 → 零新增条目）；worker 自填 artifact 既有登记路径（plugins:1289 语义）不回退——AC-R1-5 | artifact-register.test.mjs（非文档岗组） | AC-R1-5；S2 验收 4；I-7 |
| TC-S2-09 | 🟡 P1 | fixture：requirement 任务 worktree 同时含主文档 docs/REQUIREMENTS.md 与附加产物 docs/T106-evidence/01-xxx.txt | 回放 done 结算 | 默认只登记主文档一条（evidence 目录不默认登记，D-2）；主文档登记不因附加产物存在而多条目；若实现后续支持 1 岗多文档契约（扩展 docs 数组），本用例改为断言按契约条目逐条登记 | artifact-register.test.mjs | D-2；S2 验收 1 边界 |
| TC-S2-10 | 🟢 P0 | S2 实现完成（S1 已合入） | 跑 node --test plugins/tests/worker-regression.test.mjs（宿主受限记录）；tsc -p plugins/tsconfig.json --noEmit；git diff plugins/package.json | worker-regression 不回归；typecheck 0 诊断或受限记录；零新增依赖；plugins/src/index.ts 结算段改动未破坏既有 done 流转（评审确认 commitWorktree→登记→autoPromote 顺序） | L0 + 评审 | S2 验收 8/9/10；AC-R1-5；I-1/I-9 |

### 4.3 S3 R-3 v2 内容通道：team-hub 只读 GET /api/artifact/content（记录驱动 + 仓库根白名单 + realpath 防逃逸 + worktree 优先/主仓兜底 + 存量绝对路径兼容 + 截断/二进制/错误码）【P0 · R-3 服务端，独立可先行】
自动化：team-hub/artifact-content.test.mjs（新增；临时 TEAM_HUB_DB + spaces.local_dir 指向临时仓库根，双树 fixture：主树 docs/ + .legion-worktrees/<id>/docs/，仿 skills.test.mjs）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | 临时库：任务 T 登记条目 i=0 {kind:file, path:docs/x.md}；主仓库根 local_dir 下 docs/x.md 内容 C（唯一来源，无 worktree 目录） | GET /api/artifact/content?task=T&i=0 | 200；返回 content 与 readFileSync(主树 docs/x.md) 逐字一致（字节 diff 为空）；source=main；size=文件字节数；relPath=docs/x.md；previewable=true——AC-R3-1 | artifact-content.test.mjs（主分支态组） | AC-R3-1；S3 验收 2；I-8 |
| TC-S3-02 | 🟢 P0 | 同 TC-S3-01，但在 local_dir/.legion-worktrees/<T>/docs/x.md 放置内容 W（与 C 不同） | GET /api/artifact/content?task=T&i=0 | 200；返回 W（worktree 目录优先）；source=worktree；与 readFileSync(.legion-worktrees/<T>/docs/x.md) 逐字一致——AC-R3-2（K5-A 零 git CLI） | artifact-content.test.mjs（分支态组） | AC-R3-2；S3 验收 3；H-4 |
| TC-S3-03 | 🟢 P0 | 同 TC-S3-02 后删除 local_dir/.legion-worktrees/<T>/ 目录 | 再 GET /api/artifact/content?task=T&i=0 | 200；自动回退主仓库根文件（source=main），content 与主树 docs/x.md 逐字一致；无 500、无白屏——AC-R3-2 兜底 | artifact-content.test.mjs | AC-R3-2；S3 验收 3 |
| TC-S3-04 | 🔴 P0 | 登记记录被污染：path 含 ../（如 ../../etc/passwd）、盘符（如 C:/x）、任一层 .git（docs/.git/config、a/.git/b） | 逐路径调端点（登记记录本身含越权 path；测试经 fixture 注入登记 path） | 全部 403（可区分错误）；响应体不含文件内容；服务端不读越权文件；错误码/文案与正常预览可区分——AC-R3-3 | artifact-content.test.mjs（逃逸组） | AC-R3-3；S3 验收 4；I-3 |
| TC-S3-05 | 🔴 P0 | 登记 path 合法（docs/x.md），但请求带额外查询串 ?path=/etc/passwd 或 ?path=../secret | GET /api/artifact/content?task=T&i=0&path=/etc/passwd | 查询串被忽略/拒绝：返回仍为登记条目内容或 400 明确拒绝；绝不用查询串指定文件（路径只取任务登记记录）——AC-R3-3 | artifact-content.test.mjs | AC-R3-3；S3 验收 4；I-3 |
| TC-S3-06 | 🔴 P0 | 仓库根内符号链接 docs/link.md → 仓库根外文件（如 /tmp/outside.txt） | 登记 path=docs/link.md 后 GET | 经 realpath 复检 → 403 拒绝（解析后路径前缀不在仓库根内）；不返回外部文件内容；可区分错误 | artifact-content.test.mjs（symlink 组） | AC-R3-3；S3 验收 4；I-3 |
| TC-S3-07 | 🟡 P0 | 文件 >512KB（构造 513KB 与 511KB 两文件，G-R5 上限可配常量导出） | 分别对两文件 GET | ≤512KB → truncated=false 全量 content；>512KB → truncated=true + 截断提示（含可下载全文提示）；三值法（513KB/512KB/511KB）断言实现导出常量 | artifact-content.test.mjs（截断组） | AC-R3-6；S3 验收 5；G-R5；H-5 |
| TC-S3-08 | 🔴 P0 | 登记 path 指向二进制文件（含 NUL 字节）与非法 UTF-8 文件 | GET | previewable=false（或等价中性标记）+ 明确提示，不白屏不报错不 500；content 不回传原始二进制或按明确编码（断言以实现为准：至少 previewable=false 且进程存活）——AC-R3-6 | artifact-content.test.mjs（二进制组） | AC-R3-6；S3 验收 5 |
| TC-S3-09 | 🔴 P0 | 四类错误输入：任务不存在 / 任务存在但 i 越界 / 任务无登记条目 / 登记 path 指向磁盘不存在文件 | 分别 GET | 错误码可区分：404（任务/条目/文件不存在）与 400（i 越界/无登记）；响应含明确错误文案；正常预览与错误响应可区分（成功 200 含 content 字段）——K9 | artifact-content.test.mjs（错误码组） | S3 验收 5；K9；AC-R3-3 区分性 |
| TC-S3-10 | 🟡 P0 | 存量库：登记 path 为绝对路径（旧记录），命中 worktreeRoot/<id>/docs/x.md 或 local_dir/docs/x.md 前缀 | 对两类绝对路径记录 GET | 剥前缀后按同规则解析成功返回内容（source 按实态标注）；既非 worktreeRoot/<id>/ 前缀也非 local_dir 前缀的绝对路径 → 404 或明确文案（不越权读）；不跑迁移脚本——K10/G-R8 | artifact-content.test.mjs（legacy 组） | S3 验收 6；K10；G-R8；I-5 |
| TC-S3-11 | 🟢 P0 | 任务 T 含登记条目；审计表有 N 行 | GET 前后比对 audit 行数与任务/条目记录 | GET 只读：audit 行数不变（N 前后一致）、任务记录不变、无新增写动作；端点不产生 SSE 广播 | artifact-content.test.mjs（只读组） | S3 验收 7；I-3 |
| TC-S3-12 | 🟡 P0 | 登记条目 kind 非 file（kind=url / kind=html）或 path 无 md/txt/markdown 扩展名 | GET 内容端点 | 内容端点按登记 path 真实文件判定可预览性：url 类（无文件语义）→ 明确不可预览（previewable=false 或 4xx 文案）；html 文件存在 → 可返回原文（供 S6/S7 逐条语义）或按设计拒绝（断言以 S3 实现契约为准：不把 html 当 md 渲染返回，至少语义明确不崩溃） | artifact-content.test.mjs | H-3 边界；S3 验收 2 |
| TC-S3-13 | 🟢 P0 | S3 实现完成 | 跑既有 hub 套件回归：node --test team-hub/skills.test.mjs / chat.test.mjs / calendar.test.mjs（或同库 import 等价断言）；git diff team-hub/package.json | 既有套件全绿（skills/chat/calendar 计数不降）；零新增运行时依赖（server.mjs 无新 import）——AC-R3-7 hub 面 | L0（回归照跑） | S3 验收 7；AC-R3-7；I-1/I-9 |
| TC-S3-14 | 🟡 P1 | 内容为 md；另有 txt 与 .markdown 扩展名文件 | 分别 GET 并检查响应 Content-Type 与文本 | md/markdown → text/markdown（charset=utf-8）；txt → text/plain；内容逐字；空文件（0 字节）→ 200 content 空串 previewable=true 不报错 | artifact-content.test.mjs | H-3；S3 验收 2/5 边界 |
| TC-S3-15 | 🔴 P0 | 任务 T 归属空间 S（spaces.local_dir=L1）；另一空间 S2（local_dir=L2）与任务无关 | 任务 T 登记 path=docs/y.md；在 L2 下同名 docs/y.md 内容不同 | 端点只按任务归属空间 local_dir（L1）解析：返回 L1 内容；读不到/不读 L2 文件（跨空间不读，D-10）；L1 无文件且 L2 有 → 404 而非跨空间兜底 | artifact-content.test.mjs（跨空间组） | D-10；AC-R3-3 边界 |

### 4.4 S4 R-3 markdown 渲染组件：自研 MarkdownDocView 子集渲染器（React 元素直出、零依赖、原始 HTML 按文本、协议白名单、未知语法文本回退）及结构/安全自动化测试【P0 · R-3 渲染面，独立可先行】
自动化：workbench/scripts/doc-render.test.mjs（新增；经 vite ssrLoadModule 载入组件 + react-dom/server renderToString 断言）｜评审 + pnpm build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | MarkdownDocView.tsx 已实现；测试样例 md 含：一级/二级标题、段落、粗体、斜体、行内代码、围栏代码块（含语言标注）、有序列表、无序列表（含嵌套）、表格、引用块、分割线、链接 | 经 vite ssrLoadModule 载入组件 → react-dom/server renderToString 渲染样例 | 输出 HTML 出现对应结构：h1/h2 标题文本可见、strong/em 生效、code 内联与 pre 围栏代码块按预格式化呈现（内容不被转义破坏）、ol/ul 层级正确、table 含表头与行、blockquote 引用可见、hr 存在、a 链接存在且 href 在协议白名单内；关键文本（标题词/表格单元格/代码行）均可在输出中找到——AC-R3-4 | doc-render.test.mjs（结构组） | AC-R3-4；S4 验收 3；D-5 |
| TC-S4-02 | 🟢 P0 | 同 TC-S4-01 样例 | 断言渲染输出文本内容与源 md 关键文本一致性 | 文档正文文本（去掉 markdown 语法符号后的可读文本）逐字可达：无丢失段落、无乱码；代码块内容保留原样（含空格缩进） | doc-render.test.mjs | S4 验收 3；D-5 |
| TC-S4-03 | 🟡 P0 | 边界样例：空文档 / 仅空白 / 超长单行 / 列表深度 3+ / 空表格单元格 / 表格内代码 | 逐一渲染 | 空文档/空白 → 空输出或段落不崩溃；超长单行 → 正常段落（容器滚动由 S5 负责）；深层列表/空单元格/表格内代码 → 结构正确不抛错不崩溃 | doc-render.test.mjs（边界组） | S4 验收 3；K6-A 子集 |
| TC-S4-04 | 🔴 P0 | 恶意样例：md 含 script 标签注入（script alert 样本）、HTML 原文段落 | 渲染 | renderToString 输出中无 script 标签；注入内容作为纯文本可见（按文本原样出现）；无事件属性——AC-R3-5 | doc-render.test.mjs（安全组） | AC-R3-5；S4 验收 4；I-2 |
| TC-S4-05 | 🔴 P0 | 恶意样例：img onerror 样本、任意 on* 事件属性文本、iframe/object/embed 标签文本 | 渲染 | 输出无 onerror/onclick 等事件属性；img 不产生真实图片加载副作用（按文本或安全占位）；iframe/object/embed 不出现于输出标签——AC-R3-5 | doc-render.test.mjs（安全组） | AC-R3-5；S4 验收 4；I-2 |
| TC-S4-06 | 🔴 P0 | 恶意样例：链接 href=javascript:alert、data:text/html、vbscript: 文本 | 渲染 | javascript:/data:/vbscript: 协议的链接不输出为可点 href（按文本显示或渲染无 href 的 span）；输出中不存在 javascript: 协议字符串（href 属性值）——AC-R3-5 协议面 | doc-render.test.mjs（协议组） | AC-R3-5；S4 验收 4；I-2 |
| TC-S4-07 | 🟢 P0 | 未知语法样例：脚注、删除线、任务列表、HTML 标签 raw 文本 | 渲染 | 不支持的语法按文本回退（脚注/删除线/任务列表以字面文本出现）；HTML 标签按文本显示（不解析成标签）；全程不崩溃——K6-A 子集契约 | doc-render.test.mjs（回退组） | S4 验收 5；K6-A；H-6 |
| TC-S4-08 | 🟡 P0 | 超长/畸形输入：10 万字符文档、未闭合围栏代码块、行内代码内嵌反引号、表格式错乱（列数不一致） | 渲染 | 长文档可渲染完成不 OOM/不崩溃（或命中组件显式上限走 pre 文本兜底，断言其一）；未闭合围栏/错乱表格 → 按文本或尽力结构呈现，不抛未捕获异常 | doc-render.test.mjs（健壮组） | AC-R3-6 前端面；S4 验收 3/5 |
| TC-S4-09 | 🟢 P1 | 真实文档冒烟：取 docs/REQUIREMENTS.md 与 docs/RESEARCH.md 节选（含标题/表格/代码段）作为样例 | 渲染节选 | 渲染不崩溃；节选中的关键标题文本与表格单元格文本可见（R-6 缓解）；宿主/依赖不可达时如实记录复现步骤 | doc-render.test.mjs（真实文档组） | S4 验收 6；R-6 |
| TC-S4-10 | 🔴 P0 | 转义绕过矩阵：实体编码脚本、表格单元格注入 HTML、链接文本内嵌引号/尖括号、markdown 语法逃逸序列 | 渲染 | 全部按纯文本安全呈现：无解析出的 HTML 标签、无属性注入、无实体二次解码执行路径；输出文本与源内容一致（可见即所得） | doc-render.test.mjs（绕过组） | AC-R3-5；S4 验收 4 |
| TC-S4-11 | 🟢 P0 | S4 实现完成 | grep 组件与同切片新增文件 dangerouslySetInnerHTML；grep 链接协议白名单常量；git diff workbench/package.json；检查样式文件归属 | dangerouslySetInnerHTML 0 匹配；协议白名单常量集中一处可审计（http/https/mailto/相对路径/#）；样式落新增独立 css 或组件内联（不改 workbench/src/index.css，S5 文件域）；workbench/package.json 零新增依赖——AC-R3-5 审查面 | 评审/grep | S4 验收 5/7/8；AC-R3-5；I-1/I-2 |
| TC-S4-12 | 🟢 P0 | S4 实现完成 | 跑 pnpm --dir workbench build（tsc --noEmit 0 诊断 + vite 产物；受限时记录复现步骤并附 tsc 结果）；node --test workbench/scripts/doc-render.test.mjs | build 全绿（新组件参与编译）或受限记录；doc-render.test.mjs 全绿 | L0 build + 测试 | S4 验收 1/2；I-9 |

### 4.5 S5 R-2 S1 详情「产出文档」直达区：TaskDetailModal 新增小节（标题+岗位+时间+路径小字可复制 + 点击同屏内嵌 MarkdownDocView + 多轮倒序最新高亮 + 空态占位），api.ts 新增取内容函数，types.ts 扩展类型【P0 · workbench 壳文件，S1 主验收面】
自动化：L2 浏览器清单 + 评审（grep）+ pnpm --dir workbench build（宿主冒烟走 workbench/scripts/serve.mjs 托管 + hub，不可达记录复现步骤）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | hub 模式；存在文档型 in_review 任务（如 requirement 岗 T-103 样例，S2 已登记 docs/REQUIREMENTS.md） | 打开该任务详情 | 出现「产出文档」区且列出登记文档 ≥1 条（每条含 标题 + 岗位 + 时间 + 相对路径小字可复制）；无需展开 diff、无需输入或复制任何路径——AC-R2-1 | L2 + 评审 | AC-R2-1；S5 验收 2 |
| TC-S5-02 | 🟢 P0 | 同 TC-S5-01 | 点击文档条目 → 观察详情内出现视图 | 同屏出现内嵌渲染视图（MarkdownDocView，max-height 滚动容器 + 截断提示可见）；视图呈现文档全文（标题/表格/列表可读），而非仅摘要/路径/下载按钮——AC-R2-2（D-9 内嵌为主 + 新标签钮可选） | L2 + 评审 | AC-R2-2；S5 验收 3 |
| TC-S5-03 | 🟢 P0 | S5 实现完成；api.ts/types.ts 已扩展 | 评审 api.ts：新增取内容函数（如 fetchHubDocContent(taskId, i)）走既有 hub 代理；types.ts 内容响应类型含 content/truncated/source/previewable 等字段 | 客户端函数存在且经 hubBase 代理到 hub 内容端点（对照 H-3 端点形态）；响应类型与 S3 契约字段一致 | 评审/grep | AC-R2-2 数据面；S5 验收 3 |
| TC-S5-04 | 🟡 P0 | 同一任务存在两条及以上登记（S2 多轮追加数据；打回→重做场景） | 打开详情查看「产出文档」区排序 | 按登记时间倒序：最新在首并高亮（如「最新」徽标）；旧条目保留且仍可打开预览——AC-R2-3 | L2 + 评审 | AC-R2-3；S5 验收 4 |
| TC-S5-05 | 🟢 P0 | 非文档型岗位任务（coder 岗，无登记）；以及文档岗但无登记/无产出的任务 | 打开两类任务详情 | 不显示误导性「产出文档」区（或显示中性占位文案，如「该环节不要求文档」/「尚未产出」）；页面不报错、其余详情内容正常——AC-R2-4 | L2 | AC-R2-4；S5 验收 5 |
| TC-S5-06 | 🔴 P0 | S3 端点已合入；构造错误场景：内容拉取 404（条目已删）/403（越权）/超长截断（truncated=true）/二进制（previewable=false）/hub 停（网络错误） | 在详情逐一点击触发各场景 | 呈现明确错误/提示文案（区分 404/403/截断/不可预览/网络），不白屏不崩溃；hub 恢复后重试成功——K9 前端守卫 | L2 + 评审 | S5 验收 6；K9 |
| TC-S5-07 | 🟢 P0 | S5 实现完成 | 打开含 url/html/file 三类既有手工产物条目的任务详情；对照 S1 现状 | 既有产物区 url 外链、html/file 既有语义逐条保留不回退；新「产出文档」区与既有产物区并存不冲突——AC-R2-5 | L2 + 评审 | AC-R2-5；S5 验收 6 |
| TC-S5-08 | 🔴 P0 | S5 实现完成；渲染内容含脚本注入样例的文档（经 S3 正常返回原文） | 详情内点击打开该文档预览 | 内容一律经 MarkdownDocView 文本节点渲染：无脚本执行、无弹窗；grep TaskDetailModal.tsx/api 层无 dangerouslySetInnerHTML 直插服务端内容 | L2 + 评审/grep | S5 验收 7；I-2 |
| TC-S5-09 | 🟢 P0 | S5 实现完成 | 跑 pnpm --dir workbench build（tsc 0 诊断；EPERM 时记录复现步骤）；宿主冒烟：workbench/scripts/serve.mjs 托管 + hub 打开详情走通「产出文档区 → 点击 → 内嵌预览全文」 | build 全绿或受限记录；冒烟走通或受限记录（如实标注，不冒充通过）；改动不破坏 chat/files/calendar/skills 面板（评审无共享 import 破坏） | L0 build + L3 | S5 验收 1；AC-R2-5；I-9 |
| TC-S5-10 | 🟡 P1 | 长文档任务（登记 md 数千行，>512KB 截断态与 <512KB 长文各一） | 打开预览并滚动 | 内嵌容器 max-height 生效、页面不因文档长卡死；滚动流畅；截断态显示「内容超长已截断」提示 + 可下载全文入口（如有） | L2 | S5 验收 3；G-R5 |

### 4.6 S6 R-4 S2 经典看板详情逐条可交互（服务态）：render.mjs 产物区逐条化 + serve.mjs /api/artifact 逐条内容服务【P1 · scrum 面】
自动化：scrum/artifact-detail.test.mjs（新增；fixture 任务库临时替换/环境注入，仿 taskctl.ttl.test.mjs）+ node scrum/render.mjs 断言 + 评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P0 | fixture 任务库：任务含 3 条登记产物（md 文档 1 条、html 2 条、url/file 各 1 条） | node scrum/render.mjs --out 临时目录 → 打开生成 kanban.html 检查产物区 | 产物区出现逐条条目（每条含 kind 徽标 + title + 时间 + 路径）；md/txt 条目带「预览」动作；两条 html 各带独立预览入口（不再仅最新一条）——AC-R4-1/2（K8-A） | artifact-detail.test.mjs（render 组） | AC-R4-1/2；S6 验收 2 |
| TC-S6-02 | 🟢 P0 | 同 TC-S6-01；登记 md 含 script 注入与 img onerror 样本 | 生成 kanban.html 并检查 md 预览渲染 | md 预览安全渲染：输出全部转义、仅白名单协议或 pre 纯文本兜底；生成 HTML 不含未转义直插的原始 HTML（无 script 标签、无事件属性）；注入样本按文本显示无执行——AC-R4-1 安全 | artifact-detail.test.mjs（安全组） | AC-R4-1 安全；S6 验收 3；I-2 |
| TC-S6-03 | 🟡 P0 | 同 TC-S6-01；以 file:// 双击模式（无 serve.mjs 服务）打开生成的 kanban.html | 点击 md 条目「预览」 | 预览动作降级：显示路径 + 「服务模式（serve.mjs / DSH /api）下可预览」提示（不报错、不白屏）；生成 HTML 含降级分支代码——K8-C 边界 | artifact-detail.test.mjs（降级组）+ 评审 | S6 验收 4；K8-C |
| TC-S6-04 | 🟢 P0 | fixture 任务库 + serve.mjs 运行 | GET /api/artifact?task=<T>&i=<序> 逐条请求（md、txt、html、file、url 各条目）；另请求 i 缺省 | 按任务与条目序 i 返回对应条目真实文件内容（md 按 text/markdown）；i 缺省兼容既有语义取最新一条；i 越界/未知任务返回 4xx 可区分；相对路径按 repoRoot 白名单解析——AC-R3-3 v1 面 | artifact-detail.test.mjs（serve 组）+ L1 | AC-R3-3 v1；S6 验收 5；K4-B |
| TC-S6-05 | 🔴 P0 | 登记 path 含 ../ 或 .git 段；另造 url/file 条目 | serve.mjs /api/artifact 对越权 path 请求；url 条目 i 请求；file 条目请求 | ../ 与 .git 段 → 4xx 拒绝（白名单，不读越权文件）；url 条目返回跳转语义（302 或 4xx 明确）；file 下载语义保留——AC-R4-3 | artifact-detail.test.mjs | AC-R4-3；S6 验收 4/5；I-3/I-5 |
| TC-S6-06 | 🟢 P0 | S6 实现完成 | node scrum/render.mjs（真实任务库）无错；node --test scrum/taskctl.ttl.test.mjs | 真实库 render 无错（exit 0）；taskctl.ttl.test.mjs 既有用例不回归 | L0（回归照跑） | S6 验收 6；I-9 |
| TC-S6-07 | 🟡 P0 | 无任何登记产物的任务 / 未知任务 id | 打开详情；GET /api/artifact?task=<未知> | 产物区中性提示（无条目文案）不报错；未知任务 → 4xx 可区分文案 | artifact-detail.test.mjs + L2 | S6 验收 5 边界 |
| TC-S6-08 | 🟢 P1 | S6 实现完成 | git diff scrum/package.json（如有）；评审 serve.mjs/render.mjs 改动域 | 零新增运行时依赖；改动仅限 render.mjs 产物区 + serve.mjs /api/artifact 段（S6 文件域纪律：不与 S1/S2 共享 plugins 域冲突） | 评审 | S6 验收 7；I-1 |

### 4.7 S7 R-4 DSH board-plugin 内容服务逐条化：/api/artifact 按条目序 i 逐条 + md/text 语义 + artifactAllowed 白名单兼容相对路径与分支态目录【P1 · DSH 托管态，S6 后继】
自动化：pnpm --dir board-plugin typecheck/build + 端点语义评审（对齐 serve.mjs）+ DSH 冒烟（宿主可达时）；S6 前端契约复用

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P0 | S7 实现完成；board-plugin 运行（DSH 宿主或等价 mock） | GET /api/artifact?task=<T>&i=<序> 逐条（md、两条 html）；i 缺省请求 | 与 serve.mjs 同语义：按任务与条目序 i 逐条返回（md 按 text/markdown）；i 缺省兼容取最新；i 越界/未知任务 4xx 可区分；raw 分支（raw=1）字节直读——AC-R4-2 服务面（K4-B，board 段升级） | 端点评审 + DSH 冒烟 | AC-R4-2；S7 验收 3 |
| TC-S7-02 | 🟡 P0 | 登记条目含相对路径 docs/x.md（worktree 分支态：.legion-worktrees/<T>/docs/x.md 存在）与纯主仓库路径各一 | 分别 GET | 相对路径条目经 artifactAllowed（repoRoot + artifactRoots 白名单）normalize 后解析成功；分支态目录在根内可读（DSH 托管态 preview 与 S6 一致） | 端点评审 + DSH 冒烟 | S7 验收 4；H-4 |
| TC-S7-03 | 🔴 P0 | 登记 path 含 ../ 越权、盘符、.git 段、符号链接逃逸 | 分别 GET | 全部拒绝（4xx）；不读越权文件；错误与正常预览可区分——与 serve.mjs/S3 同纪律 | 端点评审（代码审查断言 + L1 冒烟） | S7 验收 4；I-3 |
| TC-S7-04 | 🟢 P0 | S7 实现完成；S6 kanban.html 逐条 UI 已合入 | DSH 托管态打开含多条目任务的卡片详情，点击 md 与两条 html 预览 | kanban.html 逐条预览可点通（与 S6 共用同一 client 契约）：md 可读、两条 html 各自可预览；不回归（看板/拖拽/SSE/board 路由正常）——宿主可达时冒烟，不可达记录复现步骤 | DSH 冒烟 / 受限记录 | S7 验收 5/6；AC-R4-2 |
| TC-S7-05 | 🟢 P0 | S7 实现完成 | pnpm --dir board-plugin typecheck（tsc -p tsconfig.json --noEmit）；宿主可跑时 pnpm --dir board-plugin build（scripts/build.sh + tsdown）且产物 lib/ 生成 | typecheck 0 诊断（受限记录复现步骤）；build 无错且 lib/ 生成（宿主可跑时）；零新增依赖 | L0 build | S7 验收 1/2/6；I-1 |
| TC-S7-06 | 🟡 P1 | 与 S6 各自实现完成 | 语义对齐评审：对同一 fixture 任务库分别跑 serve.mjs 端点与 board-plugin 端点，比对响应 | 两服务对同一请求返回同语义（状态码、content-type、逐条 i 语义、错误码）——不产生第三套行为 | 评审 + 对比冒烟 | S7 验收 3/6；K4-B |

### 4.8 S8 集成回归锚定与端到端验收：全批套件逐项运行记录 + 任务详情预览 E2E 清单写入 docs/TEST_REPORT.md【收口 · 全批】
自动化：L3 全量套件 + 宿主端到端清单；结果沉淀 docs/TEST_REPORT.md（本片为验证型，tester 执行；本设计给出命令、判据与勾选清单）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P0 | S1~S7 合入完成 | 逐套件运行并记录输出要点：node --test team-hub/artifact-content.test.mjs 与既有 team-hub 套件；node --test plugins/tests/doc-contract.test.mjs 与 artifact-register.test.mjs；node --test scrum/artifact-detail.test.mjs；pnpm --dir workbench build 与 pnpm --dir board-plugin typecheck | 全部 fail=0（记录输出要点入 docs/TEST_REPORT.md）；build/typecheck 0 诊断；宿主受限处如实记录环境 + 复现步骤——S8 验收 1/2/3/4 | L3 | S8 验收 1/2/3/4 |
| TC-S8-02 | 🟢 P0 | S1~S7 合入；宿主可达（守护可回放） | E2E：requirement 型任务（T-103 样例或等价回放）done 结算 → 打开 workbench 详情「产出文档」区 → 点击内嵌预览 | 任务记录 artifacts 含 docs/REQUIREMENTS.md 条目（AC-R1-2）；详情「产出文档」区列出并可点击（AC-R2-1/2）；预览内容与主仓库该路径文件逐字一致（AC-R3-1）——宿主不可达记录复现步骤不冒充 | L3（宿主端到端） | AC-R1-2/R2-1/R2-2/R3-1；S8 验收 5 |
| TC-S8-03 | 🟢 P0 | 未 promote 分支态 fixture（文档仅存在于 .legion-worktrees/<T>/） | E2E：打开该任务详情预览 | 预览内容与 w/<id> 分支文件（worktree 目录文件）逐字一致，source 标注 worktree——AC-R3-2 | L3 | AC-R3-2；S8 验收 6 |
| TC-S8-04 | 🟢 P0 | 契约文档缺失场景 fixture | E2E：缺失任务结算 → 查看任务状态与评论 | 任务停 in_review；评论提示含期望路径（含已登记清单）——AC-R1-4 | L3 | AC-R1-4；S8 验收 6 |
| TC-S8-05 | 🟢 P0 | 打回重做多轮 fixture（同任务两条登记） | E2E：打开详情查看产出文档区排序与预览 | 多轮条目按时间倒序可见且最新可预览（旧版保留条目）——AC-R2-3 | L3 | AC-R2-3；S8 验收 6 |
| TC-S8-06 | 🟢 P1 | S6/S7 合入 | E2E：S2 经典看板（serve.mjs 或 DSH 托管任一）打开同一 md 文档型任务 | 出现可读预览（md 渲染或明文全文），内容与真实文件一致；两条 html 逐条可预览——AC-R4-1/2 | L3 | AC-R4-1/2；S8 验收 7 |
| TC-S8-07 | 🔴 P1 | 含 script/img onerror/javascript: 注入的样例 md 文档任务 | E2E：分别在 S1 详情与 S2 看板预览 | 无脚本执行、无弹窗；内容按文本呈现——AC-R3-5 端到端 | L3 | AC-R3-5；S8 验收 7；I-2 |
| TC-S8-08 | 🟢 P0 | S8 执行完毕 | git diff 复核全批 package.json；全仓 grep dangerouslySetInnerHTML（workbench/src plugins board-plugin/src scrum） | 零新增运行时依赖（无 package.json 依赖变更）；本批新增/修改源码 dangerouslySetInnerHTML 0 匹配——AC-R3-5 审查断言 | L3 + 评审 | S8 验收 8；I-1/I-2 |
## 5. 关键业务规则 正反向覆盖矩阵

| 业务规则 | 正向用例（规则成立/被满足） | 反向用例（违反/攻击/边界被拒） |
| --- | --- | --- |
| 岗位文档契约（七文档岗各一条，path 与 prompt 一致） | TC-S1-01/07/13（七岗 docs 存在、path 逐字一致、契约条目数正确） | TC-S1-03/04（docs 缺省回退 artifact、未知角色/空契约不抛错不崩溃） |
| {taskId} 模板展开（reviewer 动态文件名） | TC-S1-02（T-106/T-009/T-1234 展开正确）/ TC-S2-02（实际登记无残留字面量） | TC-S1-10（taskId 注入 ../ 或盘符 → 拒绝或消毒不越权） |
| roles.json 只增不改（既有字段逐字节 + 消费方兼容） | TC-S1-05/06（仅新增 docs 字段、JSON 合法、pipeline 零感知） | TC-S1-08（损坏 JSON → 可读错误而非静默错误数据） |
| 自动登记兜底（worker 不填 artifact 也登记） | TC-S2-01/02/04（requirement/reviewer 登记成功、补齐后照常流转） | TC-S2-03（契约文档缺失 → 停 in_review + 缺失提示，不误判成功流转） |
| gate 岗语义与双写路径不回归 | TC-S2-05（researcher 登记后仍 in_review 人工验收；hub 可用走 POST /api/artifact） | TC-S2-05（hub 不可用走 taskctl artifact argv 双路径一致）；TC-S2-08（coder 零契约登记、自填 artifact 不回退） |
| 登记幂等/多轮追加（防打回刷屏 + 多轮数据源） | TC-S2-06（内容变化 → 追加新条目，旧版保留） | TC-S2-06（同 path 同字节 → 幂等跳过不重复登记） |
| 完成评论只给产出清单（防刷屏） | TC-S2-07（有登记 → 清单摘要；有缺失 → 缺失提示） | TC-S2-07（非文档岗无登记无缺失 → 评论不含产出清单） |
| 内容逐字一致（主分支态） | TC-S3-01（source=main 与 readFileSync 字节 diff 为空） | TC-S3-01（content 与文件不一致 = FAIL）；TC-S3-14（txt/md Content-Type 与内容逐字） |
| 内容逐字一致（未 promote 分支态，worktree 优先/主仓兜底） | TC-S3-02（source=worktree 逐字一致） | TC-S3-03（删 worktree 目录后自动回退 source=main 逐字一致，不 500） |
| 白名单/路径只取登记（防任意文件读取） | TC-S3-01/12（合法登记条目可读，url 类明确不可预览） | TC-S3-04/05/06（../、盘符、.git 段、符号链接逃逸、?path= 查询串 → 403/拒绝）；TC-S3-15（跨空间不读） |
| 读取上限与二进制（不静默截断/不白屏） | TC-S3-07（≤512KB 全量 + truncated=false） | TC-S3-07（>512KB truncated=true + 可下载提示）；TC-S3-08（NUL/非法 UTF-8 → previewable=false 不报错） |
| 错误码可区分（404/400/403） | TC-S3-09（成功 200 含 content 字段） | TC-S3-09（任务不存在/文件不存在 404、i 越界/无登记 400、越权 403，各响应文案明确可区分） |
| 存量绝对路径记录读取期兼容（零迁移） | TC-S3-10（命中 worktreeRoot/<id>/ 或 local_dir 前缀 → 剥前缀解析成功） | TC-S3-10（非两前缀绝对路径 → 404/明确文案，不越权读） |
| md 结构可读（可读等价） | TC-S4-01/02（标题/表格/代码块等关键文本可见、正文文本可达） | TC-S4-03/08（空文档/超长/错乱表格/未闭合围栏 → 不崩溃、尽力结构或文本兜底） |
| 渲染安全（脚本/HTML 不执行、协议白名单） | TC-S4-06（白名单内 http/https/mailto/相对/# 链接可点） | TC-S4-04/05/10（script/img onerror/iframe 按文本、无事件属性、实体绕过无效）；TC-S4-06（javascript:/data:/vbscript: 不产生可点 href） |
| 不支持语法按文本回退（子集契约） | TC-S4-07（脚注/删除线/任务列表/原始 HTML 以字面文本呈现） | TC-S4-07（不崩溃、不把 HTML 当标签解析） |
| 详情「产出文档」直达（点击即读） | TC-S5-01/02（区存在列出 ≥1 条、点击同屏全文预览，无路径人工查找） | TC-S5-05（非文档岗/无登记 → 中性占位不误导）；TC-S5-06（404/403/截断/二进制/断网 → 明确文案不白屏） |
| 多轮修订按时间倒序（最新高亮、旧版可查） | TC-S5-04（最新在首 + 高亮，旧条目可打开） | TC-S5-04（排序错误/旧条目不可打开 = FAIL） |
| 既有产物语义不回退（url/html/file） | TC-S5-07（url 外链、html/file 语义保留，与新区并存） | TC-S5-07（任一既有语义丢失 = FAIL） |
| S2 看板逐条可交互（md 预览安全、多条 html） | TC-S6-01（逐条条目 + md 预览动作 + 两条 html 各自入口） | TC-S6-03（file:// 无服务降级为路径 + 服务模式提示）；TC-S6-02（注入 md 按文本无执行） |
| v1 逐条内容服务（i 参数 + 白名单） | TC-S6-04（按 i 返回真实内容、i 缺省取最新兼容） | TC-S6-05（../、.git 段 → 4xx；url 语义 302/明确、file 下载保留）；TC-S6-07（无产物/未知任务中性或 4xx） |
| DSH board-plugin 与 serve.mjs 同语义（逐条 i + 白名单 + 分支态目录） | TC-S7-01/02（逐条返回、i 缺省兼容、raw 直读、相对路径与分支态可读） | TC-S7-03（../、盘符、.git、符号链接 → 4xx 拒绝）；TC-S7-06（与 serve.mjs 语义不一致 = FAIL） |
| 回归面与红线（零依赖/无 innerHTML/既有套件不回归） | TC-S1-12 / TC-S2-10 / TC-S3-13 / TC-S6-06 / TC-S5-09（worker-regression/taskctl.ttl/hub 套件/build 全绿或如实受限记录） | TC-S4-11 / TC-S5-08 / TC-S8-08（grep dangerouslySetInnerHTML 命中或 package.json 新增依赖 = FAIL） |

## 6. 验收标准逐条用例化：需求/验收 → 用例追溯矩阵

> PASS 判据 = 该需求/验收行映射的全部用例通过；机器验收行（TASK_BREAKDOWN §1 S1~S8）→ 用例见各表「追溯」列，下表为需求级汇总。

| 需求/验收（T-103 §5/§6 / TASK_BREAKDOWN §1） | 直接用例 | 边界/异常补充 | 通过判据（汇总） |
| --- | --- | --- | --- |
| AC-R1-1 契约存在性（七岗 docs + 路径与 prompt 一致 + coder 无 docs） | TC-S1-01/07/13 | TC-S1-03/04（回退/健壮） | 七岗 stage.docs 存在、path 逐字一致；coder 无 docs；未知角色不抛错 |
| AC-R1-2 自动登记（worker 不填 artifact 亦登记） | TC-S2-01 | TC-S2-04（补齐重跑） | 结算后 artifacts 追加 docs/REQUIREMENTS.md（kind=file、仓库相对路径、by=守护、含时间） |
| AC-R1-3 reviewer 动态文件名解析登记 | TC-S2-02 | TC-S1-02/10（模板展开与守卫） | 登记 path=docs/review/<任务ID>-REVIEW.md，无 {taskId} 残留 |
| AC-R1-4 缺失提示（停 in_review + 明确提示、补全消除） | TC-S2-03 | TC-S2-04（正向闭环） | 缺失 → in_review + 评论含期望路径；补齐后登记成功提示消除照常流转 |
| AC-R1-5 兼容回归（researcher gate/artifact 不回归、非文档岗零登记、既有登记路径保留） | TC-S2-05/08 | TC-S1-05/06/12、TC-S2-10 | researcher 照旧 in_review 人工验收；coder 零契约登记；自填 artifact 不回退；worker-regression/typecheck 全绿或受限记录 |
| AC-R2-1 详情可达（无路径人工查找） | TC-S5-01 | TC-S8-02（端到端） | 打开文档型 in_review 任务详情见「产出文档」区 ≥1 条（标题+岗位+时间+相对路径） |
| AC-R2-2 打开即读（全文视图非路径/摘要） | TC-S5-02 | TC-S5-03/10（数据面/长文档） | 点击 → 同屏内嵌 MarkdownDocView 全文可读（max-height + 截断提示） |
| AC-R2-3 多轮修订按时间倒序（最新高亮、旧版可查） | TC-S5-04 | TC-S2-06（数据源）、TC-S8-05（端到端） | 打回→重做后条目按时间倒序、最新在首、旧条目仍可打开 |
| AC-R2-4 无文档任务中性占位不报错 | TC-S5-05 | — | 非文档岗/无登记 → 中性占位或区不显示，页面不报错 |
| AC-R2-5 回归（url/html/file 语义不回退 + build） | TC-S5-07 | TC-S5-09（build 冒烟） | 既有产物语义逐条保留；workbench build 0 诊断或受限记录 |
| AC-R3-1 内容一致（主分支态，字节 diff 为空） | TC-S3-01 | TC-S8-02（端到端） | preview 输出与主仓库同路径文件逐字一致（source=main） |
| AC-R3-2 内容一致（未 promote 分支态） | TC-S3-02/03 | TC-S8-03（端到端） | .legion-worktrees/<id>/ 优先（source=worktree）；删目录回退 source=main 仍逐字一致 |
| AC-R3-3 路径安全（?path= 拒绝、逃逸 403、错误可区分） | TC-S3-04/05/06 | TC-S6-05/TC-S7-03（v1/DSH 面）、TC-S3-15（跨空间） | 查询串不用来指定文件；../、盘符、.git、根外符号链接 403；错误与正常预览可区分 |
| AC-R3-4 markdown 可读（标题/表格/代码块结构） | TC-S4-01/02 | TC-S4-03/08/09 | 结构正确、关键文本可见；长/畸形文档不崩溃 |
| AC-R3-5 渲染安全（无脚本执行、无新 dangerouslySetInnerHTML） | TC-S4-04/05/06/10/11 | TC-S5-08、TC-S8-07（端到端） | 注入 md 无执行；javascript: 不产生可点 href；grep 0 匹配；协议白名单集中一处 |
| AC-R3-6 超长/二进制（截断提示、previewable=false 不白屏） | TC-S3-07/08 | TC-S5-10（前端长文档） | >512KB truncated=true + 提示；NUL/非法 UTF-8 previewable=false 不报错 |
| AC-R3-7 回归（v1 html/file/url 与文件中心不受影响） | TC-S3-13 | TC-S6-04/05、TC-S7-01 | hub 既有套件全绿；v1 /api/artifact 语义与文件中心不受影响（S6/S7 回归行） |
| AC-R4-1 S2 详情 md 可读预览（内容一致） | TC-S6-01/02 | TC-S8-06（端到端） | 生成 kanban.html 含逐条条目 + md 安全预览；内容与真实文件一致 |
| AC-R4-2 多条 html 逐条可预览（升级仅最新一条行为） | TC-S6-01 | TC-S7-01/04（DSH 面） | 两条 html 各带独立预览入口，均可达；board 端点 i 逐条同语义 |
| AC-R4-3 url/file/html 既有语义不回退 | TC-S6-05 | TC-S7-06（与 serve 对齐） | url 跳转/file 下载/html 语义保留；render.mjs 真实库无错、taskctl.ttl 不回归 |
| §6 E2E-1 典型主路径（S1 详情直达阅读） | TC-S5-01/02 | TC-S8-02 | 全程无需离开任务详情找路径 |
| §6 E2E-2 未 promote 边界（预览仍可得且一致） | TC-S3-02/03 | TC-S8-03 | 验收时刻文档在 w/<id> 时预览内容与分支文件一致 |
| §6 E2E-3 缺失边界（任务停 in_review + 明确提示） | TC-S2-03 | TC-S8-04 | 缺 docs/<约定路径> 明确提示、不误判成功流转 |
| §6 E2E-4 打回重做边界（多轮条目可见） | TC-S5-04 | TC-S8-05 | 最新可见、旧版可查 |
| §6 E2E-5 安全边界（白名单 + 无脚本执行） | TC-S3-04/05/06、TC-S4-04/05/06 | TC-S8-07 | 仓库根外不可读；md 预览不执行脚本 |
| S1~S8 机器验收行（DoD/命令/期望分句逐条） | 各表「追溯」列（Sx 验收 n） | — | §4 各片表内引用用例全过 + 该片 P0 用例落成断言 |
| T-106 阶段验收 1（主路径+边界+异常，每条含前置/步骤/期望） | §4 全部用例 | — | 每条含三要素 + 类别 + 优先级 |
| T-106 阶段验收 2（验收标准用例化、明确通过/失败判据） | 每条「期望结果 / 通过判据」列 + §6 矩阵 | — | 无黑盒结论（可命令/断言/可观察状态表达） |
| T-106 阶段验收 3（关键业务规则正反向成对） | §5 矩阵 | — | 20+ 条规则成对覆盖 |

## 7. 浏览器手工验收清单模板（L2，tester 执行时逐条勾选并记录可见结果）

### 7.1 S1 详情「产出文档」直达（S5，R-2/R-3）
- [ ] 打开文档型 in_review 任务详情 → 「产出文档」区列出登记文档 ≥1 条（标题+岗位+时间+相对路径可复制），无需找路径（TC-S5-01）
- [ ] 点击条目 → 同屏内嵌 MarkdownDocView 渲染全文（滚动容器 + 截断提示）（TC-S5-02）
- [ ] 多轮任务：最新条目在首高亮、旧条目仍可打开（TC-S5-04）
- [ ] 非文档岗/无登记任务详情 → 中性占位、页面不报错（TC-S5-05）
- [ ] 404/403/截断/二进制/断网场景 → 明确错误文案不白屏（TC-S5-06）
- [ ] url 外链/html/file 既有产物语义仍可用（TC-S5-07）
- [ ] 文档含脚本注入样本 → 纯文本显示、无弹窗（TC-S5-08）

### 7.2 S2 经典看板逐条预览（S6/S7，R-4）
- [ ] kanban.html 产物区逐条条目（kind 徽标+title+时间+路径）；md 条目「预览」可点（TC-S6-01）
- [ ] 两条 html 各带独立预览入口且均可打开（TC-S6-01/TC-S7-04）
- [ ] md 预览含脚本样本 → 按文本显示无执行（TC-S6-02）
- [ ] file:// 双击模式 → 预览动作降级为路径 + 服务模式提示（TC-S6-03）
- [ ] url 外链跳转 / file 下载语义保留（TC-S6-05）
- [ ] DSH 托管态（board-plugin）同一任务逐条预览可点通（TC-S7-04，宿主可达时）

## 8. 测试夹具与数据约定（供 coder 落测试 / tester 执行）

### 8.1 岗位文档契约夹具（S1/S2 用）

- roles.json 目标态（S1 后）：七文档岗 stage 新增 docs；此处给出断言用基线对照表（requirement→docs/REQUIREMENTS.md、researcher→docs/RESEARCH.md、breaker→docs/TASK_BREAKDOWN.md、test-designer→docs/TEST_CASES.md、reviewer→docs/review/{taskId}-REVIEW.md、tester→docs/TEST_REPORT.md、devops→docs/DEPLOY.md；coder 无 docs）。
- 模板展开用例：taskId 样本集 = [T-106, T-009, T-1234, T-1]；越权样本 = [../x, C:/x, ../../etc]（expect 拒绝/消毒）。
- 解析函数变体输入：stage 含 docs 数组 / docs 缺省仅 artifact（researcher 等价单值）/ 两者皆无 / docs=null / docs=字符串 / docs 元素缺 path / 未知 role。
- roles.json 损坏样本：截断 JSON、非法 JSON、非对象根。
- 字节比对基线：git show fa9c568:roles.json（S1 前 roles.json 内容）。

### 8.2 结算自动登记夹具（S2 用；仿 worker-regression fake-hub fixture）

- fixture 任务库形状：任务含 id/role/status=done 前序字段；worktree 目录可注入（含或不含契约文档路径）。
- 场景矩阵：
  - requirement 岗 done + worktree 含 docs/REQUIREMENTS.md + 报告无 artifact → expect 登记一条（TC-S2-01）
  - reviewer 岗 done + 含 docs/review/T-106-REVIEW.md → path 展开登记（TC-S2-02）
  - requirement done + 缺文档 → in_review + 缺失提示评论（TC-S2-03）；补文档重跑 → 登记成功 + 提示消除（TC-S2-04）
  - researcher gate done + 有文档 + hub mock 可用/不可用 → 双写分支断言（TC-S2-05）
  - 两次结算内容 A/A（幂等）+ A/B（追加）（TC-S2-06）
  - coder done + 报告自填 artifact（TC-S2-08）
- hub mock：可注入 POST /api/artifact 成功/失败/不可达；taskctl artifact argv 捕获。
- 时序断言：登记动作发生在 commitWorktree 之后、autoPromote 之前（fixture 以 spy/桩记录调用顺序）。

### 8.3 内容通道夹具（S3 用；仿 skills.test.mjs：临时 TEAM_HUB_DB + import server.mjs）

- 临时仓库根 local_dir 双树：主树 docs/x.md（内容 C）；local_dir/.legion-worktrees/<T>/docs/x.md（内容 W）。逐字比对基准 = readFileSync 原文件。
- 逃逸样本登记 path：[../../etc/passwd, C:/x, docs/.git/config, a/.git/b, docs/link.md（符号链接指向根外）]。
- 截断文件：511KB / 512KB / 513KB（三值法，上限常量导出）；二进制样本：含 NUL 字节文件、非法 UTF-8 文件。
- legacy 绝对路径登记：worktreeRoot/<id>/docs/x.md 前缀、local_dir/docs/x.md 前缀、其它绝对路径 /etc/hosts。
- 跨空间：任务 T 归属空间 local_dir=L1；L2 建同名 docs/y.md 不同内容（expect 不读）。
- 空文件 / txt / .markdown / md / url 类条目样本。

### 8.4 markdown 渲染样例（S4 用；doc-render.test.mjs 内置样例常量）

- 结构样例（AC-R3-4）：包含 标题 h1/h2/h3、段落、粗体、斜体、行内代码、围栏代码块（含语言标注行）、有序列表、嵌套无序列表、表格（含空单元格）、引用块、分割线、链接（https 与相对路径与 # 锚点）。
- 安全注入样例（AC-R3-5）：
  - script 注入：段落文本包含 <script>alert(1)</script>
  - img onerror：<img src=x onerror=alert(1)>
  - 危险协议链接：[点我](javascript:alert(1))、data:text/html、vbscript:
  - 事件属性文本：onclick=alert(1) / onerror 字符串
  - 实体/表格注入：&lt;script&gt;、表格单元格内 <b>raw</b>
- 回退样例：脚注 [^1]、删除线 ~~x~~、任务列表 - [ ] 待办。
- 畸形样例：未闭合围栏（三个反引号不闭合）、列数不一致表格、10 万字符长文。
- 真实文档冒烟：docs/REQUIREMENTS.md 与 docs/RESEARCH.md 各取前 80 行节选（关键标题与表格行断言）。

### 8.5 详情与看板 fixture（S5/S6/S7 用）

- 任务数据（hub tasks/artifacts）：文档型 in_review 任务 T1 含登记 [md 条目 A（docs/REQUIREMENTS.md，时间 t1）, md 条目 B（同 path 第二轮修订，时间 t2>t1）, html 条目 x2, url 条目, file 条目]；非文档岗任务 T2（coder，无登记）；无产物任务 T3；含脚本注入内容任务 T4。
- render.mjs fixture 任务库：经临时替换 scrum/tasks.json 或环境注入（仿 taskctl.ttl.test.mjs 自清理，不污染真实数据）；产物条目按 v1 taskctl artifact 形状（kind/path/title/at）。
- serve.mjs/board-plugin 端点请求矩阵：i=0/1/…/n、i 缺省、i 越界、task 未知、path 越权。

### 8.6 env / token / 端口约定

| 用途 | env/参数 | 说明 |
| --- | --- | --- |
| hub 临时库/端口 | TEAM_HUB_DB / TEAM_HUB_PORT / TEAM_HUB_HOST | S3 测试临时库 import（isMain 不占端口）或 listen(0) |
| hub 仓库根 | spaces.local_dir（空间 S 指向临时仓库根） | S3 双树 fixture 注入点 |
| 截断上限 | 预览上限常量导出（默认 512KB，⚖️ 可配） | 三值法（TC-S3-07） |
| hub 写 token | TEAM_HUB_TOKEN（非空时写需 Bearer） | 401 断言沿用既有 token 用例语义 |
| 守护结算 | fake-hub / taskctl argv 双路径注入 | S2 fixture（TC-S2-05） |
| 前端构建 | pnpm --dir workbench build / pnpm --dir board-plugin typecheck | tsc 0 诊断为沙箱内最严证据；EPERM/无 node_modules → R-18 记录 |

## 9. 附录

### 附录 A：现状代码证据锚点（REQUIREMENTS §2/§11 精简；行号基于基线 fa9c568，S1~S8 目标代码未实现前为现状形态）

| 主题 | 证据 |
| --- | --- |
| 岗位→文档路径契约（prompt 文本，现无机器字段） | roles.json:11（requirement）、:17/:19-20（researcher + gate/artifact）、:25（breaker）、:31（test-designer）、:43（reviewer 动态文件名）、:49（tester）、:55（devops） |
| 守护 gate/artifact 校验（仅 researcher）与完成评论 | plugins/src/index.ts:1300-1318（docOk :1306、完成评论 :1315） |
| 产物登记触发点（worker 报告自填）与双路径 | plugins/src/index.ts:943-950（recordArtifact）、:1289（done 结算）、:1104-1106（「artifact 可选」提示词） |
| 内容时序（commitWorktree→autoPromote/in_review） | plugins/src/index.ts:1287-1334（:1292 autoPromote、:1326-1331 末环节点 in_review） |
| v2 任务产物数据面（artifacts 列，无内容 GET） | team-hub/server.mjs:94-100/:282-287/:1260-1273（POST /api/artifact）；:378-384（任务返回） |
| S1 详情产物区（纯路径文本）与取数 | workbench/src/components/TaskDetailModal.tsx:419-434；workbench/src/api.ts:269-272（fetchHubTask）；types.ts:290-315 |
| S2 详情产物区（最新 html iframe/file 下载/url） | scrum/render.mjs:437 |
| v1 内容服务（白名单、只读登记路径） | scrum/serve.mjs:452-473（GET /api/artifact） |
| DSH board-plugin artifact 服务（slice(-1) 只取最新） | board-plugin/src/index.ts:66-110（artifactAllowed :66-73、slice(-1) :86） |
| 渲染安全红线（无 dangerouslySetInnerHTML） | workbench/src/components/ChatView.tsx:13/:49、FilesView.tsx 渲染安全注释、ActivityFeed.tsx:72 |
| 既有测试面 | team-hub skills/chat/calendar/chat-l1-smoke；plugins tests worker-regression/slice-orchestration；scrum taskctl.ttl.test.mjs；workbench scripts web.test.mjs/files-api.test.mjs |

### 附录 B：测试代码落点骨架（coder 落盘时照此；断言细则以 §4「期望结果 / 通过判据」列为准；P0 用例必须各有一条对应断言）

S1 → plugins/tests/doc-contract.test.mjs（新增；node --test 或宿主受限时 node 直跑等效；先 pnpm --dir plugins build）：
- 契约清单断言：读仓库 roles.json，对七文档岗断言 stage.docs 存在且 path 与对照表一致；coder 无 docs。
- 解析纯函数断言：expandDocContract(role, taskId) 的模板展开（reviewer 三例）；归一化回退（docs ?? artifact 单值 ?? []）；非法输入（未知 role/null/坏 docs）不抛错返回空或可读错误。
- 字节比对断言：git diff fa9c568 roles.json 只增 docs；JSON.parse 合法。

S2 → plugins/tests/artifact-register.test.mjs（新增；fixture 回放 done 结算，fake-hub mock，仿 worker-regression）：
- requirement 无 artifact 报告 → artifacts 追加 {kind:'file', path:'docs/REQUIREMENTS.md', by:'守护'} + 时间（TC-S2-01）；reviewer path 展开（TC-S2-02）；缺失 → in_review + 提示评论（TC-S2-03）；补齐重跑（TC-S2-04）；gate 双写两分支（TC-S2-05）；同字节幂等 + 变化追加（TC-S2-06）；评论防刷屏（TC-S2-07）；coder 零登记 + 自填保留（TC-S2-08）。

S3 → team-hub/artifact-content.test.mjs（新增；临时 TEAM_HUB_DB + import server.mjs，HTTP 或 DAO 层均可；双树仓库 fixture）：
- 逐字：GET 返回 content 与 readFileSync 比对（主树 source=main / worktree 目录 source=worktree / 删除目录回退）（TC-S3-01/02/03）。
- 逃逸：../../、盘符、.git 段、根外符号链接、?path= 查询串 → 403/忽略（TC-S3-04/05/06）；跨空间不读（TC-S3-15）。
- 读取规范：511/512/513KB（truncated 翻转）、NUL/非法 UTF-8（previewable=false）、错误码矩阵 404/400/403、legacy 绝对路径前缀兼容、只读无 audit（TC-S3-07..11、TC-S3-14）。

S4 → workbench/scripts/doc-render.test.mjs（新增；vite ssrLoadModule 载入 MarkdownDocView + react-dom/server renderToString）：
- 结构断言：样例 md → 输出含 h1/h2、strong/em、pre 代码块原文、table 单元格文本、blockquote、hr、白名单 a[href]；关键文本 in 输出（TC-S4-01/02）。
- 安全断言：script/img onerror/iframe/事件属性/javascript: 链接 → 输出无对应标签/属性/协议 href，注入内容按文本出现（TC-S4-04/05/06/10）。
- 回退/健壮断言：未知语法、未闭合围栏、错乱表格、空文档、长文档 → 不抛错按文本或结构呈现（TC-S4-03/07/08）。
- 真实文档冒烟（宿主可用时）：REQUIREMENTS/RESEARCH 节选渲染关键标题可见（TC-S4-09）。

S6 → scrum/artifact-detail.test.mjs（新增；fixture 任务库临时替换/环境注入，仿 taskctl.ttl.test.mjs 自清理）：
- render 产物断言：--out 临时目录生成 kanban.html，产物区含逐条条目（kind 徽标/title/时间/路径），md 带预览动作，两条 html 各自入口，file:// 降级分支存在（TC-S6-01/03）。
- 安全断言：含注入 md → 生成 HTML 无未转义 script/事件属性（TC-S6-02）。
- serve 端点断言：i 逐条返回（md Content-Type text/markdown）、i 缺省取最新、i 越界/未知任务 4xx、../ 与 .git 拒绝（TC-S6-04/05/07）。

S7 → board-plugin/src/index.ts 端点语义：typecheck/build 0 诊断；端点行为以代码审查断言对齐 serve.mjs 语义 + DSH 冒烟（宿主可达时）逐条 i/缺省/越界/raw/白名单（TC-S7-01..06）。

S5/S8（前端/收口，无新 test runner 或为验证型）：以 §7 清单 + 评审断言（grep dangerouslySetInnerHTML、api.ts fetchHubDocContent 存在、types 扩展、详情区/空态/错误文案）+ §4.8 端到端清单为准；结果沉淀 docs/TEST_REPORT.md。

### 附录 C：机器复核（本文件自检）

- 用例计数、类别分布、追溯引用完整性、正反向矩阵与 §4 的 ID 一致性：以一次性 Node 脚本复核为准（读取 docs/TEST_CASES.md，按「| TC-S」行抽取用例编号并统计类别/优先级、校验 ID 唯一、校验 §5/§6 矩阵引用的 ID 均存在于 §4）。结果写入 docs/T106-evidence/01-doc-machcheck.txt（含每片计数与类别分布，与 §0 设计值核对；若有差异以脚本复核为准，表内为设计值）。
- 行数/计数（T-106 阶段验收用）：实测 machcheck PASS——82 条（S1 13 / S2 10 / S3 15 / S4 12 / S5 10 / S6 8 / S7 6 / S8 8）；🟢正常 46 / 🟡边界 18 / 🔴异常 18；P0=71 / P1=11；unique=82、dup=0、dangling=0（§5/§6 引用 ID 全部存在于 §4）。本文件机器复核脚本与完整输出：docs/T106-evidence/01-doc-machcheck.txt。

### 附录 D：风险与开放项

- R-11 同文件域串行（plugins/src/index.ts 归 S1→S2；workbench/src/index.css 只归 S5）：用例按切片归属文件，coder 不越域写测试文件（TASK_BREAKDOWN §2.2）。
- R-12 假设待下游复核：H-1（docs 字段对象/字符串形态）、H-3（内容端点形状与字段名）、H-5（512KB 可配常量名）、H-6（md 渲染子集边界与白名单）、S6/S7 端点参数名（i）——均为本文件内可单点修改的用例形状/默认值；实现若给不同契约/常量，仅改对应行请求形状或常量，断言语义不变。
- R-13 宿主面环境受限：plugins typecheck/build、workbench pnpm build、board-plugin typecheck/build、S4 真实文档冒烟、S5/S8 宿主端到端、S7 DSH 冒烟均需宿主（本 worktree 无 node_modules；spawn EPERM 史）——按「环境受限 + 复现步骤」记录，不冒充通过（TC-S1-11/S2-10/S4-12/S5-09/S7-05 等）。
- R-14 结算登记与既有 worker 自填 artifact 的关系：共存不互斥（S2 机器行）；若实现选择去重（同 path 覆盖而非追加）需将军裁决——默认按 TASK_BREAKDOWN 幂等/追加语义断言（TC-S2-06）。
- R-15 S5 空态文案与「产出文档」区命名以实现为准：断言语义（区存在/中性占位/不报错）优先于文案字面（TC-S5-05）。
- ❓ 未 promote 分支态「w/<id> 分支文件」与「.legion-worktrees/<id>/ 目录文件」的等价性：本文件按 G-R7/H-4（单机同仓、目录即分支态实态、零 git CLI）断言目录文件逐字一致；若将军要求严格 git show w/<id> 字节比对（需 git CLI），TC-S3-02/03 与 TC-S8-03 增加 git show 比对命令形态（宿主可达时）。
- ❓ S8 宿主端到端依赖守护 + hub + workbench 托管；不可达时以各切片 L0/L1 判据 + 受限记录共同给出结果，不静默判过。

---
（本文档由 T-106 test-designer 产出；只写用例与落点，不写业务实现、不执行用例——执行为 tester 职责。改动仅落 w/T-106 worktree，不 push；本文件取代 T-098 批 docs/TEST_CASES.md，旧版经 git 历史回溯。）
