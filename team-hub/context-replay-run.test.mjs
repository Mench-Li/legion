// team-hub/context-replay-run.test.mjs
// ============================================================================
// PRT-410（收尾）：以**真实运行**为起点的端到端回放 + 跨进程重放 + 跨进程确定性
//
// ## 本批补的是哪一半
//
// `context-e2e.test.mjs`（22 例）已经在真实 hub 上验过确定性 / 越权 / 超限 / 回放
// 跨过 HTTP 与 SQLite 之后还成立。但它那条路的起点是**直接 POST 装配接口**——
// 验的是"装配路由"，不是"一次真实运行真的会走到这里"。
//
//   > 一个"直接调装配接口"的端到端用例，
//   > 与一个"从运行起点走一遍"的端到端用例，
//   > 在断言数量上可以完全一样——
//   > 只不过前者永远发现不了"运行那条路根本没接装配"。
//
// 这个缺口正是 PRT-411 的收尾批（生产路径接上 `loadSources`）关掉的。
// 所以本套件的起点刻意选在**生产入口**：
// `productionExecutorProvider` → `buildContext(lease)`。
//
// ## 为什么"跨进程"必须单独验
//
// 同进程里读回来一致，可能只是因为那份对象还在内存里。而快照要回答的是
// "**以后**有人问'模型当时看到了什么'"——那个"以后"通常在另一个进程里。
//
//   > 一个只在写它的那个进程里验得过的哈希，
//   > 与一个写进库里但再也验不过的哈希，是同一个东西——
//   > 只不过前者的用例全绿。
//
// ## 确定性为什么要跨进程 + 跨库
//
// `frozenAtMs` 是快照哈希的一部分（它必须进哈希：否则"同一份输入"与
// "输入相同但冻结时刻不同"无法区分，而后者是两次不同的运行）。
// 生产路径的时钟默认是 `Date.now()`，于是**同一个 Attempt 装配两次会得到
// 两个哈希**——库会以 409 拒绝第二次（这是对的，见下面第 ⑥ 条）。
//
// 所以"同输入同哈希"这条性质只能在**同一个冻结时刻**下问，
// 而那要求注入时钟；再加上"另一个进程、另一个库"才是真正的重放前提。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bindDshRuntime, resetDshRuntimeBinding, productionExecutorProvider } from
  '../orchestrator/worker/executor-binding.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-replay-'))
const dbFile = join(tmpRoot, 'team.db')
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = dbFile
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  resetDshRuntimeBinding()
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
async function get(path) {
  const res = await fetch(base + path)
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

async function seedTask({ title, description = '描述' }) {
  const r = await post('/api/create', {
    title, description, scope: 'default', acceptance: [], boundary: { do: [], dont: [] }, by: 'general',
  })
  assert.ok(r.status === 200 || r.status === 201, `造任务失败：${r.status}`)
  return r.body.task.id
}

/** 生产入口：绑一个最小宿主端口，让引擎真的造得出来。`extra` 用来注入 clock 等。 */
function bindProduction(extra = {}) {
  return bindDshRuntime({
    host: {
      async probeRuntime() { return { ok: true, caps: {} } },
      async startRun() { return { ok: true, outcome: 'completed' } },
    },
    selfCheck: async () => ({ ok: true, autoExecutionForbidden: false, reasons: [] }),
    canRead: () => ({ all: true }),
    ...extra,
  })
}

/** 走**生产入口**冻结一次上下文，返回 attemptId 与读回来的快照。 */
async function runOnceThroughProduction({ taskId, attemptId, getImpl = get }) {
  const provider = await productionExecutorProvider({ post, get: getImpl, env: {} })
  assert.equal(provider.ok, true, `引擎应当造得出来：${JSON.stringify(provider).slice(0, 260)}`)
  await provider.executor.buildContext({
    attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1',
  })
  const res = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
  return { attemptId, res }
}

const digestOf = (snapshot) =>
  JSON.stringify(snapshot.sources.map((s) => [s.id, s.content, s.trust]))

// ── ① 真实运行起点 → 冻结 → 回放 ────────────────────────────────────────

test('★★ 真实运行（生产入口）冻结的快照，读回来重算哈希仍然一致', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '回放用的任务', description: '正文必须能读回来' })
    const { attemptId, res } = await runOnceThroughProduction({ taskId, attemptId: `att:${taskId}:1` })

    assert.equal(res.status, 200, `快照应当可读回：${JSON.stringify(res.body).slice(0, 260)}`)
    assert.equal(res.body?.ok, true, 'verify=1 必须给出 ok:true（读回时再验一次哈希）')
    // ★ 字段名是 `verification`（路由读回时再验一次），不是 `verify`
    assert.equal(res.body?.verification?.ok, true, '库里的记录必须自洽')
    assert.equal(res.body.verification.storedHash, res.body.verification.recomputedHash,
      '存下来的哈希与重算的哈希必须相同——不同就说明这份快照已经被改过')
    assert.equal(res.body.snapshotHash, res.body.verification.storedHash, '顶层哈希与库里的必须一致')
    // 回放要能回答"模型当时看到了什么"：正文在
    const sources = res.body?.snapshot?.sources ?? []
    assert.ok(sources.some((s) => s.type === 'task' && /正文必须能读回来/.test(s.content)),
      '回放必须能看到当时的正文，而不是只有一个哈希')
  } finally { undo() }
})

