// team-hub/budget-routes.test.mjs
// ============================================================================
// 预算账本与价目表的 HTTP 契约（PRT-503 / PRT-510 / PRT-511）
//
// 独立进程与自己的库：这一组要先发布价目表再预留，共用库会让别的路由测试
// 撞上残留状态（而那种影响看起来像"随机的 409"）。
//
// 这里补的只有真实请求才暴露的四件事：
//   ① **Attempt id 含冒号**（`att:T-1:1`），必须百分号编码后仍能正确取到
//      ——整段解码，不像绑定那样按段切（路径里只有一段）；
//   ② 状态码要能区分「参数不对」（400）、「状态不符」（409）、
//      「根本没有这笔预留」（404）；
//   ③ 结算两次必须是 409 而不是静默成功（余额被释放两次是真钱）；
//   ④ 响应体与审计里没有密钥。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-budgetroutes-'))
let mod
let base = ''

const PT = {
  version: 'route-pt-1', currency: 'USD', effectiveAtMs: 1_700_000_000_000,
  models: {
    cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 },
    dear: { billingUnit: 'per-mtok', perUnit: 10, unitSize: 1_000_000 },
  },
}

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
  const pub = await call('POST', '/api/price-tables', { actor: 'ops', ...PT })
  assert.equal(pub.status, 200, pub.raw)
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed, raw: text }
}

const reserve = (over = {}) => call('POST', '/api/runtime/run-budget/reserve', {
  attemptId: 'att:T-1:1', scope: 'default', taskId: 'T-1', modelProfileId: 'cheap',
  budget: { maxCost: 5, currency: 'USD' }, priceTableVersion: 'route-pt-1',
  tokensIn: 500_000, tokensOut: 500_000, ...over,
})

test('① 发布价目表：同版本再发布是 409（版本只增不改）', async () => {
  const again = await call('POST', '/api/price-tables', { actor: 'ops', ...PT })
  assert.equal(again.status, 409, again.raw)
  assert.equal(again.body.code, 'PRICE_TABLE_IMMUTABLE')
  // 列表里只有一版
  const list = await call('GET', '/api/price-tables')
  assert.equal(list.status, 200)
  assert.equal(list.body.priceTables.filter((t) => t.version === 'route-pt-1').length, 1)
})

test('① 取价目表本体；不存在时 404，缺版本号时 400', async () => {
  let r = await call('GET', '/api/price-tables/route-pt-1')
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.priceTable.currency, 'USD')
  assert.equal(r.body.priceTable.models.cheap.perUnit, 1)

  r = await call('GET', '/api/price-tables/never')
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'PRICE_TABLE_GONE')

  r = await call('GET', '/api/price-tables/')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'MISSING_PARAM')
})

test('① 预留：预留的是**最大预算**，返回状态与"是否显式 unbounded"', async () => {
  const r = await reserve()
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.reservation.reservedAmount, 5, '必须是预算上限 5，不是估算的 1')
  assert.equal(r.body.reservation.state, 'reserved')
  assert.equal(r.body.budgetState, 'reserved')
  assert.equal(r.body.reservation.priceTableVersion, 'route-pt-1')

  // 没有预算 = 显式 unbounded，且**不建预留**
  const u = await reserve({ attemptId: 'att:T-2:1', budget: null, priceTableVersion: undefined })
  assert.equal(u.status, 200, u.raw)
  assert.equal(u.body.budgetState, 'unbounded')
  assert.equal(u.body.reservation, null)
})

test('① 有预算但价目表版本取不到 → 409 且说清"没有上限就无从谈起"', async () => {
  const r = await reserve({ attemptId: 'att:T-3:1', priceTableVersion: 'no-such-table' })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PRICE_TABLE_GONE')
  assert.match(r.body.error, /有预算就必须有价目表/)
})

