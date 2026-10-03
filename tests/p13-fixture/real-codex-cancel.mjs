/**
 * Manual real-provider acceptance probe. It binds a real DSH Codex Run to a
 * temporary Team Hub Stage Attempt, cancels it, and verifies the persisted
 * terminal state through the public workflow history API.
 *
 * Run from the DSH checkout:
 *   pnpm exec tsx D:/project/DSH/legion/tests/p13-fixture/real-codex-cancel.mjs
 *
 * Uses the current local Codex authentication and system proxy. It never reads
 * credential values, never calls the DeepSeek native provider, and never uses
 * the production Team Hub database or a repository worktree.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { requireDshCheckout } from './host-fixture.mjs'

const dshCheckout = requireDshCheckout()
const dshRequire = createRequire(join(dshCheckout, 'package.json'))
const importDsh = async (name) => import(pathToFileURL(dshRequire.resolve(name)).href)

const [{ Context }, { default: SubagentRuntime }, { default: SessionProjectionRegistry },
  { default: LocalSubprocessRuntime }, codex, hubModule] = await Promise.all([
  importDsh('@deepseek-ai/cordis'),
  importDsh('@deepseek-ai/dsh-subagent'),
  importDsh('@deepseek-ai/dsh-session-projection'),
  importDsh('@deepseek-ai/dsh-subprocess-local'),
  importDsh('@deepseek-ai/dsh-subagent-codex'),
  (async () => {
    process.env.TEAM_HUB_DB = ':memory:'
    return import(`../../team-hub/server.mjs?real-codex-cancel=${Date.now()}`)
  })(),
])

const hub = hubModule.default ?? hubModule
const scope = `real-codex-cancel-${Date.now()}`
const base = await new Promise((resolve, reject) => {
  hub.server.once('error', reject)
  hub.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${hub.server.address().port}`))
})
const workspaceDir = mkdtempSync(join(tmpdir(), 'legion-real-codex-cancel-'))
const ctx = new Context()
const controller = new AbortController()
let run
let providerRunId = null
let attemptId = null
let resultStopReason = null

async function post(path, body) {
  const headers = { 'content-type': 'application/json' }
  if (process.env.TEAM_HUB_TOKEN) headers.authorization = `Bearer ${process.env.TEAM_HUB_TOKEN}`
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { /* returned below for diagnosis */ }
  assert.equal(response.status, 200, `${path} returned ${response.status}: ${text.slice(0, 500)}`)
  return json
}

