#!/usr/bin/env node
// scripts/release/version.mjs —— 桌面端版本号的**唯一入口**（T-197）
// ============================================================================
// ## 它解决的是哪一个具体问题
//
// 打包时版本号住在**两个互相独立**的地方，而在本工具之前**没有任何东西强制
// 它们相等**：
//
//   · `desktop/package.json` 的 `version`  → 决定安装包**文件名**
//     （`build.mjs` 的 `artifactName: Legion-${version}-internal-${arch}-setup.exe`）
//   · `product/release/runtime-manifest.json` 的 `productVersion` / `legionVersion`
//     → 进入发布清单（`stage.mjs` 把它读成 `release`，写进 `desktop-release.json`）
//
// 实测（2026-10-10，线上两台发布）就是这个形态：
//
//     r-2026-10-06_0.1.0   装机包 204,582,159 字节
//     r-2026-10-07_0.1.0   装机包 204,641,180 字节   ← 不同构建、不同字节
//     两次的 productVersion **都是 0.1.0**
//
// 两次发布的**字节不同**，而版本号**没变**。区分只能靠 `releaseId` 里的日期。
//
//   > 一个"版本号没变、字节变了"的发布，
//   > 与一个"版本号变了"的发布，在升级判据（`upgradedWindow` /
//   > `supportedFromVersions`）眼里是同一个东西——
//   > 只不过前者会让用户装到一个他以为已经装过的版本。
//
// 设计稿 §4 对 `releaseId` 的要求恰恰是「同版本不同字节也必须使用不同 releaseId」——
// 也就是说这个形态**被设计预见过**，但没有任何机器判据把它钉住。
//
// ## 三个子命令
//
//   check   两处是否一致（**默认命令**，也是 CI 判据）
//   show    打印当前版本与它的**逐字段来源**（哪些是从仓库常量推出来的）
//   bump    改版本：**一处输入 → 同时改两处**
//
// ## 版本号怎么定：手动优先，可选从 DSH 派生
//
//   --to 0.2.0              手动指定（**默认方式**）
//   --from-dsh              从 runtime-manifest.json 的 dshVersion 派生
//   --dsh 0.8.3             指定 DSH 版本，并同时把它写进清单
//
// 派生规则是**显式**的、写在 `deriveProductVersion()` 里，不是一个藏在
// `??` 后面的隐式默认值——因为"版本号从哪来"必须能被读出来（见 `show`）。
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANIFEST_FIELD_SOURCES, RUNTIME_MANIFEST_CODES,
  SHIPPED_MANIFEST_RELATIVE_PATH, buildVersionManifest, deriveManifestFields,
  renderVersionManifest,
} from '../../product/launcher/runtime-manifest.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 两处版本号的载体。**只有这两个**——多一个就多一处会漂的地方。 */
export const VERSION_SOURCES = Object.freeze({
  desktopPackage: 'desktop/package.json',
  runtimeManifest: SHIPPED_MANIFEST_RELATIVE_PATH,
})

export const VERSION_CODES = Object.freeze({
  MISMATCH: 'version-mismatch',
  NOT_SEMVER: 'version-not-semver',
  BAD_INPUT: 'version-bad-input',
  MANIFEST_INVALID: 'version-manifest-invalid',
  FILE_UNREADABLE: 'version-file-unreadable',
})

/**
 * SemVer 判据（与 `product/upgrade/manifest.mjs` 的 `parseVersion` 同口径）。
 *
 * 不引进 `semver` 包：本仓零第三方运行时依赖，而这个判据只用到
 * `major.minor.patch` 与可选的预发布段。
 */
