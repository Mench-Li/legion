// team-hub/budget-ledger.test.mjs
// ============================================================================
// 单次运行预算账本（PRT-503 / PRT-510 / PRT-511）的用例
//
// 这是全仓唯一一处"花的是真钱"的状态机，因此这一组的重点**全部是拒绝与锁定**：
//
//   ① 预留键是 attemptId，重复预留幂等，但**参数不一致必须拒绝**
//      （上限可以被改，但不能"顺便"被改）；
//   ② 结算只认**冻结的**价目表版本，取不到就拒绝，不用现价重算；
//   ③ 结果未知 → locked，**不结算**；locked 只能由恢复/人工处置解开；
//   ④ 超支**如实报出，不裁剪**，而且仍然可以结算；
//   ⑤ 没有预算 = 显式的 unbounded（"没配预算"必须可见）。
//
// 另外两条：二次结算必须拒绝（否则余额被释放两次），
// 以及达到硬上限时返回 cancel 请求而不是自己取消。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { createPriceTable, estimateCost } from '../runtime/contracts/price-table.mjs'
import {
  BUDGET_ERRORS,
  BudgetError,
  HOLDING_STATES,
  OUTCOME_KINDS,
  RESERVATION_STATES,
  RESERVATION_TRANSITIONS,
  createBudgetLedger,
  createPriceTableRegistry,
  ensureBudgetSchema,
} from './budget-ledger.mjs'

const TABLE = createPriceTable({
  version: 'pt-A',
  currency: 'USD',
  effectiveAtMs: 1_700_000_000_000,
  models: {
    cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 },
    dear: { billingUnit: 'per-mtok', perUnit: 10, unitSize: 1_000_000 },
  },
})

const TOK = { tokensIn: 500_000, tokensOut: 500_000 }  // cheap 上是 1 USD

let tick = 1_700_000_000_000
const clock = () => (tick += 1000)

function makeEnv({ tables = { 'pt-A': TABLE } } = {}) {
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const audits = []
  const ledger = createBudgetLedger({
    db, clock,
    writeAudit: (e) => audits.push(e),
    priceTableFor: (v) => tables[v] ?? null,
  })
  return { db, ledger, audits, tables }
}

const res = (over = {}) => ({
  attemptId: 'att:T-1:1', scope: 'default', taskId: 'T-1',
  modelProfileId: 'cheap', budget: { maxCost: 5, currency: 'USD' },
  priceTable: TABLE, ...TOK, ...over,
})

test('① 预留：预留的是**最大预算**，不是估算值', () => {
  const { ledger } = makeEnv()
  const { reservation, budgetState } = ledger.reserve(res())
  assert.equal(budgetState, 'reserved')
  assert.equal(reservation.reservedAmount, 5, '预留金额必须是预算上限 5，而不是估算出的 1')
  assert.equal(reservation.spentAmount, null)
  assert.equal(reservation.state, 'reserved')
  // 冻结字段落库
  assert.equal(reservation.priceTableVersion, 'pt-A')
  assert.equal(reservation.currency, 'USD')
  assert.equal(reservation.billingUnit, 'per-mtok')
  assert.equal(reservation.effectiveAtMs, 1_700_000_000_000)
  assert.equal(reservation.modelProfileId, 'cheap')
})

test('① 预留时落一条"运行时估算结果"：事后能回答当时估了多少', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  const usage = ledger.usageOf('att:T-1:1')
  assert.equal(usage.length, 1)
  assert.equal(usage[0].actualAmount, null, '预留时还没有实际金额')
  assert.equal(usage[0].estimatedAmount, 1)
  assert.equal(usage[0].priceTableVersion, 'pt-A')
  assert.equal(usage[0].estimateOk, true)
})

test('① 重复预留（参数一致）幂等：不新建行，返回同一条', () => {
  const { ledger, db } = makeEnv()
  const a = ledger.reserve(res())
  const b = ledger.reserve(res())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get().n, 1)
  assert.deepEqual(b.reservation, a.reservation)
})

