// desktop/update-service.mjs
// ============================================================================
// 桌面端更新服务 —— 设计 §7 那张"有界操作"表的主进程侧实现
//
// 设计 §7 line 152 的原话：
//
//   「Electron preload 只暴露以下有界操作，主进程校验窗口来源和输入：
//
//      update.status / update.check     无任意 URL、路径或 shell 参数
//      update.download                  releaseId + manifestDigest，匹配已验证候选
//      update.cancelDownload            当前下载操作 ID
//      update.install                   releaseId + manifestDigest，匹配已就绪包与用户确认
//      update.subscribe                 脱敏状态、阶段、字节进度、错误码；不含凭据」
//
// 两句话，两个判据：
//
//   ① **有界**：命令名是一个固定集合，参数是固定形状的字符串/数字，**没有**
//      任何"传我一个 URL"或"传我一个路径"的入口。这是"preload 暴露面"
//      这条防线在这里的全部内容——一个 `update.fetch(url)` 会让渲染进程
//      （也就是网页）获得任意取件能力。
//
//   ② **校验窗口来源与输入**：`event.senderFrame.url` 必须正是更新面板自己的
//      URL。桌面端已有这个模式（`main.mjs` 里 `legion:command` 的检查），
//      更新面板沿用同一套：**只接受来自本面板的调用**。
//
// ## 为什么面板用一个**本地文件**页面
//
// 更新界面必须在两种时刻可用：
//   · 服务已经起来了 → 主窗口是工作台；
//   · 服务起不来 / 正在升级 → 主窗口还在启动页。
//
// 所以更新面板是一个独立的 BrowserWindow，加载本地的 `update.html`。
// 它不加载任何远程内容，也不与工作台共享会话分区（用独立的 partition），
// 因此"网页不能直接触发迁移或程序切换"（设计 §7 line 162）在结构上成立，
// 而不是靠检查。
// ============================================================================

// ★ `electron` 是**延迟导入**的。
//
//   这不是风格问题：本模块里的判据（命令白名单、输入校验、状态脱敏投影）
//   全部与 Electron 无关，而它们恰恰是最需要被测的部分——输入校验漏一个
//   字段就等于多开了一个入口。在顶层 `import { ipcMain } from 'electron'`
//   会让这个文件在普通 Node 里**根本载不进来**，于是那些判据只能靠"运行
//   整个桌面端"来验证，而在这个仓库里跑 Electron 需要额外的依赖与显示环境。
//
//   所以只有真正需要 `BrowserWindow` / `ipcMain` 的那两个函数在运行时
//   `await import('electron')`。
let electronModule = null
async function electron() {
  if (electronModule === null) electronModule = await import('electron')
  return electronModule
}

import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describeTaskReadings } from '../product/upgrade/task-state.mjs'

/** §7 那张表的**精确**命令名。除此之外一律拒绝。 */
export const UPDATE_COMMANDS = Object.freeze([
  'update.status',
  'update.check',
  // 只读：在途任务读数（设计 §7 line 150 的展示读数）。它没有参数、
  // 不接受任何输入，所以把它加进白名单不会扩大"preload 暴露面"。
  'update.tasks',
  'update.download',
  'update.cancelDownload',
  'update.install',
  'update.snooze',
])

/** 事件通道名（`update.subscribe` 的推送）。 */
export const UPDATE_STATE_CHANNEL = 'legion:update-state'

/** 允许进入主进程的字符串输入：**没有 URL、没有路径、没有 shell 参数**。 */
const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DIGEST_RE = /^[0-9a-f]{64}$/

export const UPDATE_INPUT_CODES = Object.freeze({
  FORBIDDEN: 'UPDATE_IPC_FORBIDDEN',
  UNKNOWN_COMMAND: 'UPDATE_IPC_UNKNOWN_COMMAND',
  BAD_INPUT: 'UPDATE_IPC_BAD_INPUT',
  UNAVAILABLE: 'UPDATE_IPC_UNAVAILABLE',
})

/**
 * 校验 `update.download` / `update.install` 的输入。
 *
 * 只接受 `{releaseId, manifestDigest}` 这两个字段，且**拒绝多余字段**——
 * 一条"顺便接受一个 path"的宽松校验会在某一天被调用方用上。
 */
