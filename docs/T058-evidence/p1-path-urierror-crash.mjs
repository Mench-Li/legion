// p1-path-urierror-crash.mjs —— T-058 探针：顶层 decodeURIComponent(pathname) 遇非法 % 编码路径 → 进程崩溃复现
// 背景：serve.mjs:944 对每个请求先 decodeURIComponent(url.pathname)，未捕获 URIError（T-056 审查 R2 记录）。
// 归属面：全 serve.mjs 共用 dispatcher，S3 只读端点（GET /api/files/...%zz）同样可达。
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVE = join(HERE, '..', '..', 'workbench', 'scripts', 'serve.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'l1s3-crash-'))
let pass = 0, fail = 0
const ok = (n, c, x) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (x ? '  [' + x + ']' : '')); c ? pass++ : fail++ }
function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function start() {
  const port = await freePort()
  const errFd = openSync(join(tmp, 'stderr-' + port + '.log'), 'w')
  const child = spawn(process.execPath, [SERVE, '--port', String(port)], { env: process.env, stdio: ['ignore', 'ignore', errFd] })
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/fs/home'); if (r.status === 200) break } catch { }
    await new Promise(r => setTimeout(r, 100))
  }
  return { port, child }
}
const waitExit = (child, ms) => new Promise(res => { const t = setTimeout(() => res('alive'), ms); child.once('exit', (c, s) => { clearTimeout(t); res('exit:' + c + '/sig:' + s) }) })

async function rawGet(port, rawPath) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume(); res.on('end', () => resolve('resp:' + res.statusCode))
    })
    req.on('error', (e) => resolve('reqerr:' + e.message))
    req.end()
  })
}

// 用例 1：普通非法 % 路径（任意前缀，全 dispatcher 共用面）
{
  const { port, child } = await start()
  const outcome = await rawGet(port, '/%zz')
  const final = await waitExit(child, 3000)
  ok('非法 % 路径 GET /%zz → 进程被一击打死（应存活/400）', final === 'alive', 'outcome=' + outcome + ' final=' + final)
  if (!child.killed && child.exitCode === null) try { child.kill() } catch { }
  await new Promise(r => setTimeout(r, 300))
}
// 用例 2：命中 S3 只读面路径形态（/api/files/... 含非法 %）
{
  const { port, child } = await start()
  const outcome = await rawGet(port, '/api/files/list%zz?scope=fx')
  const final = await waitExit(child, 3000)
  ok('S3 端点路径 GET /api/files/list%zz → 进程存活（应存活/400）', final === 'alive', 'outcome=' + outcome + ' final=' + final)
  if (!child.killed && child.exitCode === null) try { child.kill() } catch { }
  await new Promise(r => setTimeout(r, 300))
}
// 用例 3：合法路径对照 —— 服务正常（证明崩溃源于该单请求）
{
  const { port, child } = await start()
  const r1 = await rawGet(port, '/api/files/list?scope=fx&path=')
  const r2 = await rawGet(port, '/api/fs/home')
  const alive = child.exitCode === null
  ok('对照：合法请求（files list 缺 scope 400 / fs home 200）后进程存活', alive && r1 === 'resp:400' && r2 === 'resp:200', r1 + ' / ' + r2 + ' alive=' + alive)
  try { child.kill() } catch { }
  await new Promise(r => setTimeout(r, 300))
}
console.log('\nPASS=' + pass + ' FAIL=' + fail)
try { rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(fail ? 1 : 0)
