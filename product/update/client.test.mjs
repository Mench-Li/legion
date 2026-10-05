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
  // ★ 让夹具能装出**第二个**发行（默认仍是 `NEXT`）。
  //   需要它是因为"稍后只对同一个发行生效"这条判据的正确性，只有在
  //   **同一个客户端**前后看到两个**不同**发行时才看得出来——而一个只会
  //   产出同一个发行的夹具，恰好在那件事上什么也证明不了（见 ㉗ 的用例）。
  productVersion = NEXT,
  releaseId = `rel-${productVersion}`,
  // ★ 通道 sequence 也要能调：第二个发行必须用**更高**的 sequence，
  //   否则 `judgeSequence` 会以"同 sequence 换摘要"把它拒掉（那条判据是对的）。
  sequence = 42,
  // ★ 让夹具能造出"两份清单对不上"的情形（设计 §5 line 114）。
  //   为什么需要**两份**覆盖：改发行清单验证的是"签名的清单自称属于别的通道"，
  //   改通道清单验证的是"托管上那份清单写着别的版本"。两者的拦截者可能不同
  //   （见 `client.test.mjs` 里那条平台/架构的说明），所以必须能分别造。
  releaseOverrides = {},
  feedOverrides = {},
}) {
  const productManifest = {
    format: 'legion/version-manifest@1',
    productVersion,
    legionVersion: productVersion,
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    channel: 'stable',
  }
  const pkg = artifactFromBytes(`releases/${releaseId}/legion-win-x64.zip`, packageBytes)
  const installer = artifactFromBytes(`releases/${releaseId}/Legion-Setup-win-x64.exe`, Buffer.from('installer'))
  const notes = artifactFromBytes(`releases/${releaseId}/notes.zh-CN.txt`, notesBytes)
  const release = buildRelease({
    releaseId,
    productVersion,
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
    ...releaseOverrides,
  })
  const manifestBytes = Buffer.from(serializeEnvelope(signEnvelope(release, { privateKeyPem, keyId })), 'utf8')
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const feed = buildFeedPayload({
    channel: 'stable', platform: 'win32', arch: 'x64', sequence,
    issuedAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z',
    releaseId: release.releaseId, productVersion,
    manifestPath: `releases/${releaseId}/manifest.json`, manifestSha256,
    ...feedOverrides,
  })
  const feedBytes = Buffer.from(serializeEnvelope(signEnvelope(feed, { privateKeyPem, keyId })), 'utf8')

  const files = new Map([
    ['feeds/stable/win-x64.json', { bytes: feedBytes, cache: FEED_CACHE_CONTROL }],
    [`releases/${releaseId}/manifest.json`, { bytes: manifestBytes, cache: RELEASE_CACHE_CONTROL }],
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
  fetchImpl, cacheDir, installRootUnused = null, configOverrides = {}, installer = null,
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
    // 安装事务可注入（`null` = 没接线，用来测"尚未接线"那条判据）。
    installer,
  })
}

