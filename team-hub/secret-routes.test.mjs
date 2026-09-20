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

// ============================================================================
// ④ PRT-316 切片 6：secrets 族搬进 `routes/secrets.mjs` 之后的**缝上契约**
//
// 为什么补：破验 11 条变异，第一轮只咬住 9 条，两条漏网（其中一条还先报"锚点没命中"）：
//
//   ★★ K2「rotate 的 `endsWith('/rotate')` 判据失效（只要前缀对就算命中）」没被咬住。
//      `POST /api/secrets/<任意东西>` 会被**当成一次轮换请求**，而既有 15 例
//      一条都没说过这件事 —— 它们只打过 `POST /api/secrets//rotate`（空 ref），
//      从没打过一个"前缀对、后缀不对"的路径。
//
//      > 一个"前缀 + 后缀"的匹配，与一个"只有前缀"的匹配，
//      > 在用例只喂过**后缀刚好正确**的那些输入时是同一个东西。
//
//      ★ 本族是本仓库第一次出现**前缀**路由。前五族全是等值路由，
//        "匹配方式"这一维在它们身上根本不存在，所以这一类洞到现在才有机会露出来。
//
//   ★ K6 / K8 / K10 三条漏网有**同一个根因**，值得单独写下来：
//     运行中的 hub 里 `secretAdmin()` 是**懒构造 + 无注入点**的
//     （`server.mjs` 里写死 `createHubSecretAdmin({ env: process.env })`），
//     所以 CI 上它一定打不开 ⇒ 三条**写**路由一律 503 ⇒
//     "删除该调 remove 还是 list"、"响应里有没有夹带明文"在 **HTTP 面**上不可观测。
//
//      > 一个"写路径全都 503"的环境，与一个"写路径的语义都正确"的实现，
//      > 在只看状态码的用例上是同一个东西。
//
//      ⇒ 判据改打在**缝**上：直接构造 `createSecretsRoutes` 并注入**计数桩**
//        （与切片 4/5 同一手法）。缝以下不需要真实密钥库，所以这一次它们**是可观测的**。
//
// ▲ 既有 15 例仍在**真 hub** 上验（不替换、不删除）。
// ▲ 追加而非新建文件：`git ls-files "*.test.mjs"` 的条数被 `boundary-facts` 钉着。
// ============================================================================

import { createSecretsRoutes } from './routes/secrets.mjs'

/** 真 hub 对"没有路由认领"的路径给出的答复（`server.mjs` 末尾那条兜底）。 */
const isRouted = (r) => !(r.status === 404 && String(r.body?.error ?? '').startsWith('not found:'))
const isUnrouted = (r) => r.status === 404 && String(r.body?.error ?? '').startsWith('not found:')

test('④ ★ 前缀 + 后缀：`POST /api/secrets/<ref>`（**没有** /rotate）不许被当成轮换', async () => {
  // 这一条就是 K2 的正解：如果 `matches()` 丢掉 `endsWith`，它会是 503（路由认领了，
  // 只是密钥库打不开），而不是兜底 404。
  //
  // ★ 我第一版把 `/api/secrets/rotate` 也列进来了，它**是错的**：
  //   前缀 `/api/secrets/` 与后缀 `/rotate` 都命中，切出来的 ref 恰好是空串
  //   → 400 MISSING_PARAM。这是一个**合法匹配**，不是越界。
  //   （*一个"看起来像后缀本身"的路径，与一个"前缀加一个空 ref"的路径，
  //   在字符串上是同一个东西* —— 只有真跑一遍才知道它归谁。）
  for (const p of ['/api/secrets/some-ref', '/api/secrets/some-ref/rotateX']) {
    const r = await call('POST', p)
    assert.ok(isUnrouted(r),
      `${p} 被某条路由认领了（status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}）`
      + ' —— 它既不是 /api/secrets 也不是以 /rotate 结尾的轮换路径，必须落到兜底 404')
  }
  // 正面确认那条"看起来像后缀"的路径确实归本族（且落到空 ref 的 400）
  const bare = await call('POST', '/api/secrets/rotate')
  assert.equal(bare.status, 400)
  assert.equal(bare.body.code, 'MISSING_PARAM', '`/api/secrets/rotate` 是一个**空前缀 ref**，不是越界')
})

test('④ 前缀 + 后缀：**合法**的轮换路径必须真的被认领（正面对照）', async () => {
  // 与上一条配对的正面控制：没有它，"一律不认领"也能让上一条通过。
  const r = await call('POST', '/api/secrets/some-ref/rotate', { value: 'v' })
  assert.ok(isRouted(r), `轮换路径没有被认领（status=${r.status}）`)
})

