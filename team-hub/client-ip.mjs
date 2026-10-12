// team-hub/client-ip.mjs
// ============================================================================
// 从一次请求里推出**真实客户端 IP** —— 纯决策，没有任何 I/O。
//
// ## 为什么这件事必须是一个单独、可测的模块
//
// 部署形态是"Hub 绑回环 + 反代"（cloudflared / nginx）。于是
// `req.socket.remoteAddress` **恒为反代自己的地址**（127.0.0.1）——
// 它既不是客户端，也不能用来限速。真实来源只存在于 `X-Forwarded-For` 里，
// 而那是一个**调用方可以随便写**的头。
//
//   > 一个"信一个没人验证过的 X-Forwarded-For"的按 IP 限速，
//   > 与一个完全不限速的端点，在攻击者面前是同一个东西 ——
//   > 只不过前者多了一行看起来很安全的代码。
//
// 所以本模块守的是一条**明确的**规则：
//
//   ① 没配可信代理（`trustedProxies` 为空）→ **完全不看** `X-Forwarded-For`；
//   ② 直连对端**不在**可信列表里 → 也不看（它自己就能编一个）；
//   ③ 只有直连对端可信时，才从**右往左**走那条链，跳过可信的，
//      第一个不可信的才是客户端。
//
// ③ 的方向是刻意的：反代是**追加**（append）它看到的地址，所以链的右端是
// "离我最近的那一跳说的真话"。攻击者能在**左端**塞任意值，但塞不进右端。
//
//   `XFF: 1.2.3.4, 5.6.7.8`（攻击者自己写了 `1.2.3.4`，反代追加了真实的 `5.6.7.8`）
//   → 从右往左：`5.6.7.8` 不可信 → 就是它。✓
//   → 若从左往右，得到 `1.2.3.4`，攻击者每换一个假 IP 就换一条限速配额。
//
// 同一段判断在 `user-store.mjs` 里曾以"所以这里按**全局**算"的形式**绕开**过
// （见那里的注释）。绕开是对的——当时没有办法证明谁是可信代理——
// 但"没有办法"本身可以被修：把可信代理**配置出来**，这段判断就成立了。
// ============================================================================

/** 一个 IPv4 字面量。四段 0–255，不接受前导零（`010` 在有些实现里是八进制）。 */
const V4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * 规范化一个地址：去掉端口、方括号、以及 IPv4-mapped 前缀。
 *
 * ★ 这三件事都必须做，而且各自都对应一个真实的失败：
 *   · `::ffff:127.0.0.1` —— Node 在双栈 socket 上就是这么给的。不剥掉前缀，
 *     它永远匹配不上 `127.0.0.1/32`，于是"可信代理"静默失效；
 *   · `[::1]:443` / `127.0.0.1:51234` —— 有些反代把端口一起写进 XFF；
 *   · 空白与大小写 —— 头里什么样都有。
 *
 * @returns {string|null} 规范化后的地址；不是合法字面量时返回 null
 */
export function normalizeIp(value) {
  if (typeof value !== 'string') return null
  let s = value.trim()
  if (s.length === 0) return null
  // `[v6]:port` 或 `[v6]`
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s)
  if (bracketed !== null) s = bracketed[1]
  else {
    // `v4:port` —— ★ 端口必须是**数字**。
    //   第一版写的是 `if (V4.test(s.split(':')[0]) && s.includes(':')) s = s.split(':')[0]`，
    //   于是 `1.2.3.4:abc` 被静默截成 `1.2.3.4` —— 一个畸形值变成了一个合法地址，
    //   而调用方会拿它去限速（于是"每次都换一个畸形尾巴"就能绕过限速）。
    //   IPv6 自身含冒号，所以这个分支只在"冒号后全是数字"时才生效。
    const withPort = /^([^:]+):(\d+)$/.exec(s)
    if (withPort !== null && V4.test(withPort[1])) s = withPort[1]
  }
  s = s.toLowerCase()
  // IPv4-mapped：`::ffff:1.2.3.4`
  const mapped = /^::ffff:(.+)$/.exec(s)
  if (mapped !== null && V4.test(mapped[1])) s = mapped[1]
  if (V4.test(s)) return s
  // IPv6：只做形状校验（压缩形式、`::`、以及 8 组十六进制）。
  if (isIpv6(s)) return s
  return null
}

