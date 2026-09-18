// product/launcher/dsh-overlay.test.mjs
// ============================================================================
// PRT-257 / PRT-214：DSH 强制面覆盖层的**接线**判据。
//
// ## 这一套守的是"有没有接上"，不是"算得对不对"
//
// `patch-loadable.test.mjs` 已经证明了那份 YAML 能被 DSH 读懂；
// `enforcement-plugin.test.mjs` 已经证明了 hard-floor 插件能拦住工具调用。
// 两层都绿，而**没有任何一个 DSH 进程收到过这份补丁**——因为 Launcher 拼
// `runtime` 命令行时从没往里放过 `--patch`。
//
//   > 一个"写好了、也验证过能被加载"的补丁层，
//   > 与一个"从未被交给任何进程"的补丁层，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 所以本套件里最要紧的一条是"**argv 里到底有没有那两个词**"，
// 以及"文件不在时到底拦不拦启动"。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DSH_OVERLAY_CODES,
  DSH_OVERLAY_FLAG,
  DSH_OVERLAY_PROCESS_KEY,
  DSH_OVERLAY_RELPATH,
  DSH_OVERLAY_VERSION,
  overlayArgsFor,
  overlayRelpathOf,
  resolveDshOverlay,
} from './dsh-overlay.mjs'
import { createLauncher } from './launcher.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { resolveLayout } from '../paths.mjs'
import { PATCH_YAML_PATH } from '../../runtime/dsh-composition/render.mjs'

// ★ 检出用**共享解析器**找（理由见下面 DSH 侧那段）。
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

const REPO_ROOT = resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** 合法但独立的布局。`installDir` 可覆写成"没有补丁层"的目录。 */
function layoutIn(root, overrides = {}) {
  const { layout } = resolveLayout({
    installDir: REPO_ROOT,
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
    ...overrides,
  })
  return layout
}

/**
 * 只拉 runtime 的 Launcher（其余进程的入口在临时目录里解析不出来）。
 *
 * ⚠️ `reserveEphemeralPort()` 是**异步**的。第一版直接写
 * `ports: { runtime: reserveEphemeralPort() }`，塞进去的是一个 Promise，
 * 于是 `Number(Promise)` 是 `NaN` → `PORT_OUT_OF_RANGE`。
 * 那三条用例于是红在端口上，看起来像"覆盖层的接线坏了"。
 *
 *   > 一个"把 Promise 当端口传"的夹具，
 *   > 与一个"端口真的是非法值"的部署，在诊断里长得一模一样。
 */
async function runtimeLauncher(root, opts = {}) {
  const port = opts.port ?? await reserveEphemeralPort()
  return createLauncher({
    layout: opts.layout ?? layoutIn(root),
    include: ['runtime'],
    runtimeCommand: 'dsh --profile web',
    ...opts.extra,
    ports: { runtime: port, ...(opts.extra?.ports ?? {}) },
  })
}

const codesOf = (ds) => ds.map((d) => d.code)
const byCode = (ds, code) => ds.filter((d) => d.code === code)

// ── DSH 侧（可 SKIP） ────────────────────────────────────────────────────
// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`）。此前手写
//   `process.env.DSH_CHECKOUT ?? null`——而这份文件自己的 `★★★★★`
//   就是被那套口径漏掉了**四天**（见 §10.12）。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const DSH_BIN = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const DSH_SKIP = DSH === null ? DSH_FOUND.reason : false

/**
 * 逐条 SKIP，而不是整组 `describe({skip})`：`describe` 级的 skip 不把里面的
 * 用例计进 `skipped`，于是"这一套被跳过了"与"根本没有这一套"在 CI 读数上
 * 长得一模一样。
 */
const guardedDsh = (name, fn) => test(name, async (t) => {
  if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
  return fn(t)
})

