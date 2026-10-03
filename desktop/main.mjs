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
let selectedWorkspace = null
let choosingWorkspace = false

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
    { label: '停止共享后台（Web 和桌面均停止服务）', click: () => void stopServices().catch(error => report({ state: 'failed', code: error?.code ?? 'STOP_FAILED' })) },
    { type: 'separator' },
    { label: '退出桌面端（后台继续运行）', click: () => app.quit() },
  ]))
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
