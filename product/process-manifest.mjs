// product/process-manifest.mjs
// ============================================================================
// 产品进程清单与启动契约（PRT-258 契约冻结 / PRT-251+PRT-701 的共同输入）
//
// spec §6.10 规定 Product Launcher 管理五个进程：
//
//   team-hub → Workbench 静态服务 → DSH Runtime → Legion Orchestrator worker
//   （可选 Whiteboard 服务）
//
// 并把「进程清单、启动依赖和健康协议」列为 PRT-701 的定义对象。
// 本模块只做**声明与校验**，不 spawn 任何进程——启动、监督、退避与熔断属
// `product/launcher/`（PRT-251 / PRT-704）。这样划分的理由是：
// 进程清单要能在**不启动任何东西**的前提下被用例校验，否则「依赖顺序错了」
// 这类缺陷只能在真机上以「偶发 500」的形式出现。
//
// ## 与既有 `services-plugin/index.js` 的关系
//
// 现有实现（DSH Desktop 内）只托管 2 个进程、只做 TCP 连接探测、没有熔断、
// dispose 时直接 `kill()`。本清单是它的**严格超集与替代契约**：
// 另加 DSH Runtime 与 Orchestrator worker，并把就绪判据从「端口能连」升级为
// 「能连 + 契约端点回应」——端口能连只说明有东西在听，不说明是对的东西。
//
// ## 未交付项一律显式声明（不得当成已完成）
//
// `MANIFEST_KNOWN_GAPS` 列出当前**确实还不存在**的条目。用例把这份缺口清单钉住：
// 缺口被补上时用例会红，提醒把清单和文档一起更新——避免「文档说没有，
// 代码里其实已经补上了」这种反向漂移（它比漏做更难发现）。
// ============================================================================

import { posix, win32 } from 'node:path'

import { isPathInside, pathApi, samePath } from './paths.mjs'

/**
 * 进程清单契约版本：清单结构变化时递增（产品版本清单会引用它）。
 *
 * ★ 2026-09-17 由 `1` 提到 `2`。这是在补一次**漏掉**的递增，不是本次新增：
 *   PRT-251 续给 runtime 行加了 `portArgv`（一个**新字段**，见下面 `PROCESS_SPECS`
 *   的字段表），却把版本留在了 `1`；本批又加了 `hostArgv` / `boolArgv`。
 *
 *   于是这个常量的含义与它的值**已经不一致了两批**：一个读
 *   `PROCESS_MANIFEST_VERSION === 1` 的消费者，有理由认为行上不存在这三个字段，
 *   而它们一直都在。如实补上而不是继续留着——因为"同一个字段表下，
 *   有的行有 `portArgv`、有的没有"这种事，只有靠版本号才看得出来。
 *
 *   ⚠️ 今天**没有**任何消费者读这个值（全仓库只有 `product/index.mjs` 的再导出；
 *   `role-pack` / `packs` 那些 `manifestVersion` 是另一套东西）。所以这次递增
 *   不改变任何行为——它的作用是把"这个常量说了谎"变成"它说的是真的"。
 *   值本身由 `product/process-manifest.test.mjs` 钉住，好让下一个加字段的人
 *   当场看见自己该动它。
 */
export const PROCESS_MANIFEST_VERSION = 2

/** 默认端口。运行期可被产品配置覆盖，但默认值集中在这里，避免散落在各进程里。 */
export const DEFAULT_PORTS = Object.freeze({
  runtime: 3080,
  'team-hub': 8787,
  workbench: 5173,
  whiteboard: 8080,
})

/** 只允许回环监听（spec §10「默认只监听 loopback」）。 */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

/**
 * 五个进程的声明。
 *
 * 字段含义：
 *   - `kind: 'server'` 必须有端口与就绪判据；`kind: 'worker'` 是常驻无端口进程。
 *   - `entry.kind: 'node-file'` 的路径相对安装目录；`'configured'` 表示命令由
 *     产品配置提供（DSH Runtime 走 PRT-011 裁决的路线 C：Launcher 把 npm 包装进
 *     DataDir，因此**没有**固定相对路径，不能在这里猜一个）。
 *   - `writesRoles` 引用 §6.11 的目录角色；`install` 永不允许出现在可写角色里。
 *   - `envNames` 是该进程**从环境读取**的键（声明面，不是运行期实际值）。
 *   - `milestone` 指向实现该进程真实入口的任务号。
 *   - `portArgv`（**可选**，PRT-251 续）：该进程用**哪个 argv 旗标**接收端口，
 *     例如 `['--port']`。值由 `materializeProcessPlan()` 在**末尾**补上。
 *     它必须与 `argsTemplate` 分开，理由见 §5.1 —— 一句话：
 *
 *       > 对 DSH 这种「launcher 旗标在前、app 旗标在后」的命令行，
 *       > 把 `--port` 放进 `argsTemplate` 会让它后面的 `--patch` **变成 app 参数**
 *       > （DSH 的解析器遇未知 token 即 passthrough），于是强制面补丁层静默消失，
 *       > 而这次启动**照样成功**。
 *
 *     所以「端口」不是「又一个模板占位符」，它是**位置敏感**的：必须在所有
 *     launcher 旗标之后。写成一个独立字段，位置这件事才是可断言的。
 *
 *   - `hostArgv` / `boolArgv`（**可选**，PRT-251 续批）：**同一件事的另外两面**。
 *     三者是一个概念（**app 段旗标**），只是命令行形态不同：
 *
 *     | 字段 | 形态 | 值来自 |
 *     | --- | --- | --- |
 *     | `portArgv` | 值旗标 | `ports.<portKey>` |
 *     | `hostArgv` | 值旗标 | 本 spec 的 `host` |
 *     | `boolArgv` | **开关**（无值） | 无 |
 *
 *     ⚠️ 但**冲突**的处置必须区分这两类，见 `materializeProcessPlan()`：
 *     两个**值**来源＝两个不同的答案（谁生效取决于 argv 先后）⇒ **阻塞**；
 *     重复一个**开关**＝同一个断言说了两遍 ⇒ **跳过**，不报错。
 *     把两者用同一条规则处理，必然有一边是错的：要么放过一个端口归属不明的部署，
 *     要么拦住一个本来正确的部署。
 *
 *     `boolArgv` 存在的具体理由（`--no-open`）：Launcher 已经**自己**管着
 *     「打开界面」这个决定，而且管得比裸进程更严——`tray-wiring.mjs` 只在
 *     见过 `READINESS_VERIFIED` 之后才把 workbench 地址交给浏览器。
 *     一个由 Launcher 拉起的 runtime 自己弹浏览器，等于**绕过**那道闸：
 *     在没有任何人观测过它是否就绪之前，用户的桌面上就多了一个页面。
 */
