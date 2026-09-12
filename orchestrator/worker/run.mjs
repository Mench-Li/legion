// orchestrator/worker/run.mjs
// ============================================================================
// worker 的进程外壳：环境读取、hub 客户端、信号处理（PRT-301 起）
//
// 拆出来的原因是**可测性**：
//   `main.mjs` 里是「扫单/认领/执行/停止」的循环语义，全部可注入、确定性可测；
//   本文件是「真实进程的那一层」——读环境、发 HTTP、接信号、设退出码。
// 把两者混在一起会让循环语义的用例不得不启动真实进程、连真实端口、发真实信号，
// 于是没人愿意为它写用例，而它恰恰是最需要用例的地方。
//
// ## 环境变量
//
// 每个键**逐字**读取一次（`env.TEAM_HUB_URL` 这种写法），而不是计算访问：
// `scripts/config/scan.mjs` 只能看见字面访问，计算访问会让这些读取点
// 完全不出现在配置面扫描结果里。读取点与注入点声明在 `orchestrator/config-schema.mjs`。
// ============================================================================

import { join } from 'node:path'

import { createWorker } from './main.mjs'
import { STATUS_RELPATH } from './status-file.mjs'

/** 进程外壳读取的环境变量（逐字，供 scan --check 枚举）。 */
export const WORKER_ENV = Object.freeze({
  HUB_URL: 'TEAM_HUB_URL',
  HUB_TOKEN: 'TEAM_HUB_TOKEN',
  DATA_DIR: 'LEGION_DATA_DIR',
  RUNTIME_COMMAND: 'LEGION_RUNTIME_COMMAND',
  WORKER_ID: 'LEGION_WORKER_ID',
})

/** 从环境读 worker 配置（不做默认值猜测：hub 地址缺失是显式错误）。 */
export function readWorkerEnv(env = {}) {
  return Object.freeze({
    hubUrl: env.TEAM_HUB_URL ?? null,
    hubToken: env.TEAM_HUB_TOKEN ?? null,
    dataDir: env.LEGION_DATA_DIR ?? null,
    runtimeCommand: env.LEGION_RUNTIME_COMMAND ?? null,
    workerId: env.LEGION_WORKER_ID ?? null,
  })
}

/**
 * team-hub 数据面客户端。
 *
 * 只做四件事，且**每条请求都带 token**（缺 token 时明确失败，而不是发一个匿名请求
 * 然后得到 401 再让人去猜为什么）：
 * 认领、心跳、提交终态、释放。
 */
export function createHubClient({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('createHubClient 需要 baseUrl（TEAM_HUB_URL）')
  }
  if (typeof token !== 'string' || token.trim() === '') {
    // 不发匿名请求：401 的报错文案离真因太远（「unauthorized」不会让人想到「没配 token」）
    throw new TypeError('createHubClient 需要 token（TEAM_HUB_TOKEN）：不带凭证的请求只会得到 401，离真因太远')
  }
  const root = baseUrl.replace(/\/+$/, '')

  async function call(path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!res.ok) throw new Error(`${path} 返回 ${res.status}`)
    return res.json()
  }

  return Object.freeze({
    claim: ({ workerId }) => call('/api/runtime/claim', { workerId }),
    heartbeat: ({ taskId, leaseEpoch, workerId }) => call('/api/runtime/heartbeat', { taskId, leaseEpoch, workerId }),
    transition: ({ taskId, leaseEpoch, outcome, detail }) => call('/api/runtime/transition', { taskId, leaseEpoch, outcome, detail }),
    release: ({ taskId, leaseEpoch, workerId, reason }) => call('/api/runtime/release', { taskId, leaseEpoch, workerId, reason }),
  })
}

/**
 * 以真实进程的方式运行 worker：接 SIGTERM/SIGINT 优雅停止，返回退出码。
 *
 * `executor` 由调用方给：本批次（PRT-301）还没有接上 RuntimeAdapter
 * （那是 PRT-253/311 的接线），因此默认 `null` → worker 明确报 `no-executor` 且**不认领**。
 * 这比「假装能执行」好：前者在启动时就告诉你缺什么，后者会烧掉整个队列的重试额度。
 */
export async function runWorkerProcess({
  env = process.env,
  fetchImpl = globalThis.fetch,
  executor = null,
  platform = process.platform,
  write = (line) => process.stdout.write(`${line}\n`),
  installSignalHandlers = true,
  processRef = process,
} = {}) {
  const cfg = readWorkerEnv(env)
  if (cfg.dataDir === null) {
    // 结果是**判别式联合**而不是「有时候返回数字」：
    // 上一版在这里返回了 `8`，而入口写成 `const { runPromise } = await ...`——
    // 解构一个数字得到 undefined，于是 `await undefined` 通过、退出码被设成 0。
    // 「明明没起来却说成功」是这一批最不该出现的一类缺陷，因此类型上就让它不可能发生。
    return Object.freeze({
      ok: false,
      exitCode: 8,
      code: 'DATA_DIR_REQUIRED',
      message: '未设置 LEGION_DATA_DIR：worker 状态文件没有落点。' +
        '状态文件是这个无监听端口进程的唯一观测出口，没有它「起来了但干不了活」与「正常运行」外部完全同形',
      worker: null,
      statusPath: null,
      runPromise: null,
    })
  }

  let hub = null
  if (cfg.hubUrl !== null) {
    try {
      hub = createHubClient({ baseUrl: cfg.hubUrl, token: cfg.hubToken ?? '', fetchImpl })
    } catch (e) {
      // hub 无法建客户端不是致命错误：worker 仍然要能起来并如实报告自己不能工作，
      // 否则 Launcher 看到的只是「进程退出」，看不到原因。
      write(`⚠ orchestrator worker：数据面客户端未能建立（${e.message}）——将以 hub-unreachable 状态运行`)
      hub = null
    }
  }

  const worker = createWorker({
    hub,
    executor,
    dataDir: cfg.dataDir,
    platform,
    workerId: cfg.workerId ?? undefined,
    logger: write,
  })

  const runPromise = worker.start()

  if (installSignalHandlers) {
    const stop = (signal) => {
      write(`[worker] 收到 ${signal}：优雅停止（先释放 lease）`)
      worker.stop({ reason: signal }).catch((e) => write(`[worker] 停止时出错：${e?.message ?? e}`))
    }
    processRef.once('SIGINT', () => stop('SIGINT'))
    processRef.once('SIGTERM', () => stop('SIGTERM'))
  }

  return Object.freeze({
    ok: true,
    exitCode: 0,
    worker,
    statusPath: join(cfg.dataDir, STATUS_RELPATH),
    runPromise,
  })
}
