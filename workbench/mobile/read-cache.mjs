// workbench/mobile/read-cache.mjs
// ============================================================================
// 离线**读**的缓存决策（"上次看到的那些东西"）。
//
// ## 为什么它不能交给 Service Worker
//
// `sw.js` 里有一条明确的规则：`/api/` 一律**不缓存**。那条规则是对的 ——
// API 响应是**认证过的、与具体用户相关的**，进一个按 URL 索引的共享缓存
// 意味着"换个人登录，拿到的可能是上一个人的响应"。
//
// 所以离线读只能在**应用层**做：应用知道自己是谁、当前是哪个空间、哪个会话，
// 而 SW 不知道（它只看得到 URL）。
//
//   > 一份"按 URL 缓存认证响应"的离线读，
//   > 与一份"把上一个人的消息显示给下一个人"的离线读，是同一份东西。
//
// ## ★★ 三种东西的过期规矩**不一样**（本模块最要紧的判断）
//
// `messages`（对话正文）与 `board`（任务状态）看起来都是"数据"，但它们的
// 失效方式不同：
//
//   · **消息是文本。** 一条三天前的消息，三天后还是那句话 —— 它**不会变错**，
//     只会变旧。所以永远可以显示，只要标出"这是几小时前的"。
//
//   · **任务状态是状态。** 一条三天前显示「进行中」的任务，今天可能早已完成、
//     被取消、或者卡住了。**它会变错**，而且错得危险：用户会照着它去催、
//     去验收、去判断"电脑是不是没在干活"。
//
//   > 显示一句三小时前的话，只是晚了一点；
//   > 显示一个三天前的任务状态，是让用户**照着一个不存在的世界行动**。
//
// 所以两者用**不同的**上限：消息留很久（7 天），看板只留很短（1 小时），
// 过了就直接当作没有 —— 一个过期的看板比一个空的看板更坏。
//
// ## ★★ 缓存键必须含用户身份
//
// 这是本模块唯一的**安全**判断。浏览器是共享设备（家人、同事、借用一下），
// 而缓存落在 `localStorage` 里、**登出不会自动清**（除非我们明确清）。
//
//   > 一个"按空间+会话缓存"的离线读，
//   > 与一个"把上一个人的对话显示给下一个人"的离线读，是同一个东西 ——
//   > 只不过前者在换人登录之前看起来完全正常。
//
// 所以每个键前面都带 `userId`，而登出时**主动清掉整份读缓存**
// （见 `shouldClearReadCacheOnLogout`：这与待发队列的处理**故意相反**）。
// ============================================================================

/** 消息保留多久。文本只会变旧，不会变错 —— 可以留得久。 */
export const MESSAGES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** 看板保留多久。**状态会变错**，所以窗口很短。 */
export const BOARD_MAX_AGE_MS = 60 * 60 * 1000

/** 超过这个年龄就标"数据可能已过时"（不是丢弃，只是如实说）。 */
export const MARK_STALE_AFTER_MS = 5 * 60 * 1000

/**
 * 每个会话最多留多少条消息。
 *
 * 与后端的 `limit=200` 对齐：缓存比一次请求拿到的还多没有意义，
 * 而 `localStorage` 通常只有约 5MB —— 聊天正文可能很长
 * （服务端上限 8000 字符），200 条极端情况接近 1.6MB。
 */
export const MESSAGES_MAX_ENTRIES = 200

/** 整份读缓存的字节上限。超了就按"最旧的先丢"裁剪。 */
export const CACHE_MAX_BYTES = 3 * 1024 * 1024

export const READ_CACHE_CODES = Object.freeze({
  NO_USER: 'NO_USER',
  NO_SCOPE: 'NO_SCOPE',
  EXPIRED: 'EXPIRED',
  EMPTY: 'EMPTY',
})

/**
 * 造缓存键。**必须**含 userId —— 见文件头那段安全判断。
 *
 * ★ 参数用**默认值**而不是解析式（`= {}` 而不是解构 `{...} = {}`）：
 *   解构 `null` 会抛 `TypeError`，而调用方传 `null` 的场合是真实存在的
 *   （"还没解析出当前用户"）。这条判据把那个 bug 抓出来过一次。
 *
 * @returns {string|null} 缺任何一段都返回 null（**不**退化成"少一段的键"）
 */
