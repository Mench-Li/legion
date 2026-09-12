// product/upgrade/channels.mjs
// ============================================================================
// PRT-810：internal / canary / stable 三类发布通道
//
// spec §9.2 line 695–701：
//
//   internal → canary → stable
//   · internal：开发和内部真实项目验证。
//   · canary：少量明确接受灰度的用户。
//   · stable：通过兼容性、迁移、恢复和黄金流程验证的版本。
//
// spec §9.4 line 737：「商业 Alpha 支持从当前 stable 的 N-1 版本升级到 N」。
//
// ## 一、通道不是"一个字符串字段"
//
// 把 `channel` 当成清单上的一个标签，会得到下面这个实现：客户端读
// `manifest.channel`，和用户选的通道比一下；相等就升。
//
// 它漏掉的恰恰是 canary 的全部含义。"少量**明确接受**灰度的用户"这句话
// 里有两个词：少量（份额）与明确接受（选择加入）。一个按 `channel === 'canary'`
// 分发的实现，会把 canary 版本发给**所有**把通道设成 canary 的人，
// 包括那些只是随手点了一下的人；而它同时会把内部版本发给任何
// 把通道写成 internal 的清单——因为没有任何地方记录"这个用户属于哪个环"。
//
//   > 一个按"清单上的通道字段"分发的实现，
//   > 与一个"谁都能把通道改成 canary 从而拿到灰度版本"的实现，是同一个东西。
//
// 所以本模块区分**两个不同的东西**：
//   · `channel`：这份版本发布到了哪一级（由发布方写入清单）；
//   · `ring`：这台机器处在哪一环、是否显式加入灰度（由用户/部署写入本地状态）。
// 两者合成"这一版能不能给这台机器"的判定，而**判定不读清单里用户改得到的字段**。
//
// ## 二、晋级是一条单向的、带停留期的路
//
// `internal → canary → stable` 是一条**有方向**的边。允许 `internal → stable`
// 的跳级，等于让"内部验证"与"金丝雀验证"这两道网一起失效，而报表上仍然
// 写着这个版本通过了通道晋级。
//
// `soakDays` 同理：晋级要求"在上一级停留过足够久"。一个不要求停留期的晋级
// 与一个"按下按钮就升到 stable"的流程，是同一个东西。
// ============================================================================

import { createHash } from 'node:crypto'

// 版本比较复用清单模块的那一份：两处各写一个 `compareVersions` 的实现，
// 会在某一天对"0.10.0 与 0.9.0 谁大"给出两个答案（字符串比较会给出反的）。
import { compareVersions } from './manifest.mjs'

/** 通道本体，顺序即 spec §9.2 的图示顺序（也是晋级方向）。 */
export const RELEASE_CHANNELS = Object.freeze(['internal', 'canary', 'stable'])

/** 通道的中文名（界面与通知共用同一份，避免两处漂移）。 */
export const CHANNEL_LABELS = Object.freeze({
  internal: '内部',
  canary: '金丝雀',
  stable: '稳定',
})

/** 环：一台机器处在验证链的哪一节。与 `channel` 不是同一个概念（见文件头）。 */
export const RINGS = Object.freeze(['internal', 'canary', 'stable'])

/** 提供某版本时，它必须处在用户环可接受的发布级别里。 */
export const RING_ACCEPTS = Object.freeze({
  internal: Object.freeze(['internal', 'canary', 'stable']),
  canary: Object.freeze(['canary', 'stable']),
  stable: Object.freeze(['stable']),
})

/** 晋级的默认停留期（天）：在上一级待够这么久才允许升到下一级。 */
export const DEFAULT_SOAK_DAYS = Object.freeze({ 'internal->canary': 3, 'canary->stable': 7 })

