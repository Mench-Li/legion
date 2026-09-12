// team-hub/secret-admin.mjs
// ============================================================================
// 凭证管理的**写入口**（spec §6.7「Secret Store」的增删改一半）
//
// ## 这个文件为什么存在
//
// `security/secrets/`（PRT-505）是完整实现、有套件覆盖，`product/secrets.mjs`
// 把"布局 → 密钥库 → 解析器"接了起来（PRT-254）。但接起来的只有**读**：
//
//   · 读：`runtime/probe/secret-resolver.mjs` → `store.get(ref)`  ✅ 有生产调用方
//   · 写：`store.put` / `rotate` / `remove`                    ❌ **零调用方**
//
// `git grep` 的结论是：整个仓库里没有任何生产代码调用过这三个方法，
// 也没有任何 HTTP 路由。于是 `secretRef` 只能指向**别人放进去的东西**，
// 而 spec §6.7 要求的"新增/更新/轮换/删除写审计记录（不含密文）"
// ——那四个动作**今天一个都发不出来**。
//
//   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
//
// ---------------------------------------------------------------------------
// ## 写路径引入的两个**新**问题（读路径上不存在，所以此前没人遇到）
//
// ### ① 写入会**重置文件权限**
//
// `fileBackend.writeAll` 走的是 `写临时文件 + rename`：
//
//     mkdirSync(dirname) → writeFileSync(tmp, {mode:0o600}) → renameSync(tmp, file)
//
// POSIX 上 `mode:0o600` 有效，所以看起来没问题。**Windows 上 `mode` 基本被忽略**，
// 新文件的 ACE 继承自**目录**——也就是说：
//
//   · `openProductSecrets` 在打开时把权限收紧成"仅所有者可读"（`hardenFileAcl`）；
//   · 然后**每一次写入**都用一个新文件替换掉它，**那次加固就没了**。
//
// 所以本模块在**每一次**写入之后都重新核验一次 ACL，而不是只在打开时核验一次。
// 规则很简单：**任何一次写入都可能把文件的保护重置**，那就每次都查。
//
// ### ② 全新安装上，第一次写入**必然**发生在"文件还不存在"之后
//
// `openProductSecrets` 刻意**不**对不存在的文件加固（`ACL_NOT_CREATED`：
// 对着不存在的路径跑 `icacls /grant` 只会失败并留下一条假告警）。
// 这个取舍在只读的时候是对的——可是写路径恰好就是**创建**这个文件的那一步：
//
//     启动 → 打开密钥库（文件不存在 → 不加固）→ 用户录入第一把钥匙 → 文件诞生
//                                                                    ↑ 从没被加固过
//
// 于是 §① 的"每次写完都重新核验"同时也修掉了这一条：写完文件就存在了，
// 重新核验会真的去加固它。
//
// ---------------------------------------------------------------------------
// ## 三条纪律
//
// ### A. 打不开密钥库时**不降级**
//
// `requireProtected: true` 是写死的，没有开关。读路径上"明文后端"还只是
// 让人看到不该看的东西；写路径上它会**把用户的真实密钥明文落盘**。
// 明文后端不会报错、只会静默地不安全，所以这里 fail closed：
// 打不开就是打不开，不退化成"先存着"。
//
// ### B. 响应里**永远没有值**，错误里也没有
//
// 返回的是 `freezeMeta` 的产物（ref/purpose/scheme/时间戳），不含 blob、不含明文。
// 错误对象由 `SecretStoreError` 构造，它的上下文本身就是白名单（ref/platform/cause），
// 所以"顺手把密钥塞进错误里"这条路在类型层面就不成立。
//
// ### C. 写成功之后**必须**让探测缓存失效
//
// `team-hub/probe-service.mjs:39` 写着：
//
//   > 提供一个 `invalidate()` 由轮换/修改凭证的路径调用
//
// 而它**从来没有被调用过**——因为写路径不存在，两条线一直在互相等。
// 缓存键里含凭证版本，但"密钥库这个**文件**被换了"只有写路径知道。
// 不失效的后果是具体的：轮换完密钥、界面点"测试连接"，
// 拿到的还是**用旧钥匙得出的旧结论**——而它看起来完全像一次新的验证。
// ============================================================================

