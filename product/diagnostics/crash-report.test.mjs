// product/diagnostics/crash-report.test.mjs
// ============================================================================
// PRT-906：崩溃报告的用户授权与脱敏策略。spec §10 line 747–750。
//
// 这一组盯的**不是**"有没有同意开关"，而是**开关读不出来时会发生什么**。
// 三个坑都会安静地放过：
//
//   ① "本地生成不用问，先存下来以后再问" → 未脱敏的东西留在从没被同意过的磁盘上
//   ② "没同意"与"没说"合并 → 读不出来的配置变成默认同意
//   ③ 撤销只影响将来 → 用户点了拒绝，磁盘上那份还在等着某天被上传
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONSENT_PURPOSES,
  CONSENT_PURPOSE_IDS,
  CONSENT_STATES,
  CRASH_CODES,
  CRASH_POLICY_CHECKED,
  DEFAULT_CONSENT,
  assertRedacted,
  normalizeConsent,
  planCrashReport,
  revokeConsent,
} from './crash-report.mjs'
import { STRUCTURAL_EXCLUSIONS } from './redact-package.mjs'

const consent = (obj) => normalizeConsent(obj).state

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：四条核心判据都真的被跑过（留下的是值不是布尔）', () => {
  assert.equal(CRASH_POLICY_CHECKED.ok, true, JSON.stringify(CRASH_POLICY_CHECKED.problems))
  const s = CRASH_POLICY_CHECKED.samples
  assert.equal(s.unknownCapture, false)
  assert.equal(s.unknownTransmit, false)
  assert.equal(s.localOnlyCapture, true)
  assert.equal(s.localOnlyTransmit, false)
  assert.equal(s.uploadOnlyTransmit, false)
  assert.ok(s.droppedNames.includes('credentials.yaml'), '结构性排除必须真的命中过')
  assert.ok(s.redactedNames.includes('HOME'), '崩溃特有条目脱敏必须真的命中过')
  assert.equal(s.revokedStaleCount, 1)
})

// ---------------------------------------------------------------- ★★ 三态

test('② ★★ 同意状态是**三分**的，且出厂默认全部 unknown（不是 granted）', () => {
  assert.deepEqual([...CONSENT_STATES], ['granted', 'denied', 'unknown'])
  for (const p of CONSENT_PURPOSE_IDS) assert.equal(DEFAULT_CONSENT[p], 'unknown', `${p} 的默认值必须是 unknown`)
  // 每一项都要有 why（一份说不出理由的同意项，下一个人会以为是漏收而"顺手补上"）
  for (const p of CONSENT_PURPOSES) assert.ok(p.why.length > 0, `${p.id} 没有说明为什么单独列`)
})

test('② ★★ 缺字段 → unknown；非法值 → unknown + 报码（**不是** granted）', () => {
  const empty = normalizeConsent({})
  for (const p of CONSENT_PURPOSE_IDS) assert.equal(empty.state[p], 'unknown')
  assert.equal(empty.findings.length, 0, '缺字段是正常情况，不该报码')

  for (const bad of ['yes', true, 1, 'GRANTED', 'allow']) {
    const r = normalizeConsent({ 'crash-local': bad })
    assert.equal(r.state['crash-local'], 'unknown', `${JSON.stringify(bad)} 必须归成 unknown`)
    assert.ok(r.findings.some((f) => f.code === CRASH_CODES.CONSENT_INVALID))
  }
  // 空串也算缺席
  assert.equal(normalizeConsent({ 'crash-local': '' }).state['crash-local'], 'unknown')
})

test('② ★★ unknown / denied 都**不能**导致落盘或发送', () => {
  for (const state of ['unknown', 'denied']) {
    const p = planCrashReport({ consent: consent({ 'crash-local': state, 'crash-upload': state }) })
    assert.equal(p.captureLocal, false, `${state} 不该落盘`)
    assert.equal(p.transmit, false, `${state} 不该发送`)
  }
})

// ---------------------------------------------------------------- 两份同意

test('③ ★★ 只同意本地 → 落盘但不发送', () => {
  const p = planCrashReport({ consent: consent({ 'crash-local': 'granted' }) })
  assert.equal(p.captureLocal, true)
  assert.equal(p.transmit, false)
  assert.ok(p.findings.some((f) => f.code === CRASH_CODES.UPLOAD_NOT_CONSENTED))
})

