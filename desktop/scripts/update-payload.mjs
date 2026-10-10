#!/usr/bin/env node
// desktop/scripts/update-payload.mjs
// ============================================================================
// 从一次已暂存的桌面构建产出**升级包** —— 与更新端同一套闭包格式
//
// ## 为什么这一层存在
//
// `stage.mjs` 产出的是 `stage/{shell,resources}`（给 electron-builder 用），
// 而更新端要的是一个能解压到 `installRoot/versions/<version>/` 的 ZIP，
// 并且带着与 `publish.mjs` 同形的包内闭包。
//
// 这中间那一步以前是**空的**：`publish.mjs` 只能接受一个"别处打好的 ZIP"
// （`--package-zip`），于是"发布出去的包里的文件树"与"桌面实际装出来的
// 文件树"从没有任何一处被对齐过。两边的分歧不会在打包时暴露，只会在
// **用户升级之后**暴露——而那时它表现为"某个服务起不来"。
//
// ## 对齐的判据（不是"看起来差不多"）
//
//   · 载荷根 = `<stage>/resources/legion`，与 `main.mjs` 的
//     `installRoot`（打包后是 `process.resourcesPath/legion`）**同一个位置**。
//     这是唯一能让"解压出来的版本目录"与"程序目录"同构的取法。
//   · 载荷里**不得**出现 helper 与随包 Node：它们不在待切换目录里
//     （设计 §3 line 57）。`resources/update/**` 与 `resources/node/**`
//     在载荷根之外，所以按构造就不会进去；这里额外断言一次。
//   · 载荷里不得出现本机数据（`.legion`、`roles-ozon.json`、`scratch/`）。
//     `stage.mjs` 已经按生产根过滤过，这里再按名字拒一遍——两道判据独立，
//     因为前者只认"哪些目录进"，漏掉一个新加的数据目录时后者会拦住。
//   · 目标产品版本清单（`product/release/runtime-manifest.json`）必须在载荷里，
//     而且它的 `productVersion` 必须与本次发行的版本一致。设计 §4 line 76：
//     ZIP「包含产品文件闭包和目标产品版本清单」。
//
// 用法：
//   node desktop/scripts/update-payload.mjs --stage <stage 目录> --out <输出目录> \
//     --product-version 1.1.0
//   # 或者从 current-stage.json 取：
//   node desktop/scripts/update-payload.mjs --stage-file .desktop-build/current-stage.json --out dist
// ============================================================================

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLOSURE_ENTRY_NAME, closureDigest } from '../../product/update/closure.mjs'
import { packDirectory } from '../../scripts/update/publish.mjs'
import { sha256Hex } from '../../product/update/canonical.mjs'
import { isSemver } from '../../product/update/semver.mjs'
// ★ 与安装包（`stage.mjs`）**共用**这一条：根下 `roles*.json` 里哪些不进产品树。
//   此前这里是硬编码的 `'roles-ozon.json'`，而 `stage.mjs` 用的是
//   `/^roles[^/]*\.json$/`（放行它）——两侧对"产品树包含什么"各说各话。
import { isShippableRootRoleFile } from './payload-filter.mjs'

/** 载荷根相对 stage 目录的位置。与 `main.mjs` 的 `installRoot` 同源。 */
export const PAYLOAD_RELATIVE_ROOT = Object.freeze(['resources', 'legion'])

/**
 * 载荷里**不允许**出现的顶层名字。
 *
 * 三类，理由各不相同：
 *   · `update` / `node` / `git` / `dsh.asar`：它们是"随包但不属于待切换目录"
 *     的东西（helper 与运行时）。进了载荷就等于每次升级都把它们换一遍——
 *     而 helper 正是执行这次替换的那段代码。
 *   · `.legion` / `.desktop-build` / `dist` / `scratch` / `.tmp*`：构建与本机
 *     状态。
 *   · `roles-ozon.json`：本地/空间数据。判据**不在这里写死**，而是从
 *     `payload-filter.mjs` 的 `isShippableRootRoleFile()` 取 ——
 *     与安装包（`stage.mjs`）用的是同一条。写死过一次，结果与安装包漂开了。
 */
