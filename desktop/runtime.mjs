import { randomUUID } from 'node:crypto'
import { createLineDecoder } from '../product/launcher/desktop-protocol.mjs'

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

function clientError(code) {
  return Object.assign(new Error(code), { code })
}

export function createBridgeClient(child, { onEvent = () => {} } = {}) {
  const pending = new Map()
  let exited = false
  const failAll = () => {
    if (exited) return
    exited = true
    for (const { reject } of pending.values()) reject(clientError('BRIDGE_EXITED'))
    pending.clear()
  }
  const decoder = createLineDecoder((line) => {
    if (typeof line !== 'string') { failAll(); return }
    let message
    try { message = JSON.parse(line) } catch { failAll(); return }
    if (message?.version !== 1) { failAll(); return }
    if (message.type !== 'result') { onEvent(message); return }
    const slot = pending.get(message.id)
    if (!slot) return
    pending.delete(message.id)
    if (message.ok === true) slot.resolve(message.payload)
    else slot.reject(clientError(message.payload?.code ?? 'BRIDGE_FAILED'))
  })
  child.stdout.on('data', (chunk) => decoder.push(chunk))
  child.on('exit', failAll)
  child.on('error', failAll)
  return {
    request(type, payload = {}) {
      if (exited) return Promise.reject(clientError('BRIDGE_EXITED'))
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ version: 1, id, type, payload })}\n`, (error) => {
          if (error && pending.delete(id)) reject(clientError('BRIDGE_WRITE_FAILED'))
        })
      })
    },
    async close() {
      if (exited) return
      child.stdin.end()
    },
  }
}
