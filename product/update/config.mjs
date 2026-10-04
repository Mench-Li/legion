// product/update/config.mjs
// ============================================================================
// 打包时写入的客户端配置 —— 设计 §11 的「部署时填写」
//
// 设计 §4 line 15 的原话：「产品发行地址在打包时写入客户端，测试与生产分离；
// 具体域名、存储供应商由部署时填写。」
//
// §11 又补了一句：「设计默认采用静态 HTTPS 托管、完整包升级和用户确认，
// **不因暂缺云账号而阻塞协议开发**。」
//
// 这两句话合起来定义了本模块的形态：配置**必须能从文件读出来**（打包时写），
// 但**缺配置不能是崩溃**——缺配置的正确表现是"检查更新不可用，并说明原因"，
// 而不是"应用启动失败"。所以：
//
//   · `loadUpdateConfig()` 永远返回一个可用的对象，`usable: false` 时带 `reason`；
//   · 生产通道（stable）**不接受** http origin（host.mjs 已经强制）；
//   · 信任表为空时 `usable: false`，"没有公钥"和"验签失败"必须能分开报——
//     前者是部署没做完，后者是有人在改托管。
//
// ## 为什么信任表不从网络更新
//
// 设计 §5 line 128：「首期不提供远程任意替换信任根的入口」。所以信任表
// 只能来自随包文件（或一次由**旧钥匙签名**的 trust update，见 envelope.mjs
// 的 `applyTrustUpdate`）。一个"启动时去网上拉公钥"的实现把信任根交给了
// 与清单同一个托管方，那等于没有签名。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RELEASE_CHANNELS } from '../upgrade/channels.mjs'
import { createTrustStore } from './envelope.mjs'
import { createHostConfig } from './host.mjs'

/** 配置文件名（相对 installRoot）。 */
export const UPDATE_CONFIG_FILENAME = join('product', 'release', 'update-config.json')
export const UPDATE_TRUST_FILENAME = join('product', 'release', 'update-trust.json')

export const CONFIG_CODES = Object.freeze({
  MISSING_FILE: 'update-config-missing',
  BAD_FILE: 'update-config-bad',
  NO_ORIGIN: 'update-config-no-origin',
  NO_TRUST: 'update-config-no-trust',
  BAD_ORIGIN: 'update-config-bad-origin',
  CHANNEL_NOT_CONFIGURED: 'update-config-channel-missing',
})

/**
 * 配置文件的形状（文档用，不做运行时校验——真正的校验是下面逐字段的判据）：
 *
 * ```json
 * {
 *   "channels": {
 *     "stable":   { "origin": "https://updates.example.com", "prefix": "/legion" },
 *     "canary":   { "origin": "https://updates.example.com", "prefix": "/legion" },
 *     "internal": { "origin": "http://117.72.146.36", "prefix": "/test/legion", "allowInsecureHttp": true }
 *   },
 *   "defaultChannel": "stable",
 *   "checkOnStartup": true
 * }
 * ```
 *
 * 信任表文件的形状：
 *
 * ```json
 * { "format": "legion/update-trust@1", "sequence": 1,
 *   "keys": [ { "keyId": "release-2026-a", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…" } ] }
 * ```
 */
