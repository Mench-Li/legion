// team-hub/identity-rate-limit.test.mjs
// ============================================================================
// 按来源限速的**端到端**判据（真 HTTP、真 SQLite、真配置）。
//
// 纯决策的窗口边界由 `rate-limit.test.mjs` 钉住、来源推导由 `client-ip.test.mjs`
// 钉住；这一族问的是另一件事：**接线对不对**。
//
//   > 一个"算法正确但没接上"的限速，与一个完全不限速的端点，
//   > 在攻击者面前是同一个东西 —— 只不过前者有一整套绿色的单元判据。
//
// 所以这里会**真的打 HTTP**，并只从状态码、响应头与库里读结论。
//
// ## 为什么"没配可信代理"那一条单独成文件
//
// 上限与可信代理表在 `import server.mjs` **那一刻**读进配置，而 ESM 的模块
// 缓存让同一个进程里换不掉它们。所以那条必须有自己的文件（自己的进程）——
// 与 `identity-registration-limit.test.mjs` 里"上限必须在一个自己的进程里设成小值"
// 是同一个理由。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-ratelimit-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
/** ★ 三个上限都开到 3：够验"过了线就拒"，又不用在用例里循环几十次。 */
const MAX = 3
/** ★ 直连回环 = 可信代理，所以用例可以用 XFF 模拟不同来源。 */
const TRUSTED = '127.0.0.1/32,::1/128'
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
  process.env.LEGION_TRUSTED_PROXIES = TRUSTED
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

/** 打一个请求。`from` 会写进 `X-Forwarded-For`（对端是回环 = 可信，所以会被采信）。 */
async function call(method, path, { body, token, from } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (from !== undefined) headers['x-forwarded-for'] = from
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text, retryAfter: res.headers.get('retry-after') }
}
const get = (p, o) => call('GET', p, o)
const post = (p, b, o) => call('POST', p, { body: b, ...o })

/** 把一个来源的登录配额打满。 */
async function exhaustLogin(from) {
  for (let i = 0; i < MAX; i += 1) {
    await post('/api/identity/login', { name: 'filler-' + i, password: 'wrong-password' }, { from })
  }
}

