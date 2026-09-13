// orchestrator/worker/sources-loader.mjs
// ============================================================================
// PRT-402~406 的**生产数据面**：把 hub 上真有的东西读成装配路由要的 `sources`
//
// ## 为什么需要这个模块
//
// `runtime/context/sources.mjs` 把九类来源的归一、信任与截断都做全了
// （`collectCandidates` 一个入口），`createHubContextStage` 也早就留好了
// `loadSources(lease)` 这个注入点——而它的**默认值是 `async () => ({})`**：
//
//   > 一个"零来源"的运行会冻结出一份**完全合法**的空快照。
//   > 于是"这次运行看了 0 个来源"与"我们忘了接线"在下游是同一种记录，
//   > 而模型会照着一份空上下文继续跑完，并把结论写进回执。
//
// kill-drill 走的正是这条路（发零来源 → 合法空快照），所以这个缺口在
// 演练里**看起来完全正常**。本模块就是那条接线。
//
// ## 这个模块唯一要紧的纪律：读失败 ≠ 没有
//
// hub 上有的东西读不到，与 hub 上根本没有这条路，是**两件不同的事**，
// 而它们在快照里都表现为"这条来源不在"：
//
//   · **没有这条路**（例如 hub 至今没有 teamPlan 的读端点）→ 这是世界的形状，
//     如实声明为不可用，快照记 `missing` 并带上原因。
//   · **有这条路但这次读失败**（超时、500、连接断了）→ 这**不是**
//     "这个任务没有评论"，而是"我们没问到"。此时必须**抛错**。
//
//   > 一次"读失败"被当成"没有"，与一次"真的没有"，
//   > 在快照里长得一模一样——只不过前者会让模型基于一份不完整的世界观
//   > 得出结论，而快照上写着"来源已完整清点"。
//
// 这条区分是本模块存在的理由。把上面两种都归成"读不到就算了"的实现，
// 会让每一次网络抖动都静默地变成一次"上下文更少的运行"。
//
// ## 与 PRT-401 的分工
//
// `sources.mjs` 决定"这些来源**该不该**进上下文"（信任、权限、裁剪）；
// 本模块只决定"**能拿到哪些**"。两边都不越界：这里不判权限，
// 也不替调用方决定哪个来源必需。
// ============================================================================

import { createHash } from 'node:crypto'

export const SOURCES_LOADER_CODES = Object.freeze({
  /** 依赖没给对（缺 read 等）。接线错误必须在构造期说清，不能推迟到某次运行。 */
  BAD_WIRING: 'SOURCES_LOADER_BAD_WIRING',
  /** lease 上没有 scope：来源会被放进哪个空间无从判断。 */
  NO_SCOPE: 'SOURCES_LOADER_NO_SCOPE',
  /** lease 上没有 taskId。 */
  NO_TASK_ID: 'SOURCES_LOADER_NO_TASK_ID',
  /** 任务不存在——这个 Attempt 是为一个不存在的任务领的。 */
  TASK_NOT_FOUND: 'SOURCES_LOADER_TASK_NOT_FOUND',
  /** 读失败（**不是**"没有"）。见文件头那段。 */
  READ_FAILED: 'SOURCES_READ_FAILED',
})

/**
 * hub 上**没有读端点**因此拿不到的来源族。
 *
 * 这份清单是**量出来的**，不是推断的：逐个在 `team-hub/server.mjs` 里
 * 找过 `GET path === …` 的声明（见 `docs/superpowers/prt/PRT-402-406-source-wiring.md` §3）。
 *
 * 为什么要把它们**列出来**而不是干脆不提：
 * "这条来源不在快照里"与"这一类来源我们根本取不到"在账本上长得一样。
 * 列出来之后，运维能一眼看出缺的是**产品的**这一块，而不是自己的配置。
 */
export const UNSERVED_SOURCE_FAMILIES = Object.freeze([
  Object.freeze({
    key: 'teamPlan',
    reason: 'hub 没有 TeamPlan 的读端点（`/api/missions` 是按 role 聚合的任务视图，'
      + '与 TeamPlan 记录不是同一个东西，拿它冒充会让"团队计划"变成一份当前任务的镜像）',
  }),
  Object.freeze({
    key: 'employeeManifest',
    reason: 'hub 没有 EmployeeManifest 的读端点（`/api/members` 只有在线的成员 id/kind，'
      + '没有职责边界与工具范围——而 manifest 进上下文的**全部意义**就是让模型读到自己的边界）',
  }),
  Object.freeze({
    key: 'userFeedback',
    reason: 'hub 没有用户反馈的独立读端点（`userFeedback` 在 `sources.mjs` 里是**另一个类型**：'
      + '"要不要按反馈调整"的处理与评论不同，所以不能拿任务评论去填它）',
  }),
  Object.freeze({
    key: 'upstreamDeliveries',
    reason: 'hub 的 `/api/runtime/handoffs` 是 worker 的移交状态，不是上游员工的交付物；'
      + '两者混用会把"某个 worker 交出了租约"读成"上游交付了一份成果"',
  }),
  Object.freeze({
    key: 'workspaceState',
    reason: 'hub 没有工作区状态的读端点（工作区是 worker 本机的目录，'
      + '由后续的工作区阶段提供，不在 hub 的读面里）',
  }),
])

