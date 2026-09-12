// team-hub/approval-binding.mjs
// ============================================================================
// PRT-608 审批绑定规范化操作哈希
//
// spec 阶段 6 完成标准：「未批准高风险写操作为零；改变已批准操作的任一关键字段后
// 无法继续执行。」
//
// ── 本模块唯一真正要紧的那条纪律 ──
//
// **绑定的哈希必须被写下来，而不是每次验证时重新算。**
//
// PRT-611 已经把"两次调用是不是同一个操作"从 `JSON.stringify` 换成了规范化指纹。
// 但如果审批行里**只存操作 JSON**、验证时再算一遍指纹，那么：
//
//   审批的"身份"是由**今天这份代码**定义的。
//
// 这句话的后果是具体的。假设有人往 `OPERATION_KEYS` 里加了一个字段（这正是
// PRT-611 的加载时自检在鼓励的事），那么**所有还在等待的审批**会在一夜之间
// 悄悄改变含义：昨天批准的那次调用，今天可能对不上；更糟的是反过来——
// 一个原本不匹配的调用，可能因为规范化变了而匹配上。
// 整个过程没有任何一条日志，因为每一次验证都在"用当前规则算一遍"。
//
//   > 一个"每次验证时按当前规则重算身份"的审批绑定，
//   > 与一个"审批的含义由你读它的那一刻的代码决定"的绑定，
//   > 是同一个东西——只不过前者的失效方式是**静默重绑**。
//
// 所以：批准的那一刻算出哈希、**存进那一行**，之后一切都以那一行为准。
// 规范化规则改了，旧行的哈希就是一个**旧规则下的字符串**，于是它对不上、
// 于是它 fail-closed、于是有人看得见。这正是我们要的。
//
// ── 第二条纪律：没有哈希的审批行一律**拒绝**，不"跳过校验" ──
//
// 迁移会留下一批 `bindingHash` 为 NULL 的老行（见 §4：我们**有意不回填**）。
// 对它们只有两种处理方式：
//
//   · "这行没哈希，那就跳过哈希校验" —— 危险方向
//   · "这行没哈希，所以它绑定了什么我不知道" —— 拒绝
//
//   > 一个"老的审批行没有哈希，那就跳过哈希校验"的回退，
//   > 与一个"任何审批都放行"的回退，是同一个东西。
//
// 所以 NULL 哈希是一个**独立的拒绝码**（`approval-unbound`），而不是"不检查"。
// 把它混进"操作变了"里也不行：那会让一次迁移遗留看起来像一次用户改参数，
// 值班的人会去查错了方向。
// ============================================================================

import { OPERATION_DOMAIN, operationFingerprint } from './permission-engine.mjs'

/** 绑定记录的版本。它与 F-02 的操作 schema 版本**不是**一回事。 */
export const APPROVAL_BINDING_VERSION = 'legion/approval-binding@1'

/** 审批行的状态。`expired` 是 F-02 既有状态，与 §6.4 的「TTL 到期自动 deny」对齐。 */
export const APPROVAL_STATES = Object.freeze(['pending', 'approved', 'denied', 'consumed', 'expired'])

/** 可以进入"执行"的状态。只有 `approved`。 */
export const CONSUMABLE_APPROVAL_STATES = Object.freeze(['approved'])

/** 终态：不会再变化的状态。用于"要不要写审计"和"要不要进待办"。 */
export const TERMINAL_APPROVAL_STATES = Object.freeze(['denied', 'consumed', 'expired'])

/** `permission_requests` 上承载绑定哈希的列名。 */
export const BINDING_HASH_COLUMN = 'bindingHash'

/** 审批表名。 */
export const APPROVAL_TABLE = 'permission_requests'

/**
 * `permission_requests` 上承载「哪一个 Attempt 在等这份审批」的列名（PRT-615）。
 *
 * 它与 `taskId` **不是**一回事，也别合成一个：任务重试之后是一条**新** Attempt，
 * 而 `taskId` 不变。用 `taskId` 匹配会把上一条 Attempt 的审批算成本次的依据——
 * 那正是"审批证据闸门"要防的事。
 */
