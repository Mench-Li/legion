#!/usr/bin/env node
// scripts/prt/old-path-evidence.mjs
// ============================================================================
// 旧路径执行证据提取器（PRT-005 / PRT-009）
//
// ## 为什么从审计历史提取，而不是跑一次新任务
//
// 阶段 0 的完成标准是「在受控环境稳定复现一次端到端软件交付」。最初的计划是
// 跑一次新的黄金任务来采集证据，但那条路当时是断的（见下），而且**即使能跑，
// 单次运行也不如历史数据可靠**：一个样本证明不了「稳定复现」，而 team-hub 的
// `audit` 表里已经躺着 **96 个任务、1 万余条带时间戳的真实执行记录**。
//
// 所以这里改为**从真实历史提取**：状态序列、端到端耗时、人工介入都是实测值，
// 不是一次演示运行的产物。这比造一次运行更诚实，也更难被「刚好这次顺利」骗过。
//
// ## 本工具同时是「旧路径当前不可用」的证据
//
// 2026-09-11 实测：`software` 空间的审计在 `10:32:09.919Z` 断流，
// 直到 `12:30:54.819Z` 才恢复（**1 小时 58 分 45 秒**），
// 与宿主 `legion-services` 在 `12:30:18.582Z` 重新挂载落在同一分钟
// （见 `.legion-services.log`）。也就是说这段时间**整个宿主不在**，调度与审计同时停止，
// 而且没有任何外部可见的告警——没有任何东西告诉将军「旧路径已经停了」。
// 这本身就是 PRT-005 要保存的「旧路径执行状态」：可用性证据，不只是性能证据。
//
// 早先的笔记把这段写成「守护死锁 3 小时」。那是个**没有量过的印象**：
// 实测是 1.98 小时，且归因是宿主停机而不是内部死锁。留在这里是为了提醒——
// 「大概是……吧」的结论会一路传下去，直到有人真的去量。
//
// ## 只读，且不序列化活对象
//
// 以 `readOnly: true` 打开源库：源库正在被生产进程写入，本工具**永不写它**。
// 输出只包含从行里取出的叶子字段，不 dump 行对象。
//
// ## 记不到的东西要显式记为「记不到」
//
// 旧路径**不记录 token 用量、不记录费用、不记录单次耗时**——
// 全库唯一与耗时相关的列是 `web_fetch_history.ms`。
// 因此 token / 费用 / 峰值资源三项在本工具里是**明确的缺口清单**，
// 而不是被静默省略。把「没记录」显示成「无数据」和显示成 0 是两回事。
//
// 用法：
//   node scripts/prt/old-path-evidence.mjs --db=<team.db> [--scope=software]
//   node scripts/prt/old-path-evidence.mjs --db=<path> --json
//   node scripts/prt/old-path-evidence.mjs --write-baseline [--out=<path>]
//   node scripts/prt/old-path-evidence.mjs --help
// ============================================================================
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 默认源库：主检出的生产库（本工具只读，不复制也不修改）。 */
export const DEFAULT_DB = 'D:/project/DSH/legion/team-hub/team.db'
export const DEFAULT_SCOPE = 'software'
/** `--write-baseline` 的默认输出（可提交的 PRT-009 执行证据片段）。 */
export const DEFAULT_OUT = resolve(ROOT, 'docs/superpowers/prt/prt-009-execution-evidence.json')

/**
 * 黄金流程声明的「预期任务状态序列」。
 *
 * 这里刻意**独立于** `golden-flow.mjs` 复制一份字面量，而不是 import 它：
 * 本工具是拿真实历史去**检验**这个预期是否成立的裁判，裁判自己引用被检验对象
 * 会让「预期改了、检验跟着改」，永远不会出现不一致的报告。
 */
export const EXPECTED_SEQUENCE = Object.freeze(['todo', 'in_progress', 'in_review', 'done'])

/**
 * 人工账号名。
 *
 * Legion 里「将军」（general）就是人类指挥官；其余 member 要么是守护
 * （`soldier-auto` / `mediator-auto`），要么是岗位角色（`coder` / `reviewer` …，
 * 由 agent 扮演）。所以**人工介入 = member 为 `general` 的动作**。
 * 这个判据一旦写错，人工介入率会变成「所有动作数」或恒为 0。
 */
