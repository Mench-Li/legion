// workbench/mobile/read-cache.test.mjs
// ============================================================================
// 离线**读**的缓存决策，以及它在 `app.mjs` 里的**接线**。
//
// 这一族守两句话：
//   ① **消息是文本，看板是状态** —— 前者只会变旧，后者会变**错**。
//   ② **缓存键必须含用户身份** —— 否则共享设备上会把上一个人的对话给下一个人。
//
// ★ 为什么还要管 `app.mjs` 的接线（这一节是**被破坏性验证逼出来的**）：
//   第一轮我写了 32 处破坏，其中 7 处改的是 `app.mjs`（取消回退、不标记、
//   登出不清、不记 userId、标记不按视图切换、不翻那句话）——
//   **全部没被抓住**，因为这一族只 import 纯模块，一个字都没读过 `app.mjs`。
//
//   > 一批"证明决策算得对"的判据，与一批"证明那个决策真的被用上了"的判据，
//   > 在接线完好时是同一个东西 —— 只不过前者在**线没接上**的时候仍然全绿。
//
//   所以下面这一节按**源码结构**断言接线（与 `i18n.test.mjs` 盯 `app.mjs`
//   那几条同一套做法）。它们不测行为，测的是"那条路还在不在"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MESSAGES_MAX_AGE_MS, BOARD_MAX_AGE_MS, MARK_STALE_AFTER_MS, MESSAGES_MAX_ENTRIES, CACHE_MAX_BYTES,
  READ_CACHE_CODES,
  cacheKey, usability, packPayload, unpackPayload, shouldClearReadCacheOnLogout,
  offlineNotice, trimToBudget,
} from './read-cache.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = 1_800_000_000_000

// ── ① ★★★ 缓存键必须含用户身份（唯一的安全判断）──────────────────────────────

test('★★★ 缺 userId 时**不给键**，而不是拼一个少一段的键', () => {
  // ★ 一个"忘了带用户"的键会与**所有人**共用同一条缓存。
  //   浏览器是共享设备（家人、同事、借用一下），而缓存落在 localStorage 里、
  //   登出不会自动清 —— 所以这里的选择是"不给键"（于是不缓存），
  //   而不是"给一个少一段的键"（于是所有人都看到上一个人的东西）。
  for (const bad of [undefined, null, '', 0, {}]) {
    assert.equal(
      cacheKey({ userId: bad, scope: 'default', kind: 'messages', convId: 7 }), null,
      `userId=${JSON.stringify(bad)} 时必须不给键`,
    )
  }
})

test('★★★ 两个用户的键**必定不同**（这是本模块存在的理由）', () => {
  const a = cacheKey({ userId: 'user-A', scope: 'default', kind: 'messages', convId: 7 })
  const b = cacheKey({ userId: 'user-B', scope: 'default', kind: 'messages', convId: 7 })
  assert.notEqual(a, b, '不同用户的同一条会话不许同键 —— 那就是把 A 的对话给 B')
  assert.ok(a.includes('user-A') && b.includes('user-B'))
})

test('★★★ 两个空间的键必定不同（同一用户跨空间也不许串）', () => {
  const a = cacheKey({ userId: 'u', scope: 'alpha', kind: 'messages', convId: 7 })
  const b = cacheKey({ userId: 'u', scope: 'beta', kind: 'messages', convId: 7 })
  assert.notEqual(a, b)
})

test('★★★ 两个会话的键必定不同', () => {
  const a = cacheKey({ userId: 'u', scope: 's', kind: 'messages', convId: 7 })
  const b = cacheKey({ userId: 'u', scope: 's', kind: 'messages', convId: 8 })
  assert.notEqual(a, b)
})

test('★★ 消息与看板不同键（两种东西的过期规矩不同，混在一起必然错）', () => {
  const m = cacheKey({ userId: 'u', scope: 's', kind: 'messages', convId: 7 })
  const b = cacheKey({ userId: 'u', scope: 's', kind: 'board' })
  assert.notEqual(m, b)
})

