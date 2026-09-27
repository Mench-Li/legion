// F-25 第一刀的可复跑判据（套件 `channel-contract`，标签点名 F-25）。
// 核的是契约的三条不许让步：身份不来自渠道 / 幂等 / 新渠道不改核心。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_IDS, REJECT, createChannelRegistry, createInboundGate, createEchoChannel,
} from './channel-contract.mjs'

const setup = (mapping = [['echo:u1', 'legion-1']]) => {
  const registry = createChannelRegistry()
  registry.register(createEchoChannel('echo'))
  const gate = createInboundGate({ registry, identityMap: new Map(mapping) })
  return { registry, gate }
}

test('F-25 契约：三渠道 id 已定（飞书最先/REST/邮件）', () => {
  assert.deepEqual(CHANNEL_IDS, ['feishu', 'rest', 'email'])
})

test('F-25 契约：未注册的渠道 ⇒ 明确拒绝，不得静默丢弃', () => {
  const { gate } = setup()
  const r = gate.accept('nope', { externalUserId: 'u1', rawId: 'm1' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, REJECT.UNKNOWN_CHANNEL)
})

test('F-25 契约：渠道翻译不出来 ⇒ malformed（带审计）', () => {
  const { gate } = setup()
  for (const bad of [null, 42, {}, { externalUserId: 'u1' }]) {
    const r = gate.accept('echo', bad)
    assert.equal(r.ok, false, '这些输入都该被拒：' + JSON.stringify(bad))
    assert.equal(r.reason, REJECT.MALFORMED)
    assert.ok(r.audit !== undefined)
  }
})

test('★ F-25 契约：身份不来自渠道 —— 缺映射就拒绝并记账，不得默认放行', () => {
  const { gate } = setup([['echo:u1', 'legion-1']])
  const r = gate.accept('echo', { externalUserId: 'u-陌生', text: 'hi', rawId: 'm2' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, REJECT.UNMAPPED_USER)
  assert.equal(r.audit.externalUserId, 'u-陌生', '拒了也要记账，否则无从追')
  assert.equal(gate.runCount(), 0, '被拒的输入不得产生 Run')
})

test('F-25 契约：有映射 ⇒ 放行，并把 userId 绑进事件（身份由 Legion 给，不是渠道给）', () => {
  const { gate } = setup()
  const r = gate.accept('echo', { externalUserId: 'u1', text: 'hi', rawId: 'm3' })
  assert.equal(r.ok, true)
  assert.equal(r.event.userId, 'legion-1')
  assert.notEqual(r.event.userId, r.event.externalUserId, '渠道侧 id 不是 Legion 身份')
})

test('★ F-25 契约：幂等 —— 同一条外部消息重复投递只产生一个 Run', () => {
  const { gate } = setup()
  const msg = { externalUserId: 'u1', text: 'hi', rawId: 'm4' }
  const first = gate.accept('echo', msg)
  assert.equal(first.ok, true)
  const again = gate.accept('echo', { ...msg })
  assert.equal(again.ok, false)
  assert.equal(again.reason, REJECT.DUPLICATE)
  assert.equal(again.runKey, first.runKey, '重复投递必须指回同一个 Run')
  assert.equal(gate.runCount(), 1, '只许有一个 Run')
})

test('★ F-25 契约：接入第二个渠道 ⇒ 核心零 diff（同一个闸门实例直接用）', () => {
  const { registry, gate } = setup([['echo:u1', 'legion-1'], ['echo2:u9', 'legion-9']])
  const before = gate.accept('echo', { externalUserId: 'u1', text: 'a', rawId: 'r1' })
  assert.equal(before.ok, true)
  // 新渠道只是"注册进来"——不新建闸门、不改闸门代码
  registry.register(createEchoChannel('echo2'))
  const after = gate.accept('echo2', { externalUserId: 'u9', text: 'b', rawId: 'r1' })
  assert.equal(after.ok, true, '第二个渠道必须能被同一个闸门直接处理')
  assert.notEqual(after.runKey, before.runKey, '两个渠道的 rawId 各自独立（键里有 channelId）')
  assert.equal(gate.runCount(), 2)
})

test('F-25 契约：闸门不认识任何具体渠道（源码里没有飞书/REST/邮件分支）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./channel-contract.mjs', import.meta.url), 'utf8'))
  const gatePart = src.slice(src.indexOf('export function createInboundGate'), src.indexOf('export function createEchoChannel'))
  for (const name of ['feishu', 'rest', 'email']) {
    assert.equal(gatePart.includes(name), false, '闸门里不该出现具体渠道名：' + name)
  }
})
