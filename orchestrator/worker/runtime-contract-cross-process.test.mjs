// orchestrator/worker/runtime-contract-cross-process.test.mjs
// ============================================================================
// ★ PRT-253 跨进程边界的**两进程**证明
//
// ## 这个套件回答的是哪一个问题
//
// 上一批（PRT-253 续批一）量到的缝是：
//
//   > `bindDshRuntime()` 那条注册口在 `orchestrator` 进程里，
//   > 而 DSH 执行引擎在 `runtime` 进程里 —— 所以那条缝填多好都不会改变 worker 的读数。
//
// 本套件用**两个真的操作系统进程**证明那截补上了：
//
//   · **Runtime 进程**：一个真的 `dsh`（`apps/cli/lib/bin.js`），带真补丁层、
//     真 Loader、真 Cordis Context、真服务发布，里面跑
//     `runtime/dsh-composition/plugins/runtime-contract-server-row.mjs` ——
//     它在**那个进程里**起一台 `node:http` 监听器（port 0，回环）。
//   · **orchestrator 侧**：本测试进程。它调用的就是**产品入口调用的那个函数**
//     （`product/orchestrator/worker.mjs` 的 `productionExecutorProviderFromEnv`），
//     而且**本地没有任何绑定**（`resetDshRuntimeBinding()`）。
//
// 两侧之间只有 HTTP。任何一侧缺少那条路，读数都会反转 —— 反向对照逐个给出。
//
// ## 每一个读数都有反向对照
//
// 一条"绿了"的断言只说明这一次是这样。本套件的结构是：**每个读数配一个反转**，
// 最后一条用例把全部读数放在一起断言**两两不同形**。
//
// | # | 处境 | 期望读数（具名码） |
// | --- | --- | --- |
// | A | 契约行挂上 + 有工厂 + 有 token | `ok=true`，且 `execute` 走完 → `completed` |
// | B | **不挂**契约行 | 服务 absent；worker 无 URL → `EXECUTOR_HOST_PORT_REQUIRED` |
// | C | 挂上但**没有人注册工厂** | 进程**照常退出 0**；服务 `ok=false` + `..._NO_INPUTS_FACTORY` |
// | D | 挂上但**没有 token** | 服务 `ok=true` 但 `tokenConfigured=0`；worker → `..._UNAUTHORIZED` + innerCode `..._NO_TOKEN` |
// | E | token 配了但 worker **给错** | `..._UNAUTHORIZED` + innerCode `..._UNAUTHORIZED`（与 D 不同形） |
// | F | URL 配了但**那台进程不在** | `EXECUTOR_RUNTIME_UNREACHABLE`（与 B 不同形） |
// | G | URL 配了但 worker **没给 canRead** | `EXECUTOR_CAN_READ_REQUIRED`（**不**默认放行） |
// | H | URL 配了但 worker **没给 token** | `..._UNAUTHORIZED`（**不发**匿名请求） |
//
// ## 诚实边界（详见 `docs/superpowers/prt/PRT-253-runtime-contract-boundary.md`）
//
//   · **引擎是替身**：那个 `dsh` 进程里的引擎端口（`startRun` / `probeRuntime` /
//     `currentModelSelection`）是脚手架（见 `REGISTRAR_SRC` 的说明）。
//     所以本套件证明的是「**边界**通了、请求真的进了另一个进程、具名拒绝逐条可分」，
//     **不**证明「一台真 DSH 引擎能跑完一个真任务」。
//   · 除引擎外，其余全是真的：真进程、真 Loader、真补丁层（`legion-host.patch.yml`）、
//     真 `node:http` 监听器、真服务发布、真 `RuntimeAdapter`（`createDshRuntimeAdapter`）、
//     真客户端（`createRuntimeContractClient` 那一侧）、真鉴权比较。
//   · 本地绑定的**那条老路**在这里恒为"没有"：本进程从不 `bindDshRuntime`，
//     这正是要证明的处境。
// ============================================================================
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ★ 检出用**共享解析器**找。此前手写 `process.env.DSH_CHECKOUT ?? null`，
//   实测后果：变量没导出时本套件 **19 条全跳**，而 CI 报
//   `PASS tests=19 pass=0 skipped=19`——一个"一条断言都没验过"的绿。
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

import { RUNTIME_CONTRACT_VERSION } from '../../runtime/contracts/adapter.mjs'
import {
  RUNTIME_CONTRACT_ROW_CODES,
  RUNTIME_CONTRACT_SERVER_SERVICE,
} from '../../runtime/dsh-composition/plugins/runtime-contract-server-row.mjs'
import { WIRE_CODES } from '../../runtime/contracts/wire.mjs'
import {
  EXECUTOR_CODES,
  createProductionExecutor,
} from './executor.mjs'
import {
  productionExecutorProviderFromEnv,
  resetDshRuntimeBinding,
  dshRuntimeBound,
  RUNTIME_TOKEN_ENV,
  RUNTIME_URL_ENV,
} from './executor-binding.mjs'

// ---------------------------------------------------------------- 可用性

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const UNAVAILABLE = DSH === null ? DSH_FOUND.reason : null
const SKIP = UNAVAILABLE

