// runtime/dsh-composition/external-api-scope-port.mjs
// ============================================================================
// **外部 API 授权表 → 读/写端口**（PRT-606 的最后一根线）。
//
// ## 它填的是哪个洞
//
// `external-api-scope.mjs` 的 `checkExternalApi` 早就写好了（24 例全绿），
// 而它**连端口都没有**——`production-scope-wiring.test.mjs` ② 从第 19 轮起
// 就把它当作"下一个"钉着：
//
//   > 一条判据在它守的东西被修好之后**不该消失**，它该指向下一件同类的事。
//
// 本轮是它指的"下一件"。三道范围检查至此**全部**有了位置。
//
// ## ★★★ 本端口最容易做错的一件事：把 URL **交给解析器**再取 host/path
//
// `checkExternalApi` 要的是 `{host, method, path, headers, query, body}` 六项分开的
// **请求形状**，而事实表里只有一个 `url` 字符串。所以适配器的职责是
// **把 URL 拆成 host + path + query**——而怎么拆，决定了三道既有的检查
// 是「会触发」还是「从不触发」。本批实测了两个真实的洞：
//
// | 写法 | 输入 | `new URL()` 给出来的 | 后果 |
// | --- | --- | --- | --- |
// | `u.hostname` | `https://api.example.com:8443/v1` | `api.example.com` | **端口被丢掉** ⇒ `normalizeHost` 的 `HOST_HAS_PORT` **从不触发** |
// | `u.pathname` | `https://api.example.com/api/items/../admin` | `/api/admin` | **`..` 被折叠** ⇒ `normalizeUrlPath` 的 `PATH_ESCAPE` **从不触发**，而折叠后的路径可能命中一条它本来不匹配的授权 |
//
//   > 一个「在解析之后才检查 `..`」的检查，
//   > 与一个「解析器已经悄悄把它们折叠掉了、所以这条检查从不触发」的检查，
//   > 是同一个东西——而它的方向是放行。
//
//   > 一个「把 URL 解析成 host、顺手扔掉端口」的适配器，
//   > 与一个「`api.example.com:8443` 被当成 `api.example.com` 而拿到该端点的读授权」
//   > 的适配器，是同一个东西。
//
// ⇒ 本端口**从原始字符串上取**那三段：
//   · `host` 用 `parseEgressUrl` 的 `rawAuthority`（它本来就是从原始串上正则取的，
//     带着 userinfo 与端口）⇒ `normalizeHost` 能给出**具名的** `HOST_HAS_USERINFO` /
//     `HOST_HAS_PORT` / `HOST_NON_ASCII`，而不是一个被静默改写过的 host。
//   · `path` / `query` 用一条**只切不改**的正则从原始串上切。**不**经过 `new URL()`。
//
// ★ `parseEgressUrl` 那一步不是多余的：它把"这压根不是一个 URL"变成
//   **具名的** `exec-scope-bad-url`（而不是让 `normalizeHost` 报一个让人找错方向的
//   `HOST_NOT_A_STRING`）。★ 而且它复用的是 PRT-605 那一份解析器——
//   `external-api-scope.mjs` 文件头自己写着"host 的比较规则来自 PRT-605"。
//
// ## ★ 本端口**不推导事实**——它只读 `projection.scopeFacts`
//
// 与 `execution-scope-port.mjs` 同一条纪律：事实在投影里算一次
// （`scope-facts.mjs`），本模块只读。理由是那六份兜底链。
//
// ## ★★ 一个**没有**在本端口里发明的规则：scheme
//
// `checkExternalApi` 不看 scheme（那是 `checkNetwork` 的 `SCHEME_DENIED`）。
// 本端口**没有**顺手加一条"必须是 http(s)"——那是发明策略，而 PRT-253 §3
// 明令禁止发明默认值。⇒ 它是一个**如实记下的读数**，见文件末的诚实边界。
//
// @module runtime/dsh-composition/external-api-scope-port
// ============================================================================

import { API_CODES, checkExternalApi, normalizeApiGrant } from './external-api-scope.mjs'
import { parseEgressUrl } from './execution-scope.mjs'

export const EXTERNAL_API_SCOPE_PORT_VERSION = 'legion/external-api-scope-port@1'

/**
 * 部署配置把外部 API 授权表交给 Runtime 子进程用的环境键。
 *
 * ★ 与 `LEGION_PATH_SCOPE` / `LEGION_EXECUTION_SCOPE` **同渠道、同名法**：
 *   授权表要经 `normalizeApiGrant` 归一化，而 `PatchOptions.config` 是**数据**，
 *   装不下归一化后的冻结结构。
 */
