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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** 本文件所在目录：跨进程用例要拿到 store.mjs 的绝对 URL。 */
const HERE = dirname(fileURLToPath(import.meta.url))

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

// ============================================================================
// PRT-254：文件后端的**跨进程读-改-写**（并发写锁）
//
// 这一组守的是一种**不会抛异常**的失败：两次 read-modify-write 交错，后写的
// rename 把先写的整份内容覆盖掉，于是刚存进去的引用**静默消失**。
// 「写下去返回成功」与「存的东西下次启动不见了」在用户那一次操作里是同一个东西，
// 所以只测「写进去了吗」的用例抓不住它——必须有一个**争用者**在场。
//
// 夹具纪律：`lockTimeoutMs` 一律给极小值、`sleep` 一律注入空实现，
// 否则用例真的会睡（默认预算是 2 秒，而争用路径会把它耗满）。
// ============================================================================

/** 造一个"另一个进程正持有锁"的现场。锁文件内容写成别人的 token。 */
function holdLockFromOutside(file, { token = 'someone-else-1234' } = {}) {
  writeFileSync(`${file}.lock`, token, 'utf8')
  return `${file}.lock`
}

test('★ 别人持锁时**拒绝写入**（不无锁照写、不把失败报成成功），且库文件一字未改', () => {
  const { file, cleanup } = tmpFile()
  try {
    const backend = fileBackend({ file })
    backend.write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    const before = readFileSync(file, 'utf8')

    holdLockFromOutside(file)
    const mutex = fileBackend({ file, lockTimeoutMs: 30, lockRetryMs: 1, sleep: () => {} })

    assert.throws(
      () => mutex.write('legion/b', { blob: 'enc:B', meta: { scheme: 'dpapi', purpose: 'model-credential' } }),
      (e) => e.code === 'SECRET_STORE_LOCK_TIMEOUT' && e.runtimeCode === 'SECRET_UNAVAILABLE',
      '别人持锁时必须具名拒绝——"无锁照写"正好把丢更新重新变成静默的',
    )
    // ★ 这一条才是本用例的重点：拒绝之后**磁盘上什么都没变**。
    //   只断言"抛了错"的用例，在一个"先写坏再抛"的实现下依然全绿。
    assert.equal(readFileSync(file, 'utf8'), before, '拿到锁失败时不得改动库文件')
  } finally {
    cleanup()
  }
})

test('★ 陈旧的锁（持锁进程崩了）必须能破，否则密钥库被永久锁死', () => {
  const { file, cleanup } = tmpFile()
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    holdLockFromOutside(file)

    // 把"现在"推到 TTL 之外：锁文件的 mtime 是刚刚，年龄因此超过 10s。
    const backend = fileBackend({ file, nowMs: () => Date.now() + 60_000, lockRetryMs: 1, sleep: () => {} })
    backend.write('legion/b', { blob: 'enc:B', meta: { scheme: 'dpapi', purpose: 'model-credential' } })

    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(data.records['legion/a'] !== undefined, '破锁写入不得丢掉原有的引用')
    assert.ok(data.records['legion/b'] !== undefined, '破锁之后本次写入必须落地')
  } finally {
    cleanup()
  }
})

test('★ 锁 TTL 配成 0 时**不得**去破活锁（那不是"更宽松"，是把互斥拆掉）', () => {
  const { file, cleanup } = tmpFile()
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    holdLockFromOutside(file)
    // ttl=0 会让任何 age 都"超过 TTL"。若实现照破，这里就会写成功。
    const backend = fileBackend({ file, lockTtlMs: 0, lockTimeoutMs: 30, lockRetryMs: 1, sleep: () => {} })
    assert.throws(
      () => backend.write('legion/b', { blob: 'enc:B', meta: { scheme: 'dpapi', purpose: 'model-credential' } }),
      (e) => e.code === 'SECRET_STORE_LOCK_TIMEOUT',
    )
  } finally {
    cleanup()
  }
})

