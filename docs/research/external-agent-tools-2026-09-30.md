# 外部 Agent 工具接入能力与 Legion 接入方案

调查日期：2026-09-30。范围：Agent Network、DeepSeek Harness、xAI Grok Bot 及第三方桥接、Legion 当前执行路径。

## 产品目标

Legion 要让多个 Agent 工具围绕同一目标接力工作，并以版本化交接物保持协作连续：Claude Code 产出设计，DeepSeek Harness 消费设计并编码、测试，Codex 审查设计、代码和测试证据。实现问题回到编码阶段；设计问题先回设计阶段，再重新编码和审查；混合问题先修订设计。每轮交接都引用确定版本，Legion 负责工作流状态、返工路由、轮数限制和审计。

因此，provider 调用只是阶段执行手段；单纯把现有 worker 的 provider 改名不构成目标产品。工作流还要把岗位职责、Agent 工具配置、执行节点与底层模型分开管理，并冻结一次运行实际使用的定义和交接物。

## 调查结论与当前实现

用户记忆中的“创建节点并接 Claude Code、Codex”项目是 Agent Network。DSH 已有真正调用这两个产品的 provider，但当前提供一次性委派。Legion 现已把阶段工具配置冻结到目标，并把设计文件 SHA-256、实现提交 SHA 与测试证据冻结到后续阶段快照，派工前核验设计内容和待审提交；Hub 还会核对测试报告引用的完成态 Stage Attempt、provider、Run ID 和已持久化报告内容是否完全一致。typed review 按类别创建可审计返工：实现问题回编码阶段，设计问题回设计阶段，混合问题优先回设计阶段；轮数受工作流上限限制。Legion 也已支持登记本机 DSH 执行节点、心跳上报 provider/能力、阶段绑定节点与认领时核验；跨机器工作区和 Git 同步尚未支持。Workbench 的空间设置提供三阶段工具/角色/节点配置，任务详情展示阶段工具、设计版本、实现提交/测试证据与审查返工历史；真实 Claude/Codex 认证执行和整条产品闭环仍未完成，因此当前是可配置、可审计的闭环骨架，不代表真实产品完整跑通。

未知执行结果会保留 Attempt、Run ID 与工作区并将任务挂起，防止未经核实自动重派。Hub 现提供仅限 `general` 操作人的结构化核对记录，可追加 `confirmed-stopped`、`still-running` 或 `unable-to-confirm` 结论及必填依据，并在工作流历史和 Workbench 中回读。该记录是人工判断的审计证据，不是 provider 终态的技术证明；它不会把 `unknown` 改写成成功、失败或已取消，也不会自动释放工作区或重派。未知 Run 的真实终态仍需 provider 查询/恢复能力或独立运行证据确认。

本文的本地判断来自当前检出源码，不代表已发布包或客户安装环境。外部项目的运行效果未在本机复现，未使用账号运行付费编码任务。

认证必须兼容工具自身的登录态与 API 凭证两种常见方式。Claude Code 可沿用 CLI/SDK 的原生 OAuth 或 API 配置（包括 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 与兼容服务的 `ANTHROPIC_BASE_URL`）；Codex 可沿用其原生 ChatGPT 登录，也可由 DSH provider 子进程接收显式 API 凭证（如 `OPENAI_API_KEY`）并使用 Codex 支持的 provider 配置。Legion 工作流/Attempt 只冻结 provider、权限档和非秘密配置引用，不复制、序列化或回显密钥；引用在执行节点本地解析，worker 只把实际需要的环境变量交给对应子进程。DSH provider 的 `credentialEnv` 将目标环境变量映射到 DSH credential reference，避免把 API key 写入普通 provider 配置。OAuth 与 API 模式均须以 provider 实际启动结果验证，CLI 的登录状态或节点心跳不单独作为认证成功证明。

真实验收使用本机隔离的临时仓库和独立 DSH profile 即可；Docker 是可选隔离手段，不是开发阶段启动或验证工作流的前置条件。临时 profile 只引用当前用户已有的 DSH credential store，不复制密钥；运行前后核验其仅访问临时仓库、保留 diff/Attempt/Run 证据并清理临时数据。若现有账户配置无法被 provider 使用，应记录具体认证失败，不应改动用户全局 profile 或凭证。

本文同时是当前阶段协作工作流的主要设计依据。工作流按“岗位阶段 → Agent 工具配置 → 机器与工作区 → Attempt/Run → 有版本的交接物”组织；每个阶段消费明确的上游版本，审查意见按类型回流。F-23 可作为现有路由与台账代码的背景材料，不覆盖本文定义的工作流目标。独立实施计划见 [跨 Agent 阶段工作流独立完成计划](../superpowers/plans/2026-09-30-stage-agent-workflow-implementation.md)。

## 1 证据范围

