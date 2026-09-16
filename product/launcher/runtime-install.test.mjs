// product/launcher/runtime-install.test.mjs
// ============================================================================
// PRT-257：DSH 运行时安装器的判据（路线 C 的生产半边）
//
// ## 这一套守的是什么
//
// `PRT-011-dsh-distribution-decision.md:130-137` 把路线 C 拆成四件事。这一套用例
// 逐条对着那四件：
//
//   ① 版本解析与锁定 —— 区间外 / 畸形 / §9.1 成对，全部**在纯计划里**拒绝；
//   ② 安装位置       —— 只在 DataDir，$DSH_HOME / ~/.dsh / InstallDir 一律拒绝；
//   ③ 原子切换与回滚 —— 校验失败与中途抛出之后，指针**仍然指着旧版本**；
//   ④ shipped preset —— 整轮安装没有一次写入落在只读根上（不是"文档里写着只读"）。
//
// ## 最要紧的两条断言，以及它们为什么不能合并
//
//   > 一条"新版本装好了"的断言，
//   > 与一条"指针只有在校验通过之后才动"的断言，在安装永远成功的那些运行里
//   > 是同一片绿——只不过前者的绿，在一次装到一半的失败里会留下一个半装的 current。
//
// 所以 ★★★★★ 那两条**故意让安装失败**：一次让校验在目录已经被填满之后失败，
// 一次让运行器直接抛。两次都断言磁盘上的两件事（指针指向谁、旧版本的入口在不在），
// 而不是断言返回值里的 `ok`。
//
//   > 一个"目录存在"的判据，
//   > 与一个"这次的安装完成了"的判据，在安装总是成功时是同一个东西。
//
// 这就是完成标记（`install-complete.json`）存在的全部理由，也是本套件里
// 反复出现"新目录**没有**完成标记"那条断言的原因。
//
// ## 测试从不联网，也从不跑真的 npm
//
// `installRuntime` 的 `runner` 是**必填**的（模块里没有缺省实现），所以
// "这一次没有真的去装"是一个**结构性**事实而不是一句注释。每个用例里的
// 假运行器只做一件事：把 `node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}`
// 按请求的版本写出来——并且写进去的入口文件里带着「假的 DSH 入口」这句标记，
// 用例末尾会断言它还在（见"诚实边界"那一段）。
//
// 所有临时目标都在自己的 `mkdtempSync` 里，`afterEach` + `after` 双层清理，
// 失败也一样清。
// ============================================================================

import assert from 'node:assert/strict'
import { after, afterEach, describe, test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  COMPLETION_MARKER_FILENAME, DEFAULT_DSH_PACKAGE, DEFAULT_ENTRY_RELPATH,
  LEGION_FILE_PACKAGES, LEGION_PACKAGE_PREFIX, LEGION_ROUTE_JUNCTION, NODE_MODULES_DIRNAME,
  NPM_LOG_FILENAME, NPM_RUNNER_CODES, POINTER_FILENAME, PREVIOUS_POINTER_FILENAME,
  RUNTIME_INSTALL_CODES, RUNTIME_INSTALL_VERSION, RUNTIME_ROOT_PARTS, TARGET_DIR_POLICY,
  VERSIONS_DIRNAME,
  compareDshVersions, createNpmRunner, createRuntimeWriteGuard, dshPatchPairOf, installationRepairPlan,
  installRuntime, parseDshVersion, planRuntimeInstall, readActiveRuntime,
  resolveNpmInvocation, rollbackRuntime, runtimePathsOf, runtimeRootOf, verifyInstallation,
} from './runtime-install.mjs'
import { DOCTOR_CODES, DOCTOR_EXIT, doctorReport, renderDoctor } from './doctor.mjs'
import { isPathInside, normalizePath, samePath } from '../paths.mjs'
import { LEGION_PACKAGES, LEGION_PACKAGE_PREFIX as BASELINE_PACKAGE_PREFIX } from '../../scripts/prt/composition-baseline.mjs'
import { ACTIVE_POINTER, VERSIONS_DIRNAME as SWITCHOVER_VERSIONS_DIRNAME } from '../upgrade/switchover.mjs'
import { patchPairOf } from '../upgrade/index.mjs'
import { satisfiesRange } from '../../runtime/packs/manifest.mjs'

// ---------------------------------------------------------------- 临时目录

const TEMP_ROOTS = []

function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-prt257-${tag}-`))
  TEMP_ROOTS.push(dir)
  return dir
}

function sweepTempRoots() {
  while (TEMP_ROOTS.length > 0) {
    const dir = TEMP_ROOTS.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力而为；不清会留孤儿目录 */ }
  }
}

// 两层：`afterEach` 保证一次失败不会留下孤儿目录（上一个 agent 在这里留过 3 个），
// `after` 兜住"用例文件自己被中途打断"的那一次。
afterEach(sweepTempRoots)
after(sweepTempRoots)

/** 目录树的快照。用来断言"拒绝了，而且磁盘上什么都没多出来"。 */
const snapshot = (root) => readdirSync(root, { recursive: true }).map(String).sort()

// ---------------------------------------------------------------- 夹具

/** 清单声明的受支持区间。`^0.1.5-rc.2` → `>=0.1.5-rc.2 <0.2.0`，且只接受同为预发布的版本。 */
const RANGE = '^0.1.5-rc.2'

/** 已知可用的 `(dshVersion, dshCompositionPatchVersion)` 绑定表（spec §9.1）。 */
const BINDINGS = Object.freeze([
  Object.freeze({ dshVersion: '0.1.5-rc.2', compositionPatchVersion: 1 }),
  Object.freeze({ dshVersion: '0.1.6', compositionPatchVersion: 1 }),
  Object.freeze({ dshVersion: '0.1.7', compositionPatchVersion: 2 }),
])

/**
 * 真实的区间判据。`satisfiesRange` 对无界 / 畸形区间**抛**，而本模块的三态
 * 要求"判不出来"与"判过了"分开——所以这里包一层，抛 ⇒ 返回 `null`（= 判不出来）。
 */
const rangeSatisfied = (version, range) => {
  try { return satisfiesRange(version, range) } catch { return null }
}

/**
 * 一套"像真的"目录：DataDir、InstallDir（含四个 Legion 包目录）、
 * DSH 家目录（含 shipped preset 与它们的证明文件）、operator 家目录。
 */
function fixture(tag) {
  const root = tempRoot(tag)
  const dataDir = join(root, 'Legion', 'data')
  const installDir = join(root, 'Legion', 'install')
  const dshHome = join(root, 'dsh-home')
  const operatorHome = join(root, 'operator-home')
  const shippedPresetRoot = join(dshHome, 'profiles')
  for (const p of LEGION_FILE_PACKAGES) mkdirSync(join(installDir, p.repoDir), { recursive: true })
  mkdirSync(join(shippedPresetRoot, 'web'), { recursive: true })
  // DSH 自带的 preset 安装位置里放一份"只读证据"：整轮安装之后它必须逐字节没变。
  writeFileSync(join(shippedPresetRoot, 'web', 'cordis.yml'), '# DSH shipped preset —— 只读\n[]\n', 'utf8')
  return { root, dataDir, installDir, dshHome, operatorHome, shippedPresetRoot }
}

/** 一份合法计划，逐项可被单个用例覆写。 */
function planFor(f, over = {}) {
  return planRuntimeInstall({
    dataDir: f.dataDir,
    allowedRoot: f.dataDir,
    installDir: f.installDir,
    dshHome: f.dshHome,
    operatorHome: f.operatorHome,
    shippedPresetRoot: f.shippedPresetRoot,
    targetVersion: '0.1.5-rc.2',
    supportedRange: RANGE,
    rangeSatisfied,
    expectedPatchVersion: 1,
    patchBindings: BINDINGS,
    ...over,
  })
}

/**
 * 假命令运行器。**唯一**会落盘的假动作就是把请求的那一版写进
 * `node_modules/<包>/{package.json,lib/bin.js}`——一句话：它模拟 npm 的**结果**，
 * 不模拟 npm。
 */
function fakeRunner({ mode = 'ok', version = null, writeEntry = true } = {}) {
  const calls = []
  const fn = (command, opts) => {
    calls.push({ command, opts })
    if (mode === 'throw') throw new Error('假的 npm：装到一半被打断（磁盘满）')
    if (mode === 'fail') return { ok: false, status: 1, stdout: '', stderr: 'npm ERR! EAI_AGAIN 假网络错误', error: null }
    if (mode === 'silent') return { ok: true, status: 0, stdout: '', stderr: '', error: null }
    const spec = command.args[command.args.length - 1]
    const at = spec.lastIndexOf('@')
    const pkg = spec.slice(0, at)
    const ver = version ?? spec.slice(at + 1)
    const prefix = command.args[command.args.indexOf('--prefix') + 1]
    const dir = join(prefix, NODE_MODULES_DIRNAME, ...pkg.split('/'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: ver }, null, 2), 'utf8')
    if (writeEntry) writeFileSync(join(dir, 'lib', 'bin.js'), `// 假的 DSH 入口（用例内造出来的，不是真的 dsh）\n`, 'utf8')
    return { ok: true, status: 0, stdout: '', stderr: '', error: null }
  }
  fn.calls = calls
  return fn
}

/** 记录每一次**变更**类调用的 fs 探针，其余转发给真实 node:fs。 */
function spyFs() {
  const mutating = []
  const record = (op, ...paths) => { for (const p of paths) mutating.push(Object.freeze({ op, path: String(p) })) }
  return {
    mutating,
    existsSync,
    lstatSync,
    readFileSync,
    mkdirSync: (p, o) => { record('mkdir', p); return mkdirSync(p, o) },
    writeFileSync: (p, d, e) => { record('write', p); return writeFileSync(p, d, e) },
    rmSync: (p, o) => { record('remove', p); return rmSync(p, o) },
    renameSync: (a, b) => { record('rename', a, b); return renameSync(a, b) },
    symlinkSync: (t, p, ty) => { record('symlink', p); return symlinkSync(t, p, ty) },
    copyFileSync: (a, b) => { record('copy', b); return copyFileSync(a, b) },
    unlinkSync: (p) => { record('unlink', p); return unlinkSync(p) },
    chmodSync: (p, m) => { record('chmod', p); return chmodSync(p, m) },
  }
}

