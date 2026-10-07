// product/update/semver.mjs
// ============================================================================
// SemVer 2.0.0 优先级 —— 设计 §6（line 136）点名要求补上的一块
//
// 原话：「按 SemVer 比较，不能按字符串排序；现有比较函数对预发布标识采用
// 字典序，接入 canary/internal 前必须修正或使用已验证的 SemVer 实现。」
//
// 现有实现（`product/upgrade/manifest.mjs` 的 `compareVersions`）在三段数字上
// 是对的，在预发布段上用的是 `'a' < 'b'` 这样的**字典序**。字典序在
// SemVer 里错两处：
//
//   ① **数字标识符要按数值比，不是按字符比。**
//      `1.0.0-rc.10` 与 `1.0.0-rc.9`：字典序下 `'10' < '9'`（第一个字符
//      `'1' < '9'`），于是 rc.10 被判成**早于** rc.9。修正版按数值比，
//      rc.10 > rc.9。一个把 rc.10 当成旧版本的客户端会永远停在 rc.9。
//
//   ② **数字标识符低于字母标识符**，且比较是逐字段的。
//      `1.0.0-1` < `1.0.0-alpha`（SemVer 规定），字典序下 `'1' < 'a'` 恰好
//      也对——但 `1.0.0-alpha.1` 与 `1.0.0-alpha.beta` 这类多位比较就要
//      逐字段走，字典序在字段边界上会给出错误结果。
//
// 另外 build metadata（`+` 之后）**不参与**优先级比较，但也不能让
// `1.0.0+build.2` 与 `1.0.0+build.1` 被当成同一个版本——它们字符串不同，
// 而"同一版本不同字节必须用不同 releaseId"这条（设计 §4 line 78）
// 要求上游能区分它们。所以这里返回 `equal` 的同时把 build 也读出来，
// 由上层的身份判定（releaseId + 摘要）负责"同版本不同字节"。
//
// ## 为什么保留一个"字典序读数"
//
// 修正一个比较函数最怕的是"改了之后没人知道改了哪里"。所以本模块同时提供
// `legacyPrecedence`（复刻现有字典序行为）与 `precedenceDifferences()`：
// 后者列举一组真实版本里两种口径**结论不同**的那些对。它是这段修正的
// 证据，也是一份回归测试的输入。
// ============================================================================

export const SEMVER_CODES = Object.freeze({
  MALFORMED: 'semver-malformed',
})

/** 严格 SemVer 2.0.0 语法。位数为 0 时缺省，其余按规范。 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function semverError(message) {
  const error = new Error(message)
  error.code = SEMVER_CODES.MALFORMED
  return error
}

/**
 * 解析成结构化版本。**严格**：`^1.0.0`、`v1.0.0`、`1.0`、`1.0.0-` 都不是版本。
 *
 * 宽松解析在这里是危险的：一个"能解析 `^1.0.0`"的解析器会把一个范围
 * 悄悄当成精确版本，而"精确"正是设计 §9.1 反复强调的那件事。
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > 128) return null
  const m = SEMVER_RE.exec(text)
  if (m === null) return null
  return Object.freeze({
    raw: text,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : Object.freeze(m[4].split('.')),
    build: m[5] === undefined ? null : Object.freeze(m[5].split('.')),
  })
}

export function isSemver(value) {
  return parseSemver(value) !== null
}

/** 预发布标识符的比较：数字按数值、数字 < 字母、字母按 ASCII 字典序。 */
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    const an = Number(a)
    const bn = Number(b)
    if (an === bn) return 0
    return an < bn ? -1 : 1
  }
  // ★ SemVer 2.0.0 §11.4.3：数字标识符的优先级**总是低于**字母标识符。
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * SemVer 2.0.0 优先级比较。build metadata 不参与（规范如此）。
 *
 * @returns {-1|0|1}
 * @throws 版本不合法时抛 `semver-malformed`。**不**回退到字符串比较：
 *   一个"解析不了就按字符串比"的兜底会让非法版本静默参与升级判定。
 */
export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a
  const pb = typeof b === 'string' ? parseSemver(b) : b
  if (pa === null || pb === null) {
    throw semverError(`无法比较版本：${JSON.stringify(a)} / ${JSON.stringify(b)}`)
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.prerelease === null && pb.prerelease === null) return 0
  // 有预发布段的**小于**同号正式版。
  if (pa.prerelease === null) return 1
  if (pb.prerelease === null) return -1
  const len = Math.min(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const verdict = compareIdentifier(pa.prerelease[i], pb.prerelease[i])
    if (verdict !== 0) return verdict
  }
  // 前缀相同：字段多的那个更大（1.0.0-alpha < 1.0.0-alpha.1）。
  if (pa.prerelease.length === pb.prerelease.length) return 0
  return pa.prerelease.length < pb.prerelease.length ? -1 : 1
}

/** 不抛版本。解析不了就 `null`——调用方必须自己决定要不要拒。 */
export function tryCompareSemver(a, b) {
  try { return compareSemver(a, b) } catch { return null }
}

export function isNewer(candidate, current) {
  return compareSemver(candidate, current) > 0
}

export function isSameCoreVersion(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) return false
  return pa.major === pb.major && pa.minor === pb.minor && pa.patch === pb.patch
}

