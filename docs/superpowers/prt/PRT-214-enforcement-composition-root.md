# PRT-214：组合根——把"没有生产调用方"这一截接上

> spec §6.8：三个强制点（pre-execute / hard-floor / approval-answerer）必须共用
> **同一份**投影；§6.8 line 479：必须能由审计定位到具体强制点。

本文记录的是 PRT-214 里此前没有被任何文档写下的一截：
**`assembleEnforcement()`、`bootstrapDshRuntime()`、`bindDshRuntime()` 三件东西
全都实现好了、全都各有套件、套件全绿——而没有任何生产调用方。**

> 一个从来没有人调用的装配函数，
> 与一个不存在的装配函数，在运行的部署上是同一个东西。

---

## 1. 这一截空着的具体代价

不是"少了个便利函数"。空着的是这条链：

```
补丁层那一行 → 组合根 → assembleEnforcement / bootstrapDshRuntime / bindDshRuntime
```

链子断在中间之后，`orchestrator/worker/executor.mjs` 的 `executorProvider`
永远拿不到绑定，于是 `productionExecutorProvider()` 永远返回：

```
EXECUTOR_HOST_PORT_REQUIRED —— DSH 运行时尚未绑定（没有宿主端口，也没有启动自检结论）
```

后果不是"启动慢"，而是 **PRT-215 的自检结论从来没有拦下过任何一次执行**：

- 自检判定 `autoExecutionForbidden === true` 时应该拒绝注册端口；
- 但端口从来没被注册过，所以"拒绝注册"与"根本没有注册口"是同一个状态；
- 「强制面未生效时禁止自动执行」这条保证因此**从未被行使过**。

> 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。

## 2. 交付了什么

### 2.1 `runtime/dsh-composition/root.mjs` —— 组合根

| 出口 | 作用 |
| --- | --- |
| `resolveEnforcementConfig({env, config})` | **纯函数**解析配置；不读 `process.env`、不碰文件系统 |
| `installEnforcementRoot(input)` | 装配**一次**，并把那一份交出去（幂等） |
| `enforcementRoot()` / `enforcementInstallation()` | 装好的那一份 / 含拒绝的安装结果 |
| `resetEnforcementRoot()` | 丢掉进程级单例（**给用例**：不做这一步，测的是前面所有步骤的累积效果） |
| `enforcementContextOf(values)` | 解析结果 → 桥要的 Legion 上下文 |
| `root.mount(ctx)` / `root.dispose()` | 转 `assembleEnforcement` 的两行挂载/卸载 |
| `root.bootstrap(deps)` | 转 `bootstrapDshRuntime`（自检 → 只在通过时注册端口） |
| `root.bind(args)` | 转 `bindDshRuntime`（幂等注销） |

### 2.2 两行的**运行期**模块

`plugins/pre-execute-row.mjs` 与 `plugins/approval-answerer-row.mjs`。

它们**不是** `plugins/pre-execute.mjs` / `plugins/approval-answerer.mjs` 的替代品，
而是那两个工厂的运行期入口：从组合根取装配好的那一行，再 `ctx.plugin(row)`。

### 2.3 补丁层：`runtimeModule` 字段

`PATCH_LAYER_ROWS` 里那两行**仍然** `module: null`，新增一个 `runtimeModule`。
两个字段分工明确，且**不能合成一个**：

| 字段 | 含义 |
| --- | --- |
| `module` | 静态补丁层里能加载的模块 → 进了 `legion-host.patch.yml` |
| `runtimeModule` | 模块**存在**，但需要一个进程内装配好的组合根才挂得上 |

## 3. 三个关键判断，以及被否掉的那一个

### 3.1 组合根没装好时：**在 `apply` 期抛**，不挂空 listener

两条路都写出来再选：

| | 「不挂、只打一条诊断」 | 「`apply` 期抛具名码」 |
| --- | --- | --- |
| 组合树里长什么样 | **一行装好的行** | 加载失败，当场可见 |
| `reconcilePatchLayer()` 报什么 | `OK`（它判的是 **waiting**，即 `ROW_NOT_ACTIVATED`，而 inert 不走那条分支） | 加载错误 |
| 启动自检的结论 | 「这一行已生效」 | 失败 |
| 真实强制面 | 不存在 | 不存在，但**被报出来了** |

选后者。**一个"挂上了、但什么都没接管"的行，与一个"从来没被写进补丁层"的行，
在组合树里长得一模一样——只不过前者的文件看起来是装好的。**

代价说清楚：抛会让加载它的那次 `ctx.plugin()` 失败。这是**想要**的——本行**不在**
`legion-host.patch.yml` 里（静态层装不了它，见 §2.3），所以这个失败只可能由
"某处显式地把这一行挂进一个没装配过的进程"触发；那种处境下唯一正确的行为就是响亮地失败。