export function validateTargetInput(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: 'update 目标必须是对象' })
  }
  const keys = Object.keys(payload).sort()
  if (keys.length !== 2 || keys[0] !== 'manifestDigest' || keys[1] !== 'releaseId') {
    return Object.freeze({
      ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT,
      reason: `update 目标只接受 releaseId/manifestDigest 两个字段，实际是 ${keys.join(',') || '(空)'}`,
    })
  }
  if (typeof payload.releaseId !== 'string' || !RELEASE_ID_RE.test(payload.releaseId)) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: 'releaseId 不合法' })
  }
  if (typeof payload.manifestDigest !== 'string' || !DIGEST_RE.test(payload.manifestDigest)) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: 'manifestDigest 必须是 64 位小写十六进制' })
  }
  return Object.freeze({
    ok: true, code: null, reason: null,
    target: Object.freeze({ releaseId: payload.releaseId, manifestDigest: payload.manifestDigest }),
  })
}

/** 校验 `update.cancelDownload` 的输入：一个正整数操作 ID（允许 null）。 */
export function validateOperationInput(payload) {
  if (payload === null || payload === undefined) return Object.freeze({ ok: true, code: null, reason: null, operationId: null })
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: '取消输入必须是对象' })
  }
  const keys = Object.keys(payload)
  if (keys.some((key) => key !== 'operationId')) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: '取消输入只接受 operationId' })
  }
  const { operationId } = payload
  if (operationId === null || operationId === undefined) {
    return Object.freeze({ ok: true, code: null, reason: null, operationId: null })
  }
  if (!Number.isSafeInteger(operationId) || operationId < 1) {
    return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.BAD_INPUT, reason: 'operationId 必须是正整数' })
  }
  return Object.freeze({ ok: true, code: null, reason: null, operationId })
}

/**
 * 脱敏的状态投影。
 *
 * 设计 §7 line 160：「update.subscribe 脱敏状态、阶段、字节进度、错误码；
 * **不含凭据**」。所以这里是一个**白名单投影**，而不是把 `client.snapshot()`
 * 直接送出去：以后有人在 snapshot 里加了一个字段（比如带 token 的 URL），
 * 白名单会把它挡在外面，而"原样转发"不会。
 */
export function projectState(snapshot) {
  const progress = snapshot?.progress ?? null
  return Object.freeze({
    state: snapshot?.state ?? 'idle',
    usable: snapshot?.usable === true,
    unavailableReason: typeof snapshot?.unavailableReason === 'string' ? snapshot.unavailableReason : null,
    channel: typeof snapshot?.channel === 'string' ? snapshot.channel : null,
    currentVersion: typeof snapshot?.currentVersion === 'string' ? snapshot.currentVersion : null,
    productVersion: typeof snapshot?.productVersion === 'string' ? snapshot.productVersion : null,
    releaseId: typeof snapshot?.releaseId === 'string' ? snapshot.releaseId : null,
    /**
     * 身份的另一半。设计 §7 把 `update.download` / `update.install` 的输入
     * 定为「releaseId + manifestDigest」，所以投影**必须**把它带出来——
     * 否则界面拿不到那个字符串，只能自己拼一个，而"自己拼一个身份"正是
     * 身份绑定要防的事。
     */
    manifestDigest: typeof snapshot?.manifestDigest === 'string' && /^[0-9a-f]{64}$/.test(snapshot.manifestDigest)
      ? snapshot.manifestDigest : null,
    identityLabel: typeof snapshot?.identityLabel === 'string' ? snapshot.identityLabel : null,
    ready: snapshot?.ready === true,
    /**
     * 发布说明：设计 §5 把它定为**纯文本**（`.txt`），正是为了不必在界面上
     * 运行任何标记/脚本。客户端已经在取回时校验过摘要与"是不是纯文本"，
     * 所以这里可以原样带上；取不到时连同原因一起带出来。
     */
    releaseNotes: typeof snapshot?.releaseNotes === 'string' ? snapshot.releaseNotes.slice(0, 64 * 1024) : null,
    releaseNotesUnavailableReason: typeof snapshot?.releaseNotesUnavailableReason === 'string'
      ? snapshot.releaseNotesUnavailableReason : null,
    // ★ 这里**没有** `pendingTasks`（早先投影的是快照里一个恒为 `null` 的字段）。
    //   在途任务的**展示**读数走独立的 `update.tasks`（它由主进程实时去读），
    //   而**判据**读数在安装那一刻由主进程再读一次——两者都不来自快照。
    //   在快照里放一个恒 null 的同名字段，只会让人以为它才是那个来源。
    progress: progress === null ? null : Object.freeze({
      phase: typeof progress.phase === 'string' ? progress.phase : null,
      bytes: Number.isSafeInteger(progress.bytes) ? progress.bytes : 0,
      total: Number.isSafeInteger(progress.total) ? progress.total : 0,
    }),
    lastCheck: snapshot?.lastCheck === null || snapshot?.lastCheck === undefined
      ? null
      : Object.freeze({
        atMs: Number.isSafeInteger(snapshot.lastCheck.atMs) ? snapshot.lastCheck.atMs : null,
        outcome: typeof snapshot.lastCheck.outcome === 'string' ? snapshot.lastCheck.outcome : null,
        productVersion: typeof snapshot.lastCheck.productVersion === 'string' ? snapshot.lastCheck.productVersion : null,
        trigger: typeof snapshot.lastCheck.trigger === 'string' ? snapshot.lastCheck.trigger : null,
      }),
    lastError: snapshot?.lastError === null || snapshot?.lastError === undefined
      ? null
      : Object.freeze({
        code: typeof snapshot.lastError.code === 'string' ? snapshot.lastError.code : null,
        // ★ 理由文本已经由 errors.mjs 构造为脱敏（不含凭据、不含绝对路径）。
        reason: typeof snapshot.lastError.reason === 'string' ? snapshot.lastError.reason : null,
      }),
    operationId: Number.isSafeInteger(snapshot?.operationId) ? snapshot.operationId : null,
    snoozedUntilMs: Number.isSafeInteger(snapshot?.snoozedUntilMs) ? snapshot.snoozedUntilMs : null,
  })
}

