// team-hub/routes/portal.mjs
// ============================================================================
// Hub 的**门口**（`GET /`）。
//
// ## 为什么必须有这一页
//
// 在此之前，把一个刚部署好的 Hub 地址发给人，他看到的是：
//
//     {"error":"缺少访问令牌","code":"REMOTE_AUTH_MISSING"}
//
// 那是一句**对机器说的话**。它没有告诉来人这是什么、能做什么、该去哪儿——
// 而"发个链接给人"恰恰是产品被使用的第一步。
//
//   > 一个只对已登录用户才说得清自己是什么的服务，
//   > 与一个还没装好的服务，在第一次打开它的人眼里是同一个东西。
//
// ## 这一页**不发任何数据**
//
// 它只回一段静态 HTML + 从配置读来的下载地址。没有用户列表、没有空间名、
// 没有版本探测之外的任何读数——门口贴的牌子不该把屋里的东西念出来。
//
// ## 下载地址来自配置，且**没配就如实说没配**
//
// `LEGION_DOWNLOAD_URL` 留空时页面写的是"桌面版尚未发布"，而不是给一个
// 点开 404 的假链接。一个假的下载按钮比没有按钮更坏：用户会以为是自己
// 的网络或浏览器有问题，然后反复试。
// ============================================================================

/** HTML 转义。本页所有插值都走它——没有例外，即使当前的插值都来自配置。 */
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * 造门口那一页的 HTML。**纯函数**，因此用例可以直接断言它写了什么。
 *
 * @param {object} input
 * @param {string} input.downloadUrl 桌面版下载地址；留空 = 尚未发布
 * @param {string} input.version     桌面版版本号（可空）
 * @param {string} input.registration 'closed' | 'invite' | 'open'
 * @param {string} input.mobilePath  手机端挂载点
 */
export function renderPortal({ downloadUrl = '', version = '', registration = 'closed', mobilePath = '/mobile/' } = {}) {
  const hasDownload = String(downloadUrl).trim().length > 0
  const canRegister = registration === 'open' || registration === 'invite'
  const registerLine = canRegister
    ? `<p class="hint">这台 Hub 开放注册${registration === 'invite' ? '（需要邀请码）' : ''}。打开手机端即可注册。</p>`
    : '<p class="hint">这台 Hub 未开放自助注册；请向管理员索取邀请码。</p>'

  // 下载卡片：有地址给链接，没有就给一句实话 + 该找谁要。
  //
  // ★ 那段"Windows 会拦一下"是**未签名构建**专有的，不是永远为真 ——
  //   手上这份发布（`r-2026-10-06_0.1.0`）的 PE 证书表是空的（实测），
  //   manifest 自己也写着"双击会被 Windows SmartScreen 拦"。
  //
  //   将来出签名构建时，**这段必须跟着改**（或变成按构建是否签名来开关）：
  //   一段对着不会出现的警告做说明的文案，与一段漏掉真会出现的警告的文案，
  //   在用户那里同形 —— 都是"照它说的做，然后发现对不上"，而后者更坏一点，
  //   因为它教会人忽略这一块。这也是把它放在**拿到链接之前**的原因：
  //   用户该在点之前知道要发生什么，而不是拦下来之后去猜是不是自己下坏了。
  const downloadCard = hasDownload
    ? `<a class="card primary" href="${esc(downloadUrl)}">
      <strong>下载电脑版</strong>
      <span>Windows x64${version ? `　v${esc(version)}` : ''}</span>
    </a>
    <p class="notice">安装包<b>尚未做代码签名</b>（那要一张证书）。所以 Windows 会拦一下 —— 那是预期的，不是包坏了：<br />
      ① 浏览器下载时若提示"不常见"，点<b>保留</b>；<br />
      ② 双击运行时出现"未知发布者"，点<b>更多信息 → 仍要运行</b>。<br />
      ⚠️ 例外：若系统开着 <b>Smart App Control</b>（Windows 11 全新安装默认开），它会<b>直接阻止且不给"仍要运行"</b>。关掉它可以装，但关掉之后要重装系统才能再打开 —— 这台机器请改用别的机器下载。</p>`
    : `<div class="card disabled">
      <strong>电脑版尚未发布</strong>
      <span>安装包还没上传到这台 Hub；先向管理员索取。</span>
    </div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<title>Legion</title>
<link rel="icon" href="${esc(mobilePath)}icon-192.png" />
<style>
:root { --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --fg:#e6e9ef; --muted:#9aa3b2; --accent:#6ea8fe; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --line:#dfe3e9; --fg:#141821; --muted:#5b6577; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg);
  font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  display:flex; align-items:center; justify-content:center; padding:24px; }
main { width:100%; max-width:420px; }
h1 { font-size:28px; margin:0 0 4px; letter-spacing:.5px; }
.tagline { color:var(--muted); margin:0 0 24px; }
a.card, .card { display:block; background:var(--panel); border:1px solid var(--line); border-radius:14px;
  padding:14px 16px; margin-bottom:12px; text-decoration:none; color:inherit; }
a.card:hover { border-color:var(--accent); }
a.card.primary { border-color:var(--accent); }
.card strong { display:block; font-size:16px; }
.card span { display:block; color:var(--muted); font-size:13px; margin-top:2px; }
.card.disabled { opacity:.6; }
.notice { color:var(--muted); font-size:13px; line-height:1.7; margin:10px 2px 0; }
.notice b { color:var(--fg); }
.hint { color:var(--muted); font-size:13px; margin-top:18px; }
</style>
</head>
<body>
<main>
  <h1>Legion</h1>
  <p class="tagline">在手机上查看和指挥你的 Agent，代码和工具继续运行在你的电脑上。</p>

  <a class="card primary" href="${esc(mobilePath)}">
    <strong>打开手机端</strong>
    <span>登录后即可看板与对话；可安装到主屏</span>
  </a>

  ${downloadCard}

  ${registerLine}
  <p class="hint">注册与登录都在手机端页面上；电脑版与手机端共用同一套账号。</p>
</main>
</body>
</html>
`
}

