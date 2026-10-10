// scripts/release/version.test.mjs
// ============================================================================
// 桌面端版本号工具（T-197）的判据。
//
// ## 这组用例守的是什么
//
// 版本号住在**两个互相独立**的地方，而在本工具之前**没有任何东西强制它们相等**：
//
//   · `desktop/package.json` 的 `version`         → 安装包**文件名**
//   · `product/release/runtime-manifest.json` 的  → 发布**清单**
//     `productVersion` / `legionVersion`
//
// 线上实测就是这个形态：`r-2026-10-06_0.1.0` 与 `r-2026-10-07_0.1.0`
// 是**两次不同构建**（204,582,159 vs 204,641,180 字节、sha256 不同），
// 而两次的 `productVersion` **都是 0.1.0**。
//
//   > 一个"版本号没变、字节变了"的发布，
//   > 与一个"版本号变了"的发布，在升级判据眼里是同一个东西——
//   > 只不过前者会让用户装到一个他以为已经装过的版本。
//
// 所以核心判据是**相等**，而最要紧的那条是：**只改一处必须红**。
//
// 全程在**临时目录**里造夹具，不碰仓库里的真文件。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  VERSION_CODES, VERSION_SOURCES, bumpVersion, checkVersions, deriveProductVersion, describeVersions, isSemver,
} from './version.mjs'
// 用**生产校验器**核对 bump 的产物 —— 与消费者同一套判据，不是自己另写一个。
import { validateManifest } from '../../product/upgrade/manifest.mjs'

/** 造一个最小的版本载体夹具（只含本工具会读到的字段）。 */
function makeRepo({ desktopVersion = '0.1.0', productVersion = '0.1.0', legionVersion = null, dshVersion = '0.1.5-rc.2', channel = 'internal' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-version-'))
  mkdirSync(join(root, 'desktop'), { recursive: true })
  mkdirSync(join(root, 'product', 'release'), { recursive: true })
  writeFileSync(join(root, VERSION_SOURCES.desktopPackage),
    `${JSON.stringify({ name: 'legion-desktop', version: desktopVersion, private: true }, null, 2)}\n`)
  writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), `${JSON.stringify({
    manifestFormat: 'legion/version-manifest@1',
    productVersion,
    legionVersion: legionVersion ?? productVersion,
    dshVersion,
    dshCompositionPatchVersion: 1,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    schemaVersion: 1,
    channel,
    releasedAt: '2026-09-16T00:00:00.000Z',
  }, null, 2)}\n`)
  return root
}

