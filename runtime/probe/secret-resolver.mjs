// runtime/probe/secret-resolver.mjs
// ============================================================================
// 探测执行器的**生产凭证解析器**（PRT-505「尚无生产调用方」的补线）
//
// `security/secrets/` 是完整实现，但在此之前**没有任何生产代码调用它**
// ——一份没人用的密钥库等于没有密钥库。本模块是它唯一的调用方：
// 把 `secretRef` 换成一次性凭证，交给探测执行器。
//
// ---------------------------------------------------------------------------
// 三条纪律，都落在结构上
//
// ① **`SECRET_UNAVAILABLE` ≠ `AUTH_FAILED`。**
//    本模块抛出的任何异常都只意味着"本机取不到明文"。供应商拒绝一把
//    **已经成功解析**的钥匙，是 transport 拿到 401 之后的事，在本模块
//    之外。所以这里**只有** `SECRET_UNAVAILABLE` 这一种失败，
//    这比"记得别报错码"更难写错。
//
// ② **启动即拒绝明文后端。**
//    生产环境用 `memoryBackend` 或 `nullProtector` 就等于把密钥明文落盘，
//    而这不会报错、只会静默地不安全。所以构造时就断言保护方案，
//    而不是"能跑就先跑着"。
//
// ③ **不缓存明文。**
//    spec §6.7 要求"Runtime 在获得授权后**按需**解析密钥"。缓存会让明文
//    在进程里活过很多次运行，而每一次运行都是一个新的授权边界。
//    所以每次调用都真的去解一次。
//
// ④ **先问 Legion 自己的库，且只在"这条不存在"时才问回退来源。**
//    PRT-509 路线 A′：Legion 的 DPAPI 库是唯一权威写入路径，DSH 的
//    `$DSH_HOME/.credentials.yaml` 只是一个**只读**回退来源。两件事必须
//    同时成立，否则这个功能会制造出本批次要防的那种事故：
//
//      · **只有 `SECRET_NOT_FOUND` 才回退。** "解不开"（换了 Windows 账户）、
//        "库坏了"、"引用名非法"都**不回退**——那不是"没有"，那是"有但取不出来"，
//        而回退等于把保护等级从 DPAPI 静默降到明文。用户换了账户之后
//        应该看到"解不开"，而不是"从别处读到了一把旧钥匙"。
//      · **结果里带 `source`。** 两个来源都能回答又不说谁回答的，
//        就是"我轮换的那把钥匙没生效"的起点。
//
// 取到的值只作为返回值往外走一次，**不进任何诊断、错误或日志**。
// ============================================================================

import {
  SecretStoreError,
  isSecretStoreError,
  assertProtectedStore,
} from '../../security/secrets/index.mjs'

export const RESOLVER_RAISED = Object.freeze({
  STORE_MISSING: 'SECRET_STORE_MISSING',
  PROTECTION_REQUIRED: 'SECRET_STORE_UNPROTECTED',
  FALLBACK_INVALID: 'SECRET_FALLBACK_INVALID',
})

/**
 * 凭证来源的**名字**。它进 `resolveCredential()` 的结果与 `onResolve` 回调，
 * 因此诊断能回答"这个值是谁给的"。
 *
 * `STORE` 是本进程自己算出来的名字（Legion 的库只有这一个权威实现）；
 * 回退来源的名字由**来源自己声明**（`fallback.source`）——它才知道自己是什么。
 */
export const CREDENTIAL_SOURCES = Object.freeze({
  STORE: 'legion-store',
  UNNAMED_FALLBACK: 'fallback',
})

/**
 * 把任何底层异常收敛成 `SecretStoreError`。
 *
 * 关键是**不原样带出底层 message**：密钥库的异常里可能出现被解密的片段、
 * 文件路径、Windows 账户名，或者后端命令的 stderr 正文。只留 `code`/`name`
 * 这类结构信息——诊断价值由"哪一类失败"提供，不由原文提供。
 */
function toSecretStoreError(err, ref) {
  if (isSecretStoreError(err)) return err
  const cause = err === null || err === undefined
    ? 'unknown'
    : `${err.name ?? 'Error'}${err.code === undefined ? '' : `/${err.code}`}`
  return new SecretStoreError('SECRET_STORE_UNREADABLE', { ref, cause })
}

