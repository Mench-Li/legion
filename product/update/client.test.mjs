// product/update/client.test.mjs
// ============================================================================
// 更新客户端的端到端回归 —— 用**真签名、真摘要、真文件**驱动
//
// 这里的每个用例都对应设计里的一条判据。之所以不复用"构造一个假 client"的
// 写法，是因为本模块的风险全在**接线**上：协议件各自的单测都过，但
// "验签之后的摘要有没有比对"、"被拒的清单有没有抬高高水位"、
// "下载期间候选变了会不会静默换掉"这些问题只在把件装起来之后才存在。
//
// 用一个**在内存里跑的静态托管**（`createStaticHost`）来喂它：它按
// 设计 §4 的目录布局提供 feeds/releases，带正确的 Cache-Control，
// 也可以按用例注入故障（返回旧清单、改一个字节、返回 500）。
// ============================================================================

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createUpdateClient } from './client.mjs'
import { createTrustStore, generateReleaseKeyPair, serializeEnvelope, signEnvelope, ENVELOPE_FORMATS } from './envelope.mjs'
import { buildFeedPayload } from './feed.mjs'
import { buildRelease, artifactFromBytes } from './release.mjs'
import { createHostConfig } from './host.mjs'
import { FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL } from './host.mjs'
import { createHash } from 'node:crypto'

const ORIGIN = 'https://updates.example.com'
const NOW_MS = Date.parse('2026-10-04T12:00:00Z')
const CURRENT = '1.0.0'
const NEXT = '1.1.0'

/**
 * 一个内存静态托管：目录布局、Cache-Control、字节都由测试决定。
 * `mutate` 用来注入"托管被改动"的情形。
 */
function createStaticHost({
  keyId, privateKeyPem, packageBytes, notesBytes = Buffer.from('修复若干问题。\n', 'utf8'),
  mutate = null, slowChunks = 0,
}) {
  const productManifest = {
    format: 'legion/version-manifest@1',
    productVersion: NEXT,
    legionVersion: NEXT,
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    channel: 'stable',
  }
  const pkg = artifactFromBytes(`releases/rel-${NEXT}/legion-win-x64.zip`, packageBytes)
  const installer = artifactFromBytes(`releases/rel-${NEXT}/Legion-Setup-win-x64.exe`, Buffer.from('installer'))
  const notes = artifactFromBytes(`releases/rel-${NEXT}/notes.zh-CN.txt`, notesBytes)
  const release = buildRelease({
    releaseId: `rel-${NEXT}`,
    productVersion: NEXT,
    channel: 'stable',
    productManifest,
    supportedFromVersions: [CURRENT],
    minWindowsBuild: 19045,
    requiredFreeBytes: 2 * 1024 * 1024 * 1024,
    package: pkg,
    installer,
    notes,
    migrationPlanDigest: 'e'.repeat(64),
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-03T00:00:00Z',
    expiresAt: '2026-10-10T00:00:00Z',
  })
  const manifestBytes = Buffer.from(serializeEnvelope(signEnvelope(release, { privateKeyPem, keyId })), 'utf8')
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const feed = buildFeedPayload({
    channel: 'stable', platform: 'win32', arch: 'x64', sequence: 42,
    issuedAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z',
    releaseId: release.releaseId, productVersion: NEXT,
    manifestPath: `releases/rel-${NEXT}/manifest.json`, manifestSha256,
  })
  const feedBytes = Buffer.from(serializeEnvelope(signEnvelope(feed, { privateKeyPem, keyId })), 'utf8')

  const files = new Map([
    ['feeds/stable/win-x64.json', { bytes: feedBytes, cache: FEED_CACHE_CONTROL }],
    [`releases/rel-${NEXT}/manifest.json`, { bytes: manifestBytes, cache: RELEASE_CACHE_CONTROL }],
    [pkg.path, { bytes: packageBytes, cache: RELEASE_CACHE_CONTROL }],
    [installer.path, { bytes: Buffer.from('installer'), cache: RELEASE_CACHE_CONTROL }],
    [notes.path, { bytes: notesBytes, cache: RELEASE_CACHE_CONTROL }],
  ])

  const requests = []
  async function fetchImpl(url, options = {}) {
    requests.push({ url, options })
    const relative = url.slice(`${ORIGIN}/legion/`.length)
    let entry = files.get(relative)
    if (mutate !== null) entry = mutate(relative, entry, { feedBytes, manifestBytes, pkg, files }) ?? entry
    if (entry === null || entry === undefined) {
      return response(404, { 'cache-control': 'no-store' }, Buffer.alloc(0))
    }
    if (entry.status !== undefined && entry.status !== 200) {
      return response(entry.status, entry.headers ?? { 'cache-control': 'no-store' }, entry.bytes ?? Buffer.alloc(0))
    }
    // `slowChunks > 0`：把包分块慢慢吐，给"取消"一个**真实的**时间窗口。
    // 否则一个同步吐完的替身会让取消测试变成"永远取消不到"。
    if (slowChunks > 0 && relative === pkg.path) {
      return responseSlow(entry.bytes, slowChunks, options.signal)
    }
    return response(200, { 'cache-control': entry.cache ?? RELEASE_CACHE_CONTROL, 'content-length': String(entry.bytes.length) }, entry.bytes)
  }
  fetchImpl.requests = requests
  fetchImpl.files = files
  fetchImpl.release = release
  fetchImpl.manifestSha256 = manifestSha256
  fetchImpl.feed = feed
  return fetchImpl
}

