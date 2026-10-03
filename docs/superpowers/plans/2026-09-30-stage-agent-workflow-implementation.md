# Legion 跨 Agent 协作工作流设计与实施计划

日期：2026-09-30
状态：工作流编排首版已接入；真实 Claude→DSH native DeepSeek→Codex 正常链与 design finding 返工闭环均已通过（2026-10-03）；剩余扩展门槛继续验收
主设计依据（产品意图与外部能力边界）：[外部 Agent 工具接入能力与 Legion 接入方案](../../research/external-agent-tools-2026-09-30.md)。本文把该研究结论转成 Legion 的工作流模型和实施验收，不另起一套目标。
相关产品规格：[F-23 多 Harness 路由](../prt/F-23-MULTI-HARNESS-ROUTING.md)

## 当前执行状态（2026-10-03）

- **已交付的实现面**：工作流定义/DAG、节点与工具快照、阶段 Attempt/Run 持久化、版本化交接、独立测试回执、typed review 返工、人工 reconciliation 与空间内历史浏览均已接入。Hub 现拒绝已取消目标上的迟到 review 结果，返工分支会跳过无 Git checkpoint 的只读 review 节点，并使用完整的顶层 typed-review JSON 提示。
- **已验证的真实 provider 面**：DSH Claude 经 CC Switch 本地路由真实写出设计；DSH Codex 在 `respect_system_proxy` 模式返回真实只读探测响应；真实 Codex CLI 的 `gpt-5.5` 目标节点连通性已复核。DSH Claude/Codex `credentialEnv` 单测 99/99、插件 442/442、Hub pipeline 24/24、工作流组合测试 55/55、更新后的 DSH parity 38/38、DSH runtime adapter 组合 198/198 通过。单阶段冒烟和替身测试不等于跨阶段闭环。
- **真实持久化三阶段补充验收**：隔离 DSH worker/Hub 中由三个真实 Codex Stage Attempt 顺序完成设计、实现和审查；design/implementation 任务为 `done`，Codex review 明确通过后按设计停在 `in_review` 等 Legion 最终验收。实现阶段的 Legion runner receipt 绑定 provider Run、Stage Attempt 与实现提交，`node --test probe.test.mjs` 五项通过，`probe.mjs` 与 `probe.test.mjs` 已作为版本化 artifacts 交给 review。三个 worktree clean。此结果证明持久化交接和收尾路径；不代替 Claude→DSH native→Codex 首选 provider 组合。
- **真实持久化阶段现状**：P13 的 T-001 Claude design Attempt 13 已完成并冻结 Git 提交及摘要；修正相对 artifact 和 checkpoint 后，T-002 能读取冻结设计。T-002 唯一 DSH native Attempt 因隔离进程使用占位 API key 而以未知结果结束；确认无运行进程、worktree clean 后已追加 `confirmed-stopped` 对账。T-002 保持 `in_review` 且 hold，不自动重试。
- **密钥轮换后的首选链诊断记录（2026-10-02）**：用户确认已在本机轮换旧密钥。CC Switch 路由可达、三个 provider 心跳正常；连续两次 Claude design Attempt 绑定 Provider Run 后以 `unknown` 结束，安全诊断为 `invalid-external-report`。第二次提示已按 WorkerReport 契约修正，仍失败。后续 2026-10-03 的新运行中 Claude 正常完成，说明该故障不是持续性阻断；历史失败现场仍留在隔离临时目录。
- **外部报告诊断改进**：`runtime/adapters/dsh/external-agent.mjs` 对无法解析的响应仅记录结构类别、对象数、候选数及字段类别，不保存或回显响应正文。若多段 JSON 中恰有一个满足完整 WorkerReport 契约，解析器只采用该对象；无合格对象或多个合格对象仍拒绝。adapter 回归 12/12 通过。
- **真实 Claude→DSH native DeepSeek→Codex 正常链通过（2026-10-03）**：用户轮换旧密钥后，经 CC Switch 本地 Claude 路由和隔离 DSH profile 真实运行三阶段。Claude design Attempt `wfa-50386cb8-eaed-43a1-8124-f0d3f39b74da` 绑定 Run `f7013f0e-ed41-49b0-8ac4-6124b3d7d5d4` 并完成；DSH `spawn` implementation Attempt `wfa-ffd51512-b0a7-4b10-8f6a-9ac021aa9230` 绑定 Run `34250f22-5513-4bbd-9fca-90e1af0548e0` 并完成；Codex review Attempt `wfa-fd9f7191-91cc-4fdc-86bb-05d14cf8779f` 绑定 Run `6d4f1632-b3e2-4721-97a5-a4dd7a0de137` 并通过。Claude 设计摘要 `270872fd0fd8961e1ecad17e6c1b0166d508d0c8e7a1338d2eef61861d2590c2` 被下游消费；DSH 实现提交 `6daecff8980783f461e5a1780e624a0f8e1b4bce` 包含 `src/greet.mjs`、`test/greet.test.mjs`，Legion 独立 runner receipt 与实现 Attempt、provider Run、提交 SHA 绑定，Codex review 通过，最终 worktree clean。探针成功后清理隔离 fixture。本次发现并修复宿主/沙箱职责边界：DSH coder 仅实现及自测，不写共享 worktree 的 `.git` 元数据；Legion 宿主收到 `done` 报告后创建提交并执行独立测试，避免为 Git 提交扩大 DSH sandbox 写权限。真实 Legion worker 回归覆盖该规则。
- **真实 Claude design finding 返工闭环通过（2026-10-03）**：独立 DSH profile、临时 Hub 和 Git 仓库里完成两代六个真实 Attempt：Claude 首次设计 `wfa-391c4e71-0c67-4c61-b579-f6e2648676c2` / Run `04d058ea-1d77-4722-9bf3-748f9f74f06f`，DeepSeek 编码 `wfa-38d3aa34-f3ec-4df3-bc11-b17a393064bf` / Run `9dd22c5b-78d4-4ab1-a5f8-fd00cfa3d8f4`，Codex 提交 design finding `wfa-f0a1d424-56b6-4c56-808b-21f526a328a8` / Run `4ca370c9-870f-43d2-bf61-3d9dea42a724`；Claude 返工设计 `wfa-ee385bb4-821e-46f5-8574-2897f715eaef` / Run `8fdf5166-d625-4ca8-b019-67a5da7efaef`，DeepSeek 重做 `wfa-0a56847f-3ea8-4da7-9781-5cb1ba10621f` / Run `29e7667b-b241-49f8-bdb7-05664bbb6e95`，Codex 复审 `wfa-9d6729de-5986-4ef9-8f23-11e3703867fe` / Run `04fb7732-045f-4e1e-b11f-cd22de14b11c` 并通过。六个 Attempt 都绑定真实 Provider Run，第一份设计明确遗漏首尾空格语义，review 台账实际写入 `design` finding；第二份设计补充逐字保留规则。最终设计摘要 SHA-256 为 `03355df023d19592a9808cf127a658bdfd265c09d58167d16eb94caeb06d1d87`。最终实现提交 `f3e70ed08fe75514f6d0dc8de17b31a69195184b` 更新 `test/greet.test.mjs`；实现源码由首代实现继承，Legion receipt 绑定第二代 coder Attempt、Run 和最终 source commit，独立测试通过，Codex 复审通过，worktree clean。真实复跑同时发现设计返工的上游祖先仍包含旧 generation 同路径摘要，导致新实现测试或复审被旧 SHA 阻断；Hub 现在只淘汰被同路径后代阶段替换的祖先文件产物，同级分支产物仍保留。`team-hub/pipeline.test.mjs` 验证新设计及新测试摘要覆盖旧版，同时保留尚未替换的旧测试作为实现阶段输入；24/24 通过。复跑还发现 Claude 输出可能包含辅助 JSON；adapter 只在候选中恰有一个完整 WorkerReport 时选用，并对零个/多个结果 fail closed。真实探针 `tests/p13-fixture/real-claude-deepseek-codex.mjs` 现通过设计 finding 往返，成功后清理隔离 fixture。
- **仍未通过的门槛**：各 provider 的 Claude 取消及各认证方式专项矩阵仍待验收；跨机器节点与 workspace 同步仍属后续扩展。真实 Claude design finding 返工、implementation finding 返工、Codex worker 取消、未知结果隔离与人工 reconciliation 均已有真实 DSH 路径证据。实际正常链只记录必要的 Attempt/Run ID、摘要、提交和验收结果，不读取、输出或记录密钥值。
- **目标节点代理检查**：本机 Windows 系统代理 `127.0.0.1:7897` 可达，进程代理变量未设置；DSH Codex 只读请求成功。Workbench 按执行节点展示代理模式：`system` 标记为已配置并注明 `respect_system_proxy` 仍在开发中、需本节点实测；`inherit` 明确说明未强制系统代理但仍可能沿用 Codex 原生/进程代理；未知模式提示无法判断。网络实测只覆盖该节点和本次模型/登录配置。`workbench/scripts/agent-workflow-view.test.mjs` 的三种显示状态断言与 Workbench build 已通过。

## 目标

在 Legion 的现有任务与运行事实源上定义并实现一条可恢复、可审计的跨 Agent 协作工作流：Claude Code 设计，DeepSeek Harness 编码和测试，Codex 审查。Codex 报告实现问题时回到 DSH；报告设计问题时回到 Claude Code；修订后重新实现、复审，直至独立验证通过或进入明确的待处理状态。

本计划先定义产品工作流，再记录实现工作；不更改全局 PRT 排期，也不声称文档里的示例配置已经是产品 API。产品运行数据继续保存在 team-hub 的任务、Attempt、Run、事件与审计中。

本计划以研究文档中的接力闭环为首要设计基线：Claude Code 设计 → DeepSeek Harness 编码和测试 → Codex 审查。节点、provider、ACP/SDK/CLI、模型档案和通用 DAG 都是实现这条闭环或扩展后续流程的机制，不改变首要产品意图；验收首先看交接物是否带版本并被下一阶段实际消费，以及 review finding 是否按类型回到正确阶段。

认证验收兼容 Claude Code 与 Codex 的原生 OAuth 登录和 API 凭证/自定义 endpoint 配置。工作流定义和 Attempt 仅保存认证方式及本机凭证引用，不保存密钥值；DSH provider 在执行节点解析 credential reference，并只向对应子进程注入所需变量。开发阶段的真实执行使用本机临时 Git 仓库及独立 DSH profile；Docker 可作为额外隔离选项，不是验收前置条件。

## 产品行为基线

Legion 的核心能力是让不同 Agent 工具围绕同一目标接力交付、审查与返工。首个标准场景是：

```text
用户目标
  → Claude Code 产出有版本的设计与验收约定
  → DeepSeek Harness 消费该设计，编码并运行测试
  → Codex 对照同一设计、代码版本和测试证据进行审查
       ├─ 通过：进入 Legion 的独立验证与验收
       ├─ 实现问题：回到 DeepSeek Harness 修复、重测，再交 Codex 复审
       └─ 设计问题：回到 Claude Code 修订设计，再由 DeepSeek Harness 重做并交 Codex 复审
```

每次交接必须指向可核验的产物版本：设计阶段交出设计文件及摘要；实现阶段交出代码提交和测试证据；审查阶段记录它实际检查的设计与代码版本。Legion 保存工作流定义和运行事实，负责按审查类别路由返工，并限制循环次数。节点说明 Agent 在哪里运行，Agent 工具配置说明调用哪个产品及其版本，模型配置说明该产品使用哪个模型；这些身份不可互相替代。

该三阶段链是产品意图的标准示例。工作流阶段独立于普通空间流水线的相邻关系，岗位、工具和节点分别配置；后续可增加其他阶段或拓扑，但都要遵守“明确输入版本、明确输出契约、可追踪交接与返工”的规则。首版依靠显式交接物即可成立，会话续接作为后续增强能力。

## 当前事实与边界

- Agent 工具、岗位和底层模型是不同配置。一个阶段选择的是编码 Agent 工具，不是把模型 API provider 当作工具。
- DSH 有 Codex、Claude Code 和 ACP provider；已核实的原生产品 provider 是一次性调用，不应假设有会话续接或跨进程权限继承。
- Legion 已将带版本的 Agent 工具配置接入空间阶段，并在 runtime Attempt 与守护任务认领时冻结选择。真实 DSH Claude 与 Codex 单阶段执行已验证；真实 DSH worker 的 Codex 三阶段正常路径（design/implement/review）与 implementation finding 返工也已通过。首选 Claude→DSH native→Codex 链和真实 design finding 返工仍未验证，详见执行清单及后续验收记录。
- 现有配置和运行入口仍有部分实现依赖空间 `space_stages` 与 roster 顺序；这属于迁移兼容现状，不是目标设计要求。
- 现有 DSH worker 依赖 `WORKER_SCHEMA`、本地 Agent 与工具拦截，不能把那些必需参数原样传给进程外 provider。
- 研究文档中的远程节点、MCP 云桥、长期会话和统一人工审批转交属于后续方向，不是首个闭环的假定前提。
- 目标工作目录必须是该 Attempt 的 Legion workspace；不能默认外部 provider 所看到的父会话 cwd 就等于隔离后的 workspace。
- provider 不支持某项必需能力、权限策略无法证明生效、任务结果未知时要具名拒绝或保留待对账状态，不得静默换工具或重复派发。

## 设计原则：接入工具，编排协作

这项产品不是一个“给任务选 Claude/Codex”的路由开关，而是 Legion 管理的跨 Agent 工作流。Agent Network 证明节点可以承载不同 runtime 并接收任务；DSH 已提供 Claude Code、Codex 和 ACP 的真实调用 provider；Grok Bot 周边桥接项目展示了远程触发、异步 job、续接查询和回执关联等接入模式。它们提供可借鉴的执行能力，不取代 Legion 的工作流状态与审计，也不意味着各 Agent 之间天然共享会话。

