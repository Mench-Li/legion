export interface AgentWorkflowTestRunner {
  executable: string
  args: string[]
  timeoutMs: number
}

export declare function validateWorkflowTestRunner(value: unknown):
  | { ok: true; value: Readonly<{ executable: string; args: readonly string[]; timeoutMs: number }> }
  | { ok: false; message: string }
