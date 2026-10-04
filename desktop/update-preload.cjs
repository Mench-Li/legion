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
  //
  // ★ **不接受**在途任务读数。
  //
  //   早先这里接受第三个参数 `pendingTasks`，注释写的是"只用于界面展示"。
  //   那句话与该值的**作用**不符：它会一路流进预检
  //   （`runPreflight({ tasks })`），而预检对 `[]` 判 `ok`（放行）、对
  //   `null` 判 `unknown`（拦）。
  //
  //   ★ 说明准确一点：主进程那边的 `validateTargetInput` 要求载荷**恰好**
  //     是 `releaseId`/`manifestDigest` 两个字段，所以那个额外的
  //     `pendingTasks` 实际上到不了预检——它是**不可达**的，不是一条
  //     可被利用的绕过。这里删掉它的理由是另外两条：
  //
  //       ① 一段"看起来能把安全判据说成安全"的代码，下一次有人放宽
  //          字段集判据时就会变成一条真的绕过；不可达的安全性靠的是
  //          **另一个文件**里的一个判据，而那个判据没有义务一直这样。
  //       ② 注释与作用不符本身就是缺陷：读它的人会以为任务读数是由
  //          界面提供的，从而在别处继续这样接。
  //
  //   这个读数现在完全由主进程读：它有 bridge、能连上 team-hub 的端口，
  //   而渲染进程两样都没有。
  install: (releaseId, manifestDigest) => {
    const value = target(releaseId, manifestDigest)
    if (value === null) return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '安装目标的身份不合法' })
    return send('update.install', value)
  },
  // —— update.tasks：无参数（只读；设计 §7 line 150 的展示读数） ——
  //
  // ★ 这是一个**只读**命令，且它返回的是主进程自己读到的读数——
  //   渲染进程既不能提供它、也不能影响它。它只用于显示"是否有在途任务"。
  tasks: () => send('update.tasks', {}),
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