const guarded = (name, fn) => test(name, { timeout: 300_000 }, (t) => {
  if (SKIP !== null) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

// ---------------------------------------------------------------- 一次性目录

const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-prt253ct-'))

const PROFILE_NAME = 'prt253ct'

/** 绝对路径 → `file://` URL（脚手架模块里的 import 用绝对 URL，不受 cwd 影响）。 */
const fileUrl = (abs) => pathToFileURL(abs).href

/** 每次一个新的**一次性** `DSH_HOME`。**绝不动真实 profile。** */
function makeHome(tag) {
  const home = mkdtempSync(join(SCRATCH, `home-${tag}-`))
  assert.ok(resolve(home).startsWith(TMP_ROOT), `一次性 home 逃出了 tmpdir：${home}`)
  assert.ok(resolve(home).startsWith(SCRATCH), `一次性 home 逃出了本次运行的 scratch：${home}`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 空用户层\n[]\n')
  return home
}

const LEGION_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt253ct-actor',
  LEGION_SCOPE: 'prt253ct-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

// ---------------------------------------------------------------- 令牌（只在两个进程间传递，绝不落盘/打印）

const TOKEN = 'prt253ct-token-a-7f3c1'
const TOKEN_OTHER = 'prt253ct-token-b-91d4e'
/** 每个场景用的令牌出现在 stderr 里就是泄漏 —— 所有断言都拿它做反向锚。 */
const ALL_TOKENS = [TOKEN, TOKEN_OTHER]

// ================================================================
// 脚手架源码（写进一次性 scratch 目录，全部是**替身**，见文件头）
// ================================================================

/**
 * 服务脚手架：`tools` / `approval` / `sandbox`，真补丁层那几行 inject 的宿主服务。
 *
 * 沿用既有 DSH 进程套件的形状（读数已在那里验过）。
 *
 * ⚠️ **沙箱端口是替身**：它报告 `full` 级管制并**真的**换了 argv。
 * 那是"自检的这一路能被走通"的必要条件，不是"本机沙箱真的在管制"的读数。
 *
 * 引擎端口（`startRun` / `probeRuntime` / `currentModelSelection`）**不在这里** ——
 * 它由 `prt253ct-registrar.mjs` 造，见那个文件的说明。
 */
const SERVICES_SRC = `// 桩宿主：只发布被测几行 inject 的服务。不是 ToolRuntime。
const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'prt253ct-services',
  inject: [],
  apply(ctx) {
    note('SERVICES-ROW-APPLY-RAN')
    ctx.provide('tools', { guard: () => () => undefined })
    ctx.provide('approval', {})
    ctx.provide('sandbox', {
      async confine(argv) {
        return {
          enforcement: 'full',
          backend: 'prt253ct-stub-backend',
          argv: ['prt253ct-stub-sandbox', '--', ...argv],
          denialSignatures: ['operation not permitted'],
        }
      },
    })
    note('SERVICES-PROVIDED tools,approval,sandbox')
  },
}
`

const SERVICES_PATCH_SRC = `- insert:
    - id: "prt253ct-services"
      name: "./prt253ct-services.mjs"
`

/**
 * `permission` 行的替身：只为让**真补丁层**的 `patch-over` 有靶子。
 * 真覆盖动作仍由磁盘上那份 `legion-host.patch.yml` 完成。
 */
const PERMISSION_SRC = `// 替身：只为让真补丁层的 patch-over 有靶子。不含任何权限语义。
export default {
  name: 'prt253ct-permission-standin',
  inject: [],
  apply() { process.stderr.write('PERMISSION-STANDIN-APPLY-RAN\\n') },
}
`

const PERMISSION_PATCH_SRC = `- insert:
    - id: "permission"
      name: "./prt253ct-permission.mjs"
      config:
        presets:
          workspace-write:
            sandbox: "workspace-write"
            approval: "ask"
          danger-full-access:
            sandbox: "danger-full-access"
            approval: "never"
`

const RUNTIME_ROWS_PATCH_SRC = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(HERE, '..', '..', 'runtime', 'dsh-composition', 'plugins', 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(HERE, '..', '..', 'runtime', 'dsh-composition', 'plugins', 'approval-answerer-row.mjs'))}
`

const REAL_PATCH = join(REPO, 'runtime', 'dsh-composition', 'legion-host.patch.yml')

/**
 * ★ **本批新增的注册方**：与 `runtime-host-registrar-row.mjs` 同一形状 ——
 * 在**模块求值期**把两个输入工厂都注册好，然后由两个 thin wrapper 各自
 * `export default` 真的那个插件对象。
 *
 * 为什么必须是"注册进本行自己的模块图"而不是"另起一行注册"：
 * Loader 用 `Promise.allSettled(config.map(create))` **并发**创建补丁行，
 * 所以"注册行先求值、本行后 apply"只在两个模块都不挂起时碰巧成立；
 * 而 ESM 保证被 import 的模块先求值完。
 *
 * ## ★★ 引擎端口是**替身**，而且这里必须说清它替掉的是什么
 *
 * `probeRuntime()` 的能力表是**按产品的必需清单推导**的
 * （`Object.fromEntries(REQUIRED_CAPABILITIES.map(c => [c, true]))`），
 * **不是**任何一台真引擎报出来的。理由是一条实测事实：
 * 真的 `createRuntimeHostInputsFactory()`（它从 `ctx.get('subagents')` 取端口、
 * 由 `probeDshRuntime()` 取能力）在一个只有脚手架服务的进程里只确认得了
 * `structured-result` 一项，于是 `bootstrapDshRuntime` 的自检报
 * `BOOTSTRAP_SELF_CHECK_INCOMPATIBLE`，`legion-runtime-host` 那一行**不发布**绑定服务。
 *
 *   > 于是本套件的选择是：把引擎换成替身，用真进程 / 真 Loader / 真补丁层 /
 *   > 真监听器 / 真鉴权去测**边界**；而不是把边界也换成替身去测引擎。
 *
 * `startRun()` **故意**打印 `START-RUN-CALLED`，好让"请求真的跨过边界了"
 * 成为一个可读的字面事实 —— 否则那条断言只能靠"`executor` 返回了 completed"
 * 来推断，而那个结论在一个把请求丢进虚空却仍回 completed 的替身上也成立。
 *
 * ## ★ 顺带记下的一处**既有**接缝缺口（不是本批引入的）
 *
 * 全仓库**没有任何生产代码**提供 `currentModelSelection`（只有测试夹具提供），
 * 而它在 `OPTIONAL_PORT_METHODS` 里：缺了它 `DshRuntimeAdapter._selection()`
 * 返回 null，每一次 `execute` 都以 `MODEL_UNAVAILABLE` 终态失败。
 * 本文件补一个替身好让跨进程那次运行能走完；**真实部署里那个缺口仍在**。
 */
const REGISTRAR_SRC = `import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-row.mjs')))}
// ★ 只为**副作用**而 import：真补丁层那一行（legion-enforcement-runtime-host-registrar）
//   在**模块求值期**就注册了它自己的工厂（runtime-host-registrar-row.mjs:1063）。
//   ESM 保证被 import 的模块先求值完，所以这一行过后"真注册已经发生"是一个确定的事实，
//   而不是一个取决于 Loader 并发顺序的赌。下面 unregister 那一步要用它。
import { unregisterRuntimeHostInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-registrar-row.mjs')))}
import { setRuntimeContractInputsFactory } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-contract-server-row.mjs')))}
import { REQUIRED_CAPABILITIES } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'contracts', 'adapter.mjs')))}
import { SUPPORTED_RUNTIME } from ${JSON.stringify(fileUrl(join(REPO, 'runtime', 'adapters', 'dsh', 'probe.mjs')))}

const note = (line) => process.stderr.write(line + '\\n')

/** 引擎替身：见文件头「引擎端口是替身」那一节。 */
function buildRuntimeHost() {
  let started = 0
  return {
    async probeRuntime() {
      return {
        version: SUPPORTED_RUNTIME.supportedMajor + '.1.5',
        // 按产品的必需清单推导，**不手写一份**：手写的那份会与
        // REQUIRED_CAPABILITIES 漂移，而漂移的那天表现为"自检说兼容"，不是"少验了一项"。
        capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true])),
      }
    },
    async startRun(provider, options) {
      started += 1
      const prompt = Array.isArray(options?.prompt) ? options.prompt : []
      note('START-RUN-CALLED n=' + started + ' provider=' + String(provider) + ' promptParts=' + prompt.length)
      return {
        result: Promise.resolve({
          structured: { status: 'ok', summary: 'prt253ct-stub-result' },
          usage: { inputTokens: 11, outputTokens: 7 },
          // ★ 必须是契约认得的那个词。第一版写的是 'end_turn'（某家的方言），
          //   而 \`classifyStopReason\` 对**未识别**的 stopReason 判 INVALID_RESULT
          //   —— 于是这次运行"跑到了终点"却报失败，读数看起来像引擎坏了。
          //   那正是它该有的行为（不认识的停止原因不许当成功），错的是替身。
          stopReason: 'completed',
        }),
        async dispose() { note('DISPOSE-CALLED') },
        events: null,
      }
    },
    // 见文件头：生产代码里没有这一项的来源，这里是替身。
    currentModelSelection: () => ({ provider: 'prt253ct-stub-provider', model: 'prt253ct-stub-model' }),
  }
}

/** 权限判定同样是替身：真权威是 lease / 岗位清单，DSH Runtime 进程里两者都不在。 */
const canReadStub = () => true

// ★★ 确定性地让**本套件的替身**赢，而不是赌谁最后注册。
//
//   真补丁层那一行在模块求值期注册了它自己的工厂，而 Loader 用
//   Promise.allSettled 并发创建所有补丁行 ⇒ "真工厂先、替身后"只在两个模块都不挂起时
//   碰巧成立。真工厂要 ctx.get('subagents')，而本进程只有脚手架服务（tools / approval /
//   sandbox）⇒ 它一旦赢，bootstrapDshRuntime 的自检就报 composition-patch-layer 红、
//   worker 读到 EXECUTOR_SELF_CHECK_INCOMPATIBLE，本套件要测的"跨进程边界"整条读不出来。
//
//   上面那次 import 已经保证真注册发生过，unregister 撤掉的正是它那一次
//   （幂等、且只撤自己那一次，见 runtime-host-row.mjs:243）。于是这里的替身是**唯一**
//   活着的工厂 —— 读数不再随求值顺序摆动。
unregisterRuntimeHostInputsFactory()
setDshRuntimeInputsFactory(() => ({ runtimeHost: buildRuntimeHost(), canRead: canReadStub }))

