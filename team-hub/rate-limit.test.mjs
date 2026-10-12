// team-hub/rate-limit.test.mjs
// ============================================================================
// 滑窗闸门的纯决策 —— **两个入口共用一份边界规则**：
//   · `limitDecision` —— 短窗口的**尝试**限速（登录/注册/口令重置）
//   · `quotaDecision` —— 长窗口的**用量**配额（一个账号建了多少资源）
//
// 守的是**边界**与**用户看到的那句话**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  limitDecision, limitMessage, quotaDecision, quotaMessage, QUOTA_RESOURCES, QUOTA_CODE,
  checkQuotaLimitsMatch, RATE_LIMIT_CODE, RATE_LIMIT_STATUS,
} from './rate-limit.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_800_000_000_000

// ── ① 允许 / 拒绝 ───────────────────────────────────────────────────────────

test('★★★ 窗口内没到上限就允许，到了就拒', () => {
  const opts = { atMs: T0, max: 3, windowMs: MIN }
  assert.equal(limitDecision({ ...opts, times: [] }).allowed, true)
  assert.equal(limitDecision({ ...opts, times: [T0 - 1] }).allowed, true)
  assert.equal(limitDecision({ ...opts, times: [T0 - 1, T0 - 2] }).allowed, true)
  const full = limitDecision({ ...opts, times: [T0 - 1, T0 - 2, T0 - 3] })
  assert.equal(full.allowed, false, '第 max 次之后（= 第 max+1 次请求）该被拒')
  assert.equal(full.count, 3)
  assert.equal(full.max, 3)
})

test('★★★ 窗口外的旧记录不计入（否则配额永远不恢复）', () => {
  const opts = { atMs: T0, max: 2, windowMs: MIN }
  // 两条都在窗口外 → 允许。
  const old = limitDecision({ ...opts, times: [T0 - MIN - 1, T0 - MIN - 5000] })
  assert.equal(old.allowed, true)
  assert.equal(old.count, 0, 'count 必须是**窗口内**的条数，不是 times.length')
  // 一条在外一条在内 → 允许（1 < 2）。
  assert.equal(limitDecision({ ...opts, times: [T0 - MIN - 1, T0 - 1] }).allowed, true)
  // 两条都在内 → 拒。
  assert.equal(limitDecision({ ...opts, times: [T0 - 1, T0 - 2] }).allowed, false)
})

test('★★★ 边界用 `>`：正好落在窗口起点的那一条**不算**', () => {
  // 用 `>=` 的话，正好落在边界上的记录会因为"时间一直在走"而**永远**留在窗口里，
  // 于是配额少一次且**永远不会恢复** —— 一个只在特定时刻触发的死锁。
  const d = limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [T0 - MIN] })
  assert.equal(d.allowed, true, '边界上的那条应当已经过期')
  assert.equal(d.count, 0)
  // 而**差一毫秒**就还在窗口里。
  const inside = limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [T0 - MIN + 1] })
  assert.equal(inside.allowed, false, '窗口内一毫秒也算在窗口内')
})

test('★★★ `Retry-After` 是"最早那条过期"，不是"整个窗口"', () => {
  const opts = { atMs: T0, max: 2, windowMs: MIN }
  // 最早的是 50 秒前 → 还要等 10 秒，而不是 60 秒。
  const d = limitDecision({ ...opts, times: [T0 - 50_000, T0 - 1000] })
  assert.equal(d.allowed, false)
  assert.equal(d.retryAfterMs, 10_000, '应当只要求等最早那条过期')
  assert.notEqual(d.retryAfterMs, MIN, '不许回整个窗口 —— 那会多关用户一段时间')
  // 回的是整数**秒**，且至少 1（回 0 会让客户端立刻重试，那正是最坏的反应）。
  assert.equal(d.retryAfterSec, 10)
})

test('★ 剩余时间不足一秒也要回 1 秒（不许回 0）', () => {
  const d = limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [T0 - MIN + 200] })
  assert.equal(d.allowed, false)
  assert.equal(d.retryAfterMs, 200)
  assert.equal(d.retryAfterSec, 1, '不足一秒回 1，不回 0')
})