test('★★★ 快照记下了它属于哪个任务（associations 真的发出去了）', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '归属' })
    const attemptId = `att:${taskId}:2`
    await runOnceThroughProduction({ taskId, attemptId })

    const res = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
    assert.equal(res.body?.associations?.taskId, taskId,
      '★ associations.taskId 必须是真的任务 id。'
      + '路由一直接受这个字段、库里也一直有 task_id 列并建了索引，'
      + '而生产路径此前**从不发它**——于是那四列恒为 NULL，'
      + '"这次运行属于哪个任务"这个问题在库里根本查不出来。')
    // 库里那一列也必须真的写进去了（响应可能由内存对象拼出，库才是账本）
    const row = mod.db.prepare('SELECT task_id FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    assert.equal(row.task_id, taskId, '库里 task_id 列必须被填上')
  } finally { undo() }
})

// ── ② 跨进程重放 ────────────────────────────────────────────────────────

/** 把一段脚本写到临时目录并跑起来，返回它最后一行 JSON。 */
function runChild(name, source, args = []) {
  const f = join(tmpRoot, name)
  writeFileSync(f, source, 'utf8')
  const r = spawnSync(process.execPath, [f, ...args], {
    encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL',
  })
  assert.equal(r.status, 0, `子进程 ${name} 应当成功：${r.stderr ?? ''}`)
  const line = (r.stdout ?? '').trim().split(/\r?\n/).pop()
  return JSON.parse(line)
}

const J = (v) => JSON.stringify(v)
// ★ 必须给一个**真的 file:// URL**：子进程里 `import` 一个裸的 `D:/…` 路径会
//   报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（Windows 上绝对路径不是合法模块标识符）。
const CTX = J(pathToFileURL(join(ROOT, 'runtime/contracts/context.mjs')).href)

test('★★ 跨进程重放：另一个 node 进程只凭「库路径 + attemptId」得到同一个哈希', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '跨进程回放' })
    const attemptId = `att:${taskId}:3`
    const { res } = await runOnceThroughProduction({ taskId, attemptId })
    const storedHash = res.body?.snapshotHash
    assert.ok(typeof storedHash === 'string' && storedHash !== '', '必须有哈希可比')

    // ★ 这个子进程不知道 hub、不知道这次运行、不知道那些来源，
    //   只拿到「库文件 + attemptId」。这正是"以后有人来问"的真实形状。
    const out = runChild('replay-child.mjs', `
import { DatabaseSync } from 'node:sqlite'
import { verifySnapshotHash, computeSnapshotHash } from ${CTX}

const db = new DatabaseSync(process.argv[2], { readOnly: true })
const row = db.prepare('SELECT snapshot_hash, payload_json, task_id FROM run_context_snapshots WHERE attempt_id = ?').get(process.argv[3])
if (row === undefined) { console.log(JSON.stringify({ found: false })); process.exit(0) }
const payload = JSON.parse(row.payload_json)
console.log(JSON.stringify({
  found: true,
  stored: row.snapshot_hash,
  taskIdColumn: row.task_id,
  // 独立算一遍：不依赖 payload 里自带的那个字段
  independent: computeSnapshotHash({ ...payload, snapshotHash: undefined }),
  verify: verifySnapshotHash(payload) === true,
  sourceCount: Array.isArray(payload.sources) ? payload.sources.length : -1,
  taskContent: (payload.sources.find((s) => s.type === 'task') ?? {}).content ?? null,
}))
`, [dbFile, attemptId])

    assert.equal(out.found, true, '另一个进程必须能从库里找到这份快照')
    assert.equal(out.stored, storedHash, '两个进程看到的存储哈希必须相同')
    assert.equal(out.verify, true, '另一个进程独立验哈希也必须通过')
    assert.equal(out.independent, storedHash,
      '另一个进程**独立重算**的哈希也必须相同——只验 payload 自带的字段等于自证自洽')
    assert.equal(out.sourceCount > 0, true, '另一个进程也必须看得到来源，而不是一个空快照')
    assert.match(out.taskContent ?? '', /描述/, '另一个进程也要看得到真实正文')
    assert.ok(out.taskIdColumn, '另一个进程也要看得到归属')
  } finally { undo() }
})

