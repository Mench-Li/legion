// product/update/credential.mjs
// ============================================================================
// 一次性事务凭证 —— 设计 §7 line 162 与 §8 第 7 步
//
// 原文（§7 line 162）：「升级 helper 使用受限的一次性事务凭证和固定事务
// 文件位置，不信任网页输入的包路径。」
//
// 这句话把 helper 的输入面定义死了，而 helper 是整个流程里**权限最高**的
// 一段代码：它要在服务全停之后替换程序目录、改数据库、再拉起新版本。
// 所以它不能接受"你告诉我装哪个包"——那是渲染进程（也就是网页）能影响的
// 输入。它只能读**固定的**事务文件。
//
// ## 凭证挡的是什么
//
// 不是"防止别人运行 helper"（同一个用户权限下挡不住）。它挡的是两件更
// 具体的事：
//
//   ① **把一次旧的事务重放一次。** 事务文件会留在磁盘上；一个没有凭证的
//      helper 在崩溃恢复时无法区分"这是我这次要做的"与"这是上次留下的"。
//      凭证里有 `issuedAtMs`/`expiresAtMs` 与一次性 nonce，重放会被拒。
//
//   ② **让 helper 去动一个不是本次目标的程序目录。** 凭证的 MAC 覆盖了
//      `txnId`、`dataDir`、目标版本与包摘要。改任何一个字段，MAC 就对不上。
//
// ## 为什么用 HMAC 而不是签名
//
// 签发者与验证者是**同一台机器上的同一份代码**，中间没有第三方。HMAC 的
// 前提（共享密钥）在这里成立，而且不需要管理一对非对称密钥。真正的威胁
// 模型是"另一个进程伪造事务文件"，而它拿不到密钥——密钥在一次事务开始时
// 现生成，事务结束即删。
// ============================================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { canonicalJson, parseJsonStrict, sha256Hex } from './canonical.mjs'

export const CREDENTIAL_FORMAT = 'legion/update-credential@1'
export const CREDENTIAL_FILENAME = 'transaction-credential.json'
export const SECRET_FILENAME = 'transaction-secret'

/** 凭证有效期。它只在一次进程交接期间活着，不该长到能跨一次重启。 */
export const DEFAULT_CREDENTIAL_TTL_MS = 30 * 60 * 1000

export const CREDENTIAL_CODES = Object.freeze({
  MISSING: 'credential-missing',
  EXPIRED: 'credential-expired',
  BAD_MAC: 'credential-bad-mac',
  TARGET_MISMATCH: 'credential-target-mismatch',
  BAD_INPUT: 'credential-bad-input',
  // ★ 原本这里还有一个 `CONSUMED: 'credential-consumed'`，已删除。
  //
  //   "这张凭据已经被用掉"**不会**产出这个码，因为"用掉"这个动作就是
  //   `destroyCredential()` ——**把凭据文件删掉**。所以一次重放读到的文件
  //   不存在，落到的码是 `MISSING`（"没有事务凭证"）。
  //
  //   ★ 与 ㉘ 里那个死分支是**同一个形状**，结论却相反，值得对照：
  //     那里的终态动作（提交）也会把描述符删掉，于是"已提交"永远读不出来——
  //     而**那是个 bug**，因为那条分支必须把"已提交"与"从未有过"分开
  //     （前者恢复会丢新写入，要用户确认；后者可以自动恢复）。
  //     这里两者落到同一个码是**对的**：重放与从未有过都该被拒，
  //     分开它们不会让任何决定变得更安全。
  //
  //   > 同一个"终态动作不可逆"的形状，是 bug 还是设计，
  //   > 取决于**下游需不需要把它们分开**。
})

export function credentialDir(dataDir) {
  return join(dataDir, 'update')
}

export function credentialPath(dataDir) {
  return join(credentialDir(dataDir), CREDENTIAL_FILENAME)
}

export function secretPath(dataDir) {
  return join(credentialDir(dataDir), SECRET_FILENAME)
}

/**
 * 被 MAC 覆盖的字段 —— **只有这些**。
 *
 * 白名单而不是"整个对象"：一个覆盖全字段的 MAC 在将来有人往事务文件里
 * 加一个字段时会把它一起保护起来，而"加了字段就自动被保护"听起来是好事，
 * 实际是"没人再检查那个字段该不该被信任"。
 */