按以下对象组织实现：

| 对象 | 职责 | 必须冻结或核验的事实 |
|---|---|---|
| Workflow definition | 定义阶段图、成功路径、输入/输出交接契约、审查类别路由和返工上限 | `scope/id/version` 不可变；成功路径无环；引用的阶段、工具及路由均有效 |
| Workflow instance | 某个用户目标的一次具体工作流运行，是定义的冻结实例 | 固定所用定义版本、阶段工具/节点快照和当前状态；重启后可恢复 |
| Agent tool config | 描述调用 Claude Code、Codex、DSH 内部 Agent 或 ACP Agent 的产品/协议及配置版本 | provider 注册名、能力、权限模式、认证就绪与运行组件不能互相推断 |
| Execution node | Agent 实际运行的本机或远程位置/runtime adapter | 节点身份、空间归属、健康/能力、workspace 映射和产物传输条件 |
| Stage attempt and handoff | 单次阶段调用及它交给下游的版本化产物 | 实际工具、节点、输入产物摘要、Run/会话关联、终态与输出证据 |

Legion 是定义、实例、阶段流转、返工决定和审计的权威方。执行节点只运行阶段任务并回报结果。首版以显式产物交接实现连续协作：Claude Code 交付设计包，DSH 消费该版本并交付代码提交及测试证据，Codex 对这些确切版本审查。实现问题回 DSH；设计问题回 Claude Code，随后必须重新实现和审查。共享 thread/session 是可选优化，不是闭环成立的前提。

Agent 能力按具体适配器声明。一次性 provider 可通过完整交接包参与多阶段协作；可恢复会话、流式事件、原生结构化输出、工具过滤、权限审批转交、跨机 workspace 同步等能力须逐项探测与验证。Agent 不支持必需的权限或隔离能力时，Legion 必须阻止派工；不能通过删除参数、假定父进程策略生效或静默换 provider 来兼容。

远程 connector 可以把异步任务送到用户机器上的 Agent，并以稳定 job/session 标识查询或取消；未知提交结果需要先对账，不能直接重复提交。这是节点与 adapter 的执行协议，不改变阶段产物版本、typed review 路由和工作流快照的要求。

## 目标模型：工作流、节点与执行

跨 Agent 工作流是独立的编排定义，不是空间普通岗位流水线的别名。工作流定义阶段 DAG、交接边、产物契约、返工路由和上限；阶段再绑定到一个 Agent 工具配置及允许运行的节点。阶段可调用外部产品或 DSH 托管执行器。节点代表实际可调用的运行位置或 adapter 实例，拥有机器、runtime、能力、健康状态和认证就绪信息；Agent 工具配置描述调用哪一种产品及其版本化启动参数；底层模型是该产品内部使用的模型选择。三者分开记录。

首个标准模板明确为 `design → implement → review`：Claude Code 输出带版本的设计包，交接给 DeepSeek Harness 实现并测试，再将同一方案版本、代码提交和测试证据交给 Codex 审查。岗位表达职责；各阶段分别选择 Agent 工具与执行节点，不要求角色在传统空间流水线中相邻，也不得通过改写空间普通阶段来创建闭环。命名定义现在可按成功路径 DAG 实例化，stage ID 支持同一岗位承担多个阶段，独立实例快照、状态和空间内浏览已接入。

Legion 是工作流状态、阶段流转、交接校验、返工决策和审计的权威方。Agent Network 一类节点生命周期可借鉴机器绑定、runtime、在线状态和回执核对；MCP 可作为协作入口；DSH provider、ACP、SDK、app-server 或 CLI 是具体调用方式。它们不能各自形成第二份任务状态事实源。

执行路径为：工作流实例创建并冻结定义 → 阶段运行前解析并冻结工具配置、节点和 workspace → 调用 Agent → 收集版本化交付物与终态 → 校验交接契约 → 由 Legion 决定推进、返工或等待人工处理。执行节点不健康、能力不足或权限条件未满足时，不得静默换节点或换工具。

## 阶段工作流和持久事实

| 阶段 | 工具示例 | 交付与消费关系 |
|---|---|---|
| design | Claude Code | 产出带版本与摘要的方案、接口、验收标准；implement 明确消费该版本 |
| implement | DeepSeek Harness | 消费指定方案版本，产出代码提交/diff、测试命令与结果；review 明确审查这些版本 |
| review | Codex | 产出通过状态或有类型的问题；问题路由回 design 或 implement |

工作流启动时冻结阶段定义、交接边、返工规则及其工具配置版本；每个实际 Attempt 再冻结节点/机器、选择来源、模型配置版本（若支持）、workspace、权限结论、所消费的上游产物版本，以及自身 Run 和结果。默认规则或节点健康变化不改写已产生的工作流与 Attempt。会话 ID 仅在 provider 确实提供并验证续接时记录为可续接身份。

审查结果分为通过、实现问题、设计问题和需澄清。混合问题先退回设计，随后必须重新实现并审查；类型缺失或不受支持的问题进入需澄清。复审轮数按整条工作流累计，超过配置上限后停止推进并保留审查证据。

## 实施阶段

### A. 工作流定义与阶段图纯契约

交付独立纯模块，验证可复用工作流的阶段 DAG、入口/终点、每阶段工具与产物契约、审查类别路由和返工轮数。成功路径必须无环且所有阶段可达；返工边单独建模，允许审查后回到先前阶段。非法图、悬空配置引用、未知审查类型和超限返工返回具名结果。纯契约与定义 API 不代表已经按该图派发 Agent。

**验收**：相同输入得到确定结果；定义按 `scope/id/version` 不可变保存；阶段配置引用在注册时解析到已启用的 Agent 工具配置；review 的每种合法结果都有明确的完成、返工或澄清去向。

### B. 工具能力与调用适配

为每种 Agent 工具建立能力和权限说明，映射 Legion 产品名到 DSH 实际 provider 名与安装来源。新增外部任务执行分支，只提交完整自包含的文本任务；启动前检查 runtime、provider、认证、工作目录和原生权限能力。为进程外执行明确创建与销毁隔离工作目录，收集终态、最终答复、产物及已知的用量信息。

**验收**：替身 provider 验证参数与错误映射；真实运行分别确认 Codex 与 Claude Code 在 OAuth 和 API 凭证配置下的加载、认证、工作目录读写、取消清理；能力不足时不启动任务。真实运行必须使用专用临时仓库及独立 profile，保留版本、thread/run 标识与 diff 证据。使用本机隔离目录/profile；Docker 不作为前置条件。

### C. 独立工作流定义、team-hub 持久化与 Attempt 冻结

复用 team-hub 的任务、Attempt、Run、事件与审计作为持久事实源，但为跨 Agent 流程保存独立版本化 workflow definition/instance；不再把 `space_stages` 的线性链或 roster 顺序当作其定义。每阶段配置带版本的 Agent 工具引用、可选模型配置引用、节点选择约束和输入/输出契约。发布或启动工作流时校验阶段图、配置引用和能力；首次派工冻结定义与配置，后续变更只影响新工作流。既有普通空间任务继续遵循原流水线和显式默认 DSH 兼容语义。

**验收**：工作流可在不重排空间流水线的情况下选定 design/implement/review 角色并冻结拓扑；建任务与认领之间修改默认规则，不改变已冻结工作流；每次重试有新的 Attempt 和真实选中的工具/节点配置；未知工具或悬空引用在派工前拒绝。

### D. 阶段派工与版本化交接

在 team-hub 任务推进/交接路径中绑定 workflow instance、stage 和上下游 Task/Attempt。交接边按冻结工作流拓扑推进，不从可变的普通空间流水线推导。交接包引用设计版本、代码版本、测试证据与审查意见，校验引用可读且摘要匹配。重复推进幂等；进程重启可从 team-hub 事实恢复当前阶段。

**验收**：design → implement → review 使用同一工作区代码历史和指定方案版本；缺少设计产物、代码版本改变或关联错位都不能进入 review。

### E. 审查回流、验证与用户呈现

解析并校验 Codex 审查结果，按设计/实现/需澄清进行阶段回流；每轮生成新的执行与证据，不改写旧结果。通过后仍执行 Legion 独立验证和既有人工闸门。运行面展示当前工具、阶段、被消费的版本、审查与返工历史、失败/未知/取消状态。

**验收**：注入实现问题返回 DSH，设计问题返回 Claude，混合问题修订设计后重跑实现；无限重试被预算/轮数限制；超时与取消不会把未确认的副作用当成未发生。

## 开发顺序和当前进度

实现已覆盖 A 阶段工作流契约、C 阶段独立定义与快照、D 阶段 DAG 派工和版本化交接，以及 E 阶段 typed review 回流、运行历史和人工核对。B 阶段外部 provider adapter 与真实 DSH 宿主装载已接入；真实 DSH Codex 取消链路和首选 Claude→DSH native→Codex 正常链均已验证。剩余产品验收重点是 Claude design finding 返工、Claude 取消与逐 provider 权限/认证专项验证；跨机器工作区属于后续扩展。替身测试、配置装配和宿主能力心跳不记作真实 Agent 调用。

| 阶段 | 状态 | 当前证据 |
|---|---|---|
| A 工作流定义与阶段图契约 | 已交付首版 | `runtime/contracts/agent-workflow-definition.mjs` 覆盖命名定义、阶段 DAG、入口/终点、工具和产物契约、返工路由；目标创建将定义实例化成拓扑任务图。Hub 与 worker 按 stage ID 处理多前驱、同岗位多阶段及输入/输出产物契约；typed review 使用 design/implementation 类别返工 |
| B 工具能力与调用适配 | 进行中 | `runtime/adapters/dsh/external-agent.mjs` 已接到守护 worker 的外部一次性分支；外部只收到文本任务，不传 schema/toolFilter；严格解析 `WorkerReport`，不合约结果不算成功。要求独立 worktree、cwd 与父会话一致、配置显式声明工作区/权限档；integration 模式因外部 provider 不提供 `localAgent` 而拒绝派工。DSH Codex/Claude provider 现将实例解析后的 `permissionMode` 暴露在只读 provider descriptor；worker 心跳记录该值，Hub 在工作流冻结/认领和 worker 启动前将其与版本化权限档逐项比对。Codex 的 `codex-workspace-write` 固定映射 DSH `approve-for-me`（workspace-write sandbox）；Claude 的 `claude-code-acceptEdits` 固定映射 `acceptEdits`，允许设计文件编辑，而 `dontAsk` 会拒绝未获授权操作。Claude 工具策略不构成 OS 文件系统沙箱。未知、缺失、危险或不匹配的档位 fail-closed。descriptor 与启动请求共用解析配置，不等于真实模型运行时/文件系统强制效果证明。2026-10-01 复核本机 `desktop`、`headless`、`web` DSH profile 均未声明 Codex/Claude provider bundle，且没有运行中的 DSH 进程；全局 DSH 命令缺失，但源码 CLI 入口可用。另在独立临时 `DSH_HOME` 安装 `dsh-headless`、Codex 和 Claude Code bundle，确认包清单与 `--dump-config` 中的 provider 注册行；`--help` 在 DSH 挂载前退出，所以仅证明配置组合，不证明 daemon 挂载、认证或实际调用。worker 已将 Hub 目标取消读取为 provider AbortSignal；真实 DSH Codex worker 取消已证明在办阶段任务按规则保留为 `in_progress + hold`，provider 返回明确取消终态后 Attempt 记为 canceled。Claude 取消、认证、读写和原生权限效果仍未验证。Codex CLI 的 ChatGPT 登录态不等于 DSH provider 认证成功 |
| C 独立定义、实例与 Attempt 冻结 | 命名定义、DAG 实例、状态快照、目录与生命周期控制已接入 | `/api/agent-workflows/definitions` 与 `agent_workflow_definitions` 按 `scope/id/version` 保存不可变定义，注册时核验 Agent 工具版本；Workbench 可编辑阶段、岗位、工具类型及具体配置版本、节点、输入/输出产物、成功路径依赖边、审查阶段/返工目标，并从已发布定义载入后发布新的不可变版本；目标弹窗选择定义。目标创建把拓扑、输入/输出契约、阶段工具/节点快照冻结进任务、TeamPlan 和 `agent_workflow_instances`；实例状态随目标暂停、恢复、完成或取消更新。模型档案在目标创建时校验当前版本并冻结安全的 provider/model/reasoning 字段；空间设置可按状态/关键词浏览实例、分页、展开阶段/审查历史，并复用目标生命周期暂停/恢复/取消；新增所选 provider 与指定/自动节点就绪心跳的对照提示，区分 provider 已注册和账号已认证。没有单独编辑或删除已创建实例/冻结定义的操作。未选择定义时沿用空间 runtime 固定策略 |
| D 阶段派工与版本化交接 | 命名 DAG 多前驱派工已接入；真实 Codex 和首选 Claude→DSH native→Codex 正常三阶段链均已验证 | 目标按拓扑序创建任务，`blockedBy` 保存所有入边；汇合任务等全部前驱完成。同岗位多个阶段以 `workflowStageId` 区分工具选择和上下文。worker 按冻结 stage ID 读取契约，把所有上游分支产物交给下游，并校验申报的输入/输出产物；设计 SHA-256、实现提交和测试证据仍按原规则验证。首选链真实运行绑定 design digest、三个 Stage Attempt/Provider Run、宿主提交、Legion 独立测试 receipt、Codex review 与 clean worktree。远程节点 workspace 交接不属于首个闭环，仍未验证 |
| E 审查回流、验证与呈现 | Hub typed review、独立测试回执和历史 UI 已接入；implementation finding 真实返工和首选链正常 review 通过；design finding 真实返工待验收 | `POST /api/agent-workflow/review` 校验 typed findings；设计/实现路由、混合问题设计优先、幂等返工、累计轮数上限与审查台账已接入。设计问题会创建新设计任务及其下游新一代 DAG，重新实现、重跑验证分支并创建新审查；只复用未受影响且已完成的上游阶段，旧阶段与证据不被改写。worker 对澄清/超限结果停在 `in_review`，通过结论仍进入既有完成和独立验证路径。`agent_workflow_stage_attempts` 在调用前创建带幂等键的专属阶段 Attempt，provider 启动后立即保存 Run ID；完成时保存 Agent 报告和 Legion 独立测试回执。Hub 重启隔离会把未终结 Attempt 标记为 `unknown` 并保留 Run ID。工作流历史 API 和任务详情显示阶段调用及独立测试摘要。真实 Codex 的 implementation finding 返回新 Attempt/receipt 并由新 review 通过；目标取消、unknown 隔离和人工对账已有真实 Codex 验收。无 Hub 的本地 taskctl 不支持按 ID 排除工作流阶段，存在在办工作流时会跳过批量释放并保留现场供人工核对。`GET /api/agent-workflow/history` 汇总实例任务、Stage Attempt 和审查台账；`GET /api/agent-workflow/instances?scope=` 按空间列出实例，Workbench 空间设置可浏览并展开阶段/审查返工历史。独立 runner receipt 绑定提交 SHA、Stage Attempt、provider Run、节点、argv、退出状态和输出摘要；Hub 在持久化和 review context 两处核验冻结 runner 与 Attempt 结果 |
| 执行节点（本机 DSH worker） | 首版登记与绑定已接入 | `/api/agent-nodes/configs` 保存稳定节点 ID，`/api/agent-nodes/heartbeat` 报告在线状态、实际 DSH provider 与能力；Workbench 可登记节点、选择阶段节点。目标创建冻结节点身份/版本，认领验证在线状态、provider 能力和节点匹配；工作流要求三个阶段使用同一节点或全自动选择，自动选择后续阶段继承上游节点，防止无 workspace/Git 同步时跨机器交接。远程 workspace 传输、节点认证与多机联调尚未完成 |

