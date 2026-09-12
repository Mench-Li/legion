// product/upgrade/package.mjs
// ============================================================================
// PRT-803 / PRT-804：可签名安装包、升级包、**清单签名与完整性校验**
//
// spec §10 line 744：「安装包、升级清单和下载产物需要完整性校验；正式版使用代码签名。」
// spec §9.4 line 723：升级流程里的第二步是「下载并校验签名」。
//
// ## 完整性与来源是两件事，必须分开报
//
// 哈希回答的是"这份字节有没有被动过"。签名回答的是"它是不是我们发的"。
// 两个答案的对角线情况才是要命的：
//
//   · 哈希对、签名**没有** —— 一份谁都能重造的、内容完好的包；
//   · 哈希错、签名**有效** —— 这不可能同时成立（签名覆盖摘要），
//     所以它只可能意味着"验签用的不是摘要"。
//
// 于是本模块**不**给出一个 `ok` 布尔。它给出两个独立结论
// （`integrity` / `signature`）和一个合成裁决（`verdict`），而合成裁决里
// `unsigned` 是**单独的**一档：
//
//   > 一个"签名缺失就当校验通过"的校验，
//   > 与一个没有签名校验的安装包，在"这份包到底是不是我们发的"上是同一个东西——
//   > 只不过前者会在日志里留下一行"签名校验完成"。
//
// 所以 `verdict !== 'verified'` 就是"不许安装"，而调用方要不要接受 `unsigned`
// 必须**显式**说（`requireSignature`），默认是**不接受**。
//
// ## 为什么签名不是覆盖文件内容，而是覆盖摘要
//
// 覆盖内容意味着"验签时要用同一套字节序、同一份换行、同一个文件顺序"——
// 而这三样在打包机与解包机之间并不天然一致（Windows 上尤其）。一旦它们不一致，
// 表现是"验签随机失败"，而人会开始加容错，最后容错吃掉校验。
//
//   > 一个在字节序上做容错的签名校验，
//   > 与一个"某些包跳过签名校验"的实现，是同一个东西。
//
// 所以签名的原文是**由规范化摘要拼出来的一行文本**（`SIGNATURE_PURPOSE` +
// 清单摘要 + 内容摘要），它对两边的字节序完全不敏感。
// ============================================================================

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 包格式版本。改动字段集合时递增。 */
export const PACKAGE_FORMAT = 'legion/upgrade-package@1'

/** 签名算法。只认这一种——"算法字段可配"等于"算法可以被降级"。 */
export const SIGNATURE_ALGORITHM = 'ed25519'

/** `integrity` 的两档。 */
export const INTEGRITY_VERDICTS = Object.freeze(['ok', 'mismatch', 'uncomputable'])

/** `signature` 的三档。**`unsigned` 与 `invalid` 必须分开**。 */
export const SIGNATURE_VERDICTS = Object.freeze(['verified', 'unsigned', 'invalid', 'unsupported'])

/** 合成裁决。只有 `verified` 允许进入安装流程。 */
export const PACKAGE_VERDICTS = Object.freeze(['verified', 'unsigned', 'rejected'])

export const PACKAGE_CODES = Object.freeze({
  INTEGRITY_OK: 'package-integrity-ok',
  /** 某个文件的哈希对不上（下载损坏、被替换、被截断）。 */
  FILE_HASH_MISMATCH: 'package-file-hash-mismatch',
  /** 清单里声明了但磁盘上没有的文件。 */
  FILE_MISSING: 'package-file-missing',
  /** 磁盘上有但清单里没有的文件。 */
  FILE_UNDECLARED: 'package-file-undeclared',
  /** 文件大小对不上。 */
  FILE_SIZE_MISMATCH: 'package-file-size-mismatch',
  /** 内容摘要对不上。 */
  CONTENT_DIGEST_MISMATCH: 'package-content-digest-mismatch',
  /** 没有内容摘要可算/可比。 */
  CONTENT_DIGEST_ABSENT: 'package-content-digest-absent',
  /** 签名缺失（**不是**验证通过）。 */
  UNSIGNED: 'package-unsigned',
  /** 签名存在但验不过。 */
  SIGNATURE_INVALID: 'package-signature-invalid',
  /** 签名或密钥的格式不认识。 */
  SIGNATURE_UNSUPPORTED: 'package-signature-unsupported',
  /** 签名时使用的摘要与当前内容摘要不一致。 */
  SIGNATURE_SUBJECT_MISMATCH: 'package-signature-subject-mismatch',
  /** 包格式版本不认识。 */
  FORMAT_UNKNOWN: 'package-format-unknown',
})

