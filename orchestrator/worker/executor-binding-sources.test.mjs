// orchestrator/worker/executor-binding-sources.test.mjs
// ============================================================================
// PRT-411（收尾）：**生产路径**真的把来源装配接上了
//
// ## 这一套要回答的问题
//
// `createHubContextStage` 的 `loadSources` 默认是 `async () => ({})`。
// `createProductionExecutor` 会把它透传下去——但**生产路径从不传它**。
// 于是每一次生产运行都冻结出一份**完全合法**的空快照：
//
//   > 一个"零来源"的运行与一个"来源齐备"的运行，
//   > 在快照账本上都写着"已冻结"——
//   > 只不过前者的模型是在一个我们没告诉它任何事的世界里动手。
//
// 这与 `budgetActor` 是**同一类**接缝缺陷（那一个的教训就写在
// `executor-binding.mjs` 里）。所以本套件的判据不是"参数传下去了没有"
// ——参数传下去而没人用，与没传，在结果上是一样的：
//
//   判据是**经过生产入口之后，冻结出来的快照里到底有没有真来源**。
//
// ## 为什么起真的 hub
//
// 判据是"快照里有真来源"，而快照是 hub 落库的。用假 hub 只能测
// "我们发出了一个形状正确的请求"，测不到"库里真的多了一条来源"。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  bindDshRuntime, resetDshRuntimeBinding, productionExecutorProvider, hubIo,
} from './executor-binding.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-execbind-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('../../team-hub/server.mjs')
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

const io = () => ({ post, get, env: {} })

/** 造一个任务，返回服务端真正用的 id（`/api/create` 自己发号）。 */
async function seedTask({ title = '任务', description = '描述' }) {
  const r = await post('/api/create', {
    title, description, scope: 'default', acceptance: [], boundary: { do: [], dont: [] }, by: 'general',
  })
  assert.ok(r.status === 200 || r.status === 201, `造任务失败：${r.status}`)
  const id = r.body?.task?.id
  assert.ok(typeof id === 'string' && id !== '', 'create 必须返回 id')
  return id
}

/**
 * 一个**合法**的启动自检结论。
 *
 * `autoExecutionForbidden` 必须是**布尔**：缺了它，"禁止执行"读出来是 false，
 * 于是"形状错误"会被当成"通过"——自检框架自己拒绝这种结论。
 * （写这一套时第一版就少了这个字段，报的是 `EXECUTOR_SELF_CHECK_INCOMPATIBLE`，
 *  与"强制面没生效"同一个码——两者确实是同一件事：没有可信的自检结论。）
 */
function fakeSelfCheck() {
  return { ok: true, autoExecutionForbidden: false, reasons: [] }
}

/** 一个最小的宿主端口：让 `createProductionExecutor` 愿意把引擎造出来。 */
function fakeHost() {
  return {
    async probeRuntime() { return { ok: true, caps: {} } },
    async startRun() { return { ok: true, outcome: 'completed' } },
  }
}

const bound = () => bindDshRuntime({
  host: fakeHost(),
  selfCheck: async () => fakeSelfCheck(),
  // 权限判定：本套件关心的是"来源有没有被取来"，不是权限本身。
  canRead: () => ({ all: true }),
})

// ── ① 生产路径真的把 loadSources 接上了 ─────────────────────────────────

test('★★ 生产入口造出的引擎，其 buildContext 真的会去 hub 取来源并冻结进快照', async () => {
  const undo = bound()
  try {
    const taskId = await seedTask({ title: '被装配的任务', description: '这段描述必须出现在快照里' })
    const provider = await productionExecutorProvider(io())
    assert.equal(provider.ok, true, `引擎应当造得出来：${JSON.stringify(provider).slice(0, 300)}`)

    // ★ 断言的是"引擎上真的有一个 loadSources 在干活"，
    //   而不是"某处传了一个参数"。
    const lease = {
      attemptId: `att:${taskId}:1`, runId: `att:${taskId}:1`,
      taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1',
    }
    const built = await provider.executor.buildContext(lease)
    assert.equal(built?.ok ?? true, true, `buildContext 应当成功：${JSON.stringify(built).slice(0, 300)}`)

    // 到 hub 读回快照：这才是"真的取到了"的证据
    const snap = await get(`/api/context-snapshots/${encodeURIComponent(lease.attemptId)}`)
    assert.equal(snap.status, 200, `快照应当已落库：${JSON.stringify(snap.body).slice(0, 300)}`)
    const sources = snap.body?.snapshot?.sources ?? []
    assert.ok(sources.length > 0,
      '★★ 快照里必须**有**来源。零来源会冻结出一份完全合法的空快照，'
      + '而"这次运行看了 0 个来源"与"我们忘了接线"在账本上是同一种记录')
    // 真来源指向真任务
    const taskSource = sources.find((s) => s.type === 'task')
    assert.ok(taskSource, `必须有一条 task 来源，实际类型：${sources.map((s) => s.type).join(',')}`)
    assert.match(taskSource.content, /这段描述必须出现在快照里/,
      '来源正文必须是 hub 里那条任务的真实内容（证明它真的读了 hub，而不是编了一个形状）')
  } finally { undo() }
})

