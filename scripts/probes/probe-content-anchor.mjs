/**
 * 探针：`file:line` 引用的**内容**还对不对？（上一批判据看不见的那一半）
 *
 * ## 起因：就在我写下"这条判据看不见内容漂移"的下一批，内容漂移真的发生了
 *
 * 另一会话自己订正了四处引用：`plugins/root-row.mjs:485-509` → `:508-536`
 * （"§9.5 接线前是 485-509"）。我第一反应是"我的新判据抓到了"——
 * **核过之后：没有。** 那个文件现在 **719 行**，`485-509` 稳稳在范围内。
 *
 *   > 我差一点把"别人用推理找到的"记成"我的判据找到的"。
 *   > 一个判据抓到与一个人抓到，在**结果**上一样，在**它值多少**上完全不一样。
 *
 * 但也因此有了一个**实测的边界样本**：上一批那条判据只判"行号在不在范围内"，
 * 而这一次的真实漂移是**在范围内、内容已经不是那个东西了**。
 *
 * ## 想法：用"同一句里的反引号标识符"当**内容锚**
 *
 * 台账里几乎每条引用旁边都点着一个代码标识符：
 *
 *   | `installEnforcementRoot({...})` | `plugins/root-row.mjs:508-536` |
 *   | 返回 `undefined`（放行） | `tool-request.mjs:639` |
 *
 * 于是：**那个标识符应当出现在被引用的那几行附近**。
 *
 * ## 这一步是**探针**，不是判据
 *
 * 先把读数打出来**看**：命中率多少、误报像什么样。**看过了再决定**要不要变成判据——
 * 上一批的教训是"先把键收紧、再补正面对照、然后才敢当判据"。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_CHECKOUT ?? 'D:/project/DSH/dsh/deepseek-harness'
const LEDGER = join(ROOT, 'docs/superpowers/prt/PRT-PROGRESS.md')
const text = readFileSync(LEDGER, 'utf8')

// ── 用 git 找文件（复用我上一批的后缀解析思路，但用 git 更快）──────────────
function locate(p) {
  const cands = [join(ROOT, p), join(DSH, p)]
  for (const c of cands) if (existsSync(c)) return c
  try {
    const out = execFileSync('git', ['ls-files', '--', `*${p}`], { cwd: ROOT, encoding: 'utf8' }).trim()
    const lines = out.split('\n').filter(Boolean)
    if (lines.length === 1) return join(ROOT, lines[0])
  } catch { /* ignore */ }
  return null
}

/**
 * 抓引用**与它的内容锚**。
 * 内容锚 = 引用**前面 200 字符**内最近的一个反引号标识符。
 * ★ 只收"像代码标识符"的：含大小写变化、下划线、点，或长度 > 6 的驼峰式，
 *   排除 `undefined`/`true`/`false`/`null` 这类到处都是的词（它们没有定位力）。
 */
const STOP = new Set(['undefined', 'true', 'false', 'null', 'string', 'number', 'object',
  'function', 'import', 'export', 'const', 'return', 'await', 'async', 'JSON', 'Error'])

const RE = /([\s\S]{0,220}?)((?:[\w.@-]+[\\/])*[\w.@-]+\.(?:mjs|cjs|js|ts|tsx)):(\d+)(?:-(\d+))?/g
const hits = []
for (const m of text.matchAll(RE)) {
  const before = m[1]
  const path = m[2].replace(/\\/g, '/')
  const from = Number(m[3])
  const to = m[4] ? Number(m[4]) : from
  // 取前面最近的一个反引号 token
  const toks = [...before.matchAll(/`([^`\n]{1,60})`/g)].map((x) => x[1])
  let hint = null
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].trim()
    if (t === '' || STOP.has(t)) continue
    // 标识符样式：单 token（可以带点），且不是路径、不是 Task 号
    if (/^PRT-\d+$/.test(t)) continue
    if (/[\\/]/.test(t)) continue
    if (!/^[A-Za-z_$][\w$.]*$/.test(t)) continue
    if (t.length < 4) continue
    hint = t.split('.')[0] // 取 `a.b.c` 的第一段
    break
  }
  hits.push({ path, from, to, hint })
}

const withHint = hits.filter((h) => h.hint !== null)
const rows = []
for (const h of withHint) {
  const real = locate(h.path)
  if (real === null) { rows.push({ ...h, status: 'NO-FILE' }); continue }
  let lines = []
  try { lines = readFileSync(real, 'utf8').split('\n') } catch { rows.push({ ...h, status: 'NO-READ' }); continue }
  const lo = Math.max(0, h.from - 1 - 20)
  const hi = Math.min(lines.length, h.to + 20)
  const window = lines.slice(lo, hi).join('\n')
  if (window.includes(h.hint)) rows.push({ ...h, status: 'HIT' })
  else rows.push({ ...h, status: 'MISS', file: real.replace(/\\/g, '/') })
}

const by = {}
for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1

console.log(`\n=== 内容锚探针：${hits.length} 条引用，其中 ${withHint.length} 条取到了内容锚 ===\n`)
console.log('按状态：')
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}`)

const miss = rows.filter((r) => r.status === 'MISS')
if (miss.length) {
  console.log(`\n★ MISS（锚词不在 ±20 行窗口里）——**逐条看过再决定它是不是缺陷**：`)
  for (const r of miss.slice(0, 25)) {
    console.log(`  ${r.path}:${r.from}${r.to !== r.from ? `-${r.to}` : ''}  锚=\`${r.hint}\``)
  }
  if (miss.length > 25) console.log(`  …另有 ${miss.length - 25} 条`)
} else {
  console.log('\n没有 MISS。')
}
console.log(`\n⚠️ 这是**探针**：MISS 不等于缺陷——锚词可能本来就是别的含义、`)
console.log(`   或窗口 ±20 行太窄。**逐条核过之后**才谈得上变成判据。`)
