/**
 * Legion Workbench 独立静态服务器（生产构建后使用）。
 * 用法：pnpm build && node scripts/serve.mjs [--port 5173] [--host 127.0.0.1]
 * SPA 回退：未知路径返回 index.html，方便深链。
 *
 * 附加 API（同源，仅回环地址可访问）：
 *   ① 选文件夹/git 探测（/api/fs/*，照搬 DSH 工作空间目录浏览）：
 *      GET  /api/fs/home → { home, drives }；GET /api/fs/list?path= → 目录层级；POST /api/fs/inspect → git 探测
 *   ② 文件中心（/api/files/*，目录根 = 当前工作空间 spaces.local_dir；读写全部做根内规范化 + 符号链接逃逸防护；
 *      写操作需 token（--token 或 DSH_WORKBENCH_TOKEN，未配置放行）+ 仅回环；覆盖需 overwrite=1、删除需 confirm=yes）：
 *      GET  /api/files/list?scope=&path=                 → 目录条目（dir 在前，含 .git 仓库标记）
 *      GET  /api/files/read?scope=&path=                 → 文本预览（截断/行数/二进制拒绝）
 *      GET  /api/files/download?scope=&path=             → 原始字节下载
 *      PUT  /api/files/upload?scope=&path=&overwrite=1   → raw body 上传（Content-Length 预检 + 流式落盘）
 *      POST /api/files/mkdir|rename|delete               → 受限写操作（JSON body）
 *   ③ 浏览器助手（/api/web/fetch，S6：SSRF 防护的服务端 fetch 代理 + 零依赖正文抽取）：
 *      POST /api/web/fetch { url, maxBytes?, timeoutMs? } → { ok, finalUrl, status, contentType, title, text?, excerpt?, links?, error? }
 */
import { createServer, request } from 'node:http'
import { createReadStream, createWriteStream, existsSync, openSync, readSync, writeSync, closeSync, unlinkSync, rmdirSync, mkdirSync, readdirSync, renameSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, extname, join, normalize, dirname, sep, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1])
}
const port = Number(args.get('port') ?? process.env.DSH_WORKBENCH_PORT ?? 5173)
const host = args.get('host') ?? process.env.DSH_WORKBENCH_HOST ?? '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-sh; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

// ── 写鉴权与限值（S3/S4/S6；⚖️ 导出为常量，测试用「三值法」围绕断言，见 TEST_CASES §3）──
const writeToken = String(args.get('token') ?? process.env.DSH_WORKBENCH_TOKEN ?? '')
export const FILES_LIMITS = Object.freeze({
  MAX_READ: 256 * 1024, // 文本预览截断阈值（字节）
  MAX_UPLOAD: 64 * 1024 * 1024, // 单文件上传上限（字节），Content-Length 预检
})
export const WEB_LIMITS = Object.freeze({
  MAX_BYTES: 2 * 1024 * 1024, // fetch 响应体上限（可被请求覆盖）
  TIMEOUT_MS: 10_000, // 总超时（可被请求覆盖）
  MAX_REDIRECTS: 5,
  MAX_LINKS: 40, // 抽取链接数上限
  MAX_TEXT: 300_000, // 抽取正文/标题文本上限
})
// 二进制扩展名黑名单（预览拒绝；下载不受限）
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.sqlite', '.db', '.db-wal', '.jar', '.class', '.pyc'])

// ── /api/fs/* 辅助 ──
function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 绝对路径校验：Windows 盘符路径（D:/…）或 POSIX 根路径；拒绝 NUL。 */
function isValidAbs(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true
  return p.startsWith('/')
}

function driveRoots() {
  const out = []
  for (let c = 65; c <= 90; c += 1) {
    const letter = String.fromCharCode(c)
    try {
      if (existsSync(`${letter}:\\`)) out.push({ name: `${letter}:`, path: `${letter}:\\` })
    } catch { /* 不可访问的盘符跳过 */ }
  }
  return out
}

function listDirectory(p) {
  const path = normalize(p)
  if (!isValidAbs(path)) throw new Error('path 必须是绝对目录路径')
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`目录不存在：${path}`)
  const isRoot = dirname(path) === path
  const children = readdirSync(path, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(d => {
      const child = join(path, d.name)
      return { name: d.name, path: child, isRepo: existsSync(join(child, '.git')) }
    })
  return {
    path,
    isRoot,
    parent: isRoot ? null : dirname(path),
    entries: children,
    drives: isRoot ? driveRoots() : [],
  }
}

