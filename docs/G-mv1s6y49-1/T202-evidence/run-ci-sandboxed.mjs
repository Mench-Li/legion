#!/usr/bin/env node
// run-ci-sandboxed.mjs —— 受限沙箱下的 CI 等价执行器（T-202 证据工具，非产品代码）
//
// 为什么需要它：scripts/ci/run-ci.mjs 的 exec() 用默认 stdio:'pipe' 捕获子进程输出，
// 而本会话的 DSH 沙箱（workspace-write）禁止 Node 进程创建管道：
//     node scripts/ci/run-ci.mjs --only syntax,env => 两个阶段都 exception: spawn EPERM
//     （原文见同目录 run-ci-attempt.log；栈在 run-ci.mjs:78 的 spawn）
//
// 本执行器做的是同一件事，只是换了一种输出运输方式：
//   * 被测文件集合逐字取自仓库：git ls-files '*.test.mjs' 去掉 run-ci 自己的 EXEMPT 表那一条
//     —— 那正是 CI test 阶段的覆盖面（套件清单完备性门禁保证 登记集合 == 仓库 *.test.mjs 集合（除豁免））。
//   * 每个测试文件单独一个进程（与 node --test 的每文件隔离同构），四路并发（CI 在同一套件内也是并发跑文件）。
//   * 计数用仓库自己的 scripts/ci/parse-suite-output.mjs 解析（同一个解析器）。
//   * stdio 用文件描述符（不是管道）；子进程内的 spawn/exec 由 ci-sandbox-patch.cjs 适配。
//
// 与 run-ci.mjs --only test 的真实差异（必须说清）：
//   ① 没有 node --test 聚合器：逐文件直跑（每个文件仍是独立进程，隔离粒度相同；聚合由本脚本做）。
//   ② --experimental-strip-types 对所有文件统一开启（CI 只对部分套件开）。
//   ③ 套件层面的 label/分组不产生；产物是逐文件读数 + 汇总。
//   ④ 条件套件（DSH_CHECKOUT / 浏览器）与 CI 一样：本机未配 ⇒ 用例自己逐条 skip。
//   以上四点都不改变被测行为，只改变 谁来聚合 与 输出怎么运回来。
//
// 用法：node docs/G-mv1s6y49-1/T202-evidence/run-ci-sandboxed.mjs --out .ci/T-202-full --deadline-min 45 --concurrency 4
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, closeSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSuiteCounts, countsFragment } from '../../../scripts/ci/parse-suite-output.mjs'

const SELF = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SELF, '..', '..', '..')
const args = process.argv.slice(2)
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt
}
const OUT = resolve(ROOT, getArg('out', '.ci/T-202-full'))
const DEADLINE_MIN = Number(getArg('deadline-min', '45'))
const CONCURRENCY = Number(getArg('concurrency', '4'))
const PER_FILE_TIMEOUT_MS = 300000
const PATCH = join(SELF, 'ci-sandbox-patch.cjs')
const EXEMPT = new Set(['docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs'])
// ★ 与真实 run-ci 对齐：plugins/ 与 board-plugin/ 是**条件套件目录**——只有 DSH_CHECKOUT
//   可用时 run-ci 才把它们 push 进 test 清单（run-ci.mjs:5215-5219），否则整组 SKIP。
//   本机未配 DSH_CHECKOUT ⇒ 这两组应从等价执行器的集合里同样排除，否则会把 40 个
//   「CI 本来就不跑」的外部宿主用例算成失败，读数失真。
const CONDITIONAL_DIRS = ['plugins/', 'board-plugin/']
const dshCheckout = process.env.DSH_CHECKOUT && existsSync(process.env.DSH_CHECKOUT) ? process.env.DSH_CHECKOUT : null

mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'ci.log')
writeFileSync(LOG, '')
const tee = (s) => { process.stdout.write(s + '\n'); appendFileSync(LOG, s + '\n') }

function gitLsFiles(pattern) {
  const o = join(OUT, '.git-ls-out'); const e = join(OUT, '.git-ls-err')
  const fo = openSync(o, 'w'); const fe = openSync(e, 'w')
  const r = spawnSync('git', ['ls-files', pattern], { cwd: ROOT, stdio: ['ignore', fo, fe] })
  closeSync(fo); closeSync(fe)
  if (r.status !== 0) throw new Error('git ls-files failed: ' + readFileSync(e, 'utf8').slice(0, 400))
  return readFileSync(o, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
}

function sh(cmd, argv) {
  const o = join(OUT, '.sh-out'); const fo = openSync(o, 'w')
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: ['ignore', fo, 'ignore'] })
  closeSync(fo)
  return r.status === 0 ? readFileSync(o, 'utf8') : ''
}

function killTree(pid) {
  if (!pid) return
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 尽力而为 */ }
}

/** 跑一个文件：文件 fd 作 stdio（本沙箱下管道会 EPERM）；子进程内 spawn 由 patch 适配。 */
function runFile(rel, slot) {
  return new Promise((resolvePromise) => {
    const o = join(OUT, '.out-' + slot); const e = join(OUT, '.err-' + slot)
    const fo = openSync(o, 'w'); const fe = openSync(e, 'w')
    const t0 = Date.now()
    const env = { ...process.env, CI: 'true', FORCE_COLOR: '0' }
    env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ' --require=' + PATCH).trim()
    const child = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, rel)], {
      cwd: ROOT, env, stdio: ['ignore', fo, fe], windowsHide: true,
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, PER_FILE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer); closeSync(fo); closeSync(fe)
      resolvePromise({ rel, code: -2, ms: Date.now() - t0, timedOut, out: '', err: String(err.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer); closeSync(fo); closeSync(fe)
      const out = readFileSync(o, 'utf8'); const errText = readFileSync(e, 'utf8')
      resolvePromise({ rel, code, ms: Date.now() - t0, timedOut, out, err: errText })
    })
  })
}

