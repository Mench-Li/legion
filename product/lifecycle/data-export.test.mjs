// product/lifecycle/data-export.test.mjs
// ============================================================================
// PRT-905：数据导出入口。spec §10 line 988。
//
// 这一组盯的**不是**"有没有导出功能"，而是**导出的东西用户能不能用**。
//
// 备份 / 恢复 / 导出是**三个不同的目标**：
//   · 备份要能原样恢复（字节保真、只有本产品打得开）；
//   · 导出要能**被别人读**（稳定 schema、通用格式、自描述）。
//
//   > 一个「把数据库文件复制一份」的导出，
//   > 与一个「用户拿到一个打不开的 .db」的导出，是同一个东西——
//   > 只不过前者在"导出成功"这个返回值上是完全正确的。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DATA_EXPORT_CHECKED,
  EXPORT_CLASS_POLICY,
  EXPORT_CODES,
  EXPORT_FORMAT,
  EXPORT_HANDLINGS,
  NON_PORTABLE_FORMATS,
  PORTABLE_FORMATS,
  assertExportReadable,
  buildExportManifest,
  planExport,
} from './data-export.mjs'
import { DATA_CLASS_IDS } from './data-classes.mjs'

const mk = (patch = {}) => ({
  classId: 'database', path: 'data/team.db', format: 'json', bytes: 10, hash: 'h1', ...patch,
})

// ---------------------------------------------------------------- 自检

test('① ★★ 装载期自检：五条核心判据都真的跑过（留下的是值不是布尔）', () => {
  assert.equal(DATA_EXPORT_CHECKED.ok, true, JSON.stringify(DATA_EXPORT_CHECKED.problems))
  const s = DATA_EXPORT_CHECKED.samples
  // ① 密钥库被排除，且一条条目都没进
  assert.equal(s.secretExcluded, true)
  assert.ok(s.secretFinding.includes(EXPORT_CODES.SECRET_IN_EXPORT))
  // ② 不可移植格式被拒
  assert.ok(s.unportableFinding.includes(EXPORT_CODES.FORMAT_UNPORTABLE))
  // ③ 写模式打开被拒
  assert.ok(s.destructiveFinding.includes(EXPORT_CODES.DESTRUCTIVE))
  // ④ 工作区默认不导出但被报出来
  assert.ok(s.workspaceOmittedFinding.includes(EXPORT_CODES.WORKSPACE_OMITTED))
  // ⑤ 清单往返：自己造的清单接收方读得懂
  assert.equal(s.roundTripReadable, true)
  // 反向控制：去掉 schemaVersion 就读不懂了
  assert.equal(s.noSchemaReadable, false)
})

test('① ★ 版本号是常量字符串', () => {
  assert.match(EXPORT_FORMAT, /^legion\/data-export@\d+$/)
})

// ---------------------------------------------------------------- ★★ 密钥

test('② ★★ 密钥库**永远**不进导出包（这是"不可能勾"，不是"默认不勾"）', () => {
  const r = planExport({ stores: [mk({ classId: 'secret', path: 'data/.secrets/credentials.yaml' })] })
  assert.equal(r.entries.length, 0, '密钥进了导出条目')
  assert.ok(r.excluded.some((e) => e.classId === 'secret' && e.handling === 'never'))
  const f = r.findings.find((x) => x.code === EXPORT_CODES.SECRET_IN_EXPORT)
  assert.ok(f, '必须报出来，而不是静默排除')
  // 理由要说得出为什么
  assert.match(f.detail, /支持人员|复制|上传/)
})

test('② ★★ 显式要求导出密钥也不行（没有"我还是想导出"这条缝）', () => {
  const r = planExport({
    stores: [mk({ classId: 'secret', path: 'a' })],
    include: { secret: true },
  })
  assert.equal(r.entries.length, 0, 'include.secret 竟然能导出密钥')
  assert.ok(r.findings.some((x) => x.code === EXPORT_CODES.SECRET_IN_EXPORT))
})

test('② ★★ 台账里密钥类的处置必须是 `never`', () => {
  assert.equal(EXPORT_CLASS_POLICY.secret.handling, 'never')
})

