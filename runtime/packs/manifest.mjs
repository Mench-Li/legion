// runtime/packs/manifest.mjs
// ============================================================================
// PRT-1001 / PRT-1002：PackManifest、类型、语义版本与协议版本；
// 内容哈希、签名/来源、依赖与兼容性**预检**。
//
// spec §6.13 line 565–570：
//   「`PackManifest`：包 ID、类型、语义版本、协议版本、依赖、兼容条件和内容哈希。
//     只读内容：EmployeeManifest、流水线模板、提示词、Schema、规则、测试样本和文档。
//     明确声明的 Runtime 能力、工具、权限和数据依赖。安装、启用、停用和升级记录。
//     安装时验证签名/来源、内容哈希、`packProtocolVersion`、依赖和产品兼容性……」
//
// ---------------------------------------------------------------------------
// ① 哈希必须**由预检自己算**，不能采信 manifest 里那一行
//
// 最自然的写法是：manifest 里有一个 `contentHash` 字段，安装时拿它去和签名比。
// 它在"包没被改过"的机器上恒真，因为那句比较的两边都来自同一份 manifest：
//
//   > 一个「拿 manifest 里写的 contentHash 去验签名」的预检，
//   > 与一个「签名有效、而被签的东西是另一份内容」的预检，是同一个东西——
//   > 只不过前者在"包有没有被换过"这个问题上永远回答"没有"。
//
// 所以这里有三件事各自独立：**算**（`computeContentHash` 从 files 算）、
// **对表**（manifest 声明的 contents 逐条对 sha256）、**比对**（声明的 contentHash）。
// 三者中任何一条不一致都拒绝，且三条各有自己的码——值班的人要能分清是
// "包被改过"还是"作者忘了更新清单"。
//
// ---------------------------------------------------------------------------
// ② 协议版本是**相等**，不是一个范围
//
// 语义版本有兼容范围，协议版本没有。一个协议版本是"我们两边对同一段字节
// 的理解"，而"更高版本"恰恰意味着**它多带了几个我们不认识的字段**。
//
//   > 一个「`packProtocolVersion >= 1` 就算兼容」的预检，
//   > 与一个「把未来版本的新字段当成没写」的预检，是同一个东西。
//
// 所以协议版本只接受与宿主**完全相等**，范围在这里没有意义。
//
// ---------------------------------------------------------------------------
// ③ "没声明依赖" ≠ "没有依赖"
//
// `dependsOn` 缺失时最容易的写法是 `?? []`，于是这个包"没有依赖"，
// 依赖预检对它恒真——而那正是依赖预检唯一该回答的问题。
//
//   > 一个「缺 `dependsOn` 就当成空依赖表」的预检，
//   > 与一个「依赖这一项对这种包从不生效」的预检，是同一个东西——
//   > 只不过前者在报表上是一条通过的检查。
//
// 所以缺字段是**拒绝**，空依赖表要写成 `dependsOn: []`。同一纪律适用于
// `compatibility`：不声明兼容条件 = 与一切版本兼容 = 什么也没声明。
// ============================================================================

import { createHash } from 'node:crypto'

import { domainSeparatedHash, nfc } from '../contracts/canonical.mjs'
import { FORBIDDEN_MANIFEST_FIELDS } from '../dsh-composition/employee-manifest.mjs'
import { DSH_COMPOSITION_PATCH_VERSION } from '../dsh-composition/patch-layer.mjs'
import { deepFreeze } from '../dsh-composition/tool-args.mjs'

/** 协议版本。与要解析的 manifest **结构**绑定：结构变了必须递增。 */
export const PACK_PROTOCOL_VERSION = 1

/** 归一化后 manifest 的形态版本。 */
export const PACK_MANIFEST_VERSION = 'legion/pack-manifest@1'

/** 内容哈希的 domain separator。与审批哈希、快照哈希都不同（spec §6.5）。 */
export const PACK_CONTENT_DOMAIN = 'legion.pack-content.v1'

/** 内容哈希覆盖的条目 schema 版本。 */
export const PACK_CONTENT_SCHEMA_VERSION = 1

/**
 * 能力包类型。
 *
 * 首版只有两种，而它们决定的是"这个包能不能成为一份 TeamPlan"：
 *   · `team`    —— 自带完整团队方案（员工 + 流水线），可被编译成 CompiledTeamPlan；
 *   · `overlay` —— 只提供提示词 / Schema / 规则等只读内容，**不单独成团**。
 *
 * `overlay` 是刻意保留的一类：没有它，任何只想加一条规则的包都会被逼着
 * 造一份假的团队方案——而"假的团队方案"与"真的"在编译后长得一模一样。
 */
export const PACK_TYPES = Object.freeze(['team', 'overlay'])

/** 来源可信等级。**由宿主算出来**，不是包能声明的（见 `trustOf`）。 */
export const PACK_TRUST_LEVELS = Object.freeze(['builtin', 'signed', 'unsigned'])

/** manifest 允许出现的字段（两个方向都查，见 `assertPackFieldsClosed`）。 */
export const PACK_MANIFEST_FIELDS = Object.freeze([
  'manifestVersion', 'packId', 'packType', 'version', 'packProtocolVersion',
  'contentHash', 'contents', 'entrypoints', 'dependsOn', 'compatibility',
  'requestedPermissions', 'dataDependencies', 'provenance', 'containsSecrets',
])

/** 必须有值的字段。缺一个就不是一个完整的 manifest，而不是"用默认值"。 */
export const REQUIRED_PACK_FIELDS = Object.freeze([
  'manifestVersion', 'packId', 'packType', 'version', 'packProtocolVersion',
  'contentHash', 'contents', 'entrypoints',
])

/** `provenance` 允许出现的字段。**没有 `trustLevel`**——等级由宿主算。 */
export const PROVENANCE_FIELDS = Object.freeze(['signer', 'keyId', 'signature'])

/** 宿主要求 manifest 声明的兼容条件项。缺一项即视为"与什么版本都兼容"。 */
export const HOST_COMPAT_FIELDS = Object.freeze([
  'product', 'packProtocolVersion', 'dshCompositionPatchVersion',
])

