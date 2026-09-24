/**
 * 自检：我的 `codeOnly` 会不会**吞掉大段代码**？（词法近似的已知风险）
 *
 * ## 为什么要查这个
 *
 * v4 的修法是"先去掉注释与字符串字面量，再数词频"。这是个**词法近似**：
 * 它不知道正则字面量 `/.../`。于是正则里出现一个引号字符（例如
 * `/['"]/` 或 `/[^"]+/`）就会把解析器带进"字符串模式"，
 * **从那里开始一路吞到下一个引号**——可能是几百行。
 *
 *   > 一个"这个词没有读者"与一个"我的去字符串函数把有读者的那一段吞了"，
 *   > 在只数词频的输出里长得一模一样——**而后者会让扫描器报出更多"哑声明"，
 *   > 也就是看起来更勤快。**
 *
 * 实测线索：`unregistered` 在 `scripts/prt/baseline-snapshot.mjs` 里
 * **代码**出现 3 次，可扫描器报的 `total` 只有 2 ⇒ 那 3 次没被数到。
 *
 * ## 这个脚本怎么判
 *
 * 对扫描面里每个文件比 `原文里词的出现次数` 与 `codeOnly 之后剩下的次数`：
 *   · 一个词在**注释/字符串**里也被提到 ⇒ 减少是**预期**的；
 *   · 但**减少的幅度**能告诉我们 codeOnly 是否吞过头。
 * 所以这里重点看两个量：`codeOnly` 后**长度保留率**，以及**逐文件是否骤降**。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOTS = ['product', 'runtime', 'team-hub', 'orchestrator', 'security', 'scrum', 'plugins', 'scripts', 'tests']

function codeOnly(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++ }
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '\n') out += '\n'
        i++
      }
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.mjs'))
  .filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)))

const rows = []
for (const f of files) {
  const raw = readFileSync(f, 'utf8')
  const code = codeOnly(raw)
  const nlRaw = (raw.match(/\n/g) ?? []).length
  const nlCode = (code.match(/\n/g) ?? []).length
  rows.push({ f, rawLen: raw.length, codeLen: code.length, keep: code.length / Math.max(1, raw.length), nlRaw, nlCode })
}

rows.sort((a, b) => a.keep - b.keep)

console.log(`\n=== codeOnly 保留率（最小 25 个）===`)
console.log(`  扫描面 ${rows.length} 个 .mjs\n`)
console.log('  保留率   原行数  剩行数  保留行数比   文件')
for (const r of rows.slice(0, 25)) {
  const nlKeep = r.nlCode / Math.max(1, r.nlRaw)
  console.log(`  ${r.keep.toFixed(3)}   ${String(r.nlRaw).padStart(6)}  ${String(r.nlCode).padStart(6)}  ${nlKeep.toFixed(3)}       ${r.f}`)
}

// ★ 判据：**行数**保留率是关键。字符串/注释的删除几乎不删行
//   （我的实现保留了字符串里的换行），所以行数骤降 = 吞掉了代码。
const bad = rows.filter((r) => r.nlCode / Math.max(1, r.nlRaw) < 0.95)
console.log(`\n★ 行数保留率 < 0.95 的文件：${bad.length} 个`)
for (const r of bad.slice(0, 12)) {
  console.log(`  ${(r.nlCode / r.nlRaw).toFixed(3)}   ${r.f}`)
}
if (bad.length === 0) console.log('  （无）')

// ★★ 针对线索的那个词：`unregistered` 在 baseline-snapshot.mjs 里应当还在
const probe = 'scripts/prt/baseline-snapshot.mjs'
const raw = readFileSync(probe, 'utf8')
const code = codeOnly(raw)
const cnt = (s) => (s.match(/(?<![A-Za-z0-9_$])unregistered(?![A-Za-z0-9_$])/g) ?? []).length
console.log(`\n★ 线索核对：${probe}`)
console.log(`  原文里 unregistered 出现 ${cnt(raw)} 次；codeOnly 之后剩 ${cnt(code)} 次`)
console.log(`  原文 ${raw.split('\n').length} 行 → codeOnly 后 ${code.split('\n').length} 行`)
if (cnt(code) < cnt(raw)) {
  console.log('  ⇒ codeOnly **吞掉了**代码 ⇒ 那条"unregistered 是哑声明"是**我的仪器造的假象**')
} else {
  console.log('  ⇒ 没被吞；那 total=2 另有原因（要接着查）')
}
