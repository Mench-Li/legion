# PRT-253 续：生产入口没有给 `workspaceId` / `modelProfileRef` / `workdir`

> spec §6.2：适配器只执行一个已定义的 `RunRequest`；§6.11：取值优先级
> 「内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量」。
>
> 日期：2026-09-17　状态：**本批已修（§8、§9）**；§1~§7 保留为发现时的原始记录
> 关系：本文是 `PRT-253-runtime-binding-caller.md` 与
> `PRT-253-runtime-contract-launcher-wiring.md` 的续篇；记的是**接线之后仍然空着的一截**。

---

## 1 缺口一句话

`defaultRequestFor()` 需要三个「猜不出来、必须由调用方给」的输入，
而**生产链路上没有任何东西给它们**：租约不带（`shapeAttempt()` 里没有这三列）、
快照不带（`associations` 里只有 goalId / taskId / employeeId / teamPlanId）、
`WORKER_ENV` 也没有（只有 hubUrl / token / dataDir / runtimeCommand / workerId / workspaceDir）。

因此真实部署里**第一次认领到任务**，会在执行阶段以具名错误停住：

```
EXECUTOR_BAD_WIRING
missing = ["workspaceId", "modelProfileRef", "workdir"]
```

失效方向是**好的**（具名拒绝，不是静默跑错），但结论仍然是：
**product-runtime 的执行链今天还通不了电**，与 scope 用哪个空间无关。

## 2 证据链（逐点坐标）

| # | 事实 | 坐标 |
| --- | --- | --- |
| 1 | 认领响应的字段集里**没有**这三项 | `team-hub/run-store.mjs:836-862` `shapeAttempt()`（`attemptId` / `taskId` / `scope` / `attemptNo` / `state` / `workerId` / `leaseEpoch` / `leaseExpiresAtMs` / `idempotencyKey` / … / `finishedAtMs`） |
| 2 | worker 认领后**原样**把租约交给执行阶段 | `orchestrator/worker/main.mjs:500` `claimed = await hub.claim({ workerId })`；`:602` `stageImpl.execute)(claimed)` |
| 3 | 生产走 `defaultRequestFor`（`requestFor` 全仓库只有用例传） | `orchestrator/worker/executor.mjs:340-345`；`requestFor` 的全部出现：`executor.mjs` + `executor.test.mjs` |
| 4 | 这三项**只能由调用方给**，且缺失即抛 | `executor.mjs:836` `defaultRequestFor()`；`:842` `workspaceId: lease.workspaceId`；`:850` `modelProfileRef: lease.modelProfileRef`；`:853` `workdir: lease.workdir`；注释 `:828-830`「`workspaceId` 与 `modelProfileRef` 取不到就必须由调用方给——它们是"在哪个目录里、用哪个模型跑"，猜不出来」 |
| 5 | 生产入口确实没给 | `orchestrator/worker/executor-binding.mjs:508` `createProductionExecutor({ host, adapterFactory, selfCheck, canRead, post, get, loadSources, … })`——无 `requestFor`，也无这三项 |
| 6 | 进程外壳的环境变量清单里也没有 | `orchestrator/worker/run.mjs:25-35` `WORKER_ENV`（`HUB_URL` / `HUB_TOKEN` / `DATA_DIR` / `RUNTIME_COMMAND` / `WORKER_ID` / `WORKSPACE_DIR`） |
| 7 | 产品层**一处**都没引用过这三项 | `product/` 全目录对 `workspaceId` / `modelProfileRef` / `workdir` / `LEGION_MODEL*` / `LEGION_WORKDIR` 的匹配数 = **0** |
| 8 | 可从快照回落的那几项确实能回落（所以缺的只有这三项） | `orchestrator/worker/context-stage.mjs:376` `associations: { goalId, taskId, employeeId, teamPlanId }`；`executor.mjs:837` `const assoc = snapshot?.associations ?? {}`；下落 `:843-846` |

## 3 实测读数

用**与认领响应同形**的租约（字段逐字取自 `shapeAttempt()`）喂真实的
`defaultRequestFor()`，两种快照各跑一次：

```
[hub claim 原样 + 空 associations] 拒绝  code=EXECUTOR_BAD_WIRING
  missing=["workspaceId","goalId","employeeId","teamPlanRef","modelProfileRef","workdir"]
  message=这次 Attempt 的 RunRequest 缺 6 个必填字段：… 它们既不在 lease 里，也不在快照的 associations 里。…
[hub claim 原样 + 生产快照 associations] 拒绝  code=EXECUTOR_BAD_WIRING
  missing=["workspaceId","modelProfileRef","workdir"]
  message=这次 Attempt 的 RunRequest 缺 3 个必填字段：workspaceId、modelProfileRef、workdir。…
```

