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

import { createHarnessRouter } from '../runtime/contracts/harness-routing.mjs'
import { createAgentWorkflowDefinition } from '../runtime/contracts/agent-workflow-definition.mjs'
import { expectedExternalPermissionMode } from '../runtime/contracts/agent-provider-policy.mjs'

function agentToolConfigFromRow(row) {
  return {
    id: row.id,
    version: row.version,
    providerName: row.provider_name,
    adapter: row.adapter,
    permissionProfile: row.permission_profile,
    workspacePolicy: row.workspace_policy,
    capabilities: JSON.parse(row.capabilities_json),
    enabled: row.enabled === 1,
  }
}

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

  // Agent 工具配置按 (id, version) 不可变保存；密钥与用户登录状态不进入此表。
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_configs (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      provider_name TEXT NOT NULL,
      adapter TEXT NOT NULL,
      permission_profile TEXT NOT NULL,
      workspace_policy TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (id, version))`)

  // Execution nodes are DSH worker locations, separate from the Agent product
  // and model configured for a stage. Presence is ephemeral; the node record
  // contains no credentials or user session data.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_node_configs (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      label TEXT NOT NULL,
      scope TEXT NOT NULL,
      provider_names_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS agent_node_presence (
      node_id TEXT PRIMARY KEY,
      config_version INTEGER NOT NULL,
      scope TEXT NOT NULL,
      providers_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      last_seen_at_ms INTEGER NOT NULL)`)
  // 2026-10-13（C 档）：节点的**忙闲**与**机器标识**。
  //
  // 为什么需要：自动选节点要判"哪台闲"，而在此之前 hub 对节点负载**一无所知** ——
  //   守护的忙闲是它进程内的 `inflight.size < maxWorkers`，**从不外传**；
  //   hub 只存了配置里的 maxWorkers（意图），没存实际在跑几个（事实）。
  //   ⇒ 没有这两列，"按空闲自主选择"只能拍脑袋。
  //
  // 为什么要 machine_id：自动绑定的判据不是"哪个闲"，而是"**是不是同一台机器**" ——
  //   同机可以改派（抢占式均衡），跨机必须排队（一条链不能跨机，交接尚未实现）。
  //   没有它，就没有"同机/跨机"这个区分，也就没有用户要的那条策略。
  //
  // ★ 三列都可空：老守护不上报 ⇒ NULL（= 未知），绝不能当成 0（= 空闲）。
  for (const [column, ddl] of [
    ['busy_workers', 'busy_workers INTEGER'],
    ['capacity_workers', 'capacity_workers INTEGER'],
    ['machine_id', 'machine_id TEXT'],
  ]) {
    if (!db.prepare('PRAGMA table_info(agent_node_presence)').all().some((c) => c.name === column)) {
      db.exec(`ALTER TABLE agent_node_presence ADD COLUMN ${ddl}`)
    }
  }

  // Reusable workflow definitions are versioned independently from the
  // mutable space_stages pipeline. Runs will snapshot one exact definition.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_workflow_definitions (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, id, version))`)

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
  const parseCapabilities = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('capabilities 必须是对象')
    const allowed = ['textInput', 'textOutput', 'outputSchema', 'toolFilter', 'localAgent', 'sessionResume', 'cancellation']
    const out = {}
    for (const [key, flag] of Object.entries(value)) {
      if (!allowed.includes(key) || typeof flag !== 'boolean') throw new Error(`capabilities.${key} 必须是受支持的布尔能力`)
      out[key] = flag
    }
    for (const key of allowed) if (typeof out[key] !== 'boolean') throw new Error(`capabilities.${key} 必须明确声明`)
    if (out.textInput !== true || out.textOutput !== true) throw new Error('Agent 工具配置必须支持文本输入与输出')
    return out
  }
  const parseNodeCapabilities = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('node capabilities 必须是对象')
    const allowed = ['isolatedWorktree', 'externalAgent', 'structuredOutput', 'toolFilter', 'cancellation']
    const out = {}
    for (const [key, flag] of Object.entries(value)) {
      if (key === 'providers') {
        if (flag === null || typeof flag !== 'object' || Array.isArray(flag)) throw new Error('node capabilities.providers 必须是对象')
        const providers = {}
        for (const [name, caps] of Object.entries(flag)) {
          if (name.trim() === '' || caps === null || typeof caps !== 'object' || Array.isArray(caps)
            || Object.entries(caps).some(([capability, enabled]) => capability === 'permissionMode'
              ? (typeof enabled !== 'string' || enabled.trim() === '')
              : capability === 'systemProxyMode'
                ? !['inherit', 'system'].includes(enabled)
                : (!['outputSchema', 'toolFilter', 'cancellation'].includes(capability) || typeof enabled !== 'boolean'))) {
            throw new Error(`node capabilities.providers.${name} 格式无效`)
          }
          providers[name] = { ...caps }
        }
        out.providers = providers
        continue
      }
      if (!allowed.includes(key) || typeof flag !== 'boolean') throw new Error(`node capabilities.${key} 必须是受支持的布尔能力`)
      out[key] = flag
    }
    for (const key of allowed) if (typeof out[key] !== 'boolean') throw new Error(`node capabilities.${key} 必须明确声明`)
    return out
  }

  /**
   * 节点负载（2026-10-13，C 档）：`{ busy, capacity }`。
   *
   * ★ 三种输入必须分开处理，**不许把它们混成一个值**：
   *   · 缺席（老守护）/ null  ⇒ **null = 未知**（不是 0！）
   *   · 给了合法对象          ⇒ `{busy, capacity}`
   *   · 给了坏东西            ⇒ **抛错**（不静默降级成"未知"）
   *
   * 为什么"未知"必须是 null 而不是 0：忙闲要被用来**挑机器**。
   * 把"不知道"当成"空闲"，选择器会把最不可信的节点排在第一位 ——
   * 而任务发过去之后没人认领，界面上只说"任务不动"。
   *
   *   > 一个"不知道忙不忙"的节点，与一个"确实空闲"的节点，
   *   > 如果都用 0 表示，那选择器就永远分不出该把活儿交给谁。
   */
  const parseNodeLoad = (value) => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('node load 必须是 { busy, capacity } 对象')
    const { busy, capacity } = value
    if (!Number.isInteger(busy) || !Number.isInteger(capacity)) throw new Error('node load.busy / load.capacity 必须是整数')
    // capacity 与 maxWorkers 同域（1..8）：它们是同一件事的"意图"与"事实"，
    // 域不一致会让两处读数没法互相比对。
    if (capacity < 1 || capacity > 8) throw new Error('node load.capacity 必须是 1..8 的整数')
    if (busy < 0 || busy > capacity) throw new Error('node load.busy 必须在 0..capacity 之间')
    return { busy, capacity }
  }

  /**
   * 机器标识（2026-10-13，C 档）：用来判"两个节点是不是同一台机器"。
   *
   * 判据：同机 ⇒ 可以改派（抢占式均衡）；跨机 ⇒ 必须排队（一条链不能跨机）。
   * ★ 缺席 ⇒ null（未知）。**不允许**在这里编造一个默认值 —— 那会让两台不同的机器
   * 因为"都被填了默认值"而被判成同一台，于是跨机的链被当成同机放行。
   */
  const parseMachineId = (value) => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string') throw new Error('machineId 必须是字符串')
    const trimmed = value.trim()
    if (trimmed === '') return null
    if (trimmed.length > 128) throw new Error('machineId 过长（<=128）')
    return trimmed
  }
  const nodeConfigFromRow = (row) => ({
    id: row.id, version: row.version, label: row.label, scope: row.scope,
    providerNames: JSON.parse(row.provider_names_json), capabilities: JSON.parse(row.capabilities_json),
    enabled: row.enabled === 1, updatedAtMs: row.updated_at_ms,
  })
  const nodePresence = (node, nowMs = Date.now()) => {
    const row = db.prepare('SELECT * FROM agent_node_presence WHERE node_id=?').get(node.id)
    if (row === undefined) return { status: 'unknown', lastSeenAtMs: null, observedProviders: [], observedCapabilities: null, busy: null, capacity: null, machineId: null }
    const fresh = row.config_version === node.version && row.scope === node.scope && nowMs - row.last_seen_at_ms <= 60_000
    const observedProviders = JSON.parse(row.providers_json)
    const observedCapabilities = JSON.parse(row.capabilities_json)
    const providersReady = node.providerNames.every((name) => observedProviders.includes(name))
    const capabilitiesReady = Object.entries(node.capabilities).every(([key, required]) => required !== true || observedCapabilities[key] === true)
    const status = !node.enabled ? 'disabled' : !fresh ? 'offline' : providersReady && capabilitiesReady ? 'ready' : 'incompatible'
    // ★★ 负载只在**新鲜**时才报出来，过期一律 null（= 未知）。
    //
    //   为什么这条必须有：一个**过期的**忙闲读数与一个**真的空闲**，在数值上一模一样
    //   （都是 busy=0）。若直接把库里的旧值透出去，选择器会把一台**已经失联**的机器
    //   当成"最闲的那台"挑走 —— 而任务过去之后没有任何人认领。
    //
    //     > 一个"上个月很闲"的读数，与一个"现在很闲"的读数，
    //     > 在**数值上**是同一个东西 —— 区别只在它被用来做决定的那一刻。
    //
    //   machineId 不同：它是**身份**、不随时间衰减，所以只要有过上报就照实返回。
    const busy = fresh && typeof row.busy_workers === 'number' ? row.busy_workers : null
    const capacity = fresh && typeof row.capacity_workers === 'number' ? row.capacity_workers : null
    return { status, lastSeenAtMs: row.last_seen_at_ms, observedProviders, observedCapabilities, busy, capacity, machineId: row.machine_id ?? null }
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

    /** 写入不可变 Agent 工具配置版本；相同内容可幂等重放，冲突必须递增版本。 */
    putAgentToolConfig({ id, version, providerName, adapter = 'dsh-subagent', permissionProfile, workspacePolicy, capabilities, enabled = true, nowMs = Date.now() } = {}) {
      const configId = need(id, 'id')
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configId)) throw new Error('id 格式无效')
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('version 必须为正整数')
      const provider = need(providerName, 'providerName')
      if (!['dsh-subagent', 'dsh-native'].includes(adapter)) throw new Error('adapter 不受支持')
      const permission = need(permissionProfile, 'permissionProfile')
      if (adapter === 'dsh-subagent' && expectedExternalPermissionMode({ adapter, providerName: provider, permissionProfile: permission }) === null) {
        throw new Error(`DSH 外部 provider ${provider} 的 permissionProfile 未映射到受支持的原生权限模式`)
      }
      const workspace = need(workspacePolicy, 'workspacePolicy')
      const caps = parseCapabilities(capabilities)
      const value = { id: configId, version, providerName: provider, adapter, permissionProfile: permission,
        workspacePolicy: workspace, capabilities: caps, enabled: enabled !== false }
      const existing = db.prepare('SELECT * FROM agent_tool_configs WHERE id = ? AND version = ?').get(configId, version)
      if (existing !== undefined) {
        const current = agentToolConfigFromRow(existing)
        if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error('Agent 工具配置版本不可变；请递增 version')
        return { ...current, createdAtMs: existing.created_at_ms, idempotent: true }
      }
      db.prepare(`INSERT INTO agent_tool_configs
        (id, version, provider_name, adapter, permission_profile, workspace_policy, capabilities_json, enabled, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(configId, version, provider, adapter, permission, workspace, JSON.stringify(caps), value.enabled ? 1 : 0, nowMs)
      return { ...value, createdAtMs: nowMs, idempotent: false }
    },

    getAgentToolConfig({ id, version, includeDisabled = false } = {}) {
      const row = db.prepare(`SELECT * FROM agent_tool_configs WHERE id = ? AND version = ?${includeDisabled ? '' : ' AND enabled = 1'}`).get(id, version)
      return row === undefined ? null : { ...agentToolConfigFromRow(row), createdAtMs: row.created_at_ms }
    },

    listAgentToolConfigs({ includeDisabled = true } = {}) {
      const rows = db.prepare(`SELECT * FROM agent_tool_configs${includeDisabled ? '' : ' WHERE enabled = 1'} ORDER BY id, version`).all()
      return rows.map((row) => ({ ...agentToolConfigFromRow(row), createdAtMs: row.created_at_ms }))
    },

    /** Save a DSH execution node. Node IDs are stable; config updates advance a version. */
    putAgentNodeConfig({ id, label, scope, providerNames, capabilities, enabled = true, nowMs = Date.now() } = {}) {
      const nodeId = need(id, 'id')
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nodeId)) throw new Error('node id 格式无效')
      const nodeLabel = need(label, 'label')
      const nodeScope = need(scope, 'scope')
      if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(nodeScope)) throw new Error('node scope 格式无效')
      const declaredProviders = providerNames ?? []
      if (!Array.isArray(declaredProviders)
        || declaredProviders.some((name) => typeof name !== 'string' || name.trim() === '')
        || new Set(declaredProviders.map((name) => name.trim())).size !== declaredProviders.length) {
        throw new Error('providerNames 必须是无重复的名称数组')
      }
      const providers = declaredProviders.map((name) => need(name, 'providerNames[]'))
      const caps = parseNodeCapabilities(capabilities ?? {
        isolatedWorktree: false, externalAgent: false, structuredOutput: false, toolFilter: false, cancellation: false,
      })
      const prior = db.prepare('SELECT * FROM agent_node_configs WHERE id=?').get(nodeId)
      const version = prior === undefined ? 1 : prior.version + 1
      db.prepare(`INSERT INTO agent_node_configs
        (id, version, label, scope, provider_names_json, capabilities_json, enabled, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version, label=excluded.label, scope=excluded.scope,
          provider_names_json=excluded.provider_names_json, capabilities_json=excluded.capabilities_json,
          enabled=excluded.enabled, updated_at_ms=excluded.updated_at_ms`)
        .run(nodeId, version, nodeLabel, nodeScope, JSON.stringify(providers), JSON.stringify(caps), enabled === false ? 0 : 1, nowMs)
      return { ...nodeConfigFromRow(db.prepare('SELECT * FROM agent_node_configs WHERE id=?').get(nodeId)), status: 'unknown' }
    },

    getAgentNodeConfig({ id, version = null, scope = null, includeDisabled = false } = {}) {
      const row = db.prepare(`SELECT * FROM agent_node_configs WHERE id=?${version === null ? '' : ' AND version=?'}${scope === null ? '' : ' AND scope=?'}${includeDisabled ? '' : ' AND enabled=1'}`)
        .get(...[id, ...(version === null ? [] : [version]), ...(scope === null ? [] : [scope])])
      return row === undefined ? null : nodeConfigFromRow(row)
    },

    listAgentNodeConfigs({ scope = null, includeDisabled = false, nowMs = Date.now() } = {}) {
      const rows = db.prepare(`SELECT * FROM agent_node_configs${scope === null ? '' : ' WHERE scope=?'}${includeDisabled ? '' : (scope === null ? ' WHERE' : ' AND') + ' enabled=1'} ORDER BY scope, label, id`)
        .all(...(scope === null ? [] : [scope]))
      return rows.map((row) => {
        const config = nodeConfigFromRow(row)
        return { ...config, ...nodePresence(config, nowMs) }
      })
    },

    heartbeatAgentNode({ id, version, scope, providerNames, capabilities, load, machineId, nowMs = Date.now() } = {}) {
      const node = this.getAgentNodeConfig({ id, version, scope })
      if (node === null) {
        // ★ 2026-10-13：把原来的**一句含糊话**拆成两种可判别的原因。
        //
        //   原文是「节点配置不存在、版本不匹配、空间不匹配或已停用」—— 四种原因挤一句，
        //   调用方**没法据此决定下一步**：其中"压根没这个节点"是**可以自动处理**的
        //   （守护自注册即可），而"有节点但版本/空间不符或已停用"是**人的配置问题**，
        //   自动改写它只会把人的意图悄悄盖掉。
        //
        //   > 一句"四种原因都可能"的错误，
        //   > 与一句"就是没登记"的错误，
        //   > 在**读日志的人**眼里差别不大 —— 但对**要自动修它的代码**是天壤之别。
        //
        //   所以：带上 code，让调用方靠 **code** 分支，不靠中文文本。
        const row = db.prepare('SELECT * FROM agent_node_configs WHERE id=?').get(id)
        if (row === undefined) {
          throw Object.assign(new Error(`执行节点未登记：${id}（本空间还没有这个节点）`), { code: 'AGENT_NODE_UNKNOWN' })
        }
        throw Object.assign(new Error(`执行节点配置不匹配：${id}（版本/空间不符或已停用）`), { code: 'AGENT_NODE_CONFIG_STALE' })
      }
      if (!Array.isArray(providerNames) || providerNames.some((name) => typeof name !== 'string' || name.trim() === '')) throw new Error('observed providerNames 必须是字符串数组')
      const providers = [...new Set(providerNames.map((name) => name.trim()))]
      const caps = parseNodeCapabilities(capabilities)
      const nodeLoad = parseNodeLoad(load)
      const machine = parseMachineId(machineId)
      db.prepare(`INSERT INTO agent_node_presence (node_id, config_version, scope, providers_json, capabilities_json, last_seen_at_ms, busy_workers, capacity_workers, machine_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET config_version=excluded.config_version,
        scope=excluded.scope, providers_json=excluded.providers_json, capabilities_json=excluded.capabilities_json,
        last_seen_at_ms=excluded.last_seen_at_ms, busy_workers=excluded.busy_workers,
        capacity_workers=excluded.capacity_workers, machine_id=excluded.machine_id`)
        .run(node.id, node.version, node.scope, JSON.stringify(providers), JSON.stringify(caps), nowMs,
          nodeLoad === null ? null : nodeLoad.busy, nodeLoad === null ? null : nodeLoad.capacity, machine)
      return this.listAgentNodeConfigs({ scope: node.scope, nowMs }).find((item) => item.id === node.id)
    },

    /**
     * Save an immutable named workflow version, separate from space pipeline
     * settings. Tool references must resolve to enabled immutable configs.
     */
    putAgentWorkflowDefinition({ scope, definition, nowMs = Date.now() } = {}) {
      const workflowScope = need(scope, 'scope')
      if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(workflowScope)) throw new Error('workflow scope 格式无效')
      const normalized = createAgentWorkflowDefinition(definition ?? {})
      const serialized = JSON.stringify(normalized)
      const existing = db.prepare('SELECT definition_json, created_at_ms FROM agent_workflow_definitions WHERE scope=? AND id=? AND version=?')
        .get(workflowScope, normalized.id, normalized.version)
      if (existing !== undefined) {
        if (existing.definition_json !== serialized) throw new Error('工作流定义版本不可变；请递增 version')
        return { ...normalized, scope: workflowScope, createdAtMs: existing.created_at_ms, idempotent: true }
      }
      for (const stage of normalized.stages) {
        const tool = db.prepare('SELECT enabled FROM agent_tool_configs WHERE id=? AND version=?').get(stage.agentToolConfig.id, stage.agentToolConfig.version)
        if (tool === undefined || tool.enabled !== 1) {
          throw new Error(`工作流阶段 ${stage.id} 引用的 Agent 工具配置不存在或已停用：${stage.agentToolConfig.id}@${stage.agentToolConfig.version}`)
        }
      }
      db.prepare(`INSERT INTO agent_workflow_definitions (scope, id, version, definition_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?)`)
        .run(workflowScope, normalized.id, normalized.version, serialized, nowMs)
      return { ...normalized, scope: workflowScope, createdAtMs: nowMs, idempotent: false }
    },

    getAgentWorkflowDefinition({ scope, id, version } = {}) {
      const workflowScope = need(scope, 'scope')
      const workflowId = need(id, 'id')
      if (!Number.isSafeInteger(version) || version < 1) throw new Error('version 必须为正整数')
      const row = db.prepare('SELECT definition_json, created_at_ms FROM agent_workflow_definitions WHERE scope=? AND id=? AND version=?')
        .get(workflowScope, workflowId, version)
      return row === undefined ? null : { ...JSON.parse(row.definition_json), scope: workflowScope, createdAtMs: row.created_at_ms }
    },

    listAgentWorkflowDefinitions({ scope = null } = {}) {
      const rows = db.prepare(`SELECT scope, definition_json, created_at_ms FROM agent_workflow_definitions
        ${scope === null ? '' : 'WHERE scope=?'} ORDER BY scope, id, version`)
        .all(...(scope === null ? [] : [scope]))
      return rows.map((row) => ({ ...JSON.parse(row.definition_json), scope: row.scope, createdAtMs: row.created_at_ms }))
    },

    /**
     * ★ **建任务时的判定**（F-23 接进派工路径的那一处）。
     * 输入 = 任务类型（用 `role`）+ 调用方这次是否指名 + **模型建议**（裁决「2 为主、1 兜底」里的兜底）；
     * 输出与路由契约同形。★ 建议只在**配置表没命中**时才轮得到，且它**必须在册**。
     * ★ 判定结果**不落进任务行** —— 它是 `harness_rules` 的**推导值**（规则一改就过期，
     *   而一份过期的、看起来像记录的东西比没有更糟）。要追溯看 `harness_decisions` 流水。
     * ★ **必记流水**（成功与被拒都记），哪怕调用方随后放弃建任务。
     */
    routeForTask({ taskType = null, requested = null, suggested = null, nowMs = Date.now() } = {}) {
      const out = createHarnessRouter(this.routerConfig()).resolve({ taskType, requested, suggested })
      this.recordDecision({
        taskType, requested, suggested, provider: out.ok ? out.provider : null,
        source: out.ok ? out.source : out.reason, accepted: out.ok, nowMs,
      })
      return out
    },
  }
}