同一口径在 `plugins/hard-floor.mjs` 的 `NO_GUARD_SEAM` 已经用过一次，
而且**已被证明可观测**：真运行时用例用 `assert.rejects(await ctx.plugin(...))` 钉住了它。

### 3.2 配置：三种处境必须是**三个**码

| 码 | 处境 | 修法 |
| --- | --- | --- |
| `ENFORCEMENT_ROOT_CONFIG_MISSING` | 没有任何配置来源 | 去找部署方要配置 |
| `ENFORCEMENT_ROOT_CONFIG_EMPTY` | 来源在，一个字段都没给 | 看是不是变量名写错 / 漏填 |
| `ENFORCEMENT_ROOT_CONFIG_UNREADABLE` | 来源在，读不出来（坏 JSON / 不是对象） | 去修那份坏掉的文件 |

> 合成一个码的话，一份**解析失败**的配置会长成一份**从未被设置**的配置。

字段级同样逐字段报码（`NO_HUB_URL` / `NO_ACTOR` / `NO_SCOPE` / `NO_ACTION` / `NO_CWD`），
**一个都不补默认值**：一个默认 hub 地址或默认 actor 会让「没配」与「配对了」
在读数上完全同形，而默认 `action` 还会进 canonical 授权哈希。

### 3.3 `bootstrap` / `bind` 的输入由调用方显式给，**本模块不补**

- `root.bootstrap(deps)`：少给 `canRead` 时 `bootstrapDshRuntime` 自己拒绝
  （`BOOTSTRAP_BAD_WIRING`），而它拒绝时**什么都不注册**——这正是要保住的性质；
- `root.bind(args)`：少给 `selfCheck` 时 `bindDshRuntime` 当场抛
  `TypeError(/selfCheck/)`。**不补一个"自检通过"的默认值**——那会让这个注册口
  自己变成绕过 PRT-215 的入口。

## 4. ★ 踩过的那个坑：自证的诊断

第一版 `bindingOf(row)` 用 WeakMap **记下装配方传了什么**：

```js
// ✗ 第一版
for (const row of Object.values(rows)) ROW_BINDINGS.set(row, { bridge, registry: sharedRegistry })
```

然后用例对着这份记录断言"两行共用同一本登记簿"。

**把一个"answerer 行被传了另一本登记簿"的实现改出来之后，用例照样全绿**——
因为账本记的是"我以为传了什么"，不是"行实际闭包到了什么"。

> 一个"记录了我传了什么"的诊断，
> 与一个"记录了行实际拿到什么"的诊断，在传错参数时是同一个东西——
> 只不过前者的用例是绿的。

改为**读行自己报出来的**绑定：`createPreExecutePlugin` / `createApprovalAnswererPlugin`
用 `Object.defineProperty(..., {enumerable: false})` 把实际的 `bridge` / `registry` / `port`
挂在插件对象上。不可枚举，因为那是**活对象**，不该走 `JSON.stringify`。

改完之后同一个探针**真的报红**了（见 §6 的断验证记录）。

## 5. 断验证：每条关键断言都做了"改坏它、看它红不红"

诊断本身也要被诊断。改坏一处、跑一遍、看红不红、**立刻改回**：

| # | 改坏的地方 | 应当报红的用例 | 结果 |
| --- | --- | --- | --- |
| 1 | answerer 行改用 `createInFlightRegistry()`（拆开共用登记簿） | 两行共用同一本登记簿（身份） | ✗→改回 ✗ **第一版它没红**，见 §4 |
| 2 | 单例不认"拒绝"，一律返回 `ALREADY_INSTALLED` | 装了但拒绝之后**允许重试** | ✓ 报红 |
| 3 | 行模块**先挂一个空 listener 再抛** | 拒绝时**不注册任何 listener** | ✓ 报红 |
| 4 | `moduleState` 两种处境合成 `'absent'` | 两种"造不出来"是两种读数 | ✓ 报红 |
| 5 | "没给来源"与"配了个空"同码 | 三个不同的码 | ✓ 报红 |
| 6 | 行模块装好了却**不挂**（静默成功） | 反向对照：装好了真的挂上 | ✓ 报红 |
| 7 | answerer 的 port 在半路被换掉 | port 身份 = 调用方注入的那一个 | ✓ 报红 |
| 8 | `ENFORCEMENT_CONFIG_FIELDS` 里多一个 env 键 | env 键名是闭集 | ✓ 报红 |

探针 1 是最有价值的一条：**它证明了"我以为在守"和"真的在守"不是一回事。**

