// product/upgrade/task-readings.test.mjs
// ============================================================================
// 在途任务**生产端**的回归
//
// 这个文件守的核心判据只有一条，但它是升级安全性的分水岭：
//
//     **"读不到" 绝不能变成 "没有在途任务"。**
//
// `runPreflight` 对 `tasks: null` 判 `unknown`（拦），对 `[]` 判 `ok`（放行）。
// 一个 `catch { return [] }` 就会让升级在**任务正在跑**的时候认为环境是干净的。
// 所以每一种失败（超时、非 200、不是 JSON、形状不对、连不上、没有端口）
// 都被逐一验证为 `ok: false`，且**不带** `tasks` 字段。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_BOARD_TIMEOUT_MS, MAX_BOARD_BYTES, TASK_READINGS_CHECKED, TASK_READING_SOURCES,
  hubBaseUrlFromStatus, readBoardTasks, readPendingTasksFromLauncher,
} from './task-readings.mjs'
import { checkInFlightTasks } from './preflight.mjs'

const BASE = 'http://127.0.0.1:8787'

function fetchReturning(body, { status = 200 } = {}) {
  return async () => ({ status, async text() { return body } })
}

function board(tasks) {
  return JSON.stringify(tasks)
}

// ---------------------------------------------------------------------------
// ① 基地址来自真实读数
// ---------------------------------------------------------------------------

test('★ team-hub 基地址取自 Launcher 的进程读数（不猜默认端口）', () => {
  assert.equal(hubBaseUrlFromStatus({ processes: [{ key: 'team-hub', port: 8787 }] }), BASE)
  assert.equal(hubBaseUrlFromStatus({ processes: [{ key: 'team-hub', port: 9000 }] }), 'http://127.0.0.1:9000')
  // 缺读数 / 非法端口 → null（而不是回落到默认端口）。
  for (const status of [null, {}, { processes: [] },
    { processes: [{ key: 'workbench', port: 5173 }] },
    { processes: [{ key: 'team-hub', port: 0 }] },
    { processes: [{ key: 'team-hub', port: 65536 }] },
    { processes: [{ key: 'team-hub', port: '8787' }] }]) {
    assert.equal(hubBaseUrlFromStatus(status), null, `${JSON.stringify(status)} 求出了基地址`)
  }
})

test('★ 非回环基地址一律拒绝', async () => {
  for (const url of ['http://evil.example:80', 'https://127.0.0.1:8787', 'http://0.0.0.0:8787', 'file:///x']) {
    const r = await readBoardTasks({ baseUrl: url, fetchImpl: fetchReturning('[]') })
    assert.equal(r.ok, false, `${url} 被接受了`)
    assert.match(r.reason, /回环/)
  }
})

// ---------------------------------------------------------------------------
// ② 正常读数
// ---------------------------------------------------------------------------

test('★ 正常看板：status 字段被映射成 state，并给出摘要与来源', async () => {
  const r = await readBoardTasks({
    baseUrl: BASE,
    fetchImpl: fetchReturning(board([
      { id: 't-1', status: 'done' },
      { id: 't-2', status: 'in_progress' },
      { id: 't-3', status: 'todo' },
    ])),
  })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.total, 3)
  assert.equal(r.source, TASK_READING_SOURCES.BOARD)
  assert.deepEqual(r.tasks.map((t) => [t.id, t.state]), [
    ['t-1', 'done'], ['t-2', 'in_progress'], ['t-3', 'todo'],
  ])
  assert.match(r.summary, /1 个在途/)
  assert.ok(Number.isSafeInteger(r.observedAtMs))
})

test('★ 端到端：真实的看板读数喂进预检，结论正确', async () => {
  // 全做完 → 放行（这是那个缺陷的复现形态）。
  const quiet = await readBoardTasks({
    baseUrl: BASE,
    fetchImpl: fetchReturning(board([
      { id: 't-1', status: 'done' }, { id: 't-2', status: 'canceled' }, { id: 't-3', status: 'blocked' },
    ])),
  })
  assert.equal(quiet.ok, true)
  assert.equal(checkInFlightTasks({ tasks: quiet.tasks }).verdict, 'ok',
    '一整份做完了的看板把升级拦住了')

  // 有一个在跑 → 拦，且点名的是**那个**在跑的。
  const busy = await readBoardTasks({
    baseUrl: BASE,
    fetchImpl: fetchReturning(board([
      { id: 't-1', status: 'done' }, { id: 't-9', status: 'in_progress' },
    ])),
  })
  const verdict = checkInFlightTasks({ tasks: busy.tasks })
  assert.equal(verdict.verdict, 'blocked')
  assert.deepEqual([...verdict.activeIds], ['t-9'])
})

test('★ 空看板是合法读数：与"读不到"是两件事', async () => {
  const r = await readBoardTasks({ baseUrl: BASE, fetchImpl: fetchReturning('[]') })
  assert.equal(r.ok, true)
  assert.equal(r.total, 0)
  assert.equal(r.summary, '没有任务')
  // 喂进预检 → 放行（真的没有任务）。
  assert.equal(checkInFlightTasks({ tasks: r.tasks }).verdict, 'ok')
})