test('① 重复预留参数不一致 → 409（上限可以被改，但不能顺便被改）', async () => {
  const r = await reserve({ budget: { maxCost: 999, currency: 'USD' } })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'RESERVATION_EXISTS')
  assert.match(r.body.error, /不能靠重新预留悄悄替换/)
  // 参数一致时幂等
  const same = await reserve()
  assert.equal(same.status, 200, same.raw)
})

test('② **Attempt id 含冒号**：百分号编码后仍能取到预留本体', async () => {
  // `att:T-1:1` 里的冒号必须被编码，否则很多 HTTP 客户端/中间件会切错。
  const encoded = encodeURIComponent('att:T-1:1')
  const r = await call('GET', `/api/runtime/run-budget/${encoded}`)
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.reservation.attemptId, 'att:T-1:1')
  assert.ok(Array.isArray(r.body.usage))
  assert.equal(r.body.usage.length, 1, '预留时应落一条运行时估算')
  assert.equal(r.body.usage[0].priceTableVersion, 'route-pt-1')
})

test('② 状态码三分：参数不对 400 / 没有预留 404 / 状态不符 409', async () => {
  let r = await call('GET', '/api/runtime/run-budget/')
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'MISSING_PARAM')

  r = await call('GET', '/api/runtime/run-budget/' + encodeURIComponent('att:ghost:1'))
  assert.equal(r.status, 404, r.raw)
  assert.equal(r.body.code, 'RESERVATION_NOT_FOUND')
  // 404 的说明要把"显式 unbounded"和"遗漏"分开——两者看起来都是"没有预留"
  assert.match(r.body.error, /unbounded/)

  // 未预留就采集用量 → 409（说明这条路径绕过了账本）
  r = await call('POST', '/api/runtime/run-budget/observe', { attemptId: 'att:ghost:1', tokensIn: 1, tokensOut: 1 })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'RESERVATION_NOT_FOUND')

  // 缺 attemptId → 400
  r = await call('POST', '/api/runtime/run-budget/reserve', { modelProfileId: 'cheap', budget: { maxCost: 1, currency: 'USD' } })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'ATTEMPT_REQUIRED')
})

test('③ 采集用量：超硬上限 → 请求取消（HTTP 层也给得出 BUDGET_EXCEEDED 的动作）', async () => {
  let r = await call('POST', '/api/runtime/run-budget/observe', { attemptId: 'att:T-1:1', tokensIn: 300_000, tokensOut: 300_000 })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.cancel, false)
  assert.equal(r.body.used, 0.6)

  r = await call('POST', '/api/runtime/run-budget/observe', { attemptId: 'att:T-1:1', tokensIn: 3_000_000, tokensOut: 3_000_000 })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.cancel, true)
  assert.equal(r.body.kind, 'budget-exceeded')
  assert.match(r.body.message, /BUDGET_EXCEEDED/)
  // 状态已变为"已请求取消"
  const g = await call('GET', `/api/runtime/run-budget/${encodeURIComponent('att:T-1:1')}`)
  assert.equal(g.body.reservation.state, 'cancel-requested')
})

test('③ 结算（known）：按实际用量结算并释放余额', async () => {
  const r = await call('POST', '/api/runtime/run-budget/settle', {
    attemptId: 'att:T-1:1', tokensIn: 200_000, tokensOut: 200_000, outcome: 'known', actor: 'u1',
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.reservation.spentAmount, 0.4)
  assert.equal(r.body.reservation.state, 'settled')
  assert.equal(r.body.overrun, 0)

  // 余额释放后该 scope 不再有占用
  const list = await call('GET', '/api/runtime/run-budget?scope=default')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.held, [])
})

test('③ **二次结算 → 409**（余额被释放两次是真钱）', async () => {
  const r = await call('POST', '/api/runtime/run-budget/settle', {
    attemptId: 'att:T-1:1', tokensIn: 200_000, tokensOut: 200_000, outcome: 'known', actor: 'u2',
  })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'ALREADY_SETTLED')
  // 金额未被第二次结算覆盖
  const g = await call('GET', `/api/runtime/run-budget/${encodeURIComponent('att:T-1:1')}`)
  assert.equal(g.body.reservation.spentAmount, 0.4)
})