## 6. 诚实边界

以下每一条都是**没做完 / 靠猜 / 没验过**的，不是"已完成"的另一种说法。

1. **两个插件行仍然不在 `legion-host.patch.yml` 里。**
   `renderPatchReport().complete === false`，`render.mjs --write` 仍然 **exit 3**。
   本批次**没有**让这一层变完整——它只是把"缺的是模块"与"缺的是装配路径"分开了。
   `reconcilePatchLayer()` 照旧把这两行报成 `ROW_MISSING`，启动自检照旧拒绝注册（fail closed）。

2. **★ 环境变量名是我选的，不是从 spec 读来的；而且 `scan --check` 看不见它们。**
   `TEAM_HUB_URL` / `TEAM_HUB_TOKEN` 是仓库既有约定
   （`orchestrator/worker/run.mjs` 的 `WORKER_ENV`，已在
   `orchestrator/config-schema.mjs` 的 `ENV_NAMES` 里声明）；而
   `LEGION_ACTOR` / `LEGION_SCOPE` / `LEGION_ENFORCEMENT_ACTION` / `LEGION_CWD` / `LEGION_TASK_ID`
   **在本批次之前没有任何权威来源**——它们集中在 `ENFORCEMENT_CONFIG_FIELDS` 一处，
   改名只动那一处。**没有验证过任何真实部署在用这些名字。**

   更要紧的一层：`runtime/` **不是** `scripts/config/scan.mjs` 登记的进程目录
   （`scripts/config/check.mjs` 的 `SCHEMA_FILES` 只有 team-hub / workbench /
   whiteboard / plugins / board-plugin / services-plugin / product / orchestrator）。
   所以本仓库那条硬规矩——「每一个新的 SCREAMING_SNAKE_CASE 字面量都要在
   **所属进程**的 `config-schema.mjs` 里声明」——在这里**没有所属 schema 可声明**，
   `scan --check` 对它 PASS 是**扫描面没覆盖**，不是"已声明"。

   > 一个没有机器判据的规矩，与一条不存在的规矩，
   > 在"它到底拦住了什么"上是同一个东西。

   本批次的应对**只是权宜**：`root.test.mjs` 里加了一条"env 键名是闭集"的用例，
   多读一个键就报红。真正的修法是给 `runtime/` 建一份 `config-schema.mjs`
   并把 `runtime` 登记进 `SCHEMA_FILES`（含 `topology-inventory` 的声明缺口对账）——
   **那不在本批次范围内，也**没有**做。

3. **组合根本身仍然没有生产调用方。**
   本批次补上的是"调用链存在且被证明可用"，**不是**"它已经在跑"。
   让它真的被调用的那一处（DSH 进程内的挂载点 + Launcher）**不在本批次范围内**。

4. **端口一律由调用方注入，`decide` 没有生产实现。**
   全仓库只有测试实现。`createRequestApproval` 工厂同样由调用方提供——
   真实的 hub 客户端住在 `team-hub/`，而 `runtime/` → `team-hub/` 与既有的
   `team-hub/` → `runtime/` 相撞（`scripts/ci/run-ci.mjs` 里记着反向实测 0 处），
   所以本模块**不**import 它。

5. **`root.mjs` 不写补丁层、不 mount 任何东西。**
   DSH 的用户 profile 是 `patchReload: 'live'`，往运行中的 profile 写入会立刻改掉
   **正在跑的 harness 的强制面，包括本次会话自己**。挂载时机由调用方决定并留痕。

6. **本批次没有跑 `scripts/ci/run-ci.mjs` 全量。**
   跑的是：本套件、`runtime/dsh-composition/*.test.mjs` 全目录、
   `team-hub/approval-port.test.mjs`、`--only boundary` 棘轮、`scan --check`、
   `ci-syntax`、`encoding-check --all`、`check-docs`。
   **L0 全量、构建、冒烟未跑**（按操作方要求由操作方执行）。

7. **`apply(ctx)` 抛错的后果只被假 Context 验过。**
   `root.test.mjs` 的 `fakeContext()` 只实现 `on` / `effect` / `plugin`，
   **不建模 `inject` 的等待语义、也不建模子 fiber 的独立作用域**。
   真 DSH 那两条由 `enforcement-plugin.test.mjs`（真 `ToolRuntime` + 真 `Context`）守，
   但那个套件**没有覆盖这两个 `-row.mjs` 模块**——它们只被假 Context 跑过。

8. **`runtimeModule` 的"值正确性"没有被 DSH 自己的加载器验过。**
   套件断言的是"路径解析到一个真实存在的文件"。**没有**验证 DSH 从
   `file://` 加载这个 `default` 导出之后行为符合预期——那需要把组合根装进一个
   真 DSH 进程，而本批次刻意没有这么做（见第 5 条）。