export const HUMAN_MEMBERS = Object.freeze(['general'])
/** 守护（非人、非岗位）账号。 */
export const DAEMON_MEMBERS = Object.freeze(['soldier-auto', 'mediator-auto'])

/**
 * 审计动作 → 任务状态标记。
 *
 * `claim` 与 `transition` 是**直接**的状态变更；`create` 落地为 todo；
 * `advance` 表示流水线推进到下一阶段（最后一个阶段推进即为 done，
 * 但 `advance` 本身不写 to 值——所以它单独标记为 `advanced`，
 * 不与 `done` 混为一谈；否则会把「阶段推进」误读成「任务完成」）。
 *
 * 未收录的动作**不丢弃**：进 `unmappedActions`。审计模型变了要看得见。
 */
export const ACTION_TO_STATE = Object.freeze({
  create: 'todo',
  claim: 'in_progress',
})

/** 与状态迁移相关、需要参与序列还原的动作。 */
export const SEQUENCE_ACTIONS = Object.freeze(['create', 'claim', 'transition', 'advance'])

/** 产生交付物的动作（PRT-005 要保存的「产物」）。 */
export const ARTIFACT_ACTIONS = Object.freeze(['patch', 'artifact'])

/** 纯噪音动作：守护每轮的释放扫描，与具体任务无关。必须排除，否则淹没真实轨迹。 */
export const NOISE_ACTIONS = Object.freeze(['release-stale'])

/** 从 `detail`（JSON 文本）里安全取字段。畸形 JSON 不抛错，返回 null。 */
export function parseDetail(detail) {
  if (detail === null || detail === undefined || detail === '') return {}
  if (typeof detail === 'object') return detail
  try {
    const v = JSON.parse(String(detail))
    return v !== null && typeof v === 'object' ? v : { value: v }
  } catch {
    return null // null 表示「有 detail 但解析不了」，与 {} 不同
  }
}

/**
 * 还原一个任务的状态标记序列（纯函数，便于单测）。
 *
 * @param rows 审计行（任意顺序；内部按 seq 排序），字段：seq/action/detail/member/ts
 * @returns { states, unmappedActions, malformedDetails }
 */
export function reconstructSequence(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq))
  const states = []
  const unmappedActions = []
  let malformedDetails = 0

  for (const r of sorted) {
    const action = String(r.action ?? '')
    if (NOISE_ACTIONS.includes(action)) continue
    const detail = parseDetail(r.detail)
    if (detail === null) malformedDetails += 1

    let state = null
    if (Object.hasOwn(ACTION_TO_STATE, action)) {
      state = ACTION_TO_STATE[action]
    } else if (action === 'transition') {
      const to = detail?.to
      state = typeof to === 'string' && to !== '' ? to : null
      if (state === null) unmappedActions.push('transition(缺 to)')
    } else if (action === 'advance') {
      state = 'advanced'
    } else if (!SEQUENCE_ACTIONS.includes(action)) {
      // 与状态无关的动作（comment/progress/artifact…）不参与序列，但也不报警
      continue
    }

    if (state === null) continue
    states.push({ seq: Number(r.seq), at: r.ts ?? null, state, action, member: r.member ?? null })
  }
  return { states, unmappedActions, malformedDetails }
}

/** 序列中按出现顺序去重后的状态列表（相邻重复合并）。 */
export function distinctStates(states) {
  const out = []
  for (const s of states) {
    if (out.length === 0 || out[out.length - 1] !== s.state) out.push(s.state)
  }
  return out
}

/**
 * 端到端耗时：从**首个状态标记**到**末个状态标记**的墙钟时间。
 *
 * 口径说明（重要）：
 *   · 用的是审计写入时间，即「动作被记录的时刻」，不等于「工作真正发生的时刻」；
 *     守护是 30 秒轮询，因此每次交接天然带最多约 30 秒的量化误差。
 *   · 含等待人工/等待下一轮的时间。这是**端到端**耗时，不是模型推理耗时——
 *     后者旧路径根本没有记录（这正是 §6.11 的缺口）。
 *   · 少于两个标记的任务返回 null（无法测量），不返回 0。
 */
