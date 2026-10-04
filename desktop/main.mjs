import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canNavigate, closeAction, createBridgeClient, desktopRequestHeaders, externalUrl, workbenchTarget } from './runtime.mjs'
import { resolveUpdateRuntime, trayLabelFor } from './update-wiring.mjs'

const desktopDir = fileURLToPath(new URL('.', import.meta.url))
const startupPath = join(desktopDir, 'startup.html')
const startupUrl = pathToFileURL(startupPath).href
const installRoot = app.isPackaged ? join(process.resourcesPath, 'legion') : join(desktopDir, '..')
const nodePath = app.isPackaged ? join(process.resourcesPath, 'node', 'node.exe') : process.env.LEGION_DESKTOP_NODE || 'node'
const bridgePath = join(installRoot, 'product', 'launcher', 'desktop-bridge.mjs')
const desktopToken = randomBytes(32).toString('hex')

let window = null
let tray = null
let bridge = null
let workbenchOrigin = null
let quitting = false
let stopping = false
let allowQuit = false
let serviceTransition = null
let viewGeneration = 0
let current = { state: 'starting', phase: 'preparing' }
let selectedWorkspace = null
let choosingWorkspace = false
let updateRuntime = null
let updateState = null
let updateMarksInteractive = false

function showWindow() {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function report(state) {
  current = state
  if (window && !window.isDestroyed()) window.webContents.send('legion:state', state)
  if (tray) tray.setToolTip(`Legion · ${state.state ?? '正在启动'}`)
}

function identityInput(value) {
  const fields = ['actor', 'scope', 'action']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => ![...fields, 'allowWorkspaceWrites'].includes(key))
    || typeof value.allowWorkspaceWrites !== 'boolean') throw new Error('DESKTOP_IDENTITY_INVALID')
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].trim() === '' || value[field].trim().length > 128
      || /[\u0000-\u001f\u007f]/u.test(value[field])) throw new Error('DESKTOP_IDENTITY_INVALID')
  }
  return { actor: value.actor.trim(), scope: value.scope.trim(), action: value.action.trim(), allowWorkspaceWrites: value.allowWorkspaceWrites }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180, height: 800, minWidth: 840, minHeight: 560,
    title: 'Legion', show: false, backgroundColor: '#101726',
    icon: join(desktopDir, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: join(desktopDir, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'legion-desktop',
    },
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!canNavigate(url, { startup: startupUrl, origin: workbenchOrigin })) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!canNavigate(url, { startup: startupUrl, origin: workbenchOrigin })) event.preventDefault()
  })
  const ownedSession = window.webContents.session
  ownedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ownedSession.setPermissionCheckHandler(() => false)
  ownedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: details.resourceType === 'subFrame' })
  })
  ownedSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ requestHeaders: desktopRequestHeaders(details, {
      origin: workbenchOrigin, token: desktopToken, webContentsId: window?.webContents.id,
    }) })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = externalUrl(url)
    if (allowed) void shell.openExternal(allowed)
    return { action: 'deny' }
  })
  window.on('close', (event) => {
    if (closeAction({ quitting, closeToTray: true }) === 'hide') {
      event.preventDefault()
      window.hide()
    }
  })
  window.once('ready-to-show', () => {
    showWindow()
    // ① 桌面达到可交互状态 → 首次检查开始计时（设计 §6 line 132）。
    markUpdateInteractive()
  })
  window.webContents.on('did-finish-load', () => report(current))
  void window.loadURL(startupUrl).catch(() => report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' }))
}

function createTray() {
  const icon = nativeImage.createFromPath(join(desktopDir, 'assets', 'icon.png'))
  tray = new Tray(icon)
  tray.setToolTip('Legion · 正在启动')
  tray.on('double-click', showWindow)
  tray.setContextMenu(buildTrayMenu())
}

