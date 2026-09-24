// scratch/_probe-ledger-cit.mjs —— 台账/状态文档里的引用有没有"指到空行"（**不提交**）
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { REPO } from '../scripts/prt/boundary-facts.mjs'

const DOCS = [
  'docs/superpowers/prt/PRT-PROGRESS.md',
  'docs/MULTI-AGENT-FEATURE-STATUS.md',
]
const CIT = /(?:^|[\s`（(【\[])((?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mjs|cjs|js|ts|tsx|json|yml|yaml|md)):(\d+)(?:-(\d+))?/g

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean)
const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
const byPath = new Map(tracked.map((f) => [norm(f), f]))
const bySuffix = new Map()
for (const f of tracked) {
  const parts = norm(f).split('/')
  for (let i = 0; i < parts.length; i += 1) {
    const s = parts.slice(i).join('/')
    if (!bySuffix.has(s)) bySuffix.set(s, [])
    bySuffix.get(s).push(f)
  }
}
const resolveCit = (p) => {
  const k = norm(p)
  if (byPath.has(k)) return byPath.get(k)
  const c = [...new Set(bySuffix.get(k) ?? [])]
  return c.length === 1 ? c[0] : null
}

let total = 0
const bad = []
const unres = []
for (const doc of DOCS) {
  const text = readFileSync(`${REPO}/${doc}`, 'utf8')
  const seen = new Set()
  for (const m of text.matchAll(CIT)) {
    const key = `${m[1]}:${m[2]}${m[4] ? '-' + m[4] : ''}`
    if (seen.has(key)) continue
    seen.add(key)
    total += 1
    const real = resolveCit(m[1])
    if (real === null) { unres.push(`${doc}: ${key}`); continue }
    const lines = readFileSync(`${REPO}/${real}`, 'utf8').split('\n')
    const a = Number(m[2]); const b = m[4] ? Number(m[4]) : a
    if (b > lines.length) continue                      // 越界已由既有判据覆盖
    // 范围内**每一行**都是空行或收尾符 ⇒ 这个引用指的地方什么都没有
    const allDead = []
    for (let i = a; i <= b; i += 1) allDead.push((lines[i - 1] ?? '').trim())
    if (allDead.every((t) => t === '' || /^[)}\];,]+$/.test(t))) {
      bad.push({ doc, key, real, a, b, sample: allDead.slice(0, 3).join(' | ').slice(0, 50) })
    }
  }
}
console.log(`两份文档里不同的 file:line 引用 ${total} 处；无法解析 ${unres.length} 处`)
console.log(`★ 指到"整段都空/收尾符"的：${bad.length} 处\n`)
for (const b of bad) console.log(`  ${b.doc}\n      ${b.key}  →  ${b.real}  「${b.sample}」`)
if (unres.length) { console.log('\n无法解析：'); for (const u of unres.slice(0, 10)) console.log('  ' + u) }
