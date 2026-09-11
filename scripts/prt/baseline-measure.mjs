#!/usr/bin/env node
// scripts/prt/baseline-measure.mjs
// ============================================================================
// PRT-009：成本 / 延迟 / 资源基线采集
//
// 本工具只采集**不需要模型凭证**就能确定得到的那部分基线：
//   - 代码与平台表面规模（可 diff、可归因）
//   - SQLite 库规模与行数（读现有 DB 或临时空库）
//   - 进程就绪延迟与常驻内存（真实启动 team-hub 子进程并采样）
//   - 费用模型的**输入**（token 单价表 + 估算式）
//
// 明确**不**做的事：不伪造 token / 费用 / 端到端耗时的具体数值。
// 这三个量必须有一次真实的模型执行才能得到。本工具把它们的「采集协议」落成
// 可执行条目（见 --pending），而不是填一个估算值冒充基线——一个编造的基线
// 比没有基线更糟：阶段 3 会拿它当性能回退的判据。
//
// 用法：
//   node scripts/prt/baseline-measure.mjs --record    # 采集并写入 JSON + markdown
//   node scripts/prt/baseline-measure.mjs --json      # 只打印 JSON
//   node scripts/prt/baseline-measure.mjs --pending   # 列出仍需真实运行才能采集的项
//   node scripts/prt/baseline-measure.mjs --help
//
// 约定：`--no-spawn` 跳过需要启动子进程的采样（用于受限/只读环境）。
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_JSON = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-009-baseline.json')
const rel = (p) => relative(ROOT, p).split(sep).join('/')

/**
 * 单模型费用估算表。**这是数据而不是代码**：单价会随供应商调整，
 * 因此必须独立于契约（spec §6.1 的 `usage.estimatedCostUsd` 由产品侧按本表计算）。
 * 表中数值为「每百万 token 美元」，采集时必须注明来源与生效日期。
 *
 * ## 为什么三个模型的价格至今仍是 null
 *
 * GF-001 走的是自建网关 `custom-ds`（`https://fjbigmodel.fjdac.cn`），
 * **没有公开报价**可引用。填一个「看起来合理」的数字比留空更危险：
 * `estimateCost` 会返回它，预算检查会当真，而它没有任何来源。
 * 所以这里只把**实际用到的模型 id 摆好**，等真实报价到位时补两个数字即可。
 */
export const PRICING = Object.freeze({
  $comment: '每百万 token 的美元单价。填入实际供应商报价并在 evidence 中注明来源与日期。',
  asOf: 'UNSET',
  currency: 'USD',
  perMillionTokens: Object.freeze({
    // GF-001 实测用到的两个模型（自建网关，无公开报价 → 保持 null）
    'deepseek-v4-flash-openai': Object.freeze({ input: null, output: null }),
    'deepseek-v4-pro-openai': Object.freeze({ input: null, output: null }),
    'example-model-x': Object.freeze({ input: null, output: null }),
  }),
})

/** 由 token 用量与单价表计算费用；单价缺失时返回 null 而不是 0。 */
export function estimateCost({ tokensIn, tokensOut, model }, pricing = PRICING) {
  const entry = pricing.perMillionTokens[model]
  if (!entry || entry.input === null || entry.output === null) return null
  const cost = (tokensIn / 1e6) * entry.input + (tokensOut / 1e6) * entry.output
  return Number(cost.toFixed(6))
}

// ---------------------------------------------------------------- 静态规模

