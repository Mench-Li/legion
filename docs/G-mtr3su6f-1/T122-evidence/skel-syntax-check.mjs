// docs/G-mtr3su6f-1/T122-evidence/skel-syntax-check.mjs —— T-122 TEST_CASES.md 附录 B JS 骨架语法校验
// 运行：node docs/G-mtr3su6f-1/T122-evidence/skel-syntax-check.mjs [--out <evidence.txt>]
// 把文档中 fenced js 代码块逐个写到系统临时目录并以 node --check 校验（解析级，不做语义执行），
// 结果以 UTF-8 写回 --out 指定的证据文件。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const outIdx = process.argv.indexOf('--out')
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null
const rec = []
const say = (s) => { rec.push(s); console.log(s) }

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = join(HERE, '..', 'TEST_CASES.md')
const text = readFileSync(DOC, 'utf8')
const lines = text.split(/\r?\n/)
const FENCE_OPEN = '```js'
const FENCE_CLOSE = '```'

// 提取 fenced js 块（B.1..B.6）
const blocks = []
let cur = null
for (const ln of lines) {
  const t = ln.trim()
  if (t === FENCE_OPEN) { cur = []; continue }
  if (t === FENCE_CLOSE && cur) { blocks.push(cur.join('\n')); cur = null; continue }
  if (cur) cur.push(ln)
}
if (cur) blocks.push(cur.join('\n'))

say('node ' + process.version)
say('JS 代码块数量：' + blocks.length)
if (blocks.length !== 6) say('注意：期望 6 个 js 块（B.1~B.6），实际 ' + blocks.length)

const dir = mkdtempSync(join(tmpdir(), 't122-skel-'))
let fails = 0
blocks.forEach((code, i) => {
  const file = join(dir, 'b' + (i + 1) + '.mjs')
  writeFileSync(file, code, 'utf8')
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (r.status === 0) { say('B.' + (i + 1) + ' node --check PASS') }
  else { fails++; say('B.' + (i + 1) + ' node --check FAIL（exit ' + r.status + '，诊断见上方 stderr）') }
})
rmSync(dir, { recursive: true, force: true })

say(fails > 0 ? 'RESULT: FAIL（' + fails + ' 块语法不通过）' : 'RESULT: PASS（全部 JS 骨架语法通过）')
if (OUT) writeFileSync(OUT, rec.join('\n') + '\n', 'utf8')
process.exit(fails > 0 ? 1 : 0)
