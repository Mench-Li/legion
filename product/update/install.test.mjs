// product/update/install.test.mjs
// ============================================================================
// 安装事务的失败点驱动 —— 设计 §8 的失败表逐行
//
// 与 `product/upgrade/upgrade.test.mjs` 同一条理由：**每一个失败点都必须
// 能被真的驱动到**。真实世界里没法按需制造"服务拒绝退出"或"备份验证失败"，
// 所以外部效果全部注入，而用例逐个把它们打断。
//
// 判据不是"有没有报错"，而是"系统落在哪个已知状态"——也就是
// `verdict` / `reachedStep` / 维护屏障有没有被正确处置。
// ============================================================================

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  INSTALL_VERDICTS, finalVerdict, helperDataSafety, newTransactionId, readHelperReport, runInstallTransaction,
  writeHelperReport,
} from './install.mjs'
import { createJournal, planRecovery, readActive, readJournal } from './journal.mjs'
import { acquireBarrier, canAcceptWrites, readBarrier, releaseBarrier, startupGate } from './barrier.mjs'
import { consumeCredential, isOutsideSwitchTarget, issueCredential, verifyProgramDigest } from './credential.mjs'
import { runHelper, validateInvocation } from './helper.mjs'
import { createHash } from 'node:crypto'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const CURRENT_VERSION = '1.0.0'
const NEXT_VERSION = '1.1.0'

function currentManifest(version = CURRENT_VERSION) {
  return Object.freeze({
    format: 'legion/version-manifest@1',
    productVersion: version,
    legionVersion: version,
    dshVersion: '0.8.2',
    dshCompositionPatchVersion: 2,
    channel: 'stable',
  })
}

function releaseFixture({ packagePath, sha256 }) {
  return Object.freeze({
    format: 'legion/update-release@1',
    releaseId: `rel-${NEXT_VERSION}`,
    productVersion: NEXT_VERSION,
    channel: 'stable',
    platform: 'win32',
    arch: 'x64',
    productManifest: currentManifest(NEXT_VERSION),
    supportedFromVersions: Object.freeze([CURRENT_VERSION]),
    minWindowsBuild: 19045,
    requiredFreeBytes: 1024,
    package: Object.freeze({ path: `releases/rel-${NEXT_VERSION}/legion-win-x64.zip`, sizeBytes: 16, sha256 }),
    installer: Object.freeze({ path: `releases/rel-${NEXT_VERSION}/Legion-Setup-win-x64.exe`, sizeBytes: 8, sha256: 'b'.repeat(64) }),
    notes: Object.freeze({ path: `releases/rel-${NEXT_VERSION}/notes.zh-CN.txt`, sizeBytes: 8, sha256: 'c'.repeat(64) }),
    migrationPlanDigest: 'd'.repeat(64),
    rollbackPolicy: 'program-only',
    issuedAt: '2026-10-03T00:00:00Z',
    expiresAt: '2026-10-10T00:00:00Z',
  })
}

/** 每个用例一套干净的 DataDir / InstallDir / CacheDir。 */
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-install-test-'))
  const installDir = join(root, 'install')
  const dataDir = join(root, 'data')
  const backupDir = join(root, 'backups')
  const cacheDir = join(root, 'cache')
  for (const dir of [installDir, dataDir, backupDir, cacheDir]) mkdirSync(dir, { recursive: true })
  const packagePath = join(cacheDir, 'legion-win-x64.zip')
  const packageBytes = Buffer.from('PK\u0003\u0004 pretend zip')
  writeFileSync(packagePath, packageBytes)
  const sha256 = createHash('sha256').update(packageBytes).digest('hex')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root, installDir, dataDir, backupDir, cacheDir, packagePath, sha256,
    paths: { installDir, dataDir, backupDir, cacheDir, configPath: join(dataDir, 'config.json') },
  }
}

/**
 * 一次成功的执行所需的全部替身。
 *
 * `snapshotFactory` 必须返回 `ok: true` + 一个快照 —— 因为"备份失败立即停止"
 * 是另一条判据，默认路径必须是成功的。
 */
function effects(overrides = {}) {
  const calls = []
  return {
    calls,
    stopClaiming: async () => { calls.push('stopClaiming') },
    drainInFlight: async () => { calls.push('drainInFlight'); return { ok: true, detail: 'no tasks' } },
    stopServices: async () => { calls.push('stopServices') },
    verifyExit: async () => { calls.push('verifyExit'); return { ok: true } },
    spawnHelper: async (args) => { calls.push(['spawnHelper', args]); return { ok: true, pid: 4242 } },
    snapshotFactory: ({ backupDir, nowMs, label }) => {
      calls.push('snapshot')
      const snapshot = { id: `snap-${nowMs}`, createdAtMs: nowMs, root: join(backupDir, `snap-${nowMs}`), label }
      mkdirSync(snapshot.root, { recursive: true })
      return { ok: true, snapshot, reason: null }
    },
    ...overrides,
  }
}

