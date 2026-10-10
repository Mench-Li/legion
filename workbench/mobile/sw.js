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
// v4：2026-10-10 预缓存清单同时加了 `popup.mjs`（BUG-021 提醒弹框）与
// `avatar.mjs`（T-199 拟人头像）——两条改动各自都动了这个清单，合并时**取并集**。
// 版本号一变，`activate` 就会把旧缓存整个删掉：不然装在桌面上的那份旧壳里会缺一个模块
// （而代码走网络优先，平时看不出这一点，只在"装好 SW 后立刻离线"时露馅）。
const CACHE = 'legion-mobile-v4'
// ★ 这份清单必须覆盖 `index.html` 引到的**每一个模块**。
//
//   实测踩过：`refresh-loop.mjs` 是后加的一个模块，而这份清单没跟着更新。
//   静态资源走网络优先，所以第一次成功加载之后它自己会进缓存——**平时看不出来**。
//   只有"装好 Service Worker 之后立刻离线"那一种情形会露馅，而那恰好是
//   PWA 最想守住的那一种情形。
//
//   下面那条用例（`workbench/scripts/sw-shell.test.mjs`）直接对着
//   `index.html` 的 `<script>` 与各模块的 import 语句核对，不靠人记得同步。
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  // 入口 + 它的直接依赖（合并时**取并集**：提醒的 popup.mjs 与头像的 avatar.mjs 都要在）
  './app.mjs', './board.mjs', './timeline.mjs', './refresh-loop.mjs', './popup.mjs', './avatar.mjs',
]
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
