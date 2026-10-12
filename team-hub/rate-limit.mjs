// team-hub/rate-limit.mjs
// ============================================================================
// 滑窗限速的**纯决策**部分：给定一串"发生过的时间戳"，算出现在允不允许、以及
// 还要等多久。存储（SQLite）在 `user-store.mjs`，本模块不碰任何 I/O。
//
// ## 为什么把这段单独抽出来
//
// 限速的 bug 几乎都不是"没写"，而是**边界算错了**，而那种错在人工点几下时
// 完全看不出来：
//
//   · 窗口是 `>` 还是 `>=`（差一个，上限就少一次）；
//   · `Retry-After` 给的是"整窗口"还是"最早那条过期的时间"（后者才对，
//     前者会让用户在窗口已经空了一半的时候还被告知等整整一小时）；
//   · 上限 <= 0 是"关掉"还是"谁都不许"（前者是配置语义，后者是把自己锁在门外）。
//
//   > 一段"大部分时候算对"的限速，与一段算对的限速，
//   > 在没人试过边界的时候是同一个东西。
//
// ## 一个刻意的语义选择：数的是**尝试**，不是**失败**
//
// 登录失败锁定（`user-store` 的按用户名那一套）在**成功时清零**——那是对的，
// 因为它问的是"这个账号是不是正在被猜"。
//
// 按 IP 的这一套**不清零**：它问的是"这个来源正在发多少次请求"。
// 一次成功的登录也占一次配额，因为否则**任何有一个有效账号的攻击者**
// 只要交替"成功一次 / 猜十次"就能把配额刷回来，限速等于不存在。
//
//   > 一个在成功时清零的按 IP 限速，对"已经攻破一个账号的人"是完全无效的。
// ============================================================================

/** 一条被拒绝时的 HTTP 语义：状态码 + `Retry-After`。 */
export const RATE_LIMIT_STATUS = 429

/**
 * 算出现在允不允许。
 *
 * @param {{times?: number[], atMs: number, max: number, windowMs: number}} input
 *        `times` 是"最近发生过的时间戳"（无序、可含窗口外的旧值；本函数自己筛）
 * @returns {{allowed: boolean, count: number, max: number, retryAfterMs: number, retryAfterSec: number, disabled: boolean}}
 *          `count` = **窗口内**的条数（不是 `times.length`）。
 *          `retryAfterSec` 是给 `Retry-After` 头用的整数秒，**至少 1**
 *          —— 回 0 会让客户端立刻重试，那正是最坏的反应。
 */
export function limitDecision({ times = [], atMs, max, windowMs } = {}) {
  const list = Array.isArray(times) ? times.filter((t) => Number.isFinite(t)) : []
  // `max <= 0` = **关掉闸门**。与注册闸门同一语义：明确写出来才算，
  // 不给"忘了配"留一条静默放行的路（虽然这个方向的默认是"放行"，但它是**显式**的）。
  if (!Number.isFinite(max) || max <= 0) {
    return { allowed: true, count: list.length, max, retryAfterMs: 0, retryAfterSec: 0, disabled: true }
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { allowed: true, count: list.length, max, retryAfterMs: 0, retryAfterSec: 0, disabled: true }
  }
  // ★ 边界用 `>`：`at - windowMs` 那一**瞬间**不算在窗口内。
  //   用 `>=` 的话，正好落在边界上的那条会被永久计入（因为时间一直在走），
  //   于是窗口"粘住"一条记录，配额少一次且永远不会恢复。
  const inWindow = list.filter((t) => t > atMs - windowMs)
  if (inWindow.length < max) {
    return { allowed: true, count: inWindow.length, max, retryAfterMs: 0, retryAfterSec: 0, disabled: false }
  }
  // 还要等多久：**最早那条**过期就行。回"整个窗口"会把用户多关一段时间。
  const oldest = Math.min(...inWindow)
  const retryAfterMs = Math.max(0, oldest + windowMs - atMs)
  return {
    allowed: false, count: inWindow.length, max,
    retryAfterMs,
    retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    disabled: false,
  }
}

/**
 * 该给用户看的一句话。
 *
 * ★ 必须说清"这是**来源**级别的限制，不是你的账号被锁" ——
 *   否则用户会去改密码、去问管理员"我账号是不是被封了"，而其实
 *   换一个网络（或等一会儿）就好了。同一间办公室/同一个运营商出口
 *   后面的人会**一起**被限，那不是他的错。
 *
 * ★ 也**不能**提用户名是否存在：这条消息对"猜别人的名字"和"猜自己的名字"
 *   必须一模一样，否则它就成了一个用户名探测接口。
 */
export function limitMessage({ retryAfterSec, scope = 'source' } = {}) {
  const mins = Math.max(1, Math.ceil((Number(retryAfterSec) || 0) / 60))
  const where = scope === 'account' ? '这个账号' : '这个网络'
  return `来自${where}的尝试过于频繁，请约 ${mins} 分钟后重试。`
    + '（这是**来源**级别的限速，不是账号被封；换一个网络通常可以立即继续。）'
}

/** 具名错误码：前端按**类型**分支，不按文案匹配。 */
export const RATE_LIMIT_CODE = 'IDENTITY_RATE_LIMITED'