const readPointer = (dataDir) => JSON.parse(readFileSync(runtimeRootOf({ dataDir }).pointerPath, 'utf8'))
const markerOf = (dataDir, version) => join(runtimePathsOf({ dataDir, targetVersion: version }).versionDir, COMPLETION_MARKER_FILENAME)
const entryOf = (dataDir, version) => runtimePathsOf({ dataDir, targetVersion: version }).entryPath

/** 装一次并断言成功。返回结果。 */
function installOk(f, plan, runnerOpts = {}) {
  const runner = fakeRunner(runnerOpts)
  const res = installRuntime({ plan, runner })
  assert.equal(res.ok, true, `安装没有成功：${res.code} ${res.message}`)
  return res
}

// ============================================================================
// 一、纯计划：拒绝必须发生在任何目录被创建之前
// ============================================================================

describe('PRT-257 DSH 运行时安装：纯计划（零 IO）', () => {
  test('★★★ DataDir 缺失 / 不是绝对路径 → 具名拒绝，磁盘上不留任何东西', () => {
    const f = fixture('plan-nodata')
    const before = snapshot(f.root)

    const noData = planRuntimeInstall({ allowedRoot: f.dataDir, targetVersion: '0.1.5-rc.2' })
    assert.equal(noData.ok, false)
    assert.equal(noData.code, RUNTIME_INSTALL_CODES.NO_DATA_DIR)
    assert.equal(noData.stage, 'refused')

    const relative = planRuntimeInstall({
      dataDir: join('relative', 'data'), allowedRoot: f.dataDir, targetVersion: '0.1.5-rc.2',
    })
    assert.equal(relative.ok, false)
    assert.equal(relative.code, RUNTIME_INSTALL_CODES.DATA_DIR_NOT_ABSOLUTE)

    // 两条拒绝都必须带"下一步"（spec §6.3「提示修复或回滚」）。
    for (const p of [noData, relative]) {
      assert.equal(typeof p.repair.command, 'string')
      assert.match(p.repair.command, /--doctor/)
    }
    assert.deepEqual(snapshot(f.root), before, '纯计划在磁盘上留下了东西')
  })

  test('★★★ 危险目标：$DSH_HOME / ~/.dsh / InstallDir / 允许根之外 → 具名拒绝且什么都没多出来', () => {
    const f = fixture('plan-danger')
    const cases = [
      {
        why: '落在真实 operator 的 $DSH_HOME 里',
        code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_DSH_HOME,
        over: { dataDir: join(f.dshHome, 'data') },
      },
      {
        why: '落在 ~/.dsh 里（即使 DSH_HOME 没设）',
        code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_DSH_HOME,
        over: { dataDir: join(f.operatorHome, '.dsh', 'data'), dshHome: null },
      },
      {
        why: '落在 InstallDir 里（PRT-011 §2.1 明确禁止）',
        code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_INSTALL_DIR,
        over: { dataDir: join(f.installDir, 'data') },
      },
      {
        why: '越出调用方给的允许根',
        code: RUNTIME_INSTALL_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
        over: { allowedRoot: join(f.root, 'somewhere-else') },
      },
      {
        why: '根本没给允许根（"没有边界"按越界处理）',
        code: RUNTIME_INSTALL_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
        over: { allowedRoot: null },
      },
    ]

    for (const c of cases) {
      const before = snapshot(f.root)
      const plan = planFor(f, c.over)
      assert.equal(plan.ok, false, `${c.why}：竟然被判成可安装`)
      assert.equal(plan.code, c.code, `${c.why}：码是 ${plan.code}`)
      // 磁盘上不留任何东西——这是"拒绝发生在建目录之前"的可执行形式。
      assert.deepEqual(snapshot(f.root), before, `${c.why}：磁盘上多出了东西`)
      // 而 `installRuntime` 结构上不接受一条被拒绝的计划。
      assert.throws(() => installRuntime({ plan, runner: fakeRunner() }), /ok === true/)
    }
  })

  test('★★★★ 版本区间 fail-closed：区间外与畸形都在建目录之前拒绝', () => {
    const f = fixture('plan-range')
    const before = snapshot(f.root)

    // ① 区间外：`^0.1.5-rc.2` 的上界是 0.2.0。
    const outOfRange = planFor(f, { targetVersion: '0.2.0' })
    assert.equal(outOfRange.ok, false)
    assert.equal(outOfRange.code, RUNTIME_INSTALL_CODES.VERSION_OUT_OF_RANGE)
    assert.match(outOfRange.message, /不是包管理器/)

    // ② 畸形版本：三段以下、带区间记号、路径片段——都不是版本号。
    for (const bad of ['0.1', 'not-a-version', '^0.1.5', 'latest', '', '../escape']) {
      const p = planFor(f, { targetVersion: bad })
      assert.equal(p.ok, false, `畸形版本 ${JSON.stringify(bad)} 竟然被接受`)
      assert.equal(p.code, RUNTIME_INSTALL_CODES.VERSION_MALFORMED, `畸形版本 ${JSON.stringify(bad)} 的码是 ${p.code}`)
    }

    // ③ 判据缺失 / 判不出来：**一律拒绝**，不是放行。
    for (const over of [
      { rangeSatisfied: null },
      { supportedRange: null },
      { supportedRange: '*' },                       // satisfiesRange 对无界区间抛 → 判不出来
      { rangeSatisfied: () => { throw new Error('区间写法不认识') } },
      { rangeSatisfied: () => undefined },
    ]) {
      const p = planFor(f, over)
      assert.equal(p.ok, false, `区间判据 ${JSON.stringify(Object.keys(over))} 竟然放行了`)
      assert.equal(p.code, RUNTIME_INSTALL_CODES.RANGE_UNCHECKED, `码是 ${p.code}`)
    }

    assert.deepEqual(snapshot(f.root), before, '区间判定在磁盘上留下了东西')
  })

  // ★★★★★ 缺省判据**就是生产实现**——这一条钉的是"接线"，不是"判据"。
  //
  // 上面那条用例里的 `planFor()` **总是**把 `rangeSatisfied` 传进去，所以
  // 缺省值本身**没有任何用例覆盖**。上一版的缺省是 `null`，于是任何真实调用
  // 都会停在 `RANGE_UNCHECKED` 上：安装器**一个东西都装不了**。
  //
  //   > 一根"没有任何调用方会传"的接线，
  //   > 与一根"故意不接、要求调用方显式提供"的接线，
  //   > 在每一次被拒绝的调用上都是同一个东西——
  //   > 只不过前者是缺陷，而后者看起来像纪律。
  //
  // 但只断言"它不再拒绝了"是不够的：`() => true` 也能过那一条。承重的是 ②。
  test('★★★★★ 缺省判据是生产实现：既不再"什么都装不了"，也不是"永远放行"', () => {
    const f = fixture('plan-default-range')
    const before = snapshot(f.root)

    // ① 不传 `rangeSatisfied`：合法区间下**必须越过区间这一关**。
    const withoutPredicate = planFor(f, { rangeSatisfied: undefined })
    assert.notEqual(withoutPredicate.code, RUNTIME_INSTALL_CODES.RANGE_UNCHECKED,
      `缺省判据没有生效：仍然停在 RANGE_UNCHECKED（说明缺省还是 null）`)

    // ② ★ 承重：同一个缺省判据**必须真的拒掉区间外的版本**。
    //    这一条把"缺省接的是生产实现"与"缺省接了一个恒真的东西"分开——
    //    两者在 ① 上是一样的绿。
    const outOfRange = planFor(f, { rangeSatisfied: undefined, targetVersion: '9.9.9' })
    assert.equal(outOfRange.ok, false, '缺省判据放行了区间外的版本')
    assert.equal(outOfRange.code, RUNTIME_INSTALL_CODES.VERSION_OUT_OF_RANGE,
      `缺省判据没有拒掉区间外的版本，码是 ${outOfRange.code}`)

    // ③ 显式 `null` 仍然关得掉它：fail-closed 的那条路保留着，且与"没传"不同。
    //    （JS 的解构缺省只对 `undefined` 生效，所以 `null` 是个**显式**的关闭动作。）
    const disabled = planFor(f, { rangeSatisfied: null })
    assert.equal(disabled.code, RUNTIME_INSTALL_CODES.RANGE_UNCHECKED,
      `显式 null 没有关掉判据，码是 ${disabled.code}`)

    // ④ 而 `null` 与"没传"必须**不是同一个读数**——否则这一整条用例就是空的。
    assert.notEqual(withoutPredicate.code, disabled.code,
      '「没传判据」与「显式关掉判据」给出了同一个码：缺省值没有被区分出来')

    assert.deepEqual(snapshot(f.root), before, '缺省判据的判定在磁盘上留下了东西')
  })

  test('★★★★ §9.1 成对：绑定表里没有那一对 → 具名拒绝，并说清是哪一侧', () => {
    const f = fixture('plan-pair')
    const before = snapshot(f.root)

    // ① 绑定表里根本没有这个 DSH 版本 → 动的是 DSH 那一侧。
    const dshSide = planFor(f, { targetVersion: '0.1.6', expectedPatchVersion: 9 })
    assert.equal(dshSide.ok, false)
    assert.equal(dshSide.code, RUNTIME_INSTALL_CODES.PATCH_PAIR_MISMATCH)
    assert.equal(dshSide.patchPair.verdict, 'mismatch')
    assert.equal(dshSide.patchPair.side, 'patch')
    assert.deepEqual([...dshSide.patchPair.knownGoodPatches], [1])

    const unknownDsh = planFor(f, {
      targetVersion: '0.9.9', expectedPatchVersion: 1,
      supportedRange: '^0.9.9', rangeSatisfied: () => true,
    })
    assert.equal(unknownDsh.code, RUNTIME_INSTALL_CODES.PATCH_PAIR_MISMATCH)
    assert.equal(unknownDsh.patchPair.side, 'dsh')
    assert.match(unknownDsh.message, /绑定表里没有 DSH 0\.9\.9/)

    // ② 没给绑定表 → "没有验证过"不等于"验证通过"，同样拒绝。
    const unverified = planFor(f, { patchBindings: null })
    assert.equal(unverified.ok, false)
    assert.equal(unverified.code, RUNTIME_INSTALL_CODES.PATCH_PAIR_UNVERIFIED)
    assert.equal(unverified.patchPair.verdict, 'unverified')

    assert.deepEqual(snapshot(f.root), before, '成对判定在磁盘上留下了东西')
  })

  test('★★★★ 成对判据与既有实现逐格一致（product/upgrade 的 patchPairOf）', () => {
    // 两处判据刻意同形（同三态、同绑定表结构），代价是可能漂移——所以在这里对拍。
    const versions = ['0.1.5-rc.2', '0.1.6', '0.1.7', '0.9.9']
    const patches = [1, 2, 9]
    for (const v of versions) {
      for (const p of patches) {
        const mine = dshPatchPairOf({ targetVersion: v, expectedPatchVersion: p, patchBindings: BINDINGS }).verdict
        const theirs = patchPairOf({ dshVersion: v, dshCompositionPatchVersion: p }, BINDINGS)
        assert.equal(mine, theirs, `(${v}, ${p}) 上两处判据不一致：本方 ${mine}，既有的 ${theirs}`)
      }
    }
    // 没给表：两处都必须是 unverified（**不是** match）。
    assert.equal(dshPatchPairOf({ targetVersion: '0.1.6', expectedPatchVersion: 1, patchBindings: null }).verdict, 'unverified')
    assert.equal(patchPairOf({ dshVersion: '0.1.6', dshCompositionPatchVersion: 1 }, null), 'unverified')
  })

  test('★★★ 计划明说选了哪条 Legion 路线，并给出四个 junction 的源与落点', () => {
    const f = fixture('plan-legion')
    const plan = planFor(f)
    assert.equal(plan.ok, true, plan.message)

    // 路线**写在计划里**，不是只写在注释里。
    assert.equal(plan.legion.route, LEGION_ROUTE_JUNCTION)
    assert.match(plan.legion.why, /PRT-011 §3 第 3 条/)
    assert.equal(plan.legion.links.length, 4)

    // 四个包的 (包名 → 目录名) 与 PRT-010 §2.3 的采集表逐对相等。
    const declared = [...LEGION_FILE_PACKAGES].map((p) => [p.name, p.repoDir]).sort()
    const baseline = Object.entries(LEGION_PACKAGES).map(([name, dir]) => [name, dir]).sort()
    assert.deepEqual(declared, baseline, '模块里的四个包与 scripts/prt/composition-baseline.mjs 的 LEGION_PACKAGES 漂移了')
    assert.equal(LEGION_PACKAGE_PREFIX, BASELINE_PACKAGE_PREFIX)
    for (const l of plan.legion.links) assert.ok(l.name.startsWith(LEGION_PACKAGE_PREFIX))

    for (const l of plan.legion.links) {
      assert.ok(l.name.startsWith('@dsh-external/'))
      assert.equal(l.sourceDir, join(f.installDir, l.repoDir))
      assert.equal(l.linkPath, join(plan.versionDir, NODE_MODULES_DIRNAME, ...l.name.split('/')))
      assert.equal(l.linkType, process.platform === 'win32' ? 'junction' : 'dir')
    }

    // 只读根是**明写的**：shipped preset 与安装目录。
    assert.equal(plan.readOnlyRoots.length, 2)
    assert.ok(plan.readOnlyRoots.some((r) => samePath(r, f.shippedPresetRoot)))
    assert.ok(plan.readOnlyRoots.some((r) => samePath(r, f.installDir)))
    assert.equal(plan.writableRoot, normalizePath(f.dataDir))

    // 计划是冻结的：一个能被下游改掉的计划，与一个没有计划的调用点，在出事后一样说不清。
    assert.equal(Object.isFrozen(plan), true)
    assert.equal(Object.isFrozen(plan.legion), true)
    assert.equal(Object.isFrozen(plan.installCommand.args), true)
  })

  test('计划把运行时放在 DataDir 下的 runtime/dsh，且装的是**清单那一个**版本', () => {
    const f = fixture('plan-shape')
    const plan = planFor(f)
    assert.equal(plan.version, RUNTIME_INSTALL_VERSION)
    assert.deepEqual([...RUNTIME_ROOT_PARTS], ['runtime', 'dsh'])
    assert.equal(plan.runtimeRoot, join(f.dataDir, 'runtime', 'dsh'))
    assert.equal(plan.versionsDir, join(plan.runtimeRoot, VERSIONS_DIRNAME))
    assert.equal(plan.versionDir, join(plan.versionsDir, '0.1.5-rc.2'))
    assert.equal(plan.pointerPath, join(plan.runtimeRoot, POINTER_FILENAME))
    assert.equal(plan.entryPath, join(plan.versionDir, NODE_MODULES_DIRNAME, DEFAULT_DSH_PACKAGE, DEFAULT_ENTRY_RELPATH))
    assert.equal(plan.targetDirPolicy, TARGET_DIR_POLICY.DECIDE_AT_APPLY)

    // 装的是清单声明的**精确**版本：args 里不许出现 latest / ^ / ~。
    const arg = plan.installCommand.args[plan.installCommand.args.length - 1]
    assert.equal(arg, `${DEFAULT_DSH_PACKAGE}@0.1.5-rc.2`)
    assert.equal(/latest|\^|~|\*/.test(plan.installCommand.args.join(' ')), false,
      '安装命令里出现了"最新版"语义：清单是版本的唯一来源（spec §9.1：客户不能在产品内单独升级 DSH）')
    assert.equal(plan.relation, 'fresh')
  })

  test('版本解析与比较：形状、预发布、比不出来', () => {
    assert.deepEqual({ ...parseDshVersion('0.1.5-rc.2') }, { raw: '0.1.5-rc.2', major: 0, minor: 1, patch: 5, prerelease: 'rc.2', build: null })
    assert.equal(parseDshVersion('1.2'), null)
    assert.equal(parseDshVersion(undefined), null)
    assert.equal(compareDshVersions('0.1.6', '0.1.5-rc.2'), 1)
    assert.equal(compareDshVersions('0.10.0', '0.9.0'), 1, '字符串比较会把 0.10.0 判成小于 0.9.0')
    assert.equal(compareDshVersions('0.1.5', '0.1.5-rc.2'), 1, '预发布版本小于同号正式版')
    assert.equal(compareDshVersions('0.1.5-rc.2', '0.1.5-rc.2'), 0)
    assert.equal(compareDshVersions('0.1.5-rc.2', 'garbage'), null, '"比不出来"不能读成"一样新"')
  })
})