describe('按来源限速（HTTP 端到端）', () => {
  it('★★★ 打满上限之后 429，带 `Retry-After`，且说清是**来源**限速', async () => {
    const from = '198.51.100.11'
    for (let i = 0; i < MAX; i += 1) {
      const r = await post('/api/identity/login', { name: 'filler-' + i, password: 'wrong-password' }, { from })
      assert.notEqual(r.status, 429, `第 ${i + 1} 次不该被限（上限 ${MAX}）：${r.text.slice(0, 120)}`)
    }
    const over = await post('/api/identity/login', { name: 'filler-x', password: 'wrong-password' }, { from })
    assert.equal(over.status, 429, over.text.slice(0, 200))
    assert.equal(over.json.code, 'IDENTITY_RATE_LIMITED', '要用具名错误码：前端按**类型**分支，不按文案匹配')
    // ★ `Retry-After` 是 HTTP 语义的一部分；缺了它客户端只能自己猜一个间隔重试。
    assert.notEqual(over.retryAfter, null, '必须带 Retry-After 头')
    assert.ok(Number(over.retryAfter) >= 1, `Retry-After 至少 1 秒，实际 ${over.retryAfter}`)
    // ★ 说清"是来源限速，不是账号被封" —— 否则用户会去改密码、去问管理员
    //   "我账号是不是被封了"，而其实换一个网络就好了。
    assert.match(over.json.error, /来源/, '必须点明是来源级别')
    assert.match(over.json.error, /不是账号被封/)
    assert.match(over.json.error, /换一个网络/, '要给出可操作的出路')
  })

  it('★★★ 限速按来源隔离：另一个来源不受连坐', async () => {
    const victim = '198.51.100.21'
    await exhaustLogin(victim)
    const blocked = await post('/api/identity/login', { name: 'x', password: 'wrong-password' }, { from: victim })
    assert.equal(blocked.status, 429)
    // 另一个来源必须照常 —— 这条同时证明"没有把所有人算成同一个键"。
    const other = await post('/api/identity/login', { name: 'x', password: 'wrong-password' }, { from: '203.0.113.55' })
    assert.equal(other.status, 401, `另一个来源应当照常拿到 401（凭据不对），实际 ${other.status}`)
    assert.equal(other.json.code, 'IDENTITY_INVALID_CREDENTIALS')
  })

  it('★★★ 成功的登录也消耗配额（否则有账号的攻击者能刷回配额）', async () => {
    // 先建一个真账号（bootstrap 那条路要机器令牌）。
    const boot = await post('/api/identity/bootstrap', {
      name: 'owner', password: 'owner-password-1',
    }, { token: HUB_TOKEN, from: '203.0.113.90' })
    assert.ok([200, 409].includes(boot.status), `bootstrap 状态码意外：${boot.status} ${boot.text.slice(0, 160)}`)

    const from = '198.51.100.31'
    // 用**成功**的登录打满配额。
    for (let i = 0; i < MAX; i += 1) {
      const r = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1' }, { from })
      assert.equal(r.status, 200, `第 ${i + 1} 次成功登录应当通过：${r.text.slice(0, 160)}`)
    }
    const over = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1' }, { from })
    assert.equal(over.status, 429,
      '成功的登录也必须消耗配额 —— 一个"成功即清零"的来源限速，对已经有一个有效账号的攻击者完全无效')
  })

  it('★★★ 限速消息**不泄露**用户名是否存在（两种用户名同一句话）', async () => {
    const from = '198.51.100.61'
    await exhaustLogin(from)
    const existing = await post('/api/identity/login', { name: 'owner', password: 'z' }, { from })
    const missing = await post('/api/identity/login', { name: 'definitely-not-a-user-xyz', password: 'z' }, { from })
    assert.equal(existing.status, 429)
    assert.equal(missing.status, 429)
    // 把数字都抹掉（等待秒数随最早那条过期时间而变，与用户名无关）后必须逐字相同。
    const strip = (s) => String(s ?? '').replace(/\d+/g, '#')
    assert.equal(strip(existing.json.error), strip(missing.json.error),
      '两种情况必须得到同一句话 —— 否则这个端点成了用户名探测接口，那比限速本身更值钱')
  })

  it('★★ 注册也按来源限速（挡高速试探邀请码）', async () => {
    const from = '198.51.100.41'
    let hit = false
    for (let i = 0; i < MAX + 3; i += 1) {
      const r = await post('/api/identity/register', {
        name: 'reg' + i, password: 'good-password-1', code: 'WRONGCODE',
      }, { from })
      if (r.status === 429) { hit = true; assert.equal(r.json.code, 'IDENTITY_RATE_LIMITED'); break }
    }
    assert.equal(hit, true, '注册尝试打满之后必须出现 429')
    // 而且**没有**建出账号。
    assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM hub_users WHERE name_key LIKE '%reg0%'").get().n, 0,
      '被限的注册不许留下账号')
  })

  it('★★ 口令重置也按来源限速（重置码是短字符串，这一层挡的是枚举）', async () => {
    const from = '198.51.100.51'
    let hit = false
    for (let i = 0; i < MAX + 3; i += 1) {
      const r = await post('/api/identity/password/reset', {
        name: 'owner', code: 'GUESS' + i, newPassword: 'good-password-2',
      }, { from })
      if (r.status === 429) { hit = true; assert.equal(r.json.code, 'IDENTITY_RATE_LIMITED'); break }
    }
    assert.equal(hit, true, '口令重置尝试打满之后必须出现 429')
  })

  it('★★★ 限速**不**影响已登录的读面（限速挡的是尝试，不是使用者）', async () => {
    // 一条把限额加在整个身份族上的实现，会把管理员自己也挡在门外 ——
    // 而那把"被攻击"变成了"自己也进不去"。
    // 这里用一个已经被打满的来源发一个**已鉴权**的请求：必须照常。
    const from = '198.51.100.71'
    await exhaustLogin(from)
    const login = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1' }, { from })
    assert.equal(login.status, 429, '这个来源确实已经被限了（对照）')
    // 换一个来源登录拿到令牌，再用**已被限的来源**发鉴权请求。
    const ok = await post('/api/identity/login', { name: 'owner', password: 'owner-password-1' }, { from: '203.0.113.77' })
    assert.equal(ok.status, 200)
    const token = ok.json.accessToken
    const me = await get('/api/identity/me', { token, from })
    assert.equal(me.status, 200, '已鉴权的读面不该被来源限速挡住')
    assert.equal(me.json.user.name, 'owner')
  })

  it('★★★ 诊断端点要求凭据，且如实报出"这一层生效中"', async () => {
    // 匿名：必须 401。**刻意不放在公开名单里** —— 一个匿名可读的
    // "我有没有在限速"等于告诉攻击者该不该放手打。
    const anon = await get('/api/identity/rate-limits', { from: '203.0.113.99' })
    assert.equal(anon.status, 401, `匿名读限速状态必须被拒，实际 ${anon.status}`)
    assert.equal(anon.json?.rateLimit, undefined, '被拒时不许带任何读数')

    // 机器令牌：必须 200，且报出 `effective: true` 与三个上限。
    const mine = await get('/api/identity/rate-limits', { token: HUB_TOKEN, from: '203.0.113.99' })
    assert.equal(mine.status, 200, mine.text.slice(0, 200))
    const r = mine.json.rateLimit
    assert.equal(r.reason, 'forwarded', '对端可信且有 XFF → 应当是从链里取到的来源')
    assert.equal(r.effective, true, '配了可信代理 → 这一层必须报成生效')
    assert.equal(r.max.login, MAX)
    assert.equal(r.max.register, MAX)
    assert.equal(r.max['password-reset'], MAX)
    assert.equal(r.trustedProxyRules, 2, '两条可信规则（127.0.0.1/32 与 ::1/128）')
    assert.deepEqual(r.trustedProxiesInvalid, [], '配置里不该有非法项')
    // ★ 不许回显任何地址（这个端点本身不能变成信息泄露）。
    const flat = JSON.stringify(mine.json)
    for (const forbidden of ['198.51.100', '203.0.113', '127.0.0.1']) {
      assert.equal(flat.includes(forbidden), false, `诊断响应里不该出现地址 ${forbidden}`)
    }
  })
})