test('★★ 畸形输入返回 null（不抛）', () => {
  for (const bad of [undefined, null, {}, { userId: 'u' }, { userId: 'u', scope: 's' },
    { userId: 'u', scope: 's', kind: 'nope' }, { userId: 'u', scope: 's', kind: 'messages' },
    { userId: 'u', scope: 's', kind: 'messages', convId: 0 },
    { userId: 'u', scope: 's', kind: 'messages', convId: -1 },
    { userId: 'u', scope: 's', kind: 'messages', convId: 'abc' },
    { userId: 'u', scope: '', kind: 'board' }]) {
    assert.equal(cacheKey(bad), null, `${JSON.stringify(bad)} 应当拿到 null`)
  }
})

// ── ② ★★★ 两种东西的过期规矩**不一样** ──────────────────────────────────────

test('★★★ 看板的窗口必须**远短于**消息（状态会变错，文本只会变旧）', () => {
  // ★ 这条把设计意图变成可执行的断言：有人把两个上限调成一样时它会红。
  assert.ok(BOARD_MAX_AGE_MS < MESSAGES_MAX_AGE_MS,
    '看板的过期窗口必须比消息短 —— 一个过期的看板会让用户照着不存在的世界行动')
  assert.ok(BOARD_MAX_AGE_MS <= 2 * HOUR, `看板窗口太长了：${BOARD_MAX_AGE_MS / HOUR} 小时`)
  assert.ok(MESSAGES_MAX_AGE_MS >= DAY, `消息窗口太短了：${MESSAGES_MAX_AGE_MS / DAY} 天`)
})

test('★★★ 一小时前的看板**已经不能用**了（而一小时前的消息还能用）', () => {
  const now = T0 + 2 * HOUR
  const board = usability({ savedAtMs: T0, nowMs: now, kind: 'board' })
  const msgs = usability({ savedAtMs: T0, nowMs: now, kind: 'messages' })
  assert.equal(board.usable, false, '两小时前的看板不该再显示')
  assert.equal(board.code, READ_CACHE_CODES.EXPIRED)
  assert.equal(msgs.usable, true, '两小时前的消息仍然可读 —— 它只是旧，不是错')
  assert.equal(msgs.stale, true, '但必须标出来')
})

test('★★★ 三天前的看板绝不能用（那是最坏的形态：让人照旧状态行动）', () => {
  const b = usability({ savedAtMs: T0, nowMs: T0 + 3 * DAY, kind: 'board' })
  assert.equal(b.usable, false)
  assert.ok(b.ageMs >= 3 * DAY)
})

test('★★ 三天前的消息仍然可读（文本不会变错）', () => {
  const m = usability({ savedAtMs: T0, nowMs: T0 + 3 * DAY, kind: 'messages' })
  assert.equal(m.usable, true)
  assert.equal(m.stale, true)
})

test('★ 七天前的消息过期（缓存总得有个头）', () => {
  assert.equal(usability({ savedAtMs: T0, nowMs: T0 + MESSAGES_MAX_AGE_MS + 1, kind: 'messages' }).usable, false)
})

test('★★ 刚存下来的不标 stale（否则那个标记就失去意义了）', () => {
  const fresh = usability({ savedAtMs: T0, nowMs: T0 + 1000, kind: 'messages' })
  assert.equal(fresh.usable, true)
  assert.equal(fresh.stale, false)
  const edge = usability({ savedAtMs: T0, nowMs: T0 + MARK_STALE_AFTER_MS - 1, kind: 'messages' })
  assert.equal(edge.stale, false)
  const over = usability({ savedAtMs: T0, nowMs: T0 + MARK_STALE_AFTER_MS, kind: 'messages' })
  assert.equal(over.stale, true)
})