function packageError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/** 单个文件的 `sha256:` 摘要（base64 内容用 Buffer）。 */
export function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function hashFile(path) {
  return hashBytes(readFileSync(path))
}

/** 相对路径归一化成包内路径：统一 `/`，Windows 上转出来的 `\` 不得进入清单。 */
export function toPackagePath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/** 递归列出目录下的全部文件，**按包内路径排序**——顺序不稳会让摘要不稳。 */
export function listFiles(rootPath) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  walk(rootPath)
  return out.sort((a, b) => (toPackagePath(rootPath, a) < toPackagePath(rootPath, b) ? -1 : 1))
}

/**
 * 内容摘要：由 `(路径, 摘要, 大小)` 三元组排序后哈希得到。
 *
 * 不哈希"打包后的 tarball 字节"：tar 的元数据（时间戳、属主、权限位）
 * 每次打包都不同，于是同一份内容会有两个摘要，而签名覆盖的是其中之一。
 */
export function contentDigestOf(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const text = sorted.map((e) => `${e.path}\0${e.sha256}\0${e.size}`).join('\n')
  return hashBytes(Buffer.from(text, 'utf8'))
}

/** 从一组 `(包内路径, 字节)` 构造条目表。测试与打包机都走这一条。 */
export function entriesFromContents(contents) {
  return Object.freeze(
    Object.entries(contents)
      .map(([path, value]) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
        return Object.freeze({ path: path.split(sep).join('/'), sha256: hashBytes(bytes), size: bytes.length })
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  )
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/**
 * 构造一份**未签名**的包描述。
 *
 * `files` 可以是：
 *   · `{ 'rel/path': 字符串 | Buffer }` —— 内存内容（测试与清单构造）；
 *   · 一个目录路径 —— 真实打包，逐个文件读哈希。
 *
 * 第二条路径需要显式传 `root`，因为"目录里有几个文件"必须是可枚举的：
 * 一个"打包时顺便排除掉 build 产物"的实现，与一个"少打了几个文件的包"，
 * 在解包端看起来完全一样。
 */
export function buildPackage({ productId, manifest, files, root = null }) {
  if (manifest === null || typeof manifest !== 'object') {
    throw packageError(PACKAGE_CODES.FORMAT_UNKNOWN, 'buildPackage 需要 manifest（版本清单）')
  }
  let entries
  let contents = null
  const directory = root ?? (typeof files === 'string' ? files : null)
  if (directory !== null) {
    entries = Object.freeze(listFiles(directory).map((abs) => {
      const st = statSync(abs)
      return Object.freeze({ path: toPackagePath(directory, abs), sha256: hashFile(abs), size: st.size })
    }))
  } else if (files !== null && typeof files === 'object' && !Array.isArray(files)) {
    entries = entriesFromContents(files)
    // 字节随包一起带上：解包需要它，而"只有清单没有字节"的包必须解不出来。
    contents = Object.freeze(Object.fromEntries(
      Object.entries(files).map(([p, v]) => [p.split(sep).join('/'), Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')]),
    ))
  } else {
    throw packageError(PACKAGE_CODES.CONTENT_DIGEST_ABSENT, 'buildPackage 需要 files 对象或目录路径')
  }
  return Object.freeze({
    format: PACKAGE_FORMAT,
    productId: productId ?? manifest.productVersion,
    manifest,
    files: entries,
    contentHash: contentDigestOf(entries),
    contents,
    signature: null,
  })
}

// ---------------------------------------------------------------------------
// 签名（PRT-803）
// ---------------------------------------------------------------------------

/** 生成一对 Ed25519 密钥（PEM）。发布侧持有私钥，产品侧只内置公钥。 */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKey: { type: 'spki', format: 'pem' },
    privateKey: { type: 'pkcs8', format: 'pem' },
  })
  return Object.freeze({
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  })
}

/** 签名覆盖的键标识与用途串。**换用途就要换签名**，避免签名被跨用途重放。 */
export const SIGNATURE_PURPOSE = 'legion-upgrade-package-v1'

/**
 * 被签名的原文：一行确定性文本。
 *
 * 三个字段缺一不可：`productId` 防"把 A 产品的包装进 B 产品"，
 * `manifestDigest` 防"清单被换而载荷没换"，`contentHash` 防"载荷被换"。
 * 少任何一个，签名就只覆盖了另外两个。
 */
export function signatureSubject({ productId, manifestDigest, contentHash }) {
  return [
    SIGNATURE_PURPOSE,
    `product=${productId}`,
    `manifest=${manifestDigest}`,
    `content=${contentHash}`,
  ].join('\n')
}

/**
 * 签名一份包。
 *
 * @param {object} pkg `buildPackage` 的返回
 * @param {{privateKeyPem: string, manifestDigest: string, signedAt?: string, keyId?: string}} args
 */
export function signPackage(pkg, { privateKeyPem, manifestDigest, signedAt = null, keyId = null }) {
  if (typeof privateKeyPem !== 'string' || privateKeyPem.trim() === '') {
    throw packageError(PACKAGE_CODES.SIGNATURE_UNSUPPORTED, 'signPackage 需要私钥 PEM')
  }
  if (typeof manifestDigest !== 'string' || manifestDigest === '') {
    throw packageError(PACKAGE_CODES.SIGNATURE_UNSUPPORTED, 'signPackage 需要 manifestDigest（清单内容哈希）')
  }
  const subject = signatureSubject({
    productId: pkg.productId, manifestDigest, contentHash: pkg.contentHash,
  })
  const signature = cryptoSign(null, Buffer.from(subject, 'utf8'), createPrivateKey(privateKeyPem))
  return Object.freeze({
    ...pkg,
    signature: Object.freeze({
      algorithm: SIGNATURE_ALGORITHM,
      subject,
      manifestDigest,
      value: signature.toString('base64'),
      keyId,
      signedAt,
    }),
  })
}

// ---------------------------------------------------------------------------
// 校验（PRT-804）
// ---------------------------------------------------------------------------

/** 复算包内每个文件的摘要。`files` 是 `{ 'rel/path': 字节 }` 或目录路径 + root。 */
export function hashActualFiles(files) {
  const out = new Map()
  if (typeof files === 'string') {
    for (const abs of listFiles(files)) {
      out.set(toPackagePath(files, abs), Object.freeze({ sha256: hashFile(abs), size: statSync(abs).size }))
    }
    return out
  }
  for (const [path, value] of Object.entries(files ?? {})) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    out.set(path.split(sep).join('/'), Object.freeze({ sha256: hashBytes(bytes), size: bytes.length }))
  }
  return out
}

