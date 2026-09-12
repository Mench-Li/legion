// orchestrator/model-binding/model-binding.test.mjs
// ============================================================================
// 岗位模型绑定与 fallback 的解析逻辑（PRT-502）的用例
//
// 这一组问的核心是一句话：「这条任务用的是哪个模型，为什么是它？」
//
// 它的失败形态**全部是安静的**：链排错了不会报错，任务照样跑完、照样出结果。
// 只是成本、质量、以及数据去了哪，三件事同时错了而没人知道。
//
// 因此用例的重点不在"正常情况能排出链"，而在四种**必须拒绝或必须报告**的情形：
//   ① 主档案不可用 → 不许 fallback 悄悄顶替；
//   ② 备用档案不可用 → 跳过，但必须报出来（真实余量比看起来少一位）；
//   ③ 同一个档案出现两次 → 去重并报告（否则"重试"是对同一个模型重试）；
//   ④ 坏掉的预算 → 拒绝（否则 PRT-503 落地后会变成"没有上限"）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BINDING_ERRORS,
  BindingError,
  SKIP_REASONS,
  chainSnapshot,
  resolveModelChain,
  validatePerRunBudget,
} from './index.mjs'

/** 一个可用的档案描述（**不含** secretRef 的值，与 toModelDescriptor 的输出同形）。 */
function profile(id, over = {}) {
  return {
    id,
    displayName: `档案 ${id}`,
    runtimeType: 'dsh',
    provider: 'deepseek',
    model: `model-${id}`,
    reasoningEffort: 'medium',
    limits: { maxTokens: 4096 },
    hasCredential: true,
    ...over,
  }
}

const gone = (id) => profile(id, { deleted: true, deletedAtMs: 1_700_000_000_000 })

function binding(over = {}) {
  return { employeeRole: 'coder', primaryProfile: 'p-main', fallbackProfiles: [], perRunBudget: null, ...over }
}

test('① 正常：主档案在前，备用按给出顺序在后', () => {
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-b', 'p-c'] }),
    profiles: [profile('p-main'), profile('p-b'), profile('p-c')],
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b', 'p-c'])
  assert.deepEqual(r.chain.map((c) => c.role), ['primary', 'fallback', 'fallback'])
  assert.deepEqual(r.chain.map((c) => c.order), [0, 1, 2])
  assert.deepEqual(r.skipped, [])
  // 候选里只有非敏感字段：没有 secretRef，只有 hasCredential
  for (const c of r.chain) {
    assert.ok(!('secretRef' in c), `候选不得含 secretRef：${JSON.stringify(c)}`)
    assert.equal(typeof c.hasCredential, 'boolean')
  }
})

test('① 没有备用档案是合法配置（链只有主档案）', () => {
  const r = resolveModelChain({ binding: binding(), profiles: [profile('p-main')] })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main'])
})

test('② **主档案不可用 → 绑定不可用，且理由明说"不自动降级"**', () => {
  // fallback 是为"运行时连不上"准备的，不是为"配置写错了"准备的。
  // 悄悄顶替会让 primaryProfile 一直是错的，而每次运行都在用一个没人选过的模型。
  for (const [profiles, expectCode] of [
    [[profile('p-b')], 'PROFILE_NOT_FOUND'],
    [[gone('p-main'), profile('p-b')], 'PROFILE_DELETED'],
  ]) {
    const r = resolveModelChain({ binding: binding({ fallbackProfiles: ['p-b'] }), profiles })
    assert.equal(r.ok, false, '主档案不可用时不得判成可用')
    assert.equal(r.code, BINDING_ERRORS.PRIMARY_UNRESOLVED)
    assert.match(r.message, /不自动降级到 fallback/)
    // 备用仍然被解析出来（诊断要看得到"本来会用什么"），但它**不能**顶替主档案
    assert.deepEqual(r.chain.map((c) => c.id), ['p-b'])
    assert.equal(r.chain[0].role, 'fallback', '备用不得被改写成 primary')
    // 不可用的原因如实报出，且区分"不存在"与"已下线"
    assert.equal(r.skipped[0].code, expectCode)
    assert.equal(r.skipped[0].role, 'primary')
  }
})