test('① **重复预留但参数不一致 → 拒绝**（上限可以被改，但不能顺便被改）', () => {
  const { ledger, db } = makeEnv()
  ledger.reserve(res())
  for (const bad of [
    { budget: { maxCost: 100, currency: 'USD' } },
    { modelProfileId: 'dear' },
  ]) {
    assert.throws(() => ledger.reserve(res(bad)),
      (e) => e instanceof BudgetError && e.code === BUDGET_ERRORS.RESERVATION_EXISTS && e.statusCode === 409,
      JSON.stringify(bad))
  }
  // 换币种在更早的一步就被挡下（币种不一致比"参数不一致"是更准确的诊断）
  assert.throws(() => ledger.reserve(res({ budget: { maxCost: 5, currency: 'CNY' } })),
    (e) => e.code === BUDGET_ERRORS.CURRENCY_MISMATCH)
  // 原预留守住不变
  const r = ledger.get('att:T-1:1')
  assert.equal(r.reservedAmount, 5)
  assert.equal(r.modelProfileId, 'cheap')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get().n, 1)
})

test('① 缺 attemptId / 缺 modelProfileId / 坏 budget 一律拒绝', () => {
  const { ledger } = makeEnv()
  assert.throws(() => ledger.reserve(res({ attemptId: '' })), (e) => e.code === BUDGET_ERRORS.ATTEMPT_REQUIRED)
  assert.throws(() => ledger.reserve(res({ modelProfileId: null })), (e) => e.code === BUDGET_ERRORS.BUDGET_INVALID)
  for (const budget of [{ maxCost: 5 }, { currency: 'USD' }, { maxCost: -1, currency: 'USD' }, { maxCost: 5, currency: '' }]) {
    assert.throws(() => ledger.reserve(res({ budget })), (e) => e.code === BUDGET_ERRORS.BUDGET_INVALID, JSON.stringify(budget))
  }
})

test('① 预算币种与价目表币种不一致 → 拒绝（不同币种无法比较）', () => {
  const { ledger } = makeEnv()
  assert.throws(() => ledger.reserve(res({ budget: { maxCost: 5, currency: 'CNY' } })),
    (e) => e.code === BUDGET_ERRORS.CURRENCY_MISMATCH)
})

test('⑤ 没有预算 → 显式 unbounded，**不建预留**（"没配预算"必须可见）', () => {
  const { ledger, db } = makeEnv()
  const r = ledger.reserve(res({ budget: null }))
  assert.equal(r.budgetState, 'unbounded')
  assert.equal(r.reservation, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get().n, 0)
})

test('⑤ 已预留的 Attempt 不能再声明成"没有预算"（会静默解除上限）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  assert.throws(() => ledger.reserve(res({ budget: null })),
    (e) => e.code === BUDGET_ERRORS.RESERVATION_EXISTS && e.statusCode === 409)
})

test('② 采集用量：未超 → cancel=false；超硬上限 → 请求取消', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  // 0.6 USD < 5
  const ok = ledger.observe({ attemptId: 'att:T-1:1', tokensIn: 300_000, tokensOut: 300_000 })
  assert.equal(ok.cancel, false)
  assert.equal(ok.used, 0.6)
  assert.equal(ok.limit, 5)
  assert.equal(ledger.get('att:T-1:1').state, 'reserved')

  // 6 USD > 5 → 请求取消
  const over = ledger.observe({ attemptId: 'att:T-1:1', tokensIn: 3_000_000, tokensOut: 3_000_000 })
  assert.equal(over.cancel, true)
  assert.equal(over.kind, 'budget-exceeded')
  assert.equal(over.used, 6)
  assert.match(over.message, /BUDGET_EXCEEDED/)
  assert.match(over.message, /不得在未获用户批准时自动切换到更昂贵模型/)
  // 账本**请求**取消，不自己取消（它不知道 Run 的生命周期）
  assert.equal(ledger.get('att:T-1:1').state, 'cancel-requested')
  assert.equal(ledger.get('att:T-1:1').cancelReason, 'budget-exceeded:6>5')
})

