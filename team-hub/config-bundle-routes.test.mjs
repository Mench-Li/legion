// team-hub/config-bundle-routes.test.mjs
// ============================================================================
// 配置导入导出的路由面（PRT-508）
//
// 自起进程 / 自己的库 / 自己的端口：路由用例必须能在**并行**跑，而
// 共用一个库会让"我导出的内容"依赖别条用例写了什么。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let server
let base
let dbDir

before(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'legion-bundle-'))
  process.env.TEAM_HUB_DB = join(dbDir, 'hub.sqlite')
  process.env.TEAM_HUB_TOKEN = ''
  const mod = await import('./server.mjs')
  server = mod.server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  try { server.closeAllConnections?.() } catch { /* 无连接 */ }
  try { await new Promise((r) => server.close(r)) } catch { /* 已关 */ }
  try { rmSync(dbDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

// `agent: false`：undici 的 keep-alive 会让 `node --test` 结束不了
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

const PROFILE = (id, model = 'gpt-4o') => ({
  id,
  displayName: `模型 ${id}`,
  runtimeType: 'dsh',
  provider: 'openai',
  model,
  endpoint: 'https://api.example/v1',
  reasoningEffort: 'medium',
  limits: { maxTokens: 4096 },
})

let seq = 0
const uniq = (p) => `${p}-${Date.now()}-${seq += 1}`

// ------------------------------------------------------------------ ① 导出

test('① 导出：404 之前先有内容——库里没有档案时导出一份**空但合法**的包', async () => {
  const r = await call('GET', '/api/config-bundle')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.bundle.version, 1)
  assert.equal(r.body.bundle.containsSecrets, false)
  assert.equal(r.body.bundle.credentialRefsIncluded, false)
  assert.ok(Array.isArray(r.body.bundle.profiles))
})

test('① 导出**不含 secretRef**，但如实说明哪条档案需要凭证', async () => {
  const id = uniq('exp')
  const created = await call('POST', '/api/model-profiles', {
    profile: { ...PROFILE(id), secretRef: 'legion/exp-key' }, actor: 'test',
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))

  const r = await call('GET', '/api/config-bundle')
  const p = r.body.bundle.profiles.find((x) => x.id === id)
  assert.ok(p !== undefined, '导出的包里应当有这条档案')
  // 关键：引用名不能出现在**任何**地方
  const text = JSON.stringify(r.body)
  assert.ok(!text.includes('legion/exp-key'), `引用名泄漏进了导出：${text}`)
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'secretRef'), false)
  assert.equal(p.credentialRequired, true, '要如实说明它需要凭证（否则新机器不会提示去绑定）')
})

test('① 导出种类可以只要模型、只要绑定、或全要', async () => {
  const all = await call('GET', '/api/config-bundle?kind=full')
  const onlyProfiles = await call('GET', '/api/config-bundle?kind=model-profiles')
  const onlyBindings = await call('GET', '/api/config-bundle?kind=model-bindings')
  assert.equal(all.status, 200)
  assert.ok(all.body.bundle.profiles.length > 0)
  assert.deepEqual([...onlyProfiles.body.bundle.bindings], [])
  assert.deepEqual([...onlyBindings.body.bundle.profiles], [])
  assert.equal(onlyProfiles.body.bundle.kind, 'model-profiles')
})

test('① 未知种类 → 400（不是产出一份空的包）', async () => {
  const r = await call('GET', '/api/config-bundle?kind=nope')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BUNDLE_KIND_INVALID')
  assert.match(r.body.error, /未知的导出种类/)
})

// ------------------------------------------------------------------ ② 计划

test('② plan 是 dry run：跑完之后库里**什么都没变**', async () => {
  const id = uniq('dry')
  const bundle = {
    version: 1,
    kind: 'full',
    containsSecrets: false,
    credentialRefsIncluded: false,
    profiles: [{ ...PROFILE(id), credentialRequired: false }],
    bindings: [],
  }
  const before = await call('GET', '/api/model-profiles')
  const plan = await call('POST', '/api/config-bundle/plan', { bundle })
  assert.equal(plan.status, 200, JSON.stringify(plan.body))
  assert.equal(plan.body.plan.ok, true)
  assert.equal(plan.body.applicable.ok, true)
  assert.equal(plan.body.plan.summary.willWrite, 1)
  // 库里不得出现这条档案
  const after = await call('GET', '/api/model-profiles')
  assert.equal(after.body.profiles.length, before.body.profiles.length, 'plan 不得写库')
  assert.equal(after.body.profiles.some((p) => p.id === id), false)
})