// ── ③ 确定性：跨进程 + 跨库 ─────────────────────────────────────────────

test('★★ 同一份 payload 在 3 个独立进程里重算 → 同一个哈希（规范化跨进程稳定）', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '跨进程重算', description: '同一份 payload' })
    const attemptId = `att:${taskId}:3a`
    const { res } = await runOnceThroughProduction({ taskId, attemptId })
    const storedHash = res.body?.snapshotHash

    // 同一份库记录，3 个互不相干的进程各自读、各自重算。
    // 规范化（canonical）若不跨进程稳定，回放就只在写它的那个进程里成立。
    const childSrc = `
import { DatabaseSync } from 'node:sqlite'
import { computeSnapshotHash, snapshotCanonicalJson, verifySnapshotHash } from ${CTX}
const db = new DatabaseSync(process.argv[2], { readOnly: true })
const row = db.prepare('SELECT snapshot_hash, payload_json FROM run_context_snapshots WHERE attempt_id = ?').get(process.argv[3])
const payload = JSON.parse(row.payload_json)
console.log(JSON.stringify({
  stored: row.snapshot_hash,
  independent: computeSnapshotHash({ ...payload, snapshotHash: undefined }),
  verify: verifySnapshotHash(payload) === true,
  // 规范化文本的长度与摘要：两个进程连"规范形式"本身都该一致
  canonicalLen: snapshotCanonicalJson(payload).length,
}))
`
    const outs = [0, 1, 2].map((i) => runChild(`recompute-${i}.mjs`, childSrc, [dbFile, attemptId]))
    for (const [i, o] of outs.entries()) {
      assert.equal(o.stored, storedHash, `第 ${i} 个进程看到的存储哈希必须相同`)
      assert.equal(o.verify, true, `第 ${i} 个进程独立验哈希必须通过`)
      assert.equal(o.independent, storedHash,
        `第 ${i} 个进程**独立重算**的哈希必须相同——只验 payload 自带的字段等于自证自洽`)
    }
    assert.equal(new Set(outs.map((o) => o.canonicalLen)).size, 1,
      '三个进程算出的规范化文本长度也必须一致')
  } finally { undo() }
})

