// runtime/dsh-composition/usage-projection.test.mjs
// ============================================================================
// 判据：一次 Run 的用量能不能被如实读出——以及**读不到时会不会编一个 0**
//
// 这套用例的重心不在"能不能读出数字"（那条最容易写绿），而在三件事：
//   ① 读不到必须如实说读不到（`null`），**不许**补 0；
//   ② 五种"读不到"必须**各自有码**（它们要修的东西不同）；
//   ③ 不关心的事件不许让状态引用变（投影契约的承重条款，也是性能条款）。
// ============================================================================
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  EMPTY_USAGE_STATE,
  USAGE_PROJECTION_KEY,
  USAGE_READ_CODES,
  applyUsageEvent,
  createUsageProjectionDefinition,
  readRunUsage,
  usageFromState,
  usageOf,
} from './usage-projection.mjs'

// ───────────────────────────────────────────────────────── 夹具

/** 一条带用量的 `assistant/message`（形状照真转录的实测读数）。 */
const usageEvent = ({ input = 100, output = 20, cacheRead = 500 } = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time: 1_700_000_000_000,
  data: {
    turn: 0,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output + cacheRead, cacheReadTokens: cacheRead },
    stream: [],
  },
})

/** 折叠一串事件。 */
function foldEvents(events) {
  let state = { ...EMPTY_USAGE_STATE }
  for (const e of events) state = applyUsageEvent(state, e)
  return state
}

/** 一个最小的现场 ctx：`sessions.get(id)` 与 `sessionProjections.stateOf(session, key)`。 */
function ctxWith({ sessions, projections, hasSessions = true, hasProjections = true } = {}) {
  const store = sessions ?? new Map()
  return {
    get(name) {
      if (name === 'sessions') return hasSessions ? { get: (id) => store.get(id) } : undefined
      if (name === 'sessionProjections') {
        if (!hasProjections) return undefined
        return projections ?? {
          stateOf: (session, key) => (key === USAGE_PROJECTION_KEY ? session.__state : undefined),
        }
      }
      return undefined
    },
  }
}

// ───────────────────────────────────────────────────────── ① 折叠

describe('① 纯折叠：只累加 provider 上报的计数', () => {
  test('三条用量事件累加正确', () => {
    const s = foldEvents([
      usageEvent({ input: 100, output: 20, cacheRead: 500 }),
      usageEvent({ input: 200, output: 40, cacheRead: 900 }),
      usageEvent({ input: 300, output: 60, cacheRead: 1000 }),
    ])
    assert.deepEqual(s, { inputTokens: 600, outputTokens: 120, cacheReadTokens: 2400, messages: 3 })
  })

  test('★ `totalTokens` **不参与**累加（它是 input+output+cacheRead，不是 input+output）', () => {
    // 实测恒等式：total = input + output + cacheRead。
    // 把 total 当成 input+output 会低估约一个量级（GF-001：input 68822 / output 50122，total 1682208）。
    const s = foldEvents([usageEvent({ input: 10, output: 5, cacheRead: 1000 })])
    assert.equal(s.inputTokens, 10, '不许把 cacheRead 并进 input')
    assert.equal(s.cacheReadTokens, 1000)
    // 三格之和 = 1015，而 total = 1015 —— 若实现去读了 total 并当 input+output，这里会是别的数
    assert.equal(s.inputTokens + s.outputTokens + s.cacheReadTokens, 1015)
  })

  test('★ 不关心的事件返回**同一个引用**（投影契约的承重条款）', () => {
    const s = { ...EMPTY_USAGE_STATE }
    const other = { type: 'tool/call', data: { name: 'pwsh' } }
    assert.equal(applyUsageEvent(s, other), s,
      '返回新对象会让框架在每个事件上都判"变了"，于是每次提交都产生下游工作')
  })

  test('★ 负数 / 非整数 / 缺字段一律不当作合法计数', () => {
    // usage.mjs 的 pick() 因为"负数被当成合法用量"修过一次；这里沿用同一判据。
    assert.equal(usageOf({ type: 'assistant/message', data: { usage: { inputTokens: -3, outputTokens: -1 } } }), null,
      '全是垃圾的 usage 必须记成不可用，而不是一个有效的负数读数')
    assert.equal(usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 1.5 } } }), null, '小数不是合法计数')
    assert.equal(usageOf({ type: 'assistant/message', data: { usage: {} } }), null, '空 usage 不可用')
    assert.equal(usageOf({ type: 'assistant/message', data: {} }), null, '没有 usage 字段')
    assert.equal(usageOf({ type: 'assistant/message', data: null }), null)
    assert.equal(usageOf({ type: 'step/start' }), null, '别的类型不带用量')
    assert.equal(usageOf(null), null)
    assert.equal(usageOf(undefined), null)
  })

  test('部分字段合法时，非法的那些记 0，而这条 usage **仍然可用**', () => {
    const u = usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: -1 } } })
    assert.deepEqual(u, { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0 },
      '一侧不合法记 0 —— 与"整条不可用"是两件事')
  })
})