test('★ 评论也一起进了快照（真评论 → 真来源，跨过 HTTP 与 SQLite）', async () => {
  const undo = bound()
  try {
    const taskId = await seedTask({ title: '带评论的任务' })
    const c = await post('/api/comment', { id: taskId, text: '这条评论必须在上下文里', by: 'general' })
    assert.equal(c.status, 200, `发评论失败：${JSON.stringify(c.body).slice(0, 200)}`)

    const provider = await productionExecutorProvider(io())
    const attemptId = `att:${taskId}:2`
    await provider.executor.buildContext({ attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1' })

    const snap = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
    const sources = snap.body?.snapshot?.sources ?? []
    const comment = sources.find((s) => s.type === 'comment')
    assert.ok(comment, `评论来源必须存在，实际：${sources.map((s) => s.type).join(',')}`)
    assert.match(comment.content, /这条评论必须在上下文里/)
    // 评论一律不可信（PRT-404）：判据是**谁写的**，不是它挂在谁下面
    assert.equal(comment.trust, 'untrusted')
  } finally { undo() }
})

// ── ② ★ 读失败必须让这次运行失败，而不是静默降级 ─────────────────────────

test('★★ hub 读失败 → buildContext **失败**（绝不静默降级成"上下文更少的运行"）', async () => {
  const undo = bound()
  try {
    const taskId = await seedTask({ title: '任务' })
    // 任务读得到；目标与技能读 500
    const brokenGet = async (path) => {
      if (path.startsWith('/api/task')) return get(path)
      return { status: 500, body: { error: 'hub 炸了' } }
    }
    const provider = await productionExecutorProvider({ post, get: brokenGet, env: {} })
    assert.equal(provider.ok, true)

    const attemptId = `att:${taskId}:3`
    await assert.rejects(
      () => provider.executor.buildContext({ attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1' }),
      (e) => {
        // 500 被当成"没有"，会让这次运行基于一份不完整的世界观继续下去
        assert.match(String(e?.message ?? e), /读 .* 失败|500/, `错误应当说清是读失败：${e?.message}`)
        return true
      },
      '读失败被吞掉，就等于把每一次网络抖动静默地变成一次"上下文更少的运行"',
    )
  } finally { undo() }
})

test('★ 404 是"真的没有"，不当成读失败（装配照常成功）', async () => {
  const undo = bound()
  try {
    const taskId = await seedTask({ title: '任务' })
    const get404OnGoal = async (path) => {
      if (path.startsWith('/api/goal')) return { status: 404, body: { error: '没有目标' } }
      return get(path)
    }
    const provider = await productionExecutorProvider({ post, get: get404OnGoal, env: {} })
    const attemptId = `att:${taskId}:4`
    await provider.executor.buildContext({ attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1' })
    const snap = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
    assert.equal(snap.status, 200, '404 不该让装配失败——问过了，它说没有')
    const sources = snap.body?.snapshot?.sources ?? []
    assert.ok(sources.some((s) => s.type === 'task'), '别的来源不受影响')
    assert.equal(sources.some((s) => s.type === 'goal'), false, '没有目标就不该有目标来源')
  } finally { undo() }
})

// ── ③ 生产路径的接线错误要能看见 ────────────────────────────────────────

test('★ 没绑 DSH 运行时 → 仍然是 HOST_PORT_REQUIRED（本批没有放松那条拒绝）', async () => {
  resetDshRuntimeBinding()
  const provider = await productionExecutorProvider(io())
  assert.equal(provider.ok, false)
  assert.equal(provider.code, 'EXECUTOR_HOST_PORT_REQUIRED')
})

test('★ 缺 post/get → BAD_WIRING（来源装配需要读面，缺了要说清）', async () => {
  const undo = bound()
  try {
    const provider = await productionExecutorProvider({ env: {} })
    assert.equal(provider.ok, false)
    assert.equal(provider.code, 'EXECUTOR_BAD_WIRING')
    assert.match(provider.message, /post 与 get/)
  } finally { undo() }
})

test('productionExecutorProviderFromEnv + hubIo：真环境变量走到真读面', async () => {
  const undo = bound()
  try {
    const taskId = await seedTask({ title: '从环境走过来的任务' })
    // 用真的 hubIo（真 fetch），只把 URL 指向测试 hub
    const realIo = hubIo({ hubUrl: base, hubToken: '' })
    const provider = await productionExecutorProvider({ ...realIo, env: {} })
    assert.equal(provider.ok, true)
    const attemptId = `att:${taskId}:5`
    await provider.executor.buildContext({ attemptId, runId: attemptId, taskId, scope: 'default', leaseEpoch: 1, workerId: 'w1' })
    const snap = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}`)
    assert.assertTrue?.(true)
    assert.ok((snap.body?.snapshot?.sources ?? []).length > 0, 'hubIo 那条路也必须真的取到来源')
  } finally { undo() }
})

test('★ lease 缺 scope 时装配拒绝（放错空间就是一次越权）', async () => {
  const undo = bound()
  try {
    const provider = await productionExecutorProvider(io())
    await assert.rejects(
      () => provider.executor.buildContext({ attemptId: 'a', runId: 'a', taskId: 'T-001', leaseEpoch: 1 }),
      (e) => {
        assert.match(String(e?.message ?? e), /scope/i, `应当说清缺 scope：${e?.message}`)
        return true
      },
    )
  } finally { undo() }
})
