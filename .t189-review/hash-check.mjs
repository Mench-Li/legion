import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const baseline = JSON.parse(readFileSync('docs/superpowers/prt/prt-007-baseline.json','utf8'))
const files = ['team-hub/server.mjs','team-hub/write-intent-store.mjs','team-hub/routes/agents.mjs','team-hub/routes/write-intent.mjs','team-hub/routes/delivery.mjs']
const sha = (p) => createHash('sha256').update(readFileSync(p,'utf8')).digest('hex')
for (const f of files) {
  const base = baseline.sources[f]
  const cur = sha(f)
  let par = 'MISSING'
  try { par = sha('.t189-review/parent/' + f) } catch {}
  console.log(f)
  console.log('  baseline', base)
  console.log('  parent  ', par, par === base ? 'MATCH' : 'DRIFT')
  console.log('  current ', cur, cur === base ? 'MATCH' : 'DRIFT')
}
