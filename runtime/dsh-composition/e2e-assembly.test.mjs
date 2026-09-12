// runtime/dsh-composition/e2e-assembly.test.mjs
// ============================================================================
// 装配链的**端到端**验证：四件已交付的东西能不能接起来
//
// ## 为什么需要这一组
//
// 最近四批各自交付了一块，每块都有自己的套件、全绿：
//
//   ① `runtime/dsh-composition/bootstrap.mjs` —— 自检 + 注册宿主端口
//   ② `orchestrator/worker/executor-binding.mjs` —— `bindDshRuntime`
//   ③ `orchestrator/worker/executor.mjs` —— 冻结正文当提示词 + 执行引擎
//   ④ `orchestrator/worker/budget-gate.mjs` —— 预留 / 采集 / 结算
//
// 而**没有任何一条用例把它们接起来跑过一次**。
//
//   > 「注册了、跑了、过了」≠「这条路被测过」。
//
// 每一块自己都对，接起来仍然可能不对——而接缝上的错**恰恰是每一块的
// 套件都看不见的**：它们各自的假件补上了对方那一半。
//
// 这一组就是那条缝：只用最外层的假件（DSH 引擎 + hub 的 HTTP），
// 中间四块全部用**真实现**，从"组合树观察结果"一路走到"账本已结算"。
//
// ## 这一组真的能抓到东西
//
// 写这一组之前刚犯过一个接缝错误：`bootstrap` 把只实现了 `probeRuntime`
// 的假宿主当成端口注册了，于是失败被推迟到 worker 构造执行引擎时才暴露。
// 每一块的套件当时都是绿的——因为 `bootstrap` 的假件不需要 `startRun`，
// 而 `executor` 的假件直接跳过 `bootstrap`。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootstrapDshRuntime, BOOTSTRAP_CODES } from './bootstrap.mjs'
import { PATCH_LAYER_ROWS, LEGION_PERMISSION_PRESETS } from './patch-layer.mjs'
import {
  productionExecutorProvider, resetDshRuntimeBinding, dshRuntimeBound,
} from '../../orchestrator/worker/executor-binding.mjs'

// ---------------------------------------------------------------------------
// 最外层的两个假件。中间四块全部真实现。
// ---------------------------------------------------------------------------

const CAPS_OK = Object.freeze({
  'tool-permission-enforcement': true,
  'cancel-and-timeout': true,
  'structured-result': true,
  'usage-reporting': true,
})

/**
 * 一个**完整**的 DSH 宿主端口（`startRun` + `probeRuntime`，两个都不能少）。
 *
 * `timeline` 是**与 hub 共享的**那一条调用序列：引擎那次调用也要记进去。
 * 分成两条时间线的话，"预留早于结算"验得到，而"预留早于**执行**"验不到——
 * 后者才是这道闸门存在的全部意义。
 */
function dshHost({ failure = null, usage = { tokensIn: 1200, tokensOut: 300 }, timeline = null } = {}) {
  const calls = []
  const record = (entry) => {
    calls.push(entry)
    // 记进**同一条**时间线，好让"预留 → 执行 → 结算"这个顺序可断言。
    if (Array.isArray(timeline)) timeline.push({ kind: 'engine-run', ...entry })
  }
  return {
    calls,
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() {
      return { version: '0.1.5-rc.2', capabilities: { ...CAPS_OK } }
    },
    async startRun(provider, options) {
      record({ provider, options })
      return {
        result: (async () => {
          if (failure !== null) throw failure
          return { stopReason: 'completed', structured: { ok: true }, usage }
        })(),
        dispose: async () => {},
      }
    },
  }
}

/**
 * 一个假 hub：同时扮演"上下文快照存储"与"预算账本"两件事，
 * 并**记录调用顺序**——顺序是本组要验的东西之一。
 */