9. **`ENFORCEMENT_ROOT_VERSION` / 两个 `*_ROW_VERSION` 目前都是 1。**
   它们是"接口变了就递增"的约定，**没有任何判据在读它们**，因此
   忘改不会有任何东西报红。

10. **"两行共用同一本登记簿"是把两张 `===` 断言当成证据的。**
    它证明的是**引用相同**；"共用带来的行为正确性"（一行 `put`、另一行真的
    `peek` 到）由 `pre-execute.test.mjs` 的全链路用例守，那一组需要
    `DSH_CHECKOUT` 与真 `ToolRuntime`。

## 7. 复跑命令

```powershell
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'

# 本批次新增（组合根）
node --test runtime/dsh-composition/root.test.mjs

# dsh-composition 全目录（538 用例）
node --test "runtime/dsh-composition/*.test.mjs"

# 相邻：hub 审批端口
node --test team-hub/approval-port.test.mjs

# 棘轮 + 静态检查
node scripts/ci/run-ci.mjs --only boundary
git add -A
node scripts/config/scan.mjs --check
node scripts/ci/ci-syntax.mjs
node scripts/ci/encoding-check.mjs --all --quiet
node scripts/ci/check-docs.mjs
```

---

# 8. 续批：给组合根接上**第一个生产调用方**

> 上一批的 §6.3 写着「组合根本身仍然没有生产调用方」。
> 这一批就是去还那一笔。**这一节不改上面任何一段**——上面记的是上一批当时的事实。

## 8.1 还掉的是哪一笔

上一批把链子从「三件装配函数」接到了 `installEnforcementRoot()`。
但 `installEnforcementRoot()` 仍然**只被用例调过**，所以 `enforcementRoot()`
在真实部署里永远是 `null`：

> 一个"有人可以调"的装配入口，与一个"从来没有被调用过"的装配入口，
> 在运行的部署上是同一个东西——只不过前者的用例是绿的。

这一批补的是这两截：

```
legion-host.patch.yml 里的 root 行  →  plugins/root-row.mjs  →  installEnforcementRoot()
                                                                     ↑
                                            Launcher 经 runtime.env 注入的身份
```

## 8.2 交付了什么

| 文件 | 作用 |
| --- | --- |
| `runtime/dsh-composition/plugins/root-row.mjs` | **新增**。补丁层里的 root 行：读环境 → 装组合根 → 发布服务 |
| `runtime/dsh-composition/plugins/root-row.test.mjs` | **新增**。24 条，含真 cordis `Context` 的激活/行序判据 |
| `runtime/dsh-composition/plugins/pre-execute-row.mjs` | 改：`inject` 加上组合根**服务名** |
| `runtime/dsh-composition/plugins/approval-answerer-row.mjs` | 改：同上 |
| `runtime/dsh-composition/patch-layer.mjs` | 改：新增 root 行（`insert` 锚到 `tools` 之后） |
| `runtime/dsh-composition/legion-host.patch.yml` | 重新生成：`insert` 里多了 `legion-enforcement-root` |
| `runtime/dsh-composition/index.mjs` | 改：转发 root 行的出口 |
| `product/launcher/enforcement-identity.mjs` | **新增**。身份 → `runtime.env` 的解析（纯函数） |
| `product/launcher/enforcement-identity.test.mjs` | **新增**。22 条 |
| `product/launcher/launcher.mjs` | 改：接上身份解析，诊断进 `rawPlanDiagnostics` |
| `product/launcher/cli.mjs` | 改：把 `fromConfig.runtimeEnv` 传给 `createLauncher` |
| `product/config.mjs` | 改：`runtime.env` → `out.runtimeEnv` |
| `product/process-manifest.mjs` | 改：runtime 的 `envNames` 声明那 9 个键 |
| `product/config-schema.mjs` | 改：注入表 + `CHILD_ENV_NAMES` + `ENFORCEMENT_IDENTITY_MISSING` |
| `runtime/dsh-composition/root.test.mjs` 里的 `installEnforcementRoot` | **未改**。本批不动组合根 |

## 8.3 ★ 加载顺序：用**服务依赖**，不用行序

这是本批唯一一个"必须想清楚才能做对"的地方。

`legion-host.patch.yml` 的 `insert` 是给 DSH 的 `EntryOptions[]`，**行顺序不携带
加载语义**——它不表达"这一行要在那一行之前 apply"。所以"根先装配好、两行再取它"
这件事**不能**寄望于把 root 行写在前面。

选的做法是 Cordis 原生的那一种：

