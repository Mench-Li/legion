// scratch/_mutate-r105-origincite.mjs —— 第 105 轮负控：把 `port.mjs` 的指针**改回 2241**，新判据会不会红？
//
// ★ 为什么必须做这一步：一条**绿**的判据，与一条**永远绿**的判据，在输出里长得一样。
//   实测口径：另起进程跑 CLI，看 `source-original-citations-on-line` 有没有从 ✔ 变 ✖。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const R = 'D:/project/DSH/legion'
const F = `${R}/runtime/adapters/dsh/port.mjs`
const SENTINEL = `${R}/scratch/.mutant-in-progress.json`
if (existsSync(SENTINEL)) { console.log('  ✖ 哨兵还在'); process.exit(1) }

const orig = readFileSync(F, 'utf8')
const LIVE = 'plugins/src/index.ts:1827 现场注释原文'
if (orig.split(LIVE).length - 1 !== 1) { console.log('  ✖ 找不到唯一的活锚点'); process.exit(1) }

function run() {
  try {
    const o = execFileSync('node', ['scripts/prt/boundary-facts.mjs', '--json'], { cwd: R, encoding: 'utf8', maxBuffer: 64e6 })
    return o
  } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}` }
}

const before = run()
const pick = (s) => {
  const j = JSON.parse(s.slice(s.indexOf('{')))
  const f = (j.facts ?? j.rows ?? []).find((x) => x.id === 'source-original-citations-on-line')
  return f ? { ok: f.ok, expected: String(f.expected).slice(0, 40), actual: String(f.actual).slice(0, 40) } : null
}

let b = null
try { b = pick(before) } catch { /* --json 可能不支持，退回文本 */ }
if (b === null) {
  console.log('  （--json 取不到该条，改用文本判定）')
  console.log(`  变异前：${/✔ source-original-citations-on-line/.test(before) ? '✔ 绿' : '✖ 红'}`)
}

writeFileSync(SENTINEL, JSON.stringify({ file: F, mutant: 'port.mjs 指针 1827 → 2241（漂 414 行那个原样）' }), 'utf8')
writeFileSync(F, orig.replace(LIVE, 'plugins/src/index.ts:2241 现场注释原文'), 'utf8')
const after = run()
writeFileSync(F, orig, 'utf8')
unlinkSync(SENTINEL)

let a = null
try { a = pick(after) } catch { /* ignore */ }
if (b && a) {
  console.log(`  变异前：ok=${b.ok}`)
  console.log(`  变异后：ok=${a.ok}`)
  console.log(`  变异后 actual = ${a.actual}`)
  console.log(`  ${b.ok === true && a.ok === false ? 'OK ★ 判据咬住了' : '★ 没咬住'}`)
} else {
  const okBefore = /✔ source-original-citations-on-line/.test(before)
  const okAfter = /✔ source-original-citations-on-line/.test(after)
  console.log(`  变异前：${okBefore ? '✔ 绿' : '✖ 红'}    变异后：${okAfter ? '✔ 绿' : '✖ 红'}`)
  console.log(`  ${okBefore && !okAfter ? 'OK ★ 判据咬住了' : '★ 没咬住'}`)
  const line = (after.split(/\r?\n/).find((l) => /source-original|port\.mjs:4[0-9]/.test(l)) ?? '').trim()
  if (line) console.log(`      输出：${line.slice(0, 150)}`)
}
console.log('  ✔ 原文件已还原，哨兵已清')
