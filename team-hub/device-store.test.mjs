// team-hub/device-store.test.mjs
// 远程 Agent 通道 S-B：设备配对、令牌撤销、presence 投影。
//
// 重点：配对码一次性与短时、令牌撤销立即生效、**presence 不写任务状态**、
// 迟到连接事件不改写新连接。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_DEVICE_CAPABILITIES,
  DEVICE_CAPABILITIES,
  DEVICE_CODES,
  DeviceError,
  PAIRING_REDEEM_PER_MINUTE,
  PAIRING_TTL_MS,
  PRESENCE_STALE_MS,
  createDeviceStore,
} from './device-store.mjs'

function makeStore({ clock = { now: Date.now() } } = {}) {
  const db = new DatabaseSync(':memory:')
  let depth = 0
  const withTx = (mutate) => {
    const nested = depth > 0
    const name = `tx_sp_${depth + 1}`
    if (nested) db.exec(`SAVEPOINT ${name}`)
    else db.exec('BEGIN IMMEDIATE')
    depth += 1
    try {
      const r = mutate()
      if (nested) db.exec(`RELEASE ${name}`)
      else db.exec('COMMIT')
      depth -= 1
      return r
    } catch (e) {
      depth -= 1
      try {
        if (nested) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) }
        else db.exec('ROLLBACK')
      } catch { /* 保留原异常 */ }
      throw e
    }
  }
  const store = createDeviceStore({ db, withTx, clock: () => clock.now })
  return { db, store, clock }
}

const codeOf = (fn) => {
  try { fn(); return null } catch (e) { return e instanceof DeviceError ? e.code : `UNEXPECTED:${e.message}` }
}

const USER = 'user-1'

/** 造一条已配对的设备。 */
function paired(clock, opts = {}) {
  const ctx = opts.ctx ?? makeStore({ clock })
  const pairing = ctx.store.createPairingCode({ userId: USER, nodeName: '书桌电脑', ...opts.pairing })
  const device = ctx.store.redeemPairingCode({ code: pairing.code, platform: 'win32', protocolVersion: 1, ...opts.redeem })
  return { ...ctx, pairing, device }
}

// ── 能力白名单 ──────────────────────────────────────────────────────────────

test('配对默认只授予 task.run，dsh-web-proxy 需显式声明', () => {
  assert.deepEqual([...DEFAULT_DEVICE_CAPABILITIES], ['task.run'])
  assert.ok(DEVICE_CAPABILITIES.includes('dsh-web-proxy'))
  const clock = { now: Date.now() }
  const a = paired(clock)
  assert.deepEqual(a.device.capabilities, ['task.run'])

  const b = paired(clock, { ctx: makeStore({ clock }), redeem: { capabilities: ['task.run', 'dsh-web-proxy'] } })
  assert.deepEqual(b.device.capabilities, ['task.run', 'dsh-web-proxy'])
})

test('未登记的能力被具名拒绝，而不是静默过滤掉', () => {
  const clock = { now: Date.now() }
  const ctx = makeStore({ clock })
  const pairing = ctx.store.createPairingCode({ userId: USER, nodeName: 'pc' })
  // ★ 静默过滤会让 Node 以为自己拿到了那个能力（比如 dsh-web-proxy），
  //   于是它去用，而 Hub 侧没有任何记录。
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: pairing.code, capabilities: ['task.run', 'shell.any'] })), DEVICE_CODES.CAPABILITY_NOT_ALLOWED)
  // 被拒时不得消费配对码。
  const ok = ctx.store.redeemPairingCode({ code: pairing.code })
  assert.ok(ok.nodeId)
})

// ── 配对 ────────────────────────────────────────────────────────────────────

test('配对码一次性：第二次兑换被拒，且设备名沿用配对时的名字', () => {
  const clock = { now: Date.now() }
  const { store, device, pairing } = paired(clock)
  assert.equal(device.name, '书桌电脑')
  assert.equal(device.userId, USER)
  assert.equal(codeOf(() => store.redeemPairingCode({ code: pairing.code })), DEVICE_CODES.PAIRING_CONSUMED)
  assert.equal(store.listDevices().length, 1)
})

test('配对码过期后被拒', () => {
  const clock = { now: Date.now() }
  const ctx = makeStore({ clock })
  const pairing = ctx.store.createPairingCode({ userId: USER, nodeName: 'pc', ttlMs: 1000 })
  assert.equal(pairing.expiresAtMs - clock.now, 1000)
  assert.equal(PAIRING_TTL_MS, 10 * 60 * 1000)
  clock.now += 1001
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: pairing.code })), DEVICE_CODES.PAIRING_EXPIRED)
})

