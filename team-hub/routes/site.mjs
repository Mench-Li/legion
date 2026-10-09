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

/**
 * 源码仓库地址。**业主 2026-10-09 明确要求**从这里直达 —— 我实测过它是公开的
 * （匿名访问返回 200；私有库匿名会拿到 404，所以 200 就说明是公开的），
 * 页面标题为 `GitHub - Mench-Li/legion`。
 *
 * 放在这里而不是散在模板里，是为了这条链接**只有一处**：将来换仓库或撤回，
 * 改一行即可，不会漏掉某一页。
 */
const REPO_URL = 'https://github.com/Mench-Li/legion'

/** HTML 转义。本族所有插值都走它——没有例外，即使当前插值都来自配置。 */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * 这个地址能不能写进 `href`（只有 http/https）。
 *
 * ★ 为什么在**转义之外**还需要它：`esc()` 处理的是"这段文本会不会破坏 HTML"，
 *   而 `javascript:alert(1)` 是一个**完全合法的 HTML 属性值**——转义之后它照样
 *   会在点击时执行。两者防的不是同一件事。
 *
 *   > 一个"所有插值都转义了"的页面，
 *   > 与一个"转义了、但 href 里能塞 javascript: 协议"的页面，是同一个东西——
 *   > 只不过前者在代码审查时看起来已经处理过注入了。
 *
 * 备选线路来自配置文件（`parseDownloadLines` 已经拒过非 http(s)），但
 * `renderLiveBlocks` 是导出函数，调用方可以给任意数据——所以在这里再筛一次。
 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const p = new URL(value)
    return p.protocol === 'https:' || p.protocol === 'http:'
  } catch { return false }
}

/** 字节 → `183.4 MB`。给不出精确值时返回空串（宁可少一行，也不编一个数）。 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return `${(bytes / 1048576).toFixed(1)} MB`
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
    ctaSecond: '查看协作界面',
    explore: '探索 Legion',
    // 设计稿的首屏节奏是「两个动作 + 一行小字」，塞进一整段会把节奏压垮。
    // 首屏一句。**自包含**，不再写「见下方」——详细处理方式已按业主意见撤掉，
    // 留着那句就是一个指向空处的引用。签名状态由卡片上的徽标承担。
    ctaWarnShort: '当前为内部验证版：安装包未做代码签名。',
    deployWinEmpty: '桌面端安装包还没上传到这台 Hub；先向管理员索取。',
    notYet: '电脑版尚未发布',
    // T-196：备选线路那一段的前缀。措辞与 `.dl-meta` 同一路（短、无句号）。
    otherLines: '其他线路：',
    mobile: '打开手机端',
    regOpen: '这台 Hub 开放注册，打开手机端即可注册。',
    regInvite: '这台 Hub 开放注册（需要邀请码），打开手机端即可注册。',
    regClosed: '这台 Hub 未开放自助注册，请向管理员索取邀请码。',
    webRepo: '在 GitHub 上查看源码',
    trial: '产品演示（静态样本）',
    trialNote: '一个目标拆出的八个阶段任务，可点开看描述、验收标准与证据。示例数据，不连实例。',
    // ★ 未签名构建专有的说明。换签名构建时**这段必须跟着改**，否则它会变成
    //   "照它说的做、然后发现对不上"，而那种文案教会人忽略这一块。
  },
  en: {
    lang: 'en',
    cta: 'Download for Windows',
    ctaSecond: 'See the interface',
    explore: 'Explore Legion',
    ctaWarnShort: 'Internal build: the installer is not code-signed.',
    deployWin: 'Desktop and web share one backend and one set of data. It is at internal-validation stage: the installer is not code-signed, so Windows will push back — that is expected, not a broken download.',
    deployWinEmpty: 'No desktop installer has been uploaded to this Hub yet; ask the administrator.',
    notYet: 'Desktop build not yet published',
    otherLines: 'Other mirrors: ',
    mobile: 'Open the mobile app',
    regOpen: 'This Hub is open for sign-up — open the mobile app to register.',
    regInvite: 'This Hub is open for sign-up (invite code required) — open the mobile app to register.',
    regClosed: 'This Hub does not allow self sign-up; ask the administrator for an invite code.',
    webRepo: 'View the source on GitHub',
    trial: 'Product demo (static sample)',
    trialNote: 'One goal split into eight staged tasks — open any of them to see its description, acceptance criteria and evidence. Sample data; not connected to an instance.',
  },
})

/**
 * 造三个动态块的 HTML。**纯函数**，因此用例可以直接断言它写了什么。
 *
 * @param {object} input
 * @param {'zh'|'en'} input.lang
 * @param {string} input.downloadUrl  桌面版安装包的下载地址；留空 = 尚未发布。
 *        T-196 起，**服务端已经把它换成了按地区选中的那条线路**（见
 *        `server.mjs` 的 `describeDownload`），所以渲染层只认这一个主地址——
 *        多一个 `featuredUrl` 参数会让"主按钮到底用哪个"有两个来源。
 * @param {ReadonlyArray<object>} [input.lines] 备选线路（T-196）；空数组 = 不渲染那一段。
 * @param {'zh'|'en'} input.lang
 * @param {string} [input.version]    版本号（可空 —— 空就不显示这一行，不猜）
 * @param {string} [input.size]       已格式化的体积（可空）
 * @param {string} [input.date]       发布日期（可空）
 * @param {string} [input.registration] 'closed' | 'invite' | 'open'
 * @param {string} [input.mobilePath]
 */
