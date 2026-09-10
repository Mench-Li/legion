// P2-7 文件中心增强 · 契约测试（后端）：上传冲突四策略 / 分片上传与断点续传 / 文件名搜索与批量操作 / git 只读。
//
// 形态说明（与 files-api.test.mjs 同法）：serve.mjs 以 isMain 守卫 + 纯函数导出，可直接 import 做函数级断言；
// 路由层用进程内实例监听 127.0.0.1 随机端口做真实 HTTP 断言。scope→local_dir 经 DSH_WORKBENCH_SPACES_JSON 注入（免起中枢）。
//
// 本套件刻意包含三类「反向断言」（证明没做的事）：
//   ① git 端点**只读**——调用前后 `git status --porcelain` 输出必须逐字节一致，且无 index.lock 残留；
//   ② 分片上传的临时会话目录**不出现在文件列表**、不被搜索命中、也不允许显式访问（保护断点续传）；
//   ③ 冲突/失败路径**零副作用**——skip 不覆盖、未收齐不落盘、中止后零残留。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?p27=' + Date.now()
delete process.env.DSH_WORKBENCH_TOKEN
delete process.env.DSH_WORKBENCH_MAX_UPLOAD
delete process.env.DSH_WORKBENCH_CHUNK_SIZE
const m = await import(serveUrl)
process.env.DSH_WORKBENCH_TOKEN = 'tk'
const mTok = await import(serveUrl + '&tok=1')
delete process.env.DSH_WORKBENCH_TOKEN
// 分片大小注入口：1024 → 路由层分片体上限 2048，可廉价实测「分片超限」分支
process.env.DSH_WORKBENCH_CHUNK_SIZE = '1024'
const mChunk = await import(serveUrl + '&chunk=1')
delete process.env.DSH_WORKBENCH_CHUNK_SIZE

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-p27-'))
const root = join(tmpRoot, 'repo')
const gitRepo = join(tmpRoot, 'gitrepo')
const outsideDir = join(tmpRoot, 'outside')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'P27', GIT_AUTHOR_EMAIL: 'p27@test.local',
  GIT_COMMITTER_NAME: 'P27', GIT_COMMITTER_EMAIL: 'p27@test.local',
}
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, windowsHide: true }).toString()

before(() => {
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'docs', 'deep'), { recursive: true })
  mkdirSync(join(root, 'dest'), { recursive: true })
  mkdirSync(join(root, 'chunk'), { recursive: true })
  mkdirSync(join(root, 'http-chunk'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, 'README.md'), 'hello\n')
  writeFileSync(join(root, 'docs', 'guide.txt'), 'guide content')
  writeFileSync(join(root, 'docs', 'Guide-2.md'), 'second guide')
  writeFileSync(join(root, 'docs', 'deep', 'nested-guide.txt'), 'nested')
  writeFileSync(join(root, 'conflict.txt'), 'V1')
  writeFileSync(join(root, 'dest', 'keep.txt'), 'keep')

  // 真实 git 仓库夹具（P2-7 ④）：已提交文件（随后修改 → M）、未跟踪文件（??）、暂存改名（R）、二进制改动
  mkdirSync(gitRepo, { recursive: true })
  git(gitRepo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(gitRepo, 'tracked.txt'), 'line1\nline2\nline3\n')
  writeFileSync(join(gitRepo, 'renamed-src.txt'), 'rename me\n')
  writeFileSync(join(gitRepo, 'blob.bin'), Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2, 3])]))
  git(gitRepo, ['add', '-A'])
  git(gitRepo, ['commit', '-q', '-m', 'P2-7 fixture 初始提交'])
  writeFileSync(join(gitRepo, 'tracked.txt'), 'line1\nCHANGED\nline3\n')
  writeFileSync(join(gitRepo, 'untracked.txt'), 'new file\n')
  git(gitRepo, ['mv', 'renamed-src.txt', 'renamed-dst.txt'])
  writeFileSync(join(gitRepo, 'blob.bin'), Buffer.concat([Buffer.from('BIN'), Buffer.from([9, 9, 9, 9])]))

  process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([
    { id: 'fx', name: '文件夹具', localDir: root },
    { id: 'gx', name: 'git 夹具', localDir: gitRepo },
  ])
})

const httpBases = { plain: '', token: '', chunk: '' }
before(async () => {
  const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  await listen(m.server); httpBases.plain = 'http://127.0.0.1:' + m.server.address().port
  await listen(mTok.server); httpBases.token = 'http://127.0.0.1:' + mTok.server.address().port
  await listen(mChunk.server); httpBases.chunk = 'http://127.0.0.1:' + mChunk.server.address().port
})