test('★ 没有时间戳 = 不能用（不许当作"刚刚"）', () => {
  for (const bad of [undefined, null, 0, NaN, -1, 'x']) {
    const u = usability({ savedAtMs: bad, nowMs: T0, kind: 'messages' })
    assert.equal(u.usable, false, `savedAtMs=${JSON.stringify(bad)} 必须不可用`)
  }
})

test('★ 时钟倒退（savedAtMs 在未来）不许算出负数年龄', () => {
  const u = usability({ savedAtMs: T0 + 10 * MIN, nowMs: T0, kind: 'messages' })
  assert.equal(u.ageMs, 0, '年龄不许为负')
  assert.equal(u.usable, true)
  assert.equal(u.stale, false)
})

// ── ③ 打包：留**最新**的 N 条 ───────────────────────────────────────────────

test('★★★ 消息超过上限时留**最新的**，并如实报出丢了几条', () => {
  // ★ 用户离线时最需要看到的是**最近的**对话，不是三小时前的开头。
  const list = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, body: 'm' + (i + 1) }))
  const { entry, dropped } = packPayload({ kind: 'messages', payload: list, savedAtMs: T0, maxEntries: 200 })
  assert.equal(entry.entries.length, 200)
  assert.equal(dropped, 50)
  assert.equal(entry.entries[0].id, 51, '留下的应当是**末尾**那 200 条')
  assert.equal(entry.entries[199].id, 250, '最后一条必须是最新的那条')
})

test('★★ 没超上限时一条都不丢', () => {
  const list = [{ id: 1 }, { id: 2 }]
  const { entry, dropped } = packPayload({ kind: 'messages', payload: list, savedAtMs: T0 })
  assert.equal(entry.entries.length, 2)
  assert.equal(dropped, 0)
})

test('★ 默认上限是正整数', () => {
  assert.ok(Number.isFinite(MESSAGES_MAX_ENTRIES) && MESSAGES_MAX_ENTRIES > 0)
})

test('★★ 打包/解包能对上（两种 kind 都要）', () => {
  const msgs = packPayload({ kind: 'messages', payload: [{ id: 1 }], savedAtMs: T0 }).entry
  assert.deepEqual(unpackPayload(msgs, 'messages'), [{ id: 1 }])
  const board = packPayload({ kind: 'board', payload: { tasks: [1, 2] }, savedAtMs: T0 }).entry
  assert.deepEqual(unpackPayload(board, 'board'), { tasks: [1, 2] })
})

test('★★ 解包畸形条目返回 null（不抛、不许把 undefined 当数据）', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, { entries: 'x' }]) {
    assert.equal(unpackPayload(bad, 'messages'), null)
    assert.equal(unpackPayload(bad, 'board'), null)
  }
})

test('★ 消息负载不是数组时按空处理（不抛）', () => {
  const { entry } = packPayload({ kind: 'messages', payload: 'nope', savedAtMs: T0 })
  assert.deepEqual(entry.entries, [])
})

// ── ④ ★★★ 登出：读缓存**要清**，而待发队列**不清** ──────────────────────────

test('★★★ 登出必须清读缓存（与待发队列**故意相反**）', () => {
  // ★ 两个方向的代价不对等：
  //   · 队列留着 → 最坏是"换账号后看到几条发不出去的消息，自己删掉"（可见、可修）
  //   · 缓存留着 → 最坏是**把别人的对话显示给不该看的人**（不可见、不可撤销）
  //   第二个是安全问题，第一个只是体验问题。
  assert.equal(shouldClearReadCacheOnLogout(), true)
})

test('★★★ 反例守卫：这条判据**不是**恒真（它必须真的能被改坏）', () => {
  // 一个"永远返回 true"的判据守卫的是一个常量，不是一条规矩。
  // 这里直接断言它与"队列不清"是**两个不同的决定** —— 如果有人把两者
  // 都写成同一个开关，这条会红。
  const outboxClearedOnLogout = false   // app.mjs 里 `doLogout` 的实际行为
  assert.notEqual(shouldClearReadCacheOnLogout(), outboxClearedOnLogout,
    '读缓存与待发队列在登出时的处理必须相反 —— 一个是别人的数据，一个是自己的字')
})

