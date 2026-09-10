import type { HubAuditEvent } from './types'

export type CursorStorage = Pick<Storage, 'getItem' | 'setItem'>

export type HubEventStreamOptions = {
  scope?: string
  storage?: CursorStorage
  token?: string
  EventSourceCtor?: typeof EventSource
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
  options: { scope?: string; sinceSeq?: number | null; token?: string } = {},
): string {
  const hashIndex = base.indexOf('#')
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? base.slice(0, hashIndex) : base
  const queryIndex = withoutHash.indexOf('?')
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '')
  if (options.scope !== undefined) params.set('scope', options.scope)
  if (options.sinceSeq !== undefined && options.sinceSeq !== null) params.set('sinceSeq', String(options.sinceSeq))
  if (options.token) params.set('token', options.token)
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
  const url = buildHubEventSourceUrl(base, {
    scope,
    sinceSeq: lastSeq >= 0 ? lastSeq : null,
    token: options.token,
  })
  const EventSourceCtor = options.EventSourceCtor ?? globalThis.EventSource
  const source = new EventSourceCtor(url)
  source.onmessage = (message) => {
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
  return () => source.close()
}
