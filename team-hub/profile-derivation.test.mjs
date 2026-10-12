// team-hub/profile-derivation.test.mjs
// ============================================================================
// 从供应商派生档案 —— 将军那句"直接来源于模型与供应商才对啊"的实现判据。
//
// 这一组盯的是**三种会把好事变成坏事**的写法：
//   ① 按 `id` 认身份 ⇒ 会给已存在的三元组**再建三条重复档案**（实测库里 id 与派生规则不一致）；
//   ② 顺手"修正"已存在的档案 ⇒ 会把用户的真实选择（推理档位/限额/偏离地址）改掉；
//   ③ 顺手把供应商里删掉的模型对应的档案也清掉 ⇒ 不可逆，而且那个档案可能正被岗位绑定引用。
//
// 下面每一条都对着上面三条之一，而不是"函数返回了对象"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DERIVE_CODES, DERIVE_CONFLICT_REASONS, describeDerivation, planProfileDerivation, profileIdFor, resolveRuntimeType } from './profile-derivation.mjs'
import { SUPPORTED_RUNTIME_TYPES } from '../runtime/contracts/model.mjs'

const PROVIDER = Object.freeze({
  id: 'fjd-ds',
  displayName: 'FJD',
  baseURL: 'https://fjbigmodel.fjdac.cn/v1',
  secretRef: 'FJD_DS_API_KEY',
  models: [{ id: 'deepseek-v4-pro-openai' }, { id: 'deepseek-v4-flash-openai' }, 'deepseek-v4-flash-vision-openai'],
})

const plan = (over = {}) => planProfileDerivation({
  provider: PROVIDER, profiles: [], runtimeType: 'dsh', profileIdOf: profileIdFor, ...over,
})

test('① 空库 ⇒ 三个模型各派生一条，且 endpoint/secretRef **留空**（留空即继承供应商）', () => {
  const p = plan()
  assert.equal(p.ok, true)
  assert.deepEqual(p.create.map((c) => c.model), [
    'deepseek-v4-pro-openai', 'deepseek-v4-flash-openai', 'deepseek-v4-flash-vision-openai',
  ])
  assert.equal(p.create[0].id, 'fjd-ds.deepseek-v4-pro-openai')
  assert.equal(p.create[0].displayName, 'FJD · deepseek-v4-pro-openai', '与库里既有命名习惯一致')
  assert.equal(p.create[0].runtimeType, 'dsh')
  assert.equal(p.create[0].provider, 'fjd-ds')
  assert.equal(p.create[0].endpoint, null, '★ 不许抄一份供应商的地址进去（那就又存了两份）')
  assert.equal(p.create[0].secretRef, null, '★ 凭证引用同理')
  assert.deepEqual(p.existing, [])
})

test('★★★ ② **按 (供应商,模型) 认身份，不按 id**：库里用连字符 id 已存在的 ⇒ 一条都不建', () => {
  // 实测：库里三条 fjd 档案的 id 是 `fjd-ds-deepseek-v4-flash-openai`（连字符），
  // 而 `profileIdFor` 算出来的是 `fjd-ds.deepseek-v4-flash-openai`（点号）。
  // 若按 id 认身份，这里会**再建三条**，而它们看起来完全正常。
  const existingRows = PROVIDER.models.map((m) => {
    const model = typeof m === 'string' ? m : m.id
    return { id: `fjd-ds-${model}`, provider: 'fjd-ds', model, deleted: false }
  })
  const p = plan({ profiles: existingRows })
  assert.deepEqual(p.create, [], '★ 一个都不许新建 —— 这三对 (供应商,模型) 已经有档案了')
  assert.equal(p.existing.length, 3)
  assert.deepEqual(p.existing.map((e) => e.profileId).sort(), [
    'fjd-ds-deepseek-v4-flash-openai', 'fjd-ds-deepseek-v4-flash-vision-openai', 'fjd-ds-deepseek-v4-pro-openai',
  ].sort())
})

test('★★ ③ 已存在的档案**一个字都不动**（不返回 update，也不带覆盖字段）', () => {
  const rows = [{ id: 'fjd-ds.deepseek-v4-pro-openai', provider: 'fjd-ds', model: 'deepseek-v4-pro-openai', deleted: false }]
  const p = plan({ profiles: rows })
  assert.equal(p.existing.length, 1)
  assert.equal(p.create.length, 2, '另外两个模型仍然是新增')
  // 计划里没有任何"要改哪一条"的东西：派生只会 create（纪律 ②）
  assert.deepEqual(Object.keys(p).sort(), ['conflicts', 'create', 'existing', 'ok', 'orphaned', 'providerId', 'runtimeType'])
  assert.equal(JSON.stringify(p).includes('"op":"update"'), false)
})