| 对象 | 当前检出或来源 | 证据级别 |
|---|---|---|
| Agent Network | `D:/project/DSH/_research/agent-network`，HEAD `57f4d1ac57d1f6d46308d90137b6208c5326f1fe` | 本地文档与关键源码 |
| DSH | `D:/project/DSH/dsh/deepseek-harness`，HEAD `639ed015397290b3745d163aafe02ffee4aa3f84` | provider 注册、生命周期源码与文档 |
| Legion | 当前工作区 | 建任务、适配器、宿主端口、worker 源码；路由测试实跑 |
| xAI Grok Bot | [官方产品页面](https://x.ai/bot) | 产品公开说明 |
| Locum | [作者仓库](https://github.com/HarjjotSinghh/locum)及 `server.py` | 公开文档与实现，未实跑 |
| grok-bot-cli | [作者仓库](https://github.com/ScriptedAlchemy/grok-bot-cli) | 作者说明，未实跑 |
| Grok Bridge | [作者项目页面](https://niharnm.github.io/grok-bridge/) | alpha 能力及作者验收边界，未实跑 |

## 2 Agent Network 如何创建与接入节点

本地 README 明确列出 Claude Code、Claude Agent SDK、Codex、Grok Build。典型生命周期是 `anet node create` → 选择 runtime 与认证方式 → `anet node start` → 节点连接 Hub → 接收任务、调用自己的编码工具 → 返回回执。

架构由 Hub、节点执行器、MCP 协作工具、SSE 投递组成。MCP 让 Agent 发现队友和派活，SSE 负责把任务推给在线节点。节点身份与具体模型分开：可以让一个节点运行 Claude Code，另一个运行 Codex，并在同一网络协作。

| 接入路径 | 机制 | 可借鉴之处 |
|---|---|---|
| Claude Code CLI | 启动本机 `claude`，工作目录内配置 MCP；初次绑定 session，后续 `--resume` | 复用用户登录和已有会话 |
| Claude Agent SDK | SDK 驱动 Claude 工具循环，可配置兼容的模型接口 | 产品工具能力与底层模型选择分离 |
| Codex SDK | SDK 运行编码任务 | 封装任务结果和事件 |
| Codex app-server | 绑定、创建或恢复 thread，再发送 turn；按 thread 和 turn 过滤事件 | 长会话、多客户端协作、忙碌状态处理 |
| Grok Build ACP | 启动本机 Grok Build 的 ACP 服务 | 使用标准 Agent 协议扩展工具种类 |
| OpenCode | 本地 runtime 下包含 ACP 与共存实现 | 接入支持多模型的编码产品 |

源码入口：`agent-network/agent-node/src/cli.ts`、`agent-node/src/commhub-mcp.ts`、`agent-node/src/runtime/codex-app-server-bridge.ts`、`agent-node/src/runtime/codex-app-server/runtime.ts`、`agent-node/src/runtime/side-thread/`。文档入口：`docs-site/docs/guide/runtimes.md`。

重要校准：本地 runtime 文档存在版本口径冲突：开头记录某个 `latest` 安装实验已列出七种 runtime，后面的旧表仍写部分仅 preview。应以具体安装版本、能力探测和支持矩阵判定，不能把“菜单可选”视为生产验证。README 中的 Grok Build 也不能等同于 xAI 云端 Grok Bot。

建议借鉴节点的身份、机器绑定、runtime 配置、会话映射、在线状态和回执核对；保留 Legion 自己的任务数据库与审计，避免并行建立第二个 Hub 作为任务权威。

## 3 DSH 已经提供的外部工具调用

### 3.1 Codex

包：`@deepseek-ai/dsh-subagent-codex`，默认注册名 `codex`。

源码流程：启动包内兼容运行组件的 app-server → `initialize` → 创建 `ephemeral` thread → 开启一个 turn → 等待该 thread 和 turn 的终态 → 选择最终回答 → 回收进程。每次委派新建进程、thread、turn，无会话续接或进程池。

配置有 `providerName`、`model`、`env`、`permissionMode`、`disposeGraceMs`。模型省略时沿用 Codex 原生配置；认证也沿用产品自己的机制。环境会先移除形似凭据的父进程变量，再覆盖显式 `env`。

默认权限模式是 `never`，它表示不向人询问，并不表示完全访问。另有自动审批和显式跳过审批与沙箱的模式。默认保留原生沙箱选择。

依据：`packages/subagent/subagent-codex/src/index.ts:64` 附近的能力描述、`src/run.ts` 的握手和线程生命周期、同包 README。

### 3.2 Claude Code

包：`@deepseek-ai/dsh-subagent-claude-code`，默认注册名 `claude-code`。

通过官方 Agent SDK `query()` 启动真实 CLI，使用包内固定平台组件；源码设置 `persistSession: false`。每次独立 query 和进程，当前不提供 resume、continuation 或 pooling。

默认权限 `dontAsk`，另有 `acceptEdits`、`auto`、`plan`、`bypassPermissions`。DSH README 明确：`dontAsk` 会直接拒绝尚未获授权的操作；`acceptEdits` 接受文件编辑，其余仍需授权的操作由无人值守回调拒绝。首版设计阶段要创建/修改设计交付物，因此工作流权限档使用 `acceptEdits`，不能使用默认 `dontAsk`。它是 Claude 的工具级策略，不等同于 OS 文件系统沙箱，真实写入范围仍需在隔离环境验证。返回最终回答或失败诊断；推理、工具活动、用量与文件 diff 不进入父会话结果。若 Legion 需要这些数据，必须另建明确采集通道，不能假设父会话日志里已有。

依据：`packages/subagent/subagent-claude-code/src/index.ts:74`、`src/run.ts:330` 及同包 README。

### 3.3 ACP 通用接入

包：`@deepseek-ai/dsh-subagent-acp`。配置 `command/args/cwd/env` 和权限响应策略，执行初始化、新会话、prompt、取消与进程清理。可接兼容 ACP 的其他 Agent；需单独确认目标产品或桥接组件确实支持 ACP。

该 provider 默认拒绝权限请求，可配置自动允许；没有向 Legion 人工审批箱转交请求的现成闭环。进程独立不代表文件系统被隔离，共享工作目录仍允许真实读写。

### 3.4 安装、暴露工具和能力边界

Codex 与 Claude Code 的 provider bundle 必须安装到实际运行 Legion worker 的 DSH profile，并在安装后重启该 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex @deepseek-ai/dsh-subagent-claude-code
```

在该 profile 的 `cordis.patch.yml` 中，为 provider bundle 的默认实例写入与阶段权限档一致的原生模式，然后重启 DSH worker：

```yaml
- id: subagent-codex
  config:
    permissionMode: approve-for-me
- id: subagent-claude-code
  config:
    permissionMode: acceptEdits
```

安装命令只注册 bundle，不会自动应用这两个权限模式。Legion 节点心跳会报告实例实际解析的模式；不匹配时阶段不会派工。这个读回检查仍不替代隔离工作区内的真实文件访问测试。

现有 `scripts/legion-profile.mjs --wire` 只接线 Legion 自己的服务、worker、team-hub 和 board 包，不负责安装 DSH 的 Claude/Codex 子 Agent bundle，也不修改它们的 `permissionMode`。因此“Legion 随宿主启动”与“外部 Agent provider 已装好并匹配工作流权限”是两项独立的 profile 配置；完成前者不能推断后者。

Legion worker 直接调用 `ctx.subagents.start(provider, request)`，所以不需要另外向 DSH 模型暴露 `dsh-tool-subagent` 工具行；只有希望由 DSH 模型自行决定是否委派时，才需配置 preset 工具行。bundle 负责注册宿主 provider 并带入对应锁定运行组件，但不创建登录态，也不会回退到宿主 `codex` / `claude` 命令。Codex 和 Claude Code 的原生配置/认证仍是权威来源；权限模式要按 provider 原生行为设置。节点心跳可证明某个 provider 当前已注册及上报能力，不证明账号认证成功，后者只能由真实启动和执行确认。

当前 Codex、Claude Code、ACP 均不声明可选启动能力。Codex 和 Claude 源码都使用 `NO_START_CAPABILITIES`；不能向它们照搬 DSH 内部 provider 的 `agentOptions`、`outputSchema`、`toolFilter`、persona、深度限制。服务会校验并拒绝不支持的要求。

外部产品拥有自己的模型、规则文件、工具和审批行为；父 DSH 的工具限制不自动成为子产品的限制。必需的权限保证必须由外部产品原生政策或进程隔离实现，并验证后再执行。DSH `SubagentProvider` descriptor 已公开 Claude/Codex 实例解析后的 `permissionMode`；Legion 可将冻结权限档与该值比对并拒绝缺失或不匹配配置。但这个值来源于 provider 初始化配置，不替代真实 CLI/SDK 文件访问验证或操作系统隔离。

### 3.5 纠正旧记录

旧 F-23 文档将“本机没有 codex/claude CLI”作为真跑的前置阻碍。当前 DSH 文档明确说明两种原生 provider bundle 会带入运行组件，且不回落宿主 CLI。因此应检查实际 DSH profile 是否安装 bundle、组件和平台兼容性，以及原生认证；不能仅查 PATH。

2026-10-01 环境复核：宿主 PATH 中有 `codex.exe`，没有 `claude` 或全局 `dsh` 命令；通过 DSH 源码仓库入口执行 CLI 帮助可用。用户级 DSH `desktop`、`headless`、`web` profile 均未声明 Codex/Claude 子 Agent bundle，当前也没有运行中的 DSH 进程。因此本机还没有 Legion 节点心跳可报告外部 provider 已注册。`codex login status` 显示 Codex CLI 使用 ChatGPT 登录，但不能外推为 DSH Codex bundle 的真实认证/执行成功；Claude CLI 缺失也不能单独证明 DSH Claude bundle 无法运行。没有发起真实模型任务。

同日隔离验证：在仓库内单独的 `DSH_HOME` 创建临时 profile `legion-agent-validation`，安装同版本 `@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`（均为 `0.2.0-rc.2`）。`dsh plugin ... list` 确认三个包存在，`--dump-config` 确认 headless profile 配置中出现 `subagent-codex` 与 `subagent-claude-code` 注册行。该操作未更改用户级 profile。Headless `--help` 按其 README 在运行前退出；因此此证据只证明临时 profile 安装与配置组合成功，不证明 provider 已在 daemon 中实际挂载、认证或执行。真实模型任务仍未启动。

工作流执行取消增量：Legion worker 现在在外部阶段 Attempt 执行期间轮询 Hub 任务状态；观察到用户取消后，将取消信号传递给 DSH 子 Agent，并等待 provider 终态。只有 provider 明确返回取消终态才记录 `canceled`；若忽略取消、超时或结果与取消竞态，Attempt 保留为 `unknown`，工作区保留并停止推进/重派。fake provider 集成测试覆盖信号传播和取消终态持久化；未验证真实 Codex/Claude 进程是否响应取消。DSH 一次性 provider 仍没有跨进程 Run 查询/重启续接接口，因此 Hub/worker 重启后的未知 Run 继续需要人工核对。

## 4 Grok Bot 如何调用其他 Agent

xAI 的 Grok Bot 与开源同名 GrokBot、Grok Build 是不同对象。本次将官方产品和第三方桥接分别核验；没有发现足以证明 xAI 已公开提供一套覆盖所有编码产品的原生统一执行协议的资料。

Locum 提供一条可阅读源码的接入路径：云端 Grok Bot → 远程 MCP connector → 隧道 → 用户机器上的服务 → 已登录的官方 Claude/Codex CLI。工具包括新建任务、按 session 续接、查询、列出和取消任务。任务先返回 job id，服务排队运行，再提供结果。[Locum 文档](https://github.com/HarjjotSinghh/locum)

实现使用 Claude 的流式 JSON 输出和 Codex 的 `exec --json`，续接时校验返回 thread id。它适合借鉴异步任务 API，但默认跳过权限检查、工作目录白名单不是沙箱、原生 Windows 路径与进程处理仍需验证，不能直接作为 Legion 的权限实现。[Locum 源码](https://github.com/HarjjotSinghh/locum/blob/main/server.py)

grok-bot-cli 展示另一种方式：连接本地 Codex app-server 操作 thread；Claude 使用显式启用的 channel 接收消息并回复。其作者明确指出云端与本机不是同一环境，桥接不自动建立远程传输，Codex 控制 socket 路径目前不支持原生 Windows。可借鉴忙碌状态处理、关联回执和不重复提交未知任务的原则。[项目文档](https://github.com/ScriptedAlchemy/grok-bot-cli)

Grok Bridge 自称实验 alpha；页面记录八条配置方向中仅三条有真实交换证据，Claude、Cursor 和 Windows 等仍有未验证边界。它表明多方向交接可以实现，但不适合作为已稳定支持所有 Agent 的证据。[作者验收说明](https://niharnm.github.io/grok-bridge/)

## 5 Legion 当前接入缺口

| 位置 | 已有行为 | 缺口 |
|---|---|---|
| `runtime/contracts/harness-routing.mjs` | 显式指定 > 配置表 > 模型建议 > 默认 DSH | 只产生选择结果 |
| `team-hub/harness-store.mjs` | provider、规则、选择台账 | 注册不证明执行组件已挂载或可用 |
| `team-hub/server.mjs` Agent 工具注册与认领 | `/api/agent-tools/configs` 按 `id@version` 保存不可变执行配置；runtime Attempt 与守护任务首次认领解析完整工具配置快照，悬空配置拒绝认领；可选 review workflow 和所有阶段工具也进入快照 | Agent 工具版本在认领时解析；模型档案在目标创建时解析并冻结当前版本，仅支持具备 `agentOptions` 的 DSH 原生工具 |
| `team-hub/harness-store.mjs` 与 `/api/agent-nodes/*` | 稳定节点身份、版本、空间归属、60 秒在线窗口、实际 DSH providers 与能力；配置不存账号密钥 | 心跳使用 team-hub 现有写入认证模型，尚非独立节点凭证；未实现跨机 workspace/Git 传输或调度租约 |
| `plugins/src/index.ts` worker 派工 | 显式阶段选择现可解析冻结配置；`dsh-native` 走原有结构化调用，`dsh-subagent` 走外部一次性分支 | 普通 F-23 harness 路由仍不是阶段配置注册表；仅接入已注册的阶段配置。Workbench 空间设置现可配置三阶段岗位与 Agent 工具 |
| 同一 worker 请求 | DSH 原生路径传 `WORKER_SCHEMA` 与可选工具过滤；外部路径只传自包含文本并解析严格 JSON 报告 | 文本格式校验不等价于 provider 原生结构化输出；外部无法继承 DSH 工具过滤 |
| 同一 worker 集成模式 | 外部 provider 明确拒绝，因为 `started.localAgent` 不存在 | 需建设经验证的外部进程隔离/拦截能力，不能降级丢掉强制面 |
| `runtime/adapters/dsh/index.mjs:580` | 使用 `selection.provider`，传结构化输出与强制面载荷 | 仍需明确执行 provider 与模型 provider 的区别 |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs:960` | 转发 `subagents.start` 并安装 DSH 强制面 | 外部进程不自动经过 DSH 内部工具拦截 |

新增的通用工作流定义首段与普通阶段链分离：`runtime/contracts/agent-workflow-definition.mjs` 校验命名定义、成功路径 DAG、入口/终止阶段、阶段工具版本、输入/输出契约和审查返工目标；`agent_workflow_definitions` 以 `(scope, id, version)` 保存不可变定义，`POST/GET /api/agent-workflows/definitions` 提供注册和读取。注册时会拒绝缺失或停用的 Agent 工具版本。Workbench 闭环配置可发布新定义版本，当前 DAG 编辑器可配置阶段、岗位、工具类型、具体配置版本、节点、依赖边、输入/输出产物及审查返工路由，并可载入既有版本后发布续版；发布目标弹窗可列出可执行定义。`POST /api/goal` 已可选择命名定义，并将拓扑任务图、完整定义及已解析阶段工具/节点/模型配置快照冻结到任务、TeamPlan 和独立 `agent_workflow_instances`。模型档案按当前版本校验，只对具备 `agentOptions` 能力的 DSH 原生工具注入 provider/model/reasoning；Claude Code/Codex 使用各自原生模型设置，模型档案凭证不会传给子 Agent。目标调度按拓扑序创建阶段任务，所有入边前驱写入 `blockedBy`；阶段 ID 区分同岗位的多个阶段，汇合阶段须等待全部前驱完成。守护 worker 按冻结 stage ID 恢复阶段工具和契约，把所有上游分支产物带入上下文，并校验已声明的产物输入/输出。节点身份、工作流状态和设计/实现交接证据都在历史中保留；新增空间目录接口与 Workbench 入口支持按状态/关键词浏览、分页查看实例，并展开阶段和审查返工历史，也能暂停、恢复或取消所属目标并复用目标取消留痕语义。不可变实例定义没有直接编辑/删除操作。真实 Claude/Codex 认证执行和跨机器 workspace/Git 传输仍待实现。

工具选择现已接入守护 worker。工作流配置定义设计、实现、审查三个角色及返工上限；任务认领冻结所有阶段工具选择和上游交接快照。设计文件以仓库相对路径和 SHA-256 进入实现阶段快照，派工前重新核对字节摘要；实现阶段必须回报通过的测试摘要与隔离分支提交 SHA，审查阶段验证该提交存在于当前代码历史。`/api/agent-workflow/review` 接受分类审查结果，并在单个事务内结算审查任务、创建带冻结配置与设计引用且阻塞于审查任务的返工任务、写入不可变审查台账；混合问题先回设计，重复提交幂等，缺少分类或超过上限则保留人工处理。worker 会把报告交给该接口，并把需要澄清或超限的结果停在 `in_review`。`GET /api/agent-workflow/history` 和 Workbench 任务详情已呈现阶段工具、冻结设计摘要、实现提交/测试证据及审查返工历史；真实 Claude/Codex 的认证/权限/取消验证仍待完成。不能用路由或替身测试通过宣称真实 Codex/Claude 已被调用，也不能删除不支持的权限参数后把执行记成“已受相同约束”。

配置入口位于 Workbench 的空间设置 →「配置跨 Agent 闭环」。默认三阶段设置仍提供设计/实现/审查岗位选择和 Claude Code、DSH 本地 Agent、Codex 工具类型选择；其下的可复用 DAG 编辑器允许添加/删除阶段、选择已启用岗位与具体 Agent 工具配置版本、选择节点、声明输入/输出产物、编辑成功路径依赖边、指定审查阶段及设计/实现返工目标。已发布定义可以载入并另存为更高版本，发布目标时按所选定义创建工作流图并冻结拓扑、阶段工具配置和节点。可登记 DSH 执行节点并将阶段绑定到节点；节点需在对应 daemon 配置中使用相同 `agentNodeId`，随后心跳才会显示 provider、能力和在线状态。空间设置现将阶段所选 provider 与节点在线/能力状态对照，缺少就绪节点报告时提示安装对应 DSH provider bundle 并重启；心跳不被表述为认证证明，认证只能由真实 provider 调用确认。空间原有 `next` 边不会被重排，普通目标仍按空间阶段链运行。目标创建后的普通岗位链即使改序、删除工作流岗位或被清空，已冻结工作流中的队列任务、自动补建后继和返工仍按目标快照调度。DSH 本地 Agent 新建工具配置时需填写该 DSH 实例实际注册的子代理 provider 名，并准确声明能力。当前不支持多个节点之间的仓库工作区与 Git 产物同步；跨节点配置会被拒绝或按同一节点身份约束，不会静默切换。该界面不会自动打开空间执行守护；启用执行仍由侧栏开关控制。

provider 配置表的 `permission: allow/reject` 适合 ACP，但不足以表达 Codex 与 Claude 的原生权限模式。表中的 `command/args` 也不直接适用于使用固定运行组件的原生 provider，需要分类型配置和转换。

## 6 建议的统一接入结构

下面是建议设计，不是当前已实现能力。

将五类身份分开：员工或节点、执行机器、编码工具配置、底层模型、原生会话。一次 Attempt 保存实际选中的工具配置及版本、路由来源、机器、工作目录、原生 session/thread、权限结论。默认规则可以随时变化，但已运行 Attempt 的选择事实必须冻结，才能解释历史与恢复任务。

调用路径：任务输入 → 路由规则 → 查询执行能力和健康 → 冻结 Attempt → 构造完整工作说明 → 调用对应工具 → 采集终态与产物 → 验证 → 更新任务。MCP 可作为调用入口，ACP、SDK、app-server、CLI 是驱动产品的不同方式；单纯加入模型 API 不等于接入编码工具。

| 能力 | 第一阶段做法 | 后续扩展 |
|---|---|---|
| 编码工具选择 | 默认 DSH；单次指定与规则沿用现有优先级 | 按角色、机器、能力、预算路由 |
| Codex 与 Claude | 复用 DSH 原生一次性 provider | 单独实现长期 session adapter |
| 其他编码工具 | 注册具名 ACP provider | 无 ACP 时用专用 SDK/CLI 驱动 |
| 上下文 | 输出明确任务、规则、验收标准和产物路径 | 原生会话续接与受控上下文共享 |
| 输出 | 外层解析、校验最终回答；独立检查文件与测试 | 原生事件、用量、审批与产物采集 |
| 权限 | 能力不足拒绝；按原生政策或隔离环境验证 | 统一人工审批转交与平台支持矩阵 |
| 恢复 | 区分新 Attempt、重试和未知运行 | 持久 session 映射、回执对账、恢复 |

外层 JSON 校验可以验证回答格式，不能宣称等价于 provider 原生结构化输出保证。文件 diff 和测试结果应由独立验证阶段采集；有回答、有进程退出、有已提交回执都不能独自证明任务成功。

远程节点要显式绑定 machineId、repoId 与工作目录映射，不能直接把 Windows 本地路径发给 Linux 云端。不同机器间共享成果可通过 Git 或明确产物传输实现。复用用户认证不意味着复制认证文件或把登录凭据写入普通 provider JSON。

## 7 推荐实施顺序与验收

1. 建立阶段工作流契约和审查分类。定义 design、implement、review 的工具配置引用、阶段顺序、上游产物版本、返工类别、混合问题优先级与全局返工上限。
2. 完成实际执行接线。把每个阶段的实际工具、配置版本、选择来源、机器、工作区、权限结论和上游版本冻结到 Attempt；明确 Legion 产品名到 DSH provider 名的映射。外部一次性任务使用专门分支，避免照搬本地 worker 的结构化输出和拦截逻辑。
3. 打通 Claude Code 设计 → DSH 实现/测试 → Codex 审查，以及按审查类别回流的闭环。每次交接引用不可变设计/代码/测试/审查证据；设计有变更时强制重新实现，未知结果进入对账，不自动重复启动。
4. 在临时工作区分别验证 Codex 与 Claude 的真实加载、认证、读写权限、取消与清理，再验证完整闭环及返工路径。记录真实产品、版本、run/thread/session、结果与 diff；替身测试不能代替真实运行证据。
5. 建立可复用节点生命周期，再扩展长期会话、其他 Agent 与远程节点。健康、并发槽位、超时、续接、断线后的未知状态和重启对账需显式声明能力；Grok Bot 经公开入口或 MCP 接入，不把第三方私有 gateway 作为核心依赖。

取消验收需确认子进程和相关执行已停止；超时可能只意味着等待结束。重复请求要靠幂等键与运行对账控制，未知结果不能自动再派一份。用量未提供应记为未知，不能记成零成本。

## 8 本次验证

执行 `node --test runtime/contracts/harness-routing.test.mjs team-hub/routes/harness.test.mjs`，24 项通过、0 项失败。覆盖默认、显式、规则、建议的优先级，未知 provider 拒绝，provider 表与台账行为。

阶段工作流设计落地后，另执行 `node --test runtime/contracts/agent-workflow.test.mjs runtime/adapters/dsh/external-agent.test.mjs`，20 项通过、0 项失败。覆盖带版本的 Agent 工具配置与模型配置分离、阶段链、审查分类及返工上限，DSH 在册 provider 的一次性调用参数、工作目录和预检门槛、能力不匹配拒绝、外部 run 句柄、异常诊断脱敏、终态与资源回收，以及外部 WorkerReport 文本解析。

阶段配置接入后执行 `node --test team-hub/pipeline.test.mjs`，21 项通过、0 项失败；执行 `npm run build --prefix plugins` 后再运行 `node --test plugins/tests/space-pipeline.test.mjs`，13 项通过、0 项失败。验证了 team-hub 持久化/回读版本引用、配置变动进入管线指纹、坏版本拒绝、守护插件保留有效引用并丢弃畸形引用，以及真实 HTTP 认领将空间阶段选择冻结到 Attempt 并在重试中复用旧版本。

模型选择接线验证：`node --test runtime/contracts/agent-model-selection.test.mjs team-hub/pipeline.test.mjs` 27 项通过，覆盖已登记模型档案的冻结、旧版本拒绝、外部 Agent 拒绝模型覆盖，以及 DSH 原生 provider 必须声明 `agentOptions` 才能注入模型选择；`npm test --prefix plugins` 共 428 项通过，TypeScript 构建成功。旧工作流保留冻结的 provider/model/reasoning 值；凭证不暴露给 worker 或外部子 Agent。真实 provider 登录状态、所选模型可用性与真实运行仍未验证。

本轮闭环骨架验证：`node --test team-hub/pipeline.test.mjs team-hub/routes/agent-workflow.test.mjs` 覆盖真实 HTTP 认领冻结三阶段配置、混合审查先返设计、实现问题回编码阶段、返工任务沿用冻结 provider、轮数上限、源审查任务与返工台账一致结算、重复提交不重复派发；另有重启测试关闭并重新打开 team-hub 和同一 SQLite 文件，确认待执行返工任务的阶段快照、设计摘要与审查历史均可恢复。集中回归 `node --test runtime/contracts/agent-workflow-definition.test.mjs team-hub/routes/harness.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs` 共 51 项通过；`npm test --prefix plugins` 共 428 项通过；Team Hub 与 Workbench 构建成功。Workbench 空间设置提供标准闭环配置入口、DAG 编辑器和最近运行实例目录，可按状态/关键词分页浏览实例、打开阶段及审查返工历史，以及暂停/恢复/取消目标。模型档案接线增量验证 27 项通过；实例目录增量回归 27 项通过；实例生命周期回归 `node --test team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/goal.test.mjs` 42 项通过，覆盖取消后的在办任务留痕和实例状态同步。真实 provider 验证仍未进行；已知缺口包括不可变实例定义的直接维护、真实测试 run 身份与远程 workspace/Git 交接。

这些替身测试没有验证真实 provider 在当前安装 profile 中可运行；未复现外部项目网络、云端桥接、真实 Claude/Codex 任务、续接或真实进程取消。审查历史尚无运行面呈现。研究输出不改变既有生产执行接线与状态表。

### 2026-10-01：未知外部执行结果的恢复边界

实现核对发现，原来的租约回收会把超时或守护重启遗留的工作流阶段任务重新放回 `todo`。外部 Agent 即使没有返回终态，也可能已修改隔离工作区；自动重派会造成重复副作用。因此工作流阶段启动结果未知、超时、非完成终态或无效报告时，worker 现在挂起任务并转入 `in_review`，要求人工核对；Hub 守护启动时遇到带工作流快照的孤儿任务也转为 `in_review + hold`。普通任务的原自动回收语义不变。定时 stale 检查会留给仍可能运行的工作流 worker 自行结算，不依据租约时间猜测外部执行已停止。无 Hub 的本地 taskctl 目前不能按任务排除工作流阶段，因此遇到在办工作流时会跳过批量 stale/启动孤儿回收，保留任务现场供人工核对。

未知结果隔离现已有独立持久阶段 Attempt：调用前生成幂等 Attempt，provider 启动后绑定 Run ID；完成摘要、未知结果与 Hub 重启后的 unknown 转换都会写入记录，任务详情可回看。worker 级派工集成回归还验证 Attempt 在 provider 前持久化、Run ID 在读取结果前登记，异常终态保留 Run ID 并将任务隔离。Hub 重启回归 24 项、空间删除级联回归 5 项、Stage Attempt 路由 4 项通过；插件构建通过，相关流水线解析回归 13 项、工作流回收隔离回归 21 项通过，插件全量测试 431 项通过。Hub 生命周期测试 30 项通过；其中 claim 审计断言现覆盖 `agentNodeId: null`。仍未实现真实 provider 的状态查询、取消及 Run ID 重启对账；本轮没有执行真实 Claude Code、Codex 或 DSH provider。

### 2026-10-01 命名工作流 Git 交接与阶段推进

端到端代码路径核对发现，独立命名工作流各阶段使用 `w/<taskId>` worktree，但此前只冻结设计文件路径/摘要和实现 SHA，没有把上游 Git 对象带入下游分支；独立命名 DAG 的普通成功结算也会落入空间流水线的人工审核分支。现在每个成功的命名工作流阶段把 stage ID 与 HEAD SHA 作为 evidence 持久化。下游认领后按祖先拓扑顺序将检查点 merge 到自己的隔离分支，之后校验设计文件摘要与 Codex 待审提交祖先关系。源提交缺失、证据畸形或合并冲突会在启动 provider 前拒绝派工并保留工作区。命名 DAG 任务成功后按 Hub 已冻结的 `blockedBy` 图结算，不依赖空间普通流水线的角色顺序；显式人工 gate/集成模式仍停在 `in_review`，Codex 通过后停在 Legion 独立验证与最终验收。

此交接只在同一执行节点的共享 Git 对象库内完成；它不会把候选代码合入主分支，也不能替代跨机器仓库同步。旧 `space-pipeline` 工作流继续使用原来的空间流水线合入语义。

验证：`npm run build --prefix plugins` 成功；`node --test runtime/contracts/agent-workflow-checkpoints.test.mjs plugins/tests/handoff.test.mjs plugins/tests/worker-regression.test.mjs` 共 55 项通过，包含真实临时 Git worktree 间设计/实现提交传递、审查分支保留源 SHA、冲突回滚、命名 DAG 不生成旧角色链任务，以及独立设计阶段自动完成。`npm test --prefix plugins` 共 434 项通过；含检查点契约的跨 runtime/Hub/工作流回归共 57 项通过；Team Hub 构建成功。此处的 Agent 仍是替身；Claude Code → DSH → Codex 的真实调用、认证和返工未运行。

### 2026-10-01 三阶段闭环回归补充

worker 级替身闭环现已覆盖 Claude Code 产出版本化设计、DSH 在独立实现 worktree 消费该设计并提交代码/测试证据、Codex 在包含确切上游提交的审查 worktree 检查后交给 Legion 验收。修正了两类误判：Windows Git 的 CRLF/LF 检出差异不再导致工作流文本产物摘要失配；命名 DAG 审查检查 provider 启动后的新提交与未提交改动，而不把继承的设计/实现提交当作审查写入。普通空间工作流的原字节摘要和审查路径保持不变。

本轮验证：`npm test --prefix plugins` 435 项通过，工作流跨 runtime/Hub/空间回归 57 项通过，插件及 Team Hub 构建成功。验证使用替身 provider；真实产品认证、模型执行、外部进程取消和端到端 typed rework 仍待实跑。

### 2026-10-01 真实 DSH 宿主装载复核

额外核对隔离 provider profile 后发现，它安装了 headless、Codex 与 Claude Code bundles，但没有 Legion worker；headless 是一次性 runner，不能证明 Legion 守护已挂载。随后将仓库真实 DSH CLI 宿主夹具扩展为同时加载源码检出的 Codex/Claude provider bundles，并由真实 worker 上报节点心跳。旧夹具曾引用已移除的 `@deepseek-ai/dsh-agent-presets`，修正为 `@deepseek-ai/dsh-agent-preset-registry` 后，`node --test tests/p13-fixture/p13-host-injection.test.mjs` 14/14 通过。Hub 收到的 observedProviders 包含 `codex` 与 `claude-code`，provider 能力记录为 `outputSchema=false`、`toolFilter=false`；worker 心跳的宿主取消字段为 `cancellation=true`（best-effort，不是 provider 原生保证），节点状态为 `ready`。测试使用独立 DSH home、空任务库和临时端口；没有启动 provider run、调用模型或读取认证结果。因此现已验证真实 DSH 宿主加载与能力心跳，尚未验证认证、权限实际生效和 Agent 执行。

### 2026-10-01 当前工作区复核

重新运行命名工作流定义、Git 检查点、外部 provider 适配、取消传播、Hub/Attempt 持久化、worker 三阶段替身闭环及空间清理回归：`node --test runtime/contracts/agent-workflow-definition.test.mjs runtime/contracts/agent-workflow-checkpoints.test.mjs runtime/adapters/dsh/external-agent.test.mjs runtime/adapters/dsh/workflow-run.test.mjs team-hub/routes/agent-workflow.test.mjs team-hub/pipeline.test.mjs team-hub/spaces.test.mjs plugins/tests/worker-regression.test.mjs`，68 项通过。`npm test --prefix plugins` 为 435 项通过；真实 DSH 宿主夹具 `node --test tests/p13-fixture/p13-host-injection.test.mjs` 为 14 项通过；Team Hub 构建通过。宿主夹具证明 provider bundles 已加载并上报能力，替身闭环证明版本化 Git 交接和 typed review 路由；两者都没有调用真实模型。真实 Claude Code → DSH → Codex 执行、认证/权限效果与真实返工仍未验证。
### 2026-10-01 实现阶段测试证据结构化

按闭环验收补强实现到审查的交接：命名工作流实现阶段现在要求 testReport 同时包含实际测试命令、通过摘要和测试输出摘录，失败列表为空；通用任务 evidence 不再充当测试证据。worker 将这些字段与实际 Git 提交 SHA 一起冻结，Hub 在生成 review 快照时再次校验，Workbench 任务详情与 Codex 审查上下文展示测试命令、结果和证据。缺字段或测试失败时停在 in_review，不推进至 Codex。

该记录描述的是独立 runner 接入之前的状态，后续由下方“独立测试执行与回执”记录更新。真实 provider 运行证据仍未获得。
### 2026-10-01 阶段运行记录关联测试报告

阶段 Attempt 的结果快照保留有限字段的 testReport（passed、command、summary、evidence、最多 20 条 failures），文本经过共享密钥模式脱敏并限制长度；后续独立 runner 接入后，Attempt 同时保存由 Legion 执行的测试 receipt。下方最新记录描述独立执行凭证与 review gate；这里的初始状态仍是 Agent 自报证据。

验证：node --test team-hub/pipeline.test.mjs team-hub/routes/agent-workflow.test.mjs 共 28 项通过，覆盖 Hub 重启后恢复关联测试报告及输出脱敏；Team Hub 与 Workbench 构建通过。

### 2026-10-01 独立测试执行与回执

实现阶段的测试不再只依赖 DSH Agent 自报。不可变工作流定义冻结测试 executable、argv 和超时；执行器只接受固定工具 allowlist 与无 shell 参数，在实现 worktree 内运行，限制继承环境和输出，并处理超时及子进程树清理。worker 在 Agent 结束后先提交实现代码并冻结 Git HEAD，再运行该命令；如果退出状态失败或未知、HEAD 漂移，或测试改动了工作树，任务不会交给 Codex。

Legion receipt 用唯一 test-run ID 绑定实际命令、源提交 SHA、阶段 Attempt、provider Run、执行节点、退出码、时间和输出摘要/摘录。Hub 在 Attempt 终结时核验 receipt 与冻结执行配置、Run、节点相符，并直接从 receipt 生成权威测试摘要和输出证据，避免 Agent 报告里的任意文字被误当成实际测试输出；原 Agent 自报 testReport 另存为参考记录并脱敏。review 快照再核验 receipt、实现证据和持久 Attempt 结果完全一致。Codex 上下文和 Workbench 阶段详情会展示独立凭证与分别标注的 Agent 自报结果。

验证：独立 runner、工作流定义和 receipt 契约 23 项通过；runner 还在临时 worktree 实际执行了 `npm test` 项目脚本；`team-hub/pipeline.test.mjs` 24 项通过；Claude Code → DSH → Codex worker 替身闭环通过，检查了真实子进程测试、超时进程树终止、实现提交 SHA 绑定、Attempt 持久化、receipt 与 Agent 自报分离及传给 review 的验证结果。失败路径覆盖两种情况：独立测试失败，以及测试命令自身通过但修改冻结 worktree；两者都会留下失败 receipt、阻止 Codex 启动且不生成实现交接证据。Hub 会从 receipt 派生权威测试摘要，并单独保留脱敏后的 Agent 自报。Windows runner 以 Node 直接启动 `npm-cli.js`，不再经 `cmd.exe`；Windows 上 `pnpm`/`yarn` shim 因需要 shell 会被拒绝。插件全量 442 项通过，`team-hub/pipeline.test.mjs` 24 项通过，Workbench 构建通过。另在 DSH 源码仓库运行 Claude Code 与 Codex provider 单元测试 97 项通过，覆盖权限配置校验、Claude SDK permissionMode 传递、Codex app-server 审批/沙箱字段映射和进程生命周期；这验证 provider 代码路径，不验证用户 DSH profile 实际加载值、账号认证或真实执行。测试 worktree 和环境变量过滤不是 OS 安全沙箱，测试代码仍以 worker 运行账户权限执行，可能访问工作树外文件或网络；真实闭环验收需在可丢弃的 OS 用户或容器中运行。所有 Agent 调用仍使用替身；本机当前未发现 DSH/Claude 命令或运行中的 DSH 进程，因此未验证真实 Claude Code、DSH 子 Agent、Codex 的认证、权限、取消与返工行为，也未验证真实 DSH provider 环境下 runner 的依赖和权限表现。

## 2026-10-01 接入实现复核：权限配置需核验到运行实例

DSH Codex 与 Claude Code provider 现在在注册 descriptor 上公开从实例 `ResolvedConfig` 读取的 `permissionMode`。Legion 将 provider 心跳模式与工作流冻结的权限档精确对照，并在 Hub 派发/认领及 worker 启动前重复核验；缺失或不符时不启动。首版 Codex 工作区写入档映射至 `approve-for-me`（明确包含 `workspace-write` sandbox），Claude 设计文件写入档映射至 `acceptEdits`。Claude provider 的默认 `dontAsk` 会拒绝未获授权操作，不适合需要创建设计文件的阶段；`acceptEdits` 允许文件编辑，但并非 OS 级工作区隔离。Workbench 显示已观测的 provider 权限模式；节点缺少 provider 时展示安装命令，模式不匹配时展示可直接复制到 DSH profile 的 provider 配置片段。Legion 定向权限/路由/worker 回归 75 项通过；真实 DSH 宿主夹具使用临时 profile 显式设置 Codex `approve-for-me`、Claude `acceptEdits`，节点心跳读回两者的实例模式，14 项通过。该宿主检查没有启动 provider run 或模型请求。DSH provider 单测 97 项、Team Hub 构建通过；Workbench 本次构建通过（存在既有大 chunk 提示），插件全量回归为 442 项通过。

这是实例配置一致性证据，不是原生工具实际拒绝越界访问的证明。真实 Claude → DSH → Codex 正常闭环、typed 返工、取消及权限效果仍须在专用临时仓库与独立 DSH profile 中运行验证；本机临时目录与 profile 足以作为开发验收环境，Docker/可丢弃 OS 用户是可选的额外隔离手段。

## 2026-10-01 认证兼容与本机验收口径修正

Claude Code 与 Codex 的接入需要同时保留产品原生 OAuth 登录和 API 凭证配置。Claude 支持沿用 CLI/SDK 原生认证，也支持向 Claude 子进程传入 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，并将非秘密的 `ANTHROPIC_BASE_URL` 放入 provider `env`；Codex 既可沿用 ChatGPT 登录，也支持通过 `OPENAI_API_KEY` 等显式环境变量运行 API 路径。DSH Claude/Codex provider 新增 `credentialEnv`：配置只保存环境变量名到 DSH credential reference 的映射，执行时从 `ctx.credentials` 取值后放入该 provider 子进程环境；secret 不进入 workflow definition、Attempt、日志或普通 YAML provider 配置。API endpoint 等非秘密配置仍走 `env`。Codex 的自定义 provider/endpoint 还须由 Codex 原生 provider 配置支持，不能仅凭传入 key 推断兼容。

本机预检确认用户已安装 Claude Code，Claude 当前认证状态由 CLI 报为 first-party OAuth，同时其本机设置包含 API token/reference 与自定义 endpoint 配置（这里只记录字段存在，不读取或复制值）；Codex CLI 当前使用 ChatGPT 登录。两条产品原生认证与 DSH provider API-key 注入都纳入验收矩阵。真实调用继续使用本机临时 Git 仓库和独立 DSH profile，引用已有本机凭证存储；不要求 Docker，不改用户常用 profile。已补 DSH provider 环境凭证映射及两个包的测试/配置 schema；Claude Code/Codex 定向测试 99 项通过，凭证解析与子进程环境传递已由 provider 测试覆盖。随后在临时 Git 仓库执行真实 Claude CLI 请求，当前默认模型名和显式设置中的基础模型名都被现有自定义 endpoint 以 404 拒绝，CLI usage 返回 0；只读 `/v1/models` 探测同样返回 404，故模型清单路由未知，未改动用户设置，且没有生成文件。Codex CLI 原生登录也在临时仓库发起真实请求，但模型目录刷新与 Responses 请求多次超时，未写出文件，重连后已中止。Claude/Codex 的真实成功调用与端到端闭环仍未完成。

## 2026-10-01 CC Switch 本地路由复核与真实 Claude 阶段

更正前述直连 endpoint 的预检结论：用户说明 Claude 请求由 CC Switch 本地路由，截图显示 Claude 已启用，本机 `127.0.0.1:15721` 监听进程为 CC Switch。之前直接访问 `settings.json` 中的上游地址绕过了路由；此前 models 查询还把 `/v1` 重复拼接，相关 404 不代表本地路由不可用。检查 `settings.json` 后确认模型配置与用户提供内容一致，另有 `ANTHROPIC_AUTH_TOKEN` 字段（值未读取或回显），没有其他 model 覆盖。

用临时 `--settings` 将该次 Claude 调用的 `ANTHROPIC_BASE_URL` 指向 CC Switch 本地地址后，`/v1/models` 探测返回 HTTP 200、无模型 ID；真实 Claude CLI 调用成功，在临时 Git 仓库生成 `design.md`。CLI 报告模型 `claude-opus-5[1m]`、first-party provider、约 0.13 美元 usage。产物仅在临时仓库，未改用户全局设置。该结果验证 Claude CLI 经 CC Switch 本地路由的设计阶段读写；尚未验证 DSH provider 使用同一路由，也没有 Legion Stage Attempt/Run 记录。Codex 本机登录请求仍超时，且截图中 Codex 路由关闭。后续闭环验收继续使用临时仓库/Profile，不要求 Docker。

### 2026-10-01 本地路由修正与 Claude → DSH 两阶段实跑

修正较早把自定义上游 `ANTHROPIC_BASE_URL` 当作调用路径的预检记录。用户说明 CC Switch 在本机 `127.0.0.1:15721` 路由 Claude 且已启用；CLI 设置中的 token/model 字段与提供的截图配置一致。之前 `/v1/models` 对上游 URL 的探测绕开了路由，而且重复追加 `/v1`，其 404 结论作废。通过 Claude CLI 本次调用的 `--settings` 将 `ANTHROPIC_BASE_URL` 指向 CC Switch 本地地址，成功生成临时仓库 `design.md`；CLI 报告模型 `claude-opus-5[1m]`、first-party provider、约 0.13 美元 usage。全局 settings 未修改。

随后在同一个临时 Git 仓库运行本机 DSH 已构建 CLI 的 `headless` profile。DSH 读取 `design.md`，生成 `index.mjs` 与 `index.test.mjs`，并自报按设计实现；主 Agent 随后检查实际源文件并运行 `node --test`，15 项通过；另直接运行脚本核对样例输出 `The quick brown fox jumps over the lazy dog\n`。设计文件未修改。这个实跑使用现有 DSH headless profile，但 Agent 的工作目录和 Git 仓库均为临时副本；它验证了 Claude CLI → DSH 工具接力与真实文件读写，不等于 Legion 工作流运行。当前没有 Legion 阶段 Attempt/Run 绑定，也未得到 Codex review。CC Switch 截图显示 Codex route 关闭；此前 Codex CLI 请求超时，因此第三阶段尚未完成。Docker 不需要。

### 2026-10-02 后续回归与真实接力状态

继续验证当前工作树中的命名 Agent 工作流：排除旧 `runtime/adapters/dsh/parity.test.mjs` 后，DSH runtime adapter、workflow contract、Hub stage-attempt 路由和独立测试 runner 的定向套件共 192 项通过；`plugins/tests/worker-regression.test.mjs` 中 Claude design → DSH implementation → Codex review 的版本化替身闭环 1 项通过。Legion 真实 DSH 宿主注入夹具 14 项通过。DSH Claude Code/Codex provider 定向 Vitest 99 项通过，相关 TypeScript project build、配置目录生成检查和 74-package dependency policy 检查通过。

扩大扫描包含旧 `parity.test.mjs` 时有失败：该测试依赖 `plugins/src/index.ts` 中旧的 `ctx.subagents.start()` 行号和选项集合，而当前工作树已将派工改为新的 workflow/provider 路径；失败发生在该测试对旧路径的漂移定位断言，不能据此判定上述新工作流测试失败，也没有在本轮重写旧 parity 测试。需单独决定并修复该测试的基准语义后再纳入全套回归。

真实 provider 证据边界未变：Claude CLI 经 CC Switch 在临时仓库生成设计、DSH headless 按设计生成代码且 `node --test` 15 项通过；这两步仍未经过 Legion Stage Attempt/Run。Codex CLI 只读 review 再试一次后仍经历五次请求超时，本次无产物且已停止重试。尚未取得 Legion 持久化 Attempt/Run、Codex 实际 review 或跨 Agent typed rework 的真实模型证据。

补充验证：`npm test --prefix plugins` 全量 442 项通过（该命令覆盖 Legion plugins suite，不包含上述 runtime legacy parity 用例）。

### 2026-10-02 DSH provider 真实调用复核

前述“Codex CLI 五次请求超时”记录对应未启用系统代理的调用；用户确认 Clash Verge 系统代理开启后，改用实际 DSH provider 路径验证。系统代理开关为启用、进程 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 均未设置，Clash `127.0.0.1:7897` 监听端口可连接。DSH Codex bundle `@openai/codex@0.153.4` 的 `subagent-codex` 以 `systemProxyMode: system` 启动真实 `app-server --stdio`，请求成功返回 `DSH_APP_SERVER_PROXY_OK`。这确认请求在该模式下可通过系统代理完成；Codex 仍输出 `respect_system_proxy` 开发中警告。

2026-10-02 针对目标节点再次进行独立网络验收：使用 DSH `subagent-codex` provider 的真实 `ctx.subagents.start()` 路径，配置 `systemProxyMode: system`、`gpt-5.5`、`permissionMode: never`，请求完成并返回 `LEGION_SYSTEM_PROXY_CONNECTIVITY_OK`。同日 `tests/p13-fixture/p13-host-injection.test.mjs` 14 项通过，真实 DSH worker heartbeat 上报 `systemProxyMode: system`。这关闭“本目标节点代理网络可达性”检查；不代表其他节点已验证，也不改变 Codex CLI 对 `respect_system_proxy` 的开发中标记。

第一次不覆盖模型的调用失败于 HTTP 400：该旧 bundle 继承本机默认 `gpt-6.1-sol`，服务端表示当前 ChatGPT 账户不支持这个 model ID。随后显式选择该 CLI catalog 中可用的 `gpt-5.5`，系统代理模式下的 DSH provider 请求完成。另在临时 Git 仓库真实调用 DSH `subagent-claude-code`，通过单次 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` 使用已启用的 CC Switch Claude 路由和 `acceptEdits`，成功生成设计文件。临时仓库均已清理；未修改用户级模型、代理、Codex/Claude 配置。

现有证据证明 DSH Claude 与 Codex provider 可以在各自配置下真实认证、执行和返回，Codex 系统代理路径可达；不证明 DSH 内部实现、独立测试、Codex review 与 typed rework 已形成一个真实闭环。随后首次经 Legion API 发布真实 Claude→DSH→Codex 工作流：Hub 持久化 workflow、三阶段任务、Claude Stage Attempt 与 provider Run ID；Claude 在隔离 worktree 写出设计文件，但 DSH 返回 `stopReason=error`，Attempt 正确留在 `unknown` 且任务被隔离，尚无编码、测试回执或 Codex review 证据。六个 design Attempt 后续均经 Hub 历史追加 `confirmed-stopped` 对账；每次仍保留 `unknown`，任务仍 hold，未自动重派。设计文件经过人工阅读，但未被当作已完成阶段。

该运行还揭示 Legion 丢弃了 DSH `SubagentResult.diagnostic` 的诊断缺陷；现已修复 adapter/worker 透传受限单行诊断，保持未知结果隔离策略。插件全量套件 442/442、外部 Agent adapter 12/12、provider Attempt/Run 失败路径回归 1/1 通过。完整阶段状态、代理验收边界和后续真实闭环门槛见[独立工作区实施计划](../superpowers/plans/2026-09-30-stage-agent-workflow-implementation.md#2026-10-02-legion-持久化真实阶段首次尝试与错误诊断修复)。

后续 Attempt 2–6 继续保留 `unknown` 并逐次追加 Hub `confirmed-stopped` 对账。Attempt 2 暴露 `acceptEdits` 下的交互审批拒绝；prompt 加入外部 design/review 不使用 shell、无需命令、完成后直接报告后，Attempt 4 诊断为 SDK success 但 result 为空。DSH Claude provider 增加受限恢复逻辑：仅当 SDK 有非错误终态且提供完整顶层 assistant `end_turn` 文本时才采用该文本；仍由 Legion 严格解析 WorkerReport。定向 provider 测试 43/43、TypeScript build 和 bundle build 通过。真实 Attempt 5 与 6 均确认没有 assistant `end_turn` 文本，仍返回 `unknown` 并被隔离；设计文件在独立 worktree 存在但尚未计作已完成阶段。当前证据指向所选 CC Switch / deepseek Claude Code 路由在工具回合之后没有最终文本；真实三阶段闭环仍未通过，未推进编码/测试/Codex review。下一步须解决该 endpoint 对 Agent SDK tool-use 回合的结束行为或更换兼容路由后再继续，避免无新增诊断的重复调用。细节及限制见[实施计划](../superpowers/plans/2026-09-30-stage-agent-workflow-implementation.md#2026-10-02-claude-空结果诊断fail-closed-兜底与重试核验)。

同日后续复核再次确认 Windows 系统代理 `127.0.0.1:7897` 可连接，且进程代理环境变量未设置。用 DSH 捆绑 Codex CLI `0.153.4` 真实执行只读 `exec`，显式启用 `respect_system_proxy` 并指定 `gpt-5.5`，收到精确探测串 `LEGION_SYSTEM_PROXY_CONNECTIVITY_RECHECK_OK`。CLI 仍提示该功能开发中，另有模型目录刷新和推荐插件目录告警；模型请求本身成功完成。该结果只覆盖当前目标节点和本次登录/模型配置。

2026-10-02 交接路径回归修复：独立 workflow worktree 可能位于仓库根目录外，版本化阶段产物现在相对冻结 worktree 登记；Hub 下游快照会丢弃 append-only 历史中的绝对 file artifact，只消费有 SHA-256 且路径为相对路径的产物。插件全量 442 项与 Hub pipeline 24 项通过。P13 T-001 设计提交/摘要经复核后，修正 Hub 产物路径并补入冻结提交证据；T-002 现能正确导入设计上下文，但 DSH native `spawn` Attempt 以未知错误结束并保持隔离，未生成代码。详见[实施计划](../superpowers/plans/2026-09-30-stage-agent-workflow-implementation.md)。

凭据安全状态更正：2026-10-02 的一次本机凭据检查误将 credential file 中的 API-key 值输出到会话工具结果中；不记录、不复用这些值，要求用户在本机轮换后再继续真实 API-key 验收。早期研究段落关于未读取/未输出凭据的陈述仅适用于早期检查，不适用于这次操作。
