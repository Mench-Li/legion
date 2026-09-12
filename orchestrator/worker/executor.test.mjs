// orchestrator/worker/executor.test.mjs
// ============================================================================
// 生产执行引擎接线（PRT-253：单员工、无自动交接的黄金任务）
//
// ## 这一组守的是什么
//
// 上下文装配（PRT-401~413）交付了一整套机器并且**每件都有套件、全绿**，
// 而 `executor` 默认 `null`——**没有任何真实部署走过那条路**。
//
//   > 一个功能没有入口，与一个功能不存在，在用户看来完全一样。
//
// 所以这一组问三个问题：
//
//   ① **冻结的正文是不是真的被当成模型的输入？**（本模块唯一重要的不变量）
//      一份被冻结、被哈希、被审计、然后**没有被用上**的上下文，
//      与一份从未被冻结的上下文，在"模型看到了什么"这个问题上是同一个答案。
//   ② **三道拒绝是不是拒绝，而不是降级？** 自检未过 / 缺宿主端口 /
//      没有冻结快照——三条都必须**停下来**。一个能跑但强制面没生效的引擎，
//      与一个正常的引擎在行为上完全一样，直到它执行了第一次真实的写操作。
//   ③ **拒绝的理由说得清吗？** "自检没过"、"缺端口"、"忘了配 hub"
//      三种修复动作完全不同的处境，不能长得一模一样。
//
// 全程用**假宿主端口**：适配器本来就只认识注入的端口（`runtime/adapters/dsh/port.mjs`
// 的设计取舍），所以这条接线能在不启动 DSH 的前提下被完整测到。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProductionExecutor, EXECUTOR_CODES, defaultRequestFor } from './executor.mjs'
import { validateRunRequest } from '../../runtime/contracts/run.mjs'
import {
  bindDshRuntime, dshRuntimeBound, resetDshRuntimeBinding,
  productionExecutorProvider, productionExecutorProviderFromEnv, hubIo,
} from './executor-binding.mjs'

const NOW = 1_700_000_000_000
const FROZEN_TEXT = '这是冻结下来的正文-FROZEN-BODY'

/** 一个自检通过的结论。 */
const CHECK_OK = Object.freeze({ state: 'effective', autoExecutionForbidden: false, reasons: [] })
/** 一个自检未过的结论。 */
const CHECK_BAD = Object.freeze({
  state: 'incompatible', autoExecutionForbidden: true,
  reasons: ['composition-patch-layer: 补丁层未生效', 'sandbox-enforcement: 沙箱未提供 full 级管制'],
})

/**
 * 假宿主端口。`result` 默认**立即成功结算**——这一组要验的是接线，
 * 不是看门狗（看门狗在 adapters/dsh 自己的套件里有）。
 */
function makeHost({ structured = { ok: true }, stopReason = 'completed', throwOnRun = null } = {}) {
  const calls = { startRun: [], probeRuntime: 0 }
  return {
    calls,
    currentModelSelection: () => ({ provider: 'deepseek', model: 'v4' }),
    async probeRuntime() {
      calls.probeRuntime += 1
      return { version: '0.1.5-rc.2', capabilities: { structuredOutput: true, streaming: true, cancel: true, events: true } }
    },
    async startRun(provider, options) {
      calls.startRun.push({ provider, options })
      if (throwOnRun !== null) throw new Error(throwOnRun)
      return { result: Promise.resolve({ stopReason, structured }), dispose: async () => {} }
    },
  }
}

/**
 * 假 hub：只实现这一条接线真正用到的两条路。
 *
 * `frozen: false` 时 GET 返回 404 —— 即"这个 Attempt 没有冻结快照"。
 */
function makeHub({ frozen = true, verified = true, finalText = FROZEN_TEXT, getStatus = null } = {}) {
  const calls = { post: [], get: [] }
  return {
    calls,
    async post(path, body) {
      calls.post.push({ path, body })
      return {
        status: 200,
        body: {
          ok: true, snapshotHash: 'sha256:fixture',
          snapshot: { sources: [{ id: 'a' }], excluded: [], truncations: [], redactions: [], tokens: { kind: 'exact', tokens: 7 }, finalText },
        },
      }
    },
    async get(path) {
      calls.get.push({ path })
      if (getStatus !== null) return { status: getStatus, body: { ok: false, error: '模拟' } }
      if (!frozen) return { status: 404, body: { ok: false, code: 'CONTEXT_NOT_FOUND', error: '没有这份上下文快照' } }
      return {
        status: 200,
        body: {
          ok: true, snapshotHash: 'sha256:fixture',
          verification: { ok: verified, attemptId: 'att:1', storedHash: 'sha256:fixture', recomputedHash: verified ? 'sha256:fixture' : 'sha256:other' },
          snapshot: { finalText, sources: [], excluded: [], truncations: [], redactions: [], tokens: { kind: 'exact', tokens: 7 }, associations: { goalId: 'g1', taskId: 'T-1', employeeId: 'e1', teamPlanId: 'tp1' } },
        },
      }
    },
  }
}