function response(status, headers, bytes) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    body: Readable.from(bytes.length === 0 ? [] : [bytes]),
  }
}

/**
 * 分块、带小延时的响应体：给取消/进度一个真实的时间窗口。
 *
 * ★ 必须**响应 abort signal**。真实的 `fetch` 会在 signal 触发时让 body
 *   的迭代以一个 `AbortError` 结束；一个忽略它的替身会让"取消下载"这条
 *   测试变成永远取消不到——而那是替身的缺陷，不是实现的。
 */
function responseSlow(bytes, chunks, signal = null) {
  const size = Math.max(1, Math.ceil(bytes.length / chunks))
  const pieces = []
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size))
  async function* generator() {
    for (const piece of pieces) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      yield piece
    }
  }
  return {
    status: 200,
    headers: { entries: () => [['cache-control', RELEASE_CACHE_CONTROL], ['content-length', String(bytes.length)]] },
    body: Readable.from(generator()),
  }
}

function makeConfig() {
  const hostResult = createHostConfig({ origin: ORIGIN, prefix: '/legion', channel: 'stable' })
  assert.equal(hostResult.ok, true, hostResult.reason)
  return hostResult.host
}

function makeClient({
  fetchImpl, cacheDir, installRootUnused = null, configOverrides = {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  void installRootUnused
  return createUpdateClient({
    config: {
      ok: true, usable: true, code: null, reason: null, channel: 'stable',
      host: fetchImpl.host ?? makeConfig(),
      trustStore: fetchImpl.trustStore,
      trustEntries: [], trustSequence: 1, checkOnStartup: true,
      ...configOverrides,
    },
    cacheDir,
    currentVersion: CURRENT,
    fetchImpl,
    now: () => NOW_MS,
    // ★ 计时器可注入：`checkOnStartup` 那条判据的**可观测结果**正是
    //   "有没有安排定时器"，而真实的 `setTimeout` 让那件事看不见
    //   （它不会失败，只会安静地什么都不做）。
    setTimer,
    clearTimer,
  })
}

function setup({ mutate = null, packageBytes = Buffer.from('PK\u0003\u0004 pretend zip payload'), slowChunks = 0 } = {}) {
  const keyId = 'release-2026-a'
  const keys = generateReleaseKeyPair({ keyId })
  const trustStore = createTrustStore([{ keyId, publicKeyPem: keys.publicKeyPem }])
  const fetchImpl = createStaticHost({ keyId, privateKeyPem: keys.privateKeyPem, packageBytes, mutate, slowChunks })
  fetchImpl.trustStore = trustStore
  const cacheDir = mkdtempSync(join(tmpdir(), 'legion-update-test-'))
  return { fetchImpl, cacheDir, keys, trustStore }
}

// ---------------------------------------------------------------------------
// ① 正常路径
// ---------------------------------------------------------------------------

test('检查更新：合法签名 → 发现候选，且候选身份带发行摘要', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)

  const result = await client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'available', result.reason)
  assert.equal(client.state(), 'available')
  assert.equal(result.candidate.releaseId, `rel-${NEXT}`)
  assert.equal(result.candidate.productVersion, NEXT)
  // ★ 身份必须包含**字节摘要**，不是只有 releaseId（设计 §6 line 138）。
  assert.equal(result.candidate.manifestSha256, ctx.fetchImpl.manifestSha256)
  assert.equal(client.snapshot().currentVersion, CURRENT)
})

