// team-hub/binding-store.test.mjs
// ============================================================================
// 岗位模型绑定仓储（PRT-502）的用例
//
// 纯解析逻辑已在 `orchestrator/model-binding/model-binding.test.mjs` 验过。
// 这一组问的是**仓储特有的三件事**：
//
//   ① **坏掉的持久化数据不许被当成"没有"**。`fallback_profiles_json` 读不回来时，
//      当成"没有备用"会让容错余量静默归零——配置上写着三位，实际只有一位，
//      而这个差别只在主档案真的连不上时才显形。
//   ② **写入时要挡住跑不起来的绑定**。等到运行时才发现 `primaryProfile`
//      打错了，那次运行已经认领了任务、烧掉一次尝试，而错误出现在运行日志里，
//      不是在"保存配置"这个动作上——后者才是真正能改的地方。
//   ③ **改档案要立刻影响解析**（不缓存），以及**改绑定不影响别的岗位**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  BINDING_STORE_ERRORS,
  BindingStoreError,
  createBindingStore,
  ensureBindingSchema,
} from './binding-store.mjs'

let tick = 1_700_000_000_000
const clock = () => (tick += 1000)

function profile(id, over = {}) {
  return {
    id, displayName: `档案 ${id}`, runtimeType: 'dsh', provider: 'deepseek',
    model: `model-${id}`, reasoningEffort: 'medium', limits: {}, hasCredential: true, ...over,
  }
}
const tombstone = (id) => profile(id, { deleted: true, deletedAtMs: 1 })

/** 档案表由一个可变数组驱动，测试可以随时改它——用来验"不缓存"。 */
function makeEnv(initialProfiles = [profile('p-main'), profile('p-b')]) {
  let profiles = initialProfiles
  const db = new DatabaseSync(':memory:')
  ensureBindingSchema(db)
  const audits = []
  const store = createBindingStore({
    db, clock,
    readProfiles: () => profiles,
    writeAudit: (e) => audits.push(e),
  })
  return {
    db, store, audits,
    setProfiles: (next) => { profiles = next },
  }
}

const b = (over = {}) => ({
  scope: 'default', employeeRole: 'coder', primaryProfile: 'p-main',
  fallbackProfiles: ['p-b'], perRunBudget: null, ...over,
})

test('① 建表幂等', () => {
  const db = new DatabaseSync(':memory:')
  ensureBindingSchema(db)
  ensureBindingSchema(db)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='employee_model_bindings'").get().n, 1)
})

test('① 写入后读回；解析按主档案在前、备用在后', () => {
  const { store } = makeEnv([profile('p-main'), profile('p-b'), profile('p-c')])
  const saved = store.upsert(b({ fallbackProfiles: ['p-b', 'p-c'] }), { actor: 'u1' })
  assert.equal(saved.primaryProfile, 'p-main')
  assert.deepEqual(saved.fallbackProfiles, ['p-b', 'p-c'])

  const r = store.resolve('default', 'coder')
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b', 'p-c'])
  assert.equal(r.scope, 'default')

  assert.equal(store.get('default', 'coder').employeeRole, 'coder')
  assert.equal(store.list().length, 1)
  assert.equal(store.list('other').length, 0)
})

test('① **绑定不存在 ≠ 空链**：解析给出具名码，由调用方决定默认', () => {
  // 空链会被下游读成"没有可用的模型"，而真实情况是"没有绑定"——
  // 前者要人去建档案，后者要人去建绑定。
  const { store } = makeEnv()
  const r = store.resolve('default', 'nobody')
  assert.equal(r.ok, false)
  assert.equal(r.code, BINDING_STORE_ERRORS.BINDING_NOT_FOUND)
  assert.match(r.message, /由调用方决定/)
  assert.deepEqual(r.chain, [])
})

test('① 写入时主档案解析不出来 → 409 拒绝，**不把跑不起来的绑定存进库**', () => {
  const { store, db } = makeEnv()
  assert.throws(() => store.upsert(b({ primaryProfile: 'p-nope' }), { actor: 'u1' }),
    (e) => e instanceof BindingStoreError && e.code === BINDING_STORE_ERRORS.PRIMARY_UNRESOLVED && e.statusCode === 409)
  // 主档案被下线也是拒绝
  const { store: s2 } = makeEnv([tombstone('p-main')])
  assert.throws(() => s2.upsert(b(), { actor: 'u1' }),
    (e) => e.code === BINDING_STORE_ERRORS.PRIMARY_UNRESOLVED)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_model_bindings').get().n, 0, '被拒绝时不得落行')
})