test('★ 写成功后锁被释放；写失败（finally）后锁也必须被释放', () => {
  const { file, cleanup } = tmpFile()
  const lock = `${file}.lock`
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    assert.equal(existsSync(lock), false, '成功路径必须释放锁')

    // 注入一个"锁能写、库文件写不了"的 fs：走 writeAll 的失败分支。
    const failing = {
      mkdirSync: nodeFs.mkdirSync,
      readFileSync: nodeFs.readFileSync,
      existsSync: nodeFs.existsSync,
      unlinkSync: nodeFs.unlinkSync,
      statSync: nodeFs.statSync,
      dirname,
      renameSync: nodeFs.renameSync,
      writeFileSync: (p, ...rest) => {
        if (String(p).includes('.tmp-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        return nodeFs.writeFileSync(p, ...rest)
      },
    }
    const backend = fileBackend({ file, fs: failing, lockRetryMs: 1, sleep: () => {} })
    assert.throws(
      () => backend.write('legion/c', { blob: 'enc:C', meta: { scheme: 'dpapi', purpose: 'model-credential' } }),
      (e) => e.code === 'SECRET_STORE_WRITE_FAILED',
    )
    assert.equal(existsSync(lock), false, '失败路径也必须释放锁——否则一次磁盘满就把密钥库锁死')
  } finally {
    cleanup()
  }
})

test('★★ 释放时**只删自己的锁**：别人已把陈旧的锁换成他的，就不许替他删', () => {
  const { file, cleanup } = tmpFile()
  const lock = `${file}.lock`
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })

    // 注入 fs：在 writeAll 的 rename 那一刻，模拟"我们的锁已过期、别人抢走并建了他自己的"。
    const FOREIGN = 'another-process-9999'
    const hijacking = {
      mkdirSync: nodeFs.mkdirSync,
      readFileSync: nodeFs.readFileSync,
      existsSync: nodeFs.existsSync,
      unlinkSync: nodeFs.unlinkSync,
      statSync: nodeFs.statSync,
      dirname,
      writeFileSync: nodeFs.writeFileSync,
      renameSync: (from, to) => {
        nodeFs.writeFileSync(lock, FOREIGN, 'utf8')
        return nodeFs.renameSync(from, to)
      },
    }
    fileBackend({ file, fs: hijacking }).write('legion/d', { blob: 'enc:D', meta: { scheme: 'dpapi', purpose: 'model-credential' } })

    assert.equal(existsSync(lock), true, '替别人删锁 = 同时放行两个写者')
    assert.equal(readFileSync(lock, 'utf8'), FOREIGN)
  } finally {
    cleanup()
  }
})

test('★★★ 真·跨进程：另一个**真进程**持锁时，本进程的写入被拒且库文件不变', () => {
  const { file, cleanup } = tmpFile()
  const lock = `${file}.lock`
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    const before = readFileSync(file, 'utf8')
    holdLockFromOutside(file, { token: 'parent-holds-it' })

    // 子进程走**真实的 fs**、真实的 store 模块。命中锁超时后把码打出来。
    const storeUrl = pathToFileURL(join(HERE, 'store.mjs')).href
    const script = [
      `import(${JSON.stringify(storeUrl)}).then((m) => {`,
      `  const b = m.fileBackend({ file: ${JSON.stringify(file)}, lockTimeoutMs: 40, lockRetryMs: 2 })`,
      `  try {`,
      `    b.write('legion/child', { blob: 'enc:C', meta: { scheme: 'dpapi', purpose: 'model-credential' } })`,
      `    console.log('OUTCOME=wrote')`,
      `  } catch (e) { console.log('OUTCOME=' + e.code) }`,
      `})`,
    ].join('\n')
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 })

    assert.match(out, /OUTCOME=SECRET_STORE_LOCK_TIMEOUT/, `子进程必须被锁挡住，实际输出：${out}`)
    assert.equal(readFileSync(file, 'utf8'), before, '被挡住的子进程不得改动库文件')
    assert.equal(readFileSync(lock, 'utf8'), 'parent-holds-it', '父进程的锁不得被子进程删掉')
  } finally {
    cleanup()
  }
})

