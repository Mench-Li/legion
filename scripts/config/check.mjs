// check.mjs — 配置校验命令（P3-2 交付项之一）
//
//   node scripts/config/check.mjs                    # 校验三进程 + 打印脱敏摘要 + 跨进程一致性
//   node scripts/config/check.mjs --process=whiteboard
//   node scripts/config/check.mjs --json             # 机器可读（供 CI/文档）
//   node scripts/config/check.mjs --env-file=.env    # 额外加载 KEY=VALUE 文件（仅本命令使用，不改变进程语义）
//   node scripts/config/check.mjs --strict           # 把 warning 也当失败（CI 可用）
//
// 退出码：0 = 无 error（且 strict 下无 warning）；1 = 有 error/strict 违规；2 = 用法错误。
//
// 安全：所有输出都经过引擎脱敏；本命令**从不打印** secret 原文（含 --json）。
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveConfig, redactConfig, summaryObject, SOURCE, TYPES } from '../../packages/shared/src/config.mjs'
import { runCrossChecks } from './cross-checks.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 进程 → schema 模块（相对 ROOT）
 *
 *  **这是唯一权威映射**：`scripts/config/scan.mjs` 的 `schemaModuleFor()` 直接引用它。
 *  在 PRT-251 之前这里有两份手写映射（scan.mjs 一份、本文件一份），
 *  新增 `product` 进程时只更新了其中一份，于是 `topology-inventory --diff` 报出
 *  「声明缺口：product 的 8 个 LEGION_* 键未声明」——而 `scan --check` 同时说
 *  「全部已处理」。**两份映射必然漂移**，因此合并为一份。 */
export const SCHEMA_FILES = Object.freeze({
  'team-hub': 'team-hub/config-schema.mjs',
  workbench: 'workbench/scripts/config-schema.mjs',
  whiteboard: 'whiteboard/apps/server/src/config-schema.mjs',
  // P3-4：DSH 插件族（其主配置面仍是宿主 composition，这里覆盖它们从进程环境读取的项）
  plugins: 'plugins/config-schema.mjs',
  'board-plugin': 'board-plugin/config-schema.mjs',
  'services-plugin': 'services-plugin/config-schema.mjs',
  // PRT-251：产品层（Launcher）。登记在这里等于声明「它的读取面有权威 schema」。
  product: 'product/config-schema.mjs',
})

/** 解析 --env-file=path（KEY=VALUE，忽略空行与 # 注释；不展开变量引用）
 *  重复键**不静默**：后值生效并记入 duplicates（env 文件写两次是真实陷阱）。 */
export function parseEnvFileDetailed(text) {
  const values = {}
  const duplicates = []
  const invalid = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) { invalid.push(line); continue }
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { invalid.push(line); continue }
    if (Object.prototype.hasOwnProperty.call(values, key)) duplicates.push(key)
    values[key] = val
  }
  return { values, duplicates, invalid }
}

export function parseEnvFile(text) {
  return parseEnvFileDetailed(text).values
}

export async function loadSchemas(names) {
  const out = {}
  for (const name of names) {
    const file = join(ROOT, SCHEMA_FILES[name] ?? '')
    if (!existsSync(file)) throw new Error(`找不到 ${name} 的 schema：${SCHEMA_FILES[name]}`)
    const mod = await import(pathToFileURL(file).href)
    out[name] = mod.SCHEMA
  }
  return out
}

/** 收集一份配置里各 secret 的「是否已设置」，用于在没有明文的前提下做跨进程比对提示 */
export function secretPresence(schema, values) {
  const out = {}
  for (const key of schema.secretKeys()) out[key] = Boolean(values[key])
  return out
}