function baseArgs(ctx, fx, overrides = {}) {
  return {
    paths: ctx.paths,
    current: currentManifest(),
    release: releaseFixture({ packagePath: ctx.packagePath, sha256: ctx.sha256 }),
    identity: Object.freeze({
      releaseId: `rel-${NEXT_VERSION}`, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    }),
    packagePath: ctx.packagePath,
    freeBytes: 10 * 1024 * 1024 * 1024,
    backupBytes: 1024,
    dataDirBytes: 1024,
    // ★ 预检要的是**读数**，不是"没给就当我没看见"：
    //   `tasks: []` 表示"我查过了，没有在途任务"；`patchBindings` 表示
    //   "这个 DSH × 补丁组合我验证过成对"。缺任何一个预检都会拦（那是设计
    //   要求的行为），所以正常路径的用例必须真的给出来——而且必须给**对的**
    //   那一对：目标清单的 dshVersion 是 0.8.2，不是 0.8.3。
    tasks: [],
    patchBindings: [{ dshVersion: '0.8.2', compositionPatchVersion: 2 }],
    now: () => NOW,
    ...fx,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ① 正常路径
// ---------------------------------------------------------------------------

test('正常路径：九步走完并交接 helper，屏障保持立着', async (t) => {
  const ctx = setup(t)
  const fx = effects()
  const result = await runInstallTransaction(baseArgs(ctx, fx))

  assert.equal(result.verdict, 'handed-off', result.reason)
  assert.equal(result.ok, true)
  assert.equal(result.reachedStep, 'handoff')
  // 顺序：屏障在停服务**之前**。
  assert.deepEqual(fx.calls.filter((c) => typeof c === 'string'),
    ['snapshot', 'stopClaiming', 'drainInFlight', 'stopServices', 'verifyExit'])
  // ★ 交接之后屏障**必须还立着**：写入仍被挡住，直到 helper 验证通过。
  const barrier = readBarrier(ctx.dataDir)
  assert.equal(barrier.blocked, true, '交接之后屏障被提前解除了')
  assert.equal(canAcceptWrites(ctx.dataDir).ok, false)
  // 日志里每一步都有 intent/result 一对。
  const journal = readJournal(ctx.dataDir)
  const intents = journal.records.filter((r) => r.kind === 'intent').map((r) => r.action)
  const results = journal.records.filter((r) => r.kind === 'result').map((r) => r.action)
  for (const action of ['lock', 'recheck', 'barrier-acquire', 'backup', 'stop-claiming', 'drain-in-flight', 'stop-services', 'helper-handoff']) {
    assert.ok(intents.includes(action), `缺少 ${action} 的意图记录`)
    assert.ok(results.includes(action), `缺少 ${action} 的结果记录`)
  }
})

test('事务 ID 唯一，且写进活动描述符与凭证', async (t) => {
  const ctx = setup(t)
  const fx = effects()
  const result = await runInstallTransaction(baseArgs(ctx, fx, { txnId: 'ut-fixed-1' }))
  assert.equal(result.txnId, 'ut-fixed-1')
  assert.equal(readActive(ctx.dataDir).active.txnId, 'ut-fixed-1')
  const spawnArgs = fx.calls.find((c) => Array.isArray(c) && c[0] === 'spawnHelper')[1]
  assert.equal(spawnArgs.txnId, 'ut-fixed-1')
  // 凭证里的事务号必须一致，否则 helper 会拒。
  const credential = JSON.parse(readFileSync(join(ctx.dataDir, 'update', 'transaction-credential.json'), 'utf8'))
  assert.equal(credential.txnId, 'ut-fixed-1')
  assert.equal(credential.packageSha256, ctx.sha256)
})

// ---------------------------------------------------------------------------
// ② 失败表第一行：下载/校验/预检/备份/任务等待 → 不动活动指针
// ---------------------------------------------------------------------------

test('包摘要不符：在动任何东西之前停止', async (t) => {
  const ctx = setup(t)
  const fx = effects()
  // 让清单声明的摘要与磁盘上的不一致。
  const release = releaseFixture({ packagePath: ctx.packagePath, sha256: 'a'.repeat(64) })
  const result = await runInstallTransaction(baseArgs(ctx, fx, { release }))
  assert.equal(result.verdict, 'not-started')
  assert.equal(result.code, 'install-recheck-failed')
  assert.equal(result.reachedStep, 'recheck')
  // 没有立屏障、没有备份、没有停服务。
  assert.equal(readBarrier(ctx.dataDir).blocked, false, '停止之后屏障还立着')
  assert.deepEqual(fx.calls, [])
})

test('备份失败：立即停止并**释放**屏障（此刻真的什么都没改）', async (t) => {
  const ctx = setup(t)
  const fx = effects({ snapshotFactory: () => ({ ok: false, snapshot: null, reason: '数据库快照被拒绝/不完整' }) })
  const result = await runInstallTransaction(baseArgs(ctx, fx))
  assert.equal(result.verdict, 'not-started')
  assert.equal(result.code, 'install-backup-failed')
  assert.equal(result.reachedStep, 'backup')
  assert.equal(readBarrier(ctx.dataDir).blocked, false, '备份失败之后仍被锁在维护状态里')
  assert.equal(fx.calls.includes('stopClaiming'), false, '备份失败之后仍然停了认领')
})

test('等待在途任务超时：停在维护状态，且不默认强杀', async (t) => {
  const ctx = setup(t)
  const fx = effects({ drainInFlight: async () => ({ ok: false, reason: '超时（5 分钟）' }) })
  const result = await runInstallTransaction(baseArgs(ctx, fx, { pendingTasks: [{ id: 't1' }] }))
  assert.equal(result.verdict, 'maintenance-required')
  assert.equal(result.code, 'install-drain-timeout')
  assert.equal(result.reachedStep, 'drain-in-flight')
  assert.match(result.reason, /可稍后重试或先取消任务/)
  // ★ 屏障必须**还立着**：此刻认领已停、备份已做，直接放行会让用户回到
  //   一个"看起来正常但少了几个服务"的 Legion。
  assert.equal(readBarrier(ctx.dataDir).blocked, true)
  assert.equal(fx.calls.includes('stopServices'), false, '超时之后仍然停了服务')
})

test('停止服务失败：保留旧版本并恢复维护状态', async (t) => {
  const ctx = setup(t)
  const fx = effects({ stopServices: async () => { throw Object.assign(new Error('team-hub 拒绝退出'), { code: 'STOP_TIMEOUT' }) } })
  const result = await runInstallTransaction(baseArgs(ctx, fx))
  assert.equal(result.verdict, 'maintenance-required')
  assert.equal(result.code, 'install-services-refused')
  assert.match(result.reason, /team-hub 拒绝退出/)
  assert.equal(readBarrier(ctx.dataDir).blocked, true)
  // 活动指针没有被碰过。
  assert.equal(existsSync(join(ctx.installDir, 'active-version.json')), false)
})

test('★ 句柄未释放：安全中止，不交接 helper', async (t) => {
  const ctx = setup(t)
  const fx = effects({ verifyExit: async () => ({ ok: false, detail: '进程 1234 仍然持有程序目录的句柄' }) })
  const result = await runInstallTransaction(baseArgs(ctx, fx))
  assert.equal(result.verdict, 'maintenance-required')
  assert.equal(result.code, 'install-handle-held')
  assert.equal(result.reachedStep, 'verify-exit')
  assert.match(result.reason, /已保留旧版本/)
  // ★ 绝不继续交接：helper 会去替换一个仍被占用的目录，在 Windows 上
  //   会以"部分文件已替换"结束。
  assert.equal(fx.calls.some((c) => Array.isArray(c) && c[0] === 'spawnHelper'), false, '句柄未释放时仍然交接了 helper')
})

test('启动 helper 失败：停在维护状态，旧版本完好', async (t) => {
  const ctx = setup(t)
  const fx = effects({ spawnHelper: async () => ({ ok: false, reason: 'helper 程序摘要核对失败' }) })
  const result = await runInstallTransaction(baseArgs(ctx, fx))
  assert.equal(result.verdict, 'maintenance-required')
  assert.equal(result.code, 'install-handoff-failed')
  assert.match(result.reason, /旧版本仍然完好/)
})

test('预检不过：在动任何东西之前停止', async (t) => {
  const ctx = setup(t)
  const fx = effects()
  const result = await runInstallTransaction(baseArgs(ctx, fx, { freeBytes: 1 }))
  assert.equal(result.verdict, 'not-started')
  assert.equal(result.code, 'install-recheck-failed')
  assert.equal(readBarrier(ctx.dataDir).blocked, false)
})

test('已有未完成事务：拒绝并发启动第二次升级', async (t) => {
  const ctx = setup(t)
  const fx = effects()
  acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-other', now: () => NOW })
  const result = await runInstallTransaction(baseArgs(ctx, fx))
  assert.equal(result.verdict, 'not-started')
  assert.equal(result.code, 'install-busy')
  assert.equal(fx.calls.length, 0)
})

test('输入不完整：抛明确的 bad-input，而不是静默成功', async (t) => {
  const ctx = setup(t)
  await assert.rejects(
    () => runInstallTransaction({ paths: ctx.paths }),
    (error) => error.code === 'install-bad-input',
  )
  await assert.rejects(
    () => runInstallTransaction({ paths: { installDir: ctx.installDir, dataDir: ctx.dataDir }, release: releaseFixture({ packagePath: ctx.packagePath, sha256: ctx.sha256 }), packagePath: join(ctx.cacheDir, 'missing.zip') }),
    (error) => error.code === 'install-bad-input',
  )
})

// ---------------------------------------------------------------------------
// ③ 维护屏障
// ---------------------------------------------------------------------------

test('屏障：读不出来时按"维护中"处理（代价不对称）', async (t) => {
  const ctx = setup(t)
  mkdirSync(join(ctx.dataDir, 'update'), { recursive: true })
  writeFileSync(join(ctx.dataDir, 'update', 'maintenance.json'), '{ half written', 'utf8')
  const state = readBarrier(ctx.dataDir)
  assert.equal(state.blocked, true, '损坏的屏障被当成了"没有屏障"')
  assert.equal(state.code, 'barrier-unreadable')
  const gate = startupGate({ dataDir: ctx.dataDir })
  assert.equal(gate.allowed, false)
})

test('屏障：不能被另一个事务抢占，也不能被非持有者解除', async (t) => {
  const ctx = setup(t)
  const first = acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-a', now: () => NOW })
  assert.equal(first.ok, true)
  const second = acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-b', now: () => NOW })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'barrier-foreign-txn')
  const wrongRelease = releaseBarrier(ctx.dataDir, 'ut-b')
  assert.equal(wrongRelease.ok, false)
  assert.equal(readBarrier(ctx.dataDir).blocked, true, '非持有者解除了屏障')
  assert.equal(releaseBarrier(ctx.dataDir, 'ut-a').ok, true)
  assert.equal(readBarrier(ctx.dataDir).blocked, false)
})

test('屏障：启动闸门在没有事务时放行，有事务时拦住并给建议', async (t) => {
  const ctx = setup(t)
  assert.equal(startupGate({ dataDir: ctx.dataDir }).allowed, true)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-gate', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'barrier' })
  acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-gate', now: () => NOW })
  const gate = startupGate({ dataDir: ctx.dataDir, planRecovery: (args) => planRecovery(args) })
  assert.equal(gate.allowed, false)
  assert.equal(gate.code, 'UPDATE_TRANSACTION_UNFINISHED')
  // 建议必须可行动：告诉用户该等、该重试，还是该找管理员。
  assert.match(gate.advice, /管理员|重试|维护|退回|备份/)
})

// ---------------------------------------------------------------------------
// ④ 恢复判定（设计 §8 line 182）
// ---------------------------------------------------------------------------

test('恢复判定：没有日志 → 什么都不用做', (t) => {
  const ctx = setup(t)
  const plan = planRecovery({ dataDir: ctx.dataDir })
  assert.equal(plan.verdict, 'nothing-to-do')
  assert.equal(plan.barrierRequired, false)
})

test('★ 恢复判定：停在切换之前 → 程序未被动过，可在维护模式下重试', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-1', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'stop-claiming' })
  journal.intent('backup'); journal.result('backup')
  const plan = planRecovery({
    dataDir: ctx.dataDir,
    readActivePointer: () => ({ ok: true, version: CURRENT_VERSION, previousVersion: null }),
  })
  assert.equal(plan.verdict, 'resume-maintenance')
  assert.equal(plan.barrierRequired, true)
})

test('★ 恢复判定：停在切换之后、迁移之前 → 可回退程序', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-2', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'switch' })
  journal.intent('switch-pointer'); journal.result('switch-pointer', { version: NEXT_VERSION })
  const plan = planRecovery({
    dataDir: ctx.dataDir,
    readActivePointer: () => ({ ok: true, version: NEXT_VERSION, previousVersion: CURRENT_VERSION }),
  })
  assert.equal(plan.verdict, 'rollback-program')
  assert.match(plan.reason, /程序已换、数据库未改/)
})

