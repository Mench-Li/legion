// product/update/host.mjs
// ============================================================================
// 静态托管布局 —— 设计 §4，以及"HTTP 测试不授权正式更新"这条纪律
//
// 托管只有"能公开读文件"这一个要求。这带来两个后果，本模块各管一个：
//
//   ① **URL 形状是协议的一部分。** `feeds/<channel>/<platform>-<arch>.json`
//      与 `releases/<releaseId>/...` 不是随手起的名字：前者是唯一可变的对象，
//      后者必须不可覆盖（设计 §4 line 78）。把布局写成一个函数，是为了让
//      "客户端拼出来的 URL"和"发布端上传到的位置"只有一份定义。
//
//   ② **HTTP 只用于测试。** 计划文档（2026-10-04）最后一段是原话：
//      「HTTP 测试不授权正式更新；正式环境必须使用可信 HTTPS。没有域名时
//        不把自签证书或关闭证书验证作为正式方案。」
//      所以 `http:` origin 只有在调用方**显式**声明"这是测试"时才可用，
//      而且返回的配置里带着 `production: false`，一路传到界面与日志里。
//      一个"忘了配置 HTTPS 于是静默跑在 HTTP 上"的客户端，与一个
//      "中间人可以把清单换成任意内容"的客户端，是同一个东西。
//
// ## 缓存策略为什么要在客户端核
//
// 设计 §4 line 79 要求通道清单 `Cache-Control: no-store`，发布目录可长期缓存。
// 这条命令由托管方执行，客户端能做的是：**核**。不核的话，一个把通道清单
// 配成一小时缓存的 CDN 会让用户"明明发布了新版却看不到"，而排查方向会
// 全落在客户端代码上。所以 `evaluateCachePolicy` 是一个明确的、可测的判据。
// ============================================================================

import { RELEASE_CHANNELS } from '../upgrade/channels.mjs'
import { validateRelativePath } from './release.mjs'

/** 正式环境的缓存策略（设计 §4 line 79）。 */
export const RELEASE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
/** 通道清单必须完全不可缓存。 */
export const FEED_CACHE_CONTROL = 'no-store'

export const HOST_CODES = Object.freeze({
  BAD_ORIGIN: 'host-bad-origin',
  INSECURE_ORIGIN: 'host-insecure-origin',
  BAD_PREFIX: 'host-bad-prefix',
  BAD_CHANNEL: 'host-bad-channel',
  CROSS_ORIGIN: 'host-cross-origin',
  BAD_STATUS: 'host-bad-status',
  BAD_CACHE: 'host-bad-cache',
  BAD_LENGTH: 'host-bad-length',
  REDIRECT: 'host-redirect',
})

function hostProblem(code, message) {
  return Object.freeze({ code, message })
}

/**
 * 平台 → 文件名词干。
 *
 * 设计 §4 的目录样例写的是 `feeds/stable/win-x64.json`、`legion-win-x64.zip`、
 * `Legion-Setup-win-x64.exe`——文件名里用的是 `win`，而清单字段里用的是
 * `win32`（Node 的 `process.platform`）。两者是同一个平台的两种写法，
 * 于是必须有**唯一**一处映射，否则"客户端拼的 URL"和"发布端上传的名字"
 * 会在某一次发布里对不上，而那时的表现是 404。
 */
export const PLATFORM_TOKENS = Object.freeze({ win32: 'win', darwin: 'mac', linux: 'linux' })

export function platformToken(platform) {
  return PLATFORM_TOKENS[platform] ?? null
}

/** 通道 → 平台/架构 → 通道清单的相对路径。**唯一**的定义处。 */
export function feedRelativePath(channel, platform, arch) {
  const token = platformToken(platform) ?? platform
  return `feeds/${channel}/${token}-${arch}.json`
}

/** 发行清单的相对路径。发行目录不可覆盖，所以这个 URL 是稳定的。 */
export function releaseManifestRelativePath(releaseId) {
  return `releases/${releaseId}/manifest.json`
}

/**
 * 建立托管配置。
 *
 * @param {object} args
 * @param {string} args.origin        例如 `https://updates.example.com` 或测试机 `http://117.72.146.36`
 * @param {string} [args.prefix]      存储前缀，例如 `/legion` 或 `/test/legion`
 * @param {string} args.channel
 * @param {string} [args.platform]
 * @param {string} [args.arch]
 * @param {boolean} [args.allowInsecureHttp] 仅测试：显式允许 `http:`
 */
