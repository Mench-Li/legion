// runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs
// ============================================================================
// PRT-253（Runtime 宿主绑定解阻批）：**在真 DSH 进程里**读"绑定变了没有"。
//
// ## 这套件要回答的四个问题（每一个都有一对读数，不是一个断言）
//
//   ① 拿掉那条残留的 `canRead` 要求之后，真进程里的绑定**变了吗**？
//      → `BEFORE-CONTROL`（把那条要求**原样装回**包装层）与 `AFTER`（生产注册方）
//        两条读数，且必须**不同形**。
//   ② 绑定**真的建立得起来**吗（不是"拒绝的理由变了"）？
//      → `BOUND`：自检通过、服务发布、`dshRuntimeBound() === true`、exit 0。
//        唯一替身是**能力探针**（见诚实边界）；`canRead` 在生产取值下**缺席**。
//   ③ 缺席被**如实**保留到底了吗？
//      → 同一个进程里问 `productionExecutorProvider()`：必须
//        `EXECUTOR_CAN_READ_REQUIRED`——绑定建立**不等于**权限被放松。
//   ④ `currentModelSelection` 接上真来源了吗？
//      → `MODEL-REAL`：**真的** `agent-default-model` 包按绝对路径挂进一次性 profile，
//        `ctx.get('agentDefaultModel')` 是那个**真服务**（不是用例替身）。
//        `MODEL-ABSENT`：不挂它 → `null` + `..._SERVICE_ABSENT`，**不编模型名**。
//
// ## 诚实边界（这套件**没有**证明的东西）
//
//   · `BOUND` 里 `probeRuntime` 的能力表是**用例替身**（四项全 true）。真探针
//     在一个真进程里只能确认 `structured-result`（`bundles: []` + 桩 provider），
//     所以真取值下的自检**必然**拒绝——`AFTER` 读的就是那条。绑定能建立这件事，
//     是在**一个**声明过的替身下读到的，不是一个真引擎下的读数。
//   · `BOUND` 里的 `startRun` 是**生产实现**（按引用转发到`subagents`），但**服务**
//     是替身（真进程里没有真引擎）——所以读数证明的是"端口 → 服务"这一跳通了，
//     **不是**"真 subagent 跑起来了"。
//   · 沙箱端口、`subagents` 是替身；组合补丁层用的是磁盘上那份真
//     `legion-host.patch.yml`（一个字节都不改），所以"组合树观察"与"强制面装配"
//     是真读数。
//   · `MODEL-REAL` 挂的是**真的** `@deepseek-ai/dsh-agent-default-model` 包，但它的
//     `provider` / `model` 是本次用例**显式配置**的两个值。也就是说：真服务、
//     真装载、真读法，配置值是声明的。**没有**证明"某个真实部署的 settings.yaml
//     会被读进来"（那需要 `settings` 服务，本套件不挂）。
//   · 全程没有真引擎、没有网络、没有真 profile。
//
// ## 安全（与同目录那两套件同一套，逐条成立）
//
//   一次性 `DSH_HOME`（`os.tmpdir()` 下，**spawn 之前断言**）、`bundles: []` +
//   `patchReload: 'startup'`、删掉 `DSH_SNAPSHOT`、`spawnSync` 超时、`after()` 整棵删。
//   **绝不**读写任何真实 profile（操作者那台机器的活 harness 是 `patchReload: 'live'`）。
//   **不建任何监听**（于是没有端口可撞）。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 判据取自**产品模块**（产品改了码而用例还绿着，正是要避免的事）。
import { RUNTIME_HOST_REGISTRAR_CODES, MODEL_SELECTION_CODES } from './runtime-host-registrar-row.mjs'
import { RUNTIME_HOST_BINDING_SERVICE, RUNTIME_HOST_ROW_CODES } from './runtime-host-row.mjs'
import { BOOTSTRAP_CODES } from '../bootstrap.mjs'
import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import { EXECUTOR_CODES } from '../../../orchestrator/worker/executor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(HERE, '..', '..', '..')
const REGISTRAR_ABS = join(HERE, 'runtime-host-registrar-row.mjs')
const RUNTIME_HOST_ROW_ABS = join(HERE, 'runtime-host-row.mjs')
const EXECUTOR_BINDING_ABS = join(ROOT_DIR, 'orchestrator', 'worker', 'executor-binding.mjs')
const ADAPTER_ABS = join(ROOT_DIR, 'runtime', 'adapters', 'dsh', 'index.mjs')
const CONTRACT_ROW_ABS = join(HERE, 'runtime-contract-server-row.mjs')
const REAL_PATCH = join(HERE, '..', 'legion-host.patch.yml')

const fileUrl = (p) => pathToFileURL(p).href

// ─────────────────────────────────────────── 可跑性判定（沿用同目录既有口径）

const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const CLI_PKG = DSH === null ? null : join(DSH, 'apps', 'cli', 'package.json')
/**
 * **真的** `agent-default-model` 包（不是用例替身）。
 *
 * 按**绝对路径**挂它，是为了不经过 profile 的依赖安装（那要网络）。
 * 它自己的 `node_modules` 在包里（pnpm workspace），所以按路径 import 能解析依赖。
 */
const REAL_MODEL_PKG = DSH === null ? null : join(DSH, 'packages', 'core', 'agent-default-model', 'lib', 'index.js')
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CLI)
    ? `DSH 检出里找不到 CLI（${CLI}）——未构建？`
    : !existsSync(CLI_PKG)
      ? `DSH 检出里找不到 CLI 的 package.json（${CLI_PKG}）`
      : false