after(() => {
  delete process.env.DSH_WORKBENCH_SPACES_JSON
  for (const srv of [m.server, mTok.server, mChunk.server]) {
    try { srv.closeAllConnections?.() } catch { /* 无连接/已关 */ }
    try { srv.close() } catch { /* 已关 */ }
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const encQ = (s) => encodeURIComponent(s)
async function httpJson(base, method, path, { query = '', body, headers = {}, raw = false } = {}) {
  const res = await fetch(base + path + query, {
    method,
    headers: { ...(raw ? {} : (body === undefined ? {} : { 'Content-Type': 'application/json' })), ...headers },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, text }
}

const rootDir = () => m.resolveScopeLocalDir('fx')

// ───────────────────────── ① 上传冲突四策略 ─────────────────────────
describe('P2-7 ①上传冲突策略：ask/overwrite/skip/rename（函数级）', () => {
  it('ask（默认）：目标已存在 → 409 语义错误；目标不存在 → 正常写入', async () => {
    const d = await rootDir()
    assert.throws(() => m.uploadBytes(d, 'conflict.txt', Buffer.from('V2')), /已存在/)
    const ok = m.uploadBytes(d, 'docs/new-ask.txt', Buffer.from('fresh'))
    assert.equal(ok.skipped, false)
    assert.equal(readFileSync(join(root, 'docs', 'new-ask.txt'), 'utf8'), 'fresh')
    // 默认策略 = ask：不传 strategy / 传 '' / 传 null 都必须是 ask 语义
    assert.equal(m.normalizeUploadStrategy(undefined).strategy, 'ask')
    assert.equal(m.normalizeUploadStrategy('').strategy, 'ask')
    assert.equal(m.normalizeUploadStrategy(null).strategy, 'ask')
    assert.equal(m.normalizeUploadStrategy('overwrite').overwrite, true, 'overwrite 别名与策略保持一致')
  })

  it('overwrite：覆盖既有文件；目标为目录 → 拒（不能以文件覆盖目录）', async () => {
    const d = await rootDir()
    m.uploadBytes(d, 'conflict.txt', Buffer.from('V3'), { strategy: 'overwrite' })
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), 'V3')
    assert.throws(() => m.uploadBytes(d, 'docs', Buffer.from('x'), { strategy: 'overwrite' }), /目录/)
    assert.throws(() => m.uploadBytes(d, 'docs', Buffer.from('x'), { overwrite: true }), /目录/, 'overwrite:true 别名同样拒绝目录')
  })

  it('skip：目标已存在 → skipped=true 且**原内容不变**；目标不存在 → 正常写入', async () => {
    const d = await rootDir()
    const before = readFileSync(join(root, 'conflict.txt'), 'utf8')
    const out = m.uploadBytes(d, 'conflict.txt', Buffer.from('SHOULD-NOT-LAND'), { strategy: 'skip' })
    assert.equal(out.skipped, true)
    assert.equal(out.name, 'conflict.txt')
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), before, 'skip 策略零副作用')
    const fresh = m.uploadBytes(d, 'docs/skip-fresh.txt', Buffer.from('landed'), { strategy: 'skip' })
    assert.equal(fresh.skipped, false)
    assert.equal(readFileSync(join(root, 'docs', 'skip-fresh.txt'), 'utf8'), 'landed', '目标不存在时 skip 不阻碍写入')
  })

  it('rename：自动加 -1/-2 后缀（保留扩展名），原文件不动，响应回传实际落盘名', async () => {
    const d = await rootDir()
    const r1 = m.uploadBytes(d, 'conflict.txt', Buffer.from('R1'), { strategy: 'rename' })
    assert.equal(r1.name, 'conflict-1.txt')
    assert.equal(r1.requestedName, 'conflict.txt')
    const r2 = m.uploadBytes(d, 'conflict.txt', Buffer.from('R2'), { strategy: 'rename' })
    assert.equal(r2.name, 'conflict-2.txt', '连续 rename 递增后缀')
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), 'V3', '原文件始终未被改动')
    assert.equal(readFileSync(join(root, 'conflict-1.txt'), 'utf8'), 'R1')
    assert.equal(readFileSync(join(root, 'conflict-2.txt'), 'utf8'), 'R2')
  })

  it('未知策略 → 明确报错（不静默降级为 ask）；rename 取名跳过已存在的候选名', async () => {
    assert.throws(() => m.normalizeUploadStrategy('overwrit'), /未知上传冲突策略/)
    assert.throws(() => m.uploadBytes(root, 'conflict.txt', Buffer.from('x'), { strategy: 'nope' }), /未知上传冲突策略/)
    const d = await rootDir()
    writeFileSync(join(root, 'brand-new.txt'), 'base')
    writeFileSync(join(root, 'brand-new-1.txt'), 'occupied')
    const out = m.uploadBytes(d, 'brand-new.txt', Buffer.from('v'), { strategy: 'rename' })
    assert.equal(out.name, 'brand-new-2.txt', '跳过已占用的 -1 候选名')
  })

  it('rename 不会把「无扩展名」目标弄坏（与同名目录冲突 → docs-1 兄弟文件）', async () => {
    const d = await rootDir()
    mkdirSync(join(root, 'plainname'), { recursive: true })
    const out = m.uploadBytes(d, 'plainname', Buffer.from('as file'), { strategy: 'rename' })
    assert.equal(out.name, 'plainname-1')
    assert.equal(readFileSync(join(root, 'plainname-1'), 'utf8'), 'as file')
  })
})

