// team-hub/model-store.test.mjs
// ============================================================================
// ModelProfile 数据模型与 API 的存储层（PRT-501）的用例
//
// 这一组问两件事，而它们的失败形态都很安静：
//   ① **明文密钥会不会进库**。写进去了不会报错——它只是安静地留在库里、
//      备份里、导出里。因此判据不是"我们记得不写"，而是"写不进去"。
//   ② **改动会不会被静默覆盖**。并发保存时两边都显示成功，而其中一方的改动
//      消失了。配置类的 lost update 尤其难查：用户只会觉得"我改的东西自己变回去了"。
//
// 另外验墓碑：删除**不是**物理删除，因为一次 Run 会记着 modelProfileRef。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  MODEL_ERRORS,
  ModelError,
  assertAuditClean,
  createModelStore,
  ensureModelSchema,
} from './model-store.mjs'

let tick = 1_700_000_000_000
const clock = () => (tick += 1000)

/** 一个可用的档案基线。 */
function profile(over = {}) {
  return {
    id: 'p-local',
    displayName: '本地模型',
    runtimeType: 'dsh',
    provider: 'deepseek',
    model: 'deepseek-chat',
    endpoint: null,
    secretRef: null,
    reasoningEffort: 'medium',
    limits: { maxTokens: 4096 },
    ...over,
  }
}

function makeStore({ writeAudit = null } = {}) {
  const db = new DatabaseSync(':memory:')
  ensureModelSchema(db)
  const audits = []
  const store = createModelStore({
    db, clock,
    writeAudit: writeAudit ?? ((e) => audits.push(e)),
  })
  return { db, store, audits }
}

test('① 建表幂等：重复 ensureModelSchema 不报错（老库自动补建）', () => {
  const db = new DatabaseSync(':memory:')
  ensureModelSchema(db)
  ensureModelSchema(db)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='model_profiles'").get().n, 1)
})

test('① 新增后能读回，但读出去的东西**不含 secretRef**', () => {
  // 读接口连**引用名**都不给。引用名也是可枚举的攻击面：知道引用名就离
  // 猜到密钥库里的条目更近一步，而它没有必要出现在界面上。
  const { store } = makeStore()
  const created = store.create(profile({ secretRef: 'legion/deepseek/prod' }), { actor: 'u1' })
  assert.equal(created.id, 'p-local')
  assert.equal(created.hasCredential, true)
  assert.equal(created.version, 1)
  assert.ok(!('secretRef' in created), `对外读取不得含 secretRef：${JSON.stringify(created)}`)
  assert.ok(!JSON.stringify(created).includes('legion/deepseek'), '引用名不得出现在对外结果里')

  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.ok(!JSON.stringify(listed).includes('legion/deepseek'), '列表也不得泄露引用名')

  // 仓储内部仍然拿得到（连通性测试要用它）
  assert.equal(store.internalGet('p-local').secretRef, 'legion/deepseek/prod')
})

test('① **明文密钥写不进库**：与 PRT-102 同一份校验', () => {
  const { store, db } = makeStore()
  // 常见密钥形态与"键名像密钥"两条路都试
  const bad = [
    { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' },
    { secret: 'whatever' },
    { token: 'x' },
    { endpoint: 'https://user:pass@api.example.com' },
    { id: 'p', displayName: 'x', runtimeType: 'dsh', provider: 'openai', model: 'gpt', password: 'p' },
  ]
  for (const over of bad) {
    assert.throws(() => store.create(profile(over), { actor: 'u1' }),
      (e) => e instanceof ModelError && e.code === MODEL_ERRORS.INVALID_PROFILE,
      `${JSON.stringify(over)} 必须被拒绝`)
  }
  // 值走私：把密钥写在 model 或 id 里
  assert.throws(() => store.create(profile({ model: 'sk-abcdefghijklmnopqrstuvwxyz' }), { actor: 'u1' }),
    (e) => e.code === MODEL_ERRORS.INVALID_PROFILE)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_profiles').get().n, 0, '被拒绝时不得留下任何行')
})

test('① 未知字段被拒绝（不是忽略）：忽略会让密钥字段静默进库', () => {
  const { store } = makeStore()
  assert.throws(() => store.create(profile({ note: 'x' }), { actor: 'u1' }),
    (e) => e.code === MODEL_ERRORS.INVALID_PROFILE && /未知字段/.test(e.message))
})

test('② 新增同名 id 被拒绝，并指向 update', () => {
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  assert.throws(() => store.create(profile({ displayName: '另一个' }), { actor: 'u1' }),
    (e) => e.code === MODEL_ERRORS.PROFILE_EXISTS && /update/.test(e.message))
})

test('② 缺 actor 一律拒绝：谁改的模型配置必须留痕', () => {
  const { store } = makeStore()
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => store.create(profile(), { actor: bad }),
      (e) => e.code === MODEL_ERRORS.ACTOR_REQUIRED, `actor=${JSON.stringify(bad)} 必须被拒绝`)
  }
  store.create(profile(), { actor: 'u1' })
  for (const bad of [undefined, null, '']) {
    assert.throws(() => store.update('p-local', profile(), { actor: bad, version: 1 }),
      (e) => e.code === MODEL_ERRORS.ACTOR_REQUIRED)
    assert.throws(() => store.remove('p-local', { actor: bad, version: 1 }),
      (e) => e.code === MODEL_ERRORS.ACTOR_REQUIRED)
  }
})

