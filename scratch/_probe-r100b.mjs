// scratch/_probe-r100b.mjs —— 候选 `\d{2,3}` 会不会捞进别的表
import { readFileSync } from 'node:fs'

const t = readFileSync('D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md', 'utf8')
const lines = t.split(/\r?\n/)

for (const [name, re] of [['\\d{2}', /^\| (\d{2}) \|/gm], ['\\d{2,3}', /^\| (\d{2,3}) \|/gm], ['\\d+', /^\| (\d+) \|/gm]]) {
  const nums = [...t.matchAll(re)].map((m) => Number(m[1]))
  console.log(`  ${name.padEnd(9)} 命中 ${String(nums.length).padStart(3)} 处，max = ${Math.max(...nums)}`)
}

// `\d{2,3}` 比 `\d{2}` 多出来的那些数字，出现在哪些行？是不是家族表？
const two = new Set([...t.matchAll(/^\| (\d{2}) \|/gm)].map((m) => Number(m[1])))
const extra = [...new Set([...t.matchAll(/^\| (\d{2,3}) \|/gm)].map((m) => Number(m[1])))].filter((x) => !two.has(x))
console.log(`  \`\\d{2,3}\` 比 \`\\d{2}\` 多的数字 = ${JSON.stringify(extra.sort((a, b) => a - b))}`)
for (const n of extra) {
  lines.forEach((l, i) => { if (new RegExp(`^\\| ${n} \\|`).test(l)) console.log(`    | ${n} | @L${i + 1}  ${l.trim().slice(0, 78)}`) })
}

// 家族表到底有多少行？用「行首 | N | 且该行以 | 结尾（表格行）」+ 排除里程碑表的形状（第二格是带反引号的阶段名）
const fam = lines.filter((l) => /^\| \d+ \|/.test(l) && !/^\| \d+ \| `/.test(l))
console.log(`  ── 家族表（排除第二格是反引号阶段名的里程碑表）行数 = ${fam.length}`)
const nums = fam.map((l) => Number(/^\| (\d+) \|/.exec(l)[1]))
console.log(`     max = ${Math.max(...nums)}；前 3 个 = ${nums.slice(0, 3).join(',')}；后 3 个 = ${nums.slice(-3).join(',')}`)
console.log(`     连续吗：${nums.every((v, i) => i === 0 || v === nums[i - 1] + 1) ? '是（严格递增）' : '否 —— ' + JSON.stringify(nums.filter((v, i) => i > 0 && v !== nums[i - 1] + 1))}`)
