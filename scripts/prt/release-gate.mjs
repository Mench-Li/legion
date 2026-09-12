// scripts/prt/release-gate.mjs
// ============================================================================
// PRT-614 的**可执行发布检查单**（spec line 936 / §6.6 line 472）。
//
// `runtime/dsh-composition/release-gate.mjs` 是判据，本文件是它的**唯一生产调用方**：
// 没有这一层，"发布门禁"就只是一个从没人跑过的模块。
//
//   > 一个「写好了一份发布门禁判据」的实现，
//   > 与一个「没有任何东西会在发布前跑它」的实现，是同一个东西——
//   > 只不过前者在代码审查里看起来是"门禁已经建立"。
//
// ## 用法
//
//   node scripts/prt/release-gate.mjs --evidence <file.json>
//
// 证据文件是**外部事实**（启动自检结果、有没有在记决定来源、legacy 上还剩哪些
// 高风险工具、有几个调度器）。本脚本能自己从仓库里推导的只有很小一部分，
// 剩下的一律按**未就绪**处理——缺失的证据不是证据。
//
// 退出码：0 = 门禁满足；1 = 未满足；2 = 用法错误或证据文件读不了。
//
// ## 输出纪律
//
// 报表里**永远**打印指标的 verdict，而不是只打印那个数字。原因见
// `release-gate.mjs` 的文件头：`未批准高风险写 = 0` 在门禁未满足时
// 是一个**由我们造出来的**零，不是证据。
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  READINESS_ITEMS,
  RELEASE_GATE_VERSION,
  evaluateReadiness,
  evaluateReleaseMetric,
  legacyHighRiskPolicy,
} from '../../runtime/dsh-composition/release-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

export function parseArgs(argv) {
  const out = { evidence: null, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--evidence') out.evidence = argv[++i] ?? null
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else return { error: `未知参数 ${JSON.stringify(a)}` }
  }
  return out
}

const USAGE = `用法：node scripts/prt/release-gate.mjs --evidence <file.json> [--json]

证据文件（JSON）的字段，全部可选——**没给的一律按未就绪处理**：
  selfCheck               startupSelfCheck 的返回（逐项结论，不重判）
  decisionSourceRecorded  tool_calls 是否真的在记 decisionSource（spec line 480）
  path                    'legacy' | 'product-runtime'
  legacyHighRiskTools     legacy 路径上仍然可用的高风险工具名数组
  schedulers              正在扫描该空间的调度器名数组
  observations            { attempted, unapproved } 高风险写的观测数据
`

/**
 * 从证据对象算出完整的发布结论。
 *
 * 拆成纯函数是为了能被用例直接调——脚本的 `main` 只负责读文件与打印。
 */
export function releaseReport(evidence = {}) {
  const gate = evaluateReadiness(evidence)
  const metric = evaluateReleaseMetric({ gate, observations: evidence.observations ?? {} })
  return Object.freeze({ gate, metric, version: RELEASE_GATE_VERSION })
}

function render(report) {
  const { gate, metric } = report
  const lines = []
  lines.push(`发布门禁 ${report.version}`)
  lines.push(`执行路径：${gate.path === null ? '（未给）' : gate.path}`)
  lines.push('')
  lines.push('就绪项：')
  for (const item of gate.items) {
    lines.push(`  ${item.ok ? '✔' : '✖'} ${item.label}${item.ok ? '' : `  [${item.code}]`}`)
    for (const r of item.reasons) lines.push(`      · ${r}`)
  }
  lines.push('')
  lines.push(`门禁：${gate.satisfied ? '满足' : '不满足'}（未就绪 ${gate.unsatisfied.length} 项）`)

  // ★ 指标**永远**带 verdict 打印。只打印数字正是本模块要防的那件事。
  lines.push('')
  lines.push('发布指标「未批准高风险写操作为零」：')
  lines.push(`  verdict : ${metric.verdict}${metric.metricValid ? '' : '（这个数字目前不是证据）'}`)
  lines.push(`  尝试    : ${metric.attempted}`)
  lines.push(`  未批准  : ${metric.unapproved}`)
  lines.push(`  说明    : ${metric.reason}`)

  // 若 legacy 上还有高风险工具，逐条给出本模块规定的处置。
  if (gate.legacyHighRiskTools.length > 0) {
    lines.push('')
    lines.push('legacy 高风险工具处置：')
    for (const tool of gate.legacyHighRiskTools) {
      const d = legacyHighRiskPolicy({ risk: 'high', gate, path: gate.path, toolName: tool })
      lines.push(`  ${d.allowed ? '放行' : '拒绝'} ${tool}  — ${d.reason}`)
    }
  }
  return lines.join('\n')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error) { process.stderr.write(`${args.error}\n\n${USAGE}`); return 2 }
  if (args.help) { process.stdout.write(USAGE); return 0 }

  let evidence = {}
  if (args.evidence !== null) {
    const p = resolve(ROOT, args.evidence)
    if (!existsSync(p)) {
      // 证据文件不存在 → **不用空证据继续**。空证据会被读成"全部未就绪"，
      // 那是正确的结论，但把它伪装成"我们查过了"会让真正的失败原因
      // （打错路径）被这条更响的结论盖住。
      process.stderr.write(`证据文件不存在：${p}\n`)
      return 2
    }
    try { evidence = JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
      process.stderr.write(`证据文件不是合法 JSON：${e.message}\n`)
      return 2
    }
  }

  const report = releaseReport(evidence)
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${render(report)}\n`)

  // **门禁**决定退出码，指标不参与——指标是报表，门禁是闸门。
  return report.gate.satisfied ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}

export { READINESS_ITEMS, render, USAGE }
