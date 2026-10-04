// team-hub/device-store.mjs
// ============================================================================
// 设备注册、配对与在线投影（远程 Agent 通道 S-B 之二）
//
// 设计依据：设计文档 §10「单次配对码应短时、一次性、限速，设备令牌可单独撤销和
// 轮换，并绑定节点 ID 与能力范围」；§11「在线/离线是 presence 投影，不是任务状态」。
//
// ## 与用户会话的分工
//
// 用户会话（`user-store.mjs`）证明"**是谁**"；设备令牌证明"**是哪台机器**"。
// 两者**必须分开**，因为它们的撤销语义不同：
//
//   · 手机丢了 → 撤销那个用户的会话（用户不该再登录）；
//   · 电脑重装了 → 撤销那个设备令牌（人不该被牵连）。
//
// 把它们合成一个凭据会出现"换台电脑就得重新登录手机"这种无意义的连锁。
//
// ## presence 不是任务状态
//
// `hub_node_presence` 只回答"这条连接现在是否还在"。它**不是**任务真相源：
// 设备离线时任务状态仍然从 `tasks` / `run_attempts` 读，而**不被改写**。
// 这一点是设计文档 §6.3 明确要求的（「超过心跳阈值，Agent 显示"连接中断"，
// 任务显示"状态待确认"，而非自动判失败或完成」）。
// 所以本模块**没有任何**写 `tasks` / `run_attempts` 的代码路径——这是刻意的，
// 不是"还没写"。
// ============================================================================
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 设备能力。**白名单**，不是自由文本。
 *
 * `dsh-web-proxy` 只是**预留**：设计文档 §1.2 要求透明 DSH Web 代理必须与任务
 * 通道分离，且「管理员显式开启并单独撤销」。因此它不在默认能力里，也不由配对
 * 自动授予——本模块只登记这个名字，具体实现在后续阶段。
 */
export const DEVICE_CAPABILITIES = Object.freeze(['task.run', 'dsh-web-proxy'])

/** 配对自动授予的能力：只有跑任务。 */
export const DEFAULT_DEVICE_CAPABILITIES = Object.freeze(['task.run'])

/** 配对码默认寿命：10 分钟（设计文档 §10 要求"短时"）。 */
export const PAIRING_TTL_MS = 10 * 60 * 1000

/** 一分钟内最多接受多少次配对兑换（限速）。 */
export const PAIRING_REDEEM_PER_MINUTE = 10

/** 超过这个时间没有心跳就视为连接中断。 */
export const PRESENCE_STALE_MS = 90 * 1000

export const DEVICE_CODES = Object.freeze({
  INVALID_INPUT: 'DEVICE_INVALID_INPUT',
  PAIRING_NOT_FOUND: 'DEVICE_PAIRING_NOT_FOUND',
  PAIRING_CONSUMED: 'DEVICE_PAIRING_CONSUMED',
  PAIRING_EXPIRED: 'DEVICE_PAIRING_EXPIRED',
  PAIRING_RATE_LIMITED: 'DEVICE_PAIRING_RATE_LIMITED',
  TOKEN_INVALID: 'DEVICE_TOKEN_INVALID',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  CAPABILITY_NOT_ALLOWED: 'DEVICE_CAPABILITY_NOT_ALLOWED',
  USER_NOT_FOUND: 'DEVICE_USER_NOT_FOUND',
})

export class DeviceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DeviceError'
    this.code = code
    this.status = status
  }
}

const fail = (code, message, status) => { throw new DeviceError(code, message, status) }

const id = (prefix) => `${prefix}-${randomBytes(12).toString('hex')}`
const hashSecret = (secret) => createHash('sha256').update(String(secret)).digest('hex')

function validateNodeName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) fail(DEVICE_CODES.INVALID_INPUT, '设备名必填')
  const trimmed = name.trim()
  if (trimmed.length > 64) fail(DEVICE_CODES.INVALID_INPUT, '设备名不超过 64 字符')
  return trimmed
}

function validateCapabilities(caps) {
  if (caps === undefined || caps === null) return [...DEFAULT_DEVICE_CAPABILITIES]
  if (!Array.isArray(caps)) fail(DEVICE_CODES.INVALID_INPUT, 'capabilities 必须是数组')
  const out = []
  for (const c of caps) {
    if (!DEVICE_CAPABILITIES.includes(c)) {
      // 具名拒绝而不是过滤掉：静默丢弃会让 Node 以为自己拿到了某个能力。
      fail(DEVICE_CODES.CAPABILITY_NOT_ALLOWED, `未登记的设备能力 ${JSON.stringify(c)}；合法取值：${DEVICE_CAPABILITIES.join(', ')}`)
    }
    if (!out.includes(c)) out.push(c)
  }
  return out
}