/** git 仓库探测：show-toplevel + 当前分支 + remotes（fetch）。非仓库返回 isRepo:false。 */
function inspectRepository(p) {
  const path = normalize(p)
  if (!isValidAbs(path)) throw new Error('path 必须是绝对目录路径')
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`目录不存在：${path}`)
  const run = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', windowsHide: true, timeout: 8000 }).toString()
  let root = null
  let branch = null
  const remotes = []
  try {
    root = run(['-C', path, 'rev-parse', '--show-toplevel']).trim() || null
  } catch { /* 非 git 仓库 */ }
  if (root) {
    try {
      const cur = run(['-C', path, 'branch', '--show-current']).trim()
      if (cur) branch = cur
    } catch { /* 分离头等无分支名场景忽略 */ }
    try {
      const lines = run(['-C', path, 'remote', '-v']).split('\n')
      const seen = new Set()
      for (const line of lines) {
        const m = /^(\S+)\t(\S+)\s+\(fetch\)\s*$/.exec(line)
        if (m && !seen.has(m[1])) {
          seen.add(m[1])
          remotes.push({ name: m[1], url: m[2] })
        }
      }
    } catch { /* 无 remote 忽略 */ }
  }
  return { isRepo: root !== null, root, branch, remotes }
}

// ───────────────────────── 文件中心（S3 只读面 + S4 写面）─────────────────────────
/**
 * 目录根解析：scope → 该工作空间在 team-hub spaces 表的 local_dir。
 * 测试注：设置 DSH_WORKBENCH_SPACES_JSON=<JSON 数组> 时走本地注入（免起中枢）；否则经
 * DSH_HUB_UPSTREAM（默认 http://127.0.0.1:8787）GET /api/spaces 实时解析。
 * 未绑定 → 抛出可理解错误（引导到空间设置），绝不静默落到仓库根以外的任意目录（TC-S3-03）。
 */
export async function resolveScopeLocalDir(scope) {
  if (typeof scope !== 'string' || scope.trim().length === 0) throw new Error('缺少参数 scope')
  const scopeId = scope.trim()
  let spaces = []
  const override = process.env.DSH_WORKBENCH_SPACES_JSON
  if (override) {
    try { spaces = JSON.parse(override) } catch { throw new Error('DSH_WORKBENCH_SPACES_JSON 不是合法 JSON') }
  } else {
    const up = process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787'
    const resp = await fetch(up.replace(/\/+$/, '') + '/api/spaces')
    if (!resp.ok) throw new Error('无法从 team-hub 读取工作空间列表（HTTP ' + resp.status + '），请先启动中枢 node team-hub/server.mjs')
    const data = await resp.json().catch(() => null)
    spaces = data?.spaces ?? []
  }
  const hit = spaces.find(s => s.id === scopeId)
  if (!hit) throw new Error('工作空间 ' + scopeId + ' 未注册：请先在空间设置创建该空间')
  const dir = typeof hit.localDir === 'string' ? hit.localDir.trim() : ''
  if (!dir) throw new Error('该空间尚未绑定本地文件夹：请先在空间设置中选择本地文件夹（local_dir）')
  if (!existsSync(dir)) throw new Error('空间绑定的本地文件夹不存在：' + dir)
  return realpathSync(dir)
}

/** .git 内部（含 .git 下任意层级）一律拒绝访问（TC-S3-12：防凭证/元数据外泄）。 */
function assertNotGitInternal(rel) {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts[0] === '.git') throw new Error('禁止访问 .git 内部（防凭证/元数据外泄）')
}

/**
 * 根内路径解析（读路径）：相对路径逐段校验 + 词法越界拦截 + realpath 符号链接/挂载点逃逸拦截。
 * rel='' / '.' → 根目录本身。任何等价逃逸（../、绝对路径、盘符、NUL、根外 symlink 目标）都拒绝。
 */