export const PROCESS_SPECS = Object.freeze([
  Object.freeze({
    key: 'team-hub',
    label: 'team-hub 数据面（SQLite / HTTP / SSE）',
    kind: 'server',
    required: true,
    dependsOn: Object.freeze([]),
    entry: Object.freeze({ kind: 'node-file', path: 'team-hub/server.mjs' }),
    cwd: '{install}',
    argsTemplate: Object.freeze([]),
    portKey: 'team-hub',
    defaultPort: DEFAULT_PORTS['team-hub'],
    host: '127.0.0.1',
    readiness: Object.freeze({
      kind: 'http',
      path: '/api/config',
      expectStatus: 200,
      // 身份断言（PRT-703）：`/api/config` 返回 { auth, db, port }（team-hub/server.mjs:4438）。
      // 断言 `port` 与本次启动的端口一致，才能区分「我们自己的实例」与
      // 「上一次升级前留下的旧实例 / 别的程序占了同一个端口」。
      expectJson: Object.freeze({ port: '{port}' }),
      timeoutMs: 30000,
      intervalMs: 250,
      verified: false,
    }),
    writesRoles: Object.freeze(['data']),
    // ★ PRT-610 起多一个 `LEGION_DATA_DIR`：hub 是**唯一持有 SQLite 连接**的一侧
    //   （`team-hub/server.mjs` 自己开库），而工具调用车道的收账（spool 文件 →
    //   `tool_calls`）只能在那本连接上做。它拿到的**只是目录锚**，不是凭证：
    //   `LEGION_RUNTIME_TOKEN` 仍然只注入 runtime 与 orchestrator。
    envNames: Object.freeze(['TEAM_HUB_PORT', 'TEAM_HUB_HOST', 'TEAM_HUB_TOKEN', 'TEAM_HUB_DB', 'LEGION_DATA_DIR']),
    milestone: 'PRT-251',
  }),
  Object.freeze({
    key: 'workbench',
    label: 'Legion Workbench（指挥台静态服务与代理）',
    kind: 'server',
    required: true,
    dependsOn: Object.freeze(['team-hub']),
    entry: Object.freeze({ kind: 'node-file', path: 'workbench/scripts/serve.mjs' }),
    cwd: '{install}',
    argsTemplate: Object.freeze(['--port', '{port}']),
    portKey: 'workbench',
    defaultPort: DEFAULT_PORTS.workbench,
    host: '127.0.0.1',
    readiness: Object.freeze({
      kind: 'http',
      // 走 `/hub/api/config`（serve.mjs:2540 的同源反代）而不是 `/`：
      // 拿到 200 只证明静态服务活着；代理能取到**正确 hub** 的 config 才证明
      // 「界面能拿到数据」。`{teamHubPort}` 由 Launcher 用清单里 team-hub 的端口展开。
      path: '/hub/api/config',
      expectStatus: 200,
      expectJson: Object.freeze({ port: '{teamHubPort}' }),
      timeoutMs: 30000,
      intervalMs: 250,
      verified: false,
    }),
    writesRoles: Object.freeze(['data']),
    envNames: Object.freeze(['DSH_HUB_UPSTREAM', 'TEAM_HUB_TOKEN', 'DSH_WORKBENCH_TOKEN']),
    milestone: 'PRT-251',
  }),
  Object.freeze({
    key: 'runtime',
    label: 'AI 执行引擎（受控 DSH Runtime）',
    kind: 'server',
    required: true,
    dependsOn: Object.freeze([]),
    entry: Object.freeze({ kind: 'configured', configKey: 'runtime.command' }),
    cwd: '{install}',
    argsTemplate: Object.freeze([]),
    // ★ PRT-251 续：端口**必须**走这里，不能走 `argsTemplate`。
    //
    //   DSH 的命令行是两段：launcher 旗标（`--profile` / `--patch` / `--dump-config`）
    //   在前，被启动的 app 的旗标（`--port` / `--host` / `--no-open`）在后。
    //   它的解析器带 `passThroughOptions()`：**遇到第一个不认识的 token 就停止解析
    //   自己的旗标**，从那以后所有东西都归 app。
    //
    //   而 Launcher 的 argv 是 `[…command.args, …argsTemplate, …extras]`，
    //   `extras` 里就是 `--patch <覆盖层>`。于是把 `--port` 放进 `argsTemplate`
    //   会拼出 `… --port 3081 --patch X`，其中 **`--patch X` 落进了 app 段**：
    //   DSH 照常启动、照常绑 3081、照常打印 URL——**强制面补丁层静默消失**。
    //
    //   `portArgv` 由 `materializeProcessPlan()` 追加在最末尾，于是顺序是
    //   `… --patch X --port 3081`，两段各归各位。这不是风格问题：一个
    //   「端口修好了但强制面没了」的启动，比「端口没修好」坏得多，而它看起来
    //   更像一次成功的修复。
    portArgv: Object.freeze(['--port']),
    // ★ PRT-251 续批：同一件事的另外两面（见抬头里那张表）。
    //
    //   `--host`：DSH 的缺省监听地址本来就是 `127.0.0.1`，所以今天传它**不改变
    //   行为**——但 `host` 这个字段并不是装饰：`ports.mjs:175` 拿它去
    //   `canBind()` 探测。于是「清单说 127.0.0.1、探测也探 127.0.0.1、
    //   而真正 bind 的是 DSH 自己的缺省值」这件事，今天全靠**两边缺省值恰好相同**
    //   才对得上。把它接上，`host` 才从"参与探测的字段"变成"参与探测**并且**
    //   决定实际监听"的字段——而这两者的差别要等到有人改 host 那天才显形。
    //
    //   `--no-open`：零参数开关。DSH 自己的帮助文本把它列为 app 族旗标，
    //   理由是"do not open the Web UI in the default browser"。
    //   Launcher 拉起它时**必须**给：见抬头里 `boolArgv` 那段。
    hostArgv: Object.freeze(['--host']),
    boolArgv: Object.freeze(['--no-open']),
    portKey: 'runtime',
    defaultPort: DEFAULT_PORTS.runtime,
    host: '127.0.0.1',
    // ★ PRT-251 续 ③ §4：就绪判据是 **stdout 上那一行**，不是对 `/` 的一次请求。
    //
    //   原来这里是 `{ kind:'http', path:'/', expectStatus:200 }`，而它在真机上
    //   **永远不可能通过**：DSH 的 Web 面对任何未认证请求都答同一个最小的 401
    //   （`packages/client/connection/src/browser-auth.ts` 的 `authorizeIndex()`），
    //   而 401 落进 `FATAL_PROBE_CODES` 的 `http-status-mismatch`
    //   ⇒ 不可重试、立刻熔断。反过来更坏：那个端口后面若恰好是**别的**对 `/`
    //   答 200 的服务，这条判据会**通过**——而它后面根本不是 DSH。
    //
    //   DSH 自己给出的、被它明确设计为给 supervisor 用的信号就是这一行
    //   （`packages/bundle/web-app/src/index.ts` 的 `announceReady()`）：
    //
    //     "The URL line and browser handoff are readiness signals:
    //      **supervisors RPC as soon as they observe the line**."
    //
    //   而且它比 HTTP 探测**更强**：那行文字来自**我们 spawn 的那个进程本身**。
    //   team-hub 有 `/api/config` 可做身份断言；DSH 没有等价物，
    //   它的身份恰恰在"这是我儿子说的"这件事上。
    //
    //   ⚠️ 超时从 60s 提到 120s：信号在 Loader 整棵树结算**之后**才打，
    //   不是端口一张开就有。判据变严了，等待窗口也得跟着放宽，
    //   否则「判据对了但 60 秒不够」会表现成一次假超时。
    //
    //   匹配 `dsh web: http://127.0.0.1:3081/?token=…`，只取 URL 那一段
    //   （后面可能还跟着 `(LAN: …)`，而我们要的是回环那个）。
    readiness: Object.freeze({
      kind: 'stdout',
      stream: 'stdout',
      expectMatch: '^dsh web:\\s+(https?://\\S+)',
      portGroup: 1,
      timeoutMs: 120000,
      intervalMs: 250,
      verified: false,
    }),
    writesRoles: Object.freeze(['data', 'cache']),
    // ★ PRT-214 续：Legion 身份由 Launcher **派生 + 从产品配置取**后注入本进程，
    //   组合根（`runtime/dsh-composition/root.mjs`）只从进程环境读它。
    //   加进 `envNames` 不是可选的：`buildChildEnv()` 对未声明的键直接抛，
    //   而"漏声明"会让「进程实际需要的配置」与「清单说它需要的配置」不一致。
    //
    //   · `TEAM_HUB_URL` / `LEGION_CWD` —— **派生值**，与 workbench 的
    //     `DSH_HUB_UPSTREAM` 同一条理由（见 `launcher.mjs` 的 `derivedValuesFor`）；
    //   · `LEGION_ACTOR` / `LEGION_SCOPE` / `LEGION_ENFORCEMENT_ACTION` /
    //     `LEGION_TASK_ID` —— 只能来自产品配置 `runtime.env`，本批次没有别的权威来源；
    //   · `LEGION_APPROVAL_POLICY` / `LEGION_ATTENDED` / `LEGION_PERMISSION_PRESET`
    //     —— session 级的审批口径，可选；缺了由 `decide` 在判定期 fail closed。
    envNames: Object.freeze([
      'DSH_HOME', 'LEGION_DATA_DIR', 'LEGION_LOG_DIR',
      'TEAM_HUB_URL',
      'LEGION_ACTOR', 'LEGION_SCOPE', 'LEGION_ENFORCEMENT_ACTION', 'LEGION_CWD', 'LEGION_TASK_ID',
      'LEGION_APPROVAL_POLICY', 'LEGION_ATTENDED', 'LEGION_PERMISSION_PRESET',
      // ★ PRT-253 续批四（**增量扩展**，见下）：契约服务端的凭证。
      //   本进程是**服务端**：它要拿这份值去比对 worker 出示的那一份。
      //   生成者是 Launcher（`runtime-contract-endpoint.mjs` 的
      //   `generateRuntimeToken`），每次启动一份；Launcher 只把它注入
      //   `runtime` 与 `orchestrator` 两个进程。
      //   端口**不在这里**：监听器绑临时端口（`port: 0`），实际端口由本进程
      //   发布到 DataDir 下（`runtime/dsh-composition/runtime-contract-publication.mjs`），
      //   消费侧读回——所以没有一个"端口环境变量"可声明。
      'LEGION_RUNTIME_TOKEN',
      // ★★★ 2026-09-20（业主裁决「那个文件我可以动」）：四道范围检查的授权表。
      //
      //   这四把键此前**只**登记在 `runtime/config-schema.mjs` 的 `fields` 里
      //   （用户配得进去），四个装配点 `*PortFromEnv()` 在
      //   `runtime/dsh-composition/plugins/root-row.mjs` 里也都接好了 ——
      //   而本数组没有它们 ⇒ `buildChildEnv()` 在 `baseEnv` 那一侧**静默丢掉**
      //   ⇒ 真实部署里那四道范围检查一次都不跑，而两处各自的判据都是绿的。
      //
      //   > 一个"能配、也接好了"的键，与一个"真的能到子进程"的键，
      //   > 在只读配置表的时候是同一个东西。
      //
      //   ⚠️ **`TEAM_HUB_TOKEN` 不在这里，这是刻意的**：执行面拿不到控制面凭证
      //   （§5 第 19 条已裁决"不注入"），且有一条边界不变量逐字守着
      //   （`allowlist.test.mjs` 要求 `runtime` 只持有 `LEGION_RUNTIME_TOKEN`）。
      //   把"5 把键一起通"照字面执行会**打开一扇被明令关上的门**。
      'LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS',
      'LEGION_EXECUTION_SCOPE', 'LEGION_EXTERNAL_API_SCOPE',
      // ★★ 第 112 轮（PRT-603 岗位白名单接线）：第五把键。
      //
      //   它**必须**在这里，而这一条不是"顺手补一个"：`buildChildEnv()` 只转发
      //   本数组里的键，所以一个"在 schema 里声明了、也接进组合根了、
      //   却没进这张清单"的键，**到不了子进程** —— 而两处各自的判据都是绿的。
      //
      //   > 一个「能配、也接好了」的键，与一个「真的能到子进程」的键，
      //   > 在只读配置表的时候是同一个东西。
      //
      //   ★ 这条缺口是被 `scripts/config/config.test.mjs` 那条"schema fields 与
      //     清单 envNames 必须对得上"的判据**当场抓出来的**（它逐字点名
      //     `["LEGION_EMPLOYEE_PERMIT"]`）。所以这里补的不只是一个字符串，
      //     是那道判据要的那一半。
      'LEGION_EMPLOYEE_PERMIT',
    ]),
    milestone: 'PRT-257',
  }),
  Object.freeze({
    key: 'orchestrator',
    label: 'Legion Orchestrator worker（扫单 / 认领 / 派工）',
    kind: 'worker',
    required: true,
    dependsOn: Object.freeze(['team-hub', 'runtime']),
    entry: Object.freeze({ kind: 'node-file', path: 'product/orchestrator/worker.mjs' }),
    cwd: '{install}',
    argsTemplate: Object.freeze([]),
    portKey: null,
    defaultPort: null,
    host: null,
    readiness: Object.freeze({ kind: 'none', verified: false }),
    writesRoles: Object.freeze(['data', 'workspace']),
    // ★ PRT-253 续批四：worker 经**另一个进程**里的契约监听器调用执行引擎
    //   （`orchestrator/worker/executor-binding.mjs` 的
    //   `productionExecutorProviderFromEnv` 读这两个键）。在这之前它们
    //   只登记在 `orchestrator/config-schema.mjs` 里，而白名单只放行
    //   **本清单**声明过的键——于是 Launcher 启动的真实部署里它们会被丢掉，
    //   worker 永远报 `EXECUTOR_HOST_PORT_REQUIRED`。
    //
    //   `LEGION_RUNTIME_URL`：Runtime 进程实际绑定的临时端口派生出来的回环 URL
    //   （读端口发布 → 用**本次那个 pid** 校验；读不到就具名拒绝，不编 URL）。
    //   `LEGION_RUNTIME_TOKEN`：与 runtime 进程同一份、每次启动新生成的凭证。
    envNames: Object.freeze([
      'TEAM_HUB_URL', 'TEAM_HUB_TOKEN', 'LEGION_DATA_DIR',
      'LEGION_RUNTIME_URL', 'LEGION_RUNTIME_TOKEN',
      // ★ PRT-253 续批五：`LEGION_WORKSPACE_DIR` 是 worker **唯一**的项目目录来源。
      //
      // 缺了它，`readWorkerEnv()` 的 `workspaceDir` 是 `null`，
      // `resolveWorkspaceStages()` 返回 `{ stages: null }`，于是 worker 的状态是
      // `no-stages`——**一个任务都不认领**。而它的外部表现只有状态文件里那一个词，
      // 没有任何错误：从产品上看，就是"任务一直没人做"。
      //
      // 这里的情况与上一个 PRT-253 续批**互为反面**，两个形状都要防：
      //   · `LEGION_DATA_DIR` 声明了、但 Launcher 从不给值 ⇒ 起来就退 8（崩溃循环）；
      //   · `LEGION_WORKSPACE_DIR` 连声明都没有 ⇒ `buildChildEnv()` 把宿主环境里
      //     的同名值也**丢掉**，于是它明明配了却传不到子进程。
      //
      //   > 一个"没声明所以被白名单丢掉"的变量，
      //   > 与一个"根本没配"的变量，在子进程里是同一个读数（`undefined`）——
      //   > 只不过前者的部署方会反复确认自己明明配过了。
      'LEGION_WORKSPACE_DIR',
    ]),
    milestone: 'PRT-301',
  }),
  Object.freeze({
    key: 'whiteboard',
    label: '协作白板（可选组件）',
    kind: 'server',
    required: false,
    dependsOn: Object.freeze([]),
    entry: Object.freeze({ kind: 'node-file', path: 'whiteboard/apps/server/src/index.js' }),
    cwd: '{install}',
    argsTemplate: Object.freeze([]),
    portKey: 'whiteboard',
    defaultPort: DEFAULT_PORTS.whiteboard,
    host: '127.0.0.1',
    readiness: Object.freeze({
      kind: 'http',
      path: '/healthz',
      expectStatus: 200,
      // `/healthz` 返回 { ok: true, ... }（whiteboard/apps/server/src/index.js:248）
      expectJson: Object.freeze({ ok: true }),
      timeoutMs: 30000,
      intervalMs: 250,
      verified: false,
    }),
    writesRoles: Object.freeze(['data']),
    // 端口与主机名的环境变量名是**通用名**（PORT / HOST，见 whiteboard config-schema.mjs:29-30）：
    // 这正是必须以白名单注入的理由——通用名在继承全部 env 时极易被外部值覆盖。
    envNames: Object.freeze(['WHITEBOARD_TOKEN', 'PORT', 'HOST', 'DB_PATH', 'WB_ROOMS_DIR', 'WB_AUDIT_DIR', 'WB_IN_MEMORY']),
    milestone: 'PRT-707',
  }),
])