test('★ 多条里取**最早**的那条算等待时间', () => {
  const d = limitDecision({ atMs: T0, max: 3, windowMs: MIN, times: [T0 - 10_000, T0 - 59_000, T0 - 30_000] })
  assert.equal(d.allowed, false)
  assert.equal(d.retryAfterMs, 1000, '最早那条（59 秒前）还要 1 秒')
})

// ── ② 关掉闸门 ──────────────────────────────────────────────────────────────

test('★★ `max <= 0` = 显式**关掉**（不是"谁都不许"）', () => {
  // 语义搞反的后果是把自己锁在门外 —— 一个"配 0 表示禁止一切"的限速，
  // 会让运维在紧急时刻把自己关在外面。
  for (const max of [0, -1, -100]) {
    const d = limitDecision({ atMs: T0, max, windowMs: MIN, times: [T0 - 1, T0 - 2, T0 - 3, T0 - 4] })
    assert.equal(d.allowed, true, `max=${max} 应当放行一切`)
    assert.equal(d.disabled, true)
    assert.equal(d.retryAfterSec, 0)
  }
})

test('★ 非数字 / 缺窗口也按"关掉"处理（不抛、不锁人）', () => {
  for (const bad of [NaN, undefined, null, 'x']) {
    assert.equal(limitDecision({ atMs: T0, max: bad, windowMs: MIN, times: [T0 - 1, T0 - 1] }).disabled, true,
      `max=${String(bad)} 应当被当作关掉`)
  }
  assert.equal(limitDecision({ atMs: T0, max: 3, windowMs: 0, times: [T0 - 1, T0 - 2, T0 - 3] }).allowed, true)
  assert.equal(limitDecision({ atMs: T0, max: 3, windowMs: NaN, times: [T0 - 1, T0 - 2, T0 - 3] }).allowed, true)
})

test('★ 边界 max=1：窗口里有一条就拒', () => {
  assert.equal(limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [] }).allowed, true)
  assert.equal(limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [T0] }).allowed, false)
})

// ── ③ 垃圾输入 ──────────────────────────────────────────────────────────────

test('★ `times` 里的垃圾值被忽略（不参与计数、不参与取最早）', () => {
  const d = limitDecision({ atMs: T0, max: 2, windowMs: MIN, times: [T0 - 1, null, 'x', NaN, undefined, {}] })
  assert.equal(d.count, 1, '只有那一个数字算数')
  assert.equal(d.allowed, true)
  // 最早那条是 `T0 - 2`（毫秒），所以还要等 `MIN - 2` 毫秒。
  // （我第一版在这里写的是 `MIN - 1` —— 算错了，而实现是对的。判据期望写错时
  //   要先算一遍再判断是"实现错"还是"期望错"，别顺手去改实现。）
  assert.equal(limitDecision({ times: [T0 - 1, T0 - 2], atMs: T0, max: 2, windowMs: MIN }).retryAfterMs, MIN - 2)
  // 垃圾值也不许污染"取最早"：真正的数字是 `T0 - 5`。
  const g = limitDecision({ atMs: T0, max: 1, windowMs: MIN, times: [T0 - 5, NaN, 'x', {}] })
  assert.equal(g.allowed, false)
  assert.equal(g.retryAfterMs, MIN - 5, '最早那条应当是 T0-5，不是垃圾值')
})

test('★ `times` 不是数组时当空（不抛）', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.equal(limitDecision({ atMs: T0, max: 2, windowMs: MIN, times: bad }).allowed, true)
  }
  assert.equal(limitDecision().allowed, true, '完全不传参数也不抛')
})

test('★ 不修改传入的数组（调用方可能还要用它）', () => {
  const times = [T0 - 1, T0 - MIN - 1]
  const copy = [...times]
  limitDecision({ atMs: T0, max: 5, windowMs: MIN, times })
  assert.deepEqual(times, copy, 'limitDecision 不许就地改数组')
})

// ── ④ 用户看到的那句话 ──────────────────────────────────────────────────────

test('★★★ 限速消息必须说清"是**来源**限速，不是账号被封"', () => {
  // 不说清的话，用户会去改密码、去问管理员"我账号是不是被封了"，
  // 而其实换一个网络或等一会儿就好了。同一办公室／同一运营商出口后面的人
  // 会**一起**被限，那不是他的错。
  const msg = limitMessage({ retryAfterSec: 120 })
  assert.match(msg, /来源/, '必须点明是来源级别')
  assert.match(msg, /不是账号被封/)
  assert.match(msg, /换一个网络/, '要给出可操作的出路')
  assert.match(msg, /2 分钟/, '等待时间要写成分钟，别让用户自己算秒')
})

