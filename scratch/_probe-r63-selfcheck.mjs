// scratch/_probe-r63-selfcheck.mjs —— 第 63 轮：把"执行器为什么拒绝自动执行"钉死到证据上
//
// ★ 第一版错了两处，两处都是探针自己的缺陷：
//   ① 用 `git grep` 传了一个带 `|` 的正则 ⇒ git 报 `Unmatched (`，
//      而我的 `catch` 把它吞成空数组 ⇒ 打印「**0 处**」——
//      **一个报错被读成了"一次都没有"。**
//   ② 用 `^FAIL ` 匹配存档日志，而日志行是**带缩进的** ⇒ 一条都没打出来。
//
//   > 「查不到」与「查出错」是同一个空数组 ——
//   > 而空数组读起来像"一次都没有"。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion/'
// ★ 每次调用都把 git 的 stderr 抛出来，不再吞
const grep = (pat, ...paths) => {
  const out = execFileSync('git', ['grep', '-n', '-e', pat, '--', ...paths],
    { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return out.trim() === '' ? [] : out.trim().split('\n')
}

const SVC = 'legionEnforcementRoot'
console.log(`  ① 服务名常量：${SVC}`)
const all = grep(SVC, '*.mjs')
console.log(`     全仓提到它的地方：**${all.length}** 处`)
const provides = all.filter((l) => /provide\s*\(/.test(l))
console.log(`     其中**真的 provide 它**的：**${provides.length}** 处`)
for (const p of provides) console.log(`       ${p.slice(0, 128)}`)
console.log('     （只被 import / 只被 inject 的，不算 provide）')
for (const l of all.filter((x) => /inject/.test(x)).slice(0, 5)) console.log(`       inject: ${l.slice(0, 120)}`)

console.log('\n  ② 那两行的 module 是不是 null（决定它们算不算"运行期行"）')
const pl = readFileSync(R + 'runtime/dsh-composition/patch-layer.mjs', 'utf8')
for (const id of ['runtime-host-registrar', 'runtime-contract-server']) {
  const at = pl.indexOf('`${LEGION_ROW_PREFIX}' + id + '`')
  const m = /module:\s*(null|'[^']*')/.exec(pl.slice(at, at + 1400))
  console.log(`     ${id}: module = ${m ? m[1] : '（没找到）'}`)
}

console.log('\n  ③ CI 存档 r51 里 FAIL 的套件（真跑出来的读数）')
const log = readFileSync(R + '.ci/r51/ci.log', 'utf8').split('\n')
let n = 0
for (const l of log) {
  if (/\bFAIL\b/.test(l) && /（/.test(l) && /exit=/.test(l)) {
    n += 1
    console.log(`     ${l.trim().slice(0, 116)}`)
  }
}
console.log(`     共 ${n} 条套件级 FAIL`)
