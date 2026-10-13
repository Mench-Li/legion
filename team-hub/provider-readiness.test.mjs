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

// ── 2026-10-13：provider 自报的能力位 `declared`（"能干什么"的真值） ──
// 守的是一处"发布成功、派工必失败"的缺陷：面板此前硬编码 outputSchema=true，
// 而派工与认领都真的按声明逐位拒收。所以这份读数必须能被**如实**上报。

test('★ declared 收下三个布尔位 + 权限模式（形状与节点能力位同一套）', () => {
  const r = parseProviderReadiness({ codex: { state: 'ready', declared: {
    outputSchema: true, toolFilter: false, cancellation: true,
    permissionMode: 'codex-workspace-write', systemProxyMode: 'system',
  } } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(r.value.codex.declared, {
    outputSchema: true, toolFilter: false, cancellation: true,
    permissionMode: 'codex-workspace-write', systemProxyMode: 'system',
  })
})

test('★ outputSchema=false 必须能**存下来**（正是它此前无处可表达）', () => {
  const r = parseProviderReadiness({ p: { state: 'ready', declared: { outputSchema: false, toolFilter: false, cancellation: true } } })
  assert.equal(r.ok, true, '不支持结构化输出是**合法读数**，不是坏数据')
  assert.equal(r.value.p.declared.outputSchema, false, '不能被"规整"成 true 或丢掉')
})

test('★★ 能力位**缺一个就拒**（缺位会被上层读成 false，把版本问题伪装成能力问题）', () => {
  for (const partial of [
    { outputSchema: true, toolFilter: true },
    { outputSchema: true },
    { outputSchema: true, toolFilter: true, cancellation: undefined },
    { outputSchema: true, toolFilter: true, cancellation: 'yes' },
    { outputSchema: 1, toolFilter: true, cancellation: true },
  ]) {
    const r = parseProviderReadiness({ p: { state: 'ready', declared: partial } })
    assert.equal(r.ok, false, JSON.stringify(partial) + ' 应当被拒')
  }
})

test('declared 的其它形状限制：未知能力位 / 空 permissionMode / 非法 systemProxyMode', () => {
  const base = { outputSchema: true, toolFilter: true, cancellation: true }
  for (const bad of [
    { ...base, evil: true },
    { ...base, permissionMode: '' },
    { ...base, permissionMode: 1 },
    { ...base, systemProxyMode: 'always' },
    [],
  ]) {
    const r = parseProviderReadiness({ p: { state: 'ready', declared: bad } })
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应当被拒')
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '拒掉时必须给出理由')
  }
})

test('★ 没有 declared 字段是合法的（旧守护 / 本机没读到）', async () => {
  const r = parseProviderReadiness({ p: { state: 'ready' } })
  assert.equal(r.ok, true)
  assert.equal(r.value.p.declared, undefined, '缺失 ≠ 不支持 —— 这个区别是"拦不拦发布"的判据')
  // 端到端：不带 declared 的心跳照常成功，读回来 declared 缺席
  mod.db.prepare('DELETE FROM members').run()
  await post('/api/heartbeat', { by: 'old@A', scope: 'A', kind: 'worker', providers: { p: { state: 'ready', reason: 'x' } } })
  const m = (await get('/api/members')).body.find((x) => x.member === 'old@A')
  assert.equal(m.providers.p.declared, undefined)
})

// ── 2026-10-13：凭据模式 `authMode` 与端点 `endpointHost` ──
// ★ 这两个字段**必须**在白名单里：不在 = 整条被丢（逐条收的代价），
//   于是 `claude-code` 会因为"多了个 hub 不认识的字段"而从面板上**整条消失** ——
//   而它恰恰是那条要告诉用户"你是 API 模式，不是没登录"的读数。

test('★ authMode / endpointHost 能存下来（API 模式的读数不该被丢）', () => {
  const r = parseProviderReadiness({ 'claude-code': {
    state: 'ready', reason: 'API 模式', cli: 'found', auth: 'present',
    authMode: 'api-settings', endpointHost: 'api.example.invalid', network: 'reachable',
  } })
  assert.equal(r.ok, true, '带了这两个字段不该被拒：' + JSON.stringify(r))
  assert.equal(r.value['claude-code'].authMode, 'api-settings')
  assert.equal(r.value['claude-code'].endpointHost, 'api.example.invalid')
})

test('★ 五种 authMode 都认；自造的值被拒', () => {
  for (const mode of ['subscription', 'api-settings', 'env', 'none', 'not-required']) {
    assert.equal(parseProviderReadiness({ p: { state: 'ready', authMode: mode } }).ok, true, mode)
  }
  for (const bad of ['api', 'oauth', '', 1, null]) {
    assert.equal(parseProviderReadiness({ p: { state: 'ready', authMode: bad } }).ok, false, JSON.stringify(bad))
  }
})

test('★ endpointHost 过长被拒（避免有人把整条 URL 塞进来）', () => {
  assert.equal(parseProviderReadiness({ p: { state: 'ready', endpointHost: 'a'.repeat(253) } }).ok, true)
  assert.equal(parseProviderReadiness({ p: { state: 'ready', endpointHost: 'a'.repeat(254) } }).ok, false)
})

test('★★ 端到端：API 模式的整条读数原样到达 /api/members', async () => {
  mod.db.prepare('DELETE FROM members').run()
  await post('/api/heartbeat', { by: 'apimode@A', scope: 'A', kind: 'worker', providers: {
    'claude-code': { state: 'ready', reason: '凭据（CLI 配置里的 API 模式）在', cli: 'found', auth: 'present',
      authMode: 'api-settings', endpointHost: 'api.example.invalid', network: 'reachable' },
  } })
  const m = (await get('/api/members')).body.find((x) => x.member === 'apimode@A')
  assert.ok(m.providers['claude-code'], 'claude-code 这条必须留下')
  assert.equal(m.providers['claude-code'].authMode, 'api-settings')
  assert.equal(m.providers['claude-code'].endpointHost, 'api.example.invalid')
})

test('★ declared 往返：心跳带上能力位 ⇒ /api/members 读得到', async () => {
  mod.db.prepare('DELETE FROM members').run()
  await post('/api/heartbeat', { by: 'caps@A', scope: 'A', kind: 'worker', providers: {
    p: { state: 'ready', declared: { outputSchema: false, toolFilter: true, cancellation: true } },
  } })
  const m = (await get('/api/members')).body.find((x) => x.member === 'caps@A')
  assert.equal(m.providers.p.declared.outputSchema, false)
  assert.equal(m.providers.p.declared.toolFilter, true)
})

test('★ 坏 declared 只丢字段、**不带崩心跳**（同一条纪律）', async () => {
  mod.db.prepare('DELETE FROM members').run()
  const r = await post('/api/heartbeat', { by: 'badcaps@A', scope: 'A', kind: 'worker',
    providers: { p: { state: 'ready', declared: { outputSchema: true } } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const row = memberRow('badcaps@A')
  assert.equal(row.online, 1, '坏的能力位不该让守护掉线')
  assert.equal(row.providers_json, null)
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

// ══════════════════════════════════════════════════════════════════════════
// ★★ 逐条丢，而不是"一条坏就整份丢"（2026-10-13 实机修正）
//
// 第一版是 all-or-nothing：任何一个 provider 的任何一个字段不合法 ⇒ 整份 `providers` 丢掉。
// 那是**诊断字段**上最坏的失败模式 —— 一个 provider 的怪值会让**其余全部**读数一起消失，
// 界面上表现为"这台机器什么都没探到"。
//
//   > 一个"因为隔壁那条坏了，于是这条也不报"的读数，
//   > 与一个"本机确实什么都没有"的读数，在界面上是同一个样子。
//
// 而这条数据的用途恰恰是让人看见真相 ⇒ 宁可少一条，也不要一条都没有。
// 容器形状不对（不是对象 / 空对象 / 超量）仍然整份拒 —— 那是**协议**错误。
// ══════════════════════════════════════════════════════════════════════════

test('★★ 一条坏、其余好 ⇒ **好的那条要留下**（别让坏邻居把读数全带走）', () => {
  const r = parseProviderReadiness({
    spawn: { state: 'ready', reason: '内置' },
    broken: { state: 'made-up-state' },
    half: { reason: '缺 state' },
    weird: { state: 'ready', evil: 1 },
    notObject: 'nope',
    also: { state: 'missing_cli', cli: 'missing' },
  })
  assert.equal(r.ok, true, '还有可用条目就不该整份拒：' + JSON.stringify(r))
  assert.deepEqual(Object.keys(r.value).sort(), ['also', 'spawn'], '只有两条有效')
  assert.equal(r.value.spawn.state, 'ready')
  assert.equal(r.value.also.state, 'missing_cli')
  assert.equal(r.dropped.length, 4, '丢弃原因要报出来（便于排查"为什么少了一条"）')
  assert.ok(r.dropped.some((d) => d.startsWith('broken(')))
})

test('★ 全都坏 ⇒ 仍然 not-ok（不能存成空对象，那会被读成"探过且为空"）', () => {
  const r = parseProviderReadiness({ a: { state: 'nope' }, b: null })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有一条可用/)
})

test('★ 容器形状错误仍然整份拒（那是协议错误，不是"某条脏"）', () => {
  for (const bad of [null, [], 'x', 42, {}]) {
    assert.equal(parseProviderReadiness(bad).ok, false, JSON.stringify(bad))
  }
})

test('★ 逐条丢之后落库的是**好的那部分**（端到端：坏邻居不该让心跳丢读数）', async () => {
  mod.db.prepare('DELETE FROM members').run()
  await post('/api/heartbeat', { by: 'partial@A', scope: 'A', kind: 'worker', providers: {
    spawn: { state: 'ready', reason: '内置' },
    broken: { state: 'not-a-real-state' },
  } })
  const m = (await get('/api/members')).body.find((x) => x.member === 'partial@A')
  assert.ok(m.providers, '好的那条必须留下（整份丢会让面板看到"什么都没探到"）')
  assert.deepEqual(Object.keys(m.providers), ['spawn'])
  assert.equal(m.providers.spawn.state, 'ready')
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

// ── 2026-10-13：守护上报的 profile 名（决定修法命令能不能给） ──
// 守的是一句"看着能跑、其实跑不了"的命令：`dsh plugin --profile <profile-name> add …`。
// 真名必须被带到面板，否则面板只能给占位符（而 `--profile` 是必填项，粘了必然报错）；
// 名称非法则**丢掉**，因为它会被拼进 shell 命令。

test('★ profile 往返：心跳带上 ⇒ /api/members 读得到', async () => {
  reset()
  const r = await post('/api/heartbeat', { by: 'prof@A', scope: 'A', kind: 'worker', profile: 'desktop' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const m = (await get('/api/members')).body.find((x) => x.member === 'prof@A')
  assert.equal(m.profile, 'desktop', '真名必须能带出来，否则面板只能给占位符')
})

test('★ 不带 profile ⇒ 心跳照常成功，读出来是 null（旧守护）', async () => {
  reset()
  const r = await post('/api/heartbeat', { by: 'noprof@A', scope: 'A', kind: 'worker' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const m = (await get('/api/members')).body.find((x) => x.member === 'noprof@A')
  assert.equal(m.profile, null, '没上报就是 null —— 面板据此走"不给命令"分支')
})

test('★★ 非法 profile 名被丢掉，且**不带崩心跳**（它会被拼进 shell 命令）', async () => {
  reset()
  for (const bad of ['a/b', 'a\\b', '.', '..', 'node_modules', '', 123, {}, ['x'], 'x'.repeat(200)]) {
    const r = await post('/api/heartbeat', { by: 'badprof@A', scope: 'A', kind: 'worker', profile: bad })
    assert.equal(r.status, 200, `坏 profile 导致心跳非 200：${JSON.stringify(bad)}`)
    assert.equal(r.body.ok, true)
    const row = memberRow('badprof@A')
    assert.equal(row.online, 1, '坏的诊断字段不该让守护掉线')
    assert.equal(row.profile, null, '非法名不该被存下来（它会被拼进命令）')
  }
})

test('★ profile 与 providers 各自独立：一个坏了不影响另一个', async () => {
  reset()
  await post('/api/heartbeat', { by: 'mix@A', scope: 'A', kind: 'worker',
    profile: 'web', providers: { p: { state: 'made-up' } } })
  let m = (await get('/api/members')).body.find((x) => x.member === 'mix@A')
  assert.equal(m.profile, 'web', 'providers 坏不该连带丢掉 profile')
  assert.equal(m.providers, null)

  await post('/api/heartbeat', { by: 'mix2@A', scope: 'A', kind: 'worker',
    profile: 'a/b', providers: { p: { state: 'ready' } } })
  m = (await get('/api/members')).body.find((x) => x.member === 'mix2@A')
  assert.equal(m.profile, null)
  assert.equal(m.providers.p.state, 'ready', 'profile 坏不该连带丢掉 providers')
})

test('★ profile 也是"带了覆盖、没带保留"（同 providers 的语义）', async () => {
  reset()
  await post('/api/heartbeat', { by: 'keep@A', scope: 'A', kind: 'worker', profile: 'web' })
  await post('/api/heartbeat', { by: 'keep@A', scope: 'A', kind: 'worker' })
  const m = (await get('/api/members')).body.find((x) => x.member === 'keep@A')
  assert.equal(m.profile, 'web', '没带 profile 的那次心跳不该把它抹掉')
})
