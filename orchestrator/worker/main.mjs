// orchestrator/worker/main.mjs
// ============================================================================
// Legion Orchestrator worker（PRT-301 起；扫单 / 认领 / 派工的外壳）
//
// 这是 spec §6.10 里由 Launcher 托管、清单声明为 `product/orchestrator/worker.mjs`
// 的那个进程。它长驻运行，职责是：**扫单 → 认领（拿 lease）→ 执行 → 提交终态**。
//
// ## 本模块最重要的一条行为：**不认领自己执行不了的任务**
//
// 没有配置执行引擎时，一个「积极」的 worker 会照常认领任务、然后立刻失败，
// 把每个任务的重试额度烧掉，最后全部落进 Dead Letter。
// 从外部看，这个产品的表现是「任务在跑，但全都失败了」——
// 而真实原因只是「没配执行引擎」，本该在启动时就说清楚。
//
// 因此这里的规则是：
//   - 没有执行引擎 → `state: 'no-executor'`，**不认领任何任务**，状态文件与日志如实说明；
//   - 拿不到 team-hub → `state: 'hub-unreachable'`，同样不认领（认领不到就无事可做）；
//   - 退出前必须释放持有的 lease（否则任务要等租期自然过期才能被别人领走，
//     这段时间里队列看起来是「卡住」的）。
//
// ## 依赖全部可注入
//
// `fetchImpl` / `sleep` / `now` / `spawn` 全部注入，因此「扫单节奏」「心跳间隔」
// 「优雅停止」这三件最容易只在真机上出问题的事可以在进程内确定性验证。
// 唯一的真实进程用例负责证明「真的能被 SIGTERM 停下来、真的会写状态文件」。
// ============================================================================

import { join } from 'node:path'

import { readStatusFile, STATUS_RELPATH, writeStatusFile } from './status-file.mjs'
import { resolveRunInputs } from './run-inputs.mjs'

/** worker 状态机的取值。 */
export const WORKER_STATES = Object.freeze([
  'starting',
  'no-executor',
  'no-stages',
  'hub-unreachable',
  'idle',
  'claiming',
  'executing',
  'stopping',
  'stopped',
])

/**
 * 执行一次任务必须提供的三个阶段。
 *
 * 三者都是**必需**的，而不是「有就用、没有就跳过」。理由是状态机不允许跳状态
 * （`Leased → Validating` 是非法迁移），因此一个只实现了 `execute` 的 worker
 * 根本产生不了一次合法的 Attempt——它认领之后必然失败，把重试额度烧光。
 *
 * 「没有工作区隔离、没有上下文快照」是当前的真实状态（PRT-306 与 PRT-401 未做），
 * 因此这里不假装它有，而是要求调用方**显式**选择降级模式：用 `inPlaceStages()`
 * 铺开两个明确记录自己什么都没做的阶段。这样降级是一个具名的调用点，
 * 而不是一个埋在默认值里的静默行为，日后替换它时也找得到。
 */
export const REQUIRED_STAGE_KEYS = Object.freeze(['prepareWorkspace', 'buildContext', 'execute'])

/**
 * 「原地执行」的降级阶段实现。
 *
 * 两个返回的 `kind` 会被写进 Attempt 的证据里，因此日后翻记录能看出
 * 「这次执行没有工作区隔离、没有上下文快照」——而不是让人以为它有。
 *
 * ## PRT-411：上下文不再是降级的
 *
 * 此前 `buildContext` 也在这里，和 `prepareWorkspace` 一样返回
 * `{ kind: 'minimal' }`。但两者的处境**不同**：
 *
 *   · 工作区隔离（PRT-306）**真的没交付**——没有表、没有 store，
 *     所以"原地执行"是当前唯一诚实的形态；
 *   · 上下文快照（PRT-401~413）**已经全部交付**，装配器、来源、脱敏、
 *     tokenizer、快照仓储各自都有套件，只是**没有生产调用方**。
 *
 * 于是一份空快照的原因不是"没做"，而是"没接"——后者必须修，前者只能声明。
 * 现在 `buildContext` 只在调用方**明确给出** `contextStore` + `loadInputs` 时
 * 才降级；给了就必须真的冻结一份快照，否则这个阶段不该存在于这个 worker 里。
 *
 * 不给这两个依赖时仍然返回 `kind: 'minimal'`，但**如实说明**它没有快照。
 */
export function inPlaceStages({ note = 'PRT-306/401 未交付：当前阶段为原地执行、无上下文快照', contextStage = null } = {}) {
  return Object.freeze({
    /**
     * 显式声明「没有隔离」。
     *
     * 没有这个声明时，`workspaceMode` 只能靠"有没有 `prepareWorkspace`"去猜，
     * 而这个函数**有**它——于是原地执行会被写成 `enabled`。
     * 那是这类代码里最坏的一种错：状态文件说"有隔离"，而实际上两个 worker
     * 在同一个目录里改同一份文件，且不报错。
     */
    workspaceIsolation: 'none',
    prepareWorkspace: async () => ({ kind: 'in-place', note }),
    buildContext: contextStage ?? (async () => ({ kind: 'minimal', note })),
    // 有没有真的冻结快照，是**可判定的**，所以不让人从 `kind` 去猜。
    contextFrozen: contextStage !== null,
  })
}

/** 默认节奏。全部是配置项，这里是它们的兜底值。 */
export const WORKER_DEFAULTS = Object.freeze({
  pollIntervalMs: 3000,
  heartbeatIntervalMs: 10000,
  failureBackoffMs: 5000,
  maxConsecutiveFailures: 5,
})

function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((p, i) => {
      const s = String(p).replace(/[\\/]+/g, sep)
      return i === 0 ? s.replace(new RegExp(`${sep}+$`), '') : s.replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    })
    .filter((p) => p !== '')
    .join(sep)
}

/**
 * 阶段失败 → 已登记的失败码。
 *
 * 映射表而不是默认值：未登记的阶段给出 `undefined`，由 `classifyFailure`
 * 按「不认识的错误不默认可重试」处理。默认成 `retryable` 会让一个没见过的
 * 阶段失败被无限重试。
 */
function classifyStageFailure(stage) {
  switch (stage) {
    case 'prepareWorkspace': return 'workspace-prepare-failed'
    case 'buildContext': return 'context-build-failed'
    case 'execute': return 'runtime-unavailable'
    default: return undefined
  }
}