/**
 * 托盘菜单。
 *
 * 更新相关的两项按设计 §7 来的：
 *   · 「检查更新 / 关于 Legion」打开更新面板（面板里才有"检查更新"按钮，
 *     因为手动检查要能显示错误与重试）；
 *   · 有新版且**不在 24 小时"稍后"期内**时，菜单项直接写出发现的新版本。
 *
 * ★ 这里**没有**"下载并安装"或"安装更新"这样的菜单项。设计 §7 line 148
 *   把"就绪后安装"放在面板里的用户确认之后：一个托盘菜单上的"安装更新"
 *   会让一次误点触发真实的程序切换，而托盘图标是很容易被误点的。
 * ★ 「退出桌面端」**不触发安装**（设计 §7 line 148：「关闭窗口、退出或
 *   托盘退出均不自动安装」）。所以这里的退出项与更新状态完全无关。
 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 Legion', click: showWindow },
    { label: '运行状态', click: () => { showWindow(); if (window?.webContents.getURL() !== startupUrl) void window.loadURL(startupUrl).catch(() => report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' })) } },
    { label: '重新启动服务', click: () => void restartServices() },
    { label: '停止共享后台（Web 和桌面均停止服务）', click: () => void stopServices().catch(error => report({ state: 'failed', code: error?.code ?? 'STOP_FAILED' })) },
    { type: 'separator' },
    {
      label: trayLabelFor(updateState ?? { usable: false, state: 'idle' }),
      click: () => void openUpdatePanel(),
    },
    { type: 'separator' },
    { label: '退出桌面端（后台继续运行）', click: () => app.quit() },
  ])
}

function refreshTray() {
  if (!tray) return
  try { tray.setContextMenu(buildTrayMenu()) } catch { /* 托盘重建失败不该影响主流程 */ }
}

async function openUpdatePanel() {
  if (updateRuntime === null || updateRuntime.ok !== true) {
    dialog.showMessageBox({
      type: 'info', title: '更新不可用', message: '当前无法检查更新',
      detail: updateRuntime?.reason ?? '更新运行时尚未准备好，请稍后重试。',
    }).catch(() => {})
    return
  }
  // ① 用户主动打开面板 = 桌面已经可交互。首次自动检查的 30～90 秒从这一刻
  //    开始计时（设计 §6 line 132），而不是从进程启动开始。
  markUpdateInteractive()
  try { await updateRuntime.service.showPanel({ parent: window }) } catch { /* 面板打开失败不该中断应用 */ }
}

/** 幂等：`markInteractive` 只应该真的调用一次。 */
function markUpdateInteractive() {
  if (updateMarksInteractive) return
  updateMarksInteractive = true
  try { updateRuntime?.markInteractive?.() } catch { /* 计时失败不该影响启动 */ }
}

/**
 * 启动更新运行时。
 *
 * 全部失败都**只记录**：更新不可用不是应用不可用。这条纪律对应设计 §10 的
 * 第一行验收判据——「无更新、离线、超时、CDN 返回旧清单 → 现有工作不受影响」。
 */
function startUpdateRuntime() {
  const cacheDir = join(app.getPath('userData'), 'updates')
  void (async () => {
    try {
      updateRuntime = await resolveUpdateRuntime({
        installRoot,
        cacheDir,
        // 数据目录与 update-config 读的是同一份安装布局；`--data-dir` 的
        // 覆盖由 Launcher 负责，这里用 userData 下的固定位置。
        dataDir: join(app.getPath('userData'), 'legion-data'),
        desktopDir,
        // ★ 安装事务要通过 bridge 请求 Launcher 停认领/停服务。
        //   它是**同一批要被停掉的进程**的控制通道，所以必须在 Electron 退出
        //   之前完成"停止服务"那一步；切换程序本身交给独立 helper。
        get bridge() { return bridge },
        nodePath,
        helperEntry: join(process.resourcesPath ?? installRoot, 'update', 'helper-entry.mjs'),
        onNotify: (snapshot) => {
          // 主动提醒（设计 §7 line 146）：同一发行 24 小时内不重复。
          // 只有托盘气泡，不弹模态窗口——自动检查不该打断用户工作。
          try {
            if (tray && typeof tray.displayBalloon === 'function') {
              tray.displayBalloon({
                title: 'Legion 有新版本',
                content: `${snapshot.productVersion ?? ''} 已可用。打开"检查更新"查看发布说明。`,
              })
            }
          } catch { /* 气泡失败不是错误 */ }
        },
        log: (line) => { if (!app.isPackaged) process.stdout.write(`${line}\n`) },
      })
      if (updateRuntime.ok !== true) return
      try {
        updateRuntime.client.subscribe((snapshot) => { updateState = snapshot; refreshTray() })
      } catch { /* 订阅失败只影响托盘文案 */ }
    } catch (error) {
      updateRuntime = { ok: false, reason: `更新运行时启动失败：${error?.message ?? error}` }
    }
  })()
}