const LEASE = Object.freeze({
  attemptId: 'att:1', taskId: 'T-1', scope: 'default', leaseEpoch: 1,
  idempotencyKey: 'idem:T-1', workerId: 'w1',
  goalId: 'g1', employeeId: 'e1', teamPlanRef: 'tp1', workdir: 'C:/tmp/ws',
  // 这两个**猜不出来**：它们是"在哪个目录里、用哪个模型跑"。
  workspaceId: 'ws-1', modelProfileRef: 'mp-1',
})

async function build(over = {}) {
  const hub = over.hub ?? makeHub()
  const host = over.host === undefined ? makeHost() : over.host
  // `'selfCheck' in over` 而不是 `??`：显式传 `null` 是**在测"没给自检"**，
  // 而 `??` 会把它换成默认的"通过"——那样这一条就在测它自己的兜底。
  const selfCheck = 'selfCheck' in over ? over.selfCheck : (async () => CHECK_OK)
  return {
    hub,
    host,
    result: await createProductionExecutor({
      post: hub.post, get: hub.get, canRead: () => true,
      selfCheck,
      clock: () => NOW,
      ...(host === null ? {} : { host }),
      ...(over.extra ?? {}),
    }),
  }
}

// ============================================================================
// ① 唯一的那个不变量：冻结的正文就是模型的输入
// ============================================================================

test('① **提示词就是快照里的正文**，一个字节都不自己拼', async () => {
  const { result, host, hub } = await build()
  assert.equal(result.ok, true, JSON.stringify(result))
  const r = await result.executor.execute(LEASE)
  assert.equal(r.outcome, 'completed')

  // 引擎收到的提示词
  assert.equal(host.calls.startRun.length, 1, '必须恰好发起一次运行')
  const sent = host.calls.startRun[0].options

  // 而且**是先读回快照、再发起运行**——顺序反了的话，正文可能来自别处。
  assert.equal(hub.calls.get.length, 1, '执行前必须读回一次快照')
  assert.match(hub.calls.get[0].path, /^\/api\/context-snapshots\/att%3A1\?verify=1$/,
    '必须带 ?verify=1：一次执行要用一份记录当输入，"这份记录没被改过"得在那之前确认')

  // ⚠️ 上面这几条**只证明正文在请求里**，不证明适配器把它当提示词用了。
  // 第一版就栽在这里：适配器那时自己拼了一份
  // `任务：…\n目标：…\n员工：…\n验收：…`，冻结的正文躺着没人看，
  // 而这几条断言**全绿**。所以下面单独再断言真正发出去的那段文本。
  const sentText = sent.prompt?.[0]?.text ?? ''
  assert.equal(sentText, FROZEN_TEXT,
    '适配器发出去的提示词必须**就是**冻结的正文（原样，不外包一层标签）——' +
    `实际是 ${JSON.stringify(sentText.slice(0, 120))}`)
  assert.ok(!sentText.includes('验收：'), '不得把阶段 2 的最小包装混进来：那会改掉 finalText，与快照里存的对不上')
})

test('① `contextSnapshotRef` 指向**本次 Attempt 的快照**（不是空的、也不是别的）', async () => {
  // 通过 requestFor 的默认实现直接验一遍形状
  const snap = { finalText: FROZEN_TEXT, associations: { goalId: 'g1', taskId: 'T-1', employeeId: 'e1', teamPlanId: 'tp1' } }
  const built = defaultRequestFor(LEASE, snap)
  assert.equal(built.contextSnapshotRef, 'att:1')
  assert.equal(built.prompt, FROZEN_TEXT)
  assert.equal(built.attemptId, 'att:1')
  // 契约要求的 15 个字段一个不少——少一个适配器就会在 validateRunRequest 拒绝，
  // 而那次拒绝发生在**运行之前**，所以这里必须一次给全。
  for (const k of ['runId', 'attemptId', 'idempotencyKey', 'workspaceId', 'goalId', 'taskId',
    'employeeId', 'teamPlanRef', 'contextSnapshotRef', 'modelProfileRef', 'budget',
    'timeoutMs', 'workdir', 'permissions', 'expectedOutput']) {
    assert.ok(k in built, `RunRequest 缺必填字段 ${k}`)
  }
  // 而且它**真的能过适配器的校验**——上面那个循环只证明键存在，
  // 证明不了值是合法的（第一版把拿不到的字段填 ''，键齐全但校验不过）。
  const check = validateRunRequest(built)
  assert.equal(check.ok, true, `默认 RunRequest 必须过契约校验：${JSON.stringify(check.errors)}`)
  // expectedOutput.schema 缺失时适配器是 **fail closed** 的：一次"没声明输出形状"
  // 的执行会在最后一刻失败，而那时 token 已经花掉了。
  assert.ok(built.expectedOutput.schema !== undefined && built.expectedOutput.schema !== null,
    'expectedOutput.schema 必须有：缺了它适配器在跑完之后才发现，钱已经花了')
})

