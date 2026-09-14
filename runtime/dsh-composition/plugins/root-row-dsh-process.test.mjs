// runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs
// ============================================================================
// PRT-214：这一套问的是**一个此前从未被观测过**的读数——
// 「补丁行里的 `apply()` 在一个**真 DSH 进程**里到底有没有跑」。
//
// ## 为什么这一条必须单独存在
//
// 在此之前，整条链的证据只到两处，而**两处都不是 DSH 进程**：
//
//   · `patch-loadable.test.mjs` —— 解析期接受（形状检查，不是解析器）；
//   · `root-row.test.mjs` 的下半部分 —— **真 cordis `Context`**，但那是一个
//     由用例自己 `new` 出来的 Context，不是 `dsh` 进程的加载器。
//
// 而且 `--dump-config` 这条路**看起来**像证过了：它 code 0、输出里带着锚定好的
// `file://…/root-row.mjs`。但那是 `renderConfigDump()` 把补丁层**解析并锚定**之后
// 打印出来——`dump-config.js` 的文件头写得很清楚："without booting or evaluating"。
// 一个"把行打印出来"的路径，与一个"把行装起来"的路径，在日志上长得一模一样。
//
//   > 一条"被解析并锚定"的补丁行，
//   > 与一条"被真的挂进进程"的补丁行，在 dump 的输出里完全同形——
//   > 只不过前者从来没有 `apply` 过。
//
// 所以本套件**不看 dump**，它启动真 CLI（`apps/cli/lib/bin.js`），
// 用探针行的 stderr 读数回答"apply 跑没跑"。
//
// ## 怎么做到不碰任何真实凭据 / 任何真实 profile
//
//   · 每个子进程都显式吃一个**自己的临时 `DSH_HOME`**（`$env:DSH_HOME` 覆盖），
//     目录建在 `os.tmpdir()` 下，并在启动前断言它确实在 tmpdir 里；
//   · 那个临时 home 里的 profile 声明 `dsh.profile.bundles: []` ——
//     **一个 bundle 层都不挂**，于是 web / llm / 凭据 / 网络那一整片行根本不进树；
//     唯一进树的行就是本套件通过 `--patch` 插进去的那几行；
//   · `patchReload: 'startup'`：不启动 live 热重载 watcher（那个要 `hmr` 服务）；
//   · `DSH_SNAPSHOT` 从子进程环境里**删掉**，免得 CI 的 snapshot 模式漏进来；
//   · 每个子进程都有 `spawnSync` 超时上界 + 探针自己的退出兜底，不留长命进程。
//
// ★ 这套件**从未**读写 `~/.dsh`，也从未把任何补丁文件写进真实 profile。
//
// ## 读了哪些读数（每一条都有一个反向对照）
//
//   A. `--dump-config` **不**实例化：同一份补丁层、同一个探针模块，dump 出
//      `file://` 锚定行、code 0，而 stderr 里**一个字节都没有** PROBE-APPLY-RAN。
//      ——这是"dump 不等于挂载"的正面读数，也是本套件其余部分的对照组。
//   B. 真 profile 启动：探针行的 `apply` **真的跑了**（stderr 出现 PROBE-APPLY-RAN）。
//      ——"能加载"与"跑了"在这条之前从未被分开过。
//   C. 真 `legion-host.patch.yml` 的那一行：root-row 的 `apply` 跑了，并且**拒绝**，
//      拒绝码 `ENFORCEMENT_ROOT_CONFIG_EMPTY` 透传到 stderr，启动失败（code 1）。
//      ——**拒绝不是成功**，这条断言的是拒绝本身。
//   D. 全链：根行装配成功 → 发布 `legionEnforcementRoot` → 两行运行期模块
//      离开 waiting 并激活（挂载审计 `fiberState: 2`）→ 真 `tools/pre-execute`
//      瀑布**认领**一次调用（`kind: 'deny'`）。
//      ——这是"强制面真的挂上了"的读数，不是"文件里有这个 import"。
//   E. 反向对照：两行运行期模块、同一条 `tools` 端口、但**根行缺席** →
//      DSH 自己的挂载审计报 `pending (waiting for service: legionEnforcementRoot)`，
//      启动失败（code 1），而且瀑布上**没有** listener。
//      ——没有这一条，D 里的"激活"可能只是"加载顺序碰巧"。
//   F. ★ D 用的是**替身注册方**（一个测试脚手架模块）。F 把补丁层换成**磁盘上那份
//      真 `legion-host.patch.yml`**、`--patch` 里一个测试脚手架行都不加：根行的模块
//      就是产品注册方（`team-hub/approval-registrar-row.mjs`），于是这一行**装上**
//      而不是拒绝（code 0），服务发布，两行激活，瀑布被认领。
//      ——"apply 跑了然后拒绝"与"apply 跑了然后装上"在这里第一次被分开。
//   G. F 的反向对照：把**插件本体**当成那一行的模块（= 注册方缺席，也就是产品
//      注册方交付前补丁层的取值）。身份配置是齐的，所以唯一缺的是工厂——读数必须是
//      root 行自己的具名拒绝 `..._NO_APPROVAL_PORT_FACTORY`（code 1），
//      **不是**配置码，也不是一个"装好了但没端口"的静默结局。
//      ——没有这一条，F 的"装上了"可能只是"这一行现在什么都不检查了"。
//   H. F 的**顺序对照**：把同一份补丁层的两行置换、并把 `--patch` 的层序整条倒过来，
//      F 的读数必须一字不变。它排除的是"这条接线只在某一个具体顺序下装上"；
//      "为什么行序无关"的正面读数是一个 2×2 矩阵（第二行 vs 同模块图 × 注册前挂起），
//      量在真 DSH 进程里、记在文档 §10——那份矩阵作为回归门槛太重（24 个真进程），
//      所以这里不复制它，只在注释里指路。
//
// ## 测试形状纪律
//
//   · 只断言**具名标记 / 具名码**，不写"它抛了"；
//   · 每条"跑没跑"的断言都带反向对照；
//   · 需要 DSH_CHECKOUT 的那几条逐条 `t.skip()`（`skipped: N` 看得见）；
//     跑不了就不算跑过——外部宿主测试不伪造通过。
// ============================================================================

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 拒绝码取自**产品模块**，不在用例里另抄一份字符串：抄一份的话，产品改了码而
// 用例还绿着，"断言的是那个码"就变成了一句注释。
import { ROOT_ROW_CODES } from './root-row.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSITION = resolve(HERE, '..')

