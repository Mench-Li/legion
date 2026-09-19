// scripts/prt/spec-tests-7.mjs
// ============================================================================
// 目标文档 **§7「测试与指标」** 的逐条投影：每一条要求
//   ① 对应 §6 的**哪一条退出条件**（或**为什么它不是退出条件**）；
//   ② 它在仓库里的**可复跑落点**（套件 / 用例文件 / PRT 条目）。
//
// ---------------------------------------------------------------------------
// ## 为什么需要这一格（第 37 轮）
//
// 前几轮核过：台账（140 条 ✅ 的证据）、F 表（F-01～F-25）、§9 那条九节链。
// 而 §7 此前**没有任何判据、也没有任何文档引用它**——
// `git grep '§7'` 在整仓里只命中别的东西。于是"§7 满足了没有"**无法回答**，
// 而这是目标文档自己的一节要求。
//
// ## 这一格真正防的形状
//
// ① **一整节要求没人认领**：§7 有 6 条，谁都没说它们各自对应哪条退出条件。
//    于是"做完 §7 了"与"从没读过 §7"在仓库里长得一模一样。
//
// ② ★★ 更要紧的：**把观测性指标读成未完成任务**。
//    §7 第 6 条那 6 个「持续观察」指标（事件遗漏/重复率、Run 恢复率、审批等待
//    与拒绝率、预算超限率、升级回滚成功率、商业 Alpha 交付周期）在代码里几乎
//    没有读出口——但它们**不在 §6 的任何一条退出条件里**（§6 五条退出条件逐字
//    读过，没有一条提指标）。
//
//    > 一条**观测性**要求与一条**完成标准**，在"未实现"这个读数下长得一模一样——
//    > 而前者不该拦发布，后者该。把它们混起来，要么永远关不掉，
//    > 要么用"指标没做"去否掉一个已经达标的发布。
//
//    所以本表**强制**每一条要求自报 `kind`：`exit-condition` 或 `observational`，
//    且 `observational` 必须写出**为什么它不是退出条件**（≥20 字，不是"记了一笔"）。
//
// ③ **引用的落点必须解得开**：复用 `ledger-evidence.mjs` 的 `extractMentions()`
//    与同一条解析口径（套件别名要真的是一行 CI 套件 / 路径原样存在 / 裸名唯一）。
//    ★ 复用而不是重写——第 36 轮刚在那处修过一个"把路径砍成文件名"的缺陷。
// ============================================================================
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { REPO } from './reachability.mjs'
import { suiteFilesFromCi } from './suite-counts.mjs'
import { extractMentions, ledgerEvidenceRows, CI_PATH, NAME_RE } from './ledger-evidence.mjs'

export const SPEC_PATH = `${REPO}/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`

/** 取一个 `## <标题>` 小节到下一个 `## ` 之间的正文行。 */
export function sectionLines(text, heading) {
  const lines = String(text).split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  return end < 0 ? rest : rest.slice(0, end)
}

/** §7 的 6 条要求（`- ` 开头的那些行）。 */
export function specBullets(specPath = SPEC_PATH) {
  const sec = sectionLines(readFileSync(specPath, 'utf8'), '## 7. 测试与指标')
  if (sec === null) return []
  return sec.map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
}

/** §6 那张表的「退出条件」列（逐格原文），用来核对 §7 的归属。 */
export function exitConditions(specPath = SPEC_PATH) {
  const sec = sectionLines(readFileSync(specPath, 'utf8'), '## 6. 优先级与退出条件')
  if (sec === null) return []
  const out = []
  for (const l of sec) {
    const t = l.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    if (!/^P[0-2]$/.test(cells[0])) continue
    out.push({ priority: cells[0], scope: cells[1], exit: cells[2] })
  }
  return out
}

/**
 * §7 六条要求 → §6 退出条件（或"不是退出条件"）+ 可复跑落点。
 *
 * ★ `excerpt` 必须与 §7 正文里的那一条**逐字同头**——它是这把表的锚，
 *   正文改字而这里不改 ⇒ R1 会红（不是静默漂）。
 * ★ `exit` 必须**逐字**出现在 §6 的某一条退出条件里（R4）——
 *   否则"这条要求托着哪条退出条件"就只是一句话。
 */
