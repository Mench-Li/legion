// runtime/packs/manifest.test.mjs
// ============================================================================
// PRT-1001 / PRT-1002 的判据：PackManifest、语义版本、协议版本、
// 内容哈希、签名/来源、依赖与兼容性预检。
//
// spec §6.13 line 565–568：
//   「`PackManifest`：`packId`、`packType`（`team` / `overlay`）、`version`（semver）、
//     `packProtocolVersion`、内容哈希、入口、依赖、兼容的 Legion/DSH 版本区间、
//     请求的权限、明确声明的数据依赖、来源/签名。安装时验证签名/来源、内容哈希、
//     `packProtocolVersion`、依赖和产品兼容性。」
//
// spec 阶段 10 完成标准 line 1006：
//   「不兼容、缺依赖、哈希错误或越权包在创建目标前失败。」
//   —— 前三项在这个文件里；「越权」与「创建目标前」在 authority.test.mjs。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEPENDENCY_FIELDS,
  HOST_COMPAT_FIELDS,
  MANIFEST_CODES,
  PACK_CONTENT_SCHEMA_VERSION,
  PACK_MANIFEST_CHECKED,
  PACK_MANIFEST_FIELDS,
  PACK_MANIFEST_VERSION,
  PACK_PROTOCOL_VERSION,
  PACK_TRUST_LEVELS,
  PACK_TYPES,
  PROVENANCE_FIELDS,
  REQUIRED_PACK_FIELDS,
  SAMPLE_HOST,
  UNBOUNDED_RANGES,
  compareContents,
  compareSemver,
  computeContentHash,
  contentHashOfEntries,
  normalizePackManifest,
  normalizePayload,
  parseSemver,
  preflightCompatibility,
  preflightDependencies,
  preflightManifest,
  samplePack,
  satisfiesRange,
  trustOf,
  verifyContentHash,
  verifyProvenance,
} from './manifest.mjs'

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

const verdictOf = (manifest, files) => preflightManifest({
  manifest, files, host: SAMPLE_HOST, builtinPackIds: [manifest.packId ?? 'legion.sample'],
})
const codesOf = (verdict) => verdict.problems.map((p) => p.code)

// --------------------------------------------------------------- 装载自检

test('⑩ ★ 装载自检没有未解决的问题，且每条读数都是**算出来的**', () => {
  assert.deepEqual(PACK_MANIFEST_CHECKED.problems, [])
  // 留证不是布尔：这几条都是算出来的值
  assert.equal(PACK_MANIFEST_CHECKED.samples.hashOrderInvariantHolds, true)
  assert.equal(PACK_MANIFEST_CHECKED.samples.hashChangesWithContent, true)
  assert.deepEqual(PACK_MANIFEST_CHECKED.samples.versionOrder, [1, 1, -1])
  assert.equal(PACK_MANIFEST_CHECKED.samples.normalizeIdempotent, true)
  // "改过内容" 与 "只改了哈希" 是两个不同的码，两条路都要留读数
  assert.equal(PACK_MANIFEST_CHECKED.samples.tamperedCode, MANIFEST_CODES.CONTENTS_MISMATCH)
  assert.equal(PACK_MANIFEST_CHECKED.samples.restampedOnlyCode, MANIFEST_CODES.CONTENT_HASH_MISMATCH)
})

// --------------------------------------------------------------- ① 字段与类型

test('① manifest 字段闭合：多一个不认识的字段就拒绝', () => {
  const pack = samplePack()
  // 一个多打一个字母的字段名会让这一项**静默失效**：拒绝它，
  // 宁可让作者当场知道，也不要让它安静地不生效。
  const manifest = { ...pack.manifest, requestPermissions: pack.manifest.requestedPermissions }
  const verdict = verdictOf(manifest, pack.files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.BAD_MANIFEST), JSON.stringify(codesOf(verdict)))
  assert.equal(PACK_MANIFEST_FIELDS.includes('requestPermissions'), false)
  assert.equal(PACK_MANIFEST_FIELDS.includes('requestedPermissions'), true)
})

