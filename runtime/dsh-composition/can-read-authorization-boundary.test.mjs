// runtime/dsh-composition/can-read-authorization-boundary.test.mjs
// ============================================================================
// PRT-253（canRead 授权批）：**"这一次 Attempt 能读哪些来源"这个答案，到底有没有
// 跨过进程边界**——把答案锁住，而不是靠读一遍代码相信它。
//
// ## 这套件为什么存在
//
// `runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs` 以
// `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE` 拒绝了绑定，理由是
// 「DSH Runtime 进程里没有任何 canRead 的合法来源」。那条拒绝**只有在
// "答案确实不在这一侧"成立时才是对的**——否则它就是一个把能做的事说成不能做的借口。
//
// 于是本套件把"答案在不在"变成一个**可失败**的读数，逐段钉住：
//
//   A.  跨进程请求（`execute`）携带的顶层键恰好是什么；
//   A2. 那个请求里的 RunRequest 恰好有哪些键、权限面恰好是哪几个键；
//   B.  远程 `buildContext` 交给 `canRead` 的对象恰好是哪几个键；
//   B2. 本地 `buildContext` 交给 `canRead` 的两个参数恰好是哪几个键；
//   C.  `defaultRequestFor` 造出来的 RunRequest 与契约必填集的关系；
//   E.  生产默认工厂在**具名码**上仍然拒绝，注入 canRead 后同一形状能建出端口。
//
// ## 这一套的判据是"**恰好**"，不是"包含"
//
// `assert.ok(keys.includes('x'))` 会在有人**多加**一个字段时照样绿。
// 而本批要回答的正是"有没有一个我们没看见的字段带着授权"——所以每一处都用
// `deepEqual` 比**完整键集**。新增一个键会让这里红，而那正是应该发生的：
// 那一刻本文档 / 那条拒绝的前提变了。
//
// ## 诚实边界（这套件**没有**证明的东西）
//
//   · 它证明的是**当前生产代码**在这几个接缝上搬了什么，不是"永远不会有"。
//   · `B` / `B2` 里的 lease 是**用例构造**的；"真 claim 回来的 lease 有哪些键"
//     由文档 §3 的真实读数（临时 SQLite + 真 `claim()`）承担，不在这套件里
//     （`runtime/` 不得 import `team-hub/`）。
//   · `E` 用的是**桩 ctx**（只提供 `subagents` 那一个服务）。真 DSH 进程里的读数
//     见 `plugins/runtime-host-registrar-row-dsh-process.test.mjs`。
//   · 它**不是**"权限判定接对了"的证据——恰恰相反，它锁的是"没有可接的东西"。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRuntimeContractServer } from './runtime-contract-server.mjs'
import { createRuntimeContractAdapter } from '../../orchestrator/worker/runtime-contract-client.mjs'
import { createContextStage, createHubContextStage } from '../../orchestrator/worker/context-stage.mjs'
import { defaultRequestFor } from '../../orchestrator/worker/executor.mjs'
import { RUN_REQUEST_REQUIRED } from '../contracts/run.mjs'
import {
  RUNTIME_HOST_REGISTRAR_CODES,
  createRuntimeHostInputsFactory,
} from './plugins/runtime-host-registrar-row.mjs'

/** 运维能一眼看出"哪些键可能是授权"的判据；本套件要求它是**空集**。 */
const AUTHORITY_LOOKING = /read|auth|grant|permit|acl|visib/i

/** 真 claim 回来的那个 lease 的键（文档 §3 的真实读数：8 个，没有授权）。 */
const CLAIMED_LEASE_KEYS = Object.freeze([
  'attemptId', 'attemptNo', 'leaseEpoch', 'leaseExpiresAtMs', 'scope', 'serverTimeMs', 'state', 'taskId',
])

/**
 * 真 claim 回来的那个 lease——**恰好**那 8 个键，一个不多。
 *
 * 自检就写在这里：夹具漂了，"没有授权字段"这个读数也就跟着漂，而它看起来还成立。
 * （第一版允许 `overrides` 加字段，于是被这条自检当场咬住——那条路径现在单列。）
 */
function claimedLease() {
  const lease = {
    attemptId: 'att:task:measure:1',
    attemptNo: 1,
    leaseEpoch: 1,
    leaseExpiresAtMs: 1_700_000_600_000,
    scope: 'scope:measure',
    serverTimeMs: 1_700_000_000_000,
    state: 'Leased',
    taskId: 'task:measure',
  }
  assert.deepEqual(Object.keys(lease).sort(), [...CLAIMED_LEASE_KEYS].sort(),
    'lease 夹具的键与真 claim 回来的那 8 个不一致——先修夹具，再谈结论')
  return lease
}

