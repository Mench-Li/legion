/**
 * Legion Workbench 独立静态服务器（生产构建后使用）。
 * 用法：pnpm build && node scripts/serve.mjs [--port 5173] [--host 127.0.0.1] [--token 写令牌]
 * SPA 回退：未知路径返回 index.html，方便深链。
 *
 * 附加 API（同源，仅回环地址可访问）：
 *   ① 选文件夹/git 探测（/api/fs/*，照搬 DSH 工作空间目录浏览）：
 *      GET  /api/fs/home → { home, drives }；GET /api/fs/list?path= → 目录层级；POST /api/fs/inspect → git 探测
 *   ② 文件中心（/api/files/*，目录根 = 当前工作空间 spaces.local_dir；读写全部做根内规范化 + 符号链接逃逸防护，
 *      R-A1：相对路径任一层段 .git 即拒 + realpath 复检（防嵌套仓库/符号链接绕入 .git 内部）；
 *      写操作需 token（--token 或 DSH_WORKBENCH_TOKEN，未配置放行）+ 仅回环；覆盖需 overwrite=1、删除需 confirm=yes）：
 *      GET  /api/files/list?scope=&path=                 → 目录条目（dir 在前，含 .git 仓库标记）
 *      GET  /api/files/read?scope=&path=                 → 文本预览（截断/行数/二进制拒绝）
 *      GET  /api/files/download?scope=&path=             → 原始字节下载
 *      PUT  /api/files/upload?scope=&path=&overwrite=1   → raw body 上传（Content-Length 预检 + 流式落盘临时文件，收体完整后原子改名发布——覆盖/中断/超限不破坏原文件，P0-1）
 *      POST /api/files/mkdir|rename|delete               → 受限写操作（JSON body）
 *   ③ 浏览器助手（/api/web/fetch，S6：SSRF 防护的服务端 fetch 代理 + 零依赖正文抽取）：
 *      POST /api/web/fetch { url, maxBytes?, timeoutMs? } → { ok, finalUrl, status, contentType, title, text?, excerpt?, links?, error?, code? }
 *      每次抓取（成功/失败/拦截均算）在 workbench/data/web-audit.jsonl（静态 ROOT=dist 之外）留痕一行 JSONL + console；
 *      TC-S2-10：参数级失败（url 缺失/非字符串/空白/无法解析，code=invalid_url）从未发起实际抓取——不落审计行，仅回 200-envelope；
 *      {ts, by:'general', url, finalUrl, status, ok, code, ms}，超限按容量轮转（主文件→.1）；路径/上限可经
 *      DSH_WEB_AUDIT_FILE / DSH_WEB_AUDIT_MAX_BYTES 覆盖。错误码统一取 WEB_ERR 枚举常量表（http_<n> 为动态码）。
 *   ④ 健壮性（R-A2/I-9）：任何请求（含畸形 percent-encoding %zz、NUL、超长）都不允许击穿进程——
 *      解码失败/非法输入显式 400，其余同步意外由顶层 try/catch 回 500，进程始终存活；
 *      请求体未完整到达即拒绝（413 预检/流式超限）的响应带 Connection: close——防 keep-alive 错位复用
 *      （连接仍停在「等剩余体」态时复用会把下一请求误读为体字节，挂起约 6s 后 ECONNRESET）。
 */
import { createServer, request } from 'node:http'
import { appendFileSync, createReadStream, createWriteStream, existsSync, openSync, readSync, writeSync, closeSync, unlinkSync, rmdirSync, mkdirSync, readdirSync, renameSync, realpathSync, statSync, lstatSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, extname, join, normalize, dirname, sep, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildGithubTarballUrl, scanSkillDirs, sanitizeSkillId } from './skillImporter.mjs'

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
/** 限值 env 覆盖（测试注入口，先例 DSH_WEB_FETCH_ALLOW_PRIVATE）：缺省/非法回退默认值。 */
function envBytes(name, def) {
  const raw = process.env[name]
  if (!raw) return def
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}

export const FILES_LIMITS = Object.freeze({
  MAX_READ: 256 * 1024, // 文本预览截断阈值（字节）
  MAX_UPLOAD: envBytes('DSH_WORKBENCH_MAX_UPLOAD', 64 * 1024 * 1024), // 单文件上传上限（字节）：Content-Length 预检 + 流式限长
})
export const WEB_LIMITS = Object.freeze({
  MAX_BYTES: 2 * 1024 * 1024, // fetch 响应体上限（可被请求覆盖）
  TIMEOUT_MS: 10_000, // 整条链（含重定向）总超时，可被请求覆盖（P0-3：非每跳独立计时）
  MAX_REDIRECTS: 5,
  MAX_LINKS: 40, // 抽取链接数上限
  MAX_TEXT: 300_000, // 抽取正文/标题文本上限
})

/**
 * 浏览器抓取错误码枚举常量表（G-11/R-A4 收口）：后端 webFetch emit、web.test 断言、前端 errorText 映射
 * 三方对齐的唯一权威取值。上游 4xx/5xx 为动态码 http_<status>（格式 /^http_\d{3}$/，不入表）。
 */
export const WEB_ERR = Object.freeze({
  INVALID_URL: 'invalid_url',
  PROTOCOL_BLOCKED: 'protocol_blocked',
  SSRF_BLOCKED: 'ssrf_blocked',
  DNS_ERROR: 'dns_error',
  TOO_MANY_REDIRECTS: 'too_many_redirects',
  TIMEOUT: 'timeout',
  TOO_LARGE: 'too_large',
  FETCH_ERROR: 'fetch_error',
  UNSUPPORTED: 'unsupported',
  EMPTY_CONTENT: 'empty_content',
  WEB_ERROR: 'web_error',
  // P2-8④：限流与配额（空间级/单站级/每日字节）
  RATE_LIMITED: 'rate_limited',
  CONCURRENCY_LIMITED: 'concurrency_limited',
  DAILY_QUOTA_EXCEEDED: 'daily_quota_exceeded',
  // P2-8③：截图（默认关闭；未找到浏览器；并发占满；渲染失败）
  SHOT_DISABLED: 'shot_disabled',
  SHOT_UNAVAILABLE: 'shot_unavailable',
  SHOT_BUSY: 'shot_busy',
  SHOT_FAILED: 'shot_failed',
  OK: 'ok',
})
// 二进制扩展名黑名单（预览拒绝；下载不受限）
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.sqlite', '.db', '.db-wal', '.jar', '.class', '.pyc'])

// ── /api/fs/* 辅助 ──
function sendJson(res, code, data, extraHeaders = {}) {
  // 客户端断连（上传/下载中断）后写响应会触发 res error——先吞掉避免未处理 error 崩溃；响应已结束则静默
  if (res.destroyed || res.writableEnded) { try { res.destroy() } catch { /* */ } return }
  res.on('error', () => { /* 断连写错误：忽略 */ })
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
    res.end(JSON.stringify(data, null, 2))
  } catch { try { res.destroy() } catch { /* */ } }
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

/** .git 内部（相对路径**任一层段** === .git，大小写不敏感——Windows 上 .GIT 同义）一律拒绝访问
 *  （TC-S3-12 + R-A1：防嵌套/内嵌仓库（subrepo/.git/…）、submodule/worktree 指针文件、凭证/元数据外泄）。
 *  list/read/download 与写面 upload/mkdir/rename/delete 全部共用；只拦「穿越进 .git 的请求」——
 *  rel 不含 .git 段的父目录列表仍放行（嵌套仓库目录本身可见并可列出，界面再隐藏其 .git 子条目）。 */
function assertNotGitInternal(rel) {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  for (const seg of parts) {
    if (seg.toLowerCase() === '.git') throw new Error('禁止访问 .git 内部（防凭证/元数据外泄）')
    // P2-7：分片上传会话目录是**内部状态**（`.part` 是未完成上传的暂存）。若允许经文件中心浏览/删除，
    // 一次列表操作就能静默破坏「断点续传」（分片被删 → received 归零 / 长度校验失败），故与 .git 同级拒绝。
    if (seg === UPLOAD_SESSION_DIR) throw new Error('禁止访问上传会话内部目录（' + UPLOAD_SESSION_DIR + '）：分片暂存由服务端管理')
  }
}

/** 真实路径复检（R-A1）：real 相对目录根仍含任一层 .git 段（大小写不敏感）→ 拒绝。
 *  词法守卫看不到符号链接目标——junction/symlink 指向 .git 内部时只能在此拦截；
 *  写入目标的「既有祖先」为 .git 内部（如 link → root/.git 下新建文件）也在此拦下。
 *  调用前必须先通过「根内越界」检查（顺序见 resolve* 调用点，保证既有 越界：符号链接 错误语义不变）。 */
function assertRealNotGitInternal(rRoot, real) {
  if (real === rRoot) return
  const parts = real.slice(rRoot.length).replace(/\\/g, '/').split('/').filter(Boolean)
  for (const seg of parts) {
    if (seg.toLowerCase() === '.git') throw new Error('禁止访问 .git 内部（防凭证/元数据外泄）')
  }
}

/**
 * 根内路径解析（读路径）：相对路径逐段校验 + 词法越界拦截 + realpath 符号链接/挂载点逃逸拦截。
 * rel='' / '.' → 根目录本身。任何等价逃逸（../、绝对路径、盘符、NUL、根外 symlink 目标）都拒绝。
 */
export function resolveInsideRoot(root, rel) {
  if (typeof rel !== 'string') throw new Error('缺少参数 path')
  if (rel.includes('\0')) throw new Error('path 含非法字符（NUL）')
  assertNotGitInternal(rel) // R-A1：任一层段 .git 即拒（读面兜底；调用点漏网也不放行）
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
  assertRealNotGitInternal(rRoot, real) // R-A1：realpath 复检——符号链接指向 .git 内部 → 拒
  return abs
}

/** 写路径解析：同根内规范化，但允许目标本身尚不存在（mkdir/upload 用）；已存在祖先同样做逃逸校验。 */
export function resolveInsideRootForWrite(root, rel) {
  if (typeof rel !== 'string') throw new Error('缺少参数 path')
  if (rel.includes('\0')) throw new Error('path 含非法字符（NUL）')
  assertNotGitInternal(rel) // R-A1：任一层段 .git 即拒（写面兜底；路由层 upload 直调本函数无漏网）
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
      assertRealNotGitInternal(rRoot, real) // R-A1：既有祖先 realpath 复检——符号链接指向 .git 内部 → 拒
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

/** 读取原始字节（仅作契约测试/小文件载体；路由层下载请用 openDownloadStream 流式返回，避免整文件同步读入内存——P0-2）。 */
export function readFileBytes(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRoot(root, rel)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('路径不是文件')
  return { buffer: readFileSyncFull(abs), totalBytes: st.size, name: basename(abs) }
}

/**
 * 下载流（GET /api/files/download 路由层用）：读路径防护与 readFileBytes 同强度，返回文件元数据 +
 * createReadStream 可读流。修复 P0-2：路由层不再整文件同步读入内存，Content-Length 由调用方回填。
 */
export function openDownloadStream(root, rel) {
  assertNotGitInternal(rel)
  const abs = resolveInsideRoot(root, rel)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('路径不是文件')
  return { name: basename(abs), length: st.size, stream: createReadStream(abs) }
}

/**
 * PUT 上传（TC-S4-01..04；P0-1 修复同款原子语义）：raw bytes；上限预检（Content-Length 在路由层）；
 * 冲突按 strategy 处理（P2-7：ask/overwrite/skip/rename；`overwrite:true` 为向后兼容别名）。
 * 先写【同目录临时文件】再 renameSync 原子发布——中途任何失败都不会破坏既有目标文件、不留下半写目标。
 * 返回含 `skipped` / `name`（rename 策略下 name 为实际落盘名，requestedName 为请求名）。
 */
export function uploadBytes(root, rel, data, opts = {}) {
  const { strategy } = normalizeUploadStrategy(opts.strategy ?? (opts.overwrite === true ? 'overwrite' : undefined))
  assertNotGitInternal(rel)
  if (!Buffer.isBuffer(data)) throw new Error('上传体必须是二进制字节')
  if (data.length > FILES_LIMITS.MAX_UPLOAD) throw new Error('上传超过上限 ' + FILES_LIMITS.MAX_UPLOAD + ' 字节')
  const abs = resolveInsideRootForWrite(root, rel)
  const parent = dirname(abs)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(rel ?? '')))
  const pre = resolveUploadConflict(abs, strategy)
  if (pre.skipped) {
    const stSkip = statSync(pre.target)
    return { name: basename(pre.target), size: stSkip.size, mtime: entryMtime(stSkip.mtimeMs), skipped: true, requestedName: basename(abs) }
  }
  const tmp = tmpSibling(abs)
  try {
    writeFileSyncSafe(tmp, data)
    // 发布前竞态二次校验：与 rename 同处一个同步块，无 await 穿插（TC-S4-16 并发 no-overwrite）
    const final = resolveUploadConflict(pre.target, strategy)
    if (final.skipped) {
      tryUnlink(tmp)
      const stSkip = statSync(pre.target)
      return { name: basename(pre.target), size: stSkip.size, mtime: entryMtime(stSkip.mtimeMs), skipped: true, requestedName: basename(abs) }
    }
    renameSync(tmp, final.target)
    const st = statSync(final.target)
    return { name: basename(final.target), size: st.size, mtime: entryMtime(st.mtimeMs), skipped: false, requestedName: basename(abs) }
  } catch (e) {
    tryUnlink(tmp)
    throw e
  }
}

/**
 * 冲突决策（P2-7 单一实现：uploadBytes、receiveUploadBody、completeChunkedUpload 共用）：
 * 返回 `{ skipped: true }`（skip 策略且目标已存在）或 `{ skipped: false, target }`（应写入的绝对路径）。
 * - ask：目标已存在 → 抛 409 语义错误（前端询问后带明确策略重试）；
 * - overwrite：目标为目录 → 拒（不能以文件覆盖目录）；
 * - rename：目标已存在 → 取不冲突新名（`a.txt` → `a-1.txt`）。
 */
export function resolveUploadConflict(abs, strategy) {
  if (!existsSync(abs)) return { skipped: false, target: abs }
  if (strategy === 'skip') return { skipped: true, target: abs }
  if (strategy === 'overwrite') {
    if (statSync(abs).isDirectory()) throw new Error('目标已存在且为目录，不能以文件覆盖')
    return { skipped: false, target: abs }
  }
  if (strategy === 'rename') return { skipped: false, target: pickNonConflictingPath(abs) }
  throw new Error('目标已存在：如需覆盖请带 strategy=overwrite 或 overwrite=1（409 语义）')
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

// ───────────────────────── P2-7 ①上传冲突策略 ─────────────────────────
/**
 * 上传冲突策略（P2-7）：
 *   - `ask`（默认）：目标已存在 → 409 语义错误，由前端弹窗询问后带明确策略重试（既有行为）；
 *   - `overwrite`：覆盖既有文件（目标为目录仍拒）；
 *   - `skip`：目标已存在 → 跳过，返回 `{ skipped: true }` 且**不落盘**（批量上传常用）；
 *   - `rename`：目标已存在 → 自动加 `-1`/`-2`… 后缀写不冲突的新名（返回实际落盘名）。
 * 策略是**服务端权威**（前端只做选择与记忆）：未知策略一律 400，避免拼写错误被静默当成 ask。
 */
export const UPLOAD_STRATEGIES = Object.freeze(['ask', 'overwrite', 'skip', 'rename'])

/** 校验并归一策略参数（undefined/null/'' → 默认 ask）。 */
export function normalizeUploadStrategy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { strategy: 'ask', overwrite: false }
  const s = String(raw).trim()
  if (!UPLOAD_STRATEGIES.includes(s)) throw new Error('未知上传冲突策略：' + s + '（可选 ' + UPLOAD_STRATEGIES.join('/') + '）')
  return { strategy: s, overwrite: s === 'overwrite' }
}