/**
 * 进程键的**确定性排序**：依赖在前，同层按 spec §6.10 的列举顺序。
 *
 * 它同时是启动波内的次级排序键。没有这个键时，`Set` 的迭代顺序随插入路径变化，
 * 「同一份配置两次启动得到不同顺序」会让排障时无法对照日志——顺序本身不是功能，
 * 但顺序的不确定性会让所有对照失效。
 */
export const PROCESS_KEYS = Object.freeze(PROCESS_SPECS.map((s) => s.key))

/**
 * 当前**已知缺口**：声明了但真实入口还不存在 / 还没被解析出来的条目。
 * 这不是「待办列表」，而是「清单现在还不是完整可用的东西」这一事实的机器可读形式。
 *
 * 变化史（每一次都对应一次**门禁变红**，这是它存在的意义）：
 *   - PRT-258 建立时有两项：`ENTRY_MISSING:orchestrator`、`ENTRY_UNRESOLVED:runtime`。
 *   - PRT-301 创建了 `product/orchestrator/worker.mjs`，前一项随之消失。
 *     这就是「缺口补上时用例变红」的设计：不能只改代码不改清单，
 *     否则清单会继续宣称一个已经不存在的缺口，而读者会以为编排进程还没落地。
 */
export const MANIFEST_KNOWN_GAPS = Object.freeze([
  Object.freeze({
    code: 'ENTRY_UNRESOLVED',
    process: 'runtime',
    detail: 'runtime 入口由产品配置 runtime.command 提供（PRT-011 路线 C）；未配置时 Launcher 必须拒绝启动而不是跳过。',
  }),
])