// ─────────────────────────────────────────── 可跑性判定（沿用 root-row.test.mjs 的口径）

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

// ─────────────────────────────────────────── 临时 DSH_HOME（**绝不**碰真实 profile）

const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-root-row-dsh-'))

after(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/** Legion 身份环境。字段就是 `REQUIRED_ENFORCEMENT_CONFIG` 那几个，一个不多一个不少。 */
const LEGION_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt214rt-actor',
  LEGION_SCOPE: 'prt214rt-scope',
  LEGION_ENFORCEMENT_ACTION: 'write',
  LEGION_CWD: process.platform === 'win32' ? 'C:\\work' : '/work',
})

const PROFILE_NAME = 'prt214rt'

/**
 * 建一个**一次性** DSH home，里面只有一个 `bundles: []` 的 profile。
 *
 * 建在 `SCRATCH` **里面**（而不是 `os.tmpdir()` 同级），这样上面那个 `after()`
 * 的 `rmSync(SCRATCH)` 会把每一次运行的每一个 home 一并收走——
 * 一个"每次跑都往 tmpdir 里丢几个 home 且没人收"的用例，
 * 与一个"跑完不留下东西"的用例，在功能上一样，但在机器上是两回事。
 *
 * 启动前断言它确实落在 tmpdir 下——这条断言是安全规则的可执行版本。
 * @param {string} tag - 场景名，只用于目录名。
 * @returns {string} 一次性 home 的绝对路径。
 */
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

// ─────────────────────────────────────────── 临时模块：全部是**探针**，不是产品代码
//
// 产品行本身由真补丁层 / 真模块文件给定；这里生成的只是"怎么观测"与
// "把待测行要的宿主端口支起来"的那几件。

const PROBE_SRC = `// 探针行：本文件存在的唯一理由是让"这一行的 apply 跑了"在进程外可见。
import { appendFileSync } from 'node:fs'
const logPath = process.env.PRT_PROBE_LOG
function note(line) {
  process.stderr.write(line + '\\n')
  if (logPath) {
    try { appendFileSync(logPath, line + '\\n') } catch {}
  }
}
export default {
  name: 'prt214rt-probe',
  inject: [],
  apply() {
    note('PROBE-APPLY-RAN')
    note('PROBE-DSH_HOME ' + (process.env.DSH_HOME ?? '(unset)'))
    const delay = Number(process.env.PRT_PROBE_EXIT_MS ?? '20000')
    setTimeout(() => { note('PROBE-EXIT-0'); process.exit(0) }, Number.isFinite(delay) ? delay : 20000)
  },
}
`

