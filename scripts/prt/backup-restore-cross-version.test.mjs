// scripts/prt/backup-restore-cross-version.test.mjs
// ============================================================================
// PRT-006 跨版本恢复验证（spec 附录 A.4「其它已记录缺口」里那条
// 「`PRT-006` 跨版本恢复 — 顺延至 `PRT-316` 之后」）
//
// ## 为什么需要它
//
// `docs/DEPLOY.md` 的回滚表写着一条**声明**：
//
//   > 表结构只增不改：新代码在老库自动建表/补列（幂等），回滚旧代码时新表闲置互不破坏。
//
// 这条声明此前**没有任何实验支撑**——`docs/PRT-006-evidence/backup-restore-evidence.md` §5
// 自己写着「**未验证跨版本恢复**（老代码读新库、新代码读老库）…本次未对该声明做实验」。
//
//   > 一个"回滚安全"的声明，与一个"没人试过回滚"的声明，
//   > 在读者眼里是同一个东西——只不过前者的文档里写着它被保证过。
//
// 于是本文件把那条声明拆成**两个方向**，各自给出可复跑的读数。
//
// ## 两个方向，各自怕什么
//
//   · **新代码读老库**（前滚）：老库缺新表/新列。怕的是**迁移本身**
//     把老数据弄坏或弄丢——尤其是这里**唯一一处破坏性迁移**（`goal` 表重建）。
//   · **老代码读新库**（回滚）：新库有老代码不认识的表与列。老代码的 INSERT
//     是**列名封闭**的，所以只要 ① 它写过的列还在、② 那些列**可空或有默认值**，
//     它就写得进去。`DROP`/`RENAME` 一个老代码用着的列才会真的弄坏它。
//
// ## 夹具取自**真实历史**，不是编的
//
// 老库形状不是"我少建几张表"，而是**从 git 历史里逐字取出来的**：
// 本仓 `team-hub/server.mjs` 的最早一版（`f53404e`，2026-08-25）只有三张表，
// 而今天有 50 张。夹具里的 DDL 与 INSERT 列名都抄自那一版，
// 所以这份验证测的是**这个仓库真的发生过的那段版本跨度**。
//
// ## 一个还没解决的缺口（如实记下，不在本文件里假装覆盖）
//
// "老代码读新库"这一向**没有真的去跑那一版 `server.mjs`**。原因有二：
//   ① 那一版没有 `isMain` 守卫，import 会**直接监听端口**（`createServer(...).listen(...)`）；
//   ② 它 import 时的 `ROOT = <server.mjs 所在目录>/..`，从临时目录复制出来跑会算错根目录。
// 本文件的处置是：把那一向**降级成结构性断言**（老代码写过的列还在、且可空或有默认值），
// 并**如实标注**这不是"真的跑了一遍老代码"。这一条写在这里，免得下一个人把
// 绿色的本套件读成"回滚已经端到端验过了"。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 老库形状的出处。
 *
 * 用 `git log --reverse` 找出 `team-hub/server.mjs` 的第一版，再把它的
 * `CREATE TABLE` 与 `INSERT` 原文抄下来。**钉住这个哈希**，这样夹具不会
 * 随着别人重写历史而悄悄变样；哈希不存在时本套件**红**，而不是静默跳过。
 */
const OLD_SERVER_COMMIT = 'f53404e'

