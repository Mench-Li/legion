// team-hub/client-ip.test.mjs
// ============================================================================
// 真实客户端 IP 的推导：本族守的是一条**安全边界**，不是字符串处理。
//
// 核心断言只有一句：**不可信的对端说的一切都不算数。**
// 其余用例都是这句话在不同形状下的展开。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeIp, parseTrustedProxies, isTrusted, parseForwardedFor,
  clientIpFrom, isLoopbackOrPrivate,
} from './client-ip.mjs'

const LOOPBACK = parseTrustedProxies('127.0.0.1/32,::1/128')
const LAN = parseTrustedProxies('10.0.0.0/8')

// ── ① 规范化 ────────────────────────────────────────────────────────────────

test('★ IPv4-mapped 前缀必须被剥掉（否则"可信代理"静默失效）', () => {
  // Node 在双栈 socket 上给的就是 `::ffff:127.0.0.1`。不剥前缀，它永远匹配不上
  // `127.0.0.1/32` —— 于是 `isTrusted` 恒为 false，整套可信代理判断悄悄失灵，
  // 而**没有任何报错**：只是所有请求都被当成"来自不可信对端"。
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(isTrusted(normalizeIp('::ffff:127.0.0.1'), LOOPBACK.rules), true,
    '双栈上的回环也必须被认成可信 —— 这条就是上面那个失效的判据')
})

test('★ 端口与方括号要剥掉', () => {
  assert.equal(normalizeIp('127.0.0.1:51234'), '127.0.0.1')
  assert.equal(normalizeIp('[::1]:443'), '::1')
  assert.equal(normalizeIp('[::1]'), '::1')
  assert.equal(normalizeIp('  203.0.113.7  '), '203.0.113.7')
  // IPv6 本身有冒号，不许被当成 v4:port 切开。
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1')
})

test('★ 非法输入回 null（不是回原文 —— 那会让调用方拿一个假地址去限速）', () => {
  for (const bad of ['', '   ', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5', '256.0.0.1',
    '1.2.3.4:abc', null, undefined, 0, {}, [], '10.0.0.1/8', 'example.com', '::gggg']) {
    assert.equal(normalizeIp(bad), null, `${JSON.stringify(bad)} 不该被解析成地址`)
  }
})

test('★ 前导零不算合法 IPv4（有的实现按八进制读）', () => {
  assert.equal(normalizeIp('010.0.0.1'), null)
  assert.equal(normalizeIp('1.2.3.04'), null)
})

