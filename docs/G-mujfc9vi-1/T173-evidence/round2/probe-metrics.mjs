// 诊断：S4 指标 TC-S4-12/13 在 main@3f1fce2e 上转红的原因（只读诊断，不改被测代码）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-probe-metrics-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
import { pathToFileURL } from 'node:url'
const serverPath = process.argv[2]
const mod = await import(pathToFileURL(serverPath).href)
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + mod.server.address().port
const ins = mod.db.prepare("INSERT INTO tasks (id, title, status, scope, fixCount) VALUES (?,?,?,?,?)")
ins.run('T-m1', 'm1', 'todo', 'default', 0)
ins.run('T-m2', 'm2', 'todo', 'default', 0)

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), agent: false })
  const text = await res.text()
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(method, path, '->', res.status, JSON.stringify(parsed).slice(0, 300))
  return { status: res.status, body: parsed }
}

await call('POST', '/api/tasks/T-m1/reservation', { by: 'w', scope: 'default', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
await call('POST', '/api/tasks/T-m2/reservation', { by: 'w', scope: 'default', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
await call('POST', '/api/tasks/T-m1/reservation/release', { by: 'w', scope: 'default', attemptId: 'a1', epoch: 1 })
await call('POST', '/api/tasks/T-m2/reservation', { by: 'w', scope: 'default', attemptId: 'a2', epoch: 1, paths: ['src/a.mjs'] })
const r = await call('GET', '/api/metrics/repository?repoId=scope%3Adefault')
console.log('sameFileWriteBlocked =', JSON.stringify(r.body?.metrics?.sameFileWriteBlocked))
console.log('events =', JSON.stringify(mod.db.prepare('SELECT kind, COUNT(*) AS n FROM write_intent_events GROUP BY kind').all()))
mod.server.closeAllConnections?.(); mod.server.close?.(); mod.db?.close?.(); rmSync(dir, { recursive: true, force: true })
