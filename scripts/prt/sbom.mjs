// scripts/prt/sbom.mjs
// ============================================================================
// PRT-901 / PRT-902 的**生产入口**：生成第三方组件清单与 SBOM，并给出分发条件。
//
// spec §10 line 745。判据在 `product/compliance/inventory.mjs`，本脚本是它的
// 生产调用方——否则那套判据就只是一堆从没人跑过的函数。
//
// ## 用法
//
//   node scripts/prt/sbom.mjs                 # 打印摘要
//   node scripts/prt/sbom.mjs --json          # 打印完整 SBOM
//   node scripts/prt/sbom.mjs --write <dir>   # 写出 sbom.json + distribution.json
//   node scripts/prt/sbom.mjs --check         # 有 blocker 时退出 1
//
// ## ★ 为什么本脚本必须**自己去磁盘上找** vendored 树
//
// 因为那件事不能从清单推出来。本仓库有一棵被跟踪的 vendored 第三方源码树
// （`.skills-cache/` 下 499 个文件），它**恰好**带了 package.json，
// 所以"只读清单"的 SBOM 会扫到它——但那是运气，不是判据。
//
// 真正会漏的是**没有清单的 vendored 代码**，以及落在被跳过目录
// （`docs/`、`scratch/`）下的采集副本。本脚本把磁盘事实交给判据，
// 至于"哪些目录算 vendored"，见下面的 `discoverVendoredTrees`。
// ============================================================================

import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectManifests, buildSbom, assertInventoryComplete, distributionReport,
} from '../../product/compliance/inventory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** vendored 代码的候选根。改这里等于改"哪些东西算随产品分发的第三方"。 */
export const VENDORED_ROOTS = Object.freeze(['.skills-cache', 'vendor', 'third_party'])

/**
 * 在磁盘上找 vendored 源码树。
 *
 * @param {string} root
 * @param {{listDir?: Function, exists?: Function}} [io] 可注入（测试要能造假磁盘）
 * @returns {ReadonlyArray<string>} 仓库相对路径
 */
export function discoverVendoredTrees(root, io = {}) {
  const listDir = io.listDir ?? ((d) => readdirSync(d, { withFileTypes: true }))
  const exists = io.exists ?? ((p) => existsSync(p))
  const found = []
  for (const vr of VENDORED_ROOTS) {
    const base = join(root, vr)
    if (!exists(base)) continue
    let entries
    try { entries = listDir(base) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // `.skills-cache/<owner>/<repo>` 是两层；`vendor/<name>` 是一层。
      // 两种都收：判据不关心层级，只关心"这里有一棵树"。
      const inner = findTreeAt(join(base, e.name), listDir, exists)
      if (inner !== null) found.push(inner)
      else if (hasAnyFile(join(base, e.name), listDir)) found.push(join(base, e.name))
    }
  }
  return Object.freeze([...new Set(found.map((p) => relative(root, p).replace(/\\/g, '/')))].sort())
}

/** 若 `dir` 下恰好有一个子目录含 package.json，返回那个子目录。 */
function findTreeAt(dir, listDir, exists) {
  let entries
  try { entries = listDir(dir) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (exists(join(p, 'package.json'))) return p
  }
  return null
}

function hasAnyFile(dir, listDir) {
  try { return listDir(dir).some((e) => !e.isDirectory()) } catch { return false }
}

/** 磁盘上实际存在的 `node_modules` 前缀。缺席（返回 undefined）与空数组不同。 */
function discoverInstalledPrefixes(root) {
  try {
    if (!existsSync(join(root, 'node_modules'))) {
      // 根 node_modules 都没有：这就是"看了，磁盘上什么都没有"。
      return []
    }
    const out = []
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(root, e.name, 'node_modules'))) out.push(`${e.name}/node_modules`)
    }
    if (existsSync(join(root, 'node_modules'))) out.push('node_modules')
    return out
  } catch { return undefined }   // 读不了 = 没去看，不是"空的"
}

