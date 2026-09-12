// team-hub/allow-once.mjs
// ============================================================================
// PRT-616：`allow-once` 的原子占位 —— 同一 Attempt 内相同 canonical 哈希只能放行一次
//
// spec §6.5（F-02）：
//   「answerer 命中 Legion 已批准决定时，消费必须由 team-hub 执行原子 CAS
//     （`approved → consumed`），同一哈希只能成功一次，CAS 失败即 deny。
//     同一 Attempt 内模型对同一目标发出**参数完全相同**的并发重复调用不得放行两次。」
//
// ---------------------------------------------------------------------------
// 为什么 PRT-608 的行级 CAS 还不够
//
// PRT-608 的 CAS 是 `UPDATE … WHERE requestId=? AND status='approved' AND bindingHash=?`。
// 它保证的是「**这一行**只能被消费一次」。而危险场景里根本不存在"这一行"：
//
//   模型在同一个 Attempt 内对同一目标并发发出**两次参数完全相同**的调用。两次都走
//   `checkPermission`，两次都命中 `ask`，两次都没在去重查询里看到对方 →
//   **写下两条独立的待批准行**（两条哈希相同）。用户看到两个一模一样的弹窗，
//   各点一次「批准」→ 两条都是 `approved`。
//
//   接下来的消费阶段：调用 A 消费第一条（成功），调用 B 消费第二条（**也成功**）。
//   行级 CAS 全程尽职，一次都没失败——因为**两条行各自都只被消费了一次**。
//   而同一个规范化操作执行了两次。
//
//   > 一个「每一行都只被消费一次」的 CAS，
//   > 与一个「同一个操作被放行两次」的 CAS，在「它到底防住了什么」上是同一个东西。
//
// 所以需要第二把锁，它的键**不是行**，而是「这一次授权的内容」：
// `(attemptId, bindingHash)`。同一 Attempt 内同一哈希，全局只能成功占位一次。
//
// ---------------------------------------------------------------------------
// 为什么键必须带**无歧义的分隔符**
//
// 键是拼出来的。若直接用字符串连接：
//
//     attemptId='ab', hash='cd'   →  'abcd'
//     attemptId='a',  hash='bcd'  →  'abcd'   ← 撞车
//
// 两条**不同**的授权会共用一个键，于是第二条被当成"已经被用掉了"而拒绝。
// 方向是 fail-closed（不是放行），但它把一个正确的调用判成重复——
// 用户看到的是"我没重复调用，它说我重复了"，而排查它要想到"键是怎么拼的"。
//
//   > 一个「键会撞车」的占位表，与一个「随机拒绝合法调用」的占位表，
//   > 是同一个东西——只不过前者的表现取决于两个字段各有多长。
//
// 用 `\u0000` 分隔：它不可能出现在 attemptId（UUID/`att-…`）或 sha256 十六进制里，
// 而且 `loadOnStart` 时期就能有一个**算出来的样例键**供用例比对。
// ============================================================================

import { nfc } from '../runtime/contracts/canonical.mjs'

export const ALLOW_ONCE_VERSION = 'legion/allow-once@1'

/** 占位账本的表名。**不是** `permission_requests`——账本是"这一次放行被用掉了"的
 *  事实，而审批行是"有人申请过"。两者生命周期不同：审批行会被清理，占位不能。 */
export const ALLOW_ONCE_TABLE = 'approval_consumptions'

/** 键的分隔符。见文件头：它必须是一个不可能出现在任一字段里的字符。 */
export const KEY_SEPARATOR = '\u0000'

/** 没有 Attempt 上下文的调用所用的命名空间标记。 */
export const NO_ATTEMPT_NAMESPACE = '\u0000request\u0000'

/** 占位的结果。**只有两种**，而且两种必须被调用方区别对待。 */
export const CLAIM_OUTCOMES = Object.freeze({
  CLAIMED: 'claimed',
  LOST_RACE: 'lost-race',
})

/** 拒绝/说明用的码。 */
export const ALLOW_ONCE_CODES = Object.freeze({
  ATTEMPT_DUPLICATE: 'allow-once-attempt-duplicate',
  NO_ATTEMPT_CONTEXT: 'allow-once-no-attempt-context',
})

const ALLOW_ONCE_COLUMNS = Object.freeze([
  'consumptionKey', 'requestId', 'attemptId', 'bindingHash', 'consumedAt', 'callId',
])

/**
 * 建占位账本。
 *
 * `consumptionKey` 是 **PRIMARY KEY**——这不是"索引优化"，而是这个模块的**全部机制**：
 * 唯一约束把"两个人同时想占同一个键"变成一个**原子**问题，交给 SQLite 去裁决。
 * 应用层先查后写做不到这件事（查与写之间有窗口）。
 *
 *   > 一个"先 SELECT 看看有没有、没有就 INSERT"的占位，
 *   > 与一个"在并发下会双双成功"的占位，是同一个东西——只不过它出错需要一点运气。
 */
