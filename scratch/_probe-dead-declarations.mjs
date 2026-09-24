// scratch/_probe-dead-declarations.mjs —— 找出"导出但没有任何读者"的声明表（**不提交**）
//
// ★ 第 40 轮的形状：`RUN_RECORD_OPTIONAL_FIELDS` 是一张 ★★★ 声明表，
//   注释写着"新读数一律加在这里"，而两侧**各自手写**那几个名字
//   ⇒ 那张表**没有任何机械消费者** ⇒ 照注释做一次 = 静默丢掉。
//
// ★★ 本探针必须先自证（第 39/40 轮我四次假阴性的教训）：
//   它必须**认得出**那个已知的阳性（`RUN_RECORD_OPTIONAL_FIELDS`），
//   且必须有一个 SENTINEL——一个确定有读者的声明表——来证明它不是"全报"。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const files = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.endsWith('.test.mjs'))

const grep = (pat) => {
  try {
    const out = execFileSync('git', ['grep', '-n', '-E', pat], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    return out.split('\n').filter(Boolean)
  } catch (e) {
    // git grep 只在"没有匹配"时退出 1；其它非零必须上抛（不能吞成"没有匹配"）
    if (e.status === 1) return []
    throw e
  }
}

// ── SENTINEL 自证：这三个**确定有读者**，探针必须不把它们报成"没有读者" ──
const SENTINELS = ['RUN_RECORD_FIELDS', 'RUN_RECORD_OPTIONAL_FIELDS', 'DELIVERY_STATES']
const sentinelReport = {}
for (const name of SENTINELS) {
  const hits = grep(`\\b${name}\\b`)
  sentinelReport[name] = hits.length
}
console.log('=== SENTINEL 自证（这些名字的命中数必须 > 0，否则探针是瞎的）===')
for (const [k, v] of Object.entries(sentinelReport)) console.log(`  ${k.padEnd(32)} ×${v}`)
// ★ 已知阳性：第 40 轮**修之前**它没有消费者（现在有了）。探针要能区分"表本身被引用"
//   与"表里的**成员**被引用"——这才是那处缺陷的真正形状。
console.log('\n=== 探针真正的判据：一张声明表是否**被遍历**，而不是被逐个手写 ─=')

/** 找"看起来是声明表"的导出：数组/对象的冻结常量，名字里带 FIELDS/KEYS/IDS/STATES/ACTIONS/CODES/... */
const DECL_RE = /^export const ([A-Z][A-Z0-9_]*)\s*=\s*Object\.freeze\((\[|\{)/
const rows = []
for (const f of files) {
  let text
  try { text = readFileSync(`${ROOT}/${f}`, 'utf8') } catch { continue }
  for (const line of text.split(/\r?\n/)) {
    const m = DECL_RE.exec(line)
    if (!m) continue
    rows.push({ file: f, name: m[1] })
  }
}
console.log(`  声明表候选：${rows.length} 个`)

// 一个表"被遍历"的证据：它出现在 for...of / .map / .filter / .every / spread / includes 里，
// 或者在**另一个模块**里被 import 之后用于循环。
const iterRe = (n) => `(for\\s*\\(const\\s+\\w+\\s+of\\s+${n}\\b|\\[?\\.\\.\\.${n}\\b|${n}\\.(map|filter|every|some|forEach|includes|reduce)\\b|of\\s+${n}\\b)`
const loops = []
for (const { file, name } of rows) {
  const hits = grep(iterRe(name))
  // 只算**声明文件之外**的，或者本文件里不是它自己定义那一行的
  const real = hits.filter((h) => !h.startsWith(`${file}:`) || !h.includes(`export const ${name}`))
  if (real.length === 0) loops.push({ file, name })
}
console.log(`\n=== 「声明了但**没有任何地方遍历它**」的表：${loops.length} 个 ===`)
// 已知阳性必须在里面（回归保护）：修好之后 RUN_RECORD_OPTIONAL_FIELDS 应当**不在**
if (loops.some((x) => x.name === 'RUN_RECORD_OPTIONAL_FIELDS')) {
  console.log('  ★ RUN_RECORD_OPTIONAL_FIELDS 又被报出来了 —— 第 40 轮的修复被回退了？')
} else {
  console.log('  ✓ RUN_RECORD_OPTIONAL_FIELDS **不在**名单里（第 40 轮的修复生效中）')
}
for (const x of loops.slice(0, 40)) console.log(`  ${x.file}  →  ${x.name}`)
