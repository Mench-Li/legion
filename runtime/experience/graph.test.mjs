// runtime/experience/graph.test.mjs
// ============================================================================
// F-18 关系图的判据。
//
// 重心只有两条：**边只有被记下来的那些**，以及**撤销是记录不是删除**。
// 其余的用例都是这两条的边界（含一个必须挂死过的环）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EDGE_KINDS, GRAPH_CODES, GRAPH_VERSION, NODE_KINDS,
  createGraph,
} from './graph.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

const T = (id) => ({ kind: 'task', id })
const F = (id) => ({ kind: 'file', id })
const E = (id) => ({ kind: 'error', id })
const S = (id) => ({ kind: 'skill', id })

/** 一张四类节点齐全的图。 */
function seeded() {
  const g = createGraph()
  for (const n of [T('t1'), T('t2'), F('a.mjs'), E('E1'), S('s1')]) g.addNode(n)
  return g
}

// ---------------------------------------------------------------------------
// ① 只管记录：不推断、不隐式创建
// ---------------------------------------------------------------------------

test('① ★★★ 只做存储与遍历：从**没有**任何"顺手补边"的代码路径', () => {
  const src = readFileSync(join(HERE, 'graph.mjs'), 'utf8')
  // 图里绝不允许出现按属性自动连边的逻辑。判据是：模块里没有任何一处
  // 在没有显式 `addEdge` 调用的情况下往日志里推 `type: 'edge'`。
  const edgePushes = [...src.matchAll(/log\.push\(\s*Object\.freeze\(\{\s*seq:[^}]*type:\s*'edge'/g)]
  assert.equal(edgePushes.length, 1, `推 edge 记录的地方应该正好一处（addEdge），实际 ${edgePushes.length}`)
  // 那一处必须在 addEdge 的函数体里。
  const addEdgeAt = src.indexOf('addEdge({ from, to, kind, source')
  assert.notEqual(addEdgeAt, -1)
  assert.equal(src.indexOf("type: 'edge'") > addEdgeAt, true)
})

test('① ★★★ 两端节点必须先存在——**不隐式创建**（拼错的 id 会安静地变成新节点）', () => {
  const g = seeded()
  const err = throwsCode(
    () => g.addEdge({ from: T('t1'), to: F('typo.mjs'), kind: 'touched', source: 'w' }),
    GRAPH_CODES.NODE_MISSING,
  )
  assert.match(err.message, /不隐式创建/)
  assert.match(err.message, /打错/)
  // 而且它真的没被创建。
  assert.equal(g.node(F('typo.mjs')), null)
  assert.equal(g.stats().nodes, 5)
  // 起点同样。
  throwsCode(
    () => g.addEdge({ from: T('ghost'), to: F('a.mjs'), kind: 'touched', source: 'w' }),
    GRAPH_CODES.NODE_MISSING,
  )
  assert.equal(g.stats().nodes, 5)
})

test('① ★★ 每条边必须署名（不知道谁加的边只能整条删掉）', () => {
  const g = seeded()
  const err = throwsCode(
    () => g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: '  ' }),
    GRAPH_CODES.NO_ACTOR,
  )
  assert.match(err.message, /谁记的|谁加的/)
  // 边种类必须是封闭词表里的，不允许 `related` 这种兜底。
  assert.equal(EDGE_KINDS.includes('related'), false, 'EDGE_KINDS 里不该有兜底的 related')
  const err2 = throwsCode(
    () => g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'related', source: 'w' }),
    GRAPH_CODES.BAD_EDGE_KIND,
  )
  assert.match(err2.message, /兜底/)
})

test('① 节点种类封闭：不认识的种类不给默认归类', () => {
  const g = createGraph()
  const err = throwsCode(() => g.addNode({ kind: 'mystery', id: 'x' }), GRAPH_CODES.BAD_NODE_KIND)
  assert.match(err.message, /挤在一起/)
  assert.deepEqual([...NODE_KINDS], ['task', 'file', 'skill', 'error'])
  // 空 id 也不行。
  throwsCode(() => g.addNode({ kind: 'task', id: '   ' }), GRAPH_CODES.BAD_NODE)
})

test('① 重复记同一个节点是幂等的（不是两条记录）', () => {
  const g = createGraph()
  g.addNode({ kind: 'task', id: 't1', atMs: 1 })
  g.addNode({ kind: 'task', id: 't1', atMs: 999 })
  assert.equal(g.stats().nodes, 1)
  // 第一次的读数保留（重记不该改写"它是什么时候第一次出现的"）。
  assert.equal(g.node(T('t1')).atMs, 1)
  assert.equal(g.log().length, 1)
})