test('① manifest 里出现强制面字段 → 拒绝，且码与"字段不认识"分开', () => {
  const pack = samplePack()
  // 这两条要分开：一个是"我不知道这个字段"，另一个是"这个字段属于 host 平面"。
  // 值班的人要能分清是拼错了还是越权了。
  const verdict = verdictOf({ ...pack.manifest, approvalPolicy: 'never' }, pack.files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.FIELD_ON_ENFORCEMENT_PLANE), JSON.stringify(codesOf(verdict)))
})

test('① packType 只认 team / overlay', () => {
  const pack = samplePack()
  const verdict = verdictOf({ ...pack.manifest, packType: 'plugin' }, pack.files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.BAD_TYPE), JSON.stringify(codesOf(verdict)))
  assert.deepEqual(PACK_TYPES, ['team', 'overlay'])
})

test('① 必需的 manifest 字段缺一项就拒绝', () => {
  const pack = samplePack()
  for (const field of REQUIRED_PACK_FIELDS) {
    if (field === 'dependsOn' || field === 'compatibility') continue // 这两项有自己的码，另有专门用例
    const manifest = { ...pack.manifest }
    delete manifest[field]
    const verdict = verdictOf(manifest, pack.files)
    assert.equal(verdict.ok, false, `缺 ${field} 的 manifest 通过了预检`)
  }
})

test('① 协议版本只比**相等**：更高的版本意味着有未知字段，不能当成兼容', () => {
  const pack = samplePack()
  const verdict = verdictOf({ ...pack.manifest, packProtocolVersion: PACK_PROTOCOL_VERSION + 1 }, pack.files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.PROTOCOL_MISMATCH), JSON.stringify(codesOf(verdict)))
})

test('① 归一化是幂等的，而且**不伪造**作者没写的字段', () => {
  const pack = samplePack()
  const once = normalizePackManifest(pack.manifest)
  const twice = normalizePackManifest(once)
  assert.deepEqual(twice, once, '第二次归一化产生了不同的结果')

  // `containsSecrets` 缺省时归一化**不能**补一个 `false`——
  // 那等于代替作者做了"这个包不含密钥"的声明，而 authority 那条检查正是要问作者。
  const { containsSecrets, ...without } = pack.manifest
  const n = normalizePackManifest(without)
  assert.equal(
    Object.prototype.hasOwnProperty.call(n, 'containsSecrets'), false,
    '归一化替作者声明了 containsSecrets',
  )
})

// --------------------------------------------------------------- ② 语义版本

test('② 语义版本：预发布低于正式版，`^` 碰到第一个非零位就进位', () => {
  assert.equal(compareSemver('1.2.0-alpha', '1.2.0'), -1)
  assert.deepEqual(parseSemver('1.2.3-alpha.1'), {
    raw: '1.2.3-alpha.1', major: 1, minor: 2, patch: 3, prerelease: 'alpha.1', build: null,
  })
  assert.equal(satisfiesRange('1.9.9', '^1.2.0'), true)
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false)
  // 非预发布区间**不**匹配预发布版本
  assert.equal(satisfiesRange('1.2.0-alpha', '^1.2.0'), false)
  // `^0.2.3` 只到 0.2.x
  assert.equal(satisfiesRange('0.3.0', '^0.2.3'), false)
  assert.equal(satisfiesRange('0.2.9', '^0.2.3'), true)
})

test('② ★ 无边界的版本区间**抛**，不是返回 true', () => {
  //   > 一个「`*` 一律返回 true」的区间判断，
  //   > 与一个「兼容性预检从不拒绝任何包」的区间判断，是同一个东西。
  for (const r of UNBOUNDED_RANGES) {
    assert.equal(codeOf(() => satisfiesRange('1.0.0', r)), MANIFEST_CODES.RANGE_UNBOUNDED, `区间 ${JSON.stringify(r)} 没有被拒`)
  }
})

// --------------------------------------------------------------- ③ 内容哈希

