import { spawn } from 'node:child_process'
const file = '.tmp-t202/child-target.mjs'
import { writeFileSync } from 'node:fs'
writeFileSync(file, ['console.log("OUT-LINE-1")','console.error("ERR-LINE-1")','console.log("OUT-LINE-2")','process.exitCode = 3'].join('\n'))
const child = spawn(process.execPath, [file], { cwd: process.cwd() })
let out='', err=''
child.stdout.on('data', d => { out += d.toString() })
child.stderr.on('data', d => { err += d.toString() })
child.on('close', code => console.log('CLOSE code=' + code + ' out=' + JSON.stringify(out) + ' err=' + JSON.stringify(err)))
child.on('error', e => console.log('ERR ' + e.message))