test('★ 恢复判定：迁移之后中断 → 必须向前修复', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-3', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'migrate' })
  journal.intent('switch-pointer'); journal.result('switch-pointer')
  journal.intent('migrate'); journal.result('migrate', { outcome: 'applied' })
  const plan = planRecovery({
    dataDir: ctx.dataDir,
    readActivePointer: () => ({ ok: true, version: NEXT_VERSION, previousVersion: CURRENT_VERSION }),
  })
  assert.equal(plan.verdict, 'forward-fix-required')
  assert.match(plan.reason, /不能仅回退程序/)
})

test('★ 恢复判定：日志与指针矛盾 → 必须人工（不猜）', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-4', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'stop-claiming' })
  const plan = planRecovery({
    dataDir: ctx.dataDir,
    // 日志说还没切换，但指针已经是新版本 —— 证据矛盾。
    readActivePointer: () => ({ ok: true, version: NEXT_VERSION, previousVersion: CURRENT_VERSION }),
  })
  assert.equal(plan.verdict, 'recovery-required')
  assert.match(plan.reason, /证据矛盾/)
})

test('★ 恢复判定：日志中间有坏行 → 必须人工（不跳过继续）', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-5', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'stop-claiming' })
  // 在中间插一行坏内容。
  const file = join(ctx.dataDir, 'update', 'journal.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.splice(1, 0, '{ not json at all')
  writeFileSync(file, lines.join('\n'), 'utf8')
  const plan = planRecovery({ dataDir: ctx.dataDir })
  assert.equal(plan.verdict, 'recovery-required')
  assert.equal(plan.code, 'journal-bad-line')
})

test('恢复判定：终态但描述符还在 → 只需收尾（安全）', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-6', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'committed' })
  journal.advance('committed')
  const plan = planRecovery({ dataDir: ctx.dataDir })
  assert.equal(plan.verdict, 'finalize-record')
  assert.equal(plan.barrierRequired, false)
})

