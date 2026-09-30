#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createLauncher } from './launcher.mjs'
import { launcherOptionsFrom } from './cli.mjs'
import { createLineDecoder, DESKTOP_PROTOCOL_VERSION, parseRequest } from './desktop-protocol.mjs'

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
  launcherFactory = createLauncher,
  optionsFactory = () => launcherOptionsFrom({ env: process.env, nodePath: process.execPath }),
  emit = () => {},
} = {}) {
  let launcher = null
  let running = false
  let closed = false
  let queue = Promise.resolve()
  let credentials = null

  function status() {
    return launcher === null ? { state: 'unavailable', processes: [], workbenchUrl: null } : publicStatus(launcher.status())
  }

  function ensureLauncher() {
    if (launcher !== null) return launcher
    const input = optionsFactory()
    const blocking = [...(input.layoutDiagnostics ?? []), ...(input.configDiagnostics ?? [])]
      .filter((item) => item.severity === 'error')
    if (blocking.length > 0) {
      const error = new Error('Desktop configuration invalid')
      error.code = safeCode(blocking[0].code, 'CONFIG_INVALID')
      throw error
    }
    launcher = launcherFactory({ ...input.options, desktopCredentials: credentials })
    return launcher
  }

  async function run(request) {
    const { id, type } = request
    if (closed) return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false, payload: { code: 'BRIDGE_CLOSED' } }
    try {
      if (type === 'status') return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
      if (type === 'start' || type === 'restart') {
        const token = request.payload?.token
        if (credentials === null) {
          if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
            throw Object.assign(new Error('Desktop credential required'), { code: 'DESKTOP_CREDENTIAL_REQUIRED' })
          }
          credentials = { workbench: token, hub: randomBytes(32).toString('hex') }
        } else if (token !== undefined && token !== credentials.workbench) {
          throw Object.assign(new Error('Desktop credential changed'), { code: 'DESKTOP_CREDENTIAL_CHANGED' })
        }
        const owner = ensureLauncher()
        if (type === 'restart' && running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'stopping' } })
          await owner.stop({ reason: '桌面端重启服务' })
          running = false
        }
        if (!running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'starting' } })
          const result = await owner.start()
          if (result.ok !== true) {
            return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
              payload: { state: 'failed', code: safeCode(result.code ?? result.failures?.[0]?.code ?? result.diagnostics?.find((d) => d.severity === 'error')?.code, 'START_FAILED'), phase: safePhase(result.phase) } }
          }
          running = true
        }
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: status() }
      }
      if (type === 'stop') {
        if (running) {
          emit({ version: DESKTOP_PROTOCOL_VERSION, type: 'progress', payload: { phase: 'stopping' } })
          await launcher.stop({ reason: '桌面端停止服务' })
          running = false
        }
        return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: true, payload: { state: 'stopped' } }
      }
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false, payload: { code: 'UNKNOWN_TYPE' } }
    } catch (error) {
      return { version: DESKTOP_PROTOCOL_VERSION, id, type: 'result', ok: false,
        payload: { code: safeCode(error?.code, 'BRIDGE_FAILED') } }
    }
  }

  function handle(request) {
    const work = queue.then(() => run(request))
    queue = work.catch(() => {})
    return work
  }

  async function close() {
    await queue
    if (closed) return
    closed = true
    if (running && launcher !== null) {
      await launcher.stop({ reason: '桌面控制通道关闭' })
      running = false
    }
  }

  return { handle, close }
}

export function runDesktopBridge({ input = process.stdin, output = process.stdout, bridgeFactory = createDesktopBridge } = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`)
  const bridge = bridgeFactory({ emit: send })
  let queue = Promise.resolve()
  const decoder = createLineDecoder((line) => {
    queue = queue.then(async () => {
      let request
      try {
        if (typeof line !== 'string') throw Object.assign(new Error(line.code), line)
        request = parseRequest(line)
      } catch (error) {
        send({ version: DESKTOP_PROTOCOL_VERSION, id: null, type: 'result', ok: false,
          payload: { code: error.code ?? 'BAD_REQUEST' } })
        return
      }
      send(await bridge.handle(request))
    })
  })
  input.on('data', (chunk) => decoder.push(chunk))
  input.on('end', () => { void queue.then(() => bridge.close()) })
  return bridge
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDesktopBridge()
