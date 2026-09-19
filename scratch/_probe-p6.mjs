// scratch/_probe-p6.mjs（**不提交**）
import { readFileSync } from 'node:fs'
const victim = readFileSync('D:/project/DSH/legion/scripts/prt/stage-scope.test.mjs', 'utf8')
const find = "test('\u2461 \u2605\u2605\u2605 \u6b63\u5411\u63a7\u5236\uff1a\u672a\u58f0\u660e\u7684\u78b0\u649e"
console.log('find          =', JSON.stringify(find))
console.log('includes ?    =', victim.includes(find))
const i = victim.indexOf('\u2461')
console.log('文件里那一行  =', JSON.stringify(victim.slice(i - 6, i + 40)))
console.log('逐字符：')
console.log('  find  :', [...find].map((c) => c.codePointAt(0).toString(16)).join(' '))
console.log('  文件  :', [...victim.slice(i - 6, i - 6 + find.length)].map((c) => c.codePointAt(0).toString(16)).join(' '))
