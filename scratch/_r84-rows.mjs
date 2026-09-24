// scratch/_r84-rows.mjs —— 第 84 轮：家族行 + 把这次真 CI 的读数写进人工清单
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 44)}`); return }
  t = t.replace(f, tt)
}
sub('**第 83 轮结束时的读数**（全部可复跑）：', '**第 84 轮结束时的读数**（全部可复跑）：')

if (!/^\| 84 \|/m.test(t)) {
  const ROW = '| 84 | ★★★★★ **跑了一次完整 CI：8/9 PASS，唯一的红是"没登记的套件"** —— '
    + '本次 `--out .ci/r84-full` 九阶段：`syntax` PASS · **`env` PASS**（第 82 轮那处损坏修好）· `boundary` PASS · '
    + '`deps` PASS · `build` PASS · **`test` FAIL** · ★ **`smoke` PASS**（r51 那次是 FAIL）· `stage` PASS · `doc` PASS。'
    + '★ `test` 只跑了 **4899ms** 就红 —— 因为它**卡在套件登记闸门**上（'
    + '「把它们加进 stageTest 的 suites（或放进某个套件的 cwd 相对路径下 / 登记到 EXEMPT 并写明理由）」），'
    + '而那一串是 **~16 个 `team-hub/*-routes.test.mjs`** = ★ **并行会话正在加的新路由测试**，不是我的。'
    + '★★★★★ **而这条"卡在登记闸门"有一个要紧的推论**：闸门**在跑任何套件之前**就退了 ⇒ '
    + '**这次 CI 根本没有测到第 63 轮那 21 条产品红。**'
    + '> ⇒ 同样是 "test FAIL"，r51 那次是**跑了、红在产品上**，这次是**没跑、红在登记上** ——'
    + '> **两个不同的读数，写着同一个词**。所以**不能说那 21 条修好了，只能说这次没量到。**'
    + '★ 本轮同时把 `DECISION-BRIEF.md` 里**第 28 条**那三处也撤回了（它是最危险的传播缺口：'
    + '那份文档的唯一用途就是"把那 29 条压成你要说的那一句话"，'
    + '一个只读它的人会去**说一句不需要说的话**）。'
    + '★ 也照 CI 自己的免责声明引用：跑在**脏树**上（19 改 + 703 未跟踪，指纹 `7967d77fe4c6d1db`）⇒ '
    + '证明的是「**这棵树**」，不是「提交 4f37c9b」。 |'
  const lines = t.split('\n')
  const i83 = lines.findIndex((l) => /^\| 83 \|/.test(l))
  if (i83 < 0) bad.push('  x 找不到 | 83 |')
  else { lines.splice(i83 + 1, 0, ROW.split('\n').join(eol)); t = lines.join('\n'); console.log('  OK 家族表加第 84 行') }
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
