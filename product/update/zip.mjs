// product/update/zip.mjs
// ============================================================================
// ZIP **写**端 —— 发布端产出升级包
//
// `fixtures/zip.mjs` 是测试用的恶意样例构造器，它刻意不做校验（那正是它的
// 用途）。这里是生产写端，它反过来：**拒绝一切它自己读端会拒绝的形状**。
//
// 判据的对齐方式是刻意的——写端与读端用**同一组**判据函数
// （`validateEntryName`），因为"发布端能造出读端不肯接受的包"这件事没有
// 任何好处，只有一次必然的 404 或一次解压失败：
//
//   · 条目名必须过 `validateEntryName`（与解压端同一个函数）；
//   · 只写 stored/deflate；
//   · **不写**符号链接（写出一个 link 条目等于让解压端拒掉自己的包）；
//   · 条目按路径**升序**写入，因此同一份输入产生**逐字节相同**的包——
//     这是"发布端与客户端算出同一个摘要"的前提；
//   · 拒绝重复路径。
//
// 排序与确定性不是审美：一个"两次打包得到不同字节"的发布流程，会让
// "这个包是不是我上次发的那个"变成一个无法回答的问题（设计 §4 line 78：
// 同版本不同字节也必须使用不同 releaseId）。
// ============================================================================

import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

import { validateEntryName } from './extract.mjs'

export const ZIP_METHODS = Object.freeze({ STORED: 0, DEFLATE: 8 })

/** deflate 的档位。发布产物要小，但更高档位带来的收益很小而耗时上升很快。 */
export const DEFAULT_DEFLATE_LEVEL = 9

/** 已经压缩过的媒体类型不值得再 deflate（压缩后往往更大）。 */
const ALREADY_COMPRESSED = Object.freeze([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.gz', '.tgz', '.br', '.7z', '.pdf',
  '.mp3', '.mp4', '.woff', '.woff2', '.node', '.exe', '.dll', '.asar',
])

