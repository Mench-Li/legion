// scratch/_count-main-table-files.mjs —— 把主表点名的测试文件逐个真跑一遍，拿**逐文件实测**（**不提交**）
//
// 为什么要真跑：CI 的套件行**聚合多个文件**，所以多文件行只知道总和。
// 主表声明的是**单个数**，所以分母必须是**那一个文件**。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const names = [
  'run-events', 'event-delivery', 'event-delivery-wiring', 'secrets-acl-runner',
  'automation-store', 'automation-http', 'compaction-store', 'compaction-http',
  'usage-rollup', 'usage-rollup-http', 'pack-facts', 'pack-facts-http',
  'role-pack', 'role-pack-store', 'role-pack-http', 'registry',
  'connector-store', 'connector-http', 'friction', 'graph',
  'experience-store', 'experience-http', 'contract', 'adapter',
  'budget-alert', 'budget-alert-http', 'reachability', 'production-scope-wiring',
]
const tracked = execFileSync('git', ['ls-files', '-z', '*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))

const out = {}
for (const n of names) {
  const cands = tracked.filter((f) => f.split('/').pop() === `${n}.test.mjs`)
  if (cands.length !== 1) { out[n] = { path: cands, count: null, why: `${cands.length} 个候选` }; continue }
  try {
    const r = execFileSync('node', ['--test', cands[0]], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const m = /ℹ tests (\d+)/.exec(r)
    out[n] = { path: cands[0], count: m ? Number(m[1]) : null }
  } catch (e) {
    const s = String(e.stdout ?? '') + String(e.stderr ?? '')
    const m = /ℹ tests (\d+)/.exec(s)
    out[n] = { path: cands[0], count: m ? Number(m[1]) : null, why: 'exit≠0' }
  }
}
console.log('=== 逐文件实测 ===')
for (const [n, v] of Object.entries(out)) {
  console.log(`  ${String(v.count ?? '—').padStart(4)}  ${n}.test.mjs   ${v.path ?? ''} ${v.why ?? ''}`)
}
