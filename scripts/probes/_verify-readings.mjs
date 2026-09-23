// scripts/probes/_verify-readings.mjs —— 把交接报告 §二「最终读数（都是机器读数，可复跑）」逐行重算（**不提交**）
//
// 这张表自称**可复跑**。那就去跑。凡是我能独立算出来的，都算一遍与表里比。
// 家族：**一句没有任何东西核对的断言** —— 这次是"这张表可复跑"这句话本身。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const sh = (cmd, args = []) => {
  try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) }
  catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? '') }
}

const rows = []
const say = (item, claim, real, ok) => rows.push({ item, claim, real, ok })

// ── ① 台账：140/145，4 ⏸ / 1 ⬜
const sp = sh('node', ['scripts/prt/spec-progress.mjs', '--check'])
const ledger = readFileSync(`${ROOT}/docs/superpowers/prt/PRT-PROGRESS.md`, 'utf8')
const statuses = [...ledger.matchAll(/^\|\s*PRT-\d+[^|]*\|[^|]*\|\s*([^|]*?)\s*\|/gm)].map((m) => m[1].trim())
const done = statuses.filter((s) => s.startsWith('✅')).length
const pause = statuses.filter((s) => s.includes('⏸')).length
const todo = statuses.filter((s) => s.includes('⬜')).length
say('台账行数/✅/⏸/⬜', '145 = 140✅ / 4⏸ / 1⬜',
  `${statuses.length} = ${done}✅ / ${pause}⏸ / ${todo}⬜`, sp.includes('140/145'))

// ── ② HEAD 与"交付 HEAD"那一行
const head = sh('git', ['rev-parse', '--short', 'HEAD']).trim()
say('HEAD（当前）', '（表里写 bacd407）', head, null)

// ── ③ 套件总数
const tests = sh('git', ['ls-files', '-z', '*.test.mjs']).split('\0').filter(Boolean).length
say('套件数 *.test.mjs', '360', String(tests), tests === 360)

// ── ④ 可达性：不可达条数 + 分类齐不齐
const base = JSON.parse(readFileSync(`${ROOT}/docs/superpowers/prt/prt-reachability-baseline.json`, 'utf8'))
const un = base.unreachable
const classes = [...new Set(un.map((e) => e.class))].sort()
say('可达性不可达条数', '46', String(un.length), un.length === 46)
say('可达性分类', 'by-design / deliberate / gap / in-flight', classes.join(' / '),
  classes.join(',') === 'by-design,deliberate,gap')

// ── ⑤ §5 裁决项编号 1..28 连续
const doc = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const ids = []
for (const line of doc.split(/\r?\n/)) {
  const m = /^\|\s*(\d+)\s*\|/.exec(line)
  // 只取 5 列那张表里的
  if (m && line.split('|').length - 2 === 5) ids.push(Number(m[1]))
}
const sorted = [...new Set(ids)].sort((a, b) => a - b)
const contiguous = sorted.length === 28 && sorted.every((v, i) => v === i + 1)
say('§5 裁决项', '1～28（连续、无缺号、无重复）',
  `${sorted.length} 条，${sorted[0]}..${sorted[sorted.length - 1]}，重复 ${ids.length - sorted.length}`,
  contiguous)

// ── ⑥ 文档表格 0 处 + 棘轮 87
const dt = sh('node', ['scripts/ci/run-ci.mjs', '--only', 'doc'])
const auth = /八份权威文档[^\n]*?(\d+)\s*处/.exec(dt)
const ratchet = /棘轮[^\n]*?(\d+)/.exec(dt)
say('文档表格（权威）', '八份 0 处', auth ? `${auth[1]} 处` : (dt.match(/doc.*?(PASS|FAIL)/) ?? ['?'])[0],
  auth ? auth[1] === '0' : dt.includes('PASS'))
say('文档表格棘轮', '87', ratchet ? ratchet[1] : '（输出里没读到）', ratchet ? ratchet[1] === '87' : null)

// ── ⑦ §二 正文里那个"test 阶段那 808 秒"
const ciRow = /全量 CI（\*\*交付 HEAD\*\*）[^\n]*?`test` (\d+)ms/.exec(doc + readFileSync(`${ROOT}/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md`, 'utf8'))
const hand = readFileSync(`${ROOT}/docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md`, 'utf8')
const prose = /`test` 阶段那 (\d+) 秒里/.exec(hand)
say('§二 正文"test 阶段那 N 秒"', '应与表里最新那次 CI 一致', prose ? `${prose[1]} 秒` : '（没读到）', null)

console.log('=== 交接报告 §二「机器读数」逐行重算 ===\n')
for (const r of rows) {
  const mark = r.ok === null ? '·' : (r.ok ? '✓' : '✖')
  console.log(`  ${mark} ${r.item}`)
  console.log(`      表里: ${r.claim}`)
  console.log(`      实算: ${r.real}`)
}
const bad = rows.filter((r) => r.ok === false).length
console.log(`\n明确不符 ${bad} 处；无法自动判定 ${rows.filter((r) => r.ok === null).length} 处`)