export function createHostConfig({
  origin, prefix = '/legion', channel, platform = 'win32', arch = 'x64', allowInsecureHttp = false,
} = {}) {
  const problems = []
  if (typeof origin !== 'string' || origin === '') {
    problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, 'origin 必须是非空字符串'))
  }
  if (!RELEASE_CHANNELS.includes(channel)) {
    problems.push(hostProblem(HOST_CODES.BAD_CHANNEL, `channel 必须是 ${RELEASE_CHANNELS.join('/')}`))
  }
  if (typeof prefix !== 'string' || !/^\/[A-Za-z0-9\-._/]*$/.test(prefix) || prefix.includes('..') || prefix.includes('//')) {
    problems.push(hostProblem(HOST_CODES.BAD_PREFIX, `prefix 不合法：${JSON.stringify(prefix)}`))
  }
  let url = null
  if (problems.length === 0) {
    try { url = new URL(origin) } catch { problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, `origin 不是合法 URL：${origin}`)) }
  }
  if (url !== null) {
    if (url.username !== '' || url.password !== '') {
      problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, 'origin 不能带凭据'))
    }
    if (url.search !== '' || url.hash !== '') {
      problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, 'origin 不能带查询串或片段'))
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, `origin 不应带路径（用 prefix）：${url.pathname}`))
    }
    // ★ HTTP 必须被**显式**允许，而且不能是正式配置。
    if (url.protocol === 'http:' && allowInsecureHttp !== true) {
      problems.push(hostProblem(HOST_CODES.INSECURE_ORIGIN,
        `拒绝在 ${origin} 上做更新：正式更新必须使用 HTTPS；测试请显式声明 allowInsecureHttp`))
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push(hostProblem(HOST_CODES.BAD_ORIGIN, `不支持的协议：${url.protocol}`))
    }
  }
  if (problems.length > 0) {
    const first = problems[0]
    return Object.freeze({ ok: false, code: first.code, reason: first.message, problems: Object.freeze(problems), host: null })
  }

  const normalPrefix = prefix === '/' ? '' : prefix.replace(/\/+$/, '')
  const production = url.protocol === 'https:'
  const host = Object.freeze({
    origin: `${url.protocol}//${url.host}`,
    prefix: normalPrefix,
    channel,
    platform,
    arch,
    platformToken: platformToken(platform) ?? platform,
    production,
    secure: production,
  })
  return Object.freeze({ ok: true, code: null, reason: null, problems: Object.freeze([]), host })
}

function joinUrl(host, relativePath) {
  return `${host.origin}${host.prefix}/${relativePath}`
}

/** 通道清单的绝对 URL。 */
export function feedUrl(host) {
  return joinUrl(host, feedRelativePath(host.channel, host.platform, host.arch))
}

/** 发行清单的绝对 URL。 */
export function releaseManifestUrl(host, releaseId) {
  return joinUrl(host, releaseManifestRelativePath(releaseId))
}

/**
 * 产物的绝对 URL。
 *
 * 路径先过 `validateRelativePath`：来自清单的路径是**不可信输入**，
 * 它决定了客户端去取哪个地址。校验在这里发生，而不是在"下载函数内部
 * 某处顺便检查一下"。
 */
export function artifactUrl(host, relativePath) {
  const check = validateRelativePath(relativePath, { field: 'artifact.path', allowSubdirDepth: 5 })
  if (!check.ok) return Object.freeze({ ok: false, code: check.code, reason: check.reason, url: null })
  const url = joinUrl(host, relativePath)
  const sameOrigin = isSameOrigin(url, host)
  if (!sameOrigin.ok) return sameOrigin
  return Object.freeze({ ok: true, code: null, reason: null, url })
}

/** 任何一次取件都必须在同一 origin 之内（设计 §5 line 124）。 */
export function isSameOrigin(candidate, host) {
  let parsed
  try { parsed = new URL(candidate) } catch {
    return Object.freeze({ ok: false, code: HOST_CODES.BAD_ORIGIN, reason: `不是合法 URL：${candidate}`, url: null })
  }
  if (`${parsed.protocol}//${parsed.host}` !== host.origin) {
    return Object.freeze({
      ok: false, code: HOST_CODES.CROSS_ORIGIN,
      reason: `跨 origin 取件被拒：${parsed.protocol}//${parsed.host} 不等于 ${host.origin}`, url: null,
    })
  }
  if (parsed.pathname.includes('..') || parsed.pathname.includes('%')) {
    return Object.freeze({ ok: false, code: HOST_CODES.CROSS_ORIGIN, reason: `路径含穿越或编码：${parsed.pathname}`, url: null })
  }
  return Object.freeze({ ok: true, code: null, reason: null, url: candidate })
}

/** 这条路径期望的 `Cache-Control`（供客户端核对与发布端自检共用）。 */
export function expectedCacheControl(relativePath) {
  return relativePath.startsWith('feeds/') ? FEED_CACHE_CONTROL : RELEASE_CACHE_CONTROL
}

/**
 * 核对一次响应的头。
 *
 * @param {string} relativePath
 * @param {{status: number, headers: Record<string,string>}} response
 */
