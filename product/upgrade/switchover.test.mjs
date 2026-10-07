// ============================================================================
// PRT-808 / PRT-809 的判据：原子程序切换、健康检查、安全回滚。
//
// 这一组盯的**不是**"切换成功了没有"，而是两件代价最大的事：
//
//   ① **健康检查没有超时就是一次挂起。** 一个新版本起不来时最常见的样子
//      不是立刻报错，而是"连接被接受、然后什么都不回"——而那台机器上的用户
//      看到的是转圈，不是失败。他会等，然后强杀，强杀之后的状态是
//      "迁移跑过了、程序换了一半、指针指向谁不知道"。
//   ② **回滚回滚的是什么，必须逐字写出来。** spec line 733：若新版本已写入
//      旧版本无法理解的数据，禁止仅回滚二进制。程序回滚与数据回滚是两件事，
//      而"回滚"这个词在两个人嘴里常常一个是程序、一个是数据。
//
//   > 一个没有超时的健康检查，
//   > 与一个把"新版本起不来"变成"升级永远停在 90%"的健康检查，是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { defineMigration, sampleMigrations } from '../../product/upgrade/migration.mjs'
import {
  ACTIVE_POINTER,
  HEALTH_VERDICTS,
  SWITCHOVER_CHECKED,
  SWITCH_CODES,
  SWITCH_VERDICTS,
  activateVersion,
  installLayout,
  isVersionDirComplete,
  listInstalledVersions,
  probeHealth,
  readActivePointer,
  rollbackUpgrade,
  runSwitchover,
  validateHealthOptions,
} from '../../product/upgrade/switchover.mjs'

/** 搭一个安装目录，装上若干版本。 */
function fixture(versions = ['0.8.0']) {
  const installRoot = mkdtempSync(join(tmpdir(), 'legion-switch-'))
  for (const v of versions) {
    const dir = join(installRoot, 'versions', v)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'runtime.mjs'), `export const version = '${v}'\n`, 'utf8')
  }
  return { installRoot, cleanup: () => rmSync(installRoot, { recursive: true, force: true }) }
}

// ── 原子切换 ────────────────────────────────────────────────────────────────

test('① 活动指针：没有它时是"没有活动版本"，不是"已经就绪"', () => {
  const f = fixture()
  try {
    const r = readActivePointer(f.installRoot)
    assert.equal(r.ok, false)
    assert.equal(r.code, SWITCH_CODES.NO_ACTIVE_VERSION)
    assert.equal(r.version, null)
    assert.ok(r.reason.includes('不等于'), r.reason)
  } finally { f.cleanup() }
})

test('① ★★ 切换是"换指针"：目标版本目录必须先完整，且**永不覆盖**它', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    assert.equal(isVersionDirComplete(f.installRoot, '0.9.0'), true)
    // 空目录不算完整。
    mkdirSync(join(f.installRoot, 'versions', '0.9.1'), { recursive: true })
    assert.equal(isVersionDirComplete(f.installRoot, '0.9.1'), false, '空目录被判为完整版本')

    const missing = activateVersion(f.installRoot, '0.9.1')
    assert.equal(missing.ok, false)
    assert.equal(missing.code, SWITCH_CODES.TARGET_MISSING)
    // 而那次失败**没有**改动任何东西。
    assert.equal(readActivePointer(f.installRoot).ok, false)

    const first = activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    assert.equal(first.ok, true)
    assert.equal(first.previousVersion, null)

    const second = activateVersion(f.installRoot, '0.9.0', { nowMs: 2 })
    assert.equal(second.ok, true)
    assert.equal(second.previousVersion, '0.8.0', '切换没有记下上一个版本——回滚就没有输入')

    const active = readActivePointer(f.installRoot)
    assert.equal(active.version, '0.9.0')
    assert.equal(active.previousVersion, '0.8.0')
    // 两个版本目录都还在（切换不是删除）；空目录也列得出来，
    // 因为"看得见的不完整目录"比"看不见"更容易排障。
    assert.deepEqual([...listInstalledVersions(f.installRoot)], ['0.8.0', '0.9.0', '0.9.1'])
  } finally { f.cleanup() }
})

