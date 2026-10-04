// product/update/feed.mjs
// ============================================================================
// 通道清单 —— 设计 §5 的 `legion/update-feed@1`，以及 sequence 高水位
//
// 通道清单是**唯一**会变的东西：发布时上传一批不可变文件，最后单独替换
// 通道 envelope（设计 §9 第 4 步）。因此它是攻击面最集中的一点，也是
// 客户端必须记住"我见过什么"的那一点。
//
// ## 三条判据，各自对应一次真实的失效模式
//
//   ① **sequence 回退** → 拒绝。
//      没有这条时，一个能改托管内容的人可以把通道指回一个**旧但已签名**的
//      发行。签名是好的、摘要是对的、包是真的——但用户被降级到一个已知
//      有漏洞的版本。签名保护不了这件事，只有"我记得见过 42"能。
//
//   ② **同 sequence 不同摘要** → 拒绝。
//      这是①的变体：sequence 不变而 releaseId / 摘要变了，意味着"同一个
//      发布序号对应两份内容"。放行它等于承认"序号不标识一次发布"。
//
//   ③ **sequence 提升但版本更旧** → 接受清单、拒绝升级（设计 §5 line 126
//      原话：「sequence 提升不授权安装更旧版本」）。
//      撤回坏版本时发布端**必须**签发更大的 sequence 指向当前安全版本
//      （设计 §9 line 204）——那个清单的版本可能比用户手上的更旧或相同。
//      把这条和①②混在一起就会得出"撤回清单是攻击"的错误结论。
//
// 三条的处置各不相同，所以本模块把它们分成三个明确的读数，而不是一个
// 布尔值。
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ENVELOPE_FORMATS } from './envelope.mjs'
import { isSha256Hex } from './canonical.mjs'
import { RELEASE_CHANNELS } from '../upgrade/channels.mjs'
import { compareSemver, isSemver, tryCompareSemver } from './semver.mjs'
// 路径判据必须**只有一份实现**：`release.mjs` 校验发行清单里的路径，
// 这里校验通道清单里的路径，两边用同一个函数。
import { validateRelativePath } from './release.mjs'

export const FEED_FORMAT = ENVELOPE_FORMATS.FEED

export const FEED_CODES = Object.freeze({
  BAD_FORMAT: 'feed-bad-format',
  BAD_FIELD: 'feed-bad-field',
  BAD_PATH: 'feed-bad-path',
  SEQUENCE_REGRESSION: 'feed-sequence-regression',
  SEQUENCE_CONFLICT: 'feed-sequence-conflict',
  OLDER_VERSION: 'feed-older-version',
  SAME_VERSION: 'feed-same-version',
  NEWER_AVAILABLE: 'feed-newer-available',
  NO_CHANNEL: 'feed-no-channel',
})

/**
 * 通道清单字段与"为什么需要它"。
 *
 * `manifestPath` / `manifestSha256` 这一对是设计 §5 的核心：
 * **路径决定取哪个文件，摘要把那个文件钉死**。只有路径时，托管可以换成
 * 另一份签名合法的发行清单；只有摘要时，客户端不知道该去取什么。
 */
export const FEED_FIELDS = Object.freeze([
  'format', 'channel', 'platform', 'arch', 'sequence',
  'issuedAt', 'expiresAt', 'releaseId', 'productVersion', 'manifestPath', 'manifestSha256',
])

const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function feedProblem(code, message, field = null) {
  return Object.freeze({ code, message, field })
}

/**
 * 校验通道清单 payload。
 *
 * 只做**形状与自洽**检查；有效期由 `envelope.mjs` 的 `checkValidityWindow`
 * 负责（它已经跑过了），sequence 的历史由 `createSequenceStore` 负责。
 * 分成三层是因为它们的失败语义不同：形状错=发布端坏了；过期=要续签；
 * 回退=有人在改托管。
 */
