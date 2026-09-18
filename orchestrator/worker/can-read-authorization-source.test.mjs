// orchestrator/worker/can-read-authorization-source.test.mjs
// ============================================================================
// PRT-253（canRead 授权批）：**worker 认领一个 Attempt 之后，手里到底有没有
// "这一次能读哪些来源"这个答案**——用**真** `claim()` 回答，不用手写夹具。
//
// ## 为什么这条读数必须用真 claim
//
// `runtime/dsh-composition/can-read-authorization-boundary.test.mjs` 锁的是"各段接缝
// 搬了哪些键"，它用的 lease 是**用例构造**的。而本批的结论（(B)）说的是
// 「授权不随请求到达 Runtime 进程」——这句话的**前提**是"worker 侧认领回来的东西里
// 有 / 没有授权"。前提若是自己写出来的形状，结论就只是自己跟自己对账。
//
// 所以这里走**真**路径：临时 SQLite（`mkdtempSync` 在 tmpdir 下）+ `ensureContextSchema`
// + `createRunStore().claim()`，读回来的是 `run-store.mjs` 真造出来的那个对象。
// `orchestrator/worker/context-stage.test.mjs` 已经 import 过 `team-hub/context-store.mjs`，
// 这条依赖不是本文件新开的（`runtime/` 侧则**不得**这样 import，见 dsh-boundary）。
//
// ## 诚实边界
//
//   · 它证明的是"**本仓库当前**的 `claim()` 不返回授权字段"，不是"授权永远不在这一侧"。
//     真来源（EmployeeManifest）在 hub 的库里，不在 lease 上——这条由
//     `team-hub/server.mjs` 的 `/api/employee-manifest` 路由与 `sources-loader.mjs`
//     的取数路径决定，见文档 §4。
//   · 它**不**声称"权限判定没做"。判定做了，而且是在 worker 侧做的（喂给 hub 的装配路由）；
//     它声称的是那个判定**不进 execute 请求**。
//   · ★ PRT-214 缺口①之后 (B) 有了一个**新后果**，而它正好是这批最要紧的读数：
//     既然真 lease 上**没有**权限档位，而每一次 Run 的静态 hard floor 现在都由
//     那个档位派生，那么**今天生产里的每一次 Run 都会在派发前被具名拒绝**
//     （`run-floor-permissions-missing`）。这不是"判定没做"，是"作为输入的那份
//     档位还没被搬到这一侧来"——§④ 用同一个真 lease 把它读出来。
//     一个"缺口还在"的批评与一个"接线断了、所以每次 Run 都当场停下"的读数，
//     在只看 ①②③ 的时候是同一个东西——只不过前者不会让任何一次 Run 停下来。
//     在只看 ①②③ 的时候是同一个东西——只不过前者不会让任何一次 Run 停下来。
//
//     ⚠️ **2026-09-18 订正：以上这一条（含那句"**今天**生产里的**每一次** Run
//     都会在派发前被具名拒绝"）说的是"第二步**之前**"的口径，那句**已过期**。**
//     权限档位现在**有**生产来源（`team-hub/server.mjs:438` 的
//     `resolveRunPermissions`），所以正常员工的 Run 不再停在派发前——
//     紧接下面"第二步之后"那一节里的 ⑤（结论**恰好相反**）就是这件事的读数。
//     今天**仍会**以 `run-floor-permissions-missing` 停下的只剩"这个员工没有
//     清单"（端口返回 `null`）那一类，那是**一部分** Run，不是"每一次"。
//     *原文保留*：这一段本身是「一个『每一次都停下』的读数与一个『有一类会停下』
//     的读数，在只看 ①②③ 的时候是同一个东西」这句话的又一个实例。
//
// ## ★ PRT-214 第二步之后：这个文件现在是**两半**，而两半都必须留着
//
// ①②③④ 跑的是**没有接线**的 `createRunStore`（不给 `resolveRunPermissions`）。
// 那时租约上**恰好还是那 8 个键**——所以它们一字未改地继续成立，而且继续承重：
// 它们证明的是"档位不会自己长出来"，这正是"为什么必须显式接线"的证据。
//
// ⑤ 跑的是**接了线**的那个，结论**恰好相反**：租约上多出三个键，它们**是**
// 授权载体。于是这个文件的结论从"授权不在这一侧"变成了：
//
//   > **授权在不在这一侧取决于有没有接线；接了线之后，它就在这一侧，
//   >  而它的来源被钉死在注入的那个端口上。**
//
// 一条断言"这个键不存在"的用例，在功能接上之后**必须**换成一条断言"这个键存在、
// 而且它只能从那个地方来"——直接删掉 ①②③ 等于把"档位不会自己长出来"这道边界
// 一起删掉；只留 ①②③ 则会让这个文件在功能接上之后**继续报平安**。
// ============================================================================

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore } from '../../team-hub/run-store.mjs'
import { ensureContextSchema } from '../../team-hub/context-store.mjs'
import { defaultRequestFor, deriveRunFloorCarrier } from './executor.mjs'
import { RUN_REQUEST_REQUIRED } from '../../runtime/contracts/run.mjs'
import { RUN_FLOOR_STATES } from '../../runtime/contracts/run-floor.mjs'

