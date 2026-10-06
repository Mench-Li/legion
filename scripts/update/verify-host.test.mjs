// scripts/update/verify-host.test.mjs
// ============================================================================
// 公网回读核对里的**产物那一段**（`verify-host.mjs` 的第 ③ 组检查）
//
// ★★ 这个文件为什么单独存在：那三条检查（`artifact-package` /
//    `artifact-installer` / `artifact-notes`）此前**在任何地方都没有被断言过**。
//
//    而更关键的是：它们**只有一半的分支是活的**。
//
//      · `publish.test.mjs` 里那个 `hostFrom` 替身把**每一个响应都截到 4 KiB**，
//        并声明 `content-length` = 截断后的长度：
//
//            // 只回 4 KiB：与 `verify-host` 的探测窗口一致。
//            const slice = bytes.subarray(0, 4096)
//            headers: [['cache-control', cache], ['content-length', String(slice.length)]]
//
//      · 于是传输层永远走 `head.ok` 那条分支。
//      · 而**真实发布**里三个产物都远大于 4 KiB：服务器声明真实大小 ⇒
//        `transport.fetchBytes` 在**读 body 之前**就返回 `net-too-large`
//        ⇒ 走的是 `TOO_LARGE` 那条分支。
//
//      > 一个把响应裁剪到"实现恰好能接受的长度"的替身，
//      > 会让**只有真实使用才会走到**的那条分支永远不被执行。
//
//    后果很具体：如果那条分支写错了（比如错误码拼成别名），
//    **所有测试照样全绿**，而发布工程师在"第 2 步：公网回读核对"上
//    对**每一次真实发布**都得到一个 FAIL——而上传计划写着
//    「必须在这一步通过之后才做第 3 步」。
//
// 所以这里的替身**按真实服务器的方式作答**：声明**真实**的 `Content-Length`。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { buildPublish } from './publish.mjs'
import { verifyHost } from './verify-host.mjs'
import { FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL } from '../../product/update/host.mjs'
import { createTrustStore, generateReleaseKeyPair } from '../../product/update/envelope.mjs'
import { TRANSPORT_CODES } from '../../product/update/transport.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST } from '../../product/upgrade/migration.mjs'

const ORIGIN = 'https://updates.example.com'
const PREFIX = '/legion'
const NOW_MS = Date.parse('2026-10-04T12:00:00Z')
const PRODUCT_VERSION = '1.1.0'
const RELEASE_ID = 'rel-1.1.0'

/** 一个**故意做大**的升级包：远大于 `verify-host` 的 4 KiB 探测窗口。 */
const BIG_PACKAGE_BYTES = 256 * 1024

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-verify-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stage = join(root, 'stage')
  mkdirSync(stage, { recursive: true })

  // ★ 包是 256 KiB（真实发布里它会是几十 MB）。安装器与说明保持小，
  //   这样**两类产物**（超窗口的与不超的）在这一组用例里都有代表。
  const zipPath = join(stage, 'legion-win-x64.zip')
  writeFileSync(zipPath, Buffer.alloc(BIG_PACKAGE_BYTES, 0x50))
  const installerPath = join(stage, 'Legion-Setup-win-x64.exe')
  writeFileSync(installerPath, Buffer.from('MZ pretend installer'))
  const notesPath = join(stage, 'notes.zh-CN.txt')
  writeFileSync(notesPath, Buffer.from('• 修复若干问题\n', 'utf8'))

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
  const keys = generateReleaseKeyPair({ keyId: 'release-2026-a' })
  const trustStore = createTrustStore([{ keyId: 'release-2026-a', publicKeyPem: keys.publicKeyPem }])

  const publish = buildPublish({
    productVersion: PRODUCT_VERSION,
    channel: 'stable',
    releaseId: RELEASE_ID,
    productManifest,
    supportedFromVersions: ['1.0.0'],
    packageZipPath: zipPath,
    installerPath,
    notesPath,
    migrationPlanDigest: EMPTY_MIGRATION_PLAN_DIGEST,
    rollbackPolicy: 'program-only',
    keyId: 'release-2026-a',
    privateKeyPem: keys.privateKeyPem,
    sequence: 43,
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  })
  return { root, publish, trustStore }
}

/**
 * 一个**如实作答**的托管替身。
 *
 * ★ 与 `publish.test.mjs` 的 `hostFrom` 有两处关键差别，两处都影响"能不能走到
 *   真实发布走的那条分支"：
 *
 *   ① **不裁剪响应**：`content-length` 是文件的真实长度。原来那个替身把每个
 *      响应都截到 4 KiB 并声明截断后的长度，于是传输层永远走 `head.ok`。
 *   ② ★★★ **headers 同时提供 `.get()` 与 `.entries()`**。
 *
 *      真实的 `fetch` 返回的 `response.headers` 是一个 `Headers` 实例，
 *      `.get('content-length')` 是**唯一**被 `transport` 的
 *      `declaredLengthOf()`（→ `host.lookupHeader()`）使用的方式：
 *
 *          if (typeof headers.get === 'function') return headers.get(name)
 *          for (const key of Object.keys(headers)) …      // ← 只在这里兜底
 *
 *      只给 `entries()` 的替身会让 `lookupHeader` 返回 `null` ⇒ 传输层认为
 *      "服务器没有声明长度" ⇒ 它**照读 body**，那条 `net-too-large` 分支
 *      永远不会发生。
 *
 *      > 一个只实现了 `entries()` 的 headers 替身，会让
 *      > "服务器声明了 50 MB" 与 "服务器什么都没声明" 在被测代码眼里**一样**。
 *
 * `overrides` 可以按路径改行为，用来造"文件不在"、"缓存头不对"等情形。
 */
