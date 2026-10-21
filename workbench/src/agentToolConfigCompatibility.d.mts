export interface AgentToolConfigExpectation {
  providerName: string
  adapter: string
  permissionProfile: string
  capabilities: object
}

export interface CompatibleAgentToolConfig {
  id: string
  version: number
  providerName: string
  adapter: string
  permissionProfile: string
  capabilities: object
  enabled: boolean
}

export declare function matchesAgentToolConfig(
  config: CompatibleAgentToolConfig | null | undefined,
  expected: AgentToolConfigExpectation,
): boolean

export declare function findReusableAgentToolConfig(
  configs: CompatibleAgentToolConfig[],
  expected: AgentToolConfigExpectation,
): CompatibleAgentToolConfig | null
