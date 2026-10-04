#!/usr/bin/env node
// scripts/update/verify-host.mjs —— 公网回读核对（设计 §9 第 3、5 步）
// ============================================================================
// 设计 §9 第 3 步：「生成并签名发行清单，上传全部不可变发布文件，
// **公开回读验证字节与签名**。」
// 第 5 步：「从公网回读通道清单并用真实旧客户端检查、下载、安装；保留审计记录。」
//
// 这个脚本做的是"公开回读"那一半，而且刻意走**与客户端完全相同的代码**
// （`product/update` 的 transport / envelope / feed）：如果只用别的方式
// 校验，那么"我上传的东西客户端能不能验过"就仍然是一个未验证的假设——
// 而它恰恰是这一步要回答的问题。
//
// 另外它还核**缓存头**（设计 §4 line 79）：通道清单必须 `no-store`，
// 发行文件必须可长期缓存。这条命令由托管方执行，而客户端唯一能做的是核；
// 不核的话，一个把通道清单配成可缓存的 CDN 会让用户"明明发布了新版却看不到"。
//
// 用法：
//   node scripts/update/verify-host.mjs --origin https://updates.example.com --prefix /legion \
//     --channel stable --trust ./product/release/update-trust.json
//
//   测试部署（HTTP 需显式声明）：
//   node scripts/update/verify-host.mjs --origin http://117.72.146.36 --prefix /test/legion \
//     --channel internal --allow-insecure-http --trust ./product/release/update-trust.json
//
// 退出码：0 = 全部通过；1 = 有检查未通过；2 = 用法错误。
// ============================================================================

import { readFileSync } from 'node:fs'

import { createHostConfig, evaluateResponse, feedUrl, releaseManifestUrl } from '../../product/update/host.mjs'
import { createTransport } from '../../product/update/transport.mjs'
import { ENVELOPE_FORMATS, createTrustStore, verifyEnvelope } from '../../product/update/envelope.mjs'
import { validateFeedPayload, judgeSequence, emptySequenceState, selectCandidate } from '../../product/update/feed.mjs'
import { validateRelease } from '../../product/update/release.mjs'
import { loadTrustStore } from '../../product/update/config.mjs'
import { sha256Hex } from '../../product/update/canonical.mjs'

export const VERIFY_FORMAT = 'legion/update-verify-host@1'

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

/**
 * 跑一次回读核对。
 *
 * @param {object} args
 * @param {string} args.origin
 * @param {string} args.prefix
 * @param {string} args.channel
 * @param {object} args.trustStore
 * @param {string|null} [args.expectReleaseId]
 * @param {number|null} [args.expectSequence]
 * @param {Function} [args.fetchImpl]
 * @param {Function} [args.now]
 */
