// ============================================================================
// PRT-803 / PRT-804 的判据：可签名安装包、清单签名与**完整性校验**。
//
// 这一组盯的**不是**"验签能不能过"，而是**三个方向的坏输入**：
//
//   ① 签名**缺失**时会不会被当成通过；
//   ② 载荷被改了一个字节时完整性会不会变红；
//   ③ 签名覆盖的到底是不是这份内容与这份清单。
//
// ① 是这类实现里最常见的那个错误，因为 `if (!signature) return ok` 写起来
// 只有一行，而它的表现是"日志里有一行签名校验完成"。
//
//   > 一个"签名缺失就当校验通过"的校验，
//   > 与一个没有签名校验的安装包，是同一个东西。
//
// ③ 是第二常见的：拿包里自带的 `subject` 字段去验签，等于让签名自证。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  INTEGRITY_VERDICTS,
  PACKAGE_CHECKED,
  PACKAGE_CODES,
  PACKAGE_FORMAT,
  PACKAGE_VERDICTS,
  SIGNATURE_ALGORITHM,
  SIGNATURE_VERDICTS,
  buildPackage,
  contentDigestOf,
  entriesFromContents,
  generateSigningKeyPair,
  hashBytes,
  readPackageManifest,
  signPackage,
  signatureSubject,
  unpackPackage,
  verifyIntegrity,
  verifyPackage,
  verifySignature,
  writePackageManifest,
} from '../../product/upgrade/package.mjs'

const MANIFEST = Object.freeze({
  manifestFormat: 'legion/version-manifest@1',
  productVersion: '0.9.0',
  legionVersion: '0.9.0',
  dshVersion: '0.8.3',
  dshCompositionPatchVersion: 2,
  schemaVersion: 12,
  runtimeContractVersion: 1,
  packProtocolVersion: 1,
  channel: 'stable',
})

const CONTENTS = Object.freeze({
  'app/runtime.mjs': 'export const v = 1\n',
  'app/README.md': '# legion\n',
  'app/dsh-composition/patch-layer.mjs': 'export const patch = 1\n',
})

function manifestDigestOf(m = MANIFEST) {
  return hashBytes(Buffer.from(JSON.stringify(m), 'utf8'))
}

function fixture() {
  const keys = generateSigningKeyPair()
  const other = generateSigningKeyPair()
  const manifestDigest = manifestDigestOf()
  const pkg = buildPackage({ productId: 'legion', manifest: MANIFEST, files: CONTENTS })
  const signed = signPackage(pkg, { privateKeyPem: keys.privateKeyPem, manifestDigest, signedAt: '2026-01-01T00:00:00Z', keyId: 'k1' })
  return { keys, other, manifestDigest, pkg, signed }
}

// ── 完整性 ──────────────────────────────────────────────────────────────────

test('① 完好的包：内容摘要可复算且相等', () => {
  const { pkg } = fixture()
  const r = verifyIntegrity(pkg, CONTENTS)
  assert.equal(r.verdict, 'ok', JSON.stringify(r.files))
  assert.equal(r.expectedContentHash, r.contentHash)
  assert.equal(r.files.length, 3)
})

test('① ★★ 改一个字节 → 完整性必须变红，且**指名道姓**是哪个文件', () => {
  const { pkg } = fixture()
  const tampered = { ...CONTENTS, 'app/runtime.mjs': 'export const v = 2\n' }
  const r = verifyIntegrity(pkg, tampered)
  assert.equal(r.verdict, 'mismatch')
  const bad = r.files.find((f) => f.verdict !== 'ok' && f.path === 'app/runtime.mjs')
  assert.equal(bad.verdict, 'hash-mismatch')
  assert.equal(r.code, PACKAGE_CODES.FILE_HASH_MISMATCH)
  // 文件级对不上时，由清单**复算**出来的内容摘要也必然与声明的那一个不同——
  // 两条都要报出来：只报文件级会让人以为"改回去就好了"。
  assert.ok(r.files.some((f) => f.code === PACKAGE_CODES.CONTENT_DIGEST_MISMATCH), JSON.stringify(r.files))
  assert.notEqual(r.contentHash, r.expectedContentHash)
})