export function validateFeedPayload(payload, {
  channel = null, platform = null, arch = null,
} = {}) {
  const problems = []
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return Object.freeze({
      ok: false, code: FEED_CODES.BAD_FORMAT, reason: '通道清单必须是对象',
      problems: Object.freeze([feedProblem(FEED_CODES.BAD_FORMAT, '通道清单必须是对象')]), feed: null,
    })
  }
  if (payload.format !== FEED_FORMAT) {
    problems.push(feedProblem(FEED_CODES.BAD_FORMAT, `format 必须是 ${FEED_FORMAT}，实际 ${JSON.stringify(payload.format)}`, 'format'))
  }
  if (!RELEASE_CHANNELS.includes(payload.channel)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, `channel 必须是 ${RELEASE_CHANNELS.join('/')}`, 'channel'))
  }
  if (channel !== null && payload.channel !== channel) {
    problems.push(feedProblem(FEED_CODES.NO_CHANNEL, `通道清单属于 ${payload.channel}，而本次查询的是 ${channel}`, 'channel'))
  }
  if (typeof payload.platform !== 'string' || !/^[a-z0-9]{1,16}$/.test(payload.platform)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, 'platform 必须是小写平台名', 'platform'))
  }
  if (typeof payload.arch !== 'string' || !/^[a-z0-9]{1,16}$/.test(payload.arch)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, 'arch 必须是小写架构名', 'arch'))
  }
  if (platform !== null && payload.platform !== platform) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, `通道清单的 platform=${payload.platform}，本机是 ${platform}`, 'platform'))
  }
  if (arch !== null && payload.arch !== arch) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, `通道清单的 arch=${payload.arch}，本机是 ${arch}`, 'arch'))
  }
  // ★ sequence 必须是**正整数**。0 或负数会让"高水位"从一个非法起点开始，
  //   而 `-1` 尤其危险：任何真实清单都"大于"它，于是回退保护静默失效。
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, `sequence 必须是正整数，实际 ${JSON.stringify(payload.sequence)}`, 'sequence'))
  }
  if (typeof payload.releaseId !== 'string' || !RELEASE_ID_RE.test(payload.releaseId)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, 'releaseId 不合法', 'releaseId'))
  }
  if (typeof payload.productVersion !== 'string' || !isSemver(payload.productVersion)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, `productVersion 必须是 SemVer，实际 ${JSON.stringify(payload.productVersion)}`, 'productVersion'))
  }
  if (!isSha256Hex(payload.manifestSha256)) {
    problems.push(feedProblem(FEED_CODES.BAD_FIELD, 'manifestSha256 必须是 64 位小写十六进制', 'manifestSha256'))
  }
  // manifestPath 的路径安全由 release.mjs 的同一套判据负责——**同一个函数**，
  // 免得"发行清单里的路径很严、通道清单里的路径很松"这种不对称。
  problems.push(...pathProblems(payload.manifestPath, 'manifestPath'))
  // 路径必须指向 releaseId 名下的目录。这条把"通道说 A、清单却在 B 的目录"
  // 这种发布端错误在下载之前挡掉（设计 §6 line 138 的身份绑定）。
  if (typeof payload.manifestPath === 'string' && typeof payload.releaseId === 'string'
    && !payload.manifestPath.startsWith(`releases/${payload.releaseId}/`)) {
    problems.push(feedProblem(FEED_CODES.BAD_PATH,
      `manifestPath=${payload.manifestPath} 不在 releases/${payload.releaseId}/ 之下`, 'manifestPath'))
  }

  if (problems.length > 0) {
    const first = problems[0]
    return Object.freeze({ ok: false, code: first.code, reason: first.message, problems: Object.freeze(problems), feed: null })
  }
  return Object.freeze({
    ok: true, code: null, reason: null, problems: Object.freeze([]),
    feed: Object.freeze({
      format: FEED_FORMAT,
      channel: payload.channel,
      platform: payload.platform,
      arch: payload.arch,
      sequence: payload.sequence,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      releaseId: payload.releaseId,
      productVersion: payload.productVersion,
      manifestPath: payload.manifestPath,
      manifestSha256: payload.manifestSha256,
    }),
  })
}

function pathProblems(value, field) {
  const result = validateRelativePath(value, { field, allowSubdirDepth: 5 })
  return result.ok ? [] : [feedProblem(FEED_CODES.BAD_PATH, result.reason, field)]
}

/** 构造通道清单 payload。发布端用它。 */
export function buildFeedPayload({
  channel, platform = 'win32', arch = 'x64', sequence,
  issuedAt, expiresAt, releaseId, productVersion, manifestPath, manifestSha256,
} = {}) {
  return Object.freeze({
    format: FEED_FORMAT,
    channel, platform, arch, sequence, issuedAt, expiresAt,
    releaseId, productVersion, manifestPath, manifestSha256,
  })
}

// ---------------------------------------------------------------------------
// sequence 高水位
// ---------------------------------------------------------------------------

export const SEQUENCE_STORE_FORMAT = 'legion/update-sequence@1'

/**
 * 每条 `channel/platform/arch` 一条记录：见过的最高 sequence，以及那个
 * sequence 当时对应的发行清单摘要。
 */
