// desktop/update-wiring.test.mjs
// ============================================================================
// 桌面接线层：**六个读数真的都是在这里生产出来的**
//
// ## 为什么必须有这个文件
//
// 本批次修掉的六个"判据的输入没有生产方"的缺陷，全部落在这一层或它的下游：
//
//   `freeBytes` / `patchBindings` / `tasks` / `migrations` / 健康规格 / 闭包条目
//
// 修复之后每一个都在 `buildDesktopInstaller().install()` 里被生产出来——而这一层
// 在此之前**没有测试文件**，只有模块自检（它检查的是纯函数，看不到安装路径）。
//
// 也就是说：把这个文件里任何一行删掉，所有其它用例仍然全绿，而真实升级
// 会退回"每次安装都被拦"。这个文件存在的唯一理由就是让那件事不成立。
//
// ## 它怎么观测
//
// `buildDesktopInstaller` 内部的 `runInstallTransaction` 是真的，而它在
// **启动 helper 之前**会把事务文件写到磁盘上（`writeTransactionFile`）。
// 所以断言直接看那份文件——那是"桌面到底给了 helper 什么"的唯一真相。
//
// 进程边界之后的成功路径由 `product/update/integration.test.mjs` 覆盖，
// 这里只走到"文件已写好、接着去起进程"。所以下面的用例**预期**在
// `helper-handoff` 上失败（真的起不动 helper），而那正好也是 fail-closed
// 的一个证据：起不动 helper 时旧版本完好。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  WIRING_CHECKED, buildDesktopInstaller, readFreeBytes, readLauncherPorts, readPendingTasks,
  selfCheckWiringAsync,
} from './update-wiring.mjs'
import { migrationPlanDigest } from '../product/upgrade/migration.mjs'
import { DESKTOP_PROTOCOL_VERSION, parseRequest } from '../product/launcher/desktop-protocol.mjs'
import { createReleaseFixtureBundle, fakePackageBytes } from './update-wiring.testkit.mjs'

const CURRENT_VERSION = '1.0.0'
const NEXT_VERSION = '1.1.0'
const NOW_MS = Date.parse('2026-10-05T00:00:00Z')

/**
 * 一个假的 Launcher bridge：只回答接线层真正会问的几件事。
 *
 * ★ 它**模拟了停服务的效果**：`stop` 之后 `status` 里的进程列表变空。
 *
 *   这不是为了让用例通过——`verifyExit` 那条判据的用途正是"受管进程真的
 *   都退出了吗"，而一个"无论怎么 stop 都仍然报三个进程在跑"的替身会让
 *   每一次安装都停在 `verify-exit`（那是**对的**行为，只是它测不到后面的
 *   步骤）。替身必须能表达"已经退出"这个状态，否则它表达不了任何状态。
 */
function fakeBridge({ hubPort = 8787, workbenchPort = 5173, tasks = null, failTasks = false } = {}) {
  const calls = []
  let stopped = false
  return {
    calls,
    async request(type, payload = {}) {
      calls.push({ type, payload })
      if (type === 'status') {
        return {
          state: stopped ? 'stopped' : 'ready',
          // 停服务之后进程列表为空——`verifyExit` 就是看这个。
          processes: stopped ? [] : [
            { key: 'team-hub', state: 'ready', port: hubPort },
            { key: 'workbench', state: 'ready', port: workbenchPort },
            { key: 'whiteboard', state: 'ready', port: 8080 },
          ],
        }
      }
      if (type === 'tasks') {
        if (failTasks) throw Object.assign(new Error('bridge 断了'), { code: 'BRIDGE_EXITED' })
        // `null` 表示"读不到"（不是"没有任务"）。
        return tasks === null
          ? { ok: false, code: 'TASKS_UNREADABLE', reason: '读不到看板' }
          : { ok: true, tasks }
      }
      if (type === 'stop-claiming') return { state: 'stopped' }
      if (type === 'stop') { stopped = true; return { state: 'stopped' } }
      if (type === 'prepare-runtime') return { state: 'prepared' }
      return {}
    },
  }
}

