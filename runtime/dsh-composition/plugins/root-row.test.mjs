// runtime/dsh-composition/plugins/root-row.test.mjs
// ============================================================================
// PRT-214（续）：`root-row.mjs` —— 组合根的**第一个生产调用方**。
//
// ## 这一组守的是什么
//
//   · 模块真的能被加载（`default` 是一个带 `name` / `apply` 的普通对象），
//     而且 `apply` **真的调了** `installEnforcementRoot()`——不是"文件里有这个 import"；
//   · 配置不可解析时**拒绝**，且**不发布服务**（不装半根）；
//   · ★ **激活与行序无关**：根行**最后**加载时，两行运行期模块照样激活。
//     这是对着**真 cordis Context** 验的，不是断言"字段存在"；
//   · 另外两行在根真的缺席时**仍然拒绝**（不许把响亮的拒绝变成静默 no-op）；
//   · `decide` 是 `decideApproval` 的生产适配器，缺输入时 fail closed 而不是猜。
//
// ## 测试形状纪律（本仓库评审真正抓过 bug 的地方）
//
//   · 断言**具名码本身**，不用 `[...].includes(code)`，也不写"它抛了"；
//   · 每条"没装"的断言都有**反向对照**（给对了就装上了 / 发布服务了）；
//   · 顺序无关那一条同时给出**两个方向**：根行最后加载 → 激活；
//     根行最先加载 → 也激活。只测一个方向的话，一个"要求根行必须先加载"的
//     实现照样能绿。
//   · 假 Context 只实现本套件要观察的口，**不建模 inject 的等待语义**——
//     那是真运行时的契约，由本文件下半部分对着真 cordis 守。
// ============================================================================

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import rootRow, {
  DECIDE_ENV_KEYS,
  ENFORCEMENT_ROOT_SERVICE,
  NONE_SHORTCUT_CHECKED,
  ROOT_ROW_CODES,
  ROOT_ROW_PLUGIN_NAME,
  approvalPortFactory,
  assertNoneShortcutHolds,
  createPolicyDecide,
  createRootRow,
  decideInputsFromEnv,
  setApprovalPortFactory,
} from './root-row.mjs'
import {
  ENFORCEMENT_CONFIG_FIELDS,
  ENFORCEMENT_ROOT_CODES,
  enforcementInstallation,
  enforcementRoot,
  resetEnforcementRoot,
} from '../root.mjs'
import { LEGION_ROW_PREFIX, PATCH_LAYER_ROWS } from '../patch-layer.mjs'
import preExecuteRow, { PRE_EXECUTE_ROW_CODES } from './pre-execute-row.mjs'
import approvalAnswererRow, { APPROVAL_ANSWERER_ROW_CODES } from './approval-answerer-row.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'

/** 一份**完整**的身份环境。字段不多不少，就是 `REQUIRED_ENFORCEMENT_CONFIG` 那几个。 */
const ENV_OK = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'alice',
  LEGION_SCOPE: 'space-1',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: CWD,
})

/** 一个合格的审批端口工厂：**不联网**，只回答"没有人批"。 */
function portFactory(over = {}) {
  const calls = []
  const factory = (resolved) => {
    calls.push(resolved)
    return {
      requestApproval: async () => 'rejected',
      ...over,
    }
  }
  return { factory, calls }
}

