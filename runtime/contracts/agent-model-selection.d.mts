export interface FrozenModelRef { id: string; version: number }
export interface ResolvedModelSelection extends FrozenModelRef {
  provider: string
  model: string
  reasoningEffort?: string | null
}
export interface AgentOptionsCapability { agentOptions?: boolean }

export function agentOptionsForFrozenModel(input: {
  modelRef: FrozenModelRef | null
  resolvedModel: ResolvedModelSelection | null
  agentToolConfig: { adapter?: string } | null
  providerCapabilities: AgentOptionsCapability | null
}): { provider: string; model: string; reasoningEffort?: string } | null