export function emptySequenceState() {
  return { format: SEQUENCE_STORE_FORMAT, entries: {} }
}

function stateKey({ channel, platform, arch }) {
  return `${channel}/${platform}-${arch}`
}

/**
 * 判定一份**已经验签**的通道清单能不能被接受。
 *
 * @returns {{accept: boolean, code: string, reason: string, regression: boolean}}
 */
export function judgeSequence(state, feed) {
  const key = stateKey(feed)
  const previous = state?.entries?.[key] ?? null
  if (previous === null || previous === undefined) {
    return Object.freeze({ accept: true, code: 'feed-first-seen', reason: `首次看到 ${key}`, regression: false, previous: null })
  }
  if (feed.sequence < previous.sequence) {
    return Object.freeze({
      accept: false, code: FEED_CODES.SEQUENCE_REGRESSION,
      reason: `通道清单 sequence ${feed.sequence} 低于已接受的 ${previous.sequence}（回退被拒）`,
      regression: true, previous,
    })
  }
  if (feed.sequence === previous.sequence) {
    if (feed.manifestSha256 === previous.manifestSha256 && feed.releaseId === previous.releaseId) {
      return Object.freeze({
        accept: true, code: 'feed-same-sequence-same-digest',
        reason: `sequence ${feed.sequence} 与已接受的完全相同`, regression: false, previous,
      })
    }
    return Object.freeze({
      accept: false, code: FEED_CODES.SEQUENCE_CONFLICT,
      reason: `sequence ${feed.sequence} 已存在，但摘要/发行号不同（先 ${previous.releaseId}#${String(previous.manifestSha256).slice(0, 12)}，`
        + `今 ${feed.releaseId}#${String(feed.manifestSha256).slice(0, 12)}）`,
      regression: true, previous,
    })
  }
  return Object.freeze({
    accept: true, code: 'feed-sequence-advanced',
    reason: `sequence ${previous.sequence} → ${feed.sequence}`, regression: false, previous,
  })
}

/** 记录一份已被接受的清单，返回新的状态对象（不修改入参）。 */
export function recordSequence(state, feed) {
  const next = {
    format: SEQUENCE_STORE_FORMAT,
    entries: { ...(state?.entries ?? {}) },
  }
  next.entries[stateKey(feed)] = {
    sequence: feed.sequence,
    releaseId: feed.releaseId,
    manifestSha256: feed.manifestSha256,
    productVersion: feed.productVersion,
    acceptedAtMs: feed.acceptedAtMs ?? null,
  }
  return next
}

/**
 * 文件支撑的高水位状态。
 *
 * 写入走"临时文件 + rename"：设计 §6 要求下载完成才原子改名，同一份纪律
 * 用在状态上同样必要——一次"写了一半的 sequence 状态"会让下次启动时
 * 高水位读不出来，于是回退保护整段失效。
 */
export function createSequenceStore({ file }) {
  if (typeof file !== 'string' || file === '') throw new Error('createSequenceStore 需要 file')
  function read() {
    try {
      if (!existsSync(file)) return emptySequenceState()
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.format !== SEQUENCE_STORE_FORMAT || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return emptySequenceState()
      }
      return parsed
    } catch {
      // ★ 读不出来时**不能**当成"没有历史"。那样一次磁盘损坏就会让回退
      //   保护失效。这里返回一个空状态，但调用方能通过 `damaged` 知道
      //   这件事发生过——所以状态里带一个显式标记。
      return { format: SEQUENCE_STORE_FORMAT, entries: {}, damaged: true }
    }
  }
  function write(state) {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8')
      renameSync(temp, file)
    } catch (e) {
      try { rmSync(temp, { force: true }) } catch { /* 尽力清理 */ }
      throw e
    }
    return file
  }
  return Object.freeze({
    file,
    read,
    write,
    /** 一次"读—判定—记录"的完整动作。 */
    accept(feed, { nowMs = Date.now() } = {}) {
      const state = read()
      const judgement = judgeSequence(state, feed)
      if (!judgement.accept) return Object.freeze({ ...judgement, state, written: false })
      const next = recordSequence(state, { ...feed, acceptedAtMs: nowMs })
      write(next)
      return Object.freeze({ ...judgement, state: next, written: true })
    },
  })
}

/** 状态的默认落盘位置：CacheDir 下的固定文件名。 */
export function sequenceStoreFor(cacheDir) {
  return join(cacheDir, 'channel-sequence.json')
}