export function resolveInsideRoot(root, rel) {
  if (typeof rel !== 'string') throw new Error('缺少参数 path')
  if (rel.includes('\0')) throw new Error('path 含非法字符（NUL）')
  const relClean = rel.replace(/\\/g, '/')
  if (relClean.startsWith('/')) throw new Error('path 必须是相对路径（不能越出目录根）')
  if (/^[a-zA-Z]:/.test(relClean)) throw new Error('path 必须是相对路径（不能越出目录根）')
  if (relClean.split('/').includes('..')) throw new Error('路径越界：禁止访问目录根之外')
  if (!existsSync(root)) throw new Error('目录根不存在：' + root)
  const rRoot = realpathSync(root)
  const segs = relClean.split('/').filter(s => s.length > 0 && s !== '.')
  const abs = segs.length === 0 ? rRoot : join(rRoot, ...segs)
  if (abs !== rRoot && !abs.startsWith(rRoot + sep)) throw new Error('路径越界：禁止访问目录根之外')
  let real
  try { real = realpathSync(abs) } catch (e) { throw new Error(e?.code === 'ENOENT' ? '路径不存在' : '路径不可解析（可能是断链）') }
  if (real !== rRoot && !real.startsWith(rRoot + sep)) throw new Error('路径越界：符号链接指向目录根之外')
  return abs
}

/** 写路径解析：同根内规范化，但允许目标本身尚不存在（mkdir/upload 用）；已存在祖先同样做逃逸校验。 */
export function resolveInsideRootForWrite(root, rel) {
  if (typeof rel !== 'string') throw new Error('缺少参数 path')
  if (rel.includes('\0')) throw new Error('path 含非法字符（NUL）')
  const relClean = rel.replace(/\\/g, '/')
  if (relClean.startsWith('/')) throw new Error('path 必须是相对路径（不能越出目录根）')
  if (/^[a-zA-Z]:/.test(relClean)) throw new Error('path 必须是相对路径（不能越出目录根）')
  if (relClean.split('/').includes('..')) throw new Error('路径越界：禁止访问目录根之外')
  if (!existsSync(root)) throw new Error('目录根不存在：' + root)
  const rRoot = realpathSync(root)
  const segs = relClean.split('/').filter(s => s.length > 0 && s !== '.')
  if (segs.length === 0) throw new Error('path 不能指向目录根本身')
  const abs = join(rRoot, ...segs)
  if (!abs.startsWith(rRoot + sep)) throw new Error('路径越界：禁止访问目录根之外')
  // 从最深处往回找第一个存在的祖先，校验其真实路径仍在根内（防 symlink 祖先逃逸）
  let probe = abs
  for (;;) {
    try {
      const real = realpathSync(probe)
      if (real !== rRoot && !real.startsWith(rRoot + sep)) throw new Error('路径越界：符号链接指向目录根之外')
      break
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
        const parent = dirname(probe)
        if (parent === probe || parent === rRoot) break
        probe = parent
      } else throw e
    }
  }
  return abs
}

function entryMtime(ms) {
  try { return new Date(ms).toISOString() } catch { return null }
}

/** 目录列表（TC-S3-01/02/14）：目录在前、按名排序；隐藏条目（含 .git）不进列表，.git 以 isRepo 标记呈现。 */
export function listDirEntries(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRoot(root, rel)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error('路径不是目录或不存在')
  const rows = readdirSync(abs, { withFileTypes: true }).filter(d => !d.name.startsWith('.') && d.name !== '.git')
  const entries = rows.map(d => {
    const full = join(abs, d.name)
    let size = 0
    let mtime = null
    let isRepo = false
    const isDir = d.isDirectory()
    try {
      const st = statSync(full)
      size = st.size
      mtime = entryMtime(st.mtimeMs)
      if (isDir) isRepo = existsSync(join(full, '.git'))
    } catch { /* 断链/权限 → 空值 */ }
    return { name: d.name, type: isDir ? 'dir' : 'file', size, mtime, isRepo, ext: isDir ? '' : extname(d.name).toLowerCase().replace('.', '') }
  })
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  return { root, path: String(rel ?? ''), entries }
}

/**
 * 文本预览（TC-S3-05/06/07）：二进制（扩展名黑名单或内容含 NUL）→ 明确「不可预览」；
 * 超过 MAX_READ → truncated=true + 行数/总长标注；文件不存在/目录 → 400 语义错误。
 */
