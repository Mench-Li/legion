# T-108 代码审查报告（review）——「需求澄清/方案确认等产生文档的环节，任务详情直接打开预览」

> 审查对象（本任务 = T-107 编码 diff 的独立代码审查）：
> - coder 提交 **de3c49c**（分支 w/T-107，基线 = promote T-106 e0e529f），经 promote **835dc77**（mediator resolve，另一父 92cd5e1 = promote T-101）合入当前 HEAD；被审 diff = **git diff 92cd5e1 835dc77**（33 文件 +2284/-160），审查工作树 w/T-108 @ HEAD **835dc77**（main fd7b186 = 835dc77 + 2 条将军 P3 文档提交，未触及业务文件）；
> - 审查基线 AC = 本目标链产物：docs/REQUIREMENTS.md（T-103，R-1..R-4 / AC-R1-x..R4-x）、docs/TASK_BREAKDOWN.md（T-105，切片 S1..S8 机器验收行）、docs/TEST_CASES.md（T-106，82 条用例）——全部为当前 main 上的现行版本，非 scratch/baseline 旧档；
> - 审查方式：33 个改动文件逐一正读（plugins S1/S2 纯函数 + done 结算接线、roles.json 契约、team-hub S3 内容端点 + 路径安全、workbench S4 渲染器全文 + S5 详情直达区、scrum S6 render/serve、board-plugin S7 + 5 个新测试文件全文）+ 独立复跑 + 静态走查（XSS 面 / 路径逃逸 / 三端语义一致性 / 幂等 / 状态残留）。只给反馈，未改任何实现代码。
> 结论分级：**必须修改**（AC 未达成 / 实测行为缺陷 / 语义不一致可致流程误停）与**建议优化**（可排期）。严重度 高=红 / 中=橙 / 低=黄。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 环境 | node v24.19.0；沙箱 workspace-write、禁网、无审批通道；worktree w/T-108 @ HEAD 835dc77 | 与 coder 自述同型沙箱；**本 worktree 无 node_modules 且无 plugins/lib（构建产物，gitignore 不入库）** |
| S3 hub 内容端点套件 | node team-hub/artifact-content.test.mjs | **16/16 fail 0，exit 0**（主分支态逐字一致 / 分支态优先、删 worktree 回退主仓 / 存量绝对路径兼容 / 越权 403 / 404 vs 400 区分 / 512KB 截断 / NUL、非法 UTF-8 二进制降级） |
| S6 经典看板套件 | node scrum/artifact-detail.test.mjs | **10/10 fail 0，exit 0**（render.mjs --out 生成 kanban.html 静态断言：artifactSection/wireArtifacts/data-artact/逐条 html/降级提示/旧块移除；serve.mjs L1 真 HTTP：i 逐条 + 分支态优先 + content-type + url/file + 越界 400 + 403/404 矩阵） |
| S1/S2 plugins 套件 | node plugins/tests/doc-contract.test.mjs / artifact-register.test.mjs | 未能复跑（环境）：import ../lib/index.js → ERR_MODULE_NOT_FOUND（本 worktree 未产出 plugins/lib；devDeps 不在 worktree）；coder 证据 01/02 记录当时 4/4 与 7/7 exit 0。本轮以源码精读 + node --check 替代（见 §1/§3） |
| S4 渲染器套件 | node workbench/scripts/doc-render.test.mjs | 未能复跑（环境）：react-dom 不在 worktree 可解析链（无 node_modules）；coder 证据 04 记录当时 11/11 exit 0。本轮 MarkdownDocView.tsx 全文精读 + 结构/安全用例人工逐条核对 |
| 三包 typecheck | tsc -p plugins/board-plugin/workbench/tsconfig.json --noEmit | 未能复跑（环境）：缺 @types/node 等类型包 → TS2688（exit 2）；coder 证据 07/08/09 记录三包均 0 诊断 |
| 语法校验 | node --check scrum/serve.mjs render.mjs team-hub/server.mjs plugins/tests/*.test.mjs scrum/artifact-detail.test.mjs team-hub/artifact-content.test.mjs | **全部 exit 0** |
| 改动范围 | git diff 92cd5e1 835dc77 --stat | 33 文件全落在 S1..S8 声明文件域；**零新增运行时依赖**（无 package.json 依赖变更）；本审查仅新增 docs/review/T-108-REVIEW.md（+ scratch/ 临时目录未跟踪） |
| XSS 面静态核对 | grep MarkdownDocView/TaskDetailModal/render.mjs 的 dangerouslySetInnerHTML/innerHTML/textContent/iframe 用法 | MarkdownDocView **零** dangerouslySetInnerHTML（React 元素直出）；render.mjs 预览弹层经 textContent 写入 pre 或独立 iframe（iframe src 指向受控 /api/artifact raw=1，非外部 HTML 注入） |

### 0.1 审查口径注记
- 本任务链 = T-103（需求）→ T-104（方案）→ T-105（拆解 S1..S8）→ T-106（82 用例）→ T-107（编码，S1..S7 实现 + S8 自测锚定）→ T-108（本审查）。审查按 **S1..S8 机器验收行 + AC-R1-x..R4-x** 逐条核对（§1），不重复评审更早批次面。
- 沙箱限制如实登记：plugins/workbench 三套件与三包 tsc 因缺 node_modules/lib 无法复跑（禁网禁装）；与 coder 证据（其环境内 exit 0）的差异仅在于本 worktree 无依赖产物，非代码差异。宿主补跑命令列于 §0 表。
- 三端（hub v2 / serve.mjs v1 / board-plugin DSH）对「同一功能」各自实现，语义存在细微分叉，见 O2。

---

## 1. 验收口径逐条核对

| # | 口径（TASK_BREAKDOWN S1..S8 机器行 / REQUIREMENTS AC / TEST_CASES） | 结论 | 依据 |
| --- | --- | --- | --- |
| S1 / AC-R1-1,5（岗位文档契约数据模型） | 通过（1 项注记 → O7） | roles.json 七文档岗各含 stage.docs（requirement→docs/REQUIREMENTS.md … reviewer→docs/review/{taskId}-REVIEW.md … devops→docs/DEPLOY.md），coder 无 docs；git diff 确认 **仅新增 docs 字段**，prompt/gate/artifact/next 原文逐字节不动（roles.json.diff 4 hunks 全为追加）；stageContractDocs/resolveStageDocPaths 纯函数：docs 数组优先、缺省回退 artifact、{taskId} 模板展开、路径规范化、空/非法项过滤、未知角色空数组不报错（doc-contract.test 断言面）；fileDigest sha256 |
| S2 / AC-R1-2..5、AC-R2-3、G-R2（结算自动登记 + 缺失软门禁） | **2 项必须修改（M1/M2）**，主体逻辑通过 | registerContractDocs（plugins:1169）：done 结算在 commitWorktree 后、autoPromote 前登记仓库相对路径 + kind=file + by=守护 + sha256 digest；hub 可用 POST /api/artifact 双写否则走 taskctl（与 recordArtifact 双路径惯例一致）；幂等（同 path 上一条 digest 相同则跳过）支撑 AC-R2-3 多轮倒序数据源（artifact-register.test 第 7 例：v1/v2 两次登记两条、字节未变不重复）；缺失文档停 in_review + 明确评论（AC-R1-4），补全重跑照常流转（第 6 例）；coder 无契约登记、worker 自填 artifact 不回退（第 7 例）。**问题**：M1 registerContractDocs 路径不感知目标级 docsDir（与同函数 gate 校验 goalDocPath 语义分裂，docsDir 目标必误停）；M2 登记写入失败被并入 missing → 误停 in_review 且评论归因错误 |
| S3 / AC-R3-1..7、K5-A、K9、K10（hub 内容端点） | 通过（2 项健壮性注记 → O1/O2） | GET /api/artifact/content 只取任务登记记录 + i 序号（查询串无 path 参数，AC-R3-3）；resolveArtifactReadTarget：段级防越权路径段（含 .git 不分大小写、盘符、跨任务 worktree：.legion-worktrees 首段必须本任务 id）+ realpath 复检防符号链接逃逸（server.mjs:1764-1766）+ worktree 目录优先/主仓兜底 + 存量绝对路径剥前缀（K10，不跑迁移）；512KB 截断 + NUL/非法 UTF-8 → previewable=false（AC-R3-6）；错误码 400/403/404 可区分（K9）；实测 16/16 绿。**注记**：读取先整文件进内存再截断（O1）；i 非法值静默取最新与 serve/board-plugin 的 400 不一致（O2） |
| S4 / AC-R3-4,5、K6-A（md 渲染组件） | 通过（子集边界注记 → O3） | MarkdownDocView 自研子集渲染器：React 元素直出零 dangerouslySetInnerHTML；SAFE_PROTOCOLS 集中（http/https/mailto）且相对路径/# 放行，javascript:/data: 退纯文本（safeHref 单元矩阵）；script/img onerror 原始 HTML 按文本转义；行内/块级主语法（标题/段落/粗斜体/删除线/行内码/围栏/嵌套列表/表格/引用/分割线/链接）结构用例齐备（doc-render.test 11 用例）；图片等子集外语法文本回退。**注记**：围栏闭合判定粗糙、未闭合围栏吞掉其后全部内容（O3，与「不吞内容」子集承诺相悖） |
| S5 / AC-R2-1..5（任务详情产出文档直达区） | 通过（状态缓存注记 → O5） | TaskDetailModal 新增「产出文档」小节：登记文档按 at 倒序、最新在首高亮（doc-newest + 最新徽标，AC-R2-3）；条目含岗位（ROLE_LABEL 覆盖七文档岗）/时间/路径可点复制；点击同屏 fetchHubDocContent → MarkdownDocView/max-height 滚动/截断提示/二进制不可预览明确文案（AC-R2-2、K9 前端守卫）；非文档岗/无登记 → 中性空态占位不报错（AC-R2-4）；api.ts fetchHubDocContent 错误文案透传；types.ts HubDocContent 契约。**注记**：docOpen/docState 缓存不随 taskId/刷新重置（O5，当前 append-only 数据源下影响极小）；copyDocPath 在非安全上下文 navigator.clipboard 缺失时抛 TypeError 无提示（O4） |
| S6 / AC-R4-1..3、K4-B、K8-A/C（经典看板逐条 + serve.mjs） | 通过 | render.mjs artifactSection 逐条条目（kind 徽标+title+时间+路径）+ wireArtifacts 逐条预览：html 独立 iframe、md/txt fetch 后 textContent 进 pre（天然转义）、url 外链保留、file 下载、file:// 双击模式明确降级提示；旧版「仅最新一条」块已移除（artifact-detail.test 静态断言 + 实测 10/10）；serve.mjs /api/artifact 逐条化（i 缺省=最新兼容、越界/非法 400、未知任务/无产物 404、白名单 403、md→text/markdown、分支态优先读 .legion-worktrees/<taskId>/）；serve.mjs/render.mjs 增加 LEGION_* env 注入 + isMain 守卫导出 server（可测性改造干净，watch/listen 不再误起） |
| S7 / AC-R4-1 DSH 面（board-plugin） | 通过（1 项注记 → O6/O8） | serveArtifact 逐条化（i 缺省兼容/越界非法 400/未知任务 404/url 302 或元信息/md/txt/html content-type）+ resolveArtifactFile 白名单（绝对路径须落 repoRoot/artifactRoots；相对路径拒绝越权段与 .git；分支态优先）。typecheck/build 证据齐（evidence 08/13）；无自动化测试（O8）。**注记**：相对路径分支态候选未做 realpath 复检（与 hub S3 不一致）（O6） |
| S8 / 集成回归锚定 | 通过（本轮复跑部分绿；受限部分如实登记） | TEST_REPORT.md + T107-evidence/ 13 份证据 + s3-l1-smoke.mjs 复跑脚本；本轮复跑 hub 16/16、scrum 10/10 绿；plugins/workbench/typecheck 因缺依赖无法复跑（§0 表）；零新增运行时依赖复核通过 |
| 波次验收 1 | 对照验收标准与编码规范逐条审查，每条结论有依据 | 本报告 §1/§3 |
| 波次验收 2 | 问题清单含严重度 + 位置 + 修改建议 | §3 |
| 波次验收 3 | 明确区分「必须修改」与「建议优化」 | §3.1 / §3.2 |

**总体结论：本批七切片（S1..S7）代码结构与数据面成立、测试设计扎实（本轮独立复跑 hub 16/16 + scrum 10/10 全绿），路径安全/XSS 面处理到位（realpath 复检、段级黑名单、零 dangerouslySetInnerHTML、textContent 落 pre）；无 P0 级正确性或安全问题。存在 2 项必须修改（M1 契约登记不感知目标级 docsDir 致 docDir 目标误停；M2 登记写入失败与「文档缺失」混为一谈致错误停闸归因）+ 8 项建议优化。**

---

## 3. 问题清单

### 3.1 必须修改（M）

**M1【高/红】S2 契约登记路径不感知目标级 docsDir，docsDir 目标结算必误停 in_review**
- 位置：plugins/src/index.ts —— registerContractDocs 路径解析（1169-1199，尤其 1171 行 resolveStageDocPaths(stage, t.id)）、调用点（1593-1607）；对照同函数内 gate 校验（1637 行 goalDocPath(goal, stage.artifact)）、goalDocPath 定义（454-458）、goalizePrompt（460-465）、docsDir 语义说明（448-451）。
- 问题：目标级文档目录（docs/<goalId>/，commit 82d610c/f04801d 已上线并被 buildWorkerPrompt 1308-1312 强制注入 worker：「本阶段产出文档写入该目录…禁止读写仓库根 docs/」）下，文档岗 worker 实际产出 docs/<goalId>/REQUIREMENTS.md，而 registerContractDocs 按 roles.json 静态 rel（docs/REQUIREMENTS.md）在 worktree 根找文件 → 必然 missing → 软门禁停 in_review、评论误称「契约产出文档缺失」，且文档永不登记。同一 settle 流程里 gate 校验（1637）却正确经 goalDocPath 解析 docDir——**同函数两处语义分裂**。当前 G-mtpaab3x-1 目标无 docsDir 不受影响，但任何带 docsDir 的并行目标（P2 现场验收演示的运行模式）一旦走到文档岗结算即触发；S1/S2 测试全部用默认路径夹具，**无 docDir 夹具覆盖（测试盲区）**。
- 修改建议：registerContractDocs 路径解析与 gate 同源——settle 前把 rel 集合经 goalDocPath(goal, rel) 化后再登记/判缺；同时在 artifact-register.test.mjs 增补「goal.docsDir 目标 → 登记 docs/<goalId>/X.md 且不误停」夹具用例；若 docDir 目标暂不运营，建议补注释说明前提并保留该路径。

**M2【中/橙】登记写入失败与「文档缺失」混为一谈：hub/taskctl 瞬时故障会把已完成文档岗任务错误停 in_review 并归因错误**
- 位置：plugins/src/index.ts registerContractDocs try/catch（1192-1195：catch 仅 log + missing.push(rel)）+ 软门禁判定（1599-1606）。
- 问题：catch 吞掉「登记写入失败」（hub POST 网络错误/5xx、taskctl 失败）与「文件确实不存在」（existsSync 失败）两种不同原因，统一 push 进 missing → missing.length>0 → 任务停 in_review + 评论「契约产出文档缺失（期望写入 …）」。文件其实存在且内容完整；错误归因会把将军引向「让士兵补文档」的错误动作，且 hub 故障持续期间每次重做都复现（停机循环直到 hub 恢复）。
- 修改建议：区分三类结果——registered / missing（文件不存在）/ failed（写入失败）；failed 不参与软门禁判定，记 log + 评论「登记失败（原因），流程继续/稍后自动补登」或按既有 recordArtifact 失败语义处理（log + 继续，不阻断流转）；并补「hub POST 返回 5xx 时不误停」用例。

### 3.2 建议优化（O）

**O1【中】内容读取先整文件入内存再截断/判二进制，无大小上限保护**
- 位置：team-hub/server.mjs artifactContent 1804-1815（readFileSync(target.abs) 全量读后才 truncate/previewable 判定）；scrum/serve.mjs 528-529（meta 分支整读取 size）；board-plugin/src/index.ts serveArtifact raw 分支 readFileP 全量。
- 问题：512KB 截断承诺仅在整文件读入后才生效；若登记文件达数百 MB/GB（仓库内大文件、误登记二进制），每次预览整读 → 内存峰值 = hub 进程 OOM 风险（hub 同时承载任务池状态与 SSE）。触发面窄（需 token 持有者登记大文件）故不升 M。
- 建议：先 stat 取 size：超限文件只读头部若干字节判定 NUL/UTF-8 并截断返回；meta size 用 stat.size 而非读全文件。

**O2【低】三端 i 参数非法语义不一致**
- 位置：team-hub/server.mjs 1793-1794（非法 i → 静默取最新）vs scrum/serve.mjs 508 与 board-plugin（非法 i → 400）。
- 建议：统一为 400 或统一取最新并注释约定；至少 hub 侧注释/前端约定写明。

**O3【中】MarkdownDocView 围栏：闭合判定粗糙 + 未闭合围栏吞掉其后全部内容**
- 位置：workbench/src/components/MarkdownDocView.tsx 149（行 trim 后 startsWith(opener[0]) 即视为闭合）、154（if (!closed) break）。
- 问题：1) 行首出现单个反引号/波浪号即提前闭合围栏（例：围栏内代码行首是反引号开头的 inline code，或 ~~~ 围栏内行首为 ~ 的代码行）；2) 未闭合围栏 break 跳出主循环 → **围栏之后整篇文档内容被静默丢弃**，与组件「不支持语法按文本回退、不吞内容」的 K6-A 子集承诺相悖（常见「漏写闭合围栏」的作者错误场景下预览会丢半篇）。
- 建议：闭合判定按 CommonMark 近似——行首 0-3 空格后连续同字符且数量不少于 opener（并允许行尾空格），不足 opener 长度的反引号行不算闭合；未闭合时把缓冲行按代码块显示而非 break 丢内容。

**O4【低】copyDocPath 在非安全上下文抛 TypeError 无提示**
- 位置：workbench/src/components/TaskDetailModal.tsx 292-293（navigator.clipboard?.writeText(p).then(...) —— 可选链只作用于 writeText，clipboard 为 undefined 时对 undefined 取 .then 抛错，无 toast）。
- 建议：整体可选链 + fallback（提示「当前环境不支持剪贴板」）。

**O5【低】docOpen/docState 缓存不随 taskId/任务刷新重置**
- 位置：workbench/src/components/TaskDetailModal.tsx 150-152（状态）、154-188（load 不重置）、294-305（命中缓存 status 为 ok 直接打开不重拉）。
- 问题：当前登记 append-only（同 index 内容不变、跨任务切换受 modal-mask 遮挡实际触发面窄），故仅潜在隐患；若未来 artifacts 语义变为替换/重排，缓存会显示陈旧或错任务内容。
- 建议：useEffect 在 taskId 变化时重置 docOpen/docState；load 成功后对已缓存条目比对 digest 变化决定失效。

**O6【低】board-plugin 相对路径分支态候选缺 realpath 复检（与 hub S3 不一致）**
- 位置：board-plugin/src/index.ts resolveArtifactFile（branch 候选 existsSync 即返回）；对比 team-hub/server.mjs 1764-1766。
- 问题：仓库内符号链接指向白名单外文件时，hub 会 403 而 board-plugin 会放行读取。登记面受 token 约束故不升 M。
- 建议：与 S3 对齐——命中候选后 realpath 复检须落在白名单根内。

**O7【低】roles.json 契约路径与既有 artifact 单值语义并存易生歧义**
- 位置：roles.json requirement/researcher 同时保留 artifact 与 docs（同路径重复声明）；registerContractDocs 只用 docs，gate 校验（plugins:1637）只用 artifact。
- 建议：注释说明 artifact 为 gate 校验保留字段、docs 为登记权威，避免后续维护者只改其一导致 gate 与登记路径分叉。

**O8【低】测试盲区与自动化缺口**
- 无 docDir 目标的 S2 登记夹具（M1 相关）；无 hub POST 失败路径用例（M2 相关）；TaskDetailModal「产出文档」区无组件级自动化（S5 验收只有 typecheck + 代码走查）；board-plugin serveArtifact 无自动化测试（仅 typecheck/build 证据，S7 机器行「宿主可用时」项沙箱内不可达已如实登记）。
- 建议：后续批（T-109 测试执行及后续任务）按上述补齐；board-plugin 可仿 scrum/artifact-detail.test.mjs 的 import+listen 范式建同款测试。

---

## 4. 结论与收尾

- **无 P0**。实现与数据面（S1 契约解析、S3 内容端点、S4 渲染安全、S6/S7 逐条化）主体正确，测试扎实：本轮独立复跑 hub 16/16、scrum 10/10 全绿，plugins/workbench 套件与三包 typecheck 因本 worktree 缺 node_modules/lib 无法复跑（与 coder 证据环境差异，宿主可依 §0 表补跑）。
- **2 项必须修改**：M1（S2 契约登记不感知目标级 docsDir → docDir 目标误停，需将军确认是否运营此类目标并修复/补夹具）、M2（登记写入失败误并入 missing → 错误停闸归因）。
- **8 项建议优化**（O1..O8），不影响主线合入，可排期处理。
- 本审查只产出意见（docs/review/T-108-REVIEW.md），未改动任何实现代码。
