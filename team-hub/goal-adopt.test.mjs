// team-hub/goal-adopt.test.mjs
// ============================================================================
// 接手既有交付（adopt）：`POST /api/goal` 的 `adoptFrom`
//
// 为什么有这条：T-224 的实现写完、测试全绿、验收过了，但审查环因为**冻结的验证
// 命令**接不上它（整仓 `node --test` 跑不完 ⇒ 回执 unknown），唯一能走通的路是把
// 需求、选型、拆解、编码再跑一遍。adopt 让新目标从那份交付起，而不是从 main 重写。
//
// 这一组守三件事：
//   ① 钉进**每个**任务的冻结快照（守护建工作区、拼提示词时只拿得到任务快照）；
//   ② 只接受**已验收**的交付（in_review 的半成品接过来，下游会当成已完成来审）；
//   ③ 拒绝的形状要具名（找不到 / 跨空间 / 没验收 / 没有冻结提交）。
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-goal-adopt-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const call = async (m, p, b) => {
  const res = await fetch(base + p, {
    method: m,
    headers: b === undefined ? {} : { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  })
  const t = await res.text()
  let j
  try { j = JSON.parse(t) } catch { j = t }
  return { status: res.status, body: j }
}
const post = (p, b) => call('POST', p, b)

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关 */ }
  try { mod?.db?.close?.() } catch { /* 已关 */ }
  rmSync(dir, { recursive: true, force: true })
})

const COMMIT = '717607bfd4fbbadc5ea644717d6acbc82853d092'

const READY_CAPS = {
  isolatedWorktree: true, externalAgent: true, structuredOutput: true, toolFilter: true, cancellation: true,
  providers: { spawn: { outputSchema: true, toolFilter: true, cancellation: true } },
}

async function registerNode(scope, id) {
  await post('/api/agent-nodes/configs', { id, label: `节点 ${id}`, scope, by: 'general' })
  await post('/api/agent-nodes/heartbeat', { id, scope, by: 'general', providerNames: ['spawn'], capabilities: READY_CAPS })
}

/**
 * 建空间 + 编队 + 阶段链。`withWorkflow=true` 时配一条 设计→实现→审查 的跨 Agent 工作流
 * —— 只有这种链的任务才有冻结快照（adopt 要钉的就是它）。
 */
async function makeSpace(scope, { withWorkflow = false } = {}) {
  const space = await post('/api/spaces', { id: scope, name: scope, localDir: process.cwd(), by: 'general' })
  assert.equal(space.status, 200, '建空间失败：' + JSON.stringify(space.body))
  const roles = ['designer', 'coder', 'reviewer']
  const ins = mod.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  roles.forEach((role, i) => ins.run(scope, role, role, 'agent', '🤖', i))
  const stages = roles.map((role, i) => ({
    role, label: role, prompt: role, next: roles[i + 1] ?? null, agentToolConfig: null,
  }))
  if (!withWorkflow) {
    const saved = await post('/api/pipeline', { scope, by: 'general', stages, workflow: null })
    assert.equal(saved.status, 200, '存流水线失败：' + JSON.stringify(saved.body))
    return
  }
  await registerNode(scope, 'node-a')
  const tool = await post('/api/agent-tools/configs', {
    by: 'general', id: 'workflow.designer', version: 1, providerName: 'spawn', adapter: 'dsh-native',
    permissionProfile: 'dsh-native:spawn', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
  })
  assert.equal(tool.status, 200, '登记工具配置失败：' + JSON.stringify(tool.body))
  const saved = await post('/api/pipeline', {
    scope, by: 'general', stages,
    workflow: {
      designRole: 'designer', implementationRole: 'coder', reviewRole: 'reviewer', maxReworkRounds: 2,
      stageTools: Object.fromEntries(roles.map((role) => [role, {
        agentToolConfig: { id: 'workflow.designer', version: 1 }, modelConfig: null, nodeId: 'node-a',
        ...(role === 'coder' ? { testRunner: { executable: 'node', args: ['--test'], timeoutMs: 300000 } } : {}),
      }])),
    },
  })
  assert.equal(saved.status, 200, '存流水线（含工作流）失败：' + JSON.stringify(saved.body))
}

