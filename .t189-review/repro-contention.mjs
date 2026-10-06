import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRunStore } from '../team-hub/run-store.mjs'
import { ensureContextSchema } from '../team-hub/context-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-t189-repro-'))
const db = new DatabaseSync(join(dir, 'team.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
  soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
  createdAt TEXT, updatedAt TEXT, fileDomain TEXT
)`)
ensureContextSchema(db)
const store = createRunStore({ db, clock: () => 1_700_000_000_000 })
const ins = (id, fd) => db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt, fileDomain) VALUES (?,?,?,?,?,0,?,?,?)')
  .run(id, id, 'medium', 'todo', 'software', '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.000Z', fd)

function claimOnce(w, id, fd) { ins(id, fd); const r = store.claim({ workerId: w }); return r }

// A：不申报 fileDomain（= 整仓独占）
const a = claimOnce('w-a', 'T-A', null)
console.log('A claimed:', a.claimed ? a.claimed.attemptId : null, 'reason:', a.reason ?? '-')

// B：也不申报 —— 应被 A 的整仓独占挡住
const b = claimOnce('w-b', 'T-B', null)
console.log('B claimed:', b.claimed ? b.claimed.attemptId : null, 'reason:', b.reason ?? '-', 'contention:', b.contention?.code ?? '-')

// 清掉预约（夹具的做法）后再领 B
db.prepare("UPDATE write_reservations SET state = 'released', updated_at_ms = ? WHERE state IN ('reserved','reconciling')").run(Date.now())
const b2 = store.claim({ workerId: 'w-b2' })
console.log('B after release:', b2.claimed ? b2.claimed.attemptId : null, 'reason:', b2.reason ?? '-')

// 两棵都申报**互不相交**的 fileDomain —— 不应互相挡
const c = claimOnce('w-c', 'T-C', JSON.stringify(['ev/c']))
console.log('C (ev/c) claimed:', c.claimed ? c.claimed.attemptId : null, 'reason:', c.reason ?? '-')
const d = claimOnce('w-d', 'T-D', JSON.stringify(['ev/d']))
console.log('D (ev/d) claimed:', d.claimed ? d.claimed.attemptId : null, 'reason:', d.reason ?? '-')

db.close(); try { rmSync(dir, { recursive: true, force: true }) } catch {}