export const CHANNEL_CODES = Object.freeze({
  OFFERED: 'channel-offered',
  /** 环不认识。 */
  RING_UNKNOWN: 'channel-ring-unknown',
  /** 版本发布到了比用户环更高的级别（内部版给 stable 环）。 */
  NOT_PUBLISHED_FOR_RING: 'channel-not-published-for-ring',
  /** 版本还没有发布到任何通道。 */
  NOT_PUBLISHED: 'channel-not-published',
  /** 用户没有显式选择加入金丝雀。 */
  CANARY_NOT_OPTED_IN: 'channel-canary-not-opted-in',
  /** 显式加入了，但没有落在这一批百分比里。 */
  CANARY_OUT_OF_BUCKET: 'channel-canary-out-of-bucket',
  /** 跳级晋级。 */
  PROMOTION_SKIP: 'channel-promotion-skip',
  /** 晋级方向反了。 */
  PROMOTION_BACKWARD: 'channel-promotion-backward',
  /** 晋级原地不动（来源与目标同级）——通常是配置写错了，不是方向写反了。 */
  PROMOTION_SAME: 'channel-promotion-same',
  /** 停留期不够。 */
  SOAK_INSUFFICIENT: 'channel-soak-insufficient',
  /**
   * 查不到"进入上一级的时刻"，因此停留期算不出来。
   *
   * 与 `SOAK_INSUFFICIENT` 分开：前者要去翻部署记录，后者只要等。
   * 合成一档时，"算不出来"会被当成"差几天"，于是没人去查那份缺失的记录。
   */
  SOAK_UNOBSERVED: 'channel-soak-unobserved',
  /** 候选版本不比当前版本新（没有重复提供同一个版本）。 */
  NOT_NEWER: 'channel-not-newer',
})

function channelError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// 单台机器的可见性
// ---------------------------------------------------------------------------

/**
 * 稳定分桶：`(ringSeed, version)` → `[0, 100)` 的一个整数。
 *
 * 用哈希而不是 `Math.random()`：灰度比例要能被**复现**，否则"这次测试
 * 拿到 5% 的用户"与"每次请求重新抽签"是同一个东西——后者会让同一个用户
 * 刷新一次就换一个版本，而灰度数据因此不可解释。
 */
export function canaryBucket({ ringSeed, version }) {
  const h = createHash('sha256').update(`${ringSeed}\u0000${version}`, 'utf8').digest()
  // 取前 4 字节按无符号处理，再对 100 取模。
  return h.readUInt32BE(0) % 100
}

/**
 * 这一版能不能提供给这台机器。
 *
 * @param {object} args
 * @param {object} args.release  `{ version, channel, publishedAtMs }`——**发布方**写的
 * @param {string} args.ring     `'internal' | 'canary' | 'stable'`
 * @param {boolean} [args.canaryOptIn] 用户是否**显式**接受灰度
 * @param {number} [args.canaryPercent] 灰度批次的比例（0–100）
 * @param {string} [args.ringSeed] 分桶种子（装置标识，不是用户 ID）
 */
export function isOffered({ release, ring, canaryOptIn = false, canaryPercent = 0, ringSeed = null } = {}) {
  if (!RINGS.includes(ring)) {
    return Object.freeze({
      offered: false, code: CHANNEL_CODES.RING_UNKNOWN,
      reason: `环 ${JSON.stringify(ring)} 不认识：认不出的环按**不给**处理（认不出时放行等于把灰度发给所有人）`,
    })
  }
  const channel = release?.channel
  if (channel === undefined || channel === null) {
    return Object.freeze({
      offered: false, code: CHANNEL_CODES.NOT_PUBLISHED,
      reason: '这份版本没有发布通道：没有发布记录的版本不出现在任何更新列表里',
    })
  }
  if (!RELEASE_CHANNELS.includes(channel)) {
    return Object.freeze({
      offered: false, code: CHANNEL_CODES.NOT_PUBLISHED,
      reason: `发布通道 ${JSON.stringify(channel)} 不在 ${RELEASE_CHANNELS.join(' / ')} 之内`,
    })
  }
  // 发布级别不在本环接受的集合里 → 不给。方向是**拒绝**。
  if (!RING_ACCEPTS[ring].includes(channel)) {
    return Object.freeze({
      offered: false, code: CHANNEL_CODES.NOT_PUBLISHED_FOR_RING,
      reason: `这个版本发布在 ${channel}，而本机在 ${ring} 环：` +
        `stable 环不接受 ${channel} 版本`,
    })
  }
  // canary 版本要过两道门：显式加入 + 落在这一批比例里。
  if (channel === 'canary' && ring !== 'internal') {
    if (canaryOptIn !== true) {
      return Object.freeze({
        offered: false, code: CHANNEL_CODES.CANARY_NOT_OPTED_IN,
        reason: '这是金丝雀版本，而这台机器没有**显式**选择加入灰度：' +
          '"把通道设成 canary"不等于"同意接收灰度版本"',
      })
    }
    const percent = Number.isFinite(canaryPercent) ? canaryPercent : 0
    if (percent <= 0) {
      return Object.freeze({
        offered: false, code: CHANNEL_CODES.CANARY_OUT_OF_BUCKET,
        reason: '金丝雀批次比例是 0：这一批没有放开',
      })
    }
    if (percent < 100) {
      const seed = typeof ringSeed === 'string' && ringSeed !== '' ? ringSeed : null
      if (seed === null) {
        // 没有种子时**不抽签**：抽不出来的分桶与"全部命中"是同一个东西。
        return Object.freeze({
          offered: false, code: CHANNEL_CODES.CANARY_OUT_OF_BUCKET,
          reason: '没有分桶种子，无法把这一批比例落成一个可复现的集合',
        })
      }
      const bucket = canaryBucket({ ringSeed: seed, version: release.version ?? '' })
      if (bucket >= percent) {
        return Object.freeze({
          offered: false, code: CHANNEL_CODES.CANARY_OUT_OF_BUCKET, bucket,
          reason: `分桶 ${bucket} 不在这一批的前 ${percent}% 之内`,
        })
      }
      return Object.freeze({
        offered: true, code: CHANNEL_CODES.OFFERED, bucket,
        reason: `已显式加入灰度且分桶 ${bucket} 落在前 ${percent}% 内`,
      })
    }
  }
  return Object.freeze({
    offered: true, code: CHANNEL_CODES.OFFERED,
    reason: `${ring} 环接受 ${channel} 版本`,
  })
}

