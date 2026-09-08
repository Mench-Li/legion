# T-120 方案搜索：对话中心「可回答闭环修复 + 上下文输入（关联工作空间 / 上传文件）」选型研究

> 阶段：方案搜索（researcher）｜任务：T-120（[auto-goal]，所属目标 G-mtr3su6f-1 · software · chain）
> 上游：T-119「需求澄清」→ docs/G-mtr3su6f-1/REQUIREMENTS.md（R-1~R-5 + D-1~D-8 + O-1/O-2，本目标准一入口）
> 下游：breaker（docs/G-mtr3su6f-1/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
> 本文件落点：docs/G-mtr3su6f-1/RESEARCH.md（目标级分析文档目录；不写/不碰仓库根 docs/ 槽位及其他目标目录）
> 验收标准（team-hub/stage-standards.mjs:48-64 researcher 四条）：方案覆盖需求要点并给出 ≥2 候选对比；有明确推荐与理由（真实可查来源注明引用）；新引入技术/依赖逐项说明影响；结论可直接支撑拆解。

---

## 0. 文档状态与阅读说明

- 本阶段只做选型研究，不改任何仓库实现代码。下列所有「候选/推荐」均为机制方向与设计口径；具体落地代码改写归 breaker→coder。文件路径均以仓库根相对（本 worktree w/T-120）。
- 沿用本仓库标注惯例：✅ 已确认口径（代码/文档/live 数据/历史证据钉死，可直接依据）；⚖️ 待将军裁决（默认按「倾向 + 默认值」推进，默认值 = 假设非结论）；❓ 遗留/开放问题（明示假设）。
- ⚠️ 联网可用性声明：本会话 web_search 工具被拒（返回 "Insufficient Balance"），无法在线复核第三方库的版本号 / 下载量 / star 数 / 最近提交时间 / 具体 LICENSE 文本。因此：
  - 第三方候选的许可证类型仅标注**公开且稳定的一般事实**并注明「⚡需联网复核具体文本与最新维护状态」；不给出任何时效性数字，避免虚构（遵守「不编造数据支撑结论」）；
  - 每个第三方工具给出官方仓库/官网 URL 作引用锚点（研究者可复核的原始出处，本次未联网打开），在 §14.2 集中声明；
  - **本方案最终采纳 0 个新运行时依赖**——所有推荐决策的可靠性不依赖任何上述时效性数字，第三方技术仅作「评估并拒绝/后置」的对照候选。
- 本地引用均为真实 file:line（本会话 read/grep 实测确认，见 §12.2），可直接复核。

---

## 1. 选型任务总览：R-1~R-5 映射到 researcher 需落定的工程决策

T-119 已把「要什么 / 验收口径」钉死，把「怎么实现」留给我（REQUIREMENTS §10 明示自由度：LLM 通道、上下文注入机制、附件存储、守护/模型运行契约、预算配置形态）。据此本阶段需落定七组决策：

| 决策 | 对应需求 | 决策问题 | 结论速览（详见各节） |
| --- | --- | --- | --- |
| A 执行层失败可诊断化 | R-1 | 「回复子代理未完成（error）」如何复现定位、分类、给出可行动失败文案？ | A1 隔离复现 + 透出子代理 error 详情 + 纯函数分类器映射可行动文案（5 类）；拒绝自动重试/模型网关 |
| B 运行前提可见化 | R-1 | 「守护在线 / 模型可解析 / 回复开」如何对 UI 可见？ | B1 team-hub 聚合健康端点（守护心跳 + /api/models + reply-settings）；B2 daemon.json 扩字段作排障旁证 |
| C 工作空间上下文来源与取数 | R-2 | 「该空间只读真实内容」从哪来、怎么取、预算如何？ | C1 守护读绑定仓库（spaces.local_dir）即时构造确定性摘要（allowlist 文件 + 顶层结构）；拒绝 RAG/向量库与自由工具 |
| D 上下文注入形态与降级 | R-2/R-4 | 摘要/附件如何进提示词、超预算/读取失败如何降级？ | D1 纯文本分块注入（角色→设定→空间摘要→附件→历史→提问），预算先裁摘要、截断加标记、失败给明示占位 |
| E 附件数据面 | R-3/R-4 | 上传文件存哪、如何随消息绑定、守护如何取回、何时清理？ | E1 team-hub 新增 chat_attachments 行 + uploads 目录（内容落盘不入库），meta 只存引用；拒绝塞进 messages.meta / 复用文件中心 |
| F 前端交互 | R-2/R-3/R-1 | 附件入口、全部空间视图选空间入口、回复设置 UI 用什么做？ | F1 原生控件零依赖（textarea 侧附件行 + 空间选择面板 + 设置弹窗）；拒绝 react-dropzone/antd 组件库 |
| G 公共护栏实现 | R-4 | 类型/大小/数量/预算/审计/降级/清理怎么实现与配置？ | G1 零依赖 server+守护侧校验与常量配置（env 可覆写）；拒绝 file-type/pdf-parse 等嗅探/抽取库 |

> R-5（文档同步收口）无技术决策：随 R-1~R-4 实现结果更新 docs/FEATURES.md §3.9 / README.md / workbench/README.md，并过既有 docs 校验（scripts/ci/run-ci.mjs:333-336、check-docs.mjs），见 §11.1 S8。
> 关键原则（REQUIREMENTS §4.2/§7.2）：不替换 LLM 通道与提供方；不给回复方任意文件/工具权限（只读、显式、预算内）；不做 RAG/长期记忆；零新依赖、零外网运行依赖。

---

## 2. 决策 A —— R-1 执行层失败「可诊断、可行动」修复路径

### 2.1 问题定位（✅ 证据）

- live 失败形态：守护 answerChatMessage 在子代理结果非 completed 时，统一回写 `回复子代理未完成（${result.stopReason}）`（plugins/src/index.ts:2439-2441），stopReason=error 即 live 现场 msg2 的 aiError（T-119 §2.5）；外层 catch 又统一 `String(e).slice(0,300)`（:2455-2458）——**底层具体原因被两层笼统化吞掉**，用户拿到的文案不可行动。
- 模型解析链已存在三级 fallback：settings.model（team-hub/server.mjs:1041-1053，默认 null）→ /api/models 的 role=assistant 行（plugins/src/index.ts:2402-2403）→ daemon currentSelection（:2397-2401）→ config.provider 兜底（:2404-2405）。**任一级解析出空串/非法模型/与 provider 不匹配，都会在子代理 start 阶段变成 stopReason=error，而 error 详情未透出**。
- 其余失败点已各有失败路径：foreman 不可用 → 「守护 foreman 不可用」（:2407-2411）；超预算 → result=null「超时/中止」（:2431-2437, 2439）；空回复 → 「返回空内容」（:2443-2447）；开关关 → 空转（:2391-2392）。
- 服务端 failAiReply 的 aiError 上限 500 字符（server.mjs:1204），超龄兜底文案已可读（:1094）——**回写通道本身支持承载分类文案**。

