// runtime/contracts/agent-workflow.mjs
// ============================================================================
// 阶段级 Agent 工作流纯契约。
//
// 编排只管阶段、工具身份、交接方向与审查回流；执行适配器负责启动
// Claude Code、DSH、Codex 等具体产品。工具配置和模型配置是不同身份；
// 这里不做 I/O，也不伪装成派工服务。
// ============================================================================

import { redactText } from './redact-patterns.mjs'

export const AGENT_WORKFLOW_ERRORS = Object.freeze({
  INVALID_WORKFLOW: 'AGENT_WORKFLOW_INVALID',
  UNKNOWN_STAGE: 'AGENT_WORKFLOW_UNKNOWN_STAGE',
  UNKNOWN_REVIEW_KIND: 'AGENT_WORKFLOW_UNKNOWN_REVIEW_KIND',
  REVIEW_REQUIRED: 'AGENT_WORKFLOW_REVIEW_REQUIRED',
  IMPLEMENTATION_EVIDENCE_MISSING: 'AGENT_WORKFLOW_IMPLEMENTATION_EVIDENCE_MISSING',
})

const validName = (value) => typeof value === 'string' && value.trim() !== ''

function invalid(message, details = {}) {
  return Object.freeze({ ok: false, code: AGENT_WORKFLOW_ERRORS.INVALID_WORKFLOW, message, ...details })
}

/** Validate the implementation stage's claimed test run before it can be handed to review. */
export function validateAgentWorkflowTestReport(report) {
  const failures = report?.failures
  const malformedFailures = failures !== undefined && !Array.isArray(failures)
  if (report === null || typeof report !== 'object' || report.passed !== true
    || (Array.isArray(failures) && failures.length > 0)
    || malformedFailures
    || typeof report.summary !== 'string' || report.summary.trim() === ''
    || typeof report.command !== 'string' || report.command.trim() === ''
    || typeof report.evidence !== 'string' || report.evidence.trim() === '') {
    return Object.freeze({
      ok: false,
      code: AGENT_WORKFLOW_ERRORS.IMPLEMENTATION_EVIDENCE_MISSING,
      message: '实现阶段需要通过状态、测试命令、非空测试摘要和测试输出证据，且失败列表为空',
    })
  }
  return Object.freeze({
    ok: true,
    command: redactText(report.command).text.trim().slice(0, 1000),
    summary: redactText(report.summary).text.trim().slice(0, 2000),
    evidence: redactText(report.evidence).text.trim().slice(0, 4000),
  })
}

/** Validate a Legion-executed test run receipt bound to one implementation commit and provider attempt. */
export function validateAgentWorkflowTestVerification(value) {
  const runner = value?.executable && Array.isArray(value?.args)
    ? validateWorkflowRunnerForReceipt(value)
    : { ok: false }
  if (!runner.ok
    || typeof value?.id !== 'string' || !/^wft-[0-9a-f-]{36}$/i.test(value.id)
    || !['passed', 'failed', 'unknown'].includes(value.state)
    || typeof value.sourceCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.sourceCommit)
    || typeof value.stageAttemptId !== 'string' || value.stageAttemptId.trim() === ''
    || (value.providerRunId !== null && typeof value.providerRunId !== 'string')
    || (value.runnerNodeId !== null && typeof value.runnerNodeId !== 'string')
    || (value.state === 'passed' && value.exitCode !== 0)
    || (value.state === 'failed' && value.exitCode === 0)
    || (value.state === 'unknown' && value.exitCode !== null)
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
    || !Number.isSafeInteger(value.startedAtMs) || !Number.isSafeInteger(value.finishedAtMs)
    || value.finishedAtMs < value.startedAtMs
    || typeof value.outputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.outputDigest)
    || typeof value.outputExcerpt !== 'string' || value.outputExcerpt.length > 12 * 1024
    || typeof value.outputTruncated !== 'boolean'
    || (value.error !== null && typeof value.error !== 'string')) {
    return Object.freeze({ ok: false, code: AGENT_WORKFLOW_ERRORS.IMPLEMENTATION_EVIDENCE_MISSING, message: '独立测试执行回执格式无效或未绑定实现提交/Attempt' })
  }
  return Object.freeze({
    ok: true,
    receipt: Object.freeze({
      id: value.id,
      state: value.state,
      sourceCommit: value.sourceCommit,
      stageAttemptId: value.stageAttemptId,
      providerRunId: value.providerRunId,
      runnerNodeId: value.runnerNodeId,
      executable: runner.value.executable,
      args: runner.value.args,
      timeoutMs: runner.value.timeoutMs,
      exitCode: value.exitCode,
      startedAtMs: value.startedAtMs,
      finishedAtMs: value.finishedAtMs,
      outputDigest: value.outputDigest,
      outputExcerpt: redactText(value.outputExcerpt).text.slice(0, 12 * 1024),
      outputTruncated: value.outputTruncated,
      error: typeof value.error === 'string' ? redactText(value.error).text.slice(0, 1000) : null,
    }),
  })
}

