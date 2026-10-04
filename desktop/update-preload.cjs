// desktop/update-preload.cjs
// ============================================================================
// 更新面板的 preload —— 设计 §7 那张"有界操作"表的**渲染进程**侧
//
// 这张表就是这里暴露的全部内容。刻意**没有**的东西：
//
//   · 没有 `invoke(channel, ...)` 这种通用入口 —— 有它就等于把整个 IPC
//     面交给页面，而"主进程会校验"是唯一的防线。
//   · 没有接受 URL / 路径 / 命令行参数的函数 —— 每个函数的签名里只有
//     `releaseId` + `manifestDigest` 或一个整数操作 ID。
//   · 没有 `require` / `process` / `fs` —— `contextIsolation: true` +
//     `sandbox: true` 保证页面拿不到它们。
//
// `subscribe` 是一个**单向**通道：主进程推、页面收。页面无法通过它回传
// 任何东西，因此"网页不能直接触发迁移或程序切换"（设计 §7 line 162）
// 在结构上成立。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron')

const STATE_CHANNEL = 'legion:update-state'

/** 目标输入：只允许这两个字符串字段。形状不对时**在本地就拒**，不发 IPC。 */
function target(releaseId, manifestDigest) {
  if (typeof releaseId !== 'string' || typeof manifestDigest !== 'string') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) return null
  if (!/^[0-9a-f]{64}$/.test(manifestDigest)) return null
  return { releaseId, manifestDigest }
}

function send(command, payload) {
  return ipcRenderer.invoke('legion:update', command, payload)
}

contextBridge.exposeInMainWorld('legionUpdate', Object.freeze({
  // —— update.status：无参数 ——
  status: () => send('update.status', {}),
  // —— update.check：无参数 ——
  check: () => send('update.check', {}),
  // —— update.download：releaseId + manifestDigest ——
  download: (releaseId, manifestDigest) => {
    const value = target(releaseId, manifestDigest)
    if (value === null) return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '下载目标的身份不合法' })
    return send('update.download', value)
  },
  // —— update.cancelDownload：当前下载操作 ID ——
  cancelDownload: (operationId = null) => {
    if (operationId !== null && (!Number.isSafeInteger(operationId) || operationId < 1)) {
      return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '操作 ID 不合法' })
    }
    return send('update.cancelDownload', { operationId })
  },
  // —— update.install：releaseId + manifestDigest ——
  install: (releaseId, manifestDigest, pendingTasks = null) => {
    const value = target(releaseId, manifestDigest)
    if (value === null) return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '安装目标的身份不合法' })
    // 在途任务的读数只用于界面展示"是否有任务在跑"，因此只允许一个很小的
    // 数字与一个字符串数组，不接受任意对象。
    const tasks = Array.isArray(pendingTasks)
      ? pendingTasks.filter((item) => typeof item === 'string').slice(0, 64)
      : null
    return send('update.install', { ...value, pendingTasks: tasks })
  },
  // —— update.snooze：无参数（"稍后"固定 24 小时，不接受时长） ——
  snooze: () => send('update.snooze', {}),
  // —— update.subscribe：单向状态推送 ——
  subscribe: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, state) => { callback(state) }
    ipcRenderer.on(STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener)
  },
}))
