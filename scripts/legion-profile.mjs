#!/usr/bin/env node
/**
 * legion-profile.mjs —— 把 Legion 插件族**接进任意一个 DSH 档案**（幂等、可验证、可回滚）。
 *
 * ## 这个脚本补的是哪一截
 *
 * 「Legion 会随宿主自动起」这句话，实际依赖**两份档案侧的事实**同时成立：
 *
 *   ① 四个 `@dsh-external/dsh-*` 包在该档案的 `node_modules` 里可解析
 *      （pnpm `file:` 依赖 + hoisted linker 会落成 junction）；
 *   ② 该档案的 `cordis.patch.yml` 里有那几行 `insert`（服务托管 / 士兵守护）。
 *
 * `profiles/web` 两份都有（手工做的），`profiles/desktop` 两份都没有 ——
 * 于是"同一个 Legion、同一个仓库、同一台机器"，换个宿主启动就什么都不会发生。
 * 这件事以前靠人手改 YAML + 手动 `pnpm install`，没有实现、也没有判据。
 *
 *   > 一个"配置写在文档里、依赖靠人手建"的自动启动，
 *   > 与一个"根本没有接线"的自动启动，在换一台机器的第一天是同一个东西——
 *   > 只不过前者的 README 里写着它应该会自己起来。
 *
 * ## 三种动作，严格分开
 *
 *   · `--verify`  **只读**：报告每个档案当前缺什么（依赖 / junction / 补丁行），退出码非 0 表示有缺口。
 *   · `--wire`    干活：补 `package.json` 依赖、建 junction、追加缺失的补丁行。**幂等**，改前留 `.bak-<时间戳>`。
 *   · 不带参数    = `--verify`（默认只读：一个默认就写用户档案的工具有一天会在错误的档案上执行）。
 *
 * ## 为什么是 junction 而不是重新 `pnpm install`
 *
 * DSH 的档案用 `nodeLinker: hoisted`，`file:` 依赖落点就是
 * `node_modules/@dsh-external/<pkg>` 这一个目录。而 `plugins/`、`services-plugin/` 这类
 * 包**没有运行时依赖**（`services-plugin` 零依赖；`scrum-worker` 只有 peerDependencies，
 * 由宿主自己提供）。所以"可解析"这一件事等价于"那个目录在"。
 *
 * 仍然把 `file:` 依赖写进 `package.json`：它是**下一次 `pnpm install` 的依据**——
 * 一条只存在于 `node_modules` 里的接线，会在任何一次 reinstall 之后静默消失。
 *
 * ## 为什么手写 YAML 文本而不是"读-改-写"
 *
 * 仓库里没有 YAML 解析器（`js-yaml` 不在任何 `node_modules` 里），而档案文件**属于用户**、
 * 里面是他自己的行与注释。所以本脚本只做**追加**：把一段新生成的、形状受检的
 * `- insert:` 块 append 到文件末尾，从不重写已有内容。
 * 追加的形状由 `yamlInsertBlock()` 生成，并逐行自检（缩进必须成对、每个 entry 必须有 name）。
 * 形状判据与 `runtime/dsh-composition/patch-format.mjs` 一致（顶层数组 / insert 是数组 /
 * 每项有 name / 不带 id）。
 *
 * ## 为什么要写进 `package.json` 的 `dsh.profile.bundles`
 *
 * `profiles/desktop` 的 bundles 是 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，
 * 与 web 档案相同 —— 所以 `dsh-host-webserver`（`team-hub` / `scrum-board` 两个插件的
 * peer）在 desktop 档案下也在。这一条是**读出来的**，不是猜的（见 README/证据）。
 *
 * 用法：
 *   node scripts/legion-profile.mjs --verify --profile web
 *   node scripts/legion-profile.mjs --wire   --profile desktop
 *   node scripts/legion-profile.mjs --wire   --profile web,desktop
 *   node scripts/legion-profile.mjs --wire   --profile desktop --dry-run
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// ── 常量：Legion 侧的四个包（name → 仓库内相对目录）──────────────────────────
export const LEGION_PACKAGES = Object.freeze([
  { name: '@dsh-external/dsh-legion-services', dir: 'services-plugin', why: '托管三件套（team-hub :8787 + 指挥台 :5173），随宿主启停、退出自愈' },
  { name: '@dsh-external/dsh-scrum-worker', dir: 'plugins', why: '士兵守护：扫单、认领、派工、退回纠错、blocked 解阻' },
  { name: '@dsh-external/dsh-team-hub', dir: 'team-hub', why: '中枢路由 + SSE（挂宿主 webserver，routePrefix=/team-hub）' },
  { name: '@dsh-external/dsh-scrum-board', dir: 'board-plugin', why: '看板 UI + 写接口（挂宿主 webserver，routePrefix=/scrum-board）' },
])

/** 仓库根：本文件在 <root>/scripts/ 下。 */
export function repoRootOf(here = import.meta.url) {
  return resolve(dirname(fileURLToPath(here)), '..')
}