describe('P2-7 ①上传冲突策略：HTTP 路由层（真路由）', () => {
  const bin = { 'Content-Type': 'application/octet-stream' }

  it('strategy=skip → 200 skipped=true 且原内容未动；strategy=rename → 200 file.name 为改名后目标', async () => {
    const q = '?scope=fx&path=' + encQ('http-conflict.txt')
    const first = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q, body: 'first', raw: true, headers: bin })
    assert.equal(first.status, 200)
    assert.equal(first.json.skipped, false)
    const skip = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&strategy=skip', body: 'second', raw: true, headers: bin })
    assert.equal(skip.status, 200)
    assert.equal(skip.json.skipped, true)
    assert.equal(skip.json.file.name, 'http-conflict.txt')
    const rd = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: q })
    assert.equal(rd.json.content, 'first', 'skip 后内容仍是第一版')
    const rn = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&strategy=rename', body: 'third', raw: true, headers: bin })
    assert.equal(rn.status, 200)
    assert.equal(rn.json.file.name, 'http-conflict-1.txt')
    assert.equal(rn.json.requestedName, 'http-conflict.txt')
    const rd2 = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: '?scope=fx&path=' + encQ('http-conflict-1.txt') })
    assert.equal(rd2.json.content, 'third')
  })

  it('未知 strategy → 400（不静默覆盖）；overwrite=1 旧参数仍生效（向后兼容）', async () => {
    const q = '?scope=fx&path=' + encQ('http-conflict.txt')
    const bad = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&strategy=whatever', body: 'x', raw: true, headers: bin })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /未知上传冲突策略/)
    const ov = await httpJson(httpBases.plain, 'PUT', '/api/files/upload', { query: q + '&overwrite=1', body: 'legacy', raw: true, headers: bin })
    assert.equal(ov.status, 200, 'overwrite=1 兼容路径仍可用')
    const rd = await httpJson(httpBases.plain, 'GET', '/api/files/read', { query: q })
    assert.equal(rd.json.content, 'legacy')
  })
})