/**
 * 创建凭证解析器。
 *
 * @param {object} deps
 * @param {object} deps.store                    `security/secrets` 的 SecretStore
 * @param {object} [deps.fallback]               只读**回退来源**（PRT-509 路线 A′）；
 *                                               与 store 同形（必须有 `get(ref)`），
 *                                               可选 `describe(ref)` 与 `source` 名字。
 *                                               缺省 = 没有回退来源（默认行为不变）
 * @param {boolean} [deps.requireProtected=true] 是否要求受保护后端（生产必须 true）
 * @param {string[]} [deps.allowedSchemes]       允许的保护方案，默认只有 DPAPI
 * @param {Function} [deps.onResolve]            解析成功/失败的回调（**只给元数据**，不含值）
 * @returns {{
 *   resolveSecret: (secretRef: string, profile?: object) => Promise<string>,
 *   resolveCredential: (secretRef: string, profile?: object) => Promise<{ref: string, value: string, source: string}|null>,
 *   credentialVersionOf: (profile?: object) => Promise<string|null>,
 *   protection: () => {scheme: string, protected: boolean},
 * }}
 */
export function createSecretResolver({
  store,
  fallback = null,
  requireProtected = true,
  allowedSchemes,
  onResolve = null,
} = {}) {
  if (store === null || typeof store !== 'object' || typeof store.get !== 'function') {
    throw new TypeError(`createSecretResolver 需要 SecretStore（${RESOLVER_RAISED.STORE_MISSING}）：` +
      '没有它就取不到凭证，而"取不到"绝不能被当成"不需要"')
  }
  if (onResolve !== null && typeof onResolve !== 'function') {
    throw new TypeError('onResolve 必须是函数或省略')
  }
  // 回退来源只要求 `get`：一个"只能回答有没有值"的只读来源是合法的，
  // 而它的代价被显式处理——`credentialVersionOf` 会返回 null，
  // 于是探测缓存**永不命中**（宁可多探一次）。
  if (fallback !== null && (typeof fallback !== 'object' || typeof fallback.get !== 'function')) {
    throw new TypeError(`fallback 必须是带 get(ref) 的只读来源（${RESOLVER_RAISED.FALLBACK_INVALID}）：` +
      '它是一次真实的读取，必须与 store.get 同形；形状不对时静默忽略它，' +
      '会让"我配了回退来源"与"回退来源从来没被问过"在行为上完全一样')
  }
  const fallbackSourceName = fallback === null
    ? null
    : (typeof fallback.source === 'string' && fallback.source !== ''
        ? fallback.source
        : CREDENTIAL_SOURCES.UNNAMED_FALLBACK)
  if (requireProtected === true) {
    // 明文后端的失败**必须发生在构造时**，而不是第一次真要用密钥的时候
    // ——那时错误会落在一次运行中间，而用户不会把它读成"我的密钥库没加密"。
    assertProtectedStore(store, allowedSchemes === undefined ? {} : { allowedSchemes })
  }

  const protection = store.protection()

  /** 从 `secretRef` / `profile` 两处取引用名（与历史行为逐字相同）。 */
  function refOf(secretRef, profile) {
    return secretRef === undefined || secretRef === null
      ? (profile !== null && typeof profile === 'object' ? profile.secretRef : null)
      : secretRef
  }

  /**
   * 解析凭证，并**公开它来自哪个来源**。
   *
   * 这是 `resolveSecret` 的"带出处"形式：值与来源一起返回，
   * 于是"我轮换的那把钥匙没生效"这类问题不需要靠猜。形状是
   * `store.get()` 的产物（`{ref, value}`）加上 `source`，
   * 而不是一套平行的结果约定。
   *
   * `profile` 只用于判定"这条档案要不要凭证"：没有 `secretRef` 的档案
   * （本地模型）返回 `null`，而不是抛错——"不需要凭证"不是错误。
   */
  async function resolveCredential(secretRef, profile = null) {
    const ref = refOf(secretRef, profile)

    if (ref === undefined || ref === null || ref === '') {
      // 无凭证的档案（本地模型）合法。执行器会据此不发 Authorization 头。
      if (onResolve !== null) onResolve({ ok: true, ref: null, skipped: true, source: null })
      return null
    }

    let record = null
    try {
      record = await store.get(ref)
    } catch (err) {
      const e = toSecretStoreError(err, typeof ref === 'string' ? ref : null)
      // ★ 只有"**这条不在**"才回退。解不开、库坏了、引用名非法都不回退：
      //   那不是"没有"，那是"有但取不出来"，而回退等于把保护等级
      //   从 DPAPI 静默降到明文。
      if (fallback === null || e.code !== 'SECRET_NOT_FOUND') {
        if (onResolve !== null) {
          onResolve({ ok: false, ref: e.ref, errorCode: e.code, source: CREDENTIAL_SOURCES.STORE })
        }
        throw e
      }
    }

    if (record !== null) {
      if (onResolve !== null) {
        onResolve({ ok: true, ref: record.ref, skipped: false, source: CREDENTIAL_SOURCES.STORE })
      }
      return Object.freeze({ ref: record.ref, value: record.value, source: CREDENTIAL_SOURCES.STORE })
    }

    let fromFallback = null
    try {
      fromFallback = await fallback.get(ref)
    } catch (err) {
      const e = toSecretStoreError(err, typeof ref === 'string' ? ref : null)
      if (onResolve !== null) {
        onResolve({ ok: false, ref: e.ref, errorCode: e.code, source: fallbackSourceName })
      }
      throw e
    }

    if (fromFallback === null || fromFallback === undefined) {
      // 两个来源都没有 → 仍然是**那一条** `SECRET_NOT_FOUND`。
      // 回退来源自己的读法（"没有文件"/"不能寻址"）它自己用 `inspect()`/`explain()`
      // 回答，不在这里改变解析器的错误约定。
      const e = new SecretStoreError('SECRET_NOT_FOUND', { ref: typeof ref === 'string' ? ref : null })
      if (onResolve !== null) {
        onResolve({ ok: false, ref: e.ref, errorCode: e.code, source: fallbackSourceName })
      }
      throw e
    }

    if (onResolve !== null) {
      onResolve({ ok: true, ref, skipped: false, source: fallbackSourceName })
    }
    return Object.freeze({ ref, value: fromFallback.value, source: fallbackSourceName })
  }

  /**
   * 解析凭证，返回**明文本身**（历史契约，逐字不变）。
   *
   * **这是明文唯一一次离开密钥库的地方。** 需要知道"谁回答的"时用
   * {@link resolveCredential}；两者走同一条判定路径，不存在第二份优先级。
   */
  async function resolveSecret(secretRef, profile = null) {
    const credential = await resolveCredential(secretRef, profile)
    return credential === null ? null : credential.value
  }

  /**
   * 凭证**版本**：只读元数据，**不解密**。
   *
   * 进探测的缓存指纹，于是轮换之后判定自动重来。用 `rotatedAt` 优先于
   * `updatedAt`：只轮换过（值变了）也该让缓存失效，而 `updatedAt` 在有
   * 其它元数据变更（比如改 `purpose`）时也会变——那会让缓存多失效几次，
   * 是安全的方向。
   *
   * 回退来源**只有**在 Legion 的库里没有这条时才被问到——与 `resolveCredential`
   * 的优先级逐字相同。两边不一致的话，"轮换"会在回退来源上悄悄不生效，
   * 而那正是"我轮换的钥匙没生效"的另一种写法。
   */
  async function credentialVersionOf(profile = null) {
    const ref = refOf(null, profile)
    if (ref === undefined || ref === null || ref === '') return null
    const meta = await store.describe(ref)
    const fromStore = meta === null ? null : (meta.rotatedAt ?? meta.updatedAt ?? null)
    if (fromStore !== null || fallback === null) {
      // 引用不存在时**不抛**：让紧随其后的 `resolveSecret` 去报
      // `SECRET_UNAVAILABLE`，那条错误才带得上"该怎么修"的指引。
      // 这里只保证缓存不会命中（返回唯一值由执行器负责，见 index.mjs）。
      return fromStore
    }
    if (typeof fallback.describe !== 'function') return null
    const described = await fallback.describe(ref)
    if (described === null || described === undefined) return null
    return described.rotatedAt ?? described.updatedAt ?? null
  }

  return Object.freeze({
    resolveSecret,
    resolveCredential,
    credentialVersionOf,
    protection: () => protection,
  })
}

