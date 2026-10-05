#!/usr/bin/env node
// scripts/update/publish.mjs —— 发行产物的构造与签名（设计 §9 第 1–4 步）
// ============================================================================
// 设计 §9 的五步，本脚本负责前三步里**能离线做**的部分：
//
//   1. 冻结精确组件清单和迁移计划，生成 ZIP 与签名安装器
//      → 本脚本校验输入目录的闭包、算摘要、生成不可变发布目录
//   2. 校验文件闭包、签名身份、包大小/摘要
//      → 本脚本对**自己写出去的字节**回读再算一遍
//   3. 生成并签名发行清单
//      → 本脚本产出 `releases/<releaseId>/manifest.json` 与通道 envelope
//   4. 对通道发布加锁；生成更大的 sequence，最后通过单对象替换通道 envelope
//      → 本脚本产出待上传的通道 envelope，**上传由调用方决定**
//   5. 从公网回读通道清单并用真实旧客户端检查
//      → `verify-host.mjs`
//
// ## 为什么上传不在本脚本里
//
// 设计 §9 line 202：「上传失败不得推进通道指针。通道清单只有一个带签名对象，
// 避免正文与旁路签名不同步。」
//
// 这条要求"上传不可变文件"与"替换通道清单"必须**分成两步且顺序固定**。
// 一个"顺手都传上去"的脚本把这两个动作绑在一起，于是任何一次部分失败都会
// 留下"通道指向一个不存在的 releaseId"的状态——而那正是客户端最不该看到的
// 东西。所以本脚本只**产出**文件，并把两条上传命令打印出来让人/CI 执行。
//
// 用法：
//   node scripts/update/publish.mjs \
//     --payload-root ./stage/legion-win-x64 \
//     --installer ./stage/Legion-Setup-win-x64.exe \
//     --notes ./stage/notes.zh-CN.txt \
//     --product-manifest ./stage/runtime-manifest.json \
//     --product-version 1.1.0 --from-version 1.0.0 \
//     --channel stable --release-id rel-1.1.0 \
//     --package-zip ./stage/legion-win-x64.zip \
//     --key-id release-2026-a --private-key ./keys/release-2026-a.key.pem \
//     --sequence 43 --issued-at 2026-10-04T00:00:00Z --expires-at 2026-11-04T00:00:00Z \
//     --out ./dist/update
// ============================================================================

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { buildFeedPayload } from '../../product/update/feed.mjs'
import { buildRelease, validateRelease, validateRelativePath } from '../../product/update/release.mjs'
import { serializeEnvelope, signEnvelope } from '../../product/update/envelope.mjs'
import { canonicalJson } from '../../product/update/canonical.mjs'
import { feedRelativePath } from '../../product/update/host.mjs'
import { CLOSURE_ENTRY_NAME, closureDigest, closureFromDirectory, serializeClosure } from '../../product/update/closure.mjs'
import { buildZip } from '../../product/update/zip.mjs'
import { EMPTY_MIGRATION_PLAN_DIGEST, migrationPlanDigest } from '../../product/upgrade/migration.mjs'
import { RELEASE_CHANNELS } from '../../product/upgrade/channels.mjs'
import { validateManifest } from '../../product/upgrade/manifest.mjs'

export const PUBLISH_FORMAT = 'legion/update-publish@1'

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