function usage() {
  console.log(`用法：node scripts/config/check.mjs [选项]
  --process=<name>        只校验指定进程（${Object.keys(SCHEMA_FILES).join(' / ')}）
  --json                  以 JSON 输出（已脱敏）
  --env-file=<path>       额外加载 KEY=VALUE 文件（仅本命令；进程语义不变）
  --isolated-env          只用 --env-file（忽略当前进程环境）；CI 用它消除宿主会话变量干扰
  --show-source           摘要中标注每个值的来源（cli/env/default）
  --strict                warning 也视为失败
  --no-cross              跳过跨进程一致性检查
  --quiet                 只输出结论`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { usage(); return 0 }
  const json = argv.includes('--json')
  const strict = argv.includes('--strict')
  const quiet = argv.includes('--quiet')
  const showSource = argv.includes('--show-source')
  const noCross = argv.includes('--no-cross')
  const only = argv.find((a) => a.startsWith('--process='))?.slice('--process='.length)
  const envFile = argv.find((a) => a.startsWith('--env-file='))?.slice('--env-file='.length)
  const isolated = argv.includes('--isolated-env')

  const names = only ? [only] : Object.keys(SCHEMA_FILES)
  for (const n of names) {
    if (!SCHEMA_FILES[n]) { console.error(`未知进程：${n}`); usage(); return 2 }
  }

  let env = { ...process.env }
  const fileWarnings = []
  if (envFile) {
    if (!existsSync(envFile)) { console.error(`--env-file 不存在：${envFile}`); return 2 }
    const { values: fromFile, duplicates, invalid } = parseEnvFileDetailed(readFileSync(envFile, 'utf8'))
    for (const k of duplicates) fileWarnings.push(`--env-file 中 ${k} 重复出现（后值生效）`)
    for (const l of invalid) fileWarnings.push(`--env-file 中忽略了无法解析的行：${l}`)
    // 默认：真实环境优先（校验「本机实际会生效的配置」）；
    // --isolated-env：只用文件（CI 用，避免宿主会话注入的变量（如 TEAM_HUB_PORT/DSH_WEB_URL）干扰结论）
    env = isolated ? fromFile : { ...fromFile, ...process.env }
  } else if (isolated) {
    env = {}
  }

  const schemas = await loadSchemas(names)
  const configs = {}
  let errorCount = 0
  let warnCount = 0
  for (const name of names) {
    const schema = schemas[name]
    const resolved = resolveConfig(schema, { env, argv, checkUnknownEnv: true })
    // P3-4：schema 自带的**进程内一致性规则**（各预算之间的包含关系等）。规则是纯函数，
    // 只读到已解析的值；level 决定它计入 error 还是 warning。
    const ruleViolations = (schema.rules ?? []).flatMap((rule) => rule(resolved.values))
    configs[name] = { schema, resolved, ruleViolations }
    errorCount += resolved.errors.length + ruleViolations.filter((v) => v.level === 'error').length
    warnCount += resolved.warnings.length + ruleViolations.filter((v) => v.level === 'warning').length
  }

  let cross = []
  if (!noCross && names.length > 1) {
    cross = runCrossChecks(configs, { existsFn: (p) => existsSync(join(ROOT, p)) })
    errorCount += cross.filter((c) => c.level === 'error').length
    warnCount += cross.filter((c) => c.level === 'warning').length
  }
  for (const w of fileWarnings) warnCount += 1

  if (json) {
    const payload = {
      ok: errorCount === 0 && (!strict || warnCount === 0),
      processes: Object.fromEntries(Object.entries(configs).map(([n, c]) => [n, {
        ...summaryObject(c.schema, c.resolved),
        values: redactConfig(c.schema, c.resolved.values),
        ruleViolations: c.ruleViolations,
      }])),
      crossChecks: cross,
      fileWarnings,
      counts: { errors: errorCount, warnings: warnCount },
    }
    console.log(JSON.stringify(payload, null, 2))
    return payload.ok ? 0 : 1
  }

  if (!quiet) {
    for (const [name, { schema, resolved }] of Object.entries(configs)) {
      console.log(`\n=== ${name}：${schema.title} ===`)
      for (const f of schema.fields) {
        const src = showSource ? `  [${resolved.sources[f.key] ?? SOURCE.DEFAULT}]` : ''
        const v = f.sensitive
          ? (resolved.values[f.key] ? '***（已设置）' : '（未设置）')
          : formatVal(resolved.values[f.key])
        console.log(`  ${f.env.padEnd(32)} ${String(v).padEnd(28)}${src}  ${f.doc ?? ''}`)
      }
      if (schema.notes.length) for (const n of schema.notes) console.log(`  注：${n}`)
      for (const e of resolved.errors) console.log(`  ✖ ${e.message}`)
      for (const w of resolved.warnings) console.log(`  ⚠ ${w.message}`)
      for (const v of configs[name].ruleViolations) console.log(`  ${v.level === 'error' ? '✖' : '⚠'} [${v.code}] ${v.message}`)
    }
    if (cross.length) {
      console.log('\n=== 跨进程一致性 ===')
      for (const c of cross) {
        console.log(`  ${c.level === 'error' ? '✖' : '⚠'} [${c.code}] ${c.message}`)
        if (c.hint) console.log(`      → ${c.hint}`)
      }
    }
    for (const w of fileWarnings) console.log(`  ⚠ ${w}`)
  }

  const ok = errorCount === 0 && (!strict || warnCount === 0)
  console.log(`\nconfig check: ${ok ? 'PASS' : 'FAIL'}（error ${errorCount}，warning ${warnCount}${strict ? '，strict' : ''}）`)
  return ok ? 0 : 1
}

function formatVal(v) {
  if (v === undefined || v === null) return '（未设置）'
  if (typeof v === 'string' && v === '') return '（空）'
  if (Array.isArray(v)) return v.join(',') || '（空）'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/config/check.mjs')
if (isMain) {
  process.exitCode = await main()
}

export { main as runConfigCheck, formatVal, TYPES }
