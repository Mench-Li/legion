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

import { SCHEMA_FILES } from './check.mjs'

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
  // PRT-251 起纳入产品层：Launcher 是**唯一**决定「子进程拿到什么环境」的地方，
  // 因此它的读取点必须与其余进程一样可扫描。注意它的注入面是白名单（见 product/launcher/env.mjs），
  // 与 services-plugin 的「整份 env 打底 + 覆盖」相反。
  product: { label: '产品层（Legion Launcher：进程清单 / 白名单注入 / 就绪判据 / 监督退避）', dirs: ['product'] },
  // PRT-301 起：Orchestrator worker 是独立常驻进程（清单里 `dependsOn: [team-hub, runtime]`），
  // 它有自己的读取面（TEAM_HUB_URL / TEAM_HUB_TOKEN / LEGION_*），因此单独登记。
  // 入口在 `product/orchestrator/worker.mjs`（清单冻结的路径），实现住在这里——
  // 两侧都会读 env，因此**两边都必须被扫描到**，否则「入口读了什么」会漏登记。
  orchestrator: { label: 'Legion Orchestrator worker（扫单 / 认领 / 派工；PRT-301 起）', dirs: ['orchestrator'] },
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

/**
 * 去掉注释，保留字符串与换行结构 —— 只用于「找读取点」，不改动原始文本。
 *
 * 为什么必须做：散文注释里写 `process.env.X`（举例/说明历史写法）会被下面的正则当成真实读取点，
 * 于是 `scan --check` 报出一个根本不存在的 env 键（P3-4 实测：`plugins/src/config.ts` 的注释里
 * 那句 `Number(process.env.X || 默认值)` 让主检出多出未声明键 `X`）。
 *
 * 为什么必须按字符状态机而不是 `text.replace(/\/\/.*$/gm,'')`：仓库里到处是 `'http://127.0.0.1:8787'`
 * 这类字符串字面量，粗暴替换会把**同一行后面的真实读取一起吃掉**（假阴性比假阳性更危险）。
 * 字符串内的转义与模板字面量也一并按状态处理。
 */
export function stripComments(text) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const n = text[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 1; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 1; continue }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 1; continue }
      if (c === '\n') out += c
      continue
    }
    // 字符串字面量内部：原样保留（含 `//`），转义字符不参与收尾判断
    if (c === '\\') { out += c + (n ?? ''); i += 1; continue }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code'
    out += c
  }
  return out
}

