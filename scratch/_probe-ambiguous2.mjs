// scratch/_probe-ambiguous2.mjs —— 3 处歧义点名的上下文（**不提交**）
import { readFileSync } from 'node:fs'
const lines = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md', 'utf8').split(/\r?\n/)
for (const want of ['PRT-254', 'PRT-413']) {
  const line = lines.find((l) => l.trim().startsWith(`| ${want} `))
  console.log(`\n════════ ${want} ════════`)
  for (const name of ['config.test.mjs', 'secrets.test.mjs']) {
    let idx = -1
    while ((idx = line.indexOf('`' + name + '`', idx + 1)) !== -1) {
      const a = Math.max(0, idx - 260)
      console.log(`\n  ── \`${name}\` @ ${idx} ──`)
      console.log('  ...' + line.slice(a, idx + name.length + 120).replace(/\n/g, ' '))
    }
  }
}
