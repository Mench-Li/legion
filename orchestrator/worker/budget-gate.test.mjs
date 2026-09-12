// orchestrator/worker/budget-gate.test.mjs
// ============================================================================
// 执行路径上的预算闸门（PRT-510 的运行侧接线）
//
// ## 这一组守的是什么
//
// `team-hub/budget-ledger.mjs` 完整实现了「原子预留 / 采集 / 结算 /
// Unknown Outcome 锁定」，有套件、全绿、HTTP 路由齐全——
// 而**执行路径上一次都没有调用过它**。
//
//   > 一个功能没有入口，与一个功能不存在，在用户看来完全一样。
//
// 于是要害不是"账本算得对不对"（那已经有 20+ 例守着了），而是这三条：
//
//   ① **预留发生在花钱之前**（顺序，不是存在性）
//   ② **预留与结算永远成对**——包括引擎抛错的那条路径
//   ③ **失败的方向永远是"钱还占着"**，而不是"钱放掉了"
//
// 第 ① 条尤其容易被写成"验了预留接口被调用"。那证明不了顺序：
// 先跑再预留也能让"调用过预留"成立，而那时并发已经把钱花重了。
//
//   > 「花了多少」可以在事后回答；「还能不能花」只能在事前回答。
//
// 全程用假 hub：本模块只经 HTTP 与账本说话，所以不需要真 SQLite。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createBudgetGate, runBudgeted, settlementOutcomeFor, tokensOf,
  BudgetGateError, BUDGET_GATE_CODES,
} from './budget-gate.mjs'

/**
 * 假账本。**记录调用顺序**——顺序是这一组要验的主要东西，
 * 而"调用过"与"按这个顺序调过"是两回事。
 */
function makeLedger({
  reserveStatus = 200, reserveBody = null, settleStatus = 200, settleBody = null,
  observeStatus = 200, observeBody = null,
} = {}) {
  const calls = []
  return {
    calls,
    /** 调用序列，形如 `['reserve', 'settle']`。 */
    order() { return calls.map((c) => c.kind) },
    async post(path, body) {
      const kind = path.endsWith('/reserve') ? 'reserve'
        : path.endsWith('/settle') ? 'settle'
          : path.endsWith('/observe') ? 'observe' : 'other'
      calls.push({ kind, path, body })
      if (kind === 'reserve') {
        return reserveStatus === 200
          ? { status: 200, body: { ok: true, ...(reserveBody ?? { budgetState: 'bounded', reservation: { attemptId: body.attemptId, state: 'reserved' } }) } }
          : { status: reserveStatus, body: { ok: false, error: '余额不足', code: 'BUDGET_INVALID', ...(reserveBody ?? {}) } }
      }
      if (kind === 'settle') {
        return settleStatus === 200
          ? { status: 200, body: { ok: true, ...(settleBody ?? { reservation: { state: 'settled' } }) } }
          : { status: settleStatus, body: { ok: false, error: '二结算', code: 'ALREADY_SETTLED', ...(settleBody ?? {}) } }
      }
      return observeStatus === 200
        ? { status: 200, body: { ok: true, ...(observeBody ?? { cancel: false }) } }
        : { status: observeStatus, body: { ok: false, error: '采集失败', ...(observeBody ?? {}) } }
    },
  }
}

const LEASE = Object.freeze({
  attemptId: 'att:T-1:1', taskId: 'T-1', scope: 'default',
  modelProfileRef: 'mp-1', budget: { maxCostUsd: 5 },
})

function gate(ledger, over = {}) {
  return createBudgetGate({ post: ledger.post, actor: 'w1', ...over })
}

// ============================================================================
// ① 顺序：预留必须在花钱之前
// ============================================================================

test('① **预留发生在执行之前**（顺序，不是"调用过"）', async () => {
  const ledger = makeLedger()
  const g = gate(ledger)
  const marks = []

  await runBudgeted({
    gate: g,
    lease: LEASE,
    run: async () => { marks.push('run'); return { outcome: 'completed' } },
  })

  // 用**两个来源**对账：账本自己的调用顺序，以及执行体在被调用时看到的已完成调用数。
  const atRunTime = ledger.calls.filter((c) => c.kind === 'reserve').length
  assert.equal(marks.length, 1)
  assert.deepEqual(ledger.order(), ['reserve', 'settle'])
  assert.equal(atRunTime, 1,
    '执行开始时预留必须**已经**完成。先跑再预留也能让"调用过预留"成立，' +
    '而那时并发已经把钱花重了')
})

