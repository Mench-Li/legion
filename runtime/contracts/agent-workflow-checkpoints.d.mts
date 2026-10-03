export declare const WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX: string

export interface WorkflowCheckpointStage {
  stageId: string | null
  taskId: string
  evidence?: Array<{ text?: string }>
}

export interface WorkflowGitResult {
  code: number
  out?: string
  err?: string
}

export declare function materializeWorkflowCheckpoints(input: {
  workflowContext?: { upstreamStages?: WorkflowCheckpointStage[] } | null
  workdir: string
  runGit(workdir: string, args: string[]): Promise<WorkflowGitResult>
}): Promise<ReadonlyArray<{ stageId: string; taskId: string; sourceCommit: string }>>