## 尚未达到设计目标与完整产品闭环的部分

### 首个标准闭环完成前的必过门槛

- 独立测试验证首版已实现：执行命令从不可变定义冻结的 executable/argv/timeout 读取；runner 限制可执行文件和参数字符集、不经 shell 启动、过滤父环境变量、限制输出、设置超时并终止进程树。Windows 上 `npm` 通过 Node 直接启动 `npm-cli.js`，`pnpm`/`yarn` shim 因依赖 shell 而拒绝执行。完成回执绑定实现提交 SHA、Stage Attempt、provider Run、执行节点、实际 argv、退出状态、时间和输出摘要；提交变化、工作树被测试修改、非零退出或超时均不能通过 review gate。独立超时子进程与 Windows npm 无 shell 回归已通过。工作树及环境过滤不是 OS 沙箱，测试代码仍继承 worker 账户的文件和网络权限；开发验收使用专用临时 Git 仓库和独立 DSH profile，不要求 Docker 或可丢弃 OS 用户；需要更强文件系统隔离时再选择容器/独立 OS 用户，并继续检查真实 DSH runner 依赖和敏感输出脱敏覆盖面。
- 真实产品闭环：正常路径已在专用临时仓库和隔离 DSH profile 中完成 Claude Code 设计、DSH native DeepSeek 编码/Agent 自测、Legion 宿主提交与独立测试、Codex 审查，所有阶段绑定真实 Attempt/Run。已真实完成的实现问题返工仍保留；真实设计问题返工及 Claude 取消尚待验证。替身 provider 和真实宿主装载夹具不能替代设计返工门槛。DSH `SubagentProvider` descriptor 已公开 Claude/Codex 实例解析后的 `permissionMode`，Legion 会将其与冻结档位精确比对；首选正常链三个 provider 均真实运行。按用户要求，验收使用本机隔离 DSH profile 和临时 Git 工作区；Docker 或可丢弃 OS 用户不是前置条件。

### 后续扩展，不阻挡首个标准闭环

- 跨机器节点认证、租约、workspace/Git 同步与故障迁移；原生 session/thread 持续会话；slice 目标与通用 DAG 的组合。首个闭环限定在同一执行节点与可显式交接的版本化产物。

- 已新增可复用、按 `scope/id/version` 不可变保存的工作流定义与 DAG 派工。Workbench DAG 编辑器可配置阶段、岗位、工具类型及具体配置版本、节点、输入/输出产物契约、成功路径依赖边与审查返工路由；可载入既有版本并据此发布新版本。工作流实例有独立持久记录，并可按空间筛选、分页浏览、打开阶段与返工历史；可暂停、恢复或取消所属目标，取消沿用既有在办任务留痕流程。当前没有对已创建实例快照的直接编辑/删除操作。目标创建冻结独立实例、图拓扑、阶段工具/节点与输入/输出产物契约；多前驱任务会等所有依赖完成，stage ID 可区分同岗位多个阶段。设计类 review finding 会重建其全部下游阶段批次，使并行实现/验证分支重新汇合到新审查。
- slice 目标编排与该闭环暂不组合；服务端会在事务内明确拒绝，避免悄悄回退到普通空间阶段链。后续需要定义实现阶段如何展开切片、测试岗位如何汇总回 review。
- 当前节点实现限定于运行 Legion worker 的本机 DSH 实例；还需增加节点认证、租约和健康探测的抗伪造能力、跨机器仓库/产物同步与故障迁移，才能支持真正远程节点。已把节点、Agent 产品/工具、底层模型分开建模，尚未支持原生 session/thread 持续会话。
- 隔离临时仓库中的真实 DSH Codex 正常三阶段链、implementation finding 返工、目标取消、未知结果隔离与人工对账均已验收；design finding 返工和首选 Claude→DSH native→Codex 组合仍未验收，Claude 取消亦未覆盖。真实 DSH Claude 经 CC Switch 路由完成过单阶段设计写入；Codex `gpt-5.5` 在当前 ChatGPT 登录及 `systemProxyMode: system` 下的只读执行、读写阶段和审查均有实测记录。上述证据不证明 DSH native API-key 阶段、各 provider 的完整权限效果或跨进程状态查询/续接接口。
- `unknown` Attempt 保留 Run ID、工作区并显示为“结果未知，待核对”，worker 不会自动重派。现有 Hub reconciliation API 仅允许 `general` 为未知 Attempt 追加 `confirmed-stopped`、`still-running` 或 `unable-to-confirm` 结论及必填依据；审计事件幂等、按工作流历史回读。Workbench 详情可填写并查看记录。核对操作不改写 Attempt 终态、不变更任务状态、不释放工作区、不自动重派；之后是否人工推进仍走独立任务生命周期操作。操作记录说明谁在何时作出何种判断，不构成 provider 终态的独立技术证明。
- 在隔离临时仓库中使用真实 Claude Code 与 Codex 配置完成加载、认证、权限、读写和清理验证，再跑通整条工作流；DSH Claude 单阶段写入和 Codex 单阶段/工作流运行已有证据，Codex 取消及未知结果/重启对账已覆盖，Claude 原生权限效果及取消仍待验收。
- 外部 Agent adapter 使用 `policyPreflightPassed` 表示调用方已核验工作区绑定、冻结权限档和 provider 能力；DSH provider API 没有暴露独立的认证/权限探测口，因此该标记不代表账户已认证或宿主策略已生效。真实认证只能由启动/执行结果确认。必须完成真实临时仓库运行并核对最终 diff/取消结果；不可把 CLI 登录状态外推为 DSH 子 Agent 成功。
- `modelConfig` 已在目标创建时解析并冻结已登记档案的当前版本及 provider/model/reasoning 字段；仅 `dsh-native` 可用，且 DSH 实际 provider 必须声明 `agentOptions` 能力，worker 才会注入覆盖。Claude Code/Codex 等外部工具沿用其原生模型设置，不接收模型覆盖；档案凭证不会传给子 Agent。模型档案变更后，旧工作流继续使用冻结值，新目标引用旧版本则拒绝创建。真实 Codex `gpt-5.5` 和 Claude CC Switch 路由的单阶段执行已验证；2026-10-02 DSH native `deepseek-v4-flash` 通过本机 `DEEPSEEK_API_KEY` 引用成功返回固定验收标记，但其 Legion 阶段执行仍待验证。
- 本轮 `node --test team-hub/pipeline.test.mjs` 的 24 项通过，覆盖非相邻岗位仍独立建链、普通阶段工具配置不被改写、目标 TeamPlan/任务快照冻结工具版本、常规岗位链删掉工作流阶段后动态任务仍继承快照，以及 HTTP 路径串联设计产物 → 实现与测试证据 → review → DSH 返工任务；插件完整测试 428 项和 TypeScript 检查通过，覆盖冻结阶段在岗位被移除后的队列认领/续做。这些验证不构成真实 provider 验证。
- 本轮回归：`node --test runtime/contracts/agent-workflow-definition.test.mjs team-hub/routes/harness.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs` 共 51 项通过，覆盖分支建链、多前驱汇合阻塞、同岗位 stage 工具区分、typed review stage-ID 回流、设计返工后下游实现/测试分支重跑与新审查、实例暂停/恢复与重启恢复；`npm test --prefix plugins` 428 项通过，`npm run build --prefix team-hub` 和插件 TypeScript 构建通过。以上替身与持久化验证不能代替真实 Claude/Codex 认证与执行验证。
- 工作流实例浏览与维护验证（早期回归记录）：`node --test team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/goal.test.mjs` 共 42 项通过，覆盖空间过滤、状态/关键词筛选、分页边界、实例到目标/定义/阶段计数关联、可回读历史锚点、暂停/恢复/取消同步与重启恢复；Team Hub 和 Workbench 构建成功。此后真实 Codex provider 路径、未知结果重启对账均已完成，见本计划当前状态和后续实跑记录。Workbench 仍报告既有大 bundle warning；已创建实例快照的直接编辑/删除操作仍未提供。
- Codex CLI 只读复审发现并促成修复三个实例浏览缺陷：乱序响应覆盖、重新加载忽略当前筛选条件、`in_progress` 未计入 `doing`。前两项以请求序号丢弃过期响应、加载时沿用筛选条件修正；第三项有实例列表回归断言。修复后上述 42 项回归通过，Workbench/Team Hub 构建通过。该 Codex CLI 只读复审验证的是代码审查阶段的工具调用，不能替代尚未跑通的 Claude Code → DSH → Codex 实际 provider 闭环。
- DSH provider 配置复核：Codex/Claude bundle 必须安装到运行 Legion worker 的 DSH profile 并重启；Legion 直接调用 `ctx.subagents.start()`，无需向模型开放 `dsh-tool-subagent` preset 行。bundle 不负责登录且不回退宿主 CLI。2026-10-01 本机 `desktop`、`headless`、`web` profile 均未声明两个 bundle，且无运行中 DSH 进程；空间设置现会对照所选 provider 和就绪节点心跳提示缺少注册，但心跳不等于认证或权限验证。工作流相关构建和 24 项节点/路由测试通过；真实 provider 调用仍需完成。
- 实例筛选/分页实现后，`node --test team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs` 27 项通过，分页查询有 `(scope, created_at_ms, id)` 与 `(scope, status, created_at_ms, id)` 索引；`runtime/adapters/dsh/external-agent.test.mjs` 与工作流回归合跑 37 项通过。`npm test --prefix plugins` 428 项通过；Team Hub/Workbench 构建通过。Workbench 有既存大 bundle warning。环境探测确认 Codex CLI 已登录，但没有 DSH runtime 进程且 Claude CLI 未安装；该检查不等于 DSH provider 运行验证。

## 真实 Claude Code → DSH → Codex 闭环验收门槛

本门槛只在获得真实 provider 调用授权后执行；所有 Agent 只访问专用临时 Git 仓库与独立 DSH profile，不连接 Legion 正式任务库、不改用户级 provider 配置。开始前记录 repo 初始 SHA、临时 DSH profile 与节点 ID；运行中不得输出或归档认证材料。每个阶段的配置版本、stage Attempt ID、provider Run ID（provider 未提供时明确记 null）、工作区、开始/终止状态都从 Team Hub 历史读取。

### 当前执行清单

- [x] DSH Claude provider 经 CC Switch 本地路由完成真实设计文件写入；DSH Codex provider 经 `app-server --stdio` 和系统代理完成真实只读请求。
- [x] 在本机确认 Windows 系统代理开启、Clash `127.0.0.1:7897` 可达，并在未设置进程代理变量时验证 Codex `systemProxyMode: system` 请求成功。
- [x] 在目标节点核验系统代理开启、Clash `127.0.0.1:7897` 可达且进程未设置代理环境变量；真实 DSH Codex provider 以 `systemProxyMode: system`、`gpt-5.5` 和只读权限成功返回探测串；真实 DSH worker 心跳报告 Codex 的 `systemProxyMode: system`。
- [x] 经 Legion provider 分支持久化启动 Codex Stage Attempt，并在独立 DSH profile 固定兼容模型；2026-10-02 真实三阶段实跑的三个 Codex Attempt/Run 均已在 Hub 历史核验。此项不替代下一条首选多 provider 闭环。
- [ ] 通过 Legion worker 持久化完成 Claude design → DSH implementation → Legion 独立 test receipt → Codex review 的正常闭环，并从 Hub 历史核对 Attempt/Run、配置版本、Git SHA、receipt 和 diff。
- [x] 真实运行 implementation finding 返工：首轮 review finding 触发新 implementation Attempt/Run、提交和 Legion receipt，Codex 复审通过；旧阶段记录保留。
- [ ] 真实运行 design finding 返工，检查新设计/实现 Attempt、Run、提交、receipt 与审查历史；旧证据必须保留。
- [x] 通过真实 DSH worker→Codex provider 执行目标取消；核对 Hub Stage Attempt `canceled`、provider Run 绑定、任务保持 `in_progress + hold`、隔离 worktree 干净且保留。
- [x] 对真实 Codex provider 执行未知结果和人工 reconciliation 验收；核对 app-server 子进程停止、DSH worker 重启后 Attempt 隔离、工作区保留且确认前没有自动重派。
- [ ] 分别验证 Claude/Codex 原生登录与两者各自的 DSH credential-reference API-key 注入。现有真实 provider 调用覆盖 Claude CC Switch 本地路由与 Codex ChatGPT 登录；DSH native DeepSeek 的 `DEEPSEEK_API_KEY` 引用和真实请求已单独通过，但不等价于 Claude/Codex 两个工具的 API-key 注入验收。

