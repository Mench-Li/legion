/**
 * Legion Workbench 独立静态服务器（生产构建后使用）。
 * 用法：pnpm build && node scripts/serve.mjs [--port 5173] [--host 127.0.0.1]
 * SPA 回退：未知路径返回 index.html，方便深链。
 */
import { createServer, request } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
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

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${host}:${port}`).pathname)
  // 同源 /hub/* 反向代理 → team-hub v2（规避浏览器跨域/CORS/localStorage 导致的中枢探测失败）
  if (pathname === '/hub' || pathname.startsWith('/hub/')) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
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