### 2.2 候选对比

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| A1 隔离复现 + 透出详情 + 分类映射（推荐） | ①在隔离实例/临时库构造同构 awaiting 消息，用可控 provider 让子代理返回 error，复现并拿到 `run.result` 的 error 字段原文（DSH harness 子代理 stopReason=error 终止语义可在本地源码与测试中确认）；②把该 error 详情透传进 markChatFailed（不再笼统）；③新增**纯函数错误分类器**（plugins 侧，可单测）：输入 stopReason/error 文本 → 输出类别枚举 + 可行动文案 | 根因可见可行动；分类器纯函数零 I/O 好测；失败文案符合 AC-R1-3（断言不含裸 error/undefined 样式）；改动局部（index.ts answerChatMessage + chatResponder.ts + 小分类器），不换通道不改语义 | 需先做隔离复现定位「error 的具体上游」才能定分类关键词面（风险 RK-1 缓解路径的第一步，是 R-1 固有工作量） | 低：不新增依赖；与 D-8（沿用 120s/手动重试）兼容 | ✅ 推荐 |
| A2 daemon 自动重试/降级模型 | failed 后自动退避重试 N 次，或自动切 fallback 模型再答 | 无人值守时可用性更高 | 与 REQUIREMENTS D-8 默认（无自动重试、手动防抖重试）冲突；需幂等/节流/退避新机制与测试；若根因是模型配置本身错误，自动重试只是反复失败 | 中：行为语义变更需将军裁决（D-8 之外的新默认） | ⚖️ 备选（将军要自动重试才启用，现期不做） |
| A3 引入模型网关/代理（LiteLLM / OpenRouter 类） | 用网关统一多 provider、失败自动路由 | provider 层高可用、配置集中 | 违反 REQUIREMENTS §4.2「不替换/不新增 LLM 通道与提供方」与仓库零外网依赖纪律；需联网下依赖与部署外部服务 | 高：范围外、依赖外网 | ❌ 明确不做（若隔离复现证明根因是「provider 本身不可用」，那是部署环境问题，另行报障/将军裁决，不属于本目标实现） |

### 2.3 推荐与机制口径

**A1**。理由（本地可查）：错误吞没点已被精确定位（plugins/src/index.ts:2439-2441、:2455-2458）；三层模型 fallback 已在代码中（:2396-2405），把「实际选中了谁」记进 failed/健康数据是纯增量；回写通道 aiError ≤500 且已有可读先例（server.mjs:1094、:1204）证明承载分类文案无架构障碍。分类器建议类别（breaker 落细，可单测断言）：
1. `model-unavailable`：选中的 settings.model / agent_models / currentSelection 在 provider 侧非法/不存在/未授权 → 文案含「模型配置不可用：请到模型配置/回复设置选择 assistant 可用模型后重试」；
2. `provider-error`：provider 连接/鉴权/限流等通道错误（error 文本含 key/auth/quota/429/connection 等关键词）→ 文案含「模型通道错误（…）」，指向环境排障；
3. `timeout/aborted`：超预算 abort（result=null）→ 沿用超时文案；
4. `foreman-down`：已有（:2409）；
5. `empty-other`：空回复与未分类 error → 保留原文片段（≤500）+「重试」指引，禁止输出裸「回复子代理未完成（error）」。
隔离复现路径：team-hub/chat.test.mjs 已有 tmp DB + 动态 import 范式（:3-23），chat-l1-smoke 已有真实进程 + SSE 冒烟（run-ci.mjs:253-254）；「守护侧触发真实子代理」的隔离复现需在测试里注入 fake provider 让 subagent 返回 error/completed 两种终止（对齐 plugins/tests/chat-responder.test.mjs 的纯函数单测 + 守护集成测试同型），不触碰 live 库（RK-4）。

---

## 3. 决策 B —— R-1 运行前提可见化（对话中心健康状态）

### 3.1 现状与候选

现状：守护每轮把自身能力写进 daemon.json（plugins/src/index.ts:743-780，含 mode/provider/scope/model/uptime/repo 绑定），但那是**文件系统侧**（config.scrumDir），team-hub 与 UI 读不到；hub 侧只有成员在线表（POST /api/heartbeat → touchMember，server.mjs:2163-2169；GET /api/members 按 lastSeenAt<60s 算 online，:2378-2384）。UI 对「守护没跑 / 模型没配」无提示（T-119 §2.4），failed 文案此前不可行动。

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| B1 hub 聚合健康端点 | team-hub 新增 `GET /api/chat/health?scope=`：聚合 ①守护在线（守护以成员身份 POST /api/heartbeat 上报 —— 该端点已存在 server.mjs:2163，守护需开始调用，新增量小）②本空间回复开关（getReplySettings 已有 :1041）③模型解析结果（/api/models :2224 + settings.model 链）④最近一次 chat 失败类别；UI 对话中心头部状态条展示 | 单一事实源在 hub，UI 一个 fetch 即得；与既有 heartbeat/members/SSE 机制同构；直接支撑 AC-R1「至少不静默」与失败「如何恢复」指引 | 需守护新增心跳调用（小改动）与 hub 一个聚合查询；「模型 provider 是否真可用」只有守护实际调子代理才知道 —— 健康端点只能报告解析结果与守护在线，不能保证 provider 通（诚实降级：标注「已解析，可用性以实际回复为准」） | 低；不新增依赖 | ✅ 推荐 |
| B2 扩展 daemon.json chat 字段 | daemon.json 增 chat:{lastFail,lastReply,failedReason} 等旁证（index.ts:746-780 已写 model 字段） | 运维/排障直接 cat 即见，零 hub 改动 | UI 读不到（跨进程文件路径耦合，不建议 hub 去读插件目录）；仅排障旁证 | 低 | ✅ 作为 B1 的辅助（排障文档用），不替代 B1 |
| B3 UI 静态帮助文案 | 只在对话中心放「AI 回复需要：守护在线 + 模型已配置」静态说明 | 零后端改动 | 不反映真实状态，AC-R1「运行前提可见化」只弱满足「不静默」 | 低 | ❌ 不单独采（可作为 B1 状态条的默认文案底色） |

### 3.2 推荐

**B1 + B2**。理由：心跳端点与成员在线判定已存在（server.mjs:2163-2169、:2378-2384），守护每轮本来就在轮询 /api/chat/replies（plugins/src/index.ts:2465），「回复」动作本身即可作为守护活性的代理信号（或显式心跳，breaker 二选一落细）；聚合端点的三输入（members / chat_reply_settings / agent_models+models）全部在 hub 内零新增依赖可得。UI 呈现：对话中心头部（ChatView.tsx:345-354 区域）加状态点（绿=守护在线+开关开+模型已解析 / 黄=某前提缺失并给出对应修复动作 / 红=最近回复失败并给出重试指引），文案直接复用决策 A 的分类文案。诚实边界：provider 实际可用性只能由「回复成功/失败」事实反馈，健康端点不冒充（标注说明），与 AC-R1-3 的「失败可行动」互补。