export const APPROVAL_ATTEMPT_COLUMN = 'attempt_id'

const APPROVAL_BASE_COLUMNS = Object.freeze([
  'requestId', 'scope', 'actor', 'action', 'target', 'taskId', 'operation',
  'mode', 'status', 'decidedBy', 'reason', 'createdAt', 'expiresAt', 'decidedAt', 'consumedAt',
])

/**
 * 建/补审批表。
 *
 * **从 `server.mjs` 搬到这里**，理由与 PRT-411 把 `run_context_snapshots` 交给
 * context-store 是同一个：表结构与"什么算一条合法审批"是同一份知识，而它一旦分裂成
 * 两份（生产一份、夹具一份），夹具手抄的列名会在增删时**静默**与真实结构脱节
 * ——插入报错还算好的，列名恰好还兼容时才真正难查。
 *
 * 每条 `ALTER` 都先查 `PRAGMA table_info` 再动手（幂等）：`try { ALTER } catch {}`
 * 会把"加列失败"（磁盘满、表被锁）与"列已存在"吞成同一个结果，于是真的失败时没有迹象。
 */
export function ensureApprovalSchema(db) {
  if (db === null || typeof db !== 'object' || typeof db.exec !== 'function') {
    throw new TypeError('ensureApprovalSchema 需要 db（且必须有 exec）')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${APPROVAL_TABLE} (
      requestId TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      taskId TEXT,
      operation TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      decidedBy TEXT,
      reason TEXT,
      createdAt TEXT NOT NULL,
      expiresAt INTEGER,
      decidedAt TEXT,
      consumedAt TEXT
    )
  `)
  const cols = db.prepare(`PRAGMA table_info(${APPROVAL_TABLE})`).all().map((c) => c.name)
  for (const name of [BINDING_HASH_COLUMN, APPROVAL_ATTEMPT_COLUMN]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${APPROVAL_TABLE} ADD COLUMN ${name} TEXT`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_scope_status ON ${APPROVAL_TABLE} (scope, status, createdAt)`)
  // 到期扫描按 (status, expiresAt) 走。没有这条索引时扫描是**全表**，而它跑在每一次
  // 请求之间——一个随审批历史增长而变慢的扫描，与一个最终会拖垮服务端的扫描，
  // 是同一个东西。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_status_expires ON ${APPROVAL_TABLE} (status, expiresAt)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_requests_attempt ON ${APPROVAL_TABLE} (${APPROVAL_ATTEMPT_COLUMN})`)
  return Object.freeze({
    table: APPROVAL_TABLE,
    columns: Object.freeze([...APPROVAL_BASE_COLUMNS, BINDING_HASH_COLUMN, APPROVAL_ATTEMPT_COLUMN]),
  })
}

/** 校验拒绝码。**每一个都是一件不同的事**，不许合并。 */
export const BINDING_CODES = Object.freeze({
  NOT_FOUND: 'approval-not-found',
  UNBOUND: 'approval-unbound',
  OPERATION_CHANGED: 'approval-operation-changed',
  NOT_APPROVED: 'approval-not-approved',
  EXPIRED: 'approval-expired',
  ALREADY_CONSUMED: 'approval-already-consumed',
  EMPTY_HASH: 'approval-empty-hash',
})

/**
 * 一次操作的**绑定哈希**。
 *
 * 它就是 F-02 的 `operationFingerprint`——**不是**另算一遍。
 * 一个与 F-02 各算一份的绑定哈希，与一个"审批绑的东西和执行时看的东西不是
 * 同一个东西"的绑定，是同一个东西。
 */
export function computeBindingHash(operation) {
  return operationFingerprint(operation)
}

/** 空的/缺失的哈希一律当成"没有绑定"。`''` 与 `'   '` 都不是合法的哈希。 */
export function isBoundHash(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.trim())
}

/**
 * 构造一条审批绑定记录（`permission_requests` 行的形状，不含数据库细节）。
 *
 * 哈希在**这一刻**算出来并进入返回值，调用方负责把它写进那一行。
 */
