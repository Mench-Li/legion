import type { HubAuditEvent } from './types'

export type CursorStorage = Pick<Storage, 'getItem' | 'setItem'>

export type HubEventStreamOptions = {
  scope?: string
  storage?: CursorStorage
  /**
   * 每次（重）连之前签一张订阅票据。返回 `undefined` 表示这次不带
   * （门禁没开的本机部署就是这样）。
   *
   * 为什么是**回调**而不是一个字符串：票据是一次性的，而重连要一张新的。
   * 传一个固定字符串的接口，与"第一次连得上、断线之后再也连不上"的接口，
   * 在只跑一次的实现里是同一个东西。
   */
  ticketProvider?: () => Promise<string | undefined>
  EventSourceCtor?: typeof EventSource
  /**
   * SSE 连接状态回调（P2-4 实时连接可观测性）：首次建立 open、断线重连成功 reconnected、
   * 断开重连中 reconnecting、关闭 closed。`opens` = 成功打开次数（>1 即发生过断线重连）。
   */
  onStatus?: (status: { state: 'open' | 'reconnected' | 'reconnecting' | 'closed'; opens: number }) => void
}

/** Stable cursor key. `*` represents the global (unscoped) stream. */
export function hubCursorKey(hub: string, scope?: string): string {
  const normalizedHub = String(hub).replace(/\/+$/, '')
  return `hub-events:${normalizedHub}/:${scope && scope.trim() ? scope.trim() : '*'}`
}

/** Read a safe non-negative cursor; malformed or unavailable storage is a cache miss. */
export function readHubCursor(storage: Pick<Storage, 'getItem'> | undefined, key: string): number | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (raw === null || !/^\d+$/.test(raw)) return null
    const seq = Number(raw)
    return Number.isSafeInteger(seq) ? seq : null
  } catch {
    return null
  }
}

/** Persist only a monotonic cursor; storage failures must never stop event consumption. */
export function writeHubCursor(storage: CursorStorage | undefined, key: string, seq: number): void {
  if (!storage || !Number.isSafeInteger(seq) || seq < 0) return
  const current = readHubCursor(storage, key)
  if (current !== null && current >= seq) return
  try {
    storage.setItem(key, String(seq))
  } catch {
    /* Private browsing or quota errors degrade to in-memory reconnect behavior. */
  }
}

/** Build a query string without changing whether the input URL was relative or absolute. */
export function buildHubEventSourceUrl(
  base: string,
  options: { scope?: string; sinceSeq?: number | null; ticket?: string } = {},
): string {
  const hashIndex = base.indexOf('#')
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? base.slice(0, hashIndex) : base
  const queryIndex = withoutHash.indexOf('?')
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '')
  if (options.scope !== undefined) params.set('scope', options.scope)
  if (options.sinceSeq !== undefined && options.sinceSeq !== null) params.set('sinceSeq', String(options.sinceSeq))
  // ★ 参数名是 `ticket`，**不是** `token`。
  //
  //   票据是一次性的、只活 60 秒、只对订阅有效；访问令牌是 15 分钟、覆盖全部
  //   API。两者共用一个参数名，会让人在 URL 上分不出「这一串是哪一种」——
  //   而"分不出"正是这次要修的那件事的一半：一个把主钥匙抄在门口的实现，
  //   在代码里看起来与"已经鉴权了"一模一样。
  if (options.ticket) params.set('ticket', options.ticket)
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ''}${hash}`
}

/** Validate the common v2 event envelope before it reaches any consumer. */
export function isHubAuditEvent(value: unknown): value is HubAuditEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<HubAuditEvent>
  const id = event.id
  const seq = event.seq
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
    && typeof seq === 'number' && Number.isSafeInteger(seq) && seq === id
    && typeof event.event === 'string' && event.event.length > 0
    && typeof event.scope === 'string'
    && typeof event.ts === 'string' && event.ts.length > 0
    && !!event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
}

function defaultStorage(): CursorStorage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Subscribe to a hub stream with scope filtering, envelope validation, and persistent cursors. */
export function subscribeHubEventStream(
  base: string,
  onEvent: (event: HubAuditEvent) => void,
  options: HubEventStreamOptions = {},
): () => void {
  const storage = options.storage ?? defaultStorage()
  const scope = options.scope?.trim() || undefined
  const key = hubCursorKey(base, scope)
  let lastSeq = readHubCursor(storage, key) ?? -1
  const EventSourceCtor = options.EventSourceCtor ?? globalThis.EventSource

  let source: EventSource | null = null
  let closed = false
  let opens = 0
  let retry = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function status(state: 'open' | 'reconnected' | 'reconnecting' | 'closed'): void {
    try { options.onStatus?.({ state, opens }) } catch { /* 状态回调不得影响流 */ }
  }

  function scheduleRetry(): void {
    if (closed || timer !== null) return
    // 指数退避、封顶 30s：一个连不上的订阅不该变成每秒一次的锤击。
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5))
    retry += 1
    timer = setTimeout(() => { timer = null; void connect() }, delay)
  }

  async function connect(): Promise<void> {
    if (closed) return
    // ★ 每次（重）连都新签一张票据。
    //
    //   票据是**一次性**的，而 `EventSource` 自带的重连会原样重发那个 URL——
    //   所以自带重连在这里必然失败，而且失败得很安静：界面停在"正在重连"上，
    //   浏览器那边是一串 401。我们关掉它、自己接管重连；代价是这一段代码，
    //   换来的是"URL 里那一串用完即废"。
    let ticket: string | undefined
    try {
      ticket = options.ticketProvider === undefined ? undefined : await options.ticketProvider()
    } catch {
      // 签不出来（没登录 / 网络抖）：退避后重试，而不是拿一个空票据去换 401。
      status(opens > 0 ? 'reconnecting' : 'closed')
      scheduleRetry()
      return
    }
    if (closed) return

    const es = new EventSourceCtor(buildHubEventSourceUrl(base, {
      scope,
      sinceSeq: lastSeq >= 0 ? lastSeq : null,
      ticket,
    }))
    source = es
    es.onopen = () => {
      opens += 1
      retry = 0
      status(opens > 1 ? 'reconnected' : 'open')
    }
    es.onerror = () => {
      // 先关掉：不关的话浏览器会拿**同一个已作废的票据**自己重连。
      try { es.close() } catch { /* 已关 */ }
      if (source === es) source = null
      status(opens > 0 ? 'reconnecting' : 'closed')
      scheduleRetry()
    }
    es.onmessage = (message) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!isHubAuditEvent(parsed)) return
      if (scope !== undefined && parsed.scope !== scope) return
      if (parsed.seq <= lastSeq) return
      lastSeq = parsed.seq
      writeHubCursor(storage, key, lastSeq)
      try { onEvent(parsed) } catch { /* one consumer must not kill the shared stream */ }
    }
  }

  void connect()
  return () => {
    closed = true
    if (timer !== null) { clearTimeout(timer); timer = null }
    try { source?.close() } catch { /* 已关 */ }
    source = null
  }
}
