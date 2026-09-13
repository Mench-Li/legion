// product/launcher/first-run.test.mjs
// PRT-707（接线批）：首次运行向导接真实模块。
//
// 本套件里最要紧的几条，钉的都是**读契约才发现的**东西，不是"函数能跑"：
//   ① 环境探测必须看**存在的最近祖先**（`environment` 跑在 `initialize` 之前，
//      目标目录此时本来就不该存在）；
//   ② 模型档案的更新端点是 `PATCH`，而 hub 客户端的 `call` 只发 POST；
//   ③ 绑定的字段名是 `employeeRole`/`primaryProfile`，不是 `role`/`profileId`；
//   ④ 密钥引用是**算出来的**，因为 hub 的单条档案读取**有意不含 `secretRef`**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_MODEL_PROFILE_ID,
  FIRST_RUN_CODES,
  MIN_NODE_MAJOR,
  MODEL_SECRET_PREFIX,
  createFirstRun,
  firstRunPreconditions,
  modelSecretRefFor,
  nearestExistingDir,
  probeEnvironment,
} from './first-run.mjs'
import { WIZARD_CODES } from './wizard.mjs'

// ── 替身 ────────────────────────────────────────────────────────────────────

/** 密钥库替身。`has` 的默认值是参数——**不是**常量，免得写出恒真的断言。 */
function storeStub({ has = false, putThrows = null } = {}) {
  const puts = []
  return {
    puts,
    protection: 'stub',
    async put(ref, value) {
      if (putThrows !== null) throw new Error(putThrows)
      puts.push({ ref, value })
    },
    async has(ref) { hasCalls.push(ref); return has },
    async get() { return null },
    async rotate() {},
    async remove() {},
    async describe() { return null },
    async list() { return [] },
  }
}
// `has` 的调用记录挂在模块级，方便断言"问的是哪个引用"。
let hasCalls = []
test.beforeEach(() => { hasCalls = [] })

/**
 * hub 替身。记录**每次调用的 method + path + body**——顺序与形状都是被测对象，
 * 不是实现细节。
 */
function hubStub({
  profileExists = false, bindingExists = false, versionMissing = false,
  createStatus = null, failRead = false, failBinding = false,
} = {}) {
  const calls = []
  const version = 7
  return {
    calls,
    async read(path) {
      calls.push({ method: 'GET', path })
      if (failRead) throw new Error('read boom')
      if (path.startsWith('/api/model-bindings/resolve')) {
        if (!bindingExists) throw Object.assign(new Error('没有绑定'), { status: 404 })
        return { ok: true, resolution: { ok: true, primaryProfile: 'bound-profile', chain: [{ id: 'bound-profile' }] } }
      }
      if (path.startsWith('/api/model-profiles/')) {
        if (!profileExists) throw Object.assign(new Error('没有档案'), { status: 404 })
        return {
          ok: true,
          profile: versionMissing
            ? { id: 'default', displayName: 'd', runtimeType: 'openai', provider: 'p', model: 'm', endpoint: null, deleted: false }
            : { id: 'default', displayName: 'd', runtimeType: 'openai', provider: 'p', model: 'm', endpoint: null, version, deleted: false },
        }
      }
      throw new Error(`hub 替身没有这条读端点：${path}`)
    },
    async call(path, body) {
      calls.push({ method: 'POST', path, body })
      if (failBinding && path === '/api/model-bindings') throw new Error('binding boom')
      if (path === '/api/model-profiles' && createStatus !== null) {
        throw Object.assign(new Error(`创建返回 ${createStatus}`), { status: createStatus })
      }
      return { ok: true }
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body })
      return { ok: true }
    },
  }
}

function secretsOk(store) {
  return async () => ({ ok: true, store, path: 'C:/x/secrets' })
}

