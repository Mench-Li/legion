// F-25 渠道判据：生产路径上的"身份不来自渠道 / 幂等 / 新渠道不改核心 / 准入才落待办"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createChannelRoutes, parseIdentityMap } from './channels.mjs'
import { createChannelStore, LiveIdentityMap } from '../channel-store.mjs'
import { REJECT } from '../../runtime/contracts/channel-contract.mjs'

// ★ 量具的纪律：**每次调用自带 body**。第一版让 hit() 复用上一次的载荷，
//   于是"绑定"那条请求收到的其实是入站载荷 ⇒ 绑定从未发生 ⇒ 后面每条都红，
//   而红的样子像"活视图不生效"。*一个不换请求体的量具，与一个坏掉的实现，
//   在"绑定后仍被拒"这个读数上是同一个东西。*
function mk() {
  const store = createChannelStore({ db: new DatabaseSync(':memory:') })
  const calls = []
  let body
  const handleWrite = async (_q, _s, cb) => {
    try { calls.push({ ok: true, value: await cb(body, 'tester', 'default') }) }
    catch (e) { calls.push({ ok: false, message: String(e.message) }) }
  }
  const routes = createChannelRoutes({ json: () => {}, handleWrite, channelStore: store })
  const hit = async (path, b, method = 'POST') => {
    body = b
    const r = await routes.dispatch({ method }, {}, { path })
    if (calls.length > 0) calls[calls.length - 1].path = path
    return r
  }
  return { store, routes, calls, hit }
}

const REST = (id = 'r1') => ({ channel: 'rest', payload: { userId: 'u-1', eventId: id, text: '部署' } })
const FEISHU = (id = 'f1') => ({ channel: 'feishu', payload: { header: { event_id: id }, event: { sender: { sender_id: { open_id: 'ou_1' } }, message: { content: '{"text":"部署"}' } } } })
const MAIL = () => ({ channel: 'email', payload: { messageId: '<m1@x>', from: 'a@b.c', subject: '部署' } })
const BIND = (channel, externalUserId, userId) => ({ channel, externalUserId, userId })

test('F-25 缺注入项 ⇒ 当场抛（与其它族同一条纪律）', () => {
  assert.throws(() => createChannelRoutes({ json: () => {}, handleWrite: async () => {} }), /createChannelRoutes 缺注入项：channelStore/)
})

test('★ F-25 生产默认（一张表都没绑）⇒ 任何入站都具名拒绝，一条都不放行、也不进待办', async () => {
  const s = mk()
  await s.hit('/api/channels/inbound', REST())
  assert.equal(s.calls[0].ok, false)
  assert.match(s.calls[0].message, new RegExp(REJECT.UNMAPPED_USER))
  assert.equal(s.routes.gate.runCount(), 0)
  assert.equal(s.store.count(), 0, '被拒的入站不得进待办队列')
})

test('★ F-25 A：绑定发生在闸门构造之后也立刻生效（活视图，不是启动时的快照）', async () => {
  const s = mk()
  await s.hit('/api/channels/identity', BIND('rest', 'u-1', 'legion-1'))
  assert.equal(s.calls[0].ok, true, '绑定本身要成功：' + s.calls[0].message)
  await s.hit('/api/channels/inbound', REST('r2'))
  assert.equal(s.calls[1].ok, true, '绑定后必须立刻放行')
  assert.equal(s.calls[1].value.accepted, true)
  assert.equal(s.calls[1].value.userId, 'legion-1')
})

test('F-25 A：解绑 ⇒ 立刻回到失败关闭；removed 计数如实', async () => {
  const s = mk()
  await s.hit('/api/channels/identity', BIND('rest', 'u-1', 'legion-1'))
  await s.hit('/api/channels/inbound', REST('r3'))
  assert.equal(s.calls[1].value.accepted, true)
  await s.hit('/api/channels/identity', { action: 'unbind', channel: 'rest', externalUserId: 'u-1' })
  assert.equal(s.calls[2].value.removed, 1, '真删了一行才报 1')
  await s.hit('/api/channels/inbound', REST('r4'))
  assert.equal(s.calls[3].ok, false, '解绑后必须回到拒绝')
  assert.match(s.calls[3].message, new RegExp(REJECT.UNMAPPED_USER))
  await s.hit('/api/channels/identity', { action: 'unbind', channel: 'rest', externalUserId: 'u-1' })
  assert.equal(s.calls[4].value.removed, 0, '再解绑报 0（不许假报删掉了一行）')
})

