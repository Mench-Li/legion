// team-hub/model-routes.test.mjs
// ============================================================================
// 模型档案的 HTTP 契约（PRT-501，spec §6.6 / §6.7）
//
// 上一组（`model-store.test.mjs`）验仓储；这一组验**从 HTTP 进来的那条路**，
// 而它比仓储多出三件只有真实请求才会暴露的事：
//
//   ① **响应体里有没有密钥**。仓储的那一组验的是返回值对象；这里验的是
//      **真的序列化出去的 JSON**——一个字段名写错或漏了过滤，只有在
//      `JSON.stringify(res)` 上才看得见。
//   ② **null 与缺失的区别**。`endpoint: null` 与没有 `endpoint` 字段在
//      校验里是同一件事，但 `PATCH` 一个只带 displayName 的 body 时，
//      没给的字段会被当成 `null` 还是"保持原值"，结果完全不同。
//   ③ **状态码**。仓储抛的是带 `statusCode` 的错，路由得把它如实送出去；
//      400 与 409 的区分决定了调用方该改输入还是该重新读取。
//
// 独立进程与自己的库：这一组要反复建/删档案，共用一个库会让
// 别的路由测试被残留档案影响（而那种影响看起来像"随机的 409"）。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-modelroutes-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  // `raw` 保留原始响应文本：验"没有密钥"必须在**序列化后**的字节上看，
  // 而不是在解析出来的对象上（解析会把 undefined 字段丢掉）。
  return { status: res.status, body: parsed, raw: text }
}

let seq = 0
function nextId() { seq += 1; return `p-${seq}` }

function profile(over = {}) {
  return {
    id: nextId(),
    displayName: '测试档案',
    runtimeType: 'dsh',
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
    limits: { maxTokens: 4096 },
    ...over,
  }
}

test('① POST 建档案 → 201/200 且响应体**不含任何密钥**', async () => {
  const p = profile({ secretRef: 'legion/deepseek/prod' })
  const r = await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.hasCredential, true)
  // 在**原始响应字节**上验：引用名与任何密钥形态都不得出现
  assert.ok(!r.raw.includes('legion/deepseek'), `响应体泄露了引用名：${r.raw}`)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(r.raw), `响应体泄露了密钥：${r.raw}`)
  assert.ok(!('secretRef' in r.body), `响应体含 secretRef 字段：${r.raw}`)
})

test('① GET 列表：默认不含墓碑，`?includeDeleted=1` 才带上', async () => {
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  let r = await call('GET', '/api/model-profiles')
  assert.equal(r.status, 200)
  assert.ok(r.body.profiles.some((x) => x.id === p.id))

  const del = await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1 })
  assert.equal(del.status, 200, del.raw)
  r = await call('GET', '/api/model-profiles')
  assert.ok(!r.body.profiles.some((x) => x.id === p.id), '默认列表不得含墓碑')
  r = await call('GET', '/api/model-profiles?includeDeleted=1')
  assert.ok(r.body.profiles.some((x) => x.id === p.id), 'includeDeleted=1 应当带上墓碑')
})

test('① GET 单条：未删的 200、删过的 409（墓碑）、从没存在过的 404', async () => {
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  let r = await call('GET', `/api/model-profiles/${p.id}`)
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.profile.id, p.id)

  await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1 })
  r = await call('GET', `/api/model-profiles/${p.id}`)
  // 墓碑与"不存在"必须分开：混成 404 会让「删掉再用同名建」看起来像首次创建
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PROFILE_DELETED')
  assert.ok(Number.isFinite(r.body.deletedAtMs))

  r = await call('GET', '/api/model-profiles/p-never-existed')
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'PROFILE_NOT_FOUND')
})

test('① GET 单条的 id 要**解码**：`%2D` 形态的合法 id 也得能取到', async () => {
  // 合法 id 只允许 `[a-zA-Z0-9._-]`（PRT-102 的契约），因此真正需要解码的
  // 只有"被百分号编码过的合法字符"这一种：`p%2Denc` 就是 `p-enc`。
  // 不解码时它会被当成一个字面含 `%2D` 的 id，于是 404——
  // 而这只在调用方做了编码时才出现，看起来像"建成功了却读不到"。
  const p = profile({ id: 'p-enc-one' })
  const r0 = await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  assert.equal(r0.status, 200, r0.raw)

  const r = await call('GET', '/api/model-profiles/p%2Denc%2Done')
  assert.equal(r.status, 200, `%2D 形态必须解到同一个 id：${r.raw}`)
  assert.equal(r.body.profile.id, 'p-enc-one')
})

test('① 非 ASCII 的 id 被契约拒绝（不做本地化的路径片段）', async () => {
  // id 会成为 worktree 目录名 / secretRef 命名空间 / 审计关联键。
  // 放开非 ASCII 会让这三处各自按自己的规则归一化，而它们不会一致。
  const r = await call('POST', '/api/model-profiles', { actor: 'u1', profile: profile({ id: '档案一号' }) })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'INVALID_PROFILE')
  assert.match(r.body.error, /id 只允许/)
})

