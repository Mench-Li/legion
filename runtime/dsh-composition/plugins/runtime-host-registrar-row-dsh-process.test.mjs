// runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs
// ============================================================================
// PRT-253（续批二）：**生产注册方**在真 DSH 进程里的读数。
//
// ## 这套件要回答的三个问题
//
//   ① 注册方在场时，读数**变了吗**？（与"没有注册方"必须读得出**不同**的东西）
//   ② 注册方缺席时，读的是不是上一批那条**具名拒绝**？
//   ③ 能力**未确认**时，它被报成未确认、而且后果**看得见**吗？
//
// ## 五个场景（每一个只动一个变量）
//
//   N. 组件的模块**就是** `runtime-host-row.mjs`（= 上一批的补丁层取值，没人注册工厂）
//      → 具名拒绝 `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`，exit 1。
//   R. 组件的模块换成**本批的生产注册方**（模块求值期注册、默认导出真对象）
//      → 工厂**成功**（`canRead` 现在缺席是合法的，如实记成 `null`），于是拒绝
//        移到**下一站**：`RUNTIME_HOST_ROW_BIND_REFUSED` + 内层
//        `BOOTSTRAP_SELF_CHECK_INCOMPATIBLE`（三项未确认的能力）。exit 1。
//        ★ 本批之前这里读的是 `..._INPUTS_FACTORY_THREW(RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE)`
//        ——两个读数的原始对照见新套件
//        `runtime-host-binding-unblocked-dsh-process.test.mjs` 与文档。
//        N 与 R 的差别只有**一个模块路径**。
//   F. 注册方 + 显式注入的 `canRead`（**测试替身**，见诚实边界）
//      → 与 R **同形**：这也是一条读数——`canRead` 这个输入在本进程里**不被任何东西读**
//        （R 没有、F 有一个替身，绑定阶段的结论一字不差）。
//   S. 注册方**被加载**（由脚手架按路径 import，补丁层就是这么加载它的）但**不挂那一行**，
//      于是进程活着 → 直接读**生产函数**的读数：版本、能力表、逐项判据、`startRun` 转发、
//      生产默认工厂交出的 `canRead`、以及 `currentModelSelection` 的来源判据。
//      → 版本必须等于 `<DSH>/apps/cli/package.json` 里那个值（真读数，不是常量）。
//   S2. S 的**反向对照**：唯一变量是桩 provider 的 `outputSchema` 变成 false
//      → `structured-result` 与它的判据码**必须跟着变**。
//      ——没有这一条，"读注册表"与"写死一个值"在这套件里分不开。
//
// ## 诚实边界（这套件**没有**证明的东西，逐条见 PRT-253-runtime-host-inputs.md）
//
//   · **$1 引擎（`subagents`）是替身**：`bundles: []` 的一次性 profile 里没有真引擎。
//     能力判据中"读现场 provider 注册表"这一路因此由**替身 provider**驱动；
//     被验的是**推导链**（注册表 → 判据码 → 布尔表），不是"真 DSH 引擎支持 outputSchema"。
//     生产 `startRun` 本身**不是**替身——它是按引用转发到现场服务的（S 那条钉着它）；
//     替身的是**这个进程里那个服务**。
//   · **`canRead` 在 R 里是"缺席"，在 F 里是替身**；两者读数同形，正是本批量到的
//     "这个进程里没有它的读者"。R 才是生产取值。
//   · **沙箱端口是替身**（沿用上一批的 `SERVICES_SRC` 形状）。
//   · **组合补丁层用的是磁盘上那份真 `legion-host.patch.yml`**（一个字节都不改），
//     所以"组合树观察"与"强制面装配"是真读数。
//
// ## 安全（与上一批同一套，逐条成立）
//
//   一次性 `DSH_HOME`（`os.tmpdir()` 下，**spawn 之前断言**）、`bundles: []` +
//   `patchReload: 'startup'`、删掉 `DSH_SNAPSHOT`、`spawnSync` 超时、`after()` 整棵删。
//   **绝不**读写任何真实 profile（操作者那台机器的活 harness 是 `patchReload: 'live'`）。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 判据取自**产品模块**，不在用例里另抄一份字符串（抄一份的话，产品改了码而用例还绿着）。
import { CAPABILITY_EVIDENCE_CODES, RUNTIME_HOST_REGISTRAR_CODES } from './runtime-host-registrar-row.mjs'
import { RUNTIME_HOST_ROW_CODES } from './runtime-host-row.mjs'
import { BOOTSTRAP_CODES } from '../bootstrap.mjs'
import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import { SUPPORTED_RUNTIME, parseVersion } from '../../adapters/dsh/probe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSITION = resolve(HERE, '..')
const ROOT_DIR = resolve(HERE, '..', '..', '..')

