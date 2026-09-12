// team-hub/secret-admin.test.mjs
// ============================================================================
// spec §6.7 的**写**一半：凭证的新增 / 更新 / 轮换 / 删除
//
// 这一组存在的前提是：在它之前，`security/secrets/store.mjs` 的
// `put` / `rotate` / `remove` 在整个仓库里**零生产调用方**——
// 有实现、有套件、有文档，而没有任何入口能触发它们。
//
//   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
//
// 而**写路径引入了两个读路径上不存在的问题**，这一组的后半部分全部在守它们：
//
//   ① 写入走 `临时文件 + rename`，Windows 上 `mode:0o600` 被忽略、
//      新文件的 ACE 继承自目录 —— 于是**每一次写入都会重置**上一次加固出来的
//      "仅所有者可读"。所以必须**每次写完都重新核验**，而不是只在打开时核验一次。
//
//   ② 全新安装上，第一次写入**必然**发生在"文件还不存在 ⇒ 没有加固过"之后。
//
// 还有一条横向的：写成功之后**必须**让探测缓存失效，否则轮换完密钥点
// 「测试连接」拿到的还是**用旧钥匙得出的旧结论**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSecretAdmin, SECRET_ADMIN_CODES } from './secret-admin.mjs'
import { createProtector, createSecretStore, memoryBackend } from '../security/secrets/store.mjs'
import { ACL_CODES } from '../security/secrets/acl.mjs'

const SECRETS_FILE = 'C:\\Users\\a\\AppData\\Local\\Legion\\secrets\\credentials.json'
const LAYOUT_OK = { layout: { secretsFile: SECRETS_FILE }, diagnostics: [] }

/** 一个"受保护"的假保护器：blob 不是明文，于是"密文里不含明文"可断言。 */
const protector = () => createProtector({
  scheme: 'dpapi-user',
  protect: (v) => `ENC[${Buffer.from(v, 'utf8').toString('base64')}]`,
  unprotect: (b) => Buffer.from(String(b).slice(4, -1), 'base64').toString('utf8'),
})

const ACL_OK = Object.freeze({
  ok: true, code: ACL_CODES.OK, message: '文件访问控制：仅所有者可读写',
  principals: [], owner: null, platform: 'win32', skipped: false,
})
const ACL_PERMISSIVE = Object.freeze({
  ok: false, code: ACL_CODES.TOO_PERMISSIVE, message: '文件访问控制：存在越权主体',
  principals: [], owner: null, platform: 'win32', skipped: false,
})
const ACL_NOT_CREATED = Object.freeze({
  ok: false, code: ACL_CODES.NOT_CREATED, message: '密钥库文件尚未创建（首次写入密钥时创建）；此时没有可保护的内容',
  principals: [], owner: null, platform: 'win32', skipped: false,
})

/** 一个真实的密钥库（内存后端 + 真保护器），挂在假的 `openSecrets` 后面。 */
function realStore() {
  return createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => '2026-01-01T00:00:00.000Z' })
}

/**
 * 假的 `openProductSecrets`。
 *
 * `aclSeq` 让每一次打开返回**不同**的 ACL 结论——这正是要验的东西：
 * 写入之后**又打开了一次**，而不是只在最开始打开过一次。
 */
function fakeOpen({ store = realStore(), aclSeq = null, ok = true, code = 'SECRETS_OK', message = '密钥库可用' } = {}) {
  const opens = []
  const seq = aclSeq ?? [ACL_OK]
  const impl = async () => {
    const acl = seq[Math.min(opens.length, seq.length - 1)]
    opens.push({ acl: acl.code })
    if (ok !== true) {
      return { ok: false, code, message, path: SECRETS_FILE, store: null, resolver: null, protection: null, acl: null, aclVerified: false, aclExists: false }
    }
    // 与真实实现同一手法：计数而不列名（引用名不进自检结果）。
    let count = null
    try {
      const listed = await store.list()
      count = Array.isArray(listed) ? listed.length : null
    } catch { /* 取不到不影响可用性判定 */ }
    return {
      ok: true, code: 'SECRETS_OK', message,
      path: SECRETS_FILE, store, count, resolver: { resolveSecret: async () => 'v' },
      protection: { scheme: 'dpapi-user', protected: true },
      acl, aclVerified: acl.ok === true, aclExists: acl.code !== ACL_CODES.NOT_CREATED,
    }
  }
  impl.opens = opens
  return impl
}

