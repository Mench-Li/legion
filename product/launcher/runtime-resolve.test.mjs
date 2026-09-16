// product/launcher/runtime-resolve.test.mjs
// ============================================================================
// PRT-257：**装完之后的下一跳**（`runtime-resolve.mjs`）。
//
// 这一套守的是一句话：
//
//   > Launcher 从 `current.json` **推导**出 runtime 命令，
//   > 而不是等着别人把 `--runtime-command` 塞进来。
//
// 为什么这句话必须由一套用例来守：在接线之前，"装得上"那一半有 44 条用例，
// "起得来"那一半有 100+ 条，两边都是绿的——而**"装完之后谁去用它"这件事
// 在两个文件里一次都没有出现过**。一个没有任何调用方的能力，
// 与一个不存在的能力，在部署上是同一个东西。
//
// 所以本套件刻意分三层：
//   ① 纯读数：`resolveRuntimeCommand()` 在**真的装过一遍**的磁盘上读什么
//      （不是手写的 `current.json`——手写的会同时定义"指针长什么样"与
//      "解析器读什么"，两边一起错也照样绿）；
//   ② 接线：`createLauncher()` 在 `runtimeCommand === null` 时真的把它用上，
//      并断言一路走到 `spawnImpl`（进程边界是唯一没法自证的地方）；
//   ③ 看起来对但是错的那些命令：少了 `--profile`、入口被改到另一个**也存在于
//      磁盘上的**文件、指针读不懂——每一种都必须拒绝，而不是产出一条"每个字都对"的命令。
// ============================================================================
import { after, afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveLayout } from '../paths.mjs'
import { reserveEphemeralPort } from './ports.mjs'
import { createLauncher } from './launcher.mjs'
import {
  DEFAULT_DSH_PROFILE,
  RUNTIME_RESOLVE_CODES,
  RUNTIME_RESOLVE_DIAG_CODES,
  resolveRuntimeCommand,
  resolveRuntimeForLaunch,
  runtimeCommandIsGiven,
  runtimeResolveNextStepOf,
} from './runtime-resolve.mjs'
import {
  LEGION_FILE_PACKAGES,
  NODE_MODULES_DIRNAME,
  planRuntimeInstall,
  installRuntime,
  readActiveRuntime,
  runtimePathsOf,
} from './runtime-install.mjs'
import { satisfiesRange } from '../../runtime/packs/manifest.mjs'

// ---------------------------------------------------------------- 临时目录

const TEMP_ROOTS = []

function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-prt257-resolve-${tag}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function sweepTempRoots() {
  while (TEMP_ROOTS.length > 0) {
    const dir = TEMP_ROOTS.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力而为；不清会留孤儿目录 */ }
  }
}

// 两层清理：一次失败不留孤儿，用例文件被打断也一样。
afterEach(sweepTempRoots)
after(sweepTempRoots)

const DSH_VERSION = '0.1.5-rc.2'
const NEXT_VERSION = '0.1.6'
const PATCH_VERSION = 1
const BINDINGS = Object.freeze([
  Object.freeze({ dshVersion: DSH_VERSION, compositionPatchVersion: PATCH_VERSION }),
  Object.freeze({ dshVersion: NEXT_VERSION, compositionPatchVersion: PATCH_VERSION }),
])
const rangeSatisfied = (version, range) => {
  try { return satisfiesRange(version, range) } catch { return null }
}

/** 一套"像真的"目录：DataDir / InstallDir（含四个 Legion 包与补丁层）/ DSH 家目录。 */
function fixture(tag, { withPatchLayer = true } = {}) {
  const root = tempRoot(tag)
  const dataDir = join(root, 'Legion', 'data')
  const installDir = join(root, 'Legion', 'install')
  const dshHome = join(root, 'dsh-home')
  const operatorHome = join(root, 'operator-home')
  const shippedPresetRoot = join(dshHome, 'profiles')
  for (const p of LEGION_FILE_PACKAGES) mkdirSync(join(installDir, p.repoDir), { recursive: true })
  mkdirSync(join(shippedPresetRoot, 'web'), { recursive: true })
  writeFileSync(join(shippedPresetRoot, 'web', 'cordis.yml'), '# DSH shipped preset —— 只读\n[]\n', 'utf8')
  if (withPatchLayer) {
    const patchDir = join(installDir, 'runtime', 'dsh-composition')
    mkdirSync(patchDir, { recursive: true })
    writeFileSync(join(patchDir, 'legion-host.patch.yml'), '# 假的补丁层（用例造的）\n[]\n', 'utf8')
  }
  return { root, dataDir, installDir, dshHome, operatorHome, shippedPresetRoot }
}

