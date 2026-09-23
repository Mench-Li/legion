# PRT-214 续：授权身份（`scope` / `taskId` / `cwd`）**已按 Run 生效**

> spec §6.8：强制面三个强制点必须共用同一份投影；spec §4.2：任务、空间与审计的语义属于 Legion。
> spec `:128`：「该开关首版只允许按安装生效，后续如需按 space 生效，也必须由 team-hub
> 原子分配唯一调度器；禁止按任务自由切换或让两个调度器同时扫描同一空间。」
>
> 日期：2026-09-17　状态：**缺口已修（本文含实现、判据与破坏性验证）**
> 关系：本文是 `PRT-214-enforcement-composition-root.md` 的续篇。
> §1–§6 是**缺口记录**（原文保留，只订正已被实现替换的坐标）；
> §7 起是**交付记录**：修法、实现坐标、机器判据、破坏性验证。

---

## 1 缺口一句话

`assembleEnforcement()` 是**进程级、只装一次**的，因此它从 `runtime.env` 读到的
`scope` / `actor` / `action` 是**整个 Runtime 进程的身份**，而不是**这一次 Run 的身份**。
一个 Runtime 进程服务多个空间时，别的空间的执行会被盖上这一个空间的身份——
**不报错，只是错标**。

这件事不是新发现，PRT-214 自己在解释「为什么 hard floor 必须按 Run 装」时，
把同一条论证写在了 `runtime/dsh-composition/run-floor.mjs` 的文件头里；
**hard floor 已经按那条论证找到了 per-Run 落点，而身份三元组还没有。**
（现在有了：§7。）

## 2 事实：身份曾是进程级的

| 事实 | 坐标 |
| --- | --- |
| 装配是**进程级单例**，只装一次 | `runtime/dsh-composition/root.mjs:351` `let installation = null` |
| 身份从**进程环境**读，且**不给默认值** | `root.mjs:171-180` `ENFORCEMENT_CONFIG_FIELDS[].envKeys`（`LEGION_ACTOR` / `LEGION_SCOPE` / `LEGION_ENFORCEMENT_ACTION`） |
| 解析结果翻成桥要的上下文 | `root.mjs:325` `enforcementContextOf(values)`，调用点 `root.mjs:456` |
| 三元组进**每一次工具执行**的授权哈希 | `runtime/dsh-composition/enforcement.mjs:86` `CANONICAL_OP_KEYS = ['scope','actor','action','target','taskId','toolName','callId','arguments']`，域 `enforcement.mjs:77` `legion.tool-execution.v1` |
| 落库位置 | `team-hub/server.mjs` 的 `permission_requests (scope, actor, action, target, …)` 与 `audit (member, scope, action, taskId)` |
| 生产注入点（唯一） | `product/launcher/enforcement-identity.mjs:74-100`（`scope: 'LEGION_SCOPE'`，必填清单 `root.mjs` 的 `REQUIRED_ENFORCEMENT_CONFIG`） |
| Launcher 拒绝启动的判据 | `ENFORCEMENT_IDENTITY_MISSING`（缺任一项即拦，**不降级为警告**） |

「装配级＝进程级」不是疏忽，而是形状决定的；`run-floor.mjs:20-31` 逐字写着这条论证：

> 装配级（`assembleEnforcement({floor})` 那一层）是**进程级**的：一个进程只装一次，
> 而 Runtime 进程是**长命的**、会服务很多次 Run …… 装配级的下限必然等于
> "第一个 Run 的下限"，而它会被后面每一个 Run 继承。

## 3 多空间部署下会发生什么

先分清两半——**空间语义在 Legion 侧本来就是 per-attempt 的**：

| 面 | 粒度 | 坐标 |
| --- | --- | --- |
| 认领 / 租约 | 任务自己的 `scope` 随租约下发 | `team-hub/run-store.mjs:1361` `claim({ workerId, scope = null, … })`；`run-store.mjs:836` `shapeAttempt()` 带 `scope` |
| 上下文装配 | **以租约为准**，缺了就拒绝 | `orchestrator/worker/context-stage.mjs:252` `requireScope(inputs, lease)`，调用点 `:151`、`:320` |
| 来源加载 | **租约上的 scope 优先**于构造时的兜底 | `orchestrator/worker/sources-loader.mjs:497` `const effScope = lease.scope ?? scope`（用例：`sources-loader.test.mjs:293`） |
| 执行引擎的强制身份 | **进程级**（本文的缺口，§7 已修） | §2 的表 |