test('② 采集用量：未预留就采集 → 拒绝（说明这条路径绕过了账本）', () => {
  const { ledger } = makeEnv()
  assert.throws(() => ledger.observe({ attemptId: 'att:ghost:1', tokensIn: 1, tokensOut: 1 }),
    (e) => e.code === BUDGET_ERRORS.RESERVATION_NOT_FOUND && e.statusCode === 409)
})

test('② 采集用量：**费用未知不得当成未超**', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res({ modelProfileId: 'cheap' }))
  // 用一个未定价的模型采集
  const r = ledger.observe({ attemptId: 'att:T-1:1', tokensIn: 1000, tokensOut: 1000, modelProfileId: 'unpriced' })
  assert.equal(r.cancel, false, 'unknown 不构成"超限"，但也绝不是"确认未超"')
  assert.equal(r.estimateOk, false)
  assert.equal(r.used, null, 'used 必须是 null 而不是 0')
  assert.equal(r.kind, 'cost-unknown')
  assert.match(r.message, /费用未知/)
})

test('② 采集用量：价目表版本取不到 → 拒绝，不用现价重算', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  // 价目表"消失"（比如 registry 被清掉）
  const tables = {}
  const db2 = new DatabaseSync(':memory:')
  ensureBudgetSchema(db2)
  const l2 = createBudgetLedger({ db: db2, clock, priceTableFor: (v) => tables[v] ?? null })
  l2.reserve({ ...res(), priceTable: TABLE })
  assert.throws(() => l2.observe({ attemptId: 'att:T-1:1', tokensIn: 1, tokensOut: 1 }),
    (e) => e.code === BUDGET_ERRORS.PRICE_TABLE_GONE && e.statusCode === 409)
})

test('③ 结算（outcome=known）：按实际用量结算，余额释放', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  const r = ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 200_000, tokensOut: 200_000, outcome: 'known', actor: 'u1' })
  assert.equal(r.reservation.state, 'settled')
  assert.equal(r.reservation.spentAmount, 0.4, '按实际用量 0.4 结算，不是预留的 5')
  assert.equal(r.reservation.overrunAmount, 0)
  assert.equal(r.reservation.settledBy, 'u1')
  assert.equal(r.overrun, 0)
  // 余额释放：不再占用
  assert.deepEqual(ledger.heldAmount(), [])
  assert.deepEqual(ledger.heldAmount('default'), [])
})

test('③ 结算（outcome=unknown）→ **locked，不结算**，余额仍被占住', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  const r = ledger.settle({ attemptId: 'att:T-1:1', outcome: 'unknown', actor: 'u1', reason: 'cancel-ack-timeout' })
  assert.equal(r.locked, true)
  assert.equal(r.reservation.state, 'locked')
  assert.equal(r.reservation.spentAmount, null, '结果未知时不得写入任何实际金额')
  assert.equal(r.reservation.lockReason, 'cancel-ack-timeout')
  // 锁定的钱**仍然占着**
  assert.deepEqual(ledger.heldAmount(), [{ currency: 'USD', held: 5 }])
})

test('③ **locked 不能被直接结算**（必须走恢复或人工处置）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', outcome: 'unknown', actor: 'u1' })
  assert.throws(() => ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100, tokensOut: 100, outcome: 'known', actor: 'u1' }),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERRORS.RESERVATION_LOCKED && e.statusCode === 409)
  assert.match(
    (() => { try { ledger.settle({ attemptId: 'att:T-1:1', outcome: 'known', actor: 'u1' }) } catch (e) { return e.message } })(),
    /直到\*\*恢复或人工处置\*\*/,
  )
  // 状态没变
  assert.equal(ledger.get('att:T-1:1').state, 'locked')
  assert.equal(ledger.get('att:T-1:1').spentAmount, null)
})

