// 从最新一次 CI 的 ci.log 里把"跳过"这件事摊开：
//   · 每个套件跳了几条
//   · **哪些套件报 PASS 却一条断言都没验过**（pass=0）
//
// 后者才是要紧的那一类：一个"跑了 0 条、报绿"的套件，
// 与一个"跑完 19 条全过、报绿"的套件，在 CI 摘要上是同一个东西。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ciDir = '.ci'
const newest = readdirSync(ciDir)
  .map((n) => ({ n, t: statSync(join(ciDir, n)).mtimeMs }))
  .filter((x) => statSync(join(ciDir, x.n)).isDirectory())
  .sort((a, b) => a.t - b.t)
  .pop().n
console.log('CI 产物：', join(ciDir, newest))

const log = readFileSync(join(ciDir, newest, 'ci.log'), 'utf8')
// 形如：PASS dsh-credentials（…）: exit=0 tests=165 pass=93 fail=0 skipped=72
const RE = /^(PASS|FAIL) (.+?)（.*?: exit=(\d+) tests=(\d+) pass=(\d+) fail=(\d+) skipped=(\d+)/
const rows = []
for (const line of log.split(/\r?\n/)) {
  const m = RE.exec(line.trim())
  if (m === null) continue
  rows.push({
    status: m[1], label: m[2],
    tests: Number(m[4]), pass: Number(m[5]), fail: Number(m[6]), skipped: Number(m[7]),
  })
}

const total = rows.reduce((a, r) => a + r.skipped, 0)
console.log(`套件数 = ${rows.length}　跳过合计 = ${total}`)
console.log('')

const zero = rows.filter((r) => r.pass === 0 && r.skipped > 0)
console.log('★ 报 PASS 而**一条断言都没验过**（pass=0）：')
for (const r of zero) {
  console.log('   ' + r.label.padEnd(44) + ` tests=${String(r.tests).padStart(3)} skipped=${r.skipped}`)
}
console.log(`   小计：${zero.length} 个套件 / ${zero.reduce((a, r) => a + r.skipped, 0)} 条断言`)
console.log('')

// 另一类：验过一些，但跳过比通过还多
const mostly = rows.filter((r) => r.pass > 0 && r.skipped > r.pass)
console.log('★ 跳过**多于**通过的套件：')
for (const r of mostly) {
  console.log('   ' + r.label.padEnd(44) + ` pass=${String(r.pass).padStart(3)} skipped=${r.skipped}`)
}
console.log(`   小计：${mostly.length} 个套件 / ${mostly.reduce((a, r) => a + r.skipped, 0)} 条跳过`)
console.log('')

// 按目录归类，看"跳过"集中在哪个平面
const byDir = new Map()
for (const r of rows) {
  if (r.skipped === 0) continue
  const d = r.label.split(/[（\s]/)[0]
  byDir.set(d, (byDir.get(d) ?? 0) + r.skipped)
}
console.log('★ 跳过最集中的套件（前 8）：')
for (const [k, v] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log('   ' + k.padEnd(44) + v)
}