/** 真 claim 回来的那 8 个键（**带顺序无关的整体比较**，不是"包含"）。 */
const CLAIMED_LEASE_KEYS = Object.freeze([
  'attemptId', 'attemptNo', 'leaseEpoch', 'leaseExpiresAtMs', 'scope', 'serverTimeMs', 'state', 'taskId',
])

const AUTHORITY_LOOKING = /read|auth|grant|permit|acl|visib/i

const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-cra-source-'))
assert.ok(resolve(SCRATCH).startsWith(TMP_ROOT), `临时目录逃出了 tmpdir：${SCRATCH}`)

after(() => {
  try { rmSync(SCRATCH, { recursive: true, force: true }) } catch { /* WAL 句柄在 Windows 上可能还占着 */ }
})

const SCOPE = 'scope:cra-source'

/** 建一个真库 + 一张真 task，然后走**真** `claim()`。 */
function claimOnce(tag) {
  const db = new DatabaseSync(join(SCRATCH, `team-${tag}.db`))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  ensureContextSchema(db)
  const store = createRunStore({ db, clock: () => 1_700_000_000_000 })
  const taskId = `task:${tag}`
  db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, taskId, 'medium', 'todo', SCOPE, 0, '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.000Z')

  const claimed = store.claim({ workerId: `w-${tag}` })
  assert.equal(claimed.ok, true, `真 claim 没成功：${JSON.stringify(claimed.code ?? claimed)}`)
  assert.notEqual(claimed.claimed, null, 'claim 成功了却没有 lease')
  return { lease: claimed.claimed, taskId, db }
}

test('① 真 claim() 返回的对象**恰好**那 8 个键，且没有任何读 / 授权形状的键', () => {
  const { lease, db } = claimOnce('shape')
  try {
    // ★ 整体比较，不是 `includes`：多一个键就红，而"多一个键"正是本批要找的东西。
    assert.deepEqual(Object.keys(lease).sort(), [...CLAIMED_LEASE_KEYS].sort(),
      '真 claim 回来的键集变了——新增的那个键是不是授权的载体？')
    assert.deepEqual(Object.keys(lease).filter((k) => AUTHORITY_LOOKING.test(k)), [],
      'lease 上出现了读 / 授权形状的键——那 (B) 的结论要重判')
    assert.equal(lease.state, 'Leased')
    assert.equal(lease.scope, SCOPE, 'lease 带的是**空间**，不是"这一空间里哪些来源可读"')
  } finally {
    db.close()
  }
})

