#!/usr/bin/env node
// scripts/prt/composition-baseline.mjs
// ============================================================================
// PRT-010：DSH 组合分层与 Legion 挂载基线
//
// 采集三样东西，落成可 diff 的锚点快照：
//   ① 组合分层链：dsh-base → 模式 bundle → 用户 profile 层（含实际 bundles 列表）
//   ② Legion 在用户层的每一行：row id / 包名 / config 键集合
//   ③ Legion 包的挂载形态：file: 依赖（pnpm 复制快照）
//
// ## 为什么不记录 config 的值
//
// 用户层 cordis.patch.yml 的 config 里是**绝对路径**（`D:/project/DSH/legion`）与
// **凭证字段**（`hubToken: ''`）。把值写进快照会让：
//   - 快照与机器绑定 → 换台机器 diff 全是噪音，基线失去意义；
//   - 凭证字段进入版本库 → 正是 PRT-003/PRT-505 要避免的。
// 因此只记 **config 键名** 与 **是否为空**。契约是「有哪些行、每行配了哪些键」，
// 不是「这台机器上配了什么值」。
//
// ## 为什么没有 YAML 依赖
//
// 与仓库既有约定一致：CI 脚本零第三方依赖。这里按 loader patch 的**行式结构**
// 解析（`- id:` / `name:` / `config:` + 缩进键），而不是引入 yaml 包。
// 解析器有单测覆盖，且解析不出行时**抛错**而不是返回空基线。
//
// 用法：
//   node scripts/prt/composition-baseline.mjs --record      # 采集并写入快照
//   node scripts/prt/composition-baseline.mjs --diff        # 与快照比较（默认）
//   node scripts/prt/composition-baseline.mjs --json
//   node scripts/prt/composition-baseline.mjs --where       # 打印实际读到的路径
//   node scripts/prt/composition-baseline.mjs --help
//
// 环境：DSH_HOME（默认 ~/.dsh）。profile 名用 --profile=web 覆盖。
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_PATH = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-010-composition-baseline.json')
const rel = (p) => p.split(sep).join('/')

/** Legion 自有包前缀：这些行是产品挂载面，其余是 DSH 基础行。 */
export const LEGION_PACKAGE_PREFIX = '@dsh-external/'

/**
 * Legion 各包的**仓库内来源**。挂载面是 `file:` 依赖，只有包名无法回答
 * 「这个包对应仓库哪个目录」，而那正是排障时要找的东西。
 */
export const LEGION_PACKAGES = Object.freeze({
  '@dsh-external/dsh-team-hub': 'team-hub',
  '@dsh-external/dsh-scrum-board': 'board-plugin',
  '@dsh-external/dsh-scrum-worker': 'plugins',
  '@dsh-external/dsh-legion-services': 'services-plugin',
})

function must(cond, message) {
  if (!cond) throw new Error(`组合基线采集失败：${message}`)
}

/** 解析 dsh home 与 profile 目录。 */
export function resolvePaths({ dshHome, profile = 'web' } = {}) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = join(home, 'profiles', profile)
  return {
    dshHome: home,
    profile,
    profileDir,
    patchFile: join(profileDir, 'cordis.patch.yml'),
    rootFile: join(profileDir, 'cordis.yml'),
    packageFile: join(profileDir, 'package.json'),
    lockFile: join(profileDir, 'pnpm-lock.yaml'),
  }
}

/**
 * 解析 loader patch 的行式结构。
 *
 * 返回顶层条目数组：
 *   { kind: 'insert', rows: [{ id, name, configKeys, emptyConfigKeys }] }
 *   { kind: 'override', id, configKeys, emptyConfigKeys, disabled }
 *
 * 只处理本仓库实际使用的子集：顶层数组、`- insert:` 列表、`- id:` 条目、
 * `config:` 下的**一级**键、`disabled:` 标志。嵌套更深的 config 结构只记一级键名。
 */