test('② 备用档案不可用 → 跳过并**报出来**：真实余量比配置上少一位', () => {
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-b', 'p-nope', 'p-c'] }),
    profiles: [profile('p-main'), profile('p-b'), gone('p-c')],
  })
  // 主档案可用，因此绑定仍然可用
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b'])
  // 但两个被跳过的备用必须出现在 skipped 里，且原因不同
  assert.equal(r.skipped.length, 2)
  const byId = Object.fromEntries(r.skipped.map((s) => [s.id, s]))
  assert.equal(byId['p-nope'].code, 'PROFILE_NOT_FOUND')
  assert.equal(byId['p-c'].code, 'PROFILE_DELETED')
  // 顺序位保留：运维要知道"第 3 位那个不可用"
  assert.equal(byId['p-c'].order, 3)
})

test('② "不存在"与"已下线"必须分开报（运维动作不同）', () => {
  // 前者去查是不是 id 打错了，后者去找谁把它下线的。
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['missing', 'retired'] }),
    profiles: [profile('p-main'), gone('retired')],
  })
  const codes = r.skipped.map((s) => s.code).sort()
  assert.deepEqual(codes, ['PROFILE_DELETED', 'PROFILE_NOT_FOUND'])
  assert.match(r.skipped.find((s) => s.code === 'PROFILE_DELETED').message, /墓碑仍在/)
})

test('③ 同一个档案出现两次 → 去重并报告', () => {
  // 主档案也在备用列表里：不去重的话"重试"会变成对着同一个模型重试两次——
  // 那不是容错，是把一次瞬时故障变成两次同样的失败。
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-main', 'p-b', 'p-b'] }),
    profiles: [profile('p-main'), profile('p-b')],
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b'], '重复项必须只出现一次')
  assert.equal(r.skipped.filter((s) => s.code === 'PROFILE_DUPLICATE').length, 2)
  assert.match(r.skipped[0].message, /不是容错/)
})

test('③ id 形态不合法（空串 / 非字符串）被跳过而不是崩', () => {
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['', '   ', 42, 'p-b'] }),
    profiles: [profile('p-main'), profile('p-b')],
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b'])
  assert.equal(r.skipped.filter((s) => s.code === 'PROFILE_ID_INVALID').length, 3)
})

test('④ 缺 employeeRole → 不可用（岗位不明时"该用哪个模型"没有主语）', () => {
  for (const bad of [undefined, null, '', '   ']) {
    const r = resolveModelChain({ binding: binding({ employeeRole: bad }), profiles: [profile('p-main')] })
    assert.equal(r.ok, false, `employeeRole=${JSON.stringify(bad)} 必须导致不可用`)
    assert.match(r.message, /employeeRole/)
  }
})

test('④ 缺 primaryProfile → 不可用，且链为空时**永远不能**判成可用', () => {
  const r = resolveModelChain({ binding: binding({ primaryProfile: null }), profiles: [profile('p-main')] })
  assert.equal(r.ok, false)
  assert.equal(r.code, BINDING_ERRORS.PRIMARY_UNRESOLVED)
  assert.deepEqual(r.chain, [])
})

test('④ 预算：形态不对就拒绝（否则 PRT-503 落地后变成"没有上限"）', () => {
  for (const bad of [
    { maxCost: -1 },
    { maxCost: 0 },
    { maxCost: '5' },
    { maxTokens: Number.POSITIVE_INFINITY },
    { maxCst: 5 },                       // 拼错的字段：忽略它等于没有上限
    { maxCost: 5 },                      // 给了金额没给币种：脱离币种不构成上限
    { maxTokens: 100, currency: '' },
    'not-an-object',
    [1],
  ]) {
    const r = resolveModelChain({ binding: binding({ perRunBudget: bad }), profiles: [profile('p-main')] })
    assert.equal(r.ok, false, `perRunBudget=${JSON.stringify(bad)} 必须被拒绝`)
    assert.match(r.message, /perRunBudget|主档案|预算/)
  }
})

test('④ 合法预算被规范化保留（maxCost 与 currency 成对）', () => {
  const r = resolveModelChain({
    binding: binding({ perRunBudget: { maxCost: 2.5, currency: 'USD', maxTokens: 100000 } }),
    profiles: [profile('p-main')],
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.perRunBudget, { maxCost: 2.5, currency: 'USD', maxTokens: 100000 })
  assert.equal(Object.isFrozen(r.perRunBudget), true)
})

test('④ validatePerRunBudget 单独可用，且 null/undefined 表示"没有预算"', () => {
  assert.deepEqual(validatePerRunBudget(null), { ok: true, value: null, errors: [] })
  assert.deepEqual(validatePerRunBudget(undefined), { ok: true, value: null, errors: [] })
  const bad = validatePerRunBudget({ maxCost: 1 })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /currency/)
})

