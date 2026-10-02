export interface AgentWorkflowTestReportEvidence {
  passed: boolean
  command?: string
  summary?: string
  evidence?: string
  failures?: unknown[]
}

export interface AgentWorkflowTestVerification {
  id: string
  state: 'passed' | 'failed' | 'unknown'
  sourceCommit: string
  stageAttemptId: string
  providerRunId: string | null
  runnerNodeId: string | null
  executable: string
  args: string[]
  timeoutMs: number
  exitCode: number | null
  startedAtMs: number
  finishedAtMs: number
  outputDigest: string
  outputExcerpt: string
  outputTruncated: boolean
  error: string | null
}

export declare function validateAgentWorkflowTestVerification(value: unknown):
  | { ok: true; receipt: Readonly<AgentWorkflowTestVerification> }
  | { ok: false; code: string; message: string }

export type ValidatedAgentWorkflowTestReport = {
  ok: true
  command: string
  summary: string
  evidence: string
} | {
  ok: false
  code: string
  message: string
}

export declare function validateAgentWorkflowTestReport(report: unknown): ValidatedAgentWorkflowTestReport

export type ValidatedAgentWorkflowImplementationEvidence = {
  ok: true
  sourceCommit: string
  testVerification: Readonly<AgentWorkflowTestVerification>
  command: string
  summary: string
  evidence: string
} | {
  ok: false
  code: string
  message: string
}

export declare function validateAgentWorkflowImplementationEvidence(value: unknown): ValidatedAgentWorkflowImplementationEvidence
