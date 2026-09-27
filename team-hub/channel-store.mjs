// team-hub/channel-store.mjs
// ============================================================================
// F-25 的两张表：**渠道身份映射**（业主裁决 A：做成配置表、用户自行绑定）
// 与**渠道待办队列**（业主裁决 B：准入后落一条待办记录，由编排或人决定下一步）。
//
// 为什么不直接建 Task：把"外部消息"直接变成 Task 会**绕过**权限、审批与预算那套 ——
// 本仓既有纪律是"新强制路径完成前不放行高风险动作"。先落待办、由人/编排认领，
// 是唯一不偷偷降级的路。
//
// ★ 映射表**默认空**：一条都没绑时，任何入站都以 `unmapped-user` 具名拒绝并记账。
//   这不是"没配好"，是失败关闭 —— 谁是谁必须由人显式绑定。
// ============================================================================

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 */
export function createChannelStore({ db } = {}) {
  if (db === undefined || db === null || typeof db.prepare !== 'function') throw new TypeError('createChannelStore 需要 db')

  db.exec(`CREATE TABLE IF NOT EXISTS channel_identities (
      channel_id       TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      bound_at_ms      INTEGER NOT NULL,
      PRIMARY KEY (channel_id, external_user_id))`)
  db.exec(`CREATE TABLE IF NOT EXISTS channel_inbox (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id     TEXT NOT NULL,
      raw_id         TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      run_key        TEXT NOT NULL,
      text           TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      state          TEXT NOT NULL,
      created_at_ms  INTEGER NOT NULL,
      UNIQUE (channel_id, raw_id))`)

  const need = (v, what) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`缺少参数 ${what}`)
    return v.trim()
  }

  return {
    /** 绑定：同一 (渠道, 外部id) 重复绑定 ⇒ 覆盖（用户改主意是常事）。 */
    bind({ channelId, externalUserId, userId, nowMs = Date.now() } = {}) {
      const c = need(channelId, 'channel'), e = need(externalUserId, 'externalUserId'), u = need(userId, 'userId')
      db.prepare(`INSERT INTO channel_identities (channel_id, external_user_id, user_id, bound_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (channel_id, external_user_id) DO UPDATE SET user_id = excluded.user_id, bound_at_ms = excluded.bound_at_ms`)
        .run(c, e, u, nowMs)
      return { channelId: c, externalUserId: e, userId: u }
    },

    unbind({ channelId, externalUserId } = {}) {
      const c = need(channelId, 'channel'), e = need(externalUserId, 'externalUserId')
      const r = db.prepare('DELETE FROM channel_identities WHERE channel_id = ? AND external_user_id = ?').run(c, e)
      return { removed: Number(r.changes ?? 0) }
    },

    list() {
      return db.prepare('SELECT channel_id, external_user_id, user_id, bound_at_ms FROM channel_identities ORDER BY channel_id, external_user_id').all()
        .map((r) => ({ channelId: r.channel_id, externalUserId: r.external_user_id, userId: r.user_id, boundAtMs: r.bound_at_ms }))
    },

    /** 给闸门用的映射（键 `渠道:外部id`，与契约的约定一致）。 */
    toMap() {
      const m = new Map()
      for (const r of db.prepare('SELECT channel_id, external_user_id, user_id FROM channel_identities').all()) {
        m.set(r.channel_id + ':' + r.external_user_id, r.user_id)
      }
      return m
    },

    /** B：准入后的待办记录。★ 只记被准入的；被拒的不进队列。 */
    enqueue({ channelId, rawId, userId, runKey, text = '', receivedAtMs = 0, nowMs = Date.now() } = {}) {
      db.prepare(`INSERT OR IGNORE INTO channel_inbox
        (channel_id, raw_id, user_id, run_key, text, received_at_ms, state, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(need(channelId, 'channel'), need(rawId, 'rawId'), need(userId, 'userId'), need(runKey, 'runKey'), String(text), Number(receivedAtMs) || 0, nowMs)
      const row = db.prepare('SELECT id FROM channel_inbox WHERE channel_id = ? AND raw_id = ?').get(channelId, rawId)
      return { id: row?.id ?? null }
    },

    pending({ limit = 50 } = {}) {
      return db.prepare('SELECT id, channel_id, raw_id, user_id, run_key, text, received_at_ms, state FROM channel_inbox WHERE state = ? ORDER BY id LIMIT ?')
        .all('pending', Number(limit) || 50)
        .map((r) => ({ id: r.id, channelId: r.channel_id, rawId: r.raw_id, userId: r.user_id, runKey: r.run_key, text: r.text, receivedAtMs: r.received_at_ms, state: r.state }))
    },

    count() {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM channel_inbox').get()?.n ?? 0)
    },
  }
}

/**
 * ★ **活视图**：`instanceof Map`（契约要求），但每次 `get` 都去问一次来源。
 *
 * 为什么不能直接传 `store.toMap()`：那是**一张快照**，而闸门在启动时只构造一次 ⇒
 * "启动之后才绑定的身份"永远查不到。表现是**用户绑了却不生效**，而它与"这人没绑"
 * 在读数上完全一样。*一个启动时拍下的快照，与一个只读一次的表，在"绑定到底生没生效"
 * 这件事上是同一个东西。*
 */
export class LiveIdentityMap extends Map {
  constructor(load) {
    super()
    if (typeof load !== 'function') throw new TypeError('LiveIdentityMap 需要一个取表函数')
    this._load = load
  }

  get(key) {
    const live = this._load()
    const hit = live instanceof Map ? live.get(key) : undefined
    return hit !== undefined ? hit : super.get(key)
  }

  has(key) { return this.get(key) !== undefined }
}
