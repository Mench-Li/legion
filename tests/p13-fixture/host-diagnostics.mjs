/**
 * host-diagnostics.mjs — 把「宿主未就绪 / 路由 404」翻译成**明确的插件导入失败**（P4-2，候选 #9）。
 *
 * 背景（REMAINING-TASKS #9）：`team-hub/lib` 缺失、插件入口写错、插件在导入期抛错，
 * 在客户端都表现为「60s 未就绪」或某条路由 404；真正的原因只出现在宿主子进程的 stderr 里，
 * 而那段输出要么被忽略、要么要人工翻。本模块把这段输出**解析成结构化结论**，
 * 并给出「哪个插件条目 / 哪个入口文件 / 原始错误 / 该怎么修」。
 *
 * 依据（真实 DSH 宿主 app-boot 的失败文本，`packages/boot/app-boot/src/index.ts`）：
 *   · 入口模块**无法解析**（import 失败）→ `${binName}: plugin(s) failed to load: <names>; Cordis startup
 *     failed because these plugin(s) could not be resolved (see the error(s) logged above)`（assertEntriesLoaded）
 *   · 条目**激活失败/未激活**（apply 抛错、或 inject 的服务没人提供）→
 *     `${binName}: N entries did not activate\n<name>: <stack>\n<name>: pending (waiting for services: a, b)`
 *   · 外层包装 → `${binName}: plugin tree failed to load: <detail>`（或树挂载前失败时的
 *     `host preparation failed`）；未处理拒绝 → `${binName}: fatal load failure: <stack>`
 *   · 最深层原因（如 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...'`）会附加在包装错误之后。
 *
 * 三个判据都**不猜**：名字来自日志原文，入口路径来自 profile 组合的行（YAML 真值），
 * 存在性来自文件系统。解析不到时如实说「未能识别」，并把日志尾部带上——不伪造结论。
 *
 * 本文件是纯函数模块（除 `preflightEntries` 只读文件系统），无宿主依赖，可单独单测。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** 组合行的 `name:` → 本地包目录（生产与 p13 fixture 用同一套映射）。 */
export const PACKAGE_DIRS = Object.freeze({
  '@dsh-external/dsh-team-hub': 'team-hub',
  '@dsh-external/dsh-scrum-board': 'board-plugin',
  '@dsh-external/dsh-scrum-worker': 'plugins',
})

/** 已知的「入口文件不存在」提示：这些包必须先用构建脚本产出 lib/（脚本的键即目录名）。 */
function buildHint(name) {
  const dir = PACKAGE_DIRS[name]
  return dir
    ? `入口产物缺失：先构建该插件包 —— $env:DSH_CHECKOUT=<dsh checkout>; node scripts/ci/build-external-package.mjs ${dir}`
    : '入口文件不存在：确认组合行里的 name 指向已构建的插件入口'
}

/** 从 package.json 里解析出入口文件（main / module / exports 的字符串形式）。 */
export function entryFromPackageJson(pkgJsonPath) {
  let pkg
  try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) } catch { return null }
  const tryExports = (v) => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') {
      for (const key of ['.', 'import', 'default', 'require']) {
        const found = tryExports(v[key])
        if (found) return found
      }
    }
    return null
  }
  return pkg.main || pkg.module || tryExports(pkg.exports) || null
}

/**
 * 把组合行（`{ id, name }`）解析成本地入口文件路径。
 * `packageDirs` 的值可以是相对 `repoRoot` 的目录（仓库内包），也可以是**绝对路径**
 * （fixture 的临时包目录，例如故意指向缺失 lib 的假包）。
 * 返回 `{ kind, dir|file, entry, exists }`；无法判断时 `kind:'unknown'`（**不当作问题**）。
 * @param {{ id?: string, name: string }} row
 * @param {{ repoRoot: string, packageDirs?: Record<string,string> }} opts
 */
