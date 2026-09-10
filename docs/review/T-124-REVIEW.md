# T-124 代码审查报告（review）——对话中心「可回答闭环 + 上下文输入（关联工作空间 / 上传文件）」

> 审查对象（本任务 = 对 T-123 编码 diff 的独立代码审查）：
> - coder 提交 **77ce2c2**（分支 w/T-123，18 文件 +2049/-53，基线 = promote T-122 3757151），经 mediator promote **13b87c1** 与保全提交 **2a90d90** 到达当前 HEAD；
> - 审查基线 AC = docs/G-mtr3su6f-1/ 需求链：REQUIREMENTS.md（R-1~R-5 + AC-Rx-y + D-1~D-8 默认值）、TASK_BREAKDOWN.md（S1~S9 机器验收行）、TEST_CASES.md（112 用例 TC-Sx-yy）；
> - 审查方式：18 个改动文件逐一正读（team-hub/server.mjs chat DAO/路由/健康/附件全段、plugins 新增 3 模块全文 + chatResponder/index.ts 接线、workbench ChatView/api/types/App 全文与接线、三份文档），独立复跑测试 + 静态纪律核对（无裸兜底文案 / 无 dangerouslySetInnerHTML / 无子进程 / 附件内容不入 body）。**只给反馈，未改任何实现代码。**
> - 结论分级：**必须修改**（行为缺陷 / 跨空间语义失真 / 契约违例）与**建议优化**（可排期）；严重度 高=红 / 中=橙 / 低=黄。

---

## 0. 验证证据（本审查独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 环境 | node v24.19.0；沙箱 workspace-write；worktree w/T-124 @ HEAD 2a90d90；基线 diff 3757151..77ce2c2 | 与 coder 自述同构（plugins/workbench node_modules 本 worktree 不存在，见受限项登记） |
| team-hub chat 套件（独立复跑） | node team-hub/chat.test.mjs | **41/41 pass（suites 20）fail 0 exit 0**（既有 23 + S2 健康 6 + S3 附件 12，与 coder 证据一致） |
| plugins 新增 3 套件（独立复跑） | node plugins/tests/chat-error-classifier.test.mjs / space-digest.test.mjs / chat-responder.test.mjs | **4/4 + 7/7 + 9/9 = 20/20 fail 0，均 exit 0**（依赖 coder 已编译的 plugins/lib 产物，时间戳 14:00 与提交同批） |
| docs 门禁（独立复跑） | node scripts/ci/check-docs.mjs | **check-docs: PASS**（8 类校验项全绿，exit 0） |
| plugins/workbench typecheck & vite build | node DSH_CHECKOUT node_modules typescript tsc -p plugins/tsconfig.json | **未复跑成功**：TS2688（缺 @types/node）——build.sh 需先建立 plugins/node_modules junction（沙箱受限）；coder 证据记录 plugins tsc 0 + workbench tsc 0 + vite exit 0，本审查以代码正读 + 类型约束核对替代，见受限项 |
| 静态纪律核对 | grep 生产路径裸「回复子代理未完成（」/ dangerouslySetInnerHTML / child_process | 源码零命中（仅测试负例与注释引用），与 coder §1.6 一致 |
| 改动范围 | git diff 3757151..HEAD --stat（排除 .skills-cache 与历史保全噪音） | 恰为 S1~S9 文件域 18 文件；零新增依赖；docs/goals/G-mtr3su6f-1.md 的 M 为守护镜像非任务改动 |

### 受限项（如实登记，供 T-125/T-126 宿主执行）
- plugins/node_modules 与 workbench/node_modules 在全新 worktree 中不存在 → typecheck/build 需先经 build.sh junction / run-ci deps 兜底（沙箱无法建立 junction，故未复跑，非实现问题）。
- node --test 多文件 runner 在本沙箱 spawn EPERM（仓库既有边界，run-ci.mjs 头部同载）→ plugins 套件以单文件直跑方式完成（20/20）。
- 真实出站 L1（守护+模型发送→replied；空间事实题引用真实仓库内容；附件事实题对照）与浏览器级 L2 冒烟本沙箱无 daemon/模型通道，**T-123 证据 §3 已如实移交 T-125** —— 见 §3。

---

## 1. 验收口径逐条核对（结论均有代码/测试依据）