第二行就是生产形状：goalId / taskId / employeeId / teamPlanRef 由
`context-stage` 发出的 `associations` 回落成功，**只剩这三项没有来源**——
与用例里那条断言逐字一致（`executor.test.mjs:203`
`assert.deepEqual(e.missing, ['workspaceId', 'modelProfileRef', 'workdir'])`）。

探针（临时、未跟踪，可删）：

```js
// scripts/probes/probe-lease-wiring.mjs（**已随批次丢弃**）（节选）
import { defaultRequestFor } from '../orchestrator/worker/executor.mjs'

const claimFromHub = { attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'software', attemptNo: 1,
  state: 'Leased', workerId: 'w1', leaseEpoch: 1, leaseExpiresAtMs: Date.now() + 60_000,
  idempotencyKey: 'idem:T-1', /* …其余字段逐字取自 shapeAttempt() */ }

const snapshotFromStage = { finalText: '（冻结正文）',
  associations: { goalId: 'G-1', taskId: 'T-1', employeeId: 'emp:T-1/coder', teamPlanId: 'tp:1' } }

try { defaultRequestFor(claimFromHub, snapshotFromStage) }
catch (e) { console.log(e.code, JSON.stringify(e.missing)) }   // EXECUTOR_BAD_WIRING ["workspaceId","modelProfileRef","workdir"]
```

## 4 与既有说法不一致的地方（值得单独记一句）

`orchestrator/worker/can-read-authorization-source.test.mjs:126-127` 的注释写着：

> `workspaceId` / `modelProfileRef` / `workdir` 是"在哪个目录、用哪个模型跑"，
> `defaultRequestFor` 明确拒绝猜它们（见它的 JSDoc）——**生产里由 worker 的配置给**。

而这句「生产里由 worker 的配置给」**在代码里没有对应物**：`WORKER_ENV` 没有这三个键，
`product/` 一处未引用，生产 `createProductionExecutor` 也不传 `requestFor`。

> 一句"生产里由 X 给"的注释，与一句"根本没有 X"的注释，
> 在用例上是同一个东西——只不过前者让读代码的人**停止继续找**。

这与 PRT-253 那一批反复出现的形状是同一种：两个各自都绿了的半边
（执行器用例验"缺了就具名拒绝"；hub 用例验"认领响应形状正确"），
中间的"谁把这三个值接上"从来没有出现在任何一侧。

## 5 诚实边界

1. **没有在真实部署里跑到那一步。** 本文的读数来自探针（直接调 `defaultRequestFor`）
   + 代码坐标，**不是**一次真实认领的现场日志。真要现场目击，需要在
   `orchestrator/worker` 上接一个真 hub 并让它认领一条任务。
2. **可能还有我没找到的调用方。** 我用的判据是
   `requestFor` / `workspaceId` / `modelProfileRef` / `workdir` 的全仓库匹配；
   如果某个调用方是通过别的方式（例如别的键名再改名）注入的，本文会漏掉它。
3. **本机环境限定。** 只在本仓库当前版本（Windows）上量过。
4. **不改任何代码、不新增任务号。** 本文记在 PRT-253 这条线下面。

## 6 修法候选（供评审，未实施）

| # | 落点 | 代价 | 评价 |
| --- | --- | --- | --- |
| A | `shapeAttempt()` 顺带带出 `workspaceId`（或由 `scope` 映射），worker 侧补 `modelProfileRef` / `workdir` | 要动 team-hub 的认领响应契约（它是被 worker 与用例共同钉住的形状） | 数据面本来就知道任务属于哪个空间/目录，**语义最顺**；但要处理"任务没有目录"的合法情形 |
| B | `WORKER_ENV` 增加三个受控环境变量，由 Launcher 注入 | 一处文档（`product/config-schema.mjs`）与一处 `readWorkerEnv` 即可；单 worker 只能有一个 `modelProfileRef` | 快，但把一个**按 Attempt 会变**的值做成了进程级；与 `PRT-214-per-run-enforcement-identity.md` 是同一类错误的缩小版 |
| C | 生产入口显式传 `requestFor`，在里面按租约组装 | 把"猜不出来"的判断挪到调用点，仍然要回答"值从哪来" | 不解决来源问题，只换地方 |

**推荐 A 为主 + B 作为过渡**；无论选哪条，都要补一条"第一次认领"的端到端用例，
否则这个缺口只能靠人来记。

