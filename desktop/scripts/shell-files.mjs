// desktop/scripts/shell-files.mjs
// ============================================================================
// 打包进 Electron 壳（与独立 helper 目录）的文件清单 —— 以及它的**闭包判据**
//
// ## 为什么这份清单需要一个可执行的判据
//
// `stage.mjs` 原本用一张手写数组决定哪些 desktop 文件进壳：
//
//     ['main.mjs', 'runtime.mjs', 'preload.cjs', 'startup.html', 'startup.mjs', 'messages.mjs', 'assets']
//
// 这个写法在"只改老文件"时完全没问题，只在**新增一个被 main.mjs import 的
// 文件**时失效——而它失效的表现是：开发机上一切正常（直接跑仓库里的
// `desktop/main.mjs`），打包出来的应用在启动时抛 `ERR_MODULE_NOT_FOUND`。
// 换句话说是"装完之后才发现"，而那时最可能被归因为"Electron 版本问题"。
//
//   > 一张"要记得同步"的文件清单，与一张"迟早不同步"的文件清单，
//   > 是同一个东西——只不过前者在 review 里看起来是完备的。
//
// 所以清单从 `stage.mjs` 里搬到这里，并且多了一条**闭包判据**：
// `shell-files.test.mjs` 从 `main.mjs` 出发走静态相对导入，要求每个落点
// 都在这份清单里（或在 `product/` 里，那部分由生产根循环拷贝）。
//
// ## helper 目录为什么单独一份
//
// 设计 §3 line 57 要求 helper「位于本次事务的独立受控目录……它及所需 Node
// 文件**不属于**本次待切换的目录」。也就是：
//
//     resources/legion/**   ← 本次会被整体替换的程序目录（installRoot）
//     resources/update/**   ← helper 与它需要的产品代码，**不**在替换范围内
//
// 所以 helper 不是"壳里的一个文件"，它有自己的一份闭包——那份闭包里的
// 路径必须保留仓库内的相对形状（`resources/update/product/update/helper.mjs`），
// 这样 helper-entry 里那句 `../product/update/helper.mjs` 才成立。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

/** 进 `shell/desktop/` 的文件（相对 `desktop/`）。 */
export const DESKTOP_SHELL_FILES = Object.freeze([
  'main.mjs',
  'runtime.mjs',
  'preload.cjs',
  'startup.html',
  'startup.mjs',
  'messages.mjs',
  'update-service.mjs',
  'update-wiring.mjs',
  'update-preload.cjs',
  'update-panel.mjs',
  'update.html',
])

/** 进 `shell/desktop/` 的目录（相对 `desktop/`，整棵拷贝）。 */
export const DESKTOP_SHELL_DIRS = Object.freeze(['assets'])

/** 壳还需要从 `product/` 直接拿的文件（相对仓库根）。 */
export const SHELL_PRODUCT_FILES = Object.freeze([
  'product/launcher/desktop-protocol.mjs',
])

/** helper 的入口（相对仓库根）。它进 `resources/update/`。 */
export const HELPER_ENTRY = 'desktop/helper-entry.mjs'

/**
 * helper 闭包里**允许**被拷贝的根。
 *
 * 白名单而不是"什么都不许"：一个"从 helper 能 import 到 `team-hub/`"的实现
 * 会把整个后台服务拖进独立受控目录，而那个目录的拷贝代价与它引入的
 * 依赖面都要跟着涨。
 */
export const HELPER_CLOSURE_ROOTS = Object.freeze(['product/update', 'product/upgrade', 'product/'])

/** 静态相对导入/再导出的提取。注释先剥掉，避免把说明文字当成导入。 */
export function extractRelativeSpecifiers(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const out = []
  const patterns = [
    /(?:^|[\s;{(])import\s+[^'"]*from\s*['"](\.[^'"]+)['"]/gm,
    /(?:^|[\s;{(])import\s*['"](\.[^'"]+)['"]/gm,
    /(?:^|[\s;{(])export\s+[^'"]*from\s*['"](\.[^'"]+)['"]/gm,
    // `import('...')`
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    // `import(new URL('...', import.meta.url))` —— 也是合法且常见的写法，
    // 不做这一条会让"藏起来的相对导入"在打包时被漏掉。
    /new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) out.push(match[1])
  }
  return out
}

/**
 * 从若干入口收集静态相对导入的**闭包**（只收 `.mjs`/`.cjs`/`.js`）。
 *
 * @param {object} args
 * @param {string[]} args.entries  相对 `root` 的入口路径
 * @param {string} args.root       仓库根
 * @returns {string[]} 排序后的相对 `root` 的路径（含入口自身）
 */
export function collectModuleClosure({ entries, root, readFile = (path) => readFileSync(path, 'utf8'), exists = existsSync }) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current)) continue
    seen.add(current)
    const absolute = resolve(root, current)
    if (!exists(absolute)) continue
    let source
    try { source = readFile(absolute) } catch { continue }
    for (const specifier of extractRelativeSpecifiers(source)) {
      const target = resolve(dirname(absolute), specifier)
      const rel = relative(root, target).split(sep).join('/')
      // 只跟仓库内的 `.mjs`/`.cjs`/`.js`；`node:` 与裸包名不在此列。
      if (rel.startsWith('..') || !/\.(mjs|cjs|js)$/.test(rel)) continue
      queue.push(rel)
    }
  }
  return [...seen].sort()
}

/** 壳的闭包（从 `desktop/main.mjs` 出发）。 */
export function desktopShellClosure({ root, ...rest } = {}) {
  return collectModuleClosure({ entries: ['desktop/main.mjs'], root, ...rest })
}

/**
 * helper 的闭包（从 `desktop/helper-entry.mjs` 出发），并检查它只落在
 * `HELPER_CLOSURE_ROOTS` 之内。
 *
 * 入口自身不参与"越界"判定：它被单独拷成 `resources/update/helper-entry.mjs`，
 * 而它的依赖按仓库内的相对形状铺在 `resources/update/` 之下。
 */
export function helperClosure({ root, ...rest } = {}) {
  const closure = collectModuleClosure({ entries: [HELPER_ENTRY], root, ...rest })
  const dependencies = closure.filter((path) => path !== HELPER_ENTRY)
  const outside = dependencies.filter((path) => !HELPER_CLOSURE_ROOTS.some((prefix) => path.startsWith(prefix)))
  return Object.freeze({ closure: Object.freeze(closure), dependencies: Object.freeze(dependencies), outside: Object.freeze(outside) })
}