test('下载更新：字节完整 + 摘要一致 → 就绪，且不再有 .part 残留', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  assert.equal(check.outcome, 'available', check.reason)

  const progress = []
  const result = await client.download(check.candidate.releaseId, check.candidate.manifestSha256, {
    onProgress: (p) => progress.push(p.bytes),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.reused, false)
  assert.equal(client.state(), 'ready')
  assert.ok(progress.length >= 1, '下载过程中没有回报任何进度')
  assert.equal(progress.at(-1), ctx.fetchImpl.release.package.sizeBytes)
  assert.equal(readFileSync(result.path).length, ctx.fetchImpl.release.package.sizeBytes)
})

test('重启后复用缓存：重新校验摘要而不是直接相信文件', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const first = makeClient(ctx)
  const check = await first.check()
  const downloaded = await first.download(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(downloaded.ok, true, downloaded.reason)

  // 新的 client（模拟重启）在同一个缓存目录上再走一遍。
  const second = makeClient(ctx)
  const recheck = await second.check()
  const reused = await second.download(recheck.candidate.releaseId, recheck.candidate.manifestSha256)
  assert.equal(reused.ok, true, reused.reason)
  assert.equal(reused.reused, true, '重启后没有复用已就绪的缓存')
  assert.equal(second.state(), 'ready')
})

test('复用前先校验：缓存文件被改动过就必须重新下载', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const first = makeClient(ctx)
  const check = await first.check()
  const downloaded = await first.download(check.candidate.releaseId, check.candidate.manifestSha256)
  // 篡改缓存文件：一个不校验就直接复用的实现会把它当成好的。
  writeFileSync(downloaded.path, Buffer.from('tampered'), 'utf8')

  const second = makeClient(ctx)
  const recheck = await second.check()
  const again = await second.download(recheck.candidate.releaseId, recheck.candidate.manifestSha256)
  assert.equal(again.ok, true, again.reason)
  assert.equal(again.reused, false, '被篡改的缓存被当成好的复用了')
  assert.equal(readFileSync(again.path).length, ctx.fetchImpl.release.package.sizeBytes)
})

// ---------------------------------------------------------------------------
// ② 拒绝路径：签名的四类改写
// ---------------------------------------------------------------------------

