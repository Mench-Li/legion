// product/update/envelope.test.mjs
// ============================================================================
// 信任根的判据（设计 §5）。这是整个更新体系里**唯一**决定"谁说的话算数"的模块，
// 而它此前**没有自己的用例文件**——它的正确性只被 `client.test.mjs` /
// `publish.test.mjs` **间接**经过。
//
// 间接经过的问题在于：它只走过"合法清单能验过"与"几种常见伪造被拒"，
// 而**密钥有效期与吊销**这三条判据（`selectKey` 的 175–183 行）一次都没被碰过。
// 而吊销恰恰是设计 §5 line 128 那条紧急路径的实现：
//
//   「换密钥需先通过旧信任根签名的客户端更新预置新公钥，再切换发布签名。
//     首期不提供远程任意替换信任根的入口；**签名私钥泄漏后的紧急恢复**保留
//     人工下载可信安装包路径。」
//
//   一句"私钥泄漏之后可以吊销它"如果没有判据守着，泄漏那天才会知道它坏没坏——
//   而那正是最不该做实验的时刻。
//
// ★ 本文件只测**判据**，不重复测"签名算法本身对不对"（那是 Node 的 crypto）。
//   重点全部在"什么情况下必须拒"，因为那些是本模块自己的逻辑。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ENVELOPE_CODES, ENVELOPE_FORMATS, createTrustStore, generateReleaseKeyPair, keyFingerprint,
  selectKey, serializeEnvelope, signEnvelope, verifyEnvelope,
} from './envelope.mjs'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const KEY = 'release-2026-a'

/** 一对固定用途的密钥（每个用例自己生成，避免用例之间共享状态）。 */
function keypair(keyId = KEY) {
  return generateReleaseKeyPair({ keyId })
}

function storeFor(keys) {
  return createTrustStore(keys)
}

/** 一份形状合法的通道清单 payload。 */
function feedPayload(overrides = {}) {
  return {
    format: ENVELOPE_FORMATS.FEED,
    channel: 'stable', platform: 'win32', arch: 'x64', sequence: 1,
    issuedAt: new Date(NOW - 3600_000).toISOString(),
    expiresAt: new Date(NOW + 7 * 86400_000).toISOString(),
    releaseId: 'r1', productVersion: '1.0.0',
    manifestPath: 'releases/r1/manifest.json', manifestSha256: 'a'.repeat(64),
    ...overrides,
  }
}

function signed(payload, keys, keyId = KEY) {
  return serializeEnvelope(signEnvelope(payload, { privateKeyPem: keys.privateKeyPem, keyId }))
}

// ---------------------------------------------------------------------------
// ① 密钥有效期：三条判据（此前一条都没有用例）
// ---------------------------------------------------------------------------

test('★★★ 密钥窗口：未生效 / 已过期 / 已吊销 三种都必须拒（设计 §5 的密钥窗口）', () => {
  const keys = keypair()
  const cases = [
    // [标签, 信任表条目上的窗口, 期望码]
    ['尚未生效', { notBeforeMs: NOW + 1000 }, ENVELOPE_CODES.KEY_NOT_YET_VALID],
    ['已过期', { notAfterMs: NOW - 1000 }, ENVELOPE_CODES.KEY_EXPIRED],
    ['已吊销', { revokedAtMs: NOW - 1000 }, ENVELOPE_CODES.KEY_REVOKED],
    ['吊销时刻正是现在', { revokedAtMs: NOW }, ENVELOPE_CODES.KEY_REVOKED],
  ]
  for (const [label, window, expected] of cases) {
    const trust = storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem, ...window }])
    const bytes = signed(feedPayload(), keys)
    const result = verifyEnvelope(bytes, { trust, nowMs: NOW })
    assert.equal(result.ok, false, `${label}：签名过的清单被接受了`)
    assert.equal(result.code, expected, `${label}：拒绝码是 ${result.code}，期望 ${expected}`)
    // 理由要能读（排障时"为什么这把钥匙不算数"必须能查到）。
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, `${label}：拒绝没有给出理由`)
  }
})

