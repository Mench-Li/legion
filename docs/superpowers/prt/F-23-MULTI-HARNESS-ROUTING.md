# F-23 多 Harness 路由 —— 立项与核实（2026-09-24）

> 业主指令（逐字）：「23要仔细确认，因为 **Deepseek harness 本身应该支持接入 codex/claude code**，做成**配置表 + prompt** 形式，用户可以设置**默认哪些任务交给哪个 harness 产品**，也可以**单次任务里指定使用**，**如不指定，默认使用 deep seek harness**。」

本文件是**核实结果**，不是设计定稿。结论先行：**上面那条判断成立，且比"应该支持"更强 —— DSH 里已经有两个现成的 provider 包。**

**当前设计口径（2026-09-30）**：用户明确要求 Claude Code 设计 → DSH 编码与测试 → Codex 审查的阶段协作与返工闭环，详见 §14。§1～§13 保留此前核实与施工记录；其中“整项任务选择一个工具”、本机 CLI 缺失及不保存执行选择的旧口径，由 §14 的设计与事实校准取代。当前实现进度与未完成项见 §14.7。

## 1. 核实：DSH 到底支不支持

`D:\project\DSH\dsh\deepseek-harness\packages\subagent\` 下的包（目录实测）：

```
subagent                    ← seam 本体（provider 注册表 + 一次性委派 + 可续子代理）
subagent-codex              ← ★ 现成：Codex
subagent-claude-code        ← ★ 现成：Claude Code
subagent-acp                ← 通用：任何 ACP agent
subagent-dsh-sdk / -spawn-in-process / -fork-in-process / -in-process-driver
tool-subagent / tool-subagent-control
```

**逐字证据**（各自的 `README.md` 首段）：

- `subagent-codex`：「The one-shot **Codex** subagent provider … should run in a genuine, **unattended Codex session**」
  —— 接线方式：「Mount this provider when a delegation should **run as a real Codex session in the parent's workspace**」
- `subagent-claude-code`：「should run as a fresh, **unattended Claude Code session** in the parent workspace」
- `subagent-acp`：「choose it when delegation needs process isolation or **a non-Harness ACP agent**」
  —— 配置面：`command`（必填，"the child ACP agent"）+ `args` + `cwd` + `permission`（默认 **`reject`**）+ `env`

⇒ **结论**：接 Codex / Claude Code **不是"要新造的能力"**，是 DSH 已有的两个 provider 包；Legion 这一项要做的是**路由与配置**，不是协议。

## 2. 核实：能不能"单次任务里指定"

能，而且是 seam 的**原生形状**。`docs/subsystems/subagent.md` 逐字：

- 「The tool layer builds this request from the model input and its own config; the service **validates it against the named provider** before `start`」
- 「A provider advertises its **start-time** features on a static descriptor the service checks **BEFORE a one-shot run exists**」

⇒ 委派请求里可以**指名 provider**，服务在起跑前按**该 provider 的静态能力描述**校验 ✓。

★ 同时注意一条**与本次设计直接相关**的边界（`subagent-acp` README 逐字）：ACP provider
「advertises **no optional start-time capabilities**, so the seam **rejects** requests for `agentOptions`, structured output, depth caps, tool filters, or personas rather than **silently omitting** them」
⇒ **能力不足是具名拒绝，不是静默降级** —— 这与 Legion 自己 `runtime/contracts/adapter.mjs` 里那条
「任何必需能力缺失都返回 `UNSUPPORTED_CAPABILITY`，**不得静默降级**」是同一条纪律 ✓✓。

## 3. 本机现状（外部输入）

| 命令 | 结果 |
|---|---|
| `claude` / `codex` | **（本机没有）** |
| `claude-code-acp` / `codex-acp` | **（本机没有）** |

⇒ **路由与配置这一层不受影响**（可写判据、可用替身）；**真跑一次 Codex/Claude Code 会话在本机不可达**，要装 CLI（外部输入，与 F-25 的凭据同类）。

## 4. 你那条需求映射到已有形状

| 你的要求 | 落到哪 |
|---|---|
| 配置表 | provider 清单（DeepSeek Harness / Codex / Claude Code / 任意 ACP）+ 各自的 `command`/`args`/`permission`/`env` |
| 默认：哪些任务交给哪个 harness | 一张「任务类型 / 角色 ⇒ provider」的**结构化**表 |
| 单次任务里指定 | 委派请求里**指名 provider**（seam 原生支持 ✓） |
| 不指定 ⇒ DeepSeek Harness | **显式默认值**（★ 与"静默降级"是两回事：默认是**写下来的**，降级是**没写下来的**） |

## 5. 待你裁决的一处（我不猜）

**"prompt 形式"具体指什么？** 三种读法：

1. **路由规则写成自然语言**，由模型读它决定用哪个 harness。（灵活，但同一条任务两次可能路由不同 ⇒ **判据不可复跑**）
2. **路由表是结构化配置（权威），prompt 只携带"本次用哪个"这个显式参数**。（可复跑、可审计）
3. ②为主 + ①作为**兜底建议**（模型只能建议，选定仍走表）。

★ 我的建议是 **②**：理由是 ① 会让"同一条任务路由到不同 harness"成为常态，而本仓对
F-21 已经裁过同一类事（**权威只能有一个**）；prompt 可以是**输入**，不能是**权威**。

## 6. 下一步（确认完 §5 就开工）

1. 在 Legion 侧读清"谁把 provider 名传下去"（`tool-subagent` 是否把它作为参数暴露给模型）。
2. 配置表的落点：与 F-25 同一处（hub 侧配置 + 读写路由），以及**未配置时的失败姿态**。
3. 判据：不指定 ⇒ DeepSeek Harness；指定 ⇒ 指定者；**指名不存在的 provider ⇒ 具名拒绝**（不得回落到默认）。
4. ★ 真跑两件事要外部输入：装 `codex` / `claude` CLI。

## 7. 业主裁决（2026-09-24）与第一刀

> 逐字：「采取3，即2为主，1兜底」

**优先级（已固化成代码，不是文档约定）**：

| 序 | 来源 | `source` | 说明 |
|---|---|---|---|
| ① | 单次任务显式指定 | `explicit` | 压过配置表 |
| ② | **配置表命中** | `table` | **权威**；命中时建议不许插手 |
| ③ | 模型建议（兜底） | `suggested` | 必须在册才采纳 |
| ④ | 默认 | `default` | 不指定就是 DeepSeek Harness |

**两条不许让步的规矩**：

1. **指名不在册的 provider ⇒ 具名拒绝，绝不回落到默认。** 静默回落是最坏的一种：任务被送去别的 harness 跑完了，而调用方以为用的是自己指定的那个。
2. **建议不是权威**：只有在册才被采纳，且**来源如实记账**（`source`）——否则"这条任务当初为什么交给它"没人说得清。权威只能有一个。

**错误分两处**：启动期（构造即抛）——默认不在册、某条规则指向不在册 provider；运行期（具名拒绝）——本次指定/建议不在册。

**第一刀交付**：`runtime/contracts/harness-routing.mjs`（纯结构，不做 I/O）+ `harness-routing.test.mjs`（8 例）。

**下一刀**：把它接进运行面的派工路径（谁在派工时调 `resolve()`），以及配置表的落点（hub 侧，与 F-25 同处）。★ 真跑 Codex / Claude Code 仍需装 CLI（本机没有）。

## 8. 第二刀：配置表落点 + 判定进入生产可达面（2026-09-24）

| 件 | 说明 |
|---|---|
| `team-hub/harness-store.mjs` | 配置表两张表：`harness_providers`（名字 + `command`/`args`/`env`/`permission`/`enabled`）、`harness_rules`（任务类型 ⇒ provider） |
| `team-hub/routes/harness.mjs` | 7 条路：provider 增删列、规则增删列、**`POST /api/harness/resolve`（派工前问一句"这次交给谁"，返回 `{provider, source}`）** |
| `team-hub/routes/harness.test.mjs` | 10 例 |

**三条钉死的性质**：

1. **默认 provider 永远在册、不可摘除、不可被规则悬空** —— 摘它报 `protected-default`，停用它会被规则写入拒绝。
2. **判定是现读配置表的**（不是启动时的快照）：改了表，下一次判定立刻变 —— 判据里真的改了再判一次。
3. **规则指向不在册 ⇒ 写入当场拒**：错误发生在改配置的人面前，不是发生在派工时的别人身上。

**仍是 🟡 的原因（写清楚）**：本刀把判定放上生产路径，但**还没有**把它接进真正建任务/起 Run 的那条路。
接入那一步要同时定"source 记进哪条审计"，所以留作下一刀。

## 9. 第三刀：来源如实记账（2026-09-24）

| 件 | 说明 |
|---|---|
| `harness_decisions` 表 | 每次判定落一条流水：输入（taskType/requested/suggested）+ 结果（provider/source/accepted）+ 时间 |
| `POST /api/harness/resolve` | 判定**即入账**，**成功与被拒都记** |
| `GET /api/harness/decisions` | 台账可查（按时间倒序） |
| `team-hub/routes/harness.test.mjs` | **13 例** |

★ **被拒的那条尤其要紧**：它记的是 `source = unknown-provider` 这样的**具名理由**，不是"失败"两个字。
一次"指名了一个不在册的 provider 所以没派出去"，如果只活在调用方的返回里，事后就只剩一句"那次没跑成"。

★ 入账**永不抛**：台账坏了不该让路由本身失败 —— 判定的成败由返回值决定，由流水记录。

## 10. 派工接线：还差什么（锚点已定位，不是猜的）

本刀把**记账**那一半做完了；**派工**那一半要动的是 `team-hub/server.mjs` 里那三处：

| 锚点 | 位置 | 要做什么 |
|---|---|---|
| `createTask()` | `server.mjs:4176` | 建任务的**唯一**对外入口（L573 注释逐字如此），在这里调 `resolve()` |
| `INSERT INTO tasks (...)` | `server.mjs:4167` / `:4190` | 任务表**没有** harness 列 ⇒ 要加一列（或把 provider 只记进审计，先不加列） |
| `auditEvent()` | `server.mjs:4650` | `source` 记进哪条审计，本刀定的落点就是它（`broadcastAudit(auditEvent(...))`，`server.mjs:2352`） |

★ 为什么本刀**没有**顺手改它：那是一个 5500+ 行的文件，且"加列"是 schema 变更（既有任务行、既有读方都要照顾）。
前两刀的纪律是"读准了再动" —— 这一处的读法（既有 INSERT 的完整列清单、`claimedRound`/`soldier` 这些列谁在读）**我还没有读**，
所以不猜着改。**下一刀的第一件事就是把它读全，然后再动。**

## 11. 第四刀：判定函数已落（server 侧接线**待做**，2026-09-24）

**本刀交付**：`harness-store.mjs` 的 `routeForTask()`（可直接测，判据 15 例）+ 本节。**server 侧那一行调用没有落** —— 原因如实记在下面。
调度物化、目标分解、API 都走它）。接线在 **INSERT 之前**。

**唯一的承重读数**：**指名了不在册的 provider ⇒ 拒建这个任务**（具名理由，不回落默认）。
★ 若只"记一笔然后照建"，调用方拿到的仍是一个被交给别人的任务，而"指定"就成了没有后果的话。

**没指名 ⇒ 不阻断建任务**（配置表/默认是权威，不是关卡）。

**★ 为什么 server 侧那一行没落（三次尝试，两次被门禁咬住）**：
`team-hub/server.mjs` 里有多处**源码注释手钉**「原文在 `server.mjs` 第 N 行」的引用，
由 `boundary-facts.test` 的 **㉓** 守着。我第一次把调用插在 `createTask()` 之后（+28 行）⇒ ㉓ 红「4 条一条都没对上」；
改成 helper 放 EOF、调用并到第 4166 行同一行 ⇒ **仍然红**（那条手钉引用钉的正是那一行）。
⇒ 这说明**正确做法是先把那 4 条引用读出来、（必要时）连同引用一起更新**，而不是"想办法绕开位移"：
*一个"想办法不碰到那些行"的改法，与一个"读清哪些行被钉住、按规矩一起改"的改法，在**今天的判据**上可能都是绿的——只不过前者在下一次编辑时还会撞同一面墙。*
**下一刀第一步**：打印 ㉓ 解析到的那 4 条（文件 + 行号 + 原文），读清后连同引用一起更新，再把调用接上。

**判定结果不落进任务行**（任务表**没有**加 `harness` 列）：它是 `harness_rules` 的**推导值**，
规则一改就过期 —— 与连接器声明里删掉 `risk` 是同一条纪律。追溯看 `harness_decisions` 流水。

**每进程一份 store 句柄、同一个 `db`**：与路由族那份互为两张视图，不是两张表。

**测试**：`routeForTask` 可直接测（不经过那个 5500 行文件），server 侧只剩一行守卫。

## 12. ★ 订正（同日）：一处我说错了的读数

第五刀那条提交信息里我写了「**净位移严格为零**」—— **那是错的**。
自证输出已经把真相打出来了（`4177…5000` 全部不同），而我当时没看住那个数：
我把**一行换成了两行**（多了一行注释），于是 **4177 行之后整体 +1**。

**影响（实测，不是推断）**：`boundary-facts` 的 `source-original-citations-on-line` 报出的条目
与改动前**逐字相同**（3 条：两条 `product/launcher/legacy-data-adoption.*` → `launcher.mjs:108`、
一条 `runtime/adapters/dsh/port.mjs:46` → `plugins/src/index.ts:1766`），**没有新增** —— 
因为 `server.mjs` 在 4177 行之后**没有**被任何手钉引用指着（台账那条 `server.mjs:2395` 在它之前）。

**已修**：把那一处压回**一行**（注释并到行尾），于是相对 `267ed25~1` 的真实位移确实为零。

★ 值得记的不是"少了一行"，而是**我为什么会在提交信息里写下一个自己没核的数**：
我把"行数只多了 EOF 那几行"当成了"中间没位移"，而这两件事在输出里长得**很像**。
*一个"看起来只加了尾巴"的改动，与一个"中间悄悄 +1"的改动，在"总行数变多了"这个读数上是同一个东西 ——
分得开它们的只有逐行比。*

## 13. 兜底那一半（裁决「2 为主、1 兜底」）

`routeForTask({ taskType, requested, suggested })` ⇒ 配置表**没命中**时才轮到**建议**，且建议**必须在册**
（不在册同样具名拒绝、不回落）。`createTask({ harnessSuggestion })` 把它送下来。
四条来源都如实进 `harness_decisions` 流水：`explicit` / `table` / `suggested` / `default`。

★ 为什么顺序不能反：反过来的话，"表是权威"这句话在**建议与表同时存在**时就是假的 —— 
而那时的读数（"这次用了建议"）看起来完全正常。判据里专门有一条钉这个次序。

★ 施工记录（诚实）：这一刀落过两次。第一次落进工作区后，仓库被并行会话的自动合入带进了 rebase，
重放过程中我误判"store 的 `suggested` 已在（其实那 7 处都在 `recordDecision`/表结构里）" —— 
直到重读 `routeForTask` 的**签名**才看清它还是旧的。*"同一个词出现了 N 次"与"这一个函数收了这个参数"，
是两件事；把它们混起来的读数看起来同样令人放心。*

## 14 阶段级 Agent 工作流设计

### 14.1 用户目标与设计范围

用户要求：方案由 Claude Code 设计，推给 DeepSeek Harness 编码，最后由 Codex 审查，形成闭环。F-23 因此扩展为**同一工作流内各阶段选择不同 Agent 工具，并根据审查结论返工**。仅有角色到 provider 的路由表不能完成该目标。

产品意图和外部项目能力边界以[外部 Agent 工具接入能力与 Legion 接入方案](../../research/external-agent-tools-2026-09-30.md)为准；本节定义 Legion 的工作流行为，独立实施计划记录当前代码状态与验收顺序。外部项目说明可借鉴节点、adapter、异步任务和回执机制，不表示 Legion 直接采用其任务状态机或已具备相同能力。

```text
Claude Code 设计方案
        ↓
