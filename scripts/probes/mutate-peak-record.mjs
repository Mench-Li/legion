/**
 * 变异验证：新加的那些判据**真的会咬**吗？
 *
 * ★ 起因：本会话反复出现的失败模式是"判据看着绿、其实什么也没查"。
 *   上面 47 条里有一大半是我这一轮新写的，而**新写的判据第一次跑就是绿的**——
 *   这既可能是"确实没问题"，也可能是"它根本没在看"。
 *   ⇒ 只有把被测的机制**改坏**、看它红不红，才能把这两者分开。
 *
 * ⚠️ 纪律：每次变异后**先 `node --check`**，语法错的变异体不能用来读退出码——
 *   本会话栽过一次："exit code 1"在"语法错误"与"判据咬住了"两种情况下长得一样。
 *   恢复后必须 `git diff` 为空（只碰 run-record.mjs，它是干净的）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SRC = 'product/launcher/run-record.mjs'
const TEST = 'product/launcher/run-record.test.mjs'
const original = readFileSync(SRC, 'utf8')

// ★★ 本仓工作树是 **CRLF**，而我在下面按 `\n` 写变异点 ⇒ `includes()` 一个都找不到。
//   我第一次跑时 6 个变异点有 **2 个报"找不到"**，而那个输出长得像
//   "这两个变异点我写错了"——**不是**，是行尾。
//   > 一个"变异点写错了"与一个"文件是 CRLF 而我按 LF 找"，在只看"找没找到"的输出里
//   > 是同一个东西；区别是前者要改脚本，后者只要改行尾。
//   ⇒ 把变异点**统一转成文件实际的行尾**，而不是在每处手写 `\r\n`。
const EOL = original.includes('\r\n') ? '\r\n' : '\n'
const adapt = (s) => s.split('\n').join(EOL)

/** 跑一次测试，返回 { ok, failed:[名字] }。 */
function runTests() {
  try {
    const out = execFileSync('node', ['--test', TEST], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function failedNames(out) {
  const names = []
  for (const line of out.split('\n')) {
    const m = /^\s*✖ (.+?) \(\d/.exec(line)
    if (m) names.push(m[1].trim())
  }
  return [...new Set(names)]
}

const MUTANTS = [
  {
    name: '把 peakResource 从 buildRunRecord 里**删掉**（回到"算出来然后丢掉"）',
    from: '      peakResource: normalizePeakResource(p?.peakResource),\n',
    to: '',
    expect: /落盘|closed|闭合|带上|峰值/,
  },
  {
    name: '把 peakResource 加进 RUN_RECORD_FIELDS（旧记录会判死）',
    from: "export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])",
    to: "export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image', 'peakResource'])",
    expect: /旧记录|前向兼容|孤儿/,
  },
  {
    name: '让 normalizePeakResource 恒返回 null（形状对了、读数没了）',
    from: 'export function normalizePeakResource(v) {\n  if (v === null || v === undefined) return null',
    to: 'export function normalizePeakResource(v) {\n  return null\n  if (v === null || v === undefined) return null',
    expect: /落盘|峰值/,
  },
  {
    name: '把"ok=false 不许带测量值"那条判据删掉',
    from: '          if (pr.ok === false) {',
    to: '          if (false) {',
    expect: /不许写 0|0 是测量结论|变异/,
  },
  {
    name: '把 ok 强制布尔化改成永远 true（"没采到"与"采到了"同形）',
    from: '    ok: v.ok === true,',
    to: '    ok: true,',
    expect: /ok|落盘|峰值/,
  },
  {
    name: '把可选字段的形状检查整段删掉（坏形状静默通过）',
    from: "        if (typeof pr !== 'object' || Array.isArray(pr)) {",
    to: '        if (false) {',
    expect: /既不是 null 也不是对象|坏形状|形状/,
  },
]

const results = []
for (const m of MUTANTS) {
  const from = adapt(m.from)
  const to = adapt(m.to)
  if (!original.includes(from)) {
    results.push({ name: m.name, verdict: '★ 变异点找不到（脚本要改）' })
    continue
  }
  writeFileSync(SRC, original.replace(from, to), 'utf8')

  // ⚠️ 先语法检查：语法错的变异体，它的"红"不能算判据咬住了
  let syntaxOk = true
  try { execFileSync('node', ['--check', SRC], { stdio: 'ignore' }) } catch { syntaxOk = false }

  if (!syntaxOk) {
    results.push({ name: m.name, verdict: '✖ 变异体语法就错了 ⇒ 这次读数无效' })
  } else {
    const r = runTests()
    const names = failedNames(r.out)
    const hit = r.ok === false && names.some((n) => m.expect.test(n))
    results.push({
      name: m.name,
      verdict: hit ? `✔ 咬住（${names.length} 条红）` : (r.ok ? '✖ **没咬住**（全绿）' : `? 红了但不是预期的那些：${names.slice(0, 3).join(' / ')}`),
    })
  }
  writeFileSync(SRC, original, 'utf8')
}

// 恢复自检：文件必须回到原样
const restored = readFileSync(SRC, 'utf8') === original
console.log('\n=== 变异验证 ===')
for (const r of results) console.log(`  ${r.verdict.padEnd(30)} ${r.name}`)
console.log('')
console.log(restored ? '✔ 源码已完全恢复' : '✖ ★★ 源码没有恢复干净，必须手工检查！')
console.log(`咬住 ${results.filter((r) => r.verdict.startsWith('✔')).length}/${MUTANTS.length}`)
