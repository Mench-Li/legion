// ============================================================================
// P3（docs/DECISION-legion-owns-model-config.md）：**接管写入** —— 门、写、回读、回滚
//
// 这一组盯的是"不可逆的那一段"上的四件事：
//
//   ① **门关着就一个字节都不写。** 它是这条链上唯一不可逆的动作，
//      所以"能写"与"在写"之间必须隔着一个显式开关。
//   ② **写合法**：`create`/`update` 只改**受管叶子**（不覆盖整块 provider 节点）——
//      别人放在那块里的未知字段不许被无声抹掉。
//   ③ **写后回读才算数**：判据不是"mutate 被调过"，而是"**真读者读回来之后计划干净了**"。
//      为此用例里的假宿主真的会按 ops 改自己的状态，读者也真的会读它。
//   ④ **证不出来就回滚**，而且回滚本身也要被回读确认。
//
// 另：**删除是第二道门**（`allowDeletes`）。默认关，且关着时删除只报告、不执行 ——
// 因为删除整块的逆操作只能还原"读者看得见的叶子"（见 materialize-ops.mjs 文件头）。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { planMaterialization, normalizeForCompare } from './materialize-plan.mjs'
import { planToOps, expectedResidual, verifyResidual, providerValue } from './materialize-ops.mjs'
import { runMaterialization } from './materializer.mjs'

// ── 一个**真的会改自己状态**的假宿主 ────────────────────────────────────────
// 这是本文件的关键夹具：如果 mutate 只是被记名，那"写后回读"就永远是照抄写入者的说法，
// 于是用例会绿在一个**没有真的写进去**的世界上。
function fakeHost({ initial = {}, mutateBehavior = 'normal', initialCredentials = [] } = {}) {
  // state 是 llm-pi-ai 命名空间下的 providers 节点
  const state = { providers: structuredClone(initial) }
  // ★ 凭证是**另一个**存储（DSH 的凭证文档按引用名存，不按 provider）。
  //   夹具必须能单独给它播种，否则"DSH 已配"这件事在用例里表达不出来 ——
  //   而"已配 ⇒ 不该再写"正是凭证那半条最要紧的规则之一。
  const credentials = Object.fromEntries(initialCredentials.map((ref) => [ref, 'already-there']))
  const calls = { mutate: [], set: [], unset: [] }
  const nsDesc = () => [{ ns: 'llm-pi-ai', revision: 41, value: structuredClone(state) }]

  const applyOps = (ops) => {
    for (const op of ops) {
      const path = op.path
      if (path[0] !== 'providers') continue
      const id = path[1]
      if (path.length === 2) {
        if (op.op === 'unset') delete state.providers[id]
        else state.providers[id] = structuredClone(op.value)
        continue
      }
      const leaf = path[2]
      if (!state.providers[id]) state.providers[id] = {}
      if (op.op === 'unset') delete state.providers[id][leaf]
      else state.providers[id][leaf] = structuredClone(op.value)
    }
  }

  const ctx = {
    get: (k) => {
      if (k === 'settings') {
        return {
          describe: () => nsDesc(),
          mutate: async (_ns, ops) => {
            calls.mutate.push(ops)
            if (mutateBehavior === 'throw') throw new Error('磁盘只读')
            // 'ignore' = 假装成功、其实什么都没改（用来逼出"回读不通过 ⇒ 回滚"那条路）
            if (mutateBehavior === 'ignore') return
            applyOps(ops)
          },
        }
      }
      if (k === 'llm') {
        return {
          listProviders: () => Object.keys(state.providers).map((id) => ({ id, name: state.providers[id]?.displayName ?? id })),
          listConfigurableProviders: () => Object.keys(state.providers).map((id) => ({ provider: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id] })),
          listModels: async (id) => (state.providers[id]?.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
        }
      }
      if (k === 'credentials') {
        return {
          describe: async (ref) => ({ configured: ref in credentials }),
          set: async (ref, value) => { calls.set.push([ref, value]); credentials[ref] = value },
          unset: async (ref) => { calls.unset.push(ref); delete credentials[ref] },
        }
      }
      return null
    },
    state, calls,
  }
  return ctx
}

