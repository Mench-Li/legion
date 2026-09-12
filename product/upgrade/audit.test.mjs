// ============================================================================
// PRT-811 / PRT-813 的判据：升级审计、发布说明、用户通知，与 Windows 四类边角。
//
// 这一组盯的**不是**"记录写下去了没有"，而是三件在"审计"这个词下很容易
// 被合并成一件的事：
//
//   ① **缺失字段必须看得见。** 一条 `{ result: 'ok' }` 与一条把
//      verification/backupId/migrationOutcome 全填 `null` 的记录，
//      对事后追责的人是两份完全不同的材料。
//   ② **"没有记录"不等于"上次成功了"。** 刚装好的机器与刚升级成功的机器，
//      在仪表盘上长得一样——如果实现里把"没有记录"当成成功。
//   ③ **Windows 的三件事都有一个共同的坏默认：不确定就继续。**
//      没探到子进程 → 当作都退了；重试没有上限 → 变成挂起；
//      长路径没查 → 拷到一半失败。
//
//   > 一个写着 `result: 'ok'` 的审计记录，
//   > 与一个"我们相信它当时是成功的"的记忆，是同一个东西——
//   > 只不过前者看起来是证据。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUDIT_CHECKED,
  DEFAULT_RELEASE_POLICY,
  MAX_PATH_LIMIT,
  NOTIFY_LEVELS,
  UPGRADE_AUDIT_FORMAT,
  UPGRADE_RESULTS,
  WINDOWS_CODES,
  checkLongPath,
  checkLongPaths,
  checkSubprocessTreeExited,
  createUpgradeRecord,
  formatReleaseNotes,
  isInUseError,
  isScannerDelayError,
  listUpgradeRecords,
  preSwitchWindowsCheck,
  releaseNotes,
  releaseWithRetry,
  upgradeNotification,
  upgradeResultMetric,
  writeUpgradeRecord,
} from '../../product/upgrade/audit.mjs'

const MANIFEST = Object.freeze({
  productVersion: '0.9.0', dshVersion: '0.8.3', dshCompositionPatchVersion: 2,
  schemaVersion: 12, channel: 'stable',
})

const ADDITIVE = Object.freeze({ version: 1, name: 'a', compatibility: 'additive' })
const BREAKING_SAFE = Object.freeze({ version: 2, name: 'b', compatibility: 'breaking', destructive: false })
const BREAKING_LOSSY = Object.freeze({ version: 3, name: 'c', compatibility: 'breaking', destructive: true })

// ── ① 审计记录 ──────────────────────────────────────────────────────────────

test('① ★★ 未知结果不许进审计：取值必须可枚举', () => {
  assert.throws(() => createUpgradeRecord({ result: '差不多成功吧' }), (e) => {
    assert.equal(e.code, 'upgrade-audit-bad-result')
    assert.ok(e.message.includes(UPGRADE_RESULTS[0]), e.message)
    return true
  })
  assert.throws(() => createUpgradeRecord({}), (e) => e.code === 'upgrade-audit-bad-result')
  assert.deepEqual([...UPGRADE_RESULTS],
    ['committed', 'rolled-back', 'forward-fix-required', 'aborted', 'not-started'])
})

test('① ★★ 缺失的字段**显式为 null**，不填看起来正常的默认值', () => {
  const r = createUpgradeRecord({ result: 'aborted' })
  assert.equal(r.kind, UPGRADE_AUDIT_FORMAT)
  assert.equal(r.verification, null)
  assert.equal(r.backupId, null)
  assert.equal(r.migrationOutcome, null)
  assert.equal(r.health, null)
  assert.equal(r.rollback, null)
  assert.equal(r.channel, null)
  assert.equal(r.durationMs, null)
  // 字段**存在**且是 null —— 这两件事不一样：`'backupId' in r` 为假时，
  // 后来的读者分不清"没备份"与"这条记录来自一个还没有这个字段的版本"。
  for (const key of ['verification', 'backupId', 'migrationOutcome', 'health', 'rollback', 'actor', 'trigger']) {
    assert.equal(key in r, true, `${key} 没有出现在记录里`)
    assert.equal(r[key], null)
  }
})

