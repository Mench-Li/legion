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
// P2：影子对账。单独成文件是为了让"只读"这件事**在一个文件里可以被扫**——
// `shadow-materialize.mjs` 里一次都不出现 mutate/set/unset（有用例钉住）。
import { runShadowMaterialization } from './shadow-materialize.mjs'
import { readDshProviderSnapshot } from './dsh-snapshot.mjs'
// P3：接管写入 + 从 Legion 的受保护库取值。
import { runMaterialization } from './materializer.mjs'
import { createLegionSecretReader } from './legion-secrets.mjs'
// P4：周期收敛的调度（递归 setTimeout ⇒ 不重叠是构造上的性质）。
import { createReconcileSchedule } from './reconcile-schedule.mjs'

export const name = '@dsh-external/dsh-legion-services'

// Desktop/web 的宿主地址来自 webServer；Cordis 要求先声明服务依赖。
//
// ★ `connection` **故意不写在这里**（BUG-014 第二层）。它只是可选的**增强**：
//   拿来铸那条操作员登录 URL。而 Cordis 的 `inject` 是**硬依赖** —— 名字写进来而组合里没有它，
//   整个插件会停在 pending，于是 **team-hub 与指挥台都不会启动**。
//   一个"锦上添花"的能力绝不能带"少一个服务就什么都不起"的失败模式。
//   DSH 自己的 `web-app` 就是这么分的：`export const inject = ['webServer']`（硬）
//   + `ctx.inject(['connection'], …)`（软）。这里用 `ctx.get('connection')` 走同一条路：
//   拿不到 ⇒ 返回空 ⇒ 日志说"未注入"，服务照常起。
export const inject = ['webServer']

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
export function buildWorkbenchEnv({ baseEnv = {}, hubUpstream = '', teamHubToken = '', dshModelsBaseUrl = '' } = {}) {
  return {
    ...baseEnv,
    DSH_HUB_UPSTREAM: hubUpstream,
    TEAM_HUB_TOKEN: teamHubToken,
    ...(dshModelsBaseUrl ? { DSH_MODELS_BASE_URL: dshModelsBaseUrl } : {}),
  }
}

// ★ 这里曾经有一个 `deriveDshModelsLoginUrl()`（派生"宿主操作员一次性登录 URL"，让用户的浏览器
//   去登 DSH），**已拆除**。它解决的问题是真的（宿主 `/api/*` 只认它自己的浏览器会话），
//   但解法方向错了：让用户感知 DSH 与"反向包 DSH"的产品目标相反。
//   正确方向见 docs/DECISION-legion-owns-model-config.md：**Legion 拥有配置，DSH 的配置由它派生**，
//   物化走进程内的 `ctx.settings.mutate` / `ctx.credentials.set`（无 HTTP、无 cookie、无登录）。
//   拆除的是方向，不是"还差一层"。
//
// ★ P1 的只读那一半（`readDshProviderSnapshot`）原本住在本文件里，已经搬到
//   `./dsh-snapshot.mjs`：P2 的对账也要用它，留在本文件里会让
//   `index.js ↔ shadow-materialize.mjs` 成为**循环导入**（今天能跑，但失败方式取决于谁先被加载）。
//   这里 re-export，保持 P1 的用例与既有导入路径不变。
export { readDshProviderSnapshot } from './dsh-snapshot.mjs'

/**
 * team-hub 子进程要拿到的环境。
 *
 * 抽出来的理由与 `buildWorkbenchEnv` 相同：能被断言的东西才拦得住回归 ——
 * 尤其是下面那两条**产品目录事实**，漏了它们的后果是"用户在面板里填密钥永远存不进去"。
 *
 * @param installDir 安装目录（**事实**：程序在哪）。`product/paths.mjs` 那条诊断的原话是
 *   "请设置 LEGION_INSTALL_DIR **或由 Launcher 传入**"，而本插件正是这台机器上的启动方。
 * @param workspaceDir 工作区（**用户授权**的项目目录）。规范明确"不提供默认值" ⇒ 只透传。
 */
export function buildTeamHubEnv({
  baseEnv = {}, port = '', host = '', token = '', installDir = '', workspaceDir = '',
} = {}) {
  return {
    ...baseEnv,
    TEAM_HUB_PORT: String(port),
    TEAM_HUB_HOST: host,
    TEAM_HUB_TOKEN: token,
    // ★ 安装目录不给默认值、也不允许为空：它是产品目录布局里密钥库落点校验的**必要输入**。
    ...(installDir ? { LEGION_INSTALL_DIR: installDir } : {}),
    // 工作区只在用户/配置真的给了时才传：编一个会让"用户授权"这件事失去意义。
    ...(workspaceDir ? { LEGION_WORKSPACE_DIR: workspaceDir } : {}),
  }
}