test('② 拿**真** lease 造 RunRequest：仍然只有工具面权限，读面一个字段都没有', () => {
  // ★ `db` 必须接住并关掉：不关的话 SQLite 的 WAL 句柄在 Windows 上会一直占着
  //   临时目录，`after()` 里那次 `rmSync` 就删不掉——表现为每跑一次这套件，
  //   `%TEMP%` 里就多留一个 `legion-cra-source-*`（本条此前正是这样漏的）。
  const { lease, taskId, db } = claimOnce('request')
  try {
    // `workspaceId` / `modelProfileRef` / `workdir` 是"在哪个目录、用哪个模型跑"，
    // `defaultRequestFor` 明确拒绝猜它们（见它的 JSDoc）——生产里由 worker 的配置给。
    // 这里显式列出来，正是为了让"lease 里没有它们"这件事在读数上可见（见 ③）。
    const callerSupplied = { workspaceId: 'ws:cra', modelProfileRef: 'model:cra', workdir: process.platform === 'win32' ? 'C:\\work' : '/work' }
    const snapshot = {
      associations: { goalId: 'goal:cra', taskId, employeeId: 'emp:cra', teamPlanId: 'plan:cra' },
      finalText: 'FROZEN-PROMPT-TEXT',
    }

    const request = defaultRequestFor({ ...lease, ...callerSupplied }, snapshot)
    const keys = Object.keys(request).sort()

    // 契约必填集必须被填满（`defaultRequestFor` 自己也会查，这里是**独立**复核）。
    assert.deepEqual(RUN_REQUEST_REQUIRED.filter((k) => request[k] === undefined || request[k] === null || request[k] === ''),
      [], 'RunRequest 还有必填字段是空的')
    assert.deepEqual(keys.filter((k) => !RUN_REQUEST_REQUIRED.includes(k)), ['prompt'],
      '"不在必填集里"的键只能有 prompt')
    assert.deepEqual(keys.filter((k) => AUTHORITY_LOOKING.test(k)), [],
      '拿真 lease 造出来的 RunRequest 上出现了读 / 授权形状的键')
    // 权限面**只有**工具面档位。它与"能读哪些上下文来源"是两件事，
    // 而它是本请求里唯一带默认值的一项（`executor.mjs:424`）——不要把它读成授权。
    assert.deepEqual(Object.keys(request.permissions).sort(), ['preset', 'tools'])
    assert.equal(request.contextSnapshotRef, lease.attemptId, '执行引用的必须是那份被冻结的快照')
  } finally {
    db.close()
  }
})

test('③ 真 lease 缺的 RunRequest 必填字段是"配置面"的，不是"授权面"的', () => {
  const { lease, db } = claimOnce('gaps')
  try {
    const missing = RUN_REQUEST_REQUIRED
      .filter((k) => lease[k] === undefined || lease[k] === null || lease[k] === '')
      .sort()
    // 缺的必须**全部**落在配置 / 关联面；只要有一个落在授权面，本批的结论就变了。
    assert.deepEqual(missing.filter((k) => AUTHORITY_LOOKING.test(k)), [],
      '真 lease 缺的字段里有授权形状的键')
    // 缺哪些是**读数**（不是断言一个写死的清单——那份清单会随契约漂移，
    // 而"漂了没人知道"正是这一类断言最坏的失败方式）。这里只钉住它非空：
    // 若非空都不成立，说明 lease 自己就够造请求，那 ③ 的存在理由也就没了。
    assert.ok(missing.length > 0, `真 lease 竟然不缺任何必填字段：${JSON.stringify(Object.keys(lease))}`)
    // 并且 `workspaceId` / `modelProfileRef` / `workdir` 必须**在**缺的那一组里：
    // 这三样正是"猜不出来、必须由调用方给"的那三样。
    for (const k of ['workspaceId', 'modelProfileRef', 'workdir']) {
      assert.ok(missing.includes(k), `${k} 不在真 lease 缺的字段里——那它现在从哪来？`)
    }
  } finally {
    db.close()
  }
})