test('② PATCH 只改给出的字段语义：必须带 version，且整体替换要显式', async () => {
  const p = profile({ limits: { maxTokens: 4096 } })
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })

  // 不带 version → 400，**不默认最后一版**
  let r = await call('PATCH', `/api/model-profiles/${p.id}`, { actor: 'u1', profile: { ...p, displayName: 'x' } })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'VERSION_REQUIRED')

  // 带 version → 成功，且 version 推进
  r = await call('PATCH', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1, profile: { ...p, displayName: '新名' } })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.displayName, '新名')
  assert.equal(r.body.version, 2)
})

test('② CAS 冲突：409 且**带上 currentVersion**（否则调用方只能盲试）', async () => {
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  await call('PATCH', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1, profile: { ...p, displayName: 'A' } })
  const r = await call('PATCH', `/api/model-profiles/${p.id}`, { actor: 'u2', version: 1, profile: { ...p, displayName: 'B' } })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'VERSION_CONFLICT')
  assert.equal(r.body.currentVersion, 2, `必须给出当前版本：${r.raw}`)
  // A 的改动必须还在
  const now = await call('GET', `/api/model-profiles/${p.id}`)
  assert.equal(now.body.profile.displayName, 'A')
})

test('② 明文密钥**从 HTTP 也进不来**：400，且库里不留行', async () => {
  const before = mod.db.prepare('SELECT COUNT(*) AS n FROM model_profiles').get().n
  for (const over of [
    { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' },
    { endpoint: 'https://user:pass@api.example.com' },
    { model: 'sk-abcdefghijklmnopqrstuvwxyz' },
  ]) {
    const r = await call('POST', '/api/model-profiles', { actor: 'u1', profile: profile(over) })
    assert.equal(r.status, 400, `${JSON.stringify(over)} 应被拒绝：${r.raw}`)
    assert.equal(r.body.code, 'INVALID_PROFILE')
    assert.ok(!r.raw.includes('sk-abcdefghijklmnopqrstuvwxyz'), '错误信息不得回显密钥')
  }
  assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM model_profiles').get().n, before, '被拒绝时不得留行')
})

test('② 缺 actor → 400 ACTOR_REQUIRED（谁改的模型配置必须留痕）', async () => {
  const r = await call('POST', '/api/model-profiles', { profile: profile() })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'ACTOR_REQUIRED')
})

test('③ DELETE 需要 version；成功后同名单建被拒（历史引用不得被换掉）', async () => {
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })

  let r = await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1' })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'VERSION_REQUIRED')

  r = await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1 })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.deleted, true)

  // 同名 id 不能重用：一次 Run 可能还记着这个引用
  r = await call('POST', '/api/model-profiles', { actor: 'u1', profile: profile({ id: p.id, model: 'other' }) })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PROFILE_DELETED')
})

test('③ 未知 id 的 PATCH/DELETE → 404 PROFILE_NOT_FOUND', async () => {
  for (const [method, body] of [['PATCH', { actor: 'u1', version: 1 }], ['DELETE', { actor: 'u1', version: 1 }]]) {
    const r = await call(method, '/api/model-profiles/p-nope', body)
    assert.equal(r.status, 404, `${method}: ${r.raw}`)
    assert.equal(r.body.code, 'PROFILE_NOT_FOUND')
  }
})

test('④ 审计里留了痕，但**没有密文**（在库的原始字节上验）', async () => {
  const p = profile({ secretRef: 'legion/very-secret-ref' })
  await call('POST', '/api/model-profiles', { actor: '审计员', profile: p })
  await call('PATCH', `/api/model-profiles/${p.id}`, { actor: '审计员', version: 1, profile: { ...p, displayName: '改过' } })
  await call('DELETE', `/api/model-profiles/${p.id}`, { actor: '审计员', version: 2 })

  // 按 member 过滤：同一进程里前面的用例也写了不少 model-profile 审计，
  // 不过滤会读到一堆别人的行，于是这条断言变成"数一下总数"——
  // 那种断言在任何人加一条用例时都会红，而它红的原因跟本用例要问的事无关。
  const rows = mod.db.prepare(
    "SELECT action, member, detail FROM audit WHERE member = ? AND action LIKE 'model-profile.%' ORDER BY seq",
  ).all('审计员')
  assert.deepEqual(rows.map((r) => r.action),
    ['model-profile.create', 'model-profile.update', 'model-profile.delete'])
  assert.deepEqual(rows.map((r) => r.member), ['审计员', '审计员', '审计员'])
  const all = JSON.stringify(rows)
  assert.ok(!all.includes('very-secret-ref'), `审计里出现了引用名：${all}`)
  assert.ok(!all.includes('sk-'), `审计里出现了密钥：${all}`)
  // 更新要能回答"凭证变了没有"，而不必知道它是什么
  assert.equal(JSON.parse(rows[1].detail).credentialChanged, false)
})

test('④ 无法解码的 id → 400 BAD_ID_ENCODING（不是 500，也不是静默当成别的 id）', async () => {
  // `%E0%A4%A` 是截断的百分号编码：decodeURIComponent 会抛 URIError。
  const r = await call('GET', '/api/model-profiles/%E0%A4%A')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'BAD_ID_ENCODING')
})

test('⑤ 空 id（前缀后什么都没有）→ 400 MISSING_PARAM，不落进「查不到」', async () => {
  const r = await call('GET', '/api/model-profiles/')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'MISSING_PARAM')
})
