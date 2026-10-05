#!/usr/bin/env node
// scripts/update/verify-install.mjs —— 装完之后核对"这台机器上的 Legion
// 就是那个发行"（设计 §10 验收表第 ①③⑨ 行里**离线可判**的那一半）
// ============================================================================
// 设计 §10 说「测试替身通过不能替代 Windows 真机升级验收」。真机验收里有两类
// 东西：一类**只能在真机上观察**（真的断电、真的文件占用、真的干净机器），
// 另一类是"**在真机上取读数、然后离线判定**"——后者可以也应该做成一条命令，
// 因为"人眼比对两份目录列表"既慢又不可靠。
//
// 这个脚本就是后半类：
//
//   给定① 一份**签过名的发行清单**、② 它指向的升级包 ZIP、③ 一台机器上的
//   **已安装目录**，回答一个问题：
//
//     这台机器上的文件，逐字节就是那个发行里的文件吗？
//
// 它**不写任何东西**（零副作用），只读 + 打印 + 给退出码。理由是：验收动作
// 里"记录证据"必须与"改变被测对象"分开，否则证据本身就成了变量。
//
// ## 它刻意复用而不是重写
//
//   · 发行清单的**签名**与身份  → `envelope.mjs` 的 `verifyEnvelope` + `release.mjs`
//   · 升级包自身的摘要           → 清单里的 `package.sha256`
//   · 包内 `closure.json` 的取出 → `extract.mjs` 的 `resolveClosureEntry`
//     （它同时核对闭包条目的摘要，所以"包里的闭包"不是自证的）
//   · 已装版本                   → `desktop/update-wiring.mjs` 的 `readCurrentVersion`
//
//   ★ 一个"自己再解析一遍 ZIP、自己再验一次签名"的验收脚本，会成为**第二个
//     实现**：它与真客户端对同一份字节给出不同结论的那一天，验收记录就没有
//     意义了。所以这里只把**已经验过的那些函数**串起来。
//
// ## 树比对为什么不用现成的 `verifyExtractedTree`
//
//   `extract.mjs` 的 `verifyExtractedTree()` 判的是**刚解压出来的临时目录**：
//   那个目录里除了载荷不该有任何东西，所以它对"计划之外的条目"一律报错。
//
//   而**已安装目录**多了几样合法的东西（打包时写进去的更新配置、信任表、
//   运行期生成的清单……），它们**不在**载荷闭包覆盖的范围内。直接套用那个函数
//   会把一台装得好好的机器判成失败——一个"永远报错"的验收工具与一个不存在的
//   工具在"它拦住了什么"上是同一个东西。
//
//   所以这里是**另一个判据**：缺项/摘要不符一律失败；多出来的必须逐条落在
//   显式的 `--allow-extra` 里（不写就是"一个都不许多"）。
//   ★ 两条判据之间的关系由用例**对拍**钉住：同一份输入喂给两边，
//     "缺项/摘要不符"必须给同一个结论。见 `verify-install.test.mjs`。
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { createTrustStore, verifyEnvelope, ENVELOPE_FORMATS } from '../../product/update/envelope.mjs'
import { validateRelease } from '../../product/update/release.mjs'
import { readCentralDirectory, resolveClosureEntry } from '../../product/update/extract.mjs'
import { loadTrustStore } from '../../product/update/config.mjs'
import { readCurrentVersion } from '../../desktop/update-wiring.mjs'

export const VERIFY_INSTALL_FORMAT = 'legion/update-install-verify@1'

