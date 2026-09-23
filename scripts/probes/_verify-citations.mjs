// scripts/probes/_verify-citations.mjs —— 把我新写的每个行号引用都量一遍（**不提交**）
import { readFileSync } from 'node:fs'

const show = (file, needles) => {
  const lines = readFileSync(`D:/project/DSH/legion/${file}`, 'utf8').split(/\r?\n/)
  console.log(`\n=== ${file} ===`)
  for (const n of needles) {
    const idx = lines.findIndex((l) => l.includes(n))
    console.log(`  ${idx === -1 ? '✖ 找不到' : 'L' + (idx + 1)}  「${n.slice(0, 60)}」`)
  }
}

show('docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md', [
  '定义唯一接口：`getHealth`',
  '环境变量白名单和工具权限',
])
show('runtime/contracts/run.mjs', [
  '环境变量必须是白名单数组',
  'if (!Array.isArray(req.env)) errors.push',
  'value.env = Array.isArray(req.env)',
  "一个\"用必填字段把缺席挡在门外\"的契约",
])
