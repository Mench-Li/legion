// product/secrets.mjs
// ============================================================================
// 受保护密钥库的**产品接线**（PRT-254 的「Secret Store 最小闭环」/ PRT-505）
//
// 这个文件补的是一个被反复记录了三遍的缺口：`security/secrets/` 与
// `runtime/probe/secret-resolver.mjs` 都是完整实现、都有用例覆盖，
// 但**没有任何生产代码把它们装起来**。文档里的原话是「尚无生产调用方」。
//
// **一份没人用的密钥库等于没有密钥库。** 本模块是那根线：
//
//   解析出的布局 → 密钥库文件位置 → 受保护密钥库 → 凭证解析器 → 启动自检
//
// ---------------------------------------------------------------------------
// 四条纪律
//
// ① **密钥库不在 DataDir 内。** 见 `product/paths.mjs` 的
//    `SECRETS_INSIDE_DATA_DIR`：DataDir 是备份/恢复/诊断包导出的对象，
//    密钥库落在里面会被任何「打包 DataDir」的操作顺手带走。
//
// ② **没有受保护后端就 fail closed。** 明文后端不会报错、只会静默地不安全，
//    所以这里在**打开密钥库时**就判定，并把结果放进自检。
//    但"拒绝"这个动作由**调用方**做（见 `openProductSecrets` 的 `requireProtected`），
//    因为开发机上"只想看一眼界面"是合理需求——而它必须是一个**说出来的**选择。
//
// ③ **自检返回结果，不抛。** 「这台机器上的密钥库能不能用」是要**显示给人看**的，
//    不是要中断启动的流程。是否阻止启动由调用方根据结果决定
//    ——这与"形状错误抛出、配置问题返回值"是同一条分界。
//
// ④ **诊断里没有密钥、也没有明文引用值。** 自检结果只带 `code`/`message`/
//    方案名与**计数**。连"有哪些引用名"都不带出去：引用名能画出这台机器配了
//    哪些供应商，而自检结果会进日志与诊断包。
// ============================================================================

import {
  ACL_CODES,
  SecretStoreError,
  createProductSecretStore,
  createSystemRunner,
  hardenFileAcl,
  inspectFileAcl,
  isSecretStoreError,
} from '../security/secrets/index.mjs'
import { createSecretResolver } from '../runtime/probe/secret-resolver.mjs'
import { existsSync } from 'node:fs'
import { isPathInside, samePath } from './paths.mjs'

/** 自检结果码。`OK` 之外的每一个都带"下一步该做什么"。 */
export const SECRETS_CHECK_CODES = Object.freeze({
  OK: 'SECRETS_OK',
  LAYOUT_BLOCKED: 'SECRETS_LAYOUT_BLOCKED',
  UNPROTECTED: 'SECRETS_STORE_UNPROTECTED',
  UNSUPPORTED_PLATFORM: 'SECRETS_STORE_UNSUPPORTED_PLATFORM',
  OPEN_FAILED: 'SECRETS_STORE_OPEN_FAILED',
  ACL_TOO_PERMISSIVE: 'SECRETS_ACL_TOO_PERMISSIVE',
  ACL_UNVERIFIABLE: 'SECRETS_ACL_UNVERIFIABLE',
})

/**
 * 打开产品密钥库并接线。
 *
 * @param {object} deps
 * @param {object} deps.layout              `resolveLayout()` 的产物
 * @param {boolean} [deps.requireProtected] 是否要求受保护后端（生产必须 true）
 * @param {Function} [deps.storeFactory]    `({file, platform}) => store`，测试可注入
 * @param {Function} [deps.run]             ACL 检查用的 runner（`icacls`/`stat`）
 * @param {Function} [deps.onAudit]
 * @param {boolean} [deps.hardenAcl]        是否在打开时就收紧文件权限（默认 true）
 * @returns {Promise<{ok, code, message, path, store, resolver, acl, protection, count}>}
 */
