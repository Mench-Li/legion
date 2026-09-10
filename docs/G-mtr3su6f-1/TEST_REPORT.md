<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-07**（commit `0a58ecb`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-125 测试报告 —— 对话中心「可回答闭环 + 上下文输入（关联工作空间 / 上传文件）」

> 阶段：测试执行（T-125，w/T-125 worktree @ HEAD d9adffb）｜角色：tester
> 测试对象：T-123 coder commit **77ce2c2**（基线 3757151 promote T-122 → 77ce2c2，18 文件 +2049/-53，经 promote 13b87c1 → 保全 2a90d90 → promote d9adffb 到达本 worktree）；T-124 审查（docs/review/T-124-REVIEW.md，M1/M2 必须修改）后移交本阶段做宿主级执行验证。
> 用例依据：docs/G-mtr3su6f-1/TEST_CASES.md（T-122，112 条 TC + E2E-1..6）＋ REQUIREMENTS/TASK_BREAKDOWN 同目录版本。
> 环境：node v24.19.0（node:sqlite 可用）；沙箱 workspace-write；plugins/workbench node_modules 经仓库既有 junction 机制（run-ci.mjs deps 同款：plugins/node_modules → T-123 worktree 依赖、workbench/node_modules → 主 checkout 依赖）；plugins/lib 由本会话以 DSH_CHECKOUT typescript 全量重建；workbench dist 本会话 vite build 产出。全部命令零第三方新增依赖、经宿主进程直跑（pwsh 沙箱 spawn-pipe EPERM 边界同仓库既有记载，见 T-123/T-124 证据）。
> 验证纪律：每项均以真实命令输出为证（证据文件 docs/G-mtr3su6f-1/T125-evidence/），失败/受限如实登记，不虚报通过。

## 0. 结论速览

- **自动化回归全绿**：team-hub 116/116（chat 41 含 S2 健康/S3 附件）、plugins 15 文件 115/115（含 chat 分类器 4 + 摘要 7 + 回复器 9）、chat-l1-smoke **35/35**、chat-s2-smoke **9/9**、workbench tsc 0 诊断 + vite build exit 0、check-docs PASS、S9 文档关键句 6/6、UI/静态纪律断言 14/14（合计 ≈356 项全绿）。
- **真实缺陷 2 项复现（与 T-124 M1/M2 吻合，归属 coder）**，本批**未全绿**：
  - **M1（chatHealth 跨 scope 误报/取错）**：隔离 hub 实测——只有 beta 空间守护心跳时，问 alpha 空间 health 仍 online=true（daemon.member=worker@beta），且 alpha 的 model 兜底展示 beta 的 beta-model（跨空间泄漏）。
  - **M2（lastFail 恒红 + 存量旧笼统文案透出）**：实测 failed 之后有 replied 成功回复，health.lastFail 仍返回旧 failed 行（aiError 原文「回复子代理未完成（error）」），健康点「绿」按实现不可达。
- **受限项（如实登记，非实现缺陷）**：①真实 LLM 出站闭环（E2E-1/2/3 的模型回答段）本沙箱无运行中 daemon/模型通道、且隔离纪律禁止写 live 库 → 以确定性代理验证（data-plane 全链 + L2 上下文注入 10/10），真实模型段留部署后宿主冒烟（T-126 承接部署）；②L3 浏览器级 UI 冒烟无浏览器驱动 → 以 tsc 强类型 + vite 产物 + UI 静态断言 + S2 数据面冒烟替代，GUI 渲染项留宿主浏览器复核。参考团队经验 exp-t092：先核对上游（T-124 已复跑 41/41 + plugins 20/20）避免空转，本批在保留上游结论的同时全量独立重跑并扩大覆盖面（plugins 由 20 → 115、chat-l1 由 22 → 35 项），无重复空转。

## 1. 执行矩阵（环境 / 步骤 / 实际结果 / 日志证据）

