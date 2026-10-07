// product/update/fixtures/zip.mjs
// ============================================================================
// 测试用的最小 ZIP 构造器 —— **不是**生产代码
//
// 为什么需要一个共享的构造器而不是每个测试文件里各写一份：
// 驱动"越界路径""软链接""重复目标""解压炸弹""未知可执行文件"这五条判据，
// 必须能造出**语法合法但内容恶意**的归档。现成的打包库做不到——它们的 API
// 正是"写一个正常的压缩包"，而五种恶意形态里有三种（越界名字、重复目标、
// 越界可执行文件）会被它们主动拒绝或规范化掉。
//
// ## 它为什么在 `fixtures/` 里
//
// `stage.mjs` 的打包过滤规则是：
//
//     /(^|\/)(tests?|__tests__|node_modules|archive|fixtures?|probes)(\/|$)/
//
// 也就是**目录名**为 `fixtures` 或 `tests` 的整棵子树不进安装包。所以
// "造恶意归档的代码"必须放进这个目录——放在 `product/update/` 根下时它会
// 被当成生产代码拷进用户的安装包，而那份代码的唯一用途是构造攻击样例。
//
//   > 一份"只用于测试、但会被打进安装包"的恶意样例构造器，
//   > 与一份"忘记排除的调试后门"在安装包里的字节形态上没有区别。
//
// `shell-files.test.mjs` 有一条断言守着这件事：`fixtures/` 下的路径不得
// 出现在任何打包闭包里。
// ============================================================================

import { deflateRawSync } from 'node:zlib'

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

/**
 * 造一个 ZIP。
 *
 * @param {Array<{name: string, bytes?: Buffer, method?: number, unixMode?: number|null,
 *   isDirectory?: boolean, declaredUncompressed?: number}>} entries
 */
export function makeZipFixture(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = entry.bytes ?? Buffer.alloc(0)
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const uncompressed = entry.declaredUncompressed ?? raw.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc32Of(raw), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressed, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)

    const unixMode = entry.unixMode === undefined
      ? (entry.isDirectory ? 0o40755 : 0o100644)
      : entry.unixMode
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc32Of(raw), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(unixMode === null ? 0 : ((unixMode & 0xffff) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + payload.length
  }
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBytes, eocd])
}