test('★★★ 窗口**内**必须放行（否则上面三条只是"什么都拒"）', () => {
  const keys = keypair()
  const trust = storeFor([{
    keyId: KEY, publicKeyPem: keys.publicKeyPem,
    notBeforeMs: NOW - 1000, notAfterMs: NOW + 1000,
  }])
  const result = verifyEnvelope(signed(feedPayload(), keys), { trust, nowMs: NOW })
  assert.equal(result.ok, true, `窗口内被拒了：${result.code} ${result.reason}`)
  assert.equal(result.keyId, KEY)
})

test('★★ 吊销时刻**在未来**时仍然有效（"计划吊销"不是"已经吊销"）', () => {
  // 这一条守的是边界的**方向**：`nowMs >= revokedAtMs` 才算吊销。
  // 写成 `>` 或 `!==` 会让"计划在某时刻吊销"变成"立刻吊销"，
  // 而那是发布端做密钥轮换时会真的用到的形态。
  const keys = keypair()
  const trust = storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem, revokedAtMs: NOW + 1000 }])
  const result = verifyEnvelope(signed(feedPayload(), keys), { trust, nowMs: NOW })
  assert.equal(result.ok, true, `吊销时刻在未来却被拒了：${result.code}`)
})

test('★★ 时钟偏移容忍只放宽**窗口边界**，不放宽"完全在窗口之外"', () => {
  // 设计 §6 line 134 提到"时钟明显异常时提示校正时间"，所以偏移容忍是存在的。
  // 但它的作用范围必须只有一点：刚刚跨过边界的那几百毫秒。
  const keys = keypair()
  const justExpired = storeFor([{
    keyId: KEY, publicKeyPem: keys.publicKeyPem, notAfterMs: NOW - 500,
  }])
  const within = verifyEnvelope(signed(feedPayload(), keys), { trust: justExpired, nowMs: NOW, maxClockSkewMs: 1000 })
  assert.equal(within.ok, true, `偏移容忍没有生效：${within.code}`)
  const way = verifyEnvelope(signed(feedPayload(), keys), {
    trust: storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem, notAfterMs: NOW - 3600_000 }]),
    nowMs: NOW, maxClockSkewMs: 1000,
  })
  assert.equal(way.ok, false, '比偏移量大得多的过期时间被偏移容忍放过了')
  assert.equal(way.code, ENVELOPE_CODES.KEY_EXPIRED)
})

test('★★ 吊销之后**立刻**失效——这正是"私钥泄漏后的紧急恢复"那条路', () => {
  // 端到端：同一份字节、同一把钥匙，唯一的变化是信任表里多了一个 revokedAtMs。
  const keys = keypair()
  const bytes = signed(feedPayload(), keys)
  const before = verifyEnvelope(bytes, { trust: storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }]), nowMs: NOW })
  assert.equal(before.ok, true, `吊销前的基线就不成立：${before.reason}`)
  const after = verifyEnvelope(bytes, {
    trust: storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem, revokedAtMs: NOW - 1 }]),
    nowMs: NOW,
  })
  assert.equal(after.ok, false, '吊销之后那份签名过的清单仍然验得过——泄漏的私钥可以无限期用下去')
  assert.equal(after.code, ENVELOPE_CODES.KEY_REVOKED)
})

// ---------------------------------------------------------------------------
// ② selectKey 直接问（比端到端更能指出是哪一条判据）
// ---------------------------------------------------------------------------

test('★ selectKey：信任表不可用与 keyId 不在表里都是"拒绝"，不是"跳过验签"', () => {
  // 这条是设计 §5 的核心立场：「没有公钥 = 检查更新不可用」，而不是"跳过验签"。
  const keys = keypair()
  const bad = selectKey(null, KEY, { nowMs: NOW })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, ENVELOPE_CODES.UNKNOWN_KEY)
  const missing = selectKey(storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }]), 'nobody', { nowMs: NOW })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, ENVELOPE_CODES.UNKNOWN_KEY)
  const good = selectKey(storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }]), KEY, { nowMs: NOW })
  assert.equal(good.ok, true)
  assert.equal(good.entry.keyId, KEY)
  assert.equal(typeof good.entry.fingerprint, 'string')
})