/** 老版 `server.mjs` 的三张表（逐字抄自 `OLD_SERVER_COMMIT`）。 */
const OLD_DDL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    acceptance TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'backlog',
    version INTEGER NOT NULL DEFAULT 1,
    soldier TEXT,
    claimedRound INTEGER,
    claimedAt TEXT,
    ordersVersion INTEGER DEFAULT 1,
    parent TEXT,
    role TEXT,
    scope TEXT DEFAULT 'default',
    blocks TEXT DEFAULT '[]',
    blockedBy TEXT DEFAULT '[]',
    comments TEXT DEFAULT '[]',
    evidence TEXT DEFAULT '[]',
    patches TEXT DEFAULT '[]',
    createdAt TEXT,
    updatedAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    scope TEXT DEFAULT 'default',
    kind TEXT DEFAULT 'unknown',
    lastSeenAt TEXT,
    online INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    member TEXT,
    scope TEXT,
    action TEXT,
    taskId TEXT,
    detail TEXT
  )`,
]

/**
 * 老版 `server.mjs` **写过的**列清单（逐字抄自那三个 `INSERT`）。
 *
 * 这是"老代码读新库"那一向的全部依据：老代码的 INSERT 是列名封闭的，
 * 它只会碰这些列。原句形如
 *   `INSERT INTO tasks (id, title, … , createdAt, updatedAt) VALUES (…)`
 */
const OLD_INSERT_COLUMNS = Object.freeze({
  tasks: Object.freeze([
    'id', 'title', 'description', 'acceptance', 'priority', 'status', 'version',
    'soldier', 'claimedRound', 'claimedAt', 'ordersVersion', 'parent', 'role', 'scope',
    'blocks', 'blockedBy', 'comments', 'evidence', 'patches', 'createdAt', 'updatedAt',
  ]),
  members: Object.freeze(['id', 'scope', 'kind', 'lastSeenAt', 'online']),
  audit: Object.freeze(['seq', 'ts', 'member', 'scope', 'action', 'taskId', 'detail']),
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-xver-'))
let seq = 0
/** 每次 import 换一个查询串 bust 模块缓存（与 `chat.test.mjs` 的旧库迁移用例同法）。 */
async function importFreshServer(dbFile) {
  process.env.TEAM_HUB_DB = dbFile
  seq += 1
  return import(`../../team-hub/server.mjs?xver=${seq}-${Date.now()}`)
}

/** 建一个"老版本形状"的库，并按老代码的列清单写进行。 */
function buildOldDb(file) {
  const db = new DatabaseSync(file)
  for (const ddl of OLD_DDL) db.exec(ddl)
  // 老版 `server.mjs` 的 tasks INSERT：21 列，其中 version/blocks/blockedBy/comments/
  // evidence/patches 在那条语句里是**字面量**。这里按列顺序给 21 个值。
  const insTask = db.prepare(`INSERT INTO tasks (${OLD_INSERT_COLUMNS.tasks.join(', ')}) VALUES (${OLD_INSERT_COLUMNS.tasks.map(() => '?').join(', ')})`)
  insTask.run('T-OLD-1', '存量任务一', '老库里的任务', '[]', 'high', 'backlog', 1, null, null, null, 1, null, 'dev', 'software', '[]', '[]', '[]', '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
  insTask.run('T-OLD-2', '存量任务二', '', '[]', 'medium', 'done', 1, null, null, null, 1, null, 'reviewer', 'software', '[]', '[]', '[]', '[]', '[]', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z')
  db.prepare(`INSERT INTO members (${OLD_INSERT_COLUMNS.members.join(', ')}) VALUES (?, ?, ?, ?, 1)`)
    .run('coder-old', 'software', 'agent', '2026-01-05T00:00:00.000Z')
  const insAudit = db.prepare(`INSERT INTO audit (${OLD_INSERT_COLUMNS.audit.join(', ')}) VALUES (${OLD_INSERT_COLUMNS.audit.map(() => '?').join(', ')})`)
  insAudit.run(1, '2026-01-01T00:00:00.000Z', 'general', 'software', 'task:create', 'T-OLD-1', '{}')
  insAudit.run(2, '2026-01-02T00:00:00.000Z', 'general', 'software', 'task:update', 'T-OLD-2', '{}')
  db.close()
}

/** 老版 `goal` 表的形状（`scope` 主键、单目标 upsert、无 id/status/version）。 */
function buildLegacyGoalDb(file) {
  const db = new DatabaseSync(file)
  db.exec(OLD_DDL[0]) // tasks：让 goal 重建那一段之外的启动路径有东西可用
  db.exec(`CREATE TABLE goal (
    scope TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    createdAt TEXT,
    updatedAt TEXT
  )`)
  db.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
    .run('software', '老库里的单目标', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  db.prepare('INSERT INTO goal (scope, objective, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
    .run('ops', '第二个老目标', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
  db.close()
}

after(() => { rmSync(tmpRoot, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// ⓪ 夹具出处必须真的存在（否则下面全绿也没有意义）
// ---------------------------------------------------------------------------

describe('PRT-006 跨版本：夹具出处', () => {
  it('⓪ 钉住的那个提交存在，且它的 server.mjs 确实只有三张表', () => {
    const src = execFileSync('git', ['show', `${OLD_SERVER_COMMIT}:team-hub/server.mjs`], { cwd: ROOT, encoding: 'utf8' })
    const tables = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort()
    assert.deepEqual(tables, ['audit', 'members', 'tasks'],
      `夹具声称老版只有三张表；实际读到 ${JSON.stringify(tables)}。` +
      '夹具过期时这里必须红——一份"我认为老库长这样"的夹具，' +
      '与一份"从历史里取出来的"夹具，在用例上长得一样。')
    assert.equal((src.match(/ensureColumn\(/g) ?? []).length, 0, '那一版还没有 ensureColumn（补列机制本身就是"只增不改"的产物）')
  })

  it('⓪ 夹具里的 INSERT 列清单与那一版源码逐字一致', () => {
    const src = execFileSync('git', ['show', `${OLD_SERVER_COMMIT}:team-hub/server.mjs`], { cwd: ROOT, encoding: 'utf8' })
    for (const [table, cols] of Object.entries(OLD_INSERT_COLUMNS)) {
      const m = src.match(new RegExp(`INSERT INTO ${table} \\(([^)]*)\\)`, 'i'))
      assert.ok(m, `那一版应有对 ${table} 的 INSERT`)
      const actual = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)
      assert.deepEqual(actual, [...cols],
        `${table} 的列清单与历史不一致——夹具漂了，这一向的结论跟着失效`)
    }
  })
})

// ---------------------------------------------------------------------------
// ① 前滚：新代码读老库（含唯一一处破坏性迁移）
// ---------------------------------------------------------------------------

describe('PRT-006 跨版本：新代码读老库（前滚）', () => {
  let mod
  let dbFile

  before(async () => {
    dbFile = join(tmpRoot, 'old-to-new.db')
    buildOldDb(dbFile)
    mod = await importFreshServer(dbFile)
  })

  after(() => { try { mod?.db?.close() } catch { /* 已关闭 */ } })

  it('① 老数据一行不丢（三张老表逐行对拍）', () => {
    const tasks = mod.db.prepare('SELECT id, title, status, role, scope FROM tasks ORDER BY id').all()
    assert.deepEqual(tasks.map((t) => ({ ...t })), [
      { id: 'T-OLD-1', title: '存量任务一', status: 'backlog', role: 'dev', scope: 'software' },
      { id: 'T-OLD-2', title: '存量任务二', status: 'done', role: 'reviewer', scope: 'software' },
    ])
    const members = mod.db.prepare('SELECT id, scope, kind FROM members ORDER BY id').all()
    assert.deepEqual(members.map((m) => ({ ...m })), [{ id: 'coder-old', scope: 'software', kind: 'agent' }])
    const audit = mod.db.prepare('SELECT seq, action, taskId FROM audit ORDER BY seq').all()
    assert.deepEqual(audit.map((a) => ({ ...a })), [
      { seq: 1, action: 'task:create', taskId: 'T-OLD-1' },
      { seq: 2, action: 'task:update', taskId: 'T-OLD-2' },
    ])
  })

  it('① 新表被建出来，且新列被补上（"只增不改"的前半句）', () => {
    const tables = new Set(mod.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name))
    for (const t of ['goal', 'spaces', 'conversations', 'messages', 'calendar_events', 'documents', 'run_attempts']) {
      assert.ok(tables.has(t), `新库应有 ${t}`)
    }
    // 老表上的新列（老库没有 boundary/hold/artifacts/…）
    const taskCols = new Set(mod.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name))
    for (const c of ['boundary', 'hold', 'artifacts', 'slice', 'ttlMinutes']) {
      assert.ok(taskCols.has(c), `tasks 应补上 ${c}`)
    }
  })

  it('① 补上来的每一列都**可空或有默认值**（否则老代码的 INSERT 会当场违约）', () => {
    // 只核"老代码写过的那三张表"上的**新增**列：老代码自己的列本来就有值。
    for (const table of Object.keys(OLD_INSERT_COLUMNS)) {
      const known = new Set(OLD_INSERT_COLUMNS[table])
      for (const c of mod.db.prepare(`PRAGMA table_info(${table})`).all()) {
        if (known.has(c.name)) continue
        const hasDefault = c.dflt_value !== null && c.dflt_value !== undefined
        assert.ok(c.notnull !== 1 || hasDefault,
          `${table}.${c.name} 是 NOT NULL 且没有 DEFAULT——回滚到老代码之后，` +
          '它的 INSERT 不会写这一列，于是**每一次写入都会失败**。' +
          '这正是"表结构只增不改"这句声明里唯一会静默反噬的一种新列。')
      }
    }
  })

  it('① 新代码在迁移后的老库上**写得进去**（迁移不是只读的假绿）', () => {
    const created = mod.createTask({ title: '迁移之后新建', scope: 'software', role: 'dev', by: 'general' })
    assert.ok(created && created.id, '新代码应当能在老库上建任务')
    const again = mod.db.prepare('SELECT title FROM tasks WHERE id = ?').get(created.id)
    assert.equal(again.title, '迁移之后新建')
  })

  it('① ★★★ 唯一一处破坏性迁移（goal 重建）保住行数并升级形状', async () => {
    const f = join(tmpRoot, 'legacy-goal.db')
    buildLegacyGoalDb(f)
    const m = await importFreshServer(f)
    try {
      const cols = m.db.prepare('PRAGMA table_info(goal)').all().map((c) => c.name)
      assert.ok(cols.includes('id') && cols.includes('status') && cols.includes('version'),
        `goal 应当被重建为多目标形状，实际列：${JSON.stringify(cols)}`)
      const rows = m.db.prepare('SELECT id, scope, objective, status FROM goal ORDER BY id').all()
      assert.equal(rows.length, 2, '两条老目标都必须还在——DROP TABLE 那一手不许丢行')
      assert.deepEqual(rows.map((r) => ({ scope: r.scope, objective: r.objective, status: r.status })),
        [{ scope: 'software', objective: '老库里的单目标', status: 'active' },
         { scope: 'ops', objective: '第二个老目标', status: 'active' }])
      for (const r of rows) assert.match(r.id, /^G-\d{3}$/, '搬到新形状后应当有 id（G-001…）')
    } finally {
      try { m.db.close() } catch { /* 已关闭 */ }
    }
  })

  it('① ★★ 重建是**幂等**的：已经是新形状的库再跑一次不重建、不丢行', async () => {
    const f = join(tmpRoot, 'goal-again.db')
    buildLegacyGoalDb(f)
    const first = await importFreshServer(f)
    const after1 = first.db.prepare('SELECT id, objective FROM goal ORDER BY id').all().map((r) => ({ ...r }))
    // ★ 放一行**只有新代码会写**的 id（重建会把它重新编号成 G-00N）。
    //   不加这一行的话，这条用例是**空的**：一次"每次都重建"的实现会把两行老目标
    //   按同样的顺序重新编号成同样的 G-001/G-002，于是 `after2 === after1` 照样成立。
    //   *一个"行还在"的断言，与一个"这一行还是它自己"的断言，
    //   在重建会**重新编号**的时候是同一个东西——只不过前者看不见那次重建。*
    first.db.prepare("INSERT INTO goal (id, scope, objective, status, version, mode, createdAt, updatedAt) VALUES ('G-999', 'software', '二次打开前写入', 'active', 1, 'chain', ?, ?)")
      .run('2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')
    first.db.close()

    // 第二次打开同一个（已是新形状的）库
    const second = await importFreshServer(f)
    try {
      const after2 = second.db.prepare('SELECT id, objective FROM goal ORDER BY id').all().map((r) => ({ ...r }))
      const marker = after2.find((r) => r.objective === '二次打开前写入')
      assert.ok(marker, '那一行必须还在（丢了说明第二次打开把它 DROP 掉了）')
      assert.equal(marker.id, 'G-999',
        '那一行的 id 变了 ⇒ 第二次打开**重建**了 goal 表。`needsRebuild` 必须看到 id 列就跳过：' +
        '*一个每次启动都重建一次的表，与一个"迁移是幂等的"的表，在行数上常常是同一个东西。*')
      assert.deepEqual(after2.filter((r) => r.id !== 'G-999'), after1,
        '两次打开的老目标集合必须逐字相同')
    } finally {
      try { second.db.close() } catch { /* 已关闭 */ }
    }
  })
})

// ---------------------------------------------------------------------------
// ② 回滚：老代码读新库 —— **结构性断言，不是真的跑了那一版**（见文件头那段）
// ---------------------------------------------------------------------------

describe('PRT-006 跨版本：老代码读新库（回滚）', () => {
  let mod
  before(async () => { mod = await importFreshServer(join(tmpRoot, 'fresh-new.db')) })
  after(() => { try { mod?.db?.close() } catch { /* 已关闭 */ } })

  it('② 老代码写过的**每一列**今天都还在（DROP/RENAME 会在这里红）', () => {
    const missing = []
    for (const [table, cols] of Object.entries(OLD_INSERT_COLUMNS)) {
      const have = new Set(mod.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
      for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`)
    }
    assert.deepEqual(missing, [],
      '有新版本删掉/改名了老代码用着的列——回滚之后老代码会在那一次写入上失败。' +
      'DEPLOY.md §6 的回滚表宣称"表结构只增不改"，这里就是那句话的判据。')
  })

  it('② ★★★ 把老代码那三条 INSERT **真的跑一遍**（这才是"回滚后还能写"的判据）', () => {
    // 这是本套件里唯一一条**执行**老 SQL 的判据。
    //
    // 一开始我把它写成"检查老代码用到的列是可空或有默认值"——而那个判据**把对的说成错的**：
    // `tasks.title` 是 `NOT NULL` 且无默认值，可老代码的 INSERT **显式写**了它，
    // 所以它既不该被报，也不影响回滚。
    //
    //   > 一个"检查那些列可不可空"的判据，与一个"检查老语句能不能过"的判据，
    //   > 在列被显式写入时是同一个东西——只不过前者会**误报**，而误报会教人把判据删掉。
    //
    // 正确做法是直接跑那条语句：`NOT NULL` 的列只要老代码写了就没事；
    // 而**新加的** NOT NULL 无默认列会让它当场违约——那正是要抓的。
    const src = execFileSync('git', ['show', `${OLD_SERVER_COMMIT}:team-hub/server.mjs`], { cwd: ROOT, encoding: 'utf8' })

    // 逐字从那一版源码里抠出三条 INSERT 的 SQL 形状（列清单 + 字面量行）。
    // 这里不重写它们：重写一份就等于在测"我以为老代码写了什么"。
    const taskIns = src.match(/INSERT INTO tasks \(([\s\S]*?)\)\s*\n?\s*VALUES \(([^)]*)\)/)
    assert.ok(taskIns, '应当能从历史源码里抠出 tasks 的 INSERT')

    const inserts = [
      ['tasks', taskIns[1], taskIns[2]],
      ...['members', 'audit'].map((t) => {
        const m = src.match(new RegExp(`INSERT INTO ${t} \\(([^)]*)\\)\\s*\\n?\\s*VALUES \\(([^)]*)\\)`, 'i'))
        assert.ok(m, `应当能从历史源码里抠出 ${t} 的 INSERT`)
        return [t, m[1], m[2]]
      }),
    ]

    let wrote = 0
    for (const [table, rawCols, rawVals] of inserts) {
      const cols = rawCols.split(',').map((s) => s.trim()).filter(Boolean)
      // 每个占位符给一个合法值；字面量（`1`/`NULL`/`'[]'`/`?`）原样保留。
      const vals = rawVals.split(',').map((s) => s.trim()).filter(Boolean)
      assert.equal(vals.length, cols.length,
        `${table}：历史 INSERT 的列数与值数应当相等（夹具抠错了就会在这里红）`)
      // ★ 参数要**按位置**收集，而且缺一条就报出来。
      //   第一版写的是 `.filter((v) => v !== null)`，于是任何一条没造出值的列
      //   都被**静默丢掉**，参数与占位符错位——报出来的却是"新版本动了老语句依赖的东西"，
      //   一句与真实原因（我的夹具少造了一个值）完全无关的话。
      //   *一个"参数不够就往下塞"的夹具，与一个"真的读出了跨版本缺陷"的夹具，
      //   在断言失败时是同一个东西——只不过前者的诊断指向产品。*
      const params = []
      cols.forEach((c, i) => {
        if (vals[i] !== '?') return
        const v = sampleValue(table, c, i)
        if (v === undefined) {
          assert.fail(`夹具没有为老 INSERT 的 ${table}.${c} 造值——请补上，不要让它静默错位`)
        }
        params.push(v)
      })
      // 用老代码的**列清单**（值用占位符，字面量保留）拼一条等价语句。
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.map((v) => (v === '?' ? '?' : v)).join(', ')})`
      try {
        mod.db.prepare(sql).run(...params)
        wrote += 1
      } catch (e) {
        assert.fail(
          `回滚场景下老代码的 INSERT 失败了：${table}\n  SQL: ${sql}\n  原因: ${e.message}\n` +
          '⇒ 新版本动了老语句依赖的东西（新增 NOT NULL 无默认列 / 删列 / 改名 / 加约束）。' +
          'DEPLOY.md §6 的回滚表宣称"表结构只增不改"，这里就是那句话能不能兑现的判据。')
      }
    }
    assert.equal(wrote, inserts.length, '三条老 INSERT 都应当写得进去')
  })

  it('② 老代码不认识的新表**不带**禁止老写入的触发器/约束', () => {
    // 老代码只碰自己那三张表，所以真正会影响它的只有"那三张表上被挂了新东西"。
    // 触发器是最隐蔽的一种：新表闲置确实互不破坏，但**挂在老表上的**触发器会。
    const triggers = mod.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'").all()
    const onOldTables = triggers.filter((t) => Object.keys(OLD_INSERT_COLUMNS).includes(t.tbl_name))
    assert.deepEqual(onOldTables.map((t) => `${t.tbl_name}.${t.name}`), [],
      '老表上挂了触发器——回滚旧代码时它会照常触发，而旧代码完全不知道它的存在')
  })
})

/** 给某一列造一个合法的必填值（仅供"老 INSERT 能不能过"这一条用）。 */
function sampleValue(table, column, i) {
  // ── 那版 schema 里就允许 NULL 的列：给 NULL（`parent` / `claimedAt` 等确实如此） ──
  if (['parent', 'soldier', 'claimedRound', 'claimedAt'].includes(column)) return null
  if (column === 'id') return table === 'tasks' ? `ROLLBACK-T${i}` : `ROLLBACK-${i}`
  if (column === 'title') return '回滚写入'
  if (column === 'description') return ''
  if (column === 'kind') return 'agent'
  if (column === 'online') return 1
  if (column === 'action') return 'rollback:probe'
  if (column === 'member') return 'general'
  if (column === 'scope') return 'software'
  if (column === 'detail') return '{}'
  if (column === 'status') return 'backlog'
  if (column === 'priority') return 'medium'
  if (column === 'role') return 'dev'
  if (column === 'ordersVersion') return 1
  if (table === 'audit' && column === 'seq') return 900 + i
  if (table === 'audit' && column === 'taskId') return null
  // 那版 schema 里所有 `TEXT DEFAULT '[]'` 的 JSON 列
  if (['acceptance', 'blocks', 'blockedBy', 'comments', 'evidence', 'patches'].includes(column)) return '[]'
  if (column === 'ts' || column.endsWith('At')) return '2026-02-01T00:00:00.000Z'
  return undefined
}