test('③ 人工处置 release：按 0 结算并释放，且记下是谁判的', () => {
  const { ledger, audits } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', outcome: 'unknown', actor: 'u1' })
  const r = ledger.resolveLocked({ attemptId: 'att:T-1:1', disposition: 'release', actor: 'ops-1', reason: '确认未扣费' })
  assert.equal(r.reservation.state, 'settled')
  assert.equal(r.reservation.spentAmount, 0)
  assert.equal(r.reservation.settledBy, 'ops-1')
  assert.equal(r.reservation.lockReason, 'human-release:确认未扣费')
  assert.deepEqual(ledger.heldAmount(), [], '释放后不再占用')
  const a = audits.at(-1)
  assert.equal(a.action, 'budget.human-release')
  assert.equal(a.detail.actor, 'ops-1')
})

test('③ 人工处置 settle：人工给出用量后正常结算', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', outcome: 'unknown', actor: 'u1' })
  const r = ledger.resolveLocked({
    attemptId: 'att:T-1:1', disposition: 'settle', actor: 'ops-1',
    tokensIn: 1_000_000, tokensOut: 1_000_000,
  })
  assert.equal(r.reservation.reservation.state, 'settled')
  assert.equal(r.reservation.reservation.spentAmount, 2)
})

test('③ 人工处置：只对 locked 生效，且 disposition/actor 必填', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  // 未锁定 → 拒绝（调用方对当前状态的理解是错的）
  assert.throws(() => ledger.resolveLocked({ attemptId: 'att:T-1:1', disposition: 'release', actor: 'u1' }),
    (e) => e.code === BUDGET_ERRORS.RESERVATION_LOCKED && e.state === 'reserved')
  ledger.settle({ attemptId: 'att:T-1:1', outcome: 'unknown', actor: 'u1' })
  assert.throws(() => ledger.resolveLocked({ attemptId: 'att:T-1:1', disposition: 'release' }),
    (e) => e.code === BUDGET_ERRORS.ACTOR_REQUIRED)
  for (const d of [undefined, null, '', 'drop-table']) {
    assert.throws(() => ledger.resolveLocked({ attemptId: 'att:T-1:1', disposition: d, actor: 'u1' }),
      (e) => e.code === BUDGET_ERRORS.OUTCOME_REQUIRED, String(d))
  }
  assert.equal(ledger.get('att:T-1:1').state, 'locked', '被拒绝时状态不变')
})

test('④ 结算必须显式给 outcome（不给就无法区分"已确认"与"不知道"）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  for (const o of [undefined, null, '', 'maybe', true]) {
    assert.throws(() => ledger.settle({ attemptId: 'att:T-1:1', outcome: o, actor: 'u1' }),
      (e) => e.code === BUDGET_ERRORS.OUTCOME_REQUIRED, String(o))
  }
  assert.throws(() => ledger.settle({ attemptId: 'att:T-1:1', outcome: 'known' }),
    (e) => e.code === BUDGET_ERRORS.ACTOR_REQUIRED)
  assert.deepEqual([...OUTCOME_KINDS], ['known', 'unknown'])
})

test('④ **超支如实报出，不裁剪，而且仍然可以结算**', () => {
  // 超支已经发生了，拒绝结算只会让账本与事实脱节；
  // 裁剪成 0 更糟——它把一次超支变成一次"刚好花满"。
  const { ledger } = makeEnv()
  ledger.reserve(res())
  // 实际花 12 USD > 预留 5
  const r = ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 6_000_000, tokensOut: 6_000_000, outcome: 'known', actor: 'u1' })
  assert.equal(r.reservation.spentAmount, 12, '实际金额如实记录')
  assert.equal(r.reservation.overrunAmount, 7, '超支差额必须是 7，不是 0')
  assert.equal(r.overrun, 7)
  assert.deepEqual(ledger.heldAmount(), [], '结算后释放（有超支也释放）')
})

test('④ 二次结算 → 拒绝（否则余额被释放两次）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100_000, tokensOut: 100_000, outcome: 'known', actor: 'u1' })
  const before = ledger.usageOf('att:T-1:1').length
  for (const actor of ['u1', 'u2']) {
    assert.throws(() => ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100_000, tokensOut: 100_000, outcome: 'known', actor }),
      (e) => e.code === BUDGET_ERRORS.ALREADY_SETTLED && e.statusCode === 409, actor)
  }
  assert.equal(ledger.usageOf('att:T-1:1').length, before, '被拒绝时不得追加用量行')
  assert.equal(ledger.get('att:T-1:1').spentAmount, 0.2, '实际金额不被第二次结算覆盖')
})