test('★ 密钥指纹稳定且区分不同密钥（离线核对靠它确认"是不是同一把钥匙"）', () => {
  const a = keypair('a')
  const b = keypair('b')
  assert.equal(keyFingerprint(a.publicKeyPem), keyFingerprint(a.publicKeyPem), '同一把钥匙两次指纹不同')
  assert.notEqual(keyFingerprint(a.publicKeyPem), keyFingerprint(b.publicKeyPem), '两把钥匙指纹相同')
})

// ---------------------------------------------------------------------------
// ③ payload 形状与格式
// ---------------------------------------------------------------------------

test('★ payload 不是对象 → BAD_PAYLOAD（与"格式不认识"分开）', () => {
  // 两者分开的意义：`BAD_PAYLOAD` 是"这份 envelope 的结构不对"，
  // `UNKNOWN_FORMAT` 是"结构对、但 payload 声称的格式我不认识"。
  // 合成一个码会让排障时无法区分"文件坏了"与"版本比我新"。
  const keys = keypair()
  const bytes = Buffer.from(JSON.stringify({
    keyId: KEY,
    payload: ['not', 'an', 'object'],
    signature: Buffer.alloc(64, 1).toString('base64'),
  }), 'utf8')
  const result = verifyEnvelope(bytes, {
    trust: storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }]), nowMs: NOW,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, ENVELOPE_CODES.BAD_PAYLOAD)
})

test('★ 期望格式与实际格式不符 → UNKNOWN_FORMAT（列表里合法但**这个位置**不接受）', () => {
  const keys = keypair()
  const trust = storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }])
  const releaseLike = feedPayload({ format: ENVELOPE_FORMATS.RELEASE })
  const result = verifyEnvelope(signed(releaseLike, keys), {
    trust, nowMs: NOW, expectedFormat: ENVELOPE_FORMATS.FEED,
  })
  assert.equal(result.ok, false, '发行格式的 payload 被当成通道清单接受了')
  assert.equal(result.code, ENVELOPE_CODES.UNKNOWN_FORMAT)
  // 对照：不限定格式时就该通过（否则上面那条只是"releas 格式永远不行"）。
  const loose = verifyEnvelope(signed(releaseLike, keys), { trust, nowMs: NOW })
  assert.equal(loose.ok, true, `不限定格式时被拒了：${loose.reason}`)
})

test('★ 信任表条目里那把钥匙本身不可用 → UNSUPPORTED_KEY（不是"有人改了托管"）', () => {
  // ★ 这条判据的**可达性**值得写清楚，我第一版把它想错了：
  //
  //   我原以为"往信任表里塞一个形状像 PEM、内容不是公钥的东西"就能触发它。
  //   实测不会：`createTrustStore` → `normalizeKeyEntry` 会先用
  //   `keyFingerprint()`（也就是 `createPublicKey`）验一遍，**失败就整条丢掉**。
  //   于是那种条目根本进不了表，验签时报的是 `UNKNOWN_KEY`。
  //
  //   ★ 那么 `UNSUPPORTED_KEY` 是不是死代码？**不是**——它守的是一个不同的
  //     前提：信任表**没有经过 `createTrustStore`**（手工拼的、或从别处
  //     反序列化来的）。那时 `selectKey` 会给出条目，而 `createPublicKey`
  //     在验签时抛错。这条 catch 的作用是**别让一个坏条目把进程炸掉**：
  //     一次抛出的验签会让"检查更新"整个失败，而正确的结果是"这一份清单
  //     不可信"——两者对用户是不同的事（前者是程序崩了，后者是有人动了托管）。
  //
  //   所以这一条同时钉住两件事：①`createTrustStore` 会过滤坏 PEM（走
  //   `UNKNOWN_KEY`）；②手工拼的坏表走 `UNSUPPORTED_KEY` 而不是抛出去。
  const keys = keypair()
  const fakePem = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'

  // ① 经过 createTrustStore：坏条目被过滤掉 ⇒ UNKNOWN_KEY。
  const filtered = verifyEnvelope(signed(feedPayload(), keys), {
    trust: storeFor([{ keyId: KEY, publicKeyPem: fakePem }]), nowMs: NOW,
  })
  assert.equal(filtered.ok, false)
  assert.equal(filtered.code, ENVELOPE_CODES.UNKNOWN_KEY,
    `createTrustStore 没有过滤掉坏 PEM（它应当整条丢掉）：${filtered.code}`)

  // ② 手工拼的表（绕过过滤）：必须落到 UNSUPPORTED_KEY，而不是抛异常。
  const handBuilt = Object.freeze({
    keys: new Map([[KEY, { keyId: KEY, publicKeyPem: fakePem, notBeforeMs: null, notAfterMs: null, revokedAtMs: null }]]),
  })
  const result = verifyEnvelope(signed(feedPayload(), keys), { trust: handBuilt, nowMs: NOW })
  assert.equal(result.ok, false, '无效公钥被当成了验签通过')
  assert.equal(result.code, ENVELOPE_CODES.UNSUPPORTED_KEY,
    `期望 UNSUPPORTED_KEY（信任表里那把钥匙本身不可用），实际 ${result.code}：${result.reason}`)
})

