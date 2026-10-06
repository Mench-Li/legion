// workbench/mobile/refresh-loop.test.mjs
// 合并刷新。守的是两件会**静默**出错的事：
//   · 合并掉了**最后一次** → 界面停在一个旧状态，看起来像"事件丢了"；
//   · 两次刷新**并发** → 先发后到的那个把界面写回旧数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRefresher } from './refresh-loop.mjs'

/** 手动的时钟：让"去抖到期"这件事在用例里确定性地发生，不 sleep 真实时间。 */
function fakeClock() {
  let seq = 0
  const timers = new Map()
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id },
    clearTimer: (id) => { timers.delete(id) },
    /** 触发所有到期的计时器。 */
    tick() {
      const due = [...timers.entries()]
      timers.clear()
      for (const [, t] of due) t.fn()
      return due.length
    },
    pending: () => timers.size,
  }
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

test('静默期内多次请求只跑一次', async () => {
  const clock = fakeClock()
  let runs = 0
  const r = createRefresher({ run: async () => { runs += 1 }, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  for (let i = 0; i < 10; i += 1) r.request()
  assert.equal(runs, 0, '还在去抖窗口里，不该跑')
  clock.tick()
  await flush()
  assert.equal(runs, 1, '十次请求合并成一次')
  assert.equal(r.stats().coalesced, 9)
})

test('★ 在飞期间来的请求会**补跑一次**（不许吞掉最后一次）', async () => {
  const clock = fakeClock()
  let resolveFirst = null
  let runs = 0
  const r = createRefresher({
    run: () => {
      runs += 1
      if (runs === 1) return new Promise((res) => { resolveFirst = res })
      return Promise.resolve()
    },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  r.request()
  clock.tick()               // 第一次开始跑（还没结束）
  await flush()
  assert.equal(runs, 1)

  r.request()                // 在飞期间又来了
  clock.tick()
  await flush()
  assert.equal(runs, 1, '不并发：第二次不该立刻跑')

  resolveFirst()             // 第一次跑完
  await flush()
  assert.equal(runs, 2, '★ 跑完必须补上那一次——吞掉它，界面就停在一个旧状态上')
  assert.equal(r.stats().trailing, 1)
})

test('持续来事件时**不会**永远不刷新（去抖计时器不被重置）', async () => {
  // 重置计时器的写法会把"一直有事件"变成"永远不刷新"——而那时界面**看起来**
  // 是"实时"的（因为一直在收到通知），只是内容再也不变。
  const clock = fakeClock()
  let runs = 0
  const r = createRefresher({ run: async () => { runs += 1 }, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  r.request()
  r.request(); r.request(); r.request()   // 窗口内继续来
  assert.equal(clock.pending(), 1, '计时器只该有一个，且没有被重置成新的')
  clock.tick()
  await flush()
  assert.equal(runs, 1)
})

test('run 抛错不把循环卡死（下一次照常能跑）', async () => {
  const clock = fakeClock()
  let runs = 0
  const r = createRefresher({
    run: async () => { runs += 1; if (runs === 1) throw new Error('boom') },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  r.request(); clock.tick(); await flush()
  assert.equal(runs, 1)
  assert.equal(r.stats().failures, 1)
  assert.equal(r.stats().running, false, '失败了也要把"在跑"清掉，否则此后一次都不会跑')
  r.request(); clock.tick(); await flush()
  assert.equal(runs, 2, '失败之后下一次照常跑')
})

test('now() 立刻跑（用户显式点刷新时走这条，不走去抖）', async () => {
  const clock = fakeClock()
  let runs = 0
  const r = createRefresher({ run: async () => { runs += 1 }, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  r.now()
  await flush()
  assert.equal(runs, 1)
  assert.equal(clock.pending(), 0, 'now 不该排一个去抖计时器')
})

test('缺 run 是编程错误，构造期就抛', () => {
  assert.throws(() => createRefresher({}), /需要 run/)
})