---

## 4. 决策 C —— R-2 工作空间上下文来源与取数

### 4.1 现状与候选

现状：回复方提示词 = 角色 + systemHint + 会话历史，**明示不访问文件/网络**（plugins/src/chatResponder.ts buildChatAnswerPrompt，「你只负责回答用户问题，不做任何工具调用、不访问文件或网络」）；对「仓库里有什么」类问题只能空答（live msg1）。可用的真实内容源：
- 守护进程侧：scope → spaces.local_dir 绑定缓存（plugins/src/index.ts:646-678 refreshSpaceBinding，读 /api/spaces 取 localDir、resolve repoRoot；workspaceFor() = localDir）；
- hub 侧：GET /api/spaces 返回 name/private/localDir/remoteUrl（server.mjs:2327-2345）；/api/models（:2224-2226）；chat_reply_settings（:1041）。
- 工作空间实体字段：spaces 表仅 id/name/private/local_dir/remote_url（server.mjs:143-151），无扩展内容列。

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| C1 确定性只读摘要（守护即时构造） | 守护在每次回复时从绑定仓库构造「空间摘要」文本：空间元数据 + 顶层目录/文件结构 + allowlist 关键文件片段（README/FEATURES/LEGION/AGENTS/PLUGINS 等，存在即读、单文件≤4000 字符、合计≤8000 预算）；纯只读 UTF-8 截断，不执行任意子进程 | 与「只读、显式、预算内、无工具」边界完全一致（REQUIREMENTS R-2 scope out）；零新依赖；内容真实来自绑定仓库 → AC-R2-3「回答引用真实内容」直接可测；确定性输出便于单测（fixture 仓库 → 摘要快照断言） | 摘要深度有限（不全文检索）；对「跨目录找某 API」类问题覆盖弱（本期验收题面为顶层结构/README 事实题，足够）；守护需处理仓库未绑定/读取失败降级 | 中低：本地仓库内容进 LLM 出站 —— R-4 预算/审计与「只读、不授权工具」缓解（RK-2） | ✅ 推荐 |
| C2 给回复方只读文件工具（含 MCP 化） | 回复子代理获得受限读工具（如 files.read + allowlist 路径），按需自己翻仓库 | 模型能自主找深度内容 | 与「默认不给回复方工具权限」（REQUIREMENTS R-2 scope out / chatResponder.ts 明示无工具）直接冲突；需工具注册/鉴权/审计新机制；单次回复多轮工具调用会爆预算与延迟 | 高：行为边界改变，需将军裁决 R-2 语义从「摘要注入」扩为「工具授权」 | ❌ 本期不做；作为 O-2 扩展形态记录（DSH harness 已具备 MCP 客户端桥接能力 dsh-mcp-client，将来做工具面时可零自研接入外部服务器，见 §9.1） |
| C3 RAG / 向量检索（LangChain / LlamaIndex + 向量库） | 对仓库建索引/embedding，回复前检索 top-k 片段注入 | 大仓库/语义检索场景强 | 引入 embedding 模型 + 向量库 + 索引生命周期（增量/重建）+ 每空间隔离存储；违反零新依赖与零外网纪律；单一小型仓库（legion 顶层可枚举、关键文件可 allowlist）用检索是过度设计 | 高：成本/复杂度/维护，RK-3 预算反噬 | ❌ 拒绝（本期）；若未来空间内容增长到千文件级，作为独立目标评估（§9.1 有许可证等事实锚点） |

### 4.2 推荐与摘要规格（C1）

**C1**。理由：REQUIREMENTS R-2 的验收题面是「顶层目录 / README 讲的产品」类真实事实题（AC-R2-3），绑定仓库本地可读（守护已有 localDir 缓存，plugins/src/index.ts:646-678），C1 以最低成本直接命中；C2/C3 超出需求边界与纪律。摘要规格（breaker 据此切片、test-designer 转用例）：
1. **来源**：当前关联空间 localDir（守护 spaceBinding.localDir；无绑定 → 降级占位，见决策 D）。
2. **组成**：(a) 空间元数据块：name/id/localDir/remoteUrl（/api/spaces 已有字段）；(b) 顶层结构块：readdir 一级条目（目录在前，跳过 .git/node_modules/dist/build/.legion-worktrees 等噪声；≤120 条截断并计数）；(c) 关键文件块：allowlist（README.md、README.zh.md、LEGION.md、AGENTS.md、docs/FEATURES.md、PLUGINS.md、package.json、COMMAND.md——存在即读，按序消费字符预算）。
3. **预算**：摘要合计 ≤ 决策 G 子预算（默认 4000 字符）；单文件 ≤4000 截断并加「（文件过长已截断）」标记；**附件内容优先于摘要**（用户显式提供 > 背景摘要）。
4. **纪律**：只读 fs；UTF-8 解码失败即跳过该文件；不 spawn 任意命令（顶层结构用 readdir 而非 git 命令，避免子进程面）；摘要每次回复即时生成、不落库、不跨消息缓存（对齐 D-3「不形成持久知识」，避免陈旧与泄漏）。
5. **可测**：fixture 目录（带已知文件与噪声）→ 摘要快照断言（存在 allowlist 文件内容、噪声被跳过、超预算截断标记）。

---

## 5. 决策 D —— 上下文注入形态与降级（prompt 结构 / 预算 / 来源声明）

### 5.1 候选对比

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| D1 纯文本分块注入（扩展 buildChatAnswerPrompt） | 输入增加 `spaceDigest?` 与 `attachments?: [{name,size,content}]`；输出顺序：角色→行为约束→systemHint→「工作空间只读上下文（取自绑定仓库，生成于 <ts>）」块→「本次随消息上传的文件」块（文件名+大小横幅+内容）→会话历史→提问；空摘要/空附件不产出对应块 | 与现有纯函数提示词构建器（chatResponder.ts）同构，扩展即单测；来源可见（时间戳/横幅）支撑 AC-R2「上下文来源可见」；纯文本无注入面风险（无 HTML/模板执行） | 需在队列侧把附件内容带上（决策 E 的取回接口）；顺序/截断需定死以可断言 | 低 | ✅ 推荐 |
| D2 附件内容混入历史 | 把上传文件当一条 system 消息塞进会话历史上下文 | 复用现有上下文通道、改动最小 | 附件内容会随历史进入后续消息的「最近 12 条」上下文（listAwaitingReplies 的 context 逻辑 server.mjs:1104-1130）→ 泄漏到跨消息上下文，违反 D-3 / R-4-AC6「新消息不带上一消息附件上下文」 | 中高：语义泄漏 | ❌ 拒绝 |
| D3 结构化 JSON 双通道（prompt + tool 结果） | 走 harness 子代理的 tool result 结构注入 | 结构清晰 | 需要把上下文伪装成工具结果（回复子代理无工具权限）；过度设计 | 中 | ❌ 拒绝 |

### 5.2 推荐（D1）与降级口径

