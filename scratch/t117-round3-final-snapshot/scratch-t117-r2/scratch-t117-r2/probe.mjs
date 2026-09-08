
import { readFileSync } from 'node:fs'
const t = readFileSync('docs/FEATURES.md','utf8').replace(/\r\n/g,'\n')
const heads = [...t.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim())
console.log('total headings:', heads.length)
console.log('sample:', heads.slice(0, 30).join(' || '))
const rows = t.split('\n').filter(l => /^F-[0-9]{2}/.test(l))
const c3s = rows.map(r => { const c = r.split('|').map(s => s.trim()); return c[3] })
console.log('row count:', rows.length)
console.log('c3 sample:', JSON.stringify(c3s.slice(0,5), null, 0))
console.log('c3 all in heads?', c3s.map(x => heads.includes(x)))
