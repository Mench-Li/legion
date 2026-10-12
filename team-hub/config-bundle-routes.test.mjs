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
  const pv = uniq('leakpv')
  const SECRET = 'sk-live-ZZZZ1234ZZZZ1234ZZZZ1234ZZZZ'
  await call('POST', '/api/model-profiles', { profile: { ...PROFILE(id), secretRef: 'legion/leak' }, actor: 'test' })
  // ★★ 2026-10-12：**多加一个端点、并加一条"这一步真的造出了泄漏面"的前置自检**。
  //
  //   这条用例原先只列了 4 个端点，于是 `/api/model-providers` 把
  //   `credential.ref`（= `secretRef` 的槽位名）吐出去时，它**一声不吭** ——
  //   而那个字段与档案那条路上的字段是同一个坑，只是端点不同。
  //
  //   这暴露的是这条判据自己的形状问题：**端点靠手列**，所以"新加了会泄漏的端点"
  //   在它的读数里和"没有任何端点泄漏"是同一个东西。
  //   （彻底的解法是按键名遍历所有读路由，那是另一件事；这里先补上已知会带凭证的两个。）
  //
  //   ★ 供应商的 `secretRef` 用的是**另一套**校验（POSIX 标识符，不许带斜杠：
  //     `provider-store.mjs` 的 `SECRET_REF_RE`），所以这里另起一个合法名 ——
  //     沿用 `legion/leak` 会被 400 挡在门外，于是"那一行没有泄漏"测的是
  //     "那一行根本没建起来"。这正是上面那条前置自检存在的理由。
  const PV_REF = 'LEGION_LEAK_REF'
  await call('POST', '/api/model-providers', {
    provider: { id: pv, displayName: '泄漏面', api: 'openai-responses', baseURL: 'https://x.example/v1', secretRef: PV_REF },
    actor: 'test',
  })
  const responses = await Promise.all([
    call('GET', '/api/config-bundle'),
    call('GET', '/api/model-profiles'),
    call('GET', '/api/model-providers'),
    call('POST', '/api/config-bundle/plan', {
      bundle: { version: 1, profiles: [{ ...PROFILE(id), credentialRequired: true }], bindings: [] },
    }),
    call('POST', '/api/config-bundle/apply', {
      actor: 'alice', conflictPolicy: 'keep',
      bundle: { version: 1, profiles: [{ ...PROFILE(id, 'changed'), credentialRequired: true }], bindings: [] },
    }),
  ])
  // 前置自检：**库里这条供应商必须真的带着引用名**，否则"响应里没有它"测的是
  //   "库里本来就没有它"。
  //   > 一个"过滤掉了它"的判据，与一个"库里本来就没有它"的判据，
  //   > 在库里没有它的时候是同一个东西。
  //
  //   没有 `GET /api/model-providers/<id>` 这条路（这一族的 by-id 只有 DELETE），
  //   所以自检不靠另一次请求，而靠**同一个响应里的 `hasRef`**：
  //   `hasRef === true` 证明库里的这一行**确实有** `secretRef`，
  //   而下面的字节断言证明它的**名字**没跟着出去。
  //   两条合起来才是"没泄漏"，单看后者会假绿。
  const providers = await call('GET', '/api/model-providers')
  const mine = (providers.body?.providers ?? []).find((p) => p.id === pv)
  assert.ok(mine !== undefined, '前置条件不成立：刚建的供应商不在列表里')
  assert.ok(mine.credential !== undefined, '核验结果被整段删掉了 —— 那是把仪表盘拆了来修漏水')
  assert.equal(mine.credential.hasRef, true, '要能表达"引用了某把钥匙"，只是不说它叫什么')

  // ★★ 2026-10-12（BUG-028 **已修**，这条断言随之翻转）：供应商这一族**也不再**发引用名。
  //
  //   上一版这里写的是 `assert.equal(mine.secretRef, PV_REF)` 并附了一句
  //   "修 BUG-028 时这条要翻转成 `?? null`" —— 那个"必须翻转的信号"就在下面。
  //   现在两件事一起验：
  //     ① 那个键**根本不在**（不是"值是 null"：一个 `secretRef: null` 的字段仍然在
  //        教客户端"这里有个叫 secretRef 的东西"，而它不该参与客户端的心智模型）；
  //     ② 同一行**仍然说得清**"我引用了凭证"（`credentialRequired` / `credential.hasRef`）——
  //        否则修法就成了"把仪表盘拆了来修漏水"。
  assert.equal('secretRef' in mine, false,
    `供应商那一行不该再有 secretRef 键（实际：${JSON.stringify(mine.secretRef)}）`)
  assert.equal(mine.credentialRequired, true, '抹掉名字之后仍要能表达"这条引用了凭证"')

  for (const r of responses) {
    const text = JSON.stringify(r.body)
    assert.ok(!text.includes(SECRET), `响应体里出现了密钥：${text}`)
    assert.ok(!text.includes('legion/leak'), `响应体里出现了档案的引用名：${text}`)
    // ★ BUG-028 修好之后这条不再需要豁免：**所有**响应都不许出现供应商的引用名。
    assert.ok(!text.includes(PV_REF), `这个响应体里出现了供应商的引用名：${text.slice(0, 200)}`)
  }
})