| # | 口径（REQUIREMENTS / TASK_BREAKDOWN / TEST_CASES） | 结论 | 依据 |
| --- | --- | --- | --- |
| S1 / AC-R1-3（失败可行动化） | ✅ 通过（语义注记 → M2/S1） | chatErrorClassifier.ts 五类别 + 每类含恢复指引 + ≤500 契约 + error/undefined 负例兜底；index.ts 两处失败路径（非 completed、catch 吞错）与 foreman-down 分支均改经分类器回写。独立复跑 4/4。静态：生产路径无裸「回复子代理未完成（」 |
| S2 / AC-R1-3 后端（health/心跳/daemon 状态） | ⚠️ **M1/M2（必须修改，见 §2）** | chatHealth 聚合四输入 + 诚实标注 + 只读零写入（TC-S2-07 断言 audit/表零变化）；60s 窗判定与 GET /api/members 口径一致；members.model 迁移幂等；hubHeartbeat 每轮上报 + daemon.json chat 字段随 writeDaemonStatus 写出。**缺陷**：在线判定/daemon 模型回退全局取行忽略 scope；lastFail 不随后续成功消除 → 健康点恒红（详见 M1/M2） |
| S3 / AC-R3-1/3/5、AC-R4-2/3/4/6 后端（附件数据面） | ✅ 通过（注记 → S3/S5） | chat_attachments 建表幂等零迁移 + uploads 与库同基；PUT 上传（Content-Length 预检/黑名单/非法 UTF-8/大小上限/sha1 原子落盘）+ GET content（会话归属校验 403/404 语义 + realpath 防逃逸）+ postMessage 事务内 validate/绑定（悬空/跨 scope/重复绑定拒绝且零落库，TC-S3-10）+ 孤儿 24h/sent 7 天 TTL + audit chat:attachment:*。body/meta 仅存引用（TC-S3-07/15 断言）；独立复跑 S3 12 例全绿。**注记**：同名 sha1 去重文件被 TTL 删除可能留下他行悬空（S3 建议） |
| S4 / AC-R2-3、AC-R4-1 摘要侧（spaceDigest） | ✅ 通过（注记 → S4） | 纯只读 fs、allowlist+结构块确定性顺序、噪声目录跳过、UTF-8 fatal 跳过、预算/单文件截断带标记、空/不可读返 reason 不抛、无 child_process。独立复跑 7/7。**注记**：摘要子预算 env 语义与总预算 env 混用（S4 建议） |
| S5 / AC-R2-3/4、AC-R3-2、AC-R4-1/5/6（提示词扩展） | ✅ 通过 | buildChatAnswerPrompt 摘要/附件独立块 + 缺省不产块（兼容 TC-S10）+ null/空降级占位恒保留 + 预算分配（先裁摘要、自旧丢附件、保最新附件）+ sanitizeText 全注入面（TC-S5-09 实测 < 变全角）+ 输出仍纯文本。独立复跑 9/9 |
| S6 / AC-R2-4、AC-R3-2、AC-R4-3/5/6（守护接线） | ✅ 通过（静态+纯函数；L1 交 T-125） | chatContext.ts 取绑定仓库（buildSpaceDigest）+ 逐个 GET content（归属校验）→ 进 buildChatAnswerPrompt；任一步失败仅降级不标 failed（try/catch 全包）；附件仅当次、历史附件不回填（只读 msg.meta.attachments）；摘要/附件不进任何消息体/meta（源码静态断言）。**注记**：chatContext 无直接单测文件（S7 建议）；真出站注入有效性留 T-125 |
| S7 / AC-R1-5/6、AC-R2-1/2（UI 前置） | ✅ 通过（代码/静态；L2 待勾选；注记 → S6） | !scope 死路卡 →「选择工作空间开始对话」空间列表（spaces prop + fetchSpaces 兜底；onPickScope → App.selectScope 已接线）；头部健康点四态（灰/绿/黄/红 + 15s 轮询 + 发送/重试/设置后即时刷）；⚙ 回复设置弹窗（enabled 必含默认开 + model/identity/systemHint 可选，接线既有 fetch/saveChatReplySettings）；toast 透传后端文案；无 dangerouslySetInnerHTML |
| S8 / AC-R3-1/3/4、AC-R3-6（UI 附件行） | ✅ 通过（注记 → S2/S6） | 📎 隐藏 file multiple → 客户端预检（黑名单/10MB/3 个）→ PUT staged → postMessage attachmentIds；chip 行可移除/失败标红；发送按钮在附件未就绪时禁用；消息旁渲染 meta.attachments（纯文本）；发送成功清槽、失败保留 + toast；types.ts ChatAttachmentRef/ChatHealthInfo |
| S9 / AC-R5-1/2/3（文档收口） | ✅ 通过 | FEATURES §3.9 重写（入口/上下文两种方式/预算护栏/失败可行动与运行前提/回复设置入口）、§5.1 排障表加「AI 不回/回复失败」行；README §3.9 + §6 同步；workbench/README 细目同步；check-docs PASS（本审查复跑）；三要素关键句断言 coder §1.5 记录 |
| 波次验收 1 | 对照验收标准与编码规范逐条审查，每条结论有依据 | ✅ 本报告 §1/§2（skill：边界/错误处理、命名、测试覆盖均已检查） |
| 波次验收 2 | 问题清单含 严重度 + 位置 + 修改建议 | ✅ §2 |
| 波次验收 3 | 明确区分「必须修改」与「建议优化」 | ✅ §2.1 / §2.2 |