describe('PRT-257 DSH 强制面覆盖层：解析', () => {
  test('★★★ 默认**装上**：args 是 `--patch <绝对路径>`，且指向真的补丁文件', () => {
    const o = resolveDshOverlay({ installDir: REPO_ROOT })
    assert.equal(o.ok, true)
    assert.equal(o.enabled, true)
    assert.equal(o.version, DSH_OVERLAY_VERSION)
    assert.deepEqual([...o.args], [DSH_OVERLAY_FLAG, o.path])
    assert.equal(o.args[0], '--patch')
    // 绝对路径：`--patch` 由 DSH 解析，而 DSH 的 cwd 是安装目录——
    // 传相对路径会在 cwd 不同时指向另一个文件（或找不到）。
    assert.ok(o.path.startsWith(resolve(REPO_ROOT)) || /^[A-Za-z]:[\\/]/.test(o.path),
      `覆盖层路径不是绝对路径：${o.path}`)
    assert.equal(existsSync(o.path), true, `覆盖层文件不存在：${o.path}`)
    assert.deepEqual([...o.diagnostics], [], '正常情况下不该有任何诊断')
  })

  test('★★★ 相对路径**不漂移**：与 render.mjs 的 PATCH_YAML_PATH 是同一个文件', () => {
    // 这里刻意用了字面量而不是 import（避免把生成器的整条依赖拖进 Launcher），
    // 代价是两处可能漂移——所以要有这一条钉住。
    assert.equal(DSH_OVERLAY_RELPATH, PATCH_YAML_PATH)
    assert.equal(DSH_OVERLAY_RELPATH, 'runtime/dsh-composition/legion-host.patch.yml')
  })

  test('★★★ 补丁文件不在 → **阻塞**，且**不**给出 args', () => {
    const missing = join(REPO_ROOT, '__definitely-not-here__')
    const o = resolveDshOverlay({ installDir: missing })
    assert.equal(o.ok, false, '被要求装上却没装上，不能算 ok')
    assert.deepEqual([...o.args], [],
      '文件不在时绝不能给出 --patch —— 那会让 DSH 在启动时自己报一个不提"补丁层"的错')
    const errs = byCode(o.diagnostics, DSH_OVERLAY_CODES.PATCH_FILE_MISSING)
    assert.equal(errs.length, 1)
    assert.equal(errs[0].severity, 'error')
    assert.equal(errs[0].process, DSH_OVERLAY_PROCESS_KEY)
    assert.ok(o.path.endsWith('legion-host.patch.yml'), '即便缺失也要报出**找过哪个路径**')
  })

  test('★★★ 显式关掉 → 不阻塞、**没有** args、但留下一条能被看见的 warn', () => {
    const o = resolveDshOverlay({ installDir: REPO_ROOT, enabled: false })
    assert.equal(o.ok, true, '关掉是一个被允许的决定')
    assert.equal(o.enabled, false)
    assert.deepEqual([...o.args], [])
    const w = byCode(o.diagnostics, DSH_OVERLAY_CODES.DISABLED_BY_CONFIG)
    assert.equal(w.length, 1, '关掉必须有记录：静默关掉与"从未打算装"看起来是一样的')
    assert.equal(w[0].severity, 'warn')
    // 文案必须写清**怎么开回来**——一个让人猜不到怎么恢复的门禁最后会被人绕过。
    assert.match(w[0].message, /runtime\.enforcementOverlay/)
    assert.match(w[0].message, /true/)
  })

  test('★★★ 判序：关掉时**不**报"文件不在"（那是错的诊断）', () => {
    // 反过来的话，一个"故意不装、而且本来也没这文件"的部署会同时收到
    // "你没装"和"文件找不到"两条，而后者会让人去查安装完整性——
    // 真因是用户自己关掉了。**错的诊断比没有诊断更坏。**
    const missing = join(REPO_ROOT, '__definitely-not-here__')
    const o = resolveDshOverlay({ installDir: missing, enabled: false })
    assert.equal(codesOf(o.diagnostics).includes(DSH_OVERLAY_CODES.PATCH_FILE_MISSING), false)
    assert.deepEqual(codesOf(o.diagnostics), [DSH_OVERLAY_CODES.DISABLED_BY_CONFIG])
  })

  test('★★ 没有安装目录 → 阻塞（无从定位，且这一层是被要求装上的）', () => {
    for (const dir of [null, undefined, '', '   ']) {
      const o = resolveDshOverlay({ installDir: dir })
      assert.equal(o.ok, false, `installDir=${JSON.stringify(dir)} 没被拦下`)
      assert.deepEqual([...o.args], [])
      assert.equal(byCode(o.diagnostics, DSH_OVERLAY_CODES.NO_INSTALL_DIR).length, 1)
    }
  })

  test('★★ 路径存在但不是普通文件 → 阻塞', () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-ovl-'))
    try {
      // 把 relpath 造成一个**目录**：最可能的写错方式
      const dir = join(root, ...DSH_OVERLAY_RELPATH.split('/'))
      mkdirSync(dir, { recursive: true })
      const o = resolveDshOverlay({ installDir: root })
      assert.equal(o.ok, false)
      assert.deepEqual([...o.args], [])
      const e = byCode(o.diagnostics, DSH_OVERLAY_CODES.PATCH_FILE_NOT_A_FILE)
      assert.equal(e.length, 1)
      assert.equal(e[0].severity, 'error')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 诊断的 `process` 键是 runtime（否则范围排除时降不了级）', () => {
    // Launcher 那段"被范围排除的进程降级为 warn"是按 `d.process` 过滤的。
    // process 写错 → 一条本该降级的 error 仍然阻塞一次**根本没启动 runtime** 的启动。
    for (const o of [
      resolveDshOverlay({ installDir: REPO_ROOT, enabled: false }),
      resolveDshOverlay({ installDir: join(REPO_ROOT, '__nope__') }),
      resolveDshOverlay({ installDir: null }),
    ]) {
      for (const d of o.diagnostics) assert.equal(d.process, 'runtime')
    }
  })

  test('★★ overlayArgsFor 对垃圾输入返回空数组（不抛）', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { args: null }, { args: 'x' }]) {
      assert.deepEqual([...overlayArgsFor(bad)], [])
    }
    const o = resolveDshOverlay({ installDir: REPO_ROOT })
    const a = overlayArgsFor(o)
    assert.deepEqual([...a], [...o.args])
    assert.notEqual(a, o.args, '应当返回副本：调用方改它不该影响解析结果')
  })

  test('★★ overlayRelpathOf：安装目录内的路径显示成相对形式', () => {
    const o = resolveDshOverlay({ installDir: REPO_ROOT })
    assert.equal(overlayRelpathOf(REPO_ROOT, o.path), DSH_OVERLAY_RELPATH)
    assert.equal(overlayRelpathOf(REPO_ROOT, join(REPO_ROOT, 'a', 'b.yml')), 'a/b.yml')
    assert.equal(overlayRelpathOf('/other', o.path), o.path, '安装目录之外就原样返回')
    assert.equal(overlayRelpathOf(null, o.path), null)
  })
})