| 场景 | 必须发生的阶段序列 | 通过条件与保留证据 |
|---|---|---|
| 正常交付 | Claude Code 设计 → DSH 实现/测试 → Codex 审查 → Legion 独立验收 | 设计文件及 SHA-256 在实现工作树中一致；DSH 提交 SHA 可在审查工作树验证为祖先；独立测试 receipt 绑定该提交、实现 Attempt、provider Run 与冻结 argv，Codex 收到 receipt 和测试输出摘要；Agent 全程只写各自隔离工作树 |
| 实现问题返工 | Claude Code 设计 → DSH 实现/测试 → Codex 提出 implementation finding → 新 DSH Attempt 修复/重测 → 新 Codex Attempt 复审 | 返工使用冻结的 DSH 工具配置和原设计版本；新实现提交与测试回执不覆盖旧记录；审查 finding、返工任务、provider Attempt/Run 和独立 test run 可从工作流历史关联 |
| 设计问题返工 | Claude Code 设计 → DSH 实现/测试 → Codex 提出 design finding → 新 Claude Attempt 修订 → 新 DSH Attempt 重做/重测 → 新 Codex Attempt 复审 | 新设计摘要与旧版不同；旧实现和审查证据保留；所有受影响的下游阶段消费新设计版本并重新执行，不能复用旧实现结果；新提交必须生成新测试回执 |
| 取消与未知结果 | 任一外部阶段运行中取消，另对 provider 无终态/超时情形核验 | 只有收到 provider 取消终态才记录 canceled；超时或结果未知时保留工作区和 Run ID、任务进入人工核对，期间不自动重派 |

最终归档仅保存非敏感的配置版本、临时仓库 SHAs/diff、产物摘要、provider Attempt/Run 记录、审查结果和清理结果。任何阶段无法认证、无 Run 回执、越权修改、证据无法匹配、静默更换 Agent、未确认取消或返工路由错误，都判为未通过，并记录确切停留阶段与原因；替身测试、宿主 provider 心跳或 CLI 登录状态不能替代真实 provider 门槛。用户已授权在本机临时仓库和独立 DSH profile 中继续真实验收，Docker/可丢弃 OS 用户不是前置条件。后续 P13 已取得 Claude design Attempt 13 的持久化完成记录，以及 T-002 DSH coding Attempt/Run 失败与停止对账记录；之后另完成 Codex provider 三阶段正常路径、implementation finding 返工、取消和未知结果人工对账。当前仍未完成首选 Claude→DSH native→Codex 持久化闭环、design finding 返工、DSH native 有效 API-key 执行与 Claude 原生权限/取消验收；具体状态以“当前执行清单”未勾选项为准。

2026-10-01 只读预检复核：当前没有运行中的 DSH 进程；用户级 `desktop`、`headless`、`web` profile 均未安装 Codex/Claude 子 Agent bundle；PATH 可用 Codex CLI，但没有全局 DSH 或 Claude CLI。此结果与前次环境调查一致，不代表 DSH 源码入口下的 provider 无法运行，也不代表 Codex CLI 登录态可供 DSH provider 使用。启动验收前仍需在隔离 DSH profile 装配并启动 Legion worker，再确认真实 provider 身份验证；本次没有读取认证状态或启动模型任务。

### 2026-10-01 Claude CLI 与 DSH 隔离宿主复核

按用户反馈重新核验：本机 Claude Code CLI 为 2.1.286，`claude auth status` 返回 `loggedIn: true`、`authMethod: oauth_token`、`apiProvider: firstParty`；`claude doctor` 同时报告自定义 `ANTHROPIC_BASE_URL`，所以真实 provider 请求最终使用的端点与认证兼容性仍须由 DSH 子 Agent 运行确认。用户配置仅检查存在性，不读取认证材料。真实 DSH 宿主注入测试重新执行，14 项全部通过；该测试在独立临时 DSH profile 装载 Claude/Codex bundle，节点心跳实际读回 Claude `acceptEdits` 与 Codex `approve-for-me`，没有派发 Agent 或请求模型。Docker Desktop 已安装在用户目录，但从该可执行文件启动返回“Docker Desktop is unable to start”，daemon 不可连接；WSL 仅有已停止的 `docker-desktop` 发行版，Windows Sandbox 不存在。未在当前 Windows 用户权限下启动真实 Agent。真实认证、文件读写、取消/清理、完整正常交付和两类返工仍待可用的可丢弃 OS 用户或容器内验证。

### 2026-10-01 未知执行结果保护增量

发现并修正一条重复执行风险：worker 超时或 DSH 守护重启时，原租约回收会把 `in_progress` 工作流任务放回 `todo`，但外部 Agent 可能已产生文件或其他副作用。现在工作流阶段遇到启动结果未知、超时、非完成终态或无效报告时，会记录阶段/provider/已知 run ID，置 `hold` 并进入 `in_review` 等待人工核对；Hub 启动孤儿回收也会把带冻结 workflow 快照的任务隔离，普通任务维持原有释放语义。定时 stale 检查不会抢先回收仍可能在运行的工作流 lease。`POST /api/release-stale` 同时回传 `released` 与 `quarantined`，审计记录两类结果。

验证：`node --test team-hub/pipeline.test.mjs` 24 项通过（含 Hub 重启后将工作流孤儿隔离的回归）；本轮插件构建通过，`space-pipeline.test.mjs` 13 项、`reclamation.test.mjs` 21 项通过；随后 `npm test --prefix plugins` 全量 430 项通过。`npm run build --prefix team-hub` 通过。生命周期路由最初有一项审计字段断言未包含新增的 `agentNodeId: null`，现已按扩展后的节点审计结构修正；`node --test team-hub/task-lifecycle-routes.test.mjs` 30 项全部通过。真实 DSH provider 的实际 Run ID 返回、查询和对账仍未验证。

### 2026-10-01 Stage Attempt 与 Provider Run 持久关联

工作流 Agent 调用前，worker 先通过 `/api/agent-workflow/stage-attempts/start` 创建唯一阶段 Attempt（幂等键、任务/stage、冻结 provider/配置快照）；只有收到已持久化 Attempt ID 后才启动 provider。provider 返回运行句柄后，立刻通过 `.../report` 保存 provider Run ID；完成时保存有限结果摘要，超时/中断记录 `unknown`。Run ID 一经登记不可由其他 worker 或不同 ID 覆盖。Hub 启动孤儿隔离会将仍处于 starting/running 的阶段 Attempt 更新为 unknown，并保留 providerRunId。工作流历史将 stageAttempts 暴露给任务详情，供用户逐阶段检查工具、Attempt、Run ID、状态、摘要与失败原因。空间删除预检和级联一并纳入 workflow 定义、实例、审查与 Stage Attempt，防止新表遗留跨空间记录。

验证：`node --test team-hub/pipeline.test.mjs` 24 项通过，覆盖 start 幂等、当前 worker 身份校验、Run ID 不可覆盖、终态与未知状态约束，以及 Hub 关闭重启后完成/未知 Attempt 和 Run ID 恢复；`node --test team-hub/spaces.test.mjs` 5 项通过，验证 definition/instance/review/attempt 清理；`node --test team-hub/routes/agent-workflow.test.mjs` 4 项通过；Team Hub 构建成功；Workbench `tsc --noEmit && vite build` 成功（保留既有大 chunk 提示）。插件构建成功，相关流水线解析 13 项、工作流回收隔离 21 项通过；随后 `npm test --prefix plugins` 全量 431 项通过，其中新 worker 派工集成用例验证 Attempt 先落库、后调用 provider，provider Run ID 在读取结果前持久化，未知执行被 hold 并转 `in_review`。`node --test team-hub/task-lifecycle-routes.test.mjs` 30 项通过。2026-10-01 扩展合并回归 `node --test runtime/contracts/agent-model-selection.test.mjs runtime/contracts/agent-workflow-definition.test.mjs runtime/adapters/dsh/external-agent.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/spaces.test.mjs` 共 50 项通过。当前桌面 profile 的 package.json 未声明 Codex/Claude provider bundle，且两个 bundle 均不在 profile node_modules；系统无 `claude` 或全局 `dsh` 命令。Codex CLI 存在并显示 ChatGPT 登录态，但不等价于 DSH provider 认证/执行。尚未用真实 DSH provider 验证 Run ID 的返回、查询与取消能力。

### 2026-10-01 隔离 DSH profile 装配检查

在 Legion 仓库内新建独立 `DSH_HOME` 和 `legion-agent-validation` profile，安装 `@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code` 的 `0.2.0-rc.2` 版本。profile 包清单确认三个依赖已安装；`--dump-config` 确认 headless 配置组合包含 Codex、Claude Code 的 provider 注册行。`--help` 可运行并正常退出，但官方 headless 说明该路径在 runner 执行前结束，所以没有证明 provider 已实际挂载或可调用。未触碰用户级 DSH profile，也未调用模型。此项补足“安装/配置组合”证据；真实加载、认证、读写权限、取消、清理和端到端返工仍待真实执行验证。

### 2026-10-01 工作流取消传播

工作流阶段运行期间新增 Hub 状态轮询：发现任务进入 `canceled` 后 abort 传给 DSH 子 Agent 的信号，并等待 provider 终态。明确的 `cancelled` / `canceled` / `aborted` 终态记为 canceled，保留用户取消状态与隔离工作区，不再推进；provider 不响应至超时、拒绝返回或以其他终态结束时，Attempt 记为 unknown，保留工作区且不自动推进或重派。该处理避免把“请求取消”误报成“执行已停止”。

验证：`npm run build --prefix plugins` 成功；`node --test runtime/adapters/dsh/workflow-run.test.mjs plugins/tests/worker-regression.test.mjs` 共 16 项通过，包括 fake provider 下 Attempt/Run 持久顺序、AbortSignal 传播、明确取消终态记录，以及 provider 忽略取消时等待到超时并保留未知结果。跨 runtime/Hub/工作流/空间回归 `node --test runtime/contracts/agent-model-selection.test.mjs runtime/contracts/agent-workflow-definition.test.mjs runtime/adapters/dsh/external-agent.test.mjs runtime/adapters/dsh/workflow-run.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/spaces.test.mjs` 共 54 项通过，包含 canceled Attempt 终态重启持久化。真实 Claude/Codex 子进程取消尚未验证。

### 2026-10-01 命名工作流的 Git 检查点与 DAG 执行

端到端核对发现：每个阶段的 `w/<taskId>` worktree 相互独立，原交接只传文件路径/摘要和实现 SHA，没有保证设计文件与代码提交可在下游分支读取；独立命名 DAG 的普通成功结算也错误依赖空间流水线行为。已为命名工作流阶段增加 Git 检查点 evidence（冻结 `stageId` 与 `sourceCommit`），并在下游 Agent 启动前，按祖先拓扑顺序把所有上游检查点合并到本阶段 worktree。之后仍以摘要核验设计文件，并确认审查分支包含确切实现提交。缺少/损坏的检查点、缺失 Git 对象或合并冲突都会停止派工；冲突会尝试回滚合并并保留现场。命名工作流成功阶段按 Hub 预建的 DAG/`blockedBy` 结算，不从 legacy role-order 逻辑补建任务；人工 gate、集成模式与 Codex 通过仍进入 `in_review`，最终由 Legion 独立验证和验收。旧 `space-pipeline` 工作流不走这套新交接路径。

验证：`npm run build --prefix plugins` 成功；`node --test runtime/contracts/agent-workflow-checkpoints.test.mjs plugins/tests/handoff.test.mjs plugins/tests/worker-regression.test.mjs` 共 55 项通过，覆盖临时 Git worktree 间设计/实现提交实际可读、审查分支保留源提交祖先、提交缺失与冲突 fail-closed、独立设计阶段检查点持久化并自动完成、命名 DAG 不走旧角色顺序。跨 runtime/Hub/工作流/空间回归包含 Attempt 取消终态重启恢复；`npm test --prefix plugins` 共 434 项通过；含检查点契约的跨 runtime/Hub/工作流回归共 57 项通过；`npm run build --prefix team-hub` 成功。真实 Claude Code、DSH 和 Codex 调用及整条返工闭环仍待运行验证。

### 2026-10-01 三阶段闭环回归与 Windows 工作树修正

新增 worker 级闭环回归，按顺序调用替身 Claude Code、DSH 原生实现 provider 与 Codex，验证设计文件经过 Git 检查点进入实现 worktree，代码与测试证据进入审查 worktree，审查通过后进入 Legion 独立验收。该回归发现 Windows Git 换行转换会改变下游文本文件的检出字节，因此命名工作流文本产物摘要统一 CRLF/LF 后再计算；普通空间流水线维持原有字节摘要。它也发现只读审查不能把分支相对主线的所有变更视为 Codex 新写入，因为其中包含已冻结的设计和实现提交。现在命名 DAG 审查以 provider 启动前的 HEAD 为基线，拒绝新增提交或未提交改动；旧空间流水线继续使用原检查。

验证：三阶段 worker 闭环集成回归通过；`npm test --prefix plugins` 全量 435 项通过；跨 runtime/Hub/工作流/空间回归 57 项通过；插件构建和 Team Hub 构建通过。所有 Agent 仍为替身，未验证真实 Claude Code、DSH 与 Codex 的认证或模型执行。

