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
import { createSupervisor } from './supervisor.mjs'

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
      const pre = await this.preflight()
      if (pre.ok !== true) {
        return Object.freeze({ ok: false, phase: pre.phase, failures: Object.freeze([]), diagnostics: pre.diagnostics, states: Object.freeze([]), elapsedMs: now() - beganAt })
      }

      supervisor = createSupervisor(plan, {
        order: plan.waves.flat().filter((k) => includedKeys.has(k)),
        spawnImpl,
        spawnOptions,
        // 白名单 env 通过 envFor 注入监督层；监督层不继承宿主环境
        envFor: (spec) => envFor(plan.processes.find((p) => p.key === spec.key) ?? spec),
        backoff,
        logger: (e) => log(e.level, `[${e.process}] ${e.message}`),
        now,
      })

      startedAt = now()
      readinessDiagnostics = []
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
        return Object.freeze({ reason, results: Object.freeze([]), states: Object.freeze([]) })
      }
      log('info', `停止：${reason}`)
      const results = await supervisor.stopAll({ graceMs })
      const states = supervisor.status()
      supervisor.dispose()
      stoppedAt = now()
      supervisor = null
      return Object.freeze({ reason, results, states })
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

    /** 供用例与产品入口合并展示的全量诊断。 */
    allDiagnostics() {
      const status = this.status()
      const out = [...planDiagnostics, ...status.portDiagnostics, ...status.readinessDiagnostics]
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