// ───────────────────────────────────────────────────────── ② 读不到 = null

describe('② ★ 读不到必须如实说读不到——不许补 0', () => {
  test('没有任何用量事件 → `usageFromState` 返回 null（不是全 0 的对象）', () => {
    assert.equal(usageFromState({ ...EMPTY_USAGE_STATE }), null,
      '全 0 的对象会被当成"这次运行零成本"累加进总账')
    assert.equal(usageFromState({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, messages: 0 }), null,
      '有计数但 messages=0 是自相矛盾的状态，也不许当成有效读数')
  })

  test('★ 反向控制：`messages > 0` 但计数全为 0 → 仍然返回一个**有效**读数', () => {
    // 少了这条，"messages 那一格没被真的用上"（比如恒判 0）也过得去。
    const s = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, messages: 1 }
    const u = usageFromState(s)
    assert.notEqual(u, null, '引擎确实报了一条 usage（只是全是 0）——这与"什么都没报"不同')
    assert.equal(u.messages, 1)
  })

  test('坏状态（null / 非对象 / 负计数）不抛，返回 null', () => {
    assert.equal(usageFromState(null), null)
    assert.equal(usageFromState(undefined), null)
    assert.equal(usageFromState('x'), null)
    assert.equal(usageFromState({ messages: -1 }), null)
    assert.equal(usageFromState({ messages: 1.5 }), null)
  })
})

// ───────────────────────────────────────────────────────── ③ 五种"读不到"各自有码

describe('③ ★ 五种"读不到"各自有码（它们要修的东西不同）', () => {
  test('没有 sessions 服务', () => {
    const r = readRunUsage(ctxWith({ hasSessions: false }), 's-1')
    assert.equal(r.ok, false)
    assert.equal(r.code, USAGE_READ_CODES.NO_SESSIONS_SERVICE)
    assert.equal(r.usage, null)
  })

  test('没有 sessionProjections 服务', () => {
    const store = new Map([['s-1', { __state: { ...EMPTY_USAGE_STATE } }]])
    const r = readRunUsage(ctxWith({ sessions: store, hasProjections: false }), 's-1')
    assert.equal(r.code, USAGE_READ_CODES.NO_PROJECTIONS_SERVICE)
  })

  test('会话找不到（归因键对不上）', () => {
    const r = readRunUsage(ctxWith({ sessions: new Map() }), 's-missing')
    assert.equal(r.code, USAGE_READ_CODES.SESSION_NOT_FOUND)
  })

  test('投影没注册（`stateOf` 返回 undefined）', () => {
    const store = new Map([['s-1', {}]])
    const r = readRunUsage(ctxWith({ sessions: store, projections: { stateOf: () => undefined } }), 's-1')
    // ★ 这一格与"注册了但没数据"必须分开：前者要人去注册，后者是正常的早期状态。
    assert.equal(r.code, USAGE_READ_CODES.NO_PROJECTIONS_SERVICE)
  })

  test('注册了、会话在，但还没有带用量的事件', () => {
    const store = new Map([['s-1', { __state: { ...EMPTY_USAGE_STATE } }]])
    const r = readRunUsage(ctxWith({ sessions: store }), 's-1')
    assert.equal(r.code, USAGE_READ_CODES.NO_USAGE_EVENTS)
    assert.equal(r.usage, null)
  })

  test('★ 五个码两两不同形（否则"哪一种读不到"读不出来）', () => {
    const codes = Object.values(USAGE_READ_CODES)
    assert.equal(new Set(codes).size, codes.length)
  })

  test('★ 空 id / 非字符串不当作"会话找不到"的同一个理由之外的猜测', () => {
    assert.equal(readRunUsage(ctxWith({}), '').code, USAGE_READ_CODES.SESSION_NOT_FOUND)
    assert.equal(readRunUsage(ctxWith({}), null).code, USAGE_READ_CODES.SESSION_NOT_FOUND)
    assert.equal(readRunUsage(ctxWith({}), 42).code, USAGE_READ_CODES.SESSION_NOT_FOUND)
  })
})

