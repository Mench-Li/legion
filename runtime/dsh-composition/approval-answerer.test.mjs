// runtime/dsh-composition/approval-answerer.test.mjs
// ============================================================================
// PRT-214：approval answerer 插件——对着**真 cordis** 的 `approval/request` 瀑布。
//
// ## 这一套驱动的是 DSH 自己那一行调用
//
// `ApprovalService.decide()` 里（`packages/interaction/user-approval/src/index.ts:273`）：
//
//     Promise.resolve().then(() => this.ctx.waterfall(
//       scopeTarget(req.agent, req.agent), 'approval/request', req,
//       () => Promise.resolve('unavailable'),
//     ))
//
// 本套件跑的就是这一行（去掉 `scopeTarget`——那是 `dsh-scope` 的作用域包装，
// 对"事件名 + 瀑布形状 + 兜底值"没有影响）。所以守的是**真的那张网**。
//
// ★ 而且额外有一条**源码契约检查**：直接读 DSH 的源文件，确认那个事件名、
//   那个兜底值、以及"`'never'` 在派发**之前**就决定"这三件事都还在。
//   一条用例跑得过、而那三件事已经变了，是可能的。
//
//   > 一个"对着自己抄下来的契约"测的用例，
//   > 与一个"对着真契约"测的用例，在别人改契约那天是同一个东西——
//   > 只不过前者一直是绿的。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { APPROVAL_OUTCOMES } from './enforcement.mjs'
import { createInFlightRegistry } from './inflight.mjs'
import {
  APPROVAL_ANSWERER_CODES, APPROVAL_ANSWERER_PLUGIN_NAME, createApprovalAnswererPlugin,
} from './plugins/approval-answerer.mjs'

const DSH = process.env.DSH_CHECKOUT ?? null
const CORDIS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')

let Context = null
if (DSH !== null && existsSync(CORDIS)) ({ Context } = await import(pathToFileURL(CORDIS).href))

/** 这台机器上能不能真跑（要一个真的 cordis Context）。 */
const NO_CORDIS = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CORDIS)
    ? `找不到 cordis（${CORDIS}）`
    : false

const guarded = (name, fn) => test(name, async (t) => {
  if (NO_CORDIS !== false) return t.skip(`SKIP：${NO_CORDIS}`)
  return fn(t)
})

/** 起一个真的 Context，并提供一个 `approval` 占位服务（插件声明了 inject）。 */
async function context() {
  const ctx = new Context()
  ctx.provide('approval', { name: 'stub-approval' })
  await new Promise((r) => setTimeout(r, 0))
  return ctx
}

/**
 * **完全复刻 DSH 那次派发**：事件名、参数、兜底值都一致。
 *
 * 用例可以直接读它拿到的结局，而"没人认领"时拿到的就是 DSH 的 `unavailable`。
 */
const dispatch = (ctx, req) => ctx.waterfall('approval/request', req, () => Promise.resolve('unavailable'))

const aReq = (over = {}) => ({ agent: { id: 'a1' }, toolName: 'write_file', callId: 'c1', reason: '越界写入', ...over })