test('④ ★★ 真 lease 走**真**生产者：档位没到这一侧 ⇒ 派发前具名拒绝（不是空下限）', () => {
  const { lease, taskId, db } = claimOnce('floor')
  try {
    const callerSupplied = {
      workspaceId: 'ws:cra', modelProfileRef: 'model:cra',
      workdir: process.platform === 'win32' ? 'C:\\work' : '/work',
    }
    const snapshot = {
      associations: { goalId: 'goal:cra', taskId, employeeId: 'emp:cra', teamPlanId: 'plan:cra' },
      finalText: 'FROZEN-PROMPT-TEXT',
    }
    const request = defaultRequestFor({ ...lease, ...callerSupplied }, snapshot)

    // 前提：`defaultRequestFor` 把"控制面没给"如实标出来了（按引用，不是按形状）。
    assert.equal('permissions' in lease, false, '真 lease 上出现了 permissions——这一条的结论要重判')

    const carried = deriveRunFloorCarrier(request)
    assert.equal(carried.state, RUN_FLOOR_STATES.REFUSED,
      `真 lease 竟然派得出下限（${carried.state}）——那要么档位已经被搬到这一侧，`
      + '要么生产者把"没给"读成了"没有工具"。两种都得先把这一组改掉')
    // ★ 关键：状态是 `refused`（"给了但解释不了"），**不是** `absent`（"没有人给我下限"）。
    //   两者都会拒绝一切，但只有前者说的是真话：这次 Run 的下限本来是有人生产的。
    assert.notEqual(carried.state, RUN_FLOOR_STATES.ABSENT)
    assert.equal(carried.payload.derived, false)
    assert.equal(carried.payload.floor, null, '"派生不出来"不能被写成一份空名单')
    assert.deepEqual([...carried.payload.refusals], ['run-floor-permissions-missing'],
      '拒绝码就是"去改哪里"：把权限档位搬到 lease（或搬到那条装配路）上')
  } finally {
    db.close()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ PRT-214 第二步：**接了线之后**，授权就在这一侧——而来源被钉死
// ════════════════════════════════════════════════════════════════════════════
//
// 与 ①②③④ 用的是同一套真件（临时 SQLite + 真 `claim()`），只多给了一个
// `resolveRunPermissions`。这样两半的差异**只有那一个变量**，
// "多出来的三个键是从哪来的"就只有一个可能答案。

/** 接上端口的 `createRunStore`。`tier` 是端口要返回的东西（`null` = 没有清单）。 */
function claimWithTier(tag, tier) {
  const db = new DatabaseSync(join(SCRATCH, `tier-${tag}.db`))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  ensureContextSchema(db)
  const store = createRunStore({
    db,
    clock: () => 1_700_000_000_000,
    // ★ 这就是"接线"本身。**生产实现在 `team-hub/server.mjs`**：
    //   它拿 `taskId` 去读 `tasks.role`，再读那一行的岗位清单。
    //   这里用一个显式返回值的最小实现，是为了让"多出来的三个键从哪来"
    //   在这条用例里**唯一确定**。
    resolveRunPermissions: (args) => {
      assert.deepEqual(Object.keys(args).sort(), ['attemptId', 'scope', 'taskId', 'workerId'],
        '端口被调用时的参数集变了——那"这次是哪个岗位"的来源就变了，这一组要重判')
      return tier
    },
  })
  const taskId = `task:tier-${tag}`
  db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, taskId, 'medium', 'todo', SCOPE, 0, '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.000Z')

  const claimed = store.claim({ workerId: `w-tier-${tag}` })
  assert.equal(claimed.ok, true, `真 claim 没成功：${JSON.stringify(claimed.code ?? claimed)}`)
  assert.notEqual(claimed.claimed, null, 'claim 成功了却没有 lease')
  return { lease: claimed.claimed, taskId, db }
}

/** 把接了线的租约补成能过 `defaultRequestFor` 必填校验的那一份。 */
const CALLER_SUPPLIED = {
  workspaceId: 'ws:tier', modelProfileRef: 'model:tier',
  workdir: process.platform === 'win32' ? 'C:\\work' : '/work',
}

test('⑤ ★★★★★ 接了线：租约上**多出**恰好三个键，而它们是授权载体', () => {
  const tier = { allowedTools: ['read-file', 'git-push'], deniedTools: ['mcp-invoke'], approvalPolicy: 'never' }
  const { lease, db } = claimWithTier('wired', tier)
  try {
    // 键集 = 原来那 8 个 ∪ 恰好这三个。多一个少一个都要重判。
    assert.deepEqual(Object.keys(lease).sort(),
      [...CLAIMED_LEASE_KEYS, 'allowedTools', 'approvalPolicy', 'deniedTools'].sort(),
      '接了线之后的键集不是"8 + 3"——那要么少搬了字段，要么搬了没人要的东西')
    assert.deepEqual([...lease.allowedTools], ['read-file', 'git-push'])
    assert.deepEqual([...lease.deniedTools], ['mcp-invoke'])
    assert.equal(lease.approvalPolicy, 'never')

    // ★ 这一条是**对 ① 的正面反证**：`AUTHORITY_LOOKING` 那个过滤器在这里
    //   **抓不到**这三个键（`allowedTools`/`approvalPolicy`/`deniedTools` 都不含
    //   read/auth/grant/permit/acl/visib）。也就是说：
    //
    //     > 一个只靠"键名看起来像不像授权"来守这道边的检查，
    //     > 与一个**真的**在这条边上守住了东西的检查，是同一个东西——
    //     > 只不过前者在授权换了个名字搬过来的时候会继续报平安。
    //
    //   所以 ① 里那条 `AUTHORITY_LOOKING` 零命中**不能**单独当结论用；
    //   承重的是它上面那条**整体键集比较**。这里如实把这一点读出来。
    assert.deepEqual(Object.keys(lease).filter((k) => AUTHORITY_LOOKING.test(k)), [],
      '正则应然抓不到这三个键——抓到说明键名换了，过滤器要重判')
    assert.equal(lease.allowedTools !== undefined, true, '而键**确实**在')
  } finally {
    db.close()
  }
})

test('⑤ ★★★★★ 端到端：接了线的租约一路走到 **installed**，且名单是执行面名字', () => {
  const tier = { allowedTools: ['read-file', 'git-push'], deniedTools: [], approvalPolicy: 'never' }
  const { lease, taskId, db } = claimWithTier('e2e', tier)
  try {
    const request = defaultRequestFor({ ...lease, ...CALLER_SUPPLIED }, {
      associations: { goalId: 'goal:tier', taskId, employeeId: 'emp:tier', teamPlanId: 'plan:tier' },
      finalText: 'FROZEN',
    })
    // 这一跳是 ④ 的**反面**：那边是 `refused`，这边必须是 `installed`。
    const carried = deriveRunFloorCarrier(request, { platform: process.platform })
    assert.equal(carried.state, RUN_FLOOR_STATES.INSTALLED,
      `接了线之后下限还是 ${carried.state}——那说明档位没走到派生点`)
    assert.equal(carried.payload.derived, true)
    assert.deepEqual([...carried.payload.floor.denyTools], ['bash', 'pwsh'],
      '下限里不是**执行面**名字')
  } finally {
    db.close()
  }
})

test('⑤ ★★★★ 端口返回 `null`（没有清单）与"接了线但没接上"必须分开', () => {
  // 三种读数，三种处置，而它们**都在这一层**分得开：
  //   · 端口没接（①②③④）      → 没有那三个键，下游 `permissions-missing`
  //   · 端口接了、返回 null     → **同样**没有那三个键（"这个员工没有清单"）
  //   · 端口抛错 / 形状不对     → `claim()` 直接失败 `RUN_TIER_UNRESOLVABLE`
  //
  // 前两者对 worker 是同一件事（没人告诉它这次能干什么），所以它们在租约上
  // **本来就该同形**；真正需要分开的是第三种——那一种在这里当场说清楚。
  const { lease, db } = claimWithTier('nom', null)
  try {
    assert.deepEqual(Object.keys(lease).sort(), [...CLAIMED_LEASE_KEYS].sort(),
      '端口返回 null 时租约的形状必须与"没接线"完全一样——'
      + '那正是"没有清单"这个读数的定义')
  } finally {
    db.close()
  }
})

test('⑤ ★★★★ 端口抛错 ⇒ `claim()` 当场失败（不是安静地当成"没有清单"）', () => {
  const db = new DatabaseSync(join(SCRATCH, 'tier-broken.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  ensureContextSchema(db)
  try {
    // ① 端口自己抛（清单表坏了）
    const boom = createRunStore({
      db, clock: () => 1_700_000_000_000,
      resolveRunPermissions: () => { throw new Error('清单表读写失败（探针）') },
    })
    // ② 端口形状不对（注入了写错列的实现）
    const malformed = createRunStore({
      db, clock: () => 1_700_000_000_000,
      resolveRunPermissions: () => ({ allowedTools: 'read-file' }),
    })
    db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('task:broken', 'task:broken', 'medium', 'todo', SCOPE, 0, 'x', 'x')

    for (const [what, store] of [['抛错', boom], ['形状不对', malformed]]) {
      assert.throws(() => store.claim({ workerId: 'w-broken' }), (e) => {
        assert.equal(e.code, 'RUN_TIER_UNRESOLVABLE',
          `${what}的端口没有被判成"控制面读不出来"（收到 ${e.code}）——`
          + '它会退化成"这个员工没有清单"，于是排障会去查那个员工的配置')
        return true
      }, `${what}的端口应该让 claim 当场失败`)
    }
  } finally {
    db.close()
  }
})