export function resolveRowEntry(row, { repoRoot, packageDirs = PACKAGE_DIRS }) {
  const name = String(row?.name ?? '')
  if (name.startsWith('file://')) {
    let file
    try { file = resolve(new URL(name).pathname.replace(/^\/([A-Za-z]:)/, '$1')) } catch { return { kind: 'unknown', name } }
    return { kind: 'file', name, file, entry: file, exists: existsSync(file) }
  }
  const rel = packageDirs[name]
  if (!rel) return { kind: 'unknown', name }
  const dir = isAbsolute(rel) ? rel : join(repoRoot, rel)
  const pkgJson = join(dir, 'package.json')
  if (!existsSync(pkgJson)) return { kind: 'package', name, dir, entry: null, exists: false, reason: 'package.json 不存在' }
  const main = entryFromPackageJson(pkgJson)
  if (!main) return { kind: 'package', name, dir, entry: null, exists: false, reason: 'package.json 未声明 main/module/exports' }
  const entry = resolve(dir, main)
  return { kind: 'package', name, dir, entry, exists: existsSync(entry) }
}

/**
 * 从底层模块错误文本里抽出被解析失败的**路径**（`Cannot find (package|module) 'X'`）。
 * 真实宿主的入口解析失败常常只有这一行没有插件名 —— 路径是唯一能反查条目的线索。
 */
export function specifierFromError(line) {
  const m = /Cannot find (?:package|module)\s+'([^']+)'/.exec(String(line ?? ''))
  return m ? m[1] : null
}

/**
 * 把一条底层模块错误**归属到组合行**：按包名/入口路径/目录名匹配。
 * 这是「只有 Cannot find module，没有插件名」时唯一的反查手段（真实宿主即如此）。
 * @returns {{ id?: string, name: string } | null}
 */
export function attributeModuleError(line, rows, opts) {
  const text = String(line ?? '')
  const spec = specifierFromError(text)
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase()
  const haystack = norm(text)
  for (const row of rows ?? []) {
    const name = String(row.name ?? '')
    if (name.startsWith('file://')) {
      const r = resolveRowEntry(row, opts)
      if (r.entry && haystack.includes(norm(r.entry))) return row
      const base = basename(norm(r.entry ?? name))
      if (base && haystack.includes(base)) return row
      continue
    }
    if (haystack.includes(norm(name))) return row                 // 组合行名（含 @dsh-external 前缀）
    const short = name.replace(/^@[^/]+\//, '')                   // dsh-team-hub
    if (short && haystack.includes(norm(short))) return row
    const r = resolveRowEntry(row, opts)
    if (r.entry && haystack.includes(norm(r.entry))) return row
    if (spec && r.dir && haystack.includes(norm(r.dir))) return row
  }
  return null
}

/**
 * 预检：宿主启动**之前**就能发现「入口不存在」这类问题（CI 上 `team-hub/lib` 缺失正是这一类）。
 * @returns {{ checked: number, problems: Array<{kind:'missing_entry', plugin:string, entry:string|null, hint:string}> }}
 */
export function preflightEntries(rows, opts) {
  const problems = []
  let checked = 0
  for (const row of rows ?? []) {
    const r = resolveRowEntry(row, opts)
    if (r.kind === 'unknown') continue
    checked += 1
    if (!r.exists) {
      problems.push({
        kind: 'missing_entry',
        plugin: row.id ? `${row.id}（${row.name}）` : r.name,
        entry: r.entry,
        hint: buildHint(r.name) + (r.reason ? `（${r.reason}）` : ''),
      })
    }
  }
  return { checked, problems }
}

/**
 * 从宿主日志（stdout+stderr 合并）里解析加载期失败。
 * 全部为**字符串匹配**，不猜语义；匹配不到就是空数组。
 */
export function parseHostFailures(logText) {
  const text = String(logText ?? '')
  const out = {
    stage: null,
    loaderFailedNames: [],
    entryFailures: [],
    activation: [],
    pending: [],
    fatal: null,
    moduleErrors: [],
  }
  if (/plugin tree failed to load/.test(text)) out.stage = 'plugin tree failed to load'
  else if (/host preparation failed/.test(text)) out.stage = 'host preparation failed'

  // ⓪ **实测到的真实形状**（P4-2 用真实宿主复现两遍）：
  //   Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  //     failed to import loader entry <id> (<specifier>): <插件自己的错误>
  // 里层的 `failed to import|apply loader entry <id> (<specifier>): <msg>` 是**唯一**同时给出
  // 「组合行 id」与「specifier」的地方 —— 直接按 id 反查组合行，不用猜。
  // 注意：正则**不能**把行尾消息一起吃进模式，否则外层 include 的那次匹配会吞掉内层（实测踩过）。
  const entryRe = /failed to (import|apply) loader entry\s+(\S+?)(?:\s+\(([^)]*)\))?:/g
  for (const m of text.matchAll(entryRe)) {
    const [, action, id, specifier] = m
    if (id === 'include' || id === 'cordis:include') continue   // 树根包装层，不是用户条目
    const message = (text.slice(m.index + m[0].length).split('\n')[0] ?? '').trim()
    if (out.entryFailures.some((f) => f.id === id && f.message === message)) continue
    out.entryFailures.push({ action, id, specifier: specifier ?? null, message })
  }

  // ① 入口无法解析：`dsh: plugin(s) failed to load: a, b; ...`
  for (const m of text.matchAll(/plugin\(s\) failed to load:\s*([^\n;]+);/g)) {
    for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!out.loaderFailedNames.includes(n)) out.loaderFailedNames.push(n)
    }
  }

  // ② 激活失败/未激活：`dsh: N entries did not activate` 之后的逐条清单。
  // 每条形如 `<name>: <message>`，其后的**缩进行是栈/续行**，必须归到上一条（否则
  // `    at file:///…:7:9` 会被误当成一个新条目——这正是「诊断自己说谎」的典型）。
  const act = /(\d+)\s+(?:entry|entries)\s+did not activate\b[^\n]*\n([\s\S]*?)(?=\n[^\n]*(?:plugin tree failed to load|fatal load failure)|$)/.exec(text)
  if (act) {
    let current = null
    const commit = () => { if (current) out.activation.push(current) }
    for (const line of act[2].split('\n')) {
      if (line.trim() === '') continue
      if (/^\s/.test(line)) {           // 缩进 → 上一条的续行（栈）
        if (current) current.detail += '\n' + line.trim()
        continue
      }
      const pending = /^(.+?):\s*pending \(waiting for service(?:s)?:\s*([^)]*)\)\s*$/.exec(line)
      if (pending) {
        commit()
        out.pending.push({ name: pending[1].trim(), missing: pending[2].split(',').map((s) => s.trim()).filter(Boolean) })
        current = null
        continue
      }
      const failed = /^(\S[^:]*?):\s*(.+)$/.exec(line)
      commit()
      current = failed ? { name: failed[1].trim(), detail: failed[2].trim() } : null
    }
    commit()
  }

  // ③ 未处理拒绝（fail-loud）
  const fatal = /fatal load failure:\s*([\s\S]+?)(?:\n\S|$)/.exec(text)
  if (fatal) out.fatal = fatal[1].trim()

  // ④ 底层 Node 模块错误（最深层原因常常只有这一行）
  for (const m of text.matchAll(/(ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_INVALID_MODULE_SPECIFIER|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|Cannot find module|Cannot find package)[^\n]*/g)) {
    if (!out.moduleErrors.includes(m[0].trim())) out.moduleErrors.push(m[0].trim())
  }
  return out
}

