// runtime/dsh-composition/external-api-scope.mjs
// ============================================================================
// PRT-606：区分外部 API 读取与写入权限
//
// spec line 928：「`PRT-606`：区分外部 API 读取与写入权限。」
// spec §6.6 line 465：权限至少覆盖「外部 API 读取与写入」。
// spec §6.6 line 466：权限至少覆盖「发布、付款、删除等高风险动作」。
// spec §6.6 line 944：完成标准「未批准高风险写操作为零」。
// spec §6.6 line 468：不允许改写工具参数；审计、UI 与实际执行必须看到相同输入。
//
// PRT-604 管文件、PRT-605 管进程/网络/MCP。本模块管**第四种**：对外部服务的
// 有语义的调用——它有一个方法、一个路径，而"读"与"写"的区别就藏在这两者里。
//
// 一条读权限变成写权限，从来不是靠"权限表写错了"，而是靠**一连串"看起来是读"
// 的东西**：
//
//   > 一个「只看请求行上的 method」的检查，
//   > 与一个「`GET /api/items/1` + `X-HTTP-Method-Override: DELETE` 真的删掉了」的检查，
//   > 是同一个东西——而它的方向是放行。
//
//   > 一个「用路径前缀判断这是哪个端点」的匹配，
//   > 与一个「`/api/items` 的读权限覆盖了 `/api/items/1/delete`」的匹配，
//   > 是同一个东西——而它的方向是放行。
//
//   > 一个「请求里写了 `dry_run: true` 就当成读」的分类，
//   > 与一个「由调用方自己声明自己没有副作用」的分类，是同一个东西。
//
// ⚠️ 本模块**不复用** PRT-604 的文件系统路径规范化器。这不是疏忽，是一次被自检
// 抓到的真缺陷——见 §「为什么不复用路径规范化器」。
// ============================================================================

export const EXTERNAL_API_SCOPE_VERSION = 'legion/external-api-scope@1'

export const API_CODES = Object.freeze({
  BAD_GRANT: 'api-scope-malformed',
  BAD_REQUEST: 'api-scope-bad-request',
  BAD_PATH: 'api-scope-bad-path',
  NOT_ABSOLUTE: 'api-scope-path-not-absolute',
  TRAILING_SLASH: 'api-scope-trailing-slash',
  EMPTY_SEGMENT: 'api-scope-empty-segment',
  DOT_SEGMENT: 'api-scope-dot-segment',
  PATH_ESCAPE: 'api-scope-path-escape',
  BAD_PERCENT: 'api-scope-bad-percent',
  DOUBLE_ENCODED: 'api-scope-double-encoded',
  BACKSLASH_IN_PATH: 'api-scope-backslash-in-path',
  PATH_HAS_QUERY: 'api-scope-path-has-query',
  CONTROL_CHAR: 'api-scope-control-char',
  WILDCARD_PATTERN: 'api-scope-wildcard-pattern',
  BAD_PATTERN: 'api-scope-bad-pattern',
  HOST_NOT_A_STRING: 'api-scope-host-missing',
  HOST_HAS_USERINFO: 'api-scope-host-has-userinfo',
  HOST_HAS_SEPARATOR: 'api-scope-host-has-separator',
  HOST_HAS_PORT: 'api-scope-host-has-port',
  HOST_NON_ASCII: 'api-scope-host-non-ascii',
  HOST_MALFORMED: 'api-scope-host-malformed',
  UNKNOWN_METHOD: 'api-scope-unknown-method',
  METHOD_OVERRIDE: 'api-scope-method-override',
  READ_WITH_BODY: 'api-scope-read-with-body',
  ACTION_IN_QUERY: 'api-scope-action-in-query',
  ENDPOINT_NOT_GRANTED: 'api-scope-endpoint-not-granted',
  AMBIGUOUS_MATCH: 'api-scope-ambiguous-match',
  EFFECT_MISMATCH: 'api-scope-effect-mismatch',
  HIGH_RISK_ON_READ: 'api-scope-high-risk-on-read',
  UNKNOWN_RISK_CLASS: 'api-scope-unknown-risk-class',
  IDEMPOTENCY_NOT_HONORED: 'api-scope-idempotency-not-honored',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/** 取一个会抛的调用的错误码；不抛就返回 `'NO-THROW'`（自检与判据共用）。 */
function codeOf(fn) {
  try {
    fn()
    return 'NO-THROW'
  } catch (err) {
    return err?.code ?? 'NO-CODE'
  }
}

// ============================================================ ① URL 路径

/**
 * URL 路径的规范化。**与文件系统路径是两回事**，所以这里是独立实现。
 *
 * ## 为什么不复用 PRT-604 的路径规范化器
 *
 * 第一版确实复用了 `path-scope.mjs` 的 `normalizeForCompare`（"同一套规则，
 * 不要两处各写一份"）。装载自检在 Windows 那一支直接把它否掉了：
 *
 *     path-scope-not-absolute: 路径 "/API//Items/./1/" 没有盘符
 *
 * 一个 URL 路径**永远**不会有盘符，而一个文件系统路径在 Windows 上**必须**有。
 * 两者对"大小写"的规则也相反：文件系统跟着平台折叠，URL 路径按 RFC 3986
 * **永远**大小写敏感。
 *
 *   > 一个「把文件系统路径规范化器复用到 URL 路径上」的复用，
 *   > 与一个「在 Windows 上 URL 路径因为没有盘符而被判成非法、
 *   > 在 Linux 上又悄悄折叠了大小写」的复用，是同一个东西。
 *
 * "两处各写一份"在这里不是重复，而是**两件事本来就不同**。
 *
 * ## 规范形式（不满足就拒绝，不静默改写）
 *
 * 拒绝而不是折叠，因为折叠意味着"我们替服务端猜它会怎么解释这个路径"：
 *
 *   > 一个「把 `..` 折叠掉之后继续判」的规范化，
 *   > 与一个「`/api/items/{id}` 的读权限覆盖了 `/api/items/1/../admin`」的规范化，
 *   > 是同一个东西——而它的方向是放行。
 *
 * | 要求 | 码 |
 * | --- | --- |
 * | 以 `/` 开头 | `NOT_ABSOLUTE` |
 * | 不以 `/` 结尾（根 `/` 除外） | `TRAILING_SLASH` |
 * | 没有连续 `/` | `EMPTY_SEGMENT` |
 * | 没有 `.` / `..` 段 | `DOT_SEGMENT` / `PATH_ESCAPE` |
 * | 没有 `\` | `BACKSLASH_IN_PATH` |
 * | 没有 `?` / `#` | `PATH_HAS_QUERY` |
 * | 没有控制字符 | `CONTROL_CHAR` |
 * | 百分号编码合法且 UTF-8 合法 | `BAD_PERCENT` |
 * | 解码后不再是另一个百分号编码 | `DOUBLE_ENCODED` |
 *
 * 最后一条是**两次解码**的经典绕过：
 *
 *   > 一个「解码一次就比路径」的检查，
 *   > 与一个「`%252e%252e` 解码一次还是 `%2e%2e`、服务端解码第二次就成了 `..`」的检查，
 *   > 是同一个东西——而它的方向是放行。
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const PERCENT_TRIPLET = /%[0-9a-fA-F]{2}/

/**
 * 解码一次百分号编码。连续的 `%XX` 合并成一个字节串再按 UTF-8 解码，
 * 所以 `%E4%B8%AD` 会正确地变成「中」，而 `%E4` 单独出现会报 `BAD_PERCENT`。
 */
export function percentDecodeOnce(raw) {
  let out = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] !== '%') {
      out += raw[i]
      i += 1
      continue
    }
    const bytes = []
    while (i < raw.length && raw[i] === '%') {
      const hex = raw.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw fail(
          API_CODES.BAD_PERCENT,
          `路径里的百分号编码不合法：${JSON.stringify(raw.slice(i, i + 3))}。` +
          '一个"百分号后面不是十六进制也照原样传下去"的解码，' +
          '与一个"服务端解不开、于是这个路径变成了别的东西"的解码，是同一个东西',
        )
      }
      bytes.push(parseInt(hex, 16))
      i += 3
    }
    const decoded = Buffer.from(bytes).toString('utf8')
    if (decoded.includes('\uFFFD')) {
      throw fail(API_CODES.BAD_PERCENT, `路径里的百分号编码不是合法 UTF-8：${JSON.stringify(raw)}`)
    }
    out += decoded
  }
  return out
}

/**
 * 规范形式里，段内的 `%` 一律写成 `%25`。
 *
 * 这样 `normalizeUrlPath(normalizeUrlPath(x).key).key === x.key` 成立——**规范化
 * 必须接受自己的输出**：
 *
 *   > 一个「接受不了自己输出」的规范化，
 *   > 与一个「第二次经过就抛」的规范化，是同一个东西。
 */
function canonicalSegment(seg) {
  return seg.replace(/%/g, '%25')
}

function checkChars(text) {
  if (CONTROL_CHARS.test(text)) {
    throw fail(
      API_CODES.CONTROL_CHAR,
      `路径里有控制字符：${JSON.stringify(text)}。` +
      '一个"控制字符照原样传下去"的匹配，' +
      '与一个"服务端把 \\n 当成段分隔、于是路径多了一段"的匹配，是同一个东西',
    )
  }
  if (text.includes('\\')) {
    throw fail(
      API_CODES.BACKSLASH_IN_PATH,
      `路径里有反斜杠：${JSON.stringify(text)}。` +
      '一个"只按 / 切段、但服务端也把 \\ 当分隔符"的匹配，' +
      '与一个"路径少切了一段、于是绕过了端点表"的匹配，是同一个东西',
    )
  }
  if (text.includes('?') || text.includes('#')) {
    throw fail(
      API_CODES.PATH_HAS_QUERY,
      `path 里出现了 ? 或 #：${JSON.stringify(text)}。` +
      '一个"允许 path 里带 ?"的接口，' +
      '与一个"`?action=delete` 从来没进过 query 对象、于是动作检查看不到它"的接口，是同一个东西——' +
      '而它的方向是放行',
    )
  }
}