/**
 * 在候选版本里选出这台机器能看到的那些，按版本**降序**（最高的排最前）。
 *
 * `rejected` 一并返回：只说"没有更新"的实现，与一个"用户明明在 canary 环
 * 却没有被放进这一批"的实现，在用户看得到的界面上是同一个东西。
 *
 * `selected` 是这条路尽头的那一个版本。把它单独给出来，是因为调用方几乎
 * 总是只想要它——而让每个调用方自己 `offered[0]` 的实现，会在有人改了
 * 排序的那一天集体静默地装错版本。
 */
export function selectOffered(candidates, { currentVersion = null, ...options } = {}) {
  const offered = []
  const rejected = []
  for (const release of candidates ?? []) {
    if (currentVersion !== null && compareVersions(release?.version, currentVersion) <= 0) {
      rejected.push(Object.freeze({
        release,
        verdict: Object.freeze({
          offered: false, code: CHANNEL_CODES.NOT_NEWER,
          reason: `${release?.version} 不比当前版本 ${currentVersion} 新：不重复提供同一个或更旧的版本`,
        }),
      }))
      continue
    }
    const verdict = isOffered({ ...options, release })
    if (verdict.offered) offered.push(Object.freeze({ release, verdict }))
    else rejected.push(Object.freeze({ release, verdict }))
  }
  // 降序：`parseVersion` 逐段比较，不用字符串比较（"0.10.0" < "0.9.0"）。
  offered.sort((a, b) => compareVersions(b.release?.version, a.release?.version))
  return Object.freeze({
    offered: Object.freeze(offered),
    rejected: Object.freeze(rejected),
    selected: offered.length === 0 ? null : offered[0].release,
    reason: offered.length === 0
      ? (rejected.length === 0 ? '没有候选版本' : `${rejected.length} 个候选都不适用于本机：${rejected[0].verdict.reason}`)
      : `${offered.length} 个候选适用于本机，最高的是 ${offered[0].release?.version}`,
  })
}

// ---------------------------------------------------------------------------
// 晋级
// ---------------------------------------------------------------------------

/** 相邻的下一级；`stable` 没有下一级。 */
export function nextChannel(channel) {
  const i = RELEASE_CHANNELS.indexOf(channel)
  if (i < 0 || i === RELEASE_CHANNELS.length - 1) return null
  return RELEASE_CHANNELS[i + 1]
}

/**
 * 一次晋级是否合法。
 *
 * 三条判据：方向（只能向前）、相邻（不能跳级）、停留期（待够 `soakDays`）。
 *
 * `soakDays` 的默认值来自 `DEFAULT_SOAK_DAYS`，可注入——因为它必须能被
 * 一份**故意做短**的策略驱动到"拦住了"的那一侧，否则它就是一条恒真的检查。
 */
