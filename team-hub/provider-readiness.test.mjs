// ============================================================================
// provider 就绪度：心跳携带的**本机自检读数** —— 校验、往返、以及那条纪律。
//
// 这次要守的东西来自用户的一句「相当茫然，完全不知道怎么配置」：
// 工作流面板原来让人手填 provider 名（界面上查不到），而心跳上报的能力位是**声明**
// 不是**读数** —— 一台没装 codex 的机器，界面上照样显示"就绪"。
//
// ★★★ 本文件最重要的一条不是"字段能不能存下来"，而是**字段坏掉时会发生什么**：
//   心跳失败的代价是这台守护被标成离线（60 秒在线窗）⇒ 对话健康降级、任务不再派给它；
//   而就绪度只是诊断信息，没有它一切照常。两者代价差一个量级，**不允许共命运**。
//
//     一个坏掉的诊断字段，与一个坏掉的健康上报，
//     在**字段总是合法**的时候是同一条路径 ——
//     区别只在字段坏掉的那一刻：前者该少一行信息，后者会让整台机器"下线"。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_PROVIDERS,
  deserializeProviderReadiness,
  parseProviderReadiness,
  serializeProviderReadiness,
} from './provider-readiness.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-provider-readiness-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const get = async (p) => {
  const res = await fetch(base + p)
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const reset = () => mod.db.prepare('DELETE FROM members').run()
const memberRow = (id) => mod.db.prepare('SELECT * FROM members WHERE id = ?').get(id)

const READY = Object.freeze({
  state: 'ready', reason: '`codex` 可用、登录态在、端点可达。',
  cli: 'found', auth: 'present', network: 'reachable', version: '1.2.3', checkedAtMs: 1,
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

// ══════════════════════ 校验器（纯） ══════════════════════

test('合法读数通过；每个状态都认', () => {
  for (const state of ['ready', 'missing_cli', 'not_logged_in', 'no_network', 'unprobed', 'unknown']) {
    const r = parseProviderReadiness({ codex: { state } })
    assert.equal(r.ok, true, state + ' 应当被接受')
    assert.deepEqual(r.value, { codex: { state } })
  }
})

test('★ 缺 state 的条目拒掉（没有结论的条目没有意义）', () => {
  const r = parseProviderReadiness({ codex: { reason: '不知道' } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /缺 state/)
})

test('★ 未知字段拒掉（两边版本不一致时不猜）', () => {
  const r = parseProviderReadiness({ codex: { state: 'ready', secret: 'x' } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /不是受支持的字段/)
})

test('形状不合法一律 not-ok，且 reason 里**不含取值内容**', () => {
  for (const bad of [null, undefined, [], 'x', 42, {}, { codex: null }, { codex: [] }, { codex: { state: 1 } }, { codex: { state: 'made-up' } }]) {
    const r = parseProviderReadiness(bad)
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应当被拒')
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0)
  }
  // reason 不得把原始值抄进去（避免把凭据类东西写进日志）
  const r = parseProviderReadiness({ codex: { state: 'ready', reason: 'sk-live-abcdef' } })
  assert.equal(r.ok, true)
  const bad = parseProviderReadiness({ codex: { state: 'nope', whatever: 'sk-live-abcdef' } })
  assert.ok(!bad.reason.includes('sk-live-abcdef'), 'reason 泄漏了原始内容')
})

test('条目数上限', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_PROVIDERS + 1 }, (_, i) => ['p' + i, { state: 'ready' }]))
  assert.equal(parseProviderReadiness(many).ok, false)
})

test('★ 读侧永不抛错：坏 JSON / 空串 / null 都当"没有"', () => {
  assert.equal(deserializeProviderReadiness(null), null)
  assert.equal(deserializeProviderReadiness(''), null)
  assert.equal(deserializeProviderReadiness('{ 不是 json'), null)
  assert.equal(deserializeProviderReadiness('{"codex":{"no_state":1}}'), null)
  assert.deepEqual(deserializeProviderReadiness(serializeProviderReadiness({ codex: READY })), { codex: READY })
  assert.equal(serializeProviderReadiness({ bad: 1 }), null)
})

// ══════════════════════ 心跳往返 ══════════════════════

