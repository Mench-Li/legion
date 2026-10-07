// scripts/update/verify-install.test.mjs
// ============================================================================
// 「装完之后核对」的判据（设计 §10 验收表第 ①③⑨ 行的离线可判部分）。
//
// 这一组用**真磁盘上的临时目录**驱动，而不是内存替身——因为被测的东西
// 本身就是"读一台机器上的目录树"，而内存替身恰好会把"目录读法"这一层
// 换成我自己写的东西（那个替身我在自检里已经写错过一次，见 `fakeTree` 的注释）。
//
// ★ 本文件里最有价值的一条是**对拍**：同一份输入同时喂给本模块的
//   `compareInstalledTree()` 与 `extract.mjs` 的 `verifyExtractedTree()`，
//   要求"发行里有、盘上没有"与"摘要不符"这两类差异**两边都报**。
//   本仓对"两处刻意分开的实现"用的就是这个手法（`dshPatchPairOf` 与
//   `patchPairOf` 那一条也是这样钉住的）：两处各自演进没关系，
//   **但不能对同一份输入给出相反结论**。
// ============================================================================

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTrustStore, generateReleaseKeyPair, serializeEnvelope, signEnvelope } from '../../product/update/envelope.mjs'
import { artifactFromBytes, buildRelease } from '../../product/update/release.mjs'
import { verifyExtractedTree } from '../../product/update/extract.mjs'
import { closureFromDirectory } from '../../product/update/closure.mjs'
import { packDirectory } from './publish.mjs'
import { buildTrustTable, updateTrustPath, writeTrustTable as writeTable } from './trust-file.mjs'
import {
  INSTALL_VERIFY_CODES, INSTALL_VERIFY_EXIT, compareInstalledTree, expectedClosureFromRelease,
  main, planInstallVerification, renderInstallVerification,
} from './verify-install.mjs'

const KEY_ID = 'release-2026-a'
const NOW = Date.parse('2026-10-06T12:00:00Z')

/** 造一棵"已安装目录"（真磁盘）。返回它的路径与每个文件的字节。 */
function makeTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'legion-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [relative, bytes] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, bytes)
  }
  return root
}

/**
 * 造一次"完整的发行"：真 ZIP（含闭包）+ 真签名清单 + 信任表。
 *
 * 走的是发布端**同一套**函数（`packDirectory` → `artifactFromBytes` →
 * `buildRelease` → `signEnvelope`），所以这里测的不是"我造了一个像清单的
 * 东西"，而是"发布端产出的那份清单能不能被这个核对工具读懂"。
 */
function makeRelease(t, payloadFiles) {
  const payloadRoot = makeTree(t, payloadFiles)
  const packed = packDirectory({ root: payloadRoot })
  assert.equal(packed.ok, true, packed.reason)

  const keys = generateReleaseKeyPair({ keyId: KEY_ID })
  const trustStore = createTrustStore([{ keyId: KEY_ID, publicKeyPem: keys.publicKeyPem }])
  const productManifest = {
    format: 'legion/version-manifest@1', productVersion: '1.1.0', legionVersion: '1.1.0',
    dshVersion: '0.8.3', dshCompositionPatchVersion: 2, channel: 'stable',
  }
  const release = buildRelease({
    releaseId: 'rel-1.1.0', productVersion: '1.1.0', channel: 'stable', productManifest,
    supportedFromVersions: ['1.0.0'], minWindowsBuild: 19045, requiredFreeBytes: 1024,
    dshPatchBindings: [{ dshVersion: '0.8.3', compositionPatchVersion: 2 }],
    package: artifactFromBytes('releases/rel-1.1.0/legion-win-x64.zip', packed.zipBytes, {
      closurePath: packed.closureName, closureSha256: packed.closureSha256,
    }),
    installer: artifactFromBytes('releases/rel-1.1.0/Legion-Setup-win-x64.exe', Buffer.from('installer')),
    notes: artifactFromBytes('releases/rel-1.1.0/notes.zh-CN.txt', Buffer.from('说明')),
    migrationPlanDigest: 'e'.repeat(64), rollbackPolicy: 'program-only',
    issuedAt: '2026-10-05T00:00:00Z', expiresAt: '2026-10-13T00:00:00Z',
  })
  const manifestBytes = Buffer.from(serializeEnvelope(signEnvelope(release, {
    privateKeyPem: keys.privateKeyPem, keyId: KEY_ID,
  })), 'utf8')
  return { payloadRoot, packed, manifestBytes, packageBytes: packed.zipBytes, trustStore, release, publicKeyPem: keys.publicKeyPem }
}

