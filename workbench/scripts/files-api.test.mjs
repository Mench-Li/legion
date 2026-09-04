// workbench/scripts/files-api.test.mjs — 文件中心「只读面 + 写面」契约测试（对齐 docs/TEST_CASES.md TC-S3-01..15 / TC-S4-01..17）。
// S1（T-077）追加：R-A1 嵌套/内嵌 .git 防护矩阵（任一层段 .git 即拒 + realpath 复检防符号链接绕入，读+写同强度）
//   + R-A2 畸形 percent-encoding 注入（%zz 等 → 400/404、进程存活、≥10 并发不崩）。
// 运行：node workbench/scripts/files-api.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test）
// 说明：serve.mjs 以 isMain 守卫 + 纯函数导出支持 import 直测；scope→local_dir 解析经 DSH_WORKBENCH_SPACES_JSON 注入（免起中枢）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'

// 环境注：serve.mjs 若已在宿主进程被 import 过会复用模块缓存，这里用查询串强制新实例（与 server.mjs 测试同法）。
// 三个实例（各自独立 module + server 对象，供进程内 HTTP 路由层用例，见文末 S4 路由层 describes）：
//   m     —— 未配置 token（写放行，AC2 现状语义）+ 真实 MAX_UPLOAD（64MB）
//   mTok  —— DSH_WORKBENCH_TOKEN=tk（TC-S4-13 401/200 鉴权矩阵）
//   mCap  —— DSH_WORKBENCH_MAX_UPLOAD=16384（廉价实测流式超限/中断；env 为 serve.mjs 测试注入口，先例 DSH_WEB_FETCH_ALLOW_PRIVATE）
const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?files=' + Date.now()
delete process.env.DSH_WORKBENCH_TOKEN
delete process.env.DSH_WORKBENCH_MAX_UPLOAD
const m = await import(serveUrl)
process.env.DSH_WORKBENCH_TOKEN = 'tk'
const mTok = await import(serveUrl + '&tok=1')
delete process.env.DSH_WORKBENCH_TOKEN
process.env.DSH_WORKBENCH_MAX_UPLOAD = '16384'
const mCap = await import(serveUrl + '&cap=1')
delete process.env.DSH_WORKBENCH_MAX_UPLOAD

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-files-'))
const root = join(tmpRoot, 'repo')
const outsideDir = join(tmpRoot, 'outside')
const BS = String.fromCharCode(92) // 反斜杠，避免测试源码里的转义歧义

before(() => {
  // 目录根 = 绑定空间的 local_dir（模拟 team-hub spaces.local_dir）
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'nonempty'), { recursive: true })
  mkdirSync(join(root, 'empty'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, 'README.md'), 'hello 世界\n第二行')
  writeFileSync(join(root, 'docs', 'guide.txt'), 'guide content')
  writeFileSync(join(root, 'nonempty', 'keep.txt'), 'x')
  writeFileSync(join(root, 'big.log'), 'x'.repeat(300 * 1024))
  writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))
  writeFileSync(join(root, '中文 文件.txt'), '中文内容')
  // 符号链接/挂载点逃逸样本：link-in（指向根内）放行；link-out（指向根外目录）必须拦截
  mkdirSync(join(outsideDir, 'sub'), { recursive: true })
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret outside content')
  try { symlinkSync(outsideDir, join(root, 'link-out'), 'junction') } catch { /* 无权限则跳过 link-out 断言 */ }
  try { symlinkSync(join(root, 'docs'), join(root, 'link-in'), 'junction') } catch { /* 无权限则跳过 link-in 断言 */ }
  // S1（T-077 R-A1）嵌套/内嵌 .git 夹具：subrepo=含独立 .git 的嵌套仓库；submod/.git=submodule/worktree 指针文件形态；
  // link-to-git=junction 指向 root/.git 内部（realpath 复检样本，读/写面均应拒绝）
  mkdirSync(join(root, 'subrepo', '.git', 'objects', 'pack'), { recursive: true })
  writeFileSync(join(root, 'subrepo', '.git', 'config'), '[core]\nNESTED-LEAK-MARKER\n')
  writeFileSync(join(root, 'subrepo', 'readme.txt'), 'subrepo readable')
  mkdirSync(join(root, 'submod'), { recursive: true })
  writeFileSync(join(root, 'submod', '.git'), 'gitdir: ../.git/modules/submod')
  try { symlinkSync(join(root, '.git'), join(root, 'link-to-git'), 'junction') } catch { /* 无权限则跳过 link-to-git 断言 */ }
  process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: '文件夹具', localDir: root }])
})

// 进程内 HTTP 路由层用例：三个 serve.mjs 实例监听 127.0.0.1 随机端口（TC-S4-01..16 上行真路由验证）
const httpBases = { plain: '', token: '', cap: '' }
before(async () => {
  const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  await listen(m.server); httpBases.plain = 'http://127.0.0.1:' + m.server.address().port
  await listen(mTok.server); httpBases.token = 'http://127.0.0.1:' + mTok.server.address().port
  await listen(mCap.server); httpBases.cap = 'http://127.0.0.1:' + mCap.server.address().port
})