const PROBE_PATCH_SRC = `- insert:
    - id: "prt214rt-probe"
      name: "./prt214rt-probe.mjs"
`

const SERVICES_SRC = `// 桩宿主：只发布 Legion 两行声明 inject 的两个服务。不是 ToolRuntime。
const note = (line) => process.stderr.write(line + '\\n')
export default {
  name: 'prt214rt-services',
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
    note('SERVICES-PROVIDED tools,approval')
  },
}
`

const SERVICES_PATCH_SRC = `- insert:
    - id: "prt214rt-services"
      name: "./prt214rt-services.mjs"
`

// 运行期两行（`module: null` 的那两行）按**绝对路径**挂——它们不在静态补丁层里。
const RUNTIME_ROWS_PATCH_SRC = `- insert:
    - id: "legion-enforcement-pre-execute"
      name: ${JSON.stringify(join(HERE, 'pre-execute-row.mjs'))}
    - id: "legion-enforcement-approval-answerer"
      name: ${JSON.stringify(join(HERE, 'approval-answerer-row.mjs'))}
`

const WATERFALL_SRC = `// 探针：树稳定之后问真 \`tools/pre-execute\` 瀑布有没有人认领，并 dump DSH 自己的挂载审计。
// 另外读两个只有在这个进程里才读得到的缝：注册行发布的**服务**、以及模块级的
// **审批端口工厂**。两者都是"接线到底通没通"的直接读数（而不是"文件里有这个 import"）。
import { approvalPortFactory } from ${JSON.stringify(pathToFileURL(join(HERE, 'root-row.mjs')).href)}
const note = (line) => process.stderr.write(line + '\\n')
const BOGUS = { callId: 'prt214rt-c1', name: 'no-such-tool', arguments: {} }
export default {
  name: 'prt214rt-waterfall-probe',
  inject: [],
  apply(ctx) {
    setTimeout(async () => {
      try {
        const out = await ctx.waterfall('tools/pre-execute', BOGUS, () => 'NO-LISTENER')
        note('WATERFALL-RESULT ' + JSON.stringify(out))
        if (out === 'NO-LISTENER') note('GATE-NOT-BOUND')
        else if (out && out.kind === 'deny') note('GATE-DENIED')
        else note('GATE-OTHER')
      } catch (error) {
        note('WATERFALL-THREW ' + String(error && error.message ? error.message : error))
      }
      try {
        for (const entry of ctx.loader.entries()) {
          note('MOUNT ' + JSON.stringify({
            name: entry.options.name,
            disabled: entry.disabled === true,
            fiberState: entry.fiber === undefined ? null : entry.fiber.state,
          }))
        }
      } catch (error) {
        note('MOUNT-DUMP-THREW ' + String(error && error.message ? error.message : error))
      }
      note('ENFORCEMENT-ROOT-SERVICE ' + (ctx.get('legionEnforcementRoot', false) === undefined ? 'absent' : 'present'))
      note('APPROVAL-PORT-FACTORY ' + (approvalPortFactory() === null ? 'none' : 'registered'))
      note('WATERFALL-PROBE-EXIT-0')
      process.exit(0)
    }, 2500)
  },
}
`

const WATERFALL_PATCH_SRC = `- insert:
    - id: "prt214rt-waterfall-probe"
      name: "./prt214rt-waterfall-probe.mjs"
`

// 注册方**替身**：产品注册方已经交付（`team-hub/approval-registrar-row.mjs`），
// 所以这条脚手架现在的作用是**留下一组既有读数**：D 用它证明"注册方一到位、服务就发布、
// 两行就激活、瀑布就认领"，而**不经过**产品注册方那一条路径——于是"产品的注册方坏了"
// 与"这套脚手架本身坏了"在读数上分得开。真补丁层那一条是 F。
//
// 它同样在**模块求值期**注册工厂，且 default 导出就是**真的那个** root-row 插件对象，
// 没有替换。
const ROOT_ROW_WRAPPER_SRC = `import { setApprovalPortFactory } from ${JSON.stringify(pathToFileURL(join(HERE, 'root-row.mjs')).href)}
import realRootRow from ${JSON.stringify(pathToFileURL(join(HERE, 'root-row.mjs')).href)}
process.stderr.write('REGISTRAR-INSTALLED\\n')
setApprovalPortFactory((resolved) => {
  process.stderr.write('REGISTRAR-FACTORY-CALLED keys=' + Object.keys(resolved ?? {}).sort().join(',') + '\\n')
  return { requestApproval: async () => 'rejected' }
})
export default realRootRow
`