// ============================================================================
// ④b 写凭证：客户端**不需要引用名**（BUG-028 的另一半）
//
// 抹掉读侧的引用名有个直接后果：面板**没有名字**能拿去调 `POST /api/secrets` 了。
// 于是"用户填的那把新钥匙写进哪个槽位"必须由**服务端**决定 —— 请求带 `credentialValue`，
// 服务端用那一行**已有的**名字（可能是 DSH 导进来的 `apiKeyEnv`，两侧靠它对齐），
// 没有才用派生名。
//
// 为什么不能"让客户端自己算派生名"：从 DSH 导入的行，其引用名是 DSH 侧的键名，
// 派生名与它**不一定相同**。客户端算错的表现是"新钥匙写进了另一个槽位、行仍指旧槽位"
// ⇒ 界面说保存成功、跑起来仍然认证失败。
// ============================================================================

test('④b ★★ 带 `credentialValue` 的更新 ⇒ 服务端按**已有**引用名去写（客户端全程不知道名字）', async () => {
  const pv = uniq('credwrite')
  const REF = 'LEGION_CRED_WRITE_REF'
  await call('POST', '/api/model-providers', {
    provider: { id: pv, displayName: '写凭证', api: 'openai-responses', baseURL: 'https://x.example/v1', secretRef: REF },
    actor: 'test',
  })
  const before = await call('GET', '/api/model-providers')
  const row = (before.body?.providers ?? []).find((p) => p.id === pv)
  assert.equal(row?.credential?.hasRef, true, '前提：这条在库里确实有引用名')
  assert.equal('secretRef' in row, false, '前提：读侧不给名字（否则下面的断言测不到东西）')

  // 这次请求**只带值**，不带名字
  const updated = await call('POST', `/api/model-providers/${encodeURIComponent(pv)}`, {
    actor: 'test', version: row.version,
    provider: {
      id: pv, displayName: '写凭证', api: 'openai-responses', baseURL: 'https://x.example/v1',
      runtimeType: 'dsh', models: [{ id: 'm1' }],
    },
    credentialValue: 'sk-live-SHOULD-NOT-ECHO-BACK-0123456789',
  })
  // 一个没接密钥库 / 密钥库打不开的部署必须**具名失败**，而不是静默忽略 ——
  // 静默忽略的表现正是"面板说保存成功、钥匙其实没进去"。
  // 两种具名结果都算通过（400 = 这个部署没接密钥库；503 = 接了但本测试环境的产品目录布局未定），
  // 但**必须带 code**，而且**不许回显值**。
  assert.ok(updated.status === 200 || updated.status === 400 || updated.status === 503,
    `意外的状态：${updated.status} ${JSON.stringify(updated.body).slice(0, 200)}`)
  const text = JSON.stringify(updated.body)
  assert.ok(!text.includes('sk-live-SHOULD-NOT-ECHO-BACK'), '写进去的值不许回显')
  assert.ok(!text.includes(REF), '响应里不许出现引用名')
  if (updated.status !== 200) {
    assert.ok(typeof updated.body?.code === 'string' && updated.body.code !== '',
      `失败必须是具名的（实际：${JSON.stringify(updated.body).slice(0, 200)}）`)
    assert.equal('secretRef' in (updated.body ?? {}), false, '失败的响应里也不许出现引用名')
    return
  }
  // 接了密钥库时：这一行仍然引着**原来那个名字**（派生名不该把它换掉）
  const after = await call('GET', '/api/model-providers')
  const row2 = (after.body?.providers ?? []).find((p) => p.id === pv)
  assert.equal(row2.credential.hasRef, true, '写过凭证之后仍应有引用')
  assert.equal('secretRef' in row2, false, '仍然不发名字')
})

