// 审计（只读）：枚举"**导出了、但没有任何非测试生产调用方**"的符号。
//
// 缘起：第 113 轮发现 `ENFORCEMENT_IDENTITY_PASSTHROUGH` 的**唯一**调用方是用例
// ——它对生产零影响，而两处各自的判据都是绿的。那一类东西**不会自己现形**：
// 它们长得和"核心 API"一模一样。
//
// 这不是判据（不进门禁），是一份**审计读数**，用来回答"还有多少这种东西"。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from '../../scripts/prt/reachability.mjs'

const SRC_DIRS = ['product', 'runtime', 'orchestrator', 'security', 'services-plugin', 'team-hub']

function walkDir(dir, out = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'docs', 'dist', 'lib'].includes(e.name)) continue
      walkDir(p, out)
    } else if (e.name.endsWith('.mjs')) out.push(p)
  }
  return out
}

const isTest = (p) => /\.test\.mjs$/.test(p) || /[\\/]tests?[\\/]/.test(p) || /[\\/]scratch[\\/]/.test(p) || /[\\/]scripts[\\/]/.test(p)

const files = []
for (const d of SRC_DIRS) files.push(...walkDir(join(REPO, d)))
const testFiles = files.filter(isTest)
const prodFiles = files.filter((p) => !isTest(p))
console.log(`扫描：生产文件 ${prodFiles.length} 个，测试/脚本 ${testFiles.length} 个`)

const EXPORT_RE = /^export\s+(?:const|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm

const rows = []
for (const f of prodFiles) {
  const src = readFileSync(f, 'utf8')
  const names = [...src.matchAll(EXPORT_RE)].map((m) => m[1])
  if (names.length === 0) continue
  for (const name of names) {
    // 该符号在**别的生产文件**里被引用了吗
    let usedInProd = false
    for (const g of prodFiles) {
      if (g === f) continue
      if (readFileSync(g, 'utf8').includes(name)) { usedInProd = true; break }
    }
    if (usedInProd) continue
    // 只被测试用到？
    const usedInTest = testFiles.some((g) => readFileSync(g, 'utf8').includes(name))
    rows.push({
      file: f.replace(`${REPO}\\`, '').replace(`${REPO}/`, ''),
      name,
      where: usedInTest ? '只被用例用' : '**谁都不用**',
    })
  }
}

console.log(`\n零生产调用方的导出：${rows.length} 个\n`)
for (const r of rows) console.log(`  ${r.where.padEnd(10)} ${r.name.padEnd(42)} ${r.file}`)
