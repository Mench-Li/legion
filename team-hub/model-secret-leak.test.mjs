// team-hub/model-secret-leak.test.mjs
// ============================================================================
// 模型配置那一族的**凭证不出站**判据（原住 `config-bundle-routes.test.mjs`）
//
// ## 为什么单独成文件（2026-10-12）
//
// 这两条判据原先住在 `config-bundle-routes.test.mjs` 里 —— 那是配置包（导出/导入
// 模型档案与岗位绑定）的路由判据。配置包后来被**整个删掉**（理由见
// `docs/superpowers/prt/PRT-508-config-import-export.md` 顶部那段），
// 而这两条**与配置包无关**：
//
//   · 它们测的是"**读模型配置的那些端点**会不会把凭证引用名/密钥吐出去"，
//     用的是 `/api/model-profiles` 与 `/api/model-providers` 两个端点的**原始字节**；
//   · 其中那条逐字节判据**当场抓出过 BUG-028**（供应商列表把 `secretRef` 原文发给了客户端）。
//
//   > 一条抓出过真缺陷的判据，如果它恰好住在**另一样东西**的用例文件里，
//   > 那么删那样东西的那一天，它会跟着一起消失 —— 而没有人会注意到，
//   > 因为"它不见了"与"它从来没存在过"在 CI 的读数里是同一个东西。
//
// 所以搬出来独立成文件，而不是陪葬。
//
// ## 自起进程 / 自己的库 / 自己的端口
//
// 路由用例必须能在**并行**跑（共用一个库会让这条用例的读数依赖别条写了什么）。
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
  dbDir = mkdtempSync(join(tmpdir(), 'legion-secretleak-'))
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

test('① 读模型配置的端点：**任何响应体**都不含密钥字面量或引用名（在原始字节上验）', async () => {
  const id = uniq('leak')
  const pv = uniq('leakpv')
  const SECRET = 'sk-live-ZZZZ1234ZZZZ1234ZZZZ1234ZZZZ'
  await call('POST', '/api/model-profiles', { profile: { ...PROFILE(id), secretRef: 'legion/leak' }, actor: 'test' })

  // ★ 端点是**手列**的 —— 这是这条判据已知的形状弱点：新加一个会带凭证的端点，
  //   在它的读数里与"没有任何端点泄漏"是同一个东西。
  //   实测代价：供应商那一族泄漏了很久，而这条判据**一声不吭**
  //   （它当时只列了 4 个端点，其中一个还是配置包自己的）。
  //   彻底的解法是按键名遍历所有读路由，那是另一件事；这里至少把**已知会带凭证的**列全。
  //
  //   ★ 供应商的 `secretRef` 用**另一套**校验（POSIX 标识符，不许带斜杠：
  //     `provider-store.mjs` 的 `SECRET_REF_RE`），所以另起一个合法名 ——
  //     沿用 `legion/leak` 会被 400 挡在门外，于是"那一行没有泄漏"测的是
  //     "那一行根本没建起来"。这正是下面那条前置自检存在的理由。
  const PV_REF = 'LEGION_LEAK_REF'
  await call('POST', '/api/model-providers', {
    provider: { id: pv, displayName: '泄漏面', api: 'openai-responses', baseURL: 'https://x.example/v1', secretRef: PV_REF },
    actor: 'test',
  })

  const responses = await Promise.all([
    call('GET', '/api/model-profiles'),
    call('GET', '/api/model-providers'),
    call('GET', '/api/model-bindings'),
  ])

  // 前置自检：**库里这条供应商必须真的带着引用名**，否则"响应里没有它"测的是
  //   "库里本来就没有它"。
  //   > 一个"过滤掉了它"的判据，与一个"库里本来就没有它"的判据，
  //   > 在库里没有它的时候是同一个东西。
  //
  //   没有 `GET /api/model-providers/<id>` 这条路（这一族的 by-id 只有 DELETE），
  //   所以自检不靠另一次请求，而靠**同一个响应里的 `hasRef`**：
  //   `hasRef === true` 证明库里的这一行**确实有** `secretRef`，
  //   而下面的字节断言证明它的**名字**没跟着出去。两条合起来才是"没泄漏"，单看后者会假绿。
  const providers = await call('GET', '/api/model-providers')
  const mine = (providers.body?.providers ?? []).find((p) => p.id === pv)
  assert.ok(mine !== undefined, '前置条件不成立：刚建的供应商不在列表里')
  assert.ok(mine.credential !== undefined, '核验结果被整段删掉了 —— 那是把仪表盘拆了来修漏水')
  assert.equal(mine.credential.hasRef, true, '要能表达"引用了某把钥匙"，只是不说它叫什么')

  // ★★ 2026-10-12（BUG-028 **已修**，这条断言随之翻转）：供应商这一族**也不再**发引用名。
  //     ① 那个键**根本不在**（不是"值是 null"：一个 `secretRef: null` 的字段仍然在
  //        教客户端"这里有个叫 secretRef 的东西"，而它不该参与客户端的心智模型）；
  //     ② 同一行**仍然说得清**"我引用了凭证"（`credentialRequired` / `credential.hasRef`）——
  //        否则修法就成了"把仪表盘拆了来修漏水"。
  assert.equal('secretRef' in mine, false,
    `供应商那一行不该再有 secretRef 键（实际：${JSON.stringify(mine.secretRef)}）`)
  assert.equal(mine.credentialRequired, true, '抹掉名字之后仍要能表达"这条引用了凭证"')

  for (const r of responses) {
    const text = JSON.stringify(r.body)
    assert.ok(!text.includes(SECRET), `响应体里出现了密钥：${text.slice(0, 200)}`)
    assert.ok(!text.includes('legion/leak'), `响应体里出现了档案的引用名：${text.slice(0, 200)}`)
    assert.ok(!text.includes(PV_REF), `响应体里出现了供应商的引用名：${text.slice(0, 200)}`)
  }

  // 档案那一族同样要能表达"引用了凭证"而**不给名字**
  const profiles = await call('GET', '/api/model-profiles')
  const p = (profiles.body?.profiles ?? []).find((x) => x.id === id)
  assert.ok(p !== undefined, '前置条件不成立：刚建的档案不在列表里')
  assert.equal('secretRef' in p, false, '档案那一行不该有 secretRef 键')
})

// ============================================================================
// ② 写凭证：客户端**不需要引用名**（BUG-028 的另一半）
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

test('② ★★ 带 `credentialValue` 的更新 ⇒ 服务端按**已有**引用名去写（客户端全程不知道名字）', async () => {
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

test('② ★ 显式 `clearCredential` ⇒ 引用被撤掉（"没给"与"要清掉"分开）', async () => {
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
