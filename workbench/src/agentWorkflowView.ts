/** Human-readable Codex proxy status from a DSH execution-node heartbeat. */
export function formatCodexSystemProxyMode(mode: unknown): string {
  if (mode === 'system') {
    return '已配置系统代理（Codex respect_system_proxy 开发中；需本节点实测）'
  }
  if (mode === 'inherit') {
    return '未强制系统代理（沿用 Codex 原生设置/代理环境变量，仍可能走代理）'
  }
  return '未上报（无法判断此节点是否走代理）'
}

/** Distinguish a missing Codex executor from a missing proxy-mode heartbeat field. */
export function formatCodexSystemProxyNodeStatus(providerReported: boolean, mode: unknown): string {
  if (!providerReported) {
    return '心跳未报告 Codex provider（请核对 subagent-codex 是否已安装并启用；当前无法确认 systemProxyMode 会生效）'
  }
  if (mode === 'system' || mode === 'inherit') return formatCodexSystemProxyMode(mode)
  return 'Codex provider 已上报，但 systemProxyMode 未上报（请检查配置或心跳是否已刷新，并确认执行服务已重启）'
}