test('★ IPv6 形状：`::` 最多一次，超过 8 组不算', () => {
  for (const ok of ['::1', '::', 'fe80::1', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001']) {
    assert.notEqual(normalizeIp(ok), null, `${ok} 应当合法`)
  }
  for (const bad of ['1::2::3', '1:2:3:4:5:6:7:8:9', ':1:2:3']) {
    assert.equal(normalizeIp(bad), null, `${bad} 不该合法`)
  }
})

// ── ② 可信代理表 ────────────────────────────────────────────────────────────

test('★★ 无效项**不静默丢弃**（"配了但没生效"与"没配"行为完全不同）', () => {
  const { rules, invalid } = parseTrustedProxies('127.0.0.1/32, not-an-ip, 10.0.0.0/33, ::1/128, 10.0.0.0/8')
  assert.equal(rules.length, 3, '三条合法的应当留下')
  assert.deepEqual(invalid, ['not-an-ip', '10.0.0.0/33'], '两条非法的必须被报出来')
})

test('★ 省略掩码 = 单个地址（/32 与 /128）', () => {
  const { rules } = parseTrustedProxies('1.2.3.4, ::1')
  assert.equal(rules.find((r) => r.base === '1.2.3.4').bits, 32)
  assert.equal(rules.find((r) => r.base === '::1').bits, 128)
})

test('★★ 前缀比较不许因为 32 位溢出而失效', () => {
  // `255.255.255.255` 无符号右移要在无符号域里做；用有符号移位会得到负数，
  // 于是 `/1`、`/0`、`/31` 这类前缀在**高位**地址上会算错。
  const all = parseTrustedProxies('0.0.0.0/0')
  assert.equal(isTrusted('255.255.255.255', all.rules), true, '/0 必须匹配一切')
  assert.equal(isTrusted('203.0.113.7', all.rules), true)
  const half = parseTrustedProxies('128.0.0.0/1')
  assert.equal(isTrusted('255.255.255.255', half.rules), true, '高位地址必须落在 /1 里')
  assert.equal(isTrusted('127.255.255.255', half.rules), false, '低位地址不该落在 /1 里')
  const lan = parseTrustedProxies('10.0.0.0/8')
  assert.equal(isTrusted('10.255.255.254', lan.rules), true)
  assert.equal(isTrusted('11.0.0.0', lan.rules), false)
})

test('★ 空表 = 谁都不信', () => {
  assert.equal(isTrusted('127.0.0.1', []), false)
  assert.equal(isTrusted('127.0.0.1', parseTrustedProxies('').rules), false)
  assert.equal(isTrusted('127.0.0.1', null), false)
})

test('★ v4 规则不许匹配 v6，反之亦然', () => {
  assert.equal(isTrusted('::1', LAN.rules), false)
  assert.equal(isTrusted('10.0.0.1', LOOPBACK.rules), false)
})

// ── ③ 链的解析 ──────────────────────────────────────────────────────────────

test('★ XFF 拆分：逗号、空白、空项、非法项', () => {
  assert.deepEqual(parseForwardedFor('1.2.3.4, 5.6.7.8'), ['1.2.3.4', '5.6.7.8'])
  assert.deepEqual(parseForwardedFor('1.2.3.4,,  '), ['1.2.3.4'])
  assert.deepEqual(parseForwardedFor('1.2.3.4, garbage, 5.6.7.8'), ['1.2.3.4', '5.6.7.8'])
  assert.deepEqual(parseForwardedFor(''), [])
  assert.deepEqual(parseForwardedFor(null), [])
  assert.deepEqual(parseForwardedFor(['1.2.3.4', '5.6.7.8']), ['1.2.3.4', '5.6.7.8'])
  // `::ffff:` 前缀在链里也要剥。
  assert.deepEqual(parseForwardedFor('::ffff:1.2.3.4'), ['1.2.3.4'])
})

// ── ④ 推导：本族的正文 ──────────────────────────────────────────────────────

test('★★★ 没配可信代理 → `X-Forwarded-For` **一个字都不信**', () => {
  // 这是整个模块存在的理由。一个"没配就信 XFF"的实现，等于让任何调用方
  // 自带一个 IP —— 攻击者每请求换一个假 IP，限速配额就永远用不完。
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '1.2.3.4',
    trustedProxies: parseTrustedProxies(''),
  })
  assert.equal(out.reason, 'no-trusted-proxy')
  assert.equal(out.ip, '127.0.0.1', '只能用直连对端，哪怕它是回环')
  assert.equal(out.effective, false, '回环地址不能用来当"一个客户端"')
})

test('★★★ 对端不可信 → 也不信 XFF（它自己就能编一个）', () => {
  const out = clientIpFrom({
    peerAddress: '203.0.113.7',      // 公网直连，不在可信表里
    forwardedFor: '1.2.3.4, 5.6.7.8',
    trustedProxies: LOOPBACK,
  })
  assert.equal(out.reason, 'untrusted-peer')
  assert.equal(out.ip, '203.0.113.7', '用对端自己的地址')
  assert.equal(out.effective, true, '公网对端是一个真客户端，可以用')
})

test('★★★ 对端可信 → 从**右**往左取第一个不可信地址', () => {
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '203.0.113.7',
    trustedProxies: LOOPBACK,
  })
  assert.equal(out.reason, 'forwarded')
  assert.equal(out.ip, '203.0.113.7')
  assert.equal(out.effective, true)
})

test('★★★ 攻击者在左端塞假 IP 不改结果（右端是反代追加的真话）', () => {
  // 攻击者发 `X-Forwarded-For: 1.2.3.4`，反代**追加**它看到的真实来源。
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '1.2.3.4, 198.51.100.9',
    trustedProxies: LOOPBACK,
  })
  assert.equal(out.ip, '198.51.100.9', '必须取右端的真实来源，不是左端的伪造值')
  // ★ 反例守卫：如果实现是"从左往右取第一个"，这条会失败 —— 那样的实现
  //   让攻击者每换一个假 IP 就换一条配额。
  assert.notEqual(out.ip, '1.2.3.4')
})

