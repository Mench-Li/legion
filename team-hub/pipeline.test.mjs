// team-hub/pipeline.test.mjs — SP-P0「编队即流水线」契约测试。
//
// 覆盖目标（对治 T-127 现场：目标发布成功、链也建对，却因「空间无守护实例 / 编队与流水线不一致」
// 静默停在 todo 十几小时，而指挥台毫无提示）：
//   - GET /api/pipeline：空态、回读、version 内容指纹（未变则不变）；
//   - POST /api/pipeline：写入期校验矩阵（role/label/next/gate/docs/runtime/general 门禁）+ 整批覆盖 + audit；
//   - 建链：入链 = 编队 ∩ 流水线启用岗位（非执行岗不再入链 → 机制性消除 blockedBy 链死锁）+ 阶段名取自流水线 label；
//   - 建链护栏：编队与流水线零交集 → 4xx 且零残留（目标记录也随之回滚）；
//   - GET /api/spaces/provision：开通预检清单（流水线/编队一致性/守护在线/工作区绑定/队列停滞）；
//   - 级联：空间删除清理 space_stages / space_runtime（spaces.test.mjs 另有一份零残留断言）。
// 运行：node --test team-hub/pipeline.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-pipeline-'))
let mod
let base = ''

const S = 'space-oz'          // 契约主空间（模拟业务空间）
const R = 'space-ro'          // provision 预检专用空间
const T = '2026-09-10T00:00:00.000Z'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function httpJson(method, path, { body } = {}) {
  const init = { method, headers: {} }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json' }
  const res = await fetch(base + path, init)
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const post = (path, body) => httpJson('POST', path, { body })
const get = (path) => httpJson('GET', path)

/** 三环流水线样本：role 与编队逐字一致；末环 next=null。 */
function stagesFixture() {
  return [
    { role: 'soldier-research', label: '需求调研', prompt: '调研……', next: 'soldier-selection', docs: ['research/ozon/rerun-brief.md'] },
    { role: 'soldier-selection', label: '选品与类目', prompt: '选品……', next: 'soldier-listing' },
    { role: 'soldier-listing', label: '上架准备', prompt: '上架……', next: null, docs: ['research/ozon/listing/listing-draft-sharpener.md'] },
  ]
}

function seedRoster(scope, withObserver = false) {
  const ins = mod.db.prepare('INSERT OR IGNORE INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(scope, 'soldier-research', '调研参谋', 'agent', '🔎', 0)
  ins.run(scope, 'soldier-selection', '选品参谋', 'agent', '🎯', 1)
  ins.run(scope, 'soldier-listing', '上架参谋', 'agent', '📦', 2)
  if (withObserver) ins.run(scope, 'observer', '观察员（不参与流水线）', 'human', '👀', 3)
}

function chainOf(goalId) {
  return mod.db.prepare("SELECT id, status, role, title, blockedBy, soldier FROM tasks WHERE goalId = ? AND status != 'canceled' ORDER BY id").all(goalId)
}

function storeImplementationAttempt(taskId, { testCommand, testSummary, testEvidence, sourceCommit = 'f'.repeat(40), providerRunId = `run:${taskId}` }) {
  const task = mod.db.prepare('SELECT scope, agent_selection_snapshot FROM tasks WHERE id=?').get(taskId)
  const snapshot = JSON.parse(task.agent_selection_snapshot)
  const stageId = snapshot.workflowStageId
    ?? snapshot.reviewWorkflow.implementationStageId
    ?? snapshot.reviewWorkflow.stageIdByRole?.[snapshot.reviewWorkflow.implementationRole]
    ?? snapshot.reviewWorkflow.implementationRole
  const attemptId = `wfa-test:${taskId}`
  const atMs = Date.now()
  const frozenStage = snapshot.reviewWorkflow.stageDefinitionsById?.[stageId]
  const runner = frozenStage?.testRunner ?? { executable: 'node', args: ['--test'], timeoutMs: 300000 }
  const testVerification = {
    id: `wft-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
    state: 'passed', sourceCommit, stageAttemptId: attemptId, providerRunId,
    runnerNodeId: snapshot.executionNode?.id ?? frozenStage?.nodeId ?? null,
    ...runner, exitCode: 0, startedAtMs: atMs - 10, finishedAtMs: atMs,
    outputDigest: 'a'.repeat(64), outputExcerpt: testEvidence, outputTruncated: false, error: null,
  }
  const result = {
    status: 'done', summary: 'implementation completed', evidence: '',
    testReport: { passed: true, command: testCommand, summary: testSummary, evidence: testEvidence, failures: [] },
    testVerification,
  }
  mod.db.prepare(`INSERT INTO agent_workflow_stage_attempts
    (id, scope, workflow_instance_id, task_id, stage_id, attempt_no, idempotency_key, started_by,
     provider_name, workspace_dir, provider_run_id, state, result_json, selection_snapshot_json,
     created_at_ms, updated_at_ms, started_at_ms, finished_at_ms)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`)
    .run(attemptId, task.scope, snapshot.reviewWorkflow.instanceId, taskId, stageId,
      `idem:${taskId}`, task.soldier ?? snapshot.agentToolConfig.providerName,
      snapshot.agentToolConfig.providerName, 'C:/legion/worktrees/test', providerRunId,
      JSON.stringify(result), JSON.stringify(snapshot), atMs, atMs, atMs, atMs)
  return { attemptId, providerRunId, testVerification }
}

describe('TC-SP-P0-01/02 读写：空态 → 写入 → 回读 → version 指纹', () => {
  it('未配置空间返回空流水线（runtime 默认未开通），version 稳定可复现', async () => {
    const a = await get('/api/pipeline?scope=' + S)
    assert.equal(a.status, 200, a.text)
    assert.deepEqual(a.json.stages, [])
    assert.deepEqual(a.json.activeRoles, [])
    assert.equal(a.json.runtime.enabled, false)
    assert.equal(a.json.runtime.maxWorkers, 1)
    const b = await get('/api/pipeline?scope=' + S)
    assert.equal(a.json.version, b.json.version, '空态 version 亦稳定（守护可据此跳过重建）')
  })

  it('POST 写入 → GET 回读逐字段一致、version 变化、audit pipeline:update、warnings 报出未入链成员', async () => {
    await post('/api/spaces', { id: S, name: 'ozon 业务空间', by: 'general' })
    seedRoster(S, true) // 编队 4 人，其中 observer 不参与流水线
    const before = (await get('/api/pipeline?scope=' + S)).json.version
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: stagesFixture(),
      runtime: { enabled: true, maxWorkers: 2, isolate: true },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 3)
    assert.equal(r.json.task.added, 3)
    assert.deepEqual(r.json.task.activeRoles, ['soldier-research', 'soldier-selection', 'soldier-listing'])
    const warn = r.json.task.warnings.find(w => w.code === 'roster-not-in-pipeline')
    assert.ok(warn, '应报出 observer 不参与流水线')
    assert.deepEqual(warn.roles, ['observer'])

    const view = (await get('/api/pipeline?scope=' + S)).json
    assert.notEqual(view.version, before, '内容变化 → version 变化')
    assert.equal(view.stages.length, 3)
    assert.deepEqual(view.stages.map(s => s.role), ['soldier-research', 'soldier-selection', 'soldier-listing'], '按 sort 稳定排序')
    const first = view.stages[0]
    assert.equal(first.label, '需求调研')
    assert.equal(first.next, 'soldier-selection')
    assert.equal(first.gate, false)
    assert.deepEqual(first.docs, ['research/ozon/rerun-brief.md'])
    assert.equal(view.runtime.enabled, true)
    assert.equal(view.runtime.maxWorkers, 2)

    const auditRow = mod.db.prepare("SELECT * FROM audit WHERE action = 'pipeline:update' AND scope = ?").get(S)
    assert.ok(auditRow, '审计保留 pipeline:update')
    assert.equal(JSON.parse(auditRow.detail).stages, 3)

    const again = await get('/api/pipeline?scope=' + S)
    assert.equal(again.json.version, view.version, '重复读 version 不变（守护零成本判无变化）')
  })

  it('阶段 Agent 工具与模型配置引用分别持久化，并参与流水线版本指纹', async () => {
    const stages = stagesFixture().map((stage, index) => index === 0 ? {
      ...stage,
      agentToolConfig: { id: 'tool.claude-code', version: 3 },
      modelConfig: { id: 'model.sonnet', version: 2 },
    } : stage)
    const saved = await post('/api/pipeline', { scope: S, by: 'general', stages })
    assert.equal(saved.status, 200, saved.text)
    const first = (await get('/api/pipeline?scope=' + S)).json
    assert.deepEqual(first.stages[0].agentToolConfig, { id: 'tool.claude-code', version: 3 })
    assert.deepEqual(first.stages[0].modelConfig, { id: 'model.sonnet', version: 2 })

    const changed = stages.map((stage, index) => index === 0
      ? { ...stage, agentToolConfig: { id: 'tool.claude-code', version: 4 } }
      : stage)
    const updated = await post('/api/pipeline', { scope: S, by: 'general', stages: changed })
    assert.equal(updated.status, 200, updated.text)
    const second = (await get('/api/pipeline?scope=' + S)).json
    assert.notEqual(second.version, first.version, '工具配置版本变化必须使流水线版本变化')
    assert.deepEqual(second.stages[0].agentToolConfig, { id: 'tool.claude-code', version: 4 })
    assert.deepEqual(second.stages[0].modelConfig, { id: 'model.sonnet', version: 2 }, '工具版本变化不应覆盖独立模型引用')
  })

  it('team-hub 认领冻结空间阶段工具选择，阶段配置更新不改变该 Attempt 的重试路由', async () => {
    await post('/api/spaces', { id: S, name: 'Agent 工作流验证空间', localDir: process.cwd(), by: 'general' })
    const registeredModel = await post('/api/model-profiles', {
      actor: 'general', profile: {
        id: 'model.space-reviewer', displayName: 'Review model', runtimeType: 'dsh',
        provider: 'custom-gpt', model: 'gpt-review-v1', reasoningEffort: 'medium', limits: {},
      },
    })
    assert.equal(registeredModel.status, 200, registeredModel.text)
    const makeStages = (toolVersion) => [{
      role: 'reviewer', label: '审查', prompt: '审查当前交付', next: null,
      agentToolConfig: { id: 'tool.deepseek-review', version: toolVersion },
      modelConfig: { id: 'model.space-reviewer', version: 1 },
    }]
    const configured = await post('/api/pipeline', { scope: S, by: 'general', stages: makeStages(1) })
    assert.equal(configured.status, 200, configured.text)
    const toolConfig = await post('/api/agent-tools/configs', {
      by: 'general',
      id: 'tool.deepseek-review', version: 1, providerName: 'deepseek', adapter: 'dsh-native',
      permissionProfile: 'dsh-native:deepseek', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
    })
    assert.equal(toolConfig.status, 200, toolConfig.text)
    const configuredVersion = (await get('/api/pipeline?scope=' + S)).json.version
    const taskId = 'workflow-snapshot-attempt'
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope) VALUES (?, ?, 'high', 'todo', 'reviewer', ?)")
      .run(taskId, '审查 Agent 工作流', S)

    const claimed = await post('/api/runtime/claim', { workerId: 'workflow-test', scope: S })
    assert.equal(claimed.status, 200, claimed.text)
    const lease = claimed.json.claimed
    assert.equal(lease.taskId, taskId)
    assert.deepEqual(lease.agentSelectionSnapshot, {
      source: 'space-pipeline', pipelineVersion: configuredVersion,
      stageRole: 'reviewer', agentToolConfig: {
        id: 'tool.deepseek-review', version: 1, providerName: 'deepseek', adapter: 'dsh-native',
        permissionProfile: 'dsh-native:deepseek', workspacePolicy: 'attempt-worktree-parent-cwd',
        capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
        enabled: true,
      },
      modelConfig: { id: 'model.space-reviewer', version: 1 },
      resolvedModelConfig: { id: 'model.space-reviewer', version: 1, provider: 'custom-gpt', model: 'gpt-review-v1', reasoningEffort: 'medium' },
      reviewWorkflow: null,
      workflowContext: null,
    })

    const changed = await post('/api/pipeline', { scope: S, by: 'general', stages: makeStages(2) })
    assert.equal(changed.status, 200, changed.text)
    const transition = async (to) => post('/api/runtime/transition', {
      attemptId: lease.attemptId, leaseEpoch: lease.leaseEpoch, workerId: 'workflow-test', to,
      context: to === 'RetryableFailure'
        ? { failureCode: 'test-retry', detail: 'test' }
        : to === 'Queued' ? { retryBudgetRemaining: true } : {},
    })
    assert.equal((await transition('PreparingWorkspace')).status, 200)
    assert.equal((await transition('RetryableFailure')).status, 200)
    const queued = await transition('Queued')
    assert.equal(queued.status, 200, queued.text)
    assert.deepEqual(queued.json.attempt.agentSelectionSnapshot, lease.agentSelectionSnapshot)

    const retried = await post('/api/runtime/claim', { workerId: 'workflow-test-2', scope: S })
    assert.equal(retried.status, 200, retried.text)
    assert.deepEqual(retried.json.claimed.agentSelectionSnapshot, lease.agentSelectionSnapshot)

    const nextToolConfig = await post('/api/agent-tools/configs', {
      by: 'general', id: 'tool.deepseek-review', version: 2, providerName: 'deepseek', adapter: 'dsh-native',
      permissionProfile: 'dsh-native:deepseek', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
    })
    assert.equal(nextToolConfig.status, 200, nextToolConfig.text)
    const reviewedRuntimeTask = await post('/api/transition', { id: taskId, to: 'in_review', by: 'general', scope: S, force: true })
    assert.equal(reviewedRuntimeTask.status, 200, reviewedRuntimeTask.text)
    const completedRuntimeTask = await post('/api/transition', { id: taskId, to: 'done', by: 'general', scope: S, force: true })
    assert.equal(completedRuntimeTask.status, 200, completedRuntimeTask.text)
    const legacyTaskId = 'workflow-snapshot-legacy-claim'
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, fileDomain) VALUES (?, ?, 'high', 'todo', 'reviewer', ?, ?)")
      .run(legacyTaskId, '验证守护任务认领快照', S, JSON.stringify(['docs/agent-workflow-legacy-test/']))
    const legacyClaim = await post('/api/claim', { id: legacyTaskId, soldier: 'codex-worker', by: 'general', scope: S })
    assert.equal(legacyClaim.status, 200, legacyClaim.text)
    assert.equal(legacyClaim.json.task.agentSelectionSnapshot.agentToolConfig.providerName, 'deepseek')
    assert.equal(legacyClaim.json.task.agentSelectionSnapshot.agentToolConfig.version, 2)
    const newPipeline = await post('/api/pipeline', { scope: S, by: 'general', stages: makeStages(3) })
    assert.equal(newPipeline.status, 200, newPipeline.text)
    const blocked = await post('/api/transition', { id: legacyTaskId, to: 'blocked', by: 'codex-worker', scope: S, confirmedStopped: true })
    assert.equal(blocked.status, 200, blocked.text)
    const legacyRetry = await post('/api/claim', { id: legacyTaskId, soldier: 'codex-worker', by: 'general', scope: S })
    assert.equal(legacyRetry.status, 200, legacyRetry.text)
    assert.equal(legacyRetry.json.task.agentSelectionSnapshot.agentToolConfig.version, 2, '守护重试继续使用首次认领版本，不追随最新管线')
    const stopLegacyRetry = await post('/api/transition', { id: legacyTaskId, to: 'blocked', by: 'codex-worker', confirmedStopped: true, scope: S })
    assert.equal(stopLegacyRetry.status, 200, stopLegacyRetry.text)
    const unresolvedId = 'workflow-unresolved-agent-config'
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, fileDomain) VALUES (?, ?, 'high', 'todo', 'reviewer', ?, ?)")
      .run(unresolvedId, '悬空 Agent 配置必须拒绝认领', S, JSON.stringify(['docs/agent-workflow-unresolved-test/']))
    const unresolvedClaim = await post('/api/claim', { id: unresolvedId, soldier: 'codex-worker', by: 'general', scope: S })
    assert.equal(unresolvedClaim.status, 409)
    assert.equal(unresolvedClaim.json.code, 'AGENT_TOOL_CONFIG_UNRESOLVED')
  })

  it('typed review 原子结算：混合问题先回设计，重放不重复派发，返工沿用冻结配置', async () => {
    const scope = 'space-reviewflow'
    await post('/api/spaces', { id: scope, name: 'Review 闭环验证空间', localDir: process.cwd(), by: 'general' })
    const roles = ['designer', 'coder', 'reviewer']
    const stages = roles.map((role, index) => ({
      role, label: role, prompt: `${role} prompt`, next: roles[index + 1] ?? null,
      agentToolConfig: { id: `tool.${role}`, version: 1 },
    }))
    const workflow = {
      designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2,
      stageTools: { coder: { testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } } },
    }
    const configured = await post('/api/pipeline', { scope, by: 'general', stages, workflow })
    assert.equal(configured.status, 200, configured.text)
    for (const role of roles) {
      const saved = await post('/api/agent-tools/configs', {
        by: 'general', id: `tool.${role}`, version: 1, providerName: role, adapter: 'dsh-native',
        permissionProfile: 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
        capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
      })
      assert.equal(saved.status, 200, saved.text)
    }
    const rootId = 'typed-review-design-root'
    const designPath = 'docs/review-flow/design.md'
    const designDigest = 'a'.repeat(64)
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, artifacts) VALUES (?, ?, 'high', 'done', 'designer', ?, ?)")
      .run(rootId, 'Frozen design', scope, JSON.stringify([{ by: 'claude-code', at: T, kind: 'file', path: designPath, title: 'Design', digest: designDigest }]))
    const implementationId = 'typed-review-implementation-root'
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, parent, blockedBy, fileDomain) VALUES (?, ?, 'high', 'todo', 'coder', ?, ?, ?, ?)")
      .run(implementationId, 'Frozen implementation', scope, rootId, JSON.stringify([rootId]), JSON.stringify(['docs/typed-review-flow/']))
    const implementationClaim = await post('/api/claim', { id: implementationId, soldier: 'deepseek', by: 'general', scope })
    assert.equal(implementationClaim.status, 200, implementationClaim.text)
    const implementationSnapshot = implementationClaim.json.task.agentSelectionSnapshot
    assert.deepEqual(implementationSnapshot.workflowContext.designArtifacts, [{ taskId: rootId, path: designPath, digest: designDigest, title: 'Design' }])
    const sourceCommit = 'b'.repeat(40)
    const implementationAttempt = storeImplementationAttempt(implementationId, {
      testCommand: 'npm test', testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed', sourceCommit,
    })
    const persistedImplementationAttempt = mod.db.prepare('SELECT * FROM agent_workflow_stage_attempts WHERE id=?').get(implementationAttempt.attemptId)
    assert.equal(persistedImplementationAttempt.workflow_instance_id, implementationSnapshot.reviewWorkflow.instanceId)
    assert.equal(persistedImplementationAttempt.stage_id,
      implementationSnapshot.reviewWorkflow.implementationStageId
        ?? implementationSnapshot.reviewWorkflow.stageIdByRole?.[implementationSnapshot.reviewWorkflow.implementationRole]
        ?? implementationSnapshot.reviewWorkflow.implementationRole)
    assert.equal(persistedImplementationAttempt.provider_run_id, implementationAttempt.providerRunId)
    assert.deepEqual(JSON.parse(persistedImplementationAttempt.result_json).testReport, {
      passed: true, command: 'npm test', summary: '7 tests passed', evidence: 'npm test: 7 passed', failures: [],
    })
    const proof = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit, stageAttemptId: implementationAttempt.attemptId, providerRunId: implementationAttempt.providerRunId,
      testVerification: implementationAttempt.testVerification,
      testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed',
    })}`
    const evidenceSaved = await post('/api/comment', { id: implementationId, by: 'deepseek', scope, isEvidence: true, text: proof })
    assert.equal(evidenceSaved.status, 200, evidenceSaved.text)
    const implementationReview = await post('/api/transition', { id: implementationId, to: 'in_review', by: 'deepseek', scope })
    assert.equal(implementationReview.status, 200, implementationReview.text)
    const implementationDone = await post('/api/advance', { id: implementationId, by: 'coder', scope })
    assert.equal(implementationDone.status, 200, implementationDone.text)

    const taskId = 'typed-review-source'
    mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, parent, blockedBy, fileDomain) VALUES (?, ?, 'high', 'todo', 'reviewer', ?, ?, ?, ?)")
      .run(taskId, 'Typed review lifecycle', scope, implementationId, JSON.stringify([implementationId]), JSON.stringify(['docs/typed-review-flow/']))
    const missingTestCommand = await post('/api/claim', { id: taskId, soldier: 'codex', by: 'general', scope })
    assert.equal(missingTestCommand.status, 409)
    assert.equal(missingTestCommand.json.code, 'AGENT_WORKFLOW_HANDOFF_EVIDENCE_MISSING')
    const missingAttemptProof = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit, providerRunId: implementationAttempt.providerRunId,
      testCommand: 'npm test', testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed',
    })}`
    const missingAttemptSaved = await post('/api/comment', { id: implementationId, by: 'deepseek', scope, isEvidence: true, text: missingAttemptProof })
    assert.equal(missingAttemptSaved.status, 200, missingAttemptSaved.text)
    const missingAttemptClaim = await post('/api/claim', { id: taskId, soldier: 'codex', by: 'general', scope })
    assert.equal(missingAttemptClaim.status, 409, '没有 Stage Attempt 绑定的测试证据不能进入审查')
    const mismatchedTestProof = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit, stageAttemptId: implementationAttempt.attemptId, providerRunId: implementationAttempt.providerRunId,
      testCommand: 'npm test', testSummary: 'different test result', testEvidence: 'npm test: 7 passed',
    })}`
    const mismatchedTestSaved = await post('/api/comment', { id: implementationId, by: 'deepseek', scope, isEvidence: true, text: mismatchedTestProof })
    assert.equal(mismatchedTestSaved.status, 200, mismatchedTestSaved.text)
    const mismatchedTestClaim = await post('/api/claim', { id: taskId, soldier: 'codex', by: 'general', scope })
    assert.equal(mismatchedTestClaim.status, 409, '测试命令/摘要/输出与 Attempt 持久报告不一致时不能进入审查')
    const wrongRunProof = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit, stageAttemptId: implementationAttempt.attemptId, providerRunId: 'run:other-task',
      testCommand: 'npm test', testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed',
    })}`
    const wrongRunSaved = await post('/api/comment', { id: implementationId, by: 'deepseek', scope, isEvidence: true, text: wrongRunProof })
    assert.equal(wrongRunSaved.status, 200, wrongRunSaved.text)
    const wrongRunClaim = await post('/api/claim', { id: taskId, soldier: 'codex', by: 'general', scope })
    assert.equal(wrongRunClaim.status, 409, '测试报告与 Stage Attempt 的 provider Run 不匹配时不能进入审查')
    const completeProof = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit, stageAttemptId: implementationAttempt.attemptId, providerRunId: implementationAttempt.providerRunId,
      testVerification: implementationAttempt.testVerification,
      testCommand: 'npm test', testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed',
    })}`
    const completeEvidenceSaved = await post('/api/comment', { id: implementationId, by: 'deepseek', scope, isEvidence: true, text: completeProof })
    assert.equal(completeEvidenceSaved.status, 200, completeEvidenceSaved.text)
    const claimed = await post('/api/claim', { id: taskId, soldier: 'codex', by: 'general', scope })
    assert.equal(claimed.status, 200, claimed.text)
    const snapshot = claimed.json.task.agentSelectionSnapshot
    assert.equal(snapshot.reviewWorkflow.instanceId, rootId)
    assert.equal(snapshot.reviewWorkflow.stageTools.designer.agentToolConfig.providerName, 'designer')
    assert.deepEqual(snapshot.workflowContext.designArtifacts, [{ taskId: rootId, path: designPath, digest: designDigest, title: 'Design' }])
    assert.deepEqual(snapshot.workflowContext.implementation, {
      taskId: implementationId, sourceCommit, stageAttemptId: implementationAttempt.attemptId,
      providerRunId: implementationAttempt.providerRunId, testCommand: 'npm test', testSummary: '7 tests passed', testEvidence: 'npm test: 7 passed',
      testVerification: implementationAttempt.testVerification,
    })
    const body = {
      taskId, by: 'codex', scope,
      findings: [
        { kind: 'implementation', summary: '缺少边界校验' },
        { kind: 'design', summary: '设计未定义超时重试' },
      ], summary: '发现设计和实现问题', evidence: 'review.md#L10',
    }
    const first = await post('/api/agent-workflow/review', body)
    assert.equal(first.status, 200, first.text)
    assert.equal(first.json.task.kind, 'rework')
    assert.equal(first.json.task.reworkKind, 'design')
    assert.equal(first.json.task.round, 1)
    const source = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)
    assert.equal(source.status, 'done')
    const next = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(first.json.task.nextTaskId)
    assert.equal(next.role, 'designer')
    assert.deepEqual(JSON.parse(next.blockedBy), [taskId])
    assert.equal(JSON.parse(next.agent_selection_snapshot).agentToolConfig.providerName, 'designer')
    assert.equal(JSON.parse(next.agent_selection_snapshot).reviewWorkflow.instanceId, rootId)
    assert.deepEqual(JSON.parse(next.agent_selection_snapshot).workflowContext.designArtifacts, snapshot.workflowContext.designArtifacts)
    const replay = await post('/api/agent-workflow/review', body)
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.json.task.replayed, true)
    assert.equal(replay.json.task.nextTaskId, first.json.task.nextTaskId)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent=?').get(taskId).n, 1)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM agent_workflow_reviews WHERE workflow_instance_id=?').get(rootId).n, 1)

    const addReviewAttempt = (id) => mod.db.prepare("INSERT INTO tasks (id, title, priority, status, role, scope, soldier, agent_selection_snapshot) VALUES (?, ?, 'high', 'in_progress', 'reviewer', ?, 'codex', ?)")
      .run(id, `Follow-up review ${id}`, scope, JSON.stringify(snapshot))
    addReviewAttempt('typed-review-implementation-round')
    const implementationReturn = await post('/api/agent-workflow/review', {
      taskId: 'typed-review-implementation-round', by: 'codex', scope,
      findings: [{ kind: 'implementation', summary: '实现漏掉超时边界' }], summary: '实现问题', evidence: 'review.md#L20',
    })
    assert.equal(implementationReturn.status, 200, implementationReturn.text)
    assert.equal(implementationReturn.json.task.reworkKind, 'implementation')
    assert.equal(implementationReturn.json.task.round, 2)
    const coder = mod.db.prepare('SELECT role FROM tasks WHERE id=?').get(implementationReturn.json.task.nextTaskId)
    assert.equal(coder.role, 'coder')
    const coderSnapshot = JSON.parse(mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(implementationReturn.json.task.nextTaskId).agent_selection_snapshot)
    assert.deepEqual(coderSnapshot.workflowContext.designArtifacts, snapshot.workflowContext.designArtifacts)
    assert.equal(coderSnapshot.workflowContext.implementation, null, '实现返工必须丢弃旧提交和测试证据')

    addReviewAttempt('typed-review-limit-round')
    const limited = await post('/api/agent-workflow/review', {
      taskId: 'typed-review-limit-round', by: 'codex', scope,
      findings: [{ kind: 'implementation', summary: '仍有实现遗漏' }], summary: '返工上限验证', evidence: 'review.md#L30',
    })
    assert.equal(limited.status, 200, limited.text)
    assert.equal(limited.json.task.kind, 'rework-limit')
    assert.equal(limited.json.task.round, 2)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent=?').get('typed-review-limit-round').n, 0)

    const history = await get(`/api/agent-workflow/history?taskId=${encodeURIComponent(taskId)}&scope=${encodeURIComponent(scope)}`)
    assert.equal(history.status, 200, history.text)
    assert.equal(history.json.workflowId, rootId)
    assert.deepEqual(history.json.reviews.map((review) => review.kind), ['design', 'implementation'])
    assert.ok(history.json.tasks.some((item) => item.id === taskId))
    assert.ok(history.json.tasks.some((item) => item.id === implementationReturn.json.task.nextTaskId))
  })

  it('跨 Agent 目标按冻结工作流拓扑建链，不受空间 next 顺序和后续配置变化影响', async () => {
    const scope = 'space-independent-agent-workflow'
    await post('/api/spaces', { id: scope, name: '独立 Agent 工作流空间', localDir: process.cwd(), by: 'general' })
    const roster = [
      ['designer', 'Claude 设计师', 0], ['analyst', '普通分析岗', 1],
      ['coder', 'DSH 实现者', 2], ['tester', '并行验证员', 3], ['reviewer', 'Codex 审查员', 4],
    ]
    const insertRoster = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    for (const [role, name, sort] of roster) insertRoster.run(scope, role, name, 'agent', '🤖', sort)
    const roles = ['designer', 'analyst', 'coder', 'tester', 'reviewer']
    const stages = roles.map((role, index) => ({
      role, label: role, prompt: role, next: roles[index + 1] ?? null,
      agentToolConfig: { id: `ordinary.${role}`, version: 7 },
    }))
    const registered = await post('/api/agent-tools/configs', {
      by: 'general', id: 'workflow.designer', version: 1, providerName: 'claude-code', adapter: 'dsh-subagent',
      permissionProfile: 'claude-code-acceptEdits', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
    })
    assert.equal(registered.status, 200, registered.text)
    for (const role of ['analyst', 'coder', 'tester', 'reviewer']) {
      const result = await post('/api/agent-tools/configs', {
        by: 'general', id: `workflow.${role}`, version: 1, providerName: role === 'reviewer' ? 'codex' : 'deepseek', adapter: role === 'reviewer' ? 'dsh-subagent' : 'dsh-native',
        permissionProfile: role === 'reviewer' ? 'codex-workspace-write' : 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
        capabilities: role === 'reviewer'
          ? { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true }
          : { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
      })
      assert.equal(result.status, 200, result.text)
    }
    const nodeConfig = await post('/api/agent-nodes/configs', { id: 'executor-a', label: 'DSH executor A', scope, by: 'general' })
    assert.equal(nodeConfig.status, 200, nodeConfig.text)
    const nodeHeartbeat = await post('/api/agent-nodes/heartbeat', {
      id: 'executor-a', scope, by: 'general', providerNames: ['claude-code', 'deepseek', 'codex'],
      capabilities: {
        isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
        providers: {
          'claude-code': { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'acceptEdits' },
          deepseek: { outputSchema: true, toolFilter: true, cancellation: true },
          codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me' },
        },
      },
    })
    assert.equal(nodeHeartbeat.status, 200, nodeHeartbeat.text)
    assert.equal(nodeHeartbeat.json.task.status, 'ready')
    const workflow = {
      designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2,
      stageTools: Object.fromEntries(['designer', 'coder', 'reviewer'].map((role) => [role, {
        agentToolConfig: { id: `workflow.${role}`, version: 1 }, modelConfig: null, nodeId: 'executor-a',
        ...(role === 'coder' ? { testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } } : {}),
      }])),
    }
    const saved = await post('/api/pipeline', { scope, by: 'general', stages, workflow })
    assert.equal(saved.status, 200, saved.text)
    const malformedWorkflow = await post('/api/pipeline', {
      scope, by: 'general', stages,
      workflow: { ...workflow, stageTools: { ...workflow.stageTools, designer: 'silent-fallback-is-not-allowed' } },
    })
    assert.equal(malformedWorkflow.status, 400)
    assert.deepEqual((await get('/api/pipeline?scope=' + scope)).json.workflow.stageTools.designer.agentToolConfig, { id: 'workflow.designer', version: 1 })
    const goalsBeforeSlice = mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n
    assert.throws(() => mod.publishGoalRecord(scope, 'unsupported slice + agent workflow', 'slice', 'general'), /暂不支持 slice 目标/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n, goalsBeforeSlice, '不兼容模式失败时不留下目标')

    const published = mod.publishGoalRecord(scope, 'Claude → DSH → Codex independent topology', 'chain', 'general')
    const tasks = mod.db.prepare('SELECT * FROM tasks WHERE goalId=? ORDER BY rowid').all(published.goal.id)
    assert.deepEqual(tasks.map((task) => task.role), ['designer', 'coder', 'reviewer'])
    assert.deepEqual(tasks.map((task) => JSON.parse(task.blockedBy)), [[], [tasks[0].id], [tasks[1].id]])
    const designSnapshot = JSON.parse(tasks[0].agent_selection_snapshot)
    const implementationSnapshot = JSON.parse(tasks[1].agent_selection_snapshot)
    const reviewSnapshot = JSON.parse(tasks[2].agent_selection_snapshot)
    assert.equal(designSnapshot.reviewWorkflow.instanceId, published.goal.id)
    assert.equal(designSnapshot.reviewWorkflow.stageTools.designer.agentToolConfig.providerName, 'claude-code')
    assert.equal(designSnapshot.reviewWorkflow.stageDefinitions.designer.next, 'coder', '冻结阶段 next 采用工作流拓扑，不采用普通空间链')
    assert.equal(designSnapshot.reviewWorkflow.stageDefinitions.designer.prompt, 'designer')
    assert.equal(implementationSnapshot.agentToolConfig.providerName, 'deepseek')
    assert.equal(reviewSnapshot.agentToolConfig.providerName, 'codex')
    assert.deepEqual(tasks.map((task) => JSON.parse(task.agent_selection_snapshot).executionNode.id), ['executor-a', 'executor-a', 'executor-a'])
    assert.equal(designSnapshot.reviewWorkflow.stageTools.analyst, undefined, '工作流仅冻结指定三阶段工具')
    const frozenPlan = mod.db.prepare('SELECT stages_json FROM team_plans WHERE scope=? AND goal_id=?').get(scope, published.goal.id)
    assert.equal(JSON.parse(frozenPlan.stages_json)[1].nextRole, 'reviewer')

    const namedDefinition = {
      id: 'workflow.named-closed-loop', version: 1, name: '具名跨 Agent 闭环', description: '由独立定义启动的闭环',
      stages: [
        { id: 'design', role: 'designer', agentToolConfig: { id: 'workflow.designer', version: 1 }, nodeId: 'executor-a', outputContract: { artifacts: ['design.md'] } },
        { id: 'implement', role: 'coder', agentToolConfig: { id: 'workflow.coder', version: 1 }, nodeId: 'executor-a', inputContract: { artifacts: ['design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] }, testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
        { id: 'review', role: 'reviewer', agentToolConfig: { id: 'workflow.reviewer', version: 1 }, nodeId: 'executor-a', inputContract: { artifacts: ['design.md', 'commit', 'test-evidence'] } },
      ],
      edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
      entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
      reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 2,
    }
    const modelProfile = await post('/api/model-profiles', {
      actor: 'general', profile: {
        id: 'model.workflow-coder', displayName: 'Workflow coder model', runtimeType: 'dsh',
        provider: 'custom-ds', model: 'deepseek-coder-v1', reasoningEffort: 'high', limits: {},
      },
    })
    assert.equal(modelProfile.status, 200, modelProfile.text)
    namedDefinition.stages[1].modelConfig = { id: 'model.workflow-coder', version: 1 }
    const savedDefinition = await post('/api/agent-workflows/definitions', { scope, definition: namedDefinition, by: 'general' })
    assert.equal(savedDefinition.status, 200, savedDefinition.text)
    const namedGoal = await post('/api/goal', {
      scope, objective: '通过命名定义执行 Claude → DSH → Codex', by: 'general',
      workflowDefinition: { id: namedDefinition.id, version: namedDefinition.version },
    })
    assert.equal(namedGoal.status, 200, namedGoal.text)
    assert.deepEqual(namedGoal.json.task.workflowDefinition, { id: namedDefinition.id, version: 1 })
    const namedTasks = mod.db.prepare('SELECT * FROM tasks WHERE goalId=? ORDER BY rowid').all(namedGoal.json.task.goal.id)
    assert.deepEqual(namedTasks.map((task) => task.role), ['designer', 'coder', 'reviewer'])
    const namedSnapshot = JSON.parse(namedTasks[0].agent_selection_snapshot).reviewWorkflow
    assert.deepEqual(namedSnapshot.workflowDefinitionRef, { id: namedDefinition.id, version: 1 })
    assert.equal(namedSnapshot.workflowDefinitionSnapshot.id, namedDefinition.id)
    assert.equal(namedSnapshot.workflowDefinitionSnapshot.stages[1].outputContract.artifacts[1], 'test-evidence')
    assert.deepEqual(namedSnapshot.stageToolsById.implement.resolvedModelConfig, {
      id: 'model.workflow-coder', version: 1, provider: 'custom-ds', model: 'deepseek-coder-v1', reasoningEffort: 'high',
    }, '工作流实例冻结具体模型档案版本与无密钥选择字段')
    assert.deepEqual(JSON.parse(namedTasks[1].agent_selection_snapshot).resolvedModelConfig, namedSnapshot.stageToolsById.implement.resolvedModelConfig)

    const changedModelProfile = await fetch(base + '/api/model-profiles/model.workflow-coder', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'general', version: 1, profile: {
        id: 'model.workflow-coder', displayName: 'Workflow coder model v2', runtimeType: 'dsh',
        provider: 'custom-ds', model: 'deepseek-coder-v2', reasoningEffort: 'medium', limits: {},
      } }),
    })
    assert.equal(changedModelProfile.status, 200)
    assert.equal(JSON.parse(namedTasks[1].agent_selection_snapshot).resolvedModelConfig.model, 'deepseek-coder-v1', '既有工作流任务不追随档案后续变更')
    const staleDefinition = await post('/api/agent-workflows/definitions', {
      scope, by: 'general', definition: { ...namedDefinition, version: 2 },
    })
    assert.equal(staleDefinition.status, 200, staleDefinition.text)
    const staleGoalCount = mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n
    const staleGoal = await post('/api/goal', {
      scope, objective: '拒绝使用已变化的模型档案版本', by: 'general',
      workflowDefinition: { id: namedDefinition.id, version: 2 },
    })
    assert.equal(staleGoal.status, 409, staleGoal.text)
    assert.match(staleGoal.text, /模型档案不存在、已删除或版本已变化/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n, staleGoalCount)

    const externalOverride = await post('/api/agent-workflows/definitions', {
      scope, by: 'general', definition: {
        ...namedDefinition, id: 'workflow.external-model-override', version: 1,
        stages: namedDefinition.stages.map((stage, index) => index === 0
          ? { ...stage, modelConfig: { id: 'model.workflow-coder', version: 2 } }
          : { ...stage, modelConfig: null }),
      },
    })
    assert.equal(externalOverride.status, 200, externalOverride.text)
    const externalGoalCount = mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n
    const externalOverrideGoal = await post('/api/goal', {
      scope, objective: '外部 Agent 模型覆盖应具名拒绝', by: 'general',
      workflowDefinition: { id: 'workflow.external-model-override', version: 1 },
    })
    assert.equal(externalOverrideGoal.status, 409, externalOverrideGoal.text)
    assert.match(externalOverrideGoal.text, /外部 Agent provider 不支持模型档案覆盖/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n, externalGoalCount)

    const parallelDefinition = await post('/api/agent-workflows/definitions', {
      scope, by: 'general',
      definition: {
        ...namedDefinition, id: 'workflow.parallel-dag', version: 1,
        stages: [
          ...namedDefinition.stages.slice(0, 2).map((stage, index) => index === 1 ? { ...stage, modelConfig: null } : stage),
          { id: 'test', role: 'coder', agentToolConfig: { id: 'workflow.tester', version: 1 }, nodeId: 'executor-a', inputContract: { artifacts: ['design.md'] }, outputContract: { artifacts: ['test-results'] } },
          namedDefinition.stages[2],
        ],
        edges: [{ from: 'design', to: 'implement' }, { from: 'design', to: 'test' }, { from: 'implement', to: 'review' }, { from: 'test', to: 'review' }],
      },
    })
    assert.equal(parallelDefinition.status, 200, parallelDefinition.text)
    const dagGoal = await post('/api/goal', {
      scope, objective: 'DAG 分支汇合目标', by: 'general',
      workflowDefinition: { id: 'workflow.parallel-dag', version: 1 },
    })
    assert.equal(dagGoal.status, 200, dagGoal.text)
    const dagTasks = mod.db.prepare('SELECT * FROM tasks WHERE goalId=? ORDER BY rowid').all(dagGoal.json.task.goal.id)
    assert.deepEqual(dagTasks.map((task) => task.role), ['designer', 'coder', 'coder', 'reviewer'])
    assert.deepEqual(dagTasks.map((task) => JSON.parse(task.blockedBy)), [[], [dagTasks[0].id], [dagTasks[0].id], [dagTasks[1].id, dagTasks[2].id]])
    assert.deepEqual(dagTasks.map((task) => JSON.parse(task.agent_selection_snapshot).workflowStageId), ['design', 'implement', 'test', 'review'])
    const dagSnapshot = JSON.parse(dagTasks[0].agent_selection_snapshot).reviewWorkflow
    assert.equal(dagSnapshot.stageToolsById.test.agentToolConfig.providerName, 'deepseek')
    assert.deepEqual(dagSnapshot.stageDefinitionsById.review.previousStageIds, ['implement', 'test'])
    const instance = mod.db.prepare('SELECT * FROM agent_workflow_instances WHERE goal_id=?').get(dagGoal.json.task.goal.id)
    assert.equal(instance.status, 'active')
    assert.equal(instance.definition_id, 'workflow.parallel-dag')
    assert.deepEqual(JSON.parse(instance.snapshot_json).workflowDefinitionSnapshot.edges, [
      { from: 'design', to: 'implement' }, { from: 'design', to: 'test' },
      { from: 'implement', to: 'review' }, { from: 'test', to: 'review' },
    ])
    const blockedJoin = await post('/api/claim', { id: dagTasks[3].id, scope, by: 'reviewer', soldier: 'reviewer', agentNodeId: 'executor-a' })
    assert.equal(blockedJoin.status, 400, blockedJoin.text)
    mod.db.prepare('UPDATE tasks SET status=\'done\', artifacts=? WHERE id=?')
      .run(JSON.stringify([{ kind: 'file', path: 'docs/dag/design.md', title: 'Design', digest: 'e'.repeat(64) }]), dagTasks[0].id)
    const dagImplementationAttempt = storeImplementationAttempt(dagTasks[1].id, {
      testCommand: 'npm test', testSummary: 'branch tests passed', testEvidence: 'test evidence', sourceCommit: 'f'.repeat(40),
    })
    mod.db.prepare('UPDATE tasks SET status=\'done\', evidence=? WHERE id=?')
      .run(JSON.stringify([{ text: `agent-workflow-implementation:${JSON.stringify({
        passed: true, sourceCommit: 'f'.repeat(40), stageAttemptId: dagImplementationAttempt.attemptId,
        testVerification: dagImplementationAttempt.testVerification,
        providerRunId: dagImplementationAttempt.providerRunId, testCommand: 'npm test', testSummary: 'branch tests passed', testEvidence: 'test evidence',
      })}` }]), dagTasks[1].id)
    mod.db.prepare("UPDATE tasks SET status='done', artifacts=? WHERE id=?")
      .run(JSON.stringify([{ kind: 'file', path: 'reports/branch-tests.json', title: 'test-results', digest: 'a'.repeat(64) }]), dagTasks[2].id)
    const readyJoin = await post('/api/claim', { id: dagTasks[3].id, scope, by: 'general', soldier: 'codex', agentNodeId: 'executor-a' })
    assert.equal(readyJoin.status, 200, readyJoin.text)
    assert.equal(readyJoin.json.task.agentSelectionSnapshot.workflowStageId, 'review')
    assert.deepEqual(readyJoin.json.task.agentSelectionSnapshot.workflowContext.implementation, {
      taskId: dagTasks[1].id, sourceCommit: 'f'.repeat(40), stageAttemptId: dagImplementationAttempt.attemptId,
      providerRunId: dagImplementationAttempt.providerRunId, testCommand: 'npm test', testSummary: 'branch tests passed', testEvidence: 'test evidence',
      testVerification: dagImplementationAttempt.testVerification,
    })
    assert.equal(readyJoin.json.task.agentSelectionSnapshot.workflowContext.upstreamStages.length, 3, '汇合阶段会收到所有上游分支交接物')
    const dagRework = await post('/api/agent-workflow/review', {
      taskId: dagTasks[3].id, scope, by: 'codex', findings: [{ kind: 'implementation', summary: '实现边界需修复' }],
      summary: 'DAG review', evidence: 'review evidence',
    })
    assert.equal(dagRework.status, 200, dagRework.text)
    const dagReworkTask = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(dagRework.json.task.nextTaskId)
    const dagReworkSnapshot = JSON.parse(dagReworkTask.agent_selection_snapshot)
    assert.equal(dagReworkTask.role, 'coder')
    assert.equal(dagReworkSnapshot.workflowStageId, 'implement')
    assert.equal(dagReworkSnapshot.agentToolConfig.id, 'workflow.coder', '同岗位的多个 stage 通过 stage ID 保留各自工具配置')
    assert.equal(dagRework.json.task.generatedStageTaskIds.length, 2, '实现返工会预建新的下游 review stage')
    const implementationReworkReviewId = dagRework.json.task.generatedStageTaskIds.find((id) => {
      const row = mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(id)
      return JSON.parse(row.agent_selection_snapshot).workflowStageId === 'review'
    })
    assert.ok(implementationReworkReviewId)
    const implementationReworkReview = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(implementationReworkReviewId)
    assert.deepEqual(JSON.parse(implementationReworkReview.blockedBy), [dagReworkTask.id, dagTasks[2].id], 'review 复审汇合新实现与未受影响的已完成测试分支')
    const dagReworkAttempt = storeImplementationAttempt(dagReworkTask.id, {
      testCommand: 'npm test', testSummary: 'reworked tests passed', testEvidence: 'reworked test evidence', sourceCommit: '1'.repeat(40),
    })
    mod.db.prepare('UPDATE tasks SET status=\'done\', evidence=? WHERE id=?')
      .run(JSON.stringify([{ text: `agent-workflow-implementation:${JSON.stringify({
        passed: true, sourceCommit: '1'.repeat(40), stageAttemptId: dagReworkAttempt.attemptId,
        testVerification: dagReworkAttempt.testVerification,
        providerRunId: dagReworkAttempt.providerRunId, testCommand: 'npm test', testSummary: 'reworked tests passed', testEvidence: 'reworked test evidence',
      })}` }]), dagReworkTask.id)
    const secondReviewClaim = await post('/api/claim', {
      id: implementationReworkReviewId, scope, by: 'general', soldier: 'codex', agentNodeId: 'executor-a',
    })
    assert.equal(secondReviewClaim.status, 200, secondReviewClaim.text)
    assert.deepEqual(secondReviewClaim.json.task.agentSelectionSnapshot.workflowContext.implementation, {
      taskId: dagReworkTask.id, sourceCommit: '1'.repeat(40), stageAttemptId: dagReworkAttempt.attemptId,
      providerRunId: dagReworkAttempt.providerRunId, testCommand: 'npm test', testSummary: 'reworked tests passed', testEvidence: 'reworked test evidence',
      testVerification: dagReworkAttempt.testVerification,
    })
    const designRework = await post('/api/agent-workflow/review', {
      taskId: implementationReworkReviewId, scope, by: 'codex', findings: [{ kind: 'design', summary: '方案补充错误处理约定' }],
      summary: 'DAG design finding', evidence: 'review evidence round 2',
    })
    assert.equal(designRework.status, 200, designRework.text)
    assert.equal(designRework.json.task.generatedStageTaskIds.length, 4, '设计返工会重新实例化设计后的全部 DAG 阶段')
    const regeneratedByStage = new Map()
    for (const id of designRework.json.task.generatedStageTaskIds) {
      const row = mod.db.prepare('SELECT role, blockedBy, agent_selection_snapshot FROM tasks WHERE id=?').get(id)
      const snapshot = JSON.parse(row.agent_selection_snapshot)
      regeneratedByStage.set(snapshot.workflowStageId, { id, role: row.role, blockedBy: JSON.parse(row.blockedBy), snapshot })
      assert.equal(snapshot.workflowGenerationId, `review-rework:${implementationReworkReviewId}`)
    }
    assert.deepEqual(regeneratedByStage.get('implement').blockedBy, [designRework.json.task.nextTaskId])
    assert.deepEqual(regeneratedByStage.get('test').blockedBy, [designRework.json.task.nextTaskId])
    assert.deepEqual(regeneratedByStage.get('review').blockedBy, [regeneratedByStage.get('implement').id, regeneratedByStage.get('test').id])

    const registeredV2 = await post('/api/agent-tools/configs', {
      by: 'general', id: 'workflow.designer', version: 2, providerName: 'claude-code', adapter: 'dsh-subagent',
      permissionProfile: 'claude-code-acceptEdits', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
    })
    assert.equal(registeredV2.status, 200, registeredV2.text)
    const changedWorkflow = {
      ...workflow,
      stageTools: { ...workflow.stageTools, designer: { agentToolConfig: { id: 'workflow.designer', version: 2 }, modelConfig: null, nodeId: 'executor-a' } },
    }
    const changed = await post('/api/pipeline', { scope, by: 'general', stages, workflow: changedWorkflow })
    assert.equal(changed.status, 200, changed.text)
    assert.deepEqual((await get('/api/pipeline?scope=' + scope)).json.stages[0].agentToolConfig, { id: 'ordinary.designer', version: 7 }, '闭环工具配置不得改写空间常规阶段工具')
    assert.equal(JSON.parse(tasks[0].agent_selection_snapshot).agentToolConfig.version, 1)
    assert.equal(JSON.parse(tasks[0].agent_selection_snapshot).reviewWorkflow.stageDefinitions.designer.next, 'coder')
    const ordinaryPipelineOnly = await post('/api/pipeline', { scope, by: 'general', stages: [stages[0]], workflow: null })
    assert.equal(ordinaryPipelineOnly.status, 200, ordinaryPipelineOnly.text)
    const reloadedNamedSnapshot = JSON.parse(mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(namedTasks[0].id).agent_selection_snapshot)
    assert.equal(reloadedNamedSnapshot.reviewWorkflow.workflowDefinitionSnapshot.stages[0].agentToolConfig.version, 1, '定义和阶段配置以创建目标时版本冻结')
    assert.equal(reloadedNamedSnapshot.reviewWorkflow.workflowDefinitionRef.id, namedDefinition.id)
    const dynamicSuccessor = await post('/api/create', {
      title: 'Frozen dynamic implementation successor', description: '由设计阶段完成后动态补建',
      priority: 'high', status: 'todo', role: 'coder', scope, goalId: published.goal.id,
      parent: tasks[0].id, blockedBy: [tasks[0].id], by: 'general',
    })
    assert.equal(dynamicSuccessor.status, 200, dynamicSuccessor.text)
    assert.equal(dynamicSuccessor.json.task.agentSelectionSnapshot.source, 'goal-agent-workflow')
    assert.equal(dynamicSuccessor.json.task.agentSelectionSnapshot.agentToolConfig.providerName, 'deepseek')
    assert.equal(dynamicSuccessor.json.task.agentSelectionSnapshot.reviewWorkflow.stageDefinitions.designer.next, 'coder')
    const nodeV2 = await post('/api/agent-nodes/configs', { id: 'executor-a', label: 'DSH executor A updated', scope, by: 'general' })
    assert.equal(nodeV2.status, 200, nodeV2.text)
    assert.equal(nodeV2.json.task.version, 2)
    const nodeHeartbeatV2 = await post('/api/agent-nodes/heartbeat', {
      id: 'executor-a', scope, by: 'general', providerNames: ['claude-code', 'deepseek', 'codex'],
      capabilities: {
        isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
        providers: {
          'claude-code': { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'acceptEdits' },
          deepseek: { outputSchema: true, toolFilter: true, cancellation: true },
          codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me' },
        },
      },
    })
    assert.equal(nodeHeartbeatV2.json.task.status, 'ready')
    assert.equal(JSON.parse(tasks[0].agent_selection_snapshot).executionNode.version, 1, '工作流保留创建目标时冻结的节点配置版本')
    const wrongNodeClaim = await post('/api/claim', { id: tasks[0].id, soldier: 'claude-code', by: 'general', scope, agentNodeId: 'other-node' })
    assert.equal(wrongNodeClaim.status, 409)
    assert.equal(wrongNodeClaim.json.code, 'AGENT_NODE_MISMATCH')
    await post('/api/agent-nodes/heartbeat', {
      id: 'executor-a', scope, by: 'general', providerNames: ['claude-code', 'deepseek', 'codex'],
      capabilities: {
        isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
        providers: {
          'claude-code': { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'dontAsk' },
          deepseek: { outputSchema: true, toolFilter: true, cancellation: true },
          codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me' },
        },
      },
    })
    const wrongPermissionClaim = await post('/api/claim', { id: tasks[0].id, soldier: 'claude-code', by: 'general', scope, agentNodeId: 'executor-a' })
    assert.equal(wrongPermissionClaim.status, 409)
    assert.equal(wrongPermissionClaim.json.code, 'AGENT_NODE_PROVIDER_INCOMPATIBLE')
    await post('/api/agent-nodes/heartbeat', {
      id: 'executor-a', scope, by: 'general', providerNames: ['claude-code', 'deepseek', 'codex'],
      capabilities: {
        isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
        providers: {
          'claude-code': { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'acceptEdits' },
          deepseek: { outputSchema: true, toolFilter: true, cancellation: true },
          codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me' },
        },
      },
    })
    const claimed = await post('/api/claim', { id: tasks[0].id, soldier: 'claude-code', by: 'general', scope, agentNodeId: 'executor-a' })
    assert.equal(claimed.status, 200, claimed.text)
    assert.equal(claimed.json.task.agentSelectionSnapshot.agentToolConfig.version, 1, '目标创建时冻结的 Agent 工具版本优先于当前空间配置')
    const staleAbsoluteDesignArtifact = await post('/api/artifact', {
      id: tasks[0].id, kind: 'file', path: 'C:\\worker\\worktrees\\design\\docs\\design.md',
      title: 'Stale absolute path', digest: 'b'.repeat(64), by: 'claude-code', scope,
    })
    assert.equal(staleAbsoluteDesignArtifact.status, 200, staleAbsoluteDesignArtifact.text)
    const designArtifact = await post('/api/artifact', {
      id: tasks[0].id, kind: 'file', path: 'docs/agent-workflow-independent/design.md',
      title: '设计方案', digest: 'c'.repeat(64), by: 'claude-code', scope,
    })
    assert.equal(designArtifact.status, 200, designArtifact.text)
    const designReview = await post('/api/transition', { id: tasks[0].id, to: 'in_review', by: 'claude-code', scope, force: true })
    assert.equal(designReview.status, 200, designReview.text)
    const designDone = await post('/api/advance', { id: tasks[0].id, by: 'designer', scope })
    assert.equal(designDone.status, 200, designDone.text)
    const implementationClaim = await post('/api/claim', { id: tasks[1].id, soldier: 'deepseek', by: 'general', scope, agentNodeId: 'executor-a' })
    assert.equal(implementationClaim.status, 200, implementationClaim.text)
    assert.equal(implementationClaim.json.task.agentSelectionSnapshot.agentToolConfig.providerName, 'deepseek')
    assert.deepEqual(implementationClaim.json.task.agentSelectionSnapshot.workflowContext.designArtifacts, [{
      taskId: tasks[0].id, path: 'docs/agent-workflow-independent/design.md', digest: 'c'.repeat(64), title: '设计方案',
    }])
    const designUpstream = implementationClaim.json.task.agentSelectionSnapshot.workflowContext.upstreamStages
      .find(stage => stage.taskId === tasks[0].id)
    assert.deepEqual(designUpstream.artifacts.map(({ kind, path, digest }) => ({ kind, path, digest })), [{
      kind: 'file', path: 'docs/agent-workflow-independent/design.md', digest: 'c'.repeat(64),
    }], 'invalid absolute file artifact paths are excluded from the frozen upstream workflow context')
    const implementationAttempt = storeImplementationAttempt(tasks[1].id, {
      testCommand: 'node --test', testSummary: 'tests passed', testEvidence: 'node --test: passed', sourceCommit: 'd'.repeat(40),
    })
    const implementationEvidence = `agent-workflow-implementation:${JSON.stringify({
      passed: true, sourceCommit: 'd'.repeat(40), stageAttemptId: implementationAttempt.attemptId,
      testVerification: implementationAttempt.testVerification,
      providerRunId: implementationAttempt.providerRunId, testCommand: 'node --test', testSummary: 'tests passed', testEvidence: 'node --test: passed',
    })}`
    const savedEvidence = await post('/api/comment', { id: tasks[1].id, by: 'deepseek', scope, isEvidence: true, text: implementationEvidence })
    assert.equal(savedEvidence.status, 200, savedEvidence.text)
    const implementationReview = await post('/api/transition', { id: tasks[1].id, to: 'in_review', by: 'deepseek', scope, force: true })
    assert.equal(implementationReview.status, 200, implementationReview.text)
    const implementationDone = await post('/api/advance', { id: tasks[1].id, by: 'coder', scope })
    assert.equal(implementationDone.status, 200, implementationDone.text)

    const reviewClaim = await post('/api/claim', { id: tasks[2].id, soldier: 'codex', by: 'general', scope, agentNodeId: 'executor-a' })
    assert.equal(reviewClaim.status, 200, reviewClaim.text)
    assert.deepEqual(reviewClaim.json.task.agentSelectionSnapshot.workflowContext.implementation, {
      taskId: tasks[1].id, sourceCommit: 'd'.repeat(40), stageAttemptId: implementationAttempt.attemptId,
      providerRunId: implementationAttempt.providerRunId, testCommand: 'node --test', testSummary: 'tests passed', testEvidence: 'node --test: passed',
      testVerification: implementationAttempt.testVerification,
    })
    const reviewAttempt = await post('/api/agent-workflow/stage-attempts/start', {
      taskId: tasks[2].id, stageId: reviewClaim.json.task.agentSelectionSnapshot.workflowStageId,
      providerName: 'codex', workspaceDir: 'C:/legion/worktrees/review-task',
      idempotencyKey: 'pipeline-review-stage-attempt-1', by: 'codex', scope,
    })
    assert.equal(reviewAttempt.status, 200, reviewAttempt.text)
    const reviewRun = await post('/api/agent-workflow/stage-attempts/report', {
      attemptId: reviewAttempt.json.task.id, providerRunId: 'codex-review-run-1', state: 'running',
      by: 'codex', scope,
    })
    assert.equal(reviewRun.status, 200, reviewRun.text)
    const reviewResult = await post('/api/agent-workflow/stage-attempts/report', {
      attemptId: reviewAttempt.json.task.id, providerRunId: 'codex-review-run-1', state: 'completed',
      stopReason: 'completed', result: {
        status: 'done', summary: '实现审查发现边界问题', evidence: 'review.md#L1',
        review: { passed: false, findings: [{
          kind: 'implementation', summary: '需修复输入边界 Bearer abcdefghijklmnopqrstuvwxyz',
          file: 'src/index.ts', severity: 'major', evidence: '复现条件 Bearer abcdefghijklmnopqrstuvwxyz',
          verification: '补充边界测试', ignored: 'not persisted',
        }, { kind: 'other', summary: 'must be discarded' }], token: 'must not persist' },
      },
      by: 'codex', scope,
    })
    assert.equal(reviewResult.status, 200, reviewResult.text)
    assert.deepEqual(reviewResult.json.task.result.review, {
      passed: false,
      findings: [{ kind: 'implementation', summary: '需修复输入边界 [已脱敏]', file: 'src/index.ts',
        severity: 'major', evidence: '复现条件 [已脱敏]', verification: '补充边界测试' }],
    }, 'Stage Attempt 持久化分类 review finding，同时脱敏并剔除非契约字段')
    const returned = await post('/api/agent-workflow/review', {
      taskId: tasks[2].id, by: 'codex', scope,
      findings: [{ kind: 'implementation', summary: '需要修复实现边界' }],
      summary: '实现问题', evidence: 'review.md#L1',
    })
    assert.equal(returned.status, 200, returned.text)
  const rework = mod.db.prepare('SELECT * FROM tasks WHERE id=?').get(returned.json.task.nextTaskId)
    assert.equal(rework.role, 'coder')
    assert.equal(JSON.parse(rework.agent_selection_snapshot).agentToolConfig.providerName, 'deepseek')
    const dynamicClaim = await post('/api/claim', { id: dynamicSuccessor.json.task.id, soldier: 'deepseek', by: 'general', scope, agentNodeId: 'executor-a' })
    assert.equal(dynamicClaim.status, 200, dynamicClaim.text)
    assert.equal(dynamicClaim.json.task.agentSelectionSnapshot.agentToolConfig.providerName, 'deepseek')
    const publishedInstance = mod.db.prepare('SELECT id FROM agent_workflow_instances WHERE goal_id=?').get(published.goal.id)
    assert.ok(publishedInstance, '工作流目标有独立实例记录')
    const canceledWorkflow = await post('/api/goal/status', { id: published.goal.id, status: 'canceled', by: 'general', scope })
    assert.equal(canceledWorkflow.status, 200, canceledWorkflow.text)
    assert.equal(mod.db.prepare('SELECT status FROM agent_workflow_instances WHERE id=?').get(publishedInstance.id).status, 'canceled')
    assert.ok(canceledWorkflow.json.task.strandedTasks.includes(dynamicSuccessor.json.task.id), '取消会把在办阶段留痕并挂起')
  })

  it('include=active 只回启用阶段；enabled=false 的岗位保留但不进 activeRoles', async () => {
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: stagesFixture().map(s => s.role === 'soldier-selection' ? { ...s, enabled: false } : s),
    })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.task.activeRoles, ['soldier-research', 'soldier-listing'])
    const active = (await get('/api/pipeline?scope=' + S + '&include=active')).json
    assert.deepEqual(active.stages.map(s => s.role), ['soldier-research', 'soldier-listing'])
    const all = (await get('/api/pipeline?scope=' + S)).json
    assert.equal(all.stages.length, 3, '默认含停用阶段（指挥台编辑用）')
    // 复位（后续用例依赖三环都在）
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-03 写入期校验矩阵：非法输入 4xx 且零写入', () => {
  it('role/label/next/gate/docs/runtime/门禁 逐项被拒且文案可读', async () => {
    const good = stagesFixture()
    const matrix = [
      { name: 'stages 非数组', body: { stages: 'x' }, re: /非空数组/ },
      { name: 'stages 空', body: { stages: [] }, re: /非空数组/ },
      { name: 'role 非法', body: { stages: [{ ...good[0], role: 'Soldier X' }] }, re: /role 非法/ },
      { name: 'label 缺失', body: { stages: [{ ...good[0], label: '  ' }] }, re: /label/ },
      { name: 'role 重复', body: { stages: [good[0], { ...good[1], role: good[0].role }] }, re: /重复/ },
      { name: 'next 未知', body: { stages: [{ ...good[0], next: 'ghost-role' }] }, re: /next=ghost-role/ },
      { name: 'gate 无 artifact', body: { stages: [{ ...good[0], gate: true }] }, re: /artifact/ },
      { name: 'docs 绝对路径', body: { stages: [{ ...good[0], docs: ['C:/tmp/x.md'] }] }, re: /相对路径/ },
      { name: 'docs 含 ..', body: { stages: [{ ...good[0], docs: ['a/../../etc/passwd'] }] }, re: /相对路径/ },
      { name: 'docs 非数组', body: { stages: [{ ...good[0], docs: 'a.md' }] }, re: /数组/ },
      { name: 'Agent 工具版本非法', body: { stages: [{ ...good[0], agentToolConfig: { id: 'tool.codex', version: 0 } }] }, re: /agentToolConfig.*正整数/ },
      { name: '模型配置缺版本', body: { stages: [{ ...good[0], modelConfig: { id: 'model.sonnet' } }] }, re: /modelConfig.*正整数/ },
      { name: 'runtime.maxWorkers 越界', body: { stages: good, runtime: { maxWorkers: 99 } }, re: /maxWorkers/ },
      { name: 'scope 非法', body: { scope: 'Space X', stages: good }, re: /scope 非法/ },
      { name: '非 general', body: { stages: good }, by: 'coder', re: /general/ },
    ]
    const snapshot = async () => JSON.stringify((await get('/api/pipeline?scope=' + S)).json.stages)
    const before = await snapshot()
    for (const m of matrix) {
      const r = await post('/api/pipeline', { scope: S, by: m.by ?? 'general', ...m.body })
      assert.equal(r.status, 400, m.name + ' 应 400：' + r.text)
      assert.ok(m.re.test(r.json?.error ?? ''), m.name + ' 文案：' + (r.json?.error ?? r.text))
    }
    assert.equal(await snapshot(), before, '全部非法提交后流水线未变（零写入）')
  })

  it('gate:true + artifact 合法 → 接受（闸门可被校验）', async () => {
    const r = await post('/api/pipeline', {
      scope: S, by: 'general',
      stages: [stagesFixture()[0], { ...stagesFixture()[1], gate: true, artifact: 'docs/REQUIREMENTS.md' }, stagesFixture()[2]],
    })
    assert.equal(r.status, 200, r.text)
    const stage = (await get('/api/pipeline?scope=' + S)).json.stages.find(s => s.role === 'soldier-selection')
    assert.equal(stage.gate, true)
    assert.equal(stage.artifact, 'docs/REQUIREMENTS.md')
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-04 整批覆盖语义：未提交的旧阶段被删除', () => {
  it('提交 2 环 → 旧的第 3 环被 dropped，activeRoles 同步收敛', async () => {
    const two = stagesFixture().slice(0, 2)
    const r = await post('/api/pipeline', { scope: S, by: 'general', stages: two })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.task.dropped, ['soldier-listing'], '未提交阶段被删（整批覆盖语义）')
    const view = (await get('/api/pipeline?scope=' + S)).json
    assert.deepEqual(view.activeRoles, ['soldier-research', 'soldier-selection'])
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ? AND role = ?').get(S, 'soldier-listing').c, 0)
    await post('/api/pipeline', { scope: S, by: 'general', stages: stagesFixture() })
  })
})

