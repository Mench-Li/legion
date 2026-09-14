// product/launcher/secrets-check.test.mjs
// ============================================================================
// 密钥库自检接进启动流程（PRT-257 的「自检」+ PRT-254 的生产调用方）
//
// 这一组守住的核心是一条**分界**：
//
//   阻止启动的，是「启动本身会制造新的危险」；
//   只提醒的，是「现在就不工作」——那不该阻止启动。
//
// 两种错法的代价不对称：
//   - 该阻止却只提醒 → 启动成功，然后**静默地不安全**
//   - 该提醒却阻止   → **用户被锁在门外**：他正是要打开界面去修这个问题，
//                       而界面起不来了
//
// 所以每一条等级都单独钉一个用例。少了任何一个，这条分界就会在某次改动里
// 悄悄偏向一边，而**两种偏向都不会报错**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SECRETS_DIAGNOSTIC_CODES,
  runSecretsCheck,
  secretsDiagnostics,
} from './secrets-check.mjs'

const codesOf = (list) => list.map((d) => d.code)
const severityOf = (list, code) => list.find((d) => d.code === code)?.severity ?? null

/** 造一个自检结果（字段与 `openProductSecrets` 的产物一致）。 */
const check = (fields) => ({ ok: false, code: null, message: '', acl: null, aclVerified: false, ...fields })

// ------------------------------------------------------------------ 阻止启动的两类

test('**明文后端 → error**（启动会制造新的危险：任何一次录入都明文写盘）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_STORE_UNPROTECTED', message: '后端未提供受保护存储（scheme=plaintext）',
  }))
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.UNPROTECTED), 'error')
  // 理由必须写在文案里：为什么这一类是 error 而那几类只是 warn
  assert.match(diags[0].message, /制造新的危险|明文写盘/)
})

test('**密钥库位置不合法 → error**（结构性：备份会带走 / 升级会替换 / 缓存会删掉）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_LAYOUT_BLOCKED', message: '密钥库位于数据目录内',
  }))
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.PLACEMENT), 'error')
  assert.match(diags[0].message, /结构性问题/)
})

// ------------------------------------------------------------------ 只提醒的几类

test('**打不开 → warn**（修它的地方也在被启动的东西里，挡住会让人连修的机会都没有）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_STORE_OPEN_FAILED', message: '密钥库文件损坏',
  }))
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED), 'warn')
  assert.match(diags[0].message, /Workbench|修它的地方/)
})

test('**平台不支持受保护存储 → warn**（这台机器上云模型用不了，但产品本身该能起）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_STORE_UNSUPPORTED_PLATFORM', message: '本平台尚未实现',
  }))
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.UNSUPPORTED_PLATFORM), 'warn')
})

test('**ACL 过宽 → warn**（危险是已经存在的，不是启动制造的）', () => {
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: false,
    acl: { ok: false, code: 'ACL_TOO_PERMISSIVE', message: 'BUILTIN\\Users 可读' },
  }))
  // ok:true 但 ACL 未通过 → 必须有一条 warn，**不能静默**
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.ACL_TOO_PERMISSIVE), 'warn')
  assert.equal(diags.filter((d) => d.severity === 'error').length, 0, 'ACL 不该阻止启动')
})

test('**ACL 查不出来 → 仍然有一条 warn**（"没查过"不等于"是安全的"）', () => {
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: false,
    acl: { ok: false, code: 'ACL_UNVERIFIABLE', message: '没有 icacls runner' },
  }))
  assert.equal(severityOf(diags, SECRETS_DIAGNOSTIC_CODES.ACL_UNVERIFIABLE), 'warn')
  assert.match(diags[0].message, /没查过.*不等于.*安全/)
})

test('自检完全通过且 ACL 已验证 → 零诊断（不是一条"OK"的噪音）', () => {
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: true, acl: { ok: true, code: 'ACL_OK', message: '仅所有者' },
  }))
  assert.deepEqual(diags, [])
})