另外，`workdir` 与 `LEGION_WORKSPACE_DIR` / worktree 阶段的关系需要同时确认：
`orchestrator/workspace/index.mjs:441-464` 的 `worktreeStages()` 捕获的是 **worker 级**
`scope`（`run.mjs:266` 默认 `'default'`，`:345` 传下去），从租约只取
`taskId` / `attemptId`——即"槽位目录上的空间标号"与"这次任务的空间"也可能不是同一个。

## 7 复现

```bash
# 探针（未跟踪，可删）
node scripts/probes/probe-lease-wiring.mjs（**已随批次丢弃**）
#  → [hub claim 原样 + 生产快照 associations] 拒绝 code=EXECUTOR_BAD_WIRING
#     missing=["workspaceId","modelProfileRef","workdir"]

# 用例里那条断言（同一结论的既有版本）
node --test orchestrator/worker/executor.test.mjs
```

```bash
# 产品侧当时的读数（彼时 runtime 已装好、只有身份缺）
node product/launcher/cli.mjs --check --workspace=D:\project\DSH
#  → exit 4，仅 ENFORCEMENT_IDENTITY_MISSING（ENTRY_UNRESOLVED 已随 --runtime-install 消失）
```

---

## 8 已修：三个字段各有唯一权威来源（本批实施）

### 8.1 交付物

| 文件 | 角色 |
| --- | --- |
| `orchestrator/worker/run-inputs.mjs`（新） | **唯一取值处**：`resolveRunInputs()`（纯）、`resolveModelProfileRef()`（问 hub）、`createModelProfileRefResolver()`（把"租约 → 任务岗位 → 模型绑定"封成 worker 的端口） |
| `orchestrator/worker/run-inputs.test.mjs`（新） | 25 例，含 8 条破坏性验证 |
| `orchestrator/worker/executor.mjs` | `defaultRequestFor(lease, snapshot, runInputs)`：只在 `runInputs.ok === true` 时采纳；拒绝的文案现在能区分"没人给"与"给了但被拒绝" |
| `orchestrator/worker/main.mjs` | 接住 `prepareWorkspace` 的结果（此前被丢弃）；装配 `runInputs` 并随 `execute(lease, runInputs)` 交给引擎；出处写进终态证据 |
| `orchestrator/worker/run.mjs` | `projectDir`（= `LEGION_WORKSPACE_DIR`）与 `modelProfileRefFor` 两个注入点 |
| `product/orchestrator/worker.mjs` | 生产入口用 `hubIo` 建模型解析端口并交给 `runWorkerProcess` |

### 8.2 每一项的来源（逐条）

| 字段 | ① 控制面 | ② 推导 | 缺来源时 |
| --- | --- | --- | --- |
| `workspaceId` | `lease.workspaceId` | `lease.scope`（`derived:scope`） | 具名拒绝 |
| `workdir` | `lease.workdir` | worktree 的 `slotDir`（`derived:worktree-slot`）／原地执行时的授权项目目录（`derived:project-dir`） | 具名拒绝 |
| `modelProfileRef` | `lease.modelProfileRef` | 员工模型绑定（`derived:model-binding`）：`GET /api/task?id=` 取任务上的岗位 → `GET /api/model-bindings/resolve?scope=&role=` 取主档案 | 具名拒绝 |

**为什么 `workspaceId` 允许从 `scope` 推导**：它不是执行参数，而是效果命名空间——spec `:672`
把它算进工具副作用的幂等键。按空间取值既**稳定**（同一任务每次算出来都一样）又**唯一**
（不同空间不撞键），而"没有工作集"在 Legion 里不存在（每条任务都属于一个空间）。
`workdir` 与 `modelProfileRef` 则**不许就近凑**：猜目录会改用户没授权的文件，猜模型会花用户的钱。

**为什么必须 `chain[0].role === 'primary'`**：PRT-502 §① 的全部要点是"主档案解析不出来时
**不许 fallback 悄悄顶替**"，而库里的形状恰恰是 `ok:false` 且 `chain[0]` **仍在**（诊断要看得见）、
`role` 保持 `'fallback'`。只读 `chain[0].id` 的实现会把一次配置错误变成一次
"照跑不误、只是换了个模型"的运行。

### 8.3 机器判据

```bash
node --test orchestrator/worker/run-inputs.test.mjs     # 25 例
node --test "orchestrator/worker/*.test.mjs"            # 334 例（315 过 / 19 跳过既有 / 0 失败）
node scripts/probes/mutate.mjs                                 # 8 条破坏性验证，8/8 咬住
node scripts/probes/probe-run-inputs-live.mjs                  # 对**真实** hub 的读数（见 §8.5）
```