test('④ 幂等：跑第二遍（把第一遍建的喂回去）⇒ 新增 0', () => {
  const first = plan()
  const after = first.create.map((c) => ({ id: c.id, provider: c.provider, model: c.model, deleted: false }))
  const second = plan({ profiles: after })
  assert.deepEqual(second.create, [])
  assert.equal(second.existing.length, 3)
})

test('★★ ⑤ 算出来的 id 被**另一个模型**占用 ⇒ 报冲突并跳过（绝不静默复用）', () => {
  // `profileIdFor` 会把非 [a-zA-Z0-9._-] 折叠成 `-`，于是 'a/b' 与 'a-b' 会折叠到一起。
  const prov = { id: 'p', displayName: 'P', models: ['m/n', 'm-n'] }
  const p = planProfileDerivation({
    provider: prov, profiles: [], runtimeType: 'dsh', profileIdOf: profileIdFor,
  })
  assert.equal(p.create.length, 1, '第二个折叠到同一个 id 的要被挡下')
  assert.equal(p.conflicts.length, 1)
  assert.equal(p.conflicts[0].reason, DERIVE_CONFLICT_REASONS.ID_TAKEN_BY_OTHER)
})

test('★★ ⑥ 算出来的 id 是**墓碑** ⇒ 报冲突并跳过（create 会 409；同名重建会让历史指向别的模型）', () => {
  const rows = [{ id: 'fjd-ds.deepseek-v4-pro-openai', provider: 'fjd-ds', model: '别的模型', deletedAtMs: 1791160361180 }]
  const p = plan({ profiles: rows })
  const hit = p.conflicts.find((c) => c.model === 'deepseek-v4-pro-openai')
  assert.ok(hit, '必须报出来，而不是让 create 在写库时才 409')
  assert.equal(hit.reason, DERIVE_CONFLICT_REASONS.TOMBSTONED_ID)
  assert.equal(p.create.some((c) => c.id === 'fjd-ds.deepseek-v4-pro-openai'), false)
})

test('★★ ⑦ 供应商清单里没有的模型 ⇒ 只报 `orphaned`，**绝不自动删**', () => {
  const rows = [
    { id: 'fjd-ds.legacy-model', provider: 'fjd-ds', model: 'legacy-model', deleted: false },
    { id: 'other.x', provider: 'other', model: 'legacy-model', deleted: false },
    { id: 'fjd-ds.gone', provider: 'fjd-ds', model: 'gone', deletedAtMs: 1 },
  ]
  const p = plan({ profiles: rows })
  assert.deepEqual(p.orphaned.map((o) => o.profileId), ['fjd-ds.legacy-model'],
    '只报本供应商的、活着的；别的供应商与墓碑都不进这个名单')
  assert.equal(JSON.stringify(p).includes('delete'), false, '★ 计划里不该出现任何删除动作')
})

test('★★ ⑧ 没给 runtimeType ⇒ 明确拒绝，不猜（与迁移同一条纪律）', () => {
  for (const rt of [null, undefined, '', '   ']) {
    const p = plan({ runtimeType: rt })
    assert.equal(p.ok, false, `runtimeType=${JSON.stringify(rt)}`)
    assert.equal(p.code, DERIVE_CODES.RUNTIME_TYPE_REQUIRED)
    assert.match(p.message, /不猜|第一次运行才失败/)
  }
})

test('⑨ 坏输入：缺 profileIdOf / 供应商不是对象 / profiles 不是数组 ⇒ 构造期就拒绝', () => {
  assert.throws(() => planProfileDerivation({ provider: PROVIDER, runtimeType: 'dsh' }), /profileIdOf/)
  assert.throws(() => planProfileDerivation({ provider: null, runtimeType: 'dsh', profileIdOf: profileIdFor }), /供应商行/)
  assert.throws(
    () => planProfileDerivation({ provider: PROVIDER, profiles: 'x', runtimeType: 'dsh', profileIdOf: profileIdFor }),
    /数组/,
  )
})

test('⑩ 清单去重、丢掉空 id（一个空模型名不该变成一条坏档案）', () => {
  const prov = { id: 'p', displayName: 'P', models: ['a', 'a', '', '  ', null, { id: 'b' }, { id: '' }] }
  const p = planProfileDerivation({ provider: prov, profiles: [], runtimeType: 'dsh', profileIdOf: profileIdFor })
  assert.deepEqual(p.create.map((c) => c.model), ['a', 'b'])
})

