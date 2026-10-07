// product/update/platform-build.test.mjs
// ============================================================================
// Windows 版本门禁 —— 第四个"判据的输入没有生产方"
//
// `release.mjs` 里那条「需要 Windows build N，本机是 M」的判据由
// `validateRelease(payload, { minWindowsBuildRequired })` 驱动，而在此之前
// **全仓没有任何调用方传过这个参数**（`client.mjs` 只传 `expect`）。
// 于是那条判据在生产里不可达：一份声明只支持 Win11（`minWindowsBuild: 22000`）
// 的发行，会在一台 19045（Win10 22H2）的机器上被接受并安装。
//
// 同一批里 `install.mjs` 把 `windowsBuild` 传给了 `runPreflight`，而
// `runPreflight` 从不读它——它是死参数。两处加起来：操作系统的版本门禁
// 从来没有生效过。
//
//   > 一个"从来不生效的门禁"与一个"没有这个门禁"，在用户能观察到的行为上
//   > 是同一个东西。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  PLATFORM_BUILD_CHECKED, PLATFORM_BUILD_CODES,
  checkLocalWindowsBuild, currentWindowsBuild, parseWindowsBuild,
} from './platform-build.mjs'
import { createUpdateClient } from './client.mjs'
import { validateRelease } from './release.mjs'
import { canonicalJson } from './canonical.mjs'
import { createTrustStore, generateReleaseKeyPair, serializeEnvelope, signEnvelope } from './envelope.mjs'
import { FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL, createHostConfig } from './host.mjs'
import { Readable } from 'node:stream'

const ROOT = new URL('../../', import.meta.url)
const WIN = Object.freeze({ hostPlatform: 'win32', platform: 'win32' })

// ---------------------------------------------------------------------------
// ① 解析
// ---------------------------------------------------------------------------

test('★ 真实形状：`<major>.<minor>.<build>[.<revision>]`', () => {
  assert.equal(parseWindowsBuild('10.0.19045'), 19045)
  assert.equal(parseWindowsBuild('10.0.22631.4890'), 22631)
  assert.equal(parseWindowsBuild('6.3.9600'), 9600)          // Win 8.1
  assert.equal(parseWindowsBuild('  10.0.22000  '), 22000)
})

test('★★ 解析不出来必须 `null`，**不是** 0 也不是抛', () => {
  // `0` 会让 `minWindowsBuild > 0` 永远成立 → **每一台**机器都被判成不支持，
  // 而症状是"升级总是说系统版本不够"，排查方向完全错。
  for (const value of [null, undefined, 42, '', '10.0', '10.0.', '10.0.0',
    'Windows 10', '10.0.x', '6.8.0-45-generic', '10.0.19045.1.2.3', '10.0.9999999999']) {
    assert.equal(parseWindowsBuild(value), null, `${JSON.stringify(value)} 解析成了非 null`)
  }
})

test('`currentWindowsBuild` 只在 win32 上有结论', () => {
  assert.equal(currentWindowsBuild({ platform: 'linux' }), null)
  assert.equal(currentWindowsBuild({ platform: 'darwin' }), null)
  assert.equal(currentWindowsBuild({ platform: 'win32', release: '10.0.19045' }), 19045)
  assert.equal(currentWindowsBuild({ platform: 'win32', release: 'nope' }), null)
})

// ---------------------------------------------------------------------------
// ② 三态判据
// ---------------------------------------------------------------------------

test('★ 判据三态：通过 / 明确不支持 / 读不出本机版本', () => {
  const pass = checkLocalWindowsBuild({ ...WIN, release: '10.0.22631', minWindowsBuild: 19045 })
  assert.equal(pass.ok, true)
  assert.equal(pass.skipped, false)
  assert.equal(pass.local, 22631)

  const fail = checkLocalWindowsBuild({ ...WIN, release: '10.0.19045', minWindowsBuild: 22000 })
  assert.equal(fail.ok, false)
  assert.equal(fail.code, PLATFORM_BUILD_CODES.UNSUPPORTED)
  assert.match(fail.reason, /22000/)
  assert.match(fail.reason, /19045/)

  // ★ 恰好等于下限必须通过（`>=` 不是 `>`）。
  assert.equal(checkLocalWindowsBuild({ ...WIN, release: '10.0.19045', minWindowsBuild: 19045 }).ok, true)
})