**总体结论：数据面/纯函数/UI 接线实现扎实、边界处理慷慨（降级不抛/预算截断/归属校验/防注入/审计齐备），独立复跑 chat 41/41 + plugins 20/20 + check-docs PASS 全绿。无 P0 级安全/数据完整性问题。存在 2 项必须修改（M1 chatHealth 跨 scope 语义、M2 健康点「恒红/旧笼统文案残留」语义）与 8 项建议优化；真实出站 L1 与浏览器 L2 已由 coder 如实移交 T-125，验收 R-1/R-2/R-3 的端到端口径依赖该宿主验证闭环（§3）。**

---

## 2. 问题清单

### 2.1 必须修改

**M1｜中｜chatHealth 在线判定与守护模型回退忽略 scope（跨空间误报/取错）**
- 位置：team-hub/server.mjs chatHealth()（workerRow/anyFreshRow 查询 :1415-1416、online 组合 :1418、daemon 模型 JSON :1422、返回 daemon 引用 :1444）；受牵连：team-hub/chat.test.mjs S2 用例（setMember 均以 scope=default 造行后断言任意 scope 的 health）。
- 问题：chatHealth(rawScope) 已校验并接收 scope，但三条成员查询均**不带 scope 过滤**——取的是**全局最新** worker 心跳。hub 支持多 scope 共享（/api/spaces 多空间、/api/goal per-scope、守护心跳带 scope），一旦两个以上工作空间各自 daemon 上报：A 空间守护已停但 B 空间心跳新鲜 → A 的 health 仍绿（假绿，违背「预防性提示/诚实标注」初衷）；A 空间无模型配置时还会把 B 空间守护心跳上报的 model 当作 A 的 daemon-heartbeat 兜底展示（跨空间模型名泄漏）。现测试把「default 行让 health-* 在线」固化为期望，正好反向锚定了该缺陷。
- 建议：①workerRow 与 anyFreshRow 查询加 scope 过滤（兜底分支仅在**本 scope** 无 worker 行时启用），daemon/model 字段只取本 scope 行；②补跨 scope 负例断言：别空间新鲜 worker 心跳不得令本 scope online=true、不得成为本 scope model 兜底；③同步修订 TC-S2-01/02/07 与 HTTP 用例的成员造数（scope 与本空间一致），维持「无行 false / 过期 false」语义不变。

**M2｜中｜chatHealth.lastFail 不随后续成功回复消除 + 存量旧笼统文案残留 → 健康点可能永久红**
- 位置：team-hub/server.mjs chatHealth()（lastFail 扫描 :1432-1438，只找最新一条 failed 消息）；workbench ChatView.tsx healthView()（:396-399 红态分支在 lastFail 存在时优先于绿/黄返回）。
- 问题：lastFail = id 最大的 failed 消息，只要存在一条从未重试成功的 failed 消息，即使其后已有 replied 成功、守护在线、开关开、模型已解析，健康点仍恒红。现场即会触发：live 库 software 会话 msg2（2026-09-07 failed，aiError「回复子代理未完成（error）」）是**历史失败**，本部署后 health 对 software 长期红、且把 S1 声称已消除的**旧笼统文案**原样透出（FEATURES §3.9「不再出现笼统…文案」只对新失败成立）。红态永久化使「绿=就绪」实际不可达，与四态设计的可行动语义冲突。
- 建议：①lastFail 改按「最近一次 AI 终态事件」取——比较最近 replied（meta.repliedAt / reply 消息时间）与最近 failed（meta.failedAt）：仅当失败晚于最近成功（或无任何成功）时才透出红 + 文案，否则绿/黄照常（❌ 气泡仍保留消息级失败可重试，不丢信息）；②对存量旧格式 aiError（前缀「回复子代理未完成（」等）在展示层映射为可行动文案（不改消息状态、不回填，符合 D-5「不自动轰炸」），或 chatHealth 输出前归一化一次；③补用例：failed 之后有 replied → lastFail=null/绿；历史旧文案 → 展示为分类文案。此条与建议 S1（2.2）二选一落地即可，但**必须**让「绿」可达成，否则健康条在真实部署中永远误导。