/**
 * 完整性校验。返回**逐文件结论**，不是一个布尔。
 *
 * 三种结果：
 *   · `ok`           — 声明与实测逐个一致，且内容摘要能算出来并相等；
 *   · `mismatch`     — 至少一个文件对不上（损坏、缺失、多出来、被换）；
 *   · `uncomputable` — 没有可测的内容（比如清单里一个文件都没有），
 *                      因此**不能**报 `ok`。
 *
 *   > 一个"没有文件所以校验通过"的完整性校验，
 *   > 与一个"什么都没校验"的校验，是同一个东西。
 */
export function verifyIntegrity(pkg, files) {
  const declared = Array.isArray(pkg?.files) ? pkg.files : null
  if (declared === null) {
    return Object.freeze({
      verdict: 'uncomputable',
      code: PACKAGE_CODES.CONTENT_DIGEST_ABSENT,
      reason: '包里没有文件清单，无从校验',
      files: Object.freeze([]),
      contentHash: null,
      expectedContentHash: pkg?.contentHash ?? null,
    })
  }
  if (declared.length === 0) {
    return Object.freeze({
      verdict: 'uncomputable',
      code: PACKAGE_CODES.CONTENT_DIGEST_ABSENT,
      reason: '包的文件清单是空的：空包与"校验通过"在读数上必须分开',
      files: Object.freeze([]),
      contentHash: null,
      expectedContentHash: pkg?.contentHash ?? null,
    })
  }

  const actual = hashActualFiles(files)
  const perFile = []
  let bad = 0

  for (const entry of declared) {
    const found = actual.get(entry.path)
    if (found === undefined) {
      bad += 1
      perFile.push(Object.freeze({
        path: entry.path, verdict: 'missing', code: PACKAGE_CODES.FILE_MISSING,
        expected: entry.sha256, observed: null,
      }))
      continue
    }
    if (found.size !== entry.size) {
      bad += 1
      perFile.push(Object.freeze({
        path: entry.path, verdict: 'size-mismatch', code: PACKAGE_CODES.FILE_SIZE_MISMATCH,
        expected: entry.size, observed: found.size,
      }))
      continue
    }
    if (found.sha256 !== entry.sha256) {
      bad += 1
      perFile.push(Object.freeze({
        path: entry.path, verdict: 'hash-mismatch', code: PACKAGE_CODES.FILE_HASH_MISMATCH,
        expected: entry.sha256, observed: found.sha256,
      }))
      continue
    }
    perFile.push(Object.freeze({ path: entry.path, verdict: 'ok', code: PACKAGE_CODES.INTEGRITY_OK }))
  }

  // 反方向：磁盘上有、清单里没有的文件。这一条不是洁癖——
  // 一个"只查清单里声明的文件"的校验，会放过多出来的那一个（可能正是被塞进去的）。
  const declaredPaths = new Set(declared.map((e) => e.path))
  for (const path of actual.keys()) {
    if (!declaredPaths.has(path)) {
      bad += 1
      perFile.push(Object.freeze({
        path, verdict: 'undeclared', code: PACKAGE_CODES.FILE_UNDECLARED,
        expected: null, observed: actual.get(path).sha256,
      }))
    }
  }

  // 内容摘要必须能复算，且与包**声明的**那一个相等。
  //
  // ★ 这一步刻意**不以文件级检查为条件**：每个文件都对得上而整体摘要对不上，
  // 说明"清单与摘要不是同一次打包产生的"；每个文件都对不上而整体摘要却对得上，
  // 说明"摘要没有覆盖清单"。两条都必须被看见，所以它们各自独立判。
  const declaredContentHash = contentDigestOf(declared.map((e) => ({
    path: e.path, sha256: e.sha256, size: e.size,
  })))
  const expectedContentHash = pkg?.contentHash ?? null
  if (expectedContentHash === null) {
    bad += 1
    perFile.push(Object.freeze({
      path: '(content)', verdict: 'absent', code: PACKAGE_CODES.CONTENT_DIGEST_ABSENT,
      expected: null, observed: declaredContentHash,
    }))
  } else if (expectedContentHash !== declaredContentHash) {
    bad += 1
    perFile.push(Object.freeze({
      path: '(content)', verdict: 'digest-mismatch', code: PACKAGE_CODES.CONTENT_DIGEST_MISMATCH,
      expected: expectedContentHash, observed: declaredContentHash,
    }))
  }

  const failed = perFile.filter((f) => f.verdict !== 'ok')
  return Object.freeze({
    verdict: bad === 0 ? 'ok' : 'mismatch',
    code: bad === 0 ? PACKAGE_CODES.INTEGRITY_OK : failed[0].code,
    reason: bad === 0
      ? `${declared.length} 个文件的摘要与内容摘要逐个一致`
      : `${failed.length} 项对不上（首个：${failed[0].path} — ${failed[0].verdict}）`,
    files: Object.freeze(perFile),
    // 「清单自洽」与「磁盘上的字节与清单一致」是两个读数：
    // 前者是内容摘要的复算，后者是逐文件比对。合成一个会让排障少一半信息。
    contentHash: declaredContentHash,
    observedContentHash: contentDigestOf([...actual.entries()].map(([path, v]) => ({
      path, sha256: v.sha256, size: v.size,
    }))),
    expectedContentHash,
  })
}