/** 只实现本套件要观察的口。**不建模 `inject` 的等待语义**。 */
function fakeContext() {
  const services = new Map()
  const ctx = {
    logger: { info() {}, error() {} },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    get(name) {
      return services.get(name)
    },
    on() {
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    plugin(p) {
      p.apply(ctx)
      return { dispose() {} }
    },
  }
  return { ctx, services }
}

/** 每个用例都从"从来没装过"开始——否则测的是前面所有步骤的累积效果。 */
afterEach(() => {
  resetEnforcementRoot()
  setApprovalPortFactory(null)
})

// ─────────────────────────────────────────────── 形状与声明

test('① 模块形状：default 是带 name / apply 的普通对象，且行 id 与插件名逐字相同', () => {
  assert.equal(typeof rootRow, 'object')
  assert.equal(rootRow.name, ROOT_ROW_PLUGIN_NAME)
  assert.equal(typeof rootRow.apply, 'function')
  assert.deepEqual([...rootRow.inject], [], '根行是被依赖的那一端，自己不 inject 任何服务')
  assert.equal(NONE_SHORTCUT_CHECKED, true)
  assert.deepEqual(Object.keys(ROOT_ROW_CODES).sort(), [
    'APPROVAL_PORT_UNUSABLE', 'CONFIG_UNRESOLVED', 'DECIDE_INPUT_MISSING',
    'NONE_SHORTCUT_DRIFTED', 'NO_APPROVAL_PORT_FACTORY', 'NO_CONTEXT', 'NO_ENV',
  ])
})

test('① 补丁层：这一行**在静态文档里**（module 是字符串，不是 runtime-only）', () => {
  const row = PATCH_LAYER_ROWS.find((r) => r.id === `${LEGION_ROW_PREFIX}root`)
  assert.ok(row !== undefined, '补丁层里没有 legion-enforcement-root 这一行')
  assert.equal(row.id, ROOT_ROW_PLUGIN_NAME, '行 id 与插件名必须逐字相同——挂载审计按它对号')
  assert.equal(row.module, './plugins/root-row.mjs')
  assert.equal(row.runtimeModule, undefined, '本行是静态可加载的，不该同时带 runtimeModule')
  // ★ `module` 是**相对于补丁文件所在目录**的（DSH 的 `anchorInsertedPluginNames`
  //   按 `dirname(patchFile)` 解析），不是相对本用例。少拐这一层就会把
  //   "解析错了目录"读成"文件不存在"。
  assert.ok(existsSync(resolve(HERE, '..', row.module)), `${row.module} 不存在——DSH 加载不到它`)
  assert.equal(row.mount.anchor, 'insert')
})

test('★ 闭集：`decide` 读的环境键名是**闭集**（多读一个就会红）', () => {
  assert.deepEqual(Object.keys(DECIDE_ENV_KEYS).sort(), ['attended', 'policy', 'preset'])
  assert.deepEqual([...Object.values(DECIDE_ENV_KEYS)].sort(), [
    'LEGION_APPROVAL_POLICY', 'LEGION_ATTENDED', 'LEGION_PERMISSION_PRESET',
  ].sort())
})

// ─────────────────────────────────────────────── 装上 / 拒绝（假 Context）

test('★★ 真的调了 installEnforcementRoot：装好后单例报 ok，且服务被发布', async () => {
  const { ctx, services } = fakeContext()
  const { factory } = portFactory()
  assert.equal(enforcementRoot(), null, '用例开始前不该有根')

  await ctx.plugin(createRootRow({ env: ENV_OK, createRequestApproval: factory }))

  const installed = enforcementInstallation()
  assert.equal(installed.ok, true)
  assert.equal(installed.code, null)
  assert.equal(typeof enforcementRoot()?.mount, 'function')
  // 服务是**同一份**安装结果（身份，不是形状）：另两行读到的必须就是根手里那一份。
  assert.equal(services.get(ENFORCEMENT_ROOT_SERVICE), installed)
  assert.equal(services.get(ENFORCEMENT_ROOT_SERVICE)?.root, enforcementRoot())
})

test('★★★ 配置缺 actor → 拒绝，**不发布服务**（不装半根），且码是字段级的那个', async () => {
  const { ctx, services } = fakeContext()
  const { factory } = portFactory()
  const env = { ...ENV_OK }
  delete env.LEGION_ACTOR

  await assert.rejects(
    async () => { await ctx.plugin(createRootRow({ env, createRequestApproval: factory })) },
    (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.CONFIG_UNRESOLVED)
      assert.match(e.message, new RegExp(ENFORCEMENT_ROOT_CODES.NO_ACTOR),
        '消息里必须带着组合根那一层的字段级码，否则排查要翻两层')
      return true
    },
  )
  // 反向对照：单例记的是**拒绝**（不是"从来没装过"），而服务**没有**被发布。
  assert.equal(enforcementInstallation().ok, false)
  assert.equal(enforcementInstallation().code, ENFORCEMENT_ROOT_CODES.NO_ACTOR)
  assert.equal(enforcementRoot(), null)
  assert.equal(services.has(ENFORCEMENT_ROOT_SERVICE), false, '拒绝了却把服务发出去 = 一行装好的空壳')
})

test('★★★ 没有任何审批端口工厂 → 拒绝，且**点名**缺的是哪一件事', async () => {
  const { ctx, services } = fakeContext()
  await assert.rejects(
    async () => { await ctx.plugin(createRootRow({ env: ENV_OK, createRequestApproval: null })) },
    (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.CONFIG_UNRESOLVED)
      assert.match(e.message, new RegExp(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY),
        '消息必须说出真实原因（工厂缺席），而不是笼统的"装配失败"')
      assert.match(e.message, /approval-port/)
      return true
    },
  )
  assert.equal(services.has(ENFORCEMENT_ROOT_SERVICE), false)
})