export function specFor(key) {
  return PROCESS_SPECS.find((s) => s.key === key) ?? null
}

/** 把模板里的占位符替换成具体值；未知占位符原样保留（宁可显示 `{x}` 也不要静默吞掉）。 */
function expand(template, vars) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

/**
 * 生成具体进程计划。
 *
 * 纯函数：不 spawn、不读 `process.env`、不访问文件系统。`nodePath` 显式传入
 * （默认 `process.execPath`），因此用例可以对两种平台语义、两种 node 位置做断言。
 */
export function materializeProcessPlan({
  layout,
  ports = {},
  runtimeCommand = null,
  nodePath = process.execPath,
  extraArgs = {},
} = {}) {
  const platform = layout?.platform ?? process.platform
  const api = pathApi(platform)
  const processes = []
  const diagnostics = []

  const vars = {
    install: layout?.installDir ?? '',
    data: layout?.dataDir ?? '',
    workspace: layout?.workspaceDir ?? '',
    cache: layout?.cacheDir ?? '',
    log: layout?.logDir ?? '',
  }

  for (const spec of PROCESS_SPECS) {
    const port = spec.portKey === null ? null : Number(ports[spec.portKey] ?? spec.defaultPort)
    const cwd = expand(spec.cwd, vars)
    const entryPath = spec.entry.kind === 'node-file' ? expand(spec.entry.path, vars) : null
    const args = spec.argsTemplate.map((a) => expand(a, { ...vars, port: port ?? '' }))
    const extras = extraArgs[spec.key] ?? []
    // ★ PRT-251 续：端口的 argv 段**追加在最末尾**——在所有 launcher 旗标
    //   （含 `extras` 里的 `--patch`）之后、且只对声明了 `portArgv` 的进程生效。
    //
    //   位置是这条链的全部要点（见 `PROCESS_SPECS` 里 `portArgv` 那段）：
    //   对 DSH 这种「launcher 段 + app 段」的命令行，端口一旦跑到 `--patch`
    //   前面，`--patch` 就被解析器当成 app 参数，强制面补丁层静默消失。
    //
    //   没有 `portArgv` 或没有端口的进程得到**空数组**——于是它逐字等价于
    //   「本字段不存在」，不需要在下面判第二遍。
    const portArgs = port === null || spec.portArgv === undefined
      ? []
      : [...spec.portArgv, String(port)]
    // `hostArgv` 只在 spec **声明了 host** 时才生效：`null` 是「这个进程不绑地址」，
    // 与「绑到一个叫 null 的地址」是两件事。
    const hostArgs = spec.host === null || spec.host === undefined || spec.hostArgv === undefined
      ? []
      : [...spec.hostArgv, spec.host]
    // 开关旗标没有值：`[...['--no-open']]` 就是它自己。
    const boolArgs = spec.boolArgv === undefined ? [] : [...spec.boolArgv]
    // app 段的顺序：先值旗标（host、port），再开关。DSH 的解析器对这个顺序
    // 不敏感，但**固定一个顺序**才让"完整 argv"这种断言写得出来。
    const appArgs = [...hostArgs, ...portArgs, ...boolArgs]
    let command = null
    if (spec.entry.kind === 'node-file') {
      // 入口按**安装目录**解析成绝对路径：命令里出现相对路径时，实际被执行的是
      // 「相对于 Launcher 的 cwd」那一个文件，而它与清单里写的可能不是同一个。
      const entryAbs = vars.install === ''
        ? entryPath
        : api.resolve(vars.install, String(entryPath).split('/').join(api.sep))
      command = Object.freeze({ file: nodePath, args: Object.freeze([entryAbs, ...args, ...extras, ...appArgs]) })
    } else {
      const configured = expandConfigured(runtimeCommand, vars)
      if (configured === null) {
        diagnostics.push(diag('error', 'ENTRY_UNRESOLVED', spec.key,
          `进程 ${spec.key} 的入口由配置项 ${spec.entry.configKey} 提供，但当前未配置其值。未配置时必须拒绝启动，不能跳过该进程——跳过会让「执行引擎不可用」表现成「任务一直没人做」。`))
      } else {
        /**
         * ★ PRT-251 续：**两处都给了值旗标**时必须具名拒绝，不许靠 argv 顺序决出胜负。
         *
         * `runtime.command` 可以自带 `--port` / `--host`（用户手写的那条命令），
         * 而计划也会按 `ports.runtime` / `host` 补一个。经验上后者赢
         * （commander 取最后一次出现的值），但「实际生效的是哪一个」由此变成
         * 每次排障都要重新确认的问题——而它与 `launcher.mjs:96-98` 拒绝
         * 「端口既走 env 又走 argv」是同一条理由。
         *
         *   > 一个「两处都写了端口、由解析器的取值顺序决定谁生效」的部署，
         *   > 与一个「`ports.runtime` 配了但不起作用」的部署，在**这个端口到底是谁的**
         *   > 这个读数上是同一个东西——只不过前者会让人以为自己改对了地方。
         *
         * 所以这里是 **error（阻塞启动）**，不是 warn：这不是风格问题，是一次
         * 权威冲突，而产品必须知道端口归谁管（spec §6.3：端口是计划的一部分）。
         *
         * ★ 而**开关**旗标（`boolArgv`）走的是另一条规则：用户那条命令里已经有了
         *   ⇒ **跳过**我们那一个，**不报错**。两类不能共用一条规则：
         *
         *     两个**值**来源 ＝ 两个不同的答案 ⇒ 谁生效取决于先后 ⇒ 必须阻塞；
         *     重复一个**开关** ＝ 同一个断言说了两遍 ⇒ 再写一个是噪音，
         *     而报错会**拦住一个本来正确的部署**。
         *
         *   把开关也按值旗标处理，等于因为用户写了一句"不要开浏览器"就拒绝启动。
         */
        const valueFamilies = [
          {
            flags: spec.hostArgv,
            args: hostArgs,
            code: 'HOST_AUTHORITY_CONFLICT',
            // 把**计划会用哪个值**印出来：只说"两处都写了"而不说"我本来要补什么"，
            // 用户没法判断该删哪一处。
            owner: `清单的 host 字段（${spec.host}）`,
            hint: `否则清单写的是 ${spec.host}、而实际 bind 的是命令里那个，`
              + `外部看不出任何差别（宿主探测却仍按清单那个 host 走）。`,
          },
          {
            flags: spec.portArgv,
            args: portArgs,
            code: 'PORT_AUTHORITY_CONFLICT',
            owner: `ports.${spec.portKey}（${port}）`,
            hint: `否则改了 ports.${spec.portKey} 却不生效，而外部看不出任何差别。`,
          },
        ]
        // ★ 冲突时**不追加**：计划里显示的就该是用户那条命令本身，加一个重复的
        //   值旗标只会让「这个值是谁的」在诊断输出里更看不清。诊断已经阻塞启动，
        //   所以这里的 argv 不会被执行——留它原样是让报错与它指向的东西对得上。
        const effectiveValueArgs = []
        for (const family of valueFamilies) {
          const hit = family.flags === undefined
            ? undefined
            : family.flags.find((flag) => configured.args.includes(flag))
          if (hit === undefined) {
            effectiveValueArgs.push(...family.args)
            continue
          }
          diagnostics.push(diag('error', family.code, spec.key,
            `进程 ${spec.key} 的 ${spec.entry.configKey} 里已经带了 ${hit}，而计划也会按 `
            + `${family.owner} 补一个。两处都能决定它时，「实际生效的是哪一个」`
            + `取决于 argv 里谁在后面，而那不是一个能被审计的规则。`
            + `**请在配置里删掉 ${hit}**：${family.owner} 管它，${family.hint}`))
        }
        // 开关：已经有了就跳过（同一个断言说两遍，不是冲突）。
        // 注意用 `boolArgs` 而非去重后的结果参与下面的 argv 拼接——被跳过的
        // 那一个由用户自己那条命令提供，行为完全一致。
        const effectiveBoolArgs = boolArgs.filter((flag) => !configured.args.includes(flag))
        command = Object.freeze({
          file: configured.file,
          args: Object.freeze([...configured.args, ...args, ...extras, ...effectiveValueArgs, ...effectiveBoolArgs]),
        })
      }
    }

    processes.push(Object.freeze({
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      required: spec.required,
      dependsOn: spec.dependsOn,
      entryPath,
      entryKind: spec.entry.kind,
      command,
      cwd,
      port,
      host: spec.host,
      url: port === null ? null : `http://${spec.host ?? '127.0.0.1'}:${port}`,
      readiness: spec.readiness,
      writesRoles: spec.writesRoles,
      envNames: spec.envNames,
      milestone: spec.milestone,
    }))
  }

  const waves = startupWaves(processes)
  return Object.freeze({ processes: Object.freeze(processes), diagnostics: Object.freeze(diagnostics), waves })
}