// ============================================================================
// 二、效果：原子性、回滚、完成标记
// ============================================================================

describe('PRT-257 DSH 运行时安装：原子切换', () => {
  test('★★★★★ 校验失败（新目录已填满）→ 指针仍指旧版本，旧版本仍可用', () => {
    const f = fixture('atomic-verify')
    installOk(f, planFor(f))
    const oldEntry = entryOf(f.dataDir, '0.1.5-rc.2')
    assert.equal(existsSync(oldEntry), true)

    // 让新目录"看起来装好了"：入口文件在、包目录在——只有版本号对不上。
    // 这正是"装完了"与"装的是那一版"两件事的差别。
    const planNew = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    assert.equal(planNew.ok, true, planNew.message)
    const res = installRuntime({ plan: planNew, runner: fakeRunner({ version: '0.1.6-tampered' }) })

    assert.equal(res.ok, false)
    assert.equal(res.code, RUNTIME_INSTALL_CODES.VERIFY_FAILED)
    assert.equal(res.movedPointer, false)
    assert.match(res.message, /指针没有动/)
    // 校验真的看的是磁盘：入口文件那一项是过的，版本那一项没过。
    const failed = res.verify.checks.filter((c) => c.ok !== true).map((c) => c.code)
    assert.deepEqual(failed, ['installed-package-version'])

    // ★ (a) 指针仍然指着旧版本。
    assert.equal(readPointer(f.dataDir).version, '0.1.5-rc.2')
    assert.equal(readPointer(f.dataDir).dir, runtimePathsOf({ dataDir: f.dataDir, targetVersion: '0.1.5-rc.2' }).versionDir)
    // ★ (b) 旧版本仍然可用（入口文件在），而且现役读数不是 broken。
    assert.equal(existsSync(oldEntry), true)
    const active = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(active.state, 'active')
    assert.equal(active.version, '0.1.5-rc.2')
    assert.equal(active.entryExists, true)
    assert.equal(active.patchVersion, 1)

    // ★ 半装的目录**没有**完成标记：它在磁盘上不可选。
    assert.equal(existsSync(markerOf(f.dataDir, '0.1.6')), false, '半装的目录竟然写了完成标记')
  })

  test('★★★★★ 安装中途抛出 → 指针仍指旧版本，旧版本仍可用', () => {
    const f = fixture('atomic-throw')
    installOk(f, planFor(f))
    const oldEntry = entryOf(f.dataDir, '0.1.5-rc.2')

    const planNew = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    const res = installRuntime({ plan: planNew, runner: fakeRunner({ mode: 'throw' }) })

    assert.equal(res.ok, false)
    assert.equal(res.code, RUNTIME_INSTALL_CODES.RUNNER_FAILED)
    assert.equal(res.movedPointer, false)
    assert.equal(readPointer(f.dataDir).version, '0.1.5-rc.2')
    assert.equal(existsSync(oldEntry), true)
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')
    assert.equal(existsSync(markerOf(f.dataDir, '0.1.6')), false)
  })

  test('★★★★ 运行器非零退出 → RUNNER_FAILED；运行器谎报成功 → 由磁盘校验抓住', () => {
    const f = fixture('atomic-runnerfail')
    installOk(f, planFor(f))

    // ① 非零退出：运行器自己说了没成功。
    const planFail = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    const resFail = installRuntime({ plan: planFail, runner: fakeRunner({ mode: 'fail' }) })
    assert.equal(resFail.ok, false)
    assert.equal(resFail.code, RUNTIME_INSTALL_CODES.RUNNER_FAILED)
    assert.equal(resFail.movedPointer, false)
    assert.equal(readPointer(f.dataDir).version, '0.1.5-rc.2')
    assert.equal(existsSync(markerOf(f.dataDir, '0.1.6')), false)
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')

    // ② 运行器报 `ok:true` 但磁盘上什么都没落地 —— **运行器的退出码不是判据**。
    //    这条与①分开，因为处置不同：①去看 npm 的日志，②去看校验说缺哪一项。
    const planSilent = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    const resSilent = installRuntime({ plan: planSilent, runner: fakeRunner({ mode: 'silent' }) })
    assert.equal(resSilent.ok, false)
    assert.equal(resSilent.code, RUNTIME_INSTALL_CODES.VERIFY_FAILED,
      '一个"报成功但什么都没装"的运行器必须被磁盘校验挡住；靠运行器自报的退出码就会漏掉它')
    assert.deepEqual(resSilent.verify.checks.filter((c) => c.ok !== true).map((c) => c.code),
      ['entry-file-present', 'installed-package-version'])
    assert.equal(resSilent.movedPointer, false)
    assert.equal(readPointer(f.dataDir).version, '0.1.5-rc.2')
    assert.equal(existsSync(markerOf(f.dataDir, '0.1.6')), false)
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')
  })

  test('★★★★ "目录存在"不等于"这次的安装完成了"：无标记的残留会被删掉重装', () => {
    const f = fixture('marker-replace')
    installOk(f, planFor(f))

    // 一次崩在中间的安装留下的东西：目录在、里面还有半份文件、**没有**完成标记。
    const stale = runtimePathsOf({ dataDir: f.dataDir, targetVersion: '0.1.6' }).versionDir
    mkdirSync(join(stale, 'node_modules'), { recursive: true })
    writeFileSync(join(stale, 'node_modules', 'half-written.txt'), '半份\n', 'utf8')

    const planNew = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    const res = installOk(f, planNew)
    assert.equal(res.targetDirAction, 'replace-incomplete')
    assert.equal(existsSync(join(stale, 'node_modules', 'half-written.txt')), false, '半装残留没有被清掉')
    assert.equal(existsSync(markerOf(f.dataDir, '0.1.6')), true)
    // 它现在真的可用，而且指针切过去了。
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')
    assert.equal(readPointer(f.dataDir).version, '0.1.6')
  })

  test('★★★★ 带完成标记的目录拒绝被覆盖 —— 一次已经生效的安装不是一个可以重来的草稿', () => {
    const f = fixture('marker-refuse')
    installOk(f, planFor(f))
    const first = installOk(f, planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 }))
    assert.equal(first.targetDirAction, 'create')

    const planAgain = planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.6', installedPatchVersion: 1 })
    const res = installRuntime({ plan: planAgain, runner: fakeRunner() })
    assert.equal(res.ok, false)
    assert.equal(res.code, RUNTIME_INSTALL_CODES.TARGET_DIR_EXISTS)
    assert.equal(res.movedPointer, false)
    assert.match(res.message, /不覆盖/)
    // 现役没有被这次拒绝动过。
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).version, '0.1.6')
  })

  test('★★★ 装好之后：完成标记在、指针指的就是它、读数说 active', () => {
    const f = fixture('happy')
    const plan = planFor(f)
    const res = installOk(f, plan)

    assert.equal(res.movedPointer, true)
    assert.equal(res.relation, 'fresh')
    assert.equal(res.targetDirAction, 'create')
    assert.equal(res.previousVersion, null)
    const stages = res.stages.map((s) => s.stage)
    assert.deepEqual(stages, [
      'dirs', 'legion-sources', 'target-dir', 'npm-install', 'legion-links',
      'verify', 'marker', 'previous-pointer', 'pointer',
    ])
    // ★ 校验在切指针**之前**——顺序就是原子性本身。
    assert.ok(stages.indexOf('verify') < stages.indexOf('pointer'))

    const marker = JSON.parse(readFileSync(plan.markerPath, 'utf8'))
    assert.equal(marker.version, '0.1.5-rc.2')
    assert.equal(marker.dshCompositionPatchVersion, 1)
    assert.equal(marker.legionRoute, LEGION_ROUTE_JUNCTION)
    assert.deepEqual([...marker.legionPackages].sort(), LEGION_FILE_PACKAGES.map((p) => p.name).sort())

    const active = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(active.state, 'active')
    assert.equal(active.version, '0.1.5-rc.2')
    assert.equal(active.complete, true)
    assert.equal(active.entryExists, true)
    // 写进去的入口是本用例的假产物——真 DSH 从来没有被装过（见"诚实边界"）。
    assert.match(readFileSync(active.entryPath, 'utf8'), /假的 DSH 入口/)
    assert.equal(res.verify.ok, true)
    assert.deepEqual(res.verify.checks.map((c) => c.code), [
      'entry-file-present', 'installed-package-version', 'legion-link-present',
    ])
  })

  test('★★★ readActiveRuntime 的四个读数必须分开：absent / unreadable / broken / active', () => {
    const f = fixture('states')
    // ① 干净机器：没有指针 = absent（正常读数，不是错误）。
    const absent = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(absent.state, 'absent')
    assert.equal(absent.code, null)

    // ② 指针在、读不懂 = unreadable。它与 absent 的下一步动作完全不同。
    const root = runtimeRootOf({ dataDir: f.dataDir })
    mkdirSync(root.runtimeRoot, { recursive: true })
    writeFileSync(root.pointerPath, '{ 这不是 JSON\n', 'utf8')
    const unreadable = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(unreadable.state, 'unreadable')
    assert.equal(unreadable.code, RUNTIME_INSTALL_CODES.POINTER_UNREADABLE)

    // ③ 指针指着一个没有完成标记的目录 = broken（**不是** active）。
    const orphan = runtimePathsOf({ dataDir: f.dataDir, targetVersion: '0.1.5-rc.2' }).versionDir
    mkdirSync(orphan, { recursive: true })
    writeFileSync(root.pointerPath, `${JSON.stringify({ version: '0.1.5-rc.2', dir: orphan })}\n`, 'utf8')
    const broken = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(broken.state, 'broken')
    assert.equal(broken.code, RUNTIME_INSTALL_CODES.ACTIVE_RUNTIME_INCOMPLETE)

    // ④ 补上完成标记与入口之后才是 active。
    installOk(f, planFor(f, { targetVersion: '0.1.7', expectedPatchVersion: 2 }))
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')
  })
})