function requireString(args, name) {
  const value = args.get(name)
  if (typeof value !== 'string' || value === '' || value === 'true') {
    throw new Error(`publish 需要 --${name}`)
  }
  return value
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 由文件构造一个产物描述。
 *
 * ★ 路径必须能被 `validateRelativePath` 接受。发布端算出来的路径如果是
 *   绝对路径（一个很容易犯的错：直接把本地路径塞进去），发行清单会在
 *   客户端**被拒**，而发布端这边一切正常——所以在这里就拒。
 */
export function artifactOfFile(relativePath, absolutePath) {
  const check = validateRelativePath(relativePath, { field: 'artifact.path', allowSubdirDepth: 5 })
  if (!check.ok) throw new Error(`产物路径不合法：${check.reason}`)
  if (!existsSync(absolutePath)) throw new Error(`产物不存在：${absolutePath}`)
  const size = statSync(absolutePath).size
  if (size <= 0) throw new Error(`产物是空文件：${absolutePath}`)
  return Object.freeze({ path: relativePath, sizeBytes: size, sha256: sha256OfFile(absolutePath) })
}

/**
 * 从一个目录树打出升级包，并生成它的闭包（发布端的真路径）。
 *
 * ## 为什么闭包要在**打包时**生成，而不是让调用方单独给一份
 *
 * 因为它必须与包里的字节**逐条一致**。让调用方分两次提供（一次给目录、
 * 一次给闭包文件）就多了一次"两份东西没对齐"的机会，而那个后果是客户端
 * 在解压时拒收自己刚发布的包——排查方向会落在客户端。
 *
 * ## 闭包的载体是包内条目，摘要在签名清单里
 *
 * 逐文件闭包放不进受 256 KiB 上限约束的发行清单（见 `closure.mjs` 的文件头）。
 * 所以：`closure.json` 作为**一个条目**写进包内，而 `package.closureSha256`
 * 钉住它。这条链的可信度来自发行清单已经签过名。
 */
export function packDirectory({
  root,
  closureName = CLOSURE_ENTRY_NAME,
  readFile = (path) => readFileSync(path),
  readdir = (path) => readdirSync(path, { withFileTypes: true }),
} = {}) {
  if (typeof root !== 'string' || root === '') return { ok: false, reason: 'packDirectory 需要 root' }
  if (!existsSync(root)) return { ok: false, reason: `目录不存在：${root}` }
  const resolved = resolve(root)
  // 闭包条目名要能过同一套路径判据（它在包内是一个普通条目）。
  const nameCheck = validateRelativePath(closureName, { field: 'closureName', allowSubdirDepth: 1 })
  if (!nameCheck.ok) return { ok: false, reason: `闭包条目名不合法：${nameCheck.reason}` }

  const collected = closureFromDirectory(resolved, { readFile, readdir })
  if (collected.ok !== true) return { ok: false, reason: `从目录树构造闭包失败：${collected.problems.join('；')}` }
  // 闭包条目**自己不进闭包**：它不可能列出自己的摘要（自指，sha256 没有
  // 不动点）。它的可信度由签名清单里的 `closureSha256` 保证。
  if (collected.closure.files.some((file) => file.path === closureName)) {
    return { ok: false, reason: `目录树里已经有 ${closureName} 了：它会被本函数覆盖，请先删掉` }
  }

  const closureBytes = serializeClosure(collected.closure)
  const files = collected.closure.files.map((file) => ({
    path: file.path,
    bytes: readFile(join(resolved, ...file.path.split('/'))),
  }))
  const built = buildZip([...files, { path: closureName, bytes: closureBytes }])
  if (built.ok !== true) return { ok: false, reason: `打包失败：${built.reason}` }

  return {
    ok: true,
    zipBytes: built.bytes,
    closure: collected.closure,
    closureBytes,
    closureSha256: closureDigest(closureBytes),
    closureName,
    fileCount: files.length,
  }
}

/**
 * 构造一次发行的全部文件（内存里），由调用方决定往哪写。
 *
 * 返回的 `files` 是一张 `相对路径 → 字节` 的表，路径全部相对**存储前缀**
 * （即 `/legion/` 之下），所以上传时按原样落到托管上即可。
 */
export function buildPublish({
  productVersion, channel, releaseId, platform = 'win32', arch = 'x64',
  productManifest, supportedFromVersions, minWindowsBuild = 19045, requiredFreeBytes,
  packageZipPath = null, packageRoot = null, installerPath, notesPath,
  /**
   * 固定迁移计划（数组，可省略 = 空计划）。
   *
   * 给它时摘要由 `migrationPlanDigest()` **算出来**——与客户端核对时用的是
   * 同一个函数。发布端与客户端各写一份算法，就是一条"两边算出不同值、
   * 而升级永远失败"的路径。
   */
  migrationPlan = null,
  migrationPlanDigest: explicitPlanDigest = null,
  rollbackPolicy = 'program-only',
  /**
   * 补丁层成对表：`[{ dshVersion, compositionPatchVersion }]`。
   *
   * ★ 这是**发布方**的断言，必须显式给（默认空数组 = "没有验证过任何组合"）。
   *   客户端拿它回答"目标补丁层与它声明的 DSH 版本是不是一对验证过的组合"，
   *   而这个问题的答案**只有发布方知道**：客户端从本机推断只能得到
   *   "目标与本机是不是同一对"，那恰好与真相相反——正常的 DSH 升级本来
   *   就会换掉这一对。
   *
   *   空数组是合法的，后果是客户端把这次发行判为 `unverified` 并拒绝安装
   *   （`preflight-patch-pair-unverified`）。那是刻意的：与其让客户端猜，
   *   不如让"这一批没测过"在用户之前先被说出来。
   */
  dshPatchBindings = [],
  keyId, privateKeyPem, sequence, issuedAt, expiresAt, outDir = null,
} = {}) {
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`)
  const manifestCheck = validateManifest(productManifest)
  if (manifestCheck.ok !== true) {
    throw new Error(`产品清单校验未通过：${(manifestCheck.problems ?? []).map((p) => p.message ?? p.code).join('；')}`)
  }
  if (productManifest.productVersion !== productVersion) {
    throw new Error(`产品清单的 productVersion=${productManifest.productVersion} 与 --product-version=${productVersion} 不一致`)
  }
  if (packageZipPath === null && packageRoot === null) {
    throw new Error('publish 需要 --package-zip（已有的包）或 --package-root（由一个目录树现打）')
  }
  if (packageZipPath !== null && packageRoot !== null) {
    throw new Error('--package-zip 与 --package-root 只能给一个：两个都给时"用哪一个"没有答案')
  }

  const releasePrefix = `releases/${releaseId}`
  const packageRelative = `${releasePrefix}/legion-${platformToken(platform)}-${arch}.zip`

  // ★ 两种产出方式，但**只有一种**会带上闭包：
  //
  //   · `--package-root`：由本脚本打 ZIP，因此它知道包里每个文件的摘要，
  //     并把它写成包内的 `closure.json`；
  //   · `--package-zip`：包是别处打的，本脚本**只能**钉住整包摘要。
  //     这时 `closurePath`/`closureSha256` 缺席（合法的旧形态），而解压端
  //     仍然会拒未授权的可执行文件——只是"逐文件闭包"这一层没有证据。
  let pkg
  let packed = null
  let packageLocalPath
  if (packageRoot !== null) {
    packed = packDirectory({ root: packageRoot })
    if (packed.ok !== true) throw new Error(packed.reason)
    if (outDir === null) throw new Error('--package-root 需要 --out：打出来的包要落到磁盘上再算摘要')
    const target = join(outDir, 'package', basename(packageRelative))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, packed.zipBytes)
    packageLocalPath = target
    const base = artifactOfFile(packageRelative, target)
    pkg = Object.freeze({ ...base, closurePath: packed.closureName, closureSha256: packed.closureSha256 })
  } else {
    packageLocalPath = packageZipPath
    pkg = artifactOfFile(packageRelative, packageZipPath)
  }
  const installer = artifactOfFile(`${releasePrefix}/${basename(installerPath)}`, installerPath)
  const notes = artifactOfFile(`${releasePrefix}/${basename(notesPath)}`, notesPath)

  const release = buildRelease({
    releaseId, productVersion, channel, platform, arch,
    productManifest,
    supportedFromVersions,
    minWindowsBuild,
    requiredFreeBytes: requiredFreeBytes ?? (pkg.sizeBytes * 3 + 512 * 1024 * 1024),
    dshPatchBindings,
    package: pkg,
    installer,
    notes,
    migrationPlanDigest: resolveMigrationPlanDigest({ migrationPlan, migrationPlanDigest: explicitPlanDigest }),
    rollbackPolicy,
    issuedAt,
    expiresAt,
  })
  const validated = validateRelease(release)
  if (validated.ok !== true) throw new Error(`发行清单自检未通过：${validated.reason}`)

  const manifestBytes = Buffer.from(serializeEnvelope(signEnvelope(release, { privateKeyPem, keyId })), 'utf8')
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')

  const feed = buildFeedPayload({
    channel, platform, arch, sequence, issuedAt, expiresAt,
    releaseId, productVersion,
    manifestPath: `${releasePrefix}/manifest.json`,
    manifestSha256,
  })
  const feedBytes = Buffer.from(serializeEnvelope(signEnvelope(feed, { privateKeyPem, keyId })), 'utf8')

  return Object.freeze({
    format: PUBLISH_FORMAT,
    release,
    feed,
    feedPath: feedRelativePath(channel, platform, arch),
    /**
     * 上传清单：**先全部不可变文件，最后**才替换通道 envelope。
     *
     * 顺序在这里是数据结构的一部分（`immutable` 与 `mutable` 分开），
     * 而不是文档里的一句话——因为文档里的一句话在实现里最容易被"顺手
     * 一起传"取代。
     */
    immutable: Object.freeze([
      Object.freeze({ path: `${releasePrefix}/manifest.json`, bytes: manifestBytes, sha256: manifestSha256 }),
      Object.freeze({ path: pkg.path, localPath: packageLocalPath, bytes: null, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }),
      Object.freeze({ path: installer.path, localPath: installerPath, bytes: null, sha256: installer.sha256, sizeBytes: installer.sizeBytes }),
      Object.freeze({ path: notes.path, localPath: notesPath, bytes: null, sha256: notes.sha256, sizeBytes: notes.sizeBytes }),
    ]),
    mutable: Object.freeze([
      Object.freeze({ path: feedRelativePath(channel, platform, arch), bytes: feedBytes }),
    ]),
    summary: Object.freeze({
      releaseId, productVersion, channel, platform, arch, sequence, keyId,
      manifestSha256,
      feedSha256: createHash('sha256').update(feedBytes).digest('hex'),
      packageSha256: pkg.sha256,
      packageSizeBytes: pkg.sizeBytes,
      /** 闭包只在 `--package-root` 那条路上存在（见 buildPublish 的注释）。 */
      closurePath: pkg.closurePath ?? null,
      closureSha256: pkg.closureSha256 ?? null,
      closureFileCount: packed?.fileCount ?? null,
    }),
  })
}

function platformToken(platform) {
  return platform === 'win32' ? 'win' : platform
}

/**
 * 把一次发行的文件写到输出目录，并渲染上传计划。
 *
 * `target` / `remoteRoot`+`prefix` 决定上传计划指向哪棵树（见
 * `renderUploadPlan`）。**产物总是写出来**——"构建/签名"与"决定发到哪棵树"
 * 是两件事（设计 §9 的第 1、2 步是构建与校验，第 3 步才是上传）。
 *
 * ★ 但没有目标时写出的**不是**一份计划，而是一份拒答说明：里面**没有**任何
 *   `scp` 行。理由与 `renderUploadPlan` 相同——一份把目标猜错的指令会被人
 *   照着执行，而"没有指令"不可能被执行错。
 */
export function writePublish(publish, outDir, {
  target = null, remoteRoot = null, prefix = null,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const immutableDir = join(outDir, 'immutable')
  for (const entry of publish.immutable) {
    const target = join(immutableDir, entry.path)
    mkdirSync(join(target, '..'), { recursive: true })
    if (entry.bytes !== null) {
      writeFileSync(target, entry.bytes)
    } else {
      copyFileSync(entry.localPath, target)
    }
    // ★ 回读再算一遍。设计 §9 第 2 步要求「校验文件闭包、签名身份、包大小/摘要」，
    //   而"我刚写出去的东西"是最值得核一遍的：磁盘满、路径过长、杀毒隔离
    //   都会让写出去的内容与想写的不一样，而这两者在写的那一刻看起来一样。
    const reread = sha256OfFile(target)
    if (reread !== entry.sha256) {
      throw new Error(`写出去之后回读不一致：${entry.path}（期望 ${entry.sha256}，实际 ${reread}）`)
    }
    log(`ok  immutable ${entry.path}  ${entry.sizeBytes ?? entry.bytes.length} 字节`)
  }
  for (const entry of publish.mutable) {
    const target = join(outDir, 'channel', entry.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, entry.bytes)
    log(`ok  channel   ${entry.path}  ${entry.bytes.length} 字节`)
  }
  const plan = join(outDir, 'upload-plan.txt')
  if (target === null && remoteRoot === null && prefix === null) {
    writeFileSync(plan, renderNoTargetNotice(publish), 'utf8')
    log(`⚠ 没有给出上传目标，upload-plan.txt 里**没有**可执行的 scp 命令：${plan}`)
    log('  给 --target test|production（已部署的两棵树）或 --remote-root + --prefix 之后再生成一次')
    return { immutableDir, plan, planned: false }
  }
  writeFileSync(plan, renderUploadPlan(publish, outDir, { target, remoteRoot, prefix }), 'utf8')
  log(`ok  上传计划 ${plan}`)
  return { immutableDir, plan, planned: true }
}

/**
 * 没给上传目标时写出来的**拒答**（不是计划）。
 *
 * 它的全部内容都指向"去把目标填上"，而且**一行 `scp` 都没有**：一份可以被
 * 误执行的半成品，比一份明确的拒答危险得多。
 */
export function renderNoTargetNotice(publish) {
  return [
    '# Legion 更新发布：**没有**上传计划（缺上传目标）',
    '#',
    '# 本文件不是指令，请不要从中抄命令——这里一行 scp 都没有。',
    '#',
    '# 产物已经写好了（immutable/ 与 channel/），但"发到哪棵树"是一个必须',
    '# 显式给出的部署决定。原先的脚本把它默认成**生产树**，于是一次测试通道',
    '# 的发行会生成一份指向生产目录的上传指令——照做的人每一步都对，地方错了。',
    '#',
    '# 用下面两种之一重新生成一次：',
    '#   --target test|production    （托管上已部署的两棵树）',
    ...Object.entries(UPLOAD_TARGETS).map(([name, t]) => `#     ${name} → ${t.remoteRoot}  前缀 ${t.prefix}`),
    '#   --remote-root <user@host:/path> --prefix <url 前缀>   （域名接入后的其它托管）',
    '#',
    '# ★ 本通道（' + String(publish?.summary?.channel ?? '?') + '）按仓库里的 update-config.example.json',
    '#   应当发到：' + (CHANNEL_TARGETS[publish?.summary?.channel] ?? '（这个通道没有既定映射，请自行确认）'),
    '',
    '# 本次发行摘要（留档）',
    canonicalJson(publish.summary),
    '',
  ].join('\n')
}