function headersOf(pairs) {
  const map = new Map(pairs.map(([k, v]) => [k.toLowerCase(), v]))
  return {
    get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null),
    entries: () => [...map.entries()],
  }
}

function realisticHost(publish, { overrides = {} } = {}) {
  const files = new Map()
  // ★★ `publish.immutable` 的条目有两种形状，**大产物刻意不带内存副本**：
  //
  //     { path: 'releases/…/manifest.json', bytes: <Buffer> }              ← 小文件，内联
  //     { path: 'releases/…/legion-win-x64.zip', bytes: null, localPath }  ← 大产物，只在盘上
  //
  //   所以"从 `entry.bytes` 建托管"的替身会让三个产物的字节变成 `null`
  //   —— 而症状是传输层里一句 `Cannot read properties of null (reading 'length')`，
  //   被包成"网络不可达"。
  //
  //   > 一个假定"发布清单里的每个条目都带着字节"的替身，
  //   > 会在**恰好那三个大产物**上取到 `null`——而它们是这段代码唯一要核的东西。
  for (const entry of [...publish.immutable, ...publish.mutable]) {
    files.set(entry.path, entry.bytes ?? readFileSync(entry.localPath))
  }

  const requests = []
  async function fetchImpl(url) {
    requests.push(url)
    const relative = url.slice(`${ORIGIN}${PREFIX}/`.length)
    const override = overrides[relative]
    if (typeof override === 'function') return override(relative, files.get(relative))

    const bytes = files.get(relative)
    if (bytes === undefined) {
      return { status: 404, headers: headersOf([['cache-control', 'no-store']]), body: Readable.from([]) }
    }
    const cache = relative.startsWith('feeds/') ? FEED_CACHE_CONTROL : RELEASE_CACHE_CONTROL
    // ★ 真实长度，不裁剪；而且**通过 `.get()` 可见**（真实 fetch 就是这样）。
    return {
      status: 200,
      headers: headersOf([['cache-control', cache], ['content-length', String(bytes.length)]]),
      body: Readable.from([bytes]),
    }
  }
  fetchImpl.requests = requests
  fetchImpl.files = files
  return fetchImpl
}

function run(publish, ctx, options = {}) {
  return verifyHost({
    origin: ORIGIN, prefix: PREFIX, channel: 'stable',
    trustStore: ctx.trustStore, fetchImpl: realisticHost(publish, options),
    now: () => NOW_MS,
  })
}

const checkOf = (result, name) => result.checks.find((c) => c.name === name)

// ---------------------------------------------------------------------------
// ① ★★★ 真实大小的产物：走 `net-too-large` 分支，仍然必须判"可达"
// ---------------------------------------------------------------------------

test('★★★ 超过探测窗口的产物（真实发布的样子）必须判"可达"', async (t) => {
  // ★ 这条用例就是那个此前不存在的东西：`publish.test.mjs` 的替身把响应
  //   截到 4 KiB，所以它**永远**走不到 `net-too-large` 这条分支。
  //   而真实发布的包是几十 MB ⇒ **每一次真实回读都走这条分支**。
  const ctx = setup(t)
  const result = await run(ctx.publish, ctx)

  const pkg = checkOf(result, 'artifact-package')
  assert.ok(pkg !== undefined, '根本没有 artifact-package 这条检查')
  assert.equal(pkg.ok, true,
    `真实大小的包被判成不可达：${pkg.detail}\n`
    + '★ 这会让发布工程师在"第 2 步：公网回读核对"上对每一次真实发布都拿到 FAIL')
  // ★★ 关键：理由必须自报走的是**超过探测窗口**那条分支。
  //
  //    只断言 `pkg.ok === true` 是不够的：一个"没声明 content-length"的替身
  //    会让传输层照读 body、走 `head.ok` 分支，那时这条用例**照样全绿**，
  //    而它声称覆盖的那条分支一次都没跑到。
  //
  //    > 一条"结果为真"的判据，与一条"确实走了那条分支"的判据，
  //    > 在被测分支根本没执行时读数一样。
  assert.match(pkg.detail, /探测窗口/,
    `包的理由里没有"探测窗口"——那说明它走的不是 TOO_LARGE 分支，`
    + `这条用例没有覆盖到真实发布走的那条路。实际：${pkg.detail}`)

  // 而这个包确实超过了探测窗口——否则这条用例并没有测到那条分支。
  assert.ok(ctx.publish.release.package.sizeBytes > 4096,
    `包只有 ${ctx.publish.release.package.sizeBytes} 字节，超不过 4 KiB 探测窗口，用例没有分辨力`)

  // 另外两个产物也不许因此变红。
  assert.equal(checkOf(result, 'artifact-installer').ok, true, checkOf(result, 'artifact-installer').detail)
  assert.equal(checkOf(result, 'artifact-notes').ok, true, checkOf(result, 'artifact-notes').detail)
  assert.equal(result.ok, true,
    `整轮回读没通过：\n${result.checks.filter((c) => !c.ok).map((c) => `  ${c.name}: ${c.detail}`).join('\n')}`)
})