test('② 更新必须给 version：不给就拒绝，**不默认最后一版**', () => {
  // 默认成最后一版时，两个界面同时保存会静默覆盖，而两边都显示成功。
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  for (const bad of [undefined, null, '1', 1.5]) {
    assert.throws(() => store.update('p-local', profile(), { actor: 'u1', version: bad }),
      (e) => e.code === MODEL_ERRORS.VERSION_REQUIRED, `version=${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('② CAS 真的挡住并发覆盖：过期 version 被拒，且带上当前版本', () => {
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })

  // 甲读到 version 1 并保存成功 → 版本变成 2
  const a = store.update('p-local', profile({ displayName: '甲改的' }), { actor: 'u1', version: 1 })
  assert.equal(a.version, 2)
  assert.equal(a.displayName, '甲改的')

  // 乙也基于 version 1 保存 → 必须被拒，且**告诉它当前是 2**（否则乙只能反复盲试）
  assert.throws(
    () => store.update('p-local', profile({ displayName: '乙改的' }), { actor: 'u2', version: 1 }),
    (e) => e instanceof ModelError && e.code === MODEL_ERRORS.VERSION_CONFLICT && e.currentVersion === 2)
  // 甲的改动必须还在（没有被静默覆盖）
  assert.equal(store.get('p-local').displayName, '甲改的')
})

test('② 每次成功更新都推进 version；读回的值就是刚写进去的', () => {
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  let v = 1
  for (const name of ['A', 'B', 'C']) {
    const r = store.update('p-local', profile({ displayName: name }), { actor: 'u1', version: v })
    v += 1
    assert.equal(r.version, v)
    assert.equal(r.displayName, name)
  }
  assert.equal(store.get('p-local').version, 4)
})

test('② 更新不能改 id（那是"建一个新的"）', () => {
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  // 传一个不同的 id：仓储用 URL 上的 id 覆盖它，因此结果仍然作用于 p-local
  const r = store.update('p-local', profile({ id: 'p-other', displayName: 'x' }), { actor: 'u1', version: 1 })
  assert.equal(r.id, 'p-local')
  assert.equal(store.get('p-other'), null, '不得凭空建出另一个档案')
})

test('③ 删除是墓碑：对外读不到，但**历史仍能解析**', () => {
  // 硬删除会让一次 Run 记下的 modelProfileRef 指向查不到的东西——
  // "当时用的哪个模型"就永远答不上来了。
  const { store, db } = makeStore()
  store.create(profile({ secretRef: 'ref-1' }), { actor: 'u1' })
  const del = store.remove('p-local', { actor: 'u1', version: 1 })
  assert.equal(del.deleted, true)
  assert.equal(del.version, 2)

  assert.equal(store.get('p-local'), null, '对外不应再看到它')
  assert.deepEqual(store.list(), [], '列表里不应再有它')
  // 但行还在
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_profiles').get().n, 1, '墓碑不是物理删除')
  const hist = store.resolveForHistory('p-local')
  assert.equal(hist.model, 'deepseek-chat')
  assert.equal(hist.deleted, true)
  assert.equal(hist.hasCredential, true)
  assert.ok(!('secretRef' in hist), '历史解析同样不泄露引用名')
})

test('③ 删除后**不能重用同名 id**：否则历史里那个引用会指向另一个模型', () => {
  const { store } = makeStore()
  store.create(profile({ model: 'old-model' }), { actor: 'u1' })
  store.remove('p-local', { actor: 'u1', version: 1 })
  assert.throws(() => store.create(profile({ model: 'attacker-model' }), { actor: 'u1' }),
    (e) => e.code === MODEL_ERRORS.PROFILE_DELETED && /另一个模型/.test(e.message))
})

test('③ 墓碑上的读/改/删报的是「已删除」而不是「不存在」', () => {
  // 混成 404 会让"删掉再用同名建"看起来像一次干净的首次创建。
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  store.remove('p-local', { actor: 'u1', version: 1 })
  assert.throws(() => store.update('p-local', profile(), { actor: 'u1', version: 2 }),
    (e) => e.code === MODEL_ERRORS.PROFILE_DELETED)
  assert.throws(() => store.remove('p-local', { actor: 'u1', version: 2 }),
    (e) => e.code === MODEL_ERRORS.PROFILE_DELETED)
  assert.throws(() => store.update('p-nope', profile(), { actor: 'u1', version: 1 }),
    (e) => e.code === MODEL_ERRORS.PROFILE_NOT_FOUND)
})

test('③ 删除也要 CAS：并发时被拒', () => {
  const { store } = makeStore()
  store.create(profile(), { actor: 'u1' })
  store.update('p-local', profile({ displayName: 'x' }), { actor: 'u1', version: 1 })
  assert.throws(() => store.remove('p-local', { actor: 'u1', version: 1 }),
    (e) => e.code === MODEL_ERRORS.VERSION_CONFLICT && e.currentVersion === 2)
})

test('④ 审计记录里**没有密文**，且写的是非敏感事实', () => {
  const { store, audits } = makeStore()
  store.create(profile({ secretRef: 'ref-1' }), { actor: 'u1' })
  store.update('p-local', profile({ secretRef: 'ref-2', displayName: '新名' }), { actor: 'u2', version: 1 })
  store.remove('p-local', { actor: 'u3', version: 2 })

  assert.deepEqual(audits.map((a) => a.action),
    ['model-profile.create', 'model-profile.update', 'model-profile.delete'])
  const text = JSON.stringify(audits)
  assert.ok(!text.includes('ref-1'), '不得记录引用名')
  assert.ok(!text.includes('ref-2'), '不得记录引用名')
  assert.ok(!text.includes('sk-'), '不得记录任何密钥')
  assert.deepEqual(audits.map((a) => a.actor), ['u1', 'u2', 'u3'])
  // 更新要能回答"凭证变了没有"，而不必知道它是什么
  assert.equal(audits[1].detail.credentialChanged, true)
  assert.equal(audits[1].detail.hasCredential, true)
})

test('④ 审计守卫本身会拒：含密钥的载荷**写不进去**（fail closed，不脱敏后照写）', () => {
  // 走公开 API 时这条防线不可达（`validateProfile` 已经先挡住了所有密钥形态）。
  // 因此必须直接调它——一条永远走不到、也从没被验过的防线等于没有防线。
  // 这条守卫兜的是"以后有人给审计 payload 加字段"的那一天。
  for (const leaky of [
    { action: 'model-profile.create', detail: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' } },
    { action: 'model-profile.update', detail: { note: 'AKIAIOSFODNN7EXAMPLE' } },
    { action: 'model-profile.create', detail: { nested: { token: 'x' } } },
  ]) {    assert.throws(() => assertAuditClean(leaky),
      (e) => e instanceof ModelError && e.code === MODEL_ERRORS.AUDIT_WOULD_LEAK && e.statusCode === 500,
      `${JSON.stringify(leaky)} 必须被拒绝`)
  }
  // 干净载荷通过
  assert.doesNotThrow(() => assertAuditClean({
    action: 'model-profile.create',
    detail: { provider: 'deepseek', model: 'deepseek-chat', hasCredential: true, fields: ['id', 'secretRef'] },
  }))
  // **限额字段不是密钥**：`maxTokens` 天然含 "token"，凡是被它误判，
  // 任何带 token 限额的档案都写不进去，而报错会说"检测到疑似明文密钥"。
  assert.doesNotThrow(() => assertAuditClean({
    action: 'model-profile.create', detail: { limits: { maxTokens: 4096, tokenLimit: 8192 } },
  }))
})

test('④ 审计写入器根本没被调用（守卫在**调用它之前**就拦下了）', () => {
  const db = new DatabaseSync(':memory:')
  ensureModelSchema(db)
  let called = 0
  const s = createModelStore({ db, clock, writeAudit: () => { called += 1 } })
  s.create(profile({ provider: 'deepseek' }), { actor: 'u1' })
  s.update('p-local', profile({ provider: 'openai' }), { actor: 'u1', version: 1 })
  s.remove('p-local', { actor: 'u1', version: 2 })
  assert.equal(called, 3, '三次操作各写一条审计')
})

test('⑤ limits 坏掉时不当成空对象（那会让预算判定失去依据）', () => {
  const { store, db } = makeStore()
  store.create(profile(), { actor: 'u1' })
  db.prepare("UPDATE model_profiles SET limits_json = 'not json' WHERE id = ?").run('p-local')
  const p = store.internalGet('p-local')
  assert.deepEqual(p.limits, { __unreadable: true }, '读不出来要如实标记，而不是当成"没有限制"')
})

test('⑥ 可选字段的默认值：没给 endpoint/secretRef 时是 null，reasoningEffort 是 medium', () => {
  const { store } = makeStore()
  const r = store.create({
    id: 'p-min', displayName: '最小', runtimeType: 'dsh', provider: 'ollama', model: 'llama3',
  }, { actor: 'u1' })
  assert.equal(r.endpoint, null)
  assert.equal(r.hasCredential, false)
  assert.equal(r.reasoningEffort, 'medium')
  assert.deepEqual(r.limits, {})
})

test('⑥ 列表按 id 排序，且不含墓碑', () => {
  const { store } = makeStore()
  for (const id of ['p-c', 'p-a', 'p-b']) store.create(profile({ id }), { actor: 'u1' })
  assert.deepEqual(store.list().map((p) => p.id), ['p-a', 'p-b', 'p-c'])
  store.remove('p-b', { actor: 'u1', version: 1 })
  assert.deepEqual(store.list().map((p) => p.id), ['p-a', 'p-c'])
  // 要连墓碑一起看是显式的选择
  assert.equal(store.list({ includeDeleted: true }).length, 3)
})