**D1**。扩展点已锚定：buildChatAnswerPrompt 的 input 接口（plugins/src/chatResponder.ts ChatAnswerInput）加可选字段即可，调用方在 index.ts:2413-2419 拼装。降级（AC-R2-4 / AC-R4-5）：
- 空间未绑定仓库 / localDir 不可读 → 摘要块替换为明示占位：「（当前空间未绑定可读本地仓库，无法提供工作空间内容上下文）」，回答继续（按历史），**不冒充读取成功**；
- 附件读取失败（单个）→ 该附件块替换为「（附件 <name> 读取失败：原因）」占位，其余照常；
- 预算超限 → 先裁摘要、后裁最旧附件，保留用户最新附件与提问，并各加「（已截断）」标记（AC-R4-1）；
- 摘要生成异常（守护侧 catch）→ 不注入摘要且不影响发送/重试主流程（异常被吞进日志，源消息不标 failed——上下文失败不阻断会话，与「降级不崩」一致）。

---

## 6. 决策 E —— R-3 附件数据面（上传 → 绑定 → 取回 → 清理）

### 6.1 现状与候选

现状：messages.meta 是 JSON 扩展面（server.mjs:293-303，meta 默认 '{}'；aiStatus 等已存于此），**消息表无附件概念**；messages.body 有 8000 字符上限（:916）；CHAT_MSG_KINDS 仅 text/markdown/system（:915）——把文件正文塞 meta/body 都违反现有约束语义。team-hub **没有任何文件上传端点**（本会话 grep upload/multipart/FormData 在 server.mjs 零命中）；文件中心 /api/files/* 在 workbench 侧 serve.mjs（见下表 E3），与 team-hub 是不同进程。

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| E1 team-hub 附件面：chat_attachments 行 + uploads 目录落盘 | 新表 chat_attachments(id, scope, conv_id, msg_id, file_name, size, kind, sha1, path, status, createdAt)；上传 PUT /api/chat/attachments（raw body，Content-Length 预检 + 临时文件 + 原子改名，完全复用 serve.mjs /api/files/upload 已验证的写纪律，见 workbench/scripts/serve.mjs:15、:1227+）；文件内容落 uploads 目录（DB 旁，不入 SQLite）；messages.meta 只存 `attachments:[{id,name,size}]` 引用；守护答问时经 GET /api/chat/attachments/content?id= 取回文本 | 与「文件内容不进 body」（AC-R3-1 / AC-R4-3）严格一致；内容不入库避免大 blob 拖垮 listMessages（listMessages/queue 均为 SELECT *，server.mjs:1021-1037、1104-1130）；上传纪律有现成先例（serve.mjs PUT raw body + 原子改名已过验收）；按 sha1 命名天然去重 | 新增 1 表 + 2-3 个端点 + 清理任务（TTL）——本目标内合理增量 | 低：新面走既有写纪律/审计/SSE 模式 | ✅ 推荐 |
| E2 文件内容直接存 messages.meta | 上传时把文本内联进 meta JSON | 零新表、改动最小 | meta 随所有消息列表查询被整体 SELECT（server.mjs:1021-1037、1104-1130）——多个 10MB 附件消息会拖爆分页与 SSE；违反「meta 是轻量状态扩展」语义（现仅存 aiStatus 等）；SQLite 官方亦建议大对象外置文件系统（§9.1 锚点） | 高：数据面性能与存储污染 | ❌ 拒绝 |
| E3 复用文件中心 /api/files（serve.mjs） | 上传到空间 local_dir 下某目录，守护读该目录 | 复用现成端点 | 文件中心在 workbench dev server 进程（serve.mjs），不在 team-hub 与守护的信任链上（守护连 hub）；且上传会**污染绑定仓库**（文件落到 local_dir 即仓库工作区，可能被 git 追踪/误提交）；会话附件生命周期与仓库文件混在一起不可清理 | 高：跨进程耦合 + 仓库污染 | ❌ 拒绝 |

### 6.2 推荐与数据面口径（E1）

**E1**。机制口径（breaker 据此切片）：
1. **上传**（UI 发送前完成）：PUT /api/chat/attachments?scope=，raw body；服务端校验大小（默认 ≤10MB，Content-Length 预检）、UTF-8 文本（decoder fatal 校验 + 扩展名黑名单，见决策 G）；成功 → 建行 status='staged'（未绑定消息）+ 落盘（uploads/<scope>/…）；返回 {id,fileName,size}；黑名单/非文本 → 4xx 可读文案（AC-R3-3 / AC-R4-2）。
2. **绑定**：postMessage 扩展接受 attachmentIds → 同事务写 meta.attachments 引用 + 把行 msg_id/conv_id 绑定、status='sent'；body 不含文件内容（AC-R3-1 / AC-R4-3 断言点）；kind 仍为 text（不新增 kind，避免白名单扩散，REQUIREMENTS R-3「二选一」取此）。
3. **取回**：守护答问时对 awaiting 消息的 meta.attachments 逐个 GET /api/chat/attachments/content?id= 取文本（服务端按会话归属校验 + 单附件 ≤4000 字符注入预算截断，超长加标记）；附件内容**只进当次提示词**（决策 D1），不回写、不入历史（AC-R4-6）。
4. **清理**：守护或 hub 定时任务（breaker 选宿主）删除 status='staged' 超 24h（未发送孤儿）与已绑定超 TTL（默认 7 天）的行+文件；audit 记 chat:attachment 上传/消费（文件名+大小+scope，AC-R4-4）。
5. **可见性**：附件仅本会话（行 conv_id + UI 按消息 meta 展示）；跨会话/跨空间不可见（AC-R3-5）。

---

## 7. 决策 F —— 前端交互（附件入口 / 选择空间入口 / 回复设置 UI）

### 7.1 现状（✅）与候选

现状：ChatView 编辑器为纯文本 textarea（workbench/src/components/ChatView.tsx:442-464），无附件能力；scope=null（全部空间）时只显示「请先选择具体工作空间…不可发消息」卡片（:250-261），无选择入口；回复设置 API 已存在但全 UI 零引用（api.ts:601-618 fetch/saveChatReplySettings，T-119 §2.4）；scope 状态归 App 所有（App.tsx:56、setScope :295、<ChatView scope hubMode> :447）。

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| F1 原生控件零依赖 | 附件：隐藏 `<input type=file multiple>` + 📎 按钮 + 发送前附件 chip 行（可移除）；空间入口：!scope 卡片改为可选空间列表（fetch /api/spaces，复用 api.ts 既有 hub fetch 范式）+ onPickScope 回调（App 传 props，调 setScope）；设置：头部齿轮弹窗（开关/模型/身份/systemHint → saveChatReplySettings） | 零新依赖（仓库无组件库，原生与 index.css 手写风格一致）；行为面（选择/多选/大小预检/可移除）原生可覆盖 AC-R3-1/3/4；与既有 Modal/toast 组件同风格（ChatView 已用 toast） | 拖拽上传不支持（D-6 只要求「选择/上传」，未要求拖拽）；细节手写（chip/按钮样式） | 低 | ✅ 推荐 |
| F2 react-dropzone 类上传库 | 拖拽/点击上传交互库 | 拖拽体验、多文件处理便利 | 新增运行时依赖（MIT，⚡需联网复核具体版本与 LICENSE 文本，违反零新依赖默认与仓库纪律）；本需求只需「选择文件+发送」，原生足够 | 中：依赖引入需将军批准（仓库禁止联网下依赖） | ❌ 拒绝（本期）；拖拽作为可选增强后续评估 |
| F3 antd/组件库 Upload | 成熟组件体系 | 组件全 | 引入整套 UI 框架（重量级），与现仓手写 CSS/组件风格冲突；学习成本与改造面大 | 高 | ❌ 拒绝 |

### 7.2 推荐

**F1**。三块改动都落 ChatView.tsx + api.ts + App.tsx（文件域与 R-2/R-3 共享，breaker 需排先后/划函数域，REQUIREMENTS §7 RK-7 已警示）。附件数据流：选择（原生 input）→ 客户端预检（大小/数量）→ 逐个 PUT 上传拿 {id}（决策 E）→ 发送消息携带 attachmentIds → 成功后清附件槽；失败保留附件槽并 toast（对齐现有 send 失败保留草稿语义 ChatView.tsx:312-316）。发送中（sending）与上传中禁用发送按钮，避免竞态。模型选项数据源 = /api/models（含 role=assistant 行 + daemon currentSelection 兜底展示），breaker 接线时复用 api.ts:601-618 与模型接口。

---

## 8. 决策 G —— R-4 公共护栏实现与默认值

### 8.1 候选对比

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| G1 零依赖服务端+守护校验 | 常量默认 + env 可覆写（沿用 CHAT_REPLY_TIMEOUT_MS 的 env 先例，server.mjs:912）；UTF-8 解码校验 + 扩展名黑名单 + Content-Length 大小预检 + 数量限制 + 预算截断 + audit；守护侧预算分配（先裁摘要后裁附件） | 全部约束在服务端单一事实源，客户端不可绕过；每项可单测断言（AC-R4-1..6 直接映射）；零依赖 | 黑名单靠扩展名（不嗅探 magic bytes）——伪装扩展名的二进制会在 UTF-8 解码校验处被拒（双保险），覆盖足够 | 低 | ✅ 推荐 |
| G2 引入嗅探库（file-type 类） | magic bytes 真嗅探类型 | 比扩展名准 | 新运行时依赖（⚡需联网复核版本/LICENSE）；本面是「UTF-8 文本类」而非任意类型识别，node 内建 TextDecoder fatal 模式 + 扩展名黑名单已覆盖威胁 | 中 | ❌ 拒绝（可作未来增强） |
| G3 引入文本抽取库（pdf-parse/mammoth 等） | 支持 PDF/Word 作为上下文 | 富格式支持 | 超出 D-6 / REQUIREMENTS「文本类 UTF-8」范围与「图片/非文本默认拒作上下文」边界；引入原生/重依赖 | 高：范围外 | ❌ 拒绝（O-2 backlog 若将军扩展再评估） |

### 8.2 推荐与默认值表（G1；breaker 落为常量 + env 覆写，全部 ⚖️ 默认值=假设，承接 REQUIREMENTS D-6）

| 常量 | 默认值 | 说明（锚点） | 覆盖的 AC |
| --- | --- | --- | --- |
| CHAT_ATTACH_MAX_BYTES | 10MB | 上传 Content-Length 预检（对齐 serve.mjs 上传预检先例） | AC-R3-3 / R4-2 |
| CHAT_ATTACH_MAX_PER_MSG | 3 | 每消息附件数量 | AC-R3-3 / R4-2 |
| CHAT_ATTACH_BLACKLIST_EXT | exe,dll,bin,zip,rar,7z,tar,gz,png,jpg,jpeg,gif,webp,svg,ico,pdf,doc,docx,xls,xlsx | 黑名单（可配置）；白名单行为 = 非黑名单 + UTF-8 校验通过 | AC-R3-3 / R4-2 |
| CHAT_TEXT_UTF8 | — | TextDecoder('utf-8',{fatal:true}) 校验；失败 → 「无法作为上下文（非 UTF-8 文本）」4xx | AC-R3-3 / R4-2 |
| CHAT_CTX_BUDGET_CHARS | 8000 | 单次回复外部上下文总预算（摘要+附件合计，服务端截断） | AC-R4-1 / R4-6 |
| CHAT_CTX_FILE_CAP_CHARS | 4000 | 单文件/单摘要块注入上限（截断+标记） | AC-R4-1 |
| CHAT_ATTACH_STAGED_TTL_MS | 24h | 未绑定消息的孤儿上传清理 | AC-R4-6（清理纪律） |
| CHAT_ATTACH_TTL_MS | 7 天 | 已绑定附件保留期（过期清理） | AC-R3-5（附件仅本会话）+ 生命周期文档化（REQUIREMENTS D-3 要求 researcher 定稿文档化） |
| CHAT_REPLY_TIMEOUT_MS | 120s（沿用） | 不变（D-8） | AC-R1 时间窗 |
| 内容不进 body | — | 附件内容只存 uploads + 只进当次提示词；messages.body/meta 仅引用（断言点） | AC-R4-3 / AC-R3-1 |

审计（AC-R4-4）：上传/消费走 chat:attachment* 审计（detail 含 file_name/size/scope/conv），复用 audit()（server.mjs:250-259、chat:message 先例 :1012）。

---

## 9. 外部依赖 / 新增技术影响逐项说明

> 本方案**采纳 0 个新运行时/开发依赖**。下列为评估过（候选/对照）的第三方技术逐项影响说明；许可证为公开且稳定的一般事实（⚡需联网复核具体文本与最新维护状态，见 §14.2）。

| 技术 | 在本方案中的角色 | 许可证（一般事实，⚡需复核） | 维护/生态属性（⚡需复核时效数字） | 学习成本 | 生态 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| LangChain（langchain-ai/langchain，官网 python.langchain.com） | R-2 候选 C3：仓库内容检索/RAG 框架 | MIT（⚡） | 社区活跃、文档全（⚡）；抽象层多、版本迭代快，学习曲线陡 | 高 | 大而全：模型/检索/记忆/Agent | ❌ 拒绝（本期）：小型单一仓库 allowlist 摘要即够；引入即破坏零依赖纪律；未采不影响任何功能 |
| LlamaIndex（run-llama/llama_index，官网 docs.llamaindex.ai） | R-2 候选 C3：数据索引/检索框架 | MIT（⚡） | 社区活跃（⚡） | 高（索引/检索概念体系） | 面向 RAG/知识库 | ❌ 拒绝（同上） |
| 向量库（ChromaDB / pgvector / FAISS 等） | C3 的存储底座 | 各自 MIT/Apache（⚡逐项复核） | 需独立运行/嵌入实例 | 中高 | 检索生态 | ❌ 拒绝：为摘要注入引入检索栈属过度设计；若未来空间内容千文件级再立目标评估 |
| MCP（Model Context Protocol，modelcontextprotocol.io/specification；GitHub modelcontextprotocol/*） | O-2 未来「工具面/更多上下文形态」的协议层候选（决策 C2 备选） | 规范开放、SDK 开源（⚡具体 LICENSE 文本复核） | Anthropic 2024-11 开源，现多厂商参与（⚡治理细节复核） | 中（规范清晰） | 生态快速扩张（⚡） | ⚖️ 本期不引入；**已具备无自研接入条件**：DSH harness 自带 MCP 客户端桥接 @deepseek-ai/dsh-mcp-client（本地源码 packages/mcp/mcp-client/README.md：连接外部 MCP 服务器并把工具注册到 ctx.tools）。将来若将军批准「回复方可读外部上下文源」，可作为插件依赖接入（届时新增依赖需将军批准） |
| react-dropzone | R-3 上传 UI 候选 F2 | MIT（⚡） | 维护活跃（⚡） | 低 | React 上传小生态 | ❌ 拒绝（本期）：仅需点击选择+多选，原生 input 足够；拖拽为可选增强 |
| antd（及其 Upload） | F3 | MIT（⚡） | 活跃（⚡） | 中高（组件体系） | React 大型组件库 | ❌ 拒绝：引入整套 UI 框架与现仓手写样式冲突 |
| file-type（嗅探） | G2 | MIT（⚡） | 活跃（⚡） | 低 | 类型检测 | ❌ 拒绝：TextDecoder fatal + 扩展名黑名单已覆盖文本类威胁面 |
| pdf-parse / mammoth（抽取） | G3 | MIT（⚡） | 活跃度不一（⚡） | 低中 | 文档解析 | ❌ 拒绝：超出文本类范围（D-6 默认） |
| LiteLLM / OpenRouter（模型网关） | A3 | MIT（⚡各自） | 活跃（⚡） | 中 | 模型路由 | ❌ 拒绝：违反「不替换/不新增 LLM 通道」（REQUIREMENTS §4.2） |
| node:sqlite（Node 内建） | **沿用**（team-hub 已在用 server.mjs:51，本方案 E1 只在既有 DB 上加表） | Node.js 核心（同 Node 许可证） | 随 Node 发布；本机 Node v24.19.0 实测 module 可用（§12.2）；⚡稳定性标注级别以 Node 官方文档为准（本地未联网复核最新标注，但生产已运行多轮测试全绿） | 低（仓库已大量使用） | Node 内建 | ✅ 沿用，非新引入（不加依赖） |
| SQLite 大对象落盘参考 | E1 依据：附件内容不入库、落 uploads 目录 | — | — | — | — | ✅ sqlite.org 官方论述「小 blob 内联 / 大对象走文件系统」（intern-v-extern-blob 页面，⚡未联网复核最新版本文档措辞；方向稳定：SQLite 长期建议大 blob 外置）支持 E1 不把 10MB 附件塞 messages 表 |

### 9.1 影响结论

- 新增依赖数：**0**（运行时 + 开发时）。全部推荐（A1/B1/C1/D1/E1/F1/G1）均基于仓库既有技术面：node:sqlite（已用）、原生 fetch/EventSource（已用）、原生 fs/TextDecoder、React 原生表单与手写 CSS、守护子代理（DSH 提供）。
- 学习成本：无新框架/库；新增的是**领域概念**（附件生命周期/预算/健康状态），落点即仓库既有分层（server DAO + plugins 纯函数 + ChatView 组件），可照 chat/calendar 既有模式复制。
- 维护影响：新常量集中在既有 env 常量旁（CHAT_REPLY_TIMEOUT_MS 先例 server.mjs:912）；新表走「CREATE TABLE IF NOT EXISTS 零迁移」既有范式（server.mjs:277-318 先例）；清理任务宿主沿用守护 sweep（既有节拍 plugins/src/index.ts:2787）。
- 生态影响：无（不引入新生态依赖）。若将军后续批「工具面/MCP/文件类型嗅探」，本文已给接入条件与锚点（MCP 可经 dsh-mcp-client 零自研接入，需将军批准新增插件依赖）。

---

## 10. 风险与备选

| # | 风险 | 说明 | 缓解/备选 |
| --- | --- | --- | --- |
| Rk-1 | R-1 根因是部署环境依赖（模型/provider 通道不可用），代码修复无法根治 | live 形态 = 子代理 stopReason=error；若隔离复现证明是 provider 侧问题 | A1 把根因隔离并**分类暴露**（AC-R1-3）；「守护在线+模型已解析」作为运行前提由 B1 可见化；provider 本身不可用 → 报障/将军裁决（不换通道） |
| Rk-2 | 空间摘要/上传文件经 LLM 出站的内容外泄/误用 | 提示词携带仓库内容/用户文件 | R-4 护栏全量（决策 G）：显式只读、UTF-8 文本、预算截断、不进 body、audit、per-conv 可见、TTL 清理；不给回复方工具（C1 而非 C2） |
| Rk-3 | 摘要+附件膨胀 prompt → 成本/延迟/截断失真 | 长仓库/多附件 | 总预算 8000 字符（决策 G）；先裁摘要保附件（决策 D）；关键文件 allowlist 深度受限 |
| Rk-4 | 附件数据面新增表/端点回归风险 | E1 触碰 server.mjs 大文件与 chat DAO | 走既有 tmp-DB 测试范式（chat.test.mjs:3-23 动态 import + TEAM_HUB_DB）；新增用例锚 AC-R3-*/R4-*；chat 契约 CI 阶段（run-ci.mjs:190）不回归 |
| Rk-5 | 共享文件域并行冲突（ChatView/api.ts/server.mjs/plugins） | R-1~R-4 同碰多处；在途其他目标亦可能触碰 | breaker 按函数域划界 + 先后排序（R-1 先行、R-2/R-3 其后）；沿用既有 gate/调解（REQUIREMENTS RK-7） |
| Rk-6 | 守护在线信号与 UI 健康状态「假绿」 | B1 只保证「守护在线+模型已解析」，不保证 provider 实际通 | 诚实标注（以实际回复为准）；健康状态 + 失败分类互补：绿/黄/红三态由最后一次实际结果校准 |
| Rk-7 | 附件内容仍在服务端落盘（uploads），有留存面 | 用户文件明文存储 | 权限纪律沿用 DB 目录（team-hub 私有目录）；TTL 清理 + 文档化生命周期（REQUIREMENTS D-3 要求）；不做敏感扫描（R-4 scope out，内容治理另立目标） |
| Rk-8 | 全部外部锚点未联网复核（版本/star/LICENSE 文本） | 影响评估完整性 | 本文已声明（§14.2）；采纳方案 0 依赖，不依赖任何时效数字；将军可在联网环境复核 §9 表 |