/**
 * 启动自检：把"这台机器上的密钥库到底能不能用"这个问题回答清楚。
 *
 * 返回 `{ok, code, message}` 而**不抛**——自检的结果是要显示给人看的，
 * 不是要中断启动的流程（是否阻止启动由调用方决定）。这与
 * "形状错误抛出、配置问题返回值"是同一条分界。
 */
export function inspectSecretStore(store, { requireProtected = true, allowedSchemes } = {}) {
  try {
    const protection = store?.protection?.()
    if (protection === undefined) {
      return { ok: false, code: RESOLVER_RAISED.STORE_MISSING, message: '没有可用的密钥库' }
    }
    if (requireProtected === true && protection.protected !== true) {
      return {
        ok: false,
        code: RESOLVER_RAISED.PROTECTION_REQUIRED,
        message: `密钥库后端未提供受保护存储（scheme=${protection.scheme}）：不得用于真实密钥`,
        protection,
      }
    }
    if (requireProtected === true && Array.isArray(allowedSchemes) &&
        !allowedSchemes.includes(protection.scheme)) {
      return {
        ok: false,
        code: RESOLVER_RAISED.PROTECTION_REQUIRED,
        message: `保护方案 ${protection.scheme} 不在允许列表内`,
        protection,
      }
    }
    return { ok: true, code: null, message: `密钥库可用（scheme=${protection.scheme}）`, protection }
  } catch (err) {
    const e = toSecretStoreError(err, null)
    return { ok: false, code: e.code, message: e.message }
  }
}
