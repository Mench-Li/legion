// scripts/ci/ci-syntax.mjs
// ============================================================================
// 门禁：`scripts/ci/*.mjs` 与 `scripts/**/*.mjs` 必须能被 Node **解析**。
//
// ## 为什么需要它
//
// 这条门禁来自一个反复发生的具体事故，而不是一句"最佳实践"。
//
// 编辑 `scripts/ci/run-ci.mjs` 的测试清单时，插入一个新块**吃掉**了下一个块的
// `{` —— 于是整个文件 `SyntaxError`。而当时**六道门禁全部绿灯**：
//
//   *一个"改坏了 CI 运行器、而门禁全绿"的提交，
//   与一个"改坏了 CI 运行器、并且被拦下"的提交，在门禁日志上长得一模一样。*
//
// 原因是结构性的：`run-ci.mjs` 是**跑门禁的那个程序**，它自己不跑门禁。
// 六道门禁都由它调用，所以它坏掉时，没有任何一道会响——
// 它们只会**不被执行**，而"没被执行"与"通过了"在外观上都是"没有 FAIL 行"。
//
// 本文件把自己插进**最前面**：它是唯一一个不依赖 `run-ci.mjs` 自身可运行的门禁
// （因为它只用 `node --check`，而 `node --check` 不需要被检查的文件能跑）。
//
// ## 它检查什么
//
// 对每个文件跑 `node --check`（真正的解析器，不是正则）。语法错误、括号不配对、
// 非法 token 全部拦下。**不检查语义**，也不执行它们。
//
// 零第三方依赖：只用 `node:child_process` / `node:fs` / `node:path`。
// ============================================================================

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

/** 递归收集目录下的 `.mjs` 文件。 */
function collectMjs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) collectMjs(abs, out)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(abs)
  }
  return out
}

/**
 * 一个文件能不能被 Node 解析。
 *
 * `node --check` 对语法错误 exit 非 0 并把 `SyntaxError` 打到 stderr。
 * 用 `-e` 之类的替代品都不行：那些会**执行**代码，而门禁不该执行被测对象。
 */
function parseError(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    const stderr = err.stderr === undefined ? '' : String(err.stderr)
    // 从 `file:line` 与 `SyntaxError: …` 里取出可读的一行
    const line = stderr.split(/\r?\n/).find((l) => /SyntaxError|Error:/.test(l))
    const where = stderr.split(/\r?\n/).find((l) => /^\S.*:\d+$/.test(l.trim()))
    return `${where === undefined ? '' : where.trim() + ' — '}${line === undefined ? stderr.trim().slice(0, 200) : line.trim()}`
  }
}

const args = new Set(process.argv.slice(2))

if (args.has('--help')) {
  console.log('ci-syntax.mjs — 门禁：CI 脚本必须能被 Node 解析（零第三方依赖）')
  console.log('')
  console.log('检查对象：scripts/ 下的全部 .mjs（含 scripts/ci/ 与 scripts/prt/）')
  console.log('为什么：run-ci.mjs 是跑门禁的程序，它自己不跑门禁——')
  console.log('        它语法坏掉时六道门禁全部绿灯，因为那些门禁只是"没被执行"。')
  console.log('')
  console.log('用法：')
  console.log('  node scripts/ci/ci-syntax.mjs          # 全部可解析则 exit 0')
  console.log('  node scripts/ci/ci-syntax.mjs --quiet  # 只打结论')
  console.log('  node scripts/ci/ci-syntax.mjs --help   # 本说明')
  process.exit(0)
}

const files = collectMjs(join(ROOT, 'scripts')).sort()
if (files.length === 0) {
  console.error('FAIL: scripts/ 下一个 .mjs 都没找到——门禁没检查到任何东西，不算通过')
  process.exit(1)
}

const broken = []
for (const file of files) {
  const err = parseError(file)
  if (err !== null) broken.push({ file: relative(ROOT, file).replace(/\\/g, '/'), err })
}

if (broken.length > 0) {
  for (const b of broken) console.error(`FAIL: ${b.file} — ${b.err}`)
  console.error(`\nci-syntax: FAIL（${broken.length}/${files.length} 个脚本无法被 Node 解析）`)
  console.error('★ 这些文件里有一个**跑门禁的程序**。它坏掉时其它门禁不会响——它们只是不被执行。')
  process.exit(1)
}

if (!args.has('--quiet')) {
  console.log(`ci-syntax: PASS（${files.length} 个脚本全部可被 Node 解析）`)
  // 明确点出被守住的那个文件，免得读者以为这条门禁在守无关紧要的东西。
  const hasRunner = files.some((f) => f.endsWith(join('ci', 'run-ci.mjs')))
  console.log(hasRunner
    ? '  其中包含 scripts/ci/run-ci.mjs —— 它是跑门禁的程序，此前它坏掉时六道门禁全绿。'
    : '  ⚠️ 没找到 scripts/ci/run-ci.mjs；门禁守的东西变了，请检查。')
}
process.exit(0)