test('★★ 读不出本机版本是**失败**，不是跳过（否则门禁静默打开）', () => {
  const unreadable = checkLocalWindowsBuild({ ...WIN, release: 'weird-kernel', minWindowsBuild: 19045 })
  assert.equal(unreadable.ok, false, '读不出本机版本被当成了"不用检查"')
  assert.equal(unreadable.code, PLATFORM_BUILD_CODES.UNPARSEABLE)
  assert.match(unreadable.reason, /读不出来.*支持|两件事/)
})

test('★ 跳过时必须**说明**为什么跳过，并且带 `skipped: true`', () => {
  const noFloor = checkLocalWindowsBuild({ ...WIN, release: 'weird', minWindowsBuild: null })
  assert.equal(noFloor.ok, true)
  assert.equal(noFloor.skipped, true)
  assert.match(noFloor.reason, /没有声明 minWindowsBuild/)

  const linuxTarget = checkLocalWindowsBuild({ hostPlatform: 'win32', platform: 'linux', minWindowsBuild: 1 })
  assert.equal(linuxTarget.skipped, true)
  assert.match(linuxTarget.reason, /不是 win32/)
})

test('★★ `hostPlatform` 与目标 `platform` 是两件事（CI 上跑 Linux 测 win32 分支）', () => {
  // 这条守的是一个具体的可移植性问题：Linux CI 上声明 `platform: 'win32'`
  // 的用例，`os.release()` 是 `6.8.0-45-generic` —— 若把"读不出 Windows build"
  // 当失败，**每一条这样的用例都会红**，而它们测的是别的东西。
  const cross = checkLocalWindowsBuild({ hostPlatform: 'linux', platform: 'win32', minWindowsBuild: 99999 })
  assert.equal(cross.ok, true)
  assert.equal(cross.skipped, true)
  assert.match(cross.reason, /linux/)
})

// ---------------------------------------------------------------------------
// ③ 接线：client 真的会用这条判据
// ---------------------------------------------------------------------------

/**
 * 一个最小的"检查更新"调用链所需的环境。
 *
 * 这一条不测完整下载，只走到**第 3 步（校验发行清单）**——版本门禁就在那里。
 * 所以静态托管只要给出通道清单与发行清单两个响应。
 */
