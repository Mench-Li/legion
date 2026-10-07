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
import { existsSync, readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { buildPublish, migrationPlanDigestFromArgs, packDirectory, parsePatchBindings, renderUploadPlan, resolveMigrationPlanDigest, writePublish } from './publish.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST, migrationPlanDigest, sampleMigrations } from '../../product/upgrade/migration.mjs'
import { verifyHost } from './verify-host.mjs'
import { buildTrustTable } from './trust-file.mjs'
import { createTrustStore, generateReleaseKeyPair, verifyEnvelope } from '../../product/update/envelope.mjs'
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
    // ★ 用**空计划的真摘要**，不是随手填的占位串。
    //
    //   这一行原先写 `'d'.repeat(64)` —— 一个谁也核对不了的占位值。发布端
    //   当时不做任何计算，所以它一路进了签名清单；而现在客户端会拿
    //   `migrationPlanDigest(migrations)` 去核对它，占位串会让每一次安装
    //   在动任何东西之前被挡下（`install-migration-plan-mismatch`）。
    migrationPlanDigest: EMPTY_MIGRATION_PLAN_DIGEST,
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
  const plan = renderUploadPlan(publish, join(ctx.root, 'out'), { target: 'production' })
  const immutableAt = plan.indexOf('第 1 步')
  const verifyAt = plan.indexOf('第 2 步')
  const channelAt = plan.indexOf('第 3 步')
  assert.ok(immutableAt >= 0 && verifyAt > immutableAt && channelAt > verifyAt, '上传计划的三步顺序不对')
  assert.match(plan, /scp/)
})

test('★★ 上传计划必须先教发布端"怎么知道该用几号 sequence"（设计 §9 第 4 步的"更大的"）', (t) => {
  // ★ 设计 §9 第 4 步的原话是「对通道发布加锁；生成**更大的** sequence」。
  //   而 `--sequence` 是显式给的——所以"更大的"这三个字要求发布端**先知道
  //   当前值**。在此之前计划里只有"第 4 步：确认 sequence 已经推进"，
  //   也就是**事后**核对：它能在传错之后告诉你错了，但拦不住你把错的那个传上去。
  //
  //   而抄错的方向有两种，**都很安静**：
  //     · 抄小了 → 客户端判 `feed-sequence-regression`，于是没有任何人去取这个
  //       版本，而发布端看到的一切正常；
  //     · 抄了同号 → 摘要不同 ⇒ `feed-sequence-conflict`，同样静默。
  //   两种都不会在发布端报错，只在客户端那一侧表现为"发了新版但没人更新"。
  //
  //   > 一条**事后**核对的读数，不能替代一条**事前**取值的方法。
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const plan = renderUploadPlan(publish, join(ctx.root, 'out'), { target: 'production' })
  const step0 = plan.indexOf('第 0 步')
  const step1 = plan.indexOf('第 1 步')
  assert.ok(step0 >= 0, `计划里没有"先读当前 sequence"这一步：\n${plan}`)
  assert.ok(step0 < step1, '"读当前 sequence"必须排在上传之前')
  const step0Text = plan.slice(step0, step1)
  assert.match(step0Text, /verify-host\.mjs/)
  assert.equal(/--expect-sequence/.test(step0Text), false,
    '第 0 步不该带 --expect-sequence：这一步的目的是**取值**，不是核对')
  assert.match(step0Text, /就是当前值/)
  // 本次用的号码也要写在计划里（供留档与人工比对）。
  assert.match(step0Text, new RegExp(`sequence = ${publish.summary.sequence}`))
})

test('★★★ 上传计划**不能**把目标猜成生产树（原先的默认值就是这个）', (t) => {
  // ★ 这是一个真实的、危险的缺陷：`renderUploadPlan` 原先的签名是
  //   `{ remoteRoot = 'root@117.72.146.36:/srv/legion-updates/production/legion' }`
  //   ——一个**写死的生产路径**，与通道无关。于是一次 `--channel internal`
  //   的测试发行会生成一份指向**生产树**的上传计划，还带着 `--prefix /legion`
  //   的回读命令（internal 的前缀其实是 `/test/legion`）。
  //
  //   照它执行的人会做对每一步，却把东西放错地方；而 verify-host 随后要么
  //   404、要么核到另一棵树——两种结果都不会告诉他"你传错了树"。
  //
  //   > 一份把目标猜错的部署指令，比一份要求你填目标的指令危险得多：
  //   > 前者会被人照着执行。
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  assert.throws(() => renderUploadPlan(publish, outDir), /显式.*上传目标|没有默认值/,
    '不给目标时仍然渲染出了一份计划——那正是"猜目标"的老毛病')
  assert.throws(() => renderUploadPlan(publish, outDir, { target: 'staging' }), /未知的上传目标/)
  // 两种给法不能同时用（"以哪个为准"没有答案）。
  assert.throws(
    () => renderUploadPlan(publish, outDir, { target: 'test', remoteRoot: 'r', prefix: '/p' }),
    /只能给一种/,
  )
})

