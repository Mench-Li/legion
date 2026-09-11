// security/secrets/secrets.test.mjs
// ============================================================================
// PRT-505 / PRT-258：密钥库最小闭环的判据。
//
// 本套用例的重点是**泄漏与静默退化**两类失败，它们都不会抛异常：
//   ① 元数据接口（list/toJSON/审计/错误）把值或密文带出去；
//   ② 受保护后端不可用时**退化**为明文，于是「密钥受保护」在部分机器上悄悄失效。
//
// 另有一组用例跑**真实 DPAPI 往返**（Windows 上）：只用假加解密函数，
// 只能证明「我调用了自己的函数」，证明不了「换账户后真的解不开」这件事成立。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSecretRef, isSecretRef } from './ref.mjs'
import { SecretStoreError } from './errors.mjs'
import { DPAPI_SCHEME, probeDpapi } from './dpapi.mjs'
import {
  assertProtectedStore,
  createDpapiProtector,
  createProductSecretStore,
  createProtector,
  createSecretStore,
  fileBackend,
  memoryBackend,
  nullProtector,
} from './store.mjs'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'

function tmpFile(name = 'secrets.json') {
  const dir = mkdtempSync(join(tmpdir(), 'legion-secret-'))
  return { dir, file: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 可逆的假保护器：只用于验证 store 的接线，不冒充 DPAPI。 */
function fakeProtector() {
  return createProtector({
    scheme: DPAPI_SCHEME,
    protect: (v) => `enc:${Buffer.from(v, 'utf8').toString('base64')}`,
    unprotect: (b) => {
      const text = String(b)
      if (!text.startsWith('enc:')) throw new Error('not-a-blob')
      return Buffer.from(text.slice(4), 'base64').toString('utf8')
    },
  })
}

// ---------------------------------------------------------------- 引用名

test('SecretRef：合法/非法形态，且必须拒绝路径穿越', () => {
  for (const ok of ['legion/openai-default', 'a', 'A.b_c:d-e', 'legion/model.1']) {
    assert.equal(isSecretRef(ok), true, `${ok} 应合法`)
  }
  for (const bad of ['', '.', '..', '../x', 'a/../b', 'a//b', 'a b', '/lead', '-lead', 'a'.repeat(129), null, 42, '密钥']) {
    assert.equal(isSecretRef(bad), false, `${String(bad)} 应非法`)
  }
  assert.throws(() => assertSecretRef('../x'), /不是合法引用名/)
})

// ---------------------------------------------------------------- 基本闭环

test('put/get/list/rotate/remove：闭环可用，且元数据接口不带值', async () => {
  const backend = memoryBackend()
  const audits = []
  const store = createSecretStore({
    backend,
    protector: fakeProtector(),
    now: () => '2026-09-11T00:00:00.000Z',
    onAudit: (e) => audits.push(e),
  })

  const meta = await store.put('legion/openai', SECRET, { purpose: 'model-credential' })
  assert.equal(meta.ref, 'legion/openai')
  assert.equal(meta.purpose, 'model-credential')
  assert.equal(meta.createdAt, '2026-09-11T00:00:00.000Z')
  assert.equal(meta.rotatedAt, null)

  // 落盘（内存后端）里存的必须是密文，不是明文
  assert.notEqual(backend.rawBlob('legion/openai'), SECRET)
  assert.equal(backend.rawBlob('legion/openai').includes(SECRET), false)

  const got = await store.get('legion/openai')
  assert.equal(got.value, SECRET)

  const list = await store.list()
  assert.equal(list.length, 1)
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'purpose', 'ref', 'rotatedAt', 'scheme', 'updatedAt'])
  assert.equal(JSON.stringify(list).includes(SECRET), false)
  assert.equal(JSON.stringify(store).includes(SECRET), false, 'JSON.stringify(store) 必须脱敏')
  assert.equal(String(store).includes(SECRET), false)

  await store.rotate('legion/openai', `${SECRET}-rotated`)
  const rotated = await store.get('legion/openai')
  assert.equal(rotated.value, `${SECRET}-rotated`)
  const afterRotate = await store.describe('legion/openai')
  assert.equal(afterRotate.rotatedAt, '2026-09-11T00:00:00.000Z')

  assert.equal(await store.remove('legion/openai'), true)
  assert.equal(await store.has('legion/openai'), false)
  await assert.rejects(() => store.get('legion/openai'), (e) => e.code === 'SECRET_NOT_FOUND' && e.runtimeCode === 'SECRET_UNAVAILABLE')

  // 审计只记动作与引用，不含值/密文
  assert.deepEqual(audits.map((a) => a.action), ['secret.created', 'secret.rotated', 'secret.deleted', 'secret.read-failed'])
  const auditText = JSON.stringify(audits)
  assert.equal(auditText.includes(SECRET), false)
  assert.equal(auditText.includes('enc:'), false)
})