---

## 11. 推荐结论汇总（可直接支撑 breaker 拆解）

> 决策→需求→文件域→AC 四列对齐；breaker 按此切片并注意共享文件排序（Rk-5）。

### 11.1 决策 → 文件域切片建议

| 切片 | 决策 | 需求 | 主文件域（仓库根相对） | 对应 AC 锚 |
| --- | --- | --- | --- | --- |
| S1 错误分类与可行动文案 | A1 | R-1 | plugins/src/index.ts（answerChatMessage :2387-2460 重构失败分支）+ plugins/src/chatResponder.ts（+新分类纯函数，单测 plugins/tests/chat-responder.test.mjs） | AC-R1-2/3/4/7 |
| S2 健康状态与守护心跳 | B1/B2 | R-1 | team-hub/server.mjs（GET /api/chat/health + 心跳/活性聚合）+ plugins/src/index.ts（心跳上报 + daemon.json chat 字段 :746-780）+ workbench ChatView.tsx 状态条 | AC-R1-3/6 |
| S3 空间摘要取数 | C1 | R-2 | plugins/src/index.ts（摘要构造，用 spaceBinding :646-678）+ 新纯函数模块（fixture 单测） | AC-R2-3/4 |
| S4 提示词注入扩展 | D1 | R-2/R-4 | plugins/src/chatResponder.ts（ChatAnswerInput/buildChatAnswerPrompt 扩展）+ index.ts 拼装处 :2413-2419 | AC-R2-3/4、AC-R4-1/5/6 |
| S5 附件数据面 | E1 | R-3/R-4 | team-hub/server.mjs（chat_attachments 表 + 上传/取回/清理端点 + postMessage 绑定 :984-1015）+ uploads 目录 + audit | AC-R3-1/3/5、AC-R4-2/3/4/6 |
| S6 前端交互三块 | F1 | R-2/R-3/R-1 | workbench/src/components/ChatView.tsx（!scope 选空间面板 :250-261、composer 附件行 :442-464、设置弹窗、状态条）+ App.tsx（onPickScope :56/295/447）+ api.ts（上传/设置接线 :572-618） | AC-R2-1/2、AC-R3-1/3/4、AC-R1-5/6 |
| S7 护栏常量与测试 | G1 | R-4 | team-hub/server.mjs（常量+env）+ plugins 预算分配 + chat.test.mjs / plugins tests 新增用例 | AC-R4-1..6 |
| S8 文档收口 | R-5 | R-5 | docs/FEATURES.md §3.9（:133-140 区域）、README.md、workbench/README.md；过 scripts/ci/run-ci.mjs:333-336 check-docs | AC-R5-1/2/3 |

