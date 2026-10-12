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

// ★ 2026-10-12：这里原本还有三个只服务于下载卡片的辅助函数 ——
//   `isHttpUrl`（协议白名单，防 `javascript:` 进 href）、`formatSize`（体积）、
//   `formatDate`（日期）。卡片撤掉之后它们在本文件里**没有任何调用方**。
//
//   处理方式各不相同，因为"没用到的代码"与"没用到的**判断**"不是一回事：
//     · `formatSize` / `formatDate` —— 直接删。它们是纯格式化，没有别处要用。
//     · `isHttpUrl` —— **搬到 `portal.mjs`**（并改名 `isSafeHref`、放宽成
//       也接受站内相对路径）。门口页仍然会写出一个下载链接
//       （`esc(downloadUrl)`），而 `esc()` 挡不住 `javascript:`：那是一个完全
//       合法的属性值，转义之后照样会在点击时执行。
//
//       > 一个"所有插值都转义了"的页面，
//       > 与一个"转义了、但 href 里能塞 javascript: 协议"的页面，是同一个东西。
//
//       把它删掉会让门口页失去这道判断；把它留在这里则是一段永远不执行的代码。
//       所以它跟着**那个还存在的 href** 走。

/**
 * 两种语言的动态块文案。静态正文在 `site/*.html` 里，这里只放**要现算**的那几句。
 */
const COPY = Object.freeze({
  zh: {
    lang: 'zh-CN',
    // ★ 2026-10-12：首屏的主动作从"下载电脑版"改成"打开就能用"（→ Web 端）。
    //
    //   理由不是文案偏好，而是一个实测事实：Windows 11 的 Smart App Control
    //   在**默认开启**的新装机上会拒绝运行**未签名**的安装包
    //   （原文：`was blocked by your organization's Device Guard policy`）。
    //   也就是说首屏那个主按钮，对相当一部分访客**点了装不上**。
    //
    //   > 一个"点了装不上"的主按钮，
    //   > 与一个"能用的入口"，在页面截图上长得一模一样——
    //   > 只不过前者让访客以为是自己机器坏了。
    //
    // ★ 2026-10-12（当天稍后）：桌面端下载**整块撤掉**了，不再有"次要入口"。
    //   上一版把桌面端降级成部署卡里的第二张卡，仍然在页面上教人"先把包装上"——
    //   而这条产品线现在的主打是 Web + 移动端。留着那张卡等于用一个次要位置
    //   继续宣告"桌面端是主要用法"，只是声音小一点。
    //
    //   > 一个"被降到次要位置"的入口，
    //   > 与一个"被删掉"的入口，对**只看标题和徽标**的访客是同一个东西。
    //
    //   所以这里不再有 `cta`（下载电脑版）/`notYet`（尚未发布）/`otherLines`
    //   （备选线路）/`deployWinEmpty` 这些串：**没有地方会用到它们了**。
    //   发布目录（`/legion/*`）与桌面端自动更新**不受影响**，只是官网上不再提。
    ctaWeb: '打开就能用',
    ctaSecond: '查看协作界面',
    explore: '探索 Legion',
    mobile: '打开就能用',
    regOpen: '这台 Hub 开放注册，打开即可注册。',
    regInvite: '这台 Hub 开放注册（需要邀请码），打开即可注册。',
    regClosed: '这台 Hub 未开放自助注册，请向管理员索取邀请码。',
    webRepo: '在 GitHub 上查看源码',
    trial: '产品演示（静态样本）',
    trialNote: '一个目标拆出的八个阶段任务，可点开看描述、验收标准与证据。示例数据，不连实例。',
  },
  en: {
    lang: 'en',
    ctaWeb: 'Open in your browser',
    ctaSecond: 'See the interface',
    explore: 'Explore Legion',
    mobile: 'Open in your browser',
    regOpen: 'This Hub is open for sign-up — open it to register.',
    regInvite: 'This Hub is open for sign-up (invite code required) — open the mobile app to register.',
    regClosed: 'This Hub does not allow self sign-up; ask the administrator for an invite code.',
    webRepo: 'View the source on GitHub',
    trial: 'Product demo (static sample)',
    trialNote: 'One goal split into eight staged tasks — open any of them to see its description, acceptance criteria and evidence. Sample data; not connected to an instance.',
  },
})

