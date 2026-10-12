// workbench/mobile/outbox.mjs
// ============================================================================
// 离线待发队列（"发件箱"）。
//
// ## 它解决的是什么
//
// 手机上断网是常态（地铁、电梯、切基站），而修复前**每一条断网时发出的消息都会
// 直接消失** —— 只弹一句错误，输入框里的字还在，但只要用户离开这一屏、
// 或者 PWA 被系统回收，那些字就再也没有了。
//
//   > 一个"断网时把消息丢掉"的输入框，与一个"断网时什么都不做"的输入框，
//   > 在用户眼里是同一个东西：他说了话，而没有任何事发生。
//
// ## ★ 为什么重放是**安全**的（这是整个模块的地基）
//
// 服务端的 `/api/agent-messages` 按 `(scope, actor, clientRequestId)` 去重
// （`agent-conversations.mjs` 的 `once()`）。所以只要**幂等键在入队时生成一次、
// 重放时原样复用**，重放同一条消息永远不会建出第二条。
//
//   幂等键在**入队**时生成，不是在**发送**时生成。
//
// 这两者的差别就是"能重放"与"不能重放"：
//   · 入队时生成 → "发出去了但响应丢了"的重放仍然是同一条消息 ✓
//   · 发送时生成 → 那种情形会重放成第二条消息（用户看到自己说了两遍）✗
//
// ## ★ 哪种意图**不能**排队
//
// `feedback`（追加要求）。它的语义绑定在**哪一次运行**上：提示语自己就写着
// "下一次执行时生效"。离线三小时后再重放，那条要求会落到一个**已经跑完并结算**
// 的任务上 —— 而用户在离线时看不到"下一次运行"是哪一次。
//
//   > `ask` 晚三小时问，只是答案晚；
//   > `feedback` 晚三小时问，改的是**另一次**运行。
//
// 所以 `feedback` 不入队，而是**把原文留在输入框里并说清为什么**，
// 让用户回到线上时自己按一次发送 —— 那时他看得见是给哪条任务、哪个状态加的。
//
// ## ★ 失败分类的非对称（这个模块最要紧的一条）
//
// 分类只有三档：`transient`（留着重试）/ `permanent`（别自动重试了）/
// `session`（等重新登录）。而**默认必须是 `transient`**：
//
//   · 把瞬时当永久 → **用户打的字被删了**（静默数据丢失，最坏）
//   · 把永久当瞬时 → 队列卡住（看得见、用户能自己删掉，可修）
//
// 两种错的方向不对等，所以拿不准时一律按"留着"处理。
// 而且 `permanent` 也**不删**条目 —— 只停止自动重试，条目留在列表里带错误原因，
// 由用户决定改还是丢。
//
//   > "服务端说 400" 是关于**用户的字**的一个判断。
//   > 替用户决定把它删掉，不是这个模块该做的事。
// ============================================================================

/** 队列上限。到顶时**拒绝入队**，而不是丢掉最旧的那条。 */
export const OUTBOX_LIMIT = 50

/** 超过这个年龄的待发消息在界面上标"可能已过时"。 */
export const STALE_AFTER_MS = 10 * 60 * 1000

/** 条目的状态。`failed` **留在列表里**（见文件头那段非对称）。 */
export const ENTRY_STATE = Object.freeze({
  QUEUED: 'queued',
  FAILED: 'failed',
})

export const OUTBOX_CODES = Object.freeze({
  NOT_QUEUEABLE: 'NOT_QUEUEABLE',
  FULL: 'FULL',
  NO_IDEMPOTENCY_KEY: 'NO_IDEMPOTENCY_KEY',
})

/**
 * 这个意图能不能排队。
 *
 * @returns {{ok: true} | {ok: false, code: string, reason: string}}
 */
export function isQueueable(intent) {
  if (intent === 'ask' || intent === 'create_task') return { ok: true }
  if (intent === 'feedback') {
    return {
      ok: false,
      code: OUTBOX_CODES.NOT_QUEUEABLE,
      // 这句是给用户看的，必须说清"为什么别人能排队它不能"，而不是"不支持"。
      reason: '「追加要求」不能离线排队：它改的是**正在跑的那一次**执行，'
        + '而你离线时看不到那一次是哪一次。回到线上再发，原文已经给你留着。',
    }
  }
  return {
    ok: false,
    code: OUTBOX_CODES.NOT_QUEUEABLE,
    reason: `这个意图不能离线排队：${intent}`,
  }
}

/**
 * 失败分类。**默认 `transient`** —— 见文件头那段非对称。
 *
 * @param {{status?: number|null, code?: string|null, offline?: boolean}} input
 * @returns {'transient'|'permanent'|'session'}
 */