export function cacheKey(input = {}) {
  if (input === null || typeof input !== 'object') return null
  const { userId, scope, kind, convId = null } = input
  if (typeof userId !== 'string' || userId.length === 0) return null
  if (typeof scope !== 'string' || scope.length === 0) return null
  if (kind !== 'messages' && kind !== 'board') return null
  // ★ 缺 userId 时**返回 null 而不是拼一个少一段的键**：
  //   一个"忘了带用户"的键会与**所有人**共用同一条缓存，
  //   而那正是这段设计要防的那件事。
  const base = `${userId}::${scope}::${kind}`
  if (kind === 'messages') {
    if (!Number.isFinite(Number(convId)) || Number(convId) <= 0) return null
    return `${base}::${Number(convId)}`
  }
  return base
}

/**
 * 一份缓存能不能用、以及该怎么说。
 *
 * @returns {{usable: boolean, ageMs: number, stale: boolean, code: string|null}}
 *          `stale` = 可以用，但**必须**标出来
 */
export function usability(input = {}) {
  // 同 `cacheKey`：参数可能来自 localStorage 里的畸形值，解构 `null` 会抛。
  const { savedAtMs, nowMs, kind } = (input === null || typeof input !== 'object') ? {} : input
  const maxAge = kind === 'board' ? BOARD_MAX_AGE_MS : MESSAGES_MAX_AGE_MS
  const at = Number(savedAtMs)
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  if (!Number.isFinite(at) || at <= 0) return { usable: false, ageMs: 0, stale: false, code: READ_CACHE_CODES.EMPTY }
  const ageMs = Math.max(0, now - at)
  if (ageMs > maxAge) {
    return { usable: false, ageMs, stale: true, code: READ_CACHE_CODES.EXPIRED }
  }
  return { usable: true, ageMs, stale: ageMs >= MARK_STALE_AFTER_MS, code: null }
}

/**
 * 写一份缓存（**有界**）。
 *
 * @returns {{entry: object, dropped: number}} `dropped` = 因为条数上限丢掉的条数
 */
export function packPayload(input = {}) {
  const { kind, payload, savedAtMs, maxEntries = MESSAGES_MAX_ENTRIES } = (input === null || typeof input !== 'object') ? {} : input
  const at = Number(savedAtMs)
  const savedAt = Number.isFinite(at) ? at : Date.now()
  // ★ 判据是 `kind === 'board'` 而**不是** `kind === 'messages'`。
  //
  //   两个写法在"给了消息"时一样、在"给了 board"时一样 —— 差别只在**没给 kind**
  //   的时候：写成 `=== 'messages'` 会让"没给 kind"静默掉进**看板**那一支，
  //   于是返回一个 `{payload}` 形状的条目，而调用方按消息去读 `entry.entries`
  //   会拿到 `undefined`。
  //
  //   `usability` 那边的判据是 `kind === 'board' ? BOARD : MESSAGES` ——
  //   也就是说它把"没给 kind"当**消息**。两处对同一种输入的理解必须一致，
  //   否则同一次调用会在两个函数里被当成两种东西。
  //
  //   > 一个"没给参数就悄悄选了另一支"的默认，与一个"没给参数就报错"的默认，
  //   > 只在**有人没给参数**的时候不同 —— 而那正是它被写出来的原因。
  if (kind !== 'board') {
    const list = Array.isArray(payload) ? payload : []
    // ★ 留**最新的** N 条（末尾优先）：用户离线时最需要看到的是最近的对话，
    //   而不是三小时前的开头。丢掉的条数如实返回，界面可以说明"更早的没缓存"。
    const kept = list.length > maxEntries ? list.slice(list.length - maxEntries) : list
    return { entry: { kind: 'messages', savedAtMs: savedAt, entries: kept }, dropped: list.length - kept.length }
  }
  return { entry: { kind: 'board', savedAtMs: savedAt, payload: payload ?? null }, dropped: 0 }
}

/** 读出条目里的负载（并用 `usability` 判过之后再调）。 */
export function unpackPayload(entry, kind) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return null
  // 与 `packPayload` / `usability` 同一个判据方向：只有 `'board'` 是看板。
  if (kind === 'board') return entry.payload ?? null
  return Array.isArray(entry.entries) ? entry.entries : null
}

