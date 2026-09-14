// PRT-315 切片 2：租约回收（`plugins/src/reclamation.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// 这里的两个函数此前是 `index.ts` 的 `spaceWorker()` 闭包里两段**无名语句块**——
// 连个名字都没有，就在 `sweep()` 开头按 `// 0.` / `// 0.5` 的顺序躺着。
// 它们从闭包隐式捕获 `config` / `log` / `useHub` / `isPipeline` / `hubPost` /
// `runTaskctl` / `activity` / `mediating` / `scope` / `byId`，以及那个
// `let bootReconciled`；要想单测其中任何一句，唯一的办法是**把整个守护跑起来**。
//
// 于是它们此前一条用例都没有，而它们做的是**任务池的写操作**：把别的 worker
// 正在办的任务放回 `todo`。放错一次就是把在跑的任务变成无主——
//   > 一个"只有把整个进程跑起来才能验证"的写路径，
//   > 与一个"根本没有这条写路径"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这两段全部可以用替身驱动：不连 hub、不 fork taskctl、不看时钟。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的编译产物与原 index.js 里内联的那两段逐字相同」由构建期脚本
// `_prt-handoff/prt315b-compare.mjs` 验证（按注释锚点抽出旧语句块、与新模块的
// 函数体归一化对拍，只放行两条已声明的注入改写与两行闸门改写）。本文件只管**行为**。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createReclamation } from '../lib/reclamation.js'

// ── 替身 ─────────────────────────────────────────────────────────────────────

/** 造一个在办任务（默认：本守护认领的 in_progress，不是孤儿回收要跳过的任何一种）。 */
function task(over = {}) {
  return {
    id: 'T-1', title: '任务一', status: 'in_progress', soldier: 'guard', role: 'coder',
    hold: false, claimedAt: '2026-01-01T00:00:00Z', version: 1,
    ...over,
  }
}

/**
 * 组装一个被测回收模块。
 *
 * ★ 替身必须挂在一个**调用时才读**的 `opts` 对象上，而且用例要改的是 `opts` 的字段，
 * 不是 `deps.hubPost`。
 *
 * 为什么：模块在构造时就把 `hubPost` / `useHub` 这些**值**取走了（`const { hubPost } = deps`）。
 * 所以 `h.deps.hubPost = 别的函数` 对被测模块**毫无影响**——用例会"看起来改了行为"，
 * 实际什么都没改，然后绿着通过。
 *
 *   > 一个"改的是 deps 上的字段"的夹具，
 *   > 与一个"改的是取值函数背后的那个值"的夹具，在被测模块构造时就快照了 dep 的情况下
 *   > 是同一个东西——只不过前者会让"改了行为"的用例根本没改行为。
 *
 * `opts.hubPost` / `opts.hubThrows` / `opts.tctlThrows` / `opts.hubResult` 都是**每次调用时**
 * 重新读的，`opts.useHub` / `opts.isPipeline` 更是模块自带的取值函数读的那个值——
 * 改它们等于复现 `detectHub()` / `applyPipeline()` 的真实改写。
 */
function harness(over = {}) {
  const log = []
  const activities = []
  const hubCalls = []
  const tctlCalls = []
  const boot = over.boot ?? { done: false }
  const deps = {
    config: { role: 'guard', scrumDir: 'C:/scrum', staleMinutes: 40, ...(over.config ?? {}) },
    log: (m) => log.push(m),
    scope: over.scope ?? 'app',
    useHub: () => over.useHub ?? false,
    isPipeline: () => over.isPipeline ?? false,
    hubPost: async (path, body) => {
      hubCalls.push({ path, body })
      if (typeof over.hubPost === 'function') return over.hubPost(path, body)
      if (over.hubThrows) throw new Error('hub 挂了')
      return over.hubResult ?? { released: [] }
    },
    runTaskctl: async (scrumDir, argv) => {
      tctlCalls.push({ scrumDir, argv })
      if (typeof over.runTaskctl === 'function') return over.runTaskctl(scrumDir, argv)
      if (over.tctlThrows) throw new Error('taskctl 挂了')
      return over.tctlResult ?? { released: [] }
    },
    activity: (kind, id, text) => { activities.push({ kind, id, text }) },
    mediating: over.mediating ?? new Set(),
    boot,
  }
  const r = createReclamation(deps)
  return { r, opts: over, boot, log, activities, hubCalls, tctlCalls, deps }
}

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('模块出口齐全：两段回收都在，且按 // 0. → // 0.5 的原始顺序可调', () => {
  const h = harness()
  assert.equal(typeof h.r.reclaimStaleLeases, 'function')
  assert.equal(typeof h.r.reclaimBootOrphans, 'function')
})