test('④ 结算后不能再采集用量（会与已释放的余额脱节）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100_000, tokensOut: 100_000, outcome: 'known', actor: 'u1' })
  assert.throws(() => ledger.observe({ attemptId: 'att:T-1:1', tokensIn: 200_000, tokensOut: 200_000 }),
    (e) => e.code === BUDGET_ERRORS.ALREADY_SETTLED)
})

test('④ 结算算不出金额 → 拒绝，**不得结算成 0**', () => {
  // 把"不知道花了多少"变成一笔免费运行，是账本最坏的一种谎。
  const tables = { 'pt-A': TABLE }
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const ledger = createBudgetLedger({ db, clock, priceTableFor: (v) => tables[v] ?? null })
  ledger.reserve(res())
  delete tables['pt-A']
  assert.throws(() => ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100, tokensOut: 100, outcome: 'known', actor: 'u1' }),
    (e) => e.code === BUDGET_ERRORS.PRICE_TABLE_GONE)
  assert.equal(ledger.get('att:T-1:1').state, 'reserved', '被拒绝时状态不变，钱仍然占着')
  assert.equal(ledger.get('att:T-1:1').spentAmount, null)
  assert.deepEqual(ledger.heldAmount(), [{ currency: 'USD', held: 5 }])
})

test('⑥ 结算用**冻结的**价目表版本，不用现价（spec 禁止重算历史）', () => {
  const tables = { 'pt-A': TABLE }
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const ledger = createBudgetLedger({ db, clock, priceTableFor: (v) => tables[v] ?? null })
  ledger.reserve(res())
  // 换价：新版本表里 cheap 涨 100 倍
  tables['pt-B'] = createPriceTable({
    version: 'pt-B', currency: 'USD', effectiveAtMs: 1_800_000_000_000,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 100, unitSize: 1_000_000 } },
  })
  // 结算仍然按 pt-A 算：1M tokens = 1 USD，而不是 100
  const r = ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 1_000_000, tokensOut: 0, outcome: 'known', actor: 'u1' })
  assert.equal(r.reservation.spentAmount, 1, '必须按 pt-A 结算')
  assert.equal(r.reservation.priceTableVersion, 'pt-A')
  const usage = ledger.usageOf('att:T-1:1')
  // 两条记录都冻结着各自的版本；预留那条估 1，结算那条按 pt-A 算 1
  assert.deepEqual(usage.map((u) => u.priceTableVersion), ['pt-A', 'pt-A'])
  assert.equal(usage[1].actualAmount, 1)
  assert.equal(r.reservation.priceTableVersion, 'pt-A', '结算记录不得改成 pt-B')
})

test('⑥ 用量历史是**追加**的：改价目表不改已有行', () => {
  const tables = { 'pt-A': TABLE }
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const ledger = createBudgetLedger({ db, clock, priceTableFor: (v) => tables[v] ?? null })
  ledger.reserve(res())
  const before = ledger.usageOf('att:T-1:1')
  tables['pt-B'] = createPriceTable({
    version: 'pt-B', currency: 'USD', effectiveAtMs: 0,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 500, unitSize: 1_000_000 } },
  })
  const after = ledger.usageOf('att:T-1:1')
  assert.deepEqual(after, before, '价目表变化不得修改已有 usage_records')
})