test('③ 内容哈希只覆盖 {path, sha256}：与文件顺序无关，与内容有关', () => {
  const entries = normalizePayload([{ path: 'b.txt', text: 'B' }, { path: 'a.txt', text: 'A' }])
  const reordered = normalizePayload([{ path: 'a.txt', text: 'A' }, { path: 'b.txt', text: 'B' }])
  assert.equal(contentHashOfEntries(entries), contentHashOfEntries(reordered), '顺序变了哈希就变了')
  const changed = normalizePayload([{ path: 'a.txt', text: 'A' }, { path: 'b.txt', text: 'CHANGED' }])
  assert.notEqual(contentHashOfEntries(entries), contentHashOfEntries(changed), '内容变了哈希没变')
  assert.equal(PACK_CONTENT_SCHEMA_VERSION, 1)
})

test('③ 路径规则：穿越、绝对路径、重复、仅大小写不同的碰撞都要拒', () => {
  const cases = [
    ['穿越', [{ path: '../escape.txt', text: 'x' }], MANIFEST_CODES.PATH_TRAVERSAL],
    ['盘符', [{ path: 'C:/abs.txt', text: 'x' }], MANIFEST_CODES.PATH_TRAVERSAL],
    ['绝对', [{ path: '/abs.txt', text: 'x' }], MANIFEST_CODES.PATH_TRAVERSAL],
    ['重复', [{ path: 'a.txt', text: '1' }, { path: 'a.txt', text: '2' }], MANIFEST_CODES.PATH_DUPLICATE],
    ['大小写碰撞', [{ path: 'A.txt', text: '1' }, { path: 'a.txt', text: '2' }], MANIFEST_CODES.PATH_COLLISION],
  ]
  for (const [name, files, code] of cases) {
    assert.equal(codeOf(() => normalizePayload(files)), code, `${name} 的载荷得到 ${codeOf(() => normalizePayload(files))}，期望 ${code}`)
  }
})

test('③ ★ 内容对不上时**具体原因**要说出来：改内容 vs 只改哈希', () => {
  const pack = samplePack()

  // (a) 改了内容但没更新 contents 表 → 逐文件比对先发现
  const tampered = pack.files.map((f) => (
    f.path === pack.files[0].path ? { ...f, text: `${f.text}\n// 改过` } : f
  ))
  const a = verifyContentHash({ manifest: pack.manifest, files: tampered })
  assert.equal(a.ok, false)
  assert.equal(a.code, MANIFEST_CODES.CONTENTS_MISMATCH)

  // (b) 连 contents 表一起改了，只留下 contentHash 是旧的 → 只剩总哈希能发现
  const entries = normalizePayload(tampered)
  const restamped = {
    ...pack.manifest,
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
  }
  const b = verifyContentHash({ manifest: restamped, files: tampered })
  assert.equal(b.ok, false)
  assert.equal(b.code, MANIFEST_CODES.CONTENT_HASH_MISMATCH)

  // 阳性对照：原样的包必须通过，否则上面两条拒绝可能只是"什么都拒"
  assert.equal(verifyContentHash({ manifest: pack.manifest, files: pack.files }).ok, true)
})

test('③ compareContents 给出的是**算出来的差异表**，不是一句"不一致"', () => {
  const pack = samplePack()
  const declared = normalizePackManifest(pack.manifest).contents
  const entries = normalizePayload(pack.files)
  const same = compareContents({ declared, entries })
  assert.equal(same.ok, true)
  assert.deepEqual(same.missing, [])
  assert.deepEqual(same.extra, [])
  assert.deepEqual(same.drifted, [])

  const dropped = compareContents({ declared, entries: entries.slice(1) })
  assert.equal(dropped.ok, false)
  assert.equal(dropped.missing.length, 1, '少了一个文件没有被算成 missing')

  const extra = compareContents({
    declared,
    entries: normalizePayload([...pack.files, { path: 'extra.txt', text: 'x' }]),
  })
  assert.equal(extra.ok, false)
  assert.deepEqual(extra.extra, ['extra.txt'], '多出来的文件没有被点名')
})

