// product/update/integration.test.mjs
// ============================================================================
// 全链路集成：发布端产出 → 静态托管 → 客户端检查/下载 → 安装事务 → helper → 提交
//
// ## 这个文件回答什么（以及它为什么必须存在）
//
// 本批次修掉了**六个**"判据的输入没有生产方"的缺陷（见实施记录 §6.0）。
// 它们的共同表现是：**各层的单元用例全绿，而真实链路一次都跑不通**——
// 因为每一层的夹具都替生产补上了缺失的入参。
//
// 所以这个文件**不注入任何业务读数**：
//
//   · 发行清单由 `publish.mjs` 真的签出来；
//   · 包由 `zip.mjs` 真的打出来（含包内 `closure.json`）；
//   · 托管是一个按目录布局应答的内存 HTTP 替身；
//   · 客户端用 `createUpdateClient` 的**真实**代码路径检查、下载、校验；
//   · 安装事务用 `runInstallTransaction`，读数由**真实函数**产出
//     （`readFreeBytes`、`statfsSync`、`migrationPlanDigest`、任务读数）；
//   · helper 用 `runHelper` 的真实实现（真解压、真验闭包、真切换）。
//
// 唯一被替身替代的是**进程边界**（helper 不真的另起进程）与**服务启停**
// （那是桌面/Launcher 的职责，本文件用记录型替身）。这两处在代码里都有
// 明确的注入点，所以这条链上"真实逻辑"的比例是最高的。
//
// ## 这条用例的价值在于它**会拦**
//
// 六个缺陷里任何一个回归（比如 `freeBytes` 又不传了、`migrationPlanDigest`
// 又不算了、`dshPatchBindings` 又缺席了），这条链都会停在预检上。也就是说
// 它是那六条判据的**联合守卫**——而它们各自的单测做不到这一点，因为
// 单测的夹具正好就是当年掩盖缺陷的东西。
// ============================================================================

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createUpdateClient } from './client.mjs'
import { runInstallTransaction } from './install.mjs'
import { runHelper, writeTransactionFile } from './helper.mjs'
import { readBarrier } from './barrier.mjs'
import { readJournal } from './journal.mjs'
import { issueCredential } from './credential.mjs'
import { createHostConfig, FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL } from './host.mjs'
import { healthSpecFromProcesses } from './health.mjs'
import { PROCESS_SPECS } from '../process-manifest.mjs'
import { createTrustStore, generateReleaseKeyPair } from './envelope.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST, migrationPlanDigest } from '../upgrade/migration.mjs'
import { buildPublish, writePublish } from '../../scripts/update/publish.mjs'

const ORIGIN = 'https://updates.example.com'
const PREFIX = '/legion'
const CURRENT_VERSION = '1.0.0'
const NEXT_VERSION = '1.1.0'
const NOW_MS = Date.parse('2026-10-05T00:00:00Z')

/** 与 `client.test.mjs` 同形：transport 读的是 `body` 流与 `headers.entries()`。 */
function response(status, headers, bytes) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    body: Readable.from(bytes.length === 0 ? [] : [bytes]),
  }
}

/**
 * 把 `writePublish` 的输出目录当成静态托管。
 *
 * ★ `writePublish` 把产物分成 `immutable/` 与 `channel/` 两个子树，正是为了
 *   让上传按顺序进行（设计 §9 line 202：**先**不可变文件、**最后**换通道清单）。
 *   托管侧把两者**合并**到同一个前缀下——真实的对象存储里它们就在一起。
 *
 * ★ 这个替身只做一件事：按目录把文件读出来、带上该有的 Cache-Control，
 *   并把整份字节返回（不像 `verify-host` 的探测那样只回 4 KiB）。
 *   它**不**做任何"帮客户端通过"的事——一个会补默认值的托管替身，
 *   与一个会补默认值的夹具是同一种东西。
 */
function staticHost(outDir, { origin = ORIGIN, prefix = PREFIX } = {}) {
  const files = new Map()
  const walk = (dir, parts) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = [...parts, entry.name]
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) { walk(absolute, next); continue }
      files.set(next.join('/'), {
        bytes: readFileSync(absolute),
        cache: next[0] === 'feeds' ? FEED_CACHE_CONTROL : RELEASE_CACHE_CONTROL,
      })
    }
  }
  walk(join(outDir, 'immutable'), [])
  walk(join(outDir, 'channel'), [])
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(url)
    const relative = url.slice(`${origin}${prefix}/`.length)
    const entry = files.get(relative)
    if (entry === undefined) return response(404, { 'cache-control': 'no-store' }, Buffer.alloc(0))
    return response(200, {
      'cache-control': entry.cache,
      'content-length': String(entry.bytes.length),
    }, entry.bytes)
  }
  fetchImpl.files = files
  fetchImpl.requests = requests
  return fetchImpl
}