/**
 * 托管上的两棵发布树（`2026-10-04-update-host-bootstrap.md` 的部署结果）。
 *
 * `test` 那棵给 internal 通道用（仓库里的 `update-config.example.json` 把
 * `internal` 映到 `http://117.72.146.36/test/legion`），`production` 那棵给
 * canary/stable 用。
 */
export const UPLOAD_TARGETS = Object.freeze({
  test: Object.freeze({ remoteRoot: 'root@117.72.146.36:/srv/legion-updates/test/legion', prefix: '/test/legion' }),
  production: Object.freeze({ remoteRoot: 'root@117.72.146.36:/srv/legion-updates/production/legion', prefix: '/legion' }),
})

/**
 * 通道 → 它该去的那棵树。**这是判据，不是提示**（见 `renderUploadPlan` 的说明）。
 *
 * ★ 导出它，是因为 `host-config.mjs` 需要**同一份**映射来回答"这棵树服务哪些
 *   通道"，从而推出"这棵树要不要 HTTPS"（`canary`/`stable` 必须 HTTPS，
 *   `internal` 可以显式用 http）。让第二处再写一份映射，就是又造了一个会各自
 *   漂移的真相来源——而本轮 ㉜ 找的正是"两处各自都对、接缝处对不上"。
 */
export const CHANNEL_TARGETS = Object.freeze({ internal: 'test', canary: 'production', stable: 'production' })

