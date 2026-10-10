/**
 * update.e2e.test.mjs — 腿 3：桌面端自动更新闭环（T-195 提出，T-198 重写到真模块）。
 *
 * ```
 * 发布端：buildPublish/writePublish（**真发布器**）→ immutable/ + channel/
 * 上传：  两棵子树合并进同一个前缀（真实上传就是这一步：先不可变、最后通道清单）
 * 托管：  **真 team-hub** 的 /legion/* 路由（生产代码）
 * 客户端：createUpdateClient 的**真实**代码路径：check → download（走真 HTTP）
 * 安装：  runInstallTransaction + runHelper（真事务、真解压、真切换）
 * 判据：  磁盘上的活动版本指针**真的**指向新版本
 * ```
 *
 * ## 与 `product/update/integration.test.mjs` 的分工（不重复它）
 *
 * 那一条把**托管换成内存替身**（`staticHost`），换来的是完整链路能在离网环境里
 * 跑；它覆盖的是 publish → client → install 这条**业务链**的深度（事务日志、
 * 屏障、闭包、健康、凭证清理）。
 *
 * 本腿换了**唯一一样东西**：托管是真服务器。换来的是这几件只有真 HTTP 才有的行为
 * 被真的走一遍——缓存头、扩展名白名单、路径穿越防护、Range 断点续传。
 *
 *   > 一个"对着自己写的静态替身验证通过的更新链路"，
 *   > 与一个"真的能从生产托管取到更新"的链路，在测试报告上是同一个东西——
 *   > 只不过前者在缓存头写错、扩展名不在白名单、Range 没实现时照样是绿的。
 *
 * 所以本文件**不**重复事务内部的逐步断言（那是上一条的职责），只断言
 * "这条链在真 HTTP 上从头走到尾，并且磁盘上的读数是对的"。
 *
 * ## 这一版为什么要重写（T-198）
 *
 * 第一版（T-195）自己写了一个 `product/upgrade/feed.mjs`（560 行），那是
 * `product/update/envelope.mjs` + `feed.mjs` 的**并行实现**——因为它的基线早于
 * `product/update/` 落地。它**没有任何生产消费者**，只有本文件与探针 import 它。
 *
 *   > 把一份"只有测试用"的协议实现合进主干，
 *   > 等于给仓库再加一套会与真实现漂移的东西——而它的绿全部来自它自己。
 *
 * 现在这一版直接用真模块。于是本腿守的东西也变了：它不再证明"我写的那套
 * 协议自洽"，而是证明"**产品真用的那套**协议，在真托管上从发布走到提交"。
 *
 * ## ⚠️ 诚实边界
 *
 * - 本地 Hub 是 `http://127.0.0.1:<port>`。正式更新**必须** HTTPS，
 *   所以这里显式传 `allowInsecureHttp: true` —— 那是 `host.mjs` 为测试留的
 *   唯一开关（`createHostConfig` 对明文 origin 默认拒绝）。**没有真 HTTPS、
 *   没有 CDN、没有真机**；传输安全属设计稿 §10 阶段 D。
 * - `installer`（`.exe`）是占位文件，**不声称可安装**：打真安装包需要证书与
 *   `desktop/node_modules`。
 * - helper 的**进程边界**是替身（不真的另起进程），但 helper 本身是真的。
 * - 健康探针由测试注入（同 `integration.test.mjs`）。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { call, startHub, tempDir } from './harness.mjs'

import {
  ENVELOPE_CODES, ENVELOPE_FORMATS, createTrustStore, generateReleaseKeyPair,
  serializeEnvelope, signEnvelope, verifyEnvelope,
} from '../../product/update/envelope.mjs'
import { FEED_CODES, emptySequenceState, judgeSequence, recordSequence, validateFeedPayload } from '../../product/update/feed.mjs'
import { RELEASE_CODES, validateRelativePath } from '../../product/update/release.mjs'
import { createHostConfig } from '../../product/update/host.mjs'
import { createUpdateClient } from '../../product/update/client.mjs'
import { runInstallTransaction } from '../../product/update/install.mjs'
import { runHelper, writeTransactionFile } from '../../product/update/helper.mjs'
import { issueCredential } from '../../product/update/credential.mjs'
import { healthSpecFromProcesses } from '../../product/update/health.mjs'
import { PROCESS_SPECS } from '../../product/process-manifest.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST, migrationPlanDigest } from '../../product/upgrade/migration.mjs'
import { buildPublish, writePublish } from '../../scripts/update/publish.mjs'

const CURRENT_VERSION = '1.0.0'
const NEXT_VERSION = '1.1.0'
const RELEASE_ID = `rel-${NEXT_VERSION}`
const KEY_ID = 'e2e-release-key'
const NOW_MS = Date.parse('2026-10-05T00:00:00Z')
const PREFIX = '/legion'

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const nowIso = (offsetMs = 0) => new Date(NOW_MS + offsetMs).toISOString()

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
  for (const [path, content] of [
    ['product/launcher/cli.mjs', '#!/usr/bin/env node\nconsole.log(1)\n'],
    ['product/release/runtime-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['runtime/dsh-composition/index.mjs', '// composition\n'],
  ]) {
    const target = join(root, ...path.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return { manifest }
}

/**
 * 「上传」那一步：把 `immutable/` 与 `channel/` 合并进**同一个前缀**。
 *
 * ★ 这不是为了"帮客户端通过"，而是**真实上传的形状**：设计 §9 要求先传不可变
 *   文件、**最后**换通道清单，而在对象存储里两者落进同一个命名空间。
 *   `integration.test.mjs` 的内存替身做的也是同一件事（它 walk 两棵子树）。
 *   合并之后交给**真 Hub** 托管——缓存头、白名单、穿越防护全走生产路由。
 */
