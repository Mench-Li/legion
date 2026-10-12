// ============================================================================
// team-hub/materialization-reading.test.mjs
//
// 「打开写入会改 DSH 的什么」那一份读数的**存放与校验**。
//
// 这一组守的核心是一句话：**"没收到过"不许读成"没有差异"。**
// （与 `credential-status.mjs` 纪律 ①「读不出来 ≠ 没有」同族。）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateMaterializationReading, createMaterializationReadingStore } from './materialization-reading.mjs'

const READY = {
  at: '2026-10-12T08:20:02.376Z',
  legionReadOk: true,
  actualReadOk: true,
  plan: {
    ok: true, clean: false,
    counts: { create: 0, update: 3, delete: 0, unchanged: 1 },
    create: [], update: [{ id: 'svea-ds', fields: ['api'] }], delete: [], unchanged: ['fjd-ds'],
    engineInternal: ['deepseek-official', 'deepseek-account'],
    credentialsNeeded: [],
  },
  line: '供应商影子对账：新增 0 / 修改 3 / 删除 0 / 未变 1（clean=false）',
  gate: { applyModelConfig: false, applyModelConfigDeletes: false },
}

test('① 形状合法的读数**原样存住**，并把"改了哪几个字段"一起留下', () => {
  const v = validateMaterializationReading(READY)
  assert.equal(v.plan.counts.update, 3)
  assert.deepEqual(v.plan.update[0], { id: 'svea-ds', fields: ['api'] })
  assert.deepEqual(v.plan.engineInternal, ['deepseek-official', 'deepseek-account'])
  assert.equal(v.gate.applyModelConfig, false)
})

test('② ★★★ 从没收到过 ⇒ `reading: null`，**绝不是** clean:true', () => {
  const store = createMaterializationReadingStore()
  const r = store.get({})
  assert.equal(r.reading, null)
  assert.equal(r.ageMs, null)
  // 关键区分：一个"我不知道"与一个"我知道且没有差异"，在面板上是两句不同的话。
  assert.notEqual(r.reading?.plan?.clean, true)
})

test('③ ★★ 新鲜度要能看出来：`ageMs` 与 `stale` 一起给', () => {
  let now = 1_000_000
  const store = createMaterializationReadingStore({ now: () => now })
  store.record(READY)
  assert.equal(store.get({ staleAfterMs: 1000 }).stale, false)
  now += 5000
  const later = store.get({ staleAfterMs: 1000 })
  assert.equal(later.stale, true, '一份 5 秒前的读数在"超过 1 秒就算过期"的口径下必须报过期')
  assert.equal(later.ageMs, 5000)
})

test('④ ★ 只有一份：后一次上报**覆盖**前一次（它是每轮刷新的观测，不是历史）', () => {
  const store = createMaterializationReadingStore()
  store.record(READY)
  store.record({ ...READY, at: '2026-10-12T09:00:00.000Z', plan: { ...READY.plan, clean: true, counts: { create: 0, update: 0, delete: 0, unchanged: 4 } } })
  const r = store.get({})
  assert.equal(r.reading.at, '2026-10-12T09:00:00.000Z')
  assert.equal(r.reading.plan.clean, true)
})

test('⑤ ★★★ 坏形状**必须具名拒绝**，不许静默存下一个"看起来没有差异"的读数', () => {
  const bads = [
    [null, /必须是一个对象/],
    [{}, /缺少 at/],
    [{ at: 'x', plan: { counts: {}, clean: true, update: [] } }, /counts\.create/],
    [{ at: 'x', plan: { counts: { create: 0, update: 0, delete: 0, unchanged: 0 }, update: [] } }, /缺少 clean/],
    [{ at: 'x', plan: { counts: { create: 0, update: 0, delete: 0, unchanged: 0 }, clean: true } }, /update 必须是数组/],
    [{ at: 'x', plan: { counts: { create: 0, update: 0, delete: 0, unchanged: 0 }, clean: true, update: [{ id: 'a' }] } }, /fields/],
  ]
  for (const [input, re] of bads) {
    assert.throws(() => validateMaterializationReading(input), re, `没拒绝：${JSON.stringify(input)}`)
  }
})

test('⑥ ★ 读不出来的那份读数**照样存住**（`actualReadOk:false` 本身就是要让面板看见的读数）', () => {
  const v = validateMaterializationReading({ ...READY, actualReadOk: false, plan: null })
  assert.equal(v.actualReadOk, false)
  assert.equal(v.plan, null)
  const store = createMaterializationReadingStore()
  store.record(v)
  const r = store.get({})
  assert.equal(r.reading.actualReadOk, false)
  assert.equal(r.reading.plan, null)
  // 面板据此要说"这次没读到 DSH"，而不是"没有差异"。
})

test('⑦ ★ `gate` 缺席 ⇒ `null`（**不猜**现在门开着还是关着）', () => {
  assert.equal(validateMaterializationReading({ at: 'x', plan: null }).gate, null)
  assert.equal(validateMaterializationReading({ at: 'x', plan: null, gate: {} }).gate.applyModelConfig, false)
})
