// orchestrator/config-schema.mjs
// ============================================================================
// orchestrator（Legion Orchestrator worker）的配置面声明（PRT-301 起）
//
// 本进程从环境读取的全部键都在这里登记。`scripts/config/scan.mjs --check`
// 会拿这份声明与本进程目录下的真实读取点对账：**读取点没声明 → 门禁失败**。
//
// 使用 `defineSchema` 而不是手写对象：`scan.mjs` 调的是 `SCHEMA.envNames()`，
// 手写对象会让门禁在运行时报 `envNames is not a function`——也就是「配置面声明
// 写错了」这件事要到 CI 才被发现，而它本该在导入时就报错。
//
// `nonEnvLiterals` 登记的是「看起来像 env 键、其实不是」的字面量：
// 状态名、错误码、HTTP 路径、请求头等。它们必须显式登记，否则扫描器会把
// `'application/json'`、`'authorization'` 这类字符串报成未声明的 env 读取。
// 这不是噪声——把真实读取点从这个列表里区分出来，正是门禁能起作用的前提。
// ============================================================================
import { defineSchema } from '../packages/shared/src/config.mjs'

/** 本进程读取的环境变量（逐字出现在代码里，见 orchestrator/worker/run.mjs）。 */
export const ENV_NAMES = Object.freeze([
  'TEAM_HUB_URL',
  'TEAM_HUB_TOKEN',
  'LEGION_DATA_DIR',
  'LEGION_RUNTIME_COMMAND',
  'LEGION_WORKER_ID',
  // PRT-306：worktree 从用户授权的项目目录检出。
  'LEGION_WORKSPACE_DIR',
])

/**
 * 不是 env 键、但写法上形如 env 键的字面量。
 *
 * 每条都注明来源，因为「为什么这个字符串在名单里」是下一个人会问的第一个问题。
 */
export const NON_ENV_LITERALS = Object.freeze([
  // HTTP 头与内容类型（worker/run.mjs 的 hub 客户端）
  'authorization', 'Authorization', 'content-type', 'application/json',
  // 数据面路由（worker/run.mjs）
  '/api/runtime/claim', '/api/runtime/heartbeat', '/api/runtime/transition', '/api/runtime/release',
  // worker 状态名（worker/main.mjs 的 WORKER_STATES，也被状态文件写入）
  'starting', 'no-executor', 'hub-unreachable', 'idle', 'claiming', 'executing', 'stopping', 'stopped',
  // 状态文件的禁用键（worker/status-file.mjs 的 FORBIDDEN_STATUS_KEYS）
  'token', 'TEAM_HUB_TOKEN', 'secret', 'password', 'apiKey', 'api_key',
  // 失败分类与恢复动作（state-machine 的具名码）
  'retryable', 'unknown-outcome', 'fatal',
  'none', 'claim-eligible', 'wait', 'resume-in-place', 'retry-new-attempt',
  'mark-unknown-outcome', 'await-human',
  // 执行结果名义
  'completed', 'failed', 'outcome_unknown', 'cancelled',
  // 具名错误码
  'STATUS_WRITE_FAILED', 'EXTERNAL_EFFECT_UNKNOWN', 'FAILURE_CODE_REQUIRED', 'DATA_DIR_REQUIRED',
  'ATTEMPT_NO_INVALID', 'BACKOFF_BASE_INVALID', 'BACKOFF_FACTOR_INVALID',
  // 运行面仓储的具名码（team-hub/run-store.mjs 的 RUN_ERRORS）。
  // worker 之所以要认得 `LEASE_EPOCH_STALE`，是因为它的含义是「你已被接管」——
  // 对应的动作是**停手**，而不是像 `LEASE_EXPIRED` 那样「加快或停手」。
  // 两者若被压成同一个码，worker 只能靠文案猜，而文案会变。
  'LEASE_EPOCH_STALE', 'LEASE_EXPIRED', 'LEASE_NOT_HELD', 'ATTEMPT_NOT_FOUND',
  'WORKER_REQUIRED', 'EPOCH_REQUIRED', 'BAD_LEASE_TTL', 'UNKNOWN_OUTCOME',
  'TRANSITION_REJECTED', 'MISSING_PARAM',
  // 原地执行的阶段类型（worker/main.mjs 的 inPlaceStages，会被写进 Attempt 证据）
  'in-place', 'minimal',
  // 缺阶段时 worker 的状态名
  'no-stages',
  // 状态机的具名错误码（state-machine/transitions.mjs 的 TRANSITION_ERRORS 与 states.mjs）。
  // 它们被逐个列出而不是用前缀通配：通配会让这个清单失去「哪些疑似项已被审阅」的意义，
  // 而这份清单的价值恰恰在于「每一条都被看过一次」。
  'UNKNOWN_FROM_STATE', 'UNKNOWN_TO_STATE', 'TRANSITION_FROM_TERMINAL', 'ILLEGAL_TRANSITION',
  'STALE_STATE', 'UNKNOWN_OUTCOME_NOT_RETRYABLE', 'MISSING_GUARD_INPUT', 'TRANSITION_GUARD_FAILED',
  'RETURN_TO_REQUIRED', 'UNKNOWN_ATTEMPT_STATE', 'RETRY_BUDGET_REQUIRED', 'APPROVAL_ORIGIN_REQUIRED',
  // 系统信号（run.mjs 的优雅停止）
  'SIGINT', 'SIGTERM',
  // PRT-307 机器验收的具名码（orchestrator/acceptance/index.mjs）。
  // 它们与上面那批状态机码同理：逐条登记而不是加通配前缀，
  // 这份清单的价值在于「每一条都被看过一次」。
  'accepted', 'rejected', 'needs-human',        // ACCEPTANCE_DECISIONS（三种结论）
  'run-completed', 'structured-result', 'artifact', 'manual',  // CRITERION_KINDS
  'CRITERIA_NOT_ARRAY', 'RUN_RESULT_INVALID',   // ACCEPTANCE_ERRORS
  'UNKNOWN_DECISION',                           // acceptanceTarget 的未知结论文案
  // PRT-305 岗位与流水线的具名码（orchestrator/pipeline/index.mjs）
  'UNKNOWN_ROLE', 'NO_SUCH_SCOPE',
  // PRT-306 工作区隔离的具名码（orchestrator/workspace/index.mjs 的 WORKSPACE_ERRORS）。
  // 每一条都是一次**拒绝**：不安全的 id、相对路径、布局重叠、未配置、
  // 陌生槽位、git 失败、脏工作区、未知槽位。逐条登记而不是加前缀通配——
  // 这份清单的价值在于「每一条都被看过一次」。
  'REF_UNSAFE_ID', 'REF_NOT_ABSOLUTE', 'REF_OVERLAP', 'REF_NOT_CONFIGURED',
  'REF_FOREIGN_SLOT', 'REF_WORKTREE_FAILED', 'REF_DIRTY', 'REF_UNKNOWN_SLOT',
  'GIT_FAILED',
  // 工作区槽位的种类与意图文件
  'absent', 'empty', 'foreign', 'our-worktree', 'UNKNOWN',
])