/**
 * **登出时要不要清读缓存**：要。这是一个与待发队列**故意相反**的决定。
 *
 * | | 登出时 | 为什么 |
 * |---|---|---|
 * | 待发队列 | **不清** | 那是用户**自己打的、还没发出去的字**。清掉 = 静默删掉他的话 |
 * | 读缓存 | **清** | 那是**服务端的数据**。留着 = 下一个人在共享设备上看到上一个人的对话 |
 *
 * 两个方向的代价不对等：
 *   · 队列留着，最坏是"换账号后看到几条发不出去的消息，自己删掉"（可见、可修）
 *   · 缓存留着，最坏是**把别人的对话显示给不该看的人**（不可见、不可撤销）
 *
 * 第二个是安全问题，第一个只是体验问题 —— 所以两条规矩相反。
 */
export function shouldClearReadCacheOnLogout() {
  return true
}

/**
 * 给界面用的说法（**键 + 变量，不拼句子** —— 拼出来的句子永远查不到英文）。
 *
 * ★ 两层键。外层是"离线 · 这是 {ago} 的消息"，`ago` 本身又是一句
 *   （"{hours} 小时前"）。调用方 `t(textKey, { ago: t(agoKey, agoVars) })`。
 *   两层都是**字面量**，所以 i18n 覆盖率判据两层都看得见。
 *
 *   为什么不直接把时间拼进去：`'离线 · 这是 3 小时前的消息'` 里带一个数字，
 *   每一句都是新的 —— 那种句子永远不可能在英文表里查到。
 *   （上一轮在 `outboxBanner` 上正是这么栽过一次。）
 *
 * @returns {{tone: string, textKey: string, agoKey: string, agoVars: object, detailKey: string}}
 *          `null` = 正在显示实时数据，什么都不用说
 */
export function offlineNotice(input = {}) {
  const { kind, ageMs, nowMs } = (input === null || typeof input !== 'object') ? {} : input
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const age = Number.isFinite(Number(ageMs)) ? Number(ageMs) : 0
  const isBoard = kind === 'board'
  const mins = Math.max(1, Math.round(age / 60000))
  const hours = Math.max(1, Math.round(age / 3600000))
  const days = Math.max(1, Math.round(age / 86400000))
  // ★ 人类读的是"多久以前"，而**不是**一个时间戳：离线时判断
  //   "这些还能不能信"靠的是"多久以前"，不是"哪一刻"。
  const agoKey = age < 3600000 ? '{mins} 分钟前' : age < 86400000 ? '{hours} 小时前' : '{days} 天前'
  const agoVars = age < 3600000 ? { mins: String(mins) } : age < 86400000 ? { hours: String(hours) } : { days: String(days) }
  return {
    tone: isBoard ? 'error' : 'warn',
    textKey: isBoard ? '离线 · 看板是 {ago} 的' : '离线 · 这是 {ago} 的消息',
    agoKey,
    agoVars,
    detailKey: isBoard
      ? '任务状态会变，照着过期的看板做决定可能做错。连上网络再确认一次。'
      : '这是上次连上时看到的对话，可以读，但不能当作现在的状态。',
  }
}

/**
 * 把整份读缓存裁剪到字节上限之内（**最旧的先丢**）。
 *
 * ★ 为什么会超：`localStorage` 通常只有约 5MB，而消息正文可能很长。
 *   满了之后 `setItem` 会**抛**（QuotaExceededError），于是**新的缓存一条都写不进去**
 *   —— 而现象是"离线读忽然什么都没有了"，看起来像功能坏了。
 *
 * @param {Array<{key: string, entry: object, bytes: number}>} items
 * @returns {{keep: Array, drop: Array, totalBytes: number}}
 */
export function trimToBudget(items, { maxBytes = CACHE_MAX_BYTES } = {}) {
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x.key === 'string') : []
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : CACHE_MAX_BYTES
  // 新的优先（保留顺序 = 调用方给的顺序，调用方按 savedAtMs 倒序排）。
  const keep = []
  const drop = []
  let total = 0
  for (const item of list) {
    const bytes = Number.isFinite(Number(item.bytes)) ? Number(item.bytes) : 0
    if (total + bytes <= cap) { keep.push(item); total += bytes } else { drop.push(item) }
  }
  return { keep, drop, totalBytes: total }
}
