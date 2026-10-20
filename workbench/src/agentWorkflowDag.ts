export interface WorkflowArtifactStage {
  id: string
  outputArtifacts: string[]
}

export interface WorkflowArtifactEdge {
  from: string
  to: string
}

export function nextGraphStageId(stages: Array<{ id: string }>): string {
  let suffix = stages.length + 1
  const usedIds = new Set(stages.map(stage => stage.id))
  while (usedIds.has(`stage-${suffix}`)) suffix += 1
  return `stage-${suffix}`
}

export function cleanArtifactNames(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean))]
}

export function declaredArtifactOptions(stages: WorkflowArtifactStage[]): string[] {
  return cleanArtifactNames(stages.flatMap(stage => stage.outputArtifacts))
}

export function upstreamArtifactOptions(
  stages: WorkflowArtifactStage[],
  edges: WorkflowArtifactEdge[],
  targetStageId: string,
): string[] {
  const ancestors = new Set<string>()
  const pending = [targetStageId]
  while (pending.length > 0) {
    const target = pending.pop()!
    for (const edge of edges) {
      if (edge.to !== target || ancestors.has(edge.from)) continue
      ancestors.add(edge.from)
      pending.push(edge.from)
    }
  }
  return cleanArtifactNames(stages
    .filter(stage => stage.id !== targetStageId && ancestors.has(stage.id))
    .flatMap(stage => stage.outputArtifacts))
}

export function toggleArtifact(values: string[], artifact: string): string[] {
  return values.includes(artifact)
    ? values.filter(value => value !== artifact)
    : [...values, artifact]
}
