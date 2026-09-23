// 第 6 轮诊断探针：为什么跨进程夹具里 `legionEnforcementRoot` 没被发布。
//
// 背景：`orchestrator/worker/runtime-contract-cross-process.test.mjs` 的场景 A 里，
// 真补丁层声明的两行
//   · legion-enforcement-runtime-host-registrar
//   · legion-enforcement-runtime-contract-server
// 都被报成「行已挂载但未激活（等待依赖服务）」。这两行都 `inject: ['legionEnforcementRoot']`，
// 所以根因指向 `legion-enforcement-root` 那一行（模块 = team-hub/approval-registrar-row.mjs）
// 没有把服务发布出来。
//
// 本探针**不改任何产品代码**，只把同一个部署跑一遍并把**子进程的完整 stderr** 打出来 ——
// 测试套件把子进程 stderr 吞掉了，只留一句自检结论，看不到那一行为什么没发布。
//
// 用法：node scripts/probes/_r6-probe-root.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DSH = process.env.DSH_CHECKOUT ?? 'D:\\project\\DSH\\dsh\\deepseek-harness'
const CLI = join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const fileUrl = (p) => `file:///${p.replace(/\\/g, '/')}`

if (!existsSync(CLI)) {
  console.error(`DSH CLI 不在：${CLI}（设 DSH_CHECKOUT 指向检出）`)
  process.exit(2)
}

const PROFILE_NAME = 'r6probe'
const SCRATCH = mkdtempSync(join(tmpdir(), 'r6probe-'))
const home = join(SCRATCH, 'home')
const profileDir = join(home, 'profiles', PROFILE_NAME)
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: `dsh-profile-${PROFILE_NAME}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [], patchReload: 'startup' } },
}, null, 2) + '\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 空用户层\n[]\n')

const SERVICES_SRC = `const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'r6probe-services',
  inject: [],
  apply(ctx) {
    note('SERVICES-ROW-APPLY-RAN')
    ctx.provide('tools', { guard: () => () => undefined })
    ctx.provide('approval', {})
    ctx.provide('sandbox', {
      async confine(argv) {
        return {
          enforcement: 'full',
          backend: 'r6probe-stub-backend',
          argv: ['r6probe-stub-sandbox', '--', ...argv],
          denialSignatures: ['operation not permitted'],
        }
      },
    })
    note('SERVICES-PROVIDED tools,approval,sandbox')
  },
}
`
const SERVICES_PATCH = `- insert:
    - id: "r6probe-services"
      name: "./r6probe-services.mjs"
`
const PERMISSION_SRC = `export default {
  name: 'r6probe-permission-standin',
  inject: [],
  apply() { process.stderr.write('PERMISSION-STANDIN-APPLY-RAN\\n') },
}
`
const PERMISSION_PATCH = `- insert:
    - id: "permission"
      name: "./r6probe-permission.mjs"
      config:
        presets:
          workspace-write:
            sandbox: "workspace-write"
            approval: "ask"
          danger-full-access:
            sandbox: "danger-full-access"
            approval: "never"
