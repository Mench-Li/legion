// scripts/update/publish.test.mjs
// ============================================================================
// 发布端 → 托管 → 回读的**闭环**回归
//
// 这一条测试的价值在于它走的是**两段不同的代码**：
//   发布端（`publish.mjs`，用私钥签名并写出字节）
//     → 一个内存静态托管
//     → 回读端（`verify-host.mjs`，用**客户端同一套**代码验签）
//
// 只测发布端会漏掉"我写出去的形状客户端读不懂"；只测回读端会漏掉
// "发布端对同一份清单算出了不同的字节"。设计 §9 第 3 步要的正是这个问题
// 的答案：「公开回读验证字节与签名」。
// ============================================================================

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { buildPublish, packDirectory, renderUploadPlan, writePublish } from './publish.mjs'
import { verifyHost } from './verify-host.mjs'
import { buildTrustTable } from './trust-file.mjs'
import { createTrustStore, generateReleaseKeyPair } from '../../product/update/envelope.mjs'
import { extractArchive, planExtraction, verifyExtractedTree } from '../../product/update/extract.mjs'
import { buildZip } from '../../product/update/zip.mjs'
import { createTransport } from '../../product/update/transport.mjs'
import { createHostConfig, FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL } from '../../product/update/host.mjs'
import { createHash } from 'node:crypto'

const ORIGIN = 'https://updates.example.com'
const PREFIX = '/legion'
const NOW_MS = Date.parse('2026-10-04T12:00:00Z')
const PRODUCT_VERSION = '1.1.0'
const FROM_VERSION = '1.0.0'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-publish-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stage = join(root, 'stage')
  mkdirSync(stage, { recursive: true })

  // 交付物：一个假 ZIP、一个假安装器、一份纯文本说明。
  const zipPath = join(stage, 'legion-win-x64.zip')
  writeFileSync(zipPath, Buffer.from('PK\u0003\u0004 pretend product closure'))
  const installerPath = join(stage, 'Legion-Setup-win-x64.exe')
  writeFileSync(installerPath, Buffer.from('MZ pretend installer'))
  const notesPath = join(stage, 'notes.zh-CN.txt')
  writeFileSync(notesPath, Buffer.from('• 修复若干问题\n• 启动更快\n', 'utf8'))

  // ★ 与仓库里真正的 `product/release/runtime-manifest.json` 同形：
  //   格式字段是 `manifestFormat`，且三个版本字段是必需的。
  const productManifest = {
    manifestFormat: 'legion/version-manifest@1',
    productVersion: PRODUCT_VERSION,
    legionVersion: PRODUCT_VERSION,
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    schemaVersion: 1,
    channel: 'stable',
    releasedAt: '2026-10-04T00:00:00.000Z',
  }
  const productManifestPath = join(stage, 'runtime-manifest.json')
  writeFileSync(productManifestPath, JSON.stringify(productManifest), 'utf8')

  const keys = generateReleaseKeyPair({ keyId: 'release-2026-a' })
  const trustStore = createTrustStore([{ keyId: 'release-2026-a', publicKeyPem: keys.publicKeyPem }])
  return { root, stage, zipPath, installerPath, notesPath, productManifest, productManifestPath, keys, trustStore }
}

function publishArgs(ctx, overrides = {}) {
  return {
    productVersion: PRODUCT_VERSION,
    channel: 'stable',
    releaseId: 'rel-1.1.0',
    productManifest: ctx.productManifest,
    supportedFromVersions: [FROM_VERSION],
    packageZipPath: ctx.zipPath,
    installerPath: ctx.installerPath,
    notesPath: ctx.notesPath,
    migrationPlanDigest: 'd'.repeat(64),
    rollbackPolicy: 'program-only',
    keyId: 'release-2026-a',
    privateKeyPem: ctx.keys.privateKeyPem,
    sequence: 43,
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
    ...overrides,
  }
}

