// security/secrets/run-credentials.test.mjs
// ============================================================================
// PRT-509 / spec §6.7（`line 428`）：在途 Run 的凭证不因轮换而中途替换。
//
// 本套件分三块，第 ② 块是它存在的理由：
//   ① 两个方向：**在途 Run 不变**，**新 Run 拿新值**；
//   ② ★ 数数：句柄开出来之后，`store.get` 的调用次数**一次都不涨**——
//      "抓了一次"的直接读数，而不是它的推论；
//   ③ fail-closed：解析不出来就不给句柄，且错误里不带值。
//
// 为什么 ② 必须单独数：一个**每次都重读**的实现，在轮换还没发生的那些日子里
// 与"抓了一次"的实现读出**一模一样**的结果。
//
//   > 一个"抓了一次"的实现，与一个"每次都重读、只是恰好还没轮换"的实现，
//   > 在那次轮换到来之前是同一个东西——只不过前者的用例是绿的，
//   > 而后者的绿是"这一跑里没人轮换过"换来的。
//
// 所以 ① 那条"轮换后仍是旧值"的用例，**单独并不足以**证明机制存在：
// 它也可能因为"这次轮换没写进去"而通过。② 把机制本身钉住。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RUN_CREDENTIAL_CODES,
  RUN_CREDENTIALS_VERSION,
  RunCredentialError,
  openRunCredentials,
} from './run-credentials.mjs'
import { createSecretStore, memoryBackend, nullProtector } from './store.mjs'

const SECRET = 'sk-run-0000000000000000000000000000'
const REF = 'legion/openai'
const REF2 = 'legion/anthropic'

/** 一个**会数数**的 store 包装：这是"有没有再读"的唯一直接读数。 */
function countingStore(inner) {
  const calls = []
  return {
    calls,
    get(ref) { calls.push(ref); return inner.get(ref) },
    store: inner,
  }
}

async function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-runc-'))
  const store = createSecretStore({
    backend: memoryBackend(),
    protector: nullProtector(),
    protectedRequired: false,
    now: () => '2026-09-11T00:00:00.000Z',
  })
  await store.put(REF, SECRET, { purpose: 'model' })
  await store.put(REF2, `${SECRET}-b`, { purpose: 'model' })
  return { dir, store }
}

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ } }

// ═══════════════════════════════════════════════ ① 两个方向

test('① ★★★ 在途 Run 拿到的是**启动时**那一份：中途轮换不改变它', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    const before = run.get(REF)
    assert.equal(before, SECRET)

    // 轮换（引用名不变、值替换）。
    await store.rotate(REF, `${SECRET}-rotated`)
    assert.equal((await store.get(REF)).value, `${SECRET}-rotated`, 'store 本身确实换掉了')

    // ★ 在途 Run 读到的还是旧的那一份。
    assert.equal(run.get(REF), before,
      '在途 Run 的凭证被中途替换了 —— spec §6.7「不在中途替换」不成立')
    assert.equal(run.get(REF), SECRET)
  } finally { cleanup(dir) }
})

test('① ★★★ 轮换**之后**创建的 Run 拿到新值（另一半，不能只钉一半）', async () => {
  const { dir, store } = await freshStore()
  try {
    const inFlight = await openRunCredentials({ store, refs: [REF], runId: 'run-old' })
    await store.rotate(REF, `${SECRET}-rotated`)
    const after = await openRunCredentials({ store, refs: [REF], runId: 'run-new' })

    assert.equal(inFlight.get(REF), SECRET, '在途 Run 应该拿旧值')
    assert.equal(after.get(REF), `${SECRET}-rotated`, '轮换后的新 Run 应该拿新值')
    // 两个句柄同时存在、各拿各的：这是"只影响轮换之后创建的 Run"的完整形状。
    assert.notEqual(inFlight.get(REF), after.get(REF))
  } finally { cleanup(dir) }
})