export function measureLatency(states) {
  if (!Array.isArray(states) || states.length < 2) return null
  const first = states[0]
  const last = states[states.length - 1]
  if (!first.at || !last.at) return null
  const a = Date.parse(first.at)
  const b = Date.parse(last.at)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return { ms: Math.max(0, b - a), from: first.at, to: last.at }
}

/** 统计人工介入：member 属于 HUMAN_MEMBERS 的动作。 */
export function countHumanInterventions(rows) {
  const byAction = {}
  let total = 0
  for (const r of rows) {
    if (!HUMAN_MEMBERS.includes(String(r.member ?? ''))) continue
    total += 1
    const a = String(r.action ?? 'unknown')
    byAction[a] = (byAction[a] ?? 0) + 1
  }
  return { total, byAction }
}

/**
 * 守护心跳动作。**每轮扫描都写一条**，即使什么都没释放（实测 detail 恒为 `{"released":[]}`，
 * 健康时段中位间隔 30.0s）。正因为它无条件写，才能当心跳用。
 *
 * 这一点必须先量过才能依赖：如果它是「只在有动作时写」，那么一段空窗
 * 只说明「那段时间没有过期租约」，与进程死没死无关——用它判可用性就是错的。
 */
export const HEARTBEAT_ACTION = 'release-stale'

/**
 * 可用性空窗：心跳间隔超过阈值的时段。
 *
 * ## 为什么可用性也算 PRT-005 的证据
 *
 * PRT-005 要保存的是「旧路径执行状态」。只知道它**跑的时候**什么样是不够的：
 * 2026-09-11 实测到 1 小时 58 分的审计断流（`10:32:09.919Z → 12:30:54.819Z`），
 * 与宿主 `legion-services` 在同一分钟重新挂载吻合。也就是说旧路径的可用性
 * **完全绑定在宿主进程上**，宿主一停，调度和审计同时消失，而且没有任何外部告警。
 *
 * 阈值默认 5 分钟：约 10 个心跳周期。低于它的抖动（GC、负载、磁盘慢）不报，
 * 否则清单会被噪音淹没——而会被淹没的清单等于没有清单。
 */
export function availabilityGaps(rows, { minGapMs = 300_000, maxReported = 10 } = {}) {
  const heartbeats = rows
    .filter((r) => String(r.action ?? '') === HEARTBEAT_ACTION)
    .map((r) => Date.parse(r.ts))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)

  const all = []
  for (let i = 1; i < heartbeats.length; i += 1) {
    const gapMs = heartbeats[i] - heartbeats[i - 1]
    if (gapMs >= minGapMs) {
      all.push({ from: new Date(heartbeats[i - 1]).toISOString(), to: new Date(heartbeats[i]).toISOString(), gapMs })
    }
  }

  // 分桶看形状：「一夜没开机」和「中途掉线两小时」是完全不同的事，
  // 只报「最长空窗 17 小时」会把两者混为一谈（前者是常态，后者才是故障信号）。
  const bucketOf = (ms) => (ms >= 7_200_000 ? '>=2h' : (ms >= 3_600_000 ? '1-2h' : (ms >= 1_800_000 ? '30-60m' : '5-30m')))
  const byBucket = { '5-30m': 0, '30-60m': 0, '1-2h': 0, '>=2h': 0 }
  for (const g of all) byBucket[bucketOf(g.gapMs)] += 1

  const intervals = []
  for (let i = 1; i < heartbeats.length; i += 1) intervals.push(heartbeats[i] - heartbeats[i - 1])
  intervals.sort((a, b) => a - b)

  const longest = [...all].sort((a, b) => b.gapMs - a.gapMs)

  return {
    heartbeatAction: HEARTBEAT_ACTION,
    heartbeatCount: heartbeats.length,
    firstHeartbeat: heartbeats.length > 0 ? new Date(heartbeats[0]).toISOString() : null,
    lastHeartbeat: heartbeats.length > 0 ? new Date(heartbeats[heartbeats.length - 1]).toISOString() : null,
    // 健康时段的心跳节奏：用中位数而不是均值，避免被空窗本身拉偏。
    medianIntervalMs: intervals.length > 0 ? percentile(intervals, 50) : null,
    minGapMs,
    gapCount: all.length,
    longestGapMs: longest.length > 0 ? longest[0].gapMs : null,
    gapsByBucket: byBucket,
    // 最长的若干段，用于看「最坏情况」
    gaps: longest.slice(0, maxReported),
    // 最近的若干段：**最长的那几段几乎都是跨夜关机**，
    // 只看它们会漏掉「今天白天掉线两小时」这种真正需要归因的事件。
    recentGaps: all.slice(-5),
  }
}