### 2026-10-01 真实 DSH 宿主装载核验

运行既有真实宿主夹具时发现它仍引用 DSH 已移除的 `@deepseek-ai/dsh-agent-presets` 名称，导致 `agentPresets` 未提供、worker 等待注入服务。改为当前包名 `@deepseek-ai/dsh-agent-preset-registry`，并让夹具从当前 DSH 源码检出加载 Codex/Claude bundles 后，`node --test tests/p13-fixture/p13-host-injection.test.mjs` 14 项全部通过。真实 DSH worker 在临时 `$DSH_HOME` 与空任务库内加载，并通过 Team Hub 节点心跳报告 `codex` 与 `claude-code`，能力为不支持 `outputSchema`/`toolFilter`、声明 cancellation；节点状态为 `ready`。同一测试还验证 daemon 状态、Hub/看板 HTTP 路由和有界退出，没有派发 provider run 或发起模型请求。这证明宿主挂载与能力注册，不证明认证、权限实际生效或 Agent 执行。

能力字段回归还锁定了两个 provider 的实际 DSH 声明：`outputSchema=false`、`toolFilter=false`；worker 心跳的宿主取消字段为 `cancellation=true`（基于 run 句柄与 AbortSignal 的 best-effort，不是 provider 原生保证）。因此 Legion 的外部调用必须继续发送自包含文本并自行验证 `WorkerReport`，不能把 DSH 原生 Agent 的结构化输出/工具过滤能力假定为外部 provider 能力。

### 2026-10-01 当前工作区复核

重新运行命名工作流定义、Git 检查点、外部 provider 适配、取消传播、Hub/Attempt 持久化、worker 三阶段替身闭环及空间清理回归：`node --test runtime/contracts/agent-workflow-definition.test.mjs runtime/contracts/agent-workflow-checkpoints.test.mjs runtime/adapters/dsh/external-agent.test.mjs runtime/adapters/dsh/workflow-run.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/spaces.test.mjs plugins/tests/worker-regression.test.mjs`，68 项通过。`npm test --prefix plugins` 为 435 项通过；真实 DSH 宿主夹具 `node --test tests/p13-fixture/p13-host-injection.test.mjs` 为 14 项通过；Team Hub 构建通过。宿主夹具证明 provider bundles 已加载并上报能力，替身闭环证明版本化 Git 交接和 typed review 路由；两者都没有调用真实模型。真实 Claude Code → DSH → Codex 执行、认证/权限效果与真实返工仍未验证。
### 2026-10-01 实现阶段测试证据结构化

按闭环验收补强实现到审查的交接：命名工作流实现阶段现在要求 testReport 同时包含实际测试命令、通过摘要和测试输出摘录，失败列表为空；通用任务 evidence 不再充当测试证据。worker 将这些字段与实际 Git 提交 SHA 一起冻结，Hub 在生成 review 快照时再次校验，Workbench 任务详情与 Codex 审查上下文展示测试命令、结果和证据。缺字段或测试失败时停在 in_review，不推进至 Codex。

验证：node --test runtime/contracts/agent-workflow.test.mjs team-hub/pipeline.test.mjs 共 36 项通过，含 Hub 拒绝缺少测试命令的交接回归；node --test plugins/tests/worker-regression.test.mjs 共 14 项通过，含 Claude Code → DSH → Codex 版本化替身闭环；npm test --prefix plugins 共 435 项通过；插件、Team Hub 与 Workbench 构建通过。当前字段仍是实现 Agent 自报的命令与输出，尚无独立测试进程身份/可验证 runner attestation，也没有真实 provider 运行证据。

### 2026-10-01 阶段运行记录关联测试报告

阶段 Attempt 的结果快照现在保留有限字段的 testReport（passed、command、summary、evidence、最多 20 条 failures），文本经过共享密钥模式脱敏并限制长度；Workbench 将报告显示在同一 Attempt ID 与 provider Run ID 下。这样用户可从实际阶段调用记录追溯该实现 Agent 自报的测试证据。它仍不能证明子 Agent 确实执行了该命令；独立 runner attestation 与真实产品执行依然未完成。

验证：node --test team-hub/pipeline.test.mjs team-hub/routes/agent-workflow.test.mjs 共 28 项通过，覆盖 Hub 重启后恢复关联测试报告及输出脱敏；Team Hub 与 Workbench 构建通过。

### 2026-10-01 实现测试证据与 Stage Attempt/Run 绑定

实现阶段提交给审查的证据现在必须引用该实现任务的 Stage Attempt ID 和 provider Run ID。Hub 会确认 Attempt 属于同一任务、冻结工作流实例、实现阶段与冻结 provider，且处于 `completed`；Attempt 中已持久化的 testReport 必须通过相同规范化/脱敏校验，并与交接中的测试命令、摘要和输出摘录逐字段相同。缺失或错配时拒绝生成审查快照。Workbench 持续按 Attempt 和 Run 展示自报测试报告。此校验增强了证据关联和一致性，仍不证明 Agent 确实执行了报告中的命令；独立 runner attestation 与真实 provider 执行仍未完成。

验证：worker 级三阶段替身集成现同时覆盖审查通过、implementation finding、design finding 和混合 finding：worker 将 findings 原样提交给 Hub，由 Hub 回执决定返工类型；混合 finding 返回设计优先的路由。Hub 层另有实际创建 typed rework task 的原子性测试。`npm test --prefix plugins` 435 项通过；`node --test runtime/contracts/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/routes/agent-workflow.test.mjs` 40 项通过，包含缺失 Attempt、Run 错配、报告不一致拒绝和 Hub 重启后按 Attempt ID 恢复状态；`node --test runtime/adapters/dsh/external-agent.test.mjs runtime/adapters/dsh/workflow-run.test.mjs` 14 项通过；真实 DSH 宿主注入夹具 `node --test tests/p13-fixture/p13-host-injection.test.mjs` 14 项通过；插件构建、Team Hub 构建、Workbench `tsc --noEmit && vite build` 通过。Workbench 保留既有大 chunk 提示。之前测试中对 Attempt 顺序/数量的硬编码已改为按 ID 断言，以容纳工作流历史中已有的实现与返工 Attempt。没有发起真实 Claude Code、DSH 或 Codex 模型调用。

### 2026-10-01 未知 Stage Attempt 人工核对

为结束“保留未知状态但无法记录核对事实”的运维死角，新增 `POST /api/agent-workflow/stage-attempts/reconcile`。只有 `general` 可对 `unknown` Attempt 追加三种人工判断之一和必填核对依据，审计事件支持幂等重放并出现在工作流历史与 Workbench 阶段记录中。核对不会改写 provider Attempt 终态、任务状态、工作区占用或重派状态；人工作出的判断不被伪装成 provider 终态。空间删除继续沿用全局审计保留策略，不另建待清理的 scope 表。

验证：`node --test team-hub/pipeline.test.mjs team-hub/routes/agent-workflow.test.mjs` 28 项通过，覆盖 actor 权限、有效/无效 disposition、必填依据、幂等重放和冲突拒绝、Attempt/任务状态保持不变及历史回读；Team Hub 构建通过；Workbench `tsc --noEmit && vite build` 通过（保留既有大 chunk 提示）。未调用真实 provider。

### 2026-10-01 当前工作区计划复核

重新按本计划的关键路径执行回归：命名工作流定义、交接检查点、阶段契约、外部 DSH adapter、取消/Run 生命周期、Hub 路由/持久化/空间级清理、worker 三阶段闭环和真实 DSH 宿主装载夹具共 94 项通过；`npm test --prefix plugins` 全量 435 项通过；`npm run build --prefix team-hub` 与 `npm run build --prefix workbench` 成功。Workbench 仍有既有大 chunk 提示。研究文档中的设计目标、计划模型与当前测试覆盖相符；这些回归中的 Agent 调用由替身完成，宿主夹具只证明 provider bundle 装载和能力上报。真实 Claude Code、DSH 子 Agent、Codex 的认证、权限效果、读写、取消/清理与完整返工仍未验收；本轮未发起模型调用。

### 2026-10-01 独立测试执行器首段

工作流定义新增冻结 `testRunner` executable/argv/timeout 字段，实现返工目标阶段必须配置；契约拒绝 shell executable 与 shell 元字符。Workbench 定义编辑器可填写实现阶段的 runner 命令，定义注册时随版本冻结。插件 runner 通过 `spawn(..., { shell: false })` 在指定实现 worktree 直接启动 allowlist executable，剥离凭证类父环境变量、限制输出量、设置超时并处理子进程树清理。包管理器运行 package script 时仍遵循自身脚本语义，不能把 `shell:false` 描述成对被测代码的 OS 隔离。worker 先提交实现并冻结 HEAD，再执行 runner；仅当退出码为 0、HEAD 未变化且 worktree 仍干净时回执为 passed。receipt 包含唯一 test-run ID、冻结命令、提交 SHA、Stage Attempt、provider Run、执行节点、时间、退出码、输出摘要和限长摘录；Hub 持久化前校验 Attempt 状态、Run、节点和 runner，并从 receipt 派生权威测试摘要/输出，原 Agent 自报测试另行脱敏保存；review 快照再核对 receipt 与 attempt.result 完全一致。Workbench 阶段说明测试进程沿用 worker 账户权限，Windows 下 npm 可用、pnpm/yarn shim 不支持，并分别显示独立结果与 Agent 自报参考结果。

验证：`node --test runtime/contracts/agent-workflow.test.mjs runtime/contracts/agent-workflow-definition.test.mjs plugins/tests/workflow-test-runner.test.mjs` 23 项通过，runner 在临时 worktree 实际执行 `npm test` 项目脚本；`team-hub/pipeline.test.mjs` 24 项通过；worker Claude Code → DSH → Codex 版本化闭环替身测试通过，断言 runner 实际执行并将同一 receipt 持久化并交给 review。失败路径覆盖两种情况：独立测试失败，以及测试命令本身通过但修改冻结 worktree；两者都会留下失败 receipt、阻止 Codex 启动且不产生实现交接证据。Hub 从 receipt 派生权威测试摘要，并将脱敏后的 Agent 自报另行保存。Windows npm runner 直接由 Node 启动 npm CLI，无 shell；`pnpm`/`yarn` shim 在 Windows 明确拒绝。`npm test --prefix plugins` 全量 442 项通过；Team Hub 和 Workbench 构建通过。另运行 DSH 源码仓库 Claude Code/Codex provider 单元测试 97 项通过，覆盖权限配置校验、Claude SDK permissionMode 传递、Codex app-server 审批/沙箱字段映射和生命周期；这不验证实际 DSH profile 加载值、账号认证或真实执行。当前未发起真实模型调用；本机无 DSH/Claude 命令或运行中的 DSH 进程，真实 provider 认证、权限效果、取消和重启对账仍需在可丢弃 OS 用户或容器中验收。工作树隔离与过滤进程环境不能限制测试代码访问 worker 账户可访问的其他文件或网络。

### 2026-10-01 外部 provider 权限模式核验

完成度复核发现旧 preflight 只检查 `permissionProfile` 标签是否符合预期，没有读取 DSH provider 实际解析的 `permissionMode`。现在 DSH `SubagentProvider` 暴露可选只读模式字段，Codex/Claude provider 从同一 `ResolvedConfig` 读取该字段并用于创建真实 run；Legion 节点心跳保存该值，Team Hub 工作流节点冻结/任务认领和 worker 启动都要求精确匹配。Codex 工作区写入档为 `codex-workspace-write` → `approve-for-me`，Claude 设计文件写入档为 `claude-code-acceptEdits` → `acceptEdits`。核对 DSH README 后发现 `dontAsk` 会拒绝未获授权操作，无法满足首阶段创建设计文件的职责，故更换 Claude 档；`acceptEdits` 不是 OS 级文件系统隔离。含糊的 Codex 默认档、危险 bypass 档、旧 Claude 档、未知/缺失/不匹配模式均拒绝派工。Workbench 节点列表显示每个 provider 的实际 DSH descriptor 模式。

验证：Legion 定向工作流、节点认领、工具配置和外部 adapter 测试 75 项通过，包含旧 Claude `dontAsk` 档拒绝断言；`npm test --prefix plugins` 全量 442 项通过；Team Hub 与 Workbench 构建成功。真实 DSH provider 宿主夹具现于独立 profile 显式配置 Codex `approve-for-me`、Claude `acceptEdits`，并从 worker 心跳读回两者的实例模式，14 项通过；夹具没有启动模型调用。此前 DSH Codex/Claude provider 单测 97 项通过、三项 DSH packages `tsc -b` 成功。模式字段证明启动配置选择一致，不证明真实 provider 对文件访问的强制效果；真实安全验收仍需在隔离 profile 和临时仓库进行。

### 2026-10-01 Claude 设计阶段可写权限修正

对照 DSH Claude provider README 发现，`dontAsk` 会直接拒绝尚未获授权的操作；把它作为默认工作流权限档，会让 Claude Code 设计阶段无法保证产出可交接的设计文件。已将受支持档位改为 `claude-code-acceptEdits` → DSH `acceptEdits`；此模式接受文件编辑，其他仍需审批的工具操作继续失败关闭。旧档位不再解析，避免用户空间中残留配置静默沿用错误行为。Workbench 会在节点心跳报告模式不符合阶段预期时明确告警，并提示在 DSH provider 配置中调整后重启 worker。真实宿主 fixture 的临时 profile 明确配置 Codex `approve-for-me` 与 Claude `acceptEdits`，确认运行实例 descriptor/worker 心跳读回值与冻结档一致。

