export interface WorkflowAgentRun {
  readonly result: Promise<unknown>
}

export interface WorkflowTaskSnapshot {
  readonly status?: string
}

export interface WaitForWorkflowAgentRunInput {
  run: WorkflowAgentRun
  taskId: string
  getTask(taskId: string): Promise<WorkflowTaskSnapshot>
  controller: AbortController
  timeoutMs: number
  pollIntervalMs?: number
  onPollError?(error: unknown): void
}

export interface WorkflowAgentRunWaitResult {
  readonly result: unknown | null
  readonly taskCanceled: boolean
  readonly timedOut: boolean
  /** Safe error class only when the provider result promise rejected. */
  readonly failureType?: string
}

export declare function waitForWorkflowAgentRun(input: WaitForWorkflowAgentRunInput): Promise<WorkflowAgentRunWaitResult>

/** BUG-043：把「没有可确认终态」映射成可归因的 stop_reason（纯函数，便于断言）。 */
export declare function workflowUnknownStopReason(input?: {
  timedOut?: boolean
  taskCanceled?: boolean
  failureType?: string | null
}): 'canceled-race' | 'timeout' | 'provider-rejected' | 'outcome-unknown'