// ── 分派：hub 模式 / 本地模式 ────────────────────────────────────────────────

test('★ hub 模式：走 /api/release-stale，带上 by/scope/olderThan，且**不**去 fork taskctl', async () => {
  const h = harness({ useHub: true })
  await h.r.reclaimStaleLeases(new Map())
  // 参数逐字断言：这组字段是 hub 侧 release-stale 的全部输入，错一个就释放错池子。
  assert.deepEqual(h.hubCalls, [{ path: '/api/release-stale', body: { by: 'guard', scope: 'app', olderThan: 40 } }])
  assert.deepEqual(h.tctlCalls, [], 'hub 模式下不得再走本地 taskctl（多存储部署会误碰其他任务池）')
})

test('本地模式：走 taskctl release-stale，--older-than/--by/--scope 逐字带上，且**不**连 hub', async () => {
  const h = harness({ useHub: false, config: { staleMinutes: 100 } })
  await h.r.reclaimStaleLeases(new Map())
  assert.deepEqual(h.tctlCalls, [{
    scrumDir: 'C:/scrum',
    argv: ['release-stale', '--older-than', '100', '--by', 'guard', '--scope', 'app'],
  }])
  assert.deepEqual(h.hubCalls, [], '本地模式不该发 hub 请求')
})

test('★ 取值函数不是快照：探测到 hub 之后立刻改走 hub（快照实现会一直 fork taskctl）', async () => {
  // `useHub` 在原文件里是 `let`，`detectHub()` 探测成功后改写它。
  // 快照住它的模块会**永远走本地 taskctl**——症状是"hub 部署下守护还在直连本地库"，
  // 而日志里一行错都没有。
  //   > 一个"构造时快照了 useHub"的模块，
  //   > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
  //   > 只不过前者会在探测到 hub 之后，安静地继续 fork 子进程。
  const h = harness({ useHub: false })
  await h.r.reclaimStaleLeases(new Map())
  assert.equal(h.tctlCalls.length, 1)
  assert.equal(h.hubCalls.length, 0)

  h.opts.useHub = true // —— 与 detectHub() 的真实改写同形：换掉取值函数背后的那个值
  await h.r.reclaimStaleLeases(new Map())
  assert.equal(h.hubCalls.length, 1, '探测到 hub 之后必须立刻改走 hub')
  assert.equal(h.tctlCalls.length, 1, '不得再多一次本地调用')
})

// ── 释放后的快照同步 ─────────────────────────────────────────────────────────

test('★ 释放后同步本轮快照：status/soldier/claimedAt 三个字段都要清干净', async () => {
  // 快照（`byId`）是 **sweep 本轮**用的任务表。释放了却不同步，后面的步骤仍会按
  // 旧快照把该任务当成 in_progress 去派工——这就是 // 0.5 注释里那条
  // 「abortDriven 重派会派无主 worker」的生产事故形态。
  const h = harness({ useHub: true, hubResult: { released: ['T-1', 'T-2'] } })
  const t1 = task({ id: 'T-1', soldier: 'guard', claimedAt: '2026-01-01T00:00:00Z' })
  const t2 = task({ id: 'T-2', soldier: 'coder', claimedAt: '2026-01-02T00:00:00Z' })
  const t3 = task({ id: 'T-3' }) // 没被释放，必须原样不动
  await h.r.reclaimStaleLeases(new Map([['T-1', t1], ['T-2', t2], ['T-3', t3]]))

  for (const t of [t1, t2]) {
    assert.equal(t.status, 'todo')
    assert.equal(t.soldier, null)
    assert.equal(t.claimedAt, null)
  }
  assert.equal(t3.status, 'in_progress', '没被释放的任务不得被顺手改状态')
  assert.equal(t3.soldier, 'guard')
  assert.equal(t3.claimedAt, '2026-01-01T00:00:00Z')
  // activity 的顺序与文本逐字断言（看板事件流是对外可见的）
  assert.deepEqual(h.activities, [
    { kind: 'released', id: 'T-1', text: '距最近进展超过 40 分钟或过 TTL，自动释放回 todo' },
    { kind: 'released', id: 'T-2', text: '距最近进展超过 40 分钟或过 TTL，自动释放回 todo' },
  ])
})

