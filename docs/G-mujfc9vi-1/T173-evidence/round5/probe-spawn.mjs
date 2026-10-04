import { execFileSync, spawnSync, spawn } from 'node:child_process'
const t = (name, fn) => { try { const v = fn(); console.log(name, 'OK', v) } catch (e) { console.log(name, 'FAIL', e.code, String(e.message).split('\n')[0]) } }
t('execFileSync-stdio-ignore-pipe-ignore', () => execFileSync('git', ['ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').length)
t('execFileSync-default', () => execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').length)
t('spawnSync-default', () => { const r = spawnSync('git', ['ls-files'], { encoding: 'utf8' }); if (r.error) throw r.error; return (r.status + ' lines=' + r.stdout.split('\n').length) })
t('node-execFileSync', () => execFileSync(process.execPath, ['-e', 'console.log(1)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
const p = spawn(process.execPath, ['-e', 'process.stdout.write("async-ok")'], { stdio: ['ignore', 'pipe', 'pipe'] })
p.on('error', e => console.log('spawn-async FAIL', e.code))
p.stdout.on('data', d => console.log('spawn-async OK', d.toString()))
p.on('close', c => console.log('spawn-async close', c))