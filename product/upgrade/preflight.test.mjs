// ============================================================================
// PRT-805 的判据：升级前兼容性、磁盘和在途任务检查。
//
// 这一组盯的**不是**"三项都跑了一遍"，而是**三档读数不许被压成两档**：
//
//   · 兼容性不过 → 永远不能升（换机器、等发布都不行）；
//   · 磁盘不够   → 清缓存或换盘就能升；
//   · 任务没收敛 → 等几分钟就能升。
//
// 而这三项各自还有一个更隐蔽的坏输入：**读不到**。把"读不到磁盘余量"
// 与"空间充足"合成一档的实现在平时完全正常，只在磁盘查询失败的那一刻
// 放行一次写到一半的升级。
//
//   > 一个在查不到磁盘余量时照常升级的体检，
//   > 与一个从来没有查过磁盘余量的体检，是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_TASK_STATES,
  DEFAULT_DISK_POLICY,
  PREFLIGHT_CHECKED,
  PREFLIGHT_CHECKS,
  PREFLIGHT_CODES,
  PREFLIGHT_VERDICT_KINDS,
  PREFLIGHT_VERDICTS,
  checkCompatibility,
  checkDiskSpace,
  checkInFlightTasks,
  classifyPreflightChecks,
  preflightVerdictAlignment,
  preflightVerdictKind,
  requiredBytes,
  runPreflight,
} from '../../product/upgrade/preflight.mjs'
import { createManifest } from '../../product/upgrade/manifest.mjs'

const CURRENT = createManifest({
  productVersion: '0.8.0', legionVersion: '0.8.0', dshVersion: '0.8.2',
  dshCompositionPatchVersion: 1, schemaVersion: 11, runtimeContractVersion: 1,
  packProtocolVersion: 1, channel: 'stable',
})

function target(overrides = {}) {
  return createManifest({
    productVersion: '0.9.0', legionVersion: '0.9.0', dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2, schemaVersion: 12, runtimeContractVersion: 1,
    packProtocolVersion: 1, channel: 'stable',
    ...overrides,
  })
}

// ── ① 兼容性 ────────────────────────────────────────────────────────────────

test('① N-1 允许；N-2 与降级各归各的码', () => {
  const n1 = checkCompatibility({ current: CURRENT, target: target(), patchPair: 'match' })
  assert.equal(n1.verdict, 'ok', JSON.stringify(n1.reasons))

  const n2 = checkCompatibility({
    current: createManifest({ ...CURRENT, productVersion: '1.2.0' }),
    target: target({ productVersion: '2.0.0' }),
    patchPair: 'match',
  })
  assert.equal(n2.verdict, 'blocked')
  assert.equal(n2.code, 'manifest-upgrade-not-allowed')

  const down = checkCompatibility({ current: target(), target: CURRENT, patchPair: 'match' })
  assert.equal(down.verdict, 'blocked')
  assert.equal(down.code, 'manifest-downgrade', '降级没有自己的码——它与"窗口外"的处置不同')
})

test('① ★★ 补丁层与 DSH 不成对必须拦住（这条比 DSH API 变化更隐蔽）', () => {
  const r = checkCompatibility({ current: CURRENT, target: target(), patchPair: 'mismatch' })
  assert.equal(r.verdict, 'blocked', '补丁层不成对却被放行')
  assert.ok(r.reasons.some((x) => x.includes('preflight-patch-pair-mismatch')), JSON.stringify(r.reasons))
})

test('① ★★ 没有成对结论时是 `unknown`，不是 `ok`', () => {
  const r = checkCompatibility({ current: CURRENT, target: target(), patchPair: null })
  assert.equal(r.verdict, 'unknown', '没有成对关系结论时被判为可以升级')
  assert.notEqual(r.verdict, 'ok')
})

