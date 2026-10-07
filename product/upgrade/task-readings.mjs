// product/upgrade/task-readings.mjs
// ============================================================================
// 任务读数的**生产端** —— 从本机 team-hub 读在途任务
//
// ## 为什么需要它
//
// `preflight.mjs` 的 `checkInFlightTasks` 对 `tasks: null` 的处置是
// `unknown`（"查不到在途任务不等于没有在途任务"）→ 拦。设计 §7 line 150
// 要求"安装确认显示是否有在途任务"，而在此之前**没有任何生产方**写这个读数：
//
//   · `client.mjs` 的快照里 `pendingTasks` 恒为 `null`；
//   · 桌面链路一路把它当 `null` 传下去；
//   · 于是每次升级都停在"没有拿到任务读数"。
//
// 和词表那个缺陷合在一起就是：**两头都拦，升级一次都跑不成**（一头是
// "没有读数"，另一头是"接上真实读数会永久阻塞"）。两件事必须一起修，
// 这也是本模块与 `task-state.mjs` 同批出现的原因。
//
// ## 读的是 `/api/board`
//
// `team-hub` 的读端点在**回环**监听时不需要 token（`readAuthRequired`：
// 只在非回环且 token 非空时才要求），而桌面产品里的 team-hub 一直监听
// 127.0.0.1。所以这条路径不需要把任何凭据搬来搬去——但**能拿到就带上**
// （见 `token` 参数）：一个"只在回环下才работает"的读法会在监听地址
// 改变时静默失败，而那时症状是"升级永远停在等待任务"。
//
// ## 失败一律是"没读到"，不是"没有任务"
//
// 超时、非 200、不是 JSON、形状不对 —— 全部返回 `{ ok: false }`，
// 由调用方折成 `tasks: null`。**绝不**返回空数组：一个把"读不到"说成
// "没有在途任务"的生产方，会让升级在**任务正在跑**的时候认为环境是干净的。
// ============================================================================

import { TASK_READING_CODES, boardTasksFromPayload, describeTaskReadings } from './task-state.mjs'

/** 读一次看板。给足时间但不要无限等（升级路径上不能挂住）。 */
export const DEFAULT_BOARD_TIMEOUT_MS = 5000

/** 看板响应体的上限（一个任务列表不该有几十兆）。 */
export const MAX_BOARD_BYTES = 8 * 1024 * 1024

export const TASK_READING_SOURCES = Object.freeze({
  BOARD: 'team-hub/api/board',
})

/**
 * 从 Launcher 的进程读数里求出 team-hub 的基地址。
 *
 * 与健康检查用同一份读数（`launcher.status()` → `port`），理由也同一条：
 * 猜一个默认端口会在端口被占用而换端口时指向别的东西。
 */
export function hubBaseUrlFromStatus(status, { host = '127.0.0.1' } = {}) {
  const processes = Array.isArray(status?.processes) ? status.processes : []
  const hub = processes.find((p) => p?.key === 'team-hub')
  const port = hub?.port
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null
  return `http://${host}:${port}`
}

/**
 * 读一次 `/api/board`。
 *
 * @param {object} args
 * @param {string} args.baseUrl             `http://127.0.0.1:<hub 端口>`
 * @param {string|null} [args.token]         有就带上（team-hub 回环时不需要）
 * @param {Function} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.now]
 * @returns {Promise<{ok: true, tasks, observedAtMs, source, total, summary}
 *                  | {ok: false, code, reason}>}
 */