/** 全部动作都成功的一套替身，够跑通向导的六步。 */
function happyParts(over = {}) {
  const store = over.store ?? storeStub({ has: false })
  const hub = over.hub ?? hubStub()
  let started = 0
  const launcher = {
    async start() { started += 1; return { ok: true, phase: null, failures: [], diagnostics: [] } },
    status: () => ({ state: 'ready', stateText: '就绪', processes: [] }),
  }
  const parts = {
    hub,
    store,
    launcher,
    startedCount: () => started,
    createFirstRun: (extra = {}) => createFirstRun({
      layout: { dataDir: 'D:/legion/data', logDir: 'D:/legion/logs', cacheDir: 'D:/legion/cache' },
      layoutDiagnostics: [],
      hubUrl: 'http://127.0.0.1:8787',
      hubToken: 'tok',
      hub,
      openSecrets: secretsOk(store),
      launcherFactory: async () => launcher,
      environmentProbe: async () => ({ ok: true, message: 'ok' }),
      initializeImpl: () => ({ ok: true, phase: null, diagnostics: [], created: ['a', 'b'], skipped: [] }),
      provider: 'openai',
      runtimeType: 'openai-responses',
      ...extra,
    }),
  }
  return parts
}

// ── ① 纯函数 ────────────────────────────────────────────────────────────────

test('modelSecretRefFor：按命名约定生成，非法 id 抛错而不是拼一个怪引用', () => {
  assert.equal(modelSecretRefFor('default'), `${MODEL_SECRET_PREFIX}default`)
  assert.equal(MODEL_SECRET_PREFIX, 'legion/model/')
  for (const bad of ['', '   ', null, undefined, '../etc/passwd', 'a/b', '-lead', 'x'.repeat(65)]) {
    assert.throws(() => modelSecretRefFor(bad), TypeError, `应当拒绝 ${JSON.stringify(bad)}`)
  }
})

test('nearestExistingDir：目标目录不存在时向上找，全都不是 null', () => {
  const exists = (p) => p === 'C:/a/b'
  assert.equal(nearestExistingDir('C:/a/b/c/d', { exists }), 'C:/a/b')
  assert.equal(nearestExistingDir('C:/z', { exists }), null)
  assert.equal(nearestExistingDir('', { exists }), null)
})

