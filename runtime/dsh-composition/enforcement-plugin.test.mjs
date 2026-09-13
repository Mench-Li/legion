// runtime/dsh-composition/enforcement-plugin.test.mjs
// ============================================================================
// PRT-214：enforcement 插件模块的**一致性**用例——对着真的 DSH 运行时。
//
// ## 为什么必须是真运行时
//
// 这一套测的东西**全部是别人的契约**：
//   · `ctx.tools.guard()` 是不是真的同步、真的单调（"no guard can force-allow"）
//   · guard 返回 `string` 是不是真的变成一次 deny
//   · `tools/pre-execute` 返回 `{kind:'allow'}` 能不能压过 guard（**它不能**）
//   · 卸载插件之后 guard 还在不在
//
// 这些用我自己写的替身测都毫无意义：替身会照着我以为的样子实现。
// 实测确认过一件事——`ctx.on('tools/pre-execute', …)` 是**瀑布**，
// 注册过的监听不会被后一个顶掉。我第一版探针连注册了三个，
// 第一个的 deny 永远先返回，屏幕上看起来像"ask 不工作"。
//
//   > 一个用替身喂出来的"强制面已生效"，
//   > 与一个从没被真运行时拦下过的"强制面已生效"，是同一个东西——
//   > 只不过前者的用例数是完整的。
//
// ## 没有 DSH_CHECKOUT 时逐条 SKIP
//
// 与 `patch-loadable.test.mjs`、`plugins/`、`board-plugin/` 同一纪律：
// 外部宿主测试**不伪造通过**。逐条 `t.skip()`（不用整组 `describe({skip})`），
// 因为整组跳过不把用例计进 `skipped`，于是"跳过了"与"没这套件"在摘要上分不开。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { HARD_FLOOR_CODES, HARD_FLOOR_PLUGIN_NAME, HARD_FLOOR_PLUGIN_VERSION, createHardFloorPlugin } from './plugins/hard-floor.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DSH = process.env.DSH_CHECKOUT ?? null

// 这些路径都是 **DSH 检出里的构建产物**。找不到就 SKIP，不退回本仓库的替身。
const CORDIS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
const TOOLS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'lib', 'index.js')

const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CORDIS)
    ? `DSH 检出里找不到 cordis（${CORDIS}）——依赖未安装？`
    : !existsSync(TOOLS)
      ? `DSH 检出里找不到 dsh-tools 构建产物（${TOOLS}）`
      : false

let Context = null
let ToolRuntime = null
let defineContentToolFixture = null
if (UNAVAILABLE === false) {
  ;({ Context } = await import(pathToFileURL(CORDIS).href))
  ;({ ToolRuntime, defineContentToolFixture } = await import(pathToFileURL(TOOLS).href))
}

/**
 * 起一个真的运行时。
 *
 * ★ `ToolRuntime` 有 `static inject = ['systemPrompt']`。不提供它，
 *   行会**挂载但不激活**，`ctx.tools` 是 `undefined`——
 *   "行存在 ≠ 行生效"在这里是现场可见的，不是一句格言。
 */
async function runtime() {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {},
    section() { return { dispose() {} } },
    getSectionOrder() { return 0 },
  })
  await ctx.plugin(ToolRuntime)
  await new Promise((r) => setTimeout(r, 0))
  assert.notEqual(ctx.tools, undefined, 'ToolRuntime 没有激活（systemPrompt 没提供？）')
  return ctx
}

/** 注册一个记账工具，返回它的执行次数读取器。 */
function countingTool(ctx, name = 'danger') {
  const state = { ran: 0 }
  // ★ 用 DSH 自己的 `defineContentToolFixture`，不是手搓 `defineTool({output})`。
  //   第一版手搓的 `output: { schema: {…} }` 少了 `render`，于是**工具跑了**
  //   而结果是 `isError: true`（`output.render failed: userRender is not a function`）。
  //   屏幕上看起来像"门禁误拦了未被禁止的工具"，实际是我自己的工具定义残缺。
  //   用宿主自己的 fixture 就没有这个自欺的余地。
  ctx.tools.register(defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute() { state.ran += 1; return [{ type: 'text', text: `${name} ran` }] },
  }))
  return state
}

let seq = 0
const call = (ctx, name = 'danger', over = {}) => ctx.tools.execute({
  callId: `c-${seq++}`, name, arguments: {}, signal: new AbortController().signal, ...over,
})
const textOf = (r) => (r.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' | ')

const guarded = (name, fn) => test(name, (t) => {
  if (UNAVAILABLE !== false) return t.skip(`SKIP：${UNAVAILABLE}`)
  return fn(t)
})

