// product/update/extract.mjs
// ============================================================================
// 升级包解压 —— 设计 §6 line 142 那五条拒绝判据
//
// 原文：「压缩包解压前后校验闭包；拒绝越界路径、软链接/重解析点、重复目标、
// 解压炸弹及未知可执行文件。」
//
// 五条，每一条都对应一类真实的归档攻击。这里逐条说清"拒绝了什么"以及
// "不拒绝会怎样"：
//
//   ① **越界路径** —— `../../Windows/System32/x.dll`、`C:\x`、
//      `\\?\C:\x`、`a\..\b`（Windows 上 `\` 是分隔符，POSIX 实现会把它
//      当普通字符）。不拒绝：解压直接把文件写到程序目录之外。
//
//   ② **软链接 / 重解析点** —— ZIP 里带 Unix mode 的 symlink 条目，
//      或 Windows 上的 junction。不拒绝：解压出来的"目录"指向别处，
//      于是后续写入（包括我们自己的校验）落在完全不同的位置。这是
//      "解压 → 校验 → 切换"这条链里最隐蔽的一环，因为校验读到的内容
//      与最终生效的内容可以不同。
//
//   ③ **重复目标** —— 同一个规范化路径出现两次。不拒绝：两个条目的
//      胜负取决于解压器的遍历顺序，而"实际生效的是哪一个"在清单校验
//      里看不出来。
//
//   ④ **解压炸弹** —— 声明或实际的展开体积远大于压缩体积。不拒绝：
//      一个几 MB 的包在临时目录里展开成几十 GB。
//
//   ⑤ **未知可执行文件** —— 闭包里出现了不在清单上的 `.exe/.dll/.node/
//      .scr/.cpl/.sys`。不拒绝：一次"升级"可以往程序目录里塞任意二进制。
//      这一条是"包摘要对得上就安全"的反例——摘要对得上只说明包没被换，
//      不说明包里没有别的东西。
//
// ## 为什么自己解析 ZIP 而不引依赖
//
// 本仓库零第三方运行时依赖（`desktop/payload` 里的 Node 是随包的运行时，
// 不是库）。而解压恰好是**必须自己看得见**的一层：一个"交给 zip 库"的
// 实现无法拒绝③与⑤——那两条需要看**条目集合**，而库的 API 通常只给
// "逐个解到磁盘"。
//
// 只支持 `stored`(0) 与 `deflate`(8)：发布端由我们自己控制，而"支持
// 更多压缩算法"带来的只是更大的攻击面。
// ============================================================================

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const EXTRACT_CODES = Object.freeze({
  BAD_ARCHIVE: 'extract-bad-archive',
  UNSUPPORTED_METHOD: 'extract-unsupported-method',
  PATH_ESCAPE: 'extract-path-escape',
  SYMLINK: 'extract-symlink',
  DUPLICATE_TARGET: 'extract-duplicate-target',
  BOMB: 'extract-bomb',
  UNKNOWN_EXECUTABLE: 'extract-unknown-executable',
  DIGEST_MISMATCH: 'extract-digest-mismatch',
  MISSING_ENTRY: 'extract-missing-entry',
  EXTRA_ENTRY: 'extract-extra-entry',
  WRITE_FAILED: 'extract-write-failed',
})

/** 压缩方式。只认这两个。 */
export const SUPPORTED_METHODS = Object.freeze({ STORED: 0, DEFLATE: 8 })

/**
 * 可执行/可加载的后缀。出现这些名字的条目必须在闭包清单里逐条列出。
 *
 * 列表**故意**偏保守：`.js`/`.mjs` 也在其中，因为它们同样会在随包 Node
 * 下被执行。`.json`/`.txt`/`.html` 不在其中——它们由上层的内容策略管。
 */
export const EXECUTABLE_EXTENSIONS = Object.freeze([
  '.exe', '.dll', '.node', '.scr', '.cpl', '.sys', '.com', '.bat', '.cmd',
  '.ps1', '.psm1', '.vbs', '.js', '.mjs', '.cjs', '.jar', '.msi', '.ocx', '.drv',
])

