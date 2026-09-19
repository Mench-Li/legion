// scratch/_probe-ambiguous.mjs —— 看 PRT-254 / PRT-413 的证据栏，裸名能不能靠惯例解开（**不提交**）
import { readFileSync } from 'node:fs'
const lines = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md', 'utf8').split(/\r?\n/)
for (const want of ['PRT-254', 'PRT-413']) {
  const line = lines.find((l) => l.trim().startsWith(`| ${want} `))
  console.log(`\n=== ${want} ===`)
  console.log(line.slice(0, 1400))
}