/**
 * `defaultRequestFor` 只肯从调用方拿这三样（其余能从 lease / associations 回落）。
 *
 * 它**不是** claim 的形状：真 claim 的 8 个键里缺 12 个 RunRequest 必填字段，
 * 那 12 个由 worker 的配置 / 环境补齐（文档 §3 有一条现场读数）。
 */
const CALLER_SUPPLIED = Object.freeze({
  workspaceId: 'ws:measure',
  modelProfileRef: 'model:measure',
  workdir: process.platform === 'win32' ? 'C:\\work' : '/work',
})

/** 真 claim 的 lease + **调用方补的那三样**。只有这个组合才够造 RunRequest。 */
const runRequestLease = () => ({ ...claimedLease(), ...CALLER_SUPPLIED })

const SNAPSHOT = Object.freeze({
  associations: { goalId: 'goal:measure', taskId: 'task:measure', employeeId: 'emp:measure', teamPlanId: 'plan:measure' },
  finalText: 'FROZEN-PROMPT-TEXT',
})

const sorted = (o) => Object.keys(o).sort()

// ─────────────────────────────────────────────────────────────────────────── A

test('A. 跨进程 `execute` 携带的顶层键**恰好**是 wireVersion 与 request', async (t) => {
  let onServer = null
  const adapter = {
    runtimeContractVersion: 1,
    async getHealth() { return { state: 'ready' } },
    async getCapabilities() { return {} },
    async listModels() { return [] },
    async validateProfile() { return { ok: true } },
    async *execute(req) {
      onServer = req
      yield { type: 'run.started', seq: 1, at: 1_700_000_000_000, runId: req.runId }
      yield { type: 'run.completed', seq: 2, at: 1_700_000_000_001, runId: req.runId, result: { outcome: 'completed', stopReason: 'completed' } }
    },
    async cancel() { return { accepted: true } },
    async recover() { return { accepted: true } },
  }

  const token = `boundary-${Math.random().toString(36).slice(2)}`
  const built = createRuntimeContractServer({ adapter, token, port: 0 })
  assert.equal(built.ok, true, `契约服务端没造出来：${built.code}`)
  const listening = await built.listen()
  assert.equal(listening.ok, true, `契约服务端没听上：${listening.code}`)
  t.after(() => built.close())

  // 客户端侧：录下**真的发出去的字节**。这是"跨边界带了什么"的第一手读数。
  let sent = null
  const client = createRuntimeContractAdapter({
    baseUrl: `http://127.0.0.1:${listening.port}`,
    token,
    fetchImpl: async (url, init) => {
      if (typeof init?.body === 'string' && init.body.includes('"request"')) sent = init.body
      return globalThis.fetch(url, init)
    },
  })

  const request = defaultRequestFor(runRequestLease(), SNAPSHOT)
  let terminal = null
  for await (const ev of client.execute(request)) terminal = ev
  assert.equal(terminal.type, 'run.completed', '这条流没有以终态收尾')

  assert.notEqual(sent, null, '没有录到客户端发出的请求体')
  const decoded = JSON.parse(sent)

  // ★ 判据是"恰好"：多一个键就红。而"多一个键"正是本批要找的东西。
  assert.deepEqual(sorted(decoded), ['request', 'wireVersion'],
    '跨进程 execute 的顶层键集变了——新增的那个键有没有携带授权？')
  assert.deepEqual(sorted(decoded.request), sorted(request),
    '请求体里的 request 与客户端造出来的那个不是同一组键')
  // 服务端侧的读数：适配器收到的就是 request 本身（转发，不补字段）。
  assert.deepEqual(sorted(onServer), sorted(request),
    '适配器收到的对象与请求体里的 request 不是同一组键——服务端补过字段？')
})

// ─────────────────────────────────────────────────────────────────────────── A2

test('A2. 跨边界的 RunRequest **恰好**是契约必填集加 prompt；权限面只有工具面的两个键', () => {
  const request = defaultRequestFor(runRequestLease(), SNAPSHOT)
  const keys = sorted(request)

  // 契约必填集是**被请求方校验**的那一组（`validateRunRequest`）。
  assert.deepEqual(keys.filter((k) => k !== 'prompt'), [...RUN_REQUEST_REQUIRED].sort(),
    'RunRequest 的键集与契约必填集不再一致——多出来 / 少了哪一个？')
  assert.deepEqual(keys.filter((k) => !RUN_REQUEST_REQUIRED.includes(k)), ['prompt'],
    '"不在必填集里"的键只能有一个：prompt（被冻结的正文）')
  // `prompt` 是**授权的后果**，不是授权的来源：正文在 worker 侧装配时就已经定稿。
  assert.equal(request.prompt, SNAPSHOT.finalText, 'prompt 必须逐字来自冻结的正文')

  // 权限面 = 工具面档位，与"能读哪些上下文来源"是两件事。
  assert.deepEqual(sorted(request.permissions), ['preset', 'tools'],
    'permissions 的键集变了——它是不是被当成读权限的来源了？')

  assert.deepEqual(keys.filter((k) => AUTHORITY_LOOKING.test(k)), [],
    'RunRequest 上出现了读 / 授权形状的键：那这条边界可能已经带了授权，本批的 (B) 结论要重判')
})