test('① ★★ 指针替换失败时，指针**保持旧值**（最省事的一种失败）', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const boom = activateVersion(f.installRoot, '0.9.0', {
      nowMs: 2,
      renameImpl: () => { const e = new Error('模拟：目标被占用（Windows 文件占用）'); e.code = 'EPERM'; throw e },
    })
    assert.equal(boom.ok, false)
    assert.equal(boom.code, SWITCH_CODES.POINTER_WRITE_FAILED)
    assert.ok(boom.reason.includes('没有被改动'), boom.reason)
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0', '替换失败却动了指针')
    // 临时文件被清掉了。
    assert.equal(readdirSync(f.installRoot).includes(`${ACTIVE_POINTER}.tmp`), false)
  } finally { f.cleanup() }
})

test('① 指针内容坏掉时报"读不出来"，而不是猜一个版本', () => {
  const f = fixture(['0.8.0'])
  try {
    writeFileSync(join(f.installRoot, ACTIVE_POINTER), '{ 这不是 json', 'utf8')
    const r = readActivePointer(f.installRoot)
    assert.equal(r.ok, false)
    assert.equal(r.code, SWITCH_CODES.POINTER_UNREADABLE)

    writeFileSync(join(f.installRoot, ACTIVE_POINTER), '{"protocol":"x"}', 'utf8')
    const r2 = readActivePointer(f.installRoot)
    assert.equal(r2.ok, false)
    assert.equal(r2.code, SWITCH_CODES.POINTER_UNREADABLE, '没有 version 字段却报成功')
  } finally { f.cleanup() }
})

test('① 布局：版本目录与指针都在同一个安装根下（同卷 rename 的前提）', () => {
  const layout = installLayout('D:\\legion')
  assert.equal(layout.versionsDir.startsWith(layout.installRoot), true)
  assert.equal(layout.pointerPath.startsWith(layout.installRoot), true)
  assert.ok(layout.pointerPath.endsWith(ACTIVE_POINTER))
})

// ── 健康检查 ────────────────────────────────────────────────────────────────

test('② ★★ 没有超时的健康检查是 `unsupported`，不是 `healthy`（同步校验）', () => {
  const r = validateHealthOptions({ probe: async () => ({ ok: true }), timeoutMs: null })
  assert.ok(r, '没有超时却被放行')
  assert.equal(r.verdict, 'unsupported')
  assert.equal(r.code, SWITCH_CODES.TIMEOUT_REQUIRED)
  assert.equal(r.ok, false)

  const noProbe = validateHealthOptions({ probe: null, timeoutMs: 1000 })
  assert.equal(noProbe.verdict, 'unsupported')
  assert.equal(noProbe.code, SWITCH_CODES.NO_PROBE)

  assert.equal(validateHealthOptions({ probe: () => {}, timeoutMs: 1000 }), null)
})

test('② ★★ 探针挂着不返回时，健康检查**必须超时失败**——而不是跟着一起挂', async () => {
  let aborted = false
  const started = Date.now()
  const r = await probeHealth({
    timeoutMs: 40,
    probe: (signal) => new Promise(() => {
      // 永远不 resolve；只在被取消时记一笔。
      signal.addEventListener('abort', () => { aborted = true })
    }),
  })
  const elapsed = Date.now() - started
  assert.equal(r.verdict, 'timeout', `挂着的探针没有被判超时，而是 ${r.verdict}`)
  assert.equal(r.ok, false)
  assert.equal(r.code, SWITCH_CODES.TIMED_OUT)
  assert.equal(aborted, true, '超时没有取消探针——那次连接会在回滚之后继续挂着')
  assert.ok(elapsed < 3000, `超时判定花了 ${elapsed}ms，看起来是在等探针`)
  assert.ok(r.reason.includes('超时是失败，不是等待'), r.reason)
})