/**
 * 造一套安装所需的目录与"当前版本"。
 *
 * ★ 清理要**重试**：这条用例走到 `spawnHelper` 时，真实的
 *   `runner.spawnHelper` 会**真的起一个 node 进程**（helper 入口故意不存在，
 *   所以它立刻失败），而 Windows 上那个进程的句柄关闭有一瞬间的延迟——
 *   期间对这个临时目录的删除会 `EPERM`。
 *
 *   那不是泄漏（进程随即退出），而是"删除与句柄关闭赛跑"。给 `rmSync`
 *   重试就够了，而把失败吞掉就不好了：一个真的泄漏会因此看不见。
 */
function scaffold(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-wiring-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }))
  const installRoot = join(root, 'install')
  const dataDir = join(root, 'data')
  const cacheDir = join(root, 'cache')
  for (const dir of [installRoot, dataDir, cacheDir]) mkdirSync(dir, { recursive: true })
  mkdirSync(join(installRoot, 'product', 'release'), { recursive: true })
  writeFileSync(
    join(installRoot, 'product', 'release', 'runtime-manifest.json'),
    `${JSON.stringify({
      manifestFormat: 'legion/version-manifest@1', productVersion: CURRENT_VERSION,
      legionVersion: CURRENT_VERSION, dshVersion: '0.8.3', dshCompositionPatchVersion: 2,
      runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
    }, null, 2)}\n`,
  )
  return { root, installRoot, dataDir, cacheDir }
}

/** 一个"已就绪"的合法升级包（内容不重要，但**摘要必须自洽**）。 */
function makePackage(root) {
  const packagePath = join(root, 'package.zip')
  const { bytes, sha256 } = fakePackageBytes()
  writeFileSync(packagePath, bytes)
  return { packagePath, sha256, sizeBytes: bytes.length }
}

// ---------------------------------------------------------------------------
// ① 六个读数
// ---------------------------------------------------------------------------