/**
 * 签名校验。
 *
 * ★ 本函数**永远不会**在签名缺失时返回 `verified`。它返回 `unsigned`，
 * 并把"要不要接受"留给调用方（`verifyPackage` 的 `requireSignature`）。
 */
export function verifySignature(pkg, { publicKeyPem, manifestDigest = null } = {}) {
  const sig = pkg?.signature ?? null

  // ① 缺失 ≠ 通过。
  if (sig === null || sig === undefined) {
    return Object.freeze({
      verdict: 'unsigned', code: PACKAGE_CODES.UNSIGNED, keyId: null,
      subject: null,
      reason: '这份包没有签名。"没有签名"与"签名有效"是两件事，本判定把它们分开报',
    })
  }
  if (typeof sig !== 'object' || typeof sig.value !== 'string' || sig.value === '') {
    return Object.freeze({
      verdict: 'invalid', code: PACKAGE_CODES.SIGNATURE_INVALID, keyId: sig?.keyId ?? null,
      subject: sig?.subject ?? null, reason: '签名对象存在但没有值',
    })
  }
  // ② 算法只认一种。认不出的算法按"不认识"处理，而不是"尝试一下"。
  if (sig.algorithm !== SIGNATURE_ALGORITHM) {
    return Object.freeze({
      verdict: 'unsupported', code: PACKAGE_CODES.SIGNATURE_UNSUPPORTED, keyId: sig.keyId ?? null,
      subject: sig.subject ?? null,
      reason: `签名算法 ${JSON.stringify(sig.algorithm)} 不是 ${SIGNATURE_ALGORITHM}`,
    })
  }
  if (typeof publicKeyPem !== 'string' || publicKeyPem.trim() === '') {
    return Object.freeze({
      verdict: 'unsupported', code: PACKAGE_CODES.SIGNATURE_UNSUPPORTED, keyId: sig.keyId ?? null,
      subject: sig.subject ?? null,
      reason: '没有提供可信公钥：没有可信公钥时"验签通过"这句话没有主语',
    })
  }

  // ③ 被签名的原文必须**重算**，不能直接采信包里的那一份。
  //
  //   包里存 `subject` 是为了让审计能复原"当时签的是什么"。若拿它来验证，
  //   那么把 `subject` 与 `value` 一起换掉即可通过——签名就变成了自证。
  //
  //   > 一个"用包里那份 subject 去验签"的校验，
  //   > 与一个"只要签名与它自己带来的原文一致就通过"的校验，是同一个东西。
  if (manifestDigest === null || typeof manifestDigest !== 'string') {
    return Object.freeze({
      verdict: 'unsupported', code: PACKAGE_CODES.SIGNATURE_UNSUPPORTED, keyId: sig.keyId ?? null,
      subject: sig.subject ?? null,
      reason: '没有提供 manifestDigest：签名覆盖的原文无法重算',
    })
  }
  if (sig.manifestDigest !== manifestDigest) {
    return Object.freeze({
      verdict: 'invalid', code: PACKAGE_CODES.SIGNATURE_SUBJECT_MISMATCH, keyId: sig.keyId ?? null,
      subject: sig.subject ?? null,
      reason: `签名针对的清单摘要 ${sig.manifestDigest} 与当前的 ${manifestDigest} 不一致：清单在签名之后被换过`,
    })
  }

  const expectedSubject = signatureSubject({
    productId: pkg.productId, manifestDigest, contentHash: pkg.contentHash,
  })

  let ok = false
  let decodeFailed = false
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(expectedSubject, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(sig.value, 'base64'),
    )
  } catch {
    decodeFailed = true
  }
  if (decodeFailed) {
    return Object.freeze({
      verdict: 'unsupported', code: PACKAGE_CODES.SIGNATURE_UNSUPPORTED, keyId: sig.keyId ?? null,
      subject: expectedSubject, reason: '公钥或签名的编码无法解析',
    })
  }
  if (!ok) {
    return Object.freeze({
      verdict: 'invalid', code: PACKAGE_CODES.SIGNATURE_INVALID, keyId: sig.keyId ?? null,
      subject: expectedSubject,
      reason: `签名验不过（公钥/私钥不匹配，或签名/载荷被替换）。` +
        `签名覆盖的原文里 content=${pkg?.contentHash}`,
    })
  }
  return Object.freeze({
    verdict: 'verified', code: null, keyId: sig.keyId ?? null, subject: expectedSubject,
    reason: '签名覆盖 (productId, 清单摘要, 内容摘要)，且与可信公钥匹配',
  })
}

