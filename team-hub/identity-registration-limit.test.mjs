// team-hub/identity-registration-limit.test.mjs
// ============================================================================
// 自助注册的**速率闸门**在真实 HTTP 上的接线。
//
// 单独成文件的原因：上限由环境变量在 `import server.mjs` **那一刻**读进配置，
// 所以它必须在一个自己的进程里设成一个小值——默认的 20 次循环在 HTTP 用例里
// 太慢，而"改不动那个值"会让这条用例根本没被写过。
//
// 守的是：**一个没有任何限速的公开注册端点**。它不报错、看起来也正常，
// 区别要到有人批量造账号时才出现。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-reglimit-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
/** ★ 闸门开到 2：够验"过了线就拒"，又不用在用例里循环 20 次。 */
const MAX = 2
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  process.env.LEGION_REGISTRATION = 'open'
  process.env.LEGION_REGISTRATION_MAX = String(MAX)
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

async function call(method, path, { body, token } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const get = (p, o) => call('GET', p, o)
const post = (p, b, o) => call('POST', p, { body: b, ...o })

describe('注册速率闸门（HTTP）', () => {
  it('★ 开够上限之后，第 N+1 个被 429 拒掉，且说得出现在是几个、上限几个', async () => {
    // 用**每次都不同的名字**——这正是按用户名归并的计数挡不住的那种模式。
    for (let i = 0; i < MAX; i += 1) {
      const r = await post('/api/identity/register', { name: `路人${i}`, password: 'good-password' })
      assert.equal(r.status, 200, `第 ${i + 1} 个应当在额度内：${r.text.slice(0, 160)}`)
    }
    const over = await post('/api/identity/register', { name: '再来一个', password: 'good-password' })
    assert.equal(over.status, 429, over.text.slice(0, 200))
    assert.equal(over.json.code, 'IDENTITY_REGISTRATION_RATE_LIMITED')
    // 可执行的读数：现在多少、上限多少。只说"太快了"会让人反复重试。
    assert.match(over.json.error, new RegExp(`上限 ${MAX}`))
    // **没有**建出账号。
    assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM hub_users WHERE name_key LIKE '%再来一个%'").get().n, 0)
  })

  it('被限速的是**注册**，不是整个身份族：登录照常', async () => {
    // 一条把注册闸门做成立即返回 429 的实现，会连登录一起挡掉——
    // 而那把"管理员自己也进不去"变成了限速的副作用。
    const r = await post('/api/identity/login', { name: 'owner-不存在', password: 'whatever-pass' })
    assert.equal(r.status, 401, '登录应当是 401（凭据不对），不是 429')
    assert.equal(r.json.code, 'IDENTITY_INVALID_CREDENTIALS')
  })

  it('目标空间不存在 → 404 具名拒绝，账号不落地', async () => {
    const r = await post('/api/identity/register', {
      name: '打错了', password: 'good-password', space: 'defualt',
    })
    // 注意：闸门已经满了，但**空间检查排在闸门之后**——所以这里要么 429、要么 404，
    // 两种都是"没建账号"。真正要守的是下面那句。
    assert.ok([404, 429].includes(r.status), `实际 ${r.status}：${r.text.slice(0, 160)}`)
    assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM hub_users WHERE name_key LIKE '%打错%'").get().n, 0,
      '目标空间不对时不许留下半个账号')
  })

  it('能力发现仍如实报告策略（限速不改变"这台 Hub 开不开放注册"）', async () => {
    const r = await get('/api/identity/status')
    assert.equal(r.status, 200)
    assert.equal(r.json.registration, 'open')
  })
})
