/**
 * 普查：**仓库里还有多少"生成物在手写状态/结论"？**
 *
 * ## 为什么要普查
 *
 * 本会话我已经**三次**只做到"顺路发现"：
 *   ① 过期数字（`PATCH_LAYER_ROWS` 4 vs 5）—— 修了那一处，没普查同类；
 *   ② §5 的措辞（只有第 13 条错框）—— 扫了 §5，没扫 §5 之外；
 *   ③ 生成物里的状态断言（`PRT-214 仍是未完成状态`）—— 修了那一处，没普查同类。
 *
 * 第三次我把它写进了诚实边界（58），所以这一批**先量再说**：
 *   > "发现了一处"与"只有一处"是两件事。
 *
 * ## 判据怎么定（这一步最容易写歪）
 *
 * "生成物"不是我猜的，我取三个**可核**的信号：
 *   · 文件头/正文里自称"生成"（`由 … 生成` / `GENERATED` / `不要手改` / `DO NOT EDIT`）；
 *   · 有配套生成器（按文件名配对，弱信号，只用于分级）；
 *   · 由本仓某个脚本 `--write` 写出来（同上）。
 *
 * "手写状态"取台账自己的词表 + 结论词：
 *   · 状态词： ✅ 🟡 ⏸ ⬜ 未完成 / 已完成 / 待完成 / 未开始 / 部分完成；
 *   · 带任务号的判断：`PRT-\d+` 附近 40 字符内出现上面任一词。
 *
 * ★ 两级输出：**必红**（生成物 + 任务号 + 状态词）与**待判**（生成物 + 状态词，
 *   但没有任务号——可能只是"如果失败就是未完成"这种假设句）。
 *   把两级混成一级，会让我要么漏报要么狼来了。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.ci', 'scratch', 'dist', 'build', '.dsh', 'coverage',
  // ★ 第一版漏了这两个，于是扫了 30916 个文件、报出 8 个"必红"——
  //   而**那 8 个全在别的工作树的旧副本里**，与这个仓库无关。
  //   一个把"别人的旧 checkout"算进结论的普查，量的是磁盘而不是仓库。
  '.worktrees', '.legion-worktrees',
])
const TEXT_EXT = /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|patch|sql)$/i

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (TEXT_EXT.test(name) && st.size < 2_000_000) out.push(p)
  }
  return out
}

// ── 信号 ────────────────────────────────────────────────────────────────────
const GENERATED_SELF = [
  /本文件由[^\n]{0,40}生成/,
  /\bGENERATED\b/,
  /不要手改|请勿手改|不要手工编辑|请勿手工编辑/,
  /\bDO NOT EDIT\b/i,
  /此文件(?:由|是)[^\n]{0,30}生成/,
]
// ★★★ 第 45 轮：词表**不再手写在这里**。
//
//   原来这一行是 9 项的手写并集，而**它为之背书的那些判据**各用一份更小的表
//   （文件级 6 项、类级 5 项、漏掉四个标记全部）⇒
//   "普查说这一类只有 1 个实例"这句话，与判据每天守住的**不是同一个面**。
//
//     > 一次用**更大的网**做的普查，与一条用**更小的网**执行的判据，
//     > 在"结论是 0 违规"的时候是同一个读数——
//     > 只不过前者证明的是一件**更强**的事，而后者才是每天在跑的那一条。
//
//   ⇒ 取同一个所有者。
const { GENERATED_STATUS_VOCAB: STATUS_WORDS } = await import(
  '../scripts/prt/boundary-facts.mjs'
)

const files = walk(ROOT)
const selfGenerated = []
for (const f of files) {
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  const head = text.slice(0, 3000)
  if (!GENERATED_SELF.some((re) => re.test(head))) continue
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  // 命中：状态词，或在任务号附近
  const hits = []
  for (const w of STATUS_WORDS) {
    let idx = text.indexOf(w)
    while (idx !== -1) {
      const around = text.slice(Math.max(0, idx - 60), idx + w.length + 60)
      const nearTask = /PRT-\d+/.test(around)
      hits.push({ word: w, nearTask, snippet: around.replace(/\s+/g, ' ').trim() })
      idx = text.indexOf(w, idx + 1)
      if (hits.length > 40) break
    }
  }
  selfGenerated.push({ rel, hits })
}

const mustRed = selfGenerated.filter((g) => g.hits.some((h) => h.nearTask))
const toJudge = selfGenerated.filter((g) => g.hits.length > 0 && !g.hits.some((h) => h.nearTask))
const clean = selfGenerated.filter((g) => g.hits.length === 0)

console.log(`扫了 ${files.length} 个文本文件；自称"生成物"的 ${selfGenerated.length} 个\n`)

console.log('='.repeat(74))
console.log(`★ 必红（生成物 + 任务号 + 状态词）：${mustRed.length} 个`)
for (const g of mustRed) {
  console.log(`\n  ✖ ${g.rel}  （${g.hits.filter((h) => h.nearTask).length} 处）`)
  for (const h of g.hits.filter((x) => x.nearTask).slice(0, 3)) {
    console.log(`      [${h.word}] …${h.snippet.slice(0, 118)}…`)
  }
}

console.log('\n' + '='.repeat(74))
console.log(`待判（生成物 + 状态词，但附近没有任务号）：${toJudge.length} 个`)
for (const g of toJudge) {
  console.log(`\n  ? ${g.rel}  （${g.hits.length} 处）`)
  for (const h of g.hits.slice(0, 2)) {
    console.log(`      [${h.word}] …${h.snippet.slice(0, 118)}…`)
  }
}

console.log('\n' + '='.repeat(74))
console.log(`干净（自称生成物、正文无状态词）：${clean.length} 个`)
for (const g of clean.slice(0, 20)) console.log(`  ✔ ${g.rel}`)
if (clean.length > 20) console.log(`  …还有 ${clean.length - 20} 个`)

console.log('\n' + '='.repeat(74))
console.log(`普查结论：自称生成物的文件里，**必红 ${mustRed.length} 个 / 待判 ${toJudge.length} 个**。`)
console.log('⚠️ 这只覆盖"**自称**是生成物"的文件。不自称的生成物（以及 md 报告）不在扫描面内。')