// ---------------------------------------------------------------------------
// ④ 签名覆盖的字节
// ---------------------------------------------------------------------------

test('★★ 签名覆盖「固定前缀 + 规范化 payload」，而键序变化不影响结果', () => {
  // 设计 §5 line 108：「签名覆盖固定前缀 `legion-update-envelope@1\n` 加
  // `canonicalJson(payload)` 的 UTF-8 字节」。
  // 这条判据的**实际价值**是"发布端怎么写 JSON 都不影响验签，而语义改动一定被发现"。
  //
  // ★ 要构造"字节不同但语义相同"，**不能**用 `serializeEnvelope`——
  //   它自己就会规范化，两次调用产出逐字相同的字节（我第一版就是这么写的，
  //   于是断言"两份字节应当不同"直接失败）。必须手工 `JSON.stringify`
  //   一份键序不同的原文。
  const keys = keypair()
  const trust = storeFor([{ keyId: KEY, publicKeyPem: keys.publicKeyPem }])
  const payload = feedPayload()
  const canonical = signed(payload, keys)
  const signature = signEnvelope(payload, { privateKeyPem: keys.privateKeyPem, keyId: KEY }).signature
  const reordered = Buffer.from(JSON.stringify({ signature, payload, keyId: KEY }), 'utf8')
  assert.notEqual(reordered.toString('utf8'), canonical.toString('utf8'), '自检前提失效：两份字节相同')
  // 注意：手工拼的那份**没有**尾随换行，而 `serializeEnvelope` 有——
  // 这也是"字节不同"的一部分。
  assert.equal(verifyEnvelope(reordered, { trust, nowMs: NOW }).ok, true,
    '键序不同（或没有尾随换行）导致验签失败——签名没有覆盖规范化结果')

  // 语义改动必须被发现：把改动后的 payload 配上**原始**签名。
  const spliced = Buffer.from(JSON.stringify({
    keyId: KEY,
    payload: feedPayload({ sequence: 999 }),
    signature,
  }), 'utf8')
  const result = verifyEnvelope(spliced, { trust, nowMs: NOW })
  assert.equal(result.ok, false, '改了 payload 却仍然验过')
  assert.equal(result.code, ENVELOPE_CODES.BAD_SIGNATURE)
})

// ---------------------------------------------------------------------------
// ⑤ 装载期自检自己的读数
// ---------------------------------------------------------------------------

test('★ 自检声明的拒绝用例数与实际一致（一条"报了个数字"的读数要能被核对）', async () => {
  const mod = await import('./envelope.mjs')
  const checked = mod.ENVELOPE_CHECKED
  assert.equal(checked.ok, true, JSON.stringify(checked.problems))
  assert.equal(checked.prefix, 'legion-update-envelope@1\n')
  assert.ok(checked.rejectedCases >= 8,
    `自检只报了 ${checked.rejectedCases} 条拒绝用例——它应当覆盖设计 §5 的四类伪造`)
  assert.equal(typeof checked.sample.fingerprint, 'string')
})
