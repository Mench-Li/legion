/**
 * Manual real-worker typed implementation-rework acceptance probe.
 *
 * Uses one disposable DSH profile, Hub database and Git repository. Every stage
 * runs through the real DSH worker and authenticated Codex provider. The first
 * implementation is constrained to preserve a seeded, test-passing mismatch;
 * the real reviewer must return a typed implementation finding, after which
 * the worker must create a new implementation Attempt, test it and re-review.
 * No DeepSeek credentials or production repository are read.
 *
 * Run from the DSH checkout:
 *   pnpm exec tsx D:/project/DSH/legion/tests/p13-fixture/real-codex-implementation-rework.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeFixture, freePort, req, sleep, spawnHost, waitReady } from './host-fixture.mjs'

const scope = `real-codex-implementation-rework-${Date.now()}`
const token = `p13-codex-rework-${Date.now()}`
const findingKind = process.argv.includes('--design-finding') ? 'design' : 'implementation'
const tool = {
  id: 'tool.real-codex-implementation-rework', version: 1, providerName: 'codex', adapter: 'dsh-subagent',
  permissionProfile: 'codex-workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd',
  capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
}
const stages = [
  {
    id: 'design', role: 'designer', label: 'Design', next: 'coder',
    prompt: findingKind === 'design'
      ? 'Read the objective and starter. For the initial design task only, document the seeded question-mark behavior as the accepted contract so the reviewer can return a design finding against the objective. For a task whose description contains [agent-workflow-rework], correct docs/design.md to the objective contract: greet(name) must return exactly `Hello, ${name}!`. Write only docs/design.md; do not edit source or tests.'
      : 'Read the starter source and test. Write only docs/design.md. Define greet(name) to return exactly `Hello, ${name}!`; this is the authoritative contract. Do not edit source or tests.',
    outputContract: { artifacts: ['docs/design.md'] },
  },
  {
    id: 'implement', role: 'coder', label: 'Implement', next: 'reviewer',
    prompt: findingKind === 'design'
      ? 'Implement docs/design.md and make the existing node:test suite pass. The first design intentionally describes the seeded question-mark behavior and the starter test accepts either punctuation. If this task description contains [agent-workflow-rework], follow the revised design and strengthen the test to assert the exact output, overriding any starter behavior. Commit your changes and report the commit and test evidence.'
      : 'For the first implementation in this controlled acceptance probe, preserve the starter behavior and starter test unchanged, even though the design specifies different punctuation; the Codex reviewer must catch and classify this mismatch. The starter test accepts either punctuation so Legion can run its independent test receipt and reach review. If this is a review-rework task, follow the typed finding, change the implementation to match the design, and strengthen the test to assert the exact design output, overriding the first-pass instruction. Commit your changes and report the commit and test evidence.',
    inputContract: { artifacts: ['docs/design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] },
    testRunner: { executable: 'node', args: ['--test', 'test/greet.test.mjs'], timeoutMs: 120_000 },
  },
  {
    id: 'review', role: 'reviewer', label: 'Review', next: null,
    prompt: findingKind === 'design'
      ? 'Read the objective, docs/design.md, src/greet.mjs, test/greet.test.mjs, and the Legion test receipt. This fixture deliberately seeds a design that approves `?`, although the objective requires `!`. On the first review, return one typed design finding that requires revising the design and regenerating implementation/tests; do not edit files. After design rework and implementation rerun, pass only if design, source, and test assert the exact objective output. Return a normal WorkerReport with review.passed and review.findings.'
      : 'Read docs/design.md, src/greet.mjs, test/greet.test.mjs, and the Legion test receipt. This fixture deliberately seeds a starter implementation/test using `?` while the design requires `!`. On the first review, return one typed implementation finding that names the mismatch and requires both source and test to match the design; do not edit files. After implementation rework, pass only if both source and test assert the exact design output. Return a normal WorkerReport with review.passed and review.findings.',
    inputContract: { artifacts: ['docs/design.md', 'commit', 'test-evidence'] },
  },
]
const definition = {
  id: 'workflow.real-codex-implementation-rework', version: 1,
  name: 'Real Codex implementation rework', description: 'Real provider typed finding and durable implementation rework',
  stages: stages.map(({ id, role, inputContract, outputContract, testRunner }) => ({
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
  return result.stdout.trim()
}

const port = await freePort()
const fx = makeFixture({ port, teamToken: token, workerIntervalMs: 5000, withAgentProviders: true, isolate: true, workerScope: scope, codexModel: 'gpt-5.5' })
const host = spawnHost(fx)
const base = `${fx.base}/team-hub`
let designTaskId = null

async function call(method, path, body) {
  const result = await req(base, method, path, body === undefined ? undefined : { ...body, by: body.by ?? 'general', scope: body.scope ?? scope }, token)
  assert.equal(result.status, 200, `${method} ${path} returned ${result.status}: ${JSON.stringify(result.data).slice(0, 600)}`)
  return result.data
}

async function history() {
  if (!designTaskId) return null
  const result = await req(base, 'GET', `/api/agent-workflow/history?taskId=${encodeURIComponent(designTaskId)}&scope=${encodeURIComponent(scope)}`, undefined, token)
  assert.equal(result.status, 200, `history returned ${result.status}`)
  return result.data
}

async function waitFor(predicate, label, timeoutMs = 480_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    if (host.exitCode !== null || host.signalCode !== null) throw new Error(`isolated DSH host exited before ${label} (exit=${host.exitCode}, signal=${host.signalCode})`)
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  const sourceDir = join(fx.repoRoot, 'src')
  const testDir = join(fx.repoRoot, 'test')
  const docsDir = join(fx.repoRoot, 'docs')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(testDir, { recursive: true })
  mkdirSync(docsDir, { recursive: true })
  writeFileSync(join(sourceDir, 'greet.mjs'), "export function greet(name) { return `Hello, ${name}?` }\n")
  writeFileSync(join(testDir, 'greet.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { greet } from '../src/greet.mjs'\ntest('starter behavior remains runnable before review', () => assert.ok(['Hello, Ada?', 'Hello, Ada!'].includes(greet('Ada'))))\n")
  git(['init', '-b', 'main'], fx.repoRoot)
  git(['add', '.'], fx.repoRoot)
  git(['commit', '-m', 'Seed isolated rework probe'], fx.repoRoot)

  await waitReady(fx.base, { timeoutMs: 120_000, child: host, rows: fx.rows, packageDirs: fx.packageDirs })
  await call('POST', '/api/spaces', { id: scope, name: 'Real Codex implementation rework probe', localDir: fx.repoRoot })
  for (const stage of stages) await call('POST', '/api/agents', { scope, role: stage.role, name: stage.label, kind: 'agent', avatar: '🤖' })
  await call('POST', '/api/agent-tools/configs', tool)
  await call('POST', '/api/agent-nodes/configs', { id: 'p13-fixture-node', label: 'Isolated real DSH worker', scope, providerNames: ['codex', 'claude-code'] })
  let node
  try {
    await waitFor(async () => {
      const result = await req(base, 'GET', `/api/agent-nodes?scope=${encodeURIComponent(scope)}`, undefined, token)
      node = result.data?.nodes?.find((item) => item.id === 'p13-fixture-node') ?? null
      return node?.status === 'ready' && node.observedProviders?.includes('codex')
    }, 'real Codex node heartbeat', 60_000)
  } catch (error) {
    throw new Error(`${String(error)}; node=${JSON.stringify(node)}; hostLogTail=${String(host._p13logs?.out + host._p13logs?.err).slice(-1500)}`)
  }
  assert.equal(node.observedCapabilities.providers.codex.systemProxyMode, 'system')

  await call('POST', '/api/pipeline', {
    scope, by: 'general', stages: stages.map(({ id, role, label, next, prompt }) => ({
      id, role, label, next, prompt, agentToolConfig: { id: tool.id, version: tool.version },
    })),
  })
  await call('POST', '/api/agent-workflows/definitions', { definition })
  const created = await call('POST', '/api/goal', {
    objective: findingKind === 'design'
      ? 'Design and implement greet(name) with exact output `Hello, ${name}!`; use review to return a typed design finding, revise the design, rerun implementation and pass Legion verification.'
      : 'Use real Codex review to return a typed implementation finding, rework and pass Legion verification',
    workflowDefinition: { id: definition.id, version: definition.version },
  })
  const goalId = created.task.goal.id
  const tasks = await waitFor(async () => {
    const result = await req(base, 'GET', `/api/board?scope=${encodeURIComponent(scope)}`, undefined, token)
    const rows = Array.isArray(result.data) ? result.data : result.data?.tasks ?? []
    const matching = rows.filter((task) => task.goalId === goalId)
    return matching.length === 3 ? matching : null
  }, 'persisted initial workflow tasks', 60_000)
  designTaskId = tasks.find((task) => task.role === 'designer').id

  let result
  try {
    result = await waitFor(async () => {
      const current = await history()
      const reviews = current?.reviews ?? []
      const attempts = current?.stageAttempts ?? []
      const completed = attempts.filter((attempt) => attempt.state === 'completed')
      const firstFinding = attempts.some((attempt) => attempt.stageId === 'review' && attempt.result?.review?.passed === false
        && attempt.result.review.findings.some((finding) => finding.kind === findingKind))
      const finalPass = attempts.some((attempt) => attempt.stageId === 'review' && attempt.result?.review?.passed === true)
      const terminalFailure = attempts.find((attempt) => ['failed', 'unknown', 'canceled'].includes(attempt.state))
      if (terminalFailure) throw new Error(`Stage Attempt ${terminalFailure.id} reached ${terminalFailure.state} at ${terminalFailure.stageId}`)
      if (finalPass && !firstFinding) {
        throw new Error('the real reviewer passed the initial design without a typed finding; this run did not exercise design rework')
      }
      const parked = (current?.tasks ?? []).find((task) => task.status === 'in_review'
        && task.agentSelectionSnapshot?.workflowStageId !== 'review')
      if (parked && !finalPass) throw new Error(`workflow task ${parked.id} was parked in review before completing typed rework`)
      const expectedAttempts = findingKind === 'design' ? 6 : 5
      return reviews.length >= 1 && firstFinding && finalPass && completed.length >= expectedAttempts ? current : null
    }, 'real typed finding, new implementation Attempt, test receipt and passing re-review')
  } catch (error) {
    const current = await history()
    const compactAttempts = (current?.stageAttempts ?? []).map((attempt) => ({
      id: attempt.id, stageId: attempt.stageId, state: attempt.state, providerRunBound: Boolean(attempt.providerRunId),
      stopReason: attempt.stopReason, error: attempt.error, result: attempt.result,
    }))
    const compactTasks = (current?.tasks ?? []).map((task) => ({
      id: task.id, role: task.role, workflowStageId: task.agentSelectionSnapshot?.workflowStageId,
      status: task.status, comments: task.comments?.map((comment) => comment.text),
    }))
    throw new Error(`${String(error)}; attempts=${JSON.stringify(compactAttempts)}; tasks=${JSON.stringify(compactTasks)}; reviews=${JSON.stringify((current?.reviews ?? []).map((review) => ({ kind: review.kind, round: review.round })))}`)
  }

  const attempts = result.stageAttempts
  const reviewAttempts = attempts.filter((attempt) => attempt.stageId === 'review')
  const designAttempts = attempts.filter((attempt) => attempt.stageId === 'design')
  const implementationAttempts = attempts.filter((attempt) => attempt.stageId === 'implement')
  assert.ok(reviewAttempts.length >= 2, 'a new review Attempt must follow implementation rework')
  assert.ok(implementationAttempts.length >= 2, 'implementation rework must create a distinct Attempt')
  assert.ok(designAttempts.length >= (findingKind === 'design' ? 2 : 1), 'design finding must create a distinct design Attempt')
  assert.equal(reviewAttempts[0].result.review.passed, false)
  assert.ok(reviewAttempts[0].result.review.findings.some((finding) => finding.kind === findingKind))
  assert.equal(result.reviews[0].kind, findingKind)
  assert.equal(reviewAttempts.at(-1).result.review.passed, true)
  if (findingKind === 'design') {
    const designRows = (result.tasks ?? []).filter((task) => designAttempts.some((attempt) => attempt.taskId === task.id))
    const designArtifacts = designRows.flatMap((task) => task.artifacts ?? []).filter((artifact) => artifact.kind === 'file' && artifact.path === 'docs/design.md')
    assert.ok(designArtifacts.length >= 2, 'old and revised design artifacts must both remain in Hub history')
    assert.notEqual(designArtifacts[0].digest, designArtifacts.at(-1).digest, 'design rework must publish a new artifact digest')
  }
  assert.equal(result.reviews[0].kind, findingKind)
  const initialImplementation = implementationAttempts[0]
  const reworkImplementation = implementationAttempts.at(-1)
  assert.notEqual(initialImplementation.id, reworkImplementation.id)
  assert.notEqual(initialImplementation.providerRunId, reworkImplementation.providerRunId)
  assert.ok(initialImplementation.result?.testVerification?.id)
  assert.ok(reworkImplementation.result?.testVerification?.id)
  assert.notEqual(initialImplementation.result.testVerification.sourceCommit, reworkImplementation.result.testVerification.sourceCommit)

  const source = readFileSync(join(reworkImplementation.workspaceDir, 'src', 'greet.mjs'), 'utf8')
  const test = readFileSync(join(reworkImplementation.workspaceDir, 'test', 'greet.test.mjs'), 'utf8')
  assert.match(source, /Hello, \$\{name\}!/)
  assert.match(test, /Hello, (World|Codex)!/)
  assert.ok(existsSync(join(reworkImplementation.workspaceDir, '.git')))
  const reworkStatus = git(['status', '--porcelain=v1', '--untracked-files=all'], reworkImplementation.workspaceDir)
  assert.equal(reworkStatus, '', 'rework worktree must be clean after its frozen test and commit')

  console.log(JSON.stringify({
    firstReview: `${findingKind}-finding`,
    reviewRounds: result.reviews.length,
    initialAttempt: { id: initialImplementation.id, runId: initialImplementation.providerRunId, commit: initialImplementation.result.testVerification.sourceCommit },
    reworkAttempt: { id: reworkImplementation.id, runId: reworkImplementation.providerRunId, commit: reworkImplementation.result.testVerification.sourceCommit },
    receiptsBound: [initialImplementation.result.testVerification, reworkImplementation.result.testVerification].every((receipt) => receipt.stageAttemptId && receipt.providerRunId && receipt.sourceCommit),
    reviews: reviewAttempts.map((attempt) => ({ id: attempt.id, runId: attempt.providerRunId, passed: attempt.result.review.passed })),
    finalReview: 'passed',
    reworkWorktreeClean: true,
  }))
} finally {
  if (host.exitCode === null && host.signalCode === null) {
    try { await req(fx.base, 'POST', '/__p13/shutdown') } catch { /* isolated host may already have exited */ }
    await Promise.race([
      new Promise((resolve) => host.once('exit', resolve)),
      sleep(10_000).then(() => { if (host.exitCode === null && host.signalCode === null) host.kill() }),
    ])
  }
  fx.cleanup()
}
