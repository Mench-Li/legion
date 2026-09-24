// scratch/_probe-dead-declarations2.mjs —— v2：只找"注释声称可扩展、而没人遍历"的表（**不提交**）
//
// ★ v1 的教训（本族第 7 次）：v1 报了 366/702 个"没被遍历"的表——**口径错了**。
//   `*_CODES` / `*_ERRORS` 这类**字典**是按 `CODES.FOO` 取值的，本来就不该被遍历。
//   "没被遍历" ≠ "没有消费者"。
//
// ★★ v2 的判据收窄到一个**可证伪的断言**：表的注释里**自己说**"新东西加在这里"。
//   那句话是一个**承诺**：承诺了可扩展，就必须有人真的遍历它去扩展。
//   承诺 + 没人遍历 = 第 40 轮那个形状。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const files = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.endsWith('.test.mjs'))

const grep = (pat) => {
  try {
    return execFileSync('git', ['grep', '-n', '-E', pat], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean)
  } catch (e) {
    if (e.status === 1) return []
    throw e
  }
}

// "新东西加在这里"的承诺，用中文与英文两种写法
const PROMISE = /(一律加在这里|加在这里|新增.{0,8}(加在|写在这里|登记在这里)|新读数.{0,6}加|add new .* here|新增项?都?加在)/

const DECL_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*(Object\.freeze\()?(\[|\{)/
const candidates = []
for (const f of files) {
  let lines
  try { lines = readFileSync(`${ROOT}/${f}`, 'utf8').split(/\r?\n/) } catch { continue }
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i])
    if (!m) continue
    // 往上找 40 行内的注释块（JSDoc / 行注释）
    const above = lines.slice(Math.max(0, i - 40), i).join('\n')
    const promiseLine = above.split('\n').reverse().find((l) => PROMISE.test(l)) ?? null
    if (promiseLine === null) continue
    candidates.push({ file: f, name: m[1], line: i + 1, promise: promiseLine.trim().slice(0, 120) })
  }
}
console.log(`=== 注释里**自己承诺可扩展**的声明表：${candidates.length} 个 ===\n`)

const iterRe = (n) => `(for\\s*\\(const\\s+\\w+\\s+of\\s+${n}\\b|\\[\\.\\.\\.${n}\\]|\\.\\.\\.${n}\\)|\\.\\.\\.${n},|${n}\\.(map|filter|every|some|forEach|includes|reduce)\\b|of\\s+${n}\\b)`
const dead = []
for (const c of candidates) {
  const hits = grep(iterRe(c.name))
  const real = hits.filter((h) => !(h.startsWith(`${c.file}:`) && h.includes(`export const ${c.name}`)))
  const withSelf = hits.filter((h) => h.startsWith(`${c.file}:`)).length
  c.iterSites = real.length
  c.selfSites = withSelf
  // ★ 另一个判据：被**别的模块** import 了吗
  const importers = grep(`import[^\\n]*\\b${c.name}\\b`).filter((h) => !h.startsWith(`${c.file}:`))
  c.importers = importers.length
  if (real.length === 0) dead.push(c)
  console.log(`${real.length === 0 ? '★' : ' '} ${c.name}  (${c.file}:${c.line}) 遍历点=${real.length} 外部import=${c.importers}`)
  console.log(`      承诺: ${c.promise}`)
}
console.log(`\n=== 承诺了可扩展、却**没有任何遍历点**：${dead.length} 个 ===`)
for (const d of dead) console.log(`  ${d.file}  →  ${d.name}`)