test('⑦ 状态机是**全定义**的：状态与转移表键一一对应', () => {
  // 缺键会让 `TRANSITIONS[x]` 是 undefined，于是下游落进 else，
  // 而 else 的默认行为通常是"当作正常继续"。
  assert.deepEqual([...Object.keys(RESERVATION_TRANSITIONS)].sort(), [...RESERVATION_STATES].sort())
  const all = new Set(RESERVATION_STATES)
  for (const [from, tos] of Object.entries(RESERVATION_TRANSITIONS)) {
    for (const t of tos) assert.ok(all.has(t), `${from} → ${t}：目标状态未登记`)
  }
  assert.deepEqual(RESERVATION_TRANSITIONS.settled, [], 'settled 是终态')
  // locked 仍然占着钱——它**不是**终态
  assert.ok(HOLDING_STATES.includes('locked'))
  assert.ok(!HOLDING_STATES.includes('settled'))
})

test('⑧ 切换更贵模型：未批准 → 拒绝；批准 → 允许；未定价 → 拒绝', () => {
  const { ledger, audits } = makeEnv()
  assert.throws(() => ledger.maySwitchModel({ from: 'cheap', to: 'dear', priceTable: TABLE, ...TOK }),
    (e) => e.code === 'MORE_EXPENSIVE_NEEDS_APPROVAL' && e.statusCode === 409)
  const ok = ledger.maySwitchModel({ from: 'cheap', to: 'dear', priceTable: TABLE, ...TOK, approved: true })
  assert.equal(ok.allowed, true)
  assert.equal(ledger.maySwitchModel({ from: 'dear', to: 'cheap', priceTable: TABLE, ...TOK }).allowed, true)
  assert.throws(() => ledger.maySwitchModel({ from: 'cheap', to: 'nope', priceTable: TABLE, ...TOK }),
    (e) => e.code === 'PRICE_UNKNOWN')
  // 换模型是花钱的动作，必须留痕（允许与被拒都留）
  const actions = audits.map((a) => a.action)
  assert.ok(actions.filter((a) => a === 'budget.model-switch-refused').length >= 2)
  assert.ok(actions.includes('budget.model-switch-allowed'))
})

test('⑨ 审计里没有密钥：只记金额/模型 id/版本号', () => {
  const { ledger, audits } = makeEnv()
  ledger.reserve(res())
  ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 100, tokensOut: 100, outcome: 'known', actor: 'u1' })
  const text = JSON.stringify(audits)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(text), `审计泄露密钥：${text}`)
  assert.ok(!text.includes('secretRef'))
  assert.ok(audits.some((a) => a.action === 'budget.reserve'))
  assert.ok(audits.some((a) => a.action === 'budget.settle'))
})

test('⑨ heldAmount 按 scope 与币种分别汇总（含 locked）', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res({ attemptId: 'att:A:1', scope: 's1' }))
  ledger.reserve(res({ attemptId: 'att:A:2', scope: 's1' }))
  ledger.reserve(res({ attemptId: 'att:B:1', scope: 's2' }))
  ledger.settle({ attemptId: 'att:A:2', outcome: 'unknown', actor: 'u1' })  // → locked，仍占
  ledger.settle({ attemptId: 'att:B:1', tokensIn: 0, tokensOut: 0, outcome: 'known', actor: 'u1' })  // 释放
  assert.deepEqual(ledger.heldAmount('s1'), [{ currency: 'USD', held: 10 }])
  assert.deepEqual(ledger.heldAmount('s2'), [])
  assert.deepEqual(ledger.heldAmount(), [{ currency: 'USD', held: 10 }])
})

test('⑨ list 可按 scope/state 过滤', () => {
  const { ledger } = makeEnv()
  ledger.reserve(res({ attemptId: 'att:A:1', scope: 's1' }))
  ledger.reserve(res({ attemptId: 'att:B:1', scope: 's2' }))
  ledger.settle({ attemptId: 'att:B:1', outcome: 'unknown', actor: 'u1' })
  assert.equal(ledger.list().length, 2)
  assert.equal(ledger.list({ scope: 's1' }).length, 1)
  assert.equal(ledger.list({ state: 'locked' }).length, 1)
  assert.equal(ledger.list({ scope: 's1', state: 'locked' }).length, 0)
})

test('⑩ 建表幂等，且缺 db / 缺 priceTableFor 时构造失败', () => {
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  ensureBudgetSchema(db)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='budget_reservations'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='usage_records'").get().n, 1)
  assert.throws(() => createBudgetLedger({}), TypeError)
  // 没有价目表来源时必须构造失败：否则结算只能按现价重算，而 spec 禁止
  assert.throws(() => createBudgetLedger({ db }), /priceTableFor/)
})