// ============================================================================
// 三、回滚：一次真实读数
// ============================================================================

describe('PRT-257 DSH 运行时回滚', () => {
  test('★★★★★ 回滚把指针真的指回旧目录 —— 断言的是磁盘终态', () => {
    const f = fixture('rollback')
    installOk(f, planFor(f))
    installOk(f, planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 }))

    const active = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(active.version, '0.1.6')
    assert.equal(active.previousVersion, '0.1.5-rc.2')

    const res = rollbackRuntime({ dataDir: f.dataDir })
    assert.equal(res.ok, true, `${res.code} ${res.message}`)
    assert.equal(res.from, '0.1.6')
    assert.equal(res.to, '0.1.5-rc.2')

    // ★ 磁盘终态：指针文件里写的是谁，以及**它的入口文件在不在**。
    const expectedDir = runtimePathsOf({ dataDir: f.dataDir, targetVersion: '0.1.5-rc.2' }).versionDir
    const pointer = readPointer(f.dataDir)
    assert.equal(pointer.version, '0.1.5-rc.2')
    assert.equal(pointer.dir, expectedDir)
    assert.equal(existsSync(join(pointer.dir, NODE_MODULES_DIRNAME, DEFAULT_DSH_PACKAGE, DEFAULT_ENTRY_RELPATH)), true,
      '回滚之后指针指着的目录里没有入口文件')

    const after = readActiveRuntime({ dataDir: f.dataDir })
    assert.equal(after.state, 'active')
    assert.equal(after.version, '0.1.5-rc.2')
    assert.equal(after.entryExists, true)

    // 回滚是**可逆**的：切走的那一版被记进了 previous，所以能再切回来。
    const back = rollbackRuntime({ dataDir: f.dataDir })
    assert.equal(back.ok, true)
    assert.equal(back.to, '0.1.6')
    assert.equal(readPointer(f.dataDir).version, '0.1.6')
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')
  })

  test('★★★★ 没有可回滚的目标 / 目标不完整 → 拒绝，且指针不动', () => {
    const f = fixture('rollback-refuse')
    // ① 从来没有装过。
    const never = rollbackRuntime({ dataDir: f.dataDir })
    assert.equal(never.ok, false)
    assert.equal(never.code, RUNTIME_INSTALL_CODES.ROLLBACK_UNAVAILABLE)
    assert.equal(never.entryExists, false)

    // ② 装了两次，但旧版本被"半装化"了（完成标记不见了）——这时回滚会把现役指向一个半装目录。
    installOk(f, planFor(f))
    installOk(f, planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 }))
    rmSync(markerOf(f.dataDir, '0.1.5-rc.2'), { force: true })

    const res = rollbackRuntime({ dataDir: f.dataDir })
    assert.equal(res.ok, false)
    assert.equal(res.code, RUNTIME_INSTALL_CODES.ROLLBACK_TARGET_INCOMPLETE)
    assert.match(res.message, /半装目录/)
    // 指针**没有**被这次失败的回滚动过。
    assert.equal(readPointer(f.dataDir).version, '0.1.6')
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).state, 'active')

    // ③ 入口文件不在，同样拒绝。
    writeFileSync(markerOf(f.dataDir, '0.1.5-rc.2'), `${JSON.stringify({ version: '0.1.5-rc.2' })}\n`, 'utf8')
    rmSync(entryOf(f.dataDir, '0.1.5-rc.2'), { force: true })
    const res2 = rollbackRuntime({ dataDir: f.dataDir })
    assert.equal(res2.ok, false)
    assert.equal(res2.code, RUNTIME_INSTALL_CODES.ROLLBACK_TARGET_INCOMPLETE)
    assert.equal(readPointer(f.dataDir).version, '0.1.6')
  })
})

// ============================================================================
// 四、写入边界：shipped preset 一律只读
// ============================================================================

