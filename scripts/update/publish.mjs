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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import { buildFeedPayload } from '../../product/update/feed.mjs'
import { buildRelease, validateRelease, validateRelativePath } from '../../product/update/release.mjs'
import { serializeEnvelope, signEnvelope } from '../../product/update/envelope.mjs'
import { canonicalJson } from '../../product/update/canonical.mjs'
import { feedRelativePath } from '../../product/update/host.mjs'
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
 * 构造一次发行的全部文件（内存里），由调用方决定往哪写。
 *
 * 返回的 `files` 是一张 `相对路径 → 字节` 的表，路径全部相对**存储前缀**
 * （即 `/legion/` 之下），所以上传时按原样落到托管上即可。
 */
export function buildPublish({
  productVersion, channel, releaseId, platform = 'win32', arch = 'x64',
  productManifest, supportedFromVersions, minWindowsBuild = 19045, requiredFreeBytes,
  packageZipPath, installerPath, notesPath,
  migrationPlanDigest, rollbackPolicy = 'program-only',
  keyId, privateKeyPem, sequence, issuedAt, expiresAt,
} = {}) {
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`)
  const manifestCheck = validateManifest(productManifest)
  if (manifestCheck.ok !== true) {
    throw new Error(`产品清单校验未通过：${(manifestCheck.problems ?? []).map((p) => p.message ?? p.code).join('；')}`)
  }
  if (productManifest.productVersion !== productVersion) {
    throw new Error(`产品清单的 productVersion=${productManifest.productVersion} 与 --product-version=${productVersion} 不一致`)
  }

  const releasePrefix = `releases/${releaseId}`
  const pkg = artifactOfFile(`${releasePrefix}/legion-${platformToken(platform)}-${arch}.zip`, packageZipPath)
  const installer = artifactOfFile(`${releasePrefix}/${basename(installerPath)}`, installerPath)
  const notes = artifactOfFile(`${releasePrefix}/${basename(notesPath)}`, notesPath)

  const release = buildRelease({
    releaseId, productVersion, channel, platform, arch,
    productManifest,
    supportedFromVersions,
    minWindowsBuild,
    requiredFreeBytes: requiredFreeBytes ?? (pkg.sizeBytes * 3 + 512 * 1024 * 1024),
    package: pkg,
    installer,
    notes,
    migrationPlanDigest,
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
      Object.freeze({ path: pkg.path, localPath: packageZipPath, bytes: null, sha256: pkg.sha256, sizeBytes: pkg.sizeBytes }),
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
    }),
  })
}

function platformToken(platform) {
  return platform === 'win32' ? 'win' : platform
}

/** 把一次发行的文件写到输出目录，并按上传顺序打印命令。 */
export function writePublish(publish, outDir, { log = (line) => process.stdout.write(`${line}\n`) } = {}) {
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
  writeFileSync(plan, renderUploadPlan(publish, outDir), 'utf8')
  log(`ok  上传计划 ${plan}`)
  return { immutableDir, plan }
}

/**
 * 渲染上传计划。
 *
 * 两条命令、**固定顺序**，理由见文件头注释。它用 `scp`/`rsync` 而不是自研
 * 上传器，是因为"我们自己的上传实现"是又一个需要被审计的组件，而这一步的
 * 全部要求只是"把字节放到位置上"。
 */
export function renderUploadPlan(publish, outDir, { remoteRoot = 'root@117.72.146.36:/srv/legion-updates/production/legion' } = {}) {
  const lines = []
  lines.push('# Legion 更新发布上传计划')
  lines.push('#')
  lines.push('# 顺序**不可交换**（设计 §9 line 202）：')
  lines.push('#   先传全部不可变文件，人工/CI 核对之后再替换通道清单。')
  lines.push('#   反过来的话，任何一次部分失败都会留下"通道指向一个不存在的 releaseId"。')
  lines.push('')
  lines.push(`# 第 1 步：不可变文件（发行目录不会被覆盖，可以安全重传）`)
  lines.push(`scp -r "${join(outDir, 'immutable', 'releases')}" ${remoteRoot}/`)
  lines.push('')
  lines.push('# 第 2 步：公网回读核对（必须在这一步通过之后才做第 3 步）')
  lines.push(`node scripts/update/verify-host.mjs --origin <生产 origin> --prefix /legion \\`)
  lines.push(`  --channel ${publish.summary.channel} --expect-release-id ${publish.summary.releaseId}`)
  lines.push('')
  lines.push('# 第 3 步：替换通道清单（单个对象，最后一步）')
  for (const entry of publish.mutable) {
    lines.push(`scp "${join(outDir, 'channel', entry.path)}" ${remoteRoot}/${entry.path}`)
  }
  lines.push('')
  lines.push('# 第 4 步：再次回读，确认通道清单的 sequence 已经推进')
  lines.push(`node scripts/update/verify-host.mjs --origin <生产 origin> --prefix /legion \\`)
  lines.push(`  --channel ${publish.summary.channel} --expect-sequence ${publish.summary.sequence}`)
  lines.push('')
  lines.push(`# 本次发行摘要（留档）`)
  lines.push(canonicalJson(publish.summary))
  return `${lines.join('\n')}\n`
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  try {
    const productManifestPath = requireString(args, 'product-manifest')
    const productManifest = JSON.parse(readFileSync(productManifestPath, 'utf8'))
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
      packageZipPath: requireString(args, 'package-zip'),
      installerPath: requireString(args, 'installer'),
      notesPath: requireString(args, 'notes'),
      migrationPlanDigest: requireString(args, 'migration-plan-digest'),
      rollbackPolicy: args.get('rollback-policy') ?? 'program-only',
      keyId: requireString(args, 'key-id'),
      privateKeyPem: readFileSync(requireString(args, 'private-key'), 'utf8'),
      sequence: Number(requireString(args, 'sequence')),
      issuedAt: requireString(args, 'issued-at'),
      expiresAt: requireString(args, 'expires-at'),
    })
    const outDir = resolve(args.get('out') ?? join('dist', 'update', publish.summary.releaseId))
    writePublish(publish, outDir)
    process.stdout.write(`${JSON.stringify(publish.summary, null, 2)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`发布失败：${error?.message ?? error}\n`)
    return 2
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) process.exitCode = main()