const ROOT_ROW_WRAPPER_PATCH_SRC = `- insert:
    - id: "legion-enforcement-root"
      name: "./prt214rt-rootrow-wrapper.mjs"
`

// ★ 反向对照专用：把**插件本体**当成那一行的模块挂上去，也就是"没有注册方"的部署。
//
// 这不是人为造出来的处境：产品注册方交付之前，补丁层里那一行的 `module` 就是它
// （PRT-214 文档 §9 的读数 C / D 就是这么跑出来的）。所以这条对照读的是
// **这台机器上真的会发生的**一种装配，而不是一个虚构的坏例子。
const ROOT_ROW_ONLY_PATCH_SRC = `- insert:
    - id: "legion-enforcement-root"
      name: ${JSON.stringify(join(HERE, 'root-row.mjs'))}
`

const REAL_PATCH = join(COMPOSITION, 'legion-host.patch.yml')

const SCRATCH_FILES = {
  probe: ['prt214rt-probe.mjs', PROBE_SRC],
  probePatch: ['prt214rt-probe.patch.yml', PROBE_PATCH_SRC],
  services: ['prt214rt-services.mjs', SERVICES_SRC],
  servicesPatch: ['prt214rt-services.patch.yml', SERVICES_PATCH_SRC],
  runtimeRowsPatch: ['prt214rt-runtime-rows.patch.yml', RUNTIME_ROWS_PATCH_SRC],
  waterfall: ['prt214rt-waterfall-probe.mjs', WATERFALL_SRC],
  waterfallPatch: ['prt214rt-waterfall-probe.patch.yml', WATERFALL_PATCH_SRC],
  rootRowWrapper: ['prt214rt-rootrow-wrapper.mjs', ROOT_ROW_WRAPPER_SRC],
  rootRowWrapperPatch: ['prt214rt-rootrow-wrapper.patch.yml', ROOT_ROW_WRAPPER_PATCH_SRC],
  rootRowOnlyPatch: ['prt214rt-rootrow-only.patch.yml', ROOT_ROW_ONLY_PATCH_SRC],
}

const SCRATCH_PATH = {}
for (const [key, [fileName, source]] of Object.entries(SCRATCH_FILES)) {
  SCRATCH_PATH[key] = join(SCRATCH, fileName)
  writeFileSync(SCRATCH_PATH[key], source)
}

/**
 * 跑一次真 `dsh`。每次都给一个**新的**一次性 home，并显式设置 `DSH_HOME`。
 * @param {{tag: string, patches?: string[], legionEnv?: boolean, probeExitMs?: number, dumpConfig?: boolean}} scenario
 * @returns {{code: number|null, signal: string|null, stderr: string, stdout: string, home: string}}
 */