/** 简单的分位数（已排序数值数组；空数组返回 null）。 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/** 汇总耗时分布。 */
export function latencyStats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const sum = v.reduce((a, b) => a + b, 0)
  return {
    samples: v.length,
    minMs: v[0],
    p50Ms: percentile(v, 50),
    p90Ms: percentile(v, 90),
    maxMs: v[v.length - 1],
    meanMs: Math.round(sum / v.length),
  }
}

/** 打开源库（只读）。 */
export function openReadOnly(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`源库不存在：${dbPath}`)
  return new DatabaseSync(dbPath, { readOnly: true })
}

/**
 * 提取旧路径执行证据。
 *
 * @param db 已打开的只读库
 * @param options.scope 空间 id
 */
export function extractEvidence(db, options = {}) {
  const scope = options.scope ?? DEFAULT_SCOPE

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
  for (const need of ['audit', 'tasks']) {
    if (!tables.includes(need)) throw new Error(`源库缺少表 ${need}（不是 team-hub 库？）`)
  }

  const tasks = db.prepare(
    'SELECT id, role, status, title, goalId, createdAt, updatedAt FROM tasks WHERE scope = ? ORDER BY id',
  ).all(scope)

  // ⚠️ 审计行按 **taskId 归属**取，不能按 `audit.scope` 过滤。
  //
  // `audit.scope` 记的是**动作发起者当时所在的空间视图**，不是任务所属空间。
  // 实证：T-049 的 `transition {"to":"done"}` 由 `general` 发起，
  // 其 scope 记为 `default`，而任务本身在 `software`。
  // 若按 `WHERE scope='software'` 取行，这条 done 就被丢掉——
  // 状态序列被截断在 in_review，端到端耗时也随之少算最后一段
  // （T-049 会从「到 done」缩成「到 in_review」，少约 18 分钟）。
  //
  // 这类错误不会报错、只会给出偏小的数字，属于最难发现的一种。
  // 因此改为 JOIN tasks 按任务归属取行，并单独统计 scope 不一致的量。
  const allAudit = db.prepare(`
    SELECT a.seq, a.ts, a.member, a.action, a.taskId, a.detail, a.goalId, a.scope AS auditScope
    FROM audit a JOIN tasks t ON t.id = a.taskId
    WHERE t.scope = ?
    ORDER BY a.seq
  `).all(scope)

  const scopeMismatch = allAudit.filter((r) => r.auditScope !== scope).length
  const mismatchByScope = {}
  for (const r of allAudit) {
    if (r.auditScope === scope) continue
    const k = r.auditScope ?? '(null)'
    mismatchByScope[k] = (mismatchByScope[k] ?? 0) + 1
  }

  const auditByTask = new Map()
  for (const r of allAudit) {
    const key = r.taskId ?? null
    if (key === null || key === '*') continue
    if (!auditByTask.has(key)) auditByTask.set(key, [])
    auditByTask.get(key).push(r)
  }

  const perTask = []
  const allUnmapped = new Set()
  let malformedDetailTotal = 0

  for (const t of tasks) {
    const rows = auditByTask.get(t.id) ?? []
    const { states, unmappedActions, malformedDetails } = reconstructSequence(rows)
    for (const u of unmappedActions) allUnmapped.add(u)
    malformedDetailTotal += malformedDetails
    const latency = measureLatency(states)
    const human = countHumanInterventions(rows)
    const artifacts = rows
      .filter((r) => ARTIFACT_ACTIONS.includes(String(r.action)))
      .map((r) => {
        const d = parseDetail(r.detail)
        return { seq: Number(r.seq), at: r.ts, action: r.action, path: d?.files ?? d?.path ?? null, kind: d?.kind ?? null, digest: d?.digest ?? null }
      })
    perTask.push({
      id: t.id,
      role: t.role,
      status: t.status,
      title: String(t.title ?? '').slice(0, 120),
      goalId: t.goalId ?? null,
      auditRows: rows.length,
      states: distinctStates(states),
      latencyMs: latency?.ms ?? null,
      humanInterventions: human.total,
      humanByAction: human.byAction,
      artifactCount: artifacts.length,
      artifacts,
    })
  }

  const statusCounts = {}
  for (const t of tasks) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1

  // ── 两个**不同**的总体，必须分开报，不能共用一个名字 ──
  //
  //   spaceAudit   = audit.scope = 本空间的行（空间视角：本空间里发生过什么）
  //   allAudit     = 能 JOIN 到本空间任务的行（任务视角：哪些动作属于这些任务）
  //
  // 两者双向不同，而且差异都是真实存在的：
  //   · 守护每轮的 release-stale（taskId='*'，scope 正确）→ 在空间视角里，不在任务视角里
  //   · 将军从 default 视图推进 software 任务（taskId 正确，scope='default'）
  //     → 在任务视角里，不在空间视角里
  //
  // 之前两者共用 `allAudit` 并命名为 `actionCounts`/`auditRows`，读起来像在描述空间，
  // 实际只覆盖了任务可归属的那部分——于是 5898 行 release-stale 与若干人的动作
  // 都被无声地排除在一个看起来完整的分布之外。
  const spaceAudit = db.prepare(
    'SELECT seq, ts, member, action, taskId, detail FROM audit WHERE scope = ? ORDER BY seq',
  ).all(scope)

  const actionCounts = {}
  for (const r of spaceAudit) actionCounts[r.action] = (actionCounts[r.action] ?? 0) + 1

  const memberCounts = {}
  for (const r of spaceAudit) memberCounts[r.member] = (memberCounts[r.member] ?? 0) + 1

  const completed = perTask.filter((t) => t.status === 'done')
  const terminalLatencies = completed.map((t) => t.latencyMs).filter((x) => typeof x === 'number')
  // 只对**任务视角**求和：人工介入率的分母是任务，分子必须同属任务视角，
  // 否则 release-stale 之类与本任务无关的行会把比率抬高。
  const humanTotal = perTask.reduce((n, t) => n + t.humanInterventions, 0)

  // 拿真实历史核对黄金流程的「预期状态序列」——见 checkExpectedSequence 的说明
  const stateSequence = checkExpectedSequence(perTask, EXPECTED_SEQUENCE)

  return {
    scope,
    taskCount: tasks.length,
    statusCounts,
    // 空间视角：本空间审计总行数（含不归属任何任务的守护动作）
    auditRows: spaceAudit.length,
    // 任务视角：能归属到本空间任务的行数。两者之差本身就是一条证据。
    auditRowsTaskAttributed: allAudit.length,
    actionCounts,
    memberCounts,
    tasksWithTrail: perTask.filter((t) => t.auditRows > 0).length,
    // `audit.scope` 与任务所属空间不一致的行数。为 0 才说明两者语义相同；
    // 非 0 说明任何「按 scope 过滤审计」的分析都会漏行。
    auditScopeMismatch: { rows: scopeMismatch, byScope: mismatchByScope },
    // 端到端耗时分布只统计**已完成**任务：未完成的耗时不代表交付能力
    completedLatency: latencyStats(terminalLatencies),
    human: {
      total: humanTotal,
      members: HUMAN_MEMBERS,
      // 单次运行给不出比率，但历史样本可以：人工介入动作 / 任务数
      perTaskMean: completed.length > 0 ? Number((humanTotal / completed.length).toFixed(2)) : null,
      tasksWithHuman: perTask.filter((t) => t.humanInterventions > 0).length,
    },
    artifacts: {
      total: perTask.reduce((n, t) => n + t.artifactCount, 0),
      tasks: perTask.filter((t) => t.artifactCount > 0).length,
    },
    unmappedActions: [...allUnmapped],
    malformedDetails: malformedDetailTotal,
    // 可用性证据：守护心跳空窗（旧路径「什么时候不在」与「在的时候什么样」同等重要）
    availability: availabilityGaps(spaceAudit),
    // 与黄金流程「预期序列」的对拍结论（§14.2 的基准是否成立）
    stateSequence,
    perTask,
    // 旧路径**记不到**的项：显式列出，避免被当成「值为 0」
    notRecorded: [
      { key: 'token-usage', why: '全库 23 张表无任何 token/cost 列（scripts/prt/schema-scan.mjs 可复核）' },
      { key: 'estimated-cost', why: '依赖 token-usage；agent_models 只记 provider/model，无计价' },
      { key: 'peak-resource', why: '旧路径不采样内存/CPU；全库唯一耗时列为 web_fetch_history.ms（315 行，仅网页抓取）' },
    ],
  }
}