test('**文件还没创建 → 零告警**（否则全新机器上每次启动都报一条永远不对的告警）', () => {
  // 密钥库文件要到第一次写入密钥时才存在。若把 `ACL_NOT_CREATED` 归成
  // "未验证"，这条告警会在**每一台新机器、每一次启动**上出现，
  // 而它每次都说得不对——没有文件，就没有暴露面。
  // **一条永远不对的告警，和没有告警，是同一件事。**
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: false, aclExists: false,
    acl: { ok: false, code: 'ACL_NOT_CREATED', message: '密钥库文件尚未创建' },
  }))
  assert.deepEqual(diags, [], '文件不存在时不该有 ACL 告警')
})

test('**文件存在但查不出来 → 必须有告警**（与"还没创建"必须分开）', () => {
  // 这一条是上一条的对照：两者都 `aclVerified: false`，
  // 但一个是"没什么可保护的"，另一个是"有文件而我们不知道它安不安全"。
  // 少了大意就是漏报，少了这一条就是永远误报。
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: false, aclExists: true,
    acl: { ok: false, code: 'ACL_UNVERIFIABLE', message: '输出看不懂' },
  }))
  assert.equal(diags.length, 1)
  assert.equal(diags[0].code, SECRETS_DIAGNOSTIC_CODES.ACL_UNVERIFIABLE)
})

test('自检没有返回结果 → warn（**未验证**，不是通过）', () => {
  for (const bad of [null, undefined, 42, 'x']) {
    const diags = secretsDiagnostics(bad)
    assert.equal(diags.length, 1)
    assert.equal(diags[0].severity, 'warn')
    assert.match(diags[0].message, /未验证/)
  }
})

test('整体失败时，ACL 的问题也一并报出来（失败原因可能不止一个）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_STORE_OPEN_FAILED', message: '损坏',
    acl: { ok: false, code: 'ACL_TOO_PERMISSIVE', message: 'Users 可读' },
  }))
  assert.ok(codesOf(diags).includes(SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED))
  assert.ok(codesOf(diags).includes(SECRETS_DIAGNOSTIC_CODES.ACL_TOO_PERMISSIVE))
})

test('**只有**那两类是 error——这条分界被完整枚举', () => {
  // 把所有可能的自检码过一遍，断言 error 的集合恰好是那两个。
  // 将来新增一个码时，这个用例会强迫作者明确回答"它该阻止启动吗"。
  const allCodes = [
    'SECRETS_LAYOUT_BLOCKED', 'SECRETS_STORE_UNPROTECTED', 'SECRETS_STORE_UNSUPPORTED_PLATFORM',
    'SECRETS_STORE_OPEN_FAILED',
  ]
  const errors = allCodes.filter((code) =>
    secretsDiagnostics(check({ ok: false, code, message: 'x' })).some((d) => d.severity === 'error'))
  assert.deepEqual(errors.sort(), ['SECRETS_LAYOUT_BLOCKED', 'SECRETS_STORE_UNPROTECTED'].sort())
})

// ------------------------------------------------------------------ runSecretsCheck

test('runSecretsCheck 把注入的自检结果翻成诊断', async () => {
  const r = await runSecretsCheck({
    layout: { platform: 'win32' },
    openSecrets: async () => check({ ok: true, aclVerified: true, acl: { ok: true, code: 'ACL_OK' } }),
  })
  assert.deepEqual(r.diagnostics, [])
  assert.equal(r.check.ok, true)
})

test('**自检本身抛异常 → 一条 warn，而不是未捕获的拒绝**', async () => {
  // 一个体检程序崩溃不该让产品起不来，但它必须被看见（不能静默）。
  const r = await runSecretsCheck({
    layout: { platform: 'win32' },
    openSecrets: async () => { throw Object.assign(new Error('boom'), { name: 'SecretStoreError' }) },
  })
  // **恰好一条**：自检整个崩了的时候，再叠一条"ACL 未验证"只是噪音，
  // 而噪音会把真正的那条信息稀释掉。"没有 ACL 信息"不等于"ACL 没通过"。
  assert.equal(r.diagnostics.length, 1)
  assert.equal(r.diagnostics[0].severity, 'warn')
  assert.match(r.diagnostics[0].message, /未验证|自检过程本身出错/)
  assert.ok(!r.diagnostics[0].message.includes('boom'), '不原样带出底层 message')
})