/** 管理面的错误码。除 `STORE_UNAVAILABLE` 外都与密钥库内部码同名，前端已认得。 */
export const SECRET_ADMIN_CODES = Object.freeze({
  /** 密钥库打不开：布局不合法 / 平台不支持 / 明文后端被拒 / 文件坏。**不是**"密钥不存在"。 */
  STORE_UNAVAILABLE: 'SECRET_ADMIN_STORE_UNAVAILABLE',
  /** 引用名非法。 */
  REF_INVALID: 'SECRET_REF_INVALID',
  /** 值为空。 */
  VALUE_EMPTY: 'SECRET_VALUE_EMPTY',
  /** 引用不存在（轮换/删除一个没录入过的引用）。 */
  NOT_FOUND: 'SECRET_NOT_FOUND',
  /** 写入失败（磁盘/权限）。 */
  WRITE_FAILED: 'SECRET_STORE_WRITE_FAILED',
})

/** 内部码 → HTTP 状态码。**配置错误（400）先于状态检查（404）**，与既有路由同一口径。 */
const STATUS_FOR = Object.freeze({
  SECRET_REF_INVALID: 400,
  SECRET_VALUE_EMPTY: 400,
  SECRET_NOT_FOUND: 404,
  SECRET_STORE_WRITE_FAILED: 503,
  SECRET_STORE_CORRUPT: 503,
  SECRET_STORE_UNREADABLE: 503,
  SECRET_DECRYPT_FAILED: 503,
  SECRET_STORE_UNSUPPORTED_PLATFORM: 503,
  SECRET_STORE_UNPROTECTED: 503,
})

/** 一个带 HTTP 语义的错误。`handleRun` 认 `statusCode` 与 `code`。 */
function adminError(code, message, { statusCode, ref = null, cause = null } = {}) {
  const err = new Error(message)
  err.code = code
  err.statusCode = statusCode ?? (STATUS_FOR[code] ?? 400)
  err.ref = ref
  if (cause !== null) err.causeCode = cause
  return err
}

/**
 * 创建凭证管理面。
 *
 * @param {object} deps
 * @param {object}   [deps.env]                  环境（`resolveLayout` 需要），默认 `process.env`
 * @param {string}   [deps.owner]                ACL 加固的目标主体（Windows 上是 `DOMAIN\user`）。**不猜**
 * @param {string}   [deps.platform]
 * @param {Function} [deps.openSecrets]          `openProductSecrets` 的注入点
 * @param {Function} [deps.resolveLayoutImpl]    `resolveLayout` 的注入点
 * @param {Function} [deps.onAudit]              密钥库审计回调（载荷已是白名单字段）
 * @param {Function} [deps.run]                  ACL 检查用的 runner
 * @param {Function} [deps.exists]               "文件是否存在"的注入点
 * @param {Function} [deps.onCredentialsChanged] 凭证变更后的回调——**探测缓存失效接在这里**
 */
