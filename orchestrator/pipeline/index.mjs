// orchestrator/pipeline/index.mjs
// ============================================================================
// 岗位、流水线与团队快照（PRT-305）
//
// spec §5 的术语：
//   | Task       | team-hub 中可由**一个岗位**完成和验收的业务工作单元 |
//   | TeamPlan   | 目标创建时**冻结**的团队、岗位、流水线和能力包组合快照 |
//
// spec 第 333 行对 `HandingOff` 的定义：
//   | `HandingOff` | `in_progress` | 当前 Task 收口并**原子创建/释放下一岗位任务** |
//
// 本模块只做**判定与构造**：从一条流水线（`space_stages` 读出来的有序岗位）
// 回答三个问题，并把交接要创建的那条任务**拼装好**交给调用方去落库。
// 它不碰数据库、不碰网络、不看时钟——与状态机、机器验收同样的理由：
// 「下一岗位是谁」「交接任务长什么样」必须能在不启动任何进程的情况下穷举测试，
// 因为它们决定任务链往哪走，而**猜错的两种方向都不报错**：
//   - 判成"没有下一岗位" → 静默掐断任务链，直到整个目标停住才被发现；
//   - 判成"还有下一岗位" → 创建一个没有承接方的任务，它永远没人领。
// ============================================================================

/** 流水线错误码。 */
export const PIPELINE_ERRORS = Object.freeze({
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  NO_SUCH_SCOPE: 'NO_SUCH_SCOPE',
})

export class PipelineError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'PipelineError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 把 `space_stages` 的行整理成一张按 role 索引的表。
 *
 * `enabled: false` 的岗位**不进表**：一个被停用的岗位不该承接新任务，
 * 也不该出现在链上——否则交接会创建一条没人会领的任务。
 * 但它造成的"链断了"必须能被看出来，因此 `brokenEdges` 单独报（见 pipelineView）。
 */
export function indexStages(stages) {
  if (!Array.isArray(stages)) {
    throw new PipelineError(PIPELINE_ERRORS.NO_SUCH_SCOPE,
      `stages 必须是数组（收到 ${stages === null ? 'null' : typeof stages}）：` +
      '把读不出流水线当成"没有岗位"，会让所有任务都被判成链尾')
  }
  const byRole = new Map()
  for (const s of stages) {
    if (s === null || typeof s !== 'object') continue
    if (typeof s.role !== 'string' || s.role === '') continue
    if (s.enabled === false) continue
    byRole.set(s.role, s)
  }
  return byRole
}

/**
 * 一条流水线的**结构完整性**读法。
 *
 * 这是本模块里最容易被忽略、后果最重的一个函数：`next` 是一个**没有外键约束**的
 * 字符串。有人把某个岗位停用、或把 `next` 拼错一个字母，链就断了——而"链断了"
 * 与"这条就是链尾"在数据上长得一模一样（都表现为"查不到下一岗位"）。
 *
 * 因此这里把两者分开报：
 *   - `tailRoles`  ：`next === null` 的岗位，**故意**是链尾；
 *   - `brokenEdges`：`next` 指向一个不存在或已停用的岗位，**是坏的**。
 * 前者是正常的（链总得有尾），后者是配置错误，必须能被告警出来。
 */
export function pipelineView(stages) {
  const byRole = indexStages(stages)
  const tailRoles = []
  const brokenEdges = []
  for (const [role, s] of byRole) {
    const next = s.next ?? null
    if (next === null || next === '') { tailRoles.push(role); continue }
    if (!byRole.has(next)) brokenEdges.push({ from: role, to: next })
  }
  return Object.freeze({
    roles: Object.freeze([...byRole.keys()]),
    tailRoles: Object.freeze(tailRoles),
    brokenEdges: Object.freeze(brokenEdges),
    byRole,
  })
}

/**
 * 「这条任务还有没有下一岗位」——决定验收通过后走 `HandingOff` 还是 `Completed`。
 *
 * 返回 `{ ok, hasNext, nextRole, nextLabel, reason }` 或 `{ ok: false, code, message }`。
 *
 * **为什么必须有人明确回答这个问题**：状态机为 `Validating → Completed` 与
 * `Validating → HandingOff` 各配了一个守卫（`noNextPost` / `hasNextPost`），
 * 而"没有下一岗位"在数据里既可能是"确实是链尾"，也可能是"链断了"。
 * 把后者当成前者就是静默掐断任务链。
 *
 * `role` 为空（历史任务没记岗位）时**不猜**：报 `UNKNOWN_ROLE`，
 * 由调用方决定是当链尾收口还是先补岗位。
 */
export function resolveNextPost({ stages, role }) {
  if (typeof role !== 'string' || role === '') {
    return Object.freeze({
      ok: false,
      code: PIPELINE_ERRORS.UNKNOWN_ROLE,
      message: '任务没有记录岗位（role），无法判断它后面还有没有岗位。' +
        '**不默认成链尾**：那会让一条本来还有后续的任务静默停在 Completed',
    })
  }
  const view = pipelineView(stages)
  const stage = view.byRole.get(role)
  if (stage === undefined) {
    return Object.freeze({
      ok: false,
      code: PIPELINE_ERRORS.UNKNOWN_ROLE,
      message: `岗位「${role}」不在本空间的流水线里（已知：${view.roles.join('、') || '空'}）。` +
        '**不默认成链尾**：岗位被停用或改名时，链断在这里，而"没有 next"与"根本找不到这个岗位"是两件事',
    })
  }
  const next = stage.next ?? null
  if (next === null || next === '') {
    return Object.freeze({
      ok: true, hasNext: false, nextRole: null, nextLabel: null,
      reason: `岗位「${stage.label ?? role}」是链尾（没有 next）`,
    })
  }
  const nextStage = view.byRole.get(next)
  if (nextStage === undefined) {
    // 链断了。**不报成链尾**，也不自动跳过——两种做法都会让目标静默停住。
    return Object.freeze({
      ok: false,
      code: PIPELINE_ERRORS.UNKNOWN_ROLE,
      message: `岗位「${role}」的下一岗位是「${next}」，但它不存在或已被停用。` +
        '这是流水线配置坏了，不是链尾——当成链尾会让任务链静默断在这里',
      brokenEdge: Object.freeze({ from: role, to: next }),
    })
  }
  return Object.freeze({
    ok: true,
    hasNext: true,
    nextRole: nextStage.role,
    nextLabel: nextStage.label ?? nextStage.role,
    nextStage,
    reason: `岗位「${stage.label ?? role}」之后是「${nextStage.label ?? next}」`,
  })
}

