// team-hub/identity-rate-limit-noproxy.test.mjs
// ============================================================================
// **没配可信代理时，按来源限速必须不启用**（而不是把所有人算成同一个键）。
//
// 单独成文件的原因：可信代理表在 `import server.mjs` **那一刻**读进配置，
// 而 ESM 的模块缓存让同一个进程里换不掉它。
//
// ## 这条判据守的是一个**反向**的错
//
// 大多数限速用例守的是"该挡的挡住了"。这一条守的是"**不该挡的别挡**"。
//
// 部署形态是"Hub 绑回环 + 反代"（`server.mjs` 默认 `127.0.0.1`）。如果没配
// `LEGION_TRUSTED_PROXIES`，推出来的来源**恒为 127.0.0.1** —— 于是按来源限速
// 会变成"所有访客共用一个配额"：
//
//   > 那样一个限速不但防不住攻击者，还把"被攻击"升级成"所有人都登不上"。
//   > 攻击者只要失败几次，就能把你的全部用户挡在门外 —— 而他是免费的。
//
// 所以正确的行为是**如实报成不生效并跳过它**，把这个取舍写成一行可读的输出。
// 这与注册闸门的方向**相反**（那里全局计数是对的）：注册限的是"新建资源"，
// 被耗尽的代价远小于"登录被误锁"。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-ratelimit-noproxy-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
/** ★ 上限开到 2：如果这层被错误地启用了，第二次之后的请求就会 429。 */
const MAX = 2
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  process.env.LEGION_REGISTRATION = 'invite'
  process.env.LEGION_RATE_LIMIT_LOGIN = String(MAX)
  process.env.LEGION_RATE_LIMIT_REGISTER = String(MAX)
  process.env.LEGION_RATE_LIMIT_PASSWORD_RESET = String(MAX)
  // ★ 关键：**留空**。
  delete process.env.LEGION_TRUSTED_PROXIES
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
  mod.db.prepare("INSERT OR IGNORE INTO spaces (id, name) VALUES ('default', '默认空间')").run()
})

after(() => {
  try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, { body, token, from } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (from !== undefined) headers['x-forwarded-for'] = from
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
// ⚠️ 用这两个包一层，别直接调 `call`：`call` 的第三个参数是 **options**，
//    而把 body 直接当 options 传进去会变成"没有 body" —— 服务端回
//    `用户名必填`（400），看起来像限速判据失败，其实是调用写错了。
//    我已经这样写错过一次。
const get = (p, o) => call('GET', p, o)
const post = (p, b, o) => call('POST', p, { body: b, ...o })

describe('没配可信代理 → 按来源限速不启用（HTTP）', () => {
  it('★★★ 谎报的 `X-Forwarded-For` 一律被忽略，且不会限住任何人', async () => {
    // 每个请求都换一个**假的**来源。若实现信了 XFF，这些会被当成不同来源，
    // 于是"限速生效但被绕过"；若实现把回环当唯一来源，那么第 3 次就该 429。
    // 两种都不对 —— 正确的行为是**不加这一层限速**。
    const codes = []
    for (let i = 0; i < MAX + 5; i += 1) {
      const r = await post('/api/identity/login', {
        name: 'nobody-' + i, password: 'wrong-password',
      }, { from: `198.51.100.${100 + i}` })
      codes.push(r.status)
    }
    assert.equal(codes.includes(429), false,
      `没配可信代理时必须**不启用**这层：否则所有访客共用一个配额，`
      + `攻击者失败几次就能把全部用户挡在门外。实际状态码序列：${codes.join(',')}`)
    // 而且它们应当是普通的"凭据不对"。
    assert.equal(codes.every((c) => c === 401), true, `期望全是 401，实际 ${codes.join(',')}`)
  })

  it('★★ 诊断端点如实报出"这一层不生效"，并说明原因', async () => {
    const r = await get('/api/identity/rate-limits', { token: HUB_TOKEN, from: '198.51.100.200' })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    const report = r.json.rateLimit
    // ★ 原因码必须能区分"没配"与"对端不可信"——它们要的运维动作不同。
    assert.equal(report.reason, 'no-trusted-proxy',
      `没配可信代理时必须报 'no-trusted-proxy'，实际 '${report.reason}'`)
    assert.equal(report.effective, false, '必须如实报成不生效')
    assert.equal(report.trustedProxyRules, 0, '可信规则数应当是 0')
    assert.equal(report.loopbackOrPrivate, true, '推出来的来源是回环 → 标成"不可用"')
    // 上限仍然报出来（它们是**配置**，不是生效状态）——两者必须分开读，
    // 否则运维会看着"上限 30"以为已经防住了。
    assert.equal(report.max.login, MAX, '上限是配置值，照实报')
  })

  it('★ 已鉴权的读面照常（不生效的那一层不该有任何副作用）', async () => {
    const boot = await post('/api/identity/bootstrap', {
      name: 'owner', password: 'owner-password-1',
    }, { token: HUB_TOKEN })
    assert.ok([200, 409].includes(boot.status), `bootstrap 意外：${boot.status} ${boot.text.slice(0, 160)}`)
    const login = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1' })
    assert.equal(login.status, 200, login.text.slice(0, 200))
    const me = await get('/api/identity/me', { token: login.json.accessToken })
    assert.equal(me.status, 200)
    assert.equal(me.json.user.name, 'owner')
  })
})