于是真实部署里（本机实测的 4 个空间：`default` / `gf001` / `ozon` / `software`，
来源 `GET /api/spaces`）：

- 一个 worker（`product/orchestrator/worker.mjs` 里**一次都没有出现 `scope`**）
  会跨空间认领；
- 每次 Run 被派给**同一个** Runtime 进程执行；
- 该进程的 `scope` 是配置里写死的那个值。

后果分三种，**没有一种是"拒绝执行"**：

1. 别的空间的执行被记进 `permission_requests` / `audit` 时，`scope` 是错的那个；
2. 进 `canonicalOperationHash` 的 `scope` 也是错的那个——审批绑定与内容哈希因此
   挂在"另一个空间"的名下；
3. 按空间写的 `permission_rules (scope, actor, action, target)` 与运行时的
   `scope` **对不上**；对不上的具体表现取决于规则匹配的默认方向，**本文没有端到端验证**
   （见 §6 诚实边界第 3 条）。

> 一个"把甲空间的事记在乙空间名下"的运行时，
> 与一个"拒绝执行乙空间任务"的运行时，在"乙空间的任务跑没跑"这个读数上是相反的，
> 而在"乙空间的审计还能不能用来追责"上是同一个东西。

## 4 同一份代码里已有的先例：hard floor 的 per-Run 安装点

`runtime/dsh-composition/run-floor.mjs`（PRT-214 缺口①）已经把**同一类问题**解过一次，
解法**已经照抄**（§7 逐条对应）：

| 它做了什么 | 坐标 |
| --- | --- |
| 承认装配级的下限会被后面每个 Run 继承 | `run-floor.mjs:20-31` |
| 把下限装到**那次 Run 的目标 Agent 自己的 Cordis 作用域** | `run-floor.mjs:33-48`（依据 DSH 的 `ctx.tools.guard()` 文档与 `tools/pre-execute` 的 `scopeTarget`） |
| 安装点选在**每次 Run 只过一次**的缝上 | `plugins/runtime-host-registrar-row.mjs` 的 `startRun`（创建窗口 + 回退两条路） |
| 用**对象身份**配对，杜绝"第二个 Run 拿到第一个 Run 的载荷" | 同上 |
| 明说**不许**放进 agent preset / 会话级挂载 | `run-floor.mjs:40-42`（spec §6.9 `:500`） |

**身份三元组缺的正是这一步**：它需要和 floor 一样，随 `RunRequest` 进来、
装到「这一次 Run」的作用域上，而不是在进程启动时定死。

顺带一条设计层的印证：`LEGION_TASK_ID` 是**可选**的，`root.mjs` 的注释理由是
「进程级装配时常常还没有任务」——**设计上已经承认"进程级装不了按 Run 的东西"**，
只是这只对 `taskId` 说出口了，对 `scope` 没有。

## 5 为什么"每个空间起一个 Runtime 进程"不是答案

这是最容易想到、也最不该选的一条：

- N 个 Runtime 进程 = N 份内存、端口、模型连接、补丁层装配与升级面；
- `product/process-manifest.mjs` 的清单里 `runtime` 只有**一行**，
  今天**没有**按空间展开的落点；
- spec `:128` 把"按 space 生效"明确排到后续，且要求**由 team-hub 原子分配唯一调度器**，
  而不是让 N 个实例各自扫描；
- 用户视角：换一个空间要再起一个引擎，这在产品上是多余的。

所以正确的目标形态是 **一个 Runtime 进程服务所有空间，每次执行带各自的空间身份**。

## 6 诚实边界（仍然没验证的部分，逐条写明）

1. **没有在真实多空间部署里目击这个错标（修之前）。** §1–§5 的结论来自代码坐标 +
   本机 `GET /api/spaces`（4 个空间）与 `--check` 的读数，不是现场目击。
   §7 交付的是**构造上**把这条错标消掉，以及一组"两个空间必须分得开"的判据。
2. ~~**没有一条用例覆盖它。**~~ **已消**：§8.2 的 20 条用例里有 4 条正是
   "两个 Run 各带各的空间"。其中 ⑭ 是**反面控制**——少了它，"两边不同"可能只是
   因为别的东西变了。
