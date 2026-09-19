// scratch/_mutate-citations.mjs —— 变异验证 ⑪j / ⑪k 真的会咬（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const F = 'D:/project/DSH/legion/scripts/prt/boundary-facts.mjs'
const orig = readFileSync(F, 'utf8')
const NL = orig.includes('\r\n') ? '\r\n' : '\n'
const norm = (s) => s.split('\n').join(NL)

const MUT = [
  {
    // ★ 这个 bug 有**两处**（`key` 与 `to:`），第一版只改了一处 ⇒
    //   变异后守卫**照样绿**，于是被记成"⑪j 漏网"。
    //   而真因是**变异不完整**：`key` 变了、`to:` 没变，范围仍然被查。
    //   *"变异没做全"与"守卫没咬住"在输出里同形，处置相反。*
    name: 'M1 把范围终点改回 m[4]（两处一起复原）—— ⑪j 必须红',
    find: "    const key = `${m[1].replace(/\\\\/g, '/')}:${m[2]}${m[3] ? `-${m[3]}` : ''}`\n"
      + "    uniq.set(key, {\n"
      + "      path: m[1].replace(/\\\\/g, '/'),\n"
      + "      from: Number(m[2]),\n"
      + "      to: m[3] ? Number(m[3]) : Number(m[2]),\n"
      + '    })',
    repl: "    const key = `${m[1].replace(/\\\\/g, '/')}:${m[2]}${m[4] ? `-${m[4]}` : ''}`\n"
      + "    uniq.set(key, {\n"
      + "      path: m[1].replace(/\\\\/g, '/'),\n"
      + "      from: Number(m[2]),\n"
      + "      to: m[4] ? Number(m[4]) : Number(m[2]),\n"
      + '    })',
  },
  {
    name: 'M2 拆掉"空行/收尾符"那道检查 —— ⑪k 必须红',
    find: "    if (seg.every((s) => s === '' || /^[)}\\];,]+$/.test(s))) {",
    repl: "    if (false) {",
  },
]

const parse = (out) => {
  const s = /ℹ fail (\d+)/.exec(out)
  if (s) return Number(s[1])
  return /ℹ pass (\d+)/.test(out) ? 0 : -1
}
function run() {
  try {
    const out = execFileSync('node', ['--test', 'scripts/prt/boundary-facts.test.mjs'],
      { cwd: 'D:/project/DSH/legion', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { fail: parse(out), out }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return { fail: parse(out), out }
  }
}

console.log('基线：' + (run().fail === 0 ? '36/36 全绿' : '基线不绿！'))
let all = true
try {
  for (const m of MUT) {
    const find = norm(m.find); const repl = norm(m.repl)
    if (!orig.includes(find)) { console.log(`⚠ ${m.name}\n    变异串没找到（脚本问题，不是守卫问题）`); all = false; continue }
    writeFileSync(F, orig.replace(find, repl), 'utf8')
    const { fail, out } = run()
    const names = [...out.matchAll(/✖ (⑪[jk][^\n]*)/g)].map((x) => x[1].trim().slice(0, 68))
    if (fail <= 0) all = false
    console.log(`${fail > 0 ? '✓ 咬住' : '✖ 漏网'} ${m.name}`)
    console.log(`     红 ${fail} 条；${names.length ? '其中: ' + names.join(' | ') : '(未见 ⑪j/⑪k 命名，看下是不是别的测试红的)'}`)
    writeFileSync(F, orig, 'utf8')
  }
} finally { writeFileSync(F, orig, 'utf8') }
console.log('\n全部咬住 ? ' + all)
console.log('还原逐字相同 ? ' + (readFileSync(F, 'utf8') === orig))
console.log('还原后基线：' + (run().fail === 0 ? '36/36 全绿' : '还原失败！'))