/**
 * 把一段**字面量**路径段解码并校验（不含切段逻辑）。
 * 供端点模式使用——模式里的段要先拆出占位符再逐段规范化。
 */
export function normalizePathSegment(rawSegment) {
  const text = percentDecodeOnce(String(rawSegment))
  checkChars(text, null)
  if (PERCENT_TRIPLET.test(text)) {
    throw fail(
      API_CODES.DOUBLE_ENCODED,
      `路径段 ${JSON.stringify(rawSegment)} 解码之后仍是百分号编码（${JSON.stringify(text)}）。` +
      '一个"解码一次就比路径"的检查，' +
      '与一个"`%252e%252e` 解码一次还是 `%2e%2e`、服务端解码第二次就成了 `..`"的检查，' +
      '是同一个东西——而它的方向是放行',
    )
  }
  if (text === '') {
    throw fail(API_CODES.EMPTY_SEGMENT, '路径段是空的（\\/\\/ 或结尾的 \\/）')
  }
  return text
}

/**
 * 规范化一个**请求**URL 路径。
 *
 * @returns {{key: string, segments: readonly string[], raw: string, decoded: string}}
 */
export function normalizeUrlPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw fail(API_CODES.BAD_PATH, `path 必须是非空字符串，收到 ${JSON.stringify(input)}`)
  }
  checkChars(input)
  if (!input.startsWith('/')) {
    throw fail(
      API_CODES.NOT_ABSOLUTE,
      `URL 路径必须以 / 开头：${JSON.stringify(input)}。` +
      '一个"不以 / 开头的路径也照match"的匹配，' +
      '与一个"相对路径解析到哪个端点取决于调用方"的匹配，是同一个东西',
    )
  }
  if (input.length > 1 && input.endsWith('/')) {
    throw fail(
      API_CODES.TRAILING_SLASH,
      `URL 路径不该以 / 结尾：${JSON.stringify(input)}。` +
      '一个"`/api/items/` 与 `/api/items` 当成同一个"的匹配，' +
      '与一个"服务端认为它们是两个端点、于是其中一个没被授权"的匹配，是同一个东西——' +
      '规范形式要求调用方说清楚是哪一个',
    )
  }
  const rawSegments = input.slice(1) === '' ? [] : input.slice(1).split('/')
  const segments = []
  const decoded = []
  for (const rawSeg of rawSegments) {
    if (rawSeg === '') {
      throw fail(
        API_CODES.EMPTY_SEGMENT,
        `URL 路径里有连续的 / ：${JSON.stringify(input)}。` +
        '一个"把 `//` 折叠掉"的规范化，' +
        '与一个"某些服务端把 `//api/items` 当根路径、于是绕过了前缀"的规范化，是同一个东西',
      )
    }
    const text = percentDecodeOnce(rawSeg)
    checkChars(text)
    if (text === '.') {
      throw fail(
        API_CODES.DOT_SEGMENT,
        `URL 路径里有 . 段：${JSON.stringify(input)}。` +
        '一个"把 . 段折叠掉"的规范化，' +
        '与一个"服务端不折叠、于是 `.` 成了一个合法的 {id}"的规范化，是同一个东西',
      )
    }
    if (text === '..') {
      throw fail(
        API_CODES.PATH_ESCAPE,
        `URL 路径里有 .. 段：${JSON.stringify(input)}。` +
        '一个"把 .. 折叠掉之后继续判"的规范化，' +
        '与一个"`{id}` 的读权限覆盖了 `1/../admin`"的规范化，是同一个东西——而它的方向是放行',
      )
    }
    if (PERCENT_TRIPLET.test(text)) {
      throw fail(
        API_CODES.DOUBLE_ENCODED,
        `URL 路径段 ${JSON.stringify(rawSeg)} 解码之后仍是百分号编码（${JSON.stringify(text)}）。` +
        '一个"解码一次就比路径"的检查，' +
        '与一个"`%252e%252e` 解码一次还是 `%2e%2e`、服务端解码第二次就成了 `..`"的检查，' +
        '是同一个东西——而它的方向是放行',
      )
    }
    segments.push(text)
    decoded.push(canonicalSegment(text))
  }
  return Object.freeze({
    key: '/' + decoded.join('/'),
    segments: Object.freeze(segments),
    raw: input,
    decoded: '/' + segments.join('/'),
  })
}

// ============================================================ ② host

/**
 * 规范化 host：小写、去掉 FQDN 根点、拒绝 userinfo / 端口 / 非 ASCII。
 *
 * host 的比较规则来自 PRT-605（那里管"能不能出去"），这里管"是不是同一个外部服务"：
 * 两条纪律必须一致，否则同一个 URL 在两处得到不同的 host。
 *
 * **`host` 是必需的**（端点表里不许省）：
 *
 *   > 一个「host 可以省的端点表」，
 *   > 与一个「这条授权其实对所有 host 生效」的端点表，是同一个东西——
 *   > 只不过前者在配置里看起来是有边界的。
 */
export function normalizeHost(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw fail(
      API_CODES.HOST_NOT_A_STRING,
      `host 必须是非空字符串，收到 ${JSON.stringify(input)}。` +
      '一个"host 可以省的端点表"，与一个"这条授权对所有 host 生效"的端点表，是同一个东西',
    )
  }
  let h = input.trim()
  // 四种"host 里混进了别的东西"的形态，**各有自己的码**。
  //
  //   > 一个「把两种不同的域名攻击报成同一个码」的检查，
  //   > 与一个「值班的人去改错误的那一处」的检查，是同一个东西。
  //
  // ⚠️ 诚实说明：这四条**并不**构成独立的第二道防线——后面那条
  // `^[a-z0-9.-]+$` 字符类同样会拒掉它们（`@` `/` `\` `:` 与非 ASCII 都不在类里）。
  // 它们存在的价值是**诊断**：让人一眼看出"这是一次 userinfo 混淆"还是"一个端口"。
  // 装载自检把这件事留成了证据（`redundancyWithCharClass`），免得有人以为这里有
  // 两层防线——把它当成后者，会让一个已被别处覆盖的地方看起来还有一层保护。
  if (h.includes('@')) {
    throw fail(
      API_CODES.HOST_HAS_USERINFO,
      `host ${JSON.stringify(input)} 里有 @（userinfo）。` +
      '一个"用 includes 判断 host 是否匹配"的检查，' +
      '与一个"`https://api.example.com@evil.com/` 被当成 api.example.com"的检查，是同一个东西',
    )
  }
  if (h.includes('/') || h.includes('\\')) {
    throw fail(
      API_CODES.HOST_HAS_SEPARATOR,
      `host ${JSON.stringify(input)} 里有路径分隔符 / 或 \\。` +
      '一个"host 里带 / 也照原样比"的检查，与一个"`api.example.com/evil` 被当成 api.example.com"的检查，是同一个东西',
    )
  }
  if (h.includes(':')) {
    throw fail(
      API_CODES.HOST_HAS_PORT,
      `host ${JSON.stringify(input)} 里有 :（端口或 IPv6 字面量）。` +
      '一个"把 host 与 port 一起当 host"的检查，' +
      '与一个"`api.example.com:8443` 被当成 api.example.com"的检查，是同一个东西',
    )
  }
  // 非 ASCII **在解析之前**就拒绝：解析器会把它 punycode 掉，之后再查就查不到了。
  // （这条教训来自 PRT-605 的一个真缺陷。）
  if (/[^\x00-\x7f]/.test(h)) {
    throw fail(
      API_CODES.HOST_NON_ASCII,
      `host ${JSON.stringify(input)} 里有非 ASCII 字符。` +
      '一个"在解析之后才检查非 ASCII"的检查，' +
      '与一个"解析器已经悄悄把它们转掉了、所以这条检查从不触发"的检查，是同一个东西',
    )
  }
  h = h.toLowerCase()
  if (h.endsWith('.')) h = h.slice(0, -1)      // FQDN 根点
  if (h === '' || h.startsWith('.') || h.endsWith('.') || h.includes('..')) {
    throw fail(API_CODES.HOST_MALFORMED, `host ${JSON.stringify(input)} 规范化之后不是合法域名（${JSON.stringify(h)}）`)
  }
  if (!/^[a-z0-9.-]+$/.test(h)) {
    throw fail(
      API_CODES.HOST_MALFORMED,
      `host ${JSON.stringify(input)} 规范化之后含非法字符（${JSON.stringify(h)}）。` +
      '不允许通配——一个"host 可以写 *"的端点表，与一个"这条授权对所有 host 生效"的端点表，是同一个东西',
    )
  }
  return h
}

// ============================================================ ③ 方法

/**
 * 方法 → 效果。**不认识的 method 抛，不给默认值。**
 *
 *   > 一个「不认识的方法就按读处理」的分类，
 *   > 与一个「自研的上传方法 `UPLOAD` 被当成读」的分类，是同一个东西——
 *   > 而它的方向是放行。
 */
export const METHOD_EFFECTS = Object.freeze({
  GET: 'read', HEAD: 'read', OPTIONS: 'read', TRACE: 'read',
  POST: 'write', PUT: 'write', PATCH: 'write', DELETE: 'write',
})

