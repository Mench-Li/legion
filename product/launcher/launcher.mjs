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
import { buildChildEnv, isSecretLikeKey, OS_ESSENTIAL_ENV } from './allowlist.mjs'
import { checkPorts } from './ports.mjs'
import { readinessResultToDiagnostic, waitForReadiness } from './readiness.mjs'
import { createSupervisor, defaultKillTree } from './supervisor.mjs'
import { createLogSink } from '../logging/sink.mjs'
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
  /** 日志策略（PRT-709）。缺省用 `DEFAULT_LOG_POLICY`。 */
  logPolicy = {},
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
  secretsRun = null,
  secretsOwner = null,
  requireProtected = true,
} = {}) {
  if (layout === null || typeof layout !== 'object') throw new Error('createLauncher 需要 layout（见 product/paths.mjs）')

  const log = (level, message) => {
    if (typeof logger === 'function') logger({ level, message, at: now() })
  }

  const plan = materializeProcessPlan({ layout, ports, runtimeCommand, nodePath })

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

  const teamHubPort = plan.processes.find((p) => p.key === 'team-hub')?.port ?? null

  const rawPlanDiagnostics = [
    ...layoutDiagnostics(layout),
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
  /** 日志 sink（PRT-709）。`null` 表示建不起来——**不阻止启动**。 */
  let logSink = null
  const logSinkDiagnostics = []
  // PRT-705：上一次运行残留、记录读写失败、清理结果都汇到这里。
  const orphanDiagnosticsOut = []
  let runId = null
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
      const r = await runSecretsCheck({
        layout,
        platform: layout.platform,
        run: secretsRun,
        owner: secretsOwner,
        requireProtected,
      })
      return r.diagnostics
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

  const launcher = {
    plan,
    diagnostics: planDiagnostics,

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
      // **第二步**：上一次运行留下了什么。
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

      supervisor = createSupervisor(plan, {
        order: plan.waves.flat().filter((k) => includedKeys.has(k)),
        spawnImpl,
        spawnOptions,
        onOutput: (key, stream, chunk) => {
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
        for (const proc of waveProcs) {
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

      const diagnostics = Object.freeze([...pre.diagnostics, ...readinessDiagnostics])
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
