
import { spawn } from 'node:child_process'
const c = spawn('node', ['-e', 'console.log("ASYNC-OK")'])
let out = ''
c.stdout.on('data', d => { out += d.toString() })
c.stderr.on('data', d => { out += d.toString() })
c.on('close', code => console.log('code=' + code + ' out=' + JSON.stringify(out.trim())))
