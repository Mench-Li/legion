/**
 * 变异测试：把 v4 的**正则处理**关掉 ⇒ 第五种对照必须变红。
 *
 * ★ 第一步（PowerShell 的 `-replace`）造出的是**语法错误**，
 *   而"变异版退出码=1"看起来与"变异成功、对照变红"一模一样。
 *   ——本会话早记过这条（探针造出语法错误却报"全红"）。
 *   ⇒ 所以这里先 `node --check`，语法不过就直接报"变异无效"，不当结论用。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SRC = 'scratch/scan-silent-declarations3.mjs'
const MUT = 'scratch/_mut-scanner.mjs'

const src = readFileSync(SRC, 'utf8')
const needle = "if (c === '/' && regexAllowedAfter(prev)) {"
if (!src.includes(needle)) {
  console.log('★ 找不到锚点，变异无效（不要把它读成"没变异也能过"）')
  process.exit(1)
}
// 让那个分支**永不进入**：语法保持完好，只是正则处理不再发生
const mut = src.replace(needle, 'if (false) { // 变异：关掉正则处理')
writeFileSync(MUT, mut, 'utf8')

// ① 先确认变异版**语法是好的**——否则"退出码 1"什么也说明不了
try {
  execFileSync('node', ['--check', MUT], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log('✔ 变异版语法通过（这一条必须先过，否则下面的红不算数）')
} catch (e) {
  console.log('✖ 变异版语法就不过 ⇒ **变异无效**，不是"对照变红"')
  console.log(String(e.stderr ?? '').split('\n').slice(0, 3).join('\n'))
  unlinkSync(MUT)
  process.exit(1)
}

// ② 跑变异版，看对照说什么
let out = ''
let code = 0
try {
  out = execFileSync('node', [MUT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) {
  out = String(e.stdout ?? '')
  code = e.status ?? 1
}

const tail = out.split('\n').filter((l) => l.trim() !== '').slice(-9).join('\n')
console.log('\n=== 变异版输出（尾部）===')
console.log(tail)
console.log(`\n变异版退出码 = ${code}`)

const controlFailed = out.includes('✗ 正对照') || code !== 0
const caughtRegex = out.includes('第五种被误报')
console.log('\n=== 结论 ===')
if (controlFailed && caughtRegex) {
  console.log('  ✔ 关掉正则处理 ⇒ 对照变红，且**指名**是第五种（readAfterRegex）被误报')
  console.log('  ⇒ 这条对照是真的：它能抓住 v4 第一版那个"吞掉真读者"的事故。')
} else if (controlFailed) {
  console.log('  ⚠️ 对照红了，但没指名第五种 ⇒ 红的可能是别的原因，不能当这条对照的证据')
} else {
  console.log('  ✖ 关了正则处理对照仍然 ✓ ⇒ 第五种对照是**装饰**')
}
unlinkSync(MUT)
