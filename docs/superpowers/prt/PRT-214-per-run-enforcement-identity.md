# PRT-214 续：授权身份（`scope` / `actor` / `action`）还是**进程级**的

> spec §6.8：强制面三个强制点必须共用同一份投影；spec §4.2：任务、空间与审计的语义属于 Legion。
> spec `:128`：「该开关首版只允许按安装生效，后续如需按 space 生效，也必须由 team-hub
> 原子分配唯一调度器；禁止按任务自由切换或让两个调度器同时扫描同一空间。」
>
> 日期：2026-09-17　状态：**缺口（未交付，本文不含代码改动）**
> 关系：本文是 `PRT-214-enforcement-composition-root.md` 的续篇，
> 只记录**该文交付之后仍然空着的一截**。

---

## 1 缺口一句话

`assembleEnforcement()` 是**进程级、只装一次**的，因此它从 `runtime.env` 读到的
`scope` / `actor` / `action` 是**整个 Runtime 进程的身份**，而不是**这一次 Run 的身份**。
一个 Runtime 进程服务多个空间时，别的空间的执行会被盖上这一个空间的身份——
**不报错，只是错标**。

这件事不是新发现，PRT-214 自己在解释「为什么 hard floor 必须按 Run 装」时，
把同一条论证写在了 `runtime/dsh-composition/run-floor.mjs` 的文件头里；
**hard floor 已经按那条论证找到了 per-Run 落点，而身份三元组还没有。**

## 2 事实：身份是进程级的

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
| 执行引擎的强制身份 | **进程级**（本文的缺口） | §2 的表 |

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
解法可以直接照抄：

| 它做了什么 | 坐标 |
| --- | --- |
| 承认装配级的下限会被后面每个 Run 继承 | `run-floor.mjs:20-31` |
| 把下限装到**那次 Run 的目标 Agent 自己的 Cordis 作用域** | `run-floor.mjs:33-48`（依据 DSH 的 `ctx.tools.guard()` 文档与 `tools/pre-execute` 的 `scopeTarget`） |
| 安装点选在**每次 Run 只过一次**的缝上 | `plugins/runtime-host-registrar-row.mjs:879-911`（`startRun`；创建窗口 + 回退两条路，两条都 fail closed） |
| 用**对象身份**配对，杜绝"第二个 Run 拿到第一个 Run 的载荷" | 同上 `:902-910` |
| 明说**不许**放进 agent preset / 会话级挂载 | `run-floor.mjs:40-42`（spec §6.9 `:500`） |

**身份三元组缺的正是这一步**：它需要和 floor 一样，随 `RunRequest` 进来、
装到「这一次 Run」的作用域上（或至少在桥的项目投影里按 Run 覆盖），
而不是在进程启动时定死。

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

## 6 诚实边界（没验证的部分，逐条写明）

1. **没有在真实多空间部署里观察过这个错标。** 本文的结论来自代码坐标 + 本机
   `GET /api/spaces`（4 个空间）与 `--check` 的读数，不是现场目击。
2. **没有一条用例覆盖它。** `root.test.mjs` / `pre-execute.test.mjs` 验的是
   "进程级装配正确"，不是"两个空间的两次 Run 各带各的身份"——
   这与 PRT-315 记录过的"多空间那条不变量只有替身证据"是同一类空白。
3. **规则匹配的失败方向未端到端验证。** `scope` 对不上 `permission_rules` 时，
   是"落不到任何规则 → 走人工审批（fail closed）"还是"命中某条更宽的规则"，
   取决于 `checkPermission` 的匹配实现，**本文没有读到那一步就下结论**。
4. **没有改任何代码**，也没有新增或修改用例；本文不含"已修"的宣称。
5. 本文**不主张**新建任务号。它记在 PRT-214 这条线下面，与 `PRT-214-*.md` 的其余续篇同例。

## 7 修法候选（供评审，未实施）

| # | 方案 | 代价 | 评价 |
| --- | --- | --- | --- |
| A | 身份三元组随 `RunRequest` 进来，按 Run 装到目标 Agent 作用域（照 floor 先例） | 需要 `RunRequest` 增字段 + 桥的项目投影按 Run 取身份 + 用例 | **推荐**：与 floor 同构，一个进程服务多空间且身份正确 |
| B | 保留进程级身份为"引擎身份"，另在项目投影里带 Run 的空间 | 两步身份容易漂；`canonicalOperationHash` 只认一份 | 需要先决定"哈希该用哪一份"，风险是两处口径 |
| C | 按空间起 N 个 Runtime 进程 | §5 的全部代价 | 不推荐（除非将来真要按空间做资源/故障隔离） |

修 A 之前必须先回答的两个问题（本文不替产品决定）：

1. `RunRequest` 里**哪个字段**就是空间？（今天有 `workspaceId`，但它是"在哪个目录里跑"，
   与 `permission_requests.scope` 不是同一个东西，见 `PRT-253-run-request-input-wiring.md`）
2. 进程级那三个值在 A 之后是什么语义——缺省？兜底？还是干脆变必填？

## 8 复现与核对

```bash
# 1) 身份是进程级的、且缺一即拦
node product/launcher/cli.mjs --check --workspace=D:\project\DSH
#    → exit 4，ENFORCEMENT_IDENTITY_MISSING（缺 actor / scope / action）

# 2) 本机真实存在多个空间（一个 Runtime 进程要服务它们全部）
curl -s http://127.0.0.1:8787/api/spaces

# 3) 台账与 spec 进度区仍一致（本文未改台账数字）
node scripts/prt/progress-check.mjs
node scripts/prt/spec-progress.mjs --check
```