test('③ ★★ 只同意上传 → **既不落盘也不发送**（不允许临时生成副本直接发走）', () => {
  // 这一条是"本地副本"与"对外传输"之间那道墙：
  // 没有本地已同意的副本，就不存在可以发送的东西。
  const p = planCrashReport({ consent: consent({ 'crash-upload': 'granted' }) })
  assert.equal(p.captureLocal, false)
  assert.equal(p.transmit, false, '只勾了上传不能变成直接发走')
  assert.ok(p.findings.some((f) => f.code === CRASH_CODES.LOCAL_NOT_CONSENTED))
})

test('③ ★★ 两份都同意才发送', () => {
  const p = planCrashReport({ consent: consent({ 'crash-local': 'granted', 'crash-upload': 'granted' }) })
  assert.equal(p.captureLocal, true)
  assert.equal(p.transmit, true)
  assert.equal(p.findings.length, 0)
})

test('③ ★★ "同意上报崩溃"不等蕴含"同意遥测"（四个事项必须分开）', () => {
  const p = planCrashReport({ consent: consent({ 'crash-local': 'granted', 'crash-upload': 'granted' }) })
  assert.equal(p.transmit, true)
  // 遥测那一项仍然是 unknown，且不被任何崩溃相关同意推出
  assert.equal(consent({ 'crash-local': 'granted' })['usage-telemetry'], 'unknown')
  assert.ok(CONSENT_PURPOSE_IDS.includes('usage-telemetry'))
})

// ---------------------------------------------------------------- ★★ 脱敏

test('④ ★★ 脱敏是**无条件**的——即使只本地落盘、即使什么都没同意', () => {
  // "先原样存下来以后再脱敏"会把未脱敏内容留在从没被同意过的磁盘上。
  const p = planCrashReport({
    consent: DEFAULT_CONSENT,        // 全部 unknown
    payload: { fields: [{ name: 'credentials.yaml', value: 'token=x' }, { name: 'HOME', value: '/home/me', kind: 'env' }] },
  })
  assert.equal(p.captureLocal, false, '什么都没同意，不该落盘')
  assert.ok(p.drop.length > 0, '即使不落盘，脱敏计划也必须算出来')
  assert.ok(p.redact.length > 0)
})

test('④ ★★ 复用 `redact-package.mjs` 的结构性排除，而不是另写一份', () => {
  const known = new Set(STRUCTURAL_EXCLUSIONS.map((e) => e.id))
  const p = planCrashReport({
    consent: consent({ 'crash-local': 'granted' }),
    payload: { fields: [{ name: 'x.credentials.yaml', value: 'a' }] },
  })
  assert.ok(p.drop.length > 0, '后缀规则的排除必须命中')
  assert.ok(known.has(p.drop[0].rule), `排除规则 ${p.drop[0].rule} 必须来自 redact-package`)
  assert.ok(p.drop[0].why.length > 0, '排除项必须带理由')
})

test('④ ★★ 环境变量与绝对路径被脱敏（崩溃特有的两类）', () => {
  const p = planCrashReport({
    consent: consent({ 'crash-local': 'granted' }),
    payload: {
      fields: [
        { name: 'HOME', value: 'x', kind: 'env' },
        { name: 'PATH', value: 'x' },                        // 大写名 → env 规则
        { name: 'stack', value: 'at C:\\Users\\me\\a.js', kind: 'path' },
        { name: 'note', value: 'see /home/me/x' },
        { name: 'safe', value: 'nothing here' },
      ],
    },
  })
  const redacted = p.redact.map((r) => r.name)
  assert.ok(redacted.includes('HOME'))
  assert.ok(redacted.includes('PATH'))
  assert.ok(redacted.includes('stack'))
  assert.ok(redacted.includes('note'), '正文里的绝对路径也要被脱敏')
  assert.ok(!redacted.includes('safe'), '不含敏感内容的普通字段不该被动')
})