after(() => {
  delete process.env.DSH_WORKBENCH_SPACES_JSON
  for (const srv of [m.server, mTok.server, mCap.server]) {
    try { srv.closeAllConnections?.() } catch { /* 无连接/已关 */ }
    try { srv.close() } catch { /* 已关 */ }
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('TC-S3-01/02/03 list 形状 + 根语义 + scope 未绑定', () => {
  it('TC-S3-01 目录在前、按名排序、形状完整；隐藏目录与 .git 不出现；含 .git 的目录带 isRepo', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const list = m.listDirEntries(rootDir, '')
    assert.equal(list.path, '')
    const names = list.entries.map(e => e.name)
    assert.ok(!names.some(n => n.startsWith('.')), '隐藏条目不出现在列表')
    // dirs first
    const firstDir = list.entries.findIndex(e => e.type === 'file')
    const lastDir = list.entries.map(e => e.type).lastIndexOf('dir')
    assert.ok(lastDir < firstDir, '目录全部排在文件之前')
    const readme = list.entries.find(e => e.name === 'README.md')
    assert.ok(readme && readme.type === 'file' && readme.size > 0 && readme.ext === 'md' && readme.mtime)
    const docs = list.entries.find(e => e.name === 'docs')
    assert.ok(docs && docs.type === 'dir' && docs.ext === '' )
  })
  it('TC-S3-02 空目录 → entries=[]，不存在目录 → 400 语义错误', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    assert.deepEqual(m.listDirEntries(rootDir, 'empty').entries, [])
    assert.throws(() => m.listDirEntries(rootDir, 'ghost'), /不存在|路径不是目录/)
  })
  it('TC-S3-03 未绑定/不存在的 scope → 引导错误，绝不落到任意目录', async () => {
    process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'other', name: 'other', localDir: '' }])
    await assert.rejects(() => m.resolveScopeLocalDir('ghost'), /未注册：请先在空间设置/)
    await assert.rejects(() => m.resolveScopeLocalDir('other'), /尚未绑定本地文件夹/)
    process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: '文件夹具', localDir: root }])
  })
})

describe('TC-S3-05/06/07 read 预览（文本/截断/二进制）', () => {
  it('TC-S3-05 文本预览：中文原样、行数正确、不截断', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const p = m.previewTextFile(rootDir, 'README.md')
    assert.equal(p.binary, false)
    assert.equal(p.content, 'hello 世界\n第二行')
    assert.equal(p.lineCount, 2)
    assert.equal(p.truncated, false)
    assert.equal(p.totalBytes, Buffer.byteLength('hello 世界\n第二行'))
  })
  it('TC-S3-06 超过 MAX_READ → truncated=true，content 恰为上限、totalBytes 为全量', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const p = m.previewTextFile(rootDir, 'big.log')
    assert.equal(p.truncated, true)
    assert.equal(p.content.length, m.FILES_LIMITS.MAX_READ)
    assert.equal(p.totalBytes, 300 * 1024)
    assert.ok(p.lineCount <= 1)
  })
  it('TC-S3-07 二进制/目录/缺失 → 不可预览或 400', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const png = m.previewTextFile(rootDir, 'pic.png')
    assert.equal(png.binary, true)
    assert.equal(png.message, '二进制文件不可预览')
    assert.throws(() => m.previewTextFile(rootDir, 'docs'), /目录/)
    assert.throws(() => m.previewTextFile(rootDir, 'missing.txt'), /不存在/)
  })
  it('TC-S3-08 download 字节一致（含中文名文件）', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const d = m.readFileBytes(rootDir, '中文 文件.txt')
    assert.equal(d.buffer.toString('utf8'), '中文内容')
    assert.equal(d.name, '中文 文件.txt')
    const big = m.readFileBytes(rootDir, 'big.log')
    assert.equal(big.buffer.length, 300 * 1024)
  })
})

describe('TC-S3-08b 下载路由层 P0-2：openDownloadStream 流式（不整读内存）', () => {
  it('openDownloadStream 返回 length+可读流且字节一致；目录/.git/越界/symlink 同强度拒绝', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const d = m.openDownloadStream(rootDir, '中文 文件.txt')
    assert.equal(d.name, '中文 文件.txt')
    assert.equal(d.length, Buffer.byteLength('中文内容'))
    const chunks = []
    for await (const c of d.stream) chunks.push(c)
    assert.equal(Buffer.concat(chunks).toString('utf8'), '中文内容')
    assert.throws(() => m.openDownloadStream(rootDir, 'docs'), /不是文件/)
    assert.throws(() => m.openDownloadStream(rootDir, '.git/config'), /禁止访问 .git/)
    for (const s of ['../secret.txt', 'C:/Windows/win.ini', 'a/../../x']) {
      assert.throws(() => m.openDownloadStream(rootDir, s), /越界|相对路径/, 'escape ' + s)
    }
    if (existsSync(join(root, 'link-out'))) {
      assert.throws(() => m.openDownloadStream(rootDir, 'link-out/secret.txt'), /越界：符号链接/)
    }
  })
})

describe('TC-S3-09/10 + TC-S4-14 路径逃逸矩阵（全部拒绝）', () => {
  it('词法/绝对/NUL/编码等价样本在 list/read 全被拒', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const samples = [
      '../outside.txt',
      '..' + BS + 'outside.txt',
      'a/../../outside.txt',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'C:' + BS + 'Windows' + BS + 'win.ini',
      'docs/' + BS + '..' + BS + 'outside.txt',
      'a\u0000b',
    ]
    for (const s of samples) {
      assert.throws(() => m.previewTextFile(rootDir, s), /越界|相对路径|非法字符|不存在/, 'preview: ' + JSON.stringify(s))
      assert.throws(() => m.listDirEntries(rootDir, s), /越界|相对路径|非法字符|不存在|路径不是目录/, 'list: ' + JSON.stringify(s))
    }
  })
  it('TC-S3-10 符号链接：link-in（根内）放行；link-out（根外）越界拦截', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    if (existsSync(join(root, 'link-in'))) {
      const p = m.previewTextFile(rootDir, 'link-in/guide.txt')
      assert.equal(p.content, 'guide content')
    }
    if (existsSync(join(root, 'link-out'))) {
      assert.throws(() => m.previewTextFile(rootDir, 'link-out/secret.txt'), /越界：符号链接/)
      assert.throws(() => m.uploadBytes(rootDir, 'link-out/evil.txt', Buffer.from('x'), {}), /越界：符号链接/)
      assert.throws(() => m.listDirEntries(rootDir, 'link-out'), /越界：符号链接/)
    }
  })
  it('TC-S4-14 写操作逃逸样本（upload/mkdir/rename/delete）全被拒', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const evil = ['../evil.txt', '..' + BS + 'evil.txt', 'C:/evil.txt', '/evil.txt']
    for (const s of evil) {
      assert.throws(() => m.uploadBytes(rootDir, s, Buffer.from('x'), { overwrite: true }), /越界|相对路径|非法字符/, 'upload ' + s)
      assert.throws(() => m.createDir(rootDir, s), /越界|相对路径|非法字符/, 'mkdir ' + s)
      assert.throws(() => m.renamePath(rootDir, 'README.md', s), /越界|相对路径|非法字符/, 'rename-to ' + s)
      assert.throws(() => m.removePath(rootDir, s, 'yes'), /越界|相对路径|非法字符/, 'delete ' + s)
    }
    assert.throws(() => m.removePath(rootDir, '', 'yes'), /不能指向目录根/, 'root 本身不可删')
  })
  it('TC-S3-12 .git 内部拒绝访问（含写）', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    assert.throws(() => m.previewTextFile(rootDir, '.git/config'), /禁止访问 .git/)
    assert.throws(() => m.uploadBytes(rootDir, '.git/hooks/x', Buffer.from('x'), {}), /禁止访问 .git/)
    assert.throws(() => m.removePath(rootDir, '.git/config', 'yes'), /禁止访问 .git/)
  })
})

