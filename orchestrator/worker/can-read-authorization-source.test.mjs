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
// ============================================================================

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createRunStore } from '../../team-hub/run-store.mjs'
import { ensureContextSchema } from '../../team-hub/context-store.mjs'
import { defaultRequestFor } from './executor.mjs'
import { RUN_REQUEST_REQUIRED } from '../../runtime/contracts/run.mjs'

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
  const { lease, taskId } = claimOnce('request')
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