test('★★ 两次**独立种子**的运行不会同哈希——而原因必须被钉住（是内容里的时间戳）', async () => {
  // ## 为什么这条要写成"必须不同"
  //
  // 一个很自然但**错误**的期待是："同样的标题、同样的描述、同样的任务号、
  // 同样的冻结时刻 → 同一个哈希"。
  //
  // 实测不是。原因不是装配器不确定，而是**输入本身不同**：
  // hub 给的任务对象带着自己的 `createdAt`/`updatedAt`，
  // 而它们进了来源的 `content`（快照要固定"模型当时看到了什么"，
  // 时间戳当然算它看到的东西）。
  //
  //   > 一个"看起来输入一样"的用例，
  //   > 与一个"输入真的逐字节一样"的用例，是同一个东西——
  //   > 只不过前者会把一条正确的行为报成缺陷，或者更糟：
  //   > 把一条真的缺陷说成"时间戳导致的，正常"。
  //
  // 所以这里**不只断言不同**，还断言**不同在哪里**：
  // 把时间字段抹掉之后，两份正文必须逐字节相同。
  // 这样"不同"这件事就有了唯一解释，而不是一个可以随便解释的现象。
  const childSrc = `
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = ${J(ROOT.replace(/\\/g, '/'))}
const FROZEN = 1700000000000
const tmp = mkdtempSync(join(tmpdir(), 'det-'))
process.env.TEAM_HUB_DB = join(tmp, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import(pathToFileURL(ROOT + '/team-hub/server.mjs').href)
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() } }
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }

const { bindDshRuntime, productionExecutorProvider } = await import(pathToFileURL(ROOT + '/orchestrator/worker/executor-binding.mjs').href)
const undo = bindDshRuntime({
  host: { async probeRuntime() { return { ok: true, caps: {} } }, async startRun() { return { ok: true, outcome: 'completed' } } },
  selfCheck: async () => ({ ok: true, autoExecutionForbidden: false, reasons: [] }),
  canRead: () => ({ all: true }),
  // ★ 固定时钟：把"冻结时刻"这个变量排除掉，好让剩下的差异只有一个来源
  clock: () => FROZEN,
})
const prov = await productionExecutorProvider({ post, get, env: {} })
const c = await post('/api/create', { title: '确定的输入', description: '同样的描述', scope: 'default', acceptance: [], boundary: { do: [], dont: [] }, by: 'general' })
const taskId = c.body.task.id
const attemptId = 'att:' + taskId + ':1'
await prov.executor.buildContext({ attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1' })
const r = await get('/api/context-snapshots/' + encodeURIComponent(attemptId) + '?verify=1')
const s = r.body.snapshot
const task = s.sources.find((x) => x.type === 'task')
console.log(JSON.stringify({
  hash: r.body.snapshotHash,
  frozenAtMs: s.frozenAtMs,
  taskId,
  taskContent: task.content,
  trust: task.trust,
  sourceTypes: s.sources.map((x) => x.type).sort(),
}))
undo(); mod.server.closeAllConnections?.(); mod.server.close(); mod.db?.close?.(); rmSync(tmp, { recursive: true, force: true })
`
  const a = runChild('det-a.mjs', childSrc)
  const b = runChild('det-b.mjs', childSrc)

  assert.equal(a.frozenAtMs, 1700000000000, '注入的时钟必须真的生效（否则这条用例证明不了任何事）')
  assert.equal(a.taskId, b.taskId, '两次独立运行里的任务号应当相同（都是 T-001）')
  assert.deepEqual(a.sourceTypes, b.sourceTypes, '来源类型集合必须相同（差异不该来自"少了一类来源"）')
  assert.equal(a.trust, b.trust, '可信性必须相同')
  assert.notEqual(a.hash, b.hash,
    '两次独立种子的 hub 会给出不同的任务时间戳，因此哈希必须不同——'
    + '若这条开始失败，说明"输入相同"这个前提变了，下面那条解释也要跟着重审')

  // ★ 钉住差异的唯一来源：抹掉时间字段之后必须逐字节相同。
  //   这样"不同"就有了唯一解释，而不是一个可以随便解释的现象。
  //
  //   注意来源正文用的是装配器自己的 `stableRecord` 文本格式（`key: value`，
  //   **键没有引号**），不是 JSON——所以正则不能要求键被引号包住。
  //   写这一条时第一版就按 JSON 写了，于是它一个字符都没替换掉，
  //   而"两份正文不同"被报成了缺陷。一个**没生效的替换**，
  //   与一个"成因不止一个"的真结论，在失败信息里长得一模一样。
  const stripTimes = (s) => String(s)
    .replace(/(created|updated|finished|acquired|frozen|recorded)At[A-Za-z]*\s*:\s*("[^"]*"|\d+)/g, '$1At: 0')
  assert.notEqual(stripTimes(a.taskContent), a.taskContent,
    '抹时间这个动作必须真的改到了东西（否则下面那条断言是空的）')
  assert.equal(stripTimes(a.taskContent), stripTimes(b.taskContent),
    '把时间字段抹掉之后两份任务正文必须相同——否则"哈希不同"的成因不止时间戳一个，'
    + '而这条用例的结论就站不住了')
})

// ── ④ 反转换：改一个字节即冲突 ──────────────────────────────────────────

test('★ 反转换：跨进程改库里的一个字符，读回来即验不过', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '反转换', description: '原文' })
    const attemptId = `att:${taskId}:4`
    const { res } = await runOnceThroughProduction({ taskId, attemptId })
    assert.equal(res.body.verification.ok, true)

    runChild('tamper.mjs', `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2])
const row = db.prepare('SELECT payload_json FROM run_context_snapshots WHERE attempt_id = ?').get(process.argv[3])
const p = JSON.parse(row.payload_json)
const i = p.sources.findIndex((s) => s.type === 'task')
// 只改**一个字符**，而且不改 payload 里自带的 snapshotHash
p.sources[i].content = p.sources[i].content.replace('原文', '改过')
db.prepare('UPDATE run_context_snapshots SET payload_json = ? WHERE attempt_id = ?').run(JSON.stringify(p), process.argv[3])
console.log(JSON.stringify({ tampered: true }))
`, [dbFile, attemptId])

    const after = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
    const failed = after.status !== 200 || after.body?.ok !== true || after.body?.verification?.ok !== true
    assert.equal(failed, true,
      '改了一个字符之后必须验不过——一个对变化不敏感的哈希会让回放/去重/篡改检测同时静默失效，'
      + `而它在所有正向用例里都是"通过"。实际：${JSON.stringify(after.body).slice(0, 240)}`)
  } finally { undo() }
})