test('① 缺必填字段时**在本地一次说清缺哪些**，而不是让适配器在两跳之外报"必填"', async () => {
  // 第一版把拿不到的字段填 `''`，于是适配器报「workspaceId 必填；
  // modelProfileRef 必填」——那已经离真因很远了：真因是这次 lease 里没有工作区。
  // 两跳之外的报错会把排障指向适配器，而不是指向那个没传值的调用方。
  const snapshot = { finalText: FROZEN_TEXT, associations: { goalId: 'g1', taskId: 'T-1', employeeId: 'e1', teamPlanId: 'tp1' } }
  assert.throws(() => defaultRequestFor({ attemptId: 'att:1' }, snapshot), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.BAD_WIRING)
    // 缺的要**逐个点名**，不是一句"缺字段"。
    assert.deepEqual(e.missing, ['workspaceId', 'modelProfileRef', 'workdir'])
    assert.match(e.message, /workspaceId/)
    return true
  })
  // 唯独能从快照的 associations 里取的，允许不传 lease
  const built = defaultRequestFor(
    { attemptId: 'att:1', workspaceId: 'ws', modelProfileRef: 'mp', workdir: 'C:/tmp/ws' },
    snapshot,
  )
  assert.equal(built.goalId, 'g1')
  assert.equal(built.teamPlanRef, 'tp1')
})

test('① `requestFor` 可以把 lease 与快照翻成自己的 RunRequest', async () => {
  const seen = []
  const { result } = await build({
    extra: {
      requestFor: (lease, snapshot) => {
        seen.push({ lease: lease.attemptId, text: snapshot.finalText })
        return { ...defaultRequestFor(lease, snapshot), modelProfileRef: 'mp-legion-default' }
      },
    },
  })
  await result.executor.execute(LEASE)
  assert.deepEqual(seen, [{ lease: 'att:1', text: FROZEN_TEXT }], 'requestFor 必须同时拿到 lease 与**冻结后的**快照')
})

test('① 终态 `run.failed` → `failed`，且理由可读（不是把整个结果塞进 detail）', async () => {
  const { result } = await build({ host: makeHost({ stopReason: 'error' }) })
  const r = await result.executor.execute(LEASE)
  assert.equal(r.outcome, 'failed')
  assert.equal(typeof r.detail, 'string')
  assert.ok(r.detail.length > 0 && r.detail.length < 400, `detail 应当是给运维的一句话，实际 ${r.detail?.length} 字`)
})

test('① 引擎抛错 → 以失败终态回来（适配器把引擎故障分类成终态，不往外抛）', async () => {
  // 这一条第一版写成 `assert.rejects`——它红了，而红的原因是**我猜错了契约**：
  // 适配器刻意把引擎侧的异常分类成终态事件（`run.failed` 等）而不是往外抛。
  // 那是对的设计：一次引擎故障是一条**有名字的结论**，不是一个栈。
  // 真正要守的是"它没有变成静默成功"。
  const { result } = await build({ host: makeHost({ throwOnRun: '引擎炸了' }) })
  const r = await result.executor.execute(LEASE)
  assert.notEqual(r.outcome, 'completed', '引擎炸了绝不能被当成完成')
  assert.equal(typeof r.detail, 'string')
})

// ============================================================================
// ② 三道拒绝——都是拒绝，不是降级
// ============================================================================

test('② **自检未过 → 不构造执行引擎**（不是"能力弱一点"的引擎）', async () => {
  const { result } = await build({ selfCheck: async () => CHECK_BAD })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.equal(result.executor, undefined, '自检没过时**不能**有 executor')
  // 理由要能带到运维面前：只说"自检没过"还要再猜是哪一项。
  assert.deepEqual(result.reasons, [...CHECK_BAD.reasons])
})

