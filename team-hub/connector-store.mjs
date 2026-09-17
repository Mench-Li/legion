// team-hub/connector-store.mjs
// ============================================================================
// F-21 连接器登记表的**落盘面**（控制面侧）。
//
// 执行面 `runtime/connectors/registry.mjs` 负责"放不放过去"；
// 这一层负责让控制面能回答两个事后问题：
//   · 这个连接器**当时**是怎么声明的（策略、风险、工具清单）
//   · 它的熔断器**什么时候**开的、开的理由是什么
//
// ---------------------------------------------------------------------------
// ★ ① 控制面不许 import 执行面
//
// 与 F-19/F-20 同一条单向边界：`team-hub/` 不能 import `runtime/`。
// 所以声明里那几个封闭词表在这里**抄了一份**，并由一条用例**从执行面源码里
// 抽出来**逐字比对（而不是再抄一遍——两份手抄件互相核对时，两边一起写错它全绿）。
//
// ---------------------------------------------------------------------------
// ★ ② 声明按**内容哈希**冻结，与岗位包同一条纪律
//
// `version` 是标签、`content_hash` 才是身份。同一个 (connector_id, version)
// 换一份内容必须被拒，否则"两次运行引用同一个版本、而实际上是两份不同的声明"
// ——那时"当时放行了哪些工具"就再也答不了了。
//
//   ★ 这一条在连接器上比在岗位包上更尖锐：岗位包描述的是"这个岗位能做什么"，
//     而连接器声明的是**一个外部进程能拿到什么权限**。
//
// ---------------------------------------------------------------------------
// ★ ③ 故障隔离的记录必须点名"是哪一个"
//
// 只记"某处发生了故障"时，一次隔离良好的单点故障与一次大面积故障长得一样。
// 所以事件表里 `connector_id` 是必填的，而且**没有**"全局"这种值——
// 一个能表达"全局故障"的字段，会让"三个连接器各挂了一次"与"全部连接器同时挂"
// 写成同一条记录。
// ============================================================================

import { createHash } from 'node:crypto'

import { ensureColumn } from './schema-util.mjs'

/**
 * 控制面侧的字面量副本（见文件头 ①）。
 *
 * ★ 这些值必须与 `runtime/connectors/registry.mjs` 逐字相同，
 *   由 `connector-store.test.mjs` 用例①**从执行面源码里抽出来**比对。
 */
export const CONNECTOR_LITERALS = Object.freeze({
  registryVersion: 'legion/connector-registry@1',
  transports: Object.freeze(['stdio', 'http', 'sse']),
  decisions: Object.freeze(['allow', 'deny', 'ask']),
  circuitStates: Object.freeze(['closed', 'open', 'half-open']),
})

export const CONNECTOR_RECORD_VERSION = 'legion/connector-record@1'

export const CONNECTOR_STORE_ERRORS = Object.freeze({
  BAD_RECORD: 'CONNECTOR_RECORD_MALFORMED',
  UNKNOWN_TRANSPORT: 'CONNECTOR_TRANSPORT_UNKNOWN',
  VERSION_CONFLICT: 'CONNECTOR_VERSION_CONFLICT',
  TOOL_DUPLICATE: 'CONNECTOR_TOOL_DUPLICATE',
  NO_TOOLS: 'CONNECTOR_TOOLS_EMPTY',
  BAD_EVENT: 'CONNECTOR_EVENT_MALFORMED',
  UNKNOWN_STATE: 'CONNECTOR_CIRCUIT_STATE_UNKNOWN',
  // ★ 这里**没有** `NOT_FOUND`。`getDeclaration` 找不到时返回 `null`——
  //   那是一个正常读数（"这个连接器还没登记过"），不是错误。
  //   定义一个永远不会抛的码，与一段被注释掉的代码是同一个东西，
  //   只不过前者让错误码清单看起来更完整。（用例 ⑤ 会盯住这一点。）
  WRITE_FAILED: 'CONNECTOR_WRITE_FAILED',
  READ_FAILED: 'CONNECTOR_READ_FAILED',
})

