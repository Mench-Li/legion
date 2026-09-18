/**
 * 对比"正常轮"与"挂死轮"的**时间线**，直接读出双峰差在哪一步。
 *
 * 探针（`prt509-handle-dump.cjs`）每秒记一行句柄归类，并记下
 * `process.exit()` 是否被调用（带调用栈）与 `exit` 事件是否触发。
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const DIR = resolve(ROOT, '.ci', 'prt509-timeline')
const budgetMs = Number(process.argv[2] ?? 20000)
const wantNormal = Number(process.argv[3] ?? 1)
const wantHung = Number(process.argv[4] ?? 1)

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const PRELOAD = resolve(ROOT, 'scratch', 'prt509-handle-dump.cjs').replace(/\\/g, '/')

function oneRound(tag) {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--test', FILE], {
      cwd: ROOT, windowsHide: true,
      env: {
        ...process.env,
        CI: 'true',
        PRT509_HOST_TIMEOUT_MS: String(budgetMs),
        PRT509_HANDLE_DUMP_MS: '1000',
        PRT509_HANDLE_DUMP_DIR: DIR,
        PRT509_ROUND_TAG: tag,
        NODE_OPTIONS: `--require "${PRELOAD}"`,
      },
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', () => res({
      tag,
      hung: !/exit_code=0/.test(all),
      measure: (/MEASURE[^\n]*/.exec(all) ?? ['(无)'])[0].trim(),
    }))
  })
}

function readLogs() {
  if (!existsSync(DIR)) return {}
  const out = {}
  for (const f of readdirSync(DIR).filter((x) => x.startsWith('host-'))) {
    out[f] = readFileSync(join(DIR, f), 'utf8')
  }
  return out
}

function showLog(text, label) {
  const lines = text.trimEnd().split('\n')
  console.log(`\n──── ${label}（${lines.length} 行）────`)
  for (const l of lines) console.log('  ' + l.replace(/\s+$/, '').slice(0, 168))
}

const results = []
let nGot = 0; let hGot = 0
for (let i = 1; i <= 14 && (nGot < wantNormal || hGot < wantHung); i++) {
  const before = new Set(Object.keys(readLogs()))
  const r = await oneRound(`round${i}`)
  console.log(`第 ${String(i).padStart(2)} 轮：${r.hung ? '★ 挂死' : '正常'}   ${r.measure}`)
  const after = readLogs()
  const fresh = Object.entries(after).filter(([k]) => !before.has(k))
  // 把新日志改名带上标签，便于区分正常/挂死
  for (const [k, v] of fresh) {
    const dest = join(DIR, `${r.hung ? 'HUNG' : 'NORMAL'}-${k}`)
    try { require('node:fs').writeFileSync(dest, v, 'utf8'); rmSync(join(DIR, k), { force: true }) } catch { /* */ }
  }
  if (r.hung) hGot++; else nGot++
  results.push({ ...r, fresh: fresh.length })
}

console.log('\n' + '='.repeat(80))
const files = existsSync(DIR) ? readdirSync(DIR) : []
const normals = files.filter((f) => f.startsWith('NORMAL-'))
const hungs = files.filter((f) => f.startsWith('HUNG-'))
console.log(`正常轮日志 ${normals.length} 份 / 挂死轮日志 ${hungs.length} 份`)

if (normals.length) showLog(readFileSync(join(DIR, normals[0]), 'utf8'), `正常轮（${normals[0]}）`)
if (hungs.length) showLog(readFileSync(join(DIR, hungs[hungs.length - 1]), 'utf8'), `挂死轮（${hungs[hungs.length - 1]}）`)

console.log('\n' + '='.repeat(80))
console.log('★ 关键对比：')
for (const [label, list] of [['正常', normals], ['挂死', hungs]]) {
  if (!list.length) { console.log(`  ${label}：这一批没抓到`); continue }
  const text = readFileSync(join(DIR, list[0]), 'utf8')
  const exitCalled = /\[EXIT-CALLED\]/.test(text)
  const exitEvent = /\[EXIT-EVENT\]/.test(text)
  const watchCount = (text.match(/\[WATCH\]/g) ?? []).length
  const lastTick = (text.split('\n').filter((l) => l.startsWith('[TICK]')).pop() ?? '(无 TICK)')
  console.log(`  ${label}：process.exit() ${exitCalled ? '**被调用**' : '未被调用'}；`
    + `exit 事件 ${exitEvent ? '触发' : '未触发'}；fs.watch 创建 ${watchCount} 次`)
  console.log(`        最后一个 TICK：${lastTick.trim()}`)
}