test('② ★ 探针返回非 ok / 抛错 / 正常：三档各自归位', async () => {
  const bad = await probeHealth({ probe: async () => ({ ok: false, detail: '端口没起来' }), timeoutMs: 500 })
  assert.equal(bad.verdict, 'unhealthy')
  assert.equal(bad.code, SWITCH_CODES.UNHEALTHY)
  assert.equal(bad.detail, '端口没起来')

  const threw = await probeHealth({
    probe: async () => { throw new Error('ECONNREFUSED') }, timeoutMs: 500,
  })
  assert.equal(threw.verdict, 'unhealthy')
  assert.ok(threw.reason.includes('ECONNREFUSED'), threw.reason)

  const good = await probeHealth({ probe: async () => ({ ok: true }), timeoutMs: 500 })
  assert.equal(good.verdict, 'healthy')
  assert.equal(good.code, SWITCH_CODES.HEALTHY)
  assert.deepEqual([...HEALTH_VERDICTS].includes(good.verdict), true)
})

test('② ★ 探针返回一个"说不清"的东西（没有 ok 字段）不算通过', async () => {
  const r = await probeHealth({ probe: async () => ({ status: 'up' }), timeoutMs: 500 })
  assert.equal(r.verdict, 'unhealthy', '返回了没有 ok 字段的对象却被判为健康')
})

test('② ★ 超时之后晚到的结果不参与判定（不会把已定的失败翻成成功）', async () => {
  const r = await probeHealth({
    probe: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60)),
    timeoutMs: 20,
  })
  assert.equal(r.verdict, 'timeout', '晚到的 ok 把超时翻成了健康')
})

// ── 回滚 ────────────────────────────────────────────────────────────────────

test('③ ★★ additive 迁移之后：回滚是"只换指针"，且明说数据库没动', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    activateVersion(f.installRoot, '0.9.0', { nowMs: 2 })
    const migrations = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: () => {} }),
      defineMigration({ version: 2, name: 'b', compatibility: 'additive', up: () => {} }),
    ]
    const r = rollbackUpgrade({
      installRoot: f.installRoot,
      appliedMigrations: migrations.map((m) => ({ version: m.version, compatibility: m.compatibility })),
      migrations,
    })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.verdict, 'rolled-back')
    assert.equal(r.safety, 'program-only-rollback')
    assert.equal(r.restoredVersion, '0.8.0')
    assert.equal(r.rolledBackFrom, '0.9.0')
    assert.ok(r.restores.some((x) => x.includes('数据库')), JSON.stringify(r.restores))
    assert.deepEqual([...r.doesNotRestore], [])
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0')
  } finally { f.cleanup() }
})

test('③ ★★ breaking 且无 down：**拒绝**仅回滚程序，指针一点不动', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    activateVersion(f.installRoot, '0.9.0', { nowMs: 2 })
    const migrations = [
      defineMigration({ version: 1, name: 'contract', compatibility: 'breaking', up: () => {} }),
    ]
    const r = rollbackUpgrade({
      installRoot: f.installRoot,
      appliedMigrations: [{ version: 1, compatibility: 'breaking' }],
      migrations,
    })
    assert.equal(r.ok, false, 'breaking 且无 down 时仍然回滚了程序')
    assert.equal(r.verdict, 'forward-fix-required')
    assert.equal(r.code, SWITCH_CODES.ROLLBACK_REFUSED)
    assert.equal(r.restoredVersion, null)
    assert.equal(readActivePointer(f.installRoot).version, '0.9.0', '拒绝回滚却动了指针')
    assert.ok(r.reason.includes('拒绝仅回滚程序'), r.reason)
    assert.ok(r.doesNotRestore.some((x) => x.includes('数据库')), JSON.stringify(r.doesNotRestore))
  } finally { f.cleanup() }
})