test('③ 重算内容哈希与 manifest 里的对不上就拒绝', () => {
  const pack = samplePack()
  const manifest = { ...pack.manifest, contentHash: `sha256:${'0'.repeat(64)}` }
  const verdict = verdictOf(manifest, pack.files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.CONTENT_HASH_MISMATCH), JSON.stringify(codesOf(verdict)))
  assert.equal(computeContentHash(pack.files), pack.manifest.contentHash)
})

// --------------------------------------------------------------- ④ 来源与签名

test('④ ★ 包里自称"内置"不算数：可信等级来自**宿主的登记表**', () => {
  const pack = samplePack()
  const claimed = {
    ...pack.manifest,
    provenance: { signer: 'legion', keyId: 'k1', signature: 'sig' },
  }
  // 宿主登记了它 → builtin；没登记 → unsigned（签名者是自报的，没有验证器就不算数）
  assert.equal(trustOf({ manifest: claimed, builtinPackIds: [claimed.packId] }).level, 'builtin')
  assert.equal(trustOf({ manifest: claimed, builtinPackIds: [] }).level, 'unsigned')
  assert.deepEqual(PACK_TRUST_LEVELS, ['builtin', 'signed', 'unsigned'])

  // 有验证器且验证通过 → signed
  assert.equal(trustOf({ manifest: claimed, verifier: () => true, builtinPackIds: [] }).level, 'signed')
  assert.equal(trustOf({ manifest: claimed, verifier: () => ({ valid: true }), builtinPackIds: [] }).level, 'signed')
  // 验证器说不通过 → unsigned，而不是"就当它签过"
  assert.equal(trustOf({ manifest: claimed, verifier: () => false, builtinPackIds: [] }).level, 'unsigned')
  // 验证器抛 → 也是 unsigned
  assert.equal(trustOf({ manifest: claimed, verifier: () => { throw new Error('坏') }, builtinPackIds: [] }).level, 'unsigned')

  // 每种等级都要给出**理由**：报表上一句"unsigned"没人能据此排查
  for (const t of [
    trustOf({ manifest: claimed, builtinPackIds: [claimed.packId] }),
    trustOf({ manifest: claimed, builtinPackIds: [] }),
    trustOf({ manifest: claimed, verifier: () => true, builtinPackIds: [] }),
  ]) {
    assert.equal(typeof t.why, 'string')
    assert.ok(t.why.length > 0)
  }
})

test('④ provenance **没有** trustLevel 这个字段：等级是判定结果，不是输入', () => {
  const pack = samplePack()
  // `verifyProvenance` **返回**判定（不抛），所以这里比的是它给回来的码。
  const verdict = verifyProvenance({
    manifest: { ...pack.manifest, provenance: { signer: 'a', keyId: 'b', signature: 'c', trustLevel: 'builtin' } },
    builtinPackIds: [],
  })
  // 作者在 provenance 里写 `trustLevel: 'builtin'` 不会让它变成内置——
  // 等级只来自宿主登记表与注入的验证器。
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, MANIFEST_CODES.PROVENANCE_UNVERIFIED)
  assert.equal(verdict.trust.level, 'unsigned')
  assert.deepEqual(PROVENANCE_FIELDS, ['signer', 'keyId', 'signature'])
  assert.equal(PROVENANCE_FIELDS.includes('trustLevel'), false)
})

test('④ provenance 字段闭合由 normalizePackManifest 把守', () => {
  const pack = samplePack()
  const err = codeOf(() => normalizePackManifest({
    ...pack.manifest,
    provenance: { signer: 'a', keyId: 'b', signature: 'c', trustLevel: 'builtin' },
  }))
  assert.equal(err, MANIFEST_CODES.BAD_MANIFEST)
})

test('④ 没有来源声明时等级是 unsigned，预检把它记进 computed 并给出理由', () => {
  const pack = samplePack()
  const manifest = { ...pack.manifest, provenance: null }
  const builtin = verdictOf(manifest, pack.files)
  assert.equal(builtin.computed.trust, 'builtin', '内置登记表在，等级应当来自宿主登记表')

  const unsigned = preflightManifest({
    manifest: { ...manifest, packId: 'legion.unknown' },
    files: pack.files,
    host: SAMPLE_HOST,
    builtinPackIds: [],
  })
  assert.equal(unsigned.computed.trust, 'unsigned')
  assert.equal(typeof unsigned.computed.trustWhy, 'string')
  assert.equal(unsigned.ok, false)
  assert.ok(codesOf(unsigned).includes(MANIFEST_CODES.PROVENANCE_MISSING), JSON.stringify(codesOf(unsigned)))
})

