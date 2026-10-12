import test from 'node:test'
import assert from 'node:assert/strict'
import { decideDispatchModel, parseBindingResolution, DISPATCH_MODEL_SOURCES } from '../src/dispatchModel.ts'

// BUG-027：让在跑的守护按 (空间, 岗位) 从绑定取模型。
//
// 这一组盯的是**三种会把好事变坏事**的写法：
//   ① 拿实时绑定去覆盖任务的冻结快照 ⇒ 同一份审批过的任务在两次重试里用不同模型；
//   ② 回落默认模型时**不说为什么** ⇒ “绑定了但没生效”与“没建绑定”看起来一样；
//   ③ 把四种失败（没绑定 / 绑定坏了 / 中枢没起 / 没配 hubUrl）压成同一句话 ⇒ 修错地方。

const okBody = (over = {}) => ({
  ok: true,
  resolution: {
    ok: true,
    chain: [{ id: 'fjd-ds.deepseek-v4-pro-openai', role: 'primary', provider: 'fjd-ds', model: 'deepseek-v4-pro-openai', reasoningEffort: 'medium' }],
    ...over,
  },
})

test('① 冻结快照优先：有它就不看绑定（两次重试用同一个模型）', () => {
  const d = decideDispatchModel({
    frozen: { provider: 'fjd-ds', model: 'deepseek-v4-flash-openai' },
    // 绑定指向**另一个**模型：不许覆盖冻结快照
    reading: parseBindingResolution(200, okBody()),
    scope: 'software', role: 'coder',
  })
  assert.equal(d.source, 'frozen')
  assert.deepEqual(d.agentOptions, { provider: 'fjd-ds', model: 'deepseek-v4-flash-openai' })
  assert.match(d.note, /冻结快照/)
})

test('★★ ② 没有冻结 + 绑定命中 ⇒ 用绑定主档案的 provider/model', () => {
  const d = decideDispatchModel({
    reading: parseBindingResolution(200, okBody()),
    scope: 'software', role: 'requirement',
  })
  assert.equal(d.source, 'binding')
  assert.deepEqual(d.agentOptions, { provider: 'fjd-ds', model: 'deepseek-v4-pro-openai', reasoningEffort: 'medium' })
  assert.match(d.note, /岗位 software\/requirement 的绑定/)
  assert.match(d.note, /fjd-ds\/deepseek-v4-pro-openai/)
})

test('③ 没有 reasoningEffort 时不带那个字段（不是带一个空串）', () => {
  const body = okBody()
  body.resolution.chain[0].reasoningEffort = null
  const d = decideDispatchModel({ reading: parseBindingResolution(200, body), scope: 's', role: 'r' })
  assert.deepEqual(d.agentOptions, { provider: 'fjd-ds', model: 'deepseek-v4-pro-openai' })
  assert.equal('reasoningEffort' in (d.agentOptions ?? {}), false)
})

// ---------------------------------------------------------------------------
// 失败四种分开报
// ---------------------------------------------------------------------------

test('★★★ ④ 没有绑定（404）⇒ 回落 + **说清是"没绑定"**', () => {
  const reading = parseBindingResolution(404, { ok: false, code: 'BINDING_NOT_FOUND' })
  assert.equal(reading.kind, 'no-binding')
  const d = decideDispatchModel({ reading, scope: 'software', role: 'coder' })
  assert.equal(d.source, 'default-fallback')
  assert.equal(d.agentOptions, null, '回落 = 不传 agentOptions（继承平台默认）')
  assert.match(d.note, /没有模型绑定/)
  assert.match(d.note, /平台默认模型/)
})

test('★★★ ⑤ 绑定坏了（200 但 resolution.ok=false）⇒ 与"没绑定"**不是同一句话**', () => {
  const reading = parseBindingResolution(200, { ok: true, resolution: { ok: false, code: 'PRIMARY_UNRESOLVED', message: '主档案解析不出来' } })
  assert.equal(reading.kind, 'broken')
  const d = decideDispatchModel({ reading, scope: 's', role: 'r' })
  assert.equal(d.source, 'default-fallback')
  assert.match(d.note, /绑定读不出来/)
  assert.doesNotMatch(d.note, /没有模型绑定/, '★ 这两种的修法不同：一个去建，一个去看那条绑定')
})