1. `root-row.mjs` 在 `apply` 里 `ctx.provide('legionEnforcementRoot', 那一份安装结果)`；
2. 两个 `-row.mjs` 的插件对象声明 `inject: ['tools'|'approval', 'legionEnforcementRoot']`；
3. 于是 Cordis 的 fiber 状态机让它们在服务出现之前处于 **waiting**，服务
   `notify()` 之后才 `_checkImpl` → 激活。**行序完全无关。**

被否掉的另一条路：让 `-row.mjs` 自己 `ctx.get('legionEnforcementRoot')`，拿不到就
在 `apply` 期抛。那样"顺序对了"和"顺序错了"都会在**加载期**决出胜负，而
`reconcilePatchLayer()` 判的是 **waiting**（`ROW_NOT_ACTIVATED`）——抛出来的失败
走的是另一条分支，会让审计报告说"加载错误"而不是"这一行还没激活"。
更坏的是它把一条**时序**要求写进了补丁文件的行序里，而那份行序不携带这个语义。

### 8.3.1 它是**真的**验过的，而且做了断验证

`root-row.test.mjs` 里那两条不是对着假 Context 写的：

- 从 `$DSH_CHECKOUT` 里 `import` **真 cordis** 的 `Context`；
- 造一个真 `Context`，`provide` 两个 `-row.mjs` 要的 `tools` / `approval`；
- **先**加载两行（此时组合根服务还没有 → 两行必须停在 waiting）→ **最后**加载
  root 行 → 断言两行**确实激活**（探针：`ctx.waterfall('tools/pre-execute', ...)`
  从返回 `'NO-LISTENER'` 变成走到了真正的守卫）；
- **反向控制**：根行**最先**加载时两行也激活（证明上面那条不是在测"顺序无关"的
  某个副产物）；
- **第三方对照**：根**真的缺席**时两行停在 waiting（`ROW_NOT_ACTIVATED`），
  **不是**抛、也**不是**静默 no-op。这三条读数互不相同。

**断验证做过一次，是这批里最有价值的一条**：把 `ENFORCEMENT_ROOT_SERVICE`
从 `pre-execute-row.mjs` 的 `inject` 里删掉，**恰好**那两条顺序用例报红
（`根行最后加载…` 与 `根行真的缺席时…`），而反向控制的第三条**保持绿色**。
删掉之后立刻改回，563 条全绿。这说明这两条用例的判据是**服务依赖**本身，
不是"跑了一遍没抛错"。

## 8.4 Launcher：身份从哪来，以及三种处境

`product/launcher/enforcement-identity.mjs` 是纯函数，输入只有三样：
本次启动的 team-hub 端口、Runtime 进程计划里的 `cwd`、以及产品配置的 `runtime.env`。

| 字段 | 来源 | 为什么不给默认值 |
| --- | --- | --- |
| `TEAM_HUB_URL` | **派生**（`http://127.0.0.1:<本次端口>`） | 与 workbench 的 `DSH_HUB_UPSTREAM` 同一条理由：让每个进程按各自的默认值去猜，会在端口被改掉时静默指向**另一个** hub |
| `LEGION_CWD` | **派生**（spawn 时的 `cwd`） | 工具调用投影出的路径按它展开；可覆盖会让"授权时的路径"与"执行时的路径"落在两个根上 |
| `LEGION_ACTOR` / `LEGION_SCOPE` / `LEGION_ENFORCEMENT_ACTION` | 只能来自 `runtime.env` | 本批找不到任何权威来源。一个默认 actor 会让审计里的主体变成**谁也不是的名字** |
| `LEGION_TASK_ID` | `runtime.env`，可选 | 组合根允许它是 `null`（进程级装配时常常还没有任务） |
| `LEGION_APPROVAL_POLICY` / `LEGION_ATTENDED` / `LEGION_PERMISSION_PRESET` | `runtime.env`，可选 | Launcher 没有"现场有没有人"这个事实的任何来源；缺了由 `decide` 在**判定期** fail closed |

三种处境是**三个**读数（`enforcement-identity.test.mjs` 有一条元判据断言它们
`new Set(...).size === 3`）：

| 处境 | 预检 | 谁在说话 |
| --- | --- | --- |
| 覆盖层开 + 身份齐 | 通过 | —— |
| 覆盖层开 + 身份缺 | **拦下**（`phase: 'plan'`） | `ENFORCEMENT_IDENTITY_MISSING`（error） |
| 覆盖层关 | 通过 | `DSH_OVERLAY_DISABLED_BY_CONFIG`（warn，一条） |