const REGISTRAR_ABS = join(HERE, 'runtime-host-registrar-row.mjs')
const RUNTIME_HOST_ROW_ABS = join(HERE, 'runtime-host-row.mjs')
const EXECUTOR_BINDING_ABS = join(ROOT_DIR, 'orchestrator', 'worker', 'executor-binding.mjs')

const fileUrl = (p) => pathToFileURL(p).href

// ─────────────────────────────────────────── 可跑性判定（沿用既有口径）

const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const CLI_PKG = DSH === null ? null : join(DSH, 'apps', 'cli', 'package.json')
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
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-host-registrar-dsh-'))

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

const LEGION_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt253ri-actor',
  LEGION_SCOPE: 'prt253ri-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

const PROFILE_NAME = 'prt253ri'

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

// ─────────────────────────────────────────── 脚手架（全部是替身）

/**
 * 桩宿主服务：`tools` / `approval` / `sandbox` / **`subagents`**。
 *
 * 前三个沿用上一批的形状（读数已在那里验过）。`subagents` 是本批新增的**引擎替身**：
 * 它只提供能力判据要读的那两个方法（`list` / `getProvider`）与 `start`，
 * `outputSchema` 由参数给——于是 S 与 S2 的**唯一**变量就是那一个布尔值。
 */
function servicesSrc(outputSchema) {
  return `// 桩宿主：只发布被测几行 inject 的服务 + 一个引擎替身。不是 ToolRuntime。
const note = (line) => process.stderr.write(line + '\\n')
const PROVIDER_NAME = 'prt253ri-spawn'
const HANDLE = {
  result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'prt253ri' }] }),
  dispose: async () => {},
}
export default {
  name: 'prt253ri-services',
  inject: [],
  apply(ctx) {
    note('SERVICES-ROW-APPLY-RAN')
    const guards = []
    ctx.provide('tools', {
      guard(fn) {
        guards.push(fn)
        note('SERVICES-TOOLS-GUARD-REGISTERED count=' + guards.length)
        return () => note('SERVICES-TOOLS-GUARD-DISPOSED')
      },
    })
    ctx.provide('approval', {})
    ctx.provide('sandbox', {
      async confine(argv) {
        return {
          enforcement: 'full',
          backend: 'prt253ri-stub-backend',
          argv: ['prt253ri-stub-sandbox', '--', ...argv],
          denialSignatures: ['operation not permitted'],
        }
      },
    })
    // ★ 引擎替身：能力表里只有 outputSchema 是我们这次要驱动的那个变量。
    const provider = {
      name: PROVIDER_NAME,
      capabilities: { agentOptions: true, outputSchema: ${outputSchema ? 'true' : 'false'}, depthLimit: true, toolFilter: true, persona: true },
      async start() { return HANDLE },
    }
    const starts = []
    ctx.provide('subagents', {
      list: () => [PROVIDER_NAME],
      getProvider: (n) => (n === PROVIDER_NAME ? provider : undefined),
      async start(providerName, request) {
        starts.push({ providerName, request })
        note('SUBAGENTS-START-FORWARDED provider=' + providerName)
        return HANDLE
      },
    })
    note('SERVICES-PROVIDED tools,approval,sandbox,subagents outputSchema=${outputSchema ? 'true' : 'false'}')
  },
}
`
}

const SERVICES_PATCH_SRC = `- insert:
    - id: "prt253ri-services"
      name: "./prt253ri-services.mjs"
`

/** `permission` 行的替身（与上一批同一条理由：`bundles: []` 里没有它的靶子）。 */
const PERMISSION_SRC = `// 替身：只为让真补丁层的 patch-over 有靶子。
export default {
  name: 'prt253ri-permission-standin',
  inject: [],
  apply() { process.stderr.write('PERMISSION-STANDIN-APPLY-RAN\\n') },
}
`

const PERMISSION_PATCH_SRC = `- insert:
    - id: "permission"
      name: "./prt253ri-permission.mjs"
      config:
        presets:
          workspace-write:
            sandbox: "workspace-write"
            approval: "ask"
          danger-full-access:
            sandbox: "danger-full-access"
            approval: "never"
`

// 运行期两行（`PATCH_LAYER_ROWS` 里 `module: null` 的那两行）按绝对路径挂。
const RUNTIME_ROWS_PATCH_SRC = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(HERE, 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(HERE, 'approval-answerer-row.mjs'))}
`

// N：**上一批的取值**——那一行的模块就是组件本体，没有人注册工厂。
const ROW_ONLY_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: ${JSON.stringify(RUNTIME_HOST_ROW_ABS)}
`

// R：★ 换成本批的**生产注册方**当那一行的模块。差别只有这一个路径。
const REGISTRAR_ROW_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: ${JSON.stringify(REGISTRAR_ABS)}
`

// F：注册方 + **显式注入的** canRead（测试替身）。
const WRAPPER_SRC = `import realRuntimeHostRow from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { createRuntimeHostInputsFactory } from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}
import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
note('REGISTRAR-WRAPPER-EVALUATED')