test('④ 前缀：`DELETE /api/secrets/<ref>` 被认领，而 `DELETE /api/secrets` 不被认领', async () => {
  // 前缀是 `/api/secrets/`（**带**尾斜杠）：`/api/secrets` 不匹配。
  // 少了这条，"把 prefix 写成 /api/secrets"（少一个斜杠）这种改动不会被发现 ——
  // 那会让 `DELETE /api/secrets` 被当成 `ref = ''` 的删除，而不是兜底 404。
  const bare = await call('DELETE', '/api/secrets')
  assert.ok(isUnrouted(bare), `DELETE /api/secrets 被认领了（status=${bare.status}）—— 前缀不该匹配它`)
  const withRef = await call('DELETE', '/api/secrets/some-ref')
  assert.ok(isRouted(withRef), `DELETE /api/secrets/<ref> 没有被认领（status=${withRef.status}）`)
})

test('④ 两条 GET 必须各归各的：`/api/secrets/status` 不是列表，`/api/secrets` 不是状态', async () => {
  const st = await call('GET', '/api/secrets/status')
  assert.equal(st.status, 200)
  assert.ok(!('secrets' in st.body), `状态端点回了列表形状：${JSON.stringify(st.body).slice(0, 120)}`)
  const list = await call('GET', '/api/secrets')
  assert.ok(!('status' in list.body),
    `列表端点回了状态形状（status=${list.status}）：${JSON.stringify(list.body).slice(0, 120)}`)
})

test('④ ★ 记录既有不对称：轮换**不**拒绝多段 ref，删除**拒绝**（本片不改，只钉住）', async () => {
  // 这是搬运**之前**就有的行为差异，不是本片引入的：
  //   · `POST .../rotate` 没有 `includes('/')` 判据 ⇒ `a/b` 会被原样交给密钥库；
  //   · `DELETE /api/secrets/a/b` 有 ⇒ 400 BAD_ID_ENCODING。
  // 本片只搬路由、不改语义，所以把它钉成契约；否则下一个人会把
  // "删除会拒多段" 顺手推广到轮换，或者反过来，而两者都是行为变更。
  const rot = await call('POST', '/api/secrets/a/b/rotate', { value: 'v' })
  assert.ok(isRouted(rot), `轮换没认领多段 ref（status=${rot.status}）—— 既有行为是被认领`)
  assert.notEqual(rot.status, 400, '轮换对多段 ref 不该报 400（它没有那道教判据）')
  const del = await call('DELETE', '/api/secrets/a/b')
  assert.equal(del.status, 400)
  assert.equal(del.body.code, 'BAD_ID_ENCODING')
})

