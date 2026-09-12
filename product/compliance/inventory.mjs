// product/compliance/inventory.mjs
// ============================================================================
// PRT-901 / PRT-902：第三方组件清单与 SBOM，以及**商业分发条件**。
//
// spec §10 line 745：
//   「提供第三方组件清单和 SBOM，确认 DSH 及所有依赖的商业使用与分发条件。」
//
// ## 为什么"从 package.json 生成 SBOM"在这里是不够的
//
// 本仓库**没有根 package.json**，依赖分散在 7 个 workspace 清单里。而其中一份清单
// 属于一棵**被跟踪的 vendored 第三方源码树**——`.skills-cache/` 下 499 个文件，
// 自带 `package.json`（15 运行时依赖 + 10 开发依赖，MIT）。
//
// ⚠️ 这里要写准确，因为**第一版的注释写错了**：那棵树**是**有清单的，所以
// "只读清单"的 SBOM **会**把它扫进来。它漏掉的是另一种情况——
//
//   · vendored 的**源码树没有清单**（拷进来的代码常常没有 package.json）；
//   · 源码树落在 `SCAN_SKIP_DIRS` 里的目录下（`docs/` 与 `scratch/` 都被跳过，
//     而本仓库的 `docs/T042-evidence/` 里就放了别的项目的采集副本）。
//
//   > 一个「从各 workspace 的 package.json 依赖生成的 SBOM」，
//   > 与一个「只覆盖了"恰好带清单的那些"第三方代码」的 SBOM，是同一个东西——
//   > 只不过前者看起来是完整的。
//
// 所以本模块**两个来源都收**：清单里声明的依赖，加上调用方注入的
// **磁盘上实际存在的** vendored 源码树。而"哪些目录是 vendored"不能从清单推出来，
// 必须由调用方给——否则本模块就只是在复述那几张清单。
//
// ⚠️ **同一条代码被两个来源都看见时必须只算一次**。`.skills-cache/main/teamai-cli-main`
// 既是一棵 vendored 树、又有一份清单。第一版两处都记了一个组件，于是
// `distributionReport` 把同一个 MIT 组件数了两次（`permissive: 2`）。
//
//   > 一个「同一份代码在报表里出现两次、于是"覆盖了 2 个宽松许可组件"」的 SBOM，
//   > 与一个「其实只有 1 个」的 SBOM，是同一个东西——只不过前者让人以为覆盖面更大。
//
// ## 为什么"缺 license 字段"是一条要报出来的项
//
// spec 要的是"确认**商业使用与分发条件**"。一个没有 `license` 字段的包，
// 它的分发条件**是未知的**——而未知不是"没问题"：
//
//   > 一个「清单里没有 license 字段、于是被跳过」的 SBOM，
//   > 与一个「分发条件未知、但报表上什么都没提」的 SBOM，是同一个东西——
//   > 只不过前者看起来没有发现任何问题。
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** SBOM 格式版本。改动字段语义时递增。 */
export const SBOM_VERSION = 'legion/sbom@1'

/** 本模块自己的版本（与 SBOM 格式版本分开：换了扫描规则不等于换了格式）。 */
export const INVENTORY_VERSION = 1

export const INVENTORY_FINDINGS = Object.freeze({
  /** 组件没有 `license` 字段 → 分发条件未知。 */
  LICENSE_UNKNOWN: 'inventory-license-unknown',
  /** vendored 源码树没有被任何清单覆盖。 */
  VENDORED_UNCOVERED: 'inventory-vendored-uncovered',
  /** 清单声明的依赖与磁盘上的实际安装不一致。 */
  DECLARED_NOT_INSTALLED: 'inventory-declared-not-installed',
  /** 声明了依赖但整个扫描面里一个清单都没有。 */
  NO_MANIFESTS: 'inventory-no-manifests',
})

/** 扫描时要跳过的目录：它们不是**随产品分发**的内容。 */
export const SCAN_SKIP_DIRS = Object.freeze([
  'node_modules', '.git', '.ci', '.worktrees', 'docs', 'scratch',
])

/**
 * 收集仓库里的所有 `package.json`（**排除** `node_modules` 等）。
 *
 * @param {string} root
 * @param {{listDir?: (dir: string) => Array<{name: string, isDirectory: () => boolean}>, readText?: (p: string) => string}} [io]
 *   可注入，理由见文件头：不可注入时本函数无法在测试里看见"磁盘上多了一棵 vendored 树"。
 */