setRuntimeContractInputsFactory(() => {
  const token = process.env.PRT253CT_TOKEN
  const configured = typeof token === 'string' && token !== ''
  // ★ PRT-253 续批四：DataDir 交进去，那一行才会把**临时端口**发布出来。
  //   本套件的父进程随后去读那份发布，与探针打印的 \`CONTRACTSVC port=\` 对账
  //   —— 于是"发布的是实际绑定的端口"这件事在一个**真 DSH 进程**里被验到，
  //   而不只是在行内用例里。
  const dataDir = process.env.PRT253CT_DATA_DIR
  note('CONTRACT-FACTORY-CALLED tokenConfigured=' + (configured ? 1 : 0)
    + ' dataDirConfigured=' + (typeof dataDir === 'string' && dataDir !== '' ? 1 : 0))
  return {
    runtimeHost: buildRuntimeHost(),
    token: configured ? token : null,
    // port 0 = 内核分配临时端口。**绝不绑固定端口**（会与别的用例/服务撞）。
    // 实际端口由服务值带出来，探针把它打印在 stderr 上给父进程读。
    bindPort: 0,
    dataDir: typeof dataDir === 'string' && dataDir !== '' ? dataDir : null,
  }
})
`

/**
 * 工厂注册行：**只**注册两个输入工厂，**自己不挂任何产品行**。
 *
 * ★★ 为什么不能再像原来那样多挂一份 `runtime-host-row` / `runtime-contract-server-row`：
 *   真补丁层（`legion-host.patch.yml`）**已经**声明了那两行 ——
 *   `legion-enforcement-runtime-host-registrar` 的模块是
 *   `runtime-host-registrar-row.mjs`，而它的 default **就是** `runtimeHostRow` 本体
 *   （`===`，业主裁决甲有意为之）；`legion-enforcement-runtime-contract-server` 同理。
 *   于是"夹具再挂一份" = 同一个插件对象被两个 fiber 各 apply 一次 ⇒
 *   两行都 `ctx.provide` 同一个服务名 ⇒ cordis 当场抛
 *   `service "legionRuntimeHostBinding" has been registered`，
 *   或者那一行被报成"已挂载但未激活（等待依赖服务）" ⇒
 *   `composition-patch-layer` 红 ⇒ 自检不兼容 ⇒ 本套件要测的跨进程边界整条读不出来。
 *
 *   > 一个"为了让夹具自足而多挂一份"的写法，
 *   > 与一个"把产品那一行挤掉"的写法，在只数"行在不在树里"的时候是同一个东西 ——
 *   > 只不过后者会让服务注册互相打架。
 *
 * 本行只做一件事：import 注册方模块（ESM 保证它先求值完）⇒ 两个工厂都已注册。
 * 产品那两行随后用自己的 default 挂上，并从这两个工厂取输入。
 */
const FACTORY_ROW_SRC = `import './prt253ct-registrar.mjs'
export default {
  name: 'prt253ct-factory',
  inject: [],
  apply() {},
}
`

const FACTORY_ROW_PATCH_SRC = `- insert:
    - id: "prt253ct-factory"
      name: "./prt253ct-factory.mjs"