/**
 * 渲染上传计划。
 *
 * 三条命令、**固定顺序**，理由见文件头注释。它用 `scp` 而不是自研上传器，
 * 是因为"我们自己的上传实现"是又一个需要被审计的组件，而这一步的全部要求
 * 只是"把字节放到位置上"。
 *
 * ★★ **目标树必须显式给，没有默认值。**
 *
 *   这里原先的签名是
 *   `{ remoteRoot = 'root@117.72.146.36:/srv/legion-updates/production/legion' }`
 *   ——一个**写死的生产路径**，而它与通道无关。于是一次 `--channel internal`
 *   的测试发行会生成一份**指向生产树**的上传计划，还带着 `--prefix /legion`
 *   的回读命令（internal 的前缀其实是 `/test/legion`）。
 *
 *   这不是"默认值选得不好"，而是**生成了一条把测试物写进生产目录的操作指令**：
 *   照它执行的人会做对每一步，却把东西放错地方。而 `verify-host` 随后要么
 *   404、要么核到另一棵树——两种结果都不会告诉他"你传错了树"。
 *
 *   > 一份把目标猜错的部署指令，比一份要求你填目标的指令危险得多：
 *   > 前者会被人照着执行。
 *
 *   所以现在：要么给 `target`（`'test'` / `'production'`，对应托管上那两棵
 *   已部署的树），要么给 `remoteRoot` + `prefix` 这一**对**（用于域名接入后的
 *   其它托管）。两者都不给就**拒绝渲染**，并说清为什么没有默认值。
 *
 * ★ 另加一条通道/目标的一致性判据：`internal` 是测试通道（仓库的
 *   `update-config.example.json` 把它映到 `/test/legion`），把它发到生产树
 *   会被配好的客户端**永远读不到**——那是往生产里留垃圾，所以直接拒绝。
 */