const SAMPLE = Object.freeze({
  'product-manifest.json': Buffer.from('{"productVersion":"1.1.0"}'),
  'legion/app.js': Buffer.from('console.log(1)'),
  'legion/deep/nested.txt': Buffer.from('nested'),
})

// ---------------------------------------------------------------------------
// ① 一致时必须通过
// ---------------------------------------------------------------------------

test('★★★ 已安装目录与发行逐字节一致 → 通过（这是"验收通过"的样子）', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  const report = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, true, report.reason)
  assert.equal(report.code, null)
  // 三个"我核对了什么"的读数都要在（验收记录靠它们说明核对面）。
  assert.equal(report.tree.compared, Object.keys(SAMPLE).length)
  assert.deepEqual([...report.tree.topLevel], ['legion', 'product-manifest.json'])
  assert.equal(report.release.productVersion, '1.1.0')
  assert.equal(report.tree.counts.digest + report.tree.counts.missing + report.tree.counts.extra, 0)
})

// ---------------------------------------------------------------------------
// ② 三类差异各自被抓住
// ---------------------------------------------------------------------------

test('★★★ 文件被改过 → DIGEST（且报告里指出是哪一个）', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  // 改一个字节，**长度不变**：这样它必须落到"摘要不符"而不是"大小不符"。
  writeFileSync(join(payloadRoot, 'legion', 'app.js'), Buffer.from('console.log(2)'))
  const report = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, false)
  assert.equal(report.code, INSTALL_VERIFY_CODES.DIGEST)
  assert.equal(report.tree.counts.digest, 1)
  assert.equal(report.tree.findings[0].path, 'legion/app.js')
  // 理由要能读懂（验收记录里那一行就是它）。
  assert.match(report.reason, /legion\/app\.js/)
})

test('★★★ 盘上少了文件 → MISSING', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  rmSync(join(payloadRoot, 'legion', 'deep', 'nested.txt'))
  const report = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, false)
  assert.equal(report.code, INSTALL_VERIFY_CODES.MISSING)
  assert.equal(report.tree.counts.missing, 1)
  assert.equal(report.tree.findings[0].path, 'legion/deep/nested.txt')
})

test('★★★ 盘上多了发行之外的条目 → EXTRA；写进 allowExtra 才放过', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  writeFileSync(join(payloadRoot, 'install.log'), Buffer.from('运行期生成的'))
  const strict = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(strict.ok, false, '发行之外的条目被放过了')
  assert.equal(strict.code, INSTALL_VERIFY_CODES.EXTRA)
  assert.equal(strict.tree.counts.extra, 1)

  // ★ 而"已安装目录"确实会有合法的额外文件（运行期生成的清单/日志），
  //   所以必须有一条显式的口子——否则这个工具在真机上**永远报错**，
  //   而一个永远报错的验收工具与没有工具是一回事。
  const allowed = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
    allowExtra: ['install.log'],
  })
  assert.equal(allowed.ok, true, allowed.reason)
})

test('★★ 文件变长 → SIZE（不是 DIGEST：两类差异的处置不同）', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  writeFileSync(join(payloadRoot, 'legion', 'app.js'), Buffer.from('console.log(1)extra'))
  const report = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, false)
  assert.equal(report.tree.findings[0].code, INSTALL_VERIFY_CODES.SIZE)
  assert.equal(report.tree.counts.size, 1)
  assert.equal(report.tree.counts.digest, 0)
})

