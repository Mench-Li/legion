// 探针：量「产品配置 runtime.env 里的强制面五把键，到底能不能到 Runtime 子进程」
// 只读，不改任何文件。
import { resolveEnforcementIdentity, ENFORCEMENT_IDENTITY_ENV } from '../product/launcher/enforcement-identity.mjs'
import { buildChildEnv } from '../product/launcher/allowlist.mjs'
import { PROCESS_SPECS } from '../product/process-manifest.mjs'

const runtimeProc = PROCESS_SPECS.find((p) => p.key === 'runtime')
console.log('runtime 进程 envNames 里有没有这五把键：')
for (const k of ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS', 'LEGION_EXECUTION_SCOPE', 'LEGION_EXTERNAL_API_SCOPE', 'LEGION_EMPLOYEE_PERMIT']) {
  console.log(`  ${k.padEnd(30)} ${runtimeProc.envNames.includes(k) ? '有' : '✖ 没有'}`)
}

// ① 身份解析：把五把键都放进 runtime.env，看它输出哪几个。
const runtimeEnv = {
  LEGION_ACTOR: 'alice',
  LEGION_SCOPE: 'space-1',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_PATH_SCOPE: '{"platform":"win32","read":["C:/work"],"write":[]}',
  LEGION_CONNECTOR_DECLARATIONS: '[]',
  LEGION_EXECUTION_SCOPE: '{"command":{"programs":["git"]}}',
  LEGION_EXTERNAL_API_SCOPE: '{"endpoints":[]}',
  LEGION_EMPLOYEE_PERMIT: '{"employeeId":"e1"}',
}
const out = resolveEnforcementIdentity({
  configured: runtimeEnv,
  teamHubPort: 8787,
  cwd: 'C:/work',
})
console.log('\n① resolveEnforcementIdentity 输出的键：')
console.log('  values =', JSON.stringify(Object.keys(out.values ?? {})))
console.log('  ok =', out.ok, '| missing =', JSON.stringify((out.missing ?? []).map((m) => m.field)))

// ② 把它的输出当 values 喂给 buildChildEnv，看最终子进程拿到哪几个。
const built = buildChildEnv({
  spec: runtimeProc,
  baseEnv: {},
  values: { ...(out.values ?? {}) },
})
console.log('\n② 子进程最终拿到的键：')
console.log('  env =', JSON.stringify(Object.keys(built.env)))
for (const k of ['LEGION_PATH_SCOPE', 'LEGION_EXECUTION_SCOPE', 'LEGION_EXTERNAL_API_SCOPE', 'LEGION_EMPLOYEE_PERMIT']) {
  console.log(`  ${k.padEnd(30)} ${k in built.env ? '✅ 到了' : '✖ 没到（配了也没用）'}`)
}

// ③ 那么"从宿主环境继承"这条路呢？baseEnv 里放一个，看它过不过。
const viaBase = buildChildEnv({
  spec: runtimeProc,
  baseEnv: { LEGION_EMPLOYEE_PERMIT: '{"employeeId":"e1"}' },
  values: {},
})
console.log('\n③ 宿主环境（baseEnv）这条路：')
console.log(`  LEGION_EMPLOYEE_PERMIT ${'LEGION_EMPLOYEE_PERMIT' in viaBase.env ? '✅ 到了' : '✖ 被丢掉'}（dropped=${JSON.stringify(viaBase.dropped)}）`)
