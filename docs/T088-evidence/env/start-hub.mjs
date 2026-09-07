// T-088 L1/L2 测试脚手架：以真实 team-hub server.mjs 起临时实例（stdio ignore，沙箱允许）
// 非交付物修改：不触碰任何产品源码；仅测试进程编排。env: TEAM_HUB_DB / TEAM_HUB_PORT
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..') // env -> T088-evidence -> docs -> worktree root
const tmpRoot = mkdtempSync(join(tmpdir(), 't088-hub-'))
const dbFile = join(tmpRoot, 'hub.db')
const port = Number(process.env.TEAM_HUB_PORT ?? 8791) // 8791=测试隔离端口（8787 为线上真实中枢，禁写）
const server = join(root, 'team-hub', 'server.mjs')

const child = spawn(process.execPath, [server], {
  stdio: 'ignore',
  env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port) },
})
console.log('hub-launcher: spawned server.mjs pid=' + child.pid + ' port=' + port + ' db=' + dbFile)
child.on('exit', (code, sig) => { console.log('hub-launcher: server exited code=' + code + ' sig=' + sig); process.exit(0) })
const kill = () => { try { child.kill() } catch {} }
process.on('SIGINT', kill)
process.on('SIGTERM', kill)

// 简单就绪探测
const t0 = Date.now()
;(async () => {
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/config')
      if (r.ok) { console.log('hub-launcher: READY ' + (await r.text()).slice(0, 120));
      // 保活：驻留不退出，由外层后台任务持有（kill 时 SIGTERM→child.kill 清理）
      await new Promise(() => {}) }
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 300))
  }
  console.log('hub-launcher: NOT READY within 15s'); await new Promise(() => {})
})()
// 保活：就绪后仍驻留由外层 pwsh 后台任务持有（本进程在被 kill 前不退）