export function loadUpdateConfig({ installRoot, channel = null, allowInsecureHttp = false } = {}) {
  if (typeof installRoot !== 'string' || installRoot === '') {
    return unusable(CONFIG_CODES.MISSING_FILE, 'loadUpdateConfig 需要 installRoot')
  }
  const configPath = join(installRoot, UPDATE_CONFIG_FILENAME)
  const trustPath = join(installRoot, UPDATE_TRUST_FILENAME)

  let raw = null
  if (!existsSync(configPath)) {
    return unusable(CONFIG_CODES.MISSING_FILE, `没有找到 ${UPDATE_CONFIG_FILENAME}：打包时未写入发行地址，检查更新不可用`)
  }
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    return unusable(CONFIG_CODES.BAD_FILE, `${UPDATE_CONFIG_FILENAME} 读不出来：${error?.message ?? error}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return unusable(CONFIG_CODES.BAD_FILE, `${UPDATE_CONFIG_FILENAME} 必须是对象`)
  }

  const wanted = channel ?? raw.defaultChannel ?? 'stable'
  if (!RELEASE_CHANNELS.includes(wanted)) {
    return unusable(CONFIG_CODES.CHANNEL_NOT_CONFIGURED, `未知通道 ${JSON.stringify(wanted)}`)
  }
  const entry = raw.channels?.[wanted] ?? null
  if (entry === null || typeof entry !== 'object' || typeof entry.origin !== 'string') {
    return unusable(CONFIG_CODES.CHANNEL_NOT_CONFIGURED, `通道 ${wanted} 没有配置 origin`)
  }
  // ★ 测试用的 `allowInsecureHttp` 必须**写在配置里、按通道写**，而不是
  //   一个全局开关。全局开关的后果是"某次为 internal 打开它，
  //   stable 也跟着走 HTTP"。
  const insecure = entry.allowInsecureHttp === true || allowInsecureHttp === true
  const hostResult = createHostConfig({
    origin: entry.origin,
    prefix: typeof entry.prefix === 'string' ? entry.prefix : '/legion',
    channel: wanted,
    platform: entry.platform ?? 'win32',
    arch: entry.arch ?? 'x64',
    allowInsecureHttp: insecure,
  })
  if (!hostResult.ok) {
    return unusable(CONFIG_CODES.BAD_ORIGIN, hostResult.reason, { problems: hostResult.problems })
  }

  const trust = loadTrustStore(trustPath)
  const usable = trust.entries.length > 0
  return Object.freeze({
    ok: true,
    usable,
    code: usable ? null : CONFIG_CODES.NO_TRUST,
    reason: usable ? null : `没有可用的发布公钥：${trust.reason}`,
    channel: wanted,
    channels: Object.freeze(Object.keys(raw.channels ?? {}).sort()),
    host: hostResult.host,
    trustStore: trust.store,
    trustEntries: Object.freeze(trust.entries),
    trustSequence: trust.sequence,
    checkOnStartup: raw.checkOnStartup !== false,
    configPath,
    trustPath,
    problems: Object.freeze(trust.problems),
  })
}

/**
 * 读信任表。
 *
 * 空表不是错误（测试环境、还没发布的内部构建都会是空的），但它必须
 * 让配置**不可用**——一条"没有公钥但还是去检查更新"的路径要么在
 * 验签那里失败（浪费一次请求），要么更糟：某处把"无公钥"当成了"跳过验签"。
 */
export function loadTrustStore(path) {
  if (!existsSync(path)) {
    return Object.freeze({
      store: createTrustStore([]), entries: Object.freeze([]), sequence: 0,
      problems: Object.freeze([]), reason: `没有找到 ${UPDATE_TRUST_FILENAME}`,
    })
  }
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    return Object.freeze({
      store: createTrustStore([]), entries: Object.freeze([]), sequence: 0,
      problems: Object.freeze([]), reason: `${UPDATE_TRUST_FILENAME} 读不出来：${error?.message ?? error}`,
    })
  }
  const keys = Array.isArray(raw?.keys) ? raw.keys : []
  const store = createTrustStore(keys)
  const problems = [...store.problems]
  if (typeof raw?.sequence === 'number' && Number.isSafeInteger(raw.sequence) && raw.sequence >= 0) {
    // 序列号参与"信任表不能回退"的判定（envelope.mjs 的 applyTrustUpdate）。
  } else if (raw?.sequence !== undefined) {
    problems.push(`信任表 sequence 不合法：${JSON.stringify(raw.sequence)}`)
  }
  const sequence = Number.isSafeInteger(raw?.sequence) && raw.sequence >= 0 ? raw.sequence : 0
  return Object.freeze({
    store,
    entries: Object.freeze([...store.keys.values()]),
    sequence,
    problems: Object.freeze(problems),
    reason: store.size === 0 ? '信任表里没有可用的公钥' : null,
  })
}

function unusable(code, reason, extra = {}) {
  return Object.freeze({
    ok: false, usable: false, code, reason, channel: null, channels: Object.freeze([]),
    host: null, trustStore: null, trustEntries: Object.freeze([]), trustSequence: 0,
    checkOnStartup: false, configPath: null, trustPath: null, problems: Object.freeze([]), ...extra,
  })
}

/**
 * 生成一份配置文件的写法（发布/打包脚本用）。
 *
 * 保留在模块里而不是脚本里，是为了让"配置的读"与"配置的写"挨着——
 * 两边分家的时候，字段名漂移会在打包之后才被发现。
 */
export function buildUpdateConfig({ channels, defaultChannel = 'stable', checkOnStartup = true } = {}) {
  const out = {}
  for (const [channel, entry] of Object.entries(channels ?? {})) {
    if (!RELEASE_CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`)
    out[channel] = {
      origin: entry.origin,
      prefix: entry.prefix ?? '/legion',
      ...(entry.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
    }
  }
  return Object.freeze({ channels: out, defaultChannel, checkOnStartup })
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function selfCheckConfig() {
  const problems = []
  if (loadUpdateConfig({}).ok) problems.push('没有 installRoot 时配置被判为可用')
  if (loadUpdateConfig({ installRoot: 'C:\\definitely-missing-legion' }).code !== CONFIG_CODES.MISSING_FILE) {
    problems.push('缺配置文件时没有落到 update-config-missing')
  }
  const built = buildUpdateConfig({ channels: { stable: { origin: 'https://updates.example.com' } } })
  if (built.channels.stable.prefix !== '/legion') problems.push('默认 prefix 不是 /legion')
  if (built.defaultChannel !== 'stable') problems.push('默认通道不是 stable')
  let threw = false
  try { buildUpdateConfig({ channels: { nightly: { origin: 'https://x.example' } } }) } catch { threw = true }
  if (!threw) problems.push('未知通道在写配置时没有被拒绝')
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    filenames: Object.freeze({ config: UPDATE_CONFIG_FILENAME, trust: UPDATE_TRUST_FILENAME }),
  })
}

export const CONFIG_CHECKED = selfCheckConfig()
