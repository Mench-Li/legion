import { timingSafeEqual } from 'node:crypto'

export function checkDesktopRequest(req, token, { requireToken = true } = {}) {
  const expectedHost = `127.0.0.1:${req.socket.localPort}`
  if (req.headers.host !== expectedHost) return { status: 403, code: 'DESKTOP_HOST_FORBIDDEN' }
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${expectedHost}`) return { status: 403, code: 'DESKTOP_ORIGIN_FORBIDDEN' }
  if (!requireToken) return null
  const given = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''
  const want = Buffer.from(token)
  const actual = Buffer.from(given)
  if (!want.length || actual.length !== want.length || !timingSafeEqual(actual, want)) return { status: 401, code: 'DESKTOP_UNAUTHORIZED' }
  return null
}