/** 日志里出现的某个名字是否对应这一行（包名/文件 URL 的 basename 都算）。 */
function rowMentioned(row, name) {
  const n = String(name ?? '')
  if (n === '') return false
  if (n === row.name) return true
  if (n.includes(row.name) || row.name.includes(n)) return true
  if (basename(n.replace(/\\/g, '/')) === basename(String(row.name).replace(/\\/g, '/'))) return true
  return false
}

/**
 * 汇总诊断：预检问题 + 日志解析 → 有序的问题清单（每条含插件、入口、原始错误、处置建议）。
 * @param {{ logText?: string, rows?: Array<{id?:string,name:string}>, repoRoot?: string, exitCode?: number|null, timeoutMs?: number }} input
 */
export function diagnoseHostLogs({ logText = '', rows = [], repoRoot = process.cwd(), exitCode = null, timeoutMs = null } = {}) {
  const parsed = parseHostFailures(logText)
  const problems = []
  const add = (p) => { if (!problems.some((q) => q.kind === p.kind && q.plugin === p.plugin)) problems.push(p) }
  const mentionAll = (names) => (names && names.length > 0 ? names.join('、') : null)
  const label = (row) => (row?.id ? `${row.id}（${row.name}）` : String(row?.name ?? '未知条目'))

  // ⓪ 装载器直接点名：`failed to import|apply loader entry <id> (<specifier>)` → 按 id 精确反查组合行
  for (const f of parsed.entryFailures) {
    const row = rows.find((r) => r.id === f.id)
      ?? rows.find((r) => rowMentioned(r, f.specifier || f.id))
      ?? { id: f.id, name: f.specifier || f.id }
    const r = resolveRowEntry(row, { repoRoot })
    const moduleErr = f.message.includes('Cannot find ') ? (specifierFromError(f.message) ?? null) : null
    const entryMissing = !r.exists
    add({
      kind: entryMissing ? 'missing_entry' : (f.action === 'import' ? 'import_threw' : 'activation_failed'),
      plugin: label(row),
      entry: r.entry ?? null,
      detail: entryMissing
        ? `${f.message}（入口文件不存在：${r.entry ?? '未知路径'}）`
        : f.message,
      raw: f.message,
      hint: entryMissing
        ? buildHint(row.name)
        : (f.action === 'import'
          ? '模块在**导入期**就抛错（不是 apply 期）→ 上方原始错误即插件自己的错误；若是依赖缺失，按 specifier 补依赖或修入口'
          : '插件已在 apply/激活期抛错 → 上方原始错误即插件自己的错误（含栈）'),
      specifier: f.specifier ?? null,
      moduleError: moduleErr,
    })
  }

  // 入口缺失（日志里往往只有一句 Cannot find module，这条把「哪个插件、哪个文件」补上）
  for (const n of parsed.loaderFailedNames) {
    const row = rows.find((r) => rowMentioned(r, n)) ?? { name: n }
    const r = resolveRowEntry(row, { repoRoot })
    add({
      kind: 'missing_entry',
      plugin: label(row),
      entry: r.entry ?? null,
      detail: r.exists ? '入口文件存在，但 loader 仍报解析失败（见原始错误）' : '入口文件不存在',
      raw: mentionAll(parsed.moduleErrors),
      hint: r.exists ? '入口存在 → 看原始错误：可能是该模块 import 的内部依赖缺失，或导出不是合法插件' : buildHint(String(r.name ?? n)),
    })
  }

  for (const a of parsed.activation) {
    const row = rows.find((r) => rowMentioned(r, a.name)) ?? { name: a.name }
    const r = resolveRowEntry(row, { repoRoot })
    add({
      kind: 'activation_failed',
      plugin: label(row),
      entry: r.entry ?? null,
      detail: a.detail.split('\n')[0].slice(0, 400),
      raw: a.detail,
      hint: '插件已加载但在 apply/激活期抛错 → 上方 detail 即插件自己的错误（含栈）',
    })
  }

  for (const p of parsed.pending) {
    const row = rows.find((r) => rowMentioned(r, p.name)) ?? { name: p.name }
    add({
      kind: 'pending_services',
      plugin: label(row),
      entry: null,
      detail: `等待服务：${p.missing.join(', ') || '未知'}`,
      raw: null,
      hint: '该条目的 inject 服务没有任何插件提供 → 检查组合里是否漏挂提供者，或服务名/作用域是否写错',
    })
  }

  // 底层模块错误：真实宿主在**入口解析失败**时往往只打这一行（没有插件名、更没有
  // `plugin(s) failed to load:` 友好行），所以必须能反查到组合行——否则诊断只会说「未能定位」。
  for (const line of parsed.moduleErrors) {
    if (problems.some((q) => q.raw && q.raw.includes(line))) continue
    const row = attributeModuleError(line, rows, { repoRoot })
    if (row) {
      const r = resolveRowEntry(row, { repoRoot })
      add({
        kind: r.exists ? 'module_error' : 'missing_entry',
        plugin: row.id ? `${row.id}（${row.name}）` : row.name,
        entry: r.entry ?? null,
        detail: r.exists ? line : `${line}（入口文件不存在：${r.entry ?? '未知路径'}）`,
        raw: line,
        hint: r.exists
          ? '入口文件存在 → 该模块 import 的**内部依赖**缺失（看原始错误的 specifier），或导出不是合法 cordis 插件'
          : buildHint(row.name),
      })
      continue
    }
    add({
      kind: 'module_error',
      plugin: '（未能定位到具体插件条目）',
      entry: null,
      detail: line,
      raw: line,
      hint: '这是宿主日志里的底层模块错误；上面若有同名条目即为其原因，否则看下方日志尾部',
    })
  }

  if (parsed.fatal) {
    add({
      kind: 'unhandled_rejection',
      plugin: '（未处理拒绝，未定位到条目）',
      entry: null,
      detail: parsed.fatal.split('\n')[0].slice(0, 400),
      raw: parsed.fatal,
      hint: '宿主在启动后抛出未处理拒绝并退出（fail-loud）→ 首行即真正错误',
    })
  }

  return { parsed, problems, exitCode, timeoutMs, stage: parsed.stage }
}