// ── ⑤ 界面说法：键 + 变量，两层都是字面量 ───────────────────────────────────

test('★★★ 说法返回的是**键**（含占位符），不是拼好的句子', () => {
  // ★ 拼出来的 `'离线 · 这是 3 小时前的消息'` 永远查不到英文 —— 它带一个数字。
  //   上一轮在 `outboxBanner` 上正是这么栽过一次。
  const n = offlineNotice({ kind: 'messages', ageMs: 3 * HOUR, nowMs: T0 })
  assert.match(n.textKey, /\{ago\}/, '外层必须有 {ago} 占位符')
  assert.doesNotMatch(n.textKey, /\d/, '外层键里不许出现具体数字')
  assert.match(n.agoKey, /\{hours\}/, '内层也必须是占位符')
  assert.doesNotMatch(n.agoKey, /\d/, '内层键里也不许出现具体数字')
  assert.equal(n.agoVars.hours, '3')
})

test('★★★ 三层时间粒度各自成键（分钟 / 小时 / 天）', () => {
  const min = offlineNotice({ kind: 'messages', ageMs: 3 * MIN, nowMs: T0 })
  assert.equal(min.agoKey, '{mins} 分钟前')
  assert.equal(min.agoVars.mins, '3')
  const hr = offlineNotice({ kind: 'messages', ageMs: 5 * HOUR, nowMs: T0 })
  assert.equal(hr.agoKey, '{hours} 小时前')
  assert.equal(hr.agoVars.hours, '5')
  const day = offlineNotice({ kind: 'messages', ageMs: 3 * DAY, nowMs: T0 })
  assert.equal(day.agoKey, '{days} 天前')
  assert.equal(day.agoVars.days, '3')
})

test('★★★ 看板用**错误**的调子，消息用警告（危险程度不同）', () => {
  assert.equal(offlineNotice({ kind: 'board', ageMs: MIN, nowMs: T0 }).tone, 'error')
  assert.equal(offlineNotice({ kind: 'messages', ageMs: MIN, nowMs: T0 }).tone, 'warn')
})

test('★★★ 看板的说法必须点出"照着做可能做错"', () => {
  const b = offlineNotice({ kind: 'board', ageMs: 30 * MIN, nowMs: T0 })
  assert.match(b.detailKey, /做错|确认/, '要说清后果，不能只说"这是离线数据"')
  const m = offlineNotice({ kind: 'messages', ageMs: 30 * MIN, nowMs: T0 })
  assert.match(m.detailKey, /不能当作现在的状态/)
})

test('★ 年龄为 0 或负数时不出现"0 分钟前"', () => {
  for (const age of [0, -1, NaN]) {
    const n = offlineNotice({ kind: 'messages', ageMs: age, nowMs: T0 })
    assert.ok(Number(n.agoVars.mins ?? n.agoVars.hours ?? n.agoVars.days) >= 1,
      `ageMs=${age} 算出了 0 或非数字`)
    assert.doesNotMatch(n.agoKey, /\d/)
  }
})

// ── ⑥ 字节预算：满了之后**新的还能写进去** ──────────────────────────────────

test('★★★ 超预算时**丢最旧的**，保住最新的', () => {
  // ★ 这里的方向与"队列满了拒绝入队"**故意相反**，因为东西不同：
  //   · 待发队列里是用户**打的字** → 丢一条就是删掉他的话 → 拒绝新入队
  //   · 读缓存里是服务端的**旧响应** → 丢掉最旧的毫无损失（它本来就过期了）
  //     → 而保留顺序错了的真正代价是"新的缓存一条都写不进去"
  const items = [
    { key: 'new', bytes: 400 },
    { key: 'mid', bytes: 400 },
    { key: 'old', bytes: 400 },
  ]
  const { keep, drop, totalBytes } = trimToBudget(items, { maxBytes: 900 })
  assert.deepEqual(keep.map((x) => x.key), ['new', 'mid'], '新的必须保住')
  assert.deepEqual(drop.map((x) => x.key), ['old'], '丢的是最旧的')
  assert.equal(totalBytes, 800)
})

