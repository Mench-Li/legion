#!/usr/bin/env node
// scripts/prt/baseline-snapshot.mjs
// ============================================================================
// PRT-007：旧系统平台契约基线（HTTP / 数据库 / 状态机）
//
// 目的：§14.2 要求对同一黄金任务比较新旧两条路径的「任务状态序列、结构化结果、
// 产物、审批与审计」。要比较，先得有一份**可 diff 的旧路径契约快照**——否则
// 「新路径没改变既有契约」只能靠人肉记忆判断。
//
// 本工具从源码**提取**平台表面，不执行任何进程、不连数据库：
//   - team-hub HTTP 路由（方法 + 路径）
//   - SQLite 表名
//   - 任务状态机（STATUSES + TRANSITIONS）
//   - 目标状态机
//   - 权限决策模式
//
// 输出刻意**不含时间戳**：快照要能逐字节 diff，时间戳会让每次都「有变化」。
// 漂移由 `sources` 里各源文件的 sha256 归因。
//
// 为什么**不**接进 CI 作为阻断门禁：
//   迁移期旧路径仍在被并行开发（新增路由、加表是常态）。把它做成硬门禁会让
//   每个正常的功能提交都红，最后必然被人用 `--record` 无脑刷掉，反而失去意义。
//   因此它是**比较工具**：阶段 3 对拍、以及每次 DSH/产品升级前手动跑一次 diff。
//
// 用法：
//   node scripts/prt/baseline-snapshot.mjs --record    # 写入/刷新基线
//   node scripts/prt/baseline-snapshot.mjs --diff      # 与基线比较（默认）
//   node scripts/prt/baseline-snapshot.mjs --json      # 打印当前提取结果
//   node scripts/prt/baseline-snapshot.mjs --help
// ============================================================================
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_PATH = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-007-baseline.json')

const SOURCES = {
  server: join(ROOT, 'team-hub', 'server.mjs'),
  permissions: join(ROOT, 'team-hub', 'permission-engine.mjs'),
}

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 提取失败必须抛错，而不是安静地记录一个空基线。
 * 一个「看起来正常但什么都没提取到」的基线，比没有基线更危险：
 * 它会让后续 diff 全部显示为「新增」，从而被当成噪音忽略。
 */
function must(cond, message) {
  if (!cond) throw new Error(`基线提取失败：${message}`)
}

/** 提取 HTTP 路由。四种书写顺序都要认，否则会漏掉一半端点。 */
/**
 * 抽取规则与源码脱节的护栏阈值。
 * 真实源码远高于阈值；单测用小型夹具时通过 `min` 覆盖，以免为了测试而拆掉护栏。
 */
const MIN_ROUTES = 10
const MIN_TABLES = 10

/**
 * 提取 HTTP 路由。四种书写顺序都要认，否则会漏掉一半端点。
 * @param {string} source
 * @param {{min?: number}} [options] 覆盖最小路由数护栏（单测用）
 */
export function extractRoutes(source, options = {}) {
  const min = options.min ?? MIN_ROUTES
  const routes = new Set()
  const patterns = [
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\s*===\s*'([^']+)'/g,
    /path\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\.startsWith\(\s*'([^']+)'/g,
    /path\.startsWith\(\s*'([^']+)'\s*\)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
  ]
  // 前两个 pattern 是 (method, path)，后两个是 (path, method)
  const isMethodFirst = [true, false, true, false]
  patterns.forEach((re, i) => {
    let m
    while ((m = re.exec(source)) !== null) {
      const [method, path] = isMethodFirst[i] ? [m[1], m[2]] : [m[2], m[1]]
      // 只收 API 面：静态资源与内部路径不属于平台契约
      if (!path.startsWith('/api/')) continue
      routes.add(`${method} ${path}`)
    }
  })
  must(routes.size >= min, `HTTP 路由只提取到 ${routes.size} 条（下限 ${min}），抽取规则可能已与源码脱节`)
  return [...routes].sort()
}

/**
 * 提取 SQLite 表名。
 * @param {string} source
 * @param {{min?: number}} [options]
 */
export function extractTables(source, options = {}) {
  const min = options.min ?? MIN_TABLES
  const tables = new Set()
  const re = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g
  let m
  while ((m = re.exec(source)) !== null) tables.add(m[1])
  must(tables.size >= min, `SQLite 表只提取到 ${tables.size} 张（下限 ${min}），抽取规则可能已与源码脱节`)
  return [...tables].sort()
}