export async function readBoardTasks({
  baseUrl,
  token = null,
  fetchImpl = null,
  timeoutMs = DEFAULT_BOARD_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    return fail(TASK_READING_CODES.BAD_READING,
      `读看板需要一个回环基地址（拿到的是 ${JSON.stringify(baseUrl)}）：`
      + 'team-hub 的端点只应当被本机读到')
  }
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return fail(TASK_READING_CODES.BAD_READING, '这个运行环境没有 fetch')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  const observedAtMs = now()
  try {
    const headers = { accept: 'application/json' }
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    const response = await doFetch(`${baseUrl}/api/board`, { headers, signal: controller.signal })
    if (response === null || typeof response !== 'object') {
      return fail(TASK_READING_CODES.BAD_READING, '看板返回了一个不是响应的东西')
    }
    if (response.status !== 200) {
      return fail(TASK_READING_CODES.BAD_READING, `看板返回 HTTP ${response.status}`)
    }
    const text = await response.text()
    if (typeof text !== 'string') return fail(TASK_READING_CODES.BAD_READING, '看板响应体不是文本')
    if (text.length > MAX_BOARD_BYTES) {
      return fail(TASK_READING_CODES.BAD_READING, `看板响应体 ${text.length} 字节超过上限 ${MAX_BOARD_BYTES}`)
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch (error) {
      return fail(TASK_READING_CODES.BAD_READING, `看板响应不是 JSON：${error?.message ?? error}`)
    }
    const normalized = boardTasksFromPayload(payload)
    if (normalized.ok !== true) return fail(normalized.code, normalized.reason)
    return Object.freeze({
      ok: true,
      code: null,
      reason: null,
      tasks: normalized.tasks,
      problems: normalized.problems,
      total: normalized.tasks.length,
      observedAtMs,
      source: TASK_READING_SOURCES.BOARD,
      summary: describeTaskReadings(normalized.tasks),
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''))
    return fail(TASK_READING_CODES.BAD_READING,
      aborted ? `读看板超时（${timeoutMs}ms）` : `读看板失败：${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 Launcher 状态一步到位读出在途任务。
 *
 * 任何一步拿不到就返回 `{ ok: false }`——由调用方折成 `tasks: null`
 * （`unknown` → 拦），而不是空数组。
 */
export async function readPendingTasksFromLauncher(status, {
  token = null, fetchImpl = null, timeoutMs = DEFAULT_BOARD_TIMEOUT_MS, now = () => Date.now(),
} = {}) {
  const baseUrl = hubBaseUrlFromStatus(status)
  if (baseUrl === null) {
    return fail(TASK_READING_CODES.BAD_READING,
      'Launcher 的进程读数里没有 team-hub 的端口：拿不到端口就不能假装"没有在途任务"')
  }
  return readBoardTasks({ baseUrl, token, fetchImpl, timeoutMs, now })
}

function fail(code, reason) {
  return Object.freeze({ ok: false, code, reason })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 一个按 URL 应答的 fetch 替身（自检用）。 */
function stubFetch(routes) {
  return async (url) => {
    const route = routes[url]
    if (route === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    if (typeof route === 'function') return route(url)
    return { status: route.status ?? 200, async text() { return route.text ?? '' } }
  }
}

export async function selfCheckTaskReadings() {
  const problems = []

  // ① 基地址必须来自真实读数，且必须是回环。
  if (hubBaseUrlFromStatus({ processes: [{ key: 'team-hub', port: 8787 }] }) !== 'http://127.0.0.1:8787') {
    problems.push('从状态里求 team-hub 基地址不对')
  }
  if (hubBaseUrlFromStatus({ processes: [] }) !== null) problems.push('没有 team-hub 时求出了基地址')
  if (hubBaseUrlFromStatus({ processes: [{ key: 'team-hub', port: 0 }] }) !== null) problems.push('端口为 0 时求出了基地址')
  if (await readBoardTasks({ baseUrl: 'http://evil.example:80' }).then((r) => r.ok)) {
    problems.push('非回环基地址被接受了')
  }

  // ② 正常读数。
  const good = await readBoardTasks({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl: stubFetch({
      'http://127.0.0.1:8787/api/board': {
        status: 200,
        text: JSON.stringify([{ id: 't-1', status: 'done' }, { id: 't-2', status: 'in_progress' }]),
      },
    }),
  })
  if (good.ok !== true) problems.push(`正常看板读数失败了：${good.reason}`)
  else {
    if (good.total !== 2) problems.push(`任务条数不对：${good.total}`)
    if (good.tasks[1].state !== 'in_progress') problems.push('看板的 status 字段没有被映射成 state')
    if (!/在途/.test(good.summary)) problems.push(`摘要没有指出有在途任务：${good.summary}`)
    if (good.source !== TASK_READING_SOURCES.BOARD) problems.push('读数没有标注来源')
  }

  // ③ 每一种失败都必须是 `ok: false`，**不是**空数组。
  const failures = [
    ['非 200', { status: 500, text: '' }],
    ['不是 JSON', { status: 200, text: 'not json' }],
    ['形状不对', { status: 200, text: JSON.stringify({ nope: 1 }) }],
  ]
  for (const [name, route] of failures) {
    const r = await readBoardTasks({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: stubFetch({ 'http://127.0.0.1:8787/api/board': route }),
    })
    if (r.ok !== false) problems.push(`「${name}」没有被判为失败`)
    if (r.tasks !== undefined) problems.push(`「${name}」返回了任务数组：读不到不能被说成没有任务`)
  }
  // 连不上。
  const unreachable = await readBoardTasks({
    baseUrl: 'http://127.0.0.1:8787', fetchImpl: stubFetch({}),
  })
  if (unreachable.ok !== false) problems.push('连不上看板时没有被判为失败')

  // ④ 超时必须自己了结（不能挂住升级路径）。
  const hanging = await readBoardTasks({
    baseUrl: 'http://127.0.0.1:8787',
    timeoutMs: 30,
    fetchImpl: async (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  if (hanging.ok !== false) problems.push('超时没有被判为失败')
  else if (!/超时/.test(hanging.reason)) problems.push(`超时的理由不对：${hanging.reason}`)

  // ⑤ 空看板是**合法**读数（真的没有任务），与"读不到"不同。
  const empty = await readBoardTasks({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl: stubFetch({ 'http://127.0.0.1:8787/api/board': { status: 200, text: '[]' } }),
  })
  if (empty.ok !== true) problems.push(`空看板被当成了失败：${empty.reason}`)
  else if (empty.total !== 0) problems.push('空看板的任务条数不是 0')
  else if (empty.summary !== '没有任务') problems.push(`空看板的摘要不对：${empty.summary}`)

  // ⑥ 拿了 token 就带上（回环下不需要，但监听地址改变时要有）。
  let sawAuth = null
  await readBoardTasks({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'secret-token',
    fetchImpl: async (url, options) => {
      sawAuth = options.headers.authorization ?? null
      return { status: 200, async text() { return '[]' } }
    },
  })
  if (sawAuth !== 'Bearer secret-token') problems.push(`token 没有被带上：${JSON.stringify(sawAuth)}`)

  // ⑦ 一步到位那条路：没有端口时必须失败。
  const noPort = await readPendingTasksFromLauncher({ processes: [{ key: 'workbench', port: 5173 }] })
  if (noPort.ok !== false) problems.push('没有 team-hub 端口时一步到位的读法成功了')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    source: TASK_READING_SOURCES.BOARD,
    defaultTimeoutMs: DEFAULT_BOARD_TIMEOUT_MS,
    maxBytes: MAX_BOARD_BYTES,
  })
}

export const TASK_READINGS_CHECKED = await selfCheckTaskReadings()
