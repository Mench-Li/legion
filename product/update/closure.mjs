// product/update/closure.mjs
// ============================================================================
// 产物闭包 —— 设计 §6 line 142 里「校验闭包」那两个字的载体
//
// ## 为什么闭包不能只是一个"文件清单数组"放在发行清单里
//
// 发行清单受设计 §6 的 **256 KiB** 上限约束（客户端取清单时按这个上限收）。
// 而一份真实产品树的逐文件闭包有几万个条目——远不止 256 KiB。
//
// 所以闭包的载体是**包内的一个条目**（`closure.json`），而发行清单里只钉住
// 它的**摘要**：
//
//     release.package.closurePath   = 'closure.json'
//     release.package.closureSha256 = <64 位十六进制>
//
// 于是"闭包可信"这件事与"包可信"共用同一条信任链：发行清单是签过名的，
// 闭包的摘要在它里面；而闭包自己又在包内被逐字节核对。
//
// ## 为什么闭包必须**先**取出来
//
// 校验的顺序是硬的：
//
//   1. 读中央目录，过"五条拒绝判据"里**不需要闭包**的那些
//      （越界路径、软链接、重复目标、解压炸弹）；
//   2. 解出 `closure.json` 这一个条目，核对它的摘要与发行清单声明的一致；
//   3. 用它作为闭包，检查其余全部条目（未知可执行文件、多余条目、缺条目）；
//   4. 解出其余条目并逐条核对内容摘要。
//
// 第 2 步不能并到第 4 步里：一份"先解压全部文件、之后才发现闭包对不上"的
// 实现已经把文件写到磁盘上了，而那时"拒绝"只在报告里成立。
//
// ## 闭包的形状
//
//   { "protocol": "legion/update-closure@1", "files": [ { "path", "bytes", "sha256" }, … ] }
//
// `path` 用与归档条目完全相同的相对路径口径（正斜杠、无前导斜杠）。
// `files` 按 `path` 升序——排序是摘要稳定的前提，而摘要稳定是"发布端与
// 客户端算出同一个值"的前提。
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { canonicalJson, parseJsonStrict, sha256Hex } from './canonical.mjs'
import { validateEntryName } from './extract.mjs'

export const CLOSURE_PROTOCOL = 'legion/update-closure@1'

/** 包内闭包条目的默认名字。发行清单里的 `closurePath` 必须与它一致。 */
export const CLOSURE_ENTRY_NAME = 'closure.json'

/** 闭包本身的长度上限。它要能被安全地一次读进内存。 */
export const MAX_CLOSURE_BYTES = 32 * 1024 * 1024

export const CLOSURE_CODES = Object.freeze({
  BAD_FORMAT: 'closure-bad-format',
  BAD_ENTRY: 'closure-bad-entry',
  DUPLICATE: 'closure-duplicate',
  UNSORTED: 'closure-unsorted',
  TOO_LARGE: 'closure-too-large',
  PATH_PROBLEM: 'closure-path-problem',
})

function problem(code, message, path = null) {
  return Object.freeze({ code, message, path })
}

/**
 * 校验一份闭包的值（**不是**它的字节）。
 *
 * 返回**只含已知字段**的冻结副本：闭包将来多一个字段时，客户端不该因为
 * "不认识"而把它带进后续逻辑。
 */