const LEGION_FJD = {
  id: 'fjd-ds', displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1',
  secretRef: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }],
}
const hub = (providers) => async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, providers, empty: providers.length === 0 }) })

// ── ★★ 内部读：**必须**带 `includeSecretRefs=1`（BUG-028 的收口）─────────────
//
// hub 的默认读响应不再含引用名（那是密钥库的槽位清单，不该跟着读路径公开）。
// 而这一层**需要**它：`planMaterialization()` 要把 Legion 的 `secretRef` 与 DSH 的
// `apiKeyEnv` 归一化成同一个东西来比。少了它，Legion 侧会读成"没有引用名"，
// 于是**每一轮对账都报差异** —— 而"每轮都报差异"会让人把这道读数关掉，
// 那才是真正丢掉的东西（P1/P2 的可观测性就是它）。
//
// 所以这条判据盯的是："内部消费者与 hub 的两读口径**对得上**"。
// 门禁形状上它是一条 URL 断言 —— 因为断言的正是"它问了哪一份"。
test('⑲ ★★★ 读 Legion 目录必须带 `includeSecretRefs=1`（否则对账永远报差异）', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return { status: 200, text: async () => JSON.stringify({ ok: true, providers: [LEGION_FJD], empty: false }) }
  }
  // ⚠ `fakeHost()` 返回的就是 ctx 本身（不是 `{ctx}`）—— 与文件里其它用例一致。
  const ctx = fakeHost({ initial: {} })
  // ⚠ 必须 `enabled: true`：门关着时它在读 Legion 目录**之前**就早退了（那是 ⑦ 的判据），
  //   于是这里会读到"一次请求都没有" —— 而那是"门关着"，不是"没带参数"。
  //
  // ⚠ 也必须带 `teamHubToken`：生产里这一层**总是**带着令牌（中枢设了令牌，
  //   不带就 401）。不带令牌时它走的是 URL 的另一支 —— 于是"改坏了带令牌那一支"
  //   在判据眼里看不出区别（实测：这条判据第一版就是这样漏掉了一个变异）。
  await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl, enabled: true, teamHubToken: 'T0KEN', log: () => {},
  })
  const asked = urls.find((u) => u.includes('/api/model-providers'))
  assert.ok(asked !== undefined, `这一层根本没去读 Legion 的目录：${JSON.stringify(urls)}`)
  assert.match(asked, /includeSecretRefs=1/,
    '不带这个参数就会拿到"没有引用名"的那一份，而对账需要它 ⇒ 每轮报差异')
})

test('⑲ ★ 反向锚：读到的引用名要真的进到归一化结果里', () => {
  // 如果哪天 hub 忽略那个参数（或这一层不再传它），`normalizeForCompare` 会读成 null，
  // 而 null 与 DSH 的真实值比较**永远不等** ⇒ 对账每轮报"修改 1"。
  const withRef = normalizeForCompare({ id: 'x', displayName: 'X', secretRef: 'R' })
  assert.equal(withRef.apiKeyEnv, 'R', 'Legion 侧的 `secretRef` 必须被翻成比较用的 `apiKeyEnv`')
  const without = normalizeForCompare({ id: 'x', displayName: 'X' })
  assert.equal(without.apiKeyEnv, null, '没给引用名时归一化成 null（这就是"不带参数"时的读数）')
})

// ── 纯函数：ops 翻译 ────────────────────────────────────────────────────────

test('① ★ 只改受管叶子：不覆盖整块 provider 节点（别人的未知字段不许被抹掉）', () => {
  const plan = planMaterialization({ desired: [LEGION_FJD], actual: [] })
  const t = planToOps({ plan, desired: [LEGION_FJD], actual: [] })
  // 每一条 set 的 path 都必须是 ['providers', id, <leaf>]，而不是 ['providers', id]
  for (const op of t.ops) {
    assert.equal(op.path[0], 'providers')
    assert.equal(op.path[1], 'fjd-ds')
    assert.equal(op.path.length, 3, `不许整块覆盖：${JSON.stringify(op.path)}`)
  }
  assert.deepEqual([...new Set(t.ops.map((o) => o.path[2]))].sort(), ['api', 'apiKeyEnv', 'baseURL', 'displayName', 'models'])
  // 反向锚：整块覆盖会写成一条 set path 长度 2
  assert.equal(t.ops.some((o) => o.path.length === 2), false)
})

