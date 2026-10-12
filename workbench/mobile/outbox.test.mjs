// workbench/mobile/outbox.test.mjs
// ============================================================================
// 离线待发队列的纯决策。
//
// 这一族守的是一句话：**用户打的字不许因为"网不好"而消失。**
//
// 它本身是纯逻辑（不碰 DOM、不碰 localStorage），因为队列的每条规则都会在
// **断网**时才被真正用到 —— 而断网是测试最难复现、生产上最常发生的那个状态。
// 把它做成纯函数，就能在正常网络下把"断网时的行为"逐条钉死。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OUTBOX_LIMIT, STALE_AFTER_MS, ENTRY_STATE, OUTBOX_CODES,
  isQueueable, classifyFailure, makeEntry, appendEntry, nextEntry, markResult,
  drainPlan, outboxSummary, outboxBanner,
} from './outbox.mjs'

const T0 = 1_800_000_000_000
const MIN = 60_000

/** 造一条条目，幂等键按序号生成（**入队时**生成一次，重放复用）。 */
const entry = (n, over = {}) => makeEntry({
  id: 'e' + n,
  convId: 7,
  scope: 'default',
  body: 'msg-' + n,
  intent: 'ask',
  clientRequestId: 'mobile-' + n,
  atMs: T0 + n,
  ...over,
})

// ── ① 哪种意图能排队 ────────────────────────────────────────────────────────

test('★★★ `ask` 与 `create_task` 可以排队', () => {
  assert.equal(isQueueable('ask').ok, true)
  assert.equal(isQueueable('create_task').ok, true)
})

test('★★★ `feedback` **不能**排队，而且理由必须说清"为什么别人行它不行"', () => {
  // ★ 这是本模块最重要的一条业务判断。
  //   `feedback` 的提示语自己就写着"下一次执行时生效" —— 它的语义绑定在
  //   **哪一次运行**上。离线三小时后重放，那条要求会落到一个已经跑完并结算的
  //   任务上，而用户在离线时看不到"下一次运行"是哪一次。
  //
  //   > `ask` 晚三小时问，只是答案晚；
  //   > `feedback` 晚三小时问，改的是**另一次**运行。
  const r = isQueueable('feedback')
  assert.equal(r.ok, false)
  assert.equal(r.code, OUTBOX_CODES.NOT_QUEUEABLE)
  assert.match(r.reason, /追加要求/, '要把用户看到的那个词说出来，不是内部 id')
  assert.match(r.reason, /正在跑的那一次|那一次/, '要说清它绑定在哪一次运行上')
  assert.match(r.reason, /留着/, '要告诉用户原文没丢 —— 否则他不敢离开这一屏')
})

test('★ 未知意图也不排队（不静默当成 ask）', () => {
  for (const bad of ['', 'nope', null, undefined, 'DELETED_INTENT']) {
    const r = isQueueable(bad)
    assert.equal(r.ok, false, `${String(bad)} 不该被当成可排队`)
  }
})

// ── ② ★★★ 幂等键：重放安全的地基 ───────────────────────────────────────────

test('★★★ 没有幂等键就造不出条目（那是编程错误，不是用户错误）', () => {
  // ★ 这一条是整个模块的地基。服务端按 (scope, actor, clientRequestId) 去重，
  //   所以"重放同一条"永远不会建出第二条 —— **前提是键被原样复用**。
  //   没有键，"重放"就变成了"重复发送"（用户看到自己说了两遍）。
  for (const bad of [undefined, null, '', 0, {}]) {
    assert.throws(
      () => makeEntry({ id: 'e1', convId: 1, scope: 's', body: 'b', intent: 'ask', clientRequestId: bad, atMs: T0 }),
      (e) => e.code === OUTBOX_CODES.NO_IDEMPOTENCY_KEY,
      `clientRequestId=${JSON.stringify(bad)} 必须被拒`,
    )
  }
})

test('★★★ 幂等键原样保存 —— 重放提交的必须是**同一个**键', () => {
  const e = entry(1)
  assert.equal(e.clientRequestId, 'mobile-1')
  // 服务端在 200 响应里也会回这个键；断言它没被改写、没被截断、没被重新生成。
  assert.equal(typeof e.clientRequestId, 'string')
  assert.notEqual(e.clientRequestId, '')
})