/**
 * 引导导入：**只在 Legion 的目录为空时**把 DSH 的现状收进来一次。
 *
 * ★ 为什么必须"只在空的时候"（这是 DECISION §3 那条方向纪律的执行点）：
 *   方向是单向的 Legion → DSH。如果每次启动都拿 DSH 的现状覆盖 Legion，
 *   那么"有人手改了 DSH 文件"就会静默变成"Legion 也跟着改了"——
 *   那时 Legion 不再是真相，而**没有任何读数会说话**。
 *   DSH → Legion 这条路只允许出现在两个地方：**一次性导入**（本函数）与**影子对账**（P2）。
 *
 * 幂等由服务端保证（`POST /api/model-providers/import` 的 `unchanged` 计数）；
 * 本函数再挡一层"非空就不导"，两道合起来才让"手改 DSH 不会改写 Legion"成立。
 *
 * 失败一律**只记日志、不抛**：它是一项增强，不该有能力把宿主的启动拖坏。
 */
export async function maybeBootstrapProviderImport({ ctx, hubUpstream, teamHubToken, fetchImpl = fetch, log = () => {}, retries = 10, delayMs = 1500 } = {}) {
  const suffix = (teamHubToken ? '?token=' + encodeURIComponent(teamHubToken) : '')
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${hubUpstream}${path}${suffix}`, {
      method,
      headers: { 'content-type': 'application/json', ...(teamHubToken ? { authorization: `Bearer ${teamHubToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON：下面按状态码报 */ }
    return { status: res.status, json }
  }

  let empty = null
  for (let i = 0; i < Math.max(1, retries); i += 1) {
    try {
      const r = await call('GET', '/api/model-providers')
      if (r.status === 200 && r.json) { empty = r.json.empty === true; break }
    } catch { /* team-hub 还没起来：退避再试 */ }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  if (empty === null) {
    log('供应商引导导入：读不到中枢的 /api/model-providers（一直没起来或响应异常）→ 本次跳过；不影响服务启动')
    return { skipped: 'hub-unreachable' }
  }
  if (empty === false) {
    // ★ 这一行是"方向纪律"的可见读数：非空就**不导**，因为那意味着 Legion 已经是真相。
    log('供应商引导导入：Legion 目录**已非空** → 不导入（方向是 Legion → DSH；DSH 侧被手改不会改写 Legion）')
    return { skipped: 'not-empty' }
  }

  const { providers, readOk, reason } = await readDshProviderSnapshot(ctx)
  if (!readOk) {
    log(`供应商引导导入：读不出 DSH 的供应商目录（${reason || '原因未知'}）→ 本次跳过`)
    return { skipped: 'no-snapshot', reason }
  }
  if (providers.length === 0) {
    // ★ 与上面那条**不是一回事**：这是"读到了、就是空的"。
    //   混起来会让日志里出现一句"读不出"，而实际是"DSH 里确实一个供应商都没有"。
    log('供应商引导导入：DSH 当前没有任何供应商 → 本次跳过（这是"读到了、就是空"，不是读失败）')
    return { skipped: 'no-providers' }
  }
  try {
    const r = await call('POST', '/api/model-providers/import', { actor: 'legion-services', source: 'dsh-import', providers })
    if (r.status !== 200) {
      log(`供应商引导导入：中枢拒绝（HTTP ${r.status}）→ ${JSON.stringify(r.json).slice(0, 200)}`)
      return { skipped: 'rejected', status: r.status }
    }
    log(`供应商引导导入：新增 ${r.json.created} / 更新 ${r.json.updated} / 未变 ${r.json.unchanged}（来自 DSH 现状；${providers.length} 个供应商）`)
    return { created: r.json.created, updated: r.json.updated, unchanged: r.json.unchanged }
  } catch (e) {
    log(`供应商引导导入失败：${e instanceof Error ? e.message : String(e)}（不影响服务启动）`)
    return { skipped: 'failed' }
  }
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
  /** 布尔配置：只有**显式写下的真值**才算开。
   *  ★ P3 的接管门就用它 —— 默认关。字符串 '1'/'true'/'yes' 也算（patch config 里常见）。
   *    绝不接受"没写就是开"：那是这条链上唯一不可逆的一段。 */
  const flag = (v, d = false) => {
    if (v === undefined || v === null || v === '') return d
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    const s = String(v).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
    return d
  }

  const teamHubPort = num(cfg.teamHubPort, 8787)
  const teamHubHost = typeof cfg.teamHubHost === 'string' && cfg.teamHubHost.trim()
    ? cfg.teamHubHost.trim()
    : (typeof baseEnv.TEAM_HUB_HOST === 'string' && baseEnv.TEAM_HUB_HOST.trim() ? baseEnv.TEAM_HUB_HOST.trim() : '127.0.0.1')
  const teamHubToken = typeof cfg.teamHubToken === 'string' && cfg.teamHubToken
    ? cfg.teamHubToken
    : (typeof baseEnv.TEAM_HUB_TOKEN === 'string' ? baseEnv.TEAM_HUB_TOKEN : '')
  /** 工作区（用户授权的项目目录）：只从配置/环境透传给团队中枢，**不编默认值**。 */
  const workspaceDir = typeof cfg.workspaceDir === 'string' && cfg.workspaceDir.trim()
    ? cfg.workspaceDir.trim()
    : (typeof baseEnv.LEGION_WORKSPACE_DIR === 'string' && baseEnv.LEGION_WORKSPACE_DIR.trim() ? baseEnv.LEGION_WORKSPACE_DIR.trim() : '')
  const workbenchPort = num(cfg.workbenchPort, 5173)
  // ★ P3 的两道门，都**默认关**（见下方写入处的说明）。
  //   `applyModelConfig`：接管供应商配置（settings.mutate）。
  //   `applyModelConfigDeletes`：连**删除**也接管（unset 掉 Legion 里没有的供应商）。
  //   删除单独一道门，是因为它是不可逆的那一半：整块 unset 的逆操作只能还原
  //   "读者看得见的叶子"（见 materialize-ops.mjs 文件头）。
  const applyModelConfig = flag(cfg.applyModelConfig ?? baseEnv.LEGION_APPLY_MODEL_CONFIG, false)
  const applyModelConfigDeletes = flag(cfg.applyModelConfigDeletes ?? baseEnv.LEGION_APPLY_MODEL_CONFIG_DELETES, false)
  // ★ P4 的周期：默认 5 分钟一轮；显式给 0（或负数）⇒ **只**在启动时收敛一次。
  //   为什么不复用 `num()`：它把 0 当成"没给"并回落到默认值 ——
  //   于是"我想关掉周期"这个意图会被静默变成"用默认周期"，而那正好相反。
  const rawInterval = cfg.reconcileIntervalMs ?? baseEnv.LEGION_RECONCILE_INTERVAL_MS
  const reconcileIntervalMs = rawInterval === undefined || rawInterval === null || rawInterval === ''
    ? 300000
    : (Number.isFinite(Number(rawInterval)) ? Number(rawInterval) : 300000)
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

  const services = [
    {
      key: 'team-hub',
      label: `team-hub v2（:${teamHubPort}）`,
      port: teamHubPort,
      cwd: legionDir,
      args: [join(legionDir, 'team-hub', 'server.mjs')],
      env: buildTeamHubEnv({
        baseEnv, port: teamHubPort, host: teamHubHost, token: teamHubToken,
        // 安装目录是事实（程序在哪），不是用户选择 ⇒ 由 legionDir 直接给。
        installDir: legionDir,
        // 工作区是用户授权的项目目录 ⇒ 只透传，绝不编一个（规范 §6.11）。
        workspaceDir,
      }),
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

  // P3 的取值器：从 Legion 自己的受保护库按引用名取（宿主进程内，不经 HTTP）。
  // 建一次、复用：它内部对"密钥库打不开"只报一次，避免每取一把钥匙刷一行。
  const readLegionSecret = createLegionSecretReader({ env: baseEnv, log })

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

  /**
   * P4 的一轮收敛 = P2 的对账 + （门开着时）P3 的物化。
   *
   * ★ 返回值里的 `clean` 报的是**轮次开始时**有没有差异，而不是"写完之后干不干净"。
   *   两者的区别在 streak 上很要紧：如果按"写完之后"算，那么每一次成功的写入
   *   都会让 streak +1，于是"连续 N 轮无差异"这个放行条件会被**自己的写入**满足 ——
   *   那就成了一个永远为真的读数。
   */
  async function runOneReconcileRound() {
    const shadow = await runShadowMaterialization({ ctx, hubUpstream, teamHubToken, log })
    const cleanAtStart = shadow.ok === true && shadow.plan?.clean === true
    await runMaterialization({
      ctx, hubUpstream, teamHubToken, log,
      enabled: applyModelConfig,
      allowDeletes: applyModelConfigDeletes,
      secretReader: readLegionSecret,
    })
    return { clean: cleanAtStart }
  }

  // 建在 bootTimer 之前：STM 之后才建会处在 TDZ 里（今天不会命中，因为 setTimeout 回调
  // 一定异步执行 —— 但那是"取决于运行时细节"的正确性，不是构造上的正确性）。
  const schedule = createReconcileSchedule({
    run: runOneReconcileRound,
    intervalMs: reconcileIntervalMs,
    log,
  })

  const bootTimer = setTimeout(() => {
    void (async () => {
      if (disposed) return
      const dshModelsBaseUrl = resolveDshModelsBaseUrl()
      log(dshModelsBaseUrl
        ? `模型配置宿主地址 DSH_MODELS_BASE_URL=${dshModelsBaseUrl}（派生自本次启动的宿主；Bug #1：写死 3080 时「供应商与模型」读不出来）`
        : '取不到宿主端口（ctx.webServer.port / DSH_WEB_URL 都没有）→ 不注入 DSH_MODELS_BASE_URL，workbench 将按自身默认回落；Desktop 部署下「供应商与模型」可能读不出来')
      for (const svc of services) {
        if (disposed) return
        await startService(svc)
        await new Promise(r => setTimeout(r, 150))
      }
      if (disposed) return
      // ★ P1 的引导导入：**只在 Legion 的供应商目录为空时**做一次（DECISION §3 的方向纪律）。
      //   放在服务起来之后，是因为它要经中枢自己的 API 写（不是直写 team.db）——
      //   这样"谁导的"进审计、"未知字段拒绝"这些守卫对导入同样生效。
      const imported = await maybeBootstrapProviderImport({
        ctx, hubUpstream, teamHubToken, log,
        retries: num(cfg.providerImportRetries, 10),
        delayMs: num(cfg.providerImportDelayMs, 1500),
      })
      if (imported.skipped === undefined) log('供应商目录已由 DSH 现状建立（P1）；此后 Legion 是唯一真相')

      // ★ P2 + P3 + P4 的第一轮：对账（只报告）→ 门开着时物化（写 + 回读验收）→ 之后按周期重复。
      //   顺序不能换：P1 的导入必须先把 Legion 的目录建起来，P2 的读数才有意义；
      //   而 P3 的写入只有在"看见了要写什么"之后才允许发生。
      //
      //   ★ 走 `schedule.runNow()` 而不是直接调 `runOneReconcileRound()`：
      //     `runNow` **构造上不抛**（内部 catch + streak 归零），而直接 await 那一轮时，
      //     任何一次抛出（最典型的是中枢刚启动那一瞬间的 ECONNREFUSED）都会
      //     **跳过下面的 `schedule.start()`** ⇒ 周期收敛永远不启动，
      //     而唯一的症状是"日志里少了一行"。拿一次启动读数的形式换掉一个静默失效，值得。
      if (disposed) return
      const first = await schedule.runNow()
      if (disposed) return
      // ★ P4：把上面这一轮变成**周期性**的。
      //   `start()` 会先把 streak 记下来（首轮已跑过），之后每 `reconcileIntervalMs` 一拍。
      //   不重叠是构造上的性质（递归 setTimeout），不是靠调大间隔 —— 见 reconcile-schedule.mjs。
      schedule.start()
      log(`模型配置收敛：启动收敛完成（首轮${first?.clean ? '无差异' : '有差异'}）；`
        + `接管门=${applyModelConfig ? '**已开**' : '关（只对账不写）'}`
        + `，删除门=${applyModelConfigDeletes ? '**已开**' : '关（删除只报告）'}`)
    })()
  }, num(cfg.bootDelayMs, 1500))

  // effect 清理随插件卸载执行；普通 dispose 事件不代表 Cordis 生命周期。
  ctx.effect(() => () => {
    clearTimeout(bootTimer)
    // ★ 周期收敛必须一起停：否则插件卸载后还有一轮在写 DSH 的配置，
    //   而那时它已经不归任何人管了（disposeAll 只回收子进程，管不到这个定时器）。
    schedule.stop()
    disposeAll()
    log('legion-services 已随宿主停止（全部子服务已回收，周期收敛已停）')
  })

  const dirSource = cfgDir && looksLikeLegionRoot(cfgDir) ? 'config.legionDir'
    : (looksLikeLegionRoot(selfParent) ? '插件自身位置（源码直跑）' : '内置默认值')
  log(`legion-services 挂载：legionDir=${legionDir}（来源：${dirSource}），将托管 [${services.map(s => s.label).join('，')}]`)
}
