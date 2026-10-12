// workbench/mobile/notice.mjs
// ============================================================================
// 提示该写到哪儿、会话该不该清 —— 两个**纯决策**。
//
// ★ 为什么把它们单独放在这里，而不是留在 `app.mjs` 里：
//   `app.mjs` 在 Node 里**不可 import**（顶层读 `sessionStorage`），
//   于是它那 1263 行里的渲染、错误路径、会话续期**一条直接判据都没有** ——
//   别处只能对它的源码做正则扫描。而下面这两个判断恰恰是**出过错**的地方，
//   它们**不需要 DOM** 就能判定对错，所以没有理由不可测。
//
// 实测踩到的正是第一条：登录之后发生的每一条失败（发消息失败、500、断网、
// 会话被撤销）都写进 `#login-error`，而它的祖先 `#screen-login` 在进主界面时
// 被整体 `hidden` —— **用户一条错误都看不到**，而界面看起来一切正常。
//
//   > 一个"把错误写进一个 `display:none` 的盒子"的界面，
//   > 与一个"什么都不报错"的界面，在用户眼里是同一个东西。
//
// 第二条是它的邻居：断网重开页面会把 refresh 令牌删掉，逼用户重打口令。
// ============================================================================

/** 登录页内联盒子（`#login-error` / `#login-notice`）的浮层替代。 */
export const HOST_INLINE = 'inline'
/** 全局浮层（`#toast-host`）—— 登录页不可见时唯一能被看见的去处。 */
export const HOST_TOAST = 'toast'

/**
 * 这条提示该写到**登录页内联盒子**，还是**全局浮层**？
 *
 * 判据只有一条：**登录页当前是否可见**。可见时内联（它就在用户眼前）；
 * 不可见时必须换成浮层 —— 否则提示落进一个被 `hidden` 的祖先里，等于没写。
 *
 * ★ 刻意**不按"错误类型"分流**：类型（网络 / 401 / 500 / 校验）分不出
 *   "用户这会儿到底看不看得见"。把一个能看得见的判据换成一个只能猜的判据，
 *   就是当初那个 bug 的成因。
 *
 * @param {{loginScreenVisible: boolean}} input
 * @returns {'inline' | 'toast'}
 */
export function pickNoticeHost({ loginScreenVisible }) {
  if (typeof loginScreenVisible !== 'boolean') {
    throw new TypeError('pickNoticeHost 需要 loginScreenVisible: boolean')
  }
  return loginScreenVisible ? HOST_INLINE : HOST_TOAST
}

/**
 * 这次失败该不该**清掉会话**（连 refresh 令牌一起删）？
 *
 * 判据：Hub 是否**答复了**。
 *   · 答复了并拒绝（带 HTTP `status`）⇒ 会话确实没了，清；
 *   · 网络失败（没有 `status`）⇒ 什么都不知道，**不能清**。
 *
 * ★ 这一条也是实测的：原先 `main()` 里是裸 `catch { clearSession() }`，
 *   于是**断网重开页面**就会把 localStorage 里那把 refresh 令牌删掉，
 *   逼用户重新输口令。地铁、电梯、锁屏唤醒都会命中 —— 而那是手机上
 *   最高频的失败路径。
 *
 *   > 把"我连不上"读成"你被登出了"，代价是用户重新打一遍密码；
 *   > 而这两件事在 `catch` 里长得一模一样。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldClearSession(error) {
  return typeof (error?.status) === 'number'
}

/**
 * 会话过期的专用提示文案。
 *
 * 单独一个函数是为了让它**只有一份**：`api()` 里那条 401 分支与
 * 未来的任何调用点必须说同一句话 —— 否则同一个状态会出现两种措辞，
 * 而用户会以为它们不是一回事。
 */
export function sessionExpiredMessage() {
  return '会话已过期，请重新登录。'
}
