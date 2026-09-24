// scratch/_probe-cite-all.mjs —— 第 62 轮：本地可解析的引用**逐条**列出，看漂移的全貌
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  UNSOUND — DO NOT BUILD ON THIS                                         ║
// ║                                                                          ║
// ║  它把「引用**后面**出现的第一个反引号标识符」当成"被引的符号"，           ║
// ║  而台账里那个标识符常常是**下一句**提到的别的东西。                       ║
// ║                                                                          ║
// ║  实测：它报"7 处里 4 处漂移（d=73/7/5/4）"，逐条按文件真实位置复核后      ║
// ║  **四处全是假阳性**，台账的引用是对的。                                   ║
// ║     · authority.mjs:759 讲的是 `narrowToGrant`（759 正是它），            ║
// ║       探针抓的是下一句的 `normalizeManifest`；                            ║
// ║     · composition.test.mjs:710 就是被引的用例本身，                       ║
// ║       探针抓的是被**断言的值** `incompatible`。                           ║
// ║                                                                          ║
// ║  > 一个把引用后面的标识符当成"被引的符号"的探针，                         ║
// ║  > 会把四处处处正确的引用报成"全部漂移"。                                 ║
// ║                                                                          ║
// ║  ⇒ 保留是为了让下一轮**不要重新做一遍**，不是为了它的读数。               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { readFileSync, existsSync } from 'node:fs'

const REPO = 'D:/project/DSH/legion/'
const text = readFileSync(REPO + 'docs/superpowers/prt/PRT-PROGRESS.md', 'utf8')

// `` `p:line` `` 后面 40 字内出现的第一个 `符号`
const FULL = /`([A-Za-z0-9_./-]+\.(?:mjs|js)):(\d+)`([\s\S]{0,60}?)`([A-Za-z_$][\w$]{2,})`/g
const seen = new Set()
let n = 0
let ok0 = 0
const drift = []
const unknown = []
for (const m of text.matchAll(FULL)) {
  const [, p, ln, , sym] = m
  const key = `${p}:${ln}`
  if (seen.has(key)) continue
  seen.add(key)
  if (!existsSync(REPO + p)) continue
  n += 1
  const src = readFileSync(REPO + p, 'utf8').split('\n')
  const where = []
  src.forEach((l, i) => { if (l.includes(sym)) where.push(i + 1) })
  const d = where.length === 0 ? null : Math.min(...where.map((w) => Math.abs(w - Number(ln))))
  if (d === 0) ok0 += 1
  else if (d === null) unknown.push({ p, ln, sym })
  else drift.push({ p, ln, sym, d, at: where.slice(0, 4).join(',') })
}
console.log(`  本地可解析且有符号名的引用 **${n}** 处`)
console.log(`  符号**正落在**被引行上的：${ok0} 处`)
console.log(`  符号在文件里但**不在**被引行（漂移）：**${drift.length}** 处`)
console.log(`  符号**整个文件里都没有**（抽取可疑）：${unknown.length} 处\n`)
console.log('  ── 漂移的（按距离倒序）──')
for (const x of drift.sort((a, b) => b.d - a.d)) {
  console.log(`   d=${String(x.d).padStart(3)}  ${x.p}:${x.ln}  →  \`${x.sym}\` 实际在 ${x.at}`)
}
console.log('\n  ── 符号不在文件里的（多半是我抽错了，不算证据）──')
for (const x of unknown) console.log(`   ${x.p}:${x.ln}  \`${x.sym}\``)