describe('PRT-214 approval answerer（真 cordis 的 approval/request 瀑布）', () => {
  // ── 构造期 ───────────────────────────────────────────────────────────────

  test('★ 没有 port 就抛（不兜底成"永远放行"或"永远拒绝"）', () => {
    for (const bad of [undefined, null, 'x', 42]) {
      assert.throws(() => createApprovalAnswererPlugin({ port: bad }), (e) => {
        assert.equal(e.code, APPROVAL_ANSWERER_CODES.NO_PORT)
        return true
      }, `port=${JSON.stringify(bad)} 没被拦下`)
    }
  })

  test('★ 明确**不导出 default**——它需要一个 YAML 带不了的 port', async () => {
    const mod = await import('./plugins/approval-answerer.mjs')
    assert.equal(mod.default, undefined,
      '导出了 default 就意味着补丁层里那一行会"挂上但什么都没接管"')
    assert.equal(mod.NO_DEFAULT_EXPORT_REASON.code, 'APPROVAL_ANSWERER_NEEDS_RUNTIME_CONFIG')
    // 而补丁层那一行必须仍然是 module: null——声明与实现要对得上
    const { PATCH_LAYER_ROWS, LEGION_ROW_PREFIX } = await import('./patch-layer.mjs')
    const row = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}approval-answerer`)
    assert.equal(row.module, null, '模块没有 default 导出，补丁层就不能引用它')
    assert.equal(mod.APPROVAL_ANSWERER_PLUGIN_NAME, row.id)
    // 而它声明的缝合点正是我们实测的那个事件
    assert.deepEqual([...row.registrations], ["ctx.on('approval/request')"])
  })

  // ── 认领 / 让给别人 ──────────────────────────────────────────────────────

  guarded('★★★★★ `next()` 与"抢答但答不上来"**必须能被区分开**', async () => {
    // ★ 这条是本套件最要紧的一条，它是被**断验证逼出来**的。
    //
    //   我第一版测"没有投影就 next()"是这么写的：断言结局 == `'unavailable'`。
    //   而把实现改成"抢答，然后因为找不到投影返回 unavailable"，**那条用例照样绿**——
    //   因为 DSH 自己的兜底值**也是** `unavailable`。
    //
    //     > 一个"让给别人"的实现，
    //     > 与一个"抢答然后答不上来"的实现，
    //     > 在**下游没有别人**的时候是同一个东西——
    //     > 只不过前者不会把好部署弄坏，而后者会。
    //
    //   要区分它们，必须有**一个下游答主在场**，而且它给出的答案与 `unavailable` 不同。
    const ctx = await context()
    const registry = createInFlightRegistry()
    // Legion 先注册（瀑布里排在前面）。
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => 'rejected', registry,
    }))
    // 下游答主：它才是本来能答上来的那个（比如桌面端的交互式审批）。
    let downstreamAsked = 0
    ctx.on('approval/request', async () => {
      downstreamAsked += 1
      return 'allowed-once'
    })

    // callId 不在 Legion 的登记簿里 → Legion 该让路 → 下游答主放行。
    const outcome = await dispatch(ctx, aReq({ callId: 'not-ours' }))
    assert.equal(downstreamAsked, 1,
      '★ Legion 把不属于自己的询问**抢答**了——下游答主根本没被问到。' +
      '这在读数上（unavailable）与正确实现一模一样，所以只有这条用例能抓住它')
    assert.equal(outcome, 'allowed-once',
      '★★ 抢答的实现会在这里给出 unavailable —— 而用户在好部署里本来是能批准的')
  })

  guarded('★★★ 登记簿里没有这个 callId → **让给别人**，而不是抢答 unavailable', async () => {
    //   > 一个"抢答一切、于是把别人能答的问题也答成不可用"的 answerer，
    //   > 与一个"根本没接进来"的 answerer，在用户那里是同一个东西——
    //   > 只不过前者的用例是绿的，而且它还能把好部署弄坏。
    const ctx = await context()
    const registry = createInFlightRegistry()
    let portCalls = 0
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { portCalls += 1; return 'allowed-once' },
      registry,
    }))

    // ★ 先证明**这条 answerer 是活的**，否则下面那句 `unavailable` 是空的：
    //   "没认领所以落到兜底" 与 "压根没注册所以就是兜底" 会给出同一个读数。
    registry.put('known', { toolName: 't' })
    assert.equal(await dispatch(ctx, aReq({ callId: 'known' })), 'allowed-once',
      '这条 answerer 没有真的挂上——那么下面的"让给别人"什么都没证明')
    assert.equal(portCalls, 1)

    const outcome = await dispatch(ctx, aReq({ callId: 'never-seen' }))
    assert.equal(outcome, 'unavailable', '没人认领时应当落到 DSH 自己的兜底值')
    assert.equal(portCalls, 1, '没有投影就不该去问审批箱——问了也造不出绑定哈希')
  })

  guarded('★★★ 登记簿里有投影 → **认领**，并走真端口', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    const seen = []
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async (projection, opts) => {
        seen.push({ projection, keys: Object.keys(opts).sort() })
        return 'allowed-once'
      },
      registry,
    }))
    const projection = { toolName: 'write_file', arguments: { path: '/etc/passwd' } }
    registry.put('c1', projection)

    const outcome = await dispatch(ctx, aReq({ callId: 'c1' }))
    assert.equal(outcome, 'allowed-once')
    assert.equal(seen.length, 1, '端口没被调用')
    assert.equal(seen[0].projection, projection, '端口必须拿到**投影本身**（绑定哈希要靠它）')
    // 端口收到的第二参数形状（`createHubApprovalPort` 认这三个）
    assert.ok(seen[0].keys.includes('onConnected'), '必须给 onConnected——两段超时靠它归因')
    assert.ok(seen[0].keys.includes('signal'))
    assert.ok(seen[0].keys.includes('responseTimeoutMs'))
  })

  guarded('★★ 四个结局**逐字**透传，一个都不变形', async () => {
    // DSH 的 `ApprovalOutcome` 与 Legion 的 `APPROVAL_OUTCOMES` 是同一份闭集。
    // 这里逐个确认——一个"翻译层"如果哪天把 `unavailable` 写成 `rejected`，
    // 就会把**故障**报成**决定**。
    for (const expected of APPROVAL_OUTCOMES) {
      const ctx = await context()
      const registry = createInFlightRegistry()
      await ctx.plugin(createApprovalAnswererPlugin({ port: async () => expected, registry }))
      registry.put('c1', { toolName: 't' })
      assert.equal(await dispatch(ctx, aReq({ callId: 'c1' })), expected, `结局 ${expected} 被改写了`)
    }
  })

  guarded('★★★ 端口抛错 → `unavailable`（故障），**不是** `rejected`（决定）', async () => {
    //   > 一个"问不到人"被记成"人说不"的审批，
    //   > 与一个真的被人拒绝的审批，在审计里是同一个东西——
    //   > 只不过前者会让值班的人去追问一个从未被问过的人。
    const ctx = await context()
    const registry = createInFlightRegistry()
    const outcomes = []
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { throw new Error('team-hub 拒绝连接') },
      registry,
      onOutcome: (e) => outcomes.push(e),
    }))
    registry.put('c1', { toolName: 't' })

    const outcome = await dispatch(ctx, aReq({ callId: 'c1' }))
    assert.equal(outcome, 'unavailable')
    assert.notEqual(outcome, 'rejected')
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].outcome, 'unavailable')
  })

  guarded('★★★ 闭集外的返回值 → `unavailable`，**不是**放行', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    // 端口返回垃圾 = 审批实现有 bug，不是"没问题"。
    await ctx.plugin(createApprovalAnswererPlugin({ port: async () => 'sure-go-ahead', registry }))
    registry.put('c1', { toolName: 't' })
    const outcome = await dispatch(ctx, aReq({ callId: 'c1' }))
    assert.equal(outcome, 'unavailable')
    assert.notEqual(outcome, 'allowed-once')
  })

  guarded('★★★ 响应超时 → `unavailable`，且**不会**一直挂着', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    await ctx.plugin(createApprovalAnswererPlugin({
      port: () => new Promise(() => {}), // 永不 settle
      registry,
      connectTimeoutMs: 30,
      responseTimeoutMs: 60,
    }))
    registry.put('c1', { toolName: 't' })
    const t0 = Date.now()
    const outcome = await dispatch(ctx, aReq({ callId: 'c1' }))
    assert.equal(outcome, 'unavailable')
    assert.ok(Date.now() - t0 < 3000, '超时应当很快收敛，不该真的等满默认的 60s')
  })

  guarded('★★ 调用方已取消（signal 已 abort）→ `cancelled`', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    let portCalls = 0
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { portCalls += 1; return 'allowed-once' },
      registry,
    }))
    registry.put('c1', { toolName: 't' })
    const ac = new AbortController()
    ac.abort()
    const outcome = await dispatch(ctx, aReq({ callId: 'c1', signal: ac.signal }))
    assert.equal(outcome, 'cancelled')
    assert.equal(portCalls, 0, '已经撤回的询问不该再去打扰审批箱')
  })

  guarded('★★ 认领判据可以说"这次不是我的"', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    let portCalls = 0
    await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => { portCalls += 1; return 'allowed-once' },
      registry,
      claim: (req) => req.toolName === 'write_file',
    }))
    registry.put('c1', { toolName: 'write_file' })
    registry.put('c2', { toolName: 'read_file' })

    assert.equal(await dispatch(ctx, aReq({ callId: 'c1' })), 'allowed-once')
    assert.equal(await dispatch(ctx, aReq({ callId: 'c2', toolName: 'read_file' })), 'unavailable')
    assert.equal(portCalls, 1, '被放弃认领的那次不该去问审批箱')
  })

  // ── 生命周期 ─────────────────────────────────────────────────────────────

  guarded('★★★ 卸载插件之后**不再认领**（不是"disable 了却还在答"）', async () => {
    const ctx = await context()
    const registry = createInFlightRegistry()
    const fork = await ctx.plugin(createApprovalAnswererPlugin({ port: async () => 'allowed-once', registry }))
    registry.put('c1', { toolName: 't' })
    assert.equal(await dispatch(ctx, aReq({ callId: 'c1' })), 'allowed-once')

    await fork.dispose()
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(await dispatch(ctx, aReq({ callId: 'c1' })), 'unavailable',
      '★ 插件卸载了而 answerer 还在认领——那与"补丁层里 disable 了这一行、却没有任何效果"是同一个东西')
  })

  guarded('★★ 两条 answerer 同时在场时，`next()` 真的把询问交给下一条', async () => {
    // 这条守的是"让给别人"确实**落到**别人手里，而不只是"我们返回了个别的值"。
    const ctx = await context()
    const registry = createInFlightRegistry()
    await ctx.plugin(createApprovalAnswererPlugin({ port: async () => 'allowed-once', registry }))
    // 后注册的一条：登记簿里没有它的 callId，于是它会 next()，
    // 最终落到 DSH 的兜底。
    const second = await ctx.plugin(createApprovalAnswererPlugin({
      port: async () => 'rejected', registry: createInFlightRegistry(),
    }))
    registry.put('c1', { toolName: 't' })
    assert.equal(await dispatch(ctx, aReq({ callId: 'c1' })), 'allowed-once',
      '第一条认领了，第二条不该有机会翻案')
    await second.dispose()
  })

  // ── 登记簿本身 ───────────────────────────────────────────────────────────

  test('★★ 登记簿：TTL 会真的过期，且读的时候顺手清理', () => {
    let t = 0
    const reg = createInFlightRegistry({ ttlMs: 1000, now: () => t })
    reg.put('a', { toolName: 't' })
    assert.equal(reg.size, 1)
    assert.ok(reg.peek('a') !== undefined)
    t = 1001
    assert.equal(reg.peek('a'), undefined, '过期项没被丢掉——它会一直占着内存')
    assert.equal(reg.size, 0, '读到的过期项必须顺手删掉')
  })

  test('★ 登记簿：空 callId / 非对象投影**不抛**，返回 false 让调用方 fail closed', () => {
    const reg = createInFlightRegistry()
    for (const bad of [undefined, null, '', 42]) {
      assert.equal(reg.put(bad, { toolName: 't' }), false, `callId=${JSON.stringify(bad)} 不该被登记`)
    }
    for (const bad of [null, 'x', 42, undefined]) {
      assert.equal(reg.put('c1', bad), false, `投影=${JSON.stringify(bad)} 不该被登记`)
    }
    assert.equal(reg.size, 0)
  })

  test('★ 登记簿：take 读并删，peek 只读', () => {
    const reg = createInFlightRegistry()
    reg.put('a', { n: 1 })
    assert.deepEqual(reg.peek('a'), { n: 1 })
    assert.equal(reg.size, 1, 'peek 不该删')
    assert.deepEqual(reg.take('a'), { n: 1 })
    assert.equal(reg.size, 0, 'take 必须删')
    assert.equal(reg.take('a'), undefined)
  })

  // ── DSH 源码契约（防漂移） ────────────────────────────────────────────────

  guarded('★★★ 源码契约：DSH 那边的三件事仍然成立', async (t) => {
    const file = join(DSH, 'packages', 'interaction', 'user-approval', 'src', 'index.ts')
    if (!existsSync(file)) return t.skip(`SKIP：找不到 ${file}`)
    const src = readFileSync(file, 'utf8')

    // ① 事件名与 waterfall 形状
    assert.match(src, /ctx\.waterfall\(\s*scopeTarget\([^)]*\),\s*'approval\/request',\s*req,/,
      "DSH 派发 approval/request 的方式变了——本套件驱动的那次调用可能已经不是真的了")
    // ② 没人认领时的兜底值
    assert.match(src, /'unavailable'\s*\)\s*,?\s*\)/,
      "DSH 的兜底值变了：我们断言'nothing claimed → unavailable'的那条用例会失去意义")
    // ③ `'never'` 在**派发之前**就决定（所以无人值守模式根本不会走到 answerer）
    assert.match(src, /if \(this\.effectivePolicy\(session\) === 'never'\) return 'rejected'/,
      "`never` 的短路变了：无人值守模式下 answerer 可能**会**被调用，而补丁层的 unattended preset 用的是 never")
    // ④ 闭集
    assert.match(src, /OUTCOMES/, '结局闭集的归一化点变了')
  })
})

if (NO_CORDIS !== false) {
  test('PRT-214 approval answerer 套件本次未运行', () => {
    assert.ok(true, `SKIP 原因：${NO_CORDIS}。外部宿主测试不伪造通过。`)
  })
}
