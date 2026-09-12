// ============================================================================
// PRT-801 / PRT-802 的判据：产品版本清单与 DSH/依赖的精确版本锁定。
//
// 这一组盯的**不是**"清单字段齐不齐"，而是**两个版本字段之间的关系**：
// `dshVersion` 与 `dshCompositionPatchVersion` 描述的是同一件事（spec §9.1
// line 689），而分开验证会让"DSH 升了、补丁层没跟上"这个组合**完全隐形**——
// 进程照常启动、API 照常可用，只有强制面不在了。
//
//   > 一个"DSH 升级成功、补丁层没跟上"的安装，
//   > 与一个"ToolGuard / pre-execute / approval answerer / preset 表全都不在、
//   > 而进程照常起来"的安装，是同一个东西。
//
// 第二组盯的是 N-1 窗口：spec line 737 说"不承诺跨多个主版本直接升级"，
// 而"窗口"如果只是一句口号，N-2 会安静地通过。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANNELS,
  MANIFEST_CHECKED,
  MANIFEST_CODES,
  assertManifest,
  canonicalJson,
  checkUpgradePath,
  compareVersions,
  createManifest,
  digestOf,
  isExactVersion,
  majorOf,
  parseVersion,
  reconcileObserved,
  upgradeWindow,
  validateManifest,
} from '../../product/upgrade/manifest.mjs'

/** 一份完整的合法清单。测试里所有"改坏某一个字段"都以它为基准。 */
function goodManifest(overrides = {}) {
  return createManifest({
    productVersion: '0.9.0',
    legionVersion: '0.9.0',
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    schemaVersion: 12,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    channel: 'stable',
    dependencies: { 'node:sqlite': '1.0.0', typescript: '5.6.2' },
    ...overrides,
  })
}

// ── 精确版本锁定 ────────────────────────────────────────────────────────────

test('① 区间记号一个都过不去（它们让清单描述的不是机器上真正跑的东西）', () => {
  for (const ranged of ['^0.8.3', '~0.8.3', '0.8.x', '>=0.8.3', '<0.9.0', '0.8.3 || 0.9.0', '*', '']) {
    assert.equal(isExactVersion(ranged), false, `${JSON.stringify(ranged)} 被判为精确版本`)
  }
  for (const exact of ['0.8.3', '1.0.0', '0.9.0-alpha.1']) {
    assert.equal(isExactVersion(exact), true, `${exact} 被判为非精确版本`)
  }
})

test('① ★ 报出的错误码要能区分「形状不对」与「是区间」——两者的修法不同', () => {
  const shape = validateManifest(goodManifest({ dshVersion: '零点儿八' }))
  const range = validateManifest(goodManifest({ dshVersion: '^0.8.3' }))
  assert.equal(shape.ok, false)
  assert.equal(range.ok, false)
  const shapeCode = shape.problems.find((p) => p.field === 'dshVersion').code
  const rangeCode = range.problems.find((p) => p.field === 'dshVersion').code
  assert.equal(shapeCode, MANIFEST_CODES.VERSION_MALFORMED, JSON.stringify(shape.problems))
  assert.equal(rangeCode, MANIFEST_CODES.VERSION_NOT_EXACT, JSON.stringify(range.problems))
  assert.notEqual(shapeCode, rangeCode)
})

test('② ★ 依赖是**逐个**查的：只看顶层 dshVersion 会漏掉这一条', () => {
  const ok = validateManifest(goodManifest())
  assert.equal(ok.ok, true, JSON.stringify(ok.problems))
  assert.equal(ok.dependencyCount, 2)

  const bad = validateManifest(goodManifest({ dependencies: { 'node:sqlite': '1.0.0', typescript: '^5.6.2' } }))
  assert.equal(bad.ok, false, '一个写区间的依赖被判为合法')
  const hit = bad.problems.find((p) => p.code === MANIFEST_CODES.DEPENDENCY_NOT_EXACT)
  assert.ok(hit, JSON.stringify(bad.problems))
  assert.equal(hit.field, 'dependencies.typescript')
})

test('② ★★ 补丁层版本缺失（0）必须被拒：它就是「成对」的反面', () => {
  const r = validateManifest(goodManifest({ dshCompositionPatchVersion: 0 }))
  assert.equal(r.ok, false, '补丁层版本 0 被判为合法——强制面没有挂载点')
  assert.ok(r.problems.some((p) => p.code === MANIFEST_CODES.PATCH_PAIR_MISMATCH), JSON.stringify(r.problems))
})

