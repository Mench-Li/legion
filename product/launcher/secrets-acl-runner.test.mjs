// product/launcher/secrets-acl-runner.test.mjs
// ============================================================================
// PRT-509 缺口 B1 的判据：密钥库 ACL 的 runner 与 owner 在**生产路径上真的存在**。
//
// 这一组要验的**不是** `security/secrets/acl.mjs` 会不会判 ACL —— 那件事
// 它自己的用例已经验过了，而且是绿的。要验的是另一件事：
//
//   > `launcher.mjs` 里那两行 `secretsRun = null` / `secretsOwner = null`
//   > 曾经**没有任何生产调用方给过值**，于是 `inspectFileAcl` 每次都走
//   > `ACL_NO_RUNNER`、`hardenFileAcl` 每次都报"不知道文件所有者"。
//
// 一个"判据齐全、用例全绿、而生产里恒为没查过"的访问控制检查，
// 与一个不存在的访问控制检查，在**被保护的文件**上是同一个东西。
//
// 用例分三层：
//   ① 纯函数层：`resolveSecretsOwner` 的四种读数（win32 成功 / 没 runner /
//      whoami 失败 / posix 不适用）——它们各自要落回**不同**的告警；
//   ② 真进程层：在真 win32 上用真 `whoami` 与真 `icacls` 走一遍
//      inspect → harden → 复验。这一层是本文件存在的主要理由：
//      前一层全绿也可能 runner 的根本不在 PATH 上；
//   ③ 接线层：`launcher.mjs` 的默认分支**真的会**去解析（结构级对照），
//      否则"新增了一个好用的解析器"与"生产里仍然恒为 null"是同一条读数。
// ============================================================================
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACL_COMMAND_TIMEOUT_MS,
  createAclRunner,
  resolveSecretsAcl,
  resolveSecretsOwner,
} from './secrets-acl-runner.mjs'
import { ACL_CODES, hardenFileAcl, inspectFileAcl } from '../../security/secrets/acl.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const scratch = []
function tmpDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `legion-acl-${tag}-`))
  scratch.push(d)
  return d
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

/** 一个可控的假 runner：按命令名给不同的 stdout。 */
function fakeRunner(map) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    const v = map[cmd]
    if (v === undefined) return { status: 1, stdout: '', stderr: 'not found', error: null }
    return typeof v === 'function' ? v(args) : v
  }
  return { run, calls }
}

// ---------------------------------------------------------------- ① 纯函数层

test('① win32 + whoami 成功 ⇒ 原样返回操作系统给的身份', async () => {
  const { run, calls } = fakeRunner({ whoami: { status: 0, stdout: 'AMENCH\\x\r\n', stderr: '' } })
  const r = await resolveSecretsOwner({ platform: 'win32', run })
  assert.equal(r.owner, 'AMENCH\\x', '身份没有被原样取回（去掉了 \\r\\n）')
  assert.equal(r.source, 'whoami')
  assert.equal(r.reason, null)
  // ★ 必须调的是 `whoami` 本身。调 `icacls` 猜、或者读环境变量，
  //   都会在这里露出来——而"读环境变量"是这条缺口原本的失败方向。
  assert.deepEqual(calls, [['whoami']])
})

