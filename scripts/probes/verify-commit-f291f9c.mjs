// 在**隔离 worktree**里验证 f291f9c 这一批：
//   ① 基线：runtime-contract-wiring 必须过（含 ①b′ / ①d）
//   ② 破坏性验证 ⑩：删掉 worker envNames 里的 `LEGION_WORKSPACE_DIR` 声明
//      ⇒ ①b′ 必须变红（这条此前在共享工作树上被中途杀掉、锚点丢失）
//   ③ 还原并确认还原成功
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'product/process-manifest.mjs'
const ANCHOR_RE = /\r?\n      'LEGION_WORKSPACE_DIR',(?=\r?\n)/
const SUITE = 'product/launcher/runtime-contract-wiring.test.mjs'
const PATTERN = 'Launcher 把'

function runTest(label) {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', '--test-name-pattern', PATTERN, SUITE], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000,
    })
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const m = /# (pass|fail) (\d+)/.exec(out)
  const lines = out.split(/\r?\n/).filter((l) => /^(ℹ|#) (tests|pass|fail) /.test(l.trim()) || /✖ .*①b′/.test(l))
  console.log(`--- ${label} ---`)
  for (const l of lines) console.log(l.trim())
  console.log(`SUMMARY ${JSON.stringify(Object.fromEntries([...out.matchAll(/ℹ (tests|pass|fail) (\d+)/g)].map((x) => [x[1], Number(x[2])])))}`)
  void m
  return out
}

const before = readFileSync(FILE, 'utf8')
if (!ANCHOR_RE.test(before)) { console.log('✖ 锚点不存在（⑩ 无法验证）'); process.exit(2) }

const baseline = runTest('baseline（未变异，必须全绿）')
const baselineFail = /ℹ fail (\d+)/.exec(baseline)
console.log(`baseline fail = ${baselineFail === null ? '?' : baselineFail[1]}`)

writeFileSync(FILE, before.replace(ANCHOR_RE, ''))
const mutated = runTest('mutated ⑩（删掉声明，①b′ 必须红）')

// 还原并核对
writeFileSync(FILE, before)
const restored = readFileSync(FILE, 'utf8')
console.log(`restored identical = ${restored === before}`)

const mutatedFail = /ℹ fail (\d+)/.exec(mutated)
const bit = mutatedFail !== null && Number(mutatedFail[1]) > 0
console.log(`\n★ ⑩ 咬住 = ${bit}（变异后 fail=${mutatedFail === null ? '?' : mutatedFail[1]}）`)
process.exit(bit && restored === before ? 0 : 1)
