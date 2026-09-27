// plugins/tests/write-eligibility.test.mjs —— S5（R-3：pre-execute 判定 / RunRequest 冻结 / 等待视图）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  evaluatePreExecute, classifyTool, isWithinScope, schedulingView,
  freezeRunRequest, applyRunPatch, shouldRecheckPlan, degradationNotice,
} from '../src/writeEligibility.ts'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'src', 'writeEligibility.ts'), 'utf8')

test('TC-S5-01 只读工具放行且不申请写入资格', () => {
  assert.equal(classifyTool('read'), 'read')
  assert.equal(classifyTool('grep'), 'read')
  const d = evaluatePreExecute({ toolName: 'read', scopePaths: [] })
  assert.equal(d.allow, true)
  assert.equal(d.code, 'READ_PHASE_NO_RESERVATION')
})

test('TC-S5-02 越域写入被拒，理由可读且指向扩域事务', () => {
  const d = evaluatePreExecute({ toolName: 'edit', targetPaths: ['src/b.mjs'], scopePaths: ['src/a.mjs'] })
  assert.equal(d.allow, false)
  assert.equal(d.code, 'OUT_OF_SCOPE')
  assert.match(d.message, /扩域/)
})

test('TC-S5-03 epoch 过期 / revision 变化 / 工作区不符分别给出独立拒绝码', () => {
  const base = { toolName: 'write', targetPaths: ['src/a.mjs'], scopePaths: ['src/a.mjs'] }
  assert.equal(evaluatePreExecute({ ...base, epoch: 1, expectedEpoch: 2 }).code, 'EPOCH_STALE')
  assert.equal(evaluatePreExecute({ ...base, intentRevision: 3, expectedRevision: 4 }).code, 'REVISION_MISMATCH')
  assert.equal(evaluatePreExecute({ ...base, workspaceId: 'wt-x', expectedWorkspaceId: 'wt-y' }).code, 'WORKSPACE_MISMATCH')
  assert.equal(evaluatePreExecute(base).allow, true)
})

test('TC-S5-04 非法路径（穿越、绝对）在守卫处被拒', () => {
  assert.equal(evaluatePreExecute({ toolName: 'edit', targetPaths: ['../x.mjs'], scopePaths: ['..'] }).code, 'PATH_REJECTED')
  assert.equal(evaluatePreExecute({ toolName: 'edit', targetPaths: ['C:/x.mjs'], scopePaths: ['C:'] }).code, 'PATH_REJECTED')
})

test('TC-S5-05 RunRequest 结构断言：模型补丁改不动 attempt/epoch/revision/worktree', () => {
  const frozen = freezeRunRequest({ attemptId: 'A1', epoch: 7, intentRevision: 2, workspaceId: 'wt-1', repoId: 'r1', targetRef: 'refs/heads/main', prompt: 'old' })
  assert.deepEqual(frozen.modelOverridable, [])
  const patched = applyRunPatch(frozen, { epoch: 999, attemptId: 'HACK', intentRevision: 0, workspaceId: 'wt-evil', prompt: 'new' })
  assert.equal(patched.epoch, 7)
  assert.equal(patched.attemptId, 'A1')
  assert.equal(patched.intentRevision, 2)
  assert.equal(patched.workspaceId, 'wt-1')
  assert.equal(patched.prompt, 'new')
})

test('TC-S5-06 等待视图：等谁/等哪个文件/等待期间可做的只读工作', () => {
  const v = schedulingView({
    task: { id: 'T-b' }, requestedPaths: ['src/a/b.mjs'],
    activeReservations: [{ taskId: 'T-a', paths: ['src/a'] }],
  })
  assert.equal(v.schedulingState, 'waiting-file')
  assert.equal(v.blockingTaskId, 'T-a')
  assert.equal(v.blockingPath, 'src/a/b.mjs')
  assert.ok(v.readOnlyWork.length > 0)
  const ok = schedulingView({ task: { id: 'T-b' }, requestedPaths: ['src/z.mjs'], activeReservations: [{ taskId: 'T-a', paths: ['src/a'] }] })
  assert.equal(ok.schedulingState, 'reserved')
  assert.equal(ok.waitReason, null)
})

test('TC-S5-07 HEAD 变化需要重核计划；非 Git 有可读降级提示', () => {
  assert.equal(shouldRecheckPlan({ targetHeadAtReserve: 'aaa', targetHeadNow: 'aaa' }), false)
  assert.equal(shouldRecheckPlan({ targetHeadAtReserve: 'aaa', targetHeadNow: 'bbb' }), true)
  assert.match(degradationNotice('degraded', 'no .git'), /串行/)
  assert.match(degradationNotice('git'), /并行/)
})

test('TC-S5-08 判定来源唯一：复用 path-domain，不写第二份前缀判定', () => {
  assert.match(src, /from '..\/..\/packages\/shared\/src\/path-domain\.mjs'/)
  assert.match(src, /pathsIntersect/)
  assert.doesNotMatch(src, /startsWith\(/)
  assert.match(src, /normalizeRepoPath/)
})