/** 熔断事件的种类，封闭词表。 */
export const CONNECTOR_EVENT_KINDS = Object.freeze(['circuit-opened', 'circuit-closed', 'probe-failed'])

function fail(code, message, extra = {}, statusCode = 400) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  err.statusCode = statusCode
  Object.assign(err, extra)
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 建表。两张表，都是**只追加**。
 *
 * `connector_registrations` —— 声明按 (scope, connector_id, content_hash) 冻结。
 *   ★ 主键带 `content_hash` 而不是 `version`：见文件头 ②。同一版本换内容会
 *     插入第二行，而由 `freezeDeclaration` 显式拒绝（而不是靠主键冲突报一个
 *     语义不清的错）。
 * `connector_incidents` —— 熔断事件（见文件头 ③）。
 */
export function ensureConnectorSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_registrations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      connector_id TEXT NOT NULL,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      transport TEXT NOT NULL,
      tool_count INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      frozen_at_ms INTEGER NOT NULL,
      frozen_by TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_connector_reg_id ON connector_registrations(scope, connector_id, seq)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_connector_reg_hash ON connector_registrations(content_hash)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_incidents (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'default',
      connector_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      circuit_state TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      reason TEXT,
      actor TEXT,
      recorded_at_ms INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_connector_incident ON connector_incidents(scope, connector_id, seq)')
  ensureColumn(db, 'connector_registrations', 'frozen_by', 'TEXT')
  ensureColumn(db, 'connector_incidents', 'actor', 'TEXT')
}

/**
 * 规范化一份声明。
 *
 * ★ 这一层**重新校验一遍**，不复用执行面的校验：它是**唯一**的写入口，
 *   而只在执行面拦时，一个直接打 HTTP 的调用方可以绕过去。
 *   两层的词表由用例①钉住，所以"两处校验"不会漂移成两套规则。
 */
