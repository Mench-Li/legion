#!/usr/bin/env node
/**
 * encoding-check.mjs — 源文件编码完整性门禁（零第三方依赖）。
 *
 * 为什么需要这道门禁（一次真实的教训）：
 *
 *   在一次用 PowerShell `Get-Content -Raw` / `Set-Content` 往返改写源文件的尝试中，
 *   一个多字节 CJK 字符被写成了 U+FFFD（替换字符）。文件**仍然能被 Node 解析**——
 *   因为被吃掉的字符在字符串字面量**内部**，语法没坏，测试照样跑，只是那句错误信息
 *   悄悄变了样。只有当被吃掉的恰好是引号时，才会以 `SyntaxError: Invalid or unexpected
 *   token` 的形式暴露出来。
 *
 *   > 一个「在多字节字符被吃掉之后仍然能通过语法检查」的文件，
 *   > 与一个「看起来没变、其实信息已经变了」的文件，是同一个东西。
 *
 *   而 `git diff` 对**未跟踪**的文件什么都不说，所以在新文件上这道损坏完全隐形。
 *
 * 本脚本检查两件事：
 *   ① U+FFFD（REPLACEMENT CHARACTER）—— 解码失败的残留，也是**所有**非法 UTF-8 序列的兜底
 *      （Node 的解码器把非法序列统统换成它，孤立代理项因此不可能出现在结果里）
 *   ② NUL 字节 —— 文件多半被写成了 UTF-16 或二进制；代码/配置里一律 FAIL，
 *      采集类文档（`.md`/`.txt`）只记账（见 `CAPTURE_EXT`）
 *
 * 用法：
 *   node scripts/ci/encoding-check.mjs             # 扫描受版本控制的源文件
 *   node scripts/ci/encoding-check.mjs --all       # 连未跟踪文件一起扫（提交前自查用）
 *   node scripts/ci/encoding-check.mjs --quiet     # 只输出结论行
 *
 * 通过标准：exit code 0（没有可疑文件）。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SELF_DIR, '..', '..')

const args = new Set(process.argv.slice(2))
const SCAN_ALL = args.has('--all')
const QUIET = args.has('--quiet')

/**
 * 只看文本类文件；二进制（图片、压缩包、字体、SQLite）本来就允许出现任意字节。
 */
const TEXT_EXT = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.md', '.markdown',
  '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.htm', '.svg', '.txt',
  '.sql', '.sh', '.ps1', '.cmd', '.bat', '.env', '.example', '.gitignore', '.gitattributes',
])

/**
 * 这些扩展名里出现 NUL 字节一律 **FAIL**：代码与配置永远不该是 UTF-16。
 *
 * `.md` / `.txt` 不在此列——见 `CAPTURE_EXT`。
 */
const CODE_EXT = new Set([
  '.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc',
  '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.htm', '.svg',
  '.sql', '.sh', '.ps1', '.cmd', '.bat', '.env', '.example', '.gitignore', '.gitattributes',
])

/**
 * 采集类文档：NUL 字节记为 **note**，不判失败。
 *
 * 为什么分开：仓库里有 **36 个**历史验收证据 `.txt` 与 `scratch/baseline/RESEARCH-T096.md`
 * 是 PowerShell 重定向/`Set-Content` 写出来的 UTF-16LE（带 `fffe` BOM）。它们是**历史
 * 采集物**，不是回归——把判据放宽到"不看"会让这个事实消失，把判据收紧到"判失败"会让
 * 一次历史遗留永远堵住门禁。
 *
 *   > 一个「为了让门禁变绿而不再检查」的检查，
 *   > 与一个「把历史遗留当成新回归、于是门禁永远红」的检查，是同一个东西——
 *   > 两者都让这道门禁不再说话。
 *
 * 所以：仍然**报出来**（计数 + 文件名），只是不 exit 1。要不要把历史采集物转成 UTF-8
 * 是一件独立的事（会重写文档历史），不该由这道门禁顺手决定。
 */
const CAPTURE_EXT = new Set(['.md', '.markdown', '.txt'])

/** 没有扩展名但一定是文本的文件。 */
const TEXT_BASENAMES = new Set(['LICENSE', 'NOTICE', 'AUTHORS', 'Makefile', 'Dockerfile', 'CODEOWNERS'])

function isTextFile(rel) {
  const base = rel.split('/').pop()
  if (TEXT_BASENAMES.has(base)) return true
  const ext = extname(base).toLowerCase()
  if (ext === '') return false
  return TEXT_EXT.has(ext)
}

function listFiles() {
  const out = []
  const gitArgs = ['ls-files', '--cached', '--others', '--exclude-standard']
  if (!SCAN_ALL) gitArgs.splice(2, 1) // 去掉 --others
  let raw = ''
  try {
    raw = execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    console.error('encoding-check: 无法列出文件（git 不可用？）：' + (err?.message ?? String(err)))
    process.exit(2)
  }
  for (const line of raw.split('\n')) {
    const rel = line.trim().replace(/\\/g, '/')
    if (rel === '') continue
    if (rel.includes('node_modules/')) continue
    if (rel.startsWith('.ci/')) continue
    if (rel.startsWith('releases/')) continue
    out.push(rel)
  }
  return out
}