describe('版本号：各自洽', () => {
  test('① 两处一致时通过，并把版本读出来', () => {
    const root = makeRepo()
    try {
      const r = checkVersions({ root })
      assert.equal(r.ok, true, r.message)
      assert.equal(r.sources.productVersion, '0.1.0')
      assert.equal(r.sources.desktopVersion, '0.1.0')
      assert.equal(r.sources.dshVersion, '0.1.5-rc.2')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // ★ 这一条是整组用例里最重要的：它正对应线上那个形态。
  test('② **只改一处**（清单改了、package.json 没改）必须红', () => {
    const root = makeRepo({ desktopVersion: '0.1.0', productVersion: '0.2.0' })
    try {
      const r = checkVersions({ root })
      assert.equal(r.ok, false, '只改一处必须被判为不自洽')
      assert.equal(r.code, VERSION_CODES.MISMATCH)
      assert.match(r.message, /版本号不一致/)
      // 两边都要印出来——只说"不一致"会让人去猜哪边是新的。
      assert.match(r.message, /0\.1\.0/)
      assert.match(r.message, /0\.2\.0/)
      assert.match(r.message, /bump --to/, '要给出修法，否则人只能手改两处')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('③ 只改另一处（package.json 改了、清单没改）同样必须红', () => {
    const root = makeRepo({ desktopVersion: '0.3.0', productVersion: '0.1.0' })
    try {
      assert.equal(checkVersions({ root }).ok, false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('④ productVersion 与 legionVersion 不一致也要红', () => {
    const root = makeRepo({ productVersion: '0.1.0', legionVersion: '0.2.0' })
    try {
      const r = checkVersions({ root })
      assert.equal(r.ok, false)
      assert.equal(r.code, VERSION_CODES.MISMATCH)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑤ 非 SemVer 必须红（两边都不合法时也要说得清）', () => {
    const root = makeRepo({ desktopVersion: 'v1', productVersion: 'v1' })
    try {
      const r = checkVersions({ root })
      assert.equal(r.ok, false)
      assert.ok(r.problems.some((p) => p.code === VERSION_CODES.NOT_SEMVER))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑥ 载体读不出来时具名拒绝，不抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-version-empty-'))
    try {
      const r = checkVersions({ root })
      assert.equal(r.ok, false)
      assert.equal(r.code, VERSION_CODES.FILE_UNREADABLE)
      assert.match(r.message, /读不出来/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑦ 坏 JSON 也算读不出来（而不是当成"没有版本"）', () => {
    const root = makeRepo()
    try {
      writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), '{ 坏 json')
      const r = checkVersions({ root })
      assert.equal(r.ok, false)
      assert.equal(r.code, VERSION_CODES.FILE_UNREADABLE)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('版本号：SemVer 判据', () => {
  test('⑧ 合法形态', () => {
    for (const v of ['0.1.0', '1.2.3', '10.20.30', '0.1.5-rc.2', '1.0.0-alpha.1', '1.0.0+build.5']) {
      assert.equal(isSemver(v), true, `${v} 应合法`)
    }
  })

  test('⑨ 非法形态（含前导零、缺段、非字符串）', () => {
    for (const v of ['1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3.4', '', null, undefined, 123, {}]) {
      assert.equal(isSemver(v), false, `${JSON.stringify(v)} 应不合法`)
    }
  })
})

describe('版本号：派生规则', () => {
  test('⑩ 从 DSH 派生 = major.minor + patch 归零', () => {
    assert.equal(deriveProductVersion('0.1.5-rc.2').productVersion, '0.1.0')
    assert.equal(deriveProductVersion('0.8.3').productVersion, '0.8.0')
    assert.equal(deriveProductVersion('2.5.9').productVersion, '2.5.0')
  })

  test('⑪ 派生规则要**可读**（返回规则说明，而不是一个裸结果）', () => {
    const r = deriveProductVersion('0.8.3')
    assert.equal(r.ok, true)
    assert.ok(typeof r.rule === 'string' && r.rule.length > 0, '必须说明这条版本号是怎么来的')
  })

  test('⑫ 派生不出来的输入具名拒绝', () => {
    for (const bad of ['', 'x', null, undefined, 'v1']) {
      const r = deriveProductVersion(bad)
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 应拒绝`)
      assert.equal(r.code, VERSION_CODES.BAD_INPUT)
    }
  })
})

describe('版本号：bump', () => {
  test('⑬ 一次改两处（这是本工具存在的理由）', () => {
    const root = makeRepo()
    try {
      const r = bumpVersion({ root, to: '0.2.0' })
      assert.equal(r.ok, true, r.message)
      assert.equal(r.changes.length, 2, '必须同时改两处')
      const pkg = JSON.parse(readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8'))
      const man = JSON.parse(readFileSync(join(root, VERSION_SOURCES.runtimeManifest), 'utf8'))
      assert.equal(pkg.version, '0.2.0')
      assert.equal(man.productVersion, '0.2.0')
      assert.equal(man.legionVersion, '0.2.0')
      // 改完必须自洽
      assert.equal(checkVersions({ root }).ok, true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑭ dry-run 不落盘', () => {
    const root = makeRepo()
    try {
      const before = readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8')
      const r = bumpVersion({ root, to: '9.9.9', dryRun: true })
      assert.equal(r.ok, true)
      assert.equal(r.dryRun, true)
      assert.equal(readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8'), before, 'dry-run 不该动文件')
      assert.equal(checkVersions({ root }).ok, true, 'dry-run 后仍应自洽（还是旧版本）')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑮ 从 DSH 派生 bump，并同时写 dshVersion', () => {
    const root = makeRepo({ dshVersion: '0.1.5-rc.2' })
    try {
      const r = bumpVersion({ root, fromDsh: true, dsh: '0.8.3' })
      assert.equal(r.ok, true, r.message)
      const man = JSON.parse(readFileSync(join(root, VERSION_SOURCES.runtimeManifest), 'utf8'))
      assert.equal(man.productVersion, '0.8.0', 'major.minor + patch 归零')
      assert.equal(man.dshVersion, '0.8.3', 'dshVersion 也要一起改')
      assert.equal(r.changes.length, 3, '两处版本 + dshVersion 共 3 处')
      assert.equal(checkVersions({ root }).ok, true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑯ 既没给 --to 也没给 --from-dsh 时具名拒绝（不猜一个版本）', () => {
    const root = makeRepo()
    try {
      const r = bumpVersion({ root })
      assert.equal(r.ok, false)
      assert.equal(r.code, VERSION_CODES.BAD_INPUT)
      assert.match(r.message, /--to|--from-dsh/)
      // 没猜 ⇒ 文件不该被动过
      assert.equal(checkVersions({ root }).ok, true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑰ --to 非 SemVer 时拒绝，且不落盘', () => {
    const root = makeRepo()
    try {
      const before = readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8')
      const r = bumpVersion({ root, to: 'v2' })
      assert.equal(r.ok, false)
      assert.equal(r.code, VERSION_CODES.NOT_SEMVER)
      assert.equal(readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8'), before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑱ bump 用的是**生产组装器**：清单非法时不落盘', () => {
    // 把 channel 改成生产校验器不接受的值 —— 组装器应当拒绝，于是不落盘。
    const root = makeRepo({ channel: '不是通道' })
    try {
      const before = readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8')
      const r = bumpVersion({ root, to: '0.2.0' })
      assert.equal(r.ok, false, '非法清单不该被 bump 出来')
      assert.equal(r.code, VERSION_CODES.MANIFEST_INVALID)
      assert.equal(readFileSync(join(root, VERSION_SOURCES.desktopPackage), 'utf8'), before, '失败时不许落盘')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('⑲ bump 之后清单里的三个派生字段仍在（没被改版本时弄丢）', () => {
    const root = makeRepo()
    try {
      bumpVersion({ root, to: '0.4.0' })
      const man = JSON.parse(readFileSync(join(root, VERSION_SOURCES.runtimeManifest), 'utf8'))
      for (const f of ['dshCompositionPatchVersion', 'runtimeContractVersion', 'packProtocolVersion']) {
        assert.ok(typeof man[f] === 'number', `${f} 应仍在清单里`)
      }
      assert.equal(man.manifestFormat, 'legion/version-manifest@1', '格式名不该被弄丢')
      assert.equal(man.releasedAt, '2026-09-16T00:00:00.000Z', 'releasedAt 不该被弄丢')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  // ★★★ 这一条是本组里**最强**的判据：bump 写出去的那份清单，
  //      必须能被**生产校验器**接受 —— 而不是只"文件确实被改了"。
  //
  // 它守的是一个真实撞到的缺口（2026-10-10，本工作区）：
  // `renderVersionManifest` 只渲染八个 spec 字段，而 `manifestFormat`
  // 被注释归为"格式标记、不算字段"，于是产物里没有它：
  //
  //     buildVersionManifest(...)  → ok = true
  //     renderVersionManifest(...) → 能 JSON.parse、八个字段齐全
  //     validateManifest(那份产物) → **ok = false**
  //       manifest-field-missing: manifestFormat
  //
  //   > 一个"改完版本、文件也确实变了"的工具，
  //   > 与一个"改完版本、产物装得进去"的工具，在它自己的用例里是同一个东西——
  //   > 只不过前者写出的清单，用户装的时候会被拒。
  test('㉒ bump 写出的清单必须能通过**生产校验器**（能被消费，不只是文件变了）', () => {
    const root = makeRepo()
    try {
      const r = bumpVersion({ root, to: '0.4.0' })
      assert.equal(r.ok, true, r.message)
      const man = JSON.parse(readFileSync(join(root, VERSION_SOURCES.runtimeManifest), 'utf8'))
      const verdict = validateManifest(man)
      assert.equal(verdict.ok, true,
        'bump 写出的清单没通过生产校验器 —— 安装器/Launcher 会拒收它：'
        + `${JSON.stringify(verdict.problems)}`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('版本号：show（来源可读）', () => {
  test('⑳ show 把"哪些字段是推出来的、哪些要人给"分开', () => {
    const root = makeRepo()
    try {
      const r = describeVersions({ root })
      assert.equal(r.ok, true)
      const derivable = r.fieldSources.filter((f) => f.derivable).map((f) => f.field)
      const undecided = r.fieldSources.filter((f) => !f.derivable).map((f) => f.field)
      // 三个能从仓库常量推出来
      for (const f of ['dshCompositionPatchVersion', 'runtimeContractVersion', 'packProtocolVersion']) {
        assert.ok(derivable.includes(f), `${f} 应可派生`)
      }
      // 五个必须由发布决定
      for (const f of ['productVersion', 'legionVersion', 'dshVersion', 'schemaVersion', 'channel']) {
        assert.ok(undecided.includes(f), `${f} 应由发布流程给`)
      }
      assert.equal(r.derived.dshCompositionPatchVersion, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