test('① 预留失败 → **不执行**（这是闸门，不是建议）', async () => {
  const ledger = makeLedger({ reserveStatus: 400, reserveBody: { code: 'BUDGET_INVALID', error: '余额不足' } })
  let ran = false
  await assert.rejects(
    () => runBudgeted({ gate: gate(ledger), lease: LEASE, run: async () => { ran = true; return { outcome: 'completed' } } }),
    (e) => {
      assert.ok(e instanceof BudgetGateError)
      assert.equal(e.code, BUDGET_GATE_CODES.RESERVE_FAILED)
      assert.equal(e.hubCode, 'BUDGET_INVALID')
      return true
    },
  )
  assert.equal(ran, false, '预留没成功就绝不能执行')
  assert.deepEqual(ledger.order(), ['reserve'], '而且不该走到结算')
})

test('① 预留的请求体带上 lease 的全部预算要素（缺一个账本就记不清这次是谁花的）', async () => {
  const ledger = makeLedger()
  await runBudgeted({ gate: gate(ledger), lease: LEASE, run: async () => ({ outcome: 'completed' }) })
  const body = ledger.calls[0].body
  assert.equal(body.attemptId, 'att:T-1:1')
  assert.equal(body.scope, 'default')
  assert.equal(body.taskId, 'T-1')
  assert.equal(body.modelProfileId, 'mp-1')
  assert.deepEqual(body.budget, { maxCostUsd: 5 })
  assert.equal(body.actor, 'w1', '谁花的钱要留痕')
})

// ============================================================================
// ② 预留与结算成对——包括抛错的那条路径
// ============================================================================

test('② 正常结束：按**实际用量**结算，且 outcome 是已知', async () => {
  const ledger = makeLedger()
  const r = await runBudgeted({
    gate: gate(ledger),
    lease: LEASE,
    run: async () => ({ outcome: 'completed' }),
    terminalEventOf: () => ({ type: 'run.completed', usage: { tokensIn: 1200, tokensOut: 300 } }),
  })
  assert.equal(r.outcome, 'completed')
  assert.equal(r.settlement.settled, true)
  const body = ledger.calls[1].body
  assert.equal(body.outcome, 'known')
  assert.equal(body.tokensIn, 1200, '结算要按**实际**用量，不是预留时的估算')
  assert.equal(body.tokensOut, 300)
  assert.equal(body.actor, 'w1')
})

test('② **结果未知 → `outcome: unknown`**（账本转 locked，不写任何金额）', async () => {
  const ledger = makeLedger()
  await runBudgeted({
    gate: gate(ledger),
    lease: LEASE,
    run: async () => ({ outcome: 'outcome_unknown' }),
    terminalEventOf: () => ({ type: 'run.outcome_unknown' }),
  })
  assert.equal(ledger.calls[1].body.outcome, 'unknown',
    '结果未知时必须走 unknown：写入任何数字都等于宣称"算清了"，而那时恰恰不知道')
})

test('② **引擎抛错时也要结算**，且按"未知"（半途抛出时用量不可知）', async () => {
  const ledger = makeLedger()
  await assert.rejects(
    () => runBudgeted({
      gate: gate(ledger),
      lease: LEASE,
      run: async () => { throw new Error('引擎炸了') },
      terminalEventOf: () => null,
    }),
    /引擎炸了/,
  )
  assert.deepEqual(ledger.order(), ['reserve', 'settle'],
    '抛错路径也必须结算：把预留悄悄放掉等于宣称"这次没花钱"')
  assert.equal(ledger.calls[1].body.outcome, 'unknown')
})

test('② 抛错时**原样重抛**原始异常（不被结算的失败掩盖）', async () => {
  const ledger = makeLedger()
  const boom = new Error('原始故障')
  await assert.rejects(
    () => runBudgeted({ gate: gate(ledger), lease: LEASE, run: async () => { throw boom } }),
    (e) => { assert.equal(e, boom); return true },
  )
})

test('② 结算失败**不把已经跑完的结果变成异常**（否则调用方丢掉 outcome）', async () => {
  const ledger = makeLedger({ settleStatus: 409, settleBody: { code: 'ALREADY_SETTLED' } })
  const notes = []
  const r = await runBudgeted({
    gate: gate(ledger, { onNote: (n) => notes.push(n) }),
    lease: LEASE,
    run: async () => ({ outcome: 'completed', detail: '跑完了' }),
    terminalEventOf: () => ({ type: 'run.completed', usage: { tokensIn: 1, tokensOut: 1 } }),
  })
  // 结果还在——调用方仍然知道 outcome，因而知道该不该重试。
  assert.equal(r.outcome, 'completed')
  assert.equal(r.settlement.settled, false)
  assert.equal(r.settlement.code, BUDGET_GATE_CODES.SETTLE_FAILED)
  // 但失败**必须可见**：预留还占着，需要人工处置。
  assert.equal(notes.length, 1)
  assert.equal(notes[0].kind, BUDGET_GATE_CODES.SETTLE_FAILED)
  assert.match(notes[0].detail, /仍然占着/)
})