export const INSTALL_VERIFY_CODES = Object.freeze({
  /** 找不到已安装目录。 */
  NO_INSTALL_ROOT: 'install-verify-no-install-root',
  /** 清单信封验不过。 */
  MANIFEST_UNVERIFIED: 'install-verify-manifest-unverified',
  /** 清单不是一份合法发行。 */
  RELEASE_INVALID: 'install-verify-release-invalid',
  /** 包的字节与清单里的摘要不符。 */
  PACKAGE_DIGEST: 'install-verify-package-digest',
  /** 包里的闭包取不出来。 */
  CLOSURE_UNREADABLE: 'install-verify-closure-unreadable',
  /** 已装目录里有计划之外的条目。 */
  EXTRA: 'install-verify-extra',
  /** 已装目录里少了条目。 */
  MISSING: 'install-verify-missing',
  /** 条目大小不符。 */
  SIZE: 'install-verify-size',
  /** 条目摘要不符。 */
  DIGEST: 'install-verify-digest',
  /** 目录里出现符号链接。 */
  SYMLINK: 'install-verify-symlink',
  /** 读不出来。 */
  UNREADABLE: 'install-verify-unreadable',
  /** 已装版本与期望不符。 */
  VERSION: 'install-verify-version',
  /** 读不出已装版本。 */
  VERSION_UNREADABLE: 'install-verify-version-unreadable',
})

/** 退出码。与其余脚本一样，**非 0 一律表示"这次核对没有通过"**。 */
export const INSTALL_VERIFY_EXIT = Object.freeze({
  ok: 0,
  badArgs: 2,
  treeMismatch: 3,
  versionMismatch: 4,
  sourceProblem: 5,
})

function finding(code, message, path = null) {
  return Object.freeze({ code, message, path })
}

/** 把一串允许的"额外"路径规范化：目录以 `/` 结尾表示"这一整棵子树都允许"。 */
function normalizeAllowExtra(list) {
  return Object.freeze([...list].map((item) => item.replace(/\\/g, '/').replace(/^\.?\//, '')))
}

function isAllowedExtra(relativePath, allowExtra) {
  return allowExtra.some((allowed) => (allowed.endsWith('/')
    ? relativePath.startsWith(allowed)
    : relativePath === allowed))
}

/**
 * 比对**已安装目录**与一份期望闭包。
 *
 * 返回的是**分类后的读数**，不是一串句子——因为验收记录要能回答
 * "失败在哪一类、几条"，而不是"有一堆问题"。这也是它与
 * `verifyExtractedTree()`（返回字符串数组）的另一处不同。
 *
 * `fs` 可注入：自检与用例靠它在内存里造目录树，不去碰真实磁盘。
 */
export function compareInstalledTree({
  installRoot, expected, allowExtra = [],
  readFile = (path) => readFileSync(path),
  readdir = (path) => readdirSync(path, { withFileTypes: true }),
  stat = (path) => statSync(path),
}) {
  const root = resolve(installRoot)
  const allowed = normalizeAllowExtra(allowExtra)
  const byPath = new Map(expected.map((item) => [item.path, item]))
  const findings = []
  const seen = new Set()

  const walk = (dir, prefix) => {
    let entries
    try { entries = readdir(dir) } catch (error) {
      findings.push(finding(INSTALL_VERIFY_CODES.UNREADABLE, `读不到目录：${error?.message ?? error}`, prefix || '/'))
      return
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink?.() === true) {
        findings.push(finding(INSTALL_VERIFY_CODES.SYMLINK, `已安装目录里出现符号链接：${relative}`, relative))
        continue
      }
      if (entry.isDirectory()) { walk(join(dir, entry.name), relative); continue }
      seen.add(relative)
      const expectedEntry = byPath.get(relative)
      if (expectedEntry === undefined) {
        if (!isAllowedExtra(relative, allowed)) {
          findings.push(finding(INSTALL_VERIFY_CODES.EXTRA, `已安装目录里有发行之外的条目：${relative}`, relative))
        }
        continue
      }
      let info
      let bytes
      try {
        info = stat(join(dir, entry.name))
        bytes = readFile(join(dir, entry.name))
      } catch (error) {
        findings.push(finding(INSTALL_VERIFY_CODES.UNREADABLE, `读不到文件：${error?.message ?? error}`, relative))
        continue
      }
      if (Number.isSafeInteger(expectedEntry.bytes) && info.size !== expectedEntry.bytes) {
        findings.push(finding(INSTALL_VERIFY_CODES.SIZE,
          `大小不符：期望 ${expectedEntry.bytes}，实际 ${info.size}`, relative))
        continue
      }
      if (typeof expectedEntry.sha256 === 'string') {
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== expectedEntry.sha256) {
          findings.push(finding(INSTALL_VERIFY_CODES.DIGEST, '摘要不符（文件被改过或装错了版本）', relative))
        }
      }
    }
  }
  walk(root, '')

  for (const item of expected) {
    if (!seen.has(item.path)) {
      findings.push(finding(INSTALL_VERIFY_CODES.MISSING, '发行里有这个条目，已安装目录里没有', item.path))
    }
  }

  const frozen = Object.freeze(findings)
  return Object.freeze({
    ok: frozen.length === 0,
    findings: frozen,
    /** 分类计数：验收记录要能一眼看出"失败在哪一类"。 */
    counts: Object.freeze({
      extra: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.EXTRA).length,
      missing: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.MISSING).length,
      size: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.SIZE).length,
      digest: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.DIGEST).length,
      symlink: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.SYMLINK).length,
      unreadable: frozen.filter((f) => f.code === INSTALL_VERIFY_CODES.UNREADABLE).length,
    }),
    compared: expected.length,
    /** 路径最外层是哪个目录——填验收记录时用它说明"核对了什么"。 */
    topLevel: Object.freeze([...new Set(expected.map((item) => item.path.split('/')[0]))].sort()),
  })
}

