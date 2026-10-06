export interface ProtocolFailure { ok: false, code: string, message: string }
export type Direction = 'node' | 'hub' | 'both'
export declare const PROTOCOL_VERSION: 1
export declare const PROTOCOL_MIN_VERSION: 1
export declare const PROTOCOL_MAX_VERSION: 1
export declare const PROTOCOL_NAME: 'legion-node-v1'
export declare const NODE_PATH: '/node'
export declare const MAX_FRAME_BYTES: number
export declare const LIMITS: Readonly<Record<string, number>>
export declare const FRAME_TYPES: Readonly<Record<string, string>>
export declare const TERMINAL_OUTCOMES: Readonly<['completed', 'failed', 'outcome_unknown', 'cancelled']>
export declare const PROGRESS_KINDS: Readonly<string[]>
export declare const PROTOCOL_CODES: Readonly<Record<string, string>>
export declare const SEQ_OUTCOMES: Readonly<{ ACCEPTED: 'accepted', DUPLICATE: 'duplicate' }>
export declare const DEFAULT_SEEN_WINDOW: number
export function isFrameType(type: unknown): boolean
export function directionOf(type: unknown): Direction | null
export function negotiateVersion(opts?: {
  offered: unknown, min?: number, max?: number,
}): ProtocolFailure | { ok: true, version: number }
export function validateFrame(input: unknown, opts?: {
  role?: 'hub' | 'node' | null, version?: number | null,
}): ProtocolFailure | { ok: true, frame: Record<string, unknown> }
export function createSequenceTracker(opts?: { lastSeq?: number, window?: number }): {
  readonly lastSeq: number
  readonly size: number
  observe(input: { eventId?: unknown, seq?: unknown }): ProtocolFailure | { ok: true, outcome: 'accepted' | 'duplicate', seq: number }
}
export function buildFrame(
  type: string,
  fields: Record<string, unknown> & { requestId: string },
  opts?: { now?: () => number },
): Record<string, unknown>
export function requestIdFor(prefix?: string, random?: (n: number) => Uint8Array): string
export function setRequestRandomSource(fn: ((n: number) => Uint8Array) | null): void
