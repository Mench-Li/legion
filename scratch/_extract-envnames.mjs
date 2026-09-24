// scratch/_extract-envnames.mjs —— 从两份源码文本里抽出 envNames 数组内容并比较（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const headSrc = execFileSync('git', ['show', 'HEAD:product/process-manifest.mjs'],
  { cwd: ROOT, encoding: 'utf8' })
const treeSrc = readFileSync(`${ROOT}/product/process-manifest.mjs`, 'utf8')

/** 抽出所有 `envNames: Object.freeze([ ... ])` 的键（按出现顺序）。 */
function extract(src) {
  const out = []
  const re = /envNames:\s*Object\.freeze\(\[([\s\S]*?)\]\)/g
  for (const m of src.matchAll(re)) {
    out.push([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
  }
  return out
}

const a = extract(headSrc)
const b = extract(treeSrc)
console.log(`HEAD 版 envNames 数组 ${a.length} 个；工作树版 ${b.length} 个`)
const n = Math.max(a.length, b.length)
let allSame = true
for (let i = 0; i < n; i++) {
  const x = (a[i] ?? []).slice().sort()
  const y = (b[i] ?? []).slice().sort()
  const same = JSON.stringify(x) === JSON.stringify(y)
  if (!same) allSame = false
  console.log(`\n#${i}: HEAD ${x.length} 个 / 工作树 ${y.length} 个 —— ${same ? '一致' : '✖ 不同'}`)
  console.log('  ' + y.join(', '))
  if (!same) {
    console.log('  HEAD 独有: ' + x.filter((k) => !y.includes(k)).join(', '))
    console.log('  工作树独有: ' + y.filter((k) => !x.includes(k)).join(', '))
  }
}
console.log('\n所有 envNames 数组是否逐字一致: ' + allSame)
writeFileSync(`${ROOT}/scratch/_head-pm.txt`, headSrc, 'utf8')
