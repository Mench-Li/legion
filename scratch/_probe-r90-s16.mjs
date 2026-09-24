// scratch/_probe-r90-s16.mjs —— 第 90 轮：§5 第 16 条名下有 **10 个** gap 模块（21 个里最多的簇）
//                         第 86 轮我只看了其中 1 个（retention.mjs）⇒ 这一轮把 10 个逐个看一遍
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const out = execFileSync('node', ['scripts/prt/reachability.mjs'], { cwd: R, encoding: 'utf8', maxBuffer: 64e6 })
const lines = out.split(/\r?\n/)

// 收集 (模块路径, 说明) 对：模块行是相对路径，下一行是 [bucket] 说明
const entries = []
for (let i = 0; i < lines.length; i++) {
  const m = /^([\w./-]+\.mjs)$/.exec(lines[i].trim())
  if (!m) continue
  const next = (lines[i + 1] ?? '').trim()
  const b = /^\[(\w[\w-]*)\]/.exec(next)
  if (!b) continue
  entries.push({ mod: m[1], bucket: b[1], note: next })
}

const s16 = entries.filter((e) => e.note.includes('第 16 条'))
console.log(`  指向 §5 第 16 条的模块：**${s16.length}** 个\n`)

for (const e of s16) {
  let kind = '?'
  let exports = ''
  try {
    const src = readFileSync(`${R}/${e.mod}`, 'utf8')
    const ex = [...src.matchAll(/^export\s+(?:async\s+)?(function|const|class)\s+([A-Za-z0-9_$]+)/gm)].map((x) => x[2])
    exports = ex.slice(0, 4).join(', ') + (ex.length > 4 ? ` …(+${ex.length - 4})` : '')
    const impure = /process\.env|readFileSync|writeFileSync|existsSync|execFileSync|createServer|openSync/.test(src)
    kind = impure ? '★ 会碰 IO/env' : '纯（不碰 IO/env）'
  } catch { kind = '读不到' }
  console.log(`  ${e.mod}`)
  console.log(`    ${kind}`)
  console.log(`    导出：${exports || '（无）'}`)
  console.log(`    ${e.note.slice(0, 150)}`)
  console.log('')
}
