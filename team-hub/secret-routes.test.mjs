// team-hub/secret-routes.test.mjs
// ============================================================================
// 凭证管理的 **HTTP 契约**（spec §6.7）
//
// 上一组（`secret-admin.test.mjs`）验管理面本身；这一组验**从 HTTP 进来的那条路**，
// 以及本节最要害的那根线：**写成功之后探测缓存必须失效**。
//
// ## 为什么这组要单独存在
//
// `probe-service.mjs:39` 早就写着：
//
//   > 提供一个 `invalidate()` 由轮换/修改凭证的路径调用
//
// 而它**从来没有被调用过**——因为写路径不存在，两条线一直在互相等。
// 一份"接上了"的声明与一根没接的线，在"能不能用"上是同一个答案，
// 所以这一组不验声明，验**调用计数**。
//
// 接线本身在 `server.mjs` 的 `createHubSecretAdmin` 里。它被导出就是为了
// 让这里能验它：藏在懒构造闭包里的接线，只能靠"让真实服务器去开真实密钥库"
// 来验，而那条路在 CI 上走不通（没有 DPAPI 账户、没有可写的产品布局）。
//
// ## 这一组**不碰真实密钥库**
//
// 它用真实 HTTP 服务器 + 真实路由，但密钥库用注入的假实现。
// 理由不是省事：真实密钥库在 CI 上打不开，而"打不开"会让所有写入用例
// 走在同一条错误分支上——那看起来像"全绿"，实际一条都没验到。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubSecretAdmin } from './server.mjs'
import { createProtector, createSecretStore, memoryBackend } from '../security/secrets/store.mjs'
import { ACL_CODES } from '../security/secrets/acl.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-secretroutes-'))
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
  // `raw` 保留原始响应文本：验"没有密钥"必须在**序列化后**的字节上看。
  return { status: res.status, body: parsed, raw: text }
}

const protector = () => createProtector({
  scheme: 'dpapi-user',
  protect: (v) => `ENC[${Buffer.from(v, 'utf8').toString('base64')}]`,
  unprotect: (b) => Buffer.from(String(b).slice(4, -1), 'base64').toString('utf8'),
})

const SECRETS_FILE = 'C:\\Users\\a\\AppData\\Local\\Legion\\secrets\\credentials.json'
/** 布局是写死的：用例不解析真实产品目录（CI 上没有可写的产品家目录）。 */
const LAYOUT_OK = () => ({ layout: { secretsFile: SECRETS_FILE }, diagnostics: [] })
const ACL_OK = Object.freeze({
  ok: true, code: ACL_CODES.OK, message: '文件访问控制：仅所有者可读写',
  principals: [], owner: null, platform: 'win32', skipped: false,
})

/** 假的 `openProductSecrets`：真 store、确定的 ACL 结论。 */
function fakeOpen(store) {
  return async () => ({
    ok: true, code: 'SECRETS_OK', message: '密钥库可用',
    path: SECRETS_FILE, store, resolver: { resolveSecret: async () => 'v' },
    protection: { scheme: 'dpapi-user', protected: true },
    acl: ACL_OK, aclVerified: true, aclExists: true, count: null,
  })
}

// ============================================================================
// ① 这根线：写成功 → 探测缓存失效
// ============================================================================

test('① **轮换凭证之后探测缓存真的失效了**（这就是 invalidate 一直缺的调用方）', async () => {
  const invalidations = []
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
    getProbeService: () => ({ invalidate: () => { invalidations.push('called'); return 1 } }),
  })
  await a.put({ ref: 'K1', value: 'v1' })
  await a.rotate({ ref: 'K1', value: 'v2' })
  await a.remove('K1')
  // **计数**，不是"有没有这个字段"。声明与事实在计数上才分得开。
  assert.equal(invalidations.length, 3,
    '新增/轮换/删除都必须让探测缓存失效；否则点「测试连接」拿到的是**用旧钥匙得出的旧结论**')
})