/**
 * rename 策略取名：`a.txt` → `a-1.txt` → `a-2.txt`…（保留扩展名）。返回**尚不存在**的绝对路径；
 * 999 次仍冲突则放弃（防病态目录长循环）。
 */
export function pickNonConflictingPath(abs) {
  const dir = dirname(abs)
  const base = basename(abs)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i <= 999; i += 1) {
    const candidate = join(dir, stem + '-' + String(i) + ext)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('同名文件过多：自动重命名失败（已尝试 999 次）')
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

/** 同目录临时文件路径：与目标同卷保证 rename 原子性；随机后缀防并发冲突；发布成功后即不存在。 */
function tmpSibling(abs) {
  return abs + '.upload-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.tmp'
}

function tryUnlink(p) {
  try { if (existsSync(p)) unlinkSync(p) } catch { /* ENOENT/占用等：忽略，不阻断主流程 */ }
}

/**
 * 流式接收 PUT 上传体（P0-1 修复核心；TC-S4-02/15/16）：正文边收边写【同目录临时文件】，全程不触碰目标；
 * 完整收体且不超限后，在 ws close（fd 已释放，Windows 上 rename/unlink 前必须）回调中同步完成
 * 「竞态二次校验 + renameSync 原子发布」。任何失败（流式超限/客户端中断/写错误/竞态 409）在 ws close
 * 时统一删除临时文件并 reject——目标文件（含 overwrite 场景的原文件）保持原样，无半写残留。
 * 错误消息沿用 classifyFilesError 可识别文案（413/409/400）。resolve 值为最终 abs。
 */
export function receiveUploadBody(req, abs, { maxBytes = FILES_LIMITS.MAX_UPLOAD, overwrite = false, strategy } = {}) {
  const strat = normalizeUploadStrategy(strategy ?? (overwrite === true ? 'overwrite' : undefined)).strategy
  return new Promise((resolve, reject) => {
    const tmp = tmpSibling(abs)
    const abortErr = () => new Error('上传中断：客户端中止连接，原文件未受影响')
    let settled = false
    let bodyEnded = false
    let wsFailed = null // 非 null = 中途失败原因（超限/中断/写错误），close 时据此清理而非发布
    let written = 0
    const ws = createWriteStream(tmp, { flags: 'wx' })
    // 唯一终结点：ws close 时 fd 已释放，此时才安全 rename / unlink（Windows）
    ws.on('close', () => {
      if (settled) return
      if (!bodyEnded || wsFailed) {
        // 失败路径：未完整收体 或 写入出错 → 删临时文件后拒绝（原文件从未被触碰）
        settled = true
        tryUnlink(tmp)
        reject(wsFailed ?? abortErr())
        return
      }
      try {
        // 发布路径：完整收体且写入成功 —— 竞态二次校验 + 原子改名（同同步块无 await，竞态窗口为零）
        // P2-7：冲突决策抽到 resolveUploadConflict（与函数级 uploadBytes 共用同一实现）
        const final = resolveUploadConflict(abs, strat)
        if (final.skipped) {
          tryUnlink(tmp)
          settled = true
          resolve({ abs, skipped: true, requestedName: basename(abs), finalName: basename(abs) })
          return
        }
        renameSync(tmp, final.target)
        settled = true
        resolve({ abs: final.target, skipped: false, requestedName: basename(abs), finalName: basename(final.target) })
      } catch (e) {
        settled = true
        tryUnlink(tmp)
        reject(e)
      }
    })
    ws.on('error', (e) => { wsFailed = new Error('写入失败：' + (e?.message ?? e)); try { ws.destroy() } catch { /* */ } })
    // 中断兜底：仅在尚无失败原因时记为 abort（已超限 413 等不覆盖，保留更精确的错误映射）
    const abort = () => { if (!settled && !wsFailed) { wsFailed = abortErr(); try { ws.destroy() } catch { /* */ } } }
    req.on('data', (d) => {
      if (settled || wsFailed) return
      written += d.length
      if (written > maxBytes) {
        req.resume() // 排空余下请求体，让客户端能读到 413
        wsFailed = new Error('上传超过上限 ' + maxBytes + ' 字节')
        try { ws.destroy() } catch { /* */ }
        return
      }
      const okWrite = ws.write(d)
      if (!okWrite) { req.pause(); ws.once('drain', () => req.resume()) } // 背压：大上传不做无界缓冲
    })
    req.on('end', () => { if (settled || wsFailed) return; bodyEnded = true; if (!ws.destroyed) ws.end() })
    req.on('aborted', abort)
    req.on('error', abort)
    req.on('close', () => { if (!bodyEnded) abort() }) // 与 Node 版本无关的中断兜底（体未收完即 close）
  })
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

/** 读取原始请求体字节（分片上传用）：带显式上限，超限立即 413 语义失败并排空余下字节。 */
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let failed = false
    req.on('data', (d) => {
      if (failed) return
      total += d.length
      if (total > maxBytes) {
        failed = true
        req.resume() // 排空余下字节，让客户端能读到响应而不是被 RST
        reject(new Error('分片超过上限 ' + maxBytes + ' 字节'))
        return
      }
      chunks.push(d)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', (e) => { if (!failed) { failed = true; reject(e) } })
  })
}

// ───────────────────────── P2-7 ②大文件分片上传与断点续传 ─────────────────────────
/**
 * 分片上传（P2-7）：为突破单次 64MB 上限提供**顺序分片 + 断点续传**。
 *
 * 会话状态只落**磁盘**（`<根>/.dsh-uploads/<uploadId>.json` + `.part`），进程重启后仍可续传——
 * 「已收字节」即 `.part` 的长度，不依赖任何内存表。
 *
 * 端点：
 *   POST   /api/files/upload/init   { scope, path, size, strategy? } → { uploadId, received, chunkSize }
 *          · 目标已存在且 strategy=ask（默认）→ 409（前端询问后带明确策略重来）
 *          · skip 且目标已存在 → 直接 `{ skipped: true }`（不建会话）
 *          · 同 path+size 已有未完成会话 → 返回原 uploadId 与 received（前端据此续传）
 *   PUT    /api/files/upload/chunk?uploadId=&offset=N  （body = 该片原始字节）
 *          · offset 必须 == 当前 received（顺序语义）；不等 → 409 且回传 received 供校正
 *   POST   /api/files/upload/complete { uploadId }
 *          · 长度必须等于声明 size（否则 400 且**保留会话**可续传）；随后原子发布（冲突按 strategy）
 *   DELETE /api/files/upload/abort?uploadId=  → 丢弃会话与分片
 *
 * 安全：uploadId 由服务端签发（`u_` + 16 字节随机 hex），请求侧只做**白名单字符校验**（`assertUploadId`），
 * 绝不把未校验字符串拼进路径；会话与分片都落在根内隐藏目录 `.dsh-uploads/`（不出现在文件列表）。
 */
export const UPLOAD_SESSION_DIR = '.dsh-uploads'
export const UPLOAD_CHUNK_SIZE = envBytes('DSH_WORKBENCH_CHUNK_SIZE', 4 * 1024 * 1024) // 建议分片大小（前端据此切片）
export const UPLOAD_MAX_SIZE = envBytes('DSH_WORKBENCH_MAX_UPLOAD_TOTAL', 1024 * 1024 * 1024) // 分片上传总上限（默认 1GB）

/** 会话目录绝对路径（按需创建）。 */
function uploadSessionDir(root) {
  const dir = join(realpathSync(root), UPLOAD_SESSION_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** uploadId 白名单校验（防路径穿越）。 */
export function assertUploadId(id) {
  if (typeof id !== 'string' || !/^u_[0-9a-f]{16,64}$/.test(id)) throw new Error('uploadId 非法（须为服务端签发的 u_<hex>）')
  return id
}

function sessionPaths(root, uploadId) {
  assertUploadId(uploadId)
  const dir = uploadSessionDir(root)
  return { meta: join(dir, uploadId + '.json'), part: join(dir, uploadId + '.part') }
}

function readSession(root, uploadId) {
  const { meta, part } = sessionPaths(root, uploadId)
  if (!existsSync(meta)) throw new Error('上传会话不存在或已过期：' + uploadId)
  let obj = null
  try { obj = JSON.parse(readFileSyncFull(meta).toString('utf8')) } catch { throw new Error('上传会话元数据损坏：' + uploadId) }
  const received = existsSync(part) ? statSync(part).size : 0
  return { ...obj, received }
}

function writeSession(root, uploadId, obj) {
  const { meta } = sessionPaths(root, uploadId)
  writeFileSyncSafe(meta, Buffer.from(JSON.stringify(obj), 'utf8'))
}

/** 发起/复用分片上传会话（同 path+size 已有会话 → 续传：返回原 uploadId 与已收字节）。 */
export function initChunkedUpload(root, { path: rel, size, strategy }) {
  const strat = normalizeUploadStrategy(strategy).strategy
  if (rel === undefined || rel === null || String(rel).trim() === '') throw new Error('缺少参数 path')
  const total = Number(size)
  if (!Number.isInteger(total) || total < 0) throw new Error('缺少参数 size（非负整数）')
  if (total > UPLOAD_MAX_SIZE) throw new Error('文件超过分片上传上限 ' + UPLOAD_MAX_SIZE + ' 字节')
  const abs = resolveInsideRootForWrite(root, rel)
  const parent = dirname(abs)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(rel)))
  const pre = resolveUploadConflict(abs, strat)
  if (pre.skipped) return { skipped: true, requestedName: basename(abs), finalName: basename(abs), received: 0, size: total }
  // 续传复用：同目标 + 同 size 的未完成会话
  const dir = uploadSessionDir(root)
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let obj = null
    try { obj = JSON.parse(readFileSyncFull(join(dir, f)).toString('utf8')) } catch { continue }
    if (obj && obj.rel === String(rel) && obj.size === total) {
      const uploadId = String(f).slice(0, -5)
      const received = existsSync(join(dir, uploadId + '.part')) ? statSync(join(dir, uploadId + '.part')).size : 0
      return { uploadId, received, size: total, chunkSize: UPLOAD_CHUNK_SIZE, resumed: received > 0, requestedName: basename(abs), finalName: basename(pre.target) }
    }
  }
  const uploadId = 'u_' + randomBytes(16).toString('hex')
  const { part } = sessionPaths(root, uploadId)
  closeSync(openSync(part, 'w')) // 立即建空分片文件（received=0 有据可查）
  writeSession(root, uploadId, { rel: String(rel), size: total, strategy: strat, createdAt: new Date().toISOString() })
  return { uploadId, received: 0, size: total, chunkSize: UPLOAD_CHUNK_SIZE, resumed: false, requestedName: basename(abs), finalName: basename(pre.target) }
}

/** 追加一片（顺序语义）：offset 必须 == 当前已收字节；返回新 received。 */
export function appendUploadChunk(root, uploadId, offset, buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('分片体必须是二进制字节')
  if (buf.length === 0) throw new Error('分片体不能为空')
  const s = readSession(root, uploadId)
  const off = Number(offset)
  if (!Number.isInteger(off) || off < 0) throw new Error('缺少参数 offset（非负整数）')
  if (off !== s.received) {
    const e = new Error('分片偏移不匹配：当前已收 ' + s.received + ' 字节，收到 offset=' + off + '（请从 received 续传）')
    e.received = s.received
    e.code = 'OFFSET_MISMATCH'
    throw e
  }
  if (s.received + buf.length > s.size) throw new Error('分片超出声明大小：' + (s.received + buf.length) + ' > ' + s.size)
  const { part } = sessionPaths(root, uploadId)
  const fd = openSync(part, 'r+')
  try {
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written, s.received + written)
      if (n <= 0) throw new Error('分片写入失败')
      written += n
    }
  } finally { closeSync(fd) }
  return { received: s.received + buf.length, size: s.size }
}

/** 完成分片上传：长度校验 → 原子发布（冲突按 strategy）→ 清理会话。长度不足时**保留**会话供续传。 */
export function completeChunkedUpload(root, uploadId) {
  const s = readSession(root, uploadId)
  if (s.received !== s.size) {
    const e = new Error('分片未收齐：已收 ' + s.received + '/' + s.size + ' 字节（会话保留，可继续续传）')
    e.received = s.received
    e.code = 'INCOMPLETE'
    throw e
  }
  const abs = resolveInsideRootForWrite(root, s.rel)
  const { part, meta } = sessionPaths(root, uploadId)
  const final = resolveUploadConflict(abs, s.strategy ?? 'ask')
  if (final.skipped) {
    tryUnlink(part); tryUnlink(meta)
    return { skipped: true, name: basename(abs), requestedName: basename(abs), finalName: basename(abs), size: s.size }
  }
  const parent = dirname(final.target)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(s.rel)))
  try { renameSync(part, final.target) } catch (e) { throw new Error('发布失败：' + (e?.message ?? e)) }
  tryUnlink(meta)
  const st = statSync(final.target)
  return { skipped: false, name: basename(final.target), requestedName: basename(abs), finalName: basename(final.target), size: st.size, mtime: entryMtime(st.mtimeMs) }
}

/** 中止分片上传：丢弃会话与分片（幂等——不存在也算成功）。 */
export function abortChunkedUpload(root, uploadId) {
  const { meta, part } = sessionPaths(root, uploadId)
  const existed = existsSync(meta) || existsSync(part)
  tryUnlink(part); tryUnlink(meta)
  return { uploadId, aborted: existed }
}

// ───────────────────────── P2-7 ③文件名搜索与批量操作 ─────────────────────────
/**
 * 文件名搜索（P2-7）：大小写不敏感的子串匹配；`recursive=true` 时递归子目录。
 * 纪律：与列表同强度过滤——隐藏条目与 `.git` 不进结果；跳过 `.git` / `.dsh-uploads` 目录；
 * 递归上限 `maxResults`（默认 500）防超大仓库打爆响应体；深度上限 12 层防病态嵌套。
 */
