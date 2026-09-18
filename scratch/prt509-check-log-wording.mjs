/**
 * 最后一道自查：`[PRT-509]` 那行**给人读**的措辞，在两种收场下分别说了什么？
 *
 * 为什么要单独看这行：`MEASURE` 那行走 CI 摘要（机读），而这一行是**出问题时
 * 人第一眼看到的东西**。两种收场下它必须都能读懂，尤其是"证据未被轮询捕获"
 * 这个新措辞——它是我刚加的自纠，**没被任何别的脚本覆盖过**。
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'
const FORCE = resolve(ROOT, 'scratch', 'prt509-force-hang.cjs').replace(/\\/g, '/')

function once(forceHang) {
  return new Promise((res) => {
    const env = { ...process.env, CI: 'true', PRT509_HOST_TIMEOUT_MS: '240000' }
    if (forceHang) { env.PRT509_FORCE_HANG = '1'; env.NODE_OPTIONS = `--require "${FORCE}"` }
    const child = spawn(process.execPath, ['--test', FILE], { cwd: ROOT, windowsHide: true, env })
    let all = ''
    child.stdout.on('data', (d) => { all += d.toString() })
    child.stderr.on('data', (d) => { all += d.toString() })
    child.on('exit', () => {
      res(all.split('\n').filter((l) => l.includes('[PRT-509]') || l.startsWith('MEASURE')))
    })
  })
}

for (const [label, force] of [['A 不钉（natural）', false], ['B 钉住（killed-after-evidence）', true]]) {
  console.log(`\n──── ${label} ────`)
  for (const l of await once(force)) console.log('  ' + l.trim().slice(0, 175))
}