function clientHarness({ minWindowsBuild, kernelRelease, hostPlatform = 'win32', productVersion = '1.1.0' }) {
  
  const keys = generateReleaseKeyPair({ keyId: 'k1' })
  const trustStore = createTrustStore([{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }])
  const origin = 'https://updates.example.com'
  const prefix = '/legion'

  const productManifest = {
    manifestFormat: 'legion/version-manifest@1',
    productVersion, legionVersion: productVersion, dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2, runtimeContractVersion: 1, packProtocolVersion: 1,
    schemaVersion: 1, channel: 'stable',
  }
  const releasePayload = {
    format: 'legion/update-release@1',
    releaseId: 'rel-1.1.0',
    productVersion,
    channel: 'stable',
    platform: 'win32',
    arch: 'x64',
    productManifest,
    productManifestSha256: createHash('sha256')
      .update(Buffer.from(canonicalJson(productManifest), 'utf8')).digest('hex'),
    supportedFromVersions: ['1.0.0'],
    minWindowsBuild,
    requiredFreeBytes: 1024 * 1024,
    dshPatchBindings: [{ dshVersion: '0.8.3', compositionPatchVersion: 2 }],
    package: { path: 'releases/rel-1.1.0/legion-win-x64.zip', sizeBytes: 1024, sha256: 'b'.repeat(64) },
    installer: { path: 'releases/rel-1.1.0/setup.exe', sizeBytes: 1024, sha256: 'c'.repeat(64) },
    notes: { path: 'releases/rel-1.1.0/notes.txt', sizeBytes: 8, sha256: 'd'.repeat(64) },
    migrationPlanDigest: 'e'.repeat(64),
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  }
  const releaseBytes = Buffer.from(serializeEnvelope(signEnvelope(releasePayload, { privateKeyPem: keys.privateKeyPem, keyId: 'k1' })), 'utf8')
  const releaseSha = createHash('sha256').update(releaseBytes).digest('hex')
  const feedPayload = {
    format: 'legion/update-feed@1',
    channel: 'stable', platform: 'win32', arch: 'x64',
    sequence: 5, issuedAt: '2026-10-04T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z',
    releaseId: 'rel-1.1.0', productVersion, manifestSha256: releaseSha,
    // 通道清单必须给出**不可变清单的路径**：客户端按它去取发行清单。
    manifestPath: 'releases/rel-1.1.0/manifest.json',
    requiredFreeBytes: 1024 * 1024,
  }
  const feedBytes = Buffer.from(serializeEnvelope(signEnvelope(feedPayload, { privateKeyPem: keys.privateKeyPem, keyId: 'k1' })), 'utf8')

  // 目录布局与 `client.test.mjs` 一致：`feeds/<channel>/<platformToken>-<arch>.json`。
  const files = new Map([
    ['feeds/stable/win-x64.json', { bytes: feedBytes, cache: FEED_CACHE_CONTROL }],
    ['releases/rel-1.1.0/manifest.json', { bytes: releaseBytes, cache: RELEASE_CACHE_CONTROL }],
  ])
  const cacheDir = mkdtempSync(join(tmpdir(), 'legion-platbuild-'))
  const fetchImpl = async (url) => {
    const relative = url.slice((origin + prefix + '/').length)
    const entry = files.get(relative)
    if (entry === undefined) return response(404, { 'cache-control': 'no-store' }, Buffer.alloc(0))
    return response(200, { 'cache-control': entry.cache, 'content-length': String(entry.bytes.length) }, entry.bytes)
  }
  const client = createUpdateClient({
    config: {
      ok: true, usable: true, code: null, reason: null, channel: 'stable',
      // `createHostConfig` 返回 `{ ok, host }`，所以要取 `.host`。
      // `feedUrl` 用的是 host 上的 channel/platform/arch（含 platformToken），
      // 少了它们会拼出 `feeds/undefined/undefined-undefined.json`。
      host: createHostConfig({ origin, prefix, channel: 'stable' }).host,
      trustStore, trustEntries: [], trustSequence: 1, checkOnStartup: true,
    },
    cacheDir,
    currentVersion: '1.0.0',
    platform: 'win32',
    arch: 'x64',
    hostPlatform,
    localKernelRelease: kernelRelease,
    fetchImpl,
    now: () => Date.parse('2026-10-05T00:00:00Z'),
  })
  return { client, cacheDir }
}

test('★★★ 接线：目标要求更高的 Windows build 时，检查**失败**（门禁真的生效）', async (t) => {
  const harness = clientHarness({ minWindowsBuild: 22000, kernelRelease: '10.0.19045' })
  t.after(() => rmSync(harness.cacheDir, { recursive: true, force: true }))
  const result = await harness.client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'failed', `要求 22000 而本机 19045，却给出了 ${result.outcome}`)
  assert.equal(result.code, 'update-unsupported-platform')
  assert.match(result.reason, /22000/)
  assert.match(result.reason, /19045/)
})

test('★★★ 接线：本机满足下限时正常发现候选', async (t) => {
  const harness = clientHarness({ minWindowsBuild: 19045, kernelRelease: '10.0.22631' })
  t.after(() => rmSync(harness.cacheDir, { recursive: true, force: true }))
  const result = await harness.client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'available', `${result.outcome}/${result.code ?? ''} ${result.reason ?? ''}`)
})

test('★★★ 接线：读不出本机 build 时**失败**（不是放行）', async (t) => {
  const harness = clientHarness({ minWindowsBuild: 19045, kernelRelease: '6.8.0-45-generic' })
  t.after(() => rmSync(harness.cacheDir, { recursive: true, force: true }))
  const result = await harness.client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'failed', '读不出本机 build 却放行了')
  assert.equal(result.code, 'update-unsupported-platform')
  assert.match(result.reason, /读不出来|无法确认/)
})

