// workbench/scripts/auth-recovery.test.mjs
// ---------------------------------------------------------------------------
// 「凭据过期」与「中枢不可达」必须分开处置（2026-10-30 现场：访问令牌过期后
// 页面把 401 当成中枢不可达，每 5 秒重连一次，在原地转了一整夜）。
//
// 这一组守三件事：
//   ① 判据：只有 401（或带 `IDENTITY_*` 码的 403）才算凭据问题，别的 403 不算；
//   ② 死令牌必须被清掉：没有刷新凭据时，留着那把过期的访问令牌会让之后每个请求
//      都拿同一个失效凭据再 401；
//   ③ 刷新失败也算"会话没了"：清干净 + 通知上层回登录页，**不能**留着半个会话。
//
// 运行：node --experimental-strip-types --test workbench/scripts/auth-recovery.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ── 浏览器存储替身：identity.ts 只用到 getItem / setItem / removeItem ──────────
function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    clear: () => map.clear(),
  }
}
globalThis.window = { location: { search: '', origin: 'http://127.0.0.1:5173' } }
globalThis.sessionStorage = memoryStorage()
globalThis.localStorage = memoryStorage()

const { isAuthFailure } = await import('../src/hub-errors.ts')
const identity = await import('../src/identity.ts')

const ACCESS = 'legion.identity.access'
const REFRESH = 'legion.identity.refresh'

function resetSession({ access = '', refresh = '' } = {}) {
  identity.clearSession()
  if (access) sessionStorage.setItem(ACCESS, access)
  if (refresh) localStorage.setItem(REFRESH, refresh)
}

test('① 判据：401 / IDENTITY_* 的 403 算凭据问题，其余不算', () => {
  assert.equal(isAuthFailure({ status: 401, code: 'IDENTITY_TOKEN_EXPIRED', message: '401：访问令牌已过期，请刷新' }), true)
  assert.equal(isAuthFailure({ status: 401, code: null, message: '401：unauthorized' }), true, '没有具名码的 401 仍是凭据问题')
  assert.equal(isAuthFailure({ status: 403, code: 'IDENTITY_SESSION_REVOKED', message: '403：会话已撤销' }), true)
  assert.equal(isAuthFailure({ status: 403, code: 'SPACE_FORBIDDEN', message: '403：无权访问该空间' }), false, '空间越权不是登录过期')
  assert.equal(isAuthFailure({ status: 500, code: 'INTERNAL', message: '500：内部错误' }), false)
  assert.equal(isAuthFailure(new Error('无法连接中枢 /hub（网络/代理错误）')), false, '网络错误不能被当成凭据过期')
})

test('② 没有刷新凭据时，死掉的访问令牌必须被清掉（否则每个请求继续 401）', async () => {
  resetSession({ access: 'expired-access-token' })
  let expiredCalls = 0
  identity.setSessionExpiredHandler(() => { expiredCalls += 1 })
  try {
    assert.equal(await identity.recoverSession(), false)
    assert.equal(identity.getAccessToken(), '', '失效的访问令牌必须清掉')
    assert.equal(expiredCalls, 1, '要通知上层回登录页')
  } finally {
    identity.setSessionExpiredHandler(null)
  }
})

test('③ 刷新失败 = 会话没了：清干净 + 通知登录门', async () => {
  resetSession({ access: 'expired-access-token', refresh: 'stale-refresh-token' })
  const realFetch = globalThis.fetch
  // 刷新凭据已被轮换掉：中枢回 401 TOKEN_REVOKED。
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: '刷新凭据已失效', code: 'IDENTITY_TOKEN_REVOKED' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })
  let expiredCalls = 0
  identity.setSessionExpiredHandler(() => { expiredCalls += 1 })
  try {
    assert.equal(await identity.recoverSession(), false)
    assert.equal(identity.getAccessToken(), '')
    assert.equal(identity.getRefreshToken(), '', '刷不动的刷新凭据也不该留着')
    assert.equal(expiredCalls, 1)
  } finally {
    globalThis.fetch = realFetch
    identity.setSessionExpiredHandler(null)
  }
})

test('④ 刷新成功：换成新令牌，不清会话、不打扰登录门', async () => {
  resetSession({ access: 'expired-access-token', refresh: 'good-refresh-token' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  let expiredCalls = 0
  identity.setSessionExpiredHandler(() => { expiredCalls += 1 })
  try {
    assert.equal(await identity.recoverSession(), true)
    assert.equal(identity.getAccessToken(), 'fresh-access')
    assert.equal(identity.getRefreshToken(), 'fresh-refresh')
    assert.equal(expiredCalls, 0)
  } finally {
    globalThis.fetch = realFetch
    identity.setSessionExpiredHandler(null)
  }
})