/** 假命令运行器：只把请求的那一版写进 `node_modules/<包>/{package.json,lib/bin.js}`。 */
function fakeRunner(version = DSH_VERSION) {
  const calls = []
  const fn = (command, opts) => {
    calls.push({ command, opts })
    const spec = command.args[command.args.length - 1]
    const at = spec.lastIndexOf('@')
    const pkg = spec.slice(0, at)
    const prefix = command.args[command.args.indexOf('--prefix') + 1]
    const dir = join(prefix, NODE_MODULES_DIRNAME, ...pkg.split('/'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }, null, 2), 'utf8')
    writeFileSync(join(dir, 'lib', 'bin.js'), '// 假的 DSH 入口（用例造的，不是真 npm 装的）\n', 'utf8')
    return { ok: true, status: 0, stdout: '', stderr: '', error: null }
  }
  fn.calls = calls
  return fn
}

/**
 * **真的走一遍安装器**（用注入的假运行器，所以不联网），返回现役读数。
 *
 * `runnerVersion` 让"npm 装的不是请求的那一版"这件事可以被构造出来。
 */
function installOnce(f, { targetVersion = DSH_VERSION, runnerVersion = targetVersion } = {}) {
  const plan = planRuntimeInstall({
    dataDir: f.dataDir,
    allowedRoot: f.dataDir,
    installDir: f.installDir,
    dshHome: f.dshHome,
    operatorHome: f.operatorHome,
    shippedPresetRoot: f.shippedPresetRoot,
    targetVersion,
    supportedRange: `=${targetVersion}`,
    rangeSatisfied,
    expectedPatchVersion: PATCH_VERSION,
    patchBindings: BINDINGS,
  })
  assert.equal(plan.ok, true, `安装计划没算出来：${plan.code} ${plan.message}`)
  const res = installRuntime({ plan, runner: fakeRunner(runnerVersion) })
  assert.equal(res.ok, true, `安装没成功：${res.code} ${res.message}`)
  return { plan, res, active: readActiveRuntime({ dataDir: f.dataDir }) }
}

/** Launcher 要的布局：DataDir 与 InstallDir 都在这套临时目录里。 */
function layoutFor(f, root) {
  const { layout } = resolveLayout({
    installDir: f.installDir,
    dataDir: f.dataDir,
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
  })
  return layout
}

/** 一个"一直活着"的假子进程。`pid` 特意取 1：`taskkill` 对它会失败（无害）。 */
function liveFakeChild(pid = 1) {
  const c = new EventEmitter()
  c.pid = pid
  c.exitCode = null
  c.signalCode = null
  c.killed = false
  c.kill = () => { c.killed = true; return true }
  return c
}

/** 三个接缝：不 spawn 真进程、不连网、不 taskkill。 */
function offlineSeams(captured = []) {
  const refused = new Error('fetch failed')
  refused.cause = { code: 'ECONNREFUSED' }
  let t = 0
  return {
    captured,
    opts: {
      spawnImpl: (file, args, opts) => { captured.push({ file, args: [...args], opts }); return liveFakeChild() },
      fetchImpl: async () => { throw refused },
      sleep: async (ms) => { t += ms },
      now: () => t,
      // **绝不**让回滚去 taskkill：假子进程的 pid 在真实进程表里可能真的存在。
      killTreeImpl: async () => true,
    },
  }
}

/**
 * 强制面身份（PRT-214）的三项必填。不给的话 `ENFORCEMENT_IDENTITY_MISSING`
 * 会（正确地）拦下启动——那是**另一条**判据，不该混进本套件要守的那条。
 */
const IDENTITY_ENV = Object.freeze({
  LEGION_ACTOR: 'legion-launcher',
  LEGION_SCOPE: 'legion/product',
  LEGION_ENFORCEMENT_ACTION: 'runtime.boot',
})

// ============================================================================
// ① 纯读数：在**真的装过一遍**的磁盘上，命令是什么
// ============================================================================

