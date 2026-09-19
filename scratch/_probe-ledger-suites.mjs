// scratch/_probe-ledger-suites.mjs —— 台账证据栏点名的套件，解得开吗？（**不提交**）
//
// ★ 纪律（本仓第 31 轮用血换来的三条）：
//   ① 只在**被跟踪**的文件里找（`git ls-files`）——`worktrees/` 副本会把同名数撑大；
//   ② 裸名要按**惯例**解析，不能每条独立全局搜；
//   ③ 零命中**不等于**不存在——先问"它在这儿叫什么"。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO = 'D:/project/DSH/legion'
const tracked = execFileSync('git', ['ls-files', '*.test.mjs'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
const trackedAll = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\n').map((s) => s.trim()).filter(Boolean)

const lines = readFileSync(`${REPO}/docs/superpowers/prt/PRT-PROGRESS.md`, 'utf8').split(/\r?\n/)
const rows = []
for (const [i, line] of lines.entries()) {
  const t = line.trim()
  if (!t.startsWith('|')) continue
  const cells = t.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length < 3) continue
  const m = /^(PRT-\d+)/.exec(cells[0])
  if (m === null || cells[1] !== '✅') continue
  rows.push({ prt: m[1], line: i + 1, evidence: cells[2] })
}

// 收集点名（套件 `x` 与 `...test.mjs`）
const mentions = []
for (const r of rows) {
  for (const m of r.evidence.matchAll(/套件\s*`([^`]+)`/g)) mentions.push({ ...r, name: m[1], kind: '套件' })
  for (const m of r.evidence.matchAll(/`([A-Za-z0-9][\w./-]*\.test\.mjs)`/g)) mentions.push({ ...r, name: m[1], kind: '文件名' })
}

/** 一个套件名解得开吗：① 它是路径 → 直接存在；② 裸名 → 某个被跟踪的 test 文件的路径含它。 */
function resolve(name) {
  if (name.includes('/')) {
    if (tracked.includes(name)) return { how: '路径原样', hits: [name] }
    const hits = tracked.filter((f) => f.endsWith('/' + name))
    return hits.length === 1 ? { how: '路径后缀唯一', hits } : { how: null, hits }
  }
  // 裸名：先在只取 basename 的意义上找同名文件
  const base = name.endsWith('.test.mjs') ? name : null
  if (base !== null) {
    const hits = tracked.filter((f) => f.split('/').pop() === base)
    if (hits.length === 1) return { how: '裸文件名唯一', hits }
    if (hits.length > 1) return { how: '裸文件名不唯一', hits }
    return { how: null, hits: [] }
  }
  // 套件别名：某个 test 文件的名字里含它
  const hits = tracked.filter((f) => f.split('/').pop().startsWith(name))
  if (hits.length > 0) return { how: '别名前缀', hits }
  return { how: null, hits: [] }
}

const unresolved = []
const hows = {}
for (const m of mentions) {
  const r = resolve(m.name)
  const key = r.how ?? '**解不开**'
  hows[key] = (hows[key] ?? 0) + 1
  if (r.how === null || r.how === '裸文件名不唯一') unresolved.push({ ...m, hits: r.hits })
}
console.log('点名总数 =', mentions.length)
console.log('解析方式分布：', JSON.stringify(hows, null, 1))
console.log(`\n解不开 / 不唯一的：${unresolved.length}`)
for (const u of unresolved) {
  console.log(`  ${u.prt} L${u.line} [${u.kind}] \`${u.name}\``)
  if (u.hits.length > 0) for (const h of u.hits) console.log(`       候选: ${h}`)
}