test('① 心跳带上就绪度 ⇒ 落库、并能在 /api/members 读回来', async () => {
  reset()
  const r = await post('/api/heartbeat', {
    by: 'worker@A', scope: 'A', kind: 'worker', model: { provider: 'spawn', model: 'm' },
    providers: { codex: READY, 'claude-code': { state: 'missing_cli', reason: 'PATH 上找不到 claude', cli: 'missing' } },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)

  const row = memberRow('worker@A')
  assert.ok(row, '心跳应当写下成员行')
  assert.ok(row.providers_json, 'providers_json 应当被写入')

  const m = (await get('/api/members')).body.find((x) => x.member === 'worker@A')
  assert.equal(m.providers.codex.state, 'ready')
  assert.equal(m.providers['claude-code'].state, 'missing_cli')
  assert.equal(m.providers.codex.version, '1.2.3')
})

test('② 旧守护不带 providers ⇒ 心跳照常成功，读出来是 null（不是空对象）', async () => {
  reset()
  const r = await post('/api/heartbeat', { by: 'old@A', scope: 'A', kind: 'worker' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const m = (await get('/api/members')).body.find((x) => x.member === 'old@A')
  assert.equal(m.providers, null, '"从没上报过" 必须是 null —— 与"上报了但不就绪"分得开')
})

test('★★ ③ 坏掉的 providers **不许**把心跳带崩（守护仍然在线）', async () => {
  reset()
  for (const bad of [
    { codex: { state: 'made-up' } },        // 状态不在枚举里
    { codex: { reason: 'no state' } },      // 缺 state
    { codex: { state: 'ready', x: 1 } },    // 未知字段
    { codex: null },                        // 条目不是对象
    'not-an-object',                        // 整个字段不是对象
    {},                                     // 空对象
  ]) {
    const r = await post('/api/heartbeat', { by: 'bad@A', scope: 'A', kind: 'worker', providers: bad })
    assert.equal(r.status, 200, `坏字段导致心跳非 200：${JSON.stringify(bad)}`)
    assert.equal(r.body.ok, true)
    const row = memberRow('bad@A')
    assert.ok(row, '成员行必须照样写下来（心跳成功）')
    assert.equal(row.online, 1)
    assert.equal(row.providers_json, null, '坏字段应当被丢弃，而不是存进去')
  }
  // 而且这台守护**仍然被算作在线** —— 这才是"没共命运"的判据
  const m = (await get('/api/members')).body.find((x) => x.member === 'bad@A')
  assert.equal(m.online, true, '坏诊断字段不该让守护掉线')
})

test('④ 带了就覆盖、没带就保留（探测有 TTL，心跳没有 —— 否则界面会闪）', async () => {
  reset()
  await post('/api/heartbeat', { by: 'w@A', scope: 'A', kind: 'worker', providers: { codex: READY } })
  assert.equal(memberRow('w@A').providers_json !== null, true)

  // 紧接着一次**不带** providers 的心跳（真实情形：就绪度 TTL 10 分钟，心跳 30 秒）
  await post('/api/heartbeat', { by: 'w@A', scope: 'A', kind: 'worker' })
  const m1 = (await get('/api/members')).body.find((x) => x.member === 'w@A')
  assert.equal(m1.providers?.codex?.state, 'ready', '没带值的那次心跳不该把已有读数抹掉')

  // 带了新的就覆盖
  await post('/api/heartbeat', { by: 'w@A', scope: 'A', kind: 'worker', providers: { codex: { state: 'not_logged_in', reason: '没登录' } } })
  const m2 = (await get('/api/members')).body.find((x) => x.member === 'w@A')
  assert.equal(m2.providers.codex.state, 'not_logged_in', '带了值就该覆盖')
})

test('⑤ 模型与就绪度互不干扰（model 那一格的行为未变）', async () => {
  reset()
  await post('/api/heartbeat', { by: 'w2@A', scope: 'A', kind: 'worker', model: { provider: 'spawn', model: 'mm' }, providers: { codex: READY } })
  const row = memberRow('w2@A')
  assert.equal(JSON.parse(row.model).model, 'mm', 'model 列仍按原样写入')
  assert.equal(JSON.parse(row.providers_json).codex.state, 'ready')
})