test('⑤ 形状错误用异常，配置问题用返回值：两者不混', () => {
  // binding 不是对象、fallbackProfiles 不是数组、profiles 类型不对 —— 这些是
  // **调用方的代码错**，不是"这个岗位的配置有问题"。混成返回值会让真正的
  // 代码错被当成一条正常的配置诊断埋在日志里。
  assert.throws(() => resolveModelChain({ binding: null, profiles: [] }),
    (e) => e instanceof BindingError && e.code === BINDING_ERRORS.BINDING_NOT_OBJECT)
  assert.throws(() => resolveModelChain({ binding: binding({ fallbackProfiles: 'p-b' }), profiles: [] }),
    (e) => e instanceof BindingError && e.code === BINDING_ERRORS.FALLBACKS_NOT_ARRAY)
  assert.throws(() => resolveModelChain({ binding: binding(), profiles: 'nope' }),
    (e) => e instanceof BindingError && e.code === BINDING_ERRORS.PROFILES_NOT_ARRAY)
  assert.throws(() => chainSnapshot(null),
    (e) => e instanceof BindingError && e.code === BINDING_ERRORS.BINDING_NOT_OBJECT)
})

test('⑤ fallbackProfiles 给 null 表示"没有备用"，给字符串是配置错误', () => {
  const r = resolveModelChain({ binding: binding({ fallbackProfiles: null }), profiles: [profile('p-main')] })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main'])
})

test('⑤ profiles 允许按 id 索引的对象形式', () => {
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-b'] }),
    profiles: { 'p-main': profile('p-main'), 'p-b': profile('p-b') },
  })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b'])
})

test('⑥ 冻结快照只记 id 与顺序：事后能看到"当时打算用哪几个"', () => {
  // 不记 provider/model 的值：那些会随档案改动而变，存下来就是两份互相
  // 矛盾的真相。id + 顺序足以按时间线还原。
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-b', 'p-gone'] }),
    profiles: [profile('p-main'), profile('p-b'), gone('p-gone')],
  })
  const snap = chainSnapshot(r)
  assert.deepEqual(snap.order, [{ id: 'p-main', role: 'primary' }, { id: 'p-b', role: 'fallback' }])
  assert.equal(snap.skipped.length, 1)
  assert.equal(snap.skipped[0].code, 'PROFILE_DELETED')
  assert.equal(snap.employeeRole, 'coder')
  assert.equal(snap.ok, true)
  const text = JSON.stringify(snap)
  assert.ok(!text.includes('model-p-main'), '快照不得含模型名（那会随档案改动而变）')
  assert.ok(!text.includes('deepseek'), '快照不得含 provider')
})

test('⑥ 解析不可用时快照仍然可生成（失败也要留痕）', () => {
  const r = resolveModelChain({ binding: binding({ primaryProfile: 'p-nope' }), profiles: [] })
  const snap = chainSnapshot(r)
  assert.equal(snap.ok, false)
  assert.equal(snap.code, BINDING_ERRORS.PRIMARY_UNRESOLVED)
  assert.deepEqual(snap.order, [])
})

test('⑦ 每一条 skip 的原因码都在登记表里（新增原因必须显式登记）', () => {
  // 原因码是**封闭**的：新增一种必须显式加进 SKIP_REASONS。
  // 不封闭时一个拼错的码会让下游的判断落进 else 分支——
  // 而 else 分支通常是"当作正常继续"。
  const r = resolveModelChain({
    binding: binding({ fallbackProfiles: ['p-main', 'nope', 'gone', '', 7] }),
    profiles: [profile('p-main'), gone('gone')],
  })
  assert.ok(r.skipped.length > 0)
  for (const s of r.skipped) {
    assert.ok(SKIP_REASONS.includes(s.code), `未登记的原因码：${s.code}`)
  }
  assert.deepEqual([...SKIP_REASONS].sort(), [...SKIP_REASONS].sort())
  assert.equal(new Set(SKIP_REASONS).size, SKIP_REASONS.length, '原因码不得重复')
})