test('★★ 同一个幂等键不许进队列两次', () => {
  // "同一个键出现两次"是"重放变成重复"的另一种写法 —— 服务端会去重，
  // 但用户在界面上会看到两条一模一样的待发消息，以为要发两遍。
  const a = appendEntry([], entry(1))
  const b = appendEntry(a.entries, entry(1, { id: 'e1-again' }))
  assert.equal(b.accepted, false)
  assert.equal(b.entries.length, 1)
})

// ── ③ ★★★ 失败分类的非对称 ─────────────────────────────────────────────────

test('★★★ 断网 / 超时 / 5xx / 429 一律**留着重试**', () => {
  const transient = [
    { offline: true },
    { status: null },
    { status: 408 },
    { status: 425 },
    { status: 429 },   // ★ 配额/限速：这条消息没问题，只是现在不该发
    { status: 500 },
    { status: 502 },
    { status: 503 },
    { status: 504 },
  ]
  for (const c of transient) {
    assert.equal(classifyFailure(c), 'transient', `${JSON.stringify(c)} 应当可重试`)
  }
})

test('★★★ 拿不准的状态码必须按**可重试**处理（两个方向不对等）', () => {
  // ★ 这条是非对称的**判据化**：
  //     · 把瞬时当永久 → 用户打的字被删了（静默数据丢失，最坏）
  //     · 把永久当瞬时 → 队列卡住（看得见、用户能自己删掉，可修）
  //   所以"没见过的状态码"必须落到"留着"那一侧。
  for (const s of [402, 412, 418, 451, 599, 0, -1]) {
    assert.equal(classifyFailure({ status: s }), 'transient', `${s} 没见过 → 必须留着`)
  }
  // 甚至连"状态码是字符串"这种畸形输入也不许判成永久。
  assert.equal(classifyFailure({ status: '400x' }), 'transient')
})

test('★★ 明确的"这条请求本身不对"才算永久', () => {
  for (const s of [400, 403, 404, 405, 409, 410, 413, 422]) {
    assert.equal(classifyFailure({ status: s }), 'permanent', `${s} 应当是永久`)
  }
})

test('★★ 401 单独一档：不是"这条消息有问题"，是"你得先登录"', () => {
  // 与 permanent 分开是因为界面要说不同的话、用户要做不同的事
  // （重新登录 vs 改消息），而且重放**要留着**。
  assert.equal(classifyFailure({ status: 401 }), 'session')
  assert.notEqual(classifyFailure({ status: 401 }), 'permanent')
})

test('★★★ 4xx 不许整档判成永久（408/425/429 混在里面）', () => {
  // 一个"按首位数字分类"的实现会写成 `status >= 400 && status < 500` → permanent，
  // 于是一次**限速**就把用户没发出去的消息删掉了。
  for (const s of [408, 425, 429]) {
    assert.notEqual(classifyFailure({ status: s }), 'permanent', `${s} 不该被整档判死`)
  }
})

// ── ④ 出队只有一条路径：成功 ────────────────────────────────────────────────

test('★★★ 只有"成功"会删条目；永久失败**留在列表里**', () => {
  // ★ "服务端说 400" 是关于**用户的字**的一个判断。替用户决定把它删掉，
  //   不是这个模块该做的事 —— 所以永久失败只是**停止自动重试**。
  let entries = [entry(1), entry(2)]
  const failed = markResult(entries, 'e1', 'permanent', { status: 400, message: '消息正文不能为空' })
  assert.equal(failed.entries.length, 2, '永久失败不许删条目')
  assert.equal(failed.removed, false)
  assert.equal(failed.entries[0].state, ENTRY_STATE.FAILED)
  assert.match(failed.entries[0].lastError, /正文不能为空/, '要把服务端说的原因留给用户看')

  const ok = markResult(failed.entries, 'e1', 'ok')
  assert.equal(ok.entries.length, 1)
  assert.equal(ok.removed, true)
})