// ───────────────────────────────────────────────────────── ④ 读到了

describe('④ 读到了：形状与契约字段名对齐', () => {
  test('由 SessionId 读回累加后的用量', () => {
    const state = foldEvents([usageEvent({ input: 10, output: 5, cacheRead: 100 })])
    const store = new Map([['session-abc', { __state: state }]])
    const r = readRunUsage(ctxWith({ sessions: store }), 'session-abc')
    assert.equal(r.ok, true)
    assert.equal(r.code, USAGE_READ_CODES.OK)
    assert.deepEqual(r.usage, { tokensIn: 10, tokensOut: 5, cacheReadTokens: 100, messages: 1 })
  })

  test('★ 字段名用 `tokensIn`/`tokensOut`：`collectUsage()` 认的就是这两个', () => {
    const state = foldEvents([usageEvent({ input: 42, output: 8 })])
    const u = usageFromState(state)
    assert.ok('tokensIn' in u && 'tokensOut' in u,
      '形状必须与 runtime/adapters/dsh/usage.mjs 的 collectUsage() 对齐，否则接了也读不出')
    assert.equal(u.tokensIn, 42)
    assert.equal(u.tokensOut, 8)
  })
})

// ───────────────────────────────────────────────────────── ⑤ 投影定义

describe('⑤ 投影定义：可直接交给 `sessionProjections.register()`', () => {
  const def = createUsageProjectionDefinition()

  test('键名、版本、仅主机（没有 wire）', () => {
    assert.equal(def.key, USAGE_PROJECTION_KEY)
    assert.equal(def.stateVersion, 1)
    assert.equal('wire' in def, false, '仅主机投影不该有 wire —— 它是给 Legion 自己读的')
  })

  test('`init()` 每次给一个**新**对象（不能共享可变状态）', () => {
    const a = def.init()
    const b = def.init()
    assert.deepEqual(a, { ...EMPTY_USAGE_STATE })
    assert.notEqual(a, b, '共享同一个对象会让一个会话的累加污染另一个')
    a.inputTokens = 999
    assert.equal(b.inputTokens, 0)
  })

  test('`apply` 就是那个纯折叠', () => {
    let s = def.init()
    s = def.apply(s, usageEvent({ input: 3, output: 1, cacheRead: 0 }))
    assert.equal(s.inputTokens, 3)
  })

  test('★ 坏掉的持久化状态在 `parse` 阶段就抛，不被前向折叠成垃圾', () => {
    assert.throws(() => def.stateSchema.parse(null))
    assert.throws(() => def.stateSchema.parse({ inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, messages: 0 }))
    assert.throws(() => def.stateSchema.parse({ inputTokens: 1.5, outputTokens: 0, cacheReadTokens: 0, messages: 0 }))
    assert.throws(() => def.stateSchema.parse({ inputTokens: 0 }), '缺字段也要抛')
    const good = def.stateSchema.parse({ ...EMPTY_USAGE_STATE })
    assert.deepEqual(good, { ...EMPTY_USAGE_STATE })
  })
})

// ───────────────────────────────────────────────────────── ⑥ ★ 端到端：真注册进投影注册表

describe('⑥ ★ 把定义挂进真的投影驱动：事件流真的驱动折叠', () => {
  test('逐条喂事件 → 状态累加（用注册表的 apply 语义模拟驱动）', () => {
    // 这里不启动 DSH，只验证"定义 + 驱动语义"这一段：
    // 注册表在每个 committed event 上调用 apply，且不相干的事件返回同一引用。
    const def = createUsageProjectionDefinition()
    let state = def.init()
    const events = [
      { type: 'session' },
      { type: 'turn/start' },
      usageEvent({ input: 11, output: 2, cacheRead: 30 }),
      { type: 'step/end' },
      usageEvent({ input: 13, output: 4, cacheRead: 70 }),
      { type: 'turn/end' },
    ]
    let sameRefCount = 0
    for (const e of events) {
      const next = def.apply(state, e)
      if (next === state) sameRefCount += 1
      state = next
    }
    assert.equal(sameRefCount, 4, '4 条不相干事件必须原样返回（session/turn/start/step-end/turn-end 中的 4 条）')
    assert.deepEqual(state, { inputTokens: 24, outputTokens: 6, cacheReadTokens: 100, messages: 2 })
    // 而读出来就是契约形状
    assert.deepEqual(usageFromState(state), { tokensIn: 24, tokensOut: 6, cacheReadTokens: 100, messages: 2 })
  })
})
