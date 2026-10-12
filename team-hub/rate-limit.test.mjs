// team-hub/rate-limit.test.mjs
// ============================================================================
// 滑窗限速的纯决策。守的是**边界**与**用户看到的那句话**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { limitDecision, limitMessage, RATE_LIMIT_CODE, RATE_LIMIT_STATUS } from './rate-limit.mjs'

const MIN = 60_000
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
  assert.match(RATE_LIMIT_CODE, /^[A-Z_]+$/, '错误码应当是常量形状')
})