try {
  const tool = {
    id: 'tool.real-codex-cancel', version: 1, providerName: 'codex', adapter: 'dsh-subagent',
    permissionProfile: 'codex-workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
  }
  await post('/api/spaces', { id: scope, name: 'Real Codex cancellation probe', by: 'general' })
  const addRosterRole = hub.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)')
  for (const [sort, role] of ['designer', 'coder', 'reviewer'].entries()) {
    addRosterRole.run(scope, role, role, 'agent', '🤖', sort)
  }
  await post('/api/agent-tools/configs', { ...tool, by: 'general' })
  await post('/api/pipeline', {
    scope, by: 'general', stages: [
      { role: 'designer', label: 'Designer', prompt: 'Design stage', next: 'coder', agentToolConfig: { id: tool.id, version: 1 } },
      { role: 'coder', label: 'Coder', prompt: 'Implementation stage', next: 'reviewer', agentToolConfig: { id: tool.id, version: 1 } },
      { role: 'reviewer', label: 'Reviewer', prompt: 'Review stage', next: null, agentToolConfig: { id: tool.id, version: 1 } },
    ],
  })
  await post('/api/agent-nodes/configs', { id: 'codex-cancel-node', label: 'Codex cancellation probe', scope, by: 'general' })
  await post('/api/agent-nodes/heartbeat', {
    id: 'codex-cancel-node', scope, by: 'general', providerNames: ['codex'],
    capabilities: {
      isolatedWorktree: true, externalAgent: true, structuredOutput: false, toolFilter: false, cancellation: true,
      providers: { codex: { outputSchema: false, toolFilter: false, cancellation: true, permissionMode: 'approve-for-me', systemProxyMode: 'system' } },
    },
  })
  const definition = {
    id: 'workflow.real-codex-cancel', version: 1, name: '真实 Codex 取消验收', description: '单阶段取消探针',
    stages: [
      { id: 'design', role: 'designer', agentToolConfig: { id: tool.id, version: 1 }, nodeId: 'codex-cancel-node', outputContract: { artifacts: ['design.md'] } },
      { id: 'implement', role: 'coder', agentToolConfig: { id: tool.id, version: 1 }, nodeId: 'codex-cancel-node', inputContract: { artifacts: ['design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] }, testRunner: { executable: 'node', args: ['--test'], timeoutMs: 60_000 } },
      { id: 'review', role: 'reviewer', agentToolConfig: { id: tool.id, version: 1 }, nodeId: 'codex-cancel-node', inputContract: { artifacts: ['design.md', 'commit', 'test-evidence'] } },
    ],
    edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
    entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
    reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 1,
  }
  await post('/api/agent-workflows/definitions', { scope, by: 'general', definition })
  const created = await post('/api/goal', {
    scope, by: 'general', objective: 'Verify real Codex cancellation and Hub Attempt history',
    workflowDefinition: { id: definition.id, version: definition.version },
  })
  const goalId = created.task.goal.id
  const task = hub.db.prepare('SELECT * FROM tasks WHERE goalId=? ORDER BY rowid LIMIT 1').get(goalId)
  assert.ok(task?.id, 'temporary workflow must create its design stage')
  const frozen = JSON.parse(task.agent_selection_snapshot)
  assert.equal(frozen.workflowStageId, 'design')
  hub.db.prepare("UPDATE tasks SET status='in_progress', soldier='codex', hold=0 WHERE id=?").run(task.id)

  const attempt = await post('/api/agent-workflow/stage-attempts/start', {
    taskId: task.id, stageId: 'design', providerName: 'codex', workspaceDir,
    idempotencyKey: `real-codex-cancel-${Date.now()}`, by: 'codex', scope,
  })
  attemptId = attempt.task.id

  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  codex.apply(ctx, { model: 'gpt-5.5', permissionMode: 'approve-for-me', systemProxyMode: 'system', disposeGraceMs: 2500 })
  run = await ctx.subagents.start('codex', {
    prompt: [{ type: 'text', text: 'Read-only cancellation verification. Do not use tools or modify files. If not cancelled, reply exactly: SHOULD_NOT_COMPLETE' }],
    parent: { id: 'legion-real-codex-cancel', session: { header: { cwd: workspaceDir } } },
    signal: controller.signal,
  })
  providerRunId = run.id
  await post('/api/agent-workflow/stage-attempts/report', { attemptId, providerRunId, state: 'running', by: 'codex', scope })
  await post('/api/goal/status', { id: goalId, status: 'canceled', by: 'general', scope })
  controller.abort(new Error('Legion cancellation acceptance probe'))
  resultStopReason = (await run.result).stopReason
  assert.equal(resultStopReason, 'aborted')
  await run.dispose()
  run = null
  await post('/api/agent-workflow/stage-attempts/report', {
    attemptId, providerRunId, state: 'canceled', stopReason: resultStopReason, by: 'codex', scope,
  })

  const historyResponse = await fetch(`${base}/api/agent-workflow/history?taskId=${encodeURIComponent(task.id)}&scope=${encodeURIComponent(scope)}`)
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json()
  const persisted = history.stageAttempts.find((item) => item.id === attemptId)
  assert.equal(persisted?.state, 'canceled')
  assert.equal(persisted?.providerRunId, providerRunId)
  assert.equal(persisted?.stopReason, 'aborted')
  assert.equal(persisted?.workspaceDir, workspaceDir)
  const workspaceEntries = readdirSync(workspaceDir)
  assert.deepEqual(workspaceEntries, [], 'cancellation must not write files into the isolated probe workspace')
  console.log(JSON.stringify({ resultStopReason, attemptState: persisted.state, providerRunBound: true, workspacePreserved: true }))
} finally {
  if (run) await run.dispose().catch(() => {})
  await ctx.fiber.dispose().catch(() => {})
  hub.server.closeAllConnections?.()
  await new Promise((resolve) => hub.server.close(() => resolve()))
  hub.db.close()
  if (existsSync(workspaceDir) && readdirSync(workspaceDir).length === 0) rmdirSync(workspaceDir)
}
