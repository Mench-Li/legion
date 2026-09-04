import { spawn } from 'node:child_process'
import { openSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'
const SERVE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workbench', 'scripts', 'serve.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'l1s3-stack-'))
const port = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const errFd = openSync(join(tmp, 'stderr.log'), 'w')
const child = spawn(process.execPath, [SERVE, '--port', String(port)], { env: process.env, stdio: ['ignore', 'ignore', errFd] })
for (let i = 0; i < 100 && child.exitCode === null; i++) {
  try { const r = await fetch('http://127.0.0.1:' + port + '/api/fs/home'); if (r.status === 200) break } catch { }
  await new Promise(r => setTimeout(r, 100))
}
await new Promise((resolve) => { const req = httpRequest({ host: '127.0.0.1', port, path: '/api/files/list%zz?scope=fx' }, (res) => { res.resume(); res.on('end', resolve) }); req.on('error', resolve); req.end() })
await new Promise(r => setTimeout(r, 1500))
console.log('child exitCode=', child.exitCode)
const { readFileSync } = await import('node:fs')
const stderrText = readFileSync(join(tmp, 'stderr.log'), 'utf8')
console.log('──── stderr（前 25 行）────')
console.log(stderrText.split(/\r?\n/).slice(0, 25).join('\n'))
try { child.kill() } catch { }
try { rmSync(tmp, { recursive: true, force: true }) } catch { }