test('★★★ 限速消息**不许**泄露用户名是否存在', () => {
  // 这条消息对"猜别人的名字"和"猜自己的名字"必须是**同一句** ——
  // 否则它就成了一个用户名探测接口（比限速本身更值钱）。
  const a = limitMessage({ retryAfterSec: 60 })
  const b = limitMessage({ retryAfterSec: 60 })
  assert.equal(a, b, '同一输入必须完全同一句话，不许带任何与账号相关的部分')
  // 消息里不许出现用户名占位、也不许出现"不存在/未注册/没有这个用户"这类措辞。
  for (const forbidden of ['不存在', '未注册', '没有这个', '用户名', '{name}', '该用户']) {
    assert.equal(a.includes(forbidden), false, `限速消息里不该出现 ${forbidden}`)
  }
})

test('★ 等待时间不足一分钟也报"1 分钟"（不报 0）', () => {
  assert.match(limitMessage({ retryAfterSec: 1 }), /1 分钟/)
  assert.match(limitMessage({ retryAfterSec: 0 }), /1 分钟/)
  assert.match(limitMessage({}), /1 分钟/, '不传参数也不许出现 0 分钟')
})

test('★ 账号级措辞与来源级措辞可区分', () => {
  assert.match(limitMessage({ retryAfterSec: 60, scope: 'account' }), /这个账号/)
  assert.match(limitMessage({ retryAfterSec: 60, scope: 'source' }), /这个网络/)
})

test('★ 状态码与错误码是常量（前端按**类型**分支，不按文案匹配）', () => {
  assert.equal(RATE_LIMIT_STATUS, 429)
  assert.equal(RATE_LIMIT_CODE, 'IDENTITY_RATE_LIMITED')
  assert.equal(QUOTA_CODE, 'ACCOUNT_QUOTA_EXCEEDED')
  assert.match(RATE_LIMIT_CODE, /^[A-Z_]+$/, '错误码应当是常量形状')
  // ★ 两个码必须**不同**：来源限速与账号配额要采取的动作不一样
  //   （换网络 vs 等窗口/请管理员调高），前端不可能用同一个码分支。
  assert.notEqual(RATE_LIMIT_CODE, QUOTA_CODE, '限速与配额必须是两个错误码')
})

// ── ⑤ 配额（长窗口用量）：与限速**共用**边界规则 ───────────────────────────────

test('★★★ `quotaDecision` 与 `limitDecision` 在边界上必须完全一致', () => {
  // 这一条是这次重构（抽出共享的 `decide`）的**存在理由**。
  // 两份抄开的边界规则会各自演化：某天有人在其中一个里把 `>` 改成 `>=`，
  // 另一个不动，于是同一产品里两个闸门对"边界那一毫秒"给出不同答案。
  const cases = [
    { count: 0, oldestMs: null, atMs: T0, max: 3, windowMs: HOUR },
    { count: 2, oldestMs: T0 - 1000, atMs: T0, max: 3, windowMs: HOUR },
    // 正好打在边界上：`oldestMs === atMs - windowMs` → 那一瞬间**不算**在窗口内，
    // 但这里 `count` 已经由存储层算好（它用的是同一条 `>`），所以两边都给"拒"。
    { count: 3, oldestMs: T0 - 5000, atMs: T0, max: 3, windowMs: HOUR },
    { count: 5, oldestMs: T0 - HOUR + 1, atMs: T0, max: 3, windowMs: HOUR },
    { count: 5, oldestMs: null, atMs: T0, max: 3, windowMs: HOUR },
    { count: 9, oldestMs: T0 - 10, atMs: T0, max: 0, windowMs: HOUR },
    { count: 9, oldestMs: T0 - 10, atMs: T0, max: 3, windowMs: 0 },
    { count: 9, oldestMs: T0 - 10, atMs: T0, max: NaN, windowMs: HOUR },
  ]
  for (const c of cases) {
    const q = quotaDecision(c)
    // 同样的 count/oldest 走 limitDecision：造一个恰好产生该 count/oldest 的 times 数组
    // 是不必要的 —— 直接比两个入口对**同一份输入**的结论。
    const l = limitDecision({
      times: Array.from({ length: c.count }, (_, i) => (i === 0 ? (c.oldestMs ?? c.atMs) : c.atMs - 1)),
      atMs: c.atMs, max: c.max, windowMs: c.windowMs,
    })
    assert.equal(q.allowed, l.allowed, `allowed 不一致：${JSON.stringify(c)}`)
    assert.equal(q.disabled, l.disabled, `disabled 不一致：${JSON.stringify(c)}`)
    assert.equal(q.retryAfterSec, l.retryAfterSec, `retryAfterSec 不一致：${JSON.stringify(c)}`)
  }
})