// ★ 这一条钉的是文件头 §①：`environment` 跑在 `initialize` 之前。
test('probeEnvironment：探测的是**存在的最近祖先**，不是还不存在的目标目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-fr-'))
  try {
    const target = join(root, 'not-created-yet', 'data')
    assert.equal(existsSync(target), false, '前提：目标目录确实不存在')
    const probed = []
    const r = probeEnvironment({
      layout: { dataDir: target },
      probe: (dir) => { probed.push(dir); return { writable: true, code: null, message: null } },
    })
    assert.deepEqual(probed, [root], '应当只探测存在的那个祖先，一次')
    assert.equal(r.ok, true, '祖先可写 → 环境满足（在 initialize 之前不该报不可写）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probeEnvironment：祖先也不可写时报出**是哪条路径**不可写', () => {
  const r = probeEnvironment({
    layout: { dataDir: 'C:/x/data' },
    exists: () => true,
    probe: () => ({ writable: false, code: 'DIR_NOT_WRITABLE', message: 'C:/x 不可写：EPERM' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /C:\/x 不可写/)
  assert.equal(r.unwritable.length, 1)
})

test('probeEnvironment：Node 版本过低要单独说清（低版本上 node:sqlite 的报错离真因很远）', () => {
  const r = probeEnvironment({
    layout: { dataDir: 'C:/x' }, exists: () => true,
    probe: () => ({ writable: true }), nodeMajor: MIN_NODE_MAJOR - 1,
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /Node 版本过低/)
  assert.match(r.message, new RegExp(String(MIN_NODE_MAJOR)))
})

test('probeEnvironment：多个目录共用同一个祖先时不重复报同一件事', () => {
  const seen = []
  const r = probeEnvironment({
    layout: { dataDir: 'C:/x/a', logDir: 'C:/x/b', cacheDir: 'C:/x/c' },
    exists: (p) => p === 'C:/x',
    probe: (dir) => { seen.push(dir); return { writable: false, message: `${dir} 不可写` } },
  })
  assert.deepEqual(seen, ['C:/x'], '同一个祖先只探一次')
  assert.equal(r.unwritable.length, 1, '否则"三个问题"的错觉会让人以为要改三处')
})

// ── ② 前提 ──────────────────────────────────────────────────────────────────

test('firstRunPreconditions：布局 / hub / 密钥库三类各自产出一条，且都说清后果', () => {
  const r = firstRunPreconditions({
    layout: null,
    layoutDiagnostics: [{ severity: 'error', code: 'DATA_DIR_INSIDE_INSTALL' }],
    hubUrl: '', hubToken: '',
    secrets: { ok: false, code: 'SECRET_STORE_UNAVAILABLE', message: 'DPAPI 不可用' },
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.unmet.map((u) => u.key), ['layout', 'hub', 'secrets'])
  assert.match(r.unmet[0].message, /DATA_DIR_INSIDE_INSTALL/)
  assert.match(r.unmet[1].message, /地址与令牌都没有/)
  assert.match(r.unmet[2].message, /DPAPI 不可用/)
})

test('firstRunPreconditions：只缺令牌时说的是"没有令牌"，不是笼统的"hub 不可用"', () => {
  const r = firstRunPreconditions({ layout: { dataDir: 'D:/d' }, hubUrl: 'http://h', hubToken: null })
  assert.deepEqual(r.unmet.map((u) => u.key), ['hub'])
  assert.match(r.unmet[0].message, /没有令牌/)
})

test('firstRunPreconditions：secrets 为 null（没探测过）**不算通过也不算出错**', () => {
  const r = firstRunPreconditions({
    layout: { dataDir: 'D:/d' }, hubUrl: 'http://h', hubToken: 't', secrets: null,
  })
  assert.equal(r.ok, true, '没探测就不报——把它当成失败会让第一步永远显示没跑过')
})

// ── ③ 装配前置条件 ──────────────────────────────────────────────────────────

test('createFirstRun：缺 hub / 缺 openSecrets 在构造时就报，不留到运行中', () => {
  const base = { layout: { dataDir: 'D:/d' }, hub: hubStub(), openSecrets: secretsOk(storeStub()) }
  assert.throws(() => createFirstRun({ ...base, hub: null }), TypeError)
  assert.throws(() => createFirstRun({ ...base, hub: { read() {}, call() {} } }), /patch/,
    '缺 patch 必须是构造期错误：重跑向导时档案已存在，那条路必然要用它')
  assert.throws(() => createFirstRun({ ...base, openSecrets: null }), /openSecrets/)
})

// ★ 顺序：先密钥，后档案，最后绑定（文件头 §③）。
test('submitModelConfig：写入顺序是 密钥 → 档案 → 绑定', () => {
  const store = storeStub()
  const hub = hubStub()
  const p = happyParts({ store, hub })
  return p.createFirstRun().submitModelConfig({ apiKey: 'sk-x', model: 'gpt-x' }).then((r) => {
    assert.equal(r.ok, true, r.message)
    assert.deepEqual(store.puts, [{ ref: `${MODEL_SECRET_PREFIX}default`, value: 'sk-x' }])
    assert.deepEqual(hub.calls.map((c) => `${c.method} ${c.path}`), [
      'POST /api/model-profiles',
      'POST /api/model-bindings',
    ])
  })
})

test('submitModelConfig：不是"先档案后密钥"——失败在档案那一步时，密钥已经在了', async () => {
  const store = storeStub()
  const hub = hubStub({ createStatus: 500 })
  const p = happyParts({ store, hub })
  const r = await p.createFirstRun().submitModelConfig({ apiKey: 'sk-x', model: 'gpt-x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, FIRST_RUN_CODES.PROFILE_WRITE_FAILED)
  assert.equal(store.puts.length, 1,
    '密钥先写了（中间态是一个没人引用的密钥，无害）；反过来会留下一份指向空处的档案')
  assert.equal(hub.calls.some((c) => c.path === '/api/model-bindings'), false, '档案没成就不该写绑定')
})

// ★ 钉 PATCH：档案已存在（409）时必须走更新端点，且 version 在 body 顶层。
test('submitModelConfig：409（档案已存在）→ 读回 version 并走 PATCH，不是再 POST', async () => {
  const store = storeStub()
  const hub = hubStub({ createStatus: 409, profileExists: true })
  const p = happyParts({ store, hub })
  const r = await p.createFirstRun().submitModelConfig({ apiKey: 'sk-x', model: 'gpt-x' })
  assert.equal(r.ok, true, r.message)
  const patch = hub.calls.find((c) => c.method === 'PATCH')
  assert.ok(patch, '必须是 PATCH：hub 客户端的 call 只发 POST，打过去会落到别的路由上')
  assert.equal(patch.path, '/api/model-profiles/default')
  assert.equal(patch.body.version, 7, 'version 在 body **顶层**（服务端读 body.version）')
  assert.equal(patch.body.actor, 'first-run-wizard')
  assert.equal(patch.body.profile.secretRef, `${MODEL_SECRET_PREFIX}default`)
  assert.equal(hub.calls.filter((c) => c.method === 'POST' && c.path === '/api/model-profiles').length, 1,
    '不重试创建')
})

test('submitModelConfig：档案已存在但读不到 version 时**不**动手，如实报出来', async () => {
  const hub = hubStub({ createStatus: 409, profileExists: true, versionMissing: true })
  const p = happyParts({ hub })
  const r = await p.createFirstRun().submitModelConfig({ apiKey: 'sk-x', model: 'gpt-x' })
  assert.equal(r.ok, false)
  assert.match(r.message, /读不到它的 version/)
  assert.equal(hub.calls.some((c) => c.method === 'PATCH'), false, '拿不到 version 就不该盲改')
})

// ★ 钉绑定字段名：hub 契约是 employeeRole / primaryProfile。
test('submitModelConfig：绑定的字段名是 employeeRole / primaryProfile（hub 的契约）', async () => {
  const hub = hubStub()
  const p = happyParts({ hub })
  await p.createFirstRun({ scope: 'space-a', role: 'coder' }).submitModelConfig({ apiKey: 'k', model: 'm' })
  const b = hub.calls.find((c) => c.path === '/api/model-bindings')
  assert.ok(b, '必须写绑定：没有它 resolve 会 404，而"没有绑定"与"没有可用模型"在下游长得一样')
  assert.equal(b.body.scope, 'space-a')
  assert.equal(b.body.employeeRole, 'coder')
  assert.equal(b.body.primaryProfile, DEFAULT_MODEL_PROFILE_ID)
  assert.deepEqual(b.body.fallbackProfiles, [])
  assert.equal(b.body.role, undefined, '不许多送一个 hub 不认的 role')
})

test('submitModelConfig：缺 provider / runtimeType 时拒写，且**不猜**', async () => {
  const store = storeStub()
  const p = happyParts({ store })
  const fr = p.createFirstRun()
  for (const [value, re] of [
    [{ apiKey: '', model: 'm' }, /缺少模型密钥/],
    [{ apiKey: 'k' }, /缺少模型名/],
  ]) {
    const r = await fr.submitModelConfig(value)
    assert.equal(r.ok, false)
    assert.match(r.message, re)
  }
  assert.equal(store.puts.length, 0, '一条都不该写进去')
  // provider/runtimeType 由构造参数给；不给时拒写。
  const bare = happyParts({ store }).createFirstRun({ provider: null, runtimeType: null })
  const r = await bare.submitModelConfig({ apiKey: 'k', model: 'm' })
  assert.equal(r.ok, false)
  assert.match(r.message, /缺少 provider/)
  assert.equal(store.puts.length, 0)
})

test('submitModelConfig：密钥库打不开时**不写**，也不假装写过', async () => {
  const store = storeStub()
  const hub = hubStub()
  const fr = createFirstRun({
    layout: { dataDir: 'D:/d' },
    hub, openSecrets: async () => ({ ok: false, code: 'SECRET_STORE_UNAVAILABLE', message: 'DPAPI 不可用' }),
    launcherFactory: async () => ({ start: async () => ({ ok: true }), status: () => ({ state: 'ready' }) }),
    provider: 'p', runtimeType: 'rt',
  })
  const r = await fr.submitModelConfig({ apiKey: 'k', model: 'm' })
  assert.equal(r.ok, false)
  assert.equal(r.code, FIRST_RUN_CODES.SECRETS_UNAVAILABLE)
  assert.equal(hub.calls.length, 0, '密钥没写成就绝不能碰档案')
})

test('submitModelConfig：写密钥抛错时报 SECRET_WRITE_FAILED，且不碰 hub', async () => {
  const hub = hubStub()
  const p = happyParts({ store: storeStub({ putThrows: 'DPAPI 拒绝' }), hub })
  const r = await p.createFirstRun().submitModelConfig({ apiKey: 'k', model: 'm' })
  assert.equal(r.ok, false)
  assert.equal(r.code, FIRST_RUN_CODES.SECRET_WRITE_FAILED)
  assert.match(r.message, /DPAPI 拒绝/)
  assert.equal(hub.calls.length, 0)
})

test('submitModelConfig：绑定写失败时如实说"档案已在、但岗位没指向它"', async () => {
  const hub = hubStub({ failBinding: true })
  const p = happyParts({ hub })
  const r = await p.createFirstRun().submitModelConfig({ apiKey: 'k', model: 'm' })
  assert.equal(r.ok, false)
  assert.equal(r.code, FIRST_RUN_CODES.BINDING_WRITE_FAILED)
  assert.match(r.message, /岗位没指向它/)
})

// ── ④ isModelConfigured：档案 **且** 密钥 ───────────────────────────────────

test('isModelConfigured：档案与密钥都在才是 true', async () => {
  hasCalls = []
  const store = storeStub({ has: true })
  const p = happyParts({ store, hub: hubStub({ profileExists: true, bindingExists: true }) })
  assert.equal(await p.createFirstRun().isModelConfigured(), true)
  assert.deepEqual(hasCalls, [`${MODEL_SECRET_PREFIX}bound-profile`],
    '★ 引用是**算出来的**：绑定的档案是 bound-profile → legion/model/bound-profile')
})

// ★ 这一条钉的是那个设计约束：hub 的单条档案读取**有意不含 secretRef**。
test('isModelConfigured：不依赖 API 返回 secretRef（hub 故意不暴露引用名）', async () => {
  hasCalls = []
  const store = storeStub({ has: true })
  const hub = hubStub({ profileExists: true })
  // 替身**不**返回 secretRef——与真实的 `toModelDescriptor` 一致。
  const p = happyParts({ store, hub })
  assert.equal(await p.createFirstRun().isModelConfigured(), true,
    '如果实现是"从 API 读 secretRef"，这一条会 false：真实 hub 从不返回它')
  // ★ 光断言 `true` 是不够的：`has` 的替身对**任何**参数都返回 true，
  //   所以"读回来是 undefined 于是什么都没查"也会让上面那一条通过。
  //   必须钉住**问的是哪个引用**，这一条才算真的验证了命名约定。
  //
  //   > 一个"对任何入参都返回 true"的替身，让"按约定算引用"与"算错了/没算"
  //   > 在那条断言上是同一个东西——只不过后者会让密钥永远查不到。
  assert.deepEqual(hasCalls, [`${MODEL_SECRET_PREFIX}default`],
    '没绑定时用的应当是向导自己的档案 id → legion/model/default')
})

test('isModelConfigured：档案在但密钥不在 → false（否则会跳过唯一的密钥录入入口）', async () => {
  const p = happyParts({ store: storeStub({ has: false }), hub: hubStub({ profileExists: true }) })
  assert.equal(await p.createFirstRun().isModelConfigured(), false)
})

test('isModelConfigured：档案读不到 / 读抛错 / 密钥库打不开，一律 false', async () => {
  const cases = [
    happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: false }) }),
    happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, failRead: true }) }),
  ]
  for (const p of cases) assert.equal(await p.createFirstRun().isModelConfigured(), false)
  const brokenStore = createFirstRun({
    layout: { dataDir: 'D:/d' }, hub: hubStub({ profileExists: true }),
    openSecrets: async () => { throw new Error('打不开') },
    launcherFactory: async () => ({ start: async () => ({ ok: true }), status: () => ({ state: 'ready' }) }),
    provider: 'p', runtimeType: 'rt',
  })
  assert.equal(await brokenStore.isModelConfigured(), false,
    '"判断出错"绝不该导致跳过输入——那是唯一能填密钥的地方')
})