export function validateClosure(value) {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({
      ok: false, code: CLOSURE_CODES.BAD_FORMAT, reason: '闭包必须是对象',
      problems: Object.freeze([problem(CLOSURE_CODES.BAD_FORMAT, '闭包必须是对象')]), files: null,
    })
  }
  if (value.protocol !== CLOSURE_PROTOCOL) {
    problems.push(problem(CLOSURE_CODES.BAD_FORMAT,
      `protocol 必须是 ${CLOSURE_PROTOCOL}，实际 ${JSON.stringify(value.protocol)}`))
  }
  if (!Array.isArray(value.files)) {
    problems.push(problem(CLOSURE_CODES.BAD_FORMAT, 'files 必须是数组'))
  }

  const files = []
  const seen = new Set()
  let previousPath = null
  let totalBytes = 0
  for (const [index, raw] of (Array.isArray(value.files) ? value.files : []).entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(problem(CLOSURE_CODES.BAD_ENTRY, `第 ${index + 1} 个条目必须是对象`))
      continue
    }
    const keys = Object.keys(raw).sort()
    if (keys.join(',') !== 'bytes,path,sha256') {
      problems.push(problem(CLOSURE_CODES.BAD_ENTRY,
        `第 ${index + 1} 个条目的字段必须是 path/bytes/sha256，实际 ${keys.join(',') || '(空)'}`))
      continue
    }
    // ★ 路径口径与归档条目**同一个函数**。两份实现会在某一次改动之后
    //   对同一个字符串给出不同结论，而那意味着"闭包说没问题、解压说越界"。
    const name = validateEntryName(raw.path)
    if (!name.ok) {
      problems.push(problem(CLOSURE_CODES.PATH_PROBLEM, `条目路径不合法：${raw.path}（${name.reason}）`, raw.path))
      continue
    }
    if (name.path !== raw.path) {
      // 闭包里存的是**规范化之后**的路径；带着尾斜杠或空段进来的条目
      // 会让"闭包里的 path"与"归档条目的 path"对不上。
      problems.push(problem(CLOSURE_CODES.PATH_PROBLEM,
        `条目路径不是规范化形式：${JSON.stringify(raw.path)} 应为 ${JSON.stringify(name.path)}`, raw.path))
      continue
    }
    if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0) {
      problems.push(problem(CLOSURE_CODES.BAD_ENTRY, `条目 ${raw.path} 的 bytes 必须是非负整数`, raw.path))
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(raw.sha256)) {
      problems.push(problem(CLOSURE_CODES.BAD_ENTRY, `条目 ${raw.path} 的 sha256 必须是 64 位小写十六进制`, raw.path))
      continue
    }
    if (seen.has(raw.path)) {
      problems.push(problem(CLOSURE_CODES.DUPLICATE, `条目路径重复：${raw.path}`, raw.path))
      continue
    }
    // ★ 必须升序且无重复。排序不是审美：它是"闭包摘要稳定"的前提，
    //   而摘要不稳定会让发布端与客户端算出不同的值——一次永远失败的升级。
    if (previousPath !== null && raw.path <= previousPath) {
      problems.push(problem(CLOSURE_CODES.UNSORTED,
        `条目顺序不是严格升序：${previousPath} 之后是 ${raw.path}`, raw.path))
      continue
    }
    seen.add(raw.path)
    previousPath = raw.path
    totalBytes += raw.bytes
    files.push(Object.freeze({ path: raw.path, bytes: raw.bytes, sha256: raw.sha256 }))
  }

  if (problems.length > 0) {
    const first = problems[0]
    return Object.freeze({
      ok: false, code: first.code, reason: first.message,
      problems: Object.freeze(problems), files: null,
    })
  }
  return Object.freeze({
    ok: true, code: null, reason: null, problems: Object.freeze([]),
    files: Object.freeze(files),
    totalBytes,
  })
}

/** 由文件表构造闭包（发布端）。**排序在这里发生**，而且只在这里。 */
export function buildClosure(files) {
  const sorted = [...files]
    .map((file) => ({ path: checkPath(file.path), bytes: file.bytes, sha256: file.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].path === sorted[i - 1].path) throw new Error(`闭包里路径重复：${sorted[i].path}`)
  }
  return Object.freeze({ protocol: CLOSURE_PROTOCOL, files: Object.freeze(sorted.map((file) => Object.freeze(file))) })
}

function checkPath(path) {
  const name = validateEntryName(path)
  if (!name.ok) throw new Error(`闭包路径不合法：${path}（${name.reason}）`)
  if (name.path !== path) throw new Error(`闭包路径不是规范化形式：${path} 应为 ${name.path}`)
  return path
}

/** 闭包的落盘字节。与 envelope 同一纪律：**规范化**，确保摘要唯一。 */
export function serializeClosure(closure) {
  return Buffer.from(`${canonicalJson(closure)}\n`, 'utf8')
}