export function evaluateResponse(relativePath, { status, headers = {} } = {}) {
  const problems = []
  if (status !== 200) {
    problems.push(hostProblem(HOST_CODES.BAD_STATUS, `${relativePath} 返回 HTTP ${status}，期望 200`))
  }
  const cache = String(lookupHeader(headers, 'cache-control') ?? '')
  const expected = expectedCacheControl(relativePath)
  if (expected === FEED_CACHE_CONTROL) {
    // ★ `no-store` 的判定不能写成 `includes('no-store')`：`no-store` 与
    //   `no-cache, max-age=600, no-store` 里的 `no-store` 在字符串上一样，
    //   而后者在某些中间层上仍会留下副本。通道清单要么完全不可缓存，
    //   要么就是配置错了。
    const directives = cache.split(',').map((piece) => piece.trim().toLowerCase()).filter(Boolean)
    if (directives.length !== 1 || directives[0] !== 'no-store') {
      problems.push(hostProblem(HOST_CODES.BAD_CACHE,
        `${relativePath} 的 Cache-Control 是 ${JSON.stringify(cache)}，通道清单必须**只**是 no-store`))
    }
  } else if (!cache.toLowerCase().includes('immutable')) {
    // 发行目录不可覆盖，因此"可长期缓存"这条是可核的：没有 immutable
    // 说明这个部署在按普通静态文件处理，CDN 上的旧副本可能被清掉。
    problems.push(hostProblem(HOST_CODES.BAD_CACHE,
      `${relativePath} 的 Cache-Control 是 ${JSON.stringify(cache)}，发行文件应包含 immutable`))
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

export function lookupHeader(headers, name) {
  if (headers === null || typeof headers !== 'object') return null
  const target = name.toLowerCase()
  if (typeof headers.get === 'function') return headers.get(name)
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key]
  }
  return null
}

/**
 * 重定向判定（设计 §5 line 124 的「跨 origin 重定向」）。
 *
 * 同 origin 的路径重定向可以接受（部署会把 `/legion` 指到别处），
 * 跨 origin 的一律拒——那是把"取件地址"交给托管方的方式。
 */
export function evaluateRedirect(fromUrl, location, host) {
  if (typeof location !== 'string' || location === '') {
    return Object.freeze({ ok: false, code: HOST_CODES.REDIRECT, reason: '重定向缺少 Location' })
  }
  let target
  try { target = new URL(location, fromUrl) } catch {
    return Object.freeze({ ok: false, code: HOST_CODES.REDIRECT, reason: `Location 不是合法 URL：${location}` })
  }
  if (`${target.protocol}//${target.host}` !== host.origin) {
    return Object.freeze({
      ok: false, code: HOST_CODES.CROSS_ORIGIN,
      reason: `跨 origin 重定向被拒：${fromUrl} → ${target.href}`,
    })
  }
  if (target.protocol === 'http:' && host.secure) {
    return Object.freeze({ ok: false, code: HOST_CODES.REDIRECT, reason: `HTTPS 请求被重定向到 HTTP：${target.href}` })
  }
  return Object.freeze({ ok: true, code: null, reason: null, url: target.href })
}