export function collectManifests(root, io = {}) {
  const listDir = io.listDir ?? ((d) => readdirSync(d, { withFileTypes: true }))
  const readText = io.readText ?? ((p) => readFileSync(p, 'utf8'))
  const found = []

  const walk = (dir, depth) => {
    // 深度上限：vendored 树可能很深，但我们只关心清单，不需要走到叶子。
    if (depth > 6) return
    let entries
    try { entries = listDir(dir) } catch { return }   // 读不了的目录不算"没有清单"
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.includes(e.name)) continue
        walk(join(dir, e.name), depth + 1)
        continue
      }
      if (e.name !== 'package.json') continue
      const p = join(dir, e.name)
      let parsed = null
      try { parsed = JSON.parse(readText(p)) } catch { parsed = null }
      found.push(Object.freeze({
        path: relative(root, p).replace(/\\/g, '/'),
        dir: relative(root, dir).replace(/\\/g, '/') || '.',
        // 解析不了的清单**也留下来**，标成 null——丢掉它会让"有一个坏清单"
        // 变成"少了一个清单"，而后者看起来是正常的。
        manifest: parsed,
      }))
    }
  }
  walk(root, 0)
  return Object.freeze(found)
}

/**
 * 从清单集合造 SBOM。
 *
 * @param {object} args
 * @param {string} args.root
 * @param {ReadonlyArray<{path: string, dir: string, manifest: object|null}>} args.manifests
 * @param {ReadonlyArray<string>} [args.vendoredTrees]
 *   **磁盘上实际存在**的 vendored 源码树（仓库相对路径）。这一项由调用方注入，
 *   因为"哪些目录是 vendored"不是从清单能推出来的。
 * @param {ReadonlyArray<string>} [args.installedPrefixes]
 *   磁盘上实际存在的 `node_modules` 前缀（相对路径），用来核对"声明了但没装"。
 * @returns {{version: string, components: ReadonlyArray<object>, findings: ReadonlyArray<object>,
 *            declaredCount: number, vendoredCount: number, roots: ReadonlyArray<string>}}
 */