test('② 值为 null 的叶子用 `unset` 而不是写一个 null 进去', () => {
  const noKey = { ...LEGION_FJD, secretRef: null, api: null }
  const plan = planMaterialization({ desired: [noKey], actual: [] })
  const t = planToOps({ plan, desired: [noKey], actual: [] })
  const apiOp = t.ops.find((o) => o.path[2] === 'api')
  const keyOp = t.ops.find((o) => o.path[2] === 'apiKeyEnv')
  assert.equal(apiOp.op, 'unset')
  assert.equal(keyOp.op, 'unset')
  assert.equal('value' in apiOp, false, 'unset 不带 value')
  // 反向锚：写 null 会让"没有这个字段"与"字段是空的"变成两种状态
  assert.equal(t.ops.some((o) => o.op === 'set' && o.value === null), false)
})

test('③ 逆 ops：新增的逆是"unset 整块"，修改的逆是"把当时的叶子写回去"', () => {
  const existing = { id: 'fjd-ds', displayName: '旧名', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1' }] }
  // update：displayName 变了
  const planU = planMaterialization({ desired: [LEGION_FJD], actual: [existing] })
  assert.equal(planU.counts.update, 1)
  const tU = planToOps({ plan: planU, desired: [LEGION_FJD], actual: [existing] })
  const nameBack = tU.reversed.find((o) => o.path[2] === 'displayName')
  assert.deepEqual(nameBack, { op: 'set', path: ['providers', 'fjd-ds', 'displayName'], value: '旧名' })

  // create：逆是 unset 整块
  const planC = planMaterialization({ desired: [LEGION_FJD], actual: [] })
  const tC = planToOps({ plan: planC, desired: [LEGION_FJD], actual: [] })
  assert.deepEqual(tC.reversed, [{ op: 'unset', path: ['providers', 'fjd-ds'] }])
})

test('④ ★ 删除是第二道门：`allowDeletes=false` 时只报告、不执行', () => {
  const actual = [{ id: 'svea-ds', displayName: 'SVEA', api: 'openai-completions', apiKeyEnv: 'SVEA_DS_API_KEY', models: [{ id: 'm9' }] }]
  const plan = planMaterialization({ desired: [], actual })
  assert.deepEqual(plan.delete, ['svea-ds'])
  const off = planToOps({ plan, desired: [], actual, allowDeletes: false })
  assert.deepEqual(off.skippedDeletes, ['svea-ds'])
  assert.equal(off.ops.some((o) => o.path.length === 2), false, '关着时不许出现整块 unset')
  const on = planToOps({ plan, desired: [], actual, allowDeletes: true })
  assert.deepEqual(on.skippedDeletes, [])
  assert.ok(on.ops.some((o) => o.op === 'unset' && o.path.length === 2))
  // 删除的逆操作：把看得见的叶子写回去（未知字段还原不了，见文件头那条限制）
  assert.ok(on.reversed.length >= 5)
})

test('⑤ 期望残余差异 ≠ "绝对干净"：跳过删除时判据要允许它留着', () => {
  const plan = planMaterialization({ desired: [], actual: [{ id: 'x', displayName: 'X' }] })
  const exp = expectedResidual({ skippedDeletes: ['x'], credentialRefsLeft: 1 })
  assert.deepEqual(exp, { create: 0, update: 0, delete: 1, credentialsNeeded: 1 })
  // 恰好相同 ⇒ 通过
  assert.equal(verifyResidual({ counts: { create: 0, update: 0, delete: 1, unchanged: 0 }, create: [], update: [], delete: ['x'], credentialsNeeded: ['R'] }, exp).ok, true)
  // 多出一条新增 ⇒ 不通过，且**说清差在哪**
  const bad = verifyResidual({ counts: { create: 1, update: 0, delete: 1, unchanged: 0 }, create: ['y'], update: [], delete: ['x'], credentialsNeeded: ['R'] }, exp)
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join('；'), /仍有 1 条要新增/)
  // 删除数变了也必须是失败（那是"多删了东西"的信号）
  assert.equal(verifyResidual({ counts: { create: 0, update: 0, delete: 2, unchanged: 0 }, create: [], update: [], delete: ['x', 'z'], credentialsNeeded: ['R'] }, exp).ok, false)
})

