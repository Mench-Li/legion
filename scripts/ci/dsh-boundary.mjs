#!/usr/bin/env node
/**
 * PRT-002 / PRT-108：DSH 执行面边界扫描（棘轮 ratchet）
 *
 * 目的
 *   Product Runtime 的核心承诺是「Legion 产品层只通过 Runtime Contract 调用执行引擎」。
 *   在 Orchestrator/Adapter 建好之前，这个承诺唯一的可执行形式是**阻止耦合继续扩散**：
 *   今天 `plugins/src/index.ts` 直接依赖 DSH 执行面，这是迁移期必须保留的兼容基线；
 *   但新代码不得再往这个数字上加。
 *
 * 为什么是棘轮而不是一次性清单
 *   PRT-002 要求建立依赖清单，PRT-108 要求 CI 静态边界检查。清单会过期（代码每周都在动），
 *   棘轮不会：基线只在**显式** `--update-baseline` 时下移，任何新增调用点都直接红。
 *   因此本脚本同时承担两件事：产出可读清单（--report）与守住不增长（--check）。
 *
 * 三类判定
 *   1. 执行面 API  —— Runtime Contract 之外的新代码不得调用；仅适配层豁免。
 *   2. 边界模块    —— 新架构模块（契约/编排/产品/安全）必须为零，永不允许进基线。
 *   3. 其余文件    —— 与基线逐文件逐记号比对，只许减不许增。
 *
 * 判定口径只认「DSH 执行面」这一小片，不把 `ctx.effect` / `ctx.logger` / `ctx.webServer`
 * 之类的宿主平面能力算进来：team-hub 与 board-plugin 是合法的宿主插件，把它们一起棘轮
 * 只会制造噪音，反而让真正的边界告警被淹没。
 *
 * 零第三方依赖（仅 node: 内置），与仓库其余 CI 脚本一致。
 *
 * 用法
 *   node scripts/ci/dsh-boundary.mjs                   # 等同 --check
 *   node scripts/ci/dsh-boundary.mjs --check           # 与基线比对，违规 exit 1
 *   node scripts/ci/dsh-boundary.mjs --report          # 打印当前依赖清单（人读）
 *   node scripts/ci/dsh-boundary.mjs --update-baseline # 重写基线（只在刻意下移时使用）
 *   node scripts/ci/dsh-boundary.mjs --json            # 以 JSON 输出扫描结果（供其他脚本消费）
 *   node scripts/ci/dsh-boundary.mjs --help
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'ci', 'dsh-boundary-baseline.json')

/** 扫描的源码扩展名。 */
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/

/**
 * 第三方技能缓存：不是 Legion 源码，且体量大（499 文件）。
 * 排除它需要理由，因此在这里写明，而不是靠一条静默的通配符。
 */
const EXCLUDED_PREFIXES = ['.skills-cache/']

/**
 * 扫描器自身与它的夹具：这两个文件**按构造**含有执行面记号（正则模式与测试字面量），
 * 不是产品耦合。把它们计入基线会同时污染债务清单并让「扫描结果==基线」失去意义。
 * 只列这两个确切路径，不用目录通配符——避免把真正的产品代码一起放过。
 */
const EXCLUDED_FILES = new Set([
  'scripts/ci/dsh-boundary.mjs',
  'scripts/ci/dsh-boundary.test.mjs',
])

/**
 * 执行面印记 1：通过 ctx 访问的 DSH 执行服务。
 * 这些服务属于「单 Agent 推理循环」，是 Runtime Contract 要隔离的对象。
 */
const EXECUTION_SERVICES = ['subagents', 'agentDefaultModel', 'agents', 'agentPresets']

/**
 * 执行面印记 2：由 Cordis `inject` 声明的硬依赖。
 * 声明式依赖比调用点更硬——它决定插件在服务缺失时会进入 waiting，因此同样计入边界。
 */
const INJECT_SERVICES = ['subagents', 'agentDefaultModel', 'agents', 'agentPresets']

/**
 * 执行面印记 3：DSH 执行面包。
 * 注意 `dsh-agent` 是 `dsh-agent-default-model` 的前缀，匹配时必须带词边界，
 * 否则一个更具体的包会被误记成两个记号。
 */
const EXECUTION_PACKAGES = [
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]

/**
 * 适配层：Runtime Contract 的唯一 DSH 实现处，允许自由使用执行面 API。
 * 这是「唯一允许调用」的落点，因此它不进基线、也不报违规。
 */
const ADAPTER_PREFIXES = ['runtime/adapters/dsh/', 'runtime/dsh-composition/']