test('④b ★ 显式 `clearCredential` ⇒ 引用被撤掉（"没给"与"要清掉"分开）', async () => {
  const pv = uniq('credclear')
  await call('POST', '/api/model-providers', {
    provider: { id: pv, displayName: '清凭证', api: 'openai-responses', baseURL: 'https://x.example/v1', secretRef: 'LEGION_CLEAR_REF' },
    actor: 'test',
  })
  const before = await call('GET', '/api/model-providers')
  const row = (before.body?.providers ?? []).find((p) => p.id === pv)

  // ① 只改显示名（**不带任何凭证意图**）⇒ 引用必须留着
  const keep = await call('POST', `/api/model-providers/${encodeURIComponent(pv)}`, {
    actor: 'test', version: row.version,
    provider: { id: pv, displayName: '改名不改凭证', api: 'openai-responses', baseURL: 'https://x.example/v1', runtimeType: 'dsh', models: [{ id: 'm1' }] },
  })
  assert.equal(keep.status, 200, `改名失败：${JSON.stringify(keep.body).slice(0, 200)}`)
  const mid = await call('GET', '/api/model-providers')
  const rowMid = (mid.body?.providers ?? []).find((p) => p.id === pv)
  assert.equal(rowMid.credentialRequired, true, '★ 只改显示名**不许**把凭证引用清掉（BUG-028 的读侧改动带来的坑）')

  // ② 显式清掉
  const cleared = await call('POST', `/api/model-providers/${encodeURIComponent(pv)}`, {
    actor: 'test', version: rowMid.version,
    provider: { id: pv, displayName: '改名不改凭证', api: 'openai-responses', baseURL: 'https://x.example/v1', runtimeType: 'dsh', models: [{ id: 'm1' }] },
    clearCredential: true,
  })
  assert.equal(cleared.status, 200, `清凭证失败：${JSON.stringify(cleared.body).slice(0, 200)}`)
  const after = await call('GET', '/api/model-providers')
  const rowAfter = (after.body?.providers ?? []).find((p) => p.id === pv)
  assert.equal(rowAfter.credentialRequired, false, '显式清掉之后就不该再说"引用了凭证"')
  assert.equal(rowAfter.credential.hasRef, false)
})

// ============================================================================
// PRT-316 切片 17 · 契约块 —— 破验量出来"没人问过"的五件事
//
// 第一轮破验（改坏 20 处行为）只咬住 15 处。那 5 条"没咬住"**全是真缺口**，
// 而且其中两条的成因特别值得记：
//
//   ★★ M1/M3：`kind` 过滤**在空库上不可观测**。
//     既有用例确实请求了 `?kind=model-profiles` 并且断言 `bindings` 为空 ——
//     但那时绑定库**本来就是空的**，于是"过滤生效"与"过滤没生效"
//     在那个断言眼里是同一个东西：
//
//       > 一个"过滤掉了它"的判据，与一个"库里本来就没有它"的判据，
//       > 在库是空的时候是同一个东西。
//
//     所以下面这两条**先造出一条绑定**，再断言过滤 —— 让这件事可观测。
//
//   · M8：计划不合法时 `applicable` 必须是 `null`（拿一份坏计划判"能不能应用"
//     会让前端把"计划本身不合法"读成"不可以应用"）；
//   · M14：apply 收到坏包的具名码（实测是 `BUNDLE_PROFILE_INVALID`，**不是** `PROFILE_INVALID`）；
//   · M20：成功 apply 的 `applied` 字段没人断言过。
//
// ★ 期望值全部**先量出来**再写死（`.worktrees/_prt-handoff/probe-slice17-gaps.mjs`）。
//   量出来的两件事改了草稿：档案的体是 `{ actor, profile: {...} }`
//   （顶层并列，不是 `{...profile, actor}`），而绑定要 `actor` 在**自己这一层**。
// ============================================================================

