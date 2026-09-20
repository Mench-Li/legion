// scratch/_probe-r100-familyregex.mjs —— 第 100 轮：修 `\d{2}` 之前先量，换 `\d+` 会不会捞进别的表
import { readFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
const t = readFileSync(I, 'utf8')

const two = [...t.matchAll(/^\| (\d{2}) \|/gm)].map((m) => Number(m[1]))
const plus = [...t.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]))

console.log(`  \`\\d{2}\` 命中 ${two.length} 处，max = ${Math.max(...two)}`)
console.log(`  \`\\d+\`  命中 ${plus.length} 处，max = ${Math.max(...plus)}`)
console.log(`  差集（\\d+ 有而 \\d{2} 没有的）= ${JSON.stringify([...new Set(plus)].filter((x) => !two.includes(x)).sort((a, b) => a - b))}`)

// 那些"多出来"的数字出现在哪些行？是不是家族表？
const lines = t.split(/\r?\n/)
const extra = [...new Set(plus)].filter((x) => !two.includes(x))
for (const n of extra) {
  const idx = lines.findIndex((l) => new RegExp(`^\\| ${n} \\|`).test(l))
  const s = lines[idx] ?? ''
  console.log(`    | ${n} | @L${idx + 1}  ${s.trim().slice(0, 84)}`)
}

// 反向：家族表里一共有多少行（用行首 `| NN | ★` 这种形状）
const fam = [...t.matchAll(/^\| (\d+) \| ★/gm)].map((m) => Number(m[1]))
console.log(`  \`^\\| (\\d+) \\| ★\` 命中 ${fam.length} 处，max = ${Math.max(...fam)}  ← 这个形状最贴家族表本身`)