function materializeUpload(outDir, servedDir) {
  mkdirSync(servedDir, { recursive: true })
  for (const sub of ['immutable', 'channel']) cpSync(join(outDir, sub), servedDir, { recursive: true })
  return servedDir
}

/** 一次完整的"发布 → 上传"。 */
function publishOnce(root) {
  const payloadRoot = join(root, 'payload')
  const { manifest } = writePayloadTree(payloadRoot, NEXT_VERSION)

  const keys = generateReleaseKeyPair({ keyId: KEY_ID })
  const trustStore = createTrustStore([{ keyId: KEY_ID, publicKeyPem: keys.publicKeyPem }])

  const installerPath = join(root, 'Legion-Setup.exe')
  const notesPath = join(root, 'notes.zh-CN.txt')
  // ⚠️ 占位：不是可安装的安装包。只为满足发行清单里的 installer 条目。
  writeFileSync(installerPath, 'MZ pretend installer')
  writeFileSync(notesPath, '修复了若干问题。\n')

  const outDir = join(root, 'dist')
  const publish = buildPublish({
    productVersion: NEXT_VERSION,
    channel: 'stable',
    releaseId: RELEASE_ID,
    productManifest: manifest,
    supportedFromVersions: [CURRENT_VERSION],
    minWindowsBuild: 19045,
    packageRoot: payloadRoot,
    packageZipPath: null,
    installerPath,
    notesPath,
    dshPatchBindings: [{ dshVersion: '0.8.3', compositionPatchVersion: 2 }],
    migrationPlan: [],
    keyId: KEY_ID,
    privateKeyPem: keys.privateKeyPem,
    sequence: 7,
    issuedAt: nowIso(-86400_000),
    expiresAt: nowIso(30 * 86400_000),
    outDir,
  })
  writePublish(publish, outDir, { log: () => {} })
  return { root, outDir, publish, trustStore, keys, payloadRoot, manifest, installerPath, notesPath }
}

/**
 * 客户端配置。`origin` 是**真 Hub 的基址**。
 *
 * ★ `allowInsecureHttp: true` 是必须显式声明的：`createHostConfig` 对 `http:`
 *   默认**拒绝**（"正式更新必须使用 HTTPS"）。这条不是绕过安全检查，而是
 *   设计里给测试留的唯一开关——把它写在这里，是为了让"本地 HTTP"这件事
 *   在代码里**看得见**，而不是让某个地方悄悄降级。
 */
