/**
 * Manual real-worker cancellation acceptance probe.
 *
 * Boots an isolated real DSH host and Team Hub, publishes a one-stage
 * workflow, waits for the worker to bind a real Codex Run to its Stage Attempt,
 * then cancels the goal through the Hub API. No production database or
 * repository is used, and no DeepSeek credentials are read.
 *
 * Run from the DSH checkout:
 *   pnpm exec tsx D:/project/DSH/legion/tests/p13-fixture/real-codex-worker-cancel.mjs
 *   pnpm exec tsx D:/project/DSH/legion/tests/p13-fixture/real-codex-worker-cancel.mjs --kill-codex-child
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { makeFixture, freePort, req, sleep, spawnHost, waitReady } from './host-fixture.mjs'

const scope = `real-codex-worker-cancel-${Date.now()}`
const token = `p13-worker-cancel-${Date.now()}`
const probeUnknown = process.argv.includes('--kill-codex-child')
const tool = {
  id: 'tool.real-codex-worker-cancel', version: 1, providerName: 'codex', adapter: 'dsh-subagent',
  permissionProfile: 'codex-workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd',
  capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
}
const roleStages = [
  { role: 'designer', id: 'design', label: 'Design', next: 'coder', prompt: 'Do not use tools or modify files. This is a cancellation probe: wait for at least 90 seconds before replying with any text.', outputContract: { artifacts: ['design.md'] } },
  { role: 'coder', id: 'implement', label: 'Implement', next: 'reviewer', prompt: 'Implement', inputContract: { artifacts: ['design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] }, testRunner: { executable: 'node', args: ['--test'], timeoutMs: 60_000 } },
  { role: 'reviewer', id: 'review', label: 'Review', next: null, prompt: 'Review', inputContract: { artifacts: ['design.md', 'commit', 'test-evidence'] } },
]
const definition = {
  id: 'workflow.real-codex-worker-cancel', version: 1, name: 'Real Codex worker cancellation', description: 'One-stage cancellation probe',
  stages: roleStages.map(({ id, role, inputContract, outputContract, testRunner }) => ({
    id, role, agentToolConfig: { id: tool.id, version: tool.version }, nodeId: 'p13-fixture-node',
    ...(inputContract ? { inputContract } : {}), ...(outputContract ? { outputContract } : {}), ...(testRunner ? { testRunner } : {}),
  })),
  edges: [{ from: 'design', to: 'implement' }, { from: 'implement', to: 'review' }],
  entryStageIds: ['design'], terminalStageIds: ['review'], reviewStageId: 'review',
  reviewRoutes: { design: 'design', implementation: 'implement' }, maxReworkRounds: 1,
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Legion Probe', GIT_AUTHOR_EMAIL: 'legion-probe@example.invalid', GIT_COMMITTER_NAME: 'Legion Probe', GIT_COMMITTER_EMAIL: 'legion-probe@example.invalid' },
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`)
}

function codexChildPids(parentPid) {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const query = spawnSync(powershell, ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${Number(parentPid)}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`], {
    encoding: 'utf8', windowsHide: true,
  })
  if (query.status !== 0) throw new Error('failed to inspect children of the isolated DSH host')
  const output = query.stdout.trim()
  if (!output) return []
  const rows = Array.isArray(JSON.parse(output)) ? JSON.parse(output) : [JSON.parse(output)]
  return rows.filter((row) => /^codex(?:\.exe)?$/i.test(row.Name) || /app-server(?:\s|$)/i.test(row.CommandLine ?? ''))
    .map((row) => Number(row.ProcessId)).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

function stopProcess(pid) {
  const stopped = spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true })
  if (stopped.status !== 0) throw new Error('failed to stop the Codex app-server child of the isolated DSH host')
}

const port = await freePort()
const fx = makeFixture({ port, teamToken: token, workerIntervalMs: 5000, withAgentProviders: true, isolate: true, workerScope: scope })
let host = spawnHost(fx)
const base = `${fx.base}/team-hub`
let goalId = null
let designTaskId = null
let attempt = null

async function call(method, path, body) {
  const result = await req(base, method, path, body === undefined ? undefined : { ...body, by: body.by ?? 'general', scope: body.scope ?? scope }, token)
  assert.equal(result.status, 200, `${method} ${path} returned ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`)
  return result.data
}

async function currentHistory() {
  if (!designTaskId) return null
  const result = await req(base, 'GET', `/api/agent-workflow/history?taskId=${encodeURIComponent(designTaskId)}&scope=${encodeURIComponent(scope)}`, undefined, token)
  assert.equal(result.status, 200, `history returned ${result.status}`)
  return result.data
}

async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    if (host.exitCode !== null || host.signalCode !== null) throw new Error(`DSH host exited before ${label} (exit=${host.exitCode}, signal=${host.signalCode})`)
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  // The real worker requires a repository so external Agents get an isolated
  // worktree. The fixture repository is disposable and contains no user files.
  git(['init', '-b', 'main'], fx.repoRoot)
  git(['add', '.'], fx.repoRoot)
  git(['commit', '-m', 'Initialize isolated cancellation fixture'], fx.repoRoot)
  await waitReady(fx.base, { timeoutMs: 60_000, child: host, rows: fx.rows, packageDirs: fx.packageDirs })

  await call('POST', '/api/spaces', { id: scope, name: 'Real Codex worker cancellation probe', localDir: fx.repoRoot })
  for (const stage of roleStages) {
    await call('POST', '/api/agents', { scope, role: stage.role, name: stage.label, kind: 'agent', avatar: '🤖' })
  }
  await call('POST', '/api/agent-tools/configs', tool)
  await call('POST', '/api/agent-nodes/configs', { id: 'p13-fixture-node', label: 'Isolated real DSH worker', scope, providerNames: ['codex', 'claude-code'] })
  let lastNodeSnapshot = null
  try { await waitFor(async () => {
    const result = await req(base, 'GET', `/api/agent-nodes?scope=${encodeURIComponent(scope)}`, undefined, token)
    lastNodeSnapshot = result.data?.nodes?.find((node) => node.id === 'p13-fixture-node') ?? result.data
    return lastNodeSnapshot?.status === 'ready'
  }, 'real DSH Codex node heartbeat') } catch (error) {
    const logs = host._p13logs?.out + host._p13logs?.err
    throw new Error(`${String(error)}; node=${JSON.stringify(lastNodeSnapshot)}; hostLogTail=${String(logs).slice(-1000)}`)
  }
  assert.ok(lastNodeSnapshot.observedProviders.includes('codex'))
  assert.equal(lastNodeSnapshot.observedCapabilities.providers.codex.systemProxyMode, 'system')

  await call('POST', '/api/pipeline', {
    scope, by: 'general', stages: roleStages.map(({ role, label, next, prompt }) => ({
      role, label, next, prompt, agentToolConfig: { id: tool.id, version: tool.version },
    })),
  })
  await call('POST', '/api/agent-workflows/definitions', { definition })

  const created = await call('POST', '/api/goal', {
    objective: 'Verify cancellation through the real Legion DSH worker',
    workflowDefinition: { id: definition.id, version: definition.version },
  })
  goalId = created.task.goal.id
  const tasks = await waitFor(async () => {
    const result = await req(base, 'GET', `/api/board?scope=${encodeURIComponent(scope)}`, undefined, token)
    const rows = Array.isArray(result.data) ? result.data : result.data?.tasks ?? []
    const matches = rows.filter((task) => task.goalId === goalId)
    return matches.length === 3 ? matches : null
  }, 'three persisted workflow tasks')
  designTaskId = tasks.find((task) => task.role === 'designer').id

  const runningHistory = await waitFor(async () => {
    const history = await currentHistory()
    const running = history?.stageAttempts?.find((item) => item.taskId === designTaskId && item.state === 'running' && item.providerRunId)
    return running ? { history, attempt: running } : null
  }, 'real worker Stage Attempt and Codex Run binding')
  attempt = runningHistory.attempt

  // Let app-server finish startup and enter the model turn before cancellation.
  await sleep(1500)
  if (probeUnknown) {
    const codexPid = await waitFor(() => codexChildPids(host.pid)[0] ?? null, 'Codex app-server child process')
    stopProcess(codexPid)
    await waitFor(() => !codexChildPids(host.pid).includes(codexPid), 'Codex app-server process exit')
    // The transport can remain pending after an abrupt app-server exit. Stop
    // only this disposable DSH worker; startup recovery must quarantine its
    // durable running Attempt before any redispatch can occur.
    host.kill()
    await Promise.race([
      new Promise((resolve) => host.once('exit', resolve)),
      sleep(10_000),
    ])
    assert.ok(host.exitCode !== null || host.signalCode !== null, 'isolated DSH worker must exit before recovery is tested')
    host = spawnHost(fx)
    await waitReady(fx.base, { timeoutMs: 60_000, child: host, rows: fx.rows, packageDirs: fx.packageDirs })
    let unknownHistory
    try {
      unknownHistory = await waitFor(async () => {
        const history = await currentHistory()
        const unknown = history?.stageAttempts?.find((item) => item.id === attempt.id && item.state === 'unknown')
        return unknown ? { history, attempt: unknown } : null
      }, 'unknown Stage Attempt after DSH worker restart recovery', 60_000)
    } catch (error) {
      const latest = await currentHistory()
      const latestAttempt = latest?.stageAttempts?.find((item) => item.id === attempt.id)
      const latestTask = latest?.tasks?.find((item) => item.id === designTaskId)
      throw new Error(`${String(error)}; attempt=${JSON.stringify(latestAttempt)}; task=${JSON.stringify(latestTask && { status: latestTask.status, id: latestTask.id })}`)
    }
    assert.equal(unknownHistory.attempt.providerRunId, attempt.providerRunId)
    const unknownTask = unknownHistory.history.tasks.find((item) => item.id === designTaskId)
    assert.equal(unknownTask?.status, 'in_review')
    const board = await req(base, 'GET', `/api/board?scope=${encodeURIComponent(scope)}`, undefined, token)
    const heldTask = (Array.isArray(board.data) ? board.data : board.data?.tasks ?? []).find((item) => item.id === designTaskId)
    assert.equal(heldTask?.hold, true)
    await sleep(6000)
    const stableHistory = await currentHistory()
    assert.equal(stableHistory.stageAttempts.filter((item) => item.taskId === designTaskId).length, 1, 'unknown task must not be automatically reassigned')
    const worktree = unknownHistory.attempt.workspaceDir
    assert.ok(worktree && worktree.startsWith(fx.home), 'isolated task worktree must stay under the disposable fixture home')
    assert.ok(existsSync(join(worktree, '.git')), 'unknown worktree must be preserved for human inspection')
    const worktreeStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8', windowsHide: true })
    assert.equal(worktreeStatus.status, 0)
    assert.equal(worktreeStatus.stdout.trim(), '')
    await call('POST', '/api/agent-workflow/stage-attempts/reconcile', {
      attemptId: attempt.id, disposition: 'confirmed-stopped',
      note: `Codex app-server process ${codexPid} exited in the isolated DSH fixture; worktree and task state were checked.`,
      idempotencyKey: `confirmed-stopped-${attempt.id}`,
    })
    const reconciled = await currentHistory()
    assert.equal(reconciled.stageAttempts.find((item) => item.id === attempt.id)?.state, 'unknown', 'reconciliation must not rewrite provider terminal state')
    assert.ok(reconciled.reconciliations.some((item) => item.attemptId === attempt.id && item.disposition === 'confirmed-stopped'))
    console.log(JSON.stringify({ attemptState: 'unknown', providerRunBound: true, providerProcessStopped: true, taskHeld: heldTask.hold, noAutomaticReassignment: true, reconciled: true, worktreePreserved: true, worktreeClean: true }))
  } else {
    await call('POST', '/api/goal/status', { id: goalId, status: 'canceled' })
    const canceledHistory = await waitFor(async () => {
      const history = await currentHistory()
      const canceled = history?.stageAttempts?.find((item) => item.id === attempt.id && item.state === 'canceled')
      return canceled ? { history, attempt: canceled } : null
    }, 'provider-confirmed cancellation in Stage Attempt history')
    assert.equal(canceledHistory.attempt.providerRunId, attempt.providerRunId)
    const task = canceledHistory.history.tasks.find((item) => item.id === designTaskId)
    assert.equal(task?.status, 'in_progress', 'goal cancellation preserves an in-progress task for human review')
    const board = await req(base, 'GET', `/api/board?scope=${encodeURIComponent(scope)}`, undefined, token)
    const heldTask = (Array.isArray(board.data) ? board.data : board.data?.tasks ?? []).find((item) => item.id === designTaskId)
    assert.equal(heldTask?.hold, true, 'goal cancellation must quarantine the in-progress task from further dispatch')
    const worktree = canceledHistory.attempt.workspaceDir
    assert.ok(worktree && worktree.startsWith(fx.home), 'isolated task worktree must stay under the disposable fixture home')
    assert.ok(existsSync(join(worktree, '.git')), 'worker cancellation must preserve the isolated worktree for inspection')
    const worktreeStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8', windowsHide: true })
    assert.equal(worktreeStatus.status, 0)
    console.log(JSON.stringify({ attemptState: canceledHistory.attempt.state, providerRunBound: true, goalTaskState: task.status, taskHeld: heldTask.hold, worktreePreserved: true, worktreeClean: worktreeStatus.stdout.trim() === '' }))
  }
} finally {
  if (host.exitCode === null && host.signalCode === null) {
    try { await req(fx.base, 'POST', '/__p13/shutdown') } catch { /* host may already have exited */ }
    await Promise.race([
      host.exitCode !== null || host.signalCode !== null ? Promise.resolve() : new Promise((resolve) => host.once('exit', resolve)),
      sleep(10_000).then(() => { if (host.exitCode === null && host.signalCode === null) host.kill() }),
    ])
  }
  if (host.exitCode === null && host.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => host.once('exit', resolve)),
      sleep(5_000),
    ])
  }
  if (host.exitCode === null && host.signalCode === null) throw new Error('isolated DSH host did not stop; fixture retained for inspection')
  const tempRoot = `${tmpdir()}\\`.toLowerCase()
  const fixtureHome = `${fx.home}\\`.toLowerCase()
  if (!fixtureHome.startsWith(tempRoot)) throw new Error(`refusing to remove fixture outside temp root: ${fx.home}`)
  if (existsSync(fx.home)) {
    try { rmSync(fx.home, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }) } catch { /* disposable fixture may remain locked */ }
  }
}