test('① 通道不同、平台不同、schema 降级、DSH 太旧：四条各有各的读法', () => {
  const channel = checkCompatibility({
    current: CURRENT, target: target({ channel: 'canary' }), patchPair: 'match',
  })
  assert.equal(channel.verdict, 'blocked')
  assert.equal(channel.code, PREFLIGHT_CODES.CHANNEL_MISMATCH)

  const platform = checkCompatibility({
    current: CURRENT, target: Object.freeze({ ...target(), platform: 'linux' }),
    platform: 'win32', patchPair: 'match',
  })
  assert.equal(platform.verdict, 'blocked')
  assert.equal(platform.code, PREFLIGHT_CODES.PLATFORM_MISMATCH)

  const schema = checkCompatibility({
    current: CURRENT, target: target({ schemaVersion: 10 }), patchPair: 'match',
  })
  assert.equal(schema.verdict, 'blocked')
  assert.equal(schema.code, PREFLIGHT_CODES.SCHEMA_DOWNGRADE)
  assert.ok(schema.reasons[0].includes('经过验证的数据库恢复'), schema.reasons[0])

  const old = checkCompatibility({
    current: CURRENT, target: target(), patchPair: 'match', minDshVersionMajor: 1,
  })
  assert.equal(old.verdict, 'blocked')
  assert.equal(old.code, PREFLIGHT_CODES.DSH_TOO_OLD)
})

test('① 目标清单本身不合法时，报的是"基线不可信"而不是"不兼容"', () => {
  const r = checkCompatibility({ current: CURRENT, target: target({ productVersion: '^1.0.0' }), patchPair: 'match' })
  assert.equal(r.verdict, 'blocked')
  assert.equal(r.code, PREFLIGHT_CODES.MANIFEST_INVALID)
})

// ── ② 磁盘 ──────────────────────────────────────────────────────────────────

test('② ★★ 读不到磁盘余量必须是 `unknown`，绝不能是 `ok`', () => {
  const r = checkDiskSpace({ freeBytes: null, packageBytes: 100 * 1024 * 1024 })
  assert.equal(r.verdict, 'unknown', '没有磁盘读数时被判为空间充足')
  assert.equal(r.code, PREFLIGHT_CODES.DISK_UNOBSERVED)

  const noSize = checkDiskSpace({ freeBytes: 10 ** 12, packageBytes: null })
  assert.equal(noSize.verdict, 'unknown')
})

test('② ★★ 余量按**最坏情况**算：旧版本 + 新版本 + 备份 + 解压临时同时存在', () => {
  const pkgBytes = 100 * 1024 * 1024
  const need = requiredBytes({ packageBytes: pkgBytes, backupBytes: 50 * 1024 * 1024, dataDirBytes: 20 * 1024 * 1024 })
  assert.equal(need.installDir, pkgBytes * DEFAULT_DISK_POLICY.installFactor)
  assert.ok(need.total > pkgBytes * 3, `${need.total} 不大于包的三倍`)
  assert.equal(need.breakdown.installFactor, 3)

  // 只够放"新包"的空间必须被判为不足——这正是"只按包大小算"的实现会放过的那一格。
  const exactlyPackage = checkDiskSpace({
    freeBytes: pkgBytes * 1.2, packageBytes: pkgBytes, backupBytes: 0, dataDirBytes: 0,
  })
  assert.equal(exactlyPackage.verdict, 'blocked', '刚够放新包的磁盘被判为空间充足')
  assert.equal(exactlyPackage.code, PREFLIGHT_CODES.DISK_INSUFFICIENT)
  assert.ok(exactlyPackage.reasons[0].includes('写到一半'), exactlyPackage.reasons[0])

  const plenty = checkDiskSpace({ freeBytes: need.total + 1, packageBytes: pkgBytes, backupBytes: 50 * 1024 * 1024, dataDirBytes: 20 * 1024 * 1024 })
  assert.equal(plenty.verdict, 'ok')
  assert.equal(plenty.marginBytes, 1)
})

// ── ③ 在途任务 ──────────────────────────────────────────────────────────────