破坏性验证逐条（每条都让**指定的**用例变红）：

| # | 改动 | 变红的判据 |
| --- | --- | --- |
| ① | 采纳 `inputs` 时不看 `ok` | ⑪ |
| ② | 取链首而不检查 `role === 'primary'` | ⑭ |
| ③ | 主档案解析失败也照用 | ⑬ |
| ④ | 原地执行也返回槽位目录 | ⑥ / ㉓ / ㉕ |
| ⑤ | `tagStage` 只转发一个参数 | ㉔ |
| ⑥ | 丢掉 `prepareWorkspace` 的结果 | ㉔ / ㉕ |
| ⑦ | 生产入口不再交出模型端口 | ㉒（源级钉子） |
| ⑧ | 模型解析回落到"平台默认" | ⑳ |

★ 第 ⑤ 条是**在写这批代码时真被抓到的缺陷**，记在这里：
`tagStage` 原本是 `async (lease) => fn(lease)`——一个**只转发一个参数**的包装。
调用点写成 `execute(claimed, runInputs)` 看起来完全正常，而第二个实参在包装层被丢掉。
例 ㉔（走完一整轮读 `execute` 的第二个实参）正是唯一咬住它的判据；
上面那批"只验 `resolveRunInputs` 纯函数"的用例**全都不会红**。

> 一个"转发时只接一个参数"的包装，
> 与一个"那个参数根本没被传"的实现，在调用点上是同一个东西——
> 只不过前者的排障会指向调用点，而调用点是对的。

### 8.4 一处**没做**的判断，以及为什么

**装配不齐不在 worker 外壳里判死。** 第一版在那里抛了具名错，随后撤回。
理由不是"更麻烦"，而是**分工**："这次请求需要哪些字段"是执行引擎的事——
调用方可以给自己一条 `requestFor`（`can-read-authorization-source.test.mjs` 例② 就是那么做的），
它完全可能从别处装出请求来。判据因此只有一处（`defaultRequestFor` 的拒绝），
本层做的是另一件事：**把出处记下来**。

撤回时被 15 条既有用例当场拦住（它们用的是最小租约 + 假执行器，验的是心跳/优雅停止/终态提交）。
那些用例不是"过时的"，它们指出了上面这条分工。

### 8.5 对本机真实 hub 的读数（2026-09-17）

```
空间：default、gf001、ozon、software          ← GET /api/spaces 正常
/api/model-bindings            → 404 not found
/api/model-profiles            → 404 not found
/api/employee-manifest         → 404 not found
/api/runtime/claim             → 404 not found
/api/task?id=__probe__         → 404 「未知任务」（**路由在**）
装配：false ["modelProfileRef"] {"workspaceId":"derived:scope","workdir":"derived:worktree-slot"}
```

★ 结论分两条，都很要紧：

1. **解析链本身在真数据上按预期工作**：`workspaceId` 与 `workdir` 都成功推导出来，
   只剩 `modelProfileRef`——因为这台 hub 没有那条路由（下一行）。
2. **运行中的 team-hub 比本仓库旧**：PRT-501/502/603 的路由一个都不在。
   这台 hub（PID 23108）是旧路径起的进程，比仓库源码落后若干批。
   于是"切到 Launcher 路径"不只是换进程，还**换整个 hub 的 API 面与库 schema**——
   这一条直接影响 `PRT-255` 与阶段 8 的迁移预期，记在 §8.6。

3. ⚠️ 一处**我自己的读数错误**，如实记下：第一版探针用 `/api/tasks?scope=`（复数），
   拿到 404 的 JSON 体后按 `?? []` 读成"任务 0 条"。真实情况是复数路由不存在，
   `/api/task`（单数）在。**一个把 404 体读成"空列表"的探针，
   与一个"库里真的没有任务"的探针，在输出上是同一个东西。**

### 8.6 本批**没有**解决的（继任者要接着做的）

- **`canRead` 仍然缺席，而它是另一条独立的缺口。** 本批实测：
  `product/orchestrator/worker.mjs` 的调用点**没有** `canRead`，于是
  `productionExecutorProviderFromEnv` **恒返回** `{ok:false, code:'EXECUTOR_CAN_READ_REQUIRED'}`。
  含义很直接：**即使三个字段都齐了，执行引擎仍然不会接上**。
  而这不是接线遗漏——`PRT-253-can-read-authorization.md` §3.1 明确写着
  合它需要**改 wire 契约**（给 `RunRequest` 加授权字段）+ 让 hub 的装配响应回吐结论，
  且该文 §306 标注「**不建议**按下面的方式合」。它需要单独一批、单独论证。