const admin = (over = {}) => {
  const opened = over.opened ?? fakeOpen()
  return {
    opened,
    a: createSecretAdmin({ resolveLayoutImpl: () => LAYOUT_OK, openSecrets: opened, owner: 'DOM\\u', platform: 'win32', ...over }),
  }
}

// ============================================================================
// ① 正常路径：写入真的落进了密钥库
// ============================================================================

test('① `put` 真的把密钥写进密钥库（不是"接口在、东西没存"）', async () => {
  const store = realStore()
  const { a } = admin({ opened: fakeOpen({ store }) })
  const r = await a.put({ ref: 'K1', value: 'sk-live-1' })

  assert.equal(r.meta.ref, 'K1')
  assert.equal(r.meta.purpose, 'model-credential', 'purpose 缺省值由密钥库给，接口层不另造一个')
  assert.equal(r.meta.scheme, 'dpapi-user')
  // **直查后端**：断言"接口说存了"与"东西真的在里面"是两件事。
  assert.equal((await store.get('K1')).value, 'sk-live-1')
})

test('① 响应里**永远没有值**（元数据可以给，密钥不行）', async () => {
  const { a } = admin()
  const r = await a.put({ ref: 'K1', value: 'sk-live-1' })
  const dump = JSON.stringify(r)
  assert.equal(dump.includes('sk-live-1'), false, `响应里出现了密钥明文：${dump}`)
  // 连密文都不给：密文长度也能泄漏信息，而它会进日志。
  assert.equal(dump.includes('ENC['), false)
  assert.deepEqual(Object.keys(r.meta).sort(), ['createdAt', 'purpose', 'ref', 'rotatedAt', 'scheme', 'updatedAt'])
})

test('① `list` 给出引用与元数据，同样没有值', async () => {
  const { a } = admin()
  await a.put({ ref: 'K1', value: 'sk-live-1', purpose: 'model-credential' })
  const r = await a.list()
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].ref, 'K1')
  assert.equal(r.entries[0].purpose, 'model-credential')
  assert.equal(JSON.stringify(r).includes('sk-live-1'), false)
})

test('① 重复 `put` 同一个引用 = 更新，并记下 `updatedAt`（不是新增第二条）', async () => {
  const store = realStore()
  const { a } = admin({ opened: fakeOpen({ store }) })
  await a.put({ ref: 'K1', value: 'first' })
  await a.put({ ref: 'K1', value: 'second' })
  const r = await a.list()
  assert.equal(r.entries.length, 1, '同一个引用只能有一条')
  assert.equal((await store.get('K1')).value, 'second')
})

test('① `rotate` 换值、保住引用名、并记下 `rotatedAt`', async () => {
  const store = realStore()
  const { a } = admin({ opened: fakeOpen({ store }) })
  await a.put({ ref: 'K1', value: 'old' })
  const r = await a.rotate({ ref: 'K1', value: 'new' })
  assert.equal(r.meta.ref, 'K1')
  assert.equal(r.meta.rotatedAt, '2026-01-01T00:00:00.000Z')
  assert.equal((await store.get('K1')).value, 'new')
})

test('① `remove` 真删掉了；对一个不存在的引用是**幂等**的 false，不是 404', async () => {
  const store = realStore()
  const { a } = admin({ opened: fakeOpen({ store }) })
  await a.put({ ref: 'K1', value: 'v' })
  assert.equal((await a.remove('K1')).removed, true)
  await assert.rejects(() => store.get('K1'))
  // 删除的意图是"让这个引用不存在"，而它已经不存在了 —— 那不是错误。
  // （轮换不同：轮换一个不存在的引用没有任何可轮换的对象，那是错误。）
  assert.equal((await a.remove('K1')).removed, false)
})

