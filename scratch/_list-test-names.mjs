// scratch/_list-test-names.mjs（**不提交**）
import { readFileSync } from 'node:fs'
const src = readFileSync('D:/project/DSH/legion/scripts/prt/stage-scope.test.mjs', 'utf8')
const re = /\btest\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1\s*,/g
for (const m of src.matchAll(re)) console.log(`  [${m[2]}]  @${m.index}`)
