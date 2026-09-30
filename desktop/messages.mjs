const remedies = Object.freeze({
  ENFORCEMENT_IDENTITY_MISSING: '缺少执行身份配置，请完成首次设置。',
  ENTRY_UNRESOLVED: '安装文件不完整，请重新安装 Legion。',
  PORT_IN_USE: '服务端口被其他程序占用，请关闭冲突程序后重试。',
  BRIDGE_EXITED: '后台服务控制已中断，请重新打开 Legion。',
})

export function failureMessage(code) {
  return remedies[code] ?? '请查看诊断信息后重试。'
}
