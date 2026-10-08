// team-hub/routes/site.mjs
// ============================================================================
// 路由族：官网（`/` 与 `/en`）与它的静态资源（`/site/*`）。
//
// ## 为什么是**静态文件 + 服务时注入**，而不是像门口页那样整页渲染
//
// `portal.mjs` 把整页 HTML 写在 `.mjs` 里。对门口页是对的——它一屏、
// 几百字、几乎不改。官网不一样：文案是要反复改的东西，而改一个跑着服务的
// 源文件意味着**每次改一句话都要重启 Hub**。
//
//   > 一个"改文案要重启"的页面与一个"改文案要重新编译"的页面，
//   > 在只改过一次文案的人手里是同一个东西——都是"先别改了"。
//
// 所以正文住在真正的 `.html` 文件里（`site/`），改完拷文件即可；而下载地址这类
// 必须**当场现算**的东西，由本模块每次请求替换进去。
//
// ## 缓存**模板**，不缓存**结果**
//
// 这两句话的分工是这一族的关键：
//   · 模板按 `mtime+size` 缓存——省掉每个请求重读上百 KB 的磁盘 IO；
//   · 替换**每个请求都做**——「最新的一份安装包」必须当场算。
//
// `portal.mjs` 记着这条回归的代价：整页曾被渲染成常量，"最新"被冻在服务启动
// 的那一刻，于是传了新版首页还发旧版，**没有一个地方会报错**。
// 文件缓存不会重新引入它，因为被缓存的是**没有替换过的**模板。
//
// ## 静态白名单里**没有 `.html`**
//
// 这是与 `mobile.mjs` 最重要的一处差别。那边的 `index.html` 是死的，
// 直接发出去没问题；这边的两个入口页是**活的**——里面有等替换的占位标记。
// 若允许 `/site/index.html` 走静态那条路发出，拿到的就是**没被替换过的模板**：
// 页面上没有下载按钮、没有手机端入口，而 HTTP 是 200，什么也不报。
//
//   > 一个"入口页可以从两条路出来、其中一条忘了注入"的设计，
//   > 与一个"下载按钮时有时无"的网站，在用户那里是同一个东西——
//   > 他只会再刷新几次。
//
// 所以 `.html` 不在白名单里：入口页**只能**经 `/` 与 `/en` 出来，那条路一定做了替换。
//
// ## 与门口页的关系：前置，不是替换
//
// `portal.mjs` 保留。本族排在它前面，答不了就返回 `false` 落下去。
// 于是：`site/index.html` 不存在 = 这个部署没有官网，`/` 仍然由门口页回答。
// 别的 Hub 部署者不受影响，也不需要任何新配置；不想要官网的删掉 `site/index.html` 即可。
// ============================================================================
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * 允许发出的 MIME。**白名单**：不在表里的一律 404 `TYPE_NOT_SERVED`。
 *
 * ★ 故意**没有** `.html` —— 理由见文件头。两个入口页走 `renderPage`，
 *   不走这里。
 */
const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
})

/** 三个占位标记。**全部出现处都会被替换**（同一标记可以在导航和 Hero 各用一次）。 */
export const MARKER_CTA = '<!-- legion:cta -->'
export const MARKER_DOWNLOAD = '<!-- legion:download -->'
export const MARKER_HUB = '<!-- legion:hub-line -->'

const MOBILE_PATH_DEFAULT = '/mobile/'

/** HTML 转义。本族所有插值都走它——没有例外，即使当前插值都来自配置。 */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** 字节 → `183.4 MB`。给不出精确值时返回空串（宁可少一行，也不编一个数）。 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * 发布清单里的条目用 `**粗体**` 标注。**先转义、再换标记** —— 顺序反了就是一个注入口。
 * `esc()` 不碰 `*`，所以转义之后捕捉组里不可能再有原始 `<`。
 */
function inlineBold(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
}