// ─────────────────────────────────────────────────────────────────────────── B

test('B. 远程 buildContext 交给 canRead 的**恰好**是 {lease, scope, sources}', async () => {
  const bags = []
  let postedPath = null
  let postedBody = null
  const stage = createHubContextStage({
    post: async (path, body) => {
      postedPath = path
      postedBody = body
      return {
        status: 200,
        body: {
          ok: true,
          snapshotHash: 'sha256:boundary',
          snapshot: { sources: [], excluded: [], truncations: [], redactions: [], tokens: { kind: 'conservative-estimate', tokens: 3 } },
        },
      }
    },
    loadSources: async () => ({ goal: { id: 'goal:measure' }, employeeManifest: { employeeId: 'emp:measure', role: 'dev' } }),
    canRead: (ctx) => { bags.push(ctx); return { ids: ['goal:goal:measure'] } },
    clock: () => 1_700_000_000_000,
  })

  const frozen = await stage(claimedLease())
  assert.equal(frozen.kind, 'frozen')
  assert.equal(bags.length, 1, 'canRead 必须被调用**恰好一次**（多调一次就是第二个决定点）')

  const bag = bags[0]
  assert.deepEqual(sorted(bag), ['lease', 'scope', 'sources'],
    '交给 canRead 的对象键集变了——新增的那个键是不是授权的载体？')
  assert.deepEqual(sorted(bag.lease), CLAIMED_LEASE_KEYS,
    'canRead 拿到的 lease 与真 claim 的那 8 个键不一致')
  assert.deepEqual(sorted(bag.lease).filter((k) => AUTHORITY_LOOKING.test(k)), [],
    'lease 上出现了读 / 授权形状的键')
  // sources 是**取数方**给的高层输入；它的键由调用方决定，不是授权的来源。
  assert.deepEqual(sorted(bag.sources), ['employeeManifest', 'goal'])

  // 路由侧的形态：权限**只**由 canRead 的回答决定，且必须显式。
  assert.equal(postedPath, '/api/context-snapshots/assemble')
  assert.deepEqual(sorted(postedBody), ['associations', 'attemptId', 'canReadIds', 'frozenAtMs', 'runId', 'scope', 'sources'],
    '装配请求的键集变了')
  assert.deepEqual(sorted(postedBody).filter((k) => k.startsWith('canRead')), ['canReadIds'],
    '权限面的键必须**恰好**是 canReadIds（canReadAll 只有 canRead 明确回答 all 时才发）')

  // 反向对照：canRead 回答 `{all:true}` 时发的是 canReadAll，而交付给它的形状**不变**。
  const allBags = []
  const allStage = createHubContextStage({
    post: async () => ({
      status: 200,
      body: { ok: true, snapshotHash: 'sha256:b2', snapshot: { sources: [], excluded: [], truncations: [], redactions: [], tokens: { kind: 'conservative-estimate', tokens: 1 } } },
    }),
    loadSources: async () => ({}),
    canRead: (ctx) => { allBags.push(ctx); return { all: true } },
    clock: () => 1_700_000_000_000,
  })
  await allStage(claimedLease())
  assert.deepEqual(sorted(allBags[0]), ['lease', 'scope', 'sources'], '两次调用的形状必须一致')
})

// ─────────────────────────────────────────────────────────────────────────── B2