describe('TC-S4-01/02 upload 成功与上限', () => {
  it('TC-S4-01 上传新文件（中文名 + 嵌套目录）成功并可按字节读回', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    m.createDir(rootDir, '上传')
    const up = m.uploadBytes(rootDir, '上传/新 文件.txt', Buffer.from('uploaded 内容'))
    assert.equal(up.name, '新 文件.txt')
    assert.equal(m.readFileBytes(rootDir, '上传/新 文件.txt').buffer.toString('utf8'), 'uploaded 内容')
    assert.equal(m.listDirEntries(rootDir, '').entries.find(e => e.name === '上传').type, 'dir')
  })
  it('TC-S4-02 MAX_UPLOAD 恰好可传；+1 拒绝且目标不落盘', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const okBuf = Buffer.alloc(m.FILES_LIMITS.MAX_UPLOAD, 65)
    const ok = m.uploadBytes(rootDir, 'max.bin', okBuf, { overwrite: true })
    assert.equal(ok.size, m.FILES_LIMITS.MAX_UPLOAD)
    const overBuf = Buffer.alloc(m.FILES_LIMITS.MAX_UPLOAD + 1, 66)
    assert.throws(() => m.uploadBytes(rootDir, 'over.bin', overBuf, {}), /上传超过上限/)
    assert.equal(existsSync(join(root, 'over.bin')), false)
  })
})

describe('TC-S4-03/04 overwrite 两态', () => {
  it('存在文件无 overwrite → 拒绝；overwrite=1 → 覆盖成功且字节更新', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    m.uploadBytes(rootDir, 'docs/ow.txt', Buffer.from('v1'))
    assert.throws(() => m.uploadBytes(rootDir, 'docs/ow.txt', Buffer.from('v2')), /已存在/)
    m.uploadBytes(rootDir, 'docs/ow.txt', Buffer.from('v2'), { overwrite: true })
    assert.equal(m.readFileBytes(rootDir, 'docs/ow.txt').buffer.toString('utf8'), 'v2')
    // 目录为目标 → 拒绝
    assert.throws(() => m.uploadBytes(rootDir, 'docs', Buffer.from('x'), { overwrite: true }), /目录/)
  })
})

describe('TC-S4-05..08 mkdir / rename', () => {
  it('TC-S4-05/06 mkdir 多层成功；已存在 → 拒绝', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    m.createDir(rootDir, 'deep/a/b')
    assert.equal(m.listDirEntries(rootDir, 'deep/a').entries.find(e => e.name === 'b').type, 'dir')
    assert.throws(() => m.createDir(rootDir, 'deep/a/b'), /已存在/)
    assert.throws(() => m.createDir(rootDir, 'README.md'), /已存在/)
    assert.throws(() => m.createDir(rootDir, 'README.md/sub'), /创建目录失败|已存在/)
  })
  it('TC-S4-07/08 rename 成功迁移；目标已存在/源缺失 → 拒绝', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    m.uploadBytes(rootDir, 'a.txt', Buffer.from('rename me'))
    m.renamePath(rootDir, 'a.txt', 'b.txt')
    assert.equal(existsSync(join(root, 'a.txt')), false)
    assert.equal(m.readFileBytes(rootDir, 'b.txt').buffer.toString('utf8'), 'rename me')
    assert.throws(() => m.renamePath(rootDir, 'b.txt', 'README.md'), /目标已存在/)
    assert.throws(() => m.renamePath(rootDir, 'ghost.txt', 'c.txt'), /源路径不存在/)
  })
})

describe('TC-S4-09..12 delete confirm 语义', () => {
  it('缺 confirm / confirm 非 yes → 拒绝；confirm=yes 删除文件', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    m.uploadBytes(rootDir, 'del.txt', Buffer.from('x'))
    assert.throws(() => m.removePath(rootDir, 'del.txt'), /confirm=yes/)
    assert.throws(() => m.removePath(rootDir, 'del.txt', 'nope'), /confirm=yes/)
    m.removePath(rootDir, 'del.txt', 'yes')
    assert.equal(existsSync(join(root, 'del.txt')), false)
  })
  it('TC-S4-09/10/11 非空目录拒绝；空目录 confirm=yes 删除', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    assert.throws(() => m.removePath(rootDir, 'nonempty', 'yes'), /非空目录拒绝删除/)
    m.removePath(rootDir, 'empty', 'yes')
    assert.equal(existsSync(join(root, 'empty')), false)
  })
  it('TC-S4-12 删除不存在的路径 → 400', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    assert.throws(() => m.removePath(rootDir, 'nope.txt', 'yes'), /不存在/)
  })
})

describe('TC-S4-13 token 矩阵（函数级 isLoopback 语义；HTTP 401/200 矩阵见文末路由层 describe）', () => {
  it('函数导出存在且 FILES_LIMITS 常量可被三值法引用', () => {
    assert.ok(m.FILES_LIMITS.MAX_READ > 0)
    assert.ok(m.FILES_LIMITS.MAX_UPLOAD > 0)
    assert.equal(typeof m.isLoopback, 'function')
    assert.equal(typeof m.listDirEntries, 'function')
  })
  it('TC-S3-11 仅回环：假 socket 非回环 → isLoopback=false', () => {
    assert.equal(m.isLoopback({ socket: { remoteAddress: '10.0.0.8' } }), false)
    assert.equal(m.isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true)
  })
})