test('⑥ `providerValue` 只吐受管叶子', () => {
  const v = providerValue({ id: 'a', displayName: 'A', api: 'x', baseURL: 'https://a/v1', secretRef: 'R', models: [{ id: 'm' }], 未知: 1, credentialConfigured: true })
  assert.deepEqual(Object.keys(v).sort(), ['api', 'apiKeyEnv', 'baseURL', 'displayName', 'models'])
  assert.equal(v.apiKeyEnv, 'R', 'secretRef 要翻成 DSH 的 apiKeyEnv')
})

// ── 端到端（假宿主真的会改状态）─────────────────────────────────────────────

test('⑦ ★ 门关着 ⇒ 一个字节都不写（连 mutate 都不该被调）', async () => {
  const ctx = fakeHost({ initial: {} })
  const logs = []
  const r = await runMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: false, log: (m) => logs.push(m) })
  assert.equal(r.wrote, false)
  assert.equal(r.reason, 'gate-off')
  assert.deepEqual(ctx.calls.mutate, [], '门关着时 mutate 不许被调用')
  assert.deepEqual(ctx.calls.set, [])
  assert.deepEqual(ctx.state.providers, {}, 'DSH 的状态必须原样')
  assert.match(logs.join('\n'), /未启用/)
})

test('⑦b ★ **默认就是关**：不传 `enabled` 时也不许写（"没写就是开"是最坏的一种默认）', async () => {
  const ctx = fakeHost({ initial: {} })
  const logs = []
  // 刻意**不传** enabled —— 生产里"配置里没写"就是这条路径。
  const r = await runMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), log: (m) => logs.push(m) })
  assert.equal(r.reason, 'gate-off', '不传 enabled 必须等同于关')
  assert.equal(r.wrote, false)
  assert.deepEqual(ctx.calls.mutate, [])
  assert.deepEqual(ctx.state.providers, {}, '默认关时 DSH 必须一个字节都没变')
})

test('⑱ ★ 尾部那段也要如实报"没写"：ops 为空、只有凭证要补而 Legion 里没值', async () => {
  // 与 ⑫ 的区别：这里 `credentialsToSet` 非空（DSH 说这把钥匙没配），
  // 所以**不会**走"提前返回"那条路，而是走尾部 —— 尾部也必须把 wrote 报成 false。
  const ctx = fakeHost({
    initial: { 'fjd-ds': { displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }] } },
    // 刻意**不**播种凭证 ⇒ DSH 说没配 ⇒ 有一个凭证要补
  })
  const logs = []
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true,
    secretReader: async () => null, // Legion 里没有值 ⇒ 不许写
    log: (m) => logs.push(m),
  })
  assert.equal(r.applied, true)
  assert.equal(r.wrote, false, '没发出写就必须报 false —— 尾部的 return 与提前返回必须一致')
  assert.deepEqual(ctx.calls.mutate, [])
  assert.deepEqual(ctx.calls.set, [])
  assert.deepEqual(r.credentialsUnavailable, ['FJD_DS_API_KEY'])
  assert.match(logs.join('\n'), /无需写入/)
})

test('⑧ ★ 真写进去：mutate 之后**回读**（由真读者）确认计划变干净', async () => {
  const ctx = fakeHost({ initial: {} })
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]),
    enabled: true, allowDeletes: false, secretReader: async () => null, log: () => {},
  })
  assert.equal(r.applied, true)
  assert.equal(r.wrote, true)
  assert.equal(r.verdict.ok, true, `回读应当通过：${JSON.stringify(r.verdict?.problems)}`)
  // 状态真的变了（不是只有 mutate 被记名）
  assert.deepEqual(ctx.state.providers['fjd-ds'], {
    displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }],
  })
  // 凭证：Legion 里没有值 ⇒ **不动** DSH 的（这里 DSH 说没配，于是仍然缺，但不算失败）
  assert.deepEqual(ctx.calls.set, [], '读不到值就不许写凭证（写空串会毁掉一把正在用的钥匙）')
  assert.deepEqual(r.credentialsUnavailable, ['FJD_DS_API_KEY'])
})