/** IPv6 字面量（含 `::` 压缩）。不做语义等价归一，只判"是不是一个地址"。 */
function isIpv6(s) {
  if (!/^[0-9a-f:]+$/.test(s)) return false
  if (!s.includes(':')) return false
  const doubleColons = s.split('::').length - 1
  if (doubleColons > 1) return false
  const groups = s.split(':').filter((g) => g.length > 0)
  if (doubleColons === 1) return groups.length <= 7
  return groups.length === 8
}

/** 把 IPv4 转成 32 位无符号整数；不是 IPv4 时返回 null。 */
function v4ToInt(ip) {
  if (!V4.test(ip)) return null
  const parts = ip.split('.').map(Number)
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]
}

/**
 * 解析一条可信代理表。
 *
 * 接受 `1.2.3.4`（= /32）、`10.0.0.0/8`、`2001:db8::/32`、`::1`（= /128）。
 * **无效项不静默丢弃**：它们被收集起来，因为"我配了但没生效"与"我没配"
 * 在限速行为上完全不同，而前者只在被攻击时才暴露。
 *
 * @param {string|string[]} text
 * @returns {{ rules: Array<{cidr: string, family: 4|6, base: string, bits: number}>, invalid: string[] }}
 */
export function parseTrustedProxies(text) {
  const items = (Array.isArray(text) ? text.join(',') : String(text ?? ''))
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  const rules = []
  const invalid = []
  for (const item of items) {
    const [addrPart, bitsPart] = item.includes('/') ? item.split('/') : [item, null]
    const addr = normalizeIp(addrPart)
    if (addr === null) { invalid.push(item); continue }
    const isV4 = V4.test(addr)
    const maxBits = isV4 ? 32 : 128
    let bits = maxBits
    if (bitsPart !== null) {
      if (!/^\d+$/.test(bitsPart.trim())) { invalid.push(item); continue }
      bits = Number(bitsPart.trim())
      if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) { invalid.push(item); continue }
    }
    rules.push({ cidr: item, family: isV4 ? 4 : 6, base: addr, bits })
  }
  return { rules, invalid }
}

/**
 * `ip` 是否落在可信表里。
 *
 * IPv4 做前缀比较；IPv6 做**字符串前缀**比较（对规范化后的地址足够用，
 * 且不需要引入一个完整的 IPv6 库 —— 可信代理表通常只有 `::1` / `fd00::/8`）。
 */
export function isTrusted(ip, rules) {
  if (typeof ip !== 'string' || ip.length === 0) return false
  if (!Array.isArray(rules) || rules.length === 0) return false
  for (const rule of rules) {
    if (rule.family === 4) {
      if (!V4.test(ip)) continue
      if (rule.bits === 0) return true
      const a = v4ToInt(ip)
      const b = v4ToInt(rule.base)
      if (a === null || b === null) continue
      // 用无符号右移比较前缀，避免 32 位溢出成负数。
      const shift = 32 - rule.bits
      if (rule.bits === 32 ? a === b : (a >>> shift) === (b >>> shift)) return true
      continue
    }
    // IPv6：只支持"整段前缀"的字符串比较（`::1` 精确匹配，`fd00::/8` 看头两个字符）。
    if (V4.test(ip)) continue
    if (rule.bits === 128) { if (ip === rule.base) return true; continue }
    const hexChars = Math.floor(rule.bits / 4)
    if (hexChars > 0 && ip.slice(0, hexChars) === rule.base.slice(0, hexChars)) return true
  }
  return false
}

/** 拆分 `X-Forwarded-For`（逗号分隔，可能有多层，可能有空白与空项）。 */
export function parseForwardedFor(value) {
  if (Array.isArray(value)) return value.map((v) => normalizeIp(String(v))).filter((v) => v !== null)
  if (typeof value !== 'string' || value.trim().length === 0) return []
  return value.split(',').map((s) => normalizeIp(s)).filter((v) => v !== null)
}