export async function openProductSecrets({
  layout,
  requireProtected = true,
  storeFactory = null,
  run = null,
  owner = null,
  onAudit = null,
  hardenAcl = true,
  platform = layout?.platform ?? process.platform,
  // 可注入的"文件是否存在"。默认用真实的 `existsSync`；
  // 用例注入假实现，这样"文件还没创建"与"文件在但 ACL 异常"两条分支
  // 都能被**确定性地**测到，而不需要真的去碰文件系统。
  exists = existsSync,
} = {}) {
  const path = layout?.secretsFile ?? null
  if (path === null || path === undefined || path === '') {
    return result({
      ok: false,
      code: SECRETS_CHECK_CODES.LAYOUT_BLOCKED,
      message: '布局里没有密钥库路径：请先解析产品目录布局（resolveLayout）再打开密钥库。',
      path: null,
    })
  }

  // ① 布局不变量必须先成立。密钥库落在 DataDir / InstallDir / CacheDir 内
  //    是结构性错误，在这里重判一次而不是只信调用方——这个判定很便宜，
  //    而漏掉它的代价是密钥被备份带走或被缓存清理删掉。
  const placement = assertSecretsPlacement(layout, { platform })
  if (placement.ok !== true) {
    return result({ ok: false, code: SECRETS_CHECK_CODES.LAYOUT_BLOCKED, message: placement.message, path })
  }

  // ② 打开密钥库。这里**不抛**：打不开是要显示给人看的状态。
  let store
  try {
    store = storeFactory !== null
      ? storeFactory({ file: path, platform })
      : createProductSecretStore({ file: path, platform, onAudit })
  } catch (err) {
    return result({
      ok: false,
      code: codeForOpenError(err),
      message: messageForOpenError(err),
      path,
    })
  }

  // ③ 保护方案判定。明文后端必须被点出来——它不会报错，只会静默地不安全。
  const protection = store.protection()
  if (requireProtected === true && (protection.protected !== true)) {
    return result({
      ok: false,
      code: SECRETS_CHECK_CODES.UNPROTECTED,
      message: `密钥库后端未提供受保护存储（scheme=${protection.scheme}）：明文后端不会报错、只会静默地不安全，` +
        '不得用于真实密钥。若只是本机开发查看界面，请显式传 requireProtected: false。',
      path,
      store,
      protection,
    })
  }

  // `run` 默认走**真实**实现（真 `icacls` / `stat`）。
  //
  // 这一点很关键：`inspectFileAcl` 在没有 runner 时如实报 `ACL_NO_RUNNER`，
  // 而如果生产代码永远不传 runner，整套 ACL 检查就**只会说"没查过"**——
  // 功能、用例、文档都在，而每一次真实检查都是空的。
  // 那是"尚无生产调用方"的更深一层：**线接上了，但中间那一截是空的**。
  const aclRun = run ?? createSystemRunner()

  // ④ 文件访问控制。DPAPI 保护的是**内容**，不是**文件**：
  //    另一个用户仍可复制它、看到里面有哪些引用名。
  //
  // `owner` 必须传进 `inspectFileAcl`：`icacls` 的输出**不标出**哪个主体是所有者，
  // 所以不传 owner 时真所有者会被当成越权主体——那是 fail closed 方向（不会漏报），
  // 但会让一份干净的 ACL 永远显示"越权"，于是这个提示很快会被所有人忽略。
  const aclBefore = await inspectFileAcl({ file: path, platform, run: aclRun, owner, exists })
  let acl = aclBefore
  let hardened = null
  // `NOT_CREATED` 不触发加固：文件还不存在，没有东西可以加固，
  // 而对着一个不存在的路径跑 `icacls /grant` 只会失败并留下一条假告警。
  const aclApplicable = aclBefore.code !== 'ACL_NOT_CREATED'
  if (hardenAcl === true && aclApplicable && aclBefore.ok !== true) {
    // owner 由调用方显式给出。**本模块不猜**：
    // 猜错主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"（fail open）。
    hardened = await hardenFileAcl({ file: path, platform, run: aclRun, owner })
    acl = await inspectFileAcl({ file: path, platform, run: aclRun, owner, exists })
  }

  // ⑤ 解析器——这一步才是"生产调用方"真正被接上的地方。
  const resolver = createSecretResolver({ store, requireProtected })

  // 计数而不列名：引用名不进诊断（见文件头 ④）。
  let count = null
  try {
    const listed = await store.list()
    count = Array.isArray(listed) ? listed.length : null
  } catch { /* 数目取不到不影响可用性判定 */ }

  // 结论是"能用"，但 ACL 的状态**必须**出现在文案里。
  //
  // 这是刻意的：`ok:true` 说的是"这台机器上密钥库能用来解析凭证"，
  // 而"文件权限有没有被验证过"是另一件事，两者都不许沉默。
  // 一条查不出来的 ACL 不会让密钥库不可用，但它**绝不能**看起来像"已确认安全"。
  const base = count === null
    ? `密钥库可用（scheme=${protection.scheme}）`
    : `密钥库可用（scheme=${protection.scheme}，已录入 ${count} 条）`

  return result({
    ok: true,
    code: SECRETS_CHECK_CODES.OK,
    message: `${base}；文件访问控制：${acl.message}`,
    path,
    store,
    resolver,
    protection,
    acl,
    aclBefore,
    hardened,
    count,
    aclVerified: acl.ok === true,
    // 文件是否已经存在。`aclVerified: false` 有**两种**原因，调用方要能分开：
    //   `aclExists: false` → 还没有文件，没什么可保护的（全新安装的常态）
    //   `aclExists: true`  → 文件在，但没能确认它只有所有者可读（**这才是要提醒的**）
    // 把两者混在一起，启动告警会在每台全新机器上永远出现——而一条永远
    // 都不对的告警与没有告警是同一件事。
    aclExists: acl.code !== 'ACL_NOT_CREATED',
  })
}

