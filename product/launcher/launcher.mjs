// product/launcher/launcher.mjs
// ============================================================================
// 最小 Product Launcher（PRT-251）
//
// spec §6.10 把 Launcher 定义为「客户唯一启动入口」，管理 team-hub、Workbench、
// DSH Runtime、Orchestrator worker 与可选 Whiteboard。本文件交付**最小可用形态**：
//
//   校验进程计划 → 探端口 → 按波次拉起 → 等就绪（含身份断言）→ 状态查询 → 优雅停止
//
// ## 三条决定「最小」边界的原则
//
// ① **启动前一次性拦下所有确定性错误。** 端口冲突、入口缺失、依赖成环、
//    非回环绑定都在 spawn 之前判完。启动之后再发现问题，已经产生了副作用
//    （占了端口、写了库、留下半启动状态），而用户看到的是「有些功能时好时坏」。
//
// ② **必需进程失败则整体回滚。** 半启动的产品比不起来的产品更难排查：
//    team-hub 起来了、workbench 没起来，用户看到界面能开但数据是空的。
//    可选进程（白板）失败只记 warn，产品继续可用。
//
// ③ **就绪失败要区分「还早」与「错了」。** `identity-mismatch` 说明端口上监听的
//    不是本次启动的实例（残留旧实例 / 别的程序），再等多久都不会变好 ——
//    此时必须立刻熔断而不是把 60 秒超时等满。判据见 readiness.mjs。
//
// 本文件**不读 `process.env`**：env 由调用方（产品入口）从目录布局与配置层构造后传入，
// 于是「哪些环境变量进了子进程」是显式的（见 allowlist.mjs 的白名单）。
// ============================================================================

import { existsSync } from 'node:fs'

import { hasBlockingDiagnostic, layoutDiagnostics } from '../paths.mjs'
import { entryAbsolutePath, materializeProcessPlan, validateProcessPlan } from '../process-manifest.mjs'
import {
  DSH_OVERLAY_PROCESS_KEY,
  overlayArgsFor,
  resolveDshOverlay,
} from './dsh-overlay.mjs'
import {
  ENFORCEMENT_IDENTITY_PROCESS_KEY,
  resolveEnforcementIdentity,
} from './enforcement-identity.mjs'
import {
  ADOPTION_STATES,
  adoptLegacyData as runLegacyAdoption,
  planAdoption,
} from './legacy-data-adoption.mjs'
import {
  RUNTIME_CONTRACT_ENDPOINT_CODES,
  generateRuntimeToken,
  readRuntimeContractEndpoint,
  runtimeContractDiagnostic,
  runtimeContractEndpointPath,
  waitForRuntimeContractEndpoint,
} from './runtime-contract-endpoint.mjs'
import { buildChildEnv, isSecretLikeKey, OS_ESSENTIAL_ENV } from './allowlist.mjs'
import { checkPorts } from './ports.mjs'
import {
  createLineCollector,
  readinessResultToDiagnostic,
  waitForReadiness,
  waitForStdoutReadiness,
} from './readiness.mjs'
import { createSupervisor, defaultKillTree } from './supervisor.mjs'
import { createLogSink } from '../logging/sink.mjs'
import { createLauncherHeartbeat } from './heartbeat-wiring.mjs'
// PRT-257：装完之后的下一跳。`runtime-command` 缺省不再是"没有"，
// 而是"从现役指针里解析"（判据全在那个模块里，这里只调用）。
import { DEFAULT_DSH_PROFILE, resolveRuntimeForLaunch } from './runtime-resolve.mjs'
// PRT-509 缺口 ①：写侧能力（`openRunCredentials()` 的冻结句柄 +
// `materializeRunCredentials()`）此前**没有任何生产调用方**。接线落在本文件、
// 而不是落在那个模块自己里：只有这里知道"Runtime 子进程会读哪一份
// `.credentials.yaml`"——而"写一份没人读的文件"正是这个缺口本来的形状。
import {
  prepareRuntimeCredentials,
  productRunCredentialOpener,
  runCredentialOverlayArgs,
  runCredentialPaths,
} from './run-credential-materialization.mjs'
// 单实例锁（PRT-708）。**必须早于 `checkPreviousRun()`**——见 `start()` 里那段。
import { SINGLE_INSTANCE_CODES, acquireSingleInstance } from './single-instance.mjs'
import {
  buildRunRecord,
  classifyRecordedPids,
  clearRunRecord,
  createProcessProbe,
  orphanDiagnostics,
  readRunRecord,
  runRecordPath,
  sweepOrphans,
  writeRunRecord,
} from './run-record.mjs'
import * as nodeFs from 'node:fs'

/** 产品级状态 → 用户可见文案（spec §6.3 的「产品状态」列）。 */
export const PRODUCT_STATE_TEXT = Object.freeze({
  starting: '正在启动 Legion',
  ready: 'Legion 已就绪',
  degraded: '部分能力不可用',
  unavailable: 'Legion 未运行',
  incompatible: '组件版本不兼容',
  upgrading: '正在升级',
})

/**
 * 「端口 → 环境变量名」的映射。
 *
 * 只有确实从**环境**读端口的进程才在这里；workbench 的端口走 `--port` argv，
 * 两条路径都能决定同一件事时，「实际生效的是哪一个」会变成每次排障都要重新确认的问题。
 * 每个键都必须在进程清单的 `envNames` 里声明过（否则 `buildChildEnv` 会抛错）。
 */
const PORT_ENV_KEYS = Object.freeze({
  'team-hub': 'TEAM_HUB_PORT',
  whiteboard: 'PORT',
})

/**
 * 「进程 → 数据写路径环境变量」映射（关闭 PRT-003 实测的 4 处越界写入）。
 *
 * 这些键的**代码默认值落在安装目录内**，而安装目录在升级时会被原子替换。
 * Launcher 是唯一知道 DataDir 的地方，因此由它把写路径显式指到 DataDir 下；
 * 进程自己的默认值只在「不经 Launcher 直接手跑」时才会生效。
 * 每个键都必须在进程清单的 `envNames` 里声明过。
 *
 * 导出它是为了让 `scripts/prt/topology-inventory.mjs` 的 `LAUNCHER_OVERRIDES`
 * 与这里**逐字对账**：两份手写的覆盖清单会漂移，而漂移的表现是清单说
 * 「已由 DataDir 承接」而启动路径其实没有。
 */
export const DATA_PATH_ENV = Object.freeze({
  'team-hub': Object.freeze({ TEAM_HUB_DB: 'team-hub/team.db' }),
  whiteboard: Object.freeze({
    DB_PATH: 'whiteboard/whiteboard.db',
    WB_ROOMS_DIR: 'whiteboard/rooms',
    WB_AUDIT_DIR: 'whiteboard/audit',
  }),
})

/**
 * 平台相关的路径拼接（不在 product/ 里用 `node:path` 的默认实现：布局判据必须能跨平台断言）。
 *
 * 相对片段里的**两种分隔符都被规范化**成当前平台的分隔符。混着用（`C:\x\data\team-hub/team.db`）
 * 在 Windows 上能用，但它让「两个路径是不是同一个」退化成字符串比较时永远不等——
 * 而 `product/paths.mjs` 的不变量（写入不得落在安装目录内）正是靠路径比较判定的。
 * 让所有由 Launcher 派生的路径只有一种形态，比在每个比较点都做归一化便宜。
 */
function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((p, i) => {
      const s = String(p).replace(/[\\/]+/g, sep)
      return i === 0 ? s.replace(new RegExp(`${sep}+$`), '') : s.replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    })
    .filter((p) => p !== '')
    .join(sep)
}

/**
 * 展开就绪判据里的期望值占位符。
 *
 * 两种展开方式，区别很重要：
 *   - 整串就是一个占位符（`'{port}'`）→ 返回**原值**（保留 number / boolean 类型）
 *   - 含其他字符（`'{dataDir}/team-hub/team.db'`）→ 拼接成字符串
 *
 * 第一种必须保留类型：`/api/config` 返回的 `port` 是 **number**，
 * 若把期望值一律字符串化成 `"8787"`，严格比较永远不成立，
 * 于是真实运行会被误报成 `identity-mismatch`（「端口上不是我们的服务」）——
 * 一个类型问题伪装成一条安全问题，排查方向会被完全带偏。
 *
 * `null` / `undefined` 一律抛错而不是原样保留：让断言去比对一个字面量 `"{port}"`
 * 等于让它永远不成立，而症状同样是「就绪超时」。
 */
export function expandExpectation(value, vars) {
  if (typeof value !== 'string') return value
  const whole = /^\{([a-zA-Z0-9_]+)\}$/.exec(value)
  if (whole !== null) {
    const v = vars[whole[1]]
    if (v === null || v === undefined) {
      throw new Error(`就绪判据的期望值「${value}」引用了未知上下文变量 {${whole[1]}}：` +
        '这会让身份断言永远不成立，并被误报成「就绪超时」')
    }
    return v
  }
  let missing = null
  const out = value.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => {
    const v = vars[name]
    if (v === null || v === undefined) { missing = name; return m }
    return String(v)
  })
  if (missing !== null) {
    throw new Error(`就绪判据的期望值「${value}」引用了未知上下文变量 {${missing}}：` +
      '这会让身份断言永远不成立，并被误报成「就绪超时」')
  }
  return out
}

/**
 * 创建 Launcher。
 *
 * 所有 I/O 都可注入（`spawnImpl` / `fetchImpl` / `sleep` / `now` / `exists`），
 * 这样「启动前拦下错误」「必需进程失败回滚」「身份不符立刻熔断」这三条判据
 * 都能在不启动真实进程的前提下验证；另有一套用例跑**真实进程**验证接线。
 */
/**
 * 把凭证覆盖层的 `--patch` **按需**追加到运行面进程的命令上（PRT-509 收尾）。
 *
 * ★ 为什么不在建 `plan` 时和强制面覆盖层一起算：
 *   那时还不知道"这一次有没有凭证要落地"——材料化发生在 `start()` 里、
 *   `preflight()` 之后。而**无条件**追加会让每一次启动的 argv 都变，
 *   包括那些**根本没有凭证可写**的部署：指向一份空覆盖层的 `--patch`
 *   会变成所有部署的常态。
 *
 *   > 一个"没东西可写时也把 DSH 指过去"的接线，
 *   > 与一个"只在真的写了东西时才指过去"的接线，
 *   > 在凭证配好的机器上表现完全一样——差别只在没配好的机器上，
 *   > 而那里多出来的那个参数恰好是最难解释的一种：它看起来像生效了。
 *
 * 附带的好处是判据变清楚了：`applied === true` 就意味着"写成功了"，
 * 而 `--patch` 只在那之后出现。
 */
export function withRunCredentialPatch(plan, applied, paths) {
  if (applied !== true) return plan
  const extras = runCredentialOverlayArgs(paths)
  if (extras.length === 0) return plan
  const processes = plan.processes.map((p) => {
    if (p.key !== DSH_OVERLAY_PROCESS_KEY || p.command === null) return p
    return Object.freeze({
      ...p,
      command: Object.freeze({
        file: p.command.file,
        args: Object.freeze([...p.command.args, ...extras]),
      }),
    })
  })
  return Object.freeze({ ...plan, processes: Object.freeze(processes) })
}