### 2.2 建议优化

**S1｜中｜旧失败文案存量归一化（承接 M2 建议②的另一种落法）**
- 位置：live 库 messages.meta.aiError 存量（software msg2）+ chatHealth/ChatView 展示链。
- 说明：S1 仅清除生产代码路径的笼统文案，存量 failed 行（升级前产生）会继续在 ❌ 气泡与健康红态透出旧语。建议与 M2 一并由 coder 提供一次性只读归一（查询期映射或极小迁移把旧前缀文本映射为 empty-other 可行动文案，不动 aiStatus/failedAt），保证 AC-R1-3「不再出现裸 error/undefined 样式文案」对 UI 全链路成立。

**S2｜低｜上传「无扩展名」文件：客户端拒绝与服务端允许不一致**
- 位置：workbench ChatView.tsx precheckFile()（:451 无扩展名直接拒绝）；team-hub/server.mjs rejectBlacklistedExt()（无扩展名视为非黑名单放行）+ requireUtf8Text。
- 说明：服务端护栏 = 「非黑名单 + UTF-8 fatal」，本可接受无扩展名纯文本（LICENSE/CHANGELOG 等）；客户端却把「无扩展名」当错误拦截，与服务端口径矛盾且文案不准确。建议：删除客户端该分支（UTF-8 校验交给服务端 fatal + 可读 toast），或服务端同步拒绝并统一文案——取前者更符合「仅文本类 UTF-8」的护栏语义。

**S3｜低｜附件 TTL 清理按行删文件，同 sha1 内容多行时会悬空**
- 位置：team-hub/server.mjs cleanupChatAttachments()（:1387-1391：行遍历中对每行 rmSync 文件再删行）。
- 说明：uploads/<scope>/<sha1> 按内容去重落盘；同一内容被上传两次（两行同 path，先后绑定）时，先过期行的清理会把文件删除，后行仍引用该 path → 后续 content 读取报「附件文件不存在」（占位降级，不崩但丢内容）。建议：删除文件前先查同 path 剩余行数，>0 则跳过 rmSync（行照删），或把文件删除挪到「无任何行引用该 path」时。

**S4｜低-中｜CHAT_CTX_BUDGET_CHARS 单变量双语义双默认值，chatContext 还绕过 env** —— ✅ **已于 P3-4（2026-09-10）修复**
- 位置：plugins/src/chatContext.ts:69（digestBudget ?? 4000 硬编码）；plugins/src/spaceDigest.ts:32（defaultDigestBudget 读 CHAT_CTX_BUDGET_CHARS 默认 4000 = 摘要子预算）；plugins/src/chatResponder.ts:70（同一 env 读作总预算默认 8000）；头注释 spaceDigest.ts:9 / chatResponder.ts:11-12 与 docs/FEATURES.md:141。
- 说明：同一 env 名在 spaceDigest（默认 4000）、chatResponder（默认 8000）语义不同；正式链路里 chatContext 传字面 4000，完全不理会 env，与 TEST_CASES 假设 A-1「护栏常量同名 env 覆写」及 FEATURES「合计 ≤8000 可覆写」的契约表述存在漂移（默认值下行为正确，env 覆写时才分叉：调大总预算时摘要子预算仍锁 4000）。建议：摘要子预算与总预算拆分不同 env（如 CHAT_CTX_DIGEST_BUDGET_CHARS），chatContext 改调 spaceDigest 的 defaultDigestBudget()，统一头注释与文档口径。
- **修复（按本建议逐条落地）**：摘要子预算拆为独立变量 `CHAT_CTX_DIGEST_BUDGET_CHARS`（默认 4000），总预算仍为
  `CHAT_CTX_BUDGET_CHARS`（8000）；`chatContext` 不再硬编码，改为读统一配置引擎；三处头注释与
  README §9.2 / FEATURES 口径同步；插件族纳入 `scan --check` 与 `check.mjs`。
  回归：`plugins/tests/config.test.mjs`（默认值漂移 + env 覆盖 + 摘要长度实测）与
  `scripts/config/config.test.mjs`（schema/规则/跨进程）。证据：`docs/P3-4-evidence/verify-evidence.md`。

