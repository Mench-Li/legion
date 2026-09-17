#!/usr/bin/env node
// scripts/prt/gf001-evidence.mjs
// ============================================================================
// GF-001 黄金流程「真实执行」证据采集器（PRT-004 / PRT-009）
//
// ## 为什么需要它
//
// PRT-004 把黄金流程定义为「阶段 3 新旧路径对拍」的基准，但在此之前**从未真正跑过**：
// 文档里只有**预期**状态序列（todo → in_progress → in_review → done）与一串 pending 项。
// 2026-09-11 gf001 空间里真实跑通了一次完整交付（planner → implementer → reviewer），
// 于是这些量从「预期」变成「实测」。本工具把那次执行的事实**从审计历史里提取**出来，
// 写成带出处的 JSON，供 baseline-measure.mjs 并入 PRT-009 基线。
//
// ## 为什么从审计历史提取，而不是重跑一次
//
// 重跑一次要再烧一遍真实模型调用，而且**单次顺利不能证明别的**；审计表里那次执行的
// 每一行（claim / patch / artifact / advance + 时间戳）都已经在，重跑只会得到一个更弱的证据。
// 本工具只读打开生产库，永不写它。
//
// ## 记不到的东西保持「记不到」
//
// token 用量、费用、峰值资源旧路径一律没有记录（无对应列）。本工具**不推算、不估算**，
// 把它们保留在 `notRecorded` 里——把「没记录」写成 0 或编一个数，会被阶段 3 拿去
// 当性能回退的判据，比留空有害得多。
//
// ## 验收由独立工具重算，不采信自述
//
// 验收四项交给 `gf001-run.mjs` 的 `verifyAcceptance` 在结果仓库上重新计算
// （真跑 npm test、真读 README、真与夹具对账）。本工具不复述 worker 的自我报告。
//
// 用法：
//   node scripts/prt/gf001-evidence.mjs                      # 打印证据 JSON
//   node scripts/prt/gf001-evidence.mjs --out=<path>         # 写入文件
//   node scripts/prt/gf001-evidence.mjs --no-test            # 不真跑 npm test
//   node scripts/prt/gf001-evidence.mjs --scope=<id>         # 换空间（默认 gf001）
// ============================================================================
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GOLDEN_TASK, fixtureHash } from './golden-flow.mjs'
import { DEFAULT_DB, distinctStates, measureLatency, openReadOnly, reconstructSequence } from './old-path-evidence.mjs'
import { SCRATCH_DIR, verifyAcceptance } from './gf001-run.mjs'

/**
 * 以 `member='general'` 记账、但**并非人类动作**的审计动作。
 *
 * `goal:done` 由 `settleGoalsOfScope(scope, by = 'general')` 在链末任务完成时**自动**写入，
 * 只是借了 general 的名义。若照搬「member=general 即人工介入」，一次全自动跑完的黄金流程
 * 会被算成 2 次人工介入——人工介入率凭空翻倍，而它恰恰是 PRT-009 要采集的指标。
 * 因此这里显式区分「人类发起」与「系统代记」。
 */
export const SYSTEM_ATTRIBUTED_ACTIONS = Object.freeze(['goal:done'])

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rel = (p) => p.replace(ROOT, '').replace(/^[\\/]/, '').replace(/\\/g, '/')

/** 把人读到的时间差算成毫秒；缺任一端返回 null（不是 0——「没记录」≠「零耗时」）。 */
function spanMs(from, to) {
  if (!from || !to) return null
  const a = Date.parse(from)
  const b = Date.parse(to)
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null
}

/**
 * 找出「跑通了的那次」黄金执行。
 *
 * 判据不是「有个 done 的目标」就算数：必须**链任务恰好覆盖黄金三段岗位且全部 done**。
 * gf001 空间里躺过两次被取消的失败尝试（同一 objective），只按状态挑会挑错。
 */
