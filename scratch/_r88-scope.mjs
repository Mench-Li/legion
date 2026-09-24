// scratch/_r88-scope.mjs —— 第 88 轮：给"请先看它"那一节的**根因**加一条定界注
//
// ★ 问题：L177-188 把 `isRuntimeOnlyRow` / `inject: [ENFORCEMENT_ROOT_SERVICE]` 讲成 ★★★ **根因**，
//   而同节 L193-194 引的那两行注释说的是**另一层**（"四项必需能力里三项如实报未确认"）。
//   ★★ 第 63～68 轮量到：**决定性的那一层是后者** —— 三项在源码里是**写死的 `satisfied: false` 字面量**。
//   ⇒ 一个照 L186-188 去修 `isRuntimeOnlyRow` 的人，会发现**门禁还是红的**。
//
// ★ 纪律：不改第 63 轮那段读数（它当时看到的就是这个），只在它后面加一条**标了轮次**的定界注。
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

sub('**第 87 轮结束时的读数**（全部可复跑）：', '**第 88 轮结束时的读数**（全部可复跑）：')

sub(
  '- 而 `runtime-host-row.mjs:587` 写着 `inject: [ENFORCEMENT_ROOT_SERVICE]` —— 它**在等一个依赖服务**。',
  '- 而 `runtime-host-row.mjs:587` 写着 `inject: [ENFORCEMENT_ROOT_SERVICE]` —— 它**在等一个依赖服务**。\n'
  + '\n'
  + '> ★★★★★ **第 88 轮给上面这五行加一条定界注（那段读数一字未改）**：\n'
  + '> 上面讲的是**表面机制** —— 它解释的是"**自检报的那句话是从哪来的**"。\n'
  + '> 而**决定性的那一层是下面引的那两行注释**（"四项必需能力里三项如实报未确认"）：\n'
  + '> 第 63～68 轮量到那三项在源码里是**写死的 `satisfied: false` 字面量**\n'
  + '> （`runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` 的 `runtimeCapabilityEvidence()` 函数体内恰好 3 处），\n'
  + '> 而 probe 要求"**显式为 true**" ⇒ **`autoExecutionForbidden` 恒为 true，与本机平台无关**。\n'
  + '>\n'
  + '> ⇒ **一个照上面那五行去修 `isRuntimeOnlyRow` / `inject` 的人，会发现门禁还是红的。**\n'
  + '> 那两行**挂上或摘掉，行为等价**（它们自己的注释就这么写）—— 所以"未激活"是**症状**，不是**开关**。\n'
  + '> 真正的开关是**那三个常量**。\n'
  + '>\n'
  + '> ★★ 而第 85 轮独立复现过：那 21 条红在今天 HEAD 上**仍然是 36 通过 / 21 失败**，与第 63 轮一字不差。\n'
  + '>\n'
  + '> > 一份把**症状**写成"根因"的报告，会让接手的人**修一个修不好门禁的地方**，\n'
  + '> > 然后得出"这个仓库的自检根本修不动"这个结论 —— 而那个结论是错的。',
)

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
console.log('  OK "请先看它"那一节已加定界注（第 88 轮）')
