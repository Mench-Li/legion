// desktop/update-panel.mjs
// ============================================================================
// 更新面板的渲染逻辑 —— 纯函数在这里，DOM 接线在最下面
//
// 分成两层是因为"界面按状态显示什么"这件事**必须能被测**，而 DOM 测试在
// 这个仓库里没有基础设施。所以：
//
//   · `projectView(state)`：状态 → 界面读数（纯函数）。它同时决定：
//       显示哪些按钮、状态那一行说什么、进度条怎么画、错误要不要显示。
//     这是设计 §7 的界面规则**唯一**的落点。
//   · 底部那一段只做"把 projectView 的结果写到 DOM 上"。
//
// ## 三条界面纪律
//
// ① **"稍后"不隐藏设置页**（设计 §7 line 146）。`projectView` 里
//    `snoozed` 只影响"要不要主动弹提醒"，不影响本面板的任何显示——
//    面板是用户主动打开的，用户的意愿就是"我想看"。
//
// ② **自动检查失败不给用户看错误，手动检查才给**（设计 §6 line 134）。
//    所以 `showError` 依赖 `lastCheck.trigger`：`periodic`/`startup`/`resume`
//    的失败只留一句"检查更新失败"（或干脆不提），而 `manual`/`retry`
//    显示完整理由与重试按钮。
//
// ③ **"安装并重启"只在就绪时出现，且从不自动触发**（设计 §7 line 148）。
//    这里连"下载完自动开始安装"这种便利都不做：`install` 的可见性完全由
//    `state === 'ready' || state === 'install-blocked'` 决定。
// ============================================================================

/** 这些触发来源的失败要对用户显示完整理由与重试（设计 §6 line 134）。 */
const USER_INITIATED_TRIGGERS = Object.freeze(['manual', 'retry'])

export const STATE_TEXT = Object.freeze({
  idle: '尚未检查更新。',
  checking: '正在检查更新…',
  available: '发现新版本。',
  downloading: '正在下载更新…',
  verifying: '正在验证更新…',
  ready: '更新已就绪，可以安装。',
  'waiting-for-tasks': '正在等待在途任务结束…',
  preparing: '正在准备更新…',
  installing: '正在安装更新…',
  validating: '正在验证新版本…',
  committed: '升级已完成。',
  'up-to-date': '当前已是最新版本。',
  'check-failed': '检查更新失败。',
  'download-failed': '下载失败。',
  'cancelled': '已取消下载。',
  'install-blocked': '暂时不能安装，任务结束后可重试。',
  'rolled-back': '升级失败，已回退到旧版本，当前版本仍可正常使用。',
  'recovery-required': '升级未能完成，需要人工处理。请联系管理员。',
})

/** 把版本号与通道拼成一行读数。 */
export function describeVersionLine(state) {
  if (typeof state?.currentVersion !== 'string' || state.currentVersion === '') return '—'
  const channel = typeof state.channel === 'string' && state.channel !== '' ? state.channel : '未知通道'
  return `${state.currentVersion}（${channel}）`
}

/** 上次检查那行：时间 + 结论。手动与自动的失败在这里**都要**如实显示。 */
export function describeLastCheck(state, { formatTime = defaultFormatTime } = {}) {
  const last = state?.lastCheck ?? null
  if (last === null || last === undefined || !Number.isSafeInteger(last.atMs)) return '尚未检查'
  const when = formatTime(last.atMs)
  switch (last.outcome) {
    case 'ok':
      return last.productVersion ? `${when}（通道版本 ${last.productVersion}）` : `${when}`
    case 'failed':
    case 'error':
      return `${when}（失败）`
    default:
      return when
  }
}

