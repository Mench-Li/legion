/** Human-readable Codex proxy status from a DSH execution-node heartbeat. */
export function formatCodexSystemProxyMode(mode: unknown): string {
  if (mode === 'system') {
    return '上报 system（请求使用系统代理；心跳不验证网络连通性）'
  }
  if (mode === 'inherit') {
    return '上报 inherit（沿用 Codex 原生设置/代理环境变量；心跳不验证网络连通性）'
  }
  return '代理模式读数未提供（心跳不检查网络）'
}

/** Distinguish a missing Codex executor from an optional proxy-mode telemetry field. */
export function formatCodexSystemProxyNodeStatus(providerReported: boolean, mode: unknown): string {
  if (!providerReported) {
    return '心跳未报告 Codex provider（当前无法确认此节点已加载 Codex 执行器）'
  }
  if (mode === 'system' || mode === 'inherit') return formatCodexSystemProxyMode(mode)
  return 'Codex provider 已上报；代理模式读数未提供（这不代表网络故障）'
}
