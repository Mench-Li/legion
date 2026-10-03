// Effective DSH external-provider policies required by the first Legion workflow.

const EXTERNAL_POLICIES = Object.freeze({
  codex: Object.freeze({ permissionProfile: 'codex-workspace-write', permissionMode: 'approve-for-me' }),
  'claude-code': Object.freeze({ permissionProfile: 'claude-code-acceptEdits', permissionMode: 'acceptEdits' }),
})

/** Resolve the native DSH permission mode required by a frozen external tool configuration. */
export function expectedExternalPermissionMode(toolConfig) {
  if (toolConfig?.adapter !== 'dsh-subagent') return null
  const expected = EXTERNAL_POLICIES[toolConfig.providerName]
  return expected?.permissionProfile === toolConfig.permissionProfile ? expected.permissionMode : null
}

/** Return the canonical frozen permission profile for a supported external DSH provider. */
export function externalPermissionProfile(providerName) {
  return EXTERNAL_POLICIES[providerName]?.permissionProfile ?? null
}