/** 解压炸弹判据。三档一起用，因为单看任何一档都能被绕开。 */
export const BOMB_POLICY = Object.freeze({
  /** 单个条目展开后的上限（1 GiB）。 */
  maxEntryBytes: 1024 * 1024 * 1024,
  /** 整包展开后的上限（4 GiB）。 */
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  /** 压缩比上限：展开/压缩。正常文本约 3–10，二进制约 1–3。 */
  maxRatio: 200,
  /** 条目数上限。 */
  maxEntries: 100_000,
})

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024

function findEndOfCentralDirectory(buffer) {
  // EOCD 签名 0x06054b50，最小 22 字节，注释最长 65535。
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 读中央目录。**不做任何信任假设**：每个偏移都先比对边界。
 */
export function readCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: '输入不是 Buffer' }
  if (buffer.length < 22) return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `归档只有 ${buffer.length} 字节，放不下 EOCD` }
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `归档 ${buffer.length} 字节超过上限` }
  }
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: '找不到 EOCD（不是 ZIP，或用了 ZIP64 而本实现不支持）' }
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset + directorySize > buffer.length) {
    return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: '中央目录越出归档边界' }
  }
  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) {
      return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `第 ${index + 1} 个中央目录项越出边界` }
    }
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `第 ${index + 1} 个中央目录项签名不对` }
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc32 = buffer.readUInt32LE(cursor + 16)
    const compressedBytes = buffer.readUInt32LE(cursor + 20)
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength > buffer.length) {
      return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `第 ${index + 1} 个条目的名字越界` }
    }
    // ★ 条目名一律按 UTF-8 之外的（CP437/GBK）字节流是不可能的：本仓库的
    //   发布端只产 UTF-8 名字。非法字节被替换成 U+FFFD 时拒——因为两个
    //   不同的字节串可能落到同一个替换结果上，于是"重复目标"判据失效。
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = rawName.toString('utf8')
    if (name.includes('\ufffd')) {
      return { ok: false, code: EXTRACT_CODES.BAD_ARCHIVE, reason: `第 ${index + 1} 个条目的名字不是合法 UTF-8` }
    }
    entries.push(Object.freeze({
      index,
      name,
      method,
      crc32,
      compressedBytes,
      uncompressedBytes,
      versionMadeBy,
      externalAttributes,
      localOffset,
      /** 目录条目：名字以 `/` 结尾，或外部属性里的 Unix mode 是目录。 */
      isDirectory: name.endsWith('/') || ((externalAttributes >>> 16) & 0xf000) === 0o40000,
      /** Unix mode（只有 `versionMadeBy` 高位是 3=Unix 时才有意义）。 */
      unixMode: (versionMadeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : null,
    }))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return { ok: true, code: null, reason: null, entries: Object.freeze(entries), entryCount }
}

/**
 * 规范化并校验一个条目名。
 *
 * 这是①的**唯一**落点。四条独立的拒绝：
 *   · 绝对路径（`/x`、`\\x`、`C:\x`、`C:/x`）；
 *   · 反斜杠（Windows 上是分隔符，POSIX 上是普通字符——两个平台读法不同）；
 *   · 任何 `..` 段；
 *   · 百分号（与清单路径同一条纪律：不做解码，也就不存在"解码之后才是
 *     `../`"）。
 */
