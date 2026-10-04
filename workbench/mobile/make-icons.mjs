// workbench/mobile/make-icons.mjs
// 生成 PWA 图标（192 / 512）。零依赖：直接写 PNG。
//
// 为什么不在仓库里放几张二进制图：图标是**可重现的产物**，而不是源文件。
// 用脚本生成，改配色/形状时不必再找人重做图；`node make-icons.mjs` 即可。
//
// 形状：Legion 的三叶图标简化为三个同心圆弧 + 中心点（与仓库既有的
// `legion-icon.svg` 同构，但这里是纯像素生成，不依赖 SVG 渲染器）。
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const BG = [15, 17, 21]
const ACCENT = [110, 168, 254]
const ACCENT_2 = [74, 222, 128]

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // color type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0   // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const rOuter = size * 0.34
  const ring = size * 0.055
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - c
      const dy = y - c
      const d = Math.hypot(dx, dy)
      let color = BG
      // 圆角：角落按距离淡出（antialias 一圈 1px）。
      const corner = Math.max(Math.abs(dx), Math.abs(dy)) - size * 0.46
      const edge = Math.max(d, corner)
      const alpha = Math.max(0, Math.min(1, (size * 0.5 - edge) / 1.5))
      // 三个叶：120° 分开的三段弧。
      const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360
      const inRing = Math.abs(d - rOuter) < ring
      const leaf = Math.floor(ang / 120)
      const withinLeaf = inRing && ((ang % 120) > 18 && (ang % 120) < 102)
      if (withinLeaf) color = leaf === 2 ? ACCENT_2 : mix(ACCENT, ACCENT_2, leaf * 0.35)
      else if (d < size * 0.075) color = ACCENT
      const off = (y * size + x) * 4
      px[off] = color[0]; px[off + 1] = color[1]; px[off + 2] = color[2]
      px[off + 3] = Math.round(alpha * 255)
    }
  }
  return png(size, px)
}

for (const size of [192, 512]) {
  const file = join(HERE, `icon-${size}.png`)
  writeFileSync(file, render(size))
  console.log(`wrote ${file}`)
}