test('② ★★ 内容里扫到的密钥值也算（凭据可能抄在别的地方）', () => {
  // 密钥库被排除了，但同一个 token 可能被抄进一份普通配置文件里。
  const r = planExport({ stores: [mk()], scannedSecrets: [{ path: 'data/product.config.json', key: 'apiKey' }] })
  assert.ok(r.findings.some((x) => x.code === EXPORT_CODES.SECRET_VALUE_FOUND))
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------- ★★ 格式

test('③ ★★ 不可移植格式被拒：**那是备份，不是导出**', () => {
  for (const fmt of NON_PORTABLE_FORMATS) {
    const r = planExport({ stores: [mk({ format: fmt })] })
    const f = r.findings.find((x) => x.code === EXPORT_CODES.FORMAT_UNPORTABLE)
    assert.ok(f, `${fmt} 没有被拒`)
    assert.match(f.detail, /只有本产品打得开/)
    assert.equal(r.entries.length, 0)
  }
})

test('③ ★★ 可移植格式全部放行', () => {
  for (const fmt of PORTABLE_FORMATS) {
    const r = planExport({ stores: [mk({ format: fmt })] })
    assert.equal(r.entries.length, 1, `${fmt} 被误拒`)
    assert.equal(r.ok, true, JSON.stringify(r.findings.map((f) => f.code)))
  }
})

test('③ ★★ 两个格式集合**不相交**（否则"可移植"这条判据自相矛盾）', () => {
  assert.deepEqual(PORTABLE_FORMATS.filter((f) => NON_PORTABLE_FORMATS.includes(f)), [])
})

test('③ ★★ 缺格式时用该类台账的默认格式（不能留 null）', () => {
  // `portable` 类都声明了默认格式；没给 format 的落点要用它，而不是留空。
  const r = planExport({ stores: [{ classId: 'database', path: 'p', hash: 'h' }] })
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].format, EXPORT_CLASS_POLICY.database.format)
  assert.ok(PORTABLE_FORMATS.includes(r.entries[0].format))
})

// ---------------------------------------------------------------- ★★ 只读

test('④ ★★ 导出**不得改动源**：写模式打开的落点被拒', () => {
  const r = planExport({ stores: [mk({ openedForWrite: true })] })
  const f = r.findings.find((x) => x.code === EXPORT_CODES.DESTRUCTIVE)
  assert.ok(f, '以写模式打开的落点没有被拒')
  // 理由要指出"为了导出一致快照而 checkpoint"这条动机
  assert.match(f.detail, /checkpoint|写锁|写操作/)
  assert.equal(r.entries.length, 0, '改动源的落点不能被导出')
})

test('④ ★★ 只读打开的落点正常导出', () => {
  const r = planExport({ stores: [mk({ openedForWrite: false })] })
  assert.equal(r.entries.length, 1)
  assert.equal(r.ok, true)
})

// ---------------------------------------------------------------- ★★ 漏报

test('⑤ ★★ 工作区默认不导出，**但必须报出来**（静默漏掉 ≠ 故意排除）', () => {
  const r = planExport({ stores: [mk({ classId: 'workspace', path: 'data/ws' })] })
  assert.equal(r.entries.length, 0)
  assert.ok(r.omitted.some((o) => o.classId === 'workspace' && o.reason === 'not-confirmed'))
  assert.ok(r.findings.some((f) => f.code === EXPORT_CODES.WORKSPACE_OMITTED))
})

test('⑤ ★★ 显式确认后工作区正常导出', () => {
  const r = planExport({ stores: [mk({ classId: 'workspace', path: 'data/ws' })], include: { workspace: true } })
  assert.equal(r.entries.length, 1)
  assert.equal(r.ok, true, JSON.stringify(r.findings.map((f) => f.code)))
})

test('⑤ ★★ `exclude` 类进 `excluded` 且**不**报 finding（那是刻意的，不是漏报）', () => {
  // program / cache 是**故意**排除的——报 finding 会把"设计决定"变成噪音。
  for (const classId of ['program', 'cache']) {
    const r = planExport({ stores: [mk({ classId, path: 'p' })] })
    assert.equal(r.entries.length, 0)
    assert.ok(r.excluded.some((e) => e.classId === classId && e.handling === 'exclude'))
    assert.equal(r.findings.length, 0, `${classId} 是刻意排除的，不该报 finding`)
    assert.equal(r.ok, true)
  }
})

