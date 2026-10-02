const remedies = Object.freeze({
  ENFORCEMENT_IDENTITY_MISSING: '缺少执行身份配置，请完成首次设置。',
  MODEL_NOT_CONFIGURED: '模型尚未完成安全配置和连通性验证。',
  MODEL_PROBE_AUTH_FAILED: 'API Key 被 DeepSeek 拒绝，请检查密钥后重试。',
  MODEL_PROBE_MODEL_NOT_FOUND: '默认模型未在当前 DeepSeek 服务中开放，请检查账户或联系管理员。',
  MODEL_PROBE_ENDPOINT_UNREACHABLE: '无法连接 DeepSeek 服务，请检查网络后重试。',
  MODEL_PROBE_TLS_FAILED: '安全连接 DeepSeek 服务失败，请检查系统证书和网络代理。',
  MODEL_PROBE_TIMEOUT: '连接 DeepSeek 服务超时，请稍后重试。',
  MODEL_PROBE_RATE_LIMITED: 'DeepSeek 服务暂时限制了请求，请稍后重试。',
  ENTRY_UNRESOLVED: '安装文件不完整，请重新安装 Legion。',
  PORT_IN_USE: '服务端口被其他程序占用，请关闭冲突程序后重试。',
  BRIDGE_EXITED: '后台服务控制已中断，请重新打开 Legion。',
  BRIDGE_TIMEOUT: '后台操作超时，请先停止服务，再重试。',
  BRIDGE_EXIT_TIMEOUT: '后台进程尚未退出，请稍后重试退出。',
  STOP_FAILED: '后台服务尚未全部停止，请查看运行状态后重试。',
})

const portServices = Object.freeze({
  'team-hub': 'team-hub 数据服务',
  workbench: 'Workbench 工作台',
  runtime: 'DSH 执行引擎',
  whiteboard: 'Whiteboard 服务',
})

export function failureMessage(code) {
  return remedies[code] ?? '请查看诊断信息后重试。'
}

export function portConflictMessage(conflict) {
  if (!conflict || typeof conflict !== 'object' || !Object.hasOwn(portServices, conflict.process)
    || !Number.isInteger(conflict.port) || conflict.port < 1 || conflict.port > 65535
    || typeof conflict.listening !== 'boolean') return ''
  const condition = conflict.listening ? '已有进程正在监听' : '绑定检查失败'
  return `${portServices[conflict.process]}需要端口 ${conflict.port}，${condition}。\n`
    + `PowerShell 查看占用：Get-NetTCPConnection -LocalPort ${conflict.port} -State Listen | Select-Object LocalPort,OwningProcess`
}
