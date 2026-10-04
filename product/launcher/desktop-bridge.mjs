#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { createLauncher } from './launcher.mjs'
import { launcherOptionsFrom } from './cli.mjs'
import { createLineDecoder, DESKTOP_PROTOCOL_VERSION, parseRequest } from './desktop-protocol.mjs'
import { DEFAULT_PORTS } from '../process-manifest.mjs'
import { readDesktopSettings, selectedWorkspace, validateDesktopIdentity } from './desktop-settings.mjs'
import { ENFORCEMENT_IDENTITY_ENV } from './enforcement-identity.mjs'
import { discoverBackend } from './shared-backend.mjs'
import { readPendingTasksFromLauncher } from '../upgrade/task-readings.mjs'

export function desktopOptionsFrom({ workspace, env = process.env, nodePath = process.execPath } = {}) {
  const initial = launcherOptionsFrom({ env, nodePath })
  const savedSettings = initial.options.layout.dataDir ? readDesktopSettings(initial.options.layout.dataDir) : null
  const saved = workspace ?? savedSettings?.workspace
  const input = saved === undefined ? initial : launcherOptionsFrom({ argv: [`--workspace=${saved}`],
    env: { ...env, LEGION_WORKSPACE_DIR: undefined }, nodePath })
  // Missing operator declarations are a setup step. This checks only absence;
  // the real Launcher still validates all effective policy and readiness later.
  if (input.options.layout.workspaceDir !== null && ['actor', 'scope', 'action'].some(field => {
    const value = input.options.runtimeEnv[ENFORCEMENT_IDENTITY_ENV[field]]
    return typeof value !== 'string' || value.trim() === ''
  })) input.desktopSetupPhase = 'identity'
  else if (input.options.layout.workspaceDir !== null && savedSettings?.model === undefined) input.desktopSetupPhase = 'model'
  input.desktopModelSetup = savedSettings?.model ?? null
  return input
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : fallback
}

function safePhase(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null
}

function publicPortConflict(result) {
  const diagnostic = Array.isArray(result?.diagnostics)
    ? result.diagnostics.find(item => item?.severity === 'error' && item?.code === 'PORT_IN_USE')
    : null
  if (!diagnostic || !Object.hasOwn(DEFAULT_PORTS, diagnostic.process)
    || !Number.isInteger(diagnostic.port) || diagnostic.port < 1 || diagnostic.port > 65535) return null
  return Object.freeze({ process: diagnostic.process, port: diagnostic.port, listening: diagnostic.portListening === true })
}

function publicStatus(status) {
  const processes = Array.isArray(status?.processes) ? status.processes.map((p) => ({
    key: p.key,
    state: p.state,
    required: p.required === true,
    /**
     * 实际端口。
     *
     * ★ 为什么要透出来：升级 helper 的健康检查里有一条**身份断言**
     *   （`expectJson: { port }`），而它的用途正是区分「我们自己的实例」与
     *   「上一次升级前留下的旧实例 / 别的程序占了同一个端口」
     *   （见 `process-manifest.mjs` 的 team-hub 条目）。
     *
     *   拿 `DEFAULT_PORTS` 去代替真实读数，在最坏的情况下会得到一次
     *   **看似通过**的健康检查：旧实例应答了 200，而它的 port 字段恰好
     *   等于默认值。所以健康规格必须用 Launcher 真正用的那一组端口，
     *   而这份读数的唯一来源就是这里（`launcher.status()` 已经带 `port`）。
     *
     * 只透出"够用的形状"：整数、在合法区间内，否则 `null`——而不是把原始值
     * 原样带出去。
     */
    port: Number.isSafeInteger(p.port) && p.port > 0 && p.port <= 65535 ? p.port : null,
  })) : []
  const workbench = status?.processes?.find((p) => p.key === 'workbench' && p.state === 'ready')
  const url = workbench?.url
  return {
    state: status?.state ?? 'unavailable',
    processes,
    workbenchUrl: typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : null,
  }
}