export const FORBIDDEN_PAYLOAD_ENTRIES = Object.freeze([
  'update', 'node', 'git', 'dsh.asar', 'desktop-release.json',
  '.legion', '.desktop-build', 'dist', 'scratch', '.tmp',
  'roles-ozon.json',
])

/**
 * 载荷禁止项判据：名字清单 + **共享的 roles 判据**。
 *
 * 单列一个函数是为了让"这里的规则"与"`stage.mjs` 的规则"能被同一套用例
 * 同时驱动——见 `payload-filter.test.mjs` 里那条跨路径判据。
 */
export function isForbiddenPayloadEntry(relative, { top } = {}) {
  const rel = String(relative).split('\\').join('/')
  const head = top ?? rel.split('/')[0]
  if (FORBIDDEN_PAYLOAD_ENTRIES.includes(head)) return true
  if (FORBIDDEN_PAYLOAD_PATTERNS.some((pattern) => pattern.test(rel))) return true
  // 根下的 `roles*.json`：共享判据说不能发 → 载荷里也不许出现。
  if (!rel.includes('/') && /^roles[^/]*\.json$/.test(rel) && !isShippableRootRoleFile(rel)) return true
  return false
}

/** 名字类判据：`node_modules`、`*.test.mjs`、`.part` 之类。 */
export const FORBIDDEN_PAYLOAD_PATTERNS = Object.freeze([
  /(^|\/)node_modules(\/|$)/,
  /\.(test|spec)\.[cm]?[jt]s$/,
  /\.part$/,
  /^\.tmp/,
])

export const PAYLOAD_CODES = Object.freeze({
  NO_STAGE: 'payload-no-stage',
  NO_LEGION_ROOT: 'payload-no-legion-root',
  FORBIDDEN_ENTRY: 'payload-forbidden-entry',
  NO_MANIFEST: 'payload-no-manifest',
  VERSION_MISMATCH: 'payload-version-mismatch',
  EMPTY: 'payload-empty',
  PACK_FAILED: 'payload-pack-failed',
})

function fail(code, reason, extra = {}) {
  return Object.freeze({ ok: false, code, reason, ...extra })
}

