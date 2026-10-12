// team-hub/credential-status.test.mjs
// ============================================================================
// 真实凭证状态：**问本机密钥库**，而不是信"引用了某个名字"。
//
// 实测的假话（2026-10-10）：
//   面板显示 `fjd-ds · 已配置凭证`，而它引用的 `FJD_DS_API_KEY` 根本不在库里。
//   那句"已配置"来自 `model_providers.credential_configured`（**P1 从 DSH 导入的标记**）
//   与档案的 `hasCredential`（只表示 `secret_ref` 非空）—— **两者都不是核验**。
//
// 这一组最重要的一条是 ③：读不出来时不许说"没有"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CREDENTIAL_STATE_TEXT, CREDENTIAL_STATES, classifyCredential, createCredentialStatus } from './credential-status.mjs'

const snap = (refs) => ({ ok: true, refs: new Set(refs), message: null })

test('① 引用名在库里 ⇒ ready', () => {
  const r = classifyCredential('FJD_DS_API_KEY', snap(['FJD_DS_API_KEY', 'X']))
  assert.equal(r.state, 'ready')
  assert.equal(r.ref, 'FJD_DS_API_KEY')
})

test('② 引用名不在库里 ⇒ missing，并且说清"钥匙从未存进来或被删了"', () => {
  const r = classifyCredential('FJD_DS_API_KEY', snap(['SVEA_DS_API_KEY']))
  assert.equal(r.state, 'missing')
  assert.match(r.detail, /没有这个引用/)
})

test('★★★ ③ 读不出来 ⇒ unavailable，**绝不是** missing（把"我不知道"说成"没有"会让人去补一把已经在的钥匙）', () => {
  for (const bad of [null, undefined, { ok: false, refs: new Set(), message: '布局未确定' }]) {
    const r = classifyCredential('FJD_DS_API_KEY', bad)
    assert.equal(r.state, 'unavailable', `snapshot=${JSON.stringify(bad)}`)
    assert.notEqual(r.state, 'missing')
    assert.match(r.detail, /不等于"没有"/)
  }
})

test('④ 没有引用名 ⇒ none（不需要鉴权的模型是合法的，不是错误）', () => {
  for (const ref of [null, undefined, '']) {
    const r = classifyCredential(ref, snap([]))
    assert.equal(r.state, 'none')
    assert.equal(r.ref, null)
  }
})

test('⑤ 状态文本表覆盖全部状态（缺一个会让界面露出英文状态码）', () => {
  for (const s of CREDENTIAL_STATES) {
    assert.equal(typeof CREDENTIAL_STATE_TEXT[s], 'string', s + ' 缺中文')
    assert.ok(CREDENTIAL_STATE_TEXT[s].length > 0)
  }
})

test('⑥ `refs` 是数组也要能判（读数的形状不该成为判据的一部分）', () => {
  assert.equal(classifyCredential('K', { ok: true, refs: ['K'] }).state, 'ready')
  assert.equal(classifyCredential('K', { ok: true, refs: [] }).state, 'missing')
})

test('⑦ 没有 listRefs ⇒ 构造时就拒绝（"没核验过"不许被当成"没有"）', () => {
  assert.throws(() => createCredentialStatus({}), /listRefs/)
  assert.throws(() => createCredentialStatus({ listRefs: 'x' }), /listRefs/)
})

test('⑧ 一次 snapshot 读一遍库、判任意多次（N 个供应商不该打开 N 次密钥库）', async () => {
  let calls = 0
  const status = createCredentialStatus({
    listRefs: async () => { calls += 1; return ['A', 'B'] },
  })
  const s = await status.snapshot()
  assert.equal(s.of('A').state, 'ready')
  assert.equal(s.of('B').state, 'ready')
  assert.equal(s.of('C').state, 'missing')
  assert.equal(calls, 1, '★ 读第二、第三条时不许再问一次密钥库')
})

test('★ ⑨ listRefs 抛错 ⇒ 整份读数 unavailable，且**不带上原始错误正文**（它可能含实现细节）', async () => {
  const status = createCredentialStatus({
    listRefs: async () => { throw new Error('SECRETS_LAYOUT_BLOCKED: C:\\Users\\me\\.dsh\\...') },
  })
  const s = await status.snapshot()
  assert.equal(s.ok, false)
  const r = s.of('FJD_DS_API_KEY')
  assert.equal(r.state, 'unavailable')
  assert.doesNotMatch(r.detail, /C:\\Users/, '不许把密钥库路径/实现细节带进响应')
})