function runDsh(scenario) {
  const home = makeHome(scenario.tag)
  const args = ['--profile', PROFILE_NAME]
  for (const patch of scenario.patches ?? []) args.push('--patch', patch)
  if (scenario.dumpConfig === true) args.push('--dump-config')

  const env = {
    ...process.env,
    DSH_HOME: home,
    PRT_PROBE_LOG: join(SCRATCH, `${scenario.tag}.probe.log`),
    PRT_PROBE_EXIT_MS: String(scenario.probeExitMs ?? 20_000),
  }
  delete env.DSH_SNAPSHOT
  if (scenario.legionEnv === true) Object.assign(env, LEGION_ENV)

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

// ───────────────────────────────────────────────────────────────────────────

describe('PRT-214：补丁行的 apply 在**真 DSH 进程**里跑没跑', () => {
  guarded('A. `--dump-config` 解析并锚定那一行，但**从不实例化**它（对照组）', async () => {
    const r = runDsh({ tag: 'a', patches: [SCRATCH_PATH.probePatch], dumpConfig: true })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, r.stderr)
    // 锚定确实发生了：相对 name 被改写成 file:// URL。YAML 对长标量会用 `>-`
    // 折行，所以先归一空白再断言，别把发射器的折行风格当成产品行为。
    const flat = r.stdout.replace(/\s+/g, ' ')
    assert.match(flat, /name: (?:>- )?file:\/\/\/\S*prt214rt-probe\.mjs/,
      `dump 里没有锚定后的 file:// 行：\n${r.stdout}`)
    // 而 apply **一个字节都没跑**。这正是"dump ≠ 挂载"。
    assert.equal(r.stderr.includes('PROBE-APPLY-RAN'), false,
      `dump-config 竟然执行了 apply —— 本套件其余部分的对照组失效：\n${r.stderr}`)
  })

  guarded('B. 真 profile 启动：补丁行的 `apply` **真的跑了**（此前从未被观测）', async () => {
    const r = runDsh({ tag: 'b', patches: [SCRATCH_PATH.probePatch], probeExitMs: 3000 })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /^PROBE-APPLY-RAN$/m)
    // 探针自报的一次性 home：证明这次运行**不是**在操作者的 home 里跑的。
    assert.match(r.stderr, new RegExp(`^PROBE-DSH_HOME ${r.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  })

  guarded('C. 真 legion-host.patch.yml：root-row 跑了、并且**拒绝**（具名码，code 1）', async () => {
    const r = runDsh({ tag: 'c', patches: [SCRATCH_PATH.probePatch, REAL_PATCH] })

    assert.equal(r.spawnError, null)
    // 拒绝发生在启动路径上：树加载失败，进程非 0 退出。
    assert.equal(r.code, 1, `期望启动因 root-row 拒绝而失败：\n${r.stderr}`)
    assert.match(r.stderr, /^PROBE-APPLY-RAN$/m)
    // ★ 断言的是**拒绝本身**，不是"装好了"。
    assert.match(r.stderr, /legion-enforcement-root/)
    assert.match(r.stderr, /ENFORCEMENT_ROOT_CONFIG_EMPTY/)
    assert.match(r.stderr, /root-row\.mjs/)
    // 反向对照的锚：这一行确实被真加载器当成**条目**在报。
    assert.match(r.stderr, /failed to apply loader entry legion-enforcement-root/)
  })

  guarded('D. 全链：根行装好 → 服务发布 → 两行激活 → 真瀑布**认领**一次调用', async () => {
    const r = runDsh({
      tag: 'd',
      patches: [
        SCRATCH_PATH.servicesPatch,
        SCRATCH_PATH.rootRowWrapperPatch,
        SCRATCH_PATH.runtimeRowsPatch,
        SCRATCH_PATH.probePatch,
        SCRATCH_PATH.waterfallPatch,
      ],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望全链装配成功：\n${r.stderr}`)
    // 注册方（本用例用的是**替身**行）在真进程里被**真的调用**了，并拿到身份字段。
    assert.match(r.stderr, /^REGISTRAR-INSTALLED$/m)
    assert.match(r.stderr, /REGISTRAR-FACTORY-CALLED keys=action,actor,cwd,hubToken,hubUrl,platform,scope,taskId/)
    // 强制面真的挂上了：瀑布上有 listener，而且它认领（deny）了。
    assert.match(r.stderr, /^GATE-DENIED$/m)
    assert.equal(r.stderr.includes('GATE-NOT-BOUND'), false, r.stderr)
    // 两个模块级/服务级的**直接**读数（不是"文件里有这个 import"）：
    //   · 注册缝上有工厂；
    //   · `legionEnforcementRoot` 服务真的发布了。
    assert.match(r.stderr, /^APPROVAL-PORT-FACTORY registered$/m, r.stderr)
    assert.match(r.stderr, /^ENFORCEMENT-ROOT-SERVICE present$/m, r.stderr)
    // DSH 自己的挂载审计：两行运行期模块是 ACTIVE（fiberState 2），不是 waiting。
    for (const row of ['pre-execute-row.mjs', 'approval-answerer-row.mjs']) {
      assert.match(r.stderr, new RegExp(`MOUNT \\{[^}]*${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*"fiberState":2\\}`),
        `${row} 在 DSH 的挂载审计里不是 ACTIVE：\n${r.stderr}`)
    }
  })

  guarded('E. 反向对照：根行缺席 → DSH 挂载审计报 pending，瀑布上**没有** listener', async () => {
    const r = runDsh({
      tag: 'e',
      patches: [
        SCRATCH_PATH.servicesPatch,
        SCRATCH_PATH.runtimeRowsPatch,
        SCRATCH_PATH.probePatch,
        SCRATCH_PATH.waterfallPatch,
      ],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    // 依赖没到位 ⇒ 两行 pending ⇒ DSH 的启动断言把树判为失败。
    assert.equal(r.code, 1, `期望"entry 未激活"拦下启动：\n${r.stderr}`)
    assert.match(r.stderr, /did not activate/)
    // ★ 这条读数由 **DSH 自己**给出（`assertEntriesActivated`），不是我们数的。
    assert.match(r.stderr, /pre-execute-row\.mjs: pending \(waiting for service: legionEnforcementRoot\)/)
    assert.match(r.stderr, /approval-answerer-row\.mjs: pending \(waiting for service: legionEnforcementRoot\)/)
  })

  guarded('F. ★★★ 真 legion-host.patch.yml（一个字节都不改）：这一行**装上**，不再拒绝', async () => {
    // 与 C 的唯一区别：C 没有身份配置（于是配置先拒绝），F 身份配齐、并且**用的是
    // 磁盘上那份真补丁层**——注册方就是它的 root 行模块，没有任何测试脚手架替身。
    const r = runDsh({
      tag: 'f',
      patches: [
        SCRATCH_PATH.servicesPatch,
        REAL_PATCH,
        SCRATCH_PATH.runtimeRowsPatch,
        SCRATCH_PATH.probePatch,
        SCRATCH_PATH.waterfallPatch,
      ],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    // ★ 本条与 C 的差别必须**直接读出来**：C 是 exit 1 + 拒绝码，F 是 exit 0。
    assert.equal(r.code, 0, `期望真补丁层装配成功（不再是拒绝）：\n${r.stderr}`)
    assert.match(r.stderr, /^PROBE-APPLY-RAN$/m)
    // 拒绝**没有**发生。用的是模块导出的码字面量，不另抄一份字符串。
    assert.equal(r.stderr.includes(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY), false,
      `真补丁层仍然以"没有审批端口工厂"拒绝——那说明注册方没有生效：\n${r.stderr}`)
    assert.equal(r.stderr.includes(ROOT_ROW_CODES.APPROVAL_PORT_UNUSABLE), false, r.stderr)
    assert.equal(r.stderr.includes('failed to apply loader entry legion-enforcement-root'), false, r.stderr)

    // ① 注册缝上真的有工厂，而且它**不是**替身行注册的（本场景没挂替身行）。
    assert.match(r.stderr, /^APPROVAL-PORT-FACTORY registered$/m, r.stderr)
    assert.equal(r.stderr.includes('REGISTRAR-INSTALLED'), false,
      'F 场景里出现了替身行的标记——那这条读数就不是"真注册方生效"')
    // ② 服务发布了，两行运行期模块离开 waiting。
    assert.match(r.stderr, /^ENFORCEMENT-ROOT-SERVICE present$/m, r.stderr)
    for (const row of ['pre-execute-row.mjs', 'approval-answerer-row.mjs']) {
      assert.match(r.stderr, new RegExp(`MOUNT \\{[^}]*${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*"fiberState":2\\}`),
        `${row} 在真补丁层下不是 ACTIVE：\n${r.stderr}`)
    }
    // ③ 强制面挂上了：真 `tools/pre-execute` 瀑布被认领并 deny。
    //
    //    ⚠️ 这一次 deny 的**对象是一个不存在的工具**（`no-such-tool`）：它证明的是
    //    "瀑布上有真的 listener，而且它的投影失败方向是拒绝"。它**不是**
    //    "一次真实工具调用被拦下"——后者需要真 ToolRuntime（`bundles: []` 的
    //    一次性 profile 里没有），本批没有做到，见文档 §10 的诚实边界。
    assert.match(r.stderr, /^GATE-DENIED$/m, r.stderr)
    assert.equal(r.stderr.includes('GATE-NOT-BOUND'), false, r.stderr)
  })

  guarded('G. ★★★ 反向对照：**注册方缺席**（把插件本体当那一行的模块）→ 仍是具名拒绝', async () => {
    // 驱动它的方式是挂**产品自己的**插件文件、不带注册方——这正是产品注册方交付前
    // 补丁层里那一行 `module` 的取值（§9 的读数 D）。配置是齐的，所以缺的只可能是工厂。
    const r = runDsh({
      tag: 'g',
      patches: [SCRATCH_PATH.servicesPatch, SCRATCH_PATH.rootRowOnlyPatch, SCRATCH_PATH.probePatch],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 1, `期望"没有审批端口工厂"拦下启动：\n${r.stderr}`)
    assert.match(r.stderr, /^PROBE-APPLY-RAN$/m)
    assert.match(r.stderr, /failed to apply loader entry legion-enforcement-root/)
    // ★ 断言**具名码本身**，不写"它抛了"。
    assert.match(r.stderr, new RegExp(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY), r.stderr)
    // 两种"装不上"不能同形：这一条**不是**配置问题（身份是齐的）。
    assert.equal(r.stderr.includes('ENFORCEMENT_ROOT_CONFIG_EMPTY'), false,
      `身份配齐了却报配置为空——那这条对照读的是配置，不是注册方：\n${r.stderr}`)
    // 也没有被静默降级成"装好了但没端口"：服务没有被发布。
    assert.equal(r.stderr.includes('ENFORCEMENT-ROOT-SERVICE present'), false, r.stderr)
  })

  guarded('H. ★★★ 行序与 `--patch` 顺序**都反过来**：F 的读数一字不变', async () => {
    // F 证明"装上了"，但它单独说明不了"为什么"。这一条把同一份补丁层的两行置换、
    // 并把喂给 `--patch` 的层序整条倒过来，读数必须与 F 一样。
    //
    // ⚠️ 要说清这条的**分量**：只跑一个反序**证明不了**顺序无关性。它排除的是
    //    "这条接线只在某一个具体顺序下才装上"；真正的理由在别处——注册住在 root 行
    //    自己的模块图里，而 ESM 保证"被 import 的模块先求值完"。那条理由的读数是一个
    //    2×2 矩阵（补丁层第二行 vs 同模块图 × 注册前挂不挂起），在真 DSH 进程里量过，
    //    见 `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §10。
    //    这里不再复制那份矩阵：跑满它要 24 个真进程，作为回归门槛太重。
    const onDisk = readFileSync(REAL_PATCH, 'utf8').replace(/\r\n/g, '\n')
    // ★ 置换件必须自带**锚定后的**模块名。DSH 的 `anchorInsertedPluginNames` 把
    //   `./` / `../` 开头的 name 按 **patch 文件自己所在目录** 解析成 file:// URL
    //   （`packages/boot/app-boot/src/index.ts:326-336`），所以把同一份 YAML 挪到
    //   scratch 目录里而保留相对 name，它就会去 tmpdir 旁边找 `plugins/` —— 那测的是
    //   "路径解析错了"，而不是行序。这里写的就是 DSH 对真文件会算出的那两个 URL。
    const HARD_FLOOR = '    - id: "legion-enforcement-hard-floor"\n      name: "./plugins/hard-floor.mjs"\n'
    const ROOT_ROW = '    - id: "legion-enforcement-root"\n      name: "../../team-hub/approval-registrar-row.mjs"\n'
    const REGISTRAR_ABS = resolve(COMPOSITION, '..', '..', 'team-hub', 'approval-registrar-row.mjs')
    const HARD_FLOOR_ABS = `    - id: "legion-enforcement-hard-floor"\n      name: ${JSON.stringify(join(COMPOSITION, 'plugins', 'hard-floor.mjs'))}\n`
    const ROOT_ROW_ABS = `    - id: "legion-enforcement-root"\n      name: ${JSON.stringify(REGISTRAR_ABS)}\n`
    const permuted = onDisk.replace(`${HARD_FLOOR}${ROOT_ROW}`, `${ROOT_ROW_ABS}${HARD_FLOOR_ABS}`)
    // ★ 置换必须**真的发生**了。否则这条用例只是在同一个顺序上又跑了一遍，
    //   而"顺序无关"这句话一个字都没有被验过。
    assert.notEqual(permuted, onDisk, `没能在 ${REAL_PATCH} 里找到那两行去置换——这条用例会退化成重复 F`)
    assert.ok(permuted.includes(ROOT_ROW_ABS) && permuted.includes(HARD_FLOOR_ABS))
    // 置换件指的**仍然是那两个模块文件**（只是顺序换了）。
    assert.ok(existsSync(REGISTRAR_ABS), `${REGISTRAR_ABS} 不存在——真补丁层的注册方模块找不到`)
    assert.ok(existsSync(join(COMPOSITION, 'plugins', 'hard-floor.mjs')))
    const permutedPath = join(SCRATCH, 'prt214rt-permuted-order.patch.yml')
    writeFileSync(permutedPath, permuted)

    const r = runDsh({
      tag: 'h',
      // F 的层序是 [services, REAL, runtimeRows, probe, waterfall]；这里逐项倒过来。
      patches: [
        SCRATCH_PATH.waterfallPatch,
        SCRATCH_PATH.probePatch,
        SCRATCH_PATH.runtimeRowsPatch,
        permutedPath,
        SCRATCH_PATH.servicesPatch,
      ],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `顺序反过来就装不上了——那说明这条接线依赖行序：\n${r.stderr}`)
    assert.match(r.stderr, /^APPROVAL-PORT-FACTORY registered$/m, r.stderr)
    assert.match(r.stderr, /^ENFORCEMENT-ROOT-SERVICE present$/m, r.stderr)
    assert.equal(r.stderr.includes(ROOT_ROW_CODES.NO_APPROVAL_PORT_FACTORY), false, r.stderr)
    for (const row of ['pre-execute-row.mjs', 'approval-answerer-row.mjs']) {
      assert.match(r.stderr, new RegExp(`MOUNT \\{[^}]*${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*"fiberState":2\\}`),
        `${row} 在置换后的顺序下不是 ACTIVE：\n${r.stderr}`)
    }
    assert.match(r.stderr, /^GATE-DENIED$/m, r.stderr)
  })

  guarded('I. ★★★ PRT-214 收口：**不挂那两行补丁条目**，瀑布上仍然有人认领', async () => {
    // 与 D / F 的唯一区别：**不放** `runtimeRowsPatch`。D / F 证明的是"补丁条目在场时
    // 整条链通"；这一条证明的是本批补的那一截——`mount()` 有了生产调用方之后，
    // 两行 enforcement 由**组合根那一行自己在进程内挂**，不再依赖它们是补丁条目。
    //
    // 这是"挂载真的发生了"的**行为**读数（不是"文件里有这个 import"）：
    // 瀑布被认领并 deny。
    //
    // ⚠️ 诚实边界两条，都必须一起读：
    //   ① 这一条**不**说明"强制面已生效"：`legion-host.patch.yml` 里仍然没有那两行，
    //      所以 `reconcilePatchLayer()` 照旧报 `ROW_MISSING`、启动自检照旧拒绝注册
    //      （`runtime-host-row*.test.mjs` 那些套件量的就是那一件事）。这里量的是
    //      "两行 listener 在真进程里真的挂上了"，是**前一步**。
    //   ② `MOUNT` dump 里**不会**出现那两个模块名——它们不是 loader 条目。
    //      所以下面显式断言"dump 里没有它们"，免得下一个人把这条读数读成 D 的重复。
    const r = runDsh({
      tag: 'i',
      patches: [
        SCRATCH_PATH.servicesPatch,
        SCRATCH_PATH.rootRowWrapperPatch,
        SCRATCH_PATH.probePatch,
        SCRATCH_PATH.waterfallPatch,
      ],
      legionEnv: true,
    })

    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `期望装配成功：\n${r.stderr}`)
    assert.match(r.stderr, /^ENFORCEMENT-ROOT-SERVICE present$/m, r.stderr)
    // ★ 本批的核心读数：没有那两行补丁条目，瀑布上仍然有人认领。
    assert.match(r.stderr, /^GATE-DENIED$/m, r.stderr)
    assert.equal(r.stderr.includes('GATE-NOT-BOUND'), false,
      `两行没有挂上——\`mount()\` 仍然没有生产调用方：\n${r.stderr}`)
    // 反向控制：确实没有那两行补丁条目（否则这一条与 D 就是同一个读数）。
    for (const row of ['pre-execute-row.mjs', 'approval-answerer-row.mjs']) {
      assert.equal(r.stderr.includes(`MOUNT `) && new RegExp(`MOUNT \\{[^}]*${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(r.stderr), false,
        `${row} 竟然在 loader 树里——这一条就退化成 D 的重复了：\n${r.stderr}`)
    }
  })
})

if (SKIP !== false) {
  test('PRT-214 真 DSH 进程那几条本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}
