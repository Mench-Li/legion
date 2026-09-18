/**
 * PRT-509 凭据套件的**偶发率**：短预算下多跑几轮，把"偶发"变成一个数。
 *
 * ## 为什么用短预算
 *
 * 一个挂死的运行要等满预算才结束。用 20s 预算，挂死 20s 就结束、正常 3s 就结束
 * ⇒ 8 轮最坏 160s。**这是"把偶发变成率"最便宜的做法。**
 *
 * ## 为什么必须量而不是猜
 *
 * 2026-09-18 之前这条的归因换过三次：
 *   · "机器忙" ⇒ 被算术否掉（那次其余套件反而快 14.3%）；
 *   · "升预算不收敛" ⇒ 被 900s 那一次 CI PASS 否掉；
 *   · "CI 环境特有" ⇒ 被下面这个实验直接否掉（不设 CI 也会挂，设了 CI 反而过）。
 *
 * 三次都是**用一个解释代替一次测量**。
 *
 * ## 这一轮要回答的问题
 *
 *   ① 偶发率大概是多少？
 *   ② 挂死是否留下**孤儿进程**（若留，下一轮会受上一轮影响 ⇒ "偶发"可能其实是级联）
 *   ③ 挂死那一轮，探针读数写出了吗（决定"挂的到底是关停还是取数"）
 */
import { spawn, execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const ROUNDS = Number(process.argv[2] ?? 8)
const BUDGET_MS = Number(process.argv[3] ?? 20000)

function countNodeProcs() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Measure-Object).Count"],
    { encoding: 'utf8', windowsHide: true })
    return Number(out.trim())
  } catch { return -1 }
}

function once(i) {
  return new Promise((res) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, ['--test', FILE], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, CI: 'true', PRT509_HOST_TIMEOUT_MS: String(BUDGET_MS) },
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', (code) => {
      const secs = (Date.now() - t0) / 1000
      const m = /MEASURE\s+prt509\.host_exit_seconds=([\d.]+)[^\n]*exit_code=(\S+)/.exec(all)
      const probeWritten = /探针读数 已写出|探针读数已写出/.test(all)
      res({
        i, code, secs,
        hostSecs: m ? Number(m[1]) : null,
        exitCode: m ? m[2] : '(无读数行)',
        probeWritten,
        nodeProcs: countNodeProcs(),
      })
    })
  })
}

const rows = []
for (let i = 1; i <= ROUNDS; i++) {
  const r = await once(i)
  rows.push(r)
  const mark = r.exitCode === '0' ? '✔' : '✖'
  console.log(`${mark} 第 ${String(i).padStart(2)} 轮：套件退出码 ${String(r.code).padStart(4)}  `
    + `宿主 ${String(r.hostSecs).padStart(6)}s  墙钟 ${r.secs.toFixed(1).padStart(6)}s  `
    + `探针读数${r.probeWritten ? '已写出' : '未写出'}  node 进程数 ${r.nodeProcs}`)
}

const hangs = rows.filter((r) => r.exitCode !== '0')
console.log('\n' + '='.repeat(70))
console.log(`预算 ${BUDGET_MS / 1000}s × ${ROUNDS} 轮`)
console.log(`  正常 ${rows.length - hangs.length} 轮 / 挂死 ${hangs.length} 轮`
  + ` ⇒ 偶发率 ${(hangs.length / rows.length * 100).toFixed(0)}%`)
const ok = rows.filter((r) => r.exitCode === '0').map((r) => r.hostSecs).filter((x) => x !== null)
if (ok.length) {
  console.log(`  正常那几轮的宿主耗时：${ok.join('s / ')}s`
    + `（min ${Math.min(...ok)} / max ${Math.max(...ok)}）`)
}
if (hangs.length) {
  console.log(`  挂死那几轮探针读数：${hangs.map((r) => (r.probeWritten ? '已写出' : '未写出')).join(' / ')}`)
}
const procSeries = rows.map((r) => r.nodeProcs).join(' → ')
console.log(`  每轮后的 node 进程数：${procSeries}`)
console.log(`  ⇒ ${new Set(rows.map((r) => r.nodeProcs)).size === 1
  ? '进程数恒定 ⇒ 挂死**不**留下累积的孤儿'
  : '★ 进程数在变 ⇒ 挂死**会**留下东西，下一轮可能受上一轮影响'}`)