test('★★ 瞬时失败留着，并记下最后一次的原因（界面要显示"正在重试"）', () => {
  const r = markResult([entry(1)], 'e1', 'transient', { message: '网络不通' })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].state, ENTRY_STATE.QUEUED, '瞬时失败不许改变状态')
  assert.match(r.entries[0].lastError, /网络不通/)
})

test('★★ 会话过期也留着（登录之后应当能发出去）', () => {
  const r = markResult([entry(1)], 'e1', 'session', { status: 401 })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].state, ENTRY_STATE.QUEUED)
  assert.match(r.entries[0].lastError, /登录/)
})

// ── ⑤ 顺序与排空 ────────────────────────────────────────────────────────────

test('★★★ 排空顺序必须是**先进先出**', () => {
  const plan = drainPlan([entry(3), entry(1), entry(2)])
  // `drainPlan` 不改顺序 —— 顺序由**入队顺序**决定，不由时间戳重排。
  // 重排会让用户在断网期间看到的两句话在服务端换了先后。
  assert.deepEqual(plan.map((e) => e.id), ['e3', 'e1', 'e2'])
})

test('★★★ 永久失败的条目不挡路（否则队列会被一条永远不成功的条目永久卡死）', () => {
  const entries = [
    { ...entry(1), state: ENTRY_STATE.FAILED, lastError: '正文不能为空' },
    entry(2),
    entry(3),
  ]
  const plan = drainPlan(entries)
  assert.deepEqual(plan.map((e) => e.id), ['e2', 'e3'], '失败的条目要跳过，后面的照发')
})

test('★★★ 一条都没有时排空计划是空的（不抛、不发空气）', () => {
  assert.deepEqual(drainPlan([]), [])
  assert.deepEqual(drainPlan(null), [])
  assert.deepEqual(drainPlan(undefined), [])
})

test('★★ `nextEntry` 给出的是第一条**可自动重试**的，跳过失败的', () => {
  const entries = [{ ...entry(1), state: ENTRY_STATE.FAILED }, entry(2), entry(3)]
  assert.equal(nextEntry(entries).id, 'e2')
  assert.equal(nextEntry([]), null)
  assert.equal(nextEntry([{ ...entry(1), state: ENTRY_STATE.FAILED }]), null)
})

// ── ⑥ 上限：满了**拒绝**，不丢最旧的 ────────────────────────────────────────

test('★★★ 队列满时拒绝入队，**不丢最旧的那条**', () => {
  // ★ 丢最旧的是"看起来更顺手"的实现，而它会**静默删掉用户打的字**：
  //   用户看到的是"我发了 51 条，怎么只有 50 条"。
  //   拒绝入队至少是诚实的 —— 用户当场就知道该处理一下队列了。
  const full = Array.from({ length: 3 }, (_, i) => entry(i + 1))
  const r = appendEntry(full, entry(99), { limit: 3 })
  assert.equal(r.accepted, false)
  assert.equal(r.code, OUTBOX_CODES.FULL)
  assert.equal(r.entries.length, 3, '满的时候不许动既有条目')
  assert.deepEqual(r.entries.map((e) => e.id), ['e1', 'e2', 'e3'], '最旧的那条必须还在')
  assert.match(r.reason, /3/, '要把上限的数字说出来')
})

test('★★ 没满时正常入队，且追加在**末尾**（顺序即时间线）', () => {
  const r = appendEntry([entry(1)], entry(2), { limit: 3 })
  assert.equal(r.accepted, true)
  assert.deepEqual(r.entries.map((e) => e.id), ['e1', 'e2'])
})

test('★ 默认上限是个正整数（不是一个会被忽略的 0/undefined）', () => {
  assert.ok(Number.isFinite(OUTBOX_LIMIT) && OUTBOX_LIMIT > 0)
  const list = []
  const r = appendEntry(list, entry(1))
  assert.equal(r.accepted, true, '不传 limit 时要用默认值，不是"立刻满"')
})

// ── ⑦ 摘要与横幅 ────────────────────────────────────────────────────────────