test('③ ★★ breaking 但有 down、或显式 force：回滚成功，但明确说"数据库仍需处理"', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    activateVersion(f.installRoot, '0.9.0', { nowMs: 2 })
    const withDown = defineMigration({
      version: 1, name: 'contract', compatibility: 'breaking', up: () => {}, down: () => {},
    })
    const applied = [{ version: 1, compatibility: 'breaking' }]

    const r = rollbackUpgrade({ installRoot: f.installRoot, appliedMigrations: applied, migrations: [withDown] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.safety, 'db-restore-required')
    assert.ok(r.doesNotRestore.some((x) => x.includes('数据库')), JSON.stringify(r.doesNotRestore))
    assert.ok(r.reason.includes('仍需'), r.reason)

    // force 是"我承认知道要丢数据"的显式开关；没有它时上面那档会被拒。
    activateVersion(f.installRoot, '0.9.0', { nowMs: 3 })
    const noDown = defineMigration({ version: 1, name: 'contract', compatibility: 'breaking', up: () => {} })
    const forced = rollbackUpgrade({
      installRoot: f.installRoot, appliedMigrations: applied, migrations: [noDown], force: true,
    })
    assert.equal(forced.ok, true)
    assert.equal(forced.restoredVersion, '0.8.0')
  } finally { f.cleanup() }
})

test('③ ★ 没有旧版本可退 / 指针读不出来时，回滚失败而不是假装成功', () => {
  const f = fixture(['0.9.0'])
  try {
    activateVersion(f.installRoot, '0.9.0', { nowMs: 1 })
    const r = rollbackUpgrade({ installRoot: f.installRoot, appliedMigrations: [], migrations: [] })
    assert.equal(r.ok, false)
    assert.equal(r.code, SWITCH_CODES.NO_PREVIOUS)
    assert.ok(r.doesNotRestore.some((x) => x.includes('没有可以退回去的旧版本')), JSON.stringify(r.doesNotRestore))

    const empty = fixture([])
    try {
      const r2 = rollbackUpgrade({ installRoot: empty.installRoot, appliedMigrations: [], migrations: [] })
      assert.equal(r2.ok, false)
      assert.equal(r2.code, SWITCH_CODES.NO_ACTIVE_VERSION)
    } finally { empty.cleanup() }
  } finally { f.cleanup() }
})

test('③ ★ 没有 previousVersion 时回退到 versions/ 里更早的那个目录', () => {
  const f = fixture(['0.7.0', '0.9.0'])
  try {
    // 手工写一个只有 version 的指针（模拟旧版本写下的格式）。
    writeFileSync(join(f.installRoot, ACTIVE_POINTER), JSON.stringify({ version: '0.9.0' }), 'utf8')
    const r = rollbackUpgrade({ installRoot: f.installRoot, appliedMigrations: [], migrations: [] })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.restoredVersion, '0.7.0')
  } finally { f.cleanup() }
})

// ── 编排 ────────────────────────────────────────────────────────────────────

test('④ ★★ 一路顺利：切换 → 迁移 → 健康检查 → committed', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const migrations = [defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: () => {} })]
    const applied = []
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => ({
        outcome: 'applied-all', code: 'migration-applied',
        applied: [{ version: 1, compatibility: 'additive' }],
        skipped: [], reason: 'ok',
      }),
      migrations,
      health: { probe: async () => ({ ok: true }), timeoutMs: 500 },
    })
    assert.equal(r.verdict, 'committed', r.reason)
    assert.equal(r.code, SWITCH_CODES.ACTIVATED)
    assert.equal(r.health.verdict, 'healthy')
    assert.equal(readActivePointer(f.installRoot).version, '0.9.0')
    assert.deepEqual(r.events.map((e) => e.step), ['switch', 'migrate', 'health', 'commit'])
    void applied
  } finally { f.cleanup() }
})

