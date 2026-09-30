#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDesktopLauncher } from './desktop-launcher.mjs'
import { createLauncher } from './launcher.mjs'
import { launcherOptionsFrom } from './cli.mjs'
import { createLineDecoder, DESKTOP_PROTOCOL_VERSION, parseRequest } from './desktop-protocol.mjs'
import { readDesktopSettings, selectedWorkspace, validateDesktopIdentity } from './desktop-settings.mjs'
import { ENFORCEMENT_IDENTITY_ENV } from './enforcement-identity.mjs'

export function desktopOptionsFrom({ workspace, env = process.env, nodePath = process.execPath } = {}) {
  const initial = launcherOptionsFrom({ env, nodePath })
  const saved = workspace ?? (initial.options.layout.dataDir ? readDesktopSettings(initial.options.layout.dataDir)?.workspace : undefined)
  const input = saved === undefined ? initial : launcherOptionsFrom({ argv: [`--workspace=${saved}`],
    env: { ...env, LEGION_WORKSPACE_DIR: undefined }, nodePath })
  // Missing operator declarations are a setup step. This checks only absence;
  // the real Launcher still validates all effective policy and readiness later.
  if (input.options.layout.workspaceDir !== null && ['actor', 'scope', 'action'].some(field => {
    const value = input.options.runtimeEnv[ENFORCEMENT_IDENTITY_ENV[field]]
    return typeof value !== 'string' || value.trim() === ''
  })) input.desktopSetupPhase = 'identity'
  else if (input.options.layout.workspaceDir !== null) input.desktopSetupPhase = 'model'
  return input
}

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : fallback
}

function safePhase(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null
}

function publicStatus(status) {
  const processes = Array.isArray(status?.processes) ? status.processes.map((p) => ({
    key: p.key, state: p.state, required: p.required === true,
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

  function status() {
    return launcher === null ? { state: 'unavailable', processes: [], workbenchUrl: null } : publicStatus(launcher.status())
  }

  function ensureLauncher({ setup = false } = {}) {
    if (launcher !== null) return launcher
    const input = optionsFactory(selected === null ? {} : { workspace: selected })
    const blocking = [...(input.layoutDiagnostics ?? []), ...(input.configDiagnostics ?? [])]
      .filter((item) => item.severity === 'error')
    if (blocking.length > 0) {
      const error = new Error('Desktop configuration invalid')
      error.code = safeCode(blocking[0].code, 'CONFIG_INVALID')
      throw error
    }
    if (!setup && input.desktopSetupPhase) {
      throw Object.assign(new Error('First-run setup is incomplete'), {
        code: input.desktopSetupPhase === 'identity' ? 'ENFORCEMENT_IDENTITY_MISSING' : 'MODEL_NOT_CONFIGURED',
      })
    }
    const options = { ...input.options, desktopCredentials: credentials, desktopSetup: setup }
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
      if (type === 'status') return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
      if (type === 'start' || type === 'restart' || type === 'prepare-runtime' || type === 'configure-workspace' || type === 'configure-identity') {
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
          const owner = ensureLauncher({ setup: true })
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
          const owner = ensureLauncher({ setup: true })
          ownsLifecycle = true
          const payload = await owner.configureIdentity(identity)
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload }
        }
        const owner = ensureLauncher()
        if (type === 'prepare-runtime') {
          if (typeof owner.prepareRuntime !== 'function') throw Object.assign(new Error('Bundle required'), { code: 'BUNDLE_PATH_REQUIRED' })
          ownsLifecycle = true
          await owner.prepareRuntime()
          return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'prepared' } }
        }
        if (type === 'restart' && running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'stopping' } })
          await owner.stop({ reason: '桌面端重启服务' })
          running = false
        }
        if (!running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'starting' } })
          ownsLifecycle = true
          const result = await owner.start()
          if (result.ok !== true) {
            await owner.stop({ reason: '桌面启动失败后清理' })
            ownsLifecycle = false
            return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
              payload: { state: 'failed', code: safeCode(result.code ?? result.failures?.[0]?.code ?? result.diagnostics?.find((d) => d.severity === 'error')?.code, 'START_FAILED'), phase: safePhase(result.phase) } }
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
        }
        stopPending = false
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'stopped' } }
      }
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false, payload: { code: 'UNKNOWN_TYPE' } }
    } catch (error) {
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
        payload: { code: safeCode(error?.code, 'BRIDGE_FAILED') } }
    }
  }

  function handle(request) {
    if (request.type === 'stop') { stopPending = true; launcher?.cancelPreparation?.() }
    if (request.type === 'status') return Promise.resolve(run(request))
    const work = queue.then(() => run(request))
    queue = work.catch(() => {})
    return work
  }

  async function close() {
    closed = true
    launcher?.cancelPreparation?.()
    await queue
    if (ownsLifecycle && launcher !== null) {
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
