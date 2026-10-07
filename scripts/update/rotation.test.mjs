// 公钥轮换的端到端判据（设计 §5 line 128 + §10 验收表第 8 行
// 「错误发布撤回、清单续签、公钥轮换 → 旧客户端正确消费」）。
//
// 这一条守的是**轮换这条路真的通**，而不是"每个函数各自对"。它走的顺序与
// 设计规定的一致：
//
//   ① 旧钥匙 A 在信任表里（sequence=1）
//   ② 用 **A 的私钥**签一份增量，add 新钥匙 B     → `keygen rotate`
//   ③ 把增量应用到随包信任表 → sequence=2，表里 {A, B}  → `keygen apply`
//   ④ **用 B 的私钥**签一份通道清单，交给一个"随包信任表来自第 ③ 步"的
//      客户端验签 → 必须通过
//   ⑤ 负向：用一把**不在表里**的钥匙 C 签同样的清单 → 必须被拒
//   ⑥ 负向：把第 ② 步的增量**重放**一次（同 sequence）→ 必须被拒
//   ⑦ 负向：用 B 的私钥去签增量（新钥匙不能给自己背书）→ 必须被拒
//
// ★ 第 ⑤⑥⑦ 条是必要的对照：没有它们，"步骤 ④ 通过"可能只是因为
//   "什么都接受"。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENVELOPE_FORMATS, createTrustStore, generateReleaseKeyPair, signEnvelope,
  serializeEnvelope, verifyEnvelope,
} from '../../product/update/envelope.mjs'
import { buildFeedPayload } from '../../product/update/feed.mjs'
import { loadTrustStore } from '../../product/update/config.mjs'
import { main as keygenMain } from './keygen.mjs'
import { applyTrustUpdateToTable, buildTrustTable, readTrustTable, writeTrustTable } from './trust-file.mjs'

// ★ 时间基准取**本机现在**，不是写死的时刻：`keygen apply` 那条命令内部用
//   `Date.now()`，写死一个未来时刻会被时钟偏移判据（fail-closed）拒掉——
//   那个拒绝是**对的**，所以用例要顺着它，而不是绕开它。
const NOW = Date.now()
const HOUR = 3600_000

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-rotate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root }
}

/**
 * 调用 `keygen` 的 `main` 并**恢复** `process.exitCode`。
 *
 * ★ `keygen.mjs` 的 `fail()` 除了返回 `null`，还会把 `process.exitCode` 置成 2
 *   ——对一个 CLI 这是对的（进程要以非零码退出）。但它被**同进程**调用时会
 *   污染整个测试进程：`node --test` 看到退出码 2 就把**整个文件**报成失败，
 *   而里面两条用例其实都过了。
 *
 *   症状值得记一下：报告里那一行是"文件失败"而不是"用例失败"，于是它看起来像
 *   "用例根本没跑"——而实际上跑过了、也断言过了。
 *
 *   > 一个会污染宿主进程状态的被测对象，会在**测试框架那一层**留下
 *   > 与它自己的正确性无关的痕迹。
 */
function keygen(argv) {
  const saved = process.exitCode
  try {
    return keygenMain(argv)
  } finally {
    process.exitCode = saved
  }
}