export function defaultDshHome(env = process.env) {
  const v = env.DSH_HOME
  if (typeof v === 'string' && v.trim()) return resolve(v.trim())
  return join(homedir(), '.dsh')
}

/** 读一个档案的 package.json；不存在返回 null（调用方决定这是不是错误）。 */
export function readProfilePackage(profileDir) {
  const p = join(profileDir, 'package.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) {
    const err = new Error(`档案 package.json 不是合法 JSON：${p}（${e.message}）`)
    err.code = 'PROFILE_PACKAGE_MALFORMED'
    throw err
  }
}

/**
 * 该档案**该有**哪些 `file:` 依赖。
 * 依赖值用 `file:<仓库内相对目录>`（正斜杠）——与 web 档案里现存的写法一致。
 */
export function expectedDependencies(root) {
  const out = {}
  for (const p of LEGION_PACKAGES) out[p.name] = `file:${join(root, p.dir).replace(/\\/g, '/')}`
  return Object.freeze(out)
}

/** 依赖声明里缺了哪些包（只读）。 */
export function missingDependencies(pkg, root) {
  const want = expectedDependencies(root)
  const have = pkg && typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? pkg.dependencies : {}
  return LEGION_PACKAGES.filter((p) => typeof have[p.name] !== 'string' || !have[p.name].trim())
}

/** junction 落点：node_modules/@dsh-external/<pkg> */
export function junctionPathOf(profileDir, pkgName) {
  return join(profileDir, 'node_modules', ...pkgName.split('/'))
}

/**
 * 一个 junction 指向哪里：返回真实路径，或 `null`（不存在 / 不是链接 / 链接坏了）。
 * 不用 `existsSync` 单独判，因为**一个断掉的 junction 在 existsSync 上就是 false**，
 * 与"从来没建过"长得一模一样 —— 这里要把两者分开。
 */
export function junctionTargetOf(profileDir, pkgName) {
  const p = junctionPathOf(profileDir, pkgName)
  let st
  try { st = lstatSync(p) } catch { return { state: 'absent', path: p, target: null } }
  if (!st.isSymbolicLink()) return { state: 'not-a-link', path: p, target: null }
  let raw = null
  try { raw = readlinkSync(p) } catch { /* 读不到链接内容 */ }
  try {
    const real = realpathSync(p)
    return { state: 'link', path: p, target: real, raw }
  } catch {
    return { state: 'dangling', path: p, target: null, raw }
  }
}

/** 每个包在档案里的解析状态（在 Windows 上用 realpath 比较，避免盘符大小写/短名干扰）。 */
export function junctionReport(profileDir, root) {
  return LEGION_PACKAGES.map((p) => {
    const expected = resolve(join(root, p.dir))
    const got = junctionTargetOf(profileDir, p.name)
    let ok = false
    if (got.state === 'link' && got.target) {
      const real = safeReal(expected)
      ok = samePath(got.target, real)
    }
    return Object.freeze({ name: p.name, dir: p.dir, expected, state: got.state, target: got.target, ok })
  })
}

function safeReal(p) { try { return realpathSync(p) } catch { return resolve(p) } }
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

// ── 补丁层：只追加、形状受检 ─────────────────────────────────────────────────

/** 单个标量 → YAML 单引号标量（内部单引号翻倍）。单引号里没有转义序列，因此路径原样可读。 */
export function yamlScalar(v) {
  const s = String(v)
  return `'${s.replace(/'/g, "''")}'`
}

function indent(text, pad) {
  return text.split('\n').map((l) => (l.length ? pad + l : l)).join('\n')
}

/**
 * 由"要接的行"生成一段顶层 `- insert:` 文本（不含文件头）。
 *
 * 形状与 DSH 自己的 `packages/bundle/base/cordis.patch.yml` 相同：一个顶层项、
 * 一个 `insert` 数组装下全部行。**绝不带 id**（带 id 会被读成"插进某个已存在的 group"，
 * 实测 warn-and-skip）。
 */
