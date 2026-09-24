// scratch/_mutate-suite-counts.mjs —— 变异：全路径解析（第 36 轮的真缺陷）（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/scripts/prt/suite-counts.mjs`
const orig = readFileSync(MOD, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', 'scripts/prt/suite-counts.test.mjs'],
      { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

function mut(name, find, repl) {
  if (!orig.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, orig.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, orig, 'utf8')
}

try {
  // ★ S1 就是这一轮那个 bug 本身：把目录砍掉
  mut('S1 回到 `m[1].split(\'/\').pop()`（**这一轮那个 bug 本身**）',
    'out.push({ row: row[1], line: i + 1, name: m[1], claim: Number(m[2]) })',
    "out.push({ row: row[1], line: i + 1, name: m[1].split('/').pop(), claim: Number(m[2]) })")

  // ★ S2 去掉"全路径优先"分支 ⇒ 准确的全路径又会被同名文件撞成 ambiguous
  mut('S2 去掉全路径分支（准确的引用又被撞成 ambiguous）',
    "    if (c.name.includes('/')) {", '    if (false) {')

  // ★ S3 去掉"带目录的归一化"分支 ⇒ 模块名带目录落进 unresolved
  mut('S3 去掉带目录的 `.mjs` → `.test.mjs` 归一化',
    "      if (sib !== null && byPath.has(sib)) return { ...c, kind: 'file', files: [sib] }",
    '      if (false) {')

  // ★ S4 歧义不再报（同名多文件猜第一个）
  mut('S4 同名多文件不再报 ambiguous（改成猜第一个）',
    "    if (asFile.length > 1) return { ...c, kind: 'ambiguous', files: asFile }",
    "    if (asFile.length > 1) return { ...c, kind: 'file', files: [asFile[0]] }")

  // ★ S5 带扩展名的模块名不做归一化（第一版那个 `x.mjs.test.mjs` 的错）
  mut('S5 去掉带扩展名模块名的归一化（第一版那个错）',
    "      : `${c.name.replace(/\\.(mjs|cjs|js|ts)$/, '')}.test.mjs`\n    const asFile",
    "      : `${c.name}.test.mjs`\n    const asFile")
} finally {
  writeFileSync(MOD, orig, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`逐字还原 ? ${readFileSync(MOD, 'utf8') === orig}`)
console.log(`还原后判据仍绿 ? ${green()}`)
