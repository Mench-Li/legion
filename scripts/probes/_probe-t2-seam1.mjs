// scripts/probes/_probe-t2-seam1.mjs
// T2 立缝第一刀的**变异验证**（目标要求：每条都要有可复跑判据 + 变异验证）。
//
// 这一刀的性质决定了它的判据来源有两层：
//   ① **行为层**：`cd plugins && npm test`（409 例 / 10 套件 / 0 失败）—— 由 CI 跑，不在本探针里；
//   ② **结构层**（本探针）：这一刀"该做的都做了、**不该动的没动**"。
//      第二句是重点：同一段日志闭包在 `spaceWorker` 里**还有一份**，
//      而"顺手一起统一"会让两边跑起来不等价 —— 所以"另一份原样还在"必须被核。
//
// ★ 全部内存 fixture：读真文件、在字符串上扰动、断言红/绿，**不写磁盘**。
import { readFileSync } from 'node:fs'
import { extractSymbol } from './probe-slice-verbatim.mjs'

const F = 'plugins/src/index.ts'
const REAL = readFileSync(F, 'utf8')

/** 结构判据：返回违规列表（空 = 合规）。 */
export function checkSeamOne(text) {
  const v = []
  const top = /^function makeFileLogger\(logFile: string\): \(msg: string\) => void \{/m.test(text)
  if (!top) v.push('① 顶层具名工厂 makeFileLogger(logFile) 不在（这一刀没落，或又被塞回闭包）')

  const sup = extractSymbol(text, 'superviseSpaces')
  if (sup === null) v.push('① 取不到 superviseSpaces')
  else {
    if (!sup.includes('const log = makeFileLogger(logFile)')) {
      v.push('② superviseSpaces 里没有 `const log = makeFileLogger(logFile)` ⇒ 日志不再来自那个具名工厂')
    }
    if (/const log = \(msg: string\): void =>/.test(sup)) {
      v.push('② superviseSpaces 里**还留着**原闭包 ⇒ 具名工厂成了摆设（两份实现并存，正是这一刀要避免的）')
    }
    // ★ 第一版这里写的是"含不含 `makeFileLogger`" —— 那太弱：调用行 `const log = makeFileLogger(logFile)`
    //   自己就含这个词，于是**删掉回引这条反向控制根本不红**（本探针第一次跑就栽在这）。
    //   核的是**刀痕标记**本身：切口处必须留下"这里是第一刀、要改去哪改"的说明。
    if (!sup.includes('T2 立缝第一刀')) {
      v.push('③ 切口处没有**刀痕标记**（读这段的人不会知道日志行为该去哪里改，也不会知道这里被切过）')
    }
  }
  // ★ 不该动的：spaceWorker 里那份同类闭包必须**原样保留恰好 1 份**
  const copies = text.split('const log = (msg: string): void =>').length - 1
  if (copies !== 1) v.push(`④ spaceWorker 里那份同类闭包应原样保留 **1** 份，实际 ${copies} 份`
    + ' ⇒ "一次一刀"被破坏（另一处不该在这一刀里被动）')
  return v
}

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✖'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures += 1
}

// ⓪ 真文件：零违规（合规行不许被误报）
{
  const v = checkSeamOne(REAL)
  check('⓪ 真仓库零违规', v.length === 0, v.join(' | '))
}

// ① 反向：把工厂改回闭包（等价于"这一刀没做"）⇒ 必须红
{
  const t = REAL.replace('const log = makeFileLogger(logFile)', 'const log = (msg: string): void => {}')
  const v = checkSeamOne(t)
  check('① 撤回这一刀（改回闭包）⇒ 红', v.length > 0, v[0] ?? '（没红！）')
}

// ② 反向：删掉顶层工厂（只剩调用点）⇒ 必须红
{
  const t = REAL.replace(/^function makeFileLogger\(logFile: string\): \(msg: string\) => void \{/m, 'function renamed(logFile: string): (msg: string) => void {')
  const v = checkSeamOne(t)
  check('② 顶层工厂被改名/删除 ⇒ 红', v.some((x) => x.startsWith('①')), v[0] ?? '（没红！）')
}

// ③ 反向：把切口处的**刀痕标记**删掉（只删标记那一行，回引别的行还在）⇒ 必须红
{
  const t = REAL.replace('  // ★ T2 立缝第一刀（2026-09-24）：这段原本是**捕获 `logFile` 的闭包**，已提成顶层\n', '')
  const v = checkSeamOne(t)
  check('③ 刀痕标记被删 ⇒ 红', v.some((x) => x.startsWith('③')), v[0] ?? '（没红！）')
}

// ④ 反向：顺手把 spaceWorker 里那份也"统一"了 ⇒ 必须红（"一次一刀"的守卫）
{
  const t = REAL.replace('const log = (msg: string): void =>', 'const log = makeFileLogger(logFile) // 顺手统一')
  const v = checkSeamOne(t)
  check('④ 顺手统一另一处 ⇒ 红（不该动的被动过）', v.some((x) => x.startsWith('④')), v[0] ?? '（没红！）')
}

if (failures > 0) { console.log(`\n  ⇒ 有 ${failures} 处不达预期`); process.exit(1) }
console.log('\n  ⇒ T2 立缝第一刀：结构判据 + 4 条反向控制全过（行为层由 `cd plugins && npm test` 兜）')
