// team-hub/run-events.test.mjs
// ============================================================================
// F-05 前半的判据：**运行明细作为可持久化 RunEvent 写入控制面**。
//
// 这一组要回答的问题，改动前**没有任何地方**能回答：
//
//   > 这次运行到底用了哪个模型、请求了哪些工具、工具成了还是败了？
//
// 改动前 `orchestrator/worker/executor.mjs` 的事件循环是
// `if (终态) 留下 else if (用量/产物) 留下`——13 种事件里只有两类能落地，
// 其余 11 种**读完即弃**。
//
// 用例分三层，因为它们各自会以不同的方式失效：
//   ① 仓储层（`recordRunEvents` / `runEventsOf`）：幂等、序号、体积、权限；
//   ② 接线层（`executor` 真的收集）：三条出口（成功 / 返回失败 / 抛出）都要带明细；
//   ③ HTTP 层（真 hub）：终态迁移与明细**同一个请求**，且能读回来。
// ============================================================================
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { MAX_RUN_EVENT_JSON_BYTES, RUN_ERRORS, createRunStore } from './run-store.mjs'
import { createContextStore } from './context-store.mjs'
import { assembleContext } from '../runtime/context/assembler.mjs'
import { TOKEN_ESTIMATOR_KINDS } from '../runtime/contracts/context.mjs'
import { RUN_EVENT_TYPES, isKnownEventType } from '../runtime/contracts/run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 临时库 + 一条已认领的 Attempt（明细必须挂在一条真的尝试上）。
 *
 * `tasks` 表按 `run-store.test.mjs` 那份**同样的最小列集**建：
 * 少了 `version` 这一列时 `projectToTask` 会在 `claim()` 里炸
 * （`no such column: version`），而报错位置离"我的夹具少了一列"很远。
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-runev-'))
  const db = new DatabaseSync(join(dir, 'team.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1,
      soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0,
      createdAt TEXT, updatedAt TEXT
    )
  `)
  let t = 1_000_000
  const store = createRunStore({ db, clock: () => t })
  db.prepare('INSERT INTO tasks (id,title,priority,status,scope,hold,createdAt,updatedAt) VALUES (?,?,?,?,?,0,?,?)')
    .run('T-1', 'T-1', 'medium', 'todo', 'software', new Date(t).toISOString(), new Date(t).toISOString())
  const claimed = store.claim({ workerId: 'w-1' }).claimed
  assert.ok(claimed !== null && claimed !== undefined, '夹具没能认领到任务')
  return {
    db, store, dir,
    attemptId: claimed.attemptId,
    leaseEpoch: claimed.leaseEpoch,
    advance: (ms) => { t += ms },
    dispose: () => { try { db.close() } catch { /* 已关 */ } rmSync(dir, { recursive: true, force: true }) },
  }
}

const ev = (seq, type, extra = {}) => ({ seq, type, event: { seq, type, ...extra } })

// ---------------------------------------------------------------- ① 仓储层

test('① 13 种契约事件全部能落库并原样读回', () => {
  const f = fixture()
  try {
    const events = RUN_EVENT_TYPES.map((type, i) => ev(i + 1, type, { note: `第${i + 1}种` }))
    const r = f.store.recordRunEvents({ attemptId: f.attemptId, events, leaseEpoch: f.leaseEpoch })
    assert.equal(r.ok, true)
    assert.equal(r.written, 13)
    assert.equal(r.skipped, 0)
    assert.equal(r.total, 13)
    const back = f.store.runEventsOf(f.attemptId)
    assert.equal(back.length, 13)
    // 序号与类型必须**逐个对齐**：只有条数对而顺序乱了，复盘时会把
    // "先请求工具后选模型"读成另一回事。
    for (let i = 0; i < 13; i += 1) {
      assert.equal(back[i].seq, i + 1)
      assert.equal(back[i].type, RUN_EVENT_TYPES[i])
      assert.equal(back[i].known, true, `${RUN_EVENT_TYPES[i]} 被标成了未知类型`)
      assert.equal(back[i].event.note, `第${i + 1}种`)
    }
  } finally { f.dispose() }
})

test('② 幂等：同一批重放不产生第二份，也不报错', () => {
  const f = fixture()
  try {
    const events = [ev(1, 'run.started'), ev(2, 'model.selected'), ev(3, 'run.completed')]
    const first = f.store.recordRunEvents({ attemptId: f.attemptId, events, leaseEpoch: f.leaseEpoch })
    assert.equal(first.written, 3)
    // 崩后重扫 / 人工补写都会重放同一段。
    const second = f.store.recordRunEvents({ attemptId: f.attemptId, events, leaseEpoch: f.leaseEpoch })
    assert.equal(second.written, 0, '重放写出了第二份明细')
    assert.equal(second.skipped, 3, '"被跳过了几条"必须如实报出来')
    assert.equal(f.store.runEventsOf(f.attemptId).length, 3)
  } finally { f.dispose() }
})

test('③ 未知事件类型**照收不误**但标 known:false（丢掉它会让"新增了事件"与"什么都没发生"同形）', () => {
  const f = fixture()
  try {
    f.store.recordRunEvents({
      attemptId: f.attemptId,
      leaseEpoch: f.leaseEpoch,
      events: [ev(1, 'run.started'), ev(2, 'tool.teleported'), ev(3, 'run.completed')],
    })
    const back = f.store.runEventsOf(f.attemptId)
    assert.equal(back.length, 3, '未知类型的事件被丢掉了')
    const unknown = back.find((e) => e.type === 'tool.teleported')
    assert.equal(unknown.known, false)
    // 反向对照：已知的那两条必须仍是 known:true。
    assert.equal(back.find((e) => e.type === 'run.started').known, true)
    const counts = f.store.runEventCountsOf(f.attemptId)
    assert.equal(counts.unknownTypeCount, 1)
    assert.equal(counts.total, 3)
    assert.equal(counts.byType['tool.teleported'], 1)
  } finally { f.dispose() }
})

test('④ `known` 的判定用的是**契约**，不是这里手写的一份名单', () => {
  // 一份手写的类型名单会与契约漂移，而漂移的表现是"新事件被标成未知"
  // 或"未知事件被标成已知"——两者都不会报错。
  for (const t of RUN_EVENT_TYPES) assert.equal(isKnownEventType(t), true)
  assert.equal(isKnownEventType('tool.teleported'), false)
  // 结构级对照：仓储用的是契约导出的那个函数，服务端**没有**再判一遍
  //（两处都判 = 两份会漂移的名单）。
  const store = readFileSync(join(HERE, 'run-store.mjs'), 'utf8')
  assert.match(store, /import \{ isKnownEventType \} from '\.\.\/runtime\/contracts\/run\.mjs'/,
    'run-store 没有从契约取 isKnownEventType —— 它可能自己抄了一份事件名单')
  assert.match(store, /isKnownEventType\(ev\.type\)/, '仓储没有真的用契约判定 known')
  const server = readFileSync(join(HERE, 'server.mjs'), 'utf8')
  assert.equal(/isKnownRunEventType/.test(server), false,
    '服务端也判了一遍 known —— 两处判定会漂移，而漂移不会报错')
})

test('⑤ 序号必须是契约给的；坏序号**抛错**而不是替它编号', () => {
  const f = fixture()
  try {
    for (const bad of [undefined, null, -1, 1.5, '2', NaN]) {
      assert.throws(
        () => f.store.recordRunEvents({ attemptId: f.attemptId, leaseEpoch: f.leaseEpoch, events: [ev(bad, 'run.started')] }),
        /seq 必须是非负安全整数/,
        `${JSON.stringify(bad)} 被接受了 —— 替调用方编号会得到两个可能不一致的号，事后无法回答"哪一个是当时那个"`,
      )
    }
    assert.throws(
      () => f.store.recordRunEvents({ attemptId: f.attemptId, leaseEpoch: f.leaseEpoch, events: [{ seq: 1 }] }),
      /type 必须是非空字符串/,
    )
    assert.equal(f.store.runEventsOf(f.attemptId).length, 0, '失败的写入留下了行')
  } finally { f.dispose() }
})

test('⑥ 超大事件被**如实标记**而不是截断后冒充完整', () => {
  const f = fixture()
  try {
    const huge = 'x'.repeat(MAX_RUN_EVENT_JSON_BYTES + 10)
    const r = f.store.recordRunEvents({
      attemptId: f.attemptId,
      leaseEpoch: f.leaseEpoch,
      events: [ev(1, 'message.delta', { text: huge }), ev(2, 'run.completed')],
    })
    assert.equal(r.oversized, 1, '超大事件没有被数出来')
    assert.equal(r.written, 2, '超大事件被整个丢掉了 —— 丢掉它会让"模型说了话但我们没记"与"什么都没说"同形')
    const back = f.store.runEventsOf(f.attemptId)
    assert.equal(back[0].event.truncatedByStore, true)
    assert.equal(back[0].event.limitBytes, MAX_RUN_EVENT_JSON_BYTES)
    assert.equal(back[0].type, 'message.delta', '类型必须还在：复盘要知道发生过什么类型的事件')
    // 反向对照：正常的那条没被标记。
    assert.equal(back[1].event.truncatedByStore, undefined)
  } finally { f.dispose() }
})

test('⑦ 过期 lease epoch 的写入被拒（崩后重启的旧进程不许补明细）', () => {
  const f = fixture()
  try {
    assert.throws(
      () => f.store.recordRunEvents({ attemptId: f.attemptId, events: [ev(1, 'run.started')], leaseEpoch: f.leaseEpoch + 1 }),
      (e) => e.code === RUN_ERRORS.LEASE_EPOCH_STALE,
    )
    assert.equal(f.store.runEventsOf(f.attemptId).length, 0)
  } finally { f.dispose() }
})

test('⑧ 未知 Attempt 抛具名码（不静默建一行孤儿明细）', () => {
  const f = fixture()
  try {
    assert.throws(
      () => f.store.recordRunEvents({ attemptId: 'att:nope:1', events: [ev(1, 'run.started')] }),
      (e) => e.code === RUN_ERRORS.ATTEMPT_NOT_FOUND,
    )
  } finally { f.dispose() }
})

test('⑨ 按类型筛 + limit 校验', () => {
  const f = fixture()
  try {
    f.store.recordRunEvents({
      attemptId: f.attemptId,
      leaseEpoch: f.leaseEpoch,
      events: [ev(1, 'run.started'), ev(2, 'tool.requested'), ev(3, 'tool.completed'), ev(4, 'run.completed')],
    })
    const tools = f.store.runEventsOf(f.attemptId, { type: 'tool.requested' })
    assert.deepEqual(tools.map((e) => e.seq), [2])
    assert.equal(f.store.runEventsOf(f.attemptId, { limit: 2 }).length, 2)
    assert.throws(() => f.store.runEventsOf(f.attemptId, { limit: 0 }), /limit 必须是正安全整数/)
  } finally { f.dispose() }
})

test('⑩ 只追加：源码里没有任何 UPDATE/DELETE run_events 的路径', () => {
  const src = readFileSync(join(HERE, 'run-store.mjs'), 'utf8')
  assert.equal(/UPDATE\s+run_events/i.test(src), false, 'run_events 出现了 UPDATE —— 明细变成了可改写的历史')
  assert.equal(/DELETE\s+FROM\s+run_events/i.test(src), false, 'run_events 出现了 DELETE')
  // 反向对照：确实有一条 INSERT（检查不是"因为整个表都不存在"而通过）。
  assert.match(src, /INSERT INTO run_events/)
})

// ---------------------------------------------------------------- ② 接线层（executor）

test('⑪ executor 真的收集事件：三条出口都带明细', () => {
  const src = readFileSync(join(HERE, '..', 'orchestrator', 'worker', 'executor.mjs'), 'utf8')
  // 收集容器必须存在，且事件循环里**在丢弃之前**先收。
  assert.match(src, /const collectedEvents = \[\]/, 'executor 没有收集事件的容器')
  // 上界必须存在：无界收集把 worker 的内存交给上游流的长度决定。
  assert.match(src, /MAX_COLLECTED_RUN_EVENTS/, 'executor 收集事件没有上界')
  // 成功路径带出去。
  assert.match(src, /runEvents: Object\.freeze\(\[\.\.\.collectedEvents\]\)/, '成功路径没有把明细带出去')
  // 抛错路径也带出去（挂在错误对象上）。
  assert.match(src, /runEvents: Object\.freeze\(\[\.\.\.collectedEvents\]\)[\s\S]{0,200}runEventsTruncated: eventsTruncated/,
    '抛错路径没有把已经收到的事件带出去 —— 那正是最需要复盘的一次')
  assert.match(src, /ExecutorError\(EXECUTOR_CODES\.RUN_NOT_COMPLETED,[\s\S]{0,300}runEvents:/,
    'ExecutorError 上没挂明细')
})

test('⑫ worker 把明细随终态与失败一起上报（三条出口）', () => {
  const src = readFileSync(join(HERE, '..', 'orchestrator', 'worker', 'main.mjs'), 'utf8')
  // ★ 这里必须按 `context:` 定位那一次 `hub.transition`，不能只取**第一个**
  //   `await hub.transition({...})`：`main.mjs` 里另有一处 `transition({to})`
  //   （纯状态推进，不该带明细）。按"第一个"匹配会取到它，然后报
  //   "终态迁移没有带明细"——而终态迁移其实是对的，是**探针找错了地方**。
  const transition = /await hub\.transition\(\{[\s\S]{0,1200}?context:\s*\{[\s\S]*?\n\s*\}\)/.exec(src)
  assert.ok(transition !== null, '没找到带 context 的终态迁移调用')
  assert.match(transition[0], /runEvents: result\?\.runEvents \?\? null/,
    '终态迁移没有带明细 —— 那条声明就只是一句话')
  assert.match(transition[0], /runEventsTruncated: result\?\.runEventsTruncated === true/,
    '终态迁移没有带上"收集被截断了"这个事实')
  const submits = [...src.matchAll(/submitFailure\(\{[\s\S]{0,600}?\n\s*\}\)/g)]
  assert.ok(submits.length >= 2, `submitFailure 的调用点少于 2 个（实际 ${submits.length}）`)
  const withEvents = submits.filter((m) => m[0].includes('runEvents'))
  assert.ok(withEvents.length >= 2,
    `只有 ${withEvents.length} 个失败出口带了事件明细 —— 失败的 Run 正是最需要复盘的那种`)
  assert.match(src, /runEvents: Array\.isArray\(e\?\.runEvents\) \? e\.runEvents : null/,
    '抛错路径没有从错误对象上取回明细')
})

// ---------------------------------------------------------------- ③ HTTP 层

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-runev-http-'))
let mod
let base = ''
const TOKEN = 'runev-token'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const auth = { authorization: `Bearer ${TOKEN}` }

async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

async function get(path) {
  const r = await fetch(base + path, { headers: auth })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** 造一条任务并认领它，返回 lease。 */
async function claimOne(tag) {
  const id = `T-EV-${tag}`
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,0,?,?)',
  ).run(id, id, 'medium', 'todo', 'software', new Date().toISOString(), new Date().toISOString())
  const r = await post('/api/runtime/claim', { workerId: `w-${tag}`, scope: 'software' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  // 响应形状是 `{ok:true, claimed:{attemptId,…}}`——`claimed` 是**对象**不是布尔。
  // 写成 `assert.equal(r.body.claimed, true)` 会红，而红的位置指向"没能认领"，
  // 与真实原因（探针读错了字段）毫无关系。
  assert.ok(r.body.claimed !== null && typeof r.body.claimed === 'object',
    `没能认领到任务：${JSON.stringify(r.body)}`)
  return r.body.claimed
}

/**
 * 冻一份上下文快照（`BuildingContext → Running` 的闸门，PRT-411）。
 *
 * 为什么测试要自己做这件事：状态机要求 `Running` 之前必须有一份**已落库**的
 * 上下文快照，而不做这一步的话 `Leased → Validating` 会被拒
 * （`ILLEGAL_TRANSITION`）。那是一条**正确的**拒绝——它防的是"没经过上下文
 * 就直接宣称在执行"。所以探针必须走完整段，而不是绕过它。
 */
function freezeContext(attemptId) {
  const store = createContextStore({ db: mod.db, clock: Date.now, writeAudit: () => {} })
  const snap = assembleContext({
    attemptId,
    runId: `run-${attemptId}`,
    frozenAtMs: Date.now(),
    candidates: [],
    policy: { scope: 'software', canRead: () => true, maxTokens: null },
    tokenizer: { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: () => 0 },
  })
  store.record(snap, { scope: 'software', actor: 'test' })
}

/** 把一条刚认领的 Attempt 推到 `Running`（终态迁移的合法前驱）。 */
async function toRunning(lease, tag) {
  for (const to of ['PreparingWorkspace', 'BuildingContext']) {
    const r = await post('/api/runtime/transition', {
      attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: `w-${tag}`, to,
    })
    assert.equal(r.status, 200, `${to} 被拒：${JSON.stringify(r.body)}`)
  }
  freezeContext(lease.attemptId)
  const r = await post('/api/runtime/transition', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: `w-${tag}`, to: 'Running',
  })
  assert.equal(r.status, 200, `Running 被拒：${JSON.stringify(r.body)}`)
  return lease
}

test('⑬ 终态迁移携带明细：**同一个请求**落库，并且能立刻读回来', async () => {
  const lease = await toRunning(await claimOne('t13'), 't13')
  const events = [
    ev(1, 'run.started'), ev(2, 'model.selected', { model: 'deepseek-v4' }),
    ev(3, 'tool.requested', { toolName: 'pwsh' }), ev(4, 'tool.completed', { toolName: 'pwsh' }),
    ev(5, 'run.completed'),
  ]
  const t = await post('/api/runtime/transition', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'w-t13',
    outcome: 'completed',
    context: { detail: 'ok', runResult: { outcome: 'succeeded' }, runEvents: events },
  })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  // ★ 写入读数必须回给调用方：明细没写成时它要能知道。
  assert.equal(t.body.runEvents.ok, true)
  assert.equal(t.body.runEvents.written, 5)

  const back = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}`)
  assert.equal(back.status, 200)
  assert.equal(back.body.events.length, 5)
  assert.deepEqual(back.body.events.map((e) => e.type),
    ['run.started', 'model.selected', 'tool.requested', 'tool.completed', 'run.completed'])
  // ★ 这一条就是 F-05 前半存在的全部理由：**"这次调了哪个工具"能回答**。
  assert.equal(back.body.events.find((e) => e.type === 'tool.requested').event.toolName, 'pwsh')

  const counts = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}&counts=1`)
  assert.equal(counts.status, 200)
  assert.equal(counts.body.byType['tool.requested'], 1)
  assert.equal(counts.body.total, 5)
  assert.equal(counts.body.unknownTypeCount, 0)
})

test('⑭ 失败路径同样落明细（"它在炸之前做了什么"）', async () => {
  // `fail` 只对 `Running` 上的尝试有意义（更早的失败走别的口径），
  // 所以这里也要推到 Running。这正是"探针必须走真实路径"的一个实例。
  const lease = await toRunning(await claimOne('t14'), 't14')
  const f = await post('/api/runtime/fail', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'w-t14',
    failureCode: 'engine-error', detail: '炸了',
    runEvents: [ev(1, 'run.started'), ev(2, 'tool.failed', { toolName: 'pwsh', reason: 'exit 1' })],
  })
  assert.equal(f.status, 200, JSON.stringify(f.body))
  assert.equal(f.body.runEvents.ok, true)
  assert.equal(f.body.runEvents.written, 2)
  const back = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}&type=tool.failed`)
  assert.equal(back.body.events.length, 1)
  assert.equal(back.body.events[0].event.reason, 'exit 1')
})