test('编造的配对码返回 not found', () => {
  const clock = { now: Date.now() }
  const ctx = makeStore({ clock })
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: 'nope' })), DEVICE_CODES.PAIRING_NOT_FOUND)
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: '' })), DEVICE_CODES.INVALID_INPUT)
})

test('库里不存配对码明文与设备令牌明文', () => {
  const clock = { now: Date.now() }
  const { db, device, pairing } = paired(clock)
  const codeRows = db.prepare('SELECT * FROM hub_device_pairing_codes').all()
  const deviceRows = db.prepare('SELECT * FROM hub_devices').all()
  const dump = JSON.stringify([codeRows, deviceRows])
  assert.ok(!dump.includes(pairing.code), '库中不得出现配对码明文')
  assert.ok(!dump.includes(device.deviceToken), '库中不得出现设备令牌明文')
  assert.ok(deviceRows[0].token_hash.length === 64)
})

test('兑换限速：超过每分钟上限即拒绝', () => {
  const clock = { now: Date.now() }
  const ctx = makeStore({ clock })
  for (let i = 0; i < PAIRING_REDEEM_PER_MINUTE; i += 1) {
    ctx.store.createPairingCode({ userId: USER, nodeName: `pc-${i}` })
    // 用不存在的码也会计数：限速守的是**入口**，不是"成功的兑换"。
    codeOf(() => ctx.store.redeemPairingCode({ code: `guess-${i}` }))
  }
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: 'one-more' })), DEVICE_CODES.PAIRING_RATE_LIMITED)
  // 窗口滑过之后恢复。
  clock.now += 61_000
  assert.equal(codeOf(() => ctx.store.redeemPairingCode({ code: 'after-window' })), DEVICE_CODES.PAIRING_NOT_FOUND)
})

// ── 设备令牌 ────────────────────────────────────────────────────────────────

test('设备令牌可用于认证，撤销后立即失效', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  const auth = store.authenticate({ token: device.deviceToken })
  assert.equal(auth.ok, true)
  assert.equal(auth.nodeId, device.nodeId)
  assert.equal(auth.userId, USER)
  assert.deepEqual(auth.capabilities, ['task.run'])

  store.revokeDevice({ nodeId: device.nodeId })
  const after = store.authenticate({ token: device.deviceToken })
  assert.equal(after.ok, false)
  assert.equal(after.code, DEVICE_CODES.DEVICE_REVOKED)
})

test('伪造令牌被拒，返回 ok:false 而不是抛错（握手路径要状态码）', () => {
  const clock = { now: Date.now() }
  const { store } = paired(clock)
  for (const bad of ['', 'made-up-token', null, undefined]) {
    const r = store.authenticate({ token: bad })
    assert.equal(r.ok, false)
    assert.equal(r.code, DEVICE_CODES.TOKEN_INVALID)
  }
})

test('轮换令牌后旧令牌失效、新令牌可用', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  const rotated = store.rotateToken({ nodeId: device.nodeId })
  assert.notEqual(rotated.deviceToken, device.deviceToken)
  assert.equal(store.authenticate({ token: device.deviceToken }).ok, false)
  assert.equal(store.authenticate({ token: rotated.deviceToken }).ok, true)
})

test('撤销是终态：重复撤销幂等，已撤销设备不能再轮换令牌', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  assert.equal(store.revokeDevice({ nodeId: device.nodeId }).revoked, true)
  assert.equal(store.revokeDevice({ nodeId: device.nodeId }).alreadyRevoked, true)
  assert.equal(codeOf(() => store.rotateToken({ nodeId: device.nodeId })), DEVICE_CODES.DEVICE_REVOKED)
})

test('不存在的设备返回 not found', () => {
  const clock = { now: Date.now() }
  const ctx = makeStore({ clock })
  assert.equal(codeOf(() => ctx.store.revokeDevice({ nodeId: 'node-nope' })), DEVICE_CODES.DEVICE_NOT_FOUND)
  assert.equal(codeOf(() => ctx.store.rotateToken({ nodeId: 'node-nope' })), DEVICE_CODES.DEVICE_NOT_FOUND)
})

test('设备列表可按用户过滤，且不暴露令牌哈希', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  const other = store.createPairingCode({ userId: 'user-2', nodeName: '笔记本' })
  store.redeemPairingCode({ code: other.code })
  assert.equal(store.listDevices().length, 2)
  assert.equal(store.listDevices({ userId: USER }).length, 1)
  const serialized = JSON.stringify(store.listDevices())
  assert.ok(!serialized.includes(device.deviceToken))
  assert.ok(!serialized.includes('token_hash'))
})

// ── presence 投影 ───────────────────────────────────────────────────────────