export function searchFiles(root, rel, query, { recursive = false, maxResults = 500, maxDepth = 12 } = {}) {
  assertNotGitInternal(rel)
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q.length === 0) throw new Error('缺少参数 q（搜索关键词）')
  const abs = resolveInsideRoot(root, rel)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error('路径不是目录或不存在')
  const results = []
  let truncated = false
  const walk = (dir, relPath, depth) => {
    if (truncated) return
    let rows = []
    try { rows = readdirSync(dir, { withFileTypes: true }) } catch { return } // 无权限目录：跳过
    for (const d of rows) {
      if (truncated) return
      if (d.name.startsWith('.') || d.name === '.git') continue
      const childRel = relPath.length > 0 ? relPath + '/' + d.name : d.name
      const isDir = d.isDirectory()
      if (d.name.toLowerCase().includes(q)) {
        let size = 0
        let mtime = null
        try {
          const st = statSync(join(dir, d.name))
          size = st.size
          mtime = entryMtime(st.mtimeMs)
        } catch { /* 断链/权限 → 空值 */ }
        results.push({ name: d.name, path: childRel, type: isDir ? 'dir' : 'file', size, mtime })
        if (results.length >= maxResults) { truncated = true; return }
      }
      if (recursive && isDir && depth < maxDepth && d.name !== UPLOAD_SESSION_DIR) walk(join(dir, d.name), childRel, depth + 1)
    }
  }
  walk(abs, String(rel ?? ''), 0)
  results.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.path.localeCompare(b.path))
  return { root, path: String(rel ?? ''), query: String(query), recursive, results, truncated, maxResults }
}

/**
 * 批量操作（P2-7）：对同一根内多个相对路径顺序执行一个动作，**逐项报告**成败（不因单项失败整体回滚）。
 *   - `delete`：每项 confirm 语义由路由层统一要求（body.confirm='yes'）；
 *   - `move`：每项移到 body.toDir（目录，须存在）；目标同名已存在 → 该项失败（沿用 renamePath 的 409 语义）。
 * 上限 200 项/次（防单请求打爆）；`paths` 为空或含非法项 → 400。
 * 返回 `{ action, ok, failed, items: [{ path, ok, error? , to? }] }`。
 */
export function batchFileOp(root, { action, paths, toDir, confirm } = {}) {
  if (action !== 'delete' && action !== 'move') throw new Error('缺少参数 action（delete|move）')
  if (action === 'delete' && confirm !== 'yes') throw new Error('删除需要二次确认：请带 confirm=yes')
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('缺少参数 paths（非空数组）')
  if (paths.length > 200) throw new Error('批量操作上限 200 项/次，当前 ' + paths.length)
  for (const p of paths) if (typeof p !== 'string' || p.length === 0) throw new Error('paths 必须是相对路径字符串数组')
  if (action === 'move') {
    if (typeof toDir !== 'string' || toDir.trim().length === 0) throw new Error('缺少参数 toDir（目标目录）')
    const absDir = resolveInsideRoot(root, toDir)
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) throw new Error('目标目录不存在：' + toDir)
  }
  const items = []
  for (const p of paths) {
    try {
      if (action === 'delete') {
        removePath(root, p, 'yes')
        items.push({ path: p, ok: true })
      } else {
        const base = basename(p.replace(/\\/g, '/'))
        const to = toDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + base
        renamePath(root, p, to)
        items.push({ path: p, ok: true, to })
      }
    } catch (e) {
      items.push({ path: p, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const failed = items.filter(i => !i.ok).length
  return { action, ok: items.length - failed, failed, items }
}

// ───────────────────────── P2-7 ④git 状态与差异（只读）─────────────────────────
/**
 * git 只读查询（P2-7）：**绝不写仓库**——只跑 `status` / `diff` / `rev-list` / `log` 这类只读子命令，
 * 不提供 stage/commit/checkout 能力（越权风险与产品定位不符）。
 *
 * `gitStatus(root)`：分支 + 领先/落后 + 逐文件状态标记（区分暂存区与工作区）+ 未跟踪文件。
 * `gitDiff(root, rel)`：单文件 unified diff（工作区 vs 索引；`staged=true` 时索引 vs HEAD）；
 *   二进制/超长 diff 由 `maxBytes` 截断并显式标注（不静默丢内容）。
 * `gitLog(root, limit)`：最近提交（hash/作者/时间/标题），供「最近提交」展示。
 *
 * 非 git 仓库 → `{ isRepo: false }`（不抛错，前端据此隐藏 git 面板）。
 */
const GIT_TIMEOUT_MS = 8000

/** 在指定目录跑只读 git 命令；非仓库/命令失败 → null（调用方降级）。 */
function gitRead(dir, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer }).toString()
  } catch { return null }
}

/** `git status --porcelain=v1 -z` 解析：XY 两位分别是索引与工作区状态。 */
export function parsePorcelainZ(raw) {
  const out = []
  const parts = String(raw ?? '').split('\0').filter(s => s.length > 0)
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i]
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    const rest = line.slice(3)
    // 重命名/复制：porcelain -z 把「旧路径」放在紧随其后的 NUL 段里
    if (x === 'R' || x === 'C') {
      const from = parts[i + 1] ?? ''
      i += 1
      out.push({ path: rest, from, index: x, worktree: y, code: 'R', staged: true, untracked: false, conflicted: false })
      continue
    }
    const untracked = x === '?' && y === '?'
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    out.push({
      path: rest,
      index: x,
      worktree: y,
      code: conflicted ? 'U' : (untracked ? '??' : (x !== ' ' ? x : y)),
      staged: x !== ' ' && x !== '?',
      untracked,
      conflicted,
    })
  }
  return out
}

/** git 探测目录：`git -C` 需要**目录**——传文件路径会直接失败（曾导致 gitDiff 把文件当仓库 → isRepo 误判 false）。 */
function gitProbeDir(abs) {
  try {
    return statSync(abs).isDirectory() ? abs : dirname(abs)
  } catch {
    return dirname(abs) // 目标不存在（已删除）：用所在目录探测，仍能拿到仓库信息
  }
}

export function gitStatus(root, rel = '') {
  assertNotGitInternal(rel)
  const abs = gitProbeDir(resolveInsideRoot(root, rel))
  const top = gitRead(abs, ['rev-parse', '--show-toplevel'])
  if (top === null || top.trim().length === 0) return { isRepo: false }
  const repoRoot = normalize(top.trim())
  const branch = (gitRead(abs, ['branch', '--show-current']) ?? '').trim() || null
  const porcelain = gitRead(abs, ['status', '--porcelain=v1', '-z']) ?? ''
  const files = parsePorcelainZ(porcelain)
  let ahead = null
  let behind = null
  if (branch) {
    const counts = gitRead(abs, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    if (counts) {
      const m = /^(\d+)\s+(\d+)\s*$/.exec(counts.trim())
      if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
    }
  }
  const summary = files.reduce((acc, f) => {
    if (f.conflicted) acc.conflicted += 1
    else if (f.untracked) acc.untracked += 1
    else if (f.staged && f.worktree !== ' ') acc.both += 1
    else if (f.staged) acc.staged += 1
    else acc.unstaged += 1
    return acc
  }, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, both: 0 })
  return { isRepo: true, repoRoot, branch, ahead, behind, files, summary, total: files.length }
}

/** 单文件 unified diff（只读）。二进制 → 显式标注；超 maxBytes → 截断并标注；文件不存在 → 明确说明而非抛错。 */
export function gitDiff(root, rel, { staged = false, maxBytes = 256 * 1024 } = {}) {
  assertNotGitInternal(rel)
  let absFile = null
  try {
    absFile = resolveInsideRoot(root, rel)
  } catch (e) {
    // 文件已被删除：退回根目录探测仓库信息，用 note 说明而非 400（前端仍要显示仓库上下文）
    if (!/不存在/.test(e?.message ?? '')) throw e
    const top = gitRead(root, ['rev-parse', '--show-toplevel'])
    if (top === null || top.trim().length === 0) return { isRepo: false }
    return { isRepo: true, path: String(rel ?? ''), diff: '', binary: false, truncated: false, note: '文件不存在（可能已删除）' }
  }
  const probe = gitProbeDir(absFile)
  const top = gitRead(probe, ['rev-parse', '--show-toplevel'])
  if (top === null || top.trim().length === 0) return { isRepo: false }
  const repoRoot = normalize(top.trim())
  if (!existsSync(absFile)) return { isRepo: true, path: String(rel ?? ''), diff: '', binary: false, truncated: false, note: '文件不存在（可能已删除）' }
  const relInRepo = absFile.slice(repoRoot.length).replace(/\\/g, '/').replace(/^\/+/, '')
  // --no-color + --no-ext-diff：只读预览，输出稳定可缓存；未跟踪文件无 diff（note 说明）
  const args = ['diff', '--no-color', '--no-ext-diff', '-U3']
  if (staged) args.push('--cached')
  args.push('--', relInRepo)
  const raw = gitRead(probe, args)
  if (raw === null) return { isRepo: true, path: String(rel ?? ''), diff: '', binary: false, truncated: false, note: 'diff 读取失败（可能不是仓库内文件）' }
  const isBinary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw)
  const over = Buffer.byteLength(raw, 'utf8') > maxBytes
  const diff = over ? raw.slice(0, maxBytes) : raw
  return {
    isRepo: true, repoRoot, path: String(rel ?? ''), relInRepo, staged,
    diff, binary: isBinary, truncated: over,
    note: raw.length === 0 ? '无差异（文件与' + (staged ? ' HEAD' : '索引') + '一致或未跟踪）' : (over ? 'diff 超过 ' + maxBytes + ' 字节已截断' : null),
  }
}

/** 最近提交（只读）：`--format` 用 \x1f 分隔字段、\x1e 分隔记录，避免标题含任意字符时解析歧义。 */
export function gitLog(root, rel = '', limit = 20) {
  const abs = gitProbeDir(resolveInsideRoot(root, rel))
  const top = gitRead(abs, ['rev-parse', '--show-toplevel'])
  if (top === null || top.trim().length === 0) return { isRepo: false }
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const raw = gitRead(abs, ['log', '-n', String(n), '--date=iso-strict', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e'])
  if (raw === null) return { isRepo: true, commits: [] }
  const commits = raw.split('\x1e').map(s => s.trim()).filter(s => s.length > 0).map(s => {
    const [hash, author, date, subject] = s.split('\x1f')
    return { hash: hash ?? '', short: (hash ?? '').slice(0, 8), author: author ?? '', date: date ?? '', subject: subject ?? '' }
  })
  return { isRepo: true, repoRoot: normalize(top.trim()), commits }
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

// ───────────────────────── 浏览器助手（S6：SSRF 防护 fetch 代理 + 零依赖正文抽取）─────────────────────────
import { lookup } from 'node:dns/promises'

function webErr(code, error) {
  const e = new Error(error)
  e.code = code
  return e
}

// ── R-A3/J3-A：抓取审计（JSONL 落盘到静态 ROOT 之外 + console；容量轮转；写失败绝不影响抓取响应 / 进程）──
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url)) // workbench/scripts：模块 URL 恒定位，不受 cwd 影响
export const WEB_AUDIT = Object.freeze({
  /** 默认审计文件：<workbench>/data/web-audit.jsonl（ROOT = workbench/dist 之外；workbench/.gitignore 已含 data/） */
  DEFAULT_FILE: join(SCRIPTS_DIR, '..', 'data', 'web-audit.jsonl'),
  /** 轮转上限（字节）：主文件将超限 → 改名 .1（覆盖旧档）开新文件续写——主文件大小有界、历史保留一份 */
  DEFAULT_MAX_BYTES: 5 * 1024 * 1024,
  /** 留痕来源标识（R-A3 验收字段 by=general） */
  BY: 'general',
})

/** 审计目标（每次写时现读 env，测试可注入）：DSH_WEB_AUDIT_FILE 覆盖路径、DSH_WEB_AUDIT_MAX_BYTES 覆盖轮转上限。 */
function webAuditTarget() {
  const envFile = process.env.DSH_WEB_AUDIT_FILE
  const file = typeof envFile === 'string' && envFile.trim().length > 0 ? envFile.trim() : WEB_AUDIT.DEFAULT_FILE
  const maxBytes = envBytes('DSH_WEB_AUDIT_MAX_BYTES', WEB_AUDIT.DEFAULT_MAX_BYTES)
  return { file, maxBytes }
}

/** 容量轮转：主文件已存在且写入后将超限 → 主文件改名 <file>.1（先清旧档），主文件开新续写。 */
function rotateAuditIfNeeded(file, maxBytes, lineBytes) {
  let size = 0
  try { size = statSync(file).size } catch { return } // 主文件尚不存在：无需轮转
  if (size + lineBytes <= maxBytes) return
  const archive = file + '.1'
  try { if (existsSync(archive)) unlinkSync(archive) } catch { /* 归档清理失败不阻断 */ }
  try { renameSync(file, archive) } catch { /* 轮转失败降级为直接追加（审计可用性优先，进程不死 I-9） */ }
}

/**
 * R-A3：每次 /api/web/fetch 追加一行 JSONL（成功/失败/拦截都算）并 console 一行。
 * 审计写失败只 console.error——绝不抛出、绝不影响抓取响应（I-9）。ts/by 在此补齐，entry 含其余字段。
 */
export function appendWebAudit(entry) {
  let where = ''
  try {
    const { file, maxBytes } = webAuditTarget()
    where = file
    const line = JSON.stringify({ ts: new Date().toISOString(), by: WEB_AUDIT.BY, ...entry })
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateAuditIfNeeded(file, maxBytes, Buffer.byteLength(line, 'utf8'))
    appendFileSync(file, line + '\n')
    console.log('[web-audit] ' + line)
  } catch (e) {
    console.error('[web-audit] 写入失败（不影响抓取响应）: ' + (e instanceof Error ? e.message : String(e)) + (where ? ' @ ' + where : ''))
  }
}

/** 是否允许目标为非公网地址（默认否；测试/本地 mock 经 DSH_WEB_FETCH_ALLOW_PRIVATE=1 放开——见 TEST_CASES §8.1）。 */
function privateFetchAllowed() {
  return process.env.DSH_WEB_FETCH_ALLOW_PRIVATE === '1'
}

function isPrivateV4(a, b, c, d) {
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true // 组播/保留
  return false
}

/** 把各种 inet_aton 混淆形态归一成 4 段十进制 v4（TC-S6-05：十进制/十六进制/短点分）。无法解析返回 null。 */
function normalizeV4Literal(host) {
  const h = String(host).replace(/^\[(.*)\]$/, '$1')
  if (h.includes(':')) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
    if (m) return normalizeV4Literal(m[1])
    const m2 = /^::ffff:([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/.exec(h)
    if (m2) {
      const a = parseInt(m2[1], 16), b = parseInt(m2[2], 16)
      return [Math.floor(a / 256), a % 256, Math.floor(b / 256), b % 256].join('.')
    }
    return null
  }
  if (/^\d+$/.test(h)) {
    // 单整数：0x 前缀=hex、0 前缀=octal、其余=dec；网络序转 4 段
    let n = 0
    if (/^0x/i.test(h)) n = parseInt(h.slice(2), 16)
    else if (/^0/.test(h) && h.length > 1) n = parseInt(h.slice(1), 8)
    else n = parseInt(h, 10)
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  const parts = h.split('.').map(p => {
    if (/^0x/i.test(p)) return parseInt(p.slice(2), 16)
    if (/^0/.test(p) && p.length > 1) return parseInt(p.slice(1), 8)
    return parseInt(p, 10)
  })
  if (parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null
  if (parts.length === 1) return normalizeV4Literal(String(parts[0]))
  if (parts.length === 2) return [parts[0], parts[1], 0, 0].join('.')
  if (parts.length === 3) return [parts[0], parts[1], parts[2], 0].join('.')
  if (parts.length === 4) return parts.join('.')
  return null
}

function isPrivateV6(host) {
  const h = String(host).toLowerCase().replace(/\[|\]/g, '')
  if (h === '::' || h === '::1') return true
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice(7)
    const norm = normalizeV4Literal(v4)
    return norm ? isPrivateV4Literal(norm) : true
  }
  if (h.startsWith('fc') || h.startsWith('fd')) return true
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true
  return false
}
function isPrivateV4Literal(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4) return false
  return isPrivateV4(p[0], p[1], p[2], p[3])
}

/** SSRF 判定：IP 字面量（含混淆）或域名 DNS 解析结果命中私网/回环/保留段 → 阻断（TC-S6-05/06/07）。 */
export async function assertPublicTarget(url) {
  if (privateFetchAllowed()) return { hostname: url.hostname, ip: null }
  const hostname = url.hostname.toLowerCase()
  const isV6 = hostname.includes(':')
  let literal = null
  if (isV6) {
    if (isPrivateV6(hostname)) throw webErr(WEB_ERR.SSRF_BLOCKED, 'SSRF 防护：禁止访问私网/回环地址（含 IPv6）')
    return { hostname, ip: hostname }
  }
  if (/^\d/.test(hostname) || /^0x/i.test(hostname)) {
    literal = normalizeV4Literal(hostname)
    if (literal && isPrivateV4Literal(literal)) throw webErr(WEB_ERR.SSRF_BLOCKED, 'SSRF 防护：禁止访问私网/回环地址（含 IP 混淆写法）')
    if (literal) return { hostname, ip: literal }
  }
  // 域名：DNS 解析（A/AAAA）逐条校验
  let addrs = []
  try {
    const r = await lookup(hostname, { all: true, verbatim: true })
    addrs = r.map(x => x.address)
  } catch {
    throw webErr(WEB_ERR.DNS_ERROR, '域名解析失败，无法确认目标地址（已阻止外呼）')
  }
  for (const addr of addrs) {
    if (addr.includes(':')) { if (isPrivateV6(addr)) throw webErr(WEB_ERR.SSRF_BLOCKED, 'SSRF 防护：域名解析指向私网/回环地址') }
    else if (isPrivateV4Literal(addr)) throw webErr(WEB_ERR.SSRF_BLOCKED, 'SSRF 防护：域名解析指向私网/回环地址')
  }
  return { hostname, ip: addrs[0] ?? null }
}

function decodeHtml(buf, contentType) {
  const ct = String(contentType ?? '').toLowerCase()
  const mCharset = /charset\s*=\s*["']?([\w-]+)/.exec(ct)
  let charset = mCharset ? mCharset[1] : null
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1')
    const meta = /charset\s*=\s*["']?([\w-]+)/i.exec(head)
    charset = meta ? meta[1] : 'utf-8'
  }
  try { return new TextDecoder(charset, { fatal: false }).decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)) } catch { return '' } })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ensp|emsp|mdash|ndash|hellip|copy|reg|middot|bull);/g, (_, n) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', middot: '·', bull: '•',
    })[n] ?? `&${n};`)
}