/** 源码规模：文件数与字节数。用于把「基线变化」归因到具体模块。 */
function measureSourceScale() {
  const targets = {
    'plugins/src/index.ts': null,
    'team-hub/server.mjs': null,
    'team-hub/permission-engine.mjs': null,
    'runtime/contracts': 'dir',
    'scripts/ci/dsh-boundary.mjs': null,
  }
  const out = {}
  for (const [target, kind] of Object.entries(targets)) {
    const abs = join(ROOT, target)
    if (!existsSync(abs)) {
      out[target] = null
      continue
    }
    if (kind === 'dir') {
      const files = readdirSafe(abs).filter((f) => f.endsWith('.mjs') || f.endsWith('.d.mts'))
      out[target] = {
        files: files.length,
        bytes: files.reduce((n, f) => n + statSync(join(abs, f)).size, 0),
      }
    } else {
      const st = statSync(abs)
      out[target] = { files: 1, bytes: st.size, lines: countLines(abs) }
    }
  }
  return out
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function countLines(file) {
  const text = readFileSync(file, 'utf8')
  let n = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n + (text.endsWith('\n') ? 0 : 1)
}

// ---------------------------------------------------------------- 进程采样

/**
 * 启动 team-hub 并采样「首次就绪」用时。
 *
 * 就绪判据用**端口可连接**而不是「进程未退出」：进程活着但 HTTP 未监听
 * 是最常见的假就绪。采样失败时返回 `{ok:false, reason}`，不抛错——
 * 基线采集不应因为本机环境差异而让整个工具失败。
 *
 * 内存/CPU **不在此处采集**：跨平台读取子进程 RSS 不可靠（Windows 需额外工具），
 * 与其返回一个恒为 null 的假采样，不如把它明确列为待采集项（见 PENDING_ITEMS）。
 */
async function measureHubStartup({ timeoutMs = 30000 } = {}) {
  const entry = join(ROOT, 'team-hub', 'server.mjs')
  if (!existsSync(entry)) return { ok: false, reason: 'team-hub/server.mjs 不存在' }

  const dataDir = mkdtempSync(join(tmpdir(), 'prt009-'))
  const port = 39000 + (process.pid % 500)
  const started = Date.now()

  let child
  try {
    child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: {
        ...process.env,
        // 用临时数据目录，避免污染真实库
        TEAM_HUB_DATA_DIR: dataDir,
        TEAM_HUB_DB_FILE: join(dataDir, 'hub.db'),
        PORT: String(port),
        TEAM_HUB_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return { ok: false, reason: `无法启动 team-hub：${err.message}` }
  }

  let stderrTail = ''
  child.stderr?.on('data', (b) => {
    stderrTail = (stderrTail + String(b)).slice(-800)
  })

  const ready = await waitForPort(port, timeoutMs).catch(() => false)
  const readyMs = ready ? Date.now() - started : null
  const exitCode = child.exitCode

  try {
    child.kill('SIGKILL')
  } catch { /* 已退出 */ }
  rmSync(dataDir, { recursive: true, force: true })

  if (!ready) {
    return {
      ok: false,
      reason: `端口 ${port} 在 ${timeoutMs}ms 内未就绪`,
      exitCode,
      stderrTail: stderrTail || null,
    }
  }
  return { ok: true, readyMs, port, peakRssBytes: null }
}

/** 轮询等待端口可连接。 */
async function waitForPort(port, timeoutMs) {
  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const s = net.connect({ port, host: '127.0.0.1' })
      const done = (v) => {
        s.destroy()
        res(v)
      }
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
      setTimeout(() => done(false), 500)
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// ---------------------------------------------------------------- 待采集项

/**
 * 需要一次**真实模型执行**才能采集的项。
 * 每条都给出可直接执行的命令，避免「以后再说」变成「永远不会做」。
 *
 * ## 2026-09-11 更新：六项里四项已由 GF-001 真实执行结清
 *
 * 长期挂着同一份「待采集」清单是危险的：**清单本身会变成噪音**，读的人默认它没变。
 * 所以每条都带上 `resolvedBy`——指向**承载数值的证据文件**与取值方式。
 * 数值不抄进代码（抄一次就多一处会与源漂移的副本），而是运行期从证据文件里读；
 * 文件不在（未跑过真实执行 / 换了机器）就如实显示「未采集」，绝不回落到旧数字。
 */
export const PENDING_ITEMS = Object.freeze([
  Object.freeze({
    key: 'token-usage',
    what: '黄金任务的 token 用量（input / output / cacheRead）',
    how: 'node scripts/prt/gf001-run.mjs report --out=docs/superpowers/prt/prt-009-gf001-execution.json',
    blockedBy: '需要模型凭证（spec §6.1 SECRET_UNAVAILABLE 之外的正常路径）',
    resolvedBy: Object.freeze({
      file: 'docs/superpowers/prt/prt-009-gf001-execution.json',
      extract: (j) => {
        const t = j?.execution?.totals
        if (!t) return null
        return `input ${t.input} / output ${t.output} / cacheRead ${t.cacheRead}（provider 上报，非估算；${j.execution.runs?.length ?? 0} 个岗位会话）`
      },
    }),
  }),
  Object.freeze({
    key: 'estimated-cost',
    what: '黄金任务的费用估算',
    how: '用本次 token 用量 × PRICING.perMillionTokens[model] 计算（estimateCost）',
    blockedBy: 'token 已采集；仍缺**有来源**的单价——自建网关无公开报价，PRICING.asOf 仍是 UNSET',
    resolvedBy: null,
  }),
  Object.freeze({
    key: 'end-to-end-latency',
    what: '黄金任务端到端耗时（计划→实现→评审全流程）',
    how: '目标 createdAt → endedAt；逐岗位取 claimedAt → updatedAt',
    blockedBy: '需要一次真实多岗位执行',
    resolvedBy: Object.freeze({
      file: 'docs/superpowers/prt/prt-009-gf001-execution.json',
      extract: (j) => {
        const g = j?.goal
        if (!g?.latencyMs) return null
        const roles = (j.execution?.taskLatencies ?? [])
          .map((t) => `${t.role} ${(t.latencyMs / 1000).toFixed(1)}s`).join(' / ')
        return `目标级 ${(g.latencyMs / 1000).toFixed(1)}s（${g.id}）；逐岗位 ${roles}`
      },
    }),
  }),
  Object.freeze({
    key: 'peak-resource',
    what: '峰值内存与 CPU',
    how: '执行期间外部采样各进程 RSS/CPU（Windows 可用 Get-Process 的 PeakWorkingSet64）',
    blockedBy: '会话转录不记录进程资源；需在执行期外部采样，且目标平台取决于 PRT-011 分发形态裁决（Task 4 待业主裁决）',
    resolvedBy: null,
  }),
  Object.freeze({
    key: 'old-path-task-state-sequence',
    what: '旧路径实际发生的任务状态序列（§14.2 对拍基准）',
    how: 'node scripts/prt/old-path-evidence.mjs --db=<team.db> --scope=software',
    blockedBy: '需要一次真实执行（当前只有预期序列，尚无实测序列）',
    resolvedBy: Object.freeze({
      file: 'docs/superpowers/prt/prt-009-execution-evidence.json',
      extract: (j) => {
        const s = j?.stateSequence
        if (!s) return null
        return `${s.completedWithTrail} 个有轨迹的已完成任务中，与字面预期序列相符 ${s.exactPrefixMatches} 个；${s.tasksSkippingInReview} 个不经过 in_review → 预期序列已被实测修正为「模态序列 + 可接受集合」`
      },
    }),
  }),
  Object.freeze({
    key: 'human-intervention-rate',
    what: '人工介入次数与原因分布',
    how: '审计里 member ∈ {general} 的动作数 / 完成任务数',
    blockedBy: '需要真实执行样本（单次运行不足以给出比率）',
    resolvedBy: Object.freeze({
      file: 'docs/superpowers/prt/prt-009-execution-evidence.json',
      extract: (j) => {
        const h = j?.human
        if (!h) return null
        return `${h.total} 次，涉及 ${h.tasksWithHuman} 个任务，每个完成任务 ${h.perTaskMean} 次（${j.taskCount} 个任务的样本）`
      },
    }),
  }),
])

/**
 * 用证据文件把「待采集」清单解析成「已采集 / 仍待采集」。
 *
 * @param readFile 注入的文件读取器：`(absPath) => string`；缺失时抛错即视为未采集。
 *                 注入而不是直接读盘，测试才能不依赖本机是否跑过真实执行。
 */
export function resolvePending({ readFile, items = PENDING_ITEMS, root = ROOT } = {}) {
  return items.map((item) => {
    if (item.resolvedBy === null || item.resolvedBy === undefined) {
      return { key: item.key, what: item.what, blockedBy: item.blockedBy, status: 'blocked', measured: null, evidence: null }
    }
    const rel = item.resolvedBy.file
    let measured = null
    let error = null
    try {
      measured = item.resolvedBy.extract(JSON.parse(readFile(join(root, rel))))
    } catch (err) {
      error = err.message
    }
    return {
      key: item.key,
      what: item.what,
      blockedBy: item.blockedBy,
      status: measured === null ? 'blocked' : 'measured',
      measured,
      evidence: measured === null ? null : rel,
      // 「文件在但字段缺」与「文件不在」是两回事：前者说明采集口径变了，要看一眼。
      unresolvedReason: measured === null ? (error ?? `证据文件中取不到该字段：${rel}`) : null,
    }
  })
}

// ---------------------------------------------------------------- 采集与输出

export async function measure({ spawnAllowed = true } = {}) {
  const { buildSnapshot } = await import('./baseline-snapshot.mjs')
  let platformContract = null
  let platformContractError = null
  try {
    const snap = buildSnapshot()
    platformContract = {
      httpRoutes: snap.httpRoutes.length,
      dbTables: snap.dbTables.length,
      taskStates: snap.taskStatuses.length,
      taskTransitionEdges: Object.values(snap.taskTransitions).flat().length,
      goalStates: snap.goalStatuses.length,
      permissionModes: snap.permissionModes.length,
      sources: snap.sources,
    }
  } catch (err) {
    platformContractError = err.message
  }

  return {
    $comment:
      'PRT-009 基线。machine-measured 段可重复采集；pending 段必须在一次真实模型执行后填入，' +
      '本工具不会为它们编造数值。',
    version: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    machineMeasured: {
      sourceScale: measureSourceScale(),
      platformContract,
      platformContractError,
      hubStartup: spawnAllowed ? await measureHubStartup() : { ok: false, reason: '--no-spawn' },
    },
    pricing: PRICING,
    pending: resolvePending({ readFile: (p) => readFileSync(p, 'utf8') }),
  }
}

function toMarkdown(m) {
  const lines = []
  lines.push('# PRT-009 成本 / 延迟 / 资源基线（自动生成）')
  lines.push('')
  lines.push('> 由 `scripts/prt/baseline-measure.mjs --record` 生成。')
  lines.push('> 「已由 GF-001 真实执行采集」段的数值**不在本文件里**，而是运行期从证据文件读出来的——')
  lines.push('> 抄一份进来就多一处会与源漂移的副本。仍待采集的项**不给数值**：编造数值会让阶段 3 误判性能回退。')
  lines.push('> 完整口径、复现命令与未覆盖项见 [docs/PRT-009-evidence/verify-evidence.md](../../PRT-009-evidence/verify-evidence.md)。')
  lines.push('')
  lines.push(`- Node：\`${m.node}\`　平台：\`${m.platform}/${m.arch}\``)
  lines.push('')
  lines.push('## 已测量（可重复采集）')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  for (const [file, v] of Object.entries(m.machineMeasured.sourceScale)) {
    if (v === null) {
      lines.push(`| \`${file}\` | 不存在 |`)
    } else {
      lines.push(`| \`${file}\` | ${v.files} 文件 / ${v.bytes} 字节${v.lines ? ` / ${v.lines} 行` : ''} |`)
    }
  }
  const pc = m.machineMeasured.platformContract
  if (pc) {
    lines.push(`| 平台 HTTP 路由 | ${pc.httpRoutes} |`)
    lines.push(`| 数据库表 | ${pc.dbTables} |`)
    lines.push(`| 任务状态 / 迁移边 | ${pc.taskStates} / ${pc.taskTransitionEdges} |`)
    lines.push(`| 权限模式 | ${pc.permissionModes} |`)
  }
  const hs = m.machineMeasured.hubStartup
  lines.push(`| team-hub 首次就绪 | ${hs.ok ? `${hs.readyMs} ms` : `未采集（${hs.reason}）`} |`)
  lines.push('')

  const measured = (m.pending ?? []).filter((p) => p.status === 'measured')
  const blocked = (m.pending ?? []).filter((p) => p.status !== 'measured')

  lines.push('## 已由 GF-001 真实执行采集')
  lines.push('')
  if (measured.length === 0) {
    lines.push('（无：证据文件不存在——本机尚未跑过真实执行，或证据未随仓库分发）')
  } else {
    lines.push('| 项 | 实测值 | 证据 |')
    lines.push('| --- | --- | --- |')
    for (const p of measured) lines.push(`| \`${p.key}\` | ${p.measured} | \`${p.evidence}\` |`)
  }
  lines.push('')
  lines.push('## 仍待采集')
  lines.push('')
  lines.push('| 项 | 内容 | 阻塞原因 |')
  lines.push('| --- | --- | --- |')
  for (const p of blocked) lines.push(`| \`${p.key}\` | ${p.what} | ${p.blockedBy} |`)
  lines.push('')
  return lines.join('\n')
}

function usage() {
  console.log('baseline-measure.mjs — PRT-009 成本/延迟/资源基线采集')
  console.log('')
  console.log('  --record     采集并写入 JSON + markdown')
  console.log('  --json       只打印 JSON')
  console.log('  --pending    列出仍需真实运行才能采集的项')
  console.log('  --no-spawn   跳过需要启动子进程的采样')
  console.log('  --help       本说明')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()

  if (argv.includes('--pending')) {
    const resolved = resolvePending({ readFile: (p) => readFileSync(p, 'utf8') })
    for (const p of resolved) {
      const mark = p.status === 'measured' ? '✅ 已采集' : '⛔ 待采集'
      console.log(`  ${mark}  ${p.key}`)
      console.log(`    内容：${p.what}`)
      if (p.status === 'measured') {
        console.log(`    实测：${p.measured}`)
        console.log(`    证据：${p.evidence}`)
      } else {
        console.log(`    阻塞：${p.blockedBy}`)
        if (p.unresolvedReason) console.log(`    说明：${p.unresolvedReason}`)
      }
    }
    return
  }

  const m = await measure({ spawnAllowed: !argv.includes('--no-spawn') })

  if (argv.includes('--json')) {
    console.log(JSON.stringify(m, null, 2))
    return
  }
  if (argv.includes('--record')) {
    writeFileSync(OUT_JSON, JSON.stringify(m, null, 2) + '\n', 'utf8')
    console.log(`已写入 ${rel(OUT_JSON)}`)
    const md = join(ROOT, 'docs', 'superpowers', 'prt', 'PRT-009-baseline.md')
    writeFileSync(md, toMarkdown(m) + '\n', 'utf8')
    console.log(`已写入 ${rel(md)}`)
    console.log('')
    console.log(toMarkdown(m))
    return
  }
  usage()
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  })
}
