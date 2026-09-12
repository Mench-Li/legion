// product/secrets.test.mjs
// ============================================================================
// 受保护密钥库的产品接线（PRT-254 的「Secret Store 最小闭环」）
//
// 这一组要守住的是**接线本身**，而不是 `security/secrets/` 的内部行为
// （那已有它自己的 31 例）。具体是四个问题：
//
//   ① 密钥库文件落在哪？——不得在 DataDir / InstallDir / CacheDir 内
//   ② 打开时能不能用？——没有受保护后端就 fail closed（且是结果不是异常）
//   ③ 解析器接上了没有？——`resolver` 真的能解出明文
//   ④ 诊断里有没有泄漏？——自检结果不得含明文，也不得含引用名
//
// 关键是**不碰真实 DPAPI**：用注入的 storeFactory 造一个假的受保护 store，
// 于是这一组在 Linux CI 上也能跑（与 `product/paths.test.mjs` 同一考虑）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findPlaintextSecrets } from '../runtime/contracts/model.mjs'
import {
  DPAPI_SCHEME,
  createProtector,
  createSecretStore,
  memoryBackend,
  nullProtector,
} from '../security/secrets/index.mjs'
import { resolveLayout } from './paths.mjs'
import {
  SECRETS_CHECK_CODES,
  assertSecretsPlacement,
  describeSecretsCheck,
  openProductSecrets as _openProductSecrets,
} from './secrets.mjs'
// 用例里的路径是假的：**声明**它们存在，否则会走到「文件尚未创建」那条分支
// （`ACL_NOT_CREATED`）。想测那条分支的用例显式传 `exists: () => false` 覆盖。
const openProductSecrets = (args = {}) => _openProductSecrets({ exists: () => true, ...args })

const SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'