/**
 * 从一份**签过名的发行清单** + 包 ZIP 推出期望闭包。
 *
 * ★ 顺序是刻意的：**先验签、再验身份、再验包的摘要、最后才取闭包**。
 *   反过来（先取闭包再验签）会让"包被人换过"这件事在取出闭包之后才被发现，
 *   而那时闭包已经被用来判定了。
 */
export function expectedClosureFromRelease({
  manifestBytes, packageBytes, trustStore, nowMs = Date.now(),
}) {
  const verified = verifyEnvelope(manifestBytes, {
    trust: trustStore, nowMs, expectedFormat: ENVELOPE_FORMATS.RELEASE,
  })
  if (!verified.ok) {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.MANIFEST_UNVERIFIED,
      reason: `发行清单验签失败：${verified.code} ${verified.reason}`, files: null, release: null,
    })
  }
  const validated = validateRelease(verified.payload)
  if (!validated.ok) {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.RELEASE_INVALID,
      reason: `发行清单不合法：${validated.reason}`, files: null, release: null,
    })
  }
  const release = validated.release
  const pkg = release.package
  if (pkg === null || typeof pkg !== 'object') {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.RELEASE_INVALID,
      reason: '发行清单里没有 package 产物', files: null, release,
    })
  }
  const packageDigest = createHash('sha256').update(packageBytes).digest('hex')
  if (packageDigest !== pkg.sha256) {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.PACKAGE_DIGEST,
      reason: `升级包的摘要与清单不符（清单 ${String(pkg.sha256).slice(0, 12)}…，实际 ${packageDigest.slice(0, 12)}…）`,
      files: null, release,
    })
  }
  if (typeof pkg.closurePath !== 'string' || typeof pkg.closureSha256 !== 'string') {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.CLOSURE_UNREADABLE,
      reason: '这份发行没有带闭包（`package.closurePath` / `closureSha256` 缺失）——'
        + '那么"装完之后对不对"就没有一个可信的对照物',
      files: null, release,
    })
  }
  const directory = readCentralDirectory(packageBytes)
  const resolved = resolveClosureEntry(packageBytes, directory.entries,
    { path: pkg.closurePath, sha256: pkg.closureSha256 })
  if (resolved.ok !== true) {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.CLOSURE_UNREADABLE,
      reason: `从包里取闭包失败：${resolved.reason}`, files: null, release,
    })
  }
  return Object.freeze({
    ok: true, code: null, reason: null, files: resolved.files, release,
    packageDigest, closureDigest: resolved.sha256,
  })
}

/**
 * 跑一次完整的"装完之后核对"。**只读**。
 *
 * @returns 一份可以原样填进验收记录的报告
 */
