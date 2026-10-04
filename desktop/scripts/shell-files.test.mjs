// desktop/scripts/shell-files.test.mjs
// ============================================================================
// 打包闭包判据 —— 新增一个被 import 的文件时，这一条必须红
//
// 一次真实的缺陷（写这个文件时发现的）：`stage.mjs` 用一张**手写数组**
// 决定哪些 desktop 文件进 Electron 壳。那张数组里没有本批次新增的
// `update-service.mjs` / `update-wiring.mjs` / `update-panel.mjs` /
// `update-preload.cjs` / `update.html`——于是打包出来的应用会在启动时抛
// `ERR_MODULE_NOT_FOUND`，而开发机上一切正常。
//
// 这个失败模式的形状值得写下来：
//
//   > 一个"只改了老文件"的开发流程永远不会碰到它；
//   > 而它第一次暴露是在**装完之后**，那时最可能被归因为"Electron 版本问题"。
//
// 所以这里不检查"清单看起来全不全"，而是检查**闭包**：从 `main.mjs` 出发
// 逐个静态相对导入走下去，每个落点都必须有一条能进安装包的路径。
// ============================================================================

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DESKTOP_SHELL_DIRS, DESKTOP_SHELL_FILES, HELPER_CLOSURE_ROOTS, HELPER_ENTRY, SHELL_PRODUCT_FILES,
  collectModuleClosure, desktopShellClosure, extractRelativeSpecifiers, helperClosure,
} from './shell-files.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** `stage.mjs` 拷进 `resources/legion/` 的生产根（与那里保持同一份）。 */
const PRODUCTION_ROOTS = Object.freeze([
  'product', 'team-hub', 'runtime', 'orchestrator', 'security', 'mesh', 'scrum',
  'whiteboard', 'skills', 'instructions', 'plugins', 'packages',
])

test('壳清单里的每个文件/目录都真的存在', () => {
  for (const file of DESKTOP_SHELL_FILES) {
    assert.equal(existsSync(join(ROOT, 'desktop', file)), true, `壳清单指向一个不存在的文件：desktop/${file}`)
  }
  for (const dir of DESKTOP_SHELL_DIRS) {
    assert.equal(existsSync(join(ROOT, 'desktop', dir)), true, `壳清单指向一个不存在的目录：desktop/${dir}`)
  }
  for (const path of SHELL_PRODUCT_FILES) {
    assert.equal(existsSync(join(ROOT, path)), true, `壳还要一份不存在的产品文件：${path}`)
  }
  assert.equal(existsSync(join(ROOT, HELPER_ENTRY)), true, `helper 入口不存在：${HELPER_ENTRY}`)
})

test('★ 壳的闭包：每个 desktop/ 下的落点都在清单里', () => {
  const closure = desktopShellClosure({ root: ROOT })
  assert.ok(closure.includes('desktop/main.mjs'), '闭包没有从 main.mjs 出发')

  const missing = []
  for (const path of closure) {
    if (!path.startsWith('desktop/')) continue
    const relativeToDesktop = path.slice('desktop/'.length)
    // 目录形态（`assets/icon.png`）由 DESKTOP_SHELL_DIRS 整棵拷贝覆盖。
    const coveredByDir = DESKTOP_SHELL_DIRS.some((dir) => relativeToDesktop.startsWith(`${dir}/`))
    if (DESKTOP_SHELL_FILES.includes(relativeToDesktop) || coveredByDir) continue
    missing.push(relativeToDesktop)
  }
  assert.deepEqual(missing, [],
    `这些文件被 main.mjs（或它的依赖）import，但不在打包清单里——装完之后会 ERR_MODULE_NOT_FOUND：\n  ${missing.join('\n  ')}`)
})

test('★ 壳的闭包：每个 product/ 下的落点都在生产根里（会被整体拷贝）', () => {
  const closure = desktopShellClosure({ root: ROOT })
  const outside = closure.filter((path) => path.startsWith('product/'))
    .filter((path) => !PRODUCTION_ROOTS.includes(path.split('/')[0]))
  assert.deepEqual(outside, [])
  // 壳自己需要的那几份 product 文件也必须被单独列出（它们不在闭包判据的
  // 覆盖范围内，因为 `shell/product/...` 与 `resources/legion/product/...`
  // 是两份拷贝）。
  for (const path of SHELL_PRODUCT_FILES) {
    assert.ok(closure.includes(path), `${path} 被列为壳依赖，但它不在 main.mjs 的闭包里`)
  }
})