export const SCHEMA = defineSchema({
  process: 'orchestrator',
  title: 'Legion Orchestrator worker（扫单 / 认领 / 派工；PRT-301 起）',
  // 只声明 `LEGION_`，**不声明 `TEAM_HUB_`**，虽然本进程确实读两个 TEAM_HUB_* 变量。
  //
  // 原因是一次实测：加上 `TEAM_HUB_` 前缀后，`check --strict` 立刻对
  // TEAM_HUB_PORT / TEAM_HUB_HOST / TEAM_HUB_DB 报「前缀属于本进程但未在 schema 中声明」——
  // 而这三个变量**属于 team-hub 自己**，orchestrator 不该声明它们。
  // 前缀机制是「拼写错误告警」，前提是「该前缀下的变量都属于我」；
  // 在共享的 TEAM_HUB_* 变量族里只拥有两个成员时，这个前提不成立。
  // 于是改用 `foreignEnv` 逐个登记（见下），代价是显式，收益是不产生假告警——
  // 而假告警会让人习惯性忽略 warnings，那正是这个机制失效的方式。
  prefixes: ['LEGION_'],
  foreignEnv: [
    { name: 'TEAM_HUB_PORT', owner: 'team-hub', reason: 'hub 的监听端口，由 Launcher 注入给 team-hub；worker 经 HTTP 访问，不读它' },
    { name: 'TEAM_HUB_HOST', owner: 'team-hub', reason: '同上（监听地址）' },
    { name: 'TEAM_HUB_DB', owner: 'team-hub', reason: 'hub 的 SQLite 路径；worker 不直接开库（数据面单源）' },
  ],
  nonEnvLiterals: NON_ENV_LITERALS,
  fields: [
    {
      key: 'hubUrl', env: 'TEAM_HUB_URL', type: 'string', default: '',
      doc: 'team-hub 数据面地址；缺失时 worker 以 hub-unreachable 状态运行（**不认领**，但仍如实报告）',
    },
    {
      key: 'hubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true,
      doc: '数据面凭证；**绝不写入状态文件**（见 worker/status-file.mjs 的禁用键名单）',
    },
    {
      key: 'dataDir', env: 'LEGION_DATA_DIR', type: 'path', default: '',
      doc: '数据目录；worker 状态文件写在其下的 orchestrator/worker.status.json。缺失时进程直接以退出码 8 结束',
    },
    {
      key: 'runtimeCommand', env: 'LEGION_RUNTIME_COMMAND', type: 'string', default: '',
      doc: '执行引擎命令行；**未配置时 worker 不认领任何任务**（认领会立刻失败并把重试额度烧光）',
    },
    {
      key: 'workerId', env: 'LEGION_WORKER_ID', type: 'string', default: '',
      doc: 'worker 标识；默认 worker-<pid>',
    },
    {
      key: 'workspaceDir', env: 'LEGION_WORKSPACE_DIR', type: 'path', default: '',
      doc: 'PRT-306：用户授权的项目目录，每次 Attempt 从它检出一份隔离的 git worktree。' +
        '**未配置时不认领任何任务**——不自动退回原地执行：那会让两个 worker 在同一个目录里' +
        '改同一份文件，而那种冲突不报错（表现为"改的东西莫名不见了"）',
    },
  ],
  notes: [
    '状态文件（DataDir/orchestrator/worker.status.json）是这类「无监听端口」进程的唯一观测出口：' +
      'Launcher 对 orchestrator 声明的就绪判据是 none，也就是「进程起来了」=「好了」，' +
      '而 worker 可能起来了但拿不到 hub、没有执行引擎或正在退避——没有状态文件这三种情况外部完全同形。',
    '状态文件的**新鲜度**必须单独判定（worker/status-file.mjs 的 isStatusFresh）：' +
      'Windows 上任何「终止」都是无条件终止，接收方的信号处理器不会被调用，' +
      '因此文件会永远停在最后一刻的值——「文件存在」与「worker 还活着」是两件事。',
    'TEAM_HUB_TOKEN 在两个名单里都出现是有意的：ENV_NAMES 是**读取声明**（进程确实要读它），' +
      'nonEnvLiterals 是**写入禁令**（禁用键名单里也写了这个字符串）。两个方向都要约束。',
  ],
})