/** 源文件里出现过、但这里**刻意不消费**的读端点，连同不消费的理由。 */
export const UNCONSUMED_ENDPOINTS = Object.freeze([
  Object.freeze({
    path: '/api/artifact/content',
    reason: '产物默认**只给引用**（PRT-405）：正文通常很大，"要不要读进来"是一个预算决定，'
      + '该由调用方显式做。本装配器不替它决定。',
  }),
  Object.freeze({
    path: '/api/skill-source',
    reason: '已发布的 skill **正文**同样是一个体积决定；`/api/skills` 给出的条目已足以'
      + '让模型知道自己有哪些技能可用。',
  }),
])

/**
 * 由评论的三个字段算出一个**内容派生**的稳定 id。
 *
 * hub 的评论是 `{ by, at, text }`——**没有 id**。而 `commentSources` 要求
 * 非空 id，且 PRT-404 明确要求评论按 `(createdAtMs, id)` 排序：
 * "数据库查询顺序不是数据的一部分，它变了不该让快照哈希变"。
 *
 * 所以这里**不能**用数组下标当 id：下标把"查询顺序"偷偷变回了数据的一部分，
 * 一条评论被重新排序就会让同一个世界算出两个快照哈希——
 * 而快照哈希正是回放与篡改检测的凭据。
 *
 * 用内容派生：同一条评论**永远**得到同一个 id，与它排第几无关。
 */
export function commentIdOf({ by = null, at = null, text = '' } = {}) {
  const h = createHash('sha256')
    .update(`${by ?? ''}\u0000${at ?? ''}\u0000${text ?? ''}`, 'utf8')
    .digest('hex')
  // 取前 16 位：够用（64 bit），且让快照里的 id 还是人能看的东西
  return `c-${h.slice(0, 16)}`
}

/** ISO 时间或 epoch 数字 → epoch 数字；取不到就返回 undefined（由 sources.mjs 用自己的时钟兜底）。 */
export function epochMsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

/**
 * ★ 把 hub 的时间字段名补成 `sources.mjs` 要的 `*Ms` 名字。
 *
 * ## 这是一个**接线才暴露出来的**字段名错配
 *
 * `sources.mjs` 的契约是整数毫秒、字段名叫 `createdAtMs` / `updatedAtMs`：
 *
 * ```js
 * acquiredAtMs: acquiredAt(task.updatedAtMs ?? task.createdAtMs, 'Task', nowMs)
 * ```
 *
 * 而 hub 的 `rowToTask` 给的是 `createdAt` / `updatedAt`（ISO 字符串）。
 * 两边单独看都对——`acquiredAt` 甚至**能**解析 ISO 字符串
 * （它内部会 `Date.parse`）——错的是**字段名**：`updatedAtMs` 与 `updatedAt`
 * 是两个不同的键。
 *
 * 后果不是"少一个字段"，而是整个装配 **400 失败**：
 *
 * ```
 * Task 缺少取得时间（acquiredAtMs/createdAtMs/updatedAtMs 都不是整数毫秒）。
 * ```
 *
 * 而 `acquiredAt` 拒绝兜底成"现在"是**对的**（那会让同一份输入产生两个
 * 快照哈希，回放就没法验），所以正确的做法是在**边界**上换名字，
 * 而不是去放松那条拒绝。
 *
 * ## 为什么以前没人发现
 *
 * `taskSource` / `goalContextSource` / `publishedSources` 直到本批才第一次
 * 被喂真实 hub 对象——在那之前它们只有用例里手搓的输入，而那些输入
 * 恰好都用了 `*Ms` 的名字。
 *
 *   > 一个"用例里一直用对字段名"的模块，
 *   > 与一个"只认自己发明的时间字段名"的模块，是同一个东西——
 *   > 只不过前者的用例全绿，而它一接上真实数据就 400。
 *
 * 只补**缺的**键：调用方已经给了 `*Ms` 时不动它（用例手搓的输入走这条）。
 */