describe('PRT-257 现役指针 → runtime 命令（读数）', () => {
  test('★★★★ 装完一遍之后，命令从**指针指的那个目录**里解析出来（不是硬编码）', () => {
    const a = fixture('read-a')
    const b = fixture('read-b', { withPatchLayer: false })
    const ia = installOnce(a)
    const ib = installOnce(b)

    const ra = resolveRuntimeCommand({ dataDir: a.dataDir, profile: 'web' })
    const rb = resolveRuntimeCommand({ dataDir: b.dataDir, profile: 'rescue' })

    assert.equal(ra.ok, true, `${ra.code} ${ra.message}`)
    assert.equal(ra.source, 'installed-pointer')
    assert.deepEqual([...ra.command.args], [ia.active.entryPath, '--profile', 'web'])
    assert.equal(ra.active.version, DSH_VERSION)
    assert.equal(ra.active.patchVersion, PATCH_VERSION)

    // ★ 两个**不同**的数据目录 + 不同 profile ⇒ 两条不同的命令。
    //   一条硬编码在模块里的命令在这条断言下必然红——而"解析出来了"
    //   那一条在硬编码下照样绿。
    assert.notEqual(ra.command.args[0], rb.command.args[0])
    assert.deepEqual([...rb.command.args], [ib.active.entryPath, '--profile', 'rescue'])
    // 命令指向**数据目录里**刚装好的那一份，而不是 PATH 上的哪个 dsh。
    assert.ok(ra.command.args[0].startsWith(a.dataDir), `${ra.command.args[0]} 不在 ${a.dataDir} 下`)
    assert.equal(existsSync(ra.command.args[0]), true)
    assert.equal(ra.command.file, process.execPath)
  })

  test('★★★★ 指针换了版本 ⇒ 命令跟着换（读的是指针，不是一次缓存）', () => {
    const f = fixture('read-version')
    installOnce(f)
    const first = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    installOnce(f, { targetVersion: NEXT_VERSION })
    const second = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    assert.notEqual(first.command.args[0], second.command.args[0])
    assert.equal(second.active.version, NEXT_VERSION)
    assert.ok(second.command.args[0].includes(NEXT_VERSION), `新命令仍指向旧版本：${second.command.args[0]}`)
  })

  test('★★★★★ 少了 profile 就是**拒绝**，不是一条"每个字都对"的短命令', () => {
    const f = fixture('read-profile')
    installOnce(f)
    const entryPath = runtimePathsOf({ dataDir: f.dataDir, targetVersion: DSH_VERSION }).entryPath

    for (const profile of [null, undefined, '', '   ', 42]) {
      const r = resolveRuntimeCommand({ dataDir: f.dataDir, profile })
      assert.equal(r.ok, false, `profile=${JSON.stringify(profile)} 竟然算出了命令`)
      assert.equal(r.code, RUNTIME_RESOLVE_CODES.PROFILE_REQUIRED)
      assert.equal(r.blocking, true)
      assert.equal(r.command, null)
      // 拒绝里必须**说得出真实原因**：这不是"参数忘了"，是 DSH 会退出 1。
      assert.match(r.message, /--profile/)
      assert.match(r.nextStep, /--profile/)
      assert.ok(r.message.includes(entryPath),
        '拒绝里要带上那个**确实存在**的入口路径——它正是"看起来对"的来源')
    }
  })

  test('★★★★ 指针里的 entry 与按目录重算的入口不一致 ⇒ 拒绝，且不挑任何一个用', () => {
    const f = fixture('read-mismatch')
    installOnce(f)
    const pointerPath = join(f.dataDir, 'runtime', 'dsh', 'current.json')
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
    const recomputed = runtimePathsOf({ dataDir: f.dataDir, targetVersion: DSH_VERSION }).entryPath
    // 造一个**真的存在**的第二个候选入口：这是最危险的一种错法——
    // 两个路径都存在、都以 bin.js 结尾，挑错一个的后果是启动**别的**程序。
    const decoy = join(f.dataDir, 'decoy', 'bin.js')
    mkdirSync(join(f.dataDir, 'decoy'), { recursive: true })
    writeFileSync(decoy, '// 另一个也存在、也叫 bin.js 的文件\n', 'utf8')
    writeFileSync(pointerPath, `${JSON.stringify({ ...pointer, entry: decoy }, null, 2)}\n`, 'utf8')

    const r = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    assert.equal(r.ok, false)
    assert.equal(r.code, RUNTIME_RESOLVE_CODES.ENTRY_MISMATCH)
    assert.equal(r.blocking, true)
    assert.equal(r.command, null, '不一致时不许挑一个用')
    assert.ok(r.message.includes(decoy), `拒绝里没带上指针里那个：${r.message}`)
    assert.ok(r.message.includes(recomputed), `拒绝里没带上重算的那个：${r.message}`)
    assert.notEqual(decoy, recomputed)
  })

  test('★★★ 干净机器：还没装过是一个**正常读数**，不是错误（而且不阻塞）', () => {
    const f = fixture('read-absent')
    const r = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    assert.equal(r.ok, false)
    assert.equal(r.code, RUNTIME_RESOLVE_CODES.NOT_INSTALLED)
    assert.equal(r.blocking, false, '"还没装"不该拦下一次启动——它是最常见的状态')
    assert.equal(r.command, null)
  })

  test('★★★ 没有数据目录：也**不阻塞**（同一件事由计划的 ENTRY_UNRESOLVED 说，不重复报）', () => {
    for (const dataDir of [null, '', '   ']) {
      const r = resolveRuntimeCommand({ dataDir, profile: 'web' })
      assert.equal(r.code, RUNTIME_RESOLVE_CODES.NO_DATA_DIR)
      assert.equal(r.blocking, false)
      assert.equal(r.nextStep !== null, true)
    }
  })

  test('★★★ 指针读不懂 / 指着半装的目录 ⇒ 阻塞（spec §9.1 不带病运行）', () => {
    const f = fixture('read-broken')
    const i = installOnce(f)
    const pointerPath = join(f.dataDir, 'runtime', 'dsh', 'current.json')
    const good = readFileSync(pointerPath, 'utf8')

    writeFileSync(pointerPath, '{ 这不是 JSON\n', 'utf8')
    const unreadable = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    assert.equal(unreadable.code, RUNTIME_RESOLVE_CODES.POINTER_UNREADABLE)
    assert.equal(unreadable.blocking, true)

    writeFileSync(pointerPath, good, 'utf8')
    rmSync(join(i.active.dir, 'install-complete.json'), { force: true })
    const broken = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web' })
    assert.equal(broken.code, RUNTIME_RESOLVE_CODES.POINTER_BROKEN)
    assert.equal(broken.blocking, true)
    assert.equal(broken.command, null)
  })

  test('★★★ extraArgs 追加在 --profile 之后（DSH 的参数次序：profile 先于 patch）', () => {
    const f = fixture('read-extra')
    installOnce(f)
    const r = resolveRuntimeCommand({ dataDir: f.dataDir, profile: 'web', extraArgs: ['--patch', 'x.yml'] })
    assert.deepEqual([...r.command.args].slice(1), ['--profile', 'web', '--patch', 'x.yml'])
  })

  test('★★ `runtimeCommandIsGiven` 与 `expandConfigured` 同一个判据（空串不算给）', () => {
    assert.equal(runtimeCommandIsGiven(null), false)
    assert.equal(runtimeCommandIsGiven(undefined), false)
    assert.equal(runtimeCommandIsGiven(''), false)
    assert.equal(runtimeCommandIsGiven('   '), false)
    assert.equal(runtimeCommandIsGiven({ file: '  ' }), false)
    assert.equal(runtimeCommandIsGiven('node x.mjs'), true)
    assert.equal(runtimeCommandIsGiven({ file: process.execPath, args: [] }), true)
  })
})

