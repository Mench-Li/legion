// product/release/privacy.test.mjs
// ============================================================================
// PRT-903：隐私、数据处理与模型调用说明。spec §10 line 743–747。
//
// 这一组盯的**不是**"有没有一份说明"，而是**那份说明会不会过期**。
// 隐私说明最常见的失效方式不是写错，而是写完就旧了——代码里多一条出境通道、
// 多一个字段，说明里一个字都不变，而它读起来依然完整。
//
//   > 一个「手写的隐私说明」，
//   > 与一个「代码里新增了一条出境通道、而说明里一个字都没变」的说明，
//   > 是同一个东西——只不过前者读起来是完整的。
//
// 所以下面每一条都用一个**注入的假世界**去问，而不是断言仓库当前状态。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EGRESS_CHANNEL_IDS,
  EGRESS_CONTROLS,
  EGRESS_KINDS,
  PRIVACY_CHECKED,
  PRIVACY_CODES,
  privacyReport,
  renderPrivacyNotice,
} from './privacy.mjs'
import { ALLOWED_PAYLOAD_KEYS, DEFAULT_HEARTBEAT_POLICY } from '../heartbeat.mjs'
import { CONSENT_PURPOSE_IDS } from '../diagnostics/crash-report.mjs'

/** 一个"当前的代码世界"——正常输入。 */
const WORLD = { observedEgress: EGRESS_CHANNEL_IDS }

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：四条核心判据都真的被跑过（留下的是值不是布尔）', () => {
  assert.equal(PRIVACY_CHECKED.ok, true, JSON.stringify(PRIVACY_CHECKED.problems))
  const s = PRIVACY_CHECKED.samples
  assert.equal(s.cleanOk, true)
  // 未披露 → 必须被抓住（本模块存在的理由）
  assert.ok(s.undeclaredCaught.includes(PRIVACY_CODES.UNDISCLOSED_EGRESS))
  // 反向：说明里多出来的通道也要报
  assert.ok(s.staleCaught.includes(PRIVACY_CODES.STALE_CHANNEL))
  // 字段名单漂移
  assert.ok(s.driftCaught.includes(PRIVACY_CODES.FIELD_LIST_DRIFT))
})

test('① ★ 版本号是常量字符串', () => {
  assert.match(privacyReport(WORLD).version, /^legion\/privacy@\d+$/)
})

// ---------------------------------------------------------------- ★★ 未披露

test('② ★★ 代码里存在、说明里没有的通道必须被抓住（说明最该拦的东西）', () => {
  const r = privacyReport({ observedEgress: [...EGRESS_CHANNEL_IDS, 'telemetry-hidden'] })
  const f = r.findings.find((x) => x.code === PRIVACY_CODES.UNDISCLOSED_EGRESS)
  assert.ok(f, `必须抓住未披露通道，实际 ${JSON.stringify(r.findings.map((x) => x.code))}`)
  assert.equal(f.channel, 'telemetry-hidden')
  assert.equal(r.ok, false)
})

test('② ★★ 说明里列了、代码里没有的通道也要被抓住（过期的披露同样误导）', () => {
  const r = privacyReport({ observedEgress: [] })
  assert.equal(r.findings.filter((x) => x.code === PRIVACY_CODES.STALE_CHANNEL).length, EGRESS_CHANNEL_IDS.length)
})

test('② ★★ 不给 `observedEgress` 时**不**报未披露/过期（"没观测"不等于"没有"）', () => {
  // 缺席与空数组必须分开：空数组是"看了，一条都没有"，缺席是"没看"。
  const missing = privacyReport({})
  assert.equal(missing.findings.filter((x) => x.code === PRIVACY_CODES.UNDISCLOSED_EGRESS).length, 0)
  assert.equal(missing.findings.filter((x) => x.code === PRIVACY_CODES.STALE_CHANNEL).length, 0)
  assert.equal(missing.ok, true)
})

// ---------------------------------------------------------------- ★★ 字段漂移

test('③ ★★ 心跳允许名单新增字段而说明未变 → 报 `FIELD_LIST_DRIFT`', () => {
  const r = privacyReport({ ...WORLD, actualPayloadKeys: [...ALLOWED_PAYLOAD_KEYS, 'screen_text'] })
  const f = r.findings.find((x) => x.code === PRIVACY_CODES.FIELD_LIST_DRIFT)
  assert.ok(f, '允许名单变化必须让说明变红')
  assert.match(f.detail, /screen_text/)
})

test('③ ★★ 字段名单是**引用**心跳模块的，不是在这里抄一份', () => {
  // 抄一份就是造出第二份名单，它们迟早不一样。
  const r = privacyReport(WORLD)
  const hb = r.channels.find((c) => c.id === 'heartbeat')
  assert.deepEqual([...hb.fields].sort(), [...ALLOWED_PAYLOAD_KEYS].sort())
  assert.equal(hb.fieldsRef, 'heartbeat.ALLOWED_PAYLOAD_KEYS')
})

