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
//
// ## 公钥轮换的两半（设计 §5 line 128、§10 验收表第 8 行）
//
// 设计对轮换的顺序是硬的：
//
//   「换密钥需先通过**旧信任根签名的客户端更新**预置新公钥，再切换发布签名。」
//
// 于是有**两个**动作，各自一个命令：
//
//   1. `keygen rotate` —— 用**旧私钥**签一份增量（`add` 新公钥）。
//      这份增量是给**已经装好的客户端**看的：它由旧钥匙担保，所以托管被
//      改写也伪造不出来。
//   2. `keygen apply`（本文件）—— 把那份增量**应用到随包信任表**上，
//      产出下一版客户端要带的 `update-trust.json`。
//
// ★ 第 2 步**必须**存在。少了它，第 1 步的输出就没有任何消费者，而
//   `envelope.applyTrustUpdate()` 会变成一个"有实现、有用例、生产里调用方
//   数为 0"的函数——那种东西与不存在的函数在部署上是同一个东西，
//   只不过它的报告是绿的。
// ============================================================================

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { UPDATE_TRUST_FILENAME } from '../../product/update/config.mjs'
import { applyTrustUpdate, createTrustStore } from '../../product/update/envelope.mjs'

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

/** 读一份随包信任表；形状不对时明确失败（不是"没有公钥"）。 */
export function readTrustTable(path) {
  if (!existsSync(path)) {
    return Object.freeze({ ok: false, code: 'trust-table-missing', reason: `信任表不存在：${path}`, table: null })
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return Object.freeze({ ok: false, code: 'trust-table-bad', reason: `信任表不是合法 JSON：${error?.message ?? error}`, table: null })
  }
  if (raw?.format !== TRUST_FORMAT || !Array.isArray(raw?.keys)) {
    return Object.freeze({ ok: false, code: 'trust-table-bad', reason: `信任表格式不对（期望 ${TRUST_FORMAT}）`, table: null })
  }
  return Object.freeze({
    ok: true, code: null, reason: null,
    table: buildTrustTable({ sequence: Number.isSafeInteger(raw.sequence) ? raw.sequence : 0, keys: raw.keys }),
  })
}

/**
 * 把一份**由旧钥匙签名**的信任表增量应用到随包信任表上，产出下一版信任表。
 *
 * 这是 `keygen rotate` 的**唯一消费者**。三条约束都由 `applyTrustUpdate`
 * 负责（它不是新写的逻辑，只是此前没人调用过）：
 *
 *   · 增量的签名必须来自**当前表里已有**的钥匙——新钥匙在下发的这一刻
 *     还签发不了它自己，必须由旧钥匙担保；
 *   · 增量的 `sequence` 必须**严格大于**当前表的 `sequence`
 *     （否则可以把信任表回退到某次吊销之前）；
 *   · 要吊销的 keyId 必须真的在表里（"吊销一个不存在的钥匙"多半是发布端
 *     搞错了对象，静默接受等于把错误吞掉）。
 *
 * @returns 成功时 `table` 是**新的**信任表（可直接写盘并随包发布）
 */
export function applyTrustUpdateToTable({ table, updateBytes, nowMs = Date.now() } = {}) {
  if (table === null || typeof table !== 'object' || !Array.isArray(table.keys)) {
    return Object.freeze({
      ok: false, code: 'trust-table-bad',
      reason: 'applyTrustUpdateToTable 需要一份形状正确的当前信任表', table: null,
    })
  }
  const current = buildTrustTable({ sequence: table.sequence ?? 0, keys: table.keys })
  const applied = applyTrustUpdate(createTrustStore(current.keys), updateBytes, {
    nowMs,
    // ★ 当前表的 sequence 就是"已接受的最高 sequence"。少了它，一份**重放**的
    //   同号增量会被接受——而"用重放把信任表退回吊销之前"正是这条判据要防的。
    lastSequence: current.sequence,
  })
  if (applied.ok !== true) {
    return Object.freeze({ ok: false, code: applied.code, reason: applied.reason, table: current })
  }
  const keys = [...applied.trust.keys.values()].map((entry) => ({
    keyId: entry.keyId,
    publicKeyPem: entry.publicKeyPem,
    ...(Number.isFinite(entry.notBeforeMs) ? { notBeforeMs: entry.notBeforeMs } : {}),
    ...(Number.isFinite(entry.notAfterMs) ? { notAfterMs: entry.notAfterMs } : {}),
    ...(Number.isFinite(entry.revokedAtMs) ? { revokedAtMs: entry.revokedAtMs } : {}),
    ...(typeof entry.comment === 'string' ? { comment: entry.comment } : {}),
  }))
  return Object.freeze({
    ok: true, code: null, reason: null,
    table: buildTrustTable({ sequence: applied.sequence, keys }),
    added: applied.added, revoked: applied.revoked,
    previousSequence: current.sequence,
  })
}

/** 原子写出信任表（临时文件 + rename，理由同设计 §6 要求的下载落盘）。 */
export function writeTrustTable(path, table) {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 尽力清理 */ }
    throw error
  }
  return {
    path, sequence: table.sequence, dir: dirname(path),
    keyIds: table.keys.map((key) => key.keyId),
  }
}