export function normalizeDeclaration(input) {
  if (!isPlainObject(input)) {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, '声明必须是一个对象')
  }
  const connectorId = String(input.connectorId ?? '').trim()
  if (connectorId === '' || !/^[A-Za-z0-9._-]+$/.test(connectorId)) {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 id ${JSON.stringify(input.connectorId)} 不合法`)
  }
  // ★ `version_label` 优先于 `version`：这是**幂等性**的要求，不是风格问题。
  //
  //   规范化之后的记录是 `{ version: 'legion/connector-record@1',
  //   version_label: '1.0.0' }`——两个字段各有各的用处。若这里读的是
  //   `input.version`，那么对一份**已经规范化过**的记录再规范化一次，
  //   就会把**记录格式版本**当成声明版本号，于是
  //
  //     declarationContentHash(raw) !== declarationContentHash(normalize(raw))
  //
  //   而哈希是身份：同一个逻辑声明算出来的身份会取决于"你传进来的是原始
  //   输入还是规范化后的对象"。后果很具体——`freezeDeclaration` 内部先
  //   规范化，所以调用方**事前**自己算一次哈希去比对时必然对不上；
  //   更糟的是幂等判断会时灵时不灵，于是一次无害的重放被报成
  //   "同版本换内容"（409），而真正换过内容的那次有可能被当成重放收下。
  //   （这条是被用例 ② 的"撞上另一个写入者"抓出来的：那里的假 db 回的是
  //   规范化后的记录，哈希就与传入时算的不同了。）
  const rawLabel = input.version_label !== undefined ? input.version_label : input.version
  const version = String(rawLabel ?? '').trim()
  if (version === CONNECTOR_RECORD_VERSION) {
    // 有人把记录格式版本当成了声明版本号。不猜他要的是哪个版本：
    // 猜错会让"这次冻结的是哪一版"变成一个编出来的答案。
    throw fail(
      CONNECTOR_STORE_ERRORS.BAD_RECORD,
      `连接器 ${connectorId} 的 version 填成了记录格式版本 ${CONNECTOR_RECORD_VERSION}。` +
      '那说的是这份记录长什么样，不是这个连接器是哪一版；' +
      '把它当成版本号会让"当时冻结的是哪一版"答成一个编出来的答案',
    )
  }
  if (version === '') {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 ${connectorId} 缺 version`)
  }
  const transport = String(input.transport ?? '').trim()
  if (!CONNECTOR_LITERALS.transports.includes(transport)) {
    throw fail(
      CONNECTOR_STORE_ERRORS.UNKNOWN_TRANSPORT,
      `连接器 ${connectorId} 的 transport ${JSON.stringify(input.transport)} 不在词表里` +
      `（${CONNECTOR_LITERALS.transports.join(' / ')}）`,
    )
  }
  const policy = String(input.policy ?? 'allow').trim()
  if (!CONNECTOR_LITERALS.decisions.includes(policy)) {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 ${connectorId} 的 server 级策略不合法`)
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    throw fail(
      CONNECTOR_STORE_ERRORS.NO_TOOLS,
      `连接器 ${connectorId} 没有工具。一个"没有工具"的连接器与一个"工具列表没读到"的连接器长得一样`,
    )
  }
  const tools = input.tools.map((t) => {
    if (!isPlainObject(t)) throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 ${connectorId} 的工具必须是对象`)
    const name = String(t.name ?? '').trim()
    if (name === '') throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 ${connectorId} 有一个工具没有 name`)
    const toolPolicy = String(t.policy ?? 'allow').trim()
    if (!CONNECTOR_LITERALS.decisions.includes(toolPolicy)) {
      throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, `连接器 ${connectorId} 的工具「${name}」策略不合法`)
    }
    // 能力必须显式声明（与执行面一致：空的能力清单与"能力未知"同形）。
    const capabilities = Array.isArray(t.capabilities) ? t.capabilities.map((c) => String(c)) : []
    if (capabilities.length === 0) {
      throw fail(
        CONNECTOR_STORE_ERRORS.BAD_RECORD,
        `连接器 ${connectorId} 的工具「${name}」没有声明 capabilities`,
      )
    }
    return Object.freeze({
      name,
      capabilities: Object.freeze(capabilities),
      declaredRisk: t.declaredRisk ?? null,
      risk: t.risk ?? null,
      policy: toolPolicy,
    })
  })
  const names = tools.map((t) => t.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length > 0) {
    // 重复时后一条会**遮蔽**前一条——与执行面同一条理由：
    // 于是先写那条的 capabilities 与策略变成死配置，而清单看起来完全正常。
    throw fail(
      CONNECTOR_STORE_ERRORS.TOOL_DUPLICATE,
      `连接器 ${connectorId} 重复声明了工具 ${JSON.stringify([...new Set(dup)])}。` +
      '重复时后一条会**遮蔽**前一条，于是先写那条的 capabilities 与策略变成死配置',
    )
  }
  return Object.freeze({
    version: CONNECTOR_RECORD_VERSION,
    connectorId,
    version_label: version,
    transport,
    policy,
    tools: Object.freeze(tools),
    secretRefs: Object.freeze((Array.isArray(input.secretRefs) ? input.secretRefs : []).map((r) => String(r))),
  })
}

/**
 * 内容哈希：声明里**决定权限**的那几项。
 *
 * ★ `frozenAtMs`/`frozenBy` 这类来源信息**不进哈希**：对同一份声明再冻一次
 *   必须得到同一个哈希（否则幂等重放会变成"换了一版"）。
 */
