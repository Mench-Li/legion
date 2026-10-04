// product/update/client.mjs
// ============================================================================
// 更新客户端 —— 把 A 阶段的协议件装成设计 §7 那张有界操作表
//
// 设计 §7 line 152–160 给出了 preload 只能暴露的操作，以及每个操作的
// 输入。这张表是**有界**的，意思是：没有 `update.fetch(url)`、没有
// `update.install(path)`、没有任何接受"任意地址/任意路径/任意 shell 参数"
// 的入口。本模块就是这张表的主进程侧实现。
//
// ## 一次检查的完整路径（以及每一步为什么必须在那个位置）
//
//   1. 取通道清单字节          —— 严格 JSON + 验签 + 有效期 + sequence 高水位
//   2. 取发行清单字节          —— 同一把钥匙验签 + 摘要必须与第 1 步声明的一致
//   3. 校验发行清单            —— 身份绑定到第 1 步（releaseId/版本/平台）
//   4. 得候选                  —— 身份 = releaseId + 版本 + 发行摘要
//
// 第 2 步的**摘要比对**是这里最容易漏的一条：只验签不比对摘要，等于允许
// 通道说 A、发行清单是 B——两份清单各自都是合法签名的，组合起来却不是
// 发布方想表达的意思。所以 `manifestSha256` 在这里被当成硬判据。
//
// ## 为什么下载要绑定候选身份
//
// 设计 §6 line 138：「用户确认绑定该身份；发布端变更清单不替换正在下载或
// 已下载的目标。」
//
// 所以 `download(releaseId, manifestDigest)` 的输入是**身份**，不是"最新版"。
// 一次下载开始之后，即使后台检查发现 releaseId 变了，这次下载也继续按
// 原身份完成；界面上"你确认的是 1.2.0"这句话在整个过程中都成立。
// ============================================================================

import { createHash } from 'node:crypto'
import { release as osRelease } from 'node:os'
import { join } from 'node:path'

import { createDownloadCache } from './cache.mjs'
import { createCheckScheduler, CHECK_OUTCOMES } from './schedule.mjs'
import { createSequenceStore, judgeSequence, recordSequence, selectCandidate, validateFeedPayload } from './feed.mjs'
import { releaseIdentity, sameIdentity, validateRelease } from './release.mjs'
import { checkLocalWindowsBuild } from './platform-build.mjs'
import { UPDATE_CODES_CLIENT, describeError } from './errors.mjs'
import {
  MAX_MANIFEST_BYTES, commitDownload, createTransport, discardDownload, hashFileOnDisk,
} from './transport.mjs'
import { artifactUrl, feedUrl, releaseManifestUrl } from './host.mjs'
import { ENVELOPE_FORMATS, verifyEnvelope } from './envelope.mjs'
import { transition, UPDATE_CHAIN } from './state.mjs'

/**
 * 本机内核版本字符串（`os.release()` 的形状，如 `10.0.19045`）。
 *
 * 读不到给 `null`，由 `checkLocalWindowsBuild` 决定怎么处置
 * （在 win32 上那是**失败**，不是跳过——见那个模块的文件头）。
 */
function currentWindowsBuildSource() {
  try {
    return osRelease()
  } catch {
    return null
  }
}

/** 检查的结论（与 `schedule.mjs` 的 `CHECK_OUTCOMES` 对齐）。 */
export { CHECK_OUTCOMES }

/** 发布说明的大小上限。它是一段说明，不是文档库。 */
export const MAX_NOTES_BYTES = 64 * 1024

/**
 * 把字节解成纯文本，**不是纯文本就返回 null**。
 *
 * 判据：合法 UTF-8、不含 NUL、控制字符只允许 \t \n \r。
 * 最后一条是关键：一份"摘要对得上"的 `.txt` 里如果塞了终端控制序列或
 * 转义字节，把它渲染到界面上是另一类问题（设计 §5 选择纯文本正是为了
 * 避开这一类）。
 */