/**
 * 复刻 `product/upgrade/manifest.mjs` 现有口径（预发布段按字典序整串比较）。
 *
 * 保留它是为了**能量化**这次修正：`precedenceDifferences()` 用它做对照。
 * 生产路径不得调用它。
 */
export function legacyPrecedence(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === null || pb === null) throw semverError(`无法比较版本：${JSON.stringify(a)} / ${JSON.stringify(b)}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  const aPre = pa.prerelease === null ? null : pa.prerelease.join('.')
  const bPre = pb.prerelease === null ? null : pb.prerelease.join('.')
  if (aPre === null && bPre === null) return 0
  if (aPre === null) return 1
  if (bPre === null) return -1
  if (aPre === bPre) return 0
  return aPre < bPre ? -1 : 1
}

/**
 * 一组真实会出现的版本。用它做两件事：回归测试的输入，以及下面那份差异清单。
 * canary/internal 通道的版本号形态就在这里（rc / beta / alpha 带数字字段）。
 */
export const SEMVER_FIXTURES = Object.freeze([
  '0.9.0', '0.9.1', '0.10.0', '1.0.0',
  '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
  '1.0.0-rc.1', '1.0.0-rc.9', '1.0.0-rc.10',
  '1.0.0-1', '1.0.0-2',
  '1.0.0+build.1', '1.0.0+build.2',
  '1.0.1-rc.1', '1.1.0-rc.1', '2.0.0-rc.1',
])

/**
 * 两种口径结论不同的版本对。
 *
 * 这不是"列出所有差异"，而是"列出**会影响升级判定**的差异"：这里的每一对
 * 在字典序下会得出与 SemVer 相反的结论。canary 通道一旦开起来，
 * 这些就是"客户端永远停在 rc.9"的那一类 bug。
 */
export function precedenceDifferences(fixtures = SEMVER_FIXTURES) {
  const out = []
  for (let i = 0; i < fixtures.length; i += 1) {
    for (let j = 0; j < fixtures.length; j += 1) {
      if (i === j) continue
      const strict = compareSemver(fixtures[i], fixtures[j])
      const legacy = legacyPrecedence(fixtures[i], fixtures[j])
      if (strict !== legacy) out.push(Object.freeze({ a: fixtures[i], b: fixtures[j], strict, legacy }))
    }
  }
  return Object.freeze(out)
}

/** 排序（升序），供发布端列候选。 */
export function sortSemver(versions) {
  return [...versions].sort(compareSemver)
}

/**
 * 「允许从这个版本升到那个版本」的判定。
 *
 * 设计 §5 的 `supportedFromVersions` 是一个**精确集合**，首期只验证
 * N-1 → N。所以这里是集合成员判定，不是范围判定——一个"看起来像版本"
 * 的字符串不在集合里就是不支持，没有插值空间。
 */
export function isSupportedFrom(currentVersion, supportedFromVersions) {
  if (!Array.isArray(supportedFromVersions)) return false
  return supportedFromVersions.includes(currentVersion)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检。判据来自 SemVer 2.0.0 §11 的官方例子链：
 *
 *   1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta
 *     < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
 */
export function selfCheckSemver() {
  const problems = []
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 0; i + 1 < chain.length; i += 1) {
    if (compareSemver(chain[i], chain[i + 1]) >= 0) {
      problems.push(`官方例子链断裂：${chain[i]} 应小于 ${chain[i + 1]}`)
    }
  }

  // ★ 这条是本次修正的**核心**：rc.10 必须大于 rc.9。
  if (compareSemver('1.0.0-rc.10', '1.0.0-rc.9') <= 0) problems.push('rc.10 没有被判为新于 rc.9')
  if (legacyPrecedence('1.0.0-rc.10', '1.0.0-rc.9') !== -1) {
    problems.push('自检前提失效：旧口径不再把 rc.10 判为早于 rc.9（说明对照实现变了）')
  }
  // 数字标识符低于字母标识符。
  if (compareSemver('1.0.0-1', '1.0.0-alpha') >= 0) problems.push('数字标识符没有被判为低于字母标识符')
  // 三段数字按数值。
  if (compareSemver('0.10.0', '0.9.0') <= 0) problems.push('0.10.0 没有被判为新于 0.9.0')
  // build metadata 不参与优先级。
  if (compareSemver('1.0.0+build.1', '1.0.0+build.2') !== 0) problems.push('build metadata 参与了优先级比较')
  if (parseSemver('1.0.0+build.1').build.join('.') !== 'build.1') problems.push('build metadata 没有被解析出来')

  // 非法版本必须被拒（且**不是**回退到字符串比较）。
  for (const bad of ['^1.0.0', 'v1.0.0', '1.0', '1.0.0-', '1.0.0+', '01.0.0', '1.0.0-01', '', 'latest']) {
    if (parseSemver(bad) !== null) problems.push(`非法版本被解析成功：${JSON.stringify(bad)}`)
  }
  const diff = precedenceDifferences()
  if (diff.length === 0) problems.push('两种口径在样本上没有差异——对照实现可能已经不是旧口径了')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    officialChain: Object.freeze(chain),
    differences: diff,
    differenceCount: diff.length,
    parsed: Object.freeze({
      prerelease: parseSemver('1.0.0-rc.10')?.prerelease ?? null,
      build: parseSemver('1.0.0+build.2')?.build ?? null,
    }),
  })
}

export const SEMVER_CHECKED = selfCheckSemver()