test('rotate 不存在的引用必须失败，而不是静默创建', async () => {
  const store = createSecretStore({ backend: memoryBackend(), protector: fakeProtector(), now: () => 't' })
  await assert.rejects(() => store.rotate('legion/missing', 'x'), (e) => e.code === 'SECRET_NOT_FOUND')
})

test('空值与非法引用必须被拒绝（写进库但读不出来的记录是最坏的形态）', async () => {
  const store = createSecretStore({ backend: memoryBackend(), protector: fakeProtector(), now: () => 't' })
  await assert.rejects(() => store.put('legion/x', ''), (e) => e.code === 'SECRET_VALUE_EMPTY')
  await assert.rejects(() => store.put('../escape', SECRET), (e) => e.code === 'SECRET_REF_INVALID')
})

// ---------------------------------------------------------------- 保护等级

test('明文后端必须被 assertProtectedStore 拒绝，不得「能跑就先跑着」', async () => {
  const store = createSecretStore({ backend: memoryBackend(), protector: nullProtector(), now: () => 't' })
  assert.deepEqual(store.protection(), { scheme: 'none', protected: false })
  assert.throws(() => assertProtectedStore(store), (e) => e.code === 'SECRET_STORE_UNPROTECTED' && e.runtimeCode === 'SECRET_UNAVAILABLE')

  const protectedStore = createSecretStore({ backend: memoryBackend(), protector: fakeProtector(), now: () => 't' })
  assert.equal(assertProtectedStore(protectedStore), protectedStore)
})

// ---------------------------------------------------------------- 文件后端

test('文件后端：跨实例可读、原子写、损坏与不可解密都 fail closed', async () => {
  const { file, cleanup } = tmpFile()
  try {
    const store1 = createSecretStore({ backend: fileBackend({ file }), protector: fakeProtector(), now: () => 't1' })
    await store1.put('legion/openai', SECRET)
    const onDisk = readFileSync(file, 'utf8')
    assert.equal(onDisk.includes(SECRET), false, '落盘文件不得含明文')
    assert.equal(JSON.parse(onDisk).version, 1)
    assert.ok(JSON.parse(onDisk).records['legion/openai'].blob.startsWith('enc:'))

    // 新实例（模拟重启）能读出来
    const store2 = createSecretStore({ backend: fileBackend({ file }), protector: fakeProtector(), now: () => 't2' })
    assert.equal((await store2.get('legion/openai')).value, SECRET)

    // ① 把 blob 换成**格式合法但内容不同**的密文：读出来必须是那个新值。
    //    这条断言守的是「store 真的在做解密」——若某天有人把 blob 当明文直传，
    //    这条会红，而只测「能读回原值」的用例在那种实现下依然全绿。
    const tampered = JSON.parse(onDisk)
    tampered.records['legion/openai'].blob = 'enc:' + Buffer.from('other').toString('base64')
    writeFileSync(file, JSON.stringify(tampered), 'utf8')
    const store3 = createSecretStore({ backend: fileBackend({ file }), protector: fakeProtector(), now: () => 't3' })
    assert.equal((await store3.get('legion/openai')).value, 'other')

    // ② blob 损坏 → fail closed，且错误文本里既不得有明文也不得回显 blob 原文
    tampered.records['legion/openai'].blob = 'not-a-blob'
    writeFileSync(file, JSON.stringify(tampered), 'utf8')
    const store4 = createSecretStore({ backend: fileBackend({ file }), protector: fakeProtector(), now: () => 't4' })
    await assert.rejects(
      () => store4.get('legion/openai'),
      (e) => e.code === 'SECRET_DECRYPT_FAILED'
        && e.runtimeCode === 'SECRET_UNAVAILABLE'
        && !e.message.includes(SECRET)
        && !e.message.includes('not-a-blob'),
    )

    // 结构损坏 → SECRET_STORE_CORRUPT（不是「密钥不存在」）
    writeFileSync(file, '{ not json', 'utf8')
    const store5 = createSecretStore({ backend: fileBackend({ file }), protector: fakeProtector(), now: () => 't5' })
    await assert.rejects(() => store5.list(), (e) => e.code === 'SECRET_STORE_CORRUPT')
  } finally {
    cleanup()
  }
})