test('① 写入失败时**不**失效（一次没发生的变更不该看起来发生了）', async () => {
  const invalidations = []
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
    getProbeService: () => ({ invalidate: () => { invalidations.push('called'); return 1 } }),
  })
  const err = await a.rotate({ ref: 'NOPE', value: 'v' }).then(() => null, (e) => e)
  assert.equal(err.code, 'SECRET_NOT_FOUND')
  assert.deepEqual(invalidations, [], '轮换失败不该发"凭证变了"')

  // **两条路的 catch 是两处代码**，所以两条都要走一遍。
  // 只验 rotate 的话，把 put 的失败路径写成"先失效再抛"照样绿。
  const err2 = await a.put({ ref: '', value: 'v' }).then(() => null, (e) => e)
  assert.equal(err2.code, 'SECRET_REF_INVALID')
  assert.deepEqual(invalidations, [], '新增失败同样不该发"凭证变了"')
})

test('① 失效回调抛错**不能**把一次成功的写入报成失败（两个后果不许互相污染）', async () => {
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
    getProbeService: () => ({ invalidate: () => { throw new Error('失效炸了') } }),
  })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1')
})

test('① 探测服务**还没构造**时不去构造它（没缓存可失效，不为失效开一次密钥库）', async () => {
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    getProbeService: () => null,
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
  })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1', '没有探测服务不该影响写入本身')
})

test('① 探测服务存在时**一定**失效（这就是 `invalidate` 一直缺的调用方）', async () => {
  const invalidations = []
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    getProbeService: () => ({ invalidate: () => { invalidations.push(1); return 1 } }),
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
  })
  await a.put({ ref: 'K1', value: 'v' })
  assert.equal(invalidations.length, 1)
})

test('① 没给探测服务访问器时也能用（默认取真实生产线，此时它还没构造）', async () => {
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })),
  })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1')
})

test('① 传给密钥库的 owner 是**从 OS 变量派生的那个**（不是 null，也不是猜的）', async () => {
  // 这条用例是补的，理由是上一版**观测不到**它：所有用例都注入假的
  // `openSecrets`，而 owner 只对**真实**的 `openProductSecrets` 有意义，
  // 于是把生产那行改成 `owner: null` 没有任何用例会红——
  //   > 一个观测不到的取值，与一个没有取值，在"有没有配错"上是同一个答案。
  // 观测点就在注入函数收到的实参上：那是真实实现**必须**拿到的东西。
  const owners = []
  const a = createHubSecretAdmin({
    env: { USERNAME: 'x', USERDOMAIN: 'AMENCH' },
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: async (args) => {
      owners.push(args.owner)
      return await fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' }))(args)
    },
  })
  await a.put({ ref: 'K1', value: 'v' })
  // Windows 上 `icacls` 的输出**不标出**所有者，而复核
  // （`evaluateWindowsPrincipals`）是按名字比对的——`AMENCH\\x` 与 `x` 不相等，
  // 所以域必须一起拼。少拼域会让复核**永远通不过**，而那是静默的。
  assert.equal(owners[0], 'AMENCH\\x', '域必须一起拼，否则复核永远通不过')
})

test('① 拿不到账户名时 owner 是 null（fail closed：不猜一个主体去授权）', async () => {
  // 猜错的失败方向是 **fail open**——把权限给错人。所以这里要求如实给 null，
  // 让 `hardenFileAcl` 自己报 HARDEN_FAILED，而不是"看起来加固过了"。
  const owners = []
  const a = createHubSecretAdmin({
    env: {},
    resolveLayoutImpl: LAYOUT_OK,
    openSecrets: async (args) => {
      owners.push(args.owner)
      return await fakeOpen(createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' }))(args)
    },
  })
  await a.put({ ref: 'K1', value: 'v' })
  assert.equal(owners[0], null)
})

// ============================================================================
// ② 路由：进得来的那几条路
// ============================================================================

test('② 缺 `secretRef` → 400（配置错误先于状态检查）', async () => {
  const del = await call('DELETE', '/api/secrets/')
  assert.equal(del.status, 400)
  assert.equal(del.body.code, 'MISSING_PARAM')
})

test('② `secretRef` 含斜杠 → 400（多段路径不是引用名，不去猜用户想要哪一个）', async () => {
  const r = await call('DELETE', '/api/secrets/a/b')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BAD_ID_ENCODING')
})

test('② 非法的 URL 编码 → 400 而不是崩掉', async () => {
  const r = await call('DELETE', '/api/secrets/%E0%A4%A')
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'BAD_ID_ENCODING')
})

