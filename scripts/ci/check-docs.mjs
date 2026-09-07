#!/usr/bin/env node
/**
 * check-docs.mjs — Legion 文档新鲜度机器校验（零第三方依赖，Node >= 22.5，仅 node:fs/re/path）。
 *
 * 校验对象：README.md（产品总览）与 docs/FEATURES.md（功能手册）两个持久产品文档。
 * 校验范围（R-5 口径：只判结构/链接/索引一致，不判语义）：
 *   1. 功能索引提取   —— docs/FEATURES.md 中 /^F-[0-9]{2}/ 行数 >= 18，且每行 5 列（0 坏列），状态枚举合法（AC-R3-1 / BR-1）
 *   2. 功能索引锚点   —— 索引「章节锚点」列必须是文档内真实存在的标题（AC-R3-2 / BR-1）
 *   3. 功能正文非空   —— 索引每条功能对应小节 >= 5 行且含「入口」或「操作」（AC-R3-3 / BR-1）
 *   4. README→手册互链 —— README 中所有 docs/FEATURES.md#<锚点> 的锚点在手册标题集中真实存在（AC-R2-2 / BR-3）
 *   5. 段落去重       —— README 与手册之间不存在 >= 3 行的逐字重复操作步骤块（AC-R2-1 / BR-3）
 *   6. 关键项不丢     —— 三件套命令 / DSH Desktop 自动启停 / 三分钟体验循环 至少出现在二文件之一（AC-R2-3 / BR-3）
 *   7. 无过程叙事     —— 两文件不出现「P1/P2/P3 …已交付」「切片 Sx…已交付」式过程叙事（AC-R1-5 / BR-2 / I-8）
 *
 * 用法：
 *   node scripts/ci/check-docs.mjs              # 校验当前文档，满足则 exit 0
 *   node scripts/ci/check-docs.mjs --help       # 输出用法与校验项说明（exit 0）
 *
 * 命中失败时输出「FAIL: <文件>:<行> …」并在 exit 非 0。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const README = join(ROOT, 'README.md')
const FEATURES = join(ROOT, 'docs', 'FEATURES.md')

const CHECKS = [
  '功能索引提取（>=18 行 / 0 坏列 / 状态枚举）',
  '功能索引锚点（锚点=真实标题）',
  '功能正文非空（>=5 行且含入口/操作）',
  'README→手册互链（锚点 0 失效）',
  '段落去重（>=3 行同文块=0）',
  '关键项不丢（三件套/DSH Desktop/三分钟循环）',
  '无过程叙事（P1/P2/P3·已交付 / 切片 Sx·已交付 = 0）',
  '内联锚点链接（[t](#anchor) 的锚点必须是本文件真实标题）',
]

if (process.argv.includes('--help')) {
  console.log('check-docs.mjs — Legion 文档新鲜度机器校验（零第三方依赖，仅 node:fs/re/path）')
  console.log('')
  console.log('校验对象：README.md（总览）+ docs/FEATURES.md（功能手册）')
  console.log('校验项：')
  CHECKS.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c))
  console.log('')
  console.log('用法：')
  console.log('  node scripts/ci/check-docs.mjs            # 校验当前文档，满足则 exit 0')
  console.log('  node scripts/ci/check-docs.mjs --help     # 本说明（exit 0）')
  console.log('')
  console.log('失败时输出 FAIL: <文件>:<行> … 并 exit 非 0；只判结构/链接/索引一致，不判语义。')
  process.exit(0)
}

let fails = 0
const fail = (file, line, msg) => {
  fails += 1
  const where = line != null ? file + ':' + line : file
  console.error('FAIL: ' + where + ' — ' + msg)
}

let feats = ''
let readme = ''
try { feats = readFileSync(FEATURES, 'utf8') } catch (e) { fail(FEATURES, null, '无法读取：' + e.message) }
try { readme = readFileSync(README, 'utf8') } catch (e) { fail(README, null, '无法读取：' + e.message) }

// ---- 工具 ----
const norm = (s) => s.trim()
const splitCells = (line) => line.split(String.fromCharCode(124)).map(norm).filter(Boolean)
const LINES = (s) => s.split('\n')
const lineOf = (s, idx) => idx + 1 // idx 是 LINES 里的下标
const lineAt = (s, idx) => s.slice(0, idx).split('\n').length // 由字符下标求 1 基行号

/** 标题行：返回 {level, text}；非标题返回 null。 */
function headingOf(line) {
  const m = /^(#{1,6})\s+(.+)$/.exec(line)
  return m ? { level: m[1].length, text: m[2].trim() } : null
}
/** GitHub 风格 slug（供 README 互链锚点与手册标题比对）。 */
function slugify(s) {
  return s.toLowerCase()
    .replace(/[。，、：；！？“”‘’（）《》【】·…—±××]/g, '')
    .replace(/[^\w\u4e00-\u9faf\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

if (feats) {
  const fl = LINES(feats)
  const heads = [] // {text, slug, line}
  for (let i = 0; i < fl.length; i++) {
    const h = headingOf(fl[i])
    if (h) heads.push({ text: h.text, slug: slugify(h.text), line: lineOf(fl, i) })
  }
  const headText = new Set(heads.map(h => h.text))
  const headSlug = new Set(heads.map(h => h.slug))

  // 1. 标题语义（AC-R1-1）：含「功能使用介绍」或「使用手册」
  // 2. 六类章节（AC-R1-2）——以标题是否含关键词判定
  const cats = ['一句话定位', '面向读者', '快速开始', '模块章节', '功能索引', '故障排查与术语附录']
  for (const c of cats) {
    const found = heads.find(h => h.text.includes(c))
    if (!found) fail(FEATURES, null, '缺少章节类别：' + c)
  }

  // 3. 功能索引行（AC-R3-1 / BR-1）
  const idxRows = fl.filter(l => /^F-[0-9]{2}/.test(l))
  if (idxRows.length < 18) fail(FEATURES, null, '功能索引行数=' + idxRows.length + '（需 >= 18）')
  const idxLine = (line) => { const i = fl.findIndex(x => x === line); return lineOf(fl, i) }
  for (const row of idxRows) {
    const cells = splitCells(row)
    if (cells.length !== 5) {
      fail(FEATURES, idxLine(row), '索引行列数=' + cells.length + '（需 5 列）：' + row)
      continue
    }
    const status = cells[4]
    if (!['已上线', '迭代中', '遗留'].includes(status)) fail(FEATURES, idxLine(row), '状态枚举非法：' + status)
    if (!headText.has(cells[2])) fail(FEATURES, idxLine(row), '索引锚点不存在：' + cells[2])
  }

  // 4. 索引锚点 + 正文非空（AC-R3-2 / AC-R3-3 / BR-1）
  for (const row of idxRows) {
    const cells = splitCells(row)
    const target = cells && cells[2]
    if (!target) continue
    // 找到该标题，统计其后到下个同级/更高级标题之间非空行
    const hi = heads.findIndex(h => h.text === target)
    if (hi < 0) continue
    const startIdx = fl.findIndex(l => headingOf(l) && headingOf(l).text === target)
    if (startIdx < 0) { fail(FEATURES, idxLine(row), '找不到索引对应正文小节：' + target); continue }
    const lvl = headingOf(fl[startIdx]).level
    let body = []
    for (let j = startIdx + 1; j < fl.length; j++) {
      const h2 = headingOf(fl[j])
      if (h2 && h2.level <= lvl) break
      if (fl[j].trim()) body.push(fl[j])
    }
    if (body.length < 5) fail(FEATURES, lineOf(fl, startIdx + 1), '正文小节 < 5 行（' + body.length + '）：' + target)
    if (!/入口|操作/.test(body.join(' '))) fail(FEATURES, lineOf(fl, startIdx + 1), '正文小节缺「入口/操作」：' + target)
  }

  // 5. README→手册互链（AC-R2-2 / BR-3）
  const anchorRe = /docs\/FEATURES\.md#([^\s)\]]+)/g
  let am
  let total = 0
  const rl = LINES(readme)
  for (let i = 0; i < rl.length; i++) {
    const line = rl[i]
    const re = new RegExp(anchorRe.source, 'g')
    while ((am = re.exec(line))) {
      total += 1
      if (!headSlug.has(am[1])) fail(README, lineOf(rl, i), '互链锚点失效：docs/FEATURES.md#' + am[1])
    }
  }
  if (total < 8) fail(README, null, 'README→手册互链数=' + total + '（需 >= 8）')

  // 6. 内联锚点链接（AC-R5-2 反向 / BR-5）：文档内 [text](#anchor) 的锚点必须是本文件真实标题（注入坏锚点即检出）。
  const inlineRe = /\[[^\]]*\]\(#([^)]+)\)/g
  const inlineDocs = [[FEATURES, feats, headSlug], [README, readme, new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slugify(m[1].trim())))]]
  for (const [fpath, ftext, fslugs] of inlineDocs) {
    let im
    const ire = new RegExp(inlineRe.source, 'g')
    while ((im = ire.exec(ftext))) {
      const anchor = im[1].trim()
      if (!fslugs.has(anchor)) fail(fpath, lineAt(ftext, im.index), '内联锚点失效：#' + anchor)
    }
  }

  // 6. 段落去重（AC-R2-1 / BR-3）：>=3 行逐字同文块
  const rLines = rl.map(norm)
  const fLines = fl.map(norm)
  let dupBlocks = 0
  for (let i = 0; i < rLines.length; i++) {
    if (!rLines[i]) continue
    for (let j = 0; j < fLines.length; j++) {
      if (rLines[i] === fLines[j]) {
        let len = 0
        while (i + len < rLines.length && j + len < fLines.length && rLines[i + len] === fLines[j + len] && rLines[i + len]) len += 1
        if (len >= 3) { dupBlocks += 1; j += len - 1 }
      }
    }
  }
  if (dupBlocks > 0) fail(README, null, '与手册存在 >=3 行的逐字重复块 x' + dupBlocks)

  // 7. 关键项不丢（AC-R2-3 / BR-3）
  const both = readme + '\n' + feats
  for (const key of ['三件套', 'DSH Desktop', '三分钟体验循环']) {
    if (!both.includes(key)) fail(README, null, '关键信息缺失：' + key)
  }

  // 8. 无过程叙事（AC-R1-5 / BR-2 / I-8）
  const narr = (feats.match(/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/g) || []).length
    + (readme.match(/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/g) || []).length
  if (narr !== 0) fail(FEATURES, null, '出现过程叙事（P1/P2/P3 已交付 / 切片 Sx 已交付）x' + narr)
}

if (fails === 0) {
  console.log('check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，' + CHECKS.length + ' 类校验项全绿）')
  process.exit(0)
} else {
  console.log('check-docs: FAIL（' + fails + ' 处问题，详见上方 FAIL 行）')
  process.exit(1)
}