function validateWorkflowRunnerForReceipt(value) {
  const executables = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'pytest', 'go', 'cargo', 'dotnet'])
  const safeArg = /^[A-Za-z0-9_./:@+=,-]+$/
  if (!executables.has(value.executable) || value.args.length === 0 || value.args.length > 128
    || value.args.some((arg) => typeof arg !== 'string' || arg.length === 0 || arg.length > 512 || !safeArg.test(arg))
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 60 * 60 * 1000) return { ok: false }
  return { ok: true, value: Object.freeze({ executable: value.executable, args: Object.freeze([...value.args]), timeoutMs: value.timeoutMs }) }
}

/** Validate the immutable implementation handoff consumed by a review stage. */
export function validateAgentWorkflowImplementationEvidence(value) {
  const test = validateAgentWorkflowTestReport(value)
  const verification = validateAgentWorkflowTestVerification(value?.testVerification)
  if (!test.ok || !verification.ok || verification.receipt.state !== 'passed'
    || verification.receipt.sourceCommit !== value?.sourceCommit
    || typeof value?.sourceCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.sourceCommit)) {
    return Object.freeze({
      ok: false,
      code: AGENT_WORKFLOW_ERRORS.IMPLEMENTATION_EVIDENCE_MISSING,
      message: '审查交接需要有效实现提交 SHA、Agent 报告和绑定该提交的独立通过测试回执',
    })
  }
  return Object.freeze({ ok: true, sourceCommit: value.sourceCommit, testVerification: verification.receipt, ...test })
}

/**
 * 校验并冻结一条线性工作流与审查返工策略。
 * 阶段绑定带版本的 Agent 工具配置；运行时如何映射到 DSH provider 由 adapter 决定。
 */
export function createAgentWorkflow({
  id,
  version,
  stages,
  reviewStageId = 'review',
  reviewRoutes = { implementation: 'implement', design: 'design' },
  maxReworkRounds = 3,
} = {}) {
  if (!validName(id) || !Number.isSafeInteger(version) || version < 1 || !Array.isArray(stages) || stages.length < 2) {
    throw new TypeError('工作流需要非空 id、正整数 version 和至少两个阶段')
  }
  if (!Number.isSafeInteger(maxReworkRounds) || maxReworkRounds < 0) {
    throw new TypeError('maxReworkRounds 必须是非负整数')
  }
  if (!validName(reviewStageId) || reviewRoutes === null || typeof reviewRoutes !== 'object' || Array.isArray(reviewRoutes)) {
    throw new TypeError('reviewStageId 与 reviewRoutes 形状无效')
  }

  const normalizedStages = stages.map((stage, index) => {
    if (stage === null || typeof stage !== 'object' || !validName(stage.id) || !validName(stage.role)) {
      throw new TypeError(`阶段 ${index} 必须含 id、role 与 Agent 工具配置`)
    }
    const tool = stage.agentToolConfig
    if (tool === null || typeof tool !== 'object' || !validName(tool.id)
      || !Number.isSafeInteger(tool.version) || tool.version < 1) {
      throw new TypeError(`阶段 ${index} 的 agentToolConfig 必须含 id 与正整数 version`)
    }
    const model = stage.modelConfig ?? null
    if (model !== null && (typeof model !== 'object' || !validName(model.id)
      || !Number.isSafeInteger(model.version) || model.version < 1)) {
      throw new TypeError(`阶段 ${index} 的 modelConfig 必须为 null 或含 id 与正整数 version`)
    }
    return Object.freeze({
      id: stage.id.trim(),
      role: stage.role.trim(),
      agentToolConfig: Object.freeze({ id: tool.id.trim(), version: tool.version }),
      modelConfig: model === null ? null : Object.freeze({ id: model.id.trim(), version: model.version }),
      next: stage.next === null || stage.next === undefined || stage.next === '' ? null : String(stage.next).trim(),
    })
  })
  const byId = new Map()
  for (const stage of normalizedStages) {
    if (byId.has(stage.id)) throw new TypeError(`阶段 id 重复：${stage.id}`)
    byId.set(stage.id, stage)
  }
  for (let index = 0; index < normalizedStages.length; index += 1) {
    const stage = normalizedStages[index]
    const expectedNext = normalizedStages[index + 1]?.id ?? null
    if (stage.next !== expectedNext) {
      throw new TypeError(`阶段 ${stage.id} 的 next 必须是 ${expectedNext ?? 'null'}；阶段链必须有序且无分叉`)
    }
  }
  if (!byId.has(reviewStageId)) throw new TypeError(`审查阶段不存在：${reviewStageId}`)

  const routes = {}
  for (const kind of ['implementation', 'design']) {
    const target = reviewRoutes[kind]
    if (!validName(target) || !byId.has(target)) throw new TypeError(`审查类别 ${kind} 指向无效阶段：${String(target)}`)
    routes[kind] = target.trim()
  }
  return Object.freeze({
    id: id.trim(),
    version,
    stages: Object.freeze(normalizedStages),
    reviewStageId: reviewStageId.trim(),
    reviewRoutes: Object.freeze(routes),
    maxReworkRounds,
  })
}

