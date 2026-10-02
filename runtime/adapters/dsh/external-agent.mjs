// runtime/adapters/dsh/external-agent.mjs
// ============================================================================
// DSH 外部 Agent 一次性执行适配。
//
// 只调用已注册的一次性 provider；不传 DSH 内部 worker 的 schema、agentOptions、
// toolFilter 或强制面载荷。目标工作目录必须等于该 DSH 父 Agent 的真实 cwd，
// 因为 Codex / Claude provider 从 parent.session.header.cwd 派生子进程 cwd。
// ============================================================================
import { resolve } from 'node:path'

export const EXTERNAL_AGENT_CODES = Object.freeze({
  PROVIDER_REQUIRED: 'EXTERNAL_AGENT_PROVIDER_REQUIRED',
  PROVIDER_MISSING: 'EXTERNAL_AGENT_PROVIDER_MISSING',
  PARENT_REQUIRED: 'EXTERNAL_AGENT_PARENT_REQUIRED',
  PREFLIGHT_REQUIRED: 'EXTERNAL_AGENT_PREFLIGHT_REQUIRED',
  WORKDIR_MISMATCH: 'EXTERNAL_AGENT_WORKDIR_MISMATCH',
  PROMPT_REQUIRED: 'EXTERNAL_AGENT_PROMPT_REQUIRED',
  START_FAILED: 'EXTERNAL_AGENT_START_FAILED',
  RESULT_INVALID: 'EXTERNAL_AGENT_RESULT_INVALID',
  PERMISSION_MODE_UNVERIFIED: 'EXTERNAL_AGENT_PERMISSION_MODE_UNVERIFIED',
})

function denied(code, message, details = {}) {
  return Object.freeze({ ok: false, code, message, ...details })
}

function normalizedPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const result = resolve(value)
  return process.platform === 'win32' ? result.toLowerCase() : result
}

/**
 * Run one fresh external Agent task through a registered DSH subagent provider.
 * The caller owns stage/Attempt persistence, policy preflight, and independent
 * artifact verification. This function guarantees only provider identity,
 * workspace binding, one-shot output, and run disposal.
 */
export async function executeExternalAgent({
  subagents,
  providerName,
  parent,
  workdir,
  prompt,
  label,
  signal,
  policyPreflightPassed = false,
  expectedCapabilities = null,
  expectedPermissionMode = null,
  returnRun = false,
} = {}) {
  if (!subagents || typeof subagents.getProvider !== 'function' || typeof subagents.start !== 'function') {
    throw new TypeError('external Agent adapter requires the DSH subagents service')
  }
  if (typeof providerName !== 'string' || providerName.trim() === '') {
    return denied(EXTERNAL_AGENT_CODES.PROVIDER_REQUIRED, '必须显式指定在册的 DSH Agent provider')
  }
  if (!parent?.session || !validHeader(parent.session.header)) {
    return denied(EXTERNAL_AGENT_CODES.PARENT_REQUIRED, '必须提供带 cwd 的父 Agent 会话')
  }
  if (policyPreflightPassed !== true) {
    return denied(EXTERNAL_AGENT_CODES.PREFLIGHT_REQUIRED, '执行前必须核验工作区绑定、冻结的预期权限档标识和 provider 能力；此预检不证明原生权限模式已生效，账户认证由 provider 启动/执行结果确认')
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return denied(EXTERNAL_AGENT_CODES.PROMPT_REQUIRED, '外部 Agent 需要完整的自包含文本任务')
  }
  const requestedCwd = normalizedPath(workdir)
  const parentCwd = normalizedPath(parent.session.header.cwd)
  if (requestedCwd === null || parentCwd === null || requestedCwd !== parentCwd) {
    return denied(EXTERNAL_AGENT_CODES.WORKDIR_MISMATCH,
      '外部 Agent 的工作目录必须与已预检的父 Agent cwd 相同',
      { expectedWorkdir: parent.session.header.cwd ?? null, requestedWorkdir: workdir ?? null })
  }
  const name = providerName.trim()
  const provider = subagents.getProvider(name)
  if (provider === undefined || provider.name !== name) {
    return denied(EXTERNAL_AGENT_CODES.PROVIDER_MISSING, `DSH provider 未注册：${name}`, { provider: name })
  }
  const caps = provider.capabilities
  if (caps === null || typeof caps !== 'object' || typeof caps.outputSchema !== 'boolean'
    || typeof caps.agentOptions !== 'boolean' || typeof caps.toolFilter !== 'boolean') {
    return denied(EXTERNAL_AGENT_CODES.PROVIDER_MISSING, `DSH provider ${name} 没有可核验的能力描述`, { provider: name })
  }
  if (expectedCapabilities !== null) {
    for (const key of ['outputSchema', 'toolFilter']) {
      if (typeof expectedCapabilities[key] === 'boolean' && caps[key] !== expectedCapabilities[key]) {
        return denied(EXTERNAL_AGENT_CODES.PROVIDER_MISSING, `DSH provider ${name} 的 ${key} 能力与冻结配置不一致`, { provider: name, capability: key })
      }
    }
  }
  if (typeof expectedPermissionMode !== 'string' || expectedPermissionMode.trim() === '') {
    return denied(EXTERNAL_AGENT_CODES.PERMISSION_MODE_UNVERIFIED, '冻结工具配置没有可核验的原生权限模式', { provider: name })
  }
  if (provider.permissionMode !== expectedPermissionMode) {
    return denied(EXTERNAL_AGENT_CODES.PERMISSION_MODE_UNVERIFIED,
      `DSH provider ${name} 未报告与冻结配置相符的原生权限模式`, {
        provider: name,
        expectedPermissionMode,
        actualPermissionMode: typeof provider.permissionMode === 'string' ? provider.permissionMode : null,
      })
  }
  if (signal?.aborted === true) {
    return denied(EXTERNAL_AGENT_CODES.START_FAILED, '外部 Agent 在启动前已取消', { provider: name, cancelled: true })
  }

  let run
  try {
    // Deliberately omit provider-unsupported DSH features. The prompt carries
    // the output contract; the caller validates the returned text separately.
    run = await subagents.start(name, {
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : name,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return denied(EXTERNAL_AGENT_CODES.START_FAILED, `DSH provider ${name} 启动失败`, {
      provider: name,
      // Provider exceptions may contain prompts, paths, or credential-bearing
      // command lines. Keep only the error class in durable diagnostics.
      diagnostic: safeErrorKind(error),
    })
  }

  if (returnRun === true) {
    return Object.freeze({ ok: true, provider: name, runId: run.id ?? null, run })
  }

  let result
  let failure
  try {
    result = await run.result
  } catch (error) {
    failure = error
  }
  try {
    await run.dispose()
  } catch (error) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, `DSH provider ${name} 资源回收失败`, {
      provider: name,
      runId: run.id ?? null,
      diagnostic: safeErrorKind(error),
    })
  }
  if (failure !== undefined) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, `DSH provider ${name} 结果读取失败`, {
      provider: name,
      runId: run.id ?? null,
      diagnostic: safeErrorKind(failure),
    })
  }
  if (result === null || typeof result !== 'object' || typeof result.stopReason !== 'string' || !Array.isArray(result.output)) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, `DSH provider ${name} 返回了无法核验的结果`, { provider: name, runId: run.id ?? null })
  }
  const text = result.output.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
  return Object.freeze({
    ok: result.stopReason === 'completed' && text.trim() !== '',
    provider: name,
    runId: run.id ?? null,
    stopReason: result.stopReason,
    ...(typeof result.diagnostic === 'string' ? { diagnostic: result.diagnostic } : {}),
    output: text,
    structured: result.structured ?? null,
  })
}

