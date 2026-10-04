// team-hub/routes/mobile.mjs
// ============================================================================
// 路由族：手机端 PWA 的静态资源（远程 Agent 通道 S-F）
//
// ## 为什么由 Hub 自己托管，而不是另起一个静态站点
//
// 手机端要与 Hub **同源**：
//   · `EventSource` 不能自定义请求头，令牌只能走查询串——跨源时还要处理 CORS
//     与 cookie 的 SameSite，而每一个都是能让"看着能用、偶尔掉线"的坑；
//   · PWA 的 `scope` 必须覆盖它要控制的路径，跨源会让"安装后打不开"。
// 同源之后这两件事都不存在。
//
// ## 路径安全
//
// 只服务**白名单扩展名**的、解析后仍在目录内的文件。用白名单而不是黑名单：
// 黑名单要枚举所有危险形态（`.env`、`*.key`、`config.json`…），漏一个就漏一个；
// 而这里要发的东西是有限的几种。
//
// 目录穿越用 `resolve` + 前缀比对拦，**并且**要求解析结果仍在根内——
// 只检查 `..` 字符串是拦不住符号链接与 URL 编码的。
// ============================================================================
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** 允许发出的 MIME。白名单：不在表里的扩展名一律 404。 */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
})

/** 不缓存的类型：入口与脚本必须每次回源，否则发新版后用户拿不到。 */
const NO_STORE = new Set(['.html', '.mjs', '.js', '.webmanifest'])

/**
 * 造手机端静态路由族。
 *
 * @param {object} deps
 * @param {string} deps.root  PWA 资源目录（绝对路径）
 * @param {string} [deps.mount] 挂载前缀，默认 `/mobile`
 */
export function createMobileRoutes({ root, mount = '/mobile' } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('createMobileRoutes 需要 root')
  const absRoot = resolve(root)
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount

  /** 把 URL 映射到磁盘路径；越界或类型不允许时返回 `{ status, code }`。 */
  function resolveFile(pathname) {
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || '/'
    if (rel.includes('\0')) return { status: 400, code: 'BAD_PATH' }
    let target = rel === '/' || rel === '' ? '/index.html' : rel
    // 目录形式（`/mobile`）也要落到 index.html。
    if (target.endsWith('/')) target += 'index.html'
    const abs = resolve(absRoot, normalize(target).replace(/^([/\\])+/, ''))
    // 前缀比对必须带上分隔符：`/srv/mobile-evil` 也以 `/srv/mobile` 开头。
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { status: 403, code: 'OUT_OF_ROOT' }
    const ext = extname(abs).toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return { status: 404, code: 'TYPE_NOT_SERVED' }
    if (!existsSync(abs)) return { status: 404, code: 'NOT_FOUND' }
    let st
    try { st = statSync(abs) } catch { return { status: 404, code: 'NOT_FOUND' } }
    if (!st.isFile()) return { status: 404, code: 'NOT_FOUND' }
    return { abs, ext, size: st.size, mime: MIME[ext] }
  }

  async function serve(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const found = resolveFile(url.pathname)
    if (found.abs === undefined) {
      res.writeHead(found.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(found.code)
      return
    }
    const headers = {
      'content-type': found.mime,
      'content-length': String(found.size),
      'x-content-type-options': 'nosniff',
      // PWA 的关键头：Service Worker 与 manifest 都要能读到自己。
      'service-worker-allowed': `${prefix}/`,
      'cache-control': NO_STORE.has(found.ext) ? 'no-store' : 'public, max-age=86400',
    }
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
    res.writeHead(200, headers)
    createReadStream(found.abs).pipe(res)
  }

  const routes = [
    { method: 'GET', path: `${prefix}/*` },
    { method: 'HEAD', path: `${prefix}/*` },
  ]

  return {
    id: 'mobile',
    routes,
    async dispatch(req, res, ctx) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const path = ctx.path
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return false
      await serve(req, res)
      return true
    },
  }
}
