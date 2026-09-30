import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canNavigate, closeAction, createBridgeClient, desktopRequestHeaders, externalUrl, workbenchTarget } from './runtime.mjs'

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

function createWindow() {
  window = new BrowserWindow({
    width: 1180, height: 800, minWidth: 840, minHeight: 560,
    title: 'Legion', show: false, backgroundColor: '#101726',
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
  window.once('ready-to-show', showWindow)
  window.webContents.on('did-finish-load', () => report(current))
  void window.loadURL(startupUrl).catch(() => report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' }))
}

function createTray() {
  const icon = nativeImage.createFromPath(join(desktopDir, 'assets', 'icon.png'))
  tray = new Tray(icon)
  tray.setToolTip('Legion · 正在启动')
  tray.on('double-click', showWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Legion', click: showWindow },
    { label: '运行状态', click: () => { showWindow(); if (window?.webContents.getURL() !== startupUrl) void window.loadURL(startupUrl).catch(() => report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' })) } },
    { label: '重新启动服务', click: () => void restartServices() },
    { type: 'separator' },
    { label: '退出 Legion', click: () => app.quit() },
  ]))
}

function connectBridge() {
  const child = spawn(nodePath, [bridgePath], {
    cwd: installRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LEGION_INSTALL_DIR: installRoot,
      ...(app.isPackaged ? {
        LEGION_HOME: join(app.getPath('userData'), 'product'),
        LEGION_DATA_DIR: undefined, LEGION_CACHE_DIR: undefined, LEGION_LOG_DIR: undefined,
        LEGION_PRODUCT_CONFIG: undefined, LEGION_SECRETS_FILE: undefined,
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
    report({ state: 'failed', code: error?.code ?? 'START_FAILED' })
    if (window && !window.isDestroyed()) {
      try { await window.loadURL(startupUrl) } catch { report({ state: 'failed', code: 'STARTUP_PAGE_FAILED' }) }
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

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
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
        if (bridge) {
          const acknowledgement = await bridge.request('stop')
          if (acknowledgement?.state !== 'stopped') throw Object.assign(new Error('Stop unconfirmed'), { code: 'STOP_FAILED' })
          await bridge.close()
        }
        allowQuit = true
        app.quit()
      } catch (error) {
        quitting = false
        stopping = false
        report({ state: 'failed', code: error?.code ?? 'STOP_FAILED' })
        dialog.showErrorBox('Legion 未能安全退出', '后台服务停止失败。请查看运行状态后重试。')
      }
    })()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    createWindow()
    createTray()
    ipcMain.handle('legion:command', async (event, command) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== startupUrl) throw new Error('IPC_FORBIDDEN')
      if (command === 'status') return current
      if (command === 'retry') { await startServices('restart'); return current }
      if (command === 'stop') {
        viewGeneration++
        workbenchOrigin = null
        const acknowledgement = await bridge.request('stop')
        if (acknowledgement?.state !== 'stopped') throw Object.assign(new Error('Stop unconfirmed'), { code: 'STOP_FAILED' })
        report({ state: 'stopped' })
        return current
      }
      throw new Error('IPC_UNKNOWN_COMMAND')
    })
    connectBridge()
    void startServices()
  })
}