### 11.2 验证链（供 test-designer 直接转用例）

- 数据面：既有 tmp-DB 契约测试范式（chat.test.mjs:3-23）扩附件/预算/审计用例；node team-hub/chat.test.mjs 全绿（既有 23 例 + 新增）。
- 纯函数：chatResponder 扩展 + 错误分类器 + 摘要构造 = node --test 纯单测（fixture 目录/合成 prompt）。
- 真实链路：chat-l1-smoke 同型隔离 hub+守护冒烟（run-ci.mjs:253-254），注入 fake provider 分别得 replied / failed+可行动文案（AC-R1-2/3）；不碰 live 库。
- UI 冒烟：既有浏览器驱动范式（T-082/T-087/T-088 同型脚本）：选空间入口/上传/失败重试/设置开关。
- 端到端总口径：REQUIREMENTS §6 六条照搬为验收清单。

---

## 12. 本阶段自检与本地证据

### 12.1 本阶段无代码变更、无依赖变更

本阶段（researcher）只产出本文 docs/G-mtr3su6f-1/RESEARCH.md，不改仓库实现 → 「代码纪律」（typecheck/build/test）适用对象为改行为时；本阶段无行为改动，验证主体 = 本文满足 researcher 四条验收（§12.3）。未调用 taskctl/看板写接口，未 push，未联网下依赖（§14.2）。工作区仅新增本文件（git status 中 docs/goals/G-mtr3su6f-1.md 的 M 为派工/守护产生的目标镜像快照，非本阶段改动，未触碰）。