test('★★★ 安装时写进事务文件的东西：六个读数都有生产方', async (t) => {
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  const bridge = fakeBridge({ tasks: [] })
  let spawnedWith = null
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release

  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'),
    now: () => NOW_MS,
    // ★ 只替换**进程边界**：事务文件在起进程之前就写好了，所以"桌面到底给了
    //   helper 什么"在这条替身之下是完整可观测的。真起一个 node 会让
    //   Windows 上那个进程短暂持有临时目录的句柄，删除因此 `EPERM`。
    //
    //   形状要与 `runner.spawnHelper` 的判据一致：它检查 `child.pid` 是个数字
    //   （"起了"与"起了一个立刻死掉的"是两件事）。
    spawnImpl: (file, args, options) => {
      spawnedWith = { file, args, options }
      return { pid: 4242, unref() {} }
    },
  })

  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release,
    packagePath: pkg.packagePath,
  })

  // ★ 先断言"走到了交接"再去看文件：失败时 `buildDesktopInstaller` 会把
  //   事务文件**清掉**（一份指向没开始的升级的事务文件会让下一次恢复判定
  //   读到一个不存在的事务）。所以"文件不在"有两种可能——先排除第一种。
  assert.notEqual(result.reachedStep, 'recheck',
    `安装停在预检：${result.code} ${result.reason}`)
  assert.equal(result.verdict, 'handed-off',
    `安装没有走到交接：code=${result.code} verdict=${result.verdict} reachedStep=${result.reachedStep} ${result.reason}`)

  // ── 事务文件：这是"桌面到底给了 helper 什么"的唯一真相 ──
  const transactionPath = join(cell.dataDir, 'update', 'transaction.json')
  assert.equal(existsSync(transactionPath), true,
    '走到交接了却没有事务文件：helper 起来之后读不到该做什么')
  const transaction = JSON.parse(readFileSync(transactionPath, 'utf8'))

  assert.equal(transaction.txnId, result.txnId ?? transaction.txnId)
  assert.equal(transaction.fromVersion, CURRENT_VERSION)
  assert.equal(transaction.toVersion, NEXT_VERSION)
  assert.equal(transaction.packagePath, pkg.packagePath)
  assert.equal(transaction.packageSha256, pkg.sha256)

  // ★ 读数 ①：闭包条目（来自**签过名的**发行清单的 `package.closure*`）。
  assert.deepEqual(transaction.closureEntry, {
    path: release.package.closurePath,
    sha256: release.package.closureSha256,
  }, '闭包条目没有被写进事务文件：helper 解压时走"没有闭包"那条路')

  // ★ 读数 ②：健康检查规格（声明式，端口取**实际读数**）。
  assert.equal(transaction.healthProbeSpec?.protocol, 'legion/update-health@1',
    '健康规格没有被写进事务文件：helper 会 fail-closed 到永不提交')
  const teamHub = transaction.healthProbeSpec.checks.find((c) => c.name === 'team-hub')
  assert.equal(teamHub.port, 8787, '健康规格用的不是 bridge 报的实际端口')
  assert.deepEqual(teamHub.expectJson, { port: 8787 },
    'team-hub 的身份断言不对：它必须要求端口上就是本次启动的那个实例')
  const workbench = transaction.healthProbeSpec.checks.find((c) => c.name === 'workbench')
  assert.deepEqual(workbench.expectJson, { port: 8787 },
    'workbench 的身份断言不对：它必须要求"接上的 hub"是本次启动的那个（8787），'
    + '而不是它自己的端口')

  // ★ 读数 ③：迁移计划（当前为空，但**显式**给出，且与清单声明的摘要一致）。
  assert.deepEqual(transaction.migrations, [])
  assert.equal(release.migrationPlanDigest, migrationPlanDigest([]),
    '发行清单声明的迁移摘要与空计划不符：安装会被 install-migration-plan-mismatch 拦下')

  // ★ 读数 ④：任务读数（真的向 bridge 问过）。
  assert.equal(bridge.calls.some((c) => c.type === 'tasks'), true,
    '安装时没有向 Launcher 读在途任务：预检会判 unknown 并拦下每一次安装')

  // ★ 端口读数必须发生在**停服务之前**。
  //
  //   事务文件是在停服务之后写的，而端口是从 Launcher 的进程读数里取的。
  //   今天这条路能用，靠的是一个没写在任何地方的事实：`supervisor.status()`
  //   只给出 key/state/pid，端口是 `launcher.status()` 从 `plan.processes`
  //   补出来的，而那个 plan 在停止之后仍然在。一个"不再列出已停止进程"的
  //   清理会让健康规格**静默地**派生不出来。
  const order = bridge.calls.map((c) => c.type)
  const firstStatus = order.indexOf('status')
  const stopAt = order.indexOf('stop')
  assert.notEqual(firstStatus, -1, '安装没有读过 Launcher 的进程读数（端口从哪来？）')
  assert.notEqual(stopAt, -1, '安装没有停服务')
  assert.ok(firstStatus < stopAt,
    `端口读数发生在停服务之后（调用顺序 ${order.join(' → ')}）：`
    + '那意味着健康规格依赖"已停止的进程仍然出现在读数里"，'
    + '而那是没有保证的')

  // ★ 起进程时用的是**仓库里那份** helper 入口，且环境变量带全了。
  assert.notEqual(spawnedWith, null, '没有走到起 helper 进程')
  assert.deepEqual(spawnedWith.args, [join(cell.dataDir, 'helper-entry.mjs')])
  assert.equal(spawnedWith.options.env.LEGION_UPDATE_TXN, transaction.txnId)
  assert.equal(spawnedWith.options.env.LEGION_UPDATE_DATA_DIR, cell.dataDir)
  assert.equal(spawnedWith.options.env.LEGION_UPDATE_INSTALL_DIR, cell.installRoot)
  // ★ `detached` + `stdio: 'ignore'`：helper 必须在父进程退出之后继续跑。
  assert.equal(spawnedWith.options.detached, true)
  assert.equal(spawnedWith.options.stdio, 'ignore')

  // ★ 读数 ⑤⑥：`freeBytes` 与 `patchBindings` 是 `runInstallTransaction` 的入参，
  //   它们没有直接落盘，但**它们的效果**是可观测的：
  //   · 空间不足 → 预检 disk 判 blocked；
  //   · 补丁层不成对 → 预检 compatibility 判 blocked。
  //   两者都会让结果停在 recheck。所以这里断言"没有停在 recheck"。
  assert.notEqual(result.reachedStep, 'recheck',
    `停在预检上：${result.code} ${result.reason}`)
})