test('★★ 小产物（不超窗口）走"真的读回内容"那条分支，并报出读到的字节数', async (t) => {
  const ctx = setup(t)
  const result = await run(ctx.publish, ctx)

  const notes = checkOf(result, 'artifact-notes')
  assert.equal(notes.ok, true, notes.detail)
  const declared = ctx.publish.release.notes.sizeBytes
  assert.ok(declared < 4096, `说明有 ${declared} 字节，本意是"小产物"`)
  // ★ 这一条把两条分支**区分开**：小产物报告的是"已回读 N 字节"。
  assert.match(notes.detail, new RegExp(`${declared} 字节已回读`),
    `小产物的理由应当报出实际回读的字节数，实际：${notes.detail}`)
})

// ---------------------------------------------------------------------------
// ② 产物取不到 / 缓存头不对 / 声明长度撒谎：都必须红
// ---------------------------------------------------------------------------

test('★★★ 产物 404 ⇒ `artifact-*` 必须红（地址取不到就是没发布成功）', async (t) => {
  const ctx = setup(t)
  const zipPath = ctx.publish.release.package.path
  const result = await run(ctx.publish, ctx, {
    overrides: {
      [zipPath]: () => ({ status: 404, headers: headersOf([['cache-control', 'no-store']]), body: Readable.from([]) }),
    },
  })
  const pkg = checkOf(result, 'artifact-package')
  assert.equal(pkg.ok, false, '产物 404 却被判成可达')
  assert.equal(result.ok, false)
  // ★ 另外两个产物仍然应当通过：一次"这个地址没传上去"不该掩盖"另外两个是好的"。
  assert.equal(checkOf(result, 'artifact-installer').ok, true)
  assert.equal(checkOf(result, 'artifact-notes').ok, true)
})

test('★★ 产物的缓存头不对 ⇒ 必须红（发布文件要能长期缓存）', async (t) => {
  // 设计 §4 line 79：通道清单 `no-store`，**发行文件可长期缓存**。
  // 一个"没配缓存头"的部署会让每一次下载都回源——而那是发布方的成本。
  const ctx = setup(t)
  const zipPath = ctx.publish.release.package.path
  const bytes = ctx.publish.immutable.find((e) => e.path === zipPath).bytes
  const result = await run(ctx.publish, ctx, {
    overrides: {
      [zipPath]: () => ({
        status: 200,
        headers: headersOf([['cache-control', 'no-store'], ['content-length', String(bytes.length)]]),
        body: Readable.from([bytes]),
      }),
    },
  })
  const pkg = checkOf(result, 'artifact-package')
  assert.equal(pkg.ok, false, '产物被配成 no-store 却被判成通过')
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// ③ ★★ 那条分支用的是**具名常量**，不是手抄的错误码
// ---------------------------------------------------------------------------

test('★★ 超窗口判定必须用 `TRANSPORT_CODES.TOO_LARGE`，不许手抄字面量', async () => {
  // ★ 这条守的是一个**很安静的**漂移：`verify-host.mjs` 原先写的是
  //   `head.code === 'net-too-large'`（手抄字面量）。字面量一旦与常量漂开，
  //   `TOO_LARGE` 那条分支**永远不匹配** —— 而它恰恰只有真实发布才会走到，
  //   于是所有测试照样全绿、每一次真实回读却报 FAIL。
  //
  //   所以这条判据问的是"它引用常量了吗"，而不是"它现在对不对"。
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const text = readFileSync(`${root}scripts/update/verify-host.mjs`, 'utf8')

  // 正对照：一段手抄字面量的文本必须被这条判据认出来。
  {
    const legacy = "} else if (head.code === 'net-too-large') {"
    assert.match(legacy, /head\.code ===\s*'net-too-large'/,
      '正对照的正则匹配不上，这条判据是空跑的')
  }

  assert.equal(/head\.code ===\s*'net-too-large'/.test(text), false,
    'verify-host.mjs 又手抄了 TOO_LARGE 的字面量 —— 漂移时那条分支会静默失效')
  assert.match(text, /TRANSPORT_CODES\.TOO_LARGE/,
    'verify-host.mjs 没有引用 TRANSPORT_CODES.TOO_LARGE')

  // 而常量本身的名字必须还是那个（否则上面那条引用也会漂）。
  assert.equal(TRANSPORT_CODES.TOO_LARGE, 'net-too-large')
})