function makeConfig(trustStore, origin) {
  const host = createHostConfig({
    origin, prefix: PREFIX, channel: 'stable', allowInsecureHttp: true,
  })
  assert.equal(host.ok, true, `本地宿主配置应当可用：${host.reason}`)
  return {
    ok: true, usable: true, code: null, reason: null, channel: 'stable',
    host: host.host, trustStore, trustEntries: [], trustSequence: 1, checkOnStartup: true,
  }
}

describe('腿 3 · 桌面端自动更新（真发布 → 真 Hub → 真客户端 → 真安装事务）', () => {
  let hub
  let root
  let published
  let served
  let installRoot
  let dataDir
  let cacheDir
  let helperDir

  before(async () => {
    root = tempDir('legion-e2e-update-')
    published = publishOnce(root)
    served = materializeUpload(published.outDir, join(root, 'served'))

    // ★ 真 Hub 托管发布目录（生产路由，不是本测试自己搭的静态服务器）。
    hub = await startHub({ releasesDir: served, remoteAuth: false })

    installRoot = join(root, 'install')
    dataDir = join(root, 'data')
    cacheDir = join(root, 'cache')
    helperDir = join(root, 'update')
    for (const dir of [installRoot, dataDir, cacheDir, helperDir]) mkdirSync(dir, { recursive: true })
    // 当前版本的清单（`current` 参数）：与 `writePayloadTree` 同形，版本是旧的。
    mkdirSync(join(installRoot, 'product', 'release'), { recursive: true })
    writeFileSync(join(installRoot, 'product', 'release', 'runtime-manifest.json'), `${JSON.stringify({
      manifestFormat: 'legion/version-manifest@1', productVersion: CURRENT_VERSION,
      legionVersion: CURRENT_VERSION, dshVersion: '0.8.3', dshCompositionPatchVersion: 2,
      runtimeContractVersion: 1, packProtocolVersion: 1, schemaVersion: 1, channel: 'stable',
    }, null, 2)}\n`)
    writeFileSync(join(helperDir, 'helper-entry.mjs'), '// entry\n')
  })

  after(async () => {
    if (hub) await hub.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  // ── 托管面：只有真服务器才有的那几个行为 ──────────────────────────────────

  it('① 真 Hub 托管发布目录：通道清单 no-store、不可变产物长缓存、Range 可续传', async () => {
    const feed = await call(hub.base, 'GET', `${PREFIX}/${published.publish.feedPath}`)
    assert.equal(feed.status, 200, `通道清单应可达：${feed.text.slice(0, 200)}`)
    // 设计 §4：通道清单**必须**每次回源，否则客户端会一直看到一个过期的通道。
    assert.equal(feed.headers.get('cache-control'), 'no-store', '通道清单必须 no-store')

    const manifest = await call(hub.base, 'GET', `${PREFIX}/${published.publish.feed.manifestPath}`)
    assert.equal(manifest.status, 200, '发行清单应可达')
    assert.match(manifest.headers.get('cache-control') ?? '', /max-age/,
      '不可变产物应当可长缓存——否则每次检查都要重下一遍清单')

    // Range 断点续传（§4 要求）：安装包上百 MB，断在半路不能续传等于不能下。
    const pkgPath = published.publish.release.package.path
    const whole = await call(hub.base, 'GET', `${PREFIX}/${pkgPath}`)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes',
      '没有 accept-ranges 客户端连试都不会试——它会直接整包重下')

    const part = await call(hub.base, 'GET', `${PREFIX}/${pkgPath}`, { headers: { range: 'bytes=0-99' } })
    assert.equal(part.status, 206, '单段 Range 应回 206')
    assert.match(part.headers.get('content-range') ?? '', /^bytes 0-99\//, 'content-range 应如实标注')
  })

  it('② 真 Hub 安全：路径穿越与白名单外扩展名都取不到', async () => {
    for (const p of [
      `${PREFIX}/../package.json`,
      `${PREFIX}/%2e%2e/package.json`,
      `${PREFIX}/feeds/../../product/update/feed.mjs`,
    ]) {
      const r = await call(hub.base, 'GET', p)
      assert.ok(r.status >= 400, `${p} 应被拒绝，实际 ${r.status}`)
    }
  })

  // ── 信任链：真 Hub 取回的字节，用**真**验签器与真信任表 ───────────────────

  it('③ 通道清单：从真 Hub 取回、验签通过，且信任根/格式/时效都被真的检查过', async () => {
    const url = `${hub.base}${PREFIX}/${published.publish.feedPath}`
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())

    const good = verifyEnvelope(bytes, {
      trust: published.trustStore, expectedFormat: ENVELOPE_FORMATS.FEED, nowMs: NOW_MS,
    })
    assert.equal(good.ok, true, `真清单应验签通过：${good.code} ${good.reason}`)
    assert.equal(good.payload.releaseId, RELEASE_ID)
    assert.equal(good.payload.sequence, 7)

    // 未知 keyId → **不授权任何下载或安装**（§5）。
    const unknown = verifyEnvelope(bytes, { trust: createTrustStore([]), nowMs: NOW_MS })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, ENVELOPE_CODES.UNKNOWN_KEY)

    // 期望格式不符 → 拒绝（防止把发行清单当通道清单用）。
    const wrongFormat = verifyEnvelope(bytes, {
      trust: published.trustStore, expectedFormat: ENVELOPE_FORMATS.RELEASE, nowMs: NOW_MS,
    })
    assert.equal(wrongFormat.ok, false)
    assert.equal(wrongFormat.code, ENVELOPE_CODES.UNKNOWN_FORMAT)

    // 过期清单不授权新的下载或安装（§5）。
    const expiredEnv = signEnvelope(
      { ...published.publish.feed, expiresAt: nowIso(-3600_000) },
      { privateKeyPem: published.keys.privateKeyPem, keyId: KEY_ID },
    )
    const expired = verifyEnvelope(serializeEnvelope(expiredEnv), {
      trust: published.trustStore, nowMs: NOW_MS,
    })
    assert.equal(expired.ok, false)
    assert.equal(expired.code, ENVELOPE_CODES.EXPIRED)
  })

  it('④ 篡改 payload 会让签名失效（签名覆盖的是 canonicalJson(payload)）', async () => {
    const signed = signEnvelope(published.publish.feed, {
      privateKeyPem: published.keys.privateKeyPem, keyId: KEY_ID,
    })
    // ★ `signEnvelope` 返回**冻结**对象：篡改必须构造新对象，不能就地改。
    const tampered = { ...signed, payload: { ...published.publish.feed, releaseId: 'evil' } }
    const r = verifyEnvelope(serializeEnvelope(tampered), { trust: published.trustStore, nowMs: NOW_MS })
    assert.equal(r.ok, false)
    assert.equal(r.code, ENVELOPE_CODES.BAD_SIGNATURE,
      'payload 改了而签名仍然通过 —— 那意味着签名没有覆盖 payload')
  })

  it('⑤ 严格 JSON：三种"同一个字节串两种读法"在**真消费路径**上被拒', () => {
    const sig = 'A'.repeat(88)
    const wrap = (payloadJson) => Buffer.from(`{"keyId":"${KEY_ID}","payload":${payloadJson},"signature":"${sig}"}`)
    // 重复键：`{"a":1,"a":2}` 在宽松解析下取值随实现而变。
    const dup = verifyEnvelope(wrap('{"a":1,"a":2}'), { trust: published.trustStore })
    assert.equal(dup.ok, false)
    assert.equal(dup.code, ENVELOPE_CODES.MALFORMED)
    assert.equal(dup.cause, 'json-duplicate-key', '重复键必须被**指名**拒绝，而不是"随便取一个"')
    // 越界数字：`1e999` 解析成 Infinity，而 Infinity 不能出现在签名覆盖的文本里。
    const num = verifyEnvelope(wrap('{"a":1e999}'), { trust: published.trustStore })
    assert.equal(num.ok, false)
    assert.equal(num.cause, 'json-bad-number')
    // 超大输入：不许先把内存吃光再报错。
    const big = verifyEnvelope(Buffer.alloc(300 * 1024, 0x78), { trust: published.trustStore })
    assert.equal(big.ok, false)
    assert.equal(big.code, ENVELOPE_CODES.TOO_LARGE)
  })

  it('⑥ 序列栅栏：回退与同号异摘要都被拒，同号同摘要是幂等的', () => {
    // 重放旧清单是**签名有效**的攻击，只有 sequence 栅栏拦得住。
    const feedAt = (sequence, manifestSha256) => ({
      channel: 'stable', platform: 'win32', arch: 'x64', sequence, manifestSha256,
    })
    const first = judgeSequence(emptySequenceState(), feedAt(5, 'sha256:aa'))
    assert.equal(first.accept, true, `首次应当接受：${first.code}`)

    const state = recordSequence(emptySequenceState(), feedAt(5, 'sha256:aa'))
    const regress = judgeSequence(state, feedAt(4, 'sha256:aa'))
    assert.equal(regress.accept, false)
    assert.equal(regress.code, FEED_CODES.SEQUENCE_REGRESSION)

    const conflict = judgeSequence(state, feedAt(5, 'sha256:bb'))
    assert.equal(conflict.accept, false)
    assert.equal(conflict.code, FEED_CODES.SEQUENCE_CONFLICT)

    const idem = judgeSequence(state, feedAt(5, 'sha256:aa'))
    assert.equal(idem.accept, true, '同号同摘要应当幂等接受')
    assert.equal(idem.regression, false, '幂等接受不该被当成回退')
  })

  it('⑦ 路径安全：绝对地址 / 穿越 / 编码绕过 / 盘符 / 反斜杠一律拒绝', () => {
    for (const p of ['../x', 'a/../../x', '%2e%2e/x', '%252e%252e/x', 'C:/x', '//evil/x', '/abs/x', 'a\\b', 'a\u0000b']) {
      const r = validateRelativePath(p)
      assert.equal(r.ok, false, `${p} 应被拒绝`)
      assert.equal(r.code, RELEASE_CODES.BAD_PATH)
    }
    assert.equal(validateRelativePath('releases/rel-1.1.0/manifest.json').ok, true, '合法相对路径应通过')

    // 通道清单里的 manifestPath 走的是**清单校验**那条路：越界即整份拒收。
    const bad = validateFeedPayload({ ...published.publish.feed, manifestPath: '../x' })
    assert.equal(bad.ok, false, '越界 manifestPath 的通道清单必须整份拒收')
  })

  it('⑧ 两份 canonicalJson 在协议输入域上取值一致（实测，非假设）', async () => {
    // 仓库里有**两份** canonicalJson，而**没有任何东西在维持它们一致**
    // （`runtime/contracts/canonical.mjs:11-14` 与 `docs/STATUS.md:2095` 都记过）。
    // 设计 §5 要求"经跨发布端/客户端的固定向量验证后才复用"，而那条向量
    // 在本批之前不存在——这一条就是它。**main 上目前没有别的判据守这件事。**
    const shared = await import('../../runtime/contracts/canonical.mjs')
    const own = await import('../../product/update/canonical.mjs')
    const cases = [
      { format: ENVELOPE_FORMATS.FEED, channel: 'stable', platform: 'win32', arch: 'x64', sequence: 42, ok: true, nil: null },
      { b: 1, a: { d: 2, c: [3, 1] } },
      { z: 'x', a: [1, 2, { m: true, b: null }] },
      published.publish.feed,
      published.publish.release,
    ]
    for (const c of cases) {
      assert.equal(
        own.canonicalJson(c), shared.canonicalJson(c),
        `两份 canonicalJson 分叉了：${JSON.stringify(c).slice(0, 120)}`,
      )
    }
  })

  // ── 完整闭环 ─────────────────────────────────────────────────────────────

  it('⑨ 端到端：客户端从真 Hub 检查→下载→真安装事务提交，磁盘指针指向新版本', async () => {
    const client = createUpdateClient({
      config: makeConfig(published.trustStore, hub.base),
      cacheDir,
      currentVersion: CURRENT_VERSION,
      hostPlatform: 'win32',
      localKernelRelease: '10.0.22631',   // 满足 minWindowsBuild: 19045
      fetchImpl: globalThis.fetch,
      now: () => NOW_MS,
    })

    // ① 检查：走真 HTTP 取通道清单 → 验签 → 取发行清单 → 校验摘要。
    const checked = await client.check({ trigger: 'manual' })
    assert.equal(checked.outcome, 'available', `检查失败：${checked.code} ${checked.reason}`)
    assert.equal(checked.candidate.productVersion, NEXT_VERSION)

    // ② 下载：流式 + 边下边算摘要 + 原子改名。
    const downloaded = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
    assert.equal(downloaded.ok, true, `下载失败：${downloaded.code} ${downloaded.reason}`)
    const packagePath = downloaded.path
    assert.equal(typeof packagePath, 'string')
    assert.equal(existsSync(packagePath), true, '下载报告的路径不存在')
    assert.equal(packagePath.endsWith('.part'), false,
      '就绪的包仍然是 .part —— 那意味着"中断的包能被当成就绪的包"')

    const release = client.release()
    assert.notEqual(release, null)

    // ③ 安装事务：读数由真实函数产出（与 integration.test.mjs 同形）。
    const current = JSON.parse(readFileSync(join(installRoot, 'product', 'release', 'runtime-manifest.json'), 'utf8'))
    const txnId = 'e2e-fullchain'
    const packageSha256 = sha256Hex(readFileSync(packagePath))
    const issued = issueCredential({
      dataDir, txnId, toVersion: NEXT_VERSION, fromVersion: CURRENT_VERSION,
      releaseId: RELEASE_ID, packageSha256, now: () => NOW_MS,
    })
    assert.equal(issued.ok, true, issued.reason)

    const tasks = []
    const migrations = []
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
        releaseId: RELEASE_ID, productVersion: NEXT_VERSION,
        channel: 'stable', platform: 'win32', arch: 'x64',
        manifestSha256: checked.candidate.manifestSha256,
      },
      packagePath,
      txnId,
      tasks,
      patchBindings: release.dshPatchBindings,
      freeBytes: 10 * 1024 * 1024 * 1024,
      backupBytes: 0,
      dataDirBytes: 0,
      migrations,
      now: () => NOW_MS,
      drainTimeoutMs: 5_000,
      stopClaiming: async () => { helperCalls.push('stop-claiming') },
      drainInFlight: async () => ({ ok: true, detail: '没有在途任务' }),
      stopServices: async () => { helperCalls.push('stop-services') },
      verifyExit: async () => ({ ok: true, detail: '受管进程已退出' }),
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
          ...(typeof release.package?.closurePath === 'string' && typeof release.package?.closureSha256 === 'string'
            ? { closureEntry: { path: release.package.closurePath, sha256: release.package.closureSha256 } }
            : {}),
          healthProbeSpec: healthSpecFromProcesses({
            processes: PROCESS_SPECS,
            ports: { 'team-hub': 8787, workbench: 5173, whiteboard: 8080 },
          }).spec,
          healthTimeoutMs: 30_000,
          allowUnverifiedHealth: false,
        })
        const transaction = JSON.parse(readFileSync(join(dataDir, 'update', 'transaction.json'), 'utf8'))
        assert.equal(typeof transaction.closureEntry?.sha256, 'string',
          '事务文件里没有闭包条目：helper 会走"没有闭包"那条路')
        const report = await runHelper({
          paths: { installDir: installRoot, dataDir, helperDir },
          transaction,
          programFiles: {},
          expectedProgramDigests: {},
          effects: {
            now: () => NOW_MS,
            // 按**服务语义**应答，而不是把期望值回过去（否则身份断言恒真）。
            healthFetchImpl: async (url) => {
              const port = Number(new URL(url).port)
              const body = port === 5173 ? { port: 8787 } : { port, ok: true }
              return { status: 200, text: async () => JSON.stringify(body) }
            },
            listInstalledVersionsImpl: () => [CURRENT_VERSION, NEXT_VERSION],
          },
          log: () => {},
        })
        return { ok: report.verdict === 'committed', verdict: report.verdict, code: report.code, reason: report.reason, report }
      },
    })

    assert.equal(result.ok, true, `安装事务失败：${result.code} ${result.reason}`)
    assert.equal(result.verdict, 'handed-off', `落点不是 handed-off：${result.verdict}`)
    assert.deepEqual(helperCalls, ['stop-claiming', 'stop-services', 'spawn-helper'])

    // ★ 最要紧的判据：交付目录里的文件与发布的产品树**逐字节一致**。
    const targetDir = join(installRoot, 'versions', NEXT_VERSION)
    assert.deepEqual(
      readFileSync(join(targetDir, 'product', 'launcher', 'cli.mjs')),
      Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n'),
    )
    assert.deepEqual(
      readFileSync(join(targetDir, 'runtime', 'dsh-composition', 'index.mjs')),
      Buffer.from('// composition\n'),
    )
    // 包已被消费、凭证已被清理。
    assert.equal(existsSync(join(dataDir, 'update', 'credential.json')), false, '事务凭证没有被消费掉')
  })

  it('⑩ 托管上的包被换过 → 客户端在**下载阶段**就拒（不进入事务），且不留残件', async () => {
    // ★ 这一条第一版**名不副实**，是探针 P7 把它抓出来的。
    //
    //   第一版传了一个**错的 `manifestDigest`** 给 `client.download()`，
    //   于是客户端在 `sameIdentity()` 就以 `IDENTITY_MISMATCH` 拒了 ——
    //   根本**没走到** transport 的摘要校验。于是"关掉摘要校验"这条探针
    //   怎么改都是绿的（fail=0）。
    //
    //   > 一条"包被换过就必须拒"的判据，在它由**另一个**拒绝理由满足时，
    //   > 与一条真的守住摘要校验的判据，输出完全一样——
    //   > 只不过前者在摘要校验被删掉之后仍然是绿的。
    //
    //   真正的形状是：**清单不变、托管上的字节变了**（host 被换包/CDN 被污染）。
    //   摘要对不上必须在**下载**这一步被发现，而不是等到安装。
    const pkgPath = join(served, published.publish.release.package.path)
    const originalBytes = readFileSync(pkgPath)
    // ★ 篡改必须**保持长度**：追加一个字节虽然也改了摘要，但会先被大小检查拦下
    //   （`net-too-large`）——那条路是好的快速失败，可它不是这一条要守的东西。
    //   翻一个字节是确定的：长度不变、摘要必变，于是必然走到**摘要校验**那一步。
    //
    //   > 一条"包被换过就必须拒"的用例，在它被**大小检查**满足时，
    //   > 与一条真的守住摘要校验的用例，输出完全一样——
    //   > 只不过前者在摘要校验被删掉之后仍然是绿的。
    const tamperedBytes = Buffer.from(originalBytes)
    tamperedBytes[0] ^= 0xFF
    assert.equal(tamperedBytes.length, originalBytes.length, '夹具必须保持长度，否则走的是大小检查那条路')
    assert.notEqual(sha256Hex(tamperedBytes), sha256Hex(originalBytes), '夹具本身应真的改到了字节')

    const badCache = join(root, 'cache-bad')
    mkdirSync(badCache, { recursive: true })
    writeFileSync(pkgPath, tamperedBytes)
    try {
      const client = createUpdateClient({
        config: makeConfig(published.trustStore, hub.base),
        cacheDir: badCache,
        currentVersion: CURRENT_VERSION,
        hostPlatform: 'win32',
        localKernelRelease: '10.0.22631',
        fetchImpl: globalThis.fetch,
        now: () => NOW_MS,
      })
      // 清单本身没被动过 ⇒ 检查阶段照常通过。差别只在于**包**。
      const checked = await client.check({ trigger: 'manual' })
      assert.equal(checked.outcome, 'available', `检查应当通过（清单未变）：${checked.code} ${checked.reason}`)

      const bad = await client.download(checked.candidate.releaseId, checked.candidate.manifestSha256)
      assert.equal(bad.ok, false, '托管上的字节与清单声明的摘要不符，下载不该被判成功')
      assert.equal(bad.code, 'net-digest-mismatch',
        '拒收理由应当是**摘要不符**（而不是"身份不一致"等另一个理由）——'
        + '否则这条断言会被另一个拒绝理由满足，摘要校验删掉了也照样绿')
      // 坏包不许留下来被下一次运行误用。
      assert.equal(existsSync(join(badCache, ...published.publish.release.package.path.split('/'))), false,
        '摘要不符不应留下目标文件')
    } finally {
      // 还原被换掉的包，避免影响同文件里其它用例（本用例是最后一条，但仍不依赖顺序）。
      writeFileSync(pkgPath, originalBytes)
    }
  })
})