describe('PRT-257 写入边界', () => {
  test('★★★★ 守卫逐次挡下越界写入（只读根之内 / 允许根之外）', () => {
    const f = fixture('guard')
    mkdirSync(f.dataDir, { recursive: true })
    const guard = createRuntimeWriteGuard({
      fs: {
        mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, copyFileSync, unlinkSync, chmodSync,
      },
      writableRoot: f.dataDir,
      readOnlyRoots: [f.installDir, f.shippedPresetRoot],
      allowedLinkTargets: [f.installDir],
    })

    const denied = (fn) => {
      try { fn(); return null } catch (e) { return e }
    }

    // ① shipped preset install —— PRT-011 §2.4 明写只读。
    const inPreset = denied(() => guard.writeFile(join(f.shippedPresetRoot, 'web', 'cordis.patch.yml'), 'x'))
    assert.ok(inPreset !== null, '往 shipped preset 里写竟然没有被挡下')
    assert.equal(inPreset.code, RUNTIME_INSTALL_CODES.WRITE_REFUSED)

    // ② InstallDir —— PRT-011 §2.1（引 PRT-001 §2.1）明写不许写。
    const inInstall = denied(() => guard.mkdir(join(f.installDir, 'data')))
    assert.equal(inInstall?.code, RUNTIME_INSTALL_CODES.WRITE_REFUSED)
    assert.match(inInstall.message, /只读根/)

    // ③ 允许根之外。
    const outside = denied(() => guard.writeFile(join(f.root, 'elsewhere.txt'), 'x'))
    assert.equal(outside?.code, RUNTIME_INSTALL_CODES.WRITE_REFUSED)

    // ④ 链接目标必须是被声明过的来源根：一个能指向任意位置的链接与一次任意写入同量级。
    const badLink = denied(() => guard.symlink(join(f.root, 'somewhere'), join(f.dataDir, 'link')))
    assert.equal(badLink?.code, RUNTIME_INSTALL_CODES.WRITE_REFUSED)

    // ⑤ 允许根之内照常通行，而且被记下来了。
    guard.writeFile(join(f.dataDir, 'ok.txt'), 'ok')
    assert.equal(existsSync(join(f.dataDir, 'ok.txt')), true)
    assert.ok(guard.calls.some((c) => c.op === 'write' && c.path.endsWith('ok.txt')))

    // ⑥ 只读这一条必须**单独**能拦住人：把允许根放大到包含 shipped preset，
    //    于是唯一还能拒绝它的是"只读根"这一条。没有这一格，上面 ① 的红
    //    有可能是"越出允许根"替它红出来的——两条判据长得一样，就分不清是哪条在守。
    const wide = createRuntimeWriteGuard({
      fs: { mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, copyFileSync, unlinkSync, chmodSync },
      writableRoot: f.root,
      readOnlyRoots: [f.shippedPresetRoot],
    })
    const stillDenied = denied(() => wide.writeFile(join(f.shippedPresetRoot, 'web', 'cordis.patch.yml'), 'x'))
    assert.equal(stillDenied?.code, RUNTIME_INSTALL_CODES.WRITE_REFUSED,
      '把允许根放大之后，往 shipped preset 里写竟然通过了——"只读"这一条不是独立判据')
    assert.match(stillDenied.message, /只读根/)
  })

  test('★★★★ 整轮安装没有一次写入落在只读根上（不是"文档里写着只读"）', () => {
    const f = fixture('guard-e2e')
    const before = snapshot(f.shippedPresetRoot)
    const presetBytes = readFileSync(join(f.shippedPresetRoot, 'web', 'cordis.yml'))

    const spy = spyFs()
    const plan = planFor(f)
    const res = installRuntime({ plan, runner: fakeRunner(), fs: spy })
    assert.equal(res.ok, true, res.message)

    // ★ 不vacuous：探针**真的**看见了一堆写入（否则下面那条"一处都没有"什么也没证明）。
    assert.ok(spy.mutating.length > 5, `fs 探针只看见 ${spy.mutating.length} 次变更调用，这条断言几乎是空的`)
    assert.ok(res.writes.length > 5)
    // 每一次变更调用都必须在 DataDir 之内，且不在任何一个只读根之内。
    for (const c of spy.mutating) {
      assert.equal(isPathInside(f.shippedPresetRoot, c.path), false, `${c.op} 落在了 shipped preset 里：${c.path}`)
      assert.equal(isPathInside(f.installDir, c.path), false, `${c.op} 落在了 InstallDir 里：${c.path}`)
    }
    for (const w of res.writes) {
      assert.equal(isPathInside(f.shippedPresetRoot, w.path), false)
      assert.equal(isPathInside(f.installDir, w.path), false)
      assert.ok(samePath(w.path, plan.writableRoot) || isPathInside(plan.writableRoot, w.path), `写入越界：${w.path}`)
    }

    // shipped preset 逐字节没变。
    assert.deepEqual(snapshot(f.shippedPresetRoot), before)
    assert.deepEqual(readFileSync(join(f.shippedPresetRoot, 'web', 'cordis.yml')), presetBytes)
  })
})

// ============================================================================
// 五、Legion 自己的四个 file: 包
// ============================================================================

describe('PRT-257 Legion 自有包的可达性', () => {
  test('★★★★ 四个包通过 junction 从装好的运行时可达（PRT-011 §3 第 3 条）', () => {
    const f = fixture('legion-links')
    const plan = planFor(f)
    const res = installOk(f, plan)

    assert.equal(res.legion.route, LEGION_ROUTE_JUNCTION)
    assert.deepEqual([...res.legion.linked].sort(), LEGION_FILE_PACKAGES.map((p) => p.name).sort())

    for (const l of plan.legion.links) {
      // 是链接，不是拷贝：pnpm 的 `file:` 是复制快照，改源码不生效（PRT-010 §2.3）。
      assert.equal(lstatSync(l.linkPath).isSymbolicLink(), true, `${l.name} 不是链接`)

      // ★ "可达"是一次读穿链接的读数，不是"那个路径存在"。
      //   注意：这个探针文件是**用例**写的（用来证明链接真的解析），不是安装器写的。
      const probe = `probe-${l.repoDir}.txt`
      writeFileSync(join(l.sourceDir, probe), `经由 ${l.name} 读到的\n`, 'utf8')
      assert.equal(readFileSync(join(l.linkPath, probe), 'utf8'), `经由 ${l.name} 读到的\n`,
        `${l.name} 的链接没有解析到源目录`)
    }

    // 源目录不在时必须拒绝，而不是建一个指向空处的链接。
    const f2 = fixture('legion-missing')
    rmSync(join(f2.installDir, 'plugins'), { recursive: true, force: true })
    const res2 = installRuntime({ plan: planFor(f2), runner: fakeRunner() })
    assert.equal(res2.ok, false)
    assert.equal(res2.code, RUNTIME_INSTALL_CODES.LEGION_SOURCE_MISSING)
    assert.match(res2.message, /指向空处/)
    assert.equal(res2.movedPointer, false)
    // 拒绝发生在版本目录被创建**之前**。
    assert.equal(existsSync(runtimePathsOf({ dataDir: f2.dataDir, targetVersion: '0.1.5-rc.2' }).versionDir), false)
  })

  test('与既有实现的共享约定：versions 目录名一致（两处字面量不许漂移）', () => {
    // `runtime-install.mjs` 与 `product/upgrade/switchover.mjs` 各自持有一份
    // 版本目录名。它们住在两棵树里（DataDir 的运行时 / 安装目录的程序），
    // 但**同一个字面量**——漂移会让"哪一棵树里有几个版本"这个问题的答案分叉。
    assert.equal(VERSIONS_DIRNAME, SWITCHOVER_VERSIONS_DIRNAME)
    // 指针文件名刻意不同（两条指针指的不是同一件事），所以只断言"都叫 `.json`、都住在根上"。
    assert.equal(POINTER_FILENAME.endsWith('.json'), true)
    assert.equal(PREVIOUS_POINTER_FILENAME.endsWith('.json'), true)
    assert.match(ACTIVE_POINTER, /\.json$/)
    assert.notEqual(POINTER_FILENAME, ACTIVE_POINTER,
      '两个指针如果同名，一棵树里的指针会被另一棵的读者当成自己的')
  })
})

// ============================================================================
// 六、诚实边界
// ============================================================================