test('自检短路（还没到 ACL 那一步）时不产生 ACL 诊断', () => {
  // 位置不合法 / 打不开时，`acl` 是 null——那不是"ACL 没通过"，是"没有这项信息"。
  for (const code of ['SECRETS_LAYOUT_BLOCKED', 'SECRETS_STORE_OPEN_FAILED']) {
    const diags = secretsDiagnostics(check({ ok: false, code, message: 'x', acl: null }))
    assert.equal(diags.length, 1, `${code} 应恰好产生一条诊断`)
    assert.equal(diags[0].severity, code === 'SECRETS_LAYOUT_BLOCKED' ? 'error' : 'warn')
  }
})

test('runSecretsCheck 把 requireProtected 传下去（开发机放开的决定是显式的）', async () => {
  const seen = []
  await runSecretsCheck({
    layout: { platform: 'win32' },
    requireProtected: false,
    openSecrets: async (args) => { seen.push(args); return check({ ok: true, aclVerified: true }) },
  })
  assert.equal(seen[0].requireProtected, false)
  assert.equal(seen[0].platform, 'win32')
})

test('诊断对象不可变（避免下游顺手改写等级）', () => {
  const diags = secretsDiagnostics(check({ ok: false, code: 'SECRETS_STORE_OPEN_FAILED', message: 'x' }))
  assert.equal(Object.isFrozen(diags), true)
  assert.throws(() => { diags.push({}) }, TypeError)
})

// ═══════════════════════════════════════════════════════════════════════════
// DSH 只读回退来源的读数 → 诊断（PRT-509 路线 A′）
// ═══════════════════════════════════════════════════════════════════════════
//
// 这一段的**判据**与 ACL 那一段逐字同构，理由也同构：
//
//   | state | 诊断 | 为什么 |
//   | --- | --- | --- |
//   | `absent` | 无 | 从没用过 DSH 的 Models 页时就是这个形状，是常态 |
//   | `loaded` | 无 | 读得懂就没什么可说的 |
//   | `unrecognized` | warn | 文件在、不在认识的子集里：**要用户动手** |
//   | `unreadable` | warn | 文件在、读不出来：同上 |
//
// 后两者**必须不同码**：一个要用户去改文件写法，一个要用户去查权限/磁盘。
// 把前者塌成后者，用户会去查一个并不存在的权限问题。

/** 造一份带回退来源读数的自检结果。 */
const withFallback = (state, code = null, ok = true) => check({
  ok, aclVerified: true, acl: { ok: true, code: 'ACL_OK' }, fallback: { state, code },
})

test('⑦ `absent` 与 `loaded` 都**不产生**诊断（常态与"没问题"都不该占字）', () => {
  for (const state of ['absent', 'loaded']) {
    assert.deepEqual(secretsDiagnostics(withFallback(state)), [],
      `${state} 不该产生诊断`)
  }
})

test('⑦ **`unrecognized` → warn，且与 `unreadable` 是不同码**', () => {
  const bad = secretsDiagnostics(withFallback('unrecognized', 'DSH_CREDENTIALS_QUOTED_SCALAR'))
  assert.equal(bad.length, 1)
  assert.equal(bad[0].severity, 'warn')
  assert.equal(bad[0].code, SECRETS_DIAGNOSTIC_CODES.DSH_CREDENTIALS_UNRECOGNIZED)
  // 具名码必须出现在文案里：不说"哪一类不认识"，用户只能靠猜。
  assert.match(bad[0].message, /DSH_CREDENTIALS_QUOTED_SCALAR/)
  // "整份被拒绝"而不是"少读了几条"——这两句话的下一步动作完全不同。
  assert.match(bad[0].message, /整份被拒绝/)

  const unreadable = secretsDiagnostics(withFallback('unreadable', 'DSH_CREDENTIALS_UNREADABLE'))
  assert.equal(unreadable.length, 1)
  assert.equal(unreadable[0].code, SECRETS_DIAGNOSTIC_CODES.DSH_CREDENTIALS_UNREADABLE)
  // ★ 两个码**不同**：否则"看过了，它不在子集里"会看起来像"根本没看到"。
  assert.notEqual(unreadable[0].code, bad[0].code)
})