/**
 * 造两个动态块的 HTML。**纯函数**，因此用例可以直接断言它写了什么。
 *
 * @param {object} input
 * @param {'zh'|'en'} input.lang
 * @param {string} [input.registration] 'closed' | 'invite' | 'open'
 * @param {string} [input.mobilePath]
 *
 * ★ 2026-10-12：**下载块没了**，所以这里只剩两块（首屏动作 + Web 入口）。
 *   它原本叫"造三个动态块"，第三块渲染的是 Windows 安装包卡片。
 *
 *   随之撤掉的还有那五个只服务于它的参数（`downloadUrl` / `lines` / `version` /
 *   `size` / `date`）。留着不用的参数会变成**看起来还能配、其实什么也不发生**
 *   的旋钮——而那种东西比没有更坏：有人会照着它写配置，然后以为是自己写错了。
 *
 *   发布目录（`GET /legion/*`）与桌面端自动更新**都不受影响**：它们从来不经过
 *   这个函数。这里撤掉的只是"官网上那个下载按钮"。
 */
export function renderLiveBlocks({
  lang = 'zh', registration = 'closed', mobilePath = MOBILE_PATH_DEFAULT,
} = {}) {
  const c = COPY[lang] ?? COPY.zh

  // ① Hero 的两个动作。
  //
  // ★ 2026-10-12：主动作是**打开就能用**（→ Web 端），它**不再取决于有没有发布**。
  //
  //   原先主动作在"有发布"时是下载安装包、在"没发布"时退回 `#workflow`。那条
  //   分支隐含一个假设：桌面安装包是主入口。而实测发现 Windows 11 的
  //   Smart App Control（新装机**默认开启**）会拒绝运行未签名的安装包 ——
  //   于是那个主按钮对相当一部分访客**点了装不上**。
  //
  //   > 一个"点了装不上"的主按钮，
  //   > 与一个"能用的入口"，在页面截图上长得一模一样——
  //   > 只不过前者让访客以为是自己机器坏了。
  //
  //   Web 端不需要安装、不需要签名、也不受 SAC 影响，所以它才是主入口，
  //   而且**跟有没有发布无关** —— 这条分支因此消失了（少一处会漂的地方）。
  const cta = `<div class="actions">
        <a href="${esc(mobilePath)}" class="btn primary">${c.ctaWeb}</a>
        <a href="#workflow" class="btn">${c.ctaSecond}</a>
      </div>`

  // ② 这台 Hub 自己的入口与注册状态。门口页原来承担的"这是什么、该去哪儿"，
  //    现在由官网承担——所以这一段不能丢。
  //
  // ★ 2026-10-12：这一格的主动作也是"打开就能用"，而且**与首屏同一个地址**
  //   （`mobilePath`）。原先它只给了一个纯文本链接，而首屏给的却是下载按钮 ——
  //   两处对"主入口是谁"给出了相反的答案。
  //
  //   > 一个"首屏说打开就能用、部署区说下载电脑版"的官网，
  //   > 与一个只有其中一种说法的官网，在有人**两处都看**之前是同一个东西。
  //
  // ★ 用**独立的 class**（`hub-actions`）：用例与 CSS 都要能指名道姓地说
  //   "我说的是哪一块"，而不是靠**文档顺序**推断 —— 顺序是模板里一个标记的位置，
  //   是随时会动的东西。
  //
  //   （`dl-actions` 现在**没有任何地方**再产出它了。CSS 里那几条规则暂时留着：
  //     它们是纯样式、不产生行为，而删掉它们的收益只是少几行。等下一次真的重构
  //     部署区时一起清。）
  const reg = registration === 'open' ? c.regOpen
    : registration === 'invite' ? c.regInvite
      : c.regClosed
  const hub = `<div class="hub-actions">
      <a class="btn primary" href="${esc(mobilePath)}">${c.ctaWeb}</a>
    </div>
    <p>${reg}</p>
    <p><a href="${REPO_URL}" rel="noopener">${c.webRepo}</a></p>`
  // ★ 「产品演示」暂时收起（业主 2026-10-09：先注释掉）。
  //   要恢复：把下面两行解开，并把 `dispatch` 里的 `/demo` 路由与 `routes` 表里的
  //   两条一起放开（`site/demo/index.html` 一直都在，没有被删）。
  //   `<p><a href="/demo">${c.trial}</a></p>
  //    <p class="small">${c.trialNote}</p>`

  return { cta, hub }
}

