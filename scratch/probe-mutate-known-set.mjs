/**
 * 变异测试：给 `wireChecked` 加一个**代码读者** ⇒ 扫描器必须报"已知项不再出现"。
 *
 * 这一支（`removed`）正是本轮那次事故的那一支：读数从 3 变 0 时，
 * 脚本必须**说出来**，而不是安静地报 0。
 *
 * ★ 安全措施：改的是**已跟踪且干净**的文件，跑完用 `git checkout --` 还原，
 *   并**核对** `git diff` 为空才算还原成功（不靠"我记得还原了"）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TARGET = 'runtime/dsh-composition/runtime-contract-server.mjs'
const ORIG = readFileSync(TARGET, 'utf8')

// ★ 前置：改之前必须是干净的，否则还原会把别人的改动一起冲掉
const before = execFileSync('git', ['status', '--porcelain', '--', TARGET], { encoding: 'utf8' }).trim()
if (before !== '') {
  console.log(`✖ ${TARGET} 本来就不干净（${before}）⇒ 不做这个变异，避免误伤`)
  process.exit(1)
}

try {
  // 追加一行**会被算作"读者"的代码**（不执行，只让词频看到）
  writeFileSync(TARGET, `${ORIG}\nexport const __probeReadsWireChecked = wireChecked\n`, 'utf8')
  try {
    execFileSync('node', ['--check', TARGET], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('✔ 变异版语法通过')
  } catch {
    console.log('✖ 变异版语法不过 ⇒ 变异无效')
    process.exit(1)
  }

  let out = ''
  let code = 0
  try {
    out = execFileSync('node', ['scratch/scan-silent-declarations3.mjs'], { encoding: 'utf8' })
  } catch (e) { out = String(e.stdout ?? ''); code = e.status ?? 1 }

  const saidRemoved = out.includes('不再出现')
  const namedIt = /不再出现[^\n]*wireChecked|wireChecked[^\n]*不再出现/.test(out)
  console.log(`\n变异版：退出码=${code}  说了"不再出现"=${saidRemoved}`)
  if (saidRemoved) {
    console.log('  相关行：')
    for (const l of out.split('\n')) if (l.includes('不再出现') || l.includes('判据被弄瞎')) console.log(`    ${l.trim()}`)
  }
  console.log('\n=== 结论 ===')
  console.log(saidRemoved && code !== 0
    ? '  ✔ 加了读者 ⇒ 扫描器变红并指出"已知项不再出现" ⇒ 这一支真的在查'
    : '  ✖ 加了读者却没红（或没说"不再出现"）⇒ removed 那一支是装饰')
  void namedIt
} finally {
  // ★ 还原，并**核对**
  writeFileSync(TARGET, ORIG, 'utf8')
  const after = execFileSync('git', ['status', '--porcelain', '--', TARGET], { encoding: 'utf8' }).trim()
  console.log(after === ''
    ? `\n✔ ${TARGET} 已还原（git status 为空）`
    : `\n✖ 还原不干净：${after}`)
}