export function planInstallVerification({
  installRoot, manifestBytes, packageBytes, trustStore,
  expectVersion = null, allowExtra = [], nowMs = Date.now(),
  readFile = (path) => readFileSync(path),
  readdir = (path) => readdirSync(path, { withFileTypes: true }),
  stat = (path) => statSync(path),
  ensureRoot = (path) => { statSync(path); return true },
}) {
  let rootOk = true
  try { ensureRoot(resolve(installRoot)) } catch { rootOk = false }
  if (!rootOk) {
    return Object.freeze({
      ok: false, code: INSTALL_VERIFY_CODES.NO_INSTALL_ROOT,
      reason: `找不到已安装目录：${installRoot}`, tree: null, version: null, release: null,
    })
  }

  const expected = expectedClosureFromRelease({ manifestBytes, packageBytes, trustStore, nowMs })
  if (expected.ok !== true) {
    return Object.freeze({
      ok: false, code: expected.code, reason: expected.reason,
      tree: null, version: null, release: null,
    })
  }

  const tree = compareInstalledTree({
    installRoot, expected: expected.files, allowExtra, readFile, readdir, stat,
  })

  // 版本读数：**期望给定时才读**（不给就不猜）。
  let version = Object.freeze({ checked: false, expected: null, actual: null, ok: true, reason: null })
  if (expectVersion !== null) {
    const actual = readCurrentVersion(resolve(installRoot), { readFileImpl: (path) => readFile(path) })
    if (actual === null) {
      version = Object.freeze({
        checked: true, expected: expectVersion, actual: null, ok: false,
        reason: '读不出已安装版本（运行期清单缺失或损坏）——'
          + '而"读不出来"与"版本对"不是同一个读数，所以这一条判失败',
      })
    } else {
      version = Object.freeze({
        checked: true, expected: expectVersion, actual, ok: actual === expectVersion,
        reason: actual === expectVersion ? null : `已安装版本是 ${actual}，期望 ${expectVersion}`,
      })
    }
  }

  const ok = tree.ok && version.ok
  const firstProblem = tree.ok ? null : tree.findings[0]
  return Object.freeze({
    ok,
    code: tree.ok ? (version.ok ? null : (version.actual === null
      ? INSTALL_VERIFY_CODES.VERSION_UNREADABLE : INSTALL_VERIFY_CODES.VERSION))
      : firstProblem.code,
    reason: tree.ok ? version.reason : `${firstProblem.message}（${firstProblem.path ?? ''}）`,
    release: Object.freeze({
      releaseId: expected.release.releaseId,
      productVersion: expected.release.productVersion,
      channel: expected.release.channel,
      packageDigest: expected.packageDigest,
      closureDigest: expected.closureDigest,
    }),
    tree, version,
  })
}

