/**
 * 挂死那一轮，宿主卡在哪？——把失败文案里那段日志尾部抓出来看。
 *
 * 背景见 `prt509-flake-rate.mjs`：预算 20s × 8 轮 ⇒ **4 轮正常（3.1–3.5s）/
 * 4 轮挂死**。**双峰**，没有"慢"的中间态。所以问题不是"给多少时间"，
 * 而是"它为什么有时候根本不退"。
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const BUDGET_MS = 20000

function once() {
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--test', FILE], {
      cwd: ROOT, windowsHide: true,
      env: { ...process.env, CI: 'true', PRT509_HOST_TIMEOUT_MS: String(BUDGET_MS) },
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', (code) => res({ code, all }))
  })
}

for (let i = 1; i <= 6; i++) {
  const r = await once()
  const hung = !/exit_code=0/.test(r.all)
  const m = /MEASURE[^\n]*/.exec(r.all)
  console.log(`\n${'='.repeat(72)}\n第 ${i} 轮：${hung ? '★ 挂死' : '正常'}  |  ${m ? m[0].trim() : '(无读数行)'}`)

  if (hung) {
    // 失败文案里带 `日志尾部：` —— 那是宿主进程自己的输出
    const idx = r.all.indexOf('日志尾部')
    const tail = idx === -1 ? '(文案里没有日志尾部)' : r.all.slice(idx, idx + 1600)
    console.log('--- 宿主输出尾部 ---')
    console.log(tail.split('\n').map((l) => '  ' + l.slice(0, 150)).join('\n'))
    // 也把探针读数相关的行抓出来
    const probe = r.all.split('\n').filter((l) => /探针|probe|pid|读到了|source/.test(l)).slice(0, 8)
    if (probe.length) {
      console.log('--- 与探针有关的行 ---')
      console.log(probe.map((l) => '  ' + l.trim().slice(0, 150)).join('\n'))
    }
    break // 抓到一个就够了
  }
}