// ── ⑤ 向导接线：端到端 ──────────────────────────────────────────────────────

test('向导接线：六步真跑到 done（模型从未配过 → 走输入 → 提交 → 观测通过）', async () => {
  let modelReady = false
  const store = storeStub()
  store.has = async (ref) => { hasCalls.push(ref); return modelReady }
  const hub = hubStub({ profileExists: true })
  const p = happyParts({ store, hub })

  const fr = p.createFirstRun()
  let r = await fr.wizard.run()
  assert.equal(r.blocked, true, '模型没配过时应当停在 configure-model 等输入')
  assert.equal(r.blockedStep, 'configure-model')
  assert.equal(r.needsInput, true)
  assert.match(r.message, /模型密钥/, '必须说清在等什么')

  const acc = fr.wizard.submit({ apiKey: 'sk-live', model: 'gpt-live' })
  assert.equal(acc.accepted, true)
  modelReady = true                  // 提交之后密钥库真的有了
  r = await fr.wizard.run()
  assert.equal(r.done, true, `应当完成：${r.message ?? ''} / blockedStep=${r.blockedStep}`)
  assert.equal(p.startedCount(), 1, 'start 只该被调用一次（观测用的是 status()，不是再 start 一次）')
})

test('向导接线：模型此前已配好（档案+密钥都在）→ 跳过输入直接完成', async () => {
  const p = happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, bindingExists: true }) })
  const fr = p.createFirstRun()
  const r = await fr.wizard.run()
  assert.equal(r.done, true, r.message)
  assert.ok(r.results.some((x) => x.step === 'configure-model' && /跳过输入/.test(x.message)),
    '应当明确说"已核对后跳过"，而不是悄悄跳过')
})

