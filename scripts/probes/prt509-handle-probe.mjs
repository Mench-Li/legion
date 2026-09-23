/**
 * 抓一次挂死，并把**宿主进程内部**的句柄读数拿出来。
 *
 * 上一批的读数（双峰、约 50%、探针已写出、宿主零输出、不累积孤儿）
 * 已经把范围收窄到"取数之后、退出之前"，而 `prt509-tree-snapshot.mjs` 又否掉了
 * "父等在后代进程上"。⇒ 剩下最可能的解释是**事件循环里还有活句柄**。
 *
 * 这个脚本从**进程内部**回答它（`process._getActiveHandles()`），而不是从外面猜。
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const DUMP_DIR = resolve(ROOT, '.ci', 'prt509-handles')
const budgetMs = Number(process.argv[2] ?? 20000)
const maxRounds = Number(process.argv[3] ?? 6)
const DUMP_AT_MS = Number(process.argv[4] ?? 8000)

rmSync(DUMP_DIR, { recursive: true, force: true })
mkdirSync(DUMP_DIR, { recursive: true })

const PRELOAD = resolve(ROOT, 'scratch', 'prt509-handle-dump.cjs').replace(/\\/g, '/')

function oneRound() {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--test', FILE], {
      cwd: ROOT, windowsHide: true,
      env: {
        ...process.env,
        CI: 'true',
        PRT509_HOST_TIMEOUT_MS: String(budgetMs),
        PRT509_HANDLE_DUMP_MS: String(DUMP_AT_MS),
        PRT509_HANDLE_DUMP_DIR: DUMP_DIR,
        // ★ 只对**宿主**生效要靠它自己判断入口脚本，所以整棵树都注入。
        NODE_OPTIONS: `--require "${PRELOAD}"`,
      },
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', () => res({
      hung: !/exit_code=0/.test(all),
      measure: (/MEASURE[^\n]*/.exec(all) ?? ['(无 MEASURE 行)'])[0].trim(),
    }))
  })
}

/** 读 dump 目录里入口是 bin.js 的那一份（那才是宿主）。 */
function hostDumps() {
  if (!existsSync(DUMP_DIR)) return []
  return readdirSync(DUMP_DIR).map((f) => {
    const text = readFileSync(join(DUMP_DIR, f), 'utf8')
    return { file: f, text, isHost: text.includes('bin.js') }
  })
}

console.log(`预算 ${budgetMs / 1000}s × 最多 ${maxRounds} 轮；宿主在 ${DUMP_AT_MS / 1000}s 时自dump句柄\n`)
let hungRound = null
for (let i = 1; i <= maxRounds; i++) {
  const before = new Set(readdirSync(DUMP_DIR))
  const r = await oneRound()
  console.log(`第 ${i} 轮：${r.hung ? '★ 挂死' : '正常退出'}   ${r.measure}`)
  if (r.hung) { hungRound = i; break }
  // 清掉正常轮的 dump，免得和挂死轮混起来
  for (const f of readdirSync(DUMP_DIR)) if (!before.has(f)) rmSync(join(DUMP_DIR, f), { force: true })
}

console.log('\n' + '='.repeat(78))
const dumps = hostDumps()
console.log(`抓到的 dump 文件共 ${dumps.length} 个；其中入口是 bin.js 的（=宿主）${dumps.filter((d) => d.isHost).length} 个`)
if (hungRound === null) {
  console.log('⚠️ 这一轮没抓到挂死，本轮没有结论——**不要**把"没抓到"读成"问题不存在"')
} else {
  for (const d of dumps.filter((x) => x.isHost)) {
    console.log(`\n──── 宿主 ${d.file} ────`)
    console.log(d.text.trimEnd())
  }
  const others = dumps.filter((x) => !x.isHost)
  if (others.length) {
    console.log(`\n（另有 ${others.length} 份非宿主 dump：${others.map((o) => o.file).join(', ')}）`)
    console.log('──── 其中一份（node --test worker）作对照 ────')
    console.log(others[0].text.trimEnd())
  }
}
