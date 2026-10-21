export interface DshWorkflowCapabilities {
  outputSchema?: unknown
  toolFilter?: unknown
}

/**
 * Compare the DSH provider's raw capability descriptor with the frozen workflow snapshot.
 * Missing provider flags are false, matching the normalization used by node heartbeats.
 */
export function dshWorkflowCapabilityMismatch(
  actual: DshWorkflowCapabilities | null | undefined,
  frozen: DshWorkflowCapabilities,
  requiresToolFilter: boolean,
): string | null {
  const actualOutputSchema = actual?.outputSchema === true
  const frozenOutputSchema = frozen.outputSchema === true
  const actualToolFilter = actual?.toolFilter === true
  const frozenToolFilter = frozen.toolFilter === true

  if (actualOutputSchema !== frozenOutputSchema) {
    return `outputSchema 实际=${actualOutputSchema}，冻结=${frozenOutputSchema}`
  }
  if (frozenOutputSchema !== true) {
    return '冻结配置未启用必需的 outputSchema'
  }
  if (actualToolFilter !== frozenToolFilter) {
    return `toolFilter 实际=${actualToolFilter}，冻结=${frozenToolFilter}`
  }
  if (requiresToolFilter && (actualToolFilter !== true || frozenToolFilter !== true)) {
    return '配置了 denyTools，但 provider 未启用 toolFilter'
  }
  return null
}
