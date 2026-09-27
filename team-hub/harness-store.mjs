// team-hub/harness-store.mjs
// ============================================================================
// F-23 的**配置表**（业主裁决：结构化配置为权威）。
//
// 两张表：
//   harness_providers  harness 产品（名字 + 接线方式 command/args/env + 是否启用）
//   harness_rules      任务类型 ⇒ provider（这就是"默认哪些任务交给哪个 harness"）
//
// ★ **默认 provider 永远在册、不可摘除**。理由不是洁癖：路由契约要求"在册清单非空"，
//   而一张被清空的表会让**每一次派工都无处可去**；更要紧的是，如果"默认"能从表里被删掉，
//   它就退化成了一个"当前恰好没配"的状态，而系统必须有一个人人知道的去处。
//
// ★ 本表**默认只有 DeepSeek Harness 一行**（不指定就走它）。
//   Codex / Claude Code 这些行**由人显式添加** —— 与 F-25 的映射表同一条纪律：
//   空表不是"没配好"，是**有意的默认**。
// ============================================================================

/** 产品默认：不指定时用它。这个名字是**产品事实**，不是配置项。 */
export const DEFAULT_HARNESS_NAME = 'deepseek-harness'

export function createHarnessStore({ db } = {}) {
  if (db === undefined || db === null || typeof db.prepare !== 'function') throw new TypeError('createHarnessStore 需要 db')

  db.exec(`CREATE TABLE IF NOT EXISTS harness_providers (
      name          TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      command       TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      env_json      TEXT NOT NULL,
      permission    TEXT NOT NULL,
      enabled       INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS harness_rules (
      task_type     TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL)`)

  db.exec('CREATE TABLE IF NOT EXISTS harness_decisions (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, task_type TEXT, requested TEXT, suggested TEXT,' +
    ' provider TEXT, source TEXT NOT NULL, accepted INTEGER NOT NULL, at_ms INTEGER NOT NULL)')

  db.exec('CREATE TABLE IF NOT EXISTS harness_decisions (' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT, task_type TEXT, requested TEXT, suggested TEXT,' +
    ' provider TEXT, source TEXT NOT NULL, accepted INTEGER NOT NULL, at_ms INTEGER NOT NULL)')

  const need = (v, what) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error('缺少参数 ' + what)
    return v.trim()
  }
  const parseArr = (s, what) => {
    try { const v = JSON.parse(s); if (!Array.isArray(v)) throw new Error('不是数组'); return v }
    catch (e) { throw new Error(what + ' 不是合法 JSON 数组：' + e.message) }
  }

  // ★ 默认 provider 的底行：不存在则补上，且**不由外部写入覆盖**（名字固定）。
  const seed = () => {
    db.prepare(`INSERT OR IGNORE INTO harness_providers
      (name, kind, command, args_json, env_json, permission, enabled, updated_at_ms)
      VALUES (?, 'dsh', 'dsh', '[]', '{}', 'reject', 1, ?)`).run(DEFAULT_HARNESS_NAME, Date.now())
  }
  seed()

  const rowToProvider = (r) => ({
    name: r.name, kind: r.kind, command: r.command, args: JSON.parse(r.args_json),
    env: JSON.parse(r.env_json), permission: r.permission, enabled: r.enabled === 1, updatedAtMs: r.updated_at_ms,
  })

  return {
    /** 在册清单：默认恒在首位，其余按名字。 ★ 只数**启用**的行。 */
    routerConfig() {
      seed()
      const rows = db.prepare('SELECT * FROM harness_providers WHERE enabled = 1 ORDER BY name').all().map(rowToProvider)
      const names = [DEFAULT_HARNESS_NAME, ...rows.map((p) => p.name).filter((n) => n !== DEFAULT_HARNESS_NAME)]
      const rules = db.prepare('SELECT task_type, provider FROM harness_rules ORDER BY task_type').all()
        .map((r) => ({ taskType: r.task_type, provider: r.provider }))
      return { providers: names, rules, defaultProvider: DEFAULT_HARNESS_NAME }
    },

    /** 落一行 provider。★ 默认那一行只能改接线方式，不能改名/摘除。 */
    upsertProvider({ name, kind = 'acp', command, args = [], env = {}, permission = 'reject', enabled = true, nowMs = Date.now() } = {}) {
      const n = need(name, 'name')
      const c = need(command, 'command')
      if (!Array.isArray(args)) throw new Error('args 必须是数组')
      if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error('env 必须是对象')
      if (permission !== 'reject' && permission !== 'allow') throw new Error('permission 只能是 reject 或 allow')
      if (n === DEFAULT_HARNESS_NAME) {
        // 允许改启用/接线，但 kind 恒为 dsh（它是本产品自身）
        db.prepare(`UPDATE harness_providers SET command = ?, args_json = ?, env_json = ?, permission = ?, enabled = ?, updated_at_ms = ?
          WHERE name = ?`).run(c, JSON.stringify(args), JSON.stringify(env), permission, enabled ? 1 : 0, nowMs, n)
        return { name: n, kind: 'dsh', protected: true }
      }
      db.prepare(`INSERT INTO harness_providers (name, kind, command, args_json, env_json, permission, enabled, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, command = excluded.command, args_json = excluded.args_json,
          env_json = excluded.env_json, permission = excluded.permission, enabled = excluded.enabled, updated_at_ms = excluded.updated_at_ms`)
        .run(n, need(kind, 'kind'), c, JSON.stringify(args), JSON.stringify(env), permission, enabled ? 1 : 0, nowMs)
      return { name: n, kind, protected: false }
    },

    /** 摘一行 provider。★ 默认那一行不许摘；★ 还有规则指着它也不许摘（会悬空）。 */
    removeProvider({ name } = {}) {
      const n = need(name, 'name')
      if (n === DEFAULT_HARNESS_NAME) return { removed: 0, reason: 'protected-default' }
      const used = db.prepare('SELECT task_type FROM harness_rules WHERE provider = ? ORDER BY task_type').all(n).map((r) => r.task_type)
      if (used.length > 0) return { removed: 0, reason: 'in-use', taskTypes: used }
      const r = db.prepare('DELETE FROM harness_providers WHERE name = ?').run(n)
      return { removed: Number(r.changes ?? 0) }
    },

    listProviders() {
      seed()
      return db.prepare('SELECT * FROM harness_providers ORDER BY name').all().map((r) => ({ ...rowToProvider(r), protected: r.name === DEFAULT_HARNESS_NAME }))
    },

    /** 配置表的一行：任务类型 ⇒ provider。★ 指向不在册的 provider ⇒ 当场拒（别等派工时才发现）。 */
    setRule({ taskType, provider, nowMs = Date.now() } = {}) {
      const t = need(taskType, 'taskType'), p = need(provider, 'provider')
      const known = this.routerConfig().providers
      if (!known.includes(p)) throw new Error('规则指向不在册的 provider：' + t + ' ⇒ ' + p)
      db.prepare(`INSERT INTO harness_rules (task_type, provider, updated_at_ms) VALUES (?, ?, ?)
        ON CONFLICT (task_type) DO UPDATE SET provider = excluded.provider, updated_at_ms = excluded.updated_at_ms`).run(t, p, nowMs)
      return { taskType: t, provider: p }
    },

    removeRule({ taskType } = {}) {
      const t = need(taskType, 'taskType')
      const r = db.prepare('DELETE FROM harness_rules WHERE task_type = ?').run(t)
      return { removed: Number(r.changes ?? 0) }
    },

    listRules() {
      return db.prepare('SELECT task_type, provider, updated_at_ms FROM harness_rules ORDER BY task_type').all()
        .map((r) => ({ taskType: r.task_type, provider: r.provider, updatedAtMs: r.updated_at_ms }))
    },

    /** ★ 来源如实记账：记的是**判定**，`accepted=0` 的行也照记（"这次为什么没派出去"的唯一去处）。入账**永不抛**。 */
    recordDecision({ taskType = null, requested = null, suggested = null, provider = null, source, accepted, nowMs = Date.now() } = {}) {
      try {
        db.prepare('INSERT INTO harness_decisions (task_type, requested, suggested, provider, source, accepted, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(taskType === null ? null : String(taskType), requested === null ? null : String(requested),
            suggested === null ? null : String(suggested), provider === null ? null : String(provider),
            String(source), accepted ? 1 : 0, nowMs)
        return { recorded: true }
      } catch (e) { return { recorded: false, error: e.message } }
    },

    listDecisions({ limit = 50 } = {}) {
      return db.prepare('SELECT id, task_type, requested, suggested, provider, source, accepted, at_ms FROM harness_decisions ORDER BY id DESC LIMIT ?')
        .all(Number(limit) || 50)
        .map((r) => ({ id: r.id, taskType: r.task_type, requested: r.requested, suggested: r.suggested, provider: r.provider, source: r.source, accepted: r.accepted === 1, atMs: r.at_ms }))
    },

    countDecisions() {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM harness_decisions').get()?.n ?? 0)
    },
  }
}