`

/** 反向对照 C：**产品自己的**那一行模块直接当补丁行挂 = "行交付了、没人注册工厂"。 */
const SERVERROW_ONLY_PATCH_SRC = `- insert:
    - id: ${JSON.stringify('legion-runtime-contract-server')}
      name: ${JSON.stringify(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-contract-server-row.mjs'))}
`

/**
 * 反向对照 B：把**真补丁层那一行**关掉 —— 它现在才是契约行在树里的唯一来源。
 *
 * 原来那个"插一个 disabled 占位行"的写法**不会**让服务消失：契约行还有真补丁层
 * 那一份在树里，于是 B 读到的是"不挂那一行却读到了服务"。要构造"没有本行"这个处境，
 * 必须关掉**真那一个 id**。
 */
const DISABLE_SERVERROW_PATCH_SRC = `- id: "legion-enforcement-runtime-contract-server"
  disabled: true
`

/**
 * 探针：等契约行 settle，把它的**发布值**打印出来，然后**保持进程活着**
 * 等父进程关 stdin —— 因为跨进程那条路要在本进程活着的时候被走。
 *
 * 轮询而不是定时：Loader 并发建行，端口何时绑上没有保证。
 */
const PROBE_SRC = `const note = (line) => process.stderr.write(line + '\\n')
const WAIT_MS = Number(process.env.PRT253CT_WAIT_MS || '20000')
const SERVICE = ${JSON.stringify(RUNTIME_CONTRACT_SERVER_SERVICE)}

function hold() {
  note('READY')
  let done = false
  const finish = (tag) => {
    if (done) return
    done = true
    note('PROBE-EXIT ' + tag)
    process.exit(0)
  }
  // 父进程关 stdin ⇒ 立刻退。父进程若意外消失，硬上限兜底，绝不留下孤儿进程。
  try { process.stdin.resume() } catch { /* 没有 stdin */ }
  process.stdin.on('end', () => finish('stdin-closed'))
  process.stdin.on('close', () => finish('stdin-closed'))
  setTimeout(() => finish('hard-cap'), 120000).unref?.()
}

export default {
  name: 'prt253ct-probe',
  inject: [],
  apply(ctx) {
    const deadline = Date.now() + WAIT_MS
    const tick = () => {
      const svc = ctx.get(SERVICE, false)
      if (svc === undefined) {
        if (Date.now() > deadline) { note('CONTRACTSVC ok=absent'); hold(); return }
        setTimeout(tick, 100)
        return
      }
      note('CONTRACTSVC ok=' + (svc.ok === true ? 1 : 0)
        + ' code=' + String(svc.code === null || svc.code === undefined ? 'none' : svc.code)
        + ' listening=' + (svc.listening === true ? 1 : 0)
        + ' port=' + String(svc.port === null || svc.port === undefined ? '' : svc.port)
        + ' tokenConfigured=' + (svc.tokenConfigured === true ? 1 : 0)
        + ' enforcementConfigured=' + (svc.enforcementConfigured === true ? 1 : 0)
        + ' warnings=' + (Array.isArray(svc.warnings) ? svc.warnings.join('|') : '?'))
      // 强制面结论（跨进程要读的那一条）也在这里留一个进程内读数，
      // 好让"worker 那边读到的东西"与"这台进程自己认为的东西"能对照。
      //
      // ★ \`hold()\` 必须在这次 fetch **结算之后**才调用：否则父进程可能
      //   在 SELF-ENFORCEMENT 那一行到达之前就读到 READY，于是那条读数
      //   时有时无 —— 一条"有时候在"的读数比一条没有的读数更坏。
      if (svc.ok === true && typeof svc.port === 'number') {
        const token = process.env.PRT253CT_TOKEN
        const headers = {}
        if (typeof token === 'string' && token !== '') headers.authorization = 'Bearer ' + token
        fetch('http://127.0.0.1:' + svc.port + '/legion/runtime/v1/enforcement', { headers })
          .then(async (r) => {
            const text = await r.text()
            note('SELF-ENFORCEMENT status=' + r.status + ' body=' + text.slice(0, 160))
          })
          .catch((e) => note('SELF-ENFORCEMENT-ERR ' + String(e && e.message ? e.message : e)))
          .finally(hold)
        return
      }
      hold()
    }
    // 先给别的行一点时间；然后开始轮询。
    setTimeout(tick, 400)
  },
}
`

const PROBE_PATCH_SRC = `- insert:
    - id: "prt253ct-probe"
      name: "./prt253ct-probe.mjs"
`

// ---------------------------------------------------------------- 写脚手架

const SCRATCH_FILES = {
  services: ['prt253ct-services.mjs', SERVICES_SRC],
  servicesPatch: ['prt253ct-services.patch.yml', SERVICES_PATCH_SRC],
  permission: ['prt253ct-permission.mjs', PERMISSION_SRC],
  permissionPatch: ['prt253ct-permission.patch.yml', PERMISSION_PATCH_SRC],
  runtimeRowsPatch: ['prt253ct-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH_SRC],
  registrar: ['prt253ct-registrar.mjs', REGISTRAR_SRC],
  factoryRow: ['prt253ct-factory.mjs', FACTORY_ROW_SRC],
  factoryRowPatch: ['prt253ct-factory.patch.yml', FACTORY_ROW_PATCH_SRC],
  serverRowOnlyPatch: ['prt253ct-serverrow-only.patch.yml', SERVERROW_ONLY_PATCH_SRC],
  disableServerRowPatch: ['prt253ct-disable-serverrow.patch.yml', DISABLE_SERVERROW_PATCH_SRC],
  probe: ['prt253ct-probe.mjs', PROBE_SRC],
  probePatch: ['prt253ct-probe.patch.yml', PROBE_PATCH_SRC],
}

const SCRATCH_PATH = {}
for (const [key, [fileName, source]] of Object.entries(SCRATCH_FILES)) {
  SCRATCH_PATH[key] = join(SCRATCH, fileName)
  writeFileSync(SCRATCH_PATH[key], source)
}

// 前提：真补丁层与它指的那几个模块都在。缺了就让用例**响亮地**红，
// 而不是让全部读数一起退化成"组合树没生效"。
if (SKIP === null) {
  assert.ok(existsSync(REAL_PATCH), `真补丁层不在：${REAL_PATCH}`)
  for (const p of [
    join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-contract-server-row.mjs'),
    join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-registrar-row.mjs'),
    join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-row.mjs'),
  ]) {
    assert.ok(existsSync(p), `本套件依赖的模块不在：${p}`)
  }
}

// ---------------------------------------------------------------- 场景

const BASE_PATCHES = [
  SCRATCH_PATH.servicesPatch,
  // ★ 顺序刻意：`permission` 替身必须在真补丁层**之前**，那一层的 patch-over
  //   才打得到靶子。反过来会 warn-and-skip —— 不报错，只是覆盖打空。
  SCRATCH_PATH.permissionPatch,
  REAL_PATCH,
  SCRATCH_PATH.runtimeRowsPatch,
]

const SCENARIOS = Object.freeze({
  /** A：契约行挂上 + 有工厂 + 有令牌。 */
  full: Object.freeze({
    tag: 'full',
    token: TOKEN,
    waitMs: 25_000,
    patches: Object.freeze([...BASE_PATCHES, SCRATCH_PATH.factoryRowPatch, SCRATCH_PATH.probePatch]),
  }),
  /** B：**不挂**契约行，其余一字不变。 */
  noRow: Object.freeze({
    tag: 'norow',
    token: TOKEN,
    waitMs: 8_000,
    patches: Object.freeze([...BASE_PATCHES, SCRATCH_PATH.factoryRowPatch, SCRATCH_PATH.disableServerRowPatch, SCRATCH_PATH.probePatch]),
  }),
  /** C：挂上真模块，但**没有人注册工厂**。 */
  noInputs: Object.freeze({
    tag: 'noinputs',
    token: TOKEN,
    waitMs: 15_000,
    patches: Object.freeze([SCRATCH_PATH.servicesPatch, SCRATCH_PATH.serverRowOnlyPatch, SCRATCH_PATH.probePatch]),
  }),
  /** D：契约行挂上、工厂注册了，但进程里**没有令牌**。 */
  noToken: Object.freeze({
    tag: 'notoken',
    token: null,
    waitMs: 25_000,
    patches: Object.freeze([...BASE_PATCHES, SCRATCH_PATH.factoryRowPatch, SCRATCH_PATH.probePatch]),
  }),
  /** E：令牌配了（与 A 同一个），worker 给**另一个**。 */
  otherToken: Object.freeze({
    tag: 'othertoken',
    token: TOKEN_OTHER,
    waitMs: 25_000,
    patches: Object.freeze([...BASE_PATCHES, SCRATCH_PATH.factoryRowPatch, SCRATCH_PATH.probePatch]),
  }),
})

const LIVE = new Map()

/**
 * ★ 收尾**只能有一个** hook，而且顺序是固定的：先关子进程，再删目录。
 *
 * 第一版把 `rmSync` 单独注册成 `after`，于是它在"关子进程"那个 hook **之前**跑
 * （node:test 按注册顺序跑 after），而活着的 `dsh` 子进程还占着 home 里的文件
 * —— Windows 上就是 `EPERM ... rm`。
 *
 *   > 一个"清理失败"的报错，看起来像套件出了问题；
 *   > 而真因只是清理**顺序**写反了。
 */
after(async () => {
  const all = [...LIVE.values()]
  LIVE.clear()
  await Promise.all(all.map((r) => r.stop().catch(() => undefined)))
  // 子进程退出之后句柄未必立刻释放；Windows 上给 rmSync 自己重试。
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

/**
 * 起一个真 `dsh`，等它把契约行的公开读数打到 stderr 上。
 *
 * 与既有 DSH 进程套件的差别只有一处：这里**不能**用 `spawnSync` ——
 * 跨进程那条路要在那台进程**活着**的时候从本进程走一遍。
 */
function runDsh(scenario) {
  const home = makeHome(scenario.tag)
  /**
   * 一次性的 Legion DataDir。
   *
   * 它必须**在 scratch 里**（`tmpdir()` 下、本次运行的目录下）：那一行会往
   * `<dataDir>/runtime/runtime-contract.json` 写一份发布，而"往哪个目录写"
   * 是本批新接的线之一。写到真实目录里去就等于污染运行环境。
   */
  const dataDir = join(home, 'legion-data')
  mkdirSync(dataDir, { recursive: true })
  assert.ok(resolve(dataDir).startsWith(TMP_ROOT), `一次性 DataDir 逃出了 tmpdir：${dataDir}`)
  assert.ok(resolve(dataDir).startsWith(SCRATCH), `一次性 DataDir 逃出了本次运行的 scratch：${dataDir}`)
  const args = ['--profile', PROFILE_NAME]
  for (const patch of scenario.patches) args.push('--patch', patch)

  const env = { ...process.env, DSH_HOME: home, ...LEGION_ENV, PRT253CT_WAIT_MS: String(scenario.waitMs), PRT253CT_DATA_DIR: dataDir }
  if (scenario.token === null) delete env.PRT253CT_TOKEN
  else env.PRT253CT_TOKEN = scenario.token
  delete env.DSH_SNAPSHOT

  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: SCRATCH,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderr = ''
  let stdout = ''
  let spawnError = null
  let exited = null

  const ready = new Promise((resolveReady) => {
    let settled = false
    const settle = () => { if (!settled) { settled = true; resolveReady() } }
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8')
      if (/^READY$/m.test(stderr)) settle()
    })
    child.stdout.on('data', (b) => { stdout += b.toString('utf8') })
    child.on('error', (e) => { spawnError = String(e?.message ?? e); settle() })
    child.on('exit', () => settle())
  })

  const finished = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal: signal ?? null }
      resolveExit(exited)
    })
  })

  const record = {
    tag: scenario.tag,
    child,
    home,
    dataDir,
    ready,
    finished,
    get stderr() { return stderr },
    get stdout() { return stdout },
    get spawnError() { return spawnError },
    get exited() { return exited },
    /** 关 stdin → 探针退；父进程是唯一的收尾者。 */
    async stop() {
      if (exited !== null) return exited
      try { child.stdin.end() } catch { /* 已经关了 */ }
      const killed = new Promise((r) => setTimeout(() => {
        try { child.kill() } catch { /* 已经没了 */ }
        r({ code: null, signal: 'killed-by-test' })
      }, 20_000))
      return Promise.race([finished, killed])
    },
  }
  LIVE.set(scenario.tag, record)
  return record
}

async function scenario(name) {
  const record = LIVE.get(SCENARIOS[name].tag) ?? runDsh(SCENARIOS[name])
  await record.ready
  assert.equal(record.spawnError, null, `${name} 起不来：${record.spawnError}`)
  return record
}

/** 从 stderr 读一个 `KEY …` 行；读不到返回 `null`（不猜一个默认值）。 */
function lineOf(stderr, key) {
  const m = new RegExp(`^${key} (.*)$`, 'm').exec(stderr)
  return m === null ? null : m[1].trim()
}

/**
 * 递归列出目录下的**普通文件**（找不到目录时返回空数组，不抛）。
 *
 * 它存在的理由是"凭证不许落盘"这条要求：只检查 `stderr` 是不够的——
 * 一个把令牌写进状态文件的实现，在进程输出里是干净的。
 */
function walkFiles(dir) {
  const out = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st = null
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) out.push(...walkFiles(full))
    else if (st.isFile()) out.push(full)
  }
  return out
}

/** 读一个 `CONTRACTSVC k=v k=v` 读数行。 */
function contractReading(stderr) {
  const line = lineOf(stderr, 'CONTRACTSVC')
  if (line === null) return null
  const out = {}
  for (const part of line.split(' ')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

// ---------------------------------------------------------------- 引擎侧的 hub 替身（本进程内）

const HUB_OK = Object.freeze({
  status: 200,
  body: {
    ok: true,
    verification: { ok: true },
    snapshot: { finalText: 'prt253ct-frozen-prompt', associations: {} },
  },
})

const post = async () => HUB_OK
const get = async () => HUB_OK

/**
 * 一个**分流**的 fetch：`hub.invalid` 走替身，其余走真网络。
 *
 * 为什么非分流不可：`productionExecutorProviderFromEnv` 用**同一个** `fetchImpl`
 * 造两样东西 —— hub 的 `post`/`get`（数据面）与契约客户端（引擎面）。
 * 用一个"什么都拦"的替身会让跨进程那一段也变成替身（套件就白跑了）；
 * 用一个"什么都不拦"的真 fetch 会在数据面上撞 `ENOTFOUND hub.invalid`。
 */
function makeFetch(hub = HUB_OK) {
  return async (url, init) => {
    if (String(url).startsWith('http://hub.invalid')) {
      return new Response(JSON.stringify(hub.body), {
        status: hub.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return globalThis.fetch(url, init)
  }
}

const LEASE = Object.freeze({
  attemptId: 'att-ct-1',
  runId: 'run-ct-1',
  idempotencyKey: 'idem-ct-1',
  workspaceId: 'ws-ct-1',
  goalId: 'goal-ct-1',
  taskId: 'task-ct-1',
  employeeId: 'emp-ct-1',
  teamPlanRef: 'plan-ct-1',
  modelProfileRef: 'prt253ct-stub-model',
  workdir: process.platform === 'win32' ? 'C:\\work\\ct' : '/work/ct',
  /**
   * ★ **不给 `maxCostUsd`**，只给 token 上限 —— 这一条是被实测逼出来的。
   *
   * 第一版这里写的是 `{ maxCostUsd: 1 }`，而替身模型名不在价格表里，
   * 于是 `estimateCostUsd` 返回 `null`，`checkBudget` 判 `cost-unknown`
   * → 适配器把这次运行结算成 `BUDGET_EXCEEDED`。
   *
   * 那个行为是**对的**（费用未知不得当成没超预算），错的是这个夹具：
   * 一个跨进程边界测试若因为"模型没定价"而每次都失败，那它测的是价格表。
   * token 数在替身里是已知的，于是这一条上限能真的被算出来。
   */
  budget: { maxTokens: 1_000_000 },
  timeoutMs: 10_000,
  permissions: { preset: 'legion-unattended', tools: [] },
  outputSchema: { type: 'object', additionalProperties: true },
  acceptance: '引擎正常结算',
})

/** 产品入口读的那两个键 + hub 的两个键。**没有本地绑定。** */
function workerEnv(runtimeUrl, runtimeToken) {
  const env = { TEAM_HUB_URL: 'http://hub.invalid:8787', TEAM_HUB_TOKEN: 'hub-token-not-real' }
  if (runtimeUrl !== undefined) env[RUNTIME_URL_ENV] = runtimeUrl
  if (runtimeToken !== undefined) env[RUNTIME_TOKEN_ENV] = runtimeToken
  return env
}

/**
 * 本套件里产品入口的**唯一**调用点：默认接上那个分流的 fetch。
 *
 * 直接裸调 `productionExecutorProviderFromEnv` 会让数据面去打 `hub.invalid`
 * （`ENOTFOUND`），于是真正的失败读数会被一个与边界无关的网络错误盖掉。
 */
const provider = (input = {}) => productionExecutorProviderFromEnv({ fetchImpl: makeFetch(), ...input })

const canRead = () => true

before(() => {
  // 本进程**从不**绑定：这正是要证明的处境。但万一别的用例污染了，这里清干净。
  resetDshRuntimeBinding()
  assert.equal(dshRuntimeBound(), false, '本套件的前提是 worker 侧没有任何本地绑定')
})

/** 把一次 provider 调用压成一个可比较的读数。 */
async function providerReading(input) {
  const r = await provider(input)
  return {
    ok: r.ok === true,
    code: r.code ?? null,
    innerCode: r.innerCode ?? null,
    outcome: r.ok === true ? (r.executor === undefined ? 'no-executor' : 'executor') : null,
  }
}

// ================================================================ 反转对照

guarded('反转对照：本进程**没有**任何本地绑定 —— 这是全部读数的前提', (t) => {
  assert.equal(dshRuntimeBound(), false)
  t.diagnostic('本进程 dshRuntimeBound()=false')
})

// ================================================================ A 正向

guarded('A0. ★★★ Runtime 进程里那一行**真的**起了监听器（端口从服务值读回）', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  assert.notEqual(svc, null, `探针没给出 CONTRACTSVC 读数：\n${r.stderr}`)
  assert.equal(svc.ok, '1', `契约行没装上：${JSON.stringify(svc)}\n${r.stderr}`)
  assert.equal(svc.listening, '1')
  assert.equal(svc.tokenConfigured, '1', '本场景配了令牌，读数必须是 1')
  assert.equal(svc.warnings, '', `配了令牌就不该有降级警告：${svc.warnings}`)
  assert.ok(Number(svc.port) > 0, `端口必须是内核分配的真实端口：${svc.port}`)
  // ★ 反向锚：**不是** 3080（那会与 DSH 自己撞）、**不是** 0。
  assert.notEqual(Number(svc.port), 0)
  assert.notEqual(Number(svc.port), 3080)
  // 真补丁层那几行也照常在（说明这不是一个"只挂了本行"的假进程）。
  assert.match(r.stderr, /^SERVICES-PROVIDED tools,approval,sandbox$/m, r.stderr)
  assert.match(r.stderr, /^PERMISSION-STANDIN-APPLY-RAN$/m, r.stderr)
  assert.match(r.stderr, /^CONTRACT-FACTORY-CALLED tokenConfigured=1 dataDirConfigured=1$/m, r.stderr)
  t.diagnostic(`A0: 端口 ${svc.port}`)
})

guarded('A0b. ★★★ 那一行把**实际绑定**的临时端口发布到了 DataDir 下（真进程、真文件）', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  const publicationPath = join(r.dataDir, 'runtime', 'runtime-contract.json')
  assert.equal(existsSync(publicationPath), true,
    `契约行没有发布端口：${publicationPath}（DataDir=${r.dataDir}）`)
  const published = JSON.parse(readFileSync(publicationPath, 'utf8'))

  // ★ 发布里的端口 == 探针从服务值读回的那个端口。
  //   这一条在两个真读数之间对账，而不是在"代码里有没有那一行"之间对账：
  //   把 `listened.port` 写成 `bindPort`（0）会让这条立刻红。
  assert.equal(published.port, Number(svc.port),
    `发布里的端口(${published.port})与那一行实际听的端口(${svc.port})不一致`)
  assert.notEqual(published.port, 0)
  assert.notEqual(published.port, 3080)
  assert.equal(published.host, '127.0.0.1')
  // ★ pid 必须是**本套件 spawn 的那个进程**：消费侧唯一的陈旧判据就是它。
  assert.equal(published.pid, r.child.pid, '发布的 pid 不是那个 DSH 进程')
  assert.equal(published.version, 1)
  assert.equal(Number.isInteger(published.wireVersion), true)
  // 反向锚：发布文件里**没有**任何凭证。它是本批唯一由 Runtime 进程写下的文件，
  // 如果凭证会落盘，落在这里是最"顺手"的。
  for (const token of ALL_TOKENS) {
    assert.equal(readFileSync(publicationPath, 'utf8').includes(token), false,
      '端口发布文件里出现了令牌——凭证落盘是被禁止的')
  }
  t.diagnostic(`A0b: 发布 ${publicationPath} → 端口 ${published.port} / pid ${published.pid}`)
})

guarded('A1. ★★★ 强制面结论**跨进程**读回来：worker 的 selfCheck 是那台进程的自检结论', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  const base = `http://127.0.0.1:${svc.port}`

  const reading = await providerReading({
    env: workerEnv(base, TOKEN), canRead,
  })
  // ★ 这一条是本套件的全部意义：**没有本地绑定**，worker 却拿到了一个可用的引擎。
  assert.equal(reading.ok, true, `跨进程那条路没通：${JSON.stringify(reading)}`)
  assert.notEqual(reading.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
  const enabled = await provider({ env: workerEnv(base, TOKEN), canRead })
  assert.equal(enabled.ok, true)
  assert.equal(typeof enabled.selfCheck?.autoExecutionForbidden, 'boolean',
    '"禁止自动执行"的判定必须是一个布尔，不能缺')
  assert.equal(enabled.selfCheck.autoExecutionForbidden, false)
  // 进程内自报与跨进程读回必须**一致**（否则两边读的不是同一件事）。
  const self = lineOf(r.stderr, 'SELF-ENFORCEMENT')
  assert.notEqual(self, null, `探针没给出进程内自报：\n${r.stderr}`)
  assert.match(self, /^status=200/, `那台进程自己读自己的强制面端点应当是 200：${self}`)
  t.diagnostic(`A1: ${JSON.stringify(reading)} / selfCheck.autoExecutionForbidden=${enabled.selfCheck.autoExecutionForbidden}`)
})

guarded('A2. ★★★ 一次 `execute` 真的**进了另一个进程**：那台进程打印了 START-RUN-CALLED', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  const base = `http://127.0.0.1:${svc.port}`

  const before = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  assert.equal(before, 0, '这一条必须在**第一次** execute 之前断言，否则"它被调过"可能来自别处')

  const built = await provider({ env: workerEnv(base, TOKEN), canRead })
  assert.equal(built.ok, true, `没造出执行器：${JSON.stringify(built)}`)

  const outcome = await built.executor.execute(LEASE)
  assert.equal(outcome.outcome, 'completed',
    `跨进程的那次运行没走完：${JSON.stringify(outcome)}\n${r.stderr}`)
  assert.equal(outcome.budgetState, 'not-gated', '没接预算闸门时这个读数必须是 not-gated，不与"预算充足"同形')

  // ★★ 关键：请求**真的**到了另一个操作系统进程里。
  //   这一条不能靠"executor 返回了 completed"来推断 —— 一个把请求丢进虚空、
  //   却仍然回 completed 的替身也会让它变绿。
  await new Promise((res) => setTimeout(res, 300))
  const after = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  assert.equal(after, before + 1,
    `本进程拿到 completed，但那台进程里 \`startRun\` 一次都没被调到 —— 那就不是跨进程执行：\n${r.stderr}`)
  assert.match(r.stderr, /^START-RUN-CALLED n=1 provider=prt253ct-stub-provider promptParts=1$/m, r.stderr)
  // 收尾也发生在那边（dispose 是引擎侧的清理）。
  await new Promise((res) => setTimeout(res, 200))
  assert.match(r.stderr, /^DISPOSE-CALLED$/m, `引擎侧的清理没跑：\n${r.stderr}`)
  t.diagnostic(`A2: outcome=${outcome.outcome}；Runtime 进程 startRun 调用 ${after} 次`)
})