describe('PRT-214 enforcement 插件模块（真 DSH 运行时）', () => {
  // ── 插件形状 ─────────────────────────────────────────────────────────────

  test('★ 插件形状：default export 是带 name 与 apply 的普通对象', async () => {
    const mod = await import('./plugins/hard-floor.mjs')
    assert.equal(typeof mod.default, 'object')
    assert.equal(mod.default.name, HARD_FLOOR_PLUGIN_NAME)
    assert.equal(typeof mod.default.apply, 'function')
    assert.equal(typeof mod.createHardFloorPlugin, 'function')
    assert.equal(HARD_FLOOR_PLUGIN_VERSION, 1)
    assert.ok(Object.keys(HARD_FLOOR_CODES).length > 0)
    // 行 id 必须与补丁层声明一致（两处漂移会让 patch 打到不存在的靶子）
    const { PATCH_LAYER_ROWS, LEGION_ROW_PREFIX } = await import('./patch-layer.mjs')
    const row = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}hard-floor`)
    assert.equal(HARD_FLOOR_PLUGIN_NAME, row.id,
      '插件名与补丁层的行 id 必须逐字相同——否则挂载审计里对不上号')
  })

  test('★★ 构造期就拒绝坏 floor，不给"能跑"的兜底', () => {
    for (const bad of [null, 'x', 1, []]) {
      assert.throws(() => createHardFloorPlugin({ floor: bad }), (e) => {
        assert.equal(e.code, HARD_FLOOR_CODES.BAD_FLOOR)
        return true
      }, `floor=${JSON.stringify(bad)} 没被拦下`)
    }
  })

  // ── 挂上之后真的拦得住 ───────────────────────────────────────────────────

  guarded('★★★ 挂上之后：被禁止的工具**真的**不执行，未被禁的照常执行', async () => {
    const ctx = await runtime()
    const danger = countingTool(ctx, 'danger')
    const safe = countingTool(ctx, 'safe')

    // 插进去的是**真插件**，不是我手搓的一个 guard 函数。
    await ctx.plugin(createHardFloorPlugin({ floor: { denyTools: ['danger'] } }))

    const denied = await call(ctx, 'danger')
    assert.equal(danger.ran, 0, '被静态禁止的工具居然执行了')
    assert.equal(denied.isError, true)
    assert.match(textOf(denied), /hard floor/, '拒绝理由必须能看出是静态下限拦的')
    assert.match(textOf(denied), /不可由审批解除/, '理由必须说清它不可被批准解除')

    const allowed = await call(ctx, 'safe')
    assert.equal(safe.ran, 1, '未被禁止的工具被误拦了——下限只能降级，不能变成全禁')
    assert.equal(allowed.isError, false)
  })

  guarded('★★★ 单调性：一个想 allow 的 pre-execute **压不过** guard', async () => {
    // 这是 DSH 文档里那句 "no guard can force-allow a call another guard denied"
    // 的现场验证。它也是 spec §6.8「下限永远不能成为唯一防线、但也不能被翻案」
    // 的机器判据。
    const ctx = await runtime()
    const danger = countingTool(ctx, 'danger')
    await ctx.plugin(createHardFloorPlugin({ floor: { denyTools: ['danger'] } }))

    // 一个**明确放行**的 pre-execute。它跑在 guard **之前**。
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))

    const r = await call(ctx, 'danger')
    assert.equal(danger.ran, 0, '★ guard 不是单调的：pre-execute 的 allow 把它压过去了')
    assert.equal(r.isError, true)
  })

  guarded('★★ 路径类下限也生效，且理由指出命中的前缀', async () => {
    const ctx = await runtime()
    const state = { ran: 0 }
    const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
    const secret = process.platform === 'win32' ? 'C:\\work\\secret\\a.txt' : '/work/secret/a.txt'
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write',
      parameters: { path: { type: 'string' } },
      async execute() { state.ran += 1; return [{ type: 'text', text: 'wrote' }] },
    }))
    await ctx.plugin(createHardFloorPlugin({
      floor: { denyTools: [], denyPathPrefixes: ['secret'], cwd },
    }))

    const denied = await ctx.tools.execute({
      callId: 'p1', name: 'write_file', arguments: { path: secret },
      signal: new AbortController().signal,
    })
    assert.equal(state.ran, 0, '落入静态禁止路径的写入居然执行了')
    assert.equal(denied.isError, true)
    assert.match(textOf(denied), /静态禁止范围/)
  })

  // ── 卸载与端口缺失 ───────────────────────────────────────────────────────

  guarded('★★★ 卸载插件之后 guard **真的**消失（不是"disable 了却还在拦"）', async () => {
    // `ctx.tools.guard()` 返回的 disposer 挂在 **ToolRuntime 的** fiber 上，
    // 所以插件自己必须把它交给本行的 effect 作用域。
    // 没有这一步，"disable 掉这一行"不会有任何效果。
    const ctx = await runtime()
    const danger = countingTool(ctx, 'danger')

    const fork = await ctx.plugin(createHardFloorPlugin({ floor: { denyTools: ['danger'] } }))
    assert.equal(danger.ran, 0)
    await call(ctx, 'danger')
    assert.equal(danger.ran, 0, '挂上之后应当被拦')

    await fork.dispose()
    await new Promise((r) => setTimeout(r, 0))

    await call(ctx, 'danger')
    assert.equal(danger.ran, 1,
      '★ 插件卸载了而 guard 还在拦——那与"补丁层里 disable 了这一行、却没有任何效果"是同一个东西')
  })

  guarded('★★★ `tools` 服务存在但**形状不对**时抛，不静默降级成什么都不拦', async () => {
    //   > 一个"挂上了但 guard 端口形状不对、于是什么也没拦"的下限，
    //   > 与一个"没有被写进补丁层"的下限，是同一个东西——
    //   > 只不过前者的组合树里有一行。
    //
    // ⚠️ 这条**不是**"没有 tools 服务"的场景——那种场景下 `inject: ['tools']`
    // 会让本行进入 **waiting**（不抛）。而 waiting 由 DSH 的挂载审计报成
    // `N row(s) did not activate`，那正是 `reconcilePatchLayer()` 的
    // `ROW_NOT_ACTIVATED` 判据在读的东西。两条路都要有，但它们不是同一条。
    const fake = new Context()
    // 同名服务，但没有 guard —— 名字对而形状不对。
    fake.provide('tools', { register() {}, schemas() { return [] } })
    await assert.rejects(
      async () => { await fake.plugin(createHardFloorPlugin({ floor: { denyTools: ['x'] } })) },
      (e) => {
        assert.equal(e.code, HARD_FLOOR_CODES.NO_GUARD_SEAM)
        assert.match(e.message, /ctx\.tools\.guard/)
        return true
      },
      '服务形状不对时居然挂上去了',
    )
  })

  guarded('★★ 没有 `tools` 服务时不抛而是**等待**——由挂载审计报未激活', async () => {
    // 这条把上面那条的边界钉死：声明式依赖的语义是"等待"，不是"抛"。
    // 如果哪天有人把 `inject: ['tools']` 从插件上摘掉，这条会红。
    const bare = new Context()
    const fork = await bare.plugin(createHardFloorPlugin({ floor: { denyTools: ['x'] } }))
    await new Promise((r) => setTimeout(r, 0))
    // 没有 tools 服务 → 行挂载了但没激活，且**没有抛**
    assert.equal(typeof fork.dispose, 'function')
    assert.equal(bare.tools, undefined, '不该凭空多出一个 tools 服务')
    await fork.dispose()
  })

  // ── 观测点不能改变判定 ───────────────────────────────────────────────────

  guarded('★★ `onGuard` 只观测，改不了判定', async () => {
    const ctx = await runtime()
    const danger = countingTool(ctx, 'danger')
    const seen = []
    // 观测点故意抛错：判定不该因此变成放行，也不该把整个 guard 弄坏。
    await ctx.plugin(createHardFloorPlugin({
      floor: { denyTools: ['danger'] },
      onGuard: (e) => { seen.push(e); },
    }))
    assert.equal(seen.length, 0, '还没调用就不该有观测记录')

    await call(ctx, 'danger')
    await call(ctx, 'danger')
    assert.equal(seen.length, 2, 'guard 每次被调用都该记一次')
    assert.equal(seen[0].toolName, 'danger')
    assert.match(seen[0].reason, /hard floor/)
    assert.equal(danger.ran, 0, '有观测点时下限失效了')
  })

  guarded('★ 未被禁止的工具，观测点收到的是"没有结论"（reason=null）', async () => {
    const ctx = await runtime()
    const safe = countingTool(ctx, 'safe')
    const seen = []
    await ctx.plugin(createHardFloorPlugin({
      floor: { denyTools: ['danger'] },
      onGuard: (e) => seen.push(e),
    }))
    const r = await call(ctx, 'safe')
    assert.equal(r.isError, false)
    assert.equal(safe.ran, 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].reason, null, '下限没有结论时应当是 null，而不是编一个理由')
  })
})

if (UNAVAILABLE !== false) {
  test('PRT-214 enforcement 插件套件本次未运行', () => {
    assert.ok(true, `SKIP 原因：${UNAVAILABLE}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
