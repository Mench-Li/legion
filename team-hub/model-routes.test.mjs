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
// ⑥ PRT-316 切片 13：probe 路由的 HTTP 面（此前**一条判据都没有**）
//
// ★ 本仓库此前**没有任何** HTTP 层的 probe 判据：
//   `team-hub/probe-service.test.mjs` 是 0 个 `listen(0)`、0 个 `fetch(` ——
//   它验的是**服务层**（直接 import 那个函数），不是"从 HTTP 进来的那条路"。
//   于是 probe 路由的五个校验分支、墓碑 409、以及「没探测过 ⇒ 503」这四件事，
//   在**搬走之前**就没有判据；搬走之后当然也没有。
//
//   > 一条"族里有既有套件"的印象，与一条"既有套件真的覆盖了这条路由"的事实，
//   > 在没有人为每一条路由点过名的时候是同一个东西。
//
// 下面每一条的期望值都是**先量出来**再写死的（见 `.worktrees/_prt-handoff/probe-slice13-behavior.mjs`），
// 不是照着"我以为的实现"写的 —— 这个坑本会话已经栽过四次。

test('⑥ probe：id 为空（/probe）→ 400 MISSING_PARAM，不落进「查不到」', async () => {
  const r = await call('POST', '/api/model-profiles/probe', {})
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'MISSING_PARAM')
})

test('⑥ probe：编码过的斜杠（%2F）→ 400 BAD_ID_ENCODING，不被当成 id 去查', async () => {
  // ★ 这一条与 GET 的 %2F 是**两套代码**（probe 那条把 id 的切法内联了），
  //   所以 GET 绿了**不代表**这里绿。
  const r = await call('POST', '/api/model-profiles/a%2Fb/probe', {})
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'BAD_ID_ENCODING')
  assert.match(r.body.error, /不能包含斜杠/)
})

test('⑥ probe：坏编码 → 400 BAD_ID_ENCODING（不是 500）', async () => {
  const r = await call('POST', '/api/model-profiles/%E0%A4%A/probe', {})
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'BAD_ID_ENCODING')
})

test('⑥ probe：从没存在过的 id → 404 PROFILE_NOT_FOUND', async () => {
  const r = await call('POST', '/api/model-profiles/never-existed-13/probe', {})
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'PROFILE_NOT_FOUND')
})

test('⑥ probe：墓碑 → 409 PROFILE_DELETED（与 GET 的墓碑口径**一致**，不是 404）', async () => {
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  const del = await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1 })
  assert.equal(del.status, 200, del.raw)

  const r = await call('POST', `/api/model-profiles/${p.id}/probe`, {})
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PROFILE_DELETED')
  // 与 GET 那条路径**同一个码**：调用方不该需要为两条路由记两套判断
  const g = await call('GET', `/api/model-profiles/${p.id}`)
  assert.equal(g.status, 409)
  assert.equal(g.body.code, r.body.code)
})

test('⑥ probe：「没探测过」绝不能被表示成「探测失败」⇒ 503 且码是 PROBE_LAYOUT_BLOCKED', async () => {
  // 本档案没有 endpoint ⇒ 探测**根本没发生**。这一条钉的是 PRT-507 后半那条纪律
  // 在 **HTTP 层**的样子：不是 200（那会被前端当成一个判定）、也不是 5xx 里的
  // 别的什么（那会被读成"模型连不上"，把用户引向查网络）。
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  const r = await call('POST', `/api/model-profiles/${p.id}/probe`, {})
  assert.equal(r.status, 503, r.raw)
  assert.equal(r.body.code, 'PROBE_LAYOUT_BLOCKED')
  assert.match(r.body.error, /没有探测过/, '消息必须说清"这次没有探测过"')
})

test("⑥ 列表：墓碑只认字面量 '1'（'0' 与别的值都不带）", async () => {
  // 建档 + 删掉 ⇒ 留下一个墓碑，然后看三种 query 的差别。
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  await call('DELETE', `/api/model-profiles/${p.id}`, { actor: 'u1', version: 1 })

  const ids = async (q) => {
    const r = await call('GET', '/api/model-profiles' + q)
    assert.equal(r.status, 200, r.raw)
    return r.body.profiles.map((x) => x.id)
  }
  assert.ok(!(await ids('')).includes(p.id), '默认不该出现墓碑')
  assert.ok(!(await ids('?includeDeleted=0')).includes(p.id), '=0 不该出现墓碑')
  assert.ok(!(await ids('?includeDeleted=x')).includes(p.id), '非 1 的值都不该出现墓碑')
  assert.ok((await ids('?includeDeleted=1')).includes(p.id), '=1 必须出现墓碑')
})

