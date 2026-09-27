// scripts/probes/_probe-t2-seam2.mjs
// T2 立缝**第二刀**的变异验证：`reconcile` 里"卸载不再需要的空间"提成具名函数 `unmountStale`。
//
// 这一刀与第一刀的区别，正是判据要核的东西：
//   第一刀把"捕获 `logFile`"变成"传参"；第二刀**没有**改状态所有权（它仍捕获 `mounted`/`log`），
//   所以它"行为逐字不变"的理由是**同作用域**，而不是"依赖变少了"。
//   ⇒ 判据必须核两件事：① 那段逻辑**有名字了** ② 那段逻辑**没有变成两份**。
//
// ★ 全部内存 fixture：读真文件、在字符串上扰动、断言红/绿，不写磁盘。
import { readFileSync } from 'node:fs'
import { extractSymbol } from './probe-slice-verbatim.mjs'

const F = 'plugins/src/index.ts'
const REAL = readFileSync(F, 'utf8')

const LOOP_HEAD = 'for (const scope of [...mounted.keys()]) {'
const CALL = 'unmountStale(desiredScopes)'
const MARK = 'T2 立缝第二刀'
// ★ 核刀痕要核到**调用点那一条**：`T2 立缝第二刀` 在具名函数的文档注释里**也有一份**，
//   所以只查这个短语的话，删掉调用点的刀痕仍然绿（本探针第一次跑就栽在这 —— 而且我当时
//   还把这个红探针提交了，因为那条命令只把门禁电池算进退出码，没算探针本身）。
const CALL_MARK = '这段已提成上面的具名函数'

/** 结构判据：返回违规列表（空 = 合规）。 */
export function checkSeamTwo(text) {
  const v = []
  const sup = extractSymbol(text, 'superviseSpaces')
  if (sup === null) return ['① 取不到 superviseSpaces']

  // ① 名字存在，且是 superviseSpaces 内的具名函数
  if (!/^\s{2}function unmountStale\(desiredScopes: Set<string>\): void \{/m.test(sup)) {
    v.push('① 具名函数 `unmountStale(desiredScopes)` 不在 superviseSpaces 里 ⇒ 这一刀没落')
  }
  // ② 同一段逻辑不许变成两份（名字在、原地的循环也还在 = 最坏形态：两份实现）
  const loops = sup.split(LOOP_HEAD).length - 1
  if (loops !== 1) v.push(`② 那段循环在 superviseSpaces 里应有 **1** 份（在具名函数体内），实际 ${loops} 份`
    + ' ⇒ 要么原地的还在（两份实现），要么连具名函数里的都没了')
  // ③ 调用点必须存在，且带刀痕
  if (!sup.includes(CALL)) v.push('③ 没有调用点 `unmountStale(desiredScopes)` ⇒ 提出来了却没人用')
  if (!sup.includes(CALL_MARK)) v.push('③ 调用点没有**刀痕标记** ⇒ 读这段的人不知道这里被切过、改去哪改')
  // ④ 不该动的：挂载那一侧（真正"起"空间的地方）必须原样
  if ((sup.split('mounted.set(child.scope, mountRunner(child))').length - 1) !== 1) {
    v.push('④ 挂载侧被动过（`mounted.set(child.scope, mountRunner(child))` 应恰好 1 处）'
      + ' ⇒ 这一刀只管"卸载"，不许顺手动"挂载"')
  }
  return v
}

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✖'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures += 1
}

// ⓪ 真仓库：零违规（合规行不许被误报）
{
  const v = checkSeamTwo(REAL)
  check('⓪ 真仓库零违规', v.length === 0, v.join(' | '))
}

// ① 反向：把这段退回"没有名字"（抽掉具名函数，保留调用点）⇒ 必须红
{
  const t = REAL.replace(/^  function unmountStale\(desiredScopes: Set<string>\): void \{/m, '  function renamedIt(desiredScopes: Set<string>): void {')
  check('① 具名函数被改名/删除 ⇒ 红', checkSeamTwo(t).some((x) => x.startsWith('①')), checkSeamTwo(t)[0] ?? '（没红！）')
}

// ② 反向：两份实现（具名函数在，原地循环也塞回去）⇒ 必须红
{
  const t = REAL.replace(CALL, `${CALL}\n      ${LOOP_HEAD}\n        if (desiredScopes.has(scope)) continue\n      }`)
  check('② 逻辑变成两份 ⇒ 红', checkSeamTwo(t).some((x) => x.startsWith('②')), checkSeamTwo(t)[0] ?? '（没红！）')
}

// ③ 反向：删掉刀痕 ⇒ 必须红（★ 核的是刀痕本身，不是"含不含函数名"——第一刀那次就栽在这）
{
  const t = REAL.replace(`      // ★ ${MARK}（2026-09-24）：这段已提成上面的具名函数 \`unmountStale\`。\n`, '')
  check('③ 刀痕被删 ⇒ 红', checkSeamTwo(t).some((x) => x.startsWith('③')), checkSeamTwo(t)[0] ?? '（没红！）')
}

// ④ 反向：顺手把挂载侧也动了 ⇒ 必须红（"一次一刀"的守卫）
{
  const t = REAL.replace('mounted.set(child.scope, mountRunner(child))', 'mounted.set(child.scope, mountRunner2(child))')
  check('④ 顺手动挂载侧 ⇒ 红', checkSeamTwo(t).some((x) => x.startsWith('④')), checkSeamTwo(t)[0] ?? '（没红！）')
}

if (failures > 0) { console.log(`\n  ⇒ 有 ${failures} 处不达预期`); process.exit(1) }
console.log('\n  ⇒ T2 立缝第二刀：结构判据 + 4 条反向控制全过（行为层由 `cd plugins && npm test` 兜）')