export function isSemver(value) {
  return typeof value === 'string'
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

function unreadable(path, error) {
  return Object.freeze({
    ok: false, code: VERSION_CODES.FILE_UNREADABLE,
    message: `${path} 读不出来：${error?.message ?? error}`,
  })
}

/** 读一处版本载体。**不抛**。 */
export function readVersionSources({ root = ROOT, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const problems = []
  let desktopRaw = null
  let manifestRaw = null
  try {
    desktopRaw = JSON.parse(readFile(join(root, VERSION_SOURCES.desktopPackage)))
  } catch (error) {
    problems.push(unreadable(VERSION_SOURCES.desktopPackage, error))
  }
  try {
    manifestRaw = JSON.parse(readFile(join(root, VERSION_SOURCES.runtimeManifest)))
  } catch (error) {
    problems.push(unreadable(VERSION_SOURCES.runtimeManifest, error))
  }
  if (problems.length > 0) {
    return Object.freeze({
      ok: false,
      code: problems[0].code,
      problems: Object.freeze(problems),
      // ★ 顶层也要有 `message`。只把说明放在 `problems[]` 里，
      //   调用方（含 CLI）拿到的是 `undefined` —— 而那与"没报错"长得一样。
      message: problems.map((p) => p.message).join('；'),
    })
  }
  return Object.freeze({
    ok: true,
    desktopPackage: desktopRaw,
    runtimeManifest: manifestRaw,
    desktopVersion: desktopRaw.version,
    productVersion: manifestRaw.productVersion,
    legionVersion: manifestRaw.legionVersion,
    dshVersion: manifestRaw.dshVersion,
    channel: manifestRaw.channel,
  })
}

/** 从 DSH 版本派生产品版本：**显式规则**，不是隐式默认。 */
export function deriveProductVersion(dshVersion) {
  // 规则：取 DSH 的 `major.minor`，patch 归零。
  //   例：`0.1.5-rc.2` → `0.1.0`；`0.8.3` → `0.8.0`。
  //
  // 为什么是 major.minor 而不是原样照抄：产品版本要能独立于上游 RC 抖动
  // 往前走（同一份产品可能换一个 DSH 补丁版本而自身不改行为）。
  // 这条规则一旦要改，改的是**这里**，并且 `show` 会把它打出来。
  const m = /^(\d+)\.(\d+)\./.exec(String(dshVersion ?? ''))
  if (m === null) return Object.freeze({ ok: false, code: VERSION_CODES.BAD_INPUT, message: `无法从 ${JSON.stringify(dshVersion)} 派生产品版本（需要 major.minor）` })
  return Object.freeze({ ok: true, productVersion: `${m[1]}.${m[2]}.0`, rule: 'DSH 的 major.minor + patch 归零' })
}

/**
 * 核对两处一致 —— **CI 判据**，也是 `check` 子命令的全部内容。
 *
 * 为什么要核"相等"而不是"哪个优先"：两处都可以单独被改（一个是 JSON 字段、
 * 一个是 npm 字段），而只改一处的**表现**是"安装包叫 0.2.0、清单里写着 0.1.0"——
 * 文件名与升级判据各说各话，且两处都语法合法。
 */
export function checkVersions({ root = ROOT, readFile } = {}) {
  const src = readVersionSources({ root, ...(readFile ? { readFile } : {}) })
  if (src.ok !== true) return src
  const problems = []

  for (const [label, value] of [
    ['desktop/package.json 的 version', src.desktopVersion],
    ['runtime-manifest.json 的 productVersion', src.productVersion],
    ['runtime-manifest.json 的 legionVersion', src.legionVersion],
  ]) {
    if (!isSemver(value)) {
      problems.push({ field: label, code: VERSION_CODES.NOT_SEMVER, value })
    }
  }

  if (src.desktopVersion !== src.productVersion || src.productVersion !== src.legionVersion) {
    problems.push({
      field: '两处版本号',
      code: VERSION_CODES.MISMATCH,
      desktop: src.desktopVersion,
      product: src.productVersion,
      legion: src.legionVersion,
    })
  }

  if (problems.length > 0) {
    const detail = problems.map((p) => {
      if (p.code === VERSION_CODES.MISMATCH) {
        return `  · 版本号不一致：${VERSION_SOURCES.desktopPackage}=${p.desktop}、`
          + `${VERSION_SOURCES.runtimeManifest}.productVersion=${p.product}、`
          + `.legionVersion=${p.legion}`
      }
      return `  · ${p.field} 不是 SemVer：${JSON.stringify(p.value)}`
    }).join('\n')
    return Object.freeze({
      ok: false,
      code: problems[0].code,
      problems: Object.freeze(problems),
      message: `版本号不自洽（${problems.length} 项）：\n${detail}\n`
        + '  修法：`node scripts/release/version.mjs bump --to <x.y.z>` 一次改两处。\n'
        + '  只改一处会让安装包文件名与升级判据各说各话——而两处都语法合法，不会报错。',
      sources: src,
    })
  }

  return Object.freeze({
    ok: true, code: null, sources: src,
    message: `版本号自洽：产品/Legion ${src.productVersion}（DSH ${src.dshVersion}，通道 ${src.channel}）`,
  })
}

/**
 * 改版本：**一处输入 → 同时改两处**。
 *
 * @param {{ to?: string, fromDsh?: boolean, dsh?: string, channel?: string, root?: string, dryRun?: boolean }} args
 * @returns 结果对象（`dryRun` 时不落盘）
 */
export function bumpVersion({
  to = null, fromDsh = false, dsh = null, channel = null, root = ROOT, dryRun = false,
} = {}) {
  const src = readVersionSources({ root })
  if (src.ok !== true) return src

  const nextDsh = dsh ?? src.dshVersion
  let nextVersion = to
  let rule = '手动指定（--to）'
  if (nextVersion === null && fromDsh) {
    const derived = deriveProductVersion(nextDsh)
    if (derived.ok !== true) return derived
    nextVersion = derived.productVersion
    rule = derived.rule
  }
  if (nextVersion === null) {
    return Object.freeze({
      ok: false, code: VERSION_CODES.BAD_INPUT,
      message: 'bump 需要 `--to <x.y.z>`（手动）或 `--from-dsh`（从 dshVersion 派生）',
    })
  }
  if (!isSemver(nextVersion)) {
    return Object.freeze({ ok: false, code: VERSION_CODES.NOT_SEMVER, message: `--to 不是 SemVer：${JSON.stringify(nextVersion)}` })
  }

  // ★ 用生产组装器**校验**这一版清单，而不是自己拼一个 JSON。
  //   这样"改版本"与"发版本"走同一套判据：`validateManifest` +
  //   补丁层版本的交叉验证（`checkPatchVersionAgainstRepo`）。
  const built = buildVersionManifest({
    productVersion: nextVersion,
    legionVersion: nextVersion,
    dshVersion: nextDsh,
    schemaVersion: src.runtimeManifest.schemaVersion,
    channel: channel ?? src.channel,
    releasedAt: src.runtimeManifest.releasedAt ?? null,
  })
  if (built.ok !== true) {
    return Object.freeze({
      ok: false, code: VERSION_CODES.MANIFEST_INVALID, problems: built.problems ?? null,
      message: `新清单没通过生产校验器：${built.message}`,
    })
  }

  const manifestText = renderVersionManifest(built)
  if (manifestText === '') {
    return Object.freeze({ ok: false, code: VERSION_CODES.MANIFEST_INVALID, message: 'renderVersionManifest 返回空串' })
  }
  const desktopPkg = { ...src.desktopPackage, version: nextVersion }
  const desktopText = `${JSON.stringify(desktopPkg, null, 2)}\n`

  const changes = [
    { path: VERSION_SOURCES.desktopPackage, from: src.desktopVersion, to: nextVersion },
    { path: `${VERSION_SOURCES.runtimeManifest}（productVersion/legionVersion）`, from: src.productVersion, to: nextVersion },
  ]
  if (nextDsh !== src.dshVersion) {
    changes.push({ path: `${VERSION_SOURCES.runtimeManifest}（dshVersion）`, from: src.dshVersion, to: nextDsh })
  }

  if (!dryRun) {
    writeFileSync(join(root, VERSION_SOURCES.desktopPackage), desktopText)
    writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), manifestText)
  }

  return Object.freeze({
    ok: true,
    code: null,
    dryRun,
    productVersion: nextVersion,
    dshVersion: nextDsh,
    rule,
    changes: Object.freeze(changes.map((c) => Object.freeze(c))),
    message: `${dryRun ? '（dry-run，未落盘）' : ''}版本 ${src.productVersion} → ${nextVersion}`
      + `（DSH ${src.dshVersion}→${nextDsh}，${rule}）；同时改了 ${changes.length} 处`,
  })
}

