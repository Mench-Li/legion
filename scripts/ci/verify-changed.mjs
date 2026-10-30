#!/usr/bin/env node
// scripts/ci/verify-changed.mjs
// ============================================================================
// 工作流「实现阶段」的独立测试 runner：**只跑这次提交真正碰到的那几套**。
//
// ## 为什么需要它（2026-10-30 现场）
//
// 冻结的工作流定义把 implement 阶段的 `testRunner` 配成整仓 `node --test`、
// 15 分钟超时。这个仓库跑不完：T-224 的独立测试回执是 `exitCode=null / state=unknown`，
// 而实现阶段的自动交接**要求** `state === 'passed'` ⇒ 每个编码任务都停在
// `in_review`，审查阶段（T-225）连认领都被中枢拒（回执不合规）。
//
//   > 一个"永远跑不完"的验证命令，
//   > 与一个"永远不通过"的验证命令，在流水线眼里是同一个东西。
//
// 本脚本把"跑全部"换成"跑相关的"：按本次提交改到的文件找出覆盖它的套件，
// 只跑这些。跑不动时**如实报错**，不假装通过。
//
// ## 契约（工作流 testRunner 逐字定死，不能带 shell/环境变量）
//
//   executable: node
//   args:       ["scripts/ci/verify-changed.mjs"]
//   cwd:        实现阶段的隔离 worktree（HEAD = 该阶段提交）
//
// 因此基准必须自己算：`git merge-base HEAD main`（worktree 与主仓共享 refs）。
//
// ## 覆盖映射（四类，按可信度递减）
//
//   ① 同名套件：`a/b.mjs` → `a/b.test.mjs`
//   ② 目录套件：`plugins/src/x.ts` → `plugins/tests/x.test.mjs`
//   ③ 驼峰→短横线：`workbench/src/accountProfile.ts` → `workbench/scripts/account-profile.test.mjs`
//   ④ 引用者：扫 `*.test.mjs`，谁 import 了被改模块（相对路径以模块文件名结尾）
//
// ## 没有映射到任何套件时
//
// 退出码 0，并打印 `verify-changed: unmapped=...` 与改动清单 —— **这是刻意的**：
// 把"改了一个没有任何测试覆盖的文件"判成失败，会把文档/配置类改动也堵死；
// 真正的质量闸门是紧随其后的审查阶段（Codex 看 diff）。这条取舍记在
// docs/bugs/BUG-042 里，后续要收紧时改这里一处即可。
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_SUFFIX = '.test.mjs'
const SCAN_ROOTS = ['team-hub', 'runtime', 'plugins/tests', 'workbench/scripts', 'orchestrator', 'scripts']

/** 驼峰/帕斯卡 → 短横线（`accountProfile` → `account-profile`；`AccountPanel` → `account-panel`）。 */
export function kebabCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/**
 * 把改动文件映射到应当运行的套件（纯函数，便于单测）。
 *
 * @param changed 仓库相对路径（POSIX 分隔符）
 * @param options.exists 判存在；`importersOf` 给"引用者"这一类用（可注入，便于单测）
 */
export function mapChangedToSuites(changed, { exists = () => false, importersOf = () => [], mentionedBy = () => [] } = {}) {
  const suites = new Set()
  for (const raw of changed) {
    const path = String(raw).replaceAll('\\', '/')
    if (!/\.(mjs|ts|tsx|js|cjs)$/.test(path)) continue
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const base = path.slice(path.lastIndexOf('/') + 1)
    const stem = base.replace(/\.(mjs|ts|tsx|js|cjs)$/, '')
    const candidates = []
    // ① 同名套件
    candidates.push(join(dir, `${stem}${TEST_SUFFIX}`))
    // ② 目录套件（源码目录 → 对应测试目录）
    if (dir === 'plugins/src') candidates.push(join('plugins/tests', `${stem}${TEST_SUFFIX}`))
    if (dir === 'workbench/src') candidates.push(join('workbench/scripts', `${kebabCase(stem)}${TEST_SUFFIX}`))
    if (dir.startsWith('workbench/src/')) candidates.push(join('workbench/scripts', `${kebabCase(stem)}${TEST_SUFFIX}`))
    if (dir === 'orchestrator/worker' || dir.startsWith('orchestrator/')) candidates.push(join(dir, `${stem}${TEST_SUFFIX}`))
    // ③ 引用者（import 了被改模块）
    for (const importer of importersOf(stem)) candidates.push(importer)
    // ④ 提到者：源码断言型测试（只 import node 内置、用 readFileSync 读源码）不会 import 模块，
    //    但会把**路径字符串**写在断言里（如 'workbench/src/components/AccountPanel.tsx'）。
    for (const mention of mentionedBy(path)) candidates.push(mention)
    for (const candidate of candidates) {
      const normalized = candidate.replaceAll('\\', '/')
      if (exists(normalized)) suites.add(normalized)
    }
  }
  return [...suites].sort()
}

