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

import { createProductionExecutor, EXECUTOR_CODES, defaultRequestFor, deriveRunFloorCarrier, permissionsFromLease, UNSUPPLIED_PERMISSIONS } from './executor.mjs'
import { validateRunRequest } from '../../runtime/contracts/run.mjs'
// 判据取**产品**的那几份，不在用例里另抄：
//   · `readRunFloor` 是传输层判定线上载荷的那一个函数；
//   · `createHardFloorGuard` 是真 guard（⑥ 最后一条要在它身上读名字空间）；
//   · `resolveTool` 是真能力目录的解析口（"解析口被注入了什么"必须是可读的）。
import { RUN_FLOOR_STATES, RUN_FLOOR_WIRE_FIELD, RUN_FLOOR_WIRE_VERSION, readRunFloor } from '../../runtime/contracts/run-floor.mjs'
import { createHardFloorGuard } from '../../runtime/dsh-composition/enforcement.mjs'
import { resolveTool as resolveLegionTool } from '../../runtime/dsh-composition/tool-capability.mjs'
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
  // ★ 权限档位（PRT-214 缺口①之后它**必须**在这里）：静态 hard floor 由它派生。
  //   真 `claim()` 回来的 lease 上**没有**这个字段，而那种情况现在是**具名拒绝**
  //   （见 ⑥ `RUN_FLOOR_NOT_DERIVED`）——不是"编一份空档位继续跑"。
  permissions: Object.freeze({ preset: 'legion-attended', tools: Object.freeze(['read-file']) }),
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

// 注入一个只会按剧本发事件的适配器。
//
// 为什么要**换掉适配器**而不是用默认的：这一组要验的是
// 「终态事件里的 `result` → `execute()` 返回值」这一段接线，
// 与真实适配器内部怎么造那个 `result` 无关。用剧本适配器就能让
// "我给的原文"与"它还回来的原文"逐字对齐，不受适配器字段演化的影响。
function makeAdapter(events) {
  return () => ({
    async probe() { return { ok: true, version: 'scripted', capabilities: {} } },
    async *execute() { for (const e of events) yield e },
  })
}

test('① ★★ 终态事件的 RunResult 被**原样**带回：`r.runResult` 就是引擎说过的那份', async () => {
  // hub 侧 `Running → Validating / RetryableFailure / UnknownOutcome` 三条边声明的
  // `requiresPersist: ['attempt','runResult']`，其凭据**只能从这里出去**。
  //
  // 这一条是补上来的：我的端到端用例（run-plane-e2e）用的执行器是**替身**
  // （直接返回 `{outcome, runResult}`），它压根不走 `executor.mjs`。于是
  // "删掉 executor 侧这一行"在那边**一条红都不会有**——破验 M7 就是这么发现的。
  //
  //   > 一个"引擎原文会从这里带出去"的设计，
  //   > 与一个"这一行被删了、只是没人发现"的设计，
  //   > 在所有只断言 outcome/detail 的用例下长得一模一样。
  const ENGINE_RESULT = {
    runId: 'run-att-1', attemptId: 'att:1', outcome: 'succeeded', code: null,
    output: '模型说：做完了', usage: { inputTokens: 3, outputTokens: 5 },
  }
  const { result } = await build({
    extra: {
      adapterFactory: makeAdapter([
        { type: 'run.started', seq: 1, at: NOW, runId: 'run-att-1' },
        { type: 'run.completed', seq: 2, at: NOW, runId: 'run-att-1', result: ENGINE_RESULT },
      ]),
    },
  })
  const r = await result.executor.execute(LEASE)
  // 终态类型 → 结局：走契约里的 `TERMINAL_TO_OUTCOME`，不是我在这里另写一遍
  assert.equal(r.outcome, 'completed', JSON.stringify(r))
  assert.deepEqual(r.runResult, ENGINE_RESULT,
    '引擎给的 RunResult 必须**逐字**带出来。丢了它，hub 侧那条 requiresPersist 就没有凭据')
  // 它**不是**那段给人看的摘要
  assert.notEqual(typeof r.runResult, 'string')
  assert.equal(typeof r.detail, 'string', 'detail 仍然是给运维的一句话，两者并存')
  // 引擎口径原样保留（`succeeded`），本层不做翻译——翻译只发生在读的人那里
  assert.equal(r.runResult.outcome, 'succeeded')
})

test('① ★ 没有终态事件时 `runResult` 必须是 **null**（不编一个空对象顶上）', async () => {
  // `terminal === null` 时引擎确实没产出结果，`outcome` 已经是 `outcome_unknown`。
  // 编个 `{}` 顶上去，会让 hub 那条记录看起来像"引擎给了结果，只是内容是空的"，
  // 而真相是"引擎什么都没说"。
  const { result } = await build({
    extra: { adapterFactory: makeAdapter([{ type: 'run.started', seq: 1, at: NOW, runId: 'run-x' }]) },
  })
  const r = await result.executor.execute(LEASE)
  assert.equal(r.outcome, 'outcome_unknown')
  assert.equal(r.runResult, null, '没有终态事件就没有 RunResult，如实写 null')
})

