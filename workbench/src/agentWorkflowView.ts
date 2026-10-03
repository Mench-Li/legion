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