function stripTags(s) {
  return decodeEntities(s).replace(/<[^>]*>/g, ' ')
}

/** 零依赖 HTML→正文抽取：剥离 script/style/head/noscript/iframe/svg/template + 标签，保留段落换行。 */
// ── P2-8②：Readability-lite 正文抽取（零依赖启发式；不改动既有 extractHtml 契约，仅替换其内部实现）──
//
// 与 v1 的差别：v1 是「删噪声标签 → 全文去标签」，导航/页脚/侧栏的长文本会混进正文，标题层级也丢失。
// 这里改为「候选容器打分选块 + 结构化渲染」：
//   1) 先剔除脚本/样式/表单与样板容器（nav/aside/footer/header/form + class/id 命中样板词），并记录剔除数；
//   2) 用轻量标签栈扫描出 article/main/[role=main] 及 div/section 候选块，按
//      「文本长度 ×(1−2×链接密度)」+ 语义标签加权 打分，取最高分块；没有任何候选则回退整篇 body；
//   3) 按结构渲染为可读文本：标题 → #/##、列表 → -、代码 → 围栏、引用 → >、表格行 → | 分隔；
//   4) 返回质量元数据（选用策略/得分/字数/标题数/剔除块数/候选数/链接密度），供界面明示抽取质量。
const BOILERPLATE_RE = /(?:^|[\s_-])(nav|navbar|menu|sidebar|side-bar|footer|header|banner|cookie|consent|breadcrumb|advert|ads?|sponsor|share|social|comment|related|promo|popup|modal|drawer|toolbar|pagination)(?:$|[\s_-])/i

/** P2-8② 抽取参数（阈值集中在一处，便于说明与调整）。 */
export const WEB_EXTRACT = Object.freeze({
  // 低于此长度的候选块不参与「密度」评选（按钮行、面包屑残留）；但显式语义容器（article/main）不受此限
  MIN_CANDIDATE_CHARS: 40,
})