// ------------------------------------------------------------------ 内部

/**
 * 判定密钥库位置的合法性。
 *
 * 刻意**只覆盖 `SECRETS_*` 三条**，不复用整个 `layoutDiagnostics`：
 * 打开密钥库不该因为"工作区还没配置"而失败——那是另一件事，
 * 有它自己的提示点，而且要守住的是"这个文件放对地方了吗"。
 */
export function assertSecretsPlacement(layout, { platform = layout?.platform ?? process.platform } = {}) {
  const out = []
  const inside = (parent, child) => {
    if (parent === null || parent === undefined || child === null || child === undefined) return false
    return isPathInside(parent, child, platform) || samePath(parent, child, platform)
  }
  const f = layout?.secretsFile
  if (inside(layout?.dataDir, f)) {
    out.push('SECRETS_INSIDE_DATA_DIR')
  }
  if (inside(layout?.installDir, f)) {
    out.push('SECRETS_INSIDE_INSTALL_DIR')
  }
  if (inside(layout?.cacheDir, f)) {
    out.push('SECRETS_INSIDE_CACHE_DIR')
  }
  if (out.length > 0) {
    return {
      ok: false,
      code: out[0],
      message: `密钥库位置不合法（${f}）：${out.join(' / ')}。` +
        '密钥库必须位于产品家目录下、数据目录与缓存目录之外——' +
        '数据目录会被备份与诊断包带走，缓存目录被定义为可安全删除。',
    }
  }
  return { ok: true, code: null, message: null }
}

async function inspectSecretsAcl({ path, platform, run }) {
  // 文件还不存在时（首次运行），`inspectFileAcl` 会按"读不到"报
  // UNVERIFIABLE/NO_RUNNER——那是**正确**的：没查过就是没查过，
  // 它不该伪装成 ACL_OK。加固会在第一次写入之后生效。
  return inspectFileAcl({ file: path, platform, run: run ?? undefined })
}

// 注：本模块**不读 `process.env`**。
//
// 这与 `product/paths.mjs` 是同一条纪律：环境变量由调用方（Launcher）读取并显式传入，
// 于是 ① 本模块可对 win32/posix 两套语义同时做用例；② 配置面的读取点收敛到一处，
// 只在那一个文件里声明。
//
// 具体到 ACL 的 `owner`：它在 Windows 上是 `DOMAIN\user`，而这个值**不能猜**。
// 猜错主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"。
// 所以 `owner` 是显式入参，不给就**不加固**（并把"没加固"如实报出来）。

function codeForOpenError(err) {
  if (isSecretStoreError(err)) {
    if (err.code === 'SECRET_STORE_UNSUPPORTED_PLATFORM') return SECRETS_CHECK_CODES.UNSUPPORTED_PLATFORM
    if (err.code === 'SECRET_STORE_UNPROTECTED') return SECRETS_CHECK_CODES.UNPROTECTED
  }
  return SECRETS_CHECK_CODES.OPEN_FAILED
}

function messageForOpenError(err) {
  if (isSecretStoreError(err)) return err.message
  // 不原样带出 message：密钥库异常里可能出现路径、账户名或密文片段。
  return `打开密钥库失败：${err?.name ?? 'Error'}（详见日志中的内部码）`
}

function result(fields) {
  return Object.freeze({
    store: null,
    resolver: null,
    protection: null,
    acl: null,
    aclBefore: null,
    hardened: null,
    count: null,
    aclVerified: false,
    ...fields,
  })
}

/**
 * 供启动自检使用：把结果转成**用户可读的一行**（不含任何引用名或密钥）。
 */
export function describeSecretsCheck(check) {
  if (check?.ok === true) return check.message
  return `密钥库不可用：${check?.message ?? '未知原因'}`
}

export { SecretStoreError, ACL_CODES }