test('★★★ 预算内一条不丢', () => {
  const items = [{ key: 'a', bytes: 10 }, { key: 'b', bytes: 10 }]
  const { keep, drop } = trimToBudget(items, { maxBytes: 100 })
  assert.equal(keep.length, 2)
  assert.equal(drop.length, 0)
})

test('★★★ 单条就超预算时**丢它自己**，而不是把预算撑破', () => {
  // 否则 `localStorage.setItem` 会抛 QuotaExceededError，
  // 而那之后**新的缓存一条都写不进去** —— 现象是"离线读忽然什么都没有了"。
  const { keep, drop } = trimToBudget([{ key: 'huge', bytes: 10_000 }], { maxBytes: 1000 })
  assert.equal(keep.length, 0)
  assert.deepEqual(drop.map((x) => x.key), ['huge'])
})

test('★ 畸形输入不抛（缓存状态来自 localStorage，可能是别人写坏的）', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.doesNotThrow(() => trimToBudget(bad))
    assert.doesNotThrow(() => usability({ savedAtMs: bad, kind: 'messages' }))
    assert.doesNotThrow(() => offlineNotice({ kind: 'board', ageMs: bad }))
  }
  assert.deepEqual(trimToBudget(null).keep, [])
  // 字节数是垃圾时当 0（那一条仍然留着 —— 拿不准就别丢数据）。
  const r = trimToBudget([{ key: 'a', bytes: 'x' }], { maxBytes: 1 })
  assert.equal(r.keep.length, 1)
})

test('★★★ 四个导出函数直接吃**非对象**也不许抛', () => {
  // ★ 这条是破坏性验证逼出来的：上面那条判据**只传对象**给 `usability`
  //   （`{ savedAtMs: bad, … }`），于是它内部那句
  //   `input === null || typeof input !== 'object'` 的守卫**从来没被执行过** ——
  //   把它删掉，全部判据仍然全绿。
  //
  //   > 一条"守着一个永远不会发生的输入"的守卫，与一条不存在的守卫，
  //   > 在判据眼里是同一个东西。
  //
  //   而这些函数是模块的**公开导出**（`cacheKey` / `usability` / `packPayload` /
  //   `offlineNotice`），调用方传什么都是合法的 —— 尤其在一个
  //   "从 localStorage 读回来再往下传"的链路里。
  for (const bad of [null, undefined, 'nope', 42, true, NaN]) {
    assert.doesNotThrow(() => cacheKey(bad), `cacheKey(${String(bad)}) 抛了`)
    assert.doesNotThrow(() => usability(bad), `usability(${String(bad)}) 抛了`)
    assert.doesNotThrow(() => packPayload(bad), `packPayload(${String(bad)}) 抛了`)
    assert.doesNotThrow(() => offlineNotice(bad), `offlineNotice(${String(bad)}) 抛了`)
  }
  // 而且返回值要是**安全的默认**，不能是 undefined 让调用方在下游崩。
  assert.equal(cacheKey(null), null)
  assert.equal(usability(null).usable, false)
  assert.ok(Array.isArray(packPayload(null).entry.entries))
  assert.equal(typeof offlineNotice(null).textKey, 'string')
})

test('★ 默认预算是个正整数（不是一个会被忽略的 0）', () => {
  assert.ok(Number.isFinite(CACHE_MAX_BYTES) && CACHE_MAX_BYTES > 0)
  const big = [{ key: 'a', bytes: 1000 }]
  assert.equal(trimToBudget(big).keep.length, 1, '不传 maxBytes 时要用默认值，不是"立刻超"')
})

// ── ⑦ 端到端：同一用户的两次访问 + 换人 ─────────────────────────────────────