/**
 * 设备仓储。
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {(fn: Function) => any} deps.withTx
 * @param {() => number} [deps.clock]
 * @param {Function} [deps.audit]
 */
export function createDeviceStore({ db, withTx, clock = Date.now, audit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createDeviceStore 需要 db')
  if (typeof withTx !== 'function') throw new TypeError('createDeviceStore 需要 withTx')
  const now = () => clock()
  const iso = (ms) => new Date(ms).toISOString()

  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_devices (
      node_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '', capabilities_json TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, protocol_version INTEGER,
      created_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_seen_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS hub_device_pairing_codes (
      code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, node_name TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER, consumed_node_id TEXT);
    CREATE TABLE IF NOT EXISTS hub_node_presence (
      node_id TEXT PRIMARY KEY, connection_id TEXT, connected_at_ms INTEGER,
      last_heartbeat_ms INTEGER NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_hub_devices_user ON hub_devices(user_id);
  `)

  const record = (action, detail, actor) => {
    if (typeof audit !== 'function') return
    try { audit(actor ?? 'system:device', 'global', action, null, detail ?? null) } catch { /* 审计失败不阻断 */ }
  }

  // ── 配对 ──────────────────────────────────────────────────────────────────

  // 限速用进程内滑动窗口：配对兑换是**未认证**入口，而一道内存闸门就足以把
  // "脚本狂刷"变成"每秒十次"。它的失效方式（进程重启后清零）是安全的——
  // 真正的防线是 24 字节随机码 + 一次性 + 短 TTL。
  let redeemWindowStart = 0
  let redeemCount = 0

  function checkRedeemRate() {
    const at = now()
    if (at - redeemWindowStart >= 60_000) { redeemWindowStart = at; redeemCount = 0 }
    redeemCount += 1
    if (redeemCount > PAIRING_REDEEM_PER_MINUTE) {
      fail(DEVICE_CODES.PAIRING_RATE_LIMITED, '配对请求过于频繁，请稍后重试', 429)
    }
  }

  /** 造配对码。**明文只返回一次**，库里存哈希。 */
  function createPairingCode({ userId, nodeName, ttlMs = PAIRING_TTL_MS, random = randomBytes }) {
    const name = validateNodeName(nodeName)
    if (typeof userId !== 'string' || userId.length === 0) fail(DEVICE_CODES.INVALID_INPUT, 'userId 必填')
    const code = Buffer.from(random(24)).toString('base64url')
    const at = now()
    return withTx(() => {
      db.prepare('INSERT INTO hub_device_pairing_codes VALUES(?,?,?,?,?,NULL,NULL)')
        .run(hashSecret(code), userId, name, at, at + ttlMs)
      record('device:pairing-create', { nodeName: name }, userId)
      return { code, nodeName: name, expiresAtMs: at + ttlMs }
    })
  }

  /**
   * 兑换配对码，落一条设备记录并签发设备令牌。
   *
   * 消费码与建设备在**同一个事务**里：分开写的话，进程在中间停下会得到
   * "码已消费但设备不存在"——而码是一次性的，那台电脑就再也配不上对了。
   */
  function redeemPairingCode({ code, platform = '', capabilities, protocolVersion = null }) {
    checkRedeemRate()
    if (typeof code !== 'string' || code.length === 0) fail(DEVICE_CODES.INVALID_INPUT, '配对码必填')
    const caps = validateCapabilities(capabilities)
    const codeHash = hashSecret(code)
    const row = db.prepare('SELECT * FROM hub_device_pairing_codes WHERE code_hash=?').get(codeHash)
    if (!row) fail(DEVICE_CODES.PAIRING_NOT_FOUND, '配对码无效', 404)
    if (row.consumed_at_ms !== null) fail(DEVICE_CODES.PAIRING_CONSUMED, '配对码已被使用', 409)
    if (row.expires_at_ms <= now()) fail(DEVICE_CODES.PAIRING_EXPIRED, '配对码已过期', 410)

    const at = now()
    const nodeId = id('node')
    const deviceToken = Buffer.from(randomBytes(32)).toString('base64url')
    return withTx(() => {
      // 事务内重新判定：两个并发兑换可能都通过了上面那次检查。
      const consumed = db.prepare('UPDATE hub_device_pairing_codes SET consumed_at_ms=?, consumed_node_id=? WHERE code_hash=? AND consumed_at_ms IS NULL')
        .run(at, nodeId, codeHash)
      if (Number(consumed.changes) !== 1) fail(DEVICE_CODES.PAIRING_CONSUMED, '配对码已被使用', 409)
      db.prepare(`INSERT INTO hub_devices
        (node_id,user_id,name,platform,capabilities_json,token_hash,protocol_version,created_at_ms,revoked_at_ms,last_seen_at_ms)
        VALUES(?,?,?,?,?,?,?,?,NULL,?)`)
        .run(nodeId, row.user_id, row.node_name, String(platform).slice(0, 64), JSON.stringify(caps), hashSecret(deviceToken), protocolVersion, at, at)
      record('device:paired', { nodeId, name: row.node_name, capabilities: caps }, row.user_id)
      return { nodeId, deviceToken, name: row.node_name, userId: row.user_id, capabilities: caps }
    })
  }

  // ── 设备令牌 ──────────────────────────────────────────────────────────────

  function deviceRow(nodeId) {
    const row = db.prepare('SELECT * FROM hub_devices WHERE node_id=?').get(nodeId)
    if (!row) fail(DEVICE_CODES.DEVICE_NOT_FOUND, '设备不存在', 404)
    return row
  }

  function publicDevice(row) {
    return {
      nodeId: row.node_id, userId: row.user_id, name: row.name, platform: row.platform,
      capabilities: JSON.parse(row.capabilities_json),
      protocolVersion: row.protocol_version,
      createdAt: iso(row.created_at_ms),
      revoked: row.revoked_at_ms !== null,
      lastSeenAt: row.last_seen_at_ms === null ? null : iso(row.last_seen_at_ms),
    }
  }

  /**
   * 用设备令牌确认身份。
   *
   * 返回 `{ ok, ... }` 而不是抛错：这道检查在 **WSS 握手**里，调用方需要的是
   * "以什么状态码拒绝这次握手"，而不是一个要被 catch 的异常流。
   */
  function authenticate({ token }) {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, code: DEVICE_CODES.TOKEN_INVALID, message: '缺少设备令牌' }
    }
    const row = db.prepare('SELECT * FROM hub_devices WHERE token_hash=?').get(hashSecret(token))
    if (!row) return { ok: false, code: DEVICE_CODES.TOKEN_INVALID, message: '设备令牌无效' }
    if (row.revoked_at_ms !== null) return { ok: false, code: DEVICE_CODES.DEVICE_REVOKED, message: '设备已被撤销' }
    return {
      ok: true, nodeId: row.node_id, userId: row.user_id, name: row.name,
      capabilities: JSON.parse(row.capabilities_json), protocolVersion: row.protocol_version,
    }
  }

  function touchDevice({ nodeId, protocolVersion = null }) {
    try {
      if (protocolVersion === null) db.prepare('UPDATE hub_devices SET last_seen_at_ms=? WHERE node_id=?').run(now(), nodeId)
      else db.prepare('UPDATE hub_devices SET last_seen_at_ms=?, protocol_version=? WHERE node_id=?').run(now(), protocolVersion, nodeId)
    } catch { /* 心跳式更新失败不影响本次请求 */ }
  }

  function rotateToken({ nodeId, by = null, random = randomBytes }) {
    return withTx(() => {
      const row = deviceRow(nodeId)
      if (row.revoked_at_ms !== null) fail(DEVICE_CODES.DEVICE_REVOKED, '设备已被撤销', 409)
      const token = Buffer.from(random(32)).toString('base64url')
      db.prepare('UPDATE hub_devices SET token_hash=? WHERE node_id=?').run(hashSecret(token), nodeId)
      record('device:token-rotate', { nodeId }, by ?? row.user_id)
      return { nodeId, deviceToken: token }
    })
  }

  /**
   * 撤销设备。
   *
   * 同时清掉它的 presence 行：一条"仍然在线"的投影配一个已撤销的设备，
   * 会让界面显示一台不该再出现的机器。撤销是**终态**（不提供反撤销）——
   * 要重新接入就再配一次对，这样"撤销"只有一个含义。
   */
  function revokeDevice({ nodeId, by = null }) {
    return withTx(() => {
      const row = deviceRow(nodeId)
      if (row.revoked_at_ms !== null) return { nodeId, revoked: false, alreadyRevoked: true }
      db.prepare('UPDATE hub_devices SET revoked_at_ms=? WHERE node_id=?').run(now(), nodeId)
      db.prepare('DELETE FROM hub_node_presence WHERE node_id=?').run(nodeId)
      record('device:revoke', { nodeId, name: row.name }, by ?? row.user_id)
      return { nodeId, revoked: true, alreadyRevoked: false }
    })
  }

  function listDevices({ userId = null } = {}) {
    const rows = userId === null
      ? db.prepare('SELECT * FROM hub_devices ORDER BY created_at_ms').all()
      : db.prepare('SELECT * FROM hub_devices WHERE user_id=? ORDER BY created_at_ms').all(userId)
    return rows.map(publicDevice)
  }

  // ── presence 投影 ─────────────────────────────────────────────────────────

  /**
   * 标记设备上线。`connectionId` 是**这一条连接**的标识。
   *
   * 为什么需要它：同一台设备重连时，旧连接的 close 事件可能在新连接建立**之后**
   * 才到达。没有 connectionId 的话，那次迟到的 close 会把新连接标成离线——
   * 一个"刚连上就显示离线"的抖动。带上它就能识别"这不是我这一条"。
   */
  function markOnline({ nodeId, connectionId }) {
    return withTx(() => {
      db.prepare(`INSERT INTO hub_node_presence (node_id,connection_id,connected_at_ms,last_heartbeat_ms,last_event_seq)
        VALUES(?,?,?,?,0)
        ON CONFLICT(node_id) DO UPDATE SET connection_id=excluded.connection_id, connected_at_ms=excluded.connected_at_ms, last_heartbeat_ms=excluded.last_heartbeat_ms`)
        .run(nodeId, connectionId, now(), now())
      return { nodeId, connectionId }
    })
  }

  function heartbeat({ nodeId, connectionId = null, lastEventSeq = null }) {
    const at = now()
    return withTx(() => {
      const row = db.prepare('SELECT * FROM hub_node_presence WHERE node_id=?').get(nodeId)
      if (!row) {
        // 没登记过的节点收到心跳：登记它，而不是丢弃。丢弃会让"重启后先发了
        // 心跳"的 Node 永远显示离线，而它其实一切正常。
        db.prepare('INSERT INTO hub_node_presence VALUES(?,?,?,?,?)').run(nodeId, connectionId, at, at, lastEventSeq ?? 0)
        return { registered: true, nodeId }
      }
      if (connectionId !== null && row.connection_id !== null && row.connection_id !== connectionId) {
        // 心跳来自**另一条**连接：说明这一条是旧的、正在收尾的。不改动投影。
        return { stale: true, nodeId, expectedConnectionId: row.connection_id }
      }
      db.prepare('UPDATE hub_node_presence SET last_heartbeat_ms=?, last_event_seq=COALESCE(?, last_event_seq) WHERE node_id=?')
        .run(at, lastEventSeq, nodeId)
      return { stale: false, nodeId }
    })
  }

  /** 连接断开。同样是 connectionId 栅栏：迟到的 close 不改写新连接的投影。 */
  function markOffline({ nodeId, connectionId = null }) {
    return withTx(() => {
      const row = db.prepare('SELECT * FROM hub_node_presence WHERE node_id=?').get(nodeId)
      if (!row) return { removed: false, reason: 'no-presence' }
      if (connectionId !== null && row.connection_id !== null && row.connection_id !== connectionId) {
        return { removed: false, reason: 'stale-connection', expectedConnectionId: row.connection_id }
      }
      db.prepare('DELETE FROM hub_node_presence WHERE node_id=?').run(nodeId)
      return { removed: true }
    })
  }

  /**
   * 读在线状态。
   *
   * `transport` 与 `runtime` 是**两件事**（设计文档 §11）：连接还在只说明传输可达，
   * 不说明 Agent 运行时可用。这里只报得出来 transport；runtime 的可用性由 Node
   * 在心跳里自报（`runtimeHealthy`），未自报时是 `null`（= 不知道），不是 `false`。
   */
  function presenceOf(nodeId) {
    const row = db.prepare('SELECT * FROM hub_node_presence WHERE node_id=?').get(nodeId)
    if (!row) return Object.freeze({ nodeId, online: false, since: null, lastHeartbeatAt: null, lastEventSeq: 0 })
    const stale = now() - row.last_heartbeat_ms > PRESENCE_STALE_MS
    return Object.freeze({
      nodeId,
      online: !stale,
      stale,
      connectionId: row.connection_id,
      since: row.connected_at_ms === null ? null : iso(row.connected_at_ms),
      lastHeartbeatAt: iso(row.last_heartbeat_ms),
      lastEventSeq: row.last_event_seq,
    })
  }

  function listPresence() {
    return db.prepare('SELECT node_id FROM hub_node_presence ORDER BY node_id').all().map((r) => presenceOf(r.node_id))
  }

  /** 回收所有心跳过期的 presence 行（Hub 重启后内存连接全丢，靠它对齐）。 */
  function sweepStale() {
    return withTx(() => {
      const rows = db.prepare('SELECT node_id, last_heartbeat_ms FROM hub_node_presence').all()
      let removed = 0
      for (const r of rows) {
        if (now() - r.last_heartbeat_ms <= PRESENCE_STALE_MS) continue
        db.prepare('DELETE FROM hub_node_presence WHERE node_id=?').run(r.node_id)
        removed += 1
      }
      return { removed }
    })
  }

  return {
    createPairingCode, redeemPairingCode,
    authenticate, touchDevice, rotateToken, revokeDevice, listDevices,
    markOnline, markOffline, heartbeat, presenceOf, listPresence, sweepStale,
    publicDevice, deviceRow,
    _internals: { hashSecret },
  }
}