export function generate(root = ROOT, io = {}) {
  const manifests = collectManifests(root, io)
  const vendoredTrees = discoverVendoredTrees(root, io)
  const installedPrefixes = io.installedPrefixes ?? discoverInstalledPrefixes(root)
  const sbom = buildSbom({ root, manifests, vendoredTrees, installedPrefixes })
  return Object.freeze({
    sbom,
    distribution: distributionReport(sbom),
    completeness: assertInventoryComplete(sbom),
  })
}

function parseArgs(argv) {
  const out = { json: false, write: null, check: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--check') out.check = true
    else if (a === '--write') out.write = argv[++i] ?? null
    else if (a === '--help' || a === '-h') out.help = true
    else return { error: `未知参数 ${JSON.stringify(a)}` }
  }
  return out
}

const USAGE = `用法：node scripts/prt/sbom.mjs [--json] [--write <dir>] [--check]

  --json          打印完整 SBOM 与分发条件报告
  --write <dir>   写出 sbom.json 与 distribution.json
  --check         有分发条件 blocker 时退出 1
`

export function render(result) {
  const { sbom, distribution, completeness } = result
  const lines = []
  lines.push(`第三方组件清单 ${sbom.version}`)
  lines.push(`清单根（${sbom.roots.length}）：${sbom.roots.join(' / ') || '（无）'}`)
  lines.push('')
  lines.push(`组件：声明依赖 ${sbom.declaredCount} / vendored 源码树 ${sbom.vendoredCount}`)
  lines.push(`完整性：${completeness.ok ? '✔ 覆盖两个来源' : '✖ 不完整'}`)
  for (const p of completeness.problems) lines.push(`    · ${p}`)
  // ★ 同码的发现**按码归并**再打印，而不是倾倒全部。一棵 vendored 树的 13 个
  //   未安装依赖是同一件事的 13 次重复，会把真正的发现（比如"某棵树没有清单"）
  //   淹掉——一份长得像日志的报表，与一份没人看的报表，是同一个东西。
  const byCode = new Map()
  for (const f of sbom.findings) {
    if (!byCode.has(f.code)) byCode.set(f.code, [])
    byCode.get(f.code).push(f)
  }
  for (const [code, list] of byCode) {
    lines.push(`  [${code}] ×${list.length}  ${list[0].path ?? ''}`)
    if (list.length === 1) lines.push(`      ${list[0].detail ?? ''}`)
    else lines.push(`      首条：${list[0].detail ?? ''}`)
  }
  lines.push('')
  lines.push('商业分发条件：')
  for (const v of Object.keys(distribution.counts)) {
    lines.push(`  ${v.padEnd(11)} ${distribution.counts[v]}`)
  }
  lines.push(`  可分发：${distribution.clear ? '是' : '否（有 blocker）'}`)
  // 只打印前若干条 blocker：43 个依赖的"尚未读取"是同一件事的 43 次重复，
  // 全列出来会让真正的 blocker（比如一个 GPL 的 vendored 树）被淹掉。
  const shown = distribution.blockers.slice(0, 5)
  for (const b of shown) lines.push(`    ✖ ${b.name ?? '(无名)'} license=${b.license ?? '(无)'} — ${b.reason}`)
  if (distribution.blockers.length > shown.length) {
    lines.push(`    …另有 ${distribution.blockers.length - shown.length} 条同类 blocker（--json 可看全部）`)
  }
  return lines.join('\n')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error) { process.stderr.write(`${args.error}\n\n${USAGE}`); return 2 }
  if (args.help) { process.stdout.write(USAGE); return 0 }

  const result = generate(ROOT)
  if (args.write !== null) {
    const dir = resolve(ROOT, args.write)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sbom.json'), `${JSON.stringify(result.sbom, null, 2)}\n`, 'utf8')
    writeFileSync(join(dir, 'distribution.json'), `${JSON.stringify(result.distribution, null, 2)}\n`, 'utf8')
    process.stdout.write(`已写出 ${join(args.write, 'sbom.json')} 与 ${join(args.write, 'distribution.json')}\n`)
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (args.write === null) process.stdout.write(`${render(result)}\n`)

  if (args.check) {
    // 退出码由**完整性**与**分发条件**共同决定：SBOM 不全和许可有 blocker
    // 是两种不同的失败，但都该拦住发布。
    if (!result.completeness.ok) return 1
    if (!result.distribution.clear) return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}

export { USAGE, parseArgs }