test('① `list` 的投影是**白名单**：后端多给了字段，出口也必须没有', async () => {
  // 这条用例是上一版**漏掉**的，而漏掉的原因值得记下来：
  // 真实的后端行恰好只有 6 个字段，与本接口投影出来的字段**一模一样**，
  // 所以"原样透传整行"与"按白名单投影"在真实后端上**输出完全相同**——
  //   > 一个把 bug 断言成规格的用例，与一份错误的规格完全同形。
  // 要让这两者分开，夹具必须给出**真实后端今天不会给、但明天可能给**的东西。
  // 密钥库后端是一个可替换的接缝，换一个实现就多一个字段——
  // 而多出来的那个字段会直接进响应、进日志、进诊断包。
  const leaky = createSecretStore({ backend: memoryBackend(), protector: protector(), now: () => 'T' })
  const leakyList = async () => (await leaky.list()).map((r) => ({ ...r, blob: 'ENC[secret-ciphertext]', value: 'sk-leaked' }))
  await leaky.put('K1', 'sk-live-1', { purpose: 'model-credential' })
  const { a } = admin({ opened: fakeOpen({ store: { ...leaky, list: leakyList } }) })

  const r = await a.list()
  assert.equal(r.entries.length, 1)
  assert.deepEqual(Object.keys(r.entries[0]).sort(),
    ['createdAt', 'purpose', 'ref', 'rotatedAt', 'scheme', 'updatedAt'],
    '出口的字段集必须是固定的白名单，而不是"后端给什么就透出什么"')
  assert.equal(JSON.stringify(r).includes('sk-leaked'), false)
  assert.equal(JSON.stringify(r).includes('ENC['), false, '连密文都不给：密文长度也能泄漏信息')
})

// ============================================================================
// ② 错误：区分"密钥不存在"与"密钥库打不开"
// ============================================================================

test('② 后端抛出的异常里带了值 → 出口**不得**把它带出来', async () => {
  // 这条也是补的。第一版只断言了"已知的 `SecretStoreError` 不带值"，
  // 而那条路径上**本来就没有值可带**（它的上下文是白名单）——
  // 于是用例恒绿，验的是实现已经免费具备的性质。
  //
  // 真正需要守的是**默认分支**：非 `SecretStoreError` 的异常会被收敛，
  // 而收敛时**不能顺手把 `message` 带出去**。这不是假想：保护器（DPAPI）
  // 与文件后端都在密钥库外面，它们的异常文本由别人的代码决定，
  // 而"写入失败：<内容>"这样的措辞并不罕见。
  const store = {
    list: async () => [],
    remove: async () => false,
    get: async () => { throw new Error('nope') },
    put: async () => { throw new Error('写入失败：sk-third-party-leak') },
    rotate: async () => { throw new Error('nope') },
  }
  const { a } = admin({ opened: fakeOpen({ store }) })
  const err = await a.put({ ref: 'K1', value: 'sk-third-party-leak' }).then(() => null, (e) => e)

  assert.ok(err !== null, '要抛')
  assert.equal(String(err.message).includes('sk-third-party-leak'), false,
    `异常文本里带出了值，而异常会进日志、上报与诊断包：${err.message}`)
  assert.equal(JSON.stringify(Object.keys(err)).includes('value'), false)
  // 但**失败的种类要留下**：收紧措辞的代价不能是"完全查不出为什么"。
  assert.equal(err.causeCode, undefined, '这一类异常没有内部码，不要编一个出来')
  assert.match(err.message, /Error/, '至少要说清是哪一类失败（而不是把 message 也一起丢掉）')
  assert.equal(err.code, SECRET_ADMIN_CODES.WRITE_FAILED)
})


test('② 轮换一个没录入过的引用 → `SECRET_NOT_FOUND` / 404（**不是** 503）', async () => {
  const { a } = admin()
  await assert.rejects(
    () => a.rotate({ ref: 'NOPE', value: 'v' }),
    (e) => {
      assert.equal(e.code, SECRET_ADMIN_CODES.NOT_FOUND)
      assert.equal(e.statusCode, 404, '"这把钥匙没有"是调用方要处理的，不是服务不可用')
      return true
    })
})

test('② 密钥库打不开 → `STORE_UNAVAILABLE` / 503，且**不降级成明文存储**', async () => {
  const { a } = admin({ opened: fakeOpen({ ok: false, code: 'SECRETS_STORE_UNPROTECTED', message: '密钥库后端未提供受保护存储' }) })
  await assert.rejects(
    () => a.put({ ref: 'K1', value: 'v' }),
    (e) => {
      assert.equal(e.code, SECRET_ADMIN_CODES.STORE_UNAVAILABLE)
      assert.equal(e.statusCode, 503)
      return true
    })
  // 关键：503 说的是"现在没法提供这项服务"，**不是**"我用了明文帮你存上了"。
  // 写路径上明文后端会把用户的真实密钥明文落盘——那是不可逆的。
})