test('④ 段的边界：别的命名空间不许被本族吃掉', async () => {
  // 前缀路由最容易越界。这几条都在 `/api/secrets` 的"邻接"位置：
  // `/api/secret`（少一个 s）、`/api/secretsX`（多一个字符）、
  // `/api/secrets/status/x`（状态端点后面还有一段）。
  for (const [m, p] of [['GET', '/api/secret'], ['GET', '/api/secretsX'], ['GET', '/api/secrets/status/x'],
    ['GET', '/api/secrets/statusx']]) {
    const r = await call(m, p)
    assert.ok(isUnrouted(r), `${m} ${p} 被认领了（status=${r.status}）`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 缝上的**注入桩**判据 —— 补 K6 / K8 / K10
//
// 为什么必须下到这一层：真 hub 里 `secretAdmin()` 没有注入点，CI 上必然打不开，
// 于是三条写路由一律 503，"调了哪个方法"与"回了什么字段"在 HTTP 面**不可观测**。
// 注入桩把这两件事变回可观测的。
// ══════════════════════════════════════════════════════════════════════════

/** 会记录调用的假管理面 + 假 `handleRun`（body 里带一个可辨认的明文）。 */
function secSpy(over = {}) {
  const calls = []
  const admin = {
    describe: async () => { calls.push(['describe']); return { ok: true, code: 'C', message: 'm', aclVerified: true, count: 0 } },
    list: async () => { calls.push(['list']); return { entries: [{ ref: 'leaked-ref' }], aclVerified: true } },
    put: async (a) => { calls.push(['put', a]); return { meta: { ref: a.ref }, aclVerified: true, acl: { ok: true }, aclNote: 'n' } },
    rotate: async (a) => { calls.push(['rotate', a]); return { meta: { ref: a.ref }, aclVerified: true, acl: { ok: true }, aclNote: 'n' } },
    remove: async (r) => { calls.push(['remove', r]); return { removed: true, aclVerified: true, acl: { ok: true }, aclNote: 'n' } },
  }
  Object.assign(admin, over.admin ?? {})
  const sent = []
  const deps = {
    json: (_res, code, obj) => { sent.push([code, obj]) },
    secretAdmin: () => admin,
    // 与真 `handleRun(req, res, fn)` 同形：路由体的 `fn` 收到 (body, by)。
    // ★★ `handleRun` **本身就是应答方** —— 它把回调返回的对象序列化出去
    //    （路由体里只有 `await handleRun(...)` + `return`，没有 `json(res, 200, …)`）。
    //    所以桩必须把返回值记成 200，否则"响应里有没有夹带明文"这一条
    //    会看到**空响应**，而空响应会让 `includes('SECRETVALUE') === false` **恒真**
    //    —— 那正好是要防的那种假绿（*一个"没观测到"，与一个"观测到没有"，在断言上是同一个 false*）。
    handleRun: async (_req, _res, fn) => {
      calls.push(['handleRun'])
      const out = await fn({ actor: 'me', ref: 'spy-ref', value: 'SECRETVALUE', purpose: 'spy-purpose' }, 'me')
      sent.push([200, out])
      return out
    },
    audit: (...a) => { calls.push(['audit', ...a]) },
    readScope: () => 'general',
  }
  Object.assign(deps, over.deps ?? {})
  const fam = createSecretsRoutes(deps)
  const dispatch = (method, target) => {
    const url = new URL(`http://x${target}`)
    return fam.dispatch({ method, headers: {} }, {}, { path: url.pathname, url })
  }
  return { dispatch, calls, sent }
}
const last = (calls, n) => calls.filter((c) => c[0] === n).at(-1)

test('⑤ ★ K8：`DELETE` 必须调 `remove(ref)`，**不是** `list`', async () => {
  const s = secSpy()
  assert.equal(await s.dispatch('DELETE', '/api/secrets/spy-ref'), true)
  assert.ok(last(s.calls, 'remove'), `DELETE 没有调 remove（调了：${s.calls.map((c) => c[0]).join(',')}）`)
  assert.equal(last(s.calls, 'remove')[1], 'spy-ref', 'ref 没有从 URL 里切对')
  assert.equal(s.calls.filter((c) => c[0] === 'list').length, 0, 'DELETE 碰到了 list —— 写路径挂到了只读动作上')
  assert.equal(s.calls.filter((c) => c[0] === 'describe').length, 0, 'DELETE 碰到了 describe')
})

test('⑤ ★ K10：写入响应里**永远没有值**（元数据照给，明文一个字节都不许出现）', async () => {
  for (const [m, p] of [['POST', '/api/secrets'], ['POST', '/api/secrets/spy-ref/rotate']]) {
    const s = secSpy()
    assert.equal(await s.dispatch(m, p), true)
    const [code, body] = s.sent.at(-1) ?? []
    assert.equal(code, 200, `${m} ${p} 没有 200：${JSON.stringify(s.sent)}`)
    assert.equal(JSON.stringify(body).includes('SECRETVALUE'), false,
      `${m} ${p} 的响应里出现了明文：${JSON.stringify(body).slice(0, 200)}`)
    // 正面：元数据必须照给，且 aclVerified / aclNote 一起给
    //（"没核验过"不能看起来像"已确认安全"）
    for (const k of ['secret', 'aclVerified', 'acl', 'aclNote']) {
      assert.ok(k in body, `${m} ${p} 的响应缺 ${k}`)
    }
  }
})

test('⑤ ★ K6：轮换会对 URL 段做解码，非法编码 → 400（不是把原串下传）', async () => {
  const bad = secSpy()
  assert.equal(await bad.dispatch('POST', '/api/secrets/%E0%A4%A/rotate'), true)
  assert.equal(bad.sent.at(-1)?.[0], 400, `非法编码没有 400：${JSON.stringify(bad.sent)}`)
  assert.equal(bad.sent.at(-1)?.[1]?.code, 'BAD_ID_ENCODING')
  assert.equal(bad.calls.filter((c) => c[0] === 'rotate').length, 0, '非法编码仍然调了轮换')
  // 正面：合法的百分号编码要被**解码**后下传
  const ok = secSpy()
  assert.equal(await ok.dispatch('POST', '/api/secrets/a%2Fb/rotate'), true)
  assert.equal(last(ok.calls, 'rotate')?.[1]?.ref, 'a/b', 'URL 段没有被解码')
})

test('⑤ 轮换调的是 `rotate`、写入调的是 `put`（动作不许串）', async () => {
  const r = secSpy()
  await r.dispatch('POST', '/api/secrets/spy-ref/rotate')
  assert.ok(last(r.calls, 'rotate'), '轮换没有调 rotate')
  assert.equal(r.calls.filter((c) => c[0] === 'remove').length, 0)
  const w = secSpy()
  await w.dispatch('POST', '/api/secrets')
  assert.ok(last(w.calls, 'put'), '写入没有调 put')
  // 审计必须发出来（写动作静默发生是最坏的一种）
  assert.ok(last(r.calls, 'audit')?.includes('secret:rotate'), '轮换没有留审计')
  assert.ok(last(w.calls, 'audit')?.includes('secret:put'), '写入没有留审计')
})

test('⑤ 状态/列表两条只读路由不许互换（引用名不能漏进自检形态）', async () => {
  const st = secSpy()
  await st.dispatch('GET', '/api/secrets/status')
  assert.ok(last(st.calls, 'describe'), 'status 没有调 describe')
  assert.equal(st.calls.filter((c) => c[0] === 'list').length, 0, 'status 碰到了 list')
  assert.equal(JSON.stringify(st.sent.at(-1)?.[1] ?? {}).includes('leaked-ref'), false,
    'status 的响应里出现了引用名')
  const li = secSpy()
  await li.dispatch('GET', '/api/secrets')
  assert.ok(last(li.calls, 'list'), 'GET /api/secrets 没有调 list')
  assert.equal(li.calls.filter((c) => c[0] === 'describe').length, 0)
})