test('向导接线：观测拿的是 launcher.status()，不是 start() 的返回值', async () => {
  const p = happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, bindingExists: true }) })
  // start 说成功，但 status() 说 degraded —— 独立观测必须看出这件事。
  const r = await p.createFirstRun({
    launcherFactory: async () => ({
      async start() { return { ok: true, phase: null, failures: [], diagnostics: [] } },
      status: () => ({ state: 'degraded', stateText: '部分能力不可用', processes: [] }),
    }),
  }).wizard.run()
  assert.equal(r.done, false, 'degraded 不算通过')
  assert.equal(r.blockedStep, 'verify')
})

// ★ 前提不成立 → 一步都不跑（否则 `initialize` 会去建目录、`start` 会去拉进程）。
test('向导接线：前提不成立时一步都不跑，且报 PRECONDITION_UNMET', async () => {
  const hub = hubStub()
  const p = happyParts({ hub })
  const fr = p.createFirstRun({ hubToken: null })
  const r = await fr.wizard.run()
  assert.equal(r.precondition, true)
  assert.equal(r.blockedStep, 'environment', '停在第一步，而不是跑到第三步才暴露')
  assert.equal(r.results.length, 1, '只记一条前提结论，没有任何步骤被跑过')
  assert.equal(hub.calls.some((c) => c.path === '/api/model-profiles'), false)
  assert.ok(fr.wizard.diagnostics().some((d) => d.code === WIZARD_CODES.PRECONDITION_UNMET))
})