test('③ ★★ 查不到任务读数必须是 `unknown`：查不到 ≠ 没有在途任务', () => {
  const r = checkInFlightTasks({ tasks: null })
  assert.equal(r.verdict, 'unknown', '查不到任务状态时被判为已经没有在途任务')
  assert.equal(r.code, PREFLIGHT_CODES.TASKS_UNOBSERVED)
})

test('③ 活跃任务让体检变红；收敛之后变绿；两种读数是分开的', () => {
  const running = checkInFlightTasks({
    tasks: [{ id: 'a', state: 'running' }, { id: 'b', state: 'completed' }],
  })
  assert.equal(running.verdict, 'blocked')
  assert.equal(running.activeCount, 1)
  assert.deepEqual([...running.activeIds], ['a'])

  const drained = checkInFlightTasks({
    tasks: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'dead-letter' }],
  })
  assert.equal(drained.verdict, 'ok')
  assert.equal(drained.activeCount, 0)
  assert.deepEqual([...ACTIVE_TASK_STATES].includes('running'), true)
})

test('③ ★★ 认不出的状态按**活跃**处理（把它当完成会让升级踩着它开始）', () => {
  const r = checkInFlightTasks({ tasks: [{ id: 'x', state: 'some-new-state' }] })
  assert.equal(r.verdict, 'blocked', '认不出的任务状态被判为"已经收敛"')
  assert.equal(r.unrecognizedCount, 1)
  assert.ok(r.reasons.some((x) => x.includes('some-new-state')), JSON.stringify(r.reasons))

  // 而一个明确在活跃集合里的状态**不算**"认不出"。
  const known = checkInFlightTasks({ tasks: [{ id: 'x', state: 'awaiting-approval' }] })
  assert.equal(known.unrecognizedCount, 0)
  assert.equal(known.activeCount, 1)
})

test('③ 给了 lease 到期时刻时，能算出还要等多久（把"等一下"与"要人工介入"分开）', () => {
  const r = checkInFlightTasks({
    tasks: [{ id: 'a', state: 'running' }],
    nowMs: 1000,
    oldestLeaseExpiryMs: 61000,
  })
  assert.equal(r.verdict, 'blocked')
  assert.equal(r.waitMs, 60000)

  const noClock = checkInFlightTasks({ tasks: [{ id: 'a', state: 'running' }] })
  assert.equal(noClock.waitMs, null, '没有时钟读数时算出了一个等待时间')
})

// ── 合成 ────────────────────────────────────────────────────────────────────

test('④ ★★ 合成裁决把三档读数与**各自的处置**一起给出（不许压成一个布尔）', () => {
  const blocked = runPreflight({
    current: CURRENT, target: target(), patchPair: 'match',
    freeBytes: 1024, packageBytes: 100 * 1024 * 1024,
    tasks: [{ id: 'a', state: 'running' }],
  })
  assert.equal(blocked.ok, false)
  assert.deepEqual([...blocked.blocked].sort(), ['disk', 'in-flight-tasks'])
  assert.equal(blocked.checks.length, 3)
  assert.ok(blocked.remedies.disk.includes('清理缓存'), blocked.remedies.disk)
  assert.ok(blocked.remedies['in-flight-tasks'].includes('等待'), blocked.remedies['in-flight-tasks'])
  assert.notEqual(blocked.remedies.disk, blocked.remedies['in-flight-tasks'])

  const ok = runPreflight({
    current: CURRENT, target: target(), patchPair: 'match',
    freeBytes: 10 ** 12, packageBytes: 100 * 1024 * 1024,
    tasks: [],
  })
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons))
  assert.equal(ok.remedies.disk, null, '磁盘通过时还给了处置建议')
})