test('⑦ ★ 回退来源坏了**不阻止启动**：两种状态都是 warn，没有 error', () => {
  // 回退来源是**附带的便利**——Legion 自己的库仍然是唯一权威的写入路径，
  // 也是第一顺位。把它判成 error 会让一个附属功能把用户锁在门外。
  for (const state of ['unrecognized', 'unreadable']) {
    const diags = secretsDiagnostics(withFallback(state, 'X'))
    assert.equal(diags.length, 1)
    assert.equal(diags[0].severity, 'warn', `${state} 不得判成 error`)
    assert.ok(!diags.some((d) => d.severity === 'error'))
  }
})

test('⑦ `fallback: null`（这次没接）与 `absent`（接了、文件不在）**都不产生诊断**', () => {
  // 两者是不同的事实，但两者都不该说话——沉默在这里说的是"这一项不适用"。
  // 把它们变成一个值会丢掉"到底接没接"这条信息（product/secrets.mjs 里保留着）。
  assert.deepEqual(secretsDiagnostics(check({ ok: true, aclVerified: true, fallback: null })), [])
  assert.deepEqual(secretsDiagnostics(withFallback('absent')), [])
})

test('⑦ 回退来源的读数在**失败分支上也要报**（失败原因可能不止一个）', () => {
  const diags = secretsDiagnostics(check({
    ok: false, code: 'SECRETS_STORE_OPEN_FAILED', message: '损坏',
    acl: { ok: false, code: 'ACL_TOO_PERMISSIVE', message: 'Users 可读' },
    fallback: { state: 'unrecognized', code: 'DSH_CREDENTIALS_NO_VERSION' },
  }))
  const codes = codesOf(diags)
  assert.ok(codes.includes(SECRETS_DIAGNOSTIC_CODES.OPEN_FAILED))
  assert.ok(codes.includes(SECRETS_DIAGNOSTIC_CODES.ACL_TOO_PERMISSIVE))
  assert.ok(codes.includes(SECRETS_DIAGNOSTIC_CODES.DSH_CREDENTIALS_UNRECOGNIZED))
})

test('⑦ 回退来源的读数里**没有**密钥值（诊断会进日志与诊断包）', () => {
  const LEAK = 'sk-DO-NOT-LEAK-0123456789'
  const diags = secretsDiagnostics(check({
    ok: true, aclVerified: true,
    fallback: { state: 'unrecognized', code: 'DSH_CREDENTIALS_QUOTED_SCALAR', file: `C:\\Users\\${LEAK}\\.dsh` },
  }))
  const surface = JSON.stringify(diags)
  assert.ok(!surface.includes(LEAK), `值泄漏进了诊断：${surface}`)
})

test('⑦ runSecretsCheck 把回退来源的路径与 IO 一起传下去', async () => {
  const seen = []
  await runSecretsCheck({
    layout: { platform: 'win32' },
    dshCredentialsFile: 'C:\\Users\\alice\\.dsh\\.credentials.yaml',
    dshCredentialsIo: { readFile: async () => '' },
    openSecrets: async (args) => { seen.push(args); return check({ ok: true, aclVerified: true }) },
  })
  assert.equal(seen[0].dshCredentialsFile, 'C:\\Users\\alice\\.dsh\\.credentials.yaml')
  assert.equal(typeof seen[0].dshCredentialsIo.readFile, 'function')
  // 缺省不接：与这一批之前逐字相同。
  const none = []
  await runSecretsCheck({
    layout: { platform: 'win32' },
    openSecrets: async (args) => { none.push(args); return check({ ok: true, aclVerified: true }) },
  })
  assert.equal(none[0].dshCredentialsFile, null)
  assert.equal(none[0].dshCredentialsIo, null)
})