/** Find one unambiguous, balanced top-level JSON object in model prose. */
function extractSingleJsonObject(text) {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let candidate = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"' && depth > 0) { inString = true; continue }
    if (char === '{') {
      if (depth === 0) {
        if (candidate !== null) return null
        start = index
      }
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0) candidate = text.slice(start, index + 1)
    } else if (char === '}' && depth === 0) {
      return null
    }
  }
  if (depth !== 0 || candidate === null) return null
  const before = text.slice(0, start)
  const after = text.slice(start + candidate.length)
  if (before.includes('{') || before.includes('}') || after.includes('{') || after.includes('}')) return null
  if (before.trimEnd().endsWith('[') || after.trimStart().startsWith(']')) return null
  return candidate
}

/** Parse and validate one strict JSON WorkerReport from external text. */
export function parseExternalWorkerReport(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 没有返回报告文本')
  let text = raw.trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) text = fenced[1].trim()
  let value
  try { value = JSON.parse(text) } catch {
    const candidate = text.startsWith('[') ? null : extractSingleJsonObject(text)
    if (candidate === null) return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 报告不是有效 JSON')
    try { value = JSON.parse(candidate) } catch {
      return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 报告不是有效 JSON')
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !['done', 'blocked'].includes(value.status)
    || typeof value.summary !== 'string' || typeof value.evidence !== 'string'
    || typeof value.blocker !== 'string'
    || !(value.artifact === null || (value.artifact !== null && typeof value.artifact === 'object' && !Array.isArray(value.artifact)
      && ['html', 'file', 'url'].includes(value.artifact.kind)
      && typeof value.artifact.path === 'string'
      && (value.artifact.title === undefined || typeof value.artifact.title === 'string')))) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 报告不符合 WorkerReport 契约')
  }
  if (value.testReport !== undefined && (value.testReport === null || typeof value.testReport !== 'object'
    || typeof value.testReport.passed !== 'boolean'
    || (value.testReport.summary !== undefined && typeof value.testReport.summary !== 'string')
    || (value.testReport.failures !== undefined && (!Array.isArray(value.testReport.failures)
      || value.testReport.failures.some((failure) => failure === null || typeof failure !== 'object' || typeof failure.name !== 'string'))))) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 的 testReport 不符合契约')
  }
  if (value.review !== undefined && (value.review === null || typeof value.review !== 'object'
    || typeof value.review.passed !== 'boolean' || !Array.isArray(value.review.findings)
    || value.review.findings.some((finding) => finding === null || typeof finding !== 'object'
      || !['implementation', 'design'].includes(finding.kind) || typeof finding.summary !== 'string'
      || (finding.evidence !== undefined && typeof finding.evidence !== 'string')))) {
    return denied(EXTERNAL_AGENT_CODES.RESULT_INVALID, '外部 Agent 的 review 结论不符合契约')
  }
  return Object.freeze({ ok: true, report: Object.freeze(value) })
}

function safeErrorKind(error) {
  return error instanceof Error && typeof error.name === 'string' ? error.name : 'UnknownError'
}

function validHeader(header) {
  return header !== null && typeof header === 'object' && typeof header.cwd === 'string' && header.cwd.trim() !== ''
}
