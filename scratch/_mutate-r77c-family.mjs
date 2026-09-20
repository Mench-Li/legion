// scratch/_mutate-r77c-family.mjs —— 第 77 轮第三条负控：判据到底硬编码了没有
//
// ★ 上一条我把 ④ 读成了"判据硬编码 76" —— **那是我的推断，不是读数。**
//   真实的规则在 boundary-facts.test.mjs:1141：**标题轮次 = 家族表最大轮次**。
//   ⇒ 我那条 ④ 同时加了行 77 **却没动标题** ⇒ 判据抓到的是**不一致**，不是"多了一行"。
//
// ⑥ 加一行 | 77 | **并**把读数块标题改成"第 77 轮" → 必须**全绿**（证明它不是硬编码）
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

function build() {
  const next = [...lines]
  next.splice(i76 + 1, 0, '| 77 | ★ 负控用的临时行（本行只在变异期存在） |')
  return next.join(eol).replace('**第 76 轮结束时的读数**', '**第 77 轮结束时的读数**')
}

writeFileSync(SENTINEL, JSON.stringify({ file: I, mutant: '⑥ 行77 + 标题77' }), 'utf8')
writeFileSync(I, build(), 'utf8')
const red = judges()
writeFileSync(I, orig, 'utf8')
unlinkSync(SENTINEL)

console.log(`  ${red.length === 0 ? 'OK ★ 全绿 ⇒ 判据**不是**硬编码 76，它查的是"标题 = 最大轮次"' : '★ 仍然判红 ← ' + red.join(', ')}`)
console.log('  ✔ 原文件已还原，哨兵已清')