guarded('A3. 凭证不出现在任何一侧的可读输出里（反向锚）', async (t) => {
  const r = await scenario('full')
  for (const token of ALL_TOKENS) {
    assert.equal(r.stderr.includes(token), false, `Runtime 进程的 stderr 里出现了令牌：${token}`)
    assert.equal(r.stdout.includes(token), false, `Runtime 进程的 stdout 里出现了令牌：${token}`)
  }
  // 而"配了令牌"这个**事实**是可读的（可观测性不该靠泄漏凭证）。
  assert.match(r.stderr, /^CONTRACT-FACTORY-CALLED tokenConfigured=1 dataDirConfigured=1$/m, r.stderr)
  t.diagnostic('A3: 令牌未出现在子进程输出里')
})

guarded('A3b. ★★★ 凭证也**不落盘**：DataDir 下每一个文件里都没有它（含那份端口发布）', async (t) => {
  const r = await scenario('full')
  const files = walkFiles(r.dataDir)
  // 至少要有那份发布，否则这条断言可能什么都没查（一个空目录会让它恒真）。
  assert.ok(files.some((f) => f.endsWith('runtime-contract.json')),
    `DataDir 下没有端口发布，这条没查到东西：${JSON.stringify(files)}`)
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const token of ALL_TOKENS) {
      assert.equal(text.includes(token), false, `DataDir 下的文件落盘了令牌：${f}`)
    }
  }
  t.diagnostic(`A3b: 扫了 ${files.length} 个文件，均无令牌`)
})