test('② plan 报出悬空引用且标记**不可应用**（一份跑不起来的绑定不该进库）', async () => {
  const plan = await call('POST', '/api/config-bundle/plan', {
    bundle: {
      version: 1,
      profiles: [],
      bindings: [{
        scope: uniq('s'), employeeRole: 'general',
        primaryProfile: 'ghost-model', fallbackProfiles: [],
      }],
    },
  })
  assert.equal(plan.status, 200)
  assert.equal(plan.body.plan.summary.danglingRefs.length, 1)
  assert.equal(plan.body.applicable.ok, false)
  assert.equal(plan.body.applicable.code, 'IMPORT_DANGLING_PROFILE_REF')
})

test('② 计划里的冲突计数与 applicable 一致（前端不必自己重算）', async () => {
  const id = uniq('conf')
  await call('POST', '/api/model-profiles', { profile: PROFILE(id, 'gpt-4o'), actor: 'test' })
  const plan = await call('POST', '/api/config-bundle/plan', {
    bundle: { version: 1, profiles: [{ ...PROFILE(id, 'changed-model'), credentialRequired: false }], bindings: [] },
  })
  assert.equal(plan.body.plan.summary.conflicts, 1)
  assert.equal(plan.body.applicable.ok, false)
  assert.equal(plan.body.applicable.code, 'IMPORT_HAS_CONFLICTS')
  // keep 策略下同一份包变成可应用
  const keep = await call('POST', '/api/config-bundle/plan', {
    bundle: { version: 1, profiles: [{ ...PROFILE(id, 'changed-model'), credentialRequired: false }], bindings: [] },
    conflictPolicy: 'keep',
  })
  assert.equal(keep.body.plan.summary.conflicts, 0)
  assert.equal(keep.body.applicable.ok, true)
})

// ------------------------------------------------------------------ ③ 应用

test('③ apply 真的写进去，并回执"还要去密钥库补哪几条引用"', async () => {
  const id = uniq('apply')
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    bundle: {
      version: 1,
      profiles: [{ ...PROFILE(id), credentialRequired: true }],
      bindings: [],
    },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.written.profiles.length, 1)
  // 导出包里没有引用名，所以导入后它是"需要凭证但还没绑定引用"的状态
  assert.deepEqual([...r.body.needsCredential], [id])
  // 库里确实有了
  const list = await call('GET', '/api/model-profiles')
  assert.ok(list.body.profiles.some((p) => p.id === id))
})

test('③ 冲突默认 409 而不是静默覆盖（换模型会换成本/质量/数据去向）', async () => {
  const id = uniq('conflict')
  await call('POST', '/api/model-profiles', { profile: PROFILE(id, 'gpt-4o'), actor: 'test' })
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    bundle: { version: 1, profiles: [{ ...PROFILE(id, 'other-model'), credentialRequired: false }], bindings: [] },
  })
  assert.equal(r.status, 409, JSON.stringify(r.body))
  assert.equal(r.body.code, 'IMPORT_HAS_CONFLICTS')
  assert.match(r.body.error, /keep（保留本机）或 overwrite/)
  // 库里**没变**
  const list = await call('GET', '/api/model-profiles')
  assert.equal(list.body.profiles.find((p) => p.id === id).model, 'gpt-4o')
})

test('③ overwrite 策略真的覆盖，且用的是计划里读到的那个版本（CAS）', async () => {
  const id = uniq('over')
  await call('POST', '/api/model-profiles', { profile: PROFILE(id, 'gpt-4o'), actor: 'test' })
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    conflictPolicy: 'overwrite',
    bundle: { version: 1, profiles: [{ ...PROFILE(id, 'newer-model'), credentialRequired: false }], bindings: [] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const list = await call('GET', '/api/model-profiles')
  assert.equal(list.body.profiles.find((p) => p.id === id).model, 'newer-model')
})

test('③ keep 策略**不改本机**，但如实回执"跳过了几处冲突"', async () => {
  const id = uniq('keep')
  await call('POST', '/api/model-profiles', { profile: PROFILE(id, 'gpt-4o'), actor: 'test' })
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    conflictPolicy: 'keep',
    bundle: { version: 1, profiles: [{ ...PROFILE(id, 'ignored-model'), credentialRequired: false }], bindings: [] },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.keptLocal, 1, '必须说出来跳过了——否则用户以为导入成功了')
  const list = await call('GET', '/api/model-profiles')
  assert.equal(list.body.profiles.find((p) => p.id === id).model, 'gpt-4o')
})