test('① ★ 缺失的文件与**多出来**的文件都要被拦（只查声明过的等于放过多出来的那个）', () => {
  const { pkg } = fixture()
  const missing = { ...CONTENTS }
  delete missing['app/README.md']
  const rMissing = verifyIntegrity(pkg, missing)
  assert.equal(rMissing.verdict, 'mismatch')
  assert.equal(rMissing.files.find((f) => f.path === 'app/README.md').verdict, 'missing')

  const extra = { ...CONTENTS, 'app/backdoor.mjs': 'console.log(1)\n' }
  const rExtra = verifyIntegrity(pkg, extra)
  assert.equal(rExtra.verdict, 'mismatch', '多出来的文件没有让完整性变红')
  const undeclared = rExtra.files.find((f) => f.verdict === 'undeclared')
  assert.ok(undeclared, JSON.stringify(rExtra.files))
  assert.equal(undeclared.path, 'app/backdoor.mjs')
})

test('① ★ 截断（大小变了）与"内容换了但大小没变"要给出不同的痕迹', () => {
  const { pkg } = fixture()
  const truncated = { ...CONTENTS, 'app/README.md': '# legio\n' } // 少一个字符
  const r = verifyIntegrity(pkg, truncated)
  assert.equal(r.verdict, 'mismatch')
  const f = r.files.find((x) => x.path === 'app/README.md')
  assert.equal(f.verdict, 'size-mismatch')
  assert.equal(f.observed, 8)
})

test('① ★★ 空包不得判 `ok`：空包与"校验通过"必须分开', () => {
  const empty = buildPackage({ productId: 'legion', manifest: MANIFEST, files: {} })
  const r = verifyIntegrity(empty, {})
  assert.equal(r.verdict, 'uncomputable', '空包被判为完整性 ok')
  assert.equal(r.code, PACKAGE_CODES.CONTENT_DIGEST_ABSENT)
  assert.notEqual(r.verdict, 'ok')
  assert.equal(INTEGRITY_VERDICTS.includes(r.verdict), true)
})

// ── 签名 ────────────────────────────────────────────────────────────────────