export const MANIFEST_CODES = Object.freeze({
  /** manifest 结构不合法（字段缺失、类型不对、归一化失败）。 */
  BAD_MANIFEST: 'pack-manifest-malformed',
  /** manifest 里出现了强制面字段——一个能写这些字段的包就是一个能给自己发权限的包。 */
  FIELD_ON_ENFORCEMENT_PLANE: 'pack-manifest-enforcement-field',
  /** 不认识的包类型。 */
  BAD_TYPE: 'pack-manifest-type-unknown',
  /** 不是语义版本 / 不是范围。 */
  BAD_VERSION: 'pack-manifest-version-malformed',
  /** 协议版本与宿主不相等。 */
  PROTOCOL_MISMATCH: 'pack-manifest-protocol-mismatch',
  /** 宿主版本未知——没有基线时"兼容"这个判断不成立。 */
  HOST_VERSION_UNKNOWN: 'pack-manifest-host-version-unknown',
  /** 内容条目本身不合法（路径、重复、碰撞）。 */
  BAD_CONTENTS: 'pack-manifest-contents-malformed',
  /** 路径穿越 / 绝对路径 / 盘符。 */
  PATH_TRAVERSAL: 'pack-manifest-path-traversal',
  /** 同一个路径出现了两次。 */
  PATH_DUPLICATE: 'pack-manifest-path-duplicate',
  /** 两个路径只差大小写——在 Windows 上是同一个文件。 */
  PATH_COLLISION: 'pack-manifest-path-collision',
  /** 声明的文件表与实际载荷不一致（多一个或少一个，或 sha256 不同）。 */
  CONTENTS_MISMATCH: 'pack-manifest-contents-mismatch',
  /** 声明的 contentHash 与**算出来的**不一致。 */
  CONTENT_HASH_MISMATCH: 'pack-manifest-content-hash-mismatch',
  /** 既不是内置包，也没有验证器给出肯定答复。 */
  PROVENANCE_UNVERIFIED: 'pack-manifest-provenance-unverified',
  /** 非内置包但没有 provenance 字段——"我们不知道它从哪来"。 */
  PROVENANCE_MISSING: 'pack-manifest-provenance-missing',
  /** 兼容范围写成无界（`*` / `latest` / 空串）。 */
  RANGE_UNBOUNDED: 'pack-manifest-range-unbounded',
  /** 范围写法不认识。 */
  RANGE_MALFORMED: 'pack-manifest-range-malformed',
  /** 依赖表缺失（`?? []` 就是这里要防的兜底）。 */
  DEPENDENCY_UNDECLARED: 'pack-manifest-dependency-undeclared',
  /** 依赖自己。 */
  DEPENDENCY_SELF: 'pack-manifest-dependency-self',
  /** 同一个依赖写了两遍。 */
  DEPENDENCY_DUPLICATE: 'pack-manifest-dependency-duplicate',
  /** 依赖没装。 */
  DEPENDENCY_MISSING: 'pack-manifest-dependency-missing',
  /** 依赖装了，但版本不在范围内。 */
  DEPENDENCY_INCOMPATIBLE: 'pack-manifest-dependency-incompatible',
  /** 宿主给的已安装清单里同一个包有两个版本。 */
  INSTALLED_AMBIGUOUS: 'pack-manifest-installed-ambiguous',
  /** 兼容条件缺失。 */
  COMPAT_UNDECLARED: 'pack-manifest-compatibility-undeclared',
  /** 与宿主版本不兼容。 */
  COMPAT_INCOMPATIBLE: 'pack-manifest-incompatible',
  /** 团队包缺少入口（或入口文件不在载荷里）。 */
  ENTRYPOINT_MISSING: 'pack-manifest-entrypoint-missing',
})

function packError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 语义版本
// ---------------------------------------------------------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** 支持的范围算子。**没有通配符**（见 `satisfiesRange`）。 */
export const SEMVER_RANGE_OPERATORS = Object.freeze(['^', '~', '>=', '<=', '>', '<', '='])

/** 无界范围的写法。这些一律拒绝：它们让兼容性这一项**永不失败**。 */
export const UNBOUNDED_RANGES = Object.freeze(['', '*', 'x', 'X', '*.*.*', 'latest', 'any', '>=0.0.0'])

/**
 * 解析一个语义版本。不接受 `v1.2`、`1.2`、`1.2.3.4`。
 *
 * 不接受简写是刻意的：`1.2` 在有的生态里是 `1.2.0`、在有的生态里是范围，
 * 而这里要的是一个**确定的值**——歧义解析与"猜"是同一件事。
 */
export function parseSemver(text) {
  const raw = nfc(String(text ?? '')).trim()
  const m = SEMVER_RE.exec(raw)
  if (m === null) {
    throw packError(
      MANIFEST_CODES.BAD_VERSION,
      `不是合法的语义版本：${JSON.stringify(text)}（要求 major.minor.patch，可带 -prerelease / +build）`,
    )
  }
  return Object.freeze({
    raw,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4],
    build: m[5] === undefined ? null : m[5],
  })
}

/** 是否是合法语义版本（不抛）。 */
export function isSemver(text) {
  try {
    parseSemver(text)
    return true
  } catch {
    return false
  }
}

