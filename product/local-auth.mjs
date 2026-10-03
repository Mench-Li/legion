import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto'

// A browser opened directly by the local user can share the desktop backend.
// Cross-site navigation cannot establish a session; API calls cannot mint one.
export function createLocalBrowserAuth(token, { now = Date.now, lifetimeMs = 12 * 60 * 60 * 1000 } = {}) {
  const sign = value => createHmac('sha256', token).update(value).digest('hex')
  const equal = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  return (req, res, { document = false } = {}) => {
    if (checkDesktopRequest(req, token, { requireToken: false })) return false
    const name = `legion_session_${req.socket.localPort}`
    const cookie = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1)
    if (cookie) {
      const parts = /^(\d+)\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(cookie)
      if (parts && Number(parts[1]) > now() && Number(parts[1]) <= now() + lifetimeMs
        && equal(sign(`${parts[1]}.${parts[2]}`), parts[3])) {
        req.headers.authorization = `Bearer ${token}`
        return true
      }
    }
    if (document && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document'
      && ['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) {
      const value = `${now() + lifetimeMs}.${randomBytes(16).toString('hex')}`
      res.setHeader('Set-Cookie', `${name}=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(lifetimeMs / 1000)}`)
      res.setHeader('Cache-Control', 'no-store')
    }
    return false
  }
}

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
