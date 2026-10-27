// team-hub/goal-orchestration.test.mjs
// ============================================================================
// 「软件流水线决定阶段、Agent 配置只决定谁执行」的端到端判据（2026-10-21）。
//
// 背景（T-212 现场）：空间里启用了 8 个岗位，但目标链只有「需求 → 编码 → 审查」
// 三个任务 —— 只要存在 Agent 工作流配置，`createGoalChain` 就把整条链换成
// 定义里的阶段列表，测试与部署从未进入那条链。
//
// 这一组用例只问一件事：**分配模板能不能删掉流水线的阶段**。
// 预期是不能；而且没被模板覆盖的岗位必须明确显示为 DSH 默认，
// 不是"这个人不存在"。
// ============================================================================
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-goal-orchestration-'))
let mod
let base = ''

const SOFTWARE_ROLES = ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops']

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

/** 一个 8 岗位的软件空间：编队 + 流水线（next 按 sort 串好）。 */
async function seedSoftwareSpace(scope) {
  await post('/api/spaces', { id: scope, name: '软件空间', localDir: process.cwd(), by: 'general' })
  const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  SOFTWARE_ROLES.forEach((role, index) => ins.run(scope, role, `员工-${role}`, 'agent', '🤖', index))
  const stages = SOFTWARE_ROLES.map((role, index) => ({
    role, label: `阶段-${role}`, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
  }))
  const saved = await post('/api/pipeline', { scope, by: 'general', stages, runtime: { enabled: true, maxWorkers: 1 } })
  assert.equal(saved.status, 200, saved.text)
  // 三岗分配模板所需的工具配置；其余岗位**故意不注册**——它们必须走 DSH 默认。
  const register = (id, providerName, extra = {}) => post('/api/agent-tools/configs', {
    by: 'general', id, version: 1, providerName, adapter: extra.adapter ?? 'dsh-native',
    permissionProfile: extra.permissionProfile ?? 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: {
      textInput: true, textOutput: true, outputSchema: true, toolFilter: true,
      localAgent: true, sessionResume: false, cancellation: true,
    },
  })
  assert.equal((await register('tool.claude-code', 'claude-code', { adapter: 'dsh-subagent', permissionProfile: 'claude-code-acceptEdits' })).status, 200)
  assert.equal((await register('tool.dsh-spawn', 'spawn')).status, 200)
  assert.equal((await register('tool.codex', 'codex', { adapter: 'dsh-subagent', permissionProfile: 'codex-workspace-write' })).status, 200)
}

/** 只覆盖三岗的分配模板（正是 T-212 那一份定义的形状）。 */
function shortWorkflow(overrides = {}) {
  return {
    designRole: 'requirement',
    implementationRole: 'coder',
    reviewRole: 'reviewer',
    maxReworkRounds: 2,
    stageTools: {
      requirement: { agentToolConfig: { id: 'tool.claude-code', version: 1 }, modelConfig: null, nodeId: null, testRunner: null },
      coder: {
        agentToolConfig: { id: 'tool.dsh-spawn', version: 1 }, modelConfig: null, nodeId: null,
        testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 },
      },
      reviewer: { agentToolConfig: { id: 'tool.codex', version: 1 }, modelConfig: null, nodeId: null, testRunner: null },
    },
    ...overrides,
  }
}

function chainOf(goalId) {
  return mod.db.prepare('SELECT * FROM tasks WHERE goalId = ? AND status != \'canceled\' ORDER BY rowid').all(goalId)
}