// ================================================================ B / C / D / E / F / G / H

guarded('B. ★★ 反向对照：**不挂**契约行 → 服务 absent，worker 无 URL → 老读数一字不变', async (t) => {
  const r = await scenario('noRow')
  const svc = contractReading(r.stderr)
  assert.notEqual(svc, null, `探针没给出读数：\n${r.stderr}`)
  assert.equal(svc.ok, 'absent', `不挂那一行却读到了服务：${JSON.stringify(svc)}`)
  assert.equal(r.stderr.includes('CONTRACT-FACTORY-CALLED'), false,
    'B 场景里出现了注册标记 —— 那 A/B 的差别就不是"挂没挂那一行"了')

  // worker 侧：**没有** URL → 那条既有的具名拒绝必须一字不改。
  const reading = await providerReading({ env: workerEnv(), canRead })
  assert.equal(reading.ok, false)
  assert.equal(reading.code, EXECUTOR_CODES.HOST_PORT_REQUIRED,
    `没配端点时必须仍是那条老拒绝：${JSON.stringify(reading)}`)
  assert.notEqual(reading.code, EXECUTOR_CODES.RUNTIME_UNREACHABLE,
    '"没配"与"配了但够不着"合成一个码，会让运维去查一台他根本没配的机器')
  t.diagnostic(`B: ${JSON.stringify(reading)}`)
})

guarded('C. ★★ 挂上但没有工厂 → **进程照常退出 0**，服务是可见的具名降级', async (t) => {
  const r = await scenario('noInputs')
  const svc = contractReading(r.stderr)
  assert.notEqual(svc, null, `探针没给出读数：\n${r.stderr}`)
  assert.equal(svc.ok, '0', `没有工厂时必须给出 ok=0 的**可见**状态：${JSON.stringify(svc)}\n${r.stderr}`)
  assert.equal(svc.code, RUNTIME_CONTRACT_ROW_CODES.NO_INPUTS_FACTORY)
  assert.equal(svc.listening, '0')
  assert.equal(svc.port, '', '没装上就不该报一个端口')

  // ★★ 与本批的取舍直接对应：出口挂不上**不**阻止启动。
  //   一个"为了多报一条错而让整个产品起不来"的行，把可见的小故障换成了不可用的大故障。
  const exit = await r.stop()
  assert.equal(exit.code, 0, `契约行装不上不该拦下启动（exit=${exit.code}）：\n${r.stderr}`)
  // 反向锚：这一条**不是**"行没被加载"。行加载了、apply 跑了、并且说得清为什么没装上。
  assert.equal(r.stderr.includes(`failed to apply loader entry ${'legion-runtime-contract-server'}`), false,
    `行不该被判为"没激活"——它激活了、并发布了具名状态：\n${r.stderr}`)
  t.diagnostic(`C: exit=0 code=${svc.code}`)
})