/** sha256 只认 64 位十六进制；其余（含缺失、含 `undefined`）一律视为"没有"。 */
function normalizeSha(value) {
  const s = String(value ?? '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(s) ? s : ''
}

/** 只留非空字符串。清单字段可能是任意类型，别让一个数字把渲染带崩。 */
function asList(value) {
  return Array.isArray(value) ? value.filter((s) => typeof s === 'string' && s.trim().length > 0) : []
}

/** mtime → `2026-10-06`。 */
function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/**
 * 两种语言的动态块文案。静态正文在 `site/*.html` 里，这里只放**要现算**的那几句。
 */
const COPY = Object.freeze({
  zh: {
    lang: 'zh-CN',
    cta: '下载电脑版',
    ctaNote: 'Windows x64',
    ctaWarn: '安装包未做代码签名，Windows 会拦一下 —— 怎么处理见下方「下载」。',
    notYet: '电脑版尚未发布',
    notYetHint: '安装包还没上传到这台 Hub；先向管理员索取。',
    downloadTitle: '下载电脑版',
    updates: '本次更新',
    updatesZhOnly: '发布端只写了中文说明，原文照录。',
    sha: '安装包 sha256',
    shaHint: '取自随包发布的清单；下载后可自行比对，确认拿到的是这一份。',
    copy: '复制',
    copied: '已复制',
    mobile: '打开手机端',
    mobileHint: '看板与对话；可安装到主屏',
    regOpen: '这台 Hub 开放注册。打开手机端即可注册。',
    regInvite: '这台 Hub 开放注册（需要邀请码）。打开手机端即可注册。',
    regClosed: '这台 Hub 未开放自助注册；请向管理员索取邀请码。',
    regShared: '注册与登录都在手机端页面上；电脑版与手机端共用同一套账号。',
    // ★ 未签名构建专有的说明。换签名构建时**这段必须跟着改**，否则它会变成
    //   "照它说的做、然后发现对不上"，而那种文案教会人忽略这一块。
    unsigned:
      '<p class="notice"><b>尚未做代码签名</b>（那要一张证书），所以 Windows 会拦一下 —— 那是预期的，不是包坏了：<br />' +
      '① 浏览器下载时若提示「不常见」，点<b>保留</b>；<br />' +
      '② 双击运行时出现「未知发布者」，点<b>更多信息 → 仍要运行</b>。<br />' +
      '⚠️ 例外：若系统开着 <b>Smart App Control</b>（Windows 11 全新安装默认开），它会' +
      '<b>直接阻止且不给「仍要运行」</b>。关掉它可以装，但关掉之后要重装系统才能再打开 —— ' +
      '这台机器请改用别的机器下载。</p>',
  },
  en: {
    lang: 'en',
    cta: 'Download for Windows',
    ctaNote: 'Windows x64',
    ctaWarn: 'The installer is not code-signed, so Windows will push back — see the note under Download below.',
    notYet: 'Desktop build not yet published',
    notYetHint: 'No installer has been uploaded to this Hub yet; ask the administrator.',
    downloadTitle: 'Download for Windows',
    updates: "What's new",
    updatesZhOnly: 'The publisher only wrote release notes in Chinese; shown verbatim.',
    sha: 'Installer sha256',
    shaHint: 'Taken from the manifest published alongside the build; compare it after downloading to confirm you got this exact file.',
    copy: 'Copy',
    copied: 'Copied',
    mobile: 'Open the mobile app',
    mobileHint: 'Board and conversations; installable to your home screen',
    regOpen: 'This Hub is open for sign-up. Open the mobile app to register.',
    regInvite: 'This Hub is open for sign-up (invite code required). Open the mobile app to register.',
    regClosed: 'This Hub does not allow self sign-up; ask the administrator for an invite code.',
    regShared: 'Sign-up and sign-in both happen in the mobile app; desktop and mobile share one account.',
    unsigned:
      '<p class="notice">The installer is <b>not code-signed</b> (that needs a certificate), so Windows will ' +
      'push back — that is expected, the download is not broken:<br />' +
      '① If the browser says the file is “uncommon”, choose <b>Keep</b>;<br />' +
      '② When you run it, Windows shows “Unknown publisher” — choose <b>More info → Run anyway</b>.<br />' +
      '⚠️ Exception: if <b>Smart App Control</b> is on (on by default in a fresh Windows 11 install) it will ' +
      '<b>block the installer outright with no “Run anyway”</b>. Turning it off lets you install, but you must ' +
      'reinstall Windows to turn it back on — use another machine instead.</p>',
  },
})

/**
 * 造三个动态块的 HTML。**纯函数**，因此用例可以直接断言它写了什么。
 *
 * @param {object} input
 * @param {'zh'|'en'} input.lang
 * @param {string} input.downloadUrl  桌面版下载地址；留空 = 尚未发布
 * @param {string} [input.version]    版本号（可空 —— 空就不显示这一行，不猜）
 * @param {string} [input.size]       已格式化的体积（可空）
 * @param {string} [input.date]       发布日期（可空）
 * @param {string} [input.sha256]     安装包摘要。**只在是合法 64 位十六进制时显示**；
 *        空/畸形一律不显示那一行 —— 一个空的 sha256 比没有 sha256 更坏，它看起来像"校验过了"。
 * @param {string[]} [input.changes]  发布清单里的更新条目（可空数组）
 * @param {string} [input.registration] 'closed' | 'invite' | 'open'
 * @param {string} [input.mobilePath]
 */
export function renderLiveBlocks({
  lang = 'zh', downloadUrl = '', version = '', size = '', date = '',
  sha256 = '', changes = [], changesEn = [], registration = 'closed', mobilePath = MOBILE_PATH_DEFAULT,
} = {}) {
  const c = COPY[lang] ?? COPY.zh
  const has = String(downloadUrl).trim().length > 0
  const href = has ? esc(downloadUrl) : ''

  // ① 主按钮 / 诚实的话。没发布就给一句实话，**不给点开 404 的假链接**。
  const cta = has
    ? `<a class="btn btn-primary" href="${href}">${c.cta}</a>`
    : `<span class="btn btn-disabled" aria-disabled="true">${c.notYet}</span>`

  // 元信息行：有哪几项就写哪几项，一项都没有就不出现这一行。
  const metaBits = [c.ctaNote, version ? `v${esc(version)}` : '', esc(size), esc(date)].filter((s) => s.length > 0)
  const meta = metaBits.length > 0 ? `<p class="meta">${metaBits.join(' · ')}</p>` : ''

  // Hero 版：按钮 + 元信息 + **一句**短提醒（完整说明在下面「下载」里）。
  // 提醒放在按钮**后面但仍在同一屏**，是为了让用户点之前就看见 —— 详见 portal.mjs 的注释。
  const ctaHero = `${cta}
    ${meta}
    ${has ? `<p class="hint">${c.ctaWarn}</p>` : ''}`

  // ② 下载区整块。
  //
  // ★ 这里**曾经**有一行「全部历史版本 → /legion/」。实测（2026-10-08 上线后）
  //   `/legion/` 是 **404**：发布目录那一族只发**文件**，从不列目录
  //   （`releases.mjs` 头部：目录不存在就如实 404，不假装）。也就是说我加了一个
  //   **点开 404 的假链接** —— 正是 `portal.mjs` 立下那条纪律要防的形状，
  //   而当时的守卫（"releaseId 非空"）测的是错的方向：它证明了"安装包来自发布目录"，
  //   却证明不了"那个路径下有可读的东西"。
  //
  //   > 一个"链接指向确实存在的安装包"的守卫，与一个"链接指向确实存在的**页面**"
  //   > 的守卫，在没人点过那个链接的时候，是同一个东西。
  //
  // 所以：站上不承诺任何版本历史/清单浏览。要加，得先有一个真的列表端点。
  const sha = normalizeSha(sha256)
  const shaBlock = sha.length > 0
    ? `<div class="sha">
        <span class="sha-label">${c.sha}</span>
        <code class="sha-value">${sha}</code>
        <button type="button" class="sha-copy" data-copy="${sha}" data-copied="${c.copied}">${c.copy}</button>
      </div>
      <p class="hint">${c.shaHint}</p>`
    : ''

  // 更新条目：英文页优先读 `changesEn`，没有就退回 `changes` 并**标明是发布端原文**。
  // 让英文页空着是丢信息；把中文悄悄当英文是骗人；标明出处是唯一诚实的第三条路。
  const zhList = asList(changes)
  const enList = asList(changesEn)
  const list = lang === 'en' ? (enList.length > 0 ? enList : zhList) : zhList
  const borrowed = lang === 'en' && enList.length === 0 && zhList.length > 0
  const updatesBlock = list.length > 0
    ? `<div class="updates">
        <h3>${c.updates}</h3>
        ${borrowed ? `<p class="hint">${c.updatesZhOnly}</p>` : ''}
        <ul>${list.map((s) => `<li>${inlineBold(s)}</li>`).join('')}</ul>
      </div>`
    : ''

  const download = has
    ? `<div class="dl-row">${cta}</div>
       ${meta}
       ${c.unsigned}
       ${shaBlock}
       ${updatesBlock}`
    : `<div class="dl-row">${cta}</div>
       <p class="hint">${c.notYetHint}</p>`

  // ③ 这台 Hub 自己的入口与注册状态。门口页原来承担的"这是什么、该去哪儿"，
  //    现在由官网承担——所以这一段不能丢。
  const reg = registration === 'open' ? c.regOpen
    : registration === 'invite' ? c.regInvite
      : c.regClosed
  const hub = `<p class="hub-entry">
    <a class="btn btn-ghost" href="${esc(mobilePath)}">${c.mobile}</a>
  </p>
  <p class="hint">${c.mobileHint}</p>
  <p class="hint">${reg}</p>
  <p class="hint">${c.regShared}</p>`

  return { cta: ctaHero, download, hub }
}

/**
 * 把三个标记替换进模板。**纯函数**：同一个模板 + 同一份数据 → 同一份输出。
 *
 * 用 `split/join` 而不是 `replace`：后者在替换串里出现 `$&` 一类序列时会被
 * 当成替换模式解释掉，而这里的替换串包含**运营者可配的下载地址**。
 */
export function injectLiveBlocks(template, blocks) {
  return String(template)
    .split(MARKER_CTA).join(blocks.cta)
    .split(MARKER_DOWNLOAD).join(blocks.download)
    .split(MARKER_HUB).join(blocks.hub)
}

/**
 * 造官网路由族。
 *
 * @param {object} deps
 * @param {string} deps.root        站点目录（绝对路径），里面是 `index.html` / `en/index.html` / `assets/`
 * @param {string} [deps.mount]     静态资源挂载前缀，默认 `/site`
 * @param {Function} [deps.readRelease] 返回**当次**发布信息的函数：
 *        `{ url, version, sizeBytes, at }`。传函数而不是值，是为了"最新那份每次现算"。
 *        也接受字符串（显式配置那条路不变）。
 * @param {string} [deps.registration] 'closed' | 'invite' | 'open'
 * @param {string} [deps.mobilePath]
 */
export function createSiteRoutes({
  root, mount = '/site', readRelease = () => ({ url: '' }),
  registration = 'closed', mobilePath = MOBILE_PATH_DEFAULT,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('createSiteRoutes 需要 root')
  const absRoot = resolve(root)
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount
  const resolveRelease = typeof readRelease === 'function' ? readRelease : () => ({ url: String(readRelease ?? '') })

  /** 两个入口页。`/` 是中文，`/en` 是英文（路径式双语，见方案）。 */
  const PAGES = { zh: join(absRoot, 'index.html'), en: join(absRoot, 'en', 'index.html') }

  // 模板缓存：只缓存**没有替换过**的模板，替换每次请求都做。
  const templates = new Map()

  function readTemplate(abs) {
    let st
    try { st = statSync(abs) } catch { return null }
    if (!st.isFile()) return null
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = templates.get(abs)
    if (hit !== undefined && hit.sig === sig) return hit.text
    const text = readFileSync(abs, 'utf8')
    templates.set(abs, { sig, text })
    return text
  }

  /**
   * 把 URL 映射到磁盘路径；越界或类型不允许时返回 `{ status, code }`。
   * 逐字复刻 `mobile.mjs` 的守卫，**外加一道 `realpathSync` 复检**（见下）。
   */
  function resolveFile(pathname) {
    let rel
    try { rel = decodeURIComponent(pathname.slice(prefix.length)) || '/' } catch { return { status: 400, code: 'BAD_PATH' } }
    if (rel.includes('\0')) return { status: 400, code: 'BAD_PATH' }
    let target = rel.startsWith('/') ? rel : `/${rel}`
    if (target.endsWith('/')) target += 'index.html'
    const abs = resolve(absRoot, normalize(target).replace(/^([/\\])+/, ''))
    // 前缀比对必须带上分隔符：`/srv/site-evil` 也以 `/srv/site` 开头。
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return { status: 403, code: 'OUT_OF_ROOT' }
    const ext = extname(abs).toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return { status: 404, code: 'TYPE_NOT_SERVED' }
    if (!existsSync(abs)) return { status: 404, code: 'NOT_FOUND' }
    // ★ 前缀比对**拦不住目录内的符号链接**：`resolve`/`normalize` 不接触文件系统，
    //   一个指向根外的链接会原样通过上面那道检查。`mobile.mjs` 的头注释宣称拦住了，
    //   其实没有——这里补上它承诺的那一道。`server.mjs` 的上传路径也是这么做的。
    //   （注意不能用 `statSync().isSymbolicLink()`：`statSync` 跟随链接，那个判断恒为 false。）
    let st
    try { st = statSync(abs) } catch { return { status: 404, code: 'NOT_FOUND' } }
    if (!st.isFile()) return { status: 404, code: 'NOT_FOUND' }
    let real
    try { real = realpathSync(abs) } catch { return { status: 404, code: 'NOT_FOUND' } }
    if (real !== absRoot && !real.startsWith(absRoot + sep)) return { status: 403, code: 'OUT_OF_ROOT' }
    return { abs, ext, size: st.size, mime: MIME[ext] }
  }

  function sendPlain(res, status, code) {
    const body = Buffer.from(code, 'utf8')
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /** 发入口页：读模板 → 注入动态块 → 送出。**入口页永不缓存**（它带着当次算出的下载地址）。 */
  function servePage(req, res, lang) {
    const abs = PAGES[lang]
    const template = readTemplate(abs)
    // 模板不存在 = 这个部署没有官网。返回 `false` 让请求落到门口页。
    if (template === null) return false
    const r = resolveRelease() ?? {}
    const blocks = renderLiveBlocks({
      lang,
      downloadUrl: r.url ?? '',
      version: r.version ?? '',
      size: formatSize(r.sizeBytes),
      date: formatDate(r.at),
      sha256: r.sha256 ?? '',
      changes: r.changes ?? [],
      changesEn: r.changesEn ?? [],
      registration,
      mobilePath,
    })
    const body = Buffer.from(injectLiveBlocks(template, blocks), 'utf8')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    })
    if (req.method === 'HEAD') { res.end(); return true }
    res.end(body)
    return true
  }

  const routes = [
    { method: 'GET', path: '/' },
    { method: 'HEAD', path: '/' },
    { method: 'GET', path: '/en' },
    { method: 'HEAD', path: '/en' },
    { method: 'GET', path: `${prefix}/*` },
    { method: 'HEAD', path: `${prefix}/*` },
  ]

  return {
    id: 'site',
    routes,
    async dispatch(req, res, ctx) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      const path = ctx.path

      // 入口页：**只有这两条**。其余路径一律不认，免得把 `/api/*` 之类吞掉。
      if (path === '/') return servePage(req, res, 'zh')
      if (path === '/en' || path === '/en/') return servePage(req, res, 'en')

      // 静态资源。前缀比对带分隔符，`/siteofsomething` 不被吞。
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return false
      const found = resolveFile(path)
      if (found.abs === undefined) {
        sendPlain(res, found.status, found.code)
        return true
      }
      const headers = {
        'content-type': found.mime,
        'content-length': String(found.size),
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=86400',
      }
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return true }
      res.writeHead(200, headers)
      createReadStream(found.abs).pipe(res)
      return true
    },
  }
}
