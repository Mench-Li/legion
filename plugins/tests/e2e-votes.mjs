// P0-3 集成回测：真实草稿落盘到临时目录 → 喂 recalled/upvoted 事件 → frontmatter 更新 → promote 判定
// 运行: node tests/e2e-votes.mjs  （写 scratch/e2e-votes/ 临时目录，不动 docs/）
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { collectSignals, shouldDraft, buildDraft } from '../lib/experience.js'
import {
  parseDraftState, renderFrontmatter, replaceFrontmatter, applyVote,
  detectRecalledTaskIds, detectUpvotedTaskIds, shouldPromote,
} from '../lib/experienceVotes.js'

const DIR = String.raw`D:\project\DSH\legion\scratch\e2e-votes`
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const db = new DatabaseSync(String.raw`D:\project\DSH\legion\team-hub\team.db`, { readOnly: true })
const rows = db.prepare("SELECT id, title, role, soldier, goalId, scope, status, comments, evidence, artifacts FROM tasks WHERE status='done'").all()
const mkTask = (r) => ({
  id: r.id, title: r.title, description: '', role: r.role, soldier: r.soldier,
  goalId: r.goalId, scope: r.scope, status: r.status,
  comments: JSON.parse(r.comments || '[]'),
  evidence: JSON.parse(r.evidence || '[]'),
  artifacts: JSON.parse(r.artifacts || '[]'),
})

// 1) 落盘 14 份真实草稿（createdAt=now 前 5 天，模拟观察窗已过）
const now = new Date('2026-09-08T00:00:00.000Z')
const createdAt = new Date(now.getTime() - 5 * 86400000).toISOString()
let drafts = []
for (const r of rows) {
  const t = mkTask(r)
  const sig = collectSignals(t)
  if (shouldDraft(t, sig)) {
    writeFileSync(join(DIR, `${t.id}.md`), buildDraft(t, sig, { createdAt }), 'utf8')
    drafts.push(t.id)
  }
}
console.log(`落盘草稿 ${drafts.length} 份到 scratch/e2e-votes/`)

// 2) 模拟事件：任务 T-120/T-121 描述借鉴 T-110 与 T-004 草稿（recalled），
//    将军在任务评论中采纳 T-092 与 T-004（upvoted）
const simTasks = [
  { id: 'T-120', title: '修复部署问题', description: '参考 T-110 经验处理失败轮次', comments: [] },
  { id: 'T-121', title: '补写 README', description: '复用经验草稿 T-004 的做法', comments: [] },
  { id: 'T-999', title: '任何任务', description: '普通任务', comments: [
    { by: 'general', at: now.toISOString(), text: '采纳经验草稿 T-092：集成回归锚定很有效，后续照办' },
    { by: 'general', at: now.toISOString(), text: '按 T-004 的经验办：写回接口文档给后续维护者' },
  ] },
]
// 事件收集（复刻插件挂点逻辑）
function collect(simTasks) {
  const byTask = {}, byGeneral = {}
  for (const t of simTasks) {
    const text = [t.title || '', t.description || '', ...(t.comments || []).map(c => `${c.by}: ${c.text}`)].join('\n')
    for (const target of detectRecalledTaskIds(text)) {
      if (target === t.id) continue
      ;(byTask[target] ??= []).push(t.id)
    }
    for (const target of detectUpvotedTaskIds(text)) {
      if (target === t.id) continue
      const line = (t.comments || []).find(c => (c.text || '').includes(target) && (c.by === 'general' || c.by === '将军'))
      if (line) (byGeneral[target] ??= []).push(line.by)
    }
  }
  return { byTask, byGeneral }
}
const { byTask, byGeneral } = collect(simTasks)
console.log('recalled 事件:', JSON.stringify(byTask))
console.log('upvoted 事件:', JSON.stringify(byGeneral))

// 3) 应用到草稿文件（增量幂等，模拟守护 sweep）
for (const f of readdirSync(DIR).filter(x => x.endsWith('.md'))) {
  const file = join(DIR, f)
  const raw = readFileSync(file, 'utf8')
  const cur = parseDraftState(raw)
  if (cur.status !== 'draft') continue
  let next = cur
  for (const ref of byTask[cur.taskId] ?? []) next = applyVote({ state: next, recalledByTaskId: ref, now: now.toISOString() })
  for (const g of byGeneral[cur.taskId] ?? []) next = applyVote({ state: next, upvotedBy: g, now: now.toISOString() })
  if (renderFrontmatter(next) !== renderFrontmatter(cur)) writeFileSync(file, replaceFrontmatter(raw, renderFrontmatter(next)), 'utf8')
}

// 4) 判定 promote
console.log('\n=== promote 判定（now=' + now.toISOString() + '） ===')
for (const id of drafts) {
  const file = join(DIR, `${id}.md`)
  const s = parseDraftState(readFileSync(file, 'utf8'))
  const g = shouldPromote(s, now.toISOString())
  if (g.promote || s.recalled > 0 || s.upvoted > 0) {
    console.log(`[${id}] recalled=${s.recalled} upvoted=${s.upvoted} → promote=${g.promote} ${g.gates.map(x => `${x.name}:${x.pass}`).join(' ')}`)
  }
}

// 5) 复核：T-110 草稿文件 frontmatter 实际内容
console.log('\n=== T-110 草稿 frontmatter ===')
const t110 = readFileSync(join(DIR, 'T-110.md'), 'utf8').split('\n---')[0]
console.log(t110)
db.close()