test('摘要不符：通道说 A、发行清单是另一份合法签名的清单 → 拒绝', async (t) => {
  const ctx = setup({
    // 把通道清单里的摘要改掉一个字符，再用**同一把钥匙**重新签。
    // 这正是"两份清单各自都合法、组合起来不是发布方意思"的情形。
    mutate(relative, entry, { feedBytes }) {
      if (relative !== 'feeds/stable/win-x64.json') return entry
      return null
    },
  })
  // 直接构造：先拿到合法 feed，篡改 payload 之后重签。
  const keyId = 'release-2026-a'
  const keys = ctx.keys
  const tampered = { ...ctx.fetchImpl.feed, manifestSha256: 'f'.repeat(64) }
  const tamperedBytes = Buffer.from(serializeEnvelope(signEnvelope(tampered, {
    privateKeyPem: keys.privateKeyPem, keyId,
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes: tamperedBytes, cache: FEED_CACHE_CONTROL })

  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'update-manifest-digest-mismatch', result.reason)
})

test('未知密钥：签名合法但 keyId 不在信任表里 → 拒绝（不退化成放行）', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const other = generateReleaseKeyPair({ keyId: 'ghost' })
  const ghostBytes = Buffer.from(serializeEnvelope(signEnvelope(ctx.fetchImpl.feed, {
    privateKeyPem: other.privateKeyPem, keyId: 'ghost',
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes: ghostBytes, cache: FEED_CACHE_CONTROL })

  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'envelope-unknown-key', result.reason)
  assert.equal(client.state(), 'check-failed')
})

test('过期清单：不授权新的下载', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const { keyId } = { keyId: 'release-2026-a' }
  const expired = { ...ctx.fetchImpl.feed, expiresAt: '2026-10-01T00:00:00Z', issuedAt: '2026-09-20T00:00:00Z' }
  const bytes = Buffer.from(serializeEnvelope(signEnvelope(expired, {
    privateKeyPem: ctx.keys.privateKeyPem, keyId,
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes, cache: FEED_CACHE_CONTROL })

  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'envelope-expired', result.reason)
})

test('sequence 回退：托管被改回旧清单 → 拒绝，且高水位不被降低', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const first = await client.check()
  assert.equal(first.outcome, 'available', first.reason)

  // 同一目录、新 client（模拟重启）：托管这回给出 sequence=41 的清单。
  const lower = { ...ctx.fetchImpl.feed, sequence: 41 }
  const bytes = Buffer.from(serializeEnvelope(signEnvelope(lower, {
    privateKeyPem: ctx.keys.privateKeyPem, keyId: 'release-2026-a',
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes, cache: FEED_CACHE_CONTROL })

  const second = makeClient(ctx)
  const result = await second.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'feed-sequence-regression', result.reason)

  // 高水位必须仍然是 42。
  const state = JSON.parse(readFileSync(join(ctx.cacheDir, 'channel-sequence.json'), 'utf8'))
  assert.equal(state.entries['stable/win32-x64'].sequence, 42)
})

test('被拒的清单不能抬高 sequence 高水位', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  // 通道清单声明一个**不存在**的 manifestPath 对应的 releaseId，
  // 于是它在第 2 步（取发行清单）就 404 —— 但 sequence 是 99。
  const bad = { ...ctx.fetchImpl.feed, sequence: 99, releaseId: 'rel-does-not-exist' }
  bad.manifestPath = 'releases/rel-does-not-exist/manifest.json'
  const bytes = Buffer.from(serializeEnvelope(signEnvelope(bad, {
    privateKeyPem: ctx.keys.privateKeyPem, keyId: 'release-2026-a',
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes, cache: FEED_CACHE_CONTROL })

  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  // 高水位文件不存在或还没有 99 —— 两种都可以，但**不能**是 99。
  let recorded = null
  try { recorded = JSON.parse(readFileSync(join(ctx.cacheDir, 'channel-sequence.json'), 'utf8')).entries?.['stable/win32-x64']?.sequence ?? null } catch { recorded = null }
  assert.notEqual(recorded, 99, '一次失败的检查把高水位抬到了 99')
})

test('撤回清单：更高 sequence 指向更旧版本 → 接受清单但不提供降级', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const older = { ...ctx.fetchImpl.feed, sequence: 43, productVersion: '0.9.0', releaseId: 'rel-0.9.0' }
  older.manifestPath = 'releases/rel-0.9.0/manifest.json'
  const bytes = Buffer.from(serializeEnvelope(signEnvelope(older, {
    privateKeyPem: ctx.keys.privateKeyPem, keyId: 'release-2026-a',
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes, cache: FEED_CACHE_CONTROL })

  const client = makeClient(ctx)
  // 发行清单不存在 → 这一步会失败（本地没有 rel-0.9.0 的清单）。
  // 关键是：**不能**出现一个可安装的降级候选。
  const result = await client.check()
  assert.notEqual(result.outcome, 'available')
  assert.equal(client.candidate(), null)
})

// ---------------------------------------------------------------------------
// ③ 包被替换 / 平台不符
// ---------------------------------------------------------------------------

test('包被替换：下载到的字节与清单摘要不符 → 停止且不提交', async (t) => {
  const ctx = setup({
    mutate(relative, entry, { pkg }) {
      if (relative !== pkg.path) return entry
      return { bytes: Buffer.from('PK\u0003\u0004 replaced payload!!'), cache: RELEASE_CACHE_CONTROL, status: 200 }
    },
  })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  assert.equal(check.outcome, 'available', check.reason)
  const result = await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(result.ok, false)
  assert.ok(['net-digest-mismatch', 'net-too-large', 'net-too-small'].includes(result.code), `意外的错误码 ${result.code}`)
  assert.equal(client.state(), 'download-failed')
  // `.part` 必须被清掉：留着它会让下次"看起来有东西"。
  const sweep = client.cache.sweepStaleParts()
  assert.equal(sweep.removed.length, 0, `失败之后留下了 ${sweep.removed.length} 个 .part 文件`)
})

test('平台不符：清单给的是 darwin → 拒绝', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const wrong = { ...ctx.fetchImpl.feed, platform: 'darwin' }
  const bytes = Buffer.from(serializeEnvelope(signEnvelope(wrong, {
    privateKeyPem: ctx.keys.privateKeyPem, keyId: 'release-2026-a',
  })), 'utf8')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { bytes, cache: FEED_CACHE_CONTROL })
  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
})

// ---------------------------------------------------------------------------
// ④ 设计 §8 line 166：检查失败不能覆盖已准备好的状态
// ---------------------------------------------------------------------------

test('★ 下载中遇到检查失败：主状态与候选都不受影响', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  assert.equal(client.state(), 'available')

  // 让下一次检查失败：把通道清单换成 500。
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { status: 500, bytes: Buffer.alloc(0) })
  const failed = await client.check()
  assert.equal(failed.outcome, 'failed')

  // ★ 关键断言：状态**没有**变成 check-failed，候选也还在。
  assert.equal(client.state(), 'available', '检查失败覆盖了已经准备好的更新状态')
  assert.equal(client.candidate().releaseId, `rel-${NEXT}`)
  // 但错误必须被记下来（否则界面上完全没有痕迹）。
  assert.equal(client.snapshot().lastError?.code, 'net-http-status')
})

