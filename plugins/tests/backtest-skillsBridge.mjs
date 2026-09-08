// P1-4.5 端到端验证：真实 team-hub published skills → skillsBridge 收敛计划 → 目标目录 dry-run
import { formatSkill } from '../lib/skillsCache.js'
import { renderSkillMd, planSkillSync, parseSkillTombstones } from '../lib/skillsBridge.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HUB = 'http://127.0.0.1:8787'
const res = await fetch(`${HUB}/api/skills?scope=software`)
const skills = await res.json()
console.log(`hub published (scope=software): ${skills.length} 个`)
const desired = skills
  .filter(s => s.id && !s.id.includes('/') && !s.id.includes('..'))
  .map(s => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? '', body: formatSkill(s), contentHash: s.contentHash ?? '' }))

// dry-run 到 scratch/skills-bridge/
const DIR = join(here, '..', '..', 'scratch', 'skills-bridge')
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

// 首次同步
const existing0 = new Map()
const p1 = planSkillSync(desired, existing0, new Set())
for (const w of p1.writes) {
  const d = join(DIR, w.id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), w.content, 'utf8')
}
console.log(`首次同步：写 ${p1.writes.length}（${p1.writes.map(w => w.id).join('、')}）删 ${p1.deletes.length} changed=${p1.changed}`)

// 再同步（模拟下一轮 sweep）→ 应零变化（幂等）
const existing1 = new Map()
for (const name of readdirSync(DIR)) {
  const p = join(DIR, name, 'SKILL.md')
  if (existsSync(p)) existing1.set(name, readFileSync(p, 'utf8'))
}
const p2 = planSkillSync(desired, existing1, new Set())
console.log(`再同步：写 ${p2.writes.length} 删 ${p2.deletes.length} changed=${p2.changed}（幂等应 false）`)

// 模拟将军在 hub 撤回一个技能（desired 移除）→ 无 tombstone 保留、有 tombstone 删
const truncated = desired.slice(0, -1)
const p3 = planSkillSync(truncated, existing1, new Set())
console.log(`撤回（无 tombstone）：写 ${p3.writes.length} 删 ${p3.deletes.length}（应保留不删）`)
const gone = desired[desired.length - 1].id
const p4 = planSkillSync(truncated, existing1, new Set([gone]))
console.log(`撤回（有 tombstone ${gone}）：写 ${p4.writes.length} 删 ${p4.deletes.map(d => d.id).join('、')}`)

// 展示一份实际 SKILL.md
if (desired.length > 0) {
  const sample = desired[0]
  console.log(`\n=== 样例 ${sample.id}/SKILL.md ===`)
  console.log(renderSkillMd(sample).slice(0, 500))
}
