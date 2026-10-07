// desktop/update-wiring.testkit.mjs
// ============================================================================
// 桌面接线层用例的**造数据**部分
//
// 单独放一个文件而不是内联在 `update-wiring.test.mjs` 里，是因为这份夹具
// 带一条纪律：**它造的发行清单必须能通过真实的 `validateRelease`**。
//
// 也就是说它不能"随手填一个字段就完事"——本批次修掉的六个缺陷里，有两个
// 正是因为夹具**替生产补上了**本该由生产提供的东西（`patchBindings`、
// `freeBytes`），于是真实链路的缺口被夹具掩盖了。
//
// 所以这里的原则是：夹具只造**发布端真的会发出来的**东西
// （`publish.mjs` 的产物形状），而**不**造任何读数——读数一律由被测代码
// 在安装时去生产。清单必须过 `validateRelease` 这条约束保证了这一点：
// 缺字段、摘要不自洽都会在这里就被发现。
// ============================================================================

import { createHash } from 'node:crypto'

import { buildRelease, validateRelease } from '../product/update/release.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST } from '../product/upgrade/migration.mjs'

/** 一份合法的产品版本清单（与 `stage.mjs` 写出来的同形）。 */
export function createProductManifest(productVersion, { dshVersion = '0.8.3', patchVersion = 2 } = {}) {
  return Object.freeze({
    manifestFormat: 'legion/version-manifest@1',
    productVersion,
    legionVersion: productVersion,
    dshVersion,
    dshCompositionPatchVersion: patchVersion,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    schemaVersion: 1,
    channel: 'stable',
  })
}

/**
 * 造一份**能通过 `validateRelease`** 的发行清单。
 *
 * 用 `buildRelease` 而不是手写对象：手写的对象会在"发布端其实不会发这个形状"
 * 这件事上失去约束，而那个约束正是这套夹具的价值。
 */
export function createReleaseFixtureBundle({
  productVersion = '1.1.0', fromVersion = '1.0.0', releaseId = null,
  dshPatchBindings = [{ dshVersion: '0.8.3', compositionPatchVersion: 2 }],
  /**
   * 包字节的**真摘要**。
   *
   * ★ 必须由调用方给出（或用 `fakePackageBytes` 的返回值）。
   *   填一个占位串会让安装事务停在 `install-recheck-failed`——而那条判据
   *   是**对的**（`install.mjs` 在动任何东西之前重算包摘要）。所以夹具
   *   不能自己造一个"看起来像摘要"的串：那会让每一条经过安装事务的用例
   *   都以一个与它本身无关的理由红。
   */
  packageSha256 = 'b'.repeat(64),
  packageSizeBytes = 1024,
} = {}) {
  const id = releaseId ?? `rel-${productVersion}`
  const release = buildRelease({
    releaseId: id,
    productVersion,
    channel: 'stable',
    productManifest: createProductManifest(productVersion),
    supportedFromVersions: [fromVersion],
    minWindowsBuild: 19045,
    requiredFreeBytes: 1024,
    // ★ 补丁层成对表：目标清单里的那一对（0.8.3 / 2）。
    dshPatchBindings,
    // ★ 闭包条目：摘要在清单里、内容在包里（与 `publish.mjs --package-root`
    //   的产物同形）。
    package: {
      path: `releases/${id}/legion-win-x64.zip`,
      sizeBytes: packageSizeBytes,
      sha256: packageSha256,
      closurePath: 'closure.json',
      closureSha256: 'a'.repeat(64),
    },
    installer: { path: `releases/${id}/Legion-Setup.exe`, sizeBytes: 1024, sha256: 'c'.repeat(64) },
    notes: { path: `releases/${id}/notes.txt`, sizeBytes: 8, sha256: 'd'.repeat(64) },
    // ★ 迁移计划：空（产品里确实还没有迁移），而摘要是**算出来的**那一个。
    migrationPlanDigest: EMPTY_MIGRATION_PLAN_DIGEST,
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
  })

  // ★ 夹具自己先过一遍真判据：一份"发布端发不出来"的清单会让用例在
  //   别的地方以莫名其妙的理由红，而根因在这里。
  const validated = validateRelease(release)
  if (validated.ok !== true) {
    throw new Error(`夹具造出的发行清单没有通过 validateRelease：${validated.reason}`)
  }
  return Object.freeze({ release, id })
}

/** 一个"已就绪的包"的字节与摘要（内容不重要，摘要要自洽）。 */
export function fakePackageBytes(payload = 'PK\u0003\u0004 pretend zip payload') {
  const bytes = Buffer.from(payload)
  return Object.freeze({ bytes, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
