/**
 * `runHost` 新分支的**正面对照**：把"宿主永不退出"这个情形造出来，
 * 看它是不是真的走 `killed-after-evidence`，以及**省了多少时间**。
 *
 * ## 为什么要专门验这一条
 *
 * 本批给 `runHost` 加了"证据到手就不干等"的逻辑（三种收场：
 * `natural` / `killed-after-evidence` / `timeout`）。而我今天观测到的**每一次**
 * 都是 `natural`：
 *
 *   > 一条只在"另一种情形"下才走的分支，在全是同一种情形的日志里，
 *   > 与"根本没接上"长得一模一样。
 *
 * 所以必须**主动造出**那个情形。办法：`NODE_OPTIONS=--require <force-hang>`
 * 把宿主钉住（只钉宿主，不钉 `node --test` worker——否则套件自己就不结束，
 * 得到的会是"测试挂死"的假象而不是被测分支的读数）。
 *
 * ## 三组
 *
 * · **A 对照（不钉）**  ⇒ 期望 `settle=natural`，耗时 ≈3s
 * · **B 钉住**         ⇒ 期望 `settle=killed-after-evidence`，耗时 ≈证据+宽限（~18s）
 * · **C 钉住 + 证据永不出现** ⇒ 走不到（本套件的证据一定会写出），
 *   所以 `timeout` 那一支**本脚本覆盖不到**，如实说明，不假装覆盖了
 *
 * ★ B 组的第二个读数才是关键：**它省了多少**。
 *   若 B 组仍要 ~240s，那这条分支只是换了个名字，没解决问题。
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const FORCE = resolve(ROOT, 'scratch', 'prt509-force-hang.cjs').replace(/\\/g, '/')
const BUDGET_MS = 240000 // 与产品默认一致：这样"省了多少"才是真数字
const GRACE_MS = 15000

function once({ forceHang }) {
  return new Promise((res) => {
    const t0 = Date.now()
    const env = { ...process.env, CI: 'true', PRT509_HOST_TIMEOUT_MS: String(BUDGET_MS) }
    if (forceHang) {
      env.PRT509_FORCE_HANG = '1'
      env.NODE_OPTIONS = `--require "${FORCE}"`
    }
    const child = spawn(process.execPath, ['--test', FILE], { cwd: ROOT, windowsHide: true, env })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', (code) => {
      const m = /MEASURE\s+prt509\.host_exit_seconds=([\d.]+)[^\n]*?exit_code=(\S+)(?:\s+settle=(\S+))?/.exec(all)
      res({
        code, wallSecs: (Date.now() - t0) / 1000,
        hostSecs: m ? Number(m[1]) : null,
        exitCode: m ? m[2] : '(无读数行)',
        settle: m && m[3] ? m[3] : '(无 settle 格)',
        suitePass: /ℹ pass 1/.test(all) && !/ℹ fail 1/.test(all),
        forced: /\[FORCE-HANG\]/.test(all),
      })
    })
  })
}

function report(label, r, expect) {
  const ok = r.settle === expect
  console.log(`\n${ok ? '✔' : '✖'} ${label}`)
  console.log(`     收场 settle=${r.settle}（期望 ${expect}）`)
  console.log(`     套件 ${r.suitePass ? 'PASS' : 'FAIL'}  退出码 ${r.code}  wall ${r.wallSecs.toFixed(1)}s`)
  console.log(`     宿主读数 exit_code=${r.exitCode} host_exit_seconds=${r.hostSecs}  预算 ${BUDGET_MS / 1000}s`)
  if (r.forced) console.log('     （shim 已生效：日志里出现了 [FORCE-HANG]）')
  return ok
}

console.log(`预算 ${BUDGET_MS / 1000}s（= 产品默认），宽限应≈${GRACE_MS / 1000}s\n`)

console.log('── A 对照（不钉宿主）──')
const a = await once({ forceHang: false })
const aOk = report('A 不钉 ⇒ 应走 natural', a, 'natural')

console.log('\n── B 钉住宿主（造出"永不退出"）──')
const b = await once({ forceHang: true })
const bOk = report('B 钉住 ⇒ 应走 killed-after-evidence', b, 'killed-after-evidence')

console.log('\n' + '='.repeat(78))
console.log('★ 判定')
console.log(`  A 分支可用：${aOk ? '✔' : '✖'}`)
console.log(`  B 分支可用：${bOk ? '✔' : '✖'}`)
if (aOk && bOk) {
  const saved = (BUDGET_MS / 1000) - b.wallSecs
  console.log(`  ⇒ 两个分支都真的走通了。`)
  console.log(`     B 组用 ${b.wallSecs.toFixed(1)}s 收场，而不是干等满 ${BUDGET_MS / 1000}s`
    + ` ⇒ **省了约 ${saved.toFixed(0)}s**（${(b.wallSecs / (BUDGET_MS / 1000) * 100).toFixed(0)}% 的预算）。`)
  console.log(`     ★ 这才是本条改动的价值：不是"变绿"，是**不再为一件不会发生的事白等**。`)
} else {
  console.log('  ⚠️ 有分支没走通 —— **不要**把"今天没复现"当作"分支没问题"。')
}
console.log('\n⚠️ 本脚本**没有**覆盖 `timeout` 那一支（证据始终不出现）——')
console.log('   本套件的证据一定会写出，所以那一支造不出来。如实说明，不假装覆盖了。')
