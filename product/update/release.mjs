// product/update/release.mjs
// ============================================================================
// 发行清单 —— 设计 §5 的 `legion/update-release@1`
//
// 通道清单（feed）说"现在该看哪个 releaseId"，发行清单说"那个发行是什么、
// 有哪些产物、从哪些版本能升上来"。两者分开是因为它们的**可变性**不同：
// 通道清单会随每次发布被替换，发行清单一旦上传就不可覆盖（设计 §4 line 78）。
//
// ## 路径安全是这里最重要的东西
//
// 设计 §5 line 124 有一句话，它把一大类漏洞一次说完了：
//
//   「路径为固定 origin 下的相对路径，禁止绝对地址、父目录穿越、编码绕过
//     和跨 origin 重定向。」
//
// 这四件事是同一个攻击的四种写法：让客户端去取**另一个地方**的文件，
// 而客户端以为自己取的是发布目录里的东西。所以本模块的立场是：
//
//   · 路径里**出现 `%` 就拒**。不做百分号解码，也就不存在"解码之后才
//     发现是 `../`"这条路径——因为根本没有解码这一步。
//   · 路径里**出现 `\` 就拒**（Windows 上 `\` 是分隔符，`a\..\b` 在
//     POSIX 实现里是普通文件名，在 Windows 客户端里是穿越）。
//   · 路径必须是相对的、非空的、每段都在一个很窄的字符集里。
//   · 绝对 URL（含 `://`）、`//host` 协议相对地址一律拒。
//
// 一个"先检查后拼接再交给 URL 库"的实现看起来也能防住这些，但它把安全性
// 交给了 URL 库的规范化行为——而那个行为在编码、大小写、驱动器字母上
// 各有各的规矩。这里选择的是**让危险形态根本无法通过校验**。
//
// ## 为什么产物摘要和大小要一起校验
//
// 只有摘要没有大小时，"下载前先看磁盘够不够"做不到（设计 §5 的
// `requiredFreeBytes` 与 §6 的流式限长都要求准确大小）；只有大小没有摘要时，
// 内容被替换无法发现。两个都要，且都要和实际下载到的字节对上。
// ============================================================================

import { createHash } from 'node:crypto'

import { ENVELOPE_FORMATS } from './envelope.mjs'
import { canonicalJson as canonicalOf, isSha256Hex } from './canonical.mjs'
import { RELEASE_CHANNELS } from '../upgrade/channels.mjs'
import { isSemver, parseSemver } from './semver.mjs'

export const RELEASE_FORMAT = ENVELOPE_FORMATS.RELEASE

/** 已知平台/架构。首期只有 Windows x64（设计 §1 范围）。 */
export const KNOWN_PLATFORMS = Object.freeze({ win32: Object.freeze(['x64']) })

/**
 * 允许的发布目录相对路径字符集。
 *
 * 注意里面**没有** `%`。这不是疏漏，是设计选择：见文件头注释。
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PATH_LENGTH = 512

export const RELEASE_CODES = Object.freeze({
  BAD_FORMAT: 'release-bad-format',
  BAD_PATH: 'release-bad-path',
  BAD_FIELD: 'release-bad-field',
  BAD_ARTIFACT: 'release-bad-artifact',
  BAD_DIGEST: 'release-bad-digest',
  UNSUPPORTED_PLATFORM: 'release-unsupported-platform',
  IDENTITY_MISMATCH: 'release-identity-mismatch',
  BAD_VERSION_WINDOW: 'release-bad-version-window',
  BAD_MIGRATION_PLAN: 'release-bad-migration-plan',
})

/** 是否允许"只回退程序"。设计 §8 的失败表按这个策略分档。 */
export const ROLLBACK_POLICIES = Object.freeze([
  /** 只换程序，数据不动（全 additive 迁移时成立）。 */
  'program-only',
  /** 必须从升级前备份恢复数据库。 */
  'backup-restore',
  /** 不能回退，只能向前修复。 */
  'forward-fix-only',
])