const SKIP = UNAVAILABLE === false ? false : UNAVAILABLE

const guarded = (name, fn) => test(name, { timeout: 240_000 }, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

// ─────────────────────────────────────────── 一次性 DSH_HOME

const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-host-binding-bu-'))

const PROFILE_NAME = 'prt253bu'

const LEGION_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt253bu-actor',
  LEGION_SCOPE: 'prt253bu-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

const put = (name, file, text) => {
  const p = join(SCRATCH, file)
  writeFileSync(p, text)
  SCRATCH_PATH[name] = p
  return p
}

const SCRATCH_PATH = {}

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

function makeHome(tag) {
  const home = mkdtempSync(join(SCRATCH, `home-${tag}-`))
  assert.ok(resolve(home).startsWith(TMP_ROOT), `一次性 home 逃出了 tmpdir：${home}`)
  assert.ok(resolve(home).startsWith(SCRATCH), `一次性 home 逃出了本次运行的 scratch：${home}`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }, null, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 空用户层\n[]\n')
  return home
}

// ─────────────────────────────────────────── 桩宿主服务（沿用同目录那套件）

/**
 * 桩宿主服务：`tools` / `approval` / `sandbox` / `subagents`（引擎替身）。
 *
 * `agentDefaultModel` **刻意不在这里**：`MODEL-REAL` 挂的是真包，`MODEL-ABSENT`
 * 就是不挂它。把模型服务混进这套桩里，会让"真服务"与"用例替身"在读数上同形。
 */
const SERVICES_SRC = `// 桩宿主：只发布被测几行 inject 的服务 + 一个引擎替身。不是 ToolRuntime。
const note = (line) => process.stderr.write(line + '\\n')
const PROVIDER_NAME = 'prt253bu-spawn'
const HANDLE = {
  result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'prt253bu' }] }),
  dispose: async () => {},
}
export default {
  name: 'prt253bu-services',
  inject: [],
  apply(ctx) {
    note('SERVICES-ROW-APPLY-RAN')
    ctx.provide('tools', { guard() { return () => {} } })
    ctx.provide('approval', {})
    ctx.provide('sandbox', {
      async confine(argv) {
        return {
          enforcement: 'full',
          backend: 'prt253bu-stub-backend',
          argv: ['prt253bu-stub-sandbox', '--', ...argv],
          denialSignatures: ['operation not permitted'],
        }
      },
    })
    const provider = {
      name: PROVIDER_NAME,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start() { return HANDLE },
    }
    ctx.provide('subagents', {
      list: () => [PROVIDER_NAME],
      getProvider: (n) => (n === PROVIDER_NAME ? provider : undefined),
      async start(providerName, request) {
        note('SUBAGENTS-START-FORWARDED provider=' + providerName)
        return HANDLE
      },
    })
    note('SERVICES-PROVIDED tools,approval,sandbox,subagents')
  },
}
`

const SERVICES_PATCH_SRC = `- insert:
    - id: "prt253bu-services"
      name: "./prt253bu-services.mjs"
`

/** `permission` 行的替身（`bundles: []` 里没有它的靶子，沿用同目录那套件）。 */
const PERMISSION_SRC = `// 替身：只为让真补丁层的 patch-over 有靶子。
export default {
  name: 'prt253bu-permission-standin',
  inject: [],
  apply() { process.stderr.write('PERMISSION-STANDIN-APPLY-RAN\\n') },
}
`

const PERMISSION_PATCH_SRC = `- insert:
    - id: "permission"
      name: "./prt253bu-permission.mjs"
      config:
        presets:
          workspace-write:
            sandbox: "workspace-write"
            approval: "ask"
          danger-full-access:
            sandbox: "danger-full-access"
            approval: "never"
`

/** 运行期两行（`PATCH_LAYER_ROWS` 里 `module: null` 的那两行）按绝对路径挂。 */
const RUNTIME_ROWS_PATCH_SRC = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(HERE, 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(HERE, 'approval-answerer-row.mjs'))}
`

/** `AFTER`：那一行的模块**就是生产注册方**（与 `-dsh-process` 那套件的 R 同形）。 */
const PROD_ROW_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: ${JSON.stringify(REGISTRAR_ABS)}
`

// ─────────────────────────────────────────── ① 反向对照：把那条要求**装回去**

/**
 * `BEFORE-CONTROL`：同一份生产工厂，外面**原样装回**本批拿掉的那条要求。
 *
 * 为什么需要它：本批之前那条要求住在**生产代码**里，本批之后它不存在了。
 * 想在同一份代码上读到"之前是什么读数"，只有把那条门**显式重建**出来——
 * 唯一变量因此只有那一道门，而不是"版本不同所以别的也变了"。
 *
 * 它**不是**旧代码。真正的"before"原始读数（`git stash` 掉本批的生产改动、
 * 让同一行用**真旧代码**跑一遍）抄在文档 §4 里。
 */
const BEFORE_CONTROL_SRC = `import realRuntimeHostRow from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { createRuntimeHostInputsFactory, RUNTIME_HOST_REGISTRAR_CODES } from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
note('BEFORE-CONTROL-WRAPPER-EVALUATED')

// ★ 那道被拿掉的门，**逐字**装回来：没有 canRead 来源 → 具名拒绝。
setDshRuntimeInputsFactory((ctx) => {
  const built = createRuntimeHostInputsFactory()(ctx)
  if (typeof built.canRead !== 'function') {
    const error = new Error('BEFORE-CONTROL：把本批拿掉的那条要求原样装回（生产注册方过去就是这样拒绝的）')
    error.code = RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE
    throw error
  }
  return built
})

export default realRuntimeHostRow
`