// ---------------------------------------------------------------------------
// ③ 失败一律是"没读到"
// ---------------------------------------------------------------------------

test('★★★ 每一种失败都必须 `ok: false` 且**不带** tasks 字段', async () => {
  const cases = [
    ['HTTP 500', { fetchImpl: fetchReturning('', { status: 500 }) }],
    ['HTTP 401', { fetchImpl: fetchReturning('', { status: 401 }) }],
    ['响应体不是 JSON', { fetchImpl: fetchReturning('not json') }],
    ['形状不对（对象里没有 tasks）', { fetchImpl: fetchReturning('{"nope":1}') }],
    ['形状不对（null）', { fetchImpl: fetchReturning('null') }],
    ['连不上', { fetchImpl: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) } }],
    ['响应不是对象', { fetchImpl: async () => null }],
  ]
  for (const [name, options] of cases) {
    const r = await readBoardTasks({ baseUrl: BASE, ...options })
    assert.equal(r.ok, false, `「${name}」没有被判为失败`)
    assert.equal(r.tasks, undefined, `「${name}」返回了 tasks：读不到不能被说成没有任务`)
    assert.equal(typeof r.reason, 'string')
  }
})

test('★★ 失败的读数喂进预检 → `unknown`（拦），不是 `ok`', async () => {
  const r = await readBoardTasks({ baseUrl: BASE, fetchImpl: fetchReturning('', { status: 500 }) })
  assert.equal(r.ok, false)
  // 调用方的折法：读不到 → null。
  const verdict = checkInFlightTasks({ tasks: null })
  assert.equal(verdict.verdict, 'unknown', '读不到被折成了"没有在途任务"')
})

