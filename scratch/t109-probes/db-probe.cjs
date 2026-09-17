
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
console.log('TABLES:', tables.join(','));
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name);
  console.log('COLUMNS', t, cols.join(','));
}
db.close();