test('释放列表里的 id 不在本轮快照里 → 照样记事件，不得抛（activity 在查表之前）', async () => {
  const h = harness({ useHub: true, hubResult: { released: ['T-404'] } })
  await h.r.reclaimStaleLeases(new Map()) // 空快照
  assert.deepEqual(h.activities, [{ kind: 'released', id: 'T-404', text: '距最近进展超过 40 分钟或过 TTL，自动释放回 todo' }])
})

test('hub 不返回 released 字段（或返回空）→ 什么都不改、不记事件', async () => {
  const h = harness({ useHub: true, hubResult: {} })
  const t = task()
  await h.r.reclaimStaleLeases(new Map([['T-1', t]]))
  assert.equal(t.status, 'in_progress')
  assert.deepEqual(h.activities, [])
})

// ── 失败路径 ─────────────────────────────────────────────────────────────────

test('★ 释放调用抛错 → 吞掉并记日志，调用方仍能接着跑 // 0.5（同一实例、同一轮）', async () => {
  // 任务池抖一下不该让整轮扫单停摆。这条用**同一个实例**按 sweep 的真实顺序调两次：
  // `// 0.` 抛错被吞 → `// 0.5` 照常跑完。
  let n = 0
  const h = harness({
    useHub: true,
    hubPost: async () => {
      n += 1
      if (n === 1) throw new Error('hub 挂了')
      return { released: ['T-1'] }
    },
  })
  await assert.doesNotReject(h.r.reclaimStaleLeases(new Map()))
  assert.deepEqual(h.log, ['release-stale 失败：Error: hub 挂了'])
  assert.deepEqual(h.activities, [])

  const t = task()
  await h.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.equal(t.status, 'todo', '前一步抛错之后，孤儿回收这一步必须照常生效')
  assert.deepEqual(h.activities, [
    { kind: 'released', id: 'T-1', text: '守护重启：孤儿 in_progress 释放回 todo，自动重新认领续做' },
  ])
})

test('本地模式抛错 → 同样只记日志，且两段各自用**自己的**日志串', async () => {
  const h = harness({ useHub: false, tctlThrows: true })
  await h.r.reclaimStaleLeases(new Map())
  assert.deepEqual(h.log, ['release-stale 失败：Error: taskctl 挂了'])

  const h2 = harness({ useHub: false, tctlThrows: true })
  const t = task()
  await h2.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.deepEqual(h2.log, ['守护重启孤儿回收失败：Error: taskctl 挂了'])
})

test('★ 孤儿回收自己的失败**不吞整个 sweep**：函数正常返回，标志已置位', async () => {
  const h = harness({ useHub: true, hubThrows: true })
  const t = task()
  await assert.doesNotReject(h.r.reclaimBootOrphans([t], new Map([['T-1', t]])))
  assert.deepEqual(h.log, ['守护重启孤儿回收失败：Error: hub 挂了'])
  assert.equal(h.boot.done, true)
  assert.equal(t.status, 'in_progress', '释放没成功，快照不得被改')
})

// ── bootReconciled 闸门 ──────────────────────────────────────────────────────

test('★★ 重启孤儿回收只在第一轮跑：第二次调用必须不再发释放请求', async () => {
  // 这是本切片最容易被悄悄破坏的不变量：**只调一次**的用例无论闸门在不在都是绿的。
  // 所以这里必须真的调两次，并数请求数。
  //   > 一个"只调用一次"的用例，与一个"真的验证了第二次被挡住"的用例，
  //   > 在闸门恰好存在时读数相同——只不过前者在闸门消失时也是绿的。
  const h = harness({ useHub: true, hubResult: { released: ['T-1'] } })
  const t = task()
  const byId = new Map([['T-1', t]])

  await h.r.reclaimBootOrphans([t], byId)
  assert.equal(h.hubCalls.length, 1, '第一轮必须回收')
  assert.deepEqual(h.hubCalls[0].body, { by: 'guard', scope: 'app', olderThan: 40, ids: ['T-1'] })
  assert.equal(t.status, 'todo')
  assert.equal(h.boot.done, true)

  // 第二轮：任务已经是 todo，但**即使**有新的孤儿，也不得再发请求
  const t2 = task({ id: 'T-2', soldier: 'guard' })
  await h.r.reclaimBootOrphans([t2], new Map([['T-2', t2]]))
  assert.equal(h.hubCalls.length, 1, '★ 重启孤儿回收只做第一轮，第二轮不得再发释放请求')
  assert.equal(t2.status, 'in_progress', '第二轮不该动任何任务')
})