test('日志：最后一行被截断（断电）被识别为未完成，而不是整份读不出来', (t) => {
  const ctx = setup(t)
  const journal = createJournal({ dataDir: ctx.dataDir, txnId: 'ut-7', now: () => NOW })
  journal.begin({ fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION, phase: 'backup' })
  journal.intent('backup', { backupDir: 'x' })
  const file = join(ctx.dataDir, 'update', 'journal.jsonl')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"format":"legion/update-jou`, 'utf8')
  const read = readJournal(ctx.dataDir)
  assert.equal(read.truncatedTail, true, '半截的尾行没有被识别')
  assert.equal(read.badLines.length, 0)
  // 前面完整的记录仍然读得出来 —— 这正是"意图写了、结果没写"的证据。
  assert.ok(read.records.some((r) => r.kind === 'intent' && r.action === 'backup'))
})

// ---------------------------------------------------------------------------
// ⑤ 一次性凭证
// ---------------------------------------------------------------------------

test('凭证：绑定事务号与包摘要，改一个字段就失效', async (t) => {
  const ctx = setup(t)
  const issued = issueCredential({
    dataDir: ctx.dataDir, txnId: 'ut-c1', toVersion: NEXT_VERSION, fromVersion: CURRENT_VERSION,
    releaseId: 'rel-1.1.0', packageSha256: ctx.sha256, now: () => NOW,
  })
  assert.equal(issued.ok, true, issued.reason)

  const good = consumeCredential({
    dataDir: ctx.dataDir, secretHex: issued.secretHex, now: () => NOW,
    expect: { txnId: 'ut-c1', packageSha256: ctx.sha256 }, consume: false,
  })
  assert.equal(good.ok, true, good.reason)

  const wrongTarget = consumeCredential({
    dataDir: ctx.dataDir, secretHex: issued.secretHex, now: () => NOW,
    expect: { txnId: 'ut-other' }, consume: false,
  })
  assert.equal(wrongTarget.ok, false)
  assert.equal(wrongTarget.code, 'credential-target-mismatch')

  // 改动事务文件（换掉目标版本）之后 MAC 必须对不上。
  const file = join(ctx.dataDir, 'update', 'transaction-credential.json')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  record.toVersion = '9.9.9'
  writeFileSync(file, JSON.stringify(record), 'utf8')
  const tampered = consumeCredential({ dataDir: ctx.dataDir, secretHex: issued.secretHex, now: () => NOW, consume: false })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.code, 'credential-bad-mac')
})