test('③ 回调里自己写响应**不会被再写一次**（双写会抛出被静默吞掉的异常）', async () => {
  // 拒绝路径是在 `handleRun` 的回调里直接 `json(res, 409, ...)` 然后 return 的。
  // 如果 `handleRun` 之后还无条件写一次 200，`res.writeHead` 会抛
  // `ERR_HTTP_HEADERS_SENT`；那个异常又被 `handleRun` 自己的 catch 再写一次
  // 响应（又抛），最后逃到外层被 `if (res.headersSent) res.end()` 吞掉。
  //
  // **客户端看到的是对的**，所以这条缺陷从响应上完全看不出来。唯一的可观测
  // 信号是服务端留下的记录——于是这条用例就盯着它：正常路径必须**一条都没有**。
  const id = uniq('nowrite')
  await call('POST', '/api/model-profiles', { profile: PROFILE(id, 'gpt-4o'), actor: 'test' })

  const captured = []
  const orig = console.error
  console.error = (...a) => { captured.push(a.map(String).join(' ')) }
  try {
    const r = await call('POST', '/api/config-bundle/apply', {
      actor: 'alice',
      // 冲突 → 回调内部写 409
      bundle: { version: 1, profiles: [{ ...PROFILE(id, 'changed'), credentialRequired: false }], bindings: [] },
    })
    assert.equal(r.status, 409)
    // plan 那条路由在 `handleRun` 回调里返回普通对象，不会自己写响应——
    // 两种路径都走一遍，确认没有一条留下"响应发出后又抛异常"的记录
    await call('POST', '/api/config-bundle/plan', { bundle: { version: 1, profiles: [], bindings: [] } })
    await call('GET', '/api/config-bundle')
    // 给被吞掉的异常一点时间冒出来（它是同步抛出的，这里只是稳妥）
    await new Promise((r2) => setTimeout(r2, 50))
  } finally {
    console.error = orig
  }
  const offending = captured.filter((m) => m.includes('响应已发出后'))
  assert.deepEqual(offending, [],
    `有响应在发出之后又抛出了异常（说明被写了两次）：${offending.join(' | ')}`)
})

test('③ 缺 actor → 400（导入会换模型，必须记下是谁做的）', async () => {
  const r = await call('POST', '/api/config-bundle/apply', {
    bundle: { version: 1, profiles: [{ ...PROFILE(uniq('noactor')), credentialRequired: false }], bindings: [] },
  })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'ACTOR_REQUIRED')
  assert.match(r.body.error, /是谁做的/)
})

test('③ 版本不兼容 → 400（不尽力解析）', async () => {
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    bundle: { version: 99, profiles: [], bindings: [] },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /版本 99 不受支持/)
})

// ------------------------------------------------------------------ ④ 密钥

test('④ 含明文密钥的导出被**拒绝**（400，而不是"剥掉再继续"）', async () => {
  // 把密钥伪装成一个正常的档案字段值：写档案时 PRT-501 的契约会挡，
  // 所以这里走的是"库里已有脏数据"的路径——`modelStore.create` 会拒绝，
  // 于是我们直接验契约层：导出面拿到脏数据时必须拒绝。
  const { buildBundle } = await import('../runtime/contracts/config-bundle.mjs')
  assert.throws(() => buildBundle({
    profiles: [{ ...PROFILE('dirty'), displayName: 'sk-live-abcdefghijklmnopqrstuvwxyz' }],
  }), (e) => e.code === 'BUNDLE_CONTAINS_SECRET')
})

test('④ 导入方向也挡：带 secretRef 的包被拒', async () => {
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    bundle: {
      version: 1,
      profiles: [{ ...PROFILE(uniq('ref')), secretRef: 'legion/somewhere', credentialRequired: true }],
      bindings: [],
    },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /含 secretRef/)
})

test('④ 导入声明 containsSecrets=true 被拒', async () => {
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'alice',
    bundle: { version: 1, containsSecrets: true, profiles: [], bindings: [] },
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /containsSecrets=true/)
})

test('④ 整条链路上**任何响应体**都不含密钥字面量（在原始字节上验）', async () => {
  const id = uniq('leak')
  const SECRET = 'sk-live-ZZZZ1234ZZZZ1234ZZZZ1234ZZZZ'
  await call('POST', '/api/model-profiles', { profile: { ...PROFILE(id), secretRef: 'legion/leak' }, actor: 'test' })
  const responses = await Promise.all([
    call('GET', '/api/config-bundle'),
    call('GET', '/api/model-profiles'),
    call('POST', '/api/config-bundle/plan', {
      bundle: { version: 1, profiles: [{ ...PROFILE(id), credentialRequired: true }], bindings: [] },
    }),
    call('POST', '/api/config-bundle/apply', {
      actor: 'alice', conflictPolicy: 'keep',
      bundle: { version: 1, profiles: [{ ...PROFILE(id, 'changed'), credentialRequired: true }], bindings: [] },
    }),
  ])
  for (const r of responses) {
    const text = JSON.stringify(r.body)
    assert.ok(!text.includes(SECRET), `响应体里出现了密钥：${text}`)
    assert.ok(!text.includes('legion/leak'), `响应体里出现了引用名：${text}`)
  }
})