export function buildSbom({ root = '.', manifests = [], vendoredTrees = [], installedPrefixes } = {}) {
  const components = []
  const findings = []

  // ★ 同一棵 vendored 树通常**也**有一份清单（`.skills-cache/.../package.json`），
  //   于是它既是 `workspace` 又会被下面记成 `vendored`。两处都记会让同一个组件
  //   在报表里出现两次，而 `permissive: 2` 看起来比 `permissive: 1` 覆盖面更大。
  //   所以先把 vendored 树所在的目录标出来，`workspace` 那一遍跳过它们。
  const vendoredSet = new Set(vendoredTrees)

  for (const m of manifests) {
    if (m.manifest === null) {
      findings.push(Object.freeze({
        code: INVENTORY_FINDINGS.LICENSE_UNKNOWN,
        path: m.path,
        detail: '清单解析不了——它的分发条件无法确认，而这不等同于"没有条件"',
      }))
      continue
    }
    // 这棵树会在下面以 `vendored` 的身份被记一次，这里不再记第二遍。
    // 依赖仍然要收——它们是这棵树自己的依赖，与它以什么身份出现无关。
    const isVendoredRoot = vendoredSet.has(m.dir)
    if (!isVendoredRoot) {
      const license = typeof m.manifest.license === 'string' && m.manifest.license.trim() !== ''
        ? m.manifest.license.trim()
        : null
      components.push(Object.freeze({
        kind: 'workspace',
        name: m.manifest.name ?? null,
        version: m.manifest.version ?? null,
        license,
        path: m.path,
        // `private: true` 的包不随产品分发，分发条件不适用——
        // 把它和"未知"混成一个会让真正的未知被淹没。
        private: m.manifest.private === true,
      }))
      if (license === null && m.manifest.private !== true) {
        findings.push(Object.freeze({
          code: INVENTORY_FINDINGS.LICENSE_UNKNOWN,
          path: m.path,
          name: m.manifest.name ?? null,
          detail: `包 ${JSON.stringify(m.manifest.name ?? '(无名)')} 没有 license 字段——` +
            '分发条件未知，而未知不是"没问题"',
        }))
      }
    }

    for (const [dep, range] of Object.entries(m.manifest.dependencies ?? {})) {
      components.push(Object.freeze({ kind: 'dependency', name: dep, range, license: null, from: m.path, dev: false }))
    }
    for (const [dep, range] of Object.entries(m.manifest.devDependencies ?? {})) {
      components.push(Object.freeze({ kind: 'dependency', name: dep, range, license: null, from: m.path, dev: true }))
    }
  }

  // ★ vendored 源码树：**每个都成为一个组件**，无论清单里提没提它。
  for (const tree of vendoredTrees) {
    const owner = manifests.find((m) => m.dir === tree)
    components.push(Object.freeze({
      kind: 'vendored',
      name: owner?.manifest?.name ?? tree,
      version: owner?.manifest?.version ?? null,
      license: typeof owner?.manifest?.license === 'string' ? owner.manifest.license : null,
      path: tree,
    }))
    // 一棵 vendored 树**没有对应清单**，意味着它的来源与许可完全没有记录。
    // 这正是"从 package.json 生成 SBOM"会整棵漏掉的那种情况。
    if (owner === undefined) {
      findings.push(Object.freeze({
        code: INVENTORY_FINDINGS.VENDORED_UNCOVERED,
        path: tree,
        detail: `vendored 源码树 ${tree} 没有任何 package.json 记录它的来源与许可`,
      }))
    } else if (typeof owner.manifest.license !== 'string' || owner.manifest.license.trim() === '') {
      findings.push(Object.freeze({
        code: INVENTORY_FINDINGS.LICENSE_UNKNOWN,
        path: owner.path,
        detail: `vendored 树 ${tree} 的清单没有 license 字段——随产品分发的代码不能有未知的分发条件`,
      }))
    }
  }

  // 声明了但磁盘上没有：不是"没装"，而是"清单与磁盘不一致"。
  //
  // ★ `installedPrefixes` 缺席 ≠ 空数组。缺席是"没去看磁盘"，空数组是
  //   "看了，磁盘上什么都没有"。第一版给参数写了默认 `= []`，于是这两种
  //   情况被合并——**一个"没去看"的调用会静默跳过全部核对**，而它看起来
  //   和"看过了、全都对得上"完全一样。
  //
  //   > 一个「没给磁盘信息就跳过核对」的 SBOM，
  //   > 与一个「核对过、没有任何不一致」的 SBOM，是同一个东西——
  //   > 只不过前者从来没核对过。
  if (installedPrefixes !== undefined) {
    const installed = new Set(installedPrefixes)
    for (const c of components) {
      if (c.kind !== 'dependency' || c.dev) continue
      const base = c.from.split('/').slice(0, -1).join('/')
      const want = `${base}/node_modules/${c.name}`
      if (!installed.has(want)) {
        findings.push(Object.freeze({
          code: INVENTORY_FINDINGS.DECLARED_NOT_INSTALLED,
          path: c.from,
          name: c.name,
          detail: `${c.from} 声明了 ${c.name}，但 ${want} 不存在——清单与磁盘不一致`,
        }))
      }
    }
  }

  if (manifests.length === 0) {
    findings.push(Object.freeze({
      code: INVENTORY_FINDINGS.NO_MANIFESTS,
      path: root,
      detail: '扫描面里一个 package.json 都没有——"扫出来是空的"与"这里真的没有依赖"不是同一件事',
    }))
  }

  const declaredCount = components.filter((c) => c.kind === 'dependency').length
  const vendoredCount = components.filter((c) => c.kind === 'vendored').length

  return Object.freeze({
    version: SBOM_VERSION,
    components: Object.freeze(components),
    findings: Object.freeze(findings),
    declaredCount,
    vendoredCount,
    roots: Object.freeze(manifests.map((m) => m.dir)),
  })
}

// ------------------------------------------------------------------ 分发条件

/** 分发条件分级。**`unknown` 不是 `permissive`**。 */
export const DISTRIBUTION_VERDICTS = Object.freeze(['permissive', 'copyleft', 'unknown', 'restricted'])

/**
 * 常见许可的分发条件。
 *
 * 只覆盖本仓库实际出现的那些——名单之外的**一律 `unknown`**，
 * 而不是"看起来像 MIT 就当 MIT"。
 */
export const LICENSE_TERMS = Object.freeze({
  MIT: { verdict: 'permissive', notice: true, source: true },
  'BSD-3-Clause': { verdict: 'permissive', notice: true, source: true },
  'Apache-2.0': { verdict: 'permissive', notice: true, source: true, patent: true },
  ISC: { verdict: 'permissive', notice: true, source: true },
  'GPL-3.0': { verdict: 'copyleft', notice: true, source: true, copyleft: true },
  'AGPL-3.0': { verdict: 'restricted', notice: true, source: true, copyleft: true, network: true },
})

/**
 * 判定一个组件的商业分发条件。
 *
 * @param {{license: string|null, kind?: string, name?: string}} component
 * @returns {{verdict: string, obligations: ReadonlyArray<string>, reason: string}}
 */
