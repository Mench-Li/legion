// l1-s3-smoke.mjs —— T-058（S3 serve.mjs /api/files 只读面 list/read/download）L1 真实进程 HTTP 冒烟 + 边界断言
// 运行：node docs/T058-evidence/l1-s3-smoke.mjs   （node v24；仅 node 内置模块；零依赖）
// 覆盖：TC-S3-01..15 主路径/边界/异常 + P0-2 流式下载 + 仅回环（函数级）+ .git 根级/嵌套防护 + 逃逸矩阵
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, existsSync, statSync, symlinkSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVE = join(HERE, '..', '..', 'workbench', 'scripts', 'serve.mjs')
const results = []
let passCount = 0, failCount = 0
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra ?? '' })
  if (cond) { passCount++; console.log('PASS  ' + name) }
  else { failCount++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}
async function httpJson(port, path) {
  const res = await fetch('http://127.0.0.1:' + port + path, { redirect: 'manual' })
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch { /* 非 JSON 响应（下载等） */ }
  return { status: res.status, headers: res.headers, buf, json }
}
function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
}
async function startServe(envExtra) {
  const port = await freePort()
  const child = spawn(process.execPath, [SERVE, '--port', String(port), '--host', '127.0.0.1'], { env: { ...process.env, ...envExtra }, stdio: 'ignore' })
  let ready = false
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/fs/home')
      if (r.status === 200) { ready = true; break }
    } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return { port, child, ready }
}

// ── 夹具树（对齐 TEST_CASES §8.5；另加嵌套 git 仓库用于 TC-S3-12 嵌套面）──
const tmpRoot = mkdtempSync(join(tmpdir(), 'l1s3-'))
const root = join(tmpRoot, 'repo')
const outside = join(tmpRoot, 'outside')
mkdirSync(join(root, 'docs'), { recursive: true })
mkdirSync(join(root, 'empty'), { recursive: true })
mkdirSync(join(root, 'nonempty'), { recursive: true })
mkdirSync(join(root, 'nestedrepo'), { recursive: true })
mkdirSync(join(root, 'vendor', 'sub-repo'), { recursive: true })
mkdirSync(join(root, '.git'), { recursive: true })
mkdirSync(join(root, 'nestedrepo', '.git'), { recursive: true })
mkdirSync(join(root, 'vendor', 'sub-repo', '.git'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(root, '.git', 'config'), '[core]\n  secret = root-secret')
writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
writeFileSync(join(root, 'ok.txt'), 'hello 世界\n第二行内容')
writeFileSync(join(root, 'docs', 'guide.txt'), 'guide content line1\nline2')
writeFileSync(join(root, '中文 文件.txt'), '中文内容-测试')
writeFileSync(join(root, 'nonempty', 'keep.txt'), 'x')
writeFileSync(join(root, 'nestedrepo', 'readme.txt'), 'nested repo file')
writeFileSync(join(root, 'nestedrepo', '.git', 'config'), '[core]\n  secret = NESTED-ROOT')
writeFileSync(join(root, 'vendor', 'sub-repo', 'readme.md'), 'sub repo')
writeFileSync(join(root, 'vendor', 'sub-repo', '.git', 'config'), '[core]\n  secret = NESTED-LEAK-MARKER-1f2e3d')
writeFileSync(join(root, 'vendor', 'sub-repo', '.git', 'HEAD'), 'ref: refs/heads/nested')
writeFileSync(join(outside, 'secret.txt'), 'outside secret')
writeFileSync(join(root, 'big.log'), 'log line\n'.repeat(30 * 1024)) // ≈276KB > MAX_READ 256KiB
writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))
const BIG = join(root, 'big.bin') // 64MB：流式下载/并发响应载体
{ const chunk = Buffer.alloc(65536); for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251
  const fd = openSync(BIG, 'w')
  for (let i = 0; i < 1024; i++) writeSync(fd, chunk, 0, chunk.length)
  closeSync(fd) }
try { symlinkSync(join(root, 'docs'), join(root, 'link-in'), 'junction') } catch { }
try { symlinkSync(outside, join(root, 'link-out'), 'junction') } catch { }
const SPACES = JSON.stringify([{ id: 'fx', name: 'fx', localDir: root }, { id: 'nobind', name: 'nobind' }])
const Q = encodeURIComponent

