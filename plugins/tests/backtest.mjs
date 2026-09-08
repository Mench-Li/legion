// P0-2 真实语料回测：用 team.db 的真实 done/canceled 任务跑 experience 打分
// 运行: node tests/backtest.mjs  （只读 team.db，不写盘）
import { DatabaseSync } from 'node:sqlite'
import { collectSignals, shouldDraft, buildDraft, frictionScore } from '../lib/experience.js'

const db = new DatabaseSync(String.raw`D:\project\DSH\legion\team-hub\team.db`, { readOnly: true })
const rows = db.prepare("SELECT id, title, role, soldier, goalId, scope, status, comments, evidence, artifacts FROM tasks WHERE status IN ('done','canceled')").all()
const mkTask = (r) => ({
  id: r.id, title: r.title, description: '', role: r.role, soldier: r.soldier,
  goalId: r.goalId, scope: r.scope, status: r.status,
  comments: JSON.parse(r.comments || '[]'),
  evidence: JSON.parse(r.evidence || '[]'),
  artifacts: JSON.parse(r.artifacts || '[]'),
})

const done = rows.filter(r => r.status === 'done').map(mkTask)
const drafted = []
const scoreBuckets = {}
for (const t of done) {
  const sig = collectSignals(t)
  const b = Math.floor(sig.score)
  scoreBuckets[b] = (scoreBuckets[b] ?? 0) + 1
  if (shouldDraft(t, sig)) drafted.push({ t, sig })
}
console.log(`done 任务: ${done.length}`)
console.log('friction 分桶(0-1,1-2,...):', JSON.stringify(scoreBuckets))
console.log(`\n应产草稿: ${drafted.length}/${done.length}`)
for (const { t, sig } of drafted) {
  console.log(`  [${t.id}] ${t.role ?? t.soldier ?? '-'} friction=${sig.score.toFixed(2)} 打回=${sig.rework} 验收=${sig.reviewRounds} 将军=${sig.generalNotes} 闸门=${sig.gateRounds} 缺料=${sig.artifactMiss} :: ${(t.title || '').slice(0, 40)}`)
}

// 展示一份草稿样例（将军验收类）
const sample = drafted.find(d => d.sig.generalQuote.includes('将军验收') || d.sig.generalQuote.includes('退回'))
if (sample) {
  console.log('\n===== 草稿样例（' + sample.t.id + '） =====')
  console.log(buildDraft(sample.t, sample.sig).slice(0, 1400))
}
db.close()
