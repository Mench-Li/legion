// team-hub/routes/releases.mjs
// ============================================================================
// 发布目录托管（`GET /legion/*`）——「给到用户下载」的那一半。
//
// ## 为什么让 Hub 自己托管，而不是让运营者另起一个服务
//
// 自动更新设计（`docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md` §4）
// 只要求"能公开读取文件的 HTTPS 托管"，对象存储也行。但**部署一台 Hub 的人**
// 手上已经有了一台有证书、有域名、正在跑的服务；再让他去开一个对象存储、
// 配一套 CORS、再维护一个上传流程，中间任何一步没做成都表现为
// "门口那个下载按钮点开是 404"——而那是我们**已经**在门口页里明令禁止的形状
// （`portal.mjs`：宁可写"尚未发布"，也不给一个点开 404 的假链接）。
//
// 所以：把发布目录挂上来。目录结构**逐字**照设计文档 §4：
//
//   /legion/feeds/<channel>/win-x64.json
//   /legion/releases/<releaseId>/manifest.json
//   /legion/releases/<releaseId>/notes.zh-CN.txt
//   /legion/releases/<releaseId>/legion-win-x64.zip
//   /legion/releases/<releaseId>/Legion-Setup-win-x64.exe
//
// ## 四条纪律
//
// ① **白名单扩展名**，与 `routes/mobile.mjs` 同一条：黑名单会漏，白名单不会。
//    这里尤其要紧——发布目录是个"运营者往里丢文件"的目录，而它会与安装包
//    放在同一个域上。
// ② **路径穿越一律拦下**（含编码形式与符号链接）。同 mobile 那套写法。
// ③ **缓存策略按设计文档分两类**：通道清单（`feeds/**`）`no-store`——
//    它必须每次回源，否则客户端会一直看到一个过期的通道；发布目录可以长缓存，
//    `releaseId` 唯一且不可覆盖正是为了让长缓存安全。
// ④ **支持 Range**。安装包上百 MB，手机上下一半断了不能续传，等于不能下。
//    这不是优化：一个"断了就得从头再来"的下载，在移动网络上是常态性失败。
//
// ## 目录不存在时**如实 404**，不假装
//
// 没配 `LEGION_RELEASES_DIR`、或目录还不存在时，这一族**不注册**（返回 false，
// 让请求落到通用 404）。它不会造一个空目录，也不会返回一个空列表——
// 一个"200 但是空的"发布目录，与一个"还没有发布"在界面上长得一样，
// 而前者会让排障的人去查缓存。
// ============================================================================
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** 允许发出的 MIME。**白名单**：不在表里的一律 404。 */
const MIME = Object.freeze({
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.zip': 'application/zip',
  '.blockmap': 'application/octet-stream',
})

/** 通道清单必须每次回源（设计文档 §4：`Cache-Control: no-store`）。 */
const NO_STORE_SEGMENT = 'feeds'

/**
 * 发布目录里最新的一份安装包。
 *
 * 判据是 `releases/<releaseId>/` 下**真的存在**那个 exe——不是"目录里有一个
 * 像 releaseId 的名字"。这正是门口页那条纪律要的：只链接**确实存在**的文件，
 * 否则给出去的仍然是一个点开 404 的假链接，只不过这次的假链接是代码生成的。
 *
 * `releaseId` 的排序用字符串序（设计文档没有规定它必须可排序，所以这里
 * **不解释**它的语义，只要求"能挑出一个"）：真要用语义化版本排序，
 * 那是发布端的事，客户端不该猜。
 */
export function latestInstaller(root, { installerName = 'Legion-Setup-win-x64.exe' } = {}) {
  const releasesDir = join(root, 'releases')
  if (!existsSync(releasesDir)) return null
  let entries
  try { entries = readdirSync(releasesDir) } catch { return null }
  const candidates = []
  for (const id of entries) {
    const file = join(releasesDir, id, installerName)
    try {
      const st = statSync(file)
      if (!st.isFile()) continue
      candidates.push({ releaseId: id, file, sizeBytes: st.size, mtimeMs: st.mtimeMs })
    } catch { /* 不是目录 / 没这个文件：跳过 */ }
  }
  if (candidates.length === 0) return null
  // 按 mtime 取最新：`releaseId` 的语义未规定，而 mtime 是"这份什么时候被放上来"，
  // 它回答的正是"最新一份是哪个"。
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]
}

/**
 * 读一份发布的清单（`releases/<releaseId>/manifest.json`）。
 *
 * 官网的下载区拿它来显示 sha256 与「本次更新」。**读不到就回 null**，不抛、不猜 ——
 * 清单是发布端可选写的，没有它的发布照样能下载，页面只是少显示两行，
 * 而不是显示一个空的校验值（一个空的 sha256 比没有 sha256 更坏：它看起来像"校验过了"）。
 *
 * 期望的形状（本仓库发布端写的就是这个）：
 *
 *   { releaseId, productVersion, channel, platform,
 *     artifacts: { installer: { path, sizeBytes, sha256 } },
 *     note, changes: [ "…" ] }
 *
 * 但**只按存在的字段取用**：字段缺失/类型不对时当作没有，不当成错误。
 * 这里刻意不缓存——官网是最冷的页面，而清单只有 1KB 上下；
 * 为它加一层缓存，换来的状态比省下的 IO 贵。
 */