/** `runtimeCommand` 接受字符串（命令行）或 `{file, args}`。 */
function expandConfigured(value, vars) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parts = splitCommandLine(trimmed)
    if (parts.length === 0) return null
    return { file: expand(parts[0], vars), args: parts.slice(1).map((p) => expand(p, vars)) }
  }
  if (typeof value === 'object' && typeof value.file === 'string' && value.file.trim() !== '') {
    return {
      file: expand(value.file.trim(), vars),
      args: Array.isArray(value.args) ? value.args.map((a) => expand(String(a), vars)) : [],
    }
  }
  return null
}

/**
 * 拆分命令行。刻意只按空白拆分并支持引号，不做 shell 展开：
 * 展开 `$VAR`/`%VAR%` 会让「配置里写的是什么」与「实际启动的是什么」不再一一对应，
 * 而进程清单的全部价值就在于这两者必须一致。
 */
export function splitCommandLine(line) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of String(line)) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (cur !== '') { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * 启动波次：同一波内可并发启动，波与波之间必须等待前一波就绪。
 * 同波内按 `PROCESS_KEYS` 顺序返回，保证结果确定（否则「同一输入两次运行顺序不同」
 * 会让排障时的日志无法对照）。
 */
export function startupWaves(processes) {
  const byKey = new Map(processes.map((p) => [p.key, p]))
  const remaining = new Set(byKey.keys())
  const done = new Set()
  const waves = []
  let guard = 0
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((k) => (byKey.get(k).dependsOn ?? []).every((d) => done.has(d) || !byKey.has(d)))
      .sort((a, b) => PROCESS_KEYS.indexOf(a) - PROCESS_KEYS.indexOf(b))
    if (wave.length === 0) break // 环：交由 validateProcessPlan 报 DEPENDENCY_CYCLE
    for (const k of wave) { remaining.delete(k); done.add(k) }
    waves.push(Object.freeze(wave))
    guard += 1
    if (guard > processes.length + 1) break
  }
  if (remaining.size > 0) waves.push(Object.freeze([...remaining].sort((a, b) => PROCESS_KEYS.indexOf(a) - PROCESS_KEYS.indexOf(b))))
  return Object.freeze(waves)
}

