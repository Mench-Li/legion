import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkDesktopRequest } from '../local-auth.mjs'
import { instanceLockPath, parseLock, processAlive } from './single-instance.mjs'

export const BACKEND_PROTOCOL = 1
export const BACKEND_FILENAME = 'legion-backend.json'
const fail = code => Object.assign(new Error(code), { code })
const canonical = path => {
  if (!path) return null
  const value = realpathSync(resolve(path))
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function identity(layout) {
  const manifest = JSON.parse(readFileSync(join(layout.installDir, 'product/release/runtime-manifest.json'), 'utf8'))
  if (typeof manifest.productVersion !== 'string' || typeof manifest.dshVersion !== 'string') throw fail('BACKEND_VERSION_INVALID')
  return { dataDir: canonical(layout.dataDir), workspace: canonical(layout.workspaceDir),
    version: manifest.productVersion, runtimeVersion: manifest.dshVersion }
}

// Only the DataDir lock owner may publish. The discovery file is never sufficient
// by itself: clients also verify the live lock owner and an authenticated response.
export async function publishBackend({ layout, status, stop, restart }) {
  const id = identity(layout)
  const lock = parseLock(readFileSync(instanceLockPath(layout.dataDir), 'utf8'))
  if (lock?.pid !== process.pid) throw fail('BACKEND_NOT_OWNER')
  const token = randomBytes(32).toString('hex')
  const file = join(layout.dataDir, BACKEND_FILENAME)
  let mutations = Promise.resolve()
  const mutate = action => {
    const work = mutations.then(action)
    mutations = work.catch(() => {})
    return work
  }
  const server = createServer(async (req, res) => {
    const rejected = checkDesktopRequest(req, token)
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (rejected) { reply(rejected.status, { code: rejected.code }); return }
    if (req.method === 'GET' && req.url === '/status') {
      reply(200, { protocol: BACKEND_PROTOCOL, ...id, pid: process.pid, startedAt: lock.startedAt, status: status() })
    } else if (req.method === 'POST' && req.url === '/restart' && restart) {
      try { reply(200, await mutate(restart)) }
      catch { reply(500, { code: 'BACKEND_RESTART_FAILED' }) }
    } else if (req.method === 'POST' && req.url === '/stop') {
      try { const outcome = await mutate(stop); reply(200, { ok: true, results: outcome.results ?? [] }) }
      catch { reply(500, { code: 'STOP_FAILED' }) }
    } else reply(404, { code: 'BACKEND_ROUTE_UNKNOWN' })
  })
  server.requestTimeout = 10_000
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const record = { protocol: BACKEND_PROTOCOL, ...id, pid: process.pid, startedAt: lock.startedAt,
    url: `http://127.0.0.1:${server.address().port}`, token }
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) { server.close(); try { unlinkSync(temporary) } catch {} ; throw error }
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      try {
        const current = JSON.parse(readFileSync(file, 'utf8'))
        if (current.token === token) unlinkSync(file)
      } catch {}
      // Do not await close from the /stop handler: its response must finish first.
      server.close()
      server.closeIdleConnections()
    },
  }
}

export async function discoverBackend(layout, { timeoutMs = 0, intervalMs = 100, fetchImpl = fetch,
  alive = processAlive, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!layout?.dataDir) return null
  const deadline = Date.now() + timeoutMs
  let expected = null
  for (;;) {
    let lock
    try { lock = parseLock(readFileSync(instanceLockPath(layout.dataDir), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw fail('BACKEND_DISCOVERY_INVALID') }
    if (!lock) throw fail('BACKEND_DISCOVERY_INVALID')
    if (alive(lock.pid) !== true) return null
    let record
    try { record = JSON.parse(readFileSync(join(layout.dataDir, BACKEND_FILENAME), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw fail('BACKEND_DISCOVERY_INVALID') }
    // A previous owner's descriptor is ignored while the new owner starts.
    if (record && record.pid === lock.pid && record.startedAt === lock.startedAt) {
      expected ??= identity(layout)
      if (expected.workspace === null) expected.workspace = record.workspace
      if (record.protocol !== BACKEND_PROTOCOL || record.dataDir !== expected.dataDir
        || record.workspace !== expected.workspace) throw fail('BACKEND_WORKSPACE_MISMATCH')
      if (record.version !== expected.version || record.runtimeVersion !== expected.runtimeVersion) {
        throw fail('BACKEND_VERSION_MISMATCH')
      }
      if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(record.url)
        || Number(new URL(record.url).port) > 65535 || !/^[a-f0-9]{64}$/.test(record.token)) {
        throw fail('BACKEND_DISCOVERY_INVALID')
      }
      const request = async (path, method = 'GET') => {
        const response = await fetchImpl(`${record.url}${path}`, { method,
          headers: { authorization: `Bearer ${record.token}` }, redirect: 'error',
          signal: AbortSignal.timeout(path === '/restart' ? 780_000 : method === 'POST' ? 90_000 : 5_000) })
        if (!response.ok) throw fail('BACKEND_UNAVAILABLE')
        return response.json()
      }
      let snapshot
      try { snapshot = await request('/status') }
      catch { if (Date.now() >= deadline) throw fail('BACKEND_UNAVAILABLE') }
      if (snapshot) {
        if (snapshot.protocol !== BACKEND_PROTOCOL || snapshot.pid !== lock.pid
          || snapshot.startedAt !== lock.startedAt || Object.keys(expected).some(k => snapshot[k] !== expected[k])) {
          throw fail('BACKEND_IDENTITY_MISMATCH')
        }
        let current = snapshot.status
        let replacement = null
        return {
          shared: true,
          async start() { await this.refresh(); return { ok: true, phase: null, failures: [], diagnostics: [], states: current.processes } },
          status() { return current },
          async refresh() { current = replacement ? await replacement.refresh() : (await request('/status')).status; return current },
          async restart() {
            if (replacement) {
              const result = await replacement.restart()
              current = replacement.status()
              return result
            }
            const result = await request('/restart', 'POST')
            if (result.ok) {
              replacement = await discoverBackend(layout, { timeoutMs: 720_000 })
              if (!replacement) throw fail('BACKEND_UNAVAILABLE')
              current = replacement.status()
            }
            return result
          },
          async stop() { const result = replacement ? await replacement.stop() : await request('/stop', 'POST'); current = { state: 'unavailable', processes: [] }; return result },
          allDiagnostics() { return [] },
        }
      }
    }
    if (Date.now() >= deadline) throw fail('BACKEND_STARTING')
    await sleep(intervalMs)
  }
}