/**
 * 建立更新服务：命令分派 + 状态推送 + 面板窗口。
 *
 * @param {object} args
 * @param {object} args.client             `product/update/client.mjs` 的客户端
 * @param {Function} [args.openExternal]   打开发布说明用的外壳（注入以便测试）
 * @param {Function} [args.createPanel]    面板窗口工厂（注入以便测试）
 */
export function createUpdateService({
  client,
  desktopDir = fileURLToPath(new URL('.', import.meta.url)),
  createPanel = defaultPanelFactory,
  onNotify = () => {},
  log = () => {},
  /**
   * 在途任务读数来源（**主进程**提供）。
   *
   * 返回数组 = 读到了（`[]` 表示确实没有任务）；返回 `null`/非数组 = 读不到。
   * 渲染进程**不能**提供这个读数：它是预检的输入（见 `update.install`）。
   */
  readTasks = null,
} = {}) {
  if (client === null || typeof client !== 'object') throw new Error('createUpdateService 需要 client')

  let panel = null
  let panelUrl = null
  let subscribed = false

  const panelFile = join(desktopDir, 'update.html')

  function windowOriginAllows(event) {
    // ★ 来源校验：`senderFrame.url` 必须**正是**面板自己的地址。
    //   与 `main.mjs` 的 `legion:command` 同一套路。用一个
    //   "包含 update.html" 的子串判断是不够的——一个能导航到
    //   `https://evil.example/update.html` 的渲染进程也能通过子串判断。
    if (panel === null || panel.isDestroyed?.() === true) return false
    if (event?.sender !== panel.webContents) return false
    const frame = event.senderFrame
    if (frame === null || frame === undefined) return false
    if (panel.webContents.mainFrame !== undefined && frame !== panel.webContents.mainFrame) return false
    return frame.url === panelUrl
  }

  function pushState() {
    if (panel === null || panel.isDestroyed?.() === true) return
    panel.webContents.send(UPDATE_STATE_CHANNEL, projectState(client.snapshot()))
  }

  function ensureSubscribed() {
    if (subscribed) return
    subscribed = true
    client.subscribe((snapshot) => {
      void snapshot
      pushState()
      // 主动提醒（设计 §7 line 146）：同一发行 24 小时内不重复。
      if (client.shouldNotify()) {
        try { onNotify(projectState(client.snapshot())) } catch (error) { log(`[update] 提醒失败：${error?.message ?? error}`) }
      }
    })
  }

  async function dispatch(command, payload, event) {
    if (!UPDATE_COMMANDS.includes(command)) {
      return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.UNKNOWN_COMMAND, reason: `未知命令 ${JSON.stringify(command)}` })
    }
    if (!windowOriginAllows(event)) {
      return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.FORBIDDEN, reason: '调用来源不是更新面板' })
    }
    if (client.snapshot().usable !== true && command !== 'update.status') {
      return Object.freeze({
        ok: false, code: UPDATE_INPUT_CODES.UNAVAILABLE,
        reason: client.snapshot().unavailableReason ?? '检查更新不可用',
      })
    }
    switch (command) {
      case 'update.status':
        return Object.freeze({ ok: true, code: null, reason: null, state: projectState(client.snapshot()) })
      case 'update.check':
        // 「手动检查立即执行，并与已有检查共享一次网络请求」——共享那件事
        // 由 client/调度器负责，这里只是转达。
        return Object.freeze({ ok: true, code: null, reason: null, result: await client.check({ trigger: 'manual' }) })
      case 'update.download': {
        const input = validateTargetInput(payload)
        if (!input.ok) return input
        const result = await client.download(input.target.releaseId, input.target.manifestDigest)
        return Object.freeze({ ...result, code: result.code ?? null })
      }
      case 'update.cancelDownload': {
        const input = validateOperationInput(payload)
        if (!input.ok) return input
        return client.cancelDownload(input.operationId)
      }
      /**
       * 只读：在途任务读数（设计 §7 line 150「安装确认显示是否有在途任务」）。
       *
       * ★ 这是**展示**用的读数，与安装时那条**判据**用的读数分开取。
       *   两者由同一个 provider 提供（主进程里那一个），所以"界面说有 2 个
       *   在跑"与"预检拦下这次安装"不会互相矛盾；但它们不是同一次调用——
       *   展示发生在用户打开面板时，判据发生在用户按下安装时，中间任务
       *   完全可能变化。把展示的读数**复用**为判据的输入，就是拿一个可能
       *   过期的读数去决定要不要动程序目录。
       */
      case 'update.tasks': {
        if (typeof readTasks !== 'function') {
          return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.UNAVAILABLE,
            reason: '本机没有配置在途任务读数来源' })
        }
        let reading
        try {
          reading = await readTasks()
        } catch (error) {
          return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.UNAVAILABLE,
            reason: `读在途任务失败：${error?.message ?? error}` })
        }
        // ★ 读不到就是 `ok: false`，**不是** `tasks: []`。
        //   界面上"未知"与"没有"是两句不同的话（见 describePendingTasks）。
        if (reading === null || !Array.isArray(reading)) {
          return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.UNAVAILABLE,
            reason: '读不到在途任务读数：查不到不等于没有在途任务' })
        }
        return Object.freeze({ ok: true, code: null, reason: null,
          tasks: Object.freeze(reading.map((item) => Object.freeze({ id: item?.id ?? null, state: item?.state ?? null }))),
          summary: describeTaskReadings(reading) })
      }
      case 'update.install': {
        const input = validateTargetInput(payload)
        if (!input.ok) return input
        // ★ 不读 `payload.pendingTasks`。
        //
        //   在途任务读数是预检的**输入**（对 `[]` 判 ok、对 `null` 判 unknown），
        //   所以它不能来自渲染进程——一个能传空数组的渲染进程就能让一次
        //   "任务正在跑"的升级通过预检。主进程自己读（它有 bridge 与
        //   team-hub 的端口，渲染进程都没有）。
        const result = await client.install(input.target.releaseId, input.target.manifestDigest)
        return Object.freeze({ ...result, code: result.code ?? null })
      }
      case 'update.snooze':
        return Object.freeze({ ok: true, code: null, reason: null, ...client.snooze() })
      default:
        return Object.freeze({ ok: false, code: UPDATE_INPUT_CODES.UNKNOWN_COMMAND, reason: '未实现' })
    }
  }

