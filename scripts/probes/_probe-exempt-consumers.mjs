// scripts/probes/_probe-exempt-consumers.mjs —— 我那两条豁免说"它被用了，只是没被遍历"。真的吗？
//
// ★ 判据 `declaration-mirrors` 只能看见"有没有被**遍历**"。它分不出：
//     ① 这张表被人手写重建了一遍（真缺陷，第 40 轮那个形状）；
//     ② 这张表被用了，只是没被遍历（枚举查表、当参数传走）；
//     ③ **这张表根本没有任何读者**（死声明）。
//   而我在第 41 轮给两条豁免写的理由，用的都是 ② 的说法。
//   ⇒ 所以这一轮先**量**，不先信。
//
// 量法：`git grep` 取回每个名字的全部命中行，减去声明自己那一行 ⇒ `refSites`。
//   0 个读者与"有读者但没遍历"是两个完全不同的读数。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const grep = (pat) => {
  try {
    return execFileSync('git', ['grep', '-n', '-E', pat], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean)
  } catch (e) {
    if (e.status === 1) return []
    throw e
  }
}

const NAMES = [
  // 我那两条豁免
  'PREFLIGHT_VERDICTS', 'BPE_ARTIFACT_FIELDS',
  // 对照：确定有读者的
  'DIR_ROLES', 'WRITABLE_ROLES', 'RUN_RECORD_FIELDS', 'BUDGET_ALERT_CONFIDENCE',
  // 对照：确定**没有**遍历但按字典取值用的
  'RUN_RECORD_CODES', 'BUDGET_ALERT_CODES',
]
// 每张表的声明文件（用于剔除声明自己那一行）
const DECL_FILE = {
  PREFLIGHT_VERDICTS: 'product/upgrade/preflight.mjs',
  BPE_ARTIFACT_FIELDS: 'runtime/context/bpe.mjs',
  DIR_ROLES: 'product/paths.mjs',
  WRITABLE_ROLES: 'product/paths.mjs',
  RUN_RECORD_FIELDS: 'product/launcher/run-record.mjs',
  BUDGET_ALERT_CONFIDENCE: 'team-hub/budget-alert.mjs',
}
const iterRe = (n) => `(for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+${n}\\b|\\[\\.\\.\\.${n}\\]|\\.\\.\\.${n}[,)]|${n}\\.(map|filter|every|some|forEach|includes|reduce|join|indexOf|find|flatMap)\\b|of\\s+${n}\\b)`

console.log('名字'.padEnd(26), '读者点', '其中遍历', '判定')
console.log('─'.repeat(72))
const dead = []
for (const name of NAMES) {
  const hits = grep(`\\b${name}\\b`)
  const declFile = DECL_FILE[name]
  const refs = hits.filter((h) => {
    const [file, line, text] = [h.slice(0, h.indexOf(':')), null, null]
    // 剔除"声明自己那一行"
    return !(file === declFile && /export const\s/.test(h))
  })
  const iterSites = refs.filter((h) => new RegExp(iterRe(name)).test(h)).length
  const verdict = refs.length === 0 ? '★ 没有任何读者（死声明）'
    : iterSites > 0 ? '被遍历'
      : '有读者、未遍历（查表/传参）'
  if (refs.length === 0) dead.push(name)
  console.log(name.padEnd(26), String(refs.length).padStart(6), String(iterSites).padStart(8), ' ', verdict)
}

console.log('\n=== 我那两条豁免的读者明细 ===')
for (const name of ['PREFLIGHT_VERDICTS', 'BPE_ARTIFACT_FIELDS']) {
  console.log(`\n${name}:`)
  const hits = grep(`\\b${name}\\b`)
  for (const h of hits) console.log(`  ${h.slice(0, 150)}`)
}

// 读一下那张表的声明与用法，看它到底被当成什么用
console.log('\n=== BPE_ARTIFACT_FIELDS 的声明处上下文 ===')
const bpe = readFileSync(`${ROOT}/runtime/context/bpe.mjs`, 'utf8').split(/\r?\n/)
for (let i = 18; i < 32; i++) console.log(`  ${String(i + 1).padStart(3)}  ${bpe[i]}`)