export function renderUploadPlan(publish, outDir, { target = null, remoteRoot = null, prefix = null } = {}) {
  const channel = publish?.summary?.channel ?? null
  let root = remoteRoot
  let urlPrefix = prefix

  if (target !== null) {
    if (remoteRoot !== null || prefix !== null) {
      throw new Error('renderUploadPlan 的 target 与 remoteRoot/prefix 只能给一种：两处都给时"以哪个为准"没有答案')
    }
    const chosen = UPLOAD_TARGETS[target]
    if (chosen === undefined) {
      throw new Error(`未知的上传目标 ${JSON.stringify(target)}：只支持 ${Object.keys(UPLOAD_TARGETS).join(' / ')}`)
    }
    root = chosen.remoteRoot
    urlPrefix = chosen.prefix
  }

  if (typeof root !== 'string' || root === '' || typeof urlPrefix !== 'string' || urlPrefix === '') {
    throw new Error(
      'renderUploadPlan 需要一个**显式**的上传目标：给 --target test|production，'
      + '或给 --remote-root 与 --prefix 这一对。\n'
      + '  ★ 这里刻意**没有**默认值：原先的默认是写死的生产路径，'
      + '    于是测试通道的发行会生成一份指向生产目录的上传指令。\n'
      + `    已部署的两棵树：${Object.entries(UPLOAD_TARGETS).map(([k, v]) => `${k} → ${v.remoteRoot}（前缀 ${v.prefix}）`).join('；')}`,
    )
  }

  const expected = CHANNEL_TARGETS[channel]
  if (expected !== undefined && target !== null && target !== expected) {
    throw new Error(
      `通道 ${channel} 的发行应该发到 ${expected} 那棵树，而不是 ${target}：`
      + (expected === 'test'
        ? `内部/测试通道的订阅地址是 ${UPLOAD_TARGETS.test.prefix}，发到生产树会被配好的客户端永远读不到`
        : `正式通道的发行必须走生产树与门禁流程（设计 §10：stable 需阶段 D 通过后才开放）`),
    )
  }

  const lines = []
  lines.push('# Legion 更新发布上传计划')
  lines.push('#')
  lines.push('# 顺序**不可交换**（设计 §9 line 202）：')
  lines.push('#   先传全部不可变文件，人工/CI 核对之后再替换通道清单。')
  lines.push('#   反过来的话，任何一次部分失败都会留下"通道指向一个不存在的 releaseId"。')
  lines.push('#')
  lines.push(`# ★ 目标树：${target ?? '(显式给出)'} → ${root}`)
  lines.push(`#   客户端将从这个前缀读到通道清单：${urlPrefix}`)
  lines.push(`#   （发布前确认这就是该通道该去的那棵树——这一步没有默认值。）`)
  lines.push('')
  lines.push('# 第 0 步（**发布前先做**）：读出托管上当前的 sequence，再决定本次用几号')
  lines.push('#   ★ 设计 §9 第 4 步的原话是「生成**更大的** sequence」。而 `--sequence` 是')
  lines.push('#     显式给的——这一步就是"怎么知道它该是几"。跳过它，发布端只能凭记忆')
  lines.push('#     或从上次的输出里抄一个数字，而抄错的方向有两种，都很安静：')
  lines.push('#       · 抄小了 → 新清单被客户端判成回退（`feed-sequence-regression`），')
  lines.push('#         于是**没有任何人去取这个版本**，而发布端看到的一切正常；')
  lines.push('#       · 抄了同号 → 摘要不同 ⇒ `feed-sequence-conflict`，同样静默。')
  lines.push('#     两种都不会在发布端报错，只会在客户端那一侧"新版本发布了但没人更新"。')
  lines.push(`node scripts/update/verify-host.mjs --origin <该树的 origin> --prefix ${urlPrefix} \\`)
  lines.push(`  --channel ${channel}`)
  lines.push('#   ↑ 输出里的 "sequence" 就是当前值；本次请用**它 + 1**（或更大）。')
  lines.push(`#   本次发行用的 sequence = ${publish.summary.sequence}`)
  lines.push('')
  lines.push(`# 第 1 步：不可变文件（发行目录不会被覆盖，可以安全重传）`)
  lines.push(`scp -r "${join(outDir, 'immutable', 'releases')}" ${root}/`)
  lines.push('')
  lines.push('# 第 2 步：公网回读核对（必须在这一步通过之后才做第 3 步）')
  lines.push(`node scripts/update/verify-host.mjs --origin <该树的 origin> --prefix ${urlPrefix} \\`)
  lines.push(`  --channel ${channel} --expect-release-id ${publish.summary.releaseId}`)
  lines.push('')
  lines.push('# 第 3 步：替换通道清单（单个对象，最后一步）')
  for (const entry of publish.mutable) {
    lines.push(`scp "${join(outDir, 'channel', entry.path)}" ${root}/${entry.path}`)
  }
  lines.push('')
  lines.push('# 第 4 步：再次回读，确认通道清单的 sequence 已经推进')
  lines.push(`node scripts/update/verify-host.mjs --origin <该树的 origin> --prefix ${urlPrefix} \\`)
  lines.push(`  --channel ${channel} --expect-sequence ${publish.summary.sequence}`)
  lines.push('')
  lines.push(`# 本次发行摘要（留档）`)
  lines.push(canonicalJson(publish.summary))
  return `${lines.join('\n')}\n`
}