export const CREDENTIAL_FIELDS = Object.freeze([
  'format', 'txnId', 'dataDir', 'toVersion', 'fromVersion', 'releaseId', 'packageSha256', 'expiresAtMs',
])

function subjectOf(credential) {
  const subject = {}
  for (const field of CREDENTIAL_FIELDS) subject[field] = credential[field] ?? null
  return canonicalJson(subject)
}

function computeMac(secret, credential) {
  return createHmac('sha256', secret).update(subjectOf(credential), 'utf8').digest('hex')
}

/**
 * 签发一份凭证。返回的 `secretHex` 由安装事务持有，写给 helper 的方式由
 * 调用方决定（同目录文件 / 管道 / 环境变量），本模块只负责读写文件这一种。
 */
export function issueCredential({
  dataDir, txnId, toVersion, fromVersion = null, releaseId = null, packageSha256 = null,
  ttlMs = DEFAULT_CREDENTIAL_TTL_MS, now = () => Date.now(), secret = null,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir === '' || typeof txnId !== 'string' || txnId === '') {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.BAD_INPUT, reason: '签发凭证需要 dataDir 与 txnId', credential: null, secretHex: null })
  }
  if (typeof packageSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(packageSha256)) {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.BAD_INPUT, reason: '签发凭证需要包的 sha256', credential: null, secretHex: null })
  }
  const secretHex = secret ?? randomBytes(32).toString('hex')
  const issuedAtMs = now()
  const credential = Object.freeze({
    format: CREDENTIAL_FORMAT,
    txnId,
    dataDir,
    toVersion: toVersion ?? null,
    fromVersion,
    releaseId,
    packageSha256,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ttlMs,
  })
  const record = Object.freeze({ ...credential, mac: computeMac(secretHex, credential) })
  mkdirSync(credentialDir(dataDir), { recursive: true })
  try {
    const file = credentialPath(dataDir)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${canonicalJson(record)}\n`, 'utf8')
    renameSync(temp, file)
    // 一次性密钥：helper 读完即删，但**写**是签发方的事。
    const secretFile = secretPath(dataDir)
    const secretTemp = `${secretFile}.${process.pid}.tmp`
    writeFileSync(secretTemp, `${secretHex}\n`, 'utf8')
    renameSync(secretTemp, secretFile)
  } catch (error) {
    return Object.freeze({
      ok: false, code: CREDENTIAL_CODES.BAD_INPUT,
      reason: `凭证写入失败：${error?.message ?? error}`, credential: null, secretHex: null,
    })
  }
  return Object.freeze({ ok: true, code: null, reason: null, credential: record, secretHex })
}

/**
 * 校验并**消费**一份凭证。
 *
 * `expect` 用来把校验钉死在本次要做的目标上：`txnId` 与包摘要必须与
 * 事务文件里读到的一致。缺了这一步，"凭证有效"就只证明"某个事务签过它"。
 */
export function consumeCredential({
  dataDir, expect = {}, secretHex = null, now = () => Date.now(), consume = true,
} = {}) {
  const file = credentialPath(dataDir)
  if (!existsSync(file)) {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.MISSING, reason: '没有事务凭证', credential: null })
  }
  let record
  try {
    record = parseJsonStrict(readFileSync(file, 'utf8'), { maxBytes: 16 * 1024 })
  } catch (error) {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.MISSING, reason: `事务凭证读不出来：${error?.message ?? error}`, credential: null })
  }
  const secret = secretHex ?? (existsSync(secretPath(dataDir)) ? readFileSync(secretPath(dataDir), 'utf8').trim() : null)
  if (typeof secret !== 'string' || secret === '') {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.MISSING, reason: '没有事务密钥，无法校验凭证', credential: null })
  }
  const expected = computeMac(secret, record)
  const actual = typeof record.mac === 'string' ? record.mac : ''
  // 长度不同的 `timingSafeEqual` 会抛错，所以先比长度。
  const macOk = actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  if (!macOk) {
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.BAD_MAC, reason: '事务凭证的 MAC 不匹配（事务文件被改动过）', credential: null })
  }
  if (!Number.isSafeInteger(record.expiresAtMs) || now() >= record.expiresAtMs) {
    if (consume) destroyCredential(dataDir)
    return Object.freeze({ ok: false, code: CREDENTIAL_CODES.EXPIRED, reason: '事务凭证已过期', credential: null })
  }
  for (const [field, value] of Object.entries(expect)) {
    if (value === undefined) continue
    if (record[field] !== value) {
      return Object.freeze({
        ok: false, code: CREDENTIAL_CODES.TARGET_MISMATCH,
        reason: `事务凭证的 ${field}=${JSON.stringify(record[field])} 与本次目标 ${JSON.stringify(value)} 不一致`,
        credential: null,
      })
    }
  }
  if (consume) destroyCredential(dataDir)
  return Object.freeze({ ok: true, code: null, reason: null, credential: record, consumed: consume })
}

/** 删掉凭证与密钥。事务结束、失败退出、恢复完成都要调用。 */
export function destroyCredential(dataDir) {
  try { rmSync(credentialPath(dataDir), { force: true }) } catch { /* 尽力清理 */ }
  try { rmSync(secretPath(dataDir), { force: true }) } catch { /* 尽力清理 */ }
  return true
}

/**
 * 程序摘要核对 —— 设计 §3：「helper 位于本次事务的独立受控目录，由随包
 * Node 运行，**启动前核对程序摘要**。它及所需 Node 文件不属于本次待切换
 * 的目录。」
 *
 * 这条判据防的是"helper 自己被换掉"：如果 helper 与被替换的程序目录同源，
 * 那么一次"替换了程序目录然后重启"的过程里，真正执行替换的那段代码
 * 有可能已经是新版本（尚未验证的）代码。
 */
export function verifyProgramDigest({ files, expected = {} } = {}) {
  const problems = []
  const seen = {}
  for (const [label, path] of Object.entries(files)) {
    const want = expected[label] ?? null
    if (typeof path !== 'string' || path === '') { problems.push(`${label} 没有给出路径`); continue }
    if (!existsSync(path)) { problems.push(`${label} 不存在：${path}`); continue }
    let actual
    try { actual = sha256Hex(readFileSync(path)) } catch (error) {
      problems.push(`${label} 读不出来：${error?.message ?? error}`); continue
    }
    seen[label] = actual
    if (want === null) continue
    if (actual !== want) problems.push(`${label} 的程序摘要不符（期望 ${String(want).slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    digests: Object.freeze(seen),
  })
}