const BEFORE_CONTROL_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: "./prt253bu-before-control.mjs"
`

// ─────────────────────────────────────────── ② 正例：绑定真的建立

/**
 * `BOUND`：生产注册方 + **一个**声明过的替身（能力探针），`canRead` 缺席。
 *
 * 替身的边界划得很窄：只把四项必需能力报成全具备，**版本仍然来自真探针**
 * （`process.argv[1]` 所属安装的 `package.json`），`startRun` 仍然是生产实现
 * （按引用转发到现场服务）。真探针在一个真进程里只能确认一项，所以不替换它
 * 就没有"绑定成功"这个读数——那正是本批之后**下一个**阻塞点。
 */
const BOUND_WRAPPER_SRC = `import realRuntimeHostRow from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { createRuntimeHostInputsFactory } from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
note('BOUND-WRAPPER-EVALUATED')

const ALL_TRUE = Object.freeze(${JSON.stringify(Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true])))})

setDshRuntimeInputsFactory((ctx) => {
  const base = createRuntimeHostInputsFactory()(ctx)
  // 真探针跑一次（**版本**从这里来，是真读数）。
  const realProbe = base.runtimeHost.probeRuntime()
  const runtimeHost = Object.freeze({
    ...base.runtimeHost,
    // ★ 本套件里**唯一**的替身：能力表。
    probeRuntime: () => ({ ...realProbe, capabilities: { ...ALL_TRUE } }),
  })
  // 把交出去的那一份记在 globalThis 上，脚手架才能在本进程里核对它的身份与行为。
  globalThis.__prt253buInputs = { runtimeHost, canRead: base.canRead }
  note('BOUND-WRAPPER-PROBED-VERSION ' + String(realProbe.version))
  note('BOUND-WRAPPER-CANREAD-KIND ' + (base.canRead === null ? 'null' : typeof base.canRead))
  return globalThis.__prt253buInputs
})

export default realRuntimeHostRow
`

const BOUND_WRAPPER_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: "./prt253bu-bound-wrapper.mjs"
`

/** `BOUND` 的脚手架：读绑定状态、读端口身份、读"缺席还在不在"。 */
const BOUND_SCAFFOLD_SRC = `import { RUNTIME_HOST_BINDING_SERVICE } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}
import { dshRuntimeBound, productionExecutorProvider } from ${JSON.stringify(fileUrl(EXECUTOR_BINDING_ABS))}

const note = (line) => process.stderr.write(line + '\\n')

export default {
  name: 'prt253bu-bound-scaffold',
  inject: [],
  apply(ctx) {
    note('BOUND-SCAFFOLD-APPLY-RAN')
    setTimeout(async () => {
      try {
        note('BOUND ' + String(dshRuntimeBound()))
        const svc = ctx.get(RUNTIME_HOST_BINDING_SERVICE)
        note('SERVICEOK ' + String(svc !== undefined && svc !== null ? svc.ok : 'no-service'))
        const inputs = globalThis.__prt253buInputs
        note('CAPTURED ' + String(inputs !== undefined))
        note('CAPTURED-CANREAD-KIND ' + (inputs === undefined ? 'no-capture' : (inputs.canRead === null ? 'null' : typeof inputs.canRead)))
        // 生产 startRun 的**转发**读数：交出去的那个端口调一次，真服务必须收到。
        const handle = await inputs.runtimeHost.startRun('prt253bu-spawn', { label: 'bu' })
        note('STARTFWD ' + String(handle !== undefined && handle !== null && handle.result !== undefined))
        // ★★ 缺席**没有**被放松：同一个绑定，问真正要执行的那一侧。
        if (handle && typeof handle.dispose === 'function') await handle.dispose()
        const provider = await productionExecutorProvider({
          post: async () => ({ status: 200, body: {} }),
          get: async () => ({ status: 200, body: {} }),
        })
        note('PROVIDEROK ' + String(provider.ok))
        note('PROVIDERCODE ' + String(provider.code))
        note('PROVIDERINNER ' + String(provider.innerCode))
      } catch (error) {
        note('BOUND-SCAFFOLD-THREW ' + String(error && error.message ? error.message : error))
      }
      note('BOUND-SCAFFOLD-EXIT-0')
      process.exit(0)
    }, 4000)
  },
}
`

const BOUND_SCAFFOLD_PATCH_SRC = `- insert:
    - id: "prt253bu-bound-scaffold"
      name: "./prt253bu-bound-scaffold.mjs"
`

// ─────────────────────────── ② 的脚手架：自检不兼容时**进程还活着**、端口**没绑上**

/**
 * 这一套读数就是本批那个开关的落点，四件事必须同时成立：
 *
 *   ① 进程**活着**走到脚手架（旧实现里它根本走不到——那一行抛了，整棵树加载失败）；
 *   ② 绑定服务**在**、而且是**具名拒绝**（`SELF_CHECK_INCOMPATIBLE`，带内层码）；
 *   ③ `dshRuntimeBound() === false`——**宿主端口没有被注册**，安全方向一点没放松；
 *   ④ 契约出口把这条拒绝翻成 `autoExecutionForbidden: true` + `incompatible`
 *      ——`line 854` 要的两条读数（状态 + 禁止执行）在这里会合成一个结论。
 *
 * ①与③必须**一起**读：只读①会得出"降级了"（危险），只读③得不出"进程还在"。
 * 分开之后才看得出这次改的到底是"安全性"还是"可见性"——答案是后者。
 */