### 12.2 本地证据（真实 file:line，本会话 read/grep 实测确认）

| 引用主题 | 证据位置（本 worktree / 本机） | 用途 |
| --- | --- | --- |
| 提示词纯文本/无工具/接口 | plugins/src/chatResponder.ts（buildChatAnswerPrompt、ChatAnswerInput、chatIdentityFor 全文） | 决策 A/D 基准 |
| 模型解析链 + 失败分支 + 预算 + CAS | plugins/src/index.ts:2391-2392（开关）、:2396-2405（模型链）、:2407-2411（foreman）、:2412（budgetMs≤120s）、:2413-2419（prompt）、:2423-2430（subagent start+agentOptions）、:2431-2437（超时）、:2439-2441（笼统失败文案）、:2443-2447（空回复）、:2455-2458（catch 吞错）、:2462-2474（sweepChatReplies 轮询）、:2495-2500（sweep 顺序） | 决策 A 主战场 |
| 空间绑定缓存（localDir/repoRoot） | plugins/src/index.ts:644-678（refreshSpaceBinding + workspaceFor） | 决策 C 内容源 |
| daemon.json 自述（model/repo/uptime） | plugins/src/index.ts:739-780（743-745 路径、746-780 内容含 model :765） | 决策 B2 |
| hub 心跳/成员在线 | team-hub/server.mjs:2163-2169（POST /api/heartbeat touchMember）、:2378-2384（online<60s） | 决策 B1 |
| 回复设置 DAO（默认开/身份/保存上限） | team-hub/server.mjs:1041-1053（getReplySettings）、:1056-1061（replyIdentityFor）、:1064-1082（saveReplySettings，systemHint≤2000） | 决策 B 输入/设置 UI |
| awaiting 队列/上下文 12 条/超龄/回写/重试/fail | team-hub/server.mjs:1084-1098（markStaleAwaiting 文案 :1094）、:1104-1130（listAwaitingReplies）、:1137-1171（postAiReply CAS）、:1173-1193（retry）、:1195-1218（fail，error≤500 :1204） | 决策 A/E 回写通道 |
| messages/conversations/chat_reply_settings 表与消息上限 | team-hub/server.mjs:281-303（表）、:305-306（索引）、:310-317（settings）、:912-916（超时/上下文 12/kind 白名单/8000 上限） | 决策 E/G 数据面现状 |
| spaces 表（仅 id/name/private/local_dir/remote_url） | team-hub/server.mjs:143-159 | 决策 C（无内容列→取数走守护 fs） |
| /api/spaces 返回字段 / /api/models | team-hub/server.mjs:2327-2345（spaces 含 localDir :2339）、:2224-2226（models） | 决策 B/C 输入 |
| postMessage awaiting 标记 | team-hub/server.mjs:984-1015（:1001-1007） | 决策 E 绑定扩展点 |
| team-hub 无文件上传端点 | 本会话 grep upload/multipart/FormData 在 server.mjs 零命中 | 决策 E 前提 |
| 文件中心 PUT 上传先例（raw body+原子改名） | workbench/scripts/serve.mjs:12-16（API 清单）、:210-285（scope 解析/路径防护）、:1227+（PUT upload 路由） | 决策 E 写纪律复用 |
| ChatView 守卫/死路/composer/三态 | workbench/src/components/ChatView.tsx:72（props）、:237-248（hubMode 守卫）、:250-261（!scope 死路卡片）、:290-320（send）、:322-341（retry）、:343-354（头部 scope）、:407-441（三态渲染+重试按钮）、:442-464（composer textarea+bar） | 决策 F 全部改动落点 |
| App scope 状态与 ChatView 挂载 | workbench/src/App.tsx:56（scope=null 默认）、:295（setScope）、:447（<ChatView scope hubMode>） | 决策 F onPickScope |
| api.ts chat 函数与回复设置（存在但 UI 零引用） | workbench/src/api.ts:540-580（conv/msg）、:597-599（retryChatReply）、:601-618（fetch/saveChatReplySettings）、:620-686（文件中心函数，filesUpload PUT Blob :672-676） | 决策 F 接线点 |
| ChatMessage 类型（无附件字段） | workbench/src/types.ts:394（ChatConversation）、:407（ChatMessage） | 决策 E/F 类型扩展点 |
| tmp-DB 测试范式 | team-hub/chat.test.mjs:3-23（TEAM_HUB_DB + mkdtemp + 动态 import server.mjs） | §11.2 数据面用例宿主 |
| chat 契约 CI 阶段 + L1/S2 冒烟 + docs 校验 | scripts/ci/run-ci.mjs:190（chat 契约）、:253-256（L1/S2 smoke）、:333-336（check-docs 阶段） | 决策 R-5 / 验证链 |
| FEATURES §3.9 现状（文档超前 UI） | docs/FEATURES.md:133-140（§3.9）、:224（F-09 已上线）、:249（排障表） | R-5 收口对象 |
| researcher 四条验收 | team-hub/stage-standards.mjs:48-64 | §12.3 对照 |
| MCP 客户端桥接已存在（本地源码） | D:\\project\\DSH\\dsh\\deepseek-harness\\packages\\mcp\\mcp-client\\README.md（外部 MCP 服务器工具注册到 ctx.tools；transport stdio/streamable-http） | §9.1 MCP 备选依据（本地可查，非仅外部声明） |
| Node 版本 / node:sqlite 可用 | 本机实测：node --version → v24.19.0；node -e require('node:sqlite') → ok | §9 沿用 node:sqlite 依据 |