// ============================================================================
// ② 接线：Launcher 真的把它用上
// ============================================================================

describe('PRT-257 Launcher 用上装好的运行时（接线）', () => {
  test('★★★★★ 没有 --runtime-command 时，Launcher 的命令来自 current.json', async () => {
    const f = fixture('wire-derive')
    const i = installOnce(f)
    const seams = offlineSeams()
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['runtime'],
      ports: { runtime: await reserveEphemeralPort() },
      runtimeCommand: null,
      runtimeEnv: IDENTITY_ENV,
      ...seams.opts,
    })

    // ① 读数：这一次启动的 runtime 命令是**从指针来的**。
    const entry = L.status().runtimeEntry
    assert.equal(entry.source, 'installed-runtime')
    assert.equal(entry.configured, false)
    assert.deepEqual([...entry.command.args], [i.active.entryPath, '--profile', DEFAULT_DSH_PROFILE])

    // ② 计划：不再有 ENTRY_UNRESOLVED（那条会拦住整个启动）。
    const pre = await L.preflight()
    assert.equal(pre.diagnostics.some((d) => d.code === 'ENTRY_UNRESOLVED'), false,
      `入口仍报未解析：${JSON.stringify(pre.diagnostics.map((d) => d.code))}`)
    assert.equal(pre.ok, true, `体检没过：${JSON.stringify(pre.diagnostics)}`)

    // ③ ★ 进程边界：**真的**拿这条命令去 spawn 了。
    //    这一条是整段接线的唯一不可自证之处——前两条都可以由一个
    //    "把命令存在 status 里、但从不使用"的实现满足。
    await L.start()
    assert.equal(seams.captured.length, 1, `spawn 次数不对：${seams.captured.length}`)
    const rt = seams.captured[0]
    const overlayArg = join(f.installDir, 'runtime', 'dsh-composition', 'legion-host.patch.yml')
    assert.deepEqual(rt.args, [i.active.entryPath, '--profile', DEFAULT_DSH_PROFILE, '--patch', overlayArg])
    assert.equal(rt.file, process.execPath)
    // 次序：`--profile` 在 `--patch` **之前**。DSH 的参数解析对这两段的次序敏感
    // （profile 是父命令的参数），而"两段都在命令行里"在次序错了的时候照样成立。
    assert.ok(rt.args.indexOf('--profile') < rt.args.indexOf('--patch'))
    await L.stop({ graceMs: 100 })
  })

  test('★★★★ 显式配置赢，但"装好的那份没被用上"必须说出来', async () => {
    const f = fixture('wire-configured-wins')
    installOnce(f)
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['runtime'],
      ports: { runtime: await reserveEphemeralPort() },
      runtimeCommand: 'node x.mjs',
      runtimeEnv: IDENTITY_ENV,
      ...offlineSeams().opts,
    })
    const entry = L.status().runtimeEntry
    assert.equal(entry.source, 'configured')
    assert.equal(entry.command, 'node x.mjs')
    const unused = L.diagnostics.find((d) => d.code === RUNTIME_RESOLVE_DIAG_CODES.INSTALLED_UNUSED)
    assert.ok(unused !== undefined, `装好的运行时被忽略时没有任何读数：${JSON.stringify(L.diagnostics.map((d) => d.code))}`)
    assert.equal(unused.severity, 'warn')
    assert.match(unused.message, new RegExp(DSH_VERSION))
    // 它**不**拦启动：显式配置是用户的决定。
    const pre = await L.preflight()
    assert.equal(pre.ok, true, JSON.stringify(pre.diagnostics))
  })

  test('★★★★ 坏指针 + 没有别的来源 ⇒ 拦住启动，并点名是**指针坏了**', async () => {
    const f = fixture('wire-broken')
    const i = installOnce(f)
    rmSync(join(i.active.dir, 'install-complete.json'), { force: true })
    const seams = offlineSeams()
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['runtime'],
      ports: { runtime: await reserveEphemeralPort() },
      runtimeCommand: null,
      ...seams.opts,
    })
    const pre = await L.preflight()
    assert.equal(pre.ok, false, '一个坏指针不该被读成"可以启动"')
    const d = pre.diagnostics.find((x) => x.code === RUNTIME_RESOLVE_CODES.POINTER_BROKEN)
    assert.ok(d !== undefined, `没有具名拒绝：${JSON.stringify(pre.diagnostics.map((x) => x.code))}`)
    assert.equal(d.severity, 'error')
    assert.equal(d.process, 'runtime')
    assert.equal(seams.captured.length, 0)
  })

  test('★★★★ Launcher 层也钉住"少了 profile"：dshProfile 为空 ⇒ 拒绝而不是短命令', async () => {
    const f = fixture('wire-no-profile')
    installOnce(f)
    const seams = offlineSeams()
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['runtime'],
      ports: { runtime: await reserveEphemeralPort() },
      runtimeCommand: null,
      dshProfile: null,
      ...seams.opts,
    })
    const pre = await L.preflight()
    assert.equal(pre.ok, false)
    assert.ok(pre.diagnostics.some((d) => d.code === RUNTIME_RESOLVE_CODES.PROFILE_REQUIRED))
    assert.equal(seams.captured.length, 0)
  })

  test('★★★★ 干净机器上的行为**一个字都没变**：没有命令、计划照旧报 ENTRY_UNRESOLVED', async () => {
    const f = fixture('wire-absent')
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['runtime'],
      ports: { runtime: await reserveEphemeralPort() },
      runtimeCommand: null,
      ...offlineSeams().opts,
    })
    assert.equal(L.status().runtimeEntry.source, null)
    assert.equal(L.status().runtimeEntry.code, RUNTIME_RESOLVE_CODES.NOT_INSTALLED)
    const pre = await L.preflight()
    assert.equal(pre.ok, false)
    assert.ok(pre.diagnostics.some((d) => d.code === 'ENTRY_UNRESOLVED'))
    // 而且**没有**多出一条关于运行时的诊断：同一件事报两次会被读成两个问题。
    assert.equal(
      pre.diagnostics.some((d) => d.process === 'runtime' && String(d.code).startsWith('RUNTIME_RESOLVE_')),
      false,
    )
  })

  test('★★★ 受限范围（不含 runtime）时，坏指针降级为 warn 而不是拦住整次启动', async () => {
    const f = fixture('wire-scope')
    const i = installOnce(f)
    rmSync(join(i.active.dir, 'install-complete.json'), { force: true })
    const L = createLauncher({
      layout: layoutFor(f, f.root),
      include: ['team-hub'],
      ports: { 'team-hub': await reserveEphemeralPort() },
      runtimeCommand: null,
      ...offlineSeams().opts,
    })
    const d = L.diagnostics.find((x) => x.excludedCode === RUNTIME_RESOLVE_CODES.POINTER_BROKEN)
    assert.ok(d !== undefined, `被范围排除的进程诊断没有被降级：${JSON.stringify(L.diagnostics.map((x) => x.code))}`)
    assert.equal(d.code, 'PROCESS_EXCLUDED_BY_SCOPE')
    assert.equal(d.severity, 'warn')
  })
})