test('公钥轮换：旧钥匙签名预置新公钥 → 新钥匙签的清单能被接受', async (t) => {
  const ctx = setup(t)
  const a = generateReleaseKeyPair({ keyId: 'release-a' })
  const b = generateReleaseKeyPair({ keyId: 'release-b' })
  const c = generateReleaseKeyPair({ keyId: 'not-trusted' })

  // ① 初始随包信任表只有 A。
  const trustPath = join(ctx.root, 'update-trust.json')
  writeTrustTable(trustPath, buildTrustTable({
    sequence: 1,
    keys: [{ keyId: 'release-a', publicKeyPem: a.publicKeyPem }],
  }))
  const initial = readTrustTable(trustPath)
  assert.equal(initial.ok, true)
  assert.deepEqual(initial.table.keys.map((k) => k.keyId), ['release-a'])

  // ② 用 **A 的私钥**签增量。
  const updatePath = join(ctx.root, 'trust-update.json')
  const rotateCode = keygen([
    'rotate',
    '--key-id', 'release-a',
    '--private-key', join(ctx.root, 'a.key.pem'),
    '--add-key-id', 'release-b',
    '--add-public-key', join(ctx.root, 'b.pub.pem'),
    '--sequence', '2',
    '--issued-at', new Date(NOW - HOUR).toISOString(),
    '--expires-at', new Date(NOW + 24 * HOUR).toISOString(),
    '--out', updatePath,
  ])
  // 私钥/公钥文件在上面还没写，这里补上再重跑（脚本要求文件存在）。
  assert.equal(rotateCode, null, '缺文件时应当明确失败，而不是产出一份没签名的增量')

  writeFileSync(join(ctx.root, 'a.key.pem'), a.privateKeyPem, 'utf8')
  writeFileSync(join(ctx.root, 'b.pub.pem'), b.publicKeyPem, 'utf8')
  assert.equal(keygen([
    'rotate',
    '--key-id', 'release-a',
    '--private-key', join(ctx.root, 'a.key.pem'),
    '--add-key-id', 'release-b',
    '--add-public-key', join(ctx.root, 'b.pub.pem'),
    '--sequence', '2',
    '--issued-at', new Date(NOW - HOUR).toISOString(),
    '--expires-at', new Date(NOW + 24 * HOUR).toISOString(),
    '--out', updatePath,
  ]), 0)

  // ③ 应用增量 → 新的随包信任表（这是 `apply` 这条命令的存在理由）。
  const applied = applyTrustUpdateToTable({
    table: initial.table, updateBytes: readFileSync(updatePath), nowMs: NOW,
  })
  assert.equal(applied.ok, true, applied.reason ?? '')
  assert.deepEqual(applied.added, ['release-b'])
  assert.equal(applied.previousSequence, 1)
  assert.equal(applied.table.sequence, 2)
  assert.deepEqual([...applied.table.keys.map((k) => k.keyId)].sort(), ['release-a', 'release-b'])

  const nextPath = join(ctx.root, 'update-trust.next.json')
  writeTrustTable(nextPath, applied.table)

  // ★ 客户端**真的**从这份文件读信任表（用产品代码，不自己造 store）。
  const loaded = loadTrustStore(nextPath)
  assert.equal(loaded.problems.length, 0, JSON.stringify(loaded.problems))
  assert.equal(loaded.sequence, 2)

  // ④ 用 **B 的私钥**签一份通道清单 → 必须被接受。
  const feed = (key) => serializeEnvelope(signEnvelope(buildFeedPayload({
    channel: 'internal', platform: 'win32', arch: 'x64', sequence: 3,
    issuedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    releaseId: 'rel-x', productVersion: '1.1.0',
    manifestPath: 'releases/rel-x/manifest.json', manifestSha256: 'a'.repeat(64),
  }), { privateKeyPem: key.privateKeyPem, keyId: 'release-b' }))
  const byB = verifyEnvelope(feed(b), {
    trust: loaded.store, nowMs: NOW, expectedFormat: ENVELOPE_FORMATS.FEED,
  })
  assert.equal(byB.ok, true, `轮换之后新钥匙签的清单没有被接受：${byB.reason}`)
  assert.equal(byB.keyId, 'release-b')
  // 旧钥匙在轮换窗口内仍然有效（设计要的是"预置新公钥"，不是"立刻废掉旧的"）。
  const byA = verifyEnvelope(
    serializeEnvelope(signEnvelope(buildPayloadForA(), { privateKeyPem: a.privateKeyPem, keyId: 'release-a' })),
    { trust: loaded.store, nowMs: NOW, expectedFormat: ENVELOPE_FORMATS.FEED },
  )
  assert.equal(byA.ok, true, `轮换之后旧钥匙立刻失效了：${byA.reason}`)

  // ⑤ 不在表里的钥匙 C → 必须被拒。
  const byC = verifyEnvelope(
    serializeEnvelope(signEnvelope(buildPayloadForA(), { privateKeyPem: c.privateKeyPem, keyId: 'not-trusted' })),
    { trust: loaded.store, nowMs: NOW, expectedFormat: ENVELOPE_FORMATS.FEED },
  )
  assert.equal(byC.ok, false)
  assert.equal(byC.code, 'envelope-unknown-key')

  // ⑥ 重放同 sequence 的增量 → 必须被拒（否则可以把表退回吊销之前）。
  const replay = applyTrustUpdateToTable({
    table: applied.table, updateBytes: readFileSync(updatePath), nowMs: NOW,
  })
  assert.equal(replay.ok, false, '同 sequence 的增量被重放接受了')
  assert.match(replay.reason, /不大于已接受的/)

  // ⑦ 新钥匙不能给自己背书：用 B 的私钥签 add B 的增量 → 必须被拒。
  const selfSigned = serializeEnvelope(signEnvelope({
    format: ENVELOPE_FORMATS.TRUST, sequence: 3,
    issuedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    add: [{ keyId: 'release-b', publicKeyPem: b.publicKeyPem }], revoke: [],
  }, { privateKeyPem: b.privateKeyPem, keyId: 'release-b' }))
  const selfApplied = applyTrustUpdateToTable({
    table: initial.table, updateBytes: Buffer.from(selfSigned, 'utf8'), nowMs: NOW,
  })
  assert.equal(selfApplied.ok, false, '新钥匙给自己背书居然被接受了')
})