// ─────────────────────── S4 路由层 HTTP 用例（真 serve.mjs 路由 + 进程内监听；TC-S4-01..16 上行验证）───────────────────────
const encQ = encodeURIComponent
async function httpJson(base, method, path, { query = '', body, headers = {} } = {}) {
  const init = { method, headers }
  if (body !== undefined) init.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const res = await fetch(base + path + query, init)
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON 体 */ }
  return { status: res.status, json, text }
}
async function waitFor(fn, timeoutMs = 3000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时（' + timeoutMs + 'ms）')
    await new Promise((r) => setTimeout(r, 50))
  }
}
function tmpResidue(dir) {
  return readdirSync(dir).filter((n) => n.includes('.upload-') || n.endsWith('.tmp'))
}

describe('S4 路由层（HTTP）· 写契约 e2e —— 未配置 token 时写放行（AC2 现状语义）', () => {
  before(() => mkdirSync(join(root, 'http'), { recursive: true }))
  it('TC-S4-01：PUT 上传（中文名+空格）→ 200；list 立即可见；download 字节一致', async () => {
    const bytes = Buffer.from('HTTP 上传内容 αβγ')
    const rel = 'http/上传 文件.bin'
    const up = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ(rel), body: bytes })
    assert.equal(up.status, 200)
    assert.equal(up.json.ok, true)
    assert.equal(up.json.file.name, '上传 文件.bin')
    assert.equal(up.json.file.size, bytes.length)
    const list = await httpJson(httpBases.plain, 'GET', '/api/files/list', { query: '?scope=fx&path=' + encQ('http') })
    assert.equal(list.status, 200)
    assert.ok(list.json.entries.some((e) => e.name === '上传 文件.bin'), '上传后 list 立即可见')
    const dl = await fetch(httpBases.plain + '/api/files/download?scope=fx&path=' + encQ(rel))
    assert.equal(dl.status, 200)
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, 'download 与上传字节一致')
  })
  it('TC-S4-03/04：覆盖两态——无 overwrite → 409 且原内容未动；overwrite=1 → 200 新内容可读回', async () => {
    const rel = 'http/ow.txt'
    const q = '?scope=fx&path=' + encQ(rel)
    await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q, body: '第一版内容' })
    const dup = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q, body: '第二版' })
    assert.equal(dup.status, 409)
    assert.ok(dup.json.error.includes('overwrite=1'), '409 error 提示需 overwrite=1')
    const rd1 = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: q })
    assert.equal(rd1.json.content, '第一版内容', '409 后原文件内容未被改动')
    const ov = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&overwrite=1', body: '覆盖后内容' })
    assert.equal(ov.status, 200)
    const rd2 = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: q })
    assert.equal(rd2.json.content, '覆盖后内容')
  })
  it('TC-S4-05..08：mkdir 多层/重复/与文件冲突；rename 迁移/409/越界', async () => {
    const mk = (p) => httpJson(httpBases.plain, 'POST', '/api/files/mkdir', { body: { scope: 'fx', path: p } })
    assert.equal((await mk('http/d1/d2/d3')).status, 200, 'mkdir 一次建多层')
    assert.equal((await mk('http/d1/d2/d3')).status, 400, '重复 mkdir 拒绝')
    const l1 = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ('http/rn-a.txt'), body: 'aaa' })
    assert.equal(l1.status, 200)
    assert.equal((await mk('http/rn-a.txt/sub')).status, 400, '目录与文件同名冲突拒绝')
    const listD = await httpJson(httpBases.plain, 'GET', '/api/files/list', { query: '?scope=fx&path=' + encQ('http/d1/d2') })
    assert.ok(listD.json.entries.some((e) => e.name === 'd3' && e.type === 'dir'), '嵌套多层立即可见')
    const rn = (from, to) => httpJson(httpBases.plain, 'POST', '/api/files/rename', { body: { scope: 'fx', from, to } })
    await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ('http/rn-b.txt'), body: 'bbb' })
    assert.equal((await rn('http/rn-a.txt', 'http/rn-c.txt')).status, 200, 'rename 成功迁移')
    assert.equal((await rn('http/rn-c.txt', 'http/rn-b.txt')).status, 409, 'rename 到已存在目标 → 409')
    const rc = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ('http/rn-c.txt') })
    assert.equal(rc.json.content, 'aaa', 'rename 后内容一致')
    const esc = await rn('http/rn-c.txt', '../out-esc.txt')
    assert.ok([400, 403].includes(esc.status), 'rename 出根 → 400/403（实际 ' + esc.status + '）')
    assert.equal(existsSync(join(outsideDir, 'out-esc.txt')), false, '根外零副作用')
  })
  it('TC-S4-09..12：delete confirm 语义（缺/错 confirm 400、confirm=yes 删文件、非空目录拒删、空目录可删）', async () => {
    const del = (p, confirm) => httpJson(httpBases.plain, 'POST', '/api/files/delete', { body: { scope: 'fx', path: p, confirm } })
    const rel = 'http/del.txt'
    await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ(rel), body: 'x' })
    const noC = await del(rel)
    assert.equal(noC.status, 400)
    assert.ok(noC.json.error.includes('confirm'), '缺 confirm → 提示二次确认')
    assert.equal((await del(rel, 'nope')).status, 400, 'confirm 非 yes → 拒绝')
    const rd1 = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ(rel) })
    assert.equal(rd1.status, 200, '拒绝后文件仍在')
    assert.equal((await del(rel, 'yes')).status, 200)
    const rd2 = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ(rel) })
    assert.equal(rd2.status, 400, '删除成功后 read → 400 不存在')
    mkdirSync(join(root, 'http', 'nonempty2'), { recursive: true })
    writeFileSync(join(root, 'http', 'nonempty2', 'keep.txt'), 'x')
    const ne = await del('http/nonempty2', 'yes')
    assert.equal(ne.status, 400)
    assert.ok(ne.json.error.includes('非空目录'), '非空目录拒删并提示先清空')
    assert.ok(existsSync(join(root, 'http', 'nonempty2', 'keep.txt')), '非空目录内容原样保留')
    mkdirSync(join(root, 'http', 'empty2'), { recursive: true })
    assert.equal((await del('http/empty2', 'yes')).status, 200)
    assert.equal(existsSync(join(root, 'http', 'empty2')), false, '空目录删除后不可见')
  })
})