export function previewTextFile(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRoot(root, rel)
  const st = statSync(abs)
  if (st.isDirectory()) throw new Error('路径是目录，不能预览')
  const ext = extname(abs).toLowerCase()
  const readLen = Math.min(st.size, FILES_LIMITS.MAX_READ + 1)
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(Math.max(readLen, 1))
    const got = readSync(fd, buf, 0, readLen, 0)
    const head = buf.subarray(0, got)
    if (BINARY_EXT.has(ext) || head.includes(0)) {
      return { name: basename(abs), ext, binary: true, totalBytes: st.size, message: '二进制文件不可预览' }
    }
    const full = head.toString('utf8')
    const content = full.length > FILES_LIMITS.MAX_READ ? full.slice(0, FILES_LIMITS.MAX_READ) : full
    const truncated = st.size > FILES_LIMITS.MAX_READ
    const newlines = content.split('\n').length - 1
    return { name: basename(abs), ext, binary: false, content, truncated, lineCount: newlines + (content.length > 0 && !content.endsWith('\n') ? 1 : 0), totalBytes: st.size }
  } finally {
    closeSync(fd)
  }
}

/** 读取原始字节（下载语义；测试用全量 Buffer，路由层用 createReadStream 流式返回）。 */
export function readFileBytes(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRoot(root, rel)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('路径不是文件')
  return { buffer: readFileSyncFull(abs), totalBytes: st.size, name: basename(abs) }
}

/** PUT 上传（TC-S4-01..04）：raw bytes；上限预检（Content-Length 在路由层）；overwrite=1 才允许覆盖。 */
export function uploadBytes(root, rel, data, { overwrite = false } = {}) {
  assertNotGitInternal(rel)
  if (!Buffer.isBuffer(data)) throw new Error('上传体必须是二进制字节')
  if (data.length > FILES_LIMITS.MAX_UPLOAD) throw new Error('上传超过上限 ' + FILES_LIMITS.MAX_UPLOAD + ' 字节')
  const abs = resolveInsideRootForWrite(root, rel)
  const parent = dirname(abs)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(rel ?? '')))
  if (existsSync(abs)) {
    if (!overwrite) throw new Error('目标已存在：如需覆盖请带 overwrite=1（409 语义）')
    if (statSync(abs).isDirectory()) throw new Error('目标已存在且为目录，不能以文件覆盖')
  }
  writeFileSyncSafe(abs, data)
  const st = statSync(abs)
  return { name: basename(abs), size: st.size, mtime: entryMtime(st.mtimeMs) }
}

/** 新建目录（TC-S4-05/06）：支持一次建多层；已存在/与文件同名 → 拒绝。 */
export function createDir(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRootForWrite(root, rel)
  if (existsSync(abs)) throw new Error('目录已存在')
  try { mkdirSync(abs, { recursive: true }) } catch (e) { throw new Error('创建目录失败：' + (e?.message ?? e)) }
  return { path: String(rel ?? ''), created: true }
}

/** 改名/移动（TC-S4-07/08）：from/to 均须在根内；目标已存在 → 409。 */
export function renamePath(root, from, to) {
  assertNotGitInternal(from)
  assertNotGitInternal(to)
  const fromAbs = resolveInsideRootForWrite(root, from)
  const toAbs = resolveInsideRootForWrite(root, to)
  if (!existsSync(fromAbs)) throw new Error('源路径不存在')
  if (existsSync(toAbs)) throw new Error('目标已存在，不能覆盖（409 语义）')
  const toParent = dirname(toAbs)
  if (!existsSync(toParent) || !statSync(toParent).isDirectory()) throw new Error('目标目录不存在')
  try { renameSync(fromAbs, toAbs) } catch (e) { throw new Error('改名失败：' + (e?.message ?? e)) }
  return { from: String(from ?? ''), to: String(to ?? '') }
}

/**
 * 删除（TC-S4-09..12）：confirm=yes 二次确认；非空目录拒绝（须先清空）；.git 内部拒绝。
 * 永不删除目录根本身（path='' 等已在 resolve 层拒绝）。
 */
export function removePath(root, rel, confirm) {
  assertNotGitInternal(rel)
  if (confirm !== 'yes') throw new Error('删除需要二次确认：请带 confirm=yes')
  const abs = resolveInsideRootForWrite(root, rel)
  if (!existsSync(abs)) throw new Error('路径不存在')
  const st = lstatSync(abs)
  if (st.isDirectory()) {
    const children = readdirSync(abs)
    if (children.length > 0) throw new Error('非空目录拒绝删除：请先清空目录内容')
    try { rmdirSync(abs) } catch (e) { throw new Error('删除目录失败：' + (e?.message ?? e)) }
  } else {
    try { unlinkSync(abs) } catch (e) { throw new Error('删除文件失败：' + (e?.message ?? e)) }
  }
  return { path: String(rel ?? ''), deleted: true }
}