export function renderLiveBlocks({
  lang = 'zh', downloadUrl = '', lines = [], version = '', size = '', date = '',
  registration = 'closed', mobilePath = MOBILE_PATH_DEFAULT,
} = {}) {
  const c = COPY[lang] ?? COPY.zh
  const has = String(downloadUrl).trim().length > 0
  const href = has ? esc(downloadUrl) : ''

  // ① Hero 的两个动作。设计稿写的是"首屏只设两个动作"；这里第一个动作在有发布时
  //    就是下载（我们确实有发布），没有发布时退回稿子原本的那一对，
  //    而不是给一个点开 404 的按钮。
  const cta = has
    ? `<div class="actions">
        <a href="${href}" class="btn primary">${c.cta}</a>
        <a href="#workflow" class="btn">${c.ctaSecond}</a>
      </div>
      <p class="hero-warn"><span class="warn">⚠</span> ${c.ctaWarnShort}</p>`
    : `<div class="actions">
        <a href="#workflow" class="btn primary">${c.ctaSecond}</a>
        <a href="#capabilities" class="btn">${c.explore}</a>
      </div>`

  // ② 下载块（部署区里那张 Windows 卡片的内容）。
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

  // 元信息：有哪几项就写哪几项，一项都没有就不出现这一行。等宽，与稿子的标签同一路。
  const metaBits = ['Windows x64', version ? `v${esc(version)}` : '', esc(size), esc(date)].filter((s) => s.length > 0)
  const meta = metaBits.length > 0
    ? `<p class="dl-meta">${metaBits.map((bit) => `<span>${bit}</span>`).join('<span class="sep">·</span>')}</p>`
    : ''

  // ③ 备选线路（T-196 多线路）。
  //
  // 为什么备选线路要**显示**而不是只留主按钮：按地区选线路用的是
  // Cloudflare 的 `CF-IPCountry`，而它对**部分**访客不准（VPN、企业出口、
  // 以及 `XX`/`T1` 这两个"不知道"的取值）。一个只给一条线路的页面，
  // 会让选错的那部分用户**没有任何办法**换一条。
  //
  //   > 一个"按地区自动选、选错了也没得换"的页面，
  //   > 与一个"只有一条线路"的页面，对那部分用户是同一个东西——
  //   > 只不过前者看起来更聪明。
  //
  // ★ 这里**再**筛一次协议：`parseDownloadLines` 已经拒了非 http(s)，
  //   但本函数是导出的纯函数，调用方可以传任意数据。`esc()` 只处理引号与
  //   尖括号，**不会**让 `javascript:` 变成无害的——而它会被直接写进 `href`。
  const otherLines = (Array.isArray(lines) ? lines : [])
    .filter((l) => l !== null && typeof l === 'object' && isHttpUrl(l.url))
  const othersRow = has && otherLines.length > 0
    ? `<p class="dl-lines">${c.otherLines}${otherLines
      .map((l) => `<a href="${esc(l.url)}">${esc(lang === 'en' ? (l.labelEn || l.label) : l.label)}</a>`)
      .join('<span class="sep">·</span>')}</p>`
    : ''

  // 下载卡片：一句话 + **一个**动作 + 元信息 + 未签名说明 + 摘要。
  // 按钮只留下载那一个 —— "查看协作界面"在首屏已经是第二个动作，这张卡片里再放一次
  // 是重复；而这张卡片的主题就是"把这个包装到你机器上"。
  const download = has
    ? `<div class="dl-actions">
         <a class="btn primary" href="${href}">${c.cta}</a>
       </div>
       ${othersRow}
       ${meta}`
    : `<p>${c.deployWinEmpty}</p>
       <div class="dl-actions"><span class="btn" aria-disabled="true">${c.notYet}</span></div>`

  // ③ 这台 Hub 自己的入口与注册状态。门口页原来承担的"这是什么、该去哪儿"，
  //    现在由官网承担——所以这一段不能丢。
  const reg = registration === 'open' ? c.regOpen
    : registration === 'invite' ? c.regInvite
      : c.regClosed
  const hub = `<p><a href="${REPO_URL}" rel="noopener">${c.webRepo}</a></p>
    <p>${reg}</p>
    <a href="${esc(mobilePath)}">${c.mobile}</a>`
  // ★ 「产品演示」暂时收起（业主 2026-10-09：先注释掉）。
  //   要恢复：把下面两行解开，并把 `dispatch` 里的 `/demo` 路由与 `routes` 表里的
  //   两条一起放开（`site/demo/index.html` 一直都在，没有被删）。
  //   `<p><a href="/demo">${c.trial}</a></p>
  //    <p class="small">${c.trialNote}</p>`

  return { cta, download, hub }
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
  /**
   * 入口页。`/` 是中文，`/en` 是英文（路径式双语），`/demo` 是只读演示。
   *
   * ★ `/demo` 暂时收起（业主 2026-10-09）。它的模板**没有被删** ——
   *   `site/demo/index.html` 一直在，`servePage` 的 `live: false` 分支也留着，
   *   恢复就是把 `routes` 表与 `dispatch` 里那两处注释解开。所以这里保留它：
   *   一个"注释掉就能恢复"的功能，不该顺手把它的家也拆了。
   */
  const PAGES = {
    zh: join(absRoot, 'index.html'),
    en: join(absRoot, 'en', 'index.html'),
    demo: join(absRoot, 'demo', 'index.html'),
  }

  // 模板缓存：只缓存**没有替换过**的模板，替换每次请求都做。
  const templates = new Map()

  /**
   * 样式表的版本串。取 `mtimeMs:size` —— 改一次样式就是一个新串。
   *
   * ★ 为什么必须要有它（2026-10-08 线上实测）：样式表没有内容哈希、也没有 ETag，
   *   而静态资源原本发 `max-age=86400`。隧道经 Cloudflare，边缘就把 `site.css`
   *   **缓存 24 小时**；入口页却是 `no-store`。于是重新部署之后，
   *   访问者拿到的是**新 HTML + 旧 CSS**：
   *
   *     实测症状 —— 页面上 `.sha` 那一段塌成行内、64 位摘要横着溢出，
   *     而 CSS 文件在服务器上明明是对的（`curl` 拉下来能看到规则）。
   *     浏览器里那份只有 122 条规则，且 **一条 `.sha*` 都没有**。
   *
   *   > 一个"文件在服务器上是新的"的事实，与一个"访问者拿到的是新的"的事实，
   *   > 在没人看过 DevTools 的 Network 面板时，是同一个东西。
   *
   *   版本串把它变成一个新 URL：既绕开边缘上已经缓存的那份，又让长缓存重新成立
   *   （URL 变了就是另一个资源）。比"把 max-age 调小"更好——调小只是把
   *   24 小时的窗口缩成几分钟，问题仍在，而每次访问都要回源。
   */
  function assetVersion() {
    try {
      const st = statSync(join(absRoot, 'assets', 'site.css'))
      return `${Math.round(st.mtimeMs)}-${st.size}`
    } catch { return '0' }
  }

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

  /**
   * 静态资源的缓存策略。**按"改了会不会坏页面"分，不按文件类型分。**
   *
   * · `.css` 长缓存 —— 但它的 URL 带版本串（`assetVersion()`），改了就是新 URL，
   *   所以长缓存是安全的，也是这里唯一值得长缓存的（每个页面都要它）。
   * · **图片短缓存（1 小时）** —— 文件名是固定的，重新截一张图不会换名。
   *   长缓存会让新截图最多 24 小时不生效；`no-store` 又让每次访问都重下 1MB。
   *   1 小时是这两者之间的选择：改图最迟 1 小时生效，重复访问不用重下。
   * · 其余一律 `no-store` —— 白名单里剩下的都是小文件，稳妥优先。
   */
  function cacheControlFor(ext) {
    if (ext === '.css') return 'public, max-age=86400, immutable'
    if (ext === '.png' || ext === '.svg' || ext === '.ico') return 'public, max-age=3600'
    return 'no-store'
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

  /**
   * 发入口页：读模板 → 注入动态块 → 送出。**入口页永不缓存**（它带着当次算出的下载地址）。
   *
   * `live: false` 的那一页（演示页）没有动态块，所以不调 `resolveRelease()` ——
   * 那是一次发布目录扫描，为一个静态页面每请求跑一遍是白花。
   */
  function servePage(req, res, lang, { live = true } = {}) {
    const abs = PAGES[lang]
    const template = readTemplate(abs)
    // 模板不存在 = 这个部署没有官网。返回 `false` 让请求落到门口页。
    if (template === null) return false
    // ★ 访客地区来自 **Cloudflare 注入的 `CF-IPCountry`**（本站经 Tunnel 对外，
    //   源站能直接读到）。读不到时传 null，由选线逻辑回退到默认线路——
    //   本地开发、直连部署、以及非 Cloudflare 前置的部署都走这一条。
    //
    //   刻意**不做**前端探测：那段 JS 本身要经同一条慢路送达，
    //   而"探测超时就选默认"在探测必然慢的那一侧总是选错。
    const country = typeof req.headers?.['cf-ipcountry'] === 'string'
      ? req.headers['cf-ipcountry']
      : null
    const r = live ? (resolveRelease({ country }) ?? {}) : {}
    const blocks = live
      ? renderLiveBlocks({
        lang,
        downloadUrl: r.url ?? '',
        // 备选线路：**不含**被选中的那条（服务端已经排除）。
        lines: Array.isArray(r.others) ? r.others : [],
        version: r.version ?? '',
        size: formatSize(r.sizeBytes),
        date: formatDate(r.at),
        registration,
        mobilePath,
      })
      : { cta: '', download: '', hub: '' }
    // 样式表 URL 挂上版本串（理由见 `assetVersion()`）。
    // 用 split/join 而不是 replace：替换串里没有 `$` 序列，但保持与注入同一套写法，
    // 免得将来有人在这里塞进一个带 `$&` 的值。
    const versioned = template
      .split('href="/site/assets/site.css"').join(`href="/site/assets/site.css?v=${assetVersion()}"`)
    const body = Buffer.from(injectLiveBlocks(versioned, blocks), 'utf8')
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
    // `/demo` 暂时收起（业主 2026-10-09）。`site/demo/index.html` 仍在，
    // 恢复时把这两条与下面 `dispatch` 里的那行一起解开即可。
    // { method: 'GET', path: '/demo' },
    // { method: 'HEAD', path: '/demo' },
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
      // `/demo` 暂时收起（业主 2026-10-09）：
      // if (path === '/demo' || path === '/demo/') return servePage(req, res, 'demo', { live: false })

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
        'cache-control': cacheControlFor(found.ext),
      }
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return true }
      res.writeHead(200, headers)
      createReadStream(found.abs).pipe(res)
      return true
    },
  }
}