test('⑤ ★★ 一个落点都没有 → `EMPTY_EXPORT`（空导出与"没什么好导的"必须分开）', () => {
  const r = planExport({ stores: [] })
  assert.ok(r.findings.some((f) => f.code === EXPORT_CODES.EMPTY_EXPORT))
  assert.equal(r.ok, false)
})

test('⑤ ★★ 认不出类别的落点进 `omitted` 并报码（既不敢导也不敢丢下）', () => {
  const r = planExport({ stores: [mk({ classId: '谁知道呢', path: 'x' })] })
  assert.ok(r.findings.some((f) => f.code === EXPORT_CODES.CLASS_UNKNOWN))
  assert.ok(r.omitted.some((o) => o.reason === 'class-unknown'))
  assert.equal(r.entries.length, 0)
})

test('⑤ ★★ 没有哈希的条目被报出来（无法证明它没被改过）', () => {
  const r = planExport({ stores: [mk({ hash: null })] })
  assert.ok(r.findings.some((f) => f.code === EXPORT_CODES.ENTRY_UNHASHED))
})

// ---------------------------------------------------------------- ★★ 清单

test('⑥ ★★ 清单**自描述**：往返一遍，接收方读得懂', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1.0.0', schemaVersion: 'ledger@1', nowMs: 1 })
  assert.equal(m.ok, true, JSON.stringify(m.findings.map((f) => f.code)))
  const r = assertExportReadable(m)
  assert.equal(r.readable, true, JSON.stringify(r.problems))
  assert.equal(r.portableCount, 1)
})

test('⑥ ★★ 缺 `schemaVersion` → 接收方读不了（没有 schema 版本等于把解析问题推给他）', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1.0.0', schemaVersion: '' })
  assert.ok(m.findings.some((f) => f.code === EXPORT_CODES.MANIFEST_INCOMPLETE))
  const r = assertExportReadable(m)
  assert.equal(r.readable, false)
  assert.match(r.problems.join('\n'), /schema 版本/)
})

test('⑥ ★★ 缺 `productVersion` → 接收方读不了', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '', schemaVersion: 's' })
  assert.equal(assertExportReadable(m).readable, false)
})

test('⑥ ★★ 条目数与实际不符 → 包被改过或截断了', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1', schemaVersion: 's' })
  const tampered = { ...m, entryCount: 5 }
  const r = assertExportReadable(tampered)
  assert.equal(r.readable, false)
  assert.match(r.problems.join('\n'), /截断|改过/)
})

test('⑥ ★★ 清单里混进密钥条目 → 接收方报出来', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1', schemaVersion: 's' })
  const withSecret = { ...m, entries: [...m.entries, { classId: 'secret', path: 'a', handling: 'portable', format: 'json', hash: 'h' }], entryCount: 2 }
  const r = assertExportReadable(withSecret)
  assert.equal(r.readable, false)
  assert.match(r.problems.join('\n'), /密钥库/)
})

test('⑥ ★★ 清单里混进不可移植条目 → 接收方报出来', () => {
  const plan = planExport({ stores: [mk()] })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1', schemaVersion: 's' })
  const bad = { ...m, entries: [...m.entries, { classId: 'database', path: 'b', handling: 'portable', format: 'sqlite', hash: 'h' }], entryCount: 2 }
  const r = assertExportReadable(bad)
  assert.equal(r.readable, false)
  assert.match(r.problems.join('\n'), /不可移植/)
})

test('⑥ ★★ 清单逐类计数，接收方一眼看得出有哪几类', () => {
  const plan = planExport({
    stores: [mk(), mk({ classId: 'log', path: 'data/a.log', format: 'text' }), mk({ classId: 'log', path: 'data/b.log', format: 'text' })],
  })
  const m = buildExportManifest({ entries: plan.entries, productVersion: '1', schemaVersion: 's' })
  assert.equal(m.classes.database, 1)
  assert.equal(m.classes.log, 2)
  assert.equal(m.classes.secret, 0)
  const r = assertExportReadable(m)
  assert.deepEqual([...r.classesPresent].sort(), ['database', 'log'])
})

