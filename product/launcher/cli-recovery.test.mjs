// product/launcher/cli-recovery.test.mjs
// ============================================================================
// 数据备份恢复入口在 **CLI 这一层**的判据（设计 §8 line 190 与 line 192）
//
// 为什么要单独一层用例，而不是只测 `update/recovery.mjs`：
//
//   设计要的是「提供…**入口**」。一个判据齐全、用例全绿、而没有任何人能敲出来
//   的模块，与一个不存在的模块在部署上是同一个东西——只不过前者的报告是绿的。
//   所以"**入口真的接上了**"必须由这一层来回答：退出码、输出里有没有那句
//   "本次没有写入任何文件"、以及**盘上有没有真的被改**。
//
// 三个数字是这一层最重要的读数：
//   0  = 计划列出来了 / 恢复做成了
//   12 = 需要 `--confirm-restore`（**一个字节都没写**）
//   13 = 这份快照不可恢复，或底层恢复失败
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_FLAGS, EXIT_CODES, RECOVERY_EXIT, run } from './cli.mjs'
import { acquireBarrier } from '../update/barrier.mjs'
import { createJournal } from '../update/journal.mjs'
import { createSnapshot } from '../upgrade/backup.mjs'

function collector() {
  const lines = []
  return { lines, write: (m) => lines.push(String(m)), text: () => lines.join('\n') }
}

/** 一个具备真实数据目录与真实快照的部署。 */
function deployment(t, { commit = false, phase = null, snapshot = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-rec-'))
  t.after(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })
  const installDir = join(root, 'install')
  const dataDir = join(root, 'data')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(join(dataDir, 'team-hub'), { recursive: true })
  writeFileSync(join(dataDir, 'team-hub', 'team.db'), 'ORIGINAL')
  const configPath = join(installDir, 'product.config.json')
  writeFileSync(configPath, '{"ports":{}}')

  let snapshotId = null
  if (snapshot) {
    const made = createSnapshot({
      backupDir: join(dataDir, 'backups'), dataDir, configPath,
      nowMs: Date.parse('2026-10-05T12:00:00Z'), label: 'pre-update',
    })
    assert.equal(made.ok, true, made.reason ?? '')
    snapshotId = made.snapshot.id
  }
  if (commit || phase !== null) {
    const j = createJournal({ dataDir, txnId: 'txn-1', now: () => 1 })
    j.begin({ fromVersion: '1.0.0', toVersion: '1.1.0', phase: 'barrier' })
    j.intent('barrier-acquire', { txnId: 'txn-1' })
    acquireBarrier({ dataDir, txnId: 'txn-1', now: () => 1 })
    j.result('barrier-acquire', { ok: true })
    j.intent('backup', { backupDir: join(dataDir, 'backups') })
    j.result('backup', { ok: true })
    if (commit) j.finish('committed', '提交')
    else j.advance(phase, '测试')
  }
  const env = {
    LEGION_HOME: root,
    LEGION_INSTALL_DIR: installDir,
    LEGION_DATA_DIR: dataDir,
    LEGION_WORKSPACE_DIR: join(root, 'ws'),
  }
  const dbPath = join(dataDir, 'team-hub', 'team.db')
  return { root, installDir, dataDir, configPath, env, snapshotId, dbPath, backupDir: join(dataDir, 'backups') }
}

const dbOf = (d) => readFileSync(d.dbPath, 'utf8')

test('★★★ CLI：--recovery-plan 是零副作用的读数，且退出 0', async (t) => {
  const d = deployment(t, { commit: true })
  const out = collector()
  const code = await run({ argv: ['--recovery-plan'], env: d.env, write: out.write, waitForSignal: false })
  assert.equal(code, EXIT_CODES.ok, `计划必须退出 0：\n${out.text()}`)
  const text = out.text()
  assert.match(text, /数据备份恢复计划/)
  assert.match(text, new RegExp(d.snapshotId))
  assert.match(text, /needs-confirmation/, '已提交的事务之后，档位必须是"要确认"')
  assert.match(text, /零副作用/, '必须明说这一条没有写过任何文件')
  // ★ 计划这一条绝不能改动数据。
  assert.equal(dbOf(d), 'ORIGINAL')
})

test('★★★ CLI：要确认的档位**缺少 --confirm-restore 时退出 12，且盘上一个字节都没变**', async (t) => {
  const d = deployment(t, { commit: true })
  // 提交之后的新写入：恢复会丢掉它们。
  writeFileSync(d.dbPath, 'NEW-COMMITTED')
  const out = collector()
  const code = await run({
    argv: [`--restore-backup=${d.snapshotId}`], env: d.env, write: out.write, waitForSignal: false,
  })
  assert.equal(code, RECOVERY_EXIT.confirmationRequired,
    `需要确认时必须退 ${RECOVERY_EXIT.confirmationRequired}（不是 0、也不是 2）：\n${out.text()}`)
  const text = out.text()
  assert.match(text, /本次没有写入任何文件/)
  assert.match(text, /--confirm-restore/, '拒绝必须给出下一步')
  // ★ 这一条是整组里最重要的断言。
  assert.equal(dbOf(d), 'NEW-COMMITTED', '没有确认的恢复动了数据')
})

