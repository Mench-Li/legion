// team-hub/budget-ledger.mjs
// ============================================================================
// 单次运行预算账本（PRT-503 / PRT-510 / PRT-511，spec §6.6 第 406 行）
//
// spec：「商业 Alpha 只承诺单次运行预算：运行前原子预留最大预算，运行中采集实际
// usage，达到硬上限时请求取消，终态后按实际使用结算并释放余额。若取消后结果未知，
// 预留保持锁定直到恢复或人工处置。」
//
// spec 第 408 行：「费用记录必须冻结 `priceTableVersion`、币种、模型计价单位、
// 生效时间和运行时估算结果。后续价格表更新不得重算历史 `usage_records`。
// 预算超限默认取消当前 Run 并将 Attempt 标为 `BUDGET_EXCEEDED`，
// 不得在未获用户批准时自动切换到更昂贵模型。」
//
// ── 这是全仓唯一一处"花的是真钱"的状态机 ──
//
// 它的每一个错误都比别的模块贵：预留漏了 → 超支；预留重复 → 余额被占两次；
// 结算两次 → 余额释放两次；锁定被结算 → 结果未知的那笔钱被当成已结清。
// 因此这里的设计原则是**宁可拒绝，不可猜**。
//
// ── 状态机（**全定义**，没有隐式分支）──
//
//      (无) ──reserve──▶ reserved
//     reserved ──overrun──▶ cancel-requested ──▶ cancelled ──settle──▶ settled
//     reserved ──settle(known)──▶ settled
//     reserved ──settle(unknown)──▶ locked
//     any ──settle(unknown)──▶ locked
//     locked ──resolve(人工处置)──▶ settled | cancelled
//
// 「状态必须全定义」在这里不是洁癖：一个未定义的状态会让下游的判断落进
// `else`，而 `else` 的默认行为通常是"当作正常继续"——对账本来说就是
// 把一笔结果未知的钱当成已结清。
//
// ── 五条判定 ──
//
//   ① **预留键是 attemptId。** 一次 Attempt 只能有一次预留。重复调用是幂等的
//      （重试预留是正常动作），但**参数不一致时拒绝**：悄悄接受意味着有人把
//      上限改了而没留下痕迹。上限是可以被改的——但不能"顺便"被改。
//
//   ② **结算只认冻结的价目表版本。** 结算时按预留时冻结的 `priceTableVersion`
//      去取那张表；**取不到就拒绝结算**，不用现价重算。用现价重算会让历史费用
//      在无人察觉的情况下变化——spec 明确禁止。
//
//   ③ **结果未知 → locked，不结算。** 取消后不知道是否真的停下了，那笔预留
//      必须保持锁定。结算它等于把"不知道"变成"已经算清了"。
//      `locked` 只能由**恢复**或**人工处置**解开。
//
//   ④ **超支如实报出，不裁剪。** 实际用量超过预留时 `overrunAmount` 是正数，
//      并且**仍然可以结算**——超支已经发生了，拒绝结算只会让账本与事实脱节。
//      裁剪成 0 更糟：它把一次超支变成一次"刚好花满"。
//
//   ⑤ **没有预算 = 显式的 `unbounded`。** 未配置预算时不建预留，并把
//      `budgetState: 'unbounded'` 如实返回。不建预留这件事必须**可见**，
//      否则"没配预算"和"预算闸门在工作"从外面看是一样的。
// ============================================================================

import { PriceError, createPriceTable, estimateCost, frozenEstimate, canSwitchModel } from '../runtime/contracts/price-table.mjs'

/** 账本层的具名错误码。 */
export const BUDGET_ERRORS = Object.freeze({
  ATTEMPT_REQUIRED: 'ATTEMPT_REQUIRED',
  RESERVATION_EXISTS: 'RESERVATION_EXISTS',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  BUDGET_REQUIRED: 'BUDGET_REQUIRED',
  BUDGET_INVALID: 'BUDGET_INVALID',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  PRICE_TABLE_GONE: 'PRICE_TABLE_GONE',
  PRICE_TABLE_INVALID: 'PRICE_TABLE_INVALID',
  PRICE_TABLE_IMMUTABLE: 'PRICE_TABLE_IMMUTABLE',
  ALREADY_SETTLED: 'ALREADY_SETTLED',
  RESERVATION_LOCKED: 'RESERVATION_LOCKED',
  OUTCOME_REQUIRED: 'OUTCOME_REQUIRED',
  ACTOR_REQUIRED: 'ACTOR_REQUIRED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  MORE_EXPENSIVE_NEEDS_APPROVAL: 'MORE_EXPENSIVE_NEEDS_APPROVAL',
})

export class BudgetError extends Error {
  constructor(code, message, { statusCode = 400, ...extra } = {}) {
    super(message)
    this.name = 'BudgetError'
    this.code = code
    this.statusCode = statusCode
    Object.assign(this, extra)
  }
}

