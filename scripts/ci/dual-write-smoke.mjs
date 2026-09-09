// 双进程并发写冒烟：复现 P1-1 现场 audit.seq UNIQUE 撞号并验证修复。
// 起两个 server.mjs 实例（同 TEAM_HUB_DB 隔离库、不同端口），并发各 create N 个任务。
// 修复前：两进程内存 nextSeq 从同起点递增 → audit.seq 撞 → 部分 create 400。
// 修复后：audit 事务内 MAX+1 → 全部 200。
// 用法：node scratch/dual-write-smoke.mjs <server.mjs> [N]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = process.argv[2] ?? 'team-hub/server.mjs'
const N = Number(process.argv[3] ?? 15)
const dir = mkdtempSync(join(tmpdir(), 'dual-write-'))
const db = join(dir, 'dual.db')

const ports = [0, 0].map(() => 40000 + Math.floor(Math.random() * 20000))
function boot(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: db, TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/config`)
        if (r.ok) return resolve()
      } catch { /* not yet */ }
      if (Date.now() - t0 > 15000) return reject(new Error(`boot timeout: ${err.slice(-400)}`))
      setTimeout(tick, 150)
    }
    tick()
  })
  return { child, port, ready, get err() { return err } }
}

async function create(port, i, who) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `dual-${who}-${i}`, by: 'probe', scope: 'default' }),
    })
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok, status: r.status, id: body.task?.id, error: body.error }
  } catch (e) {
    return { ok: false, status: 0, error: String(e) }
  }
}

const a = boot(ports[0])
const b = boot(ports[1])
await a.ready
await b.ready
console.log(`双进程就绪: A=:${a.port} B=:${b.port} db=${db}`)

// 并发交叉写：A 与 B 同时各建 N 个（请求交错模拟双写者）
const t0 = Date.now()
const jobs = []
for (let i = 0; i < N; i++) {
  jobs.push(create(a.port, i, 'A'), create(b.port, i, 'B'))
}
const results = await Promise.all(jobs)
const fails = results.filter((r) => !r.ok)
const okIds = results.filter((r) => r.ok).map((r) => r.id)
const dupeIds = okIds.filter((id, idx) => okIds.indexOf(id) !== idx)
const audit = await fetch(`http://127.0.0.1:${a.port}/api/activity?limit=500&scope=default`).then((r) => r.json())
const auditSeq = audit.map((x) => x.seq)
const seqDup = auditSeq.filter((s, i) => auditSeq.indexOf(s) !== i)

console.log(`并发 create ${results.length} 个: ok=${results.length - fails.length} fail=${fails.length} 耗时=${Date.now() - t0}ms`)
if (fails.length) console.log('失败样本:', JSON.stringify(fails.slice(0, 3)))
console.log(`任务 id 去重: unique=${new Set(okIds).size}/${okIds.length}${dupeIds.length ? ' ⚠有重复 id!' : ' ✓'}`)
console.log(`audit seq 去重: unique=${new Set(auditSeq).size}/${auditSeq.length}${seqDup.length ? ' ⚠有重复 seq!' : ' ✓'}`)

for (const p of [a, b]) p.child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(dir, { recursive: true, force: true })
console.log(seqDup.length === 0 && dupeIds.length === 0 && fails.length === 0 ? 'PASS' : 'FAIL')
process.exit(seqDup.length === 0 && dupeIds.length === 0 && fails.length === 0 ? 0 : 1)