test('★★★ 空队列**完全不占地方**（横幅为 null）', () => {
  // ★ 一个常驻的"0 条待发"横条会让用户学会忽略这一块屏幕区域，
  //   于是真有待发时他也看不见了。
  assert.equal(outboxBanner({ entries: [], nowMs: T0 }), null)
  assert.equal(outboxBanner({ entries: null, nowMs: T0 }), null)
  assert.equal(outboxBanner({ nowMs: T0 }), null)
})

test('★★★ 有待发时横幅要说清"几条"与"断网还是重试中"', () => {
  const entries = [entry(1), entry(2)]
  const offline = outboxBanner({ entries, nowMs: T0 + 2, online: false })
  assert.equal(offline.textKey, '{n} 条待发')
  assert.equal(offline.textVars.n, '2')
  assert.equal(offline.detailKey, '断网中，连上网络后会自动发出。')
  const retrying = outboxBanner({ entries, nowMs: T0 + 2, online: true })
  assert.equal(retrying.detailKey, '正在重试…')
  assert.notEqual(offline.detailKey, retrying.detailKey, '断网与重试中要说不同的话')
})

test('★★★ 横幅返回的是**键 + 变量**，不是拼好的句子', () => {
  // ★ 这条盯的是"这个模块能不能被翻译"。拼出来的 `'3 条待发'` 永远查不到英文 ——
  //   它里面带一个数字，每一句都是新的。返回键（字面量）才能被 i18n 覆盖率判据看见。
  const b = outboxBanner({ entries: [entry(1)], nowMs: T0 + 2, online: false })
  assert.equal(typeof b.textKey, 'string')
  assert.equal(typeof b.detailKey, 'string')
  assert.equal(typeof b.textVars, 'object')
  assert.equal(typeof b.detailVars, 'object')
  // 键里不许已经把数字填进去（那就是拼好的句子了）。
  assert.match(b.textKey, /\{n\}/, '数量必须是占位符，不是填好的数字')
  assert.doesNotMatch(b.textKey, /\d/, '键里不许出现具体数字')
  assert.doesNotMatch(b.detailKey, /\d/, '详情键里也不许出现具体数字')
  // 而且**不许**留下旧的 `text` / `detail` 字段（那说明调用方还在拼句子）。
  assert.equal(b.text, undefined, '不许再返回拼好的 text')
  assert.equal(b.detail, undefined, '不许再返回拼好的 detail')
})

test('★★★ 超时的待发必须标出来（否则用户把迟到的回答当成现在的状态）', () => {
  // ★ 一条排队三小时的消息发出去时，用户以为自己在问"现在做到哪了"，
  //   而 Agent 收到的是一句迟到的话。不告诉他，他就会把那个回答当成现在的状态。
  const fresh = outboxSummary({ entries: [entry(1)], nowMs: T0 + 1 + MIN })
  assert.equal(fresh.stale, false)
  const old = outboxSummary({ entries: [entry(1)], nowMs: T0 + 1 + STALE_AFTER_MS + MIN })
  assert.equal(old.stale, true)
  assert.ok(old.oldestAgeMs >= STALE_AFTER_MS)
  const banner = outboxBanner({ entries: [entry(1)], nowMs: T0 + 1 + STALE_AFTER_MS + MIN, online: false })
  assert.match(banner.detailKey, /\{mins\}/, '要把"等了多久"作为**占位符**说出来')
  assert.ok(Number(banner.detailVars.mins) >= 10, `分钟数要算出来（实际 ${banner.detailVars.mins}）`)
})

test('★★★ 有永久失败时横幅优先报**那个**（它需要用户动手）', () => {
  // 与"正在重试"不同：永久失败不会自己好，用户不去看就永远卡着。
  const entries = [
    { ...entry(1), state: ENTRY_STATE.FAILED, lastError: '正文不能为空' },
    entry(2),
  ]
  const b = outboxBanner({ entries, nowMs: T0 + 2, online: true })
  assert.equal(b.tone, 'error', '永久失败要用错误的调子，不是警告')
  assert.equal(b.textKey, '{n} 条发不出去')
  assert.equal(b.textVars.n, '1')
  assert.match(b.detailKey, /改一下或删掉/)
})