/**
 * 门口路由族。
 *
 * 只有一条 GET `/`。**不做**重定向到手机端：那样一来，来人还没看清这是什么
 * 就被送进一个登录页——而登录页回答不了"这服务是什么"。
 *
 * ## `downloadUrl` 可以是**函数**：发布一份新版本之后，门口页必须立刻指向它
 *
 * 这里原来把整页 HTML 渲染成**常量**（`const html = renderPortal(...)`），
 * 于是"最新的一份安装包"被冻在**服务启动的那一刻**——
 *
 *   实际代价（2026-10-07）：往发布目录里传了一份新版本，
 *   首页**仍然**指向上一版，因为服务是传之前启动的。
 *   重启之后就对了 —— 而"要重启"这件事没有任何一处写得出来，
 *   症状是"发了新版，用户下到的还是旧版"，**没有一个地方会报错**。
 *
 *   > 一个把"最新"算在启动时的页面，与一个把"最新"算在配置里的页面，
 *   > 在运营者按下"上传"之后的那一分钟里，是同一个东西 ——
 *   > 都是发旧版，且都看起来正常。
 *
 * 所以：`downloadUrl` 传字符串就照旧（显式配置那条路不变），
 * 传函数就**每次请求现算**。现算的代价是每个首页请求几次 `readdir`/`stat`，
 * 而这一页本来就是最冷的页面。
 */
export function createPortalRoutes({ downloadUrl = '', version = '', registration = 'closed', mobilePath = '/mobile/' } = {}) {
  const resolveUrl = typeof downloadUrl === 'function' ? downloadUrl : () => downloadUrl
  const routes = [
    { method: 'GET', path: '/' },
    { method: 'HEAD', path: '/' },
  ]
  return {
    id: 'portal',
    routes,
    async dispatch(req, res, ctx) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false
      if (ctx.path !== '/') return false
      const html = renderPortal({ downloadUrl: resolveUrl(), version, registration, mobilePath })
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        // 配置改了要能立刻看到，别让中间层缓存住一个过期的门口。
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      // HEAD 要有同样的头但**没有正文**（健康检查与链接预览都走它）。
      if (req.method === 'HEAD') { res.end(); return true }
      res.end(body)
      return true
    },
  }
}