test('⑨ ★ 凭证：Legion 有值且 DSH 没配 ⇒ 写入；DSH 已配 ⇒ 不动', async () => {
  const ctx = fakeHost({ initial: {} })
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]),
    enabled: true, secretReader: async (ref) => (ref === 'FJD_DS_API_KEY' ? 'sk-live-value' : null), log: () => {},
  })
  assert.deepEqual(ctx.calls.set, [['FJD_DS_API_KEY', 'sk-live-value']])
  assert.equal(r.verdict.ok, true, '写完之后不该再报"缺凭证"')
  // 已配的 DSH ⇒ credentialsNeeded 为空 ⇒ 连 secretReader 都不该被问
  //   （用 `initialCredentials` 把"DSH 已经配好了这把钥匙"这件事真的表达出来）
  const ctx2 = fakeHost({
    initial: { 'fjd-ds': { displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }] } },
    initialCredentials: ['FJD_DS_API_KEY'],
  })
  let asked = 0
  const r2 = await runMaterialization({
    ctx: ctx2, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true,
    secretReader: async () => { asked += 1; return 'x' }, log: () => {},
  })
  assert.equal(r2.wrote, false, '两侧一致 ⇒ 什么都不用写')
  assert.equal(asked, 0, 'DSH 已配的引用名不该被取值')
  assert.deepEqual(ctx2.calls.set, [])
})

test('⑩ ★ 写后回读**不通过** ⇒ 回滚，且回滚把状态改回去', async () => {
  // mutate 假装成功、其实什么都没改 ⇒ 回读必然仍有差异
  const ctx = fakeHost({ initial: {}, mutateBehavior: 'ignore' })
  const logs = []
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]),
    enabled: true, secretReader: async () => null, log: (m) => logs.push(m),
  })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'verify-failed')
  assert.equal(r.verdict.ok, false)
  assert.match(r.verdict.problems.join('；'), /仍有 1 条要新增/)
  assert.equal(r.rolled.ok, true, '回滚必须被判成功')
  assert.equal(ctx.calls.mutate.length, 2, '一次写 + 一次回滚')
  assert.deepEqual(ctx.state.providers, {}, '状态回到写入前')
  assert.match(logs.join('\n'), /回读\*\*不通过\*\*/)
})

test('⑪ 写入抛错 ⇒ 尝试回滚并如实报告（不把宿主的启动拖坏）', async () => {
  const ctx = fakeHost({ initial: {}, mutateBehavior: 'throw' })
  const logs = []
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true, log: (m) => logs.push(m),
  })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'write-failed')
  assert.match(r.error, /磁盘只读/)
  assert.equal(r.wrote, true)
  assert.match(logs.join('\n'), /尝试回滚/)
})

test('⑫ 门开着但两侧一致 ⇒ 报告"未写任何东西"，而不是假装写了一笔', async () => {
  // DSH 侧已有完全一致的条目，且**凭证也已配** ⇒ 这一轮真的什么都不用写
  const ctx = fakeHost({
    initial: { 'fjd-ds': { displayName: 'FJD', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }] } },
    initialCredentials: ['FJD_DS_API_KEY'],
  })
  const logs = []
  const r = await runMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true, log: (m) => logs.push(m) })
  assert.equal(r.applied, true)
  assert.equal(r.wrote, false, '"无需写入"不许被报成写过 —— 那是人判断"接管有没有生效"的唯一依据')
  assert.deepEqual(ctx.calls.mutate, [])
  assert.deepEqual(ctx.calls.set, [])
  assert.match(logs.join('\n'), /无差异/)
})