export function createLauncher({
  layout,
  ports = {},
  runtimeCommand = null,
  baseEnv = {},
  envValues = {},
  extraEnvAllow = [],
  nodePath = process.execPath,
  installRoot = layout?.installDir ?? null,
  logger = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = globalThis.fetch,
  exists = existsSync,
  spawnImpl = undefined,
  spawnOptions = {},
  /** 日志 sink 用的 fs（可注入）。 */
  logFs: logFsOption = null,
  /**
   * 强制面覆盖层是否装上（PRT-257）。缺省 `true`——见 `config.mjs` 的
   * `runtime.enforcementOverlay` 与 `dsh-overlay.mjs` 的文件头。
   */
  enforcementOverlay = true,
  /** 覆盖层探测用的 fs（可注入）。`null` = 真实 fs。 */
  overlayFs: overlayFsOption = null,
  /**
   * 注入 Runtime 子进程的 Legion 身份（PRT-214 续）。
   *
   * 取自产品配置键 `runtime.env`（既有键，不是本批次发明的）——
   * `actor` / `scope` / `action` / `taskId` **只能**从这里来；
   * hub 地址与 cwd 由 Launcher 派生（见 `enforcement-identity.mjs` 的文件头）。
   */
  runtimeEnv = {},
  /** 日志策略（PRT-709）。缺省用 `DEFAULT_LOG_POLICY`。 */
  logPolicy = {},
  /**
   * 单实例锁的**拿锁实现**（PRT-708）。默认 `acquireSingleInstance`（真实现）。
   *
   * 与 `spawnImpl` / `probe` 同一个手法：判据是"该拦谁、该放谁、该在哪些路径上
   * 释放"，而那件事不需要真的去独占一个文件就能逐条验证。
   *
   * **默认就是真实现**——注入只用于构造"另一个实例正在跑""读不出持有者"
   * 那几条分支，因为它们靠真磁盘是走不顺的（要么得真起两个进程，
   * 要么得手工把锁文件写坏）。
   */
  acquireInstanceLockImpl = acquireSingleInstance,  // ── PRT-713 收尾：健康心跳 ──
  //
  // 默认 `{}` → `enabled` 不是 true → 不装配、不排定时器、不建 transport。
  // **默认关**这件事在两处各判一次（这里与 `wireHeartbeat`），
  // 但两处的判据是同一条：`enabled !== true`。
  heartbeatPolicy = {},
  /** 装配心跳的注入点。默认走 `createLauncherHeartbeat`（真实的 https 通道）。 */
  heartbeatFactory = null,
  /** 心跳配置里的 `consent` 必须是**这台机器上的同意记录**，不是配置项。 */
  heartbeatConsentReader = null,
  /** 心跳定时器可注入（与 `logRotateIntervalMs` 同一个理由：`unref` 要可观测）。 */
  heartbeatSetTimer = undefined,
  heartbeatClearTimer = undefined,
  // ── PRT-705 孤儿进程清理（完整背景见 `run-record.mjs` 的文件头）──
  //
  // `runRecordFs` / `processProbe` / `killTreeImpl` 都可注入：这一层的判据
  // 必须是"**会不会杀错**"，而那个判断不需要真的去杀任何东西就能验证。
  runRecordFs = null,
  processProbe = null,
  killTreeImpl = null,
  // 启动时**只报告不清理**（默认）。清理要显式要求——
  // 杀进程是"不可撤销"的那一类动作，默认值必须是不动手。
  sweepOrphansOnStart = false,
  allowUnverifiedSweep = false,
  /** 轮转间隔。`0` 表示只在与停止时轮转。 */
  logRotateIntervalMs = 5 * 60 * 1000,
  /** 定时器可注入：`unref` 那条防线只有靠它才**可观测**。 */
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  backoff = undefined,
  readiness = {},
  allowPortInUse = [],
  include = null,
  secretsCheck = null,
  // PRT-509 缺口 B1：ACL 的 runner 与 owner。
  //
  // 两者都保持默认 `null`，但**语义变了**：`null` 现在意思是
  // 「调用方没有指定 ⇒ 用生产默认」，而生产默认由 `collectSecretsDiagnostics`
  // 延迟解析（`secrets-acl-runner.mjs`：`spawnSync` runner + `whoami` owner）。
  //
  // 在此之前 `null` 意思是「没有 runner、不知道所有者」——而**没有任何生产
  // 调用方给过值**，于是那两句告警在生产上恒久为真。一个"永远说同一句"
  // 的告警与没有告警是同一件事（用户学会忽略它，于是真的越权那天同样被忽略）。
  //
  // 显式注入仍然优先：用例要验"没有 runner 时会怎样"时传一个非 null 的值
  // 表达它要的场景（传 `undefined` 也会被当成"没指定"，所以**不要**用
  // `undefined` 表达"没有 runner"——用 `resolveSecretsAcl` 的假 runner）。
  secretsRun = null,
  secretsOwner = null,
  requireProtected = true,
  /**
   * DSH `$DSH_HOME/.credentials.yaml` 的路径（PRT-509 路线 A′）。
   *
   * `null` = **不接**只读回退来源（`product/launcher/cli.mjs` 从 `DSH_HOME`
   * 推出路径；`DSH_HOME` 未设或用户用 `--no-dsh-credentials` 关掉时就是 null）。
   * 它只影响自检怎么**描述**回退来源；真正的解析优先级在
   * `runtime/probe/secret-resolver.mjs` 里，只有一处。
   */
  dshCredentialsFile = null,
  // ── PRT-509 缺口 ①：把 Run 的凭证材料化，并让 DSH 真的读它 ─────────────
  //
  // `operatorHome` 是**操作系统**家目录（不是产品家目录）：`~/.dsh` 由它推出，
  // 和 `$DSH_HOME` 一起构成"operator 的真实 home"清单——材料化器**不允许**写进
  // 那两棵树，而它不读 `process.env`（密钥层不得有环境读取点），所以这两个路径
  // 只能由调用方注入。缺了就是具名拒绝，而不是"这条拒绝线不在"。
  operatorHome = null,
  /** 这次运行声明需要哪一份凭证。`null` = 模块的缺省声明（运行时的模型钥匙）。 */
  runCredentialRefs = null,
  /** Legion 引用 → DSH 可寻址名字。`null` = 问 DSH 自己的 `apiKeyEnv` 声明。 */
  runCredentialMapping = null,
  /** 冻结句柄工厂（`({refs, runId}) => Promise<handle>`）。`null` = 生产默认。 */
  runCredentialHandleFactory = null,
  /** 材料化实现（默认 `materializeRunCredentials`）。用例注入假的，以免碰真 IO。 */
  runCredentialMaterialize = null,
  /** `createRequire` 的替代（定位 DSH 的 base bundle 补丁）。 */
  runCredentialRequire = null,
  /** 材料化那一步的文件操作门面（`null` = 真实 `node:fs`）。 */
  runCredentialIo = null,
  /** 密钥库开启器（`openProductSecrets` 的替代）。`null` = 生产默认。 */
  runCredentialSecretsOpener = null,
  // ── PRT-253 续批四：Runtime Contract 的端点与凭证（跨进程那条路的两个坐标）──
  //
  // `runtimeTokenFactory` 可注入：`fail closed` 的判据是"**生成失败时**会怎样"，
  // 而那个处境不需要一个真的坏掉的随机源就能逐条验证。
  // 默认实现用 `node:crypto`（零第三方依赖），**每次启动生成一次**。
  runtimeTokenFactory = generateRuntimeToken,
  /** 等 Runtime 进程发布端口的上限。临时端口是**绑上了才发布**，所以要等。 */
  runtimeContractWaitMs = 5000,
  runtimeContractIntervalMs = 50,
  /** 发布文件的 fs（可注入；`null` = 真实 fs）。与 `logFs` / `overlayFs` 同一做法。 */
  publicationFs = null,
  /**
   * PRT-257 **装完之后的下一跳**：没有显式配置 runtime 命令时，从
   * `<DataDir>/runtime/dsh/current.json` 里解析出装好的那个 DSH 入口。
   *
   * `dshProfile` 是 DSH 的 profile 名（见 `runtime-resolve.mjs` 里的实测：
   * 不带 `--profile` 的入口会以退出码 1 结束）。缺省 `'web'` ——
   * 那是 `dsh-overlay.mjs` 已经写着"`runtime.command` 里的模式"的那一个。
   */
  dshProfile = DEFAULT_DSH_PROFILE,
  /** 解析现役指针用的 fs（可注入；`null` = 真实 fs）。 */
  runtimeResolveFs = null,
} = {}) {
  if (layout === null || typeof layout !== 'object') throw new Error('createLauncher 需要 layout（见 product/paths.mjs）')

  const log = (level, message) => {
    if (typeof logger === 'function') logger({ level, message, at: now() })
  }

  // ── DSH 强制面覆盖层（PRT-257 / PRT-214）─────────────────────────────
  //
  // 在 `materializeProcessPlan` **之前**算，因为它的产物要进 `extraArgs`。
  // 这是补丁层第一次真的被交给一个 DSH 进程——此前那份 YAML 的实际作用范围
  // 是零个部署（详见 `dsh-overlay.mjs` 的文件头）。
  //
  // fs 可注入：判据是"该拦谁、该放谁"，不需要真的读磁盘就能逐条验证。
  const overlay = resolveDshOverlay({
    installDir: layout.installDir ?? null,
    enabled: enforcementOverlay,
    fs: overlayFsOption ?? null,
  })

  // ── PRT-509 缺口 ①：凭证落地位置 + 「把 DSH 指过去」的覆盖层 ─────────────
  //
  // `runCredentialPaths()` 是**纯**的（只算路径）：Legion 自有的
  // `<产品家目录>/runtime-credentials/` 下两份文件——材料化出来的
  // `.credentials.yaml`，以及一个只含**一个路径**（不是密钥）的 DSH 覆盖层。
  //
  // 覆盖层参数在这里（而不是 spawn 时）就算好，是因为 `materializeProcessPlan`
  // 的 `extraArgs` 是**冻结**的。而覆盖层的**内容**在 `start()` 里才决定：
  // 那时才知道 Legion 有没有凭证可写。文件在 spawn 之前一定写出来——
  // 内容是"那一行"或 `[]`（合法的空操作），于是"没东西可写"与"接线之前"
  // 在行为上逐字相同。
  const runCredentialPathReading = runCredentialPaths(layout)

  // ── PRT-257：装好的运行时**真的被用上**（`runtime-resolve.mjs`）────────
  //
  // 在 `materializeProcessPlan` **之前**算，因为它的产物要当 `runtimeCommand`。
  // 在此之前，`runtime.command` 只能来自命令行或产品配置——安装器写下的
  // `current.json` 从来没有任何生产代码读过，"我装好了"与"我跑的是它"
  // 是两件事（详见 `runtime-resolve.mjs` 的文件头）。
  //
  // ★ 策略（配置赢 / 指针兜底 / 坏了就拦）全部落在 `resolveRuntimeForLaunch()`
  //   里，而不是写在这一段。理由与 `resolveDshOverlay` 一样：**判据要能被
  //   逐条断言**，而那件事不需要起一个 Launcher 就能验证。
  const runtimeResolution = resolveRuntimeForLaunch({
    runtimeCommand,
    dataDir: layout.dataDir ?? null,
    profile: dshProfile,
    fs: runtimeResolveFs ?? null,
    platform: layout.platform ?? process.platform,
  })

  const plan = materializeProcessPlan({
    layout, ports, runtimeCommand: runtimeResolution.command, nodePath,
    // `extraArgs` 的语义是"追加在 `runtime.command` 之后"。
    // `enabled === false` 时 `overlay.args` 是空数组，这里就等价于没接这一层——
    // 而那件事由 `overlay.diagnostics` 里那条 warn 记着。
    extraArgs: { [DSH_OVERLAY_PROCESS_KEY]: overlayArgsFor(overlay) },
  })

  /**
   * 生产默认的冻结句柄工厂（PRT-509 缺口 ①）。
   *
   * 实现搬到了 `run-credential-materialization.mjs`（`productRunCredentialOpener`）：
   * 留在本文件的闭包里，那条**只有生产才跑**的分支就没法被单测覆盖——而"只有
   * 生产才跑的分支"正是缺陷最容易藏身的位置（本文件要修的缺口 ① 就是这一类）。
   * 这里只做一件事：把本层的布局与回退来源绑上去。
   */
  function defaultRunCredentialHandle(args) {
    return productRunCredentialOpener({
      layout,
      requireProtected,
      dshCredentialsFile,
      openSecrets: runCredentialSecretsOpener,
    })(args)
  }

  /**
   * 受限范围（`include`）。
   *
   * 阶段性里程碑与用例需要只拉起一部分进程（例如现阶段 runtime 与 orchestrator
   * 的真实入口尚不存在）。**受限范围必须显式给出、必须被记录、且不得被报成 `ready`**：
   * 一个「看起来就绪」的半成品产品比一个起不来的产品更难排查。
   */
  const scopeKeys = include === null ? null : [...include]
  const included = scopeKeys === null ? plan.processes : plan.processes.filter((p) => scopeKeys.includes(p.key))
  const excluded = scopeKeys === null ? [] : plan.processes.filter((p) => !scopeKeys.includes(p.key))
  const scopePartial = scopeKeys !== null && excluded.length > 0
  const includedKeys = new Set(included.map((p) => p.key))

  // ── PRT-253 续批四：Runtime Contract 的**端点**与**凭证** ─────────────
  //
  // worker（orchestrator 进程）读两个键：`LEGION_RUNTIME_URL` 与
  // `LEGION_RUNTIME_TOKEN`。在本批之前**没有任何生产方写它们**——
  // 白名单只放行清单声明过的键，所以真实部署里它们会被丢掉，
  // worker 永远报 `EXECUTOR_HOST_PORT_REQUIRED`。
  //
  // 两样东西的来源刻意不同，因为它们**只有一处**说得清：
  //
  //   · **端口**：谁都不知道临时端口会分到几号，只有**真的绑上了**的那个进程知道。
  //     所以由它发布到 DataDir 下，这里读回并校验（pid 必须是本次那个子进程）。
  //     读不到 → 具名拒绝，**不编 URL**。理由与替代方案见
  //     `runtime/dsh-composition/runtime-contract-publication.mjs` 的文件头。
  //   · **凭证**：由本进程**每次启动生成一次**，只注入 runtime 与 orchestrator。
  //     它是 Launcher 独占的能力：`buildChildEnv` 的白名单注入是唯一能保证
  //     "别的进程拿不到"的地方。生成失败 → **不注入**（fail closed），
  //     对端以 `RUNTIME_CONTRACT_NO_TOKEN` 拒绝，而不是"关掉鉴权"。
  const publicationFsImpl = publicationFs ?? null
  const runtimeContractDiagnostics = []
  let runtimeTokenResolved = null
  let runtimeContractEndpoint = null

  // ── PRT-251 续 ④：旧数据接管（安装目录 → DataDir）──────────────────────
  //
  // `adoptionReading` 是**记忆化**的读数（一次生命周期只做一次接管）；
  // `adoptionDiagnostics` 是它的诊断面。两者分开是因为前者要说"接成没接成"，
  // 后者要说"为什么"——把它们合成一个，`allDiagnostics()` 就得反过来解析读数。
  let adoptionReading = null
  const adoptionDiagnostics = []

  /**
   * ★ PRT-251 续 ③ §4：子进程输出的**行缓冲**，供 `kind: 'stdout'` 的就绪判据读取。
   *
   * 它由 `onOutput` 喂（那段代码本来就无条件排空 stdout/stderr，见
   * `supervisor.mjs` 里那段「不接管道会卡住子进程」的说明），
   * 所以这里**不新增任何管道处理**，只是把已经流过的字节多留一份有界的副本。
   */
  const outputLines = createLineCollector()

  /**
   * 运行时凭证（**每次 createLauncher 一份**，即每次启动一份）。
   *
   * 惰性求值 + 记忆化：`envSurface()`（诊断用）与 `envFor()`（真的 spawn）
   * 都会问它，两次必须是**同一个**值——两次生成会让两个进程拿着两份不同的
   * 凭证，而那表现为"鉴权失败"，看起来像配错了凭证。
   */
  function runtimeToken() {
    if (runtimeTokenResolved !== null) return runtimeTokenResolved
    let raw = null
    try {
      raw = runtimeTokenFactory()
    } catch (e) {
      raw = {
        ok: false,
        code: RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED,
        message: `生成运行时凭证时抛了（${e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
        reasons: [],
      }
    }
    const usable = raw !== null && typeof raw === 'object' && raw.ok === true
      && typeof raw.token === 'string' && raw.token.trim() !== ''
    runtimeTokenResolved = usable
      ? Object.freeze({ ok: true, code: null, message: null, reasons: Object.freeze([]), token: raw.token })
      : Object.freeze({
        ok: false,
        code: raw?.code ?? RUNTIME_CONTRACT_ENDPOINT_CODES.TOKEN_GENERATION_FAILED,
        message: raw?.message ?? '生成运行时凭证失败：工厂返回了不可用的值。**不注入空串、不注入默认值**',
        reasons: Object.freeze([...(raw?.reasons ?? [])]),
      })
    if (runtimeTokenResolved.ok !== true) {
      runtimeContractDiagnostics.push(runtimeContractDiagnostic(runtimeTokenResolved))
    }
    return runtimeTokenResolved
  }

  /**
   * 清掉**上一次运行**可能留下的端口发布。
   *
   * 时机是"spawn Runtime 之前"，因为那条顺序给出了这条保证：
   * **清完之后再出现的发布，只可能来自本次那个进程。**
   * 于是 pid 判定之外又多了一层——上一次崩溃留下的文件不会活到本次启动。
   * 清理失败只记 `warn`：读回来时还会比对 pid，陈旧发布仍然不会被采用。
   */
  function clearStalePublication() {
    const path = runtimeContractEndpointPath(layout.dataDir, layout.platform)
    if (path === null) return
    const fsImpl = publicationFsImpl ?? nodeFs
    try {
      fsImpl.rmSync(path, { force: true })
    } catch (e) {
      if (e?.code === 'ENOENT') return
      runtimeContractDiagnostics.push(Object.freeze({
        severity: 'warn',
        code: RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_CLEAR_FAILED,
        process: DSH_OVERLAY_PROCESS_KEY,
        message: `清理上一次的端口发布失败（${e?.code ?? e?.name ?? 'Error'}）：${e?.message ?? String(e)}`,
        reasons: Object.freeze(['陈旧发布不会被误当成本次的：读回来时还会比对 pid']),
      }))
    }
  }

  /**
   * 读出本次 Runtime 进程发布的端点。**在 spawn orchestrator 之前**调用。
   *
   * 读不到时返回 `{ok:false, code}` 并记一条**具名**诊断——于是
   * "worker 拿不到引擎"这件事有两条互相印证的读数：Launcher 说"发布缺了/是旧的"，
   * worker 说 `EXECUTOR_HOST_PORT_REQUIRED`。两条都不是编出来的。
   */
  async function resolveRuntimeContractEndpoint(failures) {
    if (!includedKeys.has(DSH_OVERLAY_PROCESS_KEY)) {
      const r = Object.freeze({
        ok: false,
        code: RUNTIME_CONTRACT_ENDPOINT_CODES.PUBLICATION_ABSENT,
        message: '本次启动范围不含 runtime 进程：没有任何东西会发布契约端口。**不编一个 URL**',
        reasons: Object.freeze([
          '要么把 runtime 纳入范围，要么不要拉起 orchestrator——它拿不到引擎会一直报 HOST_PORT_REQUIRED',
        ]),
      })
      // ★ 严重级是 `warn`，不是 `error`：这一次**刻意的**受限启动
      //   （`--include` 里没有 runtime）已经有一条 `PROCESS_EXCLUDED_BY_SCOPE`
      //   在说同一件根因，而这条诊断**不参与**那段作用域降级（它跑在启动计划那一步，
      //   本条是启动过程中产生的）。两条叠在一起会读成"两个问题"，且这条 error
      //   并不阻塞启动——一个不阻塞的 error 只会训练人忽略 error。
      //
      //   码本身不变：它是准确的（确实没人发布），`derivedValuesFor` 也依赖
      //   `ok !== true` 才不注入 URL。
      runtimeContractDiagnostics.push(runtimeContractDiagnostic(r, { severity: 'warn' }))
      return r
    }
    const handle = supervisor === null ? null : supervisor.handles.get(DSH_OVERLAY_PROCESS_KEY)
    const pid = handle === null || typeof handle.status !== 'function' ? null : handle.status().pid
    const runtimeFailed = failures.some((f) => f.process === DSH_OVERLAY_PROCESS_KEY)
    if (runtimeFailed || typeof pid !== 'number') {
      // runtime 没起来 / 没有 pid：`readinessDiagnostics` 里已经有一条**具名码**
      // 在说这件事，而这条路上 `failures` 非空 → 整体回滚，orchestrator 不会被拉起。
      // 这里**不**再合成一条"发布缺失"——把"进程没起来"与"进程起来了但没发布"
      // 说成同一句话，会让下一次排查从错的地方开始。
      return null
    }
    const r = await waitForRuntimeContractEndpoint({
      dataDir: layout.dataDir,
      expectedPid: pid,
      timeoutMs: runtimeContractWaitMs,
      intervalMs: runtimeContractIntervalMs,
      fs: publicationFsImpl,
      platform: layout.platform,
      now,
      sleep,
    })
    if (r.ok !== true) runtimeContractDiagnostics.push(runtimeContractDiagnostic(r))
    return r
  }

  const teamHubPort = plan.processes.find((p) => p.key === 'team-hub')?.port ?? null

  // ── Legion 身份（PRT-214 续）─────────────────────────────────────────
  //
  // 组合根（`runtime/dsh-composition/root.mjs`）要求六项输入，而它只从进程环境读。
  // 本进程是**唯一**知道 hub 端口与 Runtime 工作目录的地方，所以这里是那条线的
  // 起点：派生出这两项，其余从产品配置 `runtime.env` 取，缺了就拦启动。
  //
  // 与覆盖层同一条纪律：诊断带 `process: 'runtime'`，于是 `--include` 不含 runtime
  // 的受限启动会把这条 error 降级成 warn——一次本来就不拉 runtime 的启动，
  // 不该因为"强制面没装上"而起不来。
  //
  // `cwd` 取的是 **Runtime 进程计划里的那个值**（`supervisor.mjs` 用它当 spawn 的
  // `cwd`），不是 Launcher 自己的目录：工具调用投影出来的路径按这个 cwd 展开。
  const runtimeProc = plan.processes.find((p) => p.key === ENFORCEMENT_IDENTITY_PROCESS_KEY) ?? null
  const enforcementIdentity = resolveEnforcementIdentity({
    enabled: enforcementOverlay,
    teamHubPort,
    cwd: runtimeProc?.cwd ?? null,
    configured: runtimeEnv,
  })

  const rawPlanDiagnostics = [
    ...layoutDiagnostics(layout),
    // 强制面覆盖层（PRT-257）。它带 `process: 'runtime'`，于是**自动**参与下面
    // 那段"被范围排除的进程降级为 warn"的处理：`--include` 不拉 runtime 时，
    // "没装上强制面"不该阻塞一次本来就不启动 runtime 的启动。
    // 这一条是白拿的，但前提是诊断里带对了 process。
    ...overlay.diagnostics,
    // 装好的运行时（PRT-257）。三条读数各说各的事：
    // "磁盘上那份没被用上"（warn）/ "磁盘上那份坏了但这次不靠它"（warn）/
    // "磁盘上那份坏了、而这次正要靠它"（error，拦启动）。
    // 与覆盖层同一条纪律：带 `process: 'runtime'`，于是受限范围下自动降级。
    ...runtimeResolution.diagnostics,
    // 身份的完整性（PRT-214 续）。关掉覆盖层时它**刻意**什么都不说（见模块文件头）。
    ...enforcementIdentity.diagnostics,
    // `validateProcessPlan` 已经并入 `plan.diagnostics`，此处**不再**重复拼接：
    // 重复的同一诊断会让「同一问题出现两次」看起来像两个问题，
    // 而诊断列表是要直接展示给用户的。
    ...validateProcessPlan(plan, { installRoot, platform: layout.platform, exists }),
  ]
  // 默认用真实 fs。刻意**不**在参数默认值里 `import`（那会让模块顶层带上 IO），
  // 与 `secretsCheck` / `spawnImpl` 的可注入做法一致。
  const logFs = logFsOption ?? nodeFs

  const planDiagnostics = Object.freeze([
    // 被范围排除的进程，其「入口不存在」类诊断降级为 warn 并换码——
    // 它不再是本次启动的阻塞项，但**仍然要被看见**：
    // 静默丢掉它会让受限启动看起来像「一切都好」。
    ...rawPlanDiagnostics
      .filter((d) => d.process === undefined || includedKeys.has(d.process))
      .map((d) => d),
    ...rawPlanDiagnostics
      .filter((d) => d.process !== undefined && !includedKeys.has(d.process))
      .map((d) => Object.freeze({
        severity: 'warn',
        code: 'PROCESS_EXCLUDED_BY_SCOPE',
        process: d.process,
        message: `进程 ${d.process} 不在本次启动范围内（原因：${d.code}）。受限范围内的产品状态不会被报成「已就绪」。`,
        excludedCode: d.code,
      })),
  ])

  let supervisor = null
  let startedAt = null
  let stoppedAt = null
  let portDiagnostics = []
  let secretsDiagnostics = []
  /**
   * 单实例锁（PRT-708）。
   *
   * `null` = 本次运行**没有**拿到锁（启动被拒、或还没启动过）。
   * 它是这一层唯一"拦住启动"的东西之一，所以它既要能被观测
   * （`launcher.instanceLock`），也要在**每一条**退出路径上被释放。
   */
  let instanceLock = null
  let instanceLockReading = null
  /** 日志 sink（PRT-709）。`null` 表示建不起来——**不阻止启动**。 */
  let logSink = null
  const logSinkDiagnostics = []
  /**
   * 健康心跳（PRT-713 收尾）。`null` = 没装配（默认），
   * 或装配失败（那时 `heartbeatCode` 说明为什么）。
   *
   * ★ 与 `logSink` 同一条纪律：**心跳的任何失败都不阻止启动**。
   *   它是附加能力，坏了不该让产品起不来——但也不该静默，
   *   所以每一种失败都进 `heartbeatDiagnostics`。
   */
  let heartbeatHandle = null
  let heartbeatDiagnostics = []
  // PRT-705：上一次运行残留、记录读写失败、清理结果都汇到这里。
  const orphanDiagnosticsOut = []
  let runId = null
  // PRT-509 缺口 ①：凭证材料化那一步的读数与诊断。
  //
  // `null` = **还没走到那一步**（启动在更早的阶段失败）。与"走了、但这次没有
  // 东西可材料化"（`applied: false` + `NO_REFS_DECLARED`）是**两个不同的读数**：
  // 前者是"没问过"，后者是"问过了、答案是空操作"。把两者说成同一句话，
  // 会让"接线根本没跑到"看起来像"这次不需要凭证"。
  let runCredentialReading = null
  let runCredentialDiagnostics = []
  let logRotationTimer = null
  let lastRotation = null
  // PRT-705：上一次运行的残留判成了什么样（`null` = 还没查过）。
  let orphanReport = null
  let sweepResult = null
  const orphanFs = runRecordFs ?? nodeFs

  /**
   * 跑密钥库自检。
   *
   * `secretsCheck` 可注入是为了让"什么该阻止启动"这条分界能在**不碰真实 DPAPI**
   * 的前提下逐条验证（本机是 Windows，但 CI 也要能跑）。
   * 不注入时用真实实现（`product/launcher/secrets-check.mjs` 的 `runSecretsCheck`）。
   *
   * 这里**先查布局**：布局不合法（密钥库在 DataDir/InstallDir/CacheDir 内）是
   * 结构性问题，连"打开"都不该发生——但它的诊断由自检给出，不在这里另判一次
   * （同一件事有两个判定点就会有两个口径）。
   */
  async function collectSecretsDiagnostics() {
    try {
      if (typeof secretsCheck === 'function') {
        const r = await secretsCheck({ layout, platform: layout.platform })
        if (Array.isArray(r)) return r
        if (r !== null && typeof r === 'object' && Array.isArray(r.diagnostics)) return r.diagnostics
        return []
      }
      if (secretsCheck !== null && typeof secretsCheck === 'object' && Array.isArray(secretsCheck.diagnostics)) {
        return secretsCheck.diagnostics
      }
      const { runSecretsCheck } = await import('./secrets-check.mjs')
      // ── PRT-509 缺口 B1：真 runner 与真 owner ────────────────────────────
      //
      // 上面两个入参（`secretsRun` / `secretsOwner`）在这之前**恒为 `null`**：
      // 全仓只有"声明"与"传参"两处引用，没有任何生产调用方给过值。
      // 于是 `inspectFileAcl` 每次都走 `ACL_NO_RUNNER` 分支、
      // `hardenFileAcl` 每次都报"不知道文件所有者"——两条都不拦启动，
      // 于是它们变成诊断里**永远出现、永远说同一句**的告警。
      //
      // 这里补上"没注入就用生产默认"的那一步。三条纪律：
      //
      //   ① **只有两者都是 `null` 时才解析**。任一被显式注入（用例）就原样用，
      //      于是"注入假 runner"这件事不会与"又一次真 whoami"混在一起。
      //   ② 解析**失败不抛**：`resolveSecretsAcl` 内部把失败折成
      //      `owner: null` / 一个连命令都跑不起来的 runner，结果仍然是
      //      既有的具名告警（`ACL_NO_RUNNER` / `HARDEN_FAILED`）。
      //      一个体检程序崩溃不该让产品起不来——这条上面的 catch 已经在守，
      //      这里再守一次是因为**这是新增的一次外部进程调用**。
      //   ③ 延迟到**这里**而不是 `launcherOptionsFrom`：那个函数是同步的，
      //      而 `whoami` 必须等一次进程返回。放在这里也顺带保证了
      //      "只在真的走到密钥库自检时才 spawn"。
      let effectiveRun = secretsRun
      let effectiveOwner = secretsOwner
      let aclResolution = null
      if (effectiveRun === null && effectiveOwner === null) {
        try {
          const { resolveSecretsAcl } = await import('./secrets-acl-runner.mjs')
          aclResolution = await resolveSecretsAcl({ platform: layout.platform })
          effectiveRun = aclResolution.run
          effectiveOwner = aclResolution.owner
        } catch (e) {
          aclResolution = {
            owner: null, ownerSource: 'resolve-failed',
            ownerReason: `解析 ACL runner/owner 失败：${e?.name ?? 'Error'}`,
          }
        }
      }
      const r = await runSecretsCheck({
        layout,
        platform: layout.platform,
        run: effectiveRun,
        owner: effectiveOwner,
        requireProtected,
        // PRT-509 路线 A′：把**只读**回退来源的位置一起交给自检，
        // 这样"DSH 的凭证文件在不在、读不读得懂"会出现在启动诊断里，
        // 而不是只在某一次解析失败时才被发现。
        dshCredentialsFile,
      })
      // ★ owner **没问出来**这件事必须自己占一行。
      //
      //   否则读数会是"ACL 检查：HARDEN_FAILED（不知道文件所有者）"——
      //   那句话说得没错，但它把两件完全不同的事说成了同一件：
      //     · "这台机器上问不出当前用户"（环境问题，修法是查 PATH / 权限）
      //     · "问出来了，但加固真的失败了"（权限问题，修法是看 icacls 输出）
      //   分开之后，读诊断的人才知道该去看哪里。
      const extra = []
      if (aclResolution !== null && effectiveOwner === null && aclResolution.ownerReason !== null) {
        extra.push({
          severity: 'warn',
          code: 'SECRETS_ACL_OWNER_UNRESOLVED',
          message: `问不出当前用户身份，密钥库 ACL 无法收紧到"仅所有者"（**未加固**）：${aclResolution.ownerReason}`,
        })
      }
      return extra.length === 0 ? r.diagnostics : [...extra, ...r.diagnostics]
    } catch (err) {
      // 自检自身出错只降级为一条 warn：**一个体检程序崩溃不该让产品起不来**，
      // 但它必须被看见（不能静默）。
      return [{
        severity: 'warn',
        code: 'SECRETS_CHECK_FAILED',
        message: `密钥库自检未完成：${err?.name ?? 'Error'}（**未验证**，不等于通过）`,
      }]
    }
  }
  let readinessDiagnostics = []

  /**
   * 跨进程接线：**派生**值。
   *
   * 这些值不是「配置」，而是「本进程需要知道另一个进程在哪」——
   * 让每个进程各自按默认值猜（workbench 的 `DSH_HUB_UPSTREAM` 默认是 8787），
   * 会在端口被改成非默认值时静默指向**别的** hub。
   *
   * 这条缺陷是实测出来的，不是推演的：把 team-hub 起在临时端口上之后，
   * workbench 的就绪探测报出 `port: 期望 51814，实际 8787` ——
   * 也就是说 workbench 去代理了默认端口上的另一个 hub 实例。
   * 没有身份断言的话，它会报「就绪」，而用户看到的界面数据来自别的数据库。
   */
  function derivedValuesFor(proc) {
    const out = {}
    if (proc.key === 'team-hub') {
      out.TEAM_HUB_HOST = proc.host
    }
    if (proc.key === 'workbench' && teamHubPort !== null) {
      out.DSH_HUB_UPSTREAM = `http://127.0.0.1:${teamHubPort}`
    }
    // Legion 身份（PRT-214 续）。**只有 Runtime 子进程**拿到它们：
    // 它们是"这个运行时以谁的名义、在哪个空间、干什么"的声明，
    // 别的进程（hub / workbench / 白板）不需要，也就拿不到。
    //
    // 身份不全时 `enforcementIdentity.values` 里缺的那几项**不在**——
    // 这里不补空串、不补默认值：一个空 actor 会在审计里变成一个谁也不是的名字。
    // 那种部署已经在 preflight 被拦下，走不到这里。
    if (proc.key === ENFORCEMENT_IDENTITY_PROCESS_KEY) {
      Object.assign(out, enforcementIdentity.values)
    }
    // ── PRT-253 续批四：Runtime Contract 的两个坐标 ─────────────────────
    //
    // ★ **只有这两个进程**拿到它们（清单里也只有这两个声明了这两个键）：
    //   · runtime      —— 它是服务端：凭证要它来比对，DataDir 要它来发布。
    //   · orchestrator —— 它是消费端：端点 + 同一份凭证。
    //   hub / workbench / 白板**拿不到**：它们的 `envNames` 里没有这两个键，
    //   `buildChildEnv()` 因此连 baseEnv 里的同名值都不会放行。
    //   这就是 spec §6.7「密钥只注入需要它的执行进程」在实现层的落点。
    //
    //   ⚠️ 第 118 轮一度给 hub 加过 `LEGION_DATA_DIR`，理由是"收账要住在持有 db 的
    //   进程里"。那**恰好就是第 28 条的选项乙**（收账侧住在 hub 里），而那条**还没裁**
    //   （`docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7 三条路，业主未选）。
    //   ⇒ 撤回：一个未裁决的选项不该由一篇 diff 悄悄选定。
    //
    // ★ 凭证**不进 argv**、不进日志、不进运行记录、不进状态文件。
    //   它唯一的去处是这两个子进程的环境块（`envSurface()` 对外是 `<redacted>`）。
    if (proc.key === DSH_OVERLAY_PROCESS_KEY) {
      if (typeof layout.dataDir === 'string' && layout.dataDir !== '') {
        // 发布落在 DataDir 下：Runtime 进程是唯一知道"实际绑在几号端口"的那一侧，
        // 而它需要知道写到哪里。DataDir 只有 Launcher 知道（同 DATA_PATH_ENV 的理由）。
        out.LEGION_DATA_DIR = layout.dataDir
      }
      const token = runtimeToken()
      if (token.ok === true) out.LEGION_RUNTIME_TOKEN = token.token
    }
    if (proc.key === 'orchestrator') {
      if (typeof layout.dataDir === 'string' && layout.dataDir !== '') {
        out.LEGION_DATA_DIR = layout.dataDir
      }
      // ── PRT-253 续批五：项目目录 ────────────────────────────────────────
      //
      // ★ 与上面那行**同一个形状**，理由也一样：Launcher 是唯一知道
      //   `layout.workspaceDir` 的地方（它来自 `--workspace`，见 `cli.mjs` 的
      //   `resolveLayout`），所以由它显式写进去，而不是指望宿主环境里恰好有。
      //
      // 缺了它，worker 的 `workspaceDir` 是 `null` ⇒ `resolveWorkspaceStages()`
      // 给 `{ stages: null }` ⇒ 状态 `no-stages` ⇒ **一个任务都不认领**，
      // 而外部只看得见状态文件里那一个词（没有任何错误）。
      //
      // 这也是 `workdir` 那个字段在**原地执行**模式下的权威来源
      // （有隔离时用的是按 Attempt 分配的 worktree 槽位，见 `run-inputs.mjs`）。
      //
      // **绝不回落成 `{install}` 或 cwd**：把项目目录猜成安装目录，
      // 等于让执行去改一个升级时会整体替换的目录。
      if (typeof layout.workspaceDir === 'string' && layout.workspaceDir !== '') {
        out.LEGION_WORKSPACE_DIR = layout.workspaceDir
      }
      // 端点**只有解析成功时才写**。没解析出来时这里什么都不放，
      // 于是 worker 的读数是 `EXECUTOR_HOST_PORT_REQUIRED`（"没配引擎"），
      // 而缺口的具名理由在 `runtimeContractDiagnostics` 里。
      // **绝不回落成 http://127.0.0.1:<默认端口>**：那会让"不知道"变成"知道"。
      if (runtimeContractEndpoint !== null && runtimeContractEndpoint.ok === true) {
        out.LEGION_RUNTIME_URL = runtimeContractEndpoint.url
      }
      const token = runtimeToken()
      if (token.ok === true) out.LEGION_RUNTIME_TOKEN = token.token
    }
    return out
  }

  /** 组装某进程的启动环境（白名单，不继承全部 env）。 */
  function envFor(proc) {
    const values = { ...envValues, ...derivedValuesFor(proc) }
    const portKey = PORT_ENV_KEYS[proc.key]
    if (portKey !== undefined && proc.port !== null && values[portKey] === undefined) {
      values[portKey] = String(proc.port)
    }
    // 写路径由**冻结的目录布局**决定，不由各进程自己的默认值决定。
    // PRT-003 实测到 4 个 path 字段的默认值落在安装目录内（升级时被替换）：
    // `TEAM_HUB_DB=team-hub/team.db`、whiteboard 的 `DB_PATH`/`WB_ROOMS_DIR`/`WB_AUDIT_DIR`。
    // Launcher 是唯一知道 DataDir 的地方，因此这里就是关闭那条差距的位置。
    const dataPaths = DATA_PATH_ENV[proc.key]
    if (dataPaths !== undefined) {
      for (const [key, relative] of Object.entries(dataPaths)) {
        if (values[key] !== undefined) continue
        if (layout.dataDir === null || layout.dataDir === undefined) continue
        values[key] = joinPath(layout.platform, layout.dataDir, relative)
      }
    }
    return buildChildEnv({ spec: proc, baseEnv, values, extraAllowed: extraEnvAllow })
  }

  /**
   * 等一个进程就绪。作为普通函数（不是对象上的私有方法）：对象字面量里
   * 不支持 `#private` 方法，而把它写成公开方法又会让「外部也能调」变成事实。
   */
  async function awaitReadiness(proc, handle) {
    const r = proc.readiness ?? { kind: 'none' }

    // ★ PRT-251 续 ③ §4：`stdout` 判据。**必须排在下面那条早退之前**——
    //   那条的判据是 `r.kind !== 'http'`，任何非 http 的判据都会被它当成
    //   "没有就绪判据"而**立刻 markReady()**。于是"判据没实现"与"判据通过了"
    //   是同一个读数，而 `kind:'stdout'` 会在一个字都没检查的情况下报就绪。
    if (r.kind === 'stdout') {
      const stream = r.stream ?? 'stdout'
      const result = await waitForStdoutReadiness(
        { stream, expectMatch: r.expectMatch, portGroup: r.portGroup ?? 1 },
        {
          timeoutMs: r.timeoutMs ?? readiness.timeoutMs ?? 30000,
          intervalMs: r.intervalMs ?? readiness.intervalMs ?? 250,
          sleep,
          now,
          isProcessAlive: () => handle.isAlive(),
          // ★ 取数函数而不是数组：每轮重新取，否则循环永远看着第一份快照。
          lines: () => outputLines.linesFor(proc.key, stream),
          // ★ 端到端那一条：子进程报告的端口必须是**计划里那个**——
          //   它是「`--port` 真的到达了它」的机器判据。
          plannedPort: proc.port ?? null,
        },
      )
      if (result.ok === true) {
        handle.markReady()
      } else {
        handle.markUnready({
          fatal: result.retryable !== true && result.code !== 'readiness-timeout',
          detail: result.detail ?? result.last?.detail ?? null,
        })
      }
      return {
        result,
        readiness: {
          kind: 'stdout',
          // 没有 URL：`readinessResultToDiagnostic` 会按模式名报出来，
          // 而**不报匹配到的那一行**（那里可能有凭证）。
          url: null,
          stream,
          expectMatch: r.expectMatch,
          matchedPattern: result.last?.matchedPattern ?? null,
        },
      }
    }

    if (r.kind !== 'http' || proc.kind !== 'server' || proc.port === null) {
      handle.markReady()
      return {
        result: { ok: true, code: null, attempts: [], elapsedMs: 0, last: null, retryable: false },
        readiness: { url: null, expectJson: undefined },
      }
    }
    const url = `${proc.url}${r.path ?? '/'}`
    const expectJson = r.expectJson === undefined
      ? undefined
      : Object.fromEntries(Object.entries(r.expectJson).map(([k, v]) => [
        k,
        expandExpectation(v, { port: proc.port, teamHubPort, dataDir: layout.dataDir, install: layout.installDir }),
      ]))
    const expected = { url, expectStatus: r.expectStatus ?? 200, expectJson }
    const result = await waitForReadiness(expected, {
      timeoutMs: r.timeoutMs ?? readiness.timeoutMs ?? 30000,
      intervalMs: r.intervalMs ?? readiness.intervalMs ?? 250,
      fetchImpl,
      sleep,
      now,
      isProcessAlive: () => handle.isAlive(),
      probeTimeoutMs: readiness.probeTimeoutMs ?? 5000,
    })
    if (result.ok === true) {
      handle.markReady()
    } else {
      // 超时是「还早」，其余不可重试的失败是「错了」——两者都必须停止等待，
      // 但只有后者要立刻熔断（等下去对 identity-mismatch 毫无意义）。
      handle.markUnready({
        fatal: result.retryable !== true && result.code !== 'readiness-timeout',
        detail: result.detail ?? result.last?.detail ?? null,
      })
    }
    return { result, readiness: expected }
  }

  /**
   * 建立日志 sink（幂等）。
   *
   * **它在 `start()` 的`第一步`被调用，早于 preflight 与 plan。** 这不是随手放的：
   * 启动失败时恰恰最需要日志，把 sink 建在"体检通过之后"等于在最需要它的
   * 那一刻恰好没有日志（与 PRT-710 诊断入口排在布局校验之前是同一个理由）。
   *
   *   > 一个只在产品健康时才存在的日志，与一个不存在的日志，
   *   > 在最需要它的那一刻是同一个东西。
   *
   * 建不起来**不阻止启动**：没有日志是遗憾，起不来是故障。但那条遗憾必须被看见。
   */
  function ensureLogSink() {
    if (logSink !== null) return logSink
    try {
      logSink = createLogSink({
        logDir: layout?.logDir,
        policy: logPolicy ?? {},
        fs: logFs,
        onDiagnostic: (d) => logSinkDiagnostics.push(Object.freeze({
          ...d, process: null,
        })),
      })
    } catch (e) {
      logSink = null
      logSinkDiagnostics.push(Object.freeze({
        severity: 'warn', code: 'LOG_SINK_UNAVAILABLE', process: null,
        // **必须带上 `e.message`。** 只报 `e.name` 时，一个 `ReferenceError`
        // 在界面上就只剩"ReferenceError"四个字——那等于没有信息：
        // 排查者既不知道该改哪一行，也不知道是代码错还是环境错。
        message: `日志 sink 建不起来（${e?.name ?? 'Error'}：${e?.message ?? '(无说明)'}）：` +
          '子进程输出会被**排空但丢弃**（进程仍然会起来），但出了问题时没有日志可看',
      }))
    }
    // 定时器跟着 sink 起，**不等 plan 走通**：启动失败的那份日志
    // 恰恰是最该被写下来、也最该被轮转保护的一份。
    startLogRotationTimer()
    return logSink
  }
  /** 把 sink 里没成行的尾巴写下去，并做一次轮转。**不抛错。** */
  async function finalizeLogs() {
    if (logSink === null) return null
    try { logSink.flush() } catch { /* 尽力而为 */ }
    try {
      const r = await logSink.rotate()
      if (r !== null) lastRotation = r
      return r
    } catch (e) {
      logSinkDiagnostics.push(Object.freeze({
        severity: 'warn', code: 'LOG_ROTATE_FAILED', process: null,
        message: `停止时轮转失败：${e?.name ?? 'Error'}（日志已写盘，只是没有轮转）`,
      }))
      return null
    }
  }

  /**
   * 周期性轮转。
   *
   * **`unref()` 是必须的**：一个被引用的定时器会让启动器进程永远不退出，
   * 于是"进程起来了但命令不返回"会成为一个莫名其妙的现场。
   * 定时器只在跑着的时候有意义，不该拦住退出。
   */
  function startLogRotationTimer() {
    if (logSink === null || !Number.isFinite(logRotateIntervalMs) || logRotateIntervalMs <= 0) return
    if (logRotationTimer !== null) return
    logRotationTimer = setIntervalImpl(() => {
      void finalizeLogs()
      // 顺带刷新运行记录：进程重启过之后 pid 变了，记录要跟上。
      // 放在这里是因为这个定时器已经在跑，且不依赖 plan 走通。
      persistRunRecord()
    }, logRotateIntervalMs)
    if (typeof logRotationTimer.unref === 'function') logRotationTimer.unref()
  }

  /** 记录文件路径。`layout.dataDir` 为空时是 `null`——**不猜位置**。 */
  const recordFile = () => runRecordPath(layout?.dataDir ?? '')

  /** 进程探针：真实实现要起 `tasklist` / `ps`，所以可注入。 */
  const probe = processProbe ?? createProcessProbe({ spawnImpl })

  /**
   * 拿单实例锁（PRT-708）。每次 `start()` 都真的去拿一次。
   *
   * 为什么不是"构造 `createLauncher` 时拿"：构造是**只读**的
   * （它算 plan、解析覆盖层、解析身份，不碰产品家目录里的独占资源）。
   * 在构造期拿锁会让"建一个 launcher 看一眼它打算做什么"变成一次占用，
   * 而那种占用没有任何人会去释放——**每一次 `--check` 都会留下一个死锁文件**。
   *
   *   > 一个"构造时就把资源占了"的工厂，
   *   > 与一个"看一眼就再也起不来"的产品，
   *   > 在用户那里是同一个东西——只不过前者看起来是把初始化提前做了。
   *
   * @returns {Promise<{ok: boolean, code: string, diagnostics: ReadonlyArray<string>}>}
   */
  async function acquireInstanceLock() {
    let outcome = null
    try {
      outcome = await acquireInstanceLockImpl({
        dataDir: layout?.dataDir ?? '',
        pid: typeof process?.pid === 'number' ? process.pid : 0,
        now: () => new Date(now()).toISOString(),
      })
    } catch (e) {
      // ★ 拿锁**抛**了（例如 `dataDir` 空 → 真实现抛"需要 dataDir"），
      //   必须翻成一次**具名拒绝**，而不是让它穿出 `start()`。
      //
      //     > 一个"拿不到锁时把异常抛穿启动函数"的启动器，
      //     > 与一个"拿不到锁时照常启动"的启动器，
      //     > 在调用方看来是两个东西——而前者更坏：
      //     > 调用方拿到的是一个未捕获异常，它说不清"是锁的问题"还是"是别的问题"。
      //
      //   `SINGLE_INSTANCE_CODES.UNKNOWN` 是这里唯一诚实的码：我们**判断不了**
      //   这个家目录有没有别的实例，所以不放行。
      instanceLockReading = Object.freeze({
        ok: false,
        code: SINGLE_INSTANCE_CODES.UNKNOWN,
        holder: null,
        file: null,
        error: e?.message ?? String(e),
      })
      log('error', `[instance-lock] 拿锁失败：${e?.message ?? String(e)}`)
      return Object.freeze({
        ok: false,
        code: SINGLE_INSTANCE_CODES.UNKNOWN,
        diagnostics: Object.freeze([
          `无法确认这个产品家目录有没有别的实例：${e?.message ?? String(e)}`,
          '不放行：判断不了的时候启动，等于把"可能有两个实例"当成"只有一个"。',
        ]),
      })
    }
    instanceLockReading = Object.freeze({
      ok: outcome.ok === true,
      code: outcome.code,
      holder: outcome.holder ?? null,
      file: outcome.lock?.file ?? null,
    })
    if (outcome.ok === true) {
      instanceLock = outcome.handle
    } else {
      // 拒绝时**把诊断原样交出去**。这一层的诊断里带着"该删哪个文件"，
      // 而那句话是用户唯一的出路——吞掉它就把一个可解的问题变成死胡同。
      for (const d of outcome.diagnostics ?? []) {
        log('error', `[instance-lock] ${d}`)
      }
    }
    return Object.freeze({
      ok: outcome.ok === true,
      code: outcome.code,
      diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    })
  }

  /**
   * 放掉单实例锁。**幂等**，且在**每一条**退出路径上都要调到。
   *
   * `stop()` 有两条早退（`supervisor === null`、以及正常那条），而锁是在
   * `start()` 里、早于 `supervisor` 被建之前就拿到的。于是"早退就不收尾"
   * 这个判断会**泄漏这把锁**——而下一次启动会被自己上一次的残留挡住。
   *
   * 这与同一段代码里 `forgetRunRecord()` 踩过的那个坑是**同一个形状**：
   * 「什么都没起来所以不用收尾」。
   */
  function releaseInstanceLock() {
    if (instanceLock === null) return null
    let outcome = null
    try {
      outcome = instanceLock.release()
    } catch (e) {
      outcome = { ok: false, reason: e?.message ?? String(e) }
    }
    instanceLock = null
    if (outcome?.ok !== true) {
      // 释放失败**不是**灾难（进程退出后那个文件是陈旧的，下次启动会按
      // "持有者已死"回收掉），但它必须被记下来——静默失败会让
      // "为什么下次启动说已经有实例在跑"变成一件要读代码才知道的事。
      log('warn', `[instance-lock] 释放未完成：${outcome?.reason ?? outcome?.code ?? '未知原因'}`)
    }
    return outcome
  }

  /**
   * 查上一次运行留下了什么。**只报告，不动手。**
   *
   * 清理是单独的一步（`sweepOrphansOnStart`），因为杀进程不可撤销——
   * 而"启动时顺手杀几个 pid"正是最容易杀错的那个形状。
   */
  async function checkPreviousRun() {
    const file = recordFile()
    if (file === null) return
    const read = readRunRecord(file, { fs: orphanFs })
    for (const d of read.diagnostics) orphanDiagnosticsOut.push(d)
    if (read.record === null) return
    const entries = await classifyRecordedPids(read.record, {
      isAlive: (pid) => probe.isAlive(pid),
      imageOf: (pid) => probe.imageOf(pid),
    })
    orphanReport = Object.freeze({
      runId: read.record.runId,
      startedAt: read.record.startedAt,
      entries,
    })
    for (const d of orphanDiagnostics(entries)) orphanDiagnosticsOut.push(d)

    // 启动时的清理**必须显式要求**。默认只报告——
    // 一个"默认会杀进程"的启动路径，与一个会在用户没要求时动手的路径，
    // 在"用户能不能预料到发生了什么"上是同一个东西。
    if (sweepOrphansOnStart === true) {
      sweepResult = await sweepOrphans(entries, {
        killTree: (pid) => killTreeOf(pid),
        allowUnverified: allowUnverifiedSweep === true,
      })
      for (const d of sweepResult.diagnostics) orphanDiagnosticsOut.push(d)
    }
  }

  /** 杀一棵进程树。Windows 上走 `taskkill /T /F`（杀树），否则 `SIGKILL`。 */
  async function killTreeOf(pid) {
    if (typeof killTreeImpl === 'function') return (await killTreeImpl(pid)) === true
    return defaultKillTree({
      pid,
      kill: () => { try { process.kill(pid, 'SIGKILL'); return true } catch { return false } },
    })
  }

  /**
   * 把这次起了什么写下来。
   *
   * 记录里的 pid 会随重启变旧，而陈旧是**有界**的危害：旧 pid 要么已经
   * 没了（判 `gone`），要么被系统回收给了别人（判 `recycled` → 我们拒绝
   * 动手）。所以陈旧只会让报告变吵，**不会让我们杀错**。
   * 这也是为什么可以在"就绪后写一次 + 每次轮转刷新"这个粒度上收手，
   * 而不必去挂监督层的每次状态变化。
   */
  function persistRunRecord() {
    const file = recordFile()
    if (file === null) return
    const processes = supervisor === null ? [] : supervisor.status().map((x) => ({
      key: x.key,
      pid: typeof x.pid === 'number' ? x.pid : null,
      // **映像名此刻拿不到。** 它不是"省略"，是"记录下来下次只能判 unknown"，
      // 而 unknown 的处置是"不动手"——这正是安全的那一侧。
      image: x.image ?? null,
      // ★ PRT-009：峰值读数**必须**在这里带上。`supervisor.status()` 每一行都带
      //   `peakResource`，而 `buildRunRecord` 是**闭合映射**——少了这一行，落盘的
      //   永远是 `null`，而它与"采样器坏了"在磁盘上是同一个东西。
      peakResource: x.peakResource ?? null,
    }))
    const rec = buildRunRecord({
      runId,
      launcherPid: typeof process?.pid === 'number' ? process.pid : null,
      startedAt: startedAt === null ? undefined : new Date(startedAt).toISOString(),
      processes,
    })
    const w = writeRunRecord(file, rec, { fs: orphanFs })
    if (w.ok !== true && w.diagnostic !== null) orphanDiagnosticsOut.push(w.diagnostic)
  }

  /** 正常停止之后删掉记录——它是"**这次**运行"的状态，不是历史。 */
  function forgetRunRecord() {
    const file = recordFile()
    if (file !== null) clearRunRecord(file, { fs: orphanFs })
  }

  /**
   * 装配健康心跳（PRT-713 收尾）。
   *
   * ★ 与 `ensureLogSink` 一样的定位：**绝不阻止启动**，但绝不静默。
   *
   * 它**不**在这里 `start()`——排在定时器上的那一刻应当是"产品已经起来了"，
   * 而不是"我们打算起"。一个在产品其实没起来时就开始发心跳的实现，
   * 会向服务端报告一个不存在的运行实例。
   */
  function ensureHeartbeat() {
    const factory = heartbeatFactory ?? createLauncherHeartbeat
    try {
      heartbeatHandle = factory({
        layout,
        policy: heartbeatPolicy,
        logger: (m) => log('info', m),
        ...(heartbeatConsentReader === null ? {} : { consentReader: heartbeatConsentReader }),
        ...(heartbeatSetTimer === undefined ? {} : { setTimer: heartbeatSetTimer }),
        ...(heartbeatClearTimer === undefined ? {} : { clearTimer: heartbeatClearTimer }),
      })
      heartbeatDiagnostics = [...(heartbeatHandle?.diagnosticsList?.() ?? heartbeatHandle?.diagnostics ?? [])]
    } catch (e) {
      heartbeatHandle = null
      heartbeatDiagnostics = [Object.freeze({
        severity: 'warn', code: 'HEARTBEAT_WIRING_FAILED',
        message: `装配心跳时抛错（不影响启动）：${e?.message ?? e}`,
      })]
    }
  }

  /** 停掉心跳（幂等，不抛）。 */
  function stopHeartbeat() {
    if (heartbeatHandle === null) return
    try {
      heartbeatHandle.stop()
      heartbeatDiagnostics = [...(heartbeatHandle.diagnosticsList?.() ?? heartbeatDiagnostics)]
    } catch (e) {
      heartbeatDiagnostics = [...heartbeatDiagnostics, Object.freeze({
        severity: 'warn', code: 'HEARTBEAT_WIRING_FAILED',
        message: `停止心跳时抛错：${e?.message ?? e}`,
      })]
    }
  }

  /**
   * 心跳的可查状态（PRT-713 收尾）。
   *
   * `wired` = **能用**（不是"有个句柄挂着"）；`enabled` = 配置要求开着。
   * 这两者不一致，就是"用户开了心跳但它其实发不出去"那一幕，
   * 而它必须是一个**能被读到的差**，不能只活在日志里。
   *
   * `wired`/`enabled` 由本函数**无条件给出**，不从被接上来的对象那里转发：
   * 一个不完整的实现（或一个替身）漏报这个键时，调用方读到的是
   * `undefined`——而"没有这个字段"与"没接上"看起来是同一个东西。
   */
  function heartbeatStatus() {
    let inner = {}
    try { inner = heartbeatHandle?.status?.() ?? {} } catch { inner = {} }
    return Object.freeze({
      ...inner,
      wired: heartbeatHandle !== null && inner.wired === true,
      enabled: heartbeatPolicy?.enabled === true,
      ...(heartbeatHandle === null || inner.wired === true ? {} : { code: inner.code ?? null, message: inner.message ?? '' }),
    })
  }

  const launcher = {
    plan,
    diagnostics: planDiagnostics,
    /**
     * 强制面覆盖层的解析结果（PRT-257）。
     *
     * 暴露出来是为了让"到底有没有把 `--patch` 接上"这件事**可被观测**——
     * 只看 `plan.processes` 里 runtime 的 argv 也能看出来，但那个读数
     * 混在 `runtime.command` 自己的参数里；分开一份，排查时不必去数逗号。
     */
    enforcementOverlay: overlay,
    /**
     * 单实例锁的读数（PRT-708）。
     *
     * 暴露理由与 `enforcementOverlay` 同：**"锁接上了没有"必须可被观测**。
     * 一个拿不到锁的启动会退在 `phase: 'instance-lock'`，但那是**这一次**的
     * 读数；`instanceLockReading` 说的是"最近一次尝试拿到了什么、是谁占着"，
     * 排查"为什么起不来"时要看的是它。
     *
     * 取值：`null`（还没 `start()` 过）或
     * `{ ok, code, holder, file }`，其中 `code` 是 `SINGLE_INSTANCE_CODES` 之一。
     * `holder: null` 与 `holder: {pid: …}` 要分开读：前者是"没人"，后者是"有人，
     * 是谁写在这儿了"。
     */
    get instanceLock() { return instanceLockReading },    /**
     * Legion 身份的解析结果（PRT-214 续）。
     *
     * 与 `enforcementOverlay` 同一个理由暴露出来：`--patch` 接上了、而身份没接上，
     * 与"两层都没接上"在 DSH 进程里的表现（组合根拒绝装配）是一样的，
     * 但**修法完全不同**——一个要去看补丁文件，一个要去看 `runtime.env`。
     * 两个读数分开摆，排查时不必去 grep 诊断列表。
     */
    enforcementIdentity,

    /**
     * Runtime Contract 的端点解析结果（PRT-253 续批四）。
     *
     * `null` = 还没走到"要拉起 orchestrator"那一步（受限范围 / 启动在更早的阶段失败）；
     * `{ok:true, url, host, port, pid}` = 端点已经拿到并**校验过是本次那个进程**发布的；
     * `{ok:false, code, message}` = 具名拒绝，而那一条**同时**在诊断列表里。
     *
     * 与 `enforcementOverlay` / `enforcementIdentity` 同一个理由暴露出来：
     * "worker 报 HOST_PORT_REQUIRED" 有三四种完全不同的修法，
     * 这里是能区分它们的那一个读数。
     */
    runtimeContract() {
      return runtimeContractEndpoint
    },

    /**
     * 凭证材料化的读数（PRT-509 缺口 ①）。
     *
     * `null` = 还没走到那一步；否则是一个只含**引用名、DSH 名字、路径、模式与
     * 计数**的读数（**永远没有值**）。与 `enforcementOverlay` / `runtimeContract`
     * 同一个理由暴露出来："DSH 起来之后连不上模型"有四五种完全不同的修法
     * （没配密钥 / 密钥库打不开 / 映射拿不到 / 覆盖层没生效 / DSH 没读那份文件），
     * 而这里是能区分它们的那一个读数。
     */
    runCredentials() {
      return runCredentialReading
    },

    /** 只做检查，不启动任何东西。产品入口在真正启动前调用它。 */
    async preflight() {
      const blocking = planDiagnostics.filter((d) => d.severity === 'error')
      if (blocking.length > 0) {
        return Object.freeze({ ok: false, phase: 'plan', diagnostics: Object.freeze([...planDiagnostics]) })
      }
      const runnable = included.filter((p) => p.command !== null)
      portDiagnostics = [...(await checkPorts(runnable, { allowInUse: allowPortInUse }))]
      if (portDiagnostics.some((d) => d.severity === 'error')) {
        return Object.freeze({ ok: false, phase: 'ports', diagnostics: Object.freeze([...planDiagnostics, ...portDiagnostics]) })
      }
      // 密钥库自检（PRT-254 / PRT-257）。排在端口之后：端口冲突是"起不来"，
      // 而密钥库的问题里只有两类是"不许起"，其余是"起来之后某些事做不了"
      // ——先报更硬的那个。
      secretsDiagnostics = await collectSecretsDiagnostics()
      const all = [...planDiagnostics, ...portDiagnostics, ...secretsDiagnostics]
      return Object.freeze({
        ok: !all.some((d) => d.severity === 'error'),
        phase: null,
        diagnostics: Object.freeze(all),
      })
    },

    /**
     * 启动。返回 `{ ok, states, diagnostics, elapsedMs }`。
     * 任一必需进程未就绪 → 回滚（停掉已启动的）并返回 `ok: false`。
     */
    async start() {
      const beganAt = now()
      // **第一步**：日志。早于 preflight 与 plan——启动失败时最需要它。
      ensureLogSink()

      // **第二步：单实例锁（PRT-708）。早于** `checkPreviousRun()`。
      //
      // 顺序在这里是**安全性**，不是风格。`checkPreviousRun()` 会去核对运行记录
      // 并清理上一次留下的孤儿进程——如果第二个实例先跑到那里，它读到的是
      // **第一个实例**的记录，然后按自己的理解去"清理"那批进程。
      //
      //   > 一个"先清理残留、再检查自己该不该启动"的启动器，
      //   > 会把"我上次没退干净"与"别人正在跑"当成同一件事处理——
      //   > 只不过它清理的是**别人正在用的**那批进程。
      //
      // 所以：先证明"这个产品家目录没有别的实例"，再去碰任何与进程有关的东西。
      const lockOutcome = await acquireInstanceLock()
      if (lockOutcome.ok !== true) {
        return Object.freeze({
          ok: false,
          phase: 'instance-lock',
          code: lockOutcome.code,
          failures: Object.freeze([]),
          diagnostics: Object.freeze(lockOutcome.diagnostics ?? []),
          states: Object.freeze([]),
          elapsedMs: now() - beganAt,
        })
      }

      // **第三步**：上一次运行留下了什么。
      //
      // 晚于日志（日志要能记下这次查的结果），早于 preflight（端口占用检查
      // 报「被其他进程占用」时，这条诊断是解释它的那句话）。
      //
      //   > 一个把"我上次没退干净"与"别人占了这个端口"说成同一句话的提示，
      //   > 把一件产品该自己收拾的事，变成了一件要用户去猜的事。
      await checkPreviousRun()
      const pre = await this.preflight()
      if (pre.ok !== true) {
        // **早退路径也要删记录。** 这条是一次真正的缺陷：这一路什么都没起来，
        // 所以记录里描述的**只可能**是上一次运行。留着它，下次启动会把同一批
        // 残留再报一遍，用户会以为残留一直在长。
        //
        // 与 `stop()` 那条早退是同一个形状的问题——「什么都没起来所以不用收尾」
        // 这个判断，两次都把该做的事漏掉了。
        forgetRunRecord()
        return Object.freeze({ ok: false, phase: pre.phase, failures: Object.freeze([]), diagnostics: pre.diagnostics, states: Object.freeze([]), elapsedMs: now() - beganAt })
      }

      // ★ PRT-251 续 ④：把**安装目录里已有的业务数据**接进 DataDir。
      //
      // 位置与凭证材料化那一步同一条理由，两端都卡死：
      //   · 晚于 `preflight()` ⇒ 只在"这次真的要起来"时才动数据；
      //   · 早于 spawn ⇒ team-hub 打开库**之前**它就在 DataDir 里了，
      //     否则 hub 会对着一个空文件建表，而接管再也无从判断
      //     （目标已存在 ⇒ 按幂等规则跳过 ⇒ 用户的数据永远接不进来）。
      //
      // ★ 失败时**拒绝启动**，不是警告后照常起。
      //
      //   这是本缺口唯一能不再重演的方式：
      //
      //   > 一个"有旧数据、但没接管成功、于是空着起来"的启动，
      //   > 与一个"这是台新机器、本来就没有数据"的启动，
      //   > 在**界面**上是同一个读数（都是空的）——只不过前者的数据
      //   > 就在旁边一个目录里，而用户会以为数据丢了。
      //
      //     而"没有旧数据"（`nothing-to-adopt`）是**正常**，照常启动——
      //     拒绝只针对"有东西该接、却没接成"。
      //
      //   ★ 范围：**只为这次真的要启动的进程**接管（`includedKeys`）。
      //     `--include=runtime` 那种"我只想把 DSH 起起来看看"的启动，
      //     不该顺手把 team-hub 的库接走——接管是一次性快照（目标存在即永远
      //     跳过），所以那样一次试运行会烧掉唯一一次机会，
      //     而且是在旧 hub 还在写那个库的时候。
      const adoption = await this.adoptLegacyData({ processes: includedKeys })
      if (adoption.ok !== true) {
        forgetRunRecord()
        return Object.freeze({
          ok: false,
          phase: 'legacy-adoption',
          failures: Object.freeze([]),
          diagnostics: Object.freeze(adoption.items.map((i) => Object.freeze({
            severity: 'error',
            code: i.code,
            process: i.process,
            message: i.message,
          }))),
          states: Object.freeze([]),
          elapsedMs: now() - beganAt,
        })
      }

      // ★ PRT-509 缺口 ①：把这次运行声明的凭证**材料化**，并让 DSH 真的读它。
      //
      // 位置是这一段，即 `preflight()` 之后、`createSupervisor()`/spawn **之前**：
      //
      //   · 早于 spawn ⇒ 文件在 Runtime 进程 **init 之前**就位（提供方在 init 时
      //     读那份文档，`watch: true` 之后才热重载）；
      //   · 晚于 preflight ⇒ 失败发生在一个**还没有产生任何副作用**的阶段
      //     （没占端口、没建库、没留半启动进程）；
      //   · 而它**不能**放到"每个 Run 开始时"：那份文档是进程级共享的一份，
      //     Run B 落盘会覆盖 Run A 的，而 spec §6.7 要求"在途 Run 保持其启动时
      //     解析到的凭证"——一次写入会改掉另一个正在跑的东西手里的钥匙，
      //     而且**不报错**。理由全文在那个模块的文件头。
      const credentialStep = await prepareRuntimeCredentials({
        layout,
        paths: runCredentialPathReading,
        dshCredentialsFile,
        operatorHome,
        runId: `launch-${now()}-${typeof process?.pid === 'number' ? process.pid : 'x'}`,
        refs: runCredentialRefs,
        mapping: runCredentialMapping,
        runtimeCommand: runtimeResolution.command,
        openHandle: runCredentialHandleFactory ?? defaultRunCredentialHandle,
        // ★ `null` 走**模块自己的默认实现**（真的 `materializeRunCredentials`）。
        //   不能把 `null` 直接透传：解构默认值只在 `undefined` 时生效，
        //   于是 `null` 会让那一步变成"没有可用的材料化实现"——一个**接了线、
        //   但永远写不出东西**的接线，而它的读数看起来像一次正常的具名拒绝。
        ...(runCredentialMaterialize === null ? {} : { materialize: runCredentialMaterialize }),
        requireFn: runCredentialRequire,
        io: runCredentialIo,
      })
      runCredentialReading = credentialStep
      runCredentialDiagnostics = [...(credentialStep.diagnostics ?? [])]
      if (credentialStep.blocking === true) {
        // 与 `preflight()` 那条早退同一个形状：什么都没起来，所以记录只可能描述
        // **上一次**运行。留着它会让下一次启动把同一批残留再报一遍。
        forgetRunRecord()
        return Object.freeze({
          ok: false,
          phase: 'run-credentials',
          code: credentialStep.code,
          failures: Object.freeze([]),
          diagnostics: Object.freeze([...pre.diagnostics, ...runCredentialDiagnostics]),
          states: Object.freeze([]),
          elapsedMs: now() - beganAt,
        })
      }

      supervisor = createSupervisor(withRunCredentialPatch(plan, credentialStep.applied, runCredentialPathReading), {
        order: plan.waves.flat().filter((k) => includedKeys.has(k)),
        spawnImpl,
        spawnOptions,
        onOutput: (key, stream, chunk) => {
          // ★ 先喂行缓冲，再写日志：`kind:'stdout'` 的就绪判据读的是前者，
          //   而日志 sink 可能根本没建起来（那是遗憾，不是故障）——
          //   把两件事绑在一起会让"没有日志"顺带变成"永远等不到就绪"。
          outputLines.push(key, stream, chunk)
          if (logSink !== null) logSink.write(`${key}.${stream}`, chunk)
        },
        onOutputError: (key, e) => logSinkDiagnostics.push(Object.freeze({
          severity: 'warn', code: 'LOG_SINK_WRITE_FAILED', process: key,
          message: `处理 ${key} 的输出时出错：${e?.name ?? 'Error'}（日志可能缺行）`,
        })),
        // 白名单 env 通过 envFor 注入监督层；监督层不继承宿主环境
        envFor: (spec) => envFor(plan.processes.find((p) => p.key === spec.key) ?? spec),
        backoff,
        logger: (e) => log(e.level, `[${e.process}] ${e.message}`),
        now,
      })

      startedAt = now()
      runId = `run-${startedAt}-${typeof process?.pid === 'number' ? process.pid : 'x'}`
      readinessDiagnostics = []
      // （定时器已在 `ensureLogSink` 里随 sink 起：它不该依赖 plan 走通。）
      const failures = []

      for (const wave of plan.waves) {
        const waveProcs = wave
          .filter((k) => includedKeys.has(k))
          .map((k) => plan.processes.find((p) => p.key === k))
          .filter((p) => p !== undefined && p.command !== null)
        if (waveProcs.length === 0) continue
        // ★ 清陈旧发布必须在 **spawn Runtime 之前**：那条顺序是"清完之后再出现的
        //   发布只可能来自本次那个进程"这条保证的全部依据（pid 判定是第二道）。
        if (includedKeys.has(DSH_OVERLAY_PROCESS_KEY) && wave.includes(DSH_OVERLAY_PROCESS_KEY)) {
          clearStalePublication()
        }
        // ★ 端点必须在 **spawn orchestrator 之前**解析出来：`envFor` 是在
        //   `supervisor.handles.get(key).start()` 里被调用的，而 orchestrator
        //   与 runtime 不在同一波（`dependsOn` 保证），所以这里是那一波之前的
        //   最后一个位置。解析不出来就**不注入 URL**（见 derivedValuesFor）。
        if (includedKeys.has('orchestrator') && wave.includes('orchestrator') && runtimeContractEndpoint === null) {
          runtimeContractEndpoint = await resolveRuntimeContractEndpoint(failures)
        }
        for (const proc of waveProcs) {
          // ★ 清掉上一代留下的输出，**必须在 spawn 之前**。
          //
          //   重启后新实例的 `stdout` 判据如果被上一代那一行 `dsh web: …` 满足，
          //   就是一次假就绪——而"上一代报过就绪、这一代还没说话"
          //   与"这一代真的起来了"，在读数上是同一个东西。
          //   （`attemptStart()` 每次 spawn 全新 child，但那**不会**清掉我们的行缓冲，
          //   因为缓冲属于 Launcher，不属于 child。）
          outputLines.clear(proc.key)
          const result = supervisor.handles.get(proc.key).start()
          if (result.started !== true) failures.push(Object.freeze({ process: proc.key, code: 'SPAWN_REFUSED', detail: result.reason }))
        }
        for (const proc of waveProcs) {
          const handle = supervisor.handles.get(proc.key)
          const outcome = await awaitReadiness(proc, handle)
          readinessDiagnostics.push(readinessResultToDiagnostic(proc.key, outcome.readiness, outcome.result))
          if (outcome.result.ok !== true && proc.required) {
            failures.push(Object.freeze({
              process: proc.key,
              code: outcome.result.code,
              // 立即失败（非超时）类结果的 `detail` 在 `last` 上——只取外层会让
              // 「为什么没就绪」变成 `null`，而这条信息正是排查的全部线索。
              detail: outcome.result.detail ?? outcome.result.last?.detail ?? null,
            }))
          }
        }
      }

      const diagnostics = Object.freeze([...pre.diagnostics, ...runCredentialDiagnostics, ...readinessDiagnostics, ...runtimeContractDiagnostics])
      if (failures.length > 0) {
        const stopResults = await this.stop({ reason: '启动失败回滚' })
        return Object.freeze({
          ok: false,
          phase: 'readiness',
          failures: Object.freeze(failures),
          diagnostics,
          states: stopResults.states,
          elapsedMs: now() - beganAt,
        })
      }
      // 就绪之后立刻落一条记录：此后这台机器上如果 Legion 被强杀，
      // 下一次启动就能认出这些 pid。晚于就绪是因为 pids 到这时才齐。
      persistRunRecord()
      // ★ PRT-713 收尾：**产品真的起来了**，这时才装配并起心跳。
      //
      //   排在就绪之后、而不是 `start()` 的第一步：一个在产品其实没起来时
      //   就开始发心跳的实现，会向服务端报告一个**不存在的运行实例**——
      //   而那种假信号比没有信号更坏，因为它会让远端以为一切正常。
      if (heartbeatPolicy?.enabled === true) {
        ensureHeartbeat()
        heartbeatHandle?.start?.()
        heartbeatDiagnostics = [...(heartbeatHandle?.diagnosticsList?.() ?? heartbeatDiagnostics)]
      }
      return Object.freeze({
        ok: true,
        phase: null,
        failures: Object.freeze([]),
        diagnostics,
        states: this.status().processes,
        elapsedMs: now() - beganAt,
      })
    },

    /** 停止（幂等）。 */
    async stop({ graceMs = 5000, reason = '主动停止' } = {}) {
      if (supervisor === null) {
        // **什么都没起来时也要收尾日志。**
        //
        // 第一版这里直接返回了，于是"启动在 preflight 就失败"这一类最值得
        // 留证的场景，日志既不会被 flush（最后几行丢掉）也不会被轮转
        // （一个已经写满的文件留给下一次启动继续写）。
        //
        //   > 「没起来所以没什么可记的」这个判断，
        //   > 恰好把最该记的那一次排除掉了。
        if (logRotationTimer !== null) { clearIntervalImpl(logRotationTimer); logRotationTimer = null }
        const logResult = await finalizeLogs()
        // 什么都没起来也要删记录：这条记录此刻只可能描述**上一次**运行，
        // 而它已经被 `checkPreviousRun` 读过、报告过了。留着它会让下一次
        // 启动把同一批残留**再报一遍**，用户会以为残留一直在长。
        forgetRunRecord()
        // 心跳同样要停：`start()` 在**成功之后**才装配它，所以这里通常
        // 本来就是空的；但"通常"不是"一定"——一次中途失败的启动
        // 可能已经装配过。停止路径不该依赖"另一条路径应该没走到那一步"。
        stopHeartbeat()
        // ★ 锁也要放。它是在 `start()` 里、**早于** `supervisor` 被建之前拿到的，
        //   所以"没起来就没什么可收的"这个判断同样会漏掉它——而上一次残留的锁
        //   会把**下一次**启动挡在门外，提示还是"已经有一个实例在运行"。
        releaseInstanceLock()
        return Object.freeze({ reason, results: Object.freeze([]), states: Object.freeze([]), log: logResult })
      }
      log('info', `停止：${reason}`)
      const results = await supervisor.stopAll({ graceMs })
      const states = supervisor.status()
      supervisor.dispose()
      stoppedAt = now()
      supervisor = null
      // 停止之后**必须** flush：还没换行的尾巴是最后那几行退出信息，
      // 而那恰恰是排查最需要的一段。轮转也在这里做一次——
      // 下次启动前把文件规整好，比让下一个进程接着写一个已经超限的文件好。
      if (logRotationTimer !== null) { clearIntervalImpl(logRotationTimer); logRotationTimer = null }
      // 注意：这里**不能**把结果叫 `log`。本文件顶层有一个 `log(level, msg)`
      // 诊断函数，在同一个作用域里用 `const log = …` 会在整个 `stop` 体内
      // 把它遮蔽成一个 TDZ 变量——连函数开头那句 `log('info', …)` 都会抛
      // `Cannot access 'log' before initialization`。
      //   > 一个遮蔽了外层函数的名字，会让那个函数在**整段**作用域里消失，
      //   > 而不只是在你写的那一行之后。
      const logResult = await finalizeLogs()
      // **停干净了才删记录。** 顺序不能反：先删的话，如果 stopAll 中途
      // 失败了（某些进程没杀掉），我们就失去了"还有谁活着"的唯一线索，
      // 而那些进程正好是下一次启动需要认出来的。
      forgetRunRecord()
      // ★ PRT-713 收尾：心跳与进程一起停。
      //
      //   一个"产品已经关掉了、心跳还在发"的实现，
      //   与一个关不掉的心跳，在"用户点了关闭之后数据还会不会出去"上是同一个东西。
      //
      //   放在**最后**（进程都停干净之后）：反过来的话，一次卡住的
      //   心跳停止会拖住我们对进程的清理，而进程清理才是 stop 的主职。
      stopHeartbeat()
      // ★ 最后放锁（PRT-708）。放在 `forgetRunRecord()` 之后：反过来的话，
      //   一次失败的"删记录"会让我们在**已经宣布停止**之后仍然占着锁，
      //   而那正是"关掉了却起不来"那个形状。
      releaseInstanceLock()
      return Object.freeze({ reason, results, states, log: logResult })
    },

    /** 熔断后的「重试」入口：重置熔断状态并重新走一次启动流程。 */
    async retry() {
      await this.stop({ reason: '重试前清理' })
      return this.start()
    },

    /** 只读状态（产品状态映射见 `productStateOf`）。 */
    status() {
      const processes = supervisor === null
        ? included.map((p) => Object.freeze({
          key: p.key,
          label: p.label,
          required: p.required,
          state: 'stopped',
          pid: null,
          url: p.url,
          port: p.port,
          milestone: p.milestone,
          restarts: 0,
          lastError: null,
          readiness: null,
        }))
        : supervisor.status().map((s) => {
          const proc = plan.processes.find((p) => p.key === s.key)
          const diag = readinessDiagnostics.find((d) => d.process === s.key) ?? null
          return Object.freeze({
            key: s.key,
            label: s.label,
            required: proc?.required ?? true,
            state: s.state,
            pid: s.pid,
            url: proc?.url ?? null,
            port: proc?.port ?? null,
            milestone: proc?.milestone ?? null,
            restarts: s.restarts,
            lastError: s.lastError,
            readiness: diag === null ? null : Object.freeze({
              code: diag.code,
              elapsedMs: diag.elapsedMs ?? null,
              attempts: diag.attempts ?? null,
              detail: diag.message,
            }),
          })
        })
      const needsAttention = supervisor === null ? [] : supervisor.requiresAttention()
      const state = productStateOf(processes, needsAttention, { partial: scopePartial })
      return Object.freeze({
        state,
        // 受限范围的信息必须**始终**出现在状态文案里，包括「未运行」时：
        // 「Legion 未运行」与「只启动了 team-hub 的调试会话」在界面上长得一样，
        // 而这两种状态下面该做的事完全不同。
        stateText: scopePartial
          ? `${PRODUCT_STATE_TEXT[state]}（受限范围：仅 ${[...includedKeys].join('、')}；这不是完整产品状态）`
          : PRODUCT_STATE_TEXT[state],
        scope: Object.freeze({
          partial: scopePartial,
          included: Object.freeze([...includedKeys]),
          excluded: Object.freeze(excluded.map((p) => p.key)),
        }),
        startedAt,
        stoppedAt,
        processes: Object.freeze(processes),
        needsAttention: Object.freeze([...needsAttention]),
        portDiagnostics: Object.freeze([...portDiagnostics]),
        readinessDiagnostics: Object.freeze([...readinessDiagnostics]),
        // PRT-713 收尾：心跳的状态要能查。
        //
        // 为什么放进 `status()` 而不是只留日志：心跳是**唯一**一个
        // "产品在往外发数据"的能力，而"它到底发了没有"必须是用户
        // 一眼能看到的读数——一个只能从日志里推断"有没有外发"的产品，
        // 与一个不告诉用户的产品，在用户想知道的时候是同一个东西。
        // ★ `wired` 的含义是**"心跳真的装上了、能用"**，不是"有个对象挂在那里"。
        //
        //   `ensureHeartbeat()` 在装配失败时也会留下一个句柄（它的 `start()`
        //   会拒绝并说明原因），所以"句柄非 null"与"心跳能用"是两件事。
        //   把后者报成前者，正好会把本批最要紧的那一幕盖住：
        //   **用户开了心跳，但它其实发不出去。**
        //
        //   装配失败时 `wired: false` 且 `code` 给出具体原因，
        //   同时 `allDiagnostics()` 里有对应的一条——三处都能看到，且互不矛盾。
        heartbeat: heartbeatStatus(),
        // PRT-257：这一次启动的 runtime 命令**是从哪来的**。
        //
        // 为什么必须是一个可读的读数，而不是"反正命令跑起来了"：
        // "用的是产品自己装的那一份"与"用的是配置里手写的那一条"
        // 在进程列表、就绪判据、界面上**完全一样**。而它们的升级、
        // 校验与回滚路径完全不同——一个只看"起没起来"的人，
        // 会在升级 DSH 之后发现升级的其实是另一个副本。
        runtimeEntry: Object.freeze({
          source: runtimeResolution.used,
          configured: runtimeResolution.given,
          profile: runtimeResolution.resolution.profile,
          command: runtimeResolution.command,
          code: runtimeResolution.resolution.code,
        }),
      })
    },

    /**
     * PRT-705：上一次运行的残留判成了什么样。
     *
     * `entries` 逐条给出结论（`gone` / `verified` / `recycled` / `unknown`），
     * 而不是一个"有几个残留"的数字——因为**四种结论的处置完全不同**，
     * 而其中两种是"绝对不要动手"。
     */
    orphanStatus() {
      return Object.freeze({
        previousRun: orphanReport,
        sweep: sweepResult,
        diagnostics: Object.freeze([...orphanDiagnosticsOut]),
      })
    },

    /** 供用例与产品入口合并展示的全量诊断。 */
    /** 日志（PRT-709）的最终处置。停止后仍可查询。 */
    logStatus() {
      return Object.freeze({
        available: logSink !== null,
        stats: logSink === null ? null : logSink.stats(),
        lastRotation: lastRotation,
        diagnostics: Object.freeze([...logSinkDiagnostics]),
      })
    },

    allDiagnostics() {
      const status = this.status()
      const out = [
        ...planDiagnostics, ...status.portDiagnostics, ...status.readinessDiagnostics,
        // PRT-705 的残留诊断**必须进这里**：只在 `orphanStatus()` 里的话，
        // 一个不去调它的入口就等于没有这条提示。
        ...orphanDiagnosticsOut,
        // PRT-713 收尾：心跳的诊断同理——一个"用户开了心跳但它其实没发出去"
        // 的配置，如果只在 `status().heartbeat` 里，那就只有专门去查的人看得到。
        ...heartbeatDiagnostics,
        // PRT-253 续批四：端点/凭证的诊断（生成失败、发布缺失/陈旧/非法）。
        // 与上面几条同一条纪律：只在 `status()` 里的话，不查它的人就看不到。
        ...runtimeContractDiagnostics,
        // PRT-251 续 ④：旧数据接管的逐项结论 + 一行总结。
        // 「有旧数据却没接成」必须在这里出现——否则它就是那个只在界面上
        // 表现为"空的"、而没有任何一处说得出原因的读数。
        ...adoptionDiagnostics,
      ]
      for (const item of status.needsAttention) {
        out.push(Object.freeze({
          severity: 'error',
          code: item.state === 'circuit-open' ? 'PROCESS_CIRCUIT_OPEN' : 'PROCESS_FAILED',
          process: item.key,
          message: `进程 ${item.key} 处于 ${item.state}：${item.lastError ?? '无详情'}。需要人工处理后重试。`,
        }))
      }
      return Object.freeze(out)
    },

    /**
     * 各进程的入口绝对路径（供「入口是否逃出安装目录」与存在性审阅）。
     * `product/process-manifest.mjs` 已有 `entryEscapesInstall`，这里只做聚合。
     */
    entries() {
      return Object.freeze(plan.processes.map((p) => Object.freeze({
        key: p.key,
        entryPath: p.entryPath,
        absolute: entryAbsolutePath(p, installRoot, layout.platform),
        entryKind: p.entryKind,
      })))
    },

    /**
     * 各进程的环境白名单读数（用于「密钥进了哪些进程」「写路径到底指到哪」这类审阅）。
     *
     * `values` 里**疑似凭证的键一律掩码**（`isSecretLikeKey`），平台必需键不列出。
     * 这个方法的用途是诊断，而诊断输出会被贴进 issue、写进日志、附进诊断包——
     * 一个「顺手带上原值」的接口是密钥泄漏最省事的通道：不需要谁犯错，只需要它存在。
     * 它同时让「写路径到底被指到哪」可被断言，而不必去问文件系统
     * （安装目录里是否有残留 .db 会被**别的**测试影响，那不是一个可依赖的判据）。
     */
    envSurface() {
      return Object.freeze(plan.processes.map((proc) => {
        const built = envFor(proc)
        const values = {}
        for (const [k, v] of Object.entries(built.env)) {
          if (OS_ESSENTIAL_ENV.includes(k)) continue
          values[k] = isSecretLikeKey(k) ? '<redacted>' : v
        }
        return Object.freeze({
          process: proc.key,
          allowed: built.allowed,
          droppedKeys: built.dropped,
          values: Object.freeze(values),
        })
      }))
    },

    /**
     * ★ PRT-251 续：**计划里的 argv**（与 `envSurface()` 对称的观察口）。
     *
     * ## 为什么需要它
     *
     * 「端口到达了 DSH」这件事的唯一判据是**argv 的顺序**，不是「argv 里有没有
     * `--port`」：DSH 的命令行是「launcher 旗标段 + app 旗标段」，它的解析器
     * 遇到第一个不认识的 token 就停止解析自己的旗标。所以一旦 `--port` 跑到
     * `--patch` 前面，`--patch <覆盖层>` 就落进 app 段——**强制面补丁层静默消失**，
     * 而启动照样成功。
     *
     *   > 一个「端口修好了但强制面没了」的启动，
     *   > 与一个「端口没修好、强制面还在」的启动，在**启动成功**这个读数上
     *   > 是同一个东西——只不过前者看起来更像一次成功的修复。
     *
     * 而那段 argv 此前**没有任何观察口**：`envSurface()` 只看环境，
     * 于是「覆盖层还在 launcher 段里」这件事只能靠读代码相信。
     *
     * ## 它不做的事
     *
     * 不返回环境、不返回值里的密钥（argv 里本来就不该有凭证——那由
     * 别处的断言钉着）；`command === null`（入口没解析出来）时如实给 `null`，
     * **不编一个空数组**：`[]` 是「有一条没有参数的命令」，与「没有命令」是两件事。
     */
    commandSurface() {
      return Object.freeze(plan.processes.map((proc) => Object.freeze({
        process: proc.key,
        args: proc.command === null ? null : Object.freeze([...proc.command.args]),
      })))
    },

    /**
     * ★ PRT-251 续 ④：把安装目录里已有的业务数据接进 DataDir。
     *
     * 记忆化：一次 Launcher 生命周期里只做**一次**。重复执行虽然幂等
     * （目标已存在 ⇒ 跳过），但"启动路径调一次、状态查询又调一次"
     * 会让读数在两次之间变化，而那正是"这个库到底是谁的"最难查的一类问题。
     *
     * 返回的是 `adoptLegacyData()` 的读数本身——**不加工**。计划与执行
     * 分开（`planAdoption()` 是纯的），是为了让"该不该接"能在不真的拷一份库
     * 的前提下被断言。
     *
     * ★ `processes`：**只为这次真的要启动的进程**接管它的数据（默认全量）。
     *   理由见 `adoptionItems()`——`--include=runtime` 那种试运行不该顺手
     *   把 team-hub 的库接走，因为接管是一次性快照。
     *
     * ⚠️ 记忆化**只记无范围的那一次**。受限范围的那次如果也写进 `adoptionReading`，
     *   一次 `--include=runtime` 就会把"这个 Launcher 的接管读数"替换成
     *   "我这次没看 team-hub"——于是随后一次真正的全量启动会读到那份**空**读数，
     *   并据此认为无事可做。那不是幂等，是记忆化把范围问题变成了数据问题。
     */
    async adoptLegacyData({ dryRun = false, processes = null } = {}) {
      const scoped = processes !== null && processes !== undefined
      if (adoptionReading !== null && !dryRun && !scoped) return adoptionReading
      if (dryRun) {
        const planned = planAdoption({ layout, dataPathEnv: DATA_PATH_ENV, processes })
        return Object.freeze({
          dryRun: true, ok: planned.ok, state: null, items: planned.items, counts: planned.counts,
        })
      }
      // 逐项结论进 `adoptionDiagnostics`（聚合进 `allDiagnostics()`），
      // **不直接写日志 sink**：sink 是按「进程.流」分文件的，而这件事不属于
      // 任何一个子进程——塞进某个进程的日志会让"这是谁说的话"变成猜的。
      //
      // ⚠️ 逐项那几行的码是 `LEGACY_ADOPTION_ITEM`，**不带总体状态**：
      //   这些回调是 `runLegacyAdoption()` **执行期间**逐项触发的，那时总体状态
      //   还不存在。原来写的是 `LEGACY_ADOPTION_${reading?.state ?? 'RUNNING'}`，
      //   而 `reading` 在那一刻必然是 `undefined` ⇒ 每一行都叫 `..._RUNNING`，
      //   无论它其实是"已接管"还是"失败"。一个恒为 `RUNNING` 的码不是信息，
      //   是让人以为"这里能看出进度"的装饰。
      //   总体状态在下面那一行总结里，那里它才真的存在。
      const reading = await runLegacyAdoption({
        layout,
        dataPathEnv: DATA_PATH_ENV,
        processes,
        log: (severity, message) => adoptionDiagnostics.push(Object.freeze({
          severity: severity === 'error' ? 'error' : 'info',
          code: 'LEGACY_ADOPTION_ITEM',
          process: null,
          message,
        })),
      })
      if (!scoped) adoptionReading = reading
      adoptionDiagnostics.push(Object.freeze({
        severity: reading.ok ? 'info' : 'error',
        code: 'LEGACY_ADOPTION',
        process: null,
        // 一行结论。运维最常问的是"这次启动有没有接管"，而它不该要靠拼
        // 四条逐项记录才能答出来。受限范围那几次要**说出来**，
        // 否则"接管 0／已是 0／无来源 0"看起来像"什么都没查"。
        message: `旧数据接管：${reading.state}`
          + `（接管 ${reading.counts.adopted}／已是 ${reading.counts.already}`
          + `／无来源 ${reading.counts.nothing}／失败 ${reading.counts.failed}`
          + `／拒绝 ${reading.counts.refused}）`
          + (scoped ? `；本次只覆盖启动范围内的进程：${[...processes].join('、') || '（空）'}` : ''),
      }))
      return reading
    },
  }

  return Object.freeze(launcher)
}

/**
 * 进程状态 → 产品状态（spec §6.3）。
 *
 * 判据：必需进程有任一处于熔断/失败 → `unavailable`；
 * 必需进程尚未就绪 → `starting`；可选进程受阻而必需进程就绪 → `degraded`；
 * 全部就绪 → `ready`；没有任何进程在跑 → `unavailable`。
 *
 * **不把「有进程在跑」当作 `ready`**：`starting` 与 `ready` 的区别正是
 * 「能不能开始认领任务」，而这个区别决定了 Orchestrator 的行为（§6.3 表格）。
 */
export function productStateOf(processes, needsAttention = [], { partial = false } = {}) {
  if (processes.length === 0) return 'unavailable'
  const blocking = new Set(needsAttention.map((n) => n.key))
  const required = processes.filter((p) => p.required !== false)
  const optional = processes.filter((p) => p.required === false)
  const active = new Set(['ready', 'starting', 'restarting'])
  const anyActive = processes.some((p) => active.has(p.state))
  if (!anyActive) return 'unavailable'
  if (required.some((p) => blocking.has(p.key))) return 'unavailable'
  if (required.some((p) => p.state !== 'ready')) return 'starting'
  if (optional.some((p) => blocking.has(p.key) || p.state !== 'ready')) return 'degraded'
  // 受限范围**永远不返回 `ready`**：`ready` 的含义是「可以开始认领任务」，
  // 而缺少执行引擎或 orchestrator 时那个含义不成立。
  return partial ? 'degraded' : 'ready'
}

/**
 * 就绪判据实测（PRT-703）：把「声明过的判据」升级为「量过的判据」。
 *
 * 清单里的 `readiness` 在真正跑过一次之前只能算声明（`verified: false`）。
 * 这个函数对**已就绪**的进程再探一次并把耗时/尝试次数报出来，
 * 因此「声明」到「实测」的转换是可复现的动作，而不是一次性的手工结论。
 */
export async function measureReadiness(proc, { fetchImpl = globalThis.fetch, sleep, now = () => Date.now(), timeoutMs = 30000, expectJson = undefined } = {}) {
  const r = proc.readiness ?? { kind: 'none' }
  if (r.kind !== 'http' || proc.port === null) {
    return Object.freeze({ process: proc.key, measured: false, reason: '该进程没有 HTTP 就绪判据（worker 或未声明）' })
  }
  const url = `${proc.url}${r.path ?? '/'}`
  const expected = {
    url,
    expectStatus: r.expectStatus ?? 200,
    expectJson: expectJson ?? (r.expectJson === undefined
      ? undefined
      : Object.fromEntries(Object.entries(r.expectJson).map(([k, v]) => [k, String(v).replaceAll('{port}', String(proc.port))]))),
  }
  const result = await waitForReadiness(expected, { fetchImpl, sleep, now, timeoutMs })
  return Object.freeze({
    process: proc.key,
    measured: true,
    url,
    ok: result.ok,
    code: result.code,
    elapsedMs: result.elapsedMs,
    attempts: result.attempts.length,
    detail: result.detail ?? null,
  })
}

/** 便捷判定：启动结果里是否有会阻塞自动执行的诊断。 */
export function startResultIsBlocking(result) {
  if (result?.ok === true) return false
  if (result?.phase === null || result?.phase === undefined) return true
  return hasBlockingDiagnostic(result.diagnostics ?? [])
}