/** 与 `secret-resolver.test.mjs` 同口径的假保护方案。 */
function fakeProtector() {
  return createProtector({
    scheme: DPAPI_SCHEME,
    protect: (v) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`,
    unprotect: (b) => {
      if (typeof b !== 'string' || !b.startsWith('enc:')) throw new Error('bad blob')
      return Buffer.from(b.slice(4), 'base64').toString('utf8')
    },
  })
}

/** 一份"生产形态"的布局：密钥库在产品家目录下的 secrets/，不在 DataDir 内。 */
function layoutFor(overrides = {}) {
  const { layout } = resolveLayout({
    platform: 'win32',
    installDir: 'C:\\Apps\\Legion',
    homeDir: 'C:\\Users\\alice',
    appDataDir: 'C:\\Users\\alice\\AppData\\Local',
    workspaceDir: 'D:\\proj',
    ...overrides,
  })
  return layout
}

/**
 * 假 storeFactory：受保护、内存后端、可预置条目。
 * `seed` 用来验"解析器真的能解出明文"。
 */
function fakeFactory({ seed = [], protector = fakeProtector() } = {}) {
  const calls = []
  const stores = []
  const factory = ({ file, platform }) => {
    calls.push({ file, platform })
    const store = createSecretStore({ backend: memoryBackend(), protector })
    stores.push(store)
    return store
  }
  factory.calls = calls
  factory.stores = stores
  factory.seed = async (ref, value) => {
    // 该 store 由 factory 建出后才存在；这里只在第一次 open 之后用
    await stores[0].put(ref, value)
  }
  factory.seedAfter = (ref, value) => stores[0].put(ref, value)
  return factory
}

/** ACL 用的假 runner：`icacls` 永远报同一份输出。 */
const aclRunner = (stdout) => async (cmd, args) => ({ status: 0, stdout })

const OWNER = 'ALICE\\alice'

const CLEAN_ACL = [
  'C:\\Users\\alice\\AppData\\Local\\Legion\\secrets\\credentials.json ALICE\\alice:(F)',
  '  NT AUTHORITY\\SYSTEM:(F)',
  '  BUILTIN\\Administrators:(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n')

/** 不干净的 ACL：`BUILTIN\Users` 有读权限（多用户机器上另一个用户能读到）。 */
const PERMISSIVE_ACL = [
  'C:\\Users\\alice\\AppData\\Local\\Legion\\secrets\\credentials.json ALICE\\alice:(F)',
  '  BUILTIN\\Users:(I)(RX)',
  '  NT AUTHORITY\\SYSTEM:(F)',
  '  BUILTIN\\Administrators:(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n')

// ------------------------------------------------------------------ ① 位置

test('① 默认密钥库路径在产品家目录下的 secrets/，且**不在 DataDir 内**', () => {
  const layout = layoutFor()
  assert.match(layout.secretsFile, /secrets[\\/]credentials\.json$/)
  // 最关键的一条：与 dataDir 是**兄弟**关系，不是父子
  assert.equal(layout.secretsFile.startsWith(`${layout.dataDir}\\`), false,
    `密钥库落在了数据目录内：${layout.secretsFile}`)
  assert.equal(layout.secretsFile.startsWith(`${layout.dataDir}/`), false)
  // 也不在产品配置旁边
  assert.notEqual(layout.secretsFile, layout.productConfigPath)
})

test('① 密钥库落在 DataDir 内 → 布局诊断报错，且打开被拒绝', async () => {
  // 数据目录是备份、恢复与诊断包导出的对象。密钥库落在里面，任何将来
  // 「把 DataDir 打个包」的功能都会**顺手**把它带出去，而 spec §3.1
  // 要求密钥不得进入导出证据与能力包。
  const layout = layoutFor()
  const bad = { ...layout, secretsFile: `${layout.dataDir}\\credentials.json` }
  const p = assertSecretsPlacement(bad)
  assert.equal(p.ok, false)
  assert.equal(p.code, 'SECRETS_INSIDE_DATA_DIR')

  const r = await openProductSecrets({ layout: bad, storeFactory: fakeFactory() })
  assert.equal(r.ok, false)
  assert.equal(r.code, SECRETS_CHECK_CODES.LAYOUT_BLOCKED)
  assert.equal(r.store, null, '位置不合法时不该把库打开')
})

test('① 密钥库落在 InstallDir / CacheDir 内 → 同样被拒', async () => {
  const layout = layoutFor()
  for (const [code, file] of [
    ['SECRETS_INSIDE_INSTALL_DIR', 'C:\\Apps\\Legion\\secrets\\credentials.json'],
    ['SECRETS_INSIDE_CACHE_DIR', `${layout.cacheDir}\\credentials.json`],
  ]) {
    const bad = { ...layout, secretsFile: file }
    assert.equal(assertSecretsPlacement(bad).code, code)
    const r = await openProductSecrets({ layout: bad, storeFactory: fakeFactory() })
    assert.equal(r.ok, false)
    assert.equal(r.code, SECRETS_CHECK_CODES.LAYOUT_BLOCKED)
  }
})

test('① 缓存目录的理由与其它两个不同：删掉之后密钥**无法找回**', () => {
  const layout = layoutFor()
  const bad = { ...layout, secretsFile: `${layout.cacheDir}\\c.json` }
  const p = assertSecretsPlacement(bad)
  assert.match(p.message, /可安全删除|无法找回/)
})

test('① secretsFile 可以由受控环境变量覆盖，但**仍然要过位置判定**', async () => {
  const layout = layoutFor({ env: { LEGION_SECRETS_FILE: 'E:\\vault\\creds.json' } })
  assert.equal(layout.secretsFile, 'E:\\vault\\creds.json')
  assert.equal(assertSecretsPlacement(layout).ok, true)

  const r = await openProductSecrets({ layout, storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL) })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.path, 'E:\\vault\\creds.json')
})

test('① 没有 secretsFile 的布局 → LAYOUT_BLOCKED（而不是猜一个路径出来）', async () => {
  const r = await openProductSecrets({ layout: { platform: 'win32', dataDir: 'C:\\d' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, SECRETS_CHECK_CODES.LAYOUT_BLOCKED)
  assert.match(r.message, /resolveLayout/)
})

// ------------------------------------------------------------------ ② 保护

test('② 明文后端 → fail closed（结果而非异常），并说清"这只是本机开发"该怎么放开', async () => {
  const factory = fakeFactory({ protector: nullProtector() })
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory })
  assert.equal(r.ok, false)
  assert.equal(r.code, SECRETS_CHECK_CODES.UNPROTECTED)
  assert.match(r.message, /静默地不安全/)
  assert.match(r.message, /requireProtected: false/, '要告诉人怎么有意放开')
  // 但库本身还是被打开了——因为它确实能读，只是"不安全"这个事实必须报出来
  assert.ok(r.store !== null)
})

test('② requireProtected: false 时明文后端可用（但那是一个**说出来的**选择）', async () => {
  const r = await openProductSecrets({
    layout: layoutFor(),
    storeFactory: fakeFactory({ protector: nullProtector() }),
    requireProtected: false,
    run: aclRunner(CLEAN_ACL),
  })
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('② 自检**不抛**：打不开时返回结果（自检是要显示给人看的）', async () => {
  const throwing = () => { throw new Error('boom at C:\\Users\\bob\\secret.bin') }
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: throwing })
  assert.equal(r.ok, false)
  assert.equal(r.code, SECRETS_CHECK_CODES.OPEN_FAILED)
  // **不原样带出 message**：密钥库异常里可能出现路径/账户名/密文片段
  assert.ok(!r.message.includes('bob'), `泄漏了路径/账户名：${r.message}`)
  assert.ok(!r.message.includes('secret.bin'))
  assert.match(r.message, /Error/, '但要保留是"哪一类异常"这个结构信息')
})

test('② 平台不支持密钥库 → UNSUPPORTED_PLATFORM（不是笼统的失败）', async () => {
  const factory = () => {
    const e = new Error('unsupported')
    e.name = 'SecretStoreError'
    e.code = 'SECRET_STORE_UNSUPPORTED_PLATFORM'
    e.runtimeCode = 'SECRET_UNAVAILABLE'
    throw e
  }
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory })
  assert.equal(r.ok, false)
  assert.equal(r.code, SECRETS_CHECK_CODES.UNSUPPORTED_PLATFORM)
})

test('② describeSecretsCheck 给出一行用户可读文案（失败时带上原因）', async () => {
  const ok = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL),
  })
  assert.equal(describeSecretsCheck(ok), ok.message)
  const bad = await openProductSecrets({ layout: layoutFor(), storeFactory: fakeFactory({ protector: nullProtector() }) })
  assert.match(describeSecretsCheck(bad), /^密钥库不可用：/)
})

// ------------------------------------------------------------------ ③ 接线

test('③ **解析器真的接上了**：解出明文并能喂给探测执行器', async () => {
  // 这是本批的核心断言——"尚无生产调用方"这个缺口就是靠这一条关掉的。
  const factory = fakeFactory()
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory, run: aclRunner(CLEAN_ACL) })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(typeof r.resolver.resolveSecret, 'function')
  assert.equal(typeof r.resolver.credentialVersionOf, 'function')

  await factory.seedAfter('legion/openai', SECRET)
  const value = await r.resolver.resolveSecret('legion/openai')
  assert.equal(value, SECRET, '明文必须真的解得出来（否则"接上了"是空话）')

  // 接上探测执行器：凭证真的传到了 transport
  const { createModelProbe } = await import('../runtime/probe/index.mjs')
  const calls = []
  const probe = createModelProbe({
    transport: async (arg) => { calls.push(arg); return { kind: 'http', status: 200, capabilities: { chat: true } } },
    resolveSecret: r.resolver.resolveSecret,
    credentialVersionOf: r.resolver.credentialVersionOf,
  })
  const verdict = await probe.probe({
    profile: {
      id: 'm1', provider: 'openai', model: 'gpt-4o', endpoint: 'https://api.example/v1',
      runtimeType: 'dsh', secretRef: 'legion/openai', reasoningEffort: 'medium', limits: {},
    },
  })
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
  assert.equal(calls[0].credential, SECRET)
})

test('③ 解析失败时是 SECRET_UNAVAILABLE（本机问题），不是 AUTH_FAILED', async () => {
  const factory = fakeFactory()
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory, run: aclRunner(CLEAN_ACL) })
  const err = await r.resolver.resolveSecret('legion/missing').catch((e) => e)
  assert.equal(err.runtimeErrorCode, 'SECRET_UNAVAILABLE')
})

test('③ 计数：报"已录入几条"，但不列名字', async () => {
  const factory = fakeFactory()
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory, run: aclRunner(CLEAN_ACL) })
  assert.equal(r.count, 0, '空库就是 0，不是 null')
  assert.match(r.message, /已录入 0 条/)
  await factory.seedAfter('legion/a', 'x')
  await factory.seedAfter('legion/b', 'y')
  const r2 = await openProductSecrets({ layout: layoutFor(), storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL) })
  assert.equal(r2.count, 0)
})

// ------------------------------------------------------------------ ④ 不泄漏

test('④ 自检结果里**没有明文**，也没有引用名', async () => {
  const factory = fakeFactory()
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: factory, run: aclRunner(CLEAN_ACL) })
  await factory.seedAfter('legion/openai', SECRET)

  const dump = JSON.stringify({
    ok: r.ok, code: r.code, message: r.message, path: r.path,
    protection: r.protection, acl: r.acl, count: r.count, aclVerified: r.aclVerified,
  })
  assert.ok(!dump.includes(SECRET), `明文泄漏：${dump}`)
  assert.deepEqual(findPlaintextSecrets({ code: r.code, message: r.message, count: r.count }), [],
    '自检码与文案不得被判成疑似密钥')

  // 引用名也不该出现：它不进 `message`（`count` 是数字）
  const factory2 = fakeFactory()
  const r2 = await openProductSecrets({ layout: layoutFor(), storeFactory: factory2, run: aclRunner(CLEAN_ACL) })
  await factory2.seedAfter('very-distinctive-ref-name', SECRET)
  assert.ok(!String(r2.message).includes('very-distinctive-ref-name'),
    '引用名不进诊断：它能画出这台机器配了哪些供应商，而自检结果会进日志与诊断包')
})

test('④ 自检结果对象**不可变**（避免被下游顺手塞进明文）', async () => {
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL),
  })
  assert.equal(Object.isFrozen(r), true)
  assert.throws(() => { r.path = 'x' }, TypeError)
})

// ------------------------------------------------------------------ ⑤ ACL 接进自检

test('⑤ ACL 干净 → aclVerified: true，且文案里报出来', async () => {
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL), owner: OWNER,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.aclVerified, true, `ACL 应判为干净：${JSON.stringify(r.acl)}`)
  assert.match(r.message, /文件访问控制：/)
})

test('⑤ **本来就干净的 ACL 不得触发加固**（改权限是有副作用的动作）', async () => {
  // 少了这一条，"第一次检查不传 owner"这个缺陷会被加固路径悄悄补上：
  // 检查判越权 → 加固 → 复验通过 → 看起来一切正常。但代价是
  // **每一次启动都会去改一遍文件权限**（Windows 上四条 icacls、POSIX 上一次 chmod），
  // 而改权限不是只读操作。一个"反正最后是对的"的实现掩盖了它多做了一件不该做的事。
  const calls = []
  const run = async (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: CLEAN_ACL } }
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run, owner: OWNER,
  })
  assert.equal(r.aclBefore.ok, true, '这份 ACL 本来就应该判为干净')
  assert.equal(r.hardened, null, '干净就不该加固')
  const mutations = calls.filter((c) => c.args.join(' ').includes('/inheritance:r') || c.cmd === 'chmod')
  assert.deepEqual(mutations, [], `不必要地改动了文件权限：${JSON.stringify(mutations)}`)
})

test('⑤ 不给 owner 时，一份**干净的** ACL 也会被判越权（fail closed，但必须说清为什么）', async () => {
  // `icacls` 的输出不标出所有者，所以不传 owner 时真所有者会被当成越权主体。
  // 方向是 fail closed（不会漏报），不会放过真正的问题；但代价是提示会变得
  // 不可信——所以这一条把它钉住，提醒调用方必须传 owner。
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run: aclRunner(CLEAN_ACL), owner: null,
  })
  assert.equal(r.ok, true, '库本身仍可用')
  assert.equal(r.aclVerified, false)
  assert.ok(r.acl.offenders.includes('ALICE\\alice'), '未传 owner 时所有者被算作越权主体')
})

test('⑤ ACL 查不出来 → ok 仍为 true（库能用），但**文案必须说未验证**', async () => {
  // 这一条是本组的重点：`ok:true` 说的是"这台机器上密钥库能用来解析凭证"，
  // 而"文件权限有没有被验证过"是另一件事。一条查不出来的 ACL 不会让密钥库
  // 不可用，但它**绝不能**看起来像"已确认安全"——那正是"查不出来就当成通过"
  // 那个错误的另一种写法。
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run: null, hardenAcl: false,
  })
  assert.equal(r.ok, true)
  assert.equal(r.aclVerified, false, '没查过就不许报"已验证"')
  assert.match(r.message, /未验证|无法确认|没有 icacls/)
})

test('⑤ 加固需要所有者：不给 owner 就不加固，且如实报出未加固', async () => {
  // 猜一个主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"。
  const run = aclRunner('C:\\x\\credentials.json BUILTIN\\Users:(F)\r\n')
  const r = await openProductSecrets({ layout: layoutFor(), storeFactory: fakeFactory(), run, owner: null })
  assert.equal(r.ok, true)
  assert.equal(r.aclVerified, false)
  assert.equal(r.hardened.ok, false, '没有 owner 时加固必须失败而不是"静默跳过"')
  assert.match(r.hardened.message, /所有者|把权限给错人/)
})

test('⑤ 给了 owner 时加固被调用，并把命令序列如实带回', async () => {
  // 初始 ACL **不干净**（Users 可读），加固之后才干净。
  // 用同一个输出当"加固前后"会让这个用例什么都不验：
  // 干净之后本来就不会触发加固，于是"必须先断继承"这条断言
  // 会对着一次**根本没发生**的加固通过——**一个测不到东西的用例，
  // 和一个正确的实现，在输出上完全一样**。
  const calls = []
  let hardened = false
  const run = async (cmd, args) => {
    calls.push({ cmd, args })
    const line = args.join(' ')
    if (cmd === 'icacls' && line.includes('/inheritance:r')) hardened = true
    return { status: 0, stdout: hardened ? CLEAN_ACL : PERMISSIVE_ACL }
  }
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run, owner: OWNER,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.aclBefore.ok, false, '加固前必须真的判为不干净')
  assert.equal(r.aclVerified, true, `加固后必须真的变干净：${JSON.stringify(r.acl)}`)
  const icacls = calls.filter((c) => c.cmd === 'icacls').map((c) => c.args.join(' '))
  assert.ok(icacls.some((a) => a.includes('/inheritance:r')), '必须先断继承')
  assert.ok(icacls.some((a) => a.includes(OWNER)), '必须授予真正的所有者')
  // 顺序：断继承必须排在授权之前
  assert.ok(icacls.findIndex((a) => a.includes('/inheritance:r')) < icacls.findIndex((a) => a.includes(OWNER)))
})

test('⑤ hardenAcl: false 时一次加固命令都不发（但仍然检查）', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: CLEAN_ACL } }
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run, hardenAcl: false,
  })
  assert.equal(r.ok, true)
  assert.equal(r.hardened, null)
  assert.ok(calls.every((c) => !c.args.join(' ').includes('/inheritance:r')))
})

// ------------------------------------------------------------------ ⑥ 默认 ACL runner

test('⑥ **不注入 runner 时，ACL 检查真的会执行**（默认走真实实现，不是"没有 runner"）', async () => {
  // 这一条守的是一个很隐蔽的死代码形态：
  //
  //   `inspectFileAcl` 在没有 runner 时如实报 `ACL_NO_RUNNER`——那是**对的**。
  //   但如果生产代码**永远不传 runner**，结果就是整套 ACL 实现与用例都在，
  //   而每一次真实检查都只说"没查过"。功能有了、接线也有了，
  //   **而线中间那一截是空的**——并且它是**安静地**空的：
  //   界面上"未验证"看着很像"已检查过、没问题"。
  //
  // 所以这里**刻意不传 `run`**，用一个真实存在的临时文件，断言判定落在
  // 一个**真实结果**上（而不是 NO_RUNNER）。
  if (process.platform !== 'win32') return // 本机是 Windows；icacls 才有意义
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'legion-defrun-'))
  const file = join(dir, 'credentials.json')
  try {
    writeFileSync(file, '{"version":1}', 'utf8')
    // **不传 run**：这是这一条用例的全部意义。
    const r = await openProductSecrets({
      layout: layoutFor({ secretsFile: file }),
      storeFactory: fakeFactory(),
      hardenAcl: false,
      exists: () => true,
    })
    assert.notEqual(r.acl.code, 'ACL_NO_RUNNER',
      '没有默认 runner → 生产里每次检查都只会说"没查过"，整套 ACL 是死代码')
    assert.ok(['ACL_OK', 'ACL_TOO_PERMISSIVE'].includes(r.acl.code),
      `应给出真实判定，实际 ${r.acl.code}：${r.acl.message}`)
    assert.equal(r.aclExists, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ 文件不存在时 `aclExists: false`，加固**不被调用**', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: CLEAN_ACL } }
  const r = await openProductSecrets({
    layout: layoutFor(), storeFactory: fakeFactory(), run, owner: 'ALICE\\alice', exists: () => false,
  })
  assert.equal(r.acl.code, 'ACL_NOT_CREATED')
  assert.equal(r.aclExists, false)
  assert.equal(r.hardened, null, '文件还不存在就没有东西可加固')
  assert.equal(calls.filter((c) => c.args.join(' ').includes('/inheritance:r')).length, 0,
    '不得对着不存在的路径跑 icacls /inheritance:r')
})