`
const RUNTIME_ROWS_PATCH = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'approval-answerer-row.mjs'))}
`
// 只注册工厂、不挂产品行 —— 与测试夹具修好之后的形状一致。
const FACTORY_SRC = `import './r6probe-registrar.mjs'
export default { name: 'r6probe-factory', inject: [], apply() {} }
`
const FACTORY_PATCH = `- insert:
    - id: "r6probe-factory"
      name: "./r6probe-factory.mjs"
`
const REGISTRAR_SRC = `import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-row.mjs')))}
import { unregisterRuntimeHostInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-registrar-row.mjs')))}
import { setRuntimeContractInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-contract-server-row.mjs')))}
import { REQUIRED_CAPABILITIES } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'contracts', 'adapter.mjs')))}
import { SUPPORTED_RUNTIME } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'adapters', 'dsh', 'probe.mjs')))}

function buildRuntimeHost() {
  return {
    async probeRuntime() {
      return {
        version: SUPPORTED_RUNTIME.supportedMajor + '.1.5',
        capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true])),
      }
    },
    async startRun() {
      return { result: Promise.resolve({ stopReason: 'completed' }), async dispose() {} }
    },
    currentModelSelection: () => ({ provider: 'r6probe-provider', model: 'r6probe-model' }),
  }
}

unregisterRuntimeHostInputsFactory()
setDshRuntimeInputsFactory(() => ({ runtimeHost: buildRuntimeHost(), canRead: () => true }))
setRuntimeContractInputsFactory(() => ({
  host: '127.0.0.1',
  bindPort: 0,
  dataDir: process.env.R6PROBE_DATA_DIR ?? null,
}))
`
// 探针行：只把"根服务在不在"以及它的读数打出来。
const PROBE_SRC = `import { observeComposition } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-row.mjs')))}
const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'r6probe-probe',
  inject: [],
  apply(ctx) {
    setTimeout(() => {
      // ★ 先量"我能不能认出我自己"：本行的 ctx.fiber 与 loader 里本行那条的 fiber
      //   是不是同一个对象。这是修自指测量唯一要依赖的机制，所以先量再用。
      const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
      const own = ctx.fiber ?? null
      note('SELF-FIBER ' + (own === null ? 'null' : 'present') + ' state=' + String(own?.state ?? 'n/a') + ' name=' + String(own?.name ?? 'n/a'))
      if (loader !== undefined && loader !== null && typeof loader.entries === 'function') {
        let matched = 0
        for (const e of loader.entries()) {
          const f = e?.fiber ?? null
          const same = f !== null && f === own
          if (same) matched += 1
          note('ENTRY id=' + String(e?.options?.id ?? '?') + ' state=' + String(f?.state ?? 'n/a')
            + ' name=' + String(f?.name ?? 'n/a') + ' isSelf=' + String(same))
        }
        note('SELF-MATCHED ' + matched)
      }
      const obs = observeComposition(ctx)
      note('OBS-ROWS ' + JSON.stringify((obs?.rows ?? []).map((r) => [r.id, r.activated, r.present])))

      const root = typeof ctx.get === 'function' ? ctx.get('legionEnforcementRoot') : undefined
      note('ROOTSVC ' + (root === undefined ? 'absent' : 'present'))
      if (root !== undefined && root !== null) {
        note('ROOT-OK ' + String(root.ok) + ' code=' + String(root.code ?? 'none'))
      }
      const binding = typeof ctx.get === 'function' ? ctx.get('legionRuntimeHostBinding') : undefined
      note('BINDING ' + (binding === undefined ? 'absent' : 'present'))
      if (binding !== undefined && binding !== null) {
        note('BINDING-OK ' + String(binding.ok) + ' code=' + String(binding.code ?? 'none'))
        note('BINDING-INNER ' + String(binding.innerCode ?? 'none'))
        const failed = (binding.checks ?? []).filter((c) => c?.ok !== true)
        note('BINDING-FAILED-CHECKS ' + JSON.stringify(failed.map((c) => c.name)))
        for (const c of failed) {
          note('BINDING-REASON ' + c.name + ' :: ' + (c.reasons ?? []).join(' | ').slice(0, 400))
        }
      }
      note('PROBE-DONE')
    }, 6000)
  },
}
`
const PROBE_PATCH = `- insert:
    - id: "r6probe-probe"
      name: "./r6probe-probe.mjs"
`

const write = (name, body) => {
  const p = join(SCRATCH, name)
  writeFileSync(p, body)
  return p
}
const patches = [
  write('r6probe-services.mjs', SERVICES_SRC),
  write('r6probe-services.patch.yml', SERVICES_PATCH),
  write('r6probe-permission.mjs', PERMISSION_SRC),
  write('r6probe-permission.patch.yml', PERMISSION_PATCH),
  join(REPO, 'runtime', 'dsh-composition', 'legion-host.patch.yml'),
  write('r6probe-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH),
  write('r6probe-registrar.mjs', REGISTRAR_SRC),
  write('r6probe-factory.mjs', FACTORY_SRC),
  write('r6probe-factory.patch.yml', FACTORY_PATCH),
  write('r6probe-probe.mjs', PROBE_SRC),
  write('r6probe-probe.patch.yml', PROBE_PATCH),
].filter((p) => p.endsWith('.patch.yml'))

const dataDir = join(SCRATCH, 'legion-data')
mkdirSync(dataDir, { recursive: true })

const args = ['--profile', PROFILE_NAME]
for (const p of patches) args.push('--patch', p)

const env = {
  ...process.env,
  DSH_HOME: home,
  R6PROBE_DATA_DIR: dataDir,
  // ★ 与夹具**逐字一致**：漏掉它会让根行以 ENFORCEMENT_ROOT_NO_HUB_URL 拒绝，
  //   那是"探针没照抄夹具"，不是夹具的缺陷（第一版就踩了这个）。
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'r6probe-actor',
  LEGION_SCOPE: 'r6probe-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
}
delete env.DSH_SNAPSHOT

const r = spawnSync(process.execPath, [CLI, ...args], {
  cwd: SCRATCH, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
})

console.log('=== exit:', r.status, 'signal:', r.signal ?? null, '===')
console.log('=== STDERR ===')
console.log(r.stderr ?? '(empty)')
console.log('=== STDOUT ===')
console.log((r.stdout ?? '(empty)').slice(0, 3000))
console.log('=== scratch:', SCRATCH)
