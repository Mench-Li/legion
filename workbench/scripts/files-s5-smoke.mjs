// workbench/scripts/files-s5-smoke.mjs — S5 文件中心前端数据面冒烟（L1）。
// 用途：FilesView（workbench/src/components/FilesView.tsx）每个 UI 动作所走的真实 HTTP 序列，
//       在真实 serve.mjs 路由（进程内监听 127.0.0.1）上逐条断言 —— 含 XSS 内容夹具（TC-S5-08）、
//       未绑定空间引导错误（TC-S5-07）、上传即刷新数据面、截断/行数、二进制不可预览、下载字节一致等。
// 运行：node workbench/scripts/files-s5-smoke.mjs  （零第三方依赖；沙箱 spawn 受限时直跑等效）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'

const require = createRequire(import.meta.url)

// ── 夹具：临时目录模拟某空间绑定的 local_dir ──
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-s5-'))
const root = join(tmpRoot, 'localdir')
mkdirSync(join(root, 'docs'), { recursive: true })
mkdirSync(join(root, 'empty'), { recursive: true })
mkdirSync(join(root, 'sub', 'repo-dir'), { recursive: true })
mkdirSync(join(root, '.git'), { recursive: true }) // 根仓库元数据（列表不显示、内部禁读）
mkdirSync(join(root, 'sub', 'repo-dir', '.git'), { recursive: true }) // isRepo 标记
writeFileSync(join(root, '.git', 'config'), '[core]\n')
writeFileSync(join(root, 'README.md'), 'hello 世界\n第二行\n')
writeFileSync(join(root, 'xss-inject.txt'), '<script>alert(1)</script>\n<img src=x onerror=alert(document.cookie)>\n正文行\n')
writeFileSync(join(root, 'docs', 'note.md'), '# 说明\n<em>斜体示例</em>\n')
writeFileSync(join(root, 'big.log'), 'B'.repeat(300 * 1024))
writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0x00, 0x00]))
writeFileSync(join(root, '中文 文件名.txt'), '中文内容\n')

delete process.env.DSH_WORKBENCH_TOKEN
delete process.env.DSH_WORKBENCH_MAX_UPLOAD
process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([
  { id: 'software', name: 'software', localDir: root },
  { id: 'plain', name: 'plain', localDir: '' }, // 未绑定 → 引导（TC-S5-07）
])

const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?s5smoke=' + Date.now()
const m = await import(serveUrl)

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
await listen(m.server)
const base = 'http://127.0.0.1:' + m.server.address().port

// 与 FilesView/api.ts 同款查询串拼法
const qs = (params) => new URLSearchParams(params).toString()

function httpReq(method, pathWithQs, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + pathWithQs)
    const req = httpRequest(u, { method, headers: headers ?? {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const ct = res.headers['content-type'] ?? ''
        let json = null
        let text = null
        if (ct.includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')) } catch { text = buf.toString('utf8') } }
        else text = buf.toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, json, text, buffer: buf })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? '' : String(detail) })
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + String(detail).slice(0, 300)))
}

// ── ① 根列表（FilesView 挂载即拉）TC-S5-02 ──
{
  const r = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: '' }))
  check('S5-L1 根 list 200 + ok', r.status === 200 && r.json?.ok === true, r.status)
  const names = (r.json?.entries ?? []).map((e) => e.name)
  check('S5-L1 隐藏条目(.git)不进列表', !names.some((n) => n.startsWith('.')), names.join(','))
  const firstFile = (r.json?.entries ?? []).findIndex((e) => e.type === 'file')
  const lastDir = (r.json?.entries ?? []).map((e) => e.type).lastIndexOf('dir')
  check('S5-L1 目录在前、文件在后', firstFile > lastDir, firstFile + '/' + lastDir)
  check('S5-L1 根含 README/docs/big.log/xss 夹具', ['README.md', 'docs', 'big.log', 'xss-inject.txt'].every((n) => names.includes(n)), names.join(','))
  const entry = (r.json?.entries ?? []).find((e) => e.name === 'README.md')
  check('S5-L1 条目形状 name/type/size/mtime/ext', !!entry && typeof entry.size === 'number' && typeof entry.mtime === 'string' && entry.ext === 'md', JSON.stringify(entry))
  const subDir = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: 'sub' }))
  const repoDir = (subDir.json?.entries ?? []).find((e) => e.name === 'repo-dir')
  check('S5-L1 含 .git 的目录带 isRepo 标记', !!repoDir && repoDir.type === 'dir' && repoDir.isRepo === true, JSON.stringify(repoDir))
}