test('③ 结算缺 outcome / 缺 actor → 400（不给就无法区分"已确认"与"不知道"）', async () => {
  let r = await call('POST', '/api/runtime/run-budget/settle', { attemptId: 'att:T-2:1', actor: 'u1' })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'OUTCOME_REQUIRED')
  r = await call('POST', '/api/runtime/run-budget/settle', { attemptId: 'att:T-2:1', outcome: 'known' })
  assert.equal(r.status, 400, r.raw)
  assert.equal(r.body.code, 'ACTOR_REQUIRED')
})

test('④ outcome=unknown → locked，且 locked 不能直接结算（只能人工处置）', async () => {
  await reserve({ attemptId: 'att:T-9:1' })
  let r = await call('POST', '/api/runtime/run-budget/settle', {
    attemptId: 'att:T-9:1', outcome: 'unknown', actor: 'u1', reason: 'cancel-ack-timeout',
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.locked, true)
  assert.equal(r.body.reservation.state, 'locked')
  assert.equal(r.body.reservation.spentAmount, null, '结果未知时不得写入任何实际金额')

  // 锁定的钱仍然占着
  const list = await call('GET', '/api/runtime/run-budget?scope=default')
  assert.deepEqual(list.body.held, [{ currency: 'USD', held: 5 }])

  // 直接结算 locked → 409
  r = await call('POST', '/api/runtime/run-budget/settle', { attemptId: 'att:T-9:1', outcome: 'known', actor: 'u1' })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'RESERVATION_LOCKED')

  // 人工处置 release → 释放
  r = await call('POST', '/api/runtime/run-budget/resolve', {
    attemptId: 'att:T-9:1', disposition: 'release', actor: 'ops-1', reason: '确认未扣费',
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.reservation.state, 'settled')
  assert.equal(r.body.reservation.spentAmount, 0)

  // 对非 locked 的预留做人工处置 → 409（调用方对当前状态的理解是错的）
  r = await call('POST', '/api/runtime/run-budget/resolve', {
    attemptId: 'att:T-9:1', disposition: 'release', actor: 'ops-1',
  })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.state, 'settled')
})