test('★★ ⑥ 中枢问不到（HTTP 500 / 网络失败）⇒ 说"问不到中枢"', () => {
  const reading = parseBindingResolution(500, { error: 'boom' })
  assert.equal(reading.kind, 'unreachable')
  assert.match(decideDispatchModel({ reading, scope: 's', role: 'r' }).note, /问不到中枢/)
})

test('★★ ⑦ 守护没配 hubUrl ⇒ 说"没配 hubUrl"（与"中枢没起"分开）', () => {
  const reading = { kind: 'hub-off', primary: null, detail: 'hubUrl 为空' }
  assert.match(decideDispatchModel({ reading, scope: 's', role: 'r' }).note, /没有配 hubUrl/)
})

test('★ ⑧ 链首不是主档案 ⇒ 当成 broken（不许拿备用顶班）', () => {
  const body = { ok: true, resolution: { ok: true, chain: [{ id: 'x', role: 'fallback', provider: 'p', model: 'm' }] } }
  const reading = parseBindingResolution(200, body)
  assert.equal(reading.kind, 'broken')
  assert.match(reading.detail, /链首不是一条可用的主档案/)
})

test('★ ⑨ 缺 provider/model 的链首也算 broken（半条档案不能用）', () => {
  for (const bad of [{ id: 'x', role: 'primary', provider: '', model: 'm' }, { id: 'x', role: 'primary', provider: 'p', model: '' }, { role: 'primary', provider: 'p', model: 'm' }]) {
    const reading = parseBindingResolution(200, { ok: true, resolution: { ok: true, chain: [bad] } })
    assert.equal(reading.kind, 'broken', JSON.stringify(bad))
  }
})

// ---------------------------------------------------------------------------
// provider 能力
// ---------------------------------------------------------------------------

test('★★★ ⑩ provider 不支持 agentOptions ⇒ 回落 + **说出"绑定了但用不上"**', () => {
  const d = decideDispatchModel({
    reading: parseBindingResolution(200, okBody()),
    scope: 'software', role: 'coder',
    agentOptionsSupported: false,
  })
  assert.equal(d.source, 'default-fallback')
  assert.equal(d.agentOptions, null)
  assert.match(d.note, /不支持 agentOptions/)
  assert.match(d.note, /fjd-ds\/deepseek-v4-pro-openai/, '★ 要把"本来该用哪个"说出来，否则看起来像没建绑定')
})

test('⑪ 没去问过绑定（reading=null）也回落，但说清是"没去问"', () => {
  const d = decideDispatchModel({ scope: 's', role: 'r' })
  assert.equal(d.source, 'default-fallback')
  assert.match(d.note, /没有去问绑定/)
})

// ---------------------------------------------------------------------------
// 形状纪律
// ---------------------------------------------------------------------------

test('⑫ 每一次判定都带 note（它是返回值的一部分，不是可选装饰）', () => {
  const cases = [
    decideDispatchModel({ frozen: { provider: 'p', model: 'm' }, scope: 's', role: 'r' }),
    decideDispatchModel({ reading: parseBindingResolution(200, okBody()), scope: 's', role: 'r' }),
    decideDispatchModel({ reading: parseBindingResolution(404, {}), scope: 's', role: 'r' }),
    decideDispatchModel({ scope: '', role: '' }),
  ]
  for (const d of cases) {
    assert.ok(DISPATCH_MODEL_SOURCES.includes(d.source), `source 不在集合里：${d.source}`)
    assert.equal(typeof d.note, 'string')
    assert.ok(d.note.length > 0, 'note 不许为空')
  }
})

test('⑬ 回落时的 note 一律带 ⚠（一眼能从日志里筛出来）', () => {
  for (const reading of [parseBindingResolution(404, {}), parseBindingResolution(500, {}), null]) {
    const d = decideDispatchModel({ reading, scope: 's', role: 'r' })
    if (d.source === 'default-fallback') assert.match(d.note, /⚠/, `回落必须显眼：${d.note}`)
  }
})

test('⑭ 坏输入不抛（响应是垃圾也要给出一个读数，而不是把守护带崩）', () => {
  for (const body of [null, undefined, 'x', 42, {}, { ok: true }, { ok: true, resolution: 'x' }, { ok: true, resolution: { ok: true, chain: 'x' } }]) {
    const reading = parseBindingResolution(200, body)
    assert.ok(typeof reading.kind === 'string', JSON.stringify(body))
    assert.doesNotThrow(() => decideDispatchModel({ reading, scope: 's', role: 'r' }))
  }
})