/**
 * 完整性 + 签名的**合成裁决**。
 *
 * 两条判据独立执行、独立报告；合成裁决只有在签名 `verified` **且**完整性 `ok`
 * 时才是 `verified`。签名有效但完整性不通过时裁决是 `rejected`——
 * 这一格是"签名覆盖摘要"这个设计的直接推论：摘要对不上而签名仍然有效，
 * 说明验签用的不是当前这份内容。
 *
 * @param {object} pkg
 * @param {{files?: object|string, publicKeyPem?: string, manifestDigest?: string,
 *          requireSignature?: boolean}} args
 */
export function verifyPackage(pkg, {
  files = {}, publicKeyPem = null, manifestDigest = null, requireSignature = true,
} = {}) {
  const integrity = verifyIntegrity(pkg, files)
  const signature = verifySignature(pkg, { publicKeyPem, manifestDigest })

  let verdict
  if (signature.verdict === 'unsigned') {
    // ★ 唯一一处"允许继续"的松动，而且必须由调用方显式打开。
    verdict = requireSignature ? 'rejected' : 'unsigned'
  } else if (signature.verdict === 'verified' && integrity.verdict === 'ok') {
    verdict = 'verified'
  } else {
    verdict = 'rejected'
  }

  const reasons = []
  if (integrity.verdict !== 'ok') reasons.push(`完整性：${integrity.reason}`)
  if (signature.verdict !== 'verified') reasons.push(`签名：${signature.reason}`)

  return Object.freeze({
    verdict,
    integrity,
    signature,
    requireSignature,
    format: PACKAGE_FORMAT,
    contentHash: integrity.contentHash,
    reasons: Object.freeze(reasons),
    reason: verdict === 'verified'
      ? '完整性与签名都通过'
      : reasons.join('；'),
  })
}