test('凭证：过期即失效，且消费一次之后就没了', async (t) => {
  const ctx = setup(t)
  const issued = issueCredential({
    dataDir: ctx.dataDir, txnId: 'ut-c2', toVersion: NEXT_VERSION, packageSha256: ctx.sha256,
    ttlMs: 1000, now: () => NOW,
  })
  const expired = consumeCredential({ dataDir: ctx.dataDir, secretHex: issued.secretHex, now: () => NOW + 2000 })
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'credential-expired')

  const again = issueCredential({
    dataDir: ctx.dataDir, txnId: 'ut-c3', toVersion: NEXT_VERSION, packageSha256: ctx.sha256, now: () => NOW,
  })
  assert.equal(consumeCredential({ dataDir: ctx.dataDir, secretHex: again.secretHex, now: () => NOW }).ok, true)
  // 消费之后文件被删除 → 第二次调用找不到凭证（不可重放）。
  const replay = consumeCredential({ dataDir: ctx.dataDir, secretHex: again.secretHex, now: () => NOW })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'credential-missing')
})

test('凭证：签发需要合法的包摘要', (t) => {
  const ctx = setup(t)
  const bad = issueCredential({ dataDir: ctx.dataDir, txnId: 'ut-c4', toVersion: NEXT_VERSION, packageSha256: 'nope' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'credential-bad-input')
})

test('程序摘要与目录边界判据', (t) => {
  const ctx = setup(t)
  const helperFile = join(ctx.root, 'helper.mjs')
  writeFileSync(helperFile, '// helper', 'utf8')
  const digest = createHash('sha256').update('// helper').digest('hex')
  assert.equal(verifyProgramDigest({ files: { helper: helperFile }, expected: { helper: digest } }).ok, true)
  const mismatch = verifyProgramDigest({ files: { helper: helperFile }, expected: { helper: 'a'.repeat(64) } })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.problems.join(' '), /程序摘要不符/)
  const missing = verifyProgramDigest({ files: { helper: join(ctx.root, 'nope.mjs') }, expected: {} })
  assert.equal(missing.ok, false)

  assert.equal(isOutsideSwitchTarget(join(ctx.root, 'helper'), ctx.installDir), true)
  assert.equal(isOutsideSwitchTarget(join(ctx.installDir, 'helper'), ctx.installDir), false)
})

// ---------------------------------------------------------------------------
// ⑥ helper（第 7–9 步）
// ---------------------------------------------------------------------------

/** 一个把 helper 的第 7–9 步全部做成"成功"的替身。 */
function helperEffects(overrides = {}) {
  const calls = []
  return {
    calls,
    unpack: async () => { calls.push('unpack'); return { ok: true } },
    listInstalledVersionsImpl: () => [CURRENT_VERSION, NEXT_VERSION],
    activateVersionImpl: (installDir, version) => { calls.push(['activate', version]); return { ok: true, version } },
    // 迁移存储由 helper 在**进程内**构造（活的数据库句柄跨不过 JSON 事务文件）。
    createMigrationStore: () => ({ rows: [], record: async () => {}, list: () => [] }),
    runMigrationsImpl: async () => ({ outcome: 'no-migrations', code: 'migration-nothing-to-do', applied: [], skipped: [], reason: '没有迁移' }),
    probeHealthImpl: async () => { calls.push('health'); return { verdict: 'healthy', reason: '就绪' } },
    rollbackUpgradeImpl: () => { calls.push('rollback'); return { ok: true, verdict: 'rolled-back', reason: '已退回旧版本' } },
    now: () => NOW,
    ...overrides,
  }
}

function helperSetup(t, transactionOverrides = {}) {
  const ctx = setup(t)
  acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-h1', now: () => NOW })
  const transaction = {
    txnId: 'ut-h1',
    fromVersion: CURRENT_VERSION,
    toVersion: NEXT_VERSION,
    releaseId: `rel-${NEXT_VERSION}`,
    packagePath: ctx.packagePath,
    packageSha256: ctx.sha256,
    backupDir: ctx.backupDir,
    healthProbe: async () => ({ ok: true }),
    ...transactionOverrides,
  }
  const issued = issueCredential({
    dataDir: ctx.dataDir, txnId: transaction.txnId, toVersion: NEXT_VERSION,
    fromVersion: CURRENT_VERSION, releaseId: transaction.releaseId,
    packageSha256: transaction.packageSha256, now: () => NOW,
  })
  return { ctx, transaction, secretHex: issued.secretHex, helperDir: join(ctx.root, 'helper') }
}