test('★★ 摘要的数字必须与实际条目对得上（不是各自算一遍）', () => {
  const entries = [
    entry(1),
    { ...entry(2), state: ENTRY_STATE.FAILED },
    { ...entry(3), state: ENTRY_STATE.FAILED },
  ]
  const s = outboxSummary({ entries, nowMs: T0 + 3 })
  assert.equal(s.total, 3)
  assert.equal(s.queued, 1)
  assert.equal(s.failed, 2)
  assert.equal(s.queued + s.failed, s.total, '两档必须把全部条目分完，不许有第三档被漏掉')
  assert.equal(s.hasFailed, true)
})

test('★ 畸形输入不抛（队列状态来自 localStorage，可能是别人写坏的）', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.doesNotThrow(() => outboxSummary({ entries: bad, nowMs: T0 }))
    assert.doesNotThrow(() => drainPlan(bad))
    assert.doesNotThrow(() => appendEntry(bad, entry(1)))
    assert.doesNotThrow(() => outboxBanner({ entries: bad, nowMs: T0 }))
  }
  // 时间戳是垃圾时也不许算出 NaN。
  const s = outboxSummary({ entries: [makeEntry({ id: 'x', convId: 1, scope: 's', body: 'b', intent: 'ask', clientRequestId: 'k', atMs: NaN })], nowMs: T0 })
  assert.ok(Number.isFinite(s.oldestAgeMs))
})

// ── ⑧ 端到端的一条链路（把上面各条连起来跑一遍）────────────────────────────

test('★★★ 断网 → 排队 → 联网 → 重放成功 → 队列清空（且幂等键全程不变）', () => {
  let entries = []
  // 用户离线时连发三条。
  for (const n of [1, 2, 3]) {
    const r = appendEntry(entries, entry(n))
    assert.equal(r.accepted, true)
    entries = r.entries
  }
  const before = entries.map((e) => e.clientRequestId)
  assert.equal(outboxSummary({ entries, nowMs: T0 + 3 }).queued, 3)

  // 联网后按顺序排空。第一条先瞬时失败（网络刚起来又不稳）。
  let plan = drainPlan(entries)
  assert.deepEqual(plan.map((e) => e.id), ['e1', 'e2', 'e3'])
  let r = markResult(entries, 'e1', 'transient', { message: '网络不通' })
  assert.equal(r.stopped, true, '瞬时失败要停下，后面的不许越过它')
  entries = r.entries
  assert.equal(entries.length, 3)

  // 再试：三条依次成功。
  for (const id of ['e1', 'e2', 'e3']) {
    r = markResult(entries, id, 'ok')
    entries = r.entries
  }
  assert.equal(entries.length, 0, '全部成功后队列必须空')
  // ★ 幂等键全程不变 —— 这是"重放安全"的可观测形式。
  assert.deepEqual(before, ['mobile-1', 'mobile-2', 'mobile-3'])
  assert.equal(outboxBanner({ entries, nowMs: T0 + 3 }), null, '清空后不占地方')
})

test('★★★ 一条永久失败 + 两条瞬时：失败那条留给人处理，另两条照发', () => {
  let entries = [entry(1), entry(2), entry(3)]
  // 第 1 条被服务端永久拒绝。
  entries = markResult(entries, 'e1', 'permanent', { status: 400, message: '消息正文不能为空' }).entries
  // 第 2 条临时失败。
  const r = markResult(entries, 'e2', 'transient', { message: '网络不通' })
  entries = r.entries
  assert.equal(entries.length, 3, '两种失败都不许删条目')
  // 排空计划：跳过失败的第 1 条，从第 2 条开始，**不越过**它。
  assert.deepEqual(drainPlan(entries).map((e) => e.id), ['e2', 'e3'])
  assert.equal(r.stopped, true)
  // 横幅优先报永久失败那条（它需要人动手）。
  const b = outboxBanner({ entries, nowMs: T0 + 3, online: true })
  assert.equal(b.tone, 'error')
  assert.equal(b.textKey, '{n} 条发不出去')
  assert.equal(b.textVars.n, '1')
})