describe('PRT-257 诚实边界', () => {
  test('★★★★ 没有真的跑过 npm install：runner 是必填的结构性事实', () => {
    const f = fixture('honest-npm')
    const plan = planFor(f)

    // ① 模块**没有**缺省运行器。少传一个参数就抛，而不是"悄悄去联网"。
    assert.throws(() => installRuntime({ plan }), /runner/)
    assert.throws(() => installRuntime({ plan, runner: null }), /runner/)

    // ② 被执行的命令是假运行器记录下来的那一条；真 npm 一次也没有被起过。
    const runner = fakeRunner()
    const res = installRuntime({ plan, runner })
    assert.equal(runner.calls.length, 1)
    assert.equal(res.runnerCalls.length, 1)
    // ★ 这一段是**计划里的**那条命令（`kind: 'planned'`）。它是产品决定要跑什么，
    //   不是这一次真的起了哪个进程——后者在 `runnerCalls` 里另记一条
    //   （`kind: 'actual'`），而在本套件的假运行器下它**刻意缺席**：
    //   假运行器不回报 `invocation`，于是"真的起了哪个进程"在这条路径上
    //   确实没有读数。真运行器那一边由下面第八节覆盖。
    assert.equal(res.runnerCalls[0].kind, 'planned')
    assert.equal(res.runnerCalls.length, 1, '假运行器不该产出一条 actual 记录')
    assert.equal(res.invocation, null)
    assert.equal(res.runnerCalls[0].file, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    assert.deepEqual([...res.runnerCalls[0].args].slice(-1), ['@deepseek-ai/dsh@0.1.5-rc.2'])

    // ③ 落盘的东西是本用例造的假 DSH，不是任何一个真的 DSH 包。
    assert.match(readFileSync(plan.entryPath, 'utf8'), /假的 DSH 入口/)
    const installedPkg = JSON.parse(readFileSync(join(plan.packageDir, 'package.json'), 'utf8'))
    assert.equal(installedPkg.version, '0.1.5-rc.2')
    // 真的 `@deepseek-ai/dsh` 里至少还有自己的依赖树；这里只有两个文件。
    assert.deepEqual(readdirSync(plan.packageDir).sort(), ['lib', 'package.json'])

    // ④ 所以：**junction 这条路没有在任何一个真的装好的 DSH 上跑过。**
    //    这条断言是这一句的机器可读形式：链接指向的是仓库里的源码目录，
    //    而那个目录里并没有一个装好的 DSH（只有 package.json 与源码）。
    for (const l of plan.legion.links) {
      assert.equal(existsSync(join(l.sourceDir, 'node_modules')), false,
        `${l.name} 的源目录里出现了 node_modules —— 那说明这一跑碰到了某种真实安装，用例不再是"离线可重复"的`)
    }
  })

  test('★★★★ 安装校验不是 doctor 的替代品：它只说"字节装对了"', () => {
    const f = fixture('honest-doctor')
    const res = installOk(f, planFor(f))

    // ① 装好的运行时里，本模块的校验是 CLEAN —— 但它判的是三件磁盘上的事。
    assert.equal(res.verify.checks.length, 3)
    const plan = installationRepairPlan(res.verify)
    assert.equal(plan.ok, true)
    const clean = doctorReport({ plan, source: 'runtime-install' })
    assert.equal(clean.code, DOCTOR_CODES.CLEAN)
    assert.equal(clean.exitCode, DOCTOR_EXIT.CLEAN)

    // ② 校验没过时，翻出来的计划项一律是 `inspect-manually` ——
    //    本模块**没有**预置修法，编一个动作名会让报告说出一件没有代码会做的事。
    const broken = installationRepairPlan({
      ok: false,
      checks: [{
        code: 'entry-file-present', label: '运行时入口文件', ok: false,
        detail: '入口文件不在', why: '入口是"这个版本真的能起来"的唯一可执行判据',
      }],
    })
    const actionable = doctorReport({ plan: broken, source: 'runtime-install' })
    assert.equal(actionable.code, DOCTOR_CODES.ACTIONABLE)
    assert.equal(actionable.exitCode, DOCTOR_EXIT.ACTIONABLE)
    assert.equal(actionable.items[0].action, 'inspect-manually')
    assert.match(renderDoctor(actionable), /没有预置修法/)

    // ③ 真正要紧的那条边界：**强制面生没生效**这件事，本模块一个字都没说。
    //    doctor 的结论来自一个**跑着的** DSH 进程的自检；本模块从来没有起过任何进程。
    //    所以"没有诊断"必须是 NO_DIAGNOSIS（退出 3），不能被读成 CLEAN。
    const noDiagnosis = doctorReport({ refusal: { state: 'incompatible', autoExecutionForbidden: true, reasons: ['legion-enforcement-hard-floor'] } })
    assert.equal(noDiagnosis.code, DOCTOR_CODES.NO_PLAN)
    assert.equal(noDiagnosis.exitCode, DOCTOR_EXIT.UNDIAGNOSED)
    assert.notEqual(noDiagnosis.exitCode, clean.exitCode)
  })

  test('★ 计划与结果的 diagnostics 只记"值得留痕的读数"，不把成功说成风险', () => {
    const f = fixture('honest-diag')
    const fresh = planFor(f)
    assert.deepEqual([...fresh.diagnostics], [])

    // 降级是一条正路，但它**不是升级**——所以它必须出现在读数里。
    installOk(f, planFor(f, { targetVersion: '0.1.6', installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 }))
    const down = planFor(f, { targetVersion: '0.1.5-rc.2', installedVersion: '0.1.6', installedPatchVersion: 1 })
    assert.equal(down.ok, true, down.message)
    assert.equal(down.relation, 'downgrade')
    assert.equal(down.diagnostics.some((d) => d.code === 'runtime-install-downgrade'), true)

    // DSH 在动、补丁层没动：绑定表说这一对已知可用所以放行，但必须在读数里留下。
    const carried = planFor(f, { targetVersion: '0.1.7', expectedPatchVersion: 1, installedVersion: '0.1.5-rc.2', installedPatchVersion: 1 })
    assert.equal(carried.ok, false, '绑定表里没有 (0.1.7, 1) 这一对，必须拒绝')
    assert.equal(carried.code, RUNTIME_INSTALL_CODES.PATCH_PAIR_MISMATCH)
    assert.equal(carried.patchPair.side, 'patch')
    assert.equal(carried.detail.moved.dsh, true)
    assert.equal(carried.detail.moved.patch, false)
  })
})

// ============================================================================
// 七、自检：导出的名字与形状（供父级接线用）
// ============================================================================

describe('PRT-257 导出面', () => {
  test('具名码无重复、全部是 SCREAMING_SNAKE、且都能在计划/结果里出现', () => {
    const codes = Object.values(RUNTIME_INSTALL_CODES)
    assert.equal(new Set(codes).size, codes.length, '有两个码取同一个值')
    for (const c of codes) assert.match(c, /^RUNTIME_INSTALL_[A-Z0-9_]+$/)
    // 计划形状的字段名（父级要照着接线）。
    const plan = planFor(fixture('exports'))
    for (const key of [
      'ok', 'stage', 'code', 'message', 'relation', 'targetVersion', 'versionDir', 'versionsDir',
      'runtimeRoot', 'entryPath', 'markerPath', 'pointerPath', 'previousPointerPath',
      'installCommand', 'legion', 'readOnlyRoots', 'writableRoot', 'targetDirPolicy',
      'patchPair', 'patchPairMoved', 'diagnostics', 'repair',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(plan, key), `计划里少了 ${key}`)
    }
  })

  test('verifyInstallation 是可直接单测的纯读数（不依赖 installRuntime）', () => {
    const f = fixture('verify-direct')
    const plan = planFor(f)
    const bare = verifyInstallation({ plan })
    assert.equal(bare.ok, false)
    assert.deepEqual(bare.checks.map((c) => c.code), [
      'entry-file-present', 'installed-package-version', 'legion-link-present',
    ])
    assert.match(bare.checks[0].why, /半装的 npm 安装上全绿/)
  })

  test('createNpmRunner：命令怎么拼、失败怎么读 —— spawn 也是注入的，所以不联网', () => {
    // 这一段测的是**真实运行器**的接线（文件、参数、超时、stdio），
    // 但 `spawn` 被换成假的：于是它既覆盖了生产那条路径，又仍然是离线的。
    const seen = []
    const fakeSpawn = (file, args, opts) => {
      seen.push({ file, args, opts })
      return { status: 0, stdout: 'added 1 package', stderr: '', error: undefined }
    }
    const runner = createNpmRunner({ spawn: fakeSpawn, env: { PATH: '/nowhere' } })
    const cmd = { file: 'npm', args: ['install', '--prefix', '/tmp/x', '@deepseek-ai/dsh@0.1.5-rc.2'] }
    const ok = runner(cmd, { cwd: '/tmp/x' })

    assert.equal(ok.ok, true)
    assert.equal(ok.status, 0)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].file, 'npm')
    // stderr 必须被**接住**：npm 失败时唯一有信息量的东西在它里面。
    assert.deepEqual(seen[0].opts.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(typeof seen[0].opts.timeout, 'number')
    assert.equal(seen[0].opts.windowsHide, true)
    assert.equal(seen[0].opts.cwd, '/tmp/x')
    // ★ 真的起了哪个进程，也要读得到（计划里那条与它可能不是同一条）。
    assert.equal(ok.invocation.file, 'npm')
    assert.equal(ok.invocation.plannedFile, 'npm')
    assert.equal(ok.invocation.timeoutMs, 600_000)
    assert.equal(typeof ok.elapsedMs, 'number')

    // 非零退出、以及"根本没起来"（error），是两种不同的读数。
    const failing = createNpmRunner({ spawn: () => ({ status: 1, stdout: '', stderr: 'npm ERR!', error: undefined }) })
    assert.equal(failing(cmd).ok, false)
    assert.equal(failing(cmd).status, 1)
    const broken = createNpmRunner({ spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT npm') }) })
    assert.equal(broken(cmd).ok, false)
    assert.match(broken(cmd).error, /ENOENT npm/)
  })

  test('★★★★ resolveNpmInvocation：Windows 上的 .cmd 垫片**必须**被翻成 node + cli 脚本', () => {
    // 判据全部注入（`platform` / `execPath` / `exists`），所以这一段在任何平台上
    // 都逐条可验证，且不依赖这台机器上真的有 npm。
    const cli = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    const win = (over = {}) => resolveNpmInvocation({
      command: { file: 'npm.cmd', args: ['install', '--prefix', 'C:\\d', 'pkg@1.0.0'] },
      platform: 'win32', execPath: 'C:\\nodejs\\node.exe', exists: (p) => p === cli, ...over,
    })

    // ① Windows + `.cmd` → 翻成 `node <cli>`，参数**逐字**搬过去。
    const r = win()
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'node-cli')
    assert.equal(r.file, 'C:\\nodejs\\node.exe')
    assert.deepEqual([...r.args], [cli, 'install', '--prefix', 'C:\\d', 'pkg@1.0.0'])
    // 参数里带空格的路径不许被切开：它是数组元素，不是拼出来的一行字。
    const spaced = win({ command: { file: 'npm.cmd', args: ['--prefix', 'C:\\Program Files\\Legion'] } })
    assert.deepEqual([...spaced.args].slice(-2), ['--prefix', 'C:\\Program Files\\Legion'])

    // ② 垫片解析不出来 → **具名拒绝**，且**不回落**到直接 spawn 那个 .cmd。
    const missing = win({ exists: () => false })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, NPM_RUNNER_CODES.INVOCATION_UNRESOLVED)
    assert.equal(missing.file, null)
    assert.equal(missing.args, null)
    assert.match(missing.message, /not.*安装失败|这不是"安装失败"/)
    assert.ok(missing.candidates.length >= 1, '拒绝里要给出试过哪些候选路径')

    // ③ 非 Windows / 非垫片 → 原样直通（不许对 `.exe` 也套一层 node）。
    const posix = win({ platform: 'linux', execPath: '/usr/bin/node' })
    assert.equal(posix.mode, 'direct')
    assert.equal(posix.file, 'npm.cmd')
    const exe = win({ command: { file: process.execPath, args: ['x'] } })
    assert.equal(exe.mode, 'direct')
    assert.equal(exe.file, process.execPath)
    // ④ 裸的 `npm.cmd`（不带目录）不许推出一个**相对**候选：落点取决于 cwd。
    const bare = resolveNpmInvocation({
      command: { file: 'npm.cmd', args: [] }, platform: 'win32',
      execPath: 'C:\\nodejs\\node.exe', exists: () => false,
    })
    assert.equal(bare.candidates.some((c) => !isAbsolute(c)), false,
      `候选里出现了相对路径：${JSON.stringify(bare.candidates)}`)

    // ⑤ 解析不出来时，运行器**一个进程都不起**：`status` 是 null（不是 0 也不是 1）。
    const spawned = []
    const runner = createNpmRunner({
      spawn: (...a) => { spawned.push(a); return { status: 0, stdout: '', stderr: '', error: undefined } },
      platform: 'win32', execPath: 'C:\\nodejs\\node.exe', exists: () => false,
    })
    const res = runner({ file: 'npm.cmd', args: ['install'] })
    assert.equal(res.ok, false)
    assert.equal(res.status, null)
    assert.equal(res.code, NPM_RUNNER_CODES.INVOCATION_UNRESOLVED)
    assert.equal(res.invocation, null)
    assert.equal(spawned.length, 0, '解析不出来却还是起了一个进程')
  })
})

