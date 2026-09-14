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
import { EXECUTOR_CODES } from '../../../orchestrator/worker/executor.mjs'
import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import { SUPPORTED_RUNTIME } from '../../adapters/dsh/probe.mjs'

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

const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
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
    note('SERVICES-PROVIDED tools,approval,sandbox')
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
      note('SVC ' + (ctx.get('legionRuntimeHostBinding', false) === undefined ? 'absent' : 'present'))
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

  guarded('C. ★★ 本行挂上、但**没有人注册端口** → 真进程里具名拒绝（exit 1）', (t) => {
    const r = runDsh({
      tag: 'c',
      patches: [...BASE_PATCHES, SCRATCH_PATH.hostRowOnlyPatch, SCRATCH_PATH.probePatch],
    })

    assert.equal(r.spawnError, null)
    // 行在 `apply` 期拒绝 ⇒ 启动路径上失败 ⇒ 非 0 退出。**不是**静默 no-op。
    assert.equal(r.code, 1, `期望"没有端口工厂"拦下启动：\n${r.stderr}`)
    // ★ 断言具名码本身，不写"它抛了"。
    assert.match(r.stderr, new RegExp(RUNTIME_HOST_ROW_CODES.NO_INPUTS_FACTORY), r.stderr)
    // 反向锚：这一行确实被真加载器当成**条目**在报。
    assert.match(r.stderr, /failed to apply loader entry legion-runtime-host/, r.stderr)
    // 两种"装不上"不能同形：这一条**不是**组合树或自检的问题。
    assert.equal(r.stderr.includes('BOOTSTRAP_SELF_CHECK_INCOMPATIBLE'), false,
      `缺工厂却报成自检不过——那这条对照读的是别的东西：\n${r.stderr}`)
    assert.equal(r.stderr.includes(RUNTIME_HOST_ROW_CODES.NO_COMPOSITION), false, r.stderr)
    assert.equal(reading(r.stderr, 'BOUND'), null, '拒绝的场景里不该有 BOUND 读数')
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
})

if (SKIP !== false) {
  test('PRT-253 真 DSH 进程部分本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