export function ensureAllowOnceSchema(db) {
  if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
    throw new TypeError('ensureAllowOnceSchema 需要 db（且必须有 exec）')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ALLOW_ONCE_TABLE} (
      consumptionKey TEXT PRIMARY KEY,
      requestId TEXT NOT NULL,
      attemptId TEXT,
      bindingHash TEXT NOT NULL,
      consumedAt TEXT NOT NULL,
      callId TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approval_consumptions_hash ON ${ALLOW_ONCE_TABLE} (bindingHash)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_approval_consumptions_request ON ${ALLOW_ONCE_TABLE} (requestId)`)
  return true
}

/**
 * 占位键。
 *
 * `attemptId` 缺失时**不**退化成"只按哈希"：那会变成一把全局的哈希锁——
 * 同一操作在**不同** Attempt 里再次被批准（完全合法）会被拒，而且是**永久**拒。
 *
 *   > 一个「没有 Attempt 就按哈希全局锁死」的降级，
 *   > 与一个「这张票以后再也不能用」的降级，是同一个东西——
 *   > 而它的表现是「过了一阵子，这个操作就再也做不了了」。
 *
 * 所以缺 Attempt 时换一个**独立命名空间**（按 requestId）：不产生假拒绝，
 * 同时这次放行在账本里**仍然留有痕迹**，且 `attemptScoped` 标出本次没有
 * Attempt 级去重——边界是可见的，不是猜的。
 */
export function consumptionKey({ attemptId = null, bindingHash, requestId = null } = {}) {
  const hash = typeof bindingHash === 'string' ? nfc(bindingHash).trim() : ''
  if (hash === '') throw new TypeError('consumptionKey 需要非空 bindingHash')
  const att = attemptId === null || attemptId === undefined ? '' : String(attemptId).trim()
  if (att === '') {
    const rid = requestId === null || requestId === undefined ? '' : String(requestId).trim()
    if (rid === '') throw new TypeError('没有 attemptId 时必须给出 requestId（否则占位无从命名）')
    return `${NO_ATTEMPT_NAMESPACE}${nfc(rid).trim()}`
  }
  // 分隔符两边的字段各自 trim：前后空白不该改变一次授权的身份。
  return `${att}${KEY_SEPARATOR}${hash}`
}

/** 这一次占位是否具备 Attempt 级去重语义。 */
export function isAttemptScopedKey(key) {
  return typeof key === 'string' && !key.startsWith(NO_ATTEMPT_NAMESPACE) && key.includes(KEY_SEPARATOR)
}

/**
 * 原子占位。
 *
 * `INSERT OR IGNORE` + `changes===1` 就是这把锁：
 *   · 第一个到达的调用插入成功（`changes === 1`）→ `CLAIMED`
 *   · 其余所有并发调用被主键约束忽略（`changes === 0`）→ `LOST_RACE`
 *
 * **不**先 `SELECT` 再 `INSERT`：查与写之间的窗口正是这个模块要消灭的东西。
 */
export function claimOnce({ db, attemptId = null, bindingHash, requestId, consumedAtText, callId = null } = {}) {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new TypeError('claimOnce 需要 db')
  }
  const key = consumptionKey({ attemptId, bindingHash, requestId })
  const res = db
    .prepare(`INSERT OR IGNORE INTO ${ALLOW_ONCE_TABLE} (${ALLOW_ONCE_COLUMNS.join(',')}) VALUES (?,?,?,?,?,?)`)
    .run(key, String(requestId ?? ''), attemptId === null || attemptId === undefined ? null : String(attemptId),
      nfc(String(bindingHash)).trim(), String(consumedAtText ?? ''), callId === null ? null : String(callId))
  const changes = Number(res.changes)
  return Object.freeze({
    outcome: changes === 1 ? CLAIM_OUTCOMES.CLAIMED : CLAIM_OUTCOMES.LOST_RACE,
    changes,
    key,
    attemptScoped: isAttemptScopedKey(key),
    attemptId: attemptId === null || attemptId === undefined ? null : String(attemptId),
  })
}

/**
 * 退回一次占位。
 *
 * 只在**同一次事务内**、且**这一次没有放行**时调用：占位成功而随后
 * `approved → consumed` 的 CAS 输了，说明这张票并没有被这次调用用掉
 * （它被别的调用用掉了，或它根本不是 approved）。
 *
 * 不退的话，一次竞争会把这张票**永久**废掉：用户批准了，没人执行，而且
 * 之后再怎么重试都是"这个操作已经用过了"。
 *
 *   > 一个「占位成功但放行失败、占位却留着」的账本，
 *   > 与一个「用户批准之后什么都做不了」的账本，是同一个东西。
 */
export function releaseClaim({ db, key } = {}) {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new TypeError('releaseClaim 需要 db')
  }
  const res = db.prepare(`DELETE FROM ${ALLOW_ONCE_TABLE} WHERE consumptionKey=?`).run(String(key))
  return Object.freeze({ released: Number(res.changes) === 1, changes: Number(res.changes) })
}

/** 读一条占位的详情（诊断/用例用）。**只读叶字段**，不返回行对象本身。 */
export function readClaim({ db, key } = {}) {
  const row = db.prepare(`SELECT * FROM ${ALLOW_ONCE_TABLE} WHERE consumptionKey=?`).get(String(key))
  if (row === null || row === undefined) return null
  return Object.freeze({
    key: row.consumptionKey,
    requestId: row.requestId,
    attemptId: row.attemptId ?? null,
    bindingHash: row.bindingHash,
    consumedAt: row.consumedAt,
    callId: row.callId ?? null,
  })
}

/** 某个 Attempt 已经用掉了哪些哈希（供诊断"这一次到底放行过什么"）。 */
export function listClaimsOfAttempt({ db, attemptId } = {}) {
  return db.prepare(`SELECT consumptionKey, requestId, bindingHash, consumedAt FROM ${ALLOW_ONCE_TABLE} WHERE attemptId=? ORDER BY consumedAt`)
    .all(String(attemptId))
    .map((r) => Object.freeze({
      key: r.consumptionKey, requestId: r.requestId, bindingHash: r.bindingHash, consumedAt: r.consumedAt,
    }))
}

// ---------------------------------------------------------------------------
// 装载时自检
//
// 刻意**不**导出一个布尔 `ok`——`ok: true` 是随手就能写出来的字面量。
// 导出的是**算出来的样例键与判定结果**：想伪造"分隔符没被去掉"，
// 就得让 `consumptionKey` 真的拼出一个会撞车的键。
// ---------------------------------------------------------------------------

const SAMPLE_HASH_A = 'a'.repeat(64)
const SAMPLE_HASH_B = 'b'.repeat(64)

/**
 * 自检：键必须**无歧义**，且两种命名空间互不覆盖。
 *
 * 样例对是**长度不同**的两个字段对：`('att-1','ab')` 与 `('att-1a','b')`。
 * 去掉分隔符时两者都拼成 `att-1ab`。
 *
 * 顺带说明为什么"两个字段各自定长"时看不出问题：那时拼接本身就没有歧义
 * （总数相等 ⇒ 前 L 个字符相等 ⇒ 两个 attemptId 相等）。所以这个缺陷只在
 * **字段长度会变**时显形，而 `attemptId` 恰恰会变（UUID / `att-…` / 测试夹具），
 * `bindingHash` 的长度在本模块里也没有被强制。一个只在特定输入形状下显形的缺陷，
 * 比一个恒定的缺陷更需要一条能**构造出那种形状**的自检。
 *
 * `keyOf` 可注入的理由与 `assertDeadlineShared` 注入 `beat` 完全相同：
 * 正确实现下"两个不同的字段对拼出同一个键"恒为假，那段断言**永远不触发**——
 *
 *   > 一段永远不会触发的断言，与一段不存在的断言，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 *
 * 注入一个恒返回同一个串的 `keyOf`，就能验那道比较是活的。
 *
 * ⚠️ **不能**靠注入一对**字段**来触发它——分隔符在，任何一对字段都撞不上。
 * 那种写法看起来像"构造了一次撞车"，实际永远测不到东西（本模块的用例在
 * 第一版就是这么写的，实测没红）。
 */
export function assertKeyUnambiguous({ left, right, keyOf = consumptionKey, keyIsAttemptScoped = isAttemptScopedKey } = {}) {
  const l = left ?? { attemptId: 'att-1', bindingHash: 'ab' }
  const r = right ?? { attemptId: 'att-1a', bindingHash: 'b' }
  const kl = keyOf(l)
  const kr = keyOf(r)
  if (kl === kr) {
    throw new Error(
      `内部错误（PRT-616）：两个不同的 (attemptId, bindingHash) 拼出了同一个占位键 ${JSON.stringify(kl)}——`
      + '占位表会把一次正确的调用当成重复调用而拒绝（键的分隔符丢了？）',
    )
  }
  // 缺 Attempt 时必须落到**另一个**命名空间，不能与有 Attempt 的键撞上
  const noAttempt = keyOf({ attemptId: null, bindingHash: SAMPLE_HASH_A, requestId: 'req-1' })
  if (noAttempt === keyOf({ attemptId: 'req-1', bindingHash: SAMPLE_HASH_A })) {
    throw new Error(
      '内部错误（PRT-616）：无 Attempt 的占位键与有 Attempt 的键撞上了——'
      + '那会变成一把跨 Attempt 的全局哈希锁，让合法调用被永久拒绝',
    )
  }
  if (keyIsAttemptScoped(noAttempt)) {
    throw new Error('内部错误（PRT-616）：无 Attempt 的键被判定为"具备 Attempt 级去重"')
  }
  return Object.freeze({
    leftKey: kl,
    rightKey: kr,
    distinct: kl !== kr,
    separatorCodePoint: KEY_SEPARATOR.codePointAt(0),
    noAttemptKey: noAttempt,
    noAttemptIsAttemptScoped: keyIsAttemptScoped(noAttempt),
    attemptKeyIsAttemptScoped: keyIsAttemptScoped(kl),
  })
}

export const ALLOW_ONCE_CHECKED = Object.freeze({
  version: ALLOW_ONCE_VERSION,
  table: ALLOW_ONCE_TABLE,
  codes: ALLOW_ONCE_CODES,
  ...assertKeyUnambiguous(),
})
