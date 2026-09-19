// scratch/_probe-envnames-state.mjs —— 交接报告说"4 把键不在 runtime envNames 里"，重量一遍（**不提交**）
import { readFileSync } from 'node:fs'
const src = readFileSync('D:/project/DSH/legion/product/process-manifest.mjs', 'utf8')

// 找所有 envNames 数组
const re = /envNames\s*:\s*\[([^\]]*)\]/g
let m, i = 0
const NEED = ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS', 'LEGION_EXECUTION_SCOPE', 'LEGION_EXTERNAL_API_SCOPE']
while ((m = re.exec(src)) !== null) {
  i += 1
  const names = m[1].split(',').map((s) => s.trim().replace(/['"`]/g, '')).filter(Boolean)
  const before = src.slice(0, m.index).split('\n').length
  const missing = NEED.filter((n) => !names.includes(n))
  console.log(`envNames #${i}  L${before}  共 ${names.length} 项；缺那 4 把里的 ${missing.length} 把`)
  console.log(`    ${names.join(' ')}`)
}
console.log(`\n共 ${i} 个 envNames 数组`)
console.log('找那 4 把键在 config-schema 里注册了没有：')
const cs = readFileSync('D:/project/DSH/legion/runtime/config-schema.mjs', 'utf8')
for (const n of NEED) console.log(`  ${cs.includes(n) ? '✔' : '✖'} ${n}`)