test('② 打不开时**措辞不指向密钥本身**（否则用户会去查一把根本读不到的钥匙）', async () => {
  const { a } = admin({ opened: fakeOpen({ ok: false, code: 'SECRETS_STORE_UNPROTECTED', message: '密钥库后端未提供受保护存储（scheme=none）' }) })
  const err = await a.put({ ref: 'K1', value: 'v' }).then(() => null, (e) => e)
  assert.match(err.message, /受保护|密钥库/)
  assert.notEqual(err.code, SECRET_ADMIN_CODES.NOT_FOUND, '别把"打不开"报成"没有这把钥匙"')
})

test('② 引用名为空 / 值非法 → 400（配置错误先于状态检查）', async () => {
  const { a } = admin()
  for (const [ref, value, expect] of [['', 'v', SECRET_ADMIN_CODES.REF_INVALID], ['K1', '', SECRET_ADMIN_CODES.VALUE_EMPTY]]) {
    await assert.rejects(() => a.put({ ref, value }), (e) => {
      assert.equal(e.code, expect)
      assert.equal(e.statusCode, 400)
      return true
    })
  }
})

test('② 错误对象里**没有密钥值**（异常会进日志、上报与诊断包）', async () => {
  const { a } = admin()
  const err = await a.put({ ref: '', value: 'sk-must-not-leak' }).then(() => null, (e) => e)
  assert.equal(String(err.message).includes('sk-must-not-leak'), false)
  assert.equal(JSON.stringify(Object.keys(err)).includes('value'), false)
})

// ============================================================================
// ③ 每次写入之后都要重新核验 ACL —— 写路径引入的问题 ①
// ============================================================================

test('③ **每次写入之后都重新打开/核验**（写入会重置文件权限）', async () => {
  // 写入走 `临时文件 + rename`。Windows 上 `mode:0o600` 基本被忽略，
  // 新文件的 ACE 继承自目录 —— 上一次加固出来的"仅所有者可读"就没了。
  // 所以"打开时核验过一次"是不够的：**每一次写入之后**都得再核验。
  const opened = fakeOpen({ aclSeq: [ACL_PERMISSIVE, ACL_OK] })
  const { a } = admin({ opened })

  assert.equal(opened.opens.length, 0, '还没有动作时不该打开密钥库')
  await a.put({ ref: 'K1', value: 'v' })
  assert.equal(opened.opens.length, 2,
    `写入之后必须**再**核验一次；实际打开了 ${opened.opens.length} 次：${JSON.stringify(opened.opens)}`)
})

test('③ 全新安装：第一次写入前"文件不存在"，写入之后**必须**再核验（否则第一次加固永远不发生）', async () => {
  // `openProductSecrets` 刻意不对不存在的文件加固（`ACL_NOT_CREATED`，
  // 因为对着不存在的路径跑 `icacls /grant` 只会失败并留下假告警）。
  // 而写路径恰好就是**创建**这个文件的那一步 —— 于是第一次写入之前，
  // 加固被跳过了；不再核验一次的话，这个文件**从来没有被加固过**。
  const opened = fakeOpen({ aclSeq: [ACL_NOT_CREATED, ACL_OK] })
  const { a } = admin({ opened })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(opened.opens.length, 2, '写入之后的那一次核验才是真正加固文件的那一次')
  assert.equal(r.aclVerified, true, '第二次核验通过了，结论要如实回给调用方')
})

test('③ 重新核验仍不通过 → `ok` 是成功的，但 `aclVerified:false` **必须**出现', async () => {
  // 凭证已经写进去了，此时报"失败"会让用户以为要重做一遍。
  // 但"没核验过"绝不能看起来像"已确认安全"。
  const { a } = admin({ opened: fakeOpen({ aclSeq: [ACL_PERMISSIVE, ACL_PERMISSIVE] }) })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1', '写入本身是成功的')
  assert.equal(r.aclVerified, false)
  assert.equal(r.acl.code, ACL_CODES.TOO_PERMISSIVE, '把真实的 ACL 结论带出来，而不是一个笼统的 false')
})

test('③ 重新核验本身抛错 → 写入仍算成功，但给出 `aclNote` 说明"没能核验"', async () => {
  let n = 0
  const opened = async () => {
    n += 1
    if (n === 1) {
      return { ok: true, path: SECRETS_FILE, store: realStore(), protection: { scheme: 's', protected: true }, acl: ACL_OK, aclVerified: true, aclExists: true, resolver: {} }
    }
    throw new Error('复核时密钥库炸了')
  }
  const { a } = admin({ opened })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1', '复核失败不能把一次成功的写入报成失败')
  assert.equal(r.aclVerified, false)
  assert.match(r.aclNote ?? '', /无法重新核验/)
})