export function planPromotion({
  from, to, enteredAtMs, promotedAtMs, soakDays = DEFAULT_SOAK_DAYS,
} = {}) {
  const problems = []
  if (!RELEASE_CHANNELS.includes(from)) {
    return Object.freeze({
      allowed: false, code: CHANNEL_CODES.RING_UNKNOWN, soakRequiredMs: null, soakActualMs: null,
      reason: `来源通道 ${JSON.stringify(from)} 不认识`,
    })
  }
  if (!RELEASE_CHANNELS.includes(to)) {
    return Object.freeze({
      allowed: false, code: CHANNEL_CODES.RING_UNKNOWN, soakRequiredMs: null, soakActualMs: null,
      reason: `目标通道 ${JSON.stringify(to)} 不认识`,
    })
  }
  const fromIndex = RELEASE_CHANNELS.indexOf(from)
  const toIndex = RELEASE_CHANNELS.indexOf(to)
  if (toIndex === fromIndex) {
    // "原地不动"与"方向反了"是两种不同的配置错误：前者多半是有人少改了一个字段，
    // 后者多半是把目标写成了来源。给同一个码会让排障从错的地方开始。
    return Object.freeze({
      allowed: false, code: CHANNEL_CODES.PROMOTION_SAME,
      soakRequiredMs: null, soakActualMs: null,
      reason: `晋级来源与目标相同（${from} → ${to}）：这不是一次晋级`,
    })
  }
  if (toIndex < fromIndex) {
    problems.push(`晋级方向反了（${from} → ${to}）：通道晋级是一条单向的路`)
    return Object.freeze({
      allowed: false, code: CHANNEL_CODES.PROMOTION_BACKWARD,
      soakRequiredMs: null, soakActualMs: null,
      reason: problems.join('；'),
    })
  }
  if (toIndex - fromIndex > 1) {
    problems.push(
      `跳级晋级（${from} → ${to}）：跳过一个通道等于让那一道验证网失效，` +
      '而报表上仍然写着这个版本通过了通道晋级',
    )
  }
  const key = `${from}->${to}`
  const requiredDays = soakDays[key] ?? soakDays[`${from}->${nextChannel(from)}`] ?? 0
  const soakRequiredMs = requiredDays * 24 * 60 * 60 * 1000
  const soakActualMs = Number.isFinite(enteredAtMs) && Number.isFinite(promotedAtMs)
    ? promotedAtMs - enteredAtMs
    : null
  if (soakActualMs === null) {
    return Object.freeze({
      allowed: false, code: CHANNEL_CODES.SOAK_UNOBSERVED,
      from, to, soakRequiredMs, soakActualMs: null, soakDays: requiredDays,
      reason: '没有进入上一级的时刻，因此无法判断停留期是否满足——' +
        '"算不出停留期"不等于"待够了"（这一档要去翻部署记录，而不是等几天）',
    })
  }
  if (soakActualMs < soakRequiredMs) {
    problems.push(
      `在 ${from} 停留了 ${(soakActualMs / 86400000).toFixed(2)} 天，少于要求的 ${requiredDays} 天`,
    )
  }

  const code = problems.length === 0 ? null
    : (problems[0].includes('跳级') ? CHANNEL_CODES.PROMOTION_SKIP : CHANNEL_CODES.SOAK_INSUFFICIENT)

  return Object.freeze({
    allowed: problems.length === 0,
    code,
    from, to,
    soakRequiredMs, soakActualMs, soakDays: requiredDays,
    reason: problems.length === 0
      ? `${from} → ${to}：方向、相邻与停留期都满足`
      : problems.join('；'),
  })
}