/** 交接任务的标题：把上一环的「【阶段标签】」换成下一环的。 */
export function handoffTitle(prevTitle, nextLabel) {
  const title = typeof prevTitle === 'string' ? prevTitle : ''
  const replaced = title.replace(/^【[^】]*】/, `【${nextLabel}】`)
  // 没有阶段前缀时补一个，而不是原样沿用——否则下一岗位的任务标题里写的是
  // **上一个**岗位的名字，派工的人看到标题就分不清这一环该谁做。
  return replaced === title && !/^【[^】]*】/.test(title) ? `【${nextLabel}】${title}` : replaced
}

/**
 * 交接任务的描述：把上一阶段的收口结论带上，让下一岗位不必回查。
 *
 * `base` 会去掉已有的「[本阶段] …」尾巴——一条任务被交接多次时，
 * 每次都要基于**原始目标**重写，而不是在前一次的产物上叠加
 * （叠加会让描述每转一手就长一截，最后没人看得懂要做什么）。
 */
export function handoffDescription({ description, prevLabel, prevRole, nextLabel, nextRole, prevSummary }) {
  // 从 `[前序阶段]` 起整段砍掉——它**和它后面的** `[本阶段]` 都是上一次交接的产物，
  // 这一次要重新生成。（只砍 `[本阶段]` 是不够的：`[前序阶段]` 在它前面，
  // 于是每转一手就会多留一条上一手的交接记录。）
  const base = String(description ?? '')
    .replace(/\n\n\[(?:前序|本)阶段\][\s\S]*$/u, '')
    .trimEnd()
  const summary = prevSummary === null || prevSummary === undefined || String(prevSummary).trim() === ''
    // 上一环没有留下收口结论时**明说**，而不是省略整行：
    // 省略会让下一岗位以为交接没发生过，于是它不会去问"上一环到底做完了什么"。
    ? '(上一阶段未留下收口结论)'
    : String(prevSummary).trim()
  return [
    base,
    `[前序阶段] ${prevLabel}（${prevRole}）已完成：${summary}`,
    `[本阶段] ${nextLabel}（${nextRole}）`,
  ].filter((s) => s.trim().length > 0).join('\n\n')
}

/**
 * 拼装交接要创建的那条任务。
 *
 * 返回 `{ ok, task }`，`task` 的字段与 `POST /api/create` 对齐：
 * `title` / `description` / `role` / `parent` / `priority` / `status` / `scope` / `goalId`。
 *
 * **`parent` 是交接的幂等键**（不是 `blockedBy`，也不是标题）：
 * 一条任务的"后继"永远只有一条，而 `parent === 上一环任务 id` 这个事实
 * 在**重试时不变**——reboot 后重扫、租约过期回收、人工重放，都会算出同一个 parent。
 * 用标题或创建时间做键，重放时会各建一条。
 */
export function buildHandoffTask({ prevTask, nextStage, stages, prevSummary = null }) {
  if (prevTask === null || typeof prevTask !== 'object' || typeof prevTask.id !== 'string' || prevTask.id === '') {
    throw new PipelineError(PIPELINE_ERRORS.UNKNOWN_ROLE, 'buildHandoffTask 需要 prevTask.id 作为后继的 parent（交接的幂等键）')
  }
  if (nextStage === null || typeof nextStage !== 'object' || typeof nextStage.role !== 'string' || nextStage.role === '') {
    throw new PipelineError(PIPELINE_ERRORS.UNKNOWN_ROLE, 'buildHandoffTask 需要 nextStage.role')
  }
  // 自己交接给自己会造出一条自我繁殖的任务链（每一环都再建一次，永不收敛）。
  const prevRole = prevTask.role ?? null
  if (prevRole !== null && prevRole === nextStage.role) {
    throw new PipelineError(PIPELINE_ERRORS.UNKNOWN_ROLE,
      `流水线把岗位「${prevRole}」的 next 指回它自己：交接会建出一条永不收敛的自我繁殖链。` +
      '这是配置错误，不是"再跑一遍"')
  }
  const nextLabel = nextStage.label ?? nextStage.role
  const prevStage = prevRole === null ? undefined : indexStages(stages).get(prevRole)
  const prevLabel = prevStage?.label ?? prevRole ?? '上一阶段'
  return Object.freeze({
    ok: true,
    task: Object.freeze({
      title: handoffTitle(prevTask.title, nextLabel),
      description: handoffDescription({
        description: prevTask.description,
        prevLabel, prevRole: prevRole ?? '未知岗位',
        nextLabel, nextRole: nextStage.role,
        prevSummary,
      }),
      role: nextStage.role,
      parent: prevTask.id,
      priority: prevTask.priority ?? 'medium',
      status: 'todo',
      scope: prevTask.scope ?? 'default',
      goalId: prevTask.goalId ?? null,
    }),
  })
}
