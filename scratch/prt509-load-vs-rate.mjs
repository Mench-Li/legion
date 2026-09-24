/**
 * 把「宿主不退出」的**触发条件**量出来：是测试自身的一半概率，还是**并发负载**？
 *
 * ## 为什么必须问这个
 *
 * 上一批我量到"≈50% 挂死（双峰）"并把它写进了台账与会话报告。但那一批的读数是在
 * **另一个会话正在同一台机器上跑测试**的时候取的（本仓两个会话共用一个工作树）。
 *
 * 刚才在**空闲机器**上重测：提交版 **8/8 自然退出（0% 挂死）**。
 *
 * > 一个在"有别人在跑东西"时量出来的率，与一个"这个测试本身的率"，
 * > 在只有那张表的时候长得一模一样。
 *
 * ⇒ 这一轮要判定的是：负载是**原因**，还是**无关的背景**。
 *
 * ## 做法
 *
 * 同一个文件、同一个预算，两组：
 *   · **串行空闲**（对照，已知 ≈0%）；
 *   · **并发 4 份**（模拟"另一个会话在跑"）。
 * 如果并发组显著上升 ⇒ 负载是触发条件，之前那个"50%"必须带上条件重述。
 *
 * ## 一个必须避免的错误
 *
 * 不能把"并发"实现成"同一秒起 4 个然后各自超时"——那样超时的成因会是
 * **CPU 排队**而不是清理失败。所以两侧都用**同一个 20s 预算**，
 * 并且判据是**证据是否落盘 + 是否自然退出**（`settle=` 那一格），
 * 而不是"跑得快不快"。
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const BUDGET_MS = 20000

function once(round) {
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
      const m = /MEASURE\s+prt509\.host_exit_seconds=([\d.]+)[^\n]*?exit_code=(\S+)(?:\s+settle=(\S+))?/.exec(all)
      res({
        round, code, secs: (Date.now() - t0) / 1000,
        hostSecs: m ? Number(m[1]) : null,
        exitCode: m ? m[2] : '(无读数行)',
        settle: m && m[3] ? m[3] : '(无 settle 格)',
        suitePass: /pass 1/.test(all) && !/fail 1/.test(all),
      })
    })
  })
}

async function group(label, concurrency, rounds) {
  console.log(`\n${'='.repeat(78)}\n${label}（并发 ${concurrency} × ${rounds} 批）`)
  const rows = []
  for (let r = 1; r <= rounds; r++) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => once(`${r}.${i + 1}`)),
    )
    rows.push(...batch)
    const natural = batch.filter((x) => x.exitCode === '0').length
    const hung = batch.length - natural
    console.log(`  第 ${r} 批：自然退出 ${natural} / 未退出 ${hung}   `
      + `宿主耗时 ${batch.map((x) => (x.hostSecs === null ? '?' : x.hostSecs.toFixed(1))).join(', ')}s`)
  }
  const natural = rows.filter((x) => x.exitCode === '0')
  const notExit = rows.filter((x) => x.exitCode !== '0')
  const pass = rows.filter((x) => x.suitePass)
  console.log(`  ── ${label} 小计：${rows.length} 跑，自然退出 ${natural.length}，`
    + `未自然退出 ${notExit.length} ⇒ 率 ${(notExit.length / rows.length * 100).toFixed(0)}%`)
  console.log(`     宿主耗时（自然退出的）：${
    natural.map((x) => x.hostSecs.toFixed(1)).join(' / ') || '（无）'}s`)
  console.log(`     套件通过：${pass.length}/${rows.length}`)
  return { label, total: rows.length, notExit: notExit.length, rows }
}

const serial = await group('① 串行空闲（每次只跑一份）', 1, 6)
const conc = await group('② 并发 4 份（模拟同机另一个会话在跑）', 4, 4)

console.log('\n' + '='.repeat(78))
console.log('★ 判定：')
console.log(`  串行空闲：${serial.notExit}/${serial.total} 未退出`)
console.log(`  并发 4 份：${conc.notExit}/${conc.total} 未退出`)
if (conc.notExit > serial.notExit && conc.notExit > 0) {
  console.log('  ⇒ 并发组显著更高 ⇒ **并发负载是触发条件**。')
  console.log('     上一批那个"≈50%"必须重述为"**在有并发负载时**约 50%"。')
} else if (conc.notExit === 0 && serial.notExit === 0) {
  console.log('  ⇒ 两组都没复现。**这不能推出"缺陷不存在"**，只能说在本次机器状态下没触发。')
} else {
  console.log('  ⇒ 两组没有明显差别，负载**不是**（唯一的）触发条件。')
}