test('⑥ 列表：回 serverTimeMs（调用方要知道这份列表是什么时候的）', async () => {
  const r = await call('GET', '/api/model-profiles')
  assert.equal(r.status, 200, r.raw)
  const t = r.body.serverTimeMs
  assert.equal(typeof t, 'number')
  assert.ok(Number.isFinite(t) && t > 0, `serverTimeMs 不合理：${t}`)
})

test('⑥ 建档：顶层字段形态会被拒（`actor` 是未知字段）—— 钉住这个不对称', async () => {
  // 路由体里写的是 `body.profile ?? body`，看着像"两种形态都收"；
  // 但 `actor` 是**必填**且从 body 顶层读，而它同时又是 profile 的**未知字段**
  // ⇒ 顶层形态在带 actor 时**必然** 400 INVALID_PROFILE。
  // 这与 secrets 那两处 "claimed vs actual" 是同一种不对称：记成契约，不"修"。
  const p = profile()
  const r = await call('POST', '/api/model-profiles', { actor: 'u1', ...p })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'INVALID_PROFILE')
  assert.match(r.body.error, /未知字段 actor/)
})

// ── ⑦ 缝上契约：注入**计数桩** probeService
//
// 为什么这一条不能用真 HTTP 验：`force` 默认值这件事只有在"探测真的发生了"
// 之后才可观测，而本环境里没有可用的 endpoint ⇒ 真 HTTP 那条路永远停在 503，
// 根本走不到 force。这就是切片 5～10 用过的**计数桩**：
// 直接构造族工厂，把 `probeService` 换成一个记录参数的桩。
test('⑦ 缝上：probe 的 force 默认 true、requiredCapabilities 透传、profileId 回显', async () => {
  const { createModelProfilesRoutes } = await import('./routes/model-profiles.mjs')
  const live = { id: 'live-13', displayName: 'x', provider: 'deepseek', model: 'm' }

  const build = (verdict) => {
    const calls = []
    let body = {}
    const family = createModelProfilesRoutes({
      json: (res, status, payload) => { res.status = status; res.body = payload },
      handleRun: async (_req, res, fn) => {
        try { res.status = 200; res.body = await fn(body) } catch (e) {
          res.status = e.statusCode ?? 500
          res.body = { ok: false, code: e.code, error: e.message }
        }
      },
      modelStore: { get: () => live, resolveForHistory: () => null },
      probeService: () => ({ probeModelProfile: async (profile, opts) => { calls.push({ profile, opts }); return verdict } }),
      MODEL_ERRORS: { PROFILE_DELETED: 'PROFILE_DELETED', PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND' },
    })
    return { calls, family, setBody: (b) => { body = b } }
  }

  // ① 默认：这是用户主动按下的按钮 ⇒ force 必须为 **true**
  {
    const { calls, family } = build({ verdict: 'ok' })
    const res = {}
    await family.dispatch({ method: 'POST' }, res, { path: '/api/model-profiles/live-13/probe' })
    assert.equal(calls.length, 1, '必须真的调了 probeModelProfile')
    assert.equal(calls[0].opts.force, true, 'force 默认必须是 true（按钮不该只回缓存结论）')
    assert.deepEqual(calls[0].opts.requiredCapabilities, [], '缺省应该是空数组')
    assert.equal(res.status, 200)
    assert.equal(res.body.profileId, 'live-13', '回包必须说明探测的是哪一个档案')
    assert.deepEqual(res.body.probe, { verdict: 'ok' }, '判定对象要**原样**透出去（不能压成一个布尔或字符串）')
  }
  // ② 显式 force:false 要**如实**传下去
  {
    const { calls, family, setBody } = build({ verdict: 'cached' })
    setBody({ force: false, requiredCapabilities: ['tools', 'vision'] })
    const res = {}
    await family.dispatch({ method: 'POST' }, res, { path: '/api/model-profiles/live-13/probe' })
    assert.equal(calls[0].opts.force, false)
    assert.deepEqual(calls[0].opts.requiredCapabilities, ['tools', 'vision'])
  }
  // ③ 桩判 unavailable ⇒ 503 且**用桩给的码**（不是路由自己编一个）
  {
    const { family } = build({ unavailable: true, code: 'NO_BACKEND_13', message: '这次没有探测过（桩）' })
    const res = {}
    await family.dispatch({ method: 'POST' }, res, { path: '/api/model-profiles/live-13/probe' })
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'NO_BACKEND_13')
    assert.equal(res.body.error, '这次没有探测过（桩）')
  }
  // ④ 顺序：`/probe` 必须**先于**那几个 startsWith 前缀被匹配，
  //    否则 id 会被切成 "live-13/probe" 然后以一个方向完全错误的 404 结束。
  {
    const { family } = build({ verdict: 'ok' })
    const res = {}
    await family.dispatch({ method: 'POST' }, res, { path: '/api/model-profiles/live-13/probe' })
    assert.equal(res.status, 200, '不能被前缀路由先抢走')
    assert.equal(res.body.profileId, 'live-13', `id 被切错了：${res.body.profileId}`)
  }
})
// ⑧ PRT-316 切片 13 第二轮：破验翻出来的三条真缺口（PUT / probe 后缀 / 四条路由的 id 守卫）
//
// 期望值全部**先量出来**再写死：见 `.worktrees/_prt-handoff/probe-slice13-gaps.mjs`。

