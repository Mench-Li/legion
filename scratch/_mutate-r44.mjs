// scratch/_mutate-r44.mjs —— 破验第 44 轮的修复：主动停止时那一行 peak-resource
//
// ★ 规矩（第 40 轮立）：新进程跑 / 换行无关 / 锚点唯一 / 不许假变异体。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = 'D:/project/DSH/legion'
const TARGET = 'product/launcher/supervisor.mjs'
const SUITE = 'product/launcher/supervisor.test.mjs'

const FIX_LINE = '      if (!disposed) reportPeakResource()'

const MUTANTS = [
  {
    name: 'M1 ★★★ 回到修之前：主动停止那条路径直接 return（成功 Run 的峰值又没人印）',
    find: FIX_LINE,
    repl: '      // 变异：不报',
  },
  {
    name: 'M2 ★★ 无条件报（连 dispose() 之后也往可能已关的 sink 里写）',
    find: FIX_LINE,
    repl: '      reportPeakResource()',
  },
  {
    // ★ 判据必须落在"那一行**带真读数**"上，不能只数条数：
    //   只数条数的话，印一行"peak-resource: ok"的废话也能过。
    name: 'M3 ★★ 印一行**没有读数**的废话（条数对、内容假）',
    find: FIX_LINE,
    repl: "      log('info', 'peak-resource: ok')",
  },
  {
    name: 'M4 ★★ 采不到时印一个像读数的 0（"不知道"与"零"同形）',
    find: '    if (reading === null) {',
    repl: '    if (false) {',
  },
  {
    name: 'M5 ★★ 读数只在 status() 上留、句柄方法摘掉（结构性消费者被绕开）',
    find: '    peakResource: readPeakResource,',
    repl: '    peakResource: () => null,',
  },
]

const snap = (p) => createHash('sha256').update(readFileSync(`${ROOT}/${p}`)).digest('hex')
const toRe = (s) => new RegExp(s.split('\n').map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n'))
const toFile = (s) => s.replace(/\r?\n/g, '\r\n')
const before = snap(TARGET)

let bitten = 0
const escaped = []
const notFound = []

for (const m of MUTANTS) {
  const src = readFileSync(`${ROOT}/${TARGET}`, 'utf8')
  const re = toRe(m.find)
  if (!re.test(src)) { notFound.push(m.name); console.log(`  ⚠ 变异串没找到：${m.name}`); continue }
  writeFileSync(`${ROOT}/${TARGET}`, src.replace(re, () => toFile(m.repl)))
  let failed = false
  let why = ''
  try {
    execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
  } catch (e) {
    failed = true
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    why = /SyntaxError|Cannot find|does not provide an export/.test(out) ? '（加载期失败）' : '（用例红）'
  }
  writeFileSync(`${ROOT}/${TARGET}`, src)
  const restored = snap(TARGET) === before
  if (!restored) throw new Error(`还原不是逐字节的：${TARGET}`)
  if (failed) { bitten += 1; console.log(`  ✔ 咬住${why}：${m.name}`) }
  else { escaped.push(m.name); console.log(`  ✖ 漏网（用例仍绿）：${m.name}`) }
}

console.log(`\n变异 ${bitten}/${MUTANTS.length} 咬住；漏网 ${escaped.length}；`
  + `变异串没找到 ${notFound.length}；还原逐字节 ${snap(TARGET) === before}`)
if (escaped.length > 0 || notFound.length > 0) process.exit(1)
execFileSync('node', ['--test', SUITE], { cwd: ROOT, stdio: 'pipe', timeout: 600000 })
console.log('还原后 supervisor 25/25 复绿')