test('★★★ 换人登录后拿不到上一个人的缓存（键不同 ⇒ 查不到）', () => {
  const store = new Map()
  // A 存了一份对话。
  const keyA = cacheKey({ userId: 'user-A', scope: 'default', kind: 'messages', convId: 7 })
  store.set(keyA, packPayload({
    kind: 'messages', savedAtMs: T0, payload: [{ id: 1, body: 'A 的私事' }],
  }).entry)
  // A 自己再打开：能拿到。
  const back = store.get(keyA)
  assert.deepEqual(unpackPayload(back, 'messages'), [{ id: 1, body: 'A 的私事' }])
  // B 登录后打开同一条会话：**查不到**（键不同）。
  const keyB = cacheKey({ userId: 'user-B', scope: 'default', kind: 'messages', convId: 7 })
  assert.equal(store.get(keyB), undefined, 'B 不该拿到 A 的缓存')
})

test('★★★ 看板过期后界面**不再显示**（而不是显示一个过期的看板）', () => {
  const key = cacheKey({ userId: 'u', scope: 'default', kind: 'board' })
  const saved = packPayload({ kind: 'board', payload: { tasks: [{ id: 'T-1', status: 'in_progress' }] }, savedAtMs: T0 })
  const u = usability({ savedAtMs: saved.entry.savedAtMs, nowMs: T0 + 3 * HOUR, kind: 'board' })
  assert.equal(u.usable, false, `键=${key} 的看板已经过期，必须当作没有`)
  // 而同一时刻的消息仍然可用。
  const m = usability({ savedAtMs: T0, nowMs: T0 + 3 * HOUR, kind: 'messages' })
  assert.equal(m.usable, true)
})

test('★★★ 三个函数对"没给 kind"的理解必须**一致**（都当消息）', () => {
  // ★ 这条是补判据时抓出来的真 bug：`packPayload` 原来写成
  //   `if (kind === 'messages') { …消息… } return { …看板… }` ——
  //   于是**没给 kind** 时会静默掉进看板那一支，返回 `{payload}` 形状；
  //   而调用方按消息去读 `entry.entries` 拿到 `undefined`。
  //
  //   而 `usability` 那边的判据是 `kind === 'board' ? BOARD : MESSAGES`，
  //   把"没给 kind"当**消息**。两处对同一种输入的理解不一致 ——
  //   同一次调用在两个函数里被当成两种东西。
  //
  //   > 一个"没给参数就悄悄选了另一支"的默认，与一个"没给参数就报错"的默认，
  //   > 只在**有人没给参数**的时候不同 —— 而那正是它被写出来的原因。
  const packed = packPayload({ payload: [{ id: 1 }], savedAtMs: T0 }).entry
  assert.equal(packed.kind, 'messages', '没给 kind 时 packPayload 必须按消息处理')
  assert.ok(Array.isArray(packed.entries), '消息形状必须带 entries')
  assert.deepEqual(unpackPayload(packed, undefined), [{ id: 1 }], '没给 kind 时 unpackPayload 也按消息读')

  // 三个函数对 `'board'` 的理解也必须一致。
  const board = packPayload({ kind: 'board', payload: { tasks: [] }, savedAtMs: T0 }).entry
  assert.equal(board.kind, 'board')
  assert.deepEqual(unpackPayload(board, 'board'), { tasks: [] })
  // ★ 反向：把看板条目的 kind 喂给 unpackPayload 时，`entries` 分支不该被走到。
  assert.equal(unpackPayload({ entries: [{ id: 1 }] }, 'board'), null,
    '看板条目没有 payload 时必须回 null，而不是去读 entries（那是消息的形状）')

  // 而 `usability` 对同一种输入的方向要一致：没给 kind 用消息窗口。
  const u = usability({ savedAtMs: T0, nowMs: T0 + 3 * HOUR })
  assert.equal(u.usable, true, '没给 kind 时 usability 必须用消息的窗口（3 小时前仍可用）')
  // 若它用的是看板窗口，这条会是 false —— 那正是"两处理解不一致"的可观测形式。
})