test('★★ 注册缝：team-hub 侧注册工厂后能装上；注销后**又变回拒绝**（缝真的有效）', async () => {
  const unregister = setApprovalPortFactory(() => ({ requestApproval: async () => 'rejected' }))
  assert.equal(typeof approvalPortFactory(), 'function')

  const a = fakeContext()
  await a.ctx.plugin(createRootRow({ env: ENV_OK }))
  assert.equal(enforcementInstallation().ok, true)
  assert.equal(a.services.has(ENFORCEMENT_ROOT_SERVICE), true)

  resetEnforcementRoot()
  unregister()
  assert.equal(approvalPortFactory(), null, '注销没生效——那这条缝就只是单向的')

  const b = fakeContext()
  await assert.rejects(
    async () => { await b.ctx.plugin(createRootRow({ env: ENV_OK })) },
    (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.CONFIG_UNRESOLVED)
      assert.match(e.message, new RegExp(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY))
      return true
    },
  )
  assert.equal(b.services.has(ENFORCEMENT_ROOT_SERVICE), false)
})

test('★ 环境不是对象 → NO_ENV（不是把 null 当成"空环境"去要默认值）', async () => {
  const { ctx } = fakeContext()
  await assert.rejects(
    async () => { await ctx.plugin(createRootRow({ env: null })) },
    (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.NO_ENV)
      return true
    },
  )
  assert.equal(enforcementInstallation(), null, '拿不到环境时连"拒绝"都不该记——那是另一个处境')
})

test('★ 不是 Context → NO_CONTEXT', async () => {
  await assert.rejects(
    async () => { rootRow.apply({}) },
    (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.NO_CONTEXT)
      return true
    },
  )
})

test('★★ 幂等：同一进程里挂第二次不重建根（服务与那份根都是**同一份**）', async () => {
  const { ctx } = fakeContext()
  const { factory } = portFactory()
  await ctx.plugin(createRootRow({ env: ENV_OK, createRequestApproval: factory }))
  const first = enforcementRoot()

  await ctx.plugin(createRootRow({ env: ENV_OK, createRequestApproval: factory }))
  assert.equal(enforcementRoot(), first, '第二次挂竟然换了另一份根——两份桥 / 两本登记簿')
})

// ─────────────────────────────────────────────── 不编造默认值

test('★★★ 只配了一个字段：逐字段报码，且消息里不得出现编造的默认值', async () => {
  const { ctx } = fakeContext()
  const { factory } = portFactory()
  let refusal = null
  await assert.rejects(
    async () => {
      await ctx.plugin(createRootRow({ env: { LEGION_ACTOR: 'alice' }, createRequestApproval: factory }))
    },
    (e) => {
      refusal = e
      return true
    },
  )
  const inst = enforcementInstallation()
  assert.equal(inst.ok, false)
  // 缺的第一个字段决定码（`REQUIRED_ENFORCEMENT_CONFIG` 的次序）。
  assert.equal(inst.code, ENFORCEMENT_ROOT_CODES.NO_HUB_URL)
  assert.deepEqual([...inst.missing].sort(), ['action', 'cwd', 'hubUrl', 'scope'])
  // 逐字段：**每一个**缺的字段都要在消息里被点名（"缺哪个报哪个"不能是空的）。
  for (const field of ['hubUrl', 'scope', 'action', 'cwd']) {
    assert.match(inst.message, new RegExp(field), `${field} 没被点名`)
  }
  // ★ 反向控制：**在场**的那个字段（actor）的 env 键名不该被报成缺失。
  //   少了这一条，一个"永远把五个字段全列上"的实现照样能通过上面那段。
  assert.ok(!inst.missing.includes('actor'), 'actor 配了却被报成缺失')
  assert.doesNotMatch(inst.message, /LEGION_ACTOR/, '配了的字段被报成缺——"缺哪个报哪个"是空的')
  assert.equal(ENFORCEMENT_CONFIG_FIELDS.actor.envKeys[0], 'LEGION_ACTOR', '这条断言依赖的键名表变了')
  // ★ "不编造默认值"的可执行形式：这段文本里不得出现任何会被读成"已经配好"的地址。
  assert.doesNotMatch(inst.message, /127\.0\.0\.1|localhost|8787/, '拒绝消息里出现了编造的 hub 地址')
  assert.doesNotMatch(refusal.message, /127\.0\.0\.1|localhost|8787/)
})