// --------------------------------------------------------------- ⑤ 依赖

test('⑤ ★ `dependsOn` 缺字段 ≠ 没有依赖：缺字段拒绝，空表要写 `[]`', () => {
  const pack = samplePack()
  const { dependsOn, ...without } = pack.manifest
  // 结构层不接受缺字段的语义判定（那是结构 vs 语义的分工），
  // 但 `preflightDependencies` 必须在**语义**层拒绝它。
  const deps = preflightDependencies({ manifest: normalizePackManifest(without), installed: [] })
  assert.equal(deps.problems.length, 1)
  assert.equal(deps.problems[0].code, MANIFEST_CODES.DEPENDENCY_UNDECLARED)
  // 写出来的空表是合法的
  assert.deepEqual(preflightDependencies({ manifest: normalizePackManifest(pack.manifest), installed: [] }).problems, [])
})

test('⑤ 缺依赖要**点名缺的是哪一个**', () => {
  const pack = samplePack()
  const manifest = normalizePackManifest({
    ...pack.manifest,
    dependsOn: [
      { packId: 'legion.base', range: '^1.0.0' },
      { packId: 'legion.never-installed', range: '^2.0.0' },
    ],
  })
  const r = preflightDependencies({ manifest, installed: [{ packId: 'legion.base', version: '1.4.0' }] })
  assert.deepEqual(r.resolved.map((x) => x.packId), ['legion.base'])
  const missing = r.problems.filter((p) => p.code === MANIFEST_CODES.DEPENDENCY_MISSING)
  assert.equal(missing.length, 1)
  assert.match(missing[0].message, /legion\.never-installed/, '缺依赖没有点名')
})

test('⑤ ★ 依赖字段名写错时，拒绝理由要指向**那个字段**而不是"范围无界"', () => {
  // 实测撞到过：`range:` 写成 `version:` 时 `dep.range` 是 undefined，
  // 而 `satisfiesRange(_, undefined)` 给出的码是 RANGE_UNBOUNDED。
  //   > 一个「拒绝理由指向另一个字段」的校验，
  //   > 与一个「把值班的人引到错误的那一行」的校验，是同一个东西。
  const pack = samplePack()
  const manifest = normalizePackManifest({
    ...pack.manifest,
    dependsOn: [{ packId: 'legion.base', version: '^1.0.0' }],
  })
  const r = preflightDependencies({ manifest, installed: [{ packId: 'legion.base', version: '1.4.0' }] })
  assert.deepEqual(r.problems.map((p) => p.code), [MANIFEST_CODES.DEPENDENCY_FIELD_UNKNOWN])
  assert.match(r.problems[0].message, /range/, '拒绝理由没有说到 range 这个字段')

  // 阳性对照：写法正确时必须过
  const right = preflightDependencies({
    manifest: normalizePackManifest({
      ...pack.manifest, dependsOn: [{ packId: 'legion.base', range: '^1.0.0' }],
    }),
    installed: [{ packId: 'legion.base', version: '1.4.0' }],
  })
  assert.deepEqual(right.problems, [])
  assert.deepEqual(DEPENDENCY_FIELDS, ['packId', 'range'])
})

test('⑤ 装了但版本区间不满足 → 与"没装"是两个码', () => {
  const pack = samplePack()
  const manifest = normalizePackManifest({
    ...pack.manifest,
    dependsOn: [{ packId: 'legion.base', range: '^2.0.0' }],
  })
  const r = preflightDependencies({ manifest, installed: [{ packId: 'legion.base', version: '1.0.0' }] })
  assert.deepEqual(r.problems.map((p) => p.code), [MANIFEST_CODES.DEPENDENCY_INCOMPATIBLE])
})