3. **规则匹配的失败方向仍未端到端验证。** `scope` 对不上 `permission_rules` 时，
   是"落不到任何规则 → 走人工审批（fail closed）"还是"命中某条更宽的规则"，
   取决于 `checkPermission` 的匹配实现，**本文没有读到那一步就下结论**。
   §7 只保证"送到匹配器里的 `scope` 是这一次 Run 的那个"。
4. ~~**没有改任何代码**~~ **已改**：§7。
5. 本文**不主张**新建任务号。它记在 PRT-214 这条线下面，与 `PRT-214-*.md` 的其余续篇同例。

---

## 7 修法（已实施，取候选 A）

§7 原来列了三条候选，**取 A**：

| # | 方案 | 评价 |
| --- | --- | --- |
| **A** | 身份随 `RunRequest` 进来，按 Run 装到目标 Agent 作用域（照 floor 先例） | **已实施**（本节） |
| B | 保留进程级身份为"引擎身份"，另在项目投影里带 Run 的空间 | 不取：两步身份容易漂，而 `canonicalOperationHash` 只认一份 |
| C | 按空间起 N 个 Runtime 进程 | 不取：§5 的全部代价 |

### 7.1 ★ 先回答原文 §7 留的两个问题

原文写着「修 A 之前必须先回答的两个问题（本文不替产品决定）」。实现把它们回答如下，
**两条都不是猜测，都有判据**：

**问题 1：`RunRequest` 里哪个字段就是空间？**

**答：`workspaceId`。** 理由不是"名字像"，而是一条已经在仓库里的推导：
PRT-253 续批（`PRT-253-run-request-input-wiring.md` §8）已经让 `workspaceId` 由
**租约上的 `scope`** 推导出来（`orchestrator/worker/run-inputs.mjs` 的
`resolveRunInputs()`，`sources.workspaceId = 'derived:scope'`）。
于是"空间"这件事**在整条链上只有一个算法**，worker 里不出现第二种。

> 一个"在 worker 里另算一次空间"的实现，
> 与一个"两个算法只在某个空间名上偶然一致"的实现，是同一个东西——
> 只不过后者错的那天，投影里的 `scope` 与租约里的 `scope` 会分头漂移。

原文担心的是「`workspaceId` 是"在哪个目录里跑"」——那个担心对，所以实现里
**目录那一半走 `workdir`、空间那一半走 `workspaceId`**，两者是**分开的两个字段**
（`contracts/run-identity.mjs` 的 `RUN_IDENTITY_OVERLAY_FIELDS`）。

**问题 2：进程级那三个值在 A 之后是什么语义——缺省？兜底？还是必填？**

**答：`scope` / `taskId` / `cwd` 变成"按 Run 覆盖、缺席回落"；
`actor` / `action` 仍然是进程级的唯一权威。** 拆开说：

- **`scope` / `taskId` / `cwd`**：进程级那份是**基线**，这次 Run 有覆盖就**叠上去**
  （`contracts/run-identity.mjs` 的 `applyIdentityOverlay()`）。
  `absent`（字段不在 `RunRequest` 上）是**合法的**，它表示"这次没有覆盖"，
  于是行为与接线之前逐字相同——这让老调用方不受影响。
  但**读不懂**（`refused`）**在起跑前拒绝这次 Run**，不回落：
  回落会把"想覆盖却写坏了"洗成"沿用进程级"，而那正是本缺口要消灭的形状。
- **`actor` / `action`**：**不被接受**，而不是"可选"。
  `RUN_IDENTITY_PAYLOAD_KEYS` 里没有这两个键，给了就具名拒绝（`UNKNOWN_KEY`）。
  理由是：`RunRequest` 里**没有任何一个字段**能权威地assert"这次由别人负责"，
  于是允许它覆盖 `actor` 等于让**审计归属变成请求方自填**——

  > 一个"允许 Run 自带 actor"的载荷，
  > 与一个"审计里的责任人可以由图省事的调用方指定"的实现，是同一个东西——
  > 只不过前者的错法是把责任记到一个**别人**头上，而它看起来完全正常。

### 7.2 载体：线上形状与端口形状**两层分开**