/** 把一个已解析的版本写回字符串（丢掉 build：build 不参与比较）。 */
export function formatSemver(v) {
  const parsed = typeof v === 'string' ? parseSemver(v) : v
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease === null ? '' : `-${parsed.prerelease}`}`
}

function comparePrerelease(a, b) {
  const x = a.split('.')
  const y = b.split('.')
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i += 1) {
    const xi = x[i]
    const yi = y[i]
    if (xi === yi) continue
    const xn = /^\d+$/.test(xi)
    const yn = /^\d+$/.test(yi)
    // 数字标识符总小于字母标识符；两个数字按数值比（`10` > `9`，不是字符串比）。
    if (xn && yn) return Number(xi) < Number(yi) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return xi < yi ? -1 : 1
  }
  if (x.length === y.length) return 0
  return x.length < y.length ? -1 : 1
}

/**
 * 比较两个版本。`-1` / `0` / `1`。
 *
 * 预发布版本**小于**同号正式版（`1.0.0-alpha < 1.0.0`）——这条不是细节，
 * 它是"先把 alpha 发给愿意冒险的人"这个流程能成立的前提。
 */
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a
  const y = typeof b === 'string' ? parseSemver(b) : b
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  if (x.prerelease === y.prerelease) return 0
  if (x.prerelease === null) return 1
  if (y.prerelease === null) return -1
  return comparePrerelease(x.prerelease, y.prerelease)
}

function upperBoundOf(op, base) {
  if (op === '~') return parseSemver(`${base.major}.${base.minor + 1}.0`)
  // `^`：第一个非零位进位。`^0.2.3` → `0.3.0`，`^0.0.3` → `0.0.4`。
  if (base.major > 0) return parseSemver(`${base.major + 1}.0.0`)
  if (base.minor > 0) return parseSemver(`0.${base.minor + 1}.0`)
  return parseSemver(`0.0.${base.patch + 1}`)
}

const RANGE_RE = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/**
 * 一个版本是否落在范围内。
 *
 * ★ 无界范围（`*` / `latest` / 空串）**抛**，不返回 `true`：
 *
 *   > 一个「接受 `*` 作为兼容范围」的预检，
 *   > 与一个「兼容性这一项对这个包从不生效」的预检，是同一个东西——
 *   > 只不过前者在安装报表上是一条通过的检查。
 *
 * ★ 预发布版本只被**同样带预发布**的范围接受（与 npm semver 一致）：
 *   否则 `^1.2.0` 会连带接受 `1.3.0-beta.1`，而我们从来没测过它。
 */
export function satisfiesRange(version, range) {
  const v = parseSemver(version)
  const raw = nfc(String(range ?? '')).trim()
  if (UNBOUNDED_RANGES.includes(raw)) {
    throw packError(
      MANIFEST_CODES.RANGE_UNBOUNDED,
      `兼容范围是无界的（${JSON.stringify(range)}）。不接受——` +
      '一个"接受 `*`"的范围与一个"不检查兼容性"的范围，在"它到底拦住了什么"上是同一个东西；' +
      '与一切版本兼容等于什么也没声明',
    )
  }
  const m = RANGE_RE.exec(raw)
  if (m === null) {
    throw packError(
      MANIFEST_CODES.RANGE_MALFORMED,
      `不认识的范围写法 ${JSON.stringify(range)}（支持 ${SEMVER_RANGE_OPERATORS.join(' / ')} 加完整三段版本）`,
    )
  }
  const op = m[1] ?? '='
  const base = parseSemver(m[2])
  if (v.prerelease !== null && base.prerelease === null) return false
  switch (op) {
    case '=': return compareSemver(v, base) === 0
    case '>': return compareSemver(v, base) > 0
    case '>=': return compareSemver(v, base) >= 0
    case '<': return compareSemver(v, base) < 0
    case '<=': return compareSemver(v, base) <= 0
    case '^':
    case '~':
      return compareSemver(v, base) >= 0 && compareSemver(v, upperBoundOf(op, base)) < 0
    default:
      throw packError(MANIFEST_CODES.RANGE_MALFORMED, `未实现的算子 ${JSON.stringify(op)}`)
  }
}

// ---------------------------------------------------------------------------
// 内容与内容哈希
// ---------------------------------------------------------------------------

function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function normalizePackPath(input) {
  const raw = nfc(String(input ?? ''))
  if (raw.trim() === '') {
    throw packError(MANIFEST_CODES.BAD_CONTENTS, '内容条目的 path 是空的')
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw packError(MANIFEST_CODES.BAD_CONTENTS, `内容条目的 path 含控制字符：${JSON.stringify(raw)}`)
  }
  const path = raw.replace(/\\/g, '/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.startsWith('//')) {
    throw packError(
      MANIFEST_CODES.PATH_TRAVERSAL,
      `内容条目的 path 是绝对路径或带盘符：${JSON.stringify(raw)}。包内路径只能是相对的`,
    )
  }
  const segments = path.split('/')
  if (segments.some((s) => s === '..')) {
    throw packError(
      MANIFEST_CODES.PATH_TRAVERSAL,
      `内容条目的 path 含 ".."：${JSON.stringify(raw)}。` +
      '一个能写到包目录之外的安装，与一个把任意路径当成包内容的安装，是同一个东西',
    )
  }
  if (segments.some((s) => s === '.' || s === '')) {
    throw packError(MANIFEST_CODES.BAD_CONTENTS, `内容条目的 path 含空段或 "."：${JSON.stringify(raw)}`)
  }
  if (/[ .]$/.test(segments[segments.length - 1])) {
    throw packError(
      MANIFEST_CODES.BAD_CONTENTS,
      `内容条目的 path 以空格或点结尾：${JSON.stringify(raw)}。Windows 会把它规范化成另一个文件`,
    )
  }
  return segments.join('/')
}

/**
 * 归一化载荷：排序、去重、逐条算 sha256。
 *
 * 排序让哈希与**书写顺序**无关（同一个包两种写法必须是同一个哈希）；
 * 大小写碰撞要拒——在 Windows 上 `Readme.md` 与 `README.md` 是同一个文件，
 * 而"哪一个赢了"取决于解压顺序。
 */
export function normalizePayload(files) {
  if (!Array.isArray(files)) {
    throw packError(MANIFEST_CODES.BAD_CONTENTS, '载荷必须是一个 {path, text} 数组')
  }
  const byPath = new Map()
  const byLower = new Map()
  for (const f of files) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw packError(MANIFEST_CODES.BAD_CONTENTS, '载荷里的每一项必须是 {path, text}')
    }
    const path = normalizePackPath(f.path)
    const text = f.text === undefined || f.text === null ? '' : String(f.text)
    if (byPath.has(path)) {
      throw packError(MANIFEST_CODES.PATH_DUPLICATE, `载荷里同一个路径出现了两次：${JSON.stringify(path)}`)
    }
    const lower = path.toLowerCase()
    if (byLower.has(lower)) {
      throw packError(
        MANIFEST_CODES.PATH_COLLISION,
        `载荷里 ${JSON.stringify(byLower.get(lower))} 与 ${JSON.stringify(path)} 只差大小写——` +
        '在 Windows 上它们是同一个文件，而"哪一个赢了"取决于解压顺序',
      )
    }
    const entry = { path, text, sha256: sha256(text), chars: text.length }
    byPath.set(path, Object.freeze(entry))
    byLower.set(lower, path)
  }
  return Object.freeze([...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
}

/** 归一化 manifest 里声明的文件表（只有 path 与 sha256，没有正文）。 */
export function normalizeDeclaredContents(contents) {
  if (!Array.isArray(contents)) {
    throw packError(MANIFEST_CODES.BAD_CONTENTS, 'manifest.contents 必须是一个数组（可以是空数组）')
  }
  const out = []
  const seen = new Set()
  for (const c of contents) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw packError(MANIFEST_CODES.BAD_CONTENTS, 'manifest.contents 里的每一项必须是 {path, sha256}')
    }
    const path = normalizePackPath(c.path)
    if (seen.has(path)) {
      throw packError(MANIFEST_CODES.PATH_DUPLICATE, `manifest.contents 里 ${JSON.stringify(path)} 出现了两次`)
    }
    seen.add(path)
    const digest = nfc(String(c.sha256 ?? '')).trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw packError(
        MANIFEST_CODES.BAD_CONTENTS,
        `manifest.contents 里 ${JSON.stringify(path)} 的 sha256 不是 "sha256:<64 位十六进制>"：${JSON.stringify(c.sha256)}`,
      )
    }
    out.push(Object.freeze({ path, sha256: digest, chars: Number.isInteger(c.chars) ? c.chars : null }))
  }
  return Object.freeze(out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
}

/** 内容哈希：只覆盖**路径 + sha256**，按路径排序。 */
export function computeContentHash(files) {
  const entries = normalizePayload(files)
  return contentHashOfEntries(entries)
}

/** 由已归一化的条目算哈希（`normalizePayload` 的产物，避免重复归一化）。 */
export function contentHashOfEntries(entries) {
  return domainSeparatedHash(PACK_CONTENT_DOMAIN, PACK_CONTENT_SCHEMA_VERSION, {
    algorithm: 'sha256',
    files: entries.map((e) => ({ path: e.path, sha256: e.sha256 })),
  })
}

/**
 * 声明的内容表与实际载荷是否**逐条**一致（两个方向都查）。
 *
 * 只查一个方向会漏掉两种：载荷多了一个文件（作者以为没带）、
 * 载荷少了一个文件（装出来是个残包）。
 */
export function compareContents({ declared, entries }) {
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const dcl = new Map(declared.map((d) => [d.path, d]))
  const missing = declared.filter((d) => !byPath.has(d.path)).map((d) => d.path)
  const extra = entries.filter((e) => !dcl.has(e.path)).map((e) => e.path)
  const drifted = declared
    .filter((d) => byPath.has(d.path) && byPath.get(d.path).sha256 !== d.sha256)
    .map((d) => ({ path: d.path, declared: d.sha256, actual: byPath.get(d.path).sha256 }))
  return Object.freeze({
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
    drifted: Object.freeze(drifted),
    ok: missing.length === 0 && extra.length === 0 && drifted.length === 0,
  })
}

/**
 * 内容哈希核验：算一遍、对一遍清单、比一遍声明的哈希。
 *
 * @returns {{ok: boolean, code: string|null, computed: string, declared: string,
 *            contents: object, entries: Array<object>}}
 */
export function verifyContentHash({ manifest, files } = {}) {
  const entries = normalizePayload(files)
  const computed = contentHashOfEntries(entries)
  let declaredContents
  try {
    declaredContents = normalizeDeclaredContents(manifest?.contents)
  } catch (err) {
    return Object.freeze({
      ok: false,
      code: err?.code ?? MANIFEST_CODES.BAD_CONTENTS,
      computed,
      declared: nfc(String(manifest?.contentHash ?? '')),
      contents: null,
      entries,
      message: err?.message ?? String(err),
    })
  }
  const contents = compareContents({ declared: declaredContents, entries })
  const declared = nfc(String(manifest?.contentHash ?? '')).trim()
  let code = null
  if (!contents.ok) code = MANIFEST_CODES.CONTENTS_MISMATCH
  else if (declared !== computed) code = MANIFEST_CODES.CONTENT_HASH_MISMATCH
  return Object.freeze({ ok: code === null, code, computed, declared, contents, entries, message: null })
}

// ---------------------------------------------------------------------------
// 来源 / 签名
// ---------------------------------------------------------------------------

function asIdSet(builtinPackIds) {
  if (builtinPackIds instanceof Set) return builtinPackIds
  return new Set((Array.isArray(builtinPackIds) ? builtinPackIds : []).map((x) => nfc(String(x)).trim()))
}

/**
 * 一个包的可信等级。**内置身份只认宿主的登记表。**
 *
 * manifest 里有一个 `provenance` 对象，但里面**没有** `trustLevel` 字段
 * （`PROVENANCE_FIELDS` 只有 signer / keyId / signature）。理由是一句话：
 *
 *   > 一个「包自己声明 `provenance: 'builtin'`」的预检，
 *   > 与一个「任何包都能自称内置」的预检，是同一个东西——
 *   > 只不过前者在安装报表上写着"来源：内置"。
 *
 * 所以等级由三个**外部**事实决定：宿主的内置清单、注入的验证器、以及两者都没有。
 */
export function trustOf({ manifest, contentHash = null, verifier = null, builtinPackIds = [] } = {}) {
  const packId = nfc(String(manifest?.packId ?? '')).trim()
  if (asIdSet(builtinPackIds).has(packId)) {
    return Object.freeze({ level: 'builtin', why: `packId 在宿主的内置清单里（${packId}）` })
  }
  const p = manifest?.provenance
  if (p === null || p === undefined || typeof p !== 'object') {
    return Object.freeze({ level: 'unsigned', why: '不是内置包，且没有 provenance' })
  }
  if (typeof verifier !== 'function') {
    return Object.freeze({ level: 'unsigned', why: '不是内置包，且宿主没有注入签名验证器——"没法验"不是"验过了"' })
  }
  let verdict
  try {
    verdict = verifier({
      packId,
      version: nfc(String(manifest?.version ?? '')).trim(),
      contentHash: contentHash ?? nfc(String(manifest?.contentHash ?? '')).trim(),
      signer: p.signer ?? null,
      keyId: p.keyId ?? null,
      signature: p.signature ?? null,
    })
  } catch (err) {
    return Object.freeze({ level: 'unsigned', why: `验证器抛错：${err?.message ?? String(err)}` })
  }
  if (verdict === true || verdict?.valid === true) {
    return Object.freeze({ level: 'signed', why: `验证器给出肯定答复（signer=${p.signer ?? 'null'}）` })
  }
  return Object.freeze({
    level: 'unsigned',
    why: `验证器没有给出肯定答复：${verdict?.reason ?? JSON.stringify(verdict ?? null)}`,
  })
}

/**
 * 来源预检。
 *
 * ★ 验证器拿到的 `contentHash` 是**算出来的**那一个（调用方传进来），
 * 不是 manifest 里写的那一个：
 *
 *   > 一个「签名对着 manifest 声明的哈希」的预检，
 *   > 与一个「签名有效、而内容已经是另一份」的预检，是同一个东西。
 */
export function verifyProvenance({ manifest, contentHash, verifier = null, builtinPackIds = [] } = {}) {
  const trust = trustOf({ manifest, contentHash, verifier, builtinPackIds })
  if (trust.level === 'builtin' || trust.level === 'signed') {
    return Object.freeze({ ok: true, code: null, trust, message: null })
  }
  const hasProvenance = manifest?.provenance !== null && manifest?.provenance !== undefined
  return Object.freeze({
    ok: false,
    code: hasProvenance ? MANIFEST_CODES.PROVENANCE_UNVERIFIED : MANIFEST_CODES.PROVENANCE_MISSING,
    trust,
    message: trust.why,
  })
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

/**
 * manifest 字段必须**闭合**：不在名单里的字段一律拒绝。
 *
 *   > 一个「忽略不认识字段」的 manifest，
 *   > 与一个「多打的一个字母让整条限制静默失效」的 manifest，是同一个东西。
 */
export function assertPackFieldsClosed({ manifest, fields = PACK_MANIFEST_FIELDS } = {}) {
  const seen = Object.keys(manifest ?? {})
  const forbidden = seen.filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  const unknown = seen.filter((k) => !fields.includes(k))
  const missing = REQUIRED_PACK_FIELDS.filter((k) => !seen.includes(k))
  if (forbidden.length > 0) {
    throw packError(
      MANIFEST_CODES.FIELD_ON_ENFORCEMENT_PLANE,
      `能力包 manifest 里出现了强制面字段 ${JSON.stringify(forbidden)}。` +
      '强制面属于 host 组合（spec §6.9 line 488），能力包属于被安装的内容——' +
      '一个能写这些字段的包，就是一个能给自己发权限、能改审批策略的包',
    )
  }
  if (unknown.length > 0) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `能力包 manifest 里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的 manifest，与一个"多打的一个字母让整条限制静默失效"的 manifest，是同一个东西',
    )
  }
  if (missing.length > 0) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `能力包 manifest 缺少必需字段 ${JSON.stringify(missing)}。不给默认值——` +
      '一个"缺字段就用默认值"的解析，与一个"没写的都按最宽松理解"的解析，是同一个东西',
    )
  }
  return Object.freeze({
    fields: Object.freeze(seen),
    forbidden: Object.freeze(forbidden),
    unknown: Object.freeze(unknown),
    missing: Object.freeze(missing),
  })
}