export function findGoldenRun(db, { scope = 'gf001', stageRoles = ['planner', 'implementer', 'reviewer'] } = {}) {
  const goals = db.prepare('SELECT id, objective, status, createdAt, endedAt, docsDir FROM goal WHERE scope = ?').all(scope)
  const candidates = []
  for (const g of goals) {
    const tasks = db.prepare('SELECT id, role, status FROM tasks WHERE goalId = ? ORDER BY id').all(g.id)
    if (tasks.length !== stageRoles.length) continue
    if (!tasks.every((t) => t.status === 'done')) continue
    if (tasks.map((t) => t.role).join(',') !== stageRoles.join(',')) continue
    candidates.push({ goal: g, tasks })
  }
  // 多次跑通时取最近一次（时间序稳定，不依赖 id 字样）
  candidates.sort((a, b) => String(b.goal.createdAt).localeCompare(String(a.goal.createdAt)))
  return candidates[0] ?? null
}

/** 同一 objective 的全部尝试（含被取消的失败尝试）——「跑了几次才成」本身就是证据。 */
export function findAttempts(db, { scope = 'gf001', objective }) {
  if (!objective) return []
  return db.prepare('SELECT id, status, createdAt, endedAt FROM goal WHERE scope = ? AND objective = ? ORDER BY createdAt').all(scope, objective)
}

/**
 * 采集一次黄金执行的全部实测项。
 *
 * @param db 只读打开的生产库
 */
export function collectEvidence(db, { scope = 'gf001', runTests = true } = {}) {
  const found = findGoldenRun(db, { scope })
  if (!found) {
    throw new Error(`在空间 ${scope} 未找到「三段岗位链全部 done」的黄金执行；无法采集实测序列`)
  }
  const { goal, tasks } = found
  const stageRoles = tasks.map((t) => t.role)

  // 逐任务还原状态序列。审计行按 taskId 取（audit.scope 记的是动作发起者的空间视图，
  // 不是任务归属空间——按 scope 过滤会漏行，这正是 old-path-evidence.mjs 注释里的坑）。
  const perTask = []
  for (const t of tasks) {
    const rows = db.prepare('SELECT seq, ts, member, action, detail FROM audit WHERE taskId = ? ORDER BY seq').all(t.id)
    const { states, unmappedActions, malformedDetails } = reconstructSequence(rows)
    // reconstructSequence 返回的是 {seq,at,state,action,member} 记录，不是字符串；
    // 序列名走 distinctStates、耗时走 measureLatency（两者都是既有工具的口径，别自造）。
    perTask.push({
      id: t.id,
      role: t.role,
      status: t.status,
      states: distinctStates(states),
      stateMarks: states.map((s) => ({ state: s.state, action: s.action, at: s.at, member: s.member })),
      latencyMs: measureLatency(states)?.ms ?? null,
      auditRows: rows.length,
      unmappedActions,
      malformedDetails,
    })
  }

  // 人工介入：member 为 general 的动作（Legion 里 general 就是人类指挥官），
  // 但要剔除「借 general 记账的系统动作」（见 SYSTEM_ATTRIBUTED_ACTIONS）。
  const chainIds = tasks.map((t) => t.id)
  const generalRows = db.prepare(
    `SELECT action, ts, taskId, goalId FROM audit
     WHERE member = 'general' AND (goalId = ? OR taskId IN (${chainIds.map(() => '?').join(',')}))`,
  ).all(goal.id, ...chainIds)
  const humanRows = generalRows.filter((r) => !SYSTEM_ATTRIBUTED_ACTIONS.includes(r.action))
  const systemRows = generalRows.filter((r) => SYSTEM_ATTRIBUTED_ACTIONS.includes(r.action))

  // 期望序列 vs 实测：逐任务判断，不合并成一个是/否——三段里可能只有一段不符。
  const expected = [...GOLDEN_TASK.expectedTaskStateSequence]
  const normalize = (states) => states.map((s) => (s === 'advanced' ? 'done' : s))
  const sequenceComparison = perTask.map((t) => {
    const seq = normalize(t.states)
    const matchedPrefix = expected.filter((e, i) => seq[i] === e).length
    return {
      id: t.id,
      role: t.role,
      observed: seq,
      specSequence: expected,
      matchedPrefixLength: matchedPrefix,
      fullyMatches: seq.length >= expected.length && expected.every((e, i) => seq[i] === e),
      missingStates: expected.filter((e) => !seq.includes(e)),
    }
  })
  const tasksMissingInReview = sequenceComparison.filter((s) => s.missingStates.includes('in_review')).length

  // 验收：独立重算（不采信 worker 自述）
  let acceptance = null
  let acceptanceError = null
  try {
    acceptance = verifyAcceptance(SCRATCH_DIR, { runTests })
    delete acceptance.detail?.testOutput // 输出太长，只留布尔与清单；完整输出见证据 md
  } catch (e) {
    acceptanceError = e.message
  }

  const attempts = findAttempts(db, { scope, objective: goal.objective })

  return {
    $comment:
      'GF-001 黄金流程真实执行证据。由 scripts/prt/gf001-evidence.mjs 从 team-hub 只读提取；'
      + '验收四项由 gf001-run.mjs 在结果仓库上独立重算。不含 token/费用/峰值资源——旧路径不记录这些量。',
    version: 1,
    flow: { id: 'GF-001', task: GOLDEN_TASK.id, title: GOLDEN_TASK.title },
    scope,
    goal: {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      createdAt: goal.createdAt,
      endedAt: goal.endedAt,
      docsDir: goal.docsDir ?? null,
    },
    pipeline: { stages: stageRoles, handoffs: GOLDEN_TASK.handoffs.length },
    // 同一 objective 被跑了几次：两次取消 + 一次成功
    attempts: {
      count: attempts.length,
      items: attempts.map((a) => ({ id: a.id, status: a.status, createdAt: a.createdAt, endedAt: a.endedAt })),
      succeededOn: attempts.findIndex((a) => a.id === goal.id) + 1,
    },
    tasks: perTask,
    fixtures: { repo: rel(SCRATCH_DIR), hash: fixtureHash() },
    acceptance,
    acceptanceError,
    sequenceComparison,
    findings: {
      tasksMissingInReview,
      inReviewNote: tasksMissingInReview === perTask.length && perTask.length > 0
        ? '黄金流程三段任务**均未经过 in_review**：流水线在产物登记后自动 advance 到下一阶段，'
          + '不经过人工验收闸门。§14.2 的预期序列把它当作必经状态，与本次实测不符——'
          + '对拍时必须先确认新路径走的是「自动推进」还是「人工闸门」，否则会对拍出一个二者都不走的过程。'
        : '三段任务中未全部经过 in_review，逐条见 sequenceComparison。',
    },
    /**
     * 两条「缺失状态」的性质**不同**，不能混为一谈：
     *   · `todo` 缺失 = **口径限制**。链任务由目标发布批量创建，没有 per-task 的 `create` 审计行，
     *     所以序列只能从 `claim` 起算。任务当时确实处于 todo，只是没被记成一行。
     *   · `in_review` 缺失 = **行为事实**。三段都直接 advance，没有任何一行 transition 到 in_review。
     * 把前者当成「任务跳过了 todo」、或把后者当成「审计漏记」，都会得出错误结论。
     */
    measurementCaveats: {
      todoNotObservable:
        'per-task 审计无 create 行（链任务由 goal 发布批量创建）→ 序列起点为 in_progress；'
        + '“缺 todo”是审计口径限制，不是任务真的跳过了 todo。',
      inReviewGenuinelyAbsent:
        '三段任务的全部审计行中没有任何 transition→in_review；这是流水线自动 advance 的行为事实。',
    },
    humanInterventions: {
      total: humanRows.length,
      perTaskMean: perTask.length > 0 ? Number((humanRows.length / perTask.length).toFixed(2)) : null,
      byAction: humanRows.reduce((m, r) => { m[r.action] = (m[r.action] ?? 0) + 1; return m }, {}),
      // 黄金链本身是自动跑完的；这里出现的人工动作属于「围绕这次执行」的介入
      actions: humanRows.map((r) => ({ ts: r.ts, action: r.action, taskId: r.taskId ?? null })),
      systemAttributed: {
        total: systemRows.length,
        byAction: systemRows.reduce((m, r) => { m[r.action] = (m[r.action] ?? 0) + 1; return m }, {}),
        note: '以 member=general 记账的系统动作（自动收尾），不计入人工介入。'
          + '照搬「member=general 即人工」会把全自动流程算成有人介入。',
      },
      acceptanceActions: humanRows.filter((r) => r.action === 'transition').length,
      note: '黄金链三段由流水线自动 advance 推进，因此没有人工验收动作；人工只做了发布目标这一步。',
    },
    measurements: {
      // PRT-009 pending 项 → 实测值。单位与口径写在 note 里，避免下游猜。
      'end-to-end-latency': {
        value: spanMs(goal.createdAt, goal.endedAt),
        unit: 'ms',
        note: '目标创建（goal:publish）→ 链末任务 done 的墙钟耗时。',
        samples: 1,
        caveat: 'n=1：PRT-009 要求取 3 次中位数以抵消冷启动，本次只有一次真实执行，未取中位数。',
      },
      'old-path-task-state-sequence': {
        // 三段岗位各自的实测序列（不合并）：planner/implementer/reviewer 走的路径可能不同
        value: sequenceComparison.map((s) => ({ role: s.role, taskId: s.id, sequence: s.observed })),
        note: '逐任务实测（advanced 归一为 done）；spec 预期序列一并给出以便对照。',
        expected: expected,
        matchesSpec: sequenceComparison.every((s) => s.fullyMatches),
      },
      'human-intervention-rate': {
        value: { total: humanRows.length, perTaskMean: perTask.length > 0 ? Number((humanRows.length / perTask.length).toFixed(2)) : null },
        unit: '次 / 任务',
        note: 'member=general 且非系统代记动作（已排除自动收尾 goal:done），范围为本次黄金执行的链任务与目标。',
        caveat: '单次运行的比率不足以描述分布；此处只作为「这一次实际介入了几次」的实测记录。',
      },
    },
    notRecorded: [
      { key: 'token-usage', why: 'team-hub schema 无 token 列；worker 用量未落库' },
      { key: 'estimated-cost', why: '依赖 token-usage；PRICING.asOf 仍为 UNSET' },
      { key: 'peak-resource', why: '旧路径不采样内存/CPU；需在目标平台单独采集' },
    ],
    provenance: {
      source: rel(DEFAULT_DB),
      readOnly: true,
      collectedBy: 'scripts/prt/gf001-evidence.mjs',
      note: '审计行按 taskId 归属提取（不按 audit.scope 过滤，避免漏行）。',
      resultRepo: rel(SCRATCH_DIR),
      resultRepoExists: existsSync(SCRATCH_DIR),
      acceptanceRecomputed: acceptance !== null,
    },
  }
}