/**
 * 检查一个缓冲区。返回问题清单（空数组表示干净）。
 *
 * 每条问题带 `severity`：`'fail'` 会让门禁红，`'note'` 只报出来。
 *
 * @param {Buffer} buf
 * @param {string} rel
 * @returns {Array<{kind: string, severity: 'fail'|'note', detail: string}>}
 */
export function inspectBuffer(buf, rel) {
  const problems = []
  const ext = extname(String(rel).split('/').pop()).toLowerCase()
  // ① 含 NUL 字节 ⇒ 多半根本不是 UTF-8 文本（UTF-16 之类）
  const nulCount = buf.filter((b) => b === 0).length
  if (nulCount > 0) {
    const ratio = nulCount / Math.max(1, buf.length)
    problems.push({
      kind: 'nul-bytes',
      // 代码/配置里出现 NUL 永远是 bug；采集类文档是历史遗留（见 CAPTURE_EXT 注释）
      severity: CODE_EXT.has(ext) ? 'fail' : 'note',
      detail: `含 ${nulCount} 个 NUL 字节（占 ${(ratio * 100).toFixed(1)}%）——多半被写成了 UTF-16 或二进制`,
    })
    return problems // 已经是别的编码了，后面两项按 UTF-8 判没有意义
  }
  const text = buf.toString('utf8')
  // ② U+FFFD：解码失败的残留。**这一条最容易漏**——它在字符串字面量内部时语法完全正常。
  //
  // ⚠️ 这一条**同时**是"任何非法 UTF-8 序列"的兜底，所以不需要单独检查孤立代理项：
  //   Node 的 UTF-8 解码器把**所有**非法序列都换成 U+FFFD，包括 CESU-8/WTF-8 形式的
  //   代理项（`ED A0 80` = U+D800 → 三个 U+FFFD）。而 `buf.toString('utf8')` 的返回值
  //   里因此**永远不可能**出现孤立代理项。
  //
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  //
  //   （实测：`ED A0 80` → `\uFFFD\uFFFD\uFFFD`；`F0 8D A0 80` 也解成 U+D800 因而同样
  //   被换成 U+FFFD。`encoding-check.test.mjs` 把这个不可达性钉住了——留着一条永远
  //   不触发的规则，只会让人以为这一类损坏已经被覆盖。）
  const fffd = []
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) fffd.push(i)
  }
  if (fffd.length > 0) {
    const first = fffd[0]
    const before = text.slice(Math.max(0, first - 40), first).replace(/\n/g, '|')
    const after = text.slice(first + 1, first + 41).replace(/\n/g, '|')
    problems.push({
      kind: 'replacement-char',
      severity: 'fail',
      detail: `含 ${fffd.length} 个 U+FFFD（替换字符）。首个在第 ${text.slice(0, first).split('\n').length} 行：…${before}［U+FFFD］${after}…`,
    })
  }
  return problems
}

function main() {
  const files = listFiles().filter(isTextFile)
  const bad = []      // severity=fail
  const noted = []    // severity=note
  for (const rel of files) {
    let buf
    try {
      buf = readFileSync(resolve(ROOT, rel))
    } catch {
      continue // 被删除或不可读（git 索引里的陈旧项）
    }
    for (const p of inspectBuffer(buf, rel)) {
      if (p.severity === 'fail') bad.push({ rel, problem: p })
      else noted.push({ rel, problem: p })
    }
  }

  if (!QUIET) {
    console.log('encoding-check: 扫描 ' + files.length + ' 个文本文件' + (SCAN_ALL ? '（含未跟踪）' : '（仅受版本控制）'))
    for (const b of bad) {
      console.log('  ✖ ' + b.rel)
      console.log('      [' + b.problem.kind + '] ' + b.problem.detail)
    }
    if (noted.length > 0) {
      // 历史采集物：报出来，但不判失败（见 CAPTURE_EXT 注释）
      const byExt = {}
      for (const n of noted) {
        const e = n.rel.includes('.') ? n.rel.slice(n.rel.lastIndexOf('.')) : '(none)'
        byExt[e] = (byExt[e] || 0) + 1
      }
      console.log('  ℹ 历史采集物（UTF-16 写出，不判失败）：' + noted.length + ' 个 ' + JSON.stringify(byExt))
      for (const n of noted) console.log('      · ' + n.rel)
    }
  }
  if (bad.length === 0) {
    console.log('encoding-check: PASS（' + files.length + ' 个文本文件：无 U+FFFD；'
      + '代码/配置无 NUL 字节' + (noted.length > 0 ? '；' + noted.length + ' 个历史采集物为 UTF-16，已列出' : '') + '）')
    process.exit(0)
  }
  console.log('encoding-check: FAIL（' + bad.length + ' 处编码损坏）')
  console.log('')
  console.log('这一类损坏**不会**被语法检查或测试发现——被吃掉的字符在字符串字面量内部时，')
  console.log('文件仍然能被解析、测试照样能跑，只是信息悄悄变了。修法是**重写整个文件**，')
  console.log('不要用 shell 做 UTF-8 文件的往返读写（PowerShell 的 Get-Content/Set-Content 尤其危险）。')
  process.exit(1)
}

// 被 import 时不执行（便于单测直接调 inspectBuffer）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

export { main, listFiles, isTextFile }