test('③ ★★ 允许名单**减项**也要报（说明多列了一个不发的字段同样是错的）', () => {
  const r = privacyReport({ ...WORLD, actualPayloadKeys: ALLOWED_PAYLOAD_KEYS.slice(0, 3) })
  assert.ok(r.findings.some((x) => x.code === PRIVACY_CODES.FIELD_LIST_DRIFT))
})

// ---------------------------------------------------------------- 控制手段

test('④ ★★ 每个通道都必须说得出控制手段（说不出控制的通道 = 没有控制）', () => {
  for (const ch of privacyReport(WORLD).channels) {
    assert.ok(ch.controls.length > 0, `通道 ${ch.id} 没有控制手段`)
    for (const c of ch.controls) assert.ok(EGRESS_CONTROLS.includes(c), `${ch.id} 的控制 ${c} 不在已知集合里`)
  }
  // 心跳必须同时有"只发名单内"和"仅 https"——这两条是它区别于裸通道的地方
  const hb = privacyReport(WORLD).channels.find((c) => c.id === 'heartbeat')
  assert.ok(hb.controls.includes('allow-list'))
  assert.ok(hb.controls.includes('https-only'))
})

test('④ ★★ 要求用户同意的通道必须挂到一个**真实存在**的同意事项上', () => {
  const r = privacyReport(WORLD)
  for (const ch of r.channels) {
    if (!ch.controls.includes('user-consent')) continue
    assert.ok(ch.consentPurpose !== null, `通道 ${ch.id} 要求同意却没挂事项`)
    assert.ok(CONSENT_PURPOSE_IDS.includes(ch.consentPurpose), `${ch.id} 挂的事项 ${ch.consentPurpose} 不存在`)
  }
  // 这一条是 PRT-903 的自检抓出来的真缺口：model-call 曾经挂着 null
  assert.ok(CONSENT_PURPOSE_IDS.includes('model-call'), 'model-call 同意事项必须存在')
})

test('④ ★★ `fields: null` 必须配 `fieldsRef`（留空会被读成"不发字段"）', () => {
  for (const ch of privacyReport(WORLD).channels) {
    if (ch.fields === null) {
      assert.equal(typeof ch.fieldsRef, 'string', `通道 ${ch.id} 没列字段也没说从哪来`)
      assert.ok(ch.fieldsRef.length > 0)
    }
  }
})

// ---------------------------------------------------------------- ★★ 模型调用

test('⑤ ★★ 出境通道必须分两类，且"委托 DSH"那一类**必须存在**', () => {
  // 把这一类漏掉，会得到一份"数据不出门"的报告，而模型调用每天都在出门。
  const r = privacyReport(WORLD)
  assert.ok(EGRESS_KINDS.includes('delegated-dsh'))
  assert.ok(r.byKind['delegated-dsh'].length > 0, '必须有通道被标为"委托 DSH"')
  const model = r.channels.find((c) => c.id === 'model-call')
  assert.equal(model.kind, 'delegated-dsh')
})

test('⑤ ★★ "心跳默认关着"不能推出"没有数据出境"（本模块最要紧的一句话）', () => {
  assert.equal(DEFAULT_HEARTBEAT_POLICY.enabled, false, '心跳默认必须是关的')
  const r = privacyReport(WORLD)
  // 心app跳关着…
  assert.deepEqual([...r.defaultsSummary.ownChannelsEnabledByDefault], [], '自有通道默认全部关闭')
  // …但仍有强制出境的通道
  assert.ok(r.defaultsSummary.delegatedChannelsAlwaysOn.length > 0)
  assert.equal(r.defaultsSummary.egressStillHappensWithAllDefaults, true)
})

test('⑤ ★★ 渲染出的说明**主动**反驳"心跳关着就没出境"这个推论', () => {
  const text = renderPrivacyNotice(privacyReport(WORLD))
  assert.match(text, /模型调用/)
  assert.match(text, /心跳关着/)
  assert.match(text, /不等于/)
  // 目的地不确定这件事必须明说，而不是留空
  assert.match(text, /本仓库看不到|由 DSH|无法事后审计/)
})

// ---------------------------------------------------------------- 本地数据

test('⑥ ★★ 本地数据分类逐条列出（说明必须能回答"卸载时我的东西会怎样"）', () => {
  const r = privacyReport(WORLD)
  assert.ok(r.localDataClasses.length >= 5)
  for (const c of r.localDataClasses) {
    assert.ok(typeof c.label === 'string' && c.label.length > 0)
    assert.ok(typeof c.onUninstall === 'string' && c.onUninstall.length > 0)
  }
  const text = renderPrivacyNotice(r)
  assert.match(text, /卸载时/)
})

