// workbench/scripts/account-profile.test.mjs
// ============================================================================
// 账号管理（P0）—— 前端纯函数与身份 API：
//   · 显示名校验与服务端 parity；
//   · 账号摘要的会话/设备计数口径；
//   · 401 单飞重放（只重放一次、只在 TOKEN_EXPIRED/TOKEN_MISSING、不吞 WRONG_PASSWORD）；
//   · fetchMe 的旧 Hub 回退、updateProfile 的请求形状。
//
// 对应用例：docs/G-mvt9or0l-1/TEST_CASES.md §4.3（TC-S3-*）
// 零新增依赖：typescript 已在 workbench devDependencies；用 ts.transpileModule
// 直跑 TS 源码（与 external-avatar-parity.test.mjs 同一范式）。
// ============================================================================
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import { validateDisplayName as serverValidateDisplayName } from '../../team-hub/user-store.mjs'

function loadTs(relPath) {
  const src = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  // 每次用不同的 data URL（hash）拿到**新的**模块实例：identity.ts 有模块级单飞状态。
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}#${Math.random().toString(36).slice(2)}`)
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/** 安装 browser 存储与 window.location；返回可断言的存储。 */
function installEnv({ access = '', refresh = '' } = {}) {
  const session = makeStorage(access.length > 0 ? { 'legion.identity.access': access } : {})
  const local = makeStorage(refresh.length > 0 ? { 'legion.identity.refresh': refresh } : {})
  globalThis.sessionStorage = session
  globalThis.localStorage = local
  globalThis.window = { location: { search: '' } }
  return { session, local }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

const authOf = (init) => init?.headers?.authorization ?? ''

describe('账号纯函数与身份 API（S3）', () => {
  it('TC-S3-01 合法显示名返回 trim 后的值', async () => {
    const { validateDisplayName } = await loadTs('../src/accountProfile.ts')
    assert.deepEqual(validateDisplayName('Alice'), { ok: true, value: 'Alice' })
    assert.deepEqual(validateDisplayName('  Alice  '), { ok: true, value: 'Alice' })
  })

  it('TC-S3-02 1 与 64 字符通过', async () => {
    const { validateDisplayName } = await loadTs('../src/accountProfile.ts')
    assert.deepEqual(validateDisplayName('A'), { ok: true, value: 'A' })
    const v = 'A'.repeat(64)
    assert.deepEqual(validateDisplayName(v), { ok: true, value: v })
  })

  it('TC-S3-03 65 字符 / 33 emoji 被拒；32 emoji / 64 汉字通过', async () => {
    const { validateDisplayName } = await loadTs('../src/accountProfile.ts')
    assert.equal(validateDisplayName('A'.repeat(65)).ok, false)
    assert.equal(validateDisplayName('😀'.repeat(33)).ok, false)
    assert.equal(validateDisplayName('😀'.repeat(32)).ok, true)
    assert.equal(validateDisplayName('汉'.repeat(64)).ok, true)
  })

  it('TC-S3-04 空/空白/控制字符/换行/非字符串 → 可读中文拒绝', async () => {
    const { validateDisplayName } = await loadTs('../src/accountProfile.ts')
    for (const v of ['', '   ', `Ali${String.fromCharCode(0)}ce`, `Ali${String.fromCharCode(10)}ce`, `Ali${String.fromCharCode(127)}ce`, 42, null, undefined, {}, []]) {
      const r = validateDisplayName(v)
      assert.equal(r.ok, false, JSON.stringify(v))
      assert.equal(typeof r.message, 'string')
      assert.ok(r.message.length > 0)
    }
  })

  it('TC-S3-05 与服务端同一批输入同结论（parity）', async () => {
    const { validateDisplayName } = await loadTs('../src/accountProfile.ts')
    const serverOk = (v) => {
      try { serverValidateDisplayName(v); return true } catch { return false }
    }
    const inputs = [
      'Alice', '  Alice  ', 'A', 'A'.repeat(64), 'A'.repeat(65),
      '', '   ', '\t\t', 'Ali\nce', 'Ali\rce', '<img onerror=alert(1)>',
      '😀'.repeat(32), '😀'.repeat(33),
      null, undefined, 42, true, {}, [],
    ]
    for (const v of inputs) {
      assert.equal(validateDisplayName(v).ok, serverOk(v), JSON.stringify(v))
    }
  })

  it('TC-S3-06 旧 /me（缺 displayName/avatar）回退用户名且不抛错', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'token-old-hub' })
    globalThis.fetch = async () => json(200, { ok: true, user: { userId: 'u1', name: '小兵' }, roles: [], systemRole: 'none' })
    const me = await mod.fetchMe()
    assert.equal(me.displayName, '小兵')
    assert.equal(me.avatar, '')
    assert.equal(me.userId, 'u1')
  })

  it('TC-S3-07 新字段原样透传；roles/systemRole 缺省为 []/none', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'token' })
    const user = { userId: 'u1', name: '小兵', displayName: 'Alice', avatar: '', createdAt: '2026-10-29T08:00:00.000Z', disabled: false }
    globalThis.fetch = async () => json(200, { ok: true, user })
    const me = await mod.fetchMe()
    assert.equal(me.displayName, 'Alice')
    assert.equal(me.createdAt, '2026-10-29T08:00:00.000Z')
    assert.equal(me.disabled, false)
    assert.deepEqual(me.roles, [])
    assert.equal(me.systemRole, 'none')
  })

  it('TC-S3-08 updateProfile 请求形状：POST /api/identity/profile、体只含 displayName、带用户令牌', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'token-x' })
    let captured = null
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), method: init.method, body: JSON.parse(init.body), auth: authOf(init) }
      return json(200, { ok: true, user: { userId: 'u1', name: '小兵', displayName: 'Alice', avatar: '', createdAt: '2026-10-29T08:00:00.000Z', disabled: false } })
    }
    const u = await mod.updateProfile({ displayName: 'Alice' })
    assert.equal(u.displayName, 'Alice')
    assert.ok(captured.url.endsWith('/api/identity/profile'))
    assert.equal(captured.method, 'POST')
    assert.deepEqual(captured.body, { displayName: 'Alice' })
    assert.equal(captured.auth, 'Bearer token-x')
  })

  it('TC-S3-09 400 IDENTITY_INVALID_INPUT → IdentityRequestError 带 code/status', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'token' })
    globalThis.fetch = async () => json(400, { ok: false, code: 'IDENTITY_INVALID_INPUT', error: '显示名不能为空' })
    await assert.rejects(mod.updateProfile({ displayName: '' }), (e) => {
      assert.ok(e instanceof mod.IdentityRequestError)
      assert.equal(e.code, 'IDENTITY_INVALID_INPUT')
      assert.equal(e.status, 400)
      return true
    })
  })

  it('TC-S3-10 活跃会话数排除 revoked', async () => {
    const { accountSummary } = await loadTs('../src/accountProfile.ts')
    const sessions = { rows: [
      { sessionId: 's1', revoked: false }, { sessionId: 's2', revoked: false },
      { sessionId: 's3', revoked: true }, { sessionId: 's4', revoked: true },
    ], currentId: 's1' }
    const s = accountSummary({ userId: 'u1' }, sessions, [])
    assert.equal(s.activeSessionCount, 2)
    assert.equal(s.currentSession?.sessionId, 's1')
  })

  it('TC-S3-11 未撤销但刷新凭据已过期仍计入活跃（过期是 P1 展示态）', async () => {
    const { accountSummary } = await loadTs('../src/accountProfile.ts')
    const rows = [{ sessionId: 's1', revoked: false, refreshExpiresAt: '2000-01-01T00:00:00.000Z' }]
    assert.equal(accountSummary({ userId: 'u1' }, { rows }, []).activeSessionCount, 1)
  })

  it('TC-S3-12 执行设备数排除 revoked 且按 userId 过滤', async () => {
    const { accountSummary } = await loadTs('../src/accountProfile.ts')
    const devices = [
      { nodeId: 'd1', userId: 'u1', revoked: false }, { nodeId: 'd2', userId: 'u1', revoked: false },
      { nodeId: 'd3', userId: 'u1', revoked: true },
      { nodeId: 'd4', userId: 'u2', revoked: false }, { nodeId: 'd5', userId: 'u2', revoked: false }, { nodeId: 'd6', userId: 'u2', revoked: false },
    ]
    assert.equal(accountSummary({ userId: 'u1' }, { rows: [] }, devices).deviceCount, 2)
  })

  it('TC-S3-13 管理员看到全是他人设备 → 0（不得用 length 冒充）', async () => {
    const { accountSummary } = await loadTs('../src/accountProfile.ts')
    const devices = [{ nodeId: 'd1', userId: 'u2', revoked: false }, { nodeId: 'd2', userId: 'u3', revoked: false }]
    assert.equal(accountSummary({ userId: 'admin-1' }, { rows: [] }, devices).deviceCount, 0)
  })

  it('TC-S3-14 会话读取失败（null）不影响设备计数，也不抛错', async () => {
    const { accountSummary } = await loadTs('../src/accountProfile.ts')
    const devices = [{ nodeId: 'd1', userId: 'u1', revoked: false }]
    const s = accountSummary({ userId: 'u1' }, null, devices)
    assert.equal(s.activeSessionCount, 0)
    assert.equal(s.deviceCount, 1)
  })

  it('TC-S3-15 formatCreatedAt：合法 ISO 本地文本；非法/缺失为「—」且不抛错', async () => {
    const { formatCreatedAt } = await loadTs('../src/accountProfile.ts')
    const text = formatCreatedAt('2026-10-29T08:00:00.000Z')
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0 && text !== '—')
    assert.equal(formatCreatedAt('not-a-date'), '—')
    assert.equal(formatCreatedAt(null), '—')
    assert.equal(formatCreatedAt(undefined), '—')
  })

  it('TC-S3-20 401 过期：刷新一次、重放一次、返回 200', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'old-token', refresh: 'refresh-1' })
    let meHits = 0
    let refreshHits = 0
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith('/api/identity/refresh')) {
        refreshHits += 1
        return json(200, { ok: true, accessToken: 'new-token', refreshToken: 'refresh-2' })
      }
      if (u.endsWith('/api/identity/me')) {
        meHits += 1
        if (authOf(init) === 'Bearer old-token') return json(401, { ok: false, code: 'IDENTITY_TOKEN_EXPIRED', error: '访问令牌已过期，请刷新' })
        return json(200, { ok: true, user: { userId: 'u1', name: '小兵', displayName: 'Alice', avatar: '', createdAt: '2026-10-29T08:00:00.000Z', disabled: false }, roles: [], systemRole: 'none' })
      }
      throw new Error(`unexpected url ${u}`)
    }
    const me = await mod.fetchMe()
    assert.equal(me.displayName, 'Alice')
    assert.equal(meHits, 2, '原请求重放恰好一次')
    assert.equal(refreshHits, 1, '刷新恰好一次')
    assert.equal(globalThis.localStorage.getItem('legion.identity.refresh'), 'refresh-2')
  })

  it('TC-S3-21 IDENTITY_WRONG_PASSWORD 不触发刷新，错误原样抛给 UI', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'token', refresh: 'refresh-1' })
    let refreshHits = 0
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.endsWith('/api/identity/refresh')) { refreshHits += 1; return json(200, { ok: true, accessToken: 'x', refreshToken: 'y' }) }
      if (u.endsWith('/api/identity/password')) return json(401, { ok: false, code: 'IDENTITY_WRONG_PASSWORD', error: '当前口令不正确' })
      throw new Error(`unexpected url ${u}`)
    }
    await assert.rejects(mod.changePassword('bad', 'new-password'), (e) => {
      assert.equal(e.code, 'IDENTITY_WRONG_PASSWORD')
      assert.equal(e.status, 401)
      return true
    })
    assert.equal(refreshHits, 0)
  })

  it('TC-S3-22 源码断言：重放包装显式排除 refresh/login，且不含 WRONG_PASSWORD', () => {
    const src = readFileSync(new URL('../src/identity.ts', import.meta.url), 'utf8')
    const body = /async function withSessionRetry[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    assert.ok(body.length > 0, '找不到 withSessionRetry')
    assert.match(body, /'\/api\/identity\/refresh'/)
    assert.match(body, /'\/api\/identity\/login'/)
    assert.match(src, /IDENTITY_TOKEN_EXPIRED/)
    assert.match(src, /IDENTITY_TOKEN_MISSING/)
    assert.doesNotMatch(body, /IDENTITY_WRONG_PASSWORD/)
    assert.match(body, /recoverSession\(\)/)
  })

  it('TC-S3-23 无刷新凭据时 401 原样返回、不发起刷新', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'old-token' }) // 没有 refresh
    let hits = 0
    globalThis.fetch = async (url) => {
      hits += 1
      assert.ok(String(url).endsWith('/api/identity/me'), '不应请求别的端点')
      return json(401, { ok: false, code: 'IDENTITY_TOKEN_EXPIRED', error: '过期' })
    }
    await assert.rejects(mod.fetchMe(), (e) => e.code === 'IDENTITY_TOKEN_EXPIRED')
    assert.equal(hits, 1)
  })

  it('TC-S3-24 10 路并发 401 只刷新 1 次（单飞），全部恢复成功', async () => {
    const mod = await loadTs('../src/identity.ts')
    installEnv({ access: 'old-token', refresh: 'refresh-1' })
    let refreshHits = 0
    globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.endsWith('/api/identity/refresh')) {
        refreshHits += 1
        await new Promise((r) => setTimeout(r, 5)) // 让 10 路都追上同一个 Promise
        return json(200, { ok: true, accessToken: 'new-token', refreshToken: 'refresh-2' })
      }
      if (authOf(init) === 'Bearer old-token') return json(401, { ok: false, code: 'IDENTITY_TOKEN_EXPIRED', error: '过期' })
      return json(200, { ok: true, user: { userId: 'u1', name: '小兵', displayName: 'Alice', avatar: '', createdAt: '2026-10-29T08:00:00.000Z', disabled: false }, roles: [], systemRole: 'none' })
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => mod.fetchMe()))
    assert.equal(results.length, 10)
    assert.ok(results.every((r) => r.displayName === 'Alice'))
    assert.equal(refreshHits, 1)
  })

  it('TC-S3-25 DeviceRow 含可选 userId（不影响既有字段）', () => {
    const src = readFileSync(new URL('../src/identity.ts', import.meta.url), 'utf8')
    const block = /export interface DeviceRow \{[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    assert.match(block, /userId\?: string/)
    assert.match(block, /nodeId: string/)
    assert.match(block, /revoked: boolean/)
  })
})
