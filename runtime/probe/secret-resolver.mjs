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
 * @param {boolean} [deps.requireProtected=true] 是否要求受保护后端（生产必须 true）
 * @param {string[]} [deps.allowedSchemes]       允许的保护方案，默认只有 DPAPI
 * @param {Function} [deps.onResolve]            解析成功/失败的回调（**只给元数据**，不含值）
 * @returns {{
 *   resolveSecret: (secretRef: string, profile?: object) => Promise<string>,
 *   credentialVersionOf: (profile?: object) => Promise<string|null>,
 *   protection: () => {scheme: string, protected: boolean},
 * }}
 */
export function createSecretResolver({
  store,
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
  if (requireProtected === true) {
    // 明文后端的失败**必须发生在构造时**，而不是第一次真要用密钥的时候
    // ——那时错误会落在一次运行中间，而用户不会把它读成"我的密钥库没加密"。
    assertProtectedStore(store, allowedSchemes === undefined ? {} : { allowedSchemes })
  }

  const protection = store.protection()

  /**
   * 解析凭证。**这是明文唯一一次离开密钥库的地方。**
   *
   * `profile` 只用于判定"这条档案要不要凭证"：没有 `secretRef` 的档案
   * （本地模型）返回 `null`，而不是抛错——"不需要凭证"不是错误。
   */
  async function resolveSecret(secretRef, profile = null) {
    const ref = secretRef === undefined || secretRef === null
      ? (profile !== null && typeof profile === 'object' ? profile.secretRef : null)
      : secretRef

    if (ref === undefined || ref === null || ref === '') {
      // 无凭证的档案（本地模型）合法。执行器会据此不发 Authorization 头。
      if (onResolve !== null) onResolve({ ok: true, ref: null, skipped: true })
      return null
    }

    let record
    try {
      record = await store.get(ref)
    } catch (err) {
      const e = toSecretStoreError(err, typeof ref === 'string' ? ref : null)
      if (onResolve !== null) onResolve({ ok: false, ref: e.ref, errorCode: e.code })
      // 抛出去 = 执行器判 `SECRET_UNAVAILABLE`（fail-closed，不是 AUTH_FAILED）
      throw e
    }

    if (onResolve !== null) onResolve({ ok: true, ref: record.ref, skipped: false })
    return record.value
  }

  /**
   * 凭证**版本**：只读元数据，**不解密**。
   *
   * 进探测的缓存指纹，于是轮换之后判定自动重来。用 `rotatedAt` 优先于
   * `updatedAt`：只轮换过（值变了）也该让缓存失效，而 `updatedAt` 在有
   * 其它元数据变更（比如改 `purpose`）时也会变——那会让缓存多失效几次，
   * 是安全的方向。
   */
  async function credentialVersionOf(profile = null) {
    const ref = profile !== null && typeof profile === 'object' ? profile.secretRef : null
    if (ref === undefined || ref === null || ref === '') return null
    const meta = await store.describe(ref)
    if (meta === null) {
      // 引用不存在。这里**不抛**：让紧随其后的 `resolveSecret` 去报
      // `SECRET_UNAVAILABLE`，那条错误才带得上"该怎么修"的指引。
      // 这里只保证缓存不会命中（返回唯一值由执行器负责，见 index.mjs）。
      return null
    }
    return meta.rotatedAt ?? meta.updatedAt ?? null
  }

  return Object.freeze({
    resolveSecret,
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