/** 把诊断渲染成可直接放进断言消息的多行文本。 */
export function formatDiagnosis(diag, { logText = '', tailLines = 25 } = {}) {
  const { problems, parsed, exitCode, timeoutMs } = diag
  const head = []
  if (problems.length > 0) {
    head.push(`宿主插件加载失败（已定位 ${problems.length} 处）：`)
    problems.forEach((p, i) => {
      head.push(`  ${i + 1}. [${p.kind}] ${p.plugin}`)
      if (p.entry) head.push(`     入口：${p.entry}`)
      head.push(`     现象：${p.detail}`)
      if (p.raw && p.raw !== p.detail) head.push(`     原始错误：${String(p.raw).split('\n')[0].slice(0, 300)}`)
      head.push(`     处置：${p.hint}`)
    })
  } else {
    head.push('宿主未就绪，但**未能从宿主日志识别出插件加载错误**（不猜结论）：')
    if (exitCode !== null && exitCode !== undefined) head.push(`  宿主进程退出码：${exitCode}`)
    if (timeoutMs !== null && timeoutMs !== undefined) head.push(`  等待就绪上限：${timeoutMs}ms（超时）`)
    if (parsed.stage) head.push(`  app-boot 阶段标签：${parsed.stage}`)
  }
  const lines = String(logText ?? '').split('\n').filter((l) => l.trim() !== '')
  const tail = lines.slice(-tailLines)
  return [
    ...head,
    '  --- 宿主日志尾部（原始输出，未加工） ---',
    ...tail.map((l) => '  | ' + l.slice(0, 500)),
  ].join('\n')
}

