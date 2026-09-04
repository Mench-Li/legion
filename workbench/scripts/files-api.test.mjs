// workbench/scripts/files-api.test.mjs — 文件中心「只读面 + 写面」契约测试（对齐 docs/TEST_CASES.md TC-S3-01..15 / TC-S4-01..17）。
// 运行：node workbench/scripts/files-api.test.mjs（沙箱 spawn 受限时直跑等效；宿主环境可 node --test）
// 说明：serve.mjs 以 isMain 守卫 + 纯函数导出支持 import 直测；scope→local_dir 解析经 DSH_WORKBENCH_SPACES_JSON 注入（免起中枢）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// 环境注：serve.mjs 若已在宿主进程被 import 过会复用模块缓存，这里用查询串强制新实例（与 server.mjs 测试同法）。
const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?files=' + Date.now()
const m = await import(serveUrl)

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
  process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: '文件夹具', localDir: root }])
})

after(() => {
  delete process.env.DSH_WORKBENCH_SPACES_JSON
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

describe('TC-S4-13 token 矩阵（函数级 isLoopback 语义；HTTP 401 矩阵在 evidence 冒烟）', () => {
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