export function createBindingRecord({
  requestId,
  operation,
  mode,
  ttlMs,
  nowMs = Date.now(),
  scope,
  actor,
  action,
  target,
  taskId = null,
} = {}) {
  const bindingHash = computeBindingHash(operation)
  if (!isBoundHash(bindingHash)) throw new Error(`绑定哈希形态非法：${bindingHash}`)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error(`审批 TTL 必须是正数：${ttlMs}`)
  return Object.freeze({
    requestId: String(requestId ?? '').trim(),
    scope: String(scope ?? '').trim(),
    actor: String(actor ?? '').trim(),
    action: String(action ?? '').trim(),
    target: String(target ?? '').trim(),
    taskId: taskId === null || taskId === undefined ? null : String(taskId),
    bindingHash,
    mode: String(mode ?? ''),
    status: 'pending',
    createdAtMs: Number(nowMs),
    expiresAtMs: Number(nowMs) + Number(ttlMs),
    version: APPROVAL_BINDING_VERSION,
  })
}

/**
 * 校验一次调用是否被这一行审批所覆盖。
 *
 * **顺序是有意的**：先看"这行绑了什么"，再看"这次调用是不是它"。
 * 反过来的话，一个没有哈希的行会先走到"操作比对"里，用一个重算出来的哈希
 * 与自己做比较——于是它**恒等**，于是它通过。那正是本模块要防的那件事。
 *
 * 返回对象形状固定，调用方不需要为"某一种拒绝"写第二条分支。
 */
export function verifyBinding({ row, operation, nowMs = Date.now() } = {}) {
  const deny = (code, userText) => Object.freeze({
    ok: false, code, userText, bindingHash: null, row: null,
  })
  if (row === null || row === undefined) {
    return deny(BINDING_CODES.NOT_FOUND, '找不到这条审批请求')
  }
  if (row.status === 'consumed') {
    return deny(BINDING_CODES.ALREADY_CONSUMED, '这条审批已经被用掉了（一次性批准只能用一次）')
  }
  if (row.status === 'expired') {
    return deny(BINDING_CODES.EXPIRED, '这条审批已经过期')
  }
  if (row.status !== 'approved') {
    return deny(BINDING_CODES.NOT_APPROVED, `这条审批还没被批准（当前状态：${row.status}）`)
  }
  // ★ 先看这一行到底绑了什么。
  const bound = row[BINDING_HASH_COLUMN]
  if (!isBoundHash(bound)) {
    return deny(
      BINDING_CODES.UNBOUND,
      '这条审批没有绑定哈希（多半是旧版本创建的），它绑定了什么无法确认——请重新发起一次审批',
    )
  }
  // 再算这次调用的哈希，与那一行比。
  let actual
  try {
    actual = computeBindingHash(operation)
  } catch (e) {
    return deny(BINDING_CODES.OPERATION_CHANGED, `这次调用的参数无法规范化：${e?.message ?? e}`)
  }
  if (actual !== bound.trim()) {
    return Object.freeze({
      ok: false,
      code: BINDING_CODES.OPERATION_CHANGED,
      userText: '这次调用的关键字段与批准时不一致，原批准不再适用',
      bindingHash: bound.trim(),
      actualHash: actual,
      row,
    })
  }
  // 最后才是时间。放在最后是因为前面的问题是"绑的东西对不对"，
  // 那是比"还来不来得及"更根本的问题——顺序反了会让一条**绑错了**的审批
  // 在过期检查上先被拒，于是日志里写的理由是"过期"，值班的人去查错了方向。
  const expiresAtMs = Number(row.expiresAtMs ?? row.expiresAt)
  if (Number.isFinite(expiresAtMs) && Number(nowMs) >= expiresAtMs) {
    return Object.freeze({
      ok: false,
      code: BINDING_CODES.EXPIRED,
      userText: '这条审批已经过期',
      bindingHash: bound.trim(),
      actualHash: actual,
      expiresAtMs,
      row,
    })
  }
  return Object.freeze({
    ok: true, code: null, userText: null, bindingHash: bound.trim(), actualHash: actual, row,
  })
}

/** 状态是否属于终态。 */
export function isTerminalApprovalState(state) {
  return TERMINAL_APPROVAL_STATES.includes(state)
}