test('② **不给自检结果视为未过**（"没检查"不等于"没问题"）', async () => {
  const { result } = await build({ selfCheck: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE)
  assert.match(result.message, /没检查|没做过自检/)
})

test('② 自检结果**形状不对**同样 fail closed', async () => {
  // `{}` 时 `autoExecutionForbidden === true` 读到的是 false，于是会**放行**。
  // 形状错误被当成通过，是这条闸门最容易漏的一种失效。
  for (const bad of [{}, { state: 'effective' }, null, 'effective']) {
    const { result } = await build({ selfCheck: async () => bad })
    assert.equal(result.ok, false, `自检返回 ${JSON.stringify(bad)} 时必须拒绝`)
    assert.equal(result.code, EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE)
  }
})

test('② 自检**自身抛错** → 拒绝（不是"当它通过了"）', async () => {
  const { result } = await build({ selfCheck: async () => { throw new Error('探测进程起不来') } })
  assert.equal(result.ok, false)
  assert.match(result.message, /探测进程起不来/)
})

test('② **缺宿主端口 → 拒绝**，且理由指出该找谁', async () => {
  const { result } = await build({ host: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
  assert.match(result.message, /PRT-214|组合层/, '理由要指向该修的那一层')
})

test('② 端口形状不合法 → 在**构造时**拒绝（不是等到执行才炸）', async () => {
  // 等到 execute 才炸会把"配置错了"表现成"运行时崩了"，误导排障方向。
  const { result } = await build({ host: {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
})

test('② **没有冻结快照 → 抛出**（不是"用空上下文继续"）', async () => {
  const { result } = await build({ hub: makeHub({ frozen: false }) })
  assert.equal(result.ok, true)
  await assert.rejects(() => result.executor.execute(LEASE), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.CONTEXT_NOT_FROZEN)
    assert.match(e.message, /空上下文/, '理由要说清为什么不降级')
    return true
  })
})

test('② **快照验不过哈希 → 抛出**（不许拿一份验不过的记录当输入）', async () => {
  const { result } = await build({ hub: makeHub({ verified: false }) })
  await assert.rejects(() => result.executor.execute(LEASE), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.CONTEXT_UNVERIFIED)
    return true
  })
})

test('② 快照读回失败（非 404 的状态码）→ 抛出，并带上真实状态码', async () => {
  const { result } = await build({ hub: makeHub({ getStatus: 500 }) })
  await assert.rejects(() => result.executor.execute(LEASE), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.CONTEXT_NOT_FROZEN)
    assert.match(e.message, /500/)
    return true
  })
})

test('② 缺 `canRead` / `post` / `get` → 构造时拒绝', async () => {
  const hub = makeHub()
  const base = { post: hub.post, get: hub.get, canRead: () => true, selfCheck: async () => CHECK_OK, host: makeHost() }
  for (const drop of ['post', 'get', 'canRead']) {
    const deps = { ...base }
    delete deps[drop]
    const r = await createProductionExecutor(deps)
    assert.equal(r.ok, false, `缺 ${drop} 必须拒绝`)
    assert.equal(r.code, EXECUTOR_CODES.BAD_WIRING)
  }
})

// ============================================================================
// ③ 装配阶段真的接上了（不是只挂在对象上）
// ============================================================================

test('③ `buildContext` 走的是 hub 侧的装配路由（冻结与持久化都在那边）', async () => {
  const { result, hub } = await build()
  const d = await result.executor.buildContext({ ...LEASE })
  assert.equal(d.kind, 'frozen')
  assert.equal(d.assembledBy, 'hub', '要能看出装配发生在 hub 那一侧')
  assert.equal(hub.calls.post.length, 1)
  assert.equal(hub.calls.post[0].path, '/api/context-snapshots/assemble')
  assert.equal(hub.calls.post[0].body.attemptId, 'att:1')
  assert.equal(hub.calls.post[0].body.scope, 'default')
  // 权限**由调用方显式回答**，不是路由默认放行。
  assert.equal(hub.calls.post[0].body.canReadAll, true)
})

// ============================================================================
// ④ 绑定口：装上了就开始干活，且注销得掉
// ============================================================================

