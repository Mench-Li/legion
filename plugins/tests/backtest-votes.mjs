// P0-3 真实语料回测：14 份草稿（P0-2 判定的 done 任务）+ 真实任务文本的 recalled/upvoted 事件扫描
// 运行: node tests/backtest-votes.mjs  （只读 team.db，不写盘）
import { DatabaseSync } from 'node:sqlite'
import {
  parseDraftState, renderFrontmatter, replaceFrontmatter, applyVote,
  detectRecalledTaskIds, detectUpvotedTaskIds, confidenceOf, shouldPromote, shouldPrune,
} from '../lib/experienceVotes.js'
import { collectSignals, shouldDraft, buildDraft } from '../lib/experience.js'

const db = new DatabaseSync(String.raw`D:\project\DSH\legion\team-hub\team.db`, { readOnly: true })
const rows = db.prepare("SELECT id, title, role, soldier, goalId, scope, status, comments, evidence, artifacts, createdAt FROM tasks").all()
const byId = new Map(rows.map(r => [r.id, r]))
const mkTask = (r) => ({
  id: r.id, title: r.title, description: '', role: r.role, soldier: r.soldier,
  goalId: r.goalId, scope: r.scope, status: r.status,
  comments: JSON.parse(r.comments || '[]'),
  evidence: JSON.parse(r.evidence || '[]'),
  artifacts: JSON.parse(r.artifacts || '[]'),
})

// 1) 重现 P0-2：done 任务 → 草稿（内存）
const doneTasks = rows.filter(r => r.status === 'done').map(mkTask)
const drafts = []
for (const t of doneTasks) {
  const sig = collectSignals(t)
  if (shouldDraft(t, sig)) {
    drafts.push({ task: t, sig, md: buildDraft(t, sig) })
  }
}
console.log(`done 任务草稿数: ${drafts.length}`)

// 2) 事件扫描：所有任务文本（描述+评论）里的 recalled/upvoted 候选，排除草稿源任务自身
const draftTaskIds = new Set(drafts.map(d => d.task.id))
const createdBy = (id) => { const t = byId.get(id); return t ? (t.createdAt || '') : '' }

const recallEvents = [] // {source: referrerId, target: draftTaskId}
const upvoteEvents = []
for (const r of rows) {
  const texts = [r.title || '', r.description || '']
  try { for (const c of JSON.parse(r.comments || '[]')) texts.push(`${c.by}: ${c.text || ''}`) } catch {}
  for (const ch of texts) {
    for (const target of detectRecalledTaskIds(ch)) {
      if (draftTaskIds.has(target) && target !== r.id) {
        // recalled 应发生在草稿落盘之后：草稿源任务 done 后才算“后续任务”
        recallEvents.push({ source: r.id, target })
      }
    }
    for (const up of detectUpvotedTaskIds(ch)) {
      if (draftTaskIds.has(up) && up !== r.id) {
        const isGeneral = /^general$|将军/.test(ch.slice(0, 20))
        if (isGeneral) upvoteEvents.push({ source: r.id, target: up })
      }
    }
  }
}
console.log(`recalled 事件候选: ${recallEvents.length}`)
for (const e of recallEvents.slice(0, 12)) console.log(`  [${e.source}] 引用草稿源任务 ${e.target}`)
console.log(`upvoted 事件候选: ${upvoteEvents.length}`)
for (const e of upvoteEvents.slice(0, 8)) console.log(`  [${e.source}] 将军采纳 ${e.target}`)

// 3) 应用事件 → 计算 confidence / promote 状态（用任务 createdAt 近似时间轴：不引入真实 now，避免全 0）
//    仅统计：给定这些事件，哪些草稿会获得票
const voted = new Map()
for (const e of recallEvents) {
  if (!voted.has(e.target)) voted.set(e.target, { recalledBy: [], upvotedBy: [] })
  const v = voted.get(e.target)
  if (!v.recalledBy.includes(e.source)) v.recalledBy.push(e.source)
}
for (const e of upvoteEvents) {
  if (!voted.has(e.target)) voted.set(e.target, { recalledBy: [], upvotedBy: [] })
  const v = voted.get(e.target)
  if (!v.upvotedBy.includes('general')) v.upvotedBy.push('general')
}
console.log('\n获得票的草稿:')
for (const d of drafts) {
  const v = voted.get(d.task.id)
  if (v && (v.recalledBy.length > 0 || v.upvotedBy.length > 0)) {
    console.log(`  [${d.task.id}] recalled=${v.recalledBy.length}(${v.recalledBy.join(',')}) upvoted=${v.upvotedBy.length}`)
  }
}
db.close()
