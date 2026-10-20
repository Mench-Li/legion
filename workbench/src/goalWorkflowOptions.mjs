/**
 * Every definition returned by the scoped published-workflow endpoint has
 * already passed server-side DAG validation. Keep the full published list so
 * parallel and merge DAGs supported by the goal API remain selectable.
 * @param {Array<{ id: string, version: number, name: string }>} definitions
 */
export function goalWorkflowOptions(definitions) {
  return definitions.map((definition) => ({
    value: `${definition.id}@${definition.version}`,
    label: `${definition.name} · v${definition.version}`,
    definition,
  }))
}