test('向导接线：前提函数抛错 → 按不成立处理（一个"出错就放行"的前提等于没有前提）', async () => {
  const p = happyParts()
  const fr = p.createFirstRun({ extraPreconditions: async () => { throw new Error('探测炸了') } })
  const r = await fr.wizard.run()
  assert.equal(r.precondition, true)
  assert.ok(r.unmet.some((u) => u.key === 'extra-precondition-error'))
  assert.match(r.unmet.find((u) => u.key === 'extra-precondition-error').message, /探测炸了/)
})

test('向导接线：附加前提返回说不清的东西 → 也算不成立', async () => {
  const p = happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, bindingExists: true }) })
  for (const bad of [42, null, 'nope']) {
    const fr = p.createFirstRun({ extraPreconditions: async () => bad })
    const r = await fr.wizard.run()
    assert.equal(r.precondition, undefined,
      `${JSON.stringify(bad)} 不是"不成立"，是"说不清"——内置三条已满足时不能凭它拦住向导`)
  }
  // 明确说 `{ok:false}` 却不说为什么时，不产出条目 = 没有不成立的前提。
  const fr = p.createFirstRun({ extraPreconditions: async () => ({ ok: false, unmet: [] }) })
  const r = await fr.wizard.run()
  assert.equal(r.done, true, '空 unmet 列表 = 没有不成立的前提')
})