test('④ ★★ `pre-download` 阶段容忍磁盘无读数，`pre-switch` 不容忍', () => {
  // 下载之前还没有包，磁盘量不出来是正常的。但"任务状态读不到"任何阶段都不容忍。
  const preDownload = runPreflight({
    current: CURRENT, target: target(), patchPair: 'match',
    stage: 'pre-download', freeBytes: null, packageBytes: null, tasks: [],
  })
  assert.equal(preDownload.ok, true, JSON.stringify(preDownload.reasons))
  assert.deepEqual([...preDownload.toleratedUnknown], ['disk'])
  assert.deepEqual([...preDownload.unknown].includes('disk'), true)

  const preSwitch = runPreflight({
    current: CURRENT, target: target(), patchPair: 'match',
    stage: 'pre-switch', freeBytes: null, packageBytes: 100, tasks: [],
  })
  assert.equal(preSwitch.ok, false, 'pre-switch 阶段容忍了磁盘无读数')

  const noTasks = runPreflight({
    current: CURRENT, target: target(), patchPair: 'match',
    stage: 'pre-download', freeBytes: null, packageBytes: null, tasks: null,
  })
  assert.equal(noTasks.ok, false, 'pre-download 阶段容忍了任务读数缺失——查不到在途任务永远不可容忍')
})

test('④ 未知 stage 直接抛（省得有人以为传错了名字也没关系）', () => {
  assert.throws(() => runPreflight({ current: CURRENT, target: target(), stage: '随便' }), (e) => {
    assert.equal(e.code, 'preflight-stage-unknown')
    return true
  })
  assert.deepEqual([...PREFLIGHT_CHECKS], ['compatibility', 'disk', 'in-flight-tasks'])
})

// ── ⑤ 装载期自检 ────────────────────────────────────────────────────────────

test('⑤ ★★ 装载期自检留下算出来的值：磁盘未知、成对未验证、认不出的状态**都被驱动到拦截**', () => {
  assert.deepEqual([...PREFLIGHT_CHECKED.problems], [])
  assert.equal(PREFLIGHT_CHECKED.ok, true)
  const s = PREFLIGHT_CHECKED.samples
  assert.equal(s.okAtPreDownload, true)
  // 磁盘：同一份输入在 pre-download 通过、在 pre-switch 被拦。
  assert.equal(s.diskNoReadingAtPreDownload, true)
  assert.equal(s.diskNoReadingVerdict, 'unknown')
  assert.equal(s.diskNoReadingAtPreSwitch, false)
  assert.deepEqual([...s.toleratesOnlyDisk], ['disk'])
  // 成对关系：`unverified` 这条**字符串**也必须被拦，不能从"mismatch 才拦"的缝里过去。
  assert.equal(s.unverifiedPairOk, false)
  assert.equal(s.badWindowOk, false)
  assert.equal(s.badTaskOk, false)
  assert.equal(s.convergedTaskOk, true)
  assert.equal(s.stageGuard, true)
})

test('⑤ ★★ 补丁层成对关系只认 `match`：`unverified` 与任何认不出的值都不算过', () => {
  const base = { current: CURRENT, target: target(), stage: 'pre-switch', freeBytes: 10 ** 9, packageBytes: 10 ** 6, tasks: [] }
  for (const pair of [null, 'unverified', '没听说过', undefined]) {
    const r = runPreflight({ ...base, patchPair: pair })
    assert.equal(r.ok, false, `patchPair=${JSON.stringify(pair)} 被判为可以升级`)
    assert.equal(r.checks.find((c) => c.check === 'compatibility').verdict, 'unknown')
  }
  assert.equal(runPreflight({ ...base, patchPair: 'match' }).ok, true)
  assert.equal(runPreflight({ ...base, patchPair: 'mismatch' }).ok, false)
})