test('★★ 目录里出现重解析点 → SYMLINK（"盘上是什么"取决于它指向哪）', (t) => {
  const { payloadRoot, manifestBytes, packageBytes, trustStore } = makeRelease(t, SAMPLE)
  // ★ 两套造法，都指向**同一个**要被拒的形状（重解析点）：
  //   · 优先试"普通文件符号链接"（最贴近真实的攻击形态）；
  //   · Windows 上它需要特权（EPERM），于是退到**目录联接**——后者不需要特权，
  //     而 Node 对它的 `isSymbolicLink()` 也报 `true`（实测）。
  //   退到联接**不是**让这条判据变松：两者都是"目录里的一项指向别处"，
  //   而解压端与安装端拒绝它们的理由是同一条。
  const link = join(payloadRoot, 'legion', 'link.js')
  let made = null
  try {
    symlinkSync(join(payloadRoot, 'legion', 'app.js'), link, 'file')
    made = 'file-symlink'
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    try {
      symlinkSync(join(payloadRoot, 'legion'), join(payloadRoot, 'legion-link'), 'junction')
      made = 'junction'
    } catch (inner) {
      t.skip(`本环境两种重解析点都建不了（${error?.code} / ${inner?.code}）——这一条没有跑，不是通过`)
      return
    }
  }
  const report = planInstallVerification({
    installRoot: payloadRoot, manifestBytes, packageBytes, trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, false, `重解析点（${made}）被放过了`)
  assert.equal(report.tree.counts.symlink, 1, `${made} 没有被判成 SYMLINK：${JSON.stringify(report.tree.findings)}`)
})

// ---------------------------------------------------------------------------
// ③ ★ 与 `verifyExtractedTree` 对拍：两处实现不能对同一份输入给相反结论
// ---------------------------------------------------------------------------

test('★★★★ 与 `extract.verifyExtractedTree()` 对拍：缺失与摘要不符两边都报', (t) => {
  // ★ 本模块**刻意**没有复用 `verifyExtractedTree`：后者判的是"刚解压出来的
  //   临时目录"，那里不该有任何计划之外的东西；而**已安装目录**会有。
  //   刻意分开的两处实现必须被钉住一致性，否则它们会各自漂移，
  //   而"两处对同一件事给出不同结论"比只有一处更坏——读者不知道该信谁。
  const files = { 'a.txt': Buffer.from('aaa'), 'b/c.txt': Buffer.from('ccc') }
  const root = makeTree(t, files)
  const collected = closureFromDirectory(root)
  assert.equal(collected.ok, true, collected.problems.join('；'))
  const expected = collected.closure.files

  // 一致时：两边都通过。
  assert.equal(compareInstalledTree({ installRoot: root, expected }).ok, true)
  assert.equal(verifyExtractedTree({ targetDir: root, expected }).ok, true)

  // 摘要不符时：两边都必须报（码不同，结论相同）。
  writeFileSync(join(root, 'a.txt'), Buffer.from('aab'))
  const mineDigest = compareInstalledTree({ installRoot: root, expected })
  const theirsDigest = verifyExtractedTree({ targetDir: root, expected })
  assert.equal(mineDigest.ok, false, '本模块放过了摘要不符')
  assert.equal(theirsDigest.ok, false, 'verifyExtractedTree 放过了摘要不符')
  assert.ok(theirsDigest.problems.some((p) => /摘要不符/.test(p)), theirsDigest.problems.join('；'))

  // 缺失时：两边都必须报。
  rmSync(join(root, 'b', 'c.txt'))
  const mineMissing = compareInstalledTree({ installRoot: root, expected })
  const theirsMissing = verifyExtractedTree({ targetDir: root, expected })
  assert.equal(mineMissing.ok, false, '本模块放过了缺失')
  assert.equal(theirsMissing.ok, false, 'verifyExtractedTree 放过了缺失')
})

test('★★ 两处的**故意**分歧：计划之外的条目，本模块可放行而 `verifyExtractedTree` 不放', (t) => {
  // 把这条分歧**写下来**，免得下一个读代码的人以为是漏了一处复用：
  // 解压后的临时目录里出现计划外的条目一定是错的（解压器写多了）；
  // 而安装目录里出现额外的文件是**正常的**（运行期产物）。
  const files = { 'a.txt': Buffer.from('aaa') }
  const root = makeTree(t, files)
  const expected = closureFromDirectory(root).closure.files
  writeFileSync(join(root, 'runtime.log'), Buffer.from('x'))

  assert.equal(verifyExtractedTree({ targetDir: root, expected }).ok, false,
    'verifyExtractedTree 竟然放过了计划之外的条目')
  assert.equal(compareInstalledTree({ installRoot: root, expected }).ok, false,
    '本模块默认也应当拒绝——"可放行"必须由调用方显式写 allowExtra')
  assert.equal(compareInstalledTree({ installRoot: root, expected, allowExtra: ['runtime.log'] }).ok, true)
})

// ---------------------------------------------------------------------------
// ④ 对照物的可信度：签名、包摘要、闭包条目
// ---------------------------------------------------------------------------

test('★★★ 清单验签不过 → 具名拒绝，且**不做**树比对（没有可信对照物就不下结论）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  const other = generateReleaseKeyPair({ keyId: KEY_ID })
  const wrongTrust = createTrustStore([{ keyId: KEY_ID, publicKeyPem: other.publicKeyPem }])
  const report = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: ctx.packageBytes, trustStore: wrongTrust, nowMs: NOW,
  })
  assert.equal(report.ok, false)
  assert.equal(report.code, INSTALL_VERIFY_CODES.MANIFEST_UNVERIFIED)
  assert.equal(report.tree, null, '验签没过却给出了树比对结论')
  assert.equal(report.version, null)
})