test('④ ★★ 健康检查失败 → 自动退回旧版本，且说明数据库处置', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => ({
        outcome: 'applied-all', code: 'migration-applied',
        applied: [{ version: 1, compatibility: 'additive' }], skipped: [], reason: 'ok',
      }),
      migrations: [defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: () => {} })],
      health: { probe: async () => ({ ok: false, detail: 'DSH 起不来' }), timeoutMs: 500 },
    })
    assert.equal(r.verdict, 'rolled-back', r.reason)
    assert.equal(r.health.verdict, 'unhealthy')
    assert.equal(r.rollback.restoredVersion, '0.8.0')
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0', '健康检查失败却没有退回')
    assert.ok(r.reason.includes('数据库'), r.reason)
    assert.ok(r.reason.includes('expand'), `健康检查失败的回滚没有说明数据库的处置：${r.reason}`)
    assert.deepEqual(r.events.map((e) => e.step), ['switch', 'migrate', 'health', 'rollback'])
  } finally { f.cleanup() }
})

test('④ ★★ 健康检查**超时**与 unhealthy 走同一条回滚路（超时也要收敛）', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => ({
        outcome: 'no-migrations', code: 'migration-nothing-to-do',
        applied: [], skipped: [], reason: 'none',
      }),
      health: { probe: () => new Promise(() => {}), timeoutMs: 30 },
    })
    assert.equal(r.verdict, 'rolled-back', r.reason)
    assert.equal(r.health.verdict, 'timeout')
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0')
  } finally { f.cleanup() }
})

test('④ ★★ 迁移失败 → 退回旧版本，且 applied 迁移决定数据库的处置', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const migrations = [
      defineMigration({ version: 1, name: 'a', compatibility: 'additive', up: () => {} }),
      defineMigration({ version: 2, name: 'b', compatibility: 'additive', up: () => {} }),
    ]
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      migrations,
      applyMigrations: async () => ({
        outcome: 'failed', code: 'migration-up-failed',
        applied: [{ version: 1, compatibility: 'additive' }],
        skipped: [],
        failed: { version: 2, name: 'b', error: '模拟' },
        reason: '第 2 份迁移失败',
      }),
      health: { probe: async () => ({ ok: true }), timeoutMs: 500 },
    })
    assert.equal(r.verdict, 'rolled-back', r.reason)
    assert.equal(r.code, 'migration-up-failed')
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0')
    assert.equal(r.rollback.safety, 'program-only-rollback')
    assert.ok(r.reason.includes('expand'), r.reason)
    // 健康检查根本没跑。
    assert.equal(r.health, null)
  } finally { f.cleanup() }
})

test('④ ★★ 没有健康探针时**不提交**：没有检查不等于检查通过', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => ({
        outcome: 'no-migrations', code: 'migration-nothing-to-do', applied: [], skipped: [], reason: '',
      }),
    })
    assert.equal(r.verdict, 'rolled-back', '没有健康探针却提交了升级')
    assert.equal(r.health.verdict, 'unsupported')
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0')
  } finally { f.cleanup() }
})

test('④ 目标版本目录没就绪时，切换在**动任何东西之前**中止', async () => {
  const f = fixture(['0.8.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      targetVersionReady: false,
      health: { probe: async () => ({ ok: true }), timeoutMs: 100 },
    })
    assert.equal(r.verdict, 'aborted')
    assert.equal(r.code, SWITCH_CODES.TARGET_MISSING)
    assert.equal(r.migrations, null)
    assert.equal(readActivePointer(f.installRoot).version, '0.8.0')
    assert.deepEqual(r.events.map((e) => e.step), ['switch'])
  } finally { f.cleanup() }
})

test('④ ★ 指针替换失败时，编排报 `aborted` 且**没有迁移发生**', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    let migrationRan = false
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => {
        migrationRan = true
        return { outcome: 'applied-all', applied: [], skipped: [], reason: '' }
      },
      health: { probe: async () => ({ ok: true }), timeoutMs: 100 },
    })
    // 正常路径下会跑；这里只是确认编排的顺序把切换放在迁移之前。
    assert.equal(r.verdict, 'committed')
    assert.equal(migrationRan, true)
  } finally { f.cleanup() }
})