test('★ 更新就绪之后检查失败：状态保持 ready，且仍可安装', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(client.state(), 'ready')
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', { status: 503, bytes: Buffer.alloc(0) })
  await client.check()
  assert.equal(client.state(), 'ready', '就绪状态被一次失败的检查覆盖了')
  assert.notEqual(client.ready(), null)
})

// ---------------------------------------------------------------------------
// ⑤ 身份绑定与"发布端变更清单不替换已下载目标"
// ---------------------------------------------------------------------------

test('身份不符：用另一个候选的 releaseId 下载 → 拒绝', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  const result = await client.download('rel-something-else', check.candidate.manifestSha256)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'update-identity-mismatch', result.reason)
})

test('摘要不符的身份也不能复用已就绪的包', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  const installed = await client.install(check.candidate.releaseId, 'f'.repeat(64))
  assert.equal(installed.ok, false)
  assert.equal(installed.code, 'update-identity-mismatch', installed.reason)
})

// ---------------------------------------------------------------------------
// ⑥ 取消
// ---------------------------------------------------------------------------

test('取消下载：状态落到 cancelled，不是 failed（不该进失败退避）', async (t) => {
  const ctx = setup({ slowChunks: 8, packageBytes: Buffer.alloc(64 * 1024, 7) })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  const pending = client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  // 等到取消窗口真的存在（包在慢慢吐）。
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.state(), 'downloading', '下载没有进入 downloading 状态')
  const cancelled = client.cancelDownload(client.snapshot().operationId)
  assert.equal(cancelled.ok, true, cancelled.reason)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'update-cancelled', result.reason)
  assert.equal(client.state(), 'cancelled')
  // ★ 取消不是失败：它不该让下一次检查被退避推远。
  assert.equal(client.scheduler.snapshot().consecutiveFailures, 0)
  // 取消之后没有 .part 残留。
  const sweep = client.cache.sweepStaleParts()
  assert.equal(sweep.removed.length, 0, `取消之后留下了 ${sweep.removed.length} 个 .part 文件`)
})

test('取消一个不存在的操作：明确拒绝而不是静默成功', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const result = client.cancelDownload(1)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'update-no-download')
})

// ---------------------------------------------------------------------------
// ⑦ 离线 / 超时 / 缓存头
// ---------------------------------------------------------------------------

test('离线：检查失败但状态可恢复，且文案可读', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const offline = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }
  offline.trustStore = ctx.trustStore
  const client = createUpdateClient({
    config: {
      ok: true, usable: true, channel: 'stable', host: makeConfig(),
      trustStore: ctx.trustStore, trustEntries: [], trustSequence: 1,
    },
    cacheDir: ctx.cacheDir, currentVersion: CURRENT, fetchImpl: offline, now: () => NOW_MS,
  })
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'net-offline')
  assert.match(result.reason, /网络/)
  assert.equal(client.state(), 'check-failed')
})

