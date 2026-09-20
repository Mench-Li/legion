// runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs
// ============================================================================
// PRT-253（续）：`runtime-host-row.mjs` 在**真 DSH 进程**里的读数。
//
// ## 这套件要回答的唯一问题
//
//   > 「`bindDshRuntime()` 有一个生产调用方」这句话，
//   > 在一个**真的 DSH 进程**里读出来是什么？
//
// 判据不是"这一行被加载了"，也不是"文件里有这个 import"，而是 **worker 自己的那个
// 读数**：`orchestrator/worker/executor-binding.mjs` 的 `productionExecutorProvider()`
// 在绑定生效时**不再**返回 `EXECUTOR_HOST_PORT_REQUIRED`。那个模块住在 worker 侧，
// 与 DSH 行之间没有任何"测试专用"的通道——它就是生产路径上那一个。
//
// ## 三个场景（正读 + 两个反向对照）
//
//   A. 本行挂上、缝上有工厂 → 真 DSH 进程 exit 0；`dshRuntimeBound()` **true**，
//      `productionExecutorProvider()` 的 code **不是** `HOST_PORT_REQUIRED`。
//   B. 与本行**只差一行**（不挂本行）→ `dshRuntimeBound()` **false**，
//      code **就是** `HOST_PORT_REQUIRED`。两个读数必须**不同**。
//   C. 本行挂上、缝上**没有**工厂（= 产品交付了行、没人注册端口的那种部署）
//      → 真 DSH 进程 exit 1，具名码是 `RUNTIME_HOST_ROW_NO_INPUTS_FACTORY`。
//
// A 与 B 的差别只有一行补丁；A 与 C 的差别只有"工厂在不在"。所以每条断言都指向
// 一个**单一变量**，而不是一堆一起动的东西。
//
// ## ★ 诚实边界（本套件**没有**证明的东西，见 PRT-253 文档 §6）
//
//   · **宿主端口是替身**。`{startRun, probeRuntime}` 由本套件造，因为全仓库没有
//     一个真的 `probeRuntime`（版本 + 四项必需能力没有生产来源）。所以这套件证明的是
//     「**调用方与绑定链在真 DSH 进程里是通的**」，**不是**「真 DSH 引擎被验过兼容」。
//   · **沙箱端口是替身**（`ctx.sandbox.confine` 在 `bundles: []` 的一次性 profile 里
//     没有生产来源）。所以「沙箱真的在管制」不是本套件的读数。
//   · **`canRead` 是替身**（`() => true`）。所以"权限判定接对了"不是本套件的读数；
//     它只证明**这一样输入被原样交到了绑定里**。
//   · 组合补丁层用的是**磁盘上那份真 `legion-host.patch.yml`**（一个字节都不改），
//     所以"组合树观察"这一条是真读数，不是替身给的。
//
// ## 安全（与 `root-row-dsh-process.test.mjs` 同一套，逐条都成立）
//
//   一次性 `DSH_HOME`（建在 `os.tmpdir()` 下的 scratch 里，**spawn 之前断言**）、
//   `bundles: []` + `patchReload: 'startup'` 的 profile、从环境里**删掉**
//   `DSH_SNAPSHOT`、`spawnSync` 带超时、`after()` 整棵删掉。
//   **绝不**读写任何真实 profile（操作者那台机器上的活 harness 是
//   `patchReload: 'live'`，碰一下就会改到正在跑的进程，包括本会话）。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 拒绝码与状态量取自**产品模块**，不在用例里另抄一份字符串：抄一份的话，
// 产品改了码而用例还绿着，"断言的是那个码"就变成了一句注释。
import { RUNTIME_HOST_ROW_CODES } from './runtime-host-row.mjs'
import { BOOTSTRAP_CODES } from '../bootstrap.mjs'
import { EXECUTOR_CODES } from '../../../orchestrator/worker/executor.mjs'
import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import { SUPPORTED_RUNTIME } from '../../adapters/dsh/probe.mjs'

import { resolveDshCheckout } from '../../../scripts/lib/dsh-checkout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSITION = resolve(HERE, '..')
const ROOT_DIR = resolve(HERE, '..', '..', '..')

const RUNTIME_HOST_ROW_ABS = join(HERE, 'runtime-host-row.mjs')
const EXECUTOR_BINDING_ABS = join(ROOT_DIR, 'orchestrator', 'worker', 'executor-binding.mjs')
const EXECUTOR_ABS = join(ROOT_DIR, 'orchestrator', 'worker', 'executor.mjs')
const CONTRACTS_ABS = join(ROOT_DIR, 'runtime', 'contracts', 'adapter.mjs')
const PROBE_ABS = join(ROOT_DIR, 'runtime', 'adapters', 'dsh', 'probe.mjs')

const fileUrl = (p) => pathToFileURL(p).href

// ─────────────────────────────────────────── 可跑性判定（沿用既有口径）

// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`），不在这里手写
//   `process.env.DSH_CHECKOUT ?? null`。手写的后果实测过：变量没导出时
//   本套件整组跳过，而 CI 报的是 `PASS`——一个「跑了 0 条」的绿。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const UNAVAILABLE = DSH === null
  ? DSH_FOUND.reason
  : !existsSync(CLI)
    ? `DSH 检出里找不到 CLI（${CLI}）——未构建？`
    : false
const SKIP = UNAVAILABLE === false ? false : UNAVAILABLE

const guarded = (name, fn) => test(name, { timeout: 180_000 }, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

// ─────────────────────────────────────────── 一次性 DSH_HOME

const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-runtime-host-dsh-'))

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

const LEGION_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt253rt-actor',
  LEGION_SCOPE: 'prt253rt-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

const PROFILE_NAME = 'prt253rt'

/**
 * 建一个一次性 home。`bundles` 默认是**空**（本套件其余场景的口径：树里只有我们
 * 通过 `--patch` 插进去的行）。
 *
 * ★ 传 `bundles: ['@deepseek-ai/dsh-base']` 就得到**生产形状**：那一层真的声明了
 * `permission` 行（`dsh-base/cordis.patch.yml:229`），于是 Legion 补丁层的
 * `patch-over permission` 有靶子可打。DSH 自己会把安装处的依赖闭包软链进
 * `$DSH_HOME/profiles/node_modules`（`healProfilesModuleFallback`），所以一个
 * **tmpdir 里的** 一次性 home 也能起真 bundle——**不需要**碰操作者的 `~/.dsh`。
 */
function makeHome(tag, bundles = []) {
  const home = mkdtempSync(join(SCRATCH, `home-${tag}-`))
  assert.ok(resolve(home).startsWith(TMP_ROOT), `一次性 home 逃出了 tmpdir：${home}`)
  assert.ok(resolve(home).startsWith(SCRATCH), `一次性 home 逃出了本次运行的 scratch：${home}`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles, patchReload: 'startup' } },
  }, null, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 空用户层\n[]\n')
  return home
}

// ─────────────────────────────────────────── 脚手架模块（全部是**替身**，见文件头）

/**
 * 服务脚手架：`tools` / `approval` / `sandbox`。
 *
 * 前两个是 PRT-214 那两行 inject 的宿主服务（沿用 `root-row-dsh-process.test.mjs`
 * 的 `SERVICES_SRC`，读数已在那里验过）；`sandbox` 是本行要交给启动自检的第三样输入。
 *
 * ⚠️ **沙箱端口是替身**：它报告 `full` 级管制并**真的**换了 argv。这是"自检的这一路
 * 能被走通"的必要条件，不是"本机沙箱真的在管制"的读数。
 */
