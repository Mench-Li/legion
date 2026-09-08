import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const src = process.argv[2]
const dst = process.argv[3]
const buf = readFileSync(src)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i <= buf.length - 4; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
const chunks = []
for (const s of starts) {
  const from = s; const to = s + 1 < starts.length ? starts[s + 1] : buf.length
  try { chunks.push(zstdDecompressSync(buf.subarray(from, to))) } catch { try { chunks.push(zstdDecompressSync(buf.subarray(from))) } catch {} }
}
const total = chunks.reduce((a, c) => a + c.length, 0)
const merged = Buffer.concat(chunks, total)
writeFileSync(dst, merged)

const events = []
for (const line of merged.toString('utf8').split('\n')) {
  if (!line) continue
  let ev; try { ev = JSON.parse(line) } catch { continue }
  if (ev.time != null) events.push(ev)
}
console.log('frames', starts.length, 'bytes', total, 'events', events.length)
const by10 = new Map(); const toolHist = new Map(); let retries = 0; const errs = []
for (const ev of events) {
  const d = new Date(ev.time + 8 * 3600 * 1000)
  const k = d.toISOString().slice(11, 16).slice(0, 4) + '0'
  by10.set(k, (by10.get(k) || 0) + 1)
  if (ev.type === 'tool/call') toolHist.set(ev.data?.name, (toolHist.get(ev.data?.name) || 0) + 1)
  if (ev.type === 'llm/retry') retries++
  if (ev.type === 'error' || ev.type === 'tool/error') errs.push(ev)
}
console.log('--- events per 10min ---'); for (const [k, v] of [...by10.entries()].sort()) console.log(' ', k, v)
console.log('--- tool calls ---'); for (const [k, v] of [...toolHist.entries()].sort((a, b) => b[1] - a[1])) console.log(' ', k, v)
console.log('llm/retry events:', retries, '| error events:', errs.length)
console.log('--- last 16 events ---')
for (const ev of events.slice(-16)) {
  const d = new Date(ev.time + 8 * 3600 * 1000)
  let info = ev.type
  if (ev.type === 'tool/call') info = 'TOOL ' + ev.data?.name + ' ' + (ev.data?.arguments || '').slice(0, 70).replace(/\n/g, ' ')
  else if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'finish') info = 'finish:' + ev.data.chunk.reason?.kind
  else if (ev.type === 'step/start') info = 'step ' + ev.data?.step
  else if (ev.type === 'error') info = 'ERROR ' + JSON.stringify(ev.data).slice(0, 220)
  else if (ev.type === 'llm/retry') info = 'llm/retry ' + JSON.stringify(ev.data).slice(0, 160)
  console.log(' ', d.toISOString().slice(11, 19), '|', info.slice(0, 140))
}
