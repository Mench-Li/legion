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
  BACKEND_WORKSPACE_MISMATCH: '当前后台属于另一个工作区，请连接对应工作区或先停止后台。',
  BACKEND_VERSION_MISMATCH: '当前后台与桌面端版本不一致，请更新到同一版本后重试。',
  BACKEND_STARTING: '共享后台正在启动，请稍后重试。',
  BACKEND_UNAVAILABLE: '共享后台无法连接，请检查原启动入口的运行状态。',
  BACKEND_RESTART_FAILED: '共享后台重启失败，请检查后台状态后重试。',
  BACKEND_DISCOVERY_INVALID: '共享后台的运行记录无法验证，请检查后台状态后重试。',
  BACKEND_IDENTITY_MISMATCH: '共享后台的身份不匹配，请检查运行记录后重试。',
  /**
   * ★ 升级期间的两次启动拒绝。
   *
   *   这两个码在此之前**不在表里**，于是落到下面那句兜底
   *   「请查看诊断信息后重试。」——而它显示在「Legion 暂时无法启动」这个
   *   标题之下。
   *
   *   也就是说：用户在一次正常升级进行中重新打开 Legion，看到的是
   *   **"这个软件坏了"**，而事实是"升级正在进行，请等它做完"。
   *
   *   一句话的差别在这里是**全部**的差别：前者会让人去重装、去删数据目录、
   *   去联系管理员，而其中任何一个动作都可能把一次正在进行的升级弄坏。
   *
   *   > 一个"看起来像故障"的正常状态，
   *   > 会换来用户针对故障才该做的处置。
   */
  UPDATE_MAINTENANCE: 'Legion 正在升级或维护中，请稍候再打开。升级完成后会自动恢复。',
  UPDATE_TRANSACTION_UNFINISHED: '上一次升级尚未结束，Legion 正在按记录恢复。请稍候再打开；'
    + '如果长时间停在这里，请联系管理员，**不要**删除数据目录。',
  // ★ 这张表**只**放桌面端自己的码（`main.mjs` / `bridge` 报上来的）。
  //   自动更新客户端的码（`update-*`）由 `product/update/errors.mjs` 的
  //   `ERROR_TEXT` 负责，而面板显示的是客户端给出的整句 `reason`——
  //   在这里再放一份会让同一个码有**两个**文案来源，改了其中一个就会分叉。
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