export const EXTERNAL_API_SCOPE_PORT_ENV_KEY = 'LEGION_EXTERNAL_API_SCOPE'

/** 本模块从环境读取的键（给 `scripts/config/config.test.mjs` 反查 schema 用）。 */
export const EXTERNAL_API_SCOPE_PORT_ENV_KEYS = Object.freeze([EXTERNAL_API_SCOPE_PORT_ENV_KEY])

export const EXTERNAL_API_SCOPE_PORT_CODES = Object.freeze({
  BAD_INPUT: 'external-api-scope-port-bad-input',
  /** 环境里那份文本不是合法 JSON。 */
  BAD_TABLE_TEXT: 'external-api-scope-port-bad-table-text',
  /** 能力说这一类、而事实里没有——证明不了它要访问哪。 */
  NO_FACTS: 'external-api-scope-port-no-facts',
  /** 事实里有 `external-api` 这一项，而它没有 `url`。 */
  NO_URL: 'external-api-scope-port-no-url',
  /**
   * ★★★ URL 拆不成"外部 API 请求"的形状（原始串上没有可用的 authority/path）。
   *
   * 与 `NO_URL` 分开：`NO_URL` 是"没给地址"，本条是"给了，而它不是一个能判的请求"
   * ——*一个「把"没给"与"给了个看不懂的"报成同一个码」的诊断，
   * 与一个「值班的人去补配置、而其实该做的是改调用方」的诊断，是同一个东西。*
   */
  BAD_URL: 'external-api-scope-port-bad-url',
})

/** 与 `scope-port.mjs` / `execution-scope-port.mjs` 同一套状态词。 */
export const EXTERNAL_API_SCOPE_PORT_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ABSENT: 'absent',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const deny = (code, reason, extra = {}) => Object.freeze({
  allowed: false, code, reason, ...extra,
})

const allow = () => Object.freeze({ allowed: true, code: null, reason: null, kind: null })

/**
 * 从**原始** URL 串上切出 path 与 query。**只切不改**。
 *
 * ★★ 为什么不用 `new URL()`：见文件头那张表。解析器会折叠 `..`、会把端口
 *   从 hostname 上摘掉——本函数存在的全部理由就是**不**让它做这两件事。
 *
 * ★ 正则不取 authority（那一项由 `parseEgressUrl` 的 `rawAuthority` 提供），
 *   所以这里没有"第二份 authority 提取"。
 *
 * @returns {{path: string, query: string}} `path` 至少是 `/`（URL 里省略路径时）
 */
export function splitRawPathAndQuery(url) {
  if (typeof url !== 'string') {
    throw fail(EXTERNAL_API_SCOPE_PORT_CODES.BAD_URL, `URL 必须是非空字符串，收到 ${JSON.stringify(url)}`)
  }
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url)
  if (m === null) {
    throw fail(EXTERNAL_API_SCOPE_PORT_CODES.BAD_URL,
      `URL ${JSON.stringify(url)} 里找不到「scheme://authority」这一段，拆不出请求形状`)
  }
  // ★ URL 里省略路径（`https://api.example.com`）⇒ 切出来是空串，而
  //   `normalizeUrlPath('')` 报 `api-scope-bad-path`（"必须以 / 开头"）。
  //   那会把"根路径"报成"路径非法"：*一个「把省略的路径读成非法路径」的适配器，
  //   与一个「其实是合法的根请求被拒」的适配器，是同一个东西——只不过它的方向是**过严**。*
  return Object.freeze({ path: m[1] === '' ? '/' : m[1], query: m[2] ?? '' })
}

/**
 * 把 query 串读成一个对象。
 *
 * ★★ 用 `URLSearchParams`（会百分号解码），**不**按 `&`/`=` 手切：
 *   `?%6dethod=DELETE` 手切出来的键是 `%6dethod`，而 `METHOD_OVERRIDE_KEYS`
 *   里没有它 ⇒ 那条"能覆盖方法的东西一律拒绝"的检查**从不触发**。
 *
 *   > 一个「按 `&` 手切 query 的适配器」，
 *   > 与一个「`?%6dethod=DELETE` 从 `collectOverrides` 眼皮底下走过去」的适配器，
 *   > 是同一个东西——而它的方向是放行。
 */
function queryObject(rawQuery) {
  if (typeof rawQuery !== 'string' || rawQuery === '') return Object.freeze({})
  const out = {}
  for (const [k, v] of new URLSearchParams(rawQuery)) out[k] = v
  return Object.freeze(out)
}