test('helper 正常路径：切换 → 迁移 → 健康 → 提交，然后解除屏障', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects()
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction, credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'committed', report.reason)
  assert.equal(report.code, 'helper-committed')
  // ★ 屏障在提交**之后**才解除，且提交记录先写。
  assert.equal(readBarrier(ctx.dataDir).blocked, false, '提交之后屏障没有解除')
  assert.equal(readActive(ctx.dataDir).ok, false, '事务描述符没有清掉')
  const journal = readJournal(ctx.dataDir)
  const actions = journal.records.map((r) => `${r.kind}:${r.action}`)
  assert.ok(actions.indexOf('result:commit') < actions.indexOf('result:barrier-release'), '提交之前就解除了屏障')
  // 报告落盘：下一次启动能读出结论。
  const read = readHelperReport(ctx.dataDir)
  assert.equal(read.verdict, 'committed')
})

test('★ helper：目录关系不成立 → 拒绝执行（恢复代码自己会被替换）', async (t) => {
  const { ctx, transaction, secretHex } = helperSetup(t)
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir: join(ctx.installDir, 'helper') },
    transaction, credentialSecretHex: secretHex, effects: helperEffects(),
  })
  assert.equal(report.verdict, 'recovery-required')
  assert.equal(report.code, 'helper-not-outside-install-root')
  // 屏障必须还立着：现场保持维护状态。
  assert.equal(readBarrier(ctx.dataDir).blocked, true)
})

test('★ helper：凭证不通过 → 拒绝切换，屏障保持', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction: { ...transaction, toVersion: '9.9.9' },
    credentialSecretHex: secretHex, effects: helperEffects(),
  })
  assert.equal(report.verdict, 'recovery-required')
  assert.equal(report.code, 'helper-credential-rejected')
  assert.equal(readBarrier(ctx.dataDir).blocked, true)
})

test('★ helper：屏障不在 → 拒绝（无法保证备份期间没有写入）', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  releaseBarrier(ctx.dataDir, 'ut-h1')
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction, credentialSecretHex: secretHex, effects: helperEffects(),
  })
  assert.equal(report.verdict, 'recovery-required')
  assert.equal(report.code, 'helper-no-barrier')
})

test('★ helper：解压失败 → 回退（活动指针未被改动）并解除屏障', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects({ unpack: async () => ({ ok: false, reason: '包内路径越界' }) })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction, credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'rolled-back')
  assert.equal(report.code, 'helper-unpack-failed')
  assert.match(report.reason, /活动指针未被改动/)
  assert.equal(fx.calls.includes('activate'), false, '解压失败之后仍然切换了指针')
  assert.equal(readBarrier(ctx.dataDir).blocked, false)
})

test('★ helper：目标版本目录不完整 → 回退，不切换指针', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects({ listInstalledVersionsImpl: () => [CURRENT_VERSION] })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction, credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'rolled-back')
  assert.equal(report.code, 'helper-unpack-incomplete')
  assert.equal(fx.calls.some((c) => Array.isArray(c) && c[0] === 'activate'), false)
})

test('★ helper：健康检查失败 → 自动回退程序（设计 §8 第三行）', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects({ probeHealthImpl: async () => ({ verdict: 'unhealthy', reason: '运行时补丁自检失败' }) })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction, credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'rolled-back')
  assert.equal(report.code, 'helper-health-failed')
  assert.ok(fx.calls.includes('rollback'), '健康失败之后没有回退')
  assert.equal(readBarrier(ctx.dataDir).blocked, false)
})

test('★ helper：迁移失败且不能仅回退 → 保持维护模式，最后一条屏障不放', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects({
    runMigrationsImpl: async () => ({
      outcome: 'failed', code: 'migration-failed', applied: [{ version: 1, compatibility: 'breaking' }],
      failed: { version: 2, partialWrites: null }, reason: '第二份迁移写了一半',
    }),
    rollbackUpgradeImpl: () => ({ ok: false, verdict: 'forward-fix-required', reason: '含 contract 迁移，旧版本读不懂当前结构' }),
  })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction: { ...transaction, migrations: [{ version: 1, name: 'a', compatibility: 'additive' }, { version: 2, name: 'b', compatibility: 'breaking' }] },
    credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'recovery-required')
  assert.equal(report.code, 'helper-recovery-required')
  assert.match(report.reason, /不能仅回退程序/)
  // ★ 屏障必须**保持**：这是设计 §8 失败表最后一行。
  assert.equal(readBarrier(ctx.dataDir).blocked, true, '不能自动恢复时把屏障放掉了')
})