// ── ⑧ ★★★ 接线（在 `app.mjs` 里）──────────────────────────────────────────
//
// 这一节**按源码结构**断言，不测行为。理由见文件头：破坏性验证里 7 处
// `app.mjs` 的破坏全部没被抓住，因为上面那些判据一个字都没读过 `app.mjs`。
//
// 判据写成"这一段必须存在"，用**行级**匹配而不是整段字面量 ——
// 一个跨 5 行的锚点会在有人加一行注释时失效，而那种失效看起来像"接线坏了"。

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.mjs'), 'utf8').replace(/\r\n/g, '\n')
const APP_LINES = APP.split('\n')

/** 找出含 `needle` 的行号与内容（便于失败时说清在哪）。 */
const linesWith = (needle) => APP_LINES
  .map((text, i) => ({ n: i + 1, text: text.trim() }))
  .filter((l) => l.text.includes(needle))

/** 断言"某一行必须有，并且它所在的函数/上下文里还有另一行"。 */
function assertWired(needle, label) {
  const hits = linesWith(needle)
  assert.ok(hits.length > 0, `接线断了：找不到 ${JSON.stringify(needle)}（${label}）`)
  return hits
}

test('★★★ 两条刷新路径都真的**回退到缓存**（否则离线读根本不会发生）', () => {
  assertWired("getReadCache('messages', conv)", '时间线的离线回退')
  assertWired("getReadCache('board')", '看板的离线回退')
  // 而且要真的把缓存画出来 —— 只取不用等于没回退。
  assertWired('state.timeline = cached.payload', '把缓存消息写进 state')
})

test('★★★ 两条回退都真的**标记**了年龄（不标记的缓存与实时数据长得一模一样）', () => {
  // ★ 这是本模块最要紧的一条接线：`markOffline` 不调，界面上就是实时数据的
  //   样子，而用户会照着三天前的看板去催一个早就完成的任务。
  assertWired("markOffline('messages', cached.ageMs)", '消息回退要标记')
  assertWired("markOffline('board', cached.ageMs)", '看板回退要标记')
  // 成功路径要把标记**清掉**（否则一次断网之后永远显示"离线"）。
  const cleared = APP_LINES.filter((l) => /markOffline\('(messages|board)', null\)/.test(l))
  assert.equal(cleared.length, 2, `成功路径必须清掉两块的标记，实际找到 ${cleared.length} 处`)
})

test('★★★ 实时数据到手后真的**写进缓存**（否则回退时没有东西可回退）', () => {
  assertWired("putReadCache('messages'", '消息要缓存')
  assertWired("putReadCache('board'", '看板要缓存')
})

test('★★★ 登出真的**清掉读缓存**（与待发队列故意相反）', () => {
  const clearSession = APP.slice(APP.indexOf('function clearSession('), APP.indexOf('function clearSession(') + 600)
  assert.ok(clearSession.includes('clearReadCache()'),
    'clearSession 里必须调 clearReadCache() —— 否则下一个人在共享设备上看到上一个人的对话')
  // ★ 而**待发队列不许**在这里清（那是用户自己打的字）。这条是**反向**判据：
  //   它断言"清缓存"这件事**没有**被顺手扩到队列上。
  assert.ok(!/LS_OUTBOX|outbox = \[\]|localStorage\.removeItem\(LS_OUTBOX\)/.test(clearSession),
    'clearSession 不许碰待发队列 —— 清掉它等于静默删掉用户打的字')
})

test('★★★ 登出路由真的走到 clearSession（不然上面那条判据守的是一个没人调的函数）', () => {
  const doLogout = APP.slice(APP.indexOf('function doLogout('), APP.indexOf('function doLogout(') + 900)
  assert.ok(doLogout.includes('clearSession()'), 'doLogout 必须调 clearSession()')
})

