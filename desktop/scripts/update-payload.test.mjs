// desktop/scripts/update-payload.test.mjs
// ============================================================================
// 桌面构建 → 升级包的**对齐**判据
//
// 这一层以前是空的：`publish.mjs` 只能接受"别处打好的 ZIP"，于是"发布出去的
// 包里的文件树"与"桌面实际装出来的文件树"从没有任何一处被对齐过。两边的
// 分歧不会在打包时暴露，只会在**用户升级之后**暴露——而那时它表现为
// "某个服务起不来"。
//
// 这些用例不跑 electron-builder（那需要 Electron 与网络），它们在一个
// 合成的 stage 目录上驱动真实的对齐与打包逻辑。合成目录的形状按
// `stage.mjs` 的实际输出来搭：`<stage>/resources/{legion,node,update,dsh.asar}`。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  FORBIDDEN_PAYLOAD_ENTRIES, PAYLOAD_CODES, PAYLOAD_RELATIVE_ROOT,
  buildUpgradePayload, inspectPayloadRoot, payloadEntryStats, resolveStage,
} from './update-payload.mjs'
import { planExtraction, extractArchive } from '../../product/update/extract.mjs'
import { closureDigest } from '../../product/update/closure.mjs'
import { generateReleaseKeyPair } from '../../product/update/envelope.mjs'

const PRODUCT_VERSION = '1.1.0'

// 真签名：`buildPublish` 会调用 `signEnvelope`，占位字符串只会在那里失败。
const KEY_PAIR = generateReleaseKeyPair({ keyId: 'k1' })