/**
 * 必须为零的边界模块：新架构中与 DSH 无关的模块。
 * 它们永不允许进基线，否则一次 `--update-baseline` 就能把违规洗白。
 * `runtime/contracts/` 尤其关键：契约必须独立于 Cordis/DSH 类型，否则 Fake Adapter 测不了编排。
 */
const MUST_BE_ZERO_PREFIXES = [
  'runtime/contracts/',
  'runtime/manager/',
  'orchestrator/',
  'product/',
  'security/',
]

// ---------------------------------------------------------------- 扫描

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 词边界：避免 `dsh-agent` 命中 `dsh-agent-default-model`、`ctx.agents` 命中 `ctx.agentPresetsX`。 */
const TAIL = '(?![-a-zA-Z0-9_$])'

const SERVICE_RE = new Map(
  EXECUTION_SERVICES.map((svc) => [
    `ctx.${svc}`,
    new RegExp(`\\bctx\\s*\\??\\.\\s*${escapeRe(svc)}\\b${TAIL}`, 'g'),
  ]),
)

/** 下标访问形式 `ctx['subagents']`，与点号访问等价。 */
const SERVICE_INDEX_RE = new Map(
  EXECUTION_SERVICES.map((svc) => [
    `ctx.${svc}`,
    new RegExp(`\\bctx\\s*\\??\\s*\\[\\s*['"]${escapeRe(svc)}['"]\\s*\\]`, 'g'),
  ]),
)

const PACKAGE_RE = new Map(
  EXECUTION_PACKAGES.map((pkg) => [
    pkg,
    // 只认 import/require/from 位置的包说明符，不误伤注释里提到的包名。
    new RegExp(`(?:from\\s*['"]|import\\s*\\(\\s*['"]|require\\(\\s*['"])${escapeRe(pkg)}${TAIL}`, 'g'),
  ]),
)

/** 从 `inject: [...]` 数组字面量里取出声明的服务名。 */
function injectHits(source, tokenKey) {
  let count = 0
  const re = /\binject\s*[:=]\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(source)) !== null) {
    const names = m[1].match(/['"]([a-zA-Z0-9_$]+)['"]/g) || []
    for (const raw of names) {
      const name = raw.slice(1, -1)
      if (`inject.${name}` === tokenKey) count += 1
    }
  }
  return count
}

/**
 * 待扫描的源码文件（相对 ROOT，统一 `/` 分隔）。
 *
 * 口径是「已跟踪 + 未跟踪但未被忽略」，而不是只用 `git ls-files`：
 * 只用已跟踪文件会让**本地** --check 看不见刚新建、还没 `git add` 的文件，
 * 于是本地全绿、提交后 CI 才红。CI 里文件必然已提交，两种口径等价；
 * 但本地必须同样拦得住，否则棘轮在提交前那一步是失效的。
 */
function trackedSourceFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split(sep).join('/'))
    .filter((p) => SOURCE_EXT.test(p))
    .filter((p) => !EXCLUDED_PREFIXES.some((pre) => p.startsWith(pre)))
    .filter((p) => !EXCLUDED_FILES.has(p))
    .sort()
}

const hasPrefix = (p, list) => list.some((pre) => p.startsWith(pre))

/**
 * 扫描一个文件，返回 `{ token: 次数 }`。只统计执行面记号。
 * 文件在扫描前解耦于行尾：仓库 Windows 检出为 CRLF，而提交 blob 为 LF。
 *
 * ## 口径是**词法**的：注释与字符串里的记号同样计数（刻意偏保守）
 *
 * 我一度把它改成「先剥注释再统计」，理由是注释不构成运行时依赖，
 * 而适配器的说明文字会让它自己的零耦合声明退化成「靠 adapterPrefixes 豁免」。
 * 改完发现这是笔坏交易，已回退，原因记录在此以免重犯：
 *
 * `stripComments` 无法识别**正则字面量**。`/https?:\/\//` 里的 `//`
 * 会被当成行注释起点，于是该行剩余部分被吞掉——若同一行还有
 * `ctx.subagents.start()`，一次真实调用就此消失。
 * 也就是说这个改动会把**假阳性换成假阴性**，而边界门禁里
 * 「漏算让回归溜过」远比「多算导致注释一提就红」严重。
 *
 * 正确的做法是让适配层的注释不要出现真实记号（现已如此，
 * 于是适配层真的是 0，而不是被豁免成 0）。
 */
export function scanSource(source) {
  const text = source.replace(/\r\n?/g, '\n')
  const hits = {}
  const bump = (token, n) => {
    if (n > 0) hits[token] = (hits[token] || 0) + n
  }
  for (const [token, re] of SERVICE_RE) {
    re.lastIndex = 0
    bump(token, (text.match(re) || []).length)
  }
  for (const [token, re] of SERVICE_INDEX_RE) {
    re.lastIndex = 0
    bump(token, (text.match(re) || []).length)
  }
  for (const [token, re] of PACKAGE_RE) {
    re.lastIndex = 0
    bump(token, (text.match(re) || []).length)
  }
  for (const svc of INJECT_SERVICES) bump(`inject.${svc}`, injectHits(text, `inject.${svc}`))
  return hits
}

