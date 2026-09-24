// scratch/_r93-rows.mjs —— 第 93 轮：★★★★★ 甲**不是发明** —— 那份文件自己的头与一条**通过的**用例已经写好了正确期望
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 46)}`); return }
  t = t.replace(f, tt)
}
sub('**第 92 轮结束时的读数**（全部可复跑）：', '**第 93 轮结束时的读数**（全部可复跑）：')

const ANCHOR = '#### ★★★★★ 第 92 轮：接着"逐条读"'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 92 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 93 轮：**甲不是发明** —— 那份文件自己的头与一条**通过的**用例，已经把正确期望写好了',
    '',
    '第 63 轮我把裁决 **Ⅰ** 交给您时，说法是"二选一：接受这个设计（改 21 条用例的期望），',
    '或者给那三项能力真来源"。**那让 甲 听起来像一次我自己发明的改写。**',
    '',
    '★ 本轮接着逐条读，撞到一件把这件事**变简单**的事实。',
    '',
    '#### 一、那条失败的用例**自己文件里的头**，写的是**相反的**期望',
    '',
    '`runtime-host-binding-unblocked-dsh-process.test.mjs` 的头（L369-380）写着：',
    '',
    '> ① 进程**活着**走到脚手架',
    '> ② 绑定服务**在**、而且是**具名拒绝**（`SELF_CHECK_INCOMPATIBLE`，带内层码）',
    '> ③ **`dshRuntimeBound() === false`** —— **宿主端口没有被注册**，安全方向一点没放松',
    '> ④ 契约出口把这条拒绝翻成 `autoExecutionForbidden: true` + `incompatible`',
    '',
    '★★ 而**同文件里那条失败的用例**（L693）断言的是：',
    '',
    '```',
    '③ ★★★ 绑定真的建立：自检通过、服务发布、`dshRuntimeBound() === true`、exit 0',
    '```',
    '',
    '⇒ **头说 `false`，用例说 `true`。** 同一份文件里，两处说了相反的话。',
    '',
    '#### 二、而且**那条"接受设计"的用例已经写好了、并且是绿的**',
    '',
    '同文件 **②**（L623）断言：',
    '',
    '```',
    "guarded('② ★★★ 生产注册方当那一行的模块 → 工厂**成功**；自检不兼容时**不抛**，进程活着、端口没绑上'",
    'assert.equal(r.code, 0, …)',
    "assert.equal(reading(r.stderr, 'INCOMPATCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE)",
    "assert.equal(reading(r.stderr, 'INCOMPATSTATE'), 'incompatible')",
    "assert.equal(reading(r.stderr, 'INCOMPATFORBID'), 'true')",
    "assert.equal(reading(r.stderr, 'INCOMPATREPAIR'), 'true')",
    '```',
    '',
    '★ 而 **② 是通过的**（它不在那 21 条里）。',
    '',
    '#### ⇒ 这把 Ⅰ 从"一次设计决定"变成了"**对齐**"',
    '',
    '**甲不是发明一个新期望**：这个仓库**已经**在同文件的头（L374）与一条**通过的**用例（②，L623）里',
    '把正确期望写下来了 —— 而失败的那几条**没有跟上**。',
    '',
    '| 说法 | 听起来的代价 | 实际 |',
    '|---|---|---|',
    '| 我第 63 轮的说法：「改那 21 条的期望」 | 像一次**由我发明的**大改写 | ★ 对齐到**仓库自己已写下、且已有一条绿用例**的东西 |',
    '',
    '★ 所以 Ⅰ 的两条路的代价**不对称**：',
    '',
    '- **甲** = 把没跟上的用例对齐到本仓**已经写好的**结论（同文件头 + ② 的形状），外加第 92 轮那几条**反向对照**要重新设计条件；',
    '- **乙** = 给 `tool-permission-enforcement` / `cancel-and-timeout` / `usage-reporting` 三项**真来源** —— 而那要改**引擎契约**（`SubagentResult` 没有用量字段），**不在本仓范围内**。',
    '',
    '★★★★★ **本轮最值记的一点**：',
    '',
    '> 我把 Ⅰ 摆成一个"要不要接受这个设计"的取舍 ——',
    '> 而**本仓早在同一份文件里就接受了它**：头写着 `false`、② 断言着 `incompatible`、而 ② 是绿的。',
    '>',
    '> ⇒ 缺的从来不是**一个决定**，是**让那几条没跟上的用例跟上**。',
    '',
    '★ 一个"这需要您决定要不要接受一个设计"的框架，与一个"设计**已经被接受过**、只是几条用例没跟上"的事实，',
    '在我**没有把那份文件从头读到尾**的时候是同一个东西。',
    '',
    '★ 而这一步之所以走到，仍然只是因为**逐条读**（第 91 轮读标题、第 92 轮读输入、本轮读**文件头**）。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK §三之三 已插入第 93 轮那节')
}

if (!/^\| 93 \|/m.test(t)) {
  const ROW = '| 93 | ★★★★★ **甲不是发明** —— 那份文件自己的头与一条**通过的**用例已把正确期望写好 —— '
    + '第 63 轮我把 Ⅰ 说成"二选一：接受设计（改 21 条期望）／给三项能力真来源"，**那让甲像一次我发明的改写**。'
    + '★ 本轮逐条读（这次读**文件头**）撞到：`runtime-host-binding-unblocked-dsh-process.test.mjs` 的头（L369-380）写着'
    + '「③ **`dshRuntimeBound() === false`** —— 宿主端口没有被注册，安全方向一点没放松」，'
    + '而**同文件里那条失败的用例**（L693）断言的是「自检通过、服务发布、**`dshRuntimeBound() === true`**、exit 0」'
    + '⇒ **头说 false，用例说 true**。'
    + '★★ 更关键：同文件 **②**（L623）已经断言了"接受设计"那一侧'
    + '（`exit 0` / `INCOMPATCODE === SELF_CHECK_INCOMPATIBLE` / `INCOMPATSTATE === incompatible` / `INCOMPATFORBID === true` / `INCOMPATREPAIR === true`）'
    + '—— **而 ② 是通过的**（它不在那 21 条里）。'
    + '⇒ **这把 Ⅰ 从"一次设计决定"变成了"对齐"**：甲**不是**发明新期望，本仓**已经**在头（L374）与一条**绿**用例（②）里写下了它，'
    + '只是失败的那几条**没跟上**。'
    + '★ 于是两条路的代价**不对称**：**甲** = 对齐到本仓已写好的结论 + 第 92 轮那几条**反向对照**重新设计条件；'
    + '**乙** = 给三项能力真来源，而那要改**引擎契约**（`SubagentResult` 没有用量字段），**不在本仓范围内**。'
    + '★★★★★ 最值记的一点：'
    + '> 我把 Ⅰ 摆成"要不要接受这个设计"——而**本仓早在同一份文件里就接受了它**（头写 `false`、② 断言 `incompatible`、② 是绿的）。'
    + '> ⇒ 缺的从来不是**一个决定**，是**让那几条没跟上的用例跟上**。'
    + '> 一个"这需要您决定要不要接受一个设计"的框架，与一个"设计**已经被接受过**、只是几条用例没跟上"的事实，'
    + '> 在我**没有把那份文件从头读到尾**的时候是同一个东西。'
    + '★ 走到这一步只是因为**逐条读**（91 读标题、92 读输入、93 读**文件头**）。 |'
  const lines = t.split('\n')
  const i92 = lines.findIndex((l) => /^\| 92 \|/.test(l))
  if (i92 < 0) bad.push('  x 找不到 | 92 |')
  else { lines.splice(i92 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 93 行') }
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