test('★★★ 包被换过 → PACKAGE_DIGEST（包摘要与清单不符）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  const tampered = Buffer.from(ctx.packageBytes)
  tampered[tampered.length - 20] ^= 0xff                       // 改尾部一个字节
  const report = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: tampered, trustStore: ctx.trustStore, nowMs: NOW,
  })
  assert.equal(report.ok, false)
  assert.equal(report.code, INSTALL_VERIFY_CODES.PACKAGE_DIGEST)
  assert.equal(report.tree, null)
})

test('★★ 过期清单 → 拒绝（有效期由信封那一层判，这里只如实带出）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  const report = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: ctx.packageBytes, trustStore: ctx.trustStore,
    nowMs: Date.parse('2026-11-01T00:00:00Z'),      // 清单 10-13 到期
  })
  assert.equal(report.ok, false)
  assert.equal(report.code, INSTALL_VERIFY_CODES.MANIFEST_UNVERIFIED)
})

test('★ `expectedClosureFromRelease` 单独可用：闭包条目摘要由清单里的值钉住', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  const good = expectedClosureFromRelease({
    manifestBytes: ctx.manifestBytes, packageBytes: ctx.packageBytes, trustStore: ctx.trustStore, nowMs: NOW,
  })
  assert.equal(good.ok, true, good.reason)
  assert.equal(good.files.length, Object.keys(SAMPLE).length)
  assert.equal(good.closureDigest, ctx.packed.closureSha256, '取出的闭包摘要与发布端算的不一致')
})

// ---------------------------------------------------------------------------
// ⑤ 版本读数（N-1 → N 的那一半）
// ---------------------------------------------------------------------------

test('★★★ 期望版本给定时才读；读不出来判失败（"读不出"≠"版本对"）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  // 先不给期望版本：不该有版本读数（不猜）。
  const noExpect = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: ctx.packageBytes, trustStore: ctx.trustStore, nowMs: NOW,
  })
  assert.equal(noExpect.version.checked, false)

  // 给了期望版本，而盘上没有运行期清单 → VERSION_UNREADABLE（不是通过）。
  const unreadable = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: ctx.packageBytes, trustStore: ctx.trustStore, nowMs: NOW,
    expectVersion: '1.1.0',
  })
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.code, INSTALL_VERIFY_CODES.VERSION_UNREADABLE)
  assert.match(unreadable.reason, /读不出已安装版本/)
})

test('★★ 版本不符 → VERSION，且与"树不一致"分开（处置不同）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  // 造一个能读出旧版本的目录：运行期清单里写 1.0.0。
  const root = makeTree(t, SAMPLE)
  const manifestRel = 'product/release/runtime-manifest.json'
  mkdirSync(join(root, 'product', 'release'), { recursive: true })
  const oldManifest = Buffer.from('{"productVersion":"1.0.0"}')
  writeFileSync(join(root, ...manifestRel.split('/')), oldManifest)

  const report = planInstallVerification({
    installRoot: root, manifestBytes: ctx.manifestBytes, packageBytes: ctx.packageBytes,
    trustStore: ctx.trustStore, nowMs: NOW, expectVersion: '1.1.0',
    // 这个额外的文件不是载荷的一部分，所以显式放行——树那一半才会通过，
    // 于是这条用例测的是**版本那一半**。
    allowExtra: ['product/release/runtime-manifest.json'],
  })
  assert.equal(report.ok, false)
  assert.equal(report.version.actual, '1.0.0')
  assert.equal(report.code, INSTALL_VERIFY_CODES.VERSION)
  assert.equal(report.tree.ok, true, '这条用例要求树那一半是通过的')
  assert.match(report.reason, /1\.0\.0/)
})

// ---------------------------------------------------------------------------
// ⑥ CLI 与渲染
// ---------------------------------------------------------------------------

test('★★ CLI：四个参数缺一个都拒绝（缺了就没有可信对照物）', () => {
  const cases = [
    [], ['--install-root', 'x'], ['--install-root', 'x', '--manifest', 'm'],
    ['--install-root', 'x', '--manifest', 'm', '--package', 'p'],
  ]
  for (const argv of cases) {
    assert.equal(main(argv), INSTALL_VERIFY_EXIT.badArgs, `缺参数却继续跑了：${argv.join(' ')}`)
  }
})