/**
 * 能**覆盖请求行上的 method** 的头部与查询参数名（小写比较）。
 *
 *   > 一个「只看请求行上的 method」的检查，
 *   > 与一个「`GET /api/items/1` + `X-HTTP-Method-Override: DELETE` 真的删掉了」的检查，
 *   > 是同一个东西——而它的方向是放行。
 */
export const METHOD_OVERRIDE_KEYS = Object.freeze([
  'x-http-method-override', 'x-method-override', 'x-http-method',
  'http-method', 'method-override', '_method', '_action', 'method', 'http_method',
])

/**
 * 在**查询参数**里表达动作的名字（小写比较）。
 *
 *   > 一个「`GET ?action=delete` 算读」的分类，
 *   > 与一个「删除走了一个叫"读"的权限」的分类，是同一个东西。
 */
export const ACTION_QUERY_KEYS = Object.freeze([
  'action', 'op', 'operation', 'cmd', 'command', 'do', 'perform', 'execute',
])

/**
 * 会被误当成"这个请求没有副作用"的声明式标记（小写比较）。
 *
 *   > 一个「请求里写了 dry_run 就当成读」的分类，
 *   > 与一个「由调用方自己声明自己没有副作用」的分类，是同一个东西。
 */
export const DRY_RUN_KEYS = Object.freeze([
  'dry_run', 'dryrun', 'dry-run', 'validate', 'validate_only', 'validation_only',
  'preview', 'test', 'simulate', 'noop', 'no_op', 'check_only',
])

/** 方法 → 效果。不认识就抛 `UNKNOWN_METHOD`。大小写与首尾空白都规范化。 */
export function effectOfMethod(method) {
  if (typeof method !== 'string' || method.trim() === '') {
    throw fail(API_CODES.BAD_REQUEST, `method 必须是非空字符串，收到 ${JSON.stringify(method)}`)
  }
  const m = method.trim().toUpperCase()
  const effect = METHOD_EFFECTS[m]
  if (effect === undefined) {
    throw fail(
      API_CODES.UNKNOWN_METHOD,
      `不认识 HTTP 方法 ${JSON.stringify(method)}。` +
      '不给"默认按读处理"的兜底——一个"不认识的方法就当读"的分类，' +
      '与一个"自研的 UPLOAD 方法被当成读"的分类，是同一个东西',
    )
  }
  return effect
}

function collectOverrides({ headers = {}, query = {} } = {}) {
  const override = []
  for (const k of Object.keys(headers)) {
    if (METHOD_OVERRIDE_KEYS.includes(String(k).toLowerCase())) {
      override.push({ where: 'header', key: String(k), value: headers[k] })
    }
  }
  const action = []
  const dryRun = []
  for (const k of Object.keys(query)) {
    const lk = String(k).toLowerCase()
    if (METHOD_OVERRIDE_KEYS.includes(lk)) {
      override.push({ where: 'query', key: String(k), value: query[k] })
    } else if (ACTION_QUERY_KEYS.includes(lk)) {
      action.push({ where: 'query', key: String(k), value: query[k] })
    }
    if (DRY_RUN_KEYS.includes(lk)) dryRun.push({ where: 'query', key: String(k), value: query[k] })
  }
  return Object.freeze({
    override: Object.freeze(override),
    action: Object.freeze(action),
    dryRun: Object.freeze(dryRun),
  })
}

/** body 算不算"非空"：`null`/`undefined`/空串/空对象/空数组都算空。 */
export function isEmptyBody(body) {
  if (body === null || body === undefined) return true
  if (typeof body === 'string') return body.trim() === ''
  if (Buffer.isBuffer(body)) return body.length === 0
  if (Array.isArray(body)) return body.length === 0
  if (typeof body === 'object') return Object.keys(body).length === 0
  return false
}

/**
 * 分类一次外部 API 调用。
 *
 * @returns {{effect: 'read'|'write', method: string, pathKey: string, overrideKeys: readonly object[], actionKeys: readonly object[], dryRunKeys: readonly object[], downgradeAttempt: boolean}}
 */
export function classifyEffect({ method, path = '/', headers = {}, query = {}, body = null } = {}) {
  const m = String(method ?? '').trim().toUpperCase()
  const declared = effectOfMethod(method)   // 不认识的方法在这里就抛了
  const found = collectOverrides({ headers, query })

  // ① 能覆盖方法的东西一律拒绝。**在分类之前**，因为"分类"这件事的前提就是
  //    "请求行上的方法就是服务端会执行的方法"。
  if (found.override.length > 0) {
    throw fail(
      API_CODES.METHOD_OVERRIDE,
      `请求带了能覆盖 HTTP 方法的东西 ${JSON.stringify(found.override.map((o) => `${o.where}:${o.key}`))}。` +
      '一个"只看请求行上的 method"的检查，' +
      '与一个"GET + X-HTTP-Method-Override: DELETE 真的删掉了"的检查，是同一个东西',
    )
  }

  // ② 路径必须先进规范形式，再判后面两件事——否则 `?action=delete` 写在 path 里
  //    就会绕过第 ③ 条（它从来没进过 `query` 对象）。
  const pathNorm = normalizeUrlPath(path)

  // ③ 声明为读的方法**不能带请求体**。
  if (declared === 'read' && !isEmptyBody(body)) {
    throw fail(
      API_CODES.READ_WITH_BODY,
      `方法 ${m} 被当作读，但它带了非空请求体。` +
      '一个"GET 带 body 也算读"的分类，' +
      '与一个"某些框架会把 GET 的 body 当参数处理、于是它成了写"的分类，是同一个东西',
    )
  }

  // ④ 读请求的查询参数里不能出现"动作"名。
  if (declared === 'read' && found.action.length > 0) {
    throw fail(
      API_CODES.ACTION_IN_QUERY,
      `方法 ${m} 被当作读，但查询参数里有动作名 ${JSON.stringify(found.action.map((o) => `${o.key}=${String(o.value)}`))}。` +
      '一个"`GET ?action=delete` 算读"的分类，' +
      '与一个"删除走了一个叫读的权限"的分类，是同一个东西',
    )
  }

  return Object.freeze({
    effect: declared,
    method: m,
    declared,
    pathKey: pathNorm.key,
    pathSegments: pathNorm.segments,
    overrideKeys: found.override,
    actionKeys: found.action,
    dryRunKeys: found.dryRun,
    // 试图降级的痕迹：一次写请求带了 dry_run。这一条**不改 effect**——
    // 是否真的没有副作用是**服务端**的事，调用方说的不算。只把它记进证据里，
    // 让审计能看到"有人试图用 dry_run 让一次写看起来像读"。
    downgradeAttempt: declared === 'write' && found.dryRun.length > 0,
  })
}

// ============================================================ ④ 端点匹配

/**
 * 端点模式：`/api/items/{id}`。
 *
 * ⚠️ `{id}` 只匹配**恰好一段**，且要求整段就是一个占位符：
 *
 *   > 一个「`{id}` 能吃下若干段」的模式，
 *   > 与一个「`/api/items/{id}` 的读权限覆盖了 `/api/items/1/delete`」的模式，
 *   > 是同一个东西——而它的方向是放行。
 *
 * 而且**不允许通配**：`*`、`?`、`[...]`、`(...)`、正则一律拒绝。
 *
 *   > 一个「支持 `*` 的端点表」的授权，
 *   > 与一个「所有端点都被允许」的授权，是同一个东西——
 *   > 只不过前者在配置里看起来是有选择的。
 */
const PATTERN_SEGMENT = /^\{[A-Za-z_][A-Za-z0-9_]*\}$/
const GLOB_CHARS = ['*', '?', '[', ']', '(', ')', '|', '^', '$', '\\', '+', '<', '>']

/**
 * 解析一个端点模式。
 *
 * @returns {{host: string, segments: readonly string[], keys: readonly object[], template: string}}
 */
export function parseEndpointPattern({ pattern, host = null } = {}) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw fail(API_CODES.BAD_PATTERN, `端点模式必须是非空字符串，收到 ${JSON.stringify(pattern)}`)
  }
  // 逐段检查通配，而不是对整串做 includes —— 占位符的 `{}` 是合法的，
  // 而 `{`/`}` 不在 GLOB_CHARS 里，所以整串 `includes` 与逐段等价；
  // 但 `?` 在整串里会被误当成"path 带查询"，所以必须在切段**之前**先判通配。
  for (const c of GLOB_CHARS) {
    if (pattern.includes(c)) {
      throw fail(
        API_CODES.WILDCARD_PATTERN,
        `端点模式 ${JSON.stringify(pattern)} 里出现了通配/正则字符 ${JSON.stringify(c)}。` +
        '一个"支持 * 的端点表"的授权，与一个"所有端点都被允许"的授权，是同一个东西——' +
        '只不过前者在配置里看起来是有选择的',
      )
    }
  }
  checkChars(pattern)
  if (!pattern.startsWith('/')) {
    throw fail(API_CODES.NOT_ABSOLUTE, `端点模式必须以 / 开头：${JSON.stringify(pattern)}`)
  }
  if (pattern.length > 1 && pattern.endsWith('/')) {
    throw fail(API_CODES.TRAILING_SLASH, `端点模式不该以 / 结尾：${JSON.stringify(pattern)}`)
  }
  const rawSegments = pattern.slice(1) === '' ? [] : pattern.slice(1).split('/')
  const segments = []
  const keys = []
  for (const rawSeg of rawSegments) {
    if (rawSeg === '') {
      throw fail(API_CODES.EMPTY_SEGMENT, `端点模式里有连续的 / ：${JSON.stringify(pattern)}`)
    }
    if (PATTERN_SEGMENT.test(rawSeg)) {
      keys.push(Object.freeze({ name: rawSeg.slice(1, -1), index: segments.length }))
      segments.push('*')
      continue
    }
    if (rawSeg.includes('{') || rawSeg.includes('}')) {
      throw fail(
        API_CODES.BAD_PATTERN,
        `端点模式 ${JSON.stringify(pattern)} 的第 ${segments.length + 1} 段 ${JSON.stringify(rawSeg)} ` +
        '不是一个合法的占位符。占位符必须**整段**形如 `{name}`——' +
        '一个"占位符只占半段"的模式，与一个"`/api/{id}-x` 被当成 `/api/*`"的模式，是同一个东西',
      )
    }
    const text = normalizePathSegment(rawSeg)
    if (text === '.' || text === '..') {
      throw fail(
        text === '.' ? API_CODES.DOT_SEGMENT : API_CODES.PATH_ESCAPE,
        `端点模式 ${JSON.stringify(pattern)} 里有 ${JSON.stringify(text)} 段——规范形式不允许`,
      )
    }
    segments.push(text)
  }
  return Object.freeze({
    host: normalizeHost(host),
    segments: Object.freeze(segments),
    keys: Object.freeze(keys),
    template: pattern,
  })
}