test('⑤ 依赖自己 / 依赖写两遍 / 已安装清单有歧义，各有自己的码', () => {
  const pack = samplePack()
  const self = preflightDependencies({ manifest: normalizePackManifest({ ...pack.manifest, dependsOn: [{ packId: pack.manifest.packId, range: '^1.0.0' }] }) })
  assert.deepEqual(self.problems.map((p) => p.code), [MANIFEST_CODES.DEPENDENCY_SELF])

  const dup = preflightDependencies({
    manifest: normalizePackManifest({
      ...pack.manifest,
      dependsOn: [{ packId: 'legion.base', range: '^1.0.0' }, { packId: 'legion.base', range: '^2.0.0' }],
    }),
    installed: [{ packId: 'legion.base', version: '1.4.0' }],
  })
  assert.deepEqual(dup.problems.map((p) => p.code), [MANIFEST_CODES.DEPENDENCY_DUPLICATE])

  const ambiguous = preflightDependencies({
    manifest: normalizePackManifest(pack.manifest),
    installed: [{ packId: 'legion.base', version: '1.0.0' }, { packId: 'legion.base', version: '2.0.0' }],
  })
  assert.deepEqual(ambiguous.problems.map((p) => p.code), [MANIFEST_CODES.INSTALLED_AMBIGUOUS])
})

// --------------------------------------------------------------- ⑥ 兼容性

test('⑥ ★ 三项兼容条件缺一不可：没声明 = "与一切兼容"', () => {
  const pack = samplePack()
  for (const field of HOST_COMPAT_FIELDS) {
    const compatibility = { ...pack.manifest.compatibility }
    delete compatibility[field]
    const r = preflightCompatibility({ manifest: { ...pack.manifest, compatibility }, host: SAMPLE_HOST })
    assert.deepEqual(r.problems.map((p) => p.code), [MANIFEST_CODES.COMPAT_UNDECLARED], `缺 ${field} 时得到 ${JSON.stringify(r.problems.map((p) => p.code))}`)
  }
  // `compatibility` 整块缺失也是同一个码
  const none = preflightCompatibility({ manifest: { ...pack.manifest, compatibility: null }, host: SAMPLE_HOST })
  assert.deepEqual(none.problems.map((p) => p.code), [MANIFEST_CODES.COMPAT_UNDECLARED])
})

test('⑥ 产品版本不满足区间 → 不兼容；DSH 补丁版本按语义版本比', () => {
  const pack = samplePack()
  const badProduct = normalizePackManifest({
    ...pack.manifest,
    compatibility: { ...pack.manifest.compatibility, product: '^9.0.0' },
  })
  const r = preflightCompatibility({ manifest: badProduct, host: SAMPLE_HOST })
  assert.deepEqual(r.problems.map((p) => p.code), [MANIFEST_CODES.COMPAT_INCOMPATIBLE])
  assert.equal(r.problems[0].field, 'compatibility.product')

  const badPatch = normalizePackManifest({
    ...pack.manifest,
    compatibility: { ...pack.manifest.compatibility, dshCompositionPatchVersion: '^99.0.0' },
  })
  const r2 = preflightCompatibility({ manifest: badPatch, host: SAMPLE_HOST })
  assert.deepEqual(r2.problems.map((p) => p.code), [MANIFEST_CODES.COMPAT_INCOMPATIBLE])
  assert.equal(r2.problems[0].field, 'compatibility.dshCompositionPatchVersion')
})

test('⑥ 兼容性读数逐项留证（三条判据各自的可比两边）', () => {
  const pack = samplePack()
  const r = preflightCompatibility({ manifest: normalizePackManifest(pack.manifest), host: SAMPLE_HOST })
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.readings.map((x) => x.field), [...HOST_COMPAT_FIELDS])
  for (const reading of r.readings) {
    assert.equal(reading.satisfied, true)
    assert.ok(reading.declared !== undefined, `${reading.field} 的读数没有声明值`)
    assert.ok(reading.host !== undefined, `${reading.host} 的读数没有宿主值`)
  }
})