// ============================================================================
// ④ 写成功之后必须让探测缓存失效 —— `invalidate()` 等了很久的那个调用方
// ============================================================================

test('④ 每一次成功的写入都通知"凭证变了"（否则测试连接回的是用旧钥匙得出的旧结论）', async () => {
  const seen = []
  const { a } = admin({ onCredentialsChanged: (x) => { seen.push(x.ref) } })
  await a.put({ ref: 'K1', value: 'v' })
  await a.rotate({ ref: 'K1', value: 'v2' })
  await a.remove('K1')
  assert.deepEqual(seen, ['K1', 'K1', 'K1'])
})

test('④ 写入**失败**时不得发"凭证变了"（那会让一次没发生的变更看起来发生了）', async () => {
  const seen = []
  const { a } = admin({ onCredentialsChanged: (x) => { seen.push(x.ref) } })
  await assert.rejects(() => a.rotate({ ref: 'NOPE', value: 'v' }))
  assert.deepEqual(seen, [])
})

test('④ 失效回调自己抛错 → 不影响写入的成功结论（两个后果不许互相污染）', async () => {
  const { a } = admin({ onCredentialsChanged: () => { throw new Error('缓存失效炸了') } })
  const r = await a.put({ ref: 'K1', value: 'v' })
  assert.equal(r.meta.ref, 'K1')
})

test('④ 失效发生在重新核验**之后**（先失效再复核等于白失效一次）', async () => {
  const order = []
  const opened = fakeOpen()
  const a = createSecretAdmin({
    resolveLayoutImpl: () => LAYOUT_OK, owner: 'DOM\\u', platform: 'win32',
    openSecrets: async (args) => { order.push('open'); return await opened(args) },
    onCredentialsChanged: () => { order.push('invalidate') },
  })
  await a.put({ ref: 'K1', value: 'v' })
  assert.deepEqual(order, ['open', 'open', 'invalidate'])
})

// ============================================================================
// ⑤ 审计：四个动作都留痕，且没有密文
// ============================================================================

test('⑤ 新增/更新/轮换/删除各自留下审计，且审计里没有密文', async () => {
  const events = []
  // 审计回调挂在**密钥库**上（白名单在那里面强制），所以这里用的是
  // 一个真的 store、带真的 onAudit —— 而不是在 admin 那层假装。
  const store = createSecretStore({
    backend: memoryBackend(), protector: protector(), now: () => 'T',
    onAudit: (e) => events.push(e),
  })
  const { a } = admin({ opened: fakeOpen({ store }) })

  await a.put({ ref: 'K1', value: 'sk-1' })
  await a.rotate({ ref: 'K1', value: 'sk-2' })
  await a.remove('K1')

  assert.deepEqual(events.map((e) => e.action), ['secret.created', 'secret.rotated', 'secret.deleted'])
  // 审计是会被导出与上报的东西：**密文长度也能泄漏信息**，所以连密文都不许有。
  assert.equal(JSON.stringify(events).includes('sk-1'), false)
  assert.equal(JSON.stringify(events).includes('ENC['), false)
  assert.deepEqual(Object.keys(events[0]).sort(), ['action', 'at', 'purpose', 'ref'])
})

// ============================================================================
// ⑥ describe：只读状态**不含引用名**
// ============================================================================

test('⑥ `describe` 只给计数，**不给引用名**（引用名能画出这台机器配了哪些供应商）', async () => {
  const { a } = admin()
  await a.put({ ref: 'vendor-alpha-key', value: 'v' })
  const d = await a.describe()
  assert.equal(d.ok, true)
  assert.equal(JSON.stringify(d).includes('vendor-alpha-key'), false,
    '自检形态的结果会被显示与记录，引用名不进这里（与 product/secrets.mjs ④ 同一条纪律）')
  assert.equal(d.count, 1, '但要给得出**有几条**')
})

test('⑥ `describe` 在密钥库打不开时如实报，且不抛（它是要显示给人看的）', async () => {
  const { a } = admin({ opened: fakeOpen({ ok: false, code: 'SECRETS_LAYOUT_BLOCKED', message: '布局未确定' }) })
  const d = await a.describe()
  assert.equal(d.ok, false)
  assert.equal(d.code, 'SECRETS_LAYOUT_BLOCKED')
})
