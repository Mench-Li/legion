// scan.mjs — 配置读取点扫描器（P3-2 统一配置系统）
//
// 目的：让「配置 schema」不只写在文档里，而是**可机器校验**。
//   ① `node scripts/config/scan.mjs`                → 列出各进程真实读取的 env 键（含动态访问）
//   ② `node scripts/config/scan.mjs --check`        → 任一读取点未在该进程 schema 中声明即失败
//   ③ `node scripts/config/scan.mjs --json`         → 机器可读输出（供 CI/文档）
//
// 判定口径：只把「进程启动/运行期直接读取环境变量」的点计入；测试文件默认排除
//（测试会人为构造 env 做断言，不代表生产配置面），需要时用 --include-tests 打开。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** 各进程的扫描范围（与 PROCESSES 一致；工作树的 worktrees 目录一律跳过）
 *  P3-4 起把 DSH 插件族也纳入：插件的主配置面是宿主 composition，但它们**从进程环境读取**的
 *  少数项（提示词预算、hub token 回落）同样属于配置面，必须可扫描、可校验。 */
export const PROCESSES = Object.freeze({
  'team-hub': { label: 'team-hub v2（对话/日程数据面）', dirs: ['team-hub'] },
  workbench: { label: '军团指挥台（workbench 宿主与静态服务）', dirs: ['workbench/scripts', 'workbench/src'] },
  whiteboard: { label: '协作白板（独立子项目）', dirs: ['whiteboard/apps/server/src', 'whiteboard/scripts'] },
  plugins: { label: '士兵守护插件族（plugins/：scrum-worker / mediator）', dirs: ['plugins/src'] },
  'board-plugin': { label: 'Scrum 看板插件（宿主 iframe 面板）', dirs: ['board-plugin/src'] },
  'services-plugin': { label: '服务托管插件（随 Desktop 启停三进程）', dirs: ['services-plugin'] },
})

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.legion-worktrees', '.worktrees', 'releases', 'scratch', 'coverage', 'data', '.ci', 'vendor'])
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts'])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), out)
    } else if (entry.isFile() && CODE_EXT.has(extname(entry.name))) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** 从源码文本里抽出 env 键读取点；动态访问（process.env[expr]）单列，必须显式登记。 */