test('① ★ 终态事件**没带** `result` 时也是 null，不得编个 `{}` 顶上', async () => {
  // 契约（`runtime/contracts/run.mjs` 的 `validateRunEvent`）要求终态事件**必须**
  // 携带或引用 RunResult，所以这里是"适配器违约"的情形。违约了也不能由本层替它编：
  // 一个 `{}` 记进库里，事后看就是"引擎给了结果，只是内容是空的"，
  // 而真相是"引擎没说它跑出了什么"。
  //
  // 这一条是破验 M9（把 `?? null` 改成 `?? {}`）逼出来的：我原先只测了
  // "没有终态事件"，没测"有终态事件但没带 result"——而后者才是那个兜底会发作的地方。
  const { result } = await build({
    extra: {
      adapterFactory: makeAdapter([
        { type: 'run.completed', seq: 1, at: NOW, runId: 'run-y' },   // 刻意不带 result
      ]),
    },
  })
  const r = await result.executor.execute(LEASE)
  assert.equal(r.outcome, 'completed', '终态类型仍然决定结局：这一条与结果缺失是两件事')
  assert.equal(r.runResult, null, '引擎没给结果就如实记 null，不代笔')
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

test('④ `bindDshRuntime` 拒收缺 `selfCheck`；`canRead` 缺席**合法**（如实记成 null）', async () => {
  resetDshRuntimeBinding()
  // 一个"没给自检就当通过"的默认值，会让这个注册口本身变成绕过 PRT-215 的入口。
  assert.throws(() => bindDshRuntime({ host: makeHost(), canRead: () => true }), /selfCheck/)

  // ★ `canRead` 缺席**不再**是注册口的拒绝理由（Runtime 进程里没有任何东西读它，
  //   见 executor-binding.mjs 的 `bindDshRuntime` 说明）。注册口收下它，
  //   并且把这一缺席如实记成一个分得开的值——拦它的是**真正要执行的那一侧**。
  const unbind = bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK })
  try {
    assert.equal(dshRuntimeBound(), true, 'canRead 缺席不该拦下绑定')
  } finally { unbind(); resetDshRuntimeBinding() }

  // 但"挂一个不是函数的 canRead"仍然当场拒：静默丢掉它，就再没有人看得出有人试图挂它。
  assert.throws(() => bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK, canRead: 'yes' }), /canRead/)
  assert.equal(dshRuntimeBound(), false, '抛了却仍然注册上了')
  resetDshRuntimeBinding()
})

test('④ ★★ 绑定在、但 `canRead` 缺席 → 同进程 provider 仍然 fail closed（`EXECUTOR_CAN_READ_REQUIRED`）', async () => {
  // 这是本批**最容易被悄悄放松**的那条不变量：`bindDshRuntime` 现在允许缺席，
  // 如果 `productionExecutorProvider()` 不再检查，一次绑定就会变成一个
  // "谁都能读"的引擎，而没有任何读数会变。
  resetDshRuntimeBinding()
  const hub = makeHub()
  const unbind = bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK })
  try {
    const r = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(r.ok, false, `同进程这条路放过了没有 canRead 的绑定：${JSON.stringify(r).slice(0, 200)}`)
    assert.equal(r.code, EXECUTOR_CODES.CAN_READ_REQUIRED,
      `拒绝码不是那个具名的权限码（收到 ${r.code}）——笼统的接线码会把排障指向错的地方`)
    assert.equal(r.innerCode, null, '这是**本进程**的拒绝，不该伪装成一次对端拒绝')
  } finally { unbind() }

  // 反向对照：同一个形状 + 一个**函数** canRead → 引擎造得出来。
  // 没有这一条，"一律拒绝"与"真的读了绑定里的那个值"就分不开。
  const unbindOk = bindDshRuntime({ host: makeHost(), selfCheck: async () => CHECK_OK, canRead: () => true })
  try {
    const ok = await productionExecutorProvider({ post: hub.post, get: hub.get })
    assert.equal(ok.ok, true, `给了 canRead 之后仍然造不出引擎：${JSON.stringify(ok).slice(0, 300)}`)
  } finally { unbindOk(); resetDshRuntimeBinding() }
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

// ============================================================================
// ⑥ PRT-214 缺口①：那次 Run 的静态 hard floor **终于有人生产了**
// ============================================================================
//
// 这一组守的是此前**搬运全绿、却空着**的那一格：
//
//   > 一个"下限的搬运与安装都做对了、只是从来没有人生产过下限"的部署，
//   > 与一个"下限已经接上生产"的部署，在只看那几个套件的时候是同一个东西——
//   > 只不过前者的 guard 里装的永远是一份**没有来源**的空装配。
//
// 判据分两半，缺一不可：
//
//   · **生产**：`execute()` 把**这一次**的权限档位翻成下限，而且它真的出现在
//     适配器交出去的端口选项上（读点是 `host.calls.startRun[0].options`）；
//   · **不生产时的处置**：派生不出来时**不派发**（不是空名单、不是缺席），
//     而且拒绝码就是权限档位本身给出的那个码。
//
// ★ 另一半**故意留在这里不修**：派生出来的名单写的是 Legion 的**工具名**，
//   而 guard 比的是执行面的工具名。本组最后一条把这个缺口读出来。

