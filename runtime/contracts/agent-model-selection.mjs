// Model overrides passed to DSH child agents are frozen, non-secret profile
// selections. External one-shot products own their own model configuration.

export function agentOptionsForFrozenModel({ modelRef, resolvedModel, agentToolConfig, providerCapabilities } = {}) {
  if (modelRef === null || modelRef === undefined) {
    if (resolvedModel !== null && resolvedModel !== undefined) throw new TypeError('缺少模型档案引用，拒绝使用未追溯的模型快照')
    return null
  }
  if (resolvedModel === null || typeof resolvedModel !== 'object'
    || resolvedModel.id !== modelRef.id || resolvedModel.version !== modelRef.version
    || typeof resolvedModel.provider !== 'string' || resolvedModel.provider.trim() === ''
    || typeof resolvedModel.model !== 'string' || resolvedModel.model.trim() === '') {
    throw new TypeError('模型档案引用与冻结解析结果不匹配')
  }
  if (agentToolConfig?.adapter !== 'dsh-native') {
    throw new TypeError('模型档案覆盖只支持 DSH 原生 Agent provider')
  }
  if (providerCapabilities?.agentOptions !== true) {
    throw new TypeError('所选 DSH provider 不支持 agentOptions，拒绝忽略冻结模型')
  }
  return Object.freeze({
    provider: resolvedModel.provider,
    model: resolvedModel.model,
    ...(typeof resolvedModel.reasoningEffort === 'string' && resolvedModel.reasoningEffort !== ''
      ? { reasoningEffort: resolvedModel.reasoningEffort } : {}),
  })
}