/**
 * 建一个 worker 实例。
 *
 * `executor` 是唯一的能力开关：
 *   - null/undefined → 不认领，状态为 `no-executor`
 *   - `{ execute(task) → Promise<{ outcome, detail }> }` → 正常认领与执行
 *
 * `hub` 是数据面客户端，形状 `{ claim(), heartbeat(), release(), transition() }`。
 * 本模块**不直接拼 HTTP**：数据面的路由与鉴权属 team-hub，混在一起会让
 * 「worker 的循环逻辑」无法脱离真实 hub 测试。
 */
export function createWorker({
  hub = null,
  executor = null,
  dataDir = null,
  platform = process.platform,
  statusPath = null,
  pollIntervalMs = WORKER_DEFAULTS.pollIntervalMs,
  heartbeatIntervalMs = WORKER_DEFAULTS.heartbeatIntervalMs,
  failureBackoffMs = WORKER_DEFAULTS.failureBackoffMs,
  maxConsecutiveFailures = WORKER_DEFAULTS.maxConsecutiveFailures,
  workerId = `worker-${process.pid}`,
  // 工作区/上下文的阶段实现（PRT-306）：与 `executor` 分开，因为
  // 「在哪里干活」不是执行引擎的事——同一套执行引擎在"有隔离"与"无隔离"
  // 两种模式下跑的是同一份代码。合并时 `executor` 自己的实现优先
  // （执行引擎想自己准备上下文就让它自己准备）。
  stages = null,
  workspaceNote = null,
  // 认领闸门（PRT-711 / spec §6.3）。
  //
  // **每一轮 tick() 都会重新问一次**，而不是建实例时问一次：
  // 「正在升级」「Runtime 变成不可用」都是**运行中才会发生**的事，
  // 只在启动时判一次，等于在升级开始的下一秒又开始认领。
  //
  // 它是一个函数 `(ctx) => ({ claim, scope, reason, state })`，形状与
  // `product/runtime-state.mjs` 的 `mayClaimTasks()` 一致。
  //
  // ## 为什么默认是 `null` 而 `null` 意味着"照旧"
  //
  // 生产入口（`product/orchestrator/worker.mjs`）**总是**装一个闸门；
  // 这里的 `null` 是给"只想测扫单/停止循环语义"的用例留的口子。
  // 但它**不会静默**：状态文件里 `claimGateMode` 会写成 `not-installed`，
  // 于是"这个 worker 没有认领闸门"是一件看得见的事，而不是一件要猜的事。
  //
  //   > 一个"没装闸门所以照常认领"的默认值，
  //   > 与一个"装了一个恒真的闸门"的默认值，是同一个东西——
  //   > 只不过前者在代码里看起来像是一个中立的、没有做决定的默认值。
  claimGate = null,
  // ── PRT-253 续批：运行输入（`workspaceId` / `modelProfileRef` / `workdir`）──
  //
  // 这三项是 `RunRequest` 的必填字段，而 `defaultRequestFor` 明确拒绝猜它们。
  // 此前**没有任何东西给**：认领响应不带、`WORKER_ENV` 不带、`product/` 一处未引用。
  // 生产链路的读数是 `EXECUTOR_BAD_WIRING missing=["workspaceId","modelProfileRef","workdir"]`。
  //
  // 这里给它们接上权威来源（见 `run-inputs.mjs` 的表）：
  //   · `workspaceId` —— 租约上的 `scope`（效果命名空间必须按 Attempt 稳定且唯一）；
  //   · `workdir`     —— worktree 的 `slotDir`，原地执行时是被授权的项目目录；
  //   · `modelProfileRef` —— 调用方给的 `modelProfileRefFor()`（员工的模型绑定，PRT-502）。
  //
  // ★ `modelProfileRefFor` 是**注入的异步端口**而不是这里直接去连 hub：
  //   本模块不认识 HTTP，也不该认识（它整条路径都能在不起进程的情况下被测到）。
  //   缺省 `null` = "没有这个端口"，那时 `modelProfileRef` 只能来自租约，
  //   否则这次 Attempt 以具名错误停下——**不猜一个模型**。
  projectDir = null,
  modelProfileRefFor = null,
  logger = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (dataDir === null && statusPath === null) {
    throw new TypeError('createWorker 需要 dataDir 或 statusPath：没有状态出口的 worker 在外部与「卡住」完全同形')
  }
  if (claimGate !== null && typeof claimGate !== 'function') {
    throw new TypeError('createWorker 的 claimGate 必须是函数（每轮调用一次）或 null：'
      + '一个"装上了但从不被调用"的闸门，与没装闸门是同一个东西')
  }
  if (modelProfileRefFor !== null && typeof modelProfileRefFor !== 'function') {
    throw new TypeError('createWorker 的 modelProfileRefFor 必须是异步函数 (lease) => string|null 或 null：'
      + '一个"装上了但从不被调用"的解析端口，与没有端口是同一个东西——'
      + '而它的缺席会让每一次 Run 都以"缺 modelProfileRef"停下')
  }
  const gateInstalled = claimGate !== null
  // 最近一次闸门裁决。写进状态文件——**"为什么现在不认领"必须能从盘上读到**，
  // 否则运维只能看见 claimed 一直是 0。
  let lastGate = null
  const resolvedStatusPath = statusPath ?? joinPath(platform, dataDir, STATUS_RELPATH)

  // 阶段齐备性在**建实例时**就算清楚：等到认领之后才发现缺阶段，
  // 那条任务就已经被领走了（状态 Leased、租约在跑），只能等租约过期。
  //
  // 三类来源合并成一份实现：`executor`（执行）、`stages`（工作区/上下文）。
  // 缺哪一类就在 `missingStages` 里报出来——`Leased → Validating` 是非法迁移，
  // 因此一个只有 `execute` 的 worker 产生不了一次合法的 Attempt，
  // 它认领之后必然失败并把重试额度烧光。
  const stageImpl = Object.freeze({ ...(stages ?? {}), ...(executor ?? {}) })
  const hasAnyStage = executor !== null && executor !== undefined
  const missingStages = hasAnyStage
    ? REQUIRED_STAGE_KEYS.filter((k) => typeof stageImpl[k] !== 'function')
    : []
  const stagesUsable = hasAnyStage && missingStages.length === 0

  let state = 'starting'
  let running = false
  let stopped = false
  let loopPromise = null
  const counters = { claimed: 0, completed: 0, failed: 0, unknownOutcome: 0, consecutiveFailures: 0, heartbeats: 0, heartbeatFailures: 0 }
  let lastError = null
  let currentLease = null
  let lastStatusWrite = null
  let heartbeatActive = false
  let leaseMayBeLost = false

  /** 状态文件 + 日志是同一份事实的两个出口，必须一起更新。 */
  function publish(nextState, extra = {}) {
    const previous = state
    state = nextState
    // 「为什么不干活」的解释必须发生在**做决定的地方**，而不是主循环里：
    // `tick()` 可以被单独调用（测试、单次扫单），在循环里打日志会让这条路径
    // 只写状态文件、不留任何解释——而状态文件是要被人读的，不是被猜的。
    if (nextState === 'no-executor' && previous !== 'no-executor') {
      logger('[worker] 未配置执行引擎：**不认领任何任务**（认领会立刻失败并把重试额度烧光，' +
        '最终表现为「任务都在跑但全都失败」）。配置执行引擎后重启即可开始工作。')
    }
    if (nextState === 'no-stages' && previous !== 'no-stages') {
      logger(`[worker] 执行引擎缺少必需阶段：${missingStages.join(', ')}——**不认领任何任务**。` +
        '状态机不允许跳状态（Leased → Validating 非法），只实现了 execute 的 worker ' +
        '产生不了一次合法的 Attempt。若确实要用原地执行，请显式铺开 inPlaceStages()。')
    }
    if (nextState === 'hub-unreachable' && previous !== 'hub-unreachable') {
      logger('[worker] 无法与 team-hub 通信：暂停认领并退避重试（不退出，等数据面恢复）')
    }
    // ★ 闸门拦下时**必须说出理由**，而且要说的是**产品的状态**，不是"不认领"三个字。
    //   一句"不认领"会让运维去查 hub、查执行引擎、查网络——而真正的原因
    //   可能是"正在升级"。
    if (nextState === 'claim-blocked' && previous !== 'claim-blocked') {
      const g = extra.claimGate ?? lastGate
      logger(`[worker] 认领被闸门拦下（产品状态：${g?.state ?? '未知'}）：${g?.reason ?? '闸门没有给出理由'}`
        + '——不认领任何任务。这是**产品级的决定**，不是本进程的故障：'
        + '去查产品状态（是否在升级 / Runtime 是否不可用），不要在这里查网络或执行引擎。')
    }
    const status = buildStatus(nextState, extra)
    const written = writeStatusFile(resolvedStatusPath, status)
    lastStatusWrite = written
    if (written.removed.length > 0) {
      // 剔除不等于没事：说明有人往状态里塞了凭证键，必须可见。
      logger(`[worker] 状态文件剔除了凭证键：${written.removed.join(', ')}`)
    }
    if (written.ok !== true) logger(`[worker] ${written.message}`)
    return status
  }

  /**
   * 组装一份状态对象（**不落盘**）。
   *
   * 与 `publish` 分开，是为了让「状态里到底写了什么」能被直接断言，
   * 而不必先写一个文件再读回来。上一版只能通过 `snapshot()` 看到其中一小部分字段，
   * 于是"隔离模式有没有被如实写出来"这件事没有任何用例能问——
   * 而它恰恰是那种**不报错**的失败：没有隔离时一切看起来都正常。
   */
  function buildStatus(nextState, extra = {}) {
    return {
      workerId,
      pid: process.pid,
      state: nextState,
      hubConfigured: hub !== null,
      executorConfigured: executor !== null && executor !== undefined,
      stageMode: executor === null || executor === undefined ? 'none' : (stagesUsable ? 'full' : 'incomplete'),
      // PRT-711：认领闸门的**存在与否**必须能从这里读出来。
      //
      // 三态而不是布尔：`not-installed` 不是一个"错"，它是一个**事实**，
      // 而它与 `installed ∧ 现在是 true` 在"为什么 claimed 一直是 0"这件事上
      // 给出的答案完全不同。合成一个布尔，等于把"没装闸门"与"闸门放行了"
      // 写成一个值——那正是这块最容易被读错的地方。
      claimGateMode: gateInstalled ? 'installed' : 'not-installed',
      // 最近一次裁决（没装闸门时是 null）。`state` 是**产品状态**，
      // 不是本进程状态：运维要能一眼看出"不认领"是产品级的决定。
      claimGate: lastGate === null ? null : lastGate,
      // PRT-306：工作区隔离的状态必须是**可观测**的。
      //
      // 四态而不是布尔：`disabled` 带着理由（"没有隔离"本身不报错——它只在两条任务
      // 撞上同一个文件时才显形，而那时已经晚了；运维必须先能看到它）。
      //
      // 判据是**提供者的显式声明** `workspaceIsolation`，不是"有没有 prepareWorkspace"：
      // `inPlaceStages()` 同样提供那个函数。靠推断会把原地执行写成 `enabled`，
      // 而那是这类代码里最坏的一种错——状态文件说"有隔离"。
      workspaceMode: !stagesUsable
        ? 'unknown'
        : (stageImpl.workspaceIsolation === 'worktree' && workspaceNote === null
          ? 'enabled'
          : (stageImpl.workspaceIsolation === 'none'
            ? 'disabled'
            // 提供了阶段却没声明隔离模式：不假装知道。`unknown` 会让人去查，
            // 而默认成 `enabled` 会让没人去查。
            : 'unknown')),
      workspaceNote,
      missingStages,
      claimed: counters.claimed,
      completed: counters.completed,
      failed: counters.failed,
      unknownOutcome: counters.unknownOutcome,
      consecutiveFailures: counters.consecutiveFailures,
      heartbeats: counters.heartbeats,
      heartbeatFailures: counters.heartbeatFailures,
      leaseMayBeLost,
      currentLeaseEpoch: currentLease === null ? null : currentLease.leaseEpoch ?? null,
      currentAttemptId: currentLease === null ? null : currentLease.attemptId ?? null,
      currentTaskId: currentLease === null ? null : currentLease.taskId ?? null,
      lastError,
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    }
  }

  /**
   * 执行期间维持 lease 的心跳。
   *
   * **为什么必须有**：租期是「另一个 worker 多久之后可以认为我死了并接管这个任务」。
   * 执行期间不发心跳，长任务一定会被第二个 worker 认领并**重跑一遍**——
   * 对一个已经调用过外部写操作的步骤，那就是重复副作用。
   * 心跳不是「保活优化」，它是「不重复执行」的前提。
   *
   * **心跳失败为什么必须可见**：心跳连续失败意味着 lease 可能已经易主。
   * 此时本进程继续执行下去，最后提交的终态会被 team-hub 以 epoch 不符拒绝
   * （PRT-313 的数据库层防线）；如果它没被拒绝，那就是**覆盖了别人的结果**。
   * 本批次还没有「中断正在执行的 executor」的能力（那需要把 AbortSignal 一路穿到
   * RuntimeAdapter，属 PRT-302/311），因此这里能做且必须做的是：
   * 计数、置 `leaseMayBeLost`、写进状态文件、并且**在日志里说清楚后果**——
   * 让「结果可能被拒绝/覆盖了别人的结果」这件事有痕迹，而不是静默地跑完。
   */
  function startHeartbeat(lease) {
    if (heartbeatIntervalMs <= 0) return
    heartbeatActive = true
    leaseMayBeLost = false
    const loop = async () => {
      while (heartbeatActive) {
        await sleep(heartbeatIntervalMs)
        if (!heartbeatActive) return
        try {
          await hub.heartbeat({ attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId })
          counters.heartbeats += 1
          leaseMayBeLost = false
        } catch (e) {
          counters.heartbeatFailures += 1
          leaseMayBeLost = true
          logger(`[worker] 心跳失败（连续 ${counters.heartbeatFailures} 次，尝试 ${lease.attemptId}）：` +
            `${e?.message ?? e}。lease 可能已过期并被其他 worker 接管——` +
            '此时本次执行的结果可能被拒绝，或者（如果没有 epoch 校验）覆盖别人的结果')
          publish('executing')
          // `LEASE_EPOCH_STALE` 的含义是「你已经被接管了」，不是「网络抖了一下」。
          // 继续按间隔发只会持续失败，而真正该做的是**停手**：不再提交结果。
          // （中断正在执行的 executor 需要 AbortSignal 穿到 RuntimeAdapter，属 PRT-302/311。）
          if (e?.code === 'LEASE_EPOCH_STALE') {
            logger(`[worker] 放弃尝试 ${lease.attemptId} 的心跳：epoch 已前进到 ${e.currentEpoch ?? '未知'}，` +
              '本 worker 不再是持有者；本次执行的结果将被丢弃，不再提交')
            heartbeatActive = false
            return
          }
        }
      }
    }
    loop()
  }

  function stopHeartbeat() {
    heartbeatActive = false
  }

  /**
   * 把一次失败交给服务端结算——**worker 上报失败的唯一出口**。
   *
   * 存在的理由不是"少写几行"，是这一批修掉的那个缺陷：worker 有**两条**失败上报的路，
   * 一条在执行器**抛出**异常时（`catch`），一条在执行器**返回** `{outcome:'failed'}` 时。
   * 两条路各自写一遍 `hub.fail({...})` 时，其中一条会漂移成 `transition({to:...})`
   * ——而后者只把这次尝试标成失败就结束了，"接下来怎么办"（还有额度就排新尝试、
   * 额度用完就进 DeadLetter）没有任何人做。
   *
   * 后果不是报错，是**任务变成"状态 todo、却永远领不到"**：`RetryableFailure`
   * 既不在回收扫描的集合里（`IN_FLIGHT_ATTEMPT_STATES`），也不在人工待办清单里
   * （`listHeld` 只收 `UnknownOutcome`/`DeadLetter`），而看板上它是个正常的待办。
   *
   * 注意"引擎抛栈"与"引擎给失败终态"这两条路，**后者才是常见形态**
   * （适配器把引擎故障分类成 `run.failed` 终态事件，不往外抛），
   * 所以漂移掉的恰好是常见的那条。
   *
   * 用一个函数收口，是让"两条路走同一个出口"变成**结构上做不到别的**，
   * 而不是靠下一批的人记得。`transition` 只用于**不带失败的**终态上报
   * （`completed` → 验收、`outcome_unknown` → 等人工）。
   *
   * @returns {Promise<object|null>} 服务端的处置（含 `action`/`nextAttemptAtMs`）；上报本身失败时为 null
   *
   * **本函数保证不抛**：主循环（`loop()`）没有给 `tick()` 包 try/catch，
   * 所以从这里漏出去一个异常会把整个 worker 循环带死——而"上报失败失败"恰恰是
   * 最可能发生的那一种（epoch 已前进 = 我们被接管了），那不是异常情况，是正确结果。
   * 两个调用方因此都可以直接 await，不必各自再包一层（各自包一层就会漂移）。
   */
  async function submitFailure({ claimed, failureCode, detail, runResult = null, runEvents = null, runEventsTruncated = false }) {
    let reported = null
    try {
      // `fail` 还负责算退避并写进队列（`next_attempt_at_ms`），
      // 因此 worker 不需要自己 sleep 一个退避时间再试——退避是**服务端**的队列闸门。
      reported = await hub.fail({
        attemptId: claimed.attemptId,
        leaseEpoch: claimed.leaseEpoch,
        workerId,
        failureCode,
        detail,
        // 引擎**返回**失败终态时手里是有结果的（终态事件带着 `result`），
        // 那就原样送上去，让 hub 侧那一行是 `source: 'engine'` 而不是 `'report-only'`
        // ——后者答不出"引擎当时说了什么"，而状态迁移全都还是对的。
        runResult,
        // F-05 前半：失败路径的事件明细同样上报。没有它，"它在炸之前做了什么"
        // 在库里没有任何痕迹（失败路径只在极少数情况下才会同时有 runResult）。
        runEvents,
        runEventsTruncated,
      })
      lastError.disposition = reported?.action ?? null
      lastError.nextAttemptAtMs = reported?.nextAttemptAtMs ?? null
    } catch (reportError) {
      // 上报失败本身也要可见：最可能的原因是 epoch 已经前进（我们被接管了）。
      try {
        lastError.reportFailed = String(reportError?.message ?? reportError)
        logger(`[worker] 无法上报失败（${lastError.reportFailed}）：Attempt 会停在 ${trace[trace.length - 1] ?? 'Leased'}，` +
          '由恢复扫描处置。若原因是 epoch 已前进，说明它已被别人接管——这是正确的结果')
      } catch {
        // 连日志都写不出去（logger 是调用方给的）。**仍然不能抛**：
        // 这条路上的"失败"已经如实留在 lastError 里由状态文件带出去。
      }
    }
    return reported
  }

  /** 一轮：能认领就认领，不能认领就如实说明原因。 */
  async function tick() {
    if (executor === null || executor === undefined) {
      // 见文件头：不认领自己执行不了的任务。
      publish('no-executor')
      return { acted: false, reason: 'no-executor' }
    }
    if (!stagesUsable) {
      // 同上，只是原因更具体：引擎在，但缺的阶段让它产生不了合法的 Attempt。
      publish('no-stages')
      return { acted: false, reason: 'no-stages', missingStages }
    }
    if (hub === null) {
      publish('hub-unreachable')
      return { acted: false, reason: 'hub-not-configured' }
    }

    // ── 认领闸门（PRT-711）──────────────────────────────────────────────
    //
    // 位置是这段代码的全部要点：它排在**真正调用 hub.claim() 之前**，
    // 排在"能不能执行"（executor/stages）之后。
    //
    // 前两道闸问的是「我干得了吗」，这一道问的是「现在该不该干」——
    // 两件事的出处完全不同：前者是本进程的能力，后者是产品的状态
    // （正在升级 / Runtime 不可用 / 部分能力缺失）。
    //
    //   > 一个"引擎在、我就认领"的 worker，
    //   > 与一个在升级过程中继续把任务领走并跑起来的 worker，
    //   > 是同一个东西——只不过前者在"我能不能执行"这个问题上回答得完全正确。
    if (gateInstalled) {
      let verdict = null
      let gateError = null
      try {
        verdict = claimGate({ workerId, counters, state })
      } catch (e) {
        gateError = String(e?.message ?? e)
      }
      // ★ 闸门抛错 / 没给结论，一律**不认领**。
      //   "问不出来"与"可以认领"是两件事；把前者当成后者，
      //   等于让一个坏掉的判据变成一张通行证。
      if (gateError !== null) {
        lastGate = { claim: false, state: null, reason: `认领闸门抛错：${gateError}`, error: gateError }
      } else if (verdict === null || verdict === undefined) {
        lastGate = { claim: false, state: null, reason: '认领闸门没有给出结论（返回空）' }
      } else {
        lastGate = {
          claim: verdict.claim === true,
          state: verdict.state ?? null,
          scope: verdict.scope ?? null,
          reason: verdict.reason ?? null,
        }
      }
      if (lastGate.claim !== true) {
        publish('claim-blocked', { claimGate: lastGate })
        return { acted: false, reason: 'claim-blocked', claimGate: lastGate }
      }
    }

    publish('claiming')
    let claimed = null
    try {
      claimed = await hub.claim({ workerId })
    } catch (e) {
      counters.consecutiveFailures += 1
      lastError = { stage: 'claim', message: String(e?.message ?? e) }
      publish('hub-unreachable')
      return { acted: false, reason: 'claim-failed', error: lastError }
    }
    if (claimed === null || claimed === undefined) {
      counters.consecutiveFailures = 0
      publish('idle')
      return { acted: false, reason: 'queue-empty' }
    }
    // 拿到一个「没有 attemptId 的 claim」是**协议错误**，不是空队列。
    // 悄悄当成空队列的后果特别坏：任务已经被服务端领走（状态 Leased、租约在跑），
    // 而 worker 以为自己什么都没领到——于是这条任务**被领走却永远没人做**，
    // 只能等租约过期才被回收，而回收日志里看不出是谁领的。
    if (claimed.attemptId === undefined || claimed.attemptId === null) {
      counters.consecutiveFailures += 1
      lastError = {
        stage: 'claim',
        message: `数据面返回的 claim 缺少 attemptId（收到字段：${Object.keys(claimed).join(', ') || '（无）'}）：` +
          '这是协议不匹配，不是空队列——任务可能已被领走',
      }
      logger(`[worker] ${lastError.message}`)
      publish('idle')
      return { acted: false, reason: 'claim-protocol-error', error: lastError }
    }

    counters.claimed += 1
    currentLease = claimed
    publish('executing')
    startHeartbeat(claimed)
    const trace = []
    // PRT-411：`buildContext` 到底做成了什么。初值**不是** `null` 而是"还没走到"，
    // 这样"阶段没跑到"与"阶段跑了但没冻结快照"不会被同一个 `null` 混为一谈。
    let contextEvidence = { contextFrozen: false, kind: 'not-reached' }
    // PRT-253 续批：这次 Attempt 的三个运行输入**从哪来的**。
    // 初值 `null` = 还没算到那一步（与"算了但没有来源"分开，同 `contextEvidence` 的理由）。
    let lastRunInputs = null
    try {
      /**
       * §6.4 的流水线：**先持久化意图，再做副作用**。
       *
       * 每一步都是「(1) 把状态写成『我要做这件事』(2) 才真的去做」。
       * 顺序反过来的话，进程在做事的中途被杀就会留下一个**看起来没开始**的 Attempt：
       * 恢复扫描会认为它什么都没做，于是安全地重跑一遍——而它可能已经改过外部系统。
       * 顺序正确时，中途被杀留下的是 `PreparingWorkspace`/`BuildingContext`，
       * 恢复扫描据此知道「它已经越过某条边界」。
       *
       * 跑一步：先落状态，再干活；**把 lease 交给阶段**。
       *
       * 上一版这里有 `await run()` —— 不传参数。做空的 `inPlaceStages()`
       * 不需要租约，于是没有人发现"阶段拿不到自己在给哪条任务干活"。
       * 而真正的工作区阶段**必须**知道 `taskId`/`attemptId`：它就是靠这两个
       * 决定在哪个槽位检出。拿不到时的表现不是报错，是
       * `taskId 不能用作路径片段：undefined` ——一条看起来像"参数没传"的错误，
       * 而真实原因是调用点漏了参数。
       */
      const step = async (to, run, stageName) => {
        const t = await hub.transition({ attemptId: claimed.attemptId, leaseEpoch: claimed.leaseEpoch, workerId, to })
        trace.push(to)
        const detail = await run(claimed)
        return { transition: t, detail, stageName }
      }
      /**
       * 给阶段抛出的异常打上阶段名。
       *
       * 不打的话，`prepareWorkspace` 的异常会被上报成 `stage: 'execute'`——
       * 于是失败码变成 `runtime-unavailable`（可重试），而真实原因是
       * 「工作区没能建起来」。两者对运维的意义完全不同，而错误分类决定了要不要重试。
       *
       * ★ `...args` 而不是 `(lease)`：**转发必须是全量的**。
       *   写成一个具名形参时，多出来的实参会被静默丢掉——
       *   而调用点（`execute(claimed, runInputs)`）看起来完全正常。
       *
       *     > 一个"转发时只接一个参数"的包装，
       *     > 与一个"那个参数根本没被传"的实现，在调用点上是同一个东西——
       *     > 只不过前者的排障会指向调用点，而调用点是对的。
       */
      const tagStage = (stageName, fn) => async (...args) => {
        try {
          return await fn(...args)
        } catch (err) {
          if (err !== null && typeof err === 'object' && err.stage === undefined) err.stage = stageName
          throw err
        }
      }

      // ── 运行输入：`modelProfileRef` 要**先**问，排在建工作区之前 ────────────
      //
      // 位置是刻意的：解析员工的模型绑定是一次**纯读**，而 `prepareWorkspace`
      // 会在磁盘上建一个真的 worktree（有副作用）。顺序反过来时，
      // "这个岗位没有模型绑定"这条**配置**错误会在留下一个 worktree 之后才暴露——
      // 而那个 worktree 没有任何人会用，只能等回收。
      //
      //   > 一个"先做副作用、再发现配置错了"的顺序，
      //   > 与一个"先做副作用、然后照样跑下去"的顺序，
      //   > 在磁盘上留下的是同一个东西。
      let modelProfileRef = null
      if (modelProfileRefFor !== null) {
        const reading = await modelProfileRefFor(claimed)
        // 端口可以返回字符串（简单形态），也可以返回判别式联合（要带理由时）。
        // 两种都收，但**只有明确为成功**时才取值——一个"读到个对象就当能用"的写法，
        // 会在端口返回 `{ok:false, message:…}` 时把整个对象当成模型 id 传下去。
        if (typeof reading === 'string') modelProfileRef = reading
        else if (reading !== null && typeof reading === 'object' && reading.ok === true) {
          modelProfileRef = reading.modelProfileRef ?? null
        }
      }

      const workspaceStep = await step('PreparingWorkspace', tagStage('prepareWorkspace', stageImpl.prepareWorkspace), 'prepareWorkspace')
      // ★ 这一步的结果此前**被丢掉**（`step()` 返回了它，没人接）。
      //   而 `workdir` 正是"这次 Attempt 在哪个目录里干活"的唯一权威来源：
      //   有隔离时那是独立的 worktree 槽位，原地执行时是被授权的项目目录。
      //   丢掉它，就等于让执行引擎去猜自己该改哪个目录。
      const workspaceDetail = workspaceStep.detail ?? null

      const runInputs = resolveRunInputs({
        lease: claimed,
        workspace: workspaceDetail,
        projectDir,
        modelProfileRef,
      })
      // ★ 装配不齐**不在本层判死**，而是原样交给执行引擎。
      //
      // 第一版在这里抛了具名错。那个写法是错的，理由不是"更麻烦"，而是**分工**：
      // "这次请求需要哪些字段"是执行引擎的事——调用方可以给自己一条 `requestFor`
      // （`can-read-authorization-source.test.mjs` 例② 就是那么做的），
      // 它完全可能从别处装出请求来。本层擅自判死，等于替执行引擎决定它需要什么。
      //
      // 于是判据只有一处：`defaultRequestFor()` 自己那次具名拒绝
      // （"缺 3 个必填字段" + 现在会一并说清**装配为什么拒绝**）。
      // 本层做的是另一件事——**把出处记下来**，因为只有这里知道
      // "哪个值是从哪来的"。
      //
      //   > 一个"本层也判一次"的实现，与一个"判据只有一处"的实现，
      //   > 在两边都写对了的时候是同一个东西——只不过前者会在某一处
      //   > 先漂移，而漂移的那一次表现为"执行引擎说缺字段、而值就在旁边"。
      if (runInputs.ok !== true) {
        logger(`[worker] ⚠ 运行输入装配不完整（${runInputs.code}）：缺 ${runInputs.missing.join('、') || '（无）'}`
          + '——原样交给执行引擎判（判据只有那一处）；若引擎拒绝，原因会在它的报错里')
      }
      lastRunInputs = {
        ok: runInputs.ok,
        code: runInputs.code,
        missing: [...runInputs.missing],
        sources: { ...runInputs.sources },
      }

      // PRT-411：把 buildContext 的结果**留下来**。
      //
      // 它此前被 `step` 返回、然后**被丢掉**。于是无论这个阶段做没做、做了什么，
      // 证据里都只有一条状态迁移——`kind: 'minimal'`（"没有上下文快照"）
      // 与一份真的冻结好的快照在记录上**完全一样**。
      // 状态文件里那句"无上下文快照"因此从来没有到达过任何能被人读到的地方。
      //
      // 这里不做"有就存没有就跳过"：`contextFrozen` 是可判定的，
      // 所以把两种情形分别**写进证据**，让人翻记录时一眼看出是哪一种。
      const contextStep = await step('BuildingContext', tagStage('buildContext', stageImpl.buildContext), 'buildContext')
      const contextDetail = contextStep.detail
      contextEvidence = {
        contextFrozen: stageImpl.contextFrozen === true && contextDetail?.kind === 'frozen',
        kind: contextDetail?.kind ?? 'unknown',
        snapshotHash: contextDetail?.snapshotHash ?? null,
        includedCount: contextDetail?.includedCount ?? null,
        excludedCount: contextDetail?.excludedCount ?? null,
        truncationCount: contextDetail?.truncationCount ?? null,
        redactionCount: contextDetail?.redactionCount ?? null,
        tokensKind: contextDetail?.tokensKind ?? null,
        canReadDefaulted: contextDetail?.canReadDefaulted ?? null,
        note: contextDetail?.note ?? null,
      }
      await step('Running', async () => null, 'running')
      // ★ 第二个实参：运行输入随这次调用一起交给执行引擎。
      //   不并进 `claimed` 是刻意的（见 `execute()` 的 JSDoc）：租约是控制面给的凭据，
      //   而这三项是**本进程**推导出来的——混成一个对象之后，
      //   "控制面这次没给"这件事就再也查不出来了。
      const result = await tagStage('execute', stageImpl.execute)(claimed, runInputs)
      const outcome = result?.outcome ?? 'failed'
      if (outcome === 'completed') counters.completed += 1
      else if (outcome === 'outcome_unknown') counters.unknownOutcome += 1
      else counters.failed += 1
      counters.consecutiveFailures = 0
      lastError = outcome === 'completed' ? null : { stage: 'execute', message: result?.detail ?? outcome }
      // ★★ 失败必须走 `fail`，**不能**走 `transition` —— 见 `submitFailure` 的注释。
      //
      // 判据是 `outcome`，不是"有没有抛异常"：执行器**返回** `{outcome:'failed'}`
      // 与它**抛出**异常是同一件事（这次运行失败了），必须走同一个出口。
      // 原先这里只有一条 `hub.transition({outcome, ...})`，于是返回值失败那条路
      // （**常见**形态：适配器把引擎故障分类成 `run.failed` 终态、不往外抛）
      // 只被记了一笔就结束了，任务静默地变成"永远领不到的 todo"。
      if (outcome === 'failed') {
        // 失败码用 worker 自己的词表（与 `catch` 那条路一致）。
        // 引擎自己的 `code` **不**搬到这里来：它在 `runResult` 里原样存着
        // （`result_json.code`），把两套词表混进同一列，事后就分不出哪一列是谁说的。
        const reported = await submitFailure({
          claimed,
          failureCode: classifyStageFailure('execute'),
          detail: result?.detail ?? 'execute-failed',
          runResult: result?.runResult ?? null,
          // F-05 前半：**失败的 Run 同样要带事件明细上去**。
          // "它在失败之前做了什么"正是最需要复盘的一次；只给成功的 Run 记明细，
          // 会让每一次失败都变成一段空白，而复盘的人无从下手。
          runEvents: result?.runEvents ?? null,
          runEventsTruncated: result?.runEventsTruncated === true,
        })
        stopHeartbeat()
        currentLease = null
        publish('idle')
        // 形状与 `catch` 那条路**一致**：调用方不该因为"失败是抛出来的还是返回的"
        // 而拿到两种不同的信封。
        return { acted: true, outcome: 'failed', error: lastError, reported: reported !== null, trace }
      }
      // 提交终态由 hub 负责（它才知道 leaseEpoch 与事务边界）；worker 只报告结果。
      // **结果未知**时同样要提交：`outcome_unknown` 的去向是「等人工」而不是「重试」
      // （状态机与仓储都拒绝让 UnknownOutcome 回到队列），
      // 于是「外部写结果不可确认」这件事才不会被一次自动重试变成重复副作用。
      //
      // ⚠️ 这里**只**处理 `completed` / `outcome_unknown`。它们与 `failed` 的去向
      // 是**相反**的：把它们也送进 `fail` 会排一次自动重试，也就是把"可能已经
      // 付过费的外部写"再执行一遍——本仓最不能犯的方向。
      await hub.transition({
        attemptId: claimed.attemptId,
        leaseEpoch: claimed.leaseEpoch,
        workerId,
        outcome,
        // PRT-312：`runResult` 必须随这次迁移一起上去。状态机为
        // `Running → Validating / RetryableFailure / UnknownOutcome` 声明的
        // `requiresPersist: ['attempt','runResult']` 是在 **hub 侧**核验的，
        // 而 hub 唯一可能的来源就是这里——漏掉这一个字段，执行侧算出来的结果
        // 就永远到不了库里，那条声明也就永远只是事件流里的一句话。
        // 注意这与 `detail` **不是**二选一：`detail` 是给人看的一句话摘要，
        // `runResult` 是给机器判的凭据（机器验收要按它判判据）。
        context: {
          detail: result?.detail ?? null, runResult: result?.runResult ?? null, trace, frozen: contextEvidence,
          // PRT-253 续批：运行输入的**出处**随终态一起上去。
          //
          // 为什么出处也要上报，而不是只上报值：这三个值里哪几个是控制面给的、
          // 哪几个是本进程从"空间 / worktree 槽位 / 员工模型绑定"推出来的，
          // 是"下一次该往哪修"的唯一线索。只留合并后的值，等于把
          // "控制面这次没给"这件事永久地从证据里抹掉。
          runInputs: lastRunInputs,
          // F-05 前半：事件明细随**同一次**终态迁移上去。放在 `context` 里而不是
          // 单独一个请求，是为了让"终态"与"明细"在同一个事务里落地——
          // 分成两次请求时，崩在中间会留下一条没有明细的终态，而读的人
          // 无法区分"这次 Run 没有明细"与"明细丢在路上了"。
          runEvents: result?.runEvents ?? null,
          runEventsTruncated: result?.runEventsTruncated === true,
        },
      })
      stopHeartbeat()
      currentLease = null
      publish('idle')
      return { acted: true, outcome, trace }
    } catch (e) {
      counters.failed += 1
      counters.consecutiveFailures += 1
      lastError = { stage: e?.stage ?? 'execute', message: String(e?.message ?? e) }
      // 中途失败要**如实上报**，而不是让 Attempt 停在 PreparingWorkspace 等租约过期：
      // 停在那儿的话，恢复扫描只能按「有没有可能已产生外部副作用」去猜，
      // 而我们知道得更多——我们知道它失败在哪一步、有没有越过 Running。
      stopHeartbeat()
      const code = e?.code === 'LEASE_EPOCH_STALE' ? 'lease-epoch-stale' : (e?.failureCode ?? classifyStageFailure(e?.stage))
      // 走 `fail`（服务端单一入口），而不是 `transition({to:'RetryableFailure'})`。
      //
      // 差别是**实质**的，不是风格：`transition` 只把这次尝试标成失败就结束了，
      // 而"接下来怎么办"（还有额度就排新尝试、额度用完就进 Dead Letter）没人做。
      // 结果是任务永远停在 `RetryableFailure`——既没有可领的队列，也不在等人工清单里
      // （它不是 DeadLetter/UnknownOutcome），从任何界面看都只是"失败了"，
      // 而没有任何人会去处理它。这类缺陷不会报错，只会让任务安静地停在那里。
      //
      // ⚠️ 本批修掉的正是"上面这段话只对抛错那条路成立"：返回值失败那条路
      // （**常见**形态：适配器把引擎故障分类成 `run.failed` 终态、不往外抛栈）
      // 原先走的是 `transition`。现在两条路共用 `submitFailure` 这一个出口，
      // 它保证不抛，所以这里不需要再包一层 try/catch。
      const reported = await submitFailure({
        claimed,
        failureCode: code,
        detail: lastError.message,
        // 抛错这条路**手里没有**引擎产出（根本没收到的终态事件），如实给 null：
        // hub 侧那一行会是 `source: 'report-only'`，而不是伪造一个空结果。
        runResult: null,
        // F-05 前半：但**事件明细可能有**——`executor` 在抛出时把已经收到的事件
        // 挂在错误对象上（见那里的注释）。那正是"它在炸之前做了什么"的唯一来源。
        runEvents: Array.isArray(e?.runEvents) ? e.runEvents : null,
        runEventsTruncated: e?.runEventsTruncated === true,
      })
      currentLease = null
      publish('idle')
      return { acted: true, outcome: 'failed', error: lastError, reported: reported !== null, trace }
    }
  }

  /** 主循环。连续失败到阈值后进入慢速退避，而不是继续高频重试。 */
  async function loop() {
    publish('starting')
    logger(`[worker] 启动：hub=${hub === null ? '未配置' : '已配置'} executor=${executor === null ? '未配置' : '已配置'}`)
    while (running && !stopped) {
      const r = await tick()
      if (!running || stopped) break
      const backoff = counters.consecutiveFailures >= maxConsecutiveFailures ? failureBackoffMs : pollIntervalMs
      if (r.reason === 'claim-failed') {
        logger(`[worker] 认领失败（连续 ${counters.consecutiveFailures} 次）：${lastError?.message ?? ''}`)
        if (counters.consecutiveFailures >= maxConsecutiveFailures) {
          logger(`[worker] 连续失败达阈值 ${maxConsecutiveFailures}：转入 ${failureBackoffMs}ms 退避（不退出，等待 hub 恢复）`)
        }
      }
      await sleep(r.acted ? pollIntervalMs : backoff)
    }
  }

  return {
    get state() { return state },
    get counters() { return Object.freeze({ ...counters }) },
    get statusPath() { return resolvedStatusPath },
    get isRunning() { return running },

    /** 启动主循环（幂等：重复调用返回同一个 promise）。 */
    start() {
      if (loopPromise !== null) return loopPromise
      running = true
      stopped = false
      // 没装闸门时**在启动时说一次**。这是一个配置事实，不是每轮都变的运行状态；
      // 每轮都报的那种告警会被学会忽略，而它要说的事恰好最容易被忽略：
      // 产品状态（升级中 / 不可用 / 部分能力）拦不住这个 worker。
      if (!gateInstalled) {
        logger('[worker] ⚠ **没有安装认领闸门**（claimGateMode=not-installed）：本 worker 会照常认领。'
          + '生产入口 product/orchestrator/worker.mjs 总是装一个；'
          + '看到这一行说明有调用方绕过了它——那样"正在升级"与"Runtime 不可用"'
          + '都不会阻止这个 worker 把任务领走。')
      }
      loopPromise = loop()
      return loopPromise
    },

    /** 跑一轮（供测试与「单次扫单」用法）。 */
    tick,

    /**
     * 优雅停止：停止认领 → 释放持有的 lease → 写终态。
     *
     * 释放 lease 这一步不能省：不释放的话任务要等租期自然过期才能被别的 worker 领走，
     * 而这段时间里队列看起来是「卡住」的——一个没有任何错误信息的故障。
     *
     * ⚠️ **已知边界**：正在执行的 executor 不会被中断（中断需要把 AbortSignal 一路穿到
     * RuntimeAdapter，属 PRT-302/311）。因此停止后它仍可能返回并提交一次终态。
     * 那条提交是否被接受，取决于 team-hub 的 leaseEpoch 校验（PRT-313）——
     * 这也是为什么 epoch 校验不是优化项：没有它，这里的「先释放再提交」会成功。
     */
    async stop({ reason = '收到停止信号', release = true } = {}) {
      if (stopped && !running) return { ok: true, alreadyStopped: true }
      stopped = true
      running = false
      stopHeartbeat()
      publish('stopping', { stopReason: reason })
      let released = null
      if (release && currentLease !== null && hub !== null && typeof hub.release === 'function') {
        try {
          released = await hub.release({ attemptId: currentLease.attemptId, leaseEpoch: currentLease.leaseEpoch, workerId, reason })
        } catch (e) {
          released = { ok: false, message: String(e?.message ?? e) }
          logger(`[worker] 释放 lease 失败：${released.message}（任务将等待租期自然过期）`)
        }
      }
      currentLease = null
      // 不 await 主循环：它可能正睡在 pollIntervalMs 里，等它会让 Ctrl+C 显得没反应。
      // 循环会在下一轮开头看到 stopped 并退出，入口 await 的是循环本身。
      publish('stopped', { stopReason: reason })
      logger(`[worker] 已停止（原因：${reason}）`)
      return { ok: true, released, statusPath: resolvedStatusPath }
    },

    /** 求值当前状态文件（供 CLI / 诊断使用）。 */
    readStatus() {
      return readStatusFile(resolvedStatusPath)
    },

    /**
     * 组装当前状态对象而**不落盘**。
     *
     * 给运维与用例一个"现在外部会看到什么"的读取点。落盘版本的字段与它完全一致
     * （`publish` 就是调它再写文件），因此断言这里等于断言状态文件，
     * 而不必为了读一个字段去建目录、写文件、再解析回来。
     */
    status(extra = {}) {
      return Object.freeze(buildStatus(state, extra))
    },

    /** 读回写给外部看的状态（不落盘，供测试断言）。 */
    snapshot() {
      return Object.freeze({
        workerId,
        state,
        counters: Object.freeze({ ...counters }),
        lastError,
        leaseMayBeLost,
        executorConfigured: executor !== null && executor !== undefined,
        hubConfigured: hub !== null,
        lastStatusWrite: lastStatusWrite === null ? null : { ok: lastStatusWrite.ok, removed: lastStatusWrite.removed },
      })
    },
  }
}