export function decodePlainText(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.includes(0)) return null
  const decoded = buffer.toString('utf8')
  // `toString('utf8')` 会把非法字节替换成 U+FFFD；出现了就说明它不是 UTF-8。
  if (decoded.includes('\ufffd')) return null
  for (const char of decoded) {
    const code = char.codePointAt(0)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null
    if (code === 0x7f) return null
  }
  return decoded
}

/**
 * 建立更新客户端。
 *
 * @param {object} args
 * @param {object} args.config            `config.mjs` 的 `loadUpdateConfig` 结果
 * @param {string} args.cacheDir
 * @param {string} args.currentVersion
 * @param {object} [args.installer]       安装事务（Stage C）。为 null 时
 *                                        `install()` 明确返回"未接线"。
 * @param {Function} [args.fetchImpl]
 * @param {Function} [args.now]
 * @param {Function} [args.onState]
 */
export function createUpdateClient({
  config,
  cacheDir,
  currentVersion,
  installer = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  onState = () => {},
  log = () => {},
  platform = 'win32',
  arch = 'x64',
  /**
   * 本机内核版本字符串（`os.release()` 的形状，如 `10.0.19045`）。
   *
   * `null` = 自己去读 `os.release()`。测试与需要在别的平台上模拟 win32 的
   * 调用方显式给值——`os.release()` 在这台机器上是什么，是不受用例控制的。
   */
  localKernelRelease = null,
  /** 正在跑这段代码的机器（与目标发行声明的 `platform` 是两件事）。 */
  hostPlatform = process.platform,
} = {}) {
  if (typeof currentVersion !== 'string' || currentVersion === '') {
    throw new Error('createUpdateClient 需要 currentVersion')
  }
  if (typeof cacheDir !== 'string' || cacheDir === '') throw new Error('createUpdateClient 需要 cacheDir')

  const transport = createTransport({ fetchImpl, now })
  const cache = createDownloadCache({ cacheDir, hashFileOnDisk, now })
  const sequenceStore = createSequenceStore({ file: join(cacheDir, 'channel-sequence.json') })

  let state = 'idle'
  let candidate = null            // 当前候选（含身份）
  let release = null              // 已验证的发行清单
  let lastCheck = null            // 读数字段：不参与主状态（见 state.mjs 的注释）
  let lastError = null
  let progress = null             // { releaseId, bytes, total, phase }
  let downloadAbort = null
  let downloadOperationId = 0
  let activeDownload = null
  let readyIdentity = null
  let snoozedUntilMs = null
  let inFlightCheck = null
  /** 发布说明（设计 §7 line 146：发现新版后展示版本、发布说明）。 */
  let releaseNotes = null
  const listeners = new Set()

  function publish() {
    const current = snapshot()
    for (const listener of listeners) {
      // ★ 一个订阅者的异常不能影响其它订阅者，也不能影响客户端本身：
      //   界面代码抛错时，更新流程必须继续。
      try { listener(current) } catch (error) { log(`[update] 订阅者报错：${error?.message ?? error}`) }
    }
    onState(current)
  }

  function snapshot() {
    return Object.freeze({
      state,
      label: null,
      usable: config?.usable === true,
      unavailableReason: config?.usable === true ? null : (config?.reason ?? '检查更新不可用'),
      channel: config?.channel ?? null,
      currentVersion,
      candidate: candidate === null ? null : Object.freeze({ ...candidate }),
      releaseId: candidate?.releaseId ?? null,
      productVersion: candidate?.productVersion ?? null,
      identityLabel: candidate === null ? null : identityText(candidate),
      manifestDigest: candidate?.manifestSha256 ?? null,
      progress: progress === null ? null : Object.freeze({ ...progress }),
      ready: readyIdentity !== null,
      readyIdentity: readyIdentity === null ? null : Object.freeze({ ...readyIdentity }),
      lastCheck: lastCheck === null ? null : Object.freeze({ ...lastCheck }),
      lastError: lastError === null ? null : Object.freeze({ ...lastError }),
      releaseNotes: releaseNotes === null ? null : releaseNotes.text,
      releaseNotesUnavailableReason: releaseNotes === null ? null : releaseNotes.reason,
      snoozedUntilMs,
      pendingTasks: null,
      operationId: activeDownload === null ? null : activeDownload.operationId,
    })
  }

  function setState(event, detail = {}) {
    const result = transition(state, event)
    if (!result.ok) {
      log(`[update] 非法事件 ${event}（当前 ${state}）：${result.code}`)
      return result
    }
    const changed = result.state !== state
    state = result.state
    if (result.code === 'update-state-unchanged' && event === 'check-failed') {
      // ★ 受保护状态上的检查失败：状态不变，但**错误要记下来**。
      //   否则"下载中遇到托管抖动"在界面上完全没有痕迹。
      log(`[update] ${detail.reason ?? '检查失败'}（状态保持 ${state}）`)
    }
    publish()
    return Object.freeze({ ...result, changed, event })
  }

  // -------------------------------------------------------------------------
  // 检查
  // -------------------------------------------------------------------------

  /**
   * 取一个清单字节并验签。
   *
   * 返回 `{ok, payload, bytes, digest}` 或 `{ok: false, code, reason}`
   * （错误已经是可展示的中文，不是 `Error` 对象——设计 §6 line 134：
   * 「自动检查失败只留脱敏日志；用户手动检查显示错误和重试按钮」）。
   */
  async function fetchVerifiedEnvelope(url, { expectedFormat, relativePath, signal, maxBytes = MAX_MANIFEST_BYTES }) {    const fetched = await transport.fetchBytes(config.host, url, { signal, relativePath, maxBytes })
    if (!fetched.ok) return Object.freeze({ ok: false, code: fetched.code, reason: fetched.reason })
    const verified = verifyEnvelope(fetched.body, {
      trust: config.trustStore,
      nowMs: now(),
      maxBytes,
      expectedFormat,
    })
    if (!verified.ok) {
      return Object.freeze({ ok: false, code: verified.code, reason: describeError(verified.code, verified.reason) })
    }
    return Object.freeze({
      ok: true, payload: verified.payload, bytes: fetched.body.length,
      digest: sha256HexOfBytes(fetched.body), keyId: verified.keyId,
    })
  }

  async function performCheck(trigger, signal) {
    if (config?.usable !== true) {
      return Object.freeze({
        outcome: 'failed', code: config?.code ?? UPDATE_CODES_CLIENT.NOT_CONFIGURED,
        reason: config?.reason ?? '检查更新不可用',
      })
    }

    // —— 第 1 步：通道清单 ——
    const feedResult = await fetchVerifiedEnvelope(feedUrl(config.host), {
      expectedFormat: ENVELOPE_FORMATS.FEED,
      relativePath: relativePathOf(feedUrl(config.host), config.host),
      signal,
    })
    if (!feedResult.ok) return Object.freeze({ outcome: 'failed', code: feedResult.code, reason: feedResult.reason })

    const validatedFeed = validateFeedPayload(feedResult.payload, {
      channel: config.channel, platform: config.host.platform, arch: config.host.arch,
    })
    if (!validatedFeed.ok) {
      return Object.freeze({
        outcome: 'failed', code: validatedFeed.code,
        reason: describeError(validatedFeed.code, validatedFeed.reason),
      })
    }
    const feed = validatedFeed.feed

    // —— sequence 高水位（设计 §5 line 126）——
    const existing = sequenceStore.read()
    const judgement = judgeSequence(existing, feed)
    if (!judgement.accept) {
      return Object.freeze({
        outcome: 'failed', code: judgement.code,
        reason: describeError(judgement.code, judgement.reason),
      })
    }

    // —— 第 2 步：发行清单，摘要必须与通道声明的**逐字节**一致 ——
    const manifestUrl = releaseManifestUrl(config.host, feed.releaseId)
    const manifestResult = await fetchVerifiedEnvelope(manifestUrl, {
      expectedFormat: ENVELOPE_FORMATS.RELEASE,
      relativePath: `releases/${feed.releaseId}/manifest.json`,
      signal,
    })
    if (!manifestResult.ok) {
      return Object.freeze({ outcome: 'failed', code: manifestResult.code, reason: manifestResult.reason })
    }
    if (manifestResult.digest !== feed.manifestSha256) {
      // ★ 这一步比验签更容易被漏掉，而它挡的正是"通道说 A、清单是 B"。
      return Object.freeze({
        outcome: 'failed', code: UPDATE_CODES_CLIENT.MANIFEST_DIGEST_MISMATCH,
        reason: `发行清单字节与通道声明的摘要不符（声明 ${feed.manifestSha256.slice(0, 12)}…，实际 ${manifestResult.digest.slice(0, 12)}…）`,
      })
    }

    // —— 第 3 步：校验发行清单并把身份钉到通道清单上 ——
    //
    // ★ `minWindowsBuildRequired` 必须真的传进来。
    //
    //   `release.mjs` 里那条「需要 Windows build N，本机是 M」的判据由它驱动，
    //   而在此之前**全仓没有任何调用方传过**——那条判据在生产里不可达，
    //   于是一份声明"只支持 Win11"（`minWindowsBuild: 22000`）的发行会在
    //   Win10 19045 上被接受并安装。同一批里 `install.mjs` 把 `windowsBuild`
    //   传给了 `runPreflight`，而 `runPreflight` 从不读它——两处加起来，
    //   操作系统的版本门禁从来没有生效过。
    //
    //   读不出本机版本时**明确失败**（不是跳过）：`checkLocalWindowsBuild`
    //   的注释里说明了为什么"读不出来"与"支持"是两件事。
    const buildFloor = checkLocalWindowsBuild({
      hostPlatform,
      platform: feed.platform,
      minWindowsBuild: manifestResult.payload?.minWindowsBuild ?? null,
      release: localKernelRelease ?? currentWindowsBuildSource(),
    })
    if (buildFloor.ok !== true) {
      return Object.freeze({ outcome: 'failed', code: UPDATE_CODES_CLIENT.UNSUPPORTED_PLATFORM, reason: buildFloor.reason })
    }

    const validatedRelease = validateRelease(manifestResult.payload, {
      expect: {
        releaseId: feed.releaseId,
        productVersion: feed.productVersion,
        channel: feed.channel,
        platform: feed.platform,
        arch: feed.arch,
      },
      // 上面那一步已经拒过一次（带着更具体的说法），这里仍然把读数传进去：
      // `validateRelease` 的那条判据是**清单自检**的一部分，而"清单自检里
      // 的一条判据永远不可达"正是这次要修的东西。
      minWindowsBuildRequired: buildFloor.local ?? null,
    })
    if (!validatedRelease.ok) {
      return Object.freeze({
        outcome: 'failed', code: validatedRelease.code,
        reason: describeError(validatedRelease.code, validatedRelease.reason),
      })
    }

    // 通过之后才推进高水位：一份被拒的清单**不能**抬高水位，否则一次
    // 中间人投毒（或一次发布端事故）就会把客户端永久锁在那个序号上。
    sequenceStore.write(recordSequence(existing, feed))

    // —— 第 4 步：候选 ——
    const selected = selectCandidate({ feed, currentVersion })
    lastCheck = Object.freeze({
      atMs: now(), trigger, outcome: 'ok', code: selected.code, reason: selected.reason,
      feedSequence: feed.sequence, releaseId: feed.releaseId, productVersion: feed.productVersion,
    })

    if (selected.verdict === 'newer') {
      candidate = Object.freeze({
        ...selected.candidate,
        manifestSha256: feed.manifestSha256,
      })
      release = validatedRelease.release
      readyIdentity = null
      setState('check-available', {})
      // 发布说明在候选确定之后取，而且**失败不致命**：一份取不到的说明
      // 不该让"发现新版本"这件事整体失败。
      releaseNotes = await fetchReleaseNotes(release)
      publish()
      return Object.freeze({
        outcome: 'available', code: selected.code, reason: selected.reason,
        candidate: candidate, release,
      })
    }

    // 没有候选：把候选与发行清掉，并落到 `up-to-date`。
    candidate = null
    release = null
    releaseNotes = null
    setState('check-up-to-date', {})
    publish()
    return Object.freeze({ outcome: 'up-to-date', code: selected.code, reason: selected.reason, verdict: selected.verdict })
  }

  /**
   * 取发布说明。
   *
   * 设计 §5 规定发布说明是**纯文本**（`notes` 是 `.txt`），理由写在设计里：
   * 避免运行外部 HTML。所以这里除了摘要与大小之外，还要**拒收二进制**——
   * 一份"内容摘要对得上但其实是 PE 文件"的 notes 会被界面当作文本渲染，
   * 而渲染二进制是所有人都不想要的结果。
   */
  async function fetchReleaseNotes(targetRelease) {
    const notes = targetRelease?.notes ?? null
    if (notes === null || typeof notes.path !== 'string') {
      return Object.freeze({ text: null, reason: '这个发行没有发布说明' })
    }
    const urlResult = artifactUrl(config.host, notes.path)
    if (!urlResult.ok) return Object.freeze({ text: null, reason: urlResult.reason })
    const fetched = await transport.fetchBytes(config.host, urlResult.url, {
      maxBytes: Math.min(Math.max(notes.sizeBytes, 1), MAX_NOTES_BYTES),
      overallMs: transport.manifestTimeoutMs,
      relativePath: notes.path,
    })
    if (!fetched.ok) return Object.freeze({ text: null, reason: describeError(fetched.code, fetched.reason) })
    if (fetched.body.length !== notes.sizeBytes) {
      return Object.freeze({ text: null, reason: `发布说明大小与清单不符（清单 ${notes.sizeBytes}，实际 ${fetched.body.length}）` })
    }
    const digest = createHash('sha256').update(fetched.body).digest('hex')
    if (digest !== notes.sha256) {
      return Object.freeze({ text: null, reason: '发布说明内容摘要与清单不符' })
    }
    const text = decodePlainText(fetched.body)
    if (text === null) return Object.freeze({ text: null, reason: '发布说明不是纯文本，已忽略' })
    return Object.freeze({ text, reason: null })
  }

  function check({ trigger = 'manual', signal = null } = {}) {    if (inFlightCheck !== null) {
      return inFlightCheck.then((result) => Object.freeze({ ...result, shared: true }))
    }
    setState('check-started', {})
    lastError = null
    publish()
    const current = (async () => {
      let result
      try {
        result = await performCheck(trigger, signal)
      } catch (error) {
        result = Object.freeze({
          outcome: 'failed', code: error?.code ?? UPDATE_CODES_CLIENT.CHECK_FAILED,
          reason: `检查更新时出错：${error?.message ?? error}`,
        })
      }
      if (result.outcome === 'failed') {
        lastError = Object.freeze({ code: result.code ?? null, reason: result.reason ?? null, atMs: now(), trigger })
        // 状态机负责"能不能改"这条判据（受保护状态上不变）。
        setState('check-failed', { reason: result.reason })
      }
      inFlightCheck = null
      return result
    })()
    inFlightCheck = current
    return current
  }

  // -------------------------------------------------------------------------
  // 下载
  // -------------------------------------------------------------------------

  /**
   * 下载候选的完整包。
   *
   * @param {string} releaseId
   * @param {string} manifestDigest  身份的一部分：摘要变了就不是同一个候选。
   */
  async function download(releaseId, manifestDigest, { onProgress = null, signal = null } = {}) {
    const wanted = Object.freeze({
      releaseId, productVersion: candidate?.productVersion ?? null, channel: config?.channel ?? null,
      platform: config?.host?.platform ?? platform, arch: config?.host?.arch ?? arch,
      manifestSha256: manifestDigest ?? null,
    })
    if (candidate === null || release === null) {
      return fail('download', UPDATE_CODES_CLIENT.NO_CANDIDATE, '还没有可用候选，请先检查更新')
    }
    if (!sameIdentity(wanted, identityOf(candidate))) {
      return fail('download', UPDATE_CODES_CLIENT.IDENTITY_MISMATCH,
        `请求的候选 ${identityText(wanted)} 与当前候选 ${identityText(candidate)} 不一致；请重新检查更新`)
    }
    if (state === 'downloading' || state === 'verifying') {
      return fail('download', UPDATE_CODES_CLIENT.BUSY, '已经有一个下载在进行中')
    }
    const pkg = release.package
    const planned = cache.plan(release.releaseId, pkg.path)
    if (!planned.ok) return fail('download', planned.code, planned.reason)

    // 复用已就绪且**重新校验过**的缓存（设计 §6 line 140）。
    const reused = await cache.verifyReady(release.releaseId, pkg.path, { sizeBytes: pkg.sizeBytes, sha256: pkg.sha256 })
    if (reused.ok) {
      readyIdentity = identityOf(candidate)
      progress = null
      setState('download-started', {}) // 允许从 available 进入 downloading
      setState('download-complete', {})
      setState('download-verified', {})
      publish()
      return Object.freeze({
        ok: true, code: null, reason: null, reused: true,
        identity: readyIdentity, path: reused.path, bytes: reused.size,
      })
    }

    const urlResult = artifactUrl(config.host, pkg.path)
    if (!urlResult.ok) return fail('download', urlResult.code, urlResult.reason)

    setState('download-started', {})
    const operationId = ++downloadOperationId
    const controller = new AbortController()
    const externalAbort = () => controller.abort()
    if (signal !== null) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', externalAbort, { once: true })
    }
    activeDownload = { operationId, releaseId: release.releaseId, abort: controller }
    downloadAbort = controller
    const targetIdentity = identityOf(candidate)
    progress = Object.freeze({ releaseId: release.releaseId, bytes: 0, total: pkg.sizeBytes, phase: 'downloading' })
    publish()

    try {
      const result = await transport.downloadToFile(config.host, urlResult.url, {
        targetPath: planned.readyPath,
        expectedSize: pkg.sizeBytes,
        expectedSha256: pkg.sha256,
        signal: controller.signal,
        onProgress: (bytes) => {
          progress = Object.freeze({ releaseId: release.releaseId, bytes, total: pkg.sizeBytes, phase: 'downloading' })
          if (typeof onProgress === 'function') onProgress(progress)
          publish()
        },
      })
      if (!result.ok) {
        if (result.code === 'net-cancelled') {
          discardDownload(planned.partPath)
          progress = null
          setState('download-cancelled', {})
          return fail('download', UPDATE_CODES_CLIENT.CANCELLED, '下载已取消')
        }
        discardDownload(planned.partPath)
        progress = null
        setState('download-failed', { reason: result.reason })
        lastError = Object.freeze({ code: result.code, reason: result.reason, atMs: now(), trigger: 'download' })
        publish()
        return fail('download', result.code, result.reason)
      }

      // 字节完整 → 进入 verifying。签名/摘要的"最终确认"在这一段：
      // 包摘要已经被 downloadToFile 核过，这里再核对**候选身份没变**
      // （设计 §6 line 138 的绑定）。
      setState('download-complete', {})
      progress = Object.freeze({ releaseId: release.releaseId, bytes: result.bytes, total: pkg.sizeBytes, phase: 'verifying' })
      publish()
      if (!sameIdentity(identityOf(candidate), targetIdentity)) {
        discardDownload(result.partPath)
        progress = null
        setState('download-failed', { reason: '候选在下载期间发生了变化' })
        return fail('download', UPDATE_CODES_CLIENT.IDENTITY_MISMATCH,
          '下载期间发布端变更了候选：为避免"悄悄安装了另一个版本"，本次下载被丢弃，请重新确认')
      }
      const committed = commitDownload(result.partPath, planned.readyPath)
      if (!committed.ok) {
        discardDownload(result.partPath)
        progress = null
        setState('download-failed', { reason: committed.reason })
        return fail('download', committed.code, committed.reason)
      }
      readyIdentity = targetIdentity
      progress = null
      setState('download-verified', {})
      return Object.freeze({
        ok: true, code: null, reason: null, reused: false,
        identity: readyIdentity, path: committed.path, bytes: result.bytes,
      })
    } finally {
      if (signal !== null) signal.removeEventListener('abort', externalAbort)
      if (downloadAbort === controller) downloadAbort = null
      if (activeDownload?.operationId === operationId) activeDownload = null
      publish()
    }
  }

  /** 取消当前下载。`operationId` 不匹配时**拒绝**（设计 §7 的有界输入）。 */
  function cancelDownload(operationId = null) {
    if (activeDownload === null) {
      return Object.freeze({ ok: false, code: UPDATE_CODES_CLIENT.NO_DOWNLOAD, reason: '当前没有进行中的下载' })
    }
    if (operationId !== null && operationId !== activeDownload.operationId) {
      return Object.freeze({
        ok: false, code: UPDATE_CODES_CLIENT.STALE_OPERATION,
        reason: `下载操作 ${operationId} 不是当前操作 ${activeDownload.operationId}`,
      })
    }
    activeDownload.abort.abort()
    return Object.freeze({ ok: true, code: null, reason: null, operationId: activeDownload.operationId })
  }

  /**
   * 安装：交给 Stage C 的安装事务。
   *
   * 输入是身份（设计 §7 line 159：「releaseId + manifestDigest，匹配已就绪包
   * 与用户确认」），并且必须先有 `readyIdentity`——也就是**用户已经确认过
   * 下载完之后**才可能发生的动作。
   */
  async function install(releaseId, manifestDigest, { onProgress = null, signal = null, pendingTasks = null } = {}) {
    const wanted = Object.freeze({
      releaseId, productVersion: candidate?.productVersion ?? null, channel: config?.channel ?? null,
      platform: config?.host?.platform ?? platform, arch: config?.host?.arch ?? arch,
      manifestSha256: manifestDigest ?? null,
    })
    if (readyIdentity === null) {
      return fail('install', UPDATE_CODES_CLIENT.NOT_READY, '还没有已就绪的更新包')
    }
    if (!sameIdentity(wanted, readyIdentity)) {
      return fail('install', UPDATE_CODES_CLIENT.IDENTITY_MISMATCH,
        `请求安装的候选 ${identityText(wanted)} 与已就绪的 ${identityText(readyIdentity)} 不一致`)
    }
    if (state === 'installing' || state === 'validating' || state === 'preparing' || state === 'waiting-for-tasks') {
      return fail('install', UPDATE_CODES_CLIENT.BUSY, '已经有一个安装事务在进行中')
    }
    if (installer === null || typeof installer.install !== 'function') {
      return fail('install', UPDATE_CODES_CLIENT.NOT_WIRED, '安装事务尚未接线（本阶段只完成检查与下载）')
    }
    setState('install-requested', {})
    const packagePath = cache.readyPath(release.releaseId, release.package.path)
    const started = await installer.install({
      identity: readyIdentity,
      release,
      packagePath,
      pendingTasks,
      signal,
      onProgress: (update) => {
        progress = update === null ? null : Object.freeze({ ...update })
        if (typeof onProgress === 'function') onProgress(progress)
        publish()
      },
      onStage: (stage) => {
        // 事务阶段 → 状态机事件。表里没有的阶段就是"保持原状态"。
        const mapping = {
          'waiting-for-tasks': 'tasks-wait-started',
          'tasks-timeout': 'tasks-wait-failed',
          preparing: 'prepare-started',
          'prepare-failed': 'prepare-failed',
          installing: 'install-started',
          validating: 'validate-started',
          committed: 'commit',
          'rolled-back': 'rollback',
          'recovery-required': 'recovery-required',
        }
        const event = mapping[stage]
        if (event !== undefined) setState(event, { reason: stage })
      },
    })
    if (started?.ok === true) return Object.freeze({ ...started, identity: readyIdentity })
    return fail('install', started?.code ?? UPDATE_CODES_CLIENT.INSTALL_FAILED,
      started?.reason ?? '安装失败', { detail: started })
  }

  function fail(operation, code, reason, extra = {}) {
    lastError = Object.freeze({ code, reason, atMs: now(), trigger: operation })
    publish()
    return Object.freeze({ ok: false, code, reason, operation, ...extra })
  }

  // -------------------------------------------------------------------------
  // 提醒（设计 §7 line 146 的"同一发行默认 24 小时内不重复主动提醒"）
  // -------------------------------------------------------------------------

  /** 用户点"稍后"。只收起提醒，不影响主状态（设计 §7 line 146）。 */
  function snooze({ durationMs = 24 * 60 * 60 * 1000 } = {}) {
    snoozedUntilMs = now() + durationMs
    setState('snooze', {})
    publish()
    return Object.freeze({ ok: true, snoozedUntilMs, releaseId: candidate?.releaseId ?? null })
  }

  /** 现在应不应该**主动**提醒（托盘气泡/系统通知）。 */
  function shouldNotify() {
    if (candidate === null) return false
    if (snoozedUntilMs !== null && now() < snoozedUntilMs) return false
    return state === 'available'
  }

  // -------------------------------------------------------------------------
  // 调度接线
  // -------------------------------------------------------------------------

  const scheduler = createCheckScheduler({
    runCheck: (trigger, signal) => check({ trigger, signal }),
    // ★ 配置里的 `checkOnStartup` 在这里才被**消费**。
    //   在此之前它是配置模块文档化的一个键，而全仓没有消费者：
    //   `markInteractive()` 照样安排首次检查、周期检查照样发请求。
    //   用户关掉自动检查的意图被静默忽略，而他会以为自己关掉了。
    automatic: config?.checkOnStartup !== false,
    now, random, setTimer, clearTimer, log,
    onState: () => publish(),
  })

  return Object.freeze({
    snapshot,
    state: () => state,
    candidate: () => candidate,
    release: () => release,
    ready: () => readyIdentity,
    /** 订阅状态变化。返回退订函数。 */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      try { listener(snapshot()) } catch (error) { log(`[update] 订阅者首次回调报错：${error?.message ?? error}`) }
      return () => { listeners.delete(listener) }
    },
    check,
    download,
    cancelDownload,
    install,
    snooze,
    shouldNotify,
    scheduler,
    /** 桌面可交互之后调用，首次检查从这一刻起算。 */
    markInteractive: () => scheduler.markInteractive(),
    /** 周期检查（由调度器驱动）。 */
    runScheduledCheck: () => scheduler.run('periodic'),
    notifyResume: () => scheduler.notifyResume(),
    stop: () => scheduler.stop(),
    /** 启动清理：删掉所有半截下载（设计 §6：不承诺续传）。 */
    sweepCache: () => cache.sweepStaleParts(),
    cache,
    transport,
    sequenceStore,
    /** 版本迁移用：把状态机主链暴露出来（文档/测试断言用）。 */
    chain: UPDATE_CHAIN,
  })
}

function identityOf(candidateLike) {
  return releaseIdentity(candidateLike, candidateLike?.manifestSha256 ?? null)
}

function identityText(identity) {
  if (identity === null || identity === undefined) return '(无候选)'
  const digest = typeof identity.manifestSha256 === 'string' ? identity.manifestSha256.slice(0, 12) : '?'
  return `${identity.releaseId ?? '?'}@${identity.productVersion ?? '?'}#${digest}`
}

function relativePathOf(url, host) {
  const prefix = `${host.origin}${host.prefix}/`
  return url.startsWith(prefix) ? url.slice(prefix.length) : null
}

function sha256HexOfBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