export function yamlInsertBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('yamlInsertBlock：entries 必须是非空数组')
  }
  // 语境（`- insert:` 之后的根级数组项）要求：第 0 项以 `  - ` 开头，其余项与它对齐；
  // 每一项内部的键再缩进 2 空格。**绝不带 id** —— 带 id 会被 DSH 读成"插进某个已存在的 group"。
  // 每一项渲染成**带缩进的完整行**：`- name:` 之后的行属于同一映射，键层级 = 列表项缩进 + 2。
  // 这里把"行"与"缩进"一次性定下来，避免后面再对整段施加统一前缀（那会把 config 的子键
  // 多推一层 —— 本函数前两版各自踩过一边）。
  const body = entries.map((e) => {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) {
      throw new Error(`yamlInsertBlock：每一项必须有 name（收到 ${JSON.stringify(e?.name ?? null)}）`)
    }
    if ('id' in e && e.id) throw new Error(`yamlInsertBlock：新增根级行不要带 id（${e.id}）`)
    const out = [`  - name: ${yamlScalar(e.name)}`]
    if (e.disabled === true) out.push('    disabled: true')
    if (e.config && Object.keys(e.config).length > 0) {
      out.push('    config:')
      // depth 1 = 相对缩进 2，再补 4 → config 的子键落在 6（= `config:` 的 4 + 2）。
      for (const l of renderYamlValue(e.config, 1).split('\n')) out.push(`    ${l}`)
    }
    return out.join('\n')
  })
  return `- insert:\n${body.join('\n')}\n`
}