/**
 * 推出客户端 IP。
 *
 * `reason` 是**给运维看的**，也是判据的锚点 —— 它让"为什么这次限速用的是
 * 127.0.0.1"变成一个可以读出来的事实，而不是一个要猜的结果：
 *
 *   `'no-trusted-proxy'` 没配可信代理（XFF 被**完全忽略**）
 *   `'untrusted-peer'`   直连对端不可信（XFF 被忽略）
 *   `'forwarded'`        从 XFF 右端取到了第一个不可信地址 ← 正常情况
 *   `'all-trusted'`      XFF 里全是可信地址，退回直连对端
 *   `'no-chain'`         对端可信但 XFF 为空，退回直连对端
 *   `'unknown-peer'`     对端地址无法解析
 *
 * @param {{peerAddress?: string|null, forwardedFor?: string|string[]|null, trustedProxies?: object}} input
 *        `trustedProxies` 是 `parseTrustedProxies` 的结果（传 `{rules:[],invalid:[]}` 或省略 = 不信任何人）
 * @returns {{ip: string|null, reason: string, effective: boolean}}
 *          `effective` = 这个 IP 能不能用来按 IP 限速。
 *          它**不是**"ip 非空"的同义词：回环/内网地址虽然解析得出来，
 *          但拿它当"一个客户端"会把所有人算成同一个人（见下）。
 */
export function clientIpFrom({ peerAddress = null, forwardedFor = null, trustedProxies = null } = {}) {
  const rules = Array.isArray(trustedProxies?.rules) ? trustedProxies.rules : []
  const peer = normalizeIp(peerAddress)
  if (peer === null) return { ip: null, reason: 'unknown-peer', effective: false }

  if (rules.length === 0) {
    // 没配可信代理：**一个头都不信**。这不是保守过度 —— 见文件头那段。
    return { ip: peer, reason: 'no-trusted-proxy', effective: !isLoopbackOrPrivate(peer) }
  }
  if (!isTrusted(peer, rules)) {
    // 直连对端不可信 = 它可以自己编一个 XFF。
    return { ip: peer, reason: 'untrusted-peer', effective: !isLoopbackOrPrivate(peer) }
  }
  const chain = parseForwardedFor(forwardedFor)
  if (chain.length === 0) return { ip: peer, reason: 'no-chain', effective: false }
  // 从**右**往左：右端是最近一跳说的真话，攻击者只能污染左端。
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (isTrusted(chain[i], rules)) continue
    return { ip: chain[i], reason: 'forwarded', effective: true }
  }
  return { ip: peer, reason: 'all-trusted', effective: false }
}

/**
 * 这个地址是不是"不可能代表一个独立客户端"（回环 / 私有 / 链路本地 / 未指定）。
 *
 * ★ 为什么需要它：如果推导结果是 `127.0.0.1`，那意味着**所有**访客都会被算成
 *   同一个键。此时按 IP 限速会从"限制一个攻击者"变成"限制你的全部用户"——
 *   攻击者只要失败几次就能把所有人挡在门外（对自己用户的 DoS）。
 *   所以调用方必须能分辨这两种情形，并选择**不启用**。
 */
export function isLoopbackOrPrivate(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return true
  if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true
  // IPv6 唯一本地地址 / 链路本地。
  if (/^f[cd][0-9a-f]{2}:/.test(ip) || /^fe80:/.test(ip)) return true
  const n = v4ToInt(ip)
  if (n === null) {
    // 不是 IPv4：走到这里说明它不在上面那些 IPv6 私有前缀里。
    // 合法的公网 IPv6 → 可用；**连合法地址都不是** → 不可用（fail closed）。
    //
    // ★ 第一版这里是裸 `return false`，于是 `isLoopbackOrPrivate('bogus')` = false ——
    //   一个解析不出来的字符串被判成"一个可区分的客户端"，也就是说限速会拿它当键。
    //   方向反了：**认不出来的东西一律当作不可用**，宁可不启用限速，
    //   也不要拿一个说不清的键去锁人。
    return !isIpv6(ip)
  }
  const a = n >>> 24
  const b = (n >>> 16) & 0xff
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}
