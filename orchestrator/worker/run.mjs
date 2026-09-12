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
import { planWorkspace, worktreeStages } from '../workspace/index.mjs'

/** 进程外壳读取的环境变量（逐字，供 scan --check 枚举）。 */
export const WORKER_ENV = Object.freeze({
  HUB_URL: 'TEAM_HUB_URL',
  HUB_TOKEN: 'TEAM_HUB_TOKEN',
  DATA_DIR: 'LEGION_DATA_DIR',
  RUNTIME_COMMAND: 'LEGION_RUNTIME_COMMAND',
  WORKER_ID: 'LEGION_WORKER_ID',
  // PRT-306：用户授权的项目目录，worktree 从这里检出。
  // 缺它时**不认领**——不是"退回原地执行"，那会让两个 worker 在同一个目录里
  // 改同一份文件，而那种冲突不报错（见 orchestrator/workspace/index.mjs 的模块说明）。
  WORKSPACE_DIR: 'LEGION_WORKSPACE_DIR',
})

/** 从环境读 worker 配置（不做默认值猜测：hub 地址缺失是显式错误）。 */
export function readWorkerEnv(env = {}) {
  return Object.freeze({
    hubUrl: env.TEAM_HUB_URL ?? null,
    hubToken: env.TEAM_HUB_TOKEN ?? null,
    dataDir: env.LEGION_DATA_DIR ?? null,
    runtimeCommand: env.LEGION_RUNTIME_COMMAND ?? null,
    workerId: env.LEGION_WORKER_ID ?? null,
    workspaceDir: env.LEGION_WORKSPACE_DIR ?? null,
  })
}

/**
 * 把工作区阶段接到执行引擎上（PRT-306）。
 *
 * 契约是「`executor` 提供 `execute`，工作区阶段由本函数补上」——
 * 因为工作区**不是**执行引擎的事：同一套 DSH 执行引擎在"有隔离"与"无隔离"
 * 两种模式下跑的是同一份代码，区别只在准备工作区那一步。
 *
 * 三种情形分得很清楚，**没有一种会静默降级**：
 *   ① 没配 `workspaceDir` → 返回 `{ stages: null, reason }`，
 *      由调用方显式铺 `inPlaceStages()`（那是一个具名的调用点，会被写进 Attempt 证据）。
 *   ② 配了 → 返回真的 `worktreeStages`。
 *   ③ 工作区根与仓库路径的布局有问题（嵌套、相对路径）→ `planWorkspace` 抛具名错误。
 *      这个错**在准备阶段就暴露**，而不是等到建的时候才发现。
 */
export function resolveWorkspaceStages({ workspaceDir, dataDir, scope = 'default', platform = process.platform, runGit } = {}) {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') {
    return Object.freeze({
      stages: null,
      reason: '未配置 LEGION_WORKSPACE_DIR：没有用户授权的项目目录可检出。' +
        '**不自动退回原地执行**（那会让两个 worker 在同一目录里改同一份文件，且不报错）——' +
        '调用方若确实要原地执行，请显式铺开 inPlaceStages()',
    })
  }
  const worktreeBaseDir = join(dataDir, 'worktrees')
  // **在这里就验布局**，不要等到第一次认领。
  //
  // 布局错误（worktree 基准落在仓库内部、路径是相对的）是**配置**错误，
  // 而 `worktreeStages` 的 `planWorkspace` 是惰性的——不先探一次的话，
  // 它会等到某个 worker 认领了任务、状态已经推进到 `PreparingWorkspace` 时才抛。
  // 那时租约在跑，只能等它过期，而日志里看起来像"这次执行失败了"。
  // 用探针 id 走一次规划：三个布局类错误（NOT_CONFIGURED / NOT_ABSOLUTE / OVERLAP）
  // 都在这一步暴露，而探针 id 本身是安全的。
  planWorkspace({
    repoDir: workspaceDir,
    worktreeBaseDir,
    scope: 'probe',
    taskId: 'probe',
    attemptId: 'probe',
    platform,
  })
  return Object.freeze({
    stages: worktreeStages({ repoDir: workspaceDir, worktreeBaseDir, scope, platform, ...(runGit === undefined ? {} : { runGit }) }),
    reason: null,
    repoDir: workspaceDir,
    worktreeBaseDir,
  })
}

