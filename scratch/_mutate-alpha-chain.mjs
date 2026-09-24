// scratch/_mutate-alpha-chain.mjs —— 变异：§9 链投影判据（**不提交**）
//
// ★ 这一族最容易写出的假绿是"**一个永远匹配不上的分支**"：
//   `core` 里写个不在 `modules` 里的路径 ⇒ 那一节永远判不出硬断 ⇒ 恒绿。
//   所以变异里要有"把某节的核心标记挪走"这一条。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/prt/alpha-chain-trace.mjs`
const BASELINE = `${ROOT}/docs/superpowers/prt/prt-reachability-baseline.json`

const orig = readFileSync(MOD, 'utf8')
const baseOrig = readFileSync(BASELINE, 'utf8')
let all = true

const suiteGreen = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/alpha-chain-trace.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl, file = MOD, original = orig) {
  if (!original.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(file, original.replace(find, repl), 'utf8')
  const g = suiteGreen()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(file, original, 'utf8')
}

try {
  // ① 把"核心缺席 ⇒ 硬断"改成只看文件存在（丢掉 gap 那一维）
  mut('M1 硬断判据忽略 `gap`（只查文件在不在）',
    'const bad = !present || cls === \'gap\'', 'const bad = !present')

  // ② 把硬断降级成"至少有活实现就算过"（第一版那个太弱的判据）
  mut('M2 硬断判据退化成"至少一个模块可达"',
    'hardBroken: brokenCore.length > 0,',
    'hardBroken: mods.filter((m) => m.present && m.unreachableClass !== \'gap\').length === 0,')

  // ③ 把软缺口并进硬断（两种状态同形）
  mut('M3 软缺口被并进硬断（L7/L9 会被误报成硬断）',
    'hardBroken: brokenCore.length > 0,',
    'hardBroken: brokenCore.length > 0 || brokenSupport.length > 0,')

  // ④ allGreen 退化成"没有硬断"
  mut('M4 `allGreen` 退化成"没有硬断"（软缺口等于没被报）',
    'const allGreen = sections.every((s) => !s.hardBroken && !s.softGap)',
    'const allGreen = sections.every((s) => !s.hardBroken)')

  // ⑤ ★★ 核心标记写成一条不存在的路径 ⇒ 那一节永不硬断
  mut('M5 ★★ L5 的核心标记改成一条不存在的路径（恒绿分支）',
    "core: Object.freeze(['runtime/dsh-composition/plugins/runtime-contract-server-row.mjs']),",
    "core: Object.freeze(['runtime/dsh-composition/plugins/NOT-A-REAL-ROW.mjs']),")

  // ⑥ 往链定义里塞一条不存在的模块路径
  mut('M6 链定义里塞一条不存在的路径',
    "'product/launcher/cli.mjs',\n      'product/init.mjs',",
    "'product/launcher/cli.mjs',\n      'product/NO-SUCH-FILE.mjs',\n      'product/init.mjs',")

  // ⑦ 基线里把 L5 那条 gap 改判掉 ⇒ 那一节会被误判成"可达"
  mut('M7 基线里 L5 的核心模块那条记录被改名（读不到分类）',
    '"file": "runtime/dsh-composition/plugins/runtime-contract-server-row.mjs"',
    '"file": "runtime/dsh-composition/plugins/RENAMED-row.mjs"',
    BASELINE, baseOrig)

  // ⑧ 核心理由写空（"没有理由的核心标记"）
  // ★★ 第一版这条**是个假变异**：我只替换了多行拼接的**第一行**，
  //    后面几行仍然拼上来，字符串长度没变 ⇒ 判据当然不红。
  //    —— 这与本仓记过的"变异必须覆盖缺陷的每一行"是同一条。
  mut('M8 ★ L5 的 coreWhy 整段退化成一句短话',
    "    coreWhy: 'worker（`product/orchestrator/worker.mjs`）与 DSH Runtime 是**两个进程**，'\n"
    + "      + '所以同进程的 `bindDshRuntime()` **填多好都不会改变 worker 的读数**'\n"
    + "      + '（`runtime-contract-server-row.mjs:9-10` 逐字写着这句）。'\n"
    + "      + '这一行就是那条缝上唯一的监听器 ⇒ 不挂 = worker 报 `EXECUTOR_HOST_PORT_REQUIRED`、'\n"
    + "      + '**不认领任何任务**（`同文件:24`）。',",
    "    coreWhy: '短',")

  // ── 第二格：断点归属（第 34 轮）──────────────────────────────────────
  mut('M9 去掉"有断点却没归属"那条规则（回到没有归属概念）',
    "    if (hasBreak && declared === undefined) {", '    if (false) {')
  mut('M10 去掉"归属指到空处"那条规则',
    '    if (hasBreak && !itemNumbers.has(declared)) {', '    if (false) {')
  mut('M11 去掉"归属已过期"那条规则',
    '    if (!hasBreak && declared !== undefined) {', '    if (false) {')
  mut('M12 去掉"§5 表解析不出来就失败"的守卫',
    '  if (itemNumbers === null) {', '  if (false) {')
  mut('M13 L7 的归属改指一条不存在的 §5 条目',
    '    owner: 28,\n    ownerWhy: \'第 28 条逐字点名了',
    '    owner: 77,\n    ownerWhy: \'第 28 条逐字点名了')
  mut('M14 L9 的归属整条删掉（那一节就没人认领了）',
    "    owner: 16,\n    ownerWhy: '第 16 条把这一批模块列成",
    "    ownerWhy: '第 16 条把这一批模块列成")
  mut('M15 归属改成文件路径（不是条目编号）',
    '    owner: 20,', "    owner: 'runtime/dsh-composition/plugins/runtime-contract-server-row.mjs',")
} finally {
  writeFileSync(MOD, orig, 'utf8')
  writeFileSync(BASELINE, baseOrig, 'utf8')
}

console.log('\n全部咬住 ? ' + all)
console.log('两个文件逐字还原 ? ' + (readFileSync(MOD, 'utf8') === orig)
  + ' ' + (readFileSync(BASELINE, 'utf8') === baseOrig))
console.log('还原后套件全绿 ? ' + suiteGreen() + '（期望 true）')