验证：`node --test runtime/contracts/agent-provider-policy.test.mjs runtime/adapters/dsh/external-agent.test.mjs team-hub/routes/harness.test.mjs team-hub/pipeline.test.mjs plugins/tests/worker-regression.test.mjs` 共 75 项通过；`npm test --prefix plugins` 442 项通过；`node --test tests/p13-fixture/p13-host-injection.test.mjs` 14 项通过；Team Hub 和 Workbench 构建成功。宿主 fixture 不启动 Claude/Codex run 或模型请求。`acceptEdits` 与 provider descriptor 只验证 DSH 的模式配置，不构成 OS 文件系统沙箱或真实文件访问权限证明。

同轮补强 worker 闭环断言：Claude、DSH、Codex 每次 provider 启动前都已有持久化 Stage Attempt，且 DSH 父会话 `session.header.cwd` 必须与 Attempt 冻结的 `workspaceDir` 完全一致。`node --test --test-name-pattern="Claude design → DSH implementation → Codex review" plugins/tests/worker-regression.test.mjs` 通过；这验证的是替身运行下 Legion 传递的目录绑定，不替代真实 provider 的文件访问隔离验收。

Workbench 的节点预检现在会按所选外部工具报告缺失 bundle 或实际权限模式不匹配；前者展示对应 `dsh plugin --profile ... add ...` 命令，后者展示精确的 DSH provider YAML 配置片段，便于在执行节点修正后重启并等待新心跳。Workbench `tsc --noEmit && vite build` 通过，保留既有大 chunk 提示。该预检帮助部署配置，仍不代表 provider 已认证或真实文件访问边界已验证。

### 2026-10-01 真实执行环境只读预检

当前机器再次核验结果：PATH 没有全局 `dsh` 或 `claude` 命令，Codex CLI 可用；用户级 `desktop`、`headless`、`web` DSH profile 都未安装 Codex/Claude 子 Agent bundle；用户级 Claude 配置目录不存在；当前进程没有 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_AUTH_TOKEN`。预检只检查工具/目录、环境变量是否存在和 profile 依赖名，不读取凭据内容、不启动 provider。此前真实 DSH 宿主 fixture 使用临时 profile 验证了 bundle 加载与 `permissionMode`，但它不会调用 Agent。完整 Claude Code → DSH → Codex 真实执行还需先有可用的 Claude 原生认证，并得到真实 provider 运行授权；在此之前不能用替身或仅 Codex 单阶段运行宣称完成闭环。

### 2026-10-01 认证兼容与本机验收方式修正

用户确认 Claude Code 已安装，并指出 Claude 与 Codex 都可能使用 API 凭证登录。复核本机仅记录配置类别与认证方式：Claude CLI 报告 first-party OAuth 登录，本机 Claude 设置同时含 API token/reference 与自定义 endpoint 字段；Codex CLI 报告 ChatGPT 登录。任何凭证值均不读取、不复制、不写入计划或测试输出。验收因此覆盖 Claude/Codex 的原生登录配置与 DSH provider 显式 API-key 注入；Claude API 路径可将凭证映射到 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 并通过 `env` 设置 endpoint，Codex API 路径可映射 `OPENAI_API_KEY`，其 endpoint/provider 细节沿用 Codex 原生配置。

DSH Claude Code 与 Codex provider 已新增 `credentialEnv` 配置：执行时由本机 DSH credential service 解析引用并仅注入对应子进程，普通 provider 配置仅保存引用。Claude 与 Codex provider 包已补中英文 README、包依赖和 API 凭证配置/解析测试；Claude Code/Codex provider 定向测试 99 项全部通过，`tsc -b packages/credentials/credentials packages/subagent/subagent-claude-code packages/subagent/subagent-codex` 通过。API 凭证测试确认凭证引用在每次运行解析，并到达对应子进程环境；测试主动取消 fake run，不调用模型。

真实执行验收按用户要求采用本机临时 Git 仓库与独立 DSH profile，并只读取现有用户凭证存储；Docker 不是前置条件，也不触碰常用 DSH profile。已在临时 Git 仓库尝试真实 Claude CLI 设计阶段：用户自定义 endpoint 对默认模型和本机配置中的基础 model ID 均返回 404（CLI 报 `unrecognized_model`，usage 为 0）；只读 `/v1/models` 查询也返回 404。未改用户设置，且未生成文件。Codex CLI 原生登录的非交互调用启动后，模型目录刷新与 Responses 请求多次超时，未写出文件，重连后已中止。后续端到端运行需要确认该 endpoint 支持的 Claude-compatible model ID 或可用的 Claude 原生认证配置，并恢复 Codex API 可达性；在此之前不把 API-key 传递单测冒充真实 API 认证。Codex fake-server 与两个 provider 包构建通过；真实 DSH provider bundle 装载、Claude 设计、DSH 实现/独立测试、Codex 审查、typed rework 与阶段 Attempt/Run/diff 记录仍待完成。

### 2026-10-01 CC Switch 本地路由下真实 Claude 设计阶段

修正前一条对 Claude 真实调用的阻塞记录：用户确认 Claude 由 CC Switch 在本机 `127.0.0.1:15721` 转发，Claude 路由启用。此前按 `settings.json` 的上游 `ANTHROPIC_BASE_URL` 直连，绕过了本地路由；早先模型列表探测还重复拼接 `/v1`。复查 `settings.json` 与用户提供的配置相符，另有 `ANTHROPIC_AUTH_TOKEN`（只确认字段存在，不读取值），没有其他 model 覆盖。

把本次调用的 `ANTHROPIC_BASE_URL` 临时覆写为 CC Switch 地址后，Claude CLI 在临时 Git 仓库成功创建 `design.md`。CLI 报告 `claude-opus-5[1m]`、first-party provider、约 0.13 美元 usage。没有改变全局设置；生成物只在临时仓库。已验收 Claude CLI 经本地路由完成设计产物，但 DSH provider 尚未读取该设计，Legion 工作流也尚无对应的 Stage Attempt/Run 记录。Codex 原生登录非交互请求仍遇到模型目录与 Responses 请求超时；截图显示 CC Switch 的 Codex 路由未启用。本地临时 Git 仓库/Profile 足以继续验收，无需 Docker。

### 2026-10-01 Claude → DSH 临时仓库实跑（CC Switch 本地路由）

用户补充 Claude 经 CC Switch 本地路由 `127.0.0.1:15721`，且 Claude route 启用。旧预检直连上游并重复拼接 models 路由的 404 记录不适用，现以本次本地路由实跑为准。只给该次 CLI 调用覆写 `ANTHROPIC_BASE_URL` 到本地地址，Claude 成功在临时 Git 仓库生成 `design.md`；CLI 报告 `claude-opus-5[1m]`、first-party provider、约 0.13 美元 usage。没有更改用户全局 settings。

随后调用本机 DSH 构建版 CLI 的 `headless` profile，让其读取该设计并在同一临时仓库生成 `index.mjs` 和 `index.test.mjs`。主 Agent 检查代码后实跑 `node --test`，15/15 通过；脚本实际输出也符合设计，`design.md` 保持不变。这证明本机 Claude CLI → DSH headless 的真实工具接力与文件读写，不经过 Legion workflow 调度，也没有生成 Stage Attempt/Run 或 Codex 审查记录。该次 DSH 调用使用现有 `headless` profile，仓库和工作区为临时目录；全程不需 Docker。

Codex 复审仍待完成：截图显示 CC Switch 的 Codex route 未启用；此前 Codex 原生 ChatGPT 登录请求触发模型目录/Responses 超时且未写出文件。没有把 Codex CLI 登录状态或本地代码检查记作 Codex review 证据。

### 2026-10-02 当前回归结果与闭环边界

继续验证后，Legion DSH runtime adapter、agent workflow contracts、Hub Attempt 路由和独立测试 runner（排除旧 parity 测试）共 192 项通过；Claude design → DSH implementation → Codex review 的版本化 worker 替身闭环 1 项通过；真实 DSH 宿主注入 fixture 14 项通过。DSH Claude Code/Codex provider 定向 Vitest 99 项通过，TypeScript project build、配置目录生成检查和 74-package 依赖策略检查通过。

扩大 glob 扫描时，`runtime/adapters/dsh/parity.test.mjs` 的旧漂移断言失败：它仍期待只有 denyTools 的单个条件展开，而当前版本化 workflow/provider 调度路径还支持冻结模型的第二个 `agentOptions` 条件展开。这个测试缺口已在下文“parity 漂移哨兵跟进冻结模型选项”一节修复；此前失败结果是修复前基线，不是当前失败项。

真实实跑仍是 Claude CLI（CC Switch 本地路由）→ DSH headless，未由 Legion 持久化阶段调度。Codex CLI 只读 review 重试仍在五次请求超时后失败，没有改文件；真实 Stage Attempt/Run、Codex review 与 typed rework 尚无证据。

补充验证：`npm test --prefix plugins` 全量 442 项通过；此插件套件不包含上述旧 runtime parity 用例。

### 2026-10-02 DSH provider 真实执行与系统代理验证

按用户要求在本机临时 Git 仓库和现有认证下继续真实验收，不修改全局配置或常用 DSH profile。真实调用 DSH `subagent-claude-code`，仅通过该次 provider 的 `env` 将 `ANTHROPIC_BASE_URL` 指向已启用的 CC Switch 本地路由 `http://127.0.0.1:15721`，实例权限为 `acceptEdits`；Claude 在临时仓库创建了符合 greet(name) 设计约定的 `design.md`，只创建了这一个文件，provider 返回 completed。该调用通过 DSH provider 真实验证本地路由认证和最小工作区写入，但没有 Legion Attempt/Run 关联。

随后真实启动 DSH 捆绑 Codex CLI `0.153.4` 的 `subagent-codex` `app-server --stdio`。`systemProxyMode: system` 实际传入 `--enable respect_system_proxy`；在进程代理环境变量为空、本机系统代理开启且 Clash 端口 `127.0.0.1:7897` 可达时，请求返回 `DSH_APP_SERVER_PROXY_OK`。该次调用临时传 `model: gpt-5.5`。不覆盖模型时，旧 bundle 会继承本机默认 `gpt-6.1-sol`，服务端因当前 ChatGPT 账户不支持该模型返回 HTTP 400。因此网络代理已验证，但实际 DSH profile 必须配置兼容模型或更新 Codex CLI bundle，之后才能确认无模型覆盖的运行行为。Codex 仍提示 `respect_system_proxy` 属开发中功能。

针对“目标节点确认网络连通性”单独复核：目标机 Windows 系统代理处于开启状态，代理地址为 `127.0.0.1:7897` 且端口可连接；进程级 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（含小写变量）均未设置。使用 DSH `subagent-codex` provider 的真实启动实现，显式配置 `systemProxyMode: system`、`model: gpt-5.5`、`permissionMode: never`，在一次性临时工作目录中发送只读提示，真实请求以 `completed` 终态返回精确探测串 `LEGION_SYSTEM_PROXY_CONNECTIVITY_OK`。另运行 `node --test tests/p13-fixture/p13-host-injection.test.mjs`：14 项通过，其中真实 DSH worker heartbeat 报告的 Codex 能力包含 `systemProxyMode: system`。因此此目标节点的代理路径已实测可用。此项只证明本机/本次模型账户与该模式组合可达；`respect_system_proxy` 仍是 Codex CLI 标注的开发中功能，其他执行节点应分别实测；本次没有创建 Legion Stage Attempt。

两次 DSH provider 冒烟均运行在专用临时 Git 仓库；临时文件已清理，没有修改用户级模型/代理配置或全局 Codex/Claude 配置。本段记录的是持久化阶段验收开始前的状态，后续已通过真实 Legion worker 建立并核验 P13 Stage Attempt/Run；但这两次单阶段 provider 冒烟本身不能代替完整闭环。

### 2026-10-02 Legion 持久化真实阶段首次尝试与错误诊断修复

在独立 DSH profile、临时 Git 仓库、独立 Hub 数据库内发布 `Claude designer → DSH coder → Codex reviewer` 目标。目标、三条角色任务、workflow definition 与设计阶段 Attempt 均由 Legion/Hub 持久化；Claude DSH provider 已启动，Attempt 绑定了 provider Run ID。Claude 在隔离 worktree 生成 `docs/G-muqf4pxh-1/design.md`（约 7 KB），包含明确接口、空字符串行为、实现布局和验收标准；但 DSH 最终返回 `stopReason=error`，worker 将任务转入 `in_review`，Attempt 保留为 `unknown`。当前证据不足以把该阶段记作完成，也没有推进编码/审查或重派该 Attempt。临时数据库、worktree 和 provider session 保留用于核查；未触碰正式空间或工作区。

这次运行暴露了一个诊断缺口：DSH `SubagentResult` 可附带受限 `diagnostic`，Legion 外部 Agent adapter 只保留 `stopReason`，使 Hub 只记录“worker 未完成（error）”。现已在 `runtime/adapters/dsh/external-agent.mjs` 与 `plugins/src/index.ts` 透传该诊断，限制长度并压成单行，供 Attempt 和隔离提示定位失败；状态仍然 fail-closed 为 `unknown`，不会将可能已有部分写入的阶段标为成功或自动重试。增加 adapter 与真实外部-provider worker 回归。验证：`runtime/adapters/dsh/external-agent.test.mjs` 12/12；Attempt 创建顺序、provider Run 绑定和外部 `dsh-subagent` 失败路径回归 1/1；`npm test --prefix plugins` 全量 442/442；`plugins/tsconfig.json` TypeScript 检查通过（调用 DSH checkout 自带的 TypeScript 编译器，因为 Legion 未安装全局 `tsc`）。

本段描述 Attempt 1–6 完成时的状态；当时后续记录曾将 T-001 design Attempt 13 记作完成，但下方 2026-10-02 可用持久化数据库审计未能找到匹配的 Claude provider Attempt，因此不得把此历史文字单独当作 Claude 阶段已完成的当前证据。此前未知 Attempt 与 Run、工作区及 `confirmed-stopped` 对账仍作为历史保留。首选真实闭环仍未完成；目标节点 Codex 系统代理连通性是已完成的独立检查，不得与闭环待办合并或互相替代。