export function parsePatch(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  let current = null        // 当前顶层条目
  let currentRow = null     // 当前 row（insert 列表内）
  let inConfig = false
  let configIndent = -1
  let childIndent = -1      // config 块内**直接子键**的缩进

  const indentOf = (s) => s.length - s.trimStart().length

  for (const raw of lines) {
    const noComment = stripYamlComment(raw)
    if (noComment.trim() === '') continue
    const indent = indentOf(noComment)
    const line = noComment.trim()

    // 顶层条目：`- insert:` 或 `- id: X`
    if (indent === 0 && line.startsWith('- ')) {
      inConfig = false
      childIndent = -1
      const body = line.slice(2).trim()
      if (body === 'insert:') {
        current = { kind: 'insert', rows: [] }
        entries.push(current)
        currentRow = null
        continue
      }
      const idMatch = /^id:\s*(.+)$/.exec(body)
      if (idMatch) {
        current = { kind: 'override', id: unquote(idMatch[1]), configKeys: [], emptyConfigKeys: [], disabled: false }
        entries.push(current)
        currentRow = current
        continue
      }
      // 其它顶层形态（如 `- disabled: true` 单独条目）不常见，登记为未知以便发现
      current = { kind: 'unknown', raw: body }
      entries.push(current)
      currentRow = null
      continue
    }

    if (current === null) continue

    // config 块内：只收**直接子键**，嵌套更深的子键不收。
    // 若不过滤缩进，`outer:` 下面的 `inner:` 会被当成一级键，于是「config 键集合」
    // 随嵌套结构漂移——而契约要的是「这一行配了哪些顶层配置项」。
    if (inConfig) {
      if (indent <= configIndent) {
        inConfig = false
        childIndent = -1
        // 落到下面的通用处理
      } else {
        if (childIndent === -1) childIndent = indent
        if (indent === childIndent) {
          const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
          if (m && currentRow) {
            const key = m[1]
            const value = m[2].trim()
            if (!currentRow.configKeys.includes(key)) currentRow.configKeys.push(key)
            if (isScalarEmpty(value) && !currentRow.emptyConfigKeys.includes(key)) {
              currentRow.emptyConfigKeys.push(key)
            }
          }
        }
        continue
      }
    }

    if (line === 'config:') {
      inConfig = true
      configIndent = indent
      childIndent = -1
      continue
    }
    if (line.startsWith('disabled:')) {
      const v = line.slice('disabled:'.length).trim()
      if (currentRow) currentRow.disabled = /^true$/i.test(v)
      continue
    }

    // insert 列表内的 row 起始：`- id: X`
    if (line.startsWith('- id:')) {
      const id = unquote(line.slice('- id:'.length).trim())
      currentRow = { id, name: null, configKeys: [], emptyConfigKeys: [], disabled: false }
      if (current && current.kind === 'insert') current.rows.push(currentRow)
      continue
    }
    if (line.startsWith('name:') && currentRow) {
      currentRow.name = unquote(line.slice('name:'.length).trim())
      continue
    }
  }

  // 归一化：config 键排序，保证 diff 稳定
  for (const e of entries) {
    if (e.kind === 'insert') {
      for (const r of e.rows) {
        r.configKeys.sort()
        r.emptyConfigKeys.sort()
      }
    } else {
      e.configKeys?.sort()
      e.emptyConfigKeys?.sort()
    }
  }
  return entries
}

/** 去掉行尾 YAML 注释（不处理引号内的 `#`；本仓库的组合文件里没有该形态）。 */
function stripYamlComment(line) {
  const i = line.indexOf(' #')
  if (i === -1) return line
  return line.slice(0, i)
}

function unquote(s) {
  const t = s.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1)
  }
  return t
}

/** 判断标量是否为空（''、null、[]、{}）。 */
function isScalarEmpty(v) {
  return v === "''" || v === '""' || v === '' || v === 'null' || v === '~' || v === '[]' || v === '{}'
}