/**
 * 授权表 → 端口。
 *
 * @param {object} p
 * @param {object} p.grant 已归一化的外部 API 授权表（`normalizeApiGrant()` 的产物）
 * @returns {(projection: object) => {allowed: boolean, code: string|null, reason: string|null}}
 * @throws {Error} 授权表不合法时（`api-scope-*`，**原样上抛**）——装配期就拒
 */
export function createExternalApiScopePort({ grant } = {}) {
  if (!isPlainObject(grant)) {
    throw fail(EXTERNAL_API_SCOPE_PORT_CODES.BAD_INPUT,
      'createExternalApiScopePort 需要一份外部 API 授权表对象')
  }
  // ★ 装配期归一化：表不合法**现在**就抛，而不是等第一次工具调用。
  //   一个"第一次调用时才炸"的授权表，把错误推迟到**已经有副作用的那一刻**。
  const normalized = normalizeApiGrant(grant)

  return function externalApiScopePort(projection) {
    if (!isPlainObject(projection)) {
      return deny(EXTERNAL_API_SCOPE_PORT_CODES.BAD_INPUT, '外部 API 范围检查收到一个不是对象的投影')
    }
    const facts = projection.scopeFacts
    // 这次调用不是外部 API 调用（`file:*` / `command:*` / `repo:*` …）⇒ 本端口无话可说。
    // ★ 与 `execution-scope-port` 同一条：放行的判据是"事实表说这次调用不属于这一类"，
    //   不是"我没看懂"。
    if (facts === null || facts === undefined) return allow()
    if (!isPlainObject(facts)) {
      return deny(EXTERNAL_API_SCOPE_PORT_CODES.BAD_INPUT, '投影上的 scopeFacts 不是对象（接线坏了）')
    }

    const kinds = Array.isArray(facts.kinds) ? facts.kinds : []
    // ---- 不是外部 API：交给别的那几道 -------------------------------------
    //   ★ `network` 那一条是 `executionScopePort` 管的（`checkNetwork`）；
    //     `command` / `mcp` 同理。本端口对它们的读数是"无话可说"，
    //     与对 `file:*` 的读数是同一句话。
    if (!kinds.includes('external-api')) return allow()

    const api = facts.externalApi
    if (api === undefined || api === null) {
      return deny(EXTERNAL_API_SCOPE_PORT_CODES.NO_FACTS,
        '这次调用的能力里有外部 API，而事实里没有 externalApi 这一项——证明不了它要访问哪')
    }
    if (typeof api.url !== 'string' || api.url.trim() === '') {
      return deny(EXTERNAL_API_SCOPE_PORT_CODES.NO_URL,
        '这次调用的能力里有外部 API，而事实里没有 URL——证明不了它要访问哪个服务')
    }

    // ---- ① 解析（复用 PRT-605 的解析器，拿具名的 BAD_URL）-------------------
    let parsed
    try {
      parsed = parseEgressUrl({ url: api.url })
    } catch (err) {
      return deny(err?.code ?? EXTERNAL_API_SCOPE_PORT_CODES.BAD_URL,
        `外部 API 的 URL 解析不了：${err?.message ?? String(err)}`)
    }

    // ---- ② 从**原始串**上切 path / query -----------------------------------
    let raw
    try {
      raw = splitRawPathAndQuery(api.url)
    } catch (err) {
      return deny(err?.code ?? EXTERNAL_API_SCOPE_PORT_CODES.BAD_URL,
        `外部 API 的 URL 拆不出请求形状：${err?.message ?? String(err)}`)
    }

    // ---- ③ 交给判定器 ------------------------------------------------------
    //   ★ `host` 传的是 `rawAuthority`（**不是** `parsed.host`）：前者带着
    //     userinfo 与端口，于是 `normalizeHost` 能给出具名的拒绝码；
    //     后者是解析器洗过的值，端口与 userinfo 都已经不在了。
    //   ★ `method` 缺省给 `GET`（与 `checkExternalApi` → `effectOfMethod` 的那条路
    //     同一个字面量）：一个"适配器给 POST、判定器认为 GET"的分歧，
    //     会让一条写请求按读判定走。
    const request = {
      host: parsed.rawAuthority,
      method: typeof api.method === 'string' && api.method.trim() !== '' ? api.method : 'GET',
      path: raw.path,
      headers: isPlainObject(api.headers) ? api.headers : {},
      query: queryObject(raw.query),
      body: api.body ?? null,
      idempotencyKey: null,
    }

    let verdict
    try {
      verdict = checkExternalApi({ request, grant: normalized })
    } catch (err) {
      return deny(err?.code ?? API_CODES.BAD_REQUEST,
        `外部 API 范围检查本身出错：${err?.message ?? String(err)}`)
    }
    if (verdict.allowed !== true) {
      return deny(verdict.code ?? API_CODES.ENDPOINT_NOT_GRANTED,
        verdict.reason ?? '没有给出理由',
        { kind: 'external-api', effect: verdict.effect ?? null })
    }
    return allow()
  }
}