/** 造一份"待发布的产品树"（与 `publish.mjs --package-root` 的输入同形）。 */
function writePayloadTree(root, productVersion) {
  const manifest = {
    manifestFormat: 'legion/version-manifest@1',
    productVersion,
    legionVersion: productVersion,
    dshVersion: '0.8.3',
    dshCompositionPatchVersion: 2,
    runtimeContractVersion: 1,
    packProtocolVersion: 1,
    schemaVersion: 1,
    channel: 'stable',
  }
  const files = [
    ['product/launcher/cli.mjs', '#!/usr/bin/env node\nconsole.log(1)\n'],
    ['product/release/runtime-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['runtime/dsh-composition/index.mjs', '// composition\n'],
  ]
  for (const [path, content] of files) {
    const target = join(root, ...path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return { manifest, files }
}

/** 一次完整的"发布 → 托管"。 */
function publishOnce(t) {
  const root = mkdtempSync(join(tmpdir(), 'legion-integration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const payloadRoot = join(root, 'payload')
  const { manifest } = writePayloadTree(payloadRoot, NEXT_VERSION)

  const keys = generateReleaseKeyPair({ keyId: 'integration-key' })
  const trustStore = createTrustStore([{ keyId: 'integration-key', publicKeyPem: keys.publicKeyPem }])

  const installerPath = join(root, 'Legion-Setup.exe')
  const notesPath = join(root, 'notes.zh-CN.txt')
  writeFileSync(installerPath, 'MZ pretend installer')
  writeFileSync(notesPath, '修复了若干问题。\n')

  const outDir = join(root, 'dist')
  const publish = buildPublish({
    productVersion: NEXT_VERSION,
    channel: 'stable',
    releaseId: `rel-${NEXT_VERSION}`,
    productManifest: manifest,
    supportedFromVersions: [CURRENT_VERSION],
    minWindowsBuild: 19045,
    // ★ 包由发布端**真的**打出来（含包内 `closure.json`）。
    packageRoot: payloadRoot,
    packageZipPath: null,
    installerPath,
    notesPath,
    // ★ 补丁层成对表：目标补丁层与它声明的 DSH 版本成对（设计 §6.3）。
    dshPatchBindings: [{ dshVersion: '0.8.3', compositionPatchVersion: 2 }],
    // ★ 迁移计划：当前产品没有迁移，所以是**空计划的真摘要**——
    //   不是占位串。客户端的判据是"声明 == 将要执行的集合"。
    migrationPlan: [],
    keyId: 'integration-key',
    privateKeyPem: keys.privateKeyPem,
    sequence: 7,
    issuedAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-04T00:00:00Z',
    outDir,
  })
  writePublish(publish, outDir)
  return { root, outDir, publish, trustStore, keys, payloadRoot, manifest }
}

function makeConfig(trustStore) {
  const host = createHostConfig({ origin: ORIGIN, prefix: PREFIX, channel: 'stable' })
  assert.equal(host.ok, true, host.reason)
  return {
    ok: true, usable: true, code: null, reason: null, channel: 'stable',
    host: host.host, trustStore, trustEntries: [], trustSequence: 1, checkOnStartup: true,
  }
}

test('★★★ 全链路：发布 → 托管 → 检查 → 下载 → 安装事务 → helper → 提交', async (t) => {
  const published = publishOnce(t)
  const fetchImpl = staticHost(published.outDir)

  // ── ① 客户端：检查 + 下载（真实代码路径）──
  const cacheDir = join(published.root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const client = createUpdateClient({
    config: makeConfig(published.trustStore),
    cacheDir,
    currentVersion: CURRENT_VERSION,
    hostPlatform: 'win32',
    localKernelRelease: '10.0.22631',   // 满足 minWindowsBuild: 19045
    fetchImpl,
    now: () => NOW_MS,
  })

  const checked = await client.check({ trigger: 'manual' })
  assert.equal(checked.outcome, 'available', `检查失败：${checked.code} ${checked.reason}`)
  assert.equal(checked.candidate.productVersion, NEXT_VERSION)

  const snapshotAfterCheck = client.snapshot()
  assert.equal(snapshotAfterCheck.ready, false)
  const downloaded = await client.download(
    checked.candidate.releaseId, checked.candidate.manifestSha256,
  )
  assert.equal(downloaded.ok, true, `下载失败：${downloaded.code} ${downloaded.reason}`)
  // ★ 包必须落在磁盘上，而且**不再是 `.part`**（设计 §6 line 140）。
  const packagePath = downloaded.path
  assert.equal(typeof packagePath, 'string')
  assert.equal(existsSync(packagePath), true, '下载报告的路径不存在')
  assert.equal(packagePath.endsWith('.part'), false, '就绪的包仍然是 .part')

  const snapshot = client.snapshot()
  assert.equal(snapshot.ready, true, '下载完成之后没有进入就绪状态')
  const release = client.release()
  assert.notEqual(release, null)

  // ── ② 安装事务：读数全部由**真实函数**产出 ──
  const installRoot = join(published.root, 'install')
  const dataDir = join(published.root, 'data')
  mkdirSync(join(installRoot, 'product', 'release'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  // 当前版本的清单（`current` 参数）。
  writeFileSync(
    join(installRoot, 'product', 'release', 'runtime-manifest.json'),
    `${JSON.stringify({
      manifestFormat: 'legion/version-manifest@1', productVersion: CURRENT_VERSION,
      legionVersion: CURRENT_VERSION, dshVersion: '0.8.3', dshCompositionPatchVersion: 2,
      runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
    }, null, 2)}\n`,
  )
  const current = JSON.parse(readFileSync(join(installRoot, 'product', 'release', 'runtime-manifest.json'), 'utf8'))

  const helperDir = join(published.root, 'update')
  mkdirSync(helperDir, { recursive: true })
  writeFileSync(join(helperDir, 'helper-entry.mjs'), '// entry\n')

  const txnId = 'it-fullchain'
  const packageSha256 = createHash('sha256').update(readFileSync(packagePath)).digest('hex')
  const issued = issueCredential({
    dataDir, txnId, toVersion: NEXT_VERSION, fromVersion: CURRENT_VERSION,
    releaseId: `rel-${NEXT_VERSION}`, packageSha256, now: () => NOW_MS,
  })
  assert.equal(issued.ok, true, issued.reason)

  // 真实读数：
  const freeBytes = 10 * 1024 * 1024 * 1024
  const tasks = []                       // 真的查过了：没有在途任务
  const migrations = []                  // 产品里确实没有迁移
  assert.equal(migrationPlanDigest(migrations), EMPTY_MIGRATION_PLAN_DIGEST)
  assert.equal(release.migrationPlanDigest, EMPTY_MIGRATION_PLAN_DIGEST,
    '发布端算出的迁移摘要与客户端算出的不同：两侧用了不同的算法')

  const helperCalls = []
  const result = await runInstallTransaction({
    paths: {
      installDir: installRoot, dataDir,
      configPath: join(dataDir, 'config.json'),
      backupDir: join(dataDir, 'backups'),
      cacheDir, helperDir,
    },
    current, release,
    identity: {
      releaseId: `rel-${NEXT_VERSION}`, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64',
      manifestSha256: checked.candidate.manifestSha256,
    },
    packagePath,
    txnId,
    // ★★ 这六行就是本批次修掉的那六个缺陷的**接线点**。
    //    任何一个回到"没有生产方"，这条链都会停在预检上。
    tasks,
    patchBindings: release.dshPatchBindings,
    freeBytes,
    backupBytes: 0,
    dataDirBytes: 0,
    migrations,
    now: () => NOW_MS,
    drainTimeoutMs: 5_000,
    stopClaiming: async () => { helperCalls.push('stop-claiming') },
    drainInFlight: async () => ({ ok: true, detail: '没有在途任务' }),
    stopServices: async () => { helperCalls.push('stop-services') },
    verifyExit: async () => ({ ok: true, detail: '受管进程已退出' }),
    // 进程边界用替身（helper 不真的另起进程），但**helper 本身是真的**，
    // 而事务文件的写法与 `desktop/update-wiring.mjs` 里 `spawnHelper` 的
    // 写法一致——那一段是"桌面把读数写进事务文件"的地方，helper 只读它。
    spawnHelper: async (spawnArgs) => {
      helperCalls.push('spawn-helper')
      writeTransactionFile(dataDir, {
        txnId: spawnArgs.txnId,
        fromVersion: spawnArgs.fromVersion,
        toVersion: spawnArgs.toVersion,
        releaseId: spawnArgs.releaseId,
        packagePath: spawnArgs.packagePath,
        packageSha256: spawnArgs.packageSha256,
        backupDir: join(dataDir, 'backups'),
        backupSnapshotRoot: spawnArgs.backupSnapshotRoot,
        migrations: spawnArgs.migrations ?? [],
        // ★ 包内闭包条目：摘要在**签过名的发行清单**里。
        ...(typeof release.package?.closurePath === 'string' && typeof release.package?.closureSha256 === 'string'
          ? { closureEntry: { path: release.package.closurePath, sha256: release.package.closureSha256 } }
          : {}),
        // ★ 健康检查规格：**声明式**（设计 §8 第 8 步）。
        //
        //   形状与 `desktop/update-wiring.mjs` 写进去的一致
        //   （`health.mjs` 的 `healthSpecFromProcesses` 的产物）。
        //   没有它时 helper 走 fail-closed（`helper-health-unverified`）——
        //   那是对的，但那样这条链就停在验证那一步，测不到提交。
        healthProbeSpec: healthSpecFromProcesses({
          processes: PROCESS_SPECS,
          ports: { 'team-hub': 8787, workbench: 5173, whiteboard: 8080 },
        }).spec,
        healthTimeoutMs: 30_000,
        allowUnverifiedHealth: false,
      })
      const transaction = JSON.parse(readFileSync(join(dataDir, 'update', 'transaction.json'), 'utf8'))
      assert.equal(transaction.txnId, spawnArgs.txnId)
      // ★ 闭包条目**真的**进了事务文件——否则 helper 解压时会走
      //   "没有闭包"那条路（仍然安全，但逐文件摘要这一层就没有证据了）。
      assert.equal(typeof transaction.closureEntry?.sha256, 'string',
        '事务文件里没有闭包条目：helper 会走"没有闭包"那条路')
      assert.equal(transaction.healthProbeSpec?.protocol, 'legion/update-health@1',
        '事务文件里没有健康规格：helper 会 fail-closed 到不提交')
      const report = await runHelper({
        paths: { installDir: installRoot, dataDir, helperDir },
        transaction,
        programFiles: {},
        expectedProgramDigests: {},
        effects: {
          now: () => NOW_MS,
          /**
           * 一个**按服务语义**应答的替身，而不是"把期望值原样回过去"。
           *
           * ★ 这个区别很重要：`expectJson` 是一条**身份断言**，如果替身
           *   照着期望值应答，那条断言就变成了恒真——用例也就测不到它。
           *   所以这里显式写出三个服务的真实语义：
           *
           *     · team-hub  `/api/config`     → 报**自己**的端口（8787）
           *     · workbench `/hub/api/config` → 报**上游 hub** 的端口（8787），
           *       不是自己的 5173。这一条正是身份断言的用途：workbench 里的
           *       `DSH_HUB_UPSTREAM` 指向哪个 hub，就说明它是被**这一次**
           *       启动接上线的那个实例，而不是上一次升级留下的旧实例。
           *     · whiteboard `/healthz`       → `{ ok: true }`
           *
           *   这条替身第一次写出来是**红的**（workbench 报了 5173），
           *   而那正是"身份断言真的在断言"的证据。
           */
          healthFetchImpl: async (url) => {
            const parsed = new URL(url)
            const port = Number(parsed.port)
            const body = port === 5173
              ? { port: 8787 }        // workbench 报它接上的那个 hub
              : { port, ok: true }    // team-hub 报自己；whiteboard 只报 ok
            return { status: 200, text: async () => JSON.stringify(body) }
          },
          listInstalledVersionsImpl: () => [CURRENT_VERSION, NEXT_VERSION],
        },
        log: () => {},
      })
      return { ok: report.verdict === 'committed', verdict: report.verdict, code: report.code, reason: report.reason, report }
    },
  })

  // ── ③ 结论 ──
  assert.equal(result.ok, true, `安装事务失败：${result.code} ${result.reason}`)
  assert.equal(result.verdict, 'handed-off', `落点不是 handed-off：${result.verdict}`)

  // 每一步都真的走过：停认领 → 排在途 → 停服务 → 交接 helper。
  assert.deepEqual(helperCalls, ['stop-claiming', 'stop-services', 'spawn-helper'])

  // 目标版本目录里的文件与发布的产品树**逐字节一致**。
  const targetDir = join(installRoot, 'versions', NEXT_VERSION)
  assert.deepEqual(
    readFileSync(join(targetDir, 'product', 'launcher', 'cli.mjs')),
    Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n'),
  )
  assert.deepEqual(
    readFileSync(join(targetDir, 'runtime', 'dsh-composition', 'index.mjs')),
    Buffer.from('// composition\n'),
  )

  // 事务日志里每一步都有 intent（设计 §8：先意图、后动作）。
  const journal = readJournal(dataDir)
  // ★ 坏行必须是 0：一条"中间出现坏行"的日志说明它被外力改过或被截断，
  //   而那种情况必须如实报告而不是跳过。
  assert.deepEqual([...journal.badLines], [], `事务日志有坏行：${JSON.stringify(journal.badLines)}`)
  assert.equal(journal.truncatedTail, false, '事务日志尾部被截断')
  for (const action of ['lock', 'recheck', 'prepare', 'barrier-acquire', 'backup', 'stop-claiming', 'drain-in-flight', 'stop-services', 'helper-handoff']) {
    const intents = journal.records.filter((r) => r.kind === 'intent' && r.action === action)
    assert.ok(intents.length >= 1, `日志里没有 ${action} 的 intent`)
  }
  // ★ 每一步的 intent 必须**先于**它的 result（设计 §8 的"先写意图、再动手"）。
  //   用 `seq` 比大小而不是"在数组里的位置"：日志是 append-only 的，而 `seq`
  //   是它唯一的顺序读数——一个"按数组下标判断先后"的断言在日志被并发写入时
  //   就会失效。
  for (const action of ['lock', 'recheck', 'prepare', 'barrier-acquire', 'backup', 'stop-claiming', 'drain-in-flight', 'stop-services']) {
    const intent = journal.records.find((r) => r.kind === 'intent' && r.action === action)
    const result = journal.records.find((r) => r.kind === 'result' && r.action === action)
    assert.ok(intent !== undefined, `日志里没有 ${action} 的 intent`)
    assert.ok(result !== undefined, `日志里没有 ${action} 的 result`)
    assert.ok(intent.seq < result.seq,
      `${action} 的 result (seq=${result.seq}) 出现在它的 intent (seq=${intent.seq}) 之前：`
      + '那意味着"动作已经做了而意图还没写下来"，崩溃恢复时无从判断这一步做没做')
  }
  /**
   * ★ 屏障在 helper **提交之后**被解除（设计 §8 第 9 步：
   *   "验证成功后刷盘提交事务，**再**解除维护屏障、恢复认领"）。
   *
   *   这与 `install.test.mjs` 里那条"交接之后屏障保持立着"并不矛盾，两者
   *   说的是**不同的时刻**：
   *
   *     · 那一条的 helper 是个**只报到、不跑完**的替身：交接完成而验证还没
   *       发生，所以屏障必须仍然立着（否则新版本在健康验证里失败时，回退
   *       会落在一个**已经开放写入**的数据上）。
   *     · 这一条的 helper 用真实实现**跑到了提交**，于是它自己解除屏障。
   *
   *   两个时刻都必须被断言到——只测其中一个，会把"过早解除"（危险）与
   *   "永不解除"（维护模式卡死）之一漏掉。
   */
  assert.equal(readBarrier(dataDir).blocked, false,
    'helper 已经提交，屏障却还立着：维护模式会永久卡住')

  // 包已被消费、凭证与密钥已被清理。
  assert.equal(existsSync(join(dataDir, 'update', 'credential.json')), false, '事务凭证没有被消费掉')
})

test('★★ 全链路：包被换过 → 客户端在安装之前就拒（不进入事务）', async (t) => {
  const published = publishOnce(t)
  const fetchImpl = staticHost(published.outDir)
  const packageRelative = published.publish.release.package.path
  const original = fetchImpl.files.get(packageRelative)
  // 同长度换字节：连"大小不符"这条都绕过，只剩摘要能拦。
  fetchImpl.files.set(packageRelative, {
    ...original,
    bytes: Buffer.alloc(original.bytes.length, 0x41),
  })

  const cacheDir = join(published.root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const client = createUpdateClient({
    config: makeConfig(published.trustStore),
    cacheDir, currentVersion: CURRENT_VERSION,
    hostPlatform: 'win32', localKernelRelease: '10.0.22631',
    fetchImpl, now: () => NOW_MS,
  })
  const checked = await client.check({ trigger: 'manual' })
  assert.equal(checked.outcome, 'available')
  const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(downloaded.ok, false, '包被换过却下载成功了')
  assert.match(`${downloaded.code} ${downloaded.reason}`, /digest|摘要/)
  // ★ 就绪状态**没有**被推进：一次被拒的下载不能留下一个"可以安装"的读数。
  assert.equal(client.snapshot().ready, false, '下载被拒之后仍然处于就绪状态')
})

test('★★ 全链路：清单声明的迁移计划与将要执行的不符 → 停在预检（不交接 helper）', async (t) => {
  // 这条是与 ⑮ 直接对应的**端到端**守卫：发布端声明了非空迁移计划，
  // 而客户端手里是空集合（产品还没有迁移），事务必须在动任何东西之前停下。
  const published = publishOnce(t)
  const fetchImpl = staticHost(published.outDir)
  const cacheDir = join(published.root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const client = createUpdateClient({
    config: makeConfig(published.trustStore),
    cacheDir, currentVersion: CURRENT_VERSION,
    hostPlatform: 'win32', localKernelRelease: '10.0.22631',
    fetchImpl, now: () => NOW_MS,
  })
  const checked = await client.check({ trigger: 'manual' })
  const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
  assert.equal(downloaded.ok, true, downloaded.reason)

  const installRoot = join(published.root, 'install')
  const dataDir = join(published.root, 'data2')
  mkdirSync(join(installRoot, 'product', 'release'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(installRoot, 'product', 'release', 'runtime-manifest.json'),
    `${JSON.stringify({
      manifestFormat: 'legion/version-manifest@1', productVersion: CURRENT_VERSION,
      legionVersion: CURRENT_VERSION, dshVersion: '0.8.3', dshCompositionPatchVersion: 2,
      runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
    }, null, 2)}\n`,
  )
  const current = JSON.parse(readFileSync(join(installRoot, 'product', 'release', 'runtime-manifest.json'), 'utf8'))

  // 把发行清单的迁移摘要改成"一份非空计划"的摘要——模拟"发布端声明有迁移"。
  const forgedRelease = {
    ...client.release(),
    migrationPlanDigest: migrationPlanDigest([{ version: 1, name: 'x', compatibility: 'additive', checksum: 'sha256:a' }]),
  }
  const packageSha256 = createHash('sha256').update(readFileSync(downloaded.path)).digest('hex')
  const issued = issueCredential({
    dataDir, txnId: 'it-plan', toVersion: NEXT_VERSION, fromVersion: CURRENT_VERSION,
    releaseId: `rel-${NEXT_VERSION}`, packageSha256, now: () => NOW_MS,
  })
  assert.equal(issued.ok, true, issued.reason)

  let spawned = false
  const result = await runInstallTransaction({
    paths: {
      installDir: installRoot, dataDir,
      configPath: join(dataDir, 'config.json'),
      backupDir: join(dataDir, 'backups'), cacheDir,
      helperDir: join(published.root, 'update2'),
    },
    current, release: forgedRelease,
    identity: {
      releaseId: `rel-${NEXT_VERSION}`, productVersion: NEXT_VERSION,
      channel: 'stable', platform: 'win32', arch: 'x64',
      manifestSha256: checked.candidate.manifestSha256,
    },
    packagePath: downloaded.path,
    txnId: 'it-plan',
    tasks: [], patchBindings: forgedRelease.dshPatchBindings,
    freeBytes: 10 * 1024 * 1024 * 1024, backupBytes: 0, dataDirBytes: 0,
    migrations: [],
    now: () => NOW_MS,
    stopClaiming: async () => {}, drainInFlight: async () => ({ ok: true }), stopServices: async () => {},
    verifyExit: async () => ({ ok: true }),
    spawnHelper: async () => { spawned = true; return { ok: true } },
  })
  assert.equal(result.ok, false, '声明了迁移却放行了安装')
  assert.equal(result.code, 'install-migration-plan-mismatch')
  assert.equal(result.reachedStep, 'recheck')
  assert.equal(spawned, false, '迁移计划不符却仍然交接了 helper')
  // 目标版本目录**没有**被创建：拒绝发生在动任何东西之前。
  assert.equal(existsSync(join(installRoot, 'versions', NEXT_VERSION)), false,
    '被拒绝的事务已经在磁盘上留下了痕迹')
})