// ---------------------------------------------------------------------------
// 序列化与解包
// ---------------------------------------------------------------------------

/** 写出包描述（`legion-package.json`）。**排除签名之外的字段都写**，供审计复原。 */
export function writePackageManifest(pkg, targetPath) {
  const text = JSON.stringify({
    format: pkg.format,
    productId: pkg.productId,
    manifest: pkg.manifest,
    contentHash: pkg.contentHash,
    files: pkg.files,
    signature: pkg.signature,
  }, null, 2)
  writeFileSync(targetPath, text + '\n', 'utf8')
  return targetPath
}

/** 读回包描述。格式版本不认识时**拒绝**，而不是尽力解析。 */
export function readPackageManifest(source) {
  const raw = typeof source === 'string' && source.trim().startsWith('{')
    ? source
    : readFileSync(source, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw packageError(PACKAGE_CODES.FORMAT_UNKNOWN, `包描述不是合法 JSON：${e.message}`)
  }
  if (parsed?.format !== PACKAGE_FORMAT) {
    throw packageError(
      PACKAGE_CODES.FORMAT_UNKNOWN,
      `包格式 ${JSON.stringify(parsed?.format)} 不是本实现认识的 ${PACKAGE_FORMAT}`,
    )
  }
  if (!Array.isArray(parsed.files)) {
    throw packageError(PACKAGE_CODES.CONTENT_DIGEST_ABSENT, '包描述没有文件清单')
  }
  return Object.freeze({
    ...parsed,
    files: Object.freeze(parsed.files.map((f) => Object.freeze({ ...f }))),
    signature: parsed.signature === null || parsed.signature === undefined
      ? null
      : Object.freeze({ ...parsed.signature }),
  })
}

/**
 * 解包：**先校验、后落盘**。
 *
 * 顺序不是实现细节。先落盘再校验意味着"一份损坏的包已经覆盖了安装目录的一半"，
 * 而"回滚一半的程序"不是一个可回滚的状态。
 *
 *   > 一个"边解压边校验"的解包，
 *   > 与一个"损坏的包已经把旧版本覆盖掉一部分"的解包，是同一个东西。
 */
export function unpackPackage(pkg, targetDir, { create = true } = {}) {
  // ★ 先把字节全部找齐，**再**创建任何目录或写任何文件。
  //
  //   > 一个"边解压边校验"的解包，
  //   > 与一个"损坏的包已经把旧版本覆盖掉一部分"的解包，是同一个东西。
  //
  // 把这一步与下一步分开，是为了让"失败"这个结果在文件系统上**不留痕迹**：
  // 只查清单就动手的实现会先建出半棵目录树，而那棵树的存在本身会误导下一个人。
  const resolved = pkg.files.map((entry) => {
    const source = pkg.contents?.[entry.path]
    if (source === undefined) {
      throw packageError(
        PACKAGE_CODES.FILE_MISSING,
        `包里没有 ${entry.path} 的字节：只有清单不能解包`,
      )
    }
    return Object.freeze({
      entry,
      bytes: Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8'),
    })
  })

  if (create) mkdirSync(targetDir, { recursive: true })
  const written = []
  for (const { entry, bytes } of resolved) {
    const dest = join(targetDir, ...entry.path.split('/'))
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, bytes)
    written.push(entry.path)
  }
  return Object.freeze({ targetDir, written: Object.freeze(written) })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的**四条**核心判据各真的跑一遍，留下算出来的值。
 *
 * 判据一条不落：① 无签名必须报 `unsigned`（不是 `verified`）；
 * ② 篡改一个字节必须让完整性变红；③ 换公钥必须让签名变红；
 * ④ 换清单摘要必须让签名变红（防止"用包里的 subject 自证"）。
 */