export function declarationContentHash(decl) {
  const d = normalizeDeclaration(decl)
  const payload = {
    connectorId: d.connectorId,
    version: d.version_label,
    transport: d.transport,
    policy: d.policy,
    // 工具**排序后**参与哈希：声明里的顺序不影响权限，
    // 让顺序进哈希会让一次纯重排看起来像一次权限变更。
    //
    // ★ `risk` 也要进哈希——它是**存下来的**字段，而哈希必须覆盖所有
    //   存下来的、与权限有关的字段。不覆盖时：有人把某个工具的 `risk`
    //   从 high 改成 low，哈希不变，于是这次冻结被当成"重放"收下并
    //   **静默丢弃**，而他得到一句"内容相同、无需重冻"。
    //
    //   一个「改了一个权限相关字段、却被告知内容没变」的写入，
    //   与一个「改了、但改动被悄悄丢掉」的写入，是同一个东西。
    tools: [...d.tools]
      .map((t) => ({
        name: t.name,
        capabilities: [...t.capabilities].sort(),
        policy: t.policy,
        declaredRisk: t.declaredRisk,
        risk: t.risk ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    secretRefs: [...d.secretRefs].sort(),
  }
  // 用 domain-separated 的简单摘要（这一层不 import 执行面的 `canonical.mjs`，
  // 见文件头 ①）。字典序键的 JSON 足以让"同样的声明给同样的哈希"成立。
  const text = JSON.stringify(payload, sortedKeys)
  return `sha256:${sha256Hex(text)}`
}

function sortedKeys(_k, v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const out = {}
  for (const k of Object.keys(v).sort()) out[k] = v[k]
  return out
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 冻结一份声明。
 *
 * 与岗位包同一条语义：**内容相同则幂等成功、内容不同则 409**，没有第三种。
 */
export function freezeDeclaration({ db, declaration, version, scope = 'default', frozenAtMs = Date.now(), frozenBy = null } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(CONNECTOR_STORE_ERRORS.WRITE_FAILED, 'freezeDeclaration 需要一个打开的数据库', {}, 500)
  }
  const decl = normalizeDeclaration({ ...declaration, version: version ?? declaration?.version })
  const contentHash = declarationContentHash(decl)
  const label = decl.version_label

  let existing
  try {
    existing = db.prepare(
      'SELECT * FROM connector_registrations WHERE scope = ? AND connector_id = ? AND version = ? ORDER BY seq DESC LIMIT 1',
    ).get(scope, decl.connectorId, label)
  } catch (err) {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, `读登记失败：${err?.message ?? err}`, {}, 500)
  }

  if (existing !== undefined) {
    if (String(existing.content_hash) === contentHash) {
      // 幂等：**不更新**冻结时刻与冻结人——那会让"第一次是什么时候冻的"被一次重试改写。
      return Object.freeze({
        frozen: true, created: false,
        connectorId: decl.connectorId, version: label, contentHash,
        toolCount: decl.tools.length,
        frozenAtMs: Number(existing.frozen_at_ms), frozenBy: existing.frozen_by ?? null,
      })
    }
    throw fail(
      CONNECTOR_STORE_ERRORS.VERSION_CONFLICT,
      `连接器 ${decl.connectorId} 的 ${label} 已经冻结过，但**内容不同**` +
      `（已冻结 ${existing.content_hash}，本次 ${contentHash}）。**这一次写入没有发生。**` +
      '★ 连接器声明说的是"一个外部进程能拿到什么权限"：' +
      '允许同版本换内容，等于允许"两次运行引用同一个版本、而其中一次多了一个能删库的工具"。' +
      '确实改了内容就**递增版本号**',
      { existingHash: String(existing.content_hash), incomingHash: contentHash }, 409,
    )
  }

  try {
    db.prepare(`
      INSERT INTO connector_registrations (
        scope, connector_id, version, content_hash, transport, tool_count, record_json, frozen_at_ms, frozen_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scope, decl.connectorId, label, contentHash, decl.transport, decl.tools.length, JSON.stringify(decl), frozenAtMs, frozenBy)
  } catch (err) {
    // 竞态：另一个写入者抢先插了。再查一次，同哈希 ⇒ 幂等，否则 409。
    let after
    try {
      after = db.prepare(
        'SELECT * FROM connector_registrations WHERE scope = ? AND connector_id = ? AND version = ? ORDER BY seq DESC LIMIT 1',
      ).get(scope, decl.connectorId, label)
    } catch { after = undefined }
    if (after !== undefined && String(after.content_hash) === contentHash) {
      return Object.freeze({
        frozen: true, created: false,
        connectorId: decl.connectorId, version: label, contentHash,
        toolCount: decl.tools.length,
        frozenAtMs: Number(after.frozen_at_ms), frozenBy: after.frozen_by ?? null,
      })
    }
    if (after !== undefined) {
      throw fail(CONNECTOR_STORE_ERRORS.VERSION_CONFLICT,
        `连接器 ${decl.connectorId} 的 ${label} 已被写入另一个内容（这次写入没有发生）`,
        { existingHash: String(after.content_hash), incomingHash: contentHash }, 409)
    }
    throw fail(CONNECTOR_STORE_ERRORS.WRITE_FAILED, `写入登记失败：${err?.message ?? err}`, {}, 500)
  }
  return Object.freeze({
    frozen: true, created: true,
    connectorId: decl.connectorId, version: label, contentHash,
    toolCount: decl.tools.length, frozenAtMs, frozenBy,
  })
}

function rowToRegistration(row) {
  let decl = null
  let readable = true
  try {
    decl = JSON.parse(row.record_json)
    if (!isPlainObject(decl)) readable = false
  } catch {
    // ★ 不猜：坏行与"从没登记过"必须分得开。
    readable = false
  }
  return Object.freeze({
    seq: Number(row.seq),
    scope: row.scope,
    connectorId: row.connector_id,
    version: row.version,
    contentHash: row.content_hash,
    transport: row.transport,
    toolCount: Number(row.tool_count),
    frozenAtMs: Number(row.frozen_at_ms),
    frozenBy: row.frozen_by ?? null,
    declaration: readable ? Object.freeze(decl) : null,
    readable,
  })
}

/** 读登记（可按连接器过滤；支持 `sinceSeq` 增量）。 */
export function connectorRegistrations({ db, scope = 'default', connectorId = null, sinceSeq = 0, limit = null } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, 'connectorRegistrations 需要一个打开的数据库', {}, 500)
  }
  const where = ['scope = ?', 'seq > ?']
  const args = [scope, Number(sinceSeq) || 0]
  if (connectorId !== null) { where.push('connector_id = ?'); args.push(connectorId) }
  const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : ''
  try {
    const rows = db.prepare(
      `SELECT * FROM connector_registrations WHERE ${where.join(' AND ')} ORDER BY seq ASC${cap}`,
    ).all(...args)
    return Object.freeze(rows.map(rowToRegistration))
  } catch (err) {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, `读登记失败：${err?.message ?? err}`, {}, 500)
  }
}

/** 一个连接器**最新**那一版（不传 version 时）。找不到返回 `null`。 */
export function getDeclaration({ db, connectorId, version = null, scope = 'default' } = {}) {
  const id = String(connectorId ?? '').trim()
  if (id === '') throw fail(CONNECTOR_STORE_ERRORS.BAD_RECORD, 'getDeclaration 需要 connectorId')
  const all = connectorRegistrations({ db, scope, connectorId: id })
  const rows = version === null ? all : all.filter((r) => r.version === version)
  if (rows.length === 0) return null
  // 最新一版 = 冻结时刻最大，同刻按 seq；**不依赖磁盘顺序**。
  return rows.slice().sort((a, b) => (b.frozenAtMs - a.frozenAtMs) || (b.seq - a.seq))[0]
}

/**
 * 记一条熔断事件。
 *
 * ★ `connectorId` 与 `kind` 都必填（见文件头 ③）。
 */
export function appendIncident({
  db, scope = 'default', connectorId, kind, circuitState, atMs, reason = null, actor = null, nowMs = Date.now(),
} = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(CONNECTOR_STORE_ERRORS.WRITE_FAILED, 'appendIncident 需要一个打开的数据库', {}, 500)
  }
  const id = String(connectorId ?? '').trim()
  if (id === '') {
    // ★ 不接"全局"这种值：一个能表达"全局故障"的字段，会让
    //   "三个连接器各挂了一次"与"全部连接器同时挂"写成同一条记录。
    throw fail(
      CONNECTOR_STORE_ERRORS.BAD_EVENT,
      '事件必须点名**是哪一个**连接器。只记"某处发生了故障"时，' +
      '一次隔离良好的单点故障与一次大面积故障长得一样',
    )
  }
  if (!CONNECTOR_EVENT_KINDS.includes(kind)) {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_EVENT, `未知的事件种类 ${JSON.stringify(kind)}（${CONNECTOR_EVENT_KINDS.join(' / ')}）`)
  }
  const state = String(circuitState ?? '').trim()
  if (!CONNECTOR_LITERALS.circuitStates.includes(state)) {
    throw fail(CONNECTOR_STORE_ERRORS.UNKNOWN_STATE, `未知的熔断状态 ${JSON.stringify(circuitState)}`)
  }
  if (!Number.isInteger(atMs)) {
    throw fail(CONNECTOR_STORE_ERRORS.BAD_EVENT, `事件的 atMs 必须是整数毫秒（收到 ${JSON.stringify(atMs)}）`)
  }
  let seq
  try {
    const res = db.prepare(`
      INSERT INTO connector_incidents (scope, connector_id, kind, circuit_state, at_ms, reason, actor, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scope, id, kind, state, atMs, reason === null ? null : String(reason), actor === null ? null : String(actor), nowMs)
    // ★ 用 `lastInsertRowid`，**不能** `SELECT MAX(seq)`：两个进程共用一个
    //   SQLite 文件时，A 插 5、B 插 6，然后 A 读到 6——A 把别人的号报成自己的。
    //   （这是 F-18 那一批踩过的同一个坑，见 `experience-store.mjs`。）
    seq = Number(res.lastInsertRowid)
  } catch (err) {
    throw fail(CONNECTOR_STORE_ERRORS.WRITE_FAILED, `写入事件失败：${err?.message ?? err}`, {}, 500)
  }
  return Object.freeze({ appended: true, seq, connectorId: id, kind })
}

/** 读事件。 */
export function connectorIncidents({ db, scope = 'default', connectorId = null, sinceSeq = 0, limit = null } = {}) {
  if (db === null || typeof db?.prepare !== 'function') {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, 'connectorIncidents 需要一个打开的数据库', {}, 500)
  }
  const where = ['scope = ?', 'seq > ?']
  const args = [scope, Number(sinceSeq) || 0]
  if (connectorId !== null) { where.push('connector_id = ?'); args.push(connectorId) }
  const cap = Number.isInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : ''
  try {
    return Object.freeze(db.prepare(
      `SELECT * FROM connector_incidents WHERE ${where.join(' AND ')} ORDER BY seq ASC${cap}`,
    ).all(...args).map((row) => Object.freeze({
      seq: Number(row.seq),
      connectorId: row.connector_id,
      kind: row.kind,
      circuitState: row.circuit_state,
      atMs: Number(row.at_ms),
      reason: row.reason ?? null,
      actor: row.actor ?? null,
    })))
  } catch (err) {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, `读事件失败：${err?.message ?? err}`, {}, 500)
  }
}

/** 读数。拿不到时报 `readable:false` + null，**不是 0**。 */
export function connectorCounts({ db, scope = 'default' } = {}) {
  try {
    const regs = db.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT connector_id) AS ids FROM connector_registrations WHERE scope = ?',
    ).get(scope)
    const inc = db.prepare(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT connector_id) AS ids FROM connector_incidents WHERE scope = ?',
    ).get(scope)
    // ★ 每个连接器**最后一条**事件决定它现在是不是开路。
    //
    //   第一版写成相关子查询（`HAVING MAX(seq) = (SELECT MAX(seq) ... connector_id = connector_incidents.connector_id)`），
    //   它在只有一条事件时是对的，多条时**恒为空**——用例当场抓到了
    //   （期望 `['gitlab']`、实际 `[]`）。
    //   SQLite 的 `GROUP BY` + `MAX()` 会让其余列取自最大值所在的那一行，
    //   所以这一版既短又不依赖相关子查询的作用域细节。
    const open = db.prepare(
      "SELECT connector_id, circuit_state, MAX(seq) AS last_seq FROM connector_incidents " +
      'WHERE scope = ? GROUP BY connector_id',
    ).all(scope).filter((r) => r.circuit_state === 'open')
    return Object.freeze({
      readable: true,
      registrations: Number(regs?.n ?? 0),
      connectorIds: Number(regs?.ids ?? 0),
      incidents: Number(inc?.n ?? 0),
      incidentConnectorIds: Number(inc?.ids ?? 0),
      // ★ 单点隔离读数：**哪几个**现在还开着，而不是"有故障"这一个布尔。
      openCircuitIds: Object.freeze(open.map((r) => r.connector_id)),
    })
  } catch (err) {
    return Object.freeze({
      readable: false, registrations: null, connectorIds: null,
      incidents: null, incidentConnectorIds: null, openCircuitIds: null,
      reason: String(err?.message ?? err),
    })
  }
}

