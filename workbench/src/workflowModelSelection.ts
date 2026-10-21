export type WorkflowModelSelectionState = 'selectable' | 'no-profiles' | 'unsupported' | 'missing-config' | 'missing-profile'

interface StageModelSelection {
  tool: string
  toolConfigRef: { id: string; version: number } | null
  modelConfigRef?: { id: string; version: number } | null
}

interface ModelToolConfig {
  id: string
  version: number
  adapter: string
}

interface ModelProfile {
  id: string
  version?: number
}

export function workflowModelSelectionState(
  stage: StageModelSelection,
  configs: ModelToolConfig[],
  profiles: ModelProfile[],
): WorkflowModelSelectionState {
  if (stage.toolConfigRef !== null) {
    const config = configs.find(item => item.id === stage.toolConfigRef?.id && item.version === stage.toolConfigRef?.version)
    if (!config) return 'missing-config'
    if (config.adapter !== 'dsh-native') return 'unsupported'
  } else if (stage.tool !== 'dsh-native') {
    return 'unsupported'
  }

  const availableProfiles = profiles.filter(profile => Number.isSafeInteger(profile.version))
  if (stage.modelConfigRef && !availableProfiles.some(profile =>
    profile.id === stage.modelConfigRef?.id && profile.version === stage.modelConfigRef?.version)) {
    return 'missing-profile'
  }
  return availableProfiles.length > 0 ? 'selectable' : 'no-profiles'
}