/**
 * 解析 `--dsh-patch-bindings <dshVersion>:<n>[,<dshVersion>:<n>…]`。
 *
 * ★ 用**逗号分隔的一个参数**，不是可重复的参数。
 *   `parseArgs` 把参数收进一个 `Map`，重复给同一个开关只会**覆盖**——
 *   于是 `--dsh-patch-binding a:1 --dsh-patch-binding b:2` 会静默地只剩
 *   最后一项，而症状是"表里少了一对"，看起来像补丁层的问题。
 *   （要支持可重复就得改 `parseArgs` 的返回形状，而那会影响这个脚本里
 *   其它每一个开关。）
 *
 * 形状在这里就拒（缺冒号、补丁版本不是正整数）：一个拼错的绑定**不会**
 * 导致发布失败——它会变成表里一个永远匹配不上的项，于是症状是客户端报
 * "目标补丁层与 DSH 版本不成对"，而原因看起来像补丁层的问题。
 */
export function parsePatchBindings(raw) {
  if (raw === undefined || raw === null || raw === true) return []
  const values = String(raw).split(',').map((item) => item.trim()).filter(Boolean)
  const out = []
  for (const value of values) {
    const at = value.lastIndexOf(':')
    if (at <= 0 || at === value.length - 1) {
      throw new Error(`--dsh-patch-bindings 的格式是 <dshVersion>:<compositionPatchVersion>，实际是 ${JSON.stringify(value)}`)
    }
    const dshVersion = value.slice(0, at)
    const patchText = value.slice(at + 1)
    if (!/^\d+$/.test(patchText)) {
      throw new Error(`--dsh-patch-bindings 的补丁层版本必须是正整数，实际是 ${JSON.stringify(patchText)}`)
    }
    out.push(Object.freeze({ dshVersion, compositionPatchVersion: Number(patchText) }))
  }
  return out
}

