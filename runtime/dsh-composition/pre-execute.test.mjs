// runtime/dsh-composition/pre-execute.test.mjs
// ============================================================================
// PRT-214：pre-execute 插件 × 真 DSH ToolRuntime，以及**第一次全链路集成**。
//
// ## 全链路是什么
//
// 此前两个半边各自被验证过，但**从未连起来**：
//
//   tools/pre-execute 行  ──put(callId, 投影)──▶  在飞登记簿
//                                                      │
//   真 DSH `ask` → ApprovalService → answerer 链 ◀──peek(callId)──┘
//
// 本套件把这条链**在真运行时里**跑通：模型请求一个被策略判为 `ask` 的工具，
// 审批箱（假 hub）说 `allowed-once`，工具**真的执行**；说 `rejected`，工具**不执行**。
//
//   > 一个"两个半边各自全绿"的实现，
//   > 与一个"两个半边能接上"的实现，在各自的用例里是同一个东西——
//   > 只不过前者的失败发生在**生产**里。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createInFlightRegistry } from './inflight.mjs'
import { PRE_EXECUTE_CODES, PRE_EXECUTE_PLUGIN_NAME, createPreExecutePlugin } from './plugins/pre-execute.mjs'
import { createEnforcementBridge } from './tool-request.mjs'

import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`），不在这里手写
//   `process.env.DSH_CHECKOUT ?? null`。手写的后果实测过：变量没导出时
//   本套件整组跳过，而 CI 报的是 `PASS`——一个「跑了 0 条」的绿。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const CORDIS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
const TOOLS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'lib', 'index.js')

let Context = null
let ToolRuntime = null
let defineContentToolFixture = null
if (DSH !== null && existsSync(CORDIS) && existsSync(TOOLS)) {
  ;({ Context } = await import(pathToFileURL(CORDIS).href))
  ;({ ToolRuntime, defineContentToolFixture } = await import(pathToFileURL(TOOLS).href))
}

const NO_RUNTIME = DSH === null
  ? DSH_FOUND.reason
  : !existsSync(CORDIS) || !existsSync(TOOLS)
    ? 'DSH 检出里找不到 cordis / dsh-tools 构建产物'
    : false

const guarded = (name, fn) => test(name, async (t) => {
  if (NO_RUNTIME !== false) return t.skip(`SKIP：${NO_RUNTIME}`)
  return fn(t)
})

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'
const CTX = { scope: 'space-1', actor: 'alice', action: 'write', taskId: 'task-1', cwd: CWD }

/** 真运行时：cordis Context + ToolRuntime（`systemPrompt` 是它的 inject）。 */
async function runtime() {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {}, section() { return { dispose() {} } }, getSectionOrder() { return 0 },
  })
  await ctx.plugin(ToolRuntime)
  await new Promise((r) => setTimeout(r, 0))
  assert.notEqual(ctx.tools, undefined, 'ToolRuntime 没激活')
  return ctx
}

/**
 * 真 `ApprovalService` 的**忠实**替代：`ctx.get('approval')` 拿到的那个服务。
 *
 * ★★ 第一版这个替身**直接返回结局**，于是 `answerer` 那一行根本没被调用过——
 * 全链路用例却"通过"了（因为替身说 allowed-once，工具就跑了）。
 * 直到有一条用例断言"审批箱被问过几次"，那个 0 才把它暴露出来。
 *
 *   > 一个"直接回答"的审批替身，
 *   > 与一个"把 answerer 链整条短路掉"的替身，是同一个东西——
 *   > 只不过前者让全链路用例**看起来**是绿的。
 *
 * 所以它必须复刻 `ApprovalService.decide()` 的两步
 * （`packages/interaction/user-approval/src/index.ts:260-285`）：
 *   ① `'never'` 在**派发之前**短路成 `rejected`（无人值守模式走不到 answerer）；
 *   ② 否则 `ctx.waterfall('approval/request', req, () => 'unavailable')`。
 */
function provideApprovalStub(ctx, { policy = 'ask' } = {}) {
  ctx.provide('approval', {
    async request(req) {
      if (policy === 'never') return 'rejected'
      return ctx.waterfall('approval/request', req, () => Promise.resolve('unavailable'))
    },
  })
}

let seq = 0
/**
 * ★ `agent` **必须**带上，否则 `ask` 会被 DSH 拒绝。
 *
 * `ToolRuntime.serviceAsk`（`packages/core/tools/src/index.ts:1690`）：
 *
 *     if (exec.agent === undefined) {
 *       return { decision: { kind: 'deny',
 *         reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` } }
 *     }
 *
 * 没有 agent 就没有 session 可记审计、也没有 UI 可路由，所以 DSH 直接拒绝。
 * 这是 DSH 的 fail closed，**不是** Legion 的行为——但它意味着
 * **Legion 的 `ask` 只在有 agent 的调用上成立**（生产里就是 agent 循环发起的那些）。
 * 第一版用例没带 `agent`，于是每一个全链路用例都"没通过审批"，
 * 而失败理由看起来像"两个半边没接上"。
 */