/** 晋级失败即抛，供发布流水线使用。 */
export function assertPromotion(input) {
  const plan = planPromotion(input)
  if (!plan.allowed) {
    throw channelError(plan.code, `通道晋级不合法：${plan.reason}`)
  }
  return plan
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检：把本模块的**四条**核心判据各真的跑一遍，留下算出来的值。
 */
export function selfCheckChannels() {
  const problems = []
  const releaseCanary = Object.freeze({ version: '0.9.0', channel: 'canary' })
  const releaseInternal = Object.freeze({ version: '0.9.0', channel: 'internal' })

  // ① 没有显式加入 → 不给（"把通道设成 canary"不够）。
  const noOptIn = isOffered({ release: releaseCanary, ring: 'canary', canaryOptIn: false, canaryPercent: 100 })
  if (noOptIn.offered) problems.push('没有显式加入灰度的机器拿到了金丝雀版本')
  if (noOptIn.code !== CHANNEL_CODES.CANARY_NOT_OPTED_IN) {
    problems.push(`没有显式加入时的裁决码是 ${noOptIn.code}`)
  }

  // ② stable 环不能拿 internal 版本。
  const stableInternal = isOffered({ release: releaseInternal, ring: 'stable', canaryOptIn: true, canaryPercent: 100 })
  if (stableInternal.offered) problems.push('stable 环拿到了 internal 版本')

  // ③ 认不出的环必须拒绝。
  const unknownRing = isOffered({ release: releaseCanary, ring: 'beta', canaryOptIn: true, canaryPercent: 100 })
  if (unknownRing.offered) problems.push('认不出的环被判为可提供版本')

  // ④ 跳级与停留期都必须被拦。
  const skip = planPromotion({
    from: 'internal', to: 'stable',
    enteredAtMs: 0, promotedAtMs: 30 * 86400000,
  })
  if (skip.allowed) problems.push('internal → stable 的跳级被判为合法')
  const tooFast = planPromotion({
    from: 'canary', to: 'stable',
    enteredAtMs: 0, promotedAtMs: 1 * 86400000,
  })
  if (tooFast.allowed) problems.push('停留期不足的晋级被判为合法')
  const good = planPromotion({
    from: 'canary', to: 'stable',
    enteredAtMs: 0, promotedAtMs: 30 * 86400000,
  })
  if (!good.allowed) problems.push(`满足条件的晋级被判为不合法：${good.reason}`)

  // ⑤ 分桶是一条真门槛：0% 谁都进不去，100% 谁都进得去。
  //    只断言"100% 能进"的实现在放量率恒为 100 时也通过，所以两头都要跑。
  const fifty = Array.from({ length: 200 }, (_, i) => `selfcheck-seed-${i}`)
  const hitZero = fifty.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < 0).length
  const hitFull = fifty.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < 100).length
  if (hitZero !== 0) problems.push(`放量 0% 时仍有 ${hitZero} 台机器落在名单里`)
  if (hitFull !== fifty.length) problems.push(`放量 100% 时有 ${fifty.length - hitFull} 台机器不在名单里`)
  const half = fifty.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < 50).length
  if (half === 0 || half === fifty.length) {
    problems.push(`放量 50% 的命中数是 ${half}：分桶没有落在 (0, 200) 之间，看起来门槛是恒真或恒假`)
  }

  // ⑥ 停留期**算不出来**与**不够**是两个码（前者的处置是去查记录，后者是等）。
  const unobserved = planPromotion({ from: 'canary', to: 'stable' })
  if (unobserved.allowed) problems.push('没有进入时刻的晋级被判为合法')
  if (unobserved.code !== CHANNEL_CODES.SOAK_UNOBSERVED) {
    problems.push(`查不到停留期时的裁决码是 ${unobserved.code}`)
  }

  // ⑦ 原地"晋级"与反向晋级分开。
  const same = planPromotion({ from: 'canary', to: 'canary' })
  if (same.code !== CHANNEL_CODES.PROMOTION_SAME) problems.push(`原地晋级的裁决码是 ${same.code}`)

  // ⑧ `selectOffered` 真的按版本降序挑（"0.10.0" > "0.9.0"，字符串比较会给反的）。
  const selection = selectOffered(
    [{ version: '0.9.0', channel: 'stable' }, { version: '0.10.0', channel: 'stable' }],
    { ring: 'stable' },
  )
  if (selection.selected?.version !== '0.10.0') {
    problems.push(`降序挑选选中了 ${selection.selected?.version}，而不是 0.10.0`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    channels: RELEASE_CHANNELS,
    rings: RINGS,
    ringAccepts: RING_ACCEPTS,
    defaultSoakDays: DEFAULT_SOAK_DAYS,
    samples: Object.freeze({
      noOptInOffered: noOptIn.offered,
      noOptInCode: noOptIn.code,
      stableInternalOffered: stableInternal.offered,
      stableInternalCode: stableInternal.code,
      unknownRingOffered: unknownRing.offered,
      unknownRingCode: unknownRing.code,
      skipAllowed: skip.allowed,
      skipCode: skip.code,
      tooFastAllowed: tooFast.allowed,
      tooFastCode: tooFast.code,
      goodAllowed: good.allowed,
      unobservedCode: unobserved.code,
      sameCode: same.code,
      zeroPercentHits: hitZero,
      fullPercentHits: hitFull,
      halfPercentHits: half,
      selectedVersion: selection.selected?.version ?? null,
    }),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const CHANNELS_CHECKED = selfCheckChannels()