test('⑥ ★ `reference-only`（产物）只给清单与哈希，不复制字节', () => {
  const plan = planExport({ stores: [mk({ classId: 'artifact', path: 'data/out.zip', bytes: 10 ** 9, format: undefined })] })
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].handling, 'reference-only')
  assert.equal(plan.entries[0].format, null)
  const r = assertExportReadable(buildExportManifest({ entries: plan.entries, productVersion: '1', schemaVersion: 's' }))
  assert.equal(r.referenceOnlyCount, 1)
  assert.equal(r.portableCount, 0)
})

// ---------------------------------------------------------------- 台账一致

test('⑦ ★★ 导出/卸载两张表必须覆盖**同一批类**（漏一个类会无声少给一块数据）', () => {
  const covered = Object.keys(EXPORT_CLASS_POLICY)
  assert.deepEqual([...covered].sort(), [...DATA_CLASS_IDS].sort())
})

test('⑦ ★★ 每一类的处置都合法、有理由、且 portable 类真的声明了可移植格式', () => {
  for (const [id, p] of Object.entries(EXPORT_CLASS_POLICY)) {
    assert.ok(EXPORT_HANDLINGS.includes(p.handling), `${id} 的处置不合法`)
    assert.ok(p.why.length > 0, `${id} 没有说明理由`)
    if (p.handling === 'portable') {
      assert.ok(PORTABLE_FORMATS.includes(p.format), `${id} 声明 portable 但格式 ${p.format} 不可移植`)
    }
  }
})

test('⑦ ★★ 装载期自检里的处置读数与台账一致', () => {
  const s = DATA_EXPORT_CHECKED.samples
  assert.equal(s.policyHandlings.secret, 'never')
  assert.equal(s.policyHandlings.program, 'exclude')
  assert.equal(s.policyHandlings.cache, 'exclude')
  assert.equal(s.policyHandlings.workspace, 'confirm')
  assert.equal(s.policyHandlings.artifact, 'reference-only')
})

// ---------------------------------------------------------------- 边界

test('⑧ ★★ `counts.bytes` 只算**会被真的写出去**的字节（不含 reference-only）', () => {
  // 一个把不复制的东西也算进体积的读数，会让用户以为这次导出要吃 10 GB 磁盘，
  // 而实际只写了几百字节的清单：
  //
  //   > 一个「把不复制的东西也算进体积」的读数，
  //   > 与一个「告诉用户这次导出有 10 GB」的读数，是同一个东西——
  //   > 只不过前者在加法上是完全正确的。
  //
  // 这条用例第一次跑时**红了**：实现当时把两类加在一起（1000000100）。
  // 那是它抓出来的真缺陷，不是用例写错。
  const plan = planExport({ stores: [mk({ bytes: 100 }), mk({ classId: 'artifact', path: 'big', bytes: 10 ** 9 })] })
  assert.equal(plan.counts.bytes, 100, '不复制的东西被算进了导出体积')
  assert.equal(plan.counts.referencedBytes, 10 ** 9, '被引用但不复制的字节要单独报出来')
  assert.equal(plan.counts.entries, 2)
})

test('⑧ ★ 返回对象被冻结', () => {
  const r = planExport({ stores: [mk()] })
  assert.ok(Object.isFrozen(r))
  assert.ok(Object.isFrozen(r.entries))
  assert.ok(Object.isFrozen(r.findings))
  assert.throws(() => { 'use strict'; r.ok = false }, TypeError)
})

test('⑧ ★ 缺省参数不抛（导出坏在一个 undefined 上是最坏的结果）', () => {
  const r = planExport()
  assert.equal(r.entries.length, 0)
  assert.equal(r.ok, false)
  const m = buildExportManifest()
  assert.equal(m.entryCount, 0)
  assert.equal(assertExportReadable().readable, false)
})