- **失败分类**：`defaultRequestFor` 抛的 `BAD_WIRING` 经 `classifyStageFailure('execute')`
  仍被归成 `runtime-unavailable`（**可重试**）。一次配置错误因此会烧掉重试额度——
  这正是 `main.mjs` 文件头警告过的那种"任务都在跑但全都失败"。本批没有动它。
- **旧库接管**：见 `PRT-255`。本批只量出"这台 hub 比仓库旧"，没有动数据迁移。

---

## 9 顺带闭掉的第五个缺口：`LEGION_WORKSPACE_DIR` 根本传不到 worker

§8 把三个字段接上之后，评审"这条链在真实部署里还缺什么"时发现的**同形状反面**。
它比 §8 那三条更安静，而且**更致命**。

### 9.1 缺陷

`product/process-manifest.mjs` 里 orchestrator 的 `envNames`（白名单）原本是：

```js
['TEAM_HUB_URL', 'TEAM_HUB_TOKEN', 'LEGION_DATA_DIR', 'LEGION_RUNTIME_URL', 'LEGION_RUNTIME_TOKEN']
```

**没有 `LEGION_WORKSPACE_DIR`**。而 `buildChildEnv()`（`product/launcher/allowlist.mjs:54`）
对**未声明**的键一律 CONTINUE 掉——连 `baseEnv` 里有同名值都放行不了：

```js
for (const [key, value] of Object.entries(baseEnv)) {
  if (!allow.has(key)) continue          // ← 声明面就是传递面
  env[key] = String(value)
}
```

于是真实部署里子进程读到 `undefined`，一路向下：

```
workspaceDir === null
  → resolveWorkspaceStages() 返回 { stages: null }      （orchestrator/worker/run.mjs:63-69）
  → worker 状态 = 'no-stages'                            （main.mjs：缺阶段不认领）
  → **一个任务都不认领**
```

外部表现只有状态文件里 `no-stages` 这一个词：**没有错误、没有告警、
没有任何一条日志说"我少了一个变量"**。从产品上看就是"任务一直没人做"。

### 9.2 它与 §8 是同一个形状的正反面，两个都要防

```
LEGION_DATA_DIR       声明了，但 Launcher 从不给值  ⇒ 起来就退 8 / DATA_DIR_REQUIRED（崩溃循环）
LEGION_WORKSPACE_DIR  连声明都没有                  ⇒ 宿主环境里配了也传不下去（静默不干活）
```

第一种已经在 PRT-253 续批四闭掉（`runtime-contract-wiring.test.mjs` 例①b，
注释写着「『白名单放行』与『有人真的注入了它』是两件事」）。
第二种就是本节。

> 一个"没声明所以被白名单丢掉"的变量，
> 与一个"根本没配"的变量，在子进程里是同一个读数（`undefined`）——
> 只不过前者的部署方会反复确认自己明明配过了。

### 9.3 修法（与 `LEGION_DATA_DIR` 逐字同形）

| 层 | 改动 |
| --- | --- |
| `product/process-manifest.mjs` | orchestrator 的 `envNames` 补 `'LEGION_WORKSPACE_DIR'` |
| `product/launcher/launcher.mjs` | `derivedValuesFor('orchestrator')` 里显式写 `out.LEGION_WORKSPACE_DIR = layout.workspaceDir`（Launcher 是唯一知道 `layout.workspaceDir` 的地方） |
| `product/launcher/runtime-contract-wiring.test.mjs` | 新增例 ①b′ |

**绝不回落成 `{install}` 或 cwd**：把项目目录猜成安装目录，
等于让执行去改一个升级时会整体替换的目录（PRT-003 那类越界写入）。

**只给 orchestrator**：hub / workbench / 白板不需要项目目录；
runtime **也不需要**——它的目录是**逐 Run** 由 `RunRequest.workdir` 给的
（这正是 §8 那个字段存在的理由）。例 ①b′ 对这四个进程各下一条反向锚。

### 9.4 判据

```bash
node --test product/launcher/runtime-contract-wiring.test.mjs   # 10 例（含新增 ①b′）
node scripts/probes/mutate.mjs                                          # 10 条破坏性验证
```

新增的两条破坏性验证：

| # | 改动 | 变红的判据 |
| --- | --- | --- |
| ⑨ | Launcher 不再注入项目目录 | ①b′ |
| ⑩ | 从 worker 的 `envNames` 里删掉声明 | ①b′ |


