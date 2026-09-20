// scratch/_probe-r104b-origincites.mjs —— 第 104 轮量：Legion **源码注释**里那些"某文件:某行 原文：『…』"的引用，今天还对得上吗？
//
// ★ 为什么：本仓已有一条判据 `ledger-line-citations-resolve` —— 但它读的是**台账**（`PRT-PROGRESS.md`）。
//   而 `runtime/adapters/dsh/port.mjs:37` 这种**源码注释**里的 `文件:行` 引用**没有任何判据**，
//   实测其中一条已经漂了 414 行（说明 `:2241`，原文在 `:1827`；文件干净、HEAD 上就是错的）。
//
// ★★ 第一版探针有两个假阳性，都记在这里：
//   ① 引文常**跨行**（开引号在本行、闭引号在下一行），而第一版逐行扫、引文里**不许有换行** ⇒ 漏掉了 `port.mjs` 那一处；
//   ② 目标路径常是**相对引用文件自己**的（`launcher.mjs:108` 就在同目录），而第一版一律按仓库根解析 ⇒ 误报"目标文件不存在"。
//   > 一个"逐行扫注释"的探针，与一个"按文件扫注释"的探针，在"跨行的引文算不算"上不是同一个东西。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'

const R = 'D:/project/DSH/legion'

// 允许引文跨行；开合引号成对（「」或『』或 “”）
const CITE = /([A-Za-z0-9_./-]+\.[a-z]{2,3}):(\d+)(?:-(\d+))?[^\n]*?(?:原文|原句)[^\n]*?[：:]\s*([「『“"])/g

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'releases'].includes(e.name)) continue
    const p = join(d, e.name)
    if (e.isDirectory()) { walk(p, out); continue }
    if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

const roots = ['runtime', 'scripts', 'product', 'orchestrator', 'team-hub', 'workbench', 'plugins']
const files = roots.filter((x) => existsSync(join(R, x))).flatMap((x) => walk(join(R, x)))
console.log(`  扫了 ${files.length} 个源码文件`)

const PAIR = { '「': '」', '『': '』', '“': '”' }
const DSH = 'D:/project/DSH/dsh/deepseek-harness'

const hits = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const lineOf = (idx) => text.slice(0, idx).split('\n').length
  for (const m of text.matchAll(CITE)) {
    const open = m[4]
    const close = PAIR[open]
    const start = m.index + m[0].length
    const end = text.indexOf(close, start)
    if (end < 0) continue
    const quote = text.slice(start, end).replace(/\s+/g, ' ').trim()
    if (quote.length < 6) continue
    hits.push({ at: `${f.replace(R + '/', '')}:${lineOf(m.index)}`, target: m[1], line: Number(m[2]), quote })
  }
}

console.log(`\n  共找到 **${hits.length}** 处"路径:行 + 原文"引用\n`)

const resolveTarget = (citingFile, target) => {
  const cands = [
    resolve(dirname(citingFile), target), // 相对引用文件
    resolve(R, target),                    // 相对仓库根
    resolve(DSH, target),                  // 相对 DSH 检出
  ]
  return cands.find((c) => existsSync(c)) ?? null
}

let ok = 0
let bad = 0
for (const h of hits) {
  const citingFile = resolve(R, h.at.slice(0, h.at.lastIndexOf(':')))
  const abs = resolveTarget(citingFile, h.target)
  if (abs === null) {
    bad += 1
    console.log(`    ✖ 目标文件三个候选位置都找不到   ${h.at} → ${h.target}:${h.line}`)
    continue
  }
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  const needle = h.quote.slice(0, 14)
  const atLine = (lines[h.line - 1] ?? '').includes(needle)
  let found = -1
  if (!atLine) {
    for (let d = 1; d <= 60 && found < 0; d += 1) {
      if ((lines[h.line - 1 - d] ?? '').includes(needle)) found = h.line - d
      else if ((lines[h.line - 1 + d] ?? '').includes(needle)) found = h.line + d
    }
  }
  if (atLine) { ok += 1; console.log(`    ✔ ${h.at} → ${h.target}:${h.line}`) } else if (found > 0) {
    bad += 1
    console.log(`    ✖ **漂了 ${Math.abs(found - h.line)} 行**   ${h.at} → 说明 ${h.target}:${h.line}，实际在 :${found}`)
    console.log(`         引文：${h.quote.slice(0, 70)}`)
  } else {
    bad += 1
    console.log(`    ✖ ±60 行内找不到那句引文   ${h.at} → ${h.target}:${h.line}`)
    console.log(`         引文：${h.quote.slice(0, 70)}`)
    console.log(`         该行实际是：${(lines[h.line - 1] ?? '').trim().slice(0, 76)}`)
  }
}
console.log(`\n  ⇒ 对得上 **${ok}**、★**对不上 ${bad}**`)