DeepSeek Harness 编码与测试
        ↓
Codex 审查方案符合度、代码与测试证据
        ├─ 通过 → 独立验证与验收 → 完成
        ├─ 实现问题 → DSH 修复 → Codex 复审
        └─ 设计问题 → Claude 修订方案 → DSH 实现 → Codex 复审
```

该图描述目标行为，不是现有运行能力。各阶段沿用 Legion Task、Attempt、Run、租约与审计，不建立另一套任务权威。首版可使用一次性外部 provider，依靠明确的交接包继续工作；原生会话续接是后续增强项。

### 14.2 岗位与工具配置

岗位定义工作职责，Agent 工具定义执行产品，模型定义该产品内部使用的推理模型。三者独立：设计岗可以使用 Claude Code，也可以由用户改成 Codex；使用某个模型 API 不等于接入该模型对应的编码工具。

| 阶段 | 默认工具示例 | 必需交付 |
|---|---|---|
| design | Claude Code | 方案、接口约定、文件影响范围、验收标准、未决事项 |
| implement | DeepSeek Harness | 代码版本与 diff、测试命令及结果、实现说明 |
| review | Codex | 审查所用方案和代码版本、通过与否、问题类型、位置与验证方法 |

新增工作流配置保存各阶段的岗位、工具配置引用、阶段提示词与交付契约，以及返工次数和运行预算。工具配置保存产品类型、DSH provider 映射、认证引用、权限模式、版本要求及能力描述。模型与密钥沿用既有配置和 SecretStore；不把凭据写入普通工作流配置。

以下为设计示例，**尚不是可提交的现有 API 或已支持字段**：

```json
{
  "workflow": "design-code-review",
  "stages": [
    { "id": "design", "role": "designer", "agentToolRef": "claude-design", "next": "implement" },
    { "id": "implement", "role": "coder", "agentToolRef": "dsh-coding", "next": "review" },
    { "id": "review", "role": "reviewer", "agentToolRef": "codex-review", "next": null }
  ],
  "reviewRouting": { "implementation": "implement", "design": "design" },
  "maxReworkRounds": 3
}
```

该定义属于跨 Agent workflow template，不是 `space_stages` 的别名。阶段序号、交接边和返工边由工作流自身保存并版本化；阶段绑定一个已登记的角色和 Agent 工具配置。`space_stages` 与 roster 继续服务原有空间任务链，不能决定跨 Agent 工作流是否可配置，也不能在创建工作流时被隐式重排或删减。创建工作流实例时冻结拓扑与工具配置，之后按冻结拓扑创建阶段任务和推进交接。

用户可以设置空间默认工作流，并在单次工作中覆盖指定阶段的工具。优先级沿用已裁决原则：**单次阶段显式指定 > 工作流阶段配置与角色规则 > 在册的模型建议 > 默认 DSH**。同一优先级下，具体阶段配置先于通用角色规则。选择混合工作流后，未覆盖阶段保留该工作流配置；未选择工作流且未命中规则时默认 DSH。显式指定的工具未知、停用或能力不满足时拒绝，不自动换成另一工具。

### 14.3 阶段交接与版本冻结

工作流启动时冻结工作流定义和返工规则；每次派工在 Attempt 中冻结实际工具配置版本、选择来源、模型配置、执行机器、工作目录和权限结论。修改默认规则影响新的工作流或后续允许覆盖的派工，不修改历史记录。普通任务字段不应承担“当前规则的推导缓存”，但**已执行 Attempt 的实际选择是历史事实，必须持久化**；这取代 §11 中可被读成“只留选择流水即可”的旧口径。

交接包必须包含原始目标、验收标准、相关规范与上下文快照、方案产物及内容摘要或哈希、代码提交或变更快照、测试证据、审查意见，以及上游 Task、Attempt、Run 的关联标识。接收方拿不到必需产物或版本不匹配时停止派工并具名说明，不能仅转发上一位 Agent 的一句摘要。

设计返工产生新方案版本；下一次实现消费该版本，Codex 审查同一方案和对应代码版本。实现返工可复用未改变的方案版本，但必须生成新的执行与验证证据。恢复时核对产物和实际运行状态，不能把新建会话记成原生 resume，也不能因等待超时直接重复派活。

### 14.4 审查决策与返工规则

审查报告需给出 `passed`、`summary`、`findings`；每个问题包含类型 `implementation` 或 `design`、严重程度、说明、相关文件或方案位置及验收方法。报告还需关联被审查的方案与代码版本。该结构是目标契约，外部 provider 不支持原生结构化输出时由外层解析与校验；无法解析则记为审查失败，不当成通过。

Legion 校验后确定去向：实现问题回到 implement；设计问题回到 design；两类问题同时存在时先修订设计，再实现并复审；问题类型不明、方案未决事项或验收标准有争议时进入待澄清状态。Agent 的审查意见作为决策输入，任务状态由 Legion 控制。

审查通过还需满足阶段产物与独立验证要求，才按工作流的自动验收或人工闸门配置收口。审查不通过产生明确关联的返工任务或新执行轮次，不改写已完成阶段的历史。每轮返工按工作流计数，设计与实现返工共用上限；预算耗尽、达到次数上限、工具不可用或用户暂停时停止自动推进并保留原因。示例中的三轮只是配置示例，并非固定产品限制。

### 14.5 Agent 调用与权限边界

Agent 节点、Agent 工具和底层模型是三种不同身份。节点表示实际执行位置/runtime adapter 实例，记录 machine、工作区映射、可用状态与能力；Agent 工具配置表示 Claude Code、Codex、ACP Agent 或 DSH 内部 Agent 的产品和调用方式；底层模型配置表示该工具内部使用的模型。阶段选择 Agent 工具及允许的节点，不能仅因节点在线就推断其已认证，也不能把模型 provider 名当成 Agent 工具。

Legion 持有 workflow instance、阶段状态、交接规则和审计的权威状态。节点注册、在线健康、MCP 协作入口和 provider 进程都作为执行面能力，不另建任务状态机。节点可本地部署或后续远程部署；远程执行必须有明确的 repo/workspace 映射和产物传输契约。首版目标闭环为 Claude Code → DeepSeek Harness → Codex；节点生命周期与能力探测可逐步扩展到更多 Agent。

先复用 DSH 的 `subagent-claude-code`、内部 DSH provider 和 `subagent-codex`。Legion 产品名称与实际 provider 注册名显式映射，例如 DeepSeek Harness 可能映射到部署中的 `spawn`，不能把模型 provider 名直接当执行 provider 名。可用性以运行组件、注册表、认证和能力探测为准。

Claude Code 与 Codex 的 DSH provider bundle 必须安装在运行 Legion worker 的 DSH profile 中，并在安装后重启该 profile。Legion 插件直接调用 `ctx.subagents.start()`，不依赖把 `dsh-tool-subagent` 工具行暴露给 DSH 模型；provider 的注册与模型是否能主动调用该工具是两项独立配置。bundle 提供锁定的运行组件，不创建登录态，也不回退宿主 CLI。空间设置应将节点心跳已报告的 provider 与所选阶段对照，并明确提示缺失安装/注册；心跳本身不能证明认证成功，需由实际 provider 运行确认。

模型覆盖属于 Agent 工具声明的可选能力，不能从节点支持某 provider 推断。只有工具适配器明确声明并通过运行时核验后，Legion 才可传递冻结的 provider/model/reasoning 选择；外部 Claude Code、Codex 等工具默认采用其自身模型配置。模型档案中的密钥或凭证不可传入子 Agent；能力缺失、档案版本变化或执行配置不匹配时应拒绝派工，不静默忽略覆盖。

2026-09-30 当前 DSH 检出显示：原生 Codex provider 使用 app-server 创建临时 thread；Claude provider 使用 Agent SDK 且不持久化产品 session。两者为一次性委派，不声明 `agentOptions`、结构化输出、工具过滤等可选启动能力，也不直接提供现有 worker 所依赖的 `localAgent` 拦截对象。需设计专门的外部执行适配分支，不能把本地 worker 的参数原样送过去。

DSH 的内部工具强制面不自动约束外部进程。每种工具需独立声明并核验原生权限、沙箱、人工审批转交、事件、用量、取消与恢复能力；要求无法满足时拒绝。只检查最终 JSON 或工作目录不能替代权限强制。当前适配器的 `policyPreflightPassed` 只表示 Legion 检查了工作区绑定、冻结权限档与 provider 能力，不证明账号已认证或宿主权限已生效；认证状态只能由真实 provider 启动/执行结果确认。共享仓库使用 worktree 或受控版本交接，远程机器需显式路径映射；worktree 本身不是安全沙箱。

旧 §3 的本机结论已过时：本次 PATH 探测已找到 Codex 可执行文件，未找到 Claude 和 dsh 命令；当前原生 provider bundle 自带相应运行组件，不以宿主 CLI 是否在 PATH 上作为唯一前置条件。本次没有核验真实登录或发起真实编码任务。详细依据见 [外部 Agent 工具研究](../../research/external-agent-tools-2026-09-30.md)。

### 14.6 界面目标与验收条件

工作流设置页允许为设计、实现、审查分别选择工具配置，编辑提示词、交付契约、返工上限与预算；单次工作可覆盖某一阶段。运行详情展示当前阶段、实际工具、方案和代码版本、审查结论、返工去向与次数，以及暂停或失败原因。角色标签不替代实际工具标识。

设计验收条件如下，均为待实现与验证项：

1. 同一工作流的三个阶段确实分别调用指定的 Claude Code、DSH、Codex，并记录实际工具与运行关联。
2. DSH 消费 Claude 交付的方案版本，Codex 审查对应代码及测试证据；缺产物和版本错配拒绝推进。
3. 实现问题返回 DSH，设计问题返回 Claude；修改后再次调用 Codex，不能只把原审查任务标成通过。
4. 默认配置与单次阶段覆盖可追溯，规则更新不改写已经执行的 Attempt。
5. 未知工具、能力不足、审批无法处理、调用失败、格式错误与取消清理失败均可区分。
6. 返工上限、预算、暂停、重复交接和重启恢复有明确行为；未知结果先对账，避免重复执行。
7. 自动收口需独立验证；人工闸门的工作流等待已有验收流程放行。

### 14.7 当前实施状态

已有代码提供路由优先级、配置表、选择流水与建任务前的名称校验，并已实现标准三阶段闭环配置、目标级拓扑/工具快照、版本化交接证据、审查归因/返工台账及 Workbench 配置和历史呈现。闭环岗位不必在空间常规阶段中相邻，配置也不覆写普通阶段工具。现已增加独立命名工作流定义仓储与 DAG 校验；目标创建可把任意成功路径 DAG 实例化成任务图，`blockedBy` 保存多前驱，阶段 ID 支持同一岗位配置多个阶段，并将定义、工具/节点和状态快照保存在独立 workflow instance。worker 按冻结 stage ID 传递上游产物并校验声明的输入/输出契约；typed review 返工按 stage ID 路由。设计问题会建立新的设计任务和下游阶段批次，重新实现、验证并汇合到新的 Codex 审查；不复用已失效的旧实现/审查结果。Workbench 可编辑 DAG、保留阶段具体工具配置版本、载入既有定义并发布新不可变版本；空间设置现可按状态/关键词筛选、分页浏览工作流实例，展开阶段任务和审查返工历史，并暂停、恢复或取消关联目标。目标取消继续遵循既有规则：取消未开工阶段、将在办阶段留痕并挂起；不可变实例定义本身不提供直接编辑/删除操作。DAG/返工测试 24 项、定义与路由集中回归 51 项、插件全量测试 428 项及 Team Hub、Workbench 构建通过；实例目录与生命周期增量回归 42 项通过，但这些测试不代表真实产品链路。真实 Claude Code → DSH → Codex 连续运行、认证、权限、取消及真实 Agent 返工仍未验证；F-23 继续保持未完成状态。实施细节和逐项验证见[跨 Agent 协作工作流设计与实施计划](../plans/2026-09-30-stage-agent-workflow-implementation.md)与[外部 Agent 工具研究](../../research/external-agent-tools-2026-09-30.md)。