test('① ★ 一条完整的记录带上两档读数与时长', () => {
  const r = createUpgradeRecord({
    result: 'committed', fromVersion: '0.8.0', toVersion: '0.9.0', channel: 'canary',
    startedAtMs: 1000, finishedAtMs: 4000,
    verification: { verdict: 'verified', integrity: 'ok', signature: 'verified' },
    backupId: 'snap-1', migrationOutcome: 'applied-all',
    health: { verdict: 'healthy' }, rollback: null,
    actor: 'user@example', trigger: 'manual',
  })
  assert.equal(r.channelLabel, '金丝雀')
  assert.equal(r.durationMs, 3000)
  assert.equal(r.verification.verdict, 'verified')
  assert.equal(r.actor, 'user@example')
  // 缺少结束时刻时，时长是 null，不是 0。
  assert.equal(createUpgradeRecord({ result: 'committed', startedAtMs: 1000 }).durationMs, null)
})

test('① 写下去、读回来：坏记录**如实报出来**，不静默跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-audit-'))
  try {
    const good = createUpgradeRecord({ result: 'rolled-back', fromVersion: '0.9.0', toVersion: '0.8.0', finishedAtMs: 2000 })
    const file = writeUpgradeRecord(dir, good, { atMs: 2000 })
    assert.ok(file.endsWith('.json'))
    writeFileSync(join(dir, '9999-broken.json'), '{ 这不是 json', 'utf8')

    const back = listUpgradeRecords(dir)
    assert.equal(back.length, 2)
    const broken = back.find((r) => r.unreadable === true)
    assert.ok(broken, JSON.stringify(back))
    assert.equal(broken.result, null)
    assert.ok(broken.error.includes('JSON'), broken.error)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('① 目录不存在时读出空数组（不是抛）', () => {
  assert.deepEqual([...listUpgradeRecords(join(tmpdir(), '绝对不存在的-dir-xyz'))], [])
})

// ── ② 升级结果读数 ──────────────────────────────────────────────────────────

test('② ★★ 没有记录时是 `not-started`，不是 `committed` 也不是 `ok`', () => {
  const empty = upgradeResultMetric([])
  assert.equal(empty.result, 'not-started')
  assert.equal(empty.count, 0)
  assert.equal(empty.lastAtMs, null)
  assert.ok(empty.reason.includes('必须区分开'), empty.reason)

  // 全是坏记录（result 为 null）时也一样：读不出结果不等于成功过。
  const broken = upgradeResultMetric([{ result: null }, { result: null }])
  assert.equal(broken.result, 'not-started', '全是坏记录却被算成了"成功过"')
  assert.equal(broken.count, 0)
})

test('② ★ 读数取**最后一条**，并单独数出回滚次数', () => {
  const records = [
    createUpgradeRecord({ result: 'rolled-back', fromVersion: '0.8.0', toVersion: '0.9.0', finishedAtMs: 100 }),
    createUpgradeRecord({ result: 'committed', fromVersion: '0.8.0', toVersion: '0.9.0', finishedAtMs: 200 }),
    createUpgradeRecord({ result: 'rolled-back', fromVersion: '0.9.0', toVersion: '0.9.1', finishedAtMs: 300 }),
  ]
  const m = upgradeResultMetric(records)
  assert.equal(m.result, 'rolled-back')
  assert.equal(m.lastAtMs, 300)
  assert.equal(m.count, 3)
  assert.equal(m.rolledBackCount, 2, '回滚次数没有被单独数出来——"升级结果"这一项就只剩最后一次')
  assert.ok(m.reason.includes('0.9.0 → 0.9.1'), m.reason)
})

// ── ③ 发布说明 ──────────────────────────────────────────────────────────────

test('③ ★★ `requiresBackupRestore` 与 `mayLoseData` 是两个不同的问题', () => {
  // 加了新表新列的 contract 迁移：回滚要走恢复备份，但备份里数据一条不少。
  const safe = releaseNotes({
    manifest: MANIFEST, migrations: [ADDITIVE, BREAKING_SAFE], rollbackSafety: 'db-restore-required',
  })
  assert.equal(safe.requiresBackupRestore, true)
  assert.equal(safe.mayLoseData, false, '不丢数据的 contract 迁移被喊成了"可能丢数据"')
  assert.ok(safe.backupHint.includes('回滚二进制不够'), safe.backupHint)

  // 删掉/改写了历史数据：两条都为真。
  const lossy = releaseNotes({
    manifest: MANIFEST, migrations: [ADDITIVE, BREAKING_LOSSY], rollbackSafety: 'db-restore-required',
  })
  assert.equal(lossy.requiresBackupRestore, true)
  assert.equal(lossy.mayLoseData, true, '会丢数据的迁移没有被标出来')
  assert.deepEqual([...lossy.destructiveMigrations], ['c'])
  assert.ok(lossy.backupHint.includes('丢掉升级之后写入的数据'), lossy.backupHint)

  // additive-only：两条都为假。
  const additive = releaseNotes({ manifest: MANIFEST, migrations: [ADDITIVE], rollbackSafety: 'program-only-rollback' })
  assert.equal(additive.requiresBackupRestore, false)
  assert.equal(additive.mayLoseData, false)
  assert.ok(additive.backupHint.includes('向前兼容'), additive.backupHint)
})

test('③ ★ 没有 manifest 直接抛（发布说明不能靠猜）', () => {
  assert.throws(() => releaseNotes({}), (e) => e.code === 'release-notes-needs-manifest')
})

test('③ ★★ 渲染时"可能丢数据"必须在**最前面**', () => {
  const notes = releaseNotes({
    manifest: MANIFEST, migrations: [BREAKING_LOSSY], rollbackSafety: 'db-restore-required',
    highlights: ['新的编排器'], important: ['需要重新登录'],
  })
  const text = formatReleaseNotes(notes)
  const lines = text.split('\n')
  assert.ok(lines[0].includes('⚠'), `第一行不是警告：${lines[0]}`)
  assert.ok(lines[0].includes('不能'), lines[0])
  // 而不会丢数据的版本里没有这条警告。
  const calm = formatReleaseNotes(releaseNotes({ manifest: MANIFEST, migrations: [ADDITIVE] }))
  assert.equal(calm.split('\n')[0].includes('⚠'), false, '向前兼容的版本也打了警告')
  // 正文包含通道中文名与各版本号，且把 breaking 数出来。
  assert.ok(text.includes('稳定'), text)
  assert.ok(text.includes('新的编排器') && text.includes('需要重新登录'), text)
  assert.ok(text.includes('1 项为 contract'), text)
})

// ── ④ 通知 ──────────────────────────────────────────────────────────────────

test('④ ★★ 需要人工介入的结果不许渲染成 `info`', () => {
  const critical = upgradeNotification({
    record: createUpgradeRecord({ result: 'forward-fix-required', fromVersion: '0.8.0', toVersion: '0.9.0' }),
  })
  assert.equal(critical.level, 'critical')
  assert.equal(critical.actionRequired, true)

  // 回滚了、但数据库仍需处理 → warning + actionRequired。
  const rollbackNeedsAction = upgradeNotification({
    record: createUpgradeRecord({
      result: 'rolled-back', fromVersion: '0.8.0', toVersion: '0.9.0',
      rollback: { safety: 'db-restore-required', restoredVersion: '0.8.0', doesNotRestore: ['数据库'] },
    }),
    rollbackSafety: 'db-restore-required',
  })
  assert.equal(rollbackNeedsAction.level, 'warning', '需要人工介入的回滚被渲染成了 info')
  assert.equal(rollbackNeedsAction.actionRequired, true)
  assert.ok(rollbackNeedsAction.caveat.includes('数据库'), rollbackNeedsAction.caveat)

  // 纯程序回滚 → info，且明说业务数据未受影响。
  const clean = upgradeNotification({
    record: createUpgradeRecord({
      result: 'rolled-back', fromVersion: '0.8.0', toVersion: '0.9.0',
      rollback: { safety: 'program-only-rollback', restoredVersion: '0.8.0', doesNotRestore: [] },
    }),
  })
  assert.equal(clean.level, 'info')
  assert.equal(clean.actionRequired, false)
  assert.ok(clean.body.includes('业务数据未受影响'), clean.body)
})

test('④ ★★ 覆盖了 contract 迁移的"成功"也要带一句提醒（提交不等于可退）', () => {
  const r = upgradeNotification({
    record: createUpgradeRecord({ result: 'committed', fromVersion: '0.8.0', toVersion: '0.9.0', channel: 'stable' }),
    rollbackSafety: 'db-restore-required',
  })
  assert.equal(r.level, 'info')
  assert.ok(r.caveat, '含 contract 迁移的成功提交没有带任何提醒')
  assert.ok(r.caveat.includes('备份'), r.caveat)

  const plain = upgradeNotification({
    record: createUpgradeRecord({ result: 'committed', fromVersion: '0.8.0', toVersion: '0.9.0', channel: 'stable' }),
  })
  assert.equal(plain.caveat, null)
  assert.ok(plain.title.includes('0.9.0'), plain.title)
})

test('④ 中止与未开始各自有可读的通知，且都不是"需要处理"', () => {
  const aborted = upgradeNotification({
    record: createUpgradeRecord({ result: 'aborted', fromVersion: '0.8.0', toVersion: '0.9.0' }),
  })
  assert.equal(aborted.level, 'warning')
  assert.equal(aborted.actionRequired, false)
  assert.ok(aborted.title.includes('安全中止'), aborted.title)

  const none = upgradeNotification({ record: createUpgradeRecord({ result: 'not-started' }) })
  assert.equal(none.level, 'info')
  assert.equal(none.actionRequired, false)
  assert.ok([...NOTIFY_LEVELS].includes(none.level))
})

test('④ 没有记录直接抛', () => {
  assert.throws(() => upgradeNotification({}), (e) => e.code === 'upgrade-notify-needs-record')
})

// ── ⑤ Windows：长路径 ───────────────────────────────────────────────────────

test('⑤ ★★ 长路径判的是**完整**长度：达到 260 就拒绝', () => {
  const long = `C:\\Users\\x\\${'a'.repeat(300)}`
  const r = checkLongPath(long)
  assert.equal(r.ok, false)
  assert.equal(r.code, WINDOWS_CODES.LONG_PATH)
  assert.equal(r.length, long.length)
  assert.equal(r.limit, MAX_PATH_LIMIT)
  assert.ok(r.reason.includes('写到一半'), r.reason)

  // 刚好 259 通过、260 不通过 —— 边界写清楚，别让 260 这种差一错误躲进去。
  const at259 = `C:\\${'b'.repeat(256)}`
  assert.equal(at259.length, 259)
  assert.equal(checkLongPath(at259).ok, true)
  const at260 = `C:\\${'b'.repeat(257)}`
  assert.equal(at260.length, 260)
  assert.equal(checkLongPath(at260).ok, false, '恰好 260 字符的路径被判为可接受')

  // 启用了长路径支持就放行。
  assert.equal(checkLongPath(long, { longPathsEnabled: true }).ok, true)
})

test('⑤ ★★ 空路径不是"短路径"：它必须失败', () => {
  const r = checkLongPath('')
  assert.equal(r.ok, false)
  assert.equal(r.code, WINDOWS_CODES.LONG_PATH)
  assert.ok(r.reason.includes('空路径不是'), r.reason)
  assert.equal(checkLongPath(null).ok, false)
})

test('⑤ `checkLongPaths` 汇总：最长的一条与违规清单', () => {
  const r = checkLongPaths(['C:\\ok', `C:\\${'c'.repeat(300)}`, `C:\\${'d'.repeat(400)}`])
  assert.equal(r.ok, false)
  assert.equal(r.checked, 3)
  assert.equal(r.violations.length, 2)
  assert.equal(r.longest, 403)
  assert.ok(r.reason.includes('2 条路径'), r.reason)

  const allOk = checkLongPaths(['C:\\a', 'C:\\b'])
  assert.equal(allOk.ok, true)
  assert.deepEqual([...allOk.violations], [])
  assert.equal(allOk.reason, null)
})

// ── ⑥ Windows：占用重试必须有上限 ───────────────────────────────────────────

function busyError() {
  const e = new Error('文件被占用')
  e.code = 'EBUSY'
  return e
}

test('⑥ ★★ 重试必须有上限：一直占用时**按次数收敛**，不挂起', async () => {
  let calls = 0
  let slept = 0
  const r = await releaseWithRetry(() => { calls += 1; throw busyError() }, {
    policy: { attempts: 3, delayMs: 1, maxTotalMs: 1000 },
    sleep: async (ms) => { slept += ms },
    now: () => slept,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, WINDOWS_CODES.RELEASE_FAILED)
  assert.equal(calls, 3, `重试了 ${calls} 次，策略说 3 次`)
  assert.equal(r.attempts.length, 3)
  assert.ok(r.attempts.every((a) => a.retryable === true))
  assert.ok(r.reason.includes('安全中止'), r.reason)
})

test('⑥ ★★ 次数没用完但**总时长**到顶时也必须停（否则延迟会把它变成挂起）', async () => {
  let calls = 0
  let clock = 0
  const r = await releaseWithRetry(() => { calls += 1; throw busyError() }, {
    policy: { attempts: 100, delayMs: 400, maxTotalMs: 500 },
    sleep: async (ms) => { clock += ms },
    now: () => clock,
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, WINDOWS_CODES.RELEASE_FAILED)
  assert.ok(calls < 100, `总时长到顶后仍然重试了 ${calls} 次`)
  assert.ok(calls <= 3, `总时长 500ms / 每次 400ms，却重试了 ${calls} 次`)
})

test('⑥ ★★ 不可重试的错误**立刻**失败，不浪费重试次数', async () => {
  let calls = 0
  const notFound = new Error('文件不存在')
  notFound.code = 'ENOENT'
  const r = await releaseWithRetry(() => { calls += 1; throw notFound }, {
    policy: { attempts: 5, delayMs: 1, maxTotalMs: 1000 },
    sleep: async () => {},
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ENOENT')
  assert.equal(calls, 1, `不可重试的错误被重试了 ${calls} 次`)
  assert.equal(r.attempts[0].retryable, false)
  assert.ok(r.reason.includes('不可重试'), r.reason)
})

test('⑥ ★ 前几次失败、之后成功：整体判成功，且留下逐次痕迹', async () => {
  let calls = 0
  const r = await releaseWithRetry(() => {
    calls += 1
    if (calls < 3) throw busyError()
    return 'released'
  }, { policy: { attempts: 5, delayMs: 1, maxTotalMs: 1000 }, sleep: async () => {} })
  assert.equal(r.ok, true)
  assert.equal(r.result, 'released')
  assert.equal(r.attempts.length, 3)
  assert.deepEqual(r.attempts.map((a) => a.ok), [false, false, true])
})

test('⑥ ★★ 无限重试的策略被**拒绝**（策略本身不合法时不许开始）', async () => {
  await assert.rejects(
    () => releaseWithRetry(() => {}, { policy: { attempts: 5, delayMs: 1, maxTotalMs: Infinity } }),
    (e) => { assert.equal(e.code, 'windows-release-policy-invalid'); return true },
  )
  await assert.rejects(
    () => releaseWithRetry(() => {}, { policy: { attempts: 0, delayMs: 1, maxTotalMs: 100 } }),
    (e) => e.code === 'windows-release-policy-invalid',
  )
  // 默认策略自己是有上限的。
  assert.ok(Number.isFinite(DEFAULT_RELEASE_POLICY.attempts) && DEFAULT_RELEASE_POLICY.attempts >= 1)
  assert.ok(Number.isFinite(DEFAULT_RELEASE_POLICY.maxTotalMs) && DEFAULT_RELEASE_POLICY.maxTotalMs > 0)
})

test('⑥ 占用与扫描器延迟的判定覆盖各自的 errno', () => {
  for (const code of ['EBUSY', 'EPERM', 'ETXTBSY', 'EACCES']) {
    assert.equal(isInUseError({ code }), true, `${code} 没有被判为占用`)
  }
  assert.equal(isInUseError({ code: 'ENOENT' }), false)
  assert.equal(isInUseError(null), false)
  // 扫描器造成的延迟是**可重试**的那一部分：ETXTBSY/EACCES 是确定的失败。
  assert.equal(isScannerDelayError({ code: 'EBUSY' }), true)
  assert.equal(isScannerDelayError({ code: 'EPERM' }), true)
  assert.equal(isScannerDelayError({ code: 'ETXTBSY' }), false)
  assert.equal(isScannerDelayError({ code: 'ENOENT' }), false)
})

// ── ⑦ Windows：子进程树 ─────────────────────────────────────────────────────

test('⑦ ★★ 没有子进程读数时是 `unknown`，不是"都退了"', () => {
  const r = checkSubprocessTreeExited({ processes: null })
  assert.equal(r.ok, false, '没有探过子进程就判为可以替换程序')
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.code, WINDOWS_CODES.SUBPROCESS_TREE_ALIVE)
  assert.ok(r.reason.includes('没有探过'), r.reason)
})

test('⑦ ★★ 只要有一个活着就不许切换（只杀父进程会留下一棵子树）', () => {
  const r = checkSubprocessTreeExited({
    processes: [
      { key: 'dsh', pid: 10, alive: false },
      { key: 'orchestrator-worker', pid: 11, alive: true },
    ],
    expected: ['dsh', 'orchestrator-worker'],
  })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'alive')
  assert.equal(r.alive.length, 1)
  assert.equal(r.alive[0].key, 'orchestrator-worker')
  assert.ok(r.reason.includes('继续写数据库'), r.reason)

  const allGone = checkSubprocessTreeExited({ processes: [{ key: 'dsh', alive: false }] })
  assert.equal(allGone.ok, true)
  assert.equal(allGone.code, WINDOWS_CODES.SUBPROCESS_TREE_EXITED)
  assert.equal(allGone.verdict, 'exited')
})

test('⑦ ★ 看的是 `alive === true`：缺字段或 `alive: "no"` 都不算活着，但也不算"已确认退出"', () => {
  // 一条没有 alive 字段的读数表示"这一条没探到"，而它在 alive 列表里不出现。
  const r = checkSubprocessTreeExited({ processes: [{ key: 'dsh', pid: 1 }] })
  assert.equal(r.ok, true)
  assert.deepEqual([...r.alive], [])
  // 而 process 列表本身为 `[]`（探过、一个都没有）与 null（没探）是两回事。
  assert.equal(checkSubprocessTreeExited({ processes: [] }).ok, true)
  assert.equal(checkSubprocessTreeExited({}).ok, false)
})

// ── ⑧ Windows：切换前合成 ───────────────────────────────────────────────────

test('⑧ ★★ 三项里任何一项不通过都不许开始切换，且给出了"所以怎么办"', () => {
  const bad = preSwitchWindowsCheck({
    installRoot: `C:\\${'e'.repeat(300)}`,
    processes: [{ key: 'orchestrator', alive: true }],
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.longPath.ok, false)
  assert.equal(bad.subprocessTree.ok, false)
  assert.equal(bad.reasons.length, 2)
  assert.ok(bad.advice.includes('保留旧版本'), bad.advice)
  assert.ok(bad.advice.includes('半覆盖'), bad.advice)

  const good = preSwitchWindowsCheck({
    installRoot: 'C:\\legion', paths: ['C:\\legion\\versions\\0.9.0'], processes: [{ key: 'dsh', alive: false }],
  })
  assert.equal(good.ok, true, JSON.stringify(good.reasons))
  assert.equal(good.advice, null)
  assert.deepEqual([...good.reasons], [])
})

test('⑧ ★ 没探子进程时，合成检查也是不通过（未知不许当成通过）', () => {
  const r = preSwitchWindowsCheck({ installRoot: 'C:\\legion', processes: null })
  assert.equal(r.ok, false)
  assert.equal(r.subprocessTree.verdict, 'unknown')
  assert.equal(r.reasons.length, 1)
})

// ── ⑨ 装载期自检 ────────────────────────────────────────────────────────────

test('⑨ ★ 装载期自检留下算出来的值，四条判据都真的跑过', () => {
  assert.deepEqual([...AUDIT_CHECKED.problems], [])
  assert.equal(AUDIT_CHECKED.ok, true)
  const s = AUDIT_CHECKED.samples
  assert.equal(s.unknownResultRejected, true)
  assert.equal(s.unknownResultCode, 'upgrade-audit-bad-result')
  assert.equal(s.emptyMetricResult, 'not-started')
  assert.equal(s.longPathOk, false)
  assert.equal(s.longPathLength, 311)
  assert.equal(s.subprocessAliveOk, false)
  assert.equal(s.subprocessAliveCode, WINDOWS_CODES.SUBPROCESS_TREE_ALIVE)
  assert.equal(s.subprocessUnknownVerdict, 'unknown')
  assert.equal(AUDIT_CHECKED.format, UPGRADE_AUDIT_FORMAT)
  assert.deepEqual([...AUDIT_CHECKED.results], [...UPGRADE_RESULTS])
})