**S5｜低｜附件内容先全量取回、后截断（10MB 上限下每附件全量过 JSON）**
- 位置：team-hub/server.mjs readChatAttachmentContent()（readFileSync 全量 :1373）→ chatContext.ts fetch 全量 JSON → chatResponder.ts fitContextBudget 才截到 fileCap(4000)。
- 说明：答复仅用 ≤4000 字符/附件，却把最多 10MB 全文在守护与 hub 间搬运并 parse。建议：content 取回端点支持 cap 参数（或 chatContext 按上限截断响应后再入提示词），省内存/IO；DB 行内附件仅引用，不受影响。

**S6｜中｜附件槽/草稿在空间切换与「发送成功但视图 stale」时不复位**
- 位置：workbench ChatView.tsx（scope 切换 effect 只清会话/消息状态，不清 attachFiles；send() 成功路径的 stale return 先于 setAttachFiles([])）。
- 说明：①scope A 下选好附件（staged in A）→ 切到 B：chip 残留，发送报「附件不属于该空间」400，需手动移除；②发送期间切走（消息已随附件入库）→ stale return，chip 保留的 id 已被绑定，回头再发报「已被绑定，不能重复使用」，草稿也保留 → 体验困惑（不会产生重复消息，因绑定失败整个消息事务回滚）。建议：scope 切换 effect 中一并清空附件槽（staged 孤儿由 24h TTL 清理）；send 成功路径在消息已 post 成功时无条件清附件槽（即使视图 stale）。

**S7｜低｜chatContext.ts 无直接单测（头注释宣称可单测但无对应测试文件）**
- 位置：plugins/tests/ 目录（仅 classifier/space-digest/chat-responder 三个新文件；无 chat-context.test.mjs）。
- 说明：gatherChatContext 的「hub 不可达/404/空内容 → 占位不 throw」「bindingDir null → null」「异常只降级」等 TC-S6-03/04/09 语义目前只能靠代码正读，无 fetch mock 单测钉住。建议：补一个 node:test + 全局 fetch stub 的用例文件（覆盖 refs 空/hub 错误/非法 id 过滤）。

**S8｜低｜chatHealth 最近失败扫描窗口 LIMIT 200**
- 位置：team-hub/server.mjs chatHealth()（:1433 ORDER BY id DESC LIMIT 200）。
- 说明：高频消息空间若最近 200 条内无 failed 但更早存在失败，则红态不显示（与 M2 相反方向的截断偏差）；结合 M2 改为「最近终态事件」比较时建议用 meta 时间而非扫描窗口，或把查询改为 WHERE aiStatus=failed ORDER BY id DESC LIMIT 1 + 最近 replied 时间，避免全表拖尾扫描。

---

## 3. 交付边界与宿主验证（供将军/后续阶段）

- ✅ 本审查已独立复跑：chat.test.mjs 41/41、plugins 新增 20/20、check-docs PASS；对 coder 证据（plugins 70/70、team-hub 116/116、workbench tsc 0 + vite exit 0）中因沙箱不可复跑的部分以正读与静态核对补充。
- ⏳ **端到端验收依赖 T-125（tester）宿主执行**（T-123 证据 §3 已如实登记，本审查认可该移交）：
  1. AC-R1-1/2/4：隔离 hub + 守护 + 模型通道，发送 → awaiting → replied 真回复闭环与 retry 幂等；失败注入 → ❌ 分类可行动文案 + 健康条黄/红；
  2. AC-R2-3：software 空间问仓库事实题 → 回复引用绑定仓库真实内容（D-2 语义是否成立的唯一证据点）；
  3. AC-R3-2 + AC-R4-6：上传含独有事实文件提问 → 引用该事实；不带附件同问无该事实；连续两问第二问不含第一问附件；
  4. AC-R1-6/R2-1/R3-1：浏览器冒烟（全部空间选空间入口、附件 chip 发送、消息附件标识）。
  - 上述任一失败或不可达时，T-125 应如实返回具体步骤/输出，不黑盒跳过；M1/M2 的宿主现场（live software scope）可顺带目击红态现象验证修复必要性。
- 🚫 本审查未改动任何实现代码；仅新增 docs/review/T-124-REVIEW.md。

*（本文件由 T-124 代码审查产出；只读代码给出意见，未改实现、未调用 taskctl/看板写接口、未 push。）*