test('★★ 磁盘读数来自真实的 statfs（不是估出来的数）', () => {
  const free = readFreeBytes(process.cwd())
  assert.equal(Number.isSafeInteger(free), true)
  assert.ok(free > 0, `读到的可用空间是 ${free}`)
  // 读不到时必须是 `null`（预检判"没有磁盘读数"→ 拦），不是 0 也不是估的数。
  assert.equal(readFreeBytes(process.cwd(), { statfs: () => { throw new Error('nope') } }), null)
  assert.equal(readFreeBytes(''), null)
})

// ---------------------------------------------------------------------------
// ② 读不到时的方向（fail-closed）
// ---------------------------------------------------------------------------

test('★★★ bridge 读不到在途任务 → 预检拦，**不**当成"没有任务"', async (t) => {
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  const bridge = fakeBridge({ tasks: null })   // 读不到
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release
  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'), now: () => NOW_MS,
  })
  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release, packagePath: pkg.packagePath,
  })
  assert.equal(result.ok, false, '读不到任务读数却放行了安装')
  assert.equal(result.reachedStep, 'recheck')
  // ★ 原因必须是"没有拿到任务读数"，而不是别的——一个笼统的"预检未通过"
  //   会让排查方向完全错。
  assert.match(result.reason, /任务|tasks/i)
  // 而且**没有**写事务文件（拒绝发生在动任何东西之前）。
  assert.equal(existsSync(join(cell.dataDir, 'update', 'transaction.json')), false,
    '被拒绝的事务已经在磁盘上留下了痕迹')
})

test('★★ bridge 报错（不是"没有任务"）→ 同样拦', async (t) => {
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  const bridge = fakeBridge({ failTasks: true })
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release
  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'), now: () => NOW_MS,
  })
  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release, packagePath: pkg.packagePath,
  })
  assert.equal(result.ok, false, 'bridge 报错却放行了安装')
  assert.equal(result.reachedStep, 'recheck')
})

test('★★ 拿不到端口读数 → 不写健康规格（helper 会 fail-closed）', async (t) => {
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  // bridge 的 status 里没有 team-hub 的端口 → `readLauncherPorts` 返回 null
  // → 规格派生失败 → 不写规格。
  const bridge = {
    calls: [],
    async request(type) {
      this.calls.push({ type })
      if (type === 'status') return { state: 'ready', processes: [{ key: 'workbench', state: 'ready', port: 5173 }] }
      if (type === 'tasks') return { ok: true, tasks: [] }
      if (type === 'stop') return { state: 'stopped' }
      return {}
    },
  }
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release
  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'), now: () => NOW_MS,
  })
  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release, packagePath: pkg.packagePath,
  })
  // ★ 关键：**要么**没写规格（helper 会 fail-closed 不提交），
  //   **要么**写了规格但端口是真的。绝不能写一份"用默认端口凑出来"的规格。
  const transactionPath = join(cell.dataDir, 'update', 'transaction.json')
  if (existsSync(transactionPath)) {
    const transaction = JSON.parse(readFileSync(transactionPath, 'utf8'))
    if (transaction.healthProbeSpec !== undefined) {
      const ports = transaction.healthProbeSpec.checks.map((c) => c.port)
      assert.equal(ports.includes(8787), false,
        '拿不到端口读数却写了 8787（默认值）：健康检查会去问一个不存在于本次启动的实例，'
        + '而旧实例恰好响应时它会**看似通过**')
    }
  }
  void result
})