test('缓存策略不符合要求 → 拒绝（而不是接受一个会被缓存的通道清单）', async (t) => {
  const ctx = setup({
    mutate(relative, entry) {
      if (relative !== 'feeds/stable/win-x64.json') return entry
      return { ...entry, cache: 'public, max-age=600' }
    },
  })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'net-http-status', result.reason)
  assert.match(result.reason, /no-store/)
})

test('配置不可用：明确说明原因，且不发出任何请求', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = createUpdateClient({
    config: {
      ok: false, usable: false, code: 'update-config-missing',
      reason: '没有找到 product/release/update-config.json',
      channel: null, host: null, trustStore: null, trustEntries: [], trustSequence: 0,
    },
    cacheDir: ctx.cacheDir, currentVersion: CURRENT, fetchImpl: ctx.fetchImpl, now: () => NOW_MS,
  })
  const result = await client.check()
  assert.equal(result.outcome, 'failed')
  assert.equal(result.code, 'update-config-missing')
  assert.equal(ctx.fetchImpl.requests.length, 0, '配置不可用时仍然发出了请求')
})

// ---------------------------------------------------------------------------
// ⑧ 提醒节奏（设计 §7 line 146）
// ---------------------------------------------------------------------------

test('稍后：24 小时内不重复主动提醒，但候选仍然可见', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  await client.check()
  assert.equal(client.shouldNotify(), true)
  const snoozed = client.snooze()
  assert.equal(snoozed.ok, true)
  assert.equal(client.shouldNotify(), false)
  // ★ 状态与候选**不变**：稍后只收起提醒，设置页仍可见（设计 §7 line 146）。
  assert.equal(client.state(), 'available')
  assert.equal(client.candidate().releaseId, `rel-${NEXT}`)
  // 24 小时之后恢复提醒。
  const later = createUpdateClient({
    config: {
      ok: true, usable: true, channel: 'stable', host: makeConfig(),
      trustStore: ctx.trustStore, trustEntries: [], trustSequence: 1,
    },
    cacheDir: ctx.cacheDir, currentVersion: CURRENT, fetchImpl: ctx.fetchImpl,
    now: () => NOW_MS + 25 * 60 * 60 * 1000,
  })
  await later.check()
  assert.equal(later.shouldNotify(), true)
})

// ---------------------------------------------------------------------------
// ⑨ 安装未接线时的行为
// ---------------------------------------------------------------------------

test('安装事务未接线：明确返回未接线，而不是假装成功', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const check = await client.check()
  await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  const result = await client.install(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'update-install-not-wired')
  assert.equal(client.state(), 'ready', '安装未接线不应改变就绪状态')
})

test('安装事务接线后：按阶段驱动状态机，提交落到 committed', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const stages = []
  const installerCalls = []
  const installer = {
    async install(args) {
      installerCalls.push(args)
      const { onStage, identity } = args
      for (const stage of ['waiting-for-tasks', 'preparing', 'installing', 'validating', 'committed']) {
        stages.push(stage)
        onStage(stage)
      }
      return { ok: true, code: null, reason: null, identity, reachedStage: 'committed' }
    },
  }
  const client = createUpdateClient({
    config: {
      ok: true, usable: true, channel: 'stable', host: makeConfig(),
      trustStore: ctx.trustStore, trustEntries: [], trustSequence: 1,
    },
    cacheDir: ctx.cacheDir, currentVersion: CURRENT, fetchImpl: ctx.fetchImpl,
    now: () => NOW_MS, installer,
  })
  const check = await client.check()
  await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  // ★ 不传在途任务读数：`install` **没有**这个参数（见 `client.mjs` 的注释——
  //   那个读数必须由主进程在按下安装的那一刻自己去读，不能由调用方提供）。
  const result = await client.install(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(result.ok, true, result.reason)
  assert.deepEqual(stages, ['waiting-for-tasks', 'preparing', 'installing', 'validating', 'committed'])
  assert.equal(client.state(), 'committed')
  // 而 installer 收到的入参里没有任务读数（透传那条路已经不存在了）。
  assert.equal('pendingTasks' in installerCalls.at(-1),
    false, 'install 把任务读数透传给了安装事务：那意味着调用方能决定预检的结论')
})

