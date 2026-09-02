/**
 * Legion Workbench 独立静态服务器（生产构建后使用）。
 * 用法：pnpm build && node scripts/serve.mjs [--port 5173] [--host 127.0.0.1]
 * SPA 回退：未知路径返回 index.html，方便深链。
 *
 * 附加 API（同源，仅回环地址可访问；用于「空间仓库绑定」的选文件夹，照搬 DSH 工作空间的
 * 目录浏览逻辑——选文件夹而非手填路径）：
 *   GET  /api/fs/home                        → { home, drives }（起始目录与盘符）
 *   GET  /api/fs/list?path=<绝对目录>         → { path, parent, isRoot, entries:[{name,path,isRepo}], drives }
 *   POST /api/fs/inspect                     → { isRepo, root, branch, remotes:[{name,url}] }（git 探测）
 */
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, join, normalize, dirname } from 'node:path'
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

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

server.listen(port, host, () => {
  console.log(`legion-workbench 已启动：http://${host}:${port}（数据源默认 http://127.0.0.1:4820）`)
})