const INCOMPAT_SCAFFOLD_SRC = `import { RUNTIME_HOST_BINDING_SERVICE } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}
import { verdictFromRuntimeHostBinding } from ${JSON.stringify(fileUrl(CONTRACT_ROW_ABS))}
import { dshRuntimeBound, productionExecutorProvider } from ${JSON.stringify(fileUrl(EXECUTOR_BINDING_ABS))}

const note = (line) => process.stderr.write(line + '\\n')

export default {
  name: 'prt253bu-incompat-scaffold',
  inject: [],
  apply(ctx) {
    note('INCOMPAT-SCAFFOLD-APPLY-RAN')
    setTimeout(async () => {
      try {
        // ★ 先量一件事：真 DSH 进程里到底有没有 ctx.logger。
        //   "组合层有没有日志出口"不能靠读代码猜——ctx.logger?.info?.() 在
        //   logger 缺席时**静默 no-op**，于是"记了"与"没记"在输出上同形。
        note('INCOMPATLOGGER ' + String(ctx.logger !== undefined && ctx.logger !== null))
        note('INCOMPATLOGGERWARN ' + String(typeof ctx.logger?.warn))
        const svc = ctx.get(RUNTIME_HOST_BINDING_SERVICE)
        const present = svc !== undefined && svc !== null
        const read = (k) => String(present ? svc[k] : 'no-service')
        // ② 服务在、且是具名拒绝
        note('INCOMPATSERVICEPRESENT ' + String(present))
        note('INCOMPATOK ' + read('ok'))
        note('INCOMPATCODE ' + read('code'))
        note('INCOMPATINNER ' + read('innerCode'))
        note('INCOMPATSTATE ' + read('state'))
        note('INCOMPATFORBID ' + read('autoExecutionForbidden'))
        note('INCOMPATREPAIR ' + String(present && svc.repair !== null && svc.repair !== undefined))
        // ③ 端口**没有**被注册
        note('INCOMPATBOUND ' + String(dshRuntimeBound()))
        // ④ 契约出口翻出来的那一份
        const v = verdictFromRuntimeHostBinding(present ? svc : null)
        note('INCOMPATVERDICTNULL ' + String(v === null))
        note('INCOMPATVERDICTFORBID ' + String(v === null ? 'null' : v.autoExecutionForbidden))
        note('INCOMPATVERDICTSTATE ' + String(v === null ? 'null' : v.state))
        // 真正要执行的那一侧照样拒绝
        const provider = await productionExecutorProvider({
          post: async () => ({ status: 200, body: {} }),
          get: async () => ({ status: 200, body: {} }),
        })
        note('INCOMPATPROVIDEROK ' + String(provider.ok))
        note('INCOMPATPROVIDERCODE ' + String(provider.code))
      } catch (error) {
        note('INCOMPAT-SCAFFOLD-THREW ' + String(error && error.message ? error.message : error))
      }
      note('INCOMPAT-SCAFFOLD-EXIT-0')
      process.exit(0)
    }, 4000)
  },
}
`

const INCOMPAT_SCAFFOLD_PATCH_SRC = `- insert:
    - id: "prt253bu-incompat-scaffold"
      name: "./prt253bu-incompat-scaffold.mjs"
`

// ─────────────────────────────────────────── ③ 反向对照：挂一个**不是函数**的 canRead

const BAD_CANREAD_SRC = `import realRuntimeHostRow from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
note('BAD-CANREAD-WRAPPER-EVALUATED')

const PORT = Object.freeze({
  async startRun() { return { result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} } },
  async probeRuntime() { return { version: '0.0.0-control', capabilities: {} } },
})

// 不是函数、也不是 null/undefined → 本行**当场拒**，不静默丢掉。
setDshRuntimeInputsFactory(() => ({ runtimeHost: PORT, canRead: 'yes' }))

export default realRuntimeHostRow
`

const BAD_CANREAD_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: "./prt253bu-bad-canread.mjs"
`

// ─────────────────────────────────────────── ④ 模型选择：真服务 / 缺席

/**
 * **真的** `agent-default-model` 包，按绝对路径挂进一次性 profile。
 *
 * 这就是 DSH 自己的那一行（基础组合层里 id 也叫 `agent-default-model`），
 * 只是 `name` 换成检出里的绝对路径——于是**不需要** profile 依赖安装（不联网）。
 * 配置值是本次用例声明的两个值（见诚实边界）。
 */
const REAL_MODEL_PATCH_SRC = `- insert:
    - id: "agent-default-model"
      name: ${JSON.stringify(REAL_MODEL_PKG === null ? '/nonexistent' : REAL_MODEL_PKG)}
      config:
        provider: "prt253bu-real-provider"
        model: "prt253bu-real-model"
`

const MODEL_SELECTION_SRC = JSON.stringify({ provider: 'prt253bu-real-provider', model: 'prt253bu-real-model' })

/** 模型读数脚手架：真读法 + 真适配器归一化。`agentDefaultModel` 挂不挂由补丁层决定。 */
const MODEL_SCAFFOLD_SRC = `import { createRuntimeHostInputsFactory, readModelSelection } from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { createDshRuntimeAdapter } from ${JSON.stringify(fileUrl(ADAPTER_ABS))}