/**
 * 模式与请求是否匹配。**整段对齐**，占位符恰好一段。
 *
 * @returns {{matched: boolean, captures: object|null, reason: string|null}}
 */
export function matchEndpoint({ endpoint, request }) {
  if (endpoint.host !== request.host) {
    return Object.freeze({ matched: false, captures: null, reason: `host 不同（${endpoint.host} ≠ ${request.host}）` })
  }
  const p = endpoint.segments
  const r = request.segments
  if (p.length !== r.length) {
    return Object.freeze({
      matched: false,
      captures: null,
      reason: `段数不同（模式 ${p.length} 段，请求 ${r.length} 段）。` +
        '段数必须相等——一个"能用前缀匹配"的判定，' +
        '与一个"/api/items 的读权限覆盖了 /api/items/1/delete"的判定，是同一个东西',
    })
  }
  const captures = {}
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*') {
      const holder = endpoint.keys.find((k) => k.index === i)
      captures[holder.name] = r[i]
      continue
    }
    if (p[i] !== r[i]) {
      return Object.freeze({ matched: false, captures: null, reason: `第 ${i + 1} 段不同（${JSON.stringify(p[i])} ≠ ${JSON.stringify(r[i])}）` })
    }
  }
  return Object.freeze({ matched: true, captures: Object.freeze(captures), reason: null })
}

// ============================================================ ⑤ 授权表

/** 高风险动作类别（spec §6.6 line 466：发布、付款、删除等）。 */
export const RISK_CLASSES = Object.freeze([
  'publish',    // 发布
  'payment',    // 付款
  'delete',     // 删除
  'credential', // 凭据
  'permission', // 权限/成员
  'transfer',   // 所有权/资产转移
])

export const EFFECTS = Object.freeze(['read', 'write'])

const GRANT_FIELDS = Object.freeze(['version', 'endpoints'])
const ENDPOINT_FIELDS = Object.freeze([
  'host', 'pattern', 'effects', 'riskClass', 'idempotent', 'notes',
])

/**
 * 归一化一份外部 API 授权表。
 *
 * 每条端点**显式列出它覆盖哪些效果**（`effects: ['read']` / `['read','write']`）。
 * 不写 `effects` 就报错——"默认是读"这件事本身就是本模块要防的那个错误：
 *
 *   > 一个「没写 effects 就默认允许读」的端点表，
 *   > 与一个「每条端点都至少允许读」的端点表，是同一个东西。
 */