const files = gitLsFiles('*.test.mjs')
  .filter(f => !EXEMPT.has(f))
  .filter(f => dshCheckout || !CONDITIONAL_DIRS.some(d => f.startsWith(d)))
  .sort()
tee('Legion CI(等价) 受限沙箱执行器')
tee('  root=' + ROOT)
tee('  node=' + process.versions.node + ' platform=' + process.platform)
tee('  文件集合=git ls-files *.test.mjs（-' + EXEMPT.size + ' 条 EXEMPT；DSH_CHECKOUT=' + (dshCheckout || '未配置 ⇒ 按 run-ci 规则排除 ' + CONDITIONAL_DIRS.join(',')) + '）=> ' + files.length + ' 个')
tee('  逐文件独立进程，并发=' + CONCURRENCY + '；stdio=文件 fd；子进程 spawn 适配补丁=' + PATCH)
tee('  每文件超时=' + PER_FILE_TIMEOUT_MS + 'ms；全局截止=' + DEADLINE_MIN + 'min')
tee('  产物：' + OUT)

const deadline = Date.now() + DEADLINE_MIN * 60 * 1000
const results = new Array(files.length)
const failures = []
const total = { tests: 0, pass: 0, fail: 0, skipped: 0, nknown: 0 }
const startedAt = new Date().toISOString()
let nextIdx = 0
let doneCount = 0

async function worker(slot) {
  for (;;) {
    const i = nextIdx
    nextIdx += 1
    if (i >= files.length) return
    const rel = files[i]
    if (Date.now() > deadline) {
      results[i] = { file: rel, status: 'NOT_RUN', reason: 'deadline' }
      continue
    }
    const r = await runFile(rel, slot)
    const counts = parseSuiteCounts(r.out + '\n' + r.err)
    const ok = r.code === 0 && (Number.isNaN(counts.fail) || counts.fail === 0) && !r.timedOut
    if (!Number.isNaN(counts.tests)) total.tests += counts.tests
    if (!Number.isNaN(counts.pass)) total.pass += counts.pass
    if (!Number.isNaN(counts.fail)) total.fail += counts.fail
    if (!Number.isNaN(counts.skipped)) total.skipped += counts.skipped
    if (Number.isNaN(counts.tests)) total.nknown += 1
    results[i] = { file: rel, status: ok ? 'PASS' : 'FAIL', code: r.code, ms: r.ms, timedOut: r.timedOut, counts }
    doneCount += 1
    tee('[' + String(doneCount).padStart(3) + '/' + files.length + '] ' + (ok ? 'PASS' : 'FAIL') + ' ' + rel + ' exit=' + r.code + ' ' + countsFragment(counts) + ' ' + r.ms + 'ms')
    if (!ok) {
      const tail = (r.out + '\n' + r.err).split('\n').filter(l => l.trim()).slice(-18).join('\n      ')
      failures.push({ file: rel, code: r.code, timedOut: r.timedOut, counts, tail })
      tee('      ' + tail)
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, (_, k) => worker(k)))
for (let i = 0; i < results.length; i += 1) if (results[i] === undefined) results[i] = { file: files[i], status: 'NOT_RUN', reason: 'deadline' }

const failed = results.filter(r => r.status === 'FAIL').length
const notRun = results.filter(r => r.status === 'NOT_RUN').length
const summary = {
  tool: 'run-ci-sandboxed.mjs（受限沙箱下的 CI 等价执行器，非产品代码）',
  note: '逐文件独立进程 + 文件 fd stdio + ci-sandbox-patch.cjs 适配子进程 spawn；文件集合 == CI test 阶段覆盖面（git ls-files *.test.mjs - EXEMPT）',
  root: ROOT, node: process.versions.node, platform: process.platform, concurrency: CONCURRENCY,
  missing: files.filter(f => !readFileSync(LOG, 'utf8')),
  gitHead: sh('git', ['rev-parse', 'HEAD']).trim(),
  gitStatusPorcelain: sh('git', ['status', '--porcelain']).split('\n').filter(Boolean),
  startedAt, finishedAt: new Date().toISOString(),
  files: files.length, passed: results.filter(r => r.status === 'PASS').length, failed, notRun,
  totals: total, results, failureTails: failures,
}
delete summary.missing
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
tee('')
tee('===== SUMMARY =====')
tee('  文件 ' + summary.files + '：PASS ' + summary.passed + ' / FAIL ' + failed + ' / NOT_RUN ' + notRun)
tee('  用例合计 tests=' + total.tests + ' pass=' + total.pass + ' fail=' + total.fail + ' skipped=' + total.skipped + '（无摘要文件 ' + total.nknown + ' 个）')
tee('  产物 ' + join(OUT, 'summary.json'))
process.exit(failed === 0 && notRun === 0 ? 0 : 1)