test('⑬ 读不到 DSH 现状 ⇒ 什么都不做（看不见现状写进去 = 闭着眼睛覆盖）', async () => {
  // 有 settings（能写）、但**没有 llm** ⇒ 读不出 DSH 现状
  const mutated = []
  const ctx = {
    get: (k) => (k === 'settings'
      ? { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: {} }], mutate: async (_n, ops) => { mutated.push(ops) } }
      : null),
  }
  const logs = []
  const r = await runMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true, log: (m) => logs.push(m) })
  assert.equal(r.applied, false)
  assert.equal(r.reason, 'actual-read-failed')
  assert.equal(r.wrote, false)
  assert.deepEqual(mutated, [], '读不到现状时不许写')
  assert.match(logs.join('\n'), /未写任何东西/)
})

test('⑭ 宿主没有 settings 服务 ⇒ 放弃且不写', async () => {
  const logs = []
  const r = await runMaterialization({ ctx: { get: (k) => (k === 'llm' ? { listProviders: () => [], listModels: async () => [] } : null) }, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true, log: (m) => logs.push(m) })
  assert.equal(r.reason, 'no-settings')
  assert.equal(r.wrote, false)
  assert.match(logs.join('\n'), /没有 settings 服务/)
})

test('⑮ 删除关着时：新条目照写、要删的条目**留着**并记进读数', async () => {
  const ghost = { id: 'ghost-ds', displayName: 'GHOST', api: 'openai-completions', baseURL: 'https://g.example/v1', apiKeyEnv: 'GHOST_API_KEY', models: [{ id: 'gm1' }] }
  const ctx = fakeHost({ initial: { 'ghost-ds': ghost } })
  const logs = []
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]),
    enabled: true, allowDeletes: false, secretReader: async () => null, log: (m) => logs.push(m),
  })
  assert.equal(r.applied, true)
  assert.equal(r.verdict.ok, true, '跳过删除属于**有意**的残余差异，判据要认它')
  assert.deepEqual(r.skippedDeletes, ['ghost-ds'])
  assert.ok(ctx.state.providers['ghost-ds'], 'ghost-ds 必须还在（删除门关着）')
  assert.ok(ctx.state.providers['fjd-ds'], 'fjd-ds 必须写进去了')
  assert.match(logs.join('\n'), /跳过删除 1.*ghost-ds/s)
})

test('⑯ 删除门打开时才真的删，并且回读通过', async () => {
  const ghost = { id: 'ghost-ds', displayName: 'GHOST', api: 'openai-completions', baseURL: 'https://g.example/v1', apiKeyEnv: 'GHOST_API_KEY', models: [{ id: 'gm1' }] }
  const ctx = fakeHost({ initial: { 'ghost-ds': ghost } })
  const r = await runMaterialization({
    ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]),
    enabled: true, allowDeletes: true, secretReader: async () => null, log: () => {},
  })
  assert.equal(r.applied, true)
  assert.equal(r.verdict.ok, true)
  assert.equal(ctx.state.providers['ghost-ds'], undefined, '门开了才真的删')
  assert.ok(ctx.state.providers['fjd-ds'])
})

test('⑰ 未知字段不许被抹掉：宿主里那条 provider 的额外字段在写入后仍在', async () => {
  const withExtra = { 'fjd-ds': { displayName: '旧', api: 'openai-responses', baseURL: 'https://a.example/v1', apiKeyEnv: 'FJD_DS_API_KEY', models: [{ id: 'm1', name: 'M1' }], timeoutMs: 30000, headers: { 'x-a': '1' } } }
  const ctx = fakeHost({ initial: withExtra })
  const r = await runMaterialization({ ctx, hubUpstream: 'http://hub.test', fetchImpl: hub([LEGION_FJD]), enabled: true, log: () => {} })
  assert.equal(r.applied, true)
  assert.equal(ctx.state.providers['fjd-ds'].timeoutMs, 30000, '我们不认识的字段必须原样留着')
  assert.deepEqual(ctx.state.providers['fjd-ds'].headers, { 'x-a': '1' })
  assert.equal(ctx.state.providers['fjd-ds'].displayName, 'FJD', '受管叶子仍然要按 Legion 写')
})
