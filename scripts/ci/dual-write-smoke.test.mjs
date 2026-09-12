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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// 第 3 个锚点：把「启动期补列的写法」本身钉住（**类**级不变量，不是某一个调用点）
//
// 上面两个用例守的是「两个进程同时启动、迁移同一新库」的行为。它们能抓住当前
// **已知**的坏写法，但抓不住"下次有人在新文件里又照抄一遍"——本仓库已经发生过两次：
//
//   · 2026-09-10：`server.mjs` 启动期 25 处「读一次 PRAGMA 再 ALTER」→
//     后到者 `duplicate column name: model`，模块加载期崩溃。修法：统一走 `ensureColumn`。
//   · 2026-09-12（PRT-607 期间发现）：`team-hub/approval-binding.mjs` 的
//     `ensureApprovalSchema` 把那两行**照抄**了过去（它是 9-10 之后新抽出来的文件）
//     → 后到者 `duplicate column name: bindingHash`。同一个缺陷，第 26 处。
//
//   > 一个「修好了当时那 25 处」的修复，
//   > 与一个「第 26 处是后来新写的、于是坏在同一个地方」的修复，是同一个东西——
//   > 只不过后者在代码审查里看起来是幂等的。
//
// 所以这一条直接查源码，把**两种坏形状**都禁掉：
//
//   ① 自己 `db.exec('ALTER TABLE …')` —— 检查与变更之间有窗口，不是原子的；
//   ② `try { ALTER } catch {}` —— 不崩，但把「加列失败」（磁盘满 / 表被锁 / 库只读 /
//      SQL 写错）吞成「列已存在」，于是列真的没加上时一声不响，
//      直到几周后某个不相干的查询报 `no such column`。
//
// 唯一允许出现 ALTER 的地方是 `schema-util.mjs` 的 `ensureColumn` 内部
// （`BEGIN IMMEDIATE` 内重读，且只在重读确认列已存在时才吞异常）。
// ---------------------------------------------------------------------------
test('③ 源码不变量：启动期补列一律走 ensureColumn，不许自己写 ALTER', () => {
  const PRODUCTION_DIRS = [join(ROOT, 'team-hub'), join(ROOT, 'orchestrator'), join(ROOT, 'runtime')]
  // 允许自己写 ALTER 的白名单：并发原语**唯一**的实现处
  const ALLOWED = new Set([join(ROOT, 'team-hub', 'schema-util.mjs')])

  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) files.push(p)
    }
  }
  for (const d of PRODUCTION_DIRS) walk(d)

  // 扫描面自检：不能只断言"文件数够多"（数量对不上时说不清是 walk 坏了还是仓库小了）。
  // 直接断言几个**必须被扫到**的文件在里面——它们正是本次缺陷的现场与判据。
  //
  //   > 一个「数了数有 90 个文件」的自检，
  //   > 与一个「确认那两个真正会跑迁移的文件在扫描面里」的自检，是同一个东西吗？不是。
  for (const must of ['team-hub/server.mjs', 'team-hub/approval-binding.mjs', 'team-hub/run-store.mjs']) {
    assert.ok(files.includes(join(ROOT, must)), `扫描面必须包含 ${must}`)
  }
  assert.ok(files.length > 50, `扫描面应当足够大（实际 ${files.length} 个生产 .mjs）`)

  const bare = []
  const swallowed = []
  for (const p of files) {
    if (ALLOWED.has(p)) continue
    const src = readFileSync(p, 'utf8')
    const lines = src.split(/\r?\n/)
    let inBlockComment = false
    lines.forEach((line, i) => {
      // 注释里提到 ALTER 是允许的（本文件与 schema-util 的解释性注释都要提到它），
      // 所以先剥掉行注释与块注释再判断。
      let code = line
      if (inBlockComment) {
        const end = code.indexOf('*/')
        if (end === -1) return
        code = code.slice(end + 2)
        inBlockComment = false
      }
      code = code.replace(/\/\*[\s\S]*?\*\//g, '')
      const open = code.indexOf('/*')
      if (open !== -1) { code = code.slice(0, open); inBlockComment = true }
      code = code.replace(/\/\/.*$/, '')
      if (!/ALTER\s+TABLE/i.test(code)) return

      const rel = p.slice(ROOT.length + 1)
      // ① 自己 exec 出去的 ALTER
      if (/\.exec\s*\(/.test(code)) bare.push(`${rel}:${i + 1}: ${line.trim()}`)
      // ② 同一条 ALTER 出现在 try/catch 的 try 分支里（吞异常）
      const window = lines.slice(i, Math.min(i + 4, lines.length)).join('\n')
      if (/catch\s*(\{|\()/.test(window)) swallowed.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }

  // ★ 两个分支**一起**报，不写成两条 assert。
  //
  //   一条 `assert.deepEqual(bare, [])` 先跑、失败即中止时，`swallowed` 那条
  //   在这一次运行里**从来没被执行过**——于是"两个分支都验证过"这句话里，
  //   有一个分支的证据其实是空的。破坏性验证时正是这样：故意注入的坏形状
  //   同时命中两个分支，而只有第一个被报出来。
  //
  //   > 一个「排在后面、于是从没被跑到」的断言，
  //   > 与一条不存在的断言，在"它到底拦住了什么"上是同一个东西。
  const violations = [
    ...bare.map((v) => `[自己 exec ALTER] ${v}`),
    ...swallowed.map((v) => `[try/catch 吞掉 ALTER] ${v}`),
  ]
  assert.deepEqual(
    violations, [],
    '启动期补列一律走 ensureColumn（schema-util.mjs 的 `BEGIN IMMEDIATE` 内重读），不许自己写 ALTER：\n' +
    '  · 自己 `db.exec(\'ALTER TABLE …\')`：检查与变更之间有窗口，两个进程同时启动时后到者 ' +
    '`duplicate column name` 崩溃（模块加载期，表现为路由整体缺失）；\n' +
    '  · `try { ALTER } catch {}`：不崩，但把「磁盘满 / 表被锁 / 库只读 / SQL 写错」与「列已存在」' +
    '吞成同一个结果，列真的没加上时一声不响。\n' +
    violations.join('\n'),
  )
})