guarded('D. ★★★ 挂上但**没有令牌** → 服务仍在听，但需要鉴权的操作以 NO_TOKEN 拒绝', async (t) => {
  const r = await scenario('noToken')
  const svc = contractReading(r.stderr)
  assert.notEqual(svc, null, `探针没给出读数：\n${r.stderr}`)
  assert.equal(svc.ok, '1', `没有令牌时服务**仍然**要装上（health 是匿名可读的）：${JSON.stringify(svc)}\n${r.stderr}`)
  assert.equal(svc.tokenConfigured, '0')
  assert.equal(svc.warnings, RUNTIME_CONTRACT_ROW_CODES.NO_TOKEN,
    `"装上了但没配令牌"必须是一条**可见的降级**：${svc.warnings}`)
  assert.match(r.stderr, /^CONTRACT-FACTORY-CALLED tokenConfigured=0 dataDirConfigured=1$/m, r.stderr)

  // 那台进程自己读自己的强制面端点 → 403 NO_TOKEN（匿名/错凭证都到不了）。
  const self = lineOf(r.stderr, 'SELF-ENFORCEMENT')
  assert.notEqual(self, null, `探针没给出进程内自报：\n${r.stderr}`)
  assert.match(self, /^status=403/, `没配令牌时强制执行面端点必须 fail closed：${self}`)
  assert.ok(self.includes(WIRE_CODES.NO_TOKEN), `拒绝码必须是 NO_TOKEN：${self}`)

  // worker 侧：URL 配了、令牌也给了 → 对端说"我没配"，于是必须是那**一条**。
  const base = `http://127.0.0.1:${svc.port}`
  const reading = await providerReading({ env: workerEnv(base, TOKEN), canRead })
  assert.equal(reading.ok, false)
  assert.equal(reading.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED, JSON.stringify(reading))
  assert.equal(reading.innerCode, WIRE_CODES.NO_TOKEN,
    `对端的码必须原样带出来：${JSON.stringify(reading)}`)
  t.diagnostic(`D: ${JSON.stringify(reading)}`)
})

guarded('E. ★★★ 对端令牌是 TOKEN_OTHER，worker 给 TOKEN → 401 UNAUTHORIZED（与 D 不同形）', async (t) => {
  const r = await scenario('otherToken')
  const svc = contractReading(r.stderr)
  assert.notEqual(svc, null, `探针没给出读数：\n${r.stderr}`)
  assert.equal(svc.ok, '1')
  assert.equal(svc.tokenConfigured, '1', '本场景那台进程**配了**令牌（只是不是 worker 给的那个）')

  const base = `http://127.0.0.1:${svc.port}`
  const reading = await providerReading({ env: workerEnv(base, TOKEN), canRead })
  assert.equal(reading.ok, false)
  assert.equal(reading.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED)
  assert.equal(reading.innerCode, WIRE_CODES.UNAUTHORIZED,
    `凭证不匹配的口径是 UNAUTHORIZED：${JSON.stringify(reading)}`)

  // ★★ D 与 E 必须**不同形**：一台机器没配 vs 你给错了。修法完全不同。
  //
  // 这里用 `scenario('noToken')` 而不是 `LIVE.get('notoken')`：后者会让本用例
  // **依赖 D 先跑过**，于是"单独跑 E"或"改了用例顺序"会表现成产品坏了。
  const dRun = await scenario('noToken')
  const dReading = await providerReading({
    env: workerEnv(`http://127.0.0.1:${contractReading(dRun.stderr).port}`, TOKEN), canRead,
  })
  assert.equal(dReading.innerCode, WIRE_CODES.NO_TOKEN)
  assert.notEqual(reading.innerCode, dReading.innerCode,
    'NO_TOKEN 与 UNAUTHORIZED 被合成一个读数，会让运维去配一台本来就配好了的机器')
  t.diagnostic(`E: innerCode=${reading.innerCode}（D 的是 ${dReading.innerCode}）`)
})

guarded('F. ★★★ URL 配了但那台进程**不在** → RUNTIME_UNREACHABLE（与 B 不同形）', async (t) => {
  // 用一个已确定没人听的端口。它**不是**"没配"（B），也**不是**"凭证不对"（D/E）。
  const deadPort = await reserveThenReleasePort()
  const reading = await providerReading({
    env: workerEnv(`http://127.0.0.1:${deadPort}`, TOKEN), canRead,
  })
  assert.equal(reading.ok, false)
  assert.equal(reading.code, EXECUTOR_CODES.RUNTIME_UNREACHABLE, JSON.stringify(reading))
  const bReading = await providerReading({ env: workerEnv(), canRead })
  assert.equal(bReading.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
  assert.notEqual(reading.code, bReading.code,
    '"配了但够不着"与"没配"合成一个码，会让运维分不清是去查进程还是去查配置')
  t.diagnostic(`F: ${JSON.stringify(reading)}`)
})

guarded('G. ★★★ URL 配了、令牌给了，但**没给 canRead** → CAN_READ_REQUIRED（不默认放行）', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  const base = `http://127.0.0.1:${svc.port}`
  const reading = await providerReading({ env: workerEnv(base, TOKEN) }) // 没有 canRead
  assert.equal(reading.ok, false)
  assert.equal(reading.code, EXECUTOR_CODES.CAN_READ_REQUIRED, JSON.stringify(reading))
  // ★ 反向锚：它**不是**被对端拒绝的，是本进程拒绝的（对端码为空）。
  assert.equal(reading.innerCode, null,
    'canRead 缺失是本进程的接线问题，不该表现成一次对端拒绝')
  t.diagnostic(`G: ${JSON.stringify(reading)}`)
})

guarded('H. ★★ URL 配了但 worker **没给令牌** → 当场拒绝，**不发**匿名请求', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)
  const base = `http://127.0.0.1:${svc.port}`

  const before = (r.stderr.match(/^SELF-ENFORCEMENT /gm) ?? []).length
  const reading = await providerReading({ env: workerEnv(base, TOKEN), canRead })
  assert.equal(reading.ok, true)
  const noToken = await providerReading({ env: workerEnv(base), canRead }) // 没有令牌
  assert.equal(noToken.ok, false)
  assert.equal(noToken.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED, JSON.stringify(noToken))
  assert.equal(noToken.innerCode, null, '这是本进程的拒绝，不是对端的')

  // ★ 反向锚：本场景里那台进程**配了**令牌，所以"没给令牌"与"给错令牌"
  //   在对端看来都会是 401 —— 而本模块**根本不发那一次请求**。
  await new Promise((res) => setTimeout(res, 300))
  const after = (r.stderr.match(/^SELF-ENFORCEMENT /gm) ?? []).length
  assert.equal(after, before, 'worker 没给令牌时不该有任何请求到达对端')
  t.diagnostic(`H: ${JSON.stringify(noToken)}`)
})

guarded('★ 全部读数**两两不同形**（否则上面各条只是在各自重复一遍）', async (t) => {
  const full = await scenario('full')
  const fullSvc = contractReading(full.stderr)
  const liveBase = `http://127.0.0.1:${fullSvc.port}`
  const deadPort = await reserveThenReleasePort()
  // 用 `scenario(...)` 取那两台进程（而不是 `LIVE.get(...)`）：见 E 用例里同一条说明。
  const noTokenSvc = contractReading((await scenario('noToken')).stderr)
  const otherTokenSvc = contractReading((await scenario('otherToken')).stderr)

  const readings = {
    A: await providerReading({ env: workerEnv(liveBase, TOKEN), canRead }),
    B: await providerReading({ env: workerEnv(), canRead }),
    D: await providerReading({ env: workerEnv(`http://127.0.0.1:${noTokenSvc.port}`, TOKEN), canRead }),
    E: await providerReading({ env: workerEnv(`http://127.0.0.1:${otherTokenSvc.port}`, TOKEN), canRead }),
    F: await providerReading({ env: workerEnv(`http://127.0.0.1:${deadPort}`, TOKEN), canRead }),
    G: await providerReading({ env: workerEnv(liveBase, TOKEN) }),
    H: await providerReading({ env: workerEnv(liveBase), canRead }),
  }

  // 每个读数先各自**钉死**（用 exact code，不用 includes）。
  assert.equal(readings.A.ok, true)
  assert.equal(readings.B.code, EXECUTOR_CODES.HOST_PORT_REQUIRED)
  assert.equal(readings.D.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED)
  assert.equal(readings.D.innerCode, WIRE_CODES.NO_TOKEN)
  assert.equal(readings.E.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED)
  assert.equal(readings.E.innerCode, WIRE_CODES.UNAUTHORIZED)
  assert.equal(readings.F.code, EXECUTOR_CODES.RUNTIME_UNREACHABLE)
  assert.equal(readings.G.code, EXECUTOR_CODES.CAN_READ_REQUIRED)
  assert.equal(readings.H.code, EXECUTOR_CODES.RUNTIME_UNAUTHORIZED)

  // 然后断言**形状互不相同**。D 与 E 的外层码相同（都是 UNAUTHORIZED），
  // 所以形状必须把 innerCode 也算进去 —— 否则这一对会被误判成同形而放过去。
  const shape = (r) => `${r.ok ? 'ok' : r.code}/${r.innerCode ?? '-'}`
  const shapes = Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, shape(v)]))
  const values = Object.values(shapes)
  assert.equal(new Set(values).size, values.length,
    `有两条读数同形 —— 那它们就是同一个东西：${JSON.stringify(shapes)}`)

  // ★ 逐对点出那两组最容易混淆的：
  assert.notEqual(shapes.B, shapes.F, '"没配"与"配了够不着"必须不同形')
  assert.notEqual(shapes.D, shapes.E, '"那台机器没配凭证"与"你给错了"必须不同形')
  assert.notEqual(shapes.G, shapes.H, '"没给 canRead"与"没给令牌"必须不同形')
  assert.notEqual(shapes.F, shapes.G, '"够不着"与"接线缺一截"必须不同形')
  t.diagnostic(`形状：${JSON.stringify(shapes, null, 0)}`)
})