// ---------------------------------------------------------------------------
// ② 撤销是记录，不是删除
// ---------------------------------------------------------------------------

test('② ★★★ 收回边是**追加一条记录**，边本身仍在日志里', () => {
  const g = seeded()
  const e = g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w', reason: 'diff 里有它' })
  assert.equal(g.edges().length, 1)
  assert.equal(g.isActive(e.edgeId), true)

  g.retract({ edgeId: e.edgeId, by: 'general', reason: '这个文件只是被读了一下' })
  // 推导出来的读数变了……
  assert.equal(g.edges().length, 0)
  assert.equal(g.isActive(e.edgeId), false)
  // ……但记录流里两条都在，于是"这条边存在过、被谁按什么理由收回了"能回答。
  const h = g.historyOf(e.edgeId)
  assert.deepEqual(h.map((r) => r.type), ['edge', 'retract'])
  assert.equal(h[1].by, 'general')
  assert.equal(h[1].reason, '这个文件只是被读了一下')
  assert.equal(g.retractions().length, 1)
  // ★ 日志长度没有减少——没有任何 DELETE。
  assert.equal(g.log().length >= 6, true)
})

test('② ★★★ 本模块里**没有**删除语义：记录流只追加', () => {
  const src = readFileSync(join(HERE, 'graph.mjs'), 'utf8')
  // 真实代码里不许有从日志里剔除记录的操作。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  for (const banned of [/log\.splice/, /nodes\.delete/, /\.pop\(\)/, /\.shift\(\)/]) {
    assert.equal(banned.test(code), false, `出现了 ${banned}——记录流必须只追加`)
  }
  assert.match(code, /log\.push\(/)
})

test('② ★★ 未署名的收回被拒（没有署名的收回 = 安静地消失）', () => {
  const g = seeded()
  const e = g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  const err = throwsCode(() => g.retract({ edgeId: e.edgeId, by: '' }), GRAPH_CODES.NO_ACTOR)
  assert.match(err.message, /署名/)
  // 收一条不存在过的边也不行。
  throwsCode(() => g.retract({ edgeId: 'e999', by: 'g' }), GRAPH_CODES.EDGE_MISSING)
  // 重复收回不行（"被收回了几次"会变成没有意义的数）。
  g.retract({ edgeId: e.edgeId, by: 'g' })
  const err2 = throwsCode(() => g.retract({ edgeId: e.edgeId, by: 'g' }), GRAPH_CODES.ALREADY_RETRACTED)
  assert.match(err2.message, /没有意义的数/)
})

test('② 收回只影响那一条边，别的边照旧', () => {
  const g = seeded()
  const a = g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  g.addEdge({ from: T('t1'), to: E('E1'), kind: 'failedWith', source: 'w' })
  g.retract({ edgeId: a.edgeId, by: 'g' })
  assert.deepEqual(g.edges().map((e) => e.kind), ['failedWith'])
  assert.equal(g.stats().retracted, 1)
  assert.equal(g.stats().edges, 1)
})

// ---------------------------------------------------------------------------
// ③ 遍历抗环
// ---------------------------------------------------------------------------

test('③ ★★★ 带环的图上遍历**不挂死**，且每个节点只出现一次', () => {
  // 这张图是真实形状：任务失败 → 错误 → 同一错误在别的任务上又出现 → 又失败。
  const g = seeded()
  g.addEdge({ from: T('t1'), to: E('E1'), kind: 'failedWith', source: 'w' })
  g.addEdge({ from: E('E1'), to: T('t1'), kind: 'retriedBy', source: 'w' })   // ★ 成环
  g.addEdge({ from: T('t2'), to: E('E1'), kind: 'failedWith', source: 'w' })
  g.addEdge({ from: E('E1'), to: T('t2'), kind: 'retriedBy', source: 'w' })   // ★ 又一个环
  const r = g.reachable({ kind: 'task', id: 't1', depth: 10 })
  const keys = r.map((n) => `${n.kind}:${n.id}`)
  assert.deepEqual(keys, ['error:E1', 'task:t2'], '每个节点只该出现一次')
  assert.equal(new Set(keys).size, keys.length, '结果里有重复节点——visited 没生效')
})