/** 结构化渲染：把选中块的 HTML 转成可读文本（保留标题/列表/代码/引用/表格等结构信号）。 */
function renderStructured(seg) {
  let s = String(seg ?? '')
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => '\n```\n' + stripTags(code).replace(/^\n+|\n+$/g, '') + '\n```\n')
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv, inner) => '\n' + '#'.repeat(Number(lv)) + ' ' + stripTags(inner).replace(/\s+/g, ' ').trim() + '\n')
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => '\n' + stripTags(inner).split('\n').map(l => '> ' + l.trim()).join('\n') + '\n')
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => '\n- ' + stripTags(inner).replace(/\s+/g, ' ').trim())
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row) => '\n| ' + [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]).replace(/\s+/g, ' ').trim()).join(' | ') + ' |')
  s = s.replace(/<hr\b[^>]*>/gi, '\n---\n')
  s = s.replace(/<(br|\/p|\/div|\/section|\/article|\/ul|\/ol|\/table|\/h[1-6]|\/pre|\/blockquote)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  return s
    .split('\n')
    .map(l => l.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 剔除样板容器（nav/aside/footer/header/form + 样板 class/id），返回 { html, dropped }（dropped=剔除块数）。 */
function stripBoilerplate(html) {
  let dropped = 0
  let out = String(html ?? '')
  const tagDrop = /<(nav|aside|footer|header|form|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi
  out = out.replace(tagDrop, () => { dropped += 1; return ' ' })
  // class/id 命中样板词的同名容器（成对标签，含嵌套则多轮收敛，最多 3 轮避免病态输入）
  for (let round = 0; round < 3; round += 1) {
    const before = out
    for (const tagName of ['div', 'section', 'ul', 'p', 'span']) {
      const re = new RegExp('<' + tagName + '\\b([^>]*)>[\\s\\S]*?<\\/' + tagName + '>', 'gi')
      out = out.replace(re, (whole, attrs) => {
        const m = /\b(?:class|id)\s*=\s*(["'])(.*?)\1/i.exec(attrs)
        if (m && BOILERPLATE_RE.test(m[2])) { dropped += 1; return ' ' }
        return whole
      })
    }
    if (out === before) break
  }
  out = out.replace(/<(script|style|noscript|template|svg|iframe|canvas|video|audio|picture)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  return { html: out, dropped }
}

/**
 * 候选块扫描：轻量标签栈，收集语义容器（article/main/[role=main]）与块级 div/section，
 * 每个候选记录内部文本统计；嵌套候选都保留（外层含内层时由打分自然偏向内容密集者）。
 */
function collectCandidates(html) {
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g
  const stack = []
  const out = []
  let m
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    const attrs = m[3] ?? ''
    const selfClose = m[4] === '/'
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === name) {
          const open = stack[i]
          stack.length = i
          if (open.candidate) {
            const inner = html.slice(open.end, m.index)
            out.push({ ...open, inner })
            if (out.length >= 400) return out
          }
          break
        }
      }
      continue
    }
    if (selfClose) continue
    const attrMatch = /\b(?:class|id)\s*=\s*(["'])(.*?)\1/i.exec(attrs)
    const attrText = (attrMatch?.[2] ?? '') + ' ' + attrs
    const isSemantic = name === 'article' || name === 'main' || /\brole\s*=\s*(["']?)main\b/i.test(attrs)
    const isBlock = name === 'div' || name === 'section'
    const candidate = isSemantic || (isBlock && !BOILERPLATE_RE.test(attrText))
    stack.push({ name, candidate, semantic: isSemantic, kind: isSemantic ? (name === 'article' ? 'article' : 'main') : name, end: re.lastIndex })
  }
  return out
}

/** 候选打分：文本长度为主，链接密度惩罚（导航块链接多文本少），语义标签加权。 */
function scoreCandidate(inner) {
  const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim()
  const chars = text.length
  const linkText = [...String(inner).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(x => decodeEntities(stripTags(x[1])).replace(/\s+/g, ' ').trim()).join('').length
  const linkDensity = chars > 0 ? Math.min(1, linkText / chars) : 1
  const headings = (String(inner).match(/<h[1-6]\b/gi) ?? []).length
  const paragraphs = (String(inner).match(/<p\b/gi) ?? []).length
  const listItems = (String(inner).match(/<li\b/gi) ?? []).length
  return { chars, linkDensity, headings, paragraphs, listItems, text }
}

export function extractReadable(html, finalUrl) {
  const raw = String(html ?? '')
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, ' ').trim() : ''
  const { html: cleaned, dropped } = stripBoilerplate(raw)
  const candidates = collectCandidates(cleaned)
  let best = null // 通过长度阈值的最高分候选
  let bestShort = null // 未过阈值但**显式语义容器**（article/main）的最高分候选
  for (const c of candidates) {
    const s = scoreCandidate(c.inner)
    if (s.chars === 0) continue
    const semanticBonus = c.semantic ? 1.35 : 1
    const score = s.chars * (1 - 2 * s.linkDensity) * semanticBonus + s.paragraphs * 20 + s.headings * 15
    const entry = { score, ...s, kind: c.kind, inner: c.inner, semantic: c.semantic }
    if (s.chars >= WEB_EXTRACT.MIN_CANDIDATE_CHARS) {
      if (!best || score > best.score) best = entry
    }
    if (c.semantic && (!bestShort || score > bestShort.score)) bestShort = entry
  }
  // 短页面（正文 < 阈值）时，显式语义容器比整页回退更可信：<article> 是作者声明的正文区，
  // 整页回退会把导航/侧栏一起带进来。只有连语义容器都没有（0 字节）才回退 body。
  const chosenEntry = best ?? bestShort ?? null
  const fallbackSeg = cleaned.replace(/^[\s\S]*?<body\b[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')
  const strategy = chosenEntry ? (chosenEntry.kind === 'article' ? 'article' : chosenEntry.kind === 'main' ? 'main' : 'density') : 'body-fallback'
  const chosen = chosenEntry ? chosenEntry.inner : fallbackSeg
  const rendered = renderStructured(chosen)
  const text = rendered.slice(0, WEB_LIMITS.MAX_TEXT)
  const excerpt = text.replace(/\s+/g, ' ').slice(0, 240)
  const linksRaw = raw.replace(/<base\b[^>]*>/gi, ' ')
  const links = []
  const seen = new Set()
  for (const mm of linksRaw.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const abs = new URL(mm[2], finalUrl).href
      if ((abs.startsWith('http://') || abs.startsWith('https://')) && !seen.has(abs)) {
        seen.add(abs)
        links.push(abs)
        if (links.length >= WEB_LIMITS.MAX_LINKS) break
      }
    } catch { /* 忽略畸形链接 */ }
  }
  const quality = {
    strategy,
    score: chosenEntry ? Math.round(chosenEntry.score) : 0,
    chars: text.length,
    headings: chosenEntry?.headings ?? 0,
    paragraphs: chosenEntry?.paragraphs ?? 0,
    listItems: chosenEntry?.listItems ?? 0,
    linkDensity: chosenEntry ? Math.round(chosenEntry.linkDensity * 100) / 100 : 0,
    candidates: candidates.length,
    droppedBlocks: dropped,
    markdown: /(^|\n)#{1,6} |(^|\n)- |(^|\n)```/.test(text),
    truncated: rendered.length > text.length,
    // 采纳了「低于长度阈值」的语义容器：内容合法但偏短，界面据此提示（避免用户以为抽取失败）
    shortContent: !!chosenEntry && chosenEntry.chars < WEB_EXTRACT.MIN_CANDIDATE_CHARS,
  }
  return { title, text, excerpt, links, quality }
}

export function extractHtml(html, finalUrl) {
  const { title, text, excerpt, links } = extractReadable(html, finalUrl)
  return { title, text, excerpt, links }
}

/** v1 抽取实现（保留供对照/回归：extractHtml 现由 extractReadable 承担）。 */
export function extractHtmlLegacy(html, finalUrl) {
  const raw = String(html ?? '')
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''
  let body = raw
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  body = body.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  body = body.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
  body = body.replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
  body = body.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
  body = body.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
  body = body.replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
  body = body.replace(/<!--[\s\S]*?-->/g, ' ')
  body = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/blockquote)[^>]*>/gi, '\n')
  body = body.replace(/<[^>]+>/g, ' ')
  body = decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // 链接收集（绝对化 + 去重 + http(s) 白名单）
  const links = []
  const seen = new Set()
  for (const m of raw.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)) {
    const href = m[2]
    try {
      const abs = new URL(href, finalUrl).href
      if ((abs.startsWith('http://') || abs.startsWith('https://')) && !seen.has(abs)) {
        seen.add(abs)
        links.push(abs)
        if (links.length >= WEB_LIMITS.MAX_LINKS) break
      }
    } catch { /* 忽略畸形链接 */ }
  }
  const text = body.slice(0, WEB_LIMITS.MAX_TEXT)
  const excerpt = text.replace(/\s+/g, ' ').slice(0, 240)
  return { title, text, excerpt, links }
}

async function readBodyLimited(res, maxBytes, signal) {
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  // R-A4/J4-A：body 读取单一归类点——abort（含共享 deadline 与 body stall 触发）一律 timeout；
  // 判据用 ac.signal.aborted 状态而非错误 message（不随 undici 文案漂移，J4-B 排除）；附真实 status 供审计行。
  const failWith = (code, message) => {
    const e = webErr(code, message)
    if (res.status != null) e.status = res.status
    return e
  }
  for (;;) {
    if (signal?.aborted) { try { await reader.cancel() } catch { /* */ } throw failWith(WEB_ERR.TIMEOUT, '抓取超时（已取消请求）') }
    let done = false
    let value
    try {
      const r = await reader.read()
      done = r.done
      value = r.value
    } catch (e) {
      // body stall：headers 已回、body 挂起时被 abort → read() 拒绝 → 同码 timeout（修复前误归类 web_error/undefined）
      if (signal?.aborted) { try { await reader.cancel() } catch { /* */ } throw failWith(WEB_ERR.TIMEOUT, '抓取超时（已取消请求）') }
      throw failWith(WEB_ERR.FETCH_ERROR, '读取响应体失败：' + (e?.message ?? e))
    }
    if (done) break
    total += value.length
    if (total > maxBytes) { try { await reader.cancel() } catch { /* */ } throw failWith(WEB_ERR.TOO_LARGE, '响应体超过上限（当前上限 ' + maxBytes + ' 字节）') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * R-A4/J4-A 延续：body「尽力读」——只有 abort/body-stall 判定的 TIMEOUT（含 5xx/降级分支）必须继续上抛归类 timeout
 * （TC-S2-06 修复：此前 5xx 分支 .catch(() => Buffer.alloc(0)) 把 stall5xx 的 timeout 吞成 http_500）；
 * 其余读失败（非中止性读错误 / 超长截断）降级为空 Buffer——不影响已按状态码/内容类型决定的响应语义。
 */
async function readBodyBestEffort(res, maxBytes, signal) {
  try {
    return await readBodyLimited(res, maxBytes, signal)
  } catch (e) {
    if (e?.code === WEB_ERR.TIMEOUT) throw e
    return Buffer.alloc(0)
  }
}

/**
 * v1 fetch 代理核心：协议白名单 → SSRF 逐跳校验（含重定向链）→ 限长/超时 → 仅文本类响应进入抽取。
 * 返回结构化 JSON（无原始 HTML 透传字段，TC-S6-10）。
 * timeoutMs 为「整条链总超时」（P0-3 修复）：首跳据此算出绝对截止时间戳 deadline 并随重定向递归
 * 共享下传，每跳剩余预算 = deadlineTs - now（不再每跳重置计时）；超过 5 跳上限同样受总超时约束。
 * 错误码取 WEB_ERR 常量表（G-11）；body 读取/整链 abort 统一 timeout（R-A4/J4-A）；失败 throw 的 Error 附 .url/.status 供审计留痕定位失败一跳。
 */
export async function webFetch({ url: rawUrl, maxBytes = WEB_LIMITS.MAX_BYTES, timeoutMs = WEB_LIMITS.TIMEOUT_MS, redirects = 0, deadline = 0, conditional = null } = {}) {
  // 参数级失败（url 缺失/非字符串/空白）：请求体未构成一次抓取，抛错标记 paramLevel → HTTP 层不落审计（TC-S2-10）
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) { const e = webErr(WEB_ERR.INVALID_URL, '缺少参数 url'); e.paramLevel = true; throw e }
  const requestedUrl = rawUrl.trim()
  const mb = Number.isFinite(Number(maxBytes)) ? Math.max(1, Math.min(Number(maxBytes), 16 * 1024 * 1024)) : WEB_LIMITS.MAX_BYTES
  const tm = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.min(Number(timeoutMs), 60_000)) : WEB_LIMITS.TIMEOUT_MS
  try {
    // P0-3：共享整链 deadline（内部参数，仅重定向递归传递）；已过截止 → 立即判超时，绝不放行
    const deadlineTs = Number.isFinite(deadline) && deadline > 0 ? deadline : Date.now() + tm
    const remainMs = deadlineTs - Date.now()
    if (remainMs <= 0) throw webErr(WEB_ERR.TIMEOUT, '抓取超时（已取消请求）')
    let target
    // URL 无法解析同样属参数级失败（未发起抓取，TC-S2-10 含「解析失败」）：同标 paramLevel → HTTP 层不落审计
    try { target = new URL(requestedUrl) } catch { const e = webErr(WEB_ERR.INVALID_URL, 'URL 无法解析'); e.paramLevel = true; throw e }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw webErr(WEB_ERR.PROTOCOL_BLOCKED, '协议白名单：仅支持 http/https（收到 ' + target.protocol + '）')
    if (redirects > WEB_LIMITS.MAX_REDIRECTS) throw webErr(WEB_ERR.TOO_MANY_REDIRECTS, '重定向超过 ' + WEB_LIMITS.MAX_REDIRECTS + ' 跳，已停止')
    await assertPublicTarget(target)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('abort')), Math.min(tm, remainMs))
    try {
      let res
      try {
        // P2-8①：条件请求（缓存过期但存有校验器时带上，304 即复用缓存内容）
        const reqHeaders = { 'user-agent': 'legion-browser-assistant/1.0 (SSRF-guarded)', 'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }
        if (conditional && typeof conditional === 'object') {
          if (conditional.etag) reqHeaders['if-none-match'] = String(conditional.etag)
          if (conditional.lastModified) reqHeaders['if-modified-since'] = String(conditional.lastModified)
        }
        res = await fetch(target.href, { redirect: 'manual', signal: ac.signal, headers: reqHeaders })
      } catch (e) {
        if (ac.signal.aborted) throw webErr(WEB_ERR.TIMEOUT, '抓取超时（已取消请求）')
        throw webErr(WEB_ERR.FETCH_ERROR, '网络请求失败：' + (e?.message ?? e))
      }
      const status = res.status
      // P2-8①：304 未修改 → 调用方用缓存内容（不读体）
      if (status === 304) {
        await readBodyBestEffort(res, 0, ac.signal)
        return { ok: true, notModified: true, finalUrl: target.href, status, contentType: res.headers.get('content-type') ?? '', title: '', text: '', excerpt: '', links: [], bytes: 0, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }
      }
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location')
        if (loc) {
          const next = new URL(loc, target.href)
          if (next.protocol !== 'http:' && next.protocol !== 'https:') throw webErr(WEB_ERR.SSRF_BLOCKED, '重定向目标协议不在白名单（' + next.protocol + '）')
          clearTimeout(timer) // 本跳已完成：交给下一跳按共享 deadline 计时（避免外层空转定时器，P0-3）
          return webFetch({ url: next.href, maxBytes: mb, timeoutMs: tm, redirects: redirects + 1, deadline: deadlineTs, conditional })
        }
      }
      const ct = res.headers.get('content-type') ?? ''
      if (status >= 400) {
        // TC-S2-06：错误体读取经 best-effort——若此处 abort（stall5xx 的 timeoutMs 到点）→ TIMEOUT 上抛归类 timeout，不得吞成 http_<status>
        const errBuf = await readBodyBestEffort(res, Math.min(mb, 65536), ac.signal)
        const errText = decodeHtml(errBuf, ct).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        return { ok: false, finalUrl: target.href, status, contentType: ct, error: '上游返回 http_' + status + (errText ? '：' + errText : ''), code: 'http_' + status }
      }
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct)
      const isText = /^text\//i.test(ct) || /json|xml/i.test(ct)
      if (!isHtml && !isText) {
        // 非文本/HTML（pdf/zip/图片等）：不读体、明确降级
        const errBuf = await readBodyBestEffort(res, 0, ac.signal)
        return { ok: true, finalUrl: target.href, status, contentType: ct, title: '', text: '', excerpt: '', links: [], bytes: 0, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), error: '目标不是可读文本/HTML（' + ct.split(';')[0].trim() + '），已跳过正文抽取', code: WEB_ERR.UNSUPPORTED }
      }
      const buf = await readBodyLimited(res, mb, ac.signal)
      const html = decodeHtml(buf, ct)
      const { title, text, excerpt, links, quality } = extractReadable(html, target.href)
      const transfer = { bytes: buf.length, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }
      if (!title && !text) {
        return { ok: true, finalUrl: target.href, status, contentType: ct, title: '', text: '', excerpt: '', links, quality, ...transfer, error: '未能抽取正文：目标页可能是 SPA/纯 JS 渲染空壳（v1 服务端抓取为显式边界）', code: WEB_ERR.EMPTY_CONTENT }
      }
      return { ok: true, finalUrl: target.href, status, contentType: ct, title, text, excerpt, links, quality, ...transfer }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    // 审计辅助：失败统一标记「本跳请求 URL」（重定向递归由最深一跳先标，外层不覆盖）——审计行 finalUrl 可定位到失败一跳
    if (e instanceof Error && typeof e.url !== 'string') e.url = requestedUrl
    throw e
  }
}

// ── P2-8①：抓取缓存（进程内 TTL + ETag/Last-Modified 条件请求）──
//
// 语义：命中新鲜缓存 → 直接返回且 cached=true（不发起网络请求）；
// 过期但存有校验器 → 带 If-None-Match / If-Modified-Since 重新验证，304 则复用原结果并刷新 TTL（省流量、内容不变）；
// 其余情况正常抓取并覆盖缓存。缓存只在**同一 (url,maxBytes) 且抽取未截断**时复用——截断结果不缓存，
// 否则用户调大 maxBytes 后会一直拿到被截断的旧内容。
export const WEB_CACHE_DEFAULTS = Object.freeze({
  TTL_MS: envBytes('DSH_WEB_CACHE_TTL_MS', 5 * 60 * 1000),
  MAX_ENTRIES: envBytes('DSH_WEB_CACHE_MAX', 200),
})
const webCache = new Map() // key → { result, storedAt, etag, lastModified, validators }

/**
 * 缓存键 = 空间 + URL + maxBytes。
 * 为什么带空间：① 空间是抓取治理的单位（配额/历史都按空间），缓存若跨空间共享，
 * 别的空间命中缓存会**完全绕过配额**；② 抓取是用户可见行为，跨空间串内容会让「我刚抓的页面」
 * 显示成别人抓的旧版本。键含 maxBytes 的理由同前（上限不同 → 内容可能被截断不同）。
 */
function webCacheKey(scope, url, maxBytes) {
  return String(scope ?? '') + '\u0000' + url + '\u0000' + String(maxBytes)
}

export function webCacheStats() {
  return { entries: webCache.size, max: WEB_CACHE_DEFAULTS.MAX_ENTRIES, ttlMs: WEB_CACHE_DEFAULTS.TTL_MS }
}

/** 读取新鲜缓存（未过期）。返回 null 表示无可用缓存。 */
export function webCacheGet(scope, url, maxBytes, now = Date.now()) {
  const hit = webCache.get(webCacheKey(scope, url, maxBytes))
  if (!hit) return null
  if (now - hit.storedAt > WEB_CACHE_DEFAULTS.TTL_MS) return null
  return { ...hit.result, cached: true, cacheAgeMs: now - hit.storedAt }
}

/** 读取过期缓存（仅用于条件请求复用：内容仍在，但需与上游确认）。 */
export function webCacheGetStale(scope, url, maxBytes) {
  return webCache.get(webCacheKey(scope, url, maxBytes)) ?? null
}

export function webCachePut(scope, url, maxBytes, result, validators = {}, now = Date.now()) {
  if (!result || result.ok !== true) return
  if (result.quality?.truncated === true) return // 截断结果不入缓存（避免调大上限后仍拿旧截断内容）
  const key = webCacheKey(scope, url, maxBytes)
  if (webCache.size >= WEB_CACHE_DEFAULTS.MAX_ENTRIES && !webCache.has(key)) {
    // 满则淘汰最旧一条（LRU 近似：Map 插入序即时间序）
    const oldest = webCache.keys().next().value
    if (oldest !== undefined) webCache.delete(oldest)
  }
  webCache.set(key, { result, storedAt: now, etag: validators.etag ?? null, lastModified: validators.lastModified ?? null })
}

/** 复用过期缓存并刷新 TTL（304 路径）。 */
function webCacheTouch(scope, url, maxBytes, now = Date.now()) {
  const hit = webCache.get(webCacheKey(scope, url, maxBytes))
  if (!hit) return null
  hit.storedAt = now
  return { ...hit.result, cached: true, revalidated: true, cacheAgeMs: 0 }
}

export function webCacheClear() {
  const n = webCache.size
  webCache.clear()
  return n
}

// ── P2-8④：抓取限流与配额（空间 = scope，单站 = host）──
//
// 三档叠加：① 空间每分钟请求数 ② 空间在途并发 ③ 空间每日字节配额；另加 host 每分钟请求数（防单站风暴）。
// 全部按滑动/固定窗口内存计数，进程重启即清零（不改用 DB：配额是运行期保护，不是账目）。
// 超限抛 webErr(rate_limited / concurrency_limited / daily_quota_exceeded)，HTTP 层映射 429 + Retry-After。
export const WEB_QUOTA_DEFAULTS = Object.freeze({
  SPACE_RPM: envBytes('DSH_WEB_QUOTA_SPACE_RPM', 30),
  SPACE_CONCURRENCY: envBytes('DSH_WEB_QUOTA_CONCURRENCY', 3),
  HOST_RPM: envBytes('DSH_WEB_QUOTA_HOST_RPM', 30),
  DAILY_BYTES: envBytes('DSH_WEB_QUOTA_DAILY_BYTES', 200 * 1024 * 1024),
})
const MINUTE_MS = 60_000
const webQuotaBuckets = new Map() // key → { windowStart, count }
const webQuotaBytes = new Map() // `${dayKey}|${scope}` → bytes
const webQuotaInflight = new Map() // scope → n

const dayKeyOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

function bumpWindow(key, limit, now) {
  const b = webQuotaBuckets.get(key)
  if (!b || now - b.windowStart >= MINUTE_MS) {
    webQuotaBuckets.set(key, { windowStart: now, count: 1 })
    return { ok: true, remaining: limit - 1, resetInMs: MINUTE_MS }
  }
  if (b.count >= limit) {
    return { ok: false, remaining: 0, resetInMs: Math.max(1, MINUTE_MS - (now - b.windowStart)) }
  }
  b.count += 1
  return { ok: true, remaining: limit - b.count, resetInMs: Math.max(1, MINUTE_MS - (now - b.windowStart)) }
}

/**
 * 抓取准入检查（不记账字节，只记请求数/并发）：throw 时调用方会归类为 429 并带 Retry-After。
 * **scope 为空（命令行/脚本/运维/自测调用）时不限流**：配额是「按空间」的界面治理手段，
 * 未标注空间的调用只落审计；界面（BrowserView）每次都带 scope，因此正常使用始终受限流保护。
 */
export function webQuotaBegin(scope, host, now = Date.now()) {
  if (!scope) return { scope: '', host, unmanaged: true }
  {
    const inflight = webQuotaInflight.get(scope) ?? 0
    if (inflight >= WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY) {
      const e = webErr(WEB_ERR.CONCURRENCY_LIMITED, `空间「${scope}」同时进行的抓取已达上限（${WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY}），请稍后重试`)
      e.retryAfterSec = 2
      throw e
    }
    const space = bumpWindow('s:' + scope, WEB_QUOTA_DEFAULTS.SPACE_RPM, now)
    if (!space.ok) {
      const e = webErr(WEB_ERR.RATE_LIMITED, `空间「${scope}」每分钟抓取次数超限（${WEB_QUOTA_DEFAULTS.SPACE_RPM}/min）`)
      e.retryAfterSec = Math.ceil(space.resetInMs / 1000)
      throw e
    }
    const usedBytes = webQuotaBytes.get(dayKeyOf(now) + '|' + scope) ?? 0
    if (usedBytes >= WEB_QUOTA_DEFAULTS.DAILY_BYTES) {
      const e = webErr(WEB_ERR.DAILY_QUOTA_EXCEEDED, `空间「${scope}」今日抓取流量配额已用完（${Math.round(WEB_QUOTA_DEFAULTS.DAILY_BYTES / 1024 / 1024)} MB），明日重置`)
      e.retryAfterSec = 3600
      throw e
    }
    webQuotaInflight.set(scope, inflight + 1)
  }
  if (host) {
    const h = bumpWindow('h:' + host, WEB_QUOTA_DEFAULTS.HOST_RPM, now)
    if (!h.ok) {
      if (scope) webQuotaEnd(scope)
      const e = webErr(WEB_ERR.RATE_LIMITED, `目标站点「${host}」每分钟抓取次数超限（${WEB_QUOTA_DEFAULTS.HOST_RPM}/min），避免对单站高频请求`)
      e.retryAfterSec = Math.ceil(h.resetInMs / 1000)
      throw e
    }
  }
  return { scope, host }
}

/** 结束一次抓取：释放并发占位。无论成功失败都必须调用（否则并发额度会泄漏）。 */
export function webQuotaEnd(scope) {
  if (!scope) return
  const n = webQuotaInflight.get(scope) ?? 0
  if (n <= 1) webQuotaInflight.delete(scope)
  else webQuotaInflight.set(scope, n - 1)
}

/** 记账本次抓取的响应字节（只在成功读到 body 时计；失败不计）。 */
export function webQuotaRecordBytes(scope, bytes, now = Date.now()) {
  if (!scope || !Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return
  const key = dayKeyOf(now) + '|' + scope
  webQuotaBytes.set(key, (webQuotaBytes.get(key) ?? 0) + Number(bytes))
}

/** 配额快照（界面展示剩余额度；只读，不影响计数）。 */
export function webQuotaSnapshot(scope, now = Date.now()) {
  const space = webQuotaBuckets.get('s:' + scope)
  const usedToday = webQuotaBytes.get(dayKeyOf(now) + '|' + scope) ?? 0
  const rpmRemaining = !space || now - space.windowStart >= MINUTE_MS ? WEB_QUOTA_DEFAULTS.SPACE_RPM : Math.max(0, WEB_QUOTA_DEFAULTS.SPACE_RPM - space.count)
  return {
    scope,
    rpm: { limit: WEB_QUOTA_DEFAULTS.SPACE_RPM, remaining: rpmRemaining, resetInMs: space ? Math.max(0, MINUTE_MS - (now - space.windowStart)) : 0 },
    concurrency: { limit: WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY, inflight: webQuotaInflight.get(scope) ?? 0 },
    hostRpmLimit: WEB_QUOTA_DEFAULTS.HOST_RPM,
    dailyBytes: { limit: WEB_QUOTA_DEFAULTS.DAILY_BYTES, used: usedToday, remaining: Math.max(0, WEB_QUOTA_DEFAULTS.DAILY_BYTES - usedToday), day: dayKeyOf(now) },
  }
}

/** 测试/运维用：清空所有配额窗口与当日计数（返回清理的键数）。 */
export function webQuotaReset() {
  const n = webQuotaBuckets.size + webQuotaBytes.size + webQuotaInflight.size
  webQuotaBuckets.clear()
  webQuotaBytes.clear()
  webQuotaInflight.clear()
  return n
}

// ── P2-8③：可选截图（探测本机 Edge/Chrome headless；默认关闭）──
//
// 设计取舍：不引入 Playwright/Puppeteer（重依赖 + 下载浏览器）。改成「探测本机已装浏览器 → headless 截图」，
// 由开关 DSH_WEB_SHOT_ENABLE=1 显式启用（默认关闭：截图会真实启动一个浏览器进程，属较重的操作）；
// 未启用 / 未找到浏览器 / 启动失败都返回明确错误码与原因，绝不静默失败或假装成功。
export const WEB_SHOT_DEFAULTS = Object.freeze({
  WIDTH: 1280, HEIGHT: 900, TIMEOUT_MS: 30_000,
  MAX_BYTES: 8 * 1024 * 1024, // 单张 PNG 上限
})
function shotEnabled() {
  return process.env.DSH_WEB_SHOT_ENABLE === '1'
}
function shotRoot() {
  // 默认放 workbench/data/shots：① 不在静态根 dist/ 内（否则截图会被当成静态资源直接暴露，
  // 且 vite build 会清掉 dist）；② data/ 已在 workbench/.gitignore（与 web 审计同一约定）。
  return process.env.DSH_WEB_SHOT_DIR || join(ROOT, '..', 'data', 'shots')
}
function shotCandidates() {
  const fromEnv = process.env.DSH_WEB_SHOT_BROWSER
  // 显式指定即**互斥**：只认该路径（否则测试与运维无法确定实际被拉起的是哪个浏览器，
  // 也会在只想验证「未找到浏览器」分支时意外拉真浏览器）。
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return [fromEnv]
  const list = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  return list.filter(p => typeof p === 'string' && p.length > 0)
}

/** 探测可用浏览器路径（返回 null = 未找到）。探测结果不缓存：安装浏览器后无需重启服务。 */
export function findShotBrowser() {
  for (const p of shotCandidates()) {
    try { if (existsSync(p)) return p } catch { /* 忽略不可访问路径 */ }
  }
  return null
}

export function shotStatus() {
  const browser = findShotBrowser()
  return {
    enabled: shotEnabled(),
    available: browser !== null,
    browser: browser ? basename(browser) : null,
    dir: shotRoot(),
    hint: shotEnabled() ? (browser ? '' : '未找到 Edge/Chrome；可用 DSH_WEB_SHOT_BROWSER 指定可执行文件路径') : '截图默认关闭：以 DSH_WEB_SHOT_ENABLE=1 启动 serve.mjs 后可用',
  }
}

/**
 * 截图：先过协议与 SSRF 校验（与抓取同一套判据），再启动 headless 浏览器写 PNG。
 * 返回 { ok, file, bytes, browser, ms }；失败抛带 code 的错误（由 HTTP 层映射）。
 */
export async function webScreenshot({ url: rawUrl, scope = '', width = WEB_SHOT_DEFAULTS.WIDTH, height = WEB_SHOT_DEFAULTS.HEIGHT } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) { const e = webErr(WEB_ERR.INVALID_URL, '缺少参数 url'); e.paramLevel = true; throw e }
  if (!shotEnabled()) {
    const e = webErr(WEB_ERR.SHOT_DISABLED, '截图能力未启用（以 DSH_WEB_SHOT_ENABLE=1 启动 serve.mjs）')
    e.paramLevel = true
    throw e
  }
  const browser = findShotBrowser()
  if (!browser) {
    const e = webErr(WEB_ERR.SHOT_UNAVAILABLE, '未找到可用的 Edge/Chrome（可用 DSH_WEB_SHOT_BROWSER 指定路径）')
    e.paramLevel = true
    throw e
  }
  let target
  try { target = new URL(rawUrl.trim()) } catch { const e = webErr(WEB_ERR.INVALID_URL, 'URL 无法解析'); e.paramLevel = true; throw e }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw webErr(WEB_ERR.PROTOCOL_BLOCKED, '协议白名单：仅支持 http/https（收到 ' + target.protocol + '）')
  await assertPublicTarget(target)
  const w = Number.isFinite(Number(width)) ? Math.max(320, Math.min(Number(width), 3840)) : WEB_SHOT_DEFAULTS.WIDTH
  const h = Number.isFinite(Number(height)) ? Math.max(240, Math.min(Number(height), 2160)) : WEB_SHOT_DEFAULTS.HEIGHT
  const dir = join(shotRoot(), scope || 'default')
  mkdirSync(dir, { recursive: true })
  const name = 'shot_' + createHash('sha1').update(target.href + '\u0000' + w + 'x' + h).digest('hex').slice(0, 16) + '.png'
  const file = join(dir, name)
  const t0 = Date.now()
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--virtual-time-budget=8000',
    `--window-size=${w},${h}`, `--screenshot=${file}`, target.href,
  ]
  // 注入接缝：DSH_WEB_SHOT_BROWSER 指向 .js/.mjs 时用当前 node 执行（测试与自定义渲染器用），
  // 避免在 Windows 上用 shell 调 .cmd（会引入参数注入风险）。
  const isScript = /\.(mjs|js|cjs)$/i.test(browser)
  const exe = isScript ? process.execPath : browser
  const argv = isScript ? [browser, ...args] : args
  try {
    execFileSync(exe, argv, { timeout: WEB_SHOT_DEFAULTS.TIMEOUT_MS, stdio: 'ignore', windowsHide: true })
  } catch (e) {
    // 浏览器可能已写出文件却以非 0 退出（Edge/Chrome 常见）——只要文件有效就算成功，否则才算失败
    if (!existsSync(file)) throw webErr(WEB_ERR.SHOT_FAILED, '截图进程失败：' + (e?.message ?? e))
  }
  if (!existsSync(file)) throw webErr(WEB_ERR.SHOT_FAILED, '截图进程未产出文件（目标页可能需要更长时间或被浏览器拦截）')
  const size = statSync(file).size
  if (size <= 0) { try { rmSync(file, { force: true }) } catch { /* */ } throw webErr(WEB_ERR.SHOT_FAILED, '截图文件为空') }
  if (size > WEB_SHOT_DEFAULTS.MAX_BYTES) {
    try { rmSync(file, { force: true }) } catch { /* */ }
    throw webErr(WEB_ERR.TOO_LARGE, `截图超过上限（${Math.round(WEB_SHOT_DEFAULTS.MAX_BYTES / 1024 / 1024)} MB）`)
  }
  webQuotaRecordBytes(scope, size)
  return { ok: true, file: name, scope: scope || 'default', bytes: size, browser: basename(browser), width: w, height: h, ms: Date.now() - t0 }
}

/** 读取已存截图（仅限截图目录内、仅 .png；防目录穿越）。 */
export function readShot(scope, name) {
  const safeScope = String(scope || 'default').replace(/[^A-Za-z0-9._-]/g, '')
  const safeName = basename(String(name ?? ''))
  if (!/^shot_[0-9a-f]{8,32}\.png$/.test(safeName)) throw webErr(WEB_ERR.INVALID_URL, '非法的截图名')
  const file = join(shotRoot(), safeScope, safeName)
  if (!existsSync(file)) throw webErr(WEB_ERR.INVALID_URL, '截图不存在（可能已被清理）')
  return { file, bytes: statSync(file).size, contentType: 'image/png' }
}

/** 截图目录清单（前端展示历史截图；只列本空间）。 */
export function listShots(scope, limit = 30) {
  const safeScope = String(scope || 'default').replace(/[^A-Za-z0-9._-]/g, '')
  const dir = join(shotRoot(), safeScope)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(n => /^shot_[0-9a-f]{8,32}\.png$/.test(n))
      .map(n => ({ name: n, bytes: statSync(join(dir, n)).size, mtime: statSync(join(dir, n)).mtime.toISOString() }))
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, Math.max(1, Math.min(Number(limit) || 30, 200)))
  } catch { return [] }
}