/**
 * 用真实历史校验黄金流程的「预期状态序列」。
 *
 * `GOLDEN_TASK.expectedTaskStateSequence` 目前是**人工写的预期**（todo → in_progress
 * → in_review → done）。这里拿真实完成任务去核对它，回答「这个预期到底成不成立」。
 * 若多数任务并不经过 in_review，那么它作为 §14.2 对拍基准就是错的——
 * 新路径会被要求去匹配一个旧路径自己都不走的序列。
 */
export function checkExpectedSequence(perTask, expected) {
  const completed = perTask.filter((t) => t.status === 'done' && t.states.length > 0)
  const normalized = (states) => states.map((s) => (s === 'advanced' ? 'done' : s))
  const matches = completed.filter((t) => {
    const seq = normalized(t.states)
    return expected.every((e, i) => seq[i] === e) && seq.length >= expected.length
  })
  const skippedReview = completed.filter((t) => !t.states.includes('in_review'))
  return {
    expected: [...expected],
    completedWithTrail: completed.length,
    exactPrefixMatches: matches.length,
    matchRate: completed.length > 0 ? Number((matches.length / completed.length).toFixed(3)) : null,
    tasksSkippingInReview: skippedReview.length,
    conclusion: skippedReview.length > completed.length / 2
      ? 'in_review 在多数完成任务中并不出现：预期序列与真实观察不符，作为对拍基准需要修正'
      : '多数完成任务经过 in_review：预期序列可作对拍基准',
  }
}