// ───────────────────────── ② 分片上传与断点续传 ─────────────────────────
describe('P2-7 ②分片上传：init/chunk/complete/abort 与断点续传（函数级）', () => {
  const big = Buffer.from('0123456789'.repeat(4096)) // 40KB：跨多片

  it('init：签发 uploadId（u_+hex）、received=0、返回 chunkSize；同 path+size 再次 init → 复用会话（续传基础）', async () => {
    const d = await rootDir()
    const s1 = m.initChunkedUpload(d, { path: 'chunk/a.bin', size: big.length })
    assert.match(s1.uploadId, /^u_[0-9a-f]{32}$/)
    assert.equal(s1.received, 0)
    assert.equal(s1.size, big.length)
    assert.ok(s1.chunkSize > 0)
    assert.equal(s1.resumed, false)
    const s2 = m.initChunkedUpload(d, { path: 'chunk/a.bin', size: big.length })
    assert.equal(s2.uploadId, s1.uploadId, '同 path+size 复用同一会话')
    m.abortChunkedUpload(d, s1.uploadId)
  })

  it('顺序追加分片：received 累计；offset 不匹配 → OFFSET_MISMATCH 且回传服务端 received', async () => {
    const d = await rootDir()
    const s = m.initChunkedUpload(d, { path: 'chunk/seq.bin', size: big.length })
    const r1 = m.appendUploadChunk(d, s.uploadId, 0, big.subarray(0, 4096))
    assert.equal(r1.received, 4096)
    const r2 = m.appendUploadChunk(d, s.uploadId, 4096, big.subarray(4096, 8192))
    assert.equal(r2.received, 8192)
    // 乱序/重复片：必须拒绝并告知真实进度（顺序语义）
    let mismatch = null
    assert.throws(() => m.appendUploadChunk(d, s.uploadId, 0, big.subarray(0, 10)), (e) => { mismatch = e; return e.code === 'OFFSET_MISMATCH' })
    assert.equal(mismatch.received, 8192, '错误里带服务端真实 received，前端据此校正而非从头再传')
    assert.equal(m.abortChunkedUpload(d, s.uploadId).aborted, true)
  })

  it('分片超出声明大小 → 拒；未收齐 complete → INCOMPLETE 且**会话保留**；收齐 → 字节一致且会话清理', async () => {
    const d = await rootDir()
    const s = m.initChunkedUpload(d, { path: 'chunk/full.bin', size: big.length })
    assert.throws(() => m.appendUploadChunk(d, s.uploadId, 0, Buffer.alloc(big.length + 1)), /超出声明大小/)
    m.appendUploadChunk(d, s.uploadId, 0, big.subarray(0, 20000))
    let inc = null
    assert.throws(() => m.completeChunkedUpload(d, s.uploadId), (e) => { inc = e; return e.code === 'INCOMPLETE' })
    assert.equal(inc.received, 20000, '未收齐时回传已收字节')
    assert.equal(existsSync(join(root, 'chunk', 'full.bin')), false, '未收齐时目标文件不存在（不留半写文件）')
    // 断点续传：重新 init 拿到同一会话与 received=20000，从该处续发余下字节
    const resumed = m.initChunkedUpload(d, { path: 'chunk/full.bin', size: big.length })
    assert.equal(resumed.uploadId, s.uploadId)
    assert.equal(resumed.received, 20000, '断点续传：已收字节从磁盘会话恢复（不依赖内存表）')
    assert.equal(resumed.resumed, true)
    m.appendUploadChunk(d, resumed.uploadId, resumed.received, big.subarray(20000))
    const done = m.completeChunkedUpload(d, resumed.uploadId)
    assert.equal(done.skipped, false)
    assert.equal(done.name, 'full.bin')
    assert.equal(done.size, big.length)
    assert.deepEqual(readFileSync(join(root, 'chunk', 'full.bin')), big, '分片拼接结果与原始字节完全一致')
    const sessDir = join(root, '.dsh-uploads')
    const leftovers = existsSync(sessDir) ? readdirSync(sessDir).filter(f => f.includes(resumed.uploadId)) : []
    assert.deepEqual(leftovers, [], '完成后零会话残留')
  })

  it('abort：丢弃会话与分片（幂等）；abort 后原 uploadId 不可再用', async () => {
    const d = await rootDir()
    const s = m.initChunkedUpload(d, { path: 'chunk/abort.bin', size: 1000 })
    m.appendUploadChunk(d, s.uploadId, 0, Buffer.alloc(500))
    assert.equal(m.abortChunkedUpload(d, s.uploadId).aborted, true)
    assert.equal(existsSync(join(root, 'chunk', 'abort.bin')), false)
    assert.throws(() => m.completeChunkedUpload(d, s.uploadId), /不存在或已过期/)
    assert.equal(m.abortChunkedUpload(d, s.uploadId).aborted, false, 'abort 幂等（重复中止不报错）')
  })

  it('uploadId 白名单校验：路径穿越/畸形 id 一律拒绝（绝不拼进路径）', async () => {
    const d = await rootDir()
    for (const bad of ['../../evil', 'u_../x', 'u_ZZZ', '', 'u_' + 'a'.repeat(200), 'uuid-1234']) {
      assert.throws(() => m.appendUploadChunk(d, bad, 0, Buffer.from('x')), /uploadId 非法/)
      assert.throws(() => m.abortChunkedUpload(d, bad), /uploadId 非法/)
    }
    assert.equal(existsSync(join(tmpRoot, 'evil')), false, '根外零副作用')
  })

  it('skip 策略 + 目标已存在 → init 直接 skipped（不建会话）；rename → complete 后落到改名目标', async () => {
    const d = await rootDir()
    const skip = m.initChunkedUpload(d, { path: 'conflict.txt', size: 10, strategy: 'skip' })
    assert.equal(skip.skipped, true)
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), 'V3', 'skip 未动原文件')
    const rn = m.initChunkedUpload(d, { path: 'conflict.txt', size: 4, strategy: 'rename' })
    m.appendUploadChunk(d, rn.uploadId, 0, Buffer.from('NEW4'))
    const done = m.completeChunkedUpload(d, rn.uploadId)
    assert.equal(done.name, 'conflict-3.txt', 'rename 策略在分片发布时同样生效')
    assert.equal(readFileSync(join(root, 'conflict-3.txt'), 'utf8'), 'NEW4')
    assert.equal(readFileSync(join(root, 'conflict.txt'), 'utf8'), 'V3')
  })

  it('会话目录是内部状态：不进列表、不被搜索命中、显式访问被拒', async () => {
    const d = await rootDir()
    const s = m.initChunkedUpload(d, { path: 'chunk/hidden.bin', size: 5000 })
    assert.equal(existsSync(join(root, '.dsh-uploads')), true, '会话目录确实已创建')
    const list = m.listDirEntries(d, '')
    assert.ok(!list.entries.some(e => e.name === '.dsh-uploads'), '.dsh-uploads 不出现在文件列表')
    const found = m.searchFiles(d, '', 'dsh-uploads', { recursive: true })
    assert.deepEqual(found.results, [], '搜索也不会命中会话目录')
    assert.throws(() => m.listDirEntries(d, '.dsh-uploads'), /上传会话内部目录/, '显式访问被拒（保护断点续传不被列表操作破坏）')
    assert.throws(() => m.removePath(d, '.dsh-uploads', 'yes'), /上传会话内部目录/, '批量/单删也无法删除会话目录')
    m.abortChunkedUpload(d, s.uploadId)
  })

  it('参数校验：缺 size/path、非法 size、超总上限、越界、父目录不存在 → 明确 400 语义错误', async () => {
    const d = await rootDir()
    assert.throws(() => m.initChunkedUpload(d, { path: 'chunk/x.bin' }), /缺少参数 size/)
    assert.throws(() => m.initChunkedUpload(d, { size: 10 }), /缺少参数 path/)
    assert.throws(() => m.initChunkedUpload(d, { path: 'chunk/x.bin', size: 1.5 }), /缺少参数 size/)
    assert.throws(() => m.initChunkedUpload(d, { path: 'chunk/x.bin', size: -1 }), /缺少参数 size/)
    assert.throws(() => m.initChunkedUpload(d, { path: 'chunk/x.bin', size: m.UPLOAD_MAX_SIZE + 1 }), /超过分片上传上限/)
    assert.throws(() => m.initChunkedUpload(d, { path: '../escape.bin', size: 10 }), /越界|相对路径/)
    assert.throws(() => m.initChunkedUpload(d, { path: 'ghost-dir/x.bin', size: 10 }), /目标目录不存在/)
  })
})

