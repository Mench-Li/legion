// security/secrets/ref.mjs
// ============================================================================
// SecretRef 的唯一权威校验（PRT-505 输入 / PRT-258 第四份契约的引用规则）
//
// `secretRef` 是**引用名**，不是密钥。spec §6.7 要求 team-hub 只保存 `secretRef`、
// 明文只存在于受保护的本地密钥库。因此这个模块是「什么算一个合法引用」的单一实现，
// `runtime/contracts/model.mjs`（ModelProfile.secretRef）也引用它——
// 两份实现漂移的表现是「档案校验通过、密钥库找不到」或反过来，
// 而这两种都只在用户真正跑起来时才暴露。
//
// ## 比 profile 校验更严的一条：不得包含路径穿越
//
// 引用名会被用作密钥库里的记录键（也可能被用作文件名或日志字段）。
// 允许 `..` 意味着一个看似无害的引用名可以把写入重定向到库目录之外。
// 因此除字符集之外，这里额外禁止空段与 `..` 段。
// ============================================================================

/** 引用允许的最大长度（与既有 profile 校验一致，避免两处口径不同）。 */
export const SECRET_REF_MAX_LENGTH = 128

/**
 * 字符集：字母数字开头，后续允许字母数字与 `. _ : / -`。
 * 与 `runtime/contracts/model.mjs` 历史的 profile 校验完全一致——
 * 收紧字符集会让已经存到库里的旧档案突然变成非法。
 */
export const SECRET_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

/** 是否是一个合法的 SecretRef 引用名。 */
export function isSecretRef(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > SECRET_REF_MAX_LENGTH) return false
  if (!SECRET_REF_RE.test(value)) return false
  // 路径穿越与空段：引用名会成为库里的键，`a//b` 与 `a/../b` 都不该被接受
  if (value.includes('/')) {
    for (const segment of value.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') return false
    }
  }
  if (value === '.' || value === '..') return false
  return true
}

/**
 * 校验并归一化引用名。失败时抛错——静默返回原值会让非法引用变成
 * 「写进库但永远读不出来」的记录。
 */
export function assertSecretRef(value, { field = 'secretRef' } = {}) {
  if (!isSecretRef(value)) {
    throw new Error(
      `${field} 不是合法引用名：${JSON.stringify(value)}。只允许字母数字开头、`
      + `长度 1..${SECRET_REF_MAX_LENGTH}、字符集 [A-Za-z0-9._:/-]，且不得含空段或 ".."。`,
    )
  }
  return value
}

/**
 * 命名空间前缀（`legion/`）。用于把产品自己的密钥与别处的记录区分开，
 * 便于按前缀列出与清理；不是强制的（本地模型可以没有密钥）。
 */
export const LEGION_SECRET_NAMESPACE = 'legion/'

/** 判断引用是否落在产品命名空间内。 */
export function isLegionSecretRef(value) {
  return typeof value === 'string' && value.startsWith(LEGION_SECRET_NAMESPACE)
}