test('★ F-25 B：准入后才落待办；重复投递不重复入队（端到端幂等）', async () => {
  const s = mk()
  await s.hit('/api/channels/identity', BIND('rest', 'u-1', 'legion-1'))
  await s.hit('/api/channels/inbound', REST('r9'))
  await s.hit('/api/channels/inbound', REST('r9'))
  assert.equal(s.calls[1].value.accepted, true)
  assert.equal(s.calls[1].value.inboxId !== null, true, '准入必须落一条待办')
  assert.equal(s.calls[2].value.duplicate, true)
  assert.equal(s.calls[2].value.runKey, s.calls[1].value.runKey, '重复投递指回同一个 Run 键')
  assert.equal(s.store.count(), 1, '两次投递只留一条待办')
  const p = s.store.pending()
  assert.equal(p.length, 1)
  assert.equal(p[0].state, 'pending')
  assert.equal(p[0].userId, 'legion-1')
  assert.equal(p[0].text, '部署')
})

test('F-25 未知渠道 / 畸形载荷 / 缺 channel ⇒ 都拒（理由不同形），且都不进待办', async () => {
  const cases = [
    [{ channel: 'rest', payload: { userId: 'u-1' } }, REJECT.MALFORMED],
    [{ channel: 'rest', payload: { eventId: 'e1' } }, REJECT.MALFORMED],
    [{ channel: 'nope', payload: { userId: 'u-1', eventId: 'e1' } }, REJECT.UNKNOWN_CHANNEL],
  ]
  for (const [body, code] of cases) {
    const s = mk()
    await s.hit('/api/channels/identity', BIND('rest', 'u-1', 'legion-1'))
    await s.hit('/api/channels/inbound', body)
    assert.equal(s.calls[1].ok, false, JSON.stringify(body))
    assert.match(s.calls[1].message, new RegExp(code), JSON.stringify(body))
    assert.equal(s.store.count(), 0)
  }
  const s2 = mk()
  await s2.hit('/api/channels/inbound', { payload: {} })
  assert.match(s2.calls[0].message, /缺少参数 channel/)
})

test('★ F-25 三渠道（飞书/REST/邮件）走同一条生产路径，判定只有一份', async () => {
  const s = mk()
  await s.hit('/api/channels/identity', BIND('feishu', 'ou_1', 'legion-1'))
  await s.hit('/api/channels/identity', BIND('rest', 'u-1', 'legion-1'))
  await s.hit('/api/channels/identity', BIND('email', 'a@b.c', 'legion-1'))
  const outs = []
  for (const b of [FEISHU('f9'), REST('r9b'), MAIL()]) {
    await s.hit('/api/channels/inbound', b)
    outs.push(s.calls[s.calls.length - 1].value)
  }
  for (const o of outs) { assert.equal(o.accepted, true); assert.equal(o.userId, 'legion-1') }
  assert.deepEqual(outs.map((o) => o.channelId), ['feishu', 'rest', 'email'])
  assert.equal(new Set(outs.map((o) => o.runKey)).size, 3, '三个渠道各自一个 Run 键')
  assert.equal(s.routes.gate.runCount(), 3)
  assert.equal(s.store.count(), 3, '三条待办')
})

test('F-25 本族只认自己那几条路：别的路径/方法不抢（dispatch 返回 false）', async () => {
  const s = mk()
  assert.equal(await s.hit('/api/tasks', REST()), false)
  assert.equal(await s.hit('/api/channels/inbound', REST(), 'GET'), false)
  assert.equal(s.routes.id, 'channels')
  assert.equal(s.routes.routes.length, 4)
})

test('F-25 身份映射解析器（留给批量导入）：合法解析 / 坏形状当场抛', () => {
  assert.equal(parseIdentityMap('{"feishu:ou_1":"legion-1"}').get('feishu:ou_1'), 'legion-1')
  assert.equal(parseIdentityMap('{}').size, 0)
  for (const bad of ['not json', '[]', '{"nokey":"u"}', '{"feishu:x":""}']) assert.throws(() => parseIdentityMap(bad), undefined, bad)
  assert.throws(() => parseIdentityMap(null), /需要文本/)
})

test('★ F-25 活视图本身：instanceof Map 成立，且读到的是当下的表（不是快照）', () => {
  let current = new Map([['rest:u-1', 'legion-1']])
  const live = new LiveIdentityMap(() => current)
  assert.equal(live instanceof Map, true, '契约要求 instanceof Map')
  assert.equal(live.get('rest:u-1'), 'legion-1')
  current = new Map([['rest:u-1', 'legion-2']])
  assert.equal(live.get('rest:u-1'), 'legion-2', '换了表必须读到新值')
  current = new Map()
  assert.equal(live.has('rest:u-1'), false)
})