async function showPanel({ parent = null } = {}) {
  ensureSubscribed()
  if (panel !== null && panel.isDestroyed?.() !== true) {
    panel.show()
    panel.focus()
    pushState()
    return panel
  }
  const created = createPanel({ parent, file: panelFile, preload: join(desktopDir, 'update-preload.cjs') })
  panel = created.window
  panelUrl = created.url
  panel.on?.('closed', () => { panel = null; panelUrl = null })
  await created.ready
  pushState()
  return panel
}

  return Object.freeze({
    dispatch,
    showPanel,
    pushState,
    snapshot: () => projectState(client.snapshot()),
    commands: UPDATE_COMMANDS,
    get panelOpen() { return panel !== null && panel.isDestroyed?.() !== true },
    close() {
      if (panel !== null && panel.isDestroyed?.() !== true) panel.close()
      panel = null
      panelUrl = null
    },
  })
}

/**
 * 默认面板工厂。
 *
 * 关键性质（每一条都对应设计 §7 的一句话）：
 *   · `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`；
 *   · 独立 `partition`：面板与工作台不共享会话；
 *   · 关闭一切权限请求与子框架（与 `main.mjs` 的主窗口同策）；
 *   · `will-navigate` 只允许面板自己的 URL：面板不该被导航到别处。
 */