// ── P2-8①：抓取历史回写（serve.mjs → team-hub；失败只 console，绝不影响抓取响应）──
function recordWebHistory(entry) {
  const scope = String(entry?.scope ?? '').trim()
  if (!scope) return
  const upstream = (process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', ...hubAuthHeaders() }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 3000)
  fetch(upstream + '/api/web/history', { method: 'POST', headers, body: JSON.stringify(entry), signal: ac.signal })
    .catch((e) => { console.log('[web-history] 回写失败（不影响抓取）：' + (e?.message ?? e)) })
    .finally(() => clearTimeout(timer))
}

async function handleWebApi(req, res, pathname, url) {
  if (!isLoopback(req)) { httpErr(res, 403, '浏览器助手接口仅限本机（127.0.0.1）访问'); return }

  // GET /api/web/meta（P2-8①③④）：配额快照 + 截图能力状态 + 缓存规模；不触发抓取。
  if (pathname === '/api/web/meta') {
    if (req.method !== 'GET') { httpErr(res, 405, 'method not allowed'); return }
    const scope = url.searchParams.get('scope') ?? ''
    sendJson(res, 200, { ok: true, quota: scope ? webQuotaSnapshot(scope) : null, shot: shotStatus(), cache: webCacheStats() })
    return
  }
  // GET /api/web/history（P2-8①）：按空间读抓取历史（serve.mjs 代理 team-hub；hub 不在则如实说明）
  if (pathname === '/api/web/history' && req.method === 'GET') {
    const scope = url.searchParams.get('scope') ?? ''
    if (!scope) { sendJson(res, 200, { ok: false, scope: '', items: [], stats: null, error: '缺少 scope 参数' }); return }
    const qs = new URLSearchParams({ scope, limit: url.searchParams.get('limit') ?? '30' })
    const q = url.searchParams.get('q')
    if (q) qs.set('q', q)
    const upstream = (process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 4000)
      const resp = await fetch(upstream + '/api/web/history?' + qs.toString(), { headers: { ...hubAuthHeaders() }, signal: ac.signal })
        .finally(() => clearTimeout(timer))
      const data = await resp.json()
      sendJson(res, 200, { ok: resp.ok, scope, ...data })
    } catch (e) {
      // hub 未运行是常态（单跑 serve.mjs）：如实报不可用，不假装空历史
      sendJson(res, 200, { ok: false, scope, items: [], stats: null, error: '抓取历史需要 team-hub v2（读 /api/web/history）：' + (e?.message ?? e) })
    }
    return
  }
  // POST /api/web/history/clear（P2-8①）：清空本空间历史（或单条）
  if (pathname === '/api/web/history/clear' && req.method === 'POST') {
    let body
    try { body = await readBodyJson(req) } catch (e) { httpErr(res, 400, e instanceof Error ? e.message : String(e)); return }
    const scope = typeof body?.scope === 'string' ? body.scope.trim() : ''
    if (!scope) { httpErr(res, 400, '缺少参数 scope'); return }
    const upstream = (process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 4000)
      const resp = await fetch(upstream + '/api/web/history/clear', {
        method: 'POST', headers: { 'content-type': 'application/json', ...hubAuthHeaders() },
        body: JSON.stringify(body), signal: ac.signal,
      }).finally(() => clearTimeout(timer))
      const data = await resp.json()
      sendJson(res, resp.status, data)
    } catch (e) {
      httpErr(res, 503, '清空抓取历史需要 team-hub v2：' + (e?.message ?? e))
    }
    return
  }
  // POST /api/web/shot（P2-8③）：可选截图（需 DSH_WEB_SHOT_ENABLE=1）
  if (pathname === '/api/web/shot' && req.method === 'POST') {
    let shotBody
    try { shotBody = await readBodyJson(req) } catch (e) { httpErr(res, 400, e instanceof Error ? e.message : String(e)); return }
    const scope = typeof shotBody?.scope === 'string' ? shotBody.scope.trim() : ''
    const t0 = Date.now()
    try {
      const shot = await webScreenshot({ url: shotBody?.url, scope, width: shotBody?.width, height: shotBody?.height })
      appendWebAudit({ url: String(shotBody?.url ?? ''), finalUrl: String(shotBody?.url ?? ''), status: 200, ok: true, code: 'shot_ok', ms: Date.now() - t0, scope, kind: 'shot' })
      sendJson(res, 200, shot)
    } catch (e) {
      const code = e?.code ?? WEB_ERR.SHOT_FAILED
      appendWebAudit({ url: String(shotBody?.url ?? ''), finalUrl: String(shotBody?.url ?? ''), status: null, ok: false, code, ms: Date.now() - t0, scope, kind: 'shot' })
      const status = code === WEB_ERR.SHOT_DISABLED || code === WEB_ERR.SHOT_UNAVAILABLE ? 409
        : code === WEB_ERR.SSRF_BLOCKED ? 403 : code === WEB_ERR.TOO_LARGE ? 413 : 400
      httpErr(res, status, e?.message ?? String(e))
    }
    return
  }
  // GET /api/web/shot?scope=&name=（P2-8③）：读取已存截图（仅截图目录内 .png）
  if (pathname === '/api/web/shot' && req.method === 'GET') {
    try {
      const s = readShot(url.searchParams.get('scope') ?? 'default', url.searchParams.get('name') ?? '')
      const stream = createReadStream(s.file)
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(s.bytes), 'cache-control': 'private, max-age=60' })
      stream.pipe(res)
    } catch (e) {
      httpErr(res, 404, e?.message ?? '截图不存在')
    }
    return
  }
  if (pathname === '/api/web/shots' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, items: listShots(url.searchParams.get('scope') ?? 'default', Number(url.searchParams.get('limit') ?? 30)) })
    return
  }
  if (pathname !== '/api/web/fetch') { httpErr(res, 404, '未知的浏览器助手接口：' + pathname); return }

  let body
  try { body = await readBodyJson(req) } catch (e) { httpErr(res, 400, e instanceof Error ? e.message : String(e)); return }
  // R-A3：一次 /api/web/fetch = 一行审计（成功/失败/拦截都算）；ms 全程计时；审计写失败只 console、不影响响应。
  // TC-S2-10：参数级失败（url 缺失/非字符串/空白 → code=invalid_url，webFetch 抛 err.paramLevel）未发起实际抓取 → 不落审计行；
  // 与 TC-S2-02「发起后拦截须留痕」（ssrf_blocked 等，非法抓取意图也是审计对象）分界在「请求是否构成一次抓取」。
  const t0 = Date.now()
  const requested = typeof body?.url === 'string' ? body.url.trim() : ''
  const scope = typeof body?.scope === 'string' ? body.scope.trim() : ''
  const maxBytesNorm = Number.isFinite(Number(body?.maxBytes)) ? Math.max(1, Math.min(Number(body.maxBytes), 16 * 1024 * 1024)) : WEB_LIMITS.MAX_BYTES
  let result = null
  let failure = null
  let hitFresh = false
  let admitted = false
  let reqHost = ''
  try { reqHost = requested ? new URL(requested).host : '' } catch { reqHost = '' }
  try {
    // ①-1 新鲜缓存：不发网络请求（因此不消耗配额）；按空间隔离，避免跨空间串内容或绕过配额
    if (requested && scope) {
      const fresh = webCacheGet(scope, requested, maxBytesNorm)
      if (fresh) { result = fresh; hitFresh = true }
    }
    if (!result) {
      // ④ 配额准入（请求数 + 并发 + 当日字节）；未标注 scope 时仅做 host 级保护
      webQuotaBegin(scope, reqHost)
      admitted = true
      const stale = requested && scope ? webCacheGetStale(scope, requested, maxBytesNorm) : null
      const conditional = stale && (stale.etag || stale.lastModified) ? { etag: stale.etag, lastModified: stale.lastModified } : null
      const fetched = await webFetch({ url: body.url, maxBytes: body.maxBytes, timeoutMs: body.timeoutMs, conditional })
      if (fetched.notModified === true && stale) {
        // ①-2 304：上游确认未变 → 复用缓存内容并刷新 TTL
        result = webCacheTouch(scope, requested, maxBytesNorm) ?? { ...stale.result, cached: true, revalidated: true }
      } else {
        result = fetched
        // ①-3 写缓存（截断结果内部会拒绝）；校验器来自响应头
        if (requested && scope) webCachePut(scope, requested, maxBytesNorm, result, { etag: result.etag, lastModified: result.lastModified })
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e))
    if (failure.paramLevel === true) {
      sendJson(res, 200, { ok: false, error: failure.message, code: failure.code ?? WEB_ERR.WEB_ERROR })
      return
    }
  } finally {
    if (admitted) webQuotaEnd(scope)
  }
  // ④ 响应字节记账（仅成功读到体的抓取；缓存命中与 304 不重复计费）
  if (result && !hitFresh && result.notModified !== true) webQuotaRecordBytes(scope, result.bytes)
  const code = result ? (result.code ?? (result.ok === true ? WEB_ERR.OK : WEB_ERR.WEB_ERROR)) : (failure.code ?? WEB_ERR.WEB_ERROR)
  appendWebAudit({
    url: requested,
    finalUrl: result ? (result.finalUrl ?? requested) : (failure.url ?? requested), // throw 路径 err.url = 失败一跳
    status: result ? (result.status ?? null) : (failure.status ?? null),
    ok: result ? result.ok === true : false,
    code,
    ms: Date.now() - t0,
    scope: scope || undefined,
    cached: hitFresh || result?.revalidated === true ? true : undefined,
  })
  // ①-4 历史回写（fire-and-forget；hub 不在只 console）
  recordWebHistory({
    scope,
    url: requested,
    finalUrl: result ? (result.finalUrl ?? requested) : (failure.url ?? requested),
    title: result?.title ?? null,
    excerpt: result?.excerpt ?? null,
    status: result ? (result.status ?? null) : (failure.status ?? null),
    bytes: result?.bytes ?? null,
    ms: Date.now() - t0,
    errorCode: result && result.ok === true && !result.error ? null : code,
    cached: hitFresh || result?.revalidated === true,
  })
  if (result) {
    sendJson(res, 200, { ...result, cached: hitFresh || result.cached === true })
    return
  }
  // ④ 限流/配额失败 → 429 + Retry-After（其余失败沿用 200 + code 语义，保持既有前端契约）
  const rateCodes = [WEB_ERR.RATE_LIMITED, WEB_ERR.CONCURRENCY_LIMITED, WEB_ERR.DAILY_QUOTA_EXCEEDED]
  if (rateCodes.includes(code)) {
    const retryAfter = Number(failure.retryAfterSec) || 5
    // 响应体带 code：前端需区分「速率限制 / 并发占满 / 当日配额用尽」三种可行动指引
    sendJson(res, 429, { ok: false, error: failure.message, code, retryAfterSec: retryAfter }, { 'retry-after': String(retryAfter), 'x-dsh-retry-after': String(retryAfter) })
    return
  }
  sendJson(res, 200, { ok: false, error: failure.message, code: failure.code ?? WEB_ERR.WEB_ERROR })
}