★ 「身份缺」与「故意关掉」**必须是两个码**。合成一个的话，一个关掉了覆盖层、
因而本来就不需要身份的正常部署，会被报成"身份缺失"——而这两者的修法完全相反
（一个什么都别做，一个去补配置）。

★ 覆盖层关时**刻意沉默**：关掉这件事已经由 `resolveDshOverlay()` 说过一次。
再说一次就是"同一件事有两个判定点"，而两份口径总有一天会不一致。

★ 身份缺**不降级为 warn**，与 `PATCH_FILE_MISSING` 同一条判据：只报 warn 会得到
一个"看起来装了强制面"的部署，而它要么在 DSH 进程里以一条**别处**的错误收场
（用户会去查 runtime 为什么起不来），要么被 warn-and-skip 掉、运行时照常起来、
强制面为零。

★ 范围不含 runtime 时（`--include runtime` 之外），这条 error 由既有的
`PROCESS_EXCLUDED_BY_SCOPE` 机制降级为 warn，受限启动照常通过。

## 8.5 接的是**既有**的配置通路，没有发明键名

`runtime.env`（"注入 Runtime 子进程的额外环境变量（不含密钥）"）**早就在**
`product/config.mjs` 的 `KNOWN_CONFIG_KEYS` 里——但此前**没有任何读取点**。

> 一个"配置里声明了、而没有任何代码读它"的键，
> 与一个不存在的键，在部署上是同一个东西——只不过前者看起来是配好的。

本批只做了一件事：让这条早就写下的通路真的通。取值时**只收非空白字符串**：
数字与布尔被静默转成字符串会得到"配置写错了、直到第一次需要人审批才发现"的失败。

`buildChildEnv()` 对未在目标进程 `envNames` 里声明的键**直接抛**，所以那 9 个键
同时进了 `product/process-manifest.mjs` 的 runtime `envNames` 与
`product/config-schema.mjs` 的 `CHILD_ENV_NAMES`。测试里有一条断言
`runtime` 的 `envNames` 是**闭集**（只允许 `DSH_HOME` / `LEGION_*` / `TEAM_HUB_*`）。

★ `product/` **不能** import `runtime/dsh-composition/`（依赖方向相反），
所以注入端的键名与读取端的 `ENFORCEMENT_CONFIG_FIELDS.envKeys` 是
**同一份事实的两个副本**。`enforcement-identity.test.mjs` 有一条用例逐字段钉住
两边相同、必填清单相同，另有一条与 `root-row.mjs` 的 `DECIDE_ENV_KEYS` 对账。

> 一个"注入端与读取端各写一遍键名、而没有判据说它们相同"的接线，
> 与一个"注入了一个没人读的变量"的接线，在运行时表现完全一样。

## 8.6 一个被门禁**误读**成事实的产品文案

`scan --check` 第一次跑**报红 4 项**：`LEGION_ACTOR` / `LEGION_SCOPE` /
`LEGION_ENFORCEMENT_ACTION` / `LEGION_TASK_ID` 被记成 `product/` **直接读取**的
env 键，来源是 `enforcement-identity.mjs` 的 `FIELD_SOURCES` 里那四句
`…产品配置 runtime.env.LEGION_ACTOR…`。

原因是 `scan.mjs` 规则②的正则 `\w*[Ee]nv\.([A-Z][A-Z0-9_]*)`：它扫**源码文本**、
不看上下文，于是 `env.` 后面跟一个大写字面量就算一个读取点——**那是一句产品文案**。

修的是**文案**，不是 schema。键名照样逐字给出（改成用「」括起来），用户仍然知道
该往哪儿写。**没有**把这四个键补进 `product` 的 `envNames()`：

> Launcher **不读** `LEGION_ACTOR`，它只把它**写进子进程**。
> 为哄过门禁而往配置面上写一条假读取点，
> 与一条真实的读取点，在"这个进程到底吃什么配置"上是两个答案。

## 8.7 诚实边界（续批）

下面每一条都是**没做完 / 靠猜 / 没验过**的，不是"已完成"的另一种说法。

