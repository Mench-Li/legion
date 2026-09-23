import { readFileSync } from 'node:fs'

// ★ 判据：**从基线自己派生**真相，再与两份文档里的表**逐格**比。
//   不硬编码任何期望值——那是这次出错的原因（我按印象归类）。

const base = JSON.parse(readFileSync('docs/superpowers/prt/prt-reachability-baseline.json', 'utf8'))
const gaps = base.unreachable.filter((r) => r.class === 'gap')

const itemOf = (reason) => {
  const m = /§5\s*第\s*(\d+)\s*条/.exec(reason) ?? /第\s*(\d+)\s*条/.exec(reason)
  return m ? Number(m[1]) : null
}

const truth = new Map()
const orphan = []
for (const r of gaps) {
  const n = itemOf(r.reason ?? '')
  if (n === null) orphan.push(r.file)
  else truth.set(n, [...(truth.get(n) ?? []), r.file])
}

console.log('=== 基线派生（判据来源）===')
for (const [n, f] of [...truth.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  第 ${String(n).padStart(2)} 条 → ${f.length}`)
}
console.log(`  gap 合计 ${gaps.length}；无条目指针的 ${orphan.length}`)

// ── 从两份文档里解析表：按**连续表格块**分组，逐块判
//   （同一份文档里有两张表都提到"第 16 条"，所以不能全文扫——那会报假 DUP）
function tableBlocks(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const blocks = []
  let cur = null
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '')
    if (/^\s*\|/.test(l)) {
      if (cur === null) cur = []
      cur.push(l)
    } else if (cur !== null) {
      blocks.push(cur)
      cur = null
    }
  }
  if (cur !== null) blocks.push(cur)
  return blocks
}

function parseBlock(block) {
  const found = new Map()
  for (const l of block) {
    const m = /\|\s*第\s*\*\*(\d+)\*\*\s*条[^|]*\|\s*\*\*(\d+)\*\*\s*\|/.exec(l)
    if (!m) continue
    const n = Number(m[1])
    if (found.has(n)) found.set(n, 'DUP')
    else found.set(n, Number(m[2]))
  }
  return found
}

// 认出"就是那张账表"的块：至少含 5 个条目计数
function accountingTable(path) {
  for (const b of tableBlocks(path)) {
    const f = parseBlock(b)
    if (f.size >= 5 && ![...f.values()].includes('DUP')) return f
  }
  return new Map()
}

const DOCS = [
  ['docs/superpowers/prt/PRT-IMPLEMENTATION-REPORT.md', '§九'],
  ['docs/superpowers/prt/PRT-SESSION-REPORT-2026-09-17.md', '§10.41'],
]

let allOk = orphan.length === 0
for (const [path, label] of DOCS) {
  const doc = accountingTable(path)
  console.log('')
  console.log(`=== ${label}（${path.split('/').pop()}）===`)
  // ── 方向 A：基线的每一条，文档里都要有，且数字对得上
  for (const [n, files] of [...truth.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const got = doc.get(n)
    const ok = got === files.length
    if (!ok) allOk = false
    console.log(`  第 ${String(n).padStart(2)} 条：基线 ${files.length}  文档 ${got ?? '（没写）'}  ${ok ? '✔' : '✖'}`)
  }
  // ── ★★ 方向 B：**文档里的每一条，基线里也要有**。
  //
  //   2026-09-18 撞出来的：我把 `runtime/connectors/registry.mjs` 接上生产
  //   之后基线从 26 掉到 25（第 13 条 → 0），而这份文档的表里**仍留着**
  //   `| 第 13 条 | 1 |` 一行——上面那个循环只遍历**基线派生**的条目，
  //   所以那一行**一格都没被检查**，脚本照样报"逐格一致"。
  //
  //     > 一个"基线的每一条都在文档里"的判据，
  //     > 与一个"文档里的每一条也都在基线里"的判据，
  //     > 在**集合没变**的时候是同一个东西——只不过前者在集合缩小时
  //     > 会把一行**过期**的记录读成一致。
  //
  //   这与 §10.41 那个 `DUP` 坑同一个形状：**只查一个方向**的判据，
  //   在另一个方向出错时给出的仍然是"✔"。
  for (const [n, written] of [...doc.entries()].sort((a, b) => a[0] - b[0])) {
    if (truth.has(n)) continue
    allOk = false
    console.log(`  第 ${String(n).padStart(2)} 条：基线 **没有这一条**（已归零/已改判）  文档却写着 ${written}  ✖`)
  }
  // ── 方向 C：合计也要对（两个方向都过、但总数各错一处时，合计能抓到）
  const docTotal = [...doc.values()].reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
  if (docTotal !== gaps.length) {
    allOk = false
    console.log(`  合计：基线 gap ${gaps.length}  文档 ${docTotal}  ✖`)
  } else {
    console.log(`  合计：${docTotal}  ✔`)
  }
}

console.log('')
console.log(allOk ? '✔ 两份文档的表与基线逐格一致' : '✖ 有出入')
process.exit(allOk ? 0 : 1)
