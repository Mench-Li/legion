// scratch/_probe-spec-linecites.mjs —— 抽出目标文档里**所有** file:line 形式的引用（**不提交**）
import { readFileSync } from 'node:fs'
const SPEC = 'D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md'
const lines = readFileSync(SPEC, 'utf8').split(/\r?\n/)

// 形状：`path:123` / `path:123,456` / `path:123-456` / `path:12,34`（反引号内）
const RE = /`([^`]*?):(\d+(?:\s*[,-]\s*\d+)*)`/g
let n = 0
for (let i = 0; i < lines.length; i++) {
  for (const m of lines[i].matchAll(RE)) {
    n += 1
    console.log(`L${String(i + 1).padStart(3)}  ${m[1]}  @${m[2]}`)
  }
}
console.log(`\n共 ${n} 处 file:line 引用`)