const note = (line) => process.stderr.write(line + '\\n')

export default {
  name: 'prt253bu-model-scaffold',
  inject: [],
  apply(ctx) {
    note('MODEL-SCAFFOLD-APPLY-RAN')
    setTimeout(async () => {
      try {
        const service = ctx.get('agentDefaultModel')
        note('MODELSERVICEPRESENT ' + String(service !== undefined && service !== null))
        note('MODELSERVICECLASS ' + String(service === undefined || service === null ? 'none' : (service.constructor && service.constructor.name)))
        const reading = readModelSelection(ctx)
        note('MODELSELECTIONCODE ' + reading.code)
        note('MODELSELECTION ' + JSON.stringify(reading.selection))
        const port = createRuntimeHostInputsFactory()(ctx)
        note('PORTSELECTION ' + JSON.stringify(port.runtimeHost.currentModelSelection()))
        const adapter = createDshRuntimeAdapter(port.runtimeHost)
        const models = await adapter.listModels()
        note('LISTMODELS ' + JSON.stringify(models.map((m) => ({ id: m.id, provider: m.provider, model: m.model }))))
        const sel = await adapter._selection()
        note('ADAPTERSELECTION ' + JSON.stringify(sel === null ? null : { provider: sel.provider, model: sel.model, runtimeType: sel.runtimeType }))
      } catch (error) {
        note('MODEL-SCAFFOLD-THREW ' + String(error && error.message ? error.message : error))
      }
      note('MODEL-SCAFFOLD-EXIT-0')
      process.exit(0)
    }, 4000)
  },
}
`

const MODEL_SCAFFOLD_PATCH_SRC = `- insert:
    - id: "prt253bu-model-scaffold"
      name: "./prt253bu-model-scaffold.mjs"
