import type { AgentWorkflowDefinition } from './api'

export interface GoalWorkflowOption {
  value: string
  label: string
  definition: AgentWorkflowDefinition
}

export declare function goalWorkflowOptions(definitions: AgentWorkflowDefinition[]): GoalWorkflowOption[]
export declare function defaultGoalWorkflowSelection(options: Array<Pick<GoalWorkflowOption, 'value'>>): string