/**
 * 求"固定迁移计划"的摘要。
 *
 * ★ 优先**算**而不是优先收。
 *
 *   · `migrationPlan`（数组）：摘要由 `migration.mjs` 的 `migrationPlanDigest`
 *     **算出来**——与客户端核对时用的是**同一个函数**。发布端与客户端各写
 *     一份算法，就是一条"两边算出不同值、而升级永远失败"的路径。
 *   · `migrationPlanDigest`（字符串）：直接给摘要（兼容旧用法）。
 *   · 都不给：**空计划的固定摘要**（不是抛错，也不是随手填的占位串）。
 *     产品目前没有迁移，而"本次发行没有迁移"是一个合法的声明——
 *     它必须等于客户端算出的那个值，否则安装会在动任何东西之前被挡下
 *     （`install-migration-plan-mismatch`）。
 */
export function resolveMigrationPlanDigest({ migrationPlan = null, migrationPlanDigest: explicit = null } = {}) {
  if (Array.isArray(migrationPlan)) return migrationPlanDigest(migrationPlan)
  if (migrationPlan !== null && migrationPlan !== undefined) throw new Error('migrationPlan 必须是数组')
  if (typeof explicit === 'string' && explicit !== '') {
    if (!/^[0-9a-f]{64}$/.test(explicit)) {
      throw new Error(`migrationPlanDigest 必须是 64 位小写十六进制，实际是 ${JSON.stringify(explicit)}`)
    }
    return explicit
  }
  return EMPTY_MIGRATION_PLAN_DIGEST
}