// ── ② 逐层导航 + 上级语义（path 相对路径）TC-S5-02 ──
{
  const r = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: 'docs' }))
  check('S5-L1 进入 docs 200', r.status === 200 && r.json?.ok === true, r.status)
  check('S5-L1 docs 含 note.md', (r.json?.entries ?? []).some((e) => e.name === 'note.md'), JSON.stringify(r.json?.entries))
  const up = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: '' }))
  check('S5-L1 返回根 200', up.status === 200 && up.json?.ok === true, up.status)
}

// ── ③ 预览：文本/截断/二进制/XSS 内容原样返回 TC-S5-03 / S5-08 / S5-10 ──
{
  const p = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: 'README.md' }))
  check('S5-L1 README 预览 200 ok:true', p.status === 200 && p.json?.ok === true && p.json?.binary === false, JSON.stringify(p.json))
  check('S5-L1 中文内容原样 + 行数', p.json?.content === 'hello 世界\n第二行\n' && p.json?.lineCount === 2 && p.json?.truncated === false, JSON.stringify(p.json))
  const big = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: 'big.log' }))
  check('S5-L1 big.log truncated=true + totalBytes=300KB', big.json?.truncated === true && big.json?.totalBytes === 300 * 1024 && big.json?.content?.length === m.FILES_LIMITS.MAX_READ, JSON.stringify({ t: big.json?.truncated, bytes: big.json?.totalBytes, len: big.json?.content?.length }))
  const bin = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: 'pic.png' }))
  check('S5-L1 二进制 → binary:true + 不可预览提示', bin.json?.binary === true && /不可预览/.test(bin.json?.message ?? ''), JSON.stringify(bin.json))
  const xss = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: 'xss-inject.txt' }))
  check('S5-L1 XSS 内容原样 JSON 返回（无转义篡改）', xss.status === 200 && xss.json?.content?.includes('<script>alert(1)</script>') && xss.json?.content?.includes('<img src=x onerror='), JSON.stringify(xss.json?.content))
}

// ── ④ 上传 → 立即可见（重拉 list）TC-S5-04；409/覆盖语义 TC-S5-09 ──
const uploadBytes = Buffer.from('上传的中文内容：s5-smoke\n', 'utf8')
{
  const u = await httpReq('PUT', '/api/files/upload?' + qs({ scope: 'software', path: '上传-中文名.txt' }), uploadBytes)
  check('S5-L1 上传新文件 200', u.status === 200 && u.json?.ok === true, u.status + JSON.stringify(u.json))
  const after = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: '' }))
  check('S5-L1 上传后 list 立即可见（无需重挂）', (after.json?.entries ?? []).some((e) => e.name === '上传-中文名.txt'), JSON.stringify(after.json?.entries?.map((e) => e.name)))
  const dup = await httpReq('PUT', '/api/files/upload?' + qs({ scope: 'software', path: '上传-中文名.txt' }), uploadBytes)
  check('S5-L1 同名再传 → 409（UI 触发覆盖确认）', dup.status === 409 && /overwrite/.test(dup.json?.error ?? ''), dup.status + JSON.stringify(dup.json))
  const ov = await httpReq('PUT', '/api/files/upload?' + qs({ scope: 'software', path: '上传-中文名.txt', overwrite: '1' }), Buffer.from('v2 覆盖内容\n', 'utf8'))
  check('S5-L1 overwrite=1 → 200', ov.status === 200 && ov.json?.ok === true, ov.status + JSON.stringify(ov.json))
}

// ── ⑤ 下载字节一致 TC-S5-05 ──
{
  const d = await httpReq('GET', '/api/files/download?' + qs({ scope: 'software', path: '上传-中文名.txt' }))
  check('S5-L1 download 200 + Content-Length + Disposition', d.status === 200 && Number(d.headers['content-length']) === Buffer.byteLength('v2 覆盖内容\n') && /attachment/.test(d.headers['content-disposition'] ?? ''), JSON.stringify(d.headers))
  check('S5-L1 下载字节 = 源字节', d.buffer.equals(Buffer.from('v2 覆盖内容\n', 'utf8')), d.buffer.toString())
}

