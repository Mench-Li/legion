// scratch/_peek-feedback-path.mjs —— `plugins/connector-feedback.mjs` 这个写法的上下文（**不提交**）
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8')
for (const n of ['plugins/connector-feedback.mjs', 'outcome-port.mjs', 'connector-port.mjs']) {
  const idx = []
  let from = 0
  while (true) {
    const i = t.indexOf(n, from)
    if (i === -1) break
    idx.push(i); from = i + 1
  }
  console.log(`### ${n}  命中 ${idx.length} 次`)
  for (const i of idx.slice(0, 3)) {
    const line = t.slice(0, i).split('\n').length
    console.log(`  L${line}: ...${t.slice(Math.max(0, i - 150), i + 80).replace(/\n/g, ' ')}...`)
  }
  console.log('')
}