function defaultFormatTime(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 状态 → 界面读数。**纯函数**，因此每个界面规则都能被断言。
 */
export function projectView(state, { formatTime = defaultFormatTime } = {}) {
  const current = state ?? {}
  const status = current.state ?? 'idle'
  const progress = current.progress ?? null
  const lastError = current.lastError ?? null
  const trigger = current.lastCheck?.trigger ?? null
  const userInitiated = trigger !== null && USER_INITIATED_TRIGGERS.includes(trigger)

  const downloading = status === 'downloading'
  const verifying = status === 'verifying'
  const hasProgress = (downloading || verifying) && progress !== null
  const bytes = Number.isSafeInteger(progress?.bytes) ? progress.bytes : 0
  const total = Number.isSafeInteger(progress?.total) && progress.total > 0 ? progress.total : 0
  const percent = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0

  // ★ 设计 §6 line 134：自动检查失败只留脱敏日志，手动检查才给用户看。
  const showErrorDetail = lastError !== null && (userInitiated || status !== 'check-failed')
  const errorText = lastError === null ? null : (showErrorDetail ? lastError.reason : '检查更新失败。')

  return Object.freeze({
    versionLine: describeVersionLine(current),
    channelLine: typeof current.channel === 'string' && current.channel !== '' ? current.channel : '—',
    lastCheckLine: describeLastCheck(current, { formatTime }),
    latestLine: typeof current.productVersion === 'string' && current.productVersion !== ''
      ? `${current.productVersion}`
      : '—',
    statusText: current.usable === false
      ? (current.unavailableReason ?? '本机尚未配置更新地址，检查更新不可用。')
      : (STATE_TEXT[status] ?? '未知状态。'),
    statusKind: statusTone(status, current.usable === false),
    // —— 按钮可见性 ——
    // 有候选、或在可重试的下载状态时，才显示"下载更新"。
    showDownload: current.usable !== false
      && (status === 'available' || status === 'download-failed' || status === 'cancelled'),
    showCancel: downloading || verifying,
    // "稍后"只在**有东西可以稍后**的时候出现。
    showSnooze: current.usable !== false && status === 'available' && !current.ready,
    showInstall: status === 'ready' || status === 'install-blocked',
    checkEnabled: current.usable !== false && !['checking', 'downloading', 'verifying', 'installing', 'preparing', 'validating'].includes(status),
    // —— 进度 ——
    showProgress: hasProgress,
    percent,
    progressText: hasProgress
      ? (verifying
        ? '正在验证更新…'
        : `${formatBytes(bytes)} / ${formatBytes(total)}（${percent}%）`)
      : '',
    // —— 发布说明 ——
    showNotes: typeof current.releaseNotes === 'string' && current.releaseNotes.trim() !== '',
    notesText: typeof current.releaseNotes === 'string' ? current.releaseNotes : '',
    notesUnavailableReason: typeof current.releaseNotesUnavailableReason === 'string'
      ? current.releaseNotesUnavailableReason : null,
    // —— 错误 ——
    showError: errorText !== null,
    errorText,
    // —— 提示 ——
    hint: hintFor(status, current),
    /** 需要回传给 `update.download` / `update.install` 的身份。 */
    target: typeof current.releaseId === 'string' && typeof current.manifestDigest === 'string'
      ? Object.freeze({ releaseId: current.releaseId, manifestDigest: current.manifestDigest })
      : null,
  })
}

function statusTone(status, unavailable) {
  if (unavailable) return 'error'
  if (status === 'recovery-required' || status === 'check-failed' || status === 'download-failed') return 'error'
  if (status === 'ready' || status === 'committed') return 'ready'
  return 'info'
}

function hintFor(status, current) {
  if (current.usable === false) return '配置更新地址之后即可检查更新。开发环境请参考 product/release/update-config.json。'
  switch (status) {
    case 'downloading':
      return '取消下载不会影响当前正在使用的版本。'
    case 'verifying':
      return '正在校验下载内容的完整性与签名。'
    case 'ready':
      return '安装会重启 Legion。你可以先选择"关闭"稍后再装。'
    case 'waiting-for-tasks':
      return '正在等待在途任务结束。任务需要取消时会另行确认。'
    case 'install-blocked':
      return '任务尚未结束或预检未通过。当前版本不受影响，可稍后重试。'
    case 'committed':
      return '请重新启动 Legion 以使用新版本。'
    case 'rolled-back':
      return '程序已退回旧版本，业务数据未被替换。'
    case 'recovery-required':
      return '请不要删除数据目录，并按管理员指引处理。'
    case 'available':
      return '更新只会在你点击"下载更新"之后开始。'
    default:
      return ''
  }
}

/** 字节数的可读写法（进度文本用）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  const rounded = index === 0 ? value : Math.round(value * 10) / 10
  return `${rounded} ${units[index]}`
}

/**
 * 把一次命令的结果转成一条提示。
 *
 * 「稍后」在这里被明确处理：它不是失败，也不该显示红色。
 */
export function describeCommandResult(command, result) {
  if (result === null || result === undefined) return Object.freeze({ ok: true, text: '' })
  if (result.ok === false) {
    return Object.freeze({ ok: false, text: result.reason ?? '操作未完成。' })
  }
  switch (command) {
    case 'update.check':
      if (result.result?.outcome === 'available') return Object.freeze({ ok: true, text: `发现新版本 ${result.result.candidate?.productVersion ?? ''}。` })
      if (result.result?.outcome === 'up-to-date') return Object.freeze({ ok: true, text: '当前已是最新版本。' })
      return Object.freeze({ ok: true, text: '' })
    case 'update.download':
      return Object.freeze({ ok: true, text: '下载完成，正在等待你确认安装。' })
    case 'update.cancelDownload':
      return Object.freeze({ ok: true, text: '已取消下载。' })
    case 'update.snooze':
      return Object.freeze({ ok: true, text: '已设为 24 小时内不再主动提醒。' })
    case 'update.install':
      return Object.freeze({ ok: true, text: '升级已完成。' })
    default:
      return Object.freeze({ ok: true, text: '' })
  }
}

// ---------------------------------------------------------------------------
// DOM 接线
// ---------------------------------------------------------------------------

/**
 * 把 `projectView` 的结果写到 DOM。
 *
 * `document` 是注入的，因此这一层也能在 Node 里被一个替身驱动——
 * 否则"动态文本走 textContent"这条纪律只能靠人工看代码。
 */
export function render(view, document) {
  const set = (id, text) => {
    const node = document.getElementById(id)
    if (node !== null && node !== undefined) node.textContent = text
  }
  set('version', view.versionLine)
  set('channel', view.channelLine)
  set('last-check', view.lastCheckLine)
  set('latest', view.latestLine)
  set('hint', view.hint)

  const status = document.getElementById('status')
  if (status !== null && status !== undefined) {
    status.textContent = view.showError && view.errorText !== null
      ? `${view.statusText} ${view.errorText}`
      : view.statusText
    status.className = `status ${view.statusKind === 'info' ? '' : view.statusKind}`.trim()
  }

  toggle(document, 'progress', view.showProgress)
  toggle(document, 'notes', view.showNotes)
  toggle(document, 'download', view.showDownload)
  toggle(document, 'cancel', view.showCancel)
  toggle(document, 'snooze', view.showSnooze)
  toggle(document, 'install', view.showInstall)

  const bar = document.getElementById('bar')
  if (bar !== null && bar !== undefined) bar.style.width = `${view.percent}%`
  set('progress-text', view.progressText)
  // ★ `textContent`，不是 `innerHTML`：发布说明是发布方提供的文本。
  set('notes', view.notesText)

  const check = document.getElementById('check')
  if (check !== null && check !== undefined) check.disabled = !view.checkEnabled
  return view
}

function toggle(document, id, visible) {
  const node = document.getElementById(id)
  if (node === null || node === undefined) return
  if (visible) node.removeAttribute('hidden')
  else node.setAttribute('hidden', '')
}

/** 面板启动：只在真的处于 Electron 渲染进程里时接线。 */
function bootstrap() {
  const api = globalThis.legionUpdate
  if (api === undefined || api === null) return
  const { document } = globalThis
  if (document === undefined) return

  let latest = null

  const redraw = () => { if (latest !== null) render(projectView(latest), document) }

  const notify = (result) => {
    const described = describeCommandResult(null, result)
    if (described.text === '') return
    const hint = document.getElementById('hint')
    if (hint !== null && hint !== undefined) hint.textContent = described.text
  }

  const handler = (command, action) => async () => {
    const result = await action()
    notify(result)
    redraw()
    return result
  }

  api.subscribe((state) => {
    latest = state
    render(projectView(state), document)
  })

  const bind = (id, listener) => {
    const node = document.getElementById(id)
    if (node !== null && node !== undefined) node.addEventListener('click', listener)
  }

  bind('check', handler('update.check', () => api.check()))
  bind('download', handler('update.download', () => {
    const target = latest === null ? null : projectView(latest).target
    if (target === null) return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '还没有可下载的版本。' })
    return api.download(target.releaseId, target.manifestDigest)
  }))
  bind('cancel', handler('update.cancelDownload', () => api.cancelDownload(latest?.operationId ?? null)))
  bind('snooze', handler('update.snooze', () => api.snooze()))
  bind('install', handler('update.install', () => {
    const target = latest === null ? null : projectView(latest).target
    if (target === null) return Promise.resolve({ ok: false, code: 'UPDATE_IPC_BAD_INPUT', reason: '还没有可安装的版本。' })
    return api.install(target.releaseId, target.manifestDigest, latest?.pendingTasks ?? null)
  }))
  bind('close', () => globalThis.close())

  void api.status().then((state) => {
    if (state?.ok === true && state.state !== undefined) {
      latest = state.state
      render(projectView(latest), document)
    }
  })
}

if (typeof globalThis.window !== 'undefined' && globalThis.legionUpdate !== undefined) bootstrap()