test('① ★★ 轮换期间**删除**引用，也不影响在途 Run（删除比轮换更彻底）', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    await store.remove(REF)
    await assert.rejects(() => store.get(REF), (e) => e.code === 'SECRET_NOT_FOUND',
      '前提：store 里确实没有了')
    assert.equal(run.get(REF), SECRET, '库里的删掉了，在途 Run 手里那一份不该跟着消失')
  } finally { cleanup(dir) }
})

// ═══════════════════════════════════════════════ ② ★ 数数：不再读

test('② ★★★ 句柄开出来之后，`store.get` 的调用次数**一次都不涨**', async () => {
  const { dir, store } = await freshStore()
  try {
    const counted = countingStore(store)
    const run = await openRunCredentials({ store: counted, refs: [REF, REF2], runId: 'run-1' })
    const opened = counted.calls.length
    assert.equal(opened, 2, `open 应该正好解析 2 次，实际 ${opened}`)

    for (let i = 0; i < 50; i++) {
      run.get(REF)
      run.get(REF2)
      run.held(REF)
      run.describe()
    }
    assert.equal(counted.calls.length, opened,
      `句柄又去读了 store ${counted.calls.length - opened} 次 —— 那就不是"抓了一次"，` +
      '只是"这一跑里恰好还没轮换过"')
  } finally { cleanup(dir) }
})

test('② ★★★ 同一个引用写两遍只解析一次（两遍会拿到两个 `resolvedAt`）', async () => {
  const { dir, store } = await freshStore()
  try {
    const counted = countingStore(store)
    const run = await openRunCredentials({ store: counted, refs: [REF, REF, REF2], runId: 'run-1' })
    assert.deepEqual(counted.calls, [REF, REF2], '重复引用被解析了两次')
    assert.deepEqual([...run.refs], [REF, REF2])
  } finally { cleanup(dir) }
})

test('② ★★ 句柄是冻结的：改不动、也换不掉手里的值', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    assert.equal(Object.isFrozen(run), true)
    assert.throws(() => { run.get = () => 'attacker' }, TypeError)
    assert.equal(run.get(REF), SECRET, '替换 get 的尝试不该成功')
    assert.throws(() => { run.runId = 'other' }, TypeError)
  } finally { cleanup(dir) }
})

// ═══════════════════════════════════════════════ ③ fail-closed

test('③ ★★★ 任一引用解析不出来 → **不给句柄**（不是"少一份也能跑"）', async () => {
  const { dir, store } = await freshStore()
  try {
    const counted = countingStore(store)
    await assert.rejects(
      () => openRunCredentials({ store: counted, refs: [REF, 'legion/missing'], runId: 'run-1' }),
      (e) => {
        assert.equal(e.code, RUN_CREDENTIAL_CODES.RESOLVE_FAILED)
        assert.equal(e.ref, 'legion/missing')
        assert.equal(e.cause, 'SECRET_NOT_FOUND', '要带出密钥库自己的具名码')
        return true
      },
    )
    // ★ 没有任何句柄流出去（这是个 `await`，拿不到返回值就没法误用）。
    //   而且失败**发生在解析途中**：已经成功的那一份不该被"留下来"。
    assert.equal(counted.calls.length, 2, '两次都试过了才失败（顺序解析，遇错即停）')
  } finally { cleanup(dir) }
})

test('③ ★★ 解析失败的错误里**不带值**（错误对象也是会被打日志的地方）', async () => {
  const { dir, store } = await freshStore()
  try {
    let caught = null
    try {
      await openRunCredentials({ store, refs: ['legion/missing'], runId: 'run-1' })
    } catch (e) { caught = e }
    const dumped = JSON.stringify(caught) + String(caught?.message) + String(caught?.stack)
    assert.equal(dumped.includes(SECRET), false, '错误对象里出现了密钥值')
    assert.equal(dumped.includes('sk-'), false)
  } finally { cleanup(dir) }
})

