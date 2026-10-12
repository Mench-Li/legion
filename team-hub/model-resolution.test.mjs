// team-hub/model-resolution.test.mjs
// ============================================================================
// 有效档案：档案留空的 `endpoint` / `secretRef` 从它点名的供应商补上。
//
// 这一组守的是 `docs/DECISION-legion-owns-model-config.md` §6 那句的下半句：
//
//   > `api` 协议与 `base_url` 从"每行都有"上移到"每个供应商一份"。
//
// 上移做完之后，档案那一份就该是**可选覆盖**。这些用例同时钉住两件相反的事：
//   · 留空 ⇒ 继承（否则"上移"没兑现，用户得回填一份拷贝）；
//   · 写了 ⇒ **逐字用它**（否则闸门会顺手把用户的真实偏离改掉，而那是一处真配置）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectionIsRedundant, connectionSources, effectiveProfile } from './model-resolution.mjs'

const FJD = Object.freeze({
  id: 'fjd-ds', displayName: 'FJD', api: 'openai-completions',
  baseURL: 'https://fjbigmodel.fjdac.cn/v1', secretRef: 'FJD_DS_API_KEY',
})

const profile = (over = {}) => ({
  id: 'p1', displayName: 'x', runtimeType: 'dsh', provider: 'fjd-ds',
  model: 'deepseek-v4-flash-openai', endpoint: null, secretRef: null, ...over,
})

test('① 留空 ⇒ 从供应商继承（这就是"上移"的兑现）', () => {
  const eff = effectiveProfile(profile(), FJD)
  assert.equal(eff.endpoint, 'https://fjbigmodel.fjdac.cn/v1')
  assert.equal(eff.secretRef, 'FJD_DS_API_KEY')
  assert.deepEqual(eff.inherited, { endpoint: true, credential: true })
})

test('② 档案自己写了 ⇒ **逐字用它**，不继承（真实偏离必须活下来）', () => {
  const eff = effectiveProfile(profile({
    endpoint: 'https://other-gateway.example/v1', secretRef: 'OTHER_KEY',
  }), FJD)
  assert.equal(eff.endpoint, 'https://other-gateway.example/v1')
  assert.equal(eff.secretRef, 'OTHER_KEY')
  assert.deepEqual(eff.inherited, { endpoint: false, credential: false }, '不许被供应商的值覆盖')
})

test('③ 两件事**各自**判：只写 endpoint 时凭证仍然继承', () => {
  const eff = effectiveProfile(profile({ endpoint: 'https://only-endpoint.example/v1' }), FJD)
  assert.equal(eff.endpoint, 'https://only-endpoint.example/v1')
  assert.equal(eff.secretRef, 'FJD_DS_API_KEY', '★ 一个字段写了不该顺手关掉另一个字段的继承')
  assert.deepEqual(eff.inherited, { endpoint: false, credential: true })
})

test('④ 空串/空白当作"留空"（否则一个空格会静默关掉继承）', () => {
  const eff = effectiveProfile(profile({ endpoint: '   ', secretRef: '' }), FJD)
  assert.equal(eff.endpoint, 'https://fjbigmodel.fjdac.cn/v1')
  assert.equal(eff.secretRef, 'FJD_DS_API_KEY')
})

test('⑤ 供应商不存在 ⇒ 原样返回，且**点名**这件事（不许笼统报"没填 endpoint"）', () => {
  const eff = effectiveProfile(profile(), null)
  assert.equal(eff.endpoint, null)
  assert.equal(eff.secretRef, null)
  assert.equal(eff.providerMissing, true,
    '★ 修法是"先建供应商"，不是"去填地址"——两者不能长成同一句话')
})

test('⑥ 供应商存在但没有 baseURL/secretRef ⇒ providerMissing 为假，值为 null（如实）', () => {
  const eff = effectiveProfile(profile(), { id: 'fjd-ds', baseURL: null, secretRef: null })
  assert.equal(eff.endpoint, null)
  assert.equal(eff.secretRef, null)
  assert.equal(eff.providerMissing, false)
})

test('⑦ 无 provider 的合法本地模型（无 endpoint 无凭证）不被弄坏', () => {
  const eff = effectiveProfile(profile({ provider: 'local', endpoint: null, secretRef: null }), null)
  assert.equal(eff.endpoint, null)
  assert.equal(eff.secretRef, null)
  assert.equal(eff.providerMissing, true, '点了一个库里没有的供应商 ⇒ 这件事要说出来')
})

test('⑧ 不修改入参（这是读法合成，不是数据变更）', () => {
  const p = profile()
  const before = JSON.stringify(p)
  effectiveProfile(p, FJD)
  assert.equal(JSON.stringify(p), before)
})

test('⑨ 坏输入不抛', () => {
  assert.equal(effectiveProfile(null, FJD), null)
  assert.equal(effectiveProfile(undefined, FJD), null)
  assert.equal(effectiveProfile(42, FJD), null)
})

test('⑩ 来源描述：能向人说清"这个值是继承来的"', () => {
  const inherited = connectionSources(profile(), FJD)
  assert.deepEqual(inherited.endpoint, { value: 'https://fjbigmodel.fjdac.cn/v1', from: 'provider' })
  assert.deepEqual(inherited.credential, { ref: 'FJD_DS_API_KEY', from: 'provider' })

  const own = connectionSources(profile({ endpoint: 'https://mine.example/v1' }), FJD)
  assert.equal(own.endpoint.from, 'profile')
  assert.equal(own.credential.from, 'provider')

  const none = connectionSources(profile(), null)
  assert.deepEqual(none.endpoint, { value: null, from: null })
  assert.deepEqual(none.credential, { ref: null, from: null })
  assert.equal(none.providerMissing, true)
})

test('⑪ 纯复制识别：与供应商逐字相同时点名，**但绝不因此拒绝**', () => {
  const redundant = connectionIsRedundant(profile({
    endpoint: 'https://fjbigmodel.fjdac.cn/v1', secretRef: 'FJD_DS_API_KEY',
  }), FJD)
  assert.deepEqual(redundant, { endpoint: true, credential: true })

  const partly = connectionIsRedundant(profile({ endpoint: 'https://fjbigmodel.fjdac.cn/v1' }), FJD)
  assert.deepEqual(partly, { endpoint: true, credential: false })

  // 留空的**不算**纯复制（它本来就该继承，不是"抄了一遍"）
  assert.deepEqual(connectionIsRedundant(profile(), FJD), { endpoint: false, credential: false })
  // 真偏离不算
  assert.deepEqual(connectionIsRedundant(profile({ endpoint: 'https://x.example/v1' }), FJD), { endpoint: false, credential: false })
  assert.deepEqual(connectionIsRedundant(null, FJD), { endpoint: false, credential: false })
})
