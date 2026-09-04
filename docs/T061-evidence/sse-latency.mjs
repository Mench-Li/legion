#!/usr/bin/env node
/**
 * T-061 S1 证据：测量 TC-S1-14 的 SSE 推送延迟（≤5s 验收）。
 * 起真实 server.mjs（随机端口+临时库），订阅 /api/events，等待连接内回放(近30条历史)刷完，
 * 记录 POST 发出到收到 live chat:message（member=by）的事件 TTFB。
 * 只依赖 node: 内置模块，零第三方依赖。
 */
import { spawn } from 'node:child_process'
import * as httpMod from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-sse-lat-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let child, base, dbFile
for (let attempt = 0; attempt < 6 && !child; attempt += 1) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  dbFile = join(tmpRoot, 'lat-' + port + '.db')
  const c = spawn(process.execPath, ['team-hub/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' },
    stdio: 'ignore',
  })
  base = 'http://127.0.0.1:' + port
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(base + '/api/config')
      if (r.ok && (await r.json()).db === dbFile) { child = c; break }
    } catch { /* 未就绪 */ }
    await sleep(100)
  }
  if (!child) c.kill()
}
if (!child) { console.log('FATAL: server 未就绪'); process.exit(2) }

const post = (p, body) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const conv = (await (await post('/api/chat/conversations', { scope: 'software', title: 'latency', kind: 'space', by: 'general' })).json()).task.id

const req = httpMod.get(base + '/api/events', (res) => {
  let buf = ''
  res.on('data', (d) => {
    buf += d.toString()
    const frames = buf.split('\n\n')
    buf = frames.pop()
    for (const f of frames) {
      const m = /^data: (.+)$/m.exec(f)
      if (m) { try { const ev = JSON.parse(m[1]); if (ev && ev.action) seen.push(ev) } catch { /* 忽略 */ } }
    }
  })
})
req.on('error', () => {})
await sleep(500)

let maxMs = 0, minMs = Infinity, sumMs = 0, n = 0
for (let i = 0; i < 3; i += 1) {
  const t0 = process.hrtime.bigint()
  const evP = new Promise((resolve) => {
    const r = httpMod.get(base + '/api/events', (res) => {
      let b = ''
      res.on('data', (d) => {
        b += d.toString()
        const fr = b.split('\n\n')
        b = fr.pop()
        for (const f of fr) {
          const m = /^data: (.+)$/m.exec(f)
          if (!m) continue
          try {
            const ev = JSON.parse(m[1])
            if (ev.action === 'chat:message' && ev.member === 'metric') { r.destroy(); resolve(ev); return }
          } catch { /* 忽略 */ }
        }
      })
    })
    r.on('error', () => resolve(null))
    setTimeout(() => { try { r.destroy() } catch { /* 已关闭 */ }; resolve(null) }, 6000)
  })
  await sleep(200)
  const body = 'lat-' + i + '-' + Date.now()
  const pr = await post('/api/chat/messages', { conv, kind: 'text', body, by: 'metric' })
  const ev = await evP
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  if (ev && pr.status === 200) {
    maxMs = Math.max(maxMs, ms); minMs = Math.min(minMs, ms); sumMs += ms; n += 1
    console.log('live event received in ' + ms.toFixed(1) + ' ms | member=' + ev.member + ' scope=' + ev.scope + ' action=' + ev.action)
  } else {
    console.log('NO live event within 6s (status ' + pr.status + ')')
  }
}

child.kill()
await sleep(300)
try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* 忽略 */ }
console.log('\n==== SSE live chat:message 推送延迟（' + n + ' 次）====')
console.log('min=' + (isFinite(minMs) ? minMs.toFixed(1) : 'n/a') + 'ms, max=' + (isFinite(maxMs) ? maxMs.toFixed(1) : 'n/a') + 'ms, avg=' + (isFinite(sumMs) && n ? (sumMs / n).toFixed(1) : 'n/a') + 'ms  —— 验收 ≤5000ms')
process.exit(n > 0 ? 0 : 1)
