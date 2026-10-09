// team-hub/download-lines.mjs
// ============================================================================
// 安装包的**多线路**下载（T-196）
//
// ## 为什么需要它
//
// 2026-10-09 实测：站点只经 Cloudflare Tunnel 对外，而客户端被 Cloudflare
// 分配到 **洛杉矶（LAX）** 边缘。195MB 的安装包在这条跨境路上只有
// **约 1.8 KB/s**，连 34 KB 的 `app.mjs` 都 30 秒超时；而源站直连
// （`117.72.146.36:80`）connect 仅 **0.06s**。也就是说：
//
//   > 一个"源站很快、缓存也命中（`cf-cache-status: HIT`）"的部署，
//   > 与一个"用户下不动安装包"的部署，是同一个东西——
//   > 只不过前者的每一项读数都是健康的。
//
// 而"两边都有人下"意味着**单一线路必然亏待一边**：把下载指到国内 CDN，
// 境外用户会慢；留在 Cloudflare，境内用户下不动。所以需要**多线路**。
//
// ## 为什么是文件，不是环境变量里的列表
//
// 配置系统（`packages/shared/src/config.mjs` 的 `TYPES`）只有
// `string / int / bool / enum / csv / path` 六种类型，没有 JSON。而下载地址里
// 天然带 `?`、`&`、`=`, 用 CSV 拼 `标签=地址` 会在第一次出现查询串时就歧义。
//
//   > 一个"用 CSV 表达结构化列表"的配置，
//   > 与一个"地址里带了一个逗号就整条线路消失"的配置，是同一个东西——
//   > 只不过前者在写它的那个下午是工作的。
//
// 所以线路表走**独立文件**（`LEGION_DOWNLOAD_LINES` 指向它），并带 format 版本号。
//
// ## 三条纪律
//
// ① **具名拒绝，不静默丢弃。** 一条线路写错时，问题必须**被报出来**——
//    否则"镜像没生效"与"配置写错了"在页面上长得一模一样（都是只有一条线路），
//    而排障的人会去查 CDN。
// ② **配错就整体不生效（fail closed）。** 有任何一条问题时 `lines` 为空，
//    站点回退到原有的单线路行为。半生效更坏：一部分用户静默拿到慢线路，
//    而没有任何地方说明为什么。
// ③ **默认必须 https。** 安装包是 195MB 的二进制；明文链路允许中间人替换它。
//    `http` 只在一份配置**显式**声明 `allowInsecureHttp: true` 时才允许
//    （与 `product/update/host.mjs` 对 internal 通道的处理同一姿态）。
//
// ## 地区怎么判：用 Cloudflare 给的 `CF-IPCountry`，不做前端探测
//
// 站点在 Cloudflare 后面（Tunnel），源站能直接读到 Cloudflare 注入的
// `CF-IPCountry`。这是**免费且可靠**的地区信号，而且：
//
//   · 不需要页面里的 JS 探测 —— 那段 JS 本身要经同一条慢路送到手机/电脑上；
//   · 不会因为探测超时把用户引到更慢的那条线
//     （*一个"探测失败就选默认"的逻辑，在探测必然慢的那一侧总是选错*）。
//
// 读不到该头时（本地开发、直连、非 Cloudflare 部署）回退到默认线路。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'

/** 线路表的格式名（与其余协议一样带版本）。 */
export const DOWNLOAD_LINES_FORMAT = 'legion/download-lines@1'

export const DOWNLOAD_LINE_CODES = Object.freeze({
  NOT_OBJECT: 'lines-not-object',
  BAD_FORMAT: 'lines-bad-format',
  BAD_LINES: 'lines-not-array',
  EMPTY_LINES: 'lines-empty',
  BAD_LINE: 'lines-bad-line',
  BAD_ID: 'lines-bad-id',
  DUPLICATE_ID: 'lines-duplicate-id',
  BAD_LABEL: 'lines-bad-label',
  BAD_URL: 'lines-bad-url',
  INSECURE_URL: 'lines-insecure-url',
  DUPLICATE_URL: 'lines-duplicate-url',
  BAD_COUNTRIES: 'lines-bad-countries',
  FILE_MISSING: 'lines-file-missing',
  FILE_BAD_JSON: 'lines-file-bad-json',
})

function problem(code, message) {
  return Object.freeze({ code, message })
}

