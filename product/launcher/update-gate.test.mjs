// product/launcher/update-gate.test.mjs
// ============================================================================
// Launcher 的升级维护闸门 —— 自动更新设计 §8 line 182
//
// 原文：「新旧 Launcher 均识别未完成事务，在恢复结束前禁止正常业务启动。」
//
// 这条判据的**全部内容**是"闸门是不是排在第一位"。一个排在端口检查之后的
// 闸门在平时完全一样——只在"升级中断、而端口恰好空闲"的那一次不同，
// 而那次的表现是：服务正常起来，开始往一个旧版本读不懂的数据库结构上写。
//
// 所以这里的用例分成两类：
//   · 有未完成事务/屏障时，preflight 必须**在**端口检查之前就返回失败；
//   · 没有时，preflight 必须照常往下走（不能顺手把所有人挡掉）。
// ============================================================================

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveLayout } from '../paths.mjs'
import { createLauncher } from './launcher.mjs'
import { acquireBarrier, startupGate } from '../update/barrier.mjs'
import { createJournal, planRecovery } from '../update/journal.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function layoutIn(root) {
  const { layout } = resolveLayout({
    installDir: REPO_ROOT,
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
  })
  return layout
}

test('★ 升级中断：preflight 在端口检查之前就被拦住', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'), { recursive: true })

  const layout = layoutIn(root)
  // 造一个"停在切换之前"的未完成事务，并立起维护屏障。
  const journal = createJournal({ dataDir: layout.dataDir, txnId: 'ut-gate', now: () => 1 })
  journal.begin({ fromVersion: '1.0.0', toVersion: '1.1.0', phase: 'backup' })
  acquireBarrier({ dataDir: layout.dataDir, txnId: 'ut-gate', now: () => 1 })

  const L = createLauncher({
    layout,
    // ★ 用**默认**闸门（`defaultUpdateGate`），也就是生产路径。
    //   这条用例守的是"闸门排在端口检查之前"，所以它必须走真实实现；
    //   传一个自造的替身会把"默认实现忘了带 planRecovery"这类问题盖住。
  })

  const pre = await L.preflight()
  assert.equal(pre.ok, false, '一次未完成的升级没有拦住启动')
  assert.equal(pre.phase, 'update-maintenance')
  assert.equal(pre.code, 'UPDATE_TRANSACTION_UNFINISHED')
  const diagnostic = pre.diagnostics.find((d) => d.process === 'update')
  assert.ok(diagnostic !== undefined, '没有给出升级相关的诊断')
  assert.equal(diagnostic.severity, 'error')
  // 建议必须可行动。
  assert.match(String(diagnostic.advice ?? ''), /管理员|重试|维护|退回|备份/)
})

test('★ 维护屏障读不出来：仍然拦住启动（按"维护中"处理）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data', 'update'), { recursive: true })
  const layout = layoutIn(root)
  // 写一个半截的屏障文件（断电的形态）。
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(layout.dataDir, 'update', 'maintenance.json'), '{"format":"legion/update-barr', 'utf8')

  const L = createLauncher({ layout })
  const pre = await L.preflight()
  assert.equal(pre.ok, false, '损坏的维护屏障被当成了"没有屏障"')
  assert.equal(pre.phase, 'update-maintenance')
  assert.equal(pre.code, 'UPDATE_MAINTENANCE')
})

test('没有未完成事务：闸门放行，preflight 照常往下走', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'), { recursive: true })
  const layout = layoutIn(root)
  let gateCalls = 0
  const L = createLauncher({
    layout,
    // ★ 忠实于生产：`launcher.mjs` 的 `defaultUpdateGate` 是**传** `planRecovery` 的。
    //   这个替身此前省掉了它，于是它测的是一个"没接事务读数"的闸门——
    //   而那种闸门在这一版之前会**放行**（"判不出来"被当成"没有未完成事务"）。
    //   省掉它还会让"事务那一维"在门禁里从未被驱动过。
    updateGate: (args) => {
      gateCalls += 1
      return startupGate({ dataDir: args.dataDir, planRecovery: (a) => planRecovery(a) })
    },
  })
  const pre = await L.preflight()
  assert.equal(gateCalls, 1, '闸门没有被调用到')
  // 不要求 ok 为 true（真实环境里端口/密钥库可能拦），只要求**不是**被闸门拦的。
  assert.notEqual(pre.phase, 'update-maintenance', `闸门误拦了：${pre.code ?? ''}`)
  assert.equal(pre.diagnostics.some((d) => d.process === 'update'), false)
})

test('升级已完成（只有终态残留在描述符里）：不拦启动', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'), { recursive: true })
  const layout = layoutIn(root)
  const journal = createJournal({ dataDir: layout.dataDir, txnId: 'ut-done', now: () => 1 })
  journal.begin({ fromVersion: '1.0.0', toVersion: '1.1.0', phase: 'committed' })
  journal.advance('committed')
  // 屏障已经解除（提交之后解除），描述符还残留（finish 的最后一步没做完）。
  const L = createLauncher({ layout })
  const pre = await L.preflight()
  assert.notEqual(pre.phase, 'update-maintenance', '一次已完成的升级把启动拦住了')
})

test('updateGate 注入为 null：闸门关闭（供不需要它的调用方显式声明）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'data'), { recursive: true })
  const layout = layoutIn(root)
  const journal = createJournal({ dataDir: layout.dataDir, txnId: 'ut-x', now: () => 1 })
  journal.begin({ fromVersion: '1.0.0', toVersion: '1.1.0', phase: 'backup' })
  const L = createLauncher({ layout, updateGate: null })
  const pre = await L.preflight()
  assert.notEqual(pre.phase, 'update-maintenance')
})