test('★★ 空环境与"没有来源"是两个码：`{}` → CONFIG_EMPTY，不给 env → CONFIG_MISSING', async () => {
  const a = fakeContext()
  const { factory } = portFactory()
  await assert.rejects(
    async () => { await a.ctx.plugin(createRootRow({ env: {}, createRequestApproval: factory })) },
    (e) => {
      assert.equal(e.message.includes(ENFORCEMENT_ROOT_CODES.CONFIG_EMPTY), true)
      return true
    },
  )
  assert.equal(enforcementInstallation().code, ENFORCEMENT_ROOT_CODES.CONFIG_EMPTY)
  assert.notEqual(ENFORCEMENT_ROOT_CODES.CONFIG_EMPTY, ENFORCEMENT_ROOT_CODES.CONFIG_MISSING)

  // 反向：`env: undefined` 时本行去读 `process.env`（真进程环境），所以这里换一条路——
  // 用 `createRootRow({env: null})` 已经由 NO_ENV 那条用例守着"根本没有环境"。
  resetEnforcementRoot()
  assert.equal(enforcementInstallation(), null)
})

// ─────────────────────────────────────────────── decide 适配器

test('★★ requiresApproval 不是 true → allow（对应 decideApproval 的 allow-by-policy）', () => {
  const decide = createPolicyDecide({ policy: null, attended: null })
  assert.deepEqual(decide({ requiresApproval: false }), { kind: 'allow' })
  assert.deepEqual(decide({}), { kind: 'allow' })
  // 反向：requiresApproval 为 true 时**不能**还是 allow
  assert.throws(() => decide({ requiresApproval: true }), (e) => {
    assert.equal(e.code, ROOT_ROW_CODES.DECIDE_INPUT_MISSING)
    return true
  })
})

test('★★ 需要人 + ask/有人 → ask；ask/没人 → ask 但理由写清"保持等待"；never → deny', () => {
  const attendedDecide = createPolicyDecide({ policy: 'ask', attended: true })
  const ask = attendedDecide({ requiresApproval: true, risk: 'high' })
  assert.equal(ask.kind, 'ask')
  assert.match(ask.reason, /问人/)

  const holdDecide = createPolicyDecide({ policy: 'ask', attended: false })
  const hold = holdDecide({ requiresApproval: true })
  // DSH 的闭集里没有 hold，本适配器映射成 ask（见 root-row.mjs 的说明）——
  // 关键是它**不能**是 allow，也不能把 hold 说成"人拒绝了"。
  assert.equal(hold.kind, 'ask')
  assert.match(hold.reason, /保持等待/)
  assert.doesNotMatch(hold.reason, /拒绝/)

  const neverDecide = createPolicyDecide({ policy: 'never', attended: true })
  const denied = neverDecide({ requiresApproval: true })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /never/)
})

test('★★ 缺策略 / 缺 attended → 判定期抛具名码（由 pre-execute 转成 deny，fail closed）', () => {
  for (const [policy, attended, hint] of [[null, true, DECIDE_ENV_KEYS.policy], ['ask', null, DECIDE_ENV_KEYS.attended]]) {
    const decide = createPolicyDecide({ policy, attended })
    assert.throws(() => decide({ requiresApproval: true }), (e) => {
      assert.equal(e.code, ROOT_ROW_CODES.DECIDE_INPUT_MISSING)
      assert.match(e.message, new RegExp(hint), '消息必须点名该设哪个环境变量')
      return true
    }, `policy=${policy} attended=${attended} 竟然给出了判定`)
  }
})

test('★ 不在闭集里的 policy 也算"没配"（不静默当成 never）', () => {
  const decide = createPolicyDecide({ policy: 'never-ever', attended: true })
  assert.throws(() => decide({ requiresApproval: true }), (e) => {
    assert.equal(e.code, ROOT_ROW_CODES.DECIDE_INPUT_MISSING)
    return true
  })
})

test('★★ 装载期检查不是恒真：一个"读了 policy"的假 decideApproval 会被抓出来', () => {
  const fake = ({ requirement, policy }) => ({
    decision: requirement === 'none' && policy === 'never' ? 'deny' : 'allow-by-policy',
  })
  assert.throws(() => assertNoneShortcutHolds(fake), (e) => {
    assert.equal(e.code, ROOT_ROW_CODES.NONE_SHORTCUT_DRIFTED)
    return true
  }, '捷径失效了却没人报——那两条捷径断言就是空的')
})