export function createDesktopBridge({
  launcherFactory = options => options.bundledRuntime || options.desktopSetup ? createDesktopLauncher(options) : createLauncher(options),
  optionsFactory = desktopOptionsFrom,
  discover = discoverBackend,
  modelCredentialVerifier = async (input) => {
    try {
      const { openProductSecrets } = await import('../secrets.mjs')
      const opened = await openProductSecrets({ layout: input.options.layout, requireProtected: true })
      if (opened?.ok !== true) return false
      const metadata = await opened.store.describe('model/api-key')
      return metadata?.updatedAt === input.desktopModelSetup?.credentialUpdatedAt
    } catch { return false }
  },
  emit = () => {},
} = {}) {
  let launcher = null
  let running = false
  let ownsLifecycle = false
  let closed = false
  let queue = Promise.resolve()
  let credentials = null
  let bundleRoot = null
  let stopPending = false
  let selected = null
  let detached = false

  function status() {
    return launcher === null ? { state: 'unavailable', processes: [], workbenchUrl: null } : publicStatus(launcher.status())
  }

  async function ensureLauncher({ setup = false } = {}) {
    if (launcher !== null) return launcher
    const input = optionsFactory(selected === null ? {} : { workspace: selected })
    const blocking = [...(input.layoutDiagnostics ?? []), ...(input.configDiagnostics ?? [])]
      .filter((item) => item.severity === 'error')
    if (blocking.length > 0) {
      const error = new Error('Desktop configuration invalid')
      error.code = safeCode(blocking[0].code, 'CONFIG_INVALID')
      throw error
    }
    if (!setup) {
      launcher = await discover(input.options.layout, { timeoutMs: 720_000 })
      if (launcher) return launcher
    }
    if (!setup && input.desktopSetupPhase) {
      throw Object.assign(new Error('First-run setup is incomplete'), {
        code: input.desktopSetupPhase === 'identity' ? 'ENFORCEMENT_IDENTITY_MISSING' : 'MODEL_NOT_CONFIGURED',
      })
    }
    if (!setup && input.desktopModelSetup !== null && input.desktopModelSetup !== undefined) {
      if (!await modelCredentialVerifier(input)) {
        throw Object.assign(new Error('Verified model credential has changed'), { code: 'MODEL_NOT_CONFIGURED' })
      }
    }
    const options = { ...input.options, desktopCredentials: credentials, desktopSetup: setup, sharedBackend: true }
    if (bundleRoot !== null) {
      const release = JSON.parse(readFileSync(join(options.layout.installDir, 'product', 'release', 'runtime-manifest.json'), 'utf8'))
      options.bundledRuntime = { bundleRoot, release }
      options.onPrepareProgress = progress => emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress',
        payload: { phase: progress.phase, completed: progress.completed, total: progress.total } })
      options.baseEnv = { ...options.baseEnv, DSH_HOME: join(options.layout.dataDir, 'runtime', 'dsh', 'home') }
      options.dshCredentialsFile = null
    }
    launcher = launcherFactory(options)
    return launcher
  }

  async function run(request) {
    const { id, type } = request
    if (closed) return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false, payload: { code: 'BRIDGE_CLOSED' } }
    try {
      if (type === 'status') {
        await launcher?.refresh?.()
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
      }
      if (type === 'detach') {
        detached = running
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'detached' } }
      }
      if (type === 'start' || type === 'restart' || type === 'prepare-runtime' || type === 'configure-workspace' || type === 'configure-identity' || type === 'configure-model') {
        if (stopPending) throw Object.assign(new Error('Start superseded by stop'), { code: 'PREPARATION_CANCELLED' })
        const suppliedRoot = request.payload?.bundleRoot
        if (suppliedRoot !== undefined) {
          if (typeof suppliedRoot !== 'string' || suppliedRoot.length > 1024) throw Object.assign(new Error('Bundle path invalid'), { code: 'BUNDLE_PATH_INVALID' })
          if ((bundleRoot !== null || launcher !== null) && bundleRoot !== suppliedRoot) throw Object.assign(new Error('Bundle changed'), { code: 'BUNDLE_PATH_CHANGED' })
          bundleRoot = suppliedRoot
        }
        const token = request.payload?.token
        if (credentials === null) {
          if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
            throw Object.assign(new Error('Desktop credential required'), { code: 'DESKTOP_CREDENTIAL_REQUIRED' })
          }
          credentials = { workbench: token, hub: randomBytes(32).toString('hex') }
        } else if (token !== undefined && token !== credentials.workbench) {
          throw Object.assign(new Error('Desktop credential changed'), { code: 'DESKTOP_CREDENTIAL_CHANGED' })
        }
        if (type === 'configure-workspace') {
          const workspace = selectedWorkspace(request.payload?.workspace)
          if (running) throw Object.assign(new Error('Services running'), { code: 'DESKTOP_SETUP_BUSY' })
          if (launcher !== null && ownsLifecycle) await launcher.stop({ reason: '更换首次设置工作区' })
          ownsLifecycle = false
          launcher = null
          selected = workspace
          const owner = await ensureLauncher({ setup: true })
          ownsLifecycle = true
          const payload = await owner.configureWorkspace()
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload }
        }
        if (type === 'configure-identity') {
          if (running) throw Object.assign(new Error('Services running'), { code: 'DESKTOP_SETUP_BUSY' })
          const identity = validateDesktopIdentity(request.payload?.identity)
          if (launcher !== null && ownsLifecycle) await launcher.stop({ reason: '保存操作者身份设置' })
          ownsLifecycle = false
          launcher = null
          const owner = await ensureLauncher({ setup: true })
          ownsLifecycle = true
          const payload = await owner.configureIdentity(identity)
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload }
        }
        if (type === 'configure-model') {
          if (running) throw Object.assign(new Error('Services running'), { code: 'DESKTOP_SETUP_BUSY' })
          if (launcher !== null && ownsLifecycle) await launcher.stop({ reason: '验证桌面端模型设置' })
          ownsLifecycle = false
          launcher = null
          const owner = await ensureLauncher({ setup: true })
          ownsLifecycle = true
          const payload = await owner.configureModel(request.payload?.model)
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload }
        }
        let owner = await ensureLauncher()
        if (type === 'prepare-runtime') {
          if (typeof owner.prepareRuntime !== 'function') throw Object.assign(new Error('Bundle required'), { code: 'BUNDLE_PATH_REQUIRED' })
          ownsLifecycle = true
          await owner.prepareRuntime()
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'prepared' } }
        }
        if (type === 'restart' && running) {
          if (owner.shared) {
            const result = await owner.restart()
            if (!result.ok) throw Object.assign(new Error('Shared backend restart failed'), { code: 'BACKEND_RESTART_FAILED' })
            return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
          }
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'stopping' } })
          await owner.stop({ reason: '桌面端重启服务' })
          running = false
        }
        if (!running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'starting' } })
          ownsLifecycle = true
          let result
          try { result = await owner.start() }
          catch (error) {
            if (error.code !== 'INSTANCE_ALREADY_RUNNING') throw error
            result = { ok: false, code: error.code }
          }
          if (result.code === 'INSTANCE_ALREADY_RUNNING') {
            await owner.stop({ reason: '连接已运行的共享后台' })
            launcher = null
            owner = await ensureLauncher()
            result = await owner.start()
          }
          if (result.ok !== true) {
            await owner.stop({ reason: '桌面启动失败后清理' })
            ownsLifecycle = false
            const portConflict = publicPortConflict(result)
            return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
              payload: { state: 'failed', code: safeCode(result.code ?? result.failures?.[0]?.code ?? result.diagnostics?.find((d) => d.severity === 'error')?.code, 'START_FAILED'),
                phase: safePhase(result.phase), ...(portConflict ? { portConflict } : {}) } }
          }
          running = true
        }
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
      }
      if (type === 'stop') {
        if (ownsLifecycle && launcher !== null) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'stopping' } })
          await launcher.stop({ reason: '桌面端停止服务' })
          running = false
          ownsLifecycle = false
          launcher = null
        }
        stopPending = false
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'stopped' } }
      }
      // ── 在途任务读数（设计 §7 line 150：安装确认要显示有没有在途任务）──
      //
      // ★ 这是一个**读**命令，所以它不走队列（与 `status` 同样处置）：
      //   它要能被用来回答"现在能不能装"，而排队等一次 start/stop 才能回答
      //   这个问题会让答案在等待期间过期。
      //
      // ★ 读不到时返回 `ok: false` 且**不带** `tasks` 字段。
      //   一个"读不到就返回空数组"的读数会让升级在**任务正在跑**的时候
      //   认为环境是干净的——那是本模块最不能犯的错。
      if (type === 'tasks') {
        if (launcher === null) {
          // ★ Launcher 还没起来 → **不**报"没有在途任务"。
          //
          //   常见的第一反应是返回空数组（"没起来当然没有任务"）。这里不这么做，
          //   因为同一条推理在**别的**情况下会错：`launcher === null` 也可能是
          //   "上一次启动留下了没被收敛的进程，而这次还没接管"。那种情况下
          //   报空数组就是让升级在一个未知环境上动手。
          //
          //   代码与理由分开给出，于是"升级被拦"能查到**拦的原因是什么**——
          //   而一个笼统的"没有拿到任务读数"会把排查方向引向任务本身。
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
            payload: {
              code: 'TASKS_LAUNCHER_NOT_STARTED',
              reason: 'Launcher 未启动，因此读不到在途任务：这不等于没有在途任务（未收敛的旧进程也算）',
            } }
        }
        const reading = await readPendingTasksFromLauncher(launcher.status(), {
          token: credentials?.hub ?? null,
        })
        if (reading.ok !== true) {
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
            payload: { code: safeCode(reading.code, 'TASKS_UNREADABLE'), reason: reading.reason } }
        }
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true,
          payload: {
            tasks: reading.tasks,
            total: reading.total,
            observedAtMs: reading.observedAtMs,
            source: reading.source,
            summary: reading.summary,
          } }
      }
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false, payload: { code: 'UNKNOWN_TYPE' } }
    } catch (error) {
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
        payload: { code: safeCode(error?.code, 'BRIDGE_FAILED') } }
    }
  }

  function handle(request) {
    if (request.type === 'stop') { stopPending = true; launcher?.cancelPreparation?.() }
    // ★ `status` 与 `tasks` 都是**读**命令，不进队列。
    //   `tasks` 要能被用来回答"现在能不能装"；排队等一次 start/stop 才能
    //   回答这个问题，会让答案在等待期间过期——而它正是升级前那一刻要用的。
    if (request.type === 'status' || request.type === 'tasks') return Promise.resolve(run(request))
    const work = queue.then(() => run(request))
    queue = work.catch(() => {})
    return work
  }

  async function close() {
    closed = true
    launcher?.cancelPreparation?.()
    await queue
    if (ownsLifecycle && launcher !== null && !detached && !launcher.shared) {
      await launcher.stop({ reason: '桌面控制通道关闭' })
      running = false
      ownsLifecycle = false
    }
  }

  return { handle, close }
}

export function runDesktopBridge({ input = process.stdin, output = process.stdout, bridgeFactory = createDesktopBridge } = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)
  const bridge = bridgeFactory({ emit: send })
  const inFlight = new Set()
  const decoder = createLineDecoder((line) => {
    const work = (async () => {
      let request
      try {
        if (typeof line !== 'string') throw Object.assign(new Error(line.code), line)
        request = parseRequest(line)
      } catch (error) {
        send({ version: DESKTOP_PROTOCOL_VERSION, id: null, type: 'result', ok: false,
          payload: { code: error.code ?? 'BAD_REQUEST' } })
        return
      }
      if (inFlight.size >= 32) {
        send({ version: DESKTOP_PROTOCOL_VERSION, id: request.id, type: 'result', ok: false, payload: { code: 'BRIDGE_BUSY' } })
        return
      }
      send(await bridge.handle(request))
    })()
    inFlight.add(work)
    void work.finally(() => inFlight.delete(work))
  })
  input.on('data', (chunk) => decoder.push(chunk))
  input.on('end', () => { void bridge.close() })
  return bridge
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) runDesktopBridge()
