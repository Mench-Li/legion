// scratch/_mutate-r77b-family.mjs —— 第 77 轮补两条：判据是不是"硬编码 76"？
//
// ★ 这一条很要紧：如果判据只是"必须存在一行 | 76 |"，那它同时
//   ① 在有人**正当**地加第 77 行时会误报（陷阱 e：硬编码一个当前读数），并且
//   ② 并没有真的在检查"连续"。
//
// 两条控制：
//   ④ 加一行 | 77 |（**正当**扩展）→ 必须**仍然全绿**
//   ⑤ 把第 76 行改成 | 78 |（**跳号**）→ 必须判红
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
const SENTINEL = 'D:/project/DSH/legion/scratch/.mutant-in-progress.json'
const SUITES = ['intervention-coverage', 'doc-table-integrity', 'boundary-facts']

if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }
const orig = readFileSync(I, 'utf8')
const eol = orig.includes('\r\n') ? '\r\n' : '\n'
const lines = orig.split(eol)
const i76 = lines.findIndex((l) => /^\| 76 \|/.test(l))
if (i76 < 0) { console.log('  ✖ 找不到 | 76 |'); process.exit(1) }
const row76 = lines[i76]

function judges() {
  const red = []
  for (const s of SUITES) {
    try {
      const out = execFileSync('node', ['--test', `scripts/prt/${s}.test.mjs`],
        { cwd: 'D:/project/DSH/legion', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (/ℹ fail [1-9]/.test(out)) red.push(s)
    } catch (e) {
      const both = `${e.stdout ?? ''}${e.stderr ?? ''}`
      if (/ℹ fail [1-9]/.test(both)) red.push(s)
    }
  }
  return red
}

const cases = [
  ['④ 正当加一行 | 77 | → 应**保持全绿**', () => {
    const next = [...lines]
    next.splice(i76 + 1, 0, '| 77 | ★ 负控用的临时行（本行只在变异期存在） |')
    return next.join(eol)
  }],
  ['⑤ 第 76 行改成 | 78 |（跳号）→ 应**判红**', () => orig.replace(row76, row76.replace('| 76 |', '| 78 |'))],
]

let allGood = true
for (const [name, build] of cases) {
  writeFileSync(SENTINEL, JSON.stringify({ file: I, mutant: name }), 'utf8')
  writeFileSync(I, build(), 'utf8')
  const red = judges()
  writeFileSync(I, orig, 'utf8')
  unlinkSync(SENTINEL)
  const wantRed = name.startsWith('⑤')
  const ok = wantRed ? red.length > 0 : red.length === 0
  if (!ok) allGood = false
  console.log(`  ${ok ? 'OK' : '★ 不符预期'}  ${name}${red.length ? '  ← 红：' + red.join(', ') : '  ← 全绿'}`)
}
writeFileSync(I, orig, 'utf8')
if (existsSync(SENTINEL)) unlinkSync(SENTINEL)
console.log('  ✔ 原文件已还原，哨兵已清')
process.exit(allGood ? 0 : 1)