/** 请求头：客户端**主动**禁用缓存（设计 §4 line 79）。 */
export function requestHeaders() {
  return Object.freeze({
    'cache-control': 'no-cache, no-store, max-age=0',
    pragma: 'no-cache',
    accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.1',
  })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckHost() {
  const problems = []

  const prod = createHostConfig({ origin: 'https://updates.example.com', prefix: '/legion', channel: 'stable' })
  if (!prod.ok) problems.push(`合法 HTTPS 配置没通过：${prod.reason}`)
  else {
    if (feedUrl(prod.host) !== 'https://updates.example.com/legion/feeds/stable/win-x64.json') {
      problems.push(`通道清单 URL 不对：${feedUrl(prod.host)}`)
    }
    if (releaseManifestUrl(prod.host, 'rel-1') !== 'https://updates.example.com/legion/releases/rel-1/manifest.json') {
      problems.push(`发行清单 URL 不对：${releaseManifestUrl(prod.host, 'rel-1')}`)
    }
    if (prod.host.production !== true) problems.push('HTTPS 配置没有被标为 production')
  }

  // ★ 计划文档最后一段的可执行形式：HTTP 需要显式声明，且不授权正式更新。
  const insecure = createHostConfig({ origin: 'http://117.72.146.36', channel: 'stable' })
  if (insecure.ok) problems.push('未显式允许的 HTTP origin 被接受了')
  else if (insecure.code !== HOST_CODES.INSECURE_ORIGIN) problems.push(`HTTP 拒绝码是 ${insecure.code}`)

  const test = createHostConfig({ origin: 'http://117.72.146.36', prefix: '/test/legion', channel: 'internal', allowInsecureHttp: true })
  if (!test.ok) problems.push(`显式允许的测试 HTTP 配置没通过：${test.reason}`)
  else if (test.host.production !== false) problems.push('测试 HTTP 配置被标成了 production')

  // 平台词干映射：字段用 win32，文件名用 win（设计 §4）。
  if (platformToken('win32') !== 'win') problems.push('win32 的平台词干不是 win')
  if (feedRelativePath('stable', 'win32', 'x64') !== 'feeds/stable/win-x64.json') {
    problems.push(`平台词干没有进入路径：${feedRelativePath('stable', 'win32', 'x64')}`)
  }

  const badOrigins = [
    ['带凭据', 'https://user:pw@updates.example.com'],
    ['带路径', 'https://updates.example.com/legion'],
    ['带查询串', 'https://updates.example.com/?a=1'],
    ['非 HTTP 协议', 'ftp://updates.example.com'],
    ['不是 URL', 'updates.example.com'],
  ]
  for (const [name, origin] of badOrigins) {
    if (createHostConfig({ origin, channel: 'stable' }).ok) problems.push(`「${name}」的 origin 被接受了`)
  }
  const badPrefixes = ['legion', '/legion/../x', '/legion//x', '/leg ion']
  for (const prefix of badPrefixes) {
    if (createHostConfig({ origin: 'https://updates.example.com', prefix, channel: 'stable' }).ok) {
      problems.push(`非法 prefix 被接受了：${JSON.stringify(prefix)}`)
    }
  }
  if (createHostConfig({ origin: 'https://updates.example.com', channel: 'nightly' }).ok) {
    problems.push('非法通道被接受了')
  }

  // 取件 URL 必须同 origin。
  const artifact = artifactUrl(prod.host, 'releases/rel-1/legion-win-x64.zip')
  if (!artifact.ok) problems.push(`合法产物路径被拒：${artifact.reason}`)
  else if (artifact.url !== 'https://updates.example.com/legion/releases/rel-1/legion-win-x64.zip') {
    problems.push(`产物 URL 不对：${artifact.url}`)
  }
  if (artifactUrl(prod.host, 'https://evil.example/x.zip').ok) problems.push('绝对 URL 产物路径被接受了')
  if (artifactUrl(prod.host, 'releases/../../x.zip').ok) problems.push('穿越产物路径被接受了')
  if (isSameOrigin('https://evil.example/legion/x.json', prod.host).ok) problems.push('跨 origin 取件被接受了')

  // 缓存策略核对。
  const feedOk = evaluateResponse('feeds/stable/win-x64.json', {
    status: 200, headers: { 'cache-control': 'no-store' },
  })
  if (!feedOk.ok) problems.push(`合法通道清单缓存头被拒：${feedOk.problems.map((p) => p.message).join('；')}`)
  const feedBad = evaluateResponse('feeds/stable/win-x64.json', {
    status: 200, headers: { 'cache-control': 'no-cache, max-age=600, no-store' },
  })
  if (feedBad.ok) problems.push('通道清单的混合缓存指令被接受了')
  const releaseOk = evaluateResponse('releases/rel-1/legion-win-x64.zip', {
    status: 200, headers: { 'cache-control': RELEASE_CACHE_CONTROL },
  })
  if (!releaseOk.ok) problems.push('合法发行缓存头被拒')
  const releaseBad = evaluateResponse('releases/rel-1/legion-win-x64.zip', {
    status: 200, headers: { 'cache-control': 'public, max-age=60' },
  })
  if (releaseBad.ok) problems.push('缺 immutable 的发行缓存头被接受了')
  const notFound = evaluateResponse('feeds/stable/win-x64.json', { status: 404, headers: { 'cache-control': 'no-store' } })
  if (notFound.ok) problems.push('404 被当成了成功响应')

  // 重定向。
  if (!evaluateRedirect('https://updates.example.com/legion/a.json', '/legion/b.json', prod.host).ok) {
    problems.push('同 origin 重定向被拒')
  }
  if (evaluateRedirect('https://updates.example.com/legion/a.json', 'https://evil.example/b.json', prod.host).ok) {
    problems.push('跨 origin 重定向被接受')
  }
  if (evaluateRedirect('https://updates.example.com/legion/a.json', 'http://updates.example.com/legion/b.json', prod.host).ok) {
    problems.push('HTTPS → HTTP 降级重定向被接受')
  }

  // 请求头必须主动禁缓存。
  const headers = requestHeaders()
  if (!String(headers['cache-control']).includes('no-store')) problems.push('请求头没有禁用缓存')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    sample: Object.freeze({
      feedUrl: prod.ok ? feedUrl(prod.host) : null,
      testPrefix: test.ok ? test.host.prefix : null,
      rejectedOrigins: badOrigins.length,
    }),
  })
}

export const HOST_CHECKED = selfCheckHost()