/** 一份把权限档位换掉的 lease。 */
function leaseWith(tools, over = {}) {
  return Object.freeze({
    ...LEASE,
    permissions: Object.freeze({ preset: 'legion-attended', tools: Object.freeze(tools) }),
    ...over,
  })
}

test('⑥ ★★ 下限来自**这一次**的权限档位，而且真的交到了端口上', async () => {
  const { result, host } = await build()
  const r = await result.executor.execute(leaseWith(['read-file', 'git-push']))
  assert.equal(r.outcome, 'completed')

  assert.equal(host.calls.startRun.length, 1)
  const carried = host.calls.startRun[0].options.enforcementFloor
  assert.equal(carried.state, 'installed',
    `端口收到的不是"装填"那一档：${JSON.stringify(carried)}`)
  // ★ 进去的是**执行面**名字：`git-push` 只有在 shell 那一对名字上才能被拒。
  //   放 `git-push` 自己进去是拦不住的（guard 比的是 `execution.name`）。
  assert.deepEqual([...carried.floor.denyTools], ['bash', 'pwsh'],
    '下限里没有这一档里那个带不可逆能力的工具——那它就不是从权限档位派生出来的')
  assert.equal(carried.floor.cwd, 'C:/tmp/ws', 'cwd 要跟着这次 Run 走（guard 靠它规范化路径）')
  assert.equal(carried.floor.platform, process.platform)
})

test('⑥ ★ 换一份权限档位，下限跟着换（不是 DEFAULT_HARD_FLOOR、也不是常量）', async () => {
  // 判别项是**两次读数不同**：一份写死的下限（或一份空装配）会让两次一样。
  const a = await build()
  await a.result.executor.execute(leaseWith(['read-file']))
  const b = await build()
  await b.result.executor.execute(leaseWith(['read-file', 'git-push']))

  const floorA = a.host.calls.startRun[0].options.enforcementFloor
  const floorB = b.host.calls.startRun[0].options.enforcementFloor
  assert.deepEqual([...floorA.floor.denyTools], [],
    '只授权了 read-file 的一次 Run 不该有任何静态禁止项')
  assert.deepEqual([...floorB.floor.denyTools].sort(), ['bash', 'pwsh'])
})

test('⑥ ★★★ 能力目录不认识的工具 ⇒ **不派发** + 具名拒绝（不是"进名单就算禁了"）', async () => {
  // ★ 本批之前这一条断言的是"`ghost-tool` 进了 `denyTools`"。那个读数**看起来**
  //   是"未知工具被禁了"，实际上名单里放的是一个执行面认不出的名字——
  //   guard 谁也没拦住。未知工具在**这一层**禁不了，于是它与 hosted 那两个
  //   落到同一个处置：整次 Run 具名拒绝。
  const { result, host } = await build()
  await assert.rejects(() => result.executor.execute(leaseWith(['read-file', 'ghost-tool'])), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED)
    assert.equal(e.refusalCode, 'run-floor-hard-floor-not-enforceable-at-plane',
      `拒绝码不是"硬底线在这一层表达不了"（收到 ${e.refusalCode}）`)
    assert.ok(Array.isArray(e.refusals) && e.refusals.includes('run-floor-hard-floor-not-enforceable-at-plane'))
    return true
  })
  // 两件"没发生"的事：**一个字节都没有派发**。
  assert.equal(host.calls.startRun.length, 0, '下限都没派生出来，却已经把 Run 派发出去了')
  assert.equal(host.calls.probeRuntime, 0, '探测跑了——顺序反了')
})

test('⑥ ★★★ 硬底线里**执行面上没有名字**的那些（hosted）：也是不派发', async () => {
  // `HARD_FLOOR_CAPABILITIES` 三个里两个（`file:delete` / `credential:write`）
  // 由 Legion 宿主平面提供，执行面上没有名字可以让 guard 去拒。
  for (const tool of ['delete-file', 'write-secret']) {
    const { result, host } = await build()
    await assert.rejects(() => result.executor.execute(leaseWith(['read-file', tool])), (e) => {
      assert.equal(e.code, EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED, tool)
      assert.equal(e.refusalCode, 'run-floor-hard-floor-not-enforceable-at-plane', tool)
      return true
    })
    assert.equal(host.calls.startRun.length, 0, `${tool}：下限没派生出来却派发了`)
  }
})