// ---------------------------------------------------------------------------
// 裁决词表接线（第 43 轮）
//
// ★★★ 补的是**汇总里那处手写复述**：
//
//     export const PREFLIGHT_VERDICTS = Object.freeze(['ok', 'blocked', 'unknown'])
//     const blockedChecks = checks.filter((c) => c.verdict === 'blocked')   ← 手写
//     const unknownChecks = checks.filter((c) => c.verdict === 'unknown')   ← 手写
//
//   往词表里加第四个裁决 ⇒ 它**既不进 blocked、也不进 unknown**
//   ⇒ `ok` 仍然是 `true`。（实测 `scratch/_probe-preflight-verdict.mjs`：
//   裁决 `degraded`、`ok = true`、`blocked = []`、`unknown = []`、`reasons = []`，
//   而**同一份返回值**里 `remedies.disk` 还在给处置建议。）
//
//   > 一条"不是 ok、也不是 blocked"的裁决，与一条 ok 的裁决，
//   > 在"这次升级该不该放行"这个读数上是同一个东西：都说可以走。
// ---------------------------------------------------------------------------

test('接线① ★★★ 归类表**覆盖每一个**声明的裁决（没有"没归类"这一档）', () => {
  for (const v of PREFLIGHT_VERDICTS) {
    assert.equal(typeof PREFLIGHT_VERDICT_KINDS[v], 'string',
      `裁决「${v}」没有归类——它会被汇总静默当成"没问题"`)
  }
  // 反向控制：归类表里不许有词表里没有的裁决（那是一条永远走不到的归类）
  for (const v of Object.keys(PREFLIGHT_VERDICT_KINDS)) {
    assert.ok(PREFLIGHT_VERDICTS.includes(v), `归类了却没声明：「${v}」`)
  }
})

test('接线② ★★★ 未声明的裁决 ⇒ **当场抛**，不静默放行', () => {
  assert.throws(() => preflightVerdictKind('half-broken'), /未声明的裁决/)
  assert.throws(() => preflightVerdictKind(undefined), /未声明的裁决/)
  // 反向控制：声明过的都要能归类，且恰好一个归到 clear
  for (const v of PREFLIGHT_VERDICTS) assert.ok(preflightVerdictKind(v).length > 0)
  assert.equal(PREFLIGHT_VERDICTS.filter((v) => PREFLIGHT_VERDICT_KINDS[v] === 'clear').length, 1,
    '"通行"的裁决必须恰好一个——多于一个等于放宽了放行条件')
})

test('接线③ ★★★ 对齐检查**可注入**：造一个"加了裁决却没归类"的形状，必须被指名', () => {
  // ★ 为什么必须注入：那条守卫只在模块加载时跑一次，而**加载时一切正常**。
  //   想验证它拦不拦得住，唯一的办法是拿坏输入去试——否则只能靠改源码，
  //   而改源码的人正是它要防的那个人。（第 42 轮 M5/M6 就是因此漏网的。）
  const base = { verdicts: PREFLIGHT_VERDICTS, kinds: PREFLIGHT_VERDICT_KINDS }
  assert.equal(preflightVerdictAlignment(base).ok, true, '真仓当下就不对齐')

  const a1 = preflightVerdictAlignment({ ...base, verdicts: [...PREFLIGHT_VERDICTS, 'degraded'] })
  assert.equal(a1.ok, false)
  assert.deepEqual(a1.unclassified, ['degraded'], '新裁决没归类却没被指名')

  const a2 = preflightVerdictAlignment({ ...base, kinds: { ...PREFLIGHT_VERDICT_KINDS, ghost: 'unknown' } })
  assert.equal(a2.ok, false)
  assert.deepEqual(a2.orphan, ['ghost'])

  // ★ 两个裁决同时归到 clear ⇒ 放行条件被放宽
  const a3 = preflightVerdictAlignment({ ...base, kinds: { ...PREFLIGHT_VERDICT_KINDS, blocked: 'clear' } })
  assert.equal(a3.ok, false)
  assert.equal(a3.clear.length, 2)
})