/** 造一个"已验收的交付"：任务 + done + 一条冻结提交的证据。 */
async function makeDeliveredTask(scope, { done = true, checkpoint = true } = {}) {
  const created = await post('/api/create', {
    scope, by: 'general', title: '【编码实现】账号管理', role: 'coder',
  })
  assert.equal(created.status, 200, '建任务失败：' + JSON.stringify(created.body))
  const id = created.body.task?.id ?? created.body.id
  const evidence = checkpoint
    ? [{ by: 'general', at: '2026-10-30T01:52:42.617Z', text: `agent-workflow-stage-checkpoint:${JSON.stringify({ stageId: 'coder', sourceCommit: COMMIT, artifactPaths: [], acceptedBy: 'general' })}` }]
    : []
  mod.db.prepare('UPDATE tasks SET status=?, evidence=? WHERE id=?').run(done ? 'done' : 'in_review', JSON.stringify(evidence), id)
  return id
}

const snapshotOf = (id) => JSON.parse(mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(id).agent_selection_snapshot)

test('① 接手已验收交付：每个新建任务都钉上同一条继承基线', async () => {
  const scope = 'adopt-a'
  await makeSpace(scope, { withWorkflow: true })
  const sourceId = await makeDeliveredTask(scope)
  const published = await post('/api/goal', {
    scope, by: 'general', objective: '账号管理（接手）', mode: 'chain', adoptFrom: sourceId,
  })
  assert.equal(published.status, 200, '发布失败：' + JSON.stringify(published.body))
  const created = mod.db.prepare("SELECT id, role FROM tasks WHERE goalId=?").all(published.body.task.goal.id)
  assert.ok(created.length >= 2, `应建出整条链，实际 ${created.length} 环`)
  for (const row of created) {
    const adopt = snapshotOf(row.id).adopt
    assert.ok(adopt, `${row.id}（${row.role}）缺少 adopt 基线`)
    assert.equal(adopt.taskId, sourceId)
    assert.equal(adopt.commit, COMMIT)
    assert.equal(adopt.branch, `w/${sourceId}`)
    assert.equal(adopt.adoptedBy, 'general')
  }
})

test('② 只接手已验收的交付：in_review 的半成品被具名拒绝', async () => {
  const scope = 'adopt-b'
  await makeSpace(scope)
  const sourceId = await makeDeliveredTask(scope, { done: false })
  const published = await post('/api/goal', { scope, by: 'general', objective: 'x', adoptFrom: sourceId })
  assert.equal(published.status, 409)
  assert.equal(published.body.code, 'ADOPT_NOT_DONE')
  // 拒绝要**在发布之前**：不该留下半个目标
  assert.equal(mod.db.prepare("SELECT count(*) c FROM goal WHERE scope=?").get(scope).c, 0)
})

test('③ 没有冻结提交的交付接不了（否则下游会从 main 起，悄悄重写）', async () => {
  const scope = 'adopt-c'
  await makeSpace(scope)
  const sourceId = await makeDeliveredTask(scope, { checkpoint: false })
  const published = await post('/api/goal', { scope, by: 'general', objective: 'x', adoptFrom: sourceId })
  assert.equal(published.status, 409)
  assert.equal(published.body.code, 'ADOPT_NO_COMMIT')
})

test('④ 找不到 / 跨空间，各自具名', async () => {
  const scope = 'adopt-d'
  await makeSpace(scope)
  const missing = await post('/api/goal', { scope, by: 'general', objective: 'x', adoptFrom: 'T-999' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'ADOPT_SOURCE_MISSING')

  await makeSpace('adopt-other')
  const foreign = await makeDeliveredTask('adopt-other')
  const cross = await post('/api/goal', { scope, by: 'general', objective: 'x', adoptFrom: foreign })
  assert.equal(cross.status, 403)
  assert.equal(cross.body.code, 'ADOPT_SCOPE_MISMATCH')
})

test('⑤ 不带 adoptFrom 时行为不变：快照里没有 adopt 字段', async () => {
  const scope = 'adopt-e'
  await makeSpace(scope)
  const published = await post('/api/goal', { scope, by: 'general', objective: '普通目标', mode: 'chain' })
  assert.equal(published.status, 200, JSON.stringify(published.body))
  const created = mod.db.prepare('SELECT id FROM tasks WHERE goalId=?').all(published.body.task.goal.id)
  assert.ok(created.length >= 2)
  // 不配跨 Agent 工作流时，链路任务本就没有冻结快照（`agent_selection_snapshot` 为 null）——
  // "没有 adopt"在两种形状下都成立：快照为 null，或快照里没有该字段。
  for (const row of created) {
    const raw = mod.db.prepare('SELECT agent_selection_snapshot FROM tasks WHERE id=?').get(row.id).agent_selection_snapshot
    assert.equal(raw === null ? undefined : JSON.parse(raw).adopt, undefined)
  }
})