test('⑥ ★★ 控制面**没给**权限档位 → 具名拒绝，而且**一个字节都没有派发**', async () => {
  // 真 `claim()` 回来的 lease 上没有 `permissions`（`can-read-authorization-source.test.mjs`
  // 用的是真 claim）。此前 `defaultRequestFor` 会**编**一份 `{preset, tools: []}` 顶上去，
  // 而形状上它与"这个员工不能用任何工具"完全一样——派生出的是"派生完成、空名单"。
  const { result, host } = await build()
  const noGrants = { ...LEASE }
  delete noGrants.permissions

  await assert.rejects(() => result.executor.execute(noGrants), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED,
      `拒绝码不是那个具名的下限码（收到 ${e.code}）：笼统的接线码会把排障指向错的地方`)
    // 派生失败的原因码单独在一个键上——`ExecutorError` 的 `code` 要是被它覆盖了，
    // 上面那条断言会红，而生产里没人看得出被换过。
    assert.equal(e.refusalCode, 'run-floor-permissions-missing')
    assert.equal(e.wireCode, 'RUN_FLOOR_NOT_DERIVED', '线上那个码是另一层的名字，两个都要在')
    assert.ok(Array.isArray(e.refusals) && e.refusals.includes('run-floor-permissions-missing'),
      `拒绝理由里没有权限档位那个码：${JSON.stringify(e.refusals)}`)
    assert.match(e.message, /run-floor-permissions-missing/)
    return true
  })

  // 两件"没发生"的事，缺一不可：
  assert.equal(host.calls.startRun.length, 0, '下限都没派生出来，却已经把 Run 派发出去了')
  assert.equal(host.calls.probeRuntime, 0,
    '探测都跑了——说明下限那一步排在花钱/生效的动作之后，顺序反了')
})

test('⑥ ★★「没给权限档位」与「给了一份空允许名单」是**两个**读数（形状一样，结论相反）', async () => {
  // 这是本批最容易被"修好"的一件事：两者在形状上都是 `{preset, tools: []}`。
  //   · 没给   → 派不出来（`run-floor-permissions-missing`）→ **不派发**
  //   · 给了空 → 派的出来，名单是空的 → **正常派发**（"这次没有东西该被禁止"）
  // 把两者合并成一个读数的后果是：一次**接线遗漏**长出一句政策的形状。
  const snapshot = { associations: {}, finalText: 'x' }

  // ① 默认构建器在 lease 没有 permissions 时，填的是那个**按引用可辨认**的常量。
  const bare = defaultRequestFor(
    {
      attemptId: 'att:1', taskId: 'T-1', workspaceId: 'ws-1', modelProfileRef: 'mp-1', workdir: 'C:/tmp/ws',
      goalId: 'g1', employeeId: 'e1', teamPlanRef: 'tp1',
    },
    snapshot,
  )
  assert.equal(bare.permissions, UNSUPPLIED_PERMISSIONS,
    '默认回落换成了一个新造的对象——那么"控制面没给"在派生点上就再也认不出来了')

  // ② 真的走一遍：没给 → 不派发。
  const none = await build()
  const noGrants = { ...LEASE }
  delete noGrants.permissions
  await assert.rejects(() => none.result.executor.execute(noGrants),
    (e) => e.code === EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED)
  assert.equal(none.host.calls.startRun.length, 0)

  // ③ 反向对照：**显式**给一份空允许名单 → 照常派发，且下限是"派生完成、零禁止项"。
  //    没有这一条，"一律拒绝"与"真的分开了两者"就分不开。
  const empty = await build()
  const r = await empty.result.executor.execute(leaseWith([]))
  assert.equal(r.outcome, 'completed')
  assert.equal(empty.host.calls.startRun.length, 1)
  const carried = empty.host.calls.startRun[0].options.enforcementFloor
  assert.equal(carried.state, 'installed')
  assert.deepEqual([...carried.floor.denyTools], [],
    '显式空允许名单派出来的下限不是空名单——那这两个读数的区别就没了意义')
})

test('⑥ ★★ 派生失败时**载荷仍然被造出来**，且传输层对它的判定是"拒收"（不是"缺席"）', () => {
  // 这一条盯的是"不挂字段"那条路：缺席（absent）是**另一个状态**，
  // 而它意味着"没有人给我下限"。把一次解释不了的输入洗成一次缺席，读数就没了。
  const request = { ...LEASE, permissions: UNSUPPLIED_PERMISSIONS, [RUN_FLOOR_WIRE_FIELD]: undefined }
  const carried = deriveRunFloorCarrier(request)
  assert.equal(carried.state, RUN_FLOOR_STATES.REFUSED)
  assert.equal(carried.payload.derived, false)
  assert.equal(carried.payload.floor, null, '"派生不出来"与"派生出空名单"必须是两个读数')
  assert.deepEqual([...carried.payload.refusals], ['run-floor-permissions-missing'])
  // 这个载荷过一下**传输层自己的**读取器：它读成 refused，而不是 absent。
  assert.equal(readRunFloor(carried.payload).state, RUN_FLOOR_STATES.REFUSED)
  assert.notEqual(readRunFloor(carried.payload).state, RUN_FLOOR_STATES.ABSENT)
})