/**
 * 从 Runtime 子进程的环境里取那份外部 API 授权表。
 *
 * ★ 缺席**如实**记成 `absent`：没配不等于"没有限制"——端口为 `null` 时
 *   组合根报 `externalApiScope: false`（**没接就是没接**，不是"接了个空的"）。
 * ★ 配了却解释不通 ⇒ **抛**：那是配置错误，不是"没配"。
 *
 * @param {object} p
 * @param {object} p.env
 * @returns {{state: string, port: Function|null, grant: object|null, reason: string|null}}
 */
export function externalApiScopePortFromEnv({ env } = {}) {
  if (!isPlainObject(env)) {
    throw fail(EXTERNAL_API_SCOPE_PORT_CODES.BAD_INPUT, 'externalApiScopePortFromEnv 需要一个环境对象')
  }
  const raw = env[EXTERNAL_API_SCOPE_PORT_ENV_KEY]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return Object.freeze({
      state: EXTERNAL_API_SCOPE_PORT_STATES.ABSENT,
      port: null,
      grant: null,
      reason: `环境里没有「${EXTERNAL_API_SCOPE_PORT_ENV_KEY}」。这**不是**"没有外部 API 限制"——`
        + '外部 API 在端口为 null 时是放行，所以这个缺席要由组合根显式处置',
    })
  }

  let declaration = raw
  if (typeof raw === 'string') {
    try {
      declaration = JSON.parse(raw)
    } catch (err) {
      throw fail(
        EXTERNAL_API_SCOPE_PORT_CODES.BAD_TABLE_TEXT,
        `「${EXTERNAL_API_SCOPE_PORT_ENV_KEY}」不是合法 JSON（${err?.message ?? err}）。`
        + '不忽略这一段：一个被静默丢掉的授权表，与一张"什么都没限制"的授权表，读数一样',
      )
    }
  }

  // ★★★ 这里对**原始**声明归一化两次（一次给端口、一次给返回值），
  //   而**不是**把端口的产物再喂回去。理由是本表的归一化器**不幂等**。
  //
  //   `normalizeApiGrant` 会在每个端点上挂一个**派生字段** `parsed`
  //   （`checkExternalApi` 用它避免每次调用都重新解析模式），而 `parsed`
  //   **不在** `ENDPOINT_FIELDS` 里 ⇒ 把"已归一化的表"再喂一次会以
  //   `api-scope-malformed`（"出现了不认识的字段 [`parsed`]"）抛。
  //
  //   > 三个端口**长着同一副样子**——`fromEnv` 归一化一次、`create*Port`
  //   > 再归一化一次——而其中两个的归一化器是**幂等**的、第三个不是。
  //   > ⇒ 同一段接线在两处是绿的、在第三处是装配期就抛，
  //   > 而"这个归一化器幂等吗"这件事，在三个端口的代码里**一个字都没写**。
  //
  //   ★ 本批**实测**过：`normalizeGrant`（PRT-605）幂等 ✓，
  //     `normalizeApiGrant`（PRT-606）不幂等 ✗。
  //
  //   ⇒ 两条路都可选：(a) 只归一化一次，让端口接受已归一化的表；
  //     (b) 对**原始**输入归一化两次。选 (b) 的理由是它**不削弱**
  //     `createExternalApiScopePort` 对**直接调用方**的保护——那条"不认识
  //     字段就拒"的检查是防打错字的那一道，留着它比省一次归一化重要。
  //     两次归一化跑的是同一个纯函数、同一份原始输入，结果确定。
  const normalized = normalizeApiGrant(declaration)
  return Object.freeze({
    state: EXTERNAL_API_SCOPE_PORT_STATES.CONFIGURED,
    // ★ 传的是**原始** `declaration`（端口自己归一化一份），不是上面那个 `normalized`。
    port: createExternalApiScopePort({ grant: declaration }),
    grant: normalized,
    reason: null,
  })
}