照 floor 的两层形状（`run-floor.mjs:200-218` 那段注释的理由逐字适用）：

| 层 | 形状 | 谁产 | 谁读 | 在哪 |
| --- | --- | --- | --- | --- |
| 线上 | `{version, scope, taskId?, cwd?}` | worker（`deriveRunIdentityCarrier`） | 适配器（`readRunIdentity`） | `runtime/contracts/run-identity.mjs` |
| 端口 | `{state:'installed', identity:{…}}` / `{state:'absent'}` | 适配器 | 宿主端口（`createRunIdentityInstallation`） | 同上（`RUN_IDENTITY_PORT_STATES`） |

两层分开才有"适配器解释不了、于是原地拒收"的位置；若端口也去解释线上形状，
一条坏载荷会在两个地方各被解释一次，而两边解释得不一样的那一天只表现为
"这条 Run 的行为跟别的不同"。

**闭集**：多一个键就具名拒绝（`UNKNOWN_KEY`）。理由是跨进程边界——
对面递来的东西带一个我不认识的字段时，我只能猜它是不是更严格的约束，
而猜"它是装饰"的代价落在**归属**上。

### 7.3 ★ 落点：与 floor **逐字相同**，但有一处**实质差别**

| 面 | floor（缺口①） | 身份（缺口②） |
| --- | --- | --- |
| 装在哪 | 那次 Run 的目标 Agent 的 Cordis 作用域 | **同一个 Agent 对象**（`WeakMap`） |
| 为什么不会串台 | 一次 Run 只有一个目标 Agent ⇒「按 Run 分」＝「按 Agent 分」是**构造上**的 | 同左 |
| 载体怎么走 | `agentOptions.legionRunFloor` | `agentOptions.legionRunIdentity` |
| 装不上时 | **拒绝起跑**（装不上 = 强全面整段不在） | **不拒绝**，回落进程级身份 + 记一条日志 |
| 读不懂时 | **拒绝起跑** | **拒绝起跑**（同） |

**那处实质差别**不是宽松，而是一条形状判断：身份**不新增任何判定点**，
只改一份已经存在的判定读到的值。所以它没有"装一半"的中间态，
也就没有可以 fail closed 的面——把一次"归属回落"升级成"任务生不出来"是过度反应。

代价是"装上去了但桥没读"是这里唯一会静默失效的形状，所以：
桥那一侧有一条**按对象身份取覆盖**的缝（`identityOverlayForExecution`），
而它有一条"两个 Run 各带各的身份"的判据（§8.2 例⑬）。

### 7.4 实现坐标

| 文件 | 改动 |
| --- | --- |
| `runtime/contracts/run-identity.mjs` | **新**。线上形状、三个状态、闭集、`applyIdentityOverlay()`、`RUN_IDENTITY_CONTRACT_CHECKED` |
| `runtime/dsh-composition/run-identity.mjs` | **新**。端口形状、`WeakMap` 登记、载体、`identityOverlayForExecution()` |
| `runtime/dsh-composition/tool-request.mjs` | 桥新增 `identityFor`（**缺省就是生产的那个**），`project(request, execution)` 按执行对象取覆盖 |
| `orchestrator/worker/executor.mjs` | **新** `deriveRunIdentityCarrier()`；`execute()` 在下限之后、探测之前接上 |
| `runtime/contracts/run.mjs` | `enforcementIdentity` 可选，给了就必须解释得通 |
| `runtime/adapters/dsh/index.mjs` | 线上 → 端口那一跳；**总是**显式交出去（缺席也是一种要交出去的状态） |
| `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` | `startRun` 在创建窗口里装身份；`RUNTIME_HOST_REGISTRAR_VERSION` 3 → 4 |

## 8 复现与核对（**机器判据**）

### 8.1 一条命令跑完整条链

```bash
node scripts/probes/probe-identity-loop.mjs
```

它用**生产代码**（不造替身）在一个进程里把整条链走完，末尾自判成败：