test('⑥ ★ 宿主报不出自己的版本时是 HOST_VERSION_UNKNOWN，不是"包不兼容"', () => {
  // 这两件事要分得开：一个是"宿主说不清自己是什么"，另一个是"包与宿主要求对不上"。
  // 值班的人要能分清该去查哪一边——而把两者合成一个码会让这件事不可能。
  const pack = samplePack()
  const verdict = preflightManifest({
    manifest: pack.manifest,
    files: pack.files,
    host: { productVersion: 'not-a-version', packProtocolVersion: PACK_PROTOCOL_VERSION, dshCompositionPatchVersion: 1 },
    builtinPackIds: [pack.manifest.packId],
  })
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.HOST_VERSION_UNKNOWN), JSON.stringify(codesOf(verdict)))
  // 而且**不能**同时报"不兼容"——那是两个不同的结论
  assert.equal(codesOf(verdict).includes(MANIFEST_CODES.COMPAT_INCOMPATIBLE), false)
})

// --------------------------------------------------------------- ⑧ 团队入口

test('⑧ 团队入口从**载荷**里读，不是从 manifest 的一个字段里读', () => {
  const pack = samplePack()
  const r = verdictOf(pack.manifest, pack.files)
  assert.equal(r.ok, true, JSON.stringify(codesOf(r)))
  assert.equal(r.computed.packType, 'team')
  assert.equal(r.computed.fileCount, pack.files.length)
})

test('⑧ ★ 内容表对不上时，预检在**读入口之前**就拒绝', () => {
  // 顺序是有意的：如果先解析入口再看哈希，一个内容被改过的包会走到
  // "入口解析失败"这条错误上，于是值班的人先去查 JSON 格式，
  // 而真正的问题是它的内容与声明不符。
  const pack = samplePack()
  const tampered = pack.files.map((f) => ({ ...f, text: `${f.text}\n` }))
  const verdict = verdictOf(pack.manifest, tampered)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, MANIFEST_CODES.CONTENTS_MISMATCH)
})

test('⑧ 团队包指向一个不存在的入口文件 → 拒绝', () => {
  const pack = samplePack()
  const files = pack.files.filter((f) => f.path !== 'team/team-plan.json')
  const entries = normalizePayload(files)
  const manifest = {
    ...pack.manifest,
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    contentHash: contentHashOfEntries(entries),
  }
  const verdict = verdictOf(manifest, files)
  assert.equal(verdict.ok, false)
  assert.ok(codesOf(verdict).includes(MANIFEST_CODES.ENTRYPOINT_MISSING), JSON.stringify(codesOf(verdict)))
})

// --------------------------------------------------------------- ⑨ 完成标准

test('⑨ ★ 完成标准前半：不兼容 / 缺依赖 / 哈希错误，三种包在预检就失败', () => {
  const pack = samplePack()
  const cases = [
    ['不兼容', { ...pack.manifest, compatibility: { ...pack.manifest.compatibility, product: '^9.0.0' } }, MANIFEST_CODES.COMPAT_INCOMPATIBLE],
    ['缺依赖', { ...pack.manifest, dependsOn: [{ packId: 'legion.absent', range: '^1.0.0' }] }, MANIFEST_CODES.DEPENDENCY_MISSING],
    ['哈希错误', { ...pack.manifest, contentHash: `sha256:${'f'.repeat(64)}` }, MANIFEST_CODES.CONTENT_HASH_MISMATCH],
  ]
  for (const [name, manifest, code] of cases) {
    const verdict = verdictOf(manifest, pack.files)
    assert.equal(verdict.ok, false, `${name} 的包通过了预检`)
    assert.ok(codesOf(verdict).includes(code), `${name} 的包没有给出 ${code}：${JSON.stringify(codesOf(verdict))}`)
  }
  assert.equal(PACK_MANIFEST_VERSION, 'legion/pack-manifest@1')
  // 阳性对照：样例包自己必须过，否则上面三条拒绝可能只是"什么都拒"
  assert.equal(verdictOf(pack.manifest, pack.files).ok, true)
})
