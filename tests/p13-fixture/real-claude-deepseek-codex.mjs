/**
 * Real persistent Legion workflow acceptance: Claude Code designs, DSH's
 * native DeepSeek agent implements and runs the independent test receipt, and
 * Codex reviews. Every execution uses a disposable DSH profile, Hub database,
 * and Git repository. The profile points its credentials provider at the
 * user's existing DSH credential file; no credential value is copied or
 * written to this probe.
 *
 * Run from the DSH checkout:
 *   pnpm exec node D:/project/DSH/legion/tests/p13-fixture/real-claude-deepseek-codex.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { makeFixture, freePort, req, sleep, spawnHost, waitReady } from './host-fixture.mjs'

const scope = `real-claude-deepseek-codex-${Date.now()}`
const token = `p13-preferred-${Date.now()}`
const verifyDesignRework = process.env.LEGION_REAL_DESIGN_REWORK === '1'
const credentialPath = resolve(process.env.USERPROFILE || homedir(), '.dsh', '.credentials.yaml').replace(/\\/g, '/')
const claudeRoute = 'http://127.0.0.1:15721'

async function assertClaudeRouteAvailable() {
  await new Promise((resolveDone, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 15721 })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolveDone() })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('CC Switch Claude route at 127.0.0.1:15721 is not reachable; enable its local route and retry')) })
    socket.once('error', () => reject(new Error('CC Switch Claude route at 127.0.0.1:15721 is not reachable; enable its local route and retry')))
  })
}
await assertClaudeRouteAvailable()
const toolConfigs = [
  {
    id: 'tool.real-claude-design', version: 1, providerName: 'claude-code', adapter: 'dsh-subagent',
    permissionProfile: 'claude-code-acceptEdits', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
  },
  {
    id: 'tool.real-deepseek-code', version: 1, providerName: 'spawn', adapter: 'dsh-native',
    permissionProfile: 'dsh-native', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: true, toolFilter: true, localAgent: true, sessionResume: false, cancellation: true },
  },
  {
    id: 'tool.real-codex-review', version: 1, providerName: 'codex', adapter: 'dsh-subagent',
    permissionProfile: 'codex-workspace-write', workspacePolicy: 'attempt-worktree-parent-cwd',
    capabilities: { textInput: true, textOutput: true, outputSchema: false, toolFilter: false, localAgent: false, sessionResume: false, cancellation: true },
  },
]
const stages = [
  {
    id: 'design', role: 'designer', label: 'Claude 设计', next: 'coder', tool: toolConfigs[0],
    prompt: verifyDesignRework
      ? 'Inspect the objective and starter source/test. Write only docs/design.md. On the first design attempt, specify the exact greet(name) output and empty-string behavior, but do not define whether leading/trailing whitespace in name is preserved, trimmed, or changed; do not mention whitespace preservation or say that name is inserted unchanged. Leave this behavior unresolved so the independent Codex review can identify the deliberate design gap. If prior review comments identify this whitespace gap, revise the design to explicitly preserve every input character (including leading/trailing whitespace) and add an acceptance example. Do not edit source/tests or run shell commands. Your final response must be exactly one JSON object, no Markdown fences or surrounding prose. Its top-level fields must be status, summary, evidence, blocker, and artifact. Status must be the string done or blocked; summary, evidence, and blocker must be strings. For a completed design, artifact must be an object with kind=file, path=docs/design.md, and title=Design. Include every field.'
      : 'Inspect the objective and starter source/test. Write only docs/design.md. Specify that greet(name) must return exactly `Hello, ${name}!`, including empty-string behavior and a focused node:test acceptance test. Do not edit source or tests and do not run shell commands. Your final response must be exactly one JSON object, no Markdown fences or surrounding prose, matching this schema: {"status":"done","summary":"...","evidence":"...","blocker":"","artifact":{"kind":"file","path":"docs/design.md","title":"Design"}}. Use status only `done` or `blocked`; include every listed field.',
    outputContract: { artifacts: ['docs/design.md'] },
  },
  {
    id: 'implement', role: 'coder', label: 'DSH DeepSeek 编码', next: 'reviewer', tool: toolConfigs[1],
    prompt: 'Read docs/design.md and implement its exact contract in src/greet.mjs. Strengthen test/greet.test.mjs to assert the exact output and run `node --test test/greet.test.mjs`. Do not run git add, git commit, or other Git write operations; Legion will create the implementation commit in the host after you return. Your final response must be exactly one JSON object, no Markdown fences or surrounding prose, matching this schema: {"status":"done","summary":"...","evidence":"...","blocker":"","artifact":null,"testReport":{"passed":true,"command":"node --test test/greet.test.mjs","summary":"...","evidence":"...","failures":[]}}. Use status only `done` or `blocked`; include every listed field. Report done only if the code and the test actually pass.',
    inputContract: { artifacts: ['docs/design.md'] }, outputContract: { artifacts: ['commit', 'test-evidence'] },
    testRunner: { executable: 'node', args: ['--test', 'test/greet.test.mjs'], timeoutMs: 120_000 },
  },
  {
    id: 'review', role: 'reviewer', label: 'Codex 审查', next: null, tool: toolConfigs[2],
    prompt: verifyDesignRework
      ? 'Review docs/design.md, src/greet.mjs, test/greet.test.mjs, the implementation commit, and Legion test receipt. The contract requires exact `Hello, ${name}!` output, including empty-string behavior, and preservation of leading/trailing whitespace exactly. On the initial review, if docs/design.md omits whitespace behavior, return exactly one design finding asking the designer to define and test it, with passed=false. On the later review, pass only when the revised design explicitly preserves whitespace and implementation/tests/receipt match. Do not edit files. Your final response must be exactly one JSON object, no Markdown fences or surrounding prose, with top-level fields status, summary, evidence, blocker, artifact, and review. Status must be the string done or blocked; summary, evidence, and blocker must be strings. The review field must contain passed as a boolean and findings as an array; each finding must contain kind, summary, and evidence, all strings, and kind may only be design or implementation. Use the correct passed value and an empty findings array when passed is true; include all fields.'
      : 'Review docs/design.md, src/greet.mjs, test/greet.test.mjs, the implementation commit, and Legion test receipt. Do not edit files. Return exactly one JSON object, no Markdown fences or surrounding prose, matching this schema: {"status":"done","summary":"...","evidence":"...","blocker":"","artifact":null,"review":{"passed":true,"findings":[]}}. Use status only `done` or `blocked`; include every listed field. Pass only when source and test both match `Hello, ${name}!` exactly, tests pass, and the receipt is bound to the implementation Attempt, provider Run, and source commit.',
    inputContract: { artifacts: ['docs/design.md', 'commit', 'test-evidence'] },
  },
]
const definition = {
  id: 'workflow.real-claude-deepseek-codex', version: 1,
  name: 'Claude → DSH DeepSeek → Codex real acceptance',
  description: 'Real provider handoff with a Legion test receipt and Codex review',
  stages: stages.map(({ id, role, tool, inputContract, outputContract, testRunner }) => ({
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

const credentialOverride = `- id: credentials\n  config:\n    path: '${credentialPath}'`
const deepseekModelOverride = `- id: agent-default-model\n  config:\n    provider: 'deepseek-official'\n    model: 'deepseek-v4-flash'`
const claudeRouteOverride = `- id: subagent-claude-code\n  config:\n    permissionMode: acceptEdits\n    env:\n      ANTHROPIC_BASE_URL: '${claudeRoute}'`
const fx = makeFixture({
  port: await freePort(), teamToken: token, workerIntervalMs: 5000,
  withAgentProviders: true, isolate: true, workerScope: scope, codexModel: 'gpt-5.5',
  extraRows: [credentialOverride, deepseekModelOverride, claudeRouteOverride],
})
const host = spawnHost(fx, { env: { DEEPSEEK_API_KEY: '' } })
const base = `${fx.base}/team-hub`
let rootTaskId = null
let goalPublished = false
let workflowSucceeded = false

async function call(method, path, body) {
  const result = await req(base, method, path, body === undefined ? undefined : { ...body, by: body.by ?? 'general', scope: body.scope ?? scope }, token)
  assert.equal(result.status, 200, `${method} ${path} returned ${result.status}: ${JSON.stringify(result.data).slice(0, 600)}`)
  return result.data
}

async function history() {
  if (!rootTaskId) return null
  const result = await req(base, 'GET', `/api/agent-workflow/history?taskId=${encodeURIComponent(rootTaskId)}&scope=${encodeURIComponent(scope)}`, undefined, token)
  assert.equal(result.status, 200, 'history returned 200')
  return result.data
}

async function waitFor(predicate, label, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    if (host.exitCode !== null || host.signalCode !== null) throw new Error(`isolated DSH host exited before ${label}`)
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  mkdirSync(join(fx.repoRoot, 'src'), { recursive: true })
  mkdirSync(join(fx.repoRoot, 'test'), { recursive: true })
  mkdirSync(join(fx.repoRoot, 'docs'), { recursive: true })
  writeFileSync(join(fx.repoRoot, 'src', 'greet.mjs'), 'export function greet(name) { return `Hello, ${name}?` }\n')
  writeFileSync(join(fx.repoRoot, 'test', 'greet.test.mjs'), [
    "import test from 'node:test'", "import assert from 'node:assert/strict'", "import { greet } from '../src/greet.mjs'",
    "test('initial fixture is executable', () => assert.equal(typeof greet('Ada'), 'string'))", '',
  ].join('\n'))
  git(['init', '-b', 'main'], fx.repoRoot)
  git(['add', '.'], fx.repoRoot)
  git(['commit', '-m', 'Seed isolated preferred workflow probe'], fx.repoRoot)

  await waitReady(fx.base, { timeoutMs: 120_000, child: host, rows: fx.rows, packageDirs: fx.packageDirs })
  const providerInventory = await req(fx.base, 'GET', '/__p13/providers')
  assert.equal(providerInventory.status, 200, 'isolated DSH provider inventory is available')
  const registeredProviders = (providerInventory.data?.providers ?? []).map((provider) => provider.name)
  assert.ok(['claude-code', 'spawn', 'codex'].every((provider) => registeredProviders.includes(provider)), `isolated DSH providers missing: ${JSON.stringify(registeredProviders)}`)
  await call('POST', '/api/spaces', { id: scope, name: 'Real Claude DSH Codex workflow', localDir: fx.repoRoot })
  for (const stage of stages) await call('POST', '/api/agents', { scope, role: stage.role, name: stage.label, kind: 'agent', avatar: '🤖' })
  for (const tool of toolConfigs) await call('POST', '/api/agent-tools/configs', tool)
  await call('POST', '/api/agent-nodes/configs', { id: 'p13-fixture-node', label: 'Isolated real DSH worker', scope, providerNames: ['claude-code', 'spawn', 'codex'] })
  let node
  try {
    await waitFor(async () => {
      const result = await req(base, 'GET', `/api/agent-nodes?scope=${encodeURIComponent(scope)}`, undefined, token)
      node = result.data?.nodes?.find((item) => item.id === 'p13-fixture-node') ?? null
      return node?.status === 'ready' && ['claude-code', 'spawn', 'codex'].every((name) => node.observedProviders?.includes(name))
    }, 'DSH worker heartbeat with all three providers', 60_000)
  } catch (error) {
    const latest = await req(base, 'GET', `/api/agent-nodes?scope=${encodeURIComponent(scope)}`, undefined, token)
    node = latest.data?.nodes?.find((item) => item.id === 'p13-fixture-node') ?? null
    const workerDiagnostics = (host._p13logs?.out + '\n' + host._p13logs?.err).split(/\r?\n/)
      .filter((line) => /heartbeat|心跳|sweep 异常|worker.*(失败|异常)|hub.*(失败|异常)|Error:/i.test(line))
      .slice(-10)
      .map((line) => line.replace(/(?:Bearer\s+)[^\s"']+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 400))
    throw new Error(`${String(error)}; observed=${JSON.stringify({
      status: node?.status ?? null,
      providers: node?.observedProviders ?? [],
      capabilityProviders: Object.keys(node?.observedCapabilities?.providers ?? {}),
    })}; registeredProviders=${JSON.stringify(registeredProviders)}; workerDiagnostics=${JSON.stringify(workerDiagnostics)}`)
  }
  assert.equal(node.observedCapabilities.providers.codex.systemProxyMode, 'system')
  console.log(JSON.stringify({
    node: node.id,
    providers: toolConfigs.map((tool) => ({
      provider: tool.providerName,
      expected: { outputSchema: tool.capabilities.outputSchema, toolFilter: tool.capabilities.toolFilter, cancellation: tool.capabilities.cancellation },
      observed: node.observedCapabilities.providers[tool.providerName],
    })),
  }))

  await call('POST', '/api/pipeline', {
    scope, by: 'general', stages: stages.map(({ id, role, label, next, prompt, tool }) => ({
      id, role, label, next, prompt, agentToolConfig: { id: tool.id, version: tool.version },
    })),
  })
  await call('POST', '/api/agent-workflows/definitions', { definition })
  const created = await call('POST', '/api/goal', {
    objective: verifyDesignRework
      ? 'Use the preferred real provider chain: Claude Code designs greet(name) returning exactly Hello, ${name}! for all strings, including empty input; DSH native DeepSeek implements and tests it; Codex performs read-only review. Resolve any typed design finding by rerunning all affected stages.'
      : 'Use the preferred real provider chain: Claude Code defines greet(name) returning exactly Hello, ${name}!, DSH native DeepSeek implements it and runs Legion verification, then Codex performs read-only review.',
    workflowDefinition: { id: definition.id, version: definition.version },
  })
  goalPublished = true
  const goalId = created.task.goal.id
  const tasks = await waitFor(async () => {
    const result = await req(base, 'GET', `/api/board?scope=${encodeURIComponent(scope)}`, undefined, token)
    const rows = Array.isArray(result.data) ? result.data : result.data?.tasks ?? []
    const matching = rows.filter((task) => task.goalId === goalId)
    return matching.length >= 3 ? matching : null
  }, 'persisted workflow tasks', 60_000)
  rootTaskId = tasks.find((task) => task.role === 'designer').id

  const result = await waitFor(async () => {
    const current = await history()
    const attempts = current?.stageAttempts ?? []
    const terminalFailure = attempts.find((attempt) => ['failed', 'unknown', 'canceled'].includes(attempt.state))
    if (terminalFailure) throw new Error(`Attempt ${terminalFailure.id} ended ${terminalFailure.state} in ${terminalFailure.stageId}`)
    const rejectedReport = attempts.find((attempt) => attempt.result?.status === 'blocked')
    if (rejectedReport) throw new Error(`Attempt ${rejectedReport.id} returned a blocked report in ${rejectedReport.stageId}`)
    const blockedTask = (current?.tasks ?? []).find((task) => task.status === 'blocked')
    if (blockedTask) throw new Error(`workflow task ${blockedTask.id} entered blocked before Codex review`)
    const parked = (current?.tasks ?? []).find((task) => task.status === 'in_review' && task.agentSelectionSnapshot?.workflowStageId !== 'review')
    if (parked) throw new Error(`workflow task ${parked.id} parked before Codex review`)
    if (verifyDesignRework) {
      const reviews = attempts.filter((attempt) => attempt.stageId === 'review')
      const firstDesignFinding = reviews[0]?.result?.review?.passed === false
        && reviews[0]?.result?.review?.findings?.some((finding) => finding.kind === 'design') === true
      if (reviews.length > 1 && !firstDesignFinding) throw new Error('first Codex review did not route a typed design finding')
      if (attempts.length === 6 && attempts.every((attempt) => attempt.state === 'completed')
        && firstDesignFinding && reviews.at(-1)?.result?.review?.passed === true) return current
    } else if (attempts.length === 3 && attempts.every((attempt) => attempt.state === 'completed')) return current
    return null
  }, 'three completed real provider Attempts and Codex review')

  const byStage = Object.fromEntries(['design', 'implement', 'review'].map((stageId) => [stageId,
    result.stageAttempts.filter((attempt) => attempt.stageId === stageId).at(-1),
  ]))
  assert.deepEqual(Object.keys(byStage).sort(), ['design', 'implement', 'review'])
  assert.ok(result.stageAttempts.every((attempt) => attempt.providerRunId), 'each Attempt must bind a provider Run')
  assert.ok(result.stageAttempts.every((attempt) => attempt.result?.status === 'done'), 'each provider must return a completed WorkerReport')
  assert.equal(byStage.design.providerName, 'claude-code')
  assert.equal(byStage.implement.providerName, 'spawn')
  assert.equal(byStage.review.providerName, 'codex')
  for (const stage of stages) {
    for (const attempt of result.stageAttempts.filter((item) => item.stageId === stage.id)) {
    assert.equal(attempt.selectionSnapshot?.agentToolConfig?.id, stage.tool.id, `${stage.id} must retain its frozen tool id`)
    assert.equal(attempt.selectionSnapshot?.agentToolConfig?.version, stage.tool.version, `${stage.id} must retain its frozen tool version`)
    assert.equal(attempt.selectionSnapshot?.agentToolConfig?.providerName, stage.tool.providerName, `${stage.id} must retain its frozen provider`)
    }
  }
  if (verifyDesignRework) {
    const reviews = result.stageAttempts.filter((attempt) => attempt.stageId === 'review')
    assert.equal(result.stageAttempts.length, 6, 'a design finding must create a complete new three-stage generation')
    assert.equal(reviews.length, 2)
    assert.equal(reviews[0].result.review.passed, false)
    assert.ok(reviews[0].result.review.findings.some((finding) => finding.kind === 'design'))
    assert.equal(reviews[1].result.review.passed, true)
  }
  assert.equal(byStage.review.result?.review?.passed, true)
  assert.ok(byStage.implement.result?.testVerification?.id, 'implementation must have a Legion independent test receipt')
  const receipt = byStage.implement.result.testVerification
  assert.equal(receipt.stageAttemptId, byStage.implement.id)
  assert.equal(receipt.providerRunId, byStage.implement.providerRunId)
  assert.match(receipt.sourceCommit, /^[0-9a-f]{40}$/i)
  const workspace = byStage.implement.workspaceDir
  assert.equal(git(['rev-parse', 'HEAD'], workspace), receipt.sourceCommit)
  const committedFiles = git(['show', '--format=', '--name-only', receipt.sourceCommit], workspace).split(/\r?\n/).filter(Boolean)
  assert.ok(committedFiles.includes('test/greet.test.mjs'))
  if (!verifyDesignRework) assert.ok(committedFiles.includes('src/greet.mjs'))
  assert.match(readFileSync(join(workspace, 'src', 'greet.mjs'), 'utf8'), /Hello, \$\{name\}!/)
  assert.match(readFileSync(join(workspace, 'test', 'greet.test.mjs'), 'utf8'), /Hello, (Ada|World)!/)
  const designTask = result.tasks.find((task) => task.id === byStage.design.taskId)
  const designArtifact = designTask?.artifacts?.find((artifact) => artifact.kind === 'file' && artifact.path === 'docs/design.md')
  assert.ok(designArtifact?.digest, 'Claude design must be stored as a versioned artifact')
  const downstreamDesign = readFileSync(join(workspace, 'docs', 'design.md'), 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  assert.equal(createHash('sha256').update(downstreamDesign, 'utf8').digest('hex'), designArtifact.digest, 'DSH coder must consume the frozen Claude design')
  assert.ok(existsSync(join(workspace, '.git')))
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all'], workspace), '', 'final implementation worktree must be clean')
  console.log(JSON.stringify({
    workflow: verifyDesignRework ? 'Claude Code → DSH native DeepSeek → Codex (design finding rework)' : 'Claude Code → DSH native DeepSeek → Codex',
    attempts: result.stageAttempts.map(({ id, stageId, providerName, providerRunId, state }) => ({ id, stageId, providerName, providerRunId, state })),
    designReworkVerified: verifyDesignRework,
    frozenToolVersionsVerified: true,
    designDigest: designArtifact.digest,
    implementationCommit: receipt.sourceCommit,
    committedFiles,
    independentReceiptBound: true,
    codexReview: byStage.review.result.review.passed ? 'passed' : 'failed',
    finalWorktreeClean: true,
  }))
  workflowSucceeded = true
} catch (error) {
  const current = await history().catch(() => null)
  const compact = (current?.stageAttempts ?? []).map(({ id, stageId, providerName, providerRunId, state, stopReason, error: attemptError }) => {
    const errorText = typeof attemptError === 'string' ? attemptError : ''
    const shape = errorText.match(/安全结构诊断：chars=(\d+), prefix=(object|array|fenced|other), objects=(\d+), fenced=(true|false)/)
    const safeError = errorText.includes('sdk-result-empty-final-assistant-missing')
      ? 'sdk-result-empty-final-assistant-missing'
      : shape ? `response-shape:chars=${shape[1]},prefix=${shape[2]},objects=${shape[3]},fenced=${shape[4]}`
        : undefined
    return { id, stageId, providerName, providerRunBound: Boolean(providerRunId), state, stopReason, ...(safeError ? { safeError } : {}) }
  })
  if (compact.length > 0) goalPublished = true
  throw new Error(`${String(error)}; attempts=${JSON.stringify(compact)}`)
} finally {
  if (host.exitCode === null && host.signalCode === null) {
    try { await req(fx.base, 'POST', '/__p13/shutdown') } catch { /* host may already have exited */ }
    await Promise.race([
      new Promise((resolveDone) => host.once('exit', resolveDone)),
      sleep(10_000).then(() => { if (host.exitCode === null && host.signalCode === null) host.kill() }),
    ])
  }
  if (workflowSucceeded || !goalPublished) {
    fx.cleanup()
  } else {
    console.error(JSON.stringify({ preservedFixture: fx.home, reason: 'provider workflow did not complete; retain DB, worktrees, and diagnostics for inspection' }))
  }
}
