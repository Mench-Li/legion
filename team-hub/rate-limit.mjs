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
 * **唯一的**边界判定。两个入口（`limitDecision` / `quotaDecision`）都走它。
 *
 * ★ 为什么要有这一层：限速与配额问的是两件不同的事（"这个来源试得太频"
 *   vs "这个账号建得太多了"），但**边界的算法完全相同** —— `>` 还是 `>=`、
 *   `Retry-After` 取最早那条、`max <= 0` 是关掉还是全禁。
 *
 *   把这些抄成两份，会让它们**各自**演化：某天有人在其中一个里把 `>` 改成 `>=`
 *   （修一个看起来像 bug 的现象），另一个不动 —— 于是同一个产品里两个闸门
 *   对"边界那一毫秒"给出不同答案，而没有一个判据会发现。
 *
 *   > 一份抄成两份的边界规则，与一份只有一处的规则，
 *   > 在没人改过它们的时候是同一个东西。
 *
 * @param {{count: number, oldestMs: number|null, atMs: number, max: number, windowMs: number}} input
 */
function decide({ count, oldestMs, atMs, max, windowMs }) {
  const used = Number.isFinite(count) ? count : 0
  // `max <= 0` = **关掉闸门**。与注册闸门同一语义：明确写出来才算，
  // 不给"忘了配"留一条静默放行的路（虽然这个方向的默认是"放行"，但它是**显式**的）。
  if (!Number.isFinite(max) || max <= 0) {
    return { allowed: true, count: used, max, retryAfterMs: 0, retryAfterSec: 0, disabled: true }
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { allowed: true, count: used, max, retryAfterMs: 0, retryAfterSec: 0, disabled: true }
  }
  if (used < max) {
    return { allowed: true, count: used, max, retryAfterMs: 0, retryAfterSec: 0, disabled: false }
  }
  // 还要等多久：**最早那条**过期就行。回"整个窗口"会把用户多关一段时间。
  // `oldestMs` 缺失时不假装知道 —— 回一整个窗口（唯一能给出的保守答案）。
  const retryAfterMs = Number.isFinite(oldestMs)
    ? Math.max(0, oldestMs + windowMs - atMs)
    : windowMs
  return {
    allowed: false, count: used, max,
    retryAfterMs,
    retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    disabled: false,
  }
}

/**
 * 算出现在允不允许（**短窗口尝试**：登录/注册/口令重置）。
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
  // ★ 边界用 `>`：`at - windowMs` 那一**瞬间**不算在窗口内。
  //   用 `>=` 的话，正好落在边界上的那条会被永久计入（因为时间一直在走），
  //   于是窗口"粘住"一条记录，配额少一次且永远不会恢复。
  const inWindow = list.filter((t) => t > atMs - windowMs)
  return decide({
    count: inWindow.length,
    oldestMs: inWindow.length > 0 ? Math.min(...inWindow) : null,
    atMs, max, windowMs,
  })
}

/**
 * 算出现在允不允许（**长窗口配额**：一个账号一小时能建多少资源）。
 *
 * 与 `limitDecision` 的差别只在**输入形状**：存储层用一条 `COUNT(*) + MIN(at_ms)`
 * 就能给出 `count` 与 `oldestMs`，不必把窗口内的几百行都取回来。
 *
 * @param {{count?: number, oldestMs?: number|null, atMs: number, max: number, windowMs: number}} input
 */
export function quotaDecision({ count = 0, oldestMs = null, atMs, max, windowMs } = {}) {
  return decide({ count, oldestMs, atMs, max, windowMs })
}

/**
 * 每种资源的配额**定义**（窗口、默认上限、给用户看的说法）。
 *
 * 放在这里而不是散在路由里：`/api/identity/rate-limits` 要把它们如实报出来，
 * 而"报出来的上限"与"实际生效的上限"必须是同一个数 —— 两份必然会漂。
 */