export const ZIP_CODES = Object.freeze({
  BAD_ENTRY: 'zip-bad-entry',
  DUPLICATE: 'zip-duplicate',
  PATH_ESCAPE: 'zip-path-escape',
  TOO_LARGE: 'zip-too-large',
})

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32Of(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 这个路径值不值得压缩。 */
export function shouldCompress(path) {
  const lower = path.toLowerCase()
  return !ALREADY_COMPRESSED.some((extension) => lower.endsWith(extension))
}

/**
 * 造一个 ZIP。
 *
 * @param {Array<{path: string, bytes: Buffer, method?: number, isDirectory?: boolean}>} entries
 * @param {object} [options]
 * @returns {{ok: true, bytes: Buffer, entries: ReadonlyArray<object>} | {ok: false, code: string, reason: string}}
 */
export function buildZip(entries, { deflateLevel = DEFAULT_DEFLATE_LEVEL, nowMs = null } = {}) {
  const prepared = []
  const seen = new Set()
  for (const [index, raw] of [...entries].entries()) {
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, code: ZIP_CODES.BAD_ENTRY, reason: `第 ${index + 1} 个条目不是对象` }
    }
    const name = validateEntryName(raw.path)
    if (!name.ok) {
      return { ok: false, code: ZIP_CODES.PATH_ESCAPE, reason: `条目路径不合法：${raw.path}（${name.reason}）` }
    }
    if (name.path !== raw.path) {
      // 写端**不**替调用方规范化：闭包里的路径用的是同一个口径，静默改写会让
      // 两份东西在最不该分叉的地方分叉。
      return { ok: false, code: ZIP_CODES.PATH_ESCAPE, reason: `条目路径不是规范化形式：${raw.path} 应为 ${name.path}` }
    }
    if (seen.has(raw.path)) return { ok: false, code: ZIP_CODES.DUPLICATE, reason: `条目路径重复：${raw.path}` }
    seen.add(raw.path)
    const isDirectory = raw.isDirectory === true
    const bytes = isDirectory ? Buffer.alloc(0) : (Buffer.isBuffer(raw.bytes) ? raw.bytes : Buffer.from(raw.bytes ?? []))
    prepared.push({ path: raw.path, bytes, isDirectory, method: raw.method })
  }

  // ★ 升序写入：同输入 → 同字节。见文件头。
  prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const locals = []
  const centrals = []
  let offset = 0
  const written = []
  for (const entry of prepared) {
    const nameBytes = Buffer.from(entry.path, 'utf8')
    const compress = entry.isDirectory ? false : (entry.method === undefined ? shouldCompress(entry.path) : entry.method === ZIP_METHODS.DEFLATE)
    const method = compress ? ZIP_METHODS.DEFLATE : ZIP_METHODS.STORED
    const payload = compress ? deflateRawSync(entry.bytes, { level: deflateLevel }) : entry.bytes
    const crc = crc32Of(entry.bytes)
    // ZIP 的 32 位字段放不下 4 GiB；超出时明确拒，而不是截断成一个坏包。
    if (payload.length > 0xffffffff || entry.bytes.length > 0xffffffff) {
      return { ok: false, code: ZIP_CODES.TOO_LARGE, reason: `条目 ${entry.path} 超过 ZIP 的 4 GiB 字段上限` }
    }
    const dosTime = dosDateTime(entry.mtimeMs ?? nowMs)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)                        // version needed
    local.writeUInt16LE(0, 6)                         // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime.time, 10)
    local.writeUInt16LE(dosTime.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)

    const unixMode = entry.isDirectory ? 0o40755 : 0o100644
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)                  // made by Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime.time, 12)
    central.writeUInt16LE(dosTime.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((unixMode & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    written.push(Object.freeze({
      path: entry.path,
      bytes: entry.bytes.length,
      sha256: createHash('sha256').update(entry.bytes).digest('hex'),
      method,
      isDirectory: entry.isDirectory,
    }))
    offset += local.length + nameBytes.length + payload.length
  }

  const centralBytes = Buffer.concat(centrals)
  if (offset > 0xffffffff || centralBytes.length > 0xffffffff) {
    return { ok: false, code: ZIP_CODES.TOO_LARGE, reason: '归档超过 ZIP 的 4 GiB 字段上限' }
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return {
    ok: true,
    bytes: Buffer.concat([...locals, centralBytes, eocd]),
    entries: Object.freeze(written),
  }
}

/**
 * MS-DOS 时间戳。
 *
 * ZIP 的目录项里只有这个字段能带时间，而它的精度是 2 秒、范围到 2107 年。
 * **确定性优先**：默认把它钉成一个固定值（1980-01-01），于是同一份输入
 * 在任何时刻、任何机器上产出逐字节相同的包。要真实时间就必须显式传入
 * `nowMs`——把"文件系统的时间戳"带进产物字节是很常见的非确定性来源。
 */
export function dosDateTime(ms) {
  if (!Number.isFinite(ms)) return { time: 0, date: 0x0021 } // 1980-01-01
  const date = new Date(ms)
  const year = date.getUTCFullYear()
  if (year < 1980 || year > 2107) return { time: 0, date: 0x0021 }
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckZip() {
  const problems = []
  const entry = { path: 'a/b.txt', bytes: Buffer.from('hello') }
  const built = buildZip([entry])
  if (built.ok !== true) problems.push(`合法输入没有产出 ZIP：${built.reason}`)
  else {
    if (built.entries.length !== 1) problems.push('条目数不对')
    // 确定性：同输入两次必须逐字节相同。
    const again = buildZip([entry])
    if (!again.bytes.equals(built.bytes)) problems.push('同一份输入两次产出不同字节（不可复现）')
    // 顺序无关：颠倒输入顺序的结果必须相同（因为内部排序）。
    const reversed = buildZip([{ path: 'z.txt', bytes: Buffer.from('z') }, entry])
    const forward = buildZip([entry, { path: 'z.txt', bytes: Buffer.from('z') }])
    if (!reversed.bytes.equals(forward.bytes)) problems.push('输入顺序影响了产物字节')
  }

  // 写端必须拒一切读端会拒的形状。
  const rejects = [
    ['穿越路径', [{ path: '../x', bytes: Buffer.from('x') }]],
    ['绝对路径', [{ path: '/x', bytes: Buffer.from('x') }]],
    ['反斜杠', [{ path: 'a\\b', bytes: Buffer.from('x') }]],
    ['未规范化', [{ path: 'a/', bytes: Buffer.from('x') }]],
    ['重复路径', [{ path: 'a', bytes: Buffer.from('x') }, { path: 'a', bytes: Buffer.from('y') }]],
    ['非对象', [null]],
  ]
  for (const [name, entries] of rejects) {
    if (buildZip(entries).ok) problems.push(`写端接受了「${name}」`)
  }

  // 压缩判定。
  if (shouldCompress('a.txt') !== true) problems.push('文本应当被压缩')
  for (const path of ['a.png', 'a.zip', 'a.asar', 'a.node', 'a.exe']) {
    if (shouldCompress(path) !== false) problems.push(`${path} 不应当被压缩`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    methods: ZIP_METHODS,
    deflateLevel: DEFAULT_DEFLATE_LEVEL,
    sampleSize: buildZip([entry]).bytes?.length ?? null,
  })
}

export const ZIP_CHECKED = selfCheckZip()
