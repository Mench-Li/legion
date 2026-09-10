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
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = join(ROOT, 'team-hub', 'server.mjs')
const N = Number(process.env.DUAL_WRITE_N ?? 12)

/** 由 OS 分配的空闲端口（立即释放，竞争窗口极小）。
 *  不用「42000 + 随机」是因为 Windows 的临时端口区（默认 49152 起）与之重叠：
 *  若该端口被别的进程（其他 agent 的 CI、本机服务）占用，boot 会失败成「就绪超时」，
 *  与真正的并发缺陷混在同一个失败签名里——本切片排查时这正是需要排除的干扰项之一。 */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

function boot(port, db) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: db, TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // logs 对外暴露（迁移竞态用例要断言 stderr 里没有 duplicate column；诊断也依赖它）
  const logs = { err: '' }
  child.stderr.on('data', (d) => { logs.err += d })
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/config`)
        .then((r) => { if (r.ok) { resolve(); return } })
        .catch(() => {})
        .finally(() => {
          if (child.exitCode !== null) { reject(new Error(`serve 进程提前退出 exit=${child.exitCode}：${logs.err.slice(-400)}`)); return }
          if (Date.now() - t0 > 15000) reject(new Error(`boot timeout: ${logs.err.slice(-300)}`))
          else setTimeout(tick, 150)
        })
    }
    tick()
  })
  // ready 若无人 await（进程提前退出路径）不应变成未处理拒绝
  ready.catch(() => {})
  return { child, port, ready, logs }
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
  const base = await freePort()
  const base2 = await freePort()
  const a = boot(base, db)
  const b = boot(base2, db)
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
  const port = await freePort()
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

// ── 迁移竞态回归（2026-09-10 实测定性）────────────────────────────────────────
//
// 背景：本套件此前有一次「1 个用例失败」的偶发记录，失败原文已丢失（当时 run-ci 只留 6 行摘要）。
// 用同款双进程场景做探针复现，**第 1 次就稳定复现**了另一个真实缺陷——不是 audit.seq，而是
// **启动期迁移**：两个进程同时打开同一个新库时，都会读到「成员表没有 model 列」并各自执行
// ALTER TABLE members ADD COLUMN model，后到者拿到 `SQLite error: duplicate column name: model`
// 并在模块加载期崩溃退出（探针捕获的 stderr 原文见 docs/DUAL-WRITE-RACE-evidence/verify-evidence.md）。
// 宿主形态下这表现为 /team-hub 路由缺失并打一条加载失败日志（外壳有 .catch，不会带走宿主进程）。
//
// 修法：启动期迁移统一走 ensureColumn —— 在 BEGIN IMMEDIATE 内**重读**列名再决定是否 ALTER，
// 把「检查 + 变更」变成跨进程原子操作（25 处调用点一次修好）；破坏性的 goal 重建同样入事务。
// 下面两个用例是这次修复的回归锚点。
test('双进程**同时**启动迁移同一新库：双方都就绪且无 duplicate column（迁移竞态回归）', { timeout: 60000 }, async () => {
  const ROUNDS = 3
  for (let round = 1; round <= ROUNDS; round++) {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-race-'))
    const db = join(dir, 'race.db')
    const pA = await freePort()
    const pB = await freePort()
    // 关键：两次 spawn 紧挨着发出（不 await 前者的 ready），最大化「同时在迁移」的窗口。
    const a = boot(pA, db)
    const b = boot(pB, db)
    try {
      await Promise.all([a.ready, b.ready])
      for (const [tag, s] of [['A', a], ['B', b]]) {
        assert.ok(!/duplicate column/i.test(s.logs.err), `第 ${round} 轮 ${tag} 进程 stderr 出现 duplicate column：${s.logs.err.slice(-300)}`)
      }
      // 两进程都必须能真正读写（迁移若半途而废，这里会失败）
      const r1 = await createTask(a.port, round, 'MA')
      const r2 = await createTask(b.port, round, 'MB')
      assert.ok(r1.ok && r2.ok, `第 ${round} 轮两进程写库都应成功：${JSON.stringify([r1, r2])}`)
    } finally {
      for (const p of [a, b]) { try { p.child.kill() } catch { /* ignore */ } }
      await new Promise((r) => setTimeout(r, 300))
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
    }
  }
})

test('双进程启同时升级**旧形状** goal 表：只迁移一次且旧目标不丢（破坏性迁移入事务回归）', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-goal-'))
  const db = join(dir, 'legacy.db')
  // 造一个「旧形状」库：goal 表 scope 主键、无 id/status/version 三列（迁移会 DROP + 重建 + 逐行搬迁）
  const seed = new DatabaseSync(db)
  seed.exec('CREATE TABLE goal (scope TEXT PRIMARY KEY, objective TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)')
  seed.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
    .run('legacy-scope', '遗留目标（迁移前就存在）', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  seed.close()

  const pA = await freePort()
  const pB = await freePort()
  const a = boot(pA, db)
  const b = boot(pB, db)
  try {
    await Promise.all([a.ready, b.ready])
    const check = new DatabaseSync(db)
    const rows = check.prepare('SELECT id, scope, objective, status FROM goal').all()
    check.close()
    assert.equal(rows.length, 1, `旧目标应恰好升级为 1 条记录（重复迁移/丢数据都会破坏此断言）；实际=${JSON.stringify(rows)}`)
    assert.equal(rows[0].id, 'G-001')
    assert.equal(rows[0].scope, 'legacy-scope')
    assert.match(rows[0].objective, /遗留目标/)
    assert.equal(rows[0].status, 'active')
  } finally {
    for (const p of [a, b]) { try { p.child.kill() } catch { /* ignore */ } }
    await new Promise((r) => setTimeout(r, 300))
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  }
})