test('② ★★ DSH 版本不可比较时，「成对」这条就不再有意义——必须报出来', () => {
  // 这一条容易被写成"版本形状不对，报一次就够"。但 `0.8.x` 同时意味着
  // "补丁锚点无从验证"，那是另一件事，漏报会让校验者以为成对关系查过了。
  const r = validateManifest(goodManifest({ dshVersion: '0.8.x' }))
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => p.code === MANIFEST_CODES.PATCH_PAIR_MISMATCH), JSON.stringify(r.problems))
})

test('③ 通道与格式版本都必须可枚举', () => {
  assert.equal(validateManifest(goodManifest({ channel: 'beta' })).problems
    .some((p) => p.code === MANIFEST_CODES.CHANNEL_UNKNOWN), true)
  assert.equal(validateManifest(goodManifest({ manifestFormat: 'legion/version-manifest@9' })).problems
    .some((p) => p.code === MANIFEST_CODES.FIELD_MISSING), true)
  assert.deepEqual([...CHANNELS], ['internal', 'canary', 'stable'])
})

test('③ `assertManifest` 抛出的错误里带**逐项**问题，不只是一句"不合法"', () => {
  assert.throws(
    () => assertManifest(goodManifest({ productVersion: '^1.0.0', channel: 'beta' })),
    (e) => {
      assert.ok(e.message.includes('manifest-'), e.message)
      assert.ok(e.message.includes('channel') || e.message.includes('productVersion'), e.message)
      return true
    },
  )
  assert.equal(assertManifest(goodManifest()).productVersion, '0.9.0')
})

// ── 版本比较与摘要 ──────────────────────────────────────────────────────────

test('④ 版本比较不能退化成字符串比较（0.10.0 > 0.9.0）', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0'), -1)
  assert.equal(majorOf('2.5.1'), 2)
  assert.equal(parseVersion('0.8.3-alpha.2').prerelease, 'alpha.2')
})

test('④ 清单摘要与键序无关（否则签名会因为序列化方式而随机失败）', () => {
  const a = goodManifest()
  const b = Object.freeze({
    channel: a.channel,
    packProtocolVersion: a.packProtocolVersion,
    runtimeContractVersion: a.runtimeContractVersion,
    schemaVersion: a.schemaVersion,
    dshCompositionPatchVersion: a.dshCompositionPatchVersion,
    dshVersion: a.dshVersion,
    legionVersion: a.legionVersion,
    productVersion: a.productVersion,
    manifestFormat: a.manifestFormat,
    dependencies: { typescript: '5.6.2', 'node:sqlite': '1.0.0' },
  })
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(digestOf(a), digestOf(b))
  assert.notEqual(digestOf(a), digestOf(goodManifest({ dshCompositionPatchVersion: 3 })))
})

// ── N-1 窗口 ────────────────────────────────────────────────────────────────

test('⑤ ★★ N-1 窗口：1.1.0 → 2.0.0 允许，1.2.0 → 2.0.0 拒绝（N-2 真的被拦）', () => {
  const n1 = upgradeWindow('1.1.0', '2.0.0')
  assert.equal(n1.allowed, true, n1.reason)

  const n2 = upgradeWindow('1.2.0', '2.0.0')
  assert.equal(n2.allowed, false, '1.2.0 → 2.0.0 被判为在窗口内——N-1 这句约束没有落地')
  assert.equal(n2.code, MANIFEST_CODES.UPGRADE_NOT_ALLOWED)
  assert.ok(n2.reason.includes('1.1.0'), n2.reason)
})

test('⑤ ★ 跨两个主版本、同主版本内升级、降级：三条各归各的码', () => {
  const crossTwo = upgradeWindow('1.0.0', '3.0.0')
  assert.equal(crossTwo.allowed, false)
  assert.equal(crossTwo.steps, 2)

  const inner = upgradeWindow('2.1.0', '2.2.0')
  assert.equal(inner.allowed, true, inner.reason)

  const down = upgradeWindow('2.2.0', '2.1.0')
  assert.equal(down.allowed, false)
  assert.equal(down.code, MANIFEST_CODES.DOWNGRADE, '降级被报成了"升级不在窗口内"——两者的处置完全不同')
})

test('⑤ 开发期 0.x：主版本 0 内的前进都允许，但 0.9.0 → 1.0.0 要 0.1.0 才在窗口内', () => {
  assert.equal(upgradeWindow('0.6.0', '0.9.0').allowed, true)
  assert.equal(upgradeWindow('0.1.0', '1.0.0').allowed, true)
  const tooOld = upgradeWindow('0.9.0', '1.0.0')
  assert.equal(tooOld.allowed, false, '0.9.0 直接升到 1.0.0 被判为窗口内')
  assert.ok(tooOld.reason.includes('0.1.0'), tooOld.reason)
})