// ---------------------------------------------------------------------------
// ③ 读数函数本身
// ---------------------------------------------------------------------------

test('★ `readLauncherPorts` 只要真实读数，拿不到就 null', async () => {
  assert.equal(await readLauncherPorts({ bridge: null }), null)
  const ports = await readLauncherPorts({
    bridge: { request: async () => ({ processes: [{ key: 'team-hub', port: 9001 }, { key: 'workbench', port: 0 }] }) },
  })
  assert.deepEqual({ ...ports }, { 'team-hub': 9001 })
})

test('★ `readPendingTasks` 三态：读到 / 空 / 读不到', async () => {
  assert.equal(await readPendingTasks({ bridge: null }), null)
  assert.equal(await readPendingTasks({ bridge: { request: async () => { throw new Error('x') } } }), null)
  assert.equal(await readPendingTasks({ bridge: { request: async () => ({ ok: false }) } }), null)
  // `ok: true` 但缺 `tasks` 字段 → 同样是"读不到"（不能当成空）。
  assert.equal(await readPendingTasks({ bridge: { request: async () => ({ ok: true }) } }), null)
  // 真正的空数组是**合法**读数。
  const empty = await readPendingTasks({ bridge: { request: async () => ({ ok: true, tasks: [] }) } })
  assert.deepEqual([...empty], [])
})

test('★★ 停止/恢复认领走的是协议真有的类型（且 fake bridge 与真协议一致）', async (t) => {
  // ★ 这条断言的是**接线层与协议的对齐**，而不是它的行为：
  //
  //   本文件的 `fakeBridge` 自己实现 `stop-claiming`／`resume-claiming`。
  //   一旦真协议不认这两个类型，替身仍然会老老实实回答——于是用例全绿而
  //   真实路径第三步就崩。所以这里额外确认**真协议**认得它们
  //   （上面那条源码级判据已经在做），并且**接线层真的会发**它们。
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  const bridge = fakeBridge({ tasks: [] })
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release
  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'), now: () => NOW_MS,
    spawnImpl: () => ({ pid: 4242, unref() {} }),
  })
  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release, packagePath: pkg.packagePath,
  })
  assert.equal(result.verdict, 'handed-off', `${result.code} ${result.reason}`)
  const forwarded = bridge.calls.map((c) => c.type)
  assert.ok(forwarded.includes('stop-claiming'), `没有停止认领：${forwarded.join(' → ')}`)
  // ★ 正常路径（一路走到交接）**不该**发 `resume-claiming`：那时认领本就应该
  //   停着，而服务马上就要被停掉。恢复只属于**中止**路径。
  assert.equal(forwarded.includes('resume-claiming'), false,
    '正常路径也在恢复认领：那会让备份之后仍有认领者（而服务马上要停）')
  // 停止认领必须早于停服务。
  assert.ok(forwarded.indexOf('stop-claiming') < forwarded.indexOf('stop'),
    `顺序不对：${forwarded.join(' → ')}`)
})