test('★★★ internal 通道的发行**不能**发到生产树（配好的客户端永远读不到）', (t) => {
  const ctx = setup(t)
  const internal = buildPublish(publishArgs(ctx, { channel: 'internal' }))
  const outDir = join(ctx.root, 'out')
  assert.throws(
    () => renderUploadPlan(internal, outDir, { target: 'production' }),
    /应该发到 test 那棵树/,
  )
  const plan = renderUploadPlan(internal, outDir, { target: 'test' })
  // 目标树与前缀都要**是 internal 那一套**。
  assert.match(plan, /legion-updates\/test\/legion/)
  assert.match(plan, /--prefix \/test\/legion/)
  assert.equal(plan.includes('/srv/legion-updates/production'), false, '测试通道的计划里出现了生产路径')
})

test('★★ 没有目标时写出的 upload-plan.txt **一行 scp 都没有**', (t) => {
  // 产物照写（构建与"决定发到哪棵树"是两件事），但那份文件必须是**拒答**，
  // 不是半成品计划：一份可以被误执行的半成品，比一份明确的拒答危险得多。
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  const written = writePublish(publish, outDir, { log: () => {} })
  assert.equal(written.planned, false)
  const notice = readFileSync(written.plan, 'utf8')
  // ★ 判据是"没有**可执行的命令行**"，不是"没有出现 scp 这三个字母"——
  //   后者会被解释文字里的 "这里一行 scp 都没有" 判红，那样一条分不清
  //   "命令"与"关于命令的话"的断言，会在正确的那一件事上先响。
  const commandLines = notice.split('\n').filter((line) => /^\s*(scp|rsync|ssh)\b/.test(line))
  assert.deepEqual(commandLines, [], `拒答文件里有可执行的命令：${JSON.stringify(commandLines)}`)
  assert.match(notice, /不是指令/)
  assert.match(notice, /--target test\|production/)
  // 产物仍然真的写出来了。
  assert.equal(existsSync(join(outDir, 'channel', `feeds/${publish.summary.channel}/win-x64.json`)), true)
})

test('★★ 给了目标时 planned=true，且计划指向那棵树', (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx))
  const outDir = join(ctx.root, 'out')
  const written = writePublish(publish, outDir, { target: 'production', log: () => {} })
  assert.equal(written.planned, true)
  const plan = readFileSync(written.plan, 'utf8')
  assert.match(plan, /legion-updates\/production\/legion/)
  assert.match(plan, /--prefix \/legion/)
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

test('★★★ 补丁层成对表进发行清单（客户端那条判据的唯一来源）', async (t) => {
  const ctx = setup(t)
  // 不给 → 空表。这是**合法**的，后果是客户端判 `unverified` 并拒绝安装。
  const withoutBindings = buildPublish(publishArgs(ctx))
  assert.deepEqual([...withoutBindings.release.dshPatchBindings], [])
  // 而"没给"与"给了但表坏了"必须是两个不同的读数。
  assert.equal(withoutBindings.release.dshPatchBindings.length, 0)

  // 给了 → 进清单，并被 `validateRelease` 接受。
  const withBindings = buildPublish(publishArgs(ctx, {
    dshPatchBindings: [{ dshVersion: '0.8.2', compositionPatchVersion: 2 }],
  }))
  assert.deepEqual(withBindings.release.dshPatchBindings.map((b) => ({ ...b })), [
    { dshVersion: '0.8.2', compositionPatchVersion: 2 },
  ])
  // ★ 排序：它进签名覆盖的字节，所以同输入必须同字节。
  const sorted = buildPublish(publishArgs(ctx, {
    dshPatchBindings: [
      { dshVersion: '0.9.0', compositionPatchVersion: 1 },
      { dshVersion: '0.8.2', compositionPatchVersion: 3 },
      { dshVersion: '0.8.2', compositionPatchVersion: 2 },
    ],
  }))
  assert.deepEqual(sorted.release.dshPatchBindings.map((b) => `${b.dshVersion}/${b.compositionPatchVersion}`),
    ['0.8.2/2', '0.8.2/3', '0.9.0/1'])

  // 形状不对的表在**发布**时就被拒（而不是变成客户端一条无法归因的失败）。
  assert.throws(() => buildPublish(publishArgs(ctx, { dshPatchBindings: [{ dshVersion: '', compositionPatchVersion: 1 }] })), /dshPatchBindings/)
  assert.throws(() => buildPublish(publishArgs(ctx, { dshPatchBindings: [{ dshVersion: '0.8.2', compositionPatchVersion: 0 }] })), /dshPatchBindings/)
})