// ⚠️ 这个 canRead 是**用例替身**：生产默认没有它（R 场景读的就是那条拒绝）。
// 它在这里的唯一作用是让工厂成功，从而读出"未确认的能力"在启动自检那一步的后果。
setDshRuntimeInputsFactory(createRuntimeHostInputsFactory({ canRead: () => ({ all: true }) }))

export default realRuntimeHostRow
`

const WRAPPER_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: "./prt253ri-wrapper.mjs"
`

// S / S2：按**路径** import 生产注册方（补丁层就是这么加载它的），读生产函数的输出；
// **不挂**那一行，于是进程活着，读数拿得到。
const SCAFFOLD_SRC = `import { CAPABILITY_EVIDENCE_CODES, RUNTIME_HOST_REGISTRAR_CODES, createRuntimeHostInputsFactory, probeDshRuntime, readDshVersionOfInstall, readModelSelection, dshInstallCandidates } from ${JSON.stringify(fileUrl(REGISTRAR_ABS))}

const note = (line) => process.stderr.write(line + '\\n')

export default {
  name: 'prt253ri-scaffold',
  inject: [],
  apply(ctx) {
    note('REGISTRAR-MODULE-LOADED')
    setTimeout(async () => {
      // ① 生产探针（真函数、真 ctx）。
      try {
        const probe = probeDshRuntime(ctx)
        note('PROBEDVERSION ' + String(probe.version))
        note('PROBEDVERSIONCODE ' + probe.versionEvidence.code)
        note('PROBEDCAPS ' + JSON.stringify(probe.capabilities))
        note('PROBEDEVIDENCE ' + JSON.stringify(Object.fromEntries(
          Object.entries(probe.capabilityEvidence).map(([k, v]) => [k, v.code]))))
      } catch (error) {
        note('PROBE-THREW ' + String(error && error.message ? error.message : error))
      }
      // ② 版本阅读器的**候选**里，第一项就是本进程的入口。
      try {
        const cands = dshInstallCandidates({ ctx })
        note('CANDIDATE0 ' + String(cands[0]))
        note('CANDIDATE0VERSION ' + String(readDshVersionOfInstall({ candidates: cands }).version))
      } catch (error) {
        note('CANDIDATES-THREW ' + String(error && error.message ? error.message : error))
      }
      // ③ 生产工厂在**真 ctx** 上建出端口；startRun 必须按引用转发到真服务。
      try {
        const built = createRuntimeHostInputsFactory({ canRead: () => ({ all: true }) })(ctx)
        const handle = await built.runtimeHost.startRun('prt253ri-spawn', { label: 'x', prompt: [{ type: 'text', text: 'y' }] })
        note('STARTFWD ' + (handle !== undefined && typeof handle.dispose === 'function' ? 'handle' : 'not-a-handle'))
        note('FACTORY ' + (typeof built.canRead === 'function' ? 'built' : 'not-built'))
      } catch (error) {
        note('FACTORY-THREW ' + String(error && error.message ? error.message : error) + ' code=' + String(error && error.code))
      }
      // ④ 生产默认（**没有** canRead 来源）在真 ctx 上：工厂**成功**，
      //    缺席被如实记成一个分得开的值（null）——**不是**替身、不是默认放行/拒绝。
      try {
        const dflt = createRuntimeHostInputsFactory()(ctx)
        note('DEFAULTFACTORY ' + (dflt.canRead === null ? 'canRead-null' : String(typeof dflt.canRead)))
        note('DEFAULTCANREADISFUNCTION ' + String(typeof dflt.canRead === 'function'))
        note('DEFAULTCANREADKEYPRESENT ' + String('canRead' in dflt))
      } catch (error) {
        note('DEFAULTFACTORY-THREW ' + String(error && error.code))
      }
      // ⑤ 模型选择的**来源判据**：一次性 profile 用的是 bundles: []，基础组合层不在，
      //    所以这里**应该**读到"服务缺席"，端口给出 null——**不是**一个编出来的模型名。
      try {
        const reading = readModelSelection(ctx)
        note('MODELSELECTIONCODE ' + reading.code)
        note('MODELSELECTION ' + JSON.stringify(reading.selection))
        note('MODELSELECTIONSERVICEPRESENT ' + String(ctx.get('agentDefaultModel') !== undefined))
        const port = createRuntimeHostInputsFactory()(ctx)
        note('PORTSELECTION ' + JSON.stringify(port.runtimeHost.currentModelSelection()))
      } catch (error) {
        note('MODELSELECTION-THREW ' + String(error && error.message ? error.message : error))
      }
      note('SCAFFOLD-EXIT-0')
      process.exit(0)
    }, 3000)
  },
}
`

const SCAFFOLD_PATCH_SRC = `- insert:
    - id: "prt253ri-scaffold"
      name: "./prt253ri-scaffold.mjs"
`