function setup({
  mutate = null, packageBytes = Buffer.from('PK\u0003\u0004 pretend zip payload'), slowChunks = 0,
  productVersion = NEXT, releaseId = `rel-${productVersion}`, sequence = 42,
  // ★ 可复用同一对密钥：合成"同一个信任根下的两个发行"时，第二个必须由
  //   **同一把钥匙**签名，否则它会以 `envelope-unknown-key` 被拒——
  //   那会掩盖这条用例真正要测的东西。
  keys = null,
  // ★ 通道清单与发行清单的字段覆盖（设计 §5 line 114 的"两者必须一致"）。
  releaseOverrides = {},
  feedOverrides = {},
} = {}) {
  const keyId = 'release-2026-a'
  const keyPair = keys ?? generateReleaseKeyPair({ keyId })
  const trustStore = createTrustStore([{ keyId, publicKeyPem: keyPair.publicKeyPem }])
  const fetchImpl = createStaticHost({
    keyId, privateKeyPem: keyPair.privateKeyPem, packageBytes, mutate, slowChunks, productVersion, releaseId, sequence,
    releaseOverrides, feedOverrides,
  })
  fetchImpl.trustStore = trustStore
  const cacheDir = mkdtempSync(join(tmpdir(), 'legion-update-test-'))
  return { fetchImpl, cacheDir, keys: keyPair, trustStore }
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

test('★★★ 发行清单与通道清单的 channel／productVersion 不一致 → 下载前就拒（设计 §5 line 114）', async (t) => {
  // ★ 设计 §5 line 114 那张表要求发行清单里的
  //   「releaseId、productVersion、channel、platform、arch | **与通道清单一致**，
  //     锁定一次发行」。
  //
  //   实现是 `validateRelease(payload, { expect })` 里一个**逐字段**的循环，
  //   生产接线也在（`client.mjs` 把五个字段一起传进去）。但**用例只证了其中
  //   两个**：`release.mjs` 的装载期自检喂的是 `expect: { releaseId, productVersion }`
  //   ——`channel`/`platform`/`arch` 那三个**没有任何用例**。
  //
  //   > 一条判据的用例只碰了它的一部分时，**没被碰的那部分是裸的**。
  //
  // ★ 实测过五个字段各自的**实际拦截者**（见下面那条被跳过的说明）：
  //   `channel` 与 `productVersion` 确实由这个 `expect` 循环拦下；
  //   `platform`/`arch` 会被**更早**的白名单判据拦下（`KNOWN_PLATFORMS`／
  //   通道清单与本机平台的一致性），所以那两条在真实链路上到不了这里。
  //   这条用例只断言**真的会走到这个循环**的那两个字段，
  //   并把这件事写清楚——把到不了的那三个也写进来，会得到一条
  //   "由别的判据满足"的绿灯，看起来在守这条循环，实际没有。
  for (const [label, opts] of [
    ['发行清单自称属于另一个通道', { releaseOverrides: { channel: 'canary' } }],
    ['通道清单写着另一个 productVersion', { feedOverrides: { productVersion: '1.2.0' } }],
  ]) {
    const ctx = setup(opts)
    t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
    const client = makeClient(ctx)
    const result = await client.check()
    assert.equal(result.outcome, 'failed',
      `${label}：两份清单对不上，却被接受了（设计 §5 line 114）`)
    // 码来自 `release.mjs` 自己的词表（`release-identity-mismatch`），
    // 不是 `UPDATE_CODES_CLIENT.IDENTITY_MISMATCH`——后者说的是"下载/安装时
    // 请求的身份与当前候选/已就绪的身份不符"，是**另一条**判据。
    assert.equal(result.code, 'release-identity-mismatch',
      `${label}：应当报身份不符，实际 ${result.code}：${result.reason}`)
    assert.equal(client.candidate(), null, `${label}：身份不一致不该留下候选`)
  }
})

test('★ platform／arch 的分歧由**更早的**白名单判据拦下（那两条到不了身份循环）', async (t) => {
  // 这一条的作用是**把上一条的边界写清楚**：`validateRelease` 的 `expect`
  // 循环里确实列了 platform/arch，但在真实链路上它们永远走不到那里——
  // 通道清单会先被"与本机平台/架构是否一致"拦下。
  //
  // ★ 为什么值得单独写一条：不写的话，下一个人看到"循环里有五个字段、
  //   用例只测了两个"，会以为是**测试不全**，然后补上三个到不了那里的断言，
  //   得到三条"由别的判据满足"的绿灯。而"一条由别的判据满足的断言"比没有
  //   断言更糟：它让人以为这条路径被守住了。
  for (const [label, opts] of [
    ['通道清单说自己是 linux', { feedOverrides: { platform: 'linux' } }],
    ['通道清单说自己是 arm64', { feedOverrides: { arch: 'arm64' } }],
  ]) {
    const ctx = setup(opts)
    t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
    const client = makeClient(ctx)
    const result = await client.check()
    assert.equal(result.outcome, 'failed', `${label}：却被接受了`)
    // 拦下它的是**具名**的通道清单字段判据，不是身份循环。
    assert.equal(result.code, 'feed-bad-field',
      `${label}：期望由通道清单的字段判据拦下，实际 ${result.code}：${result.reason}`)
  }
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

test('★★★ 下载期间候选变了 → 丢弃本次下载，绝不"悄悄装另一个版本"（设计 §10 第 4 行）', async (t) => {
  // ★ 设计 §10 第 4 行的验收是：「重复点击、多个窗口、**下载中发现新版** →
  //   一次网络/安装事务；**确认目标保持一致**」。§6 line 138 也写着
  //   「用户确认绑定该身份；发布端变更清单**不替换**正在下载或已下载的目标」。
  //
  //   实现是 `client.mjs` 下载完成之后那一次 `sameIdentity(identityOf(candidate),
  //   targetIdentity)` 比较——**而它此前没有任何用例**（我把 client.test.mjs 里
  //   "下载期间"相关的 grep 都翻了一遍，只有文件头注释提到过这件事）。
  //
  //   ★ 这条判据危险的地方在于它的**两个失败方向不对称**：
  //     · 判据在 → 一次下载被丢弃，用户重新确认（代价：一包流量）；
  //     · 判据不在 → 用户看到的是"1.1.0 的说明"，装上去的是 1.2.0。
  //   而后者在界面上**看不出来**：状态、进度、releaseId 都可能已经更新成新的，
  //   只有"我点的是那一个"这件事没有被任何人核对。
  //
  //   构造：让包慢慢吐（`slowChunks`），在下载途中把**候选换掉**（再走一次
  //   `check()`，此时托管给出另一个 releaseId 且 sequence 更高），然后等下载
  //   结束。它必须失败、必须不留就绪态、必须没有 `.part` 残留。
  const ctx = setup({ slowChunks: 8, packageBytes: Buffer.alloc(64 * 1024, 7) })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const first = await client.check()
  assert.equal(first.outcome, 'available', first.reason)
  const originalId = first.candidate.releaseId
  assert.equal(originalId, `rel-${NEXT}`)

  const pending = client.download(first.candidate.releaseId, first.candidate.manifestSha256)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(client.state(), 'downloading', '下载没有进入 downloading 状态')

  // ── 下载途中，通道前进到一个**新的**发行（更高 sequence + 新 releaseId）──
  //
  // ★ 直接把新通道与新发行的文件**装进同一份托管**：这条判据要问的是
  //   "**同一个**客户端在下载期间候选被换掉会怎样"，所以必须作用在
  //   **同一个实例**上（用两个实例各测一半，测不出这件事——见 ㉗ 的教训）。
  const NEW_VERSION = '1.2.0'
  const newer = setup({ productVersion: NEW_VERSION, sequence: 43, keys: ctx.keys })
  t.after(() => rmSync(newer.cacheDir, { recursive: true, force: true }))
  ctx.fetchImpl.files.set('feeds/stable/win-x64.json', newer.fetchImpl.files.get('feeds/stable/win-x64.json'))
  for (const [k, v] of newer.fetchImpl.files) {
    if (k.startsWith(`releases/rel-${NEW_VERSION}/`)) ctx.fetchImpl.files.set(k, v)
  }
  const second = await client.check()
  assert.equal(second.outcome, 'available', `换了通道之后应当发现新候选：${second.reason}`)
  assert.equal(client.candidate().releaseId, `rel-${NEW_VERSION}`,
    '这一条需要候选真的被换掉，否则它证明不了"下载期间候选变了"')

  const result = await pending
  assert.equal(result.ok, false, '候选变了却把包交了')
  assert.equal(result.code, 'update-identity-mismatch', `期望身份不符，实际 ${result.code}：${result.reason}`)
  assert.match(result.reason, /下载期间/)
  // ★ 三个"没有悄悄换掉"的读数：不就绪、不留包、不留 .part。
  assert.equal(client.ready(), null, '候选变了却留下了就绪态')
  assert.equal(client.snapshot().ready, false)
  const sweep = client.cache.sweepStaleParts()
  assert.equal(sweep.removed.length, 0, `丢弃之后留下了 ${sweep.removed.length} 个 .part 文件`)
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

test('★★★ 稍后只对**它当时推迟的那一个发行**生效：换了一个发行就要重新提醒', async (t) => {
  // ★ 这是 ㉗：设计 §7 line 146 的原话是
  //
  //   「稍后仅收起提醒，设置页仍可见；**同一发行**默认 24 小时内不重复主动提醒。」
  //
  //   限定词「同一发行」是这条规则的**全部内容**：24 小时的沉默只针对用户
  //   看见并推迟的那一个版本。
  //
  //   原先只存了一个时间戳，`shouldNotify()` 在任何窗口内都返回 false，
  //   **与候选是哪一个发行无关**。后果：用户对 1.1.0 点了"稍后"，而 1.2.0
  //   在几小时后发布 ⇒ **1.2.0 被静默吞掉**，用户不会被告知，直到窗口过完。
  //   而"有更新可用"正是这个功能存在的全部理由。
  //
  //   > 一条带限定词的规则，如果实现里丢掉了那个限定词，
  //   > 它的作用范围就从"那一个"变成了"全部"——而这两种写法在代码上
  //   > 只差一个字段。
  //
  // ★★ 这条用例第一版是**空的**，值得把原因记下来：
  //
  //   我一开始用**两个客户端实例**来比较（A 对 1.1.0 点稍后，再用另一个
  //   客户端看 1.2.0）。那是错的——一个新客户端**根本没有稍后状态**
  //   （`snoozedUntilMs === null`），所以它当然会提醒。把修复整个撤掉重跑，
  //   那条用例**照样通过**。也就是说它测的是"新客户端会提醒"，而不是
  //   "换了发行就不再沉默"。
  //
  //   正确的构造是**同一个客户端**先后看到两个发行：先用 `check()` 看到
  //   1.1.0、点稍后（进入沉默），再让托管换成 1.2.0（sequence 前进），
  //   同一个客户端再 `check()` 一次。
  //
  //   > 一个"两个对象各测一半"的用例，测不出"同一个对象上的状态变化"。
  const ctxA = setup()
  t.after(() => rmSync(ctxA.cacheDir, { recursive: true, force: true }))
  // ★ 第二个发行必须：① 由**同一把钥匙**签名（否则是"未知钥匙"而不是"换了发行"）；
  //   ② 用**更高**的 sequence（否则会被"同 sequence 换摘要"拒掉——那条判据是对的）。
  const ctxB = setup({ productVersion: '1.2.0', sequence: 43, keys: ctxA.keys })
  t.after(() => rmSync(ctxB.cacheDir, { recursive: true, force: true }))

  let swapped = false
  // 换发行之后，feed 与 `rel-1.2.0/*` 都从 B 那份托管取；其余仍走 A。
  const combined = async (url, options = {}) => {
    if (swapped && (url.includes('/feeds/') || url.includes('/rel-1.2.0/'))) {
      return ctxB.fetchImpl(url, options)
    }
    return ctxA.fetchImpl(url, options)
  }
  combined.host = ctxA.fetchImpl.host
  combined.trustStore = ctxA.trustStore

  const client = makeClient({ fetchImpl: combined, cacheDir: ctxA.cacheDir })
  const first = await client.check()
  assert.equal(first.outcome, 'available', first.reason)
  assert.equal(client.candidate().releaseId, `rel-${NEXT}`)
  assert.equal(client.shouldNotify(), true)

  client.snooze()
  assert.equal(client.shouldNotify(), false, '刚点完稍后就不该提醒')
  // 快照里必须能看出"推迟的是哪一个发行"（否则界面只能说一个孤零零的截止时间）。
  assert.equal(client.snapshot().snoozedReleaseId, `rel-${NEXT}`)

  // 仍是同一个发行（再次检查到同一份清单）→ 窗口内继续保持沉默。
  const again = await client.check()
  assert.equal(again.candidate.releaseId, `rel-${NEXT}`)
  assert.equal(client.shouldNotify(), false, '同一个发行在窗口内不该重新提醒（原判据要保持）')

  // ── 发布方发了新版：通道 sequence 前进，指向 rel-1.2.0 ──
  swapped = true
  const second = await client.check()
  assert.equal(second.outcome, 'available', second.reason)
  assert.equal(client.candidate().releaseId, 'rel-1.2.0')
  // ★ 关键断言：时刻仍在 A 的 24 小时窗口之内（`now` 固定为 NOW_MS），
  //   但候选换了发行 ⇒ **必须提醒**。
  assert.equal(client.shouldNotify(), true,
    '换了一个发行之后仍然不提醒：用户会永远看不到新版本（㉗）')

  // ★ 对**新的**那个发行点稍后，它自己也应当被沉默（并且记的是新发行）。
  client.snooze()
  assert.equal(client.shouldNotify(), false)
  assert.equal(client.snapshot().snoozedReleaseId, 'rel-1.2.0')
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
// ★ 安装前重查通道（设计 §9 line 204：撤回必须挡得住**已下载**的人）
// ---------------------------------------------------------------------------

test('★★★ 安装前重查通道：目标被撤回 → 禁止安装，并取消旧候选', async (t) => {
  // 在这条判据之前 `install()` **不读通道**：只核对 `readyIdentity` 与调用方
  // 给的身份一致，然后直接交接。而"下载完成"与"用户点安装"之间可以隔很久，
  // 发布端在那段时间里完全可能撤回那个版本——撤回的**全部意义**就是"别让它
  // 再被装上"。没有这一步时，撤回只能挡住还没下载的人；而撤回通常恰恰是因为
  // 那个包会弄坏数据，所以挡不住已经下载的人 ≈ 没撤。
  let feedReads = 0
  const ctx = setup({
    mutate: (relative, entry) => {
      if (relative !== 'feeds/stable/win-x64.json') return entry
      feedReads += 1
      // 第一次（检查时）给正常通道；第二次（安装前）给撤回清单：更高
      // sequence，指向**安全的旧版本**——这正是设计描述的那种撤回。
      if (feedReads < 2) return entry
      const recall = buildFeedPayload({
        channel: 'stable', platform: 'win32', arch: 'x64', sequence: 43,
        issuedAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z',
        releaseId: `rel-${CURRENT}`, productVersion: CURRENT,
        manifestPath: `releases/rel-${CURRENT}/manifest.json`, manifestSha256: 'f'.repeat(64),
      })
      return {
        bytes: Buffer.from(serializeEnvelope(signEnvelope(recall, {
          privateKeyPem: ctx.keys.privateKeyPem, keyId: 'release-2026-a',
        })), 'utf8'),
        cache: FEED_CACHE_CONTROL,
      }
    },
  })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  // ★ 装一个**会成功**的替身安装器。
  //
  //   不装的话 `install()` 会先返回 `install-not-wired`，于是这条用例即使在
  //   "撤回根本没被检查"的情况下也会"通过"——它测的就变成了别的东西。
  //   装了之后，"没拦住"会直接表现为 `result.ok === true`，拦不住就红。
  const installer = { async install({ identity }) { return { ok: true, identity, reachedStage: 'committed' } } }
  const client = makeClient({ ...ctx, installer })

  const checked = await client.check({ trigger: 'manual' })
  assert.equal(checked.outcome, 'available', checked.reason)
  const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(downloaded.ok, true, downloaded.reason)
  assert.equal(client.snapshot().ready, true)

  const result = await client.install(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(result.ok, false, '目标已被撤回，却仍然允许安装')
  assert.equal(result.code, 'update-target-recalled')
  // ★ 撤回清单必须**取消旧候选**：否则界面一直显示"有新版本可安装"，而每一次
  //   点击都在这里失败——用户会以为按钮坏了。
  assert.equal(client.candidate(), null, '已撤回的候选没有被取消')
  assert.equal(client.snapshot().ready, false, '已撤回的包仍然处于"就绪"')
  // 状态落回 `available`（通道上有东西，但不是你已经下载的那一个）。
  assert.equal(client.state(), 'available')
  // ★ 而且**不能**授予降级权限：撤回清单指向的是当前版本，但客户端不该因此
  //   把"退回 CURRENT"当成一个可选动作。
  assert.equal(client.release(), null, '撤回之后仍然留着一份发行清单')
})

test('★★★ 安装前读不到通道 → 同样不装（fail-closed）', async (t) => {
  // "读不到"与"被撤回了"必须给出同一个结论：能证明"它没被撤回"的只有通道
  // 本身。把读不到当成"那就装吧"，等于让一次网络故障取消掉撤回保护。
  let feedReads = 0
  const ctx = setup({
    mutate: (relative, entry) => {
      if (relative !== 'feeds/stable/win-x64.json') return entry
      feedReads += 1
      return feedReads < 2 ? entry : { status: 503, headers: { 'cache-control': 'no-store' }, bytes: Buffer.alloc(0) }
    },
  })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  // 同样装一个会成功的替身：否则"读不到通道却放行"会被 `install-not-wired`
  // 掩盖，用例测的就不是这条判据了。
  const installer = { async install({ identity }) { return { ok: true, identity, reachedStage: 'committed' } } }
  const client = makeClient({ ...ctx, installer })

  const checked = await client.check({ trigger: 'manual' })
  const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(downloaded.ok, true, downloaded.reason)

  const result = await client.install(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(result.ok, false, '读不到通道却放行了安装')
  assert.equal(result.code, 'update-recall-unverified')
  // ★ 与"撤回"不同：这里**不**取消候选。读不到可能只是一次网络抖动，而把候选
  //   丢掉会让用户失去一个已经下载好的包（还得重新下几百 MB）。所以状态保持
  //   `ready`，用户重试即可。
  assert.equal(client.snapshot().ready, true, '仅仅"读不到通道"就丢掉了已下载的包')
  assert.notEqual(client.candidate(), null, '仅仅"读不到通道"就取消了候选')
})

test('★★ 通道没变时安装照常进行（这条判据不能什么都拦）', async (t) => {
  const ctx = setup()
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const installer = { async install({ identity }) { return { ok: true, identity, reachedStage: 'committed' } } }
  const client = makeClient({ ...ctx, installer })
  const checked = await client.check({ trigger: 'manual' })
  const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(downloaded.ok, true, downloaded.reason)
  const result = await client.install(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(result.ok, true, `通道未变却拒绝了安装：${result.code} ${result.reason}`)
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
// ---------------------------------------------------------------------------
// ★★★ 发行方声明的升级窗口（设计 §5 的 supportedFromVersions）
// ---------------------------------------------------------------------------

test('★★★★ 本机版本不在发行声明的窗口里 → 不给出候选，且不是"已是最新版本"', async (t) => {
  // ★ 这条守的是"那份声明终于有人读"的**客户端那一半**。
  //
  //   背景（本次会话实测出来的空洞）：`release.mjs` 把 `supportedFromVersions`
  //   的形状验得很细，而**没有任何代码拿本机版本去问"我在这个集合里吗"**。
  //   于是本机 1.0.0、而发行声明只支持从 0.9.0 升时，客户端照样会给出候选，
  //   用户下载、点安装，然后在预检那里被拦——白下载一次。
  //
  //   ★ 两半的分工：这一半决定**要不要把候选显示给用户**（体验），
  //     预检那一半决定**能不能真的换程序**（安全，在 `install.test.mjs`）。
  //     两道都要有——只有预检的话用户白下载；只有客户端的话，
  //     一个绕过界面直接调 `install()` 的调用方就能从没验过的版本升上来。
  const ctx = setup({ releaseOverrides: { supportedFromVersions: ['0.9.0'] } })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)

  const result = await client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'source-unsupported', `结论错了：${JSON.stringify(result)}`)
  assert.equal(result.code, 'update-source-version-unsupported')
  // ★ 必须与"已是最新版本"分开：用户该做的事相反。
  assert.notEqual(result.outcome, 'up-to-date')
  // 没有候选——界面不该给出一个装不上的版本。
  assert.equal(client.snapshot().available ?? null, null)
  assert.equal(client.state(), 'source-unsupported')
  // 定时器/状态：它不该像失败那样进退避。
  assert.notEqual(client.state(), 'check-failed')
  // ★ 理由里要带"先升到哪个版本"，否则用户唯一的下一步就是反复点检查。
  assert.match(result.reason, /0\.9\.0/, `理由里没有说该升到哪个版本：${result.reason}`)
  assert.match(result.reason, /1\.0\.0/, `理由里没有说本机是哪个版本：${result.reason}`)
  // 声明本身要如实带出来（界面可以据此给出"先升到 X"的指引）。
  assert.deepEqual([...result.supportedFromVersions], ['0.9.0'])
  // 高水位仍然推进了：清单本身是**合法**的，"本机版本不在窗口里"不是发布端的事故。
  // （一个把合法清单判成事故的实现会让 CDN 送回旧清单时也被接受——那是另一条判据。）
  assert.equal(ctx.fetchImpl.requests.some((r) => r.url.includes('feeds/stable')), true)
})

test('★★★ 对照：本机版本**在**声明的窗口里 → 照常给出候选', async (t) => {
  // 没有这一条，上面那条的"绿"可能只是因为别的判据把候选拦掉了。
  const ctx = setup({ releaseOverrides: { supportedFromVersions: [CURRENT] } })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const result = await client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'available', `声明里含本机版本却被拒了：${result.reason}`)
  assert.equal(client.state(), 'available')
})

test('★★ 多个来源版本时按**集合**判，不是"任意版本都行"', async (t) => {
  const ctx = setup({ releaseOverrides: { supportedFromVersions: ['0.8.0', '0.9.0'] } })
  t.after(() => rmSync(ctx.cacheDir, { recursive: true, force: true }))
  const client = makeClient(ctx)
  const result = await client.check({ trigger: 'manual' })
  // 本机 1.0.0 不在 ['0.8.0','0.9.0'] 里。
  assert.equal(result.outcome, 'source-unsupported', `集合里没有本机版本，却给出了候选：${JSON.stringify(result)}`)
})
