// scratch/_mutate-r77-family.mjs —— 第 77 轮负控：家族表加的那 14 行（63～76）**有没有判据盯着**？
//
// ★ 为什么问这个：这一批（第 63～76 轮）我往家族表加了 **14 行**。
//   如果没有任何判据盯着它，那它就是**我自己写的、没人核的**散文 ——
//   而"没人核的散文"正是这十几轮一直在修的那类东西。
//
// 三条负控：
//   ① 把第 76 行的序号改成 99（破坏"严格递增"）
//   ② 把第 76 行的序号删掉（破坏"每一行都有号"）
//   ③ 把第 76 行整行删掉（破坏"到 76 为止连续"）
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
const SENTINEL = 'D:/project/DSH/legion/scratch/.mutant-in-progress.json'
const SUITES = ['intervention-coverage', 'doc-table-integrity', 'boundary-facts', 'progress-check', 'ledger-evidence']

if (existsSync(SENTINEL)) {
  console.log('  ✖ 哨兵还在（上一次变异没收尾）——先清理再跑')
  process.exit(1)
}

const orig = readFileSync(I, 'utf8')
const eol = orig.includes('\r\n') ? '\r\n' : '\n'
const row76 = orig.split(eol).find((l) => /^\| 76 \|/.test(l))
if (!row76) { console.log('  ✖ 找不到 | 76 | 那一行'); process.exit(1) }

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

const mutants = [
  ['① 序号 76 → 99（破坏严格递增）', row76.replace('| 76 |', '| 99 |')],
  ['② 序号列留空（破坏"每行有号"）', row76.replace('| 76 |', '|  |')],
  ['③ 整行删掉（破坏"连续到 76"）', null],
]

for (const [name, mutated] of mutants) {
  writeFileSync(SENTINEL, JSON.stringify({ file: I, mutant: name }), 'utf8')
  const next = mutated === null
    ? orig.split(eol).filter((l) => !/^\| 76 \|/.test(l)).join(eol)
    : orig.replace(row76, mutated)
  writeFileSync(I, next, 'utf8')
  const red = judges()
  writeFileSync(I, orig, 'utf8')
  unlinkSync(SENTINEL)
  console.log(`  ${red.length > 0 ? '判红' : '★ 全绿（没有判据盯着）'}  ${name}${red.length ? '  ← ' + red.join(', ') : ''}`)
}
writeFileSync(I, orig, 'utf8')
if (existsSync(SENTINEL)) unlinkSync(SENTINEL)
console.log('  ✔ 原文件已还原，哨兵已清')