export const SPEC7_PROJECTION = Object.freeze([
  Object.freeze({
    key: 'fake-adapter-surface',
    excerpt: 'Runtime Contract 用 Fake Adapter 覆盖 health、execute、cancel、recover、终态和错误码。',
    kind: 'exit-condition',
    exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复',
    evidence: '套件 `runtime-contract`；`runtime/contracts/fake-adapter.test.mjs`、'
      + '`runtime/contracts/contract.test.mjs`；PRT-101～109',
    covered: '六项各有具名用例：health（健康状态可切换）/ execute（拒绝非法 RunRequest）/'
      + ' cancel（取消在事件边界生效）/ recover（只给判断、不改 Task 状态）/'
      + ' 终态（全部场景满足终态契约 + no-terminal 被检出）/ 错误码（每个可注入错误码都能产出）',
  }),
  Object.freeze({
    key: 'differential-isolation',
    excerpt: '新旧对拍只在隔离数据库、worktree 和非生产空间执行，不双跑客户任务。',
    kind: 'exit-condition',
    exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复',
    evidence: '`scripts/ci/dual-write-smoke.test.mjs`（`mkdtempSync(tmpdir())` 隔离库、'
      + '两个真进程同库并发写）；套件 `runtime-contract-cross-process`（真进程，经 HTTP 调 Runtime）',
    covered: '对拍在**临时目录**里的库上跑，不指向任何客户库；'
      + '真进程那条也是每例自建隔离库，不复用生产 DataDir',
  }),
  Object.freeze({
    key: 'fault-injection-7',
    excerpt: '故障注入覆盖 Runtime 崩溃、网络中断、重复事件、审批超时、凭证缺失、预算耗尽和升级失败。',
    kind: 'exit-condition',
    exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复',
    evidence: '`runtime/contracts/fake-adapter.test.mjs`（崩溃 / 凭证缺失 / 预算耗尽 三个注入场景 +'
      + '「故障矩阵无缺口」）；`product/launcher/readiness.test.mjs`（网络中断：连接被拒，含真 undici 形态）；'
      + '`team-hub/event-delivery.test.mjs`（重复事件：plan 幂等、重启不重投、二次取走被拒）；'
      + '`team-hub/approval-ttl.test.mjs`（审批超时：越期不得被批准、到期扫描幂等）；'
      + '`product/upgrade/upgrade.test.mjs`（升级失败：下载损坏 / 迁移失败 / 启动失败 / 健康检查失败四档）',
    covered: '7 类各有落点，且都**不是**"关键词命中"——每一类都打开文件读过具名用例',
  }),
  Object.freeze({
    key: 'security-5',
    excerpt: '安全测试覆盖 hard floor、approval fail closed、sandbox 能力不足、密钥脱敏和路径/网络越权。',
    kind: 'exit-condition',
    exit: '输入和权限可复现、可审计，hard floor 不可绕过',
    evidence: '`orchestrator/worker/executor.test.mjs`（hard floor）；'
      + '`runtime/adapters/dsh/adapter.test.mjs`（approval fail closed）；'
      + '`product/launcher/doctor.test.mjs`（sandbox 能力不足）；'
      + '`orchestrator/worker/context-stage.test.mjs`（密钥脱敏）；'
      + '`runtime/dsh-composition/production-scope-wiring.test.mjs`（路径越权）',
    covered: '5 项各有落点（全仓命中用例文件 25 / 17 / 8 / 25 / 38 个）',
  }),
  Object.freeze({
    key: 'static-boundary',
    excerpt: '静态检查禁止 Adapter 外新增 DSH API 直接调用。',
    kind: 'exit-condition',
    exit: 'Fake/真实 Adapter 对拍通过；并发、重试、崩溃可恢复',
    evidence: '`scripts/ci/dsh-boundary.mjs`（PRT-002 依赖清单 / PRT-108 执行面边界**棘轮**）；'
      + '`scripts/ci/dsh-boundary.test.mjs`；CI `boundary` 阶段的 `--check` 那一步',
    covered: '棘轮而非一次性清单：基线只在显式 `--update-baseline` 时下移，'
      + '任何新增调用点直接红；适配层是唯一豁免',
  }),
  Object.freeze({
    key: 'observe-metrics-6',
    excerpt: '持续观察事件遗漏/重复率、Run 恢复率、审批等待与拒绝率、预算超限率、'
      + '升级回滚成功率和商业 Alpha 交付周期。',
    kind: 'observational',
    whyNotExitCondition:
      '§6 那五条退出条件逐字读过，没有一条提"指标"。这是一条**持续观察**要求'
      + '（运行时读数），不是**发布闸门**：其中"商业 Alpha 交付周期"必须有真实用户项目'
      + '才量得出来（PRT-910 需真实用户项目），而另外五个所需的原始数据'
      + '（`run_reconciliations`、`usage_records`、升级记录、投递状态机）已经在库里，'
      + '缺的是**汇总读出口**而不是数据。把这条读成完成标准，会用"指标没做"'
      + '否掉一个已达标的发布；把它读成不存在，则没人会去补那五个读出口。',
    evidence: '部分有落点：套件 `usage-rollup`（按五维读用量）、套件 `budget-alert`（告警与降级）；'
      + '`product/heartbeat.mjs` 是**脱敏健康心跳**（PRT-713，默认关闭），不是指标出口',
    covered: '⚠️ **本条尚未全部实现**，且它**不是**完成标准——'
      + '这是一处如实记录的缺口，不是一处已关掉的缺口',
  }),
])