/** `show` 子命令：把"这个版本号从哪来"逐字段打出来。 */
export function describeVersions({ root = ROOT } = {}) {
  const src = readVersionSources({ root })
  if (src.ok !== true) return src
  const derived = deriveManifestFields()
  return Object.freeze({
    ok: true,
    sources: src,
    derived,
    fieldSources: MANIFEST_FIELD_SOURCES,
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = new Map()
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { positional.push(token); continue }
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return { args, positional }
}

/** 取参数并清洗（CRLF 管道会把 CR 带进来——见 T-196 的同一条教训）。 */
function argString(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return cleaned === '' ? null : cleaned
}

const invokedDirectly = process.argv[1] !== undefined
  && /version\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))

if (invokedDirectly) {
  const { args, positional } = parseArgs(process.argv.slice(2))
  const command = positional[0] ?? 'check'
  const root = argString(args.get('root')) ?? ROOT

  if (command === 'check') {
    const r = checkVersions({ root })
    process.stdout.write(`${r.ok ? '✔' : '✖'} ${r.message}\n`)
    process.exit(r.ok ? 0 : 1)
  }

  if (command === 'show') {
    const r = describeVersions({ root })
    if (r.ok !== true) { process.stderr.write(`✖ ${r.message}\n`); process.exit(1) }
    process.stdout.write(`产品版本（productVersion/legionVersion）= ${r.sources.productVersion}\n`)
    process.stdout.write(`  载体 1：${VERSION_SOURCES.desktopPackage} 的 version = ${r.sources.desktopVersion}\n`)
    process.stdout.write(`  载体 2：${VERSION_SOURCES.runtimeManifest}（productVersion/legionVersion）\n`)
    process.stdout.write(`DSH 版本 = ${r.sources.dshVersion}（发布决定，仓库里没有权威来源）\n`)
    process.stdout.write(`通道 = ${r.sources.channel}\n\n`)
    process.stdout.write('八个字段各自的来源：\n')
    for (const f of r.fieldSources) {
      const how = f.derivable
        ? `推出来（${f.source}）`
        : '**由发布流程给**（仓库里没有权威来源）'
      process.stdout.write(`  ${f.field.padEnd(30)} ${how}\n`)
    }
    process.stdout.write(`\n本次从仓库常量推出来的值：${JSON.stringify(r.derived)}\n`)
    process.exit(0)
  }

  if (command === 'bump') {
    const r = bumpVersion({
      to: argString(args.get('to')),
      fromDsh: args.get('from-dsh') === 'true',
      dsh: argString(args.get('dsh')),
      channel: argString(args.get('channel')),
      root,
      dryRun: args.get('dry-run') === 'true',
    })
    if (r.ok !== true) { process.stderr.write(`✖ ${r.message}\n`); process.exit(1) }
    for (const c of r.changes) process.stdout.write(`  ${c.path}：${c.from} → ${c.to}\n`)
    process.stdout.write(`✔ ${r.message}\n`)
    if (!r.dryRun) {
      const after = checkVersions({ root })
      process.stdout.write(`${after.ok ? '✔' : '✖'} 改完后复核：${after.message}\n`)
      process.exit(after.ok ? 0 : 1)
    }
    process.exit(0)
  }

  process.stderr.write(`未知子命令：${command}（可用：check / show / bump）\n`)
  process.exit(2)
}