describe('TC-SP-P0-05/06 建链：编队 ∩ 流水线 + 阶段名 + 零交集护栏', () => {
  it('入链只含流水线启用岗位（观察员不入链）→ 链全程有人认领，阶段名用流水线 label', async () => {
    const r = await post('/api/goal', { scope: S, objective: '重新跑一次 ozon 选品', by: 'general' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 3, 'observer 不入链（编队 4 人 → 链 3 环）')
    const chain = chainOf(r.json.task.goal.id)
    assert.deepEqual(chain.map(c => c.role), ['soldier-research', 'soldier-selection', 'soldier-listing'])
    assert.ok(!chain.some(c => c.role === 'observer'), '非执行岗不在链上（消除 blockedBy 死锁）')
    assert.match(chain[0].title, /^【需求调研】/, '阶段名取自流水线 label 而不是位置套用的通用标签')
    assert.match(chain[2].title, /^【上架准备】/)
    assert.equal(chain[0].status, 'todo')
    assert.equal(chain[0].soldier, null)
    assert.deepEqual(JSON.parse(chain[0].blockedBy ?? '[]'), [], '首环无依赖')
    assert.deepEqual(JSON.parse(chain[1].blockedBy ?? '[]'), [chain[0].id], '串链依赖')
    assert.deepEqual(JSON.parse(chain[2].blockedBy ?? '[]'), [chain[1].id])
  })

  it('编队与流水线零交集 → 4xx 可读文案，且目标记录一并回滚（零残留）', async () => {
    await post('/api/spaces', { id: 'space-void', name: '零交集空间', by: 'general' })
    mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)').run('space-void', 'solo-worker', '独行侠', 'agent', '🤖', 0)
    await post('/api/pipeline', { scope: 'space-void', by: 'general', stages: [{ role: 'other-role', label: '别的岗位', prompt: '', next: null }] })
    const r = await post('/api/goal', { scope: 'space-void', objective: '不该建出任何链', by: 'general' })
    assert.equal(r.status, 400, r.text)
    assert.match(r.json.error, /交集|流水线/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM goal WHERE scope = ?').get('space-void').c, 0, '目标记录随事务回滚（不产生半个目标）')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE scope = ?').get('space-void').c, 0)
  })

  it('空间未配置流水线时退回全编队建链（向后兼容 software 等既有空间）', async () => {
    await post('/api/spaces', { id: 'space-legacy', name: '未配流水线', by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('space-legacy', 'requirement', '需求官', 'agent', '🤖', 0)
    ins.run('space-legacy', 'coder', '码农', 'agent', '💻', 1)
    const r = await post('/api/goal', { scope: 'space-legacy', objective: '兼容性目标', by: 'general' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.task.stages, 2, '无空间流水线 → 按全编队建链（既有行为不变）')
  })

  it('编队为空的空间仍可发布目标（0 环，保持既有合法行为）', async () => {
    // 回归锚：零交集护栏只应拦「编队有人但流水线全停用」；编队本身为空是既有合法态
    // （先发目标后补编队 / 通知中心冒烟建库），必须仍能发布并留下 goal:publish 审计。
    await post('/api/spaces', { id: 'space-noroster', name: '空编队空间', by: 'general' })
    const r = await post('/api/goal', { scope: 'space-noroster', objective: '空编队目标', by: 'general' })
    assert.equal(r.status, 200, '空编队不应被护栏拦下：' + r.text)
    assert.equal(r.json.task.stages, 0, '链 0 环（编队为空）')
    assert.equal(r.json.task.goal.objective, '空编队目标')
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'goal:publish' AND scope = ?").get('space-noroster').c === 1, 'goal:publish 审计应落库')
  })
})

describe('TC-SP-P0-07 开通预检 GET /api/spaces/provision', () => {
  function makeRepo(name, { git = true, gitignore = true } = {}) {
    const dir = join(tmpRoot, name)
    mkdirSync(dir, { recursive: true })
    if (git) mkdirSync(join(dir, '.git'), { recursive: true })
    if (gitignore) writeFileSync(join(dir, '.gitignore'), '.legion-worktrees/\n', 'utf8')
    return dir
  }

  it('未注册空间：可读报错（400）', async () => {
    const r = await get('/api/spaces/provision?id=Not A Space')
    assert.equal(r.status, 400)
    assert.match(r.json.error, /id 非法/)
  })

  it('预检清单不出现重复 code（pipeline-missing 只报一次，带可执行修复命令）', async () => {
    // 回归锚：编队非空 + 流水线为空时，预检自身的检查项与 pipelineWarnings 会各报一次
    // pipeline-missing；清单是给人照着做的，重复项会让人以为有两件事要修。
    const S = 'space-dupcheck'
    await post('/api/spaces', { id: S, name: '重复项检查', by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run(S, 'requirement', '需求官', 'agent', '🤖', 0)
    const r = await get('/api/spaces/provision?id=' + S)
    assert.equal(r.status, 200, r.text)
    const codes = r.json.checks.map(c => c.code)
    assert.equal(new Set(codes).size, codes.length, '预检清单 code 必须唯一：' + codes.join(','))
    assert.equal(codes.filter(c => c === 'pipeline-missing').length, 1)
    const miss = r.json.checks.find(c => c.code === 'pipeline-missing')
    assert.ok(/seed-pipeline/.test(miss.fix ?? ''), '应给出可执行的修复命令：' + JSON.stringify(miss))
  })

  it('自定义分区键（含下划线）可用：读面不因非规范 scope 而拒绝', async () => {
    // 回归锚：夹具 daemon（scope=__p13fixture__）这类非规范分区键必须能读自己的流水线，
    // 否则会静默回落部署面 rolesFile（排障时极难发现）。
    const r = await get('/api/pipeline?scope=__p13fixture__')
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.stages, [])
    const p = await get('/api/spaces/provision?id=__p13fixture__')
    assert.equal(p.status, 200, p.text)
    assert.ok(p.json.checks.some(c => c.code === 'space-missing'), '未注册只降级为 warn')
    assert.equal(p.json.checks.find(c => c.code === 'space-missing').level, 'warn')
  })

  it('无流水线 + 无守护 + 未绑工作区 → 全部落地为 error/warn 清单（不产生 audit）', async () => {
    await post('/api/spaces', { id: R, name: '预检空间', by: 'general' })
    const auditBefore = mod.db.prepare('SELECT COUNT(*) AS c FROM audit').get().c
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, false)
    const codes = r.json.checks.map(c => c.code)
    for (const want of ['roster-empty', 'pipeline-missing', 'runtime-disabled', 'daemon-offline', 'workspace-unbound']) {
      assert.ok(codes.includes(want), '缺检查项 ' + want + '：' + codes.join(','))
    }
    const p = r.json.checks.find(c => c.code === 'pipeline-missing')
    assert.equal(p.level, 'error')
    assert.ok(p.fix && p.fix.includes('seed-pipeline'), '给出一键修复指引：' + p.fix)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM audit').get().c, auditBefore, '预检是只读的：零 audit')
  })

  it('流水线 + 编队在位 + 守护心跳 + git 工作区 → ok=true，逐项 ok 明细', async () => {
    seedRoster(R)
    await post('/api/pipeline', { scope: R, by: 'general', stages: stagesFixture(), runtime: { enabled: true, maxWorkers: 1 } })
    const repo = makeRepo('repo-ro')
    await post('/api/spaces', { id: R, name: '预检空间', localDir: repo, remoteUrl: 'git@github.com:x/y.git', by: 'general' })
    mod.db.prepare('INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?)').run('soldier-auto@' + R, R, 'worker', new Date().toISOString(), 1)
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.ok, true, '清单：' + JSON.stringify(r.json.checks))
    const ok = new Set(r.json.checks.filter(c => c.level === 'ok').map(c => c.code))
    for (const want of ['pipeline-configured', 'daemon-online', 'workspace-bound', 'queue-visible']) assert.ok(ok.has(want), '缺 ok 项 ' + want)
    assert.equal(r.json.pipeline.activeRoles.length, 3)
  })

  it('工作区存在但非 git、且 .gitignore 未忽略隔离目录 → 分级告警而非 error', async () => {
    const repo = makeRepo('repo-nogit', { git: false, gitignore: false })
    await post('/api/spaces', { id: R, name: '预检空间', localDir: repo, by: 'general' })
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.status, 200, r.text)
    const codes = r.json.checks.map(c => c.code)
    assert.ok(codes.includes('workspace-not-git'), '非 git 工作区应告警：' + codes.join(','))
    assert.equal(r.json.ok, true, '非 git 只是告警（P2 有无仓库模式）')
  })

  it('待办任务 + 守护离线 → queue-stalled 明确点名「队列不会前进」', async () => {
    mod.db.prepare('INSERT INTO members (id, scope, kind, lastSeenAt, online) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lastSeenAt=excluded.lastSeenAt, online=excluded.online').run('soldier-auto@' + R, R, 'worker', '2026-01-01T00:00:00.000Z', 0)
    await post('/api/create', { scope: R, title: '排队任务', role: 'soldier-research', status: 'todo', by: 'general' })
    const r = await get('/api/spaces/provision?id=' + R)
    assert.equal(r.json.ok, false)
    const stalled = r.json.checks.find(c => c.code === 'queue-stalled')
    assert.ok(stalled, '应报 queue-stalled：' + JSON.stringify(r.json.checks.map(c => c.code)))
    assert.match(stalled.message, /队列不会前进/)
  })
})

