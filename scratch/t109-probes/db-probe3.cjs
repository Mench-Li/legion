
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true });
const rows = db.prepare("SELECT id, role, status, goalId, artifacts FROM tasks WHERE goalId='G-mtpaab3x-1' ORDER BY id").all();
for (const r of rows) {
  let arts = [];
  try { arts = JSON.parse(r.artifacts || '[]'); } catch {}
  console.log(r.id, '|', r.role, '|', r.status, '| artifacts:', arts.map(a => a.path + (a.digest ? '#'+a.digest.slice(0,6) : '')).join(' , '));
}
db.close();