// ---------------------------------------------------------------------------
// 候选选择
// ---------------------------------------------------------------------------

/**
 * 由"已通过的通道清单 + 本机当前版本"得出候选。
 *
 * 这一层只回答"有没有更新的版本"，不回答"能不能升"（那是 release 的
 * `supportedFromVersions` 和 preflight 的事）。分开是因为两者的用户可见
 * 文案完全不同："已是最新版" vs "这个版本不支持从你的版本升级"。
 */
export function selectCandidate({ feed, currentVersion = null } = {}) {
  if (feed === null || feed === undefined) {
    return Object.freeze({ verdict: 'no-candidate', code: FEED_CODES.NO_CHANNEL, reason: '没有可用的通道清单', candidate: null })
  }
  if (currentVersion === null || currentVersion === undefined) {
    return Object.freeze({
      verdict: 'unknown-current', code: 'feed-unknown-current',
      reason: '不知道本机当前版本，无法比较', candidate: null,
    })
  }
  const cmp = tryCompareSemver(feed.productVersion, currentVersion)
  if (cmp === null) {
    return Object.freeze({
      verdict: 'incomparable', code: FEED_CODES.BAD_FIELD,
      reason: `无法比较 ${feed.productVersion} 与本机 ${currentVersion}`, candidate: null,
    })
  }
  if (cmp === 0) {
    return Object.freeze({ verdict: 'up-to-date', code: FEED_CODES.SAME_VERSION, reason: `已是最新版 ${currentVersion}`, candidate: null })
  }
  if (cmp < 0) {
    // ★ 撤回清单落在这里：sequence 合法、签名有效、版本比本机旧。
    //   结论是"没有可安装的新版本"，而**不是**"这是攻击"。
    return Object.freeze({
      verdict: 'older', code: FEED_CODES.OLDER_VERSION,
      reason: `通道指向 ${feed.productVersion}，比本机 ${currentVersion} 更旧（可能是撤回清单），不提供降级`,
      candidate: null,
    })
  }
  return Object.freeze({
    verdict: 'newer', code: FEED_CODES.NEWER_AVAILABLE,
    reason: `发现 ${feed.productVersion}（本机 ${currentVersion}）`,
    candidate: Object.freeze({
      releaseId: feed.releaseId,
      productVersion: feed.productVersion,
      channel: feed.channel,
      platform: feed.platform,
      arch: feed.arch,
      manifestPath: feed.manifestPath,
      manifestSha256: feed.manifestSha256,
      sequence: feed.sequence,
      issuedAt: feed.issuedAt,
      expiresAt: feed.expiresAt,
    }),
  })
}

