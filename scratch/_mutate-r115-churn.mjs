// scratch/_mutate-r115-churn.mjs — 破验（第二轮）：退出码映射 / 机器可读行 / CI 接线
//   M1: exitCodeFor 把"读不到"与"未降温"合并回 2   ⇒ 期望 ⑧ 红
//   M2: exitCodeFor 缺判定时当"降温"               ⇒ 期望 ⑧ 红
//   M3: exitCodeFor 的 strict 失效（恒 0）          ⇒ 期望 ⑦ 红
//   M4: 不打印 CHURN_VERDICT 行                    ⇒ 期望 ⑨ 红
//   M5: CHURN_VERDICT 的 cooled 写死成 true        ⇒ 期望 ⑨ 红
//   M6: run-ci.mjs 把"读不到"(2) 与"未降温"(3) 混为一谈 ⇒ 期望 run-ci 自检红
// 逐条改坏 → 跑 → 还原；用字节比较确认还原干净。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const CHURN = 'scripts/prt/hot-file-churn.mjs'
const CI = 'scripts/ci/run-ci.mjs'
const SUITE = ['--test', 'scripts/prt/hot-file-churn.test.mjs']

const MUTANTS = [
  ['M1 读不到与未降温合并成 2', CHURN,
    '  if (!res || res.ok !== true) return CHURN_EXIT.UNREADABLE', '  if (!res || res.ok !== true) return CHURN_EXIT.NOT_COOLED'],
  ['M2 缺判定当成降温', CHURN,
    '  if (res.verdict?.cooled !== true) return CHURN_EXIT.NOT_COOLED', '  if (res.verdict?.cooled === undefined) return CHURN_EXIT.COOLED'],
  ['M3 --strict 失效（恒 0）', CHURN,
    '  if (!strict) return CHURN_EXIT.COOLED', '  if (strict) return CHURN_EXIT.COOLED'],
  ['M4 删掉 CHURN_VERDICT 行', CHURN,
    '  console.log(`CHURN_VERDICT cooled=', '  console.log(`_DISABLED_ cooled='],
]

const BAK = (f) => `${f}.mutbak`
let bad = 0
const snapshots = new Map()
for (const f of [CHURN, CI]) {
  copyFileSync(f, BAK(f))
  snapshots.set(f, readFileSync(f))
}

// ★★★ 还原**必须**在每一个可能退出的路径上发生。
//
// 第一版只在 `finally` 里还原，而它跑满了两分钟被外部**强杀**——
// 于是 `M5` 的变异（`cooled=true`）**留在了工作区里**，而进程没有任何机会报告它。
// 第二次跑时 `BAK` 快照照的是一个**已被改坏**的文件，整轮结果因此无效。
//
//   > 一个"我写了 finally 所以一定会还原"的印象，
//   > 与一个"强杀时 finally 一次都没跑到"的事实，
//   > 在我没有去核**工作区字节**的时候是同一个东西——只不过它还顺手
//   > 把下一轮测量也污染了。
//
// 处置：① 每条变异跑完**立刻**还原，不攒到 finally；② 每轮开始前先断言
// 工作区与快照逐字节相同（上一轮若留了残渣，这里当场报出来而不是继续量）。
const restoreAll = () => {
  for (const f of [CHURN, CI]) if (existsSync(BAK(f))) copyFileSync(BAK(f), f)
}
const assertClean = (when) => {
  for (const [f, snap] of snapshots) {
    if (Buffer.compare(snap, readFileSync(f)) !== 0) {
      console.log(`✖ ${when}：工作区 ${f} 与快照**不同**——上一轮留了残渣，本轮结果不可信`)
      restoreAll()
      process.exit(1)
    }
  }
}

const runSuite = (files) => {
  try {
    execFileSync(process.execPath, files, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true // green
  } catch {
    return false // red
  }
}

try {
  for (const [name, file, from, to] of MUTANTS) {
    assertClean(`变异前 ${name}`)
    const text = readFileSync(BAK(file), 'utf8')
    if (!text.includes(from)) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(file, text.replace(from, to))
    const green = runSuite(SUITE)
    console.log(`${green ? '✖' : '✔'} ${name} → ${green ? '**没咬住**' : '咬住（红）'}`)
    if (green) bad++
    copyFileSync(BAK(file), file) // ← 立刻还原，不等 finally
  }

  // M6/M7 走同一套判据（⑩ 核的是源码里的约定，所以改坏 run-ci.mjs 就会红）
  const ciSnapshot = readFileSync(BAK(CI), 'utf8')
  for (const [name, from, to] of [
    ['M6 CI 侧退回裸数字', 'if (rh.code === CHURN_EXIT.COOLED || rh.code === CHURN_EXIT.NOT_COOLED) {', 'if (rh.code === 0 || rh.code === 2) {'],
    ['M7 CI 不再单独处理"读不到"', '    if (rh.code === CHURN_EXIT.UNREADABLE) {', '    if (false) {'],
  ]) {
    assertClean(`变异前 ${name}`)
    if (!ciSnapshot.includes(from)) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(CI, ciSnapshot.replace(from, to))
    const green = runSuite(SUITE)
    console.log(`${green ? '✖' : '✔'} ${name} → ${green ? '**没咬住**' : '咬住（红）'}`)
    if (green) bad++
    copyFileSync(BAK(CI), CI)
  }
} finally {
  let same = true
  for (const f of [CHURN, CI]) {
    restoreAll()
    unlinkSync(BAK(f))
    if (Buffer.compare(snapshots.get(f), readFileSync(f)) !== 0) same = false
  }
  console.log(`还原逐字节相同：${same ? '✔' : '✖'}`)
  if (!same) process.exit(1)
}
if (bad > 0) process.exit(1)