test('DPAPI 保护器在非 Windows 上必须抛错，不得退化为明文', () => {
  assert.throws(
    () => createDpapiProtector({ platform: 'linux' }),
    (e) => e.code === 'SECRET_STORE_UNSUPPORTED_PLATFORM' && e.runtimeCode === 'SECRET_UNAVAILABLE',
  )
  assert.equal(probeDpapi({ platform: 'linux' }).available, false)
})

// ---------------------------------------------------------------- 真实 DPAPI

const dpapiProbe = probeDpapi()
const dpapiSkip = dpapiProbe.available ? false : `本机不可用真实 DPAPI：${dpapiProbe.reason}（${dpapiProbe.hint}）`

test('真实 DPAPI 往返（当前用户作用域）：落盘为密文、重启后可解、换 blob 即解不开', { skip: dpapiSkip }, async () => {
  const { file, cleanup } = tmpFile('credentials.json')
  try {
    const store = createProductSecretStore({ file, now: () => '2026-09-11T00:00:00.000Z' })
    assert.deepEqual(store.protection(), { scheme: DPAPI_SCHEME, protected: true })
    await store.put('legion/openai', SECRET, { purpose: 'model-credential' })

    const onDisk = readFileSync(file, 'utf8')
    assert.equal(onDisk.includes(SECRET), false, 'DPAPI 密文里不得出现明文')

    // 新实例（模拟重启）用同一个 Windows 用户解密
    const reopened = createProductSecretStore({ file, now: () => '2026-09-11T00:00:01.000Z' })
    assert.equal((await reopened.get('legion/openai')).value, SECRET)

    // 换掉密文 → 必须是 fail closed 的明确错误，不能返回空串
    const tampered = JSON.parse(onDisk)
    tampered.records['legion/openai'].blob = 'deadbeef'
    writeFileSync(file, JSON.stringify(tampered), 'utf8')
    const broken = createProductSecretStore({ file, now: () => '2026-09-11T00:00:02.000Z' })
    await assert.rejects(
      () => broken.get('legion/openai'),
      (e) => e.runtimeCode === 'SECRET_UNAVAILABLE' && !e.message.includes(SECRET),
    )
  } finally {
    cleanup()
  }
})

test('错误对象本身不得成为泄漏点：cause 里的长十六进制串会被擦除', () => {
  const err = new SecretStoreError('SECRET_STORE_WRITE_FAILED', { cause: 'blob=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  assert.equal(err.message.includes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), false)
  assert.equal(err.runtimeErrorCode, 'SECRET_UNAVAILABLE')
})
