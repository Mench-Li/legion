// workbench/mobile/notify-plan.mjs
// ============================================================================
// 系统提醒的三个**纯决策**：用哪个机制发、发出去时带什么标签、按钮该怎么表现。
//
// ★ 为什么单独一个模块：`app.mjs` 在 Node 里**不可 import**（顶层读
//   `sessionStorage`），所以它那 1400 行里的通知路径此前只有"源码正则扫描"级的
//   覆盖。而这三个判断都不需要 DOM 就能判定对错。
//
// ## 修的是什么（实测与规范两条依据）
//
// 修复前发送是这样：
//
//     const n = new Notification('Legion 指挥台', { body, tag: 'legion-' + body.slice(0, 40) })
//     ...
//     } catch { return false }        // ← 静默
//
// 有三个各自独立的问题：
//
// **① 机制选错了。** 移动端浏览器上 `new Notification()` 会抛
//   `Illegal constructor` —— Android Chrome 历来只允许
//   `ServiceWorkerRegistration.showNotification()`；iOS 16.4 起的 Web Push
//   同理，只能走 Service Worker 的通知。而那个异常被 `catch` 吞掉，
//   于是 `notifySystem` 返回 `false`，而**界面上写的是"🔔 已开启系统提醒"**。
//
//   > 一个"点了开启、得到确认、然后一条也收不到"的功能，
//   > 与一个"还没做"的功能，在用户眼里是同一个东西 ——
//   > 只不过前者让人以为是自己手机的问题。
//
// **② 去重的键选错了。** `tag` 取的是**文案前 40 字**。两条不同任务的提醒
//   只要开头相似就会互相顶掉（同一个 tag 的旧通知会被新通知替换）——
//   用户最后只看到一条，而"有几件事在等他"正是这个提醒要回答的问题。
//   去重的键应当是**任务号**：它是提醒的身份。
//
// **③ 失败没有出口。** 返回 `false` 之后没有人再管。现在有了全局浮层
//   （`notice.mjs`），失败必须说出来。
// ============================================================================

/** 发送机制。`'none'` = 这次不该发（决策在 `popup.mjs` 的 `shouldUseSystemNotify`）。 */
export const MECHANISM_SERVICE_WORKER = 'service-worker'
export const MECHANISM_CONSTRUCTOR = 'constructor'
export const MECHANISM_NONE = 'none'

/**
 * 这次该用哪个机制发系统提醒。
 *
 * 顺序是刻意的：**有 Service Worker 就用它**。它在两端都对：
 *   · 移动端（Android Chrome / iOS 16.4+）**只有**这一条路能通；
 *   · 桌面端它同样可用，而且顺带让点击通知能被 Service Worker 接住
 *     （`notificationclick` 可以聚焦窗口并跳到那条任务；`new Notification()`
 *     的 `onclick` 在页面被系统冻结时不会执行）。
 *
 * 所以 `new Notification()` 只作**兜底**：极老的桌面浏览器、或 SW 还没就绪。
 * 它不是"另一种一样的做法" —— 它是"在没有更好的选择时的退路"。
 *
 * @param {{swReady?: boolean, supported?: boolean}} input
 *   `supported`：`Notification` 构造器是否存在（`new Notification` 的可用性）。
 *   `swReady`：`navigator.serviceWorker.ready` 是否已就绪且 `showNotification` 可用。
 * @returns {'service-worker' | 'constructor' | 'none'}
 */
export function notifyMechanism({ swReady = false, supported = true } = {}) {
  if (swReady) return MECHANISM_SERVICE_WORKER
  if (supported) return MECHANISM_CONSTRUCTOR
  return MECHANISM_NONE
}

/**
 * 系统通知的去重标签。
 *
 * ★ 用**任务号**而不是文案。修复前是 `'legion-' + body.slice(0, 40)` ——
 *   两条不同任务只要前 40 字相同就互相顶掉，而"有几件事在等你"正是这个
 *   提醒要回答的问题。
 *
 * 没有任务号时退回**文案的稳定摘要**（不是前 40 字）：仍然会有碰撞，
 * 但至少同一条文案每次都得到同一个标签（幂等），而不是"前 40 字相同即碰撞"。
 *
 * @param {unknown} taskId
 * @param {string} [text] 没有任务号时的兜底文本
 * @returns {string}
 */
export function notificationTag(taskId, text = '') {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  // 任务号一般形如 `T-123`：白名单字符，避免出现怪异的 tag。
  if (id.length > 0 && /^[A-Za-z0-9._-]{1,64}$/.test(id)) return `legion-task-${id}`
  return `legion-text-${stableHash(String(text))}`
}

/**
 * 一个稳定的 32 位摘要（FNV-1a）。**不是密码学哈希** —— 这里只要
 * "同一段文本恒得同一个值、不同文本大概率不同"，不需要抗碰撞。
 */
export function stableHash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    // FNV 质数 16777619，用移位与加法避免 32 位溢出问题。
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 顶部那个「🔔」按钮该怎么表现。
 *
 * 修复前的判据是一行：
 *
 *     btn.classList.toggle('hidden', !(supported && permission === 'default'))
 *
 * 也就是**只有"支持且还没问过"时才出现**。于是：
 *   · 用户点了「不允许」→ 按钮**消失**，没有任何解释，也再没有入口去改；
 *   · 浏览器不支持 → 同样消失，用户不知道是"这里不支持"还是"我点坏了"。
 *
 *   > 一个"被拒绝之后就消失"的授权入口，
 *   > 与一个"从来没提供过"的功能，在用户眼里是同一个东西 ——
 *   > 只不过前者还额外让用户失去了改回来的线索。
 *
 * 改成**始终可见**，并且按状态给出**能照着做的一句话**。
 *
 * @param {{supported?: boolean, permission?: string, standalone?: boolean}} input
 * @returns {{visible: boolean, actionable: boolean, message: string}}
 */
export function notifyButtonPlan({ supported = true, permission = 'default', standalone = false } = {}) {
  if (!supported) {
    // iOS 上「添加到主屏幕」之前根本没有通知能力，所以那句话要分平台说 ——
    // 对一个已经装了 PWA 的人说"请添加到主屏幕"等于让他去撞墙。
    return {
      visible: true,
      actionable: false,
      message: standalone
        ? '这个浏览器不支持系统提醒；页面内的提醒照常出现。'
        : '这台设备要先「添加到主屏幕」，之后才能开启系统提醒。',
    }
  }
  if (permission === 'granted') {
    return { visible: true, actionable: false, message: '🔔 系统提醒已开启：页面不在前台时也会通知你。' }
  }
  if (permission === 'denied') {
    // ★ 被拒之后**浏览器不允许再问**（`requestPermission()` 会立刻返回 denied），
    //   所以这里给的不是"再点一次"，而是"去哪儿改"。
    return {
      visible: true,
      actionable: false,
      message: '提醒被浏览器拒绝了。请在站点设置里把「通知」改为允许，然后刷新页面。',
    }
  }
  return { visible: true, actionable: true, message: '开启系统提醒：页面不在前台时也会通知你。' }
}