/** 消费的结果。**只有两种**，而且两种都必须被调用方区别对待。 */
export const CONSUME_OUTCOMES = Object.freeze({
  CONSUMED: 'consumed',
  LOST_RACE: 'lost-race',
})

/**
 * 消费一次审批：`approved` + **哈希吻合** → `consumed`，原子。
 *
 * WHERE 里同时带 `status='approved'` 与哈希是两件不同的事：
 *
 *   · `status='approved'` 挡的是"这条已经被别人用掉了"
 *   · `bindingHash=?` 挡的是"这一行在我校验之后被换成了另一条绑定"
 *
 * 单条 UPDATE 在 SQLite 里本身就是原子的，所以这里不需要额外的事务包装。
 *
 * **单独导出**是为了让"没抢到"这条路径可以被**真的走到**：一个只能靠并发时序
 * 才能触发的分支，与一个不存在的分支，在"它到底拦不拦得住"上是同一个东西。
 */
export function consumeBinding({ db, requestId, bindingHash, consumedAtText, column = BINDING_HASH_COLUMN }) {
  const res = db
    .prepare(`UPDATE permission_requests SET status='consumed', consumedAt=? WHERE requestId=? AND status='approved' AND ${column}=?`)
    .run(consumedAtText, requestId, bindingHash)
  const changes = Number(res.changes)
  return Object.freeze({
    outcome: changes === 1 ? CONSUME_OUTCOMES.CONSUMED : CONSUME_OUTCOMES.LOST_RACE,
    changes,
  })
}

/**
 * 从数据库行取出的操作对象。解析失败时返回 `null`（调用方据此拒绝）。
 *
 * **不吞异常后继续**：一个"解析不出来就当空对象"的回退，会让一次损坏的审批
 * 变成一次对空操作的批准。
 */
export function operationOfRow(row) {
  if (row === null || row === undefined) return null
  const raw = row.operation
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    // 数组与 `null` 都不是"一次操作"：一次操作是一组**具名**字段。
    // 放一个数组过去，它会在 `normalizeOperation` 里因为取不到 scope 而抛，
    // 于是被归类成"参数变了"——把"这条审批坏了"说成了"你改了参数"。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 加载时自检：绑定哈希必须**就是** F-02 的指纹。
//
// 一个与 F-02 各算一份的绑定哈希，与一个"审批绑的东西和执行时看的东西不是同一个
// 东西"的绑定，是同一个东西——而两份实现今天行为一致这件事，没有任何东西在维持它。
//
// 刻意**不**导出一个布尔 `ok`：`ok: true` 是随手就能写出来的字面量。
// 导出的是**算出来的那个哈希**——想伪造它，就得把 F-02 的指纹算法再实现一遍。
// ---------------------------------------------------------------------------

const BINDING_SAMPLE = Object.freeze({
  scope: 'legion', actor: 'general', action: 'file:write', target: 'repo/notes.md',
  taskId: 'task-sample', unattended: false, metadata: { path: 'repo/notes.md', mode: 'rw' },
})

/**
 * 自检：绑定哈希与 F-02 的指纹必须是**同一个**。
 *
 * 做成带参数的函数，是为了让用例能喂一对**故意不一致**的哈希进来验它真的会拦。
 * 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形——
 * 只读模块级的两个值然后比一下，那条 `if` 就永远只在"已经出事了"的时候才跑。
 */
export function assertBindingHashShared(
  bindingHash = computeBindingHash(BINDING_SAMPLE),
  fingerprintHash = operationFingerprint(BINDING_SAMPLE),
) {
  if (bindingHash !== fingerprintHash) {
    throw new Error(
      '内部错误（PRT-608）：审批绑定哈希与 F-02 的 canonical operation 指纹不一致——'
      + `绑定的是 ${bindingHash}，F-02 认的是 ${fingerprintHash}`,
    )
  }
  return Object.freeze({ ok: true, bindingHash, fingerprintHash })
}

export const BINDING_HASH_CHECKED = Object.freeze({
  domain: OPERATION_DOMAIN,
  version: APPROVAL_BINDING_VERSION,
  ...assertBindingHashShared(),
})