test('★ --dsh-patch-bindings 的解析：逗号分隔，形状在发布时拒', () => {
  assert.deepEqual(parsePatchBindings(undefined), [])
  assert.deepEqual(parsePatchBindings(true), [])
  assert.deepEqual(parsePatchBindings(''), [])
  assert.deepEqual(parsePatchBindings('0.8.2:2').map((b) => ({ ...b })), [{ dshVersion: '0.8.2', compositionPatchVersion: 2 }])
  assert.deepEqual(
    parsePatchBindings('0.8.2:2, 0.9.0:1').map((b) => `${b.dshVersion}/${b.compositionPatchVersion}`),
    ['0.8.2/2', '0.9.0/1'],
  )
  // DSH 版本里有冒号的写法（例如带 build 元数据）：取**最后一个**冒号，
  // 因为补丁版本在右边。
  assert.deepEqual(parsePatchBindings('0.8.2+build:7:3').map((b) => ({ ...b })),
    [{ dshVersion: '0.8.2+build:7', compositionPatchVersion: 3 }])
  // 坏形状一律抛，而不是变成一个永远匹配不上的表项。
  for (const bad of ['0.8.2', ':2', '0.8.2:', '0.8.2:x', '0.8.2:-1', '0.8.2:2.5']) {
    assert.throws(() => parsePatchBindings(bad), /dsh-patch-bindings/, `${bad} 被接受了`)
  }
})

test('★ 补丁层成对表进签名覆盖的字节：改了它签名就不过', async (t) => {
  const ctx = setup(t)
  const publish = buildPublish(publishArgs(ctx, {
    dshPatchBindings: [{ dshVersion: '0.8.2', compositionPatchVersion: 2 }],
  }))
  // 签名覆盖的字节就是上传清单里那一条 `manifest.json`。
  // `verifyEnvelope` 收的是**序列化后的字节**（它自己按 ENVELOPE_PREFIX 解析），
  // 不是先 JSON.parse 出来的对象。
  const manifestEntry = publish.immutable.find((item) => item.path.endsWith('/manifest.json'))
  assert.notEqual(manifestEntry, undefined)
  const verified = verifyEnvelope(manifestEntry.bytes, { trust: ctx.trustStore, nowMs: NOW_MS })
  assert.equal(verified.ok, true, verified.reason)
  assert.deepEqual(verified.payload.dshPatchBindings.map((b) => ({ ...b })),
    [{ dshVersion: '0.8.2', compositionPatchVersion: 2 }])

  // ★ 改一个成对项 → 签名不过（它确实在签名覆盖的字节里）。
  const text = manifestEntry.bytes.toString('utf8')
  const tamperedText = text.replace('"0.8.2"', '"0.9.9"')
  assert.notEqual(tamperedText, text, '测试没有真的改到成对表')
  const rejected = verifyEnvelope(Buffer.from(tamperedText, 'utf8'), { trust: ctx.trustStore, nowMs: NOW_MS })
  assert.equal(rejected.ok, false, '改了补丁层成对表签名却仍然通过')
})

test('★★★ 迁移计划摘要由**同一个算法**算出（发布端与客户端不能各写一份）', (t) => {
  const ctx = setup(t)
  // 不给 → 空计划的**固定**摘要，不是随手填的占位串。
  assert.equal(EMPTY_MIGRATION_PLAN_DIGEST, migrationPlanDigest([]))
  const bare = buildPublish(publishArgs(ctx))
  assert.equal(bare.release.migrationPlanDigest, EMPTY_MIGRATION_PLAN_DIGEST,
    '不给计划时发行清单里的摘要不是空计划的摘要：客户端会在安装前挡下它')

  // 给一份计划文件 → 摘要 = `migrationPlanDigest(那份计划)`。
  const planPath = join(ctx.root, 'migration-plan.json')
  const plan = sampleMigrations().slice(0, 2).map((m) => ({
    version: m.version, name: m.name, compatibility: m.compatibility, checksum: m.checksum,
  }))
  writeFileSync(planPath, JSON.stringify(plan), 'utf8')
  const withPlan = buildPublish(publishArgs(ctx, { migrationPlanDigest: null, migrationPlan: plan }))
  assert.equal(withPlan.release.migrationPlanDigest, migrationPlanDigest(plan))

  // 显式摘要优先（兼容旧用法），而坏形状在发布时就拒。
  const explicit = buildPublish(publishArgs(ctx, { migrationPlanDigest: 'a'.repeat(64) }))
  assert.equal(explicit.release.migrationPlanDigest, 'a'.repeat(64))
  assert.throws(
    () => resolveMigrationPlanDigest({ migrationPlanDigest: 'not-a-digest' }),
    /64 位小写十六进制/,
  )
  // 计划文件不存在 / 不是数组 → 明确拒绝（而不是静默回落到空摘要）。
  assert.throws(() => migrationPlanDigestFromArgs(join(ctx.root, 'nope.json'), undefined), /读不出来/)
  const notArray = join(ctx.root, 'not-array.json')
  writeFileSync(notArray, '{"nope":1}', 'utf8')
  assert.throws(() => migrationPlanDigestFromArgs(notArray, undefined), /必须是一个数组/)
})

test('formatBytes 的边界占位', () => {})

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