/** 扫描整个仓库，返回 `{ file: {token: 次数} }`（跳过零命中的文件）。 */
export function scanRepo() {
  const result = {}
  for (const rel of trackedSourceFiles()) {
    let text
    try {
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      continue // 已删除但仍在索引中；忽略，不作为违规
    }
    // 去掉 BOM，避免首行记号因 \uFEFF 前缀漏配
    const hits = scanSource(text.replace(/^\uFEFF/, ''))
    if (Object.keys(hits).length > 0) result[rel] = hits
  }
  return result
}

/** 所有记号的总数，用于报告与对拍。 */
export function totalOf(hits) {
  return Object.values(hits).reduce((n, v) => n + v, 0)
}

// ---------------------------------------------------------------- 基线

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function baselineFileMap(baseline) {
  return (baseline && baseline.baseline) || {}
}

/**
 * 比对扫描结果与基线，返回违规列表。
 * 三类违规：边界模块非零、文件不在基线却出现执行面记号、记号次数超过基线。
 */
export function diffAgainstBaseline(scan, baseline) {
  const base = baselineFileMap(baseline)
  const violations = []

  for (const [file, hits] of Object.entries(scan)) {
    if (hasPrefix(file, ADAPTER_PREFIXES)) continue // 适配层豁免

    if (hasPrefix(file, MUST_BE_ZERO_PREFIXES)) {
      for (const [token, n] of Object.entries(hits)) {
        violations.push({
          file,
          token,
          kind: 'must-be-zero',
          actual: n,
          allowed: 0,
          message: `边界模块必须零 DSH 执行面依赖`,
        })
      }
      continue
    }

    const allowed = base[file]
    if (!allowed) {
      for (const [token, n] of Object.entries(hits)) {
        violations.push({
          file,
          token,
          kind: 'new-file',
          actual: n,
          allowed: 0,
          message: `文件不在基线中，却出现 DSH 执行面记号`,
        })
      }
      continue
    }

    for (const [token, n] of Object.entries(hits)) {
      const limit = allowed[token] || 0
      if (n > limit) {
        violations.push({
          file,
          token,
          kind: limit === 0 ? 'new-token' : 'increased',
          actual: n,
          allowed: limit,
          message: limit === 0 ? `基线中无此记号` : `超出基线次数`,
        })
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------- 输出

const C = process.stdout.isTTY
  ? { dim: (s) => `\u001b[2m${s}\u001b[0m`, red: (s) => `\u001b[31m${s}\u001b[0m`, green: (s) => `\u001b[32m${s}\u001b[0m`, bold: (s) => `\u001b[1m${s}\u001b[0m` }
  : { dim: (s) => s, red: (s) => s, green: (s) => s, bold: (s) => s }

function printReport(scan, baseline) {
  const base = baselineFileMap(baseline)
  const files = Object.keys(scan).sort()
  console.log(C.bold('DSH 执行面依赖清单（PRT-002）'))
  console.log(C.dim(`  仓库：${ROOT}`))
  console.log(C.dim(`  基线：${existsSync(BASELINE_PATH) ? relative(ROOT, BASELINE_PATH).split(sep).join('/') : '（尚未生成）'}`))
  console.log('')
  if (files.length === 0) {
    console.log(C.green('  未发现任何 DSH 执行面依赖。'))
    return
  }
  let grand = 0
  for (const f of files) {
    const hits = scan[f]
    const n = totalOf(hits)
    grand += n
    const exempt = hasPrefix(f, ADAPTER_PREFIXES) ? C.dim(' [适配层·豁免]') : ''
    console.log(`  ${C.bold(f)}${exempt}  ${C.dim('合计 ' + n)}`)
    for (const [token, count] of Object.entries(hits).sort()) {
      const limit = (base[f] || {})[token]
      let mark = ''
      if (limit === undefined) mark = C.dim('  (新增·未在基线)')
      else if (count > limit) mark = C.red('  (超过基线 ' + limit + ')')
      else if (count < limit) mark = C.green('  (低于基线 ' + limit + '，可下移)')
      console.log(`      ${token.padEnd(38)} ${String(count).padStart(3)}${mark}`)
    }
  }
  console.log('')
  console.log(`  文件 ${files.length} 个，执行面记号合计 ${grand} 处`)
  // 只有存在基线时才有「可下移」可言；否则每个文件都会因为基线缺失而显得可下移。
  const ratchetable = baseline
    ? files
        .filter((f) => !hasPrefix(f, ADAPTER_PREFIXES) && base[f])
        .filter((f) => Object.entries(scan[f]).some(([t, n]) => n < ((base[f] || {})[t] ?? Infinity)))
    : []
  if (ratchetable.length > 0) {
    console.log(C.green(`  可下移基线的文件：${ratchetable.join(', ')}`))
    console.log(C.dim('  下移请运行 node scripts/ci/dsh-boundary.mjs --update-baseline（并说明原因）'))
  }
}

function printViolations(violations) {
  console.log(C.bold('DSH 执行面边界检查（PRT-108）'))
  console.log('')
  for (const v of violations) {
    console.log(C.red(`  FAIL [${v.kind}] ${v.file}`))
    console.log(`       ${v.token}：实际 ${v.actual}，允许 ${v.allowed} —— ${v.message}`)
  }
  console.log('')
  console.log(C.red(`  共 ${violations.length} 处边界违规。`))
  console.log('')
  console.log('  处理方式（按优先级）：')
  console.log('    1. 把该调用移入 runtime/adapters/dsh/（适配层是唯一允许调用 DSH 执行面的地方）。')
  console.log('    2. 若确实属于迁移期兼容基线，需显式运行 --update-baseline 并在提交信息中说明理由；')
  console.log('       边界模块（runtime/contracts、orchestrator、product、security）永不接受基线例外。')
}

function usage() {
  console.log('dsh-boundary.mjs — DSH 执行面边界扫描（棘轮）')
  console.log('')
  console.log('  --check            与基线比对并对违规 exit 1（默认）')
  console.log('  --report           打印当前依赖清单')
  console.log('  --update-baseline  重写基线文件')
  console.log('  --json             输出 JSON 扫描结果')
  console.log('  --help             本说明')
}

// ---------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage(), process.exit(0)

  const scan = scanRepo()
  const baseline = loadBaseline()

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ root: ROOT, scan, baseline: baselineFileMap(baseline) }, null, 2))
    process.exit(0)
  }

  if (argv.includes('--update-baseline')) {
    const base = baselineFileMap(baseline)
    const next = {}
    // 适配层不进基线：它本来就允许调用，登记反而模糊了「基线=待迁移债务」的语义
    for (const [f, hits] of Object.entries(scan)) {
      if (hasPrefix(f, ADAPTER_PREFIXES)) continue
      if (hasPrefix(f, MUST_BE_ZERO_PREFIXES)) {
        console.error(C.red(`  拒绝写入：${f} 属于必须为零的边界模块，不得进入基线。`))
        process.exit(1)
      }
      next[f] = hits
    }
    const payload = {
      $comment:
        'PRT-002/PRT-108：DSH 执行面依赖基线。这份基线是「待迁移债务」，只许减不许增。' +
        '由 scripts/ci/dsh-boundary.mjs --update-baseline 生成；手工编辑会被下一次检查覆盖。',
      version: 1,
      rules: {
        executionServices: EXECUTION_SERVICES,
        injectServices: INJECT_SERVICES,
        executionPackages: EXECUTION_PACKAGES,
        adapterPrefixes: ADAPTER_PREFIXES,
        mustBeZeroPrefixes: MUST_BE_ZERO_PREFIXES,
        excludedPrefixes: EXCLUDED_PREFIXES,
        excludedFiles: [...EXCLUDED_FILES],
      },
      baseline: next,
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    const n = Object.entries(next).reduce((a, [, h]) => a + totalOf(h), 0)
    console.log(C.green(`  基线已更新：${relative(ROOT, BASELINE_PATH).split(sep).join('/')}`))
    console.log(`  记录 ${Object.keys(next).length} 个文件、${n} 处执行面记号。`)
    for (const k of Object.keys(base)) {
      if (!next[k]) console.log(C.green(`  已清零并移出基线：${k}`))
    }
    process.exit(0)
  }

  if (argv.includes('--report')) {
    printReport(scan, baseline)
    process.exit(0)
  }

  if (!baseline) {
    console.error(C.red('  未找到基线文件。先运行 --update-baseline 生成基线。'))
    process.exit(2)
  }

  const violations = diffAgainstBaseline(scan, baseline)
  if (violations.length > 0) {
    printViolations(violations)
    process.exit(1)
  }

  const files = Object.keys(scan).length
  const total = Object.values(scan).reduce((a, h) => a + totalOf(h), 0)
  console.log(
    C.green(`dsh-boundary: PASS（执行面依赖未增长：${files} 个文件 / ${total} 处，均在基线内）`),
  )
  process.exit(0)
}

// 作为脚本运行时才执行 main；被 import 时不执行，便于单测直接调用纯函数。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
