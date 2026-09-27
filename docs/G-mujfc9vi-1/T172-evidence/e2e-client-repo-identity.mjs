// T-172 证据：写意图路由是否信任客户端自造的 repoId/targetRef（设计 §4/§8、I-8）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-t172-repo-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../../../team-hub/server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const db = mod.db
db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)').run('T-x', 'X', 'todo', 'default', 0)
const res = await fetch(base + '/api/tasks/T-x/write-intent', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ by: 'planner', scope: 'default', repoId: 'attacker-pool', paths: ['src/a.mjs'], targetRef: 'refs/heads/evil' }),
})
const body = await res.json()
console.log('write-intent {repoId:attacker-pool, targetRef:refs/heads/evil} →', res.status, JSON.stringify(body).slice(0, 260))
console.log('VERDICT: 客户端自造身份是否被接受 =', body?.intent?.repoId === 'attacker-pool' && body?.intent?.targetRef === 'refs/heads/evil')
try { mod.server.closeAllConnections?.() } catch {}
try { mod.server.close() } catch {}
try { db.close?.() } catch {}
rmSync(dir, { recursive: true, force: true })
