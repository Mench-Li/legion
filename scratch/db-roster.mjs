import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true })
const rows = db.prepare("SELECT id, scope, role, soldier, status FROM tasks WHERE scope != 'software' ORDER BY scope, id LIMIT 14").all()
for (const r of rows) console.log(`${r.id} scope=${r.scope} role=${r.role} soldier=${r.soldier} status=${r.status}`)
db.close()
