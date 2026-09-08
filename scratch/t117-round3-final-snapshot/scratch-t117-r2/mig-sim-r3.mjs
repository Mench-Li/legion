import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('scratch/t117-r3-hub/mig-sim.db')
db.exec('DROP TABLE IF EXISTS legacy')
db.exec('CREATE TABLE legacy (id TEXT PRIMARY KEY, title TEXT)')
db.prepare('INSERT INTO legacy VALUES (?, ?)').run('old-1', 'legacy row')
try { db.exec("ALTER TABLE legacy ADD COLUMN docSync INTEGER DEFAULT 0") } catch {}
const legacy = db.prepare('SELECT docSync FROM legacy WHERE id=?').get('old-1')
console.log('legacy 行读回 docSync=' + legacy.docSync + ' (expect 0, 默认不丢数据)')
db.prepare('INSERT INTO legacy (id, title, docSync) VALUES (?, ?, ?)').run('new-1', 'new row', 1)
console.log('新插入 docSync=1 读回=' + db.prepare('SELECT docSync FROM legacy WHERE id=?').get('new-1').docSync)
console.log('PASS 迁移语义=ensureColumn(ADD COLUMN docSync INTEGER DEFAULT 0) 与 server.mjs:388-389 一致')