test('★★★ 接线：非 Windows 主机上这条判据跳过（可移植性）', async (t) => {
  // 同一条链路在 Linux CI 上必须照常走到"发现候选"，否则会把
  // "Windows 版本"这件事变成"能不能跑测试"这件事。
  const harness = clientHarness({ minWindowsBuild: 99999, kernelRelease: '6.8.0-45-generic', hostPlatform: 'linux' })
  t.after(() => rmSync(harness.cacheDir, { recursive: true, force: true }))
  const result = await harness.client.check({ trigger: 'manual' })
  assert.equal(result.outcome, 'available', `${result.outcome}/${result.code ?? ''} ${result.reason ?? ''}`)
})

// ---------------------------------------------------------------------------
// ④ 那条判据在 `validateRelease` 里也真的可达了
// ---------------------------------------------------------------------------

test('★★ `validateRelease` 的 minWindowsBuildRequired 分支不再是死代码', async () => {
  
  const keys = generateReleaseKeyPair({ keyId: 'k1' })
  void keys
  // 这一条读**客户端源码**，确认它真的把读数传给了 `validateRelease`。
  // `release.mjs` 的那条分支由这个参数驱动，而"没有任何调用方传它"正是
  // 这个缺陷的全部内容——所以判据要挂在调用点上，不是挂在分支上。
  const source = readFileSync(fileURLToPath(new URL('client.mjs', import.meta.url)), 'utf8')
  assert.match(source, /minWindowsBuildRequired/, 'client.mjs 没有把本机 build 传给 validateRelease')
  assert.match(source, /checkLocalWindowsBuild/, 'client.mjs 没有调用版本判据')

  // 而 `validateRelease` 那条分支本身是可达的。
  const payload = {
    format: 'legion/update-release@1',
    releaseId: 'rel-1.1.0', productVersion: '1.1.0', channel: 'stable',
    platform: 'win32', arch: 'x64',
    productManifest: {
      manifestFormat: 'legion/version-manifest@1', productVersion: '1.1.0', legionVersion: '1.1.0',
      dshVersion: '0.8.3', dshCompositionPatchVersion: 2, runtimeContractVersion: 1,
      packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
    },
    productManifestSha256: createHash('sha256')
      .update(Buffer.from(canonicalJson({
        manifestFormat: 'legion/version-manifest@1', productVersion: '1.1.0', legionVersion: '1.1.0',
        dshVersion: '0.8.3', dshCompositionPatchVersion: 2, runtimeContractVersion: 1,
        packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
      }), 'utf8')).digest('hex'),
    supportedFromVersions: ['1.0.0'],
    minWindowsBuild: 22000,
    requiredFreeBytes: 1024,
    dshPatchBindings: [],
    package: { path: 'releases/rel-1.1.0/a.zip', sizeBytes: 1, sha256: 'b'.repeat(64) },
    installer: { path: 'releases/rel-1.1.0/b.exe', sizeBytes: 1, sha256: 'c'.repeat(64) },
    notes: { path: 'releases/rel-1.1.0/c.txt', sizeBytes: 1, sha256: 'd'.repeat(64) },
    migrationPlanDigest: 'e'.repeat(64),
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  }
  const rejected = validateRelease(payload, { minWindowsBuildRequired: 19045 })
  assert.equal(rejected.ok, false, '需要 22000、本机 19045 却没有被拒')
  assert.match(rejected.reason, /22000/)
  assert.match(rejected.reason, /19045/)
  // 满足时通过。
  assert.equal(validateRelease(payload, { minWindowsBuildRequired: 22631 }).ok, true)
})

test('模块自检全绿', () => {
  assert.deepEqual([...PLATFORM_BUILD_CHECKED.problems], [])
  assert.equal(PLATFORM_BUILD_CHECKED.ok, true)
})

// 延迟到用例里再 import：这个文件的顶层只关心判据。
const envelopeApi = await import('./envelope.mjs')
const cryptoApi = await import('node:crypto')
const canonicalApi = await import('./canonical.mjs')
const fsApi = await import('node:fs')
const osApi = await import('node:os')
const pathApi = await import('node:path')

/** 与 `client.test.mjs` 同形：transport 读的是 `body` 流与 `headers.entries()`，不是 `text()`。 */
function response(status, headers, bytes) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    body: Readable.from(bytes.length === 0 ? [] : [bytes]),
  }
}