1. **★ 没有任何东西在真实 DSH 进程里被验证过——一次都没有。**
   本批**真的**驱动过真 DSH CLI 去试：`$DSH_CHECKOUT/apps/cli/lib/bin.js`，
   临时 `DSH_HOME`、空 profile、`--patch <探针.patch.yml> --dump-config`。
   结果是 **`code 0`，而探针模块的 `apply` 没有跑**（探针往 stderr 写
   `PROBE-APPLY-RAN`，一个字都没出现）。结论说清楚：

   - `--dump-config` **解析并锚定**了补丁行——Legion 层的输出里确实出现
     `legion-enforcement-root` → `file:///…/plugins/root-row.mjs`；
   - 但它**从不实例化插件**。因此仓库既有的 `dsh-overlay.test.mjs` 那 17 条断言
     全是**解析期接受度**，不是"这一行真的挂上了"。

   DSH 只有 `web` / `plugin` / 裸位置参数三种会真正启动的子命令，
   而启动一个 profile 会去 auth / 探凭据。**没有做**。所以：
   **`root-row.mjs` 的 `apply` 有没有在真进程里跑过，本批没有证据。**
   同一条也适用于 `pre-execute-row.mjs` / `approval-answerer-row.mjs`：
   它们只在 `root-row.test.mjs` 那个**真 cordis `Context`**（进程内，不是 DSH 进程）里激活过。

2. **`decide` 从来没有做过一次真实的决定。**
   `approval-policy.mjs` 的 `decideApproval` 被 `assertNoneShortcutHolds()` 在
   模块加载期探过一次契约（`requiresApproval !== true` → 必须 allow），
   探针本身在用例里被一个假实现证明**非空转**。但**没有任何一次真实的
   `PreToolDecision` 走完过 `createPolicyDecide`**。它只在真 cordis `Context` 上
   被 `pre-execute` 的瀑布调用过——而那条路径上的守卫是测试用的假守卫。

3. **`runtime/` 仍然在 `scan.mjs` 的扫描面之外。**
   `runtime` **不是** `PROCESSES` 里登记的进程，所以 `scan --check` 对
   `root-row.mjs` 里读写的那 9 个 `LEGION_*` 键**一个字也看不见**。
   它 PASS 是"扫描面没覆盖"，不是"已声明"。
   **本批没有**把 `runtime` 加进 `PROCESSES`——实测那样会一次冒出**约 196 个**
   既存字面量，那是另一个批次的事。
   `product/` **在**扫描面内，所以 `enforcement-identity.mjs` 的字面量是真被
   门禁管着的（见 §8.6，`scan --check` 现在是 exit 0）。

4. **团队侧那个 `setApprovalPortFactory()` 的注册者没有交付。**
   `root-row.mjs` 走的是**注入工厂**路线（`createRequestApproval` 由调用方给），
   而不是 import `team-hub/approval-port.mjs`——因为那会形成真实的模块环
   （`approval-port.mjs` → `tool-request-bridge.mjs` → `runtime/dsh-composition/tool-args.mjs`），
   且 `runtime/` → `team-hub/` 与既有的 `team-hub/` → `runtime/` 相撞。
   **于是现在没有任何生产代码调用 `setApprovalPortFactory()`**：
   谁都没注册时，root 行报 `ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY` 并拒绝。
   这是**故意的、响亮的**拒绝，不是静默半装。
   但要说清楚：**"响亮地拒绝"仍然是"强制面没有装上"。**

5. **`*_VERSION` 常量没有任何读取者。**
   `ROOT_ROW_VERSION` / `ENFORCEMENT_IDENTITY_VERSION` 是"接口变了就递增"的约定。
   忘改不会有任何东西报红——与上一批 §6.9 同一个缺口。

6. **`hold` → `ask` 是一次判断，不是从 spec 读来的。**
   `approval-policy.mjs` 的 `hold`（策略是 `ask`、而现场没人在）在 DSH 的
   `PreToolDecision` 里**没有对应物**。`root-row.mjs` 把它映射成 `ask`，
   好让审批端口的 `unavailable` 路径给出"还在等"，而不是"有人拒绝了"。
   这个理由写进了代码，但**它是一个判断**：spec 没有规定该怎么办。

7. **两个副本的一致性只有用例在守。**
   §8.5 说的键名对账、必填清单对账，靠的是 `enforcement-identity.test.mjs`
   里**手写**的那份期望值。它是判据，但它守的是"这两处现在一样"，
   **不是**"它们按定义必须一样"——真正的修法是让 `product/` 合法地读到那份
   字段表，而那会写反依赖方向。

8. **`runtime.env` 的值不做任何校验，也不做 shell 展开。**
   `LEGION_ACTOR=' '`（全空白）算缺失（有用例）；但 `LEGION_SCOPE='$HOME/x'`
   会**原样**传下去。没有"这个 actor 存在吗"的检查——本批找不到能回答它的东西。

9. **本批同样没有跑 `scripts/ci/run-ci.mjs` 全量**（按操作方要求）。
   跑过的、以及逐条结果都在 §8.8。

10. **`legion-host.patch.yml` 仍然不完整。**
    `render.mjs --write` 仍然 **exit 3**：`PATCH_LAYER_ROWS` 里
    `pre-execute` / `approval-answerer` 两行仍然 `module: null`（只有
    `runtimeModule`）。本批**没有**让这一层变完整——root 行是**新加**进
    `insert` 的那一行，它不解决另外两行。