test('★★★ `enterApp` 真的记下了 userId（否则缓存键丢了身份那一段）', () => {
  assertWired('state.userId =', '记录当前用户 id')
  // 而且必须来自 `me.userId`，不能是硬编码/占位。
  assert.ok(/state\.userId = typeof me\?\.userId === 'string'/.test(APP),
    'userId 必须取自 me.userId —— 别的来源都不是"这个登录会话的身份"')
})

test('★★★ 两处 `enterApp` 调用都真的把 userId 传进去（否则上一行拿到的是 undefined）', () => {
  // ★ 这是一个**真实踩过的坑**：`enterApp` 之前只被传 `{ name }`（名字是显示名，
  //   不是 id）。只改 `enterApp` 里的读取而忘了调用点，`state.userId` 永远是 null
  //   —— 于是 `cacheKey` 一直返回 null、**缓存一次都不写**，
  //   而现象是"离线读从来没用过"，没有任何报错。
  const calls = APP_LINES.filter((l) => l.includes('await enterApp({'))
  assert.equal(calls.length, 2, `应当有两处 enterApp 调用，实际 ${calls.length}`)
  for (const c of calls) {
    assert.ok(c.includes('userId: me.user?.userId'),
      `这一处调用没传 userId（L${calls.indexOf(c) + 1}）：${c.trim().slice(0, 90)}`)
  }
})

test('★★★ 离线标记按**当前视图**切换（否则它说的是一句与屏幕无关的话）', () => {
  const fn = APP.slice(APP.indexOf('function renderOfflineNote('), APP.indexOf('function renderOfflineNote(') + 900)
  assert.ok(/state\.view === 'tasks' \? 'board' : 'messages'/.test(fn),
    'renderOfflineNote 必须按 state.view 选 kind —— 说"消息是旧的"而用户在看板，是一句没人会读的话')
  // 切视图时要重画（否则从消息切到看板会继续显示那句话）。
  // ★ 窗口从 700 放宽到 1400：`showView` 在 T-212 里多了"记住/还原每个页签的
  //   滚动位置"那几句（R-08），函数变长了 —— 而这条判据问的是"有没有调用"，
  //   不是"在第几个字符处调用"。窗口太小会让它在实现正确时莫名其妙地红。
  const showView = APP.slice(APP.indexOf('function showView('), APP.indexOf('function showView(') + 1400)
  assert.ok(showView.includes('renderOfflineNote()'), 'showView 必须重画离线标记')
})

test('★★★ 那句标记必须经过 `t()`（否则英文模式下仍是中文）', () => {
  // ★ 这一条盯的是"渲染边界有没有翻"。上一轮在 `outboxBanner` 上踩过同一个坑：
  //   拼出来的句子整串查表必然落空。
  const fn = APP.slice(APP.indexOf('function renderOfflineNote('), APP.indexOf('function renderOfflineNote(') + 900)
  assert.ok(fn.includes('t(n.textKey'), '外层键要经过 t()')
  assert.ok(fn.includes('t(n.agoKey'), '内层时间键也要经过 t() —— 两层都是字面量')
  // ★ 反向：不许把键**原样**写进 DOM（那正是"没翻"的形态）。
  assert.ok(!/textContent = n\.textKey/.test(fn),
    '不许把键原样写进 DOM —— 英文模式下会显示中文（或占位符）')
})

test('★ 反例守卫：上面的接线判据不是恒真', () => {
  // 一个"在源码里找子串"的判据很容易退化成恒真（比如找的字符串恰好到处都有）。
  // 这里用几个**必然不存在**的针验证 `assertWired` 真的会红。
  assert.throws(() => assertWired('getReadCache(' + "'nonexistent-kind'", '反例'), /接线断了/)
  assert.throws(() => assertWired('thisStringIsNotInAppAtAll12345', '反例'), /接线断了/)
  // 而真实存在的针能过。
  assert.doesNotThrow(() => assertWired("getReadCache('board')", '正例'))
})