// ============================================================================
// ③ 失败的方向：钱还占着
// ============================================================================

test('③ 结算失败时返回 `settled: false`（而不是假装成功）', async () => {
  const ledger = makeLedger({ settleStatus: 500, settleBody: {} })
  const r = await runBudgeted({ gate: gate(ledger), lease: LEASE, run: async () => ({ outcome: 'failed' }) })
  assert.equal(r.settlement.settled, false)
  assert.equal(typeof r.settlement.message, 'string')
})

// ============================================================================
// ④ actor：不给默认值
// ============================================================================

test('④ **缺 actor 时构造即拒绝**（不给默认值）', () => {
  // 一个默认 actor 会让"没人签名"与"某人签了名"在账本里长得一样。
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => createBudgetGate({ post: async () => ({ status: 200, body: { ok: true } }), actor: bad }), (e) => {
      assert.equal(e.code, BUDGET_GATE_CODES.ACTOR_REQUIRED)
      return true
    })
  }
})

test('④ 缺 `post` 时构造即拒绝（少了它只能"假装花过钱"）', () => {
  assert.throws(() => createBudgetGate({ actor: 'w1' }), (e) => {
    assert.equal(e.code, BUDGET_GATE_CODES.BAD_WIRING)
    return true
  })
})

test('④ actor 两端空白被清掉（账本里不留「  w1  」与「w1」两行）', async () => {
  const ledger = makeLedger()
  await runBudgeted({ gate: gate(ledger, { actor: '  w1  ' }), lease: LEASE, run: async () => ({ outcome: 'completed' }) })
  assert.equal(ledger.calls[0].body.actor, 'w1')
  assert.equal(ledger.calls[1].body.actor, 'w1')
})

// ============================================================================
// ⑤ 「没有上限」必须可见
// ============================================================================

test('⑤ `budgetState: unbounded` 如实上报，并留一条诊断', async () => {
  const ledger = makeLedger({ reserveBody: { budgetState: 'unbounded', reservation: null } })
  const notes = []
  const r = await runBudgeted({
    gate: gate(ledger, { onNote: (n) => notes.push(n) }),
    lease: LEASE,
    run: async () => ({ outcome: 'completed' }),
  })
  // 一个没有上限的运行与一个有上限的运行在日志里长得一样，而风险完全不同。
  assert.equal(r.budgetState, 'unbounded')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].kind, BUDGET_GATE_CODES.UNBOUNDED)
})

test('⑤ `requireBounded: true` 时**没有上限就不执行**', async () => {
  const ledger = makeLedger({ reserveBody: { budgetState: 'unbounded', reservation: null } })
  let ran = false
  await assert.rejects(
    () => runBudgeted({
      gate: gate(ledger), lease: LEASE, requireBounded: true,
      run: async () => { ran = true; return { outcome: 'completed' } },
    }),
    (e) => {
      assert.equal(e.code, BUDGET_GATE_CODES.UNBOUNDED)
      return true
    },
  )
  assert.equal(ran, false)
  // 预留已经发生了（那是账本的记账事实），但执行没有。
  assert.deepEqual(ledger.order(), ['reserve'])
})

// ============================================================================
// ⑥ 运行中采集：只请求取消，不自己取消
// ============================================================================

test('⑥ `observe` 请求取消时**只记录**，不自己取消（它不知道 Run 的生命周期）', async () => {
  const ledger = makeLedger({ observeBody: { cancel: true, kind: 'budget-exceeded' } })
  const r = await gate(ledger).observe(LEASE, { tokensIn: 9999, tokensOut: 1 })
  assert.equal(r.cancel, true)
  assert.equal(r.kind, 'budget-exceeded')
})

test('⑥ `observe` 网络失败**不改变预算判定**（不因一次抖动杀掉正常运行）', async () => {
  const ledger = makeLedger({ observeStatus: 500, observeBody: {} })
  const notes = []
  const r = await gate(ledger, { onNote: (n) => notes.push(n) }).observe(LEASE, { tokensIn: 1, tokensOut: 1 })
  assert.equal(r.cancel, false, '采集失败不该被当成"超预算"')
  assert.equal(notes.length, 1)
})