test('★ helper 闭包：只落在允许的根里，且**不含**待切换目录里的壳文件', () => {
  const { closure, dependencies, outside } = helperClosure({ root: ROOT })
  assert.deepEqual(outside, [], `helper 闭包跑到了允许的根之外：${outside.join(', ')}`)
  assert.ok(dependencies.length >= 10, `helper 闭包只有 ${dependencies.length} 个依赖，看起来没走通`)
  assert.ok(dependencies.includes('product/update/helper.mjs'), 'helper 闭包没有包含 helper 实现')
  // ★ helper 必须与"会被替换的程序目录"分开（设计 §3 line 57）。
  for (const path of dependencies) {
    assert.equal(path.startsWith('desktop/'), false, `helper 依赖落进了桌面壳：${path}`)
    assert.equal(HELPER_CLOSURE_ROOTS.some((prefix) => path.startsWith(prefix)), true, `${path} 不在允许的根里`)
  }
  void closure
})

test('★ helper 闭包与壳闭包的交集只允许是 product/ 下的共享代码', () => {
  // 两者都拿 `product/update` 与 `product/upgrade`：这是刻意的——helper 与
  // 主进程必须对同一份判据（验签、摘要、事务）有同一份实现。
  // 不允许的是"helper 拿到了 desktop/ 下的东西"：那意味着 helper 与
  // Electron 壳绑在一起，而它必须在 Electron 退出之后继续跑。
  const shell = new Set(desktopShellClosure({ root: ROOT }))
  const helper = helperClosure({ root: ROOT }).dependencies
  const shared = helper.filter((path) => shell.has(path))
  for (const path of shared) {
    assert.equal(path.startsWith('product/'), true, `helper 与壳共享了非产品代码：${path}`)
  }
})

test('★ fixtures/ 下的代码**不得**出现在任何打包闭包里', () => {
  // `stage.mjs` 的打包过滤规则按**目录名**排除 `fixtures`/`tests`。所以
  // "造恶意归档的样例代码"必须待在这些目录里——否则它会被当成生产代码
  // 拷进用户的安装包，而那份代码的唯一用途是构造攻击样例。
  //
  //   > 一份"只用于测试、但会被打进安装包"的恶意样例构造器，
  //   > 与一份"忘记排除的调试后门"在安装包里的字节形态上没有区别。
  const shell = desktopShellClosure({ root: ROOT })
  const helper = helperClosure({ root: ROOT }).closure
  for (const path of [...shell, ...helper]) {
    assert.equal(/(^|\/)(fixtures?|tests?|__tests__|probes)\//.test(path), false,
      `打包闭包里出现了测试样例代码：${path}`)
  }
  // 而且它确实存在（避免这条断言因为"文件被删了"而永远成立）。
  assert.equal(existsSync(join(ROOT, 'product', 'update', 'fixtures', 'zip.mjs')), true,
    '样例构造器不见了——如果它被改名或搬走，这条判据要跟着更新')
})

test('说明符提取器认得四种写法（含 new URL 那种）', () => {
  const source = [
    "import { a } from './a.mjs'",
    "import './side-effect.mjs'",
    "export { b } from './b.mjs'",
    "const m = await import('./dynamic.mjs')",
    "const n = await import(new URL('./url-form.mjs', import.meta.url))",
    "import { c } from 'node:fs'",          // 不是相对的
    "import { d } from 'some-package'",      // 不是相对的
    "// import { e } from './commented.mjs'",
    "/* import { f } from './block-comment.mjs' */",
  ].join('\n')
  const found = extractRelativeSpecifiers(source).sort()
  assert.deepEqual(found, [
    './a.mjs', './b.mjs', './dynamic.mjs', './side-effect.mjs', './url-form.mjs',
  ])
})

test('★ 闭包把缺失文件也列出来（让打包在拷贝时**响亮地**失败）', () => {
  // 一个"跳过不存在的文件"的收集器会让打包**成功**，然后应用在启动时
  // 报 ERR_MODULE_NOT_FOUND —— 也就是把失败从构建期挪到了用户机器上。
  // 所以缺失的路径照样进清单，`stage.mjs` 的 copyFile 会立刻 ENOENT。
  const closure = collectModuleClosure({
    entries: ['desktop/main.mjs'],
    root: ROOT,
    exists: (path) => path.endsWith('main.mjs'),
    readFile: () => "import './gone.mjs'",
  })
  assert.deepEqual(closure, ['desktop/gone.mjs', 'desktop/main.mjs'])
})
