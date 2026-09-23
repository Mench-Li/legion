// 探针：量 whitelist-port 的真实行为（只读）。
const { translateToolName, reverseRouting, createWhitelistPort, whitelistPortFromEnv } =
  await import('../runtime/dsh-composition/whitelist-port.mjs')

console.log('=== 反查路由表 ===')
const back = reverseRouting()
for (const [dsh, legions] of [...back.entries()].sort()) {
  console.log(`  ${dsh.padEnd(12)} -> ${JSON.stringify(legions)}`)
}

console.log('\n=== 翻译四态 ===')
for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'web_fetch', 'web_search', 'delete-file', 'delete_file', 'todowrite', '']) {
  const r = translateToolName({ toolName: name })
  console.log(`  ${JSON.stringify(name).padEnd(14)} state=${r.state.padEnd(10)} legion=${String(r.legionTool).padEnd(20)} code=${r.code ?? '-'} cands=${JSON.stringify(r.candidates)}`)
}

console.log('\n=== 环境装配 ===')
console.log('  空 env:', JSON.stringify(whitelistPortFromEnv({ env: {} }).state))
const permit = {
  version: 'legion/employee-manifest@1',
  employeeId: 'e-1', role: 'reader', displayName: '只读岗',
  unattended: false,
  allowedTools: ['read-file'],
  allowedCapabilities: ['file:read'],
  maxRisk: 'low',
  workspaceRoot: null,
}
const built = whitelistPortFromEnv({ env: { LEGION_EMPLOYEE_PERMIT: JSON.stringify(permit) } })
console.log('  配了:', built.state, built.reason ?? '')
if (built.port) {
  for (const [name, args] of [['read', { path: 'C:/work/a.txt' }], ['write', { path: 'C:/work/a.txt' }], ['bash', { command: ['git', 'status'] }]]) {
    const v = built.port({ toolName: name, arguments: args, capabilities: ['file:read'], scopeFacts: null })
    console.log(`    ${name.padEnd(8)} allowed=${v.allowed} rule=${v.rule ?? '-'} ${String(v.reason ?? '').slice(0, 90)}`)
  }
}
console.log('\n  坏 JSON ⇒ 必须抛:', (() => { try { whitelistPortFromEnv({ env: { LEGION_EMPLOYEE_PERMIT: '{' } }); return 'NO-THROW' } catch (e) { return e.code } })())