/** 从 patch 条目中抽出 Legion 行（含 id/name/config 键）。 */
export function legionRows(entries) {
  const rows = []
  for (const e of entries) {
    if (e.kind === 'insert') {
      for (const r of e.rows) {
        if (typeof r.name === 'string' && r.name.startsWith(LEGION_PACKAGE_PREFIX)) {
          rows.push({
            id: r.id,
            package: r.name,
            repoDir: LEGION_PACKAGES[r.name] ?? null,
            configKeys: r.configKeys,
            emptyConfigKeys: r.emptyConfigKeys,
          })
        }
      }
    } else if (e.kind === 'override' && typeof e.id === 'string' && e.id.startsWith('legion-')) {
      rows.push({ id: e.id, package: null, repoDir: null, configKeys: e.configKeys, emptyConfigKeys: e.emptyConfigKeys })
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

/** 采集 profile 的 bundles 与 Legion file: 依赖。 */
export function readProfilePackage(file) {
  if (!existsSync(file)) return { ok: false, reason: `找不到 ${rel(file)}` }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${err.message}` }
  }
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  const patchReload = pkg?.dsh?.profile?.patchReload ?? null
  const deps = Object.entries(pkg.dependencies ?? {})
    .filter(([k]) => k.startsWith(LEGION_PACKAGE_PREFIX))
    .map(([name, spec]) => {
      const raw = String(spec)
      const isFileDependency = raw.startsWith('file:')
      const repoDir = LEGION_PACKAGES[name] ?? null
      // 只记「是否 file: 依赖」与「指向的目录名」，**不记原始 spec**：
      // spec 里是机器绝对路径（file:D:/project/.../services-plugin），
      // 写进快照会让基线绑定到某台机器，diff 全是噪音，也把用户名带进版本库。
      // 真正要判的是「依赖是否指向本仓库对应目录」——用目录名比对即可。
      const specDir = isFileDependency ? raw.replace(/^file:/, '').split(/[\\/]/).filter(Boolean).pop() ?? null : null
      return {
        name,
        isFileDependency,
        repoDir,
        pointsAtRepoDir: repoDir !== null && specDir === repoDir,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, name: pkg.name ?? null, bundles, patchReload, legionDeps: deps }
}

/** 生成基线快照（确定性：不含时间戳、不含绝对路径、不含 config 值）。 */
export function buildCompositionBaseline(options = {}) {
  const paths = resolvePaths(options)
  must(existsSync(paths.patchFile), `找不到用户层组合 ${rel(paths.patchFile)}（DSH_HOME=${paths.dshHome}）`)
  const text = readFileSync(paths.patchFile, 'utf8')
  const entries = parsePatch(text)
  must(entries.length > 0, `未能从 ${rel(paths.patchFile)} 解析出任何组合条目`)

  const rows = legionRows(entries)
  must(rows.length > 0, '未在用户层发现任何 Legion 行（@dsh-external/*）')

  const pkg = readProfilePackage(paths.packageFile)
  const rootText = existsSync(paths.rootFile) ? readFileSync(paths.rootFile, 'utf8') : null

  return {
    $comment:
      'PRT-010 DSH 组合分层与 Legion 挂载基线。由 scripts/prt/composition-baseline.mjs 生成。' +
      '**不含 config 值、不含绝对路径、不含时间戳**：契约是「有哪些行、每行配了哪些键」，' +
      '不是「某台机器上配了什么」。',
    version: 1,
    profile: paths.profile,
    // profile 根是空列表：整棵树由 patch 链合成（记录原文以证）
    profileRootIsEmptyList: rootText !== null && /^\s*\[\s*\]\s*$/m.test(rootText.replace(/^#.*$/gm, '')),
    bundles: pkg.ok ? pkg.bundles : null,
    patchReload: pkg.ok ? pkg.patchReload : null,
    layers: [
      { order: 1, layer: 'dsh-base', source: 'packages/bundle/base/cordis.patch.yml', kind: 'insert' },
      ...(pkg.ok ? pkg.bundles.slice(1).map((b, i) => ({
        order: i + 2,
        layer: b,
        source: `packages/bundle/${b.replace('@deepseek-ai/dsh-', '')}/cordis.patch.yml`,
        kind: 'patch-over',
      })) : []),
      { order: (pkg.ok ? pkg.bundles.length : 1) + 1, layer: '用户 profile 层', source: 'profiles/<profile>/cordis.patch.yml', kind: 'patch-over' },
    ],
    legionRows: rows,
    legionDeps: pkg.ok ? pkg.legionDeps : null,
    packageReadError: pkg.ok ? null : pkg.reason,
  }
}

// ---------------------------------------------------------------- diff

export function diffBaselines(before, after) {
  const lines = []
  const listDiff = (label, a = [], b = []) => {
    for (const x of b) if (!a.includes(x)) lines.push(`  + ${label}: ${x}`)
    for (const x of a) if (!b.includes(x)) lines.push(`  - ${label}: ${x}`)
  }
  listDiff('bundle 层', before.bundles ?? [], after.bundles ?? [])
  listDiff('组合行', (before.legionRows ?? []).map((r) => r.id), (after.legionRows ?? []).map((r) => r.id))

  const byId = (bs) => Object.fromEntries((bs.legionRows ?? []).map((r) => [r.id, r]))
  const b = byId(before)
  const a = byId(after)
  for (const id of Object.keys(a).filter((x) => x in b).sort()) {
    listDiff(`${id}.config`, b[id].configKeys ?? [], a[id].configKeys ?? [])
    listDiff(`${id}.空值键`, b[id].emptyConfigKeys ?? [], a[id].emptyConfigKeys ?? [])
    if (b[id].package !== a[id].package) lines.push(`  ~ ${id}.包名: ${b[id].package} -> ${a[id].package}`)
  }
  listDiff('Legion file: 依赖', (before.legionDeps ?? []).map((d) => d.name), (after.legionDeps ?? []).map((d) => d.name))
  return lines
}

function usage() {
  console.log('composition-baseline.mjs — PRT-010 DSH 组合分层与 Legion 挂载基线')
  console.log('')
  console.log('  --record        采集并写入快照（需要 DSH_HOME 下的 profile）')
  console.log('  --diff          与快照比较（默认）')
  console.log('  --json          打印当前采集结果')
  console.log('  --where         打印实际读取的路径')
  console.log('  --profile=web   profile 名（默认 web）')
  console.log('  --help          本说明')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const profile = argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) || 'web'
  const paths = resolvePaths({ profile })

  if (argv.includes('--where')) {
    for (const [k, v] of Object.entries(paths)) console.log(`  ${k.padEnd(12)} ${rel(v)}  ${existsSync(v) ? '存在' : '缺失'}`)
    return
  }

  let current
  try {
    current = buildCompositionBaseline({ profile })
  } catch (err) {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(current, null, 2))
    return
  }
  if (argv.includes('--record')) {
    writeFileSync(OUT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
    console.log(`基线已写入 ${rel(OUT_PATH)}`)
    console.log(`  bundles: ${(current.bundles ?? []).join(' -> ')}`)
    console.log(`  Legion 行 ${current.legionRows.length} 个：${current.legionRows.map((r) => r.id).join(', ')}`)
    console.log(`  file: 依赖 ${(current.legionDeps ?? []).length} 个`)
    return
  }
  if (!existsSync(OUT_PATH)) {
    console.error(`未找到基线 ${rel(OUT_PATH)}。先运行 --record。`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(OUT_PATH, 'utf8'))
  const lines = diffBaselines(before, current)
  if (lines.length === 0) {
    console.log('composition-baseline: 与基线一致（无漂移）')
    return
  }
  console.log('composition-baseline: 检测到组合漂移')
  console.log(lines.join('\n'))
  console.log('')
  console.log('  若确为有意变更，运行 --record 刷新基线并在提交信息中说明。')
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  })
}