test('安装事务失败在切换后：落到 rolled-back / recovery-required', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const installer = {
    async install({ onStage }) {
      onStage('waiting-for-tasks'); onStage('preparing'); onStage('installing'); onStage('validating')
      onStage('rolled-back')
      return { ok: false, code: 'update-install-failed', reason: '健康检查失败，已回退', reachedStage: 'rolled-back' }
    },
  }
  const client = createUpdateClient({
    config: {
      ok: true, usable: true, channel: 'stable', host: makeConfig(),
      trustStore: ctx.trustStore, trustEntries: [], trustSequence: 1,
    },
    cacheDir: ctx.cacheDir, currentVersion: CURRENT, fetchImpl: ctx.fetchImpl,
    now: () => NOW_MS, installer,
  })
  const check = await client.check()
  await client.download(check.candidate.releaseId, check.candidate.manifestSha256)
  const result = await client.install(check.candidate.releaseId, check.candidate.manifestSha256)
  assert.equal(result.ok, false)
  assert.equal(client.state(), 'rolled-back')
})

// ---------------------------------------------------------------------------
// ⑩ 同一时刻只有一次网络请求
// ---------------------------------------------------------------------------

test('并发检查共享一次请求：托管只被问了一次通道清单', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const [a, b, c] = await Promise.all([client.check(), client.check(), client.check()])
  assert.equal(a.outcome, 'available')
  assert.equal(b.outcome, 'available')
  assert.equal(c.outcome, 'available')
  assert.equal(b.shared, true)
  const feedRequests = ctx.fetchImpl.requests.filter((r) => r.url.endsWith('feeds/stable/win-x64.json'))
  assert.equal(feedRequests.length, 1, `通道清单被请求了 ${feedRequests.length} 次`)
})

// ---------------------------------------------------------------------------
// ★ 配置里的 checkOnStartup 必须**真的**被消费
// ---------------------------------------------------------------------------

test('★★★ checkOnStartup:false 时**不**自动检查；手动检查照常', async (t) => {
  // 这个键在 `config.mjs` 的 JSON 示例里是**文档化**的，而在此之前全仓
  // 没有消费者：`markInteractive()` 照样安排首次检查、周期检查照样每 6 小时
  // 发一次网络请求。也就是"关掉自动检查"被静默忽略，而用户会以为它生效了。
  //
  //   > 一个被静默忽略的"关闭"开关，与一个不存在的关闭开关，
  //   > 对用户来说是同一件事——只不过前者让用户以为自己是安全的。
  //
  // ★ 断言走**客户端**这一层，而不是直接调 `createCheckScheduler`：
  //   缺陷的位置是"配置到调度器之间没有接线"，只测调度器会把那一段漏掉。
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const scheduled = []
  const client = makeClient({
    ...ctx,
    configOverrides: { checkOnStartup: false },
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; scheduled.push(timer); return timer },
    clearTimer: () => {},
  })

  const snap = client.markInteractive()
  assert.equal(scheduled.length, 0, '配置关掉了自动检查，却仍然安排了定时器')
  assert.equal(snap.automatic, false, '调度器读数没有反映出"自动检查已关闭"')
  assert.equal(snap.dueReason, '自动检查已关闭')
  // 唤醒补检也不该安排任何东西。
  assert.equal(client.notifyResume().due, false)
  assert.equal(scheduled.length, 0)
  // ★ 手动检查**不受影响**：关掉自动检查不是"这个功能不能用了"。
  const manual = await client.check({ trigger: 'manual' })
  assert.equal(manual.outcome, 'available', manual.reason)
  assert.equal(scheduled.length, 0, '手动检查之后又安排了自动定时器')
})

test('★ checkOnStartup 开启（默认）时照常安排首次检查', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const scheduled = []
  const client = makeClient({
    ...ctx,
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; scheduled.push(timer); return timer },
    clearTimer: () => {},
  })
  const snap = client.markInteractive()
  assert.equal(scheduled.length, 1, '默认（开启）时没有安排首次检查')
  assert.equal(snap.automatic, true)
  // 首次延迟落在设计 §6 line 132 的 30～90 秒里。
  assert.ok(scheduled[0].ms >= 30_000 && scheduled[0].ms <= 90_000, `首次延迟 ${scheduled[0].ms} 越界`)
})