/** 两个合法档。 */
export const KINDS = Object.freeze(['exit-condition', 'observational'])

/**
 * 核对 §7 的投影。
 *
 * @param {{bullets: string[], exits: Array, projection: Array, suiteFiles: Map, tracked: string[]}} input
 */
export function checkSpec7({ bullets, exits, projection, suiteFiles, tracked }) {
  const violations = []
  // ★★★ "什么都没查"不许报绿（第 36 轮在自己手里犯过一次）。
  if (bullets.length === 0) {
    violations.push({ id: 'no-bullets', message: '§7 一条要求都没读到 ⇒ 这一格什么都没查（标题改了吗？）。' })
    return { ok: false, violations, reading: { bullets: 0, projection: 0, pointers: 0 } }
  }
  if (projection.length === 0) {
    violations.push({ id: 'no-projection', message: '投影表是空的 ⇒ §7 的每一条都没有归属。' })
    return { ok: false, violations, reading: { bullets: bullets.length, projection: 0, pointers: 0 } }
  }
  if (exits.length === 0) {
    violations.push({ id: 'no-exits', message: '§6 一条退出条件都没读到 ⇒ R4 无从核对。' })
  }

  const trackedSet = new Set(tracked)
  const byBase = new Map()
  for (const f of tracked) {
    if (!f.endsWith('.test.mjs')) continue
    const b = f.split('/').pop()
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(f)
  }

  // R1：§7 每一条**恰好**被投影一次（excerpt 逐字同头，且一一对应）
  const used = new Set()
  for (const b of bullets) {
    const hit = projection.filter((p) => b.startsWith(p.excerpt))
    if (hit.length === 0) {
      violations.push({
        id: 'bullet-unprojected', message: `§7 这一条没有任何投影行（谁都不认领它）：\n     「${b.slice(0, 60)}…」`,
      })
    } else if (hit.length > 1) {
      violations.push({
        id: 'bullet-multiply-projected',
        message: `§7 这一条被 ${hit.length} 个投影行认领（${hit.map((p) => p.key).join('、')}）`,
      })
    } else {
      used.add(hit[0].key)
    }
  }
  // R2：投影表里不许有**过期行**（对应不到 §7 的任何一条）
  for (const p of projection) {
    if (!used.has(p.key) && !bullets.some((b) => b.startsWith(p.excerpt))) {
      violations.push({ id: 'stale-projection', message: `投影行 \`${p.key}\` 对应不到 §7 的任何一条 ⇒ 正文改了而这里没改` })
    }
  }

  let pointers = 0
  const unresolved = []
  for (const p of projection) {
    // R3：`kind` 必须是那两档之一
    if (!KINDS.includes(p.kind)) {
      violations.push({ id: 'bad-kind', message: `\`${p.key}\` 的 kind 是 ${JSON.stringify(p.kind)}，不在 ${KINDS.join(' / ')} 里` })
      continue
    }
    // R4：退出条件档必须**逐字**指到 §6 的某一条（否则归属只是一句话）
    if (p.kind === 'exit-condition') {
      if (typeof p.exit !== 'string' || p.exit.length < 8) {
        violations.push({ id: 'no-exit-link', message: `\`${p.key}\` 是退出条件档，却没写它托着哪条退出条件` })
      } else if (!exits.some((e) => e.exit.includes(p.exit))) {
        violations.push({
          id: 'exit-link-not-in-section-6',
          message: `\`${p.key}\` 声明的退出条件在 §6 里**找不到**：\n     「${p.exit}」\n`
            + '   ⇒ 一条"托着某条退出条件"的说法，与一条真的托着它的要求，在这里长得一样。',
        })
      }
    } else {
      // R5：观测档必须写出**为什么它不是退出条件**（不是"记了一笔"）
      const why = p.whyNotExitCondition ?? ''
      if (why.trim().length < 20) {
        violations.push({
          id: 'observational-without-why',
          message: `\`${p.key}\` 是观测档，却没写清**为什么它不是完成标准**`
            + `（${why.trim().length} 字，下限 20）——`
            + '那样一条观测性要求和一条没做完的功能，在"未实现"这个读数下就分不开了',
        })
      }
    }
    // R6：每一条都要有可复跑落点，且**解得开**
    if (typeof p.evidence !== 'string' || p.evidence.trim().length === 0) {
      violations.push({ id: 'no-evidence', message: `\`${p.key}\` 没有写落点` })
      continue
    }
    const m = extractMentions(p.evidence)
    let found = 0
    for (const s of m.suites) {
      pointers += 1
      if (!suiteFiles.has(s)) unresolved.push(`\`${p.key}\` 的套件 \`${s}\` 不是 CI 里的一行`)
      else found += 1
    }
    // ★★★ 后引号里**像套件别名、而又真的是一行 CI 套件**的 token，
    //   如果**没有**写 `套件 ` 前缀，解析器不会把它当指针 ⇒ **它不会被核对**。
    //
    //   这不是假想的：本表第一版就有一处栽在这里——`budget-alert` 漏了前缀，
    //   于是它**看起来是证据、实际谁都没查**（探针读数 `suites=1`，而那一行写了两个套件）。
    //   ⚠️ 记一处就好，别写成"两处"——我当时以为 `runtime-contract-cross-process`
    //   也漏了，那是**探针输出被截断**造成的误读，它其实带着前缀、也被核对了。
    //
    //   > 一个漏了前缀的套件引用，与一个真的解得开的套件引用，
    //   > 在这一格里长得一模一样——只不过前者的绿来自**没被解析**。
    for (const tok of [...p.evidence.matchAll(/`([^`]+)`/g)].map((x) => x[1])) {
      if (!NAME_RE.test(tok)) continue
      if (tok.endsWith('.test.mjs')) continue
      if (!suiteFiles.has(tok)) continue
      if (m.suites.includes(tok)) continue
      violations.push({
        id: 'pointer-without-suite-prefix',
        message: `\`${p.key}\` 的落点里 \`${tok}\` **是一行真的 CI 套件**，却没有写 ` + '`套件 ` 前缀'
          + ' ⇒ 解析器不会把它当指针，**这一处永远不会被核对**。'
          + '补上前缀（或写成带目录的用例文件路径）。',
      })
    }
    for (const f of m.paths) {
      pointers += 1
      if (!trackedSet.has(f)) unresolved.push(`\`${p.key}\` 的路径 \`${f}\` 不是一个被跟踪的文件`)
      else found += 1
    }
    for (const b of m.bare) {
      pointers += 1
      const hits = byBase.get(b) ?? []
      if (hits.length === 0) unresolved.push(`\`${p.key}\` 的裸名 \`${b}\` 全仓没有`)
      else if (hits.length > 1) unresolved.push(`\`${p.key}\` 的裸名 \`${b}\` 全仓有 ${hits.length} 个同名`)
      else found += 1
    }
    if (found === 0) {
      violations.push({
        id: 'no-resolvable-evidence',
        message: `\`${p.key}\` 的落点一个都解不开 ⇒ 这一条要求没有任何可复跑落点`,
      })
    }
  }
  for (const u of unresolved) {
    violations.push({ id: 'unresolvable-pointer', message: u + '（读者按它去复核会找不到）' })
  }

  return {
    ok: violations.length === 0,
    violations,
    reading: {
      bullets: bullets.length,
      projection: projection.length,
      pointers,
      byKind: projection.reduce((a, p) => { a[p.kind] = (a[p.kind] ?? 0) + 1; return a }, {}),
      exits: exits.length,
    },
  }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ specPath = SPEC_PATH, ciPath = CI_PATH, tracked = null } = {}) {
  const list = tracked ?? execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'))
  return checkSpec7({
    bullets: specBullets(specPath),
    exits: exitConditions(specPath),
    projection: SPEC7_PROJECTION,
    suiteFiles: suiteFilesFromCi(readFileSync(ciPath, 'utf8')),
    tracked: list,
  })
}

// ── CLI：`node scripts/prt/spec-tests-7.mjs`（只读）────────────────────────
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')

if (isMain) {
  const r = checkRepo()
  console.log(`spec §7 要求 ${r.reading.bullets} 条 → 投影 ${r.reading.projection} 行`
    + `（${JSON.stringify(r.reading.byKind)}）；§6 退出条件 ${r.reading.exits} 条；落点 ${r.reading.pointers} 处`)
  if (r.ok) {
    console.log('\n✅ 每一条要求都有归属（退出条件 / 观测）且落点解得开')
    process.exit(0)
  }
  console.log(`\n✖ ${r.violations.length} 处：`)
  for (const v of r.violations) console.log(`  [${v.id}] ${v.message}`)
  process.exit(1)
}
