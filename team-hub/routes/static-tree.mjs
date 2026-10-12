// team-hub/routes/static-tree.mjs
// ============================================================================
// 一个**静态目录**的路由族 —— 手机端 PWA 与桌面工作台（`/workbench`）共用。
//
// ## 为什么抽出来，而不是各写一份
//
// 两个宿主服务的是不同目录、不同扩展名、不同缓存策略，**但路径安全是同一条**：
// 白名单扩展名 + `resolve` 后仍在根内 + 编码与空字节的处理。
// 那是这个文件里**唯一出错会变成安全事件**的部分。
//
//   > 拷贝一份"拒绝目录穿越"的判据，与把这条判据留在唯一一个地方，
//   > 在两个目录都安分的时候是同一个东西 ——
//   > 直到有人只修好了其中一份。
//
// 所以：安全逻辑在这里只有一份，差异全部走参数。
//
// ## 路径安全（逐条）
//
//   · **白名单**扩展名而不是黑名单：黑名单要枚举所有危险形态（`.env`、`*.key`、
//     `config.json`…），漏一个就漏一个；而要发的东西是有限的几种。
//   · `resolve` + **带分隔符**的前缀比对：`/srv/mobile-evil` 也以 `/srv/mobile`
//     开头，不带分隔符的比会放行它。
//   · 解码后仍含 `\0` 直接 400。
//   · 只发**普通文件**（`statSync().isFile()`）。
//
// ## 裸挂载点必须重定向（`/x` → `/x/`）
//
// 这一条不是美观问题。手机端的 `index.html` 用的是**相对**引用
// （`./app.mjs`、`./manifest.webmanifest`），工作台的产物同样用相对 base。
// 浏览器在 `/mobile`（**无尾斜杠**）下会把 `./app.mjs` 解析成 `/app.mjs` ——
// 于是页面**加载出来但资源全 404**。实测过：`/mobile` 返回 200 且不重定向，
// 而 `/app.mjs` 在根上并不存在。
//
//   > 一个"在地址栏里少打一个斜杠就白屏"的页面，
//   > 与一个"能用"的页面，在测试里都是 200 ——
//   > 只不过前者只有真的用浏览器打开才会发现。
// ============================================================================
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, normalize, resolve, sep } from 'node:path'

/**
 * 造一个静态目录路由族。
 *
 * @param {object} args
 * @param {string} args.id           族 id（进 `router.list()`）
 * @param {string} args.root         资源目录（绝对路径）
 * @param {string} args.mount        挂载前缀，如 `/mobile`
 * @param {Readonly<Record<string,string>>} args.mime 白名单：扩展名 → content-type
 * @param {ReadonlyArray<string>} [args.noStore]     这些扩展名回 `no-store`
 * @param {string|null} [args.immutablePrefix]       该前缀下的路径回长缓存 + `immutable`
 * @param {string|null} [args.workerAllowed]         给了就发 `service-worker-allowed`
 * @param {boolean} [args.redirectBareMount]         裸挂载点是否 301 到带斜杠形式
 */
export function createStaticTreeRoutes({
  id, root, mount, mime,
  noStore = [], immutablePrefix = null, workerAllowed = null,
  redirectBareMount = true,
} = {}) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('createStaticTreeRoutes 需要 id')
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('createStaticTreeRoutes 需要 root')
  if (typeof mount !== 'string' || !mount.startsWith('/')) throw new TypeError('createStaticTreeRoutes 需要以 / 开头的 mount')
  if (mime === null || typeof mime !== 'object') throw new TypeError('createStaticTreeRoutes 需要 mime 表')

  const absRoot = resolve(root)
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount
  const noStoreSet = new Set(noStore)

  /** 把 URL 映射到磁盘路径；越界或类型不允许时返回 `{ status, code }`。 */
  function resolveFile(pathname) {
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || '/'
    if (rel.includes('\0')) return { status: 400, code: 'BAD_PATH' }
    let target = rel === '/' || rel === '' ? '/index.html' : rel
    // 目录形式（`/x/`）落到 index.html。
    if (target.endsWith('/')) target += 'index.html'
    const abs = resolve(absRoot, normalize(target).replace(/^([/\\])+/, ''))
    // 前缀比对必须带上分隔符：`/srv/mobile-evil` 也以 `/srv/mobile` 开头。
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { status: 403, code: 'OUT_OF_ROOT' }
    const ext = extname(abs).toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(mime, ext)) return { status: 404, code: 'TYPE_NOT_SERVED' }
    if (!existsSync(abs)) return { status: 404, code: 'NOT_FOUND' }
    let st
    try { st = statSync(abs) } catch { return { status: 404, code: 'NOT_FOUND' } }
    if (!st.isFile()) return { status: 404, code: 'NOT_FOUND' }
    return { abs, ext, size: st.size, mime: mime[ext] }
  }

  /**
   * 这个路径该回什么缓存头。
   *
   * ★ `immutablePrefix` 比的是**树内相对路径**，不是完整 URL 路径。
   *   写成完整路径就永远不匹配：挂在 `/workbench/assets/` 下时，
   *   前缀若是 `/assets/`，`'/workbench/assets/x.js'.startsWith('/assets/')` 是 false ——
   *   于是哈希资源悄悄退回一天缓存，而"能不能缓存"这件事没有任何地方会报错。
   *   （实测踩到：判据报 `max-age=31536000.*immutable` 不匹配。）
   */
  function cacheControlFor(relPath, ext) {
    if (noStoreSet.has(ext)) return 'no-store'
    // 带内容哈希的构建产物：可以永久缓存，改内容就换文件名。
    if (immutablePrefix !== null && relPath.startsWith(immutablePrefix)) {
      return 'public, max-age=31536000, immutable'
    }
    return 'public, max-age=86400'
  }

  /** URL 路径 → 树内相对路径（以 `/` 开头），供缓存策略与安全判据共用。 */
  function relativeOf(pathname) {
    const rel = pathname.slice(prefix.length)
    return rel === '' ? '/' : rel
  }

  async function serve(req, res, pathname) {
    const found = resolveFile(pathname)
    if (found.abs === undefined) {
      res.writeHead(found.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(found.code)
      return
    }
    const headers = {
      'content-type': found.mime,
      'content-length': String(found.size),
      'x-content-type-options': 'nosniff',
      'cache-control': cacheControlFor(relativeOf(pathname), found.ext),
    }
    if (workerAllowed !== null) headers['service-worker-allowed'] = workerAllowed
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return }
    res.writeHead(200, headers)
    createReadStream(found.abs).pipe(res)
  }

  const routes = [
    { method: 'GET', path: `${prefix}/*` },
    { method: 'HEAD', path: `${prefix}/*` },
  ]

  return {
    id,
    routes,
    async dispatch(req, res, ctx) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const path = ctx.path
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return false
      // 裸挂载点：必须重定向，否则页面里的**相对**引用会解析到根上（见文件头）。
      if (path === prefix) {
        if (!redirectBareMount) {
          await serve(req, res, `${prefix}/`)
          return true
        }
        res.writeHead(301, { location: `${prefix}/` })
        res.end()
        return true
      }
      await serve(req, res, path)
      return true
    },
  }
}