test('★★★ 中止路径会把认领还回去（否则留下一个"再也领不到活"的 Legion）', async (t) => {
  const cell = scaffold(t)
  const pkg = makePackage(cell.root)
  const bridge = fakeBridge({ tasks: [] })
  const release = createReleaseFixtureBundle({
    productVersion: NEXT_VERSION, packageSha256: pkg.sha256, packageSizeBytes: pkg.sizeBytes,
  }).release
  const installer = buildDesktopInstaller({
    bridge, installRoot: cell.installRoot, dataDir: cell.dataDir, cacheDir: cell.cacheDir,
    helperEntry: join(cell.dataDir, 'helper-entry.mjs'), now: () => NOW_MS,
    // 备份失败 —— 一个"什么都没改"的中止路径（设计 §8 失败表第一行：
    // 「当前版本继续运行；不改变活动指针」）。
    spawnImpl: () => ({ pid: 4242, unref() {} }),
    snapshotFactory: () => ({ ok: false, snapshot: null, reason: '快照被拒绝' }),
  })
  const result = await installer.install({
    identity: {
      releaseId: release.releaseId, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64', manifestSha256: 'f'.repeat(64),
    },
    release, packagePath: pkg.packagePath,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reachedStep, 'backup')
  const forwarded = bridge.calls.map((c) => c.type)
  assert.ok(forwarded.includes('stop-claiming'), '没有停止认领')
  assert.ok(forwarded.includes('resume-claiming'),
    `中止之后没有恢复认领：${forwarded.join(' → ')}。用户会得到一个服务都在跑、`
    + '但再也领不到活的 Legion，而界面上没有任何东西提示这件事')
  assert.ok(forwarded.indexOf('stop-claiming') < forwarded.indexOf('resume-claiming'), '恢复早于停止')
})

test('模块自检全绿', async () => {
  assert.equal(WIRING_CHECKED.ok, true, JSON.stringify(WIRING_CHECKED.problems))
  const result = await selfCheckWiringAsync()
  assert.equal(result.ok, true, JSON.stringify(result.problems))
})

test('★★★ 接线层发给 Launcher 的每一条命令都是协议认得的', () => {
  // ★ 这条判据是补一次**真实的线上故障**：
  //
  //   `update-wiring.mjs` 一直在发 `stop-claiming`，而
  //   `desktop-protocol.mjs` 的 `TYPES` 里**没有**这个类型 ⇒ Launcher 以
  //   `UNKNOWN_TYPE` 拒绝 ⇒ 桌面抛错 ⇒ 安装事务判 `install-services-refused`
  //   并进维护态。**每一次真实安装都停在第三步。**
  //
  //   它没被发现，是因为本文件里的**替身 bridge 自己实现了** `stop-claiming`：
  //   写替身的人（我）照着调用方的期望写，于是替身比真货更能干，缺口被完美
  //   遮住。这与本批次那些"夹具替生产补上了缺失的入参"是同一件事，只是换成
  //   了**跨模块的命令名**。
  //
  //   > 一个比真货更能干的替身，测出来的是替身，不是系统。
  //
  //   所以这条判据**不看替身**，它拿接线层的源码去问真实的协议校验器：
  //   你认得这些类型吗？加一条新的 forward 命令而忘了加协议类型，这里就会红。
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'update-wiring.mjs'), 'utf8')
  const forwarded = [...new Set([...source.matchAll(/forward\('([^']+)'\)/g)].map((m) => m[1]))]
  assert.ok(forwarded.length >= 3, `没有从源码里认出任何 forward 命令（正则过期了？）：${JSON.stringify(forwarded)}`)
  for (const type of forwarded) {
    assert.doesNotThrow(
      () => parseRequest(JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, id: 'probe', type, payload: {} })),
      `接线层会发 ${type}，而桌面协议不认得它：真实路径上会被 UNKNOWN_TYPE 拒掉`,
    )
  }
  // 反向对照：一个真的不存在的类型必须被拒（否则上面那条判据恒真）。
  assert.throws(
    () => parseRequest(JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, id: 'probe', type: 'stop-claiming-typo', payload: {} })),
    /UNKNOWN_TYPE|未知/,
  )
})