test('① 写入时**备用**档案不可用不算错，但要记进审计', () => {
  const { store, audits } = makeEnv([profile('p-main'), profile('p-b'), tombstone('p-gone')])
  const saved = store.upsert(b({ fallbackProfiles: ['p-b', 'p-gone'] }), { actor: 'u1' })
  assert.deepEqual(saved.fallbackProfiles, ['p-b', 'p-gone'], '配置原样存下来（档案以后可能恢复）')
  const r = store.resolve('default', 'coder')
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main', 'p-b'])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].code, 'PROFILE_DELETED')
  // 审计里要留下"有一个备用当时是不可用的"：真实的容错余量比配置少一位
  assert.equal(audits[0].detail.skippedFallbacks.length, 1)
  assert.equal(audits[0].detail.skippedFallbacks[0].code, 'PROFILE_DELETED')
})

test('② 坏掉的 fallback JSON **不许**当成"没有备用"', () => {
  // 配置上写着三位备用，实际只有一位——而这个差别只在主档案真的连不上时才显形。
  const { store, db } = makeEnv()
  store.upsert(b(), { actor: 'u1' })
  db.prepare("UPDATE employee_model_bindings SET fallback_profiles_json = 'not json' WHERE employee_role = 'coder'").run()
  const r = store.resolve('default', 'coder')
  assert.equal(r.ok, false, '损坏的数据不得判成可用')
  assert.match(r.message, /读不出来/)
  assert.match(r.message, /容错余量静默归零/)
  assert.deepEqual(r.chain, [])
})

test('② 坏掉的 perRunBudget JSON 同样报出来（不静默变成"没有上限"）', () => {
  const { store, db } = makeEnv()
  store.upsert(b({ perRunBudget: { maxTokens: 100 } }), { actor: 'u1' })
  db.prepare("UPDATE employee_model_bindings SET per_run_budget_json = '{{' WHERE employee_role = 'coder'").run()
  const r = store.resolve('default', 'coder')
  assert.equal(r.ok, false)
  assert.match(r.message, /perRunBudget/)
})

test('② 预算形态不合法 → 400 拒绝（未到 PRT-503 先挡住"看起来配了"）', () => {
  const { store } = makeEnv()
  for (const bad of [{ maxCost: 5 }, { maxCst: 1 }, { maxTokens: -1 }]) {
    assert.throws(() => store.upsert(b({ perRunBudget: bad }), { actor: 'u1' }),
      (e) => e instanceof BindingStoreError && e.code === 'BUDGET_INVALID', `${JSON.stringify(bad)} 应被拒绝`)
  }
  // 合法的存下来并在解析里带出
  store.upsert(b({ perRunBudget: { maxCost: 1.5, currency: 'USD' } }), { actor: 'u1' })
  assert.deepEqual(store.resolve('default', 'coder').perRunBudget, { maxCost: 1.5, currency: 'USD' })
})

test('② 缺 actor / 缺 scope / 缺 role 一律拒绝', () => {
  const { store } = makeEnv()
  assert.throws(() => store.upsert(b(), {}), (e) => e.code === BINDING_STORE_ERRORS.ACTOR_REQUIRED)
  assert.throws(() => store.upsert(b({ scope: '' }), { actor: 'u1' }), (e) => e.code === BINDING_STORE_ERRORS.SCOPE_REQUIRED)
  assert.throws(() => store.upsert(b({ employeeRole: '  ' }), { actor: 'u1' }), (e) => e.code === BINDING_STORE_ERRORS.ROLE_REQUIRED)
  assert.throws(() => store.remove('default', 'coder', {}), (e) => e.code === BINDING_STORE_ERRORS.ACTOR_REQUIRED)
})

test('③ 解析**不缓存**：档案一改，下一次解析立刻反映', () => {
  // 缓存会让"档案下线了但解析还返回它"持续存在，而这段时长取决于缓存策略——
  // 一个"改了配置但不生效、过一会儿又生效"的现象。
  const { store, setProfiles } = makeEnv([profile('p-main'), profile('p-b')])
  store.upsert(b({ fallbackProfiles: ['p-b'] }), { actor: 'u1' })
  assert.deepEqual(store.resolve('default', 'coder').chain.map((c) => c.id), ['p-main', 'p-b'])

  setProfiles([profile('p-main'), tombstone('p-b')])
  const r = store.resolve('default', 'coder')
  assert.deepEqual(r.chain.map((c) => c.id), ['p-main'], '下线的备用必须立刻从链里消失')
  assert.equal(r.skipped[0].code, 'PROFILE_DELETED')

  setProfiles([tombstone('p-main'), profile('p-b')])
  assert.equal(store.resolve('default', 'coder').ok, false, '主档案下线后绑定立刻不可用')
})

