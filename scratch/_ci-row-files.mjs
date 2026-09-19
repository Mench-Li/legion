// scratch/_ci-row-files.mjs —— 看 CI 的套件行聚合了几个文件（**不提交**）
import { readFileSync } from 'node:fs'
const t = readFileSync('D:/project/DSH/legion/scripts/ci/run-ci.mjs', 'utf8')
for (const name of ['path-scope', 'runtime-contract', 'tool-call-log', 'dsh-adapter', 'external-api-scope', 'execution-scope']) {
  const i = t.indexOf(`label: '${name}（`)
  if (i === -1) { console.log(name + ': 找不到行'); continue }
  // label 之后到下一个 label 之间算这一行
  const j = t.indexOf('label: ', i + 10)
  const seg = t.slice(i, j === -1 ? i + 1200 : j)
  const files = [...seg.matchAll(/'([^']*\.test\.mjs)'/g)].map((m) => m[1])
  console.log(`### ${name}  → files(${files.length})`)
  for (const f of files) console.log('      ' + f)
}