/** 读取一个阶段的冻结 Agent 工具选择。 */
export function agentStageFor(workflow, stageId) {
  const stage = workflow?.stages?.find((item) => item.id === stageId)
  if (stage === undefined) {
    return Object.freeze({
      ok: false,
      code: AGENT_WORKFLOW_ERRORS.UNKNOWN_STAGE,
      message: `工作流 ${workflow?.id ?? '(unknown)'} 不包含阶段 ${String(stageId)}`,
    })
  }
  return Object.freeze({ ok: true, workflowId: workflow.id, workflowVersion: workflow.version, ...stage })
}

/**
 * 将 Codex 审查结果转成明确的下一步。混合问题先回设计，然后必须重新实现。
 * `reworkRounds` 是工作流已消耗的返工轮数；只有真正决定返工时才递增。
 */
export function resolveReviewDisposition(workflow, { passed, findings, reworkRounds = 0 } = {}) {
  if (workflow === null || typeof workflow !== 'object' || workflow.reviewStageId === undefined) {
    throw new TypeError('resolveReviewDisposition 需要已校验的工作流')
  }
  if (!Array.isArray(findings) || !Number.isSafeInteger(reworkRounds) || reworkRounds < 0) {
    return Object.freeze({ ok: false, code: AGENT_WORKFLOW_ERRORS.REVIEW_REQUIRED, message: '审查结果需要 findings 数组与非负返工计数' })
  }
  if (findings.length === 0) {
    if (passed !== true) return Object.freeze({ ok: false, code: AGENT_WORKFLOW_ERRORS.REVIEW_REQUIRED, message: '没有问题项时，审查必须明确 passed=true' })
    const review = workflow.stages.find((stage) => stage.id === workflow.reviewStageId)
    return Object.freeze({ ok: true, kind: 'passed', nextStageId: review.next, reworkRounds })
  }
  if (passed === true) return Object.freeze({ ok: false, code: AGENT_WORKFLOW_ERRORS.REVIEW_REQUIRED, message: '存在问题项时不得同时报告 passed=true' })

  const kinds = new Set()
  for (const finding of findings) {
    if (finding === null || typeof finding !== 'object' || !validName(finding.kind)) {
      return Object.freeze({ ok: true, kind: 'needs-clarification', reason: AGENT_WORKFLOW_ERRORS.UNKNOWN_REVIEW_KIND, nextStageId: null, reworkRounds })
    }
    if (!Object.hasOwn(workflow.reviewRoutes, finding.kind)) {
      return Object.freeze({ ok: true, kind: 'needs-clarification', reason: AGENT_WORKFLOW_ERRORS.UNKNOWN_REVIEW_KIND, nextStageId: null, reworkRounds })
    }
    kinds.add(finding.kind)
  }
  if (reworkRounds >= workflow.maxReworkRounds) {
    return Object.freeze({ ok: true, kind: 'rework-limit', nextStageId: null, reworkRounds })
  }
  // 设计问题优先：设计修订会使后续实现和审查都必须重新执行。
  const selectedKind = kinds.has('design') ? 'design' : 'implementation'
  return Object.freeze({
    ok: true,
    kind: selectedKind === 'design' ? 'revise-design' : 'fix-implementation',
    nextStageId: workflow.reviewRoutes[selectedKind],
    reworkRounds: reworkRounds + 1,
  })
}