test('② ★★ 签名**缺失**时必须报 `unsigned`，绝不能报 `verified`', () => {
  const { pkg, keys, manifestDigest } = fixture()
  const r = verifySignature(pkg, { publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(r.verdict, 'unsigned', '没有签名的包被判成了 verified')
  assert.equal(r.code, PACKAGE_CODES.UNSIGNED)
  assert.notEqual(r.verdict, 'verified')
  assert.equal(SIGNATURE_VERDICTS.includes(r.verdict), true)
})

test('② ★★ `unsigned` 与 `invalid` 是两档：默认都拒，但 `requireSignature: false` 只放 unsigned', () => {
  const { pkg, signed, keys, manifestDigest } = fixture()

  const unsignedDefault = verifyPackage(pkg, { files: CONTENTS, publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(unsignedDefault.verdict, 'rejected')
  assert.equal(unsignedDefault.signature.verdict, 'unsigned')

  const unsignedTolerated = verifyPackage(pkg, {
    files: CONTENTS, publicKeyPem: keys.publicKeyPem, manifestDigest, requireSignature: false,
  })
  assert.equal(unsignedTolerated.verdict, 'unsigned')

  // 而"签名验不过"这一档**任何设置下都不放行**。
  const otherKeys = fixture().other
  const invalid = verifyPackage(signed, {
    files: CONTENTS, publicKeyPem: otherKeys.publicKeyPem, manifestDigest, requireSignature: false,
  })
  assert.equal(invalid.signature.verdict, 'invalid')
  assert.equal(invalid.verdict, 'rejected', '用另一把公钥验签失败却仍被放行')
})

test('② ★ 签名算法不认时按"不认识"处理，不尝试', () => {
  const { signed, keys, manifestDigest } = fixture()
  const downgraded = Object.freeze({
    ...signed,
    signature: Object.freeze({ ...signed.signature, algorithm: 'md5' }),
  })
  const r = verifySignature(downgraded, { publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(r.verdict, 'unsupported')
  assert.equal(r.code, PACKAGE_CODES.SIGNATURE_UNSUPPORTED)
})

test('② ★ 签名值被改一个字符 → invalid（不是"格式问题"）', () => {
  const { signed, keys, manifestDigest } = fixture()
  const raw = Buffer.from(signed.signature.value, 'base64')
  raw[0] = raw[0] ^ 0xff
  const broken = Object.freeze({
    ...signed,
    signature: Object.freeze({ ...signed.signature, value: raw.toString('base64') }),
  })
  const r = verifySignature(broken, { publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(r.verdict, 'invalid')
})

// ── 签名覆盖的到底是什么 ────────────────────────────────────────────────────

test('③ ★★ 签名覆盖 (productId, 清单摘要, 内容摘要) 三者，缺一不可', () => {
  const { signed, keys, manifestDigest } = fixture()
  const subject = signatureSubject({
    productId: 'legion', manifestDigest, contentHash: signed.contentHash,
  })
  assert.ok(subject.includes('legion'), subject)
  assert.ok(subject.includes(manifestDigest), subject)
  assert.ok(subject.includes(signed.contentHash), subject)
  assert.equal(signed.signature.subject, subject)

  // 换 productId → 验不过（防止把 A 产品的包装进 B 产品）。
  const renamed = Object.freeze({ ...signed, productId: 'other-product' })
  assert.equal(verifySignature(renamed, { publicKeyPem: keys.publicKeyPem, manifestDigest }).verdict, 'invalid')

  // 换内容摘要 → 验不过。
  const rehashed = Object.freeze({ ...signed, contentHash: hashBytes(Buffer.from('x')) })
  assert.equal(verifySignature(rehashed, { publicKeyPem: keys.publicKeyPem, manifestDigest }).verdict, 'invalid')

  // 换清单摘要 → 验不过。
  assert.equal(
    verifySignature(signed, { publicKeyPem: keys.publicKeyPem, manifestDigest: hashBytes(Buffer.from('y')) }).verdict,
    'invalid',
  )
})

test('③ ★★ 签名不能**自证**：把包里的 subject 与 value 一起换掉仍然验不过', () => {
  // 这一条盯的是"用包里那份 subject 去验签"的写法。那样写时，
  // 攻击者只要把 subject 改成自己的原文、再用自己的私钥签一次即可通过——
  // 而校验器会报"签名与包内原文一致"。
  const { signed, keys, manifestDigest } = fixture()
  const forgedSubject = signatureSubject({
    productId: 'legion', manifestDigest, contentHash: hashBytes(Buffer.from('forged')),
  })
  const forged = Object.freeze({
    ...signed,
    contentHash: hashBytes(Buffer.from('forged')),
    signature: Object.freeze({ ...signed.signature, subject: forgedSubject }),
  })
  const r = verifySignature(forged, { publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(r.verdict, 'invalid', '包内 subject 被换掉后签名仍然通过——签名在自证')
  // 校验器**重算**了原文：它按包**当前**的 contentHash 拼，而不是采信包里那份 subject。
  assert.ok(r.subject.includes(forged.contentHash), r.subject)
  assert.notEqual(r.subject, forgedSubject)
})

test('③ ★ 没有可信公钥 / 没有清单摘要时是 `unsupported`，不是 `verified`', () => {
  const { signed, manifestDigest } = fixture()
  assert.equal(verifySignature(signed, { publicKeyPem: null, manifestDigest }).verdict, 'unsupported')
  assert.equal(verifySignature(signed, { publicKeyPem: 'pem', manifestDigest: null }).verdict, 'unsupported')
})

// ── 合成裁决 ────────────────────────────────────────────────────────────────

test('④ 合成裁决的四种组合各自落到哪一档', () => {
  const { signed, keys, manifestDigest } = fixture()
  assert.equal(verifyPackage(signed, { files: CONTENTS, publicKeyPem: keys.publicKeyPem, manifestDigest }).verdict, 'verified')

  // 内容被改：完整性红 → rejected（即使签名本身覆盖的摘要没变，这份内容也不是被签的那份）。
  const tamperedContent = { ...CONTENTS, 'app/README.md': '# LEGION\n' }
  const r = verifyPackage(signed, { files: tamperedContent, publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(r.verdict, 'rejected')
  assert.equal(r.integrity.verdict, 'mismatch')
  assert.equal(r.signature.verdict, 'verified')
  assert.ok(r.reasons.length >= 1, JSON.stringify(r.reasons))
})

test('④ ★ 裁决永远带"为什么"：通过的包也要有一句可读的理由', () => {
  const { signed, keys, manifestDigest } = fixture()
  const good = verifyPackage(signed, { files: CONTENTS, publicKeyPem: keys.publicKeyPem, manifestDigest })
  assert.equal(good.verdict, 'verified')
  assert.equal(good.reason, '完整性与签名都通过')
  assert.equal(good.requireSignature, true)
  assert.equal(good.format, PACKAGE_FORMAT)
  assert.equal(PACKAGE_VERDICTS.includes(good.verdict), true)
})

// ── 序列化与解包 ────────────────────────────────────────────────────────────

test('⑤ ★ 「先校验、后落盘」：只有清单没有字节时解包必须失败，不留半个目录', () => {
  const { mkdtempSync, readdirSync, rmSync } = fs
  const { tmpdir } = os
  const { join } = path
  const scratch = mkdtempSync(join(tmpdir(), 'legion-pkg-'))
  try {
    const { pkg } = fixture()
    // 包里只有描述，没有字节。
    assert.throws(() => unpackPackage(pkg, join(scratch, 'out')), (e) => {
      assert.equal(e.code, PACKAGE_CODES.FILE_MISSING)
      return true
    })
    // 一个文件都没写出来：解包必须在**创建任何东西之前**就把字节找齐。
    const outDir = join(scratch, 'out')
    assert.equal(fs.existsSync(outDir), false, '解包失败却留下了目录')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('⑤ 描述文件写出/读回，且格式版本不认识时**拒绝**而不是尽力解析', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const scratch = mkdtempSync(join(tmpdir(), 'legion-pkgm-'))
  try {
    const { signed } = fixture()
    const file = writePackageManifest(signed, join(scratch, 'legion-package.json'))
    const back = readPackageManifest(file)
    assert.equal(back.contentHash, signed.contentHash)
    assert.equal(back.signature.value, signed.signature.value)
    assert.equal(back.files.length, 3)

    assert.throws(() => readPackageManifest(JSON.stringify({ format: 'legion/upgrade-package@9', files: [] })), (e) => {
      assert.equal(e.code, PACKAGE_CODES.FORMAT_UNKNOWN)
      return true
    })
    assert.throws(() => readPackageManifest('{ 这不是 json'), /合法 JSON/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('⑤ 从目录打包：文件顺序稳定 → 同一份内容两次打包的摘要一样', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const scratch = mkdtempSync(join(tmpdir(), 'legion-pkgdir-'))
  try {
    mkdirSync(join(scratch, 'b'), { recursive: true })
    mkdirSync(join(scratch, 'a'), { recursive: true })
    writeFileSync(join(scratch, 'b', 'two.mjs'), '2\n')
    writeFileSync(join(scratch, 'a', 'one.mjs'), '1\n')
    const p1 = buildPackage({ productId: 'legion', manifest: MANIFEST, files: scratch })
    const p2 = buildPackage({ productId: 'legion', manifest: MANIFEST, files: scratch })
    assert.equal(p1.contentHash, p2.contentHash)
    // 包内路径一律 `/`：Windows 的 `\` 不得进清单（否则摘要会因平台而不同）。
    assert.deepEqual(p1.files.map((f) => f.path), ['a/one.mjs', 'b/two.mjs'])
    assert.equal(verifyIntegrity(p1, scratch).verdict, 'ok')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('⑤ 手工改清单里的一个 sha256 → 内容摘要立刻对不上', () => {
  const { pkg } = fixture()
  const forged = Object.freeze({
    ...pkg,
    files: Object.freeze(pkg.files.map((f, i) => (i === 0 ? Object.freeze({ ...f, sha256: hashBytes(Buffer.from('forged')) }) : f))),
  })
  const r = verifyIntegrity(forged, CONTENTS)
  assert.equal(r.verdict, 'mismatch')
  assert.equal(r.contentHash, contentDigestOf(forged.files))
  assert.notEqual(r.contentHash, r.expectedContentHash)
})

// ── 装载期自检 ──────────────────────────────────────────────────────────────

test('⑥ ★ 装载期自检留下的是算出来的值，且六条判据都真的跑过', () => {
  assert.deepEqual([...PACKAGE_CHECKED.problems], [])
  const s = PACKAGE_CHECKED.samples
  assert.equal(s.verified, 'verified')
  assert.equal(s.unsigned, 'unsigned', '自检里"无签名"没有落在 unsigned')
  assert.equal(s.unsignedOverall, 'rejected')
  assert.equal(s.tamperedIntegrity, 'mismatch')
  assert.equal(s.tamperedCode, PACKAGE_CODES.FILE_HASH_MISMATCH)
  assert.equal(s.wrongKey, 'invalid')
  assert.equal(s.wrongManifest, 'invalid')
  assert.equal(s.emptyIntegrity, 'uncomputable')
  assert.equal(PACKAGE_CHECKED.algorithm, SIGNATURE_ALGORITHM)
})

test('⑥ 摘要工具本身：同内容同摘要、不同内容不同摘要', () => {
  assert.equal(hashBytes(Buffer.from('a')), hashBytes(Buffer.from('a')))
  assert.notEqual(hashBytes(Buffer.from('a')), hashBytes(Buffer.from('b')))
  const e1 = entriesFromContents({ 'x': 'a', 'y': 'b' })
  const e2 = entriesFromContents({ 'y': 'b', 'x': 'a' })
  assert.deepEqual(e1.map((e) => e.path), ['x', 'y'])
  assert.equal(contentDigestOf(e1), contentDigestOf(e2))
})