/**
 * team-hub 数据面客户端。
 *
 * 只做四件事，且**每条请求都带 token**（缺 token 时明确失败，而不是发一个匿名请求
 * 然后得到 401 再让人去猜为什么）。
 *
 * ## 具名错误码必须一路传上来
 *
 * `LEASE_EPOCH_STALE`（我已被接管 → 停手，不要再提交）与 `LEASE_EXPIRED`
 * （我还是持有者但超时 → 加快或停手）要求 worker 做**不同**的动作。
 * 如果这里把它们都压成 `Error('/api/… 返回 409')`，worker 只能靠文案猜，
 * 而文案会变。因此错误对象上带 `code` / `status` / `currentEpoch`。
 *
 * ## 为什么 claim 返回的是 `claimed` 而不是整个响应
 *
 * 服务端把结果包在 `{ ok, claimed, serverTimeMs }` 里。客户端若不拆包，
 * 调用方会在一个信封上找 `taskId` 并得到 `undefined`——然后它认领了任务却以为
 * 队列是空的（`taskId === undefined` 恰好就是 worker 判断「没领到」的条件），
 * 于是**任务被领走却永远没人做**。这是本次集成测试抓到的第一个真实缺陷。
 */
export class HubHttpError extends Error {
  constructor(message, { status, code = null, currentEpoch = null, body = null, path = null } = {}) {
    super(message)
    this.name = 'HubHttpError'
    this.status = status
    this.code = code
    this.currentEpoch = currentEpoch
    this.body = body
    this.path = path
  }
}

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
    let payload = null
    try { payload = await res.json() } catch { payload = null }
    if (!res.ok) {
      throw new HubHttpError(
        `${path} 返回 ${res.status}：${payload?.error ?? '（无错误说明）'}`,
        { status: res.status, code: payload?.code ?? null, currentEpoch: payload?.currentEpoch ?? null, body: payload, path },
      )
    }
    return payload
  }

  return Object.freeze({
    /** 领取。返回**解包后**的 claim 对象，或 null（队列空 / 抢输了）。 */
    async claim({ workerId, scope = null, leaseTtlMs = null }) {
      const r = await call('/api/runtime/claim', { workerId, scope, leaseTtlMs })
      return r?.claimed ?? null
    },
    heartbeat: ({ attemptId, leaseEpoch, workerId }) => call('/api/runtime/heartbeat', { attemptId, leaseEpoch, workerId }),
    transition: ({ attemptId, leaseEpoch, workerId, outcome, to = null, context = {}, reason = null }) =>
      call('/api/runtime/transition', { attemptId, leaseEpoch, workerId, outcome, to, context, reason }),
    release: ({ attemptId, leaseEpoch, workerId, reason }) => call('/api/runtime/release', { attemptId, leaseEpoch, workerId, reason }),
    /**
     * 上报失败并让**服务端**决定去向（PRT-309）。
     *
     * 刻意不提供 `transition({to:'RetryableFailure'})` 作为替代路径：
     * 那条路径只把尝试标成失败，"接下来怎么办"没人做，任务会永远停在中间态
     * （既没有可领的队列，也不在等人工清单里）。让 worker 有能力绕过这个入口，
     * 就等于让它有能力制造那个缺陷。
     */
    fail: ({ attemptId, leaseEpoch, workerId, failureCode = null, detail = null, reason = null }) =>
      call('/api/runtime/fail', { attemptId, leaseEpoch, workerId, failureCode, detail, reason }),
    /**
     * 回收过期租约（PRT-310 的入口）。
     *
     * `externalEffectPossibleStates` 必须由调用方给出——服务端拒绝猜
     * （见 team-hub/server.mjs 的 /api/runtime/recover）。这里不提供默认值，
     * 因为「默认认为不会重复」正是会造成重复付费的那个默认。
     */
    recover: ({ externalEffectPossibleStates, scope = null, limit = 50 }) =>
      call('/api/runtime/recover', { externalEffectPossibleStates, scope, limit }),
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
  // PRT-253：生产执行引擎的提供者。给了它就以它为准（见下面的注释）。
  executorProvider = null,
  // 调用方给的执行引擎通常只实现 `execute`；工作区阶段由下面按配置补上。
  // 传 `inPlaceStages()` 的调用方保持原样（那是显式的降级点，不是静默行为）。
  stages = null,
  scope = 'default',
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

  // ── PRT-306：工作区阶段 ──
  //
  // 只有当执行引擎真的在时才有意义（`executor === null` → `no-executor`，
  // 不认领任何任务，此时去建工作区是白建）。
  //
  // 显式传了 `stages` 的调用方优先：那是调用方在声明"我知道这一步是什么"。
  // 否则按配置解析——解析不出来时返回的是一段**理由**，而不是一个沉默的原地执行。
  // ── PRT-253：生产执行引擎的**入口** ──
  //
  // `executorProvider` 是一个返回判别式联合的**异步**函数：
  //   `{ ok: true, executor }` 或 `{ ok: false, code, message, reasons }`
  //
  // 为什么是"提供者"而不是直接传 executor：构造生产引擎要先做启动自检
  // （异步、可能拒绝），而**拒绝的理由必须能传到启动结果里**。
  // 早先只有一句 `no-executor`（"没配"），于是"自检没过"、"缺宿主端口"、
  // "忘了配"三种完全不同的处境在 Launcher 看来一模一样——
  // 而它们该做的修复动作完全不同。
  let effectiveExecutor = executor
  let executorRefusal = null
  if (typeof executorProvider === 'function') {
    let provided
    try {
      provided = await executorProvider()
    } catch (e) {
      provided = { ok: false, code: 'EXECUTOR_PROVIDER_THREW', message: `执行引擎的构造过程抛错：${e?.message ?? e}` }
    }
    if (provided !== null && typeof provided === 'object' && provided.ok === true && provided.executor != null) {
      effectiveExecutor = provided.executor
      // 成功也要说一句：一个静默接上的执行引擎与一个没接上的，
      // 在启动日志里应当区分得开。
      write(`[worker] 执行引擎已接线${provided.note === undefined ? '' : `：${provided.note}`}`)
    } else {
      executorRefusal = provided ?? { ok: false, code: 'EXECUTOR_PROVIDER_EMPTY', message: '执行引擎的构造没有返回结果' }
      // 拒绝**不是**致命启动错误：worker 仍要能起来、写状态文件、如实报告
      // 自己干不了活。否则 Launcher 只看到"进程退出"，看不到原因。
      write(`⚠ [worker] 执行引擎未接线（${executorRefusal.code}）：${executorRefusal.message}`)
      for (const r of executorRefusal.reasons ?? []) write(`    · ${r}`)
    }
  }

  let effectiveStages = stages
  let workspaceNote = null
  if (effectiveExecutor !== null && effectiveExecutor !== undefined && effectiveStages === null) {
    const resolved = resolveWorkspaceStages({ workspaceDir: cfg.workspaceDir, dataDir: cfg.dataDir, scope, platform })
    effectiveStages = resolved.stages
    workspaceNote = resolved.reason
    if (resolved.stages !== null) write(`[worker] 工作区隔离已启用：${resolved.repoDir} → ${resolved.worktreeBaseDir}`)
    else write(`⚠ [worker] ${resolved.reason}`)
  }

  const worker = createWorker({
    hub,
    executor: effectiveExecutor,
    stages: effectiveStages,
    workspaceNote,
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
    // 执行引擎没接上时，**这里如实说**。下游（Launcher 的诊断页）
    // 不必去读启动日志的行文来推断——那是会随文案变更而碎的判据。
    executorWired: effectiveExecutor !== null && effectiveExecutor !== undefined,
    executorRefusal: executorRefusal === null ? null : Object.freeze({
      code: executorRefusal.code ?? null,
      message: executorRefusal.message ?? null,
      reasons: Object.freeze([...(executorRefusal.reasons ?? [])]),
    }),
  })
}
