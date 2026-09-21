// 一次性探针 v2：日志是多帧 zstd（追加写），逐帧解压后再搜。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = process.env.DSH_SESSIONS ?? 'C:/Users/11150/.dsh/sessions'
const NEEDLE = process.env.NEEDLE ?? "reading 'prepare'"

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name === 'session.v3.jsonl.zstd') out.push({ p, mtime: st.mtimeMs, size: st.size })
  }
  return out
}

function frames(buf) {
  const offs = []
  let i = 0
  while (true) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    offs.push(at)
    i = at + 4
  }
  const out = []
  for (let k = 0; k < offs.length; k += 1) {
    const start = offs[k]
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    out.push(buf.subarray(start, end))
  }
  return out
}

function decodeAll(buf) {
  const parts = []
  for (const f of frames(buf)) {
    try {
      parts.push(zstdDecompressSync(f).toString('utf8'))
    } catch (e) {
      parts.push('')
    }
  }
  return parts.join('')
}

const files = walk(ROOT).sort((a, b) => b.mtime - a.mtime).slice(0, 14)
for (const f of files) {
  const buf = readFileSync(f.p)
  const text = decodeAll(buf)
  const i = text.indexOf(NEEDLE)
  console.log(`${f.p}\n   raw=${buf.length} decoded=${text.length} ${i < 0 ? 'no-hit' : 'HIT@' + i}`)
  if (i < 0) continue
  let from = 0
  for (let n = 0; n < 3; n += 1) {
    const at = text.indexOf(NEEDLE, from)
    if (at < 0) break
    from = at + NEEDLE.length
    const ls = text.lastIndexOf('\n', at) + 1
    const le = text.indexOf('\n', at)
    const line = text.slice(ls, le < 0 ? undefined : le)
    console.log(`  ---- occurrence ${n + 1} (len=${line.length})`)
    console.log('  ' + line.slice(0, 4000))
  }
}
