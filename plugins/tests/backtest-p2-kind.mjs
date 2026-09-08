// P2-① 离线端到端：真实 declarative 草稿 → 模拟 promoteDraft declarative 分支 → learnings 资产
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { classifyDraftKind, parseDraftState, renderLearningFile, fallbackLearning, learningIdForTask } from '../lib/experienceVotes.js'

const draftsDir = 'D:/project/DSH/legion/docs/experience/drafts'
const outDir = 'D:/project/DSH/legion/scratch/p2-learnings'
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const files = readdirSync(draftsDir).filter(f => f.endsWith('.md')).sort()
let written = 0
console.log('=== 逐草稿判定 + declarative 落盘（scratch，模拟 promoteDraft declarative 分支） ===')
for (const f of files) {
  const raw = readFileSync(join(draftsDir, f), 'utf8')
  const st = parseDraftState(raw)
  const kind = classifyDraftKind(raw)
  if (st.status !== 'draft') continue
  if (kind !== 'declarative') continue
  // 模拟 promoteDraft：resolveKind → declarative → AI 改写（用 fallbackLearning 保底产物代表）→ renderLearningFile
  const body = fallbackLearning(st.taskId, raw) // AI 改写产物占位（真实运行时为模型输出）
  const md = renderLearningFile({
    taskId: st.taskId, scope: st.scope || 'software', role: st.role, goalId: st.goalId,
    createdAt: st.createdAt, promotedAt: new Date().toISOString(), body,
  })
  const file = join(outDir, `${st.taskId}.md`)
  writeFileSync(file, md, 'utf8')
  written++
  console.log(`  ${f} → ${learningIdForTask(st.taskId)}（promotedTo 形态）✓`)
}
console.log(`\n共落盘 declarative learnings: ${written} 份 → ${outDir}`)
console.log('\n=== 样例：一份 learning 资产完整形态 ===')
const sample = readdirSync(outDir).find(f => f.endsWith('.md'))
if (sample) console.log(readFileSync(join(outDir, sample), 'utf8').slice(0, 900))
