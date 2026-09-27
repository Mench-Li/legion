# F-23 多 Harness 路由 —— 立项与核实（2026-09-24）

> 业主指令（逐字）：「23要仔细确认，因为 **Deepseek harness 本身应该支持接入 codex/claude code**，做成**配置表 + prompt** 形式，用户可以设置**默认哪些任务交给哪个 harness 产品**，也可以**单次任务里指定使用**，**如不指定，默认使用 deep seek harness**。」

本文件是**核实结果**，不是设计定稿。结论先行：**上面那条判断成立，且比"应该支持"更强 —— DSH 里已经有两个现成的 provider 包。**

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