function fakeHub({ reserveStatus = 200, settleStatus = 200, frozenText = '冻结的正文', timeline = null } = {}) {
  const calls = []
  const record = (entry) => {
    calls.push(entry)
    if (Array.isArray(timeline)) timeline.push(entry)
  }
  return {
    calls,
    order() { return calls.map((c) => c.kind) },
    /** 与引擎共享的那条时间线（**含** `engine-run`）。 */
    fullOrder() { return (timeline ?? calls).map((c) => c.kind) },
    async post(path, body) {
      if (path.endsWith('/run-budget/reserve')) {
        record({ kind: 'reserve', body })
        return reserveStatus === 200
          ? { status: 200, body: { ok: true, budgetState: 'bounded', reservation: { attemptId: body.attemptId, state: 'reserved' } } }
          : { status: reserveStatus, body: { ok: false, code: 'BUDGET_INVALID', error: '余额不足' } }
      }
      if (path.endsWith('/run-budget/settle')) {
        record({ kind: 'settle', body })
        return settleStatus === 200
          ? { status: 200, body: { ok: true, reservation: { state: 'settled' } } }
          : { status: settleStatus, body: { ok: false, code: 'ALREADY_SETTLED', error: '二结算' } }
      }
      if (path.endsWith('/run-budget/observe')) {
        record({ kind: 'observe', body })
        return { status: 200, body: { ok: true, cancel: false } }
      }
      record({ kind: 'assemble', body })
      return { status: 200, body: { ok: true, recorded: true, summary: {}, snapshotHash: 'h' } }
    },
    async get(path) {
      record({ kind: 'get-snapshot', path })
      return {
        status: 200,
        body: { ok: true, verification: { ok: true }, snapshot: { finalText: frozenText, associations: {} } },
      }
    },
  }
}

function compositionOk() {
  return {
    rows: PATCH_LAYER_ROWS.map((r) => ({ id: r.id, activated: true })),
    permissionPresets: Object.keys(LEGION_PERMISSION_PRESETS),
  }
}

function sandboxOk() {
  return {
    async confine(argv) {
      return {
        enforcement: 'full',
        backend: 'e2e-backend',
        argv: ['sandbox-run', '--', ...argv],
        denialSignatures: ['operation not permitted'],
      }
    },
  }
}

const LEASE = Object.freeze({
  attemptId: 'att:T-e2e:1', taskId: 'T-e2e', workspaceId: 'ws-1',
  goalId: 'g-1', employeeId: 'emp-1', teamPlanRef: 'tp-1',
  modelProfileRef: 'mp-1', workdir: '.',
  // 用 `maxTokens` 而不是 `maxCostUsd`：没有价格表时后者会让适配器的**事后**
  // 判定报 `cost-unknown` → 判超支（那是正确且保守的），而它会掩盖本组要验的东西。
  budget: { maxTokens: 100000 },
})

async function assemble(over = {}) {
  // hub 与宿主**共享**一条时间线：引擎那次调用要落在同一条序列里。
  const timeline = over.timeline ?? null
  void timeline
  // 夹具默认清空绑定，避免用例之间互相污染。但**"连续装配两次"**那条
  // 要验的正是"两次装配的注销互不影响"——它在第一条 `assemble()` 之前
  // 清空是正确的，第二次之前清空就把要验的状态抹掉了。
  // 所以给一个显式开关：**夹具的便利不能改写被测的行为**。
  if (over.reset !== false) resetDshRuntimeBinding()
  const host = over.host ?? dshHost({ timeline })
  const hub = over.hub ?? fakeHub({ timeline })
  const boot = await bootstrapDshRuntime({
    runtimeHost: host,
    composition: over.composition ?? compositionOk(),
    sandbox: over.sandbox ?? sandboxOk(),
    canRead: over.canRead ?? (() => true),
    probeFactory: over.probeFactory,
  })
  return { host, hub, boot }
}

// ============================================================================
// ① 全链路：观察结果 → 自检 → 注册 → 执行 → 结算
// ============================================================================