function buildPayloadForA() {
  return buildFeedPayload({
    channel: 'internal', platform: 'win32', arch: 'x64', sequence: 4,
    issuedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    releaseId: 'rel-y', productVersion: '1.1.1',
    manifestPath: 'releases/rel-y/manifest.json', manifestSha256: 'b'.repeat(64),
  })
}

test('公钥轮换：`keygen apply` 这条命令真的把增量落到盘上（否则 rotate 没有消费者）', async (t) => {
  const ctx = setup(t)
  const a = generateReleaseKeyPair({ keyId: 'release-a' })
  const b = generateReleaseKeyPair({ keyId: 'release-b' })
  const trustPath = join(ctx.root, 'update-trust.json')
  const updatedPath = join(ctx.root, 'update-trust.new.json')
  const updatePath = join(ctx.root, 'trust-update.json')
  writeTrustTable(trustPath, buildTrustTable({
    sequence: 1, keys: [{ keyId: 'release-a', publicKeyPem: a.publicKeyPem }],
  }))
  writeFileSync(join(ctx.root, 'a.key.pem'), a.privateKeyPem, 'utf8')
  writeFileSync(join(ctx.root, 'b.pub.pem'), b.publicKeyPem, 'utf8')
  assert.equal(keygen([
    'rotate', '--key-id', 'release-a', '--private-key', join(ctx.root, 'a.key.pem'),
    '--add-key-id', 'release-b', '--add-public-key', join(ctx.root, 'b.pub.pem'),
    '--sequence', '2',
    '--issued-at', new Date(NOW - HOUR).toISOString(),
    '--expires-at', new Date(NOW + 24 * HOUR).toISOString(),
    '--out', updatePath,
  ]), 0)

  // ★ 走**命令本身**，不是直接调函数——只有这样才能证明"命令接线了"。
  assert.equal(keygen([
    'apply', '--trust', trustPath, '--update', updatePath, '--out', updatedPath,
  ]), 0)
  const written = readTrustTable(updatedPath)
  assert.equal(written.ok, true, written.reason ?? '')
  assert.equal(written.table.sequence, 2)
  assert.deepEqual([...written.table.keys.map((k) => k.keyId)].sort(), ['release-a', 'release-b'])

  // 负向：拿一份**不属于**当前表的增量去 apply（签名者不在表里）→ 必须失败。
  const c = generateReleaseKeyPair({ keyId: 'release-c' })
  const badPath = join(ctx.root, 'bad-update.json')
  writeFileSync(badPath, serializeEnvelope(signEnvelope({
    format: ENVELOPE_FORMATS.TRUST, sequence: 5,
    issuedAt: new Date(NOW - HOUR).toISOString(),
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    add: [{ keyId: 'release-c', publicKeyPem: c.publicKeyPem }], revoke: [],
  }, { privateKeyPem: c.privateKeyPem, keyId: 'release-c' })), 'utf8')
  assert.equal(keygen([
    'apply', '--trust', trustPath, '--update', badPath, '--out', join(ctx.root, 'never.json'),
  ]), null, '签名者不在信任表里的增量被接受了')
})