test('★ helper：有迁移要跑但拿不到迁移存储 → **不能**报"没有迁移"', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  // ★ 一次真实的缺陷：早先的 helper 读的是 `transaction.migrationStore`，
  //   而一个活的数据库句柄**跨不过 JSON 事务文件**——于是这条分支在真实
  //   部署里永远进不去，helper 会安静地报 `no-migrations`、跑完健康检查、
  //   然后提交一次"数据库没有迁移"的升级。那是一次**成功的假象**。
  const fx = helperEffects({ createMigrationStore: null })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction: {
      ...transaction,
      migrations: [{ version: 1, name: 'add-table', compatibility: 'additive' }],
    },
    credentialSecretHex: secretHex, effects: fx,
  })
  assert.notEqual(report.migrationOutcome?.outcome, 'no-migrations',
    '拿不到迁移存储时把"不知道跑没跑"当成了"没有迁移"')
  // 拿不到存储时迁移**一份都没跑**（applied 为空），所以"仅回退程序"是安全的：
  // 程序退回旧版本，屏障解除。要点不是落点，而是它**没有**被当成"没有迁移"
  // 而一路提交上去。
  assert.equal(report.verdict, 'rolled-back')
  assert.equal(report.migrationOutcome.applied.length, 0)
  assert.equal(readBarrier(ctx.dataDir).blocked, false, '回退成功之后屏障应当解除')
})

test('★ helper：**没有**健康探针 → 不提交（"没验证"与"验证失败"同一结论）', async (t) => {
  // 设计 §8 第 8–9 步：保持维护模式 → 跑迁移、补丁自检、服务健康验证 →
  // **验证成功之后**才刷盘提交。一次"没有任何健康证据"的升级如果被提交，
  // 就是设计 §10 那句「不能把未知状态显示成升级成功」的另一个写法。
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects()
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    // 事务文件里**没有** healthProbe。
    transaction: { ...transaction, healthProbe: undefined },
    credentialSecretHex: secretHex, effects: fx,
  })
  assert.notEqual(report.verdict, 'committed', '没有健康证据却提交了升级')
  assert.equal(report.code, 'helper-health-unverified')
  assert.ok(fx.calls.includes('rollback'), '没有健康证据时没有回退')
  assert.equal(readBarrier(ctx.dataDir).blocked, false, '回退成功之后屏障应当解除')
})

test('★ helper：显式声明 allowUnverifiedHealth 之后才允许无探针提交', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects()
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction: { ...transaction, healthProbe: undefined, allowUnverifiedHealth: true },
    credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'committed', report.reason)
  assert.equal(report.health.verdict, 'unsupported')
})

test('★ helper：没有探针且回退被拒 → 保持维护模式', async (t) => {
  const { ctx, transaction, secretHex, helperDir } = helperSetup(t)
  const fx = helperEffects({ rollbackUpgradeImpl: () => ({ ok: false, verdict: 'forward-fix-required', reason: '含 contract 迁移' }) })
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir },
    transaction: { ...transaction, healthProbe: undefined, migrations: [{ version: 1, name: 'x', compatibility: 'breaking' }] },
    credentialSecretHex: secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'recovery-required')
  assert.equal(readBarrier(ctx.dataDir).blocked, true, '不能自动恢复时把屏障放掉了')
})

test('★ helper：默认解压实现真的解包，且**解压后**再核一次闭包', async (t) => {
  // 这一条不替换 `unpack`：它走 `extract.mjs` 的真实实现，验证的是
  // "第 7 步的解压接上了"这件事——一个永远注入替身的测试不会发现
  // `defaultUnpack` 根本没被接进去。
  const ctx = setup(t)
  const { createHash } = await import('node:crypto')
  const { writeFileSync } = await import('node:fs')
  const { makeZipFixture } = await import('./fixtures/zip.mjs')

  const manifest = Buffer.from('{"manifestFormat":"legion/version-manifest@1","productVersion":"1.1.0"}\n', 'utf8')
  const launcher = Buffer.from('#!/usr/bin/env node\nconsole.log("launcher")\n', 'utf8')
  const zip = makeZipFixture([
    { name: 'product/release/runtime-manifest.json', bytes: manifest },
    { name: 'product/launcher/cli.mjs', bytes: launcher },
  ])
  const packagePath = join(ctx.root, 'package.zip')
  writeFileSync(packagePath, zip)
  const packageSha256 = createHash('sha256').update(zip).digest('hex')

  // 版本目录布局：`switchover.mjs` 的 `installLayout`。
  const versionsDir = join(ctx.installDir, 'versions')
  mkdirSync(versionsDir, { recursive: true })

  acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-h2', now: () => NOW })
  const issued = issueCredential({
    dataDir: ctx.dataDir, txnId: 'ut-h2', toVersion: NEXT_VERSION,
    fromVersion: CURRENT_VERSION, releaseId: `rel-${NEXT_VERSION}`,
    packageSha256, now: () => NOW,
  })
  const transaction = {
    txnId: 'ut-h2', fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION,
    releaseId: `rel-${NEXT_VERSION}`, packagePath, packageSha256,
    closure: [
      { path: 'product/release/runtime-manifest.json', bytes: manifest.length, sha256: createHash('sha256').update(manifest).digest('hex') },
      { path: 'product/launcher/cli.mjs', bytes: launcher.length, sha256: createHash('sha256').update(launcher).digest('hex') },
    ],
    healthProbe: async () => ({ ok: true }),
  }
  const fx = helperEffects({ listInstalledVersionsImpl: () => [CURRENT_VERSION, NEXT_VERSION] })
  // 用真实的 unpack，但把 `unpack` 从替身里去掉。
  delete fx.unpack
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir: join(ctx.root, 'helper') },
    transaction, credentialSecretHex: issued.secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'committed', report.reason)
  // 文件真的落在版本目录里，而且字节与闭包一致。
  const extracted = readFileSync(join(versionsDir, NEXT_VERSION, 'product', 'launcher', 'cli.mjs'))
  assert.deepEqual(extracted, launcher)
})