describe('S4 路由层（HTTP）· TC-S4-14 写路径逃逸矩阵 + TC-S4-02 预检 413（真实 64MB 上限）', () => {
  it('upload/mkdir/rename/delete 注入逃逸样本 → 全部 400/403，根外目录零副作用', async () => {
    const samples = ['../esc-out.txt', 'a/../../esc3.txt', 'C:/win-esc.txt', '/abs-esc.txt', '..%2Fesc-enc.txt', 'nul\x00name.txt']
    for (const s of samples) {
      const qPath = /%[0-9A-Fa-f]{2}/.test(s) ? s : encQ(s) // 已含 %XX 的样本原样进 URL（服务端解码一次成 ../ 再拦截）
      const r1 = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + qPath + '&overwrite=1', body: 'x' })
      assert.ok([400, 403].includes(r1.status), 'upload escape ' + JSON.stringify(s) + ' -> ' + r1.status)
    }
    for (const s of ['../esc-out2.txt', '..' + BS + 'esc-bs2.txt', 'a/../../esc4.txt', 'C:/win-esc2.txt', '/abs-esc2.txt', 'nul\x00name.txt']) {
      const mk = await httpJson(httpBases.plain, 'POST', '/api/files/mkdir', { body: { scope: 'fx', path: s } })
      assert.ok([400, 403].includes(mk.status), 'mkdir escape ' + JSON.stringify(s) + ' -> ' + mk.status)
      const rn = await httpJson(httpBases.plain, 'POST', '/api/files/rename', { body: { scope: 'fx', from: 'http/rn-c.txt', to: s } })
      assert.ok([400, 403].includes(rn.status), 'rename-to escape ' + JSON.stringify(s) + ' -> ' + rn.status)
      const del = await httpJson(httpBases.plain, 'POST', '/api/files/delete', { body: { scope: 'fx', path: s, confirm: 'yes' } })
      assert.ok([400, 403].includes(del.status), 'delete escape ' + JSON.stringify(s) + ' -> ' + del.status)
    }
    assert.deepEqual(readdirSync(outsideDir).sort(), ['secret.txt', 'sub'], '根外目录零副作用')
    assert.equal(readFileSync(join(outsideDir, 'secret.txt'), 'utf8'), 'secret outside content', '根外文件未被触碰')
  })
  it('TC-S4-02（预检）：声明 Content-Length 超真实 64MB 上限 → 413 快速拒绝、零落盘', async () => {
    const res = await new Promise((resolve) => {
      const rq = httpRequest({
        host: '127.0.0.1', port: new URL(httpBases.plain).port, method: 'PUT',
        path: '/api/files/upload?scope=fx&path=' + encQ('http/over-real.bin'),
        headers: { 'content-length': String(m.FILES_LIMITS.MAX_UPLOAD + 1) },
      }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode, body: t })) })
      rq.on('error', (e) => resolve({ status: 0, error: e.message }))
      rq.end()
    })
    assert.equal(res.status, 413, '预检应 413，实际 ' + JSON.stringify(res))
    assert.ok(res.body.includes('上传超过上限'))
    assert.equal(existsSync(join(root, 'http', 'over-real.bin')), false, '不落任何部分文件')
  })
})

