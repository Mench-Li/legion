// T-192 追加验收探针（v2）：逐字检验两个分支文案里给出的恢复命令是否真的可执行，
// 并独立复核三条判据（能证实→释放；不能证实/对照→冻结；非执行者→403 回滚）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-t192-hold2-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const hub = await import('../team-hub/server.mjs')
await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + hub.server.address().port
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const st = (id) => ({
  task: hub.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,
  reservation: hub.db.prepare("SELECT state FROM write_reservations WHERE task_id=? ORDER BY id DESC LIMIT 1").get(id)?.state ?? null,
})
const ins = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)')
const seedClaim = async (id, file) => {
  ins.run(id, id, 'todo', 'default', 0)
  await post('/api/tasks/' + id + '/write-intent', { by: 'planner', scope: 'default', paths: [file] })
  const c = await post('/api/claim', { id, by: 'worker', scope: 'default' })
  return c.status
}
try {
  // ── A. hold 分支现场：评论给的命令，逐字（无 scope）与补上 scope 两种 ──
  console.log('A_claim=' + await seedClaim('T-hold-a', 'src/a.mjs'))
  console.log('A_BEFORE=' + JSON.stringify(st('T-hold-a')))
  const a1 = await post('/api/tasks/T-hold-a/reservation/confirm-stopped', { by: 'general', confirm: 'stopped:T-hold-a' })
  console.log('A_评论原样(无scope)=' + a1.status + ' ' + JSON.stringify(a1.body))
  const a2 = await post('/api/tasks/T-hold-a/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-hold-a' })
  console.log('A_补scope=' + a2.status + ' ' + JSON.stringify(a2.body))
  console.log('A_AFTER=' + JSON.stringify(st('T-hold-a')))

  // ── B. 两步人工恢复（补齐 scope 后）是否真能解锁 ──
  const b1 = await post('/api/transition', { id: 'T-hold-a', to: 'todo', by: 'general', scope: 'default' })
  console.log('B_step1=' + b1.status + ' ' + JSON.stringify(st('T-hold-a')))
  const b2 = await post('/api/tasks/T-hold-a/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-hold-a' })
  console.log('B_step2=' + b2.status + ' ' + JSON.stringify(st('T-hold-a')))
  const b3 = await post('/api/claim', { id: 'T-hold-a', by: 'worker', scope: 'default' })
  console.log('B_reclaim=' + b3.status)

  // ── C. 诚实出口：by=执行者本人 + confirmedStopped=true ⇒ 释放 + todo + 立刻可认领 ──
  console.log('C_claim=' + await seedClaim('T-rel', 'src/c.mjs'))
  const c1 = await post('/api/transition', { id: 'T-rel', to: 'todo', by: 'worker', scope: 'default', confirmedStopped: true })
  console.log('C_release=' + c1.status + ' ' + JSON.stringify(st('T-rel')))
  const c2 = await post('/api/claim', { id: 'T-rel', by: 'worker', scope: 'default' })
  console.log('C_reclaim=' + c2.status)

  // ── D. 对照：普通 in_progress→todo（confirmedStopped=false）仍冻结 ──
  console.log('D_claim=' + await seedClaim('T-freeze', 'src/d.mjs'))
  const d1 = await post('/api/transition', { id: 'T-freeze', to: 'todo', by: 'worker', scope: 'default' })
  console.log('D_transition=' + d1.status + ' ' + JSON.stringify(st('T-freeze')))
  const d2 = await post('/api/claim', { id: 'T-freeze', by: 'worker', scope: 'default' })
  console.log('D_reclaim=' + d2.status + ' ' + JSON.stringify(d2.body))

  // ── E. 非执行者拿 confirmedStopped=true 声明 ⇒ 403 且整事务回滚 ──
  console.log('E_claim=' + await seedClaim('T-imposter', 'src/e.mjs'))
  const e1 = await post('/api/transition', { id: 'T-imposter', to: 'todo', by: 'general', scope: 'default', confirmedStopped: true })
  console.log('E_imposter=' + e1.status + ' ' + JSON.stringify(e1.body))
  console.log('E_AFTER=' + JSON.stringify(st('T-imposter')))
} finally {
  hub.server.closeAllConnections?.(); hub.server.close(); hub.db.close(); rmSync(dir, { recursive: true, force: true })
}