function readFileSyncFull(abs) {
  const fd = openSync(abs, 'r')
  const st = statSync(abs)
  try {
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const got = readSync(fd, buf, off, st.size - off, off)
      if (got <= 0) break
      off += got
    }
    return buf.subarray(0, off)
  } finally { closeSync(fd) }
}

function writeFileSyncSafe(abs, data) {
  const fd = openSync(abs, 'w')
  try {
    let off = 0
    while (off < data.length) {
      const n = writeSync(fd, data, off)
      if (n <= 0) throw new Error('写入失败')
      off += n
    }
  } finally { closeSync(fd) }
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      try { resolve(raw.length === 0 ? {} : JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

async function handleFsApi(req, res, pathname, url) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: '目录浏览接口仅限本机（127.0.0.1）访问' })
    return
  }
  try {
    if (req.method === 'GET' && pathname === '/api/fs/home') {
      sendJson(res, 200, { home: homedir(), drives: driveRoots() })
      return
    }
    if (req.method === 'GET' && pathname === '/api/fs/list') {
      const p = url.searchParams.get('path')
      sendJson(res, 200, listDirectory(p && p.length > 0 ? p : homedir()))
      return
    }
    if (req.method === 'POST' && pathname === '/api/fs/inspect') {
      const body = await readBodyJson(req)
      if (typeof body.path !== 'string' || body.path.length === 0) throw new Error('缺少参数 path')
      sendJson(res, 200, inspectRepository(body.path))
      return
    }
    sendJson(res, 404, { error: `not found: ${pathname}` })
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
}

// ── /api/files/* 路由（S3 只读 + S4 写；仅回环；写需 token；错误码分类见各函数注释）──
function httpErr(res, code, message) {
  sendJson(res, code, { error: message })
}

/** 写鉴权：配置了 token（--token / DSH_WORKBENCH_TOKEN）时写请求必须带 Bearer。读请求放行（TC-S4-13）。 */
function requireWriteToken(req) {
  if (writeToken === '') return true
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (given !== writeToken) throw new Error('未授权：Bearer token 无效')
  return true
}

function classifyFilesError(e) {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('token 无效')) return 401
  if (msg.includes('越界') || msg.includes('.git') || msg.includes('仅限本机') || msg.includes('符号链接')) return 403
  if (msg.includes('overwrite=1') || msg.includes('目标已存在，不能覆盖') || msg.includes('目标已存在：如需覆盖')) return 409
  if (msg.includes('上传超过上限')) return 413
  return 400
}