/** 扫 `.test.mjs`，找出 import 了某个模块文件名（`from '.../stem.mjs'`）的那些。 */
export function indexImporters(root, scanRoots = SCAN_ROOTS) {
  const byStem = new Map()
  const visit = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { visit(full); continue }
      if (!entry.name.endsWith(TEST_SUFFIX)) continue
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      const rel = relative(root, full).replaceAll(sep, '/')
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const target = match[1]
        const stem = target.slice(target.lastIndexOf('/') + 1).replace(/\.(mjs|ts|tsx|js|cjs)$/, '')
        if (stem === '') continue
        if (!byStem.has(stem)) byStem.set(stem, [])
        byStem.get(stem).push(rel)
      }
    }
  }
  for (const scanRoot of scanRoots) {
    const abs = join(root, scanRoot)
    if (existsSync(abs)) visit(abs)
  }
  return (stem) => byStem.get(stem) ?? []
}

/**
 * 扫 `.test.mjs`，找出**在文本里提到**某个路径的那些（源码断言型测试）。
 *
 * 这类测试只 import `node:*`，用 `readFileSync` 读源码再断言字符串，所以 import 索引
 * 一条都看不见它 —— 但它们恰恰是最容易因为源码改动而失败的那批。
 */
export function indexMentions(root, scanRoots = SCAN_ROOTS) {
  const tests = []
  const visit = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { visit(full); continue }
      if (!entry.name.endsWith(TEST_SUFFIX)) continue
      try { tests.push({ rel: relative(root, full).replaceAll(sep, '/'), text: readFileSync(full, 'utf8') }) } catch { /* 读不到就不参与 */ }
    }
  }
  for (const scanRoot of scanRoots) {
    const abs = join(root, scanRoot)
    if (existsSync(abs)) visit(abs)
  }
  // ★ 只认**仓库相对全路径**，不认裸文件名：`app.mjs`、`identity.ts` 这种名字到处都是，
  //   按裸名匹配会把半仓的测试都拉进来（实测 19 个改动 → 24 套，其中大部分毫不相干）。
  //   源码断言型测试读的就是仓库路径（`read('workbench/src/components/AccountPanel.tsx')`）。
  return (path) => tests.filter((test) => test.text.includes(path)).map((test) => test.rel)
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').trim()}`)
  return result.stdout
}

export function changedFiles(root) {
  const head = git(['-C', root, 'rev-parse', '--verify', 'HEAD']).trim()
  let base
  try {
    base = git(['-C', root, 'merge-base', 'HEAD', 'main']).trim()
  } catch {
    // 没有 main（裸单分支仓库）时退到父提交：至少只跑这次提交碰到的。
    base = `${head}^`
  }
  const committed = git(['-C', root, 'diff', '--name-only', '-z', base, head]).split('\0').filter(Boolean)
  // 未提交的改动也算（runner 可能在提交前被调起；那时更该跑一遍）
  const working = git(['-C', root, 'diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
  const untracked = git(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  return { base, head, files: [...new Set([...committed, ...working, ...untracked])].filter((f) => !f.startsWith('.legion-worktrees/')) }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const root = process.cwd()
  try {
    const { base, head, files } = changedFiles(root)
    const suites = mapChangedToSuites(files, {
      exists: (rel) => existsSync(join(root, rel)),
      importersOf: indexImporters(root),
      mentionedBy: indexMentions(root),
    })
    console.log(`verify-changed: base=${base.slice(0, 12)} head=${head.slice(0, 12)} changed=${files.length} suites=${suites.length}`)
    for (const file of files) console.log(`  · ${file}`)
    if (suites.length === 0) {
      console.log('verify-changed: unmapped=1 —— 改动没有映射到任何测试套件（文档/配置类改动属于这一支）；按约定不判失败')
      process.exit(0)
    }
    for (const suite of suites) console.log(`  → ${suite}`)
    // ★ 每套**单独一个进程**。
    //
    //   不能把 5 套塞进同一个 `node --test` 进程：这些套件里有会写 `TEAM_HUB_TOKEN`/
    //   `TEAM_HUB_DB` 并 import `server.mjs` 的，同进程里后跑的会读到前一个留下的
    //   模块级状态 —— 实测（2026-10-30，T-224）会把两套本来全绿的判成 401/未引导。
    //   而 Windows 沙箱不允许 child_process **管道** spawn，所以这里用
    //   `stdio: 'inherit'`（不建管道）而不是 Node 默认的 per-file 子进程。
    let failed = 0
    for (const suite of suites) {
      console.log(`\n=== ${suite} ===`)
      const run = spawnSync(process.execPath, ['--test', '--experimental-test-isolation=none', suite], { cwd: root, stdio: 'inherit' })
      if (run.error) { console.error(`verify-changed: 启动 ${suite} 失败：${run.error.message}`); process.exit(2) }
      if ((run.status ?? 1) !== 0) failed += 1
    }
    console.log(`\nverify-changed: suites=${suites.length} failed=${failed}`)
    process.exit(failed === 0 ? 0 : 1)
  } catch (error) {
    console.error(`verify-changed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