export function readReleaseManifest(root, releaseId) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (typeof releaseId !== 'string' || releaseId.length === 0) return null
  // `releaseId` 来自 `readdirSync`，正常不会是路径片段；仍然显式拒一次，
  // 免得将来有人把别的来源接进来时，这里变成一条能往目录外读的缝。
  if (releaseId.includes('/') || releaseId.includes('\\') || releaseId.includes('..')) return null
  try {
    const raw = readFileSync(join(root, 'releases', releaseId, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}


/**
 * 造发布目录路由族。
 *
 * @param {object} deps
 * @param {string} deps.root  发布目录的根（其下应有 `feeds/` 与 `releases/`）
 * @param {string} [deps.mount] 挂载前缀，默认 `/legion`
 */
export function createReleaseRoutes({ root, mount = '/legion' } = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('createReleaseRoutes 需要 root')
  const absRoot = resolve(root)
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount

  /** URL → 磁盘路径；越界或类型不允许时返回 `{ status, code }`。 */
  function resolveFile(pathname) {
    const rel = decodeURIComponent(pathname.slice(prefix.length)) || '/'
    if (rel.includes('\0')) return { status: 400, code: 'BAD_PATH' }
    const target = rel === '/' || rel === '' ? '/' : rel
    const abs = resolve(absRoot, normalize(target).replace(/^([/\\])+/, ''))
    // 前缀比对必须带分隔符：`/srv/legion-releases-evil` 也以 `/srv/legion-releases` 开头。
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { status: 403, code: 'OUT_OF_ROOT' }
    const ext = extname(abs).toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return { status: 404, code: 'TYPE_NOT_SERVED' }
    if (!existsSync(abs)) return { status: 404, code: 'NOT_FOUND' }
    let st
    try { st = statSync(abs) } catch { return { status: 404, code: 'NOT_FOUND' } }
    if (!st.isFile()) return { status: 404, code: 'NOT_FOUND' }
    return { abs, ext, size: st.size, mime: MIME[ext], rel: abs.slice(absRoot.length).split(sep).join('/') }
  }

  /** 这一份能不能长缓存：发布目录可以，通道清单不行。 */
  function cacheControlFor(rel) {
    return rel.split('/').includes(NO_STORE_SEGMENT) ? 'no-store' : 'public, max-age=86400'
  }

  /**
   * 解析 `Range: bytes=a-b`。
   *
   * 只支持**单段**：多段 Range 要生成 multipart/byteranges，而客户端
   * （浏览器、electron-updater）要的都是单段；为多段写一套响应拼装，
   * 换来的是没人走的分支与一处迟早会错的手工拼接。
   * 认不出来就**忽略**这个头、按整份回 200——这是 RFC 允许的降级，
   * 而"看不懂就 416"会把一个本来能下完的请求变成失败。
   */
  function parseRange(header, size) {
    if (typeof header !== 'string' || header.length === 0) return null
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (m === null) return null
    const [, rawStart, rawEnd] = m
    if (rawStart === '' && rawEnd === '') return null
    let start, end
    if (rawStart === '') {
      // `bytes=-N`：最后 N 字节
      const n = Number(rawEnd)
      if (!Number.isSafeInteger(n) || n <= 0) return null
      start = Math.max(0, size - n)
      end = size - 1
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? size - 1 : Number(rawEnd)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
    }
    if (start > end || start >= size) return { unsatisfiable: true }
    return { start, end: Math.min(end, size - 1) }
  }

  async function serve(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const found = resolveFile(url.pathname)
    if (found.abs === undefined) {
      res.writeHead(found.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(found.code)
      return
    }
    const base = {
      'content-type': found.mime,
      'x-content-type-options': 'nosniff',
      'cache-control': cacheControlFor(found.rel),
      // 断点续传要它。写在这里而不是按需拼：一个只在部分响应里出现的
      // `accept-ranges` 会让客户端**先试一整次**才知道能不能续。
      'accept-ranges': 'bytes',
    }
    const range = parseRange(req.headers.range, found.size)
    if (range?.unsatisfiable === true) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${found.size}` })
      res.end()
      return
    }
    if (range !== null && range !== undefined) {
      const length = range.end - range.start + 1
      res.writeHead(206, {
        ...base,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${found.size}`,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(found.abs, { start: range.start, end: range.end }).pipe(res)
      return
    }
    res.writeHead(200, { ...base, 'content-length': String(found.size) })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(found.abs).pipe(res)
  }

  const routes = [
    { method: 'GET', path: `${prefix}/*` },
    { method: 'HEAD', path: `${prefix}/*` },
  ]

  return {
    id: 'releases',
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