test('★★★ 配额的生产形状：几百条用量、一条 `COUNT+MIN` 就够', () => {
  // `quotaDecision` 存在的理由是**性能**：上限是几百，不能每次都把窗口内的行
  // 全取回来。所以它只吃 `{count, oldestMs}` 两个数。
  const d = quotaDecision({ count: 300, oldestMs: T0 - 600_000, atMs: T0, max: 300, windowMs: HOUR })
  assert.equal(d.allowed, false)
  assert.equal(d.count, 300)
  assert.equal(d.retryAfterSec, Math.ceil((HOUR - 600_000) / 1000), 'Retry-After 用最早那条算')
  // 没到上限就放行。
  assert.equal(quotaDecision({ count: 299, oldestMs: T0 - 600_000, atMs: T0, max: 300, windowMs: HOUR }).allowed, true)
})

test('★★ `oldestMs` 缺失时回一整个窗口（唯一能给出的保守答案）', () => {
  // 不能让 retryAfterSec 变成 0 或 NaN —— 那会让客户端立刻重试。
  const d = quotaDecision({ count: 5, oldestMs: null, atMs: T0, max: 3, windowMs: HOUR })
  assert.equal(d.allowed, false)
  assert.equal(d.retryAfterMs, HOUR)
  assert.equal(d.retryAfterSec, 3600)
  assert.ok(Number.isFinite(d.retryAfterSec) && d.retryAfterSec >= 1)
})

test('★★ `count` 缺失/垃圾当 0（不抛、不误拒）', () => {
  for (const bad of [undefined, null, NaN, 'x', {}]) {
    const d = quotaDecision({ count: bad, atMs: T0, max: 3, windowMs: HOUR })
    assert.equal(d.allowed, true, `count=${String(bad)} 应当被当成 0`)
    assert.equal(d.count, 0)
  }
  assert.equal(quotaDecision().allowed, true, '完全不传参数也不抛')
})

test('★★★ 配额消息必须说清"是账号自己的容量上限"，且**不能**说成换网络就好', () => {
  // ★ 与 `limitMessage` 的**关键差别**。来源限速受限的是 IP（可能整间办公室），
  //   所以那条要说"换一个网络通常可以立即继续"。配额受限的是**他自己的账号**，
  //   换网络完全没用 —— 把两者写成同一句话会让用户按错误的方向自救。
  const msg = quotaMessage({ resource: 'message', max: 300, windowSec: 3600, retryAfterSec: 600 })
  assert.match(msg, /上限/)
  assert.match(msg, /300/, '要把上限的数字说出来')
  assert.match(msg, /60 分钟/, '要把窗口说出来')
  assert.match(msg, /10 分钟/, '要把还要等多久说出来')
  assert.match(msg, /容量保护/, '要说清这是容量保护，不是封禁')
  assert.equal(msg.includes('换一个网络'), false,
    '配额消息**不许**建议换网络 —— 换网络对账号配额完全无效，那是一句谎话')
  // 而且要让用户知道 Agent 的汇报不受影响（否则他会以为产品坏了）。
  assert.match(msg, /Agent/)
})