describe('P2-7 ②分片上传：HTTP 路由层端到端（真路由 + 断点续传）', () => {
  const bin = { 'Content-Type': 'application/octet-stream' }
  const payload = Buffer.from('HTTP-CHUNKED-PAYLOAD-'.repeat(200)) // ~4.2KB

  it('init → chunk×N → complete：文件落盘且字节一致；list 立即可见', async () => {
    const init = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/init', { body: { scope: 'fx', path: 'http-chunk/payload.bin', size: payload.length } })
    assert.equal(init.status, 200)
    assert.equal(init.json.received, 0)
    assert.equal(init.json.resumed, false)
    assert.equal(init.json.chunkSize, 1024, '夹具经 DSH_WORKBENCH_CHUNK_SIZE=1024 注入分片建议大小')
    const uploadId = init.json.uploadId
    const chunk = init.json.chunkSize
    let offset = 0
    while (offset < payload.length) {
      const slice = payload.subarray(offset, Math.min(offset + chunk, payload.length))
      const r = await httpJson(httpBases.chunk, 'PUT', '/api/files/upload/chunk', { query: '?scope=fx&uploadId=' + uploadId + '&offset=' + offset, body: slice, raw: true, headers: bin })
      assert.equal(r.status, 200, 'chunk 片上传成功（offset=' + offset + '）')
      assert.equal(r.json.received, offset + slice.length)
      offset += slice.length
    }
    const done = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/complete', { body: { scope: 'fx', uploadId } })
    assert.equal(done.status, 200)
    assert.equal(done.json.name, 'payload.bin')
    assert.equal(done.json.size, payload.length)
    assert.deepEqual(readFileSync(join(root, 'http-chunk', 'payload.bin')), payload, '分片上传后字节完全一致')
    const list = await httpJson(httpBases.chunk, 'GET', '/api/files/list', { query: '?scope=fx&path=' + encQ('http-chunk') })
    assert.ok(list.json.entries.some(e => e.name === 'payload.bin'), 'list 立即可见')
    assert.ok(!list.json.entries.some(e => e.name === '.dsh-uploads'), '会话目录不出现在文件中心列表')
  })

  it('offset 不匹配 → 409 且回传 received（前端据此续传，而不是从头再传）', async () => {
    const first = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/init', { body: { scope: 'fx', path: 'http-chunk/resume.bin', size: 2000 } })
    const uploadId = first.json.uploadId
    await httpJson(httpBases.chunk, 'PUT', '/api/files/upload/chunk', { query: '?scope=fx&uploadId=' + uploadId + '&offset=0', body: Buffer.alloc(1000, 1), raw: true, headers: bin })
    const bad = await httpJson(httpBases.chunk, 'PUT', '/api/files/upload/chunk', { query: '?scope=fx&uploadId=' + uploadId + '&offset=0', body: Buffer.alloc(1000, 2), raw: true, headers: bin })
    assert.equal(bad.status, 409)
    assert.equal(bad.json.received, 1000, '409 响应带服务端真实进度')
    const ok = await httpJson(httpBases.chunk, 'PUT', '/api/files/upload/chunk', { query: '?scope=fx&uploadId=' + uploadId + '&offset=1000', body: Buffer.alloc(1000, 3), raw: true, headers: bin })
    assert.equal(ok.status, 200)
    const done = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/complete', { body: { scope: 'fx', uploadId } })
    assert.equal(done.status, 200)
    const bytes = readFileSync(join(root, 'http-chunk', 'resume.bin'))
    assert.equal(bytes.length, 2000)
    assert.deepEqual([...bytes.subarray(0, 3)], [1, 1, 1])
    assert.deepEqual([...bytes.subarray(1997)], [3, 3, 3], '前半为首次分片、后半为续传分片')
  })

  it('未收齐 complete → 400 + received（会话保留）；分片体超过分片上限 → 400；abort → 200', async () => {
    const init = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/init', { body: { scope: 'fx', path: 'http-chunk/partial.bin', size: 5000 } })
    const uploadId = init.json.uploadId
    const inc = await httpJson(httpBases.chunk, 'POST', '/api/files/upload/complete', { body: { scope: 'fx', uploadId } })
    assert.equal(inc.status, 400)
    assert.equal(inc.json.received, 0)
    // 分片体上限 = chunkSize + 1024（夹具 chunkSize=1024 → 2048）
    const tooBig = await httpJson(httpBases.chunk, 'PUT', '/api/files/upload/chunk', { query: '?scope=fx&uploadId=' + uploadId + '&offset=0', body: Buffer.alloc(4096), raw: true, headers: bin })
    assert.equal(tooBig.status, 400)
    assert.match(tooBig.json.error, /分片超过上限|超过上限/)
    const ab = await httpJson(httpBases.chunk, 'DELETE', '/api/files/upload/abort', { query: '?scope=fx&uploadId=' + uploadId })
    assert.equal(ab.status, 200)
    assert.equal(ab.json.aborted, true)
  })

  it('分片端点受写 token 门禁保护（未带/错 token → 401；带 Bearer token → 放行）', async () => {
    const body = { scope: 'fx', path: 'http-chunk/tok.bin', size: 100 }
    const noTok = await httpJson(httpBases.token, 'POST', '/api/files/upload/init', { body })
    assert.equal(noTok.status, 401, 'init 属于写面，必须要求 token')
    const wrong = await httpJson(httpBases.token, 'POST', '/api/files/upload/init', { body, headers: { Authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401, 'token 不匹配 → 401')
    const ok = await httpJson(httpBases.token, 'POST', '/api/files/upload/init', { body, headers: { Authorization: 'Bearer tk' } })
    assert.equal(ok.status, 200, '带正确 Bearer token → 放行')
    const ab = await httpJson(httpBases.token, 'DELETE', '/api/files/upload/abort', { query: '?scope=fx&uploadId=' + ok.json.uploadId, headers: { Authorization: 'Bearer tk' } })
    assert.equal(ab.status, 200, 'abort 亦受 token 保护且可通过')
  })
})

// ───────────────────────── ③ 文件名搜索与批量操作 ─────────────────────────
describe('P2-7 ③文件名搜索（函数级）', () => {
  it('大小写不敏感子串匹配；默认只查当前目录，recursive=true 递归子目录', async () => {
    const d = await rootDir()
    const shallow = m.searchFiles(d, 'docs', 'guide')
    assert.deepEqual(shallow.results.map(r => r.path).sort(), ['docs/Guide-2.md', 'docs/guide.txt'], '默认不递归（只查 docs 直属子项）')
    const deep = m.searchFiles(d, 'docs', 'guide', { recursive: true })
    assert.ok(deep.results.some(r => r.path === 'docs/deep/nested-guide.txt'), 'recursive 命中子目录文件')
    assert.equal(deep.results.find(r => r.name === 'nested-guide.txt').type, 'file')
  })

  it('隐藏条目与 .git 不进结果；结果含 size/mtime；缺 q / 越界 path / 不存在目录 → 400 语义错误', async () => {
    const d = await rootDir()
    const all = m.searchFiles(d, '', 'e', { recursive: true })
    assert.ok(!all.results.some(r => r.path.split('/').some(seg => seg.startsWith('.'))), '隐藏路径段不出现')
    assert.ok(all.results.every(r => typeof r.size === 'number' && r.mtime !== undefined), '每条含 size/mtime')
    assert.throws(() => m.searchFiles(d, '', '   '), /缺少参数 q/)
    assert.throws(() => m.searchFiles(d, '../..', 'x'), /越界|相对路径/)
    assert.throws(() => m.searchFiles(d, 'ghost', 'x'), /不存在|不是目录/)
  })

  it('结果上限：maxResults 触顶后 truncated=true（不静默丢结果）', async () => {
    const d = await rootDir()
    const cut = m.searchFiles(d, '', 'e', { recursive: true, maxResults: 2 })
    assert.equal(cut.results.length, 2)
    assert.equal(cut.truncated, true, '触顶必须显式标注 truncated')
    const full = m.searchFiles(d, '', 'e', { recursive: true, maxResults: 500 })
    assert.equal(full.truncated, false)
    assert.ok(full.results.length >= 2)
  })
})

describe('P2-7 ③批量操作（函数级）', () => {
  it('批量删除：逐项报告成败——存在的删除、不存在的记失败，不因单项失败整体回滚', async () => {
    const d = await rootDir()
    writeFileSync(join(root, 'batch-1.txt'), '1')
    writeFileSync(join(root, 'batch-2.txt'), '2')
    const out = m.batchFileOp(d, { action: 'delete', paths: ['batch-1.txt', 'ghost.txt', 'batch-2.txt'], confirm: 'yes' })
    assert.equal(out.ok, 2)
    assert.equal(out.failed, 1)
    assert.equal(existsSync(join(root, 'batch-1.txt')), false)
    assert.equal(existsSync(join(root, 'batch-2.txt')), false)
    const ghost = out.items.find(i => i.path === 'ghost.txt')
    assert.equal(ghost.ok, false)
    assert.match(ghost.error, /不存在/)
  })

  it('批量删除必须带 confirm=yes；批量移动按 toDir 归位，目标同名冲突 → 该项失败且不覆盖', async () => {
    const d = await rootDir()
    assert.throws(() => m.batchFileOp(d, { action: 'delete', paths: ['README.md'] }), /二次确认/)
    writeFileSync(join(root, 'mv-a.txt'), 'a')
    writeFileSync(join(root, 'mv-b.txt'), 'b')
    writeFileSync(join(root, 'dest', 'mv-b.txt'), 'occupied')
    const out = m.batchFileOp(d, { action: 'move', paths: ['mv-a.txt', 'mv-b.txt', '../escape.txt'], toDir: 'dest' })
    assert.equal(out.ok, 1)
    assert.equal(out.failed, 2)
    assert.equal(readFileSync(join(root, 'dest', 'mv-a.txt'), 'utf8'), 'a', '成功项已归位')
    assert.equal(out.items.find(i => i.path === 'mv-b.txt').ok, false, '目标同名 → 该项失败')
    assert.equal(readFileSync(join(root, 'dest', 'mv-b.txt'), 'utf8'), 'occupied', '冲突项未覆盖既有文件')
    assert.match(out.items.find(i => i.path === '../escape.txt').error, /越界|相对路径/)
  })

  it('参数校验：action 非法 / paths 空或超 200 / 非字符串项 / move 缺 toDir 或目标目录不存在 → 400', async () => {
    const d = await rootDir()
    assert.throws(() => m.batchFileOp(d, { action: 'chmod', paths: ['README.md'] }), /缺少参数 action/)
    assert.throws(() => m.batchFileOp(d, { action: 'delete', paths: [], confirm: 'yes' }), /缺少参数 paths/)
    assert.throws(() => m.batchFileOp(d, { action: 'delete', paths: ['README.md', 42], confirm: 'yes' }), /相对路径字符串数组/)
    assert.throws(() => m.batchFileOp(d, { action: 'delete', paths: Array.from({ length: 201 }, (_, i) => 'f' + i), confirm: 'yes' }), /上限 200/)
    assert.throws(() => m.batchFileOp(d, { action: 'move', paths: ['README.md'] }), /缺少参数 toDir/)
    assert.throws(() => m.batchFileOp(d, { action: 'move', paths: ['README.md'], toDir: 'ghost-dir' }), /不存在/)
  })
})

describe('P2-7 ③搜索与批量：HTTP 路由层（真路由）', () => {
  it('GET /api/files/search（含 recursive）与 POST /api/files/batch 可用；缺 q / 缺 confirm → 400', async () => {
    const s = await httpJson(httpBases.plain, 'GET', '/api/files/search', { query: '?scope=fx&path=docs&q=guide&recursive=1' })
    assert.equal(s.status, 200)
    assert.ok(s.json.results.some(r => r.path === 'docs/deep/nested-guide.txt'))
    const noQ = await httpJson(httpBases.plain, 'GET', '/api/files/search', { query: '?scope=fx&q=' })
    assert.equal(noQ.status, 400)
    writeFileSync(join(root, 'http-batch-1.txt'), 'x')
    const b = await httpJson(httpBases.plain, 'POST', '/api/files/batch', { body: { scope: 'fx', action: 'delete', confirm: 'yes', paths: ['http-batch-1.txt', 'ghost-x.txt'] } })
    assert.equal(b.status, 200)
    assert.equal(b.json.ok, 1)
    assert.equal(b.json.failed, 1)
    const noConfirm = await httpJson(httpBases.plain, 'POST', '/api/files/batch', { body: { scope: 'fx', action: 'delete', paths: ['README.md'] } })
    assert.equal(noConfirm.status, 400)
    assert.equal(existsSync(join(root, 'README.md')), true, '缺少 confirm 时未删除任何文件')
  })
})

// ───────────────────────── ④ git 只读状态与差异 ─────────────────────────
describe('P2-7 ④git 状态与差异（只读；绝不写仓库）', () => {
  const porcelain = (dir) => git(dir, ['status', '--porcelain=v1', '-z'])

  it('非 git 仓库 → isRepo:false（不抛错，前端据此隐藏 git 面板）', async () => {
    const d = await rootDir()
    assert.equal(m.gitStatus(d, '').isRepo, false)
    assert.equal(m.gitDiff(d, 'README.md').isRepo, false)
    assert.equal(m.gitLog(d, '').isRepo, false)
  })

  it('gitStatus：分支名 + 逐文件标记（M 修改 / ?? 未跟踪 / R 改名）+ 汇总计数；暂存与工作区状态分开', async () => {
    const st = m.gitStatus(gitRepo, '')
    assert.equal(st.isRepo, true)
    assert.equal(st.branch, 'main')
    assert.equal(st.repoRoot.replace(/\\/g, '/').toLowerCase(), gitRepo.replace(/\\/g, '/').toLowerCase())
    const byPath = Object.fromEntries(st.files.map(f => [f.path, f]))
    assert.equal(byPath['tracked.txt'].code, 'M', '工作区修改 → M')
    assert.equal(byPath['tracked.txt'].staged, false, 'M 是工作区改动（未暂存）')
    assert.equal(byPath['untracked.txt'].code, '??')
    assert.equal(byPath['untracked.txt'].untracked, true)
    assert.equal(byPath['renamed-dst.txt'].code, 'R', '暂存改名 → R')
    assert.equal(byPath['renamed-dst.txt'].from, 'renamed-src.txt', 'R 项带原路径（porcelain -z 解析正确）')
    assert.equal(byPath['renamed-dst.txt'].staged, true)
    assert.equal(byPath['blob.bin'].code, 'M', '二进制文件的改动同样有标记')
    assert.equal(st.summary.untracked, 1)
    assert.ok(st.summary.staged >= 1, '改名计入暂存侧')
    assert.ok(st.total >= 4)
  })

  it('gitDiff（传**文件路径**也须工作）：含 -旧/+新；staged 语义不同；未跟踪与已删除文件显式说明', async () => {
    const d = m.gitDiff(gitRepo, 'tracked.txt')
    assert.equal(d.isRepo, true, 'git -C 必须用所在目录探测（曾因传文件路径把仓库误判为非仓库）')
    assert.match(d.diff, /^-line2$/m, 'diff 含被删行')
    assert.match(d.diff, /^\+CHANGED$/m, 'diff 含新增行')
    assert.equal(d.binary, false)
    const staged = m.gitDiff(gitRepo, 'tracked.txt', { staged: true })
    assert.equal(staged.diff.trim(), '', '工作区改动未暂存 → --cached diff 为空')
    assert.match(staged.note, /无差异/)
    const untracked = m.gitDiff(gitRepo, 'untracked.txt')
    assert.equal(untracked.diff.trim(), '', '未跟踪文件无 diff')
    assert.match(untracked.note, /无差异|未跟踪/)
    const ghost = m.gitDiff(gitRepo, 'no-such-file.txt')
    assert.equal(ghost.isRepo, true, '文件不存在仍能给出仓库上下文（不是 400）')
    assert.equal(ghost.diff, '')
    assert.match(ghost.note, /不存在/)
  })

  it('gitDiff：二进制与超长 diff 都显式标注（不静默丢内容）', async () => {
    const bin = m.gitDiff(gitRepo, 'blob.bin')
    assert.equal(bin.binary, true, 'git 判定二进制 → binary:true')
    const cut = m.gitDiff(gitRepo, 'tracked.txt', { maxBytes: 20 })
    assert.equal(cut.truncated, true)
    assert.match(cut.note, /截断/)
    assert.ok(cut.diff.length > 0 && Buffer.byteLength(cut.diff) <= 40)
  })

  it('gitLog：返回提交（hash/short/作者/时间/标题）；limit 生效', async () => {
    const lg = m.gitLog(gitRepo, '', 5)
    assert.equal(lg.isRepo, true)
    assert.ok(lg.commits.length >= 1)
    assert.equal(lg.commits[0].subject, 'P2-7 fixture 初始提交')
    assert.match(lg.commits[0].hash, /^[0-9a-f]{40}$/)
    assert.equal(lg.commits[0].short.length, 8)
    assert.equal(lg.commits[0].author, 'P27')
    assert.match(lg.commits[0].date, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(m.gitLog(gitRepo, '', 1).commits.length, 1, 'limit 生效')
  })

  it('**只读保证**：调用三个 git 端点前后 porcelain 输出逐字节一致，且无 index.lock 残留', async () => {
    const before = porcelain(gitRepo)
    m.gitStatus(gitRepo, '')
    m.gitDiff(gitRepo, 'tracked.txt')
    m.gitDiff(gitRepo, 'tracked.txt', { staged: true })
    m.gitLog(gitRepo, '', 3)
    assert.equal(porcelain(gitRepo), before, 'git 只读端点不得改变仓库状态')
    assert.equal(existsSync(join(gitRepo, '.git', 'index.lock')), false, '无 index.lock 残留')
  })

  it('parsePorcelainZ：M/??/R/U 与暂存/工作区二维标记解析正确（含冲突形状）', async () => {
    const parsed = m.parsePorcelainZ(' M a.txt\0?? b.txt\0R  d.txt\0c.txt\0UU e.txt\0')
    const by = Object.fromEntries(parsed.map(p => [p.path, p]))
    assert.equal(by['a.txt'].code, 'M')
    assert.equal(by['a.txt'].staged, false)
    assert.equal(by['b.txt'].untracked, true)
    assert.equal(by['d.txt'].from, 'c.txt')
    assert.equal(by['e.txt'].conflicted, true, 'UU → 冲突标记')
    assert.equal(by['e.txt'].code, 'U')
  })

  it('git 端点同样禁止 .git 内部路径（复用 R-A1 防护）', async () => {
    assert.throws(() => m.gitStatus(gitRepo, '.git'), /\.git/)
    assert.throws(() => m.gitDiff(gitRepo, '.git/config'), /\.git/)
  })
})

describe('P2-7 ④git：HTTP 路由层（真路由）', () => {
  it('GET git/status、git/diff、git/log 可用；非仓库 scope → isRepo:false；.git 内部 → 400/403', async () => {
    const st = await httpJson(httpBases.plain, 'GET', '/api/files/git/status', { query: '?scope=gx&path=' })
    assert.equal(st.status, 200)
    assert.equal(st.json.isRepo, true)
    assert.equal(st.json.branch, 'main')
    const df = await httpJson(httpBases.plain, 'GET', '/api/files/git/diff', { query: '?scope=gx&path=' + encQ('tracked.txt') })
    assert.equal(df.status, 200)
    assert.match(df.json.diff, /\+CHANGED/)
    const lg = await httpJson(httpBases.plain, 'GET', '/api/files/git/log', { query: '?scope=gx&limit=2' })
    assert.equal(lg.status, 200)
    assert.ok(lg.json.commits.length >= 1)
    const fx = await httpJson(httpBases.plain, 'GET', '/api/files/git/status', { query: '?scope=fx&path=' })
    assert.equal(fx.json.isRepo, false, '非仓库 scope 返回 isRepo:false 而非 500')
    const bad = await httpJson(httpBases.plain, 'GET', '/api/files/git/diff', { query: '?scope=gx&path=' + encQ('.git/config') })
    assert.ok([400, 403].includes(bad.status), '.git 内部路径被拒（实际 ' + bad.status + '）')
  })
})