test('③ 同一个 scope 下不同岗位各绑各的（互不影响）', () => {
  const { store } = makeEnv([profile('p-main'), profile('p-b'), profile('p-review')])
  store.upsert(b({ employeeRole: 'coder', primaryProfile: 'p-main' }), { actor: 'u1' })
  store.upsert(b({ employeeRole: 'reviewer', primaryProfile: 'p-review', fallbackProfiles: [] }), { actor: 'u1' })
  assert.deepEqual(store.resolve('default', 'coder').chain.map((c) => c.id), ['p-main', 'p-b'])
  assert.deepEqual(store.resolve('default', 'reviewer').chain.map((c) => c.id), ['p-review'])
  assert.equal(store.list('default').length, 2)
})

test('③ 不同 scope 的同一个岗位互不影响', () => {
  const { store } = makeEnv([profile('p-main'), profile('p-b')])
  store.upsert(b({ scope: 'alpha', primaryProfile: 'p-main', fallbackProfiles: [] }), { actor: 'u1' })
  store.upsert(b({ scope: 'beta', primaryProfile: 'p-b', fallbackProfiles: [] }), { actor: 'u1' })
  assert.deepEqual(store.resolve('alpha', 'coder').chain.map((c) => c.id), ['p-main'])
  assert.deepEqual(store.resolve('beta', 'coder').chain.map((c) => c.id), ['p-b'])
})

test('④ 覆盖写入是整体替换（不是合并），审计区分建与改', () => {
  const { store, audits } = makeEnv([profile('p-main'), profile('p-b'), profile('p-c')])
  store.upsert(b({ fallbackProfiles: ['p-b', 'p-c'] }), { actor: 'u1' })
  const after = store.upsert(b({ fallbackProfiles: ['p-c'] }), { actor: 'u2' })
  // 整体替换：p-b 必须从备用里消失。合并语义会让"删掉一个备用"变成不可能。
  assert.deepEqual(after.fallbackProfiles, ['p-c'])
  assert.deepEqual(store.resolve('default', 'coder').chain.map((c) => c.id), ['p-main', 'p-c'])
  assert.deepEqual(audits.map((a) => a.action), ['model-binding.create', 'model-binding.update'])
})

test('④ 删除绑定是物理删除，且审计留痕；删不存在的是 404', () => {
  const { store, db, audits } = makeEnv()
  store.upsert(b(), { actor: 'u1' })
  const del = store.remove('default', 'coder', { actor: 'u2' })
  assert.equal(del.deleted, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_model_bindings').get().n, 0, '绑定是物理删除')
  assert.equal(store.get('default', 'coder'), null)
  assert.equal(audits.at(-1).action, 'model-binding.delete')
  assert.equal(audits.at(-1).actor, 'u2')
  assert.throws(() => store.remove('default', 'coder', { actor: 'u2' }),
    (e) => e instanceof BindingStoreError && e.code === BINDING_STORE_ERRORS.BINDING_NOT_FOUND && e.statusCode === 404)
})

test('④ 审计里没有密钥：只有档案 id / 数量 / 跳过原因', () => {
  const { store, audits } = makeEnv()
  store.upsert(b({ perRunBudget: { maxCost: 3, currency: 'CNY' } }), { actor: 'u1' })
  const text = JSON.stringify(audits)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(text), `审计泄露密钥：${text}`)
  assert.ok(!text.includes('secretRef'), '审计不得含 secretRef 字段名')
  assert.equal(audits[0].detail.hasBudget, true)
})

test('⑤ 写入后复读一致性：存进去的 primary 必须与解析出的一致', () => {
  // 复读不一致时报 500 而不是当作成功——"保存成功"是假的比保存失败更坏。
  const { store } = makeEnv([profile('p-main'), profile('p-b')])
  const saved = store.upsert(b(), { actor: 'u1' })
  assert.equal(saved.primaryProfile, store.resolve('default', 'coder').chain[0].id)
})