try {
  // ═══ A. 真实进程 + 只读面正常路径 ═══
  const { port, child, ready } = await startServe({ DSH_WORKBENCH_SPACES_JSON: SPACES })
  check('serve.mjs 真实进程启动并可响应', ready, 'exitCode=' + child.exitCode)
  try {
    // TC-S3-01 list 根
    let r = await httpJson(port, '/api/files/list?scope=fx&path=')
    const j = r.json ?? {}
    const names = (j.entries ?? []).map(e => e.name)
    check('TC-S3-01 list 根 → 200 ok:true entries 数组', r.status === 200 && j.ok === true && Array.isArray(j.entries), 'status=' + r.status)
    check('TC-S3-01 entries 含 docs/nonempty/empty/nestedrepo/vendor/中文文件', ['docs', 'nonempty', 'empty', 'nestedrepo', 'vendor', '中文 文件.txt'].every(n => names.includes(n)), JSON.stringify(names))
    check('TC-S3-01 隐藏条目(.git 等点开头)不进列表', !names.some(n => n.startsWith('.')), JSON.stringify(names.filter(n => n.startsWith('.'))))
    const firstFileIdx = j.entries.findIndex(e => e.type === 'file')
    const lastDirIdx = j.entries.map(e => e.type).lastIndexOf('dir')
    check('TC-S3-01 目录在前排序', firstFileIdx === -1 || firstFileIdx > lastDirIdx, 'firstFile=' + firstFileIdx)
    const okEnt = j.entries.find(e => e.name === 'ok.txt')
    check('TC-S3-01 文件条目形状 name/type/size/mtime/ext', okEnt && okEnt.type === 'file' && typeof okEnt.size === 'number' && typeof okEnt.mtime === 'string' && okEnt.ext === 'txt', JSON.stringify(okEnt))
    const nrEnt = j.entries.find(e => e.name === 'nestedrepo')
    check('TC-S3-01 含 .git 子目录 isRepo=true', nrEnt?.isRepo === true, JSON.stringify(nrEnt))
    // TC-S3-02 空目录 / 缺省 path
    r = await httpJson(port, '/api/files/list?scope=fx&path=empty')
    check('TC-S3-02 空目录 → 200 entries=[]', r.status === 200 && (r.json?.entries ?? null)?.length === 0, JSON.stringify(r.json?.entries))
    r = await httpJson(port, '/api/files/list?scope=fx')
    check('TC-S3-02 path 缺省 = 根 200', r.status === 200 && Array.isArray(r.json?.entries))
    // TC-S3-04 语义错误
    r = await httpJson(port, '/api/files/list?scope=fx&path=' + Q('ok.txt'))
    check('TC-S3-04 list 指向文件 → 400 可读错误', r.status === 400 && !!r.json?.error, 'status=' + r.status)
    r = await httpJson(port, '/api/files/list?scope=fx&path=' + Q('no-such-dir'))
    check('TC-S3-04 list 不存在目录 → 400 可读错误', r.status === 400 && !!r.json?.error, 'status=' + r.status)
    // TC-S3-03 scope 语义
    r = await httpJson(port, '/api/files/list?scope=nobind&path=')
    check('TC-S3-03 scope 未绑定 local_dir → 400 引导错误', r.status === 400 && /绑定|local_dir|本地文件夹/.test(r.json?.error ?? ''), JSON.stringify(r.json))
    r = await httpJson(port, '/api/files/list?scope=ghost&path=')
    check('TC-S3-03 scope 未注册 → 400 引导错误', r.status === 400 && /未注册|创建/.test(r.json?.error ?? ''), JSON.stringify(r.json))
    r = await httpJson(port, '/api/files/list&path=')
    check('缺 scope → 400 缺少参数 scope', r.status === 400 && /缺少参数 scope/.test(r.json?.error ?? ''), 'status=' + r.status)
    // TC-S3-05/06/07/13 read
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('ok.txt'))
    const okBytes = Buffer.from('hello 世界\n第二行内容')
    check('TC-S3-05 read 文本全文正确 + truncated=false + lineCount=2 + totalBytes', r.status === 200 && r.json?.content === 'hello 世界\n第二行内容' && r.json?.truncated === false && r.json?.lineCount === 2 && r.json?.totalBytes === okBytes.length, JSON.stringify(r.json))
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('中文 文件.txt'))
    check('TC-S3-13 read 中文/空格文件名全链路无乱码', r.status === 200 && r.json?.content === '中文内容-测试', JSON.stringify(r.json))
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('big.log'))
    check('TC-S3-06 read >MAX_READ → truncated=true content=256KiB totalBytes=全量', r.status === 200 && r.json?.truncated === true && r.json?.content?.length === 256 * 1024 && r.json?.totalBytes === 30 * 1024 * 9 && r.json?.lineCount > 0, 'clen=' + (r.json?.content?.length ?? '') + ' total=' + (r.json?.totalBytes ?? ''))
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('pic.png'))
    check('TC-S3-07 read 二进制 → binary:true + 明确不可预览', r.status === 200 && r.json?.binary === true && /不可预览/.test(r.json?.message ?? ''), JSON.stringify(r.json))
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('docs'))
    check('read 目录 → 400 语义错误', r.status === 400 && /目录/.test(r.json?.error ?? ''), JSON.stringify(r.json))
    // TC-S3-08 download 正常
    r = await httpJson(port, '/api/files/download?scope=fx&path=' + Q('ok.txt'))
    check('TC-S3-08 download 200 + 原始字节与磁盘逐字节一致', r.status === 200 && r.buf.equals(okBytes), 'len=' + r.buf.length)
    check('TC-S3-08 download Content-Type / Content-Disposition 合理', (r.headers.get('content-type') ?? '').startsWith('text/plain') && /attachment/.test(r.headers.get('content-disposition') ?? ''), r.headers.get('content-type') + ' | ' + r.headers.get('content-disposition'))
    check('TC-S3-08 download Content-Length 精确', r.headers.get('content-length') === String(okBytes.length), r.headers.get('content-length'))
    r = await httpJson(port, '/api/files/download?scope=fx&path=' + Q('nope.txt'))
    check('download 不存在 → 400 可读错误（非 500）', r.status === 400 && /不存在/.test(r.json?.error ?? ''), 'status=' + r.status)
    r = await httpJson(port, '/api/files/download?scope=fx&path=' + Q('docs'))
    check('download 目录 → 400 可读错误', r.status === 400 && /不是文件/.test(r.json?.error ?? ''), JSON.stringify(r.json))
    // P0-2 流式下载（64MB）：真实 TTFB（响应头时点）+ 字节一致 + Content-Length 精确
    const dlPath = '/api/files/download?scope=fx&path=' + Q('big.bin')
    const refHash = await new Promise((resolve, reject) => {
      const h = createHash('sha256'); const s = createReadStream(BIG)
      s.on('data', d => h.update(d)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', reject)
    })
    const dl = await new Promise((resolve, reject) => {
      const t0 = Date.now()
      const chunks = []
      const req = httpRequest({ host: '127.0.0.1', port, path: dlPath }, (res) => {
        const ttfb = Date.now() - t0
        res.on('data', d => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, cl: res.headers['content-length'], ttfb, buf: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    check('P0-2 download 64MB → 200 + Content-Length=67108864 精确', dl.status === 200 && dl.cl === '67108864', 'cl=' + dl.cl)
    check('P0-2 download 64MB 字节 sha256 与磁盘一致', createHash('sha256').update(dl.buf).digest('hex') === refHash, 'dl=' + dl.buf.length + 'B')
    check('P0-2 流式成立：响应头毫秒级先行（TTFB=' + dl.ttfb + 'ms ≤ 800ms）', dl.ttfb <= 800, 'ttfb=' + dl.ttfb + 'ms')
    // P0-2 断连清理：下载 16MB 中途客户端断开 → 服务存活、后续正常
    const abortHappened = await new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/files/download?scope=fx&path=' + Q('big.bin') }, (res) => {
        let got = 0
        res.on('data', (d) => { got += d.length; if (got > 65536) req.destroy() })
        res.on('error', () => resolve(true))
        res.on('close', () => { if (got > 65536) resolve(true); else resolve(false) })
        res.on('end', () => resolve(false))
      })
      req.on('error', () => resolve(true))
      req.end()
      setTimeout(() => resolve(false), 5000)
    })
    await new Promise(r2 => setTimeout(r2, 300))
    const alive = await httpJson(port, '/api/files/list?scope=fx&path=empty')
    check('P0-2 下载中途客户端断连 → 服务存活且后续 list 正常', abortHappened && alive.status === 200, 'abort=' + abortHappened + ' alive=' + alive.status)
    // P0-2 非阻塞反证：64MB 下载挂起（客户端暂停读）期间并发 list 仍毫秒级响应（整读实现会阻塞事件循环）
    const concurrent = await new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/files/download?scope=fx&path=' + Q('big.bin') }, async (res) => {
        res.once('data', async () => {
          res.pause()
          const tA = Date.now()
          const listR = await fetch('http://127.0.0.1:' + port + '/api/files/list?scope=fx&path=empty').catch(() => null)
          const elapsed = Date.now() - tA
          res.resume(); res.on('end', () => resolve({ ok: listR !== null && listR.status === 200, elapsed }))
          res.on('error', () => resolve({ ok: false, elapsed }))
        })
        res.on('error', () => resolve({ ok: false, elapsed: -1 }))
      })
      req.on('error', () => resolve({ ok: false, elapsed: -1 }))
      req.end()
      setTimeout(() => resolve({ ok: false, elapsed: -2 }), 15000)
    })
    check('P0-2 非阻塞：64MB 下载挂起期间并发 list 响应 ' + concurrent.elapsed + 'ms（≤500ms）', concurrent.ok === true && concurrent.elapsed <= 500, JSON.stringify(concurrent))

    // ═══ B. 逃逸矩阵（TC-S3-09，read/download/list 三端点）═══
    // 注：样例按「原始 query 值」发送（含已编码形态），验证服务端单次解码后的拦截语义
    const escapes = [
      ['..%2Fsecret.txt', 'URL 编码 ../（单解码=越界）'],
      ['..%252Fsecret.txt', '双编码 ..%252F（字面量，不得二次解码）'],
      ['a/../../secret.txt', '多层 ..'],
      ['/abs/x.txt', '绝对路径'],
      ['C:/Windows/win.ini', 'Windows 盘符越根'],
      ['c:\\Windows\\win.ini', '小写盘符反斜杠'],
      ['ok.txt%00x', 'NUL 注入'],
      ['..\\secret.txt', '反斜杠 ..\\'],
    ]
    for (const [p, label] of escapes) {
      for (const ep of ['read', 'download', 'list']) {
        const rr = await httpJson(port, '/api/files/' + ep + '?scope=fx&path=' + p)
        const denied = rr.status === 400 || rr.status === 403
        check('逃逸矩阵 ' + ep + '(' + label + ') → 400/403', denied, 'status=' + rr.status + ' ' + (rr.json?.error ?? rr.buf.toString('utf8').slice(0, 80)))
      }
    }
    // 正向对照：根内合法相对路径仍可达（矩阵不误伤）
    r = await httpJson(port, '/api/files/read?scope=fx&path=docs/guide.txt')
    check('对照：根内 docs/guide.txt 正常 read', r.status === 200 && r.json?.content === 'guide content line1\nline2', 'status=' + r.status)

    // ═══ C. .git 防护（TC-S3-12）：根级应拒；嵌套仓库 .git 契约同样应拒（当前实现缺口 R1，此处记录实际结果）═══
    for (const ep of ['read', 'download', 'list']) {
      r = await httpJson(port, '/api/files/' + ep + '?scope=fx&path=' + Q('.git/config'))
      check('TC-S3-12 根级 .git/config ' + ep + ' → 403', r.status === 403, 'status=' + r.status + ' ' + (r.json?.error ?? ''))
    }
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('vendor/sub-repo/.git/config'))
    check('TC-S3-12(嵌套) read vendor/sub-repo/.git/config → 403 应拒', r.status === 403, '实际=' + r.status + ' 泄露=' + JSON.stringify((r.json ?? {}).content ?? '').slice(0, 50))
    r = await httpJson(port, '/api/files/download?scope=fx&path=' + Q('vendor/sub-repo/.git/config'))
    check('TC-S3-12(嵌套) download vendor/sub-repo/.git/config → 403 应拒', r.status === 403, '实际=' + r.status + ' 体=' + r.buf.toString('utf8').slice(0, 50))
    r = await httpJson(port, '/api/files/list?scope=fx&path=' + Q('vendor/sub-repo/.git'))
    check('TC-S3-12(嵌套) list vendor/sub-repo/.git → 403 应拒', r.status === 403, '实际=' + r.status)
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('.gitignore'))
    check('对照：.gitignore 精确匹配不误伤（路径不存在→400 而非 403）', r.status === 400, 'status=' + r.status)

    // ═══ D. 符号链接（TC-S3-10）═══
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('link-in/guide.txt'))
    check('TC-S3-10 根内 symlink(junction) 放行', r.status === 200 && r.json?.content === 'guide content line1\nline2', 'status=' + r.status)
    r = await httpJson(port, '/api/files/read?scope=fx&path=' + Q('link-out/secret.txt'))
    check('TC-S3-10 根外 symlink 目标 → 403/400 拦截', r.status === 403 || r.status === 400, 'status=' + r.status + ' ' + (r.json?.error ?? ''))
    r = await httpJson(port, '/api/files/download?scope=fx&path=' + Q('link-out/secret.txt'))
    check('TC-S3-10 download 根外 symlink → 403/400 拦截', r.status === 403 || r.status === 400, 'status=' + r.status)

    // ═══ E. TC-S3-14 大目录 ═══
    mkdirSync(join(root, 'bulk'), { recursive: true })
    for (let i = 0; i < 120; i++) writeFileSync(join(root, 'bulk', 'f' + i + '.txt'), 'x')
    r = await httpJson(port, '/api/files/list?scope=fx&path=bulk')
    check('TC-S3-14 大目录(120 项)全量返回不截断', r.status === 200 && r.json?.entries?.length === 120, 'n=' + (r.json?.entries?.length ?? ''))

    // ═══ F. TC-S3-15（片段）：既有端点并行可用 ═══
    r = await httpJson(port, '/api/fs/home')
    check('TC-S3-15 /api/fs 既有面不受影响（200）', r.status === 200 && r.json?.home, 'status=' + r.status)
    r = await httpJson(port, '/api/files/list?scope=fx&path=' + Q('docs'))
    check('TC-S3-15 文件面与既有面共存正常', r.status === 200 && r.json?.entries?.some(e => e.name === 'guide.txt'), 'status=' + r.status)
  } finally {
    child.kill()
    await new Promise(r2 => setTimeout(r2, 400))
  }

  // ═══ G. 仅回环（TC-S3-11，函数级 isLoopback）═══
  {
    const mod = await import(pathToFileURL(SERVE).href + '?l1=' + Date.now())
    const mk = (addr) => ({ socket: { remoteAddress: addr } })
    check('TC-S3-11 isLoopback(127.0.0.1)=true', mod.isLoopback(mk('127.0.0.1')) === true)
    check('TC-S3-11 isLoopback(::1)=true', mod.isLoopback(mk('::1')) === true)
    check('TC-S3-11 isLoopback(::ffff:127.0.0.1)=true', mod.isLoopback(mk('::ffff:127.0.0.1')) === true)
    check('TC-S3-11 isLoopback(10.0.0.5)=false（非回环 → 403 前置）', mod.isLoopback(mk('10.0.0.5')) === false)
    check('TC-S3-11 isLoopback(192.168.1.2)=false（非回环 → 403 前置）', mod.isLoopback(mk('192.168.1.2')) === false)
    check('TC-S3-11 isLoopback(空)=false', mod.isLoopback(mk('')) === false)
  }
} finally {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { }
}

const fails = results.filter(x => !x.pass)
console.log('\n──── T058-S3 L1 汇总 ──── PASS=' + passCount + ' FAIL=' + failCount)
if (fails.length) { console.log('失败项：'); for (const f of fails) console.log(' - ' + f.name + (f.extra ? '  [' + f.extra + ']' : '')) }
process.exit(failCount > 0 ? 1 : 0)