// ============================================================================
// ③ 策略函数的读数（一次启动到底用了哪一条）
// ============================================================================

describe('PRT-257 resolveRuntimeForLaunch 的读数', () => {
  test('used 三态必须分开：configured / installed-runtime / null', () => {
    const f = fixture('policy')
    installOnce(f)
    const configured = resolveRuntimeForLaunch({ runtimeCommand: 'node x.mjs', dataDir: f.dataDir, profile: 'web' })
    const installed = resolveRuntimeForLaunch({ runtimeCommand: null, dataDir: f.dataDir, profile: 'web' })
    assert.equal(configured.used, 'configured')
    assert.equal(configured.given, true)
    assert.equal(installed.used, 'installed-runtime')
    assert.equal(installed.given, false)
    assert.equal(installed.diagnostics.length, 0, '正常路径上不该有诊断：一个每次都报的 warn 等于没有 warn')

    const empty = fixture('policy-empty')
    const absent = resolveRuntimeForLaunch({ runtimeCommand: null, dataDir: empty.dataDir, profile: 'web' })
    assert.equal(absent.used, null)
    assert.equal(absent.command, null)
    assert.deepEqual([...absent.diagnostics], [])
    // 拒绝里那句"下一步"必须查得到（否则提示等于没给）。
    assert.equal(typeof runtimeResolveNextStepOf(RUNTIME_RESOLVE_CODES.NOT_INSTALLED), 'string')
    assert.equal(runtimeResolveNextStepOf('NOT_A_CODE'), null)
  })

  test('★★★ fs 可注入：读数完全走注入的那个 fs（判据不需要真磁盘）', () => {
    const calls = []
    const io = {
      existsSync: (p) => { calls.push(['exists', String(p)]); return false },
      readFileSync: () => { throw new Error('不该读到这一步') },
    }
    const r = resolveRuntimeForLaunch({ runtimeCommand: null, dataDir: 'C:\\fake\\data', profile: 'web', fs: io })
    assert.equal(r.used, null)
    assert.equal(calls.length > 0, true)
  })

  test('★★ "没被用上"的文案里带上现役版本（要说得具体）', () => {
    const f = fixture('policy-msg')
    installOnce(f)
    const r = resolveRuntimeForLaunch({ runtimeCommand: 'node x.mjs', dataDir: f.dataDir, profile: 'web' })
    assert.equal(r.diagnostics.length, 1)
    assert.match(r.diagnostics[0].message, new RegExp(DSH_VERSION))
  })

  test('★★ 装过之后 runtime/dsh 下就是 versions/ 与 current.json（"目录在"不等于"装完了"）', () => {
    const f = fixture('policy-tree')
    installOnce(f)
    const runtimeRoot = join(f.dataDir, 'runtime', 'dsh')
    assert.ok(readdirSync(runtimeRoot).includes('current.json'))
    assert.ok(readdirSync(runtimeRoot).includes('versions'))
  })
})
