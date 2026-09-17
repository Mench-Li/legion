
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('D:\\project\\DSH\\legion\\.legion-worktrees\\T-117\\scratch\\t117-r2\\mig-sim.db')
db.exec('DROP TABLE IF EXISTS tasks'); db.exec('DROP TABLE IF EXISTS goal')
// legacy shape: pre-RC2 (no docSync column anywhere)
db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT \'backlog\', scope TEXT DEFAULT \'default\', role TEXT)')
db.exec('CREATE TABLE goal (id TEXT PRIMARY KEY, scope TEXT, objective TEXT, status TEXT, version INTEGER DEFAULT 1, mode TEXT DEFAULT \'chain\', docsDir TEXT)')
db.prepare('INSERT INTO tasks (id, title, role) VALUES (?,?,?)').run('T-LEGACY','老库遗留任务','coder')
db.prepare('INSERT INTO goal (id, scope, objective) VALUES (?,?,?)').run('G-LEGACY','software','老库遗留目标')
// ensureColumn equivalent (as server.mjs:348-351)
for (const [t,c,ddl] of [['goal','docSync','docSync INTEGER DEFAULT 0'],['tasks','docSync','docSync INTEGER DEFAULT 0']]) {
  const cols = db.prepare('PRAGMA table_info(' + t + ')').all()
  if (!cols.some(x => x.name === c)) db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + ddl)
}
const t0 = db.prepare('SELECT docSync FROM tasks WHERE id = ?').get('T-LEGACY')
const g0 = db.prepare('SELECT docSync FROM goal WHERE id = ?').get('G-LEGACY')
console.log('legacy tasks row docSync =', t0.docSync, '| legacy goal row docSync =', g0.docSync)
db.prepare('INSERT INTO tasks (id, title, role, docSync) VALUES (?,?,?,1)').run('T-NEW','新 docSync 任务','coder')
db.prepare('INSERT INTO goal (id, scope, objective, docSync) VALUES (?,?,?,1)').run('G-NEW','software','新 docSync 目标')
console.log('new insert docSync readback =', db.prepare('SELECT docSync FROM tasks WHERE id = ?').get('T-NEW').docSync, db.prepare('SELECT docSync FROM goal WHERE id = ?').get('G-NEW').docSync)
db.close()