// ★ 附加前提**叠加**在内置之上，不是替换（换了会顺手删掉三条没人打算删的检查）。
test('向导接线：附加前提不替换内置前提——布局/hub 仍会被检查', async () => {
  const p = happyParts()
  const fr = p.createFirstRun({
    hubToken: null,
    extraPreconditions: [{ key: 'licence', message: '许可证未接受' }],
  })
  const r = await fr.wizard.run()
  assert.equal(r.precondition, true)
  assert.deepEqual(r.unmet.map((u) => u.key), ['hub', 'licence'],
    '内置的 hub 一条不能少，附加的 licence 也要在')
})

test('向导接线：静态数组形态的附加前提也认', async () => {
  const p = happyParts()
  const fr = p.createFirstRun({ extraPreconditions: [{ key: 'x', message: '没装 Node' }] })
  const r = await fr.wizard.run()
  assert.equal(r.precondition, true)
  assert.deepEqual(r.unmet, [{ key: 'x', message: '没装 Node' }],
    '内置三项此时都满足，unmet 里只该有附加那一条')
})

// ★ 前提要**每次 run 都重判**：用户就是去把 hub 打开、再点一次的。
test('向导接线：前提每次 run 都重判，不缓存第一次的结论', async () => {
  const p = happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, bindingExists: true }) })
  let ready = false
  let asks = 0
  const fr = p.createFirstRun({
    extraPreconditions: async () => {
      asks += 1
      return ready ? [] : [{ key: 'licence', message: '许可证未接受' }]
    },
  })
  let r = await fr.wizard.run()
  assert.equal(r.precondition, true)
  assert.deepEqual(r.unmet.map((u) => u.key), ['licence'])
  ready = true
  r = await fr.wizard.run()
  assert.equal(r.done, true, `前提好了之后必须能继续，而不是重启向导（${r.message ?? ''}）`)
  assert.equal(asks, 2, '两次 run 各判一次')
})

