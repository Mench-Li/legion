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

/** 进程清单契约版本：清单结构变化时递增（产品版本清单会引用它）。 */
export const PROCESS_MANIFEST_VERSION = 1

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
    envNames: Object.freeze(['TEAM_HUB_PORT', 'TEAM_HUB_HOST', 'TEAM_HUB_TOKEN', 'TEAM_HUB_DB']),
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
    portKey: 'runtime',
    defaultPort: DEFAULT_PORTS.runtime,
    host: '127.0.0.1',
    readiness: Object.freeze({ kind: 'http', path: '/', expectStatus: 200, timeoutMs: 60000, intervalMs: 500, verified: false }),
    writesRoles: Object.freeze(['data', 'cache']),
    envNames: Object.freeze(['DSH_HOME', 'LEGION_DATA_DIR', 'LEGION_LOG_DIR']),
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
    envNames: Object.freeze(['TEAM_HUB_URL', 'TEAM_HUB_TOKEN', 'LEGION_DATA_DIR']),
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
    let command = null

    if (spec.entry.kind === 'node-file') {
      // 入口按**安装目录**解析成绝对路径：命令里出现相对路径时，实际被执行的是
      // 「相对于 Launcher 的 cwd」那一个文件，而它与清单里写的可能不是同一个。
      const entryAbs = vars.install === ''
        ? entryPath
        : api.resolve(vars.install, String(entryPath).split('/').join(api.sep))
      command = Object.freeze({ file: nodePath, args: Object.freeze([entryAbs, ...args, ...extras]) })
    } else {
      const configured = expandConfigured(runtimeCommand, vars)
      if (configured === null) {
        diagnostics.push(diag('error', 'ENTRY_UNRESOLVED', spec.key,
          `进程 ${spec.key} 的入口由配置项 ${spec.entry.configKey} 提供，但当前未配置其值。未配置时必须拒绝启动，不能跳过该进程——跳过会让「执行引擎不可用」表现成「任务一直没人做」。`))
      } else {
        command = Object.freeze({ file: configured.file, args: Object.freeze([...configured.args, ...args, ...extras]) })
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
