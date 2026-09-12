// team-hub/run-kill-drill.test.mjs
// ============================================================================
// PRT-312：**强制终止** worker 后的整链路演练
//
// 阶段 3 的完成标准（spec 第 885 行）逐字是：
//   强制终止 worker 或 DSH 后，重启不会丢任务、伪装成功或重复执行已确认的外部写操作。
//
// 这条标准只能用**真实进程 + 真实强杀**来验。之前的用例（run-plane-e2e）
// 已经覆盖了"崩后回收"的调用路径，但它们都是在同一个进程里调用
// `recoverExpired`——也就是说，它们验证的是"回收函数写对了"，
// 而不是"一个进程真的被杀掉之后，磁盘上留下的东西会让回收做出正确的判断"。
// 两者的差别正是这条标准要问的东西。
//
// 本文件里被杀的是 `orchestrator/worker/scripts/kill-drill-worker.mjs`
// 起来的**真进程**，它对真 team-hub 说话、写真的状态文件、写真的 marker 文件。
//
// 三条判据：
//   ① 不丢任务   —— 在外部写边界**之前**被杀：回收新建 Attempt，任务最终跑完
//   ② 不伪装成功 —— 被杀之后，那条 Attempt 不能是 Completed；状态文件必须过期
//   ③ 不重复外部写 —— 在外部写边界**之后**被杀：回收进 UnknownOutcome 等人工，
//                      marker 文件里"外部写"的记录必须**恰好一条**
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isStatusFresh, readStatusFile, STATUS_RELPATH } from '../orchestrator/worker/status-file.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DRILL_WORKER = join(ROOT, 'orchestrator', 'worker', 'scripts', 'kill-drill-worker.mjs')

// 与 run-plane-e2e 同样的理由：全局 fetch 的 undici 连接池会在
// `closeAllConnections()` 之后留下永久 keep-alive socket，让 `node --test` 卡住不退出。
function unpooledFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, json: async () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

const TOKEN = 'drill-token'
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-drill-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = TOKEN
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