test('★ helper：包里有闭包之外的可执行文件 → 解压被拒，不切换指针', async (t) => {
  const ctx = setup(t)
  const { createHash } = await import('node:crypto')
  const { writeFileSync } = await import('node:fs')
  const { makeZipFixture } = await import('./fixtures/zip.mjs')

  const good = Buffer.from('#!/usr/bin/env node\n', 'utf8')
  const zip = makeZipFixture([
    { name: 'product/launcher/cli.mjs', bytes: good },
    { name: 'product/surprise.exe', bytes: Buffer.from('MZ') },
  ])
  const packagePath = join(ctx.root, 'package.zip')
  writeFileSync(packagePath, zip)
  const packageSha256 = createHash('sha256').update(zip).digest('hex')
  mkdirSync(join(ctx.installDir, 'versions'), { recursive: true })

  acquireBarrier({ dataDir: ctx.dataDir, txnId: 'ut-h3', now: () => NOW })
  const issued = issueCredential({
    dataDir: ctx.dataDir, txnId: 'ut-h3', toVersion: NEXT_VERSION,
    fromVersion: CURRENT_VERSION, releaseId: `rel-${NEXT_VERSION}`, packageSha256, now: () => NOW,
  })
  const fx = helperEffects()
  delete fx.unpack
  const report = await runHelper({
    paths: { installDir: ctx.installDir, dataDir: ctx.dataDir, helperDir: join(ctx.root, 'helper') },
    transaction: {
      txnId: 'ut-h3', fromVersion: CURRENT_VERSION, toVersion: NEXT_VERSION,
      releaseId: `rel-${NEXT_VERSION}`, packagePath, packageSha256,
      closure: [{ path: 'product/launcher/cli.mjs', bytes: good.length, sha256: createHash('sha256').update(good).digest('hex') }],
      healthProbe: async () => ({ ok: true }),
    },
    credentialSecretHex: issued.secretHex, effects: fx,
  })
  assert.equal(report.verdict, 'rolled-back', report.reason)
  assert.equal(report.code, 'helper-unpack-failed')
  assert.match(report.reason, /unknown-executable/)
  assert.equal(fx.calls.some((c) => Array.isArray(c) && c[0] === 'activate'), false, '解压被拒之后仍然切换了指针')
  assert.equal(readBarrier(ctx.dataDir).blocked, false)
})

test('helper：调用面缺字段一律拒绝', () => {  assert.equal(validateInvocation({}).ok, false)
  assert.equal(validateInvocation({
    paths: { installDir: 'a', dataDir: 'b', helperDir: 'c' },
    transaction: { txnId: 'x', toVersion: '1', packagePath: 'nonexistent', packageSha256: 'a'.repeat(64) },
  }).ok, false, '包不存在时调用面校验通过')
})

// ---------------------------------------------------------------------------
// ⑦ 结论读数
// ---------------------------------------------------------------------------

test('结论读数：没有报告时是"需要人工"，不是"成功"', () => {
  const none = finalVerdict(null)
  assert.equal(none.verdict, 'recovery-required')
  assert.equal(none.knownCompatible, false)
  const committed = finalVerdict({ verdict: 'committed', toVersion: NEXT_VERSION })
  assert.equal(committed.knownCompatible, true)
  const rolledBack = finalVerdict({ verdict: 'rolled-back', fromVersion: CURRENT_VERSION })
  assert.equal(rolledBack.knownCompatible, true)
  assert.match(rolledBack.reason, /业务数据未被替换/)
})

test('数据安全读数：从备份恢复必须报"写入已丢"', () => {
  const restored = helperDataSafety({ verdict: 'recovery-required', restoredFromBackup: true })
  assert.equal(restored.businessDataIntact, false)
  assert.match(restored.reason, /已丢/)
  const noMigrations = helperDataSafety({ verdict: 'committed', migrationOutcome: 'no-migrations' })
  assert.equal(noMigrations.businessDataIntact, true)
  const atRisk = helperDataSafety({ verdict: 'recovery-required' })
  assert.equal(atRisk.businessDataIntact, false)
})

test('helper 报告：写坏的报告读不回来（不能当成"没发生升级"）', async (t) => {
  const ctx = setup(t)
  mkdirSync(join(ctx.dataDir, 'update'), { recursive: true })
  writeFileSync(join(ctx.dataDir, 'update', 'helper-report.json'), '{ broken', 'utf8')
  assert.equal(readHelperReport(ctx.dataDir), null)
  assert.equal(writeHelperReport(ctx.dataDir, { verdict: 'committed', toVersion: NEXT_VERSION }) !== null, true)
  assert.equal(readHelperReport(ctx.dataDir).verdict, 'committed')
})

test('事务 ID 每次不同', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newTransactionId()))
  assert.equal(ids.size, 50)
  assert.deepEqual([...INSTALL_VERDICTS], ['not-started', 'maintenance-required', 'handed-off'])
})