const SERVICES_SRC = `// 桩宿主：只发布被测几行 inject 的服务。不是 ToolRuntime。
const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'prt253rt-services',
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
          backend: 'prt253rt-stub-backend',
          argv: ['prt253rt-stub-sandbox', '--', ...argv],
          denialSignatures: ['operation not permitted'],
        }
      },
    })
    // ★ 真 DSH 进程**有** subagents（startRun 的唯一真来源），而本假件此前缺它 ⇒
    //   runtime-host-registrar-row 按设计拒了（RUNTIME_HOST_REGISTRAR_NO_SUBAGENTS_PORT），
    //   于是自检把"假件不完整"读成了"行已挂载但未激活（等待依赖服务）"。
    //   补它是为了让**假件与真 DSH 同形**——不是为了让断言变绿。
    //
    //   ⚠️ 能力表里只报 outputSchema: true：另外三项必需能力在真产品里也是 false
    //   （见 runtime-host-registrar-row.mjs 文件头），本假件不替它们做主。
    //
    //   ⚠️⚠️ 本段整体在一个模板字面量里：**不许出现反引号**（反引号会提前结束它）。
    const PROVIDER_NAME = 'prt253rt-stub-provider'
    const HANDLE = { dispose() {} }
    ctx.provide('subagents', {
      list: () => [PROVIDER_NAME],
      getProvider: (n) => (n === PROVIDER_NAME
        ? {
          name: PROVIDER_NAME,
          capabilities: { outputSchema: true },
          async start() { return HANDLE },
        }
        : undefined),
      async start() { return HANDLE },
    })
    note('SERVICES-PROVIDED tools,approval,sandbox,subagents')
  },
}
`

const SERVICES_PATCH_SRC = `- insert:
    - id: "prt253rt-services"
      name: "./prt253rt-services.mjs"
`

/**
 * `permission` 行的**替身**。
 *
 * ⚠️ 这一行在真实部署里**不由 Legion 提供**：它属于 DSH bundle，补丁层只是按 id
 * 把它的 `config.presets` 整个换掉（`legion-host.patch.yml` 里那个
 * `{id: "permission", config: {...}}`）。
 *
 * 而本套件用的是一个 `bundles: []` 的**一次性** profile（这是安全规则要求的：
 * 绝不碰真实 profile），里面**没有任何 bundle**，于是那一行不存在 ——
 * 实测读数就是自检报
 * `legion-enforcement-permission-presets: 补丁层行未出现在组合树中`。
 *
 *   > `patch-over` 打靶打空时不会报错，它 warn-and-skip ——
 *   > 于是"preset 表已被替换"与"从来没替换过"在文件层面长得一样。
 *
 * 所以这里**插一行同 id 的替身**，让它成为真 `patch-over` 的靶子：
 * 真正的覆盖动作仍然由**磁盘上那份真补丁层**完成，本替身不含任何权限语义。
 * 它不是"补丁层的一部分"，也**不**证明 Legion 的 preset 表在真实部署里生效过
 * ——那需要一次带 bundle 的 profile 启动（本批没有做，见文档 §6）。
 */
const PERMISSION_SRC = `// 替身：只为让真补丁层的 patch-over 有靶子。不提供任何服务、不挂任何 listener。
export default {
  name: 'prt253rt-permission-standin',
  inject: [],
  apply() {
    process.stderr.write('PERMISSION-STANDIN-APPLY-RAN\\n')
  },
}
`

const PERMISSION_PATCH_SRC = `- insert:
    - id: "permission"
      name: "./prt253rt-permission.mjs"
      config:
        presets:
          workspace-write:
            sandbox: "workspace-write"
            approval: "ask"
          danger-full-access:
            sandbox: "danger-full-access"
            approval: "never"
`