test('★★★ CLI：加了 --confirm-restore 之后真的恢复（否则上一条只是"谁都恢复不了"）', async (t) => {
  const d = deployment(t, { commit: true })
  writeFileSync(d.dbPath, 'NEW-COMMITTED')
  const out = collector()
  const code = await run({
    argv: [`--restore-backup=${d.snapshotId}`, '--confirm-restore'],
    env: d.env, write: out.write, waitForSignal: false,
  })
  assert.equal(code, EXIT_CODES.ok, `确认之后应当成功：\n${out.text()}`)
  assert.match(out.text(), /已从快照/)
  assert.equal(dbOf(d), 'ORIGINAL', '确认之后没有真的恢复')
})

test('★★ CLI：safe-automatic 档不需要 --confirm-restore 就能恢复', async (t) => {
  const d = deployment(t, { phase: 'migrate' })
  const out = collector()
  const code = await run({
    argv: [`--restore-backup=${d.snapshotId}`], env: d.env, write: out.write, waitForSignal: false,
  })
  assert.equal(code, EXIT_CODES.ok, `未提交 + 屏障已证明时不该要确认：\n${out.text()}`)
  assert.equal(dbOf(d), 'ORIGINAL')
})

test('★★ CLI：refused 档**--confirm-restore 也打不开**，退出 13', async (t) => {
  const d = deployment(t, { commit: true, snapshot: false })
  // 手工造一份"写了一半"的快照。
  const brokenRoot = join(d.backupDir, 'snapshots', '2026-10-05T00-00-00-000Z-broken')
  mkdirSync(brokenRoot, { recursive: true })
  writeFileSync(join(brokenRoot, 'snapshot.json'), JSON.stringify({
    format: 'legion/backup@1', id: 'broken', status: 'failed', createdAtMs: 1,
    dataDir: d.dataDir, configPath: d.configPath, files: [{ path: 'data/team-hub/team.db', sha256: 'x', size: 1 }],
  }))
  for (const extra of [[], ['--confirm-restore']]) {
    const out = collector()
    const code = await run({
      argv: ['--restore-backup=broken', ...extra], env: d.env, write: out.write, waitForSignal: false,
    })
    assert.equal(code, RECOVERY_EXIT.refused,
      `坏快照应当退 ${RECOVERY_EXIT.refused}（confirm=${extra.length > 0}）：\n${out.text()}`)
    assert.match(out.text(), /确认不能改变这一点|不可恢复/)
    assert.equal(dbOf(d), 'ORIGINAL', '坏快照被动用了')
  }
})

test('★★ CLI：找不到指定的快照 → 退出 13，并列出有哪些', async (t) => {
  const d = deployment(t, { commit: true })
  const out = collector()
  const code = await run({
    argv: ['--restore-backup=no-such-snapshot', '--confirm-restore'],
    env: d.env, write: out.write, waitForSignal: false,
  })
  assert.equal(code, RECOVERY_EXIT.refused)
  assert.match(out.text(), /no-such-snapshot/)
  assert.match(out.text(), new RegExp(d.snapshotId), '拒绝时要把可用的快照列出来')
})

test('★★ CLI：**没有备份目录**时计划也退出 0，并说清"没有可恢复的"', async (t) => {
  // ★ 这一条守的是一个真实的崩溃：早先"没有备份目录"那条出口少给了几个字段，
  //   渲染器读 `activeTransaction.txnId` 时炸在**另一条**分支上——
  //   而那恰恰是"一台还没升级过的机器"会走的路。
  const d = deployment(t, { snapshot: false })
  assert.equal(existsSync(d.backupDir), false, '这一条需要"从来没有备份过"的部署')
  const out = collector()
  const code = await run({ argv: ['--recovery-plan'], env: d.env, write: out.write, waitForSignal: false })
  assert.equal(code, EXIT_CODES.ok, `没有备份不是错误：\n${out.text()}`)
  const text = out.text()
  assert.match(text, /没有可恢复的备份|没有备份目录/)
  assert.match(text, /未完成的事务：没有/)
  assert.match(text, /维护屏障：没立/)
})

test('★ CLI：--recovery-plan 与 --json 同用时打结构化那份', async (t) => {
  const d = deployment(t, { commit: true })
  const out = collector()
  const code = await run({ argv: ['--recovery-plan', '--json'], env: d.env, write: out.write, waitForSignal: false })
  assert.equal(code, EXIT_CODES.ok)
  const parsed = JSON.parse(out.text())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.candidates.length, 1)
  assert.equal(parsed.candidates[0].safety, 'needs-confirmation')
  assert.equal(parsed.candidates[0].requiresConfirmation, true)
})

test('★ CLI：三个恢复开关都登记在 CLI_FLAGS 里（否则 --help 与解析器认不出它们）', () => {
  // 这一步是"入口"这个说法的**字面意思**：一个没登记在表里的开关会被参数
  // 解析器当成"无法识别的参数"，于是它等于不存在——而模块那一侧的用例
  // 仍然全绿（它们直接调函数，从不经过 argv）。
  const names = CLI_FLAGS.map((f) => f.name)
  for (const n of ['--recovery-plan', '--restore-backup=<snapshotId>', '--confirm-restore']) {
    assert.equal(names.includes(n), true, `${n} 没有登记在 CLI_FLAGS 里`)
  }
})