// ============================================================================
// 八、**真的**跑一次 npm / **真的**制造一次 EPERM
//
// 这一节存在的理由，是前面七节全部合起来也证明不了的那两件事：
//
//   > 一套"全部注入假运行器"的安装器用例，
//   > 与一套"生产运行器在 Windows 上 100% 起不来"的实现，
//   > 在测试报告上是同一片绿。
//
// 实测结论（本节把它变成可重复的读数）：
//   · `spawnSync('npm.cmd', args)` 在 Windows 上 **EINVAL**（Node 2024-04 安全发布后
//     `.cmd`/`.bat` 不带 `shell:true` 一律拒绝）——见 `resolveNpmInvocation` 的文件注释；
//   · 而 `node <npm-cli.js>` 能跑，并且真的把包装进了 `node_modules/`。
//
// ## 这两条用例**不需要网络**，但仍然**真的**起 npm 进程
//
// 装的是一个**本地目录**（`file:` 源），npm 对它不做任何网络请求；
// 而且参数里带 `--offline`。用例第一次跑实测 843 ms。
// 于是"这一跑真的经过 npm"是一个可重复的事实，不是一句注释——
// 而"它会不会因为 CI 没网而红"这件事被排除了。
//
// 真 npm 找不到时**跳过**（而不是静默通过）：`t.skip()` 会在报告里留痕。
// ============================================================================

/** 这台机器上 npm 的 CLI 脚本（Node 官方发行包的布局）。找不到返回 `null`。 */
function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), NODE_MODULES_DIRNAME, 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', NODE_MODULES_DIRNAME, 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((p) => { try { return existsSync(p) } catch { return false } }) ?? null
}

/** 真的起一次 npm，参数是"装一个本地目录"。 */
function realNpmInstall({ npmCli, prefix, sourceDir, extra = [] }) {
  return spawnSync(process.execPath, [
    npmCli, 'install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund',
    '--loglevel=error', '--offline', ...extra, `file:${sourceDir}`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 造一个本地"DSH 包"目录（不是真的 dsh，用例造的，但 npm 认它是一个包）。 */
function localDshPackage(root, version = '9.9.9-probe') {
  const dir = join(root, 'local-dsh-pkg')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: DEFAULT_DSH_PACKAGE, version, bin: { dsh: 'lib/bin.js' }, files: ['lib/*.js'],
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'lib', 'bin.js'), 'process.exit(0)\n', 'utf8')
  return dir
}

describe('PRT-257 真运行器：真的起 npm、真的 EPERM（不联网）', () => {
  test('★★★★★ 真的 npm install 一次本地包：`node <npm-cli>` 这条路真的装得进去', (t) => {
    const npmCli = npmCliPath()
    if (npmCli === null) {
      // ★ `t.skip()` 而不是提前 return：静默 return 会让"这条用例从来没跑过"
      //   与"它跑绿了"在报告上长得一模一样。
      return t.skip('这台机器上找不到 npm 的 CLI 脚本（不是 Node 官方布局）')
    }
    const root = tempRoot('real-npm')
    const source = localDshPackage(root)
    const prefix = join(root, 'runtime', 'dsh', 'versions', '9.9.9-probe')
    // ★ 版本目录先建出来：**生产路径就是这样**（`runtime-install.mjs` 的第 4 步先
    //   `mkdir` 再跑 npm），而且 `spawnSync` 的 `cwd` 不存在时会直接 ENOENT——
    //   那会让这条用例红在一个与 npm 无关的原因上。
    mkdirSync(prefix, { recursive: true })

    // ① ★ 先用**实测**钉住那个 bug 本身：直接 spawn 一个 `.cmd` 垫片在 Windows 上起不来。
    if (process.platform === 'win32') {
      const direct = spawnSync('npm.cmd', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      assert.notEqual(direct.status, 0, 'npm.cmd 竟然直接跑起来了 —— Node 的行为变了，这段注释要重写')
      assert.match(String(direct.error?.message ?? direct.error ?? ''), /EINVAL/,
        `直接 spawn .cmd 的失败原因不是 EINVAL：${direct.error?.message ?? direct.error}`)
    }

    // ② **生产运行器**跑真 npm。不是用例自己拼的命令行——用的是 `createNpmRunner()`。
    const runner = createNpmRunner()
    const res = runner({
      file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund',
        '--loglevel=error', '--offline', `file:${source}`],
    }, { cwd: prefix })

    assert.equal(res.ok, true,
      `真 npm 没装成：status=${res.status} code=${res.code ?? '-'} error=${res.error ?? '-'}\n`
      + `stderr=${String(res.stderr).slice(-800)}\ninvocation=${JSON.stringify(res.invocation)}`)
    // ③ 它**回报了自己真的起了哪个进程**：Windows 上是 `node <npm-cli>`，
    //    而不是计划里那个起不来的 `npm.cmd`。
    assert.ok(res.invocation !== null, '真运行器没有回报 invocation')
    assert.equal(res.invocation.plannedFile, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    assert.equal(res.invocation.file, process.execPath)
    if (process.platform === 'win32') {
      assert.equal(res.invocation.mode, 'node-cli')
      assert.equal(res.invocation.args[0], npmCli)
    }
    assert.equal(typeof res.elapsedMs, 'number')

    // ④ 磁盘上的**结果**：真 npm 写出了 package.json 与入口文件。
    const pkgDir = join(prefix, NODE_MODULES_DIRNAME, ...DEFAULT_DSH_PACKAGE.split('/'))
    const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    assert.equal(installed.version, '9.9.9-probe')
    assert.equal(existsSync(join(pkgDir, 'lib', 'bin.js')), true)
    // ⑤ 而且这个入口**能被执行**（它是真 npm 落下来的，不是用例写的）。
    const ran = spawnSync(process.execPath, [join(pkgDir, 'lib', 'bin.js')], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    })
    assert.equal(ran.status, 0)
  })

  test('★★★★★ 真的 EPERM：指针被另一个句柄占着时，切换**失败**且旧版本仍然现役', () => {
    if (process.platform !== 'win32') return // 这条读数是 Windows 的 rename 语义
    const f = fixture('real-eperm')
    const firstPlan = planFor(f)
    installOk(f, firstPlan)
    const pointerPath = join(f.dataDir, 'runtime', 'dsh', POINTER_FILENAME)
    const before = readFileSync(pointerPath, 'utf8')
    assert.match(before, /0\.1\.5-rc\.2/)

    // ★ 一个**真的**打开着的文件句柄（本进程内，不需要第二个进程、也没有孤儿）。
    //   实测：Node 在 Windows 上打开文件时不带 `FILE_SHARE_DELETE`，
    //   于是 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` 真的拿到 EPERM。
    const held = openSync(pointerPath, 'r')
    try {
      const second = installRuntime({
        plan: planFor(f, { targetVersion: '0.1.6', supportedRange: '=0.1.6', expectedPatchVersion: 1 }),
        runner: fakeRunner({ version: '0.1.6' }),
      })

      // ① 具名码 + 指针**没动**。
      assert.equal(second.ok, false, '指针被占着，切换竟然成功了')
      assert.equal(second.code, RUNTIME_INSTALL_CODES.POINTER_SWITCH_FAILED)
      assert.equal(second.movedPointer, false)
      assert.match(second.message, /EPERM/, `失败原因不是 EPERM：${second.message}`)
      // ② 磁盘终态：指针还是旧版本，而新目录**没有**完成标记那一层被当成现役。
      assert.equal(readFileSync(pointerPath, 'utf8'), before, '指针内容变了')
      const active = readActiveRuntime({ dataDir: f.dataDir })
      assert.equal(active.state, 'active')
      assert.equal(active.version, '0.1.5-rc.2', '现役版本被换成了没装完的那一个')
      assert.equal(active.entryPath, firstPlan.entryPath)
      // ③ 失败发生在**最后一步**：新目录确实被填满了（这是"半装"的真实模样），
      //    但它是靠完成标记与指针区分开的，不是靠"目录在不在"。
      const newDir = runtimePathsOf({ dataDir: f.dataDir, targetVersion: '0.1.6' }).versionDir
      assert.equal(existsSync(join(newDir, NODE_MODULES_DIRNAME)), true)
      // ④ ★ 而且失败**自己说出了**它留下的那个反直觉终态：
      //    0.1.6 是"装完了、但不是现役"，于是再装同一个版本会被 TARGET_DIR_EXISTS 挡下。
      //    不说这一句的话，第二次尝试的拒绝读起来像是"我明明没装成过"。
      assert.match(second.message, /TARGET_DIR_EXISTS|目标目录已存在|带着完成标记/)
      assert.equal(second.detail.orphanedVersionDir, newDir)
    } finally {
      closeSync(held)
    }
    // ⑤ 放开句柄之后，**同一个版本**仍然被拒（那条拒绝说的是真话），
    //    而**另一个版本**装得上——证明第 ①步的红只来自那个句柄。
    const retrySame = installRuntime({
      plan: planFor(f, { targetVersion: '0.1.6', supportedRange: '=0.1.6', expectedPatchVersion: 1 }),
      runner: fakeRunner({ version: '0.1.6' }),
    })
    assert.equal(retrySame.ok, false)
    assert.equal(retrySame.code, RUNTIME_INSTALL_CODES.TARGET_DIR_EXISTS)
    const other = installRuntime({
      plan: planFor(f, { targetVersion: '0.1.7', supportedRange: '=0.1.7', expectedPatchVersion: 2 }),
      runner: fakeRunner({ version: '0.1.7' }),
    })
    assert.equal(other.ok, true, `放开句柄后仍然装不上：${other.code} ${other.message}`)
    assert.equal(readActiveRuntime({ dataDir: f.dataDir }).version, '0.1.7')
  })
})

// ============================================================================
// 九、进度面：本线程被 `spawnSync` 挡住的这几分钟里，**别人**读得到什么
//
// 这一节的判断对象只有一句：**进度是真的活的，还是跑完才有的。**
//
//   > 一个"跑完之后 stderr 全文可见"的运行器，
//   > 与一个"跑的过程中就能被读到"的运行器，在成功的那次运行里是同一个东西——
//   > 只不过在卡住的那一次里，前者是十分钟的静默。
//
// `installRuntime` 是同步的（`cli.mjs` 同步调用它），所以本进程在 npm 跑的时候
// **不可能**报进度。于是这一节不去断言"有个回调被调了"（那可以是被伪造的），
// 而是起一个**真的第二个进程**去看那个日志文件：如果它在第一个进程还阻塞着的时候
// 就读到了"前半段"，那么"边产生边可见"这件事就被证明了。
//
// 这一节用的每一句断言都能在两个方向上错：把它改成"文件最终存在"会红，
// 改成"文件里有全部内容"也会红——因为那条断言在"跑完才写"的实现下同样成立。
// ============================================================================

/** 同步睡（测试里阻塞主线程是**故意**的：那正是被测的那种处境）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 轮询等一个文件出现（有上限；超时就返回 false）。 */
function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    sleepSync(50)
  }
  return false
}