function connectBridge() {
  const child = spawn(nodePath, [bridgePath], {
    cwd: installRoot, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LEGION_INSTALL_DIR: installRoot,
      ...(app.isPackaged ? {
        NODE_OPTIONS: undefined, NODE_PATH: undefined,
        PATH: `${join(process.resourcesPath, 'node')};${join(process.resourcesPath, 'git', 'cmd')};${join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')};${process.env.PATH ?? ''}`,
      } : {}) },
  })
  child.stderr.resume()
  bridge = createBridgeClient(child, {
    onEvent: (event) => {
      if (event.type === 'progress') report({ state: 'starting', phase: event.payload?.phase ?? 'starting',
        completed: event.payload?.completed, total: event.payload?.total })
    },
  })
  child.on('exit', () => { if (!quitting) report({ state: 'failed', code: 'BRIDGE_EXITED' }) })
  child.on('error', () => report({ state: 'failed', code: 'BRIDGE_EXITED' }))
}

async function startServices(type = 'start') {
  if (stopping) return
  if (serviceTransition) return serviceTransition
  const generation = ++viewGeneration
  serviceTransition = performStart(type, generation)
  try { return await serviceTransition } finally { serviceTransition = null }
}

async function performStart(type, generation) {
  try {
    workbenchOrigin = null
    report({ state: 'starting', phase: type === 'restart' ? 'restarting' : 'starting' })
    const result = await bridge.request(type, { token: desktopToken,
      ...(app.isPackaged ? { bundleRoot: process.resourcesPath } : {}) })
    if (generation !== viewGeneration || stopping) return
    const target = workbenchTarget(result)
    if (target) {
      workbenchOrigin = new URL(target).origin
      report({ state: result.state, phase: 'ready' })
      await window.loadURL(target)
    } else {
      report({ state: result.state, code: 'WORKBENCH_NOT_READY' })
    }
  } catch (error) {
    if (generation !== viewGeneration || stopping) return
    const phase = error?.code === 'WORKSPACE_NOT_CONFIGURED' ? 'workspace'
      : error?.code === 'ENFORCEMENT_IDENTITY_MISSING' ? 'identity'
        : error?.code === 'MODEL_NOT_CONFIGURED' ? 'model' : null
    report(phase ? { state: 'setup-required', phase, workspace: selectedWorkspace }
      : { state: 'failed', code: error?.code ?? 'START_FAILED',
        ...(error?.portConflict ? { portConflict: error.portConflict } : {}) })
    if (window && !window.isDestroyed()) {
      if (window.webContents.getURL() !== startupUrl) {
        try { await window.loadURL(startupUrl) } catch { report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' }) }
      }
    }
  }
}

async function restartServices() {
  if (!bridge) return
  if (window && !window.isDestroyed()) {
    try { await window.loadURL(startupUrl) } catch { report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' }); return }
  }
  await startServices('restart')
}

async function stopServices() {
  viewGeneration++
  workbenchOrigin = null
  const acknowledgement = await bridge.request('stop')
  if (acknowledgement?.state !== 'stopped') throw Object.assign(new Error('Stop unconfirmed'), { code: 'STOP_FAILED' })
  report({ state: 'stopped' })
  if (window && !window.isDestroyed() && window.webContents.getURL() !== startupUrl) await window.loadURL(startupUrl)
  return current
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('resume', () => {
    // ③ 系统唤醒：只在到期时补一次，不累计执行错过的周期（设计 §6 line 132）。
    try { updateRuntime?.client?.notifyResume?.() } catch { /* 唤醒补检失败不该影响应用 */ }
  })
  app.on('before-quit', (event) => {
    if (allowQuit) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    viewGeneration++
    quitting = true
    workbenchOrigin = null
    report({ state: 'stopping' })
    void (async () => {
      try {
        // ★ 退出**不**自动安装（设计 §7 line 148）。这里只做一件事：
        //   让调度器停止计时并让出 IPC，避免退出流程里又发起一次检查或
        //   在进程收尾阶段触发下载。
        try { updateRuntime?.close?.() } catch { /* 退出清理失败不该阻断退出 */ }
        if (bridge) {
          const acknowledgement = await bridge.request('detach')
          if (acknowledgement?.state !== 'detached') throw Object.assign(new Error('Detach unconfirmed'), { code: 'DETACH_FAILED' })
          await bridge.close({ detach: true })
        }
        allowQuit = true
        app.quit()
      } catch (error) {
        quitting = false
        stopping = false
        report({ state: 'failed', code: error?.code ?? 'STOP_FAILED' })
        dialog.showErrorBox('Legion 未能安全退出', '桌面连接断开失败。请查看运行状态后重试。')
      }
    })()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()
    createTray()
    // 更新运行时在窗口建好之后才装载：它要读打包时写入的配置，
    // 而"配置坏了"绝不能影响窗口出现（设计 §10 第一行验收）。
    startUpdateRuntime()
    ipcMain.handle('legion:command', async (event, command, payload) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== startupUrl) throw new Error('IPC_FORBIDDEN')
      if (command === 'status') return current
      if (command === 'choose-workspace') {
        if (stopping || serviceTransition || choosingWorkspace || current.state !== 'setup-required' || current.phase !== 'workspace') throw new Error('DESKTOP_SETUP_BUSY')
        choosingWorkspace = true
        try {
          const selection = await dialog.showOpenDialog(window, {
            title: '选择 Legion 工作区', buttonLabel: '选择此文件夹', properties: ['openDirectory'],
          })
          if (!stopping && !selection.canceled && selection.filePaths.length === 1) {
            selectedWorkspace = selection.filePaths[0]
            report({ state: 'setup-required', phase: 'workspace', workspace: selectedWorkspace })
          }
          return current
        } finally { choosingWorkspace = false }
      }
      if (command === 'configure-workspace') {
        if (stopping || serviceTransition || choosingWorkspace || selectedWorkspace === null || current.state !== 'setup-required' || current.phase !== 'workspace') throw new Error('DESKTOP_SETUP_BUSY')
        const workspace = selectedWorkspace
        serviceTransition = (async () => {
          try {
            report({ state: 'starting', phase: 'initializing' })
            const result = await bridge.request('configure-workspace', { workspace, token: desktopToken,
              ...(app.isPackaged ? { bundleRoot: process.resourcesPath } : {}) })
            if (!stopping && !quitting) report(result)
          } catch (error) { if (!stopping && !quitting) report({ state: 'failed', code: error?.code ?? 'DESKTOP_SETUP_FAILED' }) }
        })()
        try { await serviceTransition; return current } finally { serviceTransition = null }
      }
      if (command === 'configure-identity') {
        if (stopping || serviceTransition || current.state !== 'setup-required' || current.phase !== 'identity') throw new Error('DESKTOP_SETUP_BUSY')
        const identity = identityInput(payload)
        serviceTransition = (async () => {
          try {
            report({ state: 'starting', phase: 'saving-identity' })
            const result = await bridge.request('configure-identity', { identity, token: desktopToken,
              ...(app.isPackaged ? { bundleRoot: process.resourcesPath } : {}) })
            if (!stopping && !quitting) report(result)
          } catch (error) { if (!stopping && !quitting) report({ state: 'failed', code: error?.code ?? 'DESKTOP_SETUP_FAILED' }) }
        })()
        try { await serviceTransition; return current } finally { serviceTransition = null }
      }
      if (command === 'configure-model') {
        if (stopping || serviceTransition || current.state !== 'setup-required' || current.phase !== 'model') throw new Error('DESKTOP_SETUP_BUSY')
        serviceTransition = (async () => {
          try {
            report({ state: 'starting', phase: 'verifying-model' })
            const model = await bridge.request('configure-model', { model: payload, token: desktopToken,
              ...(app.isPackaged ? { bundleRoot: process.resourcesPath } : {}) })
            if (!stopping && !quitting && model?.state === 'configured') {
              await performStart('start', ++viewGeneration)
            } else if (!stopping && !quitting) report({ state: 'setup-required', phase: 'model', workspace: selectedWorkspace })
          } catch (error) {
            if (!stopping && !quitting) report({ state: 'setup-required', phase: 'model', workspace: selectedWorkspace,
              code: error?.code ?? 'MODEL_SETUP_FAILED' })
          }
        })()
        try { await serviceTransition; return current } finally { serviceTransition = null }
      }
      if (command === 'retry') { await startServices('restart'); return current }
      if (command === 'stop') {
        return stopServices()
      }
      throw new Error('IPC_UNKNOWN_COMMAND')
    })
    connectBridge()
    void startServices()
  })
}
