// workbench/mobile/sw.js
// Service Worker（远程 Agent 通道 S-F）
//
// ## 它**不**缓存 API
//
// 这是刻意的，也是这个文件最重要的一条纪律。一个缓存了 `/api/*` 的 Service Worker
// 会让"电脑离线"与"这是十分钟前的一次成功响应"在界面上长得一模一样——
// 而设计文档 §11 要求界面必须能区分这两者。
// 所以：静态资源走缓存优先，API 一律直连，事件流更是连碰都不碰。
//
// ## 导航请求的网络优先
//
// `index.html` 用网络优先：Hub 更新后手机刷新就能拿到新版本，不必等缓存过期。
// 取不到网络时才回落到缓存（离线时至少能看到壳，而不是浏览器错误页）。
const CACHE = 'legion-mobile-v1'
const SHELL = ['./', './index.html', './app.mjs', './timeline.mjs', './manifest.webmanifest']

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

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {})
        }
        return res
      })
    }),
  )
})