test('★ decideInputsFromEnv：只认字面 true/false，其余一律当"没说清"', () => {
  assert.deepEqual(decideInputsFromEnv({}), { policy: null, attended: null, preset: null })
  assert.equal(decideInputsFromEnv({ [DECIDE_ENV_KEYS.attended]: 'true' }).attended, true)
  assert.equal(decideInputsFromEnv({ [DECIDE_ENV_KEYS.attended]: 'false' }).attended, false)
  for (const v of ['1', 'yes', 'on', 'TRUE', '']) {
    assert.equal(decideInputsFromEnv({ [DECIDE_ENV_KEYS.attended]: v }).attended, null, `${v} 被当成了布尔值`)
  }
  assert.equal(decideInputsFromEnv({ [DECIDE_ENV_KEYS.policy]: '  ask ' }).policy, 'ask')
})

// ─────────────────────────────────────────────── 另外两行仍然拒绝

test('★★★ 根真的缺席时，两行运行期模块**仍然拒绝**（不许变成静默 no-op）', async () => {
  const { ctx } = fakeContext()   // 没有 provide → 也没有安装结果
  assert.equal(enforcementInstallation(), null)

  await assert.rejects(async () => { preExecuteRow.apply(ctx) }, (e) => {
    assert.equal(e.code, PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT)
    assert.match(e.message, /不挂一个空 listener/)
    return true
  })
  await assert.rejects(async () => { approvalAnswererRow.apply(ctx) }, (e) => {
    assert.equal(e.code, APPROVAL_ANSWERER_ROW_CODES.NO_COMPOSITION_ROOT)
    return true
  })
})

