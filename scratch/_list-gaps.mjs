// scratch/_list-gaps.mjs —— 列出 reachability 里所有分类为 gap 的不可达文件（**不提交**）
import { execFileSync } from 'node:child_process'

const out = execFileSync('node', ['scripts/prt/reachability.mjs'],
  { cwd: 'D:/project/DSH/legion', encoding: 'utf8', maxBuffer: 1 << 26 })
const lines = out.split(/\r?\n/)

const entries = []
for (let i = 0; i < lines.length; i += 1) {
  const m = /^\s{2}(\S+\.mjs)\s*$/.exec(lines[i])
  if (m === null) continue
  const detail = lines[i + 1] ?? ''
  const kind = /\[(\w[\w-]*)\]/.exec(detail)
  entries.push({ file: m[1], kind: kind === null ? '?' : kind[1], line: i + 1 })
}

const byKind = {}
for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
console.log(`共 ${entries.length} 个不可达条目：`, JSON.stringify(byKind))
console.log('\n=== gap 的那些（没有人接、也没有判为刻意）===')
for (const e of entries.filter((x) => x.kind === 'gap')) console.log('  ' + e.file)