test('B2. 本地 buildContext 交给 canRead 的**恰好**是 (meta, {lease, scope, inputs})', async () => {
  const calls = []
  const stage = createContextStage({
    contextStore: { record: () => {} },
    loadInputs: async () => ({
      scope: 'scope:measure',
      goal: { id: 'goal:measure', version: 1, updatedAtMs: 1_700_000_000_000 },
      task: { id: 'task:measure', version: 1, updatedAtMs: 1_700_000_000_000 },
      teamPlan: { id: 'plan:measure', version: 1, updatedAtMs: 1_700_000_000_000 },
      employeeManifest: { employeeId: 'emp:measure', role: 'dev', version: 1, updatedAtMs: 1_700_000_000_000 },
    }),
    canRead: (meta, ctx) => { calls.push({ meta, ctx }); return true },
    writeAudit: () => {},
    clock: () => 1_700_000_000_000,
  })

  const frozen = await stage(claimedLease())
  assert.equal(frozen.kind, 'frozen')
  assert.ok(calls.length > 0, 'canRead 一次都没被调用')

  const call = calls[0]
  // `meta` 是**来源的元数据**（spec §6.5：判定先于读正文）——它描述的是"这个来源"，
  // 不是"这一次 Attempt 被授予了什么"。
  assert.deepEqual(sorted(call.meta), ['id', 'scope', 'trust', 'type', 'version'],
    '交判定用的 meta 键集变了——新增的键是来源的属性还是授权？')
  assert.deepEqual(sorted(call.meta).filter((k) => AUTHORITY_LOOKING.test(k)), [])

  assert.deepEqual(sorted(call.ctx), ['inputs', 'lease', 'scope'],
    '本地路径第二个参数的键集变了')
  assert.deepEqual(sorted(call.ctx.lease), CLAIMED_LEASE_KEYS, '本地路径的 lease 形状也必须是真 claim 那 8 个键')
  assert.deepEqual(sorted(call.ctx.lease).filter((k) => AUTHORITY_LOOKING.test(k)), [])
  // `inputs` 里确实有岗位清单——而它按契约**不是**授权载体（见文档 §4）。
  assert.deepEqual(sorted(call.ctx.inputs), ['employeeManifest', 'goal', 'scope', 'task', 'teamPlan'])
})

// ─────────────────────────────────────────────────────────────────────────── C

test('C. `defaultRequestFor` 造出的 RunRequest 不含任何读权限字段', () => {
  const request = defaultRequestFor(runRequestLease(), SNAPSHOT)
  assert.deepEqual(sorted(request).filter((k) => AUTHORITY_LOOKING.test(k)), [],
    'RunRequest 上出现了读 / 授权形状的键')
  // 权限面有一个**默认值**（工具面档位），这是既有事实、且与读权限无关；
  // 记在这里是为了让"工具面有默认、读面没有默认"这个对比在读数上可见。
  assert.deepEqual(sorted(request.permissions), ['preset', 'tools'])
})

// ─────────────────────────────────────────────────────────────────────────── E

test('E. 生产默认工厂**仍然**以具名码拒绝；注入 canRead 后同一形状能建出端口', () => {
  const subagents = {
    list: () => [],
    getProvider: () => undefined,
    start: () => ({ result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }),
  }
  // 服务名以**字符串**给（与 registrar 的 `serviceOf` 同一写法）：本目录刻意
  // 不在源码里写出执行面服务访问的完整记号。
  const ctx = { get: (name) => (name === 'subagents' ? subagents : undefined) }

  // ① 生产默认：没有 canRead 来源 → 必须**具名**拒绝（不是"它抛了"）。
  let refused = null
  try {
    createRuntimeHostInputsFactory()(ctx)
  } catch (e) {
    refused = e
  }
  assert.notEqual(refused, null, '生产默认工厂在"没有 canRead 来源"时**没有**拒绝')
  assert.equal(refused.code, RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
    '生产默认的拒绝码变了——它现在说的是哪一件事？')
  assert.equal(refused.name, 'RuntimeHostRegistrarError')

  // ② 反向对照：同一形状 + 显式注入的 canRead → 端口建得出来，且按引用转发。
  const injected = () => ({ ids: [] })
  const built = createRuntimeHostInputsFactory({ canRead: injected })(ctx)
  assert.equal(built.canRead, injected, '注进来的 canRead 不是按引用交出去的')
  assert.equal(typeof built.runtimeHost.startRun, 'function')
  assert.equal(typeof built.runtimeHost.probeRuntime, 'function')
  assert.deepEqual(sorted(built), ['canRead', 'runtimeHost'])

  // ③ 另一个反向对照：没有 `subagents` 时拒绝的是**另一条**码——
  //    "缺权限来源"与"缺引擎端口"必须分得开（修法不同）。
  let noEngine = null
  try {
    createRuntimeHostInputsFactory({ canRead: injected })({ get: () => undefined })
  } catch (e) {
    noEngine = e
  }
  assert.notEqual(noEngine, null, '没有 subagents 时工厂没有拒绝')
  assert.equal(noEngine.code, RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT)
  assert.notEqual(noEngine.code, refused.code, '两条拒绝码相同——"缺权限来源"与"缺引擎端口"就分不开了')
})
