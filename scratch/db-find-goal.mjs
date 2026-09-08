import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true })
const ids = ['T-095','T-096','T-097','T-098','T-099','T-100','T-101','T-102']
for (const id of ids) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!t) { console.log(`--- ${id} ---\n(MISSING)`); continue }
  console.log(`\n===== ${id} [role=${t.role} status=${t.status} goal=${t.goalId}] =====`)
  console.log('TITLE:', t.title)
  if (t.description) console.log('DESC:', t.description)
  if (t.acceptance) console.log('ACCEPTANCE:', t.acceptance)
  if (t.evidence) console.log('EVIDENCE:', t.evidence)
  if (t.artifacts) console.log('ARTIFACTS:', t.artifacts.slice(0, 600))
  if (t.comments && t.comments.length) {
    const c = JSON.parse(t.comments)
    console.log('COMMENTS(' + c.length + '):')
    for (const x of c.slice(-6)) console.log('   [' + (x.role||x.by||'') + '] ' + String(x.text||'').slice(0, 500))
  }
  if (t.review_notes) console.log('REVIEW_NOTES:', t.review_notes)
}
db.close()