// ── ⑥ mkdir/rename/delete（confirm 语义）TC-S5-09 ──
{
  const mk = await httpReq('POST', '/api/files/mkdir', JSON.stringify({ scope: 'software', path: 'a/b/c' }), { 'content-type': 'application/json' })
  check('S5-L1 mkdir 嵌套 a/b/c 200', mk.status === 200 && mk.json?.ok === true, mk.status + JSON.stringify(mk.json))
  const rn = await httpReq('POST', '/api/files/rename', JSON.stringify({ scope: 'software', from: 'a/b/c', to: 'a/b/d' }), { 'content-type': 'application/json' })
  check('S5-L1 rename a/b/c→a/b/d 200', rn.status === 200 && rn.json?.ok === true, rn.status + JSON.stringify(rn.json))
  const delNo = await httpReq('POST', '/api/files/delete', JSON.stringify({ scope: 'software', path: '上传-中文名.txt' }), { 'content-type': 'application/json' })
  check('S5-L1 删除无 confirm → 400 提示 confirm=yes', delNo.status === 400 && /confirm=yes/.test(delNo.json?.error ?? ''), delNo.status + JSON.stringify(delNo.json))
  const still = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: '' }))
  check('S5-L1 取消删除后文件仍在', (still.json?.entries ?? []).some((e) => e.name === '上传-中文名.txt'))
  const delYes = await httpReq('POST', '/api/files/delete', JSON.stringify({ scope: 'software', path: '上传-中文名.txt', confirm: 'yes' }), { 'content-type': 'application/json' })
  check('S5-L1 confirm=yes 删除 200', delYes.status === 200 && delYes.json?.ok === true, delYes.status + JSON.stringify(delYes.json))
  const gone = await httpReq('GET', '/api/files/list?' + qs({ scope: 'software', path: '' }))
  check('S5-L1 删除后 list 不再可见（刷新语义）', !(gone.json?.entries ?? []).some((e) => e.name === '上传-中文名.txt'))
  const readGone = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: '上传-中文名.txt' }))
  check('S5-L1 删除后 read → 400 路径不存在', readGone.status === 400, readGone.status + JSON.stringify(readGone.json))
  const delNonEmpty = await httpReq('POST', '/api/files/delete', JSON.stringify({ scope: 'software', path: 'sub', confirm: 'yes' }), { 'content-type': 'application/json' })
  check('S5-L1 非空目录删 → 400 拒绝', delNonEmpty.status === 400, delNonEmpty.status + JSON.stringify(delNonEmpty.json))
  const delEmpty = await httpReq('POST', '/api/files/delete', JSON.stringify({ scope: 'software', path: 'empty', confirm: 'yes' }), { 'content-type': 'application/json' })
  check('S5-L1 空目录 confirm=yes → 200', delEmpty.status === 200 && delEmpty.json?.ok === true, delEmpty.status + JSON.stringify(delEmpty.json))
}

// ── ⑦ 未绑定/未注册空间引导错误 TC-S5-07 ──
{
  const unbound = await httpReq('GET', '/api/files/list?' + qs({ scope: 'plain', path: '' }))
  check('S5-L1 未绑定 scope → 400「尚未绑定本地文件夹」', unbound.status === 400 && /尚未绑定本地文件夹/.test(unbound.json?.error ?? ''), unbound.status + JSON.stringify(unbound.json))
  const ghost = await httpReq('GET', '/api/files/list?' + qs({ scope: 'ghost', path: '' }))
  check('S5-L1 未注册 scope → 400「未注册」', ghost.status === 400 && /未注册/.test(ghost.json?.error ?? ''), ghost.status + JSON.stringify(ghost.json))
}

// ── ⑧ .git 内部禁读（TC-S5-02 语境 + S3 既有）──
{
  const g = await httpReq('GET', '/api/files/read?' + qs({ scope: 'software', path: '.git/config' }))
  check('S5-L1 .git/config → 403 拒绝', g.status === 403, g.status + JSON.stringify(g.json))
}

const failed = results.filter((r) => !r.pass)
console.log('---')
console.log('S5 smoke: ' + (results.length - failed.length) + '/' + results.length + ' passed')

// 清理
for (const srv of [m.server]) { try { srv.closeAllConnections?.() } catch {} try { srv.close() } catch {} }
delete process.env.DSH_WORKBENCH_SPACES_JSON
rmSync(tmpRoot, { recursive: true, force: true })

if (failed.length > 0) { console.error('FAILED: ' + failed.map((f) => f.name).join('; ')); process.exit(1) }
process.exit(0)