/** 把 `writePublish` 的输出目录当静态托管。 */
function hostFrom(outDir) {
  const files = new Map()
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`)
      else files.set(`${prefix}${entry.name}`, readFileSync(full))
    }
  }
  walk(join(outDir, 'immutable'), '')
  walk(join(outDir, 'channel'), '')

  const requests = []
  async function fetchImpl(url, options = {}) {
    void options
    requests.push(url)
    const relative = url.slice(`${ORIGIN}${PREFIX}/`.length)
    const bytes = files.get(relative)
    if (bytes === undefined) {
      return { status: 404, headers: { entries: () => [['cache-control', 'no-store']] }, body: Readable.from([]) }
    }
    const cache = relative.startsWith('feeds/') ? FEED_CACHE_CONTROL : RELEASE_CACHE_CONTROL
    // 只回 4 KiB：与 `verify-host` 的探测窗口一致。
    const slice = bytes.subarray(0, 4096)
    return {
      status: 200,
      headers: { entries: () => [['cache-control', cache], ['content-length', String(slice.length)]] },
      body: Readable.from([slice]),
    }
  }
  fetchImpl.files = files
  fetchImpl.requests = requests
  return fetchImpl
}

// ---------------------------------------------------------------------------
// ① 发布端
// ---------------------------------------------------------------------------

test('发布：产出不可变发行文件与待替换的通道清单（分开放）', (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  assert.equal(publish.release.releaseId, 'rel-1.1.0')
  assert.equal(publish.feed.sequence, 43)
  assert.equal(publish.feedPath, 'feeds/stable/win-x64.json')
  // ★ 不可变与可变必须**分开**：设计 §9 line 202 要求先传不可变文件、
  //   最后才替换通道清单。
  assert.equal(publish.immutable.length, 4)
  assert.equal(publish.mutable.length, 1)
  assert.match(publish.mutable[0].path, /^feeds\//)
  for (const entry of publish.immutable) {
    assert.equal(entry.path.startsWith('releases/'), true, `不可变文件跑到发行目录之外：${entry.path}`)
  }
})

test('发布：写出去之后回读核对字节（写坏就抛）', (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  const written = writePublish(publish, outDir)
  assert.ok(written.plan.endsWith('upload-plan.txt'))
  // 发行清单的字节必须与通道声明的摘要逐字节一致。
  const manifest = readFileSync(join(outDir, 'immutable', 'releases', 'rel-1.1.0', 'manifest.json'))
  assert.equal(createHash('sha256').update(manifest).digest('hex'), publish.summary.manifestSha256)
})

test('发布：上传计划把顺序写死（不可变 → 回读 → 通道）', (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const plan = renderUploadPlan(publish, join(ctx.root, 'out'))
  const immutableAt = plan.indexOf('第 1 步')
  const verifyAt = plan.indexOf('第 2 步')
  const channelAt = plan.indexOf('第 3 步')
  assert.ok(immutableAt >= 0 && verifyAt > immutableAt && channelAt > verifyAt, '上传计划的三步顺序不对')
  assert.match(plan, /scp/)
})

test('发布：产品清单版本与 --product-version 不一致 → 拒绝', (t) => {
  const ctx = setup(t)
  assert.throws(
    () => buildPublish(publishArgs(ctx, { productVersion: '2.0.0' })),
    /不一致/,
  )
})

test('发布：产品清单本身不合法 → 拒绝', (t) => {
  const ctx = setup(t)
  assert.throws(
    () => buildPublish(publishArgs(ctx, { productManifest: { manifestFormat: 'legion/version-manifest@1', productVersion: '^1.1.0' } })),
    /产品清单校验未通过/,
  )
})

test('发布：产物路径必须是发布目录下的相对路径', (t) => {
  const ctx = setup(t)
  // 安装器的 basename 会进入路径；给它一个带目录分隔符之外的危险名字时，
  // `validateRelativePath` 必须拒。
  const badInstaller = join(ctx.stage, 'Legion Setup.exe')
  writeFileSync(badInstaller, Buffer.from('MZ'))
  assert.throws(
    () => buildPublish(publishArgs(ctx, { installerPath: badInstaller })),
    /产物路径不合法/,
  )
})

test('发布：未知通道被拒', (t) => {
  const ctx = setup(t)
  assert.throws(() => buildPublish(publishArgs(ctx, { channel: 'nightly' })), /未知通道/)
})

// ---------------------------------------------------------------------------
// ② 端到端：发布 → 托管 → 回读
// ---------------------------------------------------------------------------

test('★ 端到端：发布出来的东西能被客户端同一套代码验签并回读通过', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const fetchImpl = hostFrom(outDir)

  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl,
    expectReleaseId: 'rel-1.1.0', expectSequence: 43,
    now: () => NOW_MS,
  })

  assert.equal(result.ok, true,
    `回读未通过：\n${result.checks.filter((c) => !c.ok).map((c) => `  ${c.name}: ${c.detail}`).join('\n')}`)
  assert.equal(result.feed.sequence, 43)
  assert.equal(result.feed.releaseId, 'rel-1.1.0')
  // 通道声明的摘要 ↔ 回读得到的字节摘要必须相等。
  assert.equal(result.releaseDigest, result.feed.manifestSha256)
  // 三个产物地址都可达。
  for (const kind of ['package', 'installer', 'notes']) {
    assert.ok(result.checks.some((c) => c.name === `artifact-${kind}` && c.ok), `${kind} 的可达性检查没通过`)
  }
})

test('★ 端到端：托管上少一个不可变文件 → 回读明确失败（不是"看起来还行"）', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const fetchImpl = hostFrom(outDir)
  // 把发行清单删掉：模拟"通道已经指向了新序号，但发行清单还没传上去"。
  fetchImpl.files.delete('releases/rel-1.1.0/manifest.json')

  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl, now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const failed = result.checks.find((c) => c.name === 'release-fetch')
  assert.equal(failed.ok, false)
  assert.equal(failed.detail.includes('404'), true, `失败理由不明确：${failed.detail}`)
})

test('★ 端到端：托管上的发行清单被换掉 → 摘要不符被拒', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const fetchImpl = hostFrom(outDir)
  // 用**同一把钥匙**另签一份内容不同的发行清单（模拟"通道说 A、清单是 B"）。
  const other = buildPublish(publishArgs(ctx, { releaseId: 'rel-1.1.0', sequence: 43, productVersion: PRODUCT_VERSION, supportedFromVersions: ['0.9.0'] }))
  fetchImpl.files.set('releases/rel-1.1.0/manifest.json', other.immutable[0].bytes)

  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl, now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const digestCheck = result.checks.find((c) => c.name === 'release-digest')
  assert.equal(digestCheck.ok, false)
})

test('端到端：通道清单缓存策略不对 → 回读失败', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const files = new Map()
  for (const [key, value] of hostFrom(outDir).files) files.set(key, value)
  const brokenFetch = async (url, options = {}) => {
    const relative = url.slice(`${ORIGIN}${PREFIX}/`.length)
    const bytes = files.get(relative)
    if (bytes === undefined) {
      return { status: 404, headers: { entries: () => [['cache-control', 'no-store']] }, body: Readable.from([]) }
    }
    // 通道清单被配成可缓存 —— 一个"发布了新版但用户看不到"的部署。
    const cache = 'public, max-age=600'
    return {
      status: 200,
      headers: { entries: () => [['cache-control', cache], ['content-length', String(bytes.length)]] },
      body: Readable.from([bytes]),
    }
  }
  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl: brokenFetch, now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const check = result.checks.find((c) => c.name === 'feed-cache-policy')
  assert.equal(check.ok, false)
  assert.match(check.detail, /no-store/)
})

test('端到端：HTTP 测试地址必须显式声明，否则回读在配置这一步就失败', async (t) => {
  const ctx = setup(t)
  const result = await verifyHost({
    origin: 'http://117.72.146.36', prefix: '/test/legion', channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl: async () => { throw new Error('不该发出请求') },
    now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const check = result.checks.find((c) => c.name === 'host-config')
  assert.equal(check.ok, false)
  assert.match(check.detail, /HTTPS|allowInsecureHttp/)
})

test('端到端：sequence 与预期不符 → 那一条检查失败但其余照跑', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl: hostFrom(outDir),
    expectSequence: 99, now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const check = result.checks.find((c) => c.name === 'feed-sequence')
  assert.equal(check.ok, false)
  assert.match(check.detail, /43/)
  // 签名与 schema 仍然是通过的：一次"序号不对"不该掩盖"签名是好的"。
  assert.equal(result.checks.find((c) => c.name === 'feed-signature').ok, true)
})

// ---------------------------------------------------------------------------
// ④ 由目录树打包（带闭包）→ 回读 → 解压：真正的闭环
// ---------------------------------------------------------------------------

test('★ 闭环：目录树 → 打包（含闭包）→ 回读验签 → 解压 → 解压后再核闭包', async (t) => {
  const ctx = setup(t)
  // 一份"产品树"：一个可执行 + 一个数据文件。
  const payloadRoot = join(ctx.root, 'payload')
  const files = [
    { path: 'product/launcher/cli.mjs', bytes: Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n') },
    { path: 'product/release/runtime-manifest.json', bytes: Buffer.from(JSON.stringify(ctx.productManifest)) },
    { path: 'product/assets/icon.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]) },
  ]
  for (const file of files) {
    const target = join(payloadRoot, ...file.path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.bytes)
  }

  const outDir = join(ctx.root, 'out')
  const publish = buildPublish(publishArgs(ctx, { packageRoot: payloadRoot, packageZipPath: null, outDir }))
  // ★ 清单里带上了闭包的位置与摘要。
  assert.equal(publish.release.package.closurePath, 'closure.json')
  assert.match(publish.release.package.closureSha256, /^[0-9a-f]{64}$/)
  assert.equal(publish.summary.closureFileCount, files.length)

  writePublish(publish, outDir)

  // 回读：客户端同一套代码必须验得过。
  const verified = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl: hostFrom(outDir, { full: true }),
    expectReleaseId: 'rel-1.1.0', now: () => NOW_MS,
  })
  assert.equal(verified.ok, true,
    `回读未通过：\n${verified.checks.filter((c) => !c.ok).map((c) => `  ${c.name}: ${c.detail}`).join('\n')}`)

  // 解压：用发行清单钉住的闭包条目，逐文件核对内容摘要。
  const zipPath = join(outDir, 'immutable', 'releases', 'rel-1.1.0', 'legion-win-x64.zip')
  const archiveBytes = readFileSync(zipPath)
  const targetDir = join(ctx.root, 'installed', 'versions', '1.1.0')
  const extracted = extractArchive({
    archiveBytes,
    targetDir,
    closureEntry: {
      path: publish.release.package.closurePath,
      sha256: publish.release.package.closureSha256,
    },
  })
  assert.equal(extracted.ok, true, extracted.reason)
  for (const file of files) {
    assert.deepEqual(readFileSync(join(targetDir, ...file.path.split('/'))), file.bytes, `${file.path} 内容不符`)
  }
  // 解压**之后**的闭包核对。
  const verdict = verifyExtractedTree({ targetDir, expected: extracted.written })
  assert.equal(verdict.ok, true, verdict.problems.join('；'))
})

test('★ 闭包拦得住"发布端多塞了一个可执行文件"', async (t) => {
  const ctx = setup(t)
  const payloadRoot = join(ctx.root, 'payload')
  const good = Buffer.from('#!/usr/bin/env node\n')
  mkdirSync(join(payloadRoot, 'product', 'launcher'), { recursive: true })
  writeFileSync(join(payloadRoot, 'product', 'launcher', 'cli.mjs'), good)

  // 直接用打包函数拿到闭包字节：`buildPublish` 把它们放进包里，而这个用例
  // 要**手改包**来模拟一次投毒。
  const packed = packDirectory({ root: payloadRoot })
  assert.equal(packed.ok, true, packed.reason)

  // 攻击形态：包里多塞一个可执行文件，而闭包内容完全一致。
  const tampered = buildZip([
    { path: 'product/launcher/cli.mjs', bytes: good },
    { path: 'product/evil.exe', bytes: Buffer.from('MZ') },
    { path: 'closure.json', bytes: packed.closureBytes },
  ])
  assert.equal(tampered.ok, true, tampered.reason)

  const planned = planExtraction({
    archiveBytes: tampered.bytes,
    closureEntry: { path: 'closure.json', sha256: packed.closureSha256 },
  })
  assert.equal(planned.ok, false)
  assert.equal(planned.code, 'extract-unknown-executable')
  assert.match(planned.reason, /evil\.exe/)
  // 而**干净**的那一份必须通过——否则这条用例只证明了"什么都拒"。
  const clean = planExtraction({
    archiveBytes: packed.zipBytes,
    closureEntry: { path: 'closure.json', sha256: packed.closureSha256 },
  })
  assert.equal(clean.ok, true, clean.reason)
})

test('★ 回读发现包被换过：整包摘要不符', async (t) => {
  const ctx = setup(t)
  const payloadRoot = join(ctx.root, 'payload')
  mkdirSync(join(payloadRoot, 'product'), { recursive: true })
  writeFileSync(join(payloadRoot, 'product', 'a.txt'), 'hello')
  const outDir = join(ctx.root, 'out')
  const publish = buildPublish(publishArgs(ctx, { packageRoot: payloadRoot, packageZipPath: null, outDir }))
  writePublish(publish, outDir)
  // 托管上的包被换成了另一份字节。
  const fetchImpl = hostFrom(outDir, { full: true })
  const zipKey = 'releases/rel-1.1.0/legion-win-x64.zip'
  fetchImpl.files.set(zipKey, Buffer.from('PK\u0003\u0004 totally different bytes'))

  // 回读只探测前 4 KiB，所以"包被换过"由**下载端**的整包摘要拦住；
  // 这里断言的是"回读仍然能通过签名与清单校验"（包的字节完整性问题
  // 属于下载阶段，见 client.test.mjs 的「包被替换」用例）。
  const verified = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl, now: () => NOW_MS,
  })
  assert.equal(verified.checks.find((c) => c.name === 'release-signature').ok, true)
  // 而完整下载会算摘要 —— 用 transport 直接验证这一点。
  const transport = createTransport({ fetchImpl, now: () => NOW_MS })
  const host = createHostConfig({ origin: ORIGIN, prefix: PREFIX, channel: 'stable' }).host
  const download = await transport.downloadToFile(host, `${ORIGIN}${PREFIX}/${zipKey}`, {
    targetPath: join(ctx.root, 'downloaded.zip'),
    expectedSize: publish.release.package.sizeBytes,
    expectedSha256: publish.release.package.sha256,
  })
  assert.equal(download.ok, false)
  assert.ok(['net-digest-mismatch', 'net-too-large', 'net-too-small'].includes(download.code), download.code)
})

test('打包拒绝符号链接（闭包描述的是另一个位置的内容）', (t) => {
  const ctx = setup(t)
  const root = join(ctx.root, 'payload')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'real.txt'), 'x')
  try {
    symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'))
  } catch {
    return // Windows 上无权限创建符号链接时跳过
  }
  const packed = packDirectory({ root })
  assert.equal(packed.ok, false)
  assert.match(packed.reason, /符号链接/)
})

test('打包拒绝目录树里已有的 closure.json（避免覆盖调用方的数据）', (t) => {
  const ctx = setup(t)
  const root = join(ctx.root, 'payload')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'closure.json'), '{}')
  const packed = packDirectory({ root })
  assert.equal(packed.ok, false)
  assert.match(packed.reason, /已经有 closure\.json/)
})

test('两种包来源只能给一个（"用哪一个"必须有答案）', (t) => {
  const ctx = setup(t)
  assert.throws(
    () => buildPublish(publishArgs(ctx, { packageRoot: ctx.stage, outDir: ctx.root })),
    /只能给一个/,
  )
  assert.throws(
    () => buildPublish(publishArgs(ctx, { packageZipPath: null, packageRoot: null })),
    /需要 --package-zip/,
  )
})

// ---------------------------------------------------------------------------
// ③ 信任表
// ---------------------------------------------------------------------------

test('信任表：keyId 重复与非法 PEM 都被拒', (t) => {
  const ctx = setup(t)
  const good = buildTrustTable({
    sequence: 1,
    keys: [{ keyId: 'a', publicKeyPem: ctx.keys.publicKeyPem }],
  })
  assert.equal(good.keys.length, 1)
  assert.equal(good.sequence, 1)
  assert.throws(() => buildTrustTable({
    sequence: 1,
    keys: [{ keyId: 'a', publicKeyPem: ctx.keys.publicKeyPem }, { keyId: 'a', publicKeyPem: ctx.keys.publicKeyPem }],
  }), /重复/)
  assert.throws(() => buildTrustTable({ sequence: 1, keys: [{ keyId: 'a', publicKeyPem: 'not a key' }] }), /PEM/)
  assert.throws(() => buildTrustTable({ sequence: -1, keys: [] }), /sequence/)
})

test('端到端：信任表里没有那把钥匙 → 回读在验签这一步失败', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  writePublish(publish, outDir)
  const other = generateReleaseKeyPair({ keyId: 'release-2026-a' })
  const wrongTrust = createTrustStore([{ keyId: 'release-2026-a', publicKeyPem: other.publicKeyPem }])
  const result = await verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: wrongTrust, fetchImpl: hostFrom(outDir), now: () => NOW_MS,
  })
  assert.equal(result.ok, false)
  const check = result.checks.find((c) => c.name === 'feed-signature')
  assert.equal(check.ok, false)
  assert.match(check.detail, /bad-signature/)
})
