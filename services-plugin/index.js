/**
 * @dsh-external/dsh-legion-services — 军团独立服务伴随 DSH Desktop 自动启停。
 *
 * Desktop（web profile）启动时，本插件自动拉起 legion 独立服务并**自愈重启**：
 *   1. team-hub v2    —— node team-hub/server.mjs            （:8787，SQLite 中枢，空间/编队/目标）
 *   2. 军团指挥台      —— node workbench/scripts/serve.mjs     （:5173，工作台 UI + /hub 代理 + /api/fs）
 * Desktop 退出时随插件 dispose 全部回收；某端口已有服务在监听则跳过（避免重复占用）。
 *
 * P1-1 第 2 步退役：v1 看板（scrum/serve.mjs :4820）不再托管——v1 文件库
 * （scrum/tasks.json）退役，看板数据面统一走 team-hub v2。serve.mjs 文件保留
 * （v1v2-contract 测试 import 复用 + 本地自托管），仅生产不再自动拉起。
 *
 * 本插件零外部依赖（cordis 仅注入 ctx）。legion 根目录解析顺序：config.legionDir →
 * 插件自身位置（源码直跑时 = 仓库根）→ 默认 'D:/project/DSH/legion'。
 * ⚠ pnpm 对 file: 依赖是「复制快照」：运行时 import.meta.url 指向 profile 的 node_modules 副本，
 *   靠自身位置推断会找错根目录——patch config 里应显式给 legionDir（或依赖下方硬编码默认值兜底）。
 * 状态日志追加到 <legionDir>/.legion-services.log（并 echo 到宿主 stdout）。
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-legion-services'

// Desktop/web 的宿主地址来自 webServer；Cordis 要求先声明服务依赖。
// `connection` 是 BUG-014 第二层修法的来源：只有它能铸出那条带 `?token=` 的**操作员登录 URL**
// （DSH 桌面壳给窗口登录用的就是它）。少声明它，`ctx.connection` 在这里恒为 undefined，
// 症状是"登录按钮永远说宿主没注入地址" —— 又一个静默的不生效。
export const inject = ['webServer', 'connection']

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_LEGION_DIR = 'D:/project/DSH/legion'

/** 目录看起来像 legion 仓库根（关键入口都在）。 */
function looksLikeLegionRoot(p) {
  try {
    return existsSync(join(p, 'team-hub', 'server.mjs'))
      && existsSync(join(p, 'scrum', 'serve.mjs'))
      && existsSync(join(p, 'workbench', 'scripts', 'serve.mjs'))
  } catch { return false }
}

/**
 * 派生 workbench 要用的 **DSH 宿主地址**（Bug #1「供应商与模型无法读取」）。
 *
 * 模型配置 Remote 直连的是**本次启动的宿主**：Desktop 部署实测在 19387，而指挥台此前把它
 * 写死成 3080 ⇒ 三个读取方法全部连不上，「供应商与模型」整页读不出来，界面只报一句
 * `fetch failed`。与 `DSH_HUB_UPSTREAM` 是同一条教训（`product/config-schema.mjs` 的 injects 表）。
 *
 * 优先级：composition 的 `config.dshModelsBaseUrl` > 宿主 `ctx.webServer.port` > 宿主的 `DSH_WEB_URL`。
 * 三者都拿不到时返回 `''`——**不编一个默认值**：编了就会得到"看起来配了、其实指向没人监听的端口"
 * 这种最难查的形状。调用方据此在启动日志里说清楚这一轮有没有注入成功。
 *
 * 抽成纯函数是为了**能测**：一个只能靠"看日志像不像"来确认的派生逻辑，
 * 与一个没有派生逻辑的部署，在事故现场长得一样。
 */
