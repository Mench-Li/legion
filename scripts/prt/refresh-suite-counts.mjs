#!/usr/bin/env node
// scripts/prt/refresh-suite-counts.mjs —— 把主表里**过期的计数声明**跟上实测
//
// 起因（第 53 轮）：主表 `docs/MULTI-AGENT-FEATURE-STATUS.md` 里那格
// "`X.test.mjs` N 例"是**计数声明**，而它跟着代码走 —— 有人补了用例，
// 它就该变。实测一轮里就有 **10 条**过期（全是另一个会话持续在补的 `*-http` 套件）。
//
// ★ 这个工具**不自己数用例**，也不自己解析文档：它直接把
//   `suite-counts.mjs`（那条判据的**所有者**）算出来的 `violations` 拿来用。
//
//   > 一个"自己再数一遍"的修复工具，与那条每天在跑的判据之间，
//   > 会在**某一次**数法不一致时开始互相打架 ——
//   > 而那时两边都自称是实测。
//
// ⇒ 一条声明只有一个所有者，修复工具只是它的**执行手**。
//
// 用法：
//   node scripts/prt/refresh-suite-counts.mjs           # 只看计划，不写
//   node scripts/prt/refresh-suite-counts.mjs --write    # 按行写入
//
// ★ **按行**写，不做全文档替换：`suite-counts` 刻意**只查主表**，
//   而非主表里同样的字符串（历史读数）**必须冻结**。
//   第 53 轮第一版做成全文档替换，改的正是历史读数 —— 那恰好是判据④ 要防的事。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkRepo, REPO, STATUS_DOC } from './suite-counts.mjs'

const WRITE = process.argv.includes('--write')

const r = checkRepo()
if (r.skipped.length > 0) {
  // ★ 先报"没能核对"的：它们既不是"对"也不是"错"。
  console.log(`⚠️ 有 ${r.skipped.length} 条**没能核对**（读不出用例数 / 名字解析不到）：`)
  for (const s of r.skipped) console.log(`   · ${s}`)
  console.log('   ⇒ 这些先修，再谈"过期"。\n')
}
if (r.violations.length === 0) {
  console.log(`✅ 主表 ${r.total} 条计数声明全部与实测一致（已核 ${r.checked}）`)
  process.exit(0)
}

const abs = resolve(REPO, STATUS_DOC)
const lines = readFileSync(abs, 'utf8').split('\n')

console.log(`主表 ${r.total} 条声明里有 **${r.violations.length} 条过期**：\n`)
let applied = 0
const refused = []
for (const v of r.violations) {
  const i = v.line - 1
  const line = lines[i]
  const tag = `L${String(v.line).padStart(3)}  ${v.name.padEnd(26)} ${String(v.claim).padStart(3)} → ${String(v.real).padStart(3)}`
  if (line === undefined) { refused.push(`${tag}   行不存在`); continue }
  // ★ 安全闸：那一行上必须**正好一次**出现"名字 + 旧值 + 例"。
  //   命中 0 次 ⇒ 文档已经变了；命中多次 ⇒ 这一行里有两处同形声明，不能猜是哪一个。
  const re = new RegExp('(`' + v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`[（(]?\\s*)' + v.claim + '(\\s*例)', 'g')
  const hits = [...line.matchAll(re)].length
  if (hits !== 1) { refused.push(`${tag}   该行命中 ${hits} 次（应为 1）—— 不写入`); continue }
  if (WRITE) lines[i] = line.replace(re, `$1${v.real}$2`)
  console.log(`  ${WRITE ? '✔' : '·'} ${tag}`)
  applied += 1
}

if (refused.length > 0) {
  console.log(`\n⚠️ ${refused.length} 条**拒绝写入**（安全闸）：`)
  for (const x of refused) console.log(`  ${x}`)
}

if (!WRITE) {
  console.log(`\n（演练）可写 ${applied} 条、拒绝 ${refused.length} 条。加 \`--write\` 才落盘。`)
  process.exit(refused.length === 0 ? 0 : 1)
}
writeFileSync(abs, lines.join('\n'))
console.log(`\n已写入 ${applied} 条。请重跑 \`node --test scripts/prt/suite-counts.test.mjs\` 复核。`)
process.exit(refused.length === 0 ? 0 : 1)
