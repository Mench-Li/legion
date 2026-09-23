// scripts/probes/_mutate-r43.mjs —— 破验第 43 轮的两处修复
//
//   A. `product/upgrade/preflight.mjs`：裁决词表 ⇒ 归类表（汇总不许有"没归类"的缝）
//   B. `runtime/context/bpe.mjs`        ：BPE_ARTIFACT_FIELDS 升格成形状判据
//
// ★ 规矩（第 40 轮立）：新进程跑 / 换行无关 / 锚点唯一 / 不许假变异体。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = 'D:/project/DSH/legion'
const A = { file: 'product/upgrade/preflight.mjs', suite: 'product/upgrade/preflight.test.mjs' }
const B = { file: 'runtime/context/bpe.mjs', suite: 'runtime/context/bpe.test.mjs' }

const MUTANTS = [
  // ───────────── A：裁决词表 ─────────────
  {
    ...A,
    name: 'A1 ★★★ 汇总改回手写的两行（第四个裁决会从缝里过去）',
    // ★ 修好后这条**换成改分桶函数本身**：把"跟随归类表"改回"恰好认两个词"。
    find: "    if (kind === 'blocking') { blockedChecks.push(c); continue }\n"
      + "    if (kind === 'unknown') { unknownChecks.push(c); continue }",
    repl: '    if (c.verdict === \'blocked\') { blockedChecks.push(c); continue }\n'
      + '    if (c.verdict === \'unknown\') { unknownChecks.push(c); continue }',
  },
  {
    ...A,
    name: 'A2 ★★ 未声明的裁决不再抛（静默当成可以通过）',
    find: '  const kind = kinds[verdict]\n  if (kind === undefined) {',
    repl: '  const kind = kinds[verdict]\n  if (false) {',
  },
  {
    ...A,
    name: 'A3 ★★ 未声明的裁决返回 clear（等于自动放行）',
    find: '    throw preflightError(PREFLIGHT_CODES.VERDICT_UNKNOWN,',
    repl: '    return \'clear\' // ',
  },
  {
    ...A,
    name: 'A4 ★★ 对齐守卫关掉（加了裁决却不归类不再被拦）',
    find: '    ok: unclassified.length === 0 && orphan.length === 0 && clear.length === 1,',
    repl: '    ok: true,',
  },
  {
    ...A,
    name: 'A5 ★★ "通行"裁决允许多个（放行条件被放宽）',
    find: '&& clear.length === 1,',
    repl: '&& clear.length >= 0,',
  },
  {
    ...A,
    name: 'A6 ★★ 归类表把 blocked 错归成 clear（拦人的裁决变成放行）',
    find: "  blocked: 'blocking',",
    repl: "  blocked: 'clear',",
  },
  // ───────────── B：产物形状 ─────────────
  {
    ...B,
    name: 'B1 ★★★ 清单改回漏掉 ranks 的样子（产物有、清单没有）',
    find: "  'name', 'model', 'pattern', 'vocab', 'merges', 'ranks', 'evidence',",
    repl: "  'name', 'model', 'pattern', 'vocab', 'merges', 'evidence',",
  },
  {
    ...B,
    name: 'B2 ★★ 构造处不再校验形状（清单退回成一句说明）',
    find: '  return assertBpeArtifactShape(\n    Object.freeze({ name, model, evidence, vocab, merges: raw.merges, ranks, pattern }), { fields },\n  )',
    repl: '  return Object.freeze({ name, model, evidence, vocab, merges: raw.merges, ranks, pattern })',
  },
  {
    ...B,
    name: 'B3 ★★ 校验只看"少了什么"、不看"多了什么"（清单变成"至少要有"）',
    find: '    ok: missing.length === 0 && extra.length === 0,',
    repl: '    ok: missing.length === 0,',
  },
  {
    ...B,
    name: 'B4 ★★ 少了字段时构造处不抛（静默返回错形状的产物）',
    find: "  if (!w.ok) {\n    throw new Error('parseTokenizerArtifact：产物形状与 BPE_ARTIFACT_FIELDS 不符——'",
    repl: "  if (false) {\n    throw new Error('parseTokenizerArtifact：产物形状与 BPE_ARTIFACT_FIELDS 不符——'",
  },
  {
    ...B,
    name: 'B5 ★★ w.ok 恒真（校验结果不被读）',
    find: '    missing: Object.freeze(missing),\n    extra: Object.freeze(extra),',
    repl: '    ok: true,\n    missing: Object.freeze(missing),\n    extra: Object.freeze(extra),',
  },
  {
    ...B,
    name: 'B6 ★★ 产物少一个字段（ranks 真的不产出了）⇒ 形状判据必须红',
    find: 'merges: raw.merges, ranks, pattern })',
    repl: 'merges: raw.merges, pattern })',
  },
]

const snap = (p) => createHash('sha256').update(readFileSync(`${ROOT}/${p}`)).digest('hex')
const toRe = (s) => new RegExp(s.split('\n').map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n'))
const toFile = (s) => s.replace(/\r?\n/g, '\r\n')

const before = Object.fromEntries([A.file, B.file].map((f) => [f, snap(f)]))
let bitten = 0
const escaped = []
const notFound = []

for (const m of MUTANTS) {
  const src = readFileSync(`${ROOT}/${m.file}`, 'utf8')
  const re = toRe(m.find)
  if (!re.test(src)) { notFound.push(m.name); console.log(`  ⚠ 变异串没找到：${m.name}`); continue }
  writeFileSync(`${ROOT}/${m.file}`, src.replace(re, () => toFile(m.repl)))
  let failed = false
  let why = ''
  try {
    execFileSync('node', ['--test', m.suite], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
  } catch (e) {
    failed = true
    // ★ 区分两种"红"：用例真的红了 / 文件根本没加载起来（语法或构造期抛）
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    why = /SyntaxError|Cannot find|does not provide an export/.test(out) ? '（加载期失败）' : '（用例红）'
  }
  writeFileSync(`${ROOT}/${m.file}`, src)
  const restored = snap(m.file) === before[m.file]
  if (!restored) throw new Error(`还原不是逐字节的：${m.file}`)
  if (failed) { bitten += 1; console.log(`  ✔ 咬住${why}：${m.name}`) }
  else { escaped.push(m.name); console.log(`  ✖ 漏网（用例仍绿）：${m.name}`) }
}

console.log(`\n变异 ${bitten}/${MUTANTS.length} 咬住；漏网 ${escaped.length}；变异串没找到 ${notFound.length}；`
  + `还原逐字节 ${[A.file, B.file].every((f) => snap(f) === before[f])}`)
if (escaped.length > 0 || notFound.length > 0) process.exit(1)
execFileSync('node', ['--test', A.suite], { cwd: ROOT, stdio: 'pipe', timeout: 600000 })
execFileSync('node', ['--test', B.suite], { cwd: ROOT, stdio: 'pipe', timeout: 600000 })
console.log('还原后 preflight 21/21、bpe 32/32 复绿')