guarded('★ 端到端：跨进程两次运行之后，Runtime 进程里 `dispose` 也跑了（不泄漏子代理）', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)

  // ★ 读**增量**，不读绝对计数。
  //
  // 第一版断言的是 `START-RUN-CALLED n=2`，而 A2 已经在**同一个**进程上跑过一次，
  // 于是那条断言只有在单独跑本用例时才成立 —— 一条"跑全量时红、单独跑时绿"的
  // 断言测的是测试的执行顺序，不是产品。
  //
  //   > 一个只在别人的用例没跑过时才成立的断言，比没有断言更坏：
  //   > 它会把"顺序变了"报成"产品坏了"。
  const startedBefore = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  const disposedBefore = (r.stderr.match(/^DISPOSE-CALLED$/gm) ?? []).length

  const built = await provider({
    env: workerEnv(`http://127.0.0.1:${svc.port}`, TOKEN), canRead,
  })
  assert.equal(built.ok, true)

  // ★★ 这两次用**本用例自己的** runId/attemptId。
  //
  // 第一版复用了 A2 那份 `LEASE`，于是实测读数是一句非常准确的拒绝：
  //   「runId run-ct-1 已结算（run.completed）；重试必须创建新 Attempt/Run」
  // 也就是说**引擎侧的幂等纪律是对的**，错的是夹具 —— 它在同一个进程上
  // 拿同一个 runId 跑了两次。这条纪律本身值得钉住，见下一条用例。
  const leaseA = { ...LEASE, runId: 'run-ct-e2e-a', attemptId: 'att-ct-e2e-a', idempotencyKey: 'idem-ct-e2e-a' }
  const leaseB = { ...LEASE, runId: 'run-ct-e2e-b', attemptId: 'att-ct-e2e-b', idempotencyKey: 'idem-ct-e2e-b' }

  const first = await built.executor.execute(leaseA)
  assert.equal(first.outcome, 'completed', JSON.stringify(first))
  const second = await built.executor.execute(leaseB)
  assert.equal(second.outcome, 'completed',
    '同一个执行器应当能跑第二次（探测只做一次，但不应把状态用尽）')

  await new Promise((res) => setTimeout(res, 500))
  const startedAfter = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  const disposedAfter = (r.stderr.match(/^DISPOSE-CALLED$/gm) ?? []).length

  assert.equal(startedAfter - startedBefore, 2,
    `两次 execute 必须在对端留下恰好两条启动记录：${startedAfter - startedBefore}\n${r.stderr}`)
  assert.equal(disposedAfter - disposedBefore, 2,
    `每一次运行都必须在引擎侧被回收（dispose）——少了就是泄漏子代理：${JSON.stringify({ startedBefore, startedAfter, disposedBefore, disposedAfter })}\n${r.stderr}`)
  t.diagnostic(`端到端：两次 completed，startRun +${startedAfter - startedBefore}，dispose +${disposedAfter - disposedBefore}`)
})

guarded('★ 同一个已结算的 runId **不得**再跑一次 —— 拒绝跨进程原样带回来（幂等纪律）', async (t) => {
  const r = await scenario('full')
  const svc = contractReading(r.stderr)

  const startedBefore = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  const built = await provider({
    env: workerEnv(`http://127.0.0.1:${svc.port}`, TOKEN), canRead,
  })
  assert.equal(built.ok, true)

  const lease = { ...LEASE, runId: 'run-ct-idem', attemptId: 'att-ct-idem', idempotencyKey: 'idem-ct-idem' }
  const first = await built.executor.execute(lease)
  assert.equal(first.outcome, 'completed')

  // 第二次拿**同一个** runId：引擎侧当场拒绝（"已结算；重试必须创建新 Attempt/Run"），
  // 客户端把那次拒绝当**传输开始之前的具名拒绝**处理，executor 收成 RUN_NOT_COMPLETED。
  let error = null
  try {
    await built.executor.execute(lease)
  } catch (e) {
    error = e
  }
  assert.notEqual(error, null, '同一个 runId 跑第二次却没有被拒绝 —— 那会让"重试"变成"重复执行"')
  assert.equal(error.code, EXECUTOR_CODES.RUN_NOT_COMPLETED)
  // ★ 具名到真因那一层：对端码是 ADAPTER_THREW，而消息里说清了是"已结算"。
  assert.equal(error.cause?.innerCode, WIRE_CODES.ADAPTER_THREW, JSON.stringify(error.cause?.innerCode))
  assert.ok(String(error.cause?.message ?? '').includes('已结算'),
    `拒绝必须说清"已结算"，而不是一句笼统的失败：${error.cause?.message}`)
  // ★ 而且它**没有**变成第二次启动：一次拒绝不等于一次执行。
  await new Promise((res) => setTimeout(res, 400))
  const startedAfter = (r.stderr.match(/^START-RUN-CALLED /gm) ?? []).length
  assert.equal(startedAfter - startedBefore, 1,
    '被拒绝的那一次**不得**在对端留下第二次启动记录 —— 拒绝必须发生在引擎动手之前')
  t.diagnostic(`幂等：${error.cause?.innerCode} / ${error.code}`)
})

guarded('★ 那个 `dsh` 进程是被我们**关掉**的（不是自己崩的）', async (t) => {
  // 这一条防的是"全部用例都绿，但其实子进程早就死了，读数来自已经结束的进程"。
  const r = await scenario('full')
  const exit = await r.stop()
  assert.equal(exit.signal, null, `子进程是被信号杀掉的（${exit.signal}）——那前面的读数可能来自一个正在崩的进程`)
  assert.equal(exit.code, 0, `期望正常收尾，实际 exit=${exit.code}：\n${r.stderr}`)
  assert.match(r.stderr, /^PROBE-EXIT stdin-closed$/m, r.stderr)
  t.diagnostic(`收尾：exit=${exit.code}`)
})

guarded('★ executor 的 `post`/`get` 仍是 hub 那一侧的东西（跨进程只换了引擎，没换数据面）', async (t) => {
  // 反向锚：`createProductionExecutor` 仍然要求 post/get 是函数。
  // 跨进程那条路**只**解决"引擎在哪里"，不解决"上下文从哪里来"——
  // 后者是 hub 的事，把它顺带换掉会让两个故障源在读数上混起来。
  const refused = await createProductionExecutor({ host: {}, selfCheck: () => ({ autoExecutionForbidden: false }), canRead })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, EXECUTOR_CODES.BAD_WIRING)
  assert.equal(RUNTIME_CONTRACT_VERSION, 1)
})

// ---------------------------------------------------------------- 小工具

/**
 * 取一个**当下没有人听**的端口，然后立刻放掉。
 *
 * 为什么不用一个固定数字：固定端口会与并行的用例或本机真服务撞，
 * 而"撞上了"与"进程不在"在读数上完全不同（前者会连上某个别的服务）。
 */
async function reserveThenReleasePort() {
  const { createServer } = await import('node:http')
  const server = createServer(() => undefined)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