export function validateEntryName(name) {
  if (typeof name !== 'string' || name === '') {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: '条目名为空' }
  }
  if (name.includes('\u0000')) return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名含 NUL：${JSON.stringify(name)}` }
  if (name.startsWith('/') || name.startsWith('\\')) {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名是绝对路径：${name}` }
  }
  if (/^[A-Za-z]:/.test(name)) {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名带盘符：${name}` }
  }
  if (name.includes('\\')) {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名含反斜杠（两个平台读法不同）：${name}` }
  }
  if (name.includes('%')) {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名含百分号编码：${name}` }
  }
  if (name.includes('//')) {
    return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名含空路径段：${name}` }
  }
  const segments = name.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名没有有效路径段：${JSON.stringify(name)}` }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名含父目录段：${name}` }
    }
    if (segment.length > 255) return { ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目名的路径段过长：${name}` }
  }
  // 归一化之后的相对路径（目录条目去掉尾斜杠）。
  return { ok: true, code: null, reason: null, path: segments.join('/'), segments: Object.freeze(segments) }
}

/** 后缀是否在可执行集合里。 */
export function looksExecutable(path) {
  const lower = path.toLowerCase()
  return EXECUTABLE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * 计划一次解压：只读中央目录 + 校验，**不写任何文件**。
 *
 * 分成"计划"与"执行"两步，是因为设计 §6 要求"解压**前后**校验闭包"：
 * 计划阶段回答"这个归档允不允许展开"，执行阶段回答"展开出来的东西与
 * 清单是否逐字节一致"。
 *
 * @param {object} args
 * @param {Buffer} args.archiveBytes
 * @param {ReadonlyArray<{path: string, sha256: string, bytes: number}>} [args.closure]
 *        允许出现的条目闭包。给了它就会**同时**拒未知可执行文件与多余条目。
 * @param {object} [args.policy]
 */
export function planExtraction({ archiveBytes, closure = null, policy = BOMB_POLICY } = {}) {
  const directory = readCentralDirectory(archiveBytes)
  if (!directory.ok) return Object.freeze({ ok: false, code: directory.code, reason: directory.reason, plan: null })

  if (directory.entries.length > policy.maxEntries) {
    return Object.freeze({
      ok: false, code: EXTRACT_CODES.BOMB,
      reason: `归档有 ${directory.entries.length} 个条目，超过上限 ${policy.maxEntries}`, plan: null,
    })
  }

  const closureByPath = closure === null ? null : new Map(closure.map((item) => [item.path, item]))
  const targets = new Map()
  const files = []
  let totalBytes = 0

  for (const entry of directory.entries) {
    const nameCheck = validateEntryName(entry.isDirectory ? `${entry.name.replace(/\/+$/, '')}/` : entry.name)
    if (!nameCheck.ok) return Object.freeze({ ok: false, code: nameCheck.code, reason: `${entry.name}：${nameCheck.reason}`, plan: null })
    const path = nameCheck.path

    // ② 软链接 / 重解析点。
    if (entry.unixMode !== null && (entry.unixMode & 0xf000) === 0o120000) {
      return Object.freeze({ ok: false, code: EXTRACT_CODES.SYMLINK, reason: `归档含软链接条目：${entry.name}`, plan: null })
    }
    if (entry.isDirectory) {
      if (targets.has(path)) {
        return Object.freeze({ ok: false, code: EXTRACT_CODES.DUPLICATE_TARGET, reason: `重复的目录目标：${path}`, plan: null })
      }
      targets.set(path, 'directory')
      continue
    }
    if (entry.method !== SUPPORTED_METHODS.STORED && entry.method !== SUPPORTED_METHODS.DEFLATE) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.UNSUPPORTED_METHOD,
        reason: `条目 ${entry.name} 用了压缩方式 ${entry.method}，本实现只支持 stored/deflate`, plan: null,
      })
    }

    // ③ 重复目标。
    if (targets.has(path)) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.DUPLICATE_TARGET,
        reason: `归档里出现重复目标 ${path}（第 ${targets.get(path) === 'directory' ? '目录' : '文件'}之后又出现一次）：`
          + '两个条目的胜负取决于解压顺序，而"实际生效的是哪一个"在清单校验里看不出来',
        plan: null,
      })
    }
    targets.set(path, 'file')

    // ④ 解压炸弹：单条目、总量、压缩比三档一起判。
    if (entry.uncompressedBytes > policy.maxEntryBytes) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.BOMB,
        reason: `条目 ${entry.name} 声明展开 ${entry.uncompressedBytes} 字节，超过单条目上限 ${policy.maxEntryBytes}`, plan: null,
      })
    }
    const ratio = entry.compressedBytes === 0
      ? (entry.uncompressedBytes === 0 ? 1 : Number.POSITIVE_INFINITY)
      : entry.uncompressedBytes / entry.compressedBytes
    if (ratio > policy.maxRatio) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.BOMB,
        reason: `条目 ${entry.name} 的压缩比 ${ratio.toFixed(1)} 超过上限 ${policy.maxRatio}`, plan: null,
      })
    }
    totalBytes += entry.uncompressedBytes
    if (totalBytes > policy.maxTotalBytes) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.BOMB,
        reason: `归档展开总量超过上限 ${policy.maxTotalBytes} 字节（在 ${entry.name} 处）`, plan: null,
      })
    }

    // ⑤ 未知可执行文件 + 多余条目。
    if (closureByPath !== null) {
      if (!closureByPath.has(path)) {
        return Object.freeze({
          ok: false,
          code: looksExecutable(path) ? EXTRACT_CODES.UNKNOWN_EXECUTABLE : EXTRACT_CODES.EXTRA_ENTRY,
          reason: looksExecutable(path)
            ? `归档含闭包之外的可执行文件：${path}（摘要对得上只说明包没被换，不说明包里没有别的东西）`
            : `归档含闭包之外的条目：${path}`,
          plan: null,
        })
      }
      const expected = closureByPath.get(path)
      if (Number.isSafeInteger(expected.bytes) && expected.bytes !== entry.uncompressedBytes) {
        return Object.freeze({
          ok: false, code: EXTRACT_CODES.MISSING_ENTRY,
          reason: `条目 ${path} 声明 ${entry.uncompressedBytes} 字节，闭包声明 ${expected.bytes} 字节`, plan: null,
        })
      }
    } else if (looksExecutable(path)) {
      // 没有闭包时**仍然**拒可执行文件：一条"没给闭包所以可执行文件随便进"
      // 的默认路径，会在某一次调用方忘了传闭包时静默放行。
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.UNKNOWN_EXECUTABLE,
        reason: `归档含可执行文件 ${path}，但没有提供闭包清单来授权它`, plan: null,
      })
    }

    files.push(Object.freeze({ path, method: entry.method, crc32: entry.crc32, compressedBytes: entry.compressedBytes, uncompressedBytes: entry.uncompressedBytes, localOffset: entry.localOffset }))
  }

  // 闭包里的每一项都必须在归档里出现（"解压前后校验闭包"的另一半）。
  if (closureByPath !== null) {
    const present = new Set(files.map((file) => file.path))
    const missing = [...closureByPath.keys()].filter((path) => !present.has(path))
    if (missing.length > 0) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.MISSING_ENTRY,
        reason: `闭包里有 ${missing.length} 个条目不在归档中：${missing.slice(0, 5).join(', ')}`, plan: null,
      })
    }
  }

  return Object.freeze({
    ok: true, code: null, reason: null,
    plan: Object.freeze({
      files: Object.freeze(files),
      directories: Object.freeze([...targets.entries()].filter(([, kind]) => kind === 'directory').map(([path]) => path)),
      totalUncompressedBytes: totalBytes,
      entryCount: directory.entries.length,
    }),
  })
}

/** 解出一个条目的字节。 */
function readEntry(buffer, entry) {
  if (entry.localOffset + 30 > buffer.length) return null
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) return null
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedBytes
  if (dataEnd > buffer.length) return null
  const raw = buffer.subarray(dataStart, dataEnd)
  if (entry.method === SUPPORTED_METHODS.STORED) {
    // stored 的声明大小必须与实际一致，否则"压缩比 1"的炸弹从这里进来。
    if (raw.length !== entry.uncompressedBytes) return null
    return raw
  }
  try {
    const inflated = inflateRawSync(raw, { maxOutputLength: entry.uncompressedBytes })
    // ★ 用 zlib 的 `maxOutputLength` **而不是**解完再看长度：后者在
    //   "声明 1 KB、实际 4 GB"的炸弹上会先把 4 GB 解进内存。
    if (inflated.length !== entry.uncompressedBytes) return null
    return inflated
  } catch {
    return null
  }
}

/**
 * 执行解压。
 *
 * @param {object} args
 * @param {Buffer} args.archiveBytes
 * @param {string} args.targetDir
 * @param {ReadonlyArray<object>} [args.closure]
 * @param {boolean} [args.dryRun] 只做校验，不写文件
 * @param {Function} [args.onProgress]
 */
export function extractArchive({
  archiveBytes, targetDir, closure = null, policy = BOMB_POLICY, dryRun = false, onProgress = null,
} = {}) {
  const planned = planExtraction({ archiveBytes, closure, policy })
  if (!planned.ok) return Object.freeze({ ok: false, code: planned.code, reason: planned.reason, written: Object.freeze([]) })

  const root = resolve(targetDir)
  const written = []
  const digests = new Map()

  for (const directory of planned.plan.directories) {
    if (dryRun) continue
    const absolute = resolve(root, ...directory.split('/'))
    if (!isInside(root, absolute)) {
      return Object.freeze({ ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `目录落到目标之外：${directory}`, written: Object.freeze(written) })
    }
    mkdirSync(absolute, { recursive: true })
  }

  for (const file of planned.plan.files) {
    const bytes = readEntry(archiveBytes, file)
    if (bytes === null) {
      return Object.freeze({
        ok: false, code: EXTRACT_CODES.BAD_ARCHIVE,
        reason: `条目 ${file.path} 解不出来（本地头损坏，或实际大小与中央目录声明不符）`,
        written: Object.freeze(written),
      })
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    digests.set(file.path, Object.freeze({ sha256: digest, bytes: bytes.length }))
    if (closure !== null) {
      const expected = closure.find((item) => item.path === file.path)
      if (expected !== undefined && typeof expected.sha256 === 'string' && expected.sha256 !== digest) {
        return Object.freeze({
          ok: false, code: EXTRACT_CODES.DIGEST_MISMATCH,
          reason: `条目 ${file.path} 的内容摘要不符（闭包 ${String(expected.sha256).slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`,
          written: Object.freeze(written),
        })
      }
    }
    if (!dryRun) {
      const absolute = resolve(root, ...file.path.split('/'))
      // ★ 双保险：条目名已经过 `validateEntryName`，这里再核一次"拼出来的
      //   绝对路径仍在目标目录之内"。两道判据独立，因为前者只看字符串，
      //   而后者看的是**实际拼接结果**（`resolve` 会处理 `.`、盘符、大小写）。
      if (!isInside(root, absolute)) {
        return Object.freeze({ ok: false, code: EXTRACT_CODES.PATH_ESCAPE, reason: `条目落到目标之外：${file.path}`, written: Object.freeze(written) })
      }
      try {
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, bytes, { mode: 0o644 })
      } catch (error) {
        return Object.freeze({
          ok: false, code: EXTRACT_CODES.WRITE_FAILED,
          reason: `写入 ${file.path} 失败：${error?.message ?? error}`, written: Object.freeze(written),
        })
      }
      written.push(Object.freeze({ path: file.path, absolute, bytes: bytes.length, sha256: digest }))
    }
    if (typeof onProgress === 'function') {
      try { onProgress({ path: file.path, bytes: bytes.length, total: planned.plan.totalUncompressedBytes }) } catch { /* 进度回调不该影响解压 */ }
    }
  }

  return Object.freeze({
    ok: true, code: null, reason: null,
    written: Object.freeze(written),
    digests: Object.freeze(Object.fromEntries(digests)),
    totalBytes: planned.plan.totalUncompressedBytes,
    fileCount: planned.plan.files.length,
  })
}

/** 目标是否在根之内（按平台分隔符）。 */
export function isInside(root, candidate) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  const a = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  const b = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  return b === root || b.startsWith(a)
}

/**
 * 解压**之后**的闭包核对：目录里出现的东西必须与计划逐条一致。
 *
 * "解压前后校验"里的"后"这一半。它挡的是"解压器写出了计划之外的文件"
 * ——包括"目录里本来就有的旧文件被当成本次的产物"。
 */
export function verifyExtractedTree({ targetDir, expected }) {
  const root = resolve(targetDir)
  const problems = []
  const seen = new Set()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      // ★ 符号链接 / 重解析点在**解压之后**再拒一次：一个"先解压出普通
      //   文件、再由另一个条目把它变成链接"的序列在计划阶段看不出来。
      if (entry.isSymbolicLink()) {
        problems.push(`解压结果里出现符号链接：${relative}`)
        continue
      }
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        seen.add(`${relative}/`)
        walk(absolute, relative)
        continue
      }
      seen.add(relative)
      const info = statSync(absolute)
      const expectedEntry = expected.find((item) => item.path === relative)
      if (expectedEntry === undefined) {
        problems.push(`解压结果里出现计划之外的条目：${relative}`)
        continue
      }
      if (Number.isSafeInteger(expectedEntry.bytes) && info.size !== expectedEntry.bytes) {
        problems.push(`条目 ${relative} 大小不符：期望 ${expectedEntry.bytes}，实际 ${info.size}`)
      }
      const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex')
      if (typeof expectedEntry.sha256 === 'string' && digest !== expectedEntry.sha256) {
        problems.push(`条目 ${relative} 摘要不符`)
      }
    }
  }
  walk(root, '')
  const missing = expected.filter((item) => !seen.has(item.path)).map((item) => item.path)
  if (missing.length > 0) problems.push(`解压结果缺少 ${missing.length} 个条目：${missing.slice(0, 5).join(', ')}`)
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

import * as fsModule from 'node:fs'

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckExtract() {
  const problems = []
  // ① 路径判据：五类越界都要被拒。
  for (const bad of ['../x', 'a/../../b', '/abs', 'C:/x', 'C:\\x', 'a\\..\\b', '%2e%2e/x', 'a//b', '', '.', '..', 'a/\u0000b']) {
    if (validateEntryName(bad).ok) problems.push(`越界条目名被接受了：${JSON.stringify(bad)}`)
  }
  for (const good of ['a', 'a/b.txt', 'product/launcher/cli.mjs', 'x-y.z_1/t']) {
    if (!validateEntryName(good).ok) problems.push(`合法条目名被拒了：${good}`)
  }
  // 目录条目：尾斜杠要能过。
  if (!validateEntryName('a/b/').ok) problems.push('目录条目名被拒了：a/b/')
  // ⑤ 可执行判定。
  for (const name of ['x.exe', 'X.DLL', 'a/b.node', 'run.mjs', 'p.ps1', 'x.sys']) {
    if (!looksExecutable(name)) problems.push(`可执行后缀没被识别：${name}`)
  }
  for (const name of ['x.txt', 'x.json', 'x.html', 'x.css', 'x.png', 'notes.zh-CN.txt']) {
    if (looksExecutable(name)) problems.push(`非可执行后缀被误判：${name}`)
  }
  // ④ 炸弹策略必须是有限的正数。
  for (const [key, value] of Object.entries(BOMB_POLICY)) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`炸弹策略 ${key} 不是正数`)
  }
  // EOCD 找不到时明确报"不是 ZIP"，而不是抛。
  const notZip = readCentralDirectory(Buffer.from('not a zip at all, but long enough to pass the length check maybe'))
  if (notZip.ok) problems.push('非 ZIP 输入被当成了 ZIP')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    methods: SUPPORTED_METHODS,
    policy: BOMB_POLICY,
    executableExtensions: EXECUTABLE_EXTENSIONS.length,
  })
}

export const EXTRACT_CHECKED = selfCheckExtract()