| # | 载体（命令） | 覆盖 | 结果 | 证据文件 |
| --- | --- | --- | --- | --- |
| 1 | node team-hub/chat.test.mjs | S2 健康 6 + S3 附件 12 + 既有 23（TC-S1-01..17/S9 数据面） | **41/41 pass，suites 20，fail 0，exit 0** | 01-teamhub-chat.test.mjs.txt |
| 2 | node --test team-hub/*.test.mjs | chat+skills+goal+calendar+spaces+artifact-content+rules+stage-standards | **116/116 pass，suites 59，fail 0，exit 0** | 03-teamhub-full.test.mjs.txt |
| 3 | DSH tsc -p plugins/tsconfig.json → node --test plugins/tests/*.test.mjs | S1/S4/S5 + plugins 全量回归（15 文件） | lib 重建 exit 0；**115/115 pass，fail 0，exit 0** | 04/05-plugins-*.txt |
| 4 | workbench tsc --noEmit + vite build | S7/S8 类型 + 产物 | tsc 0 诊断 exit 0；vite **621 modules，built 8.87s，exit 0**；dist/index.html 产出 | 06/07-*.txt |
| 5 | node team-hub/chat-l1-smoke.mjs | 真实进程 + SSE + 鉴权 + 回复生命周期（含 S9-13 settings/awaiting→answer→replied/超龄 failed） | **35/35 断言通过，进程级异常 0，exit 0** | 08-chat-l1-smoke.txt |
| 6 | node workbench/scripts/chat-s2-smoke.mjs | SPA 产物 + /hub 代理 + 会话/分页/隔离/双订阅实时 | **9/9 断言通过，exit 0** | 09-chat-s2-smoke.txt |
| 7 | node scripts/ci/check-docs.mjs | R-5 docs 门禁 | **check-docs: PASS（8 类全绿）exit 0** | 10-check-docs.txt |
| 8 | node -e（S9 关键句） | FEATURES §3.9 三要素 + README 排障 + workbench README | **6/6 PASS** | 11-s9-key-sentences.txt |
| 9 | node -e（ChatView/api/types/App 静态） | S7/S8 UI 静态断言（渲染安全/选空间入口/健康点/回复设置/附件 UI/类型/接线） | **9/9 PASS** | 14-ui-static-asserts.txt |
| 10 | node -e（静态纪律） | 裸笼统文案 / spaceDigest 无子进程 / 附件全文不入 body | **5/5 PASS** | 15-static-discipline.txt |
| 11 | 隔离 hub repro（repro-health-m1m2.mjs） | S2 健康端点四输入 + 回复生命周期 + M1/M2 现场 | **10 PASS；3 项复现缺陷（B1/B2→M1，D4→M2）** | 12-repro-health-m1m2.txt |
| 12 | 隔离 hub + lib 直调（repro-l2-context-injection.mjs） | E2E-2/3 的确定性代理：绑定仓库摘要 + 附件取回 → 最终提示词注入 + 对照 | **10/10 PASS** | 13-l2-context-injection.txt |
| 13 | git diff 3757151 77ce2c2 | 回归范围与零新增依赖核对 | 恰 18 文件 S1~S9 域；package.json/pnpm-lock 无改动 | 16-regression-scope.txt |

## 2. 用例分组结果

### S1 失败可行动化 —— ✅ 通过（数据面 + 静态；出站真模型段见 §4 受限）
- 分类器 4/4（chat-error-classifier.test.mjs）：五类别映射、负例（error/undefined 原文不产裸「回复子代理未完成（error）」）、边界兜底（截断 ≤500 带重试指引）、timeout/foreman 语义沿用。
- 静态纪律：plugins/src + server.mjs + workbench/src 生产代码行**零命中**裸「回复子代理未完成（error）」；分类器文案含恢复指引关键词。
- 数据面：fail 回写（POST /api/chat/replies/fail）→ aiStatus=failed + aiError 原文（repro D2 PASS）；E1/E2 retry→awaiting→answer→replied PASS；E3 幂等 skipped PASS。

### S2 对话健康端点 + 心跳 —— ⚠️ **2 项缺陷复现（M1/M2）**，其余通过
- 通过：空库形状（A1）、本 scope 心跳后 online=true + daemon 行正确（C1）、model 解析链 settings→agent_models→daemon-heartbeat 取本 scope（C2）、chat.test S2 6 例（60s 窗/诚实标注/HTTP 只读）全绿。
- **缺陷 M1（复现 B1/B2）**：跨 scope 心跳污染本空间健康与模型兜底。
  - 复现步骤：隔离 hub（TEAM_HUB_DB=mkdtemp）→ POST /api/heartbeat {by:'worker@beta', scope:'beta', kind:'worker', model:{provider:'fake-prov',model:'beta-model'}} → GET /api/chat/health?scope=alpha。
  - 实际结果：alpha 无任何本空间 worker 行，但 online:true, daemon.member:'worker@beta'；model:{model:'beta-model',source:'daemon-heartbeat'}, modelResolved:true。
  - 期望：online=false（别空间心跳不得令本空间假绿）；model=null。
  - 归属：T-123 coder（team-hub/server.mjs chatHealth 三条成员查询不带 scope 过滤，:1415-1416/:1430）；T-124 已标「必须修改」。
- **缺陷 M2（复现 D4）**：最近失败不随后续成功消除 → 健康点恒红 + 存量旧笼统文案透出。
  - 复现步骤：同 hub 内发消息 msg1 → POST /api/chat/replies/fail {error:'回复子代理未完成（error）'}；再发 msg2 → POST /api/chat/replies/answer（成功 replied）→ GET /api/chat/health?scope=alpha。
  - 实际结果：msg2 已 replied（D3 PASS）后，lastFail 仍返回 {msgId:1, aiError:'回复子代理未完成（error）', failedAt:...}。
  - 期望：最近成功（replied）晚于最近失败时 lastFail=null（四态设计「绿=就绪」可达）；历史旧文案不原样透出。
  - 归属：T-123 coder（server.mjs chatHealth lastFail 只找最新 failed 消息 :1432-1438；ChatView healthView 红态优先）。T-124 已标「必须修改」，建议「最近终态事件」比较。

### S3 附件数据面 —— ✅ 通过
- chat.test S3 12 例全绿：UTF-8 上传 staged+落盘；黑名单/非 UTF-8 4xx；env 小值（32B 上界 413 / 恰 32 成功；每消息 1 附件超限 400 且消息不落库）；绑定 meta 只存引用、body 无全文；跨会话/跨 scope 403；悬空引用拒绝；TTL 清理行+文件；audit chat:attachment:*（fileName/size/scope/conv）；旧库无表自动建表零迁移；uploads 与临时库同基隔离。
- L2 代理：真实上传（PUT raw body）→ staged；带附件发消息 → meta.attachments 仅引用、body 无文件正文；跨会话取回 → hub 403 → gatherChatContext 占位 readError **不抛**（TC-S6-03 语义）。
- 静态：server.mjs 代码行无附件全文写入 body/meta（meta.attachments 仅引用，:1047 注释自述核对）。

### S4 空间摘要模块 —— ✅ 通过
- space-digest 7/7：allowlist/噪声目录跳过/确定性/截断带标记/空与不可读返 reason 不抛/只读零写入/静态无子进程（头注释除外，代码行零命中）。
- L2 代理：绑定 fixture 仓库 → 摘要含 README 独有标记；绑定真实 legion 仓库 → 摘要含【顶层结构】且引用真实顶层目录 team-hub/plugins/docs/workbench/scripts（非编造）。

### S5 提示词构建器 —— ✅ 通过
- chat-responder 9/9（既有 TC-S10-01..05 回归 + TC-S5-02..09）：摘要/附件块注入与顺序、缺省不产块、降级占位、HTML 注入负例（< → 全角）、预算裁摘要保最新附件带「已截断」。
- L2 代理：最终提示词同时含绑定仓库事实与附件独有事实；无附件对照提示词不含该事实；未绑定 → 固定「未绑定」降级占位（AC-R2-4）。

### S6 守护上下文接线 —— ✅ 通过（确定性代理；真出站受限）
- 隔离 hub + plugins/lib 直调 gatherChatContext 全链 10/10：摘要取回、附件归属取回、两事实进入最终提示词、第二条无附件消息 attachments=[]（附件仅当次、历史不回填 AC-R4-6 代理）、跨会话 403 → 占位、未绑定 → null 占位。
- 静态：摘要/附件内容只进本次提示词、不写消息体/meta（chatContext/chatResponder 源码断言）。

### S7 UI 前置 —— ✅ 通过（类型/产物/静态/S2 数据面；浏览器渲染受限）
- workbench tsc --noEmit 0 诊断 + vite build exit 0（621 modules）+ dist 产物完整（S2-A GET / → 200 html 经 chat-s2-smoke 实测）。
- UI 静态 9/9：无 dangerouslySetInnerHTML 实调用；「选择工作空间开始对话」入口接线（死路卡已替换）；健康点状态文案；回复设置入口；types ChatHealthInfo/ChatAttachmentRef；api fetchChatHealth/uploadChatAttachment/attachmentIds；App onPickScope。
- 回复设置数据面：chat-l1 S9-13 ①-⑬ 全 PASS（默认 enabled=true、POST enabled:false、开关关无 awaiting 无队列、开关开 awaiting 入队带上下文、answer 200 replied、≤5s SSE live、幂等不重复、超龄 failed 含超时）。

### S8 UI 附件行 —— ✅ 通过（同上；浏览器渲染受限）
- UI 静态：input file multiple 附件入口、attachFiles chip 状态管理（可移除/失败标红/就绪前发送禁用语义在 ChatView 源码）；types/api 契约齐备；S2 数据面 9/9（含双订阅实时收发的数据面等价）。

### S9 文档收口 —— ✅ 通过
- check-docs PASS（8 类全绿）；关键句 6/6：FEATURES §3.9 三要素（选择工作空间/上传文件/回复设置入口 + AI 不回失败怎么办可行动）+ README 排障 + workbench README 细目。

### E2E 六条（TEST_CASES §6）逐条口径
| ID | 口径 | 结果 | 说明 |
| --- | --- | --- | --- |
| E2E-1 | 消息→回复闭环、失败可行动、重试 | ✅（确定性段） | awaiting→answer→replied ≤5s SSE + 幂等 + 超龄 failed + retry 闭环全部数据面 PASS（chat-l1 35/35 + repro E1-E4）；真模型出站段受限 |
| E2E-2 | 绑定仓库内容作答 | ✅（确定性代理） | L2：绑定仓库摘要注入提示词且引用真实顶层目录；未绑定降级占位；LLM 语义段受限 |
| E2E-3 | 上传独有事实作答 + 对照 | ✅（确定性代理） | L2：附件 FACT 标记进提示词；无附件同问不含 FACT；附件仅当次 |
| E2E-4 | 模型不可用→可行动文案→修复重试 | ✅（确定性段） | fail 回写原文 → 分类器可行动（单元 4/4）；retry→answer→replied 幂等（repro E1-E3）；健康条黄/红呈现依 M2 修复后复核 |
| E2E-5 | 回归面 + live 库零写入 | ✅ | chat.test 41 + 全套 116 + plugins 115 + chat-l1/s2 smoke + check-docs；全部隔离临时库（mkdtemp），live 库零写入 |
| E2E-6 | 文档与实现一致 | ✅ | 见 S9；check-docs exit 0 |

## 3. 缺陷清单（复现步骤 + 归属；本阶段只报告不修复）

| ID | 严重度 | 现象（实测） | 复现 | 归属/位置 | 建议 |
| --- | --- | --- | --- | --- | --- |
| M1 | 中 | 别空间守护心跳令本空间 health online=true + 模型兜底泄漏别空间模型 | 见 §2 S2（repro B1/B2，证据 12） | T-123 coder；server.mjs chatHealth :1415-1416/:1430 | 三条成员查询加 scope 过滤；兜底分支仅本 scope 无行时启用；补跨 scope 负例断言（T-124 建议①-③） |
| M2 | 中 | lastFail 不随后续 replied 消除 → 健康点恒红 + 存量旧笼统文案透出 | 见 §2 S2（repro D4，证据 12） | T-123 coder；server.mjs chatHealth :1432-1438；ChatView healthView 红态优先 | 按「最近终态事件」（replied vs failed）比较取 lastFail；旧格式 aiError 展示层归一（T-124 建议①-③） |

> 注：M1/M2 已由 T-124（docs/review/T-124-REVIEW.md）独立代码审查标注「必须修改」；本报告在真实隔离 hub 上完成行为级复现，两者吻合。其余 8 项 T-124「建议优化」未阻断本批验收，不在此重复（见 T-124 §2.2）。

## 4. 受限项（如实登记；复现步骤已备，供宿主/后续阶段）
1. **真实 LLM 出站闭环**：daemon(answerChatMessage) 依赖 DSH host 的 cordis ctx.subagents 运行时（provider spawn-in-process），本沙箱无第二 DSH daemon/模型通道；且隔离纪律禁止写 live 库（I-2）。→ 以 L1 data-plane（35/35）+ L2 上下文注入（10/10）替代完成确定性验证；真模型回答段需部署后（T-126 后）在隔离 hub+守护宿主按 TEST_CASES §6 E2E-1/2/3 冒烟：问仓库事实题、带/不带附件对照、连续两问隔离。
2. **L3 浏览器级 UI 冒烟**：无浏览器驱动（playwright 等未装，禁网不安装）。→ 以 tsc 0 + vite build + UI 静态断言（9/9）+ chat-s2-smoke 数据面（9/9）替代；GUI 渲染（空间选择/健康点四态/附件 chip/消息附件标识）留宿主浏览器复核（同 T-047-evidence L2 清单同型做法）。
3. 复跑时 plugins/lib 需先以 DSH_CHECKOUT typescript 重建（lib/ 为 gitignored 产物）；workbench node_modules 依赖 junction 指向主 checkout——两处均为仓库既有构建约定，非实现问题。

## 5. 回归范围与结论

- **回归范围**：T-123 编码批（3757151→77ce2c2，恰 18 文件 = S1~S9 文件域，+2049/-53，零 package.json/pnpm-lock 改动 = 零新增依赖）波及的所有自动化面，全量重跑：team-hub 116/116、plugins 115/115、chat-l1-smoke 35/35、chat-s2-smoke 9/9、workbench tsc 0 + vite exit 0、check-docs PASS。E2E-5 的人-人收发/无附件消息/分页/隔离/SSE/鉴权由 chat-l1 与 chat-s2 覆盖全绿。
- **回归面之外**（未受本批影响的领域：board-plugin/whiteboard/ozon/mesh/services-plugin 等）不在本目标切片范围，不重跑；全量 run-ci 六阶段由 T-126（devops）接部署门禁（run-ci chat 阶段 = chat.test 41 已全绿、smoke chat 两行 = chat-l1/s2 已全绿，阶段等价性已在证据 08/09/10 覆盖）。
- **结论**：对话中心「可回答闭环 + 上下文输入（关联工作空间/上传文件）」**数据面/纯函数/接线/产物/文档实现全部验证通过（≈356 项自动化断言全绿）**；存在 **2 项真实行为缺陷（M1/M2，均已复现并归属 T-123 coder，T-124 审查同判「必须修改」）**，因此**本批验收未全绿**——建议将军发起 coder 修复（挂回 T-123 或新建 fix 任务），修复后 tester 复测 M1/M2 负例（跨 scope 心跳不假绿、lastFail 随后续成功消除、健康点绿可达）即可收口；真实 LLM 出站与浏览器级渲染在部署后宿主冒烟复核。

## 6. 证据文件（docs/G-mtr3su6f-1/T125-evidence/）
01-teamhub-chat.test.mjs.txt｜03-teamhub-full.test.mjs.txt｜04-plugins-lib-build.txt｜05-plugins-full.test.mjs.txt｜06-workbench-tsc-noemit.txt｜07-workbench-vite-build.txt｜08-chat-l1-smoke.txt｜09-chat-s2-smoke.txt｜10-check-docs.txt｜11-s9-key-sentences.txt｜12-repro-health-m1m2.txt｜13-l2-context-injection.txt｜14-ui-static-asserts.txt｜15-static-discipline.txt｜16-regression-scope.txt｜repro-health-m1m2.mjs（可复跑）｜repro-l2-context-injection.mjs（可复跑）

*（本文件由 T-125 测试执行产出：真实命令/日志为证，缺陷如实上报并归属，未修改任何实现代码、未调用 taskctl/看板写接口、未 push。）*