/** 递归渲染普通对象/数组/标量为块状 YAML（本脚本只用到 map + scalar + 短数组）。 */
export function renderYamlValue(v, depth = 0) {
  const pad = '  '.repeat(depth)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return v.map((x) => {
      if (x !== null && typeof x === 'object') {
        const inner = renderYamlValue(x, depth + 1)
        return `${pad}-\n${inner}`
      }
      return `${pad}- ${scalarText(x)}`
    }).join('\n')
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    return keys.map((k) => {
      const val = v[k]
      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${k}: []`
        const arr = val.map((x) => {
          if (x !== null && typeof x === 'object') return `${pad}  -\n${renderYamlValue(x, depth + 2)}`
          return `${pad}  - ${scalarText(x)}`
        }).join('\n')
        return `${pad}${k}:\n${arr}`
      }
      if (val !== null && typeof val === 'object') return `${pad}${k}:\n${renderYamlValue(val, depth + 1)}`
      return `${pad}${k}: ${scalarText(val)}`
    }).join('\n')
  }
  return `${pad}${scalarText(v)}`
}

function scalarText(v) {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return yamlScalar(v)
}

/**
 * 文本级自检。**判据是 YAML 的块映射嵌套规则**，不是"缩进好看"：
 *
 * 一个列表项 `- key: v` 之后的**后续键必须与 `key` 对齐**（`keyIndent = itemIndent + 2`）。
 * 少写一层（把 config 的键渲染到与 `- name:` 同级）产生的文本**缩进全是偶数、
 * 每项也都有 name** —— 第一版检查器正是因此把一份非法 YAML 判成了通过。
 *
 *   > 一个只检查"缩进是不是偶数、有没有 name"的形状检查器，
 *   > 与一个从不检查形状的检查器，在它放行的那一份文件上是同一个东西。
 *
 * 这里用的是**栈式**检查：每进入一个值块压一帧，缩进回到上一帧的键层级就是退出该帧。
 */
export function checkInsertBlockText(text) {
  const problems = []
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines[0] !== '- insert:') problems.push(`首行必须是顶层 '- insert:'（实际 ${JSON.stringify(lines[0])}）`)
  /** 栈：{ itemIndent | null(顶层映射), keyIndent } */
  const stack = [{ itemIndent: null, keyIndent: 0 }]
  let names = 0
  let inListValue = false
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (/\t/.test(raw)) problems.push(`第 ${i + 1} 行含制表符（YAML 不允许）：${raw}`)
    const indent = /^( *)/.exec(raw)[1].length
    if (indent % 2 !== 0) problems.push(`第 ${i + 1} 行缩进 ${indent} 不是偶数：${raw}`)
    if (/^- insert:/.test(raw)) problems.push(`第 ${i + 1} 行又出现顶层 - insert:`)

    // 出栈：缩进回到某一帧的键层级（或更浅），说明那一帧的值块结束了
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      const itemLevel = top.itemIndent
      if (itemLevel !== null && indent <= itemLevel) { stack.pop(); continue }
      if (itemLevel === null && indent < top.keyIndent) { stack.pop(); continue }
      break
    }
    const frame = stack[stack.length - 1]

    const itemMatch = /^(\s*)-\s+(.*)$/.exec(raw)
    if (itemMatch) {
      const itemIndent = itemMatch[1].length
      const content = itemMatch[2]
      const km = /^([^\s:][^:]*):(\s|$)/.exec(content)
      if (km) {
        // 列表项内联第一个键：该帧的键层级 = itemIndent + 2
        stack.push({ itemIndent, keyIndent: itemIndent + 2 })
      } else {
        // `-` 单独一行，值是块：键层级 = itemIndent + 2
        stack.push({ itemIndent, keyIndent: itemIndent + 2 })
      }
      inListValue = true
      if (/^name:\s/.test(content)) names++
      continue
    }

    const keyMatch = /^(\s*)([^\s:][^:]*):(\s|$)/.exec(raw)
    if (!keyMatch) { problems.push(`第 ${i + 1} 行既不是键也不是列表项：${raw}`); continue }
    if (indent !== frame.keyIndent) {
      problems.push(
        `第 ${i + 1} 行缩进 ${indent} 与当前键层级 ${frame.keyIndent} 不一致（键 ${JSON.stringify(keyMatch[2])}）：${raw}`,
      )
    }
    if (/^name:\s/.test(raw.trim())) names++
    // 值块（`key:` 后面什么都没有）→ 下一层的键比当前多 2
    const rest = raw.slice(keyMatch[0].length - (keyMatch[3] ? keyMatch[3].length : 0))
    if (/:\s*$/.test(raw)) stack.push({ itemIndent: null, keyIndent: indent + 2 })
    else void rest
  }
  if (names === 0) problems.push('整块里没有任何 name —— 会被 DSH warn-and-skip')
  void inListValue
  return problems
}

// ── 接线动作 ─────────────────────────────────────────────────────────────────

/** 建/修 junction。已指向正确目标 → no-op（幂等）。 */
export function ensureJunction(profileDir, root, pkg, { dryRun = false, log = () => {} } = {}) {
  const linkPath = junctionPathOf(profileDir, pkg.name)
  const target = resolve(join(root, pkg.dir))
  const got = junctionTargetOf(profileDir, pkg.name)
  if (got.state === 'link' && got.target && samePath(got.target, safeReal(target))) {
    return { name: pkg.name, action: 'unchanged', linkPath, target }
  }
  if (got.state === 'not-a-link') {
    return { name: pkg.name, action: 'refused-not-a-link', linkPath, target, detail: '同名实体已存在且不是链接，不覆盖（先人工处理）' }
  }
  if (dryRun) return { name: pkg.name, action: 'would-link', linkPath, target }
  mkdirSync(dirname(linkPath), { recursive: true })
  if (got.state === 'dangling') {
    // 断链：Windows 上要先把链接本身删掉才能重建（用 rename 挪走，避免误删真实目录）
    renameSync(linkPath, `${linkPath}.dangling-${Date.now()}`)
    log(`  · ${pkg.name}：把断链挪到 ${linkPath}.dangling-* 后重建`)
  }
  symlinkSync(target, linkPath, 'junction')
  return { name: pkg.name, action: got.state === 'absent' ? 'linked' : 'relinked', linkPath, target }
}

export function planProfile({ root, profileDir, patchEntries }) {
  const pkg = readProfilePackage(profileDir)
  const missingDeps = pkg ? missingDependencies(pkg, root) : LEGION_PACKAGES
  const junctions = junctionReport(profileDir, root)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  // "这一行在不在" 的判据要能吃下**两种合法写法**：`- name: X`（列表项内联）与
  // 单独一行的 `name: X`（列表项换行后）。第一版只认前者且把缩进写死成 6 空格，
  // 于是把自己刚写进去的行读成"缺失"——一个只认自己那一种排版的存在性判据，
  // 与一个从不检查的判据，在它误报的那一次是同一个东西。
  const rowRe = (name) => new RegExp(`^[ \\t]*(?:-[ \\t]*)?name:[ \\t]*'?${escapeRe(name)}'?[ \\t]*$`, 'm')
  const missingRows = patchEntries.filter((e) => !rowRe(e.name).test(patchText))

  // ★ 「行在」不等于「行是对的」。一个 `- name:` 在、而 `maxWorkers: 2` 的旧块，
  //   与一个块都还没有，在宿主行为上不是同一件事，但在"名字在不在"这个判据下是同一件事。
  //   所以这里进一步把那一行**自己那块**切出来，逐条比对声明必须出现的配置值。
  const staleRows = patchEntries
    .map((e) => ({ entry: e, block: rowBlockOf(patchText, e.name), checks: e.ensure ?? [] }))
    .filter((r) => r.block !== null && r.checks.length > 0)
    .filter((r) => r.checks.some((c) => !new RegExp(c).test(r.block)))
    .map((r) => ({ id: r.entry.id, name: r.entry.name, missing: r.checks.filter((c) => !new RegExp(c).test(r.block)), block: r.block }))

  return Object.freeze({
    profileDir,
    exists: existsSync(join(profileDir, 'package.json')),
    missingDeps: Object.freeze(missingDeps),
    junctions: Object.freeze(junctions),
    brokenJunctions: Object.freeze(junctions.filter((j) => !j.ok)),
    patchFile,
    patchMissingRows: Object.freeze(missingRows),
    patchStaleRows: Object.freeze(staleRows),
  })
}

/**
 * 切出 `name: <name>` 那一行所属的**补丁块**（从该行到下一个同级/更浅的列表项为止）。
 * 找不到返回 null。用于"这一行里的配置值是不是我们声明的那一套"。
 */
export function rowBlockOf(patchText, name) {
  const lines = patchText.split('\n')
  const re = new RegExp(`^([ \\t]*)(?:-[ \\t]*)?name:[ \\t]*'?${escapeRe(name)}'?[ \\t]*$`)
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return null
  const baseIndent = re.exec(lines[start])[1].length
  const out = []
  for (let i = start; i < lines.length; i++) {
    if (i > start) {
      const m = /^([ \t]*)-[ \t]+\S/.exec(lines[i])
      if (m && m[1].length <= baseIndent) break
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 把缺失的补丁行**追加**进档案的 cordis.patch.yml（改前留备份）。 */
export function appendPatchRows({ patchFile, entries, dryRun = false, log = () => {}, blocksOut = null }) {
  if (entries.length === 0) return { action: 'unchanged', appended: 0 }
  const block = yamlInsertBlock(entries)
  const problems = checkInsertBlockText(block)
  if (problems.length > 0) {
    const err = new Error(`生成的补丁块形状不合法，拒绝写入：\n${problems.map((p) => `  · ${p}`).join('\n')}`)
    err.code = 'PATCH_BLOCK_MALFORMED'
    throw err
  }
  if (dryRun) { log(`  · [dry-run] 会追加 ${entries.length} 行到 ${patchFile}`); return { action: 'would-append', appended: entries.length, block } }
  if (blocksOut) blocksOut.push(block)
  const before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const bak = `${patchFile}.bak-${stamp()}`
  writeFileSync(bak, before)
  const header = '\n# ── Legion 插件族（由 scripts/legion-profile.mjs --wire 追加；原文件已备份到同目录 .bak-*）──\n'
  const next = (before.endsWith('\n') || before === '' ? before : before + '\n') + header + block
  writeFileSync(patchFile, next)
  log(`  · 追加 ${entries.length} 行到 ${patchFile}（备份 ${bak}）`)
  return { action: 'appended', appended: entries.length, backup: bak }
}

/**
 * 把缺失的 `file:` 依赖写进档案的 `package.json`（改前留备份）。
 *
 * ★ 参数名刻意**不叫** `profileDir`：本函数里 `profileDir` 用错了地方一次就会写成
 *   `<profile>/package.json/node_modules/...`——而那正是本文件第一版的实际行为
 *   （wire 报告 2 处残留缺口，而磁盘上明明都好了）。参数名与"它是什么"必须一致。
 */
export function writeProfileDependencies({ dir, pkg, root, missing, dryRun = false, log = () => {} }) {
  if (missing.length === 0) return { action: 'unchanged' }
  const file = join(dir, 'package.json')
  const want = expectedDependencies(root)
  const next = { ...pkg, dependencies: { ...(pkg.dependencies ?? {}), ...Object.fromEntries(missing.map((m) => [m.name, want[m.name]])) } }
  if (dryRun) { log(`  · [dry-run] 会补 ${missing.length} 条 file: 依赖到 ${file}`); return { action: 'would-write', added: missing.map((m) => m.name) } }
  const before = readFileSync(file, 'utf8')
  const bak = `${file}.bak-${stamp()}`
  writeFileSync(bak, before)
  // 保持 JSON 可读：dependencies 排在最前，其余键按原顺序。
  const ordered = {}
  if (next.dependencies) ordered.dependencies = next.dependencies
  for (const k of Object.keys(next)) if (k !== 'dependencies') ordered[k] = next[k]
  writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`)
  log(`  · 补 ${missing.length} 条 file: 依赖到 ${file}（备份 ${bak}）`)
  return { action: 'written', added: missing.map((m) => m.name), backup: bak }
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ── 该写进各档案的行（服务托管 + 士兵守护）──────────────────────────────────
//
// `legion-services` 零依赖：它在任何宿主里都能起，且端口已监听时跳过（多宿主并存不会抢端口）。
// `scrum-worker` 的 peer 由宿主提供；两个宿主同时挂载时，**认领互斥由 team-hub 的乐观锁仲裁**
// （谁先 claim 谁干），所以"两个档案都开"不会变成"两个守护抢同一条任务"。

export const PATCH_ENTRIES = Object.freeze([
  Object.freeze({
    id: 'legion-services',
    name: '@dsh-external/dsh-legion-services',
    why: '托管 team-hub :8787 + 指挥台 :5173（端口已监听则跳过，宿主退出统一回收）',
    ensure: [],
    config: (root) => ({ legionDir: root.replace(/\\/g, '/') }),
  }),
  Object.freeze({
    id: 'legion-scrum-worker',
    name: '@dsh-external/dsh-scrum-worker',
    why: '士兵守护（software 空间）：扫单 → 认领 → 派工 → in_review',
    // 声明"这一行必须在场的那几个值"。**刻意不钉 maxWorkers 的具体数字**：
    // web 档案里用户手写的是 2、本脚本给新档案默认 1，两者都是合法意图
    // ——一个把用户既有意图判成"过时"的判据，比没有判据更坏（它会教人忽略这行输出）。
    ensure: ['maxWorkers: [0-9]+', "scope: 'software'", "hubUrl: 'http://127.0.0.1:8787'"],
    config: (root, { maxWorkers = 1 } = {}) => ({
      role: 'soldier-auto',
      intervalMs: 30000,
      // ★ 默认 1，不是 web 档案里那份 2：**两个宿主会同时活着**（用户明确要求 web 与
      //   desktop 都支持），而两个守护各自 maxWorkers=2 意味着同一个 spaces 仓库上
      //   可能同时有 4 个 worker 在写不同文件。认领互斥只保证"同一条任务不被双派"，
      //   不保证"并发度不翻倍"——后者要靠这里。
      maxWorkers,
      workerTimeoutMs: 1500000,
      staleMinutes: 40,
      provider: 'spawn',
      agentPreset: 'ptc',
      scrumDir: `${root.replace(/\\/g, '/')}/scrum`,
      workspace: dirname(root).replace(/\\/g, '/'),
      isolate: true,
      repoRoot: root.replace(/\\/g, '/'),
      worktreeRoot: '',
      denyTools: [],
      rolesFile: `${root.replace(/\\/g, '/')}/roles.json`,
      logFile: `${defaultDshHome().replace(/\\/g, '/')}/super-injector/dsh-scrum-worker.log`,
      hubUrl: 'http://127.0.0.1:8787',
      hubToken: '',
      scope: 'software',
      primaryScope: 'software',
      mediateMergeFails: false,
    }),
  }),
])

export function entryObjectsFor(root, { maxWorkers = 1 } = {}) {
  return PATCH_ENTRIES.map((e) => ({ id: e.id, name: e.name, ensure: e.ensure ?? [], config: e.config(root, { maxWorkers }) }))
}

// ── 接线（可复用实现，CLI 只是它的一层壳）────────────────────────────────────

/**
 * 把一个档案接好：补依赖 → 建 junction → 追加补丁行 → 复查。
 * **幂等**：已经对的部分原样不动（不重写、不重复追加）。
 */
export function wireProfile({ root, profileDir, patchEntries, dryRun = false, log = () => {} }) {
  const before = planProfile({ root, profileDir, patchEntries })
  const result = { profileDir, exists: before.exists, dryRun, steps: {} }
  if (!before.exists) return Object.freeze({ ...result, after: before })

  const pkg = readProfilePackage(profileDir)
  result.steps.dependencies = writeProfileDependencies({ dir: profileDir, pkg, root, missing: before.missingDeps, dryRun, log })
  result.steps.junctions = LEGION_PACKAGES.map((p) => ensureJunction(profileDir, root, p, { dryRun, log }))
  // 写进文件的 insert 项**不带 id**：id 只在本脚本内部用来描述"缺哪一行"。
  const rowsToWrite = before.patchMissingRows.map((r) => ({ name: r.name, config: r.config }))
  result.steps.patch = appendPatchRows({ patchFile: before.patchFile, entries: rowsToWrite, dryRun, log })

  const after = planProfile({ root, profileDir, patchEntries })
  const afterGaps = after.missingDeps.length + after.brokenJunctions.length + after.patchMissingRows.length
  return Object.freeze({ ...result, before, after, afterGaps })
}

/** 找同目录下最近的 `.bak-*`（`--restore` 用；找不到返回 null）。 */
export function latestBackupOf(file) {
  const dir = dirname(file)
  const base = file.slice(dir.length + 1)
  let best = null
  let entries = []
  try { entries = readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (!name.startsWith(`${base}.bak-`)) continue
    const p = join(dir, name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (!st.isFile()) continue
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }
  }
  return best
}

/** 把档案的两个文件各自回退到最近的 `.bak-*`。 */
export function restoreProfile({ profileDir, dryRun = false, log = () => {} }) {
  const out = []
  for (const file of [join(profileDir, 'package.json'), join(profileDir, 'cordis.patch.yml')]) {
    const bak = latestBackupOf(file)
    if (!bak) { out.push({ file, action: 'no-backup' }); continue }
    if (dryRun) { out.push({ file, action: 'would-restore', from: bak.path }); log(`  · [dry-run] 会从 ${bak.path} 恢复 ${file}`); continue }
    writeFileSync(file, readFileSync(bak.path, 'utf8'))
    out.push({ file, action: 'restored', from: bak.path })
    log(`  · 已从 ${bak.path} 恢复 ${file}`)
  }
  return out
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgv(argv = process.argv.slice(2)) {
  const out = { mode: 'verify', profiles: [], dryRun: false, root: null, dshHome: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verify') out.mode = 'verify'
    else if (a === '--wire') out.mode = 'wire'
    else if (a === '--restore') out.mode = 'restore'
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a === '--profile') out.profiles.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    else if (a.startsWith('--profile=')) out.profiles.push(...a.slice(10).split(',').map((s) => s.trim()).filter(Boolean))
    else if (a === '--root') out.root = argv[++i]
    else if (a === '--dsh-home') out.dshHome = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  if (out.profiles.length === 0) out.profiles = ['web', 'desktop']
  return out
}

function fmtPlan(p, mode) {
  const L = []
  L.push(`档案 ${p.profileDir}`)
  if (!p.exists) L.push('  ✗ 该档案没有 package.json（跳过）')
  L.push(`  · file: 依赖缺失 ${p.missingDeps.length} 条${p.missingDeps.length ? '：' + p.missingDeps.map((m) => m.name).join(', ') : ''}`)
  const bad = p.brokenJunctions
  L.push(`  · junction ${p.junctions.length - bad.length}/${p.junctions.length} 可用${bad.length ? '；异常：' + bad.map((b) => `${b.name}(${b.state})`).join(', ') : ''}`)
  L.push(`  · 补丁行缺失 ${p.patchMissingRows.length} 行${p.patchMissingRows.length ? '：' + p.patchMissingRows.map((r) => r.id).join(', ') : ''}`)
  const stale = p.patchStaleRows ?? []
  L.push(`  · 已存在但配置过时 ${stale.length} 行${stale.length ? '：' + stale.map((s) => `${s.id}（缺 ${s.missing.join(' / ')}）`).join('；') : ''}`)
  if (stale.length > 0) L.push('    ⚠ 过时的值**不会自动改**（那一行是既有配置，改它要人来定）：请对照 docs/PROFILE-WIRING.md 手工修正')
  if (mode === 'wire') L.push('  → 本次会补齐上述缺口（幂等；改前留 .bak-<时间戳>）')
  return L.join('\n')
}

async function main() {
  let opts
  try { opts = parseArgv() } catch (e) { console.error(`参数错误：${e.message}`); process.exit(2) }
  if (opts.help) {
    console.log('用法：node scripts/legion-profile.mjs [--verify|--wire|--restore] [--profile web,desktop] [--dry-run] [--json] [--root <仓库根>] [--dsh-home <DSH_HOME>]')
    return
  }
  const root = opts.root ? resolve(opts.root) : repoRootOf()
  const dshHome = opts.dshHome ? resolve(opts.dshHome) : defaultDshHome()
  const entries = entryObjectsFor(root)
  const say = (m) => { if (!opts.json) console.log(m) }

  const report = { root, dshHome, mode: opts.mode, dryRun: opts.dryRun, profiles: [] }
  let gaps = 0
  let plannedGaps = 0 // dry-run 专用：当前缺口（不是"wire 后的残留"）

  for (const name of opts.profiles) {
    const profileDir = join(dshHome, 'profiles', name)
    if (opts.mode === 'restore') {
      say(`档案 ${profileDir}（回退到最近备份）`)
      const res = restoreProfile({ profileDir, dryRun: opts.dryRun, log: say })
      const after = planProfile({ root, profileDir, patchEntries: entries })
      gaps += after.missingDeps.length + after.brokenJunctions.length + after.patchMissingRows.length
      report.profiles.push({ profile: name, dir: profileDir, restored: res })
      continue
    }

    const plan = planProfile({ root, profileDir, patchEntries: entries })
    say(fmtPlan(plan, opts.mode))
    const beforeGaps = plan.missingDeps.length + plan.brokenJunctions.length + plan.patchMissingRows.length

    if (opts.mode === 'wire') {
      const w = wireProfile({ root, profileDir, patchEntries: entries, dryRun: opts.dryRun, log: say })
      const line = {
        profile: name, dir: profileDir, exists: plan.exists, dryRun: opts.dryRun,
        before: { missingDeps: plan.missingDeps.map((m) => m.name), brokenJunctions: plan.brokenJunctions.map((b) => `${b.name}:${b.state}`), patchMissingRows: plan.patchMissingRows.map((r) => r.id) },
        steps: w.steps,
        after: w.after ? { missingDeps: w.after.missingDeps.map((m) => m.name), brokenJunctions: w.after.brokenJunctions.map((b) => `${b.name}:${b.state}`), patchMissingRows: w.after.patchMissingRows.map((r) => r.id) } : null,
        afterGaps: w.afterGaps ?? null,
      }
      // 复查读数只在**真的写过**时才有意义；dry-run 下如实标 null，不用计划值冒充结果，
      // 也**不要**把 dry-run 的"当前缺口"当成"wire 后的残留缺口"报出去。
      if (opts.dryRun) {
        plannedGaps += beforeGaps
      } else {
        gaps += w.afterGaps ?? 0
        if (!opts.json && w.after) say(`  → 复查：残留缺口 ${w.afterGaps} 处` + (w.afterGaps === 0 ? '（依赖 + junction + 补丁行齐了；重启宿主后生效）' : ''))
      }
      report.profiles.push(line)
      continue
    }

    gaps += plan.missingDeps.length + plan.brokenJunctions.length + plan.patchMissingRows.length
    report.profiles.push({ profile: name, dir: profileDir, ...JSON.parse(JSON.stringify(plan)) })
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log('')
    if (opts.mode === 'verify') console.log(gaps === 0 ? '✓ 全部档案已接好（依赖 + junction + 补丁行）' : `✗ 共 ${gaps} 处缺口（用 --wire 补齐）`)
    else if (opts.mode === 'wire') {
      if (opts.dryRun) console.log(`（dry-run：未写任何文件；当前缺口 ${plannedGaps} 处，去掉 --dry-run 即补齐）`)
      else console.log(gaps === 0 ? '✓ wire 完成，复查无缺口（重启宿主后生效）' : `✗ wire 后仍有 ${gaps} 处缺口`)
    }
    else console.log(gaps === 0 ? '✓ 回退后缺口归零（该档案不再接 Legion）' : `⚠ 回退后仍有 ${gaps} 处缺口（可能本来就有别的接线）`)
  }
  process.exit(gaps === 0 ? 0 : 1)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().catch((e) => { console.error(`legion-profile 失败：${e.message}`); process.exit(3) })
}