test('⑧ PUT 是**整体替换**：全字段生效、版本 +1；缺 version → 400；版本旧 → 409', async () => {
  const p = profile()
  const made = await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })
  assert.equal(made.status, 200, made.raw)

  // ① 整体替换：改名 + 换模型，两个字段都要真的变
  const put = await call('PUT', `/api/model-profiles/${p.id}`, {
    actor: 'u1', version: 1, profile: { ...p, displayName: '换过', model: 'other-model' },
  })
  assert.equal(put.status, 200, put.raw)
  assert.equal(put.body.version, 2, 'PUT 之后版本必须是 2')

  const g = await call('GET', `/api/model-profiles/${p.id}`)
  assert.equal(g.body.profile.displayName, '换过')
  assert.equal(g.body.profile.model, 'other-model')
  assert.equal(g.body.profile.version, 2)

  // ② 不带 version ⇒ 400 VERSION_REQUIRED（不许"默认最后一版"）
  const noVer = await call('PUT', `/api/model-profiles/${p.id}`, {
    actor: 'u1', profile: { ...p, displayName: '没带版本' },
  })
  assert.equal(noVer.status, 400, noVer.raw)
  assert.equal(noVer.body.code, 'VERSION_REQUIRED')

  // ③ 版本旧 ⇒ 409 VERSION_CONFLICT，且**写不进去**
  const stale = await call('PUT', `/api/model-profiles/${p.id}`, {
    actor: 'u1', version: 1, profile: { ...p, displayName: '旧版本写的' },
  })
  assert.equal(stale.status, 409, stale.raw)
  assert.equal(stale.body.code, 'VERSION_CONFLICT')
  const after = await call('GET', `/api/model-profiles/${p.id}`)
  assert.equal(after.body.profile.displayName, '换过', '409 之后不许留下任何改动')
})

test('⑧ PUT 对**不存在**的 id → 404 PROFILE_NOT_FOUND', async () => {
  const r = await call('PUT', '/api/model-profiles/never-put-13', { actor: 'u1', version: 1, profile: profile() })
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'PROFILE_NOT_FOUND')
})

test("⑧ probe 的 '/probe' 后缀是**必需**的：别的后缀落回 404，不被当成探测", async () => {
  // ★ 这一条钉的是"前缀匹配"与"前缀+后缀匹配"的差别。
  //   若把这条路由降级成纯前缀，`/k/nope` 会被当成一次探测请求
  //   （id 会被切错），而不是 404 —— 那时**没有任何既有判据**会说话。
  const p = profile()
  await call('POST', '/api/model-profiles', { actor: 'u1', profile: p })

  const wrong = await call('POST', `/api/model-profiles/${p.id}/nope`, {})
  assert.equal(wrong.status, 404, wrong.raw)
  assert.match(String(wrong.body.error), /not found/, '应当落回 handle 的兜底 404')

  const extra = await call('POST', `/api/model-profiles/${p.id}/probe/extra`, {})
  assert.equal(extra.status, 404, extra.raw)
})

test('⑧ 四条前缀路由的 id 守卫一致：坏编码 → 400 BAD_ID_ENCODING，空 id → 400 MISSING_PARAM', async () => {
  // GET 那两条已有判据（④⑤），但 PATCH/PUT/DELETE 的守卫**一条判据都没有** ——
  // 把它们删掉不会有任何套件变红。这里逐条钉住。
  const cases = [
    ['GET', undefined],
    ['PATCH', { actor: 'u1', version: 1, profile: profile() }],
    ['PUT', { actor: 'u1', version: 1, profile: profile() }],
    ['DELETE', { actor: 'u1', version: 1 }],
  ]
  for (const [method, body] of cases) {
    const bad = await call(method, '/api/model-profiles/%E0%A4%A', body)
    assert.equal(bad.status, 400, `${method} 坏编码：${bad.raw}`)
    assert.equal(bad.body.code, 'BAD_ID_ENCODING', `${method} 坏编码的码不对`)

    const empty = await call(method, '/api/model-profiles/', body)
    assert.equal(empty.status, 400, `${method} 空 id：${empty.raw}`)
    assert.equal(empty.body.code, 'MISSING_PARAM', `${method} 空 id 的码不对`)
  }
})