/** 线路 id 的形状：小写字母/数字/连字符 —— 它进日志与问题文本。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** ISO 3166-1 alpha-2（Cloudflare 的 `CF-IPCountry` 就是它，外加 `XX`/`T1`）。 */
const COUNTRY_RE = /^[A-Z0-9]{2}$/

/**
 * 归一一个地区码：去空白 → 大写 → 判形状。不合法返回 `null`。
 *
 * ★ 这个函数存在的唯一理由是**让两处输入共用同一条规则**：线路表里的
 *   `countries` 与访客的 `CF-IPCountry`。第一版把它们各写了一遍，而两遍
 *   不一致（配置侧先大写、访客侧先判形状），表现是：
 *
 *     配置写 `"cn"` → 生效（被归一）
 *     访客码 `"cn"` → 不生效（被判非法，回退默认线路）
 *
 *   ——而这两种情况在页面上都是"看起来选了线路"。ISO 地区码本来就大小写不敏感，
 *   所以规则是"先归一、再判形状"，两处都走这里。
 */
export function normalizeCountry(value) {
  if (typeof value !== 'string') return null
  return COUNTRY_RE.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null
}

/**
 * 解析一份线路表。
 *
 * @param {unknown} raw 已经 `JSON.parse` 过的对象（或任意值）
 * @returns {{ok: boolean, lines: ReadonlyArray<object>, problems: ReadonlyArray<object>}}
 *          `ok: false` 时 `lines` **一定是空的**（见纪律②）。
 */