/** 渲染成人读的报告（会原样进验收记录，所以不省略计数）。 */
export function renderInstallVerification(report) {
  const lines = ['更新安装核对（设计 §10 第 ①③⑨ 行的离线可判部分）', '']
  if (report.release !== null && report.release !== undefined) {
    lines.push(`  发行：${report.release.releaseId}（产品版本 ${report.release.productVersion}，通道 ${report.release.channel}）`)
    lines.push(`  升级包摘要：${String(report.release.packageDigest).slice(0, 16)}…`)
    lines.push(`  闭包摘要：  ${String(report.release.closureDigest).slice(0, 16)}…`)
  }
  if (report.tree !== null && report.tree !== undefined) {
    lines.push(`  比对了 ${report.tree.compared} 个条目，涉及顶层目录：${report.tree.topLevel.join(', ') || '(无)'}`)
    const c = report.tree.counts
    lines.push(`  差异：多出 ${c.extra}｜缺失 ${c.missing}｜大小 ${c.size}｜摘要 ${c.digest}｜符号链接 ${c.symlink}｜读不到 ${c.unreadable}`)
    for (const f of report.tree.findings.slice(0, 20)) {
      lines.push(`    ${f.code}  ${f.path ?? ''}  ${f.message}`)
    }
    if (report.tree.findings.length > 20) {
      lines.push(`    …（还有 ${report.tree.findings.length - 20} 条，用 --json 取全量）`)
    }
  }
  if (report.version !== null && report.version !== undefined && report.version.checked) {
    lines.push(`  版本：期望 ${report.version.expected}，实际 ${report.version.actual ?? '(读不出)'}`)
  }
  lines.push('')
  lines.push(report.ok ? '  结论：**一致**——这台机器上的文件逐字节就是那个发行。'
    : `  结论：**不一致** —— ${report.reason}`)
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 内存里的一个目录树（供自检用，**不碰磁盘**）。
 *
 * ★ 写它的时候我第一版是错的：我用"路径结尾匹配"去认文件，于是
 *   `readdir` 与 `stat` 各自猜出了一套不相干的东西，四条探针**全部**
 *   报成"缺失"。判据没坏，替身坏了——而那四条探针当时看起来"都对地失败了"。
 *
 *   > 一个坏掉的替身，会让"判据全都正确地报错"与"判据根本没跑起来"
 *   > 长得一模一样。
 *
 *   所以现在按**相对根目录**严格解析：`relOf()` 用一个已解析的根做前缀，
 *   认不出来就抛错（而不是返回一个默认值）。
 */
function fakeTree(rootPath, files) {
  const root = resolve(rootPath)
  const relOf = (path) => {
    const abs = resolve(path)
    if (abs === root) return ''
    if (!abs.startsWith(root + sep)) throw new Error(`不在替身根目录之下：${path}`)
    return abs.slice(root.length + 1).split(sep).join('/')
  }
  // relDir（'' 表示根）→ Map<名字, 是不是目录>
  // ★ 根目录**一开始就要在表里**：一个"存在但空"的目录必须能列成 `[]`，
  //   而不是"列不出来"。这两件事在判据上是不同的结论——前者落到 MISSING
  //   （发行里的条目全都缺失），后者落到 UNREADABLE（这个目录读不到）。
  const dirs = new Map([['', new Map()]])
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 0; i < parts.length; i += 1) {
      const dirRel = parts.slice(0, i).join('/')
      if (!dirs.has(dirRel)) dirs.set(dirRel, new Map())
      dirs.get(dirRel).set(parts[i], i < parts.length - 1)
    }
  }
  return {
    readdir: (path) => {
      const listing = dirs.get(relOf(path))
      if (listing === undefined) throw new Error(`替身里没有这个目录：${path}`)
      return [...listing.entries()].map(([name, isDir]) => ({
        name, isDirectory: () => isDir, isSymbolicLink: () => false,
      }))
    },
    stat: (path) => {
      const file = files[relOf(path)]
      if (file === undefined) throw new Error(`替身里没有这个文件：${path}`)
      return { size: file.length }
    },
    readFile: (path) => {
      const file = files[relOf(path)]
      if (file === undefined) throw new Error(`替身里没有这个文件：${path}`)
      return file
    },
  }
}

export function selfCheckVerifyInstall() {
  const problems = []
  const ROOT = join('C:', 'fake-install')
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  const good = Object.freeze({ path: 'a.txt', bytes: 3, sha256: sha('abc') })

  // ① 一致时必须通过（否则下面几条"不一致"只是"什么都拒"）。
  const hit = fakeTree(ROOT, { 'a.txt': Buffer.from('abc') })
  const okTree = compareInstalledTree({ installRoot: ROOT, expected: [good], ...hit })
  if (!okTree.ok) problems.push(`一致的树被判失败：${JSON.stringify(okTree.findings)}`)
  if (okTree.counts.digest !== 0 || okTree.counts.missing !== 0) problems.push('一致时计数不为 0')

  // ② 摘要不符必须失败，且码是 DIGEST。
  const bad = compareInstalledTree({
    installRoot: ROOT, expected: [good], ...fakeTree(ROOT, { 'a.txt': Buffer.from('abd') }),
  })
  if (bad.ok || bad.findings[0]?.code !== INSTALL_VERIFY_CODES.DIGEST) {
    problems.push(`摘要不符没有被判成 ${INSTALL_VERIFY_CODES.DIGEST}：${JSON.stringify(bad.findings)}`)
  }

  // ③ 多出来的条目默认必须失败；写进 allowExtra 就放过（两种写法各验一次）。
  const extraFiles = { 'a.txt': Buffer.from('abc'), 'extra.log': Buffer.from('x') }
  const extraBad = compareInstalledTree({ installRoot: ROOT, expected: [good], ...fakeTree(ROOT, extraFiles) })
  if (extraBad.ok || extraBad.counts.extra !== 1) {
    problems.push(`多出来的条目没有被判成 EXTRA：${JSON.stringify(extraBad.findings)}`)
  }
  for (const allow of [['extra.log'], ['sub/']]) {
    const files = allow[0] === 'sub/'
      ? { 'a.txt': Buffer.from('abc'), 'sub/deep.log': Buffer.from('x') }
      : extraFiles
    const allowed = compareInstalledTree({ installRoot: ROOT, expected: [good], allowExtra: allow, ...fakeTree(ROOT, files) })
    if (!allowed.ok) problems.push(`allowExtra=${JSON.stringify(allow)} 里的条目仍然被判失败：${JSON.stringify(allowed.findings)}`)
  }

  // ④ 缺失必须失败。
  const missing = compareInstalledTree({ installRoot: ROOT, expected: [good], ...fakeTree(ROOT, {}) })
  if (missing.ok || missing.findings[0]?.code !== INSTALL_VERIFY_CODES.MISSING) {
    problems.push('缺失的条目没有被判成 MISSING')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: VERIFY_INSTALL_FORMAT,
    codes: Object.keys(INSTALL_VERIFY_CODES).length,
    sample: Object.freeze({ compared: okTree.compared, counts: okTree.counts }),
  })
}