/** 预留的状态。**封闭集合**：新增必须显式登记，且必须给出转移。 */
export const RESERVATION_STATES = Object.freeze([
  'reserved',          // 已预留最大预算，运行中
  'cancel-requested',  // 达到硬上限，已请求取消，等终态
  'cancelled',         // 已取消，尚未结算
  'settled',           // 已按实际用量结算，余额释放
  'locked',            // 取消后结果未知，预留**保持锁定**
])

/** 终态：不再有余额被占用（`locked` **不是**终态——它仍然占着钱）。 */
export const SETTLED_STATES = Object.freeze(['settled'])

/** 占用余额的状态（决定 `heldAmount`）。 */
export const HOLDING_STATES = Object.freeze(['reserved', 'cancel-requested', 'cancelled', 'locked'])

/**
 * 合法转移表。
 *
 * `Object.freeze` 的**全定义**映射：每个状态都要有键，哪怕是空数组。
 * 缺键会让 `TRANSITIONS[x]` 是 `undefined`，于是 `.includes()` 抛异常——
 * 而那会被当成代码缺陷，掩盖"这个状态我根本没想过"。
 */
export const RESERVATION_TRANSITIONS = Object.freeze({
  reserved: Object.freeze(['cancel-requested', 'cancelled', 'settled', 'locked']),
  'cancel-requested': Object.freeze(['cancelled', 'settled', 'locked']),
  cancelled: Object.freeze(['settled', 'locked']),
  locked: Object.freeze(['settled', 'cancelled']),   // 只能由恢复/人工处置到达
  settled: Object.freeze([]),                        // 终态
})

/** 一次结算没有确定结果时的原因（`settle` 会转入 `locked`）。 */
export const OUTCOME_KINDS = Object.freeze(['known', 'unknown'])

export function ensureBudgetSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_reservations (
      attempt_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      task_id TEXT NOT NULL,
      model_profile_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_unit TEXT NOT NULL,
      price_table_version TEXT NOT NULL,
      effective_at_ms INTEGER NOT NULL,
      reserved_amount REAL NOT NULL,
      spent_amount REAL,
      overrun_amount REAL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      cancel_requested_at_ms INTEGER,
      cancel_reason TEXT,
      settled_at_ms INTEGER,
      settled_by TEXT,
      lock_reason TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      task_id TEXT NOT NULL,
      model_profile_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_unit TEXT,
      price_table_version TEXT NOT NULL,
      effective_at_ms INTEGER NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      estimated_amount REAL,
      actual_amount REAL,
      estimate_ok INTEGER NOT NULL,
      estimate_reason TEXT,
      runtime_estimate_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `)
  // 同一 Attempt 的历史用量是**追加**的：改价目表不改这些行（PRT-511）。
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_records_attempt ON usage_records(attempt_id, id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_budget_reservations_hold ON budget_reservations(state, scope)')
  // 价目表按**版本**存，且版本**不可覆盖**（PRT-511）。
  // 这是"后续价格表更新不得重算历史 usage_records"的结构性保证：
  // 不是"大家记得别改 v1"，而是 v1 改不了——要涨价就发布 v2。
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_tables (
      version TEXT PRIMARY KEY,
      currency TEXT NOT NULL,
      effective_at_ms INTEGER NOT NULL,
      models_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      created_by TEXT NOT NULL
    )
  `)
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

function assertTransition(from, to) {
  const allowed = RESERVATION_TRANSITIONS[from]
  if (allowed === undefined) {
    throw new BudgetError(BUDGET_ERRORS.ILLEGAL_TRANSITION,
      `未知的预留状态 ${from}：状态集合是封闭的，出现未登记的状态说明有代码路径绕过了账本`,
      { statusCode: 500 })
  }
  if (!allowed.includes(to)) {
    throw new BudgetError(BUDGET_ERRORS.ILLEGAL_TRANSITION,
      `不允许的状态转移：${from} → ${to}（${from} 只能转到 ${allowed.join(' / ') || '（终态，不能转出）'}）`,
      { statusCode: 409, from, to })
  }
}

function rowToReservation(r) {
  if (r === undefined || r === null) return null
  return Object.freeze({
    attemptId: r.attempt_id,
    scope: r.scope,
    taskId: r.task_id,
    modelProfileId: r.model_profile_id,
    currency: r.currency,
    billingUnit: r.billing_unit,
    priceTableVersion: r.price_table_version,
    effectiveAtMs: Number(r.effective_at_ms),
    reservedAmount: Number(r.reserved_amount),
    spentAmount: r.spent_amount === null ? null : Number(r.spent_amount),
    overrunAmount: r.overrun_amount === null ? null : Number(r.overrun_amount),
    state: r.state,
    holding: HOLDING_STATES.includes(r.state),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    cancelRequestedAtMs: r.cancel_requested_at_ms === null ? null : Number(r.cancel_requested_at_ms),
    cancelReason: r.cancel_reason ?? null,
    settledAtMs: r.settled_at_ms === null ? null : Number(r.settled_at_ms),
    settledBy: r.settled_by ?? null,
    lockReason: r.lock_reason ?? null,
  })
}