/** 从 `current-stage.json` 的内容或一个 stage 目录求出 `{ stage, resources }`。 */
export function resolveStage({ stageDir = null, stageFile = null, readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  if (stageFile !== null) {
    if (!existsSync(stageFile)) return fail(PAYLOAD_CODES.NO_STAGE, `stage 描述文件不存在：${stageFile}`)
    let parsed
    try { parsed = JSON.parse(readFile(stageFile)) } catch (error) {
      return fail(PAYLOAD_CODES.NO_STAGE, `stage 描述文件读不出来：${error?.message ?? error}`)
    }
    if (typeof parsed?.resources !== 'string' || !existsSync(parsed.resources)) {
      return fail(PAYLOAD_CODES.NO_STAGE, `stage 描述文件里的 resources 不可用：${parsed?.resources}`)
    }
    return { ok: true, resources: parsed.resources, stage: parsed.stage ?? dirname(parsed.resources) }
  }
  if (stageDir !== null) {
    const resolved = resolve(stageDir)
    if (!existsSync(resolved)) return fail(PAYLOAD_CODES.NO_STAGE, `stage 目录不存在：${resolved}`)
    // 既接受"stage 目录"也接受"resources 目录"。
    const resources = basename(resolved) === 'resources' ? resolved : join(resolved, 'resources')
    if (!existsSync(resources)) return fail(PAYLOAD_CODES.NO_STAGE, `在 ${resolved} 下找不到 resources/`)
    return { ok: true, resources, stage: basename(resolved) === 'resources' ? dirname(resolved) : resolved }
  }
  return fail(PAYLOAD_CODES.NO_STAGE, 'update-payload 需要 --stage 或 --stage-file')
}

/**
 * 校验载荷根的形状，返回顶层条目清单。
 *
 * 这一层**不**解压、不写文件：它只回答"这个目录树允不允许被打成升级包"。
 */
export function inspectPayloadRoot({
  payloadRoot,
  productVersion = null,
  readFile = (path) => readFileSync(path, 'utf8'),
  readdir = (path) => readdirSync(path, { withFileTypes: true }),
  exists = existsSync,
} = {}) {
  if (typeof payloadRoot !== 'string' || payloadRoot === '') {
    return fail(PAYLOAD_CODES.NO_LEGION_ROOT, 'inspectPayloadRoot 需要 payloadRoot')
  }
  if (!exists(payloadRoot)) {
    return fail(PAYLOAD_CODES.NO_LEGION_ROOT,
      `载荷根不存在：${payloadRoot}（桌面构建应当把产物放在 <stage>/resources/legion）`)
  }
  const entries = []
  const problems = []
  const walk = (dir, prefix) => {
    for (const entry of readdir(dir)) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (prefix === '') entries.push(entry.name)
      // 目录名与文件名分开判：`FORBIDDEN_PAYLOAD_ENTRIES` 里既有目录也有文件。
      const top = relative.split('/')[0]
      if (FORBIDDEN_PAYLOAD_ENTRIES.includes(top) && prefix === '') {
        problems.push(`载荷里出现了不该被打进升级包的东西：${relative}`)
        continue
      }
      if (FORBIDDEN_PAYLOAD_PATTERNS.some((pattern) => pattern.test(relative))) {
        problems.push(`载荷里出现了不该被打进升级包的东西：${relative}`)
        continue
      }
      if (entry.isDirectory()) { walk(absolute, relative); continue }
      if (!entry.isFile()) problems.push(`载荷里有非普通文件（符号链接/设备）：${relative}`)
    }
  }
  walk(payloadRoot, '')

  if (problems.length > 0) {
    return fail(PAYLOAD_CODES.FORBIDDEN_ENTRY, problems[0], { problems: Object.freeze(problems) })
  }
  if (entries.length === 0) {
    return fail(PAYLOAD_CODES.EMPTY, `载荷根是空的：${payloadRoot}`)
  }

  // 目标产品版本清单必须在载荷里，而且版本要与本次发行一致。
  const manifestPath = join(payloadRoot, 'product', 'release', 'runtime-manifest.json')
  if (!exists(manifestPath)) {
    return fail(PAYLOAD_CODES.NO_MANIFEST,
      `载荷里没有目标产品版本清单：${join('product', 'release', 'runtime-manifest.json')}`
      + '（设计 §4 line 76：ZIP 必须包含目标产品版本清单）')
  }
  let manifest
  try { manifest = JSON.parse(readFile(manifestPath)) } catch (error) {
    return fail(PAYLOAD_CODES.NO_MANIFEST, `目标产品版本清单读不出来：${error?.message ?? error}`)
  }
  if (typeof manifest?.productVersion !== 'string' || !isSemver(manifest.productVersion)) {
    return fail(PAYLOAD_CODES.VERSION_MISMATCH, `目标产品版本清单里的 productVersion 不是 SemVer：${JSON.stringify(manifest?.productVersion)}`)
  }
  if (productVersion !== null && manifest.productVersion !== productVersion) {
    return fail(PAYLOAD_CODES.VERSION_MISMATCH,
      `载荷里的 productVersion=${manifest.productVersion} 与本次发行声明的 ${productVersion} 不一致：`
      + '这会让用户"升级到 1.1.0"之后跑着 1.0.9 的代码')
  }
  return Object.freeze({
    ok: true, code: null, reason: null,
    entries: Object.freeze(entries),
    productVersion: manifest.productVersion,
    dshVersion: typeof manifest.dshVersion === 'string' ? manifest.dshVersion : null,
  })
}

/**
 * 从一次已暂存的构建产出升级包（ZIP + 闭包）。
 *
 * @returns {{ok: true, zipPath, zipBytes, zipSha256, closureSha256, closurePath,
 *            fileCount, productVersion} | {ok: false, code, reason}}
 */