describe('PRT-257 进度面：npm 输出边产生边可见', () => {
  test('★★★★★ 注入的 spawn 拿到的是**继承的文件描述符**，不是管道', () => {
    const root = tempRoot('log-fd')
    const logPath = join(root, 'npm-install.log')
    let seen = null
    const runner = createNpmRunner({
      // 假 spawn：把字节**真的**写进那个 fd 号（就像子进程会做的那样）。
      spawn: (file, args, opts) => {
        seen = { file, args, opts }
        const fd = opts.stdio[1]
        assert.equal(typeof fd, 'number', `stdio[1] 不是文件描述符：${JSON.stringify(opts.stdio)}`)
        assert.equal(opts.stdio[0], 'ignore')
        assert.equal(opts.stdio[1], opts.stdio[2], 'stdout 与 stderr 应当合流到同一个 fd')
        writeFileSync(join(root, 'probe'), '')
        appendFileSync(fd, 'npm http fetch GET 200\n')
        appendFileSync(fd, 'added 1 package\n')
        return { status: 0, stdout: '', stderr: '', error: undefined }
      },
    })
    const res = runner({ file: 'npm', args: ['install'] }, { cwd: root, logPath })
    assert.equal(res.ok, true)
    assert.equal(seen.opts.stdio.length, 3)
    assert.equal(res.logPath, logPath)
    assert.equal(res.logsCombined, true, 'stdout/stderr 合流这件事必须被说出来')
    assert.equal(res.stdout, '', '合流之后 stdout 不再单独可得')
    assert.match(res.stderr, /npm http fetch GET 200/)
    assert.match(res.stderr, /added 1 package/)
    assert.equal(res.invocation.logPath, logPath)
    // 日志文件真的在磁盘上（不是"我们以为写了"）。
    assert.match(readFileSync(logPath, 'utf8'), /added 1 package/)
  })

  test('★★★★ 不传 logPath 时**完全不改**原来的形状（管道 + stdout/stderr 分开）', () => {
    let seen = null
    const runner = createNpmRunner({
      spawn: (file, args, opts) => {
        seen = { file, args, opts }
        return { status: 0, stdout: 'out', stderr: 'err', error: undefined }
      },
    })
    const res = runner({ file: 'npm', args: ['install'] }, { cwd: '.' })
    assert.deepEqual(seen.opts.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(res.stdout, 'out')
    assert.equal(res.stderr, 'err')
    assert.equal(res.logPath, null)
    assert.equal(res.logsCombined, false)
  })

  test('★★ 日志开不出来**不算安装失败**（宁可没有进度面，也不能因此装不上）', () => {
    const runner = createNpmRunner({
      spawn: () => ({ status: 0, stdout: '', stderr: '', error: undefined }),
    })
    const root = tempRoot('log-unopenable')
    // 两种开不出来的方式，都必须落到同一档：
    //  ① 日志路径**是个目录**（Windows 上 `openSync(dir,'a')` 会成功——所以只
    //     "openSync 没抛"不足以说明写得出日志）；
    //  ② 父路径**是个文件**（`mkdirSync` 必然失败）。
    for (const logPath of [root, join(root, 'blocker', 'npm.log')]) {
      if (logPath !== root) writeFileSync(join(root, 'blocker'), 'not a directory\n', 'utf8')
      const res = runner({ file: 'npm', args: ['install'] }, { cwd: root, logPath })
      assert.equal(res.ok, true, `日志写不进去竟然让安装失败了（${logPath}）`)
      assert.equal(res.logPath, null, `${logPath} 被当成了可用的日志：${res.logPath}`)
      assert.equal(typeof res.logError, 'string')
      assert.equal(res.logBytes, 0)
    }
  })

  test('★★★★★ 真的第二个进程在**本线程还阻塞着**的时候读到了前一半', () => {
    const root = tempRoot('live-progress')
    const logPath = join(root, 'npm-install.log')
    const observationsPath = join(root, 'observations.json')
    const donePath = join(root, 'watcher-done')
    const childPath = join(root, 'slow-npm.mjs')
    const watcherPath = join(root, 'watcher.mjs')

    // 假 npm：先吐前半段，**卡住** 1.5 秒，再吐后半段并退出。
    writeFileSync(childPath, [
      "process.stdout.write('PHASE-ONE\\n')",
      'setTimeout(() => { process.stdout.write(\'PHASE-TWO\\n\'); process.exit(0) }, 1500)',
    ].join('\n'), 'utf8')
    // 观察者：每 50ms 读一次日志文件，把每一次读到的**全文**记下来。
    writeFileSync(watcherPath, [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
      `const log = ${JSON.stringify(logPath)}`,
      `const out = ${JSON.stringify(observationsPath)}`,
      `const done = ${JSON.stringify(donePath)}`,
      'const seen = []',
      'const deadline = Date.now() + 20000',
      'while (Date.now() < deadline) {',
      '  if (existsSync(log)) seen.push(readFileSync(log, "utf8"))',
      '  if (seen.some((s) => s.includes("PHASE-TWO"))) break',
      '}',
      'writeFileSync(out, JSON.stringify(seen))',
      'writeFileSync(done, "1")',
    ].join('\n'), 'utf8')

    // 观察者**先起**，而且是**异步**起的（`spawn`，不是 `spawnSync`）：
    // 它必须在主线程被那 1.5 秒的 `spawnSync` 挡住的时候**同时**在跑。
    // stdio 全部 `ignore`：不经管道，也就不会留下一个握着管道句柄的孤儿。
    const watcher = spawn(process.execPath, [watcherPath], { stdio: 'ignore', windowsHide: true })
    let watcherExited = false
    watcher.on('exit', () => { watcherExited = true })
    try {
      const runner = createNpmRunner()
      const beganAt = Date.now()
      const res = runner({ file: process.execPath, args: [childPath] }, { cwd: root, logPath })
      const finishedAt = Date.now()
      assert.equal(res.ok, true, `假 npm 没跑成：${res.status} ${res.error ?? ''}`)
      assert.ok(finishedAt - beganAt >= 1400,
        `它根本没有阻塞住（${finishedAt - beganAt}ms）——这一条就证明不了"主线程还阻塞着"`)

      const sawDone = waitForFile(donePath, 20_000)
      assert.equal(sawDone, true, '观察者没有收尾（它是独立的进程，不该被本进程的阻塞影响）')
      const seen = JSON.parse(readFileSync(observationsPath, 'utf8'))
      assert.ok(seen.length >= 2, `观察者只读了 ${seen.length} 次，这条断言证明不了"边产生边可见"`)
      // ★ 核心断言：观察者读到过**只有前半段**的那个中间态。
      //   一个"跑完才落盘"的实现下，它只会读到完整的两段（或者读到空）——
      //   也就是 `sawPartial` 恒为 false。
      const sawPartial = seen.some((s) => s.includes('PHASE-ONE') && !s.includes('PHASE-TWO'))
      assert.equal(sawPartial, true,
        `没有任何一次读数落在"前半段已写、后半段未写"之间：${JSON.stringify(seen)}`)
      // 而最终的日志里两段都在（它同时仍然是"错误详情"）。
      assert.match(readFileSync(logPath, 'utf8'), /PHASE-ONE[\s\S]*PHASE-TWO/)
    } finally {
      // 观察者自己会退，但**无论它退没退**都要收干净：一个还在轮询的孤儿进程
      // 比一条红的断言更糟（它会在整个测试跑完之后才消失）。
      if (watcherExited !== true) { watcher.kill(); }
    }
  })

  test('★★★★ installRuntime 把进度日志落在版本目录里，并把它报成一条读数', () => {
    const f = fixture('integration-log')
    const root = tempRoot('integration-log-root')
    const realRunner = createNpmRunner({
      spawn: (file, args, opts) => {
        // 只做"假 npm"该做的事：写几行输出到进度面，再把包写进 prefix。
        appendFileSync(opts.stdio[1], 'npm http fetch GET 200\nadded 1 package\n')
        const spec = args[args.length - 1]
        const at = spec.lastIndexOf('@')
        const pkg = spec.slice(0, at)
        const ver = spec.slice(at + 1)
        const prefix = args[args.indexOf('--prefix') + 1]
        const dir = join(prefix, NODE_MODULES_DIRNAME, ...pkg.split('/'))
        mkdirSync(join(dir, 'lib'), { recursive: true })
        writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: pkg, version: ver })}\n`, 'utf8')
        writeFileSync(join(dir, 'lib', 'bin.js'), '// 假的 DSH 入口（用例造的）\n', 'utf8')
        return { status: 0, stdout: '', stderr: '', error: undefined }
      },
    })
    const plan = planFor(f)
    const res = installRuntime({ plan, runner: realRunner })
    assert.equal(res.ok, true, `${res.code} ${res.message}`)
    // ① 结果里有 `npmLog` 这一条读数，位置在版本目录里（可写面之内）。
    assert.ok(res.npmLog !== null, '成功路径上没有 npmLog 读数')
    assert.equal(res.npmLog.path, join(plan.versionDir, NPM_LOG_FILENAME))
    assert.equal(res.npmLog.combined, true)
    assert.ok(res.npmLog.bytes > 0)
    assert.ok(isPathInside(plan.versionDir, res.npmLog.path), '进度日志落在了版本目录之外')
    // ② `stages` 里也留了一条，事后复盘能指着它说话。
    assert.ok(res.stages.some((s) => s.stage === 'npm-log' && s.ok === true))
    // ③ 失败时这条读数照样在（那时它最有用）。
    const f2 = fixture('integration-log-fail')
    const plan2 = planFor(f2)
    const failing = createNpmRunner({
      spawn: (file, args, opts) => {
        appendFileSync(opts.stdio[2], 'npm ERR! code EAI_AGAIN\n')
        return { status: 1, stdout: '', stderr: '', error: undefined }
      },
    })
    const bad = installRuntime({ plan: plan2, runner: failing })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /EAI_AGAIN/, '日志尾部的错误详情没有被带进失败文案')
    assert.equal(bad.npmLog.path, join(plan2.versionDir, NPM_LOG_FILENAME))
  })
})
