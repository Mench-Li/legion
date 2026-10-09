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

/**
 * 从**宿主进程内**读出一份"DSH 现在活着的供应商目录"快照（P1 的只读那一半）。
 *
 * 为什么在插件里做：这个进程就是宿主，`ctx.llm` / `ctx.settings` / `ctx.credentials`
 * 都是**进程内直连**——不需要 HTTP、不需要会话 cookie、不需要登录
 * （那三样正是 BUG-014 前两版绕不出去的东西，见 DECISION 文档）。
 *
 * ★ 只读、且只取**目录类**事实：供应商 id、显示名、协议、地址、**引用名**（`apiKeyEnv`）、
 *   型号清单、以及"这个引用配没配"。**永不读值**——`credentials.describe()` 返回的是
 *   `{configured}`，不是密钥本身。
 *
 * 组装规则（两条都不能少）：
 *   · "活着"以 `llm.listProviders()` 为准（引擎真正认得的供应商）；
 *   · 细节（api/baseURL/apiKeyEnv）从 `settings.describe` 的**已声明**配置里取，
 *     取不到就留 null —— 一个"活着但没声明"的供应商仍然要收进来，
 *     因为"引擎认得它"才是要紧的事实。
 *
 * 三个服务一律**软取**（`ctx.get`）：缺席时函数返回空数组并说明原因，而不是抛错。
 * 让"宿主没暴露这个服务"变成"整个插件 pending、team-hub 与指挥台都不启动"，
 * 是这条链上最容易犯、后果最大的一种错（见文件头 `inject` 那段）。
 *
 * @returns `{ providers, reason }` —— `reason` 非空即"这次读不出快照"，调用方据此决定要不要记一笔。
 */
export async function readDshProviderSnapshot(ctx) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm || typeof llm.listProviders !== 'function') return { providers: [], reason: '宿主没有 llm 服务' }
  const settings = ctx?.get?.('settings') ?? null
  const credentials = ctx?.get?.('credentials') ?? null

  let namespaces = []
  if (settings && typeof settings.describe === 'function') {
    try { namespaces = settings.describe({ redactSecrets: true }) ?? [] } catch { namespaces = [] }
  }
  let declared = []
  if (typeof llm.listConfigurableProviders === 'function') {
    try { declared = llm.listConfigurableProviders() ?? [] } catch { declared = [] }
  }

  /** 按 `settingsPath` 逐级下钻，取到这条供应商在配置里的那一节。 */
  const declaredProfile = (providerId) => {
    const entry = declared.find((d) => d?.provider === providerId)
    if (!entry) return {}
    let node = namespaces.find((n) => n?.ns === entry.settingsNs)?.value
    for (const key of entry.settingsPath ?? []) {
      node = node !== null && typeof node === 'object' ? node[key] : undefined
    }
    return node !== null && typeof node === 'object' ? node : {}
  }

  const providers = []
  for (const p of llm.listProviders()) {
    if (!p || typeof p.id !== 'string') continue
    const profile = declaredProfile(p.id)
    let models = []
    try { models = (await llm.listModels(p.id)) ?? [] } catch { models = [] }
    const apiKeyEnv = typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : null
    let credentialConfigured = false
    if (apiKeyEnv !== null && credentials && typeof credentials.describe === 'function') {
      try { credentialConfigured = (await credentials.describe(apiKeyEnv))?.configured === true } catch { credentialConfigured = false }
    }
    providers.push({
      id: p.id,
      displayName: typeof profile.displayName === 'string' && profile.displayName !== '' ? profile.displayName : (p.name ?? p.id),
      api: typeof profile.api === 'string' && profile.api !== '' ? profile.api : null,
      baseURL: typeof profile.baseURL === 'string' && profile.baseURL !== '' ? profile.baseURL : null,
      secretRef: apiKeyEnv,
      credentialConfigured,
      models: models.map((m) => ({
        id: m?.id,
        ...(typeof m?.name === 'string' && m.name !== '' ? { name: m.name } : {}),
        ...(Array.isArray(m?.inputModalities) && m.inputModalities.length > 0 ? { input: [...m.inputModalities] } : {}),
      })).filter((m) => typeof m.id === 'string' && m.id !== ''),
    })
  }
  return { providers, reason: providers.length === 0 ? '宿主当前没有任何可用供应商' : '' }
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

  const { providers, reason } = await readDshProviderSnapshot(ctx)
  if (providers.length === 0) {
    log(`供应商引导导入：读不出 DSH 的供应商目录（${reason || '原因未知'}）→ 本次跳过`)
    return { skipped: 'no-snapshot', reason }
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