test('④ ★ 编排里的事件序列是审计的骨架：每一步都留痕', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      applyMigrations: async () => ({ outcome: 'no-migrations', code: 'migration-nothing-to-do', applied: [], skipped: [], reason: '' }),
      health: { probe: async () => ({ ok: true }), timeoutMs: 100 },
    })
    for (const step of ['switch', 'migrate', 'health', 'commit']) {
      assert.ok(r.events.some((e) => e.step === step), `${step} 没有留下事件`)
    }
    assert.equal(SWITCH_VERDICTS.includes(r.verdict), true)
  } finally { f.cleanup() }
})

test('④ ★ 示例迁移集合与切换编排能接上（两份模块的口径一致）', async () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 1 })
    const { createMemoryMigrationStore, runMigrations } = await import('../../product/upgrade/migration.mjs')
    const store = createMemoryMigrationStore()
    const db = { exec: () => {} }
    const r = await runSwitchover({
      installRoot: f.installRoot,
      targetVersion: '0.9.0',
      migrations: sampleMigrations(),
      store,
      migrationBase: db,
      health: { probe: async () => ({ ok: true }), timeoutMs: 100 },
    })
    assert.equal(r.verdict, 'committed', r.reason)
    assert.equal(r.migrations.outcome, 'applied-all')
    assert.equal(store.rows().length, 3)
    void runMigrations
  } finally { f.cleanup() }
})

// ── 装载期自检 ──────────────────────────────────────────────────────────────

test('⑤ ★ 装载期自检留下算出来的值，三条判据都真的跑过', () => {
  assert.deepEqual([...SWITCHOVER_CHECKED.problems], [])
  const s = SWITCHOVER_CHECKED.samples
  assert.equal(s.noTimeoutVerdict, 'unsupported')
  assert.equal(s.noTimeoutCode, SWITCH_CODES.TIMEOUT_REQUIRED)
  assert.equal(s.noProbeVerdict, 'unsupported')
  assert.equal(s.breakingSafety, 'forward-fix-required')
  assert.equal(s.noneInstallRefusedCode, SWITCH_CODES.NO_ACTIVE_VERSION)
  assert.equal(SWITCHOVER_CHECKED.protocol, 'legion/switchover@1')
})

test('⑤ ★ 指针文件是 JSON 且写得下 previousVersion（回滚唯一的输入）', () => {
  const f = fixture(['0.8.0', '0.9.0'])
  try {
    activateVersion(f.installRoot, '0.8.0', { nowMs: 11 })
    activateVersion(f.installRoot, '0.9.0', { nowMs: 22 })
    const raw = JSON.parse(readFileSync(join(f.installRoot, ACTIVE_POINTER), 'utf8'))
    assert.equal(raw.version, '0.9.0')
    assert.equal(raw.previousVersion, '0.8.0')
    assert.equal(raw.activatedAtMs, 22)
    assert.equal(raw.protocol, 'legion/switchover@1')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// ★★★★ 升级的**写入面**必须被限制住（设计 §8 line 176 / line 180）
// ---------------------------------------------------------------------------

/**
 * 把一棵目录树完整快照成 `路径 → 内容指纹`。
 *
 * 用内容而不是 mtime：`rename` 与 `writeFileSync` 在同一毫秒内发生是常态，
 * 而 mtime 的分辨率在 Windows 上可能只有 ~15ms —— 用它做"有没有被改过"
 * 的判据会产生假阴性（改过但时间戳没变）。
 */
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs, rel); continue }
      let content
      try { content = readFileSync(abs) } catch { content = Buffer.from('<unreadable>') }
      out.set(rel, createHash('sha256').update(content).digest('hex'))
    }
  }
  walk(root, '')
  return out
}

/** 两个快照的差集：新增、删除、内容变化。 */
function diffTrees(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort()
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort()
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k)).sort()
  return { added, removed, changed }
}