// ── ⑤ 越权：真实运行起点也挡住 ──────────────────────────────────────────

test('★ 越权：canRead 说全不可读时，真实运行起点下快照里不许有任何来源', async () => {
  resetDshRuntimeBinding()
  const undo = bindDshRuntime({
    host: {
      async probeRuntime() { return { ok: true, caps: {} } },
      async startRun() { return { ok: true, outcome: 'completed' } },
    },
    selfCheck: async () => ({ ok: true, autoExecutionForbidden: false, reasons: [] }),
    canRead: () => ({ all: false }),
  })
  try {
    const taskId = await seedTask({ title: '越权' })
    const provider = await productionExecutorProvider({ post, get, env: {} })
    assert.equal(provider.ok, true)
    const attemptId = `att:${taskId}:5`

    let threw = null
    try {
      await provider.executor.buildContext({
        attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1',
      })
    } catch (e) { threw = e }

    const res = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
    if (threw === null) {
      assert.equal(res.status, 200, '没抛错就必须留下一份快照')
      const sources = res.body?.snapshot?.sources ?? []
      assert.equal(sources.length, 0,
        `canRead 说全不可读时，快照里不许有任何来源。实际 ${sources.length} 条：`
        + sources.map((s) => s.type).join(','))
    } else {
      assert.equal(res.status, 404,
        '装配拒绝时不许留下半份快照——"先落库再报错"留下的记录看起来像一次正常的装配')
    }
  } finally { undo() }
})

// ── ⑥ 同一 Attempt 两个版本必须被拒（而不是"后写的赢"）───────────────────

test('★★ 同一 Attempt 用真实时钟装配两次 → 409，且**那一行不得被改动**', async () => {
  const undo = bindProduction()
  try {
    const taskId = await seedTask({ title: '不许两个版本' })
    const attemptId = `att:${taskId}:6`
    await runOnceThroughProduction({ taskId, attemptId })

    const before = mod.db.prepare(
      'SELECT snapshot_hash, frozen_at_ms FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    // ★ 比的是**变化量**，不是绝对值：同一个文件里的用例共用一个库，
    //   别的用例已经写过快照了。断言 COUNT == 1 会随用例数量变化而红，
    //   而那种红说明的是"这个文件里还有别的用例"，不是这里的缺陷。
    const rowsBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n

    // 真实时钟 → frozenAtMs 不同 → 哈希不同 → 库必须拒绝
    const provider = await productionExecutorProvider({ post, get, env: {} })
    await assert.rejects(
      () => provider.executor.buildContext({
        attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1',
      }),
      (e) => {
        assert.match(String(e?.message ?? e), /409|已有一份不同的上下文快照|CONFLICT/i,
          `同一 Attempt 的第二个版本必须被拒：${e?.message}`)
        return true
      },
      '同一次运行的上下文不可能有两个版本；"后写的赢"会让回放读到的那一份取决于时序',
    )

    // ★ "报错了"不等于"没动手"：必须确认那一行**逐字未变**
    const after = mod.db.prepare(
      'SELECT snapshot_hash, frozen_at_ms FROM run_context_snapshots WHERE attempt_id = ?').get(attemptId)
    assert.equal(after.snapshot_hash, before.snapshot_hash, '拒绝的那次不许改动已有的哈希')
    assert.equal(after.frozen_at_ms, before.frozen_at_ms, '拒绝的那次不许改动已有的冻结时刻')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n, rowsBefore,
      '不许留下第二行')
  } finally { undo() }
})