/**
 * 命名空间归一的失败异常：`waitReady` 抛它，调用方按 `err.diagnosis` 取结构化结论。
 */
export class HostBootError extends Error {
  constructor(message, diagnosis) {
    super(message)
    this.name = 'HostBootError'
    this.diagnosis = diagnosis
  }
}

/** 便捷封装：给定日志与组合行，直接产出可读的启动失败错误。 */
export function hostBootError({ logText, rows, repoRoot, exitCode = null, timeoutMs = null, headline }) {
  const diag = diagnoseHostLogs({ logText, rows, repoRoot, exitCode, timeoutMs })
  const what = headline ?? (diag.problems.length > 0 ? '宿主插件加载失败' : '宿主未就绪')
  return new HostBootError(`${what}：${formatDiagnosis(diag, { logText })}`, diag)
}

/**
 * 把已排序的组合行文本解析成 `{id,name}` 列表（fixture 写的 YAML 即真值）。
 * 只认「行形如 `- id: X` 起的同一行」，其后的缩进行里**第一个**顶层 `name:` 才是该行的插件名：
 * 嵌套块（如 `config:` 里也有 `name: worker`）不得覆盖它——否则诊断会把配置里的字符串
 * 当成插件名，去查一个不存在的入口。
 */
export function parseCompositionRows(yamlText) {
  const rows = []
  let current = null
  for (const line of String(yamlText ?? '').split('\n')) {
    // `- id: X` → 该 map 的**键缩进**是 `- ` 之后的位置（键与键同级，不随 `- ` 的缩进）
    const idMatch = /^(\s*)-\s*id:\s*'?([^'\n]+?)'?\s*$/.exec(line)
    if (idMatch) {
      if (current) rows.push(current)
      current = { id: idMatch[2], name: null, keyIndent: idMatch[1].length + 2 }
      continue
    }
    if (current && current.name === null) {
      const nameMatch = /^(\s*)name:\s*'?([^'\n]+?)'?\s*$/.exec(line)
      if (nameMatch) {
        if (nameMatch[1].length > current.keyIndent) continue   // 缩进更深 → 属于嵌套块（如 config.name）
        current.name = nameMatch[2]
        continue
      }
      const bareDash = /^(\s*)-\s*\S/.exec(line)
      if (bareDash) current.keyIndent = bareDash[1].length + 2   // 由 `- name:` 起的行
    }
  }
  if (current) rows.push(current)
  // 没有插件名的行不是有效插件行 → 不返回（诊断不猜）
  return rows.filter((r) => r.name !== null).map((r) => ({ id: r.id, name: r.name }))
}