/** 提取一个字符串数组字面量，如 const STATUSES = ['a', 'b']。 */
export function extractStringArray(source, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([^\\]]*)\\]`)
  const m = re.exec(source)
  must(m, `找不到 ${constName} 数组字面量`)
  const items = m[1].match(/'([^']*)'/g) || []
  must(items.length > 0, `${constName} 数组为空`)
  return items.map((s) => s.slice(1, -1))
}

/**
 * 提取状态迁移表。只解析 `key: ['a', 'b'],` 形态的字面量块。
 * 不做 eval：基线工具自身不应执行被采集文件里的代码。
 */
export function extractTransitions(source, constName) {
  const start = source.indexOf(`const ${constName} = {`)
  must(start !== -1, `找不到 ${constName} 对象字面量`)
  const end = source.indexOf('\n}', start)
  must(end !== -1, `${constName} 对象字面量未闭合`)
  const block = source.slice(start, end)
  const out = {}
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[([^\]]*)\]\s*,?\s*$/gm
  let m
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = (m[2].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)).sort()
  }
  must(Object.keys(out).length > 3, `${constName} 只解析出 ${Object.keys(out).length} 个状态`)
  return out
}

/** 提取权限决策模式（MODES 集合）。 */
export function extractPermissionModes(source) {
  const m = /const\s+MODES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(source)
  must(m, '找不到 MODES 集合')
  const modes = (m[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1))
  must(modes.length > 0, 'MODES 为空')
  return [...modes].sort()
}

/** 生成快照（确定性：不含时间戳，键序固定）。 */
export function buildSnapshot() {
  for (const [name, p] of Object.entries(SOURCES)) {
    must(existsSync(p), `源文件不存在：${rel(p)}（${name}）`)
  }
  const server = readFileSync(SOURCES.server, 'utf8')
  const perms = readFileSync(SOURCES.permissions, 'utf8')

  return {
    $comment:
      'PRT-007 旧系统平台契约基线。由 scripts/prt/baseline-snapshot.mjs 生成；' +
      '不含时间戳以便逐字节 diff。漂移由 sources 的 sha256 归因。',
    version: 1,
    sources: Object.fromEntries(
      Object.entries(SOURCES).map(([name, p]) => [rel(p), sha256(readFileSync(p, 'utf8'))]),
    ),
    httpRoutes: extractRoutes(server),
    dbTables: extractTables(server),
    taskStatuses: extractStringArray(server, 'STATUSES'),
    taskTransitions: extractTransitions(server, 'TRANSITIONS'),
    goalStatuses: extractStringArray(server, 'GOAL_STATUSES'),
    permissionModes: extractPermissionModes(perms),
  }
}

// ---------------------------------------------------------------- diff

/** 比较两份快照，返回人类可读的差异行。 */
export function diffSnapshots(before, after) {
  const lines = []
  const listDiff = (label, a = [], b = []) => {
    const added = b.filter((x) => !a.includes(x))
    const removed = a.filter((x) => !b.includes(x))
    for (const x of added) lines.push(`  + ${label}: ${x}`)
    for (const x of removed) lines.push(`  - ${label}: ${x}`)
  }
  listDiff('路由', before.httpRoutes, after.httpRoutes)
  listDiff('数据表', before.dbTables, after.dbTables)
  listDiff('任务状态', before.taskStatuses, after.taskStatuses)
  listDiff('目标状态', before.goalStatuses, after.goalStatuses)
  listDiff('权限模式', before.permissionModes, after.permissionModes)

  // 迁移表的每条边单独比较，能定位到具体状态
  const states = new Set([...Object.keys(before.taskTransitions ?? {}), ...Object.keys(after.taskTransitions ?? {})])
  for (const s of [...states].sort()) {
    listDiff(`迁移 ${s}`, before.taskTransitions?.[s] ?? [], after.taskTransitions?.[s] ?? [])
  }
  for (const [file, hash] of Object.entries(after.sources ?? {})) {
    const prev = before.sources?.[file]
    if (prev && prev !== hash) lines.push(`  ~ 源文件已变更（需人工确认是否为契约变化）：${file}`)
  }
  return lines
}

function summary(snap) {
  return [
    `  路由       ${snap.httpRoutes.length}`,
    `  数据表     ${snap.dbTables.length}`,
    `  任务状态   ${snap.taskStatuses.length}（迁移边 ${Object.values(snap.taskTransitions).flat().length}）`,
    `  目标状态   ${snap.goalStatuses.length}`,
    `  权限模式   ${snap.permissionModes.length}`,
  ].join('\n')
}

function usage() {
  console.log('baseline-snapshot.mjs — PRT-007 旧系统平台契约基线')
  console.log('')
  console.log('  --record   写入/刷新基线')
  console.log('  --diff     与基线比较（默认）')
  console.log('  --json     打印当前提取结果')
  console.log('  --help     本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage(), process.exit(0)

  let current
  try {
    current = buildSnapshot()
  } catch (err) {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(current, null, 2))
    process.exit(0)
  }

  if (argv.includes('--record')) {
    writeFileSync(OUT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
    console.log(`基线已写入 ${rel(OUT_PATH)}`)
    console.log(summary(current))
    process.exit(0)
  }

  if (!existsSync(OUT_PATH)) {
    console.error(`未找到基线 ${rel(OUT_PATH)}。先运行 --record。`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(OUT_PATH, 'utf8'))
  const lines = diffSnapshots(before, current)
  if (lines.length === 0) {
    console.log('baseline-snapshot: 平台契约与基线一致（无漂移）')
    process.exit(0)
  }
  console.log('baseline-snapshot: 检测到平台契约漂移')
  console.log(lines.join('\n'))
  console.log('')
  console.log('  若确为有意变更，运行 --record 刷新基线并在提交信息中说明。')
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