test('⑥ ★ `requestFor` 自己造的请求也**照样**被挂上下限（不是只有默认那条路）', async () => {
  const { result, host } = await build({
    extra: {
      requestFor: (lease, snapshot) => ({
        ...defaultRequestFor(lease, snapshot),
        // 注意：**没有** `permissions` 的默认回落——由 lease 给的那一份决定。
        permissions: { preset: 'legion-unattended', tools: ['git-push'] },
      }),
    },
  })
  const r = await result.executor.execute({ ...LEASE })
  assert.equal(r.outcome, 'completed')
  const floor = host.calls.startRun[0].options.enforcementFloor.floor
  assert.deepEqual([...floor.denyTools], ['bash', 'pwsh'],
    '调用方自己造请求时下限没跟上——"只有默认那条路带下限"与"任何一条路都不带"在生产里同形')
})

test('⑥ ★★ 请求上**已经有一份**下限 → 拒绝（本模块是唯一的生产者）', async () => {
  const { result, host } = await build({
    extra: {
      requestFor: (lease, snapshot) => ({
        ...defaultRequestFor(lease, snapshot),
        // 一份"看起来更严"的手工下限：它绕过了派生，于是它绕过了权限档位。
        [RUN_FLOOR_WIRE_FIELD]: {
          version: RUN_FLOOR_WIRE_VERSION, derived: true,
          floor: { denyTools: ['everything'], denyPathPrefixes: [], platform: process.platform },
        },
      }),
    },
  })
  await assert.rejects(() => result.executor.execute({ ...LEASE }), (e) => {
    assert.equal(e.code, EXECUTOR_CODES.RUN_FLOOR_NOT_DERIVED)
    assert.match(e.message, new RegExp(RUN_FLOOR_WIRE_FIELD))
    return true
  })
  assert.equal(host.calls.startRun.length, 0)
})

test('⑥ ★★ 两个解析口都是**注入**的：换掉任何一个，读数就跟着变', () => {
  // 这一条同时守着 `team-hub/run-floor.mjs` 的**控制反转**不被吃掉：
  // 它不 import 能力目录、也不 import 路由表（那会造出
  // `tool-capability → run-floor → tool-capability` 这个真实的模块环，
  // 表现是"强制面整段加载不上"），两个口都由调用方给。
  const request = { ...LEASE, permissions: { preset: 'p', tools: ['git-push'] } }

  // ① 能力目录那一口：真目录说 `git-push` 是硬底线 → 进下限。
  const withReal = deriveRunFloorCarrier(request)
  assert.deepEqual([...withReal.payload.floor.denyTools], ['bash', 'pwsh'])

  // 一个"一律说不是硬底线"的替身会让它**整个不进下限**——那证明目录真的被问到了。
  const withStubCatalog = deriveRunFloorCarrier(request, {
    resolveTool: () => ({ known: true, capabilities: [], requiresApproval: false }),
  })
  assert.equal(withStubCatalog.payload.derived, true)
  assert.deepEqual([...withStubCatalog.payload.floor.denyTools], [],
    '一个"忽略输入、一律说不是硬底线"的解析口竟然没有改变读数——那说明目录根本没被问到')

  // ② 名字空间那一口：换成一个"翻译成别的名字"的替身，名单必须跟着变。
  //    少了这一段，上面那段在一个"把 bash/pwsh 硬编码进名单"的实现上也是绿的。
  const withStubNames = deriveRunFloorCarrier(request, {
    resolveExecutionNames: () => ({ dshTools: ['probe-dsh-tool'], hosted: false, unrouted: false, collateral: [] }),
  })
  assert.deepEqual([...withStubNames.payload.floor.denyTools], ['probe-dsh-tool'],
    '执行面名字的解析口没被问到——那名单里的名字是哪来的？')

  // ③ 而"禁不了"（`dshTools: []`）必须是**拒收**，不是一份空下限。
  const withUnnamed = deriveRunFloorCarrier(request, {
    resolveExecutionNames: () => ({ dshTools: [], hosted: true, unrouted: false, reason: 'probe' }),
  })
  assert.equal(withUnnamed.state, RUN_FLOOR_STATES.REFUSED)
  assert.deepEqual([...withUnnamed.payload.refusals], ['run-floor-hard-floor-not-enforceable-at-plane'])
  assert.equal(withUnnamed.payload.floor, null, '禁不了的时候不许补一个空下限')

  assert.deepEqual([...resolveLegionTool('ghost-tool').capabilities], [])
  assert.equal(resolveLegionTool('ghost-tool').known, false)
})