/**
 * R / F 的读数脚手架：把**发布出来的**那份拒绝读出来。
 *
 * 为什么必须挂脚手架、不能只 grep stderr：本批把自检不兼容从 `throw`
 * 改成了 `provide`，于是拒绝从"进程退出时的 stderr"搬到了"一个服务值上"。
 * 而 `ctx.logger` 虽然**在真进程里确实存在**（已实测：`logger=true`、
 * `warn` 是函数），它的输出**不落到子进程的 stderr**（一次性 profile 下没有
 * 终端 sink）——所以"日志里有没有"在 stderr 上是读不到的。
 *
 *   > 一个"记进了日志但日志不在你手上"的读数，
 *   > 与一个"根本没记"的读数，在 stderr 上完全同形。
 *
 * 于是这里读**权威来源**：服务值本身。它同时证明了三件事——
 * 拒绝在、拒绝是具名的、以及**端口没有绑上**。
 */
const INCOMPAT_READ_SRC = `import { RUNTIME_HOST_BINDING_SERVICE } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}
import { verdictFromRuntimeHostBinding } from ${JSON.stringify(fileUrl(join(HERE, 'runtime-contract-server-row.mjs')))}
import { dshRuntimeBound, productionExecutorProvider } from ${JSON.stringify(fileUrl(EXECUTOR_BINDING_ABS))}

const note = (line) => process.stderr.write(line + '\\n')

export default {
  name: 'prt253ri-incompat-read',
  inject: [],
  apply(ctx) {
    note('INCOMPAT-READ-APPLY-RAN')
    setTimeout(async () => {
      try {
        const svc = ctx.get(RUNTIME_HOST_BINDING_SERVICE)
        const present = svc !== undefined && svc !== null
        const read = (k) => String(present ? svc[k] : 'no-service')
        note('INCOMPATPRESENT ' + String(present))
        note('INCOMPATOK ' + read('ok'))
        note('INCOMPATCODE ' + read('code'))
        note('INCOMPATINNER ' + read('innerCode'))
        note('INCOMPATSTATE ' + read('state'))
        note('INCOMPATFORBID ' + read('autoExecutionForbidden'))
        note('INCOMPATREPAIR ' + String(present && svc.repair !== null && svc.repair !== undefined))
        // ★ 归因逐条带出来（F 靠这几条断言"未确认的能力"仍然可见）
        note('INCOMPATCHECKS ' + JSON.stringify(present ? svc.checks : null))
        note('INCOMPATREASONS ' + JSON.stringify(present ? svc.reasons : null))
        note('INCOMPATMESSAGE ' + String(present ? svc.message : 'no-service'))
        // ★ 安全方向：端口**没有**被注册
        note('INCOMPATBOUND ' + String(dshRuntimeBound()))
        // ★ 跨进程那一端：契约出口翻出来的结论
        const v = verdictFromRuntimeHostBinding(present ? svc : null)
        note('INCOMPATVERDICTNULL ' + String(v === null))
        note('INCOMPATVERDICTFORBID ' + String(v === null ? 'null' : v.autoExecutionForbidden))
        note('INCOMPATVERDICTSTATE ' + String(v === null ? 'null' : v.state))
        // ★ 真正要执行的那一侧照样拒绝
        const provider = await productionExecutorProvider({
          post: async () => ({ status: 200, body: {} }),
          get: async () => ({ status: 200, body: {} }),
        })
        note('INCOMPATPROVIDEROK ' + String(provider.ok))
        note('INCOMPATPROVIDERCODE ' + String(provider.code))
      } catch (error) {
        note('INCOMPAT-READ-THREW ' + String(error && error.message ? error.message : error))
      }
      note('INCOMPAT-READ-EXIT-0')
      process.exit(0)
    }, 3000)
  },
}
`

const INCOMPAT_READ_PATCH_SRC = `- insert:
    - id: "prt253ri-incompat-read"
      name: "./prt253ri-incompat-read.mjs"
`

const REAL_PATCH = join(COMPOSITION, 'legion-host.patch.yml')

const SCRATCH_PATH = {}
function put(key, fileName, source) {
  SCRATCH_PATH[key] = join(SCRATCH, fileName)
  writeFileSync(SCRATCH_PATH[key], source)
}

put('servicesTrue', 'prt253ri-services-true.mjs', servicesSrc(true))
put('servicesFalse', 'prt253ri-services-false.mjs', servicesSrc(false))
put('servicesTruePatch', 'prt253ri-services-true.patch.yml',
  SERVICES_PATCH_SRC.replace('./prt253ri-services.mjs', './prt253ri-services-true.mjs'))
put('servicesFalsePatch', 'prt253ri-services-false.patch.yml',
  SERVICES_PATCH_SRC.replace('./prt253ri-services.mjs', './prt253ri-services-false.mjs'))