test('★ 闸门在**动手之前**置位：即使释放调用抛错，本轮也算做过了（与闭包变量同位置）', async () => {
  let n = 0
  const h = harness({
    useHub: true,
    hubPost: async () => {
      n += 1
      if (n === 1) throw new Error('hub 挂了')
      return { released: ['T-2'] }
    },
  })
  const t = task()
  await h.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.equal(h.boot.done, true)
  assert.equal(h.hubCalls.length, 1)

  const t2 = task({ id: 'T-2' })
  await h.r.reclaimBootOrphans([t2], new Map([['T-2', t2]]))
  assert.equal(h.hubCalls.length, 1, '抛过错的那一轮已经把闸门关上了')
  assert.equal(t2.status, 'in_progress')
})

test('★ 两个实例各自持有闸门：一个进程里 mount 两个空间时都要做开机回收', async () => {
  // `superviseSpaces()` 会在**同一进程**里按空间 mount 多个 spaceWorker。
  // 如果闸门是模块级变量，第一个空间的守护会把标志置掉，其余空间的守护
  // **从此再也不会做开机孤儿回收**——它们的重启孤儿只能干等满 staleMinutes。
  //   > 一个"每实例一份"的状态对象，
  //   > 与一个"每进程一份"的模块级标志，在只有一个守护实例的部署里是同一个东西——
  //   > 只不过多空间部署下，后者会让第二个空间的开机回收静默地不发生。
  const s1 = harness({ useHub: true, hubResult: { released: ['T-1'] } })
  const s2 = harness({ useHub: true, hubResult: { released: ['T-9'] } })
  const a = task({ id: 'T-1' })
  const b = task({ id: 'T-9' })
  await s1.r.reclaimBootOrphans([a], new Map([['T-1', a]]))
  await s2.r.reclaimBootOrphans([b], new Map([['T-9', b]]))
  assert.equal(s1.boot.done, true)
  assert.equal(s2.boot.done, true)
  assert.equal(a.status, 'todo', '空间 1 的孤儿要回收')
  assert.equal(b.status, 'todo', '★ 空间 2 的孤儿同样要回收（模块级标志会漏掉这一条）')
})

// ── 孤儿筛选 ─────────────────────────────────────────────────────────────────

test('★ 孤儿筛选：只回收本守护认领、未拦截、未在调解中的 in_progress', async () => {
  const tasks = [
    task({ id: 'T-1', soldier: 'guard' }),                       // ✔ 本守护认领
    task({ id: 'T-2', soldier: 'someone-else' }),                // ✘ 人类手动在办
    task({ id: 'T-3', soldier: 'guard', status: 'todo' }),       // ✘ 不是 in_progress
    task({ id: 'T-4', soldier: 'guard', hold: true }),           // ✘ 将军拦截
    task({ id: 'T-5', soldier: 'guard' }),                       // ✘ 正在调解
  ]
  const h = harness({ useHub: true, mediating: new Set(['T-5']) })
  await h.r.reclaimBootOrphans(tasks, new Map(tasks.map(t => [t.id, t])))
  assert.deepEqual(h.hubCalls[0].body.ids, ['T-1'])
  assert.equal(tasks.find(t => t.id === 'T-2').status, 'in_progress')
  assert.equal(tasks.find(t => t.id === 'T-4').status, 'in_progress')
  assert.equal(tasks.find(t => t.id === 'T-5').status, 'in_progress')
})

test('孤儿为空 → 一发请求都不发（不拿空 ids 去打 hub）', async () => {
  const h = harness({ useHub: true })
  const t = task({ soldier: 'human-general' })
  await h.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.deepEqual(h.hubCalls, [])
  assert.deepEqual(h.log, [])
  assert.equal(h.boot.done, true, '没有孤儿也算做过第一轮，不该每轮都重扫')
})

