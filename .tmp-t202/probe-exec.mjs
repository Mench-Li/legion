import { spawn } from 'node:child_process'
function exec(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, CI: 'true' }, windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    child.on('close', (code) => { resolvePromise({ code, out, err }) })
    child.on('error', e => resolvePromise({ code: -2, out, err: e.message }))
  })
}
const r = await exec(process.execPath, ['scripts/ci/ci-syntax.mjs'], { cwd: process.cwd() })
console.log('RESULT code=' + r.code + ' outTail=' + JSON.stringify((r.out||'').split('\n').filter(Boolean).slice(-2)))
console.log('DONE')