test('② 轮换缺 ref → 400', async () => {
  const r = await call('POST', '/api/secrets//rotate', { value: 'v' })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'MISSING_PARAM')
})

test('② 路由真的接到了**真实管理面**（拿到了只有 describe() 才产出的那个形状）', async () => {
  // 上面那几条 400 都发生在调用管理面**之前**，所以它们只证明"路由在"。
  // 这一条走到底：请求 → 真实路由 → 真实 `secretAdmin()` → 真实 `describe()`。
  //
  // 环境里没有可解析的产品布局时 `describe()` 会回一个`ok:false` 的状态；
  // 有布局时会回 `ok:true`。两种都**必须**是 describe 的字段集，
  // 否则说明这条路由后面接的不是它。
  const r = await call('GET', '/api/secrets/status')
  assert.equal(r.status, 200, '状态查询本身是成功的（密钥库不可用是"状态"，不是请求失败）')
  assert.equal(typeof r.body.status, 'object')
  for (const k of ['ok', 'code', 'message', 'aclVerified', 'count']) {
    assert.ok(k in r.body.status, `状态对象缺字段 ${k}：这条路由后面接的可能不是真实的 describe()`)
  }
  assert.equal(typeof r.body.status.ok, 'boolean')
  // **自检形态的结果里没有引用名**（引用名能画出这台机器配了哪些供应商）。
  assert.equal(/vendor-|secretRef|sk-/.test(r.raw), false, `状态响应里出现了引用名或密钥：${r.raw.slice(0, 200)}`)
})

test('② 密钥库不可用时**不降级**：路由回 503 而不是「没人配过凭证」（404）', async () => {
  // 先让**同一个环境下的管理面自己说一遍**，再要求路由给出同一个答案。
  // 这才是"路由背后接的是不是真的管理面"的判据——一句
  // `if (503) … else if (200) …` 是恒真的，一条把异常吞成"0 条凭证"的
  // 实现照样绿，而那正是要防的失败。
  const probe = mod.createHubSecretAdmin({ env: process.env })
  const d = await probe.describe()
  const r = await call('GET', '/api/secrets')

  if (d.ok === true) {
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.body.secrets))
  } else {
    // 密钥库打不开 → **必须**如实报 503，而不是"没有人配过凭证"。
    // 说成后者会让用户去重新录入一把其实好端端躺在本机的钥匙；
    // 而说成 200 + 空列表更糟：它看起来像一次成功的读取。
    assert.equal(r.status, 503,
      `管理面说密钥库不可用（${d.code}），路由却回了 ${r.status} —— 它没有把真实结论送出来`)
    assert.equal(r.body.code, 'SECRET_ADMIN_STORE_UNAVAILABLE')
    assert.notEqual(r.status, 404, '不得把"打不开"报成"没有"')
  }
})

// ============================================================================
// ③ 这几条路由**真的存在于平台契约里**
// ============================================================================

test('③ 凭证管理的路由都进了平台契约基线（漏一条端点却报"与基线一致"是最坏的输出）', async () => {
  const baselinePath = new URL('../docs/superpowers/prt/prt-007-baseline.json', import.meta.url)
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  for (const route of ['GET /api/secrets', 'POST /api/secrets', 'POST /api/secrets/', 'DELETE /api/secrets/', 'GET /api/secrets/status']) {
    assert.ok(baseline.httpRoutes.includes(route),
      `平台契约里缺 ${route}：路由加了但基线没记录，等于它能不经评审地增删`)
  }
})