function diag(severity, code, processKey, message) {
  return Object.freeze({ severity, code, process: processKey, message })
}

/**
 * 校验进程计划。必须**在实际启动之前**跑通——启动之后再发现问题，
 * 已经产生了副作用（占端口、写库、半启动状态）。
 *
 * `installRoot` 传 null 时跳过入口存在性校验并如实标记 `ENTRY_NOT_VERIFIED`，
 * 而不是假装通过：没有可比对的基准就应当说「没验证」，这也是 PRT-215 自检
 * 「未生效按 incompatible 处理」的同一条口径。
 */
export function validateProcessPlan(plan, { installRoot = null, platform = null, exists = null } = {}) {
  const processes = plan?.processes ?? []
  const diagnostics = [...(plan?.diagnostics ?? [])]
  const byKey = new Map(processes.map((p) => [p.key, p]))
  const plat = platform ?? process.platform
  const api = pathApi(plat)

  // ① 端口唯一：两个进程配同一个端口会在启动期以「后启动的直接退出」呈现，
  //    而退出的那个往往不是配置错的那个。
  const seenPorts = new Map()
  for (const p of processes) {
    if (p.port === null || p.port === undefined) continue
    if (!Number.isInteger(p.port) || p.port < 0 || p.port > 65535) {
      diagnostics.push(diag('error', 'PORT_OUT_OF_RANGE', p.key, `端口 ${p.port} 不是合法端口（0..65535）`))
      continue
    }
    if (seenPorts.has(p.port)) {
      const other = seenPorts.get(p.port)
      diagnostics.push(diag('error', 'PORT_CONFLICT', p.key, `端口 ${p.port} 已被进程 ${other} 占用：两个进程不得绑定同一端口`))
    } else {
      seenPorts.set(p.port, p.key)
    }
  }

  // ② 依赖可解析、无环。
  for (const p of processes) {
    for (const dep of p.dependsOn ?? []) {
      if (!byKey.has(dep)) {
        diagnostics.push(diag('error', 'UNKNOWN_DEPENDENCY', p.key, `依赖的进程「${dep}」不在清单中：依赖必须可解析，否则启动顺序无从确定`))
      }
    }
  }
  // 环的判据是「依赖与依赖方落在**同一启动波**」——同波意味着两者互等对方就绪。
  // 曾经这里写成 `byKey.has(dep)`（依赖存在即报环），它几乎恒真：
  // 任何有依赖的正常清单都会被判成有环。缺陷之所以没被发现，是因为当时
  // 只有「真有环时必须报错」这一条断言，而没有「无环时不得报错」。
  for (const wave of startupWaves(processes)) {
    for (const key of wave) {
      for (const dep of byKey.get(key)?.dependsOn ?? []) {
        if (wave.includes(dep)) {
          diagnostics.push(diag('error', 'DEPENDENCY_CYCLE', key, `进程 ${key} 与其依赖 ${dep} 落在同一启动波：依赖关系存在环`))
        }
      }
    }
  }

  // ③ 只允许回环监听。
  for (const p of processes) {
    if (p.host === null || p.host === undefined) continue
    if (!LOOPBACK_HOSTS.includes(p.host)) {
      diagnostics.push(diag('error', 'NON_LOOPBACK_BIND', p.key,
        `进程 ${p.key} 绑定 ${p.host}，不是回环地址。默认只允许监听 loopback；远程访问必须显式启用认证与网络配置（spec §10）。`))
    }
  }

  // ④ 入口存在性与「不得写入安装目录」。
  for (const p of processes) {
    if ((p.writesRoles ?? []).includes('install')) {
      diagnostics.push(diag('error', 'WRITES_INSTALL_DIR', p.key, `进程 ${p.key} 声明写入安装目录：安装目录在升级时会被原子替换（spec §9.4）`))
    }
    if (p.entryKind !== 'node-file') continue
    if (installRoot === null || installRoot === undefined) {
      diagnostics.push(diag('warn', 'ENTRY_NOT_VERIFIED', p.key, `未提供安装目录，进程 ${p.key} 的入口存在性未被校验`))
      continue
    }
    const expected = normalizeJoin(api, installRoot, p.entryPath)
    if (typeof exists !== 'function') {
      diagnostics.push(diag('warn', 'ENTRY_NOT_VERIFIED', p.key, `未提供入口探测函数，进程 ${p.key} 的入口 ${expected} 存在性未被校验`))
    } else if (exists(expected) !== true) {
      diagnostics.push(diag(p.required ? 'error' : 'warn', 'ENTRY_MISSING', p.key,
        `进程 ${p.key} 的入口不存在：${expected}（任务 ${p.milestone}）。必需进程入口缺失时必须拒绝启动对应能力，不得静默跳过。`))
    }
  }

  // ⑤ 服务型进程必须有就绪判据；worker 不需要。
  for (const p of processes) {
    const r = p.readiness
    if (p.kind === 'server' && (r === null || r === undefined || r.kind === 'none')) {
      diagnostics.push(diag('error', 'READINESS_MISSING', p.key, `服务型进程 ${p.key} 没有就绪判据：无法区分「已就绪」与「还没起来」`))
    }
  }

  // ⑥ 配置面声明：每个进程消费的 env 必须显式登记（spec §6.11）。
  for (const p of processes) {
    if (!Array.isArray(p.envNames) || p.envNames.length === 0) {
      diagnostics.push(diag('warn', 'ENV_UNDECLARED', p.key, `进程 ${p.key} 未声明任何环境变量。进程清单是启动期注入白名单的唯一来源。`))
    }
  }

  return Object.freeze(diagnostics)
}