export function withEpochMs(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out = { ...obj }
  const pick = (...candidates) => {
    for (const c of candidates) {
      const t = epochMsOf(c)
      if (t !== undefined) return t
    }
    return undefined
  }
  const created = pick(out.createdAtMs, out.createdAt, out.created_at)
  const updated = pick(out.updatedAtMs, out.updatedAt, out.updated_at)
  if (created !== undefined) out.createdAtMs = created
  if (updated !== undefined) out.updatedAtMs = updated
  return out
}

/** 数组版的 `withEpochMs`（技能/文档/产物是一整批）。 */
function mapEpochMs(list) {
  return Array.isArray(list) ? list.map((x) => withEpochMs(x)) : []
}

class SourceLoaderError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SourceLoaderError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 把 hub 的读面接成 `loadSources(lease)`。
 *
 * @param {object} deps
 * @param {{read: (path: string) => Promise<any>}} deps.hub
 *   需要**读**能力（`read(pathAndQuery)`）。刻意不要求和 POST 同一个对象：
 *   `createHubClient` 的 POST 与读是两种用法，绑死会让本模块只能配那一个客户端。
 * @param {string|null} [deps.scope] 兜底空间（lease 上有 scope 时以 lease 为准）
 * @param {boolean} [deps.requireTask] 缺 taskId 时是否拒绝（默认 true）
 * @param {number} [deps.maxSkills] 最多带几条已发布技能（默认 50）
 * @returns {{loadSources: Function, availability: Function, lastReads: Function}}
 */