/** 造一条"一定存在"的档案 + 一条指向它的绑定，并返回两者的标识。 */
async function seedBundleContents(tag) {
  const pid = uniq(`${tag}-prof`)
  const role = uniq(`${tag}-role`)
  const cp = await call('POST', '/api/model-profiles', { actor: tag, profile: PROFILE(pid) })
  assert.equal(cp.status, 200, `建档案失败：${JSON.stringify(cp.body).slice(0, 200)}`)
  const cb = await call('POST', '/api/model-bindings', {
    scope: 'default', employeeRole: role, primaryProfile: pid, fallbackProfiles: [], actor: tag,
  })
  assert.equal(cb.status, 200, `建绑定失败：${JSON.stringify(cb.body).slice(0, 200)}`)
  return { pid, role }
}

test('⑤ ★★ 不给 `kind` 时默认导**全量**（不是某个只读子集）', async () => {
  await seedBundleContents('slice17def')
  const r = await call('GET', '/api/config-bundle')
  assert.equal(r.status, 200)
  assert.equal(r.body.bundle.kind, 'full', '不给 kind 必须等价于 kind=full')
  // 全量 ⇒ 档案与绑定**都**在。库此时非空，所以这两条断言是**可观测**的。
  assert.ok(r.body.bundle.profiles.length > 0, '默认全量必须带上档案')
  assert.ok(r.body.bundle.bindings.length > 0,
    '默认全量必须带上绑定 —— 少了它，"导出一份完整配置"这件事就是假的')
})

test('⑥ ★★★ 按 kind 过滤**在有内容时才可观测**（空库上的 [] 什么也证明不了）', async () => {
  const { pid, role } = await seedBundleContents('slice17filter')

  const onlyProfiles = await call('GET', '/api/config-bundle?kind=model-profiles')
  assert.equal(onlyProfiles.status, 200)
  assert.ok(onlyProfiles.body.bundle.profiles.some((p) => p.id === pid), '前提：档案要在包里')
  assert.deepEqual([...onlyProfiles.body.bundle.bindings], [],
    '只要档案时，绑定必须被清空 —— 否则"只要模型"会顺手把绑定也搬走')

  const onlyBindings = await call('GET', '/api/config-bundle?kind=model-bindings')
  assert.equal(onlyBindings.status, 200)
  assert.ok(onlyBindings.body.bundle.bindings.length > 0, '前提：绑定要在包里')
  assert.deepEqual([...onlyBindings.body.bundle.profiles], [],
    '只要绑定时，档案必须被清空 —— 否则一份"只导绑定"的包会覆盖掉别处的档案')
  assert.ok(onlyBindings.body.bundle.bindings.some((b) => b.employeeRole === role || b.primaryProfile === pid),
    '要的是**这一条**绑定，不是"随便有一条"')
})

test('⑦ ★ 计划本身不合法时 `applicable` 必须是 `null`（不是"算出来不可以"）', async () => {
  const r = await call('POST', '/api/config-bundle/plan', { bundle: { version: 99, kind: 'full' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.plan.ok, false, '前提：版本不兼容的计划本身就不合法')
  assert.equal(r.body.applicable, null,
    '"计划不合法"与"计划可以但当前状态不允许"是两件事；都回一个对象会让前端分不清')
})

test('⑧ 导入坏包 ⇒ 400 具名码 `BUNDLE_PROFILE_INVALID`', async () => {
  const r = await call('POST', '/api/config-bundle/apply', { bundle: { version: 99, kind: 'full' }, actor: 'route-test' })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BUNDLE_PROFILE_INVALID',
    '一条没有具名码的 400 让调用方只能去翻源码；也不该把"包不合法"与"状态不允许"混成一个码')
})

test('⑨ ★ 成功导入必须自报 `applied: true`（回执不能含糊）', async () => {
  const id = uniq('slice17applied')
  const r = await call('POST', '/api/config-bundle/apply', {
    actor: 'route-test',
    bundle: {
      version: 1, kind: 'full', containsSecrets: false, credentialRefsIncluded: false,
      profiles: [{ ...PROFILE(id), credentialRequired: false }], bindings: [],
    },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 240))
  assert.equal(r.body.applied, true,
    '一份"请求成功但什么都没应用"的回执与一份"真的应用了"的回执，在只看 status 的人眼里是同一个东西')
  assert.ok(r.body.written.profiles.some((p) => p.id === id), '写进去的档案要在回执里列出来')
})
