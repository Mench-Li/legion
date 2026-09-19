// scratch/_mutate-declaration-mirrors.mjs —— 破验 `scripts/prt/declaration-mirrors.mjs`
//
// ★ 规矩（第 40 轮立的）：
//   1. **新进程**跑（否则模块缓存里的旧版本会被读成"没咬住"）；
//   2. **换行无关**——文件是 CRLF，裸 `\n` 的 find 串会静默不匹配，
//      而"变异串没找到"与"变异被咬住"在输出上都是"没有漏网"；
//   3. 变异必须覆盖出 bug 的**每一行**；
//   4. 不许**假变异体**（两版行为完全相同 ⇒ 永远不咬，会被读成"判据漏了"）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = 'D:/project/DSH/legion'
const TARGET = 'scripts/prt/declaration-mirrors.mjs'
const SUITE = 'scripts/prt/declaration-mirrors.test.mjs'
const CRLF = /\r?\n/
const snap = (p) => createHash('sha256').update(readFileSync(`${ROOT}/${p}`)).digest('hex')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
const write = (p, s) => writeFileSync(`${ROOT}/${p}`, s)

/** 把带 `\n` 的串转成 CRLF 无关的正则，用于定位。 */
const toRe = (s) => new RegExp(s.split('\n').map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n'))
const toFile = (s) => s.replace(/\r?\n/g, '\r\n')

const MUTANTS = [
  {
    name: 'M1 口径回退：把"键位"改回"字符串出现过"（第 41 轮修的那个 17 张误报）',
    file: TARGET,
    find: "    `^\\\\s*${e}\\\\s*:`\n    + `|[{,]\\\\s*${e}\\\\s*:`\n    + `|[{,]\\\\s*${e}\\\\s*[,}]`\n    + `|^\\\\s*${e}\\\\s*$`,",
    repl: "    `'${e}'|\\\"${e}\\\"`,",
  },
  {
    name: 'M2 门槛抹掉：命中 1 个成员就算"重建"（假阳性泛滥）',
    file: TARGET,
    find: 'return hitCount >= 2 && hitCount * 2 >= total',
    repl: 'return hitCount >= 1',
  },
  {
    name: 'M3 注释行也算复述（`// data: 业务状态` 变成"第二份实现"）',
    file: TARGET,
    find: "    const code = line.replace(/\\/\\/.*$/, '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')",
    // ★ M3 第一版漏网：不是判据漏了，是**夹具没构造出键位形状的注释**
    //   （`// data: 业务状态` 前面有 `// `，本来就匹配不上 `^\s*data\s*:`）。
    //   ⑤ 的夹具已改成 `// 展开成 { data: ..., cache: ... } 那种形状` + 一条反向控制。
    repl: '    const code = line',
  },
  {
    // ★★ M4 的第一版是 `if (isDeclarationLine(i)) continue` → `if (false) continue`，
    //    **漏网**了。查下来是**那道守卫走不到**（数组声明里的成员永远带引号，
    //    键位规则在声明那段里没有可命中的形状）——详见
    //    `scratch/_probe-decl-exclusion.mjs`。
    //    但它**不是**无害的：当声明与真实代码同一行时，整行跳过会丢掉真凭据
    //    （`export const F = Object.freeze([...]); const row = { key: 1 }`）。
    //    所以改成"只挖声明那一段"，并把 M4 换成**能咬住**的这个变异：
    name: 'M4 挖掉的范围放大到**整行**（同一行上的真代码被丢掉）',
    file: TARGET,
    find: "  return text.replace(re, (m) => m.replace(/[^\\n]/g, ' '))",
    repl: '  return text.split(/\\r?\\n/).map((l) => (re.test(l) ? l.replace(/[^\\n]/g, \' \') : l)).join(\'\\n\')',
  },
  {
    name: 'M5 遍历点永远算 0（⇒ 所有表都变成"装饰"，判据淹没在噪声里）',
    file: TARGET,
    find: '  const iterSites = hits\n',
    repl: '  const iterSites = 0 * hits.length\n',
  },
  {
    name: 'M6 遍历点永远算 1（⇒ 真装饰表全部漏网）',
    file: TARGET,
    find: '  const iterSites = hits\n',
    repl: '  const iterSites = 1 || hits.length\n',
  },
  {
    name: 'M7 R1 关掉（装饰表不再被判红）',
    file: TARGET,
    find: '    if (r.decorative && !allowed.has(r.name)) {',
    repl: '    if (false && r.decorative && !allowed.has(r.name)) {',
  },
  {
    name: 'M8 R2 关掉（过期豁免不再判红 ⇒ 豁免表变成一句没人核的话）',
    file: TARGET,
    find: '    if (!decorativeNow.has(a.name)) {',
    repl: '    if (false && !decorativeNow.has(a.name)) {',
  },
  {
    name: 'M9 R3 的"理由够不够长"改成永远通过',
    file: TARGET,
    find: "    if (typeof a.why !== 'string' || a.why.length < 20) {",
    repl: "    if (false && (typeof a.why !== 'string' || a.why.length < 20)) {",
  },
  {
    name: 'M10 R4 自证关掉（判据不再证明自己能分辨"修复前/后"）',
    file: TARGET,
    find: '  if (before.length === 0 || !before.every((r) => r.decorative === true)) {',
    repl: '  if (false && (before.length === 0 || !before.every((r) => r.decorative === true))) {',
  },
  {
    name: 'M11 `git grep` 只在退出码 1 时返回空——改成**任何**非零都吞（ENOENT 会变成"没有匹配"）',
    file: TARGET,
    find: '    if (e.status === 1) return []\n    throw e',
    repl: '    return []',
  },
  {
    name: 'M12 一次 grep 改回"每个名字一次"（功能等价但慢 124 倍——这不是缺陷，是记录）',
    file: TARGET,
    find: '  const hits = (hitsReader ?? ((names) => readAllHits(names, exec)))(parsed.map((p) => p.name))',
    repl: '  const hits = (hitsReader ?? ((names) => names.flatMap((n) => readAllHits([n], exec))))(parsed.map((p) => p.name))',
    expectBite: false,
  },
]

const before = snap(TARGET)
let bitten = 0
const escaped = []
const notFound = []

for (const m of MUTANTS) {
  const src = read(m.file)
  const re = toRe(m.find)
  if (!re.test(src)) {
    notFound.push(m.name)
    console.log(`  ⚠ 变异串没找到：${m.name}`)
    continue
  }
  write(m.file, src.replace(re, () => toFile(m.repl)))
  let failed = false
  try {
    execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
  } catch (e) {
    failed = true
  }
  write(m.file, src) // 逐字节还原
  const restored = snap(m.file) === before
  const expectBite = m.expectBite !== false
  if (failed === expectBite) {
    bitten += 1
    console.log(`  ✔ 咬住（用例红）：${m.name}${restored ? '' : '  ⚠ 还原失败！'}`)
  } else if (!expectBite) {
    console.log(`  ✔ 如期不咬（等价重构）：${m.name}`)
  } else {
    escaped.push(m.name)
    console.log(`  ✖ 漏网（用例仍绿）：${m.name}`)
  }
  if (!restored) throw new Error(`还原不是逐字节的：${m.file}`)
}

const finalOk = snap(TARGET) === before
console.log(`\n变异 ${bitten}/${MUTANTS.filter((m) => m.expectBite !== false).length} 咬住`
  + `（另 ${MUTANTS.filter((m) => m.expectBite === false).length} 个等价重构如期不咬）；`
  + `漏网 ${escaped.length}；变异串没找到 ${notFound.length}；还原逐字节 ${finalOk}`)
if (escaped.length > 0 || notFound.length > 0 || !finalOk) process.exit(1)
// 还原后必须复绿
execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
console.log('还原后 12/12 复绿')