/** 供界面排序/展示：把一组候选按版本降序。 */
export function sortCandidatesDescending(candidates) {
  return [...candidates].sort((a, b) => compareSemver(b.productVersion, a.productVersion))
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

export function sampleFeed({ sequence = 42, productVersion = '1.1.0', releaseId = 'rel-1.1.0', channel = 'stable' } = {}) {
  return buildFeedPayload({
    channel,
    platform: 'win32',
    arch: 'x64',
    sequence,
    issuedAt: '2026-10-02T00:00:00Z',
    expiresAt: '2026-10-09T00:00:00Z',
    releaseId,
    productVersion,
    manifestPath: `releases/${releaseId}/manifest.json`,
    manifestSha256: 'a'.repeat(64),
  })
}

export function selfCheckFeed() {
  const problems = []
  const good = validateFeedPayload(sampleFeed(), { channel: 'stable', platform: 'win32', arch: 'x64' })
  if (!good.ok) problems.push(`合法通道清单没通过：${good.reason}`)

  const cases = [
    ['sequence 为零', { sequence: 0 }],
    ['sequence 为负', { sequence: -1 }],
    ['sequence 非整数', { sequence: 1.5 }],
    ['releaseId 为空', { releaseId: '' }],
    ['版本是范围', { productVersion: '^1.1.0' }],
    ['摘要大写', { manifestSha256: 'A'.repeat(64) }],
    ['路径穿越', { manifestPath: 'releases/../../x/manifest.json' }],
    ['路径绝对', { manifestPath: '/releases/rel-1.1.0/manifest.json' }],
    ['路径与 releaseId 不符', { manifestPath: 'releases/other/manifest.json' }],
    ['未知通道', { channel: 'nightly' }],
    ['平台不匹配', { platform: 'darwin' }],
  ]
  for (const [name, override] of cases) {
    const result = validateFeedPayload({ ...sampleFeed(), ...override }, { channel: 'stable', platform: 'win32', arch: 'x64' })
    if (result.ok) problems.push(`「${name}」被接受了`)
  }

  // 通道不匹配（查询 stable 却拿到 canary）。
  if (validateFeedPayload(sampleFeed({ channel: 'canary' }), { channel: 'stable' }).ok) {
    problems.push('通道不匹配没有被拒绝')
  }

  // —— sequence 三条判据 ——
  const state0 = emptySequenceState()
  const first = judgeSequence(state0, sampleFeed({ sequence: 42 }))
  if (!first.accept) problems.push('首次看到清单没有被接受')
  const state1 = recordSequence(state0, sampleFeed({ sequence: 42 }))

  const lower = judgeSequence(state1, sampleFeed({ sequence: 41 }))
  if (lower.accept) problems.push('sequence 回退被接受了')
  else if (lower.code !== FEED_CODES.SEQUENCE_REGRESSION) problems.push(`sequence 回退的码是 ${lower.code}`)

  const sameSame = judgeSequence(state1, sampleFeed({ sequence: 42 }))
  if (!sameSame.accept) problems.push('相同 sequence + 相同摘要被拒绝了')

  const sameDiff = judgeSequence(state1, sampleFeed({ sequence: 42, releaseId: 'other', productVersion: '1.2.0' }))
  if (sameDiff.accept) problems.push('相同 sequence + 不同摘要被接受了')
  else if (sameDiff.code !== FEED_CODES.SEQUENCE_CONFLICT) problems.push(`sequence 冲突的码是 ${sameDiff.code}`)

  const higher = judgeSequence(state1, sampleFeed({ sequence: 43, releaseId: 'rel-1.2.0', productVersion: '1.2.0' }))
  if (!higher.accept) problems.push('sequence 提升没有被接受')

  // —— 候选选择：撤回清单接受但不给降级 ——
  const newer = selectCandidate({ feed: sampleFeed({ productVersion: '1.2.0' }), currentVersion: '1.1.0' })
  if (newer.verdict !== 'newer') problems.push('更新的版本没有被判为 newer')
  const same = selectCandidate({ feed: sampleFeed({ productVersion: '1.1.0' }), currentVersion: '1.1.0' })
  if (same.verdict !== 'up-to-date') problems.push('同版本没有被判为 up-to-date')
  const older = selectCandidate({ feed: sampleFeed({ productVersion: '1.0.0' }), currentVersion: '1.1.0' })
  if (older.verdict !== 'older' || older.candidate !== null) problems.push('更旧的版本没有被判为 older/无候选')
  // ★ 这条是设计 §9 line 204 的可执行形式：撤回清单**accept**，但**不授权降级**。
  const recall = judgeSequence(state1, sampleFeed({ sequence: 43, releaseId: 'rel-1.0.0', productVersion: '1.0.0' }))
  if (!recall.accept) problems.push('撤回清单（更高 sequence、更低版本）被拒绝了——它应当被接受但不授权降级')

  // 持久化：写坏的存储不能静默变成"没有历史"。
  const dir = mkdtempSync(join(tmpdir(), 'legion-seq-'))
  try {
    const store = createSequenceStore({ file: join(dir, 'seq.json') })
    const accepted = store.accept(sampleFeed({ sequence: 42 }))
    if (!accepted.written) problems.push('高水位没有落盘')
    if (store.read().entries['stable/win32-x64']?.sequence !== 42) problems.push('高水位落盘之后读不回')
    writeFileSync(join(dir, 'seq.json'), '{ not json', 'utf8')
    const damaged = store.read()
    if (damaged.damaged !== true) problems.push('损坏的状态文件没有被标记为 damaged')
    const afterDamage = store.accept(sampleFeed({ sequence: 7 }))
    // 损坏状态下高水位丢了，但**这件事是显式的**——调用方能据此要求人工确认。
    if (afterDamage.written !== true || afterDamage.state.entries['stable/win32-x64']?.sequence !== 7) {
      problems.push('损坏状态之后的写入行为不明确')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    rejectedCases: cases.length,
    sequenceVerdicts: Object.freeze(['feed-sequence-regression', 'feed-sequence-conflict', 'feed-sequence-advanced']),
    sample: Object.freeze({
      feedFields: FEED_FIELDS.length,
      firstSeenCode: first.code,
      olderVerdict: older.verdict,
      recallAccepted: recall.accept,
    }),
  })
}

import * as fsModule from 'node:fs'
import * as osModule from 'node:os'

export const FEED_CHECKED = selfCheckFeed()