export function parseDownloadLines(raw) {
  const problems = []
  const done = (lines) => Object.freeze({
    ok: problems.length === 0,
    lines: Object.freeze(problems.length === 0 ? lines : []),
    problems: Object.freeze(problems),
  })

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(problem(DOWNLOAD_LINE_CODES.NOT_OBJECT, '线路表必须是对象'))
    return done([])
  }
  if (raw.format !== DOWNLOAD_LINES_FORMAT) {
    problems.push(problem(DOWNLOAD_LINE_CODES.BAD_FORMAT,
      `format 必须是 ${JSON.stringify(DOWNLOAD_LINES_FORMAT)}，实际 ${JSON.stringify(raw.format)}`))
  }
  const allowInsecureHttp = raw.allowInsecureHttp === true
  if (raw.allowInsecureHttp !== undefined && typeof raw.allowInsecureHttp !== 'boolean') {
    problems.push(problem(DOWNLOAD_LINE_CODES.BAD_LINE,
      `allowInsecureHttp 必须是布尔，实际 ${JSON.stringify(raw.allowInsecureHttp)}`))
  }
  if (!Array.isArray(raw.lines)) {
    problems.push(problem(DOWNLOAD_LINE_CODES.BAD_LINES, 'lines 必须是数组'))
    return done([])
  }
  if (raw.lines.length === 0) {
    problems.push(problem(DOWNLOAD_LINE_CODES.EMPTY_LINES, 'lines 是空数组：配了线路表却一条线路都没有'))
    return done([])
  }

  const ids = new Set()
  const urls = new Set()
  const lines = []
  raw.lines.forEach((entry, index) => {
    const at = `lines[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(problem(DOWNLOAD_LINE_CODES.BAD_LINE, `${at} 必须是对象`))
      return
    }
    // ── id ──
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
      problems.push(problem(DOWNLOAD_LINE_CODES.BAD_ID,
        `${at}.id 必须是 ${String(ID_RE)}（小写字母/数字/连字符，≤32），实际 ${JSON.stringify(entry.id)}`))
      return
    }
    if (ids.has(entry.id)) {
      problems.push(problem(DOWNLOAD_LINE_CODES.DUPLICATE_ID, `${at}.id 重复：${entry.id}`))
      return
    }
    ids.add(entry.id)
    // ── label ──
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      problems.push(problem(DOWNLOAD_LINE_CODES.BAD_LABEL, `${at}.label 必须是非空字符串`))
      return
    }
    if (entry.labelEn !== undefined && (typeof entry.labelEn !== 'string' || entry.labelEn.trim() === '')) {
      problems.push(problem(DOWNLOAD_LINE_CODES.BAD_LABEL, `${at}.labelEn 给了就必须是非空字符串`))
      return
    }
    // ── url ──
    const urlCheck = checkAbsoluteUrl(entry.url, { allowInsecureHttp, at })
    if (!urlCheck.ok) { problems.push(urlCheck.problem); return }
    if (urls.has(entry.url)) {
      problems.push(problem(DOWNLOAD_LINE_CODES.DUPLICATE_URL, `${at}.url 与前面的线路重复：${entry.url}`))
      return
    }
    urls.add(entry.url)
    // ── countries（可空 = 默认线路）──
    let countries = []
    if (entry.countries !== undefined) {
      if (!Array.isArray(entry.countries)) {
        problems.push(problem(DOWNLOAD_LINE_CODES.BAD_COUNTRIES,
          `${at}.countries 必须是形如 ["CN"] 的两字符代码数组（Cloudflare 的 CF-IPCountry 口径），`
          + `实际 ${JSON.stringify(entry.countries)}`))
        return
      }
      for (const raw of entry.countries) {
        const cc = normalizeCountry(raw)
        if (cc === null) {
          problems.push(problem(DOWNLOAD_LINE_CODES.BAD_COUNTRIES,
            `${at}.countries 里有不合法的地区码：${JSON.stringify(raw)}。`
            + '它必须是两位字母/数字（ISO 3166-1 alpha-2，也就是 CF-IPCountry 的口径）'))
          return
        }
        countries.push(cc)
      }
      if (new Set(countries).size !== countries.length) {
        problems.push(problem(DOWNLOAD_LINE_CODES.BAD_COUNTRIES, `${at}.countries 里有重复项（归一大小写之后）`))
        return
      }
    }
    lines.push(Object.freeze({
      id: entry.id,
      label: entry.label.trim(),
      labelEn: typeof entry.labelEn === 'string' ? entry.labelEn.trim() : entry.label.trim(),
      url: entry.url,
      countries: Object.freeze(countries),
      note: typeof entry.note === 'string' ? entry.note : '',
    }))
  })

  // 最多一条"默认线路"（countries 为空）。两条会引出"谁是默认"的歧义，
  // 而那种歧义的表现是"换了一个部署地区，默认线路就变了"。
  const defaults = lines.filter((l) => l.countries.length === 0)
  if (defaults.length > 1) {
    problems.push(problem(DOWNLOAD_LINE_CODES.BAD_COUNTRIES,
      `有 ${defaults.length} 条默认线路（countries 为空）：${defaults.map((l) => l.id).join('、')}。`
      + '默认线路最多一条——两条时"谁是默认"取决于顺序，而顺序会在一次无关的重排里变。'))
  }

  return done(lines)
}

/** 绝对 http(s) URL 的判据。相对路径在这里是**不合法**的（见文件头的纪律③与 ICP 现状）。 */
function checkAbsoluteUrl(value, { allowInsecureHttp, at }) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, problem: problem(DOWNLOAD_LINE_CODES.BAD_URL, `${at}.url 必须是非空字符串`) }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return {
      ok: false,
      problem: problem(DOWNLOAD_LINE_CODES.BAD_URL,
        `${at}.url 不是绝对地址：${JSON.stringify(value)}。`
        + '多线路必须是绝对地址——国内线路在备案完成前只能挂在云厂商分配的默认域名上，'
        + '而相对路径会静静地把请求发回本站（也就是那条被判定为慢的线路）'),
    }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      problem: problem(DOWNLOAD_LINE_CODES.BAD_URL, `${at}.url 的协议必须是 http(s)，实际 ${parsed.protocol}`),
    }
  }
  if (parsed.protocol === 'http:' && allowInsecureHttp !== true) {
    return {
      ok: false,
      problem: problem(DOWNLOAD_LINE_CODES.INSECURE_URL,
        `${at}.url 是明文 http：${value}。安装包是二进制，明文链路允许中间人替换它；`
        + '确实要用（测试机）就在线路表顶层写 "allowInsecureHttp": true'),
    }
  }
  return { ok: true }
}

/**
 * 按访客地区选一条线路。
 *
 * 判定顺序（**刻意**是这个顺序）：
 *   ① 声明了该地区的线路 → 用它（最具体）
 *   ② 没有声明地区的线路（默认线路）→ 用它
 *   ③ 都没有 → 第一条（总得给用户一个能点的链接）
 *
 * 读不到 `country` 时走 ②③，把"地区未知"与"地区不匹配"当成同一件事——
 * 对用户而言它们的结果都应该是**那条通用的线路**。
 *
 * @returns {{ok: boolean, featured: object|null, others: ReadonlyArray<object>}}
 */
export function selectDownloadLine(lines, { country = null } = {}) {
  const list = Array.isArray(lines) ? lines : []
  if (list.length === 0) return Object.freeze({ ok: false, featured: null, others: Object.freeze([]) })
  // 访客地区也走**同一个**归一函数（见 `normalizeCountry` 的注释：
  // 两处各写一遍时，配置接受小写而访客码不接受——那正是第一版的 bug）。
  const cc = normalizeCountry(country)
  let featured = null
  if (cc !== null) featured = list.find((l) => l.countries.includes(cc)) ?? null
  if (featured === null) featured = list.find((l) => l.countries.length === 0) ?? null
  if (featured === null) featured = list[0]
  return Object.freeze({
    ok: true,
    featured,
    others: Object.freeze(list.filter((l) => l.id !== featured.id)),
  })
}

/**
 * 从磁盘读线路表。**不抛**。
 *
 * 路径为空 = 没配多线路（合法，返回空表且**没有问题**）。
 * 路径给了但文件不在 = **问题**：那说明配置指了一个不存在的东西，
 * 与"没配"是两件事（*一个"指向不存在文件"的配置，与一个"没配"的配置，
 * 在页面上都表现为只有一条线路*）。
 */
export function loadDownloadLines(path, { readFile = (p) => readFileSync(p, 'utf8'), exists = (p) => existsSync(p) } = {}) {
  if (typeof path !== 'string' || path.trim() === '') {
    return Object.freeze({ lines: Object.freeze([]), problems: Object.freeze([]), source: null })
  }
  const file = path.trim()
  if (!exists(file)) {
    return Object.freeze({
      lines: Object.freeze([]),
      problems: Object.freeze([problem(DOWNLOAD_LINE_CODES.FILE_MISSING, `线路表文件不存在：${file}`)]),
      source: file,
    })
  }
  let raw
  try {
    raw = JSON.parse(readFile(file))
  } catch (error) {
    return Object.freeze({
      lines: Object.freeze([]),
      problems: Object.freeze([problem(DOWNLOAD_LINE_CODES.FILE_BAD_JSON, `线路表不是合法 JSON：${error?.message ?? error}`)]),
      source: file,
    })
  }
  const parsed = parseDownloadLines(raw)
  return Object.freeze({ lines: parsed.lines, problems: parsed.problems, source: file })
}

/** 把问题渲染成给人看的一行（启动日志用）。 */
export function formatDownloadLineProblems(problems) {
  return (Array.isArray(problems) ? problems : [])
    .map((p) => `[download-lines] ${p.code}: ${p.message}`)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** 一份合法的样例（测试与文档共用）。 */
export function sampleLinesConfig() {
  return Object.freeze({
    format: DOWNLOAD_LINES_FORMAT,
    lines: Object.freeze([
      Object.freeze({
        id: 'cn', label: '国内线路', labelEn: 'China mirror',
        url: 'https://legion-releases.s3.cn-north-1.jdcloud-oss.com/legion/releases/r-1/Legion-Setup-win-x64.exe',
        countries: Object.freeze(['CN']),
      }),
      Object.freeze({
        id: 'global', label: '国际线路', labelEn: 'Global',
        url: 'https://legion-si.online/legion/releases/r-1/Legion-Setup-win-x64.exe',
      }),
    ]),
  })
}

export function selfCheckDownloadLines() {
  const problems = []

  const good = parseDownloadLines(sampleLinesConfig())
  if (!good.ok) problems.push(`样例线路表被判为不合法：${good.problems.map((p) => p.code).join(',')}`)
  if (good.lines.length !== 2) problems.push(`样例线路表应解析出 2 条，实际 ${good.lines.length}`)

  // 选用：CN → 国内线路；US → 默认（国际）；未知 → 默认。
  const cn = selectDownloadLine(good.lines, { country: 'CN' })
  if (cn.featured?.id !== 'cn') problems.push(`CN 访客应选中 cn 线路，实际 ${cn.featured?.id}`)
  if (cn.others.length !== 1 || cn.others[0].id !== 'global') problems.push('CN 访客的备选线路应只有 global')
  const us = selectDownloadLine(good.lines, { country: 'US' })
  if (us.featured?.id !== 'global') problems.push(`US 访客应选中默认线路 global，实际 ${us.featured?.id}`)
  const none = selectDownloadLine(good.lines, {})
  if (none.featured?.id !== 'global') problems.push(`地区未知时应选中默认线路，实际 ${none.featured?.id}`)
  const bogus = selectDownloadLine(good.lines, { country: '不是代码' })
  if (bogus.featured?.id !== 'global') problems.push('非法地区代码应回退到默认线路')
  if (selectDownloadLine([], { country: 'CN' }).ok !== false) problems.push('空线路表应报 ok:false')

  // 拒绝路径：每一条都必须**具名**拒绝。
  const rejects = [
    [{ format: DOWNLOAD_LINES_FORMAT, lines: [] }, DOWNLOAD_LINE_CODES.EMPTY_LINES],
    [{ lines: [] }, DOWNLOAD_LINE_CODES.BAD_FORMAT],
    [null, DOWNLOAD_LINE_CODES.NOT_OBJECT],
    [{ format: DOWNLOAD_LINES_FORMAT, lines: {} }, DOWNLOAD_LINE_CODES.BAD_LINES],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'Bad Id', label: 'x', url: 'https://a.example/x.exe' }] },
      DOWNLOAD_LINE_CODES.BAD_ID,
    ],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: '', url: 'https://a.example/x.exe' }] },
      DOWNLOAD_LINE_CODES.BAD_LABEL,
    ],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: '/legion/releases/x.exe' }] },
      DOWNLOAD_LINE_CODES.BAD_URL,
    ],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'javascript:alert(1)' }] },
      DOWNLOAD_LINE_CODES.BAD_URL,
    ],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'http://a.example/x.exe' }] },
      DOWNLOAD_LINE_CODES.INSECURE_URL,
    ],
    [
      {
        format: DOWNLOAD_LINES_FORMAT,
        lines: [
          { id: 'a', label: 'x', url: 'https://a.example/x.exe' },
          { id: 'a', label: 'y', url: 'https://b.example/x.exe' },
        ],
      },
      DOWNLOAD_LINE_CODES.DUPLICATE_ID,
    ],
    [
      {
        format: DOWNLOAD_LINES_FORMAT,
        lines: [
          { id: 'a', label: 'x', url: 'https://a.example/x.exe' },
          { id: 'b', label: 'y', url: 'https://a.example/x.exe' },
        ],
      },
      DOWNLOAD_LINE_CODES.DUPLICATE_URL,
    ],
    [
      { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'https://a.example/x.exe', countries: ['CHN'] }] },
      DOWNLOAD_LINE_CODES.BAD_COUNTRIES,
    ],
    [
      {
        format: DOWNLOAD_LINES_FORMAT,
        lines: [
          { id: 'a', label: 'x', url: 'https://a.example/x.exe' },
          { id: 'b', label: 'y', url: 'https://b.example/x.exe' },
        ],
      },
      DOWNLOAD_LINE_CODES.BAD_COUNTRIES,
    ],
  ]
  for (const [input, expected] of rejects) {
    const r = parseDownloadLines(input)
    if (r.ok) { problems.push(`非法输入被接受了：${JSON.stringify(input).slice(0, 80)}`); continue }
    // ★ 纪律②：有问题时**必须**一条线路都不给（fail closed）。
    if (r.lines.length !== 0) problems.push(`报错时仍然给出了 ${r.lines.length} 条线路（应 fail closed）`)
    if (!r.problems.some((p) => p.code === expected)) {
      problems.push(`期望拒绝码 ${expected}，实际 ${r.problems.map((p) => p.code).join(',')}`)
    }
  }

  // 显式允许明文时，http 必须能通过（测试机的真实用法）。
  const insecure = parseDownloadLines({
    format: DOWNLOAD_LINES_FORMAT, allowInsecureHttp: true,
    lines: [{ id: 'test', label: '测试机', url: 'http://117.72.146.36/legion/releases/x.exe' }],
  })
  if (!insecure.ok) problems.push(`显式允许明文时 http 线路被拒了：${insecure.problems.map((p) => p.code).join(',')}`)

  // 落盘读取：路径为空 = 合法且无问题；文件不在 = 具名问题。
  if (loadDownloadLines('').problems.length !== 0) problems.push('未配置线路表时不应产生问题')
  const missing = loadDownloadLines('C:\\definitely-missing-lines.json')
  if (missing.problems[0]?.code !== DOWNLOAD_LINE_CODES.FILE_MISSING) problems.push('不存在的线路表文件没有具名拒绝')

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), format: DOWNLOAD_LINES_FORMAT })
}

export const DOWNLOAD_LINES_CHECKED = selfCheckDownloadLines()
