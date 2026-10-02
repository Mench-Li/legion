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