// ------------------------------------------------------------------ CLI

function usage() {
  console.log('gf001-evidence.mjs — GF-001 黄金流程真实执行证据采集（PRT-004 / PRT-009）')
  console.log('')
  console.log('  --out=<path>   写入 JSON（默认只打印）')
  console.log('  --db=<path>    team-hub 源库（默认生产库，只读打开）')
  console.log('  --scope=<id>   空间 id（默认 gf001）')
  console.log('  --no-test      不真跑 npm test（验收的 testPassed 记为 null）')
  console.log('  --help         本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d

  const dbPath = arg('db', DEFAULT_DB)
  const scope = arg('scope', 'gf001')
  const out = arg('out', null)

  let db
  try {
    db = openReadOnly(dbPath)
  } catch (e) {
    console.error(`FAIL ${e.message}`)
    process.exit(2)
  }

  let evidence
  try {
    evidence = collectEvidence(db, { scope, runTests: !argv.includes('--no-test') })
  } catch (e) {
    console.error(`FAIL ${e.message}`)
    process.exit(1)
  } finally {
    db.close()
  }

  const text = JSON.stringify(evidence, null, 2)
  if (out) {
    writeFileSync(resolve(out), text + '\n', 'utf8')
    console.log(`已写入 ${out}`)
    const lat = evidence.measurements['end-to-end-latency'].value
    console.log(`黄金目标 ${evidence.goal.id}　尝试 ${evidence.attempts.count} 次（第 ${evidence.attempts.succeededOn} 次成功）`)
    console.log(`端到端 ${lat === null ? '未采集' : `${(lat / 1000).toFixed(1)}s`}　验收 ${evidence.acceptance?.accepted === true ? '通过' : '未通过'}`)
  } else {
    console.log(text)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
