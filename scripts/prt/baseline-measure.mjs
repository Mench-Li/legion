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
 */
export const PRICING = Object.freeze({
  $comment: '每百万 token 的美元单价。填入实际供应商报价并在 evidence 中注明来源与日期。',
  asOf: 'UNSET',
  currency: 'USD',
  perMillionTokens: Object.freeze({
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
 */
export const PENDING_ITEMS = Object.freeze([
  Object.freeze({
    key: 'token-usage',
    what: '黄金任务的 token 用量（input / output）',
    how: '跑一次 GF-001 真实执行，从 RunResult.usage 读取；或从 team-hub audit 的 usage 字段汇总',
    blockedBy: '需要模型凭证（spec §6.1 SECRET_UNAVAILABLE 之外的正常路径）',
  }),
  Object.freeze({
    key: 'estimated-cost',
    what: '黄金任务的费用估算',
    how: '用本次 token 用量 × PRICING.perMillionTokens[model] 计算（estimateCost）',
    blockedBy: '依赖 token-usage；且 PRICING.asOf 仍是 UNSET',
  }),
  Object.freeze({
    key: 'end-to-end-latency',
    what: '黄金任务端到端耗时（计划→实现→评审全流程）',
    how: '从 goal 创建到最终 done 的墙钟时间；取 3 次的中位数以抵消冷启动',
    blockedBy: '需要一次真实多岗位执行',
  }),
  Object.freeze({
    key: 'peak-resource',
    what: '峰值内存与 CPU',
    how: '执行期间每 100ms 采样各进程 RSS/CPU；Windows 上用 Get-Counter 或 tasklist /fo csv',
    blockedBy: '本机跨平台采样不可靠，需在目标平台按 PRT-011 选定的分发形态采集',
  }),
  Object.freeze({
    key: 'old-path-task-state-sequence',
    what: '旧路径实际发生的任务状态序列（§14.2 对拍基准）',
    how: '跑一次 GF-001 旧路径，从 audit 表按 seq 导出 task 状态变更序列，与 GOLDEN_TASK.expectedTaskStateSequence 对照',
    blockedBy: '需要一次真实执行（当前只有预期序列，尚无实测序列）',
  }),
  Object.freeze({
    key: 'human-intervention-rate',
    what: '人工介入次数与原因分布',
    how: '统计 permission_requests 与 exec_requests 中被人工处理的比例',
    blockedBy: '需要真实执行样本（单次运行不足以给出比率）',
  }),
])

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
    pending: PENDING_ITEMS.map((p) => ({ key: p.key, what: p.what, blockedBy: p.blockedBy })),
  }
}

function toMarkdown(m) {
  const lines = []
  lines.push('# PRT-009 成本 / 延迟 / 资源基线（自动生成）')
  lines.push('')
  lines.push('> 由 `scripts/prt/baseline-measure.mjs --record` 生成。`pending` 段不含数值：')
  lines.push('> 这些量必须有一次真实模型执行才能得到，编造数值会让阶段 3 误判性能回退。')
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
  lines.push('## 待采集（需一次真实模型执行）')
  lines.push('')
  lines.push('| 项 | 内容 | 阻塞原因 |')
  lines.push('| --- | --- | --- |')
  for (const p of PENDING_ITEMS) {
    lines.push(`| \`${p.key}\` | ${p.what} | ${p.blockedBy} |`)
  }
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
    for (const p of PENDING_ITEMS) {
      console.log(`  ${p.key}`)
      console.log(`    内容：${p.what}`)
      console.log(`    采集：${p.how}`)
      console.log(`    阻塞：${p.blockedBy}`)
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