test('⑮ **不带**明细腻的迁移仍然成功（老 worker 不许因为少了它而失败）', async () => {
  const lease = await toRunning(await claimOne('t15'), 't15')
  const t = await post('/api/runtime/transition', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'w-t15',
    outcome: 'completed', context: { detail: 'ok' },
  })
  assert.equal(t.status, 200, JSON.stringify(t.body))
  // `null`（没带）与 `{ok:false}`（带了没写成）必须是两个读数。
  assert.equal(t.body.runEvents, null, '没带明细时不该编一个读数出来')
  const back = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}`)
  assert.deepEqual(back.body.events, [])
})

test('⑯ 明细写失败**不**让终态回滚（复盘材料缺一点 ≠ 这次运行不成立）', async () => {
  const lease = await toRunning(await claimOne('t16'), 't16')
  const t = await post('/api/runtime/transition', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'w-t16',
    outcome: 'completed',
    // 一条 seq 非法的明细 → 仓储会抛。终态**必须**仍然成立。
    context: { detail: 'ok', runEvents: [{ seq: 'not-a-number', type: 'run.started', event: {} }] },
  })
  assert.equal(t.status, 200, '明细写失败把终态一起带崩了 —— 方向是反的：那会让一次真实的运行结果作废并被重试（真的再花一次钱）')
  assert.equal(t.body.runEvents.ok, false)
  assert.equal(t.body.runEvents.code, 'RUN_EVENTS_NOT_RECORDED')
  assert.equal(t.body.runEvents.offered, 1, '失败读数里没有"丢了多少"')
  // 而且那条尝试确实推进了（终态成立）。
  const st = await get(`/api/runtime/attempt?attemptId=${encodeURIComponent(lease.attemptId)}`)
  assert.equal(st.status, 200)
  assert.notEqual(st.body.attempt.state, 'Running', '终态没有成立')
})

test('⑰ 缺 attemptId 返回 400 + 具名码；不存在返回空数组而不是 404', async () => {
  const missing = await get('/api/runtime/run-events')
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'MISSING_PARAM')
  // 不存在的 attempt：**空数组**。这里与 `/api/event-delivery` 的 404 不同，
  // 因为明细是「一条尝试的子集合」——`runEventsOf` 不回答"这条尝试存不存在"，
  // 那个问题由 `/api/runtime/attempt` 回答。编一个 404 会让调用方
  // 分不清"没有这次尝试"与"这次尝试没有明细"。
  const none = await get('/api/runtime/run-events?attemptId=att%3Anope%3A1')
  assert.equal(none.status, 200)
  assert.deepEqual(none.body.events, [])
})

test('⑱ 未知类型经 HTTP 落库后 known:false 可见', async () => {
  const lease = await toRunning(await claimOne('t18'), 't18')
  await post('/api/runtime/transition', {
    attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'w-t18',
    outcome: 'completed',
    context: { runEvents: [ev(1, 'run.started'), ev(2, 'future.event.type')] },
  })
  const back = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}`)
  const future = back.body.events.find((e) => e.type === 'future.event.type')
  assert.ok(future !== undefined, '未知类型的事件没有落库')
  assert.equal(future.known, false)
  const counts = await get(`/api/runtime/run-events?attemptId=${encodeURIComponent(lease.attemptId)}&counts=1`)
  assert.equal(counts.body.unknownTypeCount, 1)
})