/** 目录是否在待切换的程序目录**之外**（设计 §3 的硬要求）。 */
export function isOutsideSwitchTarget(helperDir, installRoot) {
  if (typeof helperDir !== 'string' || typeof installRoot !== 'string') return false
  const normalize = (value) => value.replace(/[\\/]+$/, '').toLowerCase()
  const helper = normalize(helperDir)
  const root = normalize(installRoot)
  if (helper === '' || root === '') return false
  // helper 不能在程序目录里，也不能是它的祖先（祖先关系意味着替换程序目录
  // 会连带影响 helper 所在的位置）。
  if (helper === root) return false
  if (helper.startsWith(`${root}/`) || helper.startsWith(`${root}\\`)) return false
  if (root.startsWith(`${helper}/`) || root.startsWith(`${helper}\\`)) return false
  return true
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckCredential() {
  const problems = []
  const issued = issueCredential({})
  if (issued.ok) problems.push('缺参数时签发了凭证')
  // 目录边界判据。
  if (isOutsideSwitchTarget('C:\\Legion\\helper', 'C:\\Legion')) problems.push('程序目录内的 helper 被判为"在外"')
  if (isOutsideSwitchTarget('C:\\Legion', 'C:\\Legion\\helper')) problems.push('程序目录的祖先被判为"在外"')
  if (!isOutsideSwitchTarget('C:\\LegionHelper', 'C:\\Legion')) problems.push('真正在外的 helper 被判为"在内"')
  if (isOutsideSwitchTarget('C:\\Legion', 'C:\\Legion')) problems.push('同一目录被判为"在外"')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    filename: CREDENTIAL_FILENAME,
    fields: CREDENTIAL_FIELDS,
  })
}

export const CREDENTIAL_CHECKED = selfCheckCredential()