// ---------------------------------------------------------------- 价目表登记处

function makeRegistry() {
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const audits = []
  const registry = createPriceTableRegistry({ db, clock, writeAudit: (e) => audits.push(e) })
  return { db, registry, audits }
}

test('⑪ 发布价目表 → 可按版本取回，且往返后内容一致', () => {
  const { registry } = makeRegistry()
  const saved = registry.publish(TABLE, { actor: 'ops' })
  assert.equal(saved.version, 'pt-A')
  const back = registry.get('pt-A')
  assert.equal(back.currency, 'USD')
  assert.equal(back.effectiveAtMs, 1_700_000_000_000)
  assert.equal(back.models.cheap.perUnit, 1)
  assert.equal(back.models.cheap.billingUnit, 'per-mtok')
  // 取回的表**可用于估算**（不是残废的骨架）
  assert.equal(estimateCost({ priceTable: back, model: 'cheap', ...TOK }).amount, 1)
  assert.equal(registry.get('never-published'), null)
  assert.equal(registry.get(''), null)
  assert.equal(registry.list().length, 1)
})

test('⑪ **版本不可覆盖**：同版本再发布 → 拒绝（改价必须发新版本）', () => {
  // 就地改价会让引用旧版本的历史费用记录在无人察觉时变化。
  const { registry, db } = makeRegistry()
  registry.publish(TABLE, { actor: 'ops' })
  const changed = createPriceTable({
    version: 'pt-A', currency: 'USD', effectiveAtMs: 1_700_000_000_000,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 999, unitSize: 1_000_000 } },
  })
  assert.throws(() => registry.publish(changed, { actor: 'ops' }),
    (e) => e instanceof BudgetError && e.code === BUDGET_ERRORS.PRICE_TABLE_IMMUTABLE && e.statusCode === 409)
  // 库里仍是原价
  assert.equal(registry.get('pt-A').models.cheap.perUnit, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_tables').get().n, 1)
})

test('⑪ 发布必须给 actor，且只接受 createPriceTable 的产物', () => {
  const { registry } = makeRegistry()
  assert.throws(() => registry.publish(TABLE, {}), (e) => e.code === BUDGET_ERRORS.ACTOR_REQUIRED)
  for (const bad of [null, undefined, {}, { version: 'v', currency: 'USD' }, 'pt-A']) {
    assert.throws(() => registry.publish(bad, { actor: 'ops' }),
      (e) => e.code === BUDGET_ERRORS.PRICE_TABLE_INVALID, JSON.stringify(bad))
  }
})

test('⑪ 坏掉的 models_json 取回 null（不返回残缺表去算钱）', () => {
  // 两种坏法都要当作"这个版本取不到"，因为结算会因此拒绝结算，
  // 而不是拿一张残缺的表去算出一个看起来很专业的错误数字。
  const { registry, db } = makeRegistry()
  registry.publish(TABLE, { actor: 'ops' })
  registry.publish(createPriceTable({
    version: 'pt-B', currency: 'USD', effectiveAtMs: 1,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 } },
  }), { actor: 'ops' })
  // ① 不是 JSON
  db.prepare('UPDATE price_tables SET models_json = ? WHERE version = ?').run('not json', 'pt-A')
  assert.equal(registry.get('pt-A'), null, '坏 JSON 必须取不到')
  // ② 是 JSON 但形状不合法（缺 billingUnit）——数据问题，同样取不到
  db.prepare('UPDATE price_tables SET models_json = ? WHERE version = ?')
    .run(JSON.stringify({ cheap: { perUnit: 1 } }), 'pt-B')
  assert.equal(registry.get('pt-B'), null, 'shape 不合法必须取不到')
  // 而没被动过的那张仍然可用
  registry.publish(createPriceTable({
    version: 'pt-C', currency: 'USD', effectiveAtMs: 2,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 3, unitSize: 1_000_000 } },
  }), { actor: 'ops' })
  assert.equal(registry.get('pt-C').models.cheap.perUnit, 3)
})

