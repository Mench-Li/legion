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
// ## 路径安全与裸挂载点重定向
//
// 都在 `static-tree.mjs` 里，只有一份 —— 包括那条实测过的坑：
// `/mobile`（**无尾斜杠**）若不重定向，页面里的 `./app.mjs` 会被浏览器
// 解析成 `/app.mjs`，于是**页面加载出来但资源全 404**。
// 桌面工作台（`./workbench.mjs`）与这里共用同一份实现，差异全在参数上。
// ============================================================================
import { createStaticTreeRoutes } from './static-tree.mjs'

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
  // ★ 2026-10-13：成员头像改用 256px WebP（照片走 PNG 每张 100KB+，WebP 约 8KB）。
  //   这一条不加，手机上所有头像都 404 —— 而桌面端正常，所以只会在手机端暴露。
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
})

/** 不缓存的类型：入口与脚本必须每次回源，否则发新版后用户拿不到。 */
const NO_STORE = Object.freeze(['.html', '.mjs', '.js', '.webmanifest'])

/**
 * 造手机端静态路由族。
 *
 * @param {object} deps
 * @param {string} deps.root  PWA 资源目录（绝对路径）
 * @param {string} [deps.mount] 挂载前缀，默认 `/mobile`
 */
export function createMobileRoutes({ root, mount = '/mobile' } = {}) {
  const prefix = mount.endsWith('/') ? mount.slice(0, -1) : mount
  return createStaticTreeRoutes({
    id: 'mobile',
    root,
    mount,
    mime: MIME,
    noStore: NO_STORE,
    // 图标等非代码资源保持一天：手机上换图标不频繁，而每次回源都走蜂窝网。
    immutablePrefix: null,
    // PWA 的关键头：Service Worker 与 manifest 都要能读到自己。
    // 不放它的话，SW 的 scope 会被限制在自己的目录里。
    workerAllowed: `${prefix}/`,
  })
}
