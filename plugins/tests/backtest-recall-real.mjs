// P2-③ 真实语料回测：hub 真实任务文本 → 真实 15 份草稿语料 → 召回命中与噪音检查
// 模拟守护 recallForTask 行为：注入段 = pickRecall（全命中），recalled 上票 = countableRefs（跨目标）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pickRecall, renderRecallSection, countableRefs } from '../lib/experienceRecall.js'

// 1) 真实草稿语料（与守护 recallCorpus 同款读取，含 goalId）
const draftsDir = 'D:/project/DSH/legion/docs/experience/drafts'
const corpus = readdirSync(draftsDir).filter(f => f.endsWith('.md')).sort().map((f) => {
  const raw = readFileSync(join(draftsDir, f), 'utf8')
  const taskM = /^taskId:\s*(T-\d+)/m.exec(raw)
  const goalM = /^goalId:\s*(\S+)/m.exec(raw)
  const statusM = /^status:\s*(\w+)/m.exec(raw)
  const titleM = /^# 经验草稿：\S+\s+(.+)$/m.exec(raw)
  return {
    taskId: taskM?.[1] ?? f.replace(/\.md$/, ''),
    kind: 'draft',
    title: titleM?.[1]?.trim()?.slice(0, 60) ?? f.replace(/\.md$/, ''),
    body: raw.replace(/^---\n[\s\S]*?\n---\n?/, '').slice(0, 4000),
    goalId: goalM?.[1] || undefined,
    status: statusM?.[1] ?? 'draft',
  }
}).filter(d => d.status === 'draft') // 与守护 recallCorpus 一致：stale/promoted 不进召回面
console.log(`语料：${corpus.length} 份草稿\n`)

// 2) 真实任务样本（含 goalId）
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true })
const ids = ['T-121', 'T-122', 'T-123', 'T-124', 'T-115', 'T-116', 'T-117', 'T-118']
const tasks = ids.map((id) => db.prepare('SELECT id, title, description, goalId FROM tasks WHERE id=?').get(id)).filter(Boolean)
db.close()

let injectCount = 0, voteCount = 0
for (const t of tasks) {
  const text = `${t.title ?? ''}\n${t.description ?? ''}`
  const picks = pickRecall(text, corpus)
  const countable = countableRefs(picks, t.id, t.goalId)
  const sec = picks.length ? renderRecallSection(picks) : null
  if (picks.length) injectCount++
  if (countable.length) voteCount++
  console.log(`== ${t.id} [goal=${t.goalId ?? '-'}] 注入${picks.length}条 / 计票${countable.length}条 ${String(t.title).slice(0, 34)}`)
  for (const c of countable) console.log(`     → 计 recalled: ${c.doc.taskId}「${c.doc.title.slice(0, 24)}」（${c.score.toFixed(1)}）`)
}
console.log(`\n注入 ${injectCount}/${tasks.length} 个任务；其中计 recalled ${voteCount} 个（其余命中为同目标兄弟/自引用 → 只注入不上票）`)