test('★★★ 攻击者伪造一个**可信**地址（回环）也没用', () => {
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '127.0.0.1, 198.51.100.9',   // 第一段是攻击者编的"我是本机"
    trustedProxies: LOOPBACK,
  })
  assert.equal(out.ip, '198.51.100.9', '可信项要被跳过，不能当成客户端')
})

test('★★ 多层可信代理：跳过全部可信跳，取第一个不可信', () => {
  const chain = parseTrustedProxies('127.0.0.1/32,10.0.0.0/8')
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '203.0.113.7, 10.0.0.5, 10.0.0.6',  // 客户端, 内层代理, 外层代理
    trustedProxies: chain,
  })
  assert.equal(out.ip, '203.0.113.7')
  assert.equal(out.reason, 'forwarded')
})

test('★ 链里全是可信地址 → 退回对端，且标为**不可用**', () => {
  const out = clientIpFrom({
    peerAddress: '127.0.0.1',
    forwardedFor: '10.0.0.5, 10.0.0.6',
    trustedProxies: parseTrustedProxies('127.0.0.1/32,10.0.0.0/8'),
  })
  assert.equal(out.reason, 'all-trusted')
  assert.equal(out.effective, false, '退回的是回环，不能用来限速')
})

test('★ 对端可信但 XFF 为空 → 退回对端', () => {
  for (const empty of ['', null, '   ', 'garbage']) {
    const out = clientIpFrom({ peerAddress: '127.0.0.1', forwardedFor: empty, trustedProxies: LOOPBACK })
    assert.equal(out.reason, 'no-chain', `XFF=${JSON.stringify(empty)}`)
  }
})

test('★ 对端解析不出来 → 明确报 unknown，不猜', () => {
  const out = clientIpFrom({ peerAddress: 'bogus', forwardedFor: '1.2.3.4', trustedProxies: LOOPBACK })
  assert.equal(out.ip, null)
  assert.equal(out.reason, 'unknown-peer')
  assert.equal(out.effective, false)
  assert.equal(clientIpFrom({}).reason, 'unknown-peer')
})

test('★★★ 反例守卫：`effective` 必须能区分"回环"与"真客户端"', () => {
  // `effective` 不是"ip 非空"的同义词，这条钉住那个区别。
  const loop = clientIpFrom({ peerAddress: '127.0.0.1', trustedProxies: LOOPBACK })
  assert.equal(loop.ip, '127.0.0.1')
  assert.equal(loop.effective, false, '回环不算一个可区分的客户端')
  const pub = clientIpFrom({ peerAddress: '198.51.100.9', trustedProxies: LOOPBACK })
  assert.equal(pub.effective, true)
  const cgnat = clientIpFrom({ peerAddress: '100.64.0.1', trustedProxies: LOOPBACK })
  assert.equal(cgnat.effective, false, 'CGNAT 出口后面是一群人，不能当一个人限速')
})

// ── ⑤ 私有/回环判定 ─────────────────────────────────────────────────────────

test('★ 回环 / 私有 / 链路本地 / CGNAT / 未指定 都算"不可用"', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isLoopbackOrPrivate(ip), true, `${ip} 应当算不可用`)
  }
  for (const ip of ['8.8.8.8', '203.0.113.7', '198.51.100.9', '172.32.0.1', '172.15.255.255',
    '100.63.255.255', '100.128.0.0', '2001:db8::1']) {
    assert.equal(isLoopbackOrPrivate(ip), false, `${ip} 应当算可用`)
  }
  // ★ CGNAT 的边界是 `100.64.0.0`–`100.127.255.255`，两侧各差一个数。
  assert.equal(isLoopbackOrPrivate('100.63.255.255'), false)
  assert.equal(isLoopbackOrPrivate('100.128.0.0'), false)
})

test('★ 空/非法一律当作"不可用"（宁可不启用限速，也不要锁住所有人）', () => {
  for (const bad of ['', null, undefined, 'bogus', 0]) {
    assert.equal(isLoopbackOrPrivate(bad), true, `${JSON.stringify(bad)} 应当算不可用`)
  }
})
