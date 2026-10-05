// workbench/mobile/sw.js
// Service Worker（远程 Agent 通道 S-F）
//
// ## 它**不**缓存 API
//
// 这是刻意的，也是这个文件最重要的一条纪律。一个缓存了 `/api/*` 的 Service Worker
// 会让"电脑离线"与"这是十分钟前的一次成功响应"在界面上长得一模一样——
// 而设计文档 §11 要求界面必须能区分这两者。
// 所以：静态资源按下面的规矩走，API 一律直连，事件流更是连碰都不碰。
//
// ## 代码走网络优先，图标走缓存优先
//
// 这一条是**踩过的**：原来所有静态资源都是缓存优先，于是 `app.mjs` 一被缓存就
// 永远是那一份——部署新版本之后手机还在跑旧代码，而页面上**没有任何症状**。
//
//   > 一个"缓存优先的脚本"与一个"部署没生效"，在手机上看起来是同一个东西；
//   > 只不过前者永远不会因为新版本而变，所以它也不会因为新版本被修好。
//
// 分界按**它会不会被改**来划：
//   · 代码（`app.mjs` / `board.mjs` / `timeline.mjs`）与入口 —— 网络优先，
//     取不到才回落到缓存（离线时至少能看到壳，而不是浏览器错误页）；
//   · 图标、manifest —— 缓存优先，它们是内容不常变的二进制，省流量。
//
// 服务器对入口与脚本本来就发 `Cache-Control: no-cache`（见 `mobile-routes.test.mjs`
// 那条"发新版后手机能拿到新代码"）。缓存优先的 SW 会把那条**抵消掉**——
// 两处规矩各写一半，合起来正好是谁都没生效。
const CACHE = 'legion-mobile-v2'
const SHELL = ['./', './index.html', './app.mjs', './board.mjs', './timeline.mjs', './manifest.webmanifest']
const CODE_EXT = /\.(?:mjs|js|html|webmanifest)$/

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** 网络优先：成功就顺手更新缓存；失败回落缓存。 */
function networkFirst(event) {
  return fetch(event.request).then((res) => {
    if (res.ok) {
      const copy = res.clone()
      caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
    }
    return res
  }).catch(() => caches.match(event.request).then((r) => r ?? Response.error()))
}

/** 缓存优先：命中即返回，未命中再取网络并写入。 */
function cacheFirst(event) {
  return caches.match(event.request).then((hit) => {
    if (hit) return hit
    return fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
      }
      return res
    })
  })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // 只处理同源；跨源（别的 Hub）不插手。
  if (url.origin !== self.location.origin) return
  // ★ API 与事件流一律不缓存、不拦截。见文件头。
  if (url.pathname.startsWith('/api/') || url.pathname === '/node') return
  if (event.request.method !== 'GET') return

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {})
        return res
      }).catch(() => caches.match('./index.html').then((r) => r ?? Response.error())),
    )
    return
  }

  event.respondWith(CODE_EXT.test(url.pathname) ? networkFirst(event) : cacheFirst(event))
})
