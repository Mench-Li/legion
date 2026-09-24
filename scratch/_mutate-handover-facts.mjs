// scratch/_mutate-handover-facts.mjs —— 变异验证 E 组 5 条事实的 **derive 侧**（**不提交**）
//
// ★★★ 必须在**新进程**里跑检查：第一版在同一个进程里改源文件再 checkFacts()，
//     而 ESM 的模块缓存让它仍用改之前那份 ⇒ **5 个变异全部"漏网"**。
//     真相是**变异根本没执行**。
//
//     > "变异没执行"与"守卫没咬住"在输出里长得一模一样，处置却完全相反。
//     > 这是第 24 轮就记下的坑，第 26 轮又踩了一次 —— 所以这里改成 spawn。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const F = 'D:/project/DSH/legion/scripts/prt/boundary-facts.mjs'
const CHECK = 'scratch/_check-facts-once.mjs'
const ROOT = 'D:/project/DSH/legion'
const orig = readFileSync(F, 'utf8')

const runOnce = (id) => JSON.parse(execFileSync('node', [CHECK, id], { cwd: ROOT, encoding: 'utf8' }).trim())

const MUT = [
  ['M1 台账计数改成**写死下标**的解析器（我第一版的错）',
    'const st = cells.map((c) => c.trim()).find((c) => /^(✅|⏸|⬜)/.test(c))',
    'const st = cells.map((c) => c.trim())[2]',
    'handover-ledger-tallies', true],
  ['M2 套件总数少算 1',
    "    .split('\\0').filter(Boolean)\n}",
    "    .split('\\0').filter(Boolean).slice(1)\n}",
    'handover-tracked-suites', true],
  ['M3 不可达总数 +1',
    'return { total: list.length, byClass }',
    'return { total: list.length + 1, byClass }',
    'handover-unreachable-total', true],
  ['M4 棘轮 derive 改成 88（报告里那个数就不跟着走了）',
    'docRatchet: () => REPO_WIDE_BASELINE,',
    'docRatchet: () => REPO_WIDE_BASELINE + 1,',
    'handover-doc-ratchet', true],
  ['M5 毫秒→秒 改成 floor（824992 ⇒ 824 ≠ 散文 825）',
    'return Math.round(Number(m[1]) / 1000)',
    'return Math.floor(Number(m[1]) / 1000)',
    'handover-ci-prose-matches-table', true],
]

const base = runOnce('no-such-id')
console.log(`基线：checked=${base.checked}/${base.total} 红=${base.ids.length}\n`)

let all = true
try {
  for (const [name, find, repl, id, wantHit] of MUT) {
    if (!orig.includes(find)) { console.log(`⚠ ${name}\n    变异串没找到`); all = false; continue }
    writeFileSync(F, orig.replace(find, repl), 'utf8')
    const r = runOnce(id)
    const ok = r.hit === wantHit
    if (!ok) all = false
    console.log(`${ok ? '✓ 咬住' : '✖ 漏网'} ${name}`)
    console.log(`     ${r.code ?? '（无违规）'} claimed=${JSON.stringify(r.claimed)} actual=${JSON.stringify(r.actual)}`)
    if (!ok) console.log(`     红的只有：${JSON.stringify(r.ids)}`)
    writeFileSync(F, orig, 'utf8')
  }
} finally { writeFileSync(F, orig, 'utf8') }

console.log('\n全部咬住 ? ' + all)
console.log('还原逐字相同 ? ' + (readFileSync(F, 'utf8') === orig))
const back = runOnce('no-such-id')
console.log(`还原后：checked=${back.checked}/${back.total} 红=${back.ids.length}`)