// ── /api/files/* 路由（S3 只读 + S4 写；仅回环；写需 token；错误码分类见各函数注释）──
function httpErr(res, code, message, extraHeaders = {}) {
  // 客户端断连（上传中断等）后写响应会触发 res error——吞掉避免未处理 error 崩溃；响应已结束则静默
  if (res.destroyed || res.writableEnded) { try { res.destroy() } catch { /* */ } return }
  res.on('error', () => { /* 断连写错误：忽略 */ })
  try { sendJson(res, code, { error: message }, extraHeaders) } catch { try { res.destroy() } catch { /* */ } }
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
  if (msg.includes('越界') || msg.includes('.git') || msg.includes('仅限本机') || msg.includes('符号链接') || msg.includes(UPLOAD_SESSION_DIR)) return 403
  if (msg.includes('overwrite=1') || msg.includes('目标已存在，不能覆盖') || msg.includes('目标已存在：如需覆盖')) return 409
  if (msg.includes('上传超过上限')) return 413
  return 400
}

// ───────────────────────── 技能安装（技能仓库：本地目录 / GitHub tarball → 候选 → 导入）─────────────────────────
const SKILL_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024 // GitHub 归档下载上限

/** team-hub 上游（同 registerSkillViaHub 的解析）。 */
function hubUpstream() {
  return (process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
}

function hubAuthHeaders() {
  const token = String(process.env.TEAM_HUB_TOKEN ?? '')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 拉取某空间的团队技能来源（github url + 分支）。 */
async function fetchSkillSourceFromHub(scope) {
  const resp = await fetch(`${hubUpstream()}/api/skill-source?scope=${encodeURIComponent(scope)}`, { headers: hubAuthHeaders() })
  const data = await resp.json().catch(() => null)
  return data?.source ?? { url: '', branch: '' }
}

/** 拉取某空间的既有技能（全部状态，含待审/被拒），按 id 索引。 */
async function fetchExistingSkills(scope) {
  const resp = await fetch(`${hubUpstream()}/api/skills?scope=${encodeURIComponent(scope)}&include=pending`, { headers: hubAuthHeaders() })
  const data = await resp.json().catch(() => null)
  const arr = Array.isArray(data) ? data : []
  const map = new Map()
  for (const s of arr) if (s && typeof s.id === 'string') map.set(s.id, s)
  return map
}

/** 下载 GitHub codeload 归档到 cacheDir 并解包，返回解包后的根目录。 */
async function downloadGithubArchive(url, cacheDir) {
  mkdirSync(cacheDir, { recursive: true })
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`GitHub 归档下载失败（HTTP ${resp.status}）`)
  const len = Number(resp.headers.get('content-length') ?? 0)
  if (Number.isFinite(len) && len > SKILL_ARCHIVE_MAX_BYTES) throw new Error('GitHub 归档过大，已拒绝下载')
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > SKILL_ARCHIVE_MAX_BYTES) throw new Error('GitHub 归档超过下载上限，已拒绝')
  const tarball = join(cacheDir, 'repo.tar.gz')
  writeFileSync(tarball, buf)
  // 解包（Windows 10+ 自带 bsdtar；失败抛可读错误，不破坏工作区）
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', cacheDir])
  } catch {
    throw new Error('归档解包失败：需要系统 tar（Windows 10+ 自带；Linux 需 tar）')
  }
  unlinkSync(tarball)
  return findArchiveRoot(cacheDir)
}

/** codeload 归档解包后通常是一个 `<owner>-<repo>-<branch>` 顶层文件夹；取其唯一子目录。 */
function findArchiveRoot(cacheDir) {
  const names = readdirSync(cacheDir).filter(n => !n.startsWith('.'))
  if (names.length === 1) {
    const p = join(cacheDir, names[0])
    if (statSync(p).isDirectory()) return p
  }
  return cacheDir
}