describe('S4 路由层（HTTP）· TC-S4-13 鉴权矩阵（serve.mjs 配 token=tk）', () => {
  before(() => mkdirSync(join(root, 'http'), { recursive: true }))
  it('无 token 写 401 / 错 token 写 401 / 对 token 写 200；无 token 读仍放行 200', async () => {
    const rel = 'http/tok.txt'
    const q = '?scope=fx&path=' + encQ(rel)
    const none = await httpJson(httpBases.token, 'PUT', '/api/files/upload', { query: q, body: 'v1' })
    assert.equal(none.status, 401)
    assert.ok(none.json.error.includes('Bearer token 无效'), '401 error 可读')
    const wrong = await httpJson(httpBases.token, 'PUT', '/api/files/upload', { query: q, body: 'v1', headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)
    const right = await httpJson(httpBases.token, 'PUT', '/api/files/upload', { query: q, body: 'tokenized', headers: { authorization: 'Bearer tk' } })
    assert.equal(right.status, 200)
    assert.equal(right.json.ok, true)
    const rd = await httpJson(httpBases.token, 'GET', '/api/files/read', { query: q })
    assert.equal(rd.status, 200)
    assert.equal(rd.json.content, 'tokenized', '对 token 上传内容可读回')
    const list = await httpJson(httpBases.token, 'GET', '/api/files/list', { query: '?scope=fx&path=' + encQ('http') })
    assert.equal(list.status, 200, '读请求（list/read）无 token 仍放行——仅写需鉴权')
    const mk401 = await httpJson(httpBases.token, 'POST', '/api/files/mkdir', { body: { scope: 'fx', path: 'http/x1' } })
    assert.equal(mk401.status, 401, 'POST mkdir 无 token 同样 401')
  })
})

describe('S4 路由层（HTTP）· P0-1 原子上传回归（cap 实例 16KB）——流式超限/中断不破坏原文件、零残留', () => {
  const cap = mCap.FILES_LIMITS.MAX_UPLOAD // 16384（随实例 import 固化，注册期可读）
  const capBase = () => httpBases.cap // 基址必须运行期取：before 钩子才给 httpBases 赋值
  function rawUpload(pathQuery, { contentLength, chunkSize, total, destroyAfter } = {}) {
    return new Promise((resolve) => {
      const headers = {}
      if (contentLength !== undefined) headers['content-length'] = String(contentLength)
      const rq = httpRequest({ host: '127.0.0.1', port: new URL(capBase()).port, method: 'PUT', path: pathQuery, headers }, (res) => {
        let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode, body: t }))
      })
      rq.on('error', (e) => resolve({ status: 0, error: e.message }))
      if (chunkSize > 0 && total > 0) {
        const chunk = Buffer.alloc(chunkSize, 90)
        let sent = 0
        while (sent < total) { sent += chunk.length; rq.write(chunk) }
        rq.end()
      } else {
        rq.end()
      }
      if (destroyAfter !== undefined) setTimeout(() => { try { rq.destroy() } catch { /* */ } }, destroyAfter)
    })
  }
  it('TC-S4-02/15 + P0-1：overwrite=1 流式超限 → 413（或断连），原文件字节原样、无临时残留', async () => {
    const victim = 'p01-victim.bin'
    const original = 'ORIGINAL-DATA-' + Date.now()
    writeFileSync(join(root, victim), original)
    const res = await rawUpload('/api/files/upload?scope=fx&path=' + encQ(victim) + '&overwrite=1', { chunkSize: 4096, total: cap + 4096 })
    assert.ok(res.status === 413 || res.status === 0, '流式超限应 413 或断连，实际 ' + JSON.stringify(res))
    await waitFor(() => tmpResidue(root).length === 0)
    assert.equal(tmpResidue(root).length, 0, '无临时文件残留')
    assert.equal(readFileSync(join(root, victim), 'utf8'), original, '覆盖上传失败：原文件未被破坏（P0-1 数据丢失回归）')
  })
  it('TC-S4-02：流式超限上传到新路径 → 目标不落盘、无残留', async () => {
    const target = 'p01-new.bin'
    const res = await rawUpload('/api/files/upload?scope=fx&path=' + encQ(target), { chunkSize: 2048, total: cap + 2048 })
    assert.ok(res.status === 413 || res.status === 0)
    await waitFor(() => tmpResidue(root).length === 0)
    assert.equal(existsSync(join(root, target)), false, '超限目标不落任何部分文件')
  })
  it('P0-1：覆盖上传中途客户端中断 → 原文件保持、零残留、服务不崩', async () => {
    const victim2 = 'p01-victim2.bin'
    const original = 'ORIGINAL2-' + Date.now()
    writeFileSync(join(root, victim2), original)
    await rawUpload('/api/files/upload?scope=fx&path=' + encQ(victim2) + '&overwrite=1', { contentLength: 100000, chunkSize: 100, total: 400, destroyAfter: 120 })
    await waitFor(() => tmpResidue(root).length === 0)
    assert.equal(tmpResidue(root).length, 0, '无临时文件残留')
    assert.equal(readFileSync(join(root, victim2), 'utf8'), original, '中断后原文件保持原样')
    const health = await httpJson(capBase(), 'GET', '/api/files/list', { query: '?scope=fx&path=' })
    assert.equal(health.status, 200, '中断/超限后服务仍健康')
  })
  it('上限注入口不影响正常路径：上限内上传 200 且读回一致', async () => {
    const payload = 'x'.repeat(cap - 1)
    const rel = 'p01-ok.bin'
    const up = await httpJson(capBase(), 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ(rel), body: payload })
    assert.equal(up.status, 200)
    assert.equal(readFileSync(join(root, rel), 'utf8').length, cap - 1)
    assert.equal(tmpResidue(root).length, 0)
  })
})

describe('S4 路由层（HTTP）· TC-S4-16 并发上传同路径（无 overwrite）→ 至多一个 200', () => {
  it('两请求并发写同一新路径：一个 200 一个 409；最终字节 = 二写之一完整内容（无半写/混合）', async () => {
    const rel = 'http/race.bin'
    const q = '?scope=fx&path=' + encQ(rel)
    const pA = 'A'.repeat(8000)
    const pB = 'B'.repeat(8000)
    const results = await Promise.all([pA, pB].map((body) => httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q, body })))
    const statuses = results.map((r) => r.status).sort()
    assert.deepEqual(statuses, [200, 409], '至多一个 200、其余 409（实际 ' + JSON.stringify(statuses) + '）')
    const final = readFileSync(join(root, 'http', 'race.bin'), 'utf8')
    assert.ok(final === pA || final === pB, '最终内容为二写之一的完整内容')
  })
})