test('⑥ ★★★★★ 名字空间：生产出来的名单**真的命中执行面**了（本批从"记录，不修"翻过来）', () => {
  // ★ 这一条的前身叫「这份"生产出来的"下限对**真执行面名字**放行（记录，不修）」，
  //   它逐条断言的是那个缺口：`denyTools` 里是 Legion 能力名，而 guard 比的是
  //   `execution.name`（执行面工具名），两个空间不相交 ⇒ **一个真工具都没拦住**。
  //
  //   一条断言"缺陷还在"的用例，在缺陷被修掉之后**必须**换成一条断言"修好了，
  //   而且是通过这一种方式修的"。删掉它等于把这道边界一起删掉。
  const { payload, result: derived } = deriveRunFloorCarrier({
    ...LEASE,
    permissions: { preset: 'legion-unattended', tools: ['git-push', 'read-file'] },
  })
  assert.equal(payload.derived, true)
  const guard = createHardFloorGuard(payload.floor)

  // ① 执行面上的**真名字真的被拒**——这是这一整条的目的。
  assert.deepEqual([...payload.floor.denyTools], ['bash', 'pwsh'])
  for (const name of ['bash', 'pwsh']) {
    assert.equal(typeof guard({ name, arguments: {} }), 'string',
      `${name} 没有被这份下限拒——那"派生"与"安装"之间又断了一节`)
  }
  // ② 名单里**不再有** Legion 能力名：一个执行面上不存在的名字放进拒绝名单，
  //    与没有这条禁令在下一次调用时是同一个东西。
  for (const name of ['git-push', 'delete-file', 'write-secret']) {
    assert.equal(payload.floor.denyTools.includes(name), false,
      `${name} 又出现在名单里了——那是 Legion 能力名，guard 永远比不到它`)
  }
  // ③ 连带代价被读出来了：`bash`/`pwsh` 也是 `run-command` / `git-status` /
  //    `git-commit` 的落地方式，禁掉它们会连带禁掉那些工具。
  //    少了这条，"为了拦一个推送而关掉整个 shell"在读数上与"只拦了推送"同形。
  const notice = derived.notices.find((n) => n.code === 'run-floor-collateral-denial')
  assert.notEqual(notice, undefined, '连带禁止没有留读数')
  assert.deepEqual([...notice.dshTools], ['bash', 'pwsh'])
  assert.deepEqual([...notice.collateral], ['run-command', 'git-status', 'git-commit'])
  // ④ 而名字名单**仍然不是** fail closed——这句是这一组唯一没变的话，
  //    留着它防的是下一个人把"翻译对了"读成"下限现在已经完备了"。
  assert.equal(guard({ name: 'write', arguments: {} }), undefined)
  assert.equal(guard({ name: 'read', arguments: {} }), undefined)
})

// ============================================================================
// ⑧ 下限告诫的**生产出口**（PRT-214 续）
//
// 这一组盯的不是"告诫在不在派生物里"（上一组已经钉了），而是**它有没有人读**：
//
//   > 一条产生了、单测锁了、而生产里没有任何人读的告诫，
//   > 与一条根本没产生的告诫，在运维读到的输出里是同一个东西。
//
// 出口是 `createProductionExecutor` 的 `onFloorNotice`，而
// `product/orchestrator/worker.mjs` 是它的**唯一生产供给者**（写 stderr）。
// 所以下面三条分别钉：出口收得到、出口坏了不许连累 Run、没接出口是一种
// **可见**的缺席（而不是被一个空函数冒名顶替）。
// ============================================================================

test('⑧ ★★ 真 execute 全链路：`onFloorNotice` 收到那条连带禁止告诫', async () => {
  const seen = []
  const { result } = await build({ extra: { onFloorNotice: (n) => seen.push(n) } })
  assert.equal(result.ok, true, JSON.stringify(result))

  const r = await result.executor.execute({
    ...LEASE,
    // `git-push` 是**执行面上有名字**的那一个（→ bash/pwsh），
    // 而 bash/pwsh 同时承载 run-command / git-status / git-commit —— 于是有连带。
    permissions: { preset: 'legion-unattended', tools: ['git-push', 'read-file'] },
  })
  assert.equal(r.outcome, 'completed')

  assert.equal(seen.length, 1, `出口收到 ${seen.length} 条告诫：${JSON.stringify(seen.map((n) => n?.code))}`)
  assert.equal(seen[0].code, 'run-floor-collateral-denial')
  assert.equal(seen[0].tool, 'git-push')
  assert.deepEqual([...seen[0].dshTools], ['bash', 'pwsh'])
  assert.deepEqual([...seen[0].collateral], ['run-command', 'git-status', 'git-commit'])
  // 人话也在：措辞由**知道原因的那一侧**写，出口不该自己拼一句。
  assert.match(seen[0].message, /连带|同时承载/)
})

