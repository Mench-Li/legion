// T-172 证据：真实启动隔离 hub，端到端验证「守护 claim 是否授予写入预约」（E2E-1 核心）。
// 期望（设计 §5.1 / TC-S2-02 / E2E-1）：T-b 与 T-a 预约了同一文件 src/a.mjs，
// claim T-b 应保持 todo/waiting-file、返回结构化 FILE_CONTENTION、不产生预约、不消耗重试。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-t172-e2e-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../../../team-hub/server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + mod.server.address().port
const db = mod.db
const ins = db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)')
ins.run('T-a', 'A', 'todo', 'default', 0)
ins.run('T-b', 'B', 'todo', 'default', 0)

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

const i1 = await call('POST', '/api/tasks/T-a/write-intent', { by: 'planner', scope: 'default', paths: ['src/a.mjs'], targetRef: 'refs/heads/main' })
const i2 = await call('POST', '/api/tasks/T-b/write-intent', { by: 'planner', scope: 'default', paths: ['src/a.mjs'], targetRef: 'refs/heads/main' })
console.log('intent A:', i1.status, '| intent B:', i2.status)
const r1 = await call('POST', '/api/tasks/T-a/reservation', { by: 'worker', scope: 'default', attemptId: 'a1', epoch: 1, paths: ['src/a.mjs'] })
console.log('reserve A (生产路由):', r1.status, JSON.stringify(r1.body).slice(0, 220))
const c = await call('POST', '/api/claim', { id: 'T-b', by: 'worker', soldier: 'T-b-worker' })
console.log('claim B (守护真实入口 POST /api/claim):', c.status, JSON.stringify(c.body).slice(0, 160))
const row = db.prepare("SELECT status, scheduling_state AS s FROM tasks WHERE id='T-b'").get()
const resvB = db.prepare("SELECT count(*) AS n FROM write_reservations WHERE task_id='T-b'").get()
console.log('T-b task row:', JSON.stringify(row))
console.log('T-b reservation count:', JSON.stringify(resvB))
console.log('E2E-1 VERDICT: claim 后 T-b 是否被授予预约 =', resvB.n > 0, '| status =', row.status, '| scheduling_state =', row.s)
try { mod.server.closeAllConnections?.() } catch {}
try { mod.server.close() } catch {}
try { db.close?.() } catch {}
rmSync(dir, { recursive: true, force: true })
