import { auditFiles } from '../scripts/prt/doc-table-integrity.mjs'
const r = auditFiles({ cwd: process.cwd(), files: ['docs/review/T-189-REVIEW.md'] })
console.log('files', r.files, 'defects', r.defects.length)
for (const d of r.defects) console.log(JSON.stringify(d))