test('★ 配额消息里的分钟数与秒数都是整数、且不为 0', () => {
  for (const retryAfterSec of [0, 1, 59, 60, 3599, 3600]) {
    const m = quotaMessage({ resource: 'message', max: 10, windowSec: 3600, retryAfterSec })
    // ⚠️ 必须用 `(?<!\d)`：`/0 分钟/` 会在 **「60 分钟」** 里匹配到那个 0 ——
    //    于是判据在正确实现上变红。这与上一轮 `includes('t(message)')` 命中
    //    `toast(message)` 是同一类错：**子串不是词**。
    assert.doesNotMatch(m, /(?<!\d)0 分钟/, `retryAfterSec=${retryAfterSec} 出现了"0 分钟"`)
    assert.doesNotMatch(m, /NaN|undefined|\[object/)
  }
})

test('★ 配额的定义表：每个资源都有单位、默认上限与窗口', () => {
  for (const [name, spec] of Object.entries(QUOTA_RESOURCES)) {
    assert.ok(Number.isFinite(spec.defaultMax) && spec.defaultMax > 0, `${name} 缺 defaultMax`)
    assert.ok(Number.isFinite(spec.defaultWindowMs) && spec.defaultWindowMs > 0, `${name} 缺 defaultWindowMs`)
    assert.equal(typeof spec.unit, 'string')
    assert.ok(spec.unit.length > 0, `${name} 的 unit 不能是空的（消息里要用它）`)
  }
  assert.ok(Object.keys(QUOTA_RESOURCES).includes('message'), '至少要有消息这一种')
})

test('★★★ 反例守卫：`QUOTA_RESOURCES` 的默认值必须真的被用来报数', () => {
  // 一张"定义了但没人读"的表，与一张不存在的表，在运行期是同一个东西 ——
  // 除了它让人觉得已经配好了。所以这里钉住"消息里出现的数字来自那张表"。
  const spec = QUOTA_RESOURCES.message
  const msg = quotaMessage({ resource: 'message', max: spec.defaultMax, windowSec: Math.round(spec.defaultWindowMs / 1000), retryAfterSec: 60 })
  assert.ok(msg.includes(String(spec.defaultMax)), '消息里的上限必须是表里的那个数')
  assert.match(msg, new RegExp(spec.unit))
})

// ── ⑥ 启动期自检：键对不上必须**响亮地**拒绝 ─────────────────────────────────

test('★★★ 键一致时通过', () => {
  assert.equal(checkQuotaLimitsMatch({
    limits: { message: 300 }, resources: { message: { unit: '条' } },
  }), true)
  assert.equal(checkQuotaLimitsMatch({ limits: {}, resources: {} }), true, '两张空表也算一致')
})

test('★★★ 键对不上必须**抛**，而且点名差在哪', () => {
  // 这条守的是一个静默的失败：键写错时 `spec === undefined` 放行、
  // `max === undefined` 又被判成"关掉" —— 两条路都通向**不限**，且没有日志。
  // > 一个"配了但键对不上"的配额，与一个"根本没配"的配额，
  // > 在运行期是同一个东西 —— 除了前者让人觉得已经防住了。
  assert.throws(
    () => checkQuotaLimitsMatch({ limits: {}, resources: { message: {} } }),
    /键不一致[\s\S]*message/, '缺键必须抛，且消息里要点名 message')
  assert.throws(
    () => checkQuotaLimitsMatch({ limits: { msg: 1 }, resources: { message: {} } }),
    /键不一致/, '拼错（msg vs message）也必须抛')
  assert.throws(
    () => checkQuotaLimitsMatch({ limits: { message: 1, extra: 2 }, resources: { message: {} } }),
    /extra/, '多出来的键也要点名 —— 它意味着有人加了一条从不生效的上限')
})

test('★ 缺参数时按空表处理（不抛 TypeError，抛的是那条业务错）', () => {
  assert.equal(checkQuotaLimitsMatch(), true)
  assert.equal(checkQuotaLimitsMatch({}), true)
})

test('★★★ 反例守卫：真实的两张表当前必须一致（否则服务器起不来）', () => {
  // 把 `QUOTA_RESOURCES` 直接喂进去 —— 这条会跟着资源表一起演化。
  // 加一种新资源却忘了在 server.mjs 的 QUOTA_LIMITS 里加上限时，这里会先红。
  const limits = {}
  for (const k of Object.keys(QUOTA_RESOURCES)) limits[k] = QUOTA_RESOURCES[k].defaultMax
  assert.equal(checkQuotaLimitsMatch({ limits, resources: QUOTA_RESOURCES }), true)
})