test('④ ★★ 超上限时**不放宽上限**（放宽的代价是磁盘）', () => {
  const p = planCrashReport({
    consent: consent({ 'crash-local': 'granted' }),
    payload: { bytes: 10 ** 9 },
  })
  assert.equal(p.captureLocal, false)
  const f = p.findings.find((x) => x.code === CRASH_CODES.OVERSIZED)
  assert.ok(f, '必须报超限')
  assert.ok(f.cap < f.bytes)
})

test('④ ★★ 带脱敏映射表的报告**不算**已脱敏（原文与占位符的对应关系就在包里）', () => {
  const r = assertRedacted({ includeMap: true, redact: [{ name: 'a', replacement: '<x>' }] })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /映射/)
})

test('④ ★★ 脱敏后仍有残留 → 不算已脱敏', () => {
  const r = assertRedacted({ redact: [{ name: 'a', replacement: '<x>' }], residual: [{ name: 'HOME', value: 'x' }] })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /残留/)
})

test('④ ★ 脱敏项必须给替换值（"删掉字段"与"替换成占位符"不是同一件事）', () => {
  assert.equal(assertRedacted({ redact: [{ name: 'a' }] }).ok, false)
  assert.equal(assertRedacted({ redact: [{ name: 'a', replacement: '<x>' }] }).ok, true)
})

test('④ ★ 引用不存在的排除规则要报出来', () => {
  const r = assertRedacted({ drop: [{ name: 'a', rule: '不存在的规则', why: '理由' }] })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /不存在的规则/)
})

// ---------------------------------------------------------------- ★★ 撤销

test('⑤ ★★ 撤销产出**待处理清单**，而不是只改一个字段', () => {
  // 用户点"不再同意"时，心里想的是"把我机器上那些东西处理掉"。
  const onDisk = [
    { id: 'r1', purpose: 'crash-local', path: '/x/r1.json' },
    { id: 'r2', purpose: 'crash-local', path: '/x/r2.json' },
  ]
  const r = revokeConsent({ consent: consent({ 'crash-local': 'denied' }), onDisk })
  assert.equal(r.clean, false)
  assert.equal(r.stale.length, 2)
  assert.ok(r.findings.some((f) => f.code === CRASH_CODES.STALE_AFTER_REVOKE))
  assert.match(r.stale[0].reason, /拒绝/)
})

test('⑤ ★★ 从未同意过（unknown）的磁盘报告也进待处理清单', () => {
  // "没说"不是"可以留着"。
  const r = revokeConsent({ consent: DEFAULT_CONSENT, onDisk: [{ id: 'r', purpose: 'crash-upload', path: '/x/r' }] })
  assert.equal(r.stale.length, 1)
  assert.match(r.stale[0].reason, /从未获同意/)
})

test('⑤ ★★ 仍然同意的事项，磁盘上的报告**不**进待处理清单', () => {
  const r = revokeConsent({
    consent: consent({ 'crash-local': 'granted' }),
    onDisk: [{ id: 'r', purpose: 'crash-local', path: '/x/r' }],
  })
  assert.equal(r.clean, true)
  assert.equal(r.stale.length, 0)
})

test('⑤ ★★ 撤销后**可以**实现"清干净"：清空磁盘后 clean 变 true', () => {
  const before = revokeConsent({ consent: consent({}), onDisk: [{ id: 'r', purpose: 'crash-local', path: '/x/r' }] })
  assert.equal(before.clean, false)
  const after = revokeConsent({ consent: consent({}), onDisk: [] })
  assert.equal(after.clean, true)
})

// ---------------------------------------------------------------- 边界

test('⑥ ★ 返回对象被冻结', () => {
  const p = planCrashReport({ consent: consent({ 'crash-local': 'granted' }) })
  assert.ok(Object.isFrozen(p))
  assert.ok(Object.isFrozen(p.findings))
  assert.throws(() => { 'use strict'; p.captureLocal = true }, TypeError)
})

test('⑥ ★ 缺省参数不抛（崩溃路径上抛异常是最坏的结果）', () => {
  const p = planCrashReport({})
  assert.equal(p.captureLocal, false)
  assert.equal(p.transmit, false)
  const r = revokeConsent({})
  assert.equal(r.clean, true)
})

test('⑥ ★ `assertRedacted` 对空报告判 ok（没有可脱敏的东西不是失败）', () => {
  assert.equal(assertRedacted({}).ok, true)
  assert.equal(assertRedacted().ok, true)
})