test('② win32 + 没有 runner ⇒ owner 为 null 且**不**回落环境变量', async () => {
  // 关键：把环境变量**设上**。若实现回落到了 `USERNAME`，这条会拿到值。
  const saved = { u: process.env.USERNAME, d: process.env.USERDOMAIN }
  process.env.USERNAME = 'ATTACKER'
  process.env.USERDOMAIN = 'EVIL'
  try {
    const r = await resolveSecretsOwner({ platform: 'win32', run: null })
    assert.equal(r.owner, null,
      'owner 回落到了环境变量 —— 环境变量可以被继承/覆盖，'
      + '而用猜出来的主体去 icacls /grant:r 是"把权限给错人"，那个动作没有返回值能告诉你给错了')
    assert.equal(r.source, 'no-runner')
    assert.match(r.reason, /runner/)
  } finally {
    if (saved.u === undefined) delete process.env.USERNAME; else process.env.USERNAME = saved.u
    if (saved.d === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = saved.d
  }
})

test('③ win32 + whoami 非零退出/空输出 ⇒ owner 为 null 且带原因', async () => {
  for (const [label, res] of [
    ['非零退出', { status: 1, stdout: '', stderr: 'denied', error: null }],
    ['零退出但空输出', { status: 0, stdout: '   \r\n', stderr: '' }],
    ['超时（status null + error）', { status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }],
  ]) {
    const { run } = fakeRunner({ whoami: res })
    const r = await resolveSecretsOwner({ platform: 'win32', run })
    assert.equal(r.owner, null, `${label}：owner 不该有值`)
    assert.equal(r.source, 'whoami-failed', `${label}：来源没有被标成失败`)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${label}：没有原因`)
  }
})

test('④ whoami 抛异常 ⇒ 折成读数而不是抛出去（体检不该让产品起不来）', async () => {
  const run = async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }) }
  const r = await resolveSecretsOwner({ platform: 'win32', run })
  assert.equal(r.owner, null)
  assert.equal(r.source, 'whoami-failed')
  assert.match(r.reason, /TypeError/)
})

test('⑤ posix ⇒ owner 不适用（chmod 600 不需要 owner，给一个值只会制造错觉）', async () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const { run, calls } = fakeRunner({ whoami: { status: 0, stdout: 'root\n', stderr: '' } })
    const r = await resolveSecretsOwner({ platform, run })
    assert.equal(r.owner, null, `${platform}：不该返回 owner`)
    assert.equal(r.source, 'not-applicable')
    assert.equal(calls.length, 0, `${platform}：不该为此 spawn 任何进程`)
  }
})

test('⑥ runner 形状与 acl.mjs 期望的一致，且**永不抛**', async () => {
  // 命令不存在：spawnSync 会返回 error，而不是抛。
  const run = createAclRunner({
    spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }),
  })
  const r = await run('icacls', ['C:\\nope'])
  assert.equal(r.status, null)
  assert.equal(r.error, 'ENOENT')
  assert.equal(typeof r.stdout, 'string', 'acl.mjs 读 res.stdout；不是字符串会让它把有输出当成无输出')

  // 超时上界必须是**有限正数**：一个不响应的网络路径不能把启动卡住。
  assert.ok(Number.isFinite(ACL_COMMAND_TIMEOUT_MS) && ACL_COMMAND_TIMEOUT_MS > 0)
})

test('⑦ runner 与 owner 共用同一个 runner（分成两个会验出物理上不存在的组合）', async () => {
  const r = await resolveSecretsAcl({
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: 'AMENCH\\x\n', stderr: '' }),
  })
  assert.equal(r.owner, 'AMENCH\\x')
  assert.equal(typeof r.run, 'function')
  assert.equal(r.ownerSource, 'whoami')
  // 同一个 `run` 既答 whoami 又答 icacls —— 只有一个 runner。
  const viaRun = await r.run('whoami', [])
  assert.equal(viaRun.status, 0)
})

// ---------------------------------------------------------------- ② 真进程层

const IS_WIN32 = process.platform === 'win32'

test('⑧ ★ 真 whoami：这台机器上问得出当前用户，且形状是 DOMAIN\\user', { skip: !IS_WIN32 ? '仅 win32' : false }, async () => {
  const r = await resolveSecretsAcl({ platform: 'win32' })
  assert.equal(r.ownerSource, 'whoami',
    `真 whoami 没问出身份（${r.ownerReason}）—— 生产上 ACL 会落回"未加固 + 一条告警"，`
    + '而那条告警正是这条缺口原本的形态')
  assert.ok(typeof r.owner === 'string' && r.owner.length > 0)
  assert.ok(r.owner.includes('\\'),
    `whoami 输出不是 DOMAIN\\user 形状：${r.owner}。icacls 需要这个形状才能授权`)
})

test('⑨ ★ 真 icacls：inspect → harden → 复验，整条链子在真文件上跑通', { skip: !IS_WIN32 ? '仅 win32' : false }, async () => {
  const dir = tmpDir('harden')
  const file = join(dir, 'credentials.json')
  writeFileSync(file, '{"a":1}', 'utf8')

  const { run, owner } = await resolveSecretsAcl({ platform: 'win32' })
  assert.ok(owner !== null, '没有 owner 就没法验加固')

  // 加固前先看一眼：这一步同时验证 `inspectFileAcl` 在真 icacls 输出上
  // 真的解析出了条目（否则 `ACL_UNVERIFIABLE` 会让下面的断言无从判断）。
  const before = await inspectFileAcl({ file, platform: 'win32', run, owner })
  assert.notEqual(before.code, ACL_CODES.NO_RUNNER, 'runner 没有被认出来')
  assert.notEqual(before.code, ACL_CODES.UNVERIFIABLE,
    `真 icacls 的输出解析不出任何条目（${before.message}）—— 那意味着生产上的检查永远是"未验证"`)
  assert.notEqual(before.code, ACL_CODES.NOT_CREATED, '文件明明刚写出来')

  const hardened = await hardenFileAcl({ file, platform: 'win32', run, owner })
  assert.equal(hardened.ok, true,
    `真加固失败：${hardened.message}（执行过：${JSON.stringify(hardened.actions)}）`)
  // ★ 加固**自己会复验**（`hardenFileAcl` 的 `verified`）。这里再独立查一次：
  //   "它说自己验过了"与"现在真的是紧的"是两件事，而只有后者是我们想要的。
  const after = await inspectFileAcl({ file, platform: 'win32', run, owner })
  assert.equal(after.ok, true, `加固后复查仍不通过：${after.message}`)
  assert.equal(after.code, ACL_CODES.OK)
  // 反向对照：`Users` 这类宽主体必须**不在**授权清单里。
  const names = (after.principals ?? []).map((p) => String(p.principal ?? p).toLowerCase())
  assert.equal(names.some((n) => n.includes('users')), false,
    `加固后仍有宽主体在授权清单里：${names.join(' / ')}`)
})

test('⑩ ★ 真 icacls 的失败方向：文件不存在时是 NOT_CREATED，**不是** "通过"', { skip: !IS_WIN32 ? '仅 win32' : false }, async () => {
  const dir = tmpDir('missing')
  const { run, owner } = await resolveSecretsAcl({ platform: 'win32' })
  const r = await inspectFileAcl({ file: join(dir, 'nope.json'), platform: 'win32', run, owner })
  assert.equal(r.code, ACL_CODES.NOT_CREATED)
  assert.equal(r.ok, false,
    '"文件还没创建"被当成了"检查通过" —— 那会让首次安装上这条检查永远绿，'
    + '而它绿的时机恰好是**什么都还没保护**的时候')
})

// ---------------------------------------------------------------- ③ 接线层

test('⑪ 接线：launcher 的默认分支真的会解析 runner/owner（结构级对照）', () => {
  const src = readFileSync(join(HERE, 'launcher.mjs'), 'utf8')
  // 必须是"两者都为 null 时解析"，否则注入的假 runner 会被真 whoami 覆盖。
  assert.match(src, /if \(effectiveRun === null && effectiveOwner === null\)/,
    'launcher 没有"没注入就用生产默认"的那一步 —— 那正是缺口的形态：'
    + '声明里有入参、生产调用方永远不给值')
  assert.match(src, /resolveSecretsAcl/, 'launcher 没有调用解析器')
  // 解析结果必须真的**传下去**（解析了但没用，与没解析是同一件事）。
  assert.match(src, /run: effectiveRun,[\s\S]{0,200}?owner: effectiveOwner,/,
    '解析出来的 runner/owner 没有传给 runSecretsCheck')
  // 解析失败不抛：外面有 try/catch，里面也要有自己的兜底读数。
  assert.match(src, /ownerSource: 'resolve-failed'/, '解析失败没有兜底读数')
  // ★ owner 没问出来要**自己占一行**：一句笼统的 "HARDEN_FAILED（不知道所有者）"
  //   会把"环境里问不出身份"与"加固真的失败了"说成同一件事。
  assert.match(src, /SECRETS_ACL_OWNER_UNRESOLVED/,
    'owner 问不出来时没有独立诊断码 —— 读诊断的人分不出该去查 PATH 还是查 icacls')
})

test('⑫ 接线：`null` 的语义在声明处被写清楚了（不是"没有"，而是"用生产默认"）', () => {
  const src = readFileSync(join(HERE, 'launcher.mjs'), 'utf8')
  const decl = /secretsRun = null,\s*\n\s*secretsOwner = null,/.exec(src)
  assert.ok(decl !== null, '找不到那两个声明的默认值')
  // 声明之前必须有一段说明"null 现在是'用默认'"的注释。
  const before = src.slice(Math.max(0, decl.index - 1400), decl.index)
  assert.match(before, /PRT-509 缺口 B1/, '声明处没有记下这条缺口的编号')
  assert.match(before, /生产默认/, '声明处没有说清 null 的新语义')
})
