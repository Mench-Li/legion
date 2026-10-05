// team-hub/identity-registration.test.mjs
// 账号体系：**注册 / 登录 / 改口令**在真实 HTTP 上的接线（远程 Agent 通道 S-B 之二）。
//
// 前面 `user-store.test.mjs` 测的是仓储语义；这一组测的是"它真的被接上了"——
// 路由注册、策略从**配置**来（不是从请求体来）、错误码与 HTTP 状态对得上。
// 这一类问题的表现方式是"模块全绿、功能不可用"或更坏的"接口在替调用方决定策略"。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REGISTRATION_MODES } from './user-store.mjs'
import { SCHEMA } from './config-schema.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-register-'))
const HUB_TOKEN = 'hub-machine-token-for-tests'
const IDENTITY_KEY = 'identity-signing-key-for-tests-0123456789'
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = HUB_TOKEN
  process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
  process.env.LEGION_REMOTE_AUTH = '1'
  // 这一组测 open 策略那一条路。**默认值**那条由下面读 schema 的用例守着。
  process.env.LEGION_REGISTRATION = 'open'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${mod.server.address().port}`
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
const get = (path, opts) => call('GET', path, opts)
const post = (path, body, opts) => call('POST', path, { body, ...opts })

describe('账号体系（注册 / 登录 / 改口令）', () => {
  const state = {}

  it('默认策略是 `closed`，且 schema 与仓储的枚举是同一套', () => {
    // ★ 这条是整组里最要紧的一条：一个**默认打开**的注册端点，
    //   与一个"忘了设策略"的部署，在出事那天是同一个东西——
    //   只不过没人会去查一个一直好好的开关。
    const field = SCHEMA.fields.find((f) => f.key === 'registration')
    assert.ok(field, 'config-schema 里必须有 registration')
    assert.equal(field.default, 'closed')
    assert.equal(field.env, 'LEGION_REGISTRATION')
    // 两处枚举必须一致：写在这里的候选值与仓储接受的值漂移的表现是
    // "配置写了个看起来对的值，运行期每一个注册请求都被 INVALID_INPUT 拒掉"。
    for (const mode of REGISTRATION_MODES) {
      assert.match(field.doc, new RegExp(mode), `config-schema 的说明里应提到 ${mode}`)
    }
    assert.deepEqual([...REGISTRATION_MODES], ['closed', 'invite', 'open'])
  })

  it('能力发现公开报告注册策略（登录页靠它决定显不显示"注册"）', async () => {
    const s = await get('/api/identity/status')
    assert.equal(s.status, 200)
    assert.equal(s.json.registration, 'open')
    assert.equal(s.json.bootstrapped, false, '还没引导时也要能回答这件事')
  })

  it('引导第一个管理员（机器令牌）', async () => {
    const r = await post('/api/identity/bootstrap', { name: 'owner', password: 'owner-password' }, { token: HUB_TOKEN })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    state.owner = r.json
    assert.equal(state.owner.systemRole, 'admin')
  })

  it('注册即登录：响应里就是可用令牌，不是"请去登录"', async () => {
    const r = await post('/api/identity/register', {
      name: '小兵', password: 'soldier-password', space: 'default', label: '手机',
    })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    state.soldier = r.json
    assert.equal(typeof r.json.accessToken, 'string')
    assert.equal(typeof r.json.refreshToken, 'string')
    // 当场就能用：分成两步的版本会留下"账号存在但我进不去"的中间态。
    const me = await get('/api/identity/me', { token: r.json.accessToken })
    assert.equal(me.status, 200)
    assert.equal(me.json.user.name, '小兵')
    assert.equal(me.json.roles[0].space, 'default')
    assert.equal(me.json.roles[0].role, 'member')
    // 自助注册**不**给系统管理员：否则任何人都能注册成主人。
    assert.equal(me.json.systemRole, 'none')
  })

  it('★ 策略从**配置**来：请求体里写 registration 不算数', async () => {
    // 一个"由调用方声明这次注册适用哪条策略"的接口，等于没有策略——
    // 攻击者只要在请求里写 `registration: 'open'`。
    const r = await post('/api/identity/register', {
      name: '想作弊的人', password: 'sneaky-password', registration: 'closed',
    })
    // 传 'closed' 应被**忽略**（配置是 open），注册照常成功。
    assert.equal(r.status, 200, r.text.slice(0, 200))
    const me = await get('/api/identity/me', { token: r.json.accessToken })
    assert.equal(me.json.user.name, '想作弊的人')
  })

  it('重名被拒 409，且用的是与登录同一套归一', async () => {
    const dup = await post('/api/identity/register', { name: '小兵', password: 'another-password' })
    assert.equal(dup.status, 409, dup.text.slice(0, 160))
    assert.equal(dup.json.code, 'IDENTITY_NAME_TAKEN')
    const casey = await post('/api/identity/register', { name: '  小兵  ', password: 'another-password' })
    assert.equal(casey.status, 409)
  })

  it('口令太短被拒（注册那条路同样走强度校验）', async () => {
    const r = await post('/api/identity/register', { name: '短口令', password: 'short' })
    assert.equal(r.status, 400)
    assert.equal(r.json.code, 'IDENTITY_INVALID_INPUT')
  })

  it('改口令：原口令不对是 401，且什么都没变', async () => {
    const bad = await post('/api/identity/password', {
      currentPassword: '记错了', newPassword: 'brand-new-password',
    }, { token: state.soldier.accessToken })
    assert.equal(bad.status, 401, bad.text.slice(0, 160))
    assert.equal(bad.json.code, 'IDENTITY_WRONG_PASSWORD')
    // 旧口令照常能登。
    const still = await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })
    assert.equal(still.status, 200)
  })

  it('改口令成功后：别的会话当场失效，当前这个还留着', async () => {
    // 再开一个会话，模拟"另一台设备"。
    const other = await post('/api/identity/login', { name: '小兵', password: 'soldier-password', label: '另一台' })
    assert.equal(other.status, 200)

    const r = await post('/api/identity/password', {
      currentPassword: 'soldier-password', newPassword: 'brand-new-password',
    }, { token: state.soldier.accessToken })
    assert.equal(r.status, 200, r.text.slice(0, 200))
    assert.equal(r.json.changed, true)
    // 只断言"≥1"而不是"恰好 1"：本组前面的用例也开过会话，那些**同样**该被撤销。
    // 真正要守的那条在下面——「另一台」必须当场失效，而当前这个必须还活着。
    assert.ok(r.json.revokedOtherSessions >= 1, `至少要撤销另一个会话，实际 ${r.json.revokedOtherSessions}`)

    // 另一台当场失效 —— 只改哈希不踢会话的话，那个人照样有效到过期为止。
    const gone = await get('/api/identity/me', { token: other.json.accessToken })
    assert.equal(gone.status, 401)
    assert.equal(gone.json.code, 'IDENTITY_SESSION_REVOKED')
    // 自己这个还在：把人一起踢掉，他会以为改口令失败了。
    const alive = await get('/api/identity/me', { token: state.soldier.accessToken })
    assert.equal(alive.status, 200)
    // 新口令能登，旧口令不能。
    assert.equal((await post('/api/identity/login', { name: '小兵', password: 'brand-new-password' })).status, 200)
    assert.equal((await post('/api/identity/login', { name: '小兵', password: 'soldier-password' })).status, 401)
  })

  it('改口令要登录：匿名调用是 401，不是"改了个寂寞"', async () => {
    const r = await post('/api/identity/password', { currentPassword: 'x', newPassword: 'brand-new-password' })
    assert.equal(r.status, 401)
  })

  it('注册与改口令都写进审计（且不含口令原文）', () => {
    const rows = mod.db.prepare("SELECT action, detail FROM audit WHERE action LIKE 'identity:%'").all()
    assert.ok(rows.some((r) => r.action === 'identity:register'), '注册要留痕')
    assert.ok(rows.some((r) => r.action === 'identity:password-change'), '改口令要留痕')
    const blob = JSON.stringify(rows)
    assert.equal(blob.includes('soldier-password'), false, '审计里不许出现口令')
    assert.equal(blob.includes('brand-new-password'), false)
  })
})