export function deriveDshModelsBaseUrl({ configured = '', webServerPort = null, env = {} } = {}) {
  const explicit = String(configured ?? '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const port = Number(webServerPort)
  if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}`
  try {
    const url = new URL(String(env.DSH_WEB_URL ?? ''))
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch { /* 宿主没给 DSH_WEB_URL：调用方按"没注入"记一笔 */ }
  return ''
}

/**
 * workbench 子进程要拿到的环境（**每次 spawn 现算**，所以宿主端口后到也拿得到）。
 *
 * 抽出来的理由与 `deriveDshModelsBaseUrl` 相同：能被断言的东西，才拦得住回归。
 * 特别是"取不到宿主就不注入"这一条——静默注入一个默认地址会退化成 Bug #1 的形状。
 */
export function buildWorkbenchEnv({ baseEnv = {}, hubUpstream = '', teamHubToken = '', dshModelsBaseUrl = '', dshModelsLoginUrl = '' } = {}) {
  return {
    ...baseEnv,
    DSH_HUB_UPSTREAM: hubUpstream,
    TEAM_HUB_TOKEN: teamHubToken,
    ...(dshModelsBaseUrl ? { DSH_MODELS_BASE_URL: dshModelsBaseUrl } : {}),
    ...(dshModelsLoginUrl ? { DSH_MODELS_LOGIN_URL: dshModelsLoginUrl } : {}),
  }
}

/**
 * 派生「宿主操作员一次性登录 URL」（BUG-014 的第二层：桥接层 → 宿主的 401）。
 *
 * 背景：宿主 `/api/*` 只认它**自己的浏览器会话**（`browser-auth.ts`：按 authority 签名、
 * 30 天、authority 绑定）。桥接层转发的是浏览器自己的 cookie，而普通浏览器里没有那条 cookie
 * ⇒ 无论地址多正确，那三个读取永远是 401。
 *
 * 修法（设计 A，将军 2026-10-09 裁决）：**让用户的浏览器登一次**。宿主进程里的本插件
 * 可以拿到那条带 `?token=<launchToken>` 的 URL（DSH 自己的桌面壳就是这么给窗口登录的：
 * `apps/desktop-host/src/index.ts` 的 `ctx.connection.authenticatedUrl(...)`），
 * 把它交给指挥台；指挥台在用户点「连接 DSH 服务」时让浏览器**顶层导航**过去，
 * 宿主随即种下会话 cookie（cookie 按主机存放、不按端口隔离），于是同一个浏览器里的
 * `:5173` 与 `:19387` 就共享了它。
 *
 * ★ 与 `deriveDshModelsBaseUrl` 同一条纪律：**拿不到就返回空，不编一个地址**。
 *   而且这里多一道判据 —— 拿到的 URL 必须**真的带 `token=`**：
 *   一个"看起来配了、其实没有令牌"的地址，与一个没配的地址，在界面上是同一种失败
 *   （又一个 BUG-001 形状）。
 */
export function deriveDshModelsLoginUrl({ connection = null, webServerPort = null } = {}) {
  const port = Number(webServerPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return ''
  if (connection === null || typeof connection.authenticatedUrl !== 'function') return ''
  try {
    const url = connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
    if (typeof url !== 'string' || !url) return ''
    // 令牌必须真的在里面：否则这条 URL 只会把浏览器带到宿主的 401 页
    return new URL(url).searchParams.get('token') ? url : ''
  } catch { return '' }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const cfgDir = typeof cfg.legionDir === 'string' && cfg.legionDir.trim() ? cfg.legionDir.trim() : ''
  const selfParent = join(SELF_DIR, '..')
  const legionDir = (cfgDir && looksLikeLegionRoot(cfgDir) && cfgDir)
    || (looksLikeLegionRoot(selfParent) && selfParent)
    || (looksLikeLegionRoot(DEFAULT_LEGION_DIR) && DEFAULT_LEGION_DIR)
    || ''
  const logFile = join(legionDir || SELF_DIR, '.legion-services.log')
  const nodeBin = process.execPath
  const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

  const teamHubPort = num(cfg.teamHubPort, 8787)
  const teamHubHost = typeof cfg.teamHubHost === 'string' && cfg.teamHubHost.trim()
    ? cfg.teamHubHost.trim()
    : (typeof baseEnv.TEAM_HUB_HOST === 'string' && baseEnv.TEAM_HUB_HOST.trim() ? baseEnv.TEAM_HUB_HOST.trim() : '127.0.0.1')
  const teamHubToken = typeof cfg.teamHubToken === 'string' && cfg.teamHubToken
    ? cfg.teamHubToken
    : (typeof baseEnv.TEAM_HUB_TOKEN === 'string' ? baseEnv.TEAM_HUB_TOKEN : '')
  const workbenchPort = num(cfg.workbenchPort, 5173)
  const hubUpstream = typeof cfg.hubUpstream === 'string' && cfg.hubUpstream.trim()
    ? cfg.hubUpstream.trim()
    : (typeof baseEnv.DSH_HUB_UPSTREAM === 'string' && baseEnv.DSH_HUB_UPSTREAM ? baseEnv.DSH_HUB_UPSTREAM : 'http://127.0.0.1:8787')

  const cfgDshModelsBaseUrl = typeof cfg.dshModelsBaseUrl === 'string' ? cfg.dshModelsBaseUrl.trim() : ''
  /** ★ 宿主地址是**派生值**，不是默认值（Bug #1「供应商与模型无法读取」）。
   *  宿主端口要等 composition 把 webServer 挂起来才拿得到，所以**每次启动现取**
   *  （不在 apply 时固化成常量——那正是"看起来配了、其实取不到"的来源）。 */
  const resolveDshModelsBaseUrl = () => deriveDshModelsBaseUrl({
    configured: cfgDshModelsBaseUrl, webServerPort: ctx?.webServer?.port, env: baseEnv,
  })
  /** ★ 同上：登录 URL 每次 spawn 现取（令牌可能是新的一轮进程令牌，固化就等于发一个过期的）。 */
  const resolveDshModelsLoginUrl = () => deriveDshModelsLoginUrl({
    connection: ctx?.connection ?? null, webServerPort: ctx?.webServer?.port,
  })

  const services = [
    {
      key: 'team-hub',
      label: `team-hub v2（:${teamHubPort}）`,
      port: teamHubPort,
      cwd: legionDir,
      args: [join(legionDir, 'team-hub', 'server.mjs')],
      env: { ...baseEnv, TEAM_HUB_PORT: String(teamHubPort), TEAM_HUB_HOST: teamHubHost, TEAM_HUB_TOKEN: teamHubToken },
    },
    {
      key: 'workbench',
      label: `军团指挥台（:${workbenchPort}）`,
      port: workbenchPort,
      cwd: join(legionDir, 'workbench'),
      args: [join(legionDir, 'workbench', 'scripts', 'serve.mjs'), '--port', String(workbenchPort)],
      // 宿主端口要等 composition 把 webServer 挂起来才拿得到，所以**每次启动现取**
      // （不在 apply 时固化成常量——那正是"看起来配了、其实取不到"的来源）。
      env: () => buildWorkbenchEnv({
        baseEnv, hubUpstream, teamHubToken, dshModelsBaseUrl: resolveDshModelsBaseUrl(),
        dshModelsLoginUrl: resolveDshModelsLoginUrl(),
      }),
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

  if (!legionDir) {
    log('✗ 未找到 legion 仓库根（config.legionDir 无效且插件不在源码目录、默认目录不存在）→ 本次不托管任何服务')
    return
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
    if (disposed) return
    let child
    const svcEnv = typeof svc.env === 'function' ? svc.env() : svc.env
    try {
      child = spawn(nodeBin, svc.args, { cwd: svc.cwd, env: svcEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      if (disposed) return
      const dshModelsBaseUrl = resolveDshModelsBaseUrl()
      log(dshModelsBaseUrl
        ? `模型配置宿主地址 DSH_MODELS_BASE_URL=${dshModelsBaseUrl}（派生自本次启动的宿主；Bug #1：写死 3080 时「供应商与模型」读不出来）`
        : '取不到宿主端口（ctx.webServer.port / DSH_WEB_URL 都没有）→ 不注入 DSH_MODELS_BASE_URL，workbench 将按自身默认回落；Desktop 部署下「供应商与模型」可能读不出来')
      // ★ 只报"注入了没有"，**绝不打印这条 URL 本身**：它携带的是宿主的操作员进程令牌，
      //   而这个日志文件（`.legion-services.log`）是明文、且长期留存。
      //   一条把令牌写进日志的"方便排查"，就是把一次登录换成一份永久凭证。
      const dshModelsLoginUrl = resolveDshModelsLoginUrl()
      log(dshModelsLoginUrl
        ? '模型配置登录地址 DSH_MODELS_LOGIN_URL=已注入（携带宿主操作员令牌，故不打印；BUG-014：宿主 /api 只认它自己的浏览器会话）'
        : '未注入 DSH_MODELS_LOGIN_URL（取不到 ctx.connection.authenticatedUrl 或没带 token）→ 指挥台的「供应商与模型」会在桥接层拿到 401；那是**凭证**缺，不是地址错')
      for (const svc of services) {
        if (disposed) return
        await startService(svc)
        await new Promise(r => setTimeout(r, 150))
      }
    })()
  }, num(cfg.bootDelayMs, 1500))

  // effect 清理随插件卸载执行；普通 dispose 事件不代表 Cordis 生命周期。
  ctx.effect(() => () => {
    clearTimeout(bootTimer)
    disposeAll()
    log('legion-services 已随宿主停止（全部子服务已回收）')
  })

  const dirSource = cfgDir && looksLikeLegionRoot(cfgDir) ? 'config.legionDir'
    : (looksLikeLegionRoot(selfParent) ? '插件自身位置（源码直跑）' : '内置默认值')
  log(`legion-services 挂载：legionDir=${legionDir}（来源：${dirSource}），将托管 [${services.map(s => s.label).join('，')}]`)
}