/** 造一个与 `stage.mjs` 输出同形的 stage 目录。 */
function makeStage(t, {
  productVersion = PRODUCT_VERSION,
  extra = [],
  omitManifest = false,
  omitLegion = false,
} = {}) {
  const stage = mkdtempSync(join(tmpdir(), 'legion-payload-test-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  const resources = join(stage, 'resources')
  const legion = join(resources, 'legion')
  if (!omitLegion) {
    const files = [
      ['product/launcher/desktop-bridge.mjs', '// bridge\n'],
      ['product/update/helper.mjs', '// helper\n'],
      ['product/release/update-config.json', '{"channels":{}}\n'],
      ['team-hub/server.mjs', '// hub\n'],
      ['workbench/dist/index.html', '<html></html>\n'],
      ['runtime/dsh-composition/index.mjs', '// composition\n'],
    ]
    for (const [path, content] of files) {
      const target = join(legion, ...path.split('/'))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
    if (!omitManifest) {
      const manifestPath = join(legion, 'product', 'release', 'runtime-manifest.json')
      mkdirSync(join(manifestPath, '..'), { recursive: true })
      writeFileSync(manifestPath, `${JSON.stringify({
        manifestFormat: 'legion/version-manifest@1',
        productVersion,
        legionVersion: productVersion,
        dshVersion: '0.8.3',
        dshCompositionPatchVersion: 2,
        runtimeContractVersion: 1,
        packProtocolVersion: 1,
        schemaVersion: 1,
        channel: 'stable',
      }, null, 2)}\n`)
    }
    for (const [path, content] of extra) {
      const target = join(legion, ...path.split('/'))
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
  }
  // 待切换目录**之外**的东西：helper 与随包 Node。它们必须留在载荷之外。
  mkdirSync(join(resources, 'update'), { recursive: true })
  writeFileSync(join(resources, 'update', 'helper-entry.mjs'), '// helper entry\n')
  mkdirSync(join(resources, 'node'), { recursive: true })
  writeFileSync(join(resources, 'node', 'node.exe'), 'MZ fake node')
  writeFileSync(join(resources, 'dsh.asar'), 'fake asar')
  writeFileSync(join(resources, 'desktop-release.json'), '{"format":"x"}\n')
  writeFileSync(join(stage, 'current-stage.json'), `${JSON.stringify({ stage, resources, shell: join(stage, 'shell') }, null, 2)}\n`)
  return { stage, resources, legion }
}

// ---------------------------------------------------------------------------
// ① 载荷根的位置
// ---------------------------------------------------------------------------

test('★ 载荷根是 <stage>/resources/legion（与打包后的 installRoot 同源）', () => {
  assert.deepEqual([...PAYLOAD_RELATIVE_ROOT], ['resources', 'legion'])
})

test('resolveStage：目录与描述文件两种入口，都指向同一个 resources', (t) => {
  const { stage, resources } = makeStage(t)
  const fromDir = resolveStage({ stageDir: stage })
  assert.equal(fromDir.ok, true, fromDir.reason)
  assert.equal(fromDir.resources, resources)
  // 也接受直接给 resources 目录。
  const fromResources = resolveStage({ stageDir: resources })
  assert.equal(fromResources.resources, resources)
  const fromFile = resolveStage({ stageFile: join(stage, 'current-stage.json') })
  assert.equal(fromFile.ok, true, fromFile.reason)
  assert.equal(fromFile.resources, resources)
})

test('resolveStage：缺参数与不存在的路径都明确失败', (t) => {
  const { stage } = makeStage(t)
  assert.equal(resolveStage({}).code, PAYLOAD_CODES.NO_STAGE)
  assert.equal(resolveStage({ stageDir: join(stage, 'nope') }).code, PAYLOAD_CODES.NO_STAGE)
  assert.equal(resolveStage({ stageFile: join(stage, 'nope.json') }).code, PAYLOAD_CODES.NO_STAGE)
})

// ---------------------------------------------------------------------------
// ② 不该进升级包的东西
// ---------------------------------------------------------------------------

test('★ helper 与随包 Node 不在载荷里（它们不属于待切换目录）', (t) => {
  const { legion } = makeStage(t)
  const inspected = inspectPayloadRoot({ payloadRoot: legion, productVersion: PRODUCT_VERSION })
  assert.equal(inspected.ok, true, inspected.reason)
  // 载荷的顶层条目：产品目录 + 版本清单目录，**没有** update/node/git/dsh.asar。
  for (const forbidden of ['update', 'node', 'git', 'dsh.asar']) {
    assert.equal(inspected.entries.includes(forbidden), false, `载荷里出现了 ${forbidden}`)
  }
})

test('★ 载荷里出现 node_modules / 测试文件 / 符号链接形状 → 拒', (t) => {
  const cases = [
    ['node_modules', [['product/node_modules/x/index.js', '// x\n']]],
    ['测试文件', [['product/update/helper.test.mjs', '// t\n']]],
    ['未完成文件', [['product/x.zip.part', 'x']]],
    ['临时目录', [['.tmp-ci-env/x', 'x']]],
  ]
  for (const [name, extra] of cases) {
    const { legion } = makeStage(t, { extra })
    const inspected = inspectPayloadRoot({ payloadRoot: legion, productVersion: PRODUCT_VERSION })
    assert.equal(inspected.ok, false, `「${name}」被接受了`)
    assert.equal(inspected.code, PAYLOAD_CODES.FORBIDDEN_ENTRY, `「${name}」的码是 ${inspected.code}`)
  }
})

test('★ 载荷顶层不该出现的名字（与 FORBIDDEN 列表一致）', (t) => {
  const { legion } = makeStage(t)
  for (const name of FORBIDDEN_PAYLOAD_ENTRIES) {
    const target = join(legion, name)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'x.txt'), 'x')
    const inspected = inspectPayloadRoot({ payloadRoot: legion, productVersion: PRODUCT_VERSION })
    assert.equal(inspected.ok, false, `顶层 ${name} 被接受了`)
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ③ 目标产品版本清单
// ---------------------------------------------------------------------------

test('★ 载荷里必须有目标产品版本清单，且版本要与发行一致', (t) => {
  const missing = makeStage(t, { omitManifest: true })
  const inspected = inspectPayloadRoot({ payloadRoot: missing.legion })
  assert.equal(inspected.ok, false)
  assert.equal(inspected.code, PAYLOAD_CODES.NO_MANIFEST)

  const { legion } = makeStage(t)
  const mismatch = inspectPayloadRoot({ payloadRoot: legion, productVersion: '2.0.0' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, PAYLOAD_CODES.VERSION_MISMATCH)
  assert.match(mismatch.reason, /跑着 1\.0\.9 的代码|不一致/)

  const ok = inspectPayloadRoot({ payloadRoot: legion, productVersion: PRODUCT_VERSION })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(ok.productVersion, PRODUCT_VERSION)
  assert.equal(ok.dshVersion, '0.8.3')
})

test('非 SemVer 的产品版本被拒', (t) => {
  const { legion } = makeStage(t, { productVersion: '^1.1.0' })
  const inspected = inspectPayloadRoot({ payloadRoot: legion, productVersion: null })
  assert.equal(inspected.ok, false)
  assert.equal(inspected.code, PAYLOAD_CODES.VERSION_MISMATCH)
})

test('空的载荷根被拒（而不是打出一个空包）', (t) => {
  const { legion } = makeStage(t, { omitLegion: true })
  const inspected = inspectPayloadRoot({ payloadRoot: legion })
  assert.equal(inspected.ok, false)
  assert.equal(inspected.code, PAYLOAD_CODES.NO_LEGION_ROOT)
})

// ---------------------------------------------------------------------------
// ④ 端到端：stage → 升级包 → 解压 → 与 stage 的字节一致
// ---------------------------------------------------------------------------

test('★ 端到端：stage → 升级包（含闭包）→ 解压出来的字节与 stage 逐文件一致', (t) => {
  const { stage, legion } = makeStage(t)
  const outDir = join(stage, 'out')
  const built = buildUpgradePayload({ stageFile: join(stage, 'current-stage.json'), outDir, productVersion: PRODUCT_VERSION })
  assert.equal(built.ok, true, built.reason)
  assert.equal(built.productVersion, PRODUCT_VERSION)
  assert.equal(built.closurePath, 'closure.json')
  assert.match(built.closureSha256, /^[0-9a-f]{64}$/)

  const archiveBytes = readFileSync(built.zipPath)
  // 整包摘要必须与返回的读数一致（"写出去之后回读"的读数）。
  assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), built.zipSha256)

  // 解压：用发行清单里那个闭包摘要。
  const targetDir = join(stage, 'installed')
  const extracted = extractArchive({
    archiveBytes,
    targetDir,
    closureEntry: { path: built.closurePath, sha256: built.closureSha256 },
  })
  assert.equal(extracted.ok, true, extracted.reason)

  // ★ 逐文件与 stage 里的载荷字节一致。这是"发布出去的包 = 装出来的树"。
  const expected = [
    'product/launcher/desktop-bridge.mjs',
    'product/update/helper.mjs',
    'product/release/update-config.json',
    'product/release/runtime-manifest.json',
    'team-hub/server.mjs',
    'workbench/dist/index.html',
    'runtime/dsh-composition/index.mjs',
  ]
  for (const path of expected) {
    assert.deepEqual(
      readFileSync(join(targetDir, ...path.split('/'))),
      readFileSync(join(legion, ...path.split('/'))),
      `${path} 的字节与 stage 不一致`,
    )
  }
  // 载荷根**之外**的东西一个都不该出现。
  for (const forbidden of ['update', 'node', 'dsh.asar', 'desktop-release.json']) {
    assert.equal(
      existsSafe(join(targetDir, forbidden)),
      false,
      `解压结果里出现了 ${forbidden}`,
    )
  }
})

test('★ 闭包条目在包内，且它的摘要能被独立算出来', (t) => {
  const { stage } = makeStage(t)
  const outDir = join(stage, 'out')
  const built = buildUpgradePayload({ stageDir: stage, outDir, productVersion: PRODUCT_VERSION })
  assert.equal(built.ok, true, built.reason)
  // 从包里把闭包条目取出来，摘要必须与返回的读数一致。
  const archiveBytes = readFileSync(built.zipPath)
  const extracted = extractArchive({
    archiveBytes,
    targetDir: join(stage, 'ceiling'),
    closureEntry: { path: built.closurePath, sha256: built.closureSha256 },
  })
  assert.equal(extracted.ok, true, extracted.reason)
  const closureBytes = readFileSync(join(stage, 'ceiling', built.closurePath))
  assert.equal(closureDigest(closureBytes), built.closureSha256)
  const closure = JSON.parse(closureBytes.toString('utf8'))
  assert.equal(closure.protocol, 'legion/update-closure@1')
  assert.equal(closure.files.length, built.closureFileCount)
  // 闭包自己**不**在闭包里（自指无不动点）。
  assert.equal(closure.files.some((file) => file.path === built.closurePath), false)
})

test('★ planExtraction 只读计划：报告里含闭包条目本身，但不含载荷外的东西', (t) => {
  const { stage } = makeStage(t)
  const outDir = join(stage, 'out')
  const built = buildUpgradePayload({ stageDir: stage, outDir, productVersion: PRODUCT_VERSION })
  const planned = planExtraction({
    archiveBytes: readFileSync(built.zipPath),
    closureEntry: { path: built.closurePath, sha256: built.closureSha256 },
  })
  assert.equal(planned.ok, true, planned.reason)
  const paths = planned.plan.files.map((file) => file.path)
  assert.ok(paths.includes(built.closurePath), '计划里没有闭包条目')
  assert.ok(paths.includes('product/launcher/desktop-bridge.mjs'))
  assert.equal(paths.some((path) => path.startsWith('node/')), false)
})

test('★ 改一个字节：闭包内容摘要拦得住', async (t) => {
  const { stage, legion } = makeStage(t)
  const outDir = join(stage, 'out')
  const built = buildUpgradePayload({ stageDir: stage, outDir, productVersion: PRODUCT_VERSION })
  assert.equal(built.ok, true, built.reason)

  // 从包里把闭包取出来，然后**改一个载荷文件**、闭包不动。
  const archiveBytes = readFileSync(built.zipPath)
  const staging = join(stage, 'tamper-src')
  extractArchive({ archiveBytes, targetDir: staging, closureEntry: { path: built.closurePath, sha256: built.closureSha256 } })
  // 同长度改写（这样连"大小不符"这条都绕过，只剩摘要能拦）。
  const victim = join(staging, 'team-hub', 'server.mjs')
  const original = readFileSync(victim)
  writeFileSync(victim, Buffer.alloc(original.length, 0x41))
  const { buildZip } = await import('../../product/update/zip.mjs')
  const files = collectTree(staging)
  const rebuilt = buildZip(files)
  assert.equal(rebuilt.ok, true, rebuilt.reason)

  const result = extractArchive({
    archiveBytes: rebuilt.bytes,
    targetDir: join(stage, 'tampered-out'),
    closureEntry: { path: built.closurePath, sha256: built.closureSha256 },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'extract-digest-mismatch')
  assert.match(result.reason, /内容摘要不符/)
  void legion
})

test('payloadEntryStats 报出顶层字节数（发布记录留档用）', (t) => {
  const { legion } = makeStage(t)
  const stats = payloadEntryStats(legion)
  assert.ok(stats.product > 0, `product 的字节数应当大于 0：${JSON.stringify(stats)}`)
  assert.ok(stats['team-hub'] > 0)
  assert.equal(stats.update, undefined)
})

// ---------------------------------------------------------------------------
// ⑤ 与 publish.mjs 的接法
// ---------------------------------------------------------------------------

test('★ 产出的包能被 buildPublish 直接接受（--package-zip 那条路）', async (t) => {
  const { stage } = makeStage(t)
  const outDir = join(stage, 'out')
  const built = buildUpgradePayload({ stageDir: stage, outDir, productVersion: PRODUCT_VERSION })
  assert.equal(built.ok, true, built.reason)

  const { buildPublish } = await import('../../scripts/update/publish.mjs')
  const installerPath = join(stage, 'Legion-Setup.exe')
  const notesPath = join(stage, 'notes.txt')
  writeFileSync(installerPath, 'MZ installer')
  writeFileSync(notesPath, 'release notes\n')
  const publish = buildPublish({
    productVersion: PRODUCT_VERSION,
    channel: 'stable',
    releaseId: 'rel-1.1.0',
    productManifest: JSON.parse(readFileSync(join(stage, 'resources', 'legion', 'product', 'release', 'runtime-manifest.json'), 'utf8')),
    supportedFromVersions: ['1.0.0'],
    // ★ 这里用 `--package-zip` 那条路：包由 `update-payload.mjs` 产出。
    packageZipPath: built.zipPath,
    installerPath,
    notesPath,
    migrationPlanDigest: 'd'.repeat(64),
    keyId: 'k1',
    privateKeyPem: KEY_PAIR.privateKeyPem,
    sequence: 43,
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  })
  // ⚠️ 这条路**不带闭包**（`publish.mjs` 只钉住整包摘要），所以
  //    `closurePath` 不出现 —— 那是刻意的，见 buildPublish 的注释。
  assert.equal(publish.release.package.path, 'releases/rel-1.1.0/legion-win-x64.zip')
  assert.equal(publish.release.package.closurePath, undefined)
  // 而整包摘要与 `update-payload.mjs` 算出来的一致。
  assert.equal(publish.release.package.sha256, built.zipSha256)
})

test('★ 也可以走 --package-root 那条路（由 publish 自己打包 + 写闭包）', async (t) => {
  const { resources } = makeStage(t)
  const { mkdtempSync: mkd } = await import('node:fs')
  const outDir = mkd(join(tmpdir(), 'legion-payload-pub-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const { buildPublish } = await import('../../scripts/update/publish.mjs')
  const payloadRoot = join(resources, 'legion')
  const installerPath = join(outDir, 'Legion-Setup.exe')
  const notesPath = join(outDir, 'notes.txt')
  writeFileSync(installerPath, 'MZ installer')
  writeFileSync(notesPath, 'release notes\n')
  const publish = buildPublish({
    productVersion: PRODUCT_VERSION,
    channel: 'stable',
    releaseId: 'rel-1.1.0',
    productManifest: JSON.parse(readFileSync(join(payloadRoot, 'product', 'release', 'runtime-manifest.json'), 'utf8')),
    supportedFromVersions: ['1.0.0'],
    packageRoot: payloadRoot,
    packageZipPath: null,
    installerPath,
    notesPath,
    migrationPlanDigest: 'd'.repeat(64),
    keyId: 'k1',
    privateKeyPem: KEY_PAIR.privateKeyPem,
    sequence: 43,
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
    outDir,
  })
  // ⚠️ 两条路的差别就在这里：`--package-root` **带**闭包。
  assert.equal(publish.release.package.closurePath, 'closure.json')
  assert.match(publish.release.package.closureSha256, /^[0-9a-f]{64}$/)
  // 而两条路打出来的内容必须**一样**（同一份载荷、同样确定性）。
  const built = buildUpgradePayload({ stageDir: resources, outDir: join(outDir, 'via-payload'), productVersion: PRODUCT_VERSION })
  assert.equal(built.ok, true, built.reason)
  assert.equal(built.closureSha256, publish.release.package.closureSha256,
    '两条路算出的闭包摘要不同 —— 说明其中一条没有按同一份载荷打包')
})

function collectTree(root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { walk(absolute, relative); continue }
      out.push({ path: relative, bytes: readFileSync(absolute) })
    }
  }
  walk(root, '')
  return out
}

function existsSafe(path) {
  try { readFileSync(path); return true } catch {
    try { readdirSync(path); return true } catch { return false }
  }
}