// ------------------------------------------------------------------ CLI

function usage() {
  console.log('old-path-evidence.mjs — 旧路径执行证据提取器（PRT-005 / PRT-009）')
  console.log('')
  console.log('  --db=<path>     team-hub 源库（默认 ' + DEFAULT_DB + '）')
  console.log('  --scope=<id>    空间 id（默认 software）')
  console.log('  --json          机器可读完整输出')
  console.log('  --tasks         打印逐任务轨迹摘要')
  console.log('  --write-baseline [--out=<path>] [--note=<说明>]')
  console.log('                  写可提交的证据片段（note 用于说明该 scope 的语义）')
  console.log('  --help          本说明')
  console.log('')
  console.log('只读打开源库，不写入、不复制。')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const arg = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const dbPath = arg('db', DEFAULT_DB)
  const scope = arg('scope', DEFAULT_SCOPE)

  let db
  try {
    db = openReadOnly(dbPath)
  } catch (err) {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  }

  let ev
  try {
    ev = extractEvidence(db, { scope })
  } finally {
    db.close()
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(ev, null, 2))
    return
  }

  if (argv.includes('--write-baseline')) {
    // 把本次提取结果写成可提交的基线片段，供 PRT-009 引用。
    // 写文件而不是让人手抄：这些数字要进证据文档，手抄一次就多一处可能与源不一致。
    const out = arg('out', DEFAULT_OUT)
    const note = arg('note', null)
    const payload = {
      $comment: 'PRT-009 执行证据（由 scripts/prt/old-path-evidence.mjs --write-baseline 生成）。'
        + '全部数值来自 team-hub 生产库的 audit 表，只读提取，不含任何估计值。',
      generatedAt: new Date().toISOString(),
      sourceDb: dbPath,
      scope,
      // 同一份提取器既能跑生产空间（旧路径历史），也能跑受控空间 gf001。
      // 两者的语义不同，靠调用方用 --note 说明，工具不替调用方猜。
      note,
      taskCount: ev.taskCount,
      statusCounts: ev.statusCounts,
      auditRows: ev.auditRows,
      auditRowsTaskAttributed: ev.auditRowsTaskAttributed,
      tasksWithTrail: ev.tasksWithTrail,
      auditScopeMismatch: ev.auditScopeMismatch,
      completedLatencyMs: ev.completedLatency,
      stateSequence: ev.stateSequence,
      human: ev.human,
      artifacts: ev.artifacts,
      // 可用性：守护心跳空窗。缺了它，证据只剩「它跑起来的时候」的样子。
      availability: ev.availability,
      notRecorded: ev.notRecorded,
    }
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`已写入 ${out}`)
    return
  }

  console.log(`空间 ${ev.scope}　任务 ${ev.taskCount}　审计 ${ev.auditRows} 条　有轨迹任务 ${ev.tasksWithTrail}`)
  console.log('')
  console.log('任务状态分布：')
  for (const [k, v] of Object.entries(ev.statusCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
  console.log('')
  const L = ev.completedLatency
  if (L) {
    console.log(`已完成任务端到端耗时（n=${L.samples}）：`)
    console.log(`  min ${(L.minMs / 1000).toFixed(1)}s　p50 ${(L.p50Ms / 1000).toFixed(1)}s　p90 ${(L.p90Ms / 1000).toFixed(1)}s　max ${(L.maxMs / 1000).toFixed(1)}s　mean ${(L.meanMs / 1000).toFixed(1)}s`)
  } else {
    console.log('已完成任务端到端耗时：无样本')
  }
  console.log('')
  console.log(`人工介入（member ∈ ${ev.human.members.join(',')}）：共 ${ev.human.total} 次，涉及 ${ev.human.tasksWithHuman} 个任务，每完成任务 ${ev.human.perTaskMean} 次`)
  console.log(`交付物：${ev.artifacts.total} 件，涉及 ${ev.artifacts.tasks} 个任务`)
  console.log('')
  const A = ev.availability
  console.log(`可用性（心跳 ${A.heartbeatAction}，中位间隔 ${A.medianIntervalMs === null ? '—' : `${(A.medianIntervalMs / 1000).toFixed(1)}s`}）：`)
  if (A.gapCount === 0) {
    console.log(`  无 ≥${A.minGapMs / 60000} 分钟的空窗`)
  } else {
    console.log(`  ${A.gapCount} 段 ≥${A.minGapMs / 60000} 分钟的空窗，最长 ${(A.longestGapMs / 3600000).toFixed(2)}h`)
    console.log(`  分桶：${Object.entries(A.gapsByBucket).map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log('  最近 5 段（最长的几段基本是跨夜关机，不能只看它们）：')
    for (const g of A.recentGaps) console.log(`    ${(g.gapMs / 3600000).toFixed(2)}h  ${g.from} → ${g.to}`)
  }
  console.log('')
  console.log('旧路径**记不到**的项：')
  for (const n of ev.notRecorded) console.log(`  ${n.key}: ${n.why}`)
  if (ev.unmappedActions.length > 0) {
    console.log('')
    console.log(`⚠ 未识别的状态动作（审计模型可能已变）：${ev.unmappedActions.join(', ')}`)
  }

  if (argv.includes('--tasks')) {
    console.log('')
    console.log('逐任务轨迹：')
    for (const t of ev.perTask.filter((x) => x.auditRows > 0).slice(0, 25)) {
      const lat = t.latencyMs === null ? '—' : `${(t.latencyMs / 1000).toFixed(1)}s`
      console.log(`  ${t.id} [${t.status}] ${t.role} ${lat} ${t.states.join('→')}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
