// team-hub/routes/workbench.mjs
// ============================================================================
// 路由族：桌面工作台（`workbench` 的构建产物）的静态资源。
//
// ## 为什么把工作台也交给 Hub 托管
//
// 在这之前，完整工作台**只能在装了桌面端、或在本机跑 `serve.mjs` 时**才用得上。
// 浏览器里能打开的只有 `/mobile` 那个精简 PWA —— 也就是说"在电脑上用浏览器
// 使用 Legion"这件事**从来没有被部署过**（不是没做好，是没有）。
// 而桌面端的分发正好卡在签名上（Windows 11 的 Smart App Control 默认开启，
// 会拒绝运行**未签名**的安装包）。
//
// 托管到 Hub 之后，"打开一个网址就能用完整工作台"不再需要安装任何东西。
//
// ## 与 `serve.mjs` 的关系：**一份产物，两个宿主**
//
// 构建用 `base: './'`（相对路径），于是同一份 `dist`：
//   · 挂在 `/`（`serve.mjs`，本地开发/桌面端）→ 资源解析成 `/assets/…`；
//   · 挂在 `/workbench/`（Hub，远程）→ 资源解析成 `/workbench/assets/…`。
// 两处都不需要改宿主。**刻意不用绝对 base**：那会把 `serve.mjs` 一起弄坏，
// 而"为了新增一个宿主去改坏另一个宿主"不是一个好交易。
//
// ## 为什么**不需要** SPA 回退（`/workbench/任意深链接` → index.html）
//
// 因为工作台**没有客户端路由**：没有 react-router、没有 `pushState`、
// 没有 `location.pathname`（逐个查过）。它靠状态切换视图，只有一个入口 URL。
// 所以"深链接"这件事不存在，也就不需要那条最容易写错的回退规则。
//
//   ⚠️ 如果将来给它加了真路由，**这里必须同时加回退**，而且要做成
//      「导航请求回 index.html / 资源请求（带扩展名）如实 404」——
//      对任何未知路径都回 index.html 的写法，会让缺失的 `/assets/*.js`
//      拿到 200 + `text/html`，浏览器报的是 MIME 类型错误，
//      而真正的原因（文件不在）再也看不见。`serve.mjs` 就踩过这一条。
//
// ## 认证
//
// 静态资源本身**免鉴权**（它是页面本身，而鉴权发生在页面发出的 API 调用上）——
// 与 `/mobile` 同一个理由，所以它也必须注册在远程门禁**之前**。
// 页面自己的登录门在 `src/App.tsx` 里：探测 `/api/identity/status`，
// `remoteAuthRequired && enabled && !hasSession()` 时整页渲染 `LoginView`。
// ============================================================================
import { createStaticTreeRoutes } from './static-tree.mjs'

/**
 * 工作台产物里可能出现的类型。白名单：不在表里的一律 404。
 *
 * 比手机端多出字体与位图这几类（Vite 产物 + `three.js` 场景资源）。
 * ★ **刻意不收 `.map`**：产物默认不带 sourcemap，而万一带上了，
 *   把它公开出去等于把源码随静态托管一起发布。少一个类型只是 devtools
 *   里一条 404，多一个类型是一次信息泄露。
 */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
})

/** 不缓存的类型：入口必须每次回源，否则发新版后用户拿不到。 */
const NO_STORE = Object.freeze(['.html'])

/**
 * 造工作台静态路由族。
 *
 * @param {object} deps
 * @param {string} deps.root   产物目录（`workbench/dist` 的绝对路径）
 * @param {string} [deps.mount] 挂载前缀，默认 `/workbench`
 */
export function createWorkbenchRoutes({ root, mount = '/workbench' } = {}) {
  return createStaticTreeRoutes({
    id: 'workbench',
    root,
    mount,
    mime: MIME,
    noStore: NO_STORE,
    // Vite 的 `/assets/` 下都是带内容哈希的文件名：改内容就换名字，
    // 所以可以永久缓存。而 `index.html` 不在这下面（它必须 no-store）。
    immutablePrefix: '/assets/',
    // 工作台不是 PWA，没有 Service Worker 要放 scope。
    workerAllowed: null,
  })
}