function normalizeJoin(api, root, relative) {
  return api.resolve(root, String(relative).split('/').join(api.sep))
}

/** 便捷判定：诊断里是否有 `error`。 */
export function hasBlockingProcessDiagnostic(diagnostics) {
  return diagnostics.some((d) => d.severity === 'error')
}

/**
 * 把「入口在安装目录内」的绝对路径算出来，供 Launcher 做存在性探测。
 * 注意形参名用 `proc` 而不是 `process`——后者会遮蔽全局 `process`，
 * 让 `platform = process.platform` 默认值静默失效（这类缺陷只在非 Windows 上才暴露）。
 */
export function entryAbsolutePath(proc, installRoot, platform = process.platform) {
  if (proc?.entryKind !== 'node-file' || installRoot === null || installRoot === undefined) return null
  const api = pathApi(platform)
  return normalizeJoin(api, installRoot, proc.entryPath)
}

/**
 * 入口路径是否逃出安装目录（配置里写 `../` 或绝对路径时）。
 * 逃出的入口不在产品自己的程序目录内，升级替换不会覆盖它——即「跑的不是这一版程序」。
 */
export function entryEscapesInstall(proc, installRoot, platform = process.platform) {
  const abs = entryAbsolutePath(proc, installRoot, platform)
  if (abs === null) return false
  const root = pathApi(platform).resolve(String(installRoot))
  return !(isPathInside(root, abs, platform) || samePath(root, abs, platform))
}