test('★★★★ CLI 的退出码就是手册里写的那几个（真文件、真签名清单、真信任表）', (t) => {
  // ★ 运行手册（`docs/superpowers/plans/2026-10-06-stage-d-acceptance-runbook.md`）
  //   让验收人**照着一条命令敲**，并写下"期望退出码"。所以那几个码必须被钉住——
  //   否则手册里写的"不一致 → 3"会与实现对不上，而那种偏差只有人在真机上
  //   照着敲时才会发现（那时手上正拿着一台刚装好的机器）。
  //
  //   ★ 这条用例走的是**完整的 CLI 路径**（`main()` + 真文件），
  //     不是直接调库函数：手册里那一行是给人敲的，被测的必须是那一行。
  const ctx = makeRelease(t, SAMPLE)
  const dir = mkdtempSync(join(tmpdir(), 'legion-vi-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manifestPath = join(dir, 'manifest.json')
  const packagePath = join(dir, 'package.zip')
  writeFileSync(manifestPath, ctx.manifestBytes)
  writeFileSync(packagePath, ctx.packageBytes)
  const trustRoot = join(dir, 'trust-root')
  mkdirSync(join(trustRoot, 'product', 'release'), { recursive: true })
  const trustPath = updateTrustPath(trustRoot)
  writeTable(trustPath, buildTrustTable({ keys: [{ keyId: KEY_ID, publicKeyPem: ctx.publicKeyPem }], sequence: 1 }))

  const base = ['--install-root', ctx.payloadRoot, '--manifest', manifestPath,
    '--package', packagePath, '--trust', trustPath]

  // ① 一致 → 0
  assert.equal(main(base), INSTALL_VERIFY_EXIT.ok, '一致的安装目录没有给 0')

  // ② 多一个文件 → 3（树不一致）
  const extraPath = join(ctx.payloadRoot, 'runtime.log')
  writeFileSync(extraPath, 'x')
  assert.equal(main(base), INSTALL_VERIFY_EXIT.treeMismatch, '多出条目没有给树不一致的码')
  rmSync(extraPath)

  // ③ 改一个字节 → 3，且**报告里点出是哪个文件**（手册要求抄那一行进记录）
  writeFileSync(join(ctx.payloadRoot, 'legion', 'app.js'), Buffer.from('console.log(2)'))
  const captured = captureStdout(() => main([...base, '--json']))
  assert.equal(captured.returned, INSTALL_VERIFY_EXIT.treeMismatch)
  const parsed = JSON.parse(captured.text.trim())
  assert.equal(parsed.code, INSTALL_VERIFY_CODES.DIGEST)
  assert.equal(parsed.tree.findings[0].path, 'legion/app.js')
  writeFileSync(join(ctx.payloadRoot, 'legion', 'app.js'), SAMPLE['legion/app.js'])

  // ④ 期望版本给定但读不出来 → 4（版本不一致，与树的差异分开）
  assert.equal(main([...base, '--expect-version', '1.1.0']), INSTALL_VERIFY_EXIT.versionMismatch,
    '"读不出已安装版本"没有被判成版本不一致')

  // ⑤ 对照物本身不对（信任表里是别人的钥匙）→ 5（来源问题，不是树的问题）
  const otherRoot = join(dir, 'other-trust')
  mkdirSync(join(otherRoot, 'product', 'release'), { recursive: true })
  const otherKeys = generateReleaseKeyPair({ keyId: KEY_ID })
  const otherPath = updateTrustPath(otherRoot)
  writeTable(otherPath, buildTrustTable({ keys: [{ keyId: KEY_ID, publicKeyPem: otherKeys.publicKeyPem }], sequence: 1 }))
  assert.equal(main(['--install-root', ctx.payloadRoot, '--manifest', manifestPath,
    '--package', packagePath, '--trust', otherPath]), INSTALL_VERIFY_EXIT.sourceProblem,
  '清单验签不过没有给"来源问题"的码')
})

/** 把 `process.stdout.write` 截下来（CLI 的 `--json` 输出要能被机器读）。 */
function captureStdout(fn) {
  const chunks = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true }
  try {
    return { returned: fn(), text: chunks.join('') }
  } finally {
    process.stdout.write = original
  }
}

test('★ 渲染结果里有结论、计数与发行身份（验收记录直接抄它）', (t) => {
  const ctx = makeRelease(t, SAMPLE)
  const report = planInstallVerification({
    installRoot: ctx.payloadRoot, manifestBytes: ctx.manifestBytes,
    packageBytes: ctx.packageBytes, trustStore: ctx.trustStore, nowMs: NOW,
  })
  const text = renderInstallVerification(report)
  assert.match(text, /rel-1\.1\.0/)
  assert.match(text, /1\.1\.0/)
  assert.match(text, /差异：/)
  assert.match(text, /结论：\*\*一致\*\*/)
})