describe('PRT-257 DSH 强制面覆盖层：接进 Launcher', () => {
  test('★★★ runtime 进程的 argv 里**真的有** `--patch <补丁层>`', async () => {
    // 本套件的要害。把 `extraArgs` 那一行删掉时，**只有这一条会红**——
    // 因为其余每一条都在测 `resolveDshOverlay` 自己算得对不对，
    // 而它算得再对，没人把结果交给进程也等于零。
    const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
    try {
      const L = await runtimeLauncher(root)
      const rt = L.plan.processes.find((p) => p.key === 'runtime')
      assert.ok(rt !== undefined)
      const args = [...rt.command.args]
      const i = args.indexOf(DSH_OVERLAY_FLAG)
      assert.notEqual(i, -1, `runtime argv 里没有 --patch：${JSON.stringify(args)}`)
      const next = args[i + 1]
      assert.equal(next, L.enforcementOverlay.path)
      assert.equal(existsSync(next), true)
      // `--patch` 必须在 `runtime.command` 自己的参数**之后**（extraArgs 的语义）
      assert.ok(args.indexOf('--profile') < i, '--patch 跑到了 runtime.command 前面')
      // 而且这一层只给 runtime，别的进程不该有
      for (const p of L.plan.processes) {
        if (p.key === 'runtime' || p.command === null) continue
        assert.ok(!p.command.args.includes(DSH_OVERLAY_FLAG),
          `进程 ${p.key} 也被塞了 --patch —— 只有 DSH Runtime 吃这个参数`)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 补丁层缺失 → `preflight()` **拒绝启动**（fail closed）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
    try {
      const L = await runtimeLauncher(root, {
        layout: layoutIn(root, { installDir: join(root, 'no-安装') }),
      })
      assert.equal(L.enforcementOverlay.ok, false)
      const pre = await L.preflight()
      assert.equal(pre.ok, false, '没有强制面的运行时不能算通过预检')
      assert.equal(pre.phase, 'plan')
      assert.ok(codesOf(pre.diagnostics).includes(DSH_OVERLAY_CODES.PATCH_FILE_MISSING))
      // 关键：**没有**把 --patch 交给进程
      const rt = L.plan.processes.find((p) => p.key === 'runtime')
      assert.ok(!rt.command.args.includes(DSH_OVERLAY_FLAG))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 显式关掉 → 预检照常通过，但 warn 留在诊断里', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
    try {
      const L = await runtimeLauncher(root, {
        extra: { enforcementOverlay: false },
      })
      const rt = L.plan.processes.find((p) => p.key === 'runtime')
      assert.ok(!rt.command.args.includes(DSH_OVERLAY_FLAG), '关掉了就不该有 --patch')
      const pre = await L.preflight()
      assert.equal(pre.ok, true, `关掉是一个被允许的决定：${JSON.stringify(codesOf(pre.diagnostics))}`)
      assert.equal(byCode(L.diagnostics, DSH_OVERLAY_CODES.DISABLED_BY_CONFIG).length, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★★ 范围不含 runtime 时，覆盖层缺失降级为 warn（不阻塞）', async () => {
    // 这一条验的是诊断的 `process` 接对了：一次 `--include team-hub` 的启动
    // 本来就不拉 runtime，不该因为"强制面没装上"而起不来。
    //
    // 用 `include: []`（什么都不拉）而不是 `['team-hub']`：那样才不需要为
    // team-hub 的入口与端口准备夹具，测的仍然**恰好**是降级那一段逻辑。
    // 一个为了测"降级"而顺带依赖"某个进程的入口存在"的用例，
    // 会在入口布局变化时红，而它红的理由与降级无关。
    const root = mkdtempSync(join(tmpdir(), 'legion-lz-'))
    try {
      const L = createLauncher({
        layout: layoutIn(root, { installDir: join(root, 'no-安装') }),
        include: [],
        runtimeCommand: 'dsh --profile web',
      })
      // 前提：这一层确实报错了（否则下面测的是别的东西）。
      // ★ 读的是 `enforcementOverlay.diagnostics`（**降级前**的原始读数），
      //   不是 `L.diagnostics`——后者已经过范围过滤，`include: []` 时
      //   那条 error 已经被换码成 `PROCESS_EXCLUDED_BY_SCOPE` 了。
      //   第一版断言的是后者，于是"前提"本身永远不成立。
      assert.equal(L.enforcementOverlay.ok, false)
      assert.equal(byCode(L.enforcementOverlay.diagnostics, DSH_OVERLAY_CODES.PATCH_FILE_MISSING).length, 1)
      assert.equal(byCode(L.diagnostics, DSH_OVERLAY_CODES.PATCH_FILE_MISSING).length, 0,
        'include: [] 时原始码不该还留在面向用户的诊断里')

      const pre = await L.preflight()
      assert.equal(pre.ok, true,
        `没启动 runtime 的受限启动被覆盖层诊断挡住了：${JSON.stringify(codesOf(pre.diagnostics))}`)
      const downgraded = byCode(pre.diagnostics, 'PROCESS_EXCLUDED_BY_SCOPE')
      assert.ok(downgraded.some((d) => d.excludedCode === DSH_OVERLAY_CODES.PATCH_FILE_MISSING),
        '降级是发生了，但换码后的诊断没有说明它替换掉了哪一条')
      // 降级后仍然是 warn（不是被悄悄丢掉）
      for (const d of downgraded) assert.equal(d.severity, 'warn')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('★★ 配置键 `runtime.enforcementOverlay` 真的改得动这件事', async () => {
    // 端到端：配置文件 → launcherInputFromConfig → cli → createLauncher。
    const { launcherInputFromConfig } = await import('../config.mjs')
    for (const [value, expected] of [[false, false], [true, true]]) {
      const out = launcherInputFromConfig({ value: { runtime: { enforcementOverlay: value } }, layers: [] })
      assert.equal(out.enforcementOverlay, expected)
    }
    // 没写 → 不给键（由默认参数落地，避免两份默认值）
    const none = launcherInputFromConfig({ value: { runtime: {} }, layers: [] })
    assert.equal('enforcementOverlay' in none, false)
  })
})

// ── 真 DSH：这一层真的进得了组合树吗 ────────────────────────────────────
describe('PRT-257 DSH 强制面覆盖层：真 DSH 管线', () => {
  guardedDsh('★★★★★ 用 Launcher 拼出的 argv，真 DSH CLI 接受并把行装进组合树', async (t) => {
    // 这是"接上了"的**唯一**直接证据：不是我们算出了 argv，而是**别人吃下了它**。
    const home = mkdtempSync(join(tmpdir(), 'legion-dshhome-'))
    try {
      const prof = join(home, 'profiles', 'legiontest')
      mkdirSync(prof, { recursive: true })
      writeFileSync(join(prof, 'cordis.yml'), '# 空的入口表\n[]\n', 'utf8')
      writeFileSync(join(prof, 'package.json'), JSON.stringify({
        name: 'dsh-profile-legiontest', private: true, dsh: { profile: { bundles: [] } },
      }, null, 2), 'utf8')

      const L = createLauncher({
        layout: layoutIn(join(home, 'legionhome')),
        include: ['runtime'],
        // ★ 必须用**生产形状**：`runtime.command` 自带模式与 profile，
        //   `extraArgs` 追加在**它之后** → `dsh --profile X --patch P`。
        //
        //   第一版这里写的是 `runtimeCommand: DSH_BIN`（裸二进制），
        //   于是 argv 变成 `dsh --patch P --profile X`——顺序反了，
        //   DSH 直接报错。那**不是**实现的缺陷：`materializeProcessPlan` 的
        //   `extraArgs` 语义本来就是"追加在配置好的命令之后"，生产里的
        //   `runtime.command` 也不会是一个裸二进制。
        //
        //   > 一个"把覆盖层放在二进制紧后面"的夹具，
        //   > 与一个"用户把 runtime.command 配错了"的部署，报的是同一个错——
        //   > 只不过前者会让用例去改一个本来正确的实现。
        runtimeCommand: { file: process.execPath, args: [DSH_BIN, '--profile', 'legiontest'] },
        ports: { runtime: await reserveEphemeralPort() },
      })
      const rt = L.plan.processes.find((p) => p.key === 'runtime')
      // ══════════════════════════════════════════════════════════════════════
      // ★★★ `--dump-config` **必须**插在 app 段之前，不能追加在 argv 末尾
      // ══════════════════════════════════════════════════════════════════════
      //
      // DSH 的根部命令用了 `.passThroughOptions()` + `[args...]`
      // （`apps/cli/src/args.ts:142`），语义是：
      //
      //   > 一旦遇到第一个不认识的 token，**从那里往后全都归 app**。
      //
      // 而 `--profile` / `--patch` / `--dump-config` 是**根**选项，
      // `--host` / `--port` / `--no-open` 是 **app** 选项。Launcher 现在的 argv
      // 末尾就带着 app 段（`process-manifest.mjs`：`[…args, …extras, …appArgs]`），
      // 于是 `[…rt.command.args, '--dump-config']` 拼出来的是：
      //
      //     dsh --profile legiontest --patch P --host 127.0.0.1 --port N --no-open --dump-config
      //                                                            ↑ app 段从这里开始
      //                                                                ↑ 于是这个也归 app
      //
      // 结果是 DSH **根本没进 dump-config 模式**，它会去启动 web app、绑端口、然后
      // 一直不退出 —— 实测表现是 `spawnSync ETIMEDOUT` / 120s 后被杀。
      //
      // ★ 这条不是"夹具写错了所以改夹具"这么轻：它正是 `f291f9c` 那批
      //   在**产品代码**里逐字论证过的同一件事的反面。那批的注释写着：
      //
      //   > 把 `--port` 放进 `argsTemplate` 会拼出 `… --port 3081 --patch X`，
      //   > 其中 **`--patch X` 落进了 app 段**：DSH 照常启动、照常绑 3081、
      //   > 照常打印 URL——**强制面补丁层静默消失**。
      //
      //   产品侧把 `--port` 挪到最后解决了它；而**夹具**从那一刻起就踩在
      //   同一个坑的另一侧：它把自己的根选项插到了 app 段后面。
      //
      //   > 一个"产品把根选项和 app 选项的顺序搞对了、
      //   > 而夹具把自己的根选项插错了段"的用例，红起来的样子
      //   > 与"产品把覆盖层弄丢了"**完全一样**（都是启动不起来 / 行没进树）——
      //   > 只不过前者要改的是用例，后者要改的是实现。
      //
      // 所以这里分两步：① 在**生产 argv 上**断言两段的顺序；② 把 app 段摘掉之后
      // 再追加 `--dump-config`（见下面 `dumpArgs` 那段）。
      const args = [...rt.command.args]
      // 顺序断言：`--patch` 在 `--profile` **之后**
      assert.ok(args.indexOf('--profile') < args.indexOf(DSH_OVERLAY_FLAG),
        `--patch 跑到 runtime.command 前面去了：${JSON.stringify(args)}`)

      // ★★ 不变式：**所有根选项都在所有 app 选项之前**。
      //   这条是"覆盖层不会静默消失"的机器判据——DSH 一旦进了 app 段，
      //   后面再出现 `--patch` 也不会被当成根选项，而**启动照样成功**。
      //   本仓的 app 族旗标是 `--host` / `--port` / `--no-open`
      //   （`process-manifest.mjs` 的 `hostArgv` / `portArgv` / `boolArgv`）。
      const APP_VALUE_FLAGS = ['--host', '--port']
      const APP_BOOL_FLAGS = ['--no-open']
      const firstApp = [...APP_VALUE_FLAGS, ...APP_BOOL_FLAGS]
        .map((f) => args.indexOf(f))
        .filter((i) => i >= 0)
        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
      const lastRoot = [DSH_OVERLAY_FLAG, '--profile']
        .map((f) => args.indexOf(f))
        .filter((i) => i >= 0)
        .reduce((a, b) => Math.max(a, b), -1)
      assert.ok(Number.isFinite(firstApp),
        `生产 argv 里一个 app 族旗标都没有，这条不变式今天没有对象：${JSON.stringify(args)}`)
      assert.ok(lastRoot < firstApp,
        `根选项出现在 app 段之后：argv=${JSON.stringify(args)}。`
        + 'DSH 用 `passThroughOptions()`，app 段一旦开始，后面的根选项（含 `--patch`）'
        + '会被当成 app 参数 ⇒ 强制面覆盖层**静默消失**而启动成功。')

      // ══════════════════════════════════════════════════════════════════════
      // ★★★ 为什么必须**摘掉** app 段，而不是把 `--dump-config` 挪个位置
      // ══════════════════════════════════════════════════════════════════════
      //
      // 把 `--dump-config` 插到 app 段之前之后，DSH 报的是：
      //
      //     error: config dumps take no app arguments,
      //            got "--host" "127.0.0.1" "--port" "51718" "--no-open"
      //
      // 也就是说 `--dump-config` 与 app 参数**语义上互斥**——它不是"位置没放对"，
      // 而是"这两件事不能同时要求"。于是夹具只能二选一：
      //
      //   · 要 dump（根选项那条链成不成立）      ⇒ 不能带 app 段；
      //   · 要 app 段（端口/地址/不弹浏览器）    ⇒ 不能 dump。
      //
      // 本用例要证的是**前者**：「Launcher 拼出的 argv 被真 DSH 接受，并且
      // Legion 的行真的进了组合树」。app 段的位置由上面那条不变式盯着，
      // 不需要靠这一条来证。
      //
      //   > 一个"把 app 段留在 dump 命令里"的夹具，
      //   > 与一个"app 段多了一个非法旗标"的部署，报的是同一条 DSH 错误——
      //   > 只不过前者要改的是用例，后者要改的是清单。
      const dumpArgs = []
      for (let i = 0; i < args.length; i++) {
        if (APP_BOOL_FLAGS.includes(args[i])) continue
        if (APP_VALUE_FLAGS.includes(args[i])) { i++; continue }
        dumpArgs.push(args[i])
      }
      assert.ok(APP_VALUE_FLAGS.some((f) => args.includes(f)),
        `生产 argv 里没有端口旗标，这条用例就没有证明"app 段被摘掉了"：${JSON.stringify(args)}`)
      assert.equal(dumpArgs.some((a) => APP_VALUE_FLAGS.includes(a) || APP_BOOL_FLAGS.includes(a)), false,
        'app 族旗标没被摘干净')
      // 摘掉之后仍然是**根选项那一段**原样：`--profile` 与 `--patch` 都在
      assert.ok(dumpArgs.includes('--profile') && dumpArgs.includes(DSH_OVERLAY_FLAG),
        `摘掉 app 段后根选项不该消失：${JSON.stringify(dumpArgs)}`)

      const out = execFileSync(process.execPath, [...dumpArgs, '--dump-config'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: home },
        timeout: 120_000,
      })

      // ① Legion 的行进了树
      assert.match(out, /legion-enforcement-hard-floor/,
        'Launcher 拼出的 argv 没能把 Legion 的行装进组合树')
      // ② 相对模块名被 DSH **锚定**成 file:// URL（相对谁？补丁文件所在目录）
      const m = out.match(/file:\/\/\/[^"'\s]*plugins\/hard-floor\.mjs/)
      assert.ok(m !== null, '相对模块名没有被解析成 file:// URL')
      assert.equal(decodeURIComponent(new URL(m[0]).pathname.replace(/^\//, '')).replace(/\//g, '\\').toLowerCase(),
        join(REPO_ROOT, 'runtime', 'dsh-composition', 'plugins', 'hard-floor.mjs').toLowerCase())
      // ③ 那个模块真的有一个默认导出（补丁 row 靠它加载）
      assert.equal(typeof L.enforcementOverlay.path, 'string')
      const patchText = readFileSync(L.enforcementOverlay.path, 'utf8')
      assert.match(patchText, /hard-floor\.mjs/)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  guardedDsh('★★★★ 覆盖层文件**真的**被 DSH 当成顶层数组读进去（不是被忽略）', (t) => {
    const home = mkdtempSync(join(tmpdir(), 'legion-dshhome-'))
    try {
      const prof = join(home, 'profiles', 'legiontest')
      mkdirSync(prof, { recursive: true })
      writeFileSync(join(prof, 'cordis.yml'), '# 空\n[]\n', 'utf8')
      writeFileSync(join(prof, 'package.json'), JSON.stringify({
        name: 'dsh-profile-legiontest', private: true, dsh: { profile: { bundles: [] } },
      }, null, 2), 'utf8')

      const overlay = resolveDshOverlay({ installDir: REPO_ROOT })
      const run = (extra) => {
        try {
          return { out: execFileSync(process.execPath,
            [DSH_BIN, '--profile', 'legiontest', ...extra, '--dump-config'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home }, timeout: 120_000 }), code: 0 }
        } catch (e) { return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 } }
      }
      const without = run([])
      const with_ = run([...overlay.args])
      assert.equal(with_.code, 0, `DSH 拒绝了我们的 --patch：${with_.out.slice(-400)}`)
      assert.equal(/legion-enforcement/.test(without.out), false, '不带 --patch 时不该有 Legion 的行')
      assert.equal(/legion-enforcement/.test(with_.out), true, '带了 --patch 却没有 Legion 的行')

      // 对照：指向一个**不存在**的文件，DSH 必须自己报错——
      // 证明"exit 0"不是因为 DSH 悄悄忽略了那个参数。
      const bogus = run([DSH_OVERLAY_FLAG, join(home, '不存在.yml')])
      assert.notEqual(bogus.code, 0, 'DSH 对不存在的 overlay 竟然不报错——那说明 exit 0 什么也没证明')
      assert.match(bogus.out, /overlay|patch/i)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
