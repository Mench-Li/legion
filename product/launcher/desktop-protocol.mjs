export const DESKTOP_PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 64 * 1024
const TYPES = new Set(['start', 'status', 'stop', 'detach', 'restart', 'prepare-runtime', 'configure-workspace', 'configure-identity', 'configure-model'])

export function protocolError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function parseRequest(line) {
  let value
  try { value = JSON.parse(line) } catch { throw protocolError('BAD_JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw protocolError('BAD_REQUEST')
  if (value.version !== DESKTOP_PROTOCOL_VERSION) throw protocolError('BAD_VERSION')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) throw protocolError('BAD_ID')
  if (!TYPES.has(value.type)) throw protocolError('UNKNOWN_TYPE')
  if (value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw protocolError('BAD_PAYLOAD')
  return value
}

export function createLineDecoder(onLine, { maxBytes = MAX_LINE_BYTES } = {}) {
  let pending = Buffer.alloc(0)
  let dropping = false
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let from = 0
      while (from < bytes.length) {
        const newline = bytes.indexOf(10, from)
        const end = newline < 0 ? bytes.length : newline
        const piece = bytes.subarray(from, end)
        if (!dropping) {
          if (pending.length + piece.length > maxBytes) {
            pending = Buffer.alloc(0)
            dropping = true
            onLine({ code: 'LINE_TOO_LARGE' })
          } else {
            pending = Buffer.concat([pending, piece])
          }
        }
        if (newline >= 0) {
          if (!dropping) onLine(pending.toString('utf8').replace(/\r$/, ''))
          pending = Buffer.alloc(0)
          dropping = false
        }
        from = end + (newline >= 0 ? 1 : 0)
      }
    },
  }
}