/** 校验 `provenance` 自身的字段闭合。 */
export function assertProvenanceFieldsClosed(provenance) {
  if (provenance === undefined || provenance === null) return null
  if (typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw packError(MANIFEST_CODES.BAD_MANIFEST, 'provenance 必须是一个对象（或 null）')
  }
  const seen = Object.keys(provenance)
  const unknown = seen.filter((k) => !PROVENANCE_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `provenance 里出现了不认识的字段 ${JSON.stringify(unknown)}。` +
      '注意这里**没有** trustLevel：可信等级由宿主的登记表和验证器算出来，不由包声明',
    )
  }
  const signer = nfc(String(provenance.signer ?? '')).trim()
  const signature = nfc(String(provenance.signature ?? '')).trim()
  if (signer === '' || signature === '') {
    throw packError(MANIFEST_CODES.BAD_MANIFEST, 'provenance 至少要给出非空的 signer 与 signature')
  }
  return Object.freeze({
    signer,
    keyId: provenance.keyId === undefined || provenance.keyId === null ? null : nfc(String(provenance.keyId)).trim(),
    signature,
  })
}

/**
 * 归一化一份 manifest。**幂等**（输出只含已知字段、取值都已合法）。
 *
 * 幂等不是审美：`normalizePackManifest` 会在预检与编译两处各被调用一次，
 * 第二次的结果必须与第一次逐字段相同，否则"同一个包"会有两个哈希。
 */