test('⑧ ★★ 出口自己抛了 ⇒ Run **照常完成**，但失败留下痕迹', async () => {
  // 一个会抛的出口（日志盘满、stdout 关了）如果能把异常传上去，
  // 一次**纯诊断**失败就变成一次 Run 失败——而这次 Run 的下限本身是好的、
  // 工具调用本来会被正确拦下。让诊断能停生产，比丢掉一条诊断更坏。
  const { result } = await build({
    extra: { onFloorNotice: () => { throw new Error('日志盘满了') } },
  })
  const r = await result.executor.execute({
    ...LEASE,
    permissions: { preset: 'legion-unattended', tools: ['git-push', 'read-file'] },
  })
  // ① Run 没被连累。
  assert.equal(r.outcome, 'completed', '出口抛错把一次好 Run 弄失败了')

  // ② 但**不许静默**：痕迹必须在结果里，否则"出口坏了"与"没有告诫"同形。
  assert.equal(Array.isArray(r.floorNoticeSinkFailed), true,
    '出口坏掉了，结果里却没有痕迹——那与"这次没有告诫"是同一个读数')
  assert.equal(r.floorNoticeSinkFailed.length, 1, '只该记第一条：出口通常对每条都坏，逐条重记会淹没真问题')
  assert.match(r.floorNoticeSinkFailed[0], /日志盘满了/)
})

test('⑧ ★ 没接出口时**不**在结果里写一个空失败数组', async () => {
  // `floorNoticeSinkFailed: []` 与"没有这个键"必须是两件事：
  // 前者读作"出口接上了、这次没坏"，后者读作"这个部署没接出口"。
  // 无差别地加一个空数组，会让这两种处境在结果的键集合上长得一样。
  const { result } = await build()
  const r = await result.executor.execute({
    ...LEASE,
    permissions: { preset: 'legion-unattended', tools: ['git-push', 'read-file'] },
  })
  assert.equal(r.outcome, 'completed')
  assert.equal('floorNoticeSinkFailed' in r, false)
})

// ============================================================================
// ⑨ 政策禁令（`permissions.deniedTools`）真的进了静态下限
//
// 与⑧同一处接缝，但换了一个方向：⑧量的是**派生出来的告诫有没有出口**，
// ⑨量的是**控制面写下的禁令有没有生效**。
//
// ★ 这一组的判据必须落在**`denyTools` 里真的多了那个执行面名字**上，
//   不是"`declaredDenyTools` 参数传下去了"。传下去而没人用，与没传，
//   在 guard 那一侧是同一个东西——而 guard 才是真的拦人的那一个。
// ============================================================================

test('⑨ ★★★ `deniedTools` 里能表达的那一类：真的进了 `denyTools`（guard 拦得到）', async () => {
  // `git-push` 在执行面上有名字（bash/pwsh）。把它写进**政策禁令**之后，
  // guard 必须真的能拦到那两个名字。
  //
  // 反面对照在下一个断言里：不写它时 `denyTools` 里没有 bash/pwsh
  // （`git-push` 是 `repo:push`＝硬底线能力，所以它本来就会被禁——
  //  这里用 **`read-file`** 那一侧来验"不影响"）。
  //
  // ★ 判据落在**发出去的那份下限**上（`host.calls.startRun[0].options.enforcementFloor`），
  //   不是"`declaredDenyTools` 参数传下去了"。传下去而没人用，与没传，
  //   在 guard 那一侧是同一个东西——而 guard 才是真的拦人的那一个。
  const { result, host } = await build()
  const r = await result.executor.execute({
    ...LEASE,
    permissions: {
      preset: 'legion-unattended',
      tools: ['read-file', 'git-status'],
      deniedTools: ['git-push'],
    },
  })
  assert.equal(r.outcome, 'completed', JSON.stringify(r).slice(0, 400))
  const floor = host.calls.startRun[0]?.options?.enforcementFloor
  assert.ok(floor, '这次 Run 没有下发下限——那说明派生根本没走通')
  assert.equal(floor.state, 'installed')
  assert.ok(floor.floor.denyTools.includes('bash') && floor.floor.denyTools.includes('pwsh'),
    `政策禁了 git-push，执行面上却没有禁 bash/pwsh：denyTools=${JSON.stringify(floor.floor.denyTools)}`)
})

test('⑨ ★★★ hosted 的政策禁令（执行面上没名字）：**不拒 Run**，但留下具名告诫', async () => {
  // 这是本批的**核心裁决**。`mcp-invoke` 是 `hosted: true`——Legion 宿主平面
  // 今天没有被任何组合挂载，所以它在执行面上没有名字可以让 guard 去拒。
  //
  // 上一版的行为是"整次 Run 具名拒绝"。改判的依据是**禁令的出处**：
  // 允许名单里那条是**产品不变量**（删文件回不来），
  // `deniedTools` 里这条是**操作者配置**（他要求得没错，产品欠他一句
  // "这条落在哪一层"）。拿产品缺口拒绝操作者的岗位，是把账记错了人。
  const seen = []
  const { result, host } = await build({ extra: { onFloorNotice: (n) => seen.push(n) } })
  const r = await result.executor.execute({
    ...LEASE,
    permissions: {
      preset: 'legion-unattended',
      tools: ['read-file'],
      deniedTools: ['mcp-invoke'],
    },
  })
  // ① Run 照常完成——**这是本批改的那一条**。
  assert.equal(r.outcome, 'completed',
    `hosted 的政策禁令把整次 Run 拒了（outcome=${r.outcome}）——那正是本批要改掉的行为`)

  // ② 下限是活的（`installed`，而不是 `absent`/`refused`）：Run 真的带上下限跑了。
  const floor = host.calls.startRun[0]?.options?.enforcementFloor
  assert.equal(floor?.state, 'installed',
    'Run 照跑，却没有一份已装填的下限——那才是真的没保护')

  // ③ ★ 而"这条禁令没生效"必须被读出来。否则它与"禁了、而且生效了"
  //    在接纳这次 Run 的那一刻是同一个读数。
  const notice = seen.find((n) => n.code === 'run-floor-policy-deny-not-enforceable-at-plane')
  assert.ok(notice,
    `没有那条具名告诫：出口收到的是 ${JSON.stringify(seen.map((n) => n?.code))}。`
    + '缺了它，"禁不了"与"没禁"在读端同形')
  assert.equal(notice.tool, 'mcp-invoke')
  assert.equal(notice.why, 'hosted')
  assert.deepEqual([...notice.dshTools], [], '它没有执行面名字，dshTools 必须是空的')
})