### 2026-10-02 Claude 空结果诊断、fail-closed 兜底与重试核验

首次运行之后又在独立 profile/worktree 中重试 Claude design。Legion 已透传 DSH provider 的受限诊断：第二次运行显示 `acceptEdits` 下出现需交互审批的工具请求；更新外部设计/审查 prompt，明确不调用 shell、无需执行命令、写完即返回 JSON 后，后续尝试仍以 DSH `stopReason=error` 结束。尝试 4 经新增诊断确认 Claude SDK 返回 `subtype=success`、空 `result`、进程 exit code 0。隔离 worktree 中实际存在 Claude 写出的 `docs/G-muqf4pxh-1/design.md`；该文件含接口与 CommonJS 契约、文件布局、node:test 验收、风险及边界，但没有合法 WorkerReport，所以文件保留为未验收证据，不能把阶段或 Attempt 改记为 completed。

为兼容 Anthropic SDK 终态 result 为空、但确有完整顶层 assistant `end_turn` 文本的路由，DSH `subagent-claude-code` 现只在同时满足“收到非错误 SDK success result”和“存在 assistant end_turn 文本”时回收该文本；没有 assistant end_turn 时仍以固定安全诊断失败，返回文本仍由 Legion 的严格 WorkerReport JSON 校验。包内定向 Vitest 43/43、该包 TypeScript project build 通过，provider bundle 已按 workspace filter 构建。此兜底没有放宽 `unknown` 隔离或报告验收。

使用新 bundle 的真实 Legion Attempt 5 明确诊断为 `sdk-result-empty-final-assistant-missing`。在 Hub 历史增加了人工核验说明、追加 `confirmed-stopped` 对账并保持任务隔离后，Attempt 6 再次尝试以同一诊断结束。Attempt 1–6 均留为 `unknown`，各自 Run ID、工作树及追加对账保留；没有自动重试。当前设计任务 T-001 仍在 `in_review` 且 hold，工作流没有推进到 DSH coding、Legion 独立测试回执或 Codex review。证据显示该 CC Switch / deepseek Claude Code 路由在工具写入后没有发出最终 assistant 文本；这与网络连通失败不同，也不能用系统代理验收替代。下一步应确认该路由对 Claude Agent SDK tool-use 回合的兼容性，或使用可返回最终 assistant 文本的受支持模型/路由，再按 Hub reconciliation + 单独任务生命周期操作继续，不应继续无诊断地重复收费调用。

2026-10-02 目标节点网络复核：Windows 系统代理仍为 `127.0.0.1:7897` 且端口可连接，六个常见大小写的 HTTP/HTTPS/ALL 代理环境变量均未设置。通过 DSH 捆绑的 Codex CLI `0.153.4` 执行 `--enable respect_system_proxy exec --model gpt-5.5 --sandbox read-only`，提示不调用工具且只返回探测串；请求成功返回 `LEGION_SYSTEM_PROXY_CONNECTIVITY_RECHECK_OK`。Codex 同时输出 `respect_system_proxy` 的开发中警告；模型目录刷新及推荐插件目录另有超时/响应解析告警，但没有影响本次模型请求完成。结论限定于本目标节点、当前登录、所选模型与此时网络状态。