```
① runInputs.ok = true {"workspaceId":"gf001","workdir":"D:/project/DSH/gf001-scratch",…}
① RunRequest.workspaceId = gf001 | workdir = D:/project/DSH/gf001-scratch
② state = installed | payload = {"version":1,"scope":"gf001","taskId":"T-9","cwd":"D:/…"}
③ portPayload = {"state":"installed","identity":{"scope":"gf001","taskId":"T-9",…}}
④ overlay = {"scope":"gf001","taskId":"T-9","cwd":"D:/…"}
⑤ subject.scope = gf001 | actor = owner:11150 | action = employee-run
⑤ canonicalHash = sha256:e7271a7b3fd910becfb4745…
⑤ 反面控制 subject.scope = legion

★ 整条链通了：租约的空间名一路走到了授权哈希
```

★ 最要紧的两行是最后两行：**同一个工具调用**，带覆盖时 `scope=gf001`、
不带覆盖时 `scope=legion`——而且**授权哈希不同**。后者是"归属真的分开了"的读数，
不只是"某个字段变了"。

### 8.2 用例

```bash
node --test runtime/dsh-composition/run-identity.test.mjs        # 20 条
node --test runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs
node --test runtime/adapters/dsh/adapter.test.mjs
node --test orchestrator/worker/run-inputs.test.mjs              # 含 ㉖㉗㉘
```

其中**判据性**最强的五条：

| # | 判据 | 少了它会怎样 |
| --- | --- | --- |
| ⑬ | 两个 Agent、两个空间 → 两个 `scope`、**两个 `canonicalHash`** | 错标无人守 |
| ⑭ | **反面控制**：没有覆盖时两次调用必须完全相同 | ⑬ 的"两边不同"可能只是别的东西变了 |
| ⑱ | `actor` / `action` 一定来自进程级（即使 overlay 里塞了） | 审计归属可被请求方自填 |
| ㉖ | **端到端**：租约 → 三个运行输入 → `RunRequest` → 身份 | ①与②各自绿、接起来断 |
| ㉗ | 造不出 `scope` 时挂一份**会被拒绝**的载荷，而不是不挂 | "这次没有空间"被回落成"沿用进程级" |

### 8.3 破坏性验证（每条都必须**变红**）

```bash
$env:MUTATE_ONLY='⑪,⑫,⑬,⑭,⑮'; node scripts/probes/mutate.mjs
$env:MUTATE_ONLY='⑯,⑰';          node scripts/probes/mutate.mjs
```

`scripts/probes/mutate.mjs` 的 ⑪–⑰ 是本批新增的七条。**七条全部咬住**：

| 变异 | 期望变红 | 实际 |
| --- | --- | --- |
| ⑪ 桥不再把覆盖叠进投影 | ⑬ | ✔ 红 4 条（⑬/⑮/⑰/⑱） |
| ⑫ 叠加白名单被绕开（`{...context, ...overlay}`） | ⑱ | ✔ 红 1 条 |
| ⑬ 载荷接受 `actor` | ② | ✔ 红 2 条 |
| ⑭ 没有 agent 时也去猜一份覆盖 | ⑫ | ✔ 红 1 条 |
| ⑮ `absent` 也给一份 overlay | ⑥ | ✔ 红 2 条 |
| ⑯ 生产者造不出 `scope` 时干脆不挂 | ㉗ | ✔ 红 1 条 |
| ⑰ 安装点对坏身份载荷不再拒绝 | 身份 | ✔ 红 2 条 |

★ ⑯ 的锚点**第一次锚错了地方**（锚在 `execute()` 里那一行赋值上，而靶子用例
㉗ 直接调生产者、不经过 `execute()`），于是得到一条"没咬住"。那不是"这条性质
没被守住"，而是**靶子不在射程里**——记录在这里，因为一条读起来像证据的空跑
比没有证据更坏。

### 8.4 回归

```bash
node --test "runtime/dsh-composition/*.test.mjs" "runtime/dsh-composition/plugins/*.test.mjs"
#   → 886 tests / 734 pass / 0 fail / 144 skipped（skip 的是未配 DSH_CHECKOUT 的真进程用例）
node --test "runtime/contracts/*.test.mjs" "runtime/adapters/dsh/*.test.mjs"   # 411 / 410 / 0
node --test "orchestrator/worker/*.test.mjs"                                    # 581 / 562 / 0
```

CI 套件登记：`scripts/ci/run-ci.mjs` 新增一行 `run-identity（PRT-214 续…）`。

```bash
node scripts/prt/progress-check.mjs
node scripts/prt/spec-progress.mjs --check
```
