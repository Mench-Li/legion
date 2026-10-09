// T-011 测试证据：忠实复刻 scripts/ci/run-ci.mjs 的「套件清单完备性」判定。
//
// 为什么是复刻而不是真跑：本沙箱内 Node 以 pipe stdio 派生子进程会 EPERM
// （见本任务 02 日志），run-ci.mjs 的 suite 执行与 `exec('git', ...)` 都走 spawn，
// 故 `node scripts/ci/run-ci.mjs --only test` 在本沙箱跑不起来。
//
// 复刻依据（scripts/ci/run-ci.mjs 当前 HEAD）：
//   :5104  const tracked = await exec('git', ['ls-files', '*.test.mjs'], { cwd: ROOT })
//   :5066-5071 listed = 每个 suite 的 files 按 cwd 归一成仓库相对路径
//   :5080  conditionalDirs = ['plugins/tests/', 'board-plugin/tests/']
//   :5100  conditionalFiles = { 'runtime/dsh-composition/patch-loadable.test.mjs' }
//   :5054  EXEMPT = { 'docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs' }
//   :5106-5110 missing = tracked - listed - conditionalDirs - conditionalFiles - EXEMPT
//   :5111-5115 missing.length>0 ⇒ listingIncomplete=true（test 阶段 FAIL）
//   :5183  ok: allOk && !listingIncomplete
//
// tracked 列表由 pwsh 预先执行 `git ls-files '*.test.mjs'` 写入 _tracked-tests.txt。
import { readFileSync } from 'node:fs'

const ROOT = process.cwd()
const ci = readFileSync('scripts/ci/run-ci.mjs', 'utf8')
const start = ci.indexOf('async function stageTest()')
const end = ci.indexOf('// ---------- L1 冒烟')
const region = ci.slice(start, end)

function literalsOf(s) {
  const set = new Set()
  for (const m of s.matchAll(/['"`]([^'"`\r\n]+\.test\.mjs)['"`]/g)) set.add(m[1].replace(/\\/g, '/'))
  return set
}
function stripComments(s) {
  let out = '', i = 0, state = null
  while (i < s.length) {
    const c = s[i], n = s[i + 1]
    if (state) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === state) state = null
      i += 1; continue
    }
    if (c === '"' || c === "'" || c === '`') { state = c; out += c; i += 1; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1; i += 2; continue }
    out += c; i += 1
  }
  return out
}
const literals = literalsOf(stripComments(region))
// 动态套件：whiteboard 的 files 来自 whiteboard/package.json 的 test 脚本（run-ci.mjs:4941-4945）
const wbPkg = JSON.parse(readFileSync('whiteboard/package.json', 'utf8'))
for (const t of String((wbPkg.scripts || {}).test || '').split(/\s+/).filter((t) => t.endsWith('.mjs'))) literals.add('whiteboard/' + t)

const conditionalDirs = ['plugins/tests/', 'board-plugin/tests/']
const conditionalFiles = new Set(['runtime/dsh-composition/patch-loadable.test.mjs'])
const EXEMPT = new Set(['docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs'])

const tracked = readFileSync('docs/T011-evidence/_tracked-tests.txt', 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
const missing = tracked.filter((f) => !literals.has(f) && !conditionalDirs.some((d) => f.startsWith(d)) && !conditionalFiles.has(f) && !EXEMPT.has(f))

console.log('HEAD tracked *.test.mjs      =', tracked.length)
console.log('listed（去注释后字面量 + 动态） =', literals.size)
console.log('conditionalDirs              =', JSON.stringify(conditionalDirs))
console.log('missing                      =', missing.length)
for (const m of missing) console.log('  MISSING  ' + m)
console.log('')
console.log('tests/e2e-acceptance/greet.test.mjs 有归属? ', literals.has('tests/e2e-acceptance/greet.test.mjs'))
console.log('=> 判定：' + (missing.length > 0 ? 'FAIL（listingIncomplete=true ⇒ test 阶段红）' : 'PASS'))
process.exit(missing.length > 0 ? 1 : 0)