export function normalizePackManifest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw packError(MANIFEST_CODES.BAD_MANIFEST, 'normalizePackManifest 需要一份 manifest 对象')
  }
  assertPackFieldsClosed({ manifest: input })

  const manifestVersion = nfc(String(input.manifestVersion ?? '')).trim()
  if (manifestVersion !== PACK_MANIFEST_VERSION) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `manifestVersion 是 ${JSON.stringify(input.manifestVersion)}，本模块只认 ${PACK_MANIFEST_VERSION}`,
    )
  }

  const packId = nfc(String(input.packId ?? '')).trim()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(packId)) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `packId 必须是 [a-z0-9._-] 组成的小写标识：${JSON.stringify(input.packId)}`,
    )
  }

  const packType = nfc(String(input.packType ?? '')).trim()
  if (!PACK_TYPES.includes(packType)) {
    throw packError(
      MANIFEST_CODES.BAD_TYPE,
      `不认识的能力包类型 ${JSON.stringify(input.packType)}（合法值：${PACK_TYPES.join(' / ')}）`,
    )
  }

  const version = formatSemver(parseSemver(input.version))

  if (!Number.isInteger(input.packProtocolVersion)) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `packProtocolVersion 必须是整数（收到 ${JSON.stringify(input.packProtocolVersion)}）`,
    )
  }

  const contentHash = nfc(String(input.contentHash ?? '')).trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw packError(
      MANIFEST_CODES.BAD_MANIFEST,
      `contentHash 必须是 "sha256:<64 位十六进制>"：${JSON.stringify(input.contentHash)}`,
    )
  }

  const contents = normalizeDeclaredContents(input.contents)

  const rawEntrypoints = input.entrypoints
  if (rawEntrypoints === null || typeof rawEntrypoints !== 'object' || Array.isArray(rawEntrypoints)) {
    throw packError(MANIFEST_CODES.BAD_MANIFEST, 'entrypoints 必须是一个对象（团队包至少要给 teamPlan）')
  }
  const entrypoints = {}
  for (const [k, v] of Object.entries(rawEntrypoints)) {
    const key = nfc(String(k)).trim()
    const val = typeof v === 'string' ? normalizePackPath(v) : null
    if (val === null) {
      throw packError(MANIFEST_CODES.BAD_MANIFEST, `entrypoints.${key} 必须是一个包内路径字符串`)
    }
    entrypoints[key] = val
  }

  // 下面这些字段的**语义**在别的模块里判（权限在 authority.mjs、依赖与兼容在这里的
  // 预检里）。归一化只负责让它们"形状确定"：要么是一个合法的容器，要么是 null。
  const dependsOn = input.dependsOn === undefined || input.dependsOn === null ? null : input.dependsOn
  if (dependsOn !== null && !Array.isArray(dependsOn)) {
    throw packError(MANIFEST_CODES.DEPENDENCY_UNDECLARED, 'dependsOn 必须是一个数组（没有依赖就写 []）')
  }
  const compatibility = input.compatibility === undefined || input.compatibility === null ? null : input.compatibility
  if (compatibility !== null && (typeof compatibility !== 'object' || Array.isArray(compatibility))) {
    throw packError(MANIFEST_CODES.COMPAT_UNDECLARED, 'compatibility 必须是一个对象')
  }

  const provenance = assertProvenanceFieldsClosed(input.provenance ?? null)

  return deepFreeze({
    manifestVersion,
    packId,
    packType,
    version,
    packProtocolVersion: input.packProtocolVersion,
    contentHash,
    contents,
    entrypoints,
    dependsOn,
    compatibility,
    requestedPermissions: input.requestedPermissions === undefined ? null : input.requestedPermissions,
    dataDependencies: input.dataDependencies === undefined ? null : input.dataDependencies,
    provenance,
    // ⚠️ `containsSecrets` 是**声明**，它的值不参与任何判据（见 authority.mjs）。
    // 原样留着是为了能把它和"实际扫出什么"摆在一起给值班的人看。
    //
    // ★ 作者**没写**这个键时，归一化结果里也**不能有**这个键：
    //   把它补成 `false` 就等于替作者声明了"包里没有密钥"，
    //   而 authority.mjs 的判据恰恰是"作者必须自己声明，声明缺席即拒绝"。
    ...(Object.prototype.hasOwnProperty.call(input, 'containsSecrets')
      ? { containsSecrets: input.containsSecrets }
      : {}),
  })
}

// ---------------------------------------------------------------------------
// 依赖与兼容性预检
// ---------------------------------------------------------------------------

/** 宿主版本三元组。三个都要有，缺一个就"没有基线"。 */
export function normalizeHost(host) {
  if (host === null || typeof host !== 'object' || Array.isArray(host)) {
    throw packError(MANIFEST_CODES.HOST_VERSION_UNKNOWN, '宿主版本必须是一个对象')
  }
  const productVersion = nfc(String(host.productVersion ?? '')).trim()
  try {
    parseSemver(productVersion)
  } catch {
    // 宿主版本不合法与"宿主版本没给"对调用方是同一件事：**没有基线**。
    // 报成 BAD_VERSION 会把"宿主自己说不清版本"读成"包写错了版本"。
    throw packError(
      MANIFEST_CODES.HOST_VERSION_UNKNOWN,
      `宿主没有给出合法的 productVersion：${JSON.stringify(host.productVersion)}`,
    )
  }
  if (!Number.isInteger(host.packProtocolVersion)) {
    throw packError(MANIFEST_CODES.HOST_VERSION_UNKNOWN, '宿主必须给出整数 packProtocolVersion')
  }
  if (!Number.isInteger(host.dshCompositionPatchVersion)) {
    throw packError(MANIFEST_CODES.HOST_VERSION_UNKNOWN, '宿主必须给出整数 dshCompositionPatchVersion')
  }
  return Object.freeze({
    productVersion,
    packProtocolVersion: host.packProtocolVersion,
    dshCompositionPatchVersion: host.dshCompositionPatchVersion,
  })
}

/** 补丁层版本是单个整数；范围比较需要把它摆成一个三段版本。 */
export function patchVersionAsSemver(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw packError(MANIFEST_CODES.HOST_VERSION_UNKNOWN, `补丁层版本必须是 >= 1 的整数（收到 ${JSON.stringify(n)}）`)
  }
  return `${n}.0.0`
}

function installedMap(installed) {
  const map = new Map()
  const ambiguous = []
  for (const rec of Array.isArray(installed) ? installed : []) {
    const id = nfc(String(rec?.packId ?? '')).trim()
    if (id === '') continue
    const version = nfc(String(rec?.version ?? '')).trim()
    if (map.has(id) && map.get(id) !== version) ambiguous.push(id)
    map.set(id, version)
  }
  return { map, ambiguous: Object.freeze(ambiguous) }
}

/**
 * 依赖预检。
 *
 * `dependsOn` 缺失 = **拒绝**，不是"没有依赖"（见文件头 ③）。空依赖表写成 `[]`。
 */
