// scratch/_measure-ratchet.mjs —— doc-table 棘轮的**实测**处数 vs 常量 87（**不提交**）
import {
  REPO_WIDE_BASELINE, AUTHORITATIVE_DOCS, trackedMarkdownFiles, auditFiles,
} from '../scripts/prt/doc-table-integrity.mjs'

const files = trackedMarkdownFiles({ cwd: 'D:/project/DSH/legion' })
const r = auditFiles({ cwd: 'D:/project/DSH/legion', files })
console.log('常量 REPO_WIDE_BASELINE = ' + REPO_WIDE_BASELINE)
console.log('实测全仓已跟踪 md 缺陷处数 = ' + r.total + '（文件 ' + Object.keys(r.byFile ?? {}).length + ' 个）')
console.log('权威文档 ' + AUTHORITATIVE_DOCS.length + ' 份，缺陷 = ' + (r.authoritativeTotal ?? '(无该字段)'))
console.log('')
console.log('★ 棘轮语义是"只许减少"：常量 ' + REPO_WIDE_BASELINE + ' 与实测 ' + r.total
  + (r.total < REPO_WIDE_BASELINE
    ? ' ⇒ 实测**低于**常量 ' + (REPO_WIDE_BASELINE - r.total) + ' ⇒ 常量可以降，而没人降'
    : ' ⇒ 一致/更高（棘轮在起作用）'))
console.log('')
console.log('逐文件（前 20）：')
for (const [f, n] of Object.entries(r.byFile ?? {}).slice(0, 20)) console.log('  ' + String(n).padStart(4) + '  ' + f)
