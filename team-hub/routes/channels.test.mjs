// F-25 渠道入站族判据：生产路径上的"身份不来自渠道 / 幂等 / 新渠道不改核心"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChannelRoutes, parseIdentityMap } from './channels.mjs'
import { REJECT } from '../../runtime/contracts/channel-contract.mjs'

test('F-25 缺注入项 ⇒ 当场抛（与其它族同一条纪律）', () => {
  assert.throws(() => createChannelRoutes({ json: () => {} }), /createChannelRoutes 缺注入项：handleWrite/)
})

test('★ F-25 生产默认（不注入 identityMap）⇒ 任何入站都具名拒绝，一条都不放行', async () => {
  let thrown
  const handleWrite = async (_q, _s, cb) => { try { await cb({ channel: 'rest', payload: { userId: 'u-1', eventId: 'e1', text: 'x' } }, 'b', 's') } catch (e) { thrown = e } }
  const routes = createChannelRoutes({ json: () => {}, handleWrite })
  const hit = await routes.dispatch({ method: 'POST' }, {}, { path: '/api/channels/inbound' })
  assert.equal(hit, true)
  assert.match(String(thrown?.message), new RegExp(REJECT.UNMAPPED_USER))
  assert.equal(routes.gate.runCount(), 0, '被拒的入站不得产生 Run')
})

test('F-25 未知渠道 / 畸形载荷 / 缺 channel ⇒ 都拒（且理由不同形）', async () => {
  const mk = (body) => {
    let thrown
    const handleWrite = async (_q, _s, cb) => { try { await cb(body, 'b', 's') } catch (e) { thrown = e } }
    return { routes: createChannelRoutes({ json: () => {}, handleWrite }), get thrown() { return thrown } }
  }
  for (const [body, pat] of [
    [{ channel: 'rest', payload: { userId: 'u-1' } }, new RegExp(REJECT.MALFORMED)],
    [{ channel: 'rest', payload: { eventId: 'e1' } }, new RegExp(REJECT.MALFORMED)],
    [{ channel: 'nope', payload: { userId: 'u-1', eventId: 'e1' } }, new RegExp(`${REJECT.UNKNOWN_CHANNEL}|${REJECT.MALFORMED}`)],
    [{ payload: {} }, /缺少参数 channel/],
  ]) {
    const s = mk(body)
    const hit = await s.routes.dispatch({ method: 'POST' }, {}, { path: '/api/channels/inbound' })
    assert.equal(hit, true)
    assert.match(String(s.thrown?.message), pat, JSON.stringify(body))
  }
})

test('★ F-25 映射到位 ⇒ 放行；重复投递 ⇒ 指回同一个 runKey（幂等，不是错误）', async () => {
  const map = new Map([['rest:u-1', 'legion-1']])
  const bodies = [
    { channel: 'rest', payload: { userId: 'u-1', eventId: 'e9', text: '部署' } },
    { channel: 'rest', payload: { userId: 'u-1', eventId: 'e9', text: '部署' } },
  ]
  const outs = []
  let i = 0
  const handleWrite = async (_q, _s, cb) => { outs.push(await cb(bodies[i++], 'b', 's')) }
  const routes = createChannelRoutes({ json: () => {}, handleWrite, identityMap: map })
  await routes.dispatch({ method: 'POST' }, {}, { path: '/api/channels/inbound' })
  await routes.dispatch({ method: 'POST' }, {}, { path: '/api/channels/inbound' })
  assert.equal(outs[0].accepted, true)
  assert.equal(outs[0].userId, 'legion-1')
  assert.equal(outs[0].duplicate, undefined)
  assert.equal(outs[1].duplicate, true)
  assert.equal(outs[1].runKey, outs[0].runKey, '重复投递必须指回同一个 Run 键')
  assert.equal(routes.gate.runCount(), 1, '两次投递只产生一个 Run')
})

test('F-25 本族只认自己那一条路：别的路径/方法一并不抢（dispatch 返回 false）', async () => {
  const routes = createChannelRoutes({ json: () => {}, handleWrite: async () => {} })
  assert.equal(await routes.dispatch({ method: 'GET' }, {}, { path: '/api/channels/inbound' }), false)
  assert.equal(await routes.dispatch({ method: 'POST' }, {}, { path: '/api/tasks' }), false)
  assert.equal(routes.id, 'channels')
})

test('★ F-25 核心零 diff：本族只注册适配器，判定全在契约闸门里（一个闸门实例、不复制规则）', async () => {
  const fs = await import('node:fs')
  const src = await fs.promises.readFile(new URL('./channels.mjs', import.meta.url), 'utf8')
  // 本族不得自己判身份/幂等：出现这些词就说明规则被抄了一份
  for (const bad of ['open_id', 'identityMap.get', 'seen.has', 'runKey =']) {
    assert.equal(src.includes(bad), false, '本族不该自己实现：' + bad)
  }
  const routes = createChannelRoutes({ json: () => {}, handleWrite: async () => {} })
  assert.equal(typeof routes.gate.accept, 'function')
  assert.equal(routes.routes.length, 1, '本族只认一条路')
})

test('★ F-25 三渠道（飞书/REST/邮件）走同一条生产路径，判定逻辑一份', async () => {
  const map = parseIdentityMap(JSON.stringify({
    'feishu:ou_9': 'legion-9',
    'rest:u-9': 'legion-9',
    'email:a@b.c': 'legion-9',
  }))
  const bodies = [
    { channel: 'feishu', payload: { header: { event_id: 'f1' }, event: { sender: { sender_id: { open_id: 'ou_9' } }, message: { content: '{"text":"部署"}' } } } },
    { channel: 'rest', payload: { userId: 'u-9', eventId: 'r1', text: '部署' } },
    { channel: 'email', payload: { messageId: '<m1@x>', from: 'a@b.c', subject: '部署' } },
  ]
  let i = 0
  const outs = []
  const handleWrite = async (_q, _s, cb) => { outs.push(await cb(bodies[i++], 'b', 's')) }
  const routes = createChannelRoutes({ json: () => {}, handleWrite, identityMap: map })
  for (let k = 0; k < bodies.length; k += 1) {
    const hit = await routes.dispatch({ method: 'POST' }, {}, { path: '/api/channels/inbound' })
    assert.equal(hit, true)
  }
  assert.equal(outs.length, 3)
  for (const o of outs) { assert.equal(o.accepted, true); assert.equal(o.userId, 'legion-9') }
  assert.deepEqual(outs.map((o) => o.channelId), ['feishu', 'rest', 'email'])
  assert.equal(routes.gate.runCount(), 3)
  assert.equal(new Set(outs.map((o) => o.runKey)).size, 3, '三个渠道各自一个 Run 键')
})

test('F-25 身份映射解析器：合法解析 / 坏形状当场抛（不静默忽略）', () => {
  const m = parseIdentityMap('{"feishu:ou_1":"legion-1"}')
  assert.equal(m.get('feishu:ou_1'), 'legion-1')
  assert.equal(parseIdentityMap('{}').size, 0)
  for (const bad of ['not json', '[]', '{"nokey":"u"}', '{"feishu:x":""}']) {
    assert.throws(() => parseIdentityMap(bad), undefined, bad)
  }
  assert.throws(() => parseIdentityMap(null), /需要文本/)
})