export function preflightDependencies({ manifest, installed = [] } = {}) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))
  const { map, ambiguous } = installedMap(installed)
  for (const id of ambiguous) {
    fail(
      MANIFEST_CODES.INSTALLED_AMBIGUOUS,
      'installed',
      `已安装清单里 ${JSON.stringify(id)} 有两个不同版本——基线本身有歧义时，依赖判定没有意义`,
    )
  }

  if (manifest.dependsOn === null) {
    fail(
      MANIFEST_CODES.DEPENDENCY_UNDECLARED,
      'dependsOn',
      'manifest 没有声明 dependsOn。缺字段不等于"没有依赖"——没有依赖要写成 []，' +
      '因为"缺字段当成空依赖表"会让依赖预检对这个包**从不生效**',
    )
    return Object.freeze({ problems: Object.freeze(problems), resolved: Object.freeze([]) })
  }

  const seen = new Set()
  const resolved = []
  for (const dep of manifest.dependsOn) {
    if (dep === null || typeof dep !== 'object' || Array.isArray(dep)) {
      fail(MANIFEST_CODES.DEPENDENCY_UNDECLARED, 'dependsOn', '每一项依赖必须是 {packId, range}')
      continue
    }
    const packId = nfc(String(dep.packId ?? '')).trim()
    if (packId === '') {
      fail(MANIFEST_CODES.DEPENDENCY_UNDECLARED, 'dependsOn', '依赖缺少 packId')
      continue
    }
    if (packId === manifest.packId) {
      fail(MANIFEST_CODES.DEPENDENCY_SELF, 'dependsOn', `包依赖自己：${packId}`)
      continue
    }
    if (seen.has(packId)) {
      fail(MANIFEST_CODES.DEPENDENCY_DUPLICATE, 'dependsOn', `依赖 ${packId} 写了两遍——两遍的 range 可能不同，取哪一份都是猜`)
      continue
    }
    seen.add(packId)
    let range
    try {
      // 只解析一次，确认它不是无界/畸形；真正的判定在下面。
      satisfiesRange('0.0.0', dep.range)
      range = nfc(String(dep.range)).trim()
    } catch (err) {
      fail(err?.code ?? MANIFEST_CODES.RANGE_MALFORMED, 'dependsOn', `依赖 ${packId} 的范围不合法：${err?.message ?? String(err)}`)
      continue
    }
    if (!map.has(packId)) {
      fail(MANIFEST_CODES.DEPENDENCY_MISSING, 'dependsOn', `依赖 ${packId}（${range}）没有安装`)
      continue
    }
    const installedVersion = map.get(packId)
    if (!isSemver(installedVersion)) {
      fail(
        MANIFEST_CODES.DEPENDENCY_INCOMPATIBLE,
        'dependsOn',
        `已安装的 ${packId} 版本 ${JSON.stringify(installedVersion)} 不是语义版本，无法判定是否满足 ${range}——不猜`,
      )
      continue
    }
    if (!satisfiesRange(installedVersion, range)) {
      fail(
        MANIFEST_CODES.DEPENDENCY_INCOMPATIBLE,
        'dependsOn',
        `依赖 ${packId} 已安装 ${installedVersion}，不满足 ${range}`,
      )
      continue
    }
    resolved.push(Object.freeze({ packId, range, installedVersion }))
  }
  return Object.freeze({ problems: Object.freeze(problems), resolved: Object.freeze(resolved) })
}

/**
 * 兼容性预检。三项都要声明，都要判定。
 *
 *   > 一个「不声明兼容条件就算兼容」的预检，
 *   > 与一个「与一切版本兼容」的预检，是同一个东西——
 *   > 只不过前者在安装报表上是空的（没有失败，也没有检查）。
 */
export function preflightCompatibility({ manifest, host } = {}) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))
  const c = manifest.compatibility
  if (c === null || c === undefined) {
    fail(
      MANIFEST_CODES.COMPAT_UNDECLARED,
      'compatibility',
      'manifest 没有声明 compatibility。不声明兼容条件 = 与一切版本兼容 = 什么也没声明',
    )
    return Object.freeze({ problems: Object.freeze(problems), readings: Object.freeze([]) })
  }
  const readings = []
  for (const field of HOST_COMPAT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(c, field) || c[field] === undefined || c[field] === null) {
      fail(MANIFEST_CODES.COMPAT_UNDECLARED, `compatibility.${field}`, `兼容条件缺少 ${field}`)
      continue
    }
    if (field === 'packProtocolVersion') {
      if (c[field] !== host.packProtocolVersion) {
        fail(
          MANIFEST_CODES.PROTOCOL_MISMATCH,
          'compatibility.packProtocolVersion',
          `包要求协议版本 ${JSON.stringify(c[field])}，宿主是 ${host.packProtocolVersion}。` +
          '协议版本只接受**相等**——更高的协议版本意味着它多带了几个我们不认识的字段',
        )
      }
      readings.push(Object.freeze({ field, host: host.packProtocolVersion, declared: c[field], satisfied: c[field] === host.packProtocolVersion }))
      continue
    }
    const hostValue = field === 'product' ? host.productVersion : patchVersionAsSemver(host.dshCompositionPatchVersion)
    let satisfied
    try {
      satisfied = satisfiesRange(hostValue, c[field])
    } catch (err) {
      fail(err?.code ?? MANIFEST_CODES.RANGE_MALFORMED, `compatibility.${field}`, `兼容范围不合法：${err?.message ?? String(err)}`)
      continue
    }
    readings.push(Object.freeze({ field, host: hostValue, declared: c[field], satisfied }))
    if (!satisfied) {
      fail(
        MANIFEST_CODES.COMPAT_INCOMPATIBLE,
        `compatibility.${field}`,
        `宿主 ${field}=${hostValue} 不满足包声明的 ${JSON.stringify(c[field])}`,
      )
    }
  }
  return Object.freeze({ problems: Object.freeze(problems), readings: Object.freeze(readings) })
}

// ---------------------------------------------------------------------------
// 团队包入口
// ---------------------------------------------------------------------------

/**
 * 从载荷里读团队方案入口。
 *
 * `overlay` 包不需要入口；`team` 包没有入口就是拒绝——一个"团队包"却
 * 编译不出团队方案，会在创建目标的那一步才炸，而那时目标已经建出来了。
 */