export function distributionTerms(component) {
  const license = component?.license ?? null
  if (license === null || license === '') {
    // ★ "**没读到**它的许可"与"**它没有**许可"是两件事，方向也不同：
    //   前者是我们还没去读（依赖树不在磁盘上），后者是对方没声明。
    //   混成一句话会让 43 个依赖看起来都"没有许可"——那是一次**夸大**，
    //   而夸大一个合规缺口与漏报一个合规缺口，在"这份报表能不能用来做决定"
    //   上是同一个东西。
    //
    //   > 一个「把"没读到"报成"没有"」的合规报表，
    //   > 与一个「把每个未知都报成一个缺口」的报表，是同一个东西——
    //   > 只不过前者会让人去修一个不存在的问题。
    const kind = component?.kind ?? null
    if (kind === 'dependency') {
      return Object.freeze({
        verdict: 'unknown',
        obligations: Object.freeze([]),
        // 依赖自己的许可写在**它自己的** package.json 里，而依赖树不在仓库里。
        // 所以准确的说法是"还没读"，不是"没有"。
        reason: `依赖 ${JSON.stringify(component?.name ?? '(无名)')} 的许可**尚未读取**——` +
          '它写在依赖自己的 package.json 里，而依赖树不在磁盘上；分发前必须实际安装后读取',
      })
    }
    return Object.freeze({
      verdict: 'unknown',
      obligations: Object.freeze([]),
      reason: '没有 license 字段——分发条件未知，必须先查清才能分发（"未知"不能当成"宽松"）',
    })
  }
  const terms = LICENSE_TERMS[license]
  if (terms === undefined) {
    return Object.freeze({
      verdict: 'unknown',
      obligations: Object.freeze([]),
      reason: `${license} 不在已知许可名单里——按未知处理，而不是按宽松处理`,
    })
  }
  const obligations = []
  if (terms.notice) obligations.push('随分发保留版权与许可声明')
  if (terms.source) obligations.push('标明来源')
  if (terms.patent) obligations.push('含专利授权条款')
  if (terms.copyleft) obligations.push('衍生作品需同许可开源')
  if (terms.network) obligations.push('网络服务亦触发开源义务')
  return Object.freeze({
    verdict: terms.verdict,
    obligations: Object.freeze(obligations),
    reason: `${license}：${terms.verdict}`,
  })
}

/**
 * 把 SBOM 翻成一份**分发条件报告**。
 *
 * 与 `buildSbom` 分开的理由：SBOM 是"有什么"，这一份是"能不能分发"，
 * 而后者会随法务结论变化，不应该让 SBOM 的哈希跟着变。
 */
export function distributionReport(sbom) {
  const rows = []
  for (const c of sbom.components) {
    // 私有包不随产品分发，不参与分发条件判定。
    if (c.kind === 'workspace' && c.private) continue
    const t = distributionTerms(c)
    rows.push(Object.freeze({ name: c.name, path: c.path ?? c.from ?? null, license: c.license ?? null, ...t }))
  }
  const blockers = rows.filter((r) => r.verdict === 'unknown' || r.verdict === 'restricted')
  return Object.freeze({
    rows: Object.freeze(rows),
    blockers: Object.freeze(blockers),
    clear: blockers.length === 0,
    counts: Object.freeze(
      Object.fromEntries(DISTRIBUTION_VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length])),
    ),
  })
}

/**
 * 一份 SBOM 够不够全。
 *
 * ★ 判据是**两个来源都有**：只有声明依赖、或只有 vendored 树，都不算全。
 * 一条只检查"有没有生成过一份 SBOM"的判据在两种情况下都是绿的，
 * 而那两种情况恰恰是它该拦的。
 */
export function assertInventoryComplete(sbom) {
  const problems = []
  if (sbom.declaredCount === 0 && sbom.vendoredCount === 0) {
    problems.push('SBOM 里一个组件都没有——"扫出来是空的"与"这里真的没有第三方"不是同一件事')
  }
  const uncovered = sbom.findings.filter((f) => f.code === INVENTORY_FINDINGS.VENDORED_UNCOVERED)
  if (uncovered.length > 0) {
    problems.push(`${uncovered.length} 棵 vendored 源码树没有被任何清单覆盖：${uncovered.map((f) => f.path).join(' / ')}`)
  }
  const unknownLicense = sbom.findings.filter((f) => f.code === INVENTORY_FINDINGS.LICENSE_UNKNOWN)
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    declaredCount: sbom.declaredCount,
    vendoredCount: sbom.vendoredCount,
    unknownLicenseCount: unknownLicense.length,
    unknownLicensePaths: Object.freeze(unknownLicense.map((f) => f.path)),
  })
}