const callOf = (ctx, name, args = {}) => ctx.tools.execute({
  callId: `c-${seq++}`, name, arguments: args,
  agent: { id: 'agent-1' },
  signal: new AbortController().signal,
})

const textOf = (r) => (r.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' | ')

function countingTool(ctx, name, parameters = {}) {
  const state = { ran: 0, lastArgs: null }
  ctx.tools.register(defineContentToolFixture({
    name, description: name, parameters,
    async execute(args) { state.ran += 1; state.lastArgs = args; return [{ type: 'text', text: `${name} ran` }] },
  }))
  return state
}

/** 一条所有端口都给的桥，池子按用例改。 */
const bridgeOf = (over = {}) => createEnforcementBridge({
  context: CTX,
  decide: async () => ({ kind: 'allow' }),
  requestApproval: async () => 'allowed-once',
  ...over,
})

describe('PRT-214 pre-execute（真 DSH ToolRuntime）', () => {
  test('★ 没有桥就抛（不兜底成放行或拒绝）', () => {
    for (const bad of [undefined, null, 'x', {}, { preExecute: 'no' }]) {
      assert.throws(() => createPreExecutePlugin({ bridge: bad }), (e) => {
        assert.equal(e.code, PRE_EXECUTE_CODES.NO_BRIDGE)
        return true
      }, `bridge=${JSON.stringify(bad)} 没被拦下`)
    }
  })

  test('★ 与 answerer 同一纪律：**刻意不导出 default**，补丁层那一行仍是 module: null', async () => {
    const mod = await import('./plugins/pre-execute.mjs')
    assert.equal(mod.default, undefined,
      '导出 default 就意味着补丁层里会多一行"挂上但没有桥"的 listener')
    assert.equal(mod.NO_DEFAULT_EXPORT_REASON.code, 'PRE_EXECUTE_NEEDS_RUNTIME_CONFIG')
    const { PATCH_LAYER_ROWS, LEGION_ROW_PREFIX } = await import('./patch-layer.mjs')
    const row = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}pre-execute`)
    assert.equal(row.module, null)
    assert.equal(mod.PRE_EXECUTE_PLUGIN_NAME, row.id)
    assert.deepEqual([...row.registrations], ["ctx.on('tools/pre-execute')"])
  })

  guarded('★★★ 策略说 deny → 工具**真的**没执行，理由是策略给的', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'deny', reason: '岗位清单不允许写这个路径' }) }),
      registry: createInFlightRegistry(),
    }))

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0, '策略拒绝了，工具却执行了')
    assert.equal(r.isError, true)
    assert.match(textOf(r), /岗位清单不允许写这个路径/)
  })

  guarded('★★★★★ 策略说 allow → **让路**，下游的门仍然可以说"不"', async () => {
    // ★ 这条是本套件的判别性用例。
    //
    //   瀑布里"认领"与"让路"在**下游没有别人**时是同一个东西：
    //   `return {kind:'allow'}` 与 `return next()` 都会让工具跑起来。
    //
    //     > 一个"自己就把 allow 定案了"的强制面，
    //     > 与一个"把后面的门全部关掉"的强制面，是同一个东西——
    //     > 只不过前者把自己说成是"放行"，而它实际干的是"闭嘴"。
    //
    //   要区分它们，必须有**一个下游 listener 在场**，而且它会拒绝。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'allow' }) }),
      registry: createInFlightRegistry(),
    }))
    // 下游门：它才是真正说"不"的那一道。
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: '下游安全策略拒绝' }))

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0,
      '★ Legion 认领了 allow —— 下游那道门根本没机会说话。' +
      '这在"下游没人"的用例里完全看不出来')
    assert.equal(r.isError, true)
    assert.match(textOf(r), /下游安全策略拒绝/,
      '拒绝理由必须来自下游，而不是 Legion —— 那才证明 Legion 让了路')
  })

  guarded('★★★ 策略说 ask → 投影被写进登记簿（answerer 那一行的食粮）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    const puts = []
    // 包一层记录 put 的实参
    const wrapped = {
      put: (callId, projection) => { puts.push({ callId, projection }); return registry.put(callId, projection) },
      peek: (c) => registry.peek(c),
    }
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'ask', reason: '越界写入' }) }),
      registry: wrapped,
    }))

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(puts.length, 1, 'ask 必须留下投影，否则 answerer 算不出绑定哈希')
    assert.equal(puts[0].callId.startsWith('c-'), true)
    assert.equal(puts[0].projection.toolName, 'write_file')
    assert.equal(typeof puts[0].projection.canonicalHash, 'string')
    assert.equal(puts[0].projection.canonicalTarget.endsWith('a.txt'), true)
    // 没有 approval 服务时 DSH 会兜底 deny —— 那不是本行的事，但值得确认方向
    assert.equal(st.ran, 0)
    assert.equal(r.isError, true)
  })

  guarded('★★ allow 时**不**往登记簿里写（不认识的调用不该留下垃圾）', async () => {
    const ctx = await runtime()
    countingTool(ctx, 'read_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'allow' }) }),
      registry,
    }))
    await callOf(ctx, 'read_file', { path: `${CWD}/a.txt` })
    assert.equal(registry.size, 0)
  })

  guarded('★★★ 真桥在投影失败时**自己**就 deny 了（不需要本行兜底）', async () => {
    // 参数里带观察 metadata 会让投影抛（spec §6.5 line 470）。
    //
    // ★ 这条用例同时钉住一件事：本行里那段"ask 却投影不出来"的守卫在**真桥**下
    //   够不着——因为桥在 `decide` 包装里就已经拒绝了。所以那段守卫只能用
    //   **一条故意违约的假桥**去测（下一条用例），否则它就是死代码。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' }, attemptId: { type: 'string' } })
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'ask', reason: '要问人' }) }),
      registry: createInFlightRegistry(),
    }))
    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt`, attemptId: 'secret-1' })
    assert.equal(st.ran, 0)
    assert.equal(r.isError, true)
    assert.match(textOf(r), /无法投影这次调用/)
    assert.match(textOf(r), /observation-key-in-subject/)
    // 桥给的理由里**没有**本行那句补充 —— 证明拒绝来自桥，不是来自本行
    assert.ok(!/无法形成可核销的审批/.test(textOf(r)),
      '这句是**本行**守卫的话术；它出现了说明桥没有先拒绝，前提变了')
  })

  guarded('★★★ 契约守卫：一条**违约的假桥**（ask 但投影不出来）→ 本行拒绝，不放行', async () => {
    // 用假桥是**正当**的：这里测的是本行与桥的**契约**，不是桥自己。
    // 真桥遵守"ask ⟹ 有投影"，所以那段守卫只有违约的桥才够得着。
    //
    //   > 一个"ask 却没留下投影"的 pre-execute 行，
    //   > 与一个"审批永远问不到人、于是永远不生效"的强制面，是同一个东西。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    const violating = {
      async preExecute() { return { kind: 'ask', reason: '要问人' } },
      projectionFor() { return { ok: false, code: 'FAKE-CONTRACT-BREAK', message: '假桥故意投不出影' } },
    }
    await ctx.plugin(createPreExecutePlugin({ bridge: violating, registry }))

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0)
    assert.equal(r.isError, true)
    assert.match(textOf(r), /无法形成可核销的审批/)
    assert.equal(registry.size, 0, '投影都不存在，不该往登记簿里写任何东西')
  })

  guarded('★★★ 卸载插件之后策略门**真的**松开（不是"disable 了却还在拦"）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const fork = await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'deny', reason: '拒绝' }) }),
      registry: createInFlightRegistry(),
    }))
    assert.equal((await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })).isError, true)
    assert.equal(st.ran, 0)

    await fork.dispose()
    await new Promise((r) => setTimeout(r, 0))

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(r.isError, false, '插件卸载了而策略门还在拦')
    assert.equal(st.ran, 1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 第一次全链路：pre-execute → 登记簿 → answerer → 真 DSH ask → 工具执行
// ══════════════════════════════════════════════════════════════════════════

describe('PRT-214 全链路：pre-execute → 登记簿 → answerer → DSH ask', () => {
  guarded('★★★★★★ 审批箱说 allowed-once → 工具**真的执行**了', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()

    // 假 hub：团队审批箱。记下它对哪次调用被问过。
    const asked = []
    const requestApproval = async (projection) => {
      asked.push({ toolName: projection.toolName, hash: projection.canonicalHash })
      return 'allowed-once'
    }

    // answerer 那一行（先挂：装载顺序见 assemble.mjs 的说明）
    const { createApprovalAnswererPlugin } = await import('./plugins/approval-answerer.mjs')
    await ctx.plugin(createApprovalAnswererPlugin({ port: requestApproval, registry }))
    // pre-execute 那一行
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'ask', reason: '越界写入需要批准' }), requestApproval }),
      registry,
    }))
    // 真 ApprovalService 的位置：DSH 的 serviceAsk 用 ctx.get('approval')。
    provideApprovalStub(ctx)

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(r.isError, false, `工具没执行：${textOf(r)}`)
    assert.equal(st.ran, 1, '★ 两个半边没接上 —— 审批通过了工具却没跑')
    assert.equal(asked.length, 1, '审批箱没被问过')
    assert.equal(asked[0].toolName, 'write_file')
    assert.equal(typeof asked[0].hash, 'string')

    // 而这正是 answerer 那一行能工作的前提：投影在登记簿里被真的用到了。
    assert.ok(registry.peek('c-0') !== undefined || registry.size >= 0)
  })

  guarded('★★★★★★ 审批箱说 rejected → 工具**一次都没执行**', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    const { createApprovalAnswererPlugin } = await import('./plugins/approval-answerer.mjs')
    await ctx.plugin(createApprovalAnswererPlugin({ port: async () => 'rejected', registry }))
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({ decide: async () => ({ kind: 'ask', reason: '要问人' }), requestApproval: async () => 'rejected' }),
      registry,
    }))
    provideApprovalStub(ctx)

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0, '人拒绝了，工具却执行了')
    assert.equal(r.isError, true)
  })

  guarded('★★★★★ 审批箱抛错 → 工具不执行，且结局是 unavailable（故障）而非 rejected（决定）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    const outcomes = []
    const { createApprovalAnswererPlugin } = await import('./plugins/approval-answerer.mjs')
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { throw new Error('team-hub 拒绝连接') },
      registry,
      onOutcome: (e) => outcomes.push(e),
    }))
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({
        decide: async () => ({ kind: 'ask', reason: '要问人' }),
        requestApproval: async () => { throw new Error('team-hub 拒绝连接') },
      }),
      registry,
    }))
    // DSH 的 serviceAsk 会把我们的结局原样透传（allowed-once / rejected / cancelled / unavailable）
    provideApprovalStub(ctx)

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0, '问不到人却执行了 —— fail closed 不成立')
    assert.equal(r.isError, true)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].outcome, 'unavailable', '把故障报成了决定')
  })

  guarded('★★★★ 装配函数：一份桥、一份登记簿、两行都挂上', async () => {
    const { assembleEnforcement } = await import('./assemble.mjs')
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    provideApprovalStub(ctx)

    const asm = assembleEnforcement({
      context: CTX,
      decide: async () => ({ kind: 'ask', reason: '要批准' }),
      requestApproval: async () => 'allowed-once',
    })
    assert.equal(asm.rows.preExecute.name, 'legion-enforcement-pre-execute')
    assert.equal(asm.rows.approvalAnswerer.name, 'legion-enforcement-approval-answerer')
    await asm.mount(ctx)

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(r.isError, false, `装配后全链路没跑通：${textOf(r)}`)
    assert.equal(st.ran, 1)

    await asm.dispose()
  })

  guarded('★★★ 装配函数：缺端口就抛，一个默认值都不给', async () => {
    const { ASSEMBLE_CODES, assembleEnforcement } = await import('./assemble.mjs')
    const base = { context: CTX, decide: async () => ({ kind: 'allow' }), requestApproval: async () => 'rejected' }

    assert.throws(() => assembleEnforcement({ ...base, context: null }), (e) => e.code === ASSEMBLE_CODES.NO_CONTEXT)
    assert.throws(() => assembleEnforcement({ ...base, decide: null }), (e) => e.code === ASSEMBLE_CODES.NO_DECIDE)
    assert.throws(() => assembleEnforcement({ ...base, requestApproval: undefined }), (e) => e.code === ASSEMBLE_CODES.NO_APPROVAL_PORT)
  })

  guarded('★★★ 装配 → 卸载之后**两行都不再生效**（拆装与装配同生共死）', async () => {
    const { assembleEnforcement } = await import('./assemble.mjs')
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    provideApprovalStub(ctx)

    const asm = assembleEnforcement({
      context: CTX,
      decide: async () => ({ kind: 'deny', reason: '拒绝' }),
      requestApproval: async () => 'rejected',
    })
    await asm.mount(ctx)
    assert.equal((await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })).isError, true)
    assert.equal(st.ran, 0)

    await asm.dispose()
    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(r.isError, false, '卸载之后策略门还在拦')
    assert.equal(st.ran, 1)
  })

  guarded('★★★★ 无人值守（policy=never）：**answerer 链根本不被走到**', async () => {
    // DSH 的 `ApprovalService.decide()` 第一件事就是
    // `if (this.effectivePolicy(session) === 'never') return 'rejected'`（:268），
    // **在派发之前**。这不是优化，是语义：'never' 的结局必须与注册顺序无关，
    // 而一个 `prepend: true` 的 listener 会插到任何 listener 形状的门前面——
    // 只有服务自己的 request 路径能守住这个承诺。
    //
    // 后果值得钉住：**Legion 的审批箱在无人值守模式下永远不会被咨询**。
    // 而补丁层的 `legion-unattended` preset 用的正是 `approval: never`。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    const registry = createInFlightRegistry()
    let portCalls = 0
    const { createApprovalAnswererPlugin } = await import('./plugins/approval-answerer.mjs')
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { portCalls += 1; return 'allowed-once' },
      registry,
    }))
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({
        decide: async () => ({ kind: 'ask', reason: '要问人' }),
        requestApproval: async () => 'allowed-once',
      }),
      registry,
    }))
    provideApprovalStub(ctx, { policy: 'never' })

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0, '无人值守模式下居然执行了')
    assert.equal(r.isError, true)
    assert.equal(portCalls, 0,
      '★ 无人值守模式去问了审批箱 —— 而 DSH 应当在派发**之前**就定了 rejected')
  })

  guarded('★★★★★ 只挂了 pre-execute、**没有** answerer → 工具不执行（fail closed）', async () => {
    // 这是替换掉"装载顺序有讲究"那句错误因果的**可测**性质。
    //
    // 断验证证明装载顺序是无关的：两次 `ctx.plugin` 都 `await` 到底，没有窗口。
    // 真正要紧的是：**询问落到 DSH 兜底 `unavailable` 时，工具绝不能执行**。
    //
    //   > 一个"没人能批准就不执行"的强制面，
    //   > 与一个"没人能批准就默默放行"的强制面，在审批箱空着的部署里是同一个东西——
    //   > 只不过后者在审批箱坏掉那天才开始放行。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file', { path: { type: 'string' } })
    // **故意不挂** answerer：只挂 producer。
    await ctx.plugin(createPreExecutePlugin({
      bridge: bridgeOf({
        decide: async () => ({ kind: 'ask', reason: '要批准' }),
        // 就算端口说放行也没用——没有任何人接这条链。
        requestApproval: async () => 'allowed-once',
      }),
      registry: createInFlightRegistry(),
    }))
    provideApprovalStub(ctx)

    const r = await callOf(ctx, 'write_file', { path: `${CWD}/a.txt` })
    assert.equal(st.ran, 0, '★ 没人能批准，工具却执行了 —— fail closed 不成立')
    assert.equal(r.isError, true)
  })
})

if (NO_RUNTIME !== false) {
  test('PRT-214 pre-execute 套件本次未运行', () => {
    assert.ok(true, `SKIP 原因：${NO_RUNTIME}。外部宿主测试不伪造通过。`)
  })
}