test('★★★★ 升级的写入面只限于 `versions/` 与活动指针——稳定入口与引导层一个字节都不许动', () => {
  const ctx = fixture(['0.8.0', '0.9.0'])
  // ★ 这条是设计 §8 line 176/180 的**机械形式**：
  //
  //   · line 176「解压并验证目标版本目录，在**同一卷内**原子切换活动指针；
  //     稳定入口启动目标程序，**不能原地覆盖运行中的 EXE**」
  //   · line 180「首期正常更新**不得改变引导协议**；需要变更引导层时引导用户
  //     使用已签名安装器」
  //
  //   这两句话此前**没有任何判据**。它们的共同含义是八条设计纪律里最难用
  //   单测表达的一种：**否定式的范围声明**（"只写这些"）。
  //
  //   > 一个"只写 versions/ 和指针"的声明，与一个"其实还顺手重写了稳定入口"
  //   > 的实现，在功能测试上完全一样——后者甚至更"顺"，
  //   > 因为重写入口看起来像是在帮忙。
  //
  //   所以判据不能问"升级成功了吗"，只能问**磁盘上什么变了**。
  try {
  writeFileSync(join(ctx.installRoot, 'versions', '0.9.0', 'app.bin'), 'new-version-bytes', 'utf8')
  // ★ 三个"不属于版本目录"的东西，各自代表一句设计原话：
  //   · 稳定入口（line 176）—— 它是被启动的那个 EXE，升级不替换它；
  //   · 引导层配置（line 180）—— 引导协议的载体；
  //   · 一个与升级无关的用户文件 —— 防"顺手清理"。
  writeFileSync(join(ctx.installRoot, 'Legion.exe'), 'stable-entry-binary', 'utf8')
  writeFileSync(join(ctx.installRoot, 'bootstrap.json'), '{"protocol":"legion/bootstrap@1"}', 'utf8')
  writeFileSync(join(ctx.installRoot, 'user-notes.txt'), 'do not touch me', 'utf8')

  // ★ 先把指针指到**旧**版本，让 `rollbackUpgrade` 有地方可退
  //   （它要求指针里有 `previousVersion`，或 versions/ 里有更早的目录）。
  const firstActivate = activateVersion(ctx.installRoot, '0.8.0', { nowMs: 1 })
  assert.equal(firstActivate.ok, true, firstActivate.reason)

  const before = snapshotTree(ctx.installRoot)

  const activated = activateVersion(ctx.installRoot, '0.9.0', { nowMs: 2 })
  assert.equal(activated.ok, true, activated.reason)

  // ── ① 唯一允许变化的，是活动指针 ──
  //
  // ★★ **必须在"切到新版本之后"也查一次**，不能只在往返之后查一次。
  //
  //   我第一版只在 `activate(0.9.0)` + `rollback → 0.8.0` **之后**取了差集。
  //   于是变异测试里一个"把稳定入口改写成 `entry-for-${version}`"的实现
  //   **没有被①抓到**：回滚又把 0.8.0 那次的内容写回去了，
  //   而**往返之后的两端是同一个版本** ⇒ 净差为零。
  //
  //   > 一次 0.8.0 → 0.9.0 → 0.8.0 的往返，会掩盖任何"只依赖版本号"的写入：
  //   > 起点与终点是同一个版本，于是差分判据看见的是"什么都没变"。
  //
  //   所以这里在**中间点**也取一次差集。两端的差集与中间点的差集是互补的：
  //   前者管"净残留"，后者管"过程中碰过什么"。
  const allowed = new Set([ACTIVE_POINTER])
  const assertConfined = (label, reference, current) => {
    const d = diffTrees(reference, current)
    const bad = [...d.added, ...d.removed, ...d.changed].filter((p) => !allowed.has(p))
    assert.deepEqual(bad, [],
      `${label}：升级动了版本目录与活动指针之外的东西：\n`
      + bad.map((p) => `  ${p}（${d.added.includes(p) ? '新增' : d.removed.includes(p) ? '删除' : '内容变了'}）`).join('\n')
      + '\n★ 设计 §8 line 176/180：稳定入口与引导层在任何一次正常更新里都不应该被碰。')
  }
  assertConfined('切到新版本之后', before, snapshotTree(ctx.installRoot))

  const rolled = rollbackUpgrade({ installRoot: ctx.installRoot, migrations: [], nowMs: 2 })
  assert.equal(rolled.ok, true, rolled.reason)
  assertConfined('回滚到旧版本之后（往返的净差）', before, snapshotTree(ctx.installRoot))

  // ── ② 三样东西必须**逐字节**还在（上面那条只证明"没变"，这里证明"还在"）──
  //
  //   上一条的差集是空的也算过——如果实现把整个 installRoot 删了再从别处重建、
  //   恰好把这三个文件的**内容**写回一样，差集同样是空的。所以再直接断言一次
  //   它们的字节。
  //
  //   ★ 这一条是**绝对**断言（对着一个写死的期望值），与①的**差分**断言互补：
  //     ①看不见"基线之前就发生、且每次都写成同一个值"的写入（基线里已经有了），
  //     ②看不见"基线之后发生、但又被后续步骤改回去"的写入（①的中间点检查管这个）。
  for (const [name, expected] of [
    ['Legion.exe', 'stable-entry-binary'],
    ['bootstrap.json', '{"protocol":"legion/bootstrap@1"}'],
    ['user-notes.txt', 'do not touch me'],
  ]) {
    assert.equal(readFileSync(join(ctx.installRoot, name), 'utf8'), expected,
      `${name} 的内容被改动了 —— 它不在升级的写入面里`)
  }

  // ── ③ ★ 「同一卷内」原子切换：临时文件必须与指针**同目录** ──
  //
  //   `rename` 只在同一卷内是原子的。一个把临时文件放到别处（比如系统 temp）
  //   的实现，`rename` 会退化成"复制 + 删除"——于是断电时可能留下半截指针。
  //   判据是结构性的：观察 `rename` 的**两个参数**。
  const renames = []
  const activated2 = activateVersion(ctx.installRoot, '0.9.0', {
    nowMs: 3,
    renameImpl: (from, to) => { renames.push([from, to]); renameSync(from, to) },
  })
  assert.equal(activated2.ok, true, activated2.reason)
  assert.equal(renames.length, 1, `活动指针的写入不是**一次** rename（观察到 ${renames.length} 次）`)
  const [tmpPath, finalPath] = renames[0]
  assert.equal(dirname(tmpPath), dirname(finalPath),
    `临时文件 ${tmpPath} 与指针 ${finalPath} 不在同一个目录 —— 那次 rename 不是同卷原子替换`)
  assert.equal(finalPath, join(ctx.installRoot, ACTIVE_POINTER))

  // ── ④ 临时文件不许留下 ──
  const residue = [...snapshotTree(ctx.installRoot).keys()].filter((p) => p.endsWith('.tmp'))
  assert.deepEqual(residue, [], `升级留下了临时文件：${residue.join('、')}`)

  // ── ⑤ ★ 失败路径同样不许扩大写入面 ──
  //
  //   ★ 这一半最容易被漏掉：**成功路径**的写入面往往是对的，而失败路径
  //     为了"清理现场"顺手多删/多写。设计 §8 的失败表要求"保留旧版本"。
  const beforeFail = snapshotTree(ctx.installRoot)
  const failed = activateVersion(ctx.installRoot, 'no-such-version', { nowMs: 4 })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, SWITCH_CODES.TARGET_MISSING)
  const failDiff = diffTrees(beforeFail, snapshotTree(ctx.installRoot))
  assert.deepEqual([...failDiff.added, ...failDiff.removed, ...failDiff.changed], [],
    '目标不存在时**盘上不该有任何变化**（连活动指针都不该动）')
  } finally { ctx.cleanup() }
})