export function classifyFailure({ status = null, code = null, offline = false } = {}) {
  // 根本没到服务端（断网、DNS、超时）—— 一定可重试。
  if (offline === true || status === null || status === undefined) return 'transient'
  // 会话没了：不是"这条消息有问题"，而是"你得先重新登录"。留着，等登录后重放。
  if (status === 401) return 'session'
  // ★ 配额/限速：这条消息**没问题**，只是现在不该发。必须留着 ——
  //   把它当永久失败会删掉用户的话，而它五分钟后就能发出去。
  if (status === 429) return 'transient'
  // 明确的瞬时档。
  if (status === 408 || status === 425 || status === 502 || status === 503 || status === 504) return 'transient'
  // 5xx 一律瞬时（服务端自己出问题，与这条消息无关）。
  if (status >= 500) return 'transient'
  // ★ 永久档：**只列那些"这条请求本身不对"的客户端错误**。
  //   刻意不写成 `4xx 全部永久`：4xx 里混着 408/425/429 这类明确瞬时的，
  //   一个"按首位数字分类"的规则会把它们一起删掉。
  if (status === 400 || status === 403 || status === 404 || status === 405
    || status === 409 || status === 410 || status === 413 || status === 422) return 'permanent'
  // 剩下的（含 402、412、451 这些没见过的）按瞬时处理 —— 拿不准就留着。
  return 'transient'
}

/**
 * 造一条待发条目。
 *
 * ★ **幂等键是必填的**，而且必须由调用方在**入队时**生成并保存下来。
 *   这条断言是本模块存在的理由：没有它，"重放"就变成了"重复发送"。
 *
 * @throws {Error} 缺幂等键时抛（这是编程错误，不是用户错误）
 */
export function makeEntry({
  id, convId, scope, body, intent, taskId = null, clientRequestId, atMs,
} = {}) {
  if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) {
    throw Object.assign(
      new Error('待发条目必须有 clientRequestId（幂等键）—— 否则重放会变成重复发送'),
      { code: OUTBOX_CODES.NO_IDEMPOTENCY_KEY },
    )
  }
  return Object.freeze({
    id: String(id),
    convId: Number(convId),
    scope: String(scope),
    body: String(body),
    intent: String(intent),
    taskId: taskId === null || taskId === undefined ? null : String(taskId),
    // ★ 原样保存，重放时**原样提交**（不重新生成）。
    clientRequestId: String(clientRequestId),
    atMs: Number(atMs),
    state: ENTRY_STATE.QUEUED,
    // 上一次失败的原因（成功就没有）。`null` = 还没失败过。
    lastError: null,
  })
}

/**
 * 入队。**满了就拒绝，不丢最旧的**。
 *
 * 丢最旧的是"看起来更顺手"的实现，而它会**静默删掉用户打的字** ——
 * 用户看到的是"我发了 51 条，怎么只有 50 条"。拒绝入队至少是诚实的：
 * 用户当场就知道该处理一下队列了。
 *
 * @returns {{entries: Array, accepted: boolean, code: string|null, reason: string|null}}
 */
export function appendEntry(entries, entry, { limit = OUTBOX_LIMIT } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const cap = Number.isFinite(limit) && limit > 0 ? limit : OUTBOX_LIMIT
  if (list.length >= cap) {
    return {
      entries: list,
      accepted: false,
      code: OUTBOX_CODES.FULL,
      reason: `待发队列已满（${cap} 条）。先连上网络把它们发出去，或者删掉几条不想要的。`,
    }
  }
  // ★ 同一个幂等键不许进来两次：那正是"重放变成重复"的另一种写法。
  if (list.some((e) => e.clientRequestId === entry.clientRequestId)) {
    return { entries: list, accepted: false, code: null, reason: null }
  }
  return { entries: [...list, entry], accepted: true, code: null, reason: null }
}

/** 下一个该自动尝试的条目：**先进先出**，跳过已永久失败的。 */
export function nextEntry(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.find((e) => e.state === ENTRY_STATE.QUEUED) ?? null
}

/**
 * 记一次发送结果。
 *
 * @param {'ok'|'transient'|'permanent'|'session'} outcome
 * @param {{status?: number|null, message?: string|null}} detail
 * @returns {{entries: Array, removed: boolean, stopped: boolean}}
 *          `removed` = 这条出队了（成功）／`stopped` = 自动重试该停下来了
 */
export function markResult(entries, id, outcome, detail = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (outcome === 'ok') {
    // 成功了才真的删掉。这是**唯一**会删条目的路径。
    return { entries: list.filter((e) => e.id !== id), removed: true, stopped: false }
  }
  const message = detail.message ?? null
  const next = list.map((e) => {
    if (e.id !== id) return e
    if (outcome === 'permanent') {
      return { ...e, state: ENTRY_STATE.FAILED, lastError: message ?? `HTTP ${detail.status ?? '?'}` }
    }
    // transient / session：留着，只记下最后一次的错误（界面上能看到"正在重试"）。
    return { ...e, lastError: message ?? (outcome === 'session' ? '需要重新登录' : '网络不通') }
  })
  return { entries: next, removed: false, stopped: outcome !== 'session' }
}