### 12.3 本文验收对照（stage-standards researcher 四条）

| 验收条目 | 落点 |
| --- | --- |
| 方案覆盖需求要点，≥2 候选对比（优缺点/成本/风险） | 决策 A~G 每组 2~4 候选，均含优缺点/成本/风险（§2~§8） |
| 有明确推荐与理由，依据真实可查来源并注明引用 | 每组「推荐与依据」给本地 file:line（§12.2 全部实测）+ 外部官方锚点（§9 表，⚡未联网复核标记）+ 诚实边界声明（§14.2） |
| 新引入技术/依赖逐项说明影响（许可/维护/学习/生态） | §9 逐项表 + §9.1 结论（0 新依赖；node:sqlite/MCP 均给接入条件与锚点） |
| 结论可直接支撑后续拆解 | §11 决策→需求→文件域→AC 四列对齐 + §11.2 验证链 |

> ⚠️ 为确保「依据可查」，§12.2 全部 file:line 均在本会话用 read/grep 实测确认，未凭记忆臆断。

---

## 13. 关联文档与阅读顺序

- 上游：docs/G-mtr3su6f-1/REQUIREMENTS.md（T-119，R-1~R-5、D-1~D-8、O-1/O-2、AC 全量）。
- 本报告：docs/G-mtr3su6f-1/RESEARCH.md（T-120）。
- 下游：docs/G-mtr3su6f-1/TASK_BREAKDOWN.md（T-121）→ TEST_CASES（T-122）→ coder（T-123）→ review（T-124）→ test（T-125）→ devops（T-126）。
- 与仓库根 docs/RESEARCH.md（他目标/遗留）与 docs/G-mtpq729o-1/RESEARCH.md（他目标）无承接关系（目标级目录纪律）。

---

## 14. 待将军确认项与「未联网复核」声明

### 14.1 ⚖️ 待将军确认（沿用 REQUIREMENTS D-* 默认，本报告不新增阻塞；如将军改判下列默认值，波及范围已标）

- 决策 A：失败修复 = 隔离复现 + 分类可行动文案（A1），**不做自动重试/模型网关**。若将军想要自动重试 N 次或 fallback 模型，请明示（A2 启用，波及 S1 与 D-8 口径）。
- 决策 C：R-2 语义沿用 D-2 默认 = 空间**只读真实内容摘要注入**（C1），**不给回复方工具/自由读文件**（C2/MCP 工具面后置到 O-2）。若将军改判「要工具」，波及 S3/S4 与 R-2 边界。
- 决策 E：附件内容**落盘 uploads 目录、不入库**，保留 TTL 默认 7 天、孤儿 24h（§8.2 默认值表可整体覆写）；若将军偏好长期会话记忆/跨会话共享（改 D-3），波及 S5 与 R-3 边界。
- 决策 F：前端用**原生控件零依赖**（F1）；若将军坚持拖拽上传体验，需批准引入 react-dropzone（F2，联网下依赖，仓库纪律例外）。
- 决策 G：护栏默认值表（§8.2）为假设默认（承接 D-6），将军给更紧/更松值即改（集中在常量 + env，不动语义）。
- 运行前提口径沿用 A-1：守护在线 + 模型可解析 = 部署环境契约，本目标做「可见化 + 失败可行动化」，不承诺守护离线自愈。

### 14.2 ❓ 未联网复核声明（诚实边界）

- 本会话 web_search 因余额不足被拒（两次调用返回 "Insufficient Balance"），无法在线核实第三方库的版本/下载量/star/最近提交/具体 LICENSE 文本。
- 故本文：第三方候选只给许可证**类型**（公开稳定的一般事实）并标注「⚡需复核」；未列任何时效性数字（版本号/下载量/star/提交日期），以免虚构数据；外部锚点 = 官方仓库/官网 URL（研究者可复核的原始出处）。sqlite.org 的「大对象走文件系统」论述亦标注 ⚡未联网复核措辞（方向稳定，且本方案另有本地纪律理由：listMessages SELECT * 会拖载大 meta）。
- 建议将军验收或后续阶段如需锁定第三方数字，可在联网环境复核 §9 表；本目标采纳方案 0 运行时依赖，不依赖任何这类数字。

---

*（本文件由 T-120 方案搜索士兵产出，仅落在 docs/G-mtr3su6f-1/RESEARCH.md；未改任何仓库实现、未调用 taskctl/看板写接口、未 push。）*