export function selfCheckPackage() {
  const problems = []
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair()
  const other = generateSigningKeyPair()

  const manifest = Object.freeze({
    manifestFormat: 'legion/version-manifest@1',
    productVersion: '0.9.0', legionVersion: '0.9.0', dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2, schemaVersion: 12, runtimeContractVersion: 1,
    packProtocolVersion: 1, channel: 'stable',
  })
  const manifestDigest = hashBytes(Buffer.from(JSON.stringify(manifest), 'utf8'))
  const contents = { 'app/runtime.mjs': 'export const v = 1\n', 'app/README.md': '# legion\n' }
  const base = buildPackage({ productId: 'legion', manifest, files: contents })
  const signed = signPackage(base, { privateKeyPem, manifestDigest })

  // ① 无签名必须报 unsigned，且默认被拒。
  const unsigned = verifyPackage(base, { files: contents, publicKeyPem, manifestDigest })
  if (unsigned.signature.verdict !== 'unsigned') {
    problems.push(`无签名的包被判成 ${unsigned.signature.verdict}——它必须是 unsigned`)
  }
  if (unsigned.verdict !== 'rejected') {
    problems.push('无签名的包在默认（requireSignature）下没有判 rejected')
  }

  // ② 篡改一个字节 → 完整性 mismatch。
  const tampered = { ...contents, 'app/runtime.mjs': 'export const v = 2\n' }
  const tamperedVerdict = verifyPackage(signed, { files: tampered, publicKeyPem, manifestDigest })
  if (tamperedVerdict.integrity.verdict !== 'mismatch') {
    problems.push('内容被改了一个字节，完整性仍判为 ok')
  }
  if (tamperedVerdict.verdict !== 'rejected') problems.push('内容被篡改的包没有被拒')

  // ③ 换公钥 → 签名 invalid。
  const wrongKey = verifyPackage(signed, { files: contents, publicKeyPem: other.publicKeyPem, manifestDigest })
  if (wrongKey.signature.verdict !== 'invalid') {
    problems.push(`用另一把公钥验签得到 ${wrongKey.signature.verdict}——它必须是 invalid`)
  }

  // ④ 换清单摘要 → 签名 invalid（签名覆盖了清单）。
  const wrongManifest = verifyPackage(signed, { files: contents, publicKeyPem, manifestDigest: hashBytes(Buffer.from('other')) })
  if (wrongManifest.signature.verdict !== 'invalid') {
    problems.push('换了清单摘要后签名仍通过——签名没有覆盖清单')
  }

  // ⑤ 正常路径必须通过（否则上面四条"全红"也可以满足）。
  const good = verifyPackage(signed, { files: contents, publicKeyPem, manifestDigest })
  if (good.verdict !== 'verified') {
    problems.push(`一份完好且已签名的包被判为 ${good.verdict}：${good.reason}`)
  }

  // ⑥ 空包不得判 ok。
  const empty = verifyPackage(buildPackage({ productId: 'legion', manifest, files: {} }), {
    files: {}, publicKeyPem, manifestDigest,
  })
  if (empty.integrity.verdict === 'ok') problems.push('空包被判为完整性 ok')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: PACKAGE_FORMAT,
    algorithm: SIGNATURE_ALGORITHM,
    integrityVerdicts: INTEGRITY_VERDICTS,
    signatureVerdicts: SIGNATURE_VERDICTS,
    packageVerdicts: PACKAGE_VERDICTS,
    samples: Object.freeze({
      verified: good.verdict,
      unsigned: unsigned.signature.verdict,
      unsignedOverall: unsigned.verdict,
      tamperedIntegrity: tamperedVerdict.integrity.verdict,
      tamperedCode: tamperedVerdict.integrity.code,
      wrongKey: wrongKey.signature.verdict,
      wrongManifest: wrongManifest.signature.verdict,
      emptyIntegrity: empty.integrity.verdict,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const PACKAGE_CHECKED = selfCheckPackage()
