
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true });
const t = db.prepare("SELECT id, role, status, goalId, artifacts, comments FROM tasks WHERE id='T-111'").get();
console.log('TASK:', JSON.stringify({id:t?.id, role:t?.role, status:t?.status, goalId:t?.goalId, artifacts:t?.artifacts}, null, 1));
const g = db.prepare("SELECT id, objective, docsDir, status FROM goal WHERE id LIKE 'G-%'").all();
console.log('GOALS:', JSON.stringify(g, null, 1));
db.close();