/** 把候选 bundle 注册到 team-hub（pending 待复审）。 */
async function registerSkillViaHub(scope, c) {
  const body = {
    id: c.id, name: c.name, scope,
    description: c.description ?? '',
    main: c.main ?? '', config: c.config ?? '',
    scripts: (c.scripts ?? []).map(s => ({ name: s.name, content: s.content })),
    cases: (c.cases ?? []).map(s => ({ name: s.name, content: s.content })),
    prompt: c.main ?? '', by: 'general',
  }
  const resp = await fetch(hubUpstream() + '/api/skills/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...hubAuthHeaders() }, body: JSON.stringify(body) })
  const data = await resp.json().catch(() => null)
  return { ok: resp.ok, status: resp.status, error: resp.ok ? undefined : (data?.error ?? `HTTP ${resp.status}`), skill: data }
}

/** 技能安装 API（仅回环）：scan-dir（扫本地目录）、scan-github（拉归档到受控缓存再扫）、import（注册到中枢为待审）。 */
async function handleSkillsApi(req, res, pathname, url) {
  if (!isLoopback(req)) {
    httpErr(res, 403, '技能安装接口仅限本机（127.0.0.1）访问')
    return
  }
  try {
    if (req.method !== 'POST') {
      httpErr(res, 405, '技能安装接口仅支持 POST')
      return
    }
    requireWriteToken(req)
    const body = await readBodyJson(req)
    const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
    if (!scope) throw new Error('缺少参数 scope')

    if (pathname === '/api/skills/scan-dir') {
      const root = await resolveScopeLocalDir(scope)
      const rel = typeof body.path === 'string' ? body.path.trim() : ''
      const abs = resolveInsideRoot(root, rel) // rel=''/'.' → 根；否则根内子目录（越界/.git 自拒）
      sendJson(res, 200, { ok: true, candidates: scanSkillDirs(abs) })
      return
    }

    if (pathname === '/api/skills/scan-github') {
      const root = await resolveScopeLocalDir(scope)
      const tarUrl = buildGithubTarballUrl(body.url) // 仅放行 GitHub 官方域名（buildGithubTarballUrl 内校验）
      const cacheDir = join(root, '.skills-cache')
      const slug = sanitizeSkillId(basename(new URL(tarUrl).pathname.replace(/\/$/, '')) || 'repo')
      const dest = join(cacheDir, slug)
      const extracted = await downloadGithubArchive(tarUrl, dest)
      sendJson(res, 200, { ok: true, candidates: scanSkillDirs(extracted), archiveDir: dest })
      return
    }

    if (pathname === '/api/skills/import') {
      const items = Array.isArray(body.candidates) ? body.candidates : []
      if (items.length === 0) throw new Error('缺少参数 candidates')
      const results = []
      for (const c of items) {
        const r = await registerSkillViaHub(scope, c)
        results.push({ id: c.id, ok: r.ok, error: r.error, version: r.skill?.version })
      }
      sendJson(res, 200, { ok: true, results })
      return
    }

    if (pathname === '/api/skills/sync') {
      const root = await resolveScopeLocalDir(scope)
      const bodyUrl = typeof body.url === 'string' ? body.url.trim() : ''
      const bodyBranch = typeof body.branch === 'string' ? body.branch.trim() : ''
      const strategy = body.strategy === 'skip' ? 'skip' : 'upgrade'
      let url = bodyUrl
      let branch = bodyBranch
      if (!url) {
        const saved = await fetchSkillSourceFromHub(scope)
        url = saved.url || ''
        if (!branch) branch = saved.branch || ''
      }
      if (!url) throw new Error('未配置技能来源：请先填写 GitHub 仓库地址（或先绑定团队技能仓库）')
      const tarUrl = buildGithubTarballUrl(url, branch || undefined)
      const cacheDir = join(root, '.skills-cache')
      const slug = sanitizeSkillId(basename(new URL(tarUrl).pathname.replace(/\/$/, '')) || 'repo')
      const dest = join(cacheDir, slug)
      const extracted = await downloadGithubArchive(tarUrl, dest)
      const candidates = scanSkillDirs(extracted)
      const existing = await fetchExistingSkills(scope)
      const report = { added: [], updated: [], unchanged: [], skipped: [], foreign: [] }
      for (const c of candidates) {
        const ex = existing.get(c.id)
        if (!ex) {
          const r = await registerSkillViaHub(scope, c)
          report.added.push({ id: c.id, name: c.name, version: r.ok ? r.skill?.version : undefined, error: r.error })
        } else if (ex.scope !== scope) {
          report.foreign.push({ id: c.id, name: c.name, scope: ex.scope }) // 他空间已有同名技能，避免越权覆盖
        } else if (strategy === 'skip') {
          report.skipped.push({ id: c.id, name: c.name, version: ex.version })
        } else {
          const r = await registerSkillViaHub(scope, c) // 幂等：同内容不 bump
          if (r.ok && ex.contentHash !== r.skill?.contentHash) report.updated.push({ id: c.id, name: c.name, fromVersion: ex.version, toVersion: r.skill?.version })
          else if (r.ok) report.unchanged.push({ id: c.id, name: c.name, version: ex.version })
          else report.skipped.push({ id: c.id, name: c.name, error: r.error })
        }
      }
      // 持久化来源（仅当本次显式给出 url；否则保留已存来源）。
      let source = await fetchSkillSourceFromHub(scope)
      if (bodyUrl) {
        await fetch(`${hubUpstream()}/api/skill-source`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...hubAuthHeaders() },
          body: JSON.stringify({ scope, url: bodyUrl, branch: branch || '', by: 'general' }),
        })
        source = { scope, url: bodyUrl, branch: branch || '' }
      }
      sendJson(res, 200, { ok: true, strategy, candidates: candidates.length, report, source })
      return
    }

    httpErr(res, 404, `not found: ${pathname}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('token 无效')) { httpErr(res, 401, msg); return }
    const forbidden = msg.includes('越界') || msg.includes('.git') || msg.includes('仅限') || msg.includes('仅允许') || msg.includes('官方域名') || msg.includes('https')
    httpErr(res, forbidden ? 403 : 400, msg)
  }
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
      || pathname === '/api/files/upload/init' || pathname === '/api/files/upload/chunk' || pathname === '/api/files/upload/complete' || pathname === '/api/files/upload/abort'
      || pathname === '/api/files/batch'
    if (isWrite) requireWriteToken(req)
    // POST body 可带 scope（与 query 二选一，body 优先），POST 分支内再按 body scope 懒解析；GET/PUT 用 query scope
    const root = method === 'POST' ? null : await resolveScopeLocalDir(scopeQuery)

    if (method === 'GET' && pathname === '/api/files/list') {
      const rel = url.searchParams.get('path') ?? ''
      sendJson(res, 200, { ok: true, ...listDirEntries(root, rel) })
      return
    }
    // P2-7 ③：文件名搜索（只读；scope 必填，recursive/q/limit 可选）
    if (method === 'GET' && pathname === '/api/files/search') {
      const rel = url.searchParams.get('path') ?? ''
      const q = url.searchParams.get('q') ?? ''
      const recursive = url.searchParams.get('recursive') === '1'
      const limit = Number(url.searchParams.get('limit') ?? 500)
      sendJson(res, 200, { ok: true, ...searchFiles(root, rel, q, { recursive, maxResults: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500 }) })
      return
    }
    // P2-7 ④：git 只读（status / diff / log）——绝不写仓库
    if (method === 'GET' && pathname === '/api/files/git/status') {
      const rel = url.searchParams.get('path') ?? ''
      sendJson(res, 200, { ok: true, ...gitStatus(root, rel) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/git/diff') {
      const rel = url.searchParams.get('path') ?? ''
      const staged = url.searchParams.get('staged') === '1'
      sendJson(res, 200, { ok: true, ...gitDiff(root, rel, { staged }) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/git/log') {
      const rel = url.searchParams.get('path') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? 20)
      sendJson(res, 200, { ok: true, ...gitLog(root, rel, limit) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/read') {
      const rel = url.searchParams.get('path') ?? ''
      sendJson(res, 200, { ok: true, ...previewTextFile(root, rel) })
      return
    }
    if (method === 'GET' && pathname === '/api/files/download') {
      const rel = url.searchParams.get('path') ?? ''
      // P0-2 修复：流式下载（createReadStream.pipe），不再整文件同步读入内存阻塞事件循环；带 Content-Length 便于进度展示
      const { name, length, stream } = openDownloadStream(root, rel)
      const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
      const safeName = encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(length),
        'content-disposition': `attachment; filename*=UTF-8''${safeName}`,
      })
      stream.on('error', (e) => {
        if (!res.headersSent) httpErr(res, e?.code === 'ENOENT' ? 404 : 500, '下载失败：' + (e?.message ?? e))
        else { try { res.destroy() } catch { /* */ } } // 头已发出：只能中断连接（res error 已在 routeRequest 顶部吞掉）
      })
      res.on('close', () => stream.destroy()) // 客户端断连 → 停止读文件（unpipe），避免继续消费磁盘 IO
      stream.pipe(res)
      return
    }
    if (method === 'PUT' && pathname === '/api/files/upload') {
      const rel = url.searchParams.get('path') ?? ''
      // P2-7 ①：strategy 为权威参数；overwrite=1 保留为向后兼容别名
      const { strategy } = normalizeUploadStrategy(url.searchParams.get('strategy') ?? (url.searchParams.get('overwrite') === '1' ? 'overwrite' : undefined))
      const declared = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(declared) && declared > FILES_LIMITS.MAX_UPLOAD) {
        // R-A2（T-077）预检拒绝的连接处理：客户端声明的体可能根本不会到达（只声明不发/半开）。
        // 若响应后 keep-alive 复用，服务端仍停在「等剩余体」态——同连接下一个请求会被误读为体字节，
        // 挂起约 6s 后连接被重置（S4 预检 413 → 同连接后续 raw 请求 ECONNRESET，实测实证）。
        // 响应带 Connection: close：该连接不再复用，后续请求落到新连接，行为正常；已到达字节排空防 RST 竞态。
        req.resume() // 排空已到达的请求体字节
        httpErr(res, 413, '上传超过上限 ' + FILES_LIMITS.MAX_UPLOAD + ' 字节', { connection: 'close' })
        return
      }
      const abs = resolveInsideRootForWrite(root, rel)
      const parent = dirname(abs)
      if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('目标目录不存在：' + dirname(String(rel ?? '')))
      if (existsSync(abs)) {
        // P2-7 ①：skip 直接返回（排空请求体，保持连接可复用）；其余策略交 receiveUploadBody 统一决策
        const pre = resolveUploadConflict(abs, strategy)
        if (pre.skipped) {
          req.resume()
          const st = statSync(abs)
          sendJson(res, 200, { ok: true, skipped: true, file: { name: basename(abs), size: st.size, mtime: entryMtime(st.mtimeMs) }, strategy })
          return
        }
      }
      // P0-1 修复：流式收体到同目录临时文件，完整收体 + 不超限后原子改名发布；
      // 覆盖/中断/超限不再破坏原文件、不留半写目标（receiveUploadBody，TC-S4-02/15/16）
      let out = null
      try {
        out = await receiveUploadBody(req, abs, { maxBytes: FILES_LIMITS.MAX_UPLOAD, strategy })
      } catch (e) {
        // R-A2（T-077）：请求体未完整到达即失败（流式超限/中断/写错）→ 连接处于「仍等体」错位态，不能安全复用；
        // 显式 Connection: close 弃用（否则同连接下一请求被误读为体字节 → 挂起/被 RST）。体已收全则走通用错误路径。
        if (!req.complete) { httpErr(res, classifyFilesError(e), e instanceof Error ? e.message : String(e), { connection: 'close' }); return }
        throw e
      }
      // rename 策略下实际落盘名可能已变（竞态二次决策），响应回传 finalName 供前端提示
      const finalAbs = out.abs
      const st = statSync(finalAbs)
      sendJson(res, 200, { ok: true, skipped: false, strategy, file: { name: basename(finalAbs), size: st.size, mtime: entryMtime(st.mtimeMs) }, requestedName: out.requestedName })
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
    // P2-7 ③：批量操作（delete/move，逐项报告；单项失败不影响其余项）
    if (method === 'POST' && pathname === '/api/files/batch') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      sendJson(res, 200, { ok: true, ...batchFileOp(await resolveScopeLocalDir(scope), body) })
      return
    }
    // P2-7 ②：分片上传会话（init 需要 scope；chunk/complete/abort 由 uploadId 定位，无需 scope）
    if (method === 'POST' && pathname === '/api/files/upload/init') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      sendJson(res, 200, { ok: true, ...initChunkedUpload(await resolveScopeLocalDir(scope), { path: body.path, size: body.size, strategy: body.strategy }) })
      return
    }
    if (method === 'PUT' && pathname === '/api/files/upload/chunk') {
      const uploadId = url.searchParams.get('uploadId') ?? ''
      const offsetRaw = url.searchParams.get('offset')
      if (offsetRaw === null || offsetRaw === '') throw new Error('缺少参数 offset')
      const target = await resolveScopeLocalDir(scopeQuery)
      try {
        const buf = await readBodyBuffer(req, UPLOAD_CHUNK_SIZE + 1024)
        const out = appendUploadChunk(target, uploadId, offsetRaw, buf)
        sendJson(res, 200, { ok: true, uploadId, received: out.received, size: out.size })
      } catch (e) {
        // 偏移不匹配：回传服务端 received 让前端从该处续传（409 而非 400——请求本身合法但状态冲突）
        if (e?.code === 'OFFSET_MISMATCH') { sendJson(res, 409, { ok: false, error: e.message, received: e.received }); return }
        throw e
      }
      return
    }
    if (method === 'POST' && pathname === '/api/files/upload/complete') {
      const body = await readBodyJson(req)
      const scope = typeof body.scope === 'string' && body.scope.trim().length > 0 ? body.scope.trim() : scopeQuery
      const target = await resolveScopeLocalDir(scope)
      try {
        sendJson(res, 200, { ok: true, ...completeChunkedUpload(target, body.uploadId) })
      } catch (e) {
        // 未收齐：保留会话可续传（400 + received 供前端续发）
        if (e?.code === 'INCOMPLETE') { sendJson(res, 400, { ok: false, error: e.message, received: e.received }); return }
        throw e
      }
      return
    }
    if (method === 'DELETE' && pathname === '/api/files/upload/abort') {
      const uploadId = url.searchParams.get('uploadId') ?? ''
      const target = await resolveScopeLocalDir(scopeQuery)
      sendJson(res, 200, { ok: true, ...abortChunkedUpload(target, uploadId) })
      return
    }
    httpErr(res, 404, 'not found: ' + pathname)
  } catch (e) {
    httpErr(res, classifyFilesError(e), e instanceof Error ? e.message : String(e))
  }
}

/** 单请求路由（R-A2/I-9 加固）：畸形 percent-encoding / NUL → 显式 400 且立即返回（进程绝不死）；
 *  其余未预期同步异常由下方 createServer 顶层 try/catch 兜底；API 分发统一挂 .catch 防未处理拒绝。 */
function routeRequest(req, res) {
  // 全请求期吞掉 res 写错误（断连/流中断后 writeHead/pipe/destroy 的 error 事件不再可能击穿进程）
  res.on('error', () => { /* 断连写错误：忽略 */ })
  let url
  try { url = new URL(req.url ?? '/', `http://${host}:${port}`) } catch { httpErr(res, 400, 'bad request：请求行无法解析'); return }
  let pathname
  try { pathname = decodeURIComponent(url.pathname) } catch { httpErr(res, 400, 'bad request：路径含畸形 percent-encoding，已拒绝'); return }
  if (pathname.includes('\0')) { httpErr(res, 400, 'bad request：路径含非法字符（NUL）'); return }
  // 同源 /hub/* 反向代理 → team-hub v2（规避浏览器跨域/CORS/localStorage 导致的中枢探测失败）
  if (pathname === '/hub' || pathname.startsWith('/hub/')) {
    const qs = url.search
    const up = new URL((process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787') + pathname.slice(4) + qs)
    const proxyReq = request({
      hostname: up.hostname, port: up.port, path: up.pathname + up.search,
      method: req.method, headers: { ...req.headers, host: up.host },
    }, (upRes) => {
      try {
        res.writeHead(upRes.statusCode, upRes.headers)
        upRes.pipe(res)
      } catch { try { res.destroy() } catch { /* 断连后写入：忽略 */ } }
    })
    proxyReq.on('error', (e) => {
      try {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`hub proxy error: ${e.message}`) }
        else try { res.destroy() } catch { /* */ }
      } catch { try { res.destroy() } catch { /* */ } }
    })
    res.on('close', () => { try { proxyReq.destroy() } catch { /* */ } }) // 客户端断连 → 停上游，避免悬挂 socket
    req.pipe(proxyReq)
    return
  }
  // 浏览器助手 /api/web/*（S6 抓取 + P2-8 历史/缓存/配额/截图；仅回环）
  if (pathname.startsWith('/api/web/')) {
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return }
    void handleWebApi(req, res, pathname, url).catch((e) => { try { httpErr(res, 500, 'internal error：' + (e instanceof Error ? e.message : String(e))) } catch { /* */ } })
    return
  }
  // 文件中心 /api/files/*（S3 只读面 + S4 写面；仅回环 + 写 token；scope → 空间 local_dir 解析）
  if (pathname.startsWith('/api/files')) {
    void handleFilesApi(req, res, pathname, url).catch((e) => { try { httpErr(res, 500, 'internal error：' + (e instanceof Error ? e.message : String(e))) } catch { /* */ } })
    return
  }
  // 目录浏览 / git 探测（空间仓库绑定的「选择文件夹」）
  if (pathname.startsWith('/api/fs/')) {
    void handleFsApi(req, res, pathname, url).catch((e) => { try { httpErr(res, 500, 'internal error：' + (e instanceof Error ? e.message : String(e))) } catch { /* */ } })
    return
  }
  // 技能安装（扫描/导入；本地目录根内 + GitHub 归档到受控缓存）
  if (pathname.startsWith('/api/skills/')) {
    void handleSkillsApi(req, res, pathname, url).catch((e) => { try { httpErr(res, 500, 'internal error：' + (e instanceof Error ? e.message : String(e))) } catch { /* */ } })
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
  const rs = createReadStream(file)
  rs.on('error', (e) => { // 文件消失/权限等读失败：不击穿进程
    try {
      if (!res.headersSent) httpErr(res, 500, '读取文件失败：' + (e?.message ?? e))
      else { try { res.destroy() } catch { /* */ } }
    } catch { try { res.destroy() } catch { /* */ } }
  })
  res.on('close', () => { try { rs.destroy() } catch { /* */ } })
  rs.pipe(res)
}

// R-A2/I-9：顶层兜底——单请求处理中的任何未预期同步异常只回 500，进程绝不被畸形输入击穿
const server = createServer((req, res) => {
  try {
    routeRequest(req, res)
  } catch (e) {
    httpErr(res, 500, 'internal error：' + (e instanceof Error ? e.message : String(e)))
  }
})

// 被 import（契约测试）时不监听端口（isMain 守卫，同 team-hub/server.mjs 先例）。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  server.listen(port, host, () => {
    console.log(`legion-workbench 已启动：http://${host}:${port}（中枢默认 ${process.env.DSH_HUB_UPSTREAM ?? 'http://127.0.0.1:8787'}，可用 DSH_HUB_UPSTREAM 覆盖）`)
  })
}

export { isLoopback, server }