/**
 * 一次"排空"的计划：按顺序该发哪几条。
 *
 * ★ 遇到瞬时失败**就停**（后面的不发了）。理由不是效率，是**顺序**：
 *   聊天是一条时间线，把第 3 条发出去而第 2 条还在重试，
 *   会让 Agent 看到一个错乱的上下文，它的回答也会错乱。
 *
 * `failed`（永久失败）**不挡路** —— 让它继续挡着会把整条队列永久卡死在一个
 * 永远不会成功的条目后面。
 *
 * ★ 判定只有**一处**：`state === QUEUED`。
 *   第一版写成两条（先 `if (FAILED) continue` 再 `if (state !== QUEUED) continue`），
 *   而破坏性验证把第一条删掉之后**全部判据仍然全绿** —— 因为第二条替它兜住了。
 *   一条删掉也不会改变行为的守卫，在判据眼里等于不存在：
 *   > 它给人的"这里检查过了"的安全感是真的，而它检查的事情一直是另一条在做。
 *   所以现在只留一处：任何改动都能被那条"失败的条目不挡路"的判据杀掉。
 */
export function drainPlan(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.filter((e) => e.state === ENTRY_STATE.QUEUED)
}

/**
 * 给界面用的摘要。
 *
 * ★ `stale` 这一项是**必须**报出去的：一条排队三小时的消息发出去时，
 *   用户以为自己在问"现在做到哪了"，而 Agent 收到的是一句迟到的话。
 *   不告诉他，他就会把那个回答当成现在的状态。
 */
export function outboxSummary({ entries, nowMs } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const queued = list.filter((e) => e.state === ENTRY_STATE.QUEUED)
  const failed = list.filter((e) => e.state === ENTRY_STATE.FAILED)
  const times = list.map((e) => Number(e.atMs)).filter((t) => Number.isFinite(t))
  const oldestMs = times.length > 0 ? Math.min(...times) : null
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const oldestAgeMs = oldestMs === null ? 0 : Math.max(0, now - oldestMs)
  return Object.freeze({
    total: list.length,
    queued: queued.length,
    failed: failed.length,
    oldestAgeMs,
    // 只要**任何一条**超过阈值就算 stale（用户要看的是"这里面有旧消息吗"）。
    stale: oldestAgeMs >= STALE_AFTER_MS,
    // 有永久失败的条目时界面要提示"有 N 条发不出去，去看看"。
    hasFailed: failed.length > 0,
  })
}

/**
 * 队列要不要显示、显示成什么。
 *
 * ★★ 返回值里是 **`textKey` / `detailKey` + `vars`**，不是拼好的句子。
 *   这一点是本模块能被翻译的前提：
 *
 *   > `'3 条待发'` 这样的句子**永远**不可能在英文表里查到 ——
 *   > 它里面带一个数字，每一句都是新的。
 *
 *   上一轮在 `popupText` 上踩过同一个坑（拼出来的句子整串查表必然落空）；
 *   当时的修法是给投影层传一个翻译器。这次改成**返回键**，因为键是字面量：
 *   于是 `i18n.test.mjs` 那支"每个键都要有英文"的判据**看得见**它们，
 *   漏翻会在 CI 变红，而不是等到有人在英文模式下断网才发现。
 *
 * ★ 单独抽出来还因为"什么时候**不**显示"和"显示什么"一样重要：
 *   空队列必须完全不占地方 —— 一个常驻的"0 条待发"横条会让用户
 *   学会忽略这一块屏幕区域，于是真有待发时他也看不见了。
 */
export function outboxBanner({ entries, nowMs, online } = {}) {
  const s = outboxSummary({ entries, nowMs })
  if (s.total === 0) return null
  if (s.hasFailed) {
    return Object.freeze({
      tone: 'error',
      textKey: '{n} 条发不出去',
      textVars: { n: String(s.failed) },
      detailKey: '这些消息服务端拒绝了，需要你处理（改一下或删掉）。',
      detailVars: {},
    })
  }
  const mins = Math.max(1, Math.round(s.oldestAgeMs / 60000))
  const textKey = '{n} 条待发'
  const textVars = { n: String(s.queued) }
  if (online === false) {
    return Object.freeze({
      tone: 'warn',
      textKey,
      textVars,
      detailKey: s.stale
        ? '最早的一条已经等了约 {mins} 分钟。连上网络后会自动发出。'
        : '断网中，连上网络后会自动发出。',
      detailVars: s.stale ? { mins: String(mins) } : {},
    })
  }
  return Object.freeze({
    tone: 'warn',
    textKey,
    textVars,
    detailKey: s.stale ? '正在重试，最早的一条已经等了约 {mins} 分钟。' : '正在重试…',
    detailVars: s.stale ? { mins: String(mins) } : {},
  })
}