test('⑥ 同版本不算升级；通道不同要由通道策略决定', () => {
  const same = upgradeWindow('0.9.0', '0.9.0')
  assert.equal(same.allowed, false)
  assert.equal(same.steps, 0)

  const crossChannel = checkUpgradePath(
    goodManifest({ channel: 'stable' }),
    goodManifest({ productVersion: '0.9.1', channel: 'canary' }),
  )
  assert.equal(crossChannel.allowed, false)
  assert.ok(crossChannel.problems.some((p) => p.code === MANIFEST_CODES.UPGRADE_NOT_ALLOWED))
})

test('⑥ ★ 没有绑定表时，成对关系是 `unverified`，不是 `match`', () => {
  const unverified = checkUpgradePath(
    goodManifest({ productVersion: '0.8.0' }),
    goodManifest({ productVersion: '0.9.0' }),
  )
  assert.equal(unverified.allowed, true)
  assert.equal(unverified.patchPair, 'unverified', '没有绑定表时把成对关系报成了已验证')

  const mismatch = checkUpgradePath(
    goodManifest({ productVersion: '0.8.0' }),
    goodManifest({ productVersion: '0.9.0' }),
    { patchPair: 'mismatch' },
  )
  assert.equal(mismatch.allowed, false)
  assert.ok(mismatch.problems.some((p) => p.code === MANIFEST_CODES.PATCH_PAIR_MISMATCH))
})

// ── 与实际对账 ──────────────────────────────────────────────────────────────

test('⑦ ★★ 观测不到版本 ≠ 一致（缺失的观测不是证据）', () => {
  const r = reconcileObserved(goodManifest(), { dshVersion: '0.8.3' })
  assert.equal(r.consistent, false, '只观测到 DSH 版本时被判为"与清单一致"')
  assert.equal(r.drift.length, 3)
  assert.ok(r.drift.every((d) => d.kind === 'unobserved'), JSON.stringify(r.drift))
})

test('⑦ 补丁层版本漂移会被单独点名——这正是那条最隐蔽的组合', () => {
  const r = reconcileObserved(goodManifest(), {
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 1, // DSH 升了，补丁层没跟上
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
  })
  assert.equal(r.consistent, false)
  assert.equal(r.drift.length, 1)
  const d = r.drift[0]
  assert.equal(d.field, 'dshCompositionPatchVersion')
  assert.equal(d.kind, 'mismatch')
  assert.equal(d.expected, 2)
  assert.equal(d.observed, 1)

  const consistent = reconcileObserved(goodManifest(), {
    dshVersion: '0.8.3', dshCompositionPatchVersion: 2, runtimeContractVersion: 1, packProtocolVersion: 1,
  })
  assert.equal(consistent.consistent, true, JSON.stringify(consistent.drift))
})

// ── 装载期自检 ──────────────────────────────────────────────────────────────

test('⑧ ★ 装载期自检留下的是**算出来的值**，且它真的跑过每条判据', () => {
  assert.deepEqual([...MANIFEST_CHECKED.problems], [])
  const s = MANIFEST_CHECKED.samples

  // 四个算出来的读数必须落在"判据真的生效"的那一侧。
  assert.equal(s.goodOk, true)
  assert.equal(s.rangedOk, false)
  assert.equal(s.rangedCode, MANIFEST_CODES.VERSION_NOT_EXACT)
  assert.equal(s.noPatchOk, false)
  assert.equal(s.pairBrokenOk, false)
  assert.equal(s.pairBrokenCode, MANIFEST_CODES.VERSION_NOT_EXACT)
  assert.equal(s.n2Allowed, false, '自检里 N-2 居然是允许的')
  assert.equal(s.n1Allowed, true)
  assert.equal(s.unobservedDrift, 3)
  assert.match(s.goodDigest, /^sha256:[0-9a-f]{64}$/)
})

test('⑧ ★ 自检会**发现**坏输入：把清单改坏一次，problems 必须非空', () => {
  // 直接构造一份"自检里那几条判据都该拦"的输入，确认判据函数本身不是恒真。
  const cases = [
    { dshVersion: '^0.8.3' },
    { dshCompositionPatchVersion: 0 },
    { dependencies: { x: '*' } },
    { channel: 'whatever' },
  ]
  for (const c of cases) {
    const r = validateManifest(goodManifest(c))
    assert.equal(r.ok, false, `改坏 ${JSON.stringify(c)} 之后仍然判为合法`)
    assert.ok(r.problems.length > 0)
  }
})