/**
 * 价目表登记处：版本**只增不改**。
 *
 * `publish` 遇到已存在的版本会**拒绝**而不是覆盖。这条是 PRT-511 的核心：
 * 「后续价格表更新不得重算历史 usage_records」如果靠"记得别改"，它的失效方式
 * 是静默的（某天为了让报表更准而就地改价，于是历史费用全变了且无任何报错）。
 * 拒绝覆盖之后，"改价"这个动作在类型上只能是"发布一个新版本"——
 * 而历史记录引用的是旧版本，它们不会变。
 */
export function createPriceTableRegistry({ db, clock = () => Date.now(), writeAudit = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createPriceTableRegistry 需要 db')
  ensureBudgetSchema(db)

  const get = (version) => {
    if (!isNonEmptyString(version)) return null
    const row = db.prepare('SELECT * FROM price_tables WHERE version = ?').get(version.trim())
    if (row === undefined) return null
    let models
    try {
      models = JSON.parse(row.models_json)
    } catch {
      // 坏掉的**数据** → 当作这个版本取不到。结算会因此拒绝，
      // 而不是拿一张残缺的表去算钱。
      return null
    }
    // 这一步刻意**只吞数据错**，不吞代码错。
    //
    // `PriceError` = 存进去的数据不合法（比如少了 billingUnit）→ 当作这个版本
    // 取不到，结算会因此拒绝，而不是拿一张残缺的表去算钱。
    //
    // 其它异常（`ReferenceError` / `TypeError`…）= **代码缺陷**。这个模块真的
    // 犯过一次：忘了 import `createPriceTable`，而当时的 `catch { return null }`
    // 把 `ReferenceError` 吞成了"版本不存在"，于是 `settle` 报 `PRICE_TABLE_GONE`
    // ——运维会去查价目表，而真实原因是一行没写的 import。
    // 把两者一律吞掉，等于让代码缺陷伪装成数据问题。
    try {
      return createPriceTable({
        version: row.version,
        currency: row.currency,
        effectiveAtMs: Number(row.effective_at_ms),
        models,
      })
    } catch (e) {
      if (e instanceof PriceError) return null
      throw e
    }
  }

  function publish(table, { actor } = {}) {
    if (!isNonEmptyString(actor)) {
      throw new BudgetError(BUDGET_ERRORS.ACTOR_REQUIRED, '缺少 actor：谁发布的价目表必须留痕')
    }
    if (!isPriceTableLike(table)) {
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_INVALID,
        'publish 需要 createPriceTable 的产物', { statusCode: 400 })
    }
    // 存在性检查必须**直接看行**，不能用 `get()`。
    //
    // `get()` 把"没有这一行"与"这一行的 JSON 坏了"都返回 `null`。用它做
    // 不可覆盖检查的后果是：**先把 v1 的 models_json 弄坏，就能用 publish
    // 覆盖 v1** —— 而 v1 正是历史费用记录引用的那一版。于是"版本只增不改"
    // 这条保证可以被一次数据损坏绕过，而绕过之后历史记录对着另一个价格算。
    //
    // 这是"用有损视图做存在性判断"这一类错误的又一个实例：判断"有没有"
    // 必须问"有没有"，不能问"能不能读出来"。
    if (db.prepare('SELECT 1 AS x FROM price_tables WHERE version = ?').get(table.version) !== undefined) {
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_IMMUTABLE,
        `价目表版本 ${table.version} 已存在：版本只增不改。` +
        '要改价请发布一个新版本——就地改价会让引用旧版本的历史费用记录在无人察觉时变化',
        { statusCode: 409, version: table.version })
    }
    db.prepare(
      'INSERT INTO price_tables (version, currency, effective_at_ms, models_json, created_at_ms, created_by) VALUES (?,?,?,?,?,?)',
    ).run(table.version, table.currency, table.effectiveAtMs, JSON.stringify(table.models), clock(), actor.trim())
    const saved = get(table.version)
    if (saved === null) {
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_INVALID,
        '价目表写入后复读失败：保存没有生效', { statusCode: 500 })
    }
    if (typeof writeAudit === 'function') {
      writeAudit({
        action: 'budget.price-table-published',
        detail: { version: table.version, currency: table.currency, models: Object.keys(table.models), actor: actor.trim() },
      })
    }
    return saved
  }

  const list = () => Object.freeze(
    db.prepare('SELECT version, currency, effective_at_ms, created_at_ms, created_by FROM price_tables ORDER BY effective_at_ms, version')
      .all()
      .map((r) => Object.freeze({
        version: r.version, currency: r.currency,
        effectiveAtMs: Number(r.effective_at_ms),
        createdAtMs: Number(r.created_at_ms), createdBy: r.created_by,
      })),
  )

  return Object.freeze({ get, publish, list })
}

