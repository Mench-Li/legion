// scratch/_r103-enumerate.mjs —— 第 103 轮：把"产品侧到底有多少条红"从一次**真实跑完的 CI**里逐条数出来
//
// ★ 为什么要有这一步：我第 63/85 轮报的是「5 套件 / 21 条」，第 100 轮改成「5 套件 / 22 条」，
//   而第 102 轮修好闸门之后**当场多出一个 `model-config`**。
//   ⇒ 那份名单**一直是不完整的**，而它的来源是"我挑了几个套件去跑"，不是"CI 跑完了全部"。
//   ★★★ 这一轮从 `.ci/r102-fixgate/suites/*.log`（**一次真的跑完了全部套件的运行**留下的原始输出）里数。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const R = 'D:/project/DSH/legion'
const dir = join(R, '.ci/r102-fixgate/suites')
if (!existsSync(dir)) { console.log('  x 找不到 r102-fixgate 的套件原始输出'); process.exit(1) }

const summary = JSON.parse(readFileSync(join(R, '.ci/r102-fixgate/summary.json'), 'utf8'))
console.log(`  summary.json：${JSON.stringify(summary.stages ?? summary).slice(0, 160)}`)

let totPass = 0
let totFail = 0
const rows = []

for (const f of readdirSync(dir).filter((x) => x.endsWith('.log'))) {
  const raw = readFileSync(join(dir, f), 'utf8')
  const pass = Number((raw.match(/^# pass (\d+)/m) ?? raw.match(/pass (\d+)/) ?? [])[1] ?? NaN)
  const fail = Number((raw.match(/^# fail (\d+)/m) ?? raw.match(/fail (\d+)/) ?? [])[1] ?? NaN)
  // 失败用例名：TAP 形状是 `not ok N - 名字`；node 的 spec reporter 是 `✖ 名字 (Nms)`
  const names = [...new Set([
    ...[...raw.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()),
    ...[...raw.matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)].map((m) => m[1].trim()),
  ])].filter((n) => !/^failing tests:$/.test(n))
  totPass += pass
  totFail += fail
  rows.push({ f, pass, fail, names })
}

rows.sort((a, b) => b.fail - a.fail)
console.log('')
console.log('  ── 那次 CI 里**每一个产出了原始输出的失败套件** ──')
for (const r of rows) {
  const label = r.f.replace(/\.log$/, '').replace(/_[^_]*$/, '')
  console.log(`    ${String(r.pass).padStart(3)} 通过 / ${String(r.fail).padStart(2)} 失败   ${label.slice(0, 62)}`)
  for (const n of r.names) console.log(`          ✖ ${n.slice(0, 104)}`)
}
console.log('')
console.log(`  ⇒ 这些失败套件合计：**${totPass} 通过 / ${totFail} 失败**（${rows.length} 个套件）`)
console.log(`  ★ 我第 100 轮报的是「5 套件 / 22 条」⇒ 差 ${rows.length - 5} 个套件、${totFail - 22} 条`)