test('⑪ **数据损坏不能绕过版本不可覆盖**（存在性判断必须看行，不能看能不能读）', () => {
  // 这是一条真实的旁路：若不可覆盖检查用 `get()`（把"没有行"与"行读不出来"
  // 都返回 null），那么**先把 v1 的 JSON 弄坏就能覆盖 v1** —— 而 v1 正是历史
  // 费用记录引用的那一版。绕过之后，历史记录会对着另一个价格算。
  const { registry, db } = makeRegistry()
  registry.publish(TABLE, { actor: 'ops' })
  db.prepare('UPDATE price_tables SET models_json = ? WHERE version = ?').run('{{{', 'pt-A')
  assert.equal(registry.get('pt-A'), null, '前提：坏数据读不出来')
  const cheaper = createPriceTable({
    version: 'pt-A', currency: 'USD', effectiveAtMs: 1_700_000_000_000,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 0.01, unitSize: 1_000_000 } },
  })
  assert.throws(() => registry.publish(cheaper, { actor: 'ops' }),
    (e) => e.code === BUDGET_ERRORS.PRICE_TABLE_IMMUTABLE,
    '坏数据不得让已存在的版本变成可覆盖')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_tables').get().n, 1)
})

test('⑪ **只吞数据错，不吞代码错**（代码缺陷不许伪装成"版本不存在"）', () => {
  // 这个模块真的犯过一次：忘了 import createPriceTable，而 `catch { return null }`
  // 把 ReferenceError 吞成了"版本不存在"，于是 settle 报 PRICE_TABLE_GONE——
  // 运维会去查价目表，而真实原因是一行没写的 import。
  const src = readFileSync(new URL('./budget-ledger.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export function createPriceTableRegistry'))
  const lookup = body.slice(body.indexOf('const get = (version)'), body.indexOf('function publish'))
  // 只有**包住 createPriceTable 调用**的那个 catch 才是危险的吞法
  const around = lookup.slice(lookup.indexOf('createPriceTable('))
  assert.match(around, /catch \(e\) \{/, '包住 createPriceTable 的 catch 必须接收异常')
  assert.match(around, /if \(e instanceof PriceError\) return null/, '必须显式只吞 PriceError')
  assert.match(around, /throw e/, '其它异常必须继续抛')
  // JSON.parse 的失败（数据坏）走 `return null` 是对的：它 catch 的是 parse，
  // 不是 createPriceTable
  assert.ok(lookup.indexOf('JSON.parse') < lookup.indexOf('createPriceTable('))
})

test('⑫ 端到端：发布 v1 → 预留 → 发布 v2（涨价）→ 结算仍按 v1', () => {
  // 这是 PRT-511 的完整闭环：价目表更新不影响已预留的那次运行的费用。
  const db = new DatabaseSync(':memory:')
  ensureBudgetSchema(db)
  const registry = createPriceTableRegistry({ db, clock })
  const ledger = createBudgetLedger({ db, clock, priceTableFor: (v) => registry.get(v) })
  registry.publish(TABLE, { actor: 'ops' })
  ledger.reserve(res())
  // 涨价：发布新版本
  registry.publish(createPriceTable({
    version: 'pt-B', currency: 'USD', effectiveAtMs: 1_800_000_000_000,
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 100, unitSize: 1_000_000 } },
  }), { actor: 'ops' })
  const r = ledger.settle({ attemptId: 'att:T-1:1', tokensIn: 1_000_000, tokensOut: 0, outcome: 'known', actor: 'u1' })
  assert.equal(r.reservation.spentAmount, 1, '必须按冻结的 pt-A，而不是涨价后的 pt-B（否则是 100）')
  assert.equal(r.reservation.priceTableVersion, 'pt-A')
  assert.deepEqual(ledger.usageOf('att:T-1:1').map((u) => u.priceTableVersion), ['pt-A', 'pt-A'])
})