test('presence 是新设备的离线态，上线后变在线', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  assert.equal(store.presenceOf(device.nodeId).online, false)
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-1' })
  const online = store.presenceOf(device.nodeId)
  assert.equal(online.online, true)
  assert.equal(online.stale, false)
  assert.equal(online.connectionId, 'conn-1')
})

test('心跳超过阈值后判为连接中断，但**不**删除行也不改任务状态', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-1' })
  clock.now += PRESENCE_STALE_MS + 1000
  const p = store.presenceOf(device.nodeId)
  assert.equal(p.online, false)
  assert.equal(p.stale, true, '应报 stale，而不是"从来没见过"')
  // 行还在：删掉它就分不清"断了一会儿"与"这台机器从未存在"。
  assert.equal(store.listPresence().length, 1)
})

test('迟到的旧连接 close 不改写新连接的投影', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-old' })
  // 新连接建立（重连）。
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-new' })
  // 旧连接的 close 此刻才到。
  const res = store.markOffline({ nodeId: device.nodeId, connectionId: 'conn-old' })
  assert.equal(res.removed, false)
  assert.equal(res.reason, 'stale-connection')
  assert.equal(store.presenceOf(device.nodeId).online, true, '新连接必须仍然在线')
})

test('迟到的旧连接心跳不推进投影', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-old' })
  clock.now += 30_000
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-new' })
  clock.now += 10_000
  const res = store.heartbeat({ nodeId: device.nodeId, connectionId: 'conn-old', lastEventSeq: 99 })
  assert.equal(res.stale, true)
  assert.equal(store.presenceOf(device.nodeId).lastEventSeq, 0, '旧连接的序号不得写入')
})

test('重启后先发心跳的节点会被登记，而不是永远显示离线', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  const res = store.heartbeat({ nodeId: device.nodeId, connectionId: 'conn-1', lastEventSeq: 7 })
  assert.equal(res.registered, true)
  const p = store.presenceOf(device.nodeId)
  assert.equal(p.online, true)
  assert.equal(p.lastEventSeq, 7)
})

test('撤销设备会清掉它的 presence 行（不留一台"在线"的幽灵）', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  store.markOnline({ nodeId: device.nodeId, connectionId: 'conn-1' })
  store.revokeDevice({ nodeId: device.nodeId })
  assert.equal(store.listPresence().length, 0)
})

test('sweepStale 只清心跳过期的行', () => {
  const clock = { now: Date.now() }
  const { store, device } = paired(clock)
  const fresh = store.createPairingCode({ userId: USER, nodeName: 'fresh' })
  const freshDevice = store.redeemPairingCode({ code: fresh.code })
  store.markOnline({ nodeId: device.nodeId, connectionId: 'c1' })
  clock.now += PRESENCE_STALE_MS + 1000
  store.markOnline({ nodeId: freshDevice.nodeId, connectionId: 'c2' })
  const res = store.sweepStale()
  assert.equal(res.removed, 1)
  assert.equal(store.listPresence().length, 1)
  assert.equal(store.presenceOf(freshDevice.nodeId).online, true)
})

test('presence 表里没有任何任务状态列（presence 不是任务真相源）', () => {
  const db = new DatabaseSync(':memory:')
  createDeviceStore({ db, withTx: (fn) => fn() })
  const cols = db.prepare('PRAGMA table_info(hub_node_presence)').all().map((c) => c.name)
  // ★ 这是设计文档 §6.3 的结构性保证：远程层不拥有任务状态。
  //   如果哪一天有人往这张表里加了 state/status，这条断言会红。
  for (const forbidden of ['state', 'status', 'task_state', 'attempt_state']) {
    assert.ok(!cols.includes(forbidden), `hub_node_presence 不得含任务状态列 ${forbidden}`)
  }
})

test('配对与撤销写入审计，且不含凭据明文', () => {
  const db = new DatabaseSync(':memory:')
  const entries = []
  const store = createDeviceStore({ db, withTx: (fn) => fn(), audit: (actor, scope, action, taskId, detail) => entries.push({ actor, action, detail }) })
  const pairing = store.createPairingCode({ userId: USER, nodeName: 'pc' })
  const device = store.redeemPairingCode({ code: pairing.code })
  store.revokeDevice({ nodeId: device.nodeId })

  const actions = entries.map((e) => e.action)
  for (const expected of ['device:pairing-create', 'device:paired', 'device:revoke']) {
    assert.ok(actions.includes(expected), `审计缺少 ${expected}`)
  }
  const dump = JSON.stringify(entries)
  assert.ok(!dump.includes(pairing.code))
  assert.ok(!dump.includes(device.deviceToken))
})
