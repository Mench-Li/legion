// ============================================================================
// P4（docs/DECISION-legion-owns-model-config.md）：**周期收敛**的调度
//
// 这一组盯四件事：
//
//   ① **不重叠**：上一轮还没跑完，绝不叠下一轮。
//      这是 P2/P3 判据的前提（"读—算—写—回读"必须是一段不可分的动作），
//      而叠轮失败的样子是"偶尔写两遍"或"回读看到改到一半的状态"——都很难从日志看出来。
//   ② **streak 的语义**：它数的是"轮次开始时没有差异"的连续轮数。
//      写完之后干不干净**不算** —— 那样每次成功的写入都会让 streak +1，
//      于是"连续 N 轮无差异"这个放行条件会被自己的写入满足（永远为真）。
//   ③ **一轮出错不许把调度器打死**（下一拍照常跑），但 streak 必须归零
//      —— "这一轮读都没读成"不能被算进"连续无差异"。
//   ④ **stop() 真的停**：不再排下一拍，且已经在跑的那一轮之后不再续。
//
// 定时器全部注入（假件）⇒ 用例不必真的等，也不会因为真实时间而抖动。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { createReconcileSchedule } from './reconcile-schedule.mjs'

/** 一个手摇的假定时器：记录排了哪几拍，并允许手动触发。 */
function fakeTimers() {
  const queued = []
  let nextId = 1
  return {
    queued,
    setTimeoutImpl: (fn, ms) => { const id = nextId++; queued.push({ id, fn, ms }); return { id, unref() {} } },
    clearTimeoutImpl: (t) => { const i = queued.findIndex((q) => q.id === t.id); if (i >= 0) queued.splice(i, 1) },
    /**
     * 触发最早的那一拍，并**等到它把下一拍排上**才算这一拍结束。
     *
     * ★ 为什么要等：被触发的回调是 `() => { void runNow().finally(schedule) }` ——
     *   它**立即返回**，真正的一轮在后面跑完才排下一拍。
     *   早先的版本只 `await setImmediate` 一次，于是"等一轮 5ms 才结束"的用例
     *   在第二轮开始前就继续断言了（实测红：order 只有 ['begin']）。
     */
    async fire() {
      const q = queued.shift()
      if (!q) return false
      q.fn()
      const deadline = Date.now() + 2000
      while (queued.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2))
      }
      return true
    },
  }
}

test('① 不重叠：上一轮慢，下一拍在它跑完之后才排（不是并发叠上去）', async () => {
  const timers = fakeTimers()
  let inFlight = 0
  let maxInFlight = 0
  const order = []
  const s = createReconcileSchedule({
    run: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push('begin')
      await new Promise((r) => setTimeout(r, 5))
      order.push('end')
      inFlight -= 1
      return { clean: true }
    },
    intervalMs: 1000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: () => {},
  })
  s.start()
  assert.equal(timers.queued.length, 1, 'start 之后应当只排了一拍')
  // 连点三拍：每一拍都必须等上一轮结束（递归 setTimeout 的构造保证）
  await timers.fire()
  await timers.fire()
  await timers.fire()
  assert.equal(maxInFlight, 1, `任何时刻在飞的轮数都不许超过 1（实测峰值 ${maxInFlight}）`)
  assert.deepEqual(order, ['begin', 'end', 'begin', 'end', 'begin', 'end'])
  assert.equal(s.stats().rounds, 3)
})

test('② 手动并发调用被挡住，且"被挡住"是一条看得见的读数', async () => {
  const logs = []
  let release = null
  const s = createReconcileSchedule({
    run: async () => { await new Promise((r) => { release = r }); return { clean: true } },
    intervalMs: 0,
    log: (m) => logs.push(m),
  })
  const first = s.runNow()
  // ★ 这里**不能**直接 `await s.runNow()`：万一挡板失效，第二次调用会真的开始跑，
  //   而它等的是 `release`，`release` 又要等这次 await 之后才被调用 ⇒ **死锁**。
  //   （实测：M8 变异把挡板去掉后，这套用例挂住不返回，整个变异实验卡死。）
  //   用"限时竞速"把它变成一次**快速失败**：拿不到 busy 就是红，而不是挂住。
  const second = await Promise.race([
    s.runNow(),
    new Promise((r) => setTimeout(() => r({ skipped: 'TIMEOUT' }), 300)),
  ])
  assert.deepEqual(second.skipped, 'busy', '上一轮还在跑时，第二次调用必须是 busy（不能真的并发跑）')
  release()
  await first
  assert.match(logs.join('\n'), /上一轮还在跑/)
})

test('③ ★ streak 只数"轮次开始时无差异"，写完之后干净不算', async () => {
  const results = [
    { clean: true },   // 1
    { clean: true },   // 2
    { clean: false },  // 归零
    { clean: true },   // 1
  ]
  let i = 0
  const s = createReconcileSchedule({ run: async () => results[i++], intervalMs: 0, log: () => {} })
  assert.equal((await s.runNow()).streak, 1)
  assert.equal((await s.runNow()).streak, 2)
  assert.equal((await s.runNow()).streak, 0, '有差异 ⇒ 归零')
  assert.equal((await s.runNow()).streak, 1)
  assert.equal(s.stats().rounds, 4)
})