export const ARTIFACT_KINDS = Object.freeze(['package', 'installer', 'notes'])

function releaseProblem(code, message, field = null) {
  return Object.freeze({ code, message, field })
}

/**
 * 校验一条发布目录下的相对路径。
 *
 * @returns {{ok: true, path: string} | {ok: false, code: string, reason: string}}
 */
export function validateRelativePath(value, { field = 'path', allowSubdirDepth = 4 } = {}) {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 必须是非空字符串` }
  }
  if (value.length > MAX_PATH_LENGTH) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 超过 ${MAX_PATH_LENGTH} 字符` }
  }
  // 编码绕过：任何 `%` 都不放行。不做解码，就没有"解码之后才是 `../`"。
  if (value.includes('%')) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 含百分号编码（拒绝编码绕过）：${value}` }
  }
  if (value.includes('\\')) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 含反斜杠（Windows 上是分隔符）：${value}` }
  }
  if (value.startsWith('/') || value.startsWith('//')) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 不能是绝对路径或协议相对地址：${value}` }
  }
  if (value.includes('://')) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 不能是绝对 URL：${value}` }
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 含控制字符` }
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '')) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 含空路径段：${value}` }
  }
  if (segments.length > allowSubdirDepth + 1) {
    return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 目录层级过深：${value}` }
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 含父目录/当前目录段：${value}` }
    }
    if (!SAFE_SEGMENT_RE.test(segment)) {
      return { ok: false, code: RELEASE_CODES.BAD_PATH, reason: `${field} 的路径段 ${JSON.stringify(segment)} 不在允许字符集内` }
    }
  }
  return { ok: true, code: null, reason: null, path: value, segments: Object.freeze(segments) }
}

function artifactProblems(kind, artifact, problems) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_ARTIFACT, `${kind} 必须是对象`, kind))
    return
  }
  const keys = Object.keys(artifact).sort()
  if (keys.join(',') !== 'path,sha256,sizeBytes') {
    problems.push(releaseProblem(RELEASE_CODES.BAD_ARTIFACT, `${kind} 的字段必须是 path/sizeBytes/sha256，实际 ${keys.join(',')}`, kind))
    return
  }
  const pathCheck = validateRelativePath(artifact.path, { field: `${kind}.path` })
  if (!pathCheck.ok) problems.push(releaseProblem(pathCheck.code, pathCheck.reason, `${kind}.path`))
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_ARTIFACT, `${kind}.sizeBytes 必须是正的安全整数`, `${kind}.sizeBytes`))
  } else if (artifact.sizeBytes > 8 * 1024 * 1024 * 1024) {
    // 8 GiB：一个"大小字段被塞了天文数字"的清单会让磁盘预检算出无意义的结论。
    problems.push(releaseProblem(RELEASE_CODES.BAD_ARTIFACT, `${kind}.sizeBytes 大到不合理`, `${kind}.sizeBytes`))
  }
  if (!isSha256Hex(artifact.sha256)) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_DIGEST, `${kind}.sha256 必须是 64 位小写十六进制`, `${kind}.sha256`))
  }
}

/**
 * 校验一份发行清单 payload。
 *
 * `expect` 用来把"这份清单说的是不是我要的那个发行"钉死：通道清单里已经有
 * releaseId/productVersion/channel/platform/arch，两者不一致就是一次
 * "清单被换掉"的事件，必须在下载之前发现（设计 §6 line 138）。
 */
