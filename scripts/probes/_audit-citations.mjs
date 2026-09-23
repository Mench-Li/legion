// scripts/probes/_audit-citations.mjs —— 抽查代码注释里的 `file.mjs:NNN` 引用（**不提交**）
//
// 家族：**一句没有任何东西核对的断言**。本会话已撞到 4 次
// （usage-rollup 声称"降级已实现"、baseline-snapshot 声称"没接进 CI"、
//   NOT_FORWARDED_YET 的两条理由指错行、F-04 手抄的计数）。
// 行号引用是这一族里**最可自动核对**的一种：被引文件还在，行号对不对是能算的。
//
// 判据只取**确定性**的两种错（不猜语义）：
//   ① 行号超出文件行数；② 被引那一行是空的 / 只有 `}` `{` `);` 这类收尾符。
// 两者都**不可能是**"那个东西的定义处"。
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = 'D:/project/DSH/legion'
const files = execFileSync('git', ['ls-files', '-z', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter(Boolean)
  .filter((f) => !/\.test\.mjs$/.test(f) && !/^scratch\//.test(f) && !/^docs\//.test(f))

const CIT = /([\w][\w./-]*\.mjs):(\d+)/g
const byPath = new Map(files.map((f) => [f.replace(/\\/g, '/'), f]))
const byBase = new Map()
for (const f of files) {
  const b = f.replace(/\\/g, '/').split('/').pop()
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push(f)
}

const bad = []
const ambiguous = []
let total = 0
for (const f of files) {
  const lines = readFileSync(`${ROOT}/${f}`, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!/^\s*(\/\/|\*|\/\*)/.test(line)) return          // 只看注释行
    for (const m of line.matchAll(CIT)) {
      const [, ref, numRaw] = m
      const num = Number(numRaw)
      total += 1
      // 解析被引文件：优先"仓库相对路径"精确命中；否则用 basename——
      // ★ 但 basename **有歧义时跳过**，不许猜。第一版直接取第一个候选，
      //   于是 `serve.mjs:2540` 被判成"超出 616 行"（真身是 `workbench/scripts/
      //   serve.mjs`，2606 行，那一行完全合法）。一个会猜的解析器
      //   制造出来的"缺陷"，与一个真的缺陷，在报告里长得一模一样。
      let cand = byPath.get(ref)
      if (cand === undefined) {
        const same = byBase.get(ref.split('/').pop()) ?? []
        if (same.length !== 1) { ambiguous.push(`${f}:${i + 1} → ${ref}:${num}（${same.length} 个同名文件）`); continue }
        cand = same[0]
      }
      let target
      try { target = readFileSync(`${ROOT}/${cand}`, 'utf8').split('\n') } catch { continue }
      if (num > target.length) {
        bad.push({ from: `${f}:${i + 1}`, ref: `${ref}:${num}`, why: `超出文件行数（共 ${target.length} 行）`, txt: '' })
        continue
      }
      const t = (target[num - 1] ?? '').trim()
      if (t === '' || /^[)}\];,]+$/.test(t)) {
        bad.push({ from: `${f}:${i + 1}`, ref: `${ref}:${num}`, why: '那一行是空行或收尾符', txt: t.slice(0, 40) })
      }
    }
  })
}
console.log(`扫了 ${files.length} 个产品文件，注释里的 file.mjs:NNN 引用共 ${total} 处`)
console.log(`★ 确定性有问题：${bad.length} 处；因同名歧义跳过 ${ambiguous.length} 处\n`)
for (const b of bad) {
  console.log(`  ${b.from}\n      → ${b.ref}  ${b.why}${b.txt ? '  「' + b.txt + '」' : ''}`)
}
