export interface WsFrameError { code: string, message: string, closeCode: number }
export interface WsDecodedFrame {
  fin: boolean
  opcode: number
  masked: boolean
  payload: Buffer
  consumed: number
  error?: WsFrameError
}
export interface WsMessage {
  opcode: number
  payload: Buffer
  text?: string
  close?: { code: number | null, reason: string, invalid?: boolean }
  error?: WsFrameError
}
export declare const WS_GUID: string
export declare const WS_VERSION: '13'
export declare const WS_OPCODE: Readonly<{ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }>
export declare const DEFAULT_MAX_MESSAGE_BYTES: number
export declare const CONTROL_FRAME_MAX_BYTES: 125
export declare const WS_CLOSE: Readonly<{
  NORMAL: 1000, PROTOCOL_ERROR: 1002, UNSUPPORTED_DATA: 1003,
  INVALID_PAYLOAD: 1007, POLICY_VIOLATION: 1008, MESSAGE_TOO_BIG: 1009,
}>
export function acceptKey(key: string): string
export function constantTimeEqual(a: unknown, b: unknown): boolean
export function validateUpgradeRequest(req: { headers?: unknown }): { status: number, code: string, reason: string, headers?: Record<string, string> } | null
export function buildHandshakeResponse(key: string, opts?: { protocol?: string | null }): string
export function buildHandshakeFailure(status: number, reason?: string): string
export function buildHandshakeRequest(opts: {
  path?: string, host: string, key: string, protocol?: string | null, extraHeaders?: Record<string, string>,
}): string
export function randomKey(random?: (n: number) => Uint8Array): string
export function setRandomBytesSource(fn: ((n: number) => Uint8Array) | null): void
export function parseHandshakeResponse(head: string, expectedKey?: string | null): {
  ok: boolean, code?: string, message?: string, status?: number,
  protocol?: string | null, headers?: Record<string, string>, rest?: string,
}
export function encodeFrame(
  opcode: number,
  payload?: Buffer | string,
  opts?: { mask?: boolean, fin?: boolean, maskKey?: Buffer | null, random?: ((n: number) => Uint8Array) | null },
): Buffer
export function encodeText(text: string, opts?: Parameters<typeof encodeFrame>[2]): Buffer
export function encodeClose(code?: number | null, reason?: string, opts?: Parameters<typeof encodeFrame>[2]): Buffer
export function parseFrame(
  buf: Buffer,
  opts?: { maxBytes?: number, expectMasked?: boolean | null },
): WsDecodedFrame | null
export function createFrameDecoder(opts?: {
  maxBytes?: number, expectMasked?: boolean | null,
}): {
  readonly bufferedBytes: number
  readonly error: WsFrameError | null
  push(chunk: Buffer): { messages: WsMessage[], error: WsFrameError | null }
}
export function parseClosePayload(payload: Buffer | string): { code: number | null, reason: string, invalid?: boolean }
