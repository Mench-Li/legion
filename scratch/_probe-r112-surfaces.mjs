// 探针：量出**生产组合根**的强制面读数（只读，不改任何文件）。
// 判据是代码自己的回答，不是文档里的说法。
const out = await import('../runtime/dsh-composition/root.mjs').catch((e) => ({ __err: e }))
if (out.__err) {
  console.log('IMPORT-FAIL', out.__err.message)
  process.exit(1)
}

const { installEnforcementRoot, resetEnforcementRoot } = out

const minEnv = {
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'alice',
  LEGION_SCOPE: 'space-1',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: 'C:/work',
}

// ① 生产今天的样子：环境里没有任何范围表。
resetEnforcementRoot()
const bare = installEnforcementRoot({
  env: { ...minEnv },
  decide: () => ({ kind: 'allow' }),
  createRequestApproval: () => (async () => 'rejected'),
  pathScope: null,
})
console.log('bare.ok =', bare.ok, bare.ok ? '' : `${bare.code} ${bare.message}`)
if (bare.ok) {
  console.log('bare surfaces =', JSON.stringify(bare.root.enforcementSurfaces(), null, 2))
}
resetEnforcementRoot()

// ② 配了范围表之后：每一道各自翻 true（证明"没配"不是"恒 false"）。
const { scopePortFromEnv, SCOPE_PORT_ENV_KEY } = await import('../runtime/dsh-composition/scope-port.mjs')
const { executionScopePortFromEnv, EXECUTION_SCOPE_PORT_ENV_KEY } =
  await import('../runtime/dsh-composition/execution-scope-port.mjs')
const { externalApiScopePortFromEnv, EXTERNAL_API_SCOPE_PORT_ENV_KEY } =
  await import('../runtime/dsh-composition/external-api-scope-port.mjs')

const env2 = {
  ...minEnv,
  [SCOPE_PORT_ENV_KEY]: JSON.stringify({ platform: process.platform === 'win32' ? 'win32' : 'linux', read: ['C:/work'], write: [] }),
  [EXECUTION_SCOPE_PORT_ENV_KEY]: JSON.stringify({ command: { programs: ['git'] } }),
  [EXTERNAL_API_SCOPE_PORT_ENV_KEY]: JSON.stringify({
    endpoints: [{ host: 'api.example.com', pattern: '/api/items/{id}', effects: ['read'], idempotent: true }],
  }),
}
resetEnforcementRoot()
const wired = installEnforcementRoot({
  env: env2,
  decide: () => ({ kind: 'allow' }),
  createRequestApproval: () => (async () => 'rejected'),
  pathScope: scopePortFromEnv({ env: env2 }).port,
  executionScope: executionScopePortFromEnv({ env: env2 }).port,
  externalApiScope: externalApiScopePortFromEnv({ env: env2 }).port,
})
console.log('wired.ok =', wired.ok, wired.ok ? '' : `${wired.code} ${wired.message}`)
if (wired.ok) {
  console.log('wired surfaces =', JSON.stringify(wired.root.enforcementSurfaces(), null, 2))
  // 真实裁决：越权命令必须被拒。
  const v = await wired.root.bridge.preExecute({
    name: 'run-command', callId: 'c1', arguments: { command: ['rm', '-rf', '/'] },
  })
  console.log('越权命令裁决 =', v.kind, '|', String(v.reason).slice(0, 120))
}
resetEnforcementRoot()

// ③ 白名单那一道：生产装配有没有给它值。
console.log('whitelist 在生产入参里 =', 'n/a（见 production-scope-wiring.test.mjs ②）')