test('④ 超支如实报出，不裁剪，且仍然可以结算', async () => {
  await reserve({ attemptId: 'att:T-10:1', budget: { maxCost: 2, currency: 'USD' } })
  const r = await call('POST', '/api/runtime/run-budget/settle', {
    attemptId: 'att:T-10:1', tokensIn: 6_000_000, tokensOut: 6_000_000, outcome: 'known', actor: 'u1',
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.reservation.spentAmount, 12)
  assert.equal(r.body.reservation.overrunAmount, 10, '超支差额必须是 10，不是 0')
  assert.equal(r.body.overrun, 10)
})

test('⑤ 换模型：更贵未批准 → 409；批准 → 允许；未定价 → 拒绝', async () => {
  let r = await call('POST', '/api/runtime/run-budget/may-switch-model', {
    from: 'cheap', to: 'dear', priceTableVersion: 'route-pt-1', tokensIn: 500_000, tokensOut: 500_000,
  })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'MORE_EXPENSIVE_NEEDS_APPROVAL')
  assert.match(r.body.error, /不得在未获用户批准时自动切换到更昂贵模型/)

  r = await call('POST', '/api/runtime/run-budget/may-switch-model', {
    from: 'cheap', to: 'dear', priceTableVersion: 'route-pt-1',
    tokensIn: 500_000, tokensOut: 500_000, approved: true,
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.allowed, true)

  // 更便宜 → 允许（省钱不需要批准）
  r = await call('POST', '/api/runtime/run-budget/may-switch-model', {
    from: 'dear', to: 'cheap', priceTableVersion: 'route-pt-1', tokensIn: 500_000, tokensOut: 500_000,
  })
  assert.equal(r.status, 200, r.raw)
  assert.equal(r.body.allowed, true)

  // 未定价 → 409，且批准不能替代定价
  r = await call('POST', '/api/runtime/run-budget/may-switch-model', {
    from: 'cheap', to: 'unpriced', priceTableVersion: 'route-pt-1',
    tokensIn: 500_000, tokensOut: 500_000, approved: true,
  })
  assert.equal(r.status, 409, r.raw)

  // 价目表版本不存在 → 409（不是 400：请求没错，是缺表）
  r = await call('POST', '/api/runtime/run-budget/may-switch-model', {
    from: 'cheap', to: 'dear', priceTableVersion: 'nope', tokensIn: 1, tokensOut: 1,
  })
  assert.equal(r.status, 409, r.raw)
  assert.equal(r.body.code, 'PRICE_TABLE_GONE')
  assert.match(r.body.error, /不能靠"查不清"来满足/)
})

test('⑥ 列表按 scope / state 过滤，且带 held 汇总', async () => {
  const all = await call('GET', '/api/runtime/run-budget')
  assert.equal(all.status, 200)
  // 三次预留：att:T-1:1（已结算）、att:T-9:1（锁定后人工释放）、att:T-10:1（超支结算）
  // 注意 att:T-2:1 是 unbounded，**不该**留下预留——这正是"没配预算"与
  // "预算闸门在工作"必须能分开的地方。
  assert.ok(all.body.reservations.length >= 3, JSON.stringify(all.body.reservations.map((r) => r.attemptId)))
  assert.ok(!all.body.reservations.some((r) => r.attemptId === 'att:T-2:1'),
    'unbounded 的运行不得留下预留')
  assert.deepEqual(all.body.held, [], '全部结算后不应还有占用')

  const settled = await call('GET', '/api/runtime/run-budget?state=settled')
  assert.ok(settled.body.reservations.length >= 3)
  assert.ok(settled.body.reservations.every((r) => r.state === 'settled'))

  const scoped = await call('GET', '/api/runtime/run-budget?scope=default')
  assert.ok(scoped.body.reservations.every((r) => r.scope === 'default'))
  const other = await call('GET', '/api/runtime/run-budget?scope=nope')
  assert.deepEqual(other.body.reservations, [])
  assert.deepEqual(other.body.held, [])
})

test('⑥ 审计留痕且**不含密钥**：只记金额、模型 id、价目表版本', async () => {
  const rows = mod.db.prepare(
    "SELECT action, member, scope, taskId, detail FROM audit WHERE action LIKE 'budget.%' ORDER BY seq",
  ).all()
  const actions = rows.map((r) => r.action)
  for (const want of [
    'budget.price-table-published', 'budget.reserve', 'budget.cancel-requested',
    'budget.settle', 'budget.lock', 'budget.human-release', 'budget.model-switch-refused',
  ]) {
    assert.ok(actions.includes(want), `缺审计动作 ${want}（实到：${actions.join(', ')}）`)
  }
  const text = JSON.stringify(rows)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(text), `审计泄露密钥：${text}`)
  assert.ok(!text.includes('secretRef'), '审计不得含 secretRef')
  // 预留审计要能回答"上限多少、什么币种、哪版价"
  const reserveAudit = rows.find((r) => r.action === 'budget.reserve')
  const detail = JSON.parse(reserveAudit.detail)
  assert.equal(detail.reservedAmount, 5)
  assert.equal(detail.currency, 'USD')
  assert.equal(detail.priceTableVersion, 'route-pt-1')
  // 结算审计要能回答"实际花了多少、超了没有、谁结的"
  const settleAudit = rows.find((r) => r.action === 'budget.settle')
  const sd = JSON.parse(settleAudit.detail)
  assert.equal(sd.spent, 0.4)
  assert.equal(sd.overrun, 0)
  assert.equal(sd.actor, 'u1')
})