put('permission', 'prt253ri-permission.mjs', PERMISSION_SRC)
put('permissionPatch', 'prt253ri-permission.patch.yml', PERMISSION_PATCH_SRC)
put('runtimeRowsPatch', 'prt253ri-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH_SRC)
put('rowOnlyPatch', 'prt253ri-row-only.patch.yml', ROW_ONLY_PATCH_SRC)
put('registrarRowPatch', 'prt253ri-registrar-row.patch.yml', REGISTRAR_ROW_PATCH_SRC)
put('wrapper', 'prt253ri-wrapper.mjs', WRAPPER_SRC)
put('wrapperPatch', 'prt253ri-wrapper.patch.yml', WRAPPER_PATCH_SRC)
put('scaffold', 'prt253ri-scaffold.mjs', SCAFFOLD_SRC)
put('scaffoldPatch', 'prt253ri-scaffold.patch.yml', SCAFFOLD_PATCH_SRC)
put('incompatRead', 'prt253ri-incompat-read.mjs', INCOMPAT_READ_SRC)
put('incompatReadPatch', 'prt253ri-incompat-read.patch.yml', INCOMPAT_READ_PATCH_SRC)

assert.ok(existsSync(REAL_PATCH), `真补丁层不在：${REAL_PATCH}`)
for (const p of [REGISTRAR_ABS, RUNTIME_HOST_ROW_ABS, EXECUTOR_BINDING_ABS,
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
const basePatches = (servicesPatch) => [
  servicesPatch,
  SCRATCH_PATH.permissionPatch,
  REAL_PATCH,
  SCRATCH_PATH.runtimeRowsPatch,
]

/** 五个场景的读数收在这里，最后一条把它们两两对照。 */
const READINGS = { n: null, r: null, f: null, s: null, s2: null }

const CLI_VERSION = SKIP === false ? JSON.parse(readFileSync(CLI_PKG, 'utf8')).version : null

describe('PRT-253 续批二：生产注册方在**真 DSH 进程**里的读数', () => {
  guarded('N. 上一批的取值（组件本体当模块、没人注册工厂）→ `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`', (t) => {
    const r = runDsh({
      tag: 'n',
      patches: [...basePatches(SCRATCH_PATH.servicesTruePatch), SCRATCH_PATH.rowOnlyPatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 1, `期望"没有工厂"拦下启动：\n${r.stderr}`)
    // ★ 断言具名码本身，不写"它抛了"。
    assert.ok(r.stderr.includes(RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY),
      `没有读到 ${RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY}：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW), false,
      'N 场景里出现了工厂抛错的码——那 N 与 R 的差别就不是"有没有注册方"了')
    READINGS.n = { code: RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY, exit: r.code }
    t.diagnostic(`N: exit=${r.code} ${READINGS.n.code}`)
  })

  guarded('R. ★★★ 换成生产注册方当那一行的模块 → 工厂**成功**；自检不兼容时**不抛**、进程活着、端口没绑上', (t) => {
    const r = runDsh({
      tag: 'r',
      patches: [...basePatches(SCRATCH_PATH.servicesTruePatch), SCRATCH_PATH.registrarRowPatch, SCRATCH_PATH.incompatReadPatch],
    })
    assert.equal(r.spawnError, null)
    // ★★★ 本批翻过来的那个取舍：**exit 0**。spec `line 854` 要的是
    //   「按 `incompatible` 处理并禁止自动执行」，§6.3 表格把 `incompatible`
    //   的行为定成「禁止自动执行，**提示修复或回滚**」——崩掉的进程提示不了。
    assert.equal(r.code, 0, `期望"进程活着并明说自己不能自动执行"：\n${r.stderr}`)
    assert.match(r.stderr, /^INCOMPAT-READ-APPLY-RAN$/m, r.stderr)
    assert.equal(r.stderr.includes('INCOMPAT-READ-THREW'), false, `读数脚手架抛了：\n${r.stderr}`)
    // ① 注册**真的**发生在模块求值期：否则这里读到的会是 N 那条 NO_INPUTS_FACTORY。
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY), false,
      `注册方在场却报"没有人注册工厂"——注册没发生在模块求值期：\n${r.stderr}`)
    // ② ★★ 本批改掉的那条读数：工厂**不再**抛。
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW), false,
      `工厂仍然抛了——canRead 缺席这条要求没有被拿掉：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE), false,
      `仍然读到"没有 canRead 来源"的具名码：\n${r.stderr}`)
    // ③ ★★★ 与**旧版**R 不同形：拒绝不再以 `BIND_REFUSED`（= 整树加载失败）出现，
    //    也不再有"装载这一行失败"。这两条是"开关真的翻了"的判据——
    //    少了它们，下面那些断言在旧实现上也会绿。
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.BIND_REFUSED), false,
      `仍然读到 ${RUNTIME_HOST_ROW_CODES.BIND_REFUSED}——那一行还在抛：\n${r.stderr}`)
    assert.equal(r.stderr.includes('failed to apply loader entry legion-runtime-host'), false,
      `仍然读到"装载这一行失败"——整棵树还是被拖垮了：\n${r.stderr}`)
    // ④ ★★★ 拒绝**仍然可见**——只是搬到了服务值上（读权威来源，不 grep 日志）
    assert.equal(reading(r.stderr, 'INCOMPATPRESENT'), 'true',
      `自检不兼容时什么都没发布：\n${r.stderr}`)
    assert.equal(reading(r.stderr, 'INCOMPATOK'), 'false')
    assert.equal(reading(r.stderr, 'INCOMPATCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(reading(r.stderr, 'INCOMPATINNER'), BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(reading(r.stderr, 'INCOMPATSTATE'), 'incompatible')
    assert.equal(reading(r.stderr, 'INCOMPATFORBID'), 'true')
    assert.equal(reading(r.stderr, 'INCOMPATREPAIR'), 'true',
      '只报"不兼容"而不给修复入口 = 把 spec 要的"提示修复或回滚"又丢了一次')
    // ⑤ ★★★ 安全方向**一点没放松**：端口没有被注册。
    //    这一条与"进程活着"**必须一起读**——只读后者会得出"降级了"。
    assert.equal(reading(r.stderr, 'INCOMPATBOUND'), 'false',
      `宿主端口被注册了——那才是真的放松：\n${r.stderr}`)
    // ⑥ 跨进程那一端 + 真正要执行的那一侧
    assert.equal(reading(r.stderr, 'INCOMPATVERDICTNULL'), 'false',
      '契约出口把"服务在说强制面不行"读成了"服务不在"——上层只会看到"够不着"')
    assert.equal(reading(r.stderr, 'INCOMPATVERDICTFORBID'), 'true')
    assert.equal(reading(r.stderr, 'INCOMPATPROVIDERCODE'), 'EXECUTOR_HOST_PORT_REQUIRED')
    READINGS.r = { code: RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE, inner: BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE, exit: r.code }
    t.diagnostic(`R: exit=${r.code} ${READINGS.r.code}(${READINGS.r.inner}) bound=${reading(r.stderr, 'INCOMPATBOUND')} state=${reading(r.stderr, 'INCOMPATSTATE')}`)
  })

  guarded('F. 注册方 + 注入的 canRead（替身）→ 未确认的能力在**启动自检**那一步后果可见', (t) => {
    const r = runDsh({
      tag: 'f',
      patches: [...basePatches(SCRATCH_PATH.servicesTruePatch), SCRATCH_PATH.wrapperPatch, SCRATCH_PATH.incompatReadPatch],
    })
    assert.equal(r.spawnError, null)
    // 同上：自检不兼容不再是启动失败，而是"活着 + 明说不能自动执行"。
    assert.equal(r.code, 0, `期望"未确认的能力"只禁止自动执行、不拦启动：\n${r.stderr}`)
    assert.match(r.stderr, /^REGISTRAR-WRAPPER-EVALUATED$/m, r.stderr)
    // ★ 链条逐段可读：本行的具名码 → 内层是启动自检不兼容。
    assert.equal(reading(r.stderr, 'INCOMPATCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(reading(r.stderr, 'INCOMPATINNER'), BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.BIND_REFUSED), false,
      `仍然读到 ${RUNTIME_HOST_ROW_CODES.BIND_REFUSED}——那一行还在抛：\n${r.stderr}`)
    // ★★ 归因**一条都没丢**：未确认的能力逐个出现在消息里
    //    （structured-result 由桩注册表确认，不在其中）。
    //    这正是"改成 provide 之后最容易丢掉的东西"。
    const blob = (reading(r.stderr, 'INCOMPATMESSAGE') ?? '') + (reading(r.stderr, 'INCOMPATCHECKS') ?? '')
      + (reading(r.stderr, 'INCOMPATREASONS') ?? '')
    for (const cap of REQUIRED_CAPABILITIES.filter((c) => c !== 'structured-result')) {
      assert.ok(blob.includes(cap), `未确认的能力 ${cap} 没有出现在读出来的理由里：\n${blob}`)
    }
    assert.ok(blob.includes('缺必需能力'), `理由里没有"缺必需能力"那段：\n${blob}`)
    // 安全方向照样没放松
    assert.equal(reading(r.stderr, 'INCOMPATBOUND'), 'false')
    assert.equal(reading(r.stderr, 'INCOMPATFORBID'), 'true')
    READINGS.f = { code: RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE, inner: BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE, exit: r.code }
    t.diagnostic(`F: exit=${r.code} ${READINGS.f.code}(${READINGS.f.inner}) bound=${reading(r.stderr, 'INCOMPATBOUND')}`)
  })

  guarded('S. ★★ 生产探针在真 DSH 进程里的读数：版本是真安装的版本，能力逐项有据', (t) => {
    const r = runDsh({
      tag: 's',
      patches: [...basePatches(SCRATCH_PATH.servicesTruePatch), SCRATCH_PATH.scaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `脚手架必须正常收尾：\n${r.stderr}`)
    assert.match(r.stderr, /^REGISTRAR-MODULE-LOADED$/m, r.stderr)
    assert.match(r.stderr, /^SCAFFOLD-EXIT-0$/m, r.stderr)

    // ① ★ 版本 = **这台机器上那份安装**的 CLI 版本（真读数）。
    const version = reading(r.stderr, 'PROBEDVERSION')
    assert.notEqual(version, null, `没有读到 PROBEDVERSION：\n${r.stderr}`)
    assert.equal(version, CLI_VERSION, `探针报的版本不是这份安装的版本：${version} vs ${CLI_VERSION}`)
    assert.equal(reading(r.stderr, 'PROBEDVERSIONCODE'), 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_READ', r.stderr)
    // 版本还要**能被兼容门用**（一个读得出来但解析不了的版本等于没读）。
    const parsed = parseVersion(version)
    assert.notEqual(parsed, null, `探针报的版本解析不了：${version}`)
    assert.equal(parsed.major, SUPPORTED_RUNTIME.supportedMajor,
      `版本主号 ${parsed.major} 与产品锁定 ${SUPPORTED_RUNTIME.supportedMajor} 不一致——探针读数与兼容门对不上`)
    // 候选第一项就是本进程的入口（版本是从它推导出来的）。
    assert.equal(reading(r.stderr, 'CANDIDATE0VERSION'), CLI_VERSION, r.stderr)

    // ② 能力表：structured-result 由**现场注册表**确认，另外三项未确认。
    const caps = JSON.parse(reading(r.stderr, 'PROBEDCAPS'))
    assert.deepEqual(Object.keys(caps).sort(), [...REQUIRED_CAPABILITIES].sort())
    assert.equal(caps['structured-result'], true, r.stderr)
    for (const cap of REQUIRED_CAPABILITIES.filter((c) => c !== 'structured-result')) {
      assert.equal(caps[cap], false, `${cap} 在没有任何来源时必须是 false（未确认）：${r.stderr}`)
    }
    // ③ 逐项判据码。
    const ev = JSON.parse(reading(r.stderr, 'PROBEDEVIDENCE'))
    assert.equal(ev['structured-result'], CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_CONFIRMS)
    assert.equal(ev['tool-permission-enforcement'], CAPABILITY_EVIDENCE_CODES.ENFORCEMENT_PLANE_MEASURED_ELSEWHERE)
    assert.equal(ev['cancel-and-timeout'], CAPABILITY_EVIDENCE_CODES.CANCEL_NOT_GUARANTEED_BY_ENGINE)
    assert.equal(ev['usage-reporting'], CAPABILITY_EVIDENCE_CODES.RESULT_CONTRACT_HAS_NO_USAGE)
    assert.equal(new Set(Object.values(ev)).size, 4, '四项的判据码必须互不相同（否则"哪一项没来源"读不出来）')

    // ④ 生产工厂在真 ctx 上建得出端口，`startRun` 按引用转发到真服务。
    assert.equal(reading(r.stderr, 'FACTORY'), 'built', r.stderr)
    assert.equal(reading(r.stderr, 'STARTFWD'), 'handle', r.stderr)
    assert.match(r.stderr, /^SUBAGENTS-START-FORWARDED provider=prt253ri-spawn$/m, r.stderr)

    // ⑤ ★ 生产**默认**（没有 canRead 来源）在同一时刻：工厂**成功**，缺席是 `null`，
    //     而且**不是**一个函数（不是替身）。
    assert.equal(reading(r.stderr, 'DEFAULTFACTORY'), 'canRead-null', r.stderr)
    assert.equal(reading(r.stderr, 'DEFAULTCANREADISFUNCTION'), 'false', r.stderr)
    assert.equal(reading(r.stderr, 'DEFAULTCANREADKEYPRESENT'), 'true', r.stderr)
    assert.equal(r.stderr.includes('DEFAULTFACTORY-THREW'), false,
      `生产默认工厂仍然抛了：\n${r.stderr}`)

    // ⑤b ★ 模型选择的来源：`bundles: []` 的一次性 profile 里基础组合层不在，
    //      所以这里**必须**是"服务缺席 + null"，**不是**一个编出来的模型名。
    //      （这条读数只说明"缺席时如实报缺席"；真 `agentDefaultModel` 有没有被
    //        观察到，见文档的诚实边界。）
    assert.equal(reading(r.stderr, 'MODELSELECTIONCODE'), 'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT', r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTION'), 'null', r.stderr)
    assert.equal(reading(r.stderr, 'MODELSELECTIONSERVICEPRESENT'), 'false', r.stderr)
    assert.equal(reading(r.stderr, 'PORTSELECTION'), 'null', r.stderr,
      '端口在服务缺席时给了一个不是 null 的选择——那只能是编的')

    READINGS.s = {
      version, caps, evidence: ev,
      defaultFactory: reading(r.stderr, 'DEFAULTFACTORY'),
      modelSelectionCode: reading(r.stderr, 'MODELSELECTIONCODE'),
      modelSelection: reading(r.stderr, 'MODELSELECTION'),
      startFwd: reading(r.stderr, 'STARTFWD'),
    }
    t.diagnostic(`S: version=${version} caps=${JSON.stringify(caps)} defaultFactoryCanRead=${READINGS.s.defaultFactory} modelSelection=${READINGS.s.modelSelection}/${READINGS.s.modelSelectionCode}`)
  })

  guarded('S2. S 的反向对照：桩 provider 把 `outputSchema` 报成 false → 那两项读数跟着变', (t) => {
    const r = runDsh({
      tag: 's2',
      patches: [...basePatches(SCRATCH_PATH.servicesFalsePatch), SCRATCH_PATH.scaffoldPatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `脚手架必须正常收尾：\n${r.stderr}`)
    // 版本这一路**不受影响**（唯一变量是能力判据）——两个场景的版本必须一样。
    assert.equal(reading(r.stderr, 'PROBEDVERSION'), READINGS.s.version, r.stderr)
    const caps = JSON.parse(reading(r.stderr, 'PROBEDCAPS'))
    assert.equal(caps['structured-result'], false, `桩 provider 说不支持时必须跟着报 false：${r.stderr}`)
    const ev = JSON.parse(reading(r.stderr, 'PROBEDEVIDENCE'))
    assert.equal(ev['structured-result'], CAPABILITY_EVIDENCE_CODES.PROVIDER_LACKS_OUTPUT_SCHEMA, r.stderr)
    assert.notEqual(ev['structured-result'], READINGS.s.evidence['structured-result'],
      'S 与 S2 的 structured-result 判据码一样——那"读现场注册表"与"写死 true"分不开')
    assert.notEqual(caps['structured-result'], READINGS.s.caps['structured-result'],
      'S 与 S2 的 structured-result 布尔值一样——能力判据没有真的读注册表')
    READINGS.s2 = { caps, structuredEvidence: ev['structured-result'] }
    t.diagnostic(`S2: structured-result=${caps['structured-result']} ${ev['structured-result']}`)
  })

  guarded('★ 读数对照：注册方在不在分得开；**canRead 在不在分不开**；能力读没读到分得开', (t) => {
    for (const k of ['n', 'r', 'f', 's', 's2']) {
      assert.notEqual(READINGS[k], null, `${k} 没有留下读数——上面某条用例没跑成`)
    }
    // ① "有没有注册方"是**分得开的**（N 报"没人注册"，R 走到了下一站）。
    assert.notEqual(READINGS.n.code, READINGS.r.code,
      `N/R 的码相同（${READINGS.n.code}）——那"有没有注册方"就没被读出来`)
    // ② ★★ 本批的**新读数**：R（没有 canRead）与 F（注入了一个 canRead 替身）
    //      在绑定阶段**一字不差**。这不是"两个场景碰巧都失败"——它们失败在**同一站**
    //      （启动自检的 runtime-probe），而 canRead 缺席/在场没有改变任何东西。
    //      这就是"这个进程里没有它的读者"的**直接读数**。
    assert.equal(READINGS.r.code, READINGS.f.code,
      `R 与 F 的码不同（${READINGS.r.code} vs ${READINGS.f.code}）——canRead 居然影响了本进程的绑定阶段？`)
    assert.equal(READINGS.r.inner, READINGS.f.inner,
      `R 与 F 的内层码不同（${READINGS.r.inner} vs ${READINGS.f.inner}）`)
    // ③ ★ 而且它与**本批之前**那条读数不同形：工厂不再抛。
    assert.notEqual(READINGS.r.code, RUNTIME_HOST_ROW_CODES.INPUTS_FACTORY_THREW,
      'R 仍然读成"工厂抛了"——canRead 缺席这条要求还在拦绑定')
    assert.notEqual(READINGS.r.inner, RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE)
    // ④ 生产默认工厂交出的 attendance 读数是**缺席本身**（null），不是替身。
    assert.equal(READINGS.s.defaultFactory, 'canRead-null')
    assert.equal(READINGS.s.modelSelection, 'null', '模型选择被编出来了？')
    // ⑤ "能力读没读到"分得开（S 与 S2 的唯一变量是桩 provider 的 outputSchema）。
    assert.notEqual(READINGS.s.caps['structured-result'], READINGS.s2.caps['structured-result'])
    t.diagnostic(`N=${READINGS.n.code} / R=${READINGS.r.code}(${READINGS.r.inner}) / F=${READINGS.f.code}(${READINGS.f.inner}) [R===F：canRead 无读者] / canRead=${READINGS.s.defaultFactory} / model=${READINGS.s.modelSelection}`)
  })
})

if (SKIP !== false) {
  test('PRT-253 续批二 真 DSH 进程部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