2026-10-02 目标节点再次复测：系统代理 `127.0.0.1:7897` 仍启用且 TCP 可连接，`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 及其小写变量均未设置。运行 DSH 捆绑 Codex CLI `0.153.4`，启用 `respect_system_proxy`、`gpt-5.5` 与只读沙箱，请求成功返回 `LEGION_SYSTEM_PROXY_CONNECTIVITY_FINAL_OK`。Codex 仍打印该功能处于开发中的警告；其他插件图标、PowerShell shell snapshot 和 rollout flush 警告未阻止模型响应。此次完成当前目标节点的网络连通验收；不能外推至其他节点或后续网络/账号状态，其他节点应按本段方法分别检查。

2026-10-02 工作流交接修复与复验：`recordArtifact()` 对版本化阶段改为相对其冻结 worktree 记录文件路径；Hub 为下游冻结上下文过滤历史绝对 file artifact，避免旧错误记录覆盖有效相对路径。测试覆盖了“worker 从仓库外 worktree 报绝对产物路径”和 Hub 中同时存在旧绝对路径及新相对路径两种情况。`npm test --prefix plugins` 442/442、`node --test team-hub/pipeline.test.mjs` 24/24、三阶段闭环回归 1/1 通过。

2026-10-02 Stage Attempt review 结果审计补齐：复核发现 `/api/agent-workflow/stage-attempts/report` 原先只把状态、摘要、测试报告等写入 `result_json`，会丢弃 Codex 的结构化 `review` finding；typed review 台账虽能生成返工任务，但无法单从 Attempt 历史还原 Agent 实际返回的审查结论。现将脱敏后的 `passed` 和分类 findings 随 Stage Attempt 保存，限定字段及长度并剔除额外数据。`team-hub/pipeline.test.mjs` 增加真实 reviewer Attempt → Codex Run → 分类 finding 的路由集成断言，验证 bearer 文本脱敏、非法 finding/额外字段丢弃，并在 Hub 重启后通过工作流 history API 回读相同结果；该套件 24/24 通过。worker 三阶段组合回归也新增断言：通过结论和 typed findings 都随对应 Codex Stage Attempt 发往 Hub，定向回归 1/1 通过；`team-hub/routes/agent-workflow.test.mjs` 4/4，Team Hub 构建通过。Workbench history 类型与任务详情现展示审查通过状态、finding 分类、严重度、文件、证据和验证要求；`npm run build --prefix workbench` 通过（保留既有大 chunk 提示）。此记录补全审计持久化与可见性，不代表尚未完成的 Claude→DSH native→Codex 真实 provider 闭环、typed rework 实跑、取消或最终 Legion 验收。

2026-10-02 DSH Codex provider 真实取消探针（部分门槛）：在 `systemProxyMode: system`、`gpt-5.5`、`permissionMode: never` 与只读提示下，provider 已发布 Run 后收到本地 AbortSignal，结果以 `stopReason=aborted` 结算；`run.dispose()` 和 DSH 宿主 `fiber.dispose()` 均成功返回。工作目录指向系统临时目录，没有创建或修改文件。该结果验证 Codex provider 的取消映射及本地子进程回收，不验证 Hub Stage Attempt `canceled` 状态、未知结果隔离、人工 reconciliation 或工作区保留；这些仍须通过 Legion 持久化真实阶段验收。

同日回归复核：`node --test team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs` 28/28、`node --test plugins/tests/worker-regression.test.mjs` 15/15 通过。Worker 合成宿主测试覆盖 Hub 取消信号穿过 worker 到 provider 并记录 `canceled` Attempt；这与上面的真实 Codex provider 取消探针互补，但二者尚未组合成同一次真实 Legion 持久化 Stage Attempt 取消验收。

同日新增 `tests/p13-fixture/real-codex-cancel.mjs` 手动真实验收探针，并完成实跑：脚本使用 SQLite 内存 Hub 建立临时空间、节点心跳、命名工作流和 Stage Attempt，再启动真实 DSH `subagent-codex`（`gpt-5.5`、`systemProxyMode: system`），将 Hub 目标取消映射到 AbortSignal。真实 provider 返回 `aborted`，dispose 成功；Attempt 的 provider Run ID 和 `canceled` 终态可从 history API 回读，临时工作区保持空白后清理。实跑输出：`{"resultStopReason":"aborted","attemptState":"canceled","providerRunBound":true,"workspacePreserved":true}`。前一轮首次启动在模型调用前由 Hub 因缺少 roster/空间阶段配置拒绝，补齐正常前置配置后成功；没有触碰正式 Hub 或 DeepSeek 凭据。此探针手动驱动取消信号，不运行 Legion 守护 worker；它与 15/15 worker 信号传播回归共同覆盖 provider 取消和 Hub 结算两端，仍不覆盖同一真实 worker 进程中的端到端传播及真实 provider 的未知终态。

P13 真实工作流中，T-001 的设计 worktree 经复核 clean，提交 `28818d6adc4c78a583f0cfc0b3ff9ad3718c126b` 含设计文件，文件 SHA-256 为 `40b10b069ae84757312f2a2622bf0ea6828c9e0063c61cd67dc64e9955ba9c8c`。经 Hub API 补录相对路径 artifact 和 `design` checkpoint 后，T-002 的冻结 workflowContext 正确读取了该文件路径与提交证据。随后 T-002 Attempt `wfa-5afcd9ae-5d39-4463-a1c9-a6353e762a30` / provider Run `00714016-3db8-4520-bf05-97b5ecd674d0` 在 DSH native `spawn` 阶段以 error 结束；Hub 将 Attempt 保留为 `unknown`、任务置于 `in_review` 并隔离。对应 worktree clean、HEAD 未改变，未发现实现文件或提交；没有自动重试。真实编码/测试/Codex review 闭环仍未通过，继续前须查明该 DSH 执行错误并按 Run 核验/对账规则操作。

T-002 失败原因复核补充：P13 隔离 DSH 进程使用的是明确占位的 `DEEPSEEK_API_KEY=keyless-p13-no-model-call`，不是有效模型凭据；DSH native `spawn` 因此不能构成 DeepSeek 认证或编码能力的有效验收。Hub 记录本次结果为 `unknown` 而不是误判成功；验证 DSH 主机及子进程已停止、T-002 worktree 无改动后，已通过 Hub 追加 `confirmed-stopped` 对账。任务仍为 `in_review` 且 hold，不自动重试。后续真实执行需先由用户在本机轮换此前暴露的密钥并更新本机 DSH credential store，然后从本机安全注入到隔离 profile；不可在聊天中传递密钥。

追加静态验收：命名 DAG、Hub 路由、实例历史、测试 runner、checkpoint 导入、外部 Agent adapter 等组合测试 55/55；工作流契约/adapter/test-runner 定向组合 42/42；Team Hub 包 build 成功，Plugins 类型检查通过（使用 DSH checkout 的 TypeScript 编译器）。`npm run typecheck --prefix plugins` 在本机因未安装全局 `tsc` 无法执行，改用 `node D:\\project\\DSH\\dsh\\deepseek-harness\\node_modules\\typescript\\bin\\tsc -p plugins/tsconfig.json --noEmit` 完成等价类型检查。

密钥处理更正：本轮凭据文件检查曾误输出本机 key 值；这些值视为已暴露，不应用于任何后续测试，需先轮换后再从本机 credential store 做安全注入。此前写在研究记录中的“凭证值均未读取/未输出”只描述早期检查，不适用于本次操作；不得继续引用为当前事实。

2026-10-02 未知结果诊断增强：工作流 provider 的 result Promise 若拒绝，等待器现在只保留经过字符集校验的错误类名，不保留异常消息；worker 依 Promise rejected/超时/普通连接中断生成不同的隔离原因，避免认证 URL、响应正文或凭据从错误文本进入 Hub。增加拒绝错误和恶意 error.name 的脱敏测试。`runtime/adapters/dsh/workflow-run.test.mjs` 6/6、`npm test --prefix plugins` 442/442、Plugins TypeScript 检查通过。该增强改善后续失败可诊断性，不改变 unknown/quarantine/不自动重试规则，也不能让占位 API key 的 T-002 Attempt 变成有效认证验收。
补充 fail-safe 诊断边界：错误对象的 `name` getter/proxy 也可能抛异常；错误分类读取现在有固定 `Error` 回退，确保 hostile rejection 不会卡住 worker 等待器。对应 workflow-run 测试 7/7，通过的错误内容只保留类型名，不回显异常消息；Plugins TypeScript 检查通过。

2026-10-02 当前状态复验：在 DSH checkout 重新运行 Claude Code 与 Codex provider 包测试，99/99 通过；重新构建 credentials、Claude provider 与 Codex provider 的 TypeScript project references 通过。该组测试验证 credential-reference 解析和注入边界，但使用 fake credentials、不发出模型请求，因此不替代真实 OAuth/API-key 认证。P13 隔离主机当前无运行进程，T-002 Attempt 保持 unknown 并已对账，任务 hold、worktree clean；本机 credential file 的元数据未变化，真实执行继续等待本机轮换。

### 2026-10-02 parity 漂移哨兵跟进冻结模型选项

重新运行 DSH parity 套件时发现命名工作流的真实 worker 调用已新增冻结模型配置的条件 `agentOptions` 展开，但漂移哨兵仍按旧的单个 `toolFilter` spread 查找调用，造成测试在实际行为未回退时误报复刻漂移。现将定位锚点更新为唯一匹配的工作流派工调用，将 `agentOptions` 纳入可选调用参数，并增加冻结模型配置存在/缺失两种形状断言；合成漂移用例同步覆盖两个条件展开。`node --test runtime/adapters/dsh/parity.test.mjs` 38/38 通过。此前 2026-10-02 回归段落里“旧 parity 基准待更新”描述已由本修复取代。

工作区适配器回归 `node --test runtime/adapters/dsh/*.test.mjs` 198/198 通过，包含现有 DSH runtime 行为、漂移检测和工作流取消/未知结果保护。

### 2026-10-02 持久化三阶段实跑与收尾缺陷修复

在一次性 DSH profile、独立 Hub 数据库和临时 Git 仓库中，由真实 DSH worker 依次运行三个真实 Codex provider Attempt。设计 Attempt `wfa-06219d52-050e-4493-bbaa-fa496465aa0e` / Run `65291262-046f-43c4-bbf6-1803a3a0e832` 完成并冻结提交 `87d6b1a5572a1ba9d912ab90f7b08757c59f0093`；实现 Attempt `wfa-770dafe0-b708-45d1-9e5c-855870e0f673` / Run `fae58e5d-fe4a-4588-ac1c-8d8ee9f24746` 完成并冻结提交 `0c7b91b275c303f93988e83aa530f629e64e02d7`；Codex review Attempt `wfa-a84f200d-40bb-4585-bd89-83244df6d93e` / Run `b59287ce-1ae5-4205-a3a8-3aac4ba5b9cf` 明确通过。Legion 在冻结实现提交上执行 `node --test probe.test.mjs`，五项通过；receipt 与 provider Run、Stage Attempt 和提交 SHA 绑定。实现文件 `probe.mjs`、`probe.test.mjs` 已从提交差异自动登记为版本化 artifacts。设计/实现任务为 `done`；review 通过后任务停在 `in_review` 等 Legion 最终验收，属于既定门禁。三个 worktree 均 clean，未 push；临时 DSH 主机已正常关闭。

该实跑连续暴露并修复四个真实边界：Windows CRLF 原始哈希与工作流 LF 规范化 SHA-256 被 Agent 误认为不一致；严格解析器返回冻结 WorkerReport，worker 写入 Legion test receipt 时因修改只读对象而异常；Agent 自行提交时 `commitWorktree()` 返回“无新提交”被误判失败；实现阶段输出契约只看 Agent 显式登记的单个 artifact，漏掉已经提交的测试文件。当前 worker 提示说明 CRLF/LF 摘要语义；报告先复制再附加 Legion receipt；实现阶段冻结输入基线，接受干净且 HEAD 是基线后代的 Agent 提交；Hub 从阶段提交差异自动登记文件 artifact。外部 review 提示现允许只读文件/终端检查，同时明确禁止工作区写入，避免“实际审查代码”与“不得使用终端”自相矛盾。

第一次复现只读对象错误时，真实 Codex provider 已返回、实现提交已存在，但 Attempt 一度留在 running。重启该隔离 DSH profile 后，Hub 将孤儿 Attempt 转 unknown 并 hold 任务；核对 worker 日志、无活动 provider 进程及 clean worktree 后，通过 general reconciliation 记录 `confirmed-stopped`。该失败 Attempt 未用于通过验收或自动重派。

验证：`npm test --prefix plugins` 442/442；使用 DSH checkout 的 TypeScript 编译器运行 `tsc -p plugins/tsconfig.json --noEmit` 通过；增强后的 Claude→DSH→Codex worker 回归 1/1。真实 DSH native DeepSeek coder 的凭证引用现已通过单次真实 Messages API 验收，但尚无 Legion Stage Attempt 证明该 native Agent 完成 coding。用户已确认轮换先前暴露的密钥。当前完整实跑三个阶段均使用 Codex provider，不代表首选 Claude→DSH native→Codex 组合已经闭环；design finding 往返与最终 Legion 独立验收仍待完成。

### 2026-10-02 DSH native API-key 安全验收与首选闭环预检

用户确认已在本机轮换先前误输出的旧密钥。通过 DSH `credentials-local` 的 `describe(DEEPSEEK_API_KEY)` 只核对配置状态，结果为 `configured=true, source=file, writable=true`，未读取或打印密钥值；没有设置该变量覆盖进程环境。随后在独立 Cordis/LLM context 中挂载本机 DSH credential provider 与 DeepSeek Messages provider，针对 `deepseek-v4-flash` 发起一次固定短提示，真实响应以 `stop=stop` 结束并精确匹配 `LEGION_DSH_API_KEY_ACCEPTED`。没有运行 coding、访问正式工作区或写入全局配置。这证明轮换后的 DSH 本机 API-key 引用可用于真实 DeepSeek 请求，不等价于 Legion Stage Attempt 或首选三方闭环。

准备启动持久化的 `Claude Code → DSH native DeepSeek → Codex` 验收前，对 CC Switch 当前本地路由 `127.0.0.1:15721` 做只读 TCP 预检：端口拒绝连接，进程列表也没有 CC Switch 进程。因此未启动隔离 DSH host、未创建目标或 Stage Attempt，也没有向失效路由发送 Claude 请求。新增 `tests/p13-fixture/real-claude-deepseek-codex.mjs` 手动探针：以独立 profile 指向本机已有 DSH credential file、隔离 Hub DB 和临时 Git repo；先要求 Claude route 可连接，再运行 Claude 设计、DSH coding/独立测试和 Codex review。DSH route/credential 覆盖补丁已通过隔离 host boot 验证；`node --check` 通过。Workbench 节点代理状态测试 3/3、`team-hub/pipeline.test.mjs runtime/contracts/agent-workflow.test.mjs` 36/36、Workbench TypeScript/Vite production build 通过（既有 chunk-size warning）。必须在 CC Switch 本地 Claude 路由启动后再执行完整首选闭环。

2026-10-02 对当前可访问的 P13 临时 Hub 数据库做只读审计：现存 `p13-hub.db` 中所有 `greet` 工作流任务的冻结 `agentSelectionSnapshot.agentToolConfig.providerName` 均为 `codex`，相应 stage Attempt 的 `provider_name` 也均为 `codex`；没有可用数据库记录证明这些阶段由 `claude-code` 或 `deepseek` provider 执行。故即使任务标题写着“Claude design”，也不能据标题认定实际 provider。当前可独立确认的 Claude 真实执行仍是 DSH provider 单阶段临时仓库 smoke（未创建 Legion Attempt）；DeepSeek credential-reference 单次 LLM 请求同样尚不是 Legion coder Attempt。后续闭环须依 Hub 冻结配置和 Attempt/Run 历史逐阶段验明 provider，不能沿用标题或先前摘要作为证明。

2026-10-02 真实 Legion worker 取消闭环及修复：新增 `tests/p13-fixture/real-codex-worker-cancel.mjs`，启动隔离真实 DSH host、Hub、Codex provider 与一次性 Git 仓库；执行节点能力来自 DSH worker 自己的心跳，provider 实际报告 `systemProxyMode: system`。实跑确认目标取消时在办任务按产品语义保持 `in_progress + hold`，而旧 worker 只检查 task `status=canceled`，没有观察到所属 goal 已取消，导致真实 provider Run 一直不收 AbortSignal。现 worker 等待器在隔离工作流运行期间同时读取任务和目标状态；目标取消会触发 provider AbortSignal，但只有 provider 返回取消终态后才把 Stage Attempt 记为 `canceled`，保留被 hold 的任务和 worktree。最终真实实跑结果：`{"attemptState":"canceled","providerRunBound":true,"goalTaskState":"in_progress","taskHeld":true,"worktreePreserved":true,"worktreeClean":true}`。临时 profile/Hub/repository 在核验后清理。验证：`node --test runtime/adapters/dsh/workflow-run.test.mjs plugins/tests/worker-regression.test.mjs` 23/23；Plugins TypeScript 检查通过；`npm run build --prefix plugins` 成功；真实 DSH 宿主注入回归 14/14。此次关闭真实 worker 取消门槛；真实 provider 未知终态与人工对账仍是独立待办。

2026-10-02 真实 Codex 未知结果与人工对账闭环：复用上述隔离 DSH/Hub/临时 Git fixture，等真实 Codex Run 已绑定后，只终止该 DSH host 的 Codex app-server 子进程并确认该进程退出；DSH worker 被中断后重启，Hub 的 boot-orphan recovery 将遗留 running Attempt 改为 `unknown`，任务进入 `in_review + hold`。再等待一个 5 秒 worker 扫描周期，Stage Attempt 仍只有一条，没有自动重派；核验 worktree 存在且 clean 后，通过公开 reconciliation API 写入 `confirmed-stopped`。History API 确认 reconciliation 留痕且 Attempt 仍为 `unknown`。实跑结果：`{"attemptState":"unknown","providerRunBound":true,"providerProcessStopped":true,"taskHeld":true,"noAutomaticReassignment":true,"reconciled":true,"worktreePreserved":true,"worktreeClean":true}`。该验收使用当前 Codex 登录，不触碰 DeepSeek credential；前次失败探针遗留的一个临时目录因 host 进程强制终止而保留在系统 temp，未进入用户仓库或常用 DSH profile。

### 2026-10-02 取消目标的迟到审查结果防护

审查与目标取消并发时，取消事务会将仍在办的 review task 置为 `in_progress + hold`；provider 若恰好在取消后返回，旧 Hub 逻辑仍接受 finding 并生成返工任务，破坏“取消后不再自动推进”的边界。`submitAgentWorkflowReview()` 现在在同一事务中检查所属目标状态：目标已取消时返回 `409 AGENT_WORKFLOW_GOAL_CANCELED`，不写 review 台账、不创建返工任务。已完成审查的重复请求仍走原幂等回放路径。`team-hub/pipeline.test.mjs` 新增真实 Hub HTTP/SQLite 集成覆盖：先取消目标，再提交有效 typed finding，断言 409 和零 review/返工写入。验证 `node --test team-hub/pipeline.test.mjs` 24/24 通过。该修复增强了取消一致性，但不代表两类真实 Agent typed rework 已通过。

### 2026-10-02 真实 Codex implementation finding 返工闭环与 checkpoint 修复

新增手动探针 `tests/p13-fixture/real-codex-implementation-rework.mjs`，运行于一次性 DSH profile、Hub SQLite 和临时 Git 仓库，使用 DSH worker 心跳注册的 Codex provider 与 `gpt-5.5`。完整五个 Stage Attempt 均由真实 Codex 执行并绑定 provider Run：design → implementation → review finding → implementation rework → review pass。首次 review 在 `agent_workflow_reviews` 中持久化 `implementation` finding 并创建 T-004；返工后新提交、新测试回执和最终复审均关联到新的 Attempt/Run，history 检查最终 review 通过，返工工作树 clean。关键实现 Attempt：初始 `wfa-bf208d46-2b70-41f8-b9db-3877cf5d39b4` / Run `7e5a999d-fb4b-48dc-b925-3a3e0d354648` / commit `1ea0a94166f170f9e603543753378b99a8e0e3fc`；返工 `wfa-1176cff2-26ec-4f4b-b8a2-db80eee4fc8b` / Run `88d30c76-805b-459b-baee-1779f0c308c0` / commit `87c73c1b48c5df4a04167c0976ff2f6aec59260a`。两份 Legion receipt 均绑定 `sourceCommit + stageAttemptId + providerRunId`，源代码和测试都精确断言设计约定 `Hello, ${name}!`；最终输出 `{"firstReview":"implementation-finding","reviewRounds":1,"receiptsBound":true,"finalReview":"passed","reworkWorktreeClean":true}`。

这次真实运行先发现返工任务继承了只读 review task 的 ancestry；`materializeWorkflowCheckpoints()` 因 review task 不会产生 Git checkpoint 而拒绝派工。Hub 的 `resolveAgentWorkflowContextSnapshot()` 现通过冻结 stage ID/role 排除 review 阶段，只把可导入的设计、实现 checkpoint 放入返工上下文。`team-hub/pipeline.test.mjs` 的真实 HTTP/SQLite 路径断言返工上下文保留设计/实现而排除 reviewer；重新实跑确认新实现 Attempt 已启动并完成。真实 Codex 还暴露报告格式歧义：finding JSON 被写进 evidence 而不是 `WorkerReport.review` 顶层字段；现已给 review prompt 增加完整的通过/未通过 JSON 示例并明确字段层级。定向回归 `node --test plugins/tests/worker-regression.test.mjs team-hub/pipeline.test.mjs` 39/39，`npm run build --prefix plugins` 通过。此项只通过 implementation finding 往返，design finding 回到 Claude 仍未验收。

### 2026-10-02 Codex 系统代理目标节点现场复测

为完成“目标节点确认网络连通性”这一项，在当前 Windows 节点重新读取 Internet Settings：`ProxyEnable=1`、`ProxyServer=127.0.0.1:7897`；Clash 监听端口 TCP 连通。当前进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写名称均未设置。新增可复跑只读探针 `tests/p13-fixture/real-codex-system-proxy-connectivity.mjs`，直接通过 DSH `subagent-codex` provider 配置 `systemProxyMode: system`、`gpt-5.5`、`permissionMode: never`，在一次性空目录里请求固定探测串。真实结果为 `stopReason=completed`、响应 `LEGION_SYSTEM_PROXY_CONNECTIVITY_LIVE_OK`，目录保持空白。执行命令：`pnpm exec node D:/project/DSH/legion/tests/p13-fixture/real-codex-system-proxy-connectivity.mjs`（工作目录为 DSH `deepseek-harness` checkout）。Codex 仍提示 `respect_system_proxy` 是开发中功能，并有模型目录刷新超时及插件/shell snapshot 警告；它们没有阻止本次模型响应。结论只适用于本节点、当前登录、gpt-5.5 和本次网络状态，其他节点仍需各自复测；此次没有创建 Legion Stage Attempt，也没有访问或输出凭据。

随后尝试以真实 Codex 复验 design finding 返工。真实设计 Attempt 正确按目标写出 `Hello, ${name}!`，实现通过独立测试，reviewer 因设计、实现、测试一致而正确给出通过；因此这次有效证明了正常阶段链，但没有产生 design finding，不能计作 design rework 通过。探针原先会把已通过的 reviewer 任务误当作待返工，并等待到超时；现已改为发现初审直接通过时立即以明确原因停止，同时只把非 reviewer 的 `in_review` 任务判作返工停滞，并在这种正常通过情形下立即提示“本次未覆盖 design rework”。设计 finding 往返仍待有真实 finding 的验证，当前探针执行不留下持久化业务数据或仓库 worktree。复核替身 Hub/DAG 路径：`node --test team-hub/pipeline.test.mjs runtime/contracts/agent-workflow.test.mjs` 36/36 通过，覆盖设计 finding 路由、返工任务生成、mixed finding 优先回设计和历史持久化；它不替代真实 provider design rework。