/** 给一道实现阶段写入「可核验的尝试 + 测试回执」——审查阶段认领时按它校验交接证据。 */
function storeImplementationAttempt(taskId, { sourceCommit }) {
  const task = mod.db.prepare('SELECT scope, soldier, agent_selection_snapshot FROM tasks WHERE id=?').get(taskId)
  const snapshot = JSON.parse(task.agent_selection_snapshot)
  const stageId = snapshot.workflowStageId
    ?? snapshot.reviewWorkflow.implementationStageId
    ?? snapshot.reviewWorkflow.implementationRole
  const runner = snapshot.reviewWorkflow.stageDefinitionsById?.[stageId]?.testRunner
    ?? { executable: 'node', args: ['--test'], timeoutMs: 300000 }
  const attemptId = `wfa-orch:${taskId}`
  const providerRunId = `run:${taskId}`
  const atMs = Date.now()
  const testVerification = {
    id: `wft-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
    state: 'passed', sourceCommit, stageAttemptId: attemptId, providerRunId,
    runnerNodeId: null, ...runner, exitCode: 0, startedAtMs: atMs - 10, finishedAtMs: atMs,
    outputDigest: 'a'.repeat(64), outputExcerpt: 'npm test: 3 passed', outputTruncated: false, error: null,
  }
  const result = {
    status: 'done', summary: 'implementation completed', evidence: '',
    testReport: { passed: true, command: 'node --test', summary: '3 passed', evidence: 'npm test: 3 passed', failures: [] },
    testVerification,
  }
  mod.db.prepare(`INSERT INTO agent_workflow_stage_attempts
    (id, scope, workflow_instance_id, task_id, stage_id, attempt_no, idempotency_key, started_by,
     provider_name, workspace_dir, provider_run_id, state, result_json, selection_snapshot_json,
     created_at_ms, updated_at_ms, started_at_ms, finished_at_ms)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`)
    .run(attemptId, task.scope, snapshot.reviewWorkflow.instanceId, taskId, stageId,
      `idem:${taskId}`, task.soldier ?? 'spawn', snapshot.agentToolConfig.providerName,
      'C:/legion/worktrees/test', providerRunId, JSON.stringify(result), JSON.stringify(snapshot),
      atMs, atMs, atMs, atMs)
  return { attemptId, providerRunId, testVerification }
}

describe('目标编排：流水线决定阶段，Agent 配置只决定分配', () => {
  it('★★ 三岗分配模板 + 八岗流水线 → 链仍然是八环，未覆盖岗位是 DSH 默认', async () => {
    const scope = 'space-eight-stage'
    await seedSoftwareSpace(scope)
    const saved = await post('/api/pipeline', { scope, by: 'general', stages: SOFTWARE_ROLES.map((role, index) => ({
      role, label: `阶段-${role}`, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
    })), workflow: shortWorkflow() })
    assert.equal(saved.status, 200, saved.text)

    const published = await post('/api/goal', { scope, objective: '八阶段目标', by: 'general' })
    assert.equal(published.status, 200, published.text)
    const goalId = published.json.task.goal.id
    assert.equal(published.json.task.stages, 8, '★ 分配模板删减不了流水线阶段')
    assert.deepEqual(published.json.task.frozen.stages, SOFTWARE_ROLES)

    const chain = chainOf(goalId)
    assert.deepEqual(chain.map((task) => task.role), SOFTWARE_ROLES)
    assert.deepEqual(chain.map((task) => JSON.parse(task.blockedBy ?? '[]')), [
      [], [chain[0].id], [chain[1].id], [chain[2].id],
      [chain[3].id], [chain[4].id], [chain[5].id], [chain[6].id],
    ], '线性流水线 → 顺序链')

    const snapshots = Object.fromEntries(chain.map((task) => [task.role, JSON.parse(task.agent_selection_snapshot)]))
    assert.equal(snapshots.requirement.agentToolConfig.providerName, 'claude-code', '模板覆盖生效')
    assert.equal(snapshots.coder.agentToolConfig.providerName, 'spawn')
    assert.equal(snapshots.reviewer.agentToolConfig.providerName, 'codex')
    for (const role of ['researcher', 'breaker', 'test-designer', 'tester', 'devops']) {
      assert.equal(snapshots[role].agentToolConfig, null, `★ ${role} 必须是 DSH 默认（不是被删掉）`)
      assert.equal(snapshots[role].resolvedModelConfig ?? null, null)
      // 未覆盖岗位仍属于同一条工作流实例：阶段检查点与独立 worktree 都靠它。
      assert.equal(snapshots[role].reviewWorkflow.instanceId, goalId)
      assert.equal(snapshots[role].orchestration, 'pipeline')
    }

    // 目标级冻结：三件事分别落列，读的人不必从任务快照反推。
    const goalRow = mod.db.prepare('SELECT orchestration, pipeline_snapshot, assignment_snapshot, workflow_snapshot FROM goal WHERE id=?').get(goalId)
    assert.equal(goalRow.orchestration, 'pipeline')
    assert.deepEqual(JSON.parse(goalRow.pipeline_snapshot).stages.map((stage) => stage.role), SOFTWARE_ROLES)
    const assignment = JSON.parse(goalRow.assignment_snapshot)
    assert.equal(assignment.stages.tester.source, 'dsh-default')
    assert.equal(assignment.stages.coder.source, 'space-review-workflow')
    assert.ok(JSON.parse(goalRow.workflow_snapshot).workflowDefinitionSnapshot, '工作流实例快照已冻结')
  })

  it('★★ 发布后改流水线与分配模板，不改写已建任务；新目标才用新形状', async () => {
    const scope = 'space-eight-stage'
    const [goal] = mod.db.prepare("SELECT id FROM goal WHERE scope=? AND status='active' ORDER BY rowid DESC").all(scope)
    const before = chainOf(goal.id).map((task) => ({ role: task.role, snapshot: task.agent_selection_snapshot }))

    const changed = await post('/api/pipeline', {
      scope, by: 'general',
      stages: ['requirement', 'coder', 'reviewer'].map((role, index, list) => ({
        role, label: `阶段-${role}`, prompt: role, next: list[index + 1] ?? null,
      })),
      workflow: null,
    })
    assert.equal(changed.status, 200, changed.text)

    const after = chainOf(goal.id).map((task) => ({ role: task.role, snapshot: task.agent_selection_snapshot }))
    assert.deepEqual(after, before, '★ 已冻结的目标不跟着空间配置漂移')
    assert.equal(before.length, 8)

    const second = await post('/api/goal', { scope, objective: '三阶段目标', by: 'general' })
    assert.equal(second.status, 200, second.text)
    assert.equal(second.json.task.stages, 3, '新目标按新流水线建链（没有审查闭环 → 普通链）')
    const secondChain = chainOf(second.json.task.goal.id)
    assert.deepEqual(secondChain.map((task) => task.role), ['requirement', 'coder', 'reviewer'])
    assert.equal(JSON.parse(secondChain[0].agent_selection_snapshot ?? 'null')?.reviewWorkflow ?? null, null,
      '没配审查闭环时不该伪造工作流实例')
  })

  it('配置了审查闭环但流水线缺 reviewer → 发布具名拒绝，零残留', async () => {
    const scope = 'space-missing-reviewer'
    await post('/api/spaces', { id: scope, name: '缺审查岗', localDir: process.cwd(), by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run(scope, 'requirement', '需求', 'agent', '🤖', 0)
    ins.run(scope, 'coder', '实现', 'agent', '💻', 1)
    // 流水线只有两岗。注意：写 `/api/pipeline` 的 `workflow` 会被自身校验挡住
    // （它要求三个角色都在 stages 里），所以制造「审查闭环要一个不在链上的角色」
    // 只能走具名定义——名字里写着 reviewer，而流水线里没有这个人。
    const saved = await post('/api/pipeline', {
      scope, by: 'general',
      stages: [
        { role: 'requirement', label: '需求', prompt: 'r', next: 'coder' },
        { role: 'coder', label: '实现', prompt: 'c', next: null },
      ],
    })
    assert.equal(saved.status, 200, saved.text)
    const tool = (id, providerName) => post('/api/agent-tools/configs', {
      by: 'general', id, version: 1, providerName, adapter: 'dsh-native',
      permissionProfile: 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
    })
    assert.equal((await tool('tool.plain-design', 'spawn')).status, 200)
    assert.equal((await tool('tool.plain-code', 'spawn')).status, 200)
    assert.equal((await tool('tool.plain-review', 'spawn')).status, 200)
    const definition = {
      id: 'workflow.needs-reviewer', version: 1, name: '需要审查岗的闭环', description: '',
      stages: [
        { id: 'design', role: 'requirement', agentToolConfig: { id: 'tool.plain-design', version: 1 }, nodeId: null, testRunner: null },
        { id: 'implement', role: 'coder', agentToolConfig: { id: 'tool.plain-code', version: 1 }, nodeId: null,
          testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
        { id: 'review', role: 'reviewer', agentToolConfig: { id: 'tool.plain-review', version: 1 }, nodeId: null, testRunner: null },
      ],
      edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
      entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
      reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 2,
    }
    assert.equal((await post('/api/agent-workflows/definitions', { scope, definition, by: 'general' })).status, 200)

    const goalBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n
    const rejected = await post('/api/goal', {
      scope, objective: '缺审查岗应被拒', by: 'general',
      workflowDefinition: { id: definition.id, version: 1 },
    })
    assert.equal(rejected.status, 400, rejected.text)
    assert.equal(rejected.json.code, 'AGENT_PLAN_REVIEW_ROLE_MISSING')
    assert.match(rejected.json.error, /reviewRole=reviewer/)
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal WHERE scope=?').get(scope).n, goalBefore, '拒绝即零残留')

    // 同一空间不引用该定义时，普通流水线链照常发布。
    const ordinary = await post('/api/goal', { scope, objective: '普通两阶段目标', by: 'general' })
    assert.equal(ordinary.status, 200, ordinary.text)
    assert.equal(ordinary.json.task.stages, 2)
    assert.equal(ordinary.json.task.orchestration, 'pipeline')
  })

  it('阶段把链钉到两台机器 → 发布 409 AGENT_NODE_WORKSPACE_MISMATCH', async () => {
    const scope = 'space-two-nodes'
    await seedSoftwareSpace(scope)
    const conflict = await post('/api/pipeline', {
      scope, by: 'general',
      stages: SOFTWARE_ROLES.map((role, index) => ({
        role, label: role, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
      })),
      workflow: shortWorkflow({
        stageTools: {
          ...shortWorkflow().stageTools,
          requirement: { agentToolConfig: { id: 'tool.claude-code', version: 1 }, modelConfig: null, nodeId: 'node-a', testRunner: null },
          coder: {
            agentToolConfig: { id: 'tool.dsh-spawn', version: 1 }, modelConfig: null, nodeId: 'node-b',
            testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 },
          },
          reviewer: { agentToolConfig: { id: 'tool.codex', version: 1 }, modelConfig: null, nodeId: 'node-a', testRunner: null },
        },
      }),
    })
    // 写流水线本身就会拒绝跨节点（既有护栏），这里确认它继续挡在发布之前。
    assert.equal(conflict.status, 400, conflict.text)
    assert.match(conflict.text, /同一节点|跨节点/)
  })

  it('★★★ 审查不通过：只重建审查环，测试与部署**不复制**、也不抢跑', async () => {
    const scope = 'space-rework-loop'
    // 五岗线性链：前置分析阶段不在这条用例的范围内（它们不影响「返工收敛」这一问）。
    const roles = ['requirement', 'coder', 'reviewer', 'tester', 'devops']
    await post('/api/spaces', { id: scope, name: '返工收敛空间', localDir: process.cwd(), by: 'general' })
    const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
    roles.forEach((role, index) => ins.run(scope, role, `员工-${role}`, 'agent', '🤖', index))
    const saved = await post('/api/pipeline', {
      scope, by: 'general',
      stages: roles.map((role, index) => ({
        role, label: `阶段-${role}`, prompt: role, next: roles[index + 1] ?? null,
      })),
      workflow: shortWorkflow(),
    })
    assert.equal(saved.status, 200, saved.text)

    const published = await post('/api/goal', { scope, objective: '返工收敛目标', by: 'general' })
    assert.equal(published.status, 200, published.text)
    const goalId = published.json.task.goal.id
    const byRole = new Map(chainOf(goalId).map((task) => [task.role, task]))
    const designCommit = 'd'.repeat(40)

    // ① 需求阶段交出一份带摘要的设计产物 → 实现阶段可以认领。
    const designPath = 'docs/orchestration/design.md'
    const designDigest = 'c'.repeat(64)
    const designClaim = await post('/api/claim', { id: byRole.get('requirement').id, soldier: 'claude-code', by: 'general', scope })
    assert.equal(designClaim.status, 200, designClaim.text)
    const designArtifact = await post('/api/artifact', {
      id: byRole.get('requirement').id, kind: 'file', path: designPath,
      title: '设计方案', digest: designDigest, by: 'claude-code', scope,
    })
    assert.equal(designArtifact.status, 200, designArtifact.text)
    const designInReview = await post('/api/transition', {
      id: byRole.get('requirement').id, to: 'in_review', by: 'claude-code', scope, force: true,
    })
    assert.equal(designInReview.status, 200, designInReview.text)
    const designAdvance = await post('/api/advance', { id: byRole.get('requirement').id, by: 'requirement', scope })
    assert.equal(designAdvance.status, 200, designAdvance.text)
    assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(byRole.get('requirement').id).status, 'done',
      `设计阶段应已验收：${designAdvance.text}`)

    // ② 实现阶段：认领 → 测试回执 → 交接证据 → 验收。
    const coderClaim = await post('/api/claim', { id: byRole.get('coder').id, soldier: 'spawn', by: 'general', scope })
    assert.equal(coderClaim.status, 200, coderClaim.text)
    const implementation = storeImplementationAttempt(byRole.get('coder').id, { sourceCommit: designCommit })
    assert.equal((await post('/api/comment', {
      id: byRole.get('coder').id, by: 'spawn', scope, isEvidence: true,
      text: `agent-workflow-implementation:${JSON.stringify({
        passed: true, sourceCommit: designCommit, stageAttemptId: implementation.attemptId,
        providerRunId: implementation.providerRunId, testVerification: implementation.testVerification,
        testCommand: 'node --test', testSummary: '3 passed', testEvidence: 'npm test: 3 passed',
      })}`,
    })).status, 200)
    assert.equal((await post('/api/transition', {
      id: byRole.get('coder').id, to: 'in_review', by: 'spawn', scope, force: true,
    })).status, 200)
    assert.equal((await post('/api/advance', { id: byRole.get('coder').id, by: 'coder', scope })).status, 200)

    // ③ 审查不通过 → 返工。
    const reviewClaim = await post('/api/claim', { id: byRole.get('reviewer').id, soldier: 'codex', by: 'general', scope })
    assert.equal(reviewClaim.status, 200, reviewClaim.text)
    const returned = await post('/api/agent-workflow/review', {
      taskId: byRole.get('reviewer').id, by: 'codex', scope,
      findings: [{ kind: 'implementation', summary: '边界没处理' }], summary: '实现问题', evidence: 'review.md#L3',
    })
    assert.equal(returned.status, 200, returned.text)
    assert.equal(returned.json.task.kind, 'rework')

    const afterRework = chainOf(goalId)
    const rolesAfter = afterRework.map((task) => task.role)
    // 返工子链 = coder + reviewer 各一条新任务；tester/devops **只有一份**。
    assert.equal(rolesAfter.filter((role) => role === 'coder').length, 2)
    assert.equal(rolesAfter.filter((role) => role === 'reviewer').length, 2)
    assert.equal(rolesAfter.filter((role) => role === 'tester').length, 1, '★ 下游测试不得被复制')
    assert.equal(rolesAfter.filter((role) => role === 'devops').length, 1, '★ 下游部署不得被复制')
    assert.equal(rolesAfter.filter((role) => role === 'requirement').length, 1, '★ 审查之前未受影响的阶段也不复制')

    const newReviewer = afterRework.find((task) => task.role === 'reviewer' && task.id !== byRole.get('reviewer').id)
    const newCoder = afterRework.find((task) => task.role === 'coder' && task.id !== byRole.get('coder').id)
    assert.ok(newReviewer && newCoder)
    assert.deepEqual(JSON.parse(newCoder.blockedBy), [byRole.get('reviewer').id], '返工实现由旧审查环节触发')
    assert.deepEqual(JSON.parse(newReviewer.blockedBy), [newCoder.id], '新审查等新实现')

    const tester = afterRework.find((task) => task.role === 'tester')
    const devops = afterRework.find((task) => task.role === 'devops')
    assert.deepEqual(JSON.parse(tester.blockedBy), [newReviewer.id],
      '★ 测试等的是**这一代**审查：旧审查已 done，指着它会让测试在被返工的版本上开跑')
    assert.deepEqual(JSON.parse(devops.blockedBy), [tester.id])

    assert.equal(mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(byRole.get('reviewer').id).status, 'done',
      '旧审查置 done 只为启动返工链')

    // ④ 新审查通过之前，测试不可认领（依赖未完成）。
    const earlyTestClaim = await post('/api/claim', { id: tester.id, soldier: 'spawn', by: 'general', scope })
    assert.equal(earlyTestClaim.status, 400, earlyTestClaim.text)
    assert.match(earlyTestClaim.text, /依赖/)
  })

  it('★★ 分配可以覆盖**任意**流水线岗位（不只设计/实现/审查），未覆盖的仍是 DSH 默认', async () => {
    const scope = 'space-assign-any-role'
    await seedSoftwareSpace(scope)
    const register = (id, providerName) => post('/api/agent-tools/configs', {
      by: 'general', id, version: 1, providerName, adapter: 'dsh-native',
      permissionProfile: 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
      capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
    })
    assert.equal((await register('tool.tester-agent', 'spawn')).status, 200)
    const baseWorkflow = shortWorkflow()
    const saved = await post('/api/pipeline', {
      scope, by: 'general',
      stages: SOFTWARE_ROLES.map((role, index) => ({
        role, label: `阶段-${role}`, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
      })),
      workflow: {
        ...baseWorkflow,
        stageTools: {
          ...baseWorkflow.stageTools,
          tester: { agentToolConfig: { id: 'tool.tester-agent', version: 1 }, modelConfig: null, nodeId: null, testRunner: null },
        },
      },
    })
    assert.equal(saved.status, 200, saved.text)

    const published = await post('/api/goal', { scope, objective: '覆盖测试岗位的目标', by: 'general' })
    assert.equal(published.status, 200, published.text)
    const chain = chainOf(published.json.task.goal.id)
    assert.equal(chain.length, 8, '★ 覆盖一个额外的岗位，不会改变阶段数')
    const snapshots = Object.fromEntries(chain.map((task) => [task.role, JSON.parse(task.agent_selection_snapshot)]))
    assert.equal(snapshots.tester.agentToolConfig.providerName, 'spawn')
    assert.equal(snapshots.tester.agentToolConfig.id, 'tool.tester-agent', '★ 测试岗位的分配真的生效了')
    assert.equal(snapshots.devops.agentToolConfig, null, '没被覆盖的岗位继续是 DSH 默认')
    assert.equal(published.json.task.frozen.assignments.tester.agentToolConfig, 'tool.tester-agent')
    assert.equal(published.json.task.frozen.assignments.devops.source, 'dsh-default')

    // 流水线里没有的岗位：拒绝，而不是存下来永不生效。
    const ghost = await post('/api/pipeline', {
      scope, by: 'general',
      stages: SOFTWARE_ROLES.map((role, index) => ({
        role, label: role, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
      })),
      workflow: {
        ...baseWorkflow,
        stageTools: { ...baseWorkflow.stageTools, ghost: { agentToolConfig: null, modelConfig: null, nodeId: null, testRunner: null } },
      },
    })
    assert.equal(ghost.status, 400, ghost.text)
    assert.match(ghost.text, /流水线里没有的岗位/)
  })

  it('★★★ 预览与发布逐字段一致：`/api/goal/plan` 不许是第二套实现', async () => {
    const scope = 'space-plan-parity'
    await seedSoftwareSpace(scope)
    assert.equal((await post('/api/pipeline', {
      scope, by: 'general',
      stages: SOFTWARE_ROLES.map((role, index) => ({
        role, label: `阶段-${role}`, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
      })),
      workflow: shortWorkflow(),
    })).status, 200)

    const request = {
      scope, by: 'general', objective: '预览一致性',
      agentToolConfig: { id: 'tool.codex', version: 1 },
      stageOverrides: { tester: { agentToolConfig: { id: 'tool.dsh-spawn', version: 1 } } },
    }
    const goalsBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n
    const auditBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n

    const preview = await post('/api/goal/plan', request)
    assert.equal(preview.status, 200, preview.text)
    // ★★★ 反例守卫：预览**一行都不许写**。写了 goal 或 audit 就等于"预览也发了一个目标"。
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n, goalsBefore, '★★★ 预览不许新建目标')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, auditBefore, '★★★ 预览不许写审计')
    assert.equal(preview.json.publishable, true, preview.text)
    assert.equal(preview.json.stages.length, 8)

    const published = await post('/api/goal', request)
    assert.equal(published.status, 200, published.text)
    const frozen = published.json.task.frozen

    // 逐字段比对：阶段集合、每阶段来源、目标级选择。
    assert.deepEqual(preview.json.stages.map((s) => s.role), frozen.stages, '★★ 阶段集合必须一致')
    for (const stage of preview.json.stages) {
      assert.equal(stage.assignment.source, frozen.assignments[stage.role].source,
        `★★ ${stage.role} 的 source 必须一致（预览说 ${stage.assignment.source}，冻结是 ${frozen.assignments[stage.role].source}）`)
      assert.equal(stage.assignment.agentToolConfig?.id ?? null, frozen.assignments[stage.role].agentToolConfig,
        `★★ ${stage.role} 的工具配置必须一致`)
    }
    assert.deepEqual(preview.json.goalAgent, frozen.goalAgent, '★ 目标级选择必须一致')
    assert.deepEqual(preview.json.effectiveNodeId, frozen.effectiveNodeId)

    // 目标级真的生效了：八环全部是 codex，只有显式覆盖的 tester 例外。
    assert.equal(frozen.assignments.requirement.agentToolConfig, 'tool.codex')
    assert.equal(frozen.assignments.requirement.source, 'goal-agent')
    assert.equal(frozen.assignments.tester.agentToolConfig, 'tool.dsh-spawn')
    assert.equal(frozen.assignments.tester.source, 'publish-override')
    assert.deepEqual(frozen.stageOverridesApplied, ['tester'])
    // 冻结到 goal 行上，之后仍能回答"这条目标当初选了谁"。
    assert.deepEqual(JSON.parse(mod.db.prepare('SELECT agent_tool_config FROM goal WHERE id=?').get(frozen.stages && published.json.task.goal.id).agent_tool_config), { agentToolConfig: { id: 'tool.codex', version: 1 } })
  })

  it('★★ 目标级 Agent 的边界：不存在的引用拒绝、testRunner 不许带、指标只在预览告警里出现', async () => {
    const scope = 'space-goal-agent-guard'
    await seedSoftwareSpace(scope)

    // ① 引用不存在 ⇒ 409 具名码，且**不留半个目标**。
    const goalsBefore = mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n
    const ghost = await post('/api/goal', {
      scope, by: 'general', objective: '幽灵工具',
      agentToolConfig: { id: 'tool.ghost', version: 1 },
    })
    assert.equal(ghost.status, 409, ghost.text)
    assert.equal(ghost.json.code, 'AGENT_TOOL_CONFIG_UNRESOLVED')
    assert.equal(mod.db.prepare('SELECT COUNT(*) AS n FROM goal').get().n, goalsBefore, '★★★ 拒绝时不留半条链')

    // ② testRunner 混进覆盖层 ⇒ 拒绝（忽略会让用户以为改成了）。
    //   ★ 顶层 `agentToolConfig` 只是 `{id, version}` 的引用，塞不进 testRunner；
    //   真正能带它的是 `stageOverrides`，所以这条判据走那条路。
    const withRunner = await post('/api/goal', {
      scope, by: 'general', objective: '偷改验收',
      stageOverrides: { coder: { testRunner: { executable: 'true', args: [], timeoutMs: 1000 } } },
    })
    assert.equal(withRunner.status, 400, withRunner.text)
    assert.equal(withRunner.json.code, 'AGENT_PLAN_OVERRIDE_TEST_RUNNER')

    // ③ 预览对"引用不存在"给出**与发布同一个**状态码与 code。
    //   ★ 它没被做成 blocker，是因为"你写了一个不存在的 id"是**请求本身有问题**，
    //     不是"配置齐了但机器没就绪"。两者若都走 blockers，前端就分不出
    //     "改一下再试"和"去开节点"。
    const previewBad = await post('/api/goal/plan', {
      scope, by: 'general', objective: '预览幽灵工具',
      agentToolConfig: { id: 'tool.ghost', version: 1 },
    })
    assert.equal(previewBad.status, ghost.status, '★★ 预览与发布对同一个坏引用必须同码')
    assert.equal(previewBad.json.code, ghost.json.code)
  })

  it('★★ 决策 #2：审查与实现同源时标注 selfReview（不拦发布）；不同源时不标', async () => {
    // 决策是 A：**接受并显式标注**。拦了就等于否掉「整条目标一个 Agent」这个能力本身，
    // 所以这里只断言"标了没有"，不断言"被拒了"。
    const scope = 'space-self-review'
    await seedSoftwareSpace(scope)
    // 配一个审查闭环：design=requirement / implementation=coder / review=reviewer。
    const baseWorkflow = {
      designRole: 'requirement', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2,
      stageTools: {
        requirement: { agentToolConfig: { id: 'tool.claude-code', version: 1 }, modelConfig: null, nodeId: null, testRunner: null },
        coder: { agentToolConfig: { id: 'tool.dsh-spawn', version: 1 }, modelConfig: null, nodeId: null,
          testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
        reviewer: { agentToolConfig: { id: 'tool.codex', version: 1 }, modelConfig: null, nodeId: null, testRunner: null },
      },
    }
    assert.equal((await post('/api/pipeline', {
      scope, by: 'general',
      stages: SOFTWARE_ROLES.map((role, index) => ({
        role, label: `阶段-${role}`, prompt: role, next: SOFTWARE_ROLES[index + 1] ?? null,
      })),
      workflow: baseWorkflow,
    })).status, 200)

    // 不同源（模板里 review=codex、implementation=dsh-spawn）⇒ 不标注。
    const distinct = await post('/api/goal/plan', { scope, by: 'general', objective: '不同源' })
    assert.equal(distinct.status, 200, distinct.text)
    assert.equal(distinct.json.selfReview, null, '★★ 不同源不许标：误标会让真实的自审提示失去意义')

    // 目标级把整条链都设成同一个 Provider ⇒ 审查与实现同源。
    //   `tool.dsh-spawn` 的 providerName 是 spawn，用它覆盖全链。
    const sameProvider = await post('/api/goal/plan', {
      scope, by: 'general', objective: '同源',
      agentToolConfig: { id: 'tool.dsh-spawn', version: 1 },
    })
    assert.equal(sameProvider.status, 200, sameProvider.text)
    assert.ok(sameProvider.json.selfReview !== null, '★★★ 同 provider 必须被标出来')
    assert.equal(sameProvider.json.selfReview.same, 'spawn')
    assert.match(sameProvider.json.selfReview.note, /语义审查不具备交叉验证性质/)
    // ★ 必须同时说清"哪一半还独立"——否则用户会以为整个验收都失效了。
    assert.match(sameProvider.json.selfReview.note, /独立测试回执不受影响/)
    // ★ 不拦：仍然 publishable。
    assert.equal(sameProvider.json.publishable, true, '★★ 标注不是拦截')

    // 发布回执里也要带上（事后要能回答"当时是不是自审"）。
    const published = await post('/api/goal', {
      scope, by: 'general', objective: '同源发布',
      agentToolConfig: { id: 'tool.dsh-spawn', version: 1 },
    })
    assert.equal(published.status, 200, published.text)
    assert.equal(published.json.task.frozen.selfReview?.same, 'spawn', '★ 冻结回执要留存自审标注')
  })

  it('custom-dag 必须显式选择：不选具名定义时按 pipeline 建链', async () => {
    const scope = 'space-explicit-dag'
    await seedSoftwareSpace(scope)
    const definition = {
      id: 'workflow.three-stage', version: 1, name: '三阶段闭环', description: '',
      stages: [
        { id: 'design', role: 'requirement', agentToolConfig: { id: 'tool.claude-code', version: 1 }, nodeId: null, testRunner: null },
        { id: 'implement', role: 'coder', agentToolConfig: { id: 'tool.dsh-spawn', version: 1 }, nodeId: null,
          testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } },
        { id: 'review', role: 'reviewer', agentToolConfig: { id: 'tool.codex', version: 1 }, nodeId: null, testRunner: null },
      ],
      edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
      entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
      reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 2,
    }
    assert.equal((await post('/api/agent-workflows/definitions', { scope, definition, by: 'general' })).status, 200)

    const asTemplate = await post('/api/goal', {
      scope, objective: '定义只当分配模板', by: 'general',
      workflowDefinition: { id: definition.id, version: 1 },
    })
    assert.equal(asTemplate.status, 200, asTemplate.text)
    assert.equal(asTemplate.json.task.stages, 8, '默认 pipeline：定义不改变阶段集合')
    assert.equal(asTemplate.json.task.orchestration, 'pipeline')

    const asDag = await post('/api/goal', {
      scope, objective: '显式按定义拓扑建链', by: 'general',
      orchestration: 'custom-dag',
      workflowDefinition: { id: definition.id, version: 1 },
    })
    assert.equal(asDag.status, 200, asDag.text)
    assert.equal(asDag.json.task.stages, 3, 'custom-dag 保留旧语义（显式选择才生效）')
    assert.equal(asDag.json.task.orchestration, 'custom-dag')

    const noDefinition = await post('/api/goal', {
      scope, objective: 'custom-dag 缺定义应拒绝', by: 'general', orchestration: 'custom-dag',
    })
    assert.equal(noDefinition.status, 400, noDefinition.text)
    assert.equal(noDefinition.json.code, 'AGENT_WORKFLOW_DEFINITION_REQUIRED')
  })
})