/** 闭包字节的裸十六进制摘要（发行清单里 `closureSha256` 用的就是这个口径）。 */
export function closureDigest(bytes) {
  return sha256Hex(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8'))
}

/** 解析并校验闭包字节。 */
export function parseClosure(bytes, { maxBytes = MAX_CLOSURE_BYTES } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
  if (buffer.length > maxBytes) {
    return Object.freeze({
      ok: false, code: CLOSURE_CODES.TOO_LARGE, reason: `闭包 ${buffer.length} 字节超过上限 ${maxBytes}`,
      problems: Object.freeze([problem(CLOSURE_CODES.TOO_LARGE, `闭包 ${buffer.length} 字节超过上限 ${maxBytes}`)]),
      files: null,
    })
  }
  let parsed
  try {
    parsed = parseJsonStrict(buffer, { maxBytes })
  } catch (error) {
    return Object.freeze({
      ok: false, code: CLOSURE_CODES.BAD_FORMAT, reason: `闭包不是严格 JSON：${error?.message ?? error}`,
      problems: Object.freeze([problem(CLOSURE_CODES.BAD_FORMAT, String(error?.message ?? error))]), files: null,
    })
  }
  return validateClosure(parsed)
}

/**
 * 从一个目录树构造闭包（发布端）。
 *
 * ★ 拒绝符号链接与目录联接，理由与解压端同一条：一份"从符号链接读出来"
 *   的闭包描述的是**另一个位置**的内容，而解压端会按路径去找，找到的东西
 *   可能不同。
 */
export function closureFromDirectory(root, {
  readFile = (path) => readFileSync(path),
  readdir = (path, options) => readdirSync(path, options),
  stat = (path) => statSync(path),
  lstat = null,
} = {}) {
  const files = []
  const problems = []
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdir(dir, { withFileTypes: true }) } catch (error) {
      problems.push(`读不到目录 ${dir}：${error?.message ?? error}`)
      return
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) {
        problems.push(`目录树里有符号链接：${relativePath}`)
        continue
      }
      if (entry.isDirectory()) { walk(absolute, relativePath); continue }
      if (!entry.isFile()) {
        problems.push(`目录树里有非普通文件：${relativePath}`)
        continue
      }
      let bytes
      try { bytes = readFile(absolute) } catch (error) {
        problems.push(`读不到文件 ${relativePath}：${error?.message ?? error}`)
        continue
      }
      const name = validateEntryName(relativePath)
      if (!name.ok) {
        problems.push(`文件路径不合法：${relativePath}（${name.reason}）`)
        continue
      }
      files.push({ path: name.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  walk(root, '')
  if (problems.length > 0) {
    return Object.freeze({ ok: false, problems: Object.freeze(problems), closure: null })
  }
  return Object.freeze({ ok: true, problems: Object.freeze([]), closure: buildClosure(files) })
}

/** 相对路径口径（发布端列目录时用），与闭包/归档条目一致。 */
export function toClosurePath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckClosure() {
  const problems = []

  const good = buildClosure([
    { path: 'b.txt', bytes: 1, sha256: 'b'.repeat(64) },
    { path: 'a/x.txt', bytes: 2, sha256: 'a'.repeat(64) },
  ])
  if (good.files.map((file) => file.path).join(',') !== 'a/x.txt,b.txt') {
    problems.push(`闭包没有按路径升序排序：${good.files.map((file) => file.path).join(',')}`)
  }
  const validated = validateClosure(good)
  if (!validated.ok) problems.push(`合法闭包没通过：${validated.reason}`)

  // 字节 → 值 → 字节 往返必须稳定（摘要稳定的前提）。
  const bytes = serializeClosure(good)
  if (closureDigest(bytes) !== closureDigest(serializeClosure(parseClosureFiles(bytes)))) {
    problems.push('闭包字节往返之后摘要不稳定')
  }

  const cases = [
    ['协议不对', { protocol: 'x', files: [] }],
    ['files 不是数组', { protocol: CLOSURE_PROTOCOL, files: null }],
    ['条目多字段', { protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1, sha256: 'a'.repeat(64), extra: 1 }] }],
    ['路径穿越', { protocol: CLOSURE_PROTOCOL, files: [{ path: '../a', bytes: 1, sha256: 'a'.repeat(64) }] }],
    ['路径未规范化', { protocol: CLOSURE_PROTOCOL, files: [{ path: 'a/', bytes: 1, sha256: 'a'.repeat(64) }] }],
    ['摘要太短', { protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: 1, sha256: 'abc' }] }],
    ['字节为负', { protocol: CLOSURE_PROTOCOL, files: [{ path: 'a', bytes: -1, sha256: 'a'.repeat(64) }] }],
    ['重复路径', {
      protocol: CLOSURE_PROTOCOL,
      files: [{ path: 'a', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'a', bytes: 1, sha256: 'a'.repeat(64) }],
    }],
    ['未排序', {
      protocol: CLOSURE_PROTOCOL,
      files: [{ path: 'b', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'a', bytes: 1, sha256: 'a'.repeat(64) }],
    }],
  ]
  for (const [name, value] of cases) {
    if (validateClosure(value).ok) problems.push(`「${name}」被接受了`)
  }
  // 严格 JSON 层：重复键与非法数字也要在闭包这一层被拒。
  if (parseClosure('{"protocol":"legion/update-closure@1","files":[],"files":[]}').ok) {
    problems.push('含重复键的闭包被接受了')
  }
  if (parseClosure('not json').ok) problems.push('非 JSON 闭包被接受了')
  if (parseClosure('{"protocol":"legion/update-closure@1","files":[]}', { maxBytes: 8 }).ok) {
    problems.push('超限闭包被接受了')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    protocol: CLOSURE_PROTOCOL,
    entryName: CLOSURE_ENTRY_NAME,
    maxBytes: MAX_CLOSURE_BYTES,
    sample: Object.freeze({ sorted: good.files.map((file) => file.path), digest: closureDigest(bytes).slice(0, 16) }),
  })
}

function parseClosureFiles(bytes) {
  const parsed = parseClosure(bytes)
  return Object.freeze({ protocol: parsed.protocol ?? CLOSURE_PROTOCOL, files: parsed.files })
}

export const CLOSURE_CHECKED = selfCheckClosure()
