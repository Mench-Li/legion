// scripts/update/trust-file.mjs
// ============================================================================
// 信任表文件的读写 —— 打包端与运行端**共用同一处定义**
//
// 为什么单独一个文件而不是把路径写在 `keygen.mjs` 里：
//
//   客户端读信任表的路径写在 `product/update/config.mjs`
//   （`UPDATE_TRUST_FILENAME = product/release/update-trust.json`），
//   而打包端写它的路径如果另写一份，两边就会在某一次改名之后错开——
//   那时的表现是"客户端永远说没有公钥"，而打包脚本一切正常。
//
//   所以格式与路径都在这里定义，两边都从这里取。
// ============================================================================

import { join } from 'node:path'

import { UPDATE_TRUST_FILENAME } from '../../product/update/config.mjs'

export const TRUST_FORMAT = 'legion/update-trust@1'

/** 信任表在 installRoot 下的相对位置（与 `config.mjs` 同源）。 */
export function updateTrustPath(installRoot) {
  return join(installRoot, UPDATE_TRUST_FILENAME)
}

/** 发布地址配置在 installRoot 下的相对位置。 */
export function updateConfigPath(installRoot) {
  return join(installRoot, 'product', 'release', 'update-config.json')
}

/**
 * 构造信任表。
 *
 * `sequence` 参与"信任表不能回退"的判定（`envelope.mjs` 的
 * `applyTrustUpdate`），所以它必须被显式带上，而不是靠"表里有几把钥匙"推。
 */
export function buildTrustTable({ sequence = 1, keys = [] } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`信任表 sequence 必须是非负安全整数，实际 ${sequence}`)
  }
  const seen = new Set()
  const cleaned = []
  for (const key of keys) {
    if (typeof key?.keyId !== 'string' || key.keyId === '') throw new Error('信任表条目缺少 keyId')
    if (typeof key.publicKeyPem !== 'string' || !key.publicKeyPem.includes('PUBLIC KEY')) {
      throw new Error(`信任表条目 ${key.keyId} 的公钥不是 PEM`)
    }
    if (seen.has(key.keyId)) throw new Error(`信任表里 keyId 重复：${key.keyId}`)
    seen.add(key.keyId)
    cleaned.push({
      keyId: key.keyId,
      publicKeyPem: key.publicKeyPem,
      ...(Number.isFinite(key.notBeforeMs) ? { notBeforeMs: key.notBeforeMs } : {}),
      ...(Number.isFinite(key.notAfterMs) ? { notAfterMs: key.notAfterMs } : {}),
      ...(Number.isFinite(key.revokedAtMs) ? { revokedAtMs: key.revokedAtMs } : {}),
      ...(typeof key.comment === 'string' ? { comment: key.comment } : {}),
    })
  }
  return Object.freeze({ format: TRUST_FORMAT, sequence, keys: Object.freeze(cleaned) })
}