// ─────────────────────── S1（T-077）R-A1 嵌套 .git 防护矩阵 + R-A2 畸形路径不崩进程 ───────────────────────
describe('S1 R-A1 嵌套/内嵌 .git 防护（F1：任一层段 .git 即拒 + realpath 复检，读/写同强度）', () => {
  it('函数层：嵌套仓库 subrepo/.git/…（含深层/大小写变体/顶层对照）在 list/read/download 全部拒绝', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const gitTargets = [
      '.git', '.git/config', // 顶层对照
      'subrepo/.git', 'subrepo/.git/config', 'subrepo/.git/objects', 'subrepo/.git/objects/pack/x', // 嵌套仓库矩阵
      'subrepo/.GIT/config', // Windows 大小写变体（toLowerCase 比较 → 同样拒绝）
      'submod/.git', // submodule/worktree 指针文件形态（.git 文件）
    ]
    for (const rel of gitTargets) {
      assert.throws(() => m.listDirEntries(rootDir, rel), /禁止访问 \.git/, 'list ' + rel)
      assert.throws(() => m.previewTextFile(rootDir, rel), /禁止访问 \.git/, 'read ' + rel)
      assert.throws(() => m.openDownloadStream(rootDir, rel), /禁止访问 \.git/, 'download ' + rel)
    }
    // 对照：subrepo 工作区文件本身仍可读/可列——守卫只拦 .git 内部，不误伤嵌套仓库的非 .git 内容
    assert.equal(m.previewTextFile(rootDir, 'subrepo/readme.txt').content, 'subrepo readable')
    const subList = m.listDirEntries(rootDir, 'subrepo')
    assert.ok(subList.entries.length > 0 && subList.entries.every((e) => !e.name.startsWith('.')), 'subrepo 列表可见且不含隐藏 .git 子条目')
  })
  it('函数层：写面同强度——upload/mkdir/rename(from/to)/delete 对嵌套 .git 全部拒绝且零副作用', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    const gitTargets = ['subrepo/.git/config', 'subrepo/.git/new.txt', 'subrepo/.git/objects/pack/x']
    for (const rel of gitTargets) {
      assert.throws(() => m.uploadBytes(rootDir, rel, Buffer.from('x'), { overwrite: true }), /禁止访问 \.git/, 'upload ' + rel)
      assert.throws(() => m.createDir(rootDir, rel), /禁止访问 \.git/, 'mkdir ' + rel)
      assert.throws(() => m.renamePath(rootDir, 'README.md', rel), /禁止访问 \.git/, 'rename-to ' + rel)
      assert.throws(() => m.renamePath(rootDir, rel, 'README.md'), /禁止访问 \.git/, 'rename-from ' + rel)
      assert.throws(() => m.removePath(rootDir, rel, 'yes'), /禁止访问 \.git/, 'delete ' + rel)
    }
    assert.throws(() => m.uploadBytes(rootDir, '.git/config', Buffer.from('x'), { overwrite: true }), /禁止访问 \.git/, '顶层 .git 写对照')
    // 零副作用：嵌套 .git/config 内容原样、无新文件落盘
    assert.match(readFileSync(join(root, 'subrepo/.git/config'), 'utf8'), /NESTED-LEAK-MARKER/)
    assert.equal(existsSync(join(root, 'subrepo/.git/new.txt')), false, '嵌套 .git 内无新建文件')
  })
  it('HTTP 路由层：subrepo/.git/config 的 list/read/download/upload/mkdir/rename/delete 七操作全部 403；顶层 .git 对照仍 403；内容零外泄', async () => {
    const nested = 'subrepo/.git/config'
    const q = '?scope=fx&path=' + encQ(nested)
    const list = await httpJson(httpBases.plain, 'GET', '/api/files/list', { query: q })
    assert.equal(list.status, 403, 'list 应 403，实际 ' + list.status)
    const read = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: q })
    assert.equal(read.status, 403, 'read 应 403，实际 ' + read.status)
    assert.ok(!(read.text ?? '').includes('NESTED-LEAK-MARKER'), 'read 响应不含嵌套 .git 内容')
    const dl = await httpJson(httpBases.plain, 'GET', '/api/files/download', { query: q })
    assert.equal(dl.status, 403, 'download 应 403，实际 ' + dl.status)
    const up = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&overwrite=1', body: 'evil' })
    assert.equal(up.status, 403, 'upload 应 403，实际 ' + up.status)
    const mk = await httpJson(httpBases.plain, 'POST', '/api/files/mkdir', { body: { scope: 'fx', path: 'subrepo/.git/newdir' } })
    assert.equal(mk.status, 403, 'mkdir 应 403，实际 ' + mk.status)
    const rnTo = await httpJson(httpBases.plain, 'POST', '/api/files/rename', { body: { scope: 'fx', from: 'README.md', to: nested } })
    assert.equal(rnTo.status, 403, 'rename-to 应 403，实际 ' + rnTo.status)
    const rnFrom = await httpJson(httpBases.plain, 'POST', '/api/files/rename', { body: { scope: 'fx', from: nested, to: 'subrepo/leak.txt' } })
    assert.equal(rnFrom.status, 403, 'rename-from 应 403，实际 ' + rnFrom.status)
    const del = await httpJson(httpBases.plain, 'POST', '/api/files/delete', { body: { scope: 'fx', path: nested, confirm: 'yes' } })
    assert.equal(del.status, 403, 'delete 应 403，实际 ' + del.status)
    // 顶层 .git 对照
    const topQ = '?scope=fx&path=' + encQ('.git/config')
    assert.equal((await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: topQ })).status, 403, '顶层 .git read 对照仍 403')
    assert.equal((await httpJson(httpBases.plain, 'GET', '/api/files/download', { query: topQ })).status, 403, '顶层 .git download 对照仍 403')
    assert.equal((await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ('.git/hooks/evil') + '&overwrite=1', body: 'x' })).status, 403, '顶层 .git upload 对照仍 403')
    // 零副作用 + 不误伤嵌套仓库工作区
    assert.match(readFileSync(join(root, 'subrepo/.git/config'), 'utf8'), /NESTED-LEAK-MARKER/, '.git/config 未被改写')
    assert.equal(existsSync(join(root, 'subrepo/.git/newdir')), false, '.git 内未建目录')
    assert.equal(existsSync(join(root, 'subrepo/leak.txt')), false, '.git 内文件未被改名移出')
    const sane = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ('subrepo/readme.txt') })
    assert.equal(sane.status, 200, '嵌套仓库工作区普通文件仍可读（守卫只拦 .git 内部）')
    assert.equal(sane.json.content, 'subrepo readable')
  })
  it('符号链接指向 .git 内部（link-to-git → root/.git）经 realpath 复检在 list/read/download/写面全部拒绝', async () => {
    const rootDir = await m.resolveScopeLocalDir('fx')
    if (!existsSync(join(root, 'link-to-git'))) return // 无 junction 权限的环境跳过（同 link-in/link-out 先例）
    // 函数层：词法上不含 .git 段，只能靠 realpath 复检拦截
    assert.throws(() => m.listDirEntries(rootDir, 'link-to-git/config'), /禁止访问 \.git/, 'list via symlink→.git')
    assert.throws(() => m.previewTextFile(rootDir, 'link-to-git/config'), /禁止访问 \.git/, 'read via symlink→.git')
    assert.throws(() => m.openDownloadStream(rootDir, 'link-to-git/config'), /禁止访问 \.git/, 'download via symlink→.git')
    assert.throws(() => m.uploadBytes(rootDir, 'link-to-git/evil.txt', Buffer.from('x'), { overwrite: true }), /禁止访问 \.git/, 'upload via symlink→.git')
    assert.throws(() => m.createDir(rootDir, 'link-to-git/newdir'), /禁止访问 \.git/, 'mkdir via symlink→.git')
    assert.throws(() => m.renamePath(rootDir, 'README.md', 'link-to-git/evil.txt'), /禁止访问 \.git/, 'rename-to via symlink→.git')
    assert.throws(() => m.removePath(rootDir, 'link-to-git/config', 'yes'), /禁止访问 \.git/, 'delete via symlink→.git')
    // HTTP 路由层（真路由 realpath 复检）
    const rd = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ('link-to-git/config') })
    assert.equal(rd.status, 403, 'HTTP read via symlink→.git 应 403，实际 ' + rd.status)
    const dl = await httpJson(httpBases.plain, 'GET', '/api/files/download', { query: '?scope=fx&path=' + encQ('link-to-git/config') })
    assert.equal(dl.status, 403, 'HTTP download via symlink→.git 应 403，实际 ' + dl.status)
    const up = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: '?scope=fx&path=' + encQ('link-to-git/x') + '&overwrite=1', body: 'x' })
    assert.equal(up.status, 403, 'HTTP upload via symlink→.git 应 403，实际 ' + up.status)
    assert.equal(existsSync(join(root, 'link-to-git/x')), false, '符号链接目标（.git 内部）无落盘')
  })
})