// ---------------------------------------------------------------- ★★ 可注入的坏通道

/** 一个"结构完整"的通道；下面每条只坏一处。 */
const mkChannel = (patch) => ({
  id: 'probe', kind: 'product-owned', label: '探针通道', destination: '探针',
  fieldsRef: 'probe', fields: null, defaultEnabled: false,
  controls: ['user-consent'], consentPurpose: 'crash-upload', ...patch,
})

test('⑧ ★★ 通道表**可注入**——否则那三条判据在真实输入上永远不可能触发', () => {
  // 这一段的存在理由：探针 55④⑤⑥ 第一版**应用了却没有用例变红**，
  // 因为那三条判据读的是模块级常量、在真实输入上恒真。
  //
  //   > 一个「永远不会触发」的复核，与没有复核，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // 反向控制：一个结构完整的通道必须**零** finding——否则这三条是无差别报警。
  assert.equal(privacyReport({ channels: [mkChannel({})], observedEgress: null }).findings.length, 0)
})

test('⑧ ★★ 无控制手段的通道被抓住（"说不出控制"≠"没有控制"）', () => {
  const r = privacyReport({ channels: [mkChannel({ controls: [] })], observedEgress: null })
  assert.ok(r.findings.some((f) => f.code === PRIVACY_CODES.UNCONTROLLED_CHANNEL))
})

test('⑧ ★★ 引用未知控制手段被抓住', () => {
  const r = privacyReport({ channels: [mkChannel({ controls: ['感觉不错'] })], observedEgress: null })
  assert.ok(r.findings.some((f) => f.code === PRIVACY_CODES.UNCONTROLLED_CHANNEL))
})

test('⑧ ★★ 要求同意却没挂事项的通道被抓住（这正是 model-call 曾经的缺口）', () => {
  const r = privacyReport({ channels: [mkChannel({ consentPurpose: null })], observedEgress: null })
  assert.ok(r.findings.some((f) => f.code === PRIVACY_CODES.NO_CONSENT_PURPOSE))
  // 挂到一个不存在的同意事项上同样要报
  const bogus = privacyReport({ channels: [mkChannel({ consentPurpose: '不存在的同意' })], observedEgress: null })
  assert.ok(bogus.findings.some((f) => f.code === PRIVACY_CODES.NO_CONSENT_PURPOSE))
})

test('⑧ ★★ `fields: null` 却没说字段从哪来被抓住（留空会被读成"不发字段"）', () => {
  const r = privacyReport({ channels: [mkChannel({ fields: null, fieldsRef: '' })], observedEgress: null })
  assert.ok(r.findings.some((f) => f.code === PRIVACY_CODES.FIELDS_UNEXPLAINED))
})

test('⑧ ★ 注入的通道表同样参与未披露/过期检查（两处用的是同一份表）', () => {
  const custom = [mkChannel({})]
  // 观测到一条不在注入表里的通道 → 未披露
  const extra = privacyReport({ channels: custom, observedEgress: ['probe', 'sneaky'] })
  assert.ok(extra.findings.some((f) => f.code === PRIVACY_CODES.UNDISCLOSED_EGRESS))
  // 注入表里有、观测没有 → 过期
  const missing = privacyReport({ channels: custom, observedEgress: [] })
  assert.ok(missing.findings.some((f) => f.code === PRIVACY_CODES.STALE_CHANNEL))
})

// ---------------------------------------------------------------- 渲染

test('⑦ ★ 说明里带版本号与结论行（读者要知道自己看的是哪一版）', () => {
  const text = renderPrivacyNotice(privacyReport(WORLD))
  assert.match(text, /legion\/privacy@\d+/)
  assert.match(text, /均已对齐/)
})

test('⑦ ★ 有未闭合项时说明里**明说**，而不是照样宣布健康', () => {
  const text = renderPrivacyNotice(privacyReport({ ...WORLD, actualPayloadKeys: [...ALLOWED_PAYLOAD_KEYS, 'x'] }))
  assert.match(text, /未闭合项/)
  assert.match(text, /privacy-field-list-drift/)
  assert.doesNotMatch(text, /均已对齐/)
})

test('⑦ ★ 返回对象被冻结', () => {
  const r = privacyReport(WORLD)
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.channels))
  assert.ok(Object.isFrozen(r.findings))
  assert.throws(() => { 'use strict'; r.ok = false }, TypeError)
})

test('⑦ ★ 每个通道都有 label 与 why（一份说不出理由的披露，下一个人会"顺手简化"）', () => {
  const r = privacyReport(WORLD)
  for (const ch of r.channels) {
    assert.ok(ch.label.length > 0, `${ch.id} 没有 label`)
    assert.ok(typeof ch.destination === 'string' && ch.destination.length > 0, `${ch.id} 没有目的地说明`)
  }
})