test('★ 超时必须自己了结（不能挂住升级路径）', async () => {
  const started = Date.now()
  const r = await readBoardTasks({
    baseUrl: BASE,
    timeoutMs: 40,
    fetchImpl: async (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /超时/)
  assert.ok(Date.now() - started < 3000, '超时没有及时了结')
})

test('★ 响应体上限：一个超大看板被拒而不是读进内存', async () => {
  const huge = `[${'x'.repeat(MAX_BOARD_BYTES + 10)}]`
  const r = await readBoardTasks({ baseUrl: BASE, fetchImpl: fetchReturning(huge) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /超过上限/)
})

// ---------------------------------------------------------------------------
// ④ 凭据与一步到位
// ---------------------------------------------------------------------------

test('★ 有 token 就带上（回环下不需要，但监听地址改变时要有）', async () => {
  let seen = null
  await readBoardTasks({
    baseUrl: BASE, token: 'hub-secret',
    fetchImpl: async (url, options) => { seen = options.headers; return { status: 200, async text() { return '[]' } } },
  })
  assert.equal(seen.authorization, 'Bearer hub-secret')
  assert.equal(seen.accept, 'application/json')

  // 没有 token 时不带 authorization 头（而不是带一个空串）。
  let without = null
  await readBoardTasks({
    baseUrl: BASE,
    fetchImpl: async (url, options) => { without = options.headers; return { status: 200, async text() { return '[]' } } },
  })
  assert.equal('authorization' in without, false)
})

test('★ 一步到位：没有 team-hub 端口时失败，而不是报空', async () => {
  const r = await readPendingTasksFromLauncher({ processes: [{ key: 'workbench', port: 5173 }] })
  assert.equal(r.ok, false)
  assert.equal(r.tasks, undefined)
  assert.match(r.reason, /port|端口/)

  const ok = await readPendingTasksFromLauncher(
    { processes: [{ key: 'team-hub', port: 8787 }] },
    { fetchImpl: fetchReturning(board([{ id: 't', status: 'done' }])) },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.total, 1)
})

test('默认超时是有限的（升级路径上不能无限等）', () => {
  assert.ok(Number.isSafeInteger(DEFAULT_BOARD_TIMEOUT_MS))
  assert.ok(DEFAULT_BOARD_TIMEOUT_MS > 0 && DEFAULT_BOARD_TIMEOUT_MS <= 30_000)
})

test('模块自检全绿', () => {
  assert.deepEqual([...TASK_READINGS_CHECKED.problems], [])
  assert.equal(TASK_READINGS_CHECKED.ok, true)
})

// ---------------------------------------------------------------------------
// ⑤ 真实 team-hub 上跑一次（合成响应只能证明"判据自洽"）
// ---------------------------------------------------------------------------

/**
 * 起一个**真的** team-hub，用真实生产端读它的看板。
 *
 * 这一条要回答的是合成响应回答不了的三件事：
 *
 *   ① `/api/board` 在**回环**下到底要不要 token
 *      （`server.mjs` 的注释说不要，而 `desktop-security.test.mjs` 里
 *      `/api/spaces` 无 auth 却拿到 401 —— 两处说法需要实测来对齐）；
 *   ② 响应体到底是**顶层数组**还是 `{tasks:[…]}`（`boardTasksFromPayload`
 *      两种都认，但认哪一种决定了真实部署走哪条分支）；
 *   ③ 字段名是 `status` 还是 `state`（归一化两种都认，但同上）。
 *
 * 起不来就跳过：这条用例要的是"能起的时候必须通"，而不是把环境依赖
 * 变成红灯——产品里真正必须成立的那两条（读不到 ≠ 没有、在跑必须拦）
 * 由上面的合成用例守着。
 */
test('★ 真实 team-hub：/api/board 的形状与真实生产端一致', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  let launcherModule
  let layoutModule
  let portsModule
  try {
    launcherModule = await import('../launcher/launcher.mjs')
    layoutModule = await import('../paths.mjs')
    portsModule = await import('../launcher/ports.mjs')
  } catch {
    t.skip('本环境缺少启动 team-hub 所需的模块')
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'legion-task-readings-'))
  const workspaceDir = join(root, 'workspace')
  mkdirSync(workspaceDir)
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const { layout } = layoutModule.resolveLayout({ installDir: repoRoot, homeDir: root, workspaceDir })
  const ports = { 'team-hub': await portsModule.reserveEphemeralPort() }
  const owner = launcherModule.createLauncher({
    layout, ports, include: ['team-hub'], baseEnv: process.env,
    desktopCredentials: { hub: 'probe-hub-token', workbench: 'probe-wb-token' },
  })
  t.after(async () => {
    try { await owner.stop({ graceMs: 1000 }) } catch { /* 收尾失败不该盖住断言 */ }
    rmSync(root, { recursive: true, force: true })
  })

  let started
  try {
    started = await owner.start()
  } catch (error) {
    t.skip(`本环境起不动 team-hub：${error?.message ?? error}`)
    return
  }
  if (started?.ok !== true) {
    t.skip(`本环境起不动 team-hub：${(started?.diagnostics ?? []).map((d) => d.code).join(',')}`)
    return
  }

  const baseUrl = `http://127.0.0.1:${ports['team-hub']}`

  // ① 回环无 auth：实测确认（这决定了真实部署要不要把 token 搬过去）。
  const anonymous = await fetch(`${baseUrl}/api/board`)
  assert.equal(anonymous.status, 200, '回环下读看板没有被放行')
  const anonymousBody = await anonymous.text()
  assert.equal(anonymousBody.trim().startsWith('['), true,
    `看板响应不是顶层数组，真实形状是：${anonymousBody.slice(0, 120)}`)

  // ② 真实生产端能读它。
  const reading = await readBoardTasks({ baseUrl })
  assert.equal(reading.ok, true, `真实生产端读不了真实看板：${reading.reason}`)
  assert.equal(reading.source, TASK_READING_SOURCES.BOARD)
  assert.ok(Array.isArray(reading.tasks))
  // 一个刚起、没有任务的 team-hub：读数必须是**空数组**（真的没有任务），
  // 而不是失败。这两种在预检那里结论相反。
  assert.equal(reading.total, 0)
  assert.equal(reading.summary, '没有任务')
  assert.equal(checkInFlightTasks({ tasks: reading.tasks }).verdict, 'ok')
})

test('★ 真实 team-hub：带 token 也照样读得到（监听地址改变时的路径）', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const { createLauncher } = await import('../launcher/launcher.mjs')
  const { resolveLayout } = await import('../paths.mjs')
  const { reserveEphemeralPort } = await import('../launcher/ports.mjs')

  const root = mkdtempSync(join(tmpdir(), 'legion-task-readings-token-'))
  const workspaceDir = join(root, 'workspace')
  mkdirSync(workspaceDir)
  const { layout } = resolveLayout({
    installDir: fileURLToPath(new URL('../../', import.meta.url)), homeDir: root, workspaceDir,
  })
  const ports = { 'team-hub': await reserveEphemeralPort() }
  const owner = createLauncher({
    layout, ports, include: ['team-hub'], baseEnv: process.env,
    desktopCredentials: { hub: 'probe-hub-token', workbench: 'probe-wb-token' },
  })
  t.after(async () => {
    try { await owner.stop({ graceMs: 1000 }) } catch { /* 同上 */ }
    rmSync(root, { recursive: true, force: true })
  })

  let started
  try { started = await owner.start() } catch (error) { t.skip(`起不动 team-hub：${error?.message ?? error}`); return }
  if (started?.ok !== true) { t.skip('起不动 team-hub'); return }

  const reading = await readBoardTasks({
    baseUrl: `http://127.0.0.1:${ports['team-hub']}`, token: 'probe-hub-token',
  })
  assert.equal(reading.ok, true, `带 token 反而读不了：${reading.reason}`)
  assert.equal(reading.total, 0)
})