test('⑪ 读数是一句话，且把"未动"说清楚（不许读成"已清理"）', () => {
  const p = plan({ profiles: [{ id: 'fjd-ds.gone', provider: 'fjd-ds', model: 'gone', deleted: false }] })
  const text = describeDerivation(p)
  assert.match(text, /新增 3/)
  assert.match(text, /未动/, '★ 用户必须看得出"这几条我没动"')
  assert.match(describeDerivation({ ok: false, message: 'x' }), /派生未执行/)
  assert.match(describeDerivation(null), /派生未执行/)
})

// ---------------------------------------------------------------------------
// 运行时类型：**只有恰好一个候选时**才允许替用户定
//
// 这是"添加完自动生成档案"唯一的障碍：派生需要 `runtimeType`。
// 把默认值随便给一个，就是 `model-migration.mjs` 那条纪律说的"猜错会让请求
// 以错误的协议发出去"；而**只有一个能跑的时候**，选它不需要用户任何信息。
// ---------------------------------------------------------------------------

test('★★ ⑫ 供应商自己有 ⇒ 用它（第一顺位，连"唯一候选"都不用判）', () => {
  const r = resolveRuntimeType({ providerRuntimeType: 'dsh', requested: 'openai-compatible', supported: SUPPORTED_RUNTIME_TYPES })
  assert.deepEqual(r, { ok: true, runtimeType: 'dsh', from: 'provider' })
})

test('★★ ⑬ 供应商没有、请求里有 ⇒ 用它（第二顺位）', () => {
  const r = resolveRuntimeType({ providerRuntimeType: null, requested: 'openai-compatible', supported: ['dsh'] })
  assert.deepEqual(r, { ok: true, runtimeType: 'openai-compatible', from: 'request' })
})

test('★★★ ⑭ 两个都没有、而**只有一个能跑** ⇒ 用它，并留下 `only-supported` 这个出处', () => {
  // 依据是 `runtime/contracts/model.mjs` 的 `SUPPORTED_RUNTIME_TYPES`：
  // Legion 今天只有一个适配器，`server.mjs` 的模型覆盖检查也只接受 dsh。
  const r = resolveRuntimeType({ supported: SUPPORTED_RUNTIME_TYPES })
  assert.deepEqual(r, { ok: true, runtimeType: 'dsh', from: 'only-supported' })
  assert.equal(SUPPORTED_RUNTIME_TYPES.length, 1, '这条判据的前提就是"只有一个"；多于一个时下面那条会响')
})

test('★★★ ⑮ **有第二个能跑的运行时 ⇒ 必须拒绝**（那时"挑第一个"就是猜）', () => {
  const r = resolveRuntimeType({ supported: ['dsh', 'codex'] })
  assert.equal(r.ok, false)
  assert.equal(r.code, DERIVE_CODES.RUNTIME_TYPE_AMBIGUOUS)
  assert.match(r.message, /多个能跑的运行时/)
  assert.match(r.message, /我没选过/, '要说明为什么不能替你选')
  // 与"一个候选都没有"分开报：两者的修法不同
  const none = resolveRuntimeType({ supported: [] })
  assert.equal(none.ok, false)
  assert.equal(none.code, DERIVE_CODES.RUNTIME_TYPE_REQUIRED)
})

test('⑯ 空白串当作"没给"（否则一个空格会静默变成一个运行时名）', () => {
  assert.deepEqual(resolveRuntimeType({ providerRuntimeType: '  ', requested: '   ', supported: ['dsh'] }),
    { ok: true, runtimeType: 'dsh', from: 'only-supported' })
})

test('⑰ `supported` 里的重复项与空项不改变"是否唯一"的判定', () => {
  assert.equal(resolveRuntimeType({ supported: ['dsh', 'dsh', '', '  ', null] }).ok, true)
  assert.equal(resolveRuntimeType({ supported: ['dsh', 'dsh', '', '  ', null] }).runtimeType, 'dsh')
})

test('⑱ 坏输入：没给 `supported` ⇒ 构造期就拒绝（"没判断过"不许被当成"唯一"）', () => {
  assert.throws(() => resolveRuntimeType({}), /supported/)
  assert.throws(() => resolveRuntimeType({ supported: 'dsh' }), /supported/)
})