export function readPackTeam({ manifest, files } = {}) {
  if (manifest.packType !== 'team') {
    return Object.freeze({ planPath: null, employees: null, pipeline: null })
  }
  const planPath = manifest.entrypoints.teamPlan
  if (typeof planPath !== 'string' || planPath === '') {
    throw packError(
      MANIFEST_CODES.ENTRYPOINT_MISSING,
      `团队包 ${manifest.packId} 没有 entrypoints.teamPlan——没有它，这个包编译不出团队方案`,
    )
  }
  const entries = normalizePayload(files)
  const hit = entries.find((e) => e.path === planPath)
  if (hit === undefined) {
    throw packError(
      MANIFEST_CODES.ENTRYPOINT_MISSING,
      `团队包 ${manifest.packId} 的入口 ${planPath} 不在载荷里（载荷有 ${entries.length} 个文件）`,
    )
  }
  let parsed
  try {
    parsed = JSON.parse(hit.text)
  } catch (err) {
    throw packError(MANIFEST_CODES.ENTRYPOINT_MISSING, `入口 ${planPath} 不是合法 JSON：${err?.message ?? String(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.employees) || !Array.isArray(parsed.pipeline)) {
    throw packError(
      MANIFEST_CODES.ENTRYPOINT_MISSING,
      `入口 ${planPath} 必须是 {employees: [], pipeline: []} 形状`,
    )
  }
  return Object.freeze({
    planPath,
    employees: deepFreeze(parsed.employees),
    pipeline: deepFreeze(parsed.pipeline),
  })
}

// ---------------------------------------------------------------------------
// manifest 预检（不含权限与密钥——那两件在 authority.mjs）
// ---------------------------------------------------------------------------

function verdictOf(problems, computed) {
  return Object.freeze({
    ok: problems.length === 0,
    code: problems.length === 0 ? null : problems[0].code,
    problems: Object.freeze(problems),
    computed: Object.freeze(computed),
  })
}

/**
 * 结构、协议、内容哈希、来源、兼容与依赖的预检。
 *
 * 它**不**判权限与密钥——那两件需要宿主的强制面基线，在 `authority.mjs` 里。
 * 拆开是因为这一个只依赖 manifest 与负载（可以被离线复算），
 * 那一个依赖宿主注入的基线（只能在真实安装现场算）。
 *
 * @param {object} p
 * @param {object} p.manifest 原始 manifest
 * @param {Array<{path: string, text: string}>} p.files 载荷
 * @param {object} p.host `{productVersion, packProtocolVersion, dshCompositionPatchVersion}`
 * @param {Array<{packId: string, version: string}>} [p.installed] 已安装清单
 * @param {Function|null} [p.verifier] 签名验证器（宿主注入）
 * @param {Array<string>|Set<string>} [p.builtinPackIds] 宿主的内置包清单
 */
export function preflightManifest({ manifest, files, host, installed = [], verifier = null, builtinPackIds = [] } = {}) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))

  let m
  try {
    m = normalizePackManifest(manifest)
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.BAD_MANIFEST, 'manifest', err?.message ?? String(err))
    return verdictOf(problems, { contentHash: null, trust: null, packId: null, version: null })
  }

  let h
  try {
    h = normalizeHost(host)
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.HOST_VERSION_UNKNOWN, 'host', err?.message ?? String(err))
    return verdictOf(problems, { contentHash: null, trust: null, packId: m.packId, version: m.version })
  }

  if (m.packProtocolVersion !== h.packProtocolVersion) {
    fail(
      MANIFEST_CODES.PROTOCOL_MISMATCH,
      'packProtocolVersion',
      `包的协议版本是 ${m.packProtocolVersion}，宿主是 ${h.packProtocolVersion}。只接受相等`,
    )
  }

  // 内容哈希：算 → 对表 → 比对。三条各有自己的码。
  let hash = null
  try {
    hash = verifyContentHash({ manifest: m, files })
    if (!hash.ok) {
      fail(
        hash.code,
        'contentHash',
        hash.code === MANIFEST_CODES.CONTENT_HASH_MISMATCH
          ? `声明的 contentHash ${hash.declared} 与实际算出的 ${hash.computed} 不一致`
          : `声明的内容表与实际载荷不一致：缺 ${JSON.stringify(hash.contents.missing)}，` +
            `多 ${JSON.stringify(hash.contents.extra)}，内容不同 ${JSON.stringify(hash.contents.drifted)}`,
      )
    }
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.BAD_CONTENTS, 'contents', err?.message ?? String(err))
  }

  // 来源：验证器拿到的是**算出来的**哈希。
  const prov = verifyProvenance({
    manifest: m,
    contentHash: hash === null ? null : hash.computed,
    verifier,
    builtinPackIds,
  })
  if (!prov.ok) fail(prov.code, 'provenance', prov.message)

  const compat = preflightCompatibility({ manifest: m, host: h })
  for (const p of compat.problems) problems.push(p)

  const deps = preflightDependencies({ manifest: m, installed })
  for (const p of deps.problems) problems.push(p)

  try {
    readPackTeam({ manifest: m, files })
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.ENTRYPOINT_MISSING, 'entrypoints', err?.message ?? String(err))
  }

  return verdictOf(problems, {
    packId: m.packId,
    version: m.version,
    packType: m.packType,
    packProtocolVersion: m.packProtocolVersion,
    // ★ 这个值是**算出来的**，不是 manifest 里那一行。下游（store、plan）只认它。
    contentHash: hash === null ? null : hash.computed,
    declaredContentHash: m.contentHash,
    trust: prov.trust.level,
    trustWhy: prov.trust.why,
    dependencies: deps.resolved,
    compatibility: compat.readings,
    fileCount: hash === null ? null : hash.entries.length,
  })
}

// ---------------------------------------------------------------------------
// 装载时自检
// ---------------------------------------------------------------------------

const SAMPLE_FILES = Object.freeze([
  Object.freeze({ path: 'docs/README.md', text: '# 样例包\n' }),
  Object.freeze({ path: 'team/team-plan.json', text: '{"employees":[],"pipeline":[]}' }),
])

/** 自检与用例共用的样例宿主版本。 */
export const SAMPLE_HOST = Object.freeze({
  productVersion: '1.0.0',
  packProtocolVersion: PACK_PROTOCOL_VERSION,
  dshCompositionPatchVersion: DSH_COMPOSITION_PATCH_VERSION,
})

/** 自检与用例共用的样例包（一个合法的空团队包）。 */
export function samplePack() {
  const entries = normalizePayload(SAMPLE_FILES)
  const manifest = {
    manifestVersion: PACK_MANIFEST_VERSION,
    packId: 'legion.sample',
    packType: 'team',
    version: '1.0.0',
    packProtocolVersion: PACK_PROTOCOL_VERSION,
    contentHash: contentHashOfEntries(entries),
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    entrypoints: { teamPlan: 'team/team-plan.json' },
    dependsOn: [],
    compatibility: {
      product: '^1.0.0',
      packProtocolVersion: PACK_PROTOCOL_VERSION,
      dshCompositionPatchVersion: `^${patchVersionAsSemver(DSH_COMPOSITION_PATCH_VERSION)}`,
    },
    requestedPermissions: { capabilities: [], tools: [], maxRisk: 'low', workspaceRoot: null },
    dataDependencies: [],
    provenance: null,
    containsSecrets: false,
  }
  return Object.freeze({
    manifest,
    files: SAMPLE_FILES.map((f) => ({ path: f.path, text: f.text })),
    host: SAMPLE_HOST,
    builtinPackIds: Object.freeze(['legion.sample']),
  })
}

function codeOf(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

/**
 * 装载期自检。**不抛，留值。**
 *
 * 留下的是**算出来的读数**（哈希相不相等、范围判定真不真、哪几条抛了哪个码），
 * 不是一个 `ok: true`：一个布尔可以被"删掉整段自检"的那一处补丁伪造，
 * 而"同一个包倒过来写两次得到同一个哈希"这个读数不行。
 */
export function assertManifestSemantics({ sample = samplePack() } = {}) {
  const problems = []
  const samples = {}

  const hashA = computeContentHash(sample.files)
  const hashB = computeContentHash([...sample.files].reverse())
  samples.hashOrderInvariant = hashA
  samples.hashOrderInvariantHolds = hashA === hashB
  if (hashA !== hashB) problems.push('同一个包换一个书写顺序就得到了另一个内容哈希')

  const flipped = sample.files.map((f, i) => (i === 0 ? { path: f.path, text: `${f.text}改变一个字符` } : f))
  samples.hashChangesWithContent = computeContentHash(flipped) !== hashA
  if (samples.hashChangesWithContent !== true) problems.push('内容改了哈希却没变')

  samples.versionOrder = Object.freeze([
    compareSemver('1.0.0', '1.0.0-alpha'),
    compareSemver('2.0.0', '1.9.9'),
    compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'),
  ])
  if (samples.versionOrder.join(',') !== '1,1,-1') {
    problems.push(`语义版本比较的读数不符（${samples.versionOrder.join(',')}，期望 1,1,-1）`)
  }

  samples.rangeReadings = Object.freeze({
    '1.9.9 in ^1.2.0': satisfiesRange('1.9.9', '^1.2.0'),
    '2.0.0 in ^1.2.0': satisfiesRange('2.0.0', '^1.2.0'),
    '1.2.0-alpha in ^1.2.0': satisfiesRange('1.2.0-alpha', '^1.2.0'),
    '0.3.0 in ^0.2.3': satisfiesRange('0.3.0', '^0.2.3'),
  })
  const expectRanges = [true, false, false, false]
  const gotRanges = Object.values(samples.rangeReadings)
  if (gotRanges.join(',') !== expectRanges.join(',')) {
    problems.push(`范围判定的读数不符（${gotRanges.join(',')}，期望 ${expectRanges.join(',')}）`)
  }

  samples.unboundedRangeCode = codeOf(() => satisfiesRange('1.0.0', '*'))
  samples.traversalCode = codeOf(() => computeContentHash([{ path: '../escape.txt', text: 'x' }]))
  samples.duplicatePathCode = codeOf(() => computeContentHash([{ path: 'a.md', text: '1' }, { path: 'a.md', text: '2' }]))
  samples.caseCollisionCode = codeOf(() => computeContentHash([{ path: 'A.md', text: '1' }, { path: 'a.md', text: '2' }]))
  for (const [k, want] of [
    ['unboundedRangeCode', MANIFEST_CODES.RANGE_UNBOUNDED],
    ['traversalCode', MANIFEST_CODES.PATH_TRAVERSAL],
    ['duplicatePathCode', MANIFEST_CODES.PATH_DUPLICATE],
    ['caseCollisionCode', MANIFEST_CODES.PATH_COLLISION],
  ]) {
    if (samples[k] !== want) problems.push(`${k} 得到 ${JSON.stringify(samples[k])}，期望 ${want}`)
  }

  // 真的跑一遍预检：好包必须过，且 contentHash 读数等于算出来的那一个。
  const good = preflightManifest({
    manifest: sample.manifest,
    files: sample.files,
    host: sample.host,
    installed: [],
    builtinPackIds: sample.builtinPackIds,
  })
  samples.goodVerdictOk = good.ok
  samples.goodVerdictCodes = Object.freeze(good.problems.map((p) => p.code))
  samples.goodComputedHash = good.computed.contentHash
  samples.goodComputedHashEqualsLocal = good.computed.contentHash === hashA
  if (good.ok !== true) problems.push(`样例包没通过预检：${JSON.stringify(samples.goodVerdictCodes)}`)

  // 内容被改：改一个文件、manifest 不动 → 必须落在两个哈希码之一。
  //
  // ⚠️ 先命中的通常是 `CONTENTS_MISMATCH`（逐文件的 sha256 表先对不上），
  // 而不是 `CONTENT_HASH_MISMATCH`。这不是"另一条没生效"——两条查的是同一件事的
  // 两个粒度，而**更细的那一条先响**正是我们想要的读数。
  const tampered = preflightManifest({
    manifest: sample.manifest,
    files: sample.files.map((f, i) => (i === 0 ? { path: f.path, text: `${f.text}被改过` } : f)),
    host: sample.host,
    installed: [],
    builtinPackIds: sample.builtinPackIds,
  })
  samples.tamperedCode = tampered.code
  samples.hashErrorCodes = Object.freeze([MANIFEST_CODES.CONTENTS_MISMATCH, MANIFEST_CODES.CONTENT_HASH_MISMATCH])
  if (!samples.hashErrorCodes.includes(tampered.code)) {
    problems.push(`被改过的包没有被判成哈希错误（${tampered.code}）`)
  }

  // ★ 第二条粒度也必须**真的能响**：把文件改了、并把 manifest 的逐文件 sha256 表
  //   一起改成新的（作者"记得更新清单"），只剩 contentHash 是旧的。
  //
  //   没有这一条，`CONTENT_HASH_MISMATCH` 就是一条**写在那里但没有任何输入能走到它**
  //   的分支——而它与一条不存在的检查在"到底拦不拦得住"上是同一个东西。
  const restampedFiles = normalizePayload(
    sample.files.map((f, i) => (i === 0 ? { path: f.path, text: `${f.text}被改过` } : f)),
  )
  const restamped = preflightManifest({
    manifest: {
      ...sample.manifest,
      contents: restampedFiles.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
      // contentHash 故意不动
    },
    files: sample.files.map((f, i) => (i === 0 ? { path: f.path, text: `${f.text}被改过` } : f)),
    host: sample.host,
    installed: [],
    builtinPackIds: sample.builtinPackIds,
  })
  samples.restampedOnlyCode = restamped.code
  if (restamped.code !== MANIFEST_CODES.CONTENT_HASH_MISMATCH) {
    problems.push(`只改了清单、没改 contentHash 的包没有被判成 CONTENT_HASH_MISMATCH（${restamped.code}）`)
  }

  // 缺 dependsOn：归一化**不**拦它（那会让"结构"与"语义"混在一起），
  // 拦住它的是预检里的依赖判定。
  const noDeps = { ...sample.manifest, dependsOn: undefined }
  samples.normalizeAcceptsMissingDependsOn = codeOf(() => normalizePackManifest(noDeps)) === null
  const noDepsVerdict = preflightManifest({
    manifest: noDeps, files: sample.files, host: sample.host, builtinPackIds: sample.builtinPackIds,
  })
  samples.missingDependsOnVerdictCode = noDepsVerdict.code
  if (noDepsVerdict.code !== MANIFEST_CODES.BAD_MANIFEST && noDepsVerdict.code !== MANIFEST_CODES.DEPENDENCY_UNDECLARED) {
    problems.push(`缺 dependsOn 的包没有被拦下（${noDepsVerdict.code}）`)
  }

  // 协议版本只接受相等：更高也要拒
  const futureProtocol = { ...sample.manifest, packProtocolVersion: PACK_PROTOCOL_VERSION + 1 }
  samples.futureProtocolCode = preflightManifest({
    manifest: futureProtocol, files: sample.files, host: sample.host, builtinPackIds: sample.builtinPackIds,
  }).code
  if (samples.futureProtocolCode !== MANIFEST_CODES.PROTOCOL_MISMATCH) {
    problems.push(`更高的协议版本没有被拒（${samples.futureProtocolCode}）`)
  }

  // ★ 自称内置：packId 不在宿主登记表里，provenance 里写什么都没有用
  samples.selfDeclaredTrust = trustOf({
    manifest: {
      packId: 'legion.not-registered',
      version: '1.0.0',
      provenance: { signer: 'me', keyId: 'k', signature: 's' },
    },
    contentHash: hashA,
    builtinPackIds: sample.builtinPackIds,
  }).level
  if (samples.selfDeclaredTrust !== 'unsigned') {
    problems.push(`未登记的 packId 拿到了 ${samples.selfDeclaredTrust} 等级——可信等级必须来自宿主`)
  }

  // 归一化幂等
  const once = normalizePackManifest(sample.manifest)
  const twice = normalizePackManifest(once)
  samples.normalizeIdempotent = JSON.stringify(once) === JSON.stringify(twice)
  if (samples.normalizeIdempotent !== true) problems.push('normalizePackManifest 不幂等')

  return Object.freeze({
    problems: Object.freeze(problems),
    samples: Object.freeze(samples),
  })
}

// 装载即执行。导出的是**算出来的读数**，不是一个布尔 ok。
export const PACK_MANIFEST_CHECKED = Object.freeze({
  version: PACK_MANIFEST_VERSION,
  protocolVersion: PACK_PROTOCOL_VERSION,
  ...assertManifestSemantics(),
})
