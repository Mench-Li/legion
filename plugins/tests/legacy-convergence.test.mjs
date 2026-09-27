// plugins/tests/legacy-convergence.test.mjs —— S6（R-6：唯一集成入口 / 模式收敛 / 诚实 done / 回滚）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  decideIntegrationPath, resolveIntegrationMode, resolveRepoMode,
  canProduceDone, observationMarker, planRollback,
} from '../src/legacyConvergence.ts'

const here = dirname(fileURLToPath(import.meta.url))

test('TC-S6-01 集成阶段启用：autoPromote 与 mediation 两条旧直合并通道都被拒并转唯一入口', () => {
  for (const source of ['autoPromote', 'mediation']) {
    const d = decideIntegrationPath({ mode: 'integration', source, taskId: 'T-1' })
    assert.equal(d.action, 'refuse-legacy')
    assert.equal(d.code, 'LEGACY_INTEGRATION_DISABLED')
    assert.equal(d.enqueueIntegration, true)
    assert.match(d.message, /T-1/)
  }
})

test('TC-S6-02 默认 legacy 与观察模式：观察只记录、不改派工', () => {
  assert.equal(resolveIntegrationMode({}), 'legacy')
  assert.equal(resolveIntegrationMode({ LEGION_INTEGRATION_MODE: 'integration' }), 'integration')
  assert.equal(resolveIntegrationMode({ LEGION_INTEGRATION_MODE: 'bogus' }), 'legacy')
  const obs = decideIntegrationPath({ mode: 'observation', source: 'mediation', taskId: 'T-1' })
  assert.equal(obs.action, 'simulate')
  assert.equal(obs.simulated, true)
  assert.equal(obs.enqueueIntegration, false)
  assert.equal(observationMarker('observation').changesDispatch, false)
  const legacy = decideIntegrationPath({ mode: 'legacy', source: 'autoPromote', taskId: 'T-1' })
  assert.equal(legacy.action, 'allow-legacy')
})

test('TC-S6-03 同一仓库被多空间以不同模式绑定 → 冲突而非静默取一个', () => {
  const ok = resolveRepoMode([{ spaceId: 'a', mode: 'integration' }, { spaceId: 'b', mode: 'integration' }])
  assert.equal(ok.ok, true)
  assert.equal(ok.mode, 'integration')
  const bad = resolveRepoMode([{ spaceId: 'a', mode: 'integration' }, { spaceId: 'b', mode: 'legacy' }])
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'REPO_MODE_CONFLICT')
})

test('TC-S6-04 done 只由 integrated + 原有验收通过产生', () => {
  assert.equal(canProduceDone({ deliveryState: 'integrated', acceptancePassed: true }), true)
  assert.equal(canProduceDone({ deliveryState: 'needs-review', acceptancePassed: true }), false)
  assert.equal(canProduceDone({ deliveryState: 'integrated', acceptancePassed: false }), false)
  assert.equal(canProduceDone({ deliveryState: null, acceptancePassed: true }), false)
})

test('TC-S6-05 回滚保留 DB/分支/临时工作区，只关新任务自动认领并做在途对账', () => {
  const p = planRollback({ inFlightJobs: ['J-1', 'J-2'] })
  assert.equal(p.disableAutoClaimForNewTasks, true)
  assert.equal(p.deleteDbRecords, false)
  assert.equal(p.deleteBranches, false)
  assert.equal(p.deleteTempWorkspaces, false)
  assert.equal(p.reconcileJobs.length, 2)
})

test('TC-S6-06 旧通道已实际接线：index.ts autoPromote 与 mediation.ts 都调用闸门', () => {
  const index = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  const mediation = readFileSync(join(here, '..', 'src', 'mediation.ts'), 'utf8')
  assert.match(index, /decideIntegrationPath\(\{ mode: resolveIntegrationMode\(process\.env\), source: 'autoPromote'/)
  assert.match(mediation, /decideIntegrationPath\(\{ mode: resolveIntegrationMode\(process\.env\), source: 'mediation'/)
})