test('★ 流水线模式多认一个角色：soldier === 任务角色 也算本守护认领', async () => {
  const tasks = [task({ id: 'T-1', soldier: 'coder', role: 'coder' }), task({ id: 'T-2', soldier: 'tester', role: 'tester' })]
  const h = harness({ useHub: true, isPipeline: true })
  await h.r.reclaimBootOrphans(tasks, new Map(tasks.map(t => [t.id, t])))
  assert.deepEqual(h.hubCalls[0].body.ids, ['T-1', 'T-2'])
  // 单角色模式下同样的任务不算本守护的 → 一条都不该带走
  const h2 = harness({ useHub: true, isPipeline: false })
  const tasks2 = [task({ id: 'T-1', soldier: 'coder', role: 'coder' })]
  await h2.r.reclaimBootOrphans(tasks2, new Map(tasks2.map(t => [t.id, t])))
  assert.deepEqual(h2.hubCalls, [], '单角色模式只认 soldier === config.role')
})

test('★ isPipeline 也走取值函数：换流水线之后筛选口径必须立刻变（快照会漏掉阶段角色）', async () => {
  // `isPipeline` 是 `let`，`applyPipeline()` 换来源时会被**重新赋值**。
  // 快照住它的模块在"从单角色切到多角色流水线"之后，会一直按 `soldier === config.role`
  // 判定——阶段角色认领的重启孤儿**全被漏掉**，只能干等 staleMinutes。
  const h = harness({ useHub: true, hubResult: { released: ['T-1'] } })
  let pipeline = false
  const r2 = createReclamation({ ...h.deps, isPipeline: () => pipeline })
  const t = task({ id: 'T-1', soldier: 'coder', role: 'coder' })
  await r2.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.deepEqual(h.hubCalls, [], '此时不是流水线：soldier=coder 不算本守护认领')

  pipeline = true // —— 与 applyPipeline() 的真实改写同形
  // ★ 闸门与筛选是**两件正交的事**：第二次观测必须先手动放开闸门，
  //   否则被挡住的是闸门而不是筛选口径——那样这条用例就变成"在测闸门"了。
  //   （闸门本身由上面那条"第二次调用不再发请求"的用例单独钉住。）
  h.boot.done = false
  const t2 = task({ id: 'T-2', soldier: 'coder', role: 'coder' })
  await r2.reclaimBootOrphans([t2], new Map([['T-2', t2]]))
  assert.equal(h.hubCalls.length, 1, '换成流水线之后必须立刻按阶段角色认领来筛')
  assert.deepEqual(h.hubCalls[0].body.ids, ['T-2'])
})

// ── 本地模式的孤儿回收 ───────────────────────────────────────────────────────

test('本地模式孤儿回收：--older-than 是 "0"（不等 stale），且**不带** ids 参数', async () => {
  // 这条钉住的是原实现的**既有形态**：hub 路径把 ids 传下去只释放这批孤儿；
  // 本地路径只带 `--older-than 0`。重构不许"顺手修好"它——那是另一个改动，
  // 而且改了之后"本地模式到底释放了什么"就与 hub 模式不是同一件事了。
  const h = harness({ useHub: false, tctlResult: { released: ['T-1'] } })
  const t = task()
  await h.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.deepEqual(h.tctlCalls, [{
    scrumDir: 'C:/scrum',
    argv: ['release-stale', '--older-than', '0', '--by', 'guard', '--scope', 'app'],
  }])
  assert.equal(t.status, 'todo')
})

test('孤儿回收记两条日志/事件：activity（看板）+ log（含 id，能定位到具体任务）', async () => {
  const h = harness({ useHub: true, hubResult: { released: ['T-1'] } })
  const t = task()
  await h.r.reclaimBootOrphans([t], new Map([['T-1', t]]))
  assert.deepEqual(h.activities, [
    { kind: 'released', id: 'T-1', text: '守护重启：孤儿 in_progress 释放回 todo，自动重新认领续做' },
  ])
  assert.deepEqual(h.log, ['T-1 守护重启孤儿回收 → todo（下轮重新认领续做）'])
})
