import { randomUUID } from 'node:crypto'
import { createLineDecoder, MAX_LINE_BYTES, parseRequest } from '../product/launcher/desktop-protocol.mjs'

export function workbenchTarget(payload) {
  if (payload?.state !== 'ready' && payload?.state !== 'degraded') return null
  const value = payload.workbenchUrl
  return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(value) ? value : null
}

export function canNavigate(target, { startup, origin }) {
  if (target === startup) return true
  if (!origin) return false
  try {
    const url = new URL(target)
    return url.protocol === 'http:' && url.origin === origin && url.username === '' && url.password === ''
  } catch { return false }
}

export function externalUrl(target) {
  try {
    const url = new URL(target)
    if (url.protocol === 'https:' && url.username === '' && url.password === '') return target
    if (url.protocol === 'mailto:' && url.pathname !== '') return target
  } catch {}
  return null
}

export function closeAction({ quitting, closeToTray }) {
  return !quitting && closeToTray ? 'hide' : 'close'
}

export function desktopRequestHeaders(details, { origin, token, webContentsId }) {
  const headers = { ...details.requestHeaders }
  if (!origin || !token || details.webContentsId !== webContentsId || details.frame?.parent !== null
    || details.resourceType === 'subFrame' || !canNavigate(details.url, { origin })) return headers
  if (details.resourceType !== 'mainFrame' && !canNavigate(details.frame.url, { origin })) return headers
  const suppliedOrigin = Object.entries(headers).find(([key]) => key.toLowerCase() === 'origin')?.[1]
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) return headers
  for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]
  headers.Authorization = `Bearer ${token}`
  return headers
}

function clientError(code) {
  return Object.assign(new Error(code), { code })
}

export const BRIDGE_DEADLINES = Object.freeze({ status: 10_000, start: 720_000, restart: 780_000, stop: 90_000, 'prepare-runtime': 600_000, 'configure-workspace': 30_000 })

export function createBridgeClient(child, {
  onEvent = () => {}, deadlines = BRIDGE_DEADLINES, maxPending = 16, exitTimeoutMs = 15_000,
} = {}) {
  const pending = new Map()
  let exited = false
  let closing = false
  let failure = null
  let exitFailure = null
  let observeExit
  const actualExit = new Promise(resolve => { observeExit = resolve })
  const failAll = (code) => {
    failure ??= code
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(clientError(code))
    }
    pending.clear()
  }
  const decoder = createLineDecoder((line) => {
    if (failure) return
    if (typeof line !== 'string') { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    let message
    try { message = JSON.parse(line) } catch { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    if (message?.version !== 1) { failAll('BRIDGE_PROTOCOL_ERROR'); return }
    if (message.type !== 'result') { onEvent(message); return }
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    clearTimeout(slot.timer)
    if (message.ok === true) slot.resolve(message.payload)
    else slot.reject(clientError(message.payload?.code ?? 'BRIDGE_FAILED'))
  })
  child.stdout.on('data', (chunk) => decoder.push(chunk))
  child.on('exit', (code, signal) => {
    exited = true
    if (code !== 0 || signal) exitFailure = 'BRIDGE_EXIT_FAILED'
    failAll('BRIDGE_EXITED')
    observeExit()
  })
  child.on('error', () => {
    failAll('BRIDGE_EXITED')
    // A failed spawn has no process whose exit we can observe.
    if (!child.pid) { exited = true; exitFailure = 'BRIDGE_EXIT_FAILED'; observeExit() }
  })
  child.stdin.on('error', () => failAll('BRIDGE_WRITE_FAILED'))
  return {
    request(type, payload = {}) {
      if (closing) return Promise.reject(clientError('BRIDGE_CLOSING'))
      if (failure) return Promise.reject(clientError(failure))
      if (pending.size >= maxPending) return Promise.reject(clientError('BRIDGE_BUSY'))
      const id = randomUUID()
      let wire
      try {
        wire = `${JSON.stringify({ version: 1, id, type, payload })}\n`
        if (Buffer.byteLength(wire) - 1 > MAX_LINE_BYTES) throw clientError('LINE_TOO_LARGE')
        parseRequest(wire)
      } catch (error) { return Promise.reject(clientError(error.code ?? 'BAD_PAYLOAD')) }
      return new Promise((resolve, reject) => {
        const timeoutMs = deadlines[type] ?? BRIDGE_DEADLINES[type]
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(clientError('BRIDGE_TIMEOUT'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        const writeFailed = () => {
          clearTimeout(timer)
          if (pending.delete(id)) reject(clientError('BRIDGE_WRITE_FAILED'))
        }
        try { child.stdin.write(wire, error => { if (error) writeFailed() }) } catch { writeFailed() }
      })
    },
    async close() {
      if (!closing) {
        closing = true
        if (!exited) child.stdin.end()
      }
      let timer
      try {
        await Promise.race([actualExit, new Promise((_, reject) => {
          timer = setTimeout(() => reject(clientError('BRIDGE_EXIT_TIMEOUT')), exitTimeoutMs)
        })])
        if (exitFailure) throw clientError(exitFailure)
      } finally { clearTimeout(timer) }
    },
  }
}
