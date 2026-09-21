// 探针 v3：还原出错那一轮的事件序列（只读）。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const TARGET = process.argv[2] ?? 'C:/Users/11150/.dsh/sessions/--D-project-DSH-legion--/session-719a3bbe-a986-4e28-bb3b-0eeadcb1782b/session.v3.jsonl.zstd'

function decodeAll(buf) {
  const offs = []
  let i = 0
  while (true) { const at = buf.indexOf(MAGIC, i); if (at < 0) break; offs.push(at); i = at + 4 }
  const parts = []
  for (let k = 0; k < offs.length; k += 1) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8')) } catch {}
  }
  return parts.join('')
}

const text = decodeAll(readFileSync(TARGET))
const lines = text.split('\n').filter(Boolean)
console.log(`events=${lines.length}`)
for (const line of lines) {
  let e
  try { e = JSON.parse(line) } catch { continue }
  const t = e.type
  const keep = /^(turn\/|agent\/|session\/|system|user\/|assistant|tool|model|llm|error|plugin|compose|preset|startup)/.test(t ?? '')
  if (!keep) continue
  const seq = e.seq
  const d = e.data ?? {}
  let brief = ''
  if (t === 'turn/start') brief = JSON.stringify(d).slice(0, 300)
  else if (t === 'turn/end') brief = JSON.stringify(d).slice(0, 400)
  else if (t === 'agent/inbox/spliced') brief = `inserted=${(d.inserted ?? []).length}`
  else if (t === 'user/message') brief = JSON.stringify(d.content ?? '').slice(0, 160)
  else if (t === 'assistant/message' || t === 'assistant/delta') brief = JSON.stringify(d).slice(0, 200)
  else if (/tool/.test(t)) brief = JSON.stringify(d).slice(0, 240)
  else brief = JSON.stringify(d).slice(0, 240)
  console.log(`${String(seq).padStart(4)} ${new Date(e.time ?? 0).toISOString()} ${t} :: ${brief}`)
}