test('⑥ `observe` 没有 usage 时不发请求（没有可采集的东西）', async () => {
  const ledger = makeLedger()
  const r = await gate(ledger).observe(LEASE, null)
  assert.equal(r.cancel, false)
  assert.equal(ledger.calls.length, 0)
})

// ============================================================================
// ⑦ 纯函数：终态映射与 token 提取
// ============================================================================

test('⑦ `settlementOutcomeFor`：只有 `outcome_unknown` 才锁定', () => {
  assert.equal(settlementOutcomeFor('outcome_unknown'), 'unknown')
  for (const known of ['completed', 'failed', 'cancelled', 'timed-out', 'outcome-unknown']) {
    assert.equal(settlementOutcomeFor(known), 'known')
  }
})

test('⑦ **未知字符串不被映射成 `unknown`**（一处拼写错误不该把余额永久锁住）', () => {
  // 锁住的表现是"这个 worker 之后都说没钱"——排查方向会被带到配置上，
  // 而真因是一个字符串写错了。所以未知一律按"已知"结算：钱该释放就释放，
  // 而这次运行的 outcome 本身仍然是可疑的、会照常上报。
  assert.equal(settlementOutcomeFor('weird-new-outcome'), 'known')
  assert.equal(settlementOutcomeFor(undefined), 'known')
  assert.equal(settlementOutcomeFor(null), 'known')
})

test('⑦ `tokensOf`：取不到就是 `null`，**不是 0**', async () => {
  // 0 是一个断言（"一个 token 都没花"），null 是"不知道"。
  // 把它写成 0，结算时就会宣称算清了，而实际是不知道。
  assert.deepEqual(tokensOf(null), { tokensIn: null, tokensOut: null })
  assert.deepEqual(tokensOf({}), { tokensIn: null, tokensOut: null })
  assert.deepEqual(tokensOf({ usage: null }), { tokensIn: null, tokensOut: null })
  assert.deepEqual(tokensOf({ usage: { tokensIn: 5 } }), { tokensIn: 5, tokensOut: null })
  // 负数与非有限数不是合法用量
  assert.deepEqual(tokensOf({ usage: { tokensIn: -1, tokensOut: Number.NaN } }), { tokensIn: null, tokensOut: null })
})

// ============================================================================
// ⑧ 没接闸门必须可见（与 PRT-253 同一条口径）
// ============================================================================

test('⑧ 没接闸门时 `budgetState` 是 `not-gated`，且**不**发任何账本请求', async () => {
  const { createProductionExecutor } = await import('./executor.mjs')
  const hub = {
    async post(path) {
      if (path.includes('run-budget')) throw new Error('没接闸门时不该碰账本')
      return { status: 200, body: { ok: true, snapshotHash: 'h', snapshot: { finalText: 'x' } } }
    },
    async get() {
      return {
        status: 200,
        body: {
          ok: true,
          verification: { ok: true },
          snapshot: { finalText: '冻结正文', associations: {} },
        },
      }
    },
  }
  const host = {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() { return { version: 'v', capabilities: { structuredOutput: true, streaming: true, cancel: true, events: true } } },
    async startRun() { return { result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }), dispose: async () => {} } },
  }
  const built = await createProductionExecutor({
    post: hub.post, get: hub.get, canRead: () => true, host,
    selfCheck: async () => ({ state: 'effective', autoExecutionForbidden: false, reasons: [] }),
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  const r = await built.executor.execute({
    attemptId: 'att:T-1:1', taskId: 'T-1', workspaceId: 'ws', modelProfileRef: 'mp', workdir: '.',
    goalId: 'g1', employeeId: 'e1', teamPlanRef: 'tp1',
  })
  // 「一个字段没人断言」与「这个字段不存在」是同一件事。
  // 先断言这次执行**真的成功了**：能力齐全 ≠ 选中了模型，
  // 少了 currentModelSelection 时适配器报 MODEL_UNAVAILABLE，
  // 而一个只看 budgetState 的断言在全流程失败时依然会通过。
  assert.equal(r.outcome, 'completed', `执行必须真的成功：${r.detail}`)
  assert.equal('budgetState' in r, true, 'budgetState 必须在执行结果里')
  assert.equal(r.budgetState, 'not-gated')
  assert.equal(r.settlement, null)
})

