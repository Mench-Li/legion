/**
 * Every definition returned by the scoped published-workflow endpoint has
 * already passed server-side DAG validation. Keep only the newest published
 * version of each workflow for new goals; existing goals retain their frozen
 * definition snapshot.
 * @param {Array<{ id: string, version: number, name: string }>} definitions
 */
export function goalWorkflowOptions(definitions) {
  const latestById = new Map()
  for (const definition of definitions) {
    const current = latestById.get(definition.id)
    if (current === undefined || definition.version > current.version) latestById.set(definition.id, definition)
  }
  return [...latestById.values()].map((definition) => ({
    value: `${definition.id}@${definition.version}`,
    label: `${definition.name} · v${definition.version}`,
    definition,
  }))
}

/** Don't make users choose a version when there is only one workflow. */
export function defaultGoalWorkflowSelection(options) {
  return options.length === 1 ? options[0].value : ''
}