export function buildUpgradePayload({
  stageDir = null,
  stageFile = null,
  outDir,
  productVersion = null,
  closureName = CLOSURE_ENTRY_NAME,
  packDirectoryImpl = packDirectory,
  readFile = (path) => readFileSync(path, 'utf8'),
  writeFile = (path, bytes) => writeFileSync(path, bytes),
  exists = existsSync,
  mkdir = (path) => mkdirSync(path, { recursive: true }),
} = {}) {
  if (typeof outDir !== 'string' || outDir === '') return fail(PAYLOAD_CODES.NO_STAGE, 'buildUpgradePayload 需要 outDir')
  const stage = resolveStage({ stageDir, stageFile, readFile })
  if (stage.ok !== true) return stage

  const payloadRoot = join(stage.resources, ...PAYLOAD_RELATIVE_ROOT.slice(1))
  const inspected = inspectPayloadRoot({ payloadRoot, productVersion, readFile, exists })
  if (inspected.ok !== true) return inspected

  const packed = packDirectoryImpl({ root: payloadRoot, closureName })
  if (packed.ok !== true) return fail(PAYLOAD_CODES.PACK_FAILED, packed.reason)

  mkdir(outDir)
  const zipPath = join(outDir, `legion-win-x64.zip`)
  writeFile(zipPath, packed.zipBytes)
  // ★ 回读再算一遍：一次"写出去的内容与想写的不一样"（磁盘满、路径过长、
  //   杀毒隔离）在写的那一刻看起来与成功完全一样。
  const reread = sha256Hex(readFileSync(zipPath))
  const expected = sha256Hex(packed.zipBytes)
  if (reread !== expected) {
    return fail(PAYLOAD_CODES.PACK_FAILED, `写出去之后回读不一致：期望 ${expected}，实际 ${reread}`)
  }

  return Object.freeze({
    ok: true, code: null, reason: null,
    zipPath,
    zipBytes: packed.zipBytes.length,
    zipSha256: expected,
    closurePath: packed.closureName,
    closureSha256: packed.closureSha256,
    closureFileCount: packed.fileCount,
    productVersion: inspected.productVersion,
    dshVersion: inspected.dshVersion,
    payloadRoot,
    entries: inspected.entries,
  })
}

/** 顶层条目的 `{name, bytes}` 清单（发布记录里留档用）。 */
export function payloadEntryStats(payloadRoot, { readdir = (path) => readdirSync(path, { withFileTypes: true }) } = {}) {
  const totals = {}
  const walk = (dir, top) => {
    for (const entry of readdir(dir)) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) { walk(absolute, top ?? entry.name); continue }
      const info = statSync(absolute)
      if (top !== null && top !== undefined) totals[top] = (totals[top] ?? 0) + info.size
    }
  }
  walk(payloadRoot, null)
  return Object.freeze(totals)
}

export function main(argv = process.argv.slice(2)) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  const outDir = args.get('out')
  if (typeof outDir !== 'string' || outDir === 'true') {
    process.stderr.write('update-payload 需要 --out\n')
    return 2
  }
  const result = buildUpgradePayload({
    stageDir: typeof args.get('stage') === 'string' && args.get('stage') !== 'true' ? args.get('stage') : null,
    stageFile: typeof args.get('stage-file') === 'string' && args.get('stage-file') !== 'true' ? args.get('stage-file') : null,
    outDir: resolve(outDir),
    productVersion: typeof args.get('product-version') === 'string' && args.get('product-version') !== 'true'
      ? args.get('product-version') : null,
  })
  if (result.ok !== true) {
    process.stderr.write(`产出升级包失败：${result.reason}\n`)
    return 2
  }
  process.stdout.write(`${JSON.stringify({
    zipPath: result.zipPath,
    zipBytes: result.zipBytes,
    zipSha256: result.zipSha256,
    closurePath: result.closurePath,
    closureSha256: result.closureSha256,
    closureFileCount: result.closureFileCount,
    productVersion: result.productVersion,
    dshVersion: result.dshVersion,
  }, null, 2)}\n`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) process.exitCode = main()

// `sep` 只用于文档化的路径口径，保留导入以免未来有人误用 `/` 拼接。
void sep
