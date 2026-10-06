// 逐字复跑 planTimeoutTransitionFailure 文案里的两步恢复命令（步骤②按文案原样，不带 scope）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'legion-t192-failpath-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const hub = await import('../team-hub/server.mjs')
await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + hub.server.address().port
const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
const st = (id) => hub.db.prepare("SELECT state FROM write_reservations WHERE task_id=? ORDER BY id DESC LIMIT 1").get(id)?.state
try {
  hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)').run('T-fail', 'T-fail', 'todo', 'default', 0)
  await post('/api/tasks/T-fail/write-intent', { by: 'planner', scope: 'default', paths: ['src/f.mjs'] })
  await post('/api/claim', { id: 'T-fail', by: 'worker', scope: 'default' })
  console.log('BEFORE task=' + hub.db.prepare("SELECT status FROM tasks WHERE id='T-fail'").get().status + ' res=' + st('T-fail'))
  // 文案步骤①（逐字，含 scope）
  const s1 = await post('/api/transition', { id: 'T-fail', to: 'todo', by: 'general', scope: 'default' })
  console.log('STEP1(文案原样)=' + s1.status + ' task=' + hub.db.prepare("SELECT status FROM tasks WHERE id='T-fail'").get().status + ' res=' + st('T-fail'))
  // 文案步骤②（逐字，无 scope）
  const s2 = await post('/api/tasks/T-fail/reservation/confirm-stopped', { by: 'general', confirm: 'stopped:T-fail' })
  console.log('STEP2(文案原样,无scope)=' + s2.status + ' ' + JSON.stringify(s2.body))
  // 补 scope 后才通
  const s3 = await post('/api/tasks/T-fail/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-fail' })
  console.log('STEP2(补scope)=' + s3.status + ' res=' + st('T-fail'))
  console.log('RECLAIM=' + (await post('/api/claim', { id: 'T-fail', by: 'worker', scope: 'default' })).status)
} finally { hub.server.closeAllConnections?.(); hub.server.close(); hub.db.close(); rmSync(dir, { recursive: true, force: true }) }