/**
 * 把标记替换进模板。**纯函数**：同一个模板 + 同一份数据 → 同一份输出。
 *
 * 用 `split/join` 而不是 `replace`：后者在替换串里出现 `$&` 一类序列时会被
 * 当成替换模式解释掉，而这些替换串来自**运营者可配的值**（`mobilePath`）。
 *
 * ★ 2026-10-12：`MARKER_DOWNLOAD` **仍然被替换，但替换成空串**。
 *   两个理由，都不是洁癖：
 *
 *   ① 真实模板里的那个标记已经被删了（两张卡里第二张换成了"同一份数据"）。
 *      但**别的部署**可能还留着一份旧模板，而模板是运营者机器上的文件。
 *      一个没人替换的标记会**原样出现在页面上**（`<!-- legion:download -->`
 *      是 HTML 注释，访客看不见，但它证明"这里本该有东西"）。
 *   ② 更实际的是：这个函数是导出的纯函数，用例会拿**自造模板**来调它。
 *      保留这一行让"标记 → 空"成为一条**可断言的行为**，而不是靠调用方记得
 *      自己先删掉标记。
 */
export function injectLiveBlocks(template, blocks) {
  return String(template)
    .split(MARKER_CTA).join(blocks.cta)
    .split(MARKER_DOWNLOAD).join('')
    .split(MARKER_HUB).join(blocks.hub)
}

/**
 * 造官网路由族。
 *
 * @param {object} deps
 * @param {string} deps.root        站点目录（绝对路径），里面是 `index.html` / `en/index.html` / `assets/`
 * @param {string} [deps.mount]     静态资源挂载前缀，默认 `/site`
 * @param {string} [deps.registration] 'closed' | 'invite' | 'open'
 * @param {string} [deps.mobilePath]
 *
 * ★ 2026-10-12：`readRelease` 参数**撤掉了**。它存在的唯一理由是给下载卡片
 *   填版本/体积/日期，而那张卡片已经从官网上移除。留着一个"传进来但没人用"
 *   的依赖，会让调用方以为官网上还有下载区。
 */
export function createSiteRoutes({
  root, mount = '/site',
  registration = 'closed', mobilePath = MOBILE_PATH_DEFAULT,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('createSiteRoutes 需要 root')
  const absRoot = resolve(root)
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount

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
   * 发入口页：读模板 → 注入动态块 → 送出。**入口页永不缓存**。
   *
   * ★ 2026-10-12：这里原先还读 `CF-IPCountry` 并按地区选**下载线路**。
   *   那个功能唯一的用途是下载卡片上那一个按钮指向哪条线；卡片撤掉之后，
   *   读地区就成了一次**读了没人用**的动作 —— 而它看起来还像在工作
   *   （请求头照读、`readRelease` 照调）。所以一并撤掉：
   *   没有下载按钮，就没有"这个按钮该指向哪"。
   *
   *   按地区选线本身**没有消失**，它搬到门口页继续用（`describeDownload`
   *   仍然被 `createPortalRoutes` 用着）—— 那里还有一个下载按钮。
   *
   * `live: false` 的那一页（演示页）没有动态块，所以不注入。
   */
  function servePage(req, res, lang, { live = true } = {}) {
    const abs = PAGES[lang]
    const template = readTemplate(abs)
    // 模板不存在 = 这个部署没有官网。返回 `false` 让请求落到门口页。
    if (template === null) return false
    const blocks = live ? renderLiveBlocks({ lang, registration, mobilePath }) : { cta: '', hub: '' }
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