11. **★ 上一批那两条 `NO_COMPOSITION_ROOT` 拒绝，在真实组合里已经走不到了。**
    这是本批一次**有意的、说清楚代价的**行为变更，不是笔误：

    | | 上一批 | 本批 |
    | --- | --- | --- |
    | `-row.mjs` 的插件对象 | 没有 `inject` | `inject: [..., 'legionEnforcementRoot']` |
    | 根不在场时 | `apply` 被调用 → 抛 `NO_COMPOSITION_ROOT` | `apply` **根本不被调用**，fiber 停在 waiting |
    | 谁报出来 | 那个异常 | 挂载审计把它报成未激活（`ROW_NOT_ACTIVATED`） |

    于是 `root.test.mjs` 里 `preExecuteRow.apply(pre.ctx)` 那几条（第 371–381、
    626 行）**是直接调 `apply()`**、绕开了 Cordis —— 它们仍然证明"拒绝逻辑本身
    正确"，但**不再描述真实组合里会发生什么**。那句话是本批必须说清楚的：
    在真实 DSH 进程里，根缺席的表现是**这一行没激活**，不是一条异常。

    为什么仍然选 waiting：行序不携带加载语义（§8.3），而"根先装好"这件事
    只有两种保证方式——服务依赖，或者把顺序假设写进补丁文件的行序。
    后者在 DSH 里**没有载体**。`apply` 里那个抛**保留着**（作为直接调用时的
    防御），但它现在是**第二道**，不是第一道。

    ★ 另外：本批**没有**在真 cordis `Context` 上跑过 `reconcilePatchLayer()`
    来亲眼确认它把 waiting 的行报成 `ROW_NOT_ACTIVATED`——那个读数是**引用**
    上一批 §3.1 的结论，不是本批复验的。这条**没有被本批验证过**。

12. **`--dump-config` 那次探针只证明了"解析期"这一件事。**
    为避免误读：那次真 DSH CLI 的运行**没有**、也**不可能**证明 root 行会
    在运行期挂上。它证明的是"这份补丁文件被接受了、且 Legion 层被锚上了"。
    两者很容易被当成同一件事，所以单列一条。

## 8.8 复跑命令与实测结果（续批）

```powershell
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'

# 本批新增
node --test runtime/dsh-composition/plugins/root-row.test.mjs      # 24/24 pass
node --test product/launcher/enforcement-identity.test.mjs          # 22/22 pass

# dsh-composition 全目录（539 用例）+ 插件行那一个（24 用例）
node --test "runtime/dsh-composition/*.test.mjs"                    # 539 pass / 0 fail
node --test "runtime/dsh-composition/plugins/*.test.mjs"            #  24 pass / 0 fail

# 相邻：hub 审批端口
node --test team-hub/approval-port.test.mjs                         #  19 pass / 0 fail

# product 全套（含本批改动的 6 个文件）
node --test product/launcher/*.test.mjs product/paths.test.mjs `
  product/process-manifest.test.mjs product/config.test.mjs `
  product/config-schema.test.mjs                                    # 402 pass / 0 fail

# 静态门禁
git add -A
node scripts/config/scan.mjs --check                                # exit 0
node scripts/ci/ci-syntax.mjs                                       # PASS（50 个脚本）
node scripts/ci/encoding-check.mjs --all --quiet                    # PASS（1887 个文件）
node scripts/ci/check-docs.mjs                                      # PASS（10 类校验项）
node scripts/ci/dsh-boundary.mjs --check                            # PASS（4 文件 / 27 处，基线内）
```

**没有跑**：`scripts/ci/run-ci.mjs` 全量、构建、冒烟。
**没有**往任何真实 profile 写补丁文件；**没有**把强制面挂进正在跑的 harness。

### 8.8.1 断验证记录（续批）

| # | 改坏的地方 | 应当报红 | 结果 |
| --- | --- | --- | --- |
| 1 | `pre-execute-row.mjs` 的 `inject` 里删掉 `ENFORCEMENT_ROOT_SERVICE` | 「根行**最后**加载」+「根**真的缺席**时」两条 | ✓ 恰好这两条报红；**反向控制**（根行最先加载）保持绿 → 已改回 |
| 2 | 文案 `runtime.env.LEGION_ACTOR` 的形状 | —— | 这是被 `scan.mjs` 抓到的**误读**（§8.6），不是用例；改文案后 `scan --check` exit 0 |

探针 1 是关键的一条：它证明「根行最后加载仍然激活」这个读数是**服务依赖**
给的，不是碰巧。

