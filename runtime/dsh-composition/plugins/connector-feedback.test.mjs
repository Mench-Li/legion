// runtime/dsh-composition/plugins/connector-feedback.test.mjs
// ============================================================================
// F-21 反馈面那一行的判据。三条主线：
//   ① 它订阅的是 **`tools/result`**（emit，`(exec, result)`），不是
//      `tools/pre-execute`（水瀑，`(exec, next)`）；写错签名会**什么都记不上**
//      而且什么都不报（DSH 承诺兜住 listener 的异常）。
//   ② 它**只观测**：不返回判定、不改结果。
//   ③ 卸载真的卸掉（不然热重载会留第二个监听器 ⇒ 失败被记两遍 ⇒
//      熔断器以两倍速度跳闸）。
//
// ★ 每条都配反向对照：一个恒真的判据与一个什么都没看的判据，
//   在只看"用例绿了没"的时候是同一个东西。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONNECTOR_FEEDBACK_CODES, CONNECTOR_FEEDBACK_PLUGIN_NAME,
  createConnectorFeedbackPlugin,
} from './connector-feedback.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'connector-feedback.mjs'), 'utf8')

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err?.code}：${err?.message}`)
  return err
}

/**
 * 一个够用的假 Context：记得谁订阅了什么、`effect` 收下的回调是哪些。
 *
 * ★ 它**故意**不复刻 Cordis 的全部行为——只复刻本行用到的那几处，
 *   这样断言的是**本行**的行为，而不是这个替身的行为。
 *
 * ★★ 但有一处**必须**复刻对：`ctx.effect(fn)` 收的是"**返回** disposer 的回调"，
 *   它把 `fn()` 的**返回值**当效果，而不是把 `fn` 本身当效果
 *   （`runtime-host-row.mjs:815-817` 逐字记着这个坑：
 *   写成 `ctx.effect(() => bound.unbind())` 会让 cordis 拿到一个布尔值并报
 *   `TypeError: Invalid effect`）。
 *
 *   本用例的第一版把 `runEffects` 写成"调 `fn()` 就算卸载完了"，
 *   于是**误报**了一次失败——它测的是替身，不是被测的行。
 *
 *   > 一个"调了回调"的替身，与一个"调了回调**返回的那个东西**"的替身，
 *   > 在"卸载到底有没有发生"上不是同一个东西——只不过前者会把
 *   > 正确的实现报成错的。
 */
function fakeCtx({ withEffect = true, withOn = true } = {}) {
  const handlers = new Map()
  const effects = []
  const disposed = []
  const ctx = {
    logger: { info: () => {} },
    on: withOn ? (evt, fn) => {
      if (!handlers.has(evt)) handlers.set(evt, [])
      handlers.get(evt).push(fn)
      const off = () => { disposed.push(evt); const a = handlers.get(evt); a.splice(a.indexOf(fn), 1) }
      return off
    } : undefined,
  }
  // ★ 收回调，**按 cordis 的形状**在卸载时调它的返回值。
  if (withEffect) {
    ctx.effect = (fn) => {
      const disposer = fn()
      if (typeof disposer !== 'function') {
        throw new TypeError(`Invalid effect：ctx.effect 的回调必须返回 disposer，收到 ${typeof disposer}`)
      }
      effects.push(disposer)
    }
  }
  ctx.emit = (evt, ...args) => { for (const fn of [...(handlers.get(evt) ?? [])]) fn(...args) }
  ctx.count = (evt) => (handlers.get(evt) ?? []).length
  ctx.runEffects = () => { for (const fn of effects) fn() }
  ctx.disposed = disposed
  return ctx
}

// ---------------------------------------------------------------------------
// ① ★★ 订阅的是 `tools/result`，且用的是 emit 的签名
// ---------------------------------------------------------------------------

test('① ★★ 挂上 `tools/result`，并且**不**去碰 `tools/pre-execute`', () => {
  const seen = []
  const plugin = createConnectorFeedbackPlugin({ listener: (e, r) => seen.push([e, r]) })
  const ctx = fakeCtx()

  plugin.apply(ctx)

  assert.equal(ctx.count('tools/result'), 1, '必须订阅 tools/result')
  assert.equal(ctx.count('tools/pre-execute'), 0,
    '判定面是**另一行**的事；在这里也订一份会让这一行"看起来接管了判定"')

  // 反向对照：**不订阅就什么都收不到**（证明上面那条断言不是恒真的）。
  const empty = fakeCtx()
  assert.equal(empty.count('tools/result'), 0)

  // emit 的签名是 `(exec, result)`，没有 next。
  ctx.emit('tools/result', { callId: 'c1' }, { isError: true })
  assert.deepEqual(seen, [[{ callId: 'c1' }, { isError: true }]])
})

test('①a ★★ 结构级：签名不许写成水瀑的 `(exec, next)`', () => {
  // 写成 `(exec, next) => … next()` 时，`next` 是 `undefined`，
  // 每次结果都会抛；而 DSH 契约承诺兜住 listener 的异常 ⇒ **什么都记不上、也什么都不报**。
  assert.equal(/ctx\.on\(\s*'tools\/result'\s*,\s*(async\s*)?\(\s*exec\s*,\s*next\s*\)/.test(SRC), false,
    'tools/result 的 listener 不许带 next 形参')
  assert.match(SRC, /ctx\.on\(\s*'tools\/result'\s*,\s*\(\s*exec\s*,\s*result\s*\)/,
    '签名应逐字是 (exec, result)')
  assert.equal(/tools\/pre-execute/.test(SRC.replace(/\/\/[^\n]*/g, '')), false,
    '源码（去注释后）不许引用 tools/pre-execute')
})

// ---------------------------------------------------------------------------
// ② ★ 只观测：不改结果、不返回判定
// ---------------------------------------------------------------------------

test('② ★★ 只观测：listener 的返回值被丢弃，emit 的返回值不影响任何人', () => {
  let calls = 0
  const plugin = createConnectorFeedbackPlugin({
    listener: () => { calls += 1; return { kind: 'deny', reason: '我不该有这个权力' } },
  })
  const ctx = fakeCtx()
  plugin.apply(ctx)

  // emit 没有"返回值"这个概念，但我们要确认本行**没有**把 listener 的返回值
  // 往外送（比如写成 `return listener(...)` 并指望它当判定）。
  const h = () => { ctx.emit('tools/result', {}, { isError: false }) }
  assert.doesNotThrow(h)
  assert.equal(calls, 1)

  // 结构级：handler 体里不许出现 `return` 把 listener 的结果送出去。
  assert.equal(/return\s+listener\s*\(/.test(SRC), false,
    '不许把 listener 的返回值当判定送出去（tools/result 是 emit，它没有判定权）')
})

// ---------------------------------------------------------------------------
// ③ ★★ 卸载真的卸掉
// ---------------------------------------------------------------------------

test('③ ★★ `ctx.effect` 收下 disposer；跑掉之后监听器真的没了', () => {
  let calls = 0
  const plugin = createConnectorFeedbackPlugin({ listener: () => { calls += 1 } })
  const ctx = fakeCtx()
  plugin.apply(ctx)

  ctx.emit('tools/result', {}, { isError: true })
  assert.equal(calls, 1, '挂载后应收到')
  assert.equal(ctx.count('tools/result'), 1)

  ctx.runEffects()
  assert.equal(ctx.count('tools/result'), 0, '卸载后监听器必须真的从事件上摘掉')
  ctx.emit('tools/result', {}, { isError: true })
  assert.equal(calls, 1, '卸载后**不许**再收到（不然热重载会把失败记两遍 ⇒ 两倍速度跳闸）')

  // ★ 为什么"记两遍"是致命的：熔断阈值是 3，记两遍时**两次**真失败就跳闸。
  //   这里把"卸干净"与"阈值"的关系写下来，免得日后有人把它当成洁癖。
  assert.equal([...ctx.disposed].includes('tools/result'), true)
})

test('③a 没有 `ctx.effect` 时退到 `ctx.on("dispose", …)`（两条路都要能卸载）', () => {
  let calls = 0
  const plugin = createConnectorFeedbackPlugin({ listener: () => { calls += 1 } })
  const ctx = fakeCtx({ withEffect: false })
  plugin.apply(ctx)

  assert.equal(ctx.count('tools/result'), 1)
  assert.equal(ctx.count('dispose'), 1, '没有 effect 时必须退到 dispose 事件')
  ctx.emit('tools/result', {}, { isError: true })
  assert.equal(calls, 1)
  ctx.emit('dispose')
  assert.equal(ctx.count('tools/result'), 0)
  ctx.emit('tools/result', {}, { isError: true })
  assert.equal(calls, 1)
})

// ---------------------------------------------------------------------------
// ④ ★★ 构造期 fail closed
// ---------------------------------------------------------------------------

test('④ ★★ 没有 listener ⇒ 构造期抛（不留一个"挂了但什么都不记"的行）', () => {
  for (const bad of [undefined, null, 'listener', 42, {}]) {
    throwsCode(() => createConnectorFeedbackPlugin({ listener: bad }),
      CONNECTOR_FEEDBACK_CODES.NO_LISTENER)
  }
  throwsCode(() => createConnectorFeedbackPlugin(), CONNECTOR_FEEDBACK_CODES.NO_LISTENER)
  // 反向对照：给对了**不许**抛。
  assert.doesNotThrow(() => createConnectorFeedbackPlugin({ listener: () => {} }))
})

test('④a ★ 没有 `ctx.on` ⇒ apply 期抛具名码（不静默挂空）', () => {
  const plugin = createConnectorFeedbackPlugin({ listener: () => {} })
  throwsCode(() => plugin.apply(fakeCtx({ withOn: false })), CONNECTOR_FEEDBACK_CODES.NO_EVENT_SEAM)
  throwsCode(() => plugin.apply({}), CONNECTOR_FEEDBACK_CODES.NO_EVENT_SEAM)
})

// ---------------------------------------------------------------------------
// ⑤ 行名与依赖声明
// ---------------------------------------------------------------------------

test('⑤ 行名与 `inject` 声明式表达（让挂载审计报得出没激活的行）', () => {
  const plugin = createConnectorFeedbackPlugin({ listener: () => {} })
  assert.equal(plugin.name, CONNECTOR_FEEDBACK_PLUGIN_NAME)
  assert.deepEqual(plugin.inject, ['tools'],
    '必须 inject tools：自己偷偷检查端口、于是永远不进 waiting 的写法，会让坏接线只在运行时暴露')
  // ★ 本文件不导出 default（行需要运行时配置，YAML 装不下）——
  //   而"没有 default"这件事本身必须有名字，否则装配方会以为漏了。
  assert.match(SRC, /export const NO_DEFAULT_EXPORT_REASON/)
})

test('⑤a `listener` 是**不可枚举**的（活对象不许被 JSON.stringify 带出去）', () => {
  const plugin = createConnectorFeedbackPlugin({ listener: () => {} })
  assert.equal(typeof plugin.listener, 'function')
  assert.equal(Object.keys(plugin).includes('listener'), false)
  assert.equal(JSON.stringify(plugin).includes('listener'), false)
})