export function createSecretAdmin({
  env = process.env,
  owner = null,
  platform = process.platform,
  openSecrets = null,
  resolveLayoutImpl = null,
  onAudit = null,
  run = null,
  exists = undefined,
  onCredentialsChanged = null,
} = {}) {
  /** 打开成功的那一份。**只在密钥库层面缓存**，写入之后立刻丢弃（见 §①）。 */
  let opened = null

  async function resolveLayoutNow() {
    if (typeof resolveLayoutImpl === 'function') return await resolveLayoutImpl({ env })
    const mod = await import('../product/paths.mjs')
    return mod.resolveLayout({ env })
  }

  async function openSecretsImpl(args) {
    if (typeof openSecrets === 'function') return await openSecrets(args)
    const mod = await import('../product/secrets.mjs')
    // `requireProtected: true` **写死**：写路径上明文后端会把真实密钥落盘。
    return mod.openProductSecrets({ ...args, requireProtected: true })
  }

  function openArgs() {
    const args = { owner, platform, hardenAcl: true }
    if (typeof run === 'function') args.run = run
    if (exists !== undefined) args.exists = exists
    if (typeof onAudit === 'function') args.onAudit = onAudit
    return args
  }

  /**
   * 确保密钥库可用。失败一律**抛**（读路径是"返回结果供显示"，写路径不是：
   * 一次写不进去的写入没有"部分成功"可言）。
   */
  async function ensure() {
    if (opened !== null) return opened

    const res = await resolveLayoutNow()
    const layout = res?.layout ?? null
    const diagnostics = res?.diagnostics ?? []
    if (Array.isArray(diagnostics) && diagnostics.some((d) => d?.severity === 'error')) {
      throw adminError(SECRET_ADMIN_CODES.STORE_UNAVAILABLE,
        '无法管理凭证：产品目录布局未确定，因此不知道密钥库在哪里。' +
        `（${diagnostics.filter((d) => d?.severity === 'error').map((d) => d?.code).filter(Boolean).join(', ')}）`,
        { statusCode: 503 })
    }

    const check = await openSecretsImpl({ layout, ...openArgs() })
    if (check?.ok !== true) {
      // 打不开就是打不开。**不退化成明文**，也不假装成"密钥不存在"。
      throw adminError(SECRET_ADMIN_CODES.STORE_UNAVAILABLE, check?.message ?? '密钥库不可用', {
        statusCode: 503, cause: check?.code ?? null,
      })
    }
    opened = {
      store: check.store,
      path: check.path,
      acl: check.acl,
      aclVerified: check.aclVerified === true,
      aclExists: check.aclExists === true,
      protection: check.protection,
    }
    return opened
  }

  /**
   * 把密钥库异常翻成管理面错误。
   *
   * **只带白名单字段**：`SecretStoreError` 的上下文本身就只允许
   * `ref` / `platform` / `cause`，所以"顺手把密钥塞进错误里"这条路
   * 在类型层面就不成立。这里也**不展开** `e`，避免把 stack 带出去。
   *
   * 认得的内部码**原样透传**（前端已经认得 `SECRET_NOT_FOUND` 这类码，
   * 转成别的码等于把一条已经能显示得很具体的错误降级成笼统提示）；
   * 不认得的收敛到 `WRITE_FAILED` 并给 503——宁可是"服务不可用"，
   * 也不要给出一个猜出来的 400。
   */
  function mapStoreError(e, ref) {
    const code = e?.code
    if (typeof code === 'string' && STATUS_FOR[code] !== undefined) {
      return adminError(code, e.message, { statusCode: STATUS_FOR[code], ref, cause: code })
    }
    if (e?.name === 'SecretStoreError') {
      // 密钥库认得、但本表没登记的内部码：不猜状态码，按"服务不可用"上报，
      // 并把内部码原样带出来供排查。
      return adminError(SECRET_ADMIN_CODES.WRITE_FAILED, e.message, { statusCode: 503, ref, cause: code ?? null })
    }
    // 不原样带出 message：密钥库异常里可能出现路径、账户名或密文片段。
    return adminError(SECRET_ADMIN_CODES.WRITE_FAILED,
      `写入密钥库失败：${e?.name ?? 'Error'}（详见日志中的内部码）`, { statusCode: 503, ref })
  }

  /**
   * 重新核验 ACL。**失败不上抛**：凭证已经写进去了，此时报"失败"会让用户
   * 以为要重做一遍。但"没核验过"这件事必须出现在响应里——
   * 一条默认静默的检查等于没有检查。
   */
  async function reverifyAcl() {
    opened = null
    try {
      const fresh = await ensure()
      return { acl: fresh.acl, aclVerified: fresh.aclVerified, aclExists: fresh.aclExists, aclNote: null }
    } catch (e) {
      return {
        acl: null, aclVerified: false, aclExists: true,
        aclNote: `凭证已写入，但之后无法重新核验文件权限：${e?.message ?? String(e)}`,
      }
    }
  }

  async function afterWrite(ref) {
    const acl = await reverifyAcl()
    // §纪律 C：写成功之后必须让探测缓存失效。**放在 ACL 复核之后**：
    // 复核自己会重新打开密钥库，先失效再复核等于白失效一次。
    if (typeof onCredentialsChanged === 'function') {
      try {
        await onCredentialsChanged({ ref })
      } catch {
        // 失效失败**不能**把一次成功的写入报成失败。它与写入是两个后果。
      }
    }
    return acl
  }

  return Object.freeze({
    /**
     * 只读状态。**不含任何引用名**——这个结果会被拿去显示与记录，
     * 而引用名能画出"这台机器配了哪些供应商"（`product/secrets.mjs` ④）。
     */
    async describe() {
      const check = await openSecretsImpl({ layout: (await resolveLayoutNow())?.layout ?? null, ...openArgs() })
      return Object.freeze({
        ok: check?.ok === true,
        code: check?.code ?? SECRET_ADMIN_CODES.STORE_UNAVAILABLE,
        message: check?.message ?? '密钥库不可用',
        path: check?.path ?? null,
        protection: check?.protection ?? null,
        acl: check?.acl ?? null,
        aclVerified: check?.aclVerified === true,
        aclExists: check?.aclExists === true,
        count: check?.count ?? null,
      })
    },

    /**
     * 列出已录入的引用。
     *
     * **这是唯一一个会返回引用名的出口**，因为管理界面必须能列出"有哪些"。
     * 它与启动自检刻意不同：自检结果会进日志与诊断包，所以那里只给计数
     * （`product/secrets.mjs` ④）；本接口是显式认证过的管理读，且返回值
     * 只有元数据、**永远没有值**。
     */
    async list() {
      const o = await ensure()
      let rows
      try {
        rows = await o.store.list()
      } catch (e) {
        throw mapStoreError(e, null)
      }
      return Object.freeze({
        // `store.list()` 给的是**扁平**行（`{ref, purpose, scheme, createdAt, ...}`），
        // 不是 `{ref, meta}`。按 `r.meta?.purpose` 取会一路取到 `null`，
        // 而 `null` 与"这条没有 purpose"长得一模一样——所以对照的是密钥库
        // 自己的形状，不是我以为的形状。
        entries: Object.freeze((Array.isArray(rows) ? rows : []).map((r) => Object.freeze({
          ref: r?.ref ?? null,
          purpose: r?.purpose ?? null,
          scheme: r?.scheme ?? null,
          createdAt: r?.createdAt ?? null,
          updatedAt: r?.updatedAt ?? null,
          rotatedAt: r?.rotatedAt ?? null,
        }))),
        path: o.path,
        aclVerified: o.aclVerified,
      })
    },

    /** 新增或更新一把钥匙。引用已存在时视为更新（`put` 的既有语义）。 */
    async put({ ref, value, purpose } = {}) {
      const o = await ensure()
      let meta
      try {
        meta = await o.store.put(ref, value, purpose === undefined ? {} : { purpose })
      } catch (e) {
        throw mapStoreError(e, ref)
      }
      const acl = await afterWrite(ref)
      return Object.freeze({ meta, ...acl })
    },

    /** 轮换：引用名不变、值替换。**只影响轮换之后创建的 Run**（spec §6.7）。 */
    async rotate({ ref, value, purpose } = {}) {
      const o = await ensure()
      let meta
      try {
        meta = await o.store.rotate(ref, value, purpose === undefined ? {} : { purpose })
      } catch (e) {
        throw mapStoreError(e, ref)
      }
      const acl = await afterWrite(ref)
      return Object.freeze({ meta, ...acl })
    },

    /**
     * 删除。引用不存在时返回 `removed: false`（**幂等**）而不是抛 404：
     * 删除的意图是"让这个引用不存在"，而它已经不存在了。
     * 轮换不同——轮换一个不存在的引用没有任何可轮换的对象，那是错误。
     */
    async remove(ref) {
      const o = await ensure()
      let existed
      try {
        existed = await o.store.remove(ref)
      } catch (e) {
        throw mapStoreError(e, ref)
      }
      const acl = await afterWrite(ref)
      return Object.freeze({ removed: existed === true, ...acl })
    },

    /** 仅供用例与诊断：缓存里是否已经打开了密钥库。**不含路径与引用名之外的东西。** */
    inspect() {
      return Object.freeze({ opened: opened !== null, storePath: opened?.path ?? null })
    },
  })
}
