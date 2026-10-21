function sameRecord(left, right) {
  if (left === null || typeof left !== 'object' || Array.isArray(left)
    || right === null || typeof right !== 'object' || Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
}

/** Whether a saved tool config still matches the currently observed provider. */
export function matchesAgentToolConfig(config, expected) {
  return config?.enabled === true
    && config.providerName === expected.providerName
    && config.adapter === expected.adapter
    && config.permissionProfile === expected.permissionProfile
    && sameRecord(config.capabilities, expected.capabilities)
}

/** Return the newest enabled config compatible with the current provider readout. */
export function findReusableAgentToolConfig(configs, expected) {
  return [...configs]
    .filter(config => matchesAgentToolConfig(config, expected))
    .sort((left, right) => right.version - left.version)[0] ?? null
}