test('④ 未绑定时提供者给出**具名**拒绝（不是一句"没配"）', async () => {
  resetDshRuntimeBinding()
  const hub = makeHub()
  const r = await productionExecutorProvider({ post: hub.post, get: hub.get })
  assert.equal(r.ok, false)
  assert.equal(r.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
  assert.match(r.message, /dsh-composition|DSH 进程/, '理由要指出绑定该由谁完成')
})

test('④ **装上端口之后，同一个入口就开始真的执行**（不需要改代码）', async () => {
  resetDshRuntimeBinding()
  const hub = makeHub()
  const host = makeHost()
  const unbind = bindDshRuntime({
    host, selfCheck: async () => CHECK_OK, canRead: () => true, clock: () => NOW,
  })
  try {
    assert.equal(dshRuntimeBound(), true)
    const r = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(r.ok, true, JSON.stringify(r))
    const out = await r.executor.execute(LEASE)
    assert.equal(out.outcome, 'completed')
    assert.ok(host.calls.startRun.length === 1)
  } finally { unbind() }
})

test('④ 注销之后又回到拒绝（绑定是进程级副作用，必须可撤销）', async () => {
  resetDshRuntimeBinding()
  const hub = makeHub()
  const unbind = bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK, canRead: () => true })
  assert.equal(dshRuntimeBound(), true)
  unbind()
  assert.equal(dshRuntimeBound(), false)
  const r = await productionExecutorProvider({ post: hub.post, get: hub.get })
  assert.equal(r.ok, false)
  assert.equal(r.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
})

test('④ `bindDshRuntime` 拒收缺 `selfCheck` / `canRead` 的绑定', async () => {
  resetDshRuntimeBinding()
  // 一个"没给自检就当通过"的默认值，会让这个注册口本身变成绕过 PRT-215 的入口。
  assert.throws(() => bindDshRuntime({ host: makeHost(), canRead: () => true }), /selfCheck/)
  assert.throws(() => bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK }), /canRead/)
})

test('④ 自检**在绑定时不跑、在构造时才跑**（结论过期了就要重算）', async () => {
  resetDshRuntimeBinding()
  const hub = makeHub()
  let runs = 0
  const unbind = bindDshRuntime({
    host: makeHost(),
    selfCheck: async () => { runs++; return runs === 1 ? CHECK_OK : CHECK_BAD },
    canRead: () => true,
  })
  try {
    const first = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(first.ok, true, '第一次：自检通过')
    const second = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(second.ok, false, '第二次：自检没过就必须拒绝——一次通过的结论不能一直沿用')
    assert.equal(second.code, EXECUTOR_CODES.SELF_CHECK_INCOMPATIBLE)
  } finally { unbind() }
})

test('④ 缺 `TEAM_HUB_URL` → 具名拒绝（worker 仍要能起来报告自己干不了活）', async () => {
  resetDshRuntimeBinding()
  const r = await productionExecutorProviderFromEnv({ env: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, EXECUTOR_CODES.BAD_WIRING)
  assert.match(r.message, /TEAM_HUB_URL/)
})

// ============================================================================
// ⑤ hubIo：只做带 token 与解包，不吞异常
// ============================================================================

test('⑤ `hubIo` 每条请求都带 token，并把响应解成 `{status, body}`', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization })
    return { status: 200, text: async () => JSON.stringify({ ok: true }) }
  }
  const io = hubIo({ hubUrl: 'http://127.0.0.1:9/', hubToken: 'T0K', fetchImpl })
  const p = await io.post('/api/x', { a: 1 })
  assert.deepEqual(p, { status: 200, body: { ok: true } })
  const g = await io.get('/api/y')
  assert.equal(g.status, 200)
  assert.deepEqual(seen.map((s) => s.url), ['http://127.0.0.1:9/api/x', 'http://127.0.0.1:9/api/y'],
    '结尾的斜杠要被规整掉，否则会拼出 //api')
  assert.deepEqual(seen.map((s) => s.method), ['POST', 'GET'])
  for (const s of seen) assert.equal(s.auth, 'Bearer T0K')
})

test('⑤ `hubIo` 缺 `hubUrl` 时抛错（不是造一个看起来能用的空壳）', () => {
  // 空壳会让每一次执行都失败在一个与真因无关的地方。
  assert.throws(() => hubIo({ hubUrl: '' }), /TEAM_HUB_URL/)
  assert.throws(() => hubIo({}), /TEAM_HUB_URL/)
})

test('⑤ 非 JSON 响应如实返回文本（不是把它当成一个成功的空对象）', async () => {
  const fetchImpl = async () => ({ status: 502, text: async () => '<html>bad gateway</html>' })
  const io = hubIo({ hubUrl: 'http://h', hubToken: '', fetchImpl })
  const r = await io.get('/api/z')
  assert.equal(r.status, 502)
  assert.equal(r.body, '<html>bad gateway</html>')
})