test('⑥ 响应体里没有密钥（在原始字节上验）', async () => {
  const g = await call('GET', `/api/runtime/run-budget/${encodeURIComponent('att:T-1:1')}`)
  assert.ok(!g.raw.includes('secretRef'), `预留响应不得含 secretRef：${g.raw}`)
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(g.raw))
  const p = await call('GET', '/api/price-tables/route-pt-1')
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(p.raw))
})

// ============================================================================
// PRT-316 切片 18 · 契约块 —— 破验量出来"没人问过"的五件事
//
// 第一轮破验（改坏 18 处行为）只咬住 11 处。逐条量过之后，那 7 条里
// **1 条是我的刀不快**、**1 条可证等价**、**5 条是真缺口**：
//
//   · M18（dispatch 恒 `return false`）—— **刀不快**：`return false` 在
//     `await r.run(...)` **之后**，响应早写完了，改不改都一样看得见。
//     已换成"在 run 之前就 return"（那才是可观测的）。
//   · M5（回执 `version` 用 `body.version` 而不是 `saved.version`）—— **可证等价**：
//     本套件第一条用例就钉住"同版本再发布是 409" ⇒ 版本是**按请求给的**存进去的，
//     两个表达式恒等。
//   · M2/M4/M7/M13/M15 —— **真缺口**，即下面这五条。
//
// ★ 期望值全部**先量出来**再写死（`.worktrees/_prt-handoff/probe-slice18-gaps.mjs`）。
//   量出来一件改草稿的事：发布回执里的 `models` 是**键名数组**（`["cheap"]`），
//   而按版本取的 `models` 是**规范化后的对象**（补出 `perUnitIn`/`perUnitOut`/`hasPeak`…）。
//   两个端点对同一个字段用两种形状 —— 不量就会写错断言，然后去改产品。
// ============================================================================

/** 发布一张价目表并返回它的版本号（版本号带时间戳，避免撞已存在的）。 */
async function publishTable(tag, over = {}) {
  const version = `${tag}-${Date.now()}`
  const r = await call('POST', '/api/price-tables', { actor: 'route-test', version, currency: 'USD', effectiveAtMs: 1234, ...over })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
  return { version, body: r.body }
}

test('⑦ ★★ 发布不带 `models` ⇒ 落到**空表**，不是 undefined', async () => {
  // 兜底那件事只有"不给 models"时才可观测 —— 既有用例每一张都给了 models。
  const { body } = await publishTable('slice18-nomodels')
  assert.equal(body.ok, true)
  assert.deepEqual([...body.priceTable.models], [],
    '不给 models 时要落到空表；回执里是**键名数组**，空表就是空数组')

  // 存下来的本体也必须是空表（回执好看、库里是 undefined，就是两回事）
  const got = await call('GET', `/api/price-tables/${body.priceTable.version}`)
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.priceTable.models, {},
    '不给 models 时库里存的必须是空表，否则按版本取会回 null')
})

test('⑧ ★ 发布回执的 `models` 是**键名数组**，且与发布的内容一致', async () => {
  const { body } = await publishTable('slice18-keys', {
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 1, unitSize: 1_000_000 },
      dear: { billingUnit: 'per-mtok', perUnit: 9, unitSize: 1_000_000 } },
  })
  assert.deepEqual([...body.priceTable.models].sort(), ['cheap', 'dear'],
    '回执要能直接看出"这张表覆盖了哪几个模型"；回成对象就得多解一层，回成 undefined 就什么都看不出')
})

