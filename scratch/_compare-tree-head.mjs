// scratch/_compare-tree-head.mjs —— 工作树版 vs HEAD 版：envNames 是否被动过（**不提交**）
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'D:/project/DSH/legion'
const sh = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

// HEAD 版 process-manifest.mjs 里 runtime 的 envNames
const headSrc = sh(['show', 'HEAD:product/process-manifest.mjs'])
const keys = ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS', 'LEGION_EXECUTION_SCOPE',
  'LEGION_EXTERNAL_API_SCOPE', 'TEAM_HUB_TOKEN']

// 找 `runtime: {` … `envNames: [` 那一段
function envNamesOf(src, proc) {
  const i = src.indexOf(`${proc}: {`)
  if (i === -1) return null
  const seg = src.slice(i, i + 4000)
  const m = /envNames:\s*\[([\s\S]*?)\]/.exec(seg)
  if (m === null) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

for (const proc of ['runtime', 'orchestrator']) {
  const headKeys = envNamesOf(headSrc, proc)
  console.log(`HEAD 版 ${proc}.envNames（${headKeys === null ? '?' : headKeys.length} 个）:`)
  console.log('   ' + (headKeys ?? []).join(', '))
  if (headKeys !== null) {
    for (const k of keys) console.log(`   ${headKeys.includes(k) ? '有' : '缺'} ${k}`)
  }
  console.log('')
}

// 这个文件的 diff 有没有碰 envNames
const diff = sh(['diff', 'HEAD', '--', 'product/process-manifest.mjs'])
const touchesEnvNames = /^[+-].*envNames/m.test(diff)
console.log('diff 是否触碰 envNames 行: ' + touchesEnvNames)
console.log('diff 规模: ' + diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length + ' 行（含增删）')
const plus = diff.split('\n').filter((l) => /^\+[^+]/.test(l))
console.log('新增行里含 HUB_TOKEN / SCOPE 的:')
for (const l of plus.filter((l) => /HUB_TOKEN|SCOPE|envNames/.test(l)).slice(0, 10)) console.log('   ' + l.slice(0, 120))