export function extractEnvReads(text) {
  const literal = new Set()
  const suspicious = new Set()
  const dynamic = []
  // process.env.NAME / env.NAME（后者仅匹配形如 `env.NAME` 且同一行出现 process.env? 不臆测，只认 process.env）
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) literal.add(m[1])
  // process.env['NAME'] / process.env["NAME"]
  for (const m of text.matchAll(/process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) literal.add(m[1])
  // 解构：const { A, B: alias } = process.env
  for (const m of text.matchAll(/const\s*\{([^}]+)\}\s*=\s*process\.env/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) literal.add(name)
    }
  }
  // ② 形如 `env.NAME` / `env['NAME']`（env 为独立标识符或其结尾，如 options.env.NAME）
  for (const m of text.matchAll(/(?:^|[^\w.'"])(?:\w+\.)*env\.([A-Za-z_][A-Za-z0-9_]*)/g)) literal.add(m[1])
  for (const m of text.matchAll(/(?:\w+\.)*env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) literal.add(m[1])
  // ②b 别名环境对象：`const baseEnv = { ...process.env, ... }` 之后写 `baseEnv.NAME`
  //     （P3-4 实测：services-plugin 正是这样读 TEAM_HUB_HOST/TOKEN 与 DSH_HUB_UPSTREAM——
  //     直接扫描完全看不到这些读取点，与 P3-2 那批 `envBytes(name, def)` 间接读取是同一类盲区。）
  for (const m of text.matchAll(/(?:^|[^\w.'"])(\w*[Ee]nv)\.([A-Z][A-Z0-9_]*)\b/g)) literal.add(m[2])
  // ③ 疑似 env 形态的大写字面量（'WB_MAX_CONNECTIONS' 这类被当 key 传进读取辅助函数的常量）
  //    启发式：可能含非 env 命中，故 --check 下要求「声明或显式列入 nonEnvLiterals」
  for (const m of text.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g)) {
    const v = m[1]
    if (!v.includes('_') && v.length < 6) continue // 排除 'ERROR' 这类单词常量
    suspicious.add(v)
  }
  // 动态下标：process.env[expr]（expr 非字符串字面量）
  for (const m of text.matchAll(/process\.env\[([^\]]+)\]/g)) {
    const inner = m[1].trim()
    if (!/^['"][A-Za-z_][A-Za-z0-9_]*['"]$/.test(inner)) dynamic.push(inner)
  }
  for (const m of text.matchAll(/(?:\w+\.)*env\[\s*([^\]'"]+)\]/g)) {
    const inner = m[1].trim()
    if (!/^['"][A-Za-z_][A-Za-z0-9_]*['"]$/.test(inner)) dynamic.push(`env[${inner}]`)
  }
  for (const k of literal) suspicious.delete(k) // 已确认为直接读取
  return { literal, dynamic, suspicious }
}

/** 取「git 跟踪文件」集合（仓库相对路径，正斜杠）。
 *  为什么必须限制在跟踪文件：主检出里常有本地工具与构建产物（实测 `team-hub/.watch.mjs`
 *  读 `process.env.DB`、`team-hub/lib/index.js` 是构建产物），把它们算进「配置面」会让
 *  `scan --check` 的结果**依赖本机状态**（工作树通过、主检出失败）。git 不可用时返回 null，
 *  调用方回退到目录遍历并在输出中标注，保证结论可解释。 */
export function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))
  } catch {
    return null
  }
}

/** 扫描单个进程；返回 { name, files, reads:Map<key, {count, files:string[]}>, dynamic:[] } */
export function scanProcess(name, { includeTests = false, onlyTracked = true } = {}) {
  const spec = PROCESSES[name]
  if (!spec) throw new Error(`未知进程：${name}（可选：${Object.keys(PROCESSES).join(', ')}）`)
  const tracked = onlyTracked ? trackedFiles(ROOT) : null
  const useGit = tracked !== null
  const files = []
  for (const d of spec.dirs) walk(join(ROOT, d), files)
  const reads = new Map()
  const dynamic = []
  const suspicious = new Map()
  let scanned = 0
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/')
    if (useGit && !tracked.has(rel)) continue // 未跟踪的本地文件/产物不属于配置面
    if (!includeTests && /\.test\.|\.spec\.|smoke/.test(rel)) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    scanned += 1
    const { literal, dynamic: dyn, suspicious: sus } = extractEnvReads(text)
    for (const key of literal) {
      const cur = reads.get(key) ?? { count: 0, files: [] }
      cur.count += 1
      if (cur.files.length < 4 && !cur.files.includes(rel)) cur.files.push(rel)
      reads.set(key, cur)
    }
    for (const key of sus) {
      const cur = suspicious.get(key) ?? { count: 0, files: [] }
      cur.count += 1
      if (cur.files.length < 3 && !cur.files.includes(rel)) cur.files.push(rel)
      suspicious.set(key, cur)
    }
    for (const d of dyn) dynamic.push({ file: rel, expr: d })
  }
  return { name, label: spec.label, filesScanned: scanned, reads, dynamic, suspicious, mode: useGit ? 'git-tracked' : 'walk（git 不可用：结果已包含未跟踪文件，仅作调试参考）' }
}

/** 未声明读取点（对照 schema 的 env 名单） */
export function undeclaredReads(scan, declaredEnvNames) {
  const declared = new Set(declaredEnvNames)
  return [...scan.reads.keys()].filter((k) => !declared.has(k)).sort()
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const check = argv.includes('--check')
  const includeTests = argv.includes('--include-tests')
  const noGit = argv.includes('--no-git')
  const only = argv.find((a) => a.startsWith('--process='))?.slice('--process='.length)
  const names = only ? [only] : Object.keys(PROCESSES)

  const results = []
  let violations = 0
  let suspiciousCount = 0
  for (const name of names) {
    const scan = scanProcess(name, { includeTests, onlyTracked: !noGit })
    let declaredEnv = null
    let undeclared = []
    let undeclaredLiterals = []
    if (check) {
      const schemaPath = schemaModuleFor(name)
      if (!existsSync(schemaPath)) {
        undeclared = [...scan.reads.keys()].sort()
        undeclaredLiterals = [...scan.suspicious.keys()].sort()
        violations += undeclared.length + undeclaredLiterals.length
      } else {
        // 动态导入 schema：schema 是纯数据（+ 少量纯函数），无副作用
        const mod = await import(pathToFileURL(schemaPath).href)
        declaredEnv = mod.SCHEMA.envNames()
        undeclared = undeclaredReads(scan, declaredEnv)
        // 疑似 env 字面量：必须「是一个已声明 env 键名」或「显式列入 nonEnvLiterals」或「属声明前缀」或「登记为 foreignEnv」
        const foreign = (mod.SCHEMA.foreignEnv ?? []).map((x) => (typeof x === 'string' ? x : x.name))
        const known = new Set([...declaredEnv, ...(mod.SCHEMA.nonEnvLiterals ?? []), ...(mod.SCHEMA.prefixes ?? []), ...foreign])
        undeclaredLiterals = [...scan.suspicious.keys()].filter((k) => !known.has(k)).sort()
        violations += undeclared.length + undeclaredLiterals.length
      }
    }
    suspiciousCount += scan.suspicious.size
    results.push({
      ...scan,
      reads: [...scan.reads.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
      literals: [...scan.suspicious.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key)),
      declaredEnv,
      undeclared,
      undeclaredLiterals,
    })
  }

  if (json) {
    console.log(JSON.stringify({ processes: results.map((r) => ({ ...r, reads: r.reads, literals: r.literals })) }, null, 2))
  } else {
    for (const r of results) {
      console.log(`\n=== ${r.name}：${r.label} ===`)
      console.log(`  扫描模式 ${r.mode}；扫描文件 ${r.filesScanned} 个；直接读取 env 键 ${r.reads.length} 个；疑似 env 字面量 ${r.literals.length} 个${r.dynamic.length ? `；动态访问 ${r.dynamic.length} 处` : ''}`)
      for (const read of r.reads) console.log(`    ${read.key.padEnd(34)} ×${String(read.count).padEnd(3)} ${read.files[0]}`)
      if (r.literals.length) {
        console.log(`    —— 疑似 env 字面量（需声明或列入 nonEnvLiterals）——`)
        for (const lit of r.literals) console.log(`    ${lit.key.padEnd(34)} ×${String(lit.count).padEnd(3)} ${lit.files[0]}`)
      }
      if (r.dynamic.length) {
        for (const d of r.dynamic) console.log(`    [动态] ${d.file}  →  ${d.expr}`)
      }
      if (r.undeclared.length || r.undeclaredLiterals.length) {
        if (r.undeclared.length) console.log(`  ✖ 未声明 env 键（${r.undeclared.length}）：${r.undeclared.join(', ')}`)
        if (r.undeclaredLiterals.length) console.log(`  ✖ 未处理字面量（${r.undeclaredLiterals.length}）：${r.undeclaredLiterals.join(', ')}`)
      } else if (r.declaredEnv) {
        console.log('  ✔ 全部读取点与字面量已在 schema 中处理')
      }
    }
  }
  if (check && violations > 0) {
    console.error(`\nscan: FAIL —— ${violations} 项未在 schema 中处理（补进对应进程的 config-schema，或列入 nonEnvLiterals 并写明理由）`)
    process.exit(1)
  }
  if (check) console.log(`\nscan: PASS（全部 env 读取点与疑似字面量均已处理；共 ${suspiciousCount} 个疑似字面量）`)
}

/** 进程 → schema 模块路径（相对 ROOT），供 --check 对照使用 */
export function schemaModuleFor(name) {
  const map = {
    'team-hub': 'team-hub/config-schema.mjs',
    workbench: 'workbench/scripts/config-schema.mjs',
    whiteboard: 'whiteboard/apps/server/src/config-schema.mjs',
    plugins: 'plugins/config-schema.mjs',
    'board-plugin': 'board-plugin/config-schema.mjs',
    'services-plugin': 'services-plugin/config-schema.mjs',
  }
  return join(ROOT, map[name] ?? '')
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/config/scan.mjs')
if (isMain) await main()