test('⑨ ★ 列表回执带 `ok` 与 `serverTimeMs`，并且真的列出已发布的表', async () => {
  const { version } = await publishTable('slice18-list')
  const r = await call('GET', '/api/price-tables')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true, '列表也要有 ok —— 少了它，调用方无法区分"空列表"与"字段没给"')
  assert.equal(typeof r.body.serverTimeMs, 'number',
    'serverTimeMs 是这条端点的时间读数；少了它，"这份列表有多旧"就无从判断')
  const mine = r.body.priceTables.find((p) => p.version === version)
  assert.ok(mine, '刚发布的表必须出现在列表里')
  assert.equal(mine.currency, 'USD')
  assert.equal(mine.createdBy, 'route-test', '列表要带上是**谁**发布的')
})

test('⑩ ★ 按版本取的 `version` / `effectiveAtMs` 忠实于存下来的那张', async () => {
  const { version } = await publishTable('slice18-faithful', { effectiveAtMs: 1_700_111_222_333 })
  const r = await call('GET', `/api/price-tables/${version}`)
  assert.equal(r.status, 200)
  assert.equal(r.body.priceTable.version, version,
    '回执里的 version 必须是存下来的那个，不是请求里的那个（两者只在 normalize 之后才恒等）')
  assert.equal(r.body.priceTable.effectiveAtMs, 1_700_111_222_333,
    '生效时刻被改成 0 之后，"这张表从什么时候开始算"就再也答不出来了')
})

test('⑪ ★ 按版本取的 `models` 是**规范化后的对象**；空表回 `{}`', async () => {
  const { version } = await publishTable('slice18-norm', {
    models: { cheap: { billingUnit: 'per-mtok', perUnit: 3, unitSize: 1_000_000 } },
  })
  const r = await call('GET', `/api/price-tables/${version}`)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body.priceTable.models), ['cheap'])
  // ★ 形状与发布回执**不同**（那边是键名数组）：这里是给算钱的人读的规范对象。
  assert.equal(r.body.priceTable.models.cheap.perUnit, 3)
  assert.equal(typeof r.body.priceTable.models.cheap.perUnitIn, 'number',
    '取向要补出来，否则调用方自己判断"单价是按哪个方向算的"')

  const empty = await publishTable('slice18-empty')
  const re = await call('GET', `/api/price-tables/${empty.version}`)
  assert.deepEqual(re.body.priceTable.models, {},
    '空表要回 {}，不能回 null —— 回 null 会让每个调用点都要多一个判空')
})

// ============================================================================
// PRT-316 切片 18 · 契约块（续）—— 第二轮破验新咬出来的一条
//
// M20 把前缀路由的 `path` 从 `'/api/price-tables/'` 去掉尾斜杠。
// 第一轮我判它"不该被咬住"，理由是"精确路由在前、切前缀用的是字面量"——
// 那个理由对**已测过的**路径都成立，所以它看起来像等价。
//
// 但有一条路径能分清：`/api/price-tablesX`。
//   · 正确（带尾斜杠）：不匹配 ⇒ 落到 404「这条路径不存在」；
//   · 去掉尾斜杠：被前缀路由认领 ⇒ 切成空版本号 ⇒ 400「缺版本号」。
// 于是它**不是**等价 —— 是我的刀恰好砍在了一条没人测过的路径上。
//
//   > 一个"这个改动不可观测"的判断，与一个"这个改动只在没人测过的那条路径上可观测"
//   > 的事实，在我只跑了已有用例的时候是同一个东西。
// ============================================================================

test('⑫ ★ 前缀路由必须**真的**以 `/` 结尾（`/api/price-tablesX` 不该被它认领）', async () => {
  const r = await call('GET', '/api/price-tablesX')
  assert.equal(r.status, 404,
    '少了尾斜杠，前缀路由会把 `/api/price-tablesX` 也认领进来、再切成空版本号，' +
    '于是回 400「缺版本号」—— 而正确的答案是 404：这条路径根本不存在，' +
    '不是"参数没给"。两者的区别决定了调用方该去改请求还是去改路径。')
})