`

// ─────────────────────────────────────────── 落盘与前置断言

put('services', 'prt253bu-services.mjs', SERVICES_SRC)
put('servicesPatch', 'prt253bu-services.patch.yml', SERVICES_PATCH_SRC)
put('permission', 'prt253bu-permission.mjs', PERMISSION_SRC)
put('permissionPatch', 'prt253bu-permission.patch.yml', PERMISSION_PATCH_SRC)
put('runtimeRowsPatch', 'prt253bu-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH_SRC)
put('prodRowPatch', 'prt253bu-prod-row.patch.yml', PROD_ROW_PATCH_SRC)
put('beforeControl', 'prt253bu-before-control.mjs', BEFORE_CONTROL_SRC)
put('beforeControlPatch', 'prt253bu-before-control.patch.yml', BEFORE_CONTROL_PATCH_SRC)
put('boundWrapper', 'prt253bu-bound-wrapper.mjs', BOUND_WRAPPER_SRC)
put('boundWrapperPatch', 'prt253bu-bound-wrapper.patch.yml', BOUND_WRAPPER_PATCH_SRC)
put('boundScaffold', 'prt253bu-bound-scaffold.mjs', BOUND_SCAFFOLD_SRC)
put('boundScaffoldPatch', 'prt253bu-bound-scaffold.patch.yml', BOUND_SCAFFOLD_PATCH_SRC)
put('incompatScaffold', 'prt253bu-incompat-scaffold.mjs', INCOMPAT_SCAFFOLD_SRC)
put('incompatScaffoldPatch', 'prt253bu-incompat-scaffold.patch.yml', INCOMPAT_SCAFFOLD_PATCH_SRC)
put('badCanRead', 'prt253bu-bad-canread.mjs', BAD_CANREAD_SRC)
put('badCanReadPatch', 'prt253bu-bad-canread.patch.yml', BAD_CANREAD_PATCH_SRC)
put('realModelPatch', 'prt253bu-real-model.patch.yml', REAL_MODEL_PATCH_SRC)
put('modelScaffold', 'prt253bu-model-scaffold.mjs', MODEL_SCAFFOLD_SRC)
put('modelScaffoldPatch', 'prt253bu-model-scaffold.patch.yml', MODEL_SCAFFOLD_PATCH_SRC)

assert.ok(existsSync(REAL_PATCH), `真补丁层不在：${REAL_PATCH}`)
for (const p of [REGISTRAR_ABS, RUNTIME_HOST_ROW_ABS, EXECUTOR_BINDING_ABS, ADAPTER_ABS,
  join(HERE, 'pre-execute-row.mjs'), join(HERE, 'approval-answerer-row.mjs')]) {
  assert.ok(existsSync(p), `本套件依赖的模块不在：${p}`)
}

// ─────────────────────────────────────────── 跑一次真 dsh

function runDsh(scenario) {
  const home = makeHome(scenario.tag)
  const args = ['--profile', PROFILE_NAME]
  for (const patch of scenario.patches) args.push('--patch', patch)

  const env = { ...process.env, DSH_HOME: home, ...LEGION_ENV }
  delete env.DSH_SNAPSHOT

  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: SCRATCH,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  })

  return {
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error === undefined ? null : String(result.error.message ?? result.error),
  }
}

/** 从 stderr 里读一个 `KEY value` 读数；读不到返回 `null`（不猜默认值）。 */
function reading(stderr, key) {
  const m = new RegExp(`^${key} (.+)$`, 'm').exec(stderr)
  return m === null ? null : m[1].trim()
}

/** 基础补丁层：服务桩 + permission 靶子 + **磁盘上那份真补丁层** + 两行运行期模块。 */
const basePatches = () => [
  SCRATCH_PATH.servicesPatch,
  SCRATCH_PATH.permissionPatch,
  REAL_PATCH,
  SCRATCH_PATH.runtimeRowsPatch,
]

const READINGS = { before: null, after: null, bound: null, badCanRead: null, modelReal: null, modelAbsent: null }

describe('PRT-253 解阻批：真 DSH 进程里的绑定读数', () => {
  guarded('① 反向对照：把那条要求**装回**包装层 → `INPUTS_FACTORY_THREW(NO_CAN_READ_SOURCE)`', (t) => {
    const r = runDsh({
      tag: 'before',
      patches: [...basePatches(), SCRATCH_PATH.beforeControlPatch],
    })
    assert.equal(r.spawnError, null)
    assert.match(r.stderr, /^BEFORE-CONTROL-WRAPPER-EVALUATED$/m, r.stderr)
    assert.equal(r.code, 1, `期望"没有 canRead 来源"拦下启动：\n${r.stderr}`)
    // 具名码本身 + 内层码，两条都断言（不写"它抛了"）。
    assert.ok(r.stderr.includes(RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW),
      `没有读到 ${RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW}：\n${r.stderr}`)
    assert.ok(r.stderr.includes(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE),
      `没有读到 ${RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE}：\n${r.stderr}`)
    READINGS.before = {
      code: RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW,
      inner: RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
      exit: r.code,
    }
    t.diagnostic(`BEFORE-CONTROL: exit=${r.code} ${READINGS.before.code}(${READINGS.before.inner})`)
  })

  guarded('② ★★★ 生产注册方当那一行的模块 → 工厂**成功**；自检不兼容时**不抛**，进程活着、端口没绑上', (t) => {
    const r = runDsh({
      tag: 'after',
      patches: [...basePatches(), SCRATCH_PATH.prodRowPatch, SCRATCH_PATH.incompatScaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    // ★★★ 本批翻过来的那个取舍：**exit 0**。
    //   spec `line 854` 要的是「按 `incompatible` 处理并禁止自动执行」，
    //   而 §6.3 表格（`line 275`）把 `incompatible` 的行为定成
    //   「禁止自动执行，**提示修复或回滚**」——一个崩掉的进程提示不了任何东西。
    assert.equal(r.code, 0, `期望"进程活着并明说自己不能自动执行"，而不是启动失败：\n${r.stderr}`)
    assert.match(r.stderr, /^INCOMPAT-SCAFFOLD-APPLY-RAN$/m, r.stderr)
    // ① 进程活着走到脚手架 —— 旧实现里这一行根本到不了。
    assert.equal(r.stderr.includes('INCOMPAT-SCAFFOLD-THREW'), false,
      `脚手架抛了，读数没取全：\n${r.stderr}`)
    // ★★ 与①**不同形**：那条要求没有了。
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW), false,
      `工厂仍然抛了——那条要求没有被拿掉：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE), false,
      `仍然读到"没有 canRead 来源"的具名码：\n${r.stderr}`)
    // ★★★ 与**旧版**②也不同形：拒绝不再以 `BIND_REFUSED`（= 整树加载失败）出现。
    //   这一条是"开关真的翻了"的判据；少了它，下面那些断言在旧实现上也全绿。
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.BIND_REFUSED), false,
      `仍然读到 ${RUNTIME_HOST_ROW_CODES.BIND_REFUSED}——那一行还在抛：\n${r.stderr}`)

    // ② 服务**在**，而且是**具名**拒绝（不是"服务不在"，也不是笼统的 ok:false）
    assert.equal(reading(r.stderr, 'INCOMPATSERVICEPRESENT'), 'true',
      `自检不兼容时什么都没发布：\n${r.stderr}`)
    assert.equal(reading(r.stderr, 'INCOMPATOK'), 'false')
    assert.equal(reading(r.stderr, 'INCOMPATCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(reading(r.stderr, 'INCOMPATINNER'), BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
    // spec §6.3 表格里的那个状态值，加上"禁止自动执行"
    assert.equal(reading(r.stderr, 'INCOMPATSTATE'), 'incompatible')
    assert.equal(reading(r.stderr, 'INCOMPATFORBID'), 'true')
    assert.equal(reading(r.stderr, 'INCOMPATREPAIR'), 'true',
      '只报"不兼容"而不给修复入口 = 把 spec 要的"提示修复或回滚"又丢了一次')
    // ★★★ ③ 安全方向**一点没放松**：端口没有被注册。
    //   这一条与"进程活着"**必须一起读**——只读后者会得出"降级了"。
    assert.equal(reading(r.stderr, 'INCOMPATBOUND'), 'false',
      `宿主端口被注册了——那才是真的放松：\n${r.stderr}`)
    // ④ 跨进程那一端：契约出口把这条拒绝翻成 worker 读得懂的结论
    assert.equal(reading(r.stderr, 'INCOMPATVERDICTNULL'), 'false',
      '契约出口把"服务在说强制面不行"读成了"服务不在"——上层只会看到"够不着"')
    assert.equal(reading(r.stderr, 'INCOMPATVERDICTFORBID'), 'true')
    assert.equal(reading(r.stderr, 'INCOMPATVERDICTSTATE'), 'incompatible')
    // 真正要执行的那一侧照样拒绝
    assert.equal(reading(r.stderr, 'INCOMPATPROVIDEROK'), 'false')
    assert.equal(reading(r.stderr, 'INCOMPATPROVIDERCODE'), 'EXECUTOR_HOST_PORT_REQUIRED')

    READINGS.after = {
      code: RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE,
      inner: BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE,
      exit: r.code,
    }
    t.diagnostic('INCOMPAT: exit=' + r.code
      + ' logger=' + reading(r.stderr, 'INCOMPATLOGGER')
      + ' loggerWarn=' + reading(r.stderr, 'INCOMPATLOGGERWARN')
      + ' bound=' + reading(r.stderr, 'INCOMPATBOUND')
      + ' code=' + reading(r.stderr, 'INCOMPATCODE')
      + ' state=' + reading(r.stderr, 'INCOMPATSTATE')
      + ' forbid=' + reading(r.stderr, 'INCOMPATFORBID')
      + ' verdictForbid=' + reading(r.stderr, 'INCOMPATVERDICTFORBID')
      + ' provider=' + reading(r.stderr, 'INCOMPATPROVIDERCODE'))
    // ★★ 两条读数必须**不同形**——这是本批"绑定变了"的落点。
    assert.notEqual(READINGS.before.code, READINGS.after.code,
      '①与②的码相同——那"那条要求有没有被拿掉"就没被读出来')
    assert.notEqual(READINGS.before.inner, READINGS.after.inner)
    t.diagnostic(`AFTER: exit=${r.code} ${READINGS.after.code}(${READINGS.after.inner})`)
  })

  guarded('③ ★★★ 绑定真的建立：自检通过、服务发布、`dshRuntimeBound() === true`、exit 0', (t) => {
    const r = runDsh({
      tag: 'bound',
      patches: [...basePatches(), SCRATCH_PATH.boundWrapperPatch, SCRATCH_PATH.boundScaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    assert.match(r.stderr, /^BOUND-WRAPPER-EVALUATED$/m, r.stderr)
    assert.match(r.stderr, /^BOUND-SCAFFOLD-APPLY-RAN$/m, r.stderr)
    // ★ 绑定建立 = 本行**没有**以 BIND_REFUSED / NO_CAN_READ / INPUTS_FACTORY_THREW 拒绝。
    for (const code of [RUNTIME_HOST_ROW_CODES.BIND_REFUSED, RUNTIME_HOST_ROW_CODES.NO_CAN_READ,
      RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW, RUNTIME_HOST_ROW_CODES.NO_HOST_PORT]) {
      assert.equal(r.stderr.includes(code), false, `绑定没建立：读到了 ${code}\n${r.stderr}`)
    }
    assert.equal(r.code, 0, `脚手架必须正常收尾（绑定成功时进程活着）：\n${r.stderr}`)
    assert.equal(reading(r.stderr, 'BOUND'), 'true', r.stderr)
    assert.equal(reading(r.stderr, 'SERVICEOK'), 'true', r.stderr)
    // 交出去的 canRead 是**缺席本身**（null），不是替身。
    assert.equal(reading(r.stderr, 'BOUND-WRAPPER-CANREAD-KIND'), 'null', r.stderr)
    assert.equal(reading(r.stderr, 'CAPTURED-CANREAD-KIND'), 'null', r.stderr)
    // 生产 `startRun` 的转发真的到了现场服务（替身服务收到了）。
    assert.equal(reading(r.stderr, 'STARTFWD'), 'true', r.stderr)
    assert.match(r.stderr, /^SUBAGENTS-START-FORWARDED provider=prt253bu-spawn$/m, r.stderr)
    // ★★ 缺席被保留到底：同一个绑定，问真正要执行的那一侧。
    assert.equal(reading(r.stderr, 'PROVIDEROK'), 'false', r.stderr)
    assert.equal(reading(r.stderr, 'PROVIDERCODE'), EXECUTOR_CODES.CAN_READ_REQUIRED, r.stderr)
    assert.equal(reading(r.stderr, 'PROVIDERINNER'), 'null', r.stderr,
      '这是本进程的拒绝，不该伪装成一次对端拒绝')
    READINGS.bound = {
      exit: r.code,
      bound: reading(r.stderr, 'BOUND'),
      serviceOk: reading(r.stderr, 'SERVICEOK'),
      canReadKind: reading(r.stderr, 'BOUND-WRAPPER-CANREAD-KIND'),
      startForwarded: reading(r.stderr, 'STARTFWD'),
      providerCode: reading(r.stderr, 'PROVIDERCODE'),
    }
    t.diagnostic(`BOUND: exit=${r.code} bound=${READINGS.bound.bound} serviceOk=${READINGS.bound.serviceOk} startFwd=${READINGS.bound.startForwarded} provider=${READINGS.bound.providerCode}`)
  })

  guarded('④ 反向对照：挂一个**不是函数**的 `canRead` → 本行仍然 `NO_CAN_READ`（与③不同形）', (t) => {
    const r = runDsh({
      tag: 'badcanread',
      patches: [...basePatches(), SCRATCH_PATH.badCanReadPatch],
    })
    assert.equal(r.spawnError, null)
    assert.match(r.stderr, /^BAD-CANREAD-WRAPPER-EVALUATED$/m, r.stderr)
    assert.equal(r.code, 1, `期望"挂了个坏的 canRead"拦下启动：\n${r.stderr}`)
    assert.ok(r.stderr.includes(RUNTIME_HOST_ROW_CODES.NO_CAN_READ),
      `没有读到 ${RUNTIME_HOST_ROW_CODES.NO_CAN_READ}：\n${r.stderr}`)
    // ★ 与③（绑定没建立 = exit 0）必须**不同形**：这条拒绝是真会拦启动的。
    assert.notEqual(r.code, READINGS.bound.exit,
      '③与④的退出码相同——那"挂了个坏的"就没被读出来')
    READINGS.badCanRead = { code: RUNTIME_HOST_ROW_CODES.NO_CAN_READ, exit: r.code }
    t.diagnostic(`BAD-CANREAD: exit=${r.code} ${READINGS.badCanRead.code}`)
  })

  guarded('⑤ ★★★ 模型选择的真来源：**真** `agent-default-model` 包挂进真进程 → 原样读出来', (t) => {
    if (!existsSync(REAL_MODEL_PKG)) {
      // 不伪造通过：跑不了就不算跑过（与同目录套件同一口径）。
      t.diagnostic(`真 agent-default-model 包不在（${REAL_MODEL_PKG}）——本场景未运行`)
      return
    }
    const r = runDsh({
      tag: 'modelreal',
      patches: [...basePatches(), SCRATCH_PATH.realModelPatch, SCRATCH_PATH.modelScaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `脚手架必须正常收尾：\n${r.stderr}`)
    assert.equal(reading(r.stderr, 'MODELSERVICEPRESENT'), 'true', r.stderr)
    // ★ 是**真服务类**，不是用例替身。
    assert.equal(reading(r.stderr, 'MODELSERVICECLASS'), 'AgentDefaultModelConfig', r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTIONCODE'), MODEL_SELECTION_CODES.SERVICE_READ, r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTION'), MODEL_SELECTION_SRC, r.stderr)
    // 端口上的那一个也必须一模一样（同一个真读法）。
    assert.equal(reading(r.stderr, 'PORTSELECTION'), MODEL_SELECTION_SRC, r.stderr)
    // 适配器把同一个选择归一化成一个 ModelProfile（provider/model 逐字相同）。
    assert.equal(reading(r.stderr, 'ADAPTERSELECTION'),
      JSON.stringify({ provider: 'prt253bu-real-provider', model: 'prt253bu-real-model', runtimeType: 'dsh' }), r.stderr)
    assert.equal(reading(r.stderr, 'LISTMODELS'),
      JSON.stringify([{ id: 'prt253bu-real-provider', provider: 'prt253bu-real-provider', model: 'prt253bu-real-model' }]), r.stderr)
    READINGS.modelReal = {
      servicePresent: reading(r.stderr, 'MODELSERVICEPRESENT'),
      serviceClass: reading(r.stderr, 'MODELSERVICECLASS'),
      code: reading(r.stderr, 'MODELSELECTIONCODE'),
      selection: reading(r.stderr, 'MODELSELECTION'),
    }
    t.diagnostic(`MODEL-REAL: class=${READINGS.modelReal.serviceClass} selection=${READINGS.modelReal.selection} code=${READINGS.modelReal.code}`)
  })

  guarded('⑥ 反向对照：不挂它 → `null` + `..._SERVICE_ABSENT`，**不编模型名**', (t) => {
    const r = runDsh({
      tag: 'modelabsent',
      patches: [...basePatches(), SCRATCH_PATH.modelScaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `脚手架必须正常收尾：\n${r.stderr}`)
    assert.equal(reading(r.stderr, 'MODELSERVICEPRESENT'), 'false', r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTIONCODE'), MODEL_SELECTION_CODES.SERVICE_ABSENT, r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTION'), 'null', r.stderr)
    assert.equal(reading(r.stderr, 'PORTSELECTION'), 'null', r.stderr,
      '端口在服务缺席时给了一个不是 null 的选择——那只能是编的')
    assert.equal(reading(r.stderr, 'ADAPTERSELECTION'), 'null', r.stderr)
    assert.equal(reading(r.stderr, 'LISTMODELS'), '[]', r.stderr)
    READINGS.modelAbsent = {
      code: reading(r.stderr, 'MODELSELECTIONCODE'),
      selection: reading(r.stderr, 'MODELSELECTION'),
    }
    // ★ 五个读数两两对照：真服务 ∉ 缺席，"挂了个坏的" ≠ 绑定成功。
    if (READINGS.modelReal !== null) {
      assert.notEqual(READINGS.modelReal.code, READINGS.modelAbsent.code,
        '"真服务读到"与"服务缺席"报了同一个码')
      assert.notEqual(READINGS.modelReal.selection, READINGS.modelAbsent.selection)
    }
    assert.notEqual(READINGS.badCanRead.exit, READINGS.bound.exit)
    t.diagnostic(`MODEL-ABSENT: selection=${READINGS.modelAbsent.selection} code=${READINGS.modelAbsent.code}`)
  })

  test('★ 汇总：真实进程读数（before/after 必须不同形）', (t) => {
    if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
    assert.notEqual(READINGS.before, null)
    assert.notEqual(READINGS.after, null)
    assert.notEqual(READINGS.bound, null)
    assert.notEqual(READINGS.before.code, READINGS.after.code)
    t.diagnostic('BEFORE-CONTROL=' + READINGS.before.code + '(' + READINGS.before.inner + ')  '
      + 'AFTER=' + READINGS.after.code + '(' + READINGS.after.inner + ')  '
      + 'BOUND=' + JSON.stringify(READINGS.bound) + '  '
      + 'MODEL-REAL=' + JSON.stringify(READINGS.modelReal) + '  '
      + 'MODEL-ABSENT=' + JSON.stringify(READINGS.modelAbsent))
  })
})

if (SKIP !== false) {
  test('PRT-253 解阻批 真 DSH 进程部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