test('④ ★ 一轮出错不打紧：下一拍照常跑，但 streak 归零', async () => {
  const logs = []
  let mode = 'throw'
  const s = createReconcileSchedule({
    run: async () => {
      if (mode === 'throw') throw new Error('中枢暂时不可达')
      return { clean: true }
    },
    intervalMs: 1000,
    setTimeoutImpl: fakeTimers().setTimeoutImpl,
    log: (m) => logs.push(m),
  })
  // ★ 必须先有一轮**成功**的，否则 streak 本来就是 0 —— 于是"出错不归零"这个变异
  //   在断言上跟正确实现一模一样（实测：M4 第一次跑没被咬住）。
  //   要验的是"归零"这个**动作**，所以起点必须 > 0。
  mode = 'ok'
  assert.equal((await s.runNow()).streak, 1, '先攒出一轮无差异')
  mode = 'throw'
  const bad = await s.runNow()
  assert.equal(bad.clean, false)
  assert.match(bad.error, /中枢暂时不可达/)
  assert.equal(bad.streak, 0, '"读都没读成"必须把已经攒下的连续轮数**抹掉**，不许被算进连续无差异')
  // 接着成功：streak 从 1 开始重数
  mode = 'ok'
  assert.equal((await s.runNow()).streak, 1, '出错之后 streak 从零重数')
  assert.match(logs.join('\n'), /下一拍照常跑/)
  assert.match(logs.join('\n'), /streak 归零/)
})

test('⑤ stop() 真的停：不再排下一拍，且在飞的那一轮之后不再续', async () => {
  const timers = fakeTimers()
  const s = createReconcileSchedule({
    run: async () => ({ clean: true }),
    intervalMs: 1000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: () => {},
  })
  s.start()
  assert.equal(timers.queued.length, 1)
  s.stop()
  assert.equal(timers.queued.length, 0, 'stop 之后队列必须空')
  assert.deepEqual(await s.runNow(), { skipped: 'stopped' }, 'stop 之后连显式调用也不该再跑')
  assert.equal(s.stats().stopped, true)
})

test('⑥ 间隔 <= 0 ⇒ 不排任何周期（只在启动时收敛一次），但显式 runNow 仍可用', async () => {
  const timers = fakeTimers()
  const logs = []
  const s = createReconcileSchedule({
    run: async () => ({ clean: true }),
    intervalMs: 0,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: (m) => logs.push(m),
  })
  s.start()
  assert.equal(timers.queued.length, 0, '间隔为 0 时不许排周期')
  assert.match(logs.join('\n'), /未启用周期/)
  assert.equal((await s.runNow()).clean, true, '启动时那一轮仍然要能跑')
})

test('⑦ 周期读数里带"每 N 秒一轮"，且跑完会自己续下一拍', async () => {
  const timers = fakeTimers()
  const logs = []
  const s = createReconcileSchedule({
    run: async () => ({ clean: true }),
    intervalMs: 300000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: (m) => logs.push(m),
  })
  s.start()
  assert.match(logs.join('\n'), /每 300 秒一轮/)
  assert.equal(timers.queued[0].ms, 300000)
  await timers.fire()
  assert.equal(timers.queued.length, 1, '跑完一轮要自己续下一拍')
  assert.match(logs.join('\n'), /第 1 轮结束/)
  assert.match(logs.join('\n'), /连续无差异 1 轮/)
})

test('⑧ 缺 run 直接抛（这个调度器没有 run 就没有意义，不该静默什么都不做）', () => {
  assert.throws(() => createReconcileSchedule({ intervalMs: 100 }), /需要 run/)
})

test('⑨ ★ 幂等：同一份状态连跑两轮 ⇒ 第二轮的 run 报告"无需写入"', async () => {
  // 这条是 P4 的精髓：稳态下每一轮都应当是"0 次写"。
  // 这里用假 run 表达"第二轮的 run 内部判定无需写入"，调度器只负责把它记成 streak。
  const writes = []
  let state = 'empty'
  const s = createReconcileSchedule({
    run: async () => {
      if (state === 'empty') { writes.push('write'); state = 'converged'; return { clean: false } }
      return { clean: true } // 稳态：什么都不用写
    },
    intervalMs: 0,
    log: () => {},
  })
  const r1 = await s.runNow()
  const r2 = await s.runNow()
  const r3 = await s.runNow()
  assert.equal(writes.length, 1, '只有第一轮写了；之后两轮都是 0 次写')
  assert.equal(r1.streak, 0)
  assert.equal(r2.streak, 1, '第二轮开始就进入"连续无差异"')
  assert.equal(r3.streak, 2)
})