test('③ ★★ 向句柄要一个**不属于本次运行**的引用 → 具名拒绝（不是 undefined）', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    assert.equal(run.held(REF2), false)
    assert.throws(() => run.get(REF2), (e) => {
      assert.equal(e.code, RUN_CREDENTIAL_CODES.REF_NOT_HELD)
      assert.equal(e.ref, REF2)
      // `undefined` 会被下游当成"没配置"，而真因是"问错了对象"。
      assert.ok(Array.isArray(e.heldRefs), '要能看出这个句柄到底持有什么')
      return true
    })
  } finally { cleanup(dir) }
})

test('③ ★★ 空引用清单 / 空 runId / 没有 store 都是**具名拒绝**，不猜', async () => {
  const { dir, store } = await freshStore()
  try {
    const cases = [
      [{ store, refs: [], runId: 'r' }, RUN_CREDENTIAL_CODES.REFS_REQUIRED],
      [{ store, refs: null, runId: 'r' }, RUN_CREDENTIAL_CODES.REFS_REQUIRED],
      [{ store, refs: [REF], runId: '' }, RUN_CREDENTIAL_CODES.RUN_ID_REQUIRED],
      [{ store, refs: [REF] }, RUN_CREDENTIAL_CODES.RUN_ID_REQUIRED],
      [{ refs: [REF], runId: 'r' }, RUN_CREDENTIAL_CODES.REFS_REQUIRED],
      [{ store, refs: [REF, ''], runId: 'r' }, RUN_CREDENTIAL_CODES.REFS_REQUIRED],
    ]
    for (const [input, code] of cases) {
      await assert.rejects(() => openRunCredentials(input), (e) => e.code === code,
        `${JSON.stringify(input?.refs)} / runId=${JSON.stringify(input?.runId)} 应该报 ${code}`)
    }
  } finally { cleanup(dir) }
})

// ═══════════════════════════════════════════════ ④ 不会顺手泄漏

test('④ ★★★ 把句柄记进日志**不会**泄漏值（`toJSON` / `describe` 只有名字）', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    // ★ 三条都**序列化**（第一版这里写的是 `String(run.toJSON())`，
    //   而 `String(对象)` 给的是 `[object Object]` —— 那条断言对着一个
    //   不含引用名的字符串检查 `includes('legion/openai')`，红得毫无信息量。
    //   *一个把被测对象先变成 `[object Object]` 的夹具，
    //   与一个"什么都没测"的断言，在断言信息上是同一个东西。*)
    const texts = [JSON.stringify(run), JSON.stringify(run.describe()), JSON.stringify(run.toJSON())]
    for (const text of texts) {
      assert.equal(text.includes(SECRET), false, '序列化把值带出去了')
      assert.equal(text.includes('sk-'), false)
      assert.match(text, /legion\/openai/, '但要能看出它持有哪个引用')
      assert.match(text, /run-1/)
    }
  } finally { cleanup(dir) }
})

test('④ ★ `describe()` 与 `toJSON()` 同形，且版本/时间可对照', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({
      store, refs: [REF], runId: 'run-1', now: () => '2026-09-11T12:00:00.000Z',
    })
    const d = run.describe()
    assert.deepEqual(run.toJSON(), d)
    assert.equal(d.version, RUN_CREDENTIALS_VERSION)
    assert.equal(d.runId, 'run-1')
    assert.equal(d.resolvedAt, '2026-09-11T12:00:00.000Z')
    assert.equal(d.count, 1)
    assert.equal(Object.isFrozen(d), true)
  } finally { cleanup(dir) }
})

test('④ ★ 错误类型是具名的（调用方按码分支，不按文案匹配）', async () => {
  const { dir, store } = await freshStore()
  try {
    const run = await openRunCredentials({ store, refs: [REF], runId: 'run-1' })
    try {
      run.get('legion/nope')
    } catch (e) {
      assert.equal(e instanceof RunCredentialError, true)
      assert.equal(e instanceof Error, true)
      assert.equal(e.name, 'RunCredentialError')
    }
  } finally { cleanup(dir) }
})
