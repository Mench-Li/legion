export declare const EXTERNAL_AGENT_CODES: Readonly<Record<string, string>>

export interface ExternalAgentRun {
  readonly id?: string
  readonly result: Promise<{ readonly stopReason?: string; readonly diagnostic?: string; readonly output?: Array<{ readonly type?: string; readonly text?: string }> }>
  dispose(): Promise<void>
}

export interface ExternalAgentExecution {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
  readonly diagnostic?: string
  readonly provider?: string
  readonly expectedPermissionMode?: string
  readonly actualPermissionMode?: string | null
  readonly runId?: string | null
  readonly run?: ExternalAgentRun
  readonly output?: string
  readonly stopReason?: string
  readonly structured?: unknown
}

export declare function executeExternalAgent(input: {
  subagents: any
  providerName?: string
  parent?: any
  workdir?: string
  prompt?: string
  label?: string
  signal?: AbortSignal
  /** Caller checked the frozen workspace policy; the adapter independently compares the DSH provider's resolved permissionMode. */
  policyPreflightPassed?: boolean
  expectedCapabilities?: Record<string, boolean> | null
  expectedPermissionMode?: string | null
  returnRun?: boolean
}): Promise<ExternalAgentExecution>

export declare function parseExternalWorkerReport(raw: string):
  | { readonly ok: true; readonly report: Record<string, any> }
  | { readonly ok: false; readonly code: string; readonly message: string }
