import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalBrowserAuth, checkDesktopRequest } from './local-auth.mjs'

const token = 'c'.repeat(64)
const request = (headers = {}) => ({ method: 'GET', socket: { localPort: 5173 }, headers: { host: '127.0.0.1:5173', ...headers } })
test('direct local navigation grants an HttpOnly session accepted for browser API writes', () => {
  const auth = createLocalBrowserAuth(token, { now: () => 1000 })
  const headers = {}
  auth(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }),
    { setHeader: (k, v) => headers[k] = v }, { document: true })
  assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Strict/)
  assert.doesNotMatch(headers['Set-Cookie'], new RegExp(token))
  const req = request({ cookie: headers['Set-Cookie'].split(';')[0] })
  assert.equal(auth(req, {}), true)
  assert.equal(checkDesktopRequest(req, token), null)
})

test('cross-site navigation, API requests, forged cookies and foreign origins cannot authenticate', () => {
  const auth = createLocalBrowserAuth(token)
  const res = { setHeader() { throw new Error('must not set a session') } }
  for (const headers of [
    { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' },
    { cookie: `legion_session_5173=${Date.now() + 1000}.${'a'.repeat(32)}.${'b'.repeat(64)}` },
    { origin: 'https://evil.test', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
    { host: 'evil.test:5173', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
  ]) {
    const req = request(headers)
    assert.equal(auth(req, res, { document: true }), false)
    assert.notEqual(checkDesktopRequest(req, token), null)
  }
  auth(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }), res)
})

test('expired session and a previous backend credential cannot authenticate', () => {
  let time = 1000
  const auth = createLocalBrowserAuth(token, { now: () => time, lifetimeMs: 1000 })
  let cookie
  auth(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' }),
    { setHeader: (k, v) => { if (k === 'Set-Cookie') cookie = v.split(';')[0] } }, { document: true })
  assert.equal(createLocalBrowserAuth('d'.repeat(64), { now: () => time })(request({ cookie }), {}), false)
  time = 2001
  assert.equal(auth(request({ cookie }), {}), false)
})