test('⑨ ★★ `deniedTools` 缺席与"空数组"都不产生静态禁令', async () => {
  // 两者都不禁任何东西（这是对的：没有禁令就是没有禁令）。
  // （"两者在**请求形状**上仍然不同"由 `permissionsFromLease` 那一条单测钉住，
  //  因为 `execute` 的结果里看不到 `permissions` 原样。）
  for (const deniedTools of [undefined, []]) {
    const { result, host } = await build()
    const perms = { preset: 'legion-unattended', tools: ['read-file'] }
    if (deniedTools !== undefined) perms.deniedTools = deniedTools
    const r = await result.executor.execute({ ...LEASE, permissions: perms })
    assert.equal(r.outcome, 'completed', `deniedTools=${JSON.stringify(deniedTools)} 时 Run 没跑完`)
    const floor = host.calls.startRun[0]?.options?.enforcementFloor
    assert.deepEqual([...floor.floor.denyTools], [],
      `deniedTools=${JSON.stringify(deniedTools)} 不该产生任何静态禁令`)
  }
})

test('⑨ ★★ `permissionsFromLease`：`deniedTools` 缺席与空数组形状不同（审计要读的那个对象）', () => {
  // 下限上两者一样（上一条），但 `permissions` 是**审计要读的对象**：
  // 把一句操作者**没做过**的陈述（`deniedTools: []`＝"我说了这次没有禁令"）
  // 补进去，等于让审计读到一个不存在的决定。
  const withoutField = permissionsFromLease({
    attemptId: 'att:1', allowedTools: ['read-file'], approvalPolicy: null,
  })
  assert.equal('deniedTools' in withoutField, false,
    '控制面没有表达禁令，却凭空写了一个 deniedTools 进档位')

  const explicitEmpty = permissionsFromLease({
    attemptId: 'att:1', allowedTools: ['read-file'], approvalPolicy: null, deniedTools: [],
  })
  assert.deepEqual([...explicitEmpty.deniedTools], [],
    '控制面**明确说了**没有禁令时，那个陈述必须原样留着')

  const withDenies = permissionsFromLease({
    attemptId: 'att:1', allowedTools: ['read-file'], approvalPolicy: null, deniedTools: ['mcp-invoke'],
  })
  assert.deepEqual([...withDenies.deniedTools], ['mcp-invoke'])
})

test('⑨ ★★★ `deniedTools` 形状坏掉（不是数组）→ 具名拒绝，不是静默当成空', async () => {
  // 一个读不出来的禁令名单，与一份空名单，在下限上是同一个读数——
  // 而前者意味着"操作者说要禁的东西我们没读到"。
  // 那必须是一次**具名**失败（`run-floor-declared-deny-tools-invalid`），
  // 否则静默的后果是：一份被写坏的政策让所有禁令**消失**，而 Run 照跑。
  const { result } = await build()
  // ★ 形状是**抛**（`EXECUTOR_RUN_FLOOR_NOT_DERIVED`），不是"返回一个没跑完的结果"：
  //   一个"派生失败但照样返回了一个结果对象"的接口，会让每个调用点都必须记得
  //   判那一种结果——而漏判的那一个会把一次拒绝当成一次能跑的 Run。
  await assert.rejects(
    () => result.executor.execute({
      ...LEASE,
      permissions: { preset: 'legion-unattended', tools: ['read-file'], deniedTools: 'mcp-invoke' },
    }),
    (err) => {
      // 拒绝码要落到**派生失败的原因**上，而不是停在传输层那个笼统的码上。
      assert.equal(err.refusalCode, 'run-floor-declared-deny-tools-invalid',
        `拒绝理由没有点名那个码：${JSON.stringify(err.refusalCode)}`)
      assert.equal(err.code, 'EXECUTOR_RUN_FLOOR_NOT_DERIVED')
      assert.deepEqual([...err.refusals], ['run-floor-declared-deny-tools-invalid'])
      return true
    },
  )
})