/** 从源码文本里抽出 env 键读取点；动态访问（process.env[expr]）单列，必须显式登记。 */
export function extractEnvReads(source) {
  const text = stripComments(source)
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

/** 取「已写好但尚未纳入版本控制、且**不被 .gitignore 忽略**」的文件集合。
 *
 *  这是 `git add -A` 会带走的那一批，因此也就是「这次提交的配置面」。
 *
 *  与 `trackedFiles` 的差别很重要：`trackedFiles` 只知道「在不在索引里」，
 *  因此 `team-hub/lib/index.js` 这类**被忽略的构建产物**也算「未跟踪」；
 *  而真正危险的是「新建的源文件还没 git add」——它在索引外、也不被忽略。
 *  `--others --exclude-standard` 恰好就给出这一批。 */
export function pendingFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
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
  const pendingSet = onlyTracked ? pendingFiles(ROOT) : null
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
  // 未跟踪的代码文件**不纳入配置面**（理由见 trackedFiles 的说明），但这会带来一个陷阱：
  // 在「文件已写好、尚未 git add」的工作树上，`scan --check` 会因为压根没扫到这些文件而**假绿**。
  // 实测：P3-4 的 plugins/src/config.ts 在提交前未被扫描，提交后同一份代码立刻多出一个未声明键。
  // 这里把「有几个文件没被扫」如实报出来，让日志读者看得见这个盲区（不判失败：未跟踪文件本就不算配置面）。
  const untracked = useGit
    ? files.map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !tracked.has(rel) && (includeTests || !/\.test\.|\.spec\.|smoke/.test(rel)))
    : []

  // ── 「假绿」的真正修法：把**将要被提交**的那批文件单独拎出来 ──
  //
  // 上面那条注释把陷阱说清楚了，却选择「只警告、不判失败」。这个选择本身
  // 就是漏洞：`scan --check` 报 PASS 的含义是「配置面没问题」，
  // 而它实际的含义只是「**已经提交的那部分**没问题」。
  //
  // 实测后果（PRT-502）：`orchestrator/model-binding/index.mjs` 提交前未跟踪，
  // 门禁报 PASS（285 字面量）；提交后同一份文件立刻冒出 12 个未处理字面量。
  // 也就是说这条门禁在**最需要它的时刻**（提交前）覆盖不到**它该管的对象**。
  //
  // 因此：`pending`（untracked 且未被 .gitignore 忽略）= `git add -A` 会带走的
  // 那批文件。非空时 `--check` **判失败**，因为此时任何 PASS 都是对
  // "将要提交的东西"的谎报。
  const pending = useGit
    ? files.map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !tracked.has(rel) && pendingSet !== null && pendingSet.has(rel) &&
        (includeTests || !/\.test\.|\.spec\.|smoke/.test(rel)))
    : []
  return { name, label: spec.label, filesScanned: scanned, untracked, pending, reads, dynamic, suspicious, mode: useGit ? 'git-tracked' : 'walk（git 不可用：结果已包含未跟踪文件，仅作调试参考）' }
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
      if (r.untracked?.length) {
        console.log(`    ⚠ 另有 ${r.untracked.length} 个未跟踪文件未纳入扫描（本地状态，提交后即纳入）：${r.untracked.slice(0, 3).join(', ')}${r.untracked.length > 3 ? ' …' : ''}`)
      }
      if (r.pending?.length) {
        console.log(`  ✖ 有 ${r.pending.length} 个文件**已写好但尚未纳入版本控制**，因此本次扫描没有覆盖它们：${r.pending.join(', ')}`)
        console.log('     这条门禁的模式是 git-tracked。在它们被 git add 之前，任何 PASS 都只是「已提交的那部分没问题」，而不是「你要提交的东西没问题」')
      }
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
  // 假绿治理：有"将要提交但没被扫到"的文件时，PASS 是对提交内容的谎报。
  const pendingAll = results.flatMap((r) => (r.pending ?? []).map((f) => `${r.name}:${f}`))
  if (check && pendingAll.length > 0) {
    console.error(`\nscan: FAIL —— ${pendingAll.length} 个文件已写好但未被扫描（未纳入版本控制且未被 .gitignore 忽略）：`)
    for (const p of pendingAll) console.error(`  - ${p}`)
    console.error('  git-tracked 模式下这些文件不在配置面里。请 `git add` 后重跑，')
    console.error('  否则这条门禁报的是「已提交的部分没问题」，而不是「你要提交的东西没问题」。')
    process.exitCode = 1
  }
  if (check && violations > 0) {
    console.error(`\nscan: FAIL —— ${violations} 项未在 schema 中处理（补进对应进程的 config-schema，或列入 nonEnvLiterals 并写明理由）`)
    process.exit(1)
  }
  if (check && pendingAll.length === 0) {
    console.log(`\nscan: PASS（全部 env 读取点与疑似字面量均已处理；共 ${suspiciousCount} 个疑似字面量）`)
  }
}

/** 进程 → schema 模块路径（相对 ROOT），供 --check 对照使用。
 *
 *  **委托给 `check.mjs` 的 `SCHEMA_FILES`**，不再自己维护第二份映射：
 *  这两份曾经各自手写，PRT-251 新增 `product` 进程时只更新了其中一份，
 *  结果是 `scan --check` 说「全部已处理」而 `topology-inventory --diff` 说
 *  「product 的 8 个键未声明」。两份映射必然漂移，因此只留一份。 */
export function schemaModuleFor(name) {
  const file = SCHEMA_FILES[name]
  return file === undefined ? join(ROOT, '') : join(ROOT, file)
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/config/scan.mjs')
if (isMain) await main()