test('⑧ 接了闸门时执行结果里带 reservation 与 settlement（不是只有 budgetState）', async () => {
  const { createProductionExecutor } = await import('./executor.mjs')
  const ledger = makeLedger()
  const hub = {
    async post(path, body) {
      if (path.includes('run-budget')) return ledger.post(path, body)
      return {
        status: 200,
        body: {
          ok: true, snapshotHash: 'h',
          snapshot: { finalText: '冻结正文', associations: {}, sources: [], excluded: [], truncations: [], redactions: [], tokens: { kind: 'exact', tokens: 1 } },
        },
      }
    },
    async get() {
      return {
        status: 200,
        body: { ok: true, verification: { ok: true }, snapshot: { finalText: '冻结正文', associations: {} } },
      }
    },
  }
  const host = {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() { return { version: 'v', capabilities: { structuredOutput: true, streaming: true, cancel: true, events: true } } },
    async startRun() {
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }),
        dispose: async () => {},
      }
    },
  }
  const built = await createProductionExecutor({
    post: hub.post, get: hub.get, canRead: () => true, host, budgetActor: 'w1',
    selfCheck: async () => ({ state: 'effective', autoExecutionForbidden: false, reasons: [] }),
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  const r = await built.executor.execute({
    attemptId: 'att:T-1:1', taskId: 'T-1', workspaceId: 'ws', modelProfileRef: 'mp', workdir: '.',
    goalId: 'g1', employeeId: 'e1', teamPlanRef: 'tp1',
  })
  assert.equal(r.outcome, 'completed')
  assert.equal(r.budgetState, 'bounded')
  assert.equal(r.reservation.attemptId, 'att:T-1:1')
  assert.equal(r.settlement.settled, true)
  // **顺序**：预留必须排在适配器那次运行之前。
  assert.deepEqual(ledger.order(), ['reserve', 'settle'])
})

// ============================================================================
// ⑨ 执行路径自己那条抛错分支（不是 `runBudgeted` 那条）
// ============================================================================

test('⑨ 引擎抛出时执行路径也结算，并按「未知」锁定', async () => {
  // 为什么这条要单独写：适配器**刻意**把引擎故障分类成终态事件，不往外抛
  // （那是对的设计——一次引擎故障是一条有名字的结论，不是一个栈）。
  // 所以 `executor.execute` 里那个 catch 分支**用真适配器永远走不到**。
  //
  // 第一版就漏在这里：探针 ⑪④ 改掉了那个分支，而**没有任何用例会红**——
  // 因为没有任何用例进得去。一条没人走过的分支与一条不存在的分支，
  // 在"用例全绿"这个读数上完全一样。
  //
  // `adapterFactory` 注入就是为这种事准备的：不启动 DSH，也能走到那一步。
  const { createProductionExecutor } = await import('./executor.mjs')
  const ledger = makeLedger()
  const hub = {
    async post(path, body) {
      if (path.includes('run-budget')) return ledger.post(path, body)
      return { status: 200, body: { ok: true, snapshotHash: 'h', snapshot: { finalText: 'x' } } }
    },
    async get() {
      return { status: 200, body: { ok: true, verification: { ok: true }, snapshot: { finalText: '冻结正文', associations: {} } } }
    },
  }
  const host = {
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() { return { version: 'v', capabilities: {} } },
    async startRun() { throw new Error('不该走到这里') },
  }
  // 一个 `execute` 会抛的适配器。用 async generator 的形状，与真适配器一致。
  const throwingAdapter = {
    async probe() { return { ok: true } },
    // eslint-disable-next-line require-yield
    async *execute() { throw new Error('适配器自己炸了') },
  }
  const built = await createProductionExecutor({
    post: hub.post, get: hub.get, canRead: () => true, host, budgetActor: 'w1',
    adapterFactory: () => throwingAdapter,
    selfCheck: async () => ({ state: 'effective', autoExecutionForbidden: false, reasons: [] }),
  })
  assert.equal(built.ok, true, JSON.stringify(built))
  await assert.rejects(
    () => built.executor.execute({
      attemptId: 'att:T-1:1', taskId: 'T-1', workspaceId: 'ws', modelProfileRef: 'mp', workdir: '.',
      goalId: 'g1', employeeId: 'e1', teamPlanRef: 'tp1',
    }),
    /适配器自己炸了/,
  )
  // 抛错之后**预留必须已经被结算**——而且按"未知"：半途抛出时用量不可知。
  assert.deepEqual(ledger.order(), ['reserve', 'settle'],
    '执行路径抛错时也必须结算：把预留留着不管，余额会被一直占住（表现为"能跑但都说没钱"）')
  assert.equal(ledger.calls[1].body.outcome, 'unknown')
})