const isPriceTableLike = (t) => t !== null && typeof t === 'object' &&
  isNonEmptyString(t.version) && isNonEmptyString(t.currency) &&
  typeof t.effectiveAtMs === 'number' && t.models !== null && typeof t.models === 'object'

/**
 * 建预算账本。
 *
 * @param {object} args
 * @param {import('node:sqlite').DatabaseSync} args.db
 * @param {() => number} [args.clock]
 * @param {(payload: object) => void} [args.writeAudit]  审计写入器（只收非敏感事实）
 * @param {(version: string) => object|null} [args.priceTableFor]
 *        按版本取价目表。**取不到返回 `null`** —— 结算会拒绝，而不是用现价重算。
 */
export function createBudgetLedger({ db, clock = () => Date.now(), writeAudit = null, priceTableFor = null } = {}) {
  if (db === undefined || db === null) throw new TypeError('createBudgetLedger 需要 db')
  if (typeof clock !== 'function') throw new TypeError('createBudgetLedger 的 clock 必须是函数')
  if (typeof priceTableFor !== 'function') {
    throw new TypeError('createBudgetLedger 需要 priceTableFor：没有价目表来源时' +
      '结算只能按现价重算，而 spec 明确禁止重算历史费用')
  }
  ensureBudgetSchema(db)

  function audit(payload) {
    if (typeof writeAudit === 'function') writeAudit(payload)
  }

  const get = (attemptId) => {
    if (!isNonEmptyString(attemptId)) {
      throw new BudgetError(BUDGET_ERRORS.ATTEMPT_REQUIRED, '缺少 attemptId：账本的键是一次 Attempt')
    }
    return rowToReservation(
      db.prepare('SELECT * FROM budget_reservations WHERE attempt_id = ?').get(attemptId.trim()),
    )
  }

  /**
   * 运行前**原子预留**最大预算。
   *
   * "原子"的具体含义：同一个 `attemptId` 的预留由主键唯一确定，插入与读回在
   * 同一个事务里完成，因此两个进程同时预留同一个 Attempt 时，**结果必然一致**
   * ——要么都拿到同一行，要么其中一个因为参数不同而被拒。
   *
   * 幂等规则：`attemptId` 相同且**参数一致** → 返回已有预留（重试预留是正常动作）；
   * 参数不一致 → 拒绝。上限可以被改，但不能"顺便"被改。
   *
   * @returns {{reservation: object|null, budgetState: 'reserved'|'unbounded'}}
   */
  function reserve({ attemptId, scope, taskId, modelProfileId, budget, priceTable, tokensIn, tokensOut } = {}) {
    if (!isNonEmptyString(attemptId)) {
      throw new BudgetError(BUDGET_ERRORS.ATTEMPT_REQUIRED, '缺少 attemptId：账本的键是一次 Attempt')
    }
    const id = attemptId.trim()

    // ── 没有预算 = 显式的 unbounded（见模块头 ⑤）──
    if (budget === null || budget === undefined) {
      const existing = get(id)
      if (existing !== null) {
        throw new BudgetError(BUDGET_ERRORS.RESERVATION_EXISTS,
          `Attempt ${id} 已经有预留（${existing.state}），但本次调用的 budget 为空：` +
          '不能把一次已预留的运行重新声明成"没有预算"——那会静默解除上限', { statusCode: 409 })
      }
      audit({ action: 'budget.unbounded', attemptId: id, scope, taskId, detail: {} })
      return Object.freeze({ reservation: null, budgetState: 'unbounded' })
    }
    if (typeof budget !== 'object' || Array.isArray(budget)) {
      throw new BudgetError(BUDGET_ERRORS.BUDGET_INVALID, 'budget 必须是对象')
    }
    const currency = isNonEmptyString(budget.currency) ? budget.currency.trim() : null
    const maxCost = typeof budget.maxCost === 'number' && Number.isFinite(budget.maxCost) && budget.maxCost > 0
      ? budget.maxCost : null
    if (currency === null || maxCost === null) {
      // 形态校验本已在 PRT-502 的 validatePerRunBudget 做过。这里再挡一次不是冗余：
      // 账本是"钱"的那一层，它不能依赖上游一定校验过。
      throw new BudgetError(BUDGET_ERRORS.BUDGET_INVALID,
        `budget 必须同时给出正的 maxCost 与非空 currency（收到 maxCost=${JSON.stringify(budget.maxCost)}, currency=${JSON.stringify(budget.currency)}）：` +
        '金额脱离币种不构成上限')
    }
    if (!isNonEmptyString(modelProfileId)) {
      throw new BudgetError(BUDGET_ERRORS.BUDGET_INVALID,
        '缺少 modelProfileId：费用记录必须能回答"这笔钱花在哪个模型上"')
    }

    // 预留的金额是**最大预算**，不是估算值：估算值只是当次的预期，
    // 预留必须覆盖最坏情况，否则"预留成功"不构成任何保证。
    const frozen = frozenEstimate(estimateCost({ priceTable, model: modelProfileId, tokensIn, tokensOut }))
    if (priceTable.currency !== currency) {
      throw new BudgetError(BUDGET_ERRORS.CURRENCY_MISMATCH,
        `预算币种 ${currency} 与价目表币种 ${priceTable.currency} 不一致：` +
        '不同币种的金额无法比较，预算判定会给出无意义的结论')
    }

    const nowMs = clock()
    // BEGIN IMMEDIATE：先拿写锁再读，避免"两个进程都读到没有预留"。
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = rowToReservation(
        db.prepare('SELECT * FROM budget_reservations WHERE attempt_id = ?').get(id),
      )
      if (existing !== null) {
        // 幂等要求**参数一致**。不一致时拒绝：上限可以被改，但不能顺便被改。
        const same = existing.reservedAmount === maxCost &&
          existing.currency === currency &&
          existing.modelProfileId === modelProfileId
        if (!same) {
          throw new BudgetError(BUDGET_ERRORS.RESERVATION_EXISTS,
            `Attempt ${id} 已有预留（${existing.reservedAmount} ${existing.currency} / ${existing.modelProfileId}），` +
            `本次请求是 ${maxCost} ${currency} / ${modelProfileId}：` +
            '预留上限可以被修改，但必须是一次显式动作，不能靠重新预留悄悄替换', {
            statusCode: 409, attemptId: id, existing: {
              reservedAmount: existing.reservedAmount, currency: existing.currency,
              modelProfileId: existing.modelProfileId, state: existing.state,
            },
          })
        }
        db.exec('COMMIT')
        return Object.freeze({ reservation: existing, budgetState: 'reserved' })
      }
      db.prepare(
        `INSERT INTO budget_reservations
          (attempt_id, scope, task_id, model_profile_id, currency, billing_unit,
           price_table_version, effective_at_ms, reserved_amount, state,
           created_at_ms, updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, scope ?? '*', taskId ?? '', modelProfileId.trim(), currency,
        frozen.billingUnit ?? 'unpriced',
        frozen.priceTableVersion, frozen.effectiveAtMs, maxCost, 'reserved', nowMs, nowMs,
      )
      // 预留时就把"运行时估算结果"落一条 usage_record：事后要能回答
      // "当时估的是多少"，而不是拿现在的用量倒推。
      insertUsage({
        attemptId: id, scope: scope ?? '*', taskId: taskId ?? '', modelProfileId: modelProfileId.trim(),
        currency, frozen, tokensIn, tokensOut, actualAmount: null, nowMs,
      })
      const created = rowToReservation(
        db.prepare('SELECT * FROM budget_reservations WHERE attempt_id = ?').get(id),
      )
      db.exec('COMMIT')
      audit({
        action: 'budget.reserve', attemptId: id, scope, taskId,
        detail: { reservedAmount: maxCost, currency, modelProfileId, priceTableVersion: frozen.priceTableVersion },
      })
      return Object.freeze({ reservation: created, budgetState: 'reserved' })
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 事务已结束 */ }
      throw e
    }
  }

  function insertUsage({ attemptId, scope, taskId, modelProfileId, currency, frozen, tokensIn, tokensOut, actualAmount, nowMs }) {
    db.prepare(
      `INSERT INTO usage_records
        (attempt_id, scope, task_id, model_profile_id, currency, billing_unit,
         price_table_version, effective_at_ms, tokens_in, tokens_out,
         estimated_amount, actual_amount, estimate_ok, estimate_reason,
         runtime_estimate_json, created_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attemptId, scope, taskId, modelProfileId, currency, frozen.billingUnit,
      frozen.priceTableVersion, frozen.effectiveAtMs,
      frozen.tokensIn, frozen.tokensOut,
      frozen.amount, actualAmount,
      frozen.ok ? 1 : 0, frozen.reason,
      JSON.stringify(frozen), nowMs,
    )
  }

  /**
   * 运行中采集一次实际 usage 并检查硬上限。
   *
   * 达到上限时**请求取消**并返回 `{ cancel: true, kind: 'budget-exceeded' }`，
   * 由调用方去真的取消 Run 并把 Attempt 标为 `BUDGET_EXCEEDED`。
   * 账本不自己取消：它不知道 Run 的生命周期，而"以为取消已经发出去了"
   * 是最坏的一种错觉。
   */
  function observe({ attemptId, tokensIn, tokensOut, modelProfileId } = {}) {
    const r = get(attemptId)
    if (r === null) {
      throw new BudgetError(BUDGET_ERRORS.RESERVATION_NOT_FOUND,
        `Attempt ${attemptId} 没有预算预留：未预留就开始采集用量，说明这条路径绕过了账本`,
        { statusCode: 409 })
    }
    if (r.state === 'settled') {
      throw new BudgetError(BUDGET_ERRORS.ALREADY_SETTLED,
        `Attempt ${attemptId} 已结算（${r.spentAmount} ${r.currency}），不能再采集用量：` +
        '结算后追加用量会让账本与已释放的余额脱节', { statusCode: 409 })
    }
    const table = priceTableFor(r.priceTableVersion)
    if (table === null) {
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_GONE,
        `价目表 ${r.priceTableVersion} 已取不到，无法为 Attempt ${attemptId} 估算用量：` +
        '不得改用现价重算——那会让这笔费用在事后变成另一个数字', { statusCode: 409 })
    }
    const est = estimateCost({ priceTable: table, model: modelProfileId ?? r.modelProfileId, tokensIn, tokensOut })
    // 用累计量判上限：本方法是**累计快照**语义，不是增量。
    const exceeded = est.ok ? est.amount > r.reservedAmount : false
    const nowMs = clock()
    if (exceeded && r.state === 'reserved') {
      assertTransition(r.state, 'cancel-requested')
      db.prepare(
        `UPDATE budget_reservations SET state = 'cancel-requested', cancel_requested_at_ms = ?,
           cancel_reason = ?, updated_at_ms = ? WHERE attempt_id = ? AND state = 'reserved'`,
      ).run(nowMs, `budget-exceeded:${est.amount}>${r.reservedAmount}`, nowMs, r.attemptId)
      audit({
        action: 'budget.cancel-requested', attemptId: r.attemptId, scope: r.scope, taskId: r.taskId,
        detail: { used: est.amount, limit: r.reservedAmount, currency: r.currency },
      })
      return Object.freeze({
        cancel: true, kind: 'budget-exceeded',
        used: est.amount, limit: r.reservedAmount, currency: r.currency,
        message: `实际用量 ${est.amount} ${r.currency} 超出预留上限 ${r.reservedAmount}：` +
          '已请求取消当前 Run（Attempt 应标为 BUDGET_EXCEEDED）；' +
          '不得在未获用户批准时自动切换到更昂贵模型',
        reservation: get(r.attemptId),
      })
    }
    // 未超（或费用未知）：如实返回。费用未知时**不能**当成未超——
    // 那等于把"不知道"当成"没超"。
    return Object.freeze({
      cancel: false, kind: exceeded ? 'budget-exceeded' : (est.ok ? null : 'cost-unknown'),
      used: est.ok ? est.amount : null, limit: r.reservedAmount, currency: r.currency,
      message: est.ok ? '' : `费用未知（${est.reason}）：${est.message}`,
      reservation: r,
      estimateOk: est.ok,
    })
  }

  /**
   * 终态结算：按**冻结的**价目表版本算实际费用，释放余额。
   *
   * `outcome: 'unknown'` 时**不结算**，转入 `locked`（见模块头 ③）。
   *
   * 超支**仍然结算**（见模块头 ④）：超支已经发生了，拒绝结算只会让账本与事实
   * 脱节。差额记在 `overrunAmount` 里，可见。
   */
  function settle({ attemptId, tokensIn, tokensOut, outcome, actor, modelProfileId, reason } = {}) {
    if (!isNonEmptyString(actor)) {
      throw new BudgetError(BUDGET_ERRORS.ACTOR_REQUIRED, '缺少 actor：谁结算的必须留痕')
    }
    if (!OUTCOME_KINDS.includes(outcome)) {
      throw new BudgetError(BUDGET_ERRORS.OUTCOME_REQUIRED,
        `结算必须显式给出 outcome（${OUTCOME_KINDS.join(' / ')}），收到 ${JSON.stringify(outcome)}：` +
        '不给出时无法区分"已确认用量"与"结果未知"，而这两者的账务处理完全相反')
    }
    const r = get(attemptId)
    if (r === null) {
      throw new BudgetError(BUDGET_ERRORS.RESERVATION_NOT_FOUND,
        `Attempt ${attemptId} 没有预算预留`, { statusCode: 404 })
    }
    if (r.state === 'settled') {
      // 二次结算会**把余额释放两次**。
      throw new BudgetError(BUDGET_ERRORS.ALREADY_SETTLED,
        `Attempt ${attemptId} 已结算（${r.spentAmount} ${r.currency}，于 ${r.settledAtMs}）：` +
        '重复结算会重复释放余额', { statusCode: 409 })
    }
    const nowMs = clock()

    // ── 已锁定 → 拒绝（锁定的钱只能走显式处置，见 resolveLocked）──
    if (r.state === 'locked') {
      throw new BudgetError(BUDGET_ERRORS.RESERVATION_LOCKED,
        `Attempt ${attemptId} 的预留处于 locked（原因：${r.lockReason ?? '未知'}）：` +
        '取消后结果未知的预留必须保持锁定，直到**恢复或人工处置**；' +
        '直接调结算接口会把它当成已算清，而事实是不知道', {
        statusCode: 409, state: 'locked', lockReason: r.lockReason ?? null,
      })
    }

    // ── 结果未知 → 锁定，不结算 ──
    if (outcome === 'unknown') {
      assertTransition(r.state, 'locked')
      db.prepare(
        `UPDATE budget_reservations SET state = 'locked', lock_reason = ?, updated_at_ms = ?
         WHERE attempt_id = ?`,
      ).run(reason ?? 'outcome-unknown', nowMs, r.attemptId)
      audit({
        action: 'budget.lock', attemptId: r.attemptId, scope: r.scope, taskId: r.taskId,
        detail: { reason: reason ?? 'outcome-unknown', reservedAmount: r.reservedAmount, currency: r.currency },
      })
      return Object.freeze({ reservation: get(r.attemptId), locked: true, alreadyLocked: false })
    }

    // ── 已确认 → 按冻结的价目表版本算实际费用 ──
    const table = priceTableFor(r.priceTableVersion)
    if (table === null) {
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_GONE,
        `价目表 ${r.priceTableVersion}（生效于 ${r.effectiveAtMs}）已取不到，无法结算 Attempt ${attemptId}：` +
        '**不得改用现价重算**——spec 明确禁止后续价格表更新重算历史 usage_records；' +
        '请恢复该版本价目表或走人工处置', { statusCode: 409, priceTableVersion: r.priceTableVersion })
    }
    const est = estimateCost({ priceTable: table, model: modelProfileId ?? r.modelProfileId, tokensIn, tokensOut })
    if (!est.ok) {
      // 算不出实际费用时**不能**结算成 0：那会把"不知道花了多少"变成一笔免费运行。
      throw new BudgetError(BUDGET_ERRORS.PRICE_TABLE_GONE,
        `无法算出 Attempt ${attemptId} 的实际费用（${est.reason}）：${est.message}；` +
        '不得结算成 0——那会把"不知道花了多少"变成一笔免费运行', { statusCode: 409 })
    }
    const overrun = Math.max(0, est.amount - r.reservedAmount)
    assertTransition(r.state, 'settled')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `UPDATE budget_reservations SET state = 'settled', spent_amount = ?, overrun_amount = ?,
           settled_at_ms = ?, settled_by = ?, updated_at_ms = ? WHERE attempt_id = ?`,
      ).run(est.amount, overrun, nowMs, actor.trim(), nowMs, r.attemptId)
      insertUsage({
        attemptId: r.attemptId, scope: r.scope, taskId: r.taskId,
        modelProfileId: (modelProfileId ?? r.modelProfileId).trim(),
        currency: r.currency, frozen: frozenEstimate(est),
        tokensIn, tokensOut, actualAmount: est.amount, nowMs,
      })
      const done = get(r.attemptId)
      db.exec('COMMIT')
      audit({
        action: 'budget.settle', attemptId: r.attemptId, scope: r.scope, taskId: r.taskId,
        detail: {
          spent: est.amount, reserved: r.reservedAmount, overrun, currency: r.currency,
          priceTableVersion: r.priceTableVersion, actor: actor.trim(),
        },
      })
      return Object.freeze({ reservation: done, locked: false, overrun })
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 事务已结束 */ }
      throw e
    }
  }

  /**
   * 人工处置 / 恢复：把 `locked` 的预留解开。
   *
   * 这是 `locked` 唯一的出口。要求显式的 `disposition`
   * （`settle` 或 `release`）与 `actor`：一笔锁定中的钱不能靠"再跑一次"
   * 自动变成结清。
   */
  function resolveLocked({ attemptId, disposition, actor, tokensIn, tokensOut, reason } = {}) {
    if (!isNonEmptyString(actor)) {
      throw new BudgetError(BUDGET_ERRORS.ACTOR_REQUIRED, '缺少 actor：人工处置必须留痕')
    }
    const r = get(attemptId)
    if (r === null) {
      throw new BudgetError(BUDGET_ERRORS.RESERVATION_NOT_FOUND, `Attempt ${attemptId} 没有预算预留`, { statusCode: 404 })
    }
    if (r.state !== 'locked') {
      throw new BudgetError(BUDGET_ERRORS.RESERVATION_LOCKED,
        `Attempt ${attemptId} 的状态是 ${r.state}，不是 locked：人工处置只用于解开锁定的预留，` +
        '对其它状态调用它说明调用方对当前状态的理解是错的', {
        statusCode: 409, state: r.state,
      })
    }
    const nowMs = clock()
    if (disposition === 'release') {
      // 人工判定"这笔没花出去"：按 0 结算并释放。必须记下是谁判的。
      assertTransition('locked', 'settled')
      db.prepare(
        `UPDATE budget_reservations SET state = 'settled', spent_amount = 0, overrun_amount = 0,
           settled_at_ms = ?, settled_by = ?, lock_reason = ?, updated_at_ms = ?
         WHERE attempt_id = ?`,
      ).run(nowMs, actor.trim(), `human-release:${reason ?? ''}`, nowMs, r.attemptId)
      audit({
        action: 'budget.human-release', attemptId: r.attemptId, scope: r.scope, taskId: r.taskId,
        detail: { actor: actor.trim(), reason: reason ?? null, reservedAmount: r.reservedAmount },
      })
      return Object.freeze({ reservation: get(r.attemptId), disposition: 'release' })
    }
    if (disposition === 'settle') {
      // 人工给出实际用量后按正常路径结算。
      db.prepare("UPDATE budget_reservations SET state = 'cancelled', updated_at_ms = ? WHERE attempt_id = ?")
        .run(nowMs, r.attemptId)
      return Object.freeze({
        reservation: settle({ attemptId, tokensIn, tokensOut, outcome: 'known', actor, reason }),
        disposition: 'settle',
      })
    }
    throw new BudgetError(BUDGET_ERRORS.OUTCOME_REQUIRED,
      `人工处置必须显式给出 disposition（release / settle），收到 ${JSON.stringify(disposition)}`)
  }

  /** 某个 scope 当前**被占住**的余额（含 locked——锁定的钱仍然占着）。 */
  function heldAmount(scope = null) {
    const rows = scope === null
      ? db.prepare('SELECT currency, SUM(reserved_amount) AS held FROM budget_reservations WHERE state IN (?,?,?,?) GROUP BY currency')
        .all(...HOLDING_STATES)
      : db.prepare('SELECT currency, SUM(reserved_amount) AS held FROM budget_reservations WHERE scope = ? AND state IN (?,?,?,?) GROUP BY currency')
        .all(scope, ...HOLDING_STATES)
    return Object.freeze(rows.map((r) => Object.freeze({ currency: r.currency, held: Number(r.held) })))
  }

  /** 按 Attempt 列出追加式的用量历史（改价目表不改这些行）。 */
  function usageOf(attemptId) {
    return Object.freeze(
      db.prepare('SELECT * FROM usage_records WHERE attempt_id = ? ORDER BY id').all(attemptId)
        .map((r) => Object.freeze({
          id: Number(r.id),
          attemptId: r.attempt_id,
          modelProfileId: r.model_profile_id,
          currency: r.currency,
          billingUnit: r.billing_unit,
          priceTableVersion: r.price_table_version,
          effectiveAtMs: Number(r.effective_at_ms),
          tokensIn: r.tokens_in === null ? null : Number(r.tokens_in),
          tokensOut: r.tokens_out === null ? null : Number(r.tokens_out),
          estimatedAmount: r.estimated_amount === null ? null : Number(r.estimated_amount),
          actualAmount: r.actual_amount === null ? null : Number(r.actual_amount),
          estimateOk: Number(r.estimate_ok) === 1,
          estimateReason: r.estimate_reason ?? null,
        })),
    )
  }

  function list({ scope = null, state = null } = {}) {
    const clauses = []
    const args = []
    if (scope !== null) { clauses.push('scope = ?'); args.push(scope) }
    if (state !== null) { clauses.push('state = ?'); args.push(state) }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    return Object.freeze(
      db.prepare(`SELECT * FROM budget_reservations${where} ORDER BY created_at_ms, attempt_id`).all(...args)
        .map(rowToReservation),
    )
  }

  /**
   * 检查一次 fallback 切换是否允许（spec 第 408 行第二句）。
   *
   * 委托给 `price-table.mjs` 的 `canSwitchModel`，但**在账本这一层**
   * 也记一条审计：换模型是花钱的动作，它必须留痕。
   */
  function maySwitchModel({ from, to, priceTable, tokensIn, tokensOut, approved = false } = {}) {
    const d = canSwitchModel({ priceTable, from, to, tokensIn, tokensOut, approved })
    audit({
      action: d.allowed ? 'budget.model-switch-allowed' : 'budget.model-switch-refused',
      detail: {
        from, to, code: d.code,
        fromAmount: d.fromAmount, toAmount: d.toAmount, currency: d.currency,
      },
    })
    if (!d.allowed) {
      // 错误码用**决策自己的码**（PRICE_UNKNOWN / MORE_EXPENSIVE_NEEDS_APPROVAL），
      // 而不是笼统的账本码：调用方需要区分"太贵了等着批准"与"根本没定价"，
      // 因为前者等批准，后者要去补价目表。
      throw new BudgetError(d.code, d.message, {
        statusCode: 409, fromAmount: d.fromAmount, toAmount: d.toAmount, currency: d.currency,
      })
    }
    return d
  }

  return Object.freeze({
    reserve, observe, settle, resolveLocked, heldAmount, usageOf, list, get, maySwitchModel,
  })
}
