// P1-4.4 真实语料回测：真实 LEGION.md → norms 拼装 → doctor 全 present；
// 模拟（a）将军停用 AGENTS.md（tombstone）；（b）将军追加超长规则致空间层截断 → missing 发现。
import { buildNormSections } from '../lib/norms.js'
import { runRuleDoctor, parseTombstones } from '../lib/ruleAssets.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '..', '..')
const LEGION_MD = readFileSync(join(REPO, 'LEGION.md'), 'utf8')
const files = [{ label: 'LEGION.md', content: LEGION_MD }]

// 1) 现状：兼容单文件形态 → doctor 全 present
let { sections, truncated } = buildNormSections({ globalText: '', files })
let rep = runRuleDoctor({ files, globalText: '', injectedText: sections.join('\n'), truncated })
console.log(`现状：${rep.items.filter(i=>i.present).length}/${rep.items.length} present, ok=${rep.ok}, truncated=${rep.truncated}`)

// 2) 模拟将军追加一条超长规则（总长远超 2000 字预算）→ 两段形态截断 → doctor 应发现尾部缺失
const globalText = '## 全局验收纪律\n- 将军一句话验收才算 done。'
const longTail = '## 将军新增：交付物完整性\n' + ('- 所有交付必须附带可复现的验证命令与真实输出摘录。'.repeat(100))
const longFiles = [{ label: 'LEGION.md', content: LEGION_MD + '\n\n' + longTail }]
const r2 = buildNormSections({ globalText, files: longFiles }, { spaceMax: 2000, totalMax: 0 })
const rep2 = runRuleDoctor({
  files: longFiles, globalText,
  injectedText: r2.sections.join('\n'), truncated: r2.truncated,
})
const miss2 = rep2.items.filter(i => !i.present)
console.log(`\n超长规则场景：ok=${rep2.ok} truncated=${rep2.truncated} present=${rep2.items.length - miss2.length}/${rep2.items.length}`)
console.log(`缺失单元：${miss2.map(m => `${m.source}#${m.title}`).join('、') || '（无）'}`)

// 3) tombstone：停用 LEGION.md → desired 空 → doctor ok（无 desired 无可缺失；注入文本也空）
const removed = parseTombstones('# 停用\nLEGION.md\n')
const r3 = buildNormSections({ globalText: '', files: [] })
const rep3 = runRuleDoctor({ files, globalText: '', injectedText: r3.sections.join('\n'), truncated: false, removed })
console.log(`\ntombstone 停用 LEGION.md：items=${rep3.items.length} removedSources=${rep3.removedSources.join(',')} ok=${rep3.ok}`)

// 4) 验证结果可被 serve.mjs /api/daemon 表达的形态（rulesDoctor 汇总字段）
const summary = {
  ok: rep2.ok, truncated: rep2.truncated,
  total: rep2.items.length,
  present: rep2.items.length - miss2.length,
  missing: miss2.map(i => `${i.source}#${i.title}`),
}
console.log('\n=== daemon.json rulesDoctor 汇总形态 ===')
console.log(JSON.stringify(summary, null, 2))