/** 命令行侧：`--migration-plan <文件>` 读成数组；`--migration-plan-digest` 直传。 */
export function migrationPlanDigestFromArgs(planPath, explicitDigest) {
  let migrationPlan = null
  if (typeof planPath === 'string' && planPath !== '' && planPath !== 'true') {
    try {
      migrationPlan = JSON.parse(readFileSync(planPath, 'utf8'))
    } catch (error) {
      throw new Error(`--migration-plan 读不出来：${error?.message ?? error}`)
    }
    if (!Array.isArray(migrationPlan)) throw new Error('--migration-plan 必须是一个数组')
  }
  return resolveMigrationPlanDigest({
    migrationPlan,
    migrationPlanDigest: typeof explicitDigest === 'string' && explicitDigest !== '' && explicitDigest !== 'true'
      ? explicitDigest : null,
  })
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  /**
   * 上传目标：`--target test|production`，或 `--remote-root` + `--prefix` 一对。
   *
   * ★ 命令行这边**必须**给，而且**先于**任何构建工作给（与 `writePublish` 的
   *   宽松不同）。一次"发布"在操作者心里总是包含"发到哪"，所以让工具在开头
   *   就把这件事问清楚，比等产物写完之后再警告一句要好——后者很容易被忽略。
   */
  const target = typeof args.get('target') === 'string' && args.get('target') !== 'true' ? args.get('target') : null
  const remoteRoot = typeof args.get('remote-root') === 'string' && args.get('remote-root') !== 'true' ? args.get('remote-root') : null
  const prefix = typeof args.get('prefix') === 'string' && args.get('prefix') !== 'true' ? args.get('prefix') : null
  if (target === null && (remoteRoot === null || prefix === null)) {
    process.stderr.write(
      '发布需要显式的上传目标：--target test|production，或 --remote-root <user@host:/path> 与 --prefix <url 前缀> 一起给。\n'
      + '  ★ 这里刻意没有默认值：原先默认成**生产树**，于是测试通道的发行会生成一份\n'
      + '    指向生产目录的上传指令——照做的人每一步都对，地方错了。\n'
      + Object.entries(UPLOAD_TARGETS).map(([name, t]) => `    ${name} → ${t.remoteRoot}  前缀 ${t.prefix}\n`).join(''),
    )
    return 2
  }

  try {
    const productManifestPath = requireString(args, 'product-manifest')
    const productManifest = JSON.parse(readFileSync(productManifestPath, 'utf8'))
    const outDir = resolve(args.get('out') ?? join('dist', 'update', requireString(args, 'release-id')))
    const packageRoot = typeof args.get('package-root') === 'string' && args.get('package-root') !== 'true'
      ? args.get('package-root') : null
    const packageZipArg = typeof args.get('package-zip') === 'string' && args.get('package-zip') !== 'true'
      ? args.get('package-zip') : null
    const publish = buildPublish({
      productVersion: requireString(args, 'product-version'),
      channel: requireString(args, 'channel'),
      releaseId: requireString(args, 'release-id'),
      platform: args.get('platform') ?? 'win32',
      arch: args.get('arch') ?? 'x64',
      productManifest,
      supportedFromVersions: String(args.get('from-versions') ?? requireString(args, 'from-version')).split(',').map((s) => s.trim()).filter(Boolean),
      minWindowsBuild: Number(args.get('min-windows-build') ?? 19045),
      requiredFreeBytes: args.get('required-free-bytes') !== undefined ? Number(args.get('required-free-bytes')) : undefined,
      // `--dsh-patch-bindings <dshVersion>:<n>[,…]`。
      // 一个都没给就是**空表**（= 本次没有验证过任何组合）→ 客户端会拒绝安装。
      dshPatchBindings: parsePatchBindings(args.get('dsh-patch-bindings')),
      // ★ 两者只能给一个。都由 `buildPublish` 检查，理由在那里。
      packageRoot,
      packageZipPath: packageZipArg,
      installerPath: requireString(args, 'installer'),
      notesPath: requireString(args, 'notes'),
      migrationPlanDigest: migrationPlanDigestFromArgs(args.get('migration-plan'), args.get('migration-plan-digest')),
      rollbackPolicy: args.get('rollback-policy') ?? 'program-only',
      keyId: requireString(args, 'key-id'),
      privateKeyPem: readFileSync(requireString(args, 'private-key'), 'utf8'),
      sequence: Number(requireString(args, 'sequence')),
      issuedAt: requireString(args, 'issued-at'),
      expiresAt: requireString(args, 'expires-at'),
      outDir,
    })
    const written = writePublish(publish, outDir, { target, remoteRoot, prefix })
    process.stdout.write(`${JSON.stringify({ ...publish.summary, planned: written.planned }, null, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`发布失败：${error?.message ?? error}\n`)
    return 2
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) process.exitCode = main()
