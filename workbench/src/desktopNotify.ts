/**
 * 系统级提醒（桌面通知）—— BUG-021 的第二半。
 *
 * ## 为什么在页面弹框之外还要它
 *
 * 右下角弹框只在**页面可见**时有意义。而"物理离开电脑"正是这条需求的起因
 * （用户原话：手机能操控电脑、人在外面也要知道进度）：切到别的窗口/最小化时，
 * 页面里的弹框**一个都看不见**。
 *
 *   > 一个只在自己窗口里弹的提醒，
 *   > 与一个"你不在看它就不响"的提醒，是同一件事。
 *
 * ## 三条纪律
 *
 *   1. **绝不自动请求权限**：`Notification.requestPermission()` 只能在用户手势里调用，
 *      而且自动弹一个系统授权框会被用户直接拒掉（拒一次就再也回不来）。
 *      所以只在这里读 `permission`，请求由通知中心那个按钮触发。
 *   2. **只在页面不可见时才发**：页面可见时右下角弹框已经说过了，再发一条系统通知是重复打扰。
 *   3. **点了要能回来**：`onclick` 里 `focus()` 窗口，否则用户点完通知还得自己找窗口。
 */

/** 纯决策：现在该不该发系统通知（可测；副作用另说）。 */
export function shouldUseSystemNotify(input: { hidden: boolean; permission: string }): boolean {
  return input.hidden && input.permission === 'granted'
}

/** 浏览器是否支持（Electron/桌面壳里通常支持）。 */
export function systemNotifySupported(): boolean {
  return typeof Notification !== 'undefined'
}

/** 当前权限：'unsupported' | 'default' | 'granted' | 'denied'。 */
export function systemNotifyPermission(): string {
  return systemNotifySupported() ? Notification.permission : 'unsupported'
}

/**
 * 请求授权（**必须在用户手势里调用**，例如按钮 onClick）。
 * 返回请求后的权限；不支持或抛错时返回当前权限/unsupported，不向上抛。
 */
export async function requestSystemNotifyPermission(): Promise<string> {
  if (!systemNotifySupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return systemNotifyPermission()
  }
}

/**
 * 发一条系统通知。**只在页面不可见且有权限时**才真的发（见上面第 2 条纪律）。
 * 返回是否真的发了——调用方不必关心，返回值只给判据用。
 */
export function notifySystem(body: string, title = 'Legion 指挥台'): boolean {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const permission = systemNotifyPermission()
  if (!shouldUseSystemNotify({ hidden, permission })) return false
  try {
    const n = new Notification(title, { body, tag: 'legion-' + body.slice(0, 40) })
    n.onclick = () => {
      try { window.focus() } catch { /* 某些壳里不允许 */ }
      n.close()
    }
    return true
  } catch {
    return false
  }
}