export async function verifyHost({
  origin, prefix = '/legion', channel, platform = 'win32', arch = 'x64',
  trustStore, expectReleaseId = null, expectSequence = null,
  allowInsecureHttp = false, fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  const checks = []
  const check = (name, ok, detail = null) => {
    checks.push(Object.freeze({ name, ok: ok === true, detail }))
    return ok === true
  }

  const hostResult = createHostConfig({ origin, prefix, channel, platform, arch, allowInsecureHttp })
  if (!check('host-config', hostResult.ok, hostResult.ok ? `${hostResult.host.origin}${hostResult.host.prefix}（${hostResult.host.production ? '生产 HTTPS' : '测试 HTTP'}）` : hostResult.reason)) {
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed: null, release: null })
  }
  const host = hostResult.host
  const transport = createTransport({ fetchImpl, now })

  // —— ① 通道清单：回读、验签、缓存头、schema ——
  const url = feedUrl(host)
  const relative = url.slice(`${host.origin}${host.prefix}/`.length)
  const fetched = await transport.fetchBytes(host, url, { relativePath: relative })
  if (!fetched.ok) {
    // ★ `transport` 在缓存策略不符时会在**返回字节之前**就拒（见 host.mjs 的
    //   `evaluateResponse`）。那条拒绝本身就是"缓存策略"的结论，所以把它记到
    //   `feed-cache-policy` 上，而不是只留一句笼统的取件失败——否则一个
    //   "通道清单被配置成可缓存"的部署在报告里看起来像"服务器不可达"。
    if (/Cache-Control|no-store|immutable/i.test(fetched.reason ?? '')) {
      check('feed-cache-policy', false, fetched.reason)
    }
    check('feed-fetch', false, fetched.reason)
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed: null, release: null, url })
  }
  // 缓存头单独再核一次（transport 已经拒过一次，这里把结论记下来）。
  const cachePolicy = evaluateResponse(relative, {
    status: fetched.status, headers: fetched.headers,
  })
  check('feed-cache-policy', cachePolicy.ok,
    cachePolicy.ok ? fetched.headers['cache-control'] : cachePolicy.problems.map((p) => p.message).join('；'))

  const verifiedFeed = verifyEnvelope(fetched.body, { trust: trustStore, nowMs: now(), expectedFormat: ENVELOPE_FORMATS.FEED })
  if (!check('feed-signature', verifiedFeed.ok, verifiedFeed.ok ? `keyId=${verifiedFeed.keyId}` : `${verifiedFeed.code} ${verifiedFeed.reason}`)) {
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed: null, release: null, url, feedDigest: sha256Hex(fetched.body) })
  }
  const feedValidation = validateFeedPayload(verifiedFeed.payload, { channel, platform, arch })
  if (!check('feed-schema', feedValidation.ok, feedValidation.ok ? `sequence=${feedValidation.feed.sequence}` : feedValidation.reason)) {
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed: null, release: null, url, feedDigest: sha256Hex(fetched.body) })
  }
  const feed = feedValidation.feed

  if (expectReleaseId !== null) {
    check('feed-release-id', feed.releaseId === expectReleaseId, `通道指向 ${feed.releaseId}，期望 ${expectReleaseId}`)
  }
  if (expectSequence !== null) {
    // 用与客户端**同一套**高水位判据核"通道推进到了预期的序号"。
    const judgement = judgeSequence(emptySequenceState(), feed)
    check('feed-sequence', judgement.accept && feed.sequence === expectSequence,
      `通道 sequence=${feed.sequence}（${judgement.code}），期望 ${expectSequence}`)
  }

  // —— ② 发行清单：回读、摘要逐字节比对、验签、schema ——
  const manifestUrl = releaseManifestUrl(host, feed.releaseId)
  const manifestRelative = `releases/${feed.releaseId}/manifest.json`
  const fetchedManifest = await transport.fetchBytes(host, manifestUrl, { relativePath: manifestRelative })
  if (!check('release-fetch', fetchedManifest.ok, fetchedManifest.ok ? `${fetchedManifest.bytes} 字节` : fetchedManifest.reason)) {
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed, release: null, url, feedDigest: sha256Hex(fetched.body) })
  }
  // ★ 这一条是"上传的字节与通道声明的字节是同一个"的**唯一**证据。
  const manifestDigest = sha256Hex(fetchedManifest.body)
  check('release-digest', manifestDigest === feed.manifestSha256,
    `通道声明 ${feed.manifestSha256.slice(0, 16)}…，回读得到 ${manifestDigest.slice(0, 16)}…`)

  const verifiedManifest = verifyEnvelope(fetchedManifest.body, { trust: trustStore, nowMs: now(), expectedFormat: ENVELOPE_FORMATS.RELEASE })
  if (!check('release-signature', verifiedManifest.ok, verifiedManifest.ok ? `keyId=${verifiedManifest.keyId}` : `${verifiedManifest.code} ${verifiedManifest.reason}`)) {
    return Object.freeze({ ok: false, checks: Object.freeze(checks), feed, release: null, url, feedDigest: sha256Hex(fetched.body) })
  }
  const releaseValidation = validateRelease(verifiedManifest.payload, {
    expect: { releaseId: feed.releaseId, productVersion: feed.productVersion, channel: feed.channel, platform: feed.platform, arch: feed.arch },
  })
  check('release-schema', releaseValidation.ok, releaseValidation.ok ? null : releaseValidation.reason)
  const release = releaseValidation.release

  // —— ③ 产物：只回读**前 4 KiB** 核可达性与大小，不整包下载 ——
  //
  // 完整下载属于"真实旧客户端检查/下载/安装"那一步（设计 §9 第 5 步），
  // 而它需要一个真实的旧版本环境。这里回答的是"发布之后这些地址能不能取到"。
  if (release !== null) {
    for (const kind of ['package', 'installer', 'notes']) {
      const artifact = release[kind]
      if (artifact === null || artifact === undefined) { check(`artifact-${kind}`, false, '清单里没有这个产物'); continue }
      const artifactPath = `${host.origin}${host.prefix}/${artifact.path}`
      const head = await transport.fetchBytes(host, artifactPath, {
        relativePath: artifact.path, maxBytes: 4096, overallMs: transport.manifestTimeoutMs,
      })
      if (head.ok) {
        check(`artifact-${kind}`, true, `${artifact.path} 可达（${artifact.sizeBytes} 字节声明）`)
      } else if (head.code === 'net-too-large') {
        // 限长中止 = 文件比 4 KiB 大 = 可达且大小合理。
        check(`artifact-${kind}`, true, `${artifact.path} 可达（大于 4 KiB 探测窗口）`)
      } else {
        check(`artifact-${kind}`, false, `${artifact.path}：${head.reason}`)
      }
    }
  }

  // —— ④ 候选选择口径与客户端一致 ——
  if (release !== null && expectSequence !== null) {
    const candidate = selectCandidate({ feed, currentVersion: null })
    check('candidate-shape', candidate.verdict === 'unknown-current', `不知道本机版本时返回 ${candidate.verdict}`)
  }

  return Object.freeze({
    format: VERIFY_FORMAT,
    ok: checks.every((item) => item.ok),
    checks: Object.freeze(checks),
    feed,
    release,
    url,
    feedDigest: sha256Hex(fetched.body),
    releaseDigest: manifestDigest,
  })
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const origin = args.get('origin')
  if (typeof origin !== 'string' || origin === 'true') {
    process.stderr.write('verify-host 需要 --origin\n')
    return 2
  }
  const trustPath = args.get('trust')
  let trustStore
  if (typeof trustPath === 'string' && trustPath !== 'true') {
    const loaded = loadTrustStore(trustPath)
    trustStore = loaded.store
    if (loaded.entries.length === 0) {
      process.stderr.write(`信任表里没有可用公钥：${trustPath}（${loaded.reason ?? ''}）\n`)
      return 2
    }
  } else {
    trustStore = createTrustStore([])
  }

  return verifyHost({
    origin,
    prefix: args.get('prefix') ?? '/legion',
    channel: args.get('channel') ?? 'stable',
    allowInsecureHttp: args.get('allow-insecure-http') === 'true',
    trustStore,
    expectReleaseId: typeof args.get('expect-release-id') === 'string' && args.get('expect-release-id') !== 'true' ? args.get('expect-release-id') : null,
    expectSequence: args.get('expect-sequence') !== undefined && args.get('expect-sequence') !== 'true' ? Number(args.get('expect-sequence')) : null,
  }).then((result) => {
    for (const item of result.checks) {
      process.stdout.write(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail === null ? '' : `  ${item.detail}`}\n`)
    }
    if (result.feed !== null) {
      process.stdout.write(`${JSON.stringify({
        sequence: result.feed.sequence, releaseId: result.feed.releaseId, productVersion: result.feed.productVersion,
        feedDigest: result.feedDigest, releaseDigest: result.releaseDigest ?? null,
      }, null, 2)}\n`)
    }
    return result.ok ? 0 : 1
  }).catch((error) => {
    process.stderr.write(`回读核对失败：${error?.message ?? error}\n`)
    return 1
  })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) main().then((code) => { process.exitCode = code })