export function validateRelease(payload, {
  expect = null,
  nowUnixMs = null,
  minWindowsBuildRequired = null,
} = {}) {
  const problems = []
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({
      ok: false, code: RELEASE_CODES.BAD_FORMAT, problems: Object.freeze([releaseProblem(RELEASE_CODES.BAD_FORMAT, '发行清单必须是对象')]),
      release: null,
    })
  }
  if (payload.format !== RELEASE_FORMAT) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_FORMAT, `format 必须是 ${RELEASE_FORMAT}，实际 ${JSON.stringify(payload.format)}`, 'format'))
  }

  for (const [field, predicate, describe] of [
    ['releaseId', (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v), '1–128 字符的标识符'],
    ['productVersion', (v) => typeof v === 'string' && isSemver(v), 'SemVer 2.0.0 版本'],
    ['channel', (v) => RELEASE_CHANNELS.includes(v), `通道 ${RELEASE_CHANNELS.join('/')}`],
    ['platform', (v) => Object.hasOwn(KNOWN_PLATFORMS, v), `平台 ${Object.keys(KNOWN_PLATFORMS).join('/')}`],
    ['arch', (v) => typeof v === 'string' && /^[a-z0-9]{1,16}$/.test(v), '小写架构名'],
    ['migrationPlanDigest', (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), '64 位十六进制迁移计划摘要'],
    ['productManifestSha256', (v) => isSha256Hex(v), '64 位十六进制产品清单摘要'],
  ]) {
    if (!predicate(payload[field])) {
      problems.push(releaseProblem(RELEASE_CODES.BAD_FIELD, `${field} 必须是${describe}，实际 ${JSON.stringify(payload[field])}`, field))
    }
  }

  if (payload.platform === 'win32' && !KNOWN_PLATFORMS.win32.includes(payload.arch)) {
    problems.push(releaseProblem(RELEASE_CODES.UNSUPPORTED_PLATFORM, `win32 只支持 ${KNOWN_PLATFORMS.win32.join('/')}`, 'arch'))
  }

  // 产品清单：必须是对象（精确组件版本的载体）。这里不重复校验它的 schema，
  // 那是 `product/upgrade/manifest.mjs` 的职责；这里只保证"它被摘要钉住了"。
  if (payload.productManifest === null || typeof payload.productManifest !== 'object' || Array.isArray(payload.productManifest)) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_FIELD, 'productManifest 必须是对象', 'productManifest'))
  } else {
    const actual = sha256OfCanonical(payload.productManifest)
    if (isSha256Hex(payload.productManifestSha256) && actual !== payload.productManifestSha256) {
      problems.push(releaseProblem(RELEASE_CODES.BAD_DIGEST,
        `productManifestSha256 与实际内容不符：声明 ${payload.productManifestSha256}，实际 ${actual}`, 'productManifestSha256'))
    }
    // 清单里的 productVersion 必须与发行清单一致：一处写 1.2.0、另一处写 1.3.0
    // 的发行，会让"我升到了哪个版本"这个问题有两个答案。
    if (typeof payload.productManifest.productVersion === 'string'
      && payload.productManifest.productVersion !== payload.productVersion) {
      problems.push(releaseProblem(RELEASE_CODES.IDENTITY_MISMATCH,
        `productManifest.productVersion=${payload.productManifest.productVersion} 与发行的 productVersion=${payload.productVersion} 不一致`,
        'productVersion'))
    }
  }

  if (!Array.isArray(payload.supportedFromVersions) || payload.supportedFromVersions.length === 0) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_VERSION_WINDOW, 'supportedFromVersions 必须是非空数组（首期只验证 N-1 → N）', 'supportedFromVersions'))
  } else {
    for (const version of payload.supportedFromVersions) {
      if (!isSemver(version)) {
        problems.push(releaseProblem(RELEASE_CODES.BAD_VERSION_WINDOW, `supportedFromVersions 含非法版本 ${JSON.stringify(version)}`, 'supportedFromVersions'))
        continue
      }
      // "允许从自己升到自己"毫无意义，而且通常是发布端把版本号填错了。
      if (version === payload.productVersion) {
        problems.push(releaseProblem(RELEASE_CODES.BAD_VERSION_WINDOW, 'supportedFromVersions 不能包含目标版本自身', 'supportedFromVersions'))
        continue
      }
      const from = parseSemver(version)
      const to = parseSemver(payload.productVersion)
      if (from !== null && to !== null && compareCore(from, to) >= 0) {
        problems.push(releaseProblem(RELEASE_CODES.BAD_VERSION_WINDOW,
          `supportedFromVersions 里的 ${version} 不低于目标版本 ${payload.productVersion}（不支持降级）`, 'supportedFromVersions'))
      }
    }
  }

  if (!Number.isSafeInteger(payload.requiredFreeBytes) || payload.requiredFreeBytes <= 0) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_FIELD, 'requiredFreeBytes 必须是正的安全整数', 'requiredFreeBytes'))
  }
  if (!Number.isSafeInteger(payload.minWindowsBuild) || payload.minWindowsBuild <= 0) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_FIELD, 'minWindowsBuild 必须是正的安全整数', 'minWindowsBuild'))
  } else if (Number.isSafeInteger(minWindowsBuildRequired) && payload.minWindowsBuild > minWindowsBuildRequired) {
    problems.push(releaseProblem(RELEASE_CODES.UNSUPPORTED_PLATFORM,
      `需要 Windows build ${payload.minWindowsBuild}，本机是 ${minWindowsBuildRequired}`, 'minWindowsBuild'))
  }
  if (!ROLLBACK_POLICIES.includes(payload.rollbackPolicy)) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_FIELD, `rollbackPolicy 必须是 ${ROLLBACK_POLICIES.join('/')}`, 'rollbackPolicy'))
  }

  for (const kind of ARTIFACT_KINDS) {
    artifactProblems(kind, payload[kind] ?? null, problems)
  }

  // 一致性约束：产物之间不能互相覆盖同一个路径。
  const paths = ARTIFACT_KINDS.map((kind) => payload[kind]?.path).filter((p) => typeof p === 'string')
  if (new Set(paths).size !== paths.length) {
    problems.push(releaseProblem(RELEASE_CODES.BAD_ARTIFACT, `产物路径重复：${paths.join(' / ')}`, null))
  }

  if (expect !== null) {
    for (const field of ['releaseId', 'productVersion', 'channel', 'platform', 'arch']) {
      if (expect[field] !== undefined && expect[field] !== payload[field]) {
        problems.push(releaseProblem(RELEASE_CODES.IDENTITY_MISMATCH,
          `发行清单的 ${field}=${JSON.stringify(payload[field])} 与通道清单的 ${JSON.stringify(expect[field])} 不一致`, field))
      }
    }
  }

  if (problems.length > 0) {
    const first = problems[0]
    return Object.freeze({ ok: false, code: first.code, reason: first.message, problems: Object.freeze(problems), release: null })
  }

  // 冻结一份**只含已知字段**的副本：清单将来多一个字段时，客户端不该
  // 因为"不认识"而带进后续逻辑。
  return Object.freeze({
    ok: true, code: null, reason: null, problems: Object.freeze([]),
    release: Object.freeze({
      format: RELEASE_FORMAT,
      releaseId: payload.releaseId,
      productVersion: payload.productVersion,
      channel: payload.channel,
      platform: payload.platform,
      arch: payload.arch,
      productManifest: payload.productManifest,
      productManifestSha256: payload.productManifestSha256,
      supportedFromVersions: Object.freeze([...payload.supportedFromVersions]),
      minWindowsBuild: payload.minWindowsBuild,
      requiredFreeBytes: payload.requiredFreeBytes,
      package: payload.package,
      installer: payload.installer,
      notes: payload.notes,
      migrationPlanDigest: payload.migrationPlanDigest,
      rollbackPolicy: payload.rollbackPolicy,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      nowUnixMs,
    }),
  })
}