describe('S1 R-A2 畸形 percent-encoding 注入不崩进程（F2：400/404 + 进程存活 + ≥10 并发）', () => {
  // 原始请求行直发（%zz 必须原样进 req.url——fetch 会先做 URL 规范化，这里用 node:http 底走真路由）
  function rawGet(path) {
    return new Promise((resolve) => {
      const rq = httpRequest({ host: '127.0.0.1', port: new URL(httpBases.plain).port, method: 'GET', path }, (res) => {
        let t = ''
        res.on('data', (d) => { t += d })
        res.on('end', () => resolve({ status: res.statusCode, body: t }))
      })
      rq.on('error', (e) => resolve({ status: 0, error: e.message, code: e.code, name: e.name }))
      rq.end()
    })
  }
  it('单发畸形 % 注入矩阵（%zz/悬空 %/重复 %/超长 ≥1 万字符）→ 400/404；同进程随后正常请求 200（进程存活）', async () => {
    // 前置：复现「413 预检毒化 keep-alive 连接」场景（TC-S4-02 预检同款——声明超上限 Content-Length 但一字节体都不发）。
    // 若服务端预检 413 后仍 keep-alive：连接停在「服务端等剩余体」的错位态，node:http 客户端会把该 socket 放回连接池，
    // 下一个 raw 请求（下方畸形样本）复用错位连接 → 被服务端误读为体字节 → 挂起约 6s 后 ECONNRESET（本轮实测实证）。
    // 修复后预检响应带 Connection: close → 连接不回流连接池，畸形样本必须仍即时 400/404（新连接），否则本测试失败。
    const poison = await new Promise((resolve) => {
      const rq = httpRequest({
        host: '127.0.0.1', port: new URL(httpBases.plain).port, method: 'PUT',
        path: '/api/files/upload?scope=fx&path=' + encQ('ra2-poison.bin'),
        headers: { 'content-length': String(m.FILES_LIMITS.MAX_UPLOAD + 1) },
      }, (res) => { let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode, body: t })) })
      rq.on('error', (e) => resolve({ status: 0, error: e.message }))
      rq.end()
    })
    assert.equal(poison.status, 413, '预检探针应 413，实际 ' + JSON.stringify(poison))
    assert.ok(String(poison.body ?? '').includes('上传超过上限'), '预检探针响应文案可读')
    const samples = [
      '/api/files%zz', // R-A2 验收原样样本：decodeURIComponent 抛 URIError → 400
      '/api/files/%zz',
      '/api/files/%',
      '/%zz',
      '/api%zz/files/list',
      '/api/files/list%zz%zz',
      '/index%zz.html',
      '/api/files/' + '%zz'.repeat(3000), // 超长畸形（约 9k 字符）
      '/api/files/read?scope=fx&path=' + encQ('README.md') + '%zz', // query 内混入畸形（URLSearchParams 容错 → 正常路径语义）
    ]
    for (const p of samples) {
      const r = await rawGet(p)
      assert.ok(r.status === 400 || r.status === 404, '样本 ' + JSON.stringify(p.slice(0, 40)) + ' 应 400/404，实际 ' + r.status + ' detail=' + JSON.stringify(r))
    }
    // 进程存活：同进程后续正常请求 200（若进程被击穿，这里连接将 000/ECONNREFUSED）
    const health = await httpJson(httpBases.plain, 'GET', '/api/files/list', { query: '?scope=fx&path=' })
    assert.equal(health.status, 200, '畸形注入后正常 list 仍 200（进程存活）')
    const read = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ('README.md') })
    assert.equal(read.status, 200)
    assert.equal(read.json.content, 'hello 世界\n第二行', '数据面不受畸形注入影响')
  })
  it('≥10 并发畸形请求不崩：全部 400/404、随后健康 200', async () => {
    const pool = ['/api/files%zz', '/api/files/%zz', '/%zz%zz%zz', '/api%zz/list', '/api/files/read%zz', '/api/files/' + '%zz'.repeat(4000)]
    const reqs = []
    for (let i = 0; i < 12; i += 1) reqs.push(pool[i % pool.length])
    const results = await Promise.all(reqs.map((p) => rawGet(p)))
    for (const r of results) {
      assert.ok(r.status === 400 || r.status === 404, '并发畸形应 400/404，实际 ' + r.status + '（' + JSON.stringify(r).slice(0, 100) + '）')
    }
    const health = await httpJson(httpBases.plain, 'GET', '/api/files/list', { query: '?scope=fx&path=' })
    assert.equal(health.status, 200, '12 并发畸形请求后进程仍存活（正常请求 200）')
  })
})