describe('TC-SP-P0-08 级联：空间删除清理流水线数据', () => {
  it('删除空间 → space_stages/space_runtime 清零，audit 保留', async () => {
    assert.ok(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?').get(R).c > 0)
    const impact = await get('/api/spaces/impact?id=' + R)
    assert.equal(impact.json.counts.spaceStages, 3)
    assert.equal(impact.json.counts.spaceRuntime, 1)
    const del = await post('/api/spaces/delete', { id: R, confirm: 'delete-space:' + R, by: 'general' })
    assert.equal(del.status, 200, del.text)
    assert.equal(del.json.task.removed.spaceStages, 3)
    assert.equal(del.json.task.removed.spaceRuntime, 1)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?').get(R).c, 0)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS c FROM space_runtime WHERE scope = ?').get(R).c, 0)
    assert.ok(mod.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'pipeline:update' AND scope = ?").get(R).c > 0, 'audit 保留')
  })

  it('空间删除后 GET /api/pipeline 回到空态', async () => {
    const r = await get('/api/pipeline?scope=' + R)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.stages, [])
    assert.equal(r.json.runtime.enabled, false)
  })
})

it('Agent 工作流快照与 typed review 台账在 team-hub 重启后可恢复', async () => {
  const dagInstance = mod.db.prepare("SELECT * FROM agent_workflow_instances WHERE scope=? AND definition_id='workflow.parallel-dag'").get('space-independent-agent-workflow')
  assert.ok(dagInstance, '目标发布时会创建独立 workflow instance 记录')
  assert.equal(dagInstance.status, 'active')
  const dagTask = mod.db.prepare('SELECT id FROM tasks WHERE goalId=? ORDER BY rowid LIMIT 1').get(dagInstance.goal_id)
  mod.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(dagTask.id)
  const instanceList = await get('/api/agent-workflow/instances?scope=space-independent-agent-workflow')
  assert.equal(instanceList.status, 200, instanceList.text)
  const listed = instanceList.json.instances.find(item => item.id === dagInstance.id)
  assert.ok(listed, '空间工作流目录可发现已创建实例')
  assert.equal(listed.goalId, dagInstance.goal_id)
  assert.equal(listed.definitionName, '具名跨 Agent 闭环')
  assert.ok(listed.anchorTaskId, '实例列表给出可回读单实例历史的任务锚点')
  assert.equal(listed.counts.total, 10)
  assert.equal(listed.counts.doing, 1, '实例摘要将持久化的 in_progress 状态计入 doing')
  assert.equal(listed.counts.other, 0)
  mod.db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(dagTask.id)
  const filteredPage = await get('/api/agent-workflow/instances?scope=space-independent-agent-workflow&limit=1&offset=0&status=active&search=DAG')
  assert.equal(filteredPage.status, 200, filteredPage.text)
  assert.equal(filteredPage.json.total, 1)
  assert.equal(filteredPage.json.instances[0].id, dagInstance.id)
  assert.equal(filteredPage.json.offset, 0)
  assert.equal(filteredPage.json.limit, 1)
  const hiddenScope = await get('/api/agent-workflow/instances?scope=another-space&search=DAG')
  assert.equal(hiddenScope.status, 200, hiddenScope.text)
  assert.equal(hiddenScope.json.total, 0, '工作流目录严格按空间隔离')
  const instanceBefore = await get(`/api/agent-workflow/history?taskId=${encodeURIComponent(dagTask.id)}&scope=space-independent-agent-workflow`)
  assert.equal(instanceBefore.status, 200, instanceBefore.text)
  assert.equal(instanceBefore.json.instance.definitionId, 'workflow.parallel-dag')
  assert.equal(instanceBefore.json.instance.definitionVersion, 1)
  assert.equal(JSON.parse(dagInstance.snapshot_json).workflowDefinitionSnapshot.edges.length, 4)

  const attemptTaskRow = mod.db.prepare('SELECT id, role, agent_selection_snapshot FROM tasks WHERE goalId=? ORDER BY rowid LIMIT 1 OFFSET 1').get(dagInstance.goal_id)
  const attemptSnapshot = JSON.parse(attemptTaskRow.agent_selection_snapshot)
  mod.db.prepare("UPDATE tasks SET status='in_progress', soldier=role, hold=0 WHERE id=?").run(attemptTaskRow.id)
  const startedAttempt = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: attemptTaskRow.id, stageId: attemptSnapshot.workflowStageId,
    providerName: attemptSnapshot.agentToolConfig?.providerName ?? 'dsh-native',
    workspaceDir: 'C:/legion/worktrees/attempt-task',
    idempotencyKey: 'pipeline-history-stage-attempt-1', by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(startedAttempt.status, 200, startedAttempt.text)
  assert.equal(startedAttempt.json.task.state, 'starting')
  assert.equal(startedAttempt.json.task.attemptNo, 2, '恢复测试继续沿用该阶段已有的成功 Attempt 编号')
  const runAttached = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: startedAttempt.json.task.id, providerRunId: 'dsh-run-persisted-1', state: 'running',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(runAttached.status, 200, runAttached.text)
  const forgedRunReport = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: startedAttempt.json.task.id, providerRunId: 'forged-run', state: 'running',
    by: 'codex', scope: 'space-independent-agent-workflow',
  })
  assert.equal(forgedRunReport.status, 403, '阶段执行身份不能改写别的 worker 的 Run 关联')
  const frozenRunner = attemptSnapshot.reviewWorkflow.stageDefinitionsById[attemptSnapshot.workflowStageId].testRunner
  const testVerification = {
    id: `wft-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
    state: 'passed', sourceCommit: 'c'.repeat(40), stageAttemptId: startedAttempt.json.task.id,
    providerRunId: 'dsh-run-persisted-1', runnerNodeId: attemptSnapshot.executionNode?.id ?? null,
    ...frozenRunner, exitCode: 0, startedAtMs: Date.now() - 20, finishedAtMs: Date.now(),
    outputDigest: 'b'.repeat(64), outputExcerpt: '5 passed', outputTruncated: false, error: null,
  }
  const wrongRunnerReceipt = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: startedAttempt.json.task.id, providerRunId: 'dsh-run-persisted-1', state: 'completed',
    result: { status: 'done', testReport: { passed: true, command: 'npm test', summary: '5 passed', evidence: '5 passed', failures: [] },
      testVerification: { ...testVerification, executable: 'npm' } },
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(wrongRunnerReceipt.status, 409, 'Attempt 不接受与冻结 runner 不匹配的独立测试回执')
  const runFinished = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: startedAttempt.json.task.id, providerRunId: 'dsh-run-persisted-1', state: 'completed',
    stopReason: 'completed', result: {
      status: 'done', summary: 'implemented', evidence: 'tests passed', ignored: 'not persisted',
      testReport: { passed: true, command: [frozenRunner.executable, ...frozenRunner.args].join(' '), summary: '5 passed', evidence: '5 passed; Bearer abcdefghijklmnopqrstuvwxyz', failures: [] },
      testVerification,
      agentTestReport: { passed: true, command: 'npm test', summary: '5 passed', evidence: 'Bearer abcdefghijklmnopqrstuvwxyz', failures: [] },
    },
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(runFinished.status, 200, runFinished.text)
  assert.equal(runFinished.json.task.providerRunId, 'dsh-run-persisted-1')
  assert.deepEqual(runFinished.json.task.result, {
      status: 'done', summary: 'implemented', evidence: 'tests passed',
      testReport: {
        passed: true, command: [frozenRunner.executable, ...frozenRunner.args].join(' '),
        summary: 'Legion 独立测试通过（exit 0）', evidence: '5 passed', failures: [],
      },
      testVerification: { ...testVerification, outputExcerpt: '5 passed' },
      agentTestReport: {
        passed: true, command: 'npm test', summary: '5 passed', evidence: '[已脱敏]', failures: [],
      },
  })
  const overwrittenRun = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: startedAttempt.json.task.id, providerRunId: 'different-run', state: 'completed',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(overwrittenRun.status, 409, '已持久化的 provider Run 身份不可覆盖')
  const idempotentAttempt = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: attemptTaskRow.id, stageId: attemptSnapshot.workflowStageId,
    providerName: attemptSnapshot.agentToolConfig?.providerName ?? 'dsh-native',
    workspaceDir: 'C:/legion/worktrees/attempt-task',
    idempotencyKey: 'pipeline-history-stage-attempt-1', by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(idempotentAttempt.json.task.id, startedAttempt.json.task.id, '重复 start 请求不能创建第二次真实调用记录')
  const unknownAttempt = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: attemptTaskRow.id, stageId: attemptSnapshot.workflowStageId,
    providerName: attemptSnapshot.agentToolConfig?.providerName ?? 'dsh-native',
    workspaceDir: 'C:/legion/worktrees/attempt-task',
    idempotencyKey: 'pipeline-history-stage-attempt-2', by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(unknownAttempt.status, 200, unknownAttempt.text)
  assert.equal(unknownAttempt.json.task.attemptNo, 3)
  const unknownResult = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: unknownAttempt.json.task.id, providerRunId: 'dsh-run-unknown-2', state: 'unknown',
    stopReason: 'worker-timeout', error: 'worker timed out before final response',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(unknownResult.status, 200, unknownResult.text)
  assert.equal(unknownResult.json.task.finishedAtMs, null, '未知结果尚未被对账为终态')
  const reconcileForbidden = await post('/api/agent-workflow/stage-attempts/reconcile', {
    attemptId: unknownAttempt.json.task.id, disposition: 'confirmed-stopped', note: 'worker 自报进程停止',
    idempotencyKey: 'manual-reconcile-unknown-2', by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(reconcileForbidden.status, 403, 'Agent worker 不能替用户核对自己的未知结果')
  const beforeReconciliationTaskStatus = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(attemptTaskRow.id).status
  const reconciliationBody = {
    attemptId: unknownAttempt.json.task.id, disposition: 'confirmed-stopped', note: '已通过宿主进程清单确认子进程退出',
    idempotencyKey: 'manual-reconcile-unknown-2', by: 'general', scope: 'space-independent-agent-workflow',
  }
  const reconciliation = await post('/api/agent-workflow/stage-attempts/reconcile', reconciliationBody)
  assert.equal(reconciliation.status, 200, reconciliation.text)
  assert.equal(reconciliation.json.task.attemptId, unknownAttempt.json.task.id)
  assert.equal(reconciliation.json.task.disposition, 'confirmed-stopped')
  assert.equal(reconciliation.json.task.idempotent, false)
  const reconciliationReplay = await post('/api/agent-workflow/stage-attempts/reconcile', reconciliationBody)
  assert.equal(reconciliationReplay.status, 200, reconciliationReplay.text)
  assert.equal(reconciliationReplay.json.task.id, reconciliation.json.task.id)
  assert.equal(reconciliationReplay.json.task.idempotent, true, '重复提交只回读同一条人工核对事件')
  assert.equal(mod.db.prepare('SELECT state FROM agent_workflow_stage_attempts WHERE id=?').get(unknownAttempt.json.task.id).state, 'unknown',
    '人工核对不能伪造 provider 终态')
  assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(attemptTaskRow.id).status, beforeReconciliationTaskStatus,
    '人工核对不会改变任务状态或自动重派')
  const conflictingReconciliationReplay = await post('/api/agent-workflow/stage-attempts/reconcile', {
    ...reconciliationBody, note: '不同依据但复用幂等键',
  })
  assert.equal(conflictingReconciliationReplay.status, 409, '同幂等键不能改写已记录的核对事实')
  const unknownRetry = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: unknownAttempt.json.task.id, providerRunId: 'dsh-run-unknown-2', state: 'running',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(unknownRetry.status, 409, '未知结果不能假装回到运行中')
  const canceledAttempt = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: attemptTaskRow.id, stageId: attemptSnapshot.workflowStageId,
    providerName: attemptSnapshot.agentToolConfig?.providerName ?? 'dsh-native',
    workspaceDir: 'C:/legion/worktrees/attempt-task',
    idempotencyKey: 'pipeline-history-stage-attempt-3', by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(canceledAttempt.status, 200, canceledAttempt.text)
  const canceledRunning = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: canceledAttempt.json.task.id, providerRunId: 'dsh-run-canceled-3', state: 'running',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(canceledRunning.status, 200, canceledRunning.text)
  const canceledResult = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: canceledAttempt.json.task.id, providerRunId: 'dsh-run-canceled-3', state: 'canceled', stopReason: 'cancelled',
    by: attemptTaskRow.role, scope: 'space-independent-agent-workflow',
  })
  assert.equal(canceledResult.status, 200, canceledResult.text)
  assert.equal(canceledResult.json.task.state, 'canceled')
  assert.ok(canceledResult.json.task.finishedAtMs > 0, '确认取消属于终态并保存结算时间')

  mod.setGoalState(dagInstance.goal_id, 'paused', 'general')
  assert.equal(mod.db.prepare('SELECT status FROM agent_workflow_instances WHERE id=?').get(dagInstance.id).status, 'paused')
  const pausedPage = await get('/api/agent-workflow/instances?scope=space-independent-agent-workflow&status=paused&search=DAG')
  assert.equal(pausedPage.json.total, 1)
  assert.equal(pausedPage.json.instances[0].id, dagInstance.id)
  mod.setGoalState(dagInstance.goal_id, 'active', 'general')
  assert.equal(mod.db.prepare('SELECT status FROM agent_workflow_instances WHERE id=?').get(dagInstance.id).status, 'active')

  const before = await get('/api/agent-workflow/history?taskId=typed-review-source&scope=space-reviewflow')
  assert.equal(before.status, 200, before.text)
  assert.equal(before.json.reviews.length, 2)
  const reworkId = before.json.reviews[0].nextTaskId

  mod.server.closeAllConnections?.()
  await new Promise((resolve, reject) => mod.server.close((error) => error ? reject(error) : resolve()))
  mod.db.close()

  mod = await import(`./server.mjs?workflow-restart=${Date.now()}`)
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port

  const after = await get('/api/agent-workflow/history?taskId=typed-review-source&scope=space-reviewflow')
  assert.equal(after.status, 200, after.text)
  assert.equal(after.json.workflowId, before.json.workflowId)
  assert.deepEqual(after.json.reviews, before.json.reviews)
  const reviewAttemptRow = mod.db.prepare('SELECT id, task_id, scope FROM agent_workflow_stage_attempts WHERE idempotency_key=?')
    .get('pipeline-review-stage-attempt-1')
  assert.ok(reviewAttemptRow, 'reviewer Stage Attempt survives Hub restart')
  const reviewAttemptHistory = await get(`/api/agent-workflow/history?taskId=${encodeURIComponent(reviewAttemptRow.task_id)}&scope=${encodeURIComponent(reviewAttemptRow.scope)}`)
  assert.equal(reviewAttemptHistory.status, 200, reviewAttemptHistory.text)
  const persistedReviewAttempt = reviewAttemptHistory.json.stageAttempts.find(attempt => attempt.id === reviewAttemptRow.id)
  assert.ok(persistedReviewAttempt)
  assert.equal(persistedReviewAttempt.providerRunId, 'codex-review-run-1')
  assert.equal(persistedReviewAttempt.state, 'completed')
  assert.deepEqual(persistedReviewAttempt.result.review, {
    passed: false,
    findings: [{ kind: 'implementation', summary: '需修复输入边界 [已脱敏]', file: 'src/index.ts',
      severity: 'major', evidence: '复现条件 [已脱敏]', verification: '补充边界测试' }],
  }, 'Hub 重启后按 Stage Attempt 历史恢复脱敏后的结构化 review finding')
  const instanceAfter = await get(`/api/agent-workflow/history?taskId=${encodeURIComponent(dagTask.id)}&scope=space-independent-agent-workflow`)
  assert.equal(instanceAfter.status, 200, instanceAfter.text)
  assert.equal(instanceAfter.json.instance.id, instanceBefore.json.instance.id)
  assert.equal(instanceAfter.json.instance.status, 'active')
  assert.equal(instanceAfter.json.instance.definitionId, instanceBefore.json.instance.definitionId)
  assert.equal(instanceAfter.json.tasks.length, 10, 'DAG 的原始分支、实现返工与设计返工 stage task 及快照在重启后可恢复')
  const attemptHistory = await get(`/api/agent-workflow/history?taskId=${encodeURIComponent(attemptTaskRow.id)}&scope=space-independent-agent-workflow`)
  assert.equal(attemptHistory.status, 200, attemptHistory.text)
  const attemptsById = new Map(attemptHistory.json.stageAttempts.map(attempt => [attempt.id, attempt]))
  const persistedAttempt = attemptsById.get(startedAttempt.json.task.id)
  assert.ok(persistedAttempt, '重启后的工作流历史包含刚完成的阶段 Attempt')
  assert.equal(persistedAttempt.workspaceDir, 'C:/legion/worktrees/attempt-task')
  assert.equal(persistedAttempt.providerRunId, 'dsh-run-persisted-1')
  assert.equal(persistedAttempt.state, 'completed')
  assert.equal(persistedAttempt.result.evidence, 'tests passed')
  assert.equal(persistedAttempt.result.testReport.command, [frozenRunner.executable, ...frozenRunner.args].join(' '))
  assert.equal(persistedAttempt.result.testReport.summary, 'Legion 独立测试通过（exit 0）')
  assert.equal(persistedAttempt.result.testReport.evidence, '5 passed', 'Hub derives test evidence from the independent receipt, not the provider report')
  assert.equal(persistedAttempt.result.testVerification.id, testVerification.id)
  assert.equal(persistedAttempt.result.testVerification.sourceCommit, 'c'.repeat(40))
  const persistedUnknownAttempt = attemptsById.get(unknownAttempt.json.task.id)
  assert.ok(persistedUnknownAttempt, '重启后的工作流历史包含未知结果 Attempt')
  assert.equal(persistedUnknownAttempt.providerRunId, 'dsh-run-unknown-2')
  assert.equal(persistedUnknownAttempt.state, 'unknown')
  const persistedReconciliation = attemptHistory.json.reconciliations.find(item => item.id === reconciliation.json.task.id)
  assert.ok(persistedReconciliation, 'Hub 重启后工作流历史保留人工核对事件')
  assert.equal(persistedReconciliation.disposition, 'confirmed-stopped')
  assert.equal(persistedReconciliation.note, '已通过宿主进程清单确认子进程退出')
  const persistedCanceledAttempt = attemptsById.get(canceledAttempt.json.task.id)
  assert.ok(persistedCanceledAttempt, '重启后的工作流历史包含已确认取消 Attempt')
  assert.equal(persistedCanceledAttempt.providerRunId, 'dsh-run-canceled-3')
  assert.equal(persistedCanceledAttempt.state, 'canceled')
  mod.db.prepare("UPDATE tasks SET status='done' WHERE goalId=?").run(dagInstance.goal_id)
  assert.equal(mod.settleGoalsOfScope('space-independent-agent-workflow'), 1)
  assert.equal(mod.db.prepare('SELECT status FROM agent_workflow_instances WHERE id=?').get(dagInstance.id).status, 'done')
  const rework = after.json.tasks.find((task) => task.id === reworkId)
  assert.ok(rework, '待执行返工任务应从持久库恢复')
  assert.equal(rework.status, 'todo')
  assert.equal(rework.agentSelectionSnapshot.stageRole, 'designer')
  assert.deepEqual(rework.agentSelectionSnapshot.workflowContext.designArtifacts, [{
    taskId: 'typed-review-design-root', path: 'docs/review-flow/design.md', digest: 'a'.repeat(64), title: 'Design',
  }])

  // A boot-time worker orphan with a frozen workflow snapshot may already have
  // produced external side effects. It must be held for reconciliation, never
  // sent back to todo for an automatic duplicate Agent invocation.
  mod.db.prepare(`UPDATE tasks SET status='in_progress', hold=0, soldier='designer', claimedAt=?,
    updatedAt=?, claimedRound=1, ttlMinutes=60, expiresAt=?, claimRequestId='workflow-orphan-test' WHERE id=?`)
    .run(new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), dagTask.id)
  const orphanSnapshot = JSON.parse(mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(dagTask.id).agent_selection_snapshot)
  const orphanAttemptStart = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: dagTask.id, stageId: orphanSnapshot.workflowStageId,
    providerName: orphanSnapshot.agentToolConfig?.providerName ?? 'dsh-native',
    workspaceDir: 'C:/legion/worktrees/orphan-task',
    idempotencyKey: 'workflow-orphan-live-attempt', by: 'designer', scope: 'space-independent-agent-workflow',
  })
  assert.equal(orphanAttemptStart.status, 200, orphanAttemptStart.text)
  const orphanAttemptRunning = await post('/api/agent-workflow/stage-attempts/report', {
    attemptId: orphanAttemptStart.json.task.id, providerRunId: 'dsh-orphan-run-1', state: 'running',
    by: 'designer', scope: 'space-independent-agent-workflow',
  })
  assert.equal(orphanAttemptRunning.status, 200, orphanAttemptRunning.text)
  const recovered = await post('/api/release-stale', {
    by: 'general', scope: 'space-independent-agent-workflow', olderThan: 1, ids: [dagTask.id],
  })
  assert.equal(recovered.status, 200, recovered.text)
  assert.deepEqual(recovered.json.task.released, [])
  assert.deepEqual(recovered.json.task.quarantined, [dagTask.id])
  const orphan = mod.db.prepare('SELECT status, hold, soldier, claimedAt, claimedRound, ttlMinutes, expiresAt, claimRequestId, comments FROM tasks WHERE id=?').get(dagTask.id)
  assert.equal(orphan.status, 'in_review')
  assert.equal(orphan.hold, 1)
  assert.equal(orphan.soldier, null)
  assert.equal(orphan.claimedAt, null)
  assert.equal(orphan.claimedRound, null)
  assert.equal(orphan.ttlMinutes, null)
  assert.equal(orphan.expiresAt, null)
  assert.equal(orphan.claimRequestId, null)
  assert.match(JSON.parse(orphan.comments).at(-1).text, /结果未知.*不自动重派/)
  const orphanAttempt = mod.db.prepare('SELECT provider_run_id, state, stop_reason FROM agent_workflow_stage_attempts WHERE id=?').get(orphanAttemptStart.json.task.id)
  assert.equal(orphanAttempt.provider_run_id, 'dsh-orphan-run-1')
  assert.equal(orphanAttempt.state, 'unknown', 'Hub 重启回收同时把未终结的 provider Attempt 标记为结果未知')
  assert.equal(orphanAttempt.stop_reason, 'worker-restarted')
})