function compareCore(from, to) {
  for (const key of ['major', 'minor', 'patch']) {
    if (from[key] !== to[key]) return from[key] < to[key] ? -1 : 1
  }
  return 0
}

/** 规范化摘要（与 canonical.mjs 同一口径，避免两处各算一份）。 */
function sha256OfCanonical(value) {
  return createHash('sha256').update(canonicalOf(value), 'utf8').digest('hex')
}

/** 构造一份发行清单。发布端用它，客户端只读它。 */
export function buildRelease({
  releaseId, productVersion, channel, platform = 'win32', arch = 'x64',
  productManifest, supportedFromVersions, minWindowsBuild, requiredFreeBytes,
  package: pkg, installer, notes, migrationPlanDigest, rollbackPolicy, issuedAt, expiresAt,
} = {}) {
  return Object.freeze({
    format: RELEASE_FORMAT,
    releaseId,
    productVersion,
    channel,
    platform,
    arch,
    productManifest,
    productManifestSha256: sha256OfCanonical(productManifest),
    supportedFromVersions: Object.freeze([...supportedFromVersions]),
    minWindowsBuild,
    requiredFreeBytes,
    package: pkg,
    installer,
    notes,
    migrationPlanDigest,
    rollbackPolicy,
    issuedAt,
    expiresAt,
  })
}