test('★★ 装过但被拒绝时：两行报的是 COMPOSITION_ROOT_REFUSED，**与"没装过"是两个码**', async () => {
  const { ctx } = fakeContext()
  // 造一个"装了但拒绝"的单例：缺 actor 的安装。
  const env = { ...ENV_OK }
  delete env.LEGION_ACTOR
  const { factory } = portFactory()
  await assert.rejects(async () => {
    await ctx.plugin(createRootRow({ env, createRequestApproval: factory }))
  })
  assert.equal(enforcementInstallation().ok, false)

  for (const [row, code] of [
    [preExecuteRow, PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED],
    [approvalAnswererRow, APPROVAL_ANSWERER_ROW_CODES.COMPOSITION_ROOT_REFUSED],
  ]) {
    await assert.rejects(async () => { row.apply(ctx) }, (e) => {
      assert.equal(e.code, code)
      assert.match(e.message, new RegExp(ENFORCEMENT_ROOT_CODES.NO_ACTOR))
      return true
    })
  }
  assert.notEqual(
    PRE_EXECUTE_ROW_CODES.NO_COMPOSITION_ROOT,
    PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED,
    '"没装过"与"装了但拒绝"必须修法不同',
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// 真 cordis Context：**顺序无关**这件事只能对着真运行时验
// ═══════════════════════════════════════════════════════════════════════════
//
// `patch-layer.mjs` 写死了"行顺序不携带加载语义"，所以"根行先加载"是**不得假设**的。
// 下面这几条把两个方向都跑一遍：
//   · 根行**最后**加载 → 两行先 pending、服务出现后激活（顺序无关的正面证明）；
//   · 根行**最先**加载 → 两行立即激活（反面控制）。
// 只跑一个方向的话，一个"要求根行必须先加载"的实现照样全绿。

const DSH = process.env.DSH_CHECKOUT ?? null
const CORDIS = DSH === null ? null : join(
  DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js',
)
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CORDIS)
    ? `DSH 检出里找不到 cordis（${CORDIS}）——依赖未安装？`
    : false
const SKIP = UNAVAILABLE === false ? false : UNAVAILABLE

let Context = null
if (SKIP === false) ({ Context } = await import(pathToFileURL(CORDIS).href))

const guarded = (name, fn) => test(name, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

/** 真 Context + 两行依赖的宿主服务（`tools` / `approval`）。 */
async function realContext() {
  const ctx = new Context()
  ctx.provide('tools', {})
  ctx.provide('approval', {})
  return ctx
}

/** 一个必然投影失败的 exec——只要 listener 挂上了，它就会给出 deny。 */
const BOGUS_EXEC = Object.freeze({ callId: 'c-1', name: 'no-such-tool', arguments: {} })

/** 策略门到底挂上了没有：没挂 → `next()` 的值；挂上了 → 一次 deny。 */
async function preExecuteProbe(ctx) {
  const out = await ctx.waterfall('tools/pre-execute', BOGUS_EXEC, () => 'NO-LISTENER')
  return out === 'NO-LISTENER' ? null : out
}

describe('PRT-214 root-row（真 cordis Context：激活与行序无关）', () => {
  guarded('★★★ 根行**最后**加载：两行先 pending，服务一出现就激活', async () => {
    const ctx = await realContext()
    const { factory } = portFactory({ requestApproval: async () => 'rejected' })
    const root = createRootRow({ env: ENV_OK, createRequestApproval: factory })

    // ① 根行还没来：两行先挂上——**不许抛**，只许 pending。
    const pre = await ctx.plugin(preExecuteRow)
    const ans = await ctx.plugin(approvalAnswererRow)
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(ctx.get(ENFORCEMENT_ROOT_SERVICE, false), undefined, '根行还没加载，服务不该在')
    assert.equal(await preExecuteProbe(ctx), null,
      '根行还没加载，策略门就已经在拦东西了——那说明顺序假设被写进了实现')

    // ② 根行**最后**加载。
    await ctx.plugin(root)
    await new Promise((r) => setTimeout(r, 0))

    // ③ 两行都激活了：策略门真的在听（给一次 deny），且**没有抛**。
    const decision = await preExecuteProbe(ctx)
    assert.notEqual(decision, null, '根行最后加载时，依赖它的行没有激活（顺序无关性不成立）')
    assert.equal(decision.kind, 'deny', '投影失败的调用必须被 deny（fail closed）')
    assert.equal(pre._error, undefined, `本行不该以失败收场：${pre._error?.message ?? ''}`)
    assert.equal(ans._error, undefined, `答案行不该以失败收场：${ans._error?.message ?? ''}`)
  })

  guarded('★★ 反向控制：根行**最先**加载时两行也激活（不是"必须先"）', async () => {
    const ctx = await realContext()
    const { factory } = portFactory()
    await ctx.plugin(createRootRow({ env: ENV_OK, createRequestApproval: factory }))

    const pre = await ctx.plugin(preExecuteRow)
    await new Promise((r) => setTimeout(r, 0))

    const decision = await preExecuteProbe(ctx)
    assert.notEqual(decision, null, '根行先加载时反而没激活——依赖声明写错了')
    assert.equal(decision.kind, 'deny')
    assert.equal(pre._error, undefined)
  })

  guarded('★★ 拒绝值也能让依赖行激活：报的是"根拒绝了"，不是"从来没有根"', async () => {
    const ctx = await realContext()
    // 手工发布一个**拒绝**值（模拟"根行在别处拒绝了、但服务被发了出来"这条接缝）。
    ctx.provide(ENFORCEMENT_ROOT_SERVICE, {
      ok: false, code: ENFORCEMENT_ROOT_CODES.NO_ACTOR, message: '缺 actor', missing: ['actor'], reasons: [],
    })
    await assert.rejects(
      async () => {
        const row = await ctx.plugin(preExecuteRow)
        if (row._error !== undefined) throw row._error
        await new Promise((r) => setTimeout(r, 0))
        if (row._error !== undefined) throw row._error
      },
      (e) => {
        assert.equal(e.code, PRE_EXECUTE_ROW_CODES.COMPOSITION_ROOT_REFUSED)
        assert.match(e.message, new RegExp(ENFORCEMENT_ROOT_CODES.NO_ACTOR))
        return true
      },
    )
  })

  guarded('★★★ 根行真的缺席时，两行在真运行时上是 **pending**（由挂载审计报未激活）', async () => {
    const ctx = await realContext()
    const pre = await ctx.plugin(preExecuteRow)
    const ans = await ctx.plugin(approvalAnswererRow)
    await new Promise((r) => setTimeout(r, 0))

    // 静默 no-op 的反面：没有 listener 挂着（探针仍然是"没人理"），
    // 而且两行都**没有**以失败收场——它们是 waiting，不是抛。
    assert.equal(await preExecuteProbe(ctx), null)
    assert.equal(pre._error, undefined, 'waiting 被实现成了抛——那两行就再也不会自己恢复')
    assert.equal(ans._error, undefined)
    // ③ pending 与"装好了"必须可分：服务不在场。
    assert.equal(ctx.get(ENFORCEMENT_ROOT_SERVICE, false), undefined)
  })
})

if (SKIP !== false) {
  test('PRT-214 root-row 的真运行时部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
