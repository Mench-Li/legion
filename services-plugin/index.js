/**
 * @dsh-external/dsh-legion-services — 军团独立服务伴随 DSH Desktop 自动启停。
 *
 * Desktop（web profile）启动时，本插件自动拉起三个 legion 独立服务并**自愈重启**：
 *   1. team-hub v2    —— node team-hub/server.mjs            （:8787，SQLite 中枢，空间/编队/目标）
 *   2. 军团 v1 看板     —— node scrum/serve.mjs --port 4820     （:4820，指挥台数据源）
 *   3. 军团指挥台      —— node workbench/scripts/serve.mjs     （:5173，工作台 UI + /hub 代理 + /api/fs）
 * Desktop 退出时随插件 dispose 全部回收；某端口已有服务在监听则跳过（避免重复占用）。
 *
 * 本插件零外部依赖（cordis 仅注入 ctx），legion 根目录由插件自身位置推导，也可用 config.legionDir 覆盖。
 * 状态日志追加到 <legionDir>/.legion-services.log（并 echo 到宿主 stdout）。
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-legion-services'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const LEGION_DIR = join(SELF_DIR, '..')

export function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const legionDir = typeof cfg.legionDir === 'string' && cfg.legionDir.trim() ? cfg.legionDir : LEGION_DIR
  const logFile = join(legionDir, '.legion-services.log')
  const nodeBin = process.execPath
  const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

  const teamHubPort = num(cfg.teamHubPort, 8787)
  const boardPort = num(cfg.boardPort, 4820)
  const workbenchPort = num(cfg.workbenchPort, 5173)
  const boardToken = typeof cfg.boardToken === 'string' && cfg.boardToken ? cfg.boardToken : 'legion-kanban-4820'
  const hubUpstream = typeof cfg.hubUpstream === 'string' && cfg.hubUpstream.trim()
    ? cfg.hubUpstream.trim()
    : (typeof baseEnv.DSH_HUB_UPSTREAM === 'string' && baseEnv.DSH_HUB_UPSTREAM ? baseEnv.DSH_HUB_UPSTREAM : 'http://127.0.0.1:8787')

  const services = [
    {
      key: 'team-hub',
      label: `team-hub v2（:${teamHubPort}）`,
      port: teamHubPort,
      cwd: legionDir,
      args: [join(legionDir, 'team-hub', 'server.mjs')],
      env: { ...baseEnv, TEAM_HUB_PORT: String(teamHubPort) },
    },
    {
      key: 'kanban-v1',
      label: `军团 v1 看板（:${boardPort}）`,
      port: boardPort,
      cwd: legionDir,
      args: [join(legionDir, 'scrum', 'serve.mjs'), '--port', String(boardPort), '--host', '0.0.0.0', '--token', boardToken],
      env: baseEnv,
    },
    {
      key: 'workbench',
      label: `军团指挥台（:${workbenchPort}）`,
      port: workbenchPort,
      cwd: join(legionDir, 'workbench'),
      args: [join(legionDir, 'workbench', 'scripts', 'serve.mjs'), '--port', String(workbenchPort)],
      env: { ...baseEnv, DSH_HUB_UPSTREAM: hubUpstream },
    },
  ]

  let disposed = false
  const children = new Map()
  const restartTimers = new Set()
  const backoff = new Map() // key → 退避 ms（进程闪退时翻倍，上限 30s）

  function log(line) {
    const s = `[${new Date().toISOString()}] ${line}\n`
    try { appendFileSync(logFile, s) } catch { /* 日志文件不可写不影响服务 */ }
    try { process.stdout.write(s) } catch { /* ignore */ }
  }

  /** 探测某端口是否已在监听（避免与手动实例/残留进程抢端口）。 */
  function tcpOpen(port, host) {
    return new Promise((resolve) => {
      const sock = connect({ port, host: host || '127.0.0.1' })
      const done = (ok) => { try { sock.destroy() } catch { /* ignore */ } resolve(ok) }
      sock.setTimeout(500)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
  }

  async function startService(svc) {
    if (disposed || children.has(svc.key)) return
    if (await tcpOpen(svc.port)) {
      log(`[${svc.key}] ${svc.label}：端口 ${svc.port} 已有服务在监听 → 跳过启动`)
      return
    }
    let child
    try {
      child = spawn(nodeBin, svc.args, { cwd: svc.cwd, env: svc.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      log(`[${svc.key}] 启动失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    children.set(svc.key, child)
    child.startedAt = Date.now()
    let buf = ''
    const feed = (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) log(`[${svc.key}] ${line}`)
      }
      if (buf.length > 4000) buf = buf.slice(-2000)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (e) => {
      children.delete(svc.key)
      log(`[${svc.key}] ${svc.label} 启动错误：${e.message}`)
    })
    child.on('exit', (code, sig) => {
      children.delete(svc.key)
      const uptime = Date.now() - (child.startedAt ?? Date.now())
      log(`[${svc.key}] ${svc.label} 退出 code=${code} sig=${sig ?? ''}（存活 ${uptime}ms）`)
      if (disposed) return
      const delay = uptime < 8000 ? Math.min((backoff.get(svc.key) ?? 1000) * 2, 30000) : 1000
      backoff.set(svc.key, delay)
      const t = setTimeout(() => { restartTimers.delete(t); void startService(svc) }, delay)
      restartTimers.add(t)
    })
    log(`[${svc.key}] ${svc.label} 已启动：node ${svc.args.join(' ')}（cwd=${svc.cwd}）`)
  }

  function disposeAll() {
    disposed = true
    for (const t of restartTimers) clearTimeout(t)
    restartTimers.clear()
    for (const child of children.values()) {
      try { child.kill() } catch { /* ignore */ }
    }
    children.clear()
  }

  const bootTimer = setTimeout(() => {
    void (async () => {
      for (const svc of services) {
        await startService(svc)
        await new Promise(r => setTimeout(r, 150))
      }
    })()
  }, num(cfg.bootDelayMs, 1500))

  ctx.on('dispose', () => {
    clearTimeout(bootTimer)
    disposeAll()
    log('legion-services 已随宿主停止（全部子服务已回收）')
  })

  log(`legion-services 挂载：legionDir=${legionDir}，将托管 [${services.map(s => s.label).join('，')}]`)
}
