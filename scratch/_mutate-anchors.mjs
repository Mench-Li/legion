// scratch/_mutate-anchors.mjs —— 变异验证新加的"理由内容"棘轮（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const F = 'D:/project/DSH/legion/scripts/config/config.test.mjs'
const MUT = [
  {
    name: 'M1 把理由正文改回旧的行号写法（符号从理由里消失）',
    find: "    + '装配点 `scopePortFromEnv()`（`root-row.mjs`）已接。最后一根线在 '",
    repl: "    + '装配点 `root-row.mjs:540` 已接。最后一根线在 '",
  },
  {
    name: 'M2 锚点符号指向一个不存在的东西（模拟"它搬走了而没人更新"）',
    find: "    symbol: 'connectorPortFromEnv(',",
    repl: "    symbol: 'connectorPortFromEnvTYPO(',",
  },
  {
    name: 'M3 锚点文件指错（模拟"缝其实不在那儿"）',
    find: "    file: 'runtime/dsh-composition/root.mjs',\n    symbol: 'ENFORCEMENT_CONFIG_FIELDS',",
    repl: "    file: 'runtime/dsh-composition/ghost.mjs',\n    symbol: 'ENFORCEMENT_CONFIG_FIELDS',",
  },
  {
    name: 'M4 新加一把键进 NOT_FORWARDED_YET 而忘了配锚点（反向检查）',
    find: "  LEGION_PATH_SCOPE: {\n    file: 'runtime/dsh-composition/plugins/root-row.mjs',\n    symbol: 'scopePortFromEnv(',\n  },",
    repl: '',
  },
]

const parse = (out) => {
  const s = /ℹ fail (\d+)/.exec(out)
  if (s) return Number(s[1])
  return /ℹ pass (\d+)/.test(out) ? 0 : -1
}
function run() {
  try {
    const out = execFileSync('node', ['--test', 'scripts/config/config.test.mjs'],
      { cwd: 'D:/project/DSH/legion', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { fail: parse(out), out }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return { fail: parse(out), out }
  }
}

const orig = readFileSync(F, 'utf8')
// ★ 这个文件是 CRLF，而我第一版用 `\n` 写多行锚点 ⇒ M3/M4 **"锚点没找到"**，
//   于是它们被记成"漏网"（`all=false`），而真相是**变异根本没做**。
//   "变异没执行"与"守卫没咬住"在输出上同形，处置完全相反：
//   前者要修脚本，后者要修守卫。（同族：一个没生效的变红验证，
//   与一个通过的验证，在输出上完全一样。）
const NL = orig.includes('\r\n') ? '\r\n' : '\n'
console.log('行尾: ' + (NL === '\r\n' ? 'CRLF' : 'LF'))
const norm = (s) => s.split('\n').join(NL)
console.log('基线：' + (run().fail === 0 ? '53/53 全绿' : '基线不绿！'))
let all = true
try {
  for (const m of MUT) {
    const find = norm(m.find)
    const repl = norm(m.repl)
    if (!orig.includes(find)) { console.log(`⚠ ${m.name}\n    锚点没找到`); all = false; continue }
    writeFileSync(F, orig.replace(find, repl), 'utf8')
    const { fail, out } = run()
    const msg = [...new Set([...out.matchAll(/AssertionError[^\n]*\n?[^\n]*/g)].map((x) => x[0].replace(/\s+/g, ' ').slice(0, 120)))]
    if (fail <= 0) all = false
    console.log(`${fail > 0 ? '✓ 咬住' : '✖ 漏网'} ${m.name}`)
    console.log(`     红 ${fail} 条；消息: ${msg[0] ?? '(无)'}`)
    writeFileSync(F, orig, 'utf8')
  }
} finally {
  writeFileSync(F, orig, 'utf8')
}
console.log('\n全部咬住 ? ' + all)
console.log('还原逐字相同 ? ' + (readFileSync(F, 'utf8') === orig))
console.log('还原后基线：' + (run().fail === 0 ? '53/53 全绿' : '还原失败！'))