test('③ 深度受限，且按边种类过滤真的有效', () => {
  const g = seeded()
  g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  g.addEdge({ from: T('t1'), to: E('E1'), kind: 'failedWith', source: 'w' })
  g.addEdge({ from: E('E1'), to: S('s1'), kind: 'fixedBy', source: 'w' })
  assert.equal(g.reachable({ kind: 'task', id: 't1', depth: 1 }).length, 2)
  assert.equal(g.reachable({ kind: 'task', id: 't1', depth: 2 }).length, 3)
  // 只要 touched 时，深度再大也只到一个。
  const only = g.reachable({ kind: 'task', id: 't1', depth: 5, edgeKinds: ['touched'] })
  assert.deepEqual(only.map((n) => `${n.kind}:${n.id}`), ['file:a.mjs'])
  // 起点不存在要抛（不是返回空清单——那会把"拼错了"读成"没有相关经验"）。
  throwsCode(() => g.reachable({ kind: 'task', id: 'ghost' }), GRAPH_CODES.NODE_MISSING)
})

// ---------------------------------------------------------------------------
// ④ 读数
// ---------------------------------------------------------------------------

test('④ ★★★ `records` 是**独立读数**，不硬凑成 edges + retracted 的等式', () => {
  const g = seeded()
  g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  const s = g.stats()
  assert.equal(s.nodes, 5)
  assert.equal(s.edges, 1)
  assert.equal(s.retracted, 0)
  // 5 个节点 + 1 条边 = 6 条记录。
  assert.equal(s.records, 6)
  // ★ 判据必须是"它等于日志的真实长度"，而**不是**"它等于那几个分项之和"。
  //   第一次写这条时断言的是 `nodes + edges + retracted`——而那恰好就是
  //   一个硬凑公式会算出来的东西，于是把 `records` 改成
  //   `nodes.size + active.length` 之后**用例一条都不红**：
  //   在那个场景里两个式子的值都是 6。
  //   一个"复核了公式"的断言，与一个"复核了真相"的断言，在数值恰好相等时
  //   长得一模一样——只有让两者**分岔**才分得开（见下）。
  assert.equal(s.records, g.log().length, 'records 必须就是记录流的长度')
  // 让两个式子分岔：发生一次收回之后，
  //   log.length = 节点 + 边 + 收回记录，
  //   而 `nodes.size + active.length` 会少算掉那条被收回的边。
  const e = g.edges()[0]
  g.retract({ edgeId: e.edgeId, by: 'general' })
  const after = g.stats()
  assert.equal(after.retracted, 1)
  assert.equal(after.records, 7, '收回了也是 7 条记录——收回是追加，不是删除')
  assert.equal(after.records, g.log().length)
  assert.notEqual(after.records, after.nodes + after.edges, '在这个场景下硬凑公式会少算一条')
  // 逐类计数都在，缺的给 0（这里是"确实一个都没有"，因为图是完整的）。
  assert.deepEqual(Object.keys(s.byKind), [...EDGE_KINDS])
  assert.deepEqual(Object.keys(s.byNodeKind), [...NODE_KINDS])
  assert.equal(s.byKind.touched, 1)
  assert.equal(s.byKind.fixedBy, 0)
})

test('④ 查询过滤（kind / from / to）都作用在**推导后**的边上', () => {
  const g = seeded()
  const a = g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  g.addEdge({ from: T('t1'), to: E('E1'), kind: 'failedWith', source: 'w' })
  g.addEdge({ from: T('t2'), to: E('E1'), kind: 'failedWith', source: 'w' })
  assert.equal(g.edges({ kind: 'failedWith' }).length, 2)
  assert.equal(g.edges({ from: T('t1') }).length, 2)
  assert.equal(g.edges({ to: E('E1') }).length, 2)
  assert.equal(g.edges({ from: T('t2'), kind: 'touched' }).length, 0)
  // 收回之后过滤结果也随之变——因为过滤作用在推导结果上。
  g.retract({ edgeId: a.edgeId, by: 'g' })
  assert.equal(g.edges({ from: T('t1') }).length, 1)
})

test('④ 图是冻结的：读出来的东西改不动，也没有 remove/update 出口', () => {
  const g = seeded()
  g.addEdge({ from: T('t1'), to: F('a.mjs'), kind: 'touched', source: 'w' })
  assert.equal(Object.isFrozen(g.edges()), true)
  assert.equal(Object.isFrozen(g.nodes()), true)
  for (const banned of ['remove', 'delete', 'update', 'clear']) {
    assert.equal(typeof g[banned], 'undefined', `图不该有 ${banned} 出口`)
  }
  assert.equal(g.version, GRAPH_VERSION)
})

test('④ 每个码都至少被一个用例触达（没有定义了却到不了的分支）', () => {
  const src = readFileSync(join(HERE, 'graph.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'graph.test.mjs'), 'utf8')
  const unreachable = declared.filter((n) => !testSrc.includes(`GRAPH_CODES.${n}`))
  assert.deepEqual(unreachable, [], `这些码没有用例触达：${unreachable.join(', ')}`)
})