test('接线⑤ ★★★ 分桶**跟随归类表**——注入第四个裁决，它必须被处置（不许算 ok）', () => {
  // ★★★ 这一条是分开"跟随归类表"与"恰好认 blocked/unknown 两个词"的**唯一**办法。
  //   二者在今天（词表正好是 ok/blocked/unknown）行为**完全相同**；
  //   破验 A1（把汇总改回手写两行）最初就是**漏网**的，查下来正是这个原因。
  //   ⇒ 把归类表做成可注入的，用例才能拿**第四个**裁决去试。
  const mk = (verdict) => [{ check: 'disk', verdict, code: null, reasons: [] }]

  // ① 归类成 blocking ⇒ 必须进 blocked
  const kinds1 = { ok: 'clear', blocked: 'blocking', unknown: 'unknown', degraded: 'blocking' }
  const r1 = classifyPreflightChecks(mk('degraded'), { kinds: kinds1 })
  assert.deepEqual(r1.blockedChecks.map((c) => c.check), ['disk'],
    '新的非通行裁决归类成 blocking，却没被分进 blocked ⇒ 它会从放行条件里漏过去')

  // ② 归类成 unknown ⇒ 必须进 unknown
  const kinds2 = { ok: 'clear', blocked: 'blocking', unknown: 'unknown', degraded: 'unknown' }
  const r2 = classifyPreflightChecks(mk('degraded'), { kinds: kinds2 })
  assert.deepEqual(r2.unknownChecks.map((c) => c.check), ['disk'])

  // ③ 归类成**第三类**（既不是 clear、也不是 blocking/unknown）⇒ 必须抛，不许当成没问题
  const kinds3 = { ok: 'clear', blocked: 'blocking', unknown: 'unknown', degraded: 'degraded-kind' }
  assert.throws(() => classifyPreflightChecks(mk('degraded'), { kinds: kinds3 }), /没有任何处置/,
    '一个没有处置的归类被静默放过去了——那就是"可以升级"的缝')

  // ④ 未声明的裁决 ⇒ 抛（不是返回 undefined）
  assert.throws(() => classifyPreflightChecks(mk('half-broken')), /未声明的裁决/)

  // ⑤ 反向控制：通行裁决不许进任何桶
  const r5 = classifyPreflightChecks(mk('ok'))
  assert.deepEqual([r5.blockedChecks.length, r5.unknownChecks.length], [0, 0], 'ok 被分进了桶里')
})
test('接线④ ★★★ 每一项裁决都被**真的**算进汇总（三档不许压成两档）', () => {
  // ★ 反证：把磁盘那一项的裁决换成 `unknown`（另一个**声明过的**裁决），
  //   它必须出现在 `unknown` 里，且 pre-switch 阶段 `ok=false`。
  //   如果实现是手写 `=== 'blocked'` / `=== 'unknown'` 的两行，这里仍然能过；
  //   所以真正咬住"跟随声明"的是接线③的注入用例与接线②的抛。
  const base = { current: CURRENT, target: target(), stage: 'pre-switch', freeBytes: 10, packageBytes: 10 ** 9, tasks: [] }
  const r = runPreflight({ ...base, patchPair: 'match' })
  assert.equal(r.ok, false)
  const disk = r.checks.find((c) => c.check === 'disk')
  assert.equal(disk.verdict, 'blocked')
  assert.ok(r.blocked.includes('disk'), '磁盘被拦了，却没出现在 blocked 里')
  assert.equal(r.reasons.length > 0, true, '被拦了却没有理由')
  // 每一项都要么 ok、要么在 blocked/unknown 里——不许有"哪儿都不在"的裁决
  for (const c of r.checks) {
    const kind = PREFLIGHT_VERDICT_KINDS[c.verdict]
    assert.ok(kind !== undefined, `${c.check} 的裁决「${c.verdict}」没有归类`)
    if (kind === 'clear') continue
    const listed = r.blocked.includes(c.check) || r.unknown.includes(c.check)
    assert.equal(listed, true,
      `${c.check} 的裁决是「${c.verdict}」（归类 ${kind}），却既不在 blocked 也不在 unknown 里——这就是"可以升级"的缝`)
  }
})