export const QUOTA_RESOURCES = Object.freeze({
  // 一条消息 = 一行 `messages`。最大的那张表，也是手机上最常用的写操作。
  message: Object.freeze({
    unit: '条消息',
    defaultMax: 300,
    defaultWindowMs: 60 * 60 * 1000,
  }),
})

/** 配额被触发时的错误码。与来源限速**分开**：前端与运维要采取的动作不同。 */
export const QUOTA_CODE = 'ACCOUNT_QUOTA_EXCEEDED'

/**
 * 启动期自检：生效上限表与资源定义表的**键必须完全一致**。
 *
 * ★ 守的是一个**静默**的失败。调用方（`server.mjs`）用资源名同时查两张表：
 *
 *     const spec = QUOTA_RESOURCES[resource]   // undefined → return（放行）
 *     const max  = QUOTA_LIMITS[resource]      // undefined → decide 判成"关掉"
 *
 *   键写错（改名、拼错、只改了一边）时**两条路都通向"不限"**，而且没有任何日志、
 *   没有任何报错。配额看起来接好了，实际上一次都没生效过。
 *
 *   > 一个"配了但键对不上"的配额，与一个"根本没配"的配额，
 *   > 在运行期是同一个东西 —— 除了前者让人觉得已经防住了。
 *
 *   所以把它变成启动时一次**响亮的拒绝**，而不是运行期一个安静的放行。
 *   （放在这里而不是 `server.mjs` 里，是为了它能被一个用例直接钉住 ——
 *     一个只在启动时执行、又不可测的断言，等于没有断言。）
 *
 * @param {{limits: object, resources: object}} input
 * @returns {true} 一致时返回 true
 * @throws {Error} 不一致时抛出，消息里点名差在哪
 */
export function checkQuotaLimitsMatch({ limits = {}, resources = {} } = {}) {
  const missing = Object.keys(resources).filter((k) => !Object.prototype.hasOwnProperty.call(limits, k))
  const extra = Object.keys(limits).filter((k) => !Object.prototype.hasOwnProperty.call(resources, k))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      'QUOTA_LIMITS 与 QUOTA_RESOURCES 的键不一致 —— '
      + `resources 里有而 limits 里没有：${JSON.stringify(missing)}；`
      + `limits 里有而 resources 里没有：${JSON.stringify(extra)}`,
    )
  }
  return true
}

/**
 * 配额被触发时给用户看的一句话。
 *
 * ★ 与 `limitMessage` 的**关键差别**：限速那条要说"不是账号被封、换网络就好了"，
 *   因为受限的是**来源**（可能是整间办公室）。配额这条恰恰相反 ——
 *   受限的是**他自己的账号**，换网络没有用，等窗口过去或者请管理员调高上限才有用。
 *
 *   把两者写成同一句话是最省事的做法，而它会让用户**按错误的方向**自救：
 *   换网络、换设备、反复重试 —— 全都不会好。
 *
 * ★ 也不许把上限说得像惩罚：这是**容量保护**，不是封禁。用户看到"你发了太多"
 *   应当能算出自己什么时候能继续，而不是以为账号被标记了。
 */
export function quotaMessage({ resource = 'message', max, windowSec, retryAfterSec } = {}) {
  const unit = QUOTA_RESOURCES[resource]?.unit ?? '条记录'
  const mins = Math.max(1, Math.ceil((Number(retryAfterSec) || 0) / 60))
  const windowMins = Math.max(1, Math.round((Number(windowSec) || 0) / 60))
  return `你在最近 ${windowMins} 分钟内创建的${unit}已达上限（${max}）。`
    + `请约 ${mins} 分钟后继续。`
    + '（这是**容量保护**，不是账号被封；Agent 自己的汇报不受此限制。）'
}

/** 具名错误码：前端按**类型**分支，不按文案匹配。 */
export const RATE_LIMIT_CODE = 'IDENTITY_RATE_LIMITED'

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
