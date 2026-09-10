// scripts/ci/dual-write-smoke.test.mjs — 双进程写同库竞态回归（P1-1 第 2 步现场根因固化）。
//
// 背景：team-hub v2 的 audit.seq 曾用进程内内存计数器（启动读一次 MAX(seq) 后 ++）。生产上
// 8787 独立进程与 3080 宿主 v2 外壳双进程写同一 team.db，各自从同起点递增 → 撞
// UNIQUE constraint failed: audit.seq（现场 /api/create 400 实证）。
// 修复后 audit() 在写事务内读库 MAX+1 分配。本用例固化为回归：
// 起两个 server.mjs 实例指向同一隔离库，并发各建 N 个任务，要求全部成功且 id/seq 唯一。
//
// 运行：node --test scripts/ci/dual-write-smoke.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'team-hub', 'server.mjs')
const N = Number(process.env.DUAL_WRITE_N ?? 12)

function boot(port, db) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: db, TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/config`)
        .then((r) => { if (r.ok) resolve() })
        .catch(() => {})
        .finally(() => {
          if (Date.now() - t0 > 15000) reject(new Error(`boot timeout: ${err.slice(-300)}`))
          else setTimeout(tick, 150)
        })
    }
    tick()
  })
  return { child, port, ready }
}

async function createTask(port, i, who) {
  const res = await fetch(`http://127.0.0.1:${port}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `dual-${who}-${i}`, by: 'ci', scope: 'default' }),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, id: body.task?.id, error: body.error }
}

test('双进程并发写同一 team.db：create 全成功且 audit seq / task id 全唯一（P1-1 audit.seq 回归）', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dual-write-'))
  const db = join(dir, 'dual.db')
  const base = 42000 + Math.floor(Math.random() * 15000)
  const a = boot(base, db)
  const b = boot(base + 1, db)
  try {
    await Promise.all([a.ready, b.ready])
    const jobs = []
    for (let i = 0; i < N; i++) {
      jobs.push(createTask(a.port, i, 'A'), createTask(b.port, i, 'B'))
    }
    const results = await Promise.all(jobs)
    const fails = results.filter((r) => !r.ok)
    assert.equal(fails.length, 0, `双进程并发 create 应全部成功；失败样本=${JSON.stringify(fails.slice(0, 3))}`)

    const ids = results.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, `任务 id 应唯一；重复=${ids.length - new Set(ids).size}`)

    const audit = await fetch(`http://127.0.0.1:${a.port}/api/activity?limit=500&scope=default`).then((r) => r.json())
    const seqs = audit.map((x) => x.seq)
    assert.equal(new Set(seqs).size, seqs.length, `audit seq 应唯一（撞号即回归）；重复=${seqs.length - new Set(seqs).size}`)
    assert.ok(seqs.length >= results.length, `audit 应记录全部 create；seq=${seqs.length} < ${results.length}`)
  } finally {
    for (const p of [a, b]) { try { p.child.kill() } catch { /* ignore */ } }
    await new Promise((r) => setTimeout(r, 300))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单进程连续写：audit seq 单调递增无重复（回归基线）', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-write-'))
  const db = join(dir, 'single.db')
  const port = 58000 + Math.floor(Math.random() * 5000)
  const a = boot(port, db)
  try {
    await a.ready
    for (let i = 0; i < 5; i++) await createTask(a.port, i, 'S')
    const audit = await fetch(`http://127.0.0.1:${a.port}/api/activity?limit=100&scope=default`).then((r) => r.json())
    const seqs = audit.map((x) => x.seq).sort((x, y) => x - y)
    assert.equal(new Set(seqs).size, seqs.length, '单进程也不得有重复 seq')
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `seq 应严格递增：${seqs[i - 1]} → ${seqs[i]}`)
    }
  } finally {
    try { a.child.kill() } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300))
    rmSync(dir, { recursive: true, force: true })
  }
})