function defaultPanelFactory({ parent, file, preload = null }) {
  const url = pathToFileURL(file).href
  const { BrowserWindow } = electronModule ?? {}
  if (BrowserWindow === undefined) throw new Error('defaultPanelFactory 需要 Electron（请先用 await electron() 装载）')
  const window = new BrowserWindow({
    width: 560, height: 520, parent: parent ?? undefined, modal: false,
    title: 'Legion 更新', show: true, resizable: true, minimizable: false, maximizable: false,
    backgroundColor: '#101726',
    webPreferences: {
      ...(preload === null ? {} : { preload }),
      nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'legion-update',
    },
  })
  window.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const session = window.webContents.session
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  const ready = window.loadURL(url).catch(() => { /* 面板加载失败不该影响主流程 */ })
  return { window, url, ready }
}

/**
 * 注册 IPC。与 `main.mjs` 的 `legion:command` 分开一个通道：
 * 更新面板与启动页是两个不同的页面，来源校验各自独立。
 *
 * 异步（因为要延迟装载 Electron），调用方需要 `await`。
 */
export async function registerUpdateIpc(service, { ipc = null } = {}) {
  const target = ipc ?? (await electron()).ipcMain
  target.handle('legion:update', async (event, command, payload) => {
    const result = await service.dispatch(command, payload, event)
    // 返回值必须是可结构化克隆的：`Error` 对象会在这里变成一个空对象，
    // 于是界面拿到的是"undefined 的错误"。
    return JSON.parse(JSON.stringify(result ?? { ok: false, code: 'UPDATE_IPC_EMPTY' }))
  })
  return () => { try { target.removeHandler('legion:update') } catch { /* 退出时可能已经清空 */ } }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckUpdateService() {
  const problems = []
  const expected = ['update.status', 'update.check', 'update.download', 'update.cancelDownload', 'update.install']
  for (const command of expected) {
    if (!UPDATE_COMMANDS.includes(command)) problems.push(`设计 §7 的命令 ${command} 没有暴露`)
  }
  // 输入校验：路径与 URL 必须无法通过。
  for (const bad of [
    { releaseId: 'rel-1', manifestDigest: 'a'.repeat(64), path: 'C:\\evil.exe' },
    { releaseId: 'rel-1', manifestDigest: 'a'.repeat(64), url: 'https://evil.example/x.zip' },
    { releaseId: '../escape', manifestDigest: 'a'.repeat(64) },
    { releaseId: 'rel-1', manifestDigest: 'A'.repeat(64) },
    { releaseId: 'rel-1' },
  ]) {
    if (validateTargetInput(bad).ok) problems.push(`非法目标输入被接受：${JSON.stringify(bad)}`)
  }
  if (!validateTargetInput({ releaseId: 'rel-1', manifestDigest: 'a'.repeat(64) }).ok) {
    problems.push('合法目标输入被拒绝')
  }
  if (validateOperationInput({ operationId: 0 }).ok) problems.push('operationId=0 被接受')
  if (validateOperationInput({ operationId: '1' }).ok) problems.push('字符串 operationId 被接受')

  // 投影是白名单：凭据类字段不许出现。
  const projected = projectState({
    state: 'downloading', progress: { bytes: 1, total: 2, phase: 'downloading' },
    token: 'secret', workbenchToken: 'secret', url: 'https://x.example/?k=1', nested: { secret: 1 },
  })
  for (const leak of ['token', 'workbenchToken', 'url', 'nested']) {
    if (Object.hasOwn(projected, leak)) problems.push(`状态投影泄露了字段 ${leak}`)
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    commands: UPDATE_COMMANDS,
  })
}

export const UPDATE_SERVICE_CHECKED = selfCheckUpdateService()