test('向导接线：start 用的判据是 launcher 自己的 startResultIsBlocking', async () => {
  const p = happyParts({ store: storeStub({ has: true }), hub: hubStub({ profileExists: true, bindingExists: true }) })
  // `ok:false` + **有** phase + 只有 warn 诊断 = 部分起来、不阻塞。
  // 把它当失败会让向导停在一步本来已经过去了的地方。
  let r = await p.createFirstRun({
    launcherFactory: async () => ({
      async start() {
        return { ok: false, phase: 'readiness', failures: [], diagnostics: [{ severity: 'warn', message: '一个可选项没起来' }] }
      },
      status: () => ({ state: 'ready', stateText: '就绪', processes: [] }),
    }),
  }).wizard.run()
  assert.equal(r.done, true, `只有 warn 不应当是阻塞：${r.message ?? ''}`)

  // `ok:false` + phase:null = **阻塞**（不知道哪儿坏了，但确实坏了）。
  r = await p.createFirstRun({
    launcherFactory: async () => ({
      async start() { return { ok: false, phase: null, failures: [], diagnostics: [] } },
      status: () => ({ state: 'stopped', stateText: '没起来', processes: [] }),
    }),
  }).wizard.run()
  assert.equal(r.blockedStep, 'start', 'phase:null 是"不知道哪儿坏了"，不能当成没问题')
})

test('向导接线：环境不满足 / 初始化失败时停在对应那一步，并说清原因', async () => {
  const p = happyParts()
  let r = await p.createFirstRun({ environmentProbe: async () => ({ ok: false, message: 'C:/x 不可写' }) }).wizard.run()
  assert.equal(r.blockedStep, 'environment')
  assert.match(r.message, /C:\/x 不可写/)

  r = await p.createFirstRun({
    initializeImpl: () => ({ ok: false, phase: 'layout', created: [], skipped: [], diagnostics: [{ severity: 'error', message: '装在安装目录里' }] }),
  }).wizard.run()
  assert.equal(r.blockedStep, 'initialize')
  assert.match(r.message, /装在安装目录里/)
})

test('向导接线：环境探测返回说不清的东西 → 不算过', async () => {
  const p = happyParts()
  const r = await p.createFirstRun({ environmentProbe: async () => null }).wizard.run()
  assert.equal(r.blockedStep, 'environment')
  assert.match(r.message, /没有给出可判读的结果/)
})

test('向导接线：预导出的一组动作与向导内用的是**同一份**实现', async () => {
  const p = happyParts()
  const fr = p.createFirstRun()
  // 同一个观察点：直接调导出的 preconditions 与 wizard 内部行为一致。
  const direct = await fr.preconditions()
  assert.equal(direct.ok, true)
  assert.equal(typeof fr.checkEnvironment, 'function')
  assert.equal(typeof fr.observe, 'function')
  assert.equal(fr.profileId, DEFAULT_MODEL_PROFILE_ID)
  assert.equal(fr.scope, 'default')
  // invalidateSecrets 之后仍能工作（重新打开密钥库）。
  fr.invalidateSecrets()
  assert.equal(await fr.isModelConfigured(), false)
})

test('向导接线：stateFile 断点续跑仍然有效（接线没有把它弄丢）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-fr-state-'))
  try {
    const stateFile = join(dir, 'first-run-wizard.json')
    const mem = new Map()
    const fs = {
      writeFileSync: (p, c) => mem.set(p, String(c)),
      readFileSync: (p) => { if (!mem.has(p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return mem.get(p) },
      mkdirSync: () => {},
      existsSync: (p) => mem.has(p),
    }
    const p = happyParts()
    const fr = p.createFirstRun({ stateFile, fs })
    const r = await fr.wizard.run()
    assert.equal(r.blocked, true)
    assert.ok(mem.has(stateFile), '断点要落盘，否则用户去拿密钥回来后得从头再来')

    // 新向导从同一个状态文件恢复位置。
    const fr2 = p.createFirstRun({ stateFile, fs })
    assert.equal(fr2.wizard.status().step, 'configure-model', '应当从断点继续')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