test('① **全链路跑通**：自检 → 注册 → worker 拿到引擎 → 执行 → 账本已结算', async () => {
  const timeline = []
  const { host, hub, boot } = await assemble({ timeline })
  try {
    assert.equal(boot.ok, true, JSON.stringify(boot))
    assert.equal(dshRuntimeBound(), true)

    // worker 这一侧：从"进程里已经注册了什么"出发，拿到执行引擎。
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    assert.equal(provided.ok, true,
      `装配之后 worker 必须能拿到引擎；实际 ${provided.code}：${provided.message}`)

    const result = await provided.executor.execute(LEASE)
    assert.equal(result.outcome, 'completed', result.detail)
    assert.equal(result.contextSnapshotRef, LEASE.attemptId)

    // 顺序是这条链的要害：**预留 → 执行 → 结算**。
    // 用**同一条**时间线断言，因为"两笔账务都有"证明不了执行夹在中间——
    // 而"钱在花之前就被占住"正是这道闸门存在的全部意义。
    assert.deepEqual(hub.fullOrder(), ['get-snapshot', 'reserve', 'engine-run', 'settle'],
      '预留必须先于执行、结算必须在执行之后；' +
      `实际：${hub.fullOrder().join(' → ')}`)
    assert.equal(host.calls.length, 1, '引擎只被调用一次')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('① 提示词就是**冻结的正文**，一路没有被重新拼装', async () => {
  // 这条要**看完整个链路**：快照里的正文 → RunRequest → 引擎收到的 prompt。
  // 中间隔着 executor 与 adapter 两层，任一层重新拼装都会让"进模型的东西"
  // 与"冻结的哈希"对不上，而单层套件看不见这件事。
  const FROZEN = '冻结的正文（唯一应当进入模型的东西）'
  const host = dshHost()
  const { hub, boot } = await assemble({ hub: fakeHub({ frozenText: FROZEN }), host })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    assert.equal(provided.ok, true, JSON.stringify(provided))
    await provided.executor.execute(LEASE)

    // 引擎收到的 prompt —— 这是离模型最近的一处可观察点。
    assert.equal(host.calls.length, 1, '引擎必须被调用一次')
    const prompt = host.calls[0].options?.prompt
    assert.ok(prompt !== undefined, `startRun 的 options 里没有 prompt：${JSON.stringify(Object.keys(host.calls[0].options ?? {}))}`)
    // 提示词可以是一个字符串或消息数组；两种都归一化成文本再比。
    const text = typeof prompt === 'string'
      ? prompt
      : (Array.isArray(prompt) ? prompt.map((m) => m?.text ?? '').join('') : '')
    assert.ok(text.includes(FROZEN),
      `引擎收到的提示词里没有冻结的正文。收到的是：${text.slice(0, 200)}`)
    // 而且**不能有包装**：包装会改变正文，从而与快照里存的哈希对不上。
    assert.equal(text, FROZEN,
      '冻结的正文必须**逐字**进模型：任何前缀/包装都会让它与快照的哈希对不上')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('① 端到端：结算带上**真实用量**（不是预留时的估算）', async () => {
  const { hub, boot } = await assemble({ host: dshHost({ usage: { tokensIn: 4321, tokensOut: 123 } }) })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    await provided.executor.execute(LEASE)
    const settle = hub.calls.find((c) => c.kind === 'settle')
    assert.ok(settle !== undefined, `必须走到结算；实际调用序列：${hub.order().join(' → ')}`)
    assert.equal(settle.body.outcome, 'known')
    assert.equal(settle.body.tokensIn, 4321, '结算必须按实际用量')
    assert.equal(settle.body.tokensOut, 123)
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

// ============================================================================
// ② 接缝上的拒绝：装配失败时 worker 一侧**必须拒绝**，不能拿到半个引擎
// ============================================================================

test('② 自检未过 → worker 拿不到引擎（拒绝要能穿透到另一侧）', async () => {
  const { hub, boot } = await assemble({ composition: { rows: [] } })
  assert.equal(boot.ok, false)
  assert.equal(boot.code, BOOTSTRAP_CODES.COMPOSITION_UNOBSERVED)
  const provided = await productionExecutorProvider({
    post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
  })
  assert.equal(provided.ok, false, '装配没过时 worker 绝不能拿到引擎')
  assert.equal(provided.code, 'EXECUTOR_HOST_PORT_REQUIRED')
  assert.equal(hub.order().length, 0, '拒绝时不该碰 hub')
})

test('② 沙箱只做到 partial → 自检未过 → worker 一侧拒绝', async () => {
  // 这条走的是**自检**那条分支（`autoExecutionForbidden === true`），
  // 与上面"组合树没观察"那条不同——后者在自检**之前**就返回了。
  // 两条分支都要有人走到，否则其中一条就是"没人走过的分支"。
  const hub = fakeHub()
  const { boot } = await assemble({
    hub,
    sandbox: {
      async confine(argv) {
        return { enforcement: 'partial', backend: 'b', argv: ['x', ...argv], denialSignatures: ['no'] }
      },
    },
  })
  assert.equal(boot.ok, false)
  assert.equal(boot.code, BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
  const provided = await productionExecutorProvider({
    post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
  })
  assert.equal(provided.ok, false, '自检未过时 worker 绝不能拿到引擎')
  assert.equal(hub.order().length, 0, '拒绝时不该碰 hub')
})

test('② 装配之后 `unbind` → worker 一侧又拒绝（装配与注册同生共死）', async () => {
  const { hub, boot } = await assemble()
  assert.equal(boot.ok, true)
  boot.unbind()
  assert.equal(dshRuntimeBound(), false)
  const provided = await productionExecutorProvider({
    post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
  })
  assert.equal(provided.ok, false)
  assert.equal(provided.code, 'EXECUTOR_HOST_PORT_REQUIRED')
})

// ============================================================================
// ③ 接缝上的失败方向：每一处的失败都指向"钱还占着 / 不执行"
// ============================================================================

test('③ 余额不足 → **引擎一次都没被调用**（闸门在花钱之前）', async () => {
  const hub = fakeHub({ reserveStatus: 400 })
  const host = dshHost()
  const { boot } = await assemble({ hub, host })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    await assert.rejects(() => provided.executor.execute(LEASE), /余额不足/)
    assert.equal(host.calls.length, 0,
      '预留失败时引擎一次都不能被调用——这是这道闸门存在的全部意义')
    assert.deepEqual(hub.order(), ['get-snapshot', 'reserve'], '而且不该走到结算')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('③ 引擎故障 → 是一条**有名字的结论**，而账务照旧有结局', async () => {
  const hub = fakeHub()
  const host = dshHost({ failure: new Error('引擎炸了') })
  const { boot } = await assemble({ hub, host })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    // **不抛**——这是适配器刻意的设计：一次引擎故障是一条有名字的结论
    // （`run.failed` 终态事件），不是一个栈。
    //
    // 第一版这条写的是 `assert.rejects`，那是在要求实现做它**刻意不做**的事。
    // 出一条"实现没按测试的想法做"的红，与"实现是错的"完全同形——
    // 所以夹具/断言写错时，红不是证据。
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.outcome, 'failed', `引擎故障必须落成一个终态，实际 ${result.outcome}：${result.detail}`)

    const settle = hub.calls.find((c) => c.kind === 'settle')
    assert.ok(settle !== undefined, '引擎故障时也必须结算：把预留留着不管，余额会被一直占住')
    // 走的是 `known` 而不是 `unknown`：适配器给了明确的终态，
    // "这次运行失败了"这件事是**已知**的。未知的是用量，而用量缺失
    // 由 `tokensIn/tokensOut` 为 `null` 如实表达——不是把它写成 0。
    assert.equal(settle.body.outcome, 'known')
    assert.equal(settle.body.tokensIn, null, '取不到用量就是 null，不是 0')
    assert.ok(result.budgetState === 'bounded', '账本这一侧照旧有结论')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('③ **一侧不可信的 usage** → 未知侧记 `null`（不补 0），且不得判为完成', async () => {
  // 这条存在的理由：探针改掉 `tokensOf` 里的 `n()` 却没有任何用例会红，
  // 因为 `usage` **整个缺失**时函数提前返回了，`n()` 根本没被走到。
  // 一条没人走过的分支与一条不存在的分支，在"用例全绿"这个读数上完全一样。
  //
  // 所以这里给一个**一侧合法、另一侧不可信**的 usage ——
  // 这才走得到 `n()`。
  //
  // 顺带一提：`{ inputTokens: 5 }` 会被适配器**归一化**成 `tokensIn: 5`
  // （它认得替代字段名）。所以「字段名不认识」不是走到 `n()` 的办法，
  // 「值是坏的」才是。第一版这条写的就是前者，而它是红的——
  // 一条「实现比测试想得更聪明」的红，与「实现是错的」完全同形。
  const hub = fakeHub()
  const { boot } = await assemble({ hub, host: dshHost({ usage: { tokensIn: 7, tokensOut: '很多' } }) })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    const result = await provided.executor.execute(LEASE)
    // **不得判为完成**：这次运行声明了 token 上限，而用量只报了一半。
    // 用 0 补上缺的那一半会**低估**用量——一次实际超支的运行会被判成"未超"，
    // 而它是错的却看起来是对的。
    assert.notEqual(result.outcome, 'completed',
      `用量不完整时不得判为完成，实际 ${result.outcome}：${result.detail}`)
    assert.match(result.detail, /token|预算|BUDGET/i)

    const settle = hub.calls.find((c) => c.kind === 'settle')
    assert.ok(settle !== undefined, '必须走到结算')
    // **0 是一个断言**（"一个 token 都没花"），null 是"不知道"。
    // 把不知道写成 0，结算时就会宣称算清了。
    // 已知的一侧照实记，未知的一侧是 null——**不能补成 0**。
    assert.equal(settle.body.tokensIn, 7, '拿到的那个读数要照实记')
    assert.equal(settle.body.tokensOut, null,
      '没拿到的那一侧是"不知道"，不是"零"——写成 0 等于宣称算清了')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('③ 结算失败**不吞掉执行结果**（调用方仍要知道 outcome）', async () => {
  const hub = fakeHub({ settleStatus: 409 })
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.outcome, 'completed', '结算失败不该把已经跑完的结果变成异常')
    assert.equal(result.settlement.settled, false)
    assert.equal(result.settlement.code, 'BUDGET_SETTLE_FAILED')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

// ============================================================================
// ④ 没接的东西必须可见——在**全链路**上也一样
// ============================================================================

test('④ 没接预算闸门时，全链路结果里 `budgetState` 是 `not-gated` 且 hub 没收到账务请求', async () => {
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    // 两个身份来源**都不给** → 不建闸门。
    // （只不给 `LEGION_BUDGET_ACTOR` 是不够的：`LEGION_WORKER_ID` 会兜底，
    //   而那正是"闸门在真实部署里真的会被建起来"所依赖的那一层。）
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: {},
    })
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.outcome, 'completed')
    assert.equal(result.budgetState, 'not-gated')
    assert.equal(result.settlement, null)
    assert.equal(hub.order().filter((k) => k !== 'get-snapshot').length, 0,
      '没接闸门时一条账务请求都不该发出去')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

// ============================================================================
// ⑤ 接缝上抓到的两个真问题（各自单层的套件都看不见）
// ============================================================================

test('⑤ **记账主体必须能从生产路径传进来**（这是接缝上的一个真 bug）', async () => {
  // PRT-510 的套件把 `budgetActor` 直接传给 `createProductionExecutor`，
  // 而**生产路径根本不经过那一步**：`productionExecutorProvider` 只从 binding 里
  // 取 `{host, selfCheck, canRead}`，`budgetActor` 没有来源。
  // 于是闸门代码是对的、套件是全绿的，而**通过生产路径它永远不会被建起来**。
  //
  //   > 「注册了、跑了、过了」≠「这条路被测过」。
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub),
      env: { LEGION_BUDGET_ACTOR: 'w-from-env' },
    })
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.budgetState, 'bounded',
      '环境变量给了记账主体时闸门就必须被建起来；' +
      `实际 ${result.budgetState}——而 ${hub.order().filter((k) => k !== 'get-snapshot').length} 条账务请求说明它根本没接上`)
    const reserve = hub.calls.find((c) => c.kind === 'reserve')
    assert.equal(reserve.body.actor, 'w-from-env', '记账主体要一路传到账本里')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('⑤ 显式入参**优先于**环境变量（调用方要能覆盖部署默认值）', async () => {
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub),
      env: { LEGION_BUDGET_ACTOR: 'w-from-env' },
      budgetActor: 'w-explicit',
    })
    await provided.executor.execute(LEASE)
    assert.equal(hub.calls.find((c) => c.kind === 'reserve').body.actor, 'w-explicit')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('⑤ **没有 `LEGION_BUDGET_ACTOR` 时用 worker 自己的身份兜底**（否则闸门永不生效）', async () => {
  // 这一条补的是一个**具体代价**：Launcher 还没有往 worker 的环境里写
  // `LEGION_BUDGET_ACTOR`，所以如果只认那一个变量，闸门在真实部署里
  // **永远不会被建起来**——一次预算都没预留过。
  //
  //   > 一个默认不生效的闸门，与一个不存在的闸门，在"有没有拦住过"上是同一个答案。
  //
  // 兜底用 `LEGION_WORKER_ID` 而不是编一个占位符：那是这个进程**已经被赋予**的身份，
  // 它本来就要出现在 claim / heartbeat / transition 的每一笔记录里。
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub),
      env: { LEGION_WORKER_ID: 'worker-from-pid-4242' },
    })
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.budgetState, 'bounded', '有 worker 身份时闸门必须被建起来')
    assert.equal(hub.calls.find((c) => c.kind === 'reserve').body.actor, 'worker-from-pid-4242')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('⑤ 身份来源的**优先级**：显式 > BUDGET_ACTOR > WORKER_ID', async () => {
  const env = { LEGION_BUDGET_ACTOR: 'actor-env', LEGION_WORKER_ID: 'worker-id' }
  const cases = [
    [{ budgetActor: 'explicit' }, 'explicit'],
    [{}, 'actor-env'],
  ]
  for (const [over, expected] of cases) {
    const hub = fakeHub()
    const { boot } = await assemble({ hub })
    try {
      const provided = await productionExecutorProvider({
        post: hub.post.bind(hub), get: hub.get.bind(hub), env, ...over,
      })
      await provided.executor.execute(LEASE)
      assert.equal(hub.calls.find((c) => c.kind === 'reserve').body.actor, expected)
    } finally { boot.unbind?.(); resetDshRuntimeBinding() }
  }
})

test('⑤ 身份两端的空白被清掉（账本里不留「  w1  」与「w1」两行）', async () => {
  // 这条是给探针 ⑮③ 补的落点。原来那个探针（把 `clean` 的 trim 去掉）
  // **咬不住**：executor 自己还有一道 `budgetActor.trim() !== ''` 的守卫，
  // 于是空主体在**两层**都被挡住——这属于纵深防御，是好事情，
  // 但它意味着"空串"这个输入区分不出实现对错。
  //
  // 而 `trim` 本身是**可观察**的：不清空白的话，账本里会出现
  // 「  w1  」与「w1」两行，看上去是两个人。
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub),
      env: { LEGION_BUDGET_ACTOR: '  spaced-actor  ' },
    })
    await provided.executor.execute(LEASE)
    assert.equal(hub.calls.find((c) => c.kind === 'reserve').body.actor, 'spaced-actor')
    assert.equal(hub.calls.find((c) => c.kind === 'settle').body.actor, 'spaced-actor')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('⑤ **两个身份都没有 → 不建闸门**，且"没接"可见（不与"预算充足"同形）', async () => {
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: {},
    })
    const result = await provided.executor.execute(LEASE)
    assert.equal(result.budgetState, 'not-gated')
    assert.equal(result.settlement, null)
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

test('⑤ **费用未知不得当作未超预算**（适配器的事后判定，与账本是两套机制）', async () => {
  // 这条把两个机制的区别钉在端到端上：
  //   · Legion 的**账本**（PRT-510）在**事前**把钱占住；
  //   · 适配器的 `checkBudget` 在**事后**拿实际 usage 判一次。
  // 后者遇到 `maxCostUsd` 而没有价格表时**必须**报"费用未知、无法确认未超"，
  // 而不是放行——把"不知道"当成"没超"是这一处最容易写错的地方。
  const hub = fakeHub()
  const { boot } = await assemble({ hub })
  try {
    const provided = await productionExecutorProvider({
      post: hub.post.bind(hub), get: hub.get.bind(hub), env: { LEGION_BUDGET_ACTOR: 'w-e2e' },
    })
    const result = await provided.executor.execute({ ...LEASE, budget: { maxCostUsd: 5 } })
    assert.notEqual(result.outcome, 'completed',
      '没有价格表时"费用未知"，不得判为完成——未知不是"没超"')
    assert.match(result.detail, /BUDGET_EXCEEDED|费用|预算/)
    // 账本这一侧照旧有结论：预留了、也结算了。
    assert.equal(result.budgetState, 'bounded')
    assert.ok(hub.calls.some((c) => c.kind === 'settle'), '无论适配器怎么判，账务都必须有结论')
  } finally { boot.unbind?.(); resetDshRuntimeBinding() }
})

// ============================================================================
// ⑥ 装配是**幂等可重入**的：一次装配对应一份注册
// ============================================================================

test('⑤ 连续装配两次 → 第二次的 `unbind` 不会把第一次的注册也拆掉', async () => {
  resetDshRuntimeBinding()
  const a = await assemble()
  assert.equal(a.boot.ok, true)
  const b = await assemble({ reset: false })
  assert.equal(b.boot.ok, true)

  // **乱序**注销才是能区分对错的那一种：
  // 先拆**前**装的那一个。正确的实现是 no-op（现在生效的是 B，不是 A 那一份）；
  // 而"无条件写回 previous"的实现会把 B 一起抹掉——
  // 表现是"worker 突然拿不到引擎了"，而没有任何东西报错。
  a.boot.unbind()
  assert.equal(dshRuntimeBound(), true,
    '注销**前**一次装配不该影响后一次——无条件写回 previous 就会抹掉它')

  // 再拆掉**后**装的那一个。
  b.boot.unbind()
  // 前一个还在（它是另一次装配的注册）。这条是 `bindDshRuntime` 里
  // "记住 mine" 那个修法的端到端体现：不记住的话，第二次 unbind
  // 会把第一次的注册一并清掉，而表现是"worker 突然拿不到引擎了"。
  assert.equal(dshRuntimeBound(), false, '两次都注销之后才该回到未绑定')
  resetDshRuntimeBinding()
})