async function api(path, body) {
  const res = await unpooledFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined
      ? { authorization: `Bearer ${TOKEN}` }
      : { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * 让库里**只剩**这一条待办任务。
 *
 * 这个文件是有状态的（一个真实库），而领取取队首。不清理时
 * 「我的 worker 会领到 drill-x」这个假设会被前面用例留下的 todo 打破——
 * 表现为"trace 里没有我要的阶段"，而原因与强杀毫无关系。
 */
function onlyTask(id, scope = 'default') {
  const now = new Date().toISOString()
  mod.db.prepare("UPDATE tasks SET status = 'done' WHERE id != ?").run(id)
  mod.db.prepare(
    'INSERT OR REPLACE INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,0,?,?)',
  ).run(id, id, 'medium', 'todo', scope, now, now)
  return id
}

/** 读 marker 文件里的记录行。 */
function markerLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

/** 等一个条件成立（带超时）。返回是否成立，不抛错——判据由调用方给出。 */
async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 起一个真实 worker 进程，等 `ready` 成立后**强杀**它。
 *
 * 强杀用的是 `child.kill('SIGKILL')`。在 Windows 上 Node 把 SIGKILL 映射成
 * 无条件终止（TerminateProcess），而在 POSIX 上它是不可捕获的——两种平台下
 * 接收方的信号处理器都不会被调用，这正是我们要复现的场景：
 * **优雅停止路径一次都没走**，lease 没有被释放，状态文件停在最后一刻的值。
 */
async function spawnAndKill({ taskId, blockIn, blockMs = 30000, markerName, ready }) {
  const dataDir = join(tmpRoot, `data-${markerName}`)
  const marker = join(tmpRoot, `${markerName}.jsonl`)
  mkdirp(dataDir)
  const child = spawn(process.execPath, [DRILL_WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LEGION_DATA_DIR: dataDir,
      TEAM_HUB_URL: base,
      TEAM_HUB_TOKEN: TOKEN,
      DRILL_MARKER: marker,
      DRILL_BLOCK_IN: blockIn,
      DRILL_BLOCK_MS: String(blockMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (c) => logs.push(c.toString('utf8')))
  child.stderr.on('data', (c) => logs.push(c.toString('utf8')))

  const ok = await waitFor(() => ready({ child, marker, dataDir, logs }))
  assert.ok(ok, `worker 没有在超时内达到预期状态（强杀之前）。日志：\n${logs.join('')}`)

  child.kill('SIGKILL')
  const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
  return { child, marker, dataDir, logs: logs.join(''), exit }
}

function mkdirp(p) {
  mkdirSync(p, { recursive: true })
}

/** 库里某条任务的尝试历史（按 attempt_no 升序）。 */
function attemptsOf(taskId) {
  return mod.db.prepare('SELECT * FROM run_attempts WHERE task_id = ? ORDER BY attempt_no').all(taskId)
}

/**
 * 把某条任务的租约改成"已过期"。
 *
 * **为什么直接改库而不是等**：默认租期是 120s，等它自然过期会让这个文件跑两分钟以上，
 * 而演练要验的是「租约已过期时回收会不会做对判断」，不是"120 秒到底有多长"
 * （TTL 本身的语义由 run-store 的用例覆盖）。
 *
 * 这一点必须写清楚，因为它是一个**测试替身**：真实场景里租约是因为
 * 持有者不再续约而自然过期的。这里我们只是把"时间到了"这个前提直接摆好，
 * 并且用下面那条"过期之前不许回收"的断言证明：回收确实是**由租约**驱动的，
 * 而不是简单地看状态就动手。
 */
function expireLease(taskId) {
  const past = Date.now() - 1000
  mod.db.prepare('UPDATE run_attempts SET lease_expires_at_ms = ? WHERE task_id = ?').run(past, taskId)
}

/**
 * 在回收结果里找某条任务的条目。
 *
 * 回收条目的形状是 `{ attemptId, action, ... }`（**没有** `taskId` 字段），
 * 而 attemptId 的格式是 `att:<taskId>:<attemptNo>`。用前缀匹配而不是猜字段名：
 * 猜字段名会得到 `undefined`，而 `undefined === undefined` 会让"没找到"看起来像"找到了"。
 */
function recoveredFor(body, taskId) {
  const prefix = `att:${taskId}:`
  return (body.recovered ?? []).filter((r) => typeof r.attemptId === 'string' && r.attemptId.startsWith(prefix))
}

/** 等某个 Attempt 进入指定状态之一。 */
function waitForAttemptState(taskId, states, timeoutMs = 15000) {
  return waitFor(() => {
    const rows = attemptsOf(taskId)
    return rows.some((r) => states.includes(r.state))
  }, { timeoutMs })
}

// ---------------------------------------------------------------- ① 不丢任务

test('① 在外部写边界**之前**强杀 worker：任务不丢，回收后新建 Attempt 并跑完', async () => {
  const taskId = onlyTask('drill-before')
  const markerName = 'before'
  const { marker, dataDir, exit } = await spawnAndKill({
    taskId, blockIn: 'prepareWorkspace', markerName,
    // 等它真的进到 prepareWorkspace（Attempt 已落库为 PreparingWorkspace）再杀。
    ready: () => waitForAttemptState(taskId, ['PreparingWorkspace']),
  })

  // 强杀成功：进程以信号/非零码结束，而不是"优雅退出"
  assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0,
    `应当是被强杀的，实际 code=${exit.code} signal=${exit.signal}`)

  // ---- 不伪装成功：那条 Attempt 绝不能是 Completed ----
  const before = attemptsOf(taskId)
  assert.equal(before.length, 1, '强杀时应当只有一条 Attempt')
  assert.notEqual(before[0].state, 'Completed',
    '被杀掉的执行绝不能是 Completed——"明明没做完却说成功"是这一批最不该出现的缺陷')
  assert.equal(before[0].state, 'PreparingWorkspace',
    '先落库意图再做副作用：被杀时应停在 PreparingWorkspace（它还没越过外部写边界）')
  assert.equal(before[0].finished_at_ms, null, '被杀时 Attempt 不得被写成已结束')

  // ---- 状态文件必须过期（Windows 上强杀不走信号处理器，文件停在最后一刻） ----
  const statusPath = join(dataDir, STATUS_RELPATH)
  const read = readStatusFile(statusPath)
  assert.equal(read.ok, true, '被杀之前状态文件应当已经写过')
  const fresh = isStatusFresh(read.status, { now: Date.now() + 60000 })
  assert.equal(fresh.fresh, false,
    '强杀之后状态文件必须判为**不新鲜**：文件存在与 worker 还活着是两件事，混为一谈会让外部以为它还在跑')
  assert.match(fresh.reason, /过期/)

  // ---- 回收：它停在 PreparingWorkspace（未越过外部写边界）→ 安全新建 Attempt ----
  //
  // 先证明回收**由租约驱动**而不是"看到 PreparingWorkspace 就动手"：
  // 被杀进程的租约此刻仍然有效（心跳间隔 10s，我们在几秒内就杀掉了它），
  // 因此回收必须**拒绝抢占**——抢占一个可能还活着的持有者会让同一条任务被执行两次。
  const notYet = await api('/api/runtime/recover', { externalEffectPossibleStates: ['Running', 'HandingOff'] })
  assert.equal(recoveredFor(notYet.body, taskId).length, 0,
    '租约仍有效时不得回收：抢占一个可能还活着的 worker 正是「同一任务被执行两次」的来源')

  expireLease(taskId)
  const rec = await api('/api/runtime/recover', {
    externalEffectPossibleStates: ['Running', 'HandingOff'],
  })
  assert.equal(rec.status, 200, `回收失败：${JSON.stringify(rec.body)}`)
  const entry = recoveredFor(rec.body, taskId)[0]
  assert.ok(entry !== undefined, `回收结果里没有这条任务：${JSON.stringify(rec.body.recovered)}`)
  assert.equal(entry.action, 'retry-new-attempt',
    '未越过外部写边界的中断必须能安全重试——判成"未知"会让本可自动恢复的任务永远挂起')
  assert.equal(entry.attemptsUsed, 1)

  // 历史 Attempt 保留下来（身份、尝试号、失败原因都在），并**被结算**为失败。
  //
  // 注意这里不是"状态不变"：一条租约过期、停在 PreparingWorkspace 的 Attempt
  // 如果原样留着，下一次恢复扫描会**再**把它当成在飞的执行处理一遍——
  // 于是每扫一次就多一次"回收"，而每一次都可能新建 Attempt。
  // 「不可覆盖」说的是这条记录不会被删掉或改写成另一次尝试，
  // 而不是说它的状态不再推进。
  const afterRecover = attemptsOf(taskId)
  assert.equal(afterRecover.length, 2, '回收应新建第二条 Attempt，并保留第一条历史')
  assert.equal(afterRecover[0].id, before[0].id, '历史 Attempt 的身份不得被改写')
  assert.equal(afterRecover[0].attempt_no, 1)
  assert.equal(afterRecover[0].state, 'RetryableFailure',
    '被中断的那次执行要**结算**成失败，否则下次扫描会把它再回收一遍')
  assert.notEqual(afterRecover[0].state, 'Completed', '它没有完成')
  assert.equal(afterRecover[1].state, 'Queued')

  // 回收是幂等的：再扫一次不得凭空多出 Attempt
  const again = await api('/api/runtime/recover', { externalEffectPossibleStates: ['Running', 'HandingOff'] })
  assert.equal(recoveredFor(again.body, taskId).length, 0,
    '刚回收过的 Attempt 不得被反复回收——那会每次扫描都新建一条 Attempt')
  assert.equal(attemptsOf(taskId).length, 2)

  // ---- 另一个 worker 接手并执行完 ----
  //
  // 注意「执行成功」的落点是 `Validating` 而不是 `Completed`：
  // 机器验收（PRT-307）是执行成功之后的一道独立关卡，本批次未交付，
  // 因此没有东西会把 Attempt 从 `Validating` 推到 `Completed`。
  // 这里断言 `Validating` 是**如实**的做法——若断言 `Completed`，
  // 要么会得到一条永远等不到的用例，要么会诱使实现把"执行完"直接写成"已完成"，
  // 而后者正是"伪装成功"。
  const marker2 = join(tmpRoot, 'before-resume.jsonl')
  const dataDir2 = join(tmpRoot, 'data-before-resume')
  mkdirp(dataDir2)
  const child = spawn(process.execPath, [DRILL_WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LEGION_DATA_DIR: dataDir2, TEAM_HUB_URL: base, TEAM_HUB_TOKEN: TOKEN,
      DRILL_MARKER: marker2, DRILL_BLOCK_IN: 'none', DRILL_BLOCK_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs2 = []
  child.stdout.on('data', (c) => logs2.push(c.toString('utf8')))
  child.stderr.on('data', (c) => logs2.push(c.toString('utf8')))
  const done = await waitFor(() => attemptsOf(taskId).some((r) => r.state === 'Validating'), { timeoutMs: 25000 })
  child.kill('SIGKILL')
  assert.ok(done, `接手的 worker 没有把任务执行完。日志：\n${logs2.join('')}`)

  const final = attemptsOf(taskId)
  assert.equal(final.length, 2, '不该再多出 Attempt')
  assert.equal(final[1].state, 'Validating',
    '执行成功 → 待机器验收（PRT-307 未交付，因此不会自动到 Completed）')
  assert.equal(final[1].attempt_no, 2)
  assert.equal(final[1].failure_code, null, '成功的那条不该带失败码')
  assert.equal(final[1].detail, `drill-ok:${final[1].id}`)
  // 任务不再需要人处理，也不再挂着
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId).status, 'in_review')
  assert.equal((await api('/api/runtime/held')).body.items.filter((i) => i.taskId === taskId).length, 0)
  // 幂等键跨尝试稳定
  assert.equal(final[0].idempotency_key, final[1].idempotency_key,
    '重试必须复用同一个幂等键，否则外部系统无法判断这是同一次操作的重试')

  // 外部写**恰好在第二条 Attempt 上发生一次**：第一条死在 prepareWorkspace，
  // 根本没走到 execute。这是"不丢任务"与"不重复外部写"同时成立的证据。
  const writes = markerLines(marker2).filter((l) => l.kind === 'external-write')
  assert.equal(writes.length, 1, `接手后应当恰好发生一次外部写，实际 ${writes.length}`)
  const killedWorkerWrites = markerLines(marker).filter((l) => l.kind === 'external-write')
  assert.equal(killedWorkerWrites.length, 0,
    '被杀的那次执行停在 prepareWorkspace，不可能发生过外部写')
})

// ---------------------------------------------------------------- ③ 不重复外部写

test('③ 在外部写边界**之后**强杀 worker：回收进 UnknownOutcome 等人工，外部写恰好一次', async () => {
  const taskId = onlyTask('drill-after')
  const markerName = 'after'
  const { marker, exit } = await spawnAndKill({
    taskId, blockIn: 'execute', markerName,
    // 等它写进 marker（外部写已发生）且 Attempt 已到 Running。
    ready: async ({ marker: m }) => {
      const wrote = existsSync(m) && readFileSync(m, 'utf8').includes('external-write')
      return wrote && attemptsOf(taskId).some((r) => r.state === 'Running')
    },
  })
  assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0)

  const before = attemptsOf(taskId)
  assert.equal(before.length, 1)
  assert.equal(before[0].state, 'Running', '强杀时应停在 Running——它已经越过外部写边界')
  assert.notEqual(before[0].state, 'Completed')

  // 外部写确实发生过（marker 是唯一证据）
  const wroteByKilled = markerLines(marker).filter((l) => l.kind === 'external-write')
  assert.equal(wroteByKilled.length, 1, '前提：被杀之前它已经写过一次外部系统')

  // ---- 回收：Running 已越过外部写边界 → 必须进 UnknownOutcome，绝不自动重试 ----
  // 同样先确认租约有效时不会被抢占。
  const notYet = await api('/api/runtime/recover', { externalEffectPossibleStates: ['Running', 'HandingOff'] })
  assert.equal(recoveredFor(notYet.body, taskId).length, 0,
    '租约仍有效时不得回收')

  expireLease(taskId)
  const rec = await api('/api/runtime/recover', { externalEffectPossibleStates: ['Running', 'HandingOff'] })
  assert.equal(rec.status, 200)
  const entry = recoveredFor(rec.body, taskId)[0]
  assert.ok(entry !== undefined, `回收结果里没有这条任务：${JSON.stringify(rec.body.recovered)}`)
  assert.equal(entry.action, 'mark-unknown-outcome',
    '已越过外部写边界的中断**绝不能**判成可重试——那会把一次已经发生的付费/推送再做一遍')

  // 没有新建 Attempt，且那条 Attempt 真的进了 UnknownOutcome
  assert.equal(attemptsOf(taskId).length, 1, 'UnknownOutcome 不得自动新建 Attempt')
  assert.equal(attemptsOf(taskId)[0].state, 'UnknownOutcome')

  // 它出现在等人工清单里（否则"不静默重跑"会变成"静默消失"）
  const held = await api('/api/runtime/held')
  const inHeld = held.body.items.filter((i) => i.taskId === taskId)
  assert.equal(inHeld.length, 1, `挂起的任务必须能从界面找到：${JSON.stringify(held.body.items)}`)
  assert.equal(inHeld[0].state, 'UnknownOutcome')
  assert.equal(inHeld[0].isLatest, true)

  // ---- 再起两个 worker，让它们跑一会儿：不得有任何一次新的外部写 ----
  const marker2 = join(tmpRoot, 'after-idle.jsonl')
  const kids = [0, 1].map((i) => {
    const dataDir = join(tmpRoot, `data-after-idle-${i}`)
    mkdirp(dataDir)
    const child = spawn(process.execPath, [DRILL_WORKER], {
      cwd: ROOT,
      env: {
        ...process.env,
        LEGION_DATA_DIR: dataDir, TEAM_HUB_URL: base, TEAM_HUB_TOKEN: TOKEN,
        DRILL_MARKER: marker2, DRILL_BLOCK_IN: 'none', DRILL_BLOCK_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    return child
  })
  // 给它们足够时间跑几轮认领（队列里只剩这一条挂起任务，若回收判错它们会立刻领走）
  await new Promise((r) => setTimeout(r, 3000))
  for (const k of kids) k.kill('SIGKILL')

  const totalWrites = markerLines(marker).concat(markerLines(marker2)).filter((l) => l.kind === 'external-write')
  assert.equal(totalWrites.length, 1,
    `外部写必须恰好一次（含两次 worker 反复认领之后）。实际 ${totalWrites.length} 次：` +
    '多出来的每一次都是对已生效外部操作的重复执行')
  assert.equal(attemptsOf(taskId).length, 1, '挂起的任务仍不得被自动新建 Attempt')

  // ---- 人工对账后：确认已发生 → 按成功走验收，且仍然不重跑 ----
  const resolved = await api('/api/runtime/resolve', {
    attemptId: before[0].id, decision: 'external-effect-happened', actor: 'oncall', note: '对账单显示已扣费',
  })
  assert.equal(resolved.status, 200, `处置失败：${JSON.stringify(resolved.body)}`)
  assert.equal(resolved.body.attempt.state, 'Validating')
  assert.equal(resolved.body.attempt.externalEffect, 'confirmed')
  assert.equal(attemptsOf(taskId).length, 1, '人工确认"已发生"之后也不得新建 Attempt——那正是"绝不重跑"')

  const finalWrites = markerLines(marker).concat(markerLines(marker2)).filter((l) => l.kind === 'external-write')
  assert.equal(finalWrites.length, 1, '整条链路自始至终只有一次外部写')
})