export function createHubSourceLoader({
  hub = null,
  scope = null,
  requireTask = true,
  maxSkills = 50,
  clock = () => Date.now(),
} = {}) {
  if (hub === null || typeof hub?.read !== 'function') {
    throw new SourceLoaderError(SOURCES_LOADER_CODES.BAD_WIRING,
      'createHubSourceLoader 需要一个提供 read(path) 的 hub 客户端：'
      + '没有它本装配器只能返回零来源，而零来源会冻结出一份**完全合法**的空快照')
  }
  if (!Number.isInteger(maxSkills) || maxSkills < 0) {
    throw new SourceLoaderError(SOURCES_LOADER_CODES.BAD_WIRING, 'maxSkills 必须是非负整数')
  }

  // 每次运行读了些什么。它不是日志，而是**可被断言的东西**：
  // "这次运行到底问了哪些端点"在排障时与"拿到了什么"一样重要。
  let reads = []

  /**
   * 读一次，把三类结果**分开**：
   *
   *   · 读到了        → 返回正文
   *   · 404（不存在） → 返回 `null`，由调用方决定这是不是致命
   *   · 别的失败      → **抛错**
   *
   * 第三类是重点：超时、500、连接断了都不是"这条来源不存在"。
   * 只有 404 才是"我问到了，它说没有"——那是**问过之后**才知道的事。
   */
  async function readOrThrow(path, { notFoundIsNull = false } = {}) {
    try {
      const body = await hub.read(path)
      reads.push(Object.freeze({ path, ok: true, status: 200 }))
      return body
    } catch (e) {
      const status = e?.status ?? null
      reads.push(Object.freeze({ path, ok: false, status }))
      if (notFoundIsNull && status === 404) return null
      // ★ 读失败**不是**"没有"。见文件头那段。
      throw new SourceLoaderError(SOURCES_LOADER_CODES.READ_FAILED,
        `读 ${path} 失败（${status ?? '无状态码'}）：${e?.message ?? e}。`
        + '这不是"没有这条来源"——把它当成没有，会让这次运行基于一份不完整的世界观继续下去，'
        + '而快照上写着"来源已完整清点"',
        { cause: e, path, status })
    }
  }

  /** 从若干候选里挑出属于本任务的那个目标。 */
  function pickGoal(goalBody, goalId) {
    const list = Array.isArray(goalBody) ? goalBody : (goalBody?.goals ?? [])
    if (!Array.isArray(list)) return null
    if (goalId === null || goalId === undefined) {
      // 没给 goalId：只有一个 active 目标时用它；多个时**不猜**
      // （猜错等于让模型照着一个不是它的目标干活）
      const active = list.filter((g) => g?.status === 'active')
      return active.length === 1 ? active[0] : null
    }
    return list.find((g) => g?.id === goalId) ?? null
  }

  /** 任务的评论 → `commentSources` 要的形状（补上 hub 没给的稳定 id 与 epoch 时间）。 */
  function toComments(task) {
    const raw = Array.isArray(task?.comments) ? task.comments : []
    return raw.map((c) => ({
      id: commentIdOf({ by: c?.by, at: c?.at, text: c?.text }),
      author: c?.by ?? null,
      body: c?.text ?? '',
      createdAtMs: epochMsOf(c?.at),
    }))
  }

  return Object.freeze({
    /**
     * @param {object} lease 认领到的 Attempt（至少要 `taskId`；`scope` 优先用它的）
     * @returns {Promise<object>} 交给装配路由 `sources` 的高层输入
     */
    async loadSources(lease) {
      if (lease === null || typeof lease !== 'object') {
        throw new SourceLoaderError(SOURCES_LOADER_CODES.BAD_WIRING, 'loadSources 必须拿到 lease')
      }
      reads = []
      const effScope = lease.scope ?? scope
      if (typeof effScope !== 'string' || effScope === '') {
        throw new SourceLoaderError(SOURCES_LOADER_CODES.NO_SCOPE,
          'lease 上没有 scope：来源该放进哪个空间无从判断，而放错空间就是一次越权')
      }
      const taskId = lease.taskId ?? lease.task_id ?? null
      if ((taskId === null || taskId === '') && requireTask) {
        throw new SourceLoaderError(SOURCES_LOADER_CODES.NO_TASK_ID,
          'lease 上没有 taskId：读不到任务定义时装配出来的上下文里没有"这次要做什么"，'
          + '而模型会照样跑完并给出结论')
      }

      // ── 任务（评论与产物引用都在这一行里，见 rowToTask）──
      let task = null
      if (typeof taskId === 'string' && taskId !== '') {
        // 404 → null：任务真的不存在与"读不到"是两件事，
        // 前者是这个 Attempt 本身的处境（领了一个不存在的任务），
        // 后者是基础设施的问题。两者的修复动作完全不同。
        task = await readOrThrow(`/api/task?id=${encodeURIComponent(taskId)}`, { notFoundIsNull: true })
        if (task === null || typeof task !== 'object') {
          throw new SourceLoaderError(SOURCES_LOADER_CODES.TASK_NOT_FOUND,
            `任务 ${taskId} 读回来是空的：这个 Attempt 是为一个不存在的任务领的`)
        }
      }

      // ── 目标（按任务的 goalId 精确取，取不到就不给）──
      let goal = null
      const goalBody = await readOrThrow(`/api/goal?scope=${encodeURIComponent(effScope)}`, { notFoundIsNull: true })
      goal = pickGoal(goalBody, task?.goalId ?? lease.goalId ?? null)

      // ── 已发布技能 ──
      const skillsBody = await readOrThrow(`/api/skills?scope=${encodeURIComponent(effScope)}`, { notFoundIsNull: true })
      const skillList = Array.isArray(skillsBody)
        ? skillsBody
        : (skillsBody?.skills ?? skillsBody?.items ?? [])
      const skills = (Array.isArray(skillList) ? skillList : []).slice(0, maxSkills)

      return {
        scope: effScope,
        // 这两条 hub 没有读端点，只能是 null —— 由 `sources.mjs` 各自产出
        // 一条 `missing` 候选（而不是**少一项**）。见 UNSERVED_SOURCE_FAMILIES。
        teamPlan: null,
        employeeManifest: null,
        // ★ 一律过一遍 `withEpochMs`：hub 给的是 ISO 的 `createdAt`/`updatedAt`，
        // 而 `sources.mjs` 认的是 `createdAtMs`/`updatedAtMs`。见那个函数的说明——
        // 这是本批**接线才暴露出来**的一处字段名错配，不补会整条装配 400。
        goal: goal === null ? null : withEpochMs(goal),
        task: task === null ? null : withEpochMs(task),
        // 兄弟任务不在这里取：它们属于"当前任务之外的东西"，
        // 该由调用方显式决定要不要，而不是由装配器顺手全带上。
        tasks: [],
        comments: toComments(task),
        userFeedback: [],
        upstreamDeliveries: [],
        // 产物**只给引用**（PRT-405）：正文是一个预算决定。
        artifacts: mapEpochMs(task?.artifacts),
        skills: mapEpochMs(skills),
        documents: [],
        workspaceState: null,
      }
    },

    /**
     * 本装配器**取不到**哪些来源族，以及为什么。
     *
     * 形状与 `product/metrics-source.mjs` 的 `missing` 一致：
     * 两种缺失在界面上都表现为"没有"，但只有一种是**还没做**。
     */
    availability() {
      return Object.freeze({
        unserved: UNSERVED_SOURCE_FAMILIES,
        unconsumed: UNCONSUMED_ENDPOINTS,
        // 读面覆盖：hub 上有读端点、且本装配器真的会去读的那些
        consumed: Object.freeze(['/api/task', '/api/goal', '/api/skills']),
      })
    },

    /** 上一次 `loadSources` 读了哪些端点、成没成。排障用。 */
    lastReads() { return Object.freeze([...reads]) },
  })
}
