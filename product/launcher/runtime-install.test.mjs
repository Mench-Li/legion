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
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPLETION_MARKER_FILENAME, DEFAULT_DSH_PACKAGE, DEFAULT_ENTRY_RELPATH,
  LEGION_FILE_PACKAGES, LEGION_PACKAGE_PREFIX, LEGION_ROUTE_JUNCTION, NODE_MODULES_DIRNAME,
  POINTER_FILENAME, PREVIOUS_POINTER_FILENAME, RUNTIME_INSTALL_CODES, RUNTIME_INSTALL_VERSION,
  RUNTIME_ROOT_PARTS, TARGET_DIR_POLICY, VERSIONS_DIRNAME,
  compareDshVersions, createNpmRunner, createRuntimeWriteGuard, dshPatchPairOf, installationRepairPlan,
  installRuntime, parseDshVersion, planRuntimeInstall, readActiveRuntime,
  rollbackRuntime, runtimePathsOf, runtimeRootOf, verifyInstallation,
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

    // 非零退出、以及"根本没起来"（error），是两种不同的读数。
    const failing = createNpmRunner({ spawn: () => ({ status: 1, stdout: '', stderr: 'npm ERR!', error: undefined }) })
    assert.equal(failing(cmd).ok, false)
    assert.equal(failing(cmd).status, 1)
    const broken = createNpmRunner({ spawn: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT npm') }) })
    assert.equal(broken(cmd).ok, false)
    assert.match(broken(cmd).error, /ENOENT npm/)
  })
})
