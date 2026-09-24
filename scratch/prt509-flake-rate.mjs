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
      const m = /MEASURE\s+prt509\.host_exit_seconds=([\d.]+)[^\n]*?exit_code=(\S+)(?:\s+settle=(\S+))?/.exec(all)
      // ⚠️ 这一格以前靠匹配 `探针读数 已写出` 那句中文——**那句话 2026-09-18 被改了措辞**，
      //    于是这一列静默地全变成"未写出"，而它与"真的没写出"看起来一样。
      //    ⇒ 改判 `settle`（机读约定，由 run-ci 的提取器背书），不再靠一句会变的中文。
      res({
        i, code, secs,
        hostSecs: m ? Number(m[1]) : null,
        exitCode: m ? m[2] : '(无读数行)',
        settle: m && m[3] ? m[3] : '(无 settle 格)',
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
    + `收场 ${String(r.settle).padEnd(23)} node 进程数 ${r.nodeProcs}`)
}

const hangs = rows.filter((r) => r.exitCode !== '0')
console.log('\n' + '='.repeat(70))
console.log(`预算 ${BUDGET_MS / 1000}s × ${ROUNDS} 轮`)
console.log(`  自然退出 ${rows.length - hangs.length} 轮 / 未自然退出 ${hangs.length} 轮`
  + ` ⇒ ${(hangs.length / rows.length * 100).toFixed(0)}%`)
const ok = rows.filter((r) => r.exitCode === '0').map((r) => r.hostSecs).filter((x) => x !== null)
if (ok.length) {
  console.log(`  自然退出那几轮的宿主耗时：${ok.join('s / ')}s`
    + `（min ${Math.min(...ok)} / max ${Math.max(...ok)}）`)
}
const settles = {}
for (const r of rows) settles[r.settle] = (settles[r.settle] ?? 0) + 1
console.log(`  收场分布：${Object.entries(settles).map(([k, v]) => `${k}×${v}`).join(', ')}`)
console.log(`  ⚠️ 本脚本只量"这一台机器、这一段时间"的率——**离开这个条件，这个数不作数**。`)
console.log(`  ⚠️ 2026-09-18 实测：同一个文件在空闲机器上 0/25、并发 4×4 下 0/16、`)
console.log(`     CI 在跑时 0/10 ⇒ 当时那个"≈50%"已作废（见 PRT-PROGRESS 的第二次订正）。`)
// ⚠️ 这一段以前会推断"进程数在变 ⇒ 挂死会留下累积的孤儿"。**那条推断是错的，已作废。**
//
//   反例就在本脚本自己的输出里：一跑 25 轮、**0 轮未退出**的那一次，
//   进程数照样在 6 与 7 之间跳。⇒ 进程数变化与"有没有挂死"**没有**那个关系
//   ——它多半来自 `countNodeProcs()` 自己起 PowerShell 的时序，以及同机的其他活动。
//
//   > 我当初是从**一次**并排的观测里读出那条因果的，
//   > 而它在"全部没挂"的数据里立刻不成立。
const procSeries = rows.map((r) => r.nodeProcs).join(' → ')
console.log(`  node 进程数采样（仅供参考）：${procSeries}`)
console.log('  ⚠️ 此前这里写着"进程数在变 ⇒ 挂死会留下孤儿"——**那条推断已作废**：'
  + '在 0 轮未退出的那次里它照样在变。进程数不是挂死的判据。')