export function normalizeApiGrant(input) {
  if (input === null || typeof input !== 'object') {
    throw fail(API_CODES.BAD_GRANT, 'normalizeApiGrant 需要一份授权对象')
  }
  const unknown = Object.keys(input).filter((k) => !GRANT_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw fail(
      API_CODES.BAD_GRANT,
      `授权表里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的授权表，与一个"多打的一个字母让整条限制静默失效"的授权表，是同一个东西',
    )
  }
  if (input.version !== undefined && input.version !== EXTERNAL_API_SCOPE_VERSION) {
    throw fail(API_CODES.BAD_GRANT, `授权表的 version 是 ${JSON.stringify(input.version)}，期望 ${JSON.stringify(EXTERNAL_API_SCOPE_VERSION)}`)
  }
  if (!Array.isArray(input.endpoints)) {
    throw fail(API_CODES.BAD_GRANT, 'endpoints 必须是数组（空数组表示什么都不可调用）')
  }
  const endpoints = input.endpoints.map((e, i) => {
    if (e === null || typeof e !== 'object') {
      throw fail(API_CODES.BAD_GRANT, `endpoints[${i}] 必须是对象`)
    }
    const dup = Object.keys(e).filter((k) => !ENDPOINT_FIELDS.includes(k))
    if (dup.length > 0) {
      throw fail(API_CODES.BAD_GRANT, `endpoints[${i}] 出现了不认识的字段 ${JSON.stringify(dup)}`)
    }
    if (!Array.isArray(e.effects) || e.effects.length === 0) {
      throw fail(
        API_CODES.BAD_GRANT,
        `endpoints[${i}]（${JSON.stringify(e.pattern)}）必须显式列出 effects。` +
        '一个"没写 effects 就默认允许读"的端点表，与一个"每条端点都至少允许读"的端点表，是同一个东西',
      )
    }
    for (const eff of e.effects) {
      if (!EFFECTS.includes(eff)) {
        throw fail(API_CODES.BAD_GRANT, `endpoints[${i}] 的 effect ${JSON.stringify(eff)} 不是 ${JSON.stringify(EFFECTS)} 之一`)
      }
    }
    if (e.riskClass !== undefined && e.riskClass !== null && !RISK_CLASSES.includes(e.riskClass)) {
      throw fail(
        API_CODES.UNKNOWN_RISK_CLASS,
        `endpoints[${i}] 的 riskClass ${JSON.stringify(e.riskClass)} 不在 ${JSON.stringify(RISK_CLASSES)} 之内。` +
        '高风险类别必须**被点名**，不能从路径里猜——' +
        '一个"用路径里有没有 delete 这个词判断高风险"的分类，' +
        '与一个"/api/items/delete-preview 被当成删除动作"的分类，是同一个东西',
      )
    }
    // 高风险类别不可能属于一条**只读**的端点。
    if (e.riskClass !== undefined && e.riskClass !== null
      && e.effects.length === 1 && e.effects[0] === 'read') {
      throw fail(
        API_CODES.HIGH_RISK_ON_READ,
        `endpoints[${i}]（${JSON.stringify(e.pattern)}）声明了高风险类别 ${JSON.stringify(e.riskClass)}，但它只允许读。` +
        '高风险动作不可能是读——一个"读端点带 payment 类别"的表，' +
        '与一个"读权限被当成高风险动作的授权"的表，是同一个东西',
      )
    }
    // 会改状态的端点必须显式声明它是不是幂等的——否则"重试"这件事无法判定。
    if (e.effects.includes('write') && typeof e.idempotent !== 'boolean') {
      throw fail(
        API_CODES.BAD_GRANT,
        `endpoints[${i}]（${JSON.stringify(e.pattern)}）允许写，但没有声明 idempotent。` +
        '一个"没声明幂等性的写端点"，与一个"重试算第二次写、但只审了一次"的端点，是同一个东西',
      )
    }
    // host 是必需的（normalizeHost 会拒绝空值）。
    //
    // ⚠️ **模式在这里就要解析**，不能留到调用时。写过一版只在 `checkExternalApi`
    // 里解析，结果是：一份授权表里写着 `/api/items/../admin` 或 `/api/*`，**建表成功**，
    // 直到某次请求才报出 `PATH_ESCAPE`/`WILDCARD_PATTERN`——而那个码看起来像是
    // **这次请求**的问题，于是值班的人去改请求，而真正该改的是那张表。
    //
    //   > 一个「把授权表的错报成请求的错」的诊断，
    //   > 与一个「值班的人去改请求、而配置一直错着」的诊断，是同一个东西。
    const parsed = parseEndpointPattern({ pattern: e.pattern, host: e.host })
    return Object.freeze({
      host: parsed.host,
      pattern: e.pattern,
      parsed,
      effects: Object.freeze([...e.effects]),
      riskClass: e.riskClass === undefined ? null : e.riskClass,
      idempotent: e.idempotent === undefined ? null : e.idempotent,
      notes: e.notes === undefined ? null : (e.notes === null ? null : String(e.notes)),
    })
  })
  return Object.freeze({ version: EXTERNAL_API_SCOPE_VERSION, endpoints: Object.freeze(endpoints) })
}

// ============================================================ ⑥ 判定

const EMPTY_VERDICT = Object.freeze({
  effect: null, endpoint: null, riskClass: null, highRisk: false, captures: null,
  idempotencyKey: null, canonicalKey: null, retry: false,
  downgradeAttempt: false, dryRunKeys: Object.freeze([]),
})

/**
 * 判定一次外部 API 调用是否在授权之内。
 *
 * @param {object} p
 * @param {object} p.request `{ method, path, host, headers?, query?, body?, idempotencyKey? }`
 * @param {object} p.grant
 * @param {string|null} [p.retryOf] 若这次是重试，给出同一幂等键的首次调用的 `canonicalKey`
 */
export function checkExternalApi({ request, grant, retryOf = null } = {}) {
  if (request === null || typeof request !== 'object') {
    return Object.freeze({ allowed: false, code: API_CODES.BAD_REQUEST, reason: 'request 必须是对象', ...EMPTY_VERDICT })
  }

  let classified
  try {
    classified = classifyEffect({
      method: request.method, path: request.path,
      headers: request.headers, query: request.query, body: request.body,
    })
  } catch (err) {
    return Object.freeze({ allowed: false, code: err?.code ?? API_CODES.BAD_REQUEST, reason: err?.message ?? String(err), ...EMPTY_VERDICT })
  }

  let host
  try {
    host = normalizeHost(request.host)
  } catch (err) {
    return Object.freeze({ allowed: false, code: err?.code ?? API_CODES.HOST_MALFORMED, reason: err?.message ?? String(err), ...EMPTY_VERDICT, effect: classified.effect })
  }

  const endpoints = grant?.endpoints
  if (!Array.isArray(endpoints)) {
    return Object.freeze({ allowed: false, code: API_CODES.BAD_GRANT, reason: '这个岗位没有外部 API 授权', ...EMPTY_VERDICT, effect: classified.effect })
  }

  const reqShape = Object.freeze({ host, segments: classified.pathSegments })

  // 找到**所有**匹配的端点。多于一条就报歧义——两条规则同时命中时"用哪条"取决于
  // 遍历顺序，而顺序不是配置的一部分：
  //
  //   > 一个「多条规则命中时取第一条」的匹配，
  //   > 与一个「换个遍历顺序结论就变」的匹配，是同一个东西。
  const hits = []
  for (const e of endpoints) {
    // 已归一化的端点带着 `parsed`（`normalizeApiGrant` 建表时就解析过了）；
    // 手写的裸端点在这里解析——诊断仍然要给出来，而不是抛。
    let parsed = e.parsed
    if (parsed === undefined) {
      try {
        parsed = parseEndpointPattern({ pattern: e.pattern, host: e.host })
      } catch (err) {
        return Object.freeze({ allowed: false, code: err?.code ?? API_CODES.BAD_PATTERN, reason: err?.message ?? String(err), ...EMPTY_VERDICT, effect: classified.effect })
      }
    }
    const m = matchEndpoint({ endpoint: parsed, request: reqShape })
    if (m.matched) hits.push({ entry: e, captures: m.captures })
  }
  if (hits.length === 0) {
    return Object.freeze({
      allowed: false,
      code: API_CODES.ENDPOINT_NOT_GRANTED,
      reason: `${classified.method} ${classified.pathKey} 不匹配任何被授权的端点`,
      ...EMPTY_VERDICT,
      effect: classified.effect,
    })
  }
  if (hits.length > 1) {
    // ⚠️ 用一个**自己的**码，而不是复用 `BAD_GRANT`：授权的**语法**没问题，
    // 有问题的是两条模式**互相重叠**，而这两件事的修复动作完全不同。
    //
    //   > 一个「把'请求匹配到多条规则'报成'授权表格式错误'」的诊断，
    //   > 与一个「值班的人去改授权表的语法、而其实该做的是让模式互不重叠」的诊断，
    //   > 是同一个东西。
    return Object.freeze({
      allowed: false,
      code: API_CODES.AMBIGUOUS_MATCH,
      reason: `${classified.method} ${classified.pathKey} 同时匹配 ${hits.length} 条端点（${hits.map((h) => h.entry.pattern).join(' / ')}）。` +
        '一个"多条规则命中时取第一条"的匹配，与一个"换个遍历顺序结论就变"的匹配，是同一个东西——' +
        '修法是把重叠的模式改掉，而不是改授权表的格式',
      ...EMPTY_VERDICT,
      effect: classified.effect,
    })
  }
  const hit = hits[0]

  // ★ 读权限与写权限是**两个**权限。这就是 PRT-606 要区分的那件事。
  //
  //   > 一个「允许读就顺带允许写」的端点表，
  //   > 与一个「读和写是同一个权限」的端点表，是同一个东西。
  if (!hit.entry.effects.includes(classified.effect)) {
    return Object.freeze({
      allowed: false,
      code: API_CODES.EFFECT_MISMATCH,
      reason: `端点 ${JSON.stringify(hit.entry.pattern)} 只授权了 ${JSON.stringify([...hit.entry.effects])}，` +
        `而这次是**${classified.effect === 'write' ? '写' : '读'}**（${classified.method}）。` +
        '一个"允许读就顺带允许写"的端点表，与一个"读和写是同一个权限"的端点表，是同一个东西',
      ...EMPTY_VERDICT,
      effect: classified.effect,
      endpoint: hit.entry,
      riskClass: hit.entry.riskClass,
      highRisk: classified.effect === 'write' && hit.entry.riskClass !== null,
      captures: hit.captures,
      downgradeAttempt: classified.downgradeAttempt,
      dryRunKeys: classified.dryRunKeys,
    })
  }

  const idempotencyKey = request.idempotencyKey === undefined || request.idempotencyKey === null
    ? null
    : String(request.idempotencyKey)

  if (classified.effect === 'write' && hit.entry.idempotent === false && idempotencyKey !== null) {
    // 端点自己声明了"不幂等"，却带了一个幂等键——这个键不会有用，别让它给审计错觉。
    //
    //   > 一个「带了幂等键就以为重试安全」的判定，
    //   > 与一个「服务端不认这个键、于是每次重试都真的执行一遍」的判定，是同一个东西。
    //
    // 码名说的是**这件事**（这个端点的幂等声明不被兑现），不是"缺少幂等键"——
    // 后者会把值班的人引向"给它加个键"，而正确的动作是"别重试"或者"换个端点"。
    return Object.freeze({
      allowed: false,
      code: API_CODES.IDEMPOTENCY_NOT_HONORED,
      reason: `端点 ${JSON.stringify(hit.entry.pattern)} 声明了 idempotent: false，但请求带了幂等键 ${JSON.stringify(idempotencyKey)}。` +
        '这个键不会被兑现——一个"带了幂等键就以为重试安全"的判定，' +
        '与一个"服务端不认这个键、于是每次重试都真的执行一遍"的判定，是同一个东西',
      ...EMPTY_VERDICT,
      effect: classified.effect,
      endpoint: hit.entry,
      riskClass: hit.entry.riskClass,
      highRisk: hit.entry.riskClass !== null,
      captures: hit.captures,
      idempotencyKey,
      downgradeAttempt: classified.downgradeAttempt,
      dryRunKeys: classified.dryRunKeys,
    })
  }

  // 重试**仍然是写**。它只是"同一个写"的第二次投递，不是一次读。
  //
  //   > 一个「把重试当成读」的分类，
  //   > 与一个「重试算第二次写、但只审了一次」的分类，是同一个东西。
  const retry = retryOf !== null && idempotencyKey !== null

  return Object.freeze({
    allowed: true,
    code: null,
    reason: null,
    effect: classified.effect,
    endpoint: hit.entry,
    // 高风险标记交给 PRT-607 的审批门：它决定"要不要批准"，本模块只负责**说清楚**。
    // spec line 944「未批准高风险写操作为零」需要一个可信的 highRisk 信号。
    riskClass: hit.entry.riskClass,
    highRisk: classified.effect === 'write' && hit.entry.riskClass !== null,
    captures: hit.captures,
    idempotencyKey,
    canonicalKey: canonicizeApiCall({
      host, method: classified.method, path: classified.pathKey, idempotencyKey,
    }),
    retry,
    downgradeAttempt: classified.downgradeAttempt,
    dryRunKeys: classified.dryRunKeys,
  })
}

/**
 * 一次外部 API 调用的规范化标识。
 *
 * 与 PRT-602 的 `canonicalOperationHash` 不同：那一个是**授权主体**（谁、对什么、
 * 干什么），这一个只是"这一次外部调用的身份"，用于幂等键配对。
 * 键序固定，不用 `JSON.stringify` 判等（PRT-611 的纪律）。
 */
export function canonicizeApiCall({ host = null, method, path, idempotencyKey = null } = {}) {
  return ['external-api@1', host ?? '-', String(method).toUpperCase(), path, idempotencyKey ?? '-'].join('|')
}

// ============================================================ 装载自检

const H = 'api.example.com'

const PROBE_GRANT = normalizeApiGrant({
  version: EXTERNAL_API_SCOPE_VERSION,
  endpoints: [
    { host: H, pattern: '/api/items', effects: ['read'] },
    { host: H, pattern: '/api/items/{id}', effects: ['read', 'write'], idempotent: true },
    { host: H, pattern: '/api/orders', effects: ['write'], idempotent: false, riskClass: 'payment' },
    { host: H, pattern: '/api/catalog', effects: ['read', 'write'], idempotent: true, riskClass: 'publish' },
    { host: H, pattern: '/api/files/{id}', effects: ['write'], idempotent: true, riskClass: 'delete' },
  ],
})

/** ① 读权限不能变成写权限（七种"看起来是读"的东西逐个探）。 */
export function assertReadNeverBecomesWrite() {
  const readGrant = normalizeApiGrant({
    version: EXTERNAL_API_SCOPE_VERSION,
    endpoints: [{ host: 'h.example.com', pattern: '/api/items', effects: ['read'] }],
  })
  const samples = [
    { label: '纯读', request: { method: 'GET', path: '/api/items', host: 'h.example.com' }, expect: 'allow' },
    { label: '写方法打读端点', request: { method: 'POST', path: '/api/items', host: 'h.example.com', body: {} }, expect: API_CODES.EFFECT_MISMATCH },
    { label: '方法覆盖头', request: { method: 'GET', path: '/api/items', host: 'h.example.com', headers: { 'X-HTTP-Method-Override': 'DELETE' } }, expect: API_CODES.METHOD_OVERRIDE },
    { label: '方法覆盖参数', request: { method: 'GET', path: '/api/items', host: 'h.example.com', query: { _method: 'DELETE' } }, expect: API_CODES.METHOD_OVERRIDE },
    { label: '读带 body', request: { method: 'GET', path: '/api/items', host: 'h.example.com', body: { a: 1 } }, expect: API_CODES.READ_WITH_BODY },
    { label: '动作写在查询里', request: { method: 'GET', path: '/api/items', host: 'h.example.com', query: { action: 'delete' } }, expect: API_CODES.ACTION_IN_QUERY },
    { label: '动作写在 path 里（不进 query）', request: { method: 'GET', path: '/api/items?action=delete', host: 'h.example.com' }, expect: API_CODES.PATH_HAS_QUERY },
    { label: '更深一段（读）', request: { method: 'GET', path: '/api/items/1', host: 'h.example.com' }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { label: '更深一段（写）', request: { method: 'DELETE', path: '/api/items/1/delete', host: 'h.example.com' }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { label: '前缀边界', request: { method: 'GET', path: '/api/items-other', host: 'h.example.com' }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { label: '大写路径（URL 永远大小写敏感）', request: { method: 'GET', path: '/API/ITEMS', host: 'h.example.com' }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { label: '编码斜杠制造第二段', request: { method: 'GET', path: '/api/items%2F1', host: 'h.example.com' }, expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { label: '百分号编码的同一端点（允许）', request: { method: 'GET', path: '/%61pi/items', host: 'h.example.com' }, expect: 'allow' },
  ]
  const out = samples.map((s) => {
    const v = checkExternalApi({ request: s.request, grant: readGrant })
    return Object.freeze({ label: s.label, expect: s.expect, got: v.allowed ? 'allow' : v.code, allowed: v.allowed })
  })
  return Object.freeze({ samples: Object.freeze(out), mismatched: Object.freeze(out.filter((o) => o.got !== o.expect)) })
}

/** ② 前缀匹配会把写放进来——把**会放行的那几行**列出来当证据。 */
export function assertPrefixMatchingWouldAllowWrite() {
  // 若用 `startsWith(端点)` 判匹配，下面这些请求都会落进一条端点。
  const pairs = [
    { granted: '/api/items', requested: '/api/items/1/delete', note: '更深一段的写' },
    { granted: '/api/orders', requested: '/api/orders/9/refund', note: '更深一段的写' },
    { granted: '/api/catalog', requested: '/api/catalog/publish', note: '更深一段的写' },
    // 边界：`/api/items-other` **不是** `/api/items` 之下（PRT-604 的同一条教训）
    { granted: '/api/items', requested: '/api/items-other', note: '前缀边界' },
  ]
  const rows = pairs.map((p) => {
    const grantedNorm = normalizeUrlPath(p.granted)
    const requestedNorm = normalizeUrlPath(p.requested)
    return Object.freeze({
      granted: p.granted,
      requested: p.requested,
      note: p.note,
      grantedKey: grantedNorm.key,
      requestedKey: requestedNorm.key,
      startsWithWouldMatch: requestedNorm.key.startsWith(grantedNorm.key),
      // 正确的判定：段数必须相等
      segmentCounts: [grantedNorm.segments.length, requestedNorm.segments.length],
    })
  })
  // 另一种形态：`..` 被**折叠**而不是被拒绝时会发生什么。
  const fold = (input) => {
    const out = []
    for (const s of input.split('/').filter((x) => x !== '')) {
      if (s === '..') out.pop()
      else if (s !== '.') out.push(s)
    }
    return '/' + out.join('/')
  }
  // ★ 真正会升级的是**模式侧**：一条写着 `..` 的规则，字面上什么都不匹配；
  //   折叠之后它变成对**另一个端点**的授权。
  const foldPatterns = [
    { pattern: '/api/items/../admin', effects: ['read'], note: '只读规则被折叠成 /api/admin 的读授权' },
    { pattern: '/api/public/../internal/secrets', effects: ['read'], note: '折叠后落到高敏感端点' },
    { pattern: '/api/orders/../../billing/pay', effects: ['write'], note: '折叠后落到付款端点' },
  ]
  const folds = foldPatterns.map((f) => Object.freeze({
    pattern: f.pattern,
    effects: f.effects,
    foldedPattern: fold(f.pattern),
    // 字面量匹配：这条规则**什么**都匹配不到（除了一个真的叫 .. 的段）
    literalWouldMatchNothing: true,
    // 折叠后它其实是一条对 foldedPattern 的授权
    changedEndpoint: fold(f.pattern) !== f.pattern,
    // 本模块的处置
    normalizedCode: (() => { try { parseEndpointPattern({ pattern: f.pattern, host: 'h.example.com' }); return null } catch (e) { return e.code } })(),
    note: f.note,
  }))
  // 请求侧：折叠会替调用方决定它落到哪个端点（同段数的另一条路径）
  const foldRequests = [
    { requested: '/api/items/1/../secret', note: '折叠后仍是 /api/items/{id} 家族' },
    { requested: '/api/%2e%2e/admin', note: '编码的 .. 解码后才看得出' },
  ]
  const requestFolds = foldRequests.map((f) => Object.freeze({
    requested: f.requested,
    folded: fold(percentDecodeOnce(f.requested)),
    normalizedCode: (() => { try { normalizeUrlPath(f.requested); return null } catch (e) { return e.code } })(),
    note: f.note,
  }))
  return Object.freeze({
    rows: Object.freeze(rows),
    prefixWouldAllowCount: rows.filter((r) => r.startsWithWouldMatch).length,
    foldingPatterns: Object.freeze(folds),
    foldingPatternsChangedEndpoint: folds.filter((f) => f.changedEndpoint).length,
    foldingPatternsAllRejected: folds.every((f) => f.normalizedCode !== null),
    foldingRequests: Object.freeze(requestFolds),
  })
}

/** ③ 占位符恰好一段。 */
export function assertPlaceholderIsSingleSegment() {
  const g = normalizeApiGrant({
    version: EXTERNAL_API_SCOPE_VERSION,
    endpoints: [{ host: 'h.example.com', pattern: '/api/items/{id}', effects: ['read'] }],
  })
  const samples = [
    { path: '/api/items/1', expect: 'allow' },
    { path: '/api/items/1/delete', expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { path: '/api/items', expect: API_CODES.ENDPOINT_NOT_GRANTED },
    { path: '/api/items/1/2', expect: API_CODES.ENDPOINT_NOT_GRANTED },
  ]
  const out = samples.map((s) => {
    const v = checkExternalApi({ request: { method: 'GET', path: s.path, host: 'h.example.com' }, grant: g })
    return Object.freeze({ path: s.path, expect: s.expect, got: v.allowed ? 'allow' : v.code, captures: v.captures })
  })
  const parsed = parseEndpointPattern({ pattern: '/api/items/{id}', host: 'h.example.com' })
  // 半段占位符必须拒绝
  const halfPlaceholders = ['/api/{id}-x', '/api/x{id}', '/api/{id}{x}', '/api/']
  const half = halfPlaceholders.map((p) => Object.freeze({ pattern: p, code: codeOf(() => parseEndpointPattern({ pattern: p, host: 'h.example.com' })) }))
  return Object.freeze({
    samples: Object.freeze(out),
    mismatched: Object.freeze(out.filter((o) => o.got !== o.expect)),
    parsedSegments: parsed.segments,
    parsedKeys: parsed.keys,
    halfPlaceholders: Object.freeze(half),
    halfAllRejected: half.every((o) => o.code !== 'NO-THROW'),
  })
}

/** ④ 方法覆盖的**所有**拼法都要拒绝（含大小写变形）。 */
export function assertEveryOverrideSpellingRejected() {
  const g = normalizeApiGrant({
    version: EXTERNAL_API_SCOPE_VERSION,
    endpoints: [{ host: 'h.example.com', pattern: '/api/items', effects: ['read'] }],
  })
  const out = METHOD_OVERRIDE_KEYS.map((k) => {
    const h = (headers) => checkExternalApi({ request: { method: 'GET', path: '/api/items', host: 'h.example.com', headers }, grant: g }).code
    const q = (query) => checkExternalApi({ request: { method: 'GET', path: '/api/items', host: 'h.example.com', query }, grant: g }).code
    return Object.freeze({
      key: k,
      header: h({ [k]: 'DELETE' }),
      upperHeader: h({ [k.toUpperCase()]: 'DELETE' }),
      mixedHeader: h({ [k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())]: 'DELETE' }),
      query: q({ [k]: 'DELETE' }),
    })
  })
  return Object.freeze({
    keys: Object.freeze(out),
    count: METHOD_OVERRIDE_KEYS.length,
    allRejected: out.every((o) => o.header === API_CODES.METHOD_OVERRIDE
      && o.query === API_CODES.METHOD_OVERRIDE
      && o.upperHeader === API_CODES.METHOD_OVERRIDE
      && o.mixedHeader === API_CODES.METHOD_OVERRIDE),
  })
}

/** ⑤ `dry_run` 不能让写降级成读。 */
export function assertDryRunDoesNotDowngrade() {
  const out = DRY_RUN_KEYS.map((k) => {
    const v = checkExternalApi({
      request: { method: 'POST', path: '/api/orders', host: H, body: { amount: 1 }, query: { [k]: 'true' } },
      grant: PROBE_GRANT,
    })
    return Object.freeze({ key: k, effect: v.effect, highRisk: v.highRisk, allowed: v.allowed, downgradeAttempt: v.downgradeAttempt === true })
  })
  return Object.freeze({
    keys: Object.freeze(out),
    count: DRY_RUN_KEYS.length,
    allStillWrite: out.every((o) => o.effect === 'write'),
    allStillHighRisk: out.every((o) => o.highRisk === true),
    allFlaggedAsAttempt: out.every((o) => o.downgradeAttempt === true),
  })
}

/** ⑥ 高风险类别必须被点名，不能从路径里猜。 */
export function assertRiskClassIsDeclaredNotInferred() {
  const readOnly = normalizeApiGrant({
    version: EXTERNAL_API_SCOPE_VERSION,
    endpoints: [{ host: 'h.example.com', pattern: '/api/items/{id}/delete-preview', effects: ['read'] }],
  })
  const preview = checkExternalApi({ request: { method: 'GET', path: '/api/items/1/delete-preview', host: 'h.example.com' }, grant: readOnly })
  const declared = checkExternalApi({
    request: { method: 'POST', path: '/api/orders', host: H, body: {} },
    grant: PROBE_GRANT,
  })
  const attempt = (input) => codeOf(() => normalizeApiGrant(input))
  return Object.freeze({
    // 路径里写着 delete，但声明是只读 ⇒ 不是高风险
    pathSaysDeleteButReadOnly: Object.freeze({ allowed: preview.allowed, highRisk: preview.highRisk, riskClass: preview.riskClass }),
    // 路径里什么都没有，但声明的类别是 payment ⇒ 是高风险
    pathSaysNothingButDeclared: Object.freeze({ highRisk: declared.highRisk, riskClass: declared.riskClass, endpointPattern: declared.endpoint?.pattern }),
    highRiskOnRead: attempt({ version: EXTERNAL_API_SCOPE_VERSION, endpoints: [{ host: 'h', pattern: '/api/x', effects: ['read'], riskClass: 'payment' }] }),
    unknownClass: attempt({ version: EXTERNAL_API_SCOPE_VERSION, endpoints: [{ host: 'h', pattern: '/api/x', effects: ['write'], idempotent: true, riskClass: 'refund' }] }),
    inferredFromPath: RISK_CLASSES.filter((c) => '/api/items/1/delete-preview'.includes(c)),
  })
}

/** ⑦ 读与写是两个权限。 */
export function assertReadAndWriteAreSeparatePermissions() {
  const cases = [
    { effects: ['read'], method: 'GET', expect: true },
    { effects: ['read'], method: 'POST', expect: false },
    { effects: ['write'], method: 'GET', expect: false },
    { effects: ['write'], method: 'POST', expect: true },
    { effects: ['read', 'write'], method: 'GET', expect: true },
    { effects: ['read', 'write'], method: 'POST', expect: true },
  ]
  const out = cases.map((c) => {
    const g = normalizeApiGrant({
      version: EXTERNAL_API_SCOPE_VERSION,
      endpoints: [{ host: 'h.example.com', pattern: '/api/x', effects: c.effects, idempotent: true }],
    })
    const v = checkExternalApi({
      request: { method: c.method, path: '/api/x', host: 'h.example.com', body: c.method === 'POST' ? {} : null },
      grant: g,
    })
    return Object.freeze({ effects: c.effects, method: c.method, expect: c.expect, allowed: v.allowed, code: v.code })
  })
  return Object.freeze({ cases: Object.freeze(out), mismatched: Object.freeze(out.filter((o) => o.allowed !== o.expect)) })
}

/** ⑧ 未知方法 fail-closed，而"默认按读"会放行。 */
export function assertUnknownMethodFailsClosed() {
  // 只列**真正未知**的方法。早先的夹具里放了 `'get '` —— 它 trim 之后就是合法的
  // `GET`，于是"全部 fail-closed"这条断言永远不成立。
  //
  //   > 一个「夹具里混进一个合法值」的探针，
  //   > 与一个从没验证过这条规则的探针，是同一个东西。
  const unknowns = ['UPLOAD', 'PURGE', 'FROBNICATE', 'LOCK', 'COPY', 'REPORT']
  const out = unknowns.map((m) => {
    let code = null
    try { effectOfMethod(m) } catch (err) { code = err.code }
    return Object.freeze({ method: m, code })
  })
  const normalized = ['get', ' Get ', 'HEAD', 'delete', '\tpost\n'].map((m) => Object.freeze({ raw: m, effect: effectOfMethod(m) }))
  const wouldBeRead = unknowns.map((m) => Object.freeze({
    method: m,
    assumedReadWouldAllow: METHOD_EFFECTS[String(m).trim().toUpperCase()] === undefined,
  }))
  return Object.freeze({
    methods: Object.freeze(out),
    allFailedClosed: out.every((o) => o.code === API_CODES.UNKNOWN_METHOD),
    normalized,
    assumedReadWouldAllow: Object.freeze(wouldBeRead),
    assumedReadWouldAllowCount: wouldBeRead.filter((o) => o.assumedReadWouldAllow).length,
  })
}

/** ⑨ 通配模式一律拒绝（通配的路径 = 通配的权限）。 */
export function assertWildcardPatternRejected() {
  const patterns = ['/api/*', '/api/**', '/api/items/*', '/api/[a-z]+', '/api/items/(x|y)', '/api/a?b', '/api/\\d+', '/api/items/{id']
  const out = patterns.map((p) => {
    let accepted = true
    let code = null
    try { parseEndpointPattern({ pattern: p, host: 'h.example.com' }) } catch (err) { accepted = false; code = err.code }
    return Object.freeze({ pattern: p, accepted, code })
  })
  const valid = ['/api/items', '/api/{id}', '/api/items/{id}', '/api/items/{id}/sub']
  const validOut = valid.map((p) => {
    let accepted = true
    let code = null
    try { parseEndpointPattern({ pattern: p, host: 'h.example.com' }) } catch (err) { accepted = false; code = err.code }
    return Object.freeze({ pattern: p, accepted, code })
  })
  return Object.freeze({
    patterns: Object.freeze(out),
    acceptedCount: out.filter((o) => o.accepted).length,
    rejectedCodes: Object.freeze([...new Set(out.filter((o) => !o.accepted).map((o) => o.code))]),
    valid: Object.freeze(validOut),
    allValidAccepted: validOut.every((o) => o.accepted),
  })
}

/** ⑩ 授权表字段闭合 + 写端点必须声明幂等性 + host 必需。 */
export function assertGrantRequiresExplicitEffectsAndIdempotency() {
  const V = EXTERNAL_API_SCOPE_VERSION
  const tries = [
    { label: '缺 effects', input: { version: V, endpoints: [{ host: 'h', pattern: '/api/x' }] } },
    { label: 'effects 为空', input: { version: V, endpoints: [{ host: 'h', pattern: '/api/x', effects: [] }] } },
    { label: 'effect 不认识', input: { version: V, endpoints: [{ host: 'h', pattern: '/api/x', effects: ['execute'] }] } },
    { label: '写端点缺 idempotent', input: { version: V, endpoints: [{ host: 'h', pattern: '/api/x', effects: ['write'] }] } },
    { label: '端点多余字段', input: { version: V, endpoints: [{ host: 'h', pattern: '/api/x', effects: ['read'], allowPrefix: true }] } },
    { label: '根多余字段', input: { version: V, endpoints: [], denyPaths: [] } },
    { label: '版本不对', input: { version: 'legion/external-api-scope@0', endpoints: [] } },
    { label: 'endpoints 不是数组', input: { version: V, endpoints: null } },
    { label: 'host 缺失', input: { version: V, endpoints: [{ pattern: '/api/x', effects: ['read'] }] } },
    { label: 'host 为空', input: { version: V, endpoints: [{ host: '  ', pattern: '/api/x', effects: ['read'] }] } },
    { label: 'host 带通配', input: { version: V, endpoints: [{ host: '*.example.com', pattern: '/api/x', effects: ['read'] }] } },
    { label: 'host 带 userinfo', input: { version: V, endpoints: [{ host: 'api.example.com@evil.com', pattern: '/api/x', effects: ['read'] }] } },
    { label: 'host 带端口', input: { version: V, endpoints: [{ host: 'api.example.com:443', pattern: '/api/x', effects: ['read'] }] } },
    { label: 'host 非 ASCII', input: { version: V, endpoints: [{ host: 'еxample.com', pattern: '/api/x', effects: ['read'] }] } },
  ]
  const out = tries.map((t) => Object.freeze({ label: t.label, code: codeOf(() => normalizeApiGrant(t.input)) }))
  return Object.freeze({
    tries: Object.freeze(out),
    allRejected: out.every((o) => o.code !== 'NO-THROW'),
    // 空的 endpoints 数组是合法的（什么都不许调用）
    emptyOk: normalizeApiGrant({ version: V, endpoints: [] }).endpoints.length,
    // 归一化后的 host 是规范化过的
    hostNormalized: normalizeHost('API.Example.COM.'),
    // 每种 host 形态有自己的码——这样"哪一处坏了"不用从消息里猜
    hostShapes: Object.freeze([
      { label: '缺失', input: undefined, code: codeOf(() => normalizeHost(undefined)) },
      { label: '空', input: '  ', code: codeOf(() => normalizeHost('  ')) },
      { label: 'userinfo', input: 'api.example.com@evil.com', code: codeOf(() => normalizeHost('api.example.com@evil.com')) },
      { label: '路径分隔符', input: 'api.example.com/evil', code: codeOf(() => normalizeHost('api.example.com/evil')) },
      { label: '反斜杠', input: 'api.example.com\\evil', code: codeOf(() => normalizeHost('api.example.com\\evil')) },
      { label: '端口', input: 'api.example.com:443', code: codeOf(() => normalizeHost('api.example.com:443')) },
      { label: '非 ASCII', input: 'еxample.com', code: codeOf(() => normalizeHost('еxample.com')) },
      { label: '通配', input: '*.example.com', code: codeOf(() => normalizeHost('*.example.com')) },
      { label: '双点', input: 'api..example.com', code: codeOf(() => normalizeHost('api..example.com')) },
      { label: '前导点', input: '.example.com', code: codeOf(() => normalizeHost('.example.com')) },
    ]),
    // ★ 诚实：那四条"具体形态"的检查**不是**独立的第二道防线——把特殊字符从
    //   具体检查里拿掉之后，字符类 `^[a-z0-9.-]+$` 仍然会拒（只是换一个码）。
    //   留成证据，是为了不让人以为这里有两层保护。
    //
    //   > 一个「其实是诊断、但看起来像一道防线」的检查，
    //   > 与一个「被前一道更宽的规则挡住」的检查，在"它到底拦住了什么"上是同一个东西。
    redundancyWithCharClass: Object.freeze(
      ['api.example.com@evil.com', 'api.example.com/evil', 'api.example.com\\evil', 'api.example.com:443', 'еxample.com']
        .map((host) => Object.freeze({
          host,
          // 具体检查给出的码
          specificCode: codeOf(() => normalizeHost(host)),
          // 只靠字符类会给出的码（把这些字符从串里去掉，看字符类是否仍会拒）
          charClassWouldReject: !/^[a-z0-9.-]+$/.test(host.toLowerCase()),
        })),
    ),
  })
}

/** ⑪ 重试仍然是写；幂等键的配对进 canonicalKey。 */
export function assertRetryIsStillAWrite() {
  const first = checkExternalApi({
    request: { method: 'POST', path: '/api/items/7', host: H, body: {}, idempotencyKey: 'k-1' },
    grant: PROBE_GRANT,
  })
  const retry = checkExternalApi({
    request: { method: 'POST', path: '/api/items/7', host: H, body: {}, idempotencyKey: 'k-1' },
    grant: PROBE_GRANT,
    retryOf: first.canonicalKey,
  })
  const nonIdempotentWithKey = checkExternalApi({
    request: { method: 'POST', path: '/api/orders', host: H, body: {}, idempotencyKey: 'k-2' },
    grant: PROBE_GRANT,
  })
  const otherKey = checkExternalApi({
    request: { method: 'POST', path: '/api/items/7', host: H, body: {}, idempotencyKey: 'k-9' },
    grant: PROBE_GRANT,
  })
  return Object.freeze({
    first: Object.freeze({ effect: first.effect, retry: first.retry, canonicalKey: first.canonicalKey, idempotencyKey: first.idempotencyKey }),
    retry: Object.freeze({ effect: retry.effect, retry: retry.retry, canonicalKey: retry.canonicalKey }),
    nonIdempotentWithKey: Object.freeze({ allowed: nonIdempotentWithKey.allowed, code: nonIdempotentWithKey.code }),
    otherKeyCanonical: otherKey.canonicalKey,
    sameCanonical: first.canonicalKey === retry.canonicalKey,
    differentCanonical: first.canonicalKey !== otherKey.canonicalKey,
  })
}

/** ⑫ ★ URL 路径有**自己的**规则：平台无关、大小写敏感、百分号先解码。 */
export function assertUrlPathRulesAreItsOwn() {
  // (a) 平台无关：这正是"复用文件系统规范化器"会崩的地方
  //     （Windows 上会要求盘符；Linux 上会折叠大小写——两者对 URL 都是错的）
  const p = normalizeUrlPath('/API/Items/1')
  const spellings = ['/api/items/1', '/API/items/1', '/api/Items/1']
  const keys = spellings.map((s) => Object.freeze({ raw: s, key: normalizeUrlPath(s).key }))
  // (b) 百分号解码在**匹配之前**
  const decoded = [
    { raw: '/%61pi/items', decoded: normalizeUrlPath('/%61pi/items').key, note: '解出来就是被授权的那条' },
    { raw: '/api/items%2F1', note: '解码后多出一段' },
    { raw: '/api/%2e%2e/admin', note: '解码后是 ..' },
    { raw: '/api/%252e%252e/admin', note: '两次编码' },
  ]
  const decodedOut = decoded.map((d) => {
    let key = null
    let code = null
    try { key = normalizeUrlPath(d.raw).key } catch (e) { code = e.code }
    return Object.freeze({ raw: d.raw, key, code, note: d.note })
  })
  // (c) 规范化必须接受自己的输出。
  //
  //     `/api/50%25off` 解码成 `50%off`，而 key 又把 `%` 写回 `%25` ⇒ 稳定。
  //     若 key 直接用解码后的字面量（`/api/50%off`），第二次经过会因为 `%of`
  //     不是合法十六进制而抛——这正是"接受不了自己输出"的形态。
  const idempotentInputs = ['/api/items', '/api/50%25off', '/api/items/1', '/', '/a/b/c', '/a%20b/c']
  const idempotent = idempotentInputs.map((s) => {
    const once = normalizeUrlPath(s)
    const twice = normalizeUrlPath(once.key)
    return Object.freeze({ raw: s, decoded: once.segments, once: once.key, twice: twice.key, stable: once.key === twice.key })
  })
  // 反面证据：拿**解码后**的字面量当 key 会在第二次经过时抛
  const naive = idempotentInputs.map((s) => {
    const once = normalizeUrlPath(s)
    const naiveKey = '/' + once.segments.join('/')
    let secondPassCode = null
    try { normalizeUrlPath(naiveKey) } catch (err) { secondPassCode = err.code }
    return Object.freeze({ raw: s, naiveKey, secondPassCode })
  })
  // (d) 根路径
  const root = Object.freeze({ key: normalizeUrlPath('/').key, segments: normalizeUrlPath('/').segments })
  return Object.freeze({
    platformFree: Object.freeze({ key: p.key, segments: p.segments }),
    caseKeys: Object.freeze(keys),
    distinctCaseKeys: [...new Set(keys.map((k) => k.key))].length,
    percent: Object.freeze(decodedOut),
    idempotent: Object.freeze(idempotent),
    allIdempotent: idempotent.every((o) => o.stable),
    naiveKeyWouldThrow: Object.freeze(naive),
    naiveThrowCount: naive.filter((o) => o.secondPassCode !== null).length,
    root,
  })
}

/** ⑬ 歧义匹配要拒绝，而不是"取第一条"。 */
export function assertAmbiguousMatchRejected() {
  const g = normalizeApiGrant({
    version: EXTERNAL_API_SCOPE_VERSION,
    endpoints: [
      { host: 'h.example.com', pattern: '/api/items/{id}', effects: ['read'] },
      { host: 'h.example.com', pattern: '/api/{collection}/1', effects: ['read'] },
    ],
  })
  const ambiguous = checkExternalApi({ request: { method: 'GET', path: '/api/items/1', host: 'h.example.com' }, grant: g })
  const single = checkExternalApi({ request: { method: 'GET', path: '/api/items/2', host: 'h.example.com' }, grant: g })
  return Object.freeze({
    ambiguous: Object.freeze({ allowed: ambiguous.allowed, code: ambiguous.code }),
    single: Object.freeze({ allowed: single.allowed, code: single.code }),
  })
}

/**
 * ⑭ 错误码清单本身（供测试做"每个码都必须真的被发出过"的不变量）。
 *
 * 判据在测试里：它在模块源码中数 `API_CODES.<NAME>` 的出现次数，为 0 就说明
 * 没有任何地方抛这个码。
 *
 *   > 一个「声明了但从不发出」的错误码，
 *   > 与一个不存在的错误码，在"它到底告诉过值班的人什么"上是同一个东西。
 */
export function assertEveryCodeIsEmitted() {
  return Object.freeze({ codes: Object.freeze(Object.values(API_CODES)), count: Object.keys(API_CODES).length })
}

export const EXTERNAL_API_SCOPE_CHECKED = Object.freeze({
  version: EXTERNAL_API_SCOPE_VERSION,
  methodEffects: METHOD_EFFECTS,
  riskClasses: RISK_CLASSES,
  overrideKeys: METHOD_OVERRIDE_KEYS,
  actionKeys: ACTION_QUERY_KEYS,
  dryRunKeys: DRY_RUN_KEYS,
  codes: API_CODES,
  readNeverBecomesWrite: assertReadNeverBecomesWrite(),
  prefixMatching: assertPrefixMatchingWouldAllowWrite(),
  placeholder: assertPlaceholderIsSingleSegment(),
  overrides: assertEveryOverrideSpellingRejected(),
  dryRun: assertDryRunDoesNotDowngrade(),
  riskClass: assertRiskClassIsDeclaredNotInferred(),
  separatePermissions: assertReadAndWriteAreSeparatePermissions(),
  unknownMethod: assertUnknownMethodFailsClosed(),
  wildcard: assertWildcardPatternRejected(),
  grantShape: assertGrantRequiresExplicitEffectsAndIdempotency(),
  retry: assertRetryIsStillAWrite(),
  urlPath: assertUrlPathRulesAreItsOwn(),
  ambiguity: assertAmbiguousMatchRejected(),
  codeList: assertEveryCodeIsEmitted(),
})