// 运行期两行（`PATCH_LAYER_ROWS` 里 `module: null` 的那两行）按**绝对路径**挂。
// 与 `root-row-dsh-process.test.mjs` 用的是同一对产品模块。
const RUNTIME_ROWS_PATCH_SRC = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(HERE, 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(HERE, 'approval-answerer-row.mjs'))}
`

/**
 * ★ 生产调用方的**注册方**：形状与 `team-hub/approval-registrar-row.mjs` 完全一样——
 * 在**模块求值期**注册，然后默认导出**真的那个**插件对象（`===`，没有替换）。
 *
 * 为什么必须是这个形状（而不是另起一行注册）：Loader 用
 * `Promise.allSettled(config.map(create))` **并发**创建所有补丁行，
 * 所以"注册行先求值、本行后 apply"只在两个模块都不挂起时碰巧成立。
 * 把注册放进本行自己的模块图里，ESM 保证被 import 的模块先求值完。
 * 那条 2×2 矩阵的实测读数在 PRT-214 文档 §10。
 *
 * ⚠️ 端口是**替身**：`probeRuntime` 的版本与能力由 `REQUIRED_CAPABILITIES` 推导，
 * 不是任何一台真引擎报出来的。
 */
const HOST_ROW_WRAPPER_SRC = `import { setDshRuntimeInputsFactory } from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}
import realRuntimeHostRow from ${JSON.stringify(fileUrl(RUNTIME_HOST_ROW_ABS))}
import { REQUIRED_CAPABILITIES } from ${JSON.stringify(fileUrl(CONTRACTS_ABS))}
import { SUPPORTED_RUNTIME } from ${JSON.stringify(fileUrl(PROBE_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
note('RUNTIME-HOST-FACTORY-INSTALLED')

// 替身宿主端口（见文件头的诚实边界）。能力表**按产品的必需清单推导**，
// 不手写一份：手写的那份会与 REQUIRED_CAPABILITIES 漂移，而漂移的那一天
// 表现为"自检说兼容"，而不是"少验了一项"。
const host = {
  async probeRuntime() {
    return {
      version: SUPPORTED_RUNTIME.supportedMajor + '.1.5',
      capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((c) => [c, true])),
    }
  },
  async startRun() {
    return { result: Promise.resolve({ stopReason: 'completed' }), dispose: async () => {} }
  },
}

const runtimeHostInputs = { runtimeHost: host, canRead: () => true }
setDshRuntimeInputsFactory(() => runtimeHostInputs)

export default realRuntimeHostRow
`

const HOST_ROW_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: "./prt253rt-hostrow.mjs"
`

// 反向对照 C 专用：**产品自己的**那一行模块直接当补丁行的模块挂，也就是
// "行交付了、没有人注册端口工厂"的那种部署。
const HOST_ROW_ONLY_PATCH_SRC = `- insert:
    - id: "legion-runtime-host"
      name: ${JSON.stringify(RUNTIME_HOST_ROW_ABS)}
`

// 反向对照 B 用：**没有**本行，其余一字不变。
const NO_HOST_ROW_PATCH_SRC = `- insert:
    - id: "prt253rt-placeholder"
      name: "./prt253rt-services.mjs"
      disabled: true
`

/**
 * 探针：本行 settle 之后，从**worker 侧那个模块**读绑定到底生效没有。
 *
 * 它 import 的是 `orchestrator/worker/executor-binding.mjs` **本身**——不是一份副本、
 * 不是一个"测试专用"的接口。所以这两个读数就是生产路径上那两个。
 */
const PROBE_SRC = `import { productionExecutorProvider, dshRuntimeBound } from ${JSON.stringify(fileUrl(EXECUTOR_BINDING_ABS))}
import { EXECUTOR_CODES } from ${JSON.stringify(fileUrl(EXECUTOR_ABS))}

const note = (line) => process.stderr.write(line + '\\n')
const HUB_BODY = {
  status: 200,
  body: {
    ok: true,
    verification: { ok: true },
    snapshot: { finalText: 'prt253rt-frozen', associations: {} },
  },
}
const post = async () => HUB_BODY
const get = async () => HUB_BODY

export default {
  name: 'prt253rt-probe',
  inject: [],
  apply(ctx) {
    setTimeout(async () => {
      // ① 本行发布的结论（进程内自报）。
      //    ctx.get(name, strict) 的第二个参数是 **strict**，不是 fallback——
      //    服务不在时拿到的是 undefined。写成 === null 会把"不在"读成"在"
      //    （这正是第一版探针的错误，被 B 场景咬出来的）。
      const svc = ctx.get('legionRuntimeHostBinding', false)
      note('SVC ' + (svc === undefined ? 'absent' : 'present'))
      // ★ 服务在时**逐字段**读出来（本批把自检不兼容从 throw 改成了 provide，
      //   于是拒绝从"进程退出时的 stderr"搬到了这个服务值上）。
      //   message 一律 JSON.stringify：它里面有多行，直接写会把 reading()
      //   的单行正则在第一行就截断——那样读到的就只是"第一行"，而不是"整条理由"。
      const at = (f) => (svc === undefined ? 'absent' : String(svc[f]))
      note('SVCCODE ' + at('code'))
      note('SVCINNER ' + at('innerCode'))
      note('SVCSTATE ' + at('state'))
      note('SVCFORBID ' + at('autoExecutionForbidden'))
      note('SVCMESSAGE ' + JSON.stringify(svc === undefined ? null : svc.message))
      note('SVCCHECKS ' + JSON.stringify(svc === undefined ? null : svc.checks))
      // ② 组合根服务也在场（它由真补丁层的 root 行发布）。
      note('ROOTSVC ' + (ctx.get('legionEnforcementRoot', false) === undefined ? 'absent' : 'present'))
      // ③ **worker 自己的**读数：绑定生不生效，由它说了算。
      note('BOUND ' + dshRuntimeBound())
      try {
        const r = await productionExecutorProvider({ post, get })
        note('PROVIDER ok=' + r.ok + ' code=' + (r.code === undefined ? 'none' : r.code))
      } catch (error) {
        note('PROVIDER-THREW ' + String(error && error.message ? error.message : error))
      }
      note('PROBE-EXIT-0')
      process.exit(0)
    }, 3500)
  },
}
`

const PROBE_PATCH_SRC = `- insert:
    - id: "prt253rt-probe"
      name: "./prt253rt-probe.mjs"
`

// ★★★ 对账探针：在**真 DSH 进程**里问一句此前从未问过的话——
//   `reconcilePatchLayer(observeComposition(ctx)).effective` 到底是什么？
//
// PRT-214 的残留写着：「本批**没有**新增真 DSH 场景去断言"自检判生效"（量的是**反向**）」。
// 既有真进程场景量的都是**拒绝**（配置空 / 注册方缺席 / entry 未激活）。
// 这一支把**正向**那个读数补上，而且用**替身行的假 preset 表**当靶子：
// 替身声明的是 DSH 默认名（workspace-write / danger-full-access），
// 真补丁层的 `patch-over` 如果没打中，对账读到的就是那组假名字 ⇒ PRESETS_NOT_OVERRIDDEN。
// 于是"整层判生效"这句话是**有因果的**，不是一个碰巧为空的读数。
const RECONCILE_PROBE_SRC = `import { observeComposition } from ${JSON.stringify(fileUrl(join(HERE, 'runtime-host-row.mjs')))}
import { reconcilePatchLayer } from ${JSON.stringify(fileUrl(join(COMPOSITION, 'patch-layer.mjs')))}
import { approvalPortFactory } from ${JSON.stringify(fileUrl(join(HERE, 'root-row.mjs')))}
import { dshRuntimeBound } from ${JSON.stringify(fileUrl(EXECUTOR_BINDING_ABS))}
const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'prt253rt-reconcile-probe',
  inject: [],
  apply(ctx) {
    setTimeout(() => {
      try {
        const obs = observeComposition(ctx)
        note('RECONCILE-ROWS ' + JSON.stringify(obs.rows.map((r) => [r.id, r.activated, r.present])))
        note('RECONCILE-PRESETS ' + JSON.stringify(obs.permissionPresets))
        const r = reconcilePatchLayer(obs)
        note('RECONCILE-EFFECTIVE ' + r.effective)
        note('RECONCILE-REASONS ' + JSON.stringify(r.reasons))
        for (const f of r.findings) note('RECONCILE-FINDING ' + JSON.stringify([f.row, f.code]))
        // ★ 生产形状那两条（H/I）要读的三样：服务、注册缝、以及**生效的 config 内容**
        note('ROOT-SERVICE ' + (ctx.get('legionEnforcementRoot', false) === undefined ? 'absent' : 'present'))
        // ★★ 绑定服务逐字段读出来（J 要读的就是它）。
        //    J 只挂本探针——prt253rt-probe 与它在同一个进程里**各自**
        //    process.exit(0)，谁先到谁赢：两个都挂上会得到一个**竞态**，
        //    而"读数随机缺失"与"读数不存在"在断言里是同一个东西。
        //    所以这里自己读一遍，不靠另一个脚手架。
        const svc = ctx.get('legionRuntimeHostBinding', false)
        const at = (f) => (svc === undefined ? 'absent' : String(svc[f]))
        note('SVCCODE ' + at('code'))
        note('SVCINNER ' + at('innerCode'))
        note('SVCSTATE ' + at('state'))
        note('SVCFORBID ' + at('autoExecutionForbidden'))
        note('SVCMESSAGE ' + JSON.stringify(svc === undefined ? null : svc.message))
        note('SVCCHECKS ' + JSON.stringify(svc === undefined ? null : svc.checks))
        // ★ worker 自己的读数。J 靠它区分"端口真的注册了"与"自检拒绝了"——
        //   少了这一条，reading(...) 返回 null，而 null 既不是 true 也不是 false，
        //   于是那个分支判据会**静默走错路**（这一次它走到了 else 里，然后
        //   拿 null 去比 'false' 才炸出来；换个写法就会变成一个假绿）。
        note('BOUND ' + dshRuntimeBound())
        note('PORT-FACTORY ' + (approvalPortFactory() === null ? 'none' : 'registered'))
        try {
          for (const e of ctx.loader.entries()) {
            if ((e.options.id ?? '') === 'permission') note('PERM-CONFIG ' + JSON.stringify(e.options.config ?? null))
          }
        } catch (error) { note('PERM-CONFIG-THREW ' + String(error && error.message ? error.message : error)) }
      } catch (error) {
        note('RECONCILE-THREW ' + String(error && error.message ? error.message : error))
      }
      note('RECONCILE-PROBE-DONE')
      process.exit(0)
    }, 3000)
  },
}
`

const RECONCILE_PROBE_PATCH_SRC = `- insert:
    - id: "prt253rt-reconcile-probe"
      name: "./prt253rt-reconcile.mjs"
`

const REAL_PATCH = join(COMPOSITION, 'legion-host.patch.yml')

const SCRATCH_FILES = {
  services: ['prt253rt-services.mjs', SERVICES_SRC],
  servicesPatch: ['prt253rt-services.patch.yml', SERVICES_PATCH_SRC],
  permission: ['prt253rt-permission.mjs', PERMISSION_SRC],
  permissionPatch: ['prt253rt-permission.patch.yml', PERMISSION_PATCH_SRC],
  runtimeRowsPatch: ['prt253rt-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH_SRC],
  hostRow: ['prt253rt-hostrow.mjs', HOST_ROW_WRAPPER_SRC],
  hostRowPatch: ['prt253rt-hostrow.patch.yml', HOST_ROW_PATCH_SRC],
  hostRowOnlyPatch: ['prt253rt-hostrow-only.patch.yml', HOST_ROW_ONLY_PATCH_SRC],
  noHostRowPatch: ['prt253rt-no-hostrow.patch.yml', NO_HOST_ROW_PATCH_SRC],
  probe: ['prt253rt-probe.mjs', PROBE_SRC],
  probePatch: ['prt253rt-probe.patch.yml', PROBE_PATCH_SRC],
  reconcileProbe: ['prt253rt-reconcile.mjs', RECONCILE_PROBE_SRC],
  reconcileProbePatch: ['prt253rt-reconcile.patch.yml', RECONCILE_PROBE_PATCH_SRC],
}

const SCRATCH_PATH = {}
for (const [key, [fileName, source]] of Object.entries(SCRATCH_FILES)) {
  SCRATCH_PATH[key] = join(SCRATCH, fileName)
  writeFileSync(SCRATCH_PATH[key], source)
}

// 前提：真补丁层在磁盘上，且它指的那两个模块也在。缺了就让用例**响亮地**红，
// 而不是让三条读数一起退化成"组合树没生效"。
assert.ok(existsSync(REAL_PATCH), `真补丁层不在：${REAL_PATCH}`)
for (const p of [RUNTIME_HOST_ROW_ABS, EXECUTOR_BINDING_ABS, join(HERE, 'pre-execute-row.mjs'), join(HERE, 'approval-answerer-row.mjs')]) {
  assert.ok(existsSync(p), `本套件依赖的模块不在：${p}`)
}

/**
 * 跑一次真 `dsh`。每次一个新的**一次性** home。
 * @param {{tag: string, patches: string[]}} scenario
 */
function runDsh(scenario) {
  const home = makeHome(scenario.tag, scenario.bundles ?? [])
  const args = ['--profile', PROFILE_NAME]
  for (const patch of scenario.patches) args.push('--patch', patch)

  const env = { ...process.env, DSH_HOME: home, ...LEGION_ENV }
  if (scenario.env !== undefined) for (const [k, v] of Object.entries(scenario.env)) env[k] = v
  delete env.DSH_SNAPSHOT

  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: SCRATCH,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 150_000,
  })

  return {
    home,
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error === undefined ? null : String(result.error.message ?? result.error),
  }
}

/** 从 stderr 里读一个 `KEY value` 读数；读不到返回 `null`（不猜一个默认值）。 */
function reading(stderr, key) {
  const m = new RegExp(`^${key} (.+)$`, 'm').exec(stderr)
  return m === null ? null : m[1].trim()
}

/**
 * 三个场景的读数**收集到这里**，最后一条用例把它们两两对照。
 *
 * 各跑各的只会得到三条"看起来都对"的读数；"A 与 B 不同"这件事必须被**读**出来，
 * 而不是靠三段分开的断言各自成立来推断。
 */
const READINGS = { a: null, b: null, c: null }

const BASE_PATCHES = [
  SCRATCH_PATH.servicesPatch,
  // ★ 顺序是**刻意的**：`permission` 替身必须在真补丁层**之前**，那一层的
  //   `patch-over` 才打得到靶子。反过来（真补丁层先、替身后）覆盖就打空了，
  //   而那是 warn-and-skip——不会报错，只会让自检在别处报"行没出现"。
  SCRATCH_PATH.permissionPatch,
  REAL_PATCH,
  SCRATCH_PATH.runtimeRowsPatch,
]

describe('PRT-253：`bindDshRuntime` 的生产调用方在**真 DSH 进程**里的读数', () => {
  guarded('A. ★★★ 本行挂上：worker 自己的 `productionExecutorProvider()` **不再**报缺端口', (t) => {
    const r = runDsh({
      tag: 'a',
      patches: [...BASE_PATCHES, SCRATCH_PATH.hostRowPatch, SCRATCH_PATH.probePatch],
    })

    assert.equal(r.spawnError, null)
    // 真补丁层（含 root 行）装配成功 + 本行绑定成功 ⇒ 进程正常收尾。
    assert.equal(r.code, 0, `期望装配成功：\n${r.stderr}`)
    assert.match(r.stderr, /^RUNTIME-HOST-FACTORY-INSTALLED$/m, r.stderr)
    assert.match(r.stderr, /^SERVICES-PROVIDED tools,approval,sandbox$/m, r.stderr)
    // 组合树对账是**真的**全过了：那条 patch-over 打到了靶子（否则自检会拒）。
    assert.match(r.stderr, /^PERMISSION-STANDIN-APPLY-RAN$/m, r.stderr)
    // 本行没有被 DSH 判为"没激活"。
    assert.equal(r.stderr.includes('failed to apply loader entry legion-runtime-host'), false, r.stderr)

    // ① 结论发布出来了（进程内自报）。
    assert.equal(reading(r.stderr, 'SVC'), 'present', r.stderr)
    // ①b 组合根服务也在场（真补丁层的 root 行发的）——本行的 `inject` 依赖它。
    assert.equal(reading(r.stderr, 'ROOTSVC'), 'present', r.stderr)
    // ③ ★ 真正的判据：**worker 侧那一个模块**说绑上了。
    assert.equal(reading(r.stderr, 'BOUND'), 'true', `绑定没生效：\n${r.stderr}`)
    const provider = reading(r.stderr, 'PROVIDER')
    assert.notEqual(provider, null, `探针没给出 PROVIDER 读数：\n${r.stderr}`)
    // ★ 这一条是本套件的全部意义：worker 通过**生产路径**拿到了一个可用的引擎，
    //   而不是一条"没有宿主端口"的拒绝。
    assert.equal(provider, 'ok=true code=none',
      `绑定生效后 worker 必须能从生产路径造出引擎：${provider}`)
    assert.equal(provider.includes(EXECUTOR_CODES.HOST_PORT_REQUIRED), false,
      `绑定生效了，worker 却仍然报缺宿主端口——那说明绑定没接到 worker 那条路径上：${provider}`)
    READINGS.a = { bound: reading(r.stderr, 'BOUND'), provider }
    t.diagnostic(`A: ${provider}`)
  })

  guarded('B. ★★★ 反向对照：**不挂本行**（其余一字不变）→ 两个读数都反转', (t) => {
    const r = runDsh({
      tag: 'b',
      patches: [...BASE_PATCHES, SCRATCH_PATH.noHostRowPatch, SCRATCH_PATH.probePatch],
    })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望装配照旧成功（只是没人绑定）：\n${r.stderr}`)
    assert.equal(r.stderr.includes('RUNTIME-HOST-FACTORY-INSTALLED'), false,
      'B 场景里出现了本行的标记——那 A/B 的差别就不是"挂没挂本行"了')
    // ★ 两个读数都必须是**反面**，而且与 A 不同形。
    assert.equal(reading(r.stderr, 'SVC'), 'absent', r.stderr)
    assert.equal(reading(r.stderr, 'BOUND'), 'false', r.stderr)
    const provider = reading(r.stderr, 'PROVIDER')
    assert.match(provider, new RegExp(`code=${EXECUTOR_CODES.HOST_PORT_REQUIRED}`),
      `没有本行时 worker 必须报缺宿主端口：${provider}`)
    READINGS.b = { bound: reading(r.stderr, 'BOUND'), provider }
    t.diagnostic(`B: ${provider}`)
  })

  guarded('C. ★★ 本行挂上、但**没有人注册端口** → 真进程里具名拒绝（进程照常起来，端口没绑上）', (t) => {
    const r = runDsh({
      tag: 'c',
      patches: [...BASE_PATCHES, SCRATCH_PATH.hostRowOnlyPatch, SCRATCH_PATH.probePatch],
    })

    assert.equal(r.spawnError, null)
    // ⚠️ 本行拒绝**不会**让进程非零退出：DSH 的启动严格性是**消费方自有**的
    //    （只有全局 required 名单里的 entry 才会拆卸应用；Legion 的补丁行不在其中）。
    //    逐条证据与那份 DSH 架构决定记录见
    //    `root-row-dsh-process.test.mjs` 文件头「DSH 的启动严格性是消费方自有的」一节。
    assert.equal(r.code, 0, `DSH 对非 required entry 只报 warning，进程应照常起来：\n${r.stderr}`)
    assert.match(r.stderr, /warning: \d+ entr(?:y|ies) did not activate/, r.stderr)
    // ★ 断言具名码本身，不写"它抛了"。
    assert.match(r.stderr, new RegExp(RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY), r.stderr)
    // 反向锚：这一行确实被真加载器当成**条目**在报。
    //
    // ⚠️ 这里原来写的是 `failed to apply loader entry legion-runtime-host`——那是**旧版 DSH**
    //    的措辞，当前 app-boot 已不再产生它。当前形状是
    //    `<entry id> (<模块 file:// URL>): <诊断>`。
    assert.match(r.stderr, /legion-runtime-host \(file:\/\/[^)]+\): RuntimeHostRowError: /, r.stderr)
    // 两种"装不上"不能同形：这一条**不是**组合树或自检的问题。
    assert.equal(r.stderr.includes('BOOTSTRAP_SELF_CHECK_INCOMPATIBLE'), false,
      `缺工厂却报成自检不过——那这条对照读的是别的东西：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.NO_COMPOSITION), false, r.stderr)
    // ★★★ 与下面 G 同一条纪律：**「读不到」与「读到 false」是两件事**——
    //     旧写法断言 `null`（"拒绝的场景里不该有 BOUND 读数"），而探针**总是**会打这一行，
    //     于是它既没有读出"端口没被注册"，在探针根本没跑时也照样绿。
    //     这里读的是**强制面本身**。
    assert.equal(reading(r.stderr, 'BOUND'), 'false',
      `被拒绝的场景里端口却被注册了：\n${r.stderr}`)
    READINGS.c = { code: RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY }
    t.diagnostic('C: 具名拒绝 ' + RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY)
  })

  guarded('D. ★★ 三个读数**两两不同形**（否则前面三条只是在各自重复一遍）', (t) => {
    // 这条是形状纪律的可执行版本。A/B/C 各自成立，**推不出**它们是三个不同的读数——
    // 一个把任何输入都读成同一个值的探针，能让前面三条同时"通过"。
    assert.notEqual(READINGS.a, null, 'A 没有留下读数——顺序依赖被破坏了，这条断言不算跑过')
    assert.notEqual(READINGS.b, null, 'B 没有留下读数')
    assert.notEqual(READINGS.c, null, 'C 没有留下读数')

    assert.notEqual(READINGS.a.bound, READINGS.b.bound,
      `A/B 的绑定读数相同（${READINGS.a.bound}）——那"挂没挂本行"就没被读出来`)
    assert.notEqual(READINGS.a.provider, READINGS.b.provider,
      `A/B 的 provider 读数相同（${READINGS.a.provider}）——那"绑定生不生效"就没被读出来`)
    // A 是"拿到了引擎"，B 是"缺端口"，C 是"连端口工厂都没有"：三种结局，三个读数。
    assert.equal(READINGS.a.provider, 'ok=true code=none')
    assert.match(READINGS.b.provider, new RegExp(EXECUTOR_CODES.HOST_PORT_REQUIRED))
    assert.notEqual(READINGS.a.provider, READINGS.c.code)
    t.diagnostic(`A=${READINGS.a.provider} / B=${READINGS.b.provider} / C=${READINGS.c.code}`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // ★★★ E/F：把「自检判**生效**」这个**正向**读数第一次量出来（PRT-214 残留三）
  //
  // 残留原文：「本批**没有**新增真 DSH 场景去断言"自检判生效"（量的是反向）」。
  // 反向是指：既有场景量的都是自检**拒绝**（配置空 / 注册方缺席 / entry 未激活）。
  // 一个只会红的火警，与一个坏掉的火警，在"它有没有报过警"这件事上分不开。
  // ───────────────────────────────────────────────────────────────────────────

  guarded('E. ★★★ 真补丁层 + 靶子替身 → 自检**判生效**（`effective=true`、`reasons=[]`）', (t) => {
    // 与 A 用的是同一份 BASE_PATCHES：真 `legion-host.patch.yml`、真注册方、
    // 真运行期两行由组合根在进程内挂载。加一个对账探针，把**判决**读出来。
    const r = runDsh({ tag: 'e', patches: [...BASE_PATCHES, SCRATCH_PATH.hostRowPatch, SCRATCH_PATH.reconcileProbePatch] })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望装配成功：\n${r.stderr}`)
    assert.match(r.stderr, /^RECONCILE-PROBE-DONE$/m, `对账探针没跑完：\n${r.stderr}`)
    const rec = reconcileReading(r.stderr)
    assert.notEqual(rec, null, `读不到对账读数（探针没跑到那一步）：\n${r.stderr}`)

    // ① ★ 本批的正面读数本身。
    assert.equal(rec.effective, true, `真进程里自检判了未生效：${JSON.stringify(rec.reasons)}`)
    assert.deepEqual(rec.reasons, [], '判生效了却还带着理由——判决与理由不一致')
    // ② 每一行都要有具名结论，且**全部**是 OK。少一行就等于有一条判决没被读出来。
    assert.ok(rec.findings.length > 0, '一条逐行结论都没有——那"判生效"是空口说的')
    for (const [row, code] of rec.findings) {
      assert.equal(code, 'OK', `${row} 在真进程里的结论是 ${code}，不是 OK`)
    }
    // ③ 运行期两行必须走**进程内挂载**那条证据路，而不是静态树那条。
    //    没有这一条，"生效"可能只是"这几行碰巧是 loader 条目"。
    assert.match(r.stderr, /^RECONCILE-FINDING \["legion-enforcement-pre-execute","OK"\]$/m, r.stderr)
    assert.match(r.stderr, /^RECONCILE-FINDING \["legion-enforcement-approval-answerer","OK"\]$/m, r.stderr)

    // ④ ★★ 非空洞：靶子替身声明的是 **DSH 默认** preset 名（见 PERMISSION_PATCH_SRC），
    //    真补丁层的 patch-over 只有**真的打中**了，生效表里才会是 Legion 的名字。
    assert.deepEqual(rec.presets, ['legion-attended', 'legion-unattended'],
      `生效的 preset 表不是 Legion 那组——真 patch-over 没打中靶子：${JSON.stringify(rec.presets)}`)
    assert.equal((rec.presets ?? []).includes('danger-full-access'), false,
      '替身自己声明的默认名还在生效表里 —— 那说明这一跳读的是替身，不是覆盖结果')
    t.diagnostic(`E: effective=true，逐行结论 ${rec.findings.length} 条全 OK，presets=${JSON.stringify(rec.presets)}`)
  })

  guarded('F. ★★★ 反向对照：**靶子不在树里** → 未生效，且理由是"缺席"不是"在等依赖服务"', (t) => {
    // 与 E 的唯一区别：**不挂**靶子替身。真补丁层里的 `patch-over permission`
    // 于是匹配不到任何东西——DSH 对它是 warn-and-skip：不报错，只是什么也不做。
    //
    // ★ 这里**故意不挂** `runtime-host-row`：挂了它，本行会因为自检不过而**拒绝装配**，
    //   整棵树加载失败、探针没机会跑——那样读到的就只有"进程失败了"，
    //   而这一条要读的是**理由的措辞**。拒绝这件事由 G 单独读。
    //   （把两件事塞进一条用例，就会得到"两个都对才绿"的读数：红的时候说不清是哪个。）
    const r = runDsh({
      tag: 'f',
      patches: [
        SCRATCH_PATH.servicesPatch,
        REAL_PATCH,
        SCRATCH_PATH.runtimeRowsPatch,
        SCRATCH_PATH.reconcileProbePatch,
      ],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望仍然装配成功（warn-and-skip 不是错）：\n${r.stderr}`)
    assert.match(r.stderr, /^RECONCILE-PROBE-DONE$/m, `对账探针没跑完：\n${r.stderr}`)
    const rec = reconcileReading(r.stderr)
    assert.notEqual(rec, null, `读不到对账读数：\n${r.stderr}`)

    assert.equal(rec.effective, false, '靶子不在树里，自检却判了生效')
    // ★ 裁定之外，**理由**才是这一条的全部信息量。
    const codes = rec.byRow('legion-enforcement-permission-presets')
    assert.ok(codes.includes('ROW_MISSING'),
      `靶子缺席被报成了 ${JSON.stringify(codes)} —— ROW_NOT_ACTIVATED 的意思是`
      + '"已挂载、在等依赖服务"，而这里根本没有那一行')
    assert.equal(codes.includes('ROW_NOT_ACTIVATED'), false,
      '缺席与"在等依赖服务"被读成了同一件事')
    const joined = rec.reasons.join(' / ')
    assert.match(joined, /warn-and-skip/, `理由里没有说出 warn-and-skip 这回事：${joined}`)
    assert.equal(joined.includes('等待依赖服务'), false,
      `缺席被说成了"等待依赖服务"——那句话把人指向一个不存在的服务依赖：${joined}`)

    // 其余四行仍然各自 OK：这条对照变的**只有**靶子那一样，
    // 不然它读的就可能是"整棵树坏了"。
    assert.deepEqual(rec.byRow('legion-enforcement-hard-floor'), ['OK'])
    assert.deepEqual(rec.byRow('legion-enforcement-root'), ['OK'])
    assert.deepEqual(rec.byRow('legion-enforcement-pre-execute'), ['OK'])
    assert.deepEqual(rec.byRow('legion-enforcement-approval-answerer'), ['OK'])
    t.diagnostic(`F: effective=false，靶子行=${JSON.stringify(codes)}，其余四行 OK`)
  })

  guarded('G. ★★★ 同 F、但把生产宿主行**挂上**：具名拒绝、**不注册**端口，而进程**活着**', (t) => {
    // 这是 F 的下游那一步，单独读出来：靶子缺席 ⇒ 自检判未生效 ⇒
    // `bootstrapDshRuntime()` 拒绝注册宿主端口。
    //
    // ★★★ 本批**翻掉的就是这一条的后半句**：旧版这里写的是
    //     「树加载失败、进程退出 1」，并且用 `failed to apply loader entry` 钉住它。
    //     spec `line 854` 要的是「按 `incompatible` 处理并禁止自动执行」，
    //     而 §6.3 表格把 `incompatible` 定成「禁止自动执行，**提示修复或回滚**」——
    //     一个已经崩掉的进程提示不了任何东西，也无法被回滚。
    //
    //   > 一个"拒绝执行"的读数，与一个"拒绝启动"的读数，
    //   > 在**只看进程有没有起来**的时候是同一个东西——
    //   > 只不过前者还能被修，而后者只剩一次崩溃。
    //
    // 与 E 的唯一差别就是**没有靶子替身**；有了 E，这一条的"拒绝"才不是
    // "它本来就起不来"。
    const r = runDsh({
      tag: 'g',
      patches: [
        SCRATCH_PATH.servicesPatch,
        REAL_PATCH,
        SCRATCH_PATH.runtimeRowsPatch,
        SCRATCH_PATH.hostRowPatch,
        SCRATCH_PATH.probePatch,
      ],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望"进程活着并明说自己不能自动执行"：\n${r.stderr}`)
    // ★ 断言**具名内层码本身**，不写"它抛了"。
    assert.equal(reading(r.stderr, 'SVCCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE)
    assert.equal(reading(r.stderr, 'SVCINNER'), BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE)
    // 承诺的那两条读数：状态是 `incompatible`，且明确"禁止自动执行"。
    assert.equal(reading(r.stderr, 'SVCSTATE'), 'incompatible')
    assert.equal(reading(r.stderr, 'SVCFORBID'), 'true')
    // ★★★ 与旧版**不同形**：整棵树**没有**被拖垮。
    assert.equal(r.stderr.includes('failed to apply loader entry legion-runtime-host'), false,
      `仍然读到"装载这一行失败"——整棵树还是被拖垮了：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.BIND_REFUSED), false,
      `仍然读到 ${RUNTIME_HOST_ROW_CODES.BIND_REFUSED}——那一行还在抛：\n${r.stderr}`)
    // 拒绝要说得出**是哪一项**没过——自检的全部意义就是逐项归因。
    assert.match(JSON.stringify(reading(r.stderr, 'SVCCHECKS')), /composition-patch-layer/,
      `拒绝里没有指出是哪一项自检没过：\n${r.stderr}`)
    // ★★★ 反向锚（本批变**更强**了）：不是"没有 BOUND 读数"，而是
    //     worker 自己明确报 `false`——端口**确实没被注册**。
    //     "读不到"与"读到 false"是两件事：旧写法在探针根本没跑时也会绿。
    assert.equal(reading(r.stderr, 'BOUND'), 'false',
      `被拒绝的场景里端口却被注册了：\n${r.stderr}`)
    t.diagnostic(`G: exit 0 + ${RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE}(${BOOTSTRAP_CODES.SELF_CHECK_INCOMPATIBLE})`
      + ` state=${reading(r.stderr, 'SVCSTATE')} bound=${reading(r.stderr, 'BOUND')}`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // ★★★ H/I：**生产形状**的启动 —— 真 bundle 声明 `permission`，Legion 覆盖它
  //
  // 上面 A–G 用的 profile 都是 `bundles: []`，于是 `permission` 那一行**必须**
  // 靠测试替身插进去。PRT-214 因此一直留着这句话：
  //
  //   「一次带 bundle 的 profile 启动让 Legion preset 表真的生效，
  //     **依然没有被观察到**。」
  //
  // `dsh-base` 自己的 `cordis.patch.yml:229` 就声明了 `permission`
  // （`name: '@deepseek-ai/dsh-permission-presets'`）。把它挂上，Legion 补丁层的
  // `patch-over permission` 就有了**真的**靶子——于是这一条量的是生产那件事，
  // 不是"对账器会把某种树判生效"。
  //
  // 安全：仍然是**一次性 DSH_HOME**。DSH 会把安装处的依赖闭包软链进
  // `$DSH_HOME/profiles/node_modules`（`healProfilesModuleFallback`），
  // 写入全在临时目录里；真实 `~/.dsh` 一个字节都不碰。
  // ───────────────────────────────────────────────────────────────────────────

  guarded('H. ★★★ 生产形状：真 bundle + 真补丁层 → 生效的 preset 表是 **Legion 的**', (t) => {
    // ★ 刻意**不挂** `legion-runtime-host`：那一行**不在**真补丁层里
    //   （`legion-host.patch.yml` 里没有它，`PATCH_LAYER_ROWS` 里也没有）。
    //   把它混进来读的就不是"生产形状"，而是"生产形状 + 一件尚未接上的东西"——
    //   那一天它确实会拒绝，而拒绝的原因是**另外两项**自检（见 J）。
    const r = runDsh({
      tag: 'h',
      bundles: ['@deepseek-ai/dsh-base'],
      patches: [REAL_PATCH, SCRATCH_PATH.reconcileProbePatch],
    })
    assert.equal(r.spawnError, null)
    // bundle 起不来时**响亮地红**，不要静默退化成"读数不对"——
    // 那会让人以为产品坏了，而真因是这个环境里 bundle 解析不了。
    assert.equal(r.code, 0, `真 bundle 启动失败：\n${r.stderr}`)
    assert.match(r.stderr, /^RECONCILE-PROBE-DONE$/m, `对账探针没跑完：\n${r.stderr}`)
    const rec = reconcileReading(r.stderr)
    assert.notEqual(rec, null, `读不到对账读数：\n${r.stderr}`)

    // ① ★ 缺了很久的那个读数：整层**判生效**，在真的带 bundle 的启动里。
    assert.equal(rec.effective, true, `生产形状下自检判未生效：${JSON.stringify(rec.reasons)}`)
    assert.deepEqual(rec.reasons, [], '判生效了却还带着理由')
    for (const [row, code] of rec.findings) {
      assert.equal(code, 'OK', `${row} 在生产形状下的结论是 ${code}，不是 OK`)
    }
    // ② ★★ 生效的 preset 表是 **Legion 的**，不是 DSH 默认的那三个。
    assert.deepEqual(rec.presets, ['legion-attended', 'legion-unattended'],
      `生效的 preset 表不是 Legion 的：${JSON.stringify(rec.presets)}`)
    for (const dshDefault of ['read-only', 'workspace-write', 'danger-full-access']) {
      assert.equal((rec.presets ?? []).includes(dshDefault), false,
        `DSH 默认 preset "${dshDefault}" 还在生效表里 —— 覆盖没真发生`)
    }
    // ③ ★★★ 覆盖的是**内容**，不只是名字。
    //    两种值守都锁在 `workspace-write`，区别只在 approval。少了这一条，
    //    一个"只把名字塞进表里、sandbox 仍是 danger-full-access"的实现会绿——
    //    而把无人值守从"降到全权限"里救回来正是这张表的**全部意义**。
    const perm = reading(r.stderr, 'PERM-CONFIG')
    assert.notEqual(perm, null, `读不到生效的 permission config：\n${r.stderr}`)
    const cfg = JSON.parse(perm)
    assert.equal(cfg.presets['legion-attended'].sandbox, 'workspace-write')
    assert.equal(cfg.presets['legion-attended'].approval, 'ask')
    assert.equal(cfg.presets['legion-unattended'].sandbox, 'workspace-write',
      '无人值守的 sandbox 不是 workspace-write —— 那正是"无人值守 ⇒ 降到全权限"这个陷阱')
    assert.equal(cfg.presets['legion-unattended'].approval, 'never')
    // ④ 产品注册方（**不是**替身）把工厂注册进来了，组合根服务也发布了。
    assert.match(r.stderr, /^ROOT-SERVICE present$/m, r.stderr)
    assert.match(r.stderr, /^PORT-FACTORY registered$/m, r.stderr)
    t.diagnostic(`H: effective=true，presets=${JSON.stringify(rec.presets)}，sandbox=workspace-write×2`)
  })

  guarded('I. ★★★ H 的反向对照：**同一棵树、同一个 bundle**，只是不加载 Legion 补丁层', (t) => {
    // 这是 H 的**非空洞**保证。只跑 H，"preset 表是 Legion 的"可能只是
    // "这个 DSH 版本默认就叫这个名字"。把 Legion 的补丁层拿掉、其余一字不变：
    // 靶子行 `permission` 仍然由 **bundle** 提供，但生效表必须回到 DSH 默认。
    const r = runDsh({
      tag: 'i',
      bundles: ['@deepseek-ai/dsh-base'],
      patches: [SCRATCH_PATH.reconcileProbePatch],
    })
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `对照组启动失败：\n${r.stderr}`)
    assert.match(r.stderr, /^RECONCILE-PROBE-DONE$/m, r.stderr)
    const rec = reconcileReading(r.stderr)
    assert.notEqual(rec, null, `对照组读不到对账读数：\n${r.stderr}`)

    // ★ 靶子行在树里、且激活 —— 所以下面那条差异**只**能来自 Legion 的补丁层，
    //   不可能来自"这一行根本不存在"。这一条是 I 存在的全部理由。
    assert.match(r.stderr, /"legion-enforcement-permission-presets",true,true/,
      `对照组里 permission 行不在树里 —— 那这条对照读的是"行缺席"，不是"覆盖没发生"：\n${r.stderr}`)
    assert.deepEqual(rec.presets, ['read-only', 'workspace-write', 'danger-full-access'],
      `没加载 Legion 补丁层，生效表却不是 DSH 默认：${JSON.stringify(rec.presets)}`)
    // 而 Legion 的名字**一个都不能在**。
    for (const name of ['legion-attended', 'legion-unattended']) {
      assert.equal((rec.presets ?? []).includes(name), false,
        `${name} 在没有 Legion 补丁层的启动里也生效了 —— 那 H 读的不是覆盖`)
    }
    t.diagnostic(`I: presets=${JSON.stringify(rec.presets)}（DSH 默认），permission 行在树里且激活`)
  })

  guarded('J. ★★★ 把**生产消费者**自己的判决读出来：它没有把"组合补丁层"列进未通过项', (t) => {
    // H 读的是**我们自己的**对账探针调 `reconcilePatchLayer()`。
    // 这一条读的是**产品自己的**那一次判定：`bootstrapDshRuntime()` →
    // `startupSelfCheck()` 第①项。两者是同一份观察，但**调用方不同**——
    // 探针对了、生产调用方不对，是完全可能的。
    //
    // 挂上 `legion-runtime-host`（生产里尚未接上的那一行）来驱动它。那一行在这个
    // 形状下**会拒绝**，而拒绝的理由是**具体哪几项**没过——失败清单里有没有
    // `composition-patch-layer`，就是这一条要读的东西。
    //
    // ⚠️ 这条**不**断言"它一定拒绝"：②③两项取决于环境（见下），某台机器上它可能
    //    直接装上。两种结局都允许，被钉住的只有"第①项不在失败清单里"。
    const r = runDsh({
      tag: 'j',
      bundles: ['@deepseek-ai/dsh-base'],
      patches: [REAL_PATCH, SCRATCH_PATH.hostRowPatch, SCRATCH_PATH.reconcileProbePatch],
    })
    assert.equal(r.spawnError, null)

    // 自检的逐项归因。本批之后拒绝**不再抛**，所以它不再只出现在 stderr 的
    // 「未通过的自检项」那一段里，而是出现在**发布出来的**服务值上。
    // 两条来源都收：stderr（旧路径，仍被更下面的 C 场景用着）与 `SVCCHECKS`。
    //   > 只收其中一条，会在"拒绝换了条路"的那一刻读到空清单——
    //   > 而空清单会让下面那条 `includes(...) === false` 变成一个恒真断言。
    const failedItems = [...new Set([
      ...[...r.stderr.matchAll(/^\s*· ([a-z0-9-]+)[:：]/gm)].map((m) => m[1]),
      ...(() => {
        const raw = reading(r.stderr, 'SVCCHECKS')
        if (raw === null) return []
        try {
          const parsed = JSON.parse(raw)
          return Array.isArray(parsed) ? parsed.filter((c) => c?.ok !== true).map((c) => c.name) : []
        } catch { return [] }
      })(),
    ])]
    // ★★★ 本条的判据。生产调用方要么根本没拒绝（说明它把三项都判过了），
    //     要么拒绝的理由里**不含**组合补丁层这一项。
    assert.equal(failedItems.includes('composition-patch-layer'), false,
      `生产自检把"组合补丁层"列进了未通过项 —— 那 H 的 effective=true 是探针说的，`
      + `生产调用方并不这么看。未通过项：${JSON.stringify(failedItems)}\n${r.stderr.slice(-1200)}`)
    // ★★ 拒绝必须是**逐项归因**的：报出来的名字得是自检自己的项名，
    //    而不是一段随手拼的文本。少了这一条，一个"把三项糊成一句'未生效'"的实现
    //    也能过上面那条断言（它的未通过清单会是空的或全是垃圾名）。
    const CHECK_ITEMS = ['composition-patch-layer', 'runtime-probe', 'sandbox-enforcement',
      'enforcement-mapping', 'guard-approval-consistency', 'enforcement-availability']
    for (const item of failedItems) {
      assert.ok(CHECK_ITEMS.includes(item),
        `未通过项里出现了不是自检项名的东西："${item}" —— 那这条归因读的不是自检输出：`
        + `${JSON.stringify(failedItems)}`)
    }

    if (r.code === 0 && reading(r.stderr, 'BOUND') === 'true') {
      // 三项全过 ⇒ 宿主端口真的注册了。这是最强的那一种结局。
      assert.deepEqual(failedItems, [], '没拒绝却有未通过项 —— 两者不一致')
      t.diagnostic('J: 三项全过，BOUND=true；未通过项=[]')
    } else {
      // ★★★ 自检**拒绝**了。本批之后这不再意味着进程退出——而是
      //     "进程活着、端口没注册、结论是 `incompatible`"。
      //     把真实理由记进诊断，不假装它不存在。
      assert.equal(reading(r.stderr, 'SVCCODE'), RUNTIME_HOST_ROW_CODES.SELF_CHECK_INCOMPATIBLE,
        `既没有 BOUND=true、也没有具名拒绝——那是第三种状态，本用例不认：\n${r.stderr.slice(-1200)}`)
      assert.equal(reading(r.stderr, 'SVCFORBID'), 'true')
      assert.equal(reading(r.stderr, 'BOUND'), 'false', '拒绝了却把端口注册上了——那是真的放松')
      assert.ok(failedItems.length > 0, `拒绝了却没给出逐项归因：\n${r.stderr}`)
      // ★★★ 这一条是**那个平台级阻塞**的可执行版本：
      //     Windows 上 DSH 的 `windows-acl` 后端**静态**报 `partial`
      //     （`sandbox-local/src/index.ts:186`，理由写在源码注释里：WRITE_RESTRICTED
      //     需要 Everyone 在两个 restricting 列表里、且 NTFS 硬链接能把已授权文件
      //     别名到工作区外），而本产品的判据取 `full`（spec §A.7 第 1 条）。
      //     两者在 Windows 上不相容 ⇒ 生产宿主行在这个平台上**永远拒绝**。
      //     不断言"一定拒绝"（Linux 上 bwrap/landlock 是 full），但当拒绝发生时，
      //     在这个平台上它**必须**是沙箱那一项——否则就说明我们对"为什么起不来"
      //     的判断是错的，而那正是这一轮要钉住的东西。
      if (process.platform === 'win32') {
        assert.ok(failedItems.includes('sandbox-enforcement'),
          `Windows 上拒绝了，未通过项却不是沙箱：${JSON.stringify(failedItems)}——`
          + '本轮量到的平台级阻塞（windows-acl 静态 partial vs 判据 full）不成立，'
          + '或者拒绝的原因另有其物，两种情况都必须重读\n' + r.stderr.slice(-1200))
      }
      t.diagnostic(`J: 拒绝了（exit=${r.code}，端口未注册），未通过项=${JSON.stringify(failedItems)}——**不含** composition-patch-layer`)
    }
  })
})

/**
 * 把对账探针的读数解析成结构化结果。读不到就返回 `null`——**不猜默认值**：
 * 一个"读不到就当 false"的解析器，与一个"读不到就是真的 false"的读数，
 * 在只看结论的时候是同一个东西。
 */
function reconcileReading(stderr) {
  const effective = reading(stderr, 'RECONCILE-EFFECTIVE')
  if (effective === null) return null
  const rawPresets = reading(stderr, 'RECONCILE-PRESETS')
  const rawReasons = reading(stderr, 'RECONCILE-REASONS')
  const findings = []
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^RECONCILE-FINDING (\[.*\])$/.exec(line)
    if (m !== null) {
      try { findings.push(JSON.parse(m[1])) } catch { /* 形状不对就不收 */ }
    }
  }
  const parse = (s) => { try { return JSON.parse(s) } catch { return null } }
  return {
    effective: effective === 'true',
    presets: parse(rawPresets),
    reasons: parse(rawReasons) ?? [],
    findings,
    byRow: (id) => findings.filter(([row]) => row === id).map(([, code]) => code),
  }
}

if (SKIP !== false) {
  test('PRT-253 真 DSH 进程部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