/** 导出成可提交进 Git 的审阅文本（字段白名单：不含命令与 URL 细节）。 */
export function exportConnectors({ db, scope = 'default', exportedAtMs = Date.now(), pretty = true } = {}) {
  let regs
  let incidents
  try {
    regs = connectorRegistrations({ db, scope })
    incidents = connectorIncidents({ db, scope })
  } catch (err) {
    throw fail(CONNECTOR_STORE_ERRORS.READ_FAILED, `导出前读失败：${err?.message ?? err}`, {}, 500)
  }
  const doc = {
    format: 'legion/connector-export@1',
    recordVersion: CONNECTOR_RECORD_VERSION,
    registryVersion: CONNECTOR_LITERALS.registryVersion,
    scope,
    exportedAtMs,
    counts: connectorCounts({ db, scope }),
    registrations: regs.map((r) => ({
      seq: r.seq,
      connectorId: r.connectorId,
      version: r.version,
      contentHash: r.contentHash,
      transport: r.transport,
      policy: r.declaration?.policy ?? null,
      // ★ 只出工具的**名字与策略**，不出 capabilities/risk 的细节？
      //   不：权限就是这个文件存在的理由。审阅的人要看的正是"这个工具是干嘛的"。
      tools: (r.declaration?.tools ?? []).map((t) => ({
        name: t.name, capabilities: t.capabilities, policy: t.policy, risk: t.risk ?? null,
      })),
      // ★ 只出引用的**名字**。引用的名字不是凭证，但它会告诉审阅的人
      //   "这个连接器要拿哪一类凭证"——那正是要看的东西。
      secretRefs: r.declaration?.secretRefs ?? [],
      frozenAtMs: r.frozenAtMs,
      frozenBy: r.frozenBy,
      readable: r.readable,
    })),
    incidents: incidents.map((i) => ({
      seq: i.seq, connectorId: i.connectorId, kind: i.kind,
      circuitState: i.circuitState, atMs: i.atMs, reason: i.reason, actor: i.actor,
    })),
  }
  return { text: JSON.stringify(doc, null, pretty ? 2 : 0), doc }
}