export const VERIFY_INSTALL_CHECKED = selfCheckVerifyInstall()

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 与 `publish.mjs` / `verify-host.mjs` / `host-config.mjs` 逐字一致的参数解析。 */
function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const installRoot = typeof args.get('install-root') === 'string' ? args.get('install-root') : null
  const manifestPath = typeof args.get('manifest') === 'string' ? args.get('manifest') : null
  const packagePath = typeof args.get('package') === 'string' ? args.get('package') : null
  const trustPath = typeof args.get('trust') === 'string' ? args.get('trust') : null
  if (installRoot === null || manifestPath === null || packagePath === null || trustPath === null) {
    process.stderr.write('verify-install 需要 --install-root、--manifest、--package、--trust 四个参数\n'
      + '（缺任何一个都会让"核对"退化成"自己说自己对"：没有签名清单就没有可信的对照物）\n')
    return INSTALL_VERIFY_EXIT.badArgs
  }

  const loaded = loadTrustStore(trustPath)
  if (loaded.entries.length === 0) {
    process.stderr.write(`信任表里没有可用公钥：${trustPath}（${loaded.reason ?? ''}）\n`)
    return INSTALL_VERIFY_EXIT.badArgs
  }
  const allowExtra = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--allow-extra' && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) {
      allowExtra.push(argv[i + 1])
    }
  }

  let report
  try {
    report = planInstallVerification({
      installRoot,
      manifestBytes: readFileSync(manifestPath),
      packageBytes: readFileSync(packagePath),
      trustStore: createTrustStore(loaded.entries),
      expectVersion: typeof args.get('expect-version') === 'string' ? args.get('expect-version') : null,
      allowExtra,
    })
  } catch (error) {
    process.stderr.write(`核对时出错：${error?.message ?? error}\n`)
    return INSTALL_VERIFY_EXIT.sourceProblem
  }

  if (args.get('json') === true) process.stdout.write(`${JSON.stringify(report)}\n`)
  else process.stdout.write(renderInstallVerification(report))

  if (report.ok) return INSTALL_VERIFY_EXIT.ok
  // 区分"树的差异"与"版本不符"：它们的处置不同（前者要看包与安装，后者要看清单）。
  if (report.code === INSTALL_VERIFY_CODES.VERSION || report.code === INSTALL_VERIFY_CODES.VERSION_UNREADABLE) {
    return INSTALL_VERIFY_EXIT.versionMismatch
  }
  if ([INSTALL_VERIFY_CODES.MANIFEST_UNVERIFIED, INSTALL_VERIFY_CODES.RELEASE_INVALID,
    INSTALL_VERIFY_CODES.PACKAGE_DIGEST, INSTALL_VERIFY_CODES.CLOSURE_UNREADABLE].includes(report.code)) {
    return INSTALL_VERIFY_EXIT.sourceProblem
  }
  return INSTALL_VERIFY_EXIT.treeMismatch
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly && process.argv[1].endsWith('verify-install.mjs')) {
  process.exitCode = main()
}