async function handleFilesApi(req, res, pathname, url) {
  if (!isLoopback(req)) {
    httpErr(res, 403, '文件接口仅限本机（127.0.0.1）访问')
    return
  }
  try {
    const scopeQuery = url.searchParams.get('scope') ?? null
    const method = req.method
    const isWrite = pathname === '/api/files/upload' || pathname === '/api/files/mkdir' || pathname === '/api/files/rename' || pathname === '/api/files/delete'
    if (isWrite) requireWriteToken(req)
    // POST body 可带 scope（与 query 二选一，body 优先），POST 分支内再按 body scope 懒解析；GET/PUT 用 query scope
    const root = method === 'POST' ? null : await resolveScopeLocalDir(scopeQuery)

    if (method === 'GET' && pathname === '/api/files/list') {
      const rel = url.searchParams.get('path') ?? ''
      sendJson(res, 200, { ok: true, ...listDirEntries(root, rel) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/read') {
      const rel = url.searchParams.get('path') ?? ''
      sendJson(res, 200, { ok: true, ...previewTextFile(root, rel) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/download') {
      const rel = url.searchParams.get('path') ?? ''
      const { buffer, name } = readFileBytes(root, rel)
      const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
      const safeName = encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename*=UTF-8''${safeName}` })
      res.end(buffer)
      return
    }
    if (method === 'PUT' && pathname === '/api/files/upload') {
      const rel = url.searchParams.get('path') ?? ''
      const overwrite = url.searchParams.get('overwrite') === '1'
      const declared = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(declared) && declared > FILES_LIMITS.MAX_UPLOAD) {
        req.resume() // 排空请求体
        httpErr(res, 413, '上传超过上限 ' + FILES_LIMITS.MAX_UPLOAD + ' 字节')
        return
      }
      const abs = resolveInsideRootForWrite(root, rel)
      const parent = dirname(abs)
      if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(rel ?? '')))
      if (existsSync(abs)) {
        if (!overwrite) throw new Error('目标已存在：如需覆盖请带 overwrite=1（409 语义）')
        if (statSync(abs).isDirectory()) throw new Error('目标已存在且为目录，不能以文件覆盖')
      }
      const ws = createWriteStream(abs)
      let written = 0
      let oversized = false
      const p = new Promise((resolve, reject) => {
        ws.on('error', reject)
        ws.on('finish', () => resolve(undefined))
        req.on('data', (d) => {
          written += d.length
          if (written > FILES_LIMITS.MAX_UPLOAD) {
            oversized = true
            ws.destroy()
            try { unlinkSync(abs) } catch { /* 可能尚未创建 */ }
          } else if (!oversized) ws.write(d)
        })
        req.on('end', () => { if (!oversized) ws.end() })
        req.on('error', reject)
      })
      await p
      if (oversized) { httpErr(res, 413, '上传超过上限 ' + FILES_LIMITS.MAX_UPLOAD + ' 字节'); return }
      const st = statSync(abs)
      sendJson(res, 200, { ok: true, file: { name: basename(abs), size: st.size, mtime: entryMtime(st.mtimeMs) } })
      return
    }
    if (method === 'POST' && pathname === '/api/files/mkdir') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      const rel = body.path
      if (typeof rel !== 'string' || rel.trim().length === 0) throw new Error('缺少参数 path')
      sendJson(res, 200, { ok: true, ...createDir(await resolveScopeLocalDir(scope), rel) })
      return
    }
    if (method === 'POST' && pathname === '/api/files/rename') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      if (typeof body.from !== 'string' || body.from.length === 0) throw new Error('缺少参数 from')
      if (typeof body.to !== 'string' || body.to.length === 0) throw new Error('缺少参数 to')
      sendJson(res, 200, { ok: true, ...renamePath(await resolveScopeLocalDir(scope), body.from, body.to) })
      return
    }
    if (method === 'POST' && pathname === '/api/files/delete') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      if (typeof body.path !== 'string' || body.path.length === 0) throw new Error('缺少参数 path')
      sendJson(res, 200, { ok: true, ...removePath(await resolveScopeLocalDir(scope), body.path, body.confirm) })
      return
    }
    httpErr(res, 404, 'not found: ' + pathname)
  } catch (e) {
    httpErr(res, classifyFilesError(e), e instanceof Error ? e.message : String(e))
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  const pathname = decodeURIComponent(url.pathname)
  // 同源 /hub/* 反向代理 → team-hub v2（规避浏览器跨域/CORS/localStorage 导致的中枢探测失败）
  if (pathname === '/hub' || pathname.startsWith('/hub/')) {
    const qs = url.search
    const up = new URL((process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787') + pathname.slice(4) + qs)
    const proxyReq = request({
      hostname: up.hostname, port: up.port, path: up.pathname + up.search,
      method: req.method, headers: { ...req.headers, host: up.host },
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.pipe(res)
    })
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`hub proxy error: ${e.message}`)
    })
    req.pipe(proxyReq)
    return
  }
  // 文件中心 /api/files/*（S3 只读面 + S4 写面；仅回环 + 写 token；scope → 空间 local_dir 解析）
  if (pathname.startsWith('/api/files')) {
    void handleFilesApi(req, res, pathname, url)
    return
  }
  // 目录浏览 / git 探测（空间仓库绑定的「选择文件夹」）
  if (pathname.startsWith('/api/fs/')) {
    void handleFsApi(req, res, pathname, url)
    return
  }
  let file = normalize(join(ROOT, pathname))
  if (!file.startsWith(ROOT)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const index = join(file, 'index.html')
    if (existsSync(index)) file = index
    else file = join(ROOT, 'index.html') // SPA 回退
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  createReadStream(file).pipe(res)
})

// 被 import（契约测试）时不监听端口（isMain 守卫，同 team-hub/server.mjs 先例）。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  server.listen(port, host, () => {
    console.log(`legion-workbench 已启动：http://${host}:${port}（数据源默认 http://127.0.0.1:4820）`)
  })
}

export { isLoopback }