test('★★★ 真·跨进程无争用时两个进程都能写：锁不会把正常写入误伤', () => {
  const { file, cleanup } = tmpFile()
  try {
    const storeUrl = pathToFileURL(join(HERE, 'store.mjs')).href
    const write = (ref) => {
      const script = [
        `import(${JSON.stringify(storeUrl)}).then((m) => {`,
        `  const b = m.fileBackend({ file: ${JSON.stringify(file)}, lockTimeoutMs: 2000 })`,
        `  b.write(${JSON.stringify(ref)}, { blob: 'enc:X', meta: { scheme: 'dpapi', purpose: 'model-credential' } })`,
        `  console.log('OUTCOME=ok')`,
        `})`,
      ].join('\n')
      return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 })
    }
    assert.match(write('legion/p1'), /OUTCOME=ok/)
    assert.match(write('legion/p2'), /OUTCOME=ok/)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(data.records['legion/p1'] !== undefined && data.records['legion/p2'] !== undefined,
      '顺序的两个进程写入都必须保留（锁被正确释放，没有把第二次写入挡在门外）')
    assert.equal(existsSync(`${file}.lock`), false, '正常结束后不得留下锁文件')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// ★★ 下面三条来自一次**真并发实测**，而不是从代码推演出来的：
//
//    8 进程 × 400 次建/删同一个路径，`wx` 的错误码分布是
//    `EEXIST 1393 / 成功 1594 / **EPERM 213**`。
//
//    "只认 EEXIST"的实现在**本文件此前那些用例里全绿**（它们都是静态造一个锁文件，
//    那报的正是 EEXIST），一到真并发就把 6.7% 的正常争用当成致命错误：
//    实测 8 进程 × 40 写只落 208/320。
//
//    一个"在夹具里认得出被占用"的判据，与一个"在真争用下认得出被占用"的判据，
//    在只跑单进程用例时是同一个东西。
// ---------------------------------------------------------------------------

test('★★ `wx` 报 EPERM 时必须当成**争用**重试（只认 EEXIST 会让真并发随机失败）', () => {
  const { file, cleanup } = tmpFile()
  const lock = `${file}.lock`
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })

    let attempts = 0
    const flaky = {
      mkdirSync: nodeFs.mkdirSync,
      readFileSync: nodeFs.readFileSync,
      existsSync: nodeFs.existsSync,
      unlinkSync: nodeFs.unlinkSync,
      statSync: nodeFs.statSync,
      renameSync: nodeFs.renameSync,
      dirname,
      writeFileSync: (p, ...rest) => {
        if (String(p) === lock) {
          attempts += 1
          // 前两次模拟"名字正被别人动"——Windows 上这就是 EPERM。
          if (attempts <= 2) throw Object.assign(new Error('access denied'), { code: 'EPERM' })
        }
        return nodeFs.writeFileSync(p, ...rest)
      },
    }
    const backend = fileBackend({ file, fs: flaky, lockRetryMs: 1, sleep: () => {} })
    backend.write('legion/e', { blob: 'enc:E', meta: { scheme: 'dpapi', purpose: 'model-credential' } })

    assert.equal(attempts, 3, '两次 EPERM 必须被当成争用并重试到第三次成功，而不是当场报致命错')
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).records['legion/e'] !== undefined)
  } finally {
    cleanup()
  }
})

test('★★ 锁**始终建不出来**（目录不可写）→ 报"建不出来"而不是"抢不到"，且不残留锁', () => {
  const { file, cleanup } = tmpFile()
  const lock = `${file}.lock`
  try {
    fileBackend({ file }).write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
    const before = readFileSync(file, 'utf8')

    const denied = {
      mkdirSync: nodeFs.mkdirSync,
      readFileSync: nodeFs.readFileSync,
      existsSync: nodeFs.existsSync,
      unlinkSync: nodeFs.unlinkSync,
      statSync: nodeFs.statSync,
      renameSync: nodeFs.renameSync,
      dirname,
      writeFileSync: (p, ...rest) => {
        if (String(p) === lock) throw Object.assign(new Error('denied'), { code: 'EPERM' })
        return nodeFs.writeFileSync(p, ...rest)
      },
    }
    const backend = fileBackend({ file, fs: denied, lockTimeoutMs: 30, lockRetryMs: 1, sleep: () => {} })
    assert.throws(
      () => backend.write('legion/f', { blob: 'enc:F', meta: { scheme: 'dpapi', purpose: 'model-credential' } }),
      // 全程没人持有锁 ⇒ 真因是"建不出来"，不是"别人占着"。两个码的修法不同。
      (e) => e.code === 'SECRET_STORE_LOCK_FAILED',
    )
    assert.equal(readFileSync(file, 'utf8'), before, '建不出锁时不得改动库文件')
    assert.equal(existsSync(lock), false)
  } finally {
    cleanup()
  }
})

test('★★★ 真并发实测的回归闸：6 个进程各写 15 条，90 条一条都不许丢', async () => {
  const { file, cleanup } = tmpFile()
  const PROCS = 6
  const PER = 15
  try {
    const storeUrl = pathToFileURL(join(HERE, 'store.mjs')).href
    const kids = []
    for (let i = 0; i < PROCS; i++) {
      const script = [
        `import(${JSON.stringify(storeUrl)}).then((m) => {`,
        `  const b = m.fileBackend({ file: ${JSON.stringify(file)}, lockTimeoutMs: 20000 })`,
        `  for (let j = 0; j < ${PER}; j++) {`,
        `    b.write('p${i}-' + j, { blob: 'enc:x', meta: { scheme: 'dpapi', purpose: 'model-credential' } })`,
        `  }`,
        `  process.exit(0)`,
        `}).catch(() => process.exit(3))`,
      ].join('\n')
      // `stdio: 'ignore'`：不靠管道收子进程输出（受限模式下命名管道不可用）。
      kids.push(new Promise((res) => {
        const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
        child.on('close', (code) => res(code))
      }))
    }
    const codes = await Promise.all(kids)

    assert.deepEqual(codes, new Array(PROCS).fill(0),
      '并发写入不得有任何进程失败——EPERM 被当成致命错时这里会出现 3')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(Object.keys(data.records ?? {}).length, PROCS * PER,
      '并发 read-modify-write 丢了更新（这正是加锁要关掉的那件事）')
    assert.equal(existsSync(`${file}.lock`), false, '并发结束后不得留下锁文件')
  } finally {
    cleanup()
  }
})