/** 由字节构造一个产物描述（发布端在写完文件之后用它）。 */
export function artifactFromBytes(path, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return Object.freeze({
    path: validateRelativePath(path).ok ? path : null,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  })
}

/** 发行身份：候选必须以 releaseId、版本和摘要**共同**标识（设计 §6 line 138）。 */
export function releaseIdentity(release, feedManifestSha256 = null) {
  if (release === null || typeof release !== 'object') return null
  return Object.freeze({
    releaseId: release.releaseId ?? null,
    productVersion: release.productVersion ?? null,
    channel: release.channel ?? null,
    platform: release.platform ?? null,
    arch: release.arch ?? null,
    manifestSha256: feedManifestSha256 ?? release.productManifestSha256 ?? null,
  })
}

/** 两个身份是不是同一个候选。用户确认绑定的是它，不是"最新版"这个说法。 */
export function sameIdentity(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false
  return a.releaseId === b.releaseId && a.productVersion === b.productVersion
    && a.channel === b.channel && a.platform === b.platform && a.arch === b.arch
    && a.manifestSha256 === b.manifestSha256
}

/** 身份的可读串（用于日志、状态展示与"确认绑定"的界面文案）。 */
export function identityLabel(identity) {
  if (identity === null || identity === undefined) return '(无候选)'
  const digest = typeof identity.manifestSha256 === 'string' ? identity.manifestSha256.slice(0, 12) : '?'
  return `${identity.releaseId ?? '?'}@${identity.productVersion ?? '?'}(${identity.channel ?? '?'}/${identity.platform ?? '?'}-${identity.arch ?? '?'}#${digest})`
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 样例产品清单。
 *
 * ★ 字段名必须与仓库里真正的 `product/release/runtime-manifest.json` 一致：
 *   格式字段叫 **`manifestFormat`**（不是 `format`），而且
 *   `runtimeContractVersion`/`packProtocolVersion`/`schemaVersion` 是必需的。
 *
 *   早先这里写的是 `format`，而 `validateRelease` 只检查"它是个对象 +
 *   摘要对得上 + 版本一致"，所以样例一路通过——直到发布脚本真的去调
 *   `validateManifest` 才暴露。一份"看起来对但字段名不对"的样例，正是让
 *   判据在**最不该暴露的时刻**才暴露的原因。
 */
function sampleProductManifest(productVersion = '1.1.0') {
  return {
    manifestFormat: 'legion/version-manifest@1',
    productVersion,
    legionVersion: productVersion,
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    schemaVersion: 1,
    channel: 'stable',
    releasedAt: '2026-10-03T00:00:00.000Z',
  }
}

export function sampleRelease({ productVersion = '1.1.0', releaseId = 'rel-1.1.0' } = {}) {
  const manifest = sampleProductManifest(productVersion)
  return buildRelease({
    releaseId,
    productVersion,
    channel: 'stable',
    productManifest: manifest,
    supportedFromVersions: ['1.0.0'],
    minWindowsBuild: 19045,
    requiredFreeBytes: 2 * 1024 * 1024 * 1024,
    package: { path: `releases/${releaseId}/legion-win-x64.zip`, sizeBytes: 1024, sha256: 'b'.repeat(64) },
    installer: { path: `releases/${releaseId}/Legion-Setup-win-x64.exe`, sizeBytes: 2048, sha256: 'c'.repeat(64) },
    notes: { path: `releases/${releaseId}/notes.zh-CN.txt`, sizeBytes: 64, sha256: 'd'.repeat(64) },
    migrationPlanDigest: 'e'.repeat(64),
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-02T00:00:00Z',
    expiresAt: '2026-10-09T00:00:00Z',
  })
}

export function selfCheckRelease() {
  const problems = []
  const good = validateRelease(sampleRelease())
  if (!good.ok) problems.push(`合法发行清单没通过：${good.reason}`)

  const sample = sampleRelease()
  const cases = [
    ['绝对路径', { package: { path: '/etc/passwd', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['绝对 URL', { package: { path: 'https://evil.example/x.zip', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['协议相对', { package: { path: '//evil.example/x.zip', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['父目录穿越', { package: { path: 'releases/../../x.zip', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['编码绕过', { package: { path: 'releases/%2e%2e/x.zip', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['反斜杠穿越', { package: { path: 'releases\\..\\x.zip', sizeBytes: 1, sha256: 'a'.repeat(64) } }],
    ['大小为零', { package: { path: 'releases/a/x.zip', sizeBytes: 0, sha256: 'a'.repeat(64) } }],
    ['摘要太短', { package: { path: 'releases/a/x.zip', sizeBytes: 1, sha256: 'abc' } }],
    ['摘要大写', { package: { path: 'releases/a/x.zip', sizeBytes: 1, sha256: 'A'.repeat(64) } }],
    ['产物路径重复', { installer: { ...sample.installer, path: sample.package.path } }],
    ['缺 notes', { notes: null }],
    ['降级的 supportedFrom', { supportedFromVersions: ['1.2.0'] }],
    ['自指 supportedFrom', { supportedFromVersions: ['1.1.0'] }],
    ['空 supportedFrom', { supportedFromVersions: [] }],
    ['非法回滚策略', { rollbackPolicy: 'whatever' }],
    ['非法迁移摘要', { migrationPlanDigest: 'xyz' }],
    ['产品清单摘要不符', { productManifestSha256: 'f'.repeat(64) }],
    ['产品清单版本不符', { productManifest: sampleProductManifest('9.9.9') }],
    ['未知平台', { platform: 'darwin' }],
    ['win32 非 x64', { arch: 'arm64' }],
  ]
  for (const [name, override] of cases) {
    const result = validateRelease({ ...sample, ...override })
    if (result.ok) problems.push(`「${name}」被接受了`)
  }

  // 身份绑定：通道清单与发行清单不一致必须在下载前被拒。
  const mismatch = validateRelease(sampleRelease(), { expect: { releaseId: 'other', productVersion: '1.1.0' } })
  if (mismatch.ok) problems.push('channel/release 身份不一致没有被拒绝')

  // 身份比较：摘要不同即不同候选。
  const idA = releaseIdentity(sampleRelease(), 'a'.repeat(64))
  const idB = releaseIdentity(sampleRelease(), 'b'.repeat(64))
  if (sameIdentity(idA, idB)) problems.push('摘要不同的两个候选被判为同一身份')
  if (!sameIdentity(idA, releaseIdentity(sampleRelease(), 'a'.repeat(64)))) problems.push('同一候选被判为不同身份')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    rejectedCases: cases.length,
    sample: Object.freeze({
      identity: identityLabel(releaseIdentity(sampleRelease(), 'a'.repeat(64))),
      productManifestSha256: good.release?.productManifestSha256 ?? null,
    }),
  })
}

export const RELEASE_CHECKED = selfCheckRelease()
