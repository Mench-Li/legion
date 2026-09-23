// 破坏性验证（PRT-509 定位器那处生产缺陷）：改 → 跑 → **无论如何还原**。
//
// 还原写在 `finally` 里（不是"跑完之后"）——见 PRT-SESSION-REPORT §10.2
// 记的那个失效模式。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'product/launcher/run-credential-materialization.mjs'
const TEST = 'product/launcher/run-credential-materialization.test.mjs'

function run() {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', TEST], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    })
  } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? '') }
  const f = /ℹ fail (\d+)/.exec(out)
  return { failed: f === null ? -1 : Number(f[1]), names: [...out.matchAll(/^✖ (.+?) \(/gm)].map((x) => x[1].trim()) }
}

// ★★ 锚点必须锚在**代码**上，不能锚在**注释**上——而第一版正是锚错了：
//
//   `/const usable = \(r\) =>[\s\S]*?&& typeof r\.resolve === 'function'/` 会先命中
//   上面那段注释里**逐字抄了一遍**旧代码的那一行（`:301`），于是脚本改的是注释，
//   而真正的代码（`:328`）一个字没动。表现为"这条变异**没咬住**"。
//
//  > 一条"改了注释所以行为不变"的变异，与一条"靶子根本没被改到"的变异，
//  > 在 harness 的读数上是同一个"没咬住"——只不过前者的结论是"这段代码
//  > 没有对应判据"，而后者是"我的锚点写错了"。
//
//   区分它们的方式在锚点里：新代码那一行是 `r !== null && r !== undefined`，
//   而注释里抄的是 `r !== null && typeof r === 'object'`。锚在新代码独有的那半句上，
//   注释就再也匹配不到了。
const GOOD_RE = /const usable = \(r\) => r !== null && r !== undefined[\s\S]*?&& typeof r\.resolve === 'function'/
const BAD = `const usable = (r) => r !== null && typeof r === 'object' && typeof r.resolve === 'function'`

const original = readFileSync(SRC, 'utf8')
const found = original.match(GOOD_RE)
if (found === null) { console.log('★ 锚点没找到——靶子不是我以为的那段，先停下'); process.exit(1) }
console.log(`锚点（${JSON.stringify(found[0].slice(0, 40))}…，长度 ${found[0].length}）`)

let ok = 0
try {
  const base = run()
  console.log(`基线：fail=${base.failed}`)
  if (base.failed !== 0) throw new Error('基线不绿，先修基线')

  writeFileSync(SRC, original.replace(GOOD_RE, BAD))
  let r
  try { r = run() } finally { writeFileSync(SRC, original) }

  const bit = r.failed > 0
  if (bit) ok++
  console.log(`${bit ? '✔' : '✖'} ㉙ 还原成"必须是对象"（= 第一版那处缺陷）→ 实际 fail=${r.failed}`)
  for (const n of r.names.slice(0, 4)) console.log(`      ✖ ${n}`)
} finally {
  if (readFileSync(SRC, 'utf8') !== original) { writeFileSync(SRC, original); console.log('已还原') }
}

const restored = readFileSync(SRC, 'utf8') === original
console.log(`\n破坏性验证：${ok}/1 条咬住；还原逐字节一致 = ${restored}`)
process.exit(ok === 1 && restored ? 0